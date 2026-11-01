// tactics/wasm.test.ts — bt-11 gating tests for the rules PORT (BT11.7) and the overlay port it
// re-closes (bt-10's deferred BT10.4): `bindTacticsRules(pkg)` over the BUILT client-wasm pkg, the
// serde shapes it hands back, the binding-row adapter `unitRowOf`, `overlaySets` / `intentKind`,
// and the overlay layer. Every rule answer is checked against game-core's own `tactics_golden`
// harness (the SAME wasm build) on the same scenario — the plan's A14 differential — never against
// a TypeScript re-implementation of a rule.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-battle-tactics.spec.md BT11.7 + BT10.4 and the bt-11
// plan (memory/projects/monster-realm-bt-11-plan.md) §4 as amended by REV 2 A1–A17 and REV 3
// A18–A21 (the amendments win). The exported names and shapes of wasm.ts and of the
// `// --- Tactics rules (bt-11) ---` region of client-wasm/src/lib.rs are the contract: every call
// below goes through them.
//
// HOW THE EXPECTED VALUES ARE BUILT:
// - Content facts are pinned literals transcribed from the RON with file:line citations
//   (game-core/content/battle_maps/000-core.ron, species/000-core.ron, skills/000-core.ron,
//   tactics_skills/000-core.ron, tactics_species/000-core.ron). The whole-roster join is proven on
//   the host (client-wasm/src/tactics_tests.rs `bt11_unit_join`, against game-core's build_kits).
// - Rule answers come from `tactics_golden` (golden.rs) with the equivalent GoldenCase: the board
//   rows from the pinned map glyphs ('.' Plain, 'r' Rough, 'w' Water — golden.rs:207-211), the
//   BoardUnits `{id, side, pos, alive: state === 'Active' && cur_hp > 0, class}`
//   (resolve.rs:111-115 + :751-759), the AiPlan units joined, seed / action_seq 0, the spawn
//   `map.spawn_b[wild_index]` (plan A7).
// - Overlay oracles compose those golden answers per tile exactly as plan A3 / A4 / A5 define the
//   sets (the execution gate's path + stride + cost for reach; the probe sweep for aoe and danger;
//   the disengage predicate for shield). Every scenario count is pinned and every Ok / Err kind a
//   tag must cover is asserted present in the GOLDEN answers (non-vacuity).
//
// HOW THE TESTS ARE PROVEN: written red against the API-freeze stubs (every port call threw `bt-11:
// not implemented`), now green against the implementation. Their bite is the WRONG IMPL KILLED note
// above each test: each names the hand-written wrong implementations (and the round-2 red-team
// mutants: h1 integer guards, h2c foreign skill, h3 error identity, h5 overlaySets, h9l Sleep 0,
// b8 / m10b / x5 overlay refusals) that fail a DIFFERENT assertion of that test. RULES-BIND also
// reds on a pkg older than the sources (A15) — run `just wasm` first.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadWasmPkg } from '../../test-util/wasmPkg';
import type { BattleUnit } from '../module_bindings/types';
import { type TacticalUnit as BoardUnitVM, buildBoard } from './boardModel';
import {
  type BattleMapDef,
  bindTacticsRules,
  type Cell,
  type Entry,
  intentKind,
  type OverlayQuery,
  type OverlaysOut,
  overlaySets,
  type QueuedActionRule,
  type RuleResult,
  type RuleSide,
  type RuleStance,
  type RuleStatBlock,
  type RuleStatusEffect,
  type RulesBoard,
  type RulesUnit,
  type RuleTerrain,
  type RuleUnitState,
  type SkillTactics,
  type TacticsRules,
  type TacticsWasmExports,
  type TurnBudget,
  type UnitRow,
  unitRowOf,
} from './wasm';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** Generous per-test timeout for the tile-by-tile golden oracles. */
const SLOW = { timeout: 120_000 };

// --- the contract's names -------------------------------------------------------------------------

/** The 14 `tactics_*` exports (`TacticsWasmExports`, wasm.ts) and the `TacticsRules` method each
 *  backs. bt-11 round 3 (named intentional change, plan REV 5 A26): +`tactics_recruit_targets`
 *  (`recruitTargets`), bound after `tactics_ai_plan`. Was: 13. */
const EXPORT_METHODS: readonly (readonly [keyof TacticsWasmExports, keyof TacticsRules])[] = [
  ['tactics_map', 'map'],
  ['tactics_fresh_budget', 'freshBudget'],
  ['tactics_unit', 'unit'],
  ['tactics_targets', 'targets'],
  ['tactics_path', 'path'],
  ['tactics_disengage', 'disengage'],
  ['tactics_flank', 'flank'],
  ['tactics_forecast', 'forecast'],
  ['tactics_recruit_odds', 'recruitOdds'],
  ['tactics_ai_plan', 'aiPlan'],
  ['tactics_recruit_targets', 'recruitTargets'],
  ['tactics_is_exhausted', 'isExhausted'],
  ['tactics_plan', 'plan'],
  ['tactics_overlays', 'overlays'],
];

// --- content, transcribed (battle_maps/000-core.ron) -----------------------------------------------

const c = (x: number, y: number): Cell => ({ x, y });
const same = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;
const key = (t: Cell): string => `${t.x},${t.y}`;

const PLAIN7 = '.......';
const PLAIN8 = '........';
/** Every content map as golden glyph rows (battle_maps/000-core.ron:8-172, tiles row-major). */
const MAP_ROWS: Readonly<Record<number, readonly string[]>> = {
  1: [PLAIN7, PLAIN7, PLAIN7, PLAIN7, PLAIN7, PLAIN7, PLAIN7], // :16-22 all Plain
  2: [PLAIN7, PLAIN7, PLAIN7, 'w.www.w', PLAIN7, PLAIN7, PLAIN7], // :39 the channel, passages x = 1, 5
  3: [PLAIN7, PLAIN7, 'rrr.rrr', 'rrr.rrr', 'rrr.rrr', PLAIN7, PLAIN7], // :58-60 the rough choke
  4: [PLAIN8, PLAIN8, PLAIN8, PLAIN8, PLAIN8, PLAIN8, PLAIN8, PLAIN8], // :76-83
  5: [PLAIN8, PLAIN8, PLAIN8, 'ww.ww.ww', 'ww.ww.ww', PLAIN8, PLAIN8, PLAIN8], // :100-101
  6: [PLAIN8, PLAIN8, PLAIN8, 'rrr..rrr', 'rrr..rrr', PLAIN8, PLAIN8, PLAIN8], // :121-122
  7: [PLAIN8, PLAIN8, PLAIN8, 'w..ww..w', 'w..ww..w', PLAIN8, PLAIN8, PLAIN8], // :142-143
  8: [PLAIN8, PLAIN8, '..rr....', '....r...', '...r....', '....rr..', PLAIN8, PLAIN8], // :162-165
};
const SPAWN_A: readonly Cell[] = [c(1, 1), c(3, 1), c(5, 1)];
const B7: readonly Cell[] = [c(1, 5), c(3, 5), c(5, 5)];
const B8: readonly Cell[] = [c(2, 6), c(4, 6), c(6, 6)];
const BPVP: readonly Cell[] = [c(6, 6), c(4, 6), c(2, 6)];
const MAP_SPAWNS: Readonly<
  Record<number, { readonly a: readonly Cell[]; readonly b: readonly Cell[] }>
> = {
  1: { a: SPAWN_A, b: B7 },
  2: { a: SPAWN_A, b: B7 },
  3: { a: SPAWN_A, b: B7 },
  4: { a: SPAWN_A, b: B8 },
  5: { a: SPAWN_A, b: B8 },
  6: { a: SPAWN_A, b: B8 },
  7: { a: SPAWN_A, b: BPVP },
  8: { a: SPAWN_A, b: BPVP },
};
const TERRAIN_OF: Readonly<Record<string, RuleTerrain>> = {
  '.': 'Plain',
  r: 'Rough',
  w: 'Water',
  '#': 'Blocked',
};

/** The content map as `tactics_map` must serialise it (map.rs:20-38; elevation / blocks_los default). */
function expectedMap(id: number): BattleMapDef {
  const rows = MAP_ROWS[id];
  return {
    width: rows[0].length,
    height: rows.length,
    tiles: rows.flatMap((r) =>
      [...r].map((g) => ({ terrain: TERRAIN_OF[g], elevation: 0, blocks_los: false })),
    ),
    spawn_a: MAP_SPAWNS[id].a,
    spawn_b: MAP_SPAWNS[id].b,
  };
}

function allTiles(mapId: number): Cell[] {
  const rows = MAP_ROWS[mapId];
  const out: Cell[] = [];
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[0].length; x++) out.push(c(x, y));
  }
  return out;
}

// --- budgets (tuning.rs:108-135 TacticsTuning::DESIGN; economy.rs:57-64) ---------------------------

const IDLE: TurnBudget = { ap: 0, strides_used: 0, attacks: 0, last: null };
/** `TurnBudget::fresh(DESIGN)`: ap_turn 6, nothing used. */
const FRESH: TurnBudget = { ap: 6, strides_used: 0, attacks: 0, last: null };
const apOnly = (ap: number, o: Partial<TurnBudget> = {}): TurnBudget => ({ ...IDLE, ap, ...o });

// --- unit rows and boards ---------------------------------------------------------------------------

const STATS: RuleStatBlock = {
  hp: 100,
  attack: 50,
  defense: 50,
  speed: 50,
  sp_attack: 50,
  sp_defense: 50,
};

interface Spec {
  readonly id: number;
  readonly side: RuleSide;
  readonly slot: number;
  /** Content species: 1 Walk (base speed 65, stride 3), 2 Swim (43, stride 2), 3 Walk (45, stride 2), 4 Nimble, 42 Fly. */
  readonly species: number;
  readonly at: readonly [number, number];
  readonly hp?: number;
  readonly state?: RuleUnitState;
  readonly status?: RuleStatusEffect | null;
  readonly stance?: RuleStance | null;
  readonly wild?: number | null;
  readonly budget?: TurnBudget;
}

function row(s: Spec): UnitRow {
  return {
    id: s.id,
    side: s.side,
    slot: s.slot,
    species_id: s.species,
    level: 10,
    stats: STATS,
    pos: c(s.at[0], s.at[1]),
    cur_hp: s.hp ?? 100,
    status: s.status ?? null,
    budget: s.budget ?? IDLE,
    guard: false,
    first_stand: false,
    state: s.state ?? 'Active',
    stance: s.stance ?? null,
    wild_index: s.wild ?? null,
  };
}

const fainted = (s: Spec): Spec => ({ ...s, state: 'Fainted', hp: 0 });

function board(mapId: number, specs: readonly Spec[]): RulesBoard {
  return { kind: 'Wild', map_id: mapId, units: specs.map(row) };
}

/** `TacticalUnit::is_conscious` (resolve.rs:111-115). */
const alive = (r: UnitRow): boolean => r.state === 'Active' && r.cur_hp > 0;
const opponent = (s: RuleSide): RuleSide => (s === 'A' ? 'B' : 'A');

/** The server's unit order (A6): `(side, slot)`. */
function sortedRows(b: RulesBoard): UnitRow[] {
  return [...b.units].sort((p, q) =>
    p.side === q.side ? p.slot - q.slot : p.side === 'A' ? -1 : 1,
  );
}

function rowOf(b: RulesBoard, id: number): UnitRow {
  const r = b.units.find((u) => u.id === id);
  if (r === undefined) throw new Error(`fixture: no unit ${id}`);
  return r;
}

function q(o: Partial<OverlayQuery> = {}): OverlayQuery {
  return { viewer: 'A', selected: null, skill_id: null, aim: null, budget: FRESH, ...o };
}

// --- the pkg, the port, the golden harness ----------------------------------------------------------

let pkg: Record<string, unknown> | undefined;
let bound: TacticsRules | undefined;

beforeAll(async () => {
  pkg = await loadWasmPkg();
});

function realPkg(): Record<string, unknown> {
  if (pkg === undefined) throw new Error('the client-wasm pkg did not load — run `just wasm`');
  return pkg;
}

/** The port under test, bound once to the REAL pkg (throws while the stub is in place). */
function rules(): TacticsRules {
  bound ??= bindTacticsRules(realPkg() as unknown as TacticsWasmExports);
  return bound;
}

/** game-core's own harness on the same wasm build (golden.rs `run_golden`). */
function golden(cases: readonly unknown[]): unknown[] {
  const fn = realPkg().tactics_golden;
  if (typeof fn !== 'function') {
    throw new Error('client-wasm exports no tactics_golden() — the pkg is stale, run `just wasm`');
  }
  const out = (fn as (cs: readonly unknown[]) => unknown)(cases);
  if (!Array.isArray(out) || out.length !== cases.length) {
    throw new Error('tactics_golden returns one result per case');
  }
  return out;
}

/** Compact JSON with object keys sorted recursively — the byte-identity form (golden.parity.test.ts). */
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

/** The payload of a `{"Tag": payload}` golden result (a BadCase fails loudly). */
function unwrap(result: unknown, tag: string): unknown {
  if (result === null || typeof result !== 'object' || !(tag in result)) {
    throw new Error(`golden: expected a ${tag} result, got ${canon(result)}`);
  }
  return (result as Record<string, unknown>)[tag];
}

/** `Ok` or the Err variant's name, of a `{Ok}` / `{Err}` rule result. */
function kindOf(r: unknown): string {
  const o = r as Record<string, unknown>;
  if ('Ok' in o) return 'Ok';
  const err = o.Err;
  return typeof err === 'string' ? err : Object.keys(err as object)[0];
}

function okOf<T>(r: RuleResult<T, unknown>, label: string): T {
  if (!('Ok' in r)) throw new Error(`${label}: expected Ok, got ${canon(r)}`);
  return r.Ok;
}

const isOk = (r: unknown): boolean => r !== null && typeof r === 'object' && 'Ok' in r;

/**
 * Plan A15: a malformed input is REFUSED — a thrown error that is not a wasm trap and whose
 * message names the input (the caller then makes a valid call to prove the instance survived).
 */
function rejects(label: string, call: () => unknown, needle: string | RegExp): void {
  let threw = false;
  let caught: unknown;
  try {
    call();
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw, `${label}: throws (a malformed input is never answered)`).toBe(true);
  expect(
    caught instanceof WebAssembly.RuntimeError,
    `${label}: a refused input, not a wasm trap (${String(caught)})`,
  ).toBe(false);
  const message = caught instanceof Error ? caught.message : String(caught);
  if (typeof needle === 'string') {
    expect(message, `${label}: the message names the input`).toContain(needle);
  } else {
    expect(message, `${label}: the message names the input`).toMatch(needle);
  }
}

// --- golden boards ------------------------------------------------------------------------------------

interface GoldenUnit {
  readonly id: number;
  readonly side: RuleSide;
  readonly pos: Cell;
  readonly alive: boolean;
  readonly class: string;
}
interface GoldenBoard {
  readonly rows: readonly string[];
  readonly units: readonly GoldenUnit[];
}

/** The rules' `Board` of a client board: the map glyphs and every unit's BoardUnit (class joined). */
function goldenBoard(b: RulesBoard): GoldenBoard {
  return {
    rows: MAP_ROWS[b.map_id],
    units: sortedRows(b).map((r) => ({
      id: r.id,
      side: r.side,
      pos: r.pos,
      alive: alive(r),
      class: rules().unit(r).kit.class,
    })),
  };
}

function skillOf(b: RulesBoard, caster: number, skillId: number): SkillTactics {
  const s = rules()
    .unit(rowOf(b, caster))
    .kit.skills.find((k) => k.skill_id === skillId);
  if (s === undefined) throw new Error(`fixture: unit ${caster} has no skill ${skillId}`);
  return s;
}

/** Plan A4's probe id (u32::MAX). */
const PROBE = 4_294_967_295;

/** Plan A4: the living occupant of `t` is the probe; an empty tile gets a conscious Walk probe. */
function probed(
  units: readonly GoldenUnit[],
  t: Cell,
  side: RuleSide,
): { readonly units: GoldenUnit[]; readonly id: number } {
  const occupant = units.find((u) => u.alive && same(u.pos, t));
  if (occupant !== undefined) return { units: [...units], id: occupant.id };
  return {
    units: [...units, { id: PROBE, side, pos: t, alive: true, class: 'Walk' }],
    id: PROBE,
  };
}

