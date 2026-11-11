// ui/battlePolicy.test.ts — bt-15 increment B RED tests for `ratingChange` (BT15.3): the pure rule
// that decides whether the Finished phase shows a rating line, and with which before / after.
//
// SOURCE OF TRUTH: spec `M-battle-tactics.spec.md` §bt-15 BT15.3 ("THE Finished phase SHALL show the
// rating change ... when one applied"); plan memory/projects/monster-realm-bt-15-plan.md §8 REV 3.1
// H1: the server rates ONLY a ranked PvP battle with a decisive outcome (ranking.rs
// `apply_pvp_rating`: never wild / practice, never a `Fled` or an unfinished battle), the profile row
// is created lazily by the first rated game (no profile at Active: a null `before`), and the BEFORE is
// the per-battle baseline main.ts snapshotted at the first non-Finished sighting — a baseline of
// another battle is never this battle's. API freeze: `ratingChange({ kind, outcome, battleId,
// baseline, after })` → `{ before, after } | null`, null unless kind === 'Pvp' AND outcome is
// SideAWins / SideBWins AND baseline?.battleId === battleId AND after !== undefined.
//
// RED REASON: `ratingChange` is not exported by ui/battlePolicy.ts.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { describe, expect, it } from 'vitest';
// bt-17 [BT17-1]: the GENERATED bindings (a generated artifact, read for its reducer set).
import { reducers as generatedReducers } from '../module_bindings';
import type { StoreTacticalBattle } from '../net/store';
import {
  battleRenderer,
  COMMAND_BATTLE_POLICY,
  ratingChange,
  renderableBattle,
} from './battlePolicy';
import type { Command } from './screens/types';

/** A battle id past 2^53, and one that differs from it only above 2^53. */
const B = 2n ** 60n + 7n;
const B_TWIN = B + 2n ** 53n;

type Input = Parameters<typeof ratingChange>[0];
const base = (o: Partial<Input> = {}): Input => ({
  kind: 'Pvp',
  outcome: 'SideBWins',
  battleId: B,
  baseline: { battleId: B, rating: 1000 },
  after: 984,
  ...o,
});

describe('battlePolicy: the rating change of a finished battle (bt-15 B, BT15.3)', () => {
  it('ratingChange is the before / after pair of a decided ranked PvP battle whose baseline was taken for THIS battle — 1000 to 984 on a loss, 1000 to 1016 on a win, a null before on a first rated game — and null for a wild or practice battle, an unknown kind, a flight, an unfinished or unknown outcome, another battle`s baseline, no baseline or no profile after [BT15-3]', () => {
    // WRONG IMPL KILLED (REV 3.1 H1): a rating line for a battle the server never rates (Wild,
    // Practice: the plan's "(+0)" line would be WRONG, not missing); a Fled or Ongoing outcome read
    // as decided; the baseline's battle id ignored (a previous battle's snapshot used as this one's
    // BEFORE), or compared through Number() (the twin id differs only above 2^53); a null baseline
    // rating turned into 0 (a first game read as "0 → 1016"); a missing after-profile defaulted to
    // the before or to 0; before and after swapped.
    expect(ratingChange(base()), 'Pvp SideBWins, this battle`s baseline').toEqual({
      before: 1000,
      after: 984,
    });
    expect(ratingChange(base({ outcome: 'SideAWins', after: 1016 })), 'a win').toEqual({
      before: 1000,
      after: 1016,
    });
    expect(
      ratingChange(base({ after: 1000 })),
      'a decided game that left the rating unchanged still has a line',
    ).toEqual({ before: 1000, after: 1000 });
    expect(
      ratingChange(
        base({ outcome: 'SideAWins', baseline: { battleId: B, rating: null }, after: 1016 }),
      ),
      'a first rated game: no profile at the baseline',
    ).toEqual({ before: null, after: 1016 });

    const none: ReadonlyArray<readonly [string, Partial<Input>]> = [
      ['a wild battle', { kind: 'Wild' }],
      ['a practice battle', { kind: 'Practice' }],
      ['no tactical kind', { kind: undefined }],
      ['a flight', { outcome: 'Fled' }],
      ['an unfinished battle', { outcome: 'Ongoing' }],
      ['an unknown outcome', { outcome: 'Draw' }],
      [
        'another battle`s baseline (differing only above 2^53)',
        { baseline: { battleId: B_TWIN, rating: 1000 } },
      ],
      ['no baseline (a reload after the finish)', { baseline: null }],
      ['no profile after', { after: undefined }],
    ];
    for (const [label, o] of none) {
      expect(ratingChange(base(o)), `${label}: no rating line`).toBeNull();
    }
    expect(
      ratingChange(
        base({ battleId: B_TWIN, baseline: { battleId: B_TWIN, rating: 1203 }, after: 1189 }),
      ),
      'control: the twin battle with ITS own baseline',
    ).toEqual({ before: 1203, after: 1189 });
  });
});

