// spacetime-type-snapshot eval: the nested-type half of the migration freeze.
// Every #[derive(SpacetimeType)] struct/enum in server-module/src and
// game-core/src is BSATN-encoded positionally inside table rows and client
// messages, so field order (structs) and variant order (enums) are wire format.
//
//  1. DRIFT — parsed source must equal evals/baselines/spacetime-types.json
//     (regenerate: `node evals/spacetime-type-snapshot.eval.mjs --write`).
//  2. APPEND-ONLY — against the baseline at merge-base(HEAD, origin/master):
//     no type removed, no struct<->enum flip, and the committed fields /
//     variants must stay a positional prefix (tail-append only).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  itemAt,
  matchClose,
  mergeBaseViolations,
  parseField,
  prevBaseline,
  readRustTree,
  splitConsolidation,
  splitTop,
} from './battle-schema-snapshot.eval.mjs';

const BASELINE = 'evals/baselines/spacetime-types.json';

export function parseSpacetimeTypes(src) {
  const types = {};
  // `#[derive(.., SpacetimeType)]` or game-core's
  // `#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]`.
  for (const m of src.matchAll(/#\[(?:cfg_attr\([^\]]*?)?derive\(([^)]*)\)/g)) {
    if (!m[1].split(',').some((d) => d.trim().split('::').pop() === 'SpacetimeType')) continue;
    const item = itemAt(src, matchClose(src, m.index + 1));
    const parts = splitTop(item.body);
    types[item.name] =
      item.kind === 'struct'
        ? { kind: 'struct', fields: parts.map(parseField).map((f) => [f.name, f.type]) }
        : {
            kind: 'enum',
            variants: parts.map((p) => /(\w+)\s*(?:[({]|$)/.exec(p.replace(/#\[[^\]]*\]/g, ''))[1]),
          };
  }
  return types;
}

export function appendOnlyViolations(prev, next) {
  const out = [];
  for (const [name, p] of Object.entries(prev)) {
    const n = next[name];
    if (!n) out.push(`'${name}' removed — a wire break`);
    else if (n.kind !== p.kind) out.push(`'${name}' flipped ${p.kind} -> ${n.kind}`);
    else {
      const key = p.kind === 'struct' ? 'fields' : 'variants';
      const prefix = JSON.stringify(n[key].slice(0, p[key].length));
      if (prefix !== JSON.stringify(p[key]))
        out.push(
          `${p.kind} '${name}': committed ${key} are no longer a positional prefix (tail-append only)`,
        );
    }
  }
  return out;
}

function selfTeeth() {
  const prev = {
    E: { kind: 'enum', variants: ['A', 'B'] },
    S: { kind: 'struct', fields: [['x', 'u8']] },
  };
  const bad = [];
  const expect = (what, next, want) =>
    appendOnlyViolations(prev, { ...prev, ...next }).length > 0 === want || bad.push(what);
  expect('variant reorder', { E: { kind: 'enum', variants: ['B', 'A'] } }, true);
  expect('field removal', { S: { kind: 'struct', fields: [] } }, true);
  expect('variant append is legal', { E: { kind: 'enum', variants: ['A', 'B', 'C'] } }, false);
  const parsed = parseSpacetimeTypes(
    '#[derive(Clone, SpacetimeType)]\n#[sats(x)]\npub enum Q {\n A,\n B { t: u8 },\n C(u8),\n}',
  );
  if (JSON.stringify(parsed.Q?.variants) !== '["A","B","C"]') bad.push('multi-form enum parse');

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
    Head: { kind: 'enum', variants: ['On', 'Off'] },
    Mode: { kind: 'enum', variants: ['Walk', 'Run', 'Swim'] },
    Spot: {
      kind: 'struct',
      fields: [
        ['x', 'u16'],
        ['y', 'u16'],
      ],
    },
    Tail: { kind: 'struct', fields: [['id', 'u64']] },
  });
  const BREAKS = [
    ['a removed type', freeze({ Head: PREV.Head, Mode: PREV.Mode, Tail: PREV.Tail })],
    ['a removed field', freeze({ ...PREV, Spot: { kind: 'struct', fields: [['x', 'u16']] } })],
    [
      'a reordered variant',
      freeze({ ...PREV, Mode: { kind: 'enum', variants: ['Run', 'Walk', 'Swim'] } }),
    ],
  ];
  const LEGAL = freeze({
    ...PREV,
    Mode: { kind: 'enum', variants: ['Walk', 'Run', 'Swim', 'Fly'] },
  });
  const CYRILLIC_L = String.fromCodePoint(0x04cf);
  const UNDECLARED = ['LPW-32', 'lpw-32 ', ' lpw-32', 'lpw-33', 'x', '', `${CYRILLIC_L}pw-32`];
  const NOT_STRINGS = [true, 1, 0, null, {}, ['lpw-32']];

  check('fixture: the tail-appended variant is legal', () => {
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
    check(
      `a tail-appended variant with ${what} has no violation and none names consolidation`,
      () => {
        const got = merge(prev, next);
        return same(got, []) && !got.some((v) => v.includes('consolidation'));
      },
    );
  }
  check('an unchanged baseline marked lpw-32 on both sides has no violation', () => {
    return same(merge(marked(PREV), marked(PREV)), []);
  });
  check(
    'a tail-appended variant that kept the inherited marker has exactly one violation, naming it',
    () => {
      const got = merge(marked(PREV), marked(LEGAL));
      return got.length === 1 && got[0].includes('lpw-32');
    },
  );

  const failures = (parsed, baseline, prev) => typeSnapshotFailures({ parsed, baseline, prev });
  for (const [what, baseline] of [
    ['unmarked', PREV],
    ['marked lpw-32', marked(PREV)],
  ]) {
    check(
      `typeSnapshotFailures fails when the merge-base baseline is unreadable (baseline ${what})`,
      () => {
        return failures(PREV, baseline, null).length > 0;
      },
    );
  }
  for (const [label, next] of BREAKS) {
    const breaks = appendOnlyViolations(PREV, next);
    check(`typeSnapshotFailures passes the declared consolidation of ${label}`, () => {
      return same(failures(next, marked(next), PREV), []);
    });
    check(`typeSnapshotFailures reports ${label} under a marker kept from the merge-base`, () => {
      const got = failures(next, marked(next), marked(PREV));
      return got.length > breaks.length && mentions(got, breaks);
    });
  }
  check('typeSnapshotFailures reports drift under a declared consolidation', () => {
    const next = BREAKS[1][1];
    const parsed = freeze({ ...next, Extra: { kind: 'struct', fields: [['z', 'u8']] } });
    const got = failures(parsed, marked(next), PREV);
    return got.length > 0 && got.some((v) => v.includes('Extra'));
  });
  check('typeSnapshotFailures passes a marked baseline equal to its merge-base and source', () => {
    const got = failures(PREV, marked(PREV), marked(PREV));
    return same(got, []) && !got.some((v) => v.includes('consolidation'));
  });
  return bad;
}

const parseTree = () => parseSpacetimeTypes(readRustTree('server-module/src', 'game-core/src'));

export default async function spacetimeTypeSnapshotEval() {
  const name = 'spacetime-type-snapshot (SpacetimeType field/variant order freeze)';
  const teeth = selfTeeth();
  if (teeth.length) return { name, pass: false, detail: `self-teeth failed: ${teeth.join(', ')}` };
  const parsed = parseTree();
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const failures = [];
  for (const t of new Set([...Object.keys(parsed), ...Object.keys(baseline)])) {
    if (JSON.stringify(parsed[t]) !== JSON.stringify(baseline[t]))
      failures.push(`[drift] '${t}' differs from ${BASELINE}`);
  }
  const prev = prevBaseline(BASELINE);
  if (prev === null)
    failures.push('[append-only] cannot resolve the committed baseline (git fetch origin master)');
  else failures.push(...appendOnlyViolations(prev, baseline).map((v) => `[append-only] ${v}`));
  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? failures.join('; ')
      : `${Object.keys(parsed).length} types match the baseline; append-only vs merge-base holds (teeth verified)`,
  };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    const existing = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const parsed = parseTree();
    const names = [
      ...Object.keys(existing).filter((t) => t in parsed),
      ...Object.keys(parsed).filter((t) => !(t in existing)),
    ];
    writeFileSync(
      BASELINE,
      `${JSON.stringify(Object.fromEntries(names.map((t) => [t, parsed[t]])), null, 2)}\n`,
    );
    console.log(`wrote ${BASELINE} — review the diff`);
    process.exit(0);
  }
  const r = await spacetimeTypeSnapshotEval().catch((e) => ({
    name: 'spacetime-type-snapshot',
    pass: false,
    detail: `threw: ${e.message}`,
  }));
  console.log(`eval ${r.pass ? 'PASS' : 'FAIL'}: ${r.name} — ${r.detail}`);
  process.exit(r.pass ? 0 : 1);
}
