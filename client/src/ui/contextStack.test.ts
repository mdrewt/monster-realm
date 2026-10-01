/**
 * contextStack.test.ts: the pure UI context stack (ctl-2, CTL2.1 / CTL2.3 / CTL2.4).
 *
 * Pure, node env: no DOM, no SDK, no clock. `contextStep(stack, edge)` is the one transition
 * function over a base-first stack (`world` or `battle(id)` at index 0, then upper frames);
 * `mirrorEdges(stack, visible)` turns "which legacy overlays are visible right now" into the
 * edges that bring a stack in line; `movementEnabled` is the one movement gate;
 * `baseFor` derives the base from a battle row; `SCREEN_POLICY` is the total per-overlay table.
 *
 * The contract proven here:
 *  - a push of an id not on the stack appends it and asks for exactly one `clearHeld`;
 *    a push of an id already present is a no-op; a pop removes its frame wherever it sits,
 *    never emits a command, and an absent id is a no-op; a base edge replaces stack[0], keeps
 *    the upper frames and asks for `clearHeld` only when the base KIND changes;
 *  - mirroring is exact and idempotent: after folding `mirrorEdges` the upper-frame ids are
 *    the visible ids (`battleView` being the battle base's own presentation, never a frame
 *    over a battle base), the base is untouched, and a second mirror emits nothing;
 *  - movement is enabled only on a bare world stack with the session gate clear: not under any
 *    upper frame, and not on a battle base even with `battleView` hidden (B17).
 *
 * Every row asserts concrete stacks and commands. No source-text scan, no prose pin.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type BaseFrame,
  baseFor,
  blocksPlayerOpen,
  type Command,
  contextStep,
  type Edge,
  mirrorEdges,
  movementEnabled,
  reconcile,
  SCREEN_POLICY,
  type ServerView,
  type Stack,
  type UpperFrame,
  WORLD_STACK,
} from './contextStack';
import { OVERLAY_IDS, type OverlayId } from './overlayRegistry';

// --- builders -----------------------------------------------------------------------------
const WORLD: BaseFrame = { kind: 'world' };
const battle = (battleId: string): BaseFrame => ({ kind: 'battle', battleId });
const screen = (id: OverlayId): UpperFrame => ({ kind: 'screen', id });
const prompt = (id: OverlayId): UpperFrame => ({ kind: 'prompt', id });
const textEntry = (owner: OverlayId): UpperFrame => ({ kind: 'textEntry', owner });
const stackOf = (base: BaseFrame, ...upper: UpperFrame[]): Stack => [base, ...upper];

const pushEdge = (frame: UpperFrame): Edge => ({ kind: 'push', frame });
const popEdge = (id: OverlayId): Edge => ({ kind: 'pop', id });
const baseEdge = (base: BaseFrame): Edge => ({ kind: 'base', base });

const CLEAR: readonly Command[] = [{ kind: 'clearHeld' }];
const NONE: readonly Command[] = [];

/** The overlay id a frame stands for: a text-entry frame is keyed by its owner. */
const frameId = (f: UpperFrame): OverlayId => (f.kind === 'textEntry' ? f.owner : f.id);

/** Fold a list of edges through `contextStep`, collecting every command in order. */
function fold(
  from: Stack,
  edges: readonly Edge[],
): { readonly stack: Stack; readonly commands: readonly Command[] } {
  let stack = from;
  const commands: Command[] = [];
  for (const edge of edges) {
    const step = contextStep(stack, edge);
    stack = step.stack;
    commands.push(...step.commands);
  }
  return { stack, commands };
}

/** Freeze a stack and every frame in it, so an in-place write throws (ES modules are strict). */
function deepFrozen(s: Stack): Stack {
  for (const frame of s) Object.freeze(frame);
  return Object.freeze([...s]) as unknown as Stack;
}

const BOX: OverlayId = 'boxView';
const PVP: OverlayId = 'pvpView';
const TRADE: OverlayId = 'tradeView';
const RENAME: OverlayId = 'renameView';