// --- bt-17 increment A (BT17.1): the 1v1 commands are unrepresentable; the renderer rule ----------
//
// SOURCE OF TRUTH: spec §bt-17 BT17.1 (the 1v1 reducers and the 1v1 client renderer SHALL be
// deleted); plan memory/projects/monster-realm-bt-17-plan.md REV 3 §2 (`BattleRenderer = 'none' |
// 'deploy' | 'tactical' | 'results'`, `battleRenderer(undefined) === 'none'`, `COMMAND_BATTLE_POLICY`
// −7 rows, `ui/screens/types.ts` loses the seven `Command` kinds) and R11/R12 (ONE predicate
// `renderableBattle(latest, tacticalRow)`: true iff both are defined; the type-level absence check).
//
// RED TODAY: `COMMAND_BATTLE_POLICY` still has the seven 1v1 rows (41 keys, not 34); `Command` still
// has the seven kinds (the three type-level checks below fail `just client-typecheck`);
// `battleRenderer(undefined)` is 'legacy'; `renderableBattle` is not exported; the generated bindings
// still export the seven 1v1 reducers.

/** The seven 1v1 `Command` kinds bt-17 deletes. HARD-CODED (never read from production). */
const GONE_KINDS = [
  'attack',
  'flee',
  'swap',
  'recruit',
  'useItem',
  'pvpAttack',
  'pvpSwap',
] as const;

/** Every `Command` kind after the purge, transcribed from ui/screens/types.ts. HARD-CODED. */
const COMMAND_KINDS = [
  'pop',
  'popToBase',
  'openMenu',
  'toggleHelp',
  'care',
  'train',
  'evolve',
  'setNickname',
  'setPartySlot',
  'healParty',
  'buy',
  'sell',
  // The five trade-session kinds (ts-3); no offer-based trade kind exists (ts-4.6).
  'openTradeSession',
  'openTradeEditor',
  'setTradeOffer',
  'confirmTradeSession',
  'cancelTradeSession',
  'challenge',
  'acceptChallenge',
  'declineChallenge',
  'cancelChallenge',
  'setProfileName',
  'submitQueue',
  'cancelQueue',
  'forfeit',
  'deployUnits',
  'advanceDialogue',
  'dismissDialogue',
  'pickShop',
  'claimSignIn',
  'claimJoin',
  'claimDecline',
  'deleteAccount',
  'cancelAccountDeletion',
  'requestDataExport',
  // uif-14b (UIF14B.3): saving the bug bundle.
  'reportProblem',
] as const;

/** The three offer-based trade kinds no `Command` carries (ts-4.6). HARD-CODED. */
const LEGACY_TRADE_KINDS = ['respondTrade', 'confirmTrade', 'cancelTrade'] as const;

// Compile-level halves (RED under `just client-typecheck` today): no `Command` kind is one of the
// seven; every `Command` kind is in COMMAND_KINDS and every listed kind is a `Command` kind.
type Gone = Extract<Command['kind'], (typeof GONE_KINDS)[number]>;
const _gone: [Gone] extends [never] ? true : false = true;
type Listed = (typeof COMMAND_KINDS)[number];
const _total: [Exclude<Command['kind'], Listed>] extends [never] ? true : false = true;
const _sound: [Exclude<Listed, Command['kind']>] extends [never] ? true : false = true;

