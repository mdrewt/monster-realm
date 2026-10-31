// tactics/golden.parity.test.ts — BT1.9, the wasm half of the native = wasm byte-identity harness.
//
// `game-core/tests/fixtures/tactics_golden.json` is `{ cases, expected }` (serde externally
// tagged, e.g. `{"Distance":{"a":{"x":0,"y":0},"b":{"x":7,"y":7}}}` -> `{"Distance":14}`).
// The native cargo test (`game-core/src/tactics/golden_tests.rs`) runs the cases through
// `run_golden`; THIS suite runs the SAME file's cases through the built wasm pkg's
// `tactics_golden` export and compares the CANONICAL form (compact JSON, object keys sorted
// recursively) against the hand-derived `expected`. A divergence between the native and wasm
// targets (a HashMap iteration order, a float, a tie-break) shows up as a string mismatch.
// There is no TypeScript reimplementation of any rule here: every answer comes from game-core.
//
// Pinned on purpose: the case count, the nine case kinds, and the number of malformed boards.
// Growing the harness (BT2.5, BT4.8, BT11.7) is a deliberate edit to these literals AND to the
// matching constants in golden_tests.rs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadWasmPkg } from '../../test-util/wasmPkg';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../game-core/tests/fixtures/tactics_golden.json',
);

/** The pinned fixture size (keep equal to CASE_COUNT in golden_tests.rs). */
const CASE_COUNT = 182;
/** Cases whose board is malformed: they must come back as `{"BadCase": "<text>"}`. */
const BAD_CASE_COUNT = 9;
/** Every `GoldenCase` kind; each must appear in the fixture at least once. */
const KINDS = [
  'Distance',
  'Adjacent',
  'TargetSet',
  'Flank',
  'Los',
  'Stride',
  'Weight',
  'Path',
  'Disengage',
] as const;

interface GoldenFixture {
  cases: unknown[];
  expected: unknown[];
}

type TacticsGolden = (cases: unknown[]) => unknown;

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;

/** Compact JSON with object keys sorted recursively — the byte-identity form. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const body = Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The single external tag of a `{"Kind": ...}` value. */
function kindOf(v: unknown): string {
  expect(
    v !== null && typeof v === 'object' && !Array.isArray(v),
    `not an object: ${canon(v)}`,
  ).toBe(true);
  const keys = Object.keys(v as Record<string, unknown>);
  expect(keys, `exactly one tag: ${canon(v)}`).toHaveLength(1);
  return keys[0];
}

let tacticsGolden: TacticsGolden | undefined;
let pkgExport: unknown;

beforeAll(async () => {
  const pkg = await loadWasmPkg();
  pkgExport = pkg.tactics_golden;
  if (typeof pkgExport === 'function') tacticsGolden = pkgExport as TacticsGolden;
});

function runWasm(): unknown[] {
  if (tacticsGolden === undefined) {
    throw new Error('client-wasm exports no tactics_golden() — the pkg is stale, run `just wasm`');
  }
  const result = tacticsGolden(fixture.cases);
  expect(Array.isArray(result), 'tactics_golden returns an array').toBe(true);
  return result as unknown[];
}

describe('BT1.9 tactics golden: wasm == native on the shared JSON fixture', () => {
  it('BT1.9 the built wasm pkg exports tactics_golden as a function', () => {
    expect(typeof pkgExport).toBe('function');
  });

  it('BT1.9 the fixture is the pinned size and covers all nine case kinds', () => {
    expect(fixture.cases).toHaveLength(CASE_COUNT);
    expect(fixture.expected).toHaveLength(CASE_COUNT);
    const kinds = fixture.cases.map(kindOf);
    for (const want of KINDS) {
      expect(
        kinds.filter((k) => k === want).length,
        `no ${want} case in the fixture`,
      ).toBeGreaterThan(0);
    }
    for (const k of kinds) {
      expect(KINDS as readonly string[], `unknown case kind ${k}`).toContain(k);
    }
  });

  it('BT1.9 tactics_golden returns one result per case, in order, of the same kind (or BadCase)', () => {
    const results = runWasm();
    expect(results).toHaveLength(fixture.cases.length);
    expect(results).toHaveLength(CASE_COUNT);
    results.forEach((r, i) => {
      const got = kindOf(r);
      const want = kindOf(fixture.cases[i]);
      expect(got === want || got === 'BadCase', `result #${i} is ${got} for a ${want} case`).toBe(
        true,
      );
    });
  });

  it('BT1.9 every wasm result is canonically byte-identical to the fixture expected', () => {
    const results = runWasm();
    results.forEach((r, i) => {
      expect(canon(r), `case #${i}: ${canon(fixture.cases[i])}`).toBe(canon(fixture.expected[i]));
    });
    // And the whole document at once — the exact string the native half compares.
    expect(canon(results)).toBe(canon(fixture.expected));
  });

  it('BT1.9 exactly the pinned number of malformed boards come back as BadCase', () => {
    const results = runWasm();
    const bad = results
      .filter((r) => kindOf(r) === 'BadCase')
      .map((r) => (r as { BadCase: string }).BadCase);
    expect(bad).toHaveLength(BAD_CASE_COUNT);
    expect(bad).toEqual([
      'empty board',
      'empty board',
      'ragged row 1',
      'ragged row 2',
      "bad terrain 'x' at (1,1)",
      "bad terrain 'q' at (1,0)",
      "bad terrain 'W' at (2,1)",
      "bad terrain ' ' at (0,1)",
      'empty board',
    ]);
  });
});