describe('context stack: pure core (ctl-2)', () => {
  it('CTL2-1-STEP: push appends a new id once, a duplicate push is a no-op, pop removes a frame wherever it sits, a base edge keeps the frames above it', () => {
    // WRONG IMPL KILLED: a stack that pops only the top (out-of-order close leaves a ghost
    // frame), a duplicate push that stacks the same overlay twice, a pop that throws or
    // clears the stack on an absent id, a base edge that drops the uppers or becomes a push,
    // a step that mutates its input, and a push that ignores the cross-kind id rule.
    interface Row {
      readonly name: string;
      readonly from: Stack;
      readonly edge: Edge;
      readonly to: Stack;
      readonly commands: readonly Command[];
    }
    const rows: readonly Row[] = [
      {
        name: 'push a screen over the world',
        from: WORLD_STACK,
        edge: pushEdge(screen(BOX)),
        to: stackOf(WORLD, screen(BOX)),
        commands: CLEAR,
      },
      {
        name: 'push a prompt over a screen',
        from: stackOf(WORLD, screen(BOX)),
        edge: pushEdge(prompt(PVP)),
        to: stackOf(WORLD, screen(BOX), prompt(PVP)),
        commands: CLEAR,
      },
      {
        name: 'push text entry over a screen (owner is a different id)',
        from: stackOf(WORLD, screen(BOX)),
        edge: pushEdge(textEntry(RENAME)),
        to: stackOf(WORLD, screen(BOX), textEntry(RENAME)),
        commands: CLEAR,
      },
      {
        name: 'duplicate screen push is a no-op',
        from: stackOf(WORLD, screen(BOX)),
        edge: pushEdge(screen(BOX)),
        to: stackOf(WORLD, screen(BOX)),
        commands: NONE,
      },
      {
        name: 'a prompt for an id that is already a screen is a no-op',
        from: stackOf(WORLD, screen(BOX)),
        edge: pushEdge(prompt(BOX)),
        to: stackOf(WORLD, screen(BOX)),
        commands: NONE,
      },
      {
        name: 'text entry whose owner is already on the stack is a no-op',
        from: stackOf(WORLD, screen(RENAME)),
        edge: pushEdge(textEntry(RENAME)),
        to: stackOf(WORLD, screen(RENAME)),
        commands: NONE,
      },
      {
        name: 'duplicate push deep in the stack is a no-op',
        from: stackOf(WORLD, screen(BOX), screen(PVP), screen(TRADE)),
        edge: pushEdge(screen(BOX)),
        to: stackOf(WORLD, screen(BOX), screen(PVP), screen(TRADE)),
        commands: NONE,
      },
      {
        name: 'pop the top frame',
        from: stackOf(WORLD, screen(BOX), screen(PVP)),
        edge: popEdge(PVP),
        to: stackOf(WORLD, screen(BOX)),
        commands: NONE,
      },
      {
        name: 'pop out of order: a middle frame',
        from: stackOf(WORLD, screen(BOX), screen(PVP), screen(TRADE)),
        edge: popEdge(PVP),
        to: stackOf(WORLD, screen(BOX), screen(TRADE)),
        commands: NONE,
      },
      {
        name: 'pop out of order: the lowest upper frame',
        from: stackOf(WORLD, screen(BOX), screen(PVP), screen(TRADE)),
        edge: popEdge(BOX),
        to: stackOf(WORLD, screen(PVP), screen(TRADE)),
        commands: NONE,
      },
      {
        name: 'pop a prompt frame by its id',
        from: stackOf(WORLD, screen(BOX), prompt(PVP)),
        edge: popEdge(PVP),
        to: stackOf(WORLD, screen(BOX)),
        commands: NONE,
      },
      {
        name: 'pop a text-entry frame by its owner id',
        from: stackOf(WORLD, textEntry(RENAME)),
        edge: popEdge(RENAME),
        to: WORLD_STACK,
        commands: NONE,
      },
      {
        name: 'pop an id that is not on the stack is a no-op',
        from: stackOf(WORLD, screen(BOX)),
        edge: popEdge(PVP),
        to: stackOf(WORLD, screen(BOX)),
        commands: NONE,
      },
      {
        name: 'pop from the bare world is a no-op',
        from: WORLD_STACK,
        edge: popEdge(BOX),
        to: WORLD_STACK,
        commands: NONE,
      },
      {
        name: 'pop never removes the base',
        from: stackOf(battle('7')),
        edge: popEdge(BOX),
        to: stackOf(battle('7')),
        commands: NONE,
      },
      {
        name: 'base edge world to battle keeps every upper frame',
        from: stackOf(WORLD, screen(BOX), prompt(PVP)),
        edge: baseEdge(battle('7')),
        to: stackOf(battle('7'), screen(BOX), prompt(PVP)),
        commands: CLEAR,
      },
      {
        name: 'base edge battle to world keeps every upper frame',
        from: stackOf(battle('7'), screen(BOX)),
        edge: baseEdge(WORLD),
        to: stackOf(WORLD, screen(BOX)),
        commands: CLEAR,
      },
      {
        name: 'base edge to another battle of the same kind keeps the frames and emits nothing',
        from: stackOf(battle('7'), screen(BOX)),
        edge: baseEdge(battle('8')),
        to: stackOf(battle('8'), screen(BOX)),
        commands: NONE,
      },
      {
        name: 'base edge world to world changes nothing',
        from: stackOf(WORLD, screen(BOX)),
        edge: baseEdge(WORLD),
        to: stackOf(WORLD, screen(BOX)),
        commands: NONE,
      },
    ];

    for (const row of rows) {
      const before = JSON.stringify(row.from);
      const result = contextStep(deepFrozen(row.from), row.edge);
      expect(result.stack, `${row.name}: stack`).toEqual(row.to);
      expect(result.commands, `${row.name}: commands`).toEqual(row.commands);
      expect(JSON.stringify(row.from), `${row.name}: the input stack is untouched`).toBe(before);
    }

    // The bare world constant is the one-frame world stack.
    expect(WORLD_STACK).toEqual([{ kind: 'world' }]);
  });

  it('CTL2-1-MIRROR: folding mirrorEdges makes the upper frames exactly the visible overlays, keeps the base, and is idempotent', () => {
    // WRONG IMPL KILLED: a mirror that leaves a stale frame for a hidden overlay, one that
    // pushes a frame twice for an already-mirrored id, one that re-orders surviving frames,
    // one that emits a base edge, one that mirrors battleView over a battle base (the base IS
    // its presentation) or drops it over a world base, one that pushes before it pops, and one
    // whose second pass is not empty.
    const nonBattleIds = OVERLAY_IDS.filter((id) => id !== 'battleView');
    const baseArb: fc.Arbitrary<BaseFrame> = fc.oneof(
      fc.constant<BaseFrame>(WORLD),
      fc
        .constantFrom('1', '42', '9007199254740993')
        .map((battleId): BaseFrame => ({ kind: 'battle', battleId })),
    );
    const frameArb = (id: OverlayId): fc.Arbitrary<UpperFrame> =>
      fc.constantFrom<UpperFrame>(screen(id), prompt(id), textEntry(id));
    // A random starting stack (unique ids, any frame kind, any order; no battleView over a
    // battle base, which is not a reachable shape) and a random visible list in random order.
    const scenarioArb = baseArb.chain((base) =>
      fc
        .shuffledSubarray([...(base.kind === 'battle' ? nonBattleIds : OVERLAY_IDS)])
        .chain((startIds) =>
          fc
            .tuple(fc.tuple(...startIds.map(frameArb)), fc.shuffledSubarray([...OVERLAY_IDS]))
            .map(([start, visible]) => ({ base, start, visible })),
        ),
    );

    fc.assert(
      fc.property(scenarioArb, ({ base, start, visible }) => {
        const from = stackOf(base, ...start);
        const effective =
          base.kind === 'battle' ? visible.filter((id) => id !== 'battleView') : visible;
        const startIds = start.map(frameId);
        const keptFrames = start.filter((f) => effective.includes(frameId(f)));
        const newIds = effective.filter((id) => !startIds.includes(id));
        const goneIds = startIds.filter((id) => !effective.includes(id));

        const edges = mirrorEdges(from, visible);
        expect(
          edges.map((e) => e.kind),
          'every edge is a pop or a push, pops first',
        ).toEqual([...goneIds.map(() => 'pop'), ...newIds.map(() => 'push')]);
        expect(
          edges.filter((e) => e.kind === 'pop'),
          'pops follow stack order',
        ).toEqual(goneIds.map(popEdge));
        expect(
          edges.filter((e) => e.kind === 'push'),
          'pushes are screen frames in visible order',
        ).toEqual(newIds.map((id) => pushEdge(screen(id))));

        const folded = fold(from, edges);
        expect(folded.stack[0], 'the base is untouched').toEqual(base);
        expect(
          folded.stack.slice(1, 1 + keptFrames.length),
          'surviving frames keep their kind and order',
        ).toEqual(keptFrames);
        expect(
          folded.stack.slice(1 + keptFrames.length),
          'new frames are screens appended in visible order',
        ).toEqual(newIds.map(screen));
        expect(
          (folded.stack.slice(1) as readonly UpperFrame[]).map(frameId),
          'upper-frame ids are exactly the effective visible set',
        ).toEqual([...keptFrames.map(frameId), ...newIds]);
        expect(folded.commands, 'one clearHeld per pushed frame').toEqual(
          newIds.map(() => ({ kind: 'clearHeld' })),
        );
        expect(mirrorEdges(folded.stack, visible), 'mirroring again is a no-op').toEqual([]);
      }),
      { numRuns: 400 },
    );

    // Table rows: the cases the property above treats generically, pinned by name.
    expect(
      mirrorEdges(WORLD_STACK, [PVP, BOX]),
      'two ids visible in one sync are pushed in visible order, not registry order',
    ).toEqual([pushEdge(screen(PVP)), pushEdge(screen(BOX))]);
    expect(
      mirrorEdges(stackOf(WORLD, screen(BOX), screen(PVP), screen(TRADE)), [PVP]),
      'hidden overlays are popped in stack order',
    ).toEqual([popEdge(BOX), popEdge(TRADE)]);
    expect(
      mirrorEdges(stackOf(WORLD, screen(BOX), screen(TRADE)), [PVP, TRADE]),
      'pops come before pushes',
    ).toEqual([popEdge(BOX), pushEdge(screen(PVP))]);
    expect(
      mirrorEdges(stackOf(WORLD, prompt(PVP), textEntry(RENAME)), [PVP, RENAME]),
      'a prompt or text-entry frame already holding a visible id is left alone',
    ).toEqual([]);
    expect(
      mirrorEdges(stackOf(battle('7')), ['battleView']),
      'battleView is the battle base itself: no frame over a battle base',
    ).toEqual([]);
    expect(
      mirrorEdges(stackOf(battle('7')), ['battleView', BOX]),
      'only the other overlays are mirrored over a battle base',
    ).toEqual([pushEdge(screen(BOX))]);
    expect(
      mirrorEdges(WORLD_STACK, ['battleView']),
      'over a world base a visible battleView (a terminal outcome frame) is a screen frame',
    ).toEqual([pushEdge(screen('battleView'))]);
    expect(
      mirrorEdges(stackOf(WORLD, screen('battleView')), []),
      'and it pops when the outcome frame is dismissed',
    ).toEqual([popEdge('battleView')]);
  });

  it('CTL2-1-BASE: baseFor is a battle base exactly while the battle is Ongoing, else the world', () => {
    // WRONG IMPL KILLED: a base that stays on a battle after its outcome, one that treats any
    // present battle row as Ongoing, a case-insensitive outcome match, and a base that drops the
    // battle id.
    expect(baseFor(undefined)).toEqual({ kind: 'world' });
    expect(baseFor({ battleId: '101', outcome: 'Ongoing' })).toEqual({
      kind: 'battle',
      battleId: '101',
    });
    expect(baseFor({ battleId: '9007199254740993', outcome: 'Ongoing' })).toEqual({
      kind: 'battle',
      battleId: '9007199254740993',
    });
    for (const outcome of [
      'SideAWins',
      'SideBWins',
      'Fled',
      'Recruited',
      'Forfeit',
      'ongoing',
      '',
    ]) {
      expect(baseFor({ battleId: '101', outcome }), `outcome ${JSON.stringify(outcome)}`).toEqual({
        kind: 'world',
      });
    }
  });

  it('CTL2-1-POLICY: SCREEN_POLICY is total over the overlay ids and dialogue is server-owned and suspended by a battle', () => {
    // WRONG IMPL KILLED: a policy table that omits an overlay or carries a stray key, and a
    // dialogue row that lets a battle drop a live server conversation.
    expect([...Object.keys(SCREEN_POLICY)].sort()).toEqual([...OVERLAY_IDS].sort());
    expect(SCREEN_POLICY.dialogueView).toEqual({
      owner: 'server',
      onBattle: 'suspend',
      battleSafe: false,
    });
    for (const id of OVERLAY_IDS) {
      const row = SCREEN_POLICY[id];
      expect(['player', 'server'], `${id}.owner`).toContain(row.owner);
      expect(['drop', 'suspend'], `${id}.onBattle`).toContain(row.onBattle);
      expect(typeof row.battleSafe, `${id}.battleSafe`).toBe('boolean');
    }
  });

  it('CTL2-3-GATE: movement is enabled only on a bare world stack with the session gate clear', () => {
    // WRONG IMPL KILLED: a gate that ignores the session gate, one that looks only at the
    // overlay count (a battle base with battleView hidden would walk: B17), one that looks
    // only at the base kind (a world base under a prompt or text entry would walk), and one
    // that treats a battle base as enabled.
    expect(movementEnabled(WORLD_STACK, false), 'bare world, session clear').toBe(true);
    expect(movementEnabled(WORLD_STACK, true), 'bare world, session gate set').toBe(false);
    expect(movementEnabled(stackOf(WORLD, screen(BOX)), false), 'world + screen').toBe(false);
    expect(movementEnabled(stackOf(WORLD, prompt(PVP)), false), 'world + prompt').toBe(false);
    expect(movementEnabled(stackOf(WORLD, textEntry(RENAME)), false), 'world + text entry').toBe(
      false,
    );
    expect(
      movementEnabled(stackOf(battle('7')), false),
      'B17: a battle base alone (battleView hidden) is not walkable',
    ).toBe(false);
    expect(movementEnabled(stackOf(battle('7')), true), 'battle base, session gate set').toBe(
      false,
    );
    expect(movementEnabled(stackOf(battle('7'), screen(BOX)), false), 'battle + screen').toBe(
      false,
    );

    // The truth table, exhaustively over the shapes this slice produces: exactly one cell is true.
    const bases: ReadonlyArray<readonly [string, BaseFrame]> = [
      ['world', WORLD],
      ['battle', battle('7')],
    ];
    const uppers: ReadonlyArray<readonly [string, readonly UpperFrame[]]> = [
      ['no frames', []],
      ['screen', [screen(BOX)]],
      ['prompt', [prompt(PVP)]],
      ['text entry', [textEntry(RENAME)]],
      ['two screens', [screen(BOX), screen(PVP)]],
      ['battleView outcome frame', [screen('battleView')]],
    ];
    const enabled: string[] = [];
    for (const [baseName, base] of bases) {
      for (const [upperName, upper] of uppers) {
        for (const sessionGate of [false, true]) {
          if (movementEnabled(stackOf(base, ...upper), sessionGate)) {
            enabled.push(`${baseName} / ${upperName} / session gate ${sessionGate}`);
          }
        }
      }
    }
    expect(enabled).toEqual(['world / no frames / session gate false']);
  });

  it('CTL2-4-CLEAR-CMD: a new push emits exactly one clearHeld; a duplicate push, a pop and a same-kind base edge emit none; a base kind change emits one', () => {
    // WRONG IMPL KILLED: no command on push (the B14 defect: a held key stays latched under the
    // new frame), a command per frame already on the stack, a command on a duplicate push or on
    // pop (closing would clear a hold the player started afterwards), no command when the base
    // flips world<->battle, and a command on every base edge (a no-op batch would wipe the hold).
    const rows: ReadonlyArray<{
      readonly name: string;
      readonly from: Stack;
      readonly edge: Edge;
      readonly commands: readonly Command[];
    }> = [
      { name: 'push new', from: WORLD_STACK, edge: pushEdge(screen(BOX)), commands: CLEAR },
      {
        name: 'push new onto a deep stack emits one, not one per frame',
        from: stackOf(WORLD, screen(BOX), prompt(PVP)),
        edge: pushEdge(screen(TRADE)),
        commands: CLEAR,
      },
      { name: 'push new prompt', from: WORLD_STACK, edge: pushEdge(prompt(PVP)), commands: CLEAR },
      {
        name: 'push new text entry',
        from: WORLD_STACK,
        edge: pushEdge(textEntry(RENAME)),
        commands: CLEAR,
      },
      {
        name: 'push duplicate',
        from: stackOf(WORLD, screen(BOX)),
        edge: pushEdge(screen(BOX)),
        commands: NONE,
      },
      {
        name: 'pop present',
        from: stackOf(WORLD, screen(BOX)),
        edge: popEdge(BOX),
        commands: NONE,
      },
      {
        name: 'pop absent',
        from: stackOf(WORLD, screen(BOX)),
        edge: popEdge(PVP),
        commands: NONE,
      },
      {
        name: 'base world to battle',
        from: WORLD_STACK,
        edge: baseEdge(battle('7')),
        commands: CLEAR,
      },
      {
        name: 'base battle to world',
        from: stackOf(battle('7')),
        edge: baseEdge(WORLD),
        commands: CLEAR,
      },
      {
        name: 'base world to battle with frames above',
        from: stackOf(WORLD, screen(BOX)),
        edge: baseEdge(battle('7')),
        commands: CLEAR,
      },
      { name: 'base world to world', from: WORLD_STACK, edge: baseEdge(WORLD), commands: NONE },
      {
        name: 'base battle to the same battle',
        from: stackOf(battle('7')),
        edge: baseEdge(battle('7')),
        commands: NONE,
      },
      {
        name: 'base battle to another battle',
        from: stackOf(battle('7')),
        edge: baseEdge(battle('8')),
        commands: NONE,
      },
    ];
    for (const row of rows) {
      expect(contextStep(row.from, row.edge).commands, row.name).toEqual(row.commands);
    }
  });
});

