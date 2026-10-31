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
// Pinned on purpose: the case count, every case kind, and the number of BadCase results
// (malformed boards, and since bt-2 invalid Pipeline units). Growing the harness (BT2.5, BT4.8,
// BT11.7) is a deliberate edit to these literals AND to the matching constants in
// golden_tests.rs. The BT2.5 block below is the wasm half of bt-2's golden join: the roll
// stream, economy, Surge, status tick, initiative, priority, pipeline and adjudication kinds.
// The BT4.8 block is the wasm half of bt-4's join: the wild planner's `AiPlan` kind on frozen
// boards (the client's intent chip runs this same wasm `ai::plan`), compared case by case
// against the hand-derived plans (no TypeScript planner, no inline probes).

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
const CASE_COUNT = 304;
/** Cases that must come back as `{"BadCase": "<text>"}`: malformed boards, invalid Pipeline units. */
const BAD_CASE_COUNT = 17;
/** U+00E9, built from its code point (never a pasted or escaped literal). */
const E_ACUTE = String.fromCharCode(0xe9);
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
  'Rolls',
  'Economy',
  'SurgeDamage',
  'StatusTick',
  'Initiative',
  'Priority',
  'Pipeline',
  'Adjudicate',
  'AiPlan',
] as const;
/** The kinds bt-2 added (BT2.5). */
const BT2_KINDS = [
  'Rolls',
  'Economy',
  'SurgeDamage',
  'StatusTick',
  'Initiative',
  'Priority',
  'Pipeline',
  'Adjudicate',
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

  it('BT1.9 the fixture is the pinned size and covers every case kind', () => {
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
      'board too large',
      `bad terrain '${E_ACUTE}' at (1,0)`,
      "bad terrain 'x' at (0,0)",
      'ragged row 1',
      // bt-2 (BT2.5): Pipeline units failing validate_unit, the attacker checked first.
      'invalid unit: Fainted { id: 7 }',
      'invalid unit: HpAboveMax { id: 8, cur_hp: 101, max_hp: 100 }',
      'invalid unit: ZeroDefense { id: 8 }',
      'invalid unit: ZeroDefense { id: 7 }',
    ]);
  });

  it('BT1.9 the board size limit is exactly 255 columns by 255 rows', () => {
    if (tacticsGolden === undefined) {
      throw new Error(
        'client-wasm exports no tactics_golden() — the pkg is stale, run `just wasm`',
      );
    }
    const los = (rows: string[]) => ({
      Los: { board: { rows, units: [] }, from: { x: 0, y: 0 }, to: { x: 0, y: 0 } },
    });
    const cases = [
      los(['.'.repeat(255)]),
      los(['.'.repeat(256)]),
      los(Array.from({ length: 255 }, () => '.')),
      los(Array.from({ length: 256 }, () => '.')),
    ];
    const results = tacticsGolden(cases) as unknown[];
    expect(results.map(canon)).toEqual([
      canon({ Los: true }),
      canon({ BadCase: 'board too large' }),
      canon({ Los: true }),
      canon({ BadCase: 'board too large' }),
    ]);
  });
});

/** Run inline cases through the wasm export (the fixture-independent probes below). */
function wasmGolden(cases: unknown[]): unknown[] {
  if (tacticsGolden === undefined) {
    throw new Error('client-wasm exports no tactics_golden() — the pkg is stale, run `just wasm`');
  }
  const result = tacticsGolden(cases);
  expect(Array.isArray(result), 'tactics_golden returns an array').toBe(true);
  return result as unknown[];
}

interface UnitSpec {
  id: number;
  side: 'A' | 'B';
  affinity: string;
  attack: number;
  defense: number;
  curHp: number;
  guard: boolean;
  firstStand: boolean;
}

/** A level-5, 100-max-HP tactical unit as the fixture spells it (serde field names). */
function tacticalUnit(u: UnitSpec): Record<string, unknown> {
  return {
    id: u.id,
    side: u.side,
    slot: 0,
    kit: {
      species_id: u.id,
      affinity: u.affinity,
      level: 5,
      stats: {
        hp: 100,
        attack: u.attack,
        defense: u.defense,
        speed: 50,
        sp_attack: 50,
        sp_defense: 50,
      },
      base_speed: 50,
      class: 'Walk',
      skills: [],
    },
    pos: { x: u.side === 'A' ? 0 : 1, y: 0 },
    cur_hp: u.curHp,
    status: null,
    budget: { ap: 0, strides_used: 0, attacks: 0, last: null },
    guard: u.guard,
    first_stand: u.firstStand,
    state: 'Active',
  };
}

/** Fire power 40, accuracy 100, melee — the carried known-answer skill. */
const FIRE_40 = {
  skill_id: 1,
  tier: 'Light',
  affinity: 'Fire',
  power: 40,
  accuracy: 100,
  applies_status: null,
  geometry: {
    range_min: 1,
    range_max: 1,
    origin: 'TargetUnit',
    shape: 'Single',
    radius: 0,
    ff_filter: 'Enemies',
  },
};

const SURE = { accuracy: 0, variance: 100 };

/** The AiPlan cases the fixture carries (bt-4's matrix; keep equal to AI_PLAN_CASES in golden_tests.rs). */
const AI_PLAN_CASES = 18;

/** The entry tags of an `{"AiPlan": [...]}` result (`"EndTurn"` is a bare string), comma-joined. */
function planShape(result: unknown): string {
  const entries = (result as { AiPlan?: unknown }).AiPlan;
  expect(Array.isArray(entries), `not an AiPlan result: ${canon(result)}`).toBe(true);
  return (entries as unknown[]).map((e) => (typeof e === 'string' ? e : kindOf(e))).join(',');
}