function strideOf(baseSpeed: number): number {
  return unwrap(golden([{ Stride: { base_speed: baseSpeed } }])[0], 'Stride') as number;
}

/**
 * Plan A3 for a client board: every tile `t != own` whose least accepted stride count `s` (the
 * gate's `find_path` cost <= `stride_points(s) = s x stride`, queue.rs:427, then `spend` of
 * `Move{s, taxed}` on the basis budget) is 1 / 2. A dead unit's tax is an Err: the gate refuses it.
 */
function reachOracle(
  b: RulesBoard,
  sel: number,
  basis: TurnBudget,
): { reach1: Cell[]; reach2: Cell[] } {
  const s = rowOf(b, sel);
  const gb = goldenBoard(b);
  const reach1: Cell[] = [];
  const reach2: Cell[] = [];
  const tax = unwrap(
    golden([{ Disengage: { board: gb, mover: sel, start: s.pos } }])[0],
    'Disengage',
  ) as RuleResult<boolean, unknown>;
  if (!('Ok' in tax)) return { reach1, reach2 };
  const stride = strideOf(rules().unit(s).kit.base_speed);
  const afford = golden(
    [1, 2].map((strides) => ({
      Economy: { start: basis, entries: [{ Move: { strides, taxed: tax.Ok } }] },
    })),
  ).map((e) => isOk(unwrap(e, 'Economy')));
  const tiles = allTiles(b.map_id).filter((t) => !same(t, s.pos));
  const paths = golden(
    tiles.map((dest) => ({ Path: { board: gb, mover: sel, start: s.pos, dest } })),
  );
  tiles.forEach((t, i) => {
    const p = unwrap(paths[i], 'Path') as RuleResult<{ readonly cost: number }, unknown>;
    if (!('Ok' in p)) return;
    const band = [1, 2].find((n) => p.Ok.cost <= n * stride);
    if (band === undefined || !afford[band - 1]) return;
    (band === 1 ? reach1 : reach2).push(t);
  });
  return { reach1, reach2 };
}

/** Plan A4 range: `target_set` at `a` is Ok or NoTargetUnit. */
function rangeOracle(b: RulesBoard, sel: number, skillId: number): Cell[] {
  const geometry = skillOf(b, sel, skillId).geometry;
  const gb = goldenBoard(b);
  const tiles = allTiles(b.map_id);
  const res = golden(
    tiles.map((aim) => ({ TargetSet: { board: gb, caster: sel, aim, geometry } })),
  );
  return tiles.filter((_, i) => {
    const r = unwrap(res[i], 'TargetSet') as RuleResult<unknown, unknown>;
    return 'Ok' in r || r.Err === 'NoTargetUnit';
  });
}

/** Plan A4 aoe at the GIVEN aim: nothing when the aim itself is refused, else the probe sweep. */
function aoeOracle(b: RulesBoard, sel: number, skillId: number, aim: Cell): Cell[] {
  const geometry = skillOf(b, sel, skillId).geometry;
  const gb = goldenBoard(b);
  const real = unwrap(
    golden([{ TargetSet: { board: gb, caster: sel, aim, geometry } }])[0],
    'TargetSet',
  );
  if (!isOk(real)) return [];
  const side = opponent(rowOf(b, sel).side);
  const tiles = allTiles(b.map_id);
  const probes = tiles.map((t) => probed(gb.units, t, side));
  const res = golden(
    probes.map((p) => ({
      TargetSet: { board: { rows: gb.rows, units: p.units }, caster: sel, aim, geometry },
    })),
  );
  return tiles.filter((_, i) => {
    const r = unwrap(res[i], 'TargetSet') as RuleResult<number[], unknown>;
    return 'Ok' in r && r.Ok.includes(probes[i].id);
  });
}

/**
 * Plan A4 danger: per conscious unit of the other side (sorted `(side, slot)`), from a fresh budget
 * — the standing tiles (own at s = 0, else the least `s` as in reach), each kit skill feasible as
 * `[Move{s, taxed}?, Attack(tier), EndTurn]`, the probe sweep from the moved board with aim = the
 * standing tile for a Caster-origin skill, else the probed tile.
 */
function dangerOracle(b: RulesBoard, viewer: RuleSide): Cell[][] {
  const gb = goldenBoard(b);
  const tiles = allTiles(b.map_id);
  return sortedRows(b)
    .filter((u) => u.side !== viewer && alive(u))
    .map((e) => {
      const kit = rules().unit(e).kit;
      const stride = strideOf(kit.base_speed);
      const taxed = okOf(
        unwrap(
          golden([{ Disengage: { board: gb, mover: e.id, start: e.pos } }])[0],
          'Disengage',
        ) as RuleResult<boolean, unknown>,
        `disengage of ${e.id}`,
      );
      const others = tiles.filter((t) => !same(t, e.pos));
      const paths = golden(
        others.map((dest) => ({ Path: { board: gb, mover: e.id, start: e.pos, dest } })),
      );
      const moveOk = golden(
        [1, 2].map((strides) => ({
          Economy: { start: FRESH, entries: [{ Move: { strides, taxed } }] },
        })),
      ).map((r) => isOk(unwrap(r, 'Economy')));
      const standing: (readonly [Cell, number])[] = [[e.pos, 0]];
      others.forEach((t, i) => {
        const p = unwrap(paths[i], 'Path') as RuleResult<{ readonly cost: number }, unknown>;
        if (!('Ok' in p)) return;
        const band = [1, 2].find((n) => p.Ok.cost <= n * stride);
        if (band !== undefined && moveOk[band - 1]) standing.push([t, band]);
      });
      const plans: { readonly s: number; readonly k: SkillTactics }[] = [];
      for (const s of [0, 1, 2]) for (const k of kit.skills) plans.push({ s, k });
      const feasible = golden(
        plans.map(({ s, k }) => ({
          Economy: {
            start: FRESH,
            entries: [
              ...(s > 0 ? [{ Move: { strides: s, taxed } }] : []),
              { Attack: k.tier },
              'EndTurn',
            ],
          },
        })),
      ).map((r) => isOk(unwrap(r, 'Economy')));
      const cases: unknown[] = [];
      const ids: number[] = [];
      const at: Cell[] = [];
      for (const [stand, s] of standing) {
        const moved = gb.units.map((u) => (u.id === e.id ? { ...u, pos: stand } : u));
        for (const k of kit.skills) {
          if (!feasible[plans.findIndex((p) => p.s === s && p.k === k)]) continue;
          for (const t of tiles) {
            const pr = probed(moved, t, opponent(e.side));
            cases.push({
              TargetSet: {
                board: { rows: gb.rows, units: pr.units },
                caster: e.id,
                aim: k.geometry.origin === 'Caster' ? stand : t,
                geometry: k.geometry,
              },
            });
            ids.push(pr.id);
            at.push(t);
          }
        }
      }
      const hit = new Set<string>();
      golden(cases).forEach((r, i) => {
        const v = unwrap(r, 'TargetSet') as RuleResult<number[], unknown>;
        if ('Ok' in v && v.Ok.includes(ids[i])) hit.add(key(at[i]));
      });
      return tiles.filter((t) => hit.has(key(t)));
    });
}

