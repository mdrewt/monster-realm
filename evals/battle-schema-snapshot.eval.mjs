// battle-schema-snapshot eval: the live-DB migration freeze for every
// #[spacetimedb::table] in server-module/src.
//
// evals/baselines/table-schemas.json records, per table: pk, visibility,
// column types, column order, #[default] columns, #[unique] columns, indexed
// columns (#[index(btree)]), each table-level composite index (accessor and
// ordered columns; the key is present only on a table that declares one) and
// the scheduled reducer. Two layers:
//
//  1. DRIFT — the parsed source must equal the working baseline exactly
//     (regenerate with `node evals/battle-schema-snapshot.eval.mjs --write`
//     and commit the diff for review).
//  2. APPEND-ONLY — the baseline at merge-base(HEAD, origin/master) versus the
//     working one, so re-baselining cannot launder a change the live DB's
//     automigration rejects: dropping a table or column, reordering or
//     inserting mid-struct, changing a column type or the pk, adding #[unique],
//     or flipping a table's scheduled-ness. A column may only be appended at the
//     tail with #[default(..)], and defaulted columns must stay a suffix.
//     A table-level "manual_migration": "ADR-nnnn ..." note (a delete-data
//     migration) exempts that table from layer 2.
//     A consolidation (a declared break shipped with a wipe of every database)
//     skips layer 2 for the whole file: the working baseline carries a top-level
//     "consolidation" key holding one of DECLARED_CONSOLIDATIONS that the
//     merge-base copy lacks. `--write` never writes the key, so the slice that
//     consolidates adds it by hand and the next schema change drops it.
//
// Plus the zoning rule: a non-scheduled table carrying zone_id or
// map_id (or tile_x/tile_y) must have that zone field as its pk or indexed, so
// per-zone subscriptions stay a query change, never a migration.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripRustSource } from './rust-scan.mjs';

const BASELINE = 'evals/baselines/table-schemas.json';
const TABLE_ATTR = '#[spacetimedb::table(';

// Every .rs file under `dirs`, comments and string payloads blanked.
export function readRustTree(...dirs) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const full = path.join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith('.rs')) out.push(stripRustSource(readFileSync(full, 'utf8')));
    }
  };
  for (const d of dirs) walk(d);
  return out.join('\n');
}