describe('battlePolicy: no 1v1 command, no 1v1 renderer (bt-17, BT17.1)', () => {
  it('the battle policy table has no row for any of the seven 1v1 commands (attack, flee, swap, recruit, useItem, pvpAttack, pvpSwap), stays total over exactly the 36 Command kinds, and keeps the four tactical actions battle-safe [BT17-1]', () => {
    // WRONG IMPL KILLED: a 1v1 row left in the table (a dead command a stray adapter could still
    // issue at a battle base); a purge that drops a live row with them (the table is no longer
    // total: a Command kind would read `undefined` and `battleSafeCommand` would refuse it); a
    // tactical action reclassified (the shell's submit / cancel / forfeit and the deploy panel's
    // deploy would be refused ON the battle base they run at).
    expect(_gone, 'type level: no Command kind is a 1v1 kind').toBe(true);
    expect(_total && _sound, 'type level: COMMAND_KINDS is exactly the Command kinds').toBe(true);
    for (const kind of GONE_KINDS) {
      expect(kind in COMMAND_BATTLE_POLICY, `no ${kind} row`).toBe(false);
    }
    expect(
      Object.keys(COMMAND_BATTLE_POLICY).sort(),
      'the table is total over exactly the remaining kinds',
    ).toEqual([...COMMAND_KINDS].sort());
    expect(COMMAND_KINDS, 'ANTI-VACUITY: the transcribed roster').toHaveLength(36);
    for (const kind of ['submitQueue', 'cancelQueue', 'deployUnits', 'forfeit'] as const) {
      expect(COMMAND_BATTLE_POLICY[kind], `${kind} stays battle-safe`).toBe('safe');
    }
  });

  it('UIF14B.3 reportProblem is classified once in COMMAND_BATTLE_POLICY as safe (F9 parity: Help opens over a battle and the report must still work there)', () => {
    // WRONG IMPL KILLED: a missing row (the table stops being total; battleSafeCommand reads
    // undefined); a 'refuse' row (the Report a problem row would do nothing over a battle); a
    // 'drop' / other class; a neighbouring row (requestDataExport) flipped to make the roster pass.
    expect('reportProblem' in COMMAND_BATTLE_POLICY).toBe(true);
    expect(COMMAND_BATTLE_POLICY.reportProblem).toBe('safe');
    expect(
      Object.keys(COMMAND_BATTLE_POLICY).filter((k) => k === 'reportProblem'),
      'one row',
    ).toHaveLength(1);
    expect(Object.keys(COMMAND_BATTLE_POLICY)).toHaveLength(36);
  });

  it('ts-3 the trade-session commands: proposeTrade has no row and no Command kind, and openTradeSession, openTradeEditor, setTradeOffer, confirmTradeSession and cancelTradeSession are each refused over a battle', () => {
    // WRONG IMPL KILLED: the wizard's `proposeTrade` row (or Command arm) left behind; a session
    // kind missing from the table (battleSafeCommand reads undefined); a session kind classified
    // 'safe' (an editor opened, an offer sent or a trade confirmed from a battle base) or 'drop'.
    type Proposed = Extract<Command['kind'], 'proposeTrade'>;
    const noProposeKind: [Proposed] extends [never] ? true : false = true;
    expect(noProposeKind, 'type level: proposeTrade is not a Command kind').toBe(true);
    expect('proposeTrade' in COMMAND_BATTLE_POLICY, 'no proposeTrade row').toBe(false);
    const sessionKinds = [
      'openTradeSession',
      'openTradeEditor',
      'setTradeOffer',
      'confirmTradeSession',
      'cancelTradeSession',
    ] as const;
    for (const kind of sessionKinds) {
      expect(COMMAND_BATTLE_POLICY[kind], `${kind} is refused over a battle`).toBe('refuse');
    }
  });

  it('ts-4.6 the policy table has no respondTrade, confirmTrade or cancelTrade row and no Command kind is one of them; its key set is exactly the 36 Command kinds, 10 safe and 26 refused, each session kind refused', () => {
    // WRONG IMPL KILLED: a legacy trade row left in the table (a dead command a stray adapter could
    // still issue); a `Command` arm left for one of them (the type-level check fails typecheck); a
    // purge that drops a live row or reclassifies one (the safe / refused split moves).
    type LegacyTrade = Extract<Command['kind'], (typeof LEGACY_TRADE_KINDS)[number]>;
    const noLegacyKind: [LegacyTrade] extends [never] ? true : false = true;
    expect(noLegacyKind, 'type level: no Command kind is an offer-based trade kind').toBe(true);
    const table = COMMAND_BATTLE_POLICY as Readonly<Record<string, unknown>>;
    for (const kind of LEGACY_TRADE_KINDS) {
      expect(Object.hasOwn(table, kind), `no ${kind} row`).toBe(false);
      expect(table[kind], `${kind} reads nothing`).toBeUndefined();
    }
    expect(Object.keys(COMMAND_BATTLE_POLICY).sort(), 'the key set is the Command roster').toEqual(
      [...COMMAND_KINDS].sort(),
    );
    const classes = Object.values(COMMAND_BATTLE_POLICY);
    expect(
      classes.filter((c) => c === 'safe'),
      'the safe rows',
    ).toHaveLength(10);
    expect(
      classes.filter((c) => c === 'refuse'),
      'the refused rows',
    ).toHaveLength(26);
  });

  it('battleRenderer maps no tactical row to none, Deploying to deploy, Active to tactical and Finished to results; renderableBattle is true only when the anchor AND its tactical row are both present [BT17-1]', () => {
    // WRONG IMPL KILLED: the 'legacy' arm kept (a row-less anchor routed to a renderer that no
    // longer exists); two phases swapped; a `renderableBattle` that reads only the anchor (a
    // row-less anchor would count as renderable: reconcileStack would close every drop-policy frame
    // for a terminal one, and refreshBattle would build a view for it) or only the row.
    expect(battleRenderer(undefined), 'no tactical row').toBe('none');
    expect(battleRenderer('Deploying')).toBe('deploy');
    expect(battleRenderer('Active')).toBe('tactical');
    expect(battleRenderer('Finished')).toBe('results');
    const anchor = { battleId: 2n ** 60n + 1n };
    const row = { battleId: anchor.battleId, phase: 'Deploying' } as unknown as StoreTacticalBattle;
    expect(renderableBattle(undefined, undefined), 'no anchor, no row').toBe(false);
    expect(renderableBattle(anchor, undefined), 'an anchor with no tactical row').toBe(false);
    expect(renderableBattle(undefined, row), 'a row with no anchor').toBe(false);
    expect(renderableBattle(anchor, row), 'the anchor and its tactical row').toBe(true);
  });

  it('the generated bindings export none of the seven 1v1 reducers (submit_attack, swap_active, flee, use_battle_item, attempt_recruit, submit_pvp_action, start_battle), while the tactical reducers stay [BT17-1]', () => {
    // WRONG IMPL KILLED: a 1v1 reducer left client-callable (its `#[spacetimedb::reducer]` kept, so
    // `just gen` re-emits it — R-bt-16-STARTBATTLE); a purge that also drops a tactical reducer. The
    // accessor map's keys are normalised to snake_case, so the check holds whichever case the
    // generator emits.
    const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const names = new Set(Object.keys(generatedReducers).map(snake));
    for (const kept of ['submit_queue', 'cancel_queue', 'deploy_units', 'forfeit']) {
      expect(names.has(kept), `control: ${kept} is a generated reducer`).toBe(true);
    }
    for (const gone of [
      'submit_attack',
      'swap_active',
      'flee',
      'use_battle_item',
      'attempt_recruit',
      'submit_pvp_action',
      'start_battle',
    ]) {
      expect(names.has(gone), `${gone} is not a generated reducer`).toBe(false);
    }
  });
});