describe('BT2.5 tactics golden: the bt-2 rules answer byte-identically in wasm', () => {
  it('BT2.5 the fixture carries every bt-2 case kind', () => {
    const kinds = fixture.cases.map(kindOf);
    for (const want of BT2_KINDS) {
      expect(
        kinds.filter((k) => k === want).length,
        `${want} cases in the fixture`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('BT2.5 every bt-2 fixture case is canonically byte-identical to its expected value', () => {
    const results = runWasm();
    let checked = 0;
    fixture.cases.forEach((c, i) => {
      if ((BT2_KINDS as readonly string[]).includes(kindOf(c))) {
        expect(canon(results[i]), `case #${i}: ${canon(c)}`).toBe(canon(fixture.expected[i]));
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(BT2_KINDS.length * 2);
  });

  it('BT2.5 the wasm pipeline floors flank (x5/4) before Guard (x3/4)', () => {
    // d0 5 (Water L5 attack 40, Fire power 40, into a Wind defence-40 target at variance 100):
    // flank 25/4 = 6, then Guard 18/4 = 4 — Guard first would give 3.
    const results = wasmGolden([
      {
        Pipeline: {
          attacker: tacticalUnit({
            id: 1,
            side: 'A',
            affinity: 'Water',
            attack: 40,
            defense: 40,
            curHp: 100,
            guard: false,
            firstStand: false,
          }),
          target: tacticalUnit({
            id: 2,
            side: 'B',
            affinity: 'Wind',
            attack: 40,
            defense: 40,
            curHp: 100,
            guard: true,
            firstStand: false,
          }),
          skill: FIRE_40,
          flank: true,
          rolls: SURE,
        },
      },
    ]);
    expect(results.map(canon)).toEqual([
      canon({
        Pipeline: {
          hit: true,
          d0: 5,
          d1: 6,
          d2: 4,
          d3: 4,
          effectiveness: 'Neutral',
          applied: 4,
          hp_after: 96,
          stood_ground: false,
        },
      }),
    ]);
  });

  it('BT2.5 the wasm roll stream draws accuracy then variance from splitmix64(seed ^ action_seq)', () => {
    // splitmix64(0) is 35 mod 100 and 15 mod 16; splitmix64(1) is 65 mod 100 and 1 mod 16.
    const results = wasmGolden([
      { Rolls: { seed: 0, action_seq: 0, draws: 1 } },
      { Rolls: { seed: 2, action_seq: 2, draws: 1 } },
      { Rolls: { seed: 7, action_seq: 6, draws: 1 } },
      { Rolls: { seed: 0, action_seq: 0, draws: 0 } },
    ]);
    expect(results.map(canon)).toEqual([
      canon({ Rolls: [{ accuracy: 35, variance: 86 }] }),
      canon({ Rolls: [{ accuracy: 35, variance: 86 }] }),
      canon({ Rolls: [{ accuracy: 65, variance: 100 }] }),
      canon({ Rolls: [] }),
    ]);
  });

  it('BT2.5 an invalid Pipeline unit comes back as a BadCase naming its deploy error', () => {
    const fainted = tacticalUnit({
      id: 7,
      side: 'A',
      affinity: 'Fire',
      attack: 40,
      defense: 40,
      curHp: 0,
      guard: false,
      firstStand: false,
    });
    const softTarget = tacticalUnit({
      id: 8,
      side: 'B',
      affinity: 'Plant',
      attack: 40,
      defense: 0,
      curHp: 30,
      guard: false,
      firstStand: false,
    });
    const healthy = tacticalUnit({
      id: 7,
      side: 'A',
      affinity: 'Fire',
      attack: 40,
      defense: 40,
      curHp: 100,
      guard: false,
      firstStand: false,
    });
    const pipeline = (attacker: unknown, target: unknown) => ({
      Pipeline: { attacker, target, skill: FIRE_40, flank: false, rolls: SURE },
    });
    const results = wasmGolden([pipeline(fainted, softTarget), pipeline(healthy, softTarget)]);
    expect(results.map(canon)).toEqual([
      canon({ BadCase: 'invalid unit: Fainted { id: 7 }' }),
      canon({ BadCase: 'invalid unit: ZeroDefense { id: 8 }' }),
    ]);
  });
});

describe('BT4.8 tactics golden: the wasm wild planner plans byte-identically to the native one', () => {
  it('BT4.8 every AiPlan fixture case is canonically byte-identical through tactics_golden', () => {
    const results = runWasm();
    let checked = 0;
    fixture.cases.forEach((c, i) => {
      if (kindOf(c) === 'AiPlan') {
        expect(kindOf(fixture.expected[i]), `expected #${i} kind`).toBe('AiPlan');
        expect(canon(results[i]), `case #${i}: ${canon(c)}`).toBe(canon(fixture.expected[i]));
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(AI_PLAN_CASES);
  });

  it('BT4.8 the wasm planner answers every plan shape on the fixture boards', () => {
    const results = runWasm();
    const shapes = new Set<string>();
    fixture.cases.forEach((c, i) => {
      if (kindOf(c) === 'AiPlan') shapes.add(planShape(results[i]));
    });
    const seen = Array.from(shapes).join(' | ');
    for (const want of ['Skill,EndTurn', 'Move,Skill,EndTurn', 'Move,EndTurn', 'EndTurn']) {
      expect(shapes.has(want), `no ${want} plan among the wasm AiPlan results: ${seen}`).toBe(true);
    }
    expect(shapes.size, `only the four contract shapes: ${seen}`).toBe(4);
  });
});