// ==========================================================================================
// ctl-3: reconcile server truth into the stack (CTL3.1 to CTL3.5)
// ==========================================================================================
//
// `reconcile(stack, view)` is the one pure rule that brings the upper frames in line with what the
// SERVER says: the base follows the ongoing battle row; a battle (or a terminal outcome frame over
// the world) drops every player frame; a server conversation takes every player frame too; a
// conversation that is gone takes a dialogue frame silently. It only POPS, it never pushes (pushes
// stay the mirror's), and every popped frame except a dialogue frame yields exactly one `close(id)`.
//
// MIGRATED SURVIVORS. ctl-3 deletes BATTLE_FORCE_HIDE / NEVER_FORCE_HIDE / hideAllExceptPlan from
// overlayRegistry.ts, and with them the cases that pinned them. What each retired case guarded
// survives here, FIRST in this block, as a literal-table reconcile case:
//   OR-FORCEHIDE-EXACT (the exact force-hide list, "not a superset, not a spot-check")
//       -> CTL3-2-DROP-EXACT: the hard-coded literal list of the 15 dropped ids, exact and ordered.
//          (Deliberate behaviour change: the old list was 9 ids; a battle now also drops quest log,
//          heal, shop, trade, pvp and claim. dialogueView stays out, as it always did.)
//   OR-HIDEALLEXCEPT-BATTLE-SUBSET (the plan is the VISIBLE intersection; nothing else plans a hide;
//       the battle never hides itself; no non-battle context force-hides anything)
//       -> CTL3-2-DROP-EXACT's partial-stack and world-base rows, and CTL3-2-OUTCOME-KEPT (a
//          battleView frame is never closed).
//   OR-NEVER-FORCE-HIDE (no verdict ever force-hides dialogueView, for any target x blocker set)
//       -> CTL3-3-NEVER-CLOSE-DIALOGUE: a generator that FORCES a dialogue frame, both conversation
//          values and both base kinds, and requires that no command ever closes it.
//   OR-HANDLES-DIALOGUE-HAS-NO-HIDE's invariant half (a hide of a live conversation strands the
//       server player_conversation row) -> CTL3-3-NEVER-CLOSE-DIALOGUE; its handle-table half stays
//       in overlayRegistry.test.ts.
//   OR-CANOPEN-BATTLE-TARGET-MATCHES-FORCEHIDE has no reconcile survivor: canOpen('battleView', ...)
//       is now a plain deny, pinned by OR-CANOPEN-BATTLE-TARGET-DENIES in overlayRegistry.test.ts.
//
// The expectations below are HARD-CODED literals, never derived from SCREEN_POLICY: a table that is
// read from the very policy it guards shrinks with it and stays green.