// Index just past the bracket matching the opener at `open`.
export function matchClose(src, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let i = open; i < src.length; i++) {
    if (pairs[src[i]]) stack.push(pairs[src[i]]);
    else if (src[i] === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  throw new Error(`unbalanced bracket at offset ${open}`);
}

// Split on depth-0 commas (depth counts ()[]{}<>), trimmed, empties dropped.
export function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// From `i`, skip further `#[...]` attributes, then read `pub struct|enum Name { body }`.
export function itemAt(src, i) {
  let j = i;
  for (;;) {
    while (/\s/.test(src[j])) j++;
    if (src.startsWith('#[', j)) j = matchClose(src, j + 1);
    else break;
  }
  const m = /^pub(?:\([^)]*\))?\s+(struct|enum)\s+(\w+)\s*\{/.exec(src.slice(j, j + 200));
  if (!m) throw new Error(`expected \`pub struct|enum Name {\` at offset ${j}`);
  const open = j + m[0].length - 1;
  const end = matchClose(src, open);
  return { kind: m[1], name: m[2], body: src.slice(open + 1, end - 1), end };
}

// A struct field chunk -> { attrs: string[], name, type }.
export function parseField(chunk) {
  const attrs = [];
  let s = chunk.trim();
  while (s.startsWith('#[')) {
    const end = matchClose(s, 1);
    attrs.push(s.slice(2, end - 1).replace(/\s+/g, ''));
    s = s.slice(end).trim();
  }
  const m = /^(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*([\s\S]+)$/.exec(s);
  if (!m) throw new Error(`unparseable field \`${s.slice(0, 60)}\``);
  return { attrs, name: m[1], type: m[2].replace(/\s+/g, '') };
}

// The one modelled table-level index form: `index(accessor = X, btree(columns = [a, b, ..]))`.
const COMPOSITE_INDEX =
  /^index\s*\(\s*accessor\s*=\s*(\w+)\s*,\s*btree\s*\(\s*columns\s*=\s*\[([\w\s,]*)\]\s*\)\s*\)$/;

// A table-level index argument (any depth-0 table argument whose first word is `index`, so a
// leading character Rust lexes as whitespace cannot hide one) -> { accessor, columns }, columns
// in declared order. It must name two or more distinct columns of the struct; any other
// table-level form throws, and a one-column index belongs on its field as #[index(btree)].
export function parseCompositeIndex(table, arg, order) {
  const fail = (why) => {
    throw new Error(`${table}: table-level index \`${arg}\` ${why}`);
  };
  const m = COMPOSITE_INDEX.exec(arg);
  if (!m) fail('is not the modelled index(accessor = X, btree(columns = [a, b, ..])) form');
  const columns = m[2].split(',').map((c) => c.trim());
  if (columns.length < 2)
    fail('must list two or more columns (a one-column index goes on the field)');
  for (const c of columns) if (!order.includes(c)) fail(`names unknown column '${c}'`);
  if (new Set(columns).size !== columns.length) fail('repeats a column');
  return { accessor: m[1], columns };
}

export function parseTables(src) {
  const tables = {};
  let at = src.indexOf(TABLE_ATTR);
  while (at !== -1) {
    const argsEnd = matchClose(src, at + TABLE_ATTR.length - 1);
    const args = splitTop(src.slice(at + TABLE_ATTR.length, argsEnd - 1));
    const name = /^accessor\s*=\s*(\w+)$/.exec(
      args.find((a) => a.startsWith('accessor')) ?? '',
    )?.[1];
    if (!name) throw new Error(`table attribute at offset ${at} has no accessor`);
    const item = itemAt(src, matchClose(src, at + 1));
    const fields = splitTop(item.body).map(parseField);
    const has = (f, a) => f.attrs.includes(a);
    const withAttr = (a) => fields.filter((f) => has(f, a)).map((f) => f.name);
    const order = fields.map((f) => f.name);
    const composite = args
      .filter((a) => /^\W*index\b/.test(a))
      .map((a) => parseCompositeIndex(name, a, order));
    const accessors = composite.map((c) => c.accessor);
    if (new Set(accessors).size !== accessors.length)
      throw new Error(`${name}: two table-level indexes share an accessor`);
    tables[name] = {
      pk: fields.find((f) => has(f, 'primary_key'))?.name ?? null,
      visibility: args.includes('public') ? 'public' : 'private',
      columns: Object.fromEntries(fields.map((f) => [f.name, f.type])),
      order,
      defaults: fields
        .filter((f) => f.attrs.some((a) => a.startsWith('default(')))
        .map((f) => f.name),
      unique: withAttr('unique'),
      indexes: withAttr('index(btree)'),
      ...(composite.length ? { composite_indexes: composite } : {}),
      scheduled:
        /^scheduled\((\w+)\)$/.exec(args.find((a) => a.startsWith('scheduled(')) ?? '')?.[1] ??
        null,
    };
    at = src.indexOf(TABLE_ATTR, item.end);
  }
  return tables;
}

// Keeps the existing table order (new tables appended) and hand-authored notes.
export function formatBaseline(parsed, existing = {}) {
  const names = [
    ...Object.keys(existing).filter((t) => t in parsed),
    ...Object.keys(parsed).filter((t) => !(t in existing)),
  ];
  const out = {};
  for (const t of names) {
    out[t] = { ...parsed[t] };
    if (existing[t]?.manual_migration) out[t].manual_migration = existing[t].manual_migration;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function driftViolations(parsed, baseline) {
  const out = [];
  for (const t of new Set([...Object.keys(parsed), ...Object.keys(baseline)])) {
    const { manual_migration: _, ...b } = baseline[t] ?? {};
    if (!(t in parsed)) out.push(`[drift] table '${t}' is in the baseline but not in source`);
    else if (!(t in baseline))
      out.push(`[drift] table '${t}' is in source but not in the baseline`);
    else if (JSON.stringify(parsed[t]) !== JSON.stringify(b)) {
      const keys = [...new Set([...Object.keys(parsed[t]), ...Object.keys(b)])].filter(
        (k) => JSON.stringify(parsed[t][k]) !== JSON.stringify(b[k]),
      );
      out.push(`[drift] table '${t}' differs from the baseline in ${keys.join(', ')}`);
    }
  }
  return out;
}

// Layer 2. A key absent from `prev` (a baseline written before it was recorded) skips its rule.
export function appendOnlyViolations(prev, next) {
  const out = [];
  for (const t of Object.keys(prev)) {
    const p = prev[t];
    const n = next[t];
    const v = (msg) => out.push(`[append-only] table '${t}': ${msg}`);
    if (n?.manual_migration) continue;
    if (!n) {
      v('dropped — automigration never accepts a table drop');
      continue;
    }
    const kept = p.order.filter((c) => n.order.includes(c));
    const gone = p.order.filter((c) => !n.order.includes(c));
    if (gone.length) v(`column(s) ${gone.join(', ')} removed`);
    const i = kept.findIndex((c, k) => n.order[k] !== c);
    if (i !== -1)
      v(
        `column '${kept[i]}' moved — the committed order must stay a prefix (no mid-struct insert or reorder)`,
      );
    for (const c of kept)
      if (p.columns[c] !== n.columns[c])
        v(`column '${c}' changed type ${p.columns[c]} -> ${n.columns[c]}`);
    if (p.pk !== n.pk) v(`pk changed ${p.pk} -> ${n.pk}`);
    if ('scheduled' in p && p.scheduled !== n.scheduled)
      v(`scheduled changed ${p.scheduled} -> ${n.scheduled}`);
    if ('unique' in p)
      for (const c of n.unique)
        if (kept.includes(c) && !p.unique.includes(c))
          v(`#[unique] added to existing column '${c}'`);
    for (const c of n.order.slice(kept.length))
      if (!n.defaults.includes(c)) v(`appended column '${c}' has no #[default(..)]`);
    const firstDefault = n.order.findIndex((c) => n.defaults.includes(c));
    if (firstDefault !== -1 && n.order.slice(firstDefault).some((c) => !n.defaults.includes(c)))
      v('#[default] columns are not a tail suffix');
  }
  return out;
}

// The slices whose spec declares a consolidation, each by its exact id.
export const DECLARED_CONSOLIDATIONS = ['lpw-32'];

// A baseline file's marker and its entries. A string under the key is the marker and leaves the
// entries; any other value stays an entry, which the drift layer reports.
export function splitConsolidation(baseline) {
  const { consolidation: marker, ...entries } = baseline;
  return typeof marker === 'string' ? { marker, entries } : { marker: null, entries: baseline };
}

// The declared consolidation `next` names and `prev` does not, else null.
export function consolidationOf(prev, next) {
  const marker = splitConsolidation(next).marker;
  const declared = marker !== null && DECLARED_CONSOLIDATIONS.includes(marker);
  return declared && marker !== splitConsolidation(prev).marker ? marker : null;
}

// Layer 2 for a whole baseline file: nothing for a consolidation, else `appendOnly` over the two
// files' entries. A marker that names no declared consolidation is a violation and skips
// nothing; so is a declared one the merge-base copy already holds once the entries differ.
export function mergeBaseViolations(prev, next, appendOnly) {
  if (consolidationOf(prev, next) !== null) return [];
  const p = splitConsolidation(prev);
  const n = splitConsolidation(next);
  const out = [];
  if (n.marker !== null && !DECLARED_CONSOLIDATIONS.includes(n.marker))
    out.push(
      `[consolidation] marker '${n.marker}' names no declared consolidation (declared: ${DECLARED_CONSOLIDATIONS.join(', ')})`,
    );
  else if (n.marker !== null && JSON.stringify(p.entries) !== JSON.stringify(n.entries))
    out.push(
      `[consolidation] marker '${n.marker}' is the merge-base baseline's own: the first schema change after a consolidation removes it`,
    );
  return [...out, ...appendOnly(p.entries, n.entries)];
}

export function zoningViolations(tables) {
  const out = [];
  for (const [t, e] of Object.entries(tables)) {
    if (e.scheduled) continue;
    const keyed = (c) => e.pk === c || e.indexes.includes(c);
    const hasTile = 'tile_x' in e.columns || 'tile_y' in e.columns;
    for (const c of ['zone_id', 'map_id']) {
      if ((c in e.columns || (c === 'zone_id' && hasTile)) && !keyed(c))
        out.push(`[zoning] table '${t}': ${c} must be the pk or #[index(btree)]`);
    }
  }
  return out;
}

// The committed baseline at merge-base(HEAD, origin/master), else origin/master, else null.
export function prevBaseline(gitPath) {
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const ref of [
    () => git(['merge-base', 'HEAD', 'origin/master']).trim(),
    () => 'origin/master',
  ]) {
    try {
      return JSON.parse(git(['show', `${ref()}:${gitPath}`]));
    } catch {}
  }
  return null;
}

function selfTeeth() {
  const e = (order, extra = {}) => ({
    pk: order[0],
    visibility: 'private',
    columns: Object.fromEntries(order.map((c) => [c, 'u32'])),
    order,
    defaults: [],
    unique: [],
    indexes: [],
    scheduled: null,
    ...extra,
  });
  const base = { t: e(['id', 'a']) };
  const cases = [
    ['mid-struct insert', { t: e(['id', 'x', 'a'], { defaults: ['x'] }) }, true],
    ['append without default', { t: e(['id', 'a', 'x']) }, true],
    ['append with default', { t: e(['id', 'a', 'x'], { defaults: ['x'] }) }, false],
    ['table drop', {}, true],
    ['scheduled flip', { t: e(['id', 'a'], { scheduled: 'r' }) }, true],
    ['unique added', { t: e(['id', 'a'], { unique: ['a'] }) }, true],
  ];
  const bad = cases
    .filter(([, next, want]) => appendOnlyViolations(base, next).length > 0 !== want)
    .map(([w]) => w);
  if (zoningViolations({ z: e(['id', 'zone_id']) }).length !== 1) bad.push('unindexed zone_id');
  const decoy = `const S: &str = "${TABLE_ATTR}accessor = fake)] pub struct F { pub x: u8 }"; // ${TABLE_ATTR}accessor = f2)]`;
  if (Object.keys(parseTables(stripRustSource(decoy))).length !== 0)
    bad.push('string/comment decoy parsed as a table');
  // Rust lexes U+200E (left-to-right mark) as whitespace; JS's \s and trim() do not.
  const LRM = String.fromCharCode(0x200e);
  const table = (args) =>
    parseTables(
      stripRustSource(`${TABLE_ATTR}${args})] pub struct T { pub a: u32, pub b: u32, pub c: u32 }`),
    ).t;
  const recorded = (args) => JSON.stringify(table(args).composite_indexes);
  if (
    recorded('accessor = t, index(accessor = cba, btree(columns = [c, b, a]))') !==
    '[{"accessor":"cba","columns":["c","b","a"]}]'
  )
    bad.push('composite index not recorded with its columns in declared order');
  if (
    recorded(
      'index(accessor = y, btree(columns = [b, c])), accessor = t, index(accessor = x, btree(columns = [a, b]))',
    ) !== '[{"accessor":"y","columns":["b","c"]},{"accessor":"x","columns":["a","b"]}]'
  )
    bad.push('two composite indexes not both recorded in declared order');
  if ('composite_indexes' in table('accessor = t'))
    bad.push('composite_indexes key on a table without one');
  for (const args of [
    'accessor = t, index(accessor = x, hash(columns = [a, b]))',
    'accessor = t, index(accessor = x, direct(column = a))',
    'accessor = t, index(name = x, btree(columns = [a, b]))',
    'accessor = t, index(accessor = x, name = "n", btree(columns = [a, b]))',
    'accessor = t, index(btree(columns = [a, b]))',
    'accessor = t, index(accessor = x, btree(columns = [a, b]), y)',
    'accessor = t, index (accessor = x, hash(columns = [a, b]))',
    `accessor = t, ${LRM}index(accessor = x, hash(columns = [a, b]))`,
    'index(accessor = x, hash(columns = [a, b])), accessor = t',
    'accessor = t, index(accessor = x, btree(columns = [a]))',
    'accessor = t, index(accessor = x, btree(columns = [a, b,]))',
    'accessor = t, index(accessor = x, btree(columns = [a, d]))',
    'accessor = t, index(accessor = x, btree(columns = [a, b, a]))',
    'accessor = t, index(accessor = x, btree(columns = [a, b])), index(accessor = x, btree(columns = [b, a]))',
  ]) {
    let message = '';
    try {
      table(args);
    } catch (err) {
      message = err.message;
    }
    if (!message.includes('table-level index')) bad.push(`table-level \`${args}\` did not throw`);
  }

  // The consolidation marker. Every fixture is deep-frozen, so a function that writes to its
  // input throws, and a case that throws is reported as failed under its own name.
  const freeze = (o) => {
    if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
      for (const v of Object.values(o)) freeze(v);
      Object.freeze(o);
    }
    return o;
  };
  const check = (what, ok) => {
    try {
      if (!ok()) bad.push(what);
    } catch (err) {
      bad.push(`${what} (threw ${err?.name ?? err})`);
    }
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hasAll = (got, want) => want.every((v) => got.includes(v));
  const mentions = (got, want) => want.every((v) => got.some((g) => g.includes(v)));
  // `got` is `want` plus exactly one more violation, and that one names `marker`.
  const plusMarker = (got, want, marker) => {
    const extra = got.filter((v) => !want.includes(v));
    return (
      got.length === want.length + 1 &&
      hasAll(got, want) &&
      extra.length === 1 &&
      extra[0].includes(marker)
    );
  };
  const marked = (entries, marker = 'lpw-32') => freeze({ ...entries, consolidation: marker });
  const merge = (prev, next) => mergeBaseViolations(prev, next, appendOnlyViolations);

  const PREV = freeze({
    first: e(['id', 'a'], { visibility: 'public' }),
    mid: e(['id', 'b', 'c']),
    last: e(['id', 'd'], { scheduled: 'tick' }),
  });
  const withMid = (mid) =>
    freeze(
      mid === undefined
        ? { first: PREV.first, last: PREV.last }
        : { first: PREV.first, mid, last: PREV.last },
    );
  const BREAKS = [
    ['a dropped table', withMid(undefined)],
    ['a removed column', withMid(e(['id', 'b']))],
    ['a reordered column', withMid(e(['id', 'c', 'b']))],
    [
      'a changed column type',
      withMid(e(['id', 'b', 'c'], { columns: { id: 'u32', b: 'u64', c: 'u32' } })),
    ],
    ['a changed pk', withMid(e(['id', 'b', 'c'], { pk: 'b' }))],
    ['a flipped scheduled', withMid(e(['id', 'b', 'c'], { scheduled: 'sweep' }))],
  ];
  const LEGAL = withMid(e(['id', 'b', 'c', 'n'], { defaults: ['n'] }));
  const CYRILLIC_L = String.fromCodePoint(0x04cf);
  const UNDECLARED = ['LPW-32', 'lpw-32 ', ' lpw-32', 'lpw-33', 'x', '', `${CYRILLIC_L}pw-32`];
  const NOT_STRINGS = [true, 1, 0, null, {}, ['lpw-32']];

  check('fixture: the tail append with a default is legal', () => {
    return appendOnlyViolations(PREV, LEGAL).length === 0;
  });
  for (const [label, next] of BREAKS) {
    const breaks = appendOnlyViolations(PREV, next);
    check(`fixture: ${label} is a break`, () => breaks.length > 0);
    check(`the declared consolidation skips the merge-base check for ${label}`, () => {
      return same(merge(PREV, marked(next)), []);
    });
    check(`a marker kept from the merge-base still reports ${label}, plus the marker`, () => {
      return plusMarker(merge(marked(PREV), marked(next)), breaks, 'lpw-32');
    });
    check(
      `with the marker removed, ${label} is reported as appendOnlyViolations reports it`,
      () => {
        return same(merge(marked(PREV), next), appendOnlyViolations(PREV, next));
      },
    );
    check(
      `with no marker on either side, ${label} is reported as appendOnlyViolations reports it`,
      () => {
        return same(merge(PREV, next), breaks);
      },
    );
    for (const marker of UNDECLARED) {
      for (const [side, prev] of [
        ['an unmarked merge-base', PREV],
        ['a merge-base marked lpw-32', marked(PREV)],
      ]) {
        check(
          `the undeclared marker ${JSON.stringify(marker)} over ${side} reports ${label} and names the marker`,
          () => {
            return plusMarker(merge(prev, marked(next, marker)), breaks, marker);
          },
        );
      }
    }
    for (const value of NOT_STRINGS) {
      for (const [side, prev] of [
        ['an unmarked merge-base', PREV],
        ['a merge-base marked lpw-32', marked(PREV)],
      ]) {
        check(
          `a non-string consolidation ${JSON.stringify(value)} over ${side} reports ${label}`,
          () => {
            return same(merge(prev, marked(next, value)), breaks);
          },
        );
      }
    }
  }
  for (const [what, prev, next] of [
    ['both unmarked', PREV, LEGAL],
    ['a merge-base marked lpw-32 and an unmarked baseline', marked(PREV), LEGAL],
    ['an unmarked merge-base and a baseline marked lpw-32', PREV, marked(LEGAL)],
  ]) {
    check(`a legal tail append with ${what} has no violation and none names consolidation`, () => {
      const got = merge(prev, next);
      return same(got, []) && !got.some((v) => v.includes('consolidation'));
    });
  }
  check('an unchanged baseline marked lpw-32 on both sides has no violation', () => {
    return same(merge(marked(PREV), marked(PREV)), []);
  });
  check(
    'a legal tail append that kept the inherited marker has exactly one violation, naming it',
    () => {
      const got = merge(marked(PREV), marked(LEGAL));
      return got.length === 1 && got[0].includes('lpw-32');
    },
  );

  check('splitConsolidation returns a string marker and the entries without the key', () => {
    const { marker, entries } = splitConsolidation(
      freeze({ first: PREV.first, consolidation: 'lpw-32', mid: PREV.mid, last: PREV.last }),
    );
    return (
      marker === 'lpw-32' &&
      !('consolidation' in entries) &&
      same(Object.keys(entries), ['first', 'mid', 'last']) &&
      same(entries, PREV)
    );
  });
  for (const marker of ['LPW-32', 'x', '']) {
    check(
      `splitConsolidation returns any string marker, ${JSON.stringify(marker)} included`,
      () => {
        const { marker: got, entries } = splitConsolidation(marked(PREV, marker));
        return got === marker && !('consolidation' in entries) && same(entries, PREV);
      },
    );
  }
  check('splitConsolidation of a baseline with no key gives marker null and the baseline', () => {
    const { marker, entries } = splitConsolidation(PREV);
    return marker === null && same(entries, PREV);
  });
  for (const value of NOT_STRINGS) {
    check(
      `splitConsolidation keeps the non-string consolidation ${JSON.stringify(value)} in entries`,
      () => {
        const { marker, entries } = splitConsolidation(marked(PREV, value));
        return (
          marker === null &&
          'consolidation' in entries &&
          same(entries.consolidation, value) &&
          same(entries, marked(PREV, value))
        );
      },
    );
  }
  check('splitConsolidation of a deep-frozen baseline does not throw', () => {
    splitConsolidation(marked(PREV));
    return true;
  });

  const failures = (parsed, baseline, prev) => snapshotFailures({ parsed, baseline, prev });
  for (const [what, baseline] of [
    ['unmarked', PREV],
    ['marked lpw-32', marked(PREV)],
  ]) {
    check(
      `snapshotFailures fails when the merge-base baseline is unreadable (baseline ${what})`,
      () => {
        return failures(PREV, baseline, null).length > 0;
      },
    );
  }
  for (const [label, next] of BREAKS) {
    const breaks = appendOnlyViolations(PREV, next);
    check(`snapshotFailures passes the declared consolidation of ${label}`, () => {
      return same(failures(next, marked(next), PREV), []);
    });
    check(`snapshotFailures reports ${label} under a marker kept from the merge-base`, () => {
      const got = failures(next, marked(next), marked(PREV));
      return got.length > breaks.length && mentions(got, breaks);
    });
  }
  check('snapshotFailures reports drift under a declared consolidation', () => {
    const next = BREAKS[1][1];
    const drift = driftViolations(LEGAL, next);
    const got = failures(LEGAL, marked(next), PREV);
    return drift.length > 0 && mentions(got, drift);
  });
  check('snapshotFailures reports an unindexed zone_id under a declared consolidation', () => {
    const parsed = freeze({ ...PREV, zone: e(['id', 'zone_id']) });
    const zoning = zoningViolations(parsed);
    const got = failures(parsed, marked(parsed), PREV);
    return zoning.length === 1 && mentions(got, zoning);
  });
  check('snapshotFailures passes a marked baseline equal to its merge-base and source', () => {
    const got = failures(PREV, marked(PREV), marked(PREV));
    return same(got, []) && !got.some((v) => v.includes('consolidation'));
  });
  return bad;
}

// Every failure of the eval for one parsed source, working baseline and merge-base baseline
// (null when git cannot read it).
export function snapshotFailures({ parsed, baseline, prev }) {
  const failures = [
    ...driftViolations(parsed, splitConsolidation(baseline).entries),
    ...zoningViolations(parsed),
  ];
  if (prev === null)
    failures.push('[append-only] cannot resolve the committed baseline (git fetch origin master)');
  else failures.push(...mergeBaseViolations(prev, baseline, appendOnlyViolations));
  return failures;
}

export default async function battleSchemaSnapshotEval() {
  const name = 'battle-schema-snapshot (table migration freeze + zoning)';
  const teeth = selfTeeth();
  if (teeth.length) return { name, pass: false, detail: `self-teeth failed: ${teeth.join(', ')}` };
  const parsed = parseTables(readRustTree('server-module/src'));
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const prev = prevBaseline(BASELINE);
  const failures = snapshotFailures({ parsed, baseline, prev });
  const consolidation = prev === null ? null : consolidationOf(prev, baseline);
  const layerTwo =
    consolidation === null
      ? 'append-only vs merge-base and zoning hold'
      : `zoning holds; the merge-base comparison is skipped for the declared consolidation '${consolidation}'`;
  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? `${failures.join('; ')} — regenerate with --write only for a legal change`
      : `${Object.keys(parsed).length} tables match the baseline; ${layerTwo} (teeth verified)`,
  };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    const existing = JSON.parse(readFileSync(BASELINE, 'utf8'));
    writeFileSync(
      BASELINE,
      formatBaseline(parseTables(readRustTree('server-module/src')), existing),
    );
    console.log(`wrote ${BASELINE} — review the diff`);
    process.exit(0);
  }
  const r = await battleSchemaSnapshotEval().catch((e) => ({
    name: 'battle-schema-snapshot',
    pass: false,
    detail: `threw: ${e.message}`,
  }));
  console.log(`eval ${r.pass ? 'PASS' : 'FAIL'}: ${r.name} — ${r.detail}`);
  process.exit(r.pass ? 0 : 1);
}
