// battle-schema-snapshot eval: the live-DB migration freeze for every
// #[spacetimedb::table] in server-module/src.
//
// evals/baselines/table-schemas.json records, per table: pk, visibility,
// column types, column order, #[default] columns, #[unique] columns, indexed
// columns (#[index(btree)]) and the scheduled reducer. Two layers:
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
    if (args.some((a) => a.startsWith('index(')))
      throw new Error(`${name}: table-level index() is not modelled here`);
    const item = itemAt(src, matchClose(src, at + 1));
    const fields = splitTop(item.body).map(parseField);
    const has = (f, a) => f.attrs.includes(a);
    const withAttr = (a) => fields.filter((f) => has(f, a)).map((f) => f.name);
    tables[name] = {
      pk: fields.find((f) => has(f, 'primary_key'))?.name ?? null,
      visibility: args.includes('public') ? 'public' : 'private',
      columns: Object.fromEntries(fields.map((f) => [f.name, f.type])),
      order: fields.map((f) => f.name),
      defaults: fields
        .filter((f) => f.attrs.some((a) => a.startsWith('default(')))
        .map((f) => f.name),
      unique: withAttr('unique'),
      indexes: withAttr('index(btree)'),
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
      const keys = Object.keys(parsed[t]).filter(
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
  return bad;
}

export default async function battleSchemaSnapshotEval() {
  const name = 'battle-schema-snapshot (table migration freeze + zoning)';
  const teeth = selfTeeth();
  if (teeth.length) return { name, pass: false, detail: `self-teeth failed: ${teeth.join(', ')}` };
  const parsed = parseTables(readRustTree('server-module/src'));
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const prev = prevBaseline(BASELINE);
  const failures = [...driftViolations(parsed, baseline), ...zoningViolations(parsed)];
  if (prev === null)
    failures.push('[append-only] cannot resolve the committed baseline (git fetch origin master)');
  else failures.push(...appendOnlyViolations(prev, baseline));
  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? `${failures.join('; ')} — regenerate with --write only for a legal change`
      : `${Object.keys(parsed).length} tables match the baseline; append-only vs merge-base and zoning hold (teeth verified)`,
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
