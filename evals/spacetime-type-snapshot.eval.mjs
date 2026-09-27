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
  parseField,
  prevBaseline,
  readRustTree,
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