function isRowMajor(list: readonly Cell[]): boolean {
  return list.every(
    (t, i) => i === 0 || list[i - 1].y < t.y || (list[i - 1].y === t.y && list[i - 1].x < t.x),
  );
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** A recording stand-in for the pkg (DI): every export logs its arguments. */
function fakePkg(override: Readonly<Record<string, (...args: unknown[]) => unknown>> = {}): {
  readonly pkg: TacticsWasmExports;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const fake: Record<string, unknown> = {};
  for (const [name] of EXPORT_METHODS) {
    fake[name] = (...args: unknown[]) => {
      calls.push({ name, args });
      const fn = override[name];
      if (fn !== undefined) return fn(...args);
      return name === 'tactics_is_exhausted' ? false : { fake: name };
    };
  }
  return { pkg: fake as unknown as TacticsWasmExports, calls };
}

// --- content kits (pinned literals) ------------------------------------------------------------------

const SINGLE = { origin: 'TargetUnit', shape: 'Single', radius: 0, ff_filter: 'Enemies' } as const;
/** skills/000-core.ron:6 Ember (Fire 20/100) + tactics_skills/000-core.ron:17 (Light, 2..3). */
const EMBER: SkillTactics = {
  skill_id: 1,
  tier: 'Light',
  affinity: 'Fire',
  power: 20,
  accuracy: 100,
  applies_status: null,
  geometry: { range_min: 2, range_max: 3, ...SINGLE },
};
/** skills/000-core.ron:7 Fire Fang (Fire 70/95) + tactics_skills/000-core.ron:8 (Heavy, 1..1). */
const FIRE_FANG: SkillTactics = {
  skill_id: 2,
  tier: 'Heavy',
  affinity: 'Fire',
  power: 70,
  accuracy: 95,
  applies_status: null,
  geometry: { range_min: 1, range_max: 1, ...SINGLE },
};
/** skills/000-core.ron:8 Water Gun (Water 20/100) + tactics_skills/000-core.ron:12 (Light, 1..2). */
const WATER_GUN: SkillTactics = {
  skill_id: 3,
  tier: 'Light',
  affinity: 'Water',
  power: 20,
  accuracy: 100,
  applies_status: null,
  geometry: { range_min: 1, range_max: 2, ...SINGLE },
};
/** skills/000-core.ron:11 Razor Leaf (Plant 70/95) + tactics_skills/000-core.ron:20 (Heavy, Diamond r1, 2..3). */
const RAZOR_LEAF: SkillTactics = {
  skill_id: 6,
  tier: 'Heavy',
  affinity: 'Plant',
  power: 70,
  accuracy: 95,
  applies_status: null,
  geometry: {
    range_min: 2,
    range_max: 3,
    origin: 'TargetUnit',
    shape: 'Diamond',
    radius: 1,
    ff_filter: 'Enemies',
  },
};
/** skills/000-core.ron:18 Toxic Sting (Dark 20/100, Poison) + tactics_skills/000-core.ron:14 (Light, 1..2). */
const TOXIC_STING: SkillTactics = {
  skill_id: 11,
  tier: 'Light',
  affinity: 'Dark',
  power: 20,
  accuracy: 100,
  applies_status: 'Poison',
  geometry: { range_min: 1, range_max: 2, ...SINGLE },
};

// --- the rules: binding and the plain exports ----------------------------------------------------

describe('tactics rules port: binding and the plain exports (BT11.7)', () => {
  it('BT11-7-RULES-BIND: the real pkg is fresh and binds every method; a missing export throws naming it; out-of-range primitives throw RangeError before wasm; wasm errors are rethrown by identity; forecast resolves the kit skill', () => {
    // WRONG IMPL KILLED: a stale pkg (built before the sources — A15); a bind that defers the check
    // to the first call (or names every export, or none); `typeof` not checked (a non-function
    // value accepted); a primitive clamped or wrapped (`x >>> 0`, `x & 0xffff`, Math.trunc) instead
    // of refused; an in-range boundary refused; a wasm error wrapped, retried or swallowed; a
    // forecast that sends a default skill or calls wasm for a skill outside the kit; disengage's
    // `start` defaulted to a tile. Round 2: any ONE of the 15 integer parameters (bt-11 round 3:
    // +recruitTargets' unit) left unguarded
    // (2**32 + 1 wraps to 1 — mutants h1*); a skill resolved from the TARGET's kit (h2c); any ONE
    // method that wraps, defaults or converts a thrown wasm value — e.g. `plan` returning
    // `{Err: e}` (h3*).
    const built = statSync(path.join(ROOT, 'client-wasm/pkg/client_wasm_bg.wasm')).mtimeMs;
    const newestSrc = Math.max(
      newestMtime(path.join(ROOT, 'client-wasm/src')),
      newestMtime(path.join(ROOT, 'game-core/src')),
    );
    expect(
      built >= newestSrc,
      'client-wasm/pkg is older than client-wasm/src or game-core/src — run `just wasm`',
    ).toBe(true);

    const r = rules();
    for (const [, method] of EXPORT_METHODS) {
      expect(typeof r[method], `rules.${method} is bound`).toBe('function');
    }

    const names = EXPORT_METHODS.map(([name]) => name as string);
    for (const missing of names) {
      const rest = Object.fromEntries(Object.entries(realPkg()).filter(([k]) => k !== missing));
      let message = '';
      try {
        bindTacticsRules(rest as unknown as TacticsWasmExports);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `binding without ${missing} throws naming it`).toContain(missing);
      expect(
        names.filter((n) => message.includes(n)),
        `the ${missing} error names only that export`,
      ).toEqual([missing]);
    }
    let notFn = '';
    try {
      bindTacticsRules({ ...realPkg(), tactics_plan: 42 } as unknown as TacticsWasmExports);
    } catch (err) {
      notFn = err instanceof Error ? err.message : String(err);
    }
    expect(notFn, 'a non-function export is refused by name').toContain('tactics_plan');

    const { pkg: spy, calls } = fakePkg();
    const port = bindTacticsRules(spy);
    const blank = board(1, []);
    const outOfRange: readonly (readonly [string, () => unknown])[] = [
      ['map(-1)', () => port.map(-1)],
      ['map(2**32)', () => port.map(2 ** 32)],
      ['map(1.5)', () => port.map(1.5)],
      ['map(NaN)', () => port.map(Number.NaN)],
      ['isExhausted(1.5, 3)', () => port.isExhausted(1.5, 3)],
      ['isExhausted(65536, 1)', () => port.isExhausted(65_536, 1)],
      ['isExhausted(1, -1)', () => port.isExhausted(1, -1)],
      ['recruitOdds(70000, 1, 0)', () => port.recruitOdds(70_000, 1, 0)],
      ['recruitOdds(1, 1, 65536)', () => port.recruitOdds(1, 1, 65_536)],
      ['path(mover -1)', () => port.path(blank, -1, c(0, 0))],
      ['path(mover 2**32)', () => port.path(blank, 2 ** 32, c(0, 0))],
      ['targets(skill 2**32)', () => port.targets(blank, 1, 2 ** 32, c(0, 0))],
      ['flank(target -5)', () => port.flank(blank, 1, -5)],
      ['aiPlan(unit 1.25)', () => port.aiPlan(blank, 1.25)],
      ['disengage(mover 2**32 + 1)', () => port.disengage(blank, 2 ** 32 + 1)],
    ];
    for (const [label, call] of outOfRange) {
      let caught: unknown;
      try {
        call();
      } catch (err) {
        caught = err;
      }
      expect(caught instanceof RangeError, `${label}: a RangeError`).toBe(true);
    }
    expect(calls, 'no out-of-range argument reached wasm').toEqual([]);

    port.map(0);
    port.map(2 ** 32 - 1);
    port.isExhausted(65_535, 0);
    port.recruitOdds(0, 65_535, 65_535);
    port.flank(blank, 0, 2 ** 32 - 1);
    expect(
      calls.map((x) => [x.name, ...x.args.filter((a) => typeof a === 'number')]),
      'every in-range boundary passes through unchanged',
    ).toEqual([
      ['tactics_map', 0],
      ['tactics_map', 4_294_967_295],
      ['tactics_is_exhausted', 65_535, 0],
      ['tactics_recruit_odds', 0, 65_535, 65_535],
      ['tactics_flank', 0, 4_294_967_295],
    ]);

    const boom = new Error('rule input refused');
    const thrower = fakePkg({
      tactics_path: () => {
        throw boom;
      },
    });
    let rethrown: unknown;
    try {
      bindTacticsRules(thrower.pkg).path(blank, 1, c(0, 0));
    } catch (err) {
      rethrown = err;
    }
    expect(rethrown, 'a wasm error is rethrown by identity').toBe(boom);
    expect(thrower.calls, 'called exactly once: no retry').toHaveLength(1);

    const glimmer: SkillTactics = {
      ...EMBER,
      skill_id: 42,
      geometry: {
        ...EMBER.geometry,
        range_min: 0,
        range_max: 0,
        origin: 'Caster',
        shape: 'Burst',
        radius: 1,
      },
    };
    const lance: SkillTactics = { ...WATER_GUN, skill_id: 43, tier: 'Heavy' };
    const attacker: RulesUnit = {
      id: 1,
      side: 'A',
      slot: 0,
      kit: {
        species_id: 42,
        affinity: 'Light',
        level: 5,
        stats: STATS,
        base_speed: 50,
        class: 'Fly',
        skills: [glimmer, lance],
      },
      pos: c(0, 0),
      cur_hp: 100,
      status: null,
      budget: IDLE,
      guard: false,
      first_stand: false,
      state: 'Active',
    };
    const target: RulesUnit = { ...attacker, id: 2, side: 'B', pos: c(1, 0) };
    const fk = fakePkg();
    const fp = bindTacticsRules(fk.pkg);
    fp.forecast(attacker, target, 43, true);
    expect(
      fk.calls.map((x) => x.name),
      'forecast calls tactics_forecast once',
    ).toEqual(['tactics_forecast']);
    expect(fk.calls[0].args, 'the kit skill 43 travels as the skill, flank as given').toEqual([
      attacker,
      target,
      lance,
      true,
    ]);
    let outside = false;
    try {
      fp.forecast(attacker, target, 99, false);
    } catch {
      outside = true;
    }
    expect(outside, 'a skill id outside the attacker kit throws').toBe(true);
    expect(fk.calls, 'and never reaches wasm').toHaveLength(1);
    const targetOnly: RulesUnit = {
      ...target,
      kit: { ...target.kit, skills: [...target.kit.skills, { ...lance, skill_id: 77 }] },
    };
    let foreign = false;
    try {
      fp.forecast(attacker, targetOnly, 77, false);
    } catch {
      foreign = true;
    }
    expect(foreign, 'a skill only the TARGET knows is not the attacker skill: it throws').toBe(
      true,
    );
    expect(fk.calls, 'and never reaches wasm either').toHaveLength(1);

    fp.disengage(blank, 3);
    fp.disengage(blank, 3, c(1, 2));
    const starts = fk.calls.filter((x) => x.name === 'tactics_disengage').map((x) => x.args[2]);
    expect(
      starts[0] == null,
      'no start: the mover tile (null/undefined, never a default tile)',
    ).toBe(true);
    expect(starts[1], 'an explicit start travels as given').toEqual(c(1, 2));

    // Every integer parameter, one at a time: 2**32 + 1 is 1 after `>>> 0` (and after `& 0xffff`),
    // so a missing guard forwards a plausible 1 instead of refusing. The forecast attacker carries
    // a skill 1, so a wrapped skill id would even resolve.
    const WRAPS = 2 ** 32 + 1;
    const guarded = fakePkg();
    const gp = bindTacticsRules(guarded.pkg);
    const withOne: RulesUnit = { ...attacker, kit: { ...attacker.kit, skills: [EMBER, lance] } };
    const everyInteger: readonly (readonly [string, () => unknown])[] = [
      ['map(mapId)', () => gp.map(WRAPS)],
      ['targets(caster)', () => gp.targets(blank, WRAPS, 1, c(0, 0))],
      ['targets(skillId)', () => gp.targets(blank, 1, WRAPS, c(0, 0))],
      ['path(mover)', () => gp.path(blank, WRAPS, c(0, 0))],
      ['disengage(mover)', () => gp.disengage(blank, WRAPS)],
      ['flank(attacker)', () => gp.flank(blank, WRAPS, 2)],
      ['flank(target)', () => gp.flank(blank, 1, WRAPS)],
      ['forecast(skillId)', () => gp.forecast(withOne, target, WRAPS, false)],
      ['recruitOdds(maxHp)', () => gp.recruitOdds(WRAPS, 1, 0)],
      ['recruitOdds(hp)', () => gp.recruitOdds(100, WRAPS, 0)],
      ['recruitOdds(baitBonus)', () => gp.recruitOdds(100, 1, WRAPS)],
      ['aiPlan(unit)', () => gp.aiPlan(blank, WRAPS)],
      ['recruitTargets(unit)', () => gp.recruitTargets(blank, WRAPS, FRESH)],
      ['isExhausted(curHp)', () => gp.isExhausted(WRAPS, 4)],
      ['isExhausted(maxHp)', () => gp.isExhausted(1, WRAPS)],
    ];
    expect(everyInteger, 'all 15 integer parameters of TacticsRules').toHaveLength(15);
    for (const [label, call] of everyInteger) {
      let caught: unknown;
      try {
        call();
      } catch (err) {
        caught = err;
      }
      expect(caught instanceof RangeError, `${label} = 2**32 + 1: a RangeError`).toBe(true);
    }
    expect(guarded.calls, 'no wrapped integer reached wasm').toEqual([]);

    // Every method rethrows the wasm error VALUE itself (a plain object here: no `instanceof
    // Error` filter may re-wrap it), and `plan` never turns it into a rule refusal.
    const sentinel = { refused: 'by wasm' };
    const allThrow = fakePkg(
      Object.fromEntries(
        EXPORT_METHODS.map(([name]) => [
          name,
          () => {
            throw sentinel;
          },
        ]),
      ),
    );
    const tp = bindTacticsRules(allThrow.pkg);
    const sample = row({ id: 1, side: 'A', slot: 0, species: 1, at: [0, 0] });
    const everyMethod: readonly (readonly [keyof TacticsRules, () => unknown])[] = [
      ['map', () => tp.map(1)],
      ['freshBudget', () => tp.freshBudget()],
      ['unit', () => tp.unit(sample)],
      ['targets', () => tp.targets(blank, 1, 1, c(0, 0))],
      ['path', () => tp.path(blank, 1, c(0, 0))],
      ['disengage', () => tp.disengage(blank, 1)],
      ['flank', () => tp.flank(blank, 1, 2)],
      ['forecast', () => tp.forecast(attacker, target, 43, false)],
      ['recruitOdds', () => tp.recruitOdds(100, 20, 0)],
      ['aiPlan', () => tp.aiPlan(blank, 1)],
      ['recruitTargets', () => tp.recruitTargets(blank, 1, FRESH)],
      ['isExhausted', () => tp.isExhausted(1, 4)],
      ['plan', () => tp.plan(FRESH, [])],
      ['overlays', () => tp.overlays(blank, q())],
    ];
    expect(
      everyMethod.map(([m]) => m),
      'every TacticsRules method, in export order',
    ).toEqual(EXPORT_METHODS.map(([, m]) => m));
    for (const [method, call] of everyMethod) {
      let got: unknown = 'returned normally';
      try {
        got = call();
      } catch (err) {
        got = err;
      }
      expect(got, `${method}: the thrown wasm value itself, never wrapped or returned`).toBe(
        sentinel,
      );
    }
    expect(
      allThrow.calls.map((x) => x.name),
      'each method called its own export exactly once (no retry, no fallback export)',
    ).toEqual(EXPORT_METHODS.map(([name]) => name));
  });

  it('BT11-7-RULES-MAP: map(id) is the content battle map for ids 1..8 (map 1 is the 7x7 Open Field); an unknown id is refused by id and the instance keeps answering', () => {
    // WRONG IMPL KILLED: tiles column-major or transposed; terrain mapped wrongly (Rough as Water);
    // spawn lists swapped or reordered (map 7/8 spawn_b runs right to left); elevation / blocks_los
    // dropped (serde shape); an unknown id answered with map 1 or with a trap.
    const r = rules();
    for (let id = 1; id <= 8; id++) {
      expect(r.map(id), `map ${id} is the content map`).toStrictEqual(expectedMap(id));
    }
    const m1 = r.map(1);
    expect([m1.width, m1.height, m1.tiles.length], 'map 1 is 7x7').toEqual([7, 7, 49]);
    expect(m1.spawn_a, 'map 1 spawn_a').toEqual([c(1, 1), c(3, 1), c(5, 1)]);
    expect(m1.spawn_b, 'map 1 spawn_b').toEqual([c(1, 5), c(3, 5), c(5, 5)]);
    expect(
      m1.tiles.every((t) => ['Plain', 'Rough', 'Water', 'Blocked'].includes(t.terrain)),
      'every tile is one of the four terrains',
    ).toBe(true);
    rejects('map(4242)', () => r.map(4242), '4242');
    rejects('map(9)', () => r.map(9), /\b9\b/);
    rejects('map(0)', () => r.map(0), /\b0\b/);
    expect(r.map(2).tiles[3 * 7].terrain, 'a later valid call still answers (map 2 row 3)').toBe(
      'Water',
    );
  });

  it('BT11-7-RULES-FRESH: freshBudget() is the design ap_turn budget with nothing used and last null', () => {
    // WRONG IMPL KILLED: `TurnBudget::default()` (ap 0); `last` omitted or undefined instead of
    // null (serialize_missing_as_null); a budget carrying a previous spend.
    const fresh = rules().freshBudget();
    expect(fresh.ap, 'ap_turn 6 (tuning.rs:109)').toBe(6);
    expect(fresh.last, 'no last action, as null').toBeNull();
    expect(fresh, 'exactly {ap 6, strides_used 0, attacks 0, last null}').toStrictEqual(FRESH);
  });

  it('BT11-7-RULES-UNIT: unit(row) joins the content kit (species affinity, base speed, class, [light, heavy]) with the row level and stats, copies every row field verbatim, and refuses an unknown species', () => {
    // WRONG IMPL KILLED: level or stats taken from the species base stats; base_speed from the
    // row's levelled speed (61); the class from the row; the kit heavy-first or built from a
    // different skill registry; applies_status dropped; a row field dropped or swapped (status,
    // budget.last, guard vs first_stand, state); an unknown species joined to a default kit.
    const r = rules();
    const primes: RuleStatBlock = {
      hp: 211,
      attack: 53,
      defense: 59,
      speed: 61,
      sp_attack: 67,
      sp_defense: 71,
    };
    const base: UnitRow = {
      id: 101,
      side: 'B',
      slot: 3,
      species_id: 1,
      level: 37,
      stats: primes,
      pos: c(2, 5),
      cur_hp: 173,
      status: { Sleep: { turns_remaining: 2 } },
      budget: { ap: 5, strides_used: 1, attacks: 1, last: { Move: { strides: 1, taxed: true } } },
      guard: true,
      first_stand: false,
      state: 'Fainted',
      stance: 'Territorial',
      wild_index: 2,
    };
    const u = r.unit(base);
    expect(u.kit.level, 'level from the row (37), not content').toBe(37);
    expect(u.kit.stats, 'stats from the row').toStrictEqual(primes);
    expect(
      u.kit.base_speed,
      'Flameling base speed 65 (species/000-core.ron:6), not the row 61',
    ).toBe(65);
    expect(u.kit.class, 'tactics_species/000-core.ron:12 movement Walk').toBe('Walk');
    expect(u.kit.affinity, 'species/000-core.ron:7 Fire').toBe('Fire');
    expect(u.kit.skills, 'kit (1, 2): [light Ember, heavy Fire Fang]').toStrictEqual([
      EMBER,
      FIRE_FANG,
    ]);
    expect(u, 'every row field verbatim, nothing else').toStrictEqual({
      id: 101,
      side: 'B',
      slot: 3,
      kit: {
        species_id: 1,
        affinity: 'Fire',
        level: 37,
        stats: primes,
        base_speed: 65,
        class: 'Walk',
        skills: [EMBER, FIRE_FANG],
      },
      pos: c(2, 5),
      cur_hp: 173,
      status: { Sleep: { turns_remaining: 2 } },
      budget: base.budget,
      guard: true,
      first_stand: false,
      state: 'Fainted',
    });

    const tidalin = r.unit({ ...base, species_id: 2 });
    expect(
      tidalin.kit,
      'species 2 (species/000-core.ron:12-17, tactics_species :13)',
    ).toStrictEqual({
      species_id: 2,
      affinity: 'Water',
      level: 37,
      stats: primes,
      base_speed: 43,
      class: 'Swim',
      skills: [WATER_GUN, RAZOR_LEAF],
    });
    const stinger = r.unit({ ...base, species_id: 8 });
    expect(stinger.kit.class, 'species 8 is Nimble (tactics_species :19)').toBe('Nimble');
    expect(stinger.kit.skills, 'kit (11, 2): Toxic Sting carries its Poison').toStrictEqual([
      TOXIC_STING,
      FIRE_FANG,
    ]);
    const flyer = r.unit({ ...base, species_id: 42 });
    expect(flyer.kit.class, 'species 42 is Fly (tactics_species :30)').toBe('Fly');
    expect(
      flyer.kit.skills.map((s) => [s.skill_id, s.tier, s.power, canon(s.geometry)]),
      'kit (42, 43): the Caster Burst Light then the 1..2 Heavy (tactics_skills :22, :15)',
    ).toEqual([
      [
        42,
        'Light',
        20,
        canon({
          range_min: 0,
          range_max: 0,
          origin: 'Caster',
          shape: 'Burst',
          radius: 1,
          ff_filter: 'Enemies',
        }),
      ],
      [43, 'Heavy', 70, canon({ range_min: 1, range_max: 2, ...SINGLE })],
    ]);

    const lasts: readonly (Entry | null)[] = [
      null,
      { Move: { strides: 2, taxed: false } },
      { Attack: 'Light' },
      { Attack: 'Heavy' },
      'Item',
      'Recruit',
      'Flee',
      'EndTurn',
    ];
    for (const last of lasts) {
      expect(
        r.unit({ ...base, budget: { ...base.budget, last } }).budget.last,
        `budget.last ${canon(last)}`,
      ).toStrictEqual(last);
    }
    const statuses: readonly (RuleStatusEffect | null)[] = [
      null,
      'Poison',
      'Burn',
      'Paralysis',
      { Sleep: { turns_remaining: 3 } },
      'Freeze',
    ];
    for (const status of statuses) {
      expect(r.unit({ ...base, status }).status, `status ${canon(status)}`).toStrictEqual(status);
    }
    for (const state of ['Active', 'Fainted', 'Recruited'] as const) {
      expect(r.unit({ ...base, state }).state, `state ${state}`).toBe(state);
    }
    expect(r.unit({ ...base, side: 'A' }).side, 'side A').toBe('A');
    expect(
      [r.unit({ ...base, guard: false, first_stand: true })].map((x) => [x.guard, x.first_stand]),
      'guard and first_stand are not swapped',
    ).toEqual([[false, true]]);

    rejects('unit(species 9999)', () => r.unit({ ...base, species_id: 9999 }), '9999');
    expect(r.unit(base).kit.base_speed, 'a later valid join still answers').toBe(65);
  });

  it('BT11-7-RULES-ROW: unitRowOf maps a my_battle_units binding row to the port UnitRow (every budgetLast tag, every status tag, stats renamed, side/state/stance tags, wildIndex) and unit(unitRowOf(row)) round-trips', () => {
    // WRONG IMPL KILLED: spAttack/spDefense swapped or left camelCase; x/y swapped; ap / stridesUsed
    // / attacks crossed; a budgetLast tag mapped to the wrong Entry (AttackLight as Heavy, Move
    // losing taxed); Sleep's turns dropped; a unit tag passed as `{tag}` instead of the serde
    // string; `wildIndex 0` turned into null (`||`); undefined options left undefined instead of
    // null; binding-only fields (battleId, owner, skillIds, movement, stride, affinity) leaking into
    // the UnitRow; the kit joined from the row's skillIds / movement / stride instead of content;
    // a Sleep with 0 turns left read as no status (round-2 mutant h9l).
    const bindingRow = (o: Record<string, unknown> = {}): BattleUnit =>
      ({
        unitId: 61,
        battleId: 9n,
        side: { tag: 'B' },
        owner: undefined,
        slot: 3,
        monsterId: undefined,
        wildIndex: 2,
        speciesId: 1,
        level: 29,
        affinity: { tag: 'Fire' },
        x: 5,
        y: 7,
        curHp: 31,
        stats: { hp: 37, attack: 41, defense: 43, speed: 47, spAttack: 53, spDefense: 59 },
        skillIds: [97, 89],
        status: { tag: 'Sleep', value: 67 },
        ap: 13,
        stridesUsed: 17,
        attacks: 19,
        budgetLast: { tag: 'Move', value: { strides: 23, taxed: true } },
        guard: true,
        firstStand: false,
        movement: { tag: 'Swim' },
        stride: 71,
        stance: { tag: 'Territorial' },
        state: { tag: 'Active' },
        ...o,
      }) as unknown as BattleUnit;
    const want: UnitRow = {
      id: 61,
      side: 'B',
      slot: 3,
      species_id: 1,
      level: 29,
      stats: { hp: 37, attack: 41, defense: 43, speed: 47, sp_attack: 53, sp_defense: 59 },
      pos: c(5, 7),
      cur_hp: 31,
      status: { Sleep: { turns_remaining: 67 } },
      budget: {
        ap: 13,
        strides_used: 17,
        attacks: 19,
        last: { Move: { strides: 23, taxed: true } },
      },
      guard: true,
      first_stand: false,
      state: 'Active',
      stance: 'Territorial',
      wild_index: 2,
    };
    const got = unitRowOf(bindingRow());
    expect(got.stats, 'camelCase stats renamed, each value in its own field').toStrictEqual(
      want.stats,
    );
    expect(got.pos, 'x / y become pos').toStrictEqual(c(5, 7));
    expect(got.budget, 'ap / stridesUsed / attacks / budgetLast become budget').toStrictEqual(
      want.budget,
    );
    expect(got.status, '{tag Sleep, value} becomes {Sleep:{turns_remaining}}').toStrictEqual(
      want.status,
    );
    expect(got, 'the whole UnitRow and nothing else').toStrictEqual(want);

    const lasts: readonly (readonly [unknown, Entry | null])[] = [
      [
        { tag: 'Move', value: { strides: 2, taxed: false } },
        { Move: { strides: 2, taxed: false } },
      ],
      [{ tag: 'AttackLight' }, { Attack: 'Light' }],
      [{ tag: 'AttackHeavy' }, { Attack: 'Heavy' }],
      [{ tag: 'Item' }, 'Item'],
      [{ tag: 'Recruit' }, 'Recruit'],
      [{ tag: 'Flee' }, 'Flee'],
      [{ tag: 'EndTurn' }, 'EndTurn'],
      [undefined, null],
    ];
    for (const [tag, entry] of lasts) {
      expect(
        unitRowOf(bindingRow({ budgetLast: tag })).budget.last,
        `budgetLast ${canon(tag ?? null)}`,
      ).toStrictEqual(entry);
    }
    expect(lasts, 'all 7 BudgetLastEntry tags + none').toHaveLength(8);
    const statuses: readonly (readonly [unknown, RuleStatusEffect | null])[] = [
      [{ tag: 'Poison' }, 'Poison'],
      [{ tag: 'Burn' }, 'Burn'],
      [{ tag: 'Paralysis' }, 'Paralysis'],
      [{ tag: 'Sleep', value: 2 }, { Sleep: { turns_remaining: 2 } }],
      // A falsy payload is still a Sleep (a `value ? ... : null` / `value || ...` mapping drops it).
      [{ tag: 'Sleep', value: 0 }, { Sleep: { turns_remaining: 0 } }],
      [{ tag: 'Freeze' }, 'Freeze'],
      [undefined, null],
    ];
    expect(statuses, 'all 5 StatusEffect tags, Sleep 0, and none').toHaveLength(7);
    for (const [tag, status] of statuses) {
      expect(
        unitRowOf(bindingRow({ status: tag })).status,
        `status ${canon(tag ?? null)}`,
      ).toStrictEqual(status);
    }
    expect(unitRowOf(bindingRow({ side: { tag: 'A' } })).side, 'side A').toBe('A');
    for (const state of ['Active', 'Fainted', 'Recruited'] as const) {
      expect(unitRowOf(bindingRow({ state: { tag: state } })).state, `state ${state}`).toBe(state);
    }
    for (const stance of ['Aggressive', 'Territorial', 'Skittish'] as const) {
      expect(unitRowOf(bindingRow({ stance: { tag: stance } })).stance, `stance ${stance}`).toBe(
        stance,
      );
    }
    expect(unitRowOf(bindingRow({ stance: undefined })).stance, 'no stance is null').toBeNull();
    expect(unitRowOf(bindingRow({ wildIndex: 0 })).wild_index, 'wildIndex 0 stays 0').toBe(0);
    expect(
      unitRowOf(bindingRow({ wildIndex: undefined })).wild_index,
      'no wildIndex is null',
    ).toBeNull();

    for (const o of [
      {},
      { side: { tag: 'A' }, state: { tag: 'Recruited' }, status: { tag: 'Burn' } },
      { budgetLast: { tag: 'AttackHeavy' }, status: undefined, wildIndex: 0 },
    ]) {
      const rowIn = unitRowOf(bindingRow(o));
      const u = rules().unit(rowIn);
      const label = `round trip ${canon(o)}`;
      expect(
        [
          u.id,
          u.side,
          u.slot,
          u.pos,
          u.cur_hp,
          u.status,
          u.budget,
          u.guard,
          u.first_stand,
          u.state,
        ],
        `${label}: the row fields`,
      ).toEqual([
        rowIn.id,
        rowIn.side,
        rowIn.slot,
        rowIn.pos,
        rowIn.cur_hp,
        rowIn.status,
        rowIn.budget,
        rowIn.guard,
        rowIn.first_stand,
        rowIn.state,
      ]);
      expect([u.kit.level, u.kit.stats], `${label}: level and stats from the row`).toEqual([
        29,
        want.stats,
      ]);
      expect(
        [u.kit.class, u.kit.base_speed, u.kit.skills.map((s) => s.skill_id)],
        `${label}: the kit from content (Walk, 65, [1, 2]) — not the row movement / stride / skillIds`,
      ).toEqual(['Walk', 65, [1, 2]]);
    }
  });

  it('BT11-7-RULES-EXHAUSTED: isExhausted is cur_hp x 4 < max_hp in u32, on both sides of every boundary', () => {
    // WRONG IMPL KILLED: `<=` (25/100 and 1/4 exhausted); a u16 product (16384 x 4 wraps to 0 and
    // reads exhausted); arguments swapped; `cur_hp < max_hp / 4` (integer division: 24/99 differs).
    const table: readonly (readonly [number, number, boolean])[] = [
      [24, 100, true],
      [25, 100, false],
      [24, 99, true],
      [25, 99, false],
      [0, 1, true],
      [1, 0, false],
      [0, 0, false],
      [1, 4, false],
      [1, 5, true],
      [16_383, 65_535, true],
      [16_384, 65_535, false],
      [65_535, 65_535, false],
      [0, 65_535, true],
    ];
    const r = rules();
    for (const [cur, max, want] of table) {
      // ai.rs:52-54: u32::from(cur_hp) * 4 < u32::from(max_hp)
      expect(r.isExhausted(cur, max), `isExhausted(${cur}, ${max})`).toBe(want);
    }
  });

  it('BT11-7-RULES-RECRUIT: recruitOdds is the carried quantized odds (the design 20 % HP + 150 bait example), refuses a bait over 1000, and its line items always sum', () => {
    // WRONG IMPL KILLED: per-mille not quantized; base not 8; the bait line uncapped at the 1000
    // bait cap (lines no longer sum); a bait of 1001 clamped instead of refused; Ok/Err shape lost.
    const r = rules();
    expect(r.recruitOdds(100, 20, 150), 'recruit.rs:58 / design §5').toStrictEqual({
      Ok: { pct: 63, base: 8, bait: 15, weakened: 40 },
    });
    expect(r.recruitOdds(100, 20, 1001), 'bait over 1000 is the rule refusal').toStrictEqual({
      Err: { BaitBonus: { bait_bonus: 1001 } },
    });
    const full = okOf(r.recruitOdds(100, 100, 0), 'full HP, no bait');
    expect([full.base, full.bait], 'full HP, no bait: base 8, bait 0').toEqual([8, 0]);
    expect(full.base + full.bait + full.weakened, 'full HP, no bait: lines sum to pct').toBe(
      full.pct,
    );
    let rows = 0;
    for (const hp of [1, 10, 25, 50, 99, 100]) {
      for (const bait of [0, 1, 9, 10, 150, 999, 1000]) {
        const odds = okOf(r.recruitOdds(100, hp, bait), `hp ${hp} bait ${bait}`);
        expect(
          odds.base + odds.bait + odds.weakened,
          `hp ${hp} bait ${bait}: base + bait + weakened == pct`,
        ).toBe(odds.pct);
        expect(odds.base, `hp ${hp} bait ${bait}: base`).toBe(8);
        expect(odds.pct <= 100, `hp ${hp} bait ${bait}: a percent`).toBe(true);
        rows += 1;
      }
    }
    expect(rows, 'ANTI-VACUITY').toBe(42);
  });
});

// --- the A14 differential --------------------------------------------------------------------------

/** Path boards: one per content map, Walk / Swim / Nimble / Fly movers, live and fainted units. */
const P1 = board(1, [
  { id: 1, side: 'A', slot: 0, species: 1, at: [3, 3] },
  { id: 2, side: 'A', slot: 1, species: 2, at: [1, 1] },
  fainted({ id: 3, side: 'A', slot: 2, species: 4, at: [0, 6] }),
  { id: 11, side: 'B', slot: 0, species: 3, at: [3, 5] },
  { id: 12, side: 'B', slot: 1, species: 1, at: [4, 3] },
  fainted({ id: 13, side: 'B', slot: 2, species: 1, at: [6, 6] }),
]);
/** Map 2: enemies hold both channel passages (x = 1 and x = 5 of row 3). */
const P2 = board(2, [
  { id: 21, side: 'A', slot: 0, species: 1, at: [3, 1] },
  { id: 22, side: 'A', slot: 1, species: 2, at: [2, 1] },
  { id: 23, side: 'A', slot: 2, species: 42, at: [4, 1] },
  { id: 31, side: 'B', slot: 0, species: 3, at: [1, 3] },
  { id: 32, side: 'B', slot: 1, species: 3, at: [5, 3] },
]);
const P3 = board(3, [
  { id: 41, side: 'A', slot: 0, species: 1, at: [3, 1] },
  { id: 42, side: 'A', slot: 1, species: 4, at: [1, 1] },
  { id: 51, side: 'B', slot: 0, species: 3, at: [3, 5] },
]);
const P4 = board(4, [
  { id: 61, side: 'A', slot: 0, species: 1, at: [1, 1] },
  { id: 71, side: 'B', slot: 0, species: 3, at: [6, 6] },
]);
const P5 = board(5, [
  { id: 81, side: 'A', slot: 0, species: 1, at: [1, 1] },
  { id: 82, side: 'A', slot: 1, species: 2, at: [3, 1] },
  { id: 91, side: 'B', slot: 0, species: 3, at: [4, 6] },
]);
const P6 = board(6, [
  { id: 101, side: 'A', slot: 0, species: 1, at: [3, 1] },
  { id: 111, side: 'B', slot: 0, species: 3, at: [4, 6] },
]);
const P7 = board(7, [
  { id: 121, side: 'A', slot: 0, species: 1, at: [1, 1] },
  { id: 131, side: 'B', slot: 0, species: 1, at: [6, 6] },
]);
const P8 = board(8, [
  { id: 141, side: 'A', slot: 0, species: 1, at: [1, 1] },
  { id: 151, side: 'B', slot: 0, species: 1, at: [6, 6] },
]);

/** Target boards: map 1 with a Burst caster ringed by enemies, plus maps 5 and 8. */
const T1 = board(1, [
  { id: 1, side: 'A', slot: 0, species: 1, at: [3, 3] },
  { id: 2, side: 'A', slot: 1, species: 42, at: [1, 1] },
  { id: 3, side: 'A', slot: 2, species: 2, at: [5, 1] },
  fainted({ id: 4, side: 'A', slot: 3, species: 1, at: [0, 0] }),
  { id: 11, side: 'B', slot: 0, species: 3, at: [3, 5] },
  { id: 12, side: 'B', slot: 1, species: 1, at: [4, 3] },
  { id: 13, side: 'B', slot: 2, species: 3, at: [1, 2] },
  { id: 14, side: 'B', slot: 3, species: 1, at: [2, 1] },
  fainted({ id: 15, side: 'B', slot: 4, species: 1, at: [0, 1] }),
]);
const T5 = board(5, [
  { id: 81, side: 'A', slot: 0, species: 1, at: [2, 2] },
  { id: 82, side: 'A', slot: 1, species: 42, at: [5, 2] },
  { id: 91, side: 'B', slot: 0, species: 2, at: [2, 4] },
]);
const T8 = board(8, [
  { id: 141, side: 'A', slot: 0, species: 2, at: [1, 1] },
  { id: 151, side: 'B', slot: 0, species: 1, at: [3, 2] },
]);

function posOf(b: RulesBoard, id: number): Cell {
  return rowOf(b, id).pos;
}

describe('tactics rules port: the A14 differential against tactics_golden (BT11.7)', () => {
  it('BT11-7-RULES-TARGETS: targets() equals the golden TargetSet with the caster kit geometry on 21 scenarios over maps 1, 5 and 8 (Ok and OutOfRange / NoTargetUnit / OutOfBounds / AimNotCaster / UnknownCaster); an absent caster or a skill outside the kit throws', () => {
    // WRONG IMPL KILLED: the skill geometry not taken from the caster kit; dead units hit or
    // counted as aim targets; a Caster-origin Burst centred on the aim; the result order not
    // (y, x, id); a fainted caster thrown instead of answered (its UnknownCaster is DATA, A10); an
    // absent caster answered as data; a foreign skill silently resolved.
    const r = rules();
    const cases: readonly (readonly [RulesBoard, number, number, Cell])[] = [
      [T1, 1, 2, c(4, 3)],
      [T1, 1, 2, c(3, 5)],
      [T1, 1, 1, c(3, 5)],
      [T1, 1, 1, c(3, 4)],
      [T1, 1, 1, c(3, 1)],
      [T1, 1, 1, c(7, 3)],
      [T1, 2, 42, c(1, 1)],
      [T1, 2, 42, c(2, 1)],
      [T1, 2, 43, c(1, 2)],
      [T1, 4, 1, c(2, 0)],
      [T1, 3, 6, c(4, 3)],
      [T1, 3, 3, c(5, 3)],
      [T1, 11, 5, c(3, 3)],
      [T1, 12, 2, c(3, 3)],
      [T1, 3, 6, c(3, 5)],
      [T1, 2, 43, c(1, 1)],
      [T5, 81, 1, c(2, 4)],
      [T5, 82, 42, c(5, 2)],
      [T8, 141, 6, c(3, 2)],
      [T8, 151, 1, c(1, 1)],
      [T8, 151, 2, c(1, 1)],
    ];
    expect(cases, 'the pinned compared-case count').toHaveLength(21);
    const want = golden(
      cases.map(([b, caster, skillId, aim]) => ({
        TargetSet: {
          board: goldenBoard(b),
          caster,
          aim,
          geometry: skillOf(b, caster, skillId).geometry,
        },
      })),
    ).map((w) => unwrap(w, 'TargetSet'));
    cases.forEach(([b, caster, skillId, aim], i) => {
      expect(
        canon(r.targets(b, caster, skillId, aim)),
        `targets #${i}: caster ${caster} skill ${skillId} at ${key(aim)} (map ${b.map_id})`,
      ).toBe(canon(want[i]));
    });
    const kinds = want.map(kindOf);
    expect(
      kinds.filter((k) => k === 'Ok').length,
      'ANTI-VACUITY: Ok answers',
    ).toBeGreaterThanOrEqual(10);
    for (const k of [
      'OutOfRange',
      'NoTargetUnit',
      'OutOfBounds',
      'AimNotCaster',
      'UnknownCaster',
    ]) {
      expect(kinds, `ANTI-VACUITY: the golden answers cover ${k}`).toContain(k);
    }
    expect(r.targets(T1, 4, 1, c(2, 0)), 'a FAINTED caster is data (A10)').toEqual({
      Err: { UnknownCaster: 4 },
    });

    const absent = unwrap(
      golden([
        {
          TargetSet: {
            board: goldenBoard(T1),
            caster: 9001,
            aim: c(1, 1),
            geometry: EMBER.geometry,
          },
        },
      ])[0],
      'TargetSet',
    );
    expect(absent, 'the rule answers an absent caster as UnknownCaster').toEqual({
      Err: { UnknownCaster: 9001 },
    });
    rejects('targets(absent caster 9001)', () => r.targets(T1, 9001, 1, c(1, 1)), '9001');
    rejects(
      'targets(skill 43 not in the kit of unit 1)',
      () => r.targets(T1, 1, 43, c(4, 3)),
      '43',
    );
    expect(canon(r.targets(T1, 1, 2, c(4, 3))), 'a later valid call still answers').toBe(
      canon(want[0]),
    );
  });

  it('BT11-7-RULES-PATH: path() equals the golden Path from the mover tile on 26 scenarios over all 8 maps (Ok, SameTile, OutOfBounds, DestOccupied, DestImpassable, Unreachable, UnknownMover for a fainted mover); an absent mover throws', () => {
    // WRONG IMPL KILLED: a straight-line / Manhattan path; allies blocking passage or enemies not;
    // a fainted unit occupying its tile; Walk on water; a path from a wrong start; a dead mover
    // thrown instead of answered (UnknownMover is DATA, A10); an absent mover answered as data.
    const r = rules();
    const cases: readonly (readonly [RulesBoard, number, Cell])[] = [
      [P1, 1, c(3, 0)],
      [P1, 1, c(3, 3)],
      [P1, 1, c(7, 3)],
      [P1, 1, c(3, 5)],
      [P1, 1, c(1, 1)],
      [P1, 1, c(6, 6)],
      [P1, 3, c(0, 5)],
      [P1, 1, c(5, 3)],
      [P1, 12, c(4, 0)],
      [P2, 21, c(3, 5)],
      [P2, 21, c(3, 3)],
      [P2, 22, c(3, 5)],
      [P2, 23, c(3, 5)],
      [P2, 22, c(3, 3)],
      [P2, 31, c(1, 0)],
      [P3, 41, c(2, 5)],
      [P3, 42, c(1, 5)],
      [P3, 41, c(0, 3)],
      [P4, 61, c(6, 5)],
      [P5, 81, c(0, 3)],
      [P5, 82, c(3, 4)],
      [P5, 81, c(1, 6)],
      [P6, 101, c(3, 6)],
      [P7, 121, c(0, 3)],
      [P7, 121, c(2, 5)],
      [P8, 141, c(4, 4)],
    ];
    expect(cases, 'the pinned compared-case count').toHaveLength(26);
    const want = golden(
      cases.map(([b, mover, dest]) => ({
        Path: { board: goldenBoard(b), mover, start: posOf(b, mover), dest },
      })),
    ).map((w) => unwrap(w, 'Path'));
    cases.forEach(([b, mover, dest], i) => {
      expect(
        canon(r.path(b, mover, dest)),
        `path #${i}: mover ${mover} to ${key(dest)} (map ${b.map_id})`,
      ).toBe(canon(want[i]));
    });
    const kinds = want.map(kindOf);
    expect(
      kinds.filter((k) => k === 'Ok').length,
      'ANTI-VACUITY: Ok answers',
    ).toBeGreaterThanOrEqual(12);
    for (const k of [
      'SameTile',
      'OutOfBounds',
      'DestOccupied',
      'DestImpassable',
      'Unreachable',
      'UnknownMover',
    ]) {
      expect(kinds, `ANTI-VACUITY: the golden answers cover ${k}`).toContain(k);
    }
    expect(r.path(P1, 3, c(0, 5)), 'a FAINTED mover is data (A10)').toEqual({
      Err: { UnknownMover: 3 },
    });

    const absent = unwrap(
      golden([{ Path: { board: goldenBoard(P1), mover: 9001, start: c(0, 0), dest: c(1, 0) } }])[0],
      'Path',
    );
    expect(absent, 'the rule answers an absent mover as UnknownMover').toEqual({
      Err: { UnknownMover: 9001 },
    });
    rejects('path(absent mover 9001)', () => r.path(P1, 9001, c(1, 0)), '9001');
    expect(canon(r.path(P1, 1, c(3, 0))), 'a later valid call still answers').toBe(canon(want[0]));
  });

  it('BT11-7-RULES-DISENGAGE: disengage() equals the golden Disengage at the mover tile or a given start on 14 scenarios (taxed / untaxed, Fly exempt, dead enemies ignored, UnknownMover, OutOfBounds); an absent mover throws', () => {
    // WRONG IMPL KILLED: Fly taxed; a dead enemy taxing; an ally taxing; `start` ignored (always
    // the mover tile); an off-board start clamped; a dead mover thrown instead of answered.
    const r = rules();
    const cases: readonly (readonly [RulesBoard, number, Cell | undefined])[] = [
      [T1, 1, undefined],
      [T1, 2, undefined],
      [T1, 3, undefined],
      [T1, 4, undefined],
      [T1, 1, c(0, 6)],
      [T1, 1, c(3, 4)],
      [T1, 1, c(9, 9)],
      [T1, 11, undefined],
      [T1, 12, undefined],
      [T1, 3, c(0, 0)],
      [T1, 14, undefined],
      [P2, 22, c(1, 2)],
      [P2, 23, c(5, 2)],
      [P2, 31, undefined],
    ];
    expect(cases, 'the pinned compared-case count').toHaveLength(14);
    const want = golden(
      cases.map(([b, mover, start]) => ({
        Disengage: { board: goldenBoard(b), mover, start: start ?? posOf(b, mover) },
      })),
    ).map((w) => unwrap(w, 'Disengage'));
    cases.forEach(([b, mover, start], i) => {
      const got = start === undefined ? r.disengage(b, mover) : r.disengage(b, mover, start);
      expect(
        canon(got),
        `disengage #${i}: mover ${mover} at ${start === undefined ? 'its tile' : key(start)}`,
      ).toBe(canon(want[i]));
    });
    const answers = want.map(canon);
    expect(
      answers.filter((a) => a === canon({ Ok: true })).length,
      'ANTI-VACUITY: taxed answers',
    ).toBeGreaterThanOrEqual(3);
    expect(
      answers.filter((a) => a === canon({ Ok: false })).length,
      'ANTI-VACUITY: untaxed answers',
    ).toBeGreaterThanOrEqual(3);
    expect(want.map(kindOf), 'ANTI-VACUITY: UnknownMover and OutOfBounds').toEqual(
      expect.arrayContaining(['UnknownMover', 'OutOfBounds']),
    );
    rejects('disengage(absent mover 9001)', () => r.disengage(T1, 9001), '9001');
    expect(canon(r.disengage(T1, 1)), 'a later valid call still answers').toBe(canon(want[0]));
  });

  it('BT11-7-RULES-FLANK: flank() equals the golden Flank on the pre-attack board on 14 scenarios (0 / 1 / 2 / 3 adjacent allies, the attacker adjacent or ranged, dead allies and attackers, the target side ignored); absent ids throw', () => {
    // WRONG IMPL KILLED: the attacker always counted (a ranged attacker with one ally flanks); dead
    // allies counted; units of the target side counted; ">= 3"; the target's own id instead of
    // its tile; an absent attacker answered `false` (the rule's data) instead of refused.
    const r = rules();
    const F1 = board(4, [
      { id: 11, side: 'B', slot: 0, species: 3, at: [4, 4] },
      { id: 12, side: 'B', slot: 1, species: 3, at: [0, 7] },
      { id: 1, side: 'A', slot: 0, species: 1, at: [4, 3] },
      { id: 2, side: 'A', slot: 1, species: 1, at: [3, 4] },
      { id: 3, side: 'A', slot: 2, species: 1, at: [5, 4] },
      { id: 4, side: 'A', slot: 3, species: 1, at: [4, 6] },
      fainted({ id: 5, side: 'A', slot: 4, species: 1, at: [4, 5] }),
    ]);
    const F2 = board(4, [
      { id: 11, side: 'B', slot: 0, species: 3, at: [4, 4] },
      { id: 12, side: 'B', slot: 1, species: 3, at: [0, 7] },
      { id: 1, side: 'A', slot: 0, species: 1, at: [4, 3] },
      { id: 4, side: 'A', slot: 1, species: 1, at: [4, 6] },
    ]);
    const F3 = board(4, [
      { id: 11, side: 'B', slot: 0, species: 3, at: [4, 4] },
      { id: 12, side: 'B', slot: 1, species: 3, at: [5, 4] },
      { id: 13, side: 'B', slot: 2, species: 3, at: [0, 0] },
      { id: 1, side: 'A', slot: 0, species: 1, at: [4, 3] },
      { id: 2, side: 'A', slot: 1, species: 1, at: [3, 4] },
    ]);
    const F4 = board(4, [
      { id: 11, side: 'B', slot: 0, species: 3, at: [4, 4] },
      { id: 12, side: 'B', slot: 1, species: 3, at: [0, 7] },
      { id: 4, side: 'A', slot: 0, species: 1, at: [4, 6] },
      fainted({ id: 5, side: 'A', slot: 1, species: 1, at: [4, 5] }),
      fainted({ id: 6, side: 'A', slot: 2, species: 1, at: [3, 4] }),
    ]);
    const F5 = board(1, [
      { id: 11, side: 'B', slot: 0, species: 3, at: [0, 0] },
      { id: 1, side: 'A', slot: 0, species: 1, at: [1, 0] },
      { id: 2, side: 'A', slot: 1, species: 1, at: [0, 1] },
    ]);
    const F6 = board(7, [
      { id: 21, side: 'B', slot: 0, species: 3, at: [3, 2] },
      { id: 31, side: 'A', slot: 0, species: 1, at: [3, 1] },
      { id: 32, side: 'A', slot: 1, species: 1, at: [2, 2] },
      { id: 33, side: 'A', slot: 2, species: 1, at: [4, 2] },
      { id: 34, side: 'A', slot: 3, species: 1, at: [5, 5] },
    ]);
    const cases: readonly (readonly [RulesBoard, number, number])[] = [
      [F1, 1, 11],
      [F1, 4, 11],
      [F1, 5, 11],
      [F1, 11, 1],
      [F2, 1, 11],
      [F2, 4, 11],
      [F3, 1, 11],
      [F3, 2, 11],
      [F4, 4, 11],
      [F5, 1, 11],
      [F5, 2, 11],
      [F5, 11, 1],
      [F6, 31, 21],
      [F6, 34, 21],
    ];
    expect(cases, 'the pinned compared-case count').toHaveLength(14);
    const want = golden(
      cases.map(([b, attacker, target]) => ({
        Flank: { units: goldenBoard(b).units, attacker, target: posOf(b, target) },
      })),
    ).map((w) => unwrap(w, 'Flank'));
    cases.forEach(([b, attacker, target], i) => {
      expect(r.flank(b, attacker, target), `flank #${i}: ${attacker} on ${target}`).toBe(want[i]);
    });
    expect(want.filter((w) => w === true).length, 'ANTI-VACUITY: flanked').toBeGreaterThanOrEqual(
      5,
    );
    expect(
      want.filter((w) => w === false).length,
      'ANTI-VACUITY: not flanked',
    ).toBeGreaterThanOrEqual(5);
    // Coverage of the scenario design itself: living units of the attacker's side adjacent to the
    // target (geometry.rs:201-210 counts these), over the cases whose attacker is alive.
    const adjacentCounts = new Set(
      cases.map(([b, attacker, target]) => {
        const side = rowOf(b, attacker).side;
        const t = posOf(b, target);
        return b.units.filter(
          (u) =>
            u.side === side && alive(u) && Math.abs(u.pos.x - t.x) + Math.abs(u.pos.y - t.y) === 1,
        ).length;
      }),
    );
    expect([...adjacentCounts].sort(), 'ANTI-VACUITY: 0, 1, 2 and 3 adjacent allies').toEqual(
      expect.arrayContaining([0, 1, 2, 3]),
    );

    const absent = unwrap(
      golden([{ Flank: { units: goldenBoard(F1).units, attacker: 9001, target: c(4, 4) } }])[0],
      'Flank',
    );
    expect(absent, 'the rule answers an absent attacker as false').toBe(false);
    rejects('flank(absent attacker 9001)', () => r.flank(F1, 9001, 11), '9001');
    rejects('flank(absent target 9002)', () => r.flank(F1, 1, 9002), '9002');
    expect(r.flank(F1, 1, 11), 'a later valid call still answers').toBe(want[0]);
  });

  it('BT11-7-RULES-AIPLAN: aiPlan() equals the golden AiPlan (joined units, seed 0, the row stance, spawn_b[wild_index]) on 16 scenarios over maps 1, 2, 3, 4 and 6 covering every plan shape; an absent unit throws', () => {
    // WRONG IMPL KILLED: the spawn from spawn_a or the wrong index; the stance hard-coded; the
    // planner fed the row's budget or a seeded stream; the units not joined (no kit: every plan
    // [EndTurn]); a fainted wild or a wild with no living enemy answered with an attack; an
    // absent unit answered as [EndTurn] instead of refused.
    const r = rules();
    const near = (o: Partial<Spec> = {}): RulesBoard =>
      board(1, [
        { id: 1, side: 'A', slot: 0, species: 1, at: [3, 2] },
        { id: 11, side: 'B', slot: 0, species: 1, at: [3, 5], stance: 'Aggressive', wild: 1, ...o },
      ]);
    const far = (o: Partial<Spec> = {}): RulesBoard =>
      board(4, [
        { id: 1, side: 'A', slot: 0, species: 1, at: [7, 0] },
        { id: 11, side: 'B', slot: 0, species: 1, at: [2, 6], stance: 'Aggressive', wild: 0, ...o },
      ]);
    const pack = board(1, [
      { id: 1, side: 'A', slot: 0, species: 1, at: [3, 2] },
      { id: 2, side: 'A', slot: 1, species: 3, at: [1, 2] },
      { id: 11, side: 'B', slot: 0, species: 1, at: [1, 5], stance: 'Aggressive', wild: 0 },
      { id: 12, side: 'B', slot: 1, species: 3, at: [3, 5], stance: 'Territorial', wild: 1 },
      { id: 13, side: 'B', slot: 2, species: 2, at: [5, 5], stance: 'Skittish', wild: 2 },
    ]);
    const cases: readonly (readonly [RulesBoard, number])[] = [
      [near(), 11],
      [near({ hp: 20 }), 11],
      [far({ stance: 'Territorial' }), 11],
      [far(), 11],
      [near({ stance: 'Skittish', wild: 2 }), 11],
      [far({ stance: 'Skittish' }), 11],
      [near({ state: 'Fainted', hp: 0 }), 11],
      [
        board(1, [
          fainted({ id: 1, side: 'A', slot: 0, species: 1, at: [3, 2] }),
          { id: 11, side: 'B', slot: 0, species: 1, at: [3, 5], stance: 'Aggressive', wild: 1 },
        ]),
        11,
      ],
      [pack, 11],
      [pack, 12],
      [pack, 13],
      [
        board(2, [
          { id: 1, side: 'A', slot: 0, species: 1, at: [3, 1] },
          { id: 11, side: 'B', slot: 0, species: 2, at: [3, 5], stance: 'Aggressive', wild: 1 },
        ]),
        11,
      ],
      [
        board(3, [
          { id: 1, side: 'A', slot: 0, species: 1, at: [3, 1] },
          { id: 11, side: 'B', slot: 0, species: 1, at: [3, 5], stance: 'Aggressive', wild: 1 },
        ]),
        11,
      ],
      [
        board(6, [
          { id: 1, side: 'A', slot: 0, species: 1, at: [4, 1] },
          { id: 11, side: 'B', slot: 0, species: 42, at: [4, 6], stance: 'Aggressive', wild: 1 },
        ]),
        11,
      ],
      [far({ hp: 20 }), 11],
      [near({ status: { Sleep: { turns_remaining: 2 } } }), 11],
    ];
    expect(cases, 'the pinned compared-case count').toHaveLength(16);
    const want = golden(
      cases.map(([b, unit]) => {
        const w = rowOf(b, unit);
        if (w.stance === null || w.wild_index === null) throw new Error('fixture: not a wild');
        return {
          AiPlan: {
            rows: MAP_ROWS[b.map_id],
            units: sortedRows(b).map((x) => r.unit(x)),
            seed: 0,
            action_seq: 0,
            unit,
            stance: w.stance,
            spawn: MAP_SPAWNS[b.map_id].b[w.wild_index],
          },
        };
      }),
    ).map((x) => unwrap(x, 'AiPlan') as QueuedActionRule[]);
    cases.forEach(([b, unit], i) => {
      expect(canon(r.aiPlan(b, unit)), `aiPlan #${i}: unit ${unit} (map ${b.map_id})`).toBe(
        canon(want[i]),
      );
    });
    const shapes = new Set(
      want.map((p) => p.map((e) => (typeof e === 'string' ? e : Object.keys(e)[0])).join(',')),
    );
    for (const s of ['Move,Skill,EndTurn', 'Skill,EndTurn', 'Move,EndTurn', 'EndTurn']) {
      expect(shapes.has(s), `ANTI-VACUITY: the golden plans include ${s} (${[...shapes]})`).toBe(
        true,
      );
    }
    rejects('aiPlan(absent unit 9001)', () => r.aiPlan(near(), 9001), '9001');
    expect(canon(r.aiPlan(near(), 11)), 'a later valid call still answers').toBe(canon(want[0]));
  });

  it('BT11-7-RULES-PLAN: plan() is the golden Economy total with per-entry costs (prefix differences), the spent budget and guard_on_end per guard_granted, on 18 drafts; every refusal is the golden Err', () => {
    // WRONG IMPL KILLED: Exert missing on the second attack; the tax not charged; costs summed in
    // the shell from a table; `remaining` not the spent copy (strides / attacks / last — EndTurn
    // never becomes last); guard_on_end hard-coded or ignoring last = Recruit/Flee or ap < 2; an Err
    // clamped to Ok or rewritten.
    const r = rules();
    const mv = (strides: number, taxed: boolean): Entry => ({ Move: { strides, taxed } });
    const cases: readonly (readonly [TurnBudget, readonly Entry[]])[] = [
      [FRESH, [mv(1, false), { Attack: 'Heavy' }, 'EndTurn']],
      [FRESH, [{ Attack: 'Light' }, { Attack: 'Light' }]],
      [FRESH, [{ Attack: 'Heavy' }, { Attack: 'Light' }]],
      [FRESH, [mv(2, true)]],
      [FRESH, [mv(1, false), mv(2, false)]],
      [apOnly(5), ['Recruit']],
      [FRESH, ['Recruit']],
      [FRESH, ['Item', 'EndTurn']],
      [FRESH, []],
      [FRESH, ['EndTurn']],
      [apOnly(4, { attacks: 1, last: { Attack: 'Light' } }), [{ Attack: 'Light' }, 'EndTurn']],
      [FRESH, [mv(0, false)]],
      [apOnly(6, { strides_used: 2, last: mv(2, false) }), [mv(1, false)]],
      [apOnly(2, { last: 'Item' }), ['EndTurn']],
      [apOnly(1), ['EndTurn']],
      [apOnly(6, { last: 'Flee' }), []],
      [FRESH, ['Flee']],
      [apOnly(3), [mv(1, true)]],
    ];
    expect(cases, 'the pinned compared-case count').toHaveLength(18);
    let oks = 0;
    let errs = 0;
    const guards = new Set<boolean>();
    for (const [start, entries] of cases) {
      const label = `plan ${canon(start)} ${canon(entries)}`;
      const prefixes = golden(
        entries.map((_, n) => ({ Economy: { start, entries: entries.slice(0, n + 1) } })),
      ).map((x) => unwrap(x, 'Economy') as RuleResult<number, unknown>);
      const whole = unwrap(golden([{ Economy: { start, entries } }])[0], 'Economy') as RuleResult<
        number,
        unknown
      >;
      const got = r.plan(start, entries);
      if (!('Ok' in whole)) {
        expect(canon(got), `${label}: the golden refusal`).toBe(canon(whole));
        errs += 1;
        continue;
      }
      const p = okOf(got, label);
      expect(p.total, `${label}: total == plan_cost`).toBe(whole.Ok);
      const costs = prefixes.map((x, n) => {
        const before = n === 0 ? 0 : okOf(prefixes[n - 1], label);
        return okOf(x, label) - before;
      });
      expect(p.costs, `${label}: per-entry charges`).toEqual(costs);
      // economy.rs:163-173: ap -= charge, strides add, an attack counts, last = every entry but EndTurn.
      let strides = start.strides_used;
      let attacks = start.attacks;
      let last = start.last;
      for (const e of entries) {
        if (typeof e === 'object' && 'Move' in e) strides += e.Move.strides;
        if (typeof e === 'object' && 'Attack' in e) attacks += 1;
        if (e !== 'EndTurn') last = e;
      }
      const remaining: TurnBudget = {
        ap: start.ap - whole.Ok,
        strides_used: strides,
        attacks,
        last,
      };
      expect(p.remaining, `${label}: the spent budget`).toStrictEqual(remaining);
      // economy.rs:198-203 at EndTurn (committed): no attack, ap >= guard_min_ap 2, last not Recruit/Flee.
      const guard =
        remaining.attacks === 0 &&
        remaining.ap >= 2 &&
        remaining.last !== 'Recruit' &&
        remaining.last !== 'Flee';
      expect(p.guard_on_end, `${label}: guard_on_end`).toBe(guard);
      guards.add(guard);
      oks += 1;
    }
    expect([oks >= 10, errs >= 5], `ANTI-VACUITY: Ok ${oks}, Err ${errs}`).toEqual([true, true]);
    expect([...guards].sort(), 'ANTI-VACUITY: guard both granted and refused').toEqual([
      false,
      true,
    ]);
  });
});

// --- the overlay layer -----------------------------------------------------------------------------

/** Reach boards. R0: open, untaxed, an ally to pass through, a fainted enemy's tile to stand on. */
const R0 = board(1, [
  { id: 1, side: 'A', slot: 0, species: 1, at: [3, 3] },
  { id: 2, side: 'A', slot: 1, species: 3, at: [3, 2] },
  fainted({ id: 12, side: 'B', slot: 1, species: 1, at: [2, 3] }),
  { id: 11, side: 'B', slot: 0, species: 3, at: [0, 6] },
]);
/** R1: an enemy adjacent (taxed start) that also forces a detour east. */
const R1 = board(1, [
  { id: 1, side: 'A', slot: 0, species: 1, at: [3, 3] },
  { id: 11, side: 'B', slot: 0, species: 1, at: [4, 3] },
]);
const R2SWIM = board(2, [
  { id: 1, side: 'A', slot: 0, species: 2, at: [3, 2] },
  { id: 11, side: 'B', slot: 0, species: 3, at: [3, 6] },
]);
const R2WALK = board(2, [
  { id: 1, side: 'A', slot: 0, species: 3, at: [3, 2] },
  { id: 11, side: 'B', slot: 0, species: 3, at: [3, 6] },
]);
/** Range / aoe board: a Swim lancer (kit 3, 6) at the centre, an ally, an enemy, a fainted enemy. */
const G1 = board(1, [
  { id: 1, side: 'A', slot: 0, species: 2, at: [3, 3] },
  { id: 2, side: 'A', slot: 1, species: 1, at: [3, 2] },
  { id: 11, side: 'B', slot: 0, species: 3, at: [3, 5] },
  fainted({ id: 12, side: 'B', slot: 1, species: 1, at: [4, 3] }),
]);
/** A species-42 Flyer (kit 42 = Caster Burst r1) at the centre with an enemy beside it. */
const G3 = board(1, [
  { id: 2, side: 'A', slot: 0, species: 42, at: [3, 3] },
  { id: 11, side: 'B', slot: 0, species: 3, at: [4, 3] },
  { id: 12, side: 'B', slot: 1, species: 1, at: [3, 5] },
]);
/** Shield board (see the pinned answer in OVERLAYS-SHIELD). */
const S1 = board(1, [
  { id: 1, side: 'A', slot: 0, species: 1, at: [3, 3] },
  { id: 2, side: 'A', slot: 1, species: 3, at: [4, 4] },
  { id: 3, side: 'A', slot: 2, species: 42, at: [6, 0] },
  { id: 11, side: 'B', slot: 0, species: 3, at: [5, 5] },
  fainted({ id: 12, side: 'B', slot: 1, species: 1, at: [1, 1] }),
  { id: 13, side: 'B', slot: 2, species: 3, at: [0, 3] },
]);
/** disengage_taxed (movement.rs:190-204) for S1's Walker 1: tiles beside 11 or 13 (never beside the dead 12). */
const SHIELD_S1: readonly Cell[] = [c(0, 2), c(1, 3), c(0, 4), c(5, 4), c(4, 5), c(6, 5), c(5, 6)];

describe('tactics overlay layer: computed by the wasm rules (BT10.4 via BT11.7)', () => {
  it(
    'BT11-7-OVERLAYS-REACH: reach1/reach2 are exactly the tiles whose least gate-accepted stride count is 1/2 from the query budget (path cost vs strides x stride, the tax, the stride cap), row-major, never occupied or the own tile; Swim crosses water; a fainted selection is empty, not an error',
    SLOW,
    () => {
      // WRONG IMPL KILLED: Manhattan reach ((5,3) behind the adjacent enemy is band 2, not 1);
      // allies blocking (3,1) behind the ally is band 1); the tax ignored (taxed ap 2 / ap 4 rows);
      // the unit's own row budget used instead of the query's (every row's own budget is idle
      // ap 0); strides_used ignored; occupied tiles or the own tile listed; a fainted unit's tile
      // treated as occupied; Swim treated as Walk; a fainted selection thrown or answered with a
      // reach; danger tied to the selection.
      const r = rules();
      const cases: readonly (readonly [string, RulesBoard, TurnBudget])[] = [
        ['R0 fresh', R0, FRESH],
        ['R0 ap 2', R0, apOnly(2)],
        ['R0 ap 4', R0, apOnly(4)],
        ['R0 ap 0', R0, IDLE],
        [
          'R0 strides_used 1',
          R0,
          apOnly(6, { strides_used: 1, last: { Move: { strides: 1, taxed: false } } }),
        ],
        ['R1 fresh (taxed)', R1, FRESH],
        ['R1 ap 2 (taxed)', R1, apOnly(2)],
        ['R1 ap 4 (taxed)', R1, apOnly(4)],
        ['R1 ap 5 (taxed)', R1, apOnly(5)],
        ['R2 Swim fresh', R2SWIM, FRESH],
        ['R2 Walk fresh', R2WALK, FRESH],
      ];
      const got = new Map<string, OverlaysOut>();
      for (const [label, b, basis] of cases) {
        const out = r.overlays(b, q({ selected: 1, budget: basis }));
        got.set(label, out);
        const want = reachOracle(b, 1, basis);
        expect(out.reach1, `${label}: reach1 (every tile cross-checked)`).toEqual(want.reach1);
        expect(out.reach2, `${label}: reach2 (every tile cross-checked)`).toEqual(want.reach2);
        const occupied = b.units.filter(alive).map((u) => key(u.pos));
        for (const t of [...out.reach1, ...out.reach2]) {
          expect(occupied.includes(key(t)), `${label}: ${key(t)} is not occupied`).toBe(false);
        }
        expect(
          isRowMajor(out.reach1) && isRowMajor(out.reach2),
          `${label}: row-major, no dupes`,
        ).toBe(true);
      }
      const at = (label: string): OverlaysOut => {
        const out = got.get(label);
        if (out === undefined) throw new Error(label);
        return out;
      };
      const has = (list: readonly Cell[], t: Cell): boolean => list.some((x) => same(x, t));

      // Pinned facts, each aimed at one cheat (stride 3 for species 1, 2 for species 2 and 3).
      expect(
        [at('R0 fresh').reach1.length, at('R0 fresh').reach2.length],
        'R0: the 25-tile radius-3 diamond minus the own and the ally tile; the other 24 minus the enemy corner',
      ).toEqual([23, 23]);
      expect(
        has(at('R0 fresh').reach1, c(3, 1)),
        'R0: (3,1) through the ally at (3,2) is band 1',
      ).toBe(true);
      expect(has(at('R0 fresh').reach1, c(2, 3)), 'R0: a fainted unit does not occupy (2,3)').toBe(
        true,
      );
      expect(
        has(at('R1 fresh (taxed)').reach2, c(5, 3)) && !has(at('R1 fresh (taxed)').reach1, c(5, 3)),
        'R1: (5,3), Manhattan 2 behind the enemy, costs 4 -> band 2 (not Manhattan reach)',
      ).toBe(true);
      expect(
        [at('R0 ap 2').reach1.length > 0, at('R0 ap 2').reach2.length],
        'untaxed ap 2: Move{1} = 2 fits, Move{2} = 4 does not',
      ).toEqual([true, 0]);
      expect(
        [at('R1 ap 2 (taxed)').reach1.length, at('R1 ap 2 (taxed)').reach2.length],
        'taxed ap 2: Move{1} = 2 + 1 tax does not fit',
      ).toEqual([0, 0]);
      expect(
        [
          at('R0 ap 4').reach2.length > 0,
          at('R1 ap 4 (taxed)').reach2.length,
          at('R1 ap 5 (taxed)').reach2.length > 0,
        ],
        'Move{2}: untaxed 4 fits ap 4; taxed 5 needs ap 5',
      ).toEqual([true, 0, true]);
      expect(
        [at('R0 ap 0').reach1.length, at('R0 ap 0').reach2.length],
        'ap 0: nothing reachable',
      ).toEqual([0, 0]);
      expect(
        [at('R0 strides_used 1').reach1.length > 0, at('R0 strides_used 1').reach2.length],
        'one stride already used: the cap of 2 leaves only band 1',
      ).toEqual([true, 0]);
      expect(
        [c(3, 3), c(3, 4)].map((t) => has(at('R2 Swim fresh').reach1, t)),
        'Swim: the water tile (3,3) and the far bank (3,4) in one stride',
      ).toEqual([true, true]);
      expect(
        [c(3, 3), c(3, 4)].map(
          (t) => has(at('R2 Walk fresh').reach1, t) || has(at('R2 Walk fresh').reach2, t),
        ),
        'Walk: no water, and the far bank is 6 points round the passage (> 4)',
      ).toEqual([false, false]);

      const dead = r.overlays(R0, q({ selected: 12, skill_id: 1, aim: c(2, 1) }));
      expect(
        [dead.reach1, dead.reach2, dead.range, dead.aoe, dead.shield],
        'a FAINTED selection: every selection set empty (data, not a throw)',
      ).toEqual([[], [], [], [], []]);
      expect(dead.danger, 'danger does not depend on the selection').toEqual(
        r.overlays(R0, q()).danger,
      );
    },
  );

  it(
    'BT11-7-OVERLAYS-RANGE: range is every tile where targets() is Ok or NoTargetUnit (cross-checked tile by tile), the Caster-origin skill only the own tile, and nothing without a skill or a selection',
    SLOW,
    () => {
      // WRONG IMPL KILLED: range limited to tiles with a unit (empty tiles must show); an ally tile
      // dropped (Ok([]) is in range); range_min ignored (the own tile / distance 1 for the 2..3
      // Diamond); a Caster-origin skill drawing its burst ring as range; a range with no skill.
      const r = rules();
      const lance = r.overlays(G1, q({ selected: 1, skill_id: 3 })).range;
      expect(lance, 'skill 3 (1..2): the golden range').toEqual(rangeOracle(G1, 1, 3));
      expect(lance, 'skill 3 from the centre: the 12 tiles at distance 1..2').toHaveLength(12);
      const diamond = r.overlays(G1, q({ selected: 1, skill_id: 6 })).range;
      expect(diamond, 'skill 6 (2..3): the golden range').toEqual(rangeOracle(G1, 1, 6));
      expect(diamond, 'skill 6 from the centre: the 20 tiles at distance 2..3').toHaveLength(20);
      const caster = board(1, [
        { id: 2, side: 'A', slot: 0, species: 42, at: [1, 1] },
        { id: 11, side: 'B', slot: 0, species: 3, at: [2, 1] },
      ]);
      expect(
        r.overlays(caster, q({ selected: 2, skill_id: 42 })).range,
        'a Caster-origin skill: exactly the own tile',
      ).toEqual([c(1, 1)]);
      expect(r.overlays(G1, q({ selected: 1 })).range, 'no skill: no range').toEqual([]);
      expect(r.overlays(G1, q({ skill_id: 3 })).range, 'no selection: no range').toEqual([]);
      expect(isRowMajor(lance) && isRowMajor(diamond), 'row-major').toBe(true);
    },
  );

  it(
    'BT11-7-OVERLAYS-AOE: aoe is the probe sweep at the given aim — the Caster Burst rings its caster (empty tiles included, the centre excluded), a Single skill marks its target, a Diamond its five tiles; a refused aim shows nothing',
    SLOW,
    () => {
      // WRONG IMPL KILLED: aoe = the target units' tiles only (the empty ring tiles vanish); the
      // Burst centre included (geometry.rs:178 excludes it); out-of-board ring tiles listed; an aoe
      // drawn for an aim the rule refuses (AimNotCaster, NoTargetUnit) or with no aim.
      const r = rules();
      const burst = r.overlays(G3, q({ selected: 2, skill_id: 42, aim: c(3, 3) })).aoe;
      expect(burst, 'the Burst ring around (3,3), row-major').toEqual([
        c(3, 2),
        c(2, 3),
        c(4, 3),
        c(3, 4),
      ]);
      expect(burst, 'the probe-sweep oracle agrees').toEqual(aoeOracle(G3, 2, 42, c(3, 3)));
      const corner = board(1, [
        { id: 2, side: 'A', slot: 0, species: 42, at: [0, 0] },
        { id: 11, side: 'B', slot: 0, species: 3, at: [6, 6] },
      ]);
      expect(
        r.overlays(corner, q({ selected: 2, skill_id: 42, aim: c(0, 0) })).aoe,
        'in a corner only the two in-board ring tiles',
      ).toEqual([c(1, 0), c(0, 1)]);
      expect(
        r.overlays(G3, q({ selected: 2, skill_id: 42, aim: c(2, 3) })).aoe,
        'a Caster-origin skill aimed off the caster (AimNotCaster): nothing',
      ).toEqual([]);
      expect(
        r.overlays(G1, q({ selected: 1, skill_id: 3, aim: c(3, 5) })).aoe,
        'a Single skill at an enemy: exactly its tile',
      ).toEqual([c(3, 5)]);
      expect(
        r.overlays(G1, q({ selected: 1, skill_id: 3, aim: c(3, 1) })).aoe,
        'a Single skill at an empty tile (NoTargetUnit): nothing',
      ).toEqual([]);
      const diamond = r.overlays(G1, q({ selected: 1, skill_id: 6, aim: c(3, 5) })).aoe;
      expect(diamond, 'the Diamond r1 around (3,5), empty tiles included').toEqual([
        c(3, 4),
        c(2, 5),
        c(3, 5),
        c(4, 5),
        c(3, 6),
      ]);
      expect(diamond, 'the probe-sweep oracle agrees').toEqual(aoeOracle(G1, 1, 6, c(3, 5)));
      expect(r.overlays(G1, q({ selected: 1, skill_id: 6 })).aoe, 'no aim: nothing').toEqual([]);
    },
  );

  it(
    'BT11-7-OVERLAYS-DANGER: one probe-sweep list per conscious enemy of the viewer in (side, slot) order — a fainted enemy has none, a sleeping one still threatens, a species-42 Flyer threatens every neighbour of every tile it can stand on, and the viewer flips the sides',
    SLOW,
    () => {
      // WRONG IMPL KILLED: "aim must equal a target" (empty tiles never threatened); the Burst
      // centred on the probe instead of the standing tile; standing tiles by Manhattan; a Heavy
      // counted after a 2-stride move it cannot afford; a fainted enemy given a list; a sleeping
      // one dropped; the lists in row order instead of (side, slot); `viewer` ignored.
      const r = rules();
      // The fainted B unit at (0,0) is >= 7 from both living B Walkers (species 3, stride 2: reach
      // <= 6) and >= 12 from both A units (species 1, stride 3: reach <= 9), so its tile is outside
      // every zone for either viewer. A corpse INSIDE a zone is board D3 below.
      const D1 = board(4, [
        { id: 21, side: 'B', slot: 2, species: 3, at: [6, 1] },
        {
          id: 22,
          side: 'B',
          slot: 0,
          species: 3,
          at: [4, 4],
          status: { Sleep: { turns_remaining: 2 } },
        },
        fainted({ id: 23, side: 'B', slot: 1, species: 3, at: [0, 0] }),
        { id: 1, side: 'A', slot: 0, species: 1, at: [7, 7] },
        { id: 2, side: 'A', slot: 1, species: 1, at: [5, 7] },
      ]);
      const forA = r.overlays(D1, q({ viewer: 'A' })).danger;
      expect(forA, 'two conscious enemies: two lists (none for the fainted one)').toHaveLength(2);
      expect(
        [forA[0].some((t) => same(t, c(4, 6))), forA[0].some((t) => same(t, c(7, 0)))],
        'list 0 is slot 0 (the sleeper at (4,4)): (4,6) yes, (7,0) out of its reach',
      ).toEqual([true, false]);
      expect(
        [forA[1].some((t) => same(t, c(7, 0))), forA[1].some((t) => same(t, c(4, 6)))],
        'list 1 is slot 2 (at (6,1)): (7,0) yes, (4,6) out of its reach',
      ).toEqual([true, false]);
      expect(forA, 'viewer A: the probe-sweep oracle').toEqual(dangerOracle(D1, 'A'));
      const forB = r.overlays(D1, q({ viewer: 'B' })).danger;
      expect(forB, 'viewer B: the A units are the enemies').toHaveLength(2);
      expect(forB, 'viewer B: the probe-sweep oracle').toEqual(dangerOracle(D1, 'B'));

      const D2 = board(1, [
        { id: 1, side: 'A', slot: 0, species: 1, at: [3, 1] },
        { id: 2, side: 'A', slot: 1, species: 3, at: [0, 0] },
        { id: 13, side: 'B', slot: 0, species: 42, at: [3, 4] },
      ]);
      const burst = r.overlays(D2, q()).danger;
      expect(burst, 'one Flyer, one list').toHaveLength(1);
      // Any stride is >= 2 (movement.rs:55-61) and Fly is never taxed, so every tile within 2 of
      // (3,4) is a standing tile for Move{1} + the Light Burst (2 + 2 AP); its ring is threatened.
      let checked = 0;
      for (const s of allTiles(1)) {
        if (Math.abs(s.x - 3) + Math.abs(s.y - 4) > 2) continue;
        for (const n of [c(s.x, s.y - 1), c(s.x - 1, s.y), c(s.x + 1, s.y), c(s.x, s.y + 1)]) {
          if (n.x < 0 || n.y < 0 || n.x > 6 || n.y > 6) continue;
          expect(
            burst[0].some((t) => same(t, n)),
            `standing at ${key(s)}, the Burst threatens ${key(n)}`,
          ).toBe(true);
        }
        checked += 1;
      }
      expect(checked, 'ANTI-VACUITY: the 13 tiles within 2 of (3,4)').toBe(13);
      expect(burst, 'the probe-sweep oracle').toEqual(dangerOracle(D2, 'A'));

      // A corpse occupies nothing (movement.rs:159-163, geometry.rs:185): the probe stands on the
      // dead A unit's tile (3,4) beside the live melee enemy at (3,3), so the tile is threatened.
      const D3 = board(1, [
        { id: 1, side: 'A', slot: 0, species: 1, at: [0, 6] },
        fainted({ id: 2, side: 'A', slot: 1, species: 1, at: [3, 4] }),
        { id: 11, side: 'B', slot: 0, species: 1, at: [3, 3] },
      ]);
      const corpse = r.overlays(D3, q()).danger;
      expect(
        corpse.map((list) => list.some((t) => same(t, c(3, 4)))),
        "the corpse's tile is threatened (round-2 mutant b2 used the dead unit as the probe)",
      ).toEqual([true]);
      expect(corpse, 'the probe-sweep oracle').toEqual(dangerOracle(D3, 'A'));
      for (const list of [...forA, ...forB, ...burst, ...corpse]) {
        expect(isRowMajor(list), 'each list row-major and de-duplicated').toBe(true);
      }
    },
  );

  it('BT11-7-OVERLAYS-SHIELD: shield is every tile where disengage() for the selection would be taxed (cross-checked tile by tile), empty for a Flyer and with no selection', () => {
    // WRONG IMPL KILLED: "tiles beside any unit of the other side" counting the dead enemy at
    // (1,1); tiles beside allies; Fly selections shielded; a shield with no selection; viewer used
    // instead of the selection's side; unsorted output.
    const r = rules();
    const out = r.overlays(S1, q({ selected: 1 }));
    expect(out.shield, 'the pinned shield of the Walker at (3,3)').toEqual(SHIELD_S1);
    for (const t of allTiles(1)) {
      const taxed = r.disengage(S1, 1, t);
      expect(
        out.shield.some((x) => same(x, t)),
        `${key(t)}: in the shield exactly when disengage() is Ok(true)`,
      ).toBe(canon(taxed) === canon({ Ok: true }));
    }
    expect(r.overlays(S1, q({ selected: 3 })).shield, 'a Fly selection is never taxed').toEqual([]);
    expect(r.overlays(S1, q()).shield, 'no selection: no shield').toEqual([]);
    expect(
      r.overlays(S1, q({ selected: 1, viewer: 'B' })).shield,
      'the selection decides the side, not the viewer',
    ).toEqual(SHIELD_S1);
  });

  it('BT11-7-OVERLAYS-INTENTS: one intent per conscious wild in (side, slot) order with its aiPlan (== golden AiPlan), the Exhausted flag and block_pct 0 / 25 / 100 by status; intentKind and overlaySets turn them into bt-10 chips and tile sets that buildBoard paints', () => {
    // WRONG IMPL KILLED: a chip for a KO'd / 0-HP / recruited wild; intents in row order; a plan
    // that is not the wild planner's; exhausted from the wrong numbers; block_pct as a boolean or
    // 100 for Paralysis; intentKind keyed on the first entry only, or ignoring block_pct 100;
    // overlaySets dropping a set, merging danger lists, leaking extra keys or mis-keying unitId.
    const r = rules();
    const I1 = board(1, [
      { id: 1, side: 'A', slot: 0, species: 1, at: [3, 1] },
      { id: 2, side: 'A', slot: 1, species: 3, at: [1, 1] },
      {
        id: 13,
        side: 'B',
        slot: 2,
        species: 1,
        at: [5, 5],
        stance: 'Aggressive',
        wild: 2,
        state: 'Fainted',
        hp: 0,
      },
      { id: 12, side: 'B', slot: 1, species: 3, at: [3, 5], stance: 'Territorial', wild: 1 },
      {
        id: 11,
        side: 'B',
        slot: 0,
        species: 1,
        at: [1, 5],
        stance: 'Aggressive',
        wild: 0,
        status: 'Paralysis',
        hp: 20,
      },
    ]);
    const I2 = board(1, [
      { id: 1, side: 'A', slot: 0, species: 1, at: [3, 1] },
      {
        id: 11,
        side: 'B',
        slot: 0,
        species: 1,
        at: [1, 5],
        stance: 'Aggressive',
        wild: 0,
        status: { Sleep: { turns_remaining: 2 } },
      },
      {
        id: 12,
        side: 'B',
        slot: 1,
        species: 3,
        at: [3, 5],
        stance: 'Skittish',
        wild: 1,
        status: 'Freeze',
      },
      {
        id: 13,
        side: 'B',
        slot: 2,
        species: 2,
        at: [5, 5],
        stance: 'Territorial',
        wild: 2,
        status: 'Poison',
      },
    ]);
    const I3 = board(4, [
      { id: 1, side: 'A', slot: 0, species: 1, at: [3, 1] },
      {
        id: 11,
        side: 'B',
        slot: 0,
        species: 1,
        at: [2, 6],
        stance: 'Aggressive',
        wild: 0,
        status: 'Burn',
      },
      {
        id: 12,
        side: 'B',
        slot: 1,
        species: 3,
        at: [4, 6],
        stance: 'Aggressive',
        wild: 1,
        state: 'Recruited',
        hp: 50,
      },
      { id: 13, side: 'B', slot: 2, species: 3, at: [6, 6], stance: 'Aggressive', wild: 2, hp: 0 },
    ]);
    // queue.rs:416-421 counted over r in 0..100: none / Poison / Burn never block, Paralysis when
    // r < 25, Sleep and Freeze always.
    const blockOf = (s: RuleStatusEffect | null): number =>
      s === 'Paralysis' ? 25 : s === 'Freeze' || (s !== null && typeof s === 'object') ? 100 : 0;
    const expected: readonly (readonly [RulesBoard, readonly number[]])[] = [
      [I1, [11, 12]],
      [I2, [11, 12, 13]],
      [I3, [11]],
    ];
    const blocks: number[] = [];
    for (const [b, units] of expected) {
      const out = r.overlays(b, q({ selected: 1 }));
      expect(
        out.intents.map((i) => i.unit),
        `map ${b.map_id}: one chip per conscious wild, sorted`,
      ).toEqual(units);
      const goldenPlans = golden(
        units.map((u) => {
          const w = rowOf(b, u);
          return {
            AiPlan: {
              rows: MAP_ROWS[b.map_id],
              units: sortedRows(b).map((x) => r.unit(x)),
              seed: 0,
              action_seq: 0,
              unit: u,
              stance: w.stance,
              spawn: MAP_SPAWNS[b.map_id].b[w.wild_index ?? -1],
            },
          };
        }),
      ).map((x) => unwrap(x, 'AiPlan'));
      out.intents.forEach((intent, i) => {
        const w = rowOf(b, intent.unit);
        expect(canon(intent.plan), `unit ${intent.unit}: the golden AiPlan`).toBe(
          canon(goldenPlans[i]),
        );
        expect(canon(intent.plan), `unit ${intent.unit}: == aiPlan()`).toBe(
          canon(r.aiPlan(b, intent.unit)),
        );
        expect(intent.exhausted, `unit ${intent.unit}: isExhausted(cur_hp, max_hp)`).toBe(
          r.isExhausted(w.cur_hp, w.stats.hp),
        );
        expect(intent.block_pct, `unit ${intent.unit}: block_pct for ${canon(w.status)}`).toBe(
          blockOf(w.status),
        );
        blocks.push(intent.block_pct);
      });
      if (b === I1) {
        expect(
          out.intents.map((i) => i.exhausted),
          'I1: the 20-HP wild is Exhausted',
        ).toEqual([true, false]);
      }
    }
    expect(
      [...new Set(blocks)].sort((a, b) => a - b),
      'ANTI-VACUITY: 0, 25 and 100',
    ).toEqual([0, 25, 100]);

    // A1: block 100 -> hold; else any Skill -> attack; else any Move -> move; else hold.
    const mv: QueuedActionRule = { Move: { x: 1, y: 2, strides: 1 } };
    const sk: QueuedActionRule = { Skill: { skill_id: 2, target: { Unit: 1 } } };
    const burstSelf: QueuedActionRule = { Skill: { skill_id: 42, target: 'SelfTarget' } };
    const kinds: readonly (readonly [readonly QueuedActionRule[], number, string])[] = [
      [[mv, sk, 'EndTurn'], 0, 'attack'],
      [[sk, 'EndTurn'], 0, 'attack'],
      [[burstSelf, 'EndTurn'], 25, 'attack'],
      [[mv, 'EndTurn'], 0, 'move'],
      [['EndTurn'], 0, 'hold'],
      [[], 0, 'hold'],
      [[mv, sk, 'EndTurn'], 100, 'hold'],
      [[mv, 'EndTurn'], 100, 'hold'],
      [[mv, sk, 'EndTurn'], 99, 'attack'],
      [['Flee'], 0, 'hold'],
      [[{ Item: { item_id: 3, target: 'SelfTarget' } }, 'EndTurn'], 0, 'hold'],
    ];
    for (const [plan, block, kind] of kinds) {
      expect(intentKind(plan, block), `intentKind(${canon(plan)}, ${block})`).toBe(kind);
    }

    const out = r.overlays(I1, q({ selected: 1 }));
    const sets = overlaySets(out);
    expect(Object.keys(sets).sort(), 'exactly the bt-10 OverlaySets keys').toEqual([
      'aoe',
      'danger',
      'intents',
      'range',
      'reach1',
      'reach2',
      'shield',
    ]);
    expect(
      [sets.reach1, sets.reach2, sets.range, sets.aoe, sets.shield],
      'tiles copied as {x, y}',
    ).toEqual([out.reach1, out.reach2, out.range, out.aoe, out.shield]);
    expect(sets.danger, 'one danger list per enemy, kept apart').toEqual(out.danger);
    expect(sets.intents, 'intents as {unitId, kind}').toEqual(
      out.intents.map((i) => ({ unitId: i.unit, kind: intentKind(i.plan, i.block_pct) })),
    );
    expect(
      sets.intents.map((i) => i.unitId),
      'the unit ids of the intents',
    ).toEqual([11, 12]);

    // A hand-built DTO, independent of the pkg (round-2 mutants h5*): distinct range and aoe tiles,
    // an EMPTY danger list between two non-empty ones (one deliberately not row-major: the port
    // copies, it never re-sorts), a blocked attacker and a moving wild.
    const dto: OverlaysOut = {
      reach1: [c(1, 1), c(2, 1)],
      reach2: [c(3, 1)],
      range: [c(4, 2), c(5, 2)],
      aoe: [c(5, 3)],
      danger: [[c(0, 5)], [], [c(6, 6), c(6, 5)]],
      shield: [c(2, 2)],
      intents: [
        {
          unit: 5,
          plan: [{ Skill: { skill_id: 2, target: { Unit: 1 } } }, 'EndTurn'],
          exhausted: true,
          block_pct: 100,
        },
        {
          unit: 6,
          plan: [{ Move: { x: 1, y: 1, strides: 1 } }, 'EndTurn'],
          exhausted: false,
          block_pct: 25,
        },
      ],
    };
    const dtoSets = overlaySets(dto);
    expect(
      [dtoSets.reach1, dtoSets.reach2, dtoSets.range, dtoSets.aoe, dtoSets.shield],
      'each set from its own field (range is not aoe, reach1 is not reach2)',
    ).toEqual([[c(1, 1), c(2, 1)], [c(3, 1)], [c(4, 2), c(5, 2)], [c(5, 3)], [c(2, 2)]]);
    expect(dtoSets.danger, 'three lists, the empty one kept in its place, order kept').toEqual([
      [c(0, 5)],
      [],
      [c(6, 6), c(6, 5)],
    ]);
    expect(
      dtoSets.intents,
      'exactly {unitId, kind}: an attack plan blocked 100 % holds; a move at 25 % moves',
    ).toStrictEqual([
      { unitId: 5, kind: 'hold' },
      { unitId: 6, kind: 'move' },
    ]);
    expect(dtoSets.reach1, 'a copied array, not the DTO array').not.toBe(dto.reach1);
    expect(dtoSets.reach1[0], 'a copied tile, not the DTO tile').not.toBe(dto.reach1[0]);
    expect(dtoSets.danger[2], 'a copied danger list').not.toBe(dto.danger[2]);
    expect(dtoSets.danger[2][1], 'a copied danger tile').not.toBe(dto.danger[2][1]);

    const vmUnits: BoardUnitVM[] = I1.units.map((u) => ({
      unitId: u.id,
      side: u.side,
      mine: u.side === 'A',
      ai: u.wild_index !== null,
      speciesId: u.species_id,
      speciesName: 'Sprigg',
      level: u.level,
      affinity: 'Fire',
      x: u.pos.x,
      y: u.pos.y,
      curHp: u.cur_hp,
      maxHp: u.stats.hp,
      status: null,
      ap: 0,
      guard: false,
      firstStand: false,
      role: null,
      stance: u.stance,
      state: u.state,
    }));
    const vm = buildBoard({
      width: 7,
      height: 7,
      units: vmUnits,
      activeUnitId: 1,
      cursor: null,
      overlays: sets,
      dangerOn: true,
    });
    const tile = (t: Cell) => vm.tiles[t.y * 7 + t.x].overlays;
    expect(
      {
        reach1: tile(out.reach1[0]).includes('reach1'),
        shield: tile(out.shield[0]).includes('shield'),
        danger: tile(out.danger[0][0]).includes('danger'),
        intent: vm.units.find((u) => u.unitId === 11)?.intent,
      },
      'the computed sets land on the bt-10 board',
    ).toEqual({
      reach1: true,
      shield: true,
      danger: true,
      intent: intentKind(out.intents[0].plan, out.intents[0].block_pct),
    });
  });

  it('BT11-7-OVERLAYS-REJECT: an unknown selection, an unknown map, duplicate ids, an unknown species and an undeserialisable row are refused by id (never a trap); aiPlan refuses a non-wild, a stance-less wild and an absent unit; the instance keeps answering', () => {
    // WRONG IMPL KILLED: an unknown selection answered with empty sets; an unknown map defaulted
    // to map 1; duplicate ids de-duplicated silently; a panic (RuntimeError: unreachable) for any
    // of them; aiPlan planning for a player unit or defaulting a missing stance; a poisoned
    // instance after a refusal. Round 2 + A20: a query skill outside the selected kit answered
    // with empty sets (b8); a wild_index past spawn_b clamped or defaulted (m10b); a stance-less
    // wild planned by overlays with a default stance (x5); a duplicate (side, slot) or a real unit
    // carrying the probe id u32::MAX accepted; a conscious selection standing off the map answered
    // with sets (while a DEAD one still answers with empty sets).
    const r = rules();
    const dup = board(1, [
      { id: 7777, side: 'A', slot: 0, species: 1, at: [1, 1] },
      { id: 7777, side: 'B', slot: 0, species: 1, at: [5, 5] },
    ]);
    const unknownSpecies = board(1, [
      { id: 1, side: 'A', slot: 0, species: 9999, at: [1, 1] },
      { id: 11, side: 'B', slot: 0, species: 1, at: [5, 5] },
    ]);
    const wilds = board(1, [
      { id: 5555, side: 'A', slot: 0, species: 1, at: [3, 1] },
      { id: 4444, side: 'B', slot: 0, species: 1, at: [3, 5], wild: 1 },
      { id: 11, side: 'B', slot: 1, species: 1, at: [1, 5], stance: 'Aggressive', wild: 0 },
    ]);
    rejects('overlays(selected 9001)', () => r.overlays(S1, q({ selected: 9001 })), '9001');
    rejects('overlays(map 4242)', () => r.overlays({ ...S1, map_id: 4242 }, q()), '4242');
    rejects('path(map 4242)', () => r.path({ ...S1, map_id: 4242 }, 1, c(3, 0)), '4242');
    rejects('overlays(duplicate 7777)', () => r.overlays(dup, q()), '7777');
    rejects('path(duplicate 7777)', () => r.path(dup, 7777, c(2, 2)), '7777');
    rejects('overlays(species 9999)', () => r.overlays(unknownSpecies, q()), '9999');
    rejects('aiPlan(non-wild 5555)', () => r.aiPlan(wilds, 5555), '5555');
    rejects('aiPlan(wild 4444 without a stance)', () => r.aiPlan(wilds, 4444), '4444');
    rejects('aiPlan(absent 9001)', () => r.aiPlan(wilds, 9001), '9001');
    const badSide = {
      ...S1,
      units: [...S1.units, { ...rowOf(S1, 11), id: 99, side: 'C' }],
    } as unknown as RulesBoard;
    rejects('overlays(side C)', () => r.overlays(badSide, q()), /\S/);

    const lancer = board(1, [
      { id: 1, side: 'A', slot: 0, species: 2, at: [3, 3] },
      { id: 11, side: 'B', slot: 0, species: 3, at: [3, 5] },
    ]);
    rejects(
      'overlays(skill 99999 outside the selected kit)',
      () => r.overlays(lancer, q({ selected: 1, skill_id: 99_999 })),
      '99999',
    );
    // Every content map has exactly three spawn_b slots (map.rs:16, battle_maps/000-core.ron).
    const index3 = board(1, [
      { id: 1, side: 'A', slot: 0, species: 1, at: [3, 1] },
      { id: 11, side: 'B', slot: 0, species: 1, at: [3, 5], stance: 'Aggressive', wild: 3 },
    ]);
    rejects(
      'overlays(wild_index 3 on a 3-spawn map)',
      () => r.overlays(index3, q()),
      /wild_index 3/,
    );
    rejects('aiPlan(wild_index 3 on a 3-spawn map)', () => r.aiPlan(index3, 11), /wild_index 3/);
    rejects(
      'overlays(wild 4444 without a stance): the reason',
      () => r.overlays(wilds, q()),
      /stance/,
    );
    rejects('overlays(wild 4444 without a stance): the unit', () => r.overlays(wilds, q()), '4444');
    const probeId = board(1, [
      { id: 4_294_967_295, side: 'A', slot: 0, species: 1, at: [1, 1] },
      { id: 11, side: 'B', slot: 0, species: 1, at: [5, 5] },
    ]);
    rejects(
      'overlays(a real unit with the probe id u32::MAX)',
      () => r.overlays(probeId, q()),
      '4294967295',
    );
    // Units 7 and 63 share (A, slot 7): a message naming the slot or the ids both say 7.
    const sameSlot = board(1, [
      { id: 7, side: 'A', slot: 7, species: 1, at: [1, 1] },
      { id: 63, side: 'A', slot: 7, species: 3, at: [2, 1] },
      { id: 11, side: 'B', slot: 0, species: 1, at: [5, 5] },
    ]);
    rejects('overlays(duplicate (A, slot 7))', () => r.overlays(sameSlot, q()), /\b7\b/);
    rejects('path(duplicate (A, slot 7))', () => r.path(sameSlot, 7, c(1, 2)), /\b7\b/);
    const offBoard = board(1, [
      { id: 8181, side: 'A', slot: 0, species: 1, at: [9, 9] },
      { id: 11, side: 'B', slot: 0, species: 1, at: [5, 5] },
    ]);
    rejects(
      'overlays(conscious selection 8181 standing off the map at (9,9))',
      () => r.overlays(offBoard, q({ selected: 8181 })),
      '8181',
    );
    const deadOffBoard = board(1, [
      fainted({ id: 8181, side: 'A', slot: 0, species: 1, at: [9, 9] }),
      { id: 11, side: 'B', slot: 0, species: 1, at: [5, 5] },
    ]);
    const deadOut = r.overlays(deadOffBoard, q({ selected: 8181, skill_id: 1, aim: c(5, 5) }));
    expect(
      [deadOut.reach1, deadOut.reach2, deadOut.range, deadOut.aoe, deadOut.shield],
      'a DEAD selection off the map is data: empty selection sets (A20)',
    ).toEqual([[], [], [], [], []]);

    expect(r.overlays(S1, q({ selected: 1 })).shield, 'the instance still answers').toEqual(
      SHIELD_S1,
    );
    expect(r.map(1).width, 'and the content is intact').toBe(7);
  });
});

// --- bt-11 increment B: the recruit-target rule (plan REV 5 A26) ---------------------------------

describe('tactics rules port: the recruit targets (BT11.1, REV 5 A26)', () => {
  it('BT11-1-RULES-RECRUIT-TARGETS: recruitTargets(board, unit, budget) on the built pkg lists the conscious wilds adjacent to the unit in state order when the budget is full, and nothing with a partial or spent budget, in PvP, for a wild actor, beside a KO`d wild, a diagonal or a two-tile wild only; the budget handed in wins over the row`s; an unknown unit is refused by id and the instance keeps answering', () => {
    // WRONG IMPL KILLED: adjacency restated in the shell (a diagonal or two-tile wild listed); the
    // actor's ROW budget used instead of the one handed in (U's row is spent: ap 0); ap compared with
    // `>=` some constant instead of the full-budget rule (ap 5, or 4 after a Move, listed); PvP not
    // refused; a wild actor answered; a KO'd wild listed; the hooks' headroom left at the inert
    // `false` (every answer empty — the fresh-budget row reds); the answer in input or id order
    // instead of state (side, slot) order; an unknown unit answered with [] or a wasm trap.
    const r = rules();
    const wild = (
      id: number,
      slot: number,
      at: readonly [number, number],
      wildIndex: number,
    ): Spec => ({ id, side: 'B', slot, species: 3, at, stance: 'Aggressive', wild: wildIndex });
    // Map 1 (7x7 Plain): U (5) at (3,3) with a spent row budget; W1 (31) one tile south, W2 (17) two
    // tiles east, W3 (29) diagonal; an ally (2) west.
    const base: Spec[] = [
      { id: 5, side: 'A', slot: 0, species: 1, at: [3, 3] },
      { id: 2, side: 'A', slot: 1, species: 3, at: [2, 3] },
      wild(31, 0, [3, 4], 0),
      wild(17, 1, [5, 3], 1),
      wild(29, 2, [4, 4], 2),
    ];
    const b = board(1, base);
    // Fixture geometry (the scenario's own design, not a rule): W1 adjacent, W2 and W3 at two.
    const dist = (p: Cell, t: Cell): number => Math.abs(p.x - t.x) + Math.abs(p.y - t.y);
    const u = posOf(b, 5);
    expect(dist(u, posOf(b, 31)), 'fixture: W1 is one tile from U').toBe(1);
    expect(dist(u, posOf(b, 17)), 'fixture: W2 is two tiles from U').toBe(2);
    expect(dist(u, posOf(b, 29)), 'fixture: W3 is diagonal (two tiles) from U').toBe(2);
    expect(rowOf(b, 5).budget, 'fixture: U`s ROW budget is spent (ap 0)').toStrictEqual(IDLE);
    expect(
      isOk(r.plan(r.freshBudget(), ['Recruit'])),
      'cross-check: the fresh budget affords a Recruit',
    ).toBe(true);
    expect(isOk(r.plan(apOnly(5), ['Recruit'])), 'cross-check: ap 5 does not').toBe(false);

    expect(r.recruitTargets(b, 5, r.freshBudget()), 'the fresh budget: [W1]').toEqual([31]);
    expect(r.recruitTargets(b, 5, FRESH), 'the literal fresh budget: [W1]').toEqual([31]);
    expect(r.recruitTargets(b, 5, apOnly(5)), 'ap 5: not the full budget').toEqual([]);
    expect(
      r.recruitTargets(b, 5, {
        ap: 4,
        strides_used: 1,
        attacks: 0,
        last: { Move: { strides: 1, taxed: false } },
      }),
      'after a Move this turn',
    ).toEqual([]);
    expect(r.recruitTargets(b, 5, IDLE), 'a spent budget').toEqual([]);

    // The budget handed in wins over the row's, both ways.
    const freshRow = board(
      1,
      base.map((s) => (s.id === 5 ? { ...s, budget: FRESH } : s)),
    );
    expect(
      r.recruitTargets(freshRow, 5, apOnly(5)),
      'a fresh ROW, an ap-5 budget: nothing',
    ).toEqual([]);
    expect(r.recruitTargets(freshRow, 5, FRESH), 'a fresh row and budget: [W1]').toEqual([31]);

    expect(r.recruitTargets({ ...b, kind: 'Pvp' }, 5, FRESH), 'PvP refuses Recruit').toEqual([]);
    expect(r.recruitTargets(b, 31, FRESH), 'a wild actor recruits nobody').toEqual([]);
    expect(r.recruitTargets(b, 2, FRESH), 'the ally has no adjacent wild').toEqual([]);
    const ko = board(
      1,
      base.map((s) => (s.id === 31 ? fainted(s) : s)),
    );
    expect(r.recruitTargets(ko, 5, FRESH), 'W1 KO`d: nothing').toEqual([]);
    const noneAdjacent = board(
      1,
      base.filter((s) => s.id !== 31),
    );
    expect(r.recruitTargets(noneAdjacent, 5, FRESH), 'no wild adjacent: nothing').toEqual([]);

    // Three adjacent wilds: the answer is the state (side, slot) order — not the input order
    // (41, 37, 43) nor the id order (37, 41, 43).
    const ring = board(1, [
      { id: 5, side: 'A', slot: 0, species: 1, at: [3, 3] },
      wild(41, 2, [3, 2], 0),
      wild(37, 1, [4, 3], 1),
      wild(43, 0, [2, 3], 2),
    ]);
    expect(r.recruitTargets(ring, 5, FRESH), 'state order').toEqual([43, 37, 41]);

    rejects('recruitTargets(absent unit 9001)', () => r.recruitTargets(b, 9001, FRESH), '9001');
    expect(r.recruitTargets(b, 5, FRESH), 'a later valid call still answers').toEqual([31]);
  });
});