type CloseId = Exclude<OverlayId, 'dialogueView'>;
const closeCmd = (id: CloseId): Command => ({ kind: 'close', id });
const serverView = (
  ongoingBattleId: string | undefined,
  conversation: boolean,
  outcomeShown = false,
): ServerView => ({
  ongoingBattleId,
  outcomeShown,
  conversation,
});
const closeIds = (commands: readonly Command[]): readonly string[] =>
  commands.flatMap((c) => (c.kind === 'close' ? [c.id] : []));
const clearHeldCount = (commands: readonly Command[]): number =>
  commands.filter((c) => c.kind === 'clearHeld').length;
const upperIdsOf = (s: Stack): readonly OverlayId[] =>
  (s.slice(1) as readonly UpperFrame[]).map(frameId);
const sortedIds = (xs: readonly string[]): string[] => [...xs].sort();

/** The 15 ids a battle (or an outcome frame) drops and a conversation takes: every overlay but the
 *  two server-owned ones. HARD-CODED. */
const PLAYER_IDS: readonly CloseId[] = [
  'boxView',
  'raisingView',
  'evolutionView',
  'questLogView',
  'healView',
  'shopView',
  'tradeView',
  'pvpView',
  'leaderboardView',
  'renameView',
  'tradeProposeView',
  'helpView',
  'menuView',
  'claimView',
  'privacyView',
];
/** One frame per player id, in PLAYER_IDS order, in all three frame kinds (pvp is a prompt, rename a
 *  text entry) so a pop-by-id is exercised for each kind. */
const PLAYER_FRAMES: readonly UpperFrame[] = [
  screen('boxView'),
  screen('raisingView'),
  screen('evolutionView'),
  screen('questLogView'),
  screen('healView'),
  screen('shopView'),
  screen('tradeView'),
  prompt('pvpView'),
  screen('leaderboardView'),
  textEntry('renameView'),
  screen('tradeProposeView'),
  screen('helpView'),
  screen('menuView'),
  screen('claimView'),
  screen('privacyView'),
];

const startBases: readonly BaseFrame[] = [WORLD, battle('1'), battle('2')];
const frameKindsOf = (id: OverlayId): fc.Arbitrary<UpperFrame> =>
  fc.constantFrom<UpperFrame>(screen(id), prompt(id), textEntry(id));
const serverViewArb: fc.Arbitrary<ServerView> = fc.record({
  ongoingBattleId: fc.constantFrom<string | undefined>(undefined, '1', '42'),
  outcomeShown: fc.boolean(),
  conversation: fc.boolean(),
});

/** A random start stack (unique ids, any frame kind, any order, any base, a battleView frame allowed
 *  anywhere) and a random server view. With `forceDialogue` a dialogueView frame is ALWAYS present,
 *  at a random position, in a random frame kind. */
function scenarioArb(
  forceDialogue: boolean,
): fc.Arbitrary<{ readonly from: Stack; readonly view: ServerView }> {
  const idsArb: fc.Arbitrary<OverlayId[]> = forceDialogue
    ? fc
        .tuple(fc.shuffledSubarray(OVERLAY_IDS.filter((id) => id !== 'dialogueView')), fc.nat())
        .map(([ids, at]) => {
          const out: OverlayId[] = [...ids];
          out.splice(at % (out.length + 1), 0, 'dialogueView');
          return out;
        })
    : fc.shuffledSubarray([...OVERLAY_IDS]);
  return fc
    .tuple(fc.constantFrom(...startBases), idsArb, serverViewArb)
    .chain(([base, ids, view]) =>
      fc
        .tuple(...ids.map(frameKindsOf))
        .map((frames) => ({ from: stackOf(base, ...frames), view })),
    );
}

describe('context stack: reconcile server truth (ctl-3)', () => {
  it('CTL3-2-DROP-EXACT: a battle drops EXACTLY the 15 player ids, in stack order, and nothing else; a world with no battle and no outcome frame drops nothing', () => {
    // WRONG IMPL KILLED: the old 9-id list (shop, trade, pvp, quest log, heal and claim left
    // painted under the battle); a drop list derived from the policy table; a drop that also takes
    // dialogueView or battleView; a drop keyed to the id table's order instead of the stack's; one
    // that skips prompt or text-entry frames; one that drops over a bare world; and a close
    // emitted for an id that was never on the stack.
    // ANTI-VACUITY: the literal is the whole manifest minus the two server-owned ids.
    expect(PLAYER_IDS).toHaveLength(15);
    expect(PLAYER_FRAMES.map(frameId)).toEqual([...PLAYER_IDS]);
    expect(sortedIds([...PLAYER_IDS, 'battleView', 'dialogueView'])).toEqual(
      sortedIds(OVERLAY_IDS),
    );

    // A new battle over every player frame: all 15 popped, 15 closes in stack order, one clearHeld.
    const a = reconcile(deepFrozen(stackOf(WORLD, ...PLAYER_FRAMES)), serverView('7', false));
    expect(a.stack, 'A: only the battle base is left').toEqual(stackOf(battle('7')));
    expect(closeIds(a.commands), 'A: one close per player id, in stack order').toEqual([
      ...PLAYER_IDS,
    ]);
    expect(clearHeldCount(a.commands), 'A: the base kind change clears held once').toBe(1);
    expect(a.commands, 'A: nothing but those 16 commands').toHaveLength(16);

    // The same frames over an ALREADY-ongoing battle: same drops, no base change, no clearHeld.
    const b = reconcile(deepFrozen(stackOf(battle('7'), ...PLAYER_FRAMES)), serverView('7', false));
    expect(b.stack, 'B: only the battle base is left').toEqual(stackOf(battle('7')));
    expect(closeIds(b.commands)).toEqual([...PLAYER_IDS]);
    expect(b.commands, 'B: no clearHeld without a base kind change').toHaveLength(15);

    // Stack order, not table order: the reversed stack closes in the reversed order.
    const reversedFrames = [...PLAYER_FRAMES].reverse();
    const c = reconcile(
      deepFrozen(stackOf(battle('7'), ...reversedFrames)),
      serverView('7', false),
    );
    expect(c.stack).toEqual(stackOf(battle('7')));
    expect(closeIds(c.commands), 'C: closes follow the STACK order').toEqual([
      ...[...PLAYER_IDS].reverse(),
    ]);

    // A partial stack: close is emitted only for frames that are on the stack.
    const d = reconcile(
      deepFrozen(stackOf(WORLD, screen('boxView'), screen('helpView'))),
      serverView('7', false),
    );
    expect(d.stack).toEqual(stackOf(battle('7')));
    expect(closeIds(d.commands), 'D: no close for an id that is not on the stack').toEqual([
      'boxView',
      'helpView',
    ]);
    const d2 = reconcile(deepFrozen(stackOf(battle('7'))), serverView('7', false));
    expect(d2.stack, 'D2: a bare battle base stays a bare battle base').toEqual(
      stackOf(battle('7')),
    );
    expect(d2.commands, 'D2: and asks for nothing').toEqual([]);

    // A world with no battle and no outcome frame: every player frame stays, nothing is emitted.
    const e = reconcile(deepFrozen(stackOf(WORLD, ...PLAYER_FRAMES)), serverView(undefined, false));
    expect(e.stack, 'E: nothing is popped over a bare world').toEqual(
      stackOf(WORLD, ...PLAYER_FRAMES),
    );
    expect(e.commands, 'E: and nothing is emitted').toEqual([]);

    // The battle never takes a server-owned frame: the outcome frame stays (and is never closed).
    const f = reconcile(
      deepFrozen(stackOf(WORLD, screen('boxView'), screen('battleView'))),
      serverView('7', false),
    );
    expect(upperIdsOf(f.stack), 'F: the battleView frame is not dropped by a battle').toEqual([
      'battleView',
    ]);
    expect(closeIds(f.commands), 'F: only the player frame is closed').toEqual(['boxView']);
  });

  it('CTL3-2-POLICY-EXACT: SCREEN_POLICY owner and onBattle rows are exactly the literal table (battleSafe is not pinned here)', () => {
    // WRONG IMPL KILLED: a table that marks a player overlay server-owned (reconcile would then
    // never close it), one that marks dialogue as droppable on battle (a live server conversation
    // would be torn off the stack), one that marks a player overlay `suspend`, and a row that goes
    // missing. battleSafe is ctl-6c's and deliberately not asserted.
    const expected: ReadonlyArray<
      readonly [OverlayId, 'player' | 'server', 'drop' | 'suspend' | undefined]
    > = [
      ['battleView', 'server', undefined],
      ['dialogueView', 'server', 'suspend'],
      ['boxView', 'player', 'drop'],
      ['raisingView', 'player', 'drop'],
      ['evolutionView', 'player', 'drop'],
      ['questLogView', 'player', 'drop'],
      ['healView', 'player', 'drop'],
      ['shopView', 'player', 'drop'],
      ['tradeView', 'player', 'drop'],
      ['pvpView', 'player', 'drop'],
      ['leaderboardView', 'player', 'drop'],
      ['renameView', 'player', 'drop'],
      ['tradeProposeView', 'player', 'drop'],
      ['helpView', 'player', 'drop'],
      ['menuView', 'player', 'drop'],
      ['claimView', 'player', 'drop'],
      ['privacyView', 'player', 'drop'],
    ];
    expect(expected, 'ANTI-VACUITY: the literal covers all 17 overlay ids').toHaveLength(17);
    expect(sortedIds(expected.map(([id]) => id))).toEqual(sortedIds(OVERLAY_IDS));
    for (const [id, owner, onBattle] of expected) {
      expect(SCREEN_POLICY[id].owner, `${id}.owner`).toBe(owner);
      if (onBattle !== undefined) {
        expect(SCREEN_POLICY[id].onBattle, `${id}.onBattle`).toBe(onBattle);
      }
    }
    expect(
      expected.filter(([, owner]) => owner === 'server').map(([id]) => id),
      'exactly two server-owned overlays',
    ).toEqual(['battleView', 'dialogueView']);
  });

  it('CTL3-3-NEVER-CLOSE-DIALOGUE: over generated stacks that always hold a dialogue frame, with both conversation values and both base kinds, no command ever closes dialogueView', () => {
    // WRONG IMPL KILLED: a close emitted for a popped dialogue frame (the legacy handle table has
    // no dialogue hide: a bare hide strands the server player_conversation row); a pop of the
    // dialogue frame while the conversation is still present; one that keeps it after the
    // conversation is gone; and a reconcile that emits some OTHER command kind (a dismiss).
    // The generator FORCES the dialogue frame, so the property cannot pass by never seeing one.
    const quadrants = new Map<string, number>();
    let withCloses = 0;
    fc.assert(
      fc.property(scenarioArb(true), ({ from, view }) => {
        expect(
          upperIdsOf(from),
          'precondition: the generated stack holds a dialogue frame',
        ).toContain('dialogueView');
        const result = reconcile(deepFrozen(from), view);
        expect(closeIds(result.commands)).not.toContain('dialogueView');
        for (const command of result.commands) {
          expect(['clearHeld', 'close'], 'no other command kind').toContain(command.kind);
        }
        expect(
          upperIdsOf(result.stack).includes('dialogueView'),
          'the dialogue frame follows the conversation: kept while present, popped when gone',
        ).toBe(view.conversation);
        const key = `conversation=${view.conversation}/battle=${view.ongoingBattleId !== undefined}`;
        quadrants.set(key, (quadrants.get(key) ?? 0) + 1);
        if (closeIds(result.commands).length > 0) withCloses += 1;
      }),
      { numRuns: 400 },
    );
    // ANTI-VACUITY: every conversation x base quadrant was generated, and closes were emitted
    // around the dialogue frame often enough that "never closes it" is a real claim.
    for (const key of [
      'conversation=true/battle=true',
      'conversation=true/battle=false',
      'conversation=false/battle=true',
      'conversation=false/battle=false',
    ]) {
      expect(quadrants.get(key) ?? 0, `quadrant ${key} was generated`).toBeGreaterThan(30);
    }
    expect(withCloses, 'ANTI-VACUITY: many generated runs emitted closes').toBeGreaterThan(100);
  });

  it('CTL3-1-IDEMPOTENT: reconciling an already-reconciled stack against the same view changes nothing and emits nothing', () => {
    // WRONG IMPL KILLED: a reconcile that re-emits clearHeld or close on every call (a per-batch
    // wipe of the player's hold, a second hide of a closed overlay), one whose pop rule depends
    // on a frame it has itself just removed, one that pushes (a second pass would then differ),
    // and one that reorders the surviving frames or drops a frame it should keep.
    let changed = 0;
    let emitted = 0;
    fc.assert(
      fc.property(scenarioArb(false), ({ from, view }) => {
        const first = reconcile(deepFrozen(from), view);
        const second = reconcile(first.stack, view);
        expect(second.stack, 'the second pass keeps the stack').toEqual(first.stack);
        expect(second.commands, 'the second pass emits nothing').toEqual([]);

        expect(first.stack[0], 'the base follows the ongoing battle row').toEqual(
          view.ongoingBattleId === undefined ? WORLD : battle(view.ongoingBattleId),
        );
        const startUpper = from.slice(1) as readonly UpperFrame[];
        const keptIds = upperIdsOf(first.stack);
        expect(
          first.stack.slice(1),
          'reconcile only pops: the survivors are the start frames, in the start order',
        ).toEqual(startUpper.filter((f) => keptIds.includes(frameId(f))));

        if (JSON.stringify(first.stack) !== JSON.stringify(from)) changed += 1;
        if (first.commands.length > 0) emitted += 1;
      }),
      { numRuns: 400 },
    );
    // ANTI-VACUITY: the property was exercised on stacks the first pass really changed, and on
    // ones that really asked for commands.
    expect(
      changed,
      'ANTI-VACUITY: many generated stacks were changed by the first pass',
    ).toBeGreaterThan(100);
    expect(emitted, 'ANTI-VACUITY: many generated runs emitted commands').toBeGreaterThan(100);
  });

  it('CTL3-1-BASE: the base follows the ongoing battle row, a base kind change asks for clearHeld once, and what is popped depends on the NEW base', () => {
    // WRONG IMPL KILLED: a base that ignores the ongoing id, one that clears held on a same-kind
    // battle id change (a hold wiped for nothing) or never on a kind change, one that drops the
    // frames on a battle-to-world change (nothing is dropped over a bare world), and one that
    // judges the drop by the OLD base.
    const rows: ReadonlyArray<{
      readonly name: string;
      readonly from: Stack;
      readonly view: ServerView;
      readonly to: Stack;
      readonly commands: readonly Command[];
    }> = [
      {
        name: 'world stays the world',
        from: WORLD_STACK,
        view: serverView(undefined, false),
        to: WORLD_STACK,
        commands: NONE,
      },
      {
        name: 'world to battle',
        from: WORLD_STACK,
        view: serverView('5', false),
        to: stackOf(battle('5')),
        commands: CLEAR,
      },
      {
        name: 'the same battle is a no-op',
        from: stackOf(battle('5')),
        view: serverView('5', false),
        to: stackOf(battle('5')),
        commands: NONE,
      },
      {
        name: 'another battle id is the same kind: no clearHeld',
        from: stackOf(battle('5')),
        view: serverView('6', false),
        to: stackOf(battle('6')),
        commands: NONE,
      },
      {
        name: 'battle to world',
        from: stackOf(battle('5')),
        view: serverView(undefined, false),
        to: WORLD_STACK,
        commands: CLEAR,
      },
      {
        name: 'battle to world keeps a player frame: nothing is dropped over a bare world',
        from: stackOf(battle('5'), screen(BOX)),
        view: serverView(undefined, false),
        to: stackOf(WORLD, screen(BOX)),
        commands: CLEAR,
      },
    ];
    for (const row of rows) {
      const result = reconcile(deepFrozen(row.from), row.view);
      expect(result.stack, `${row.name}: stack`).toEqual(row.to);
      expect(result.commands, `${row.name}: commands`).toEqual(row.commands);
    }
  });

  it('CTL3-2-OUTCOME-KEPT: over the world, a terminal outcome frame drops the player frames but is itself kept and never closed; under a new battle base it is not closed either', () => {
    // WRONG IMPL KILLED: a reconcile that pops the outcome frame (the player's Continue/Escape
    // owns that, through the mirror), one that closes it (the view is the base's own
    // presentation, and a bare close would skip the dismissedBattleId latch), one that leaves the
    // player frames standing under an outcome (two aria-modal roots, two focus traps), and one
    // that drops player frames over the world with NO outcome frame.
    const kept = reconcile(
      deepFrozen(stackOf(WORLD, screen('boxView'), screen('battleView'), screen('questLogView'))),
      serverView(undefined, false),
    );
    expect(kept.stack, 'the outcome frame is the only frame left').toEqual(
      stackOf(WORLD, screen('battleView')),
    );
    expect(
      kept.commands,
      'one close per player frame, none for the outcome frame, no clearHeld',
    ).toEqual([closeCmd('boxView'), closeCmd('questLogView')]);

    // Control: the very same player frames with NO outcome frame (and no battle) stay.
    const control = reconcile(
      deepFrozen(stackOf(WORLD, screen('boxView'), screen('questLogView'))),
      serverView(undefined, false),
    );
    expect(control.stack, 'control: no outcome frame, no battle: nothing is popped').toEqual(
      stackOf(WORLD, screen('boxView'), screen('questLogView')),
    );
    expect(control.commands).toEqual([]);

    // A NEW battle arrives while the outcome frame is still up: the frame is neither popped nor closed.
    const under = reconcile(
      deepFrozen(stackOf(WORLD, screen('battleView'), screen('boxView'))),
      serverView('9', false),
    );
    expect(under.stack, 'the battle base is set and the outcome frame survives').toEqual(
      stackOf(battle('9'), screen('battleView')),
    );
    expect(closeIds(under.commands), 'only the player frame is closed').toEqual(['boxView']);
    expect(clearHeldCount(under.commands), 'the base kind change clears held once').toBe(1);

    // The outcome frame survives a conversation as well (it is server-owned).
    const withConversation = reconcile(
      deepFrozen(stackOf(WORLD, screen('battleView'), screen('boxView'))),
      serverView(undefined, true),
    );
    expect(withConversation.stack).toEqual(stackOf(WORLD, screen('battleView')));
    expect(withConversation.commands).toEqual([closeCmd('boxView')]);
  });

  it('CTL3-3-CLOSE-PER-POP: every popped frame except a dialogue frame yields exactly one close, in stack order; a frame that is not popped yields none', () => {
    // WRONG IMPL KILLED: a frame popped by BOTH the battle rule and the conversation rule closed
    // twice (the overlay's hide() would run twice); a close for a frame that stays; none for a
    // popped prompt or text-entry frame (keyed by the wrong id); closes in id-table order; and a
    // close whose payload carries anything but the kind and the overlay id.
    const both = reconcile(
      deepFrozen(stackOf(battle('7'), screen('boxView'), screen('helpView'), screen('shopView'))),
      serverView('7', true),
    );
    expect(both.stack).toEqual(stackOf(battle('7')));
    expect(
      both.commands,
      'popped by both rules, closed once each, in stack order, no other command',
    ).toEqual([closeCmd('boxView'), closeCmd('helpView'), closeCmd('shopView')]);

    const kinds = reconcile(
      deepFrozen(stackOf(WORLD, prompt('pvpView'), textEntry('renameView'))),
      serverView('3', false),
    );
    expect(kinds.stack).toEqual(stackOf(battle('3')));
    expect(closeIds(kinds.commands), 'a prompt and a text-entry frame close by their id').toEqual([
      'pvpView',
      'renameView',
    ]);
    expect(
      kinds.commands.filter((c) => c.kind === 'close'),
      'the close payload is exactly { kind, id }',
    ).toEqual([closeCmd('pvpView'), closeCmd('renameView')]);

    const none = reconcile(
      deepFrozen(stackOf(WORLD, screen('boxView'))),
      serverView(undefined, false),
    );
    expect(none.stack, 'a frame that is not popped stays').toEqual(
      stackOf(WORLD, screen('boxView')),
    );
    expect(none.commands, 'and yields no close').toEqual([]);

    // The generated oracle: closes are exactly the popped frames, minus a dialogue frame, in the
    // START stack's order, each once. Read off the RESULT, so it holds whatever the rules pop.
    let withCloses = 0;
    let withoutPops = 0;
    let manyCloses = 0;
    fc.assert(
      fc.property(scenarioArb(false), ({ from, view }) => {
        const result = reconcile(deepFrozen(from), view);
        const resultIds = upperIdsOf(result.stack);
        const expectedCloses = upperIdsOf(from).filter(
          (id) => !resultIds.includes(id) && id !== 'dialogueView',
        );
        expect(closeIds(result.commands)).toEqual(expectedCloses);
        if (expectedCloses.length > 0) withCloses += 1;
        if (expectedCloses.length >= 3) manyCloses += 1;
        if (resultIds.length === upperIdsOf(from).length) withoutPops += 1;
      }),
      { numRuns: 600 },
    );
    expect(withCloses, 'ANTI-VACUITY: many runs popped and closed frames').toBeGreaterThan(100);
    expect(manyCloses, 'ANTI-VACUITY: many runs popped three or more frames').toBeGreaterThan(30);
    // Roughly 2% of runs (no battle, no outcome flag, no conversation, no dialogue frame, no
    // outcome frame): the floor is the lowest non-vacuous one (never zero) on purpose, so a lucky
    // seed cannot flake it, yet it still fails a generator that never produces a no-pop run.
    expect(withoutPops, 'ANTI-VACUITY: some runs popped nothing').toBeGreaterThan(0);
  });

  it('CTL3-2-OUTCOME-BIT: outcomeShown over the world drops every player frame like a battle does, but never pushes or pops a frame by itself', () => {
    // WRONG IMPL KILLED: a reconcile that ignores outcomeShown (the terminal outcome is about to
    // be shown by a later listener in the same batch, so the overlays under it would still be
    // standing when the outcome takes focus: the reviewer's same-batch finding); one that acts on
    // the flag when it is false; one that drops the outcome frame itself, or any server-owned
    // frame; one that PUSHES a battleView frame for the flag (the mirror pushes, and a null view
    // model would strand the frame); one that pops a dialogue frame while the conversation is
    // still there; and one that emits a clearHeld for a flag (the base did not change).
    const flagged = reconcile(
      deepFrozen(stackOf(WORLD, screen('menuView'), screen('helpView'))),
      serverView(undefined, false, true),
    );
    expect(
      flagged.stack,
      'outcomeShown, no outcome frame yet: both player frames are dropped',
    ).toEqual(WORLD_STACK);
    expect(flagged.commands, 'one close each, in stack order, nothing else').toEqual([
      closeCmd('menuView'),
      closeCmd('helpView'),
    ]);

    const unflagged = reconcile(
      deepFrozen(stackOf(WORLD, screen('menuView'), screen('helpView'))),
      serverView(undefined, false, false),
    );
    expect(unflagged.stack, 'no flag, no battle, no outcome frame: nothing is dropped').toEqual(
      stackOf(WORLD, screen('menuView'), screen('helpView')),
    );
    expect(unflagged.commands).toEqual([]);

    // Every player id, in every frame kind: the flag drops all 15 exactly as a battle does.
    const all = reconcile(
      deepFrozen(stackOf(WORLD, ...PLAYER_FRAMES)),
      serverView(undefined, false, true),
    );
    expect(all.stack).toEqual(WORLD_STACK);
    expect(all.commands, 'exactly the 15 closes in stack order').toEqual(PLAYER_IDS.map(closeCmd));

    // It never pushes: a bare world stays bare.
    const bare = reconcile(deepFrozen(WORLD_STACK), serverView(undefined, false, true));
    expect(bare.stack, 'the flag pushes no battleView frame').toEqual(WORLD_STACK);
    expect(bare.commands).toEqual([]);

    // It never pops the outcome frame, and a live conversation keeps its dialogue frame.
    const kept = reconcile(
      deepFrozen(stackOf(WORLD, screen('boxView'), screen('battleView'), screen('dialogueView'))),
      serverView(undefined, true, true),
    );
    expect(kept.stack, 'the outcome and dialogue frames survive').toEqual(
      stackOf(WORLD, screen('battleView'), screen('dialogueView')),
    );
    expect(kept.commands, 'only the player frame is closed').toEqual([closeCmd('boxView')]);

    // Over a battle base the flag changes nothing: the base already drops.
    const underBattle = reconcile(
      deepFrozen(stackOf(battle('7'), screen('menuView'))),
      serverView('7', false, true),
    );
    expect(underBattle.stack).toEqual(stackOf(battle('7')));
    expect(underBattle.commands).toEqual([closeCmd('menuView')]);

    // The flag is idempotent too: a second pass over its own result emits nothing.
    const again = reconcile(flagged.stack, serverView(undefined, false, true));
    expect(again.stack).toEqual(flagged.stack);
    expect(again.commands).toEqual([]);
  });

  it('CTL3-4-CONV-APPEARS: a server conversation pops and closes all 15 player frames, keeps the dialogue frame, and reconcile never pushes one', () => {
    // WRONG IMPL KILLED: a conversation that leaves some player overlay painted behind the
    // dialogue (a second modal root; only the menu was preempted before), one that pops the
    // dialogue frame it is there to serve, one that pushes a dialogue frame itself (the mirror
    // owns pushes), and one that emits a clearHeld without a base change or a push.
    const withDialogue = reconcile(
      deepFrozen(stackOf(WORLD, ...PLAYER_FRAMES, screen('dialogueView'))),
      serverView(undefined, true),
    );
    expect(withDialogue.stack).toEqual(stackOf(WORLD, screen('dialogueView')));
    expect(withDialogue.commands, 'exactly the 15 closes in stack order, nothing else').toEqual(
      PLAYER_IDS.map(closeCmd),
    );

    const noDialogueFrame = reconcile(
      deepFrozen(stackOf(WORLD, ...PLAYER_FRAMES)),
      serverView(undefined, true),
    );
    expect(noDialogueFrame.stack, 'reconcile never pushes the dialogue frame').toEqual(
      stackOf(WORLD),
    );
    expect(noDialogueFrame.commands).toEqual(PLAYER_IDS.map(closeCmd));

    // The dialogue frame sitting BELOW some player frames stays put and stays in place.
    const interleaved = reconcile(
      deepFrozen(stackOf(WORLD, screen('boxView'), screen('dialogueView'), screen('helpView'))),
      serverView(undefined, true),
    );
    expect(interleaved.stack).toEqual(stackOf(WORLD, screen('dialogueView')));
    expect(interleaved.commands).toEqual([closeCmd('boxView'), closeCmd('helpView')]);

    // Over a battle base the conversation is suspended, not dropped: the dialogue frame stays.
    const underBattle = reconcile(
      deepFrozen(stackOf(battle('7'), ...PLAYER_FRAMES, screen('dialogueView'))),
      serverView('7', true),
    );
    expect(underBattle.stack).toEqual(stackOf(battle('7'), screen('dialogueView')));
    expect(underBattle.commands).toEqual(PLAYER_IDS.map(closeCmd));
  });

  it('CTL3-4-CONV-GOES: with no conversation, a dialogue frame is popped with no command at all, and the player frames over the world are left alone', () => {
    // WRONG IMPL KILLED: a close or a dismiss emitted for the dialogue frame (the server already
    // ended the conversation: a client-side dismiss would be a stray reducer call), a dialogue
    // frame left on the stack after the row is gone (movement stays dead), and a pop of the
    // player frames that sit next to it.
    const alone = reconcile(
      deepFrozen(stackOf(WORLD, screen('dialogueView'))),
      serverView(undefined, false),
    );
    expect(alone.stack).toEqual(WORLD_STACK);
    expect(alone.commands, 'zero commands').toEqual([]);

    const beside = reconcile(
      deepFrozen(stackOf(WORLD, screen('dialogueView'), screen('boxView'))),
      serverView(undefined, false),
    );
    expect(beside.stack, 'the player frame is not touched').toEqual(
      stackOf(WORLD, screen('boxView')),
    );
    expect(beside.commands, 'zero commands').toEqual([]);

    const asPrompt = reconcile(
      deepFrozen(stackOf(WORLD, prompt('dialogueView'))),
      serverView(undefined, false),
    );
    expect(asPrompt.stack, 'a dialogue frame of any kind is popped by its id').toEqual(WORLD_STACK);
    expect(asPrompt.commands).toEqual([]);
  });

  it('CTL3-4-SUSPENDED-ENDS-SILENT: a conversation that ends while suspended under a battle pops the dialogue frame with ZERO commands and leaves the battle base unchanged', () => {
    // The named W2 row. WRONG IMPL KILLED: a close or dismiss for the suspended dialogue (it was
    // never visible, and the server already ended it), a clearHeld (the base did not change), a
    // base edge that replaces or re-derives the battle base (the battle is still ongoing), and a
    // dialogue frame that outlives its conversation under the battle.
    const result = reconcile(
      deepFrozen(stackOf(battle('7'), screen('dialogueView'))),
      serverView('7', false),
    );
    expect(result.stack, 'the bare battle base').toEqual(stackOf(battle('7')));
    expect(result.stack[0], 'the battle base is unchanged').toEqual({
      kind: 'battle',
      battleId: '7',
    });
    expect(result.commands, 'ZERO commands').toEqual([]);

    // With a player frame above it, only that frame is closed: still nothing for the dialogue.
    const withPlayer = reconcile(
      deepFrozen(stackOf(battle('7'), screen('dialogueView'), screen('boxView'))),
      serverView('7', false),
    );
    expect(withPlayer.stack).toEqual(stackOf(battle('7')));
    expect(withPlayer.commands, 'only the player frame is closed').toEqual([closeCmd('boxView')]);
  });

  it('CTL3-5-OPEN-GATE: blocksPlayerOpen is true for a battle base or any upper frame other than a dialogue frame, and false for a bare world or world + dialogue', () => {
    // WRONG IMPL KILLED: a gate that also blocks on the dialogue frame (the deferred shop open
    // could then never run: it fires exactly when the conversation ends, with a dialogue frame
    // still on the stack), one that ignores the base (a battle with no frames would let a shop
    // pop), one that ignores the outcome frame, one that checks only the top frame, and one that
    // ignores prompt and text-entry frames.
    interface Row {
      readonly name: string;
      readonly stack: Stack;
      readonly blocks: boolean;
    }
    const rows: Row[] = [
      { name: 'bare world', stack: WORLD_STACK, blocks: false },
      { name: 'world + dialogue', stack: stackOf(WORLD, screen('dialogueView')), blocks: false },
      { name: 'bare battle base', stack: stackOf(battle('7')), blocks: true },
      {
        name: 'battle base + dialogue (the base alone blocks)',
        stack: stackOf(battle('7'), screen('dialogueView')),
        blocks: true,
      },
      {
        name: 'world + battleView outcome frame',
        stack: stackOf(WORLD, screen('battleView')),
        blocks: true,
      },
      {
        name: 'dialogue below a player frame',
        stack: stackOf(WORLD, screen('dialogueView'), screen('boxView')),
        blocks: true,
      },
      {
        name: 'dialogue above a player frame',
        stack: stackOf(WORLD, screen('boxView'), screen('dialogueView')),
        blocks: true,
      },
      { name: 'world + prompt', stack: stackOf(WORLD, prompt('pvpView')), blocks: true },
      { name: 'world + text entry', stack: stackOf(WORLD, textEntry('renameView')), blocks: true },
    ];
    for (const id of PLAYER_IDS) {
      rows.push({ name: `world + ${id}`, stack: stackOf(WORLD, screen(id)), blocks: true });
    }
    expect(rows, 'ANTI-VACUITY: 9 named rows + 15 player ids').toHaveLength(24);
    for (const row of rows) {
      expect(blocksPlayerOpen(deepFrozen(row.stack)), row.name).toBe(row.blocks);
    }
    expect(
      rows.filter((r) => !r.blocks),
      'ANTI-VACUITY: both polarities are exercised',
    ).toHaveLength(2);
  });
});
