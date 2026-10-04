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
import type { VButton } from '../input/buttons';
import {
  acceleratorsDenied,
  type BaseFrame,
  baseFor,
  battleButton,
  battleRefused,
  battleSafeCommand,
  blocksPlayerOpen,
  COMMAND_BATTLE_POLICY,
  type Command,
  contextStep,
  continuedBattleId,
  type Edge,
  type FrameId,
  isBareBattle,
  mirrorEdges,
  movementEnabled,
  OUTCOME_CONTINUE_GRACE_MS,
  popToBase,
  popTop,
  reconcile,
  SCREEN_POLICY,
  type ServerView,
  SOCIAL_FRAME,
  SOCIAL_PANELS,
  type Stack,
  socialPanel,
  stackDiff,
  type UpperFrame,
  WORLD_STACK,
} from './contextStack';
import { OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import type { Command as ScreenCommand, SocialPanelId, SocialTab } from './screens/types';

// --- builders -----------------------------------------------------------------------------
// ctl-8s (named intentional change): the builders and `frameId` take and return a FrameId, the
// overlay ids plus the Social frame. Were: OverlayId.
const WORLD: BaseFrame = { kind: 'world' };
const battle = (battleId: string): BaseFrame => ({ kind: 'battle', battleId });
const screen = (id: FrameId): UpperFrame => ({ kind: 'screen', id });
/** A screen frame opened over battle `battleId` (ctl-6c): the optional `overBattle` stamp. */
const stamped = (id: FrameId, battleId: string): UpperFrame =>
  ({ kind: 'screen', id, overBattle: battleId }) as UpperFrame;
const prompt = (id: FrameId): UpperFrame => ({ kind: 'prompt', id });
const textEntry = (owner: FrameId): UpperFrame => ({ kind: 'textEntry', owner });
const stackOf = (base: BaseFrame, ...upper: UpperFrame[]): Stack => [base, ...upper];

const pushEdge = (frame: UpperFrame): Edge => ({ kind: 'push', frame });
const popEdge = (id: FrameId): Edge => ({ kind: 'pop', id });
const baseEdge = (base: BaseFrame): Edge => ({ kind: 'base', base });

const CLEAR: readonly Command[] = [{ kind: 'clearHeld' }];
const NONE: readonly Command[] = [];

/** The frame id a frame stands for: a text-entry frame is keyed by its owner. */
const frameId = (f: UpperFrame): FrameId => (f.kind === 'textEntry' ? f.owner : f.id);

/** Every frame id (ctl-8s): the overlay ids and the Social frame, spelled here and never read from
 *  the module under test. */
const FRAME_IDS: readonly FrameId[] = [...OVERLAY_IDS, 'social'];
/** The three overlays the Social frame hosts as its panels. HARD-CODED. */
const PANEL_IDS: readonly OverlayId[] = ['tradeView', 'pvpView', 'leaderboardView'];
const isPanel = (id: FrameId): boolean => (PANEL_IDS as readonly FrameId[]).includes(id);
/** The test's own oracle of the ctl-8s fold: the frame ids a visible list mirrors as, in visible
 *  order, with the three panels folded into ONE `social` at the first visible panel's position. */
function foldPanels(visible: readonly OverlayId[]): FrameId[] {
  const out: FrameId[] = [];
  for (const id of visible) {
    if (!isPanel(id)) out.push(id);
    else if (!out.includes('social')) out.push('social');
  }
  return out;
}

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
    //
    // ctl-8s INTENTIONAL CHANGE (CTL8S.3, from the spec): a visible trade, pvp or leaderboard
    // overlay now mirrors as the ONE Social frame, so the expected ids are the visible list folded
    // by `foldPanels` (the test's own oracle), and the start stacks draw from the frame ids a stack
    // can hold now: every overlay id but the three panels, plus `social` (a panel id is never pushed
    // any more, so a stack holding one is not a reachable shape). Every claim below is unchanged.
    const stackIds = FRAME_IDS.filter((id) => !isPanel(id));
    const nonBattleIds = stackIds.filter((id) => id !== 'battleView');
    const baseArb: fc.Arbitrary<BaseFrame> = fc.oneof(
      fc.constant<BaseFrame>(WORLD),
      fc
        .constantFrom('1', '42', '9007199254740993')
        .map((battleId): BaseFrame => ({ kind: 'battle', battleId })),
    );
    const frameArb = (id: FrameId): fc.Arbitrary<UpperFrame> =>
      fc.constantFrom<UpperFrame>(screen(id), prompt(id), textEntry(id));
    // A random starting stack (unique ids, any frame kind, any order; no battleView over a
    // battle base, which is not a reachable shape) and a random visible list in random order.
    const scenarioArb = baseArb.chain((base) =>
      fc
        .shuffledSubarray([...(base.kind === 'battle' ? nonBattleIds : stackIds)])
        .chain((startIds) =>
          fc
            .tuple(fc.tuple(...startIds.map(frameArb)), fc.shuffledSubarray([...OVERLAY_IDS]))
            .map(([start, visible]) => ({ base, start, visible })),
        ),
    );

    // ctl-6c CORRECTION (CTL6C.1, from the spec): a frame pushed over a battle base is now stamped
    // with `overBattle: <battleId>` (so reconcile can keep a battleSafe one), where it used to be a
    // bare `{kind:'screen', id}`. Over the world it stays unstamped. The expected shape below
    // tracks the base; it is not weakened (a missing or wrong stamp still fails).
    fc.assert(
      fc.property(scenarioArb, ({ base, start, visible }) => {
        const pushFrame = (id: FrameId): UpperFrame =>
          base.kind === 'battle' ? stamped(id, base.battleId) : screen(id);
        const from = stackOf(base, ...start);
        const effective = foldPanels(
          base.kind === 'battle' ? visible.filter((id) => id !== 'battleView') : visible,
        );
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
        ).toEqual(newIds.map((id) => pushEdge(pushFrame(id))));

        const folded = fold(from, edges);
        expect(folded.stack[0], 'the base is untouched').toEqual(base);
        expect(
          folded.stack.slice(1, 1 + keptFrames.length),
          'surviving frames keep their kind and order',
        ).toEqual(keptFrames);
        expect(
          folded.stack.slice(1 + keptFrames.length),
          'new frames are screens appended in visible order',
        ).toEqual(newIds.map(pushFrame));
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
    // ctl-8s INTENTIONAL CHANGE: the rows that used the pvp and trade overlays as two generic ids
    // use the quest log, help and shop (pvp and trade now fold into the Social frame, pinned in
    // CTL8S-3-MIRROR-ONE-FRAME). Each row keeps its claim; the visible order still differs from the
    // registry order in the first one.
    expect(
      mirrorEdges(WORLD_STACK, ['questLogView', BOX]),
      'two ids visible in one sync are pushed in visible order, not registry order',
    ).toEqual([pushEdge(screen('questLogView')), pushEdge(screen(BOX))]);
    expect(
      mirrorEdges(stackOf(WORLD, screen(BOX), screen('questLogView'), screen('helpView')), [
        'questLogView',
      ]),
      'hidden overlays are popped in stack order',
    ).toEqual([popEdge(BOX), popEdge('helpView')]);
    expect(
      mirrorEdges(stackOf(WORLD, screen(BOX), screen('helpView')), ['questLogView', 'helpView']),
      'pops come before pushes',
    ).toEqual([popEdge(BOX), pushEdge(screen('questLogView'))]);
    expect(
      mirrorEdges(stackOf(WORLD, prompt('shopView'), textEntry(RENAME)), ['shopView', RENAME]),
      'a prompt or text-entry frame already holding a visible id is left alone',
    ).toEqual([]);
    expect(
      mirrorEdges(stackOf(battle('7')), ['battleView']),
      'battleView is the battle base itself: no frame over a battle base',
    ).toEqual([]);
    expect(
      mirrorEdges(stackOf(battle('7')), ['battleView', BOX]),
      'only the other overlays are mirrored over a battle base, stamped with the battle (ctl-6c)',
    ).toEqual([pushEdge(stamped(BOX, '7'))]);
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

  it('CTL2-1-POLICY: SCREEN_POLICY is total over the frame ids (the overlay ids and the Social frame) and dialogue is server-owned and suspended by a battle', () => {
    // WRONG IMPL KILLED: a policy table that omits an overlay or carries a stray key, and a
    // dialogue row that lets a battle drop a live server conversation.
    // ctl-8s INTENTIONAL CHANGE (CTL8S.3): total over FRAME_IDS, which add `social`. Was:
    // OVERLAY_IDS.
    expect([...Object.keys(SCREEN_POLICY)].sort()).toEqual([...FRAME_IDS].sort());
    expect(SCREEN_POLICY.dialogueView).toEqual({
      owner: 'server',
      onBattle: 'suspend',
      battleSafe: false,
    });
    for (const id of FRAME_IDS) {
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

// ctl-8s: a close names a frame id (the Social frame included). Was: Exclude<OverlayId, ...>.
type CloseId = Exclude<FrameId, 'dialogueView'>;
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
const upperIdsOf = (s: Stack): readonly FrameId[] =>
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

  it('CTL3-2-POLICY-EXACT: SCREEN_POLICY owner and onBattle rows are exactly the literal table', () => {
    // WRONG IMPL KILLED: a table that marks a player overlay server-owned (reconcile would then
    // never close it), one that marks dialogue as droppable on battle (a live server conversation
    // would be torn off the stack), one that marks a player overlay `suspend`, and a row that goes
    // missing. The third column, battleSafe, is ctl-6c's: its exact literal is pinned in the ctl-6c
    // block of this file ("the SCREEN_POLICY battleSafe column is exactly the literal table").
    // ctl-8s INTENTIONAL CHANGE (CTL8S.3): the literal gains the Social frame, a player frame that
    // a battle drops, and is checked against the 18 frame ids. Was: 17 overlay ids.
    const expected: ReadonlyArray<
      readonly [FrameId, 'player' | 'server', 'drop' | 'suspend' | undefined]
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
      ['social', 'player', 'drop'],
    ];
    expect(expected, 'ANTI-VACUITY: the literal covers all 18 frame ids').toHaveLength(18);
    expect(sortedIds(expected.map(([id]) => id))).toEqual(sortedIds(FRAME_IDS));
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

// ==========================================================================================
// ctl-6b: the player-driven pops (Start / B), the close-side diff and the outcome-continue rule
// ==========================================================================================
//
// `popTop(stack)` drops the TOP upper frame positionally (B); `popToBase(stack)` keeps only the
// base (Start); both hand back the very same stack object when there is nothing above the base.
// `stackDiff(prev, next).closed` lists the upper frames of `prev` that `next` no longer holds,
// TOP FIRST (the order the retired Escape ladder closed them in), compared by structural frame key
// (kind + id, or kind + owner), never by object identity and never by the base.
// `continuedBattleId(latest, current)` is the pure rule of pgcc-d D3: continuing an outcome sets
// the dismissed id to the latest battle's id if and only if that battle is terminal.

describe('context stack: player pops, close diff and the outcome rule (ctl-6b)', () => {
  it('CTL6B-2-POP-TO-BASE: popToBase keeps only the base, whatever the base and the frames, and returns the same object when already bare', () => {
    // WRONG IMPL KILLED: a pop that removes one frame (Start would leave the menu up under a
    // child), one that clears the base, one that swaps a battle base for the world (movement would
    // come back mid-battle: B17), one that returns a fresh equal array for a bare stack (the shell
    // could not tell "nothing changed" from "something closed"), and one that mutates its input.
    const rows: ReadonlyArray<{ readonly name: string; readonly from: Stack; readonly to: Stack }> =
      [
        {
          name: 'three frames of three kinds over the world',
          from: stackOf(WORLD, screen(BOX), prompt(PVP), textEntry(RENAME)),
          to: WORLD_STACK,
        },
        { name: 'one frame over the world', from: stackOf(WORLD, screen(BOX)), to: WORLD_STACK },
        {
          name: 'two frames over a battle base keep the base',
          from: stackOf(battle('7'), screen(BOX), screen(PVP)),
          to: stackOf(battle('7')),
        },
        {
          name: 'a terminal-outcome frame over the world',
          from: stackOf(WORLD, screen('battleView')),
          to: WORLD_STACK,
        },
      ];
    for (const row of rows) {
      const before = JSON.stringify(row.from);
      const result = popToBase(deepFrozen(row.from));
      expect(result, row.name).toEqual(row.to);
      expect(JSON.stringify(row.from), `${row.name}: the input stack is untouched`).toBe(before);
    }

    const bareWorld = deepFrozen(WORLD_STACK);
    expect(popToBase(bareWorld), 'a bare world is returned as is').toBe(bareWorld);
    const bareBattle = deepFrozen(stackOf(battle('7')));
    expect(popToBase(bareBattle), 'a bare battle base is returned as is').toBe(bareBattle);

    // What the shell reads off the result: the gate follows the base.
    expect(
      movementEnabled(popToBase(stackOf(WORLD, screen(BOX), screen(PVP))), false),
      'popping to a world base opens the movement gate',
    ).toBe(true);
    expect(
      movementEnabled(popToBase(stackOf(battle('7'), screen(BOX))), false),
      'popping to a battle base does not',
    ).toBe(false);
    // Idempotent.
    const once = popToBase(stackOf(WORLD, screen(BOX)));
    expect(popToBase(once)).toBe(once);
  });

  it('CTL6B-3-POP-TOP: popTop drops exactly the top upper frame by position, never by id, and returns the same object for a bare base', () => {
    // WRONG IMPL KILLED: a pop that clears everything (Backspace would close the menu with its
    // child: B4), one keyed by id like contextStep's `pop` (a text-entry frame sharing its owner's
    // id would take the owner with it), one that pops the BOTTOM frame, one that drops the base,
    // one that returns a fresh array for a bare stack, and one that mutates its input.
    const rows: ReadonlyArray<{ readonly name: string; readonly from: Stack; readonly to: Stack }> =
      [
        {
          name: 'three frames: the top one goes',
          from: stackOf(WORLD, screen(BOX), screen(PVP), screen(TRADE)),
          to: stackOf(WORLD, screen(BOX), screen(PVP)),
        },
        {
          name: 'two frames: back to the first',
          from: stackOf(WORLD, screen('menuView'), screen('claimView')),
          to: stackOf(WORLD, screen('menuView')),
        },
        { name: 'one frame closes', from: stackOf(WORLD, screen(BOX)), to: WORLD_STACK },
        {
          name: 'a text-entry frame sharing its owner`s id leaves the owner standing',
          from: stackOf(WORLD, screen(RENAME), textEntry(RENAME)),
          to: stackOf(WORLD, screen(RENAME)),
        },
        {
          name: 'a prompt on top',
          from: stackOf(WORLD, screen(BOX), prompt(PVP)),
          to: stackOf(WORLD, screen(BOX)),
        },
        {
          name: 'over a battle base the base stays',
          from: stackOf(battle('7'), screen(BOX), screen(PVP)),
          to: stackOf(battle('7'), screen(BOX)),
        },
      ];
    for (const row of rows) {
      const before = JSON.stringify(row.from);
      const result = popTop(deepFrozen(row.from));
      expect(result, row.name).toEqual(row.to);
      expect(JSON.stringify(row.from), `${row.name}: the input stack is untouched`).toBe(before);
    }

    const bareWorld = deepFrozen(WORLD_STACK);
    expect(popTop(bareWorld), 'a bare world is returned as is').toBe(bareWorld);
    const bareBattle = deepFrozen(stackOf(battle('7')));
    expect(popTop(bareBattle), 'a bare battle base is returned as is').toBe(bareBattle);

    // Property: one pop is one frame, the prefix is untouched, and n pops reach the bare base.
    const frameArb: fc.Arbitrary<UpperFrame> = fc.oneof(
      fc.constantFrom(...OVERLAY_IDS).map(screen),
      fc.constantFrom(...OVERLAY_IDS).map(prompt),
      fc.constantFrom(...OVERLAY_IDS).map(textEntry),
    );
    const baseArb: fc.Arbitrary<BaseFrame> = fc.constantFrom(WORLD, battle('1'), battle('42'));
    fc.assert(
      fc.property(baseArb, fc.array(frameArb, { maxLength: 6 }), (base, frames) => {
        const from = stackOf(base, ...frames);
        const next = popTop(deepFrozen(from));
        if (frames.length === 0) {
          expect(next).toEqual(from);
          return;
        }
        expect(next.length, 'exactly one frame fewer').toBe(from.length - 1);
        expect(next, 'the prefix is untouched').toEqual(from.slice(0, -1));
        let cursor: Stack = from;
        for (let i = 0; i < frames.length; i += 1) cursor = popTop(cursor);
        expect(cursor, 'n pops reach the bare base').toEqual(stackOf(base));
      }),
      { numRuns: 200 },
    );
  });

  it('CTL6B-2-STACK-DIFF: stackDiff lists the closed frames TOP FIRST, by structural key, ignoring the base and object identity', () => {
    // WRONG IMPL KILLED: a bottom-first list (the privacy overlay's onDismissed -> renderClaim flush
    // would then run while the claim is still visible), a diff by object identity (a rebuilt equal
    // stack would close everything), one that treats a text entry and a screen of the same owner as
    // one frame (the typing frame could never close separately), one that conflates a screen and a
    // prompt of one id, one that lets a base change close frames, and one that reports a push.
    const closedOf = (prev: Stack, next: Stack): readonly UpperFrame[] =>
      stackDiff(deepFrozen(prev), deepFrozen(next)).closed;
    const rows: ReadonlyArray<{
      readonly name: string;
      readonly prev: Stack;
      readonly next: Stack;
      readonly closed: readonly UpperFrame[];
    }> = [
      {
        name: 'everything closes, top first',
        prev: stackOf(WORLD, screen(BOX), prompt(PVP), textEntry(RENAME)),
        next: stackOf(WORLD),
        closed: [textEntry(RENAME), prompt(PVP), screen(BOX)],
      },
      {
        name: 'the top two close, top first',
        prev: stackOf(WORLD, screen(BOX), prompt(PVP), textEntry(RENAME)),
        next: stackOf(WORLD, screen(BOX)),
        closed: [textEntry(RENAME), prompt(PVP)],
      },
      {
        name: 'a single pop',
        prev: stackOf(WORLD, screen('menuView'), screen('claimView')),
        next: stackOf(WORLD, screen('menuView')),
        closed: [screen('claimView')],
      },
      {
        name: 'nothing changed',
        prev: stackOf(WORLD, screen(BOX), screen(PVP)),
        next: stackOf(WORLD, screen(BOX), screen(PVP)),
        closed: [],
      },
      {
        name: 'a push closes nothing',
        prev: stackOf(WORLD),
        next: stackOf(WORLD, screen(BOX)),
        closed: [],
      },
      {
        name: 'a frame in the middle closes alone',
        prev: stackOf(WORLD, screen(BOX), screen(PVP), screen(TRADE)),
        next: stackOf(WORLD, screen(BOX), screen(TRADE)),
        closed: [screen(PVP)],
      },
      {
        name: 'a text entry is a different frame from a screen of the same owner',
        prev: stackOf(WORLD, screen(RENAME)),
        next: stackOf(WORLD, textEntry(RENAME)),
        closed: [screen(RENAME)],
      },
      {
        name: 'the text entry closes alone and the owner screen stays',
        prev: stackOf(WORLD, screen(RENAME), textEntry(RENAME)),
        next: stackOf(WORLD, screen(RENAME)),
        closed: [textEntry(RENAME)],
      },
      {
        name: 'a screen is a different frame from a prompt of the same id',
        prev: stackOf(WORLD, screen(PVP)),
        next: stackOf(WORLD, prompt(PVP)),
        closed: [screen(PVP)],
      },
      {
        name: 'a base change alone closes nothing',
        prev: stackOf(WORLD, screen(BOX)),
        next: stackOf(battle('7'), screen(BOX)),
        closed: [],
      },
      {
        name: 'the base change does not hide a real close',
        prev: stackOf(WORLD, screen(BOX), screen(PVP)),
        next: stackOf(battle('7'), screen(BOX)),
        closed: [screen(PVP)],
      },
    ];
    for (const row of rows) {
      expect(closedOf(row.prev, row.next), row.name).toEqual(row.closed);
    }

    // Structural, not referential: freshly built equal frames are the same frames.
    const same = stackDiff(
      stackOf(WORLD, screen(BOX), prompt(PVP)),
      stackOf(WORLD, { kind: 'screen', id: BOX }, { kind: 'prompt', id: PVP }),
    );
    expect(same.closed).toEqual([]);

    // Property: closed is exactly the prev frames whose key next lacks, in reverse stack order.
    const keyOf = (f: UpperFrame): string => `${f.kind}:${frameId(f)}`;
    const frameArb: fc.Arbitrary<UpperFrame> = fc.oneof(
      fc.constantFrom(...OVERLAY_IDS).map(screen),
      fc.constantFrom(...OVERLAY_IDS).map(prompt),
      fc.constantFrom(...OVERLAY_IDS).map(textEntry),
    );
    const uniqueFrames = fc.uniqueArray(frameArb, { selector: keyOf, maxLength: 7 });
    let nonEmpty = 0;
    fc.assert(
      fc.property(uniqueFrames, uniqueFrames, (a, b) => {
        const nextKeys = new Set(b.map(keyOf));
        const expected = a.filter((f) => !nextKeys.has(keyOf(f))).reverse();
        const result = closedOf(stackOf(WORLD, ...a), stackOf(WORLD, ...b));
        expect(result.map(keyOf)).toEqual(expected.map(keyOf));
        if (expected.length > 0) nonEmpty += 1;
      }),
      { numRuns: 300 },
    );
    expect(nonEmpty, 'ANTI-VACUITY: many generated pairs closed something').toBeGreaterThan(100);
  });

  it('CTL6B-2-OUTCOME-RULE: continuing sets the dismissed id to the latest battle if and only if it is terminal; Ongoing or no battle keeps the current id', () => {
    // WRONG IMPL KILLED: a rule that dismisses an Ongoing battle (Start on a live battle would
    // then hide it for good: B17), one that never dismisses a terminal outcome (it would re-pop on
    // the next batch), one that keeps the OLD id for a newer terminal battle (a second outcome would
    // be hidden), one that clears the id when there is no battle, a case-insensitive Ongoing match,
    // and an id that goes through Number() (ids past 2^53 collide).
    const BIG = 9007199254740993n;
    const TERMINAL = ['SideAWins', 'SideBWins', 'Fled', 'Recruited', 'Forfeit', 'ongoing', ''];
    const currents: ReadonlyArray<bigint | null> = [null, 5n, 9n, BIG - 1n];

    for (const current of currents) {
      expect(continuedBattleId(undefined, current), `no battle, current ${current}`).toBe(current);
      for (const battleId of [9n, BIG]) {
        expect(
          continuedBattleId({ battleId, outcome: 'Ongoing' }, current),
          `Ongoing ${battleId}, current ${current}`,
        ).toBe(current);
        for (const outcome of TERMINAL) {
          expect(
            continuedBattleId({ battleId, outcome }, current),
            `${JSON.stringify(outcome)} ${battleId}, current ${current}`,
          ).toBe(battleId);
        }
      }
    }
    // The result is the latest id exactly: a neighbour past 2^53 is not rounded onto it.
    expect(continuedBattleId({ battleId: BIG, outcome: 'Fled' }, BIG - 1n)).toBe(BIG);
    expect(continuedBattleId({ battleId: BIG, outcome: 'Fled' }, BIG - 1n)).not.toBe(BIG - 1n);
  });
});

// ==========================================================================================
// ctl-6c: Start over an Ongoing battle, the outcome continue, and the battle-safe command policy
// ==========================================================================================
//
// `mirrorEdges(stack, visible, prevBase = stack[0])` stamps a screen frame pushed over a battle base
// with `overBattle: <battleId>`, but only when the base was ALREADY that battle before this sync
// (`prevBase`): a frame first mirrored in the very batch that brings the battle was opened at the
// world and must still drop (CTL3.2). `reconcile` keeps a stamped, battleSafe frame of the CURRENT
// battle, and drops a stamped frame whose battle is gone even when no outcome is shown (the stale
// stamp). `battleButton(stack, btn, outcomeAgeMs?)` is the base-level battle rule (Start opens the
// menu at the bare battle base; A continues a terminal outcome after a grace). `battleRefused`
// reads `COMMAND_BATTLE_POLICY` (a total table over the `Command` kinds) at a battle base, through
// `battleSafeCommand`, the one predicate over that table; `isBareBattle(stack)` is the one test for
// "exactly a battle base, nothing above it".
//
// The expected sets below are HARD-CODED literals, never derived from SCREEN_POLICY or from the
// policy table: a table read from the very thing it guards shrinks with it and stays green.

/** The four overlays SCREEN_POLICY marks battleSafe besides battleView itself. HARD-CODED.
 *  ctl-8s: typed as frame ids, so a frame's id can be looked up in it (the Social frame is not). */
const SAFE_OVER_BATTLE: readonly FrameId[] = [
  'questLogView',
  'leaderboardView',
  'helpView',
  'menuView',
];
/** The other eleven player overlays: not battleSafe. HARD-CODED. */
const UNSAFE_OVER_BATTLE: readonly FrameId[] = [
  'boxView',
  'raisingView',
  'evolutionView',
  'healView',
  'shopView',
  'tradeView',
  'pvpView',
  'renameView',
  'tradeProposeView',
  'claimView',
  'privacyView',
];

const press = (button: VButton, repeat = false) => ({ button, repeat });
const ALL_BUTTONS: readonly VButton[] = [
  'Up',
  'Down',
  'Left',
  'Right',
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'Start',
  'Select',
];

describe('context stack: battle semantics (ctl-6c)', () => {
  it('CTL6C-1-BATTLE-START-OPENS-MENU: Start on a bare battle base is openMenu (a repeat is swallowed), every other stack or button is not the rule`s', () => {
    // WRONG IMPL KILLED: a Start that stays 'consumed' at the battle (today: the menu never
    // opens), one that opens the menu while a frame is already above the battle (a second Start
    // over the menu would reopen it instead of closing it; Start over [battle, dialogue] must keep
    // dismissing the dialogue, A4), one that opens at the world base (that is baseButton's own
    // rule, the shell falls through to it), a repeat Start that opens (OS key-repeat would reopen
    // the menu every tick), and a rule that grabs other buttons at the battle (B and Select must
    // reach the base's own swallow or toggle).
    const bare = deepFrozen(stackOf(battle('7')));
    expect(
      battleButton(bare, press('Start')),
      'Start at a bare battle base opens the menu',
    ).toEqual({ kind: 'openMenu' });
    expect(battleButton(bare, press('Start', true)), 'a repeat Start is swallowed').toBe(
      'consumed',
    );
    expect(
      battleButton(bare, press('Start'), 5_000),
      'the outcome age is irrelevant to Start at a battle base',
    ).toEqual({ kind: 'openMenu' });

    const notTheRule: ReadonlyArray<{ readonly name: string; readonly stack: Stack }> = [
      { name: 'the world base', stack: stackOf(WORLD) },
      { name: 'the world with a menu', stack: stackOf(WORLD, screen('menuView')) },
      { name: 'the world with the outcome frame', stack: stackOf(WORLD, screen('battleView')) },
      { name: 'a battle with the menu above it', stack: stackOf(battle('7'), screen('menuView')) },
      {
        name: 'a battle with a stamped menu above it',
        stack: stackOf(battle('7'), stamped('menuView', '7')),
      },
      {
        name: 'a battle with a suspended dialogue (Start dismisses it)',
        stack: stackOf(battle('7'), screen('dialogueView')),
      },
      {
        name: 'a battle with a stamped screen above a stamped menu',
        stack: stackOf(battle('7'), stamped('menuView', '7'), stamped('questLogView', '7')),
      },
    ];
    for (const row of notTheRule) {
      expect(battleButton(deepFrozen(row.stack), press('Start')), `Start over ${row.name}`).toBe(
        undefined,
      );
    }

    for (const button of ALL_BUTTONS.filter((b) => b !== 'Start')) {
      for (const repeat of [false, true]) {
        expect(
          battleButton(bare, press(button, repeat)),
          `${button}${repeat ? ' (repeat)' : ''} at a bare battle base is not the rule's`,
        ).toBe(undefined);
      }
    }
  });

  it('mirrorEdges stamps a screen pushed over a battle base with that battle, only when the base was already that battle; the base itself and the world never stamp', () => {
    // WRONG IMPL KILLED: no stamp at all (a menu opened over the battle is then
    // indistinguishable from one opened at the world and the next batch closes it), a stamp
    // carried by a world frame (it would survive a later battle), a stamp with another battle's id,
    // a stamp that ignores prevBase (the click race: a menu click-opened at the world and first
    // mirrored in the batch that brings the battle would be kept), a prevBase default other than
    // stack[0], an `overBattle: undefined` own property on an unstamped frame, a re-stamp of a
    // frame already on the stack, and a battleView frame pushed over a battle base.
    const pushed = (edges: readonly Edge[]): readonly UpperFrame[] =>
      edges.flatMap((e) => (e.kind === 'push' ? [e.frame] : []));

    // Default prevBase is stack[0]: the base was already this battle.
    expect(mirrorEdges(deepFrozen(stackOf(battle('7'))), ['menuView'])).toEqual([
      pushEdge(stamped('menuView', '7')),
    ]);
    expect(
      mirrorEdges(deepFrozen(stackOf(battle('7'))), ['menuView'], battle('7')),
      'an explicit prevBase of the same battle stamps',
    ).toEqual([pushEdge(stamped('menuView', '7'))]);
    expect(
      mirrorEdges(deepFrozen(stackOf(battle('12'))), ['menuView', 'questLogView']),
      'every pushed frame is stamped with the battle, in visible order',
    ).toEqual([pushEdge(stamped('menuView', '12')), pushEdge(stamped('questLogView', '12'))]);

    // The base flipped in this sync: unstamped, and the property is OMITTED, not undefined.
    const flips: ReadonlyArray<{ readonly name: string; readonly prev: BaseFrame }> = [
      { name: 'the world', prev: WORLD },
      { name: 'another battle', prev: battle('8') },
    ];
    for (const flip of flips) {
      const edges = mirrorEdges(deepFrozen(stackOf(battle('7'))), ['menuView'], flip.prev);
      expect(edges, `prevBase ${flip.name}: a bare push`).toEqual([pushEdge(screen('menuView'))]);
      const [frame] = pushed(edges);
      expect(frame, `prevBase ${flip.name}: a frame was pushed`).toBeDefined();
      expect(
        Object.hasOwn(frame as UpperFrame, 'overBattle'),
        `prevBase ${flip.name}: no overBattle property at all`,
      ).toBe(false);
    }

    // The world never stamps, whatever prevBase says.
    for (const prev of [WORLD, battle('7')]) {
      const edges = mirrorEdges(deepFrozen(stackOf(WORLD)), [BOX], prev);
      expect(edges).toEqual([pushEdge(screen(BOX))]);
      expect(Object.hasOwn(pushed(edges)[0] as UpperFrame, 'overBattle')).toBe(false);
    }

    // A frame already on the stack is neither re-pushed nor re-stamped; a stamped one is left alone.
    expect(
      mirrorEdges(deepFrozen(stackOf(battle('7'), stamped('menuView', '7'))), ['menuView']),
      'an already-mirrored stamped frame needs no edge',
    ).toEqual([]);
    expect(
      mirrorEdges(deepFrozen(stackOf(battle('7'), stamped('menuView', '7'))), ['menuView', BOX]),
      'a new frame is stamped, the old one is left',
    ).toEqual([pushEdge(stamped(BOX, '7'))]);
    expect(
      mirrorEdges(deepFrozen(stackOf(battle('7'))), ['battleView', 'menuView']),
      'battleView is the base itself: only the menu is pushed, stamped',
    ).toEqual([pushEdge(stamped('menuView', '7'))]);
    expect(
      mirrorEdges(deepFrozen(stackOf(battle('7'), stamped('menuView', '7'))), []),
      'a hidden stamped frame pops by id',
    ).toEqual([popEdge('menuView')]);
  });

  it('CTL6C-1-RECONCILE-KEEPS-SAFE-OVER-BATTLE: a stamped battleSafe frame of the current battle is kept (and stays kept); a different battle, a non-safe id, a conversation, a vanished battle or a shown outcome drops it with one close', () => {
    // WRONG IMPL KILLED: today's reconcile (every `drop` frame goes while a battle is up, so a menu
    // opened over the battle closes on the NEXT batch: red today); a keep rule that ignores the
    // stamp's battle id (a menu opened over battle 7 survives battle 8); one that keeps any
    // stamped frame (a box opened over the battle survives: the box is not battleSafe); one that
    // keeps an UNstamped battleSafe frame (a world-opened menu survives the battle that arrives:
    // CTL3.2); a stale stamp that survives the battle's removal (no outcome is shown then, so the
    // old battleUp rule never fires: the A1 hole); one that keeps a stamped frame through a
    // conversation (the dialogue frame would sit under a menu); a keep that is not idempotent (a
    // second pass re-closes or re-orders); and a reconcile that mutates its input.
    const M7 = stamped('menuView', '7');

    // (a) kept, with no command, and a second pass changes nothing.
    const kept = reconcile(deepFrozen(stackOf(battle('7'), M7)), serverView('7', false));
    expect(kept.stack, 'a: the stamped menu of the current battle is kept').toEqual(
      stackOf(battle('7'), M7),
    );
    expect(kept.commands, 'a: and nothing is closed or cleared').toEqual([]);
    const again = reconcile(kept.stack, serverView('7', false));
    expect(again.stack, 'a: the second pass keeps it').toEqual(stackOf(battle('7'), M7));
    expect(again.commands, 'a: and emits nothing').toEqual([]);

    // (b) every safe id is kept, together, in stack order; a conversation-less outcome-less view.
    expect(SAFE_OVER_BATTLE, 'ANTI-VACUITY: four safe ids').toHaveLength(4);
    const allSafe = SAFE_OVER_BATTLE.map((id) => stamped(id, '7'));
    const b = reconcile(deepFrozen(stackOf(battle('7'), ...allSafe)), serverView('7', false));
    expect(b.stack, 'b: every battleSafe stamped frame is kept').toEqual(
      stackOf(battle('7'), ...allSafe),
    );
    expect(b.commands, 'b: nothing closed').toEqual([]);

    // (c) every non-safe id is dropped even when stamped; one close each, in stack order.
    expect(UNSAFE_OVER_BATTLE, 'ANTI-VACUITY: eleven non-safe ids').toHaveLength(11);
    expect(
      sortedIds([...SAFE_OVER_BATTLE, ...UNSAFE_OVER_BATTLE]),
      'ANTI-VACUITY: safe plus non-safe is the 15 player ids',
    ).toEqual(sortedIds(PLAYER_IDS));
    const unsafe = UNSAFE_OVER_BATTLE.map((id) => stamped(id, '7'));
    const c = reconcile(deepFrozen(stackOf(battle('7'), ...unsafe)), serverView('7', false));
    expect(c.stack, 'c: a stamped non-safe frame is dropped').toEqual(stackOf(battle('7')));
    expect(closeIds(c.commands), 'c: one close each, in stack order').toEqual([
      ...UNSAFE_OVER_BATTLE,
    ]);
    expect(c.commands, 'c: nothing but the closes').toHaveLength(11);
    const mixed = reconcile(
      deepFrozen(stackOf(battle('7'), M7, stamped('boxView', '7'), stamped('questLogView', '7'))),
      serverView('7', false),
    );
    expect(mixed.stack, 'c: the safe frames around a dropped one stay, in order').toEqual(
      stackOf(battle('7'), M7, stamped('questLogView', '7')),
    );
    expect(mixed.commands).toEqual([closeCmd('boxView')]);

    // (d) a different battle is the base now: the stamp does not match.
    const d = reconcile(deepFrozen(stackOf(battle('7'), M7)), serverView('8', false));
    expect(d.stack, 'd: another battle drops the stamped menu').toEqual(stackOf(battle('8')));
    expect(d.commands, 'd: one close, no clearHeld (same base kind)').toEqual([
      closeCmd('menuView'),
    ]);

    // (e) a menu opened at the world (unstamped) drops when a battle appears: CTL3.2.
    const e = reconcile(deepFrozen(stackOf(WORLD, screen('menuView'))), serverView('7', false));
    expect(e.stack, 'e: the world-opened menu is dropped').toEqual(stackOf(battle('7')));
    expect(e.commands, 'e: clearHeld for the base change, then the close').toEqual([
      { kind: 'clearHeld' },
      closeCmd('menuView'),
    ]);
    const eSame = reconcile(
      deepFrozen(stackOf(battle('7'), screen('menuView'))),
      serverView('7', false),
    );
    expect(eSame.stack, 'e: an unstamped menu over an existing battle is dropped too').toEqual(
      stackOf(battle('7')),
    );
    expect(eSame.commands).toEqual([closeCmd('menuView')]);

    // (f) the outcome shows: the base returns to the world, the stamped menu goes.
    const f = reconcile(deepFrozen(stackOf(battle('7'), M7)), serverView(undefined, false, true));
    expect(f.stack, 'f: a shown outcome drops the stamped menu').toEqual(WORLD_STACK);
    expect(f.commands, 'f: clearHeld for the base change, then the close').toEqual([
      { kind: 'clearHeld' },
      closeCmd('menuView'),
    ]);

    // (g) the battle row vanished with NO outcome shown: the stamp is stale.
    const g = reconcile(deepFrozen(stackOf(battle('7'), M7)), serverView(undefined, false, false));
    expect(g.stack, 'g: no battle, no outcome: the stamped menu still goes').toEqual(WORLD_STACK);
    expect(g.commands).toEqual([{ kind: 'clearHeld' }, closeCmd('menuView')]);
    const gWorld = reconcile(deepFrozen(stackOf(WORLD, M7)), serverView(undefined, false, false));
    expect(gWorld.stack, 'g: a stamped frame over a world base goes with nothing shown').toEqual(
      WORLD_STACK,
    );
    expect(gWorld.commands).toEqual([closeCmd('menuView')]);
    // Control: the same frame, unstamped, over a world with nothing up, stays.
    const gControl = reconcile(
      deepFrozen(stackOf(WORLD, screen('menuView'))),
      serverView(undefined, false, false),
    );
    expect(gControl.stack, 'g control: an unstamped world menu stays').toEqual(
      stackOf(WORLD, screen('menuView')),
    );
    expect(gControl.commands).toEqual([]);

    // (h) a conversation drops a stamped player frame; the suspended dialogue frame stays.
    const h = reconcile(
      deepFrozen(stackOf(battle('7'), screen('dialogueView'), M7)),
      serverView('7', true),
    );
    expect(h.stack, 'h: the conversation takes the stamped menu, the dialogue frame stays').toEqual(
      stackOf(battle('7'), screen('dialogueView')),
    );
    expect(h.commands, 'h: one close, none for the dialogue').toEqual([closeCmd('menuView')]);
    const h2 = reconcile(deepFrozen(stackOf(battle('7'), M7)), serverView('7', true));
    expect(h2.stack).toEqual(stackOf(battle('7')));
    expect(h2.commands).toEqual([closeCmd('menuView')]);

    // (i) the outcome frame (battleView over the world) is still never dropped by this rule.
    const i = reconcile(
      deepFrozen(stackOf(battle('7'), M7, screen('battleView'))),
      serverView(undefined, false, true),
    );
    expect(upperIdsOf(i.stack), 'i: only the stamped menu goes').toEqual(['battleView']);
    expect(closeIds(i.commands)).toEqual(['menuView']);
  });

  it('reconcile over generated stacks of stamped, unstamped and foreign-battle frames follows the independent oracle and is idempotent', () => {
    // WRONG IMPL KILLED: any keep rule that deviates from "stamped with the current battle id, an
    // id in the literal battleSafe list, and no conversation" for a stamped frame, or from the old
    // rule (dropped while a battle or an outcome is up, kept otherwise) for an unstamped one; a
    // second pass that is not a no-op; and a reconcile that reorders survivors or closes twice.
    // The oracle is written from the spec, never from SCREEN_POLICY.
    let keptStamped = 0;
    let droppedStamped = 0;
    const stampArb = (id: FrameId): fc.Arbitrary<UpperFrame> =>
      fc.constantFrom<UpperFrame>(screen(id), stamped(id, '1'), stamped(id, '2'));
    const scenario = fc
      .tuple(
        fc.constantFrom<BaseFrame>(WORLD, battle('1'), battle('2')),
        fc.shuffledSubarray([...PLAYER_IDS]),
        fc.record({
          ongoingBattleId: fc.constantFrom<string | undefined>(undefined, '1', '2'),
          outcomeShown: fc.boolean(),
          conversation: fc.boolean(),
        }),
      )
      .chain(([base, ids, view]) =>
        fc.tuple(...ids.map(stampArb)).map((frames) => ({ from: stackOf(base, ...frames), view })),
      );
    fc.assert(
      fc.property(scenario, ({ from, view }) => {
        const result = reconcile(deepFrozen(from), view);
        const upper = from.slice(1) as readonly UpperFrame[];
        const battleUp = view.ongoingBattleId !== undefined || view.outcomeShown;
        const expected = upper.filter((f) => {
          if (view.conversation) return false;
          const stamp = (f as { readonly overBattle?: string }).overBattle;
          if (stamp === undefined) return !battleUp;
          return stamp === view.ongoingBattleId && SAFE_OVER_BATTLE.includes(frameId(f));
        });
        expect(result.stack.slice(1), 'survivors').toEqual(expected);
        expect(closeIds(result.commands), 'closes').toEqual(
          upper.filter((f) => !expected.includes(f)).map(frameId),
        );
        const second = reconcile(result.stack, view);
        expect(second.stack, 'idempotent stack').toEqual(result.stack);
        expect(second.commands, 'idempotent commands').toEqual([]);
        for (const f of upper) {
          if ((f as { readonly overBattle?: string }).overBattle === undefined) continue;
          if (expected.includes(f)) keptStamped += 1;
          else droppedStamped += 1;
        }
      }),
      { numRuns: 500 },
    );
    expect(keptStamped, 'ANTI-VACUITY: many stamped frames were kept').toBeGreaterThan(50);
    expect(droppedStamped, 'ANTI-VACUITY: many stamped frames were dropped').toBeGreaterThan(50);
  });

  it('the SCREEN_POLICY battleSafe column is exactly the literal table: battleView, questLogView, leaderboardView, helpView and menuView are battle-safe and no other frame id is', () => {
    // WRONG IMPL KILLED: any single flag flipped. The reconcile cases above see the column only
    // through the 15 player ids; battleView's and dialogueView's flags are observable nowhere else,
    // and a dialogue marked battle-safe would read as a screen the battle allows. A box, a shop or a
    // trade marked battle-safe would stay open over a battle; a menu or help that is not would close
    // on the next batch after Start opened it (CTL6C.1). A row that goes missing fails the totality.
    // ctl-8s INTENTIONAL CHANGE (CTL8S.3): the literal and the totality span the 18 frame ids; the
    // Social frame is NOT battle-safe (its Trades and Challenges panels issue refused commands), so
    // there are still exactly five battle-safe ids. Was: 17 overlay ids.
    const expected: Readonly<Record<FrameId, boolean>> = {
      battleView: true,
      boxView: false,
      raisingView: false,
      evolutionView: false,
      dialogueView: false,
      questLogView: true,
      healView: false,
      shopView: false,
      tradeView: false,
      pvpView: false,
      leaderboardView: true,
      renameView: false,
      tradeProposeView: false,
      helpView: true,
      menuView: true,
      claimView: false,
      privacyView: false,
      social: false,
    };
    expect(sortedIds(Object.keys(expected)), 'ANTI-VACUITY: the literal covers every id').toEqual(
      sortedIds(FRAME_IDS),
    );
    expect(sortedIds(Object.keys(SCREEN_POLICY)), 'the policy has no extra row').toEqual(
      sortedIds(FRAME_IDS),
    );
    for (const id of FRAME_IDS) {
      expect(SCREEN_POLICY[id].battleSafe, `${id}.battleSafe`).toBe(expected[id]);
    }
    expect(
      FRAME_IDS.filter((id) => SCREEN_POLICY[id].battleSafe),
      'exactly five battle-safe frame ids',
    ).toHaveLength(5);
  });

  it('isBareBattle is true only for a stack that is exactly one battle base frame, and Start at the battle opens the menu exactly where it holds', () => {
    // WRONG IMPL KILLED: a check of the base kind alone (a menu, a stamped frame or a suspended
    // dialogue above the battle would read as bare: Start there would reopen the menu instead of
    // closing it, or swallow the dialogue's dismiss, A4); a check of the length alone (the bare world
    // would read as a battle); one keyed to the top frame (the outcome frame over the world); and a
    // helper that disagrees with the Start rule it is the single source of.
    const rows: ReadonlyArray<{
      readonly name: string;
      readonly stack: Stack;
      readonly bare: boolean;
    }> = [
      { name: 'a bare battle base', stack: stackOf(battle('7')), bare: true },
      { name: 'another bare battle base', stack: stackOf(battle('42')), bare: true },
      { name: 'the bare world', stack: stackOf(WORLD), bare: false },
      {
        name: 'a battle with a menu above it',
        stack: stackOf(battle('7'), screen('menuView')),
        bare: false,
      },
      {
        name: 'a battle with a stamped menu above it',
        stack: stackOf(battle('7'), stamped('menuView', '7')),
        bare: false,
      },
      {
        name: 'a battle with a suspended dialogue',
        stack: stackOf(battle('7'), screen('dialogueView')),
        bare: false,
      },
      { name: 'a battle with a prompt', stack: stackOf(battle('7'), prompt(PVP)), bare: false },
      {
        name: 'a battle with a text entry',
        stack: stackOf(battle('7'), textEntry(RENAME)),
        bare: false,
      },
      {
        name: 'the outcome frame over the world',
        stack: stackOf(WORLD, screen('battleView')),
        bare: false,
      },
      { name: 'the world with a menu', stack: stackOf(WORLD, screen('menuView')), bare: false },
    ];
    for (const row of rows) {
      expect(isBareBattle(deepFrozen(row.stack)), row.name).toBe(row.bare);
      expect(
        battleButton(deepFrozen(row.stack), press('Start')),
        `${row.name}: Start is the menu rule exactly when the battle is bare`,
      ).toEqual(row.bare ? { kind: 'openMenu' } : undefined);
    }
    expect(
      rows.filter((r) => r.bare),
      'ANTI-VACUITY: both polarities are exercised',
    ).toHaveLength(2);
  });

  it('CTL6C-2-OUTCOME-A-B-CONTINUE: A on a terminal outcome pops it once it has been up OUTCOME_CONTINUE_GRACE_MS (400), swallows it before, and a repeat; B and Start are left to the legacy adapter', () => {
    // WRONG IMPL KILLED: an A that stays unhandled on the outcome (today: only Esc/Backspace
    // continue and the hint tells the player "Press Esc"); an A with no grace (an Enter mashed at
    // the battle's last turn would skip the result); a grace boundary off by one (399 passes, or
    // 400 does not); a grace measured the wrong way (an old outcome refused, a new one passed); an
    // unknown age that continues; a repeat A that continues (a held Enter would skip the result the
    // instant the grace ends); a B or Start remapped here (they already continue through the
    // legacy adapter: a second path would double-pop); an A that continues the Ongoing battle's
    // base (B17), the world, or a non-outcome frame; and one that closes a dialogue instead of
    // only the outcome (A is a `pop` of the top frame, never popToBase).
    expect(OUTCOME_CONTINUE_GRACE_MS, 'the grace is 400 ms').toBe(400);

    const outcome = deepFrozen(stackOf(WORLD, screen('battleView')));
    const ages: ReadonlyArray<readonly [string, number | undefined, 'pop' | 'consumed']> = [
      ['age 0', 0, 'consumed'],
      ['age 1', 1, 'consumed'],
      ['age 399', 399, 'consumed'],
      ['age 399.9', 399.9, 'consumed'],
      ['age 400 (the boundary)', 400, 'pop'],
      ['age 401', 401, 'pop'],
      ['age 10 minutes', 600_000, 'pop'],
      ['age unknown', undefined, 'consumed'],
      ['negative age', -1, 'consumed'],
    ];
    for (const [name, age, want] of ages) {
      const got = battleButton(outcome, press('A'), age);
      expect(got, `A at ${name}`).toEqual(want === 'pop' ? { kind: 'pop' } : 'consumed');
    }
    for (const age of [0, 399, 400, 1_000, undefined]) {
      expect(
        battleButton(outcome, press('A', true), age),
        `a repeat A at age ${String(age)} is swallowed`,
      ).toBe('consumed');
    }

    // B and Start, and every other button, are not the rule's on the outcome.
    for (const button of ALL_BUTTONS.filter((b) => b !== 'A')) {
      for (const age of [0, 500]) {
        expect(
          battleButton(outcome, press(button), age),
          `${button} on the outcome at age ${age} is the legacy adapter's`,
        ).toBe(undefined);
      }
    }

    // A over a suspended dialogue below the outcome pops only the outcome.
    const withDialogue = deepFrozen(stackOf(WORLD, screen('dialogueView'), screen('battleView')));
    expect(battleButton(withDialogue, press('A'), 500)).toEqual({ kind: 'pop' });
    expect(battleButton(withDialogue, press('A'), 399)).toBe('consumed');

    // Not an outcome: A is not the rule's.
    const notOutcome: ReadonlyArray<{ readonly name: string; readonly stack: Stack }> = [
      { name: 'the bare world', stack: stackOf(WORLD) },
      { name: 'a bare battle base', stack: stackOf(battle('7')) },
      { name: 'the world with a box', stack: stackOf(WORLD, screen(BOX)) },
      { name: 'the world with a menu', stack: stackOf(WORLD, screen('menuView')) },
      {
        name: 'the outcome with a frame above it',
        stack: stackOf(WORLD, screen('battleView'), screen('menuView')),
      },
      {
        name: 'the outcome under a suspended dialogue',
        stack: stackOf(WORLD, screen('battleView'), screen('dialogueView')),
      },
      {
        name: 'a battle base with a battleView frame (not a reachable shape)',
        stack: stackOf(battle('7'), screen('battleView')),
      },
      { name: 'a battleView PROMPT frame', stack: stackOf(WORLD, prompt('battleView')) },
      { name: 'a battleView TEXT-ENTRY frame', stack: stackOf(WORLD, textEntry('battleView')) },
    ];
    for (const row of notOutcome) {
      expect(battleButton(deepFrozen(row.stack), press('A'), 500), `A over ${row.name}`).toBe(
        undefined,
      );
    }
  });

  it('CTL6C-3-REFUSAL-TABLE: at a battle base every non-battleSafe command is refused and the twelve safe ones are not; at the world or over an outcome nothing is refused; the policy table is total over the literal kinds and battleSafeCommand is the one predicate over it', () => {
    // WRONG IMPL KILLED: a refusal that is a no-op (the policy is never consulted: every row of
    // the refused list reads false); a policy that refuses everything (a battle's own attack, the
    // stack moves or dismissDialogue would die: Start over [battle, dialogue] must still
    // dismiss); one that refuses nothing; one keyed to the TOP frame or to a store read instead of
    // stack[0] (a menu above the battle, a suspended dialogue or a stack-only battle base must still
    // refuse); one that refuses at a world base or over an outcome frame (the world would lose
    // care, shop, trade and challenge); a table with a stray or missing kind (a new Command arm
    // must classify itself: here the literal 37 kinds are the whole table); a single row moved
    // from refuse to safe (each of the named rows below is its own sample); and a battleSafeCommand
    // that disagrees with the table or with battleRefused (two readers of one policy drifting
    // apart: the shell's early return and the stack rule would then refuse different commands).
    // Named spec rows: Care = care, Feed = train, Move = setPartySlot, Evolve = evolve, challenge
    // Accept = acceptChallenge, buy, sell. Bag Use and talk have no Command arm yet: Bag Use is
    // covered by the disabled Bag menu row (CTL6C-3-MENU-DISABLED-OVER-BATTLE in
    // mainMenuScreen.test.ts), talk by the booted KeyT movement-gate test CTL2-3-BOOT-B17 in
    // main.input.test.ts, and the total Record makes their future arms classify themselves.
    // ctl-7d (named intentional change, CTL7D.3 / CTL7D.5): `buy` and `sell` carry a `qty`, and
    // the new `pickShop` arm (the greet-then-shop pick) joins the refused list: 12 safe, 25
    // refused, 37 kinds (were 12 / 24 / 36).
    const big = 5n;
    const SAFE: ReadonlyArray<readonly [string, ScreenCommand]> = [
      ['pop', { kind: 'pop' }],
      ['popToBase', { kind: 'popToBase' }],
      ['openMenu', { kind: 'openMenu' }],
      ['toggleHelp', { kind: 'toggleHelp' }],
      ['attack', { kind: 'attack', battleId: big, skillId: 1 }],
      ['flee', { kind: 'flee', battleId: big }],
      ['swap', { kind: 'swap', battleId: big, teamIndex: 1 }],
      ['recruit', { kind: 'recruit', battleId: big, baitItemId: undefined }],
      ['useItem', { kind: 'useItem', battleId: big, itemId: 3 }],
      ['pvpAttack', { kind: 'pvpAttack', battleId: big, skillId: 1 }],
      ['pvpSwap', { kind: 'pvpSwap', battleId: big, teamIndex: 1 }],
      ['dismissDialogue', { kind: 'dismissDialogue' }],
    ];
    const proposal = {
      targetIdentity: 'cd'.repeat(32),
      initiatorMonsterIds: [1n],
      initiatorCurrency: 0n,
      counterpartyCurrency: 0n,
    } as unknown as Extract<ScreenCommand, { kind: 'proposeTrade' }>['args'];
    const REFUSE: ReadonlyArray<readonly [string, ScreenCommand]> = [
      ['Care: care', { kind: 'care', monsterId: big }],
      ['Feed: train', { kind: 'train', monsterId: big, foodItemId: 2 }],
      ['Evolve: evolve', { kind: 'evolve', monsterId: big, toSpecies: 9 }],
      ['setNickname', { kind: 'setNickname', monsterId: big, nickname: 'Zed' }],
      ['Move: setPartySlot', { kind: 'setPartySlot', monsterId: big, slot: 0 }],
      ['healParty', { kind: 'healParty' }],
      ['buy', { kind: 'buy', shopId: 1, itemId: 2, qty: 3 }],
      ['sell', { kind: 'sell', itemId: 2, qty: 3 }],
      ['respondTrade', { kind: 'respondTrade', tradeId: big, accepted: true }],
      ['confirmTrade', { kind: 'confirmTrade', tradeId: big }],
      ['cancelTrade', { kind: 'cancelTrade', tradeId: big }],
      ['proposeTrade', { kind: 'proposeTrade', args: proposal }],
      ['challenge', { kind: 'challenge', targetIdentity: 'cd'.repeat(32) }],
      ['challenge Accept: acceptChallenge', { kind: 'acceptChallenge', challengeId: big }],
      ['declineChallenge', { kind: 'declineChallenge', challengeId: big }],
      ['cancelChallenge', { kind: 'cancelChallenge', challengeId: big }],
      ['setProfileName', { kind: 'setProfileName', name: 'Zed' }],
      ['advanceDialogue', { kind: 'advanceDialogue', choiceIdx: 0 }],
      ['pickShop', { kind: 'pickShop', shopId: 4 }],
      ['claimSignIn', { kind: 'claimSignIn' }],
      ['claimJoin', { kind: 'claimJoin' }],
      ['claimDecline', { kind: 'claimDecline' }],
      ['deleteAccount', { kind: 'deleteAccount' }],
      ['cancelAccountDeletion', { kind: 'cancelAccountDeletion' }],
      ['requestDataExport', { kind: 'requestDataExport' }],
    ];
    expect(SAFE, 'ANTI-VACUITY: twelve safe kinds').toHaveLength(12);
    expect(REFUSE, 'ANTI-VACUITY: twenty-five refused kinds').toHaveLength(25);
    const kindsOf = (rows: ReadonlyArray<readonly [string, ScreenCommand]>): string[] =>
      rows.map(([, c]) => c.kind);
    expect(new Set([...kindsOf(SAFE), ...kindsOf(REFUSE)]).size, 'every kind appears once').toBe(
      37,
    );
    expect(
      kindsOf(SAFE),
      'the safe kinds are exactly the battle`s own actions, the stack moves and dismissDialogue',
    ).toEqual([
      'pop',
      'popToBase',
      'openMenu',
      'toggleHelp',
      'attack',
      'flee',
      'swap',
      'recruit',
      'useItem',
      'pvpAttack',
      'pvpSwap',
      'dismissDialogue',
    ]);

    // The table itself is total over the 37 literal kinds and says exactly this.
    expect(sortedIds(Object.keys(COMMAND_BATTLE_POLICY))).toEqual(
      sortedIds([...kindsOf(SAFE), ...kindsOf(REFUSE)]),
    );
    for (const [, command] of SAFE) {
      expect(COMMAND_BATTLE_POLICY[command.kind], `${command.kind} is safe`).toBe('safe');
    }
    for (const [, command] of REFUSE) {
      expect(COMMAND_BATTLE_POLICY[command.kind], `${command.kind} is refused`).toBe('refuse');
    }
    // The one predicate over the table agrees with it row by row (read off the literal lists).
    for (const [label, command] of SAFE) {
      expect(battleSafeCommand(command), `${label}: battleSafeCommand is true`).toBe(true);
    }
    for (const [label, command] of REFUSE) {
      expect(battleSafeCommand(command), `${label}: battleSafeCommand is false`).toBe(false);
    }

    // Every battle-base stack shape refuses the refused list and passes the safe list.
    const battleStacks: ReadonlyArray<{ readonly name: string; readonly stack: Stack }> = [
      { name: 'a bare battle base (stack only, no store)', stack: stackOf(battle('7')) },
      { name: 'a battle with a menu above it', stack: stackOf(battle('7'), screen('menuView')) },
      {
        name: 'a battle with a stamped menu',
        stack: stackOf(battle('7'), stamped('menuView', '7')),
      },
      {
        name: 'a battle with a suspended dialogue',
        stack: stackOf(battle('7'), screen('dialogueView')),
      },
      {
        name: 'a battle with a prompt and a text entry',
        stack: stackOf(battle('7'), prompt('pvpView'), textEntry('renameView')),
      },
    ];
    for (const { name, stack } of battleStacks) {
      for (const [label, command] of REFUSE) {
        expect(battleRefused(deepFrozen(stack), command), `${name}: ${label} is refused`).toBe(
          true,
        );
      }
      for (const [label, command] of SAFE) {
        expect(battleRefused(deepFrozen(stack), command), `${name}: ${label} is allowed`).toBe(
          false,
        );
      }
    }

    // Controls: at the world, over the outcome frame, under the world's own screens: nothing refused.
    const worldStacks: ReadonlyArray<{ readonly name: string; readonly stack: Stack }> = [
      { name: 'the bare world', stack: stackOf(WORLD) },
      { name: 'the world with a box', stack: stackOf(WORLD, screen(BOX)) },
      { name: 'the world with a menu', stack: stackOf(WORLD, screen('menuView')) },
      { name: 'the outcome over the world', stack: stackOf(WORLD, screen('battleView')) },
      {
        name: 'a conversation at the world',
        stack: stackOf(WORLD, screen('dialogueView')),
      },
    ];
    for (const { name, stack } of worldStacks) {
      for (const [label, command] of [...REFUSE, ...SAFE]) {
        expect(
          battleRefused(deepFrozen(stack), command),
          `${name}: ${label} is never refused without a battle base`,
        ).toBe(false);
      }
    }

    // battleRefused is exactly "a battle base and not battleSafeCommand", on every stack above.
    for (const { name, stack } of [...battleStacks, ...worldStacks]) {
      for (const [label, command] of [...REFUSE, ...SAFE]) {
        expect(
          battleRefused(deepFrozen(stack), command),
          `${name}: ${label} is refused iff a battle base and not battle-safe`,
        ).toBe(stack[0].kind === 'battle' && !battleSafeCommand(command));
      }
    }
  });
});

describe('the greet-then-shop pick over a battle (ctl-7d, CTL7D.5)', () => {
  it('CTL7D-5-POLICY-REFUSE: pickShop is refused at every battle-base stack shape (bare, over a suspended dialogue, under a menu) for shop 0 and a non-zero shop, and allowed at a world base and over an outcome frame; battleSafeCommand says false and its policy row is exactly refuse', () => {
    // WRONG IMPL KILLED: `pickShop` classified `safe`, the likely copy of the `dismissDialogue` row
    // it sits beside in the Dialogue group (`dismissDialogue` IS safe): a Shop pick over a dialogue
    // suspended by a battle would dismiss the conversation mid-battle and open the shop under the
    // battle; `pickShop` left out of the table (the total Record breaks client-typecheck, and the
    // row read here is undefined); a refusal keyed to the shop id (shop 0 read as "no shop"); and
    // one keyed to anything but a battle base (a Shop click at the world, or after the battle
    // ended with its outcome still up, would do nothing). Every expectation is a literal, never
    // read back from COMMAND_BATTLE_POLICY.
    expect(COMMAND_BATTLE_POLICY.pickShop, 'the policy row').toBe('refuse');
    const picks: ReadonlyArray<readonly [string, ScreenCommand]> = [
      ['pickShop shop 0', { kind: 'pickShop', shopId: 0 }],
      ['pickShop shop 4', { kind: 'pickShop', shopId: 4 }],
    ];
    const atBattle: ReadonlyArray<readonly [string, Stack]> = [
      ['a bare battle base', stackOf(battle('7'))],
      [
        'a battle with a suspended dialogue (where the Shop choice is clicked)',
        stackOf(battle('7'), screen('dialogueView')),
      ],
      ['a battle with a menu above it', stackOf(battle('7'), screen('menuView'))],
      [
        'a battle with a stamped menu over a suspended dialogue',
        stackOf(battle('7'), screen('dialogueView'), stamped('menuView', '7')),
      ],
    ];
    const atWorld: ReadonlyArray<readonly [string, Stack]> = [
      ['the bare world', stackOf(WORLD)],
      ['a conversation at the world', stackOf(WORLD, screen('dialogueView'))],
      ['the outcome frame over the world', stackOf(WORLD, screen('battleView'))],
      [
        'the outcome over a suspended dialogue',
        stackOf(WORLD, screen('dialogueView'), screen('battleView')),
      ],
    ];
    let checked = 0;
    for (const [pickLabel, pick] of picks) {
      expect(battleSafeCommand(pick), `${pickLabel}: not battle-safe`).toBe(false);
      for (const [name, stack] of atBattle) {
        expect(battleRefused(deepFrozen(stack), pick), `${name}: ${pickLabel} is refused`).toBe(
          true,
        );
        checked += 1;
      }
      for (const [name, stack] of atWorld) {
        expect(battleRefused(deepFrozen(stack), pick), `${name}: ${pickLabel} is allowed`).toBe(
          false,
        );
        checked += 1;
      }
    }
    expect(checked, 'ANTI-VACUITY: 2 picks x (4 battle + 4 world stacks)').toBe(16);
  });
});

// ==========================================================================================
// ctl-8s: one Social frame over three panels (CTL8S.3)
// ==========================================================================================
//
// The trade, pvp and leaderboard overlays are the PANELS of one frame, `social`. `mirrorEdges`
// folds them: the first visible panel's position holds ONE `{ kind: 'screen', id: 'social' }`
// (stamped over a battle as any frame is), a panel id is never pushed, a stack that already holds
// `social` raises no edge whichever panel is visible (a panel switch is not a frame change, so the
// frame's adapter state survives it), and `social` pops when no panel is visible.
// `socialPanel(tab)` names the panel a requested tab shows. `SCREEN_POLICY.social` is a player
// frame that a battle drops and that is not battle-safe; the three panel rows stay as they were.
//
// Every expected edge and policy row below is a HARD-CODED literal, never read from the module.

describe('context stack: the one Social frame (ctl-8s, CTL8S.3)', () => {
  it('CTL8S-3-SOCIAL-PANEL: socialPanel names the panel of each requested tab, challenges the pvp panel, rankings the leaderboard and trades, players and no tab the trade panel; SOCIAL_PANELS is the three panels in that order and SOCIAL_FRAME is `social`', () => {
    // WRONG IMPL KILLED: a crossed map (challenges to the leaderboard: P would open Rankings), a
    // `null` or `players` tab that names no panel (`undefined`: the open path would show nothing
    // and push no frame), a players tab sent to the pvp panel, a panel list missing one (a mirror
    // or close built from it would leave that root painted), and a frame id other than `social`
    // (every stack read and e2e selector in this slice names it).
    expect(SOCIAL_FRAME, 'the Social frame id').toBe('social');
    expect(SOCIAL_PANELS, 'the three panels, in order').toEqual([
      'tradeView',
      'pvpView',
      'leaderboardView',
    ]);
    const rows: ReadonlyArray<readonly [SocialTab | null, SocialPanelId]> = [
      ['trades', 'tradeView'],
      ['challenges', 'pvpView'],
      ['rankings', 'leaderboardView'],
      ['players', 'tradeView'],
      [null, 'tradeView'],
    ];
    let checked = 0;
    for (const [tab, panel] of rows) {
      expect(socialPanel(tab), `${String(tab)} shows the ${panel} panel`).toBe(panel);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: the four tabs and no tab').toBe(5);
    expect(
      [...new Set(rows.map(([tab]) => socialPanel(tab)))].sort(),
      'every panel is reached by some tab',
    ).toEqual(['leaderboardView', 'pvpView', 'tradeView']);
  });

  it('CTL8S-3-MIRROR-ONE-FRAME: mirrorEdges folds the trade, pvp and leaderboard overlays into ONE social frame at the first visible panel`s position, stamped over a battle like any frame; it never pushes a panel frame; a stack holding social raises no edge whichever panels are visible; with no panel visible social pops; SCREEN_POLICY.social drops on a battle and is not battle-safe, the panel rows unchanged; and reconcile closes a social frame when a battle, an outcome or a conversation arrives', () => {
    // WRONG IMPL KILLED: today's mirror (one frame per visible panel: U, P and L push three
    // different ids); a mirror that pushes `social` AND the panel; one that pushes `social` once
    // per visible panel; one that appends `social` after the other frames instead of at the first
    // panel's place; one that pops and re-pushes `social` when the visible panel changes (the
    // frame's state would be reset by every tab switch); one that never pops it (a closed Social
    // would leave the world frozen under a phantom frame); a `social` push that skips the stamping
    // rule every other frame follows (unstamped over its own battle, or stamped in the sync that
    // brought the battle); a Social policy row that is battle-safe or server-owned (a battle or a
    // conversation would leave the trade and challenge controls painted under it); a panel row
    // changed with it (the main menu's battle rule reads those rows); and a reconcile that cannot
    // close `social`.
    const SOCIAL = screen('social');
    const pushed = (edges: readonly Edge[]): readonly UpperFrame[] =>
      edges.flatMap((e) => (e.kind === 'push' ? [e.frame] : []));

    // Each panel alone: ONE push of the Social frame, stamped exactly as any other frame.
    let alone = 0;
    for (const panel of PANEL_IDS) {
      expect(mirrorEdges(deepFrozen(WORLD_STACK), [panel]), `${panel} alone at the world`).toEqual([
        pushEdge(SOCIAL),
      ]);
      expect(
        mirrorEdges(deepFrozen(stackOf(battle('7'))), [panel]),
        `${panel} over the battle it was opened over: stamped`,
      ).toEqual([pushEdge(stamped('social', '7'))]);
      const flipped = mirrorEdges(deepFrozen(stackOf(battle('7'))), [panel], WORLD);
      expect(flipped, `${panel} first mirrored in the sync that brought the battle`).toEqual([
        pushEdge(SOCIAL),
      ]);
      expect(
        Object.hasOwn(pushed(flipped)[0] as UpperFrame, 'overBattle'),
        `${panel}: no overBattle property at all`,
      ).toBe(false);
      alone += 1;
    }
    expect(alone, 'ANTI-VACUITY: three panels').toBe(3);

    // Two or three panels in one sync, in any order: still ONE Social frame.
    const groups: ReadonlyArray<readonly OverlayId[]> = [
      ['tradeView', 'pvpView'],
      ['pvpView', 'tradeView'],
      ['leaderboardView', 'tradeView'],
      ['pvpView', 'leaderboardView'],
      ['tradeView', 'pvpView', 'leaderboardView'],
      ['leaderboardView', 'pvpView', 'tradeView'],
    ];
    for (const group of groups) {
      expect(mirrorEdges(deepFrozen(WORLD_STACK), group), group.join(' + ')).toEqual([
        pushEdge(SOCIAL),
      ]);
    }

    // At the first visible panel's position, among other frames, in visible order.
    expect(
      mirrorEdges(deepFrozen(WORLD_STACK), [BOX, 'pvpView', 'questLogView', 'tradeView']),
      'social takes the first panel`s place',
    ).toEqual([pushEdge(screen(BOX)), pushEdge(SOCIAL), pushEdge(screen('questLogView'))]);
    expect(
      mirrorEdges(deepFrozen(WORLD_STACK), ['leaderboardView', 'menuView']),
      'a panel listed first: social first',
    ).toEqual([pushEdge(SOCIAL), pushEdge(screen('menuView'))]);

    // Social on the stack and ANY panel visible: no edge at all.
    const shownSets: ReadonlyArray<readonly OverlayId[]> = [
      ['tradeView'],
      ['pvpView'],
      ['leaderboardView'],
      ['tradeView', 'pvpView'],
      ['pvpView', 'leaderboardView'],
      ['tradeView', 'leaderboardView'],
      ['tradeView', 'pvpView', 'leaderboardView'],
    ];
    let still = 0;
    for (const shown of shownSets) {
      const label = shown.join(' + ');
      expect(mirrorEdges(deepFrozen(stackOf(WORLD, SOCIAL)), shown), `social, ${label}`).toEqual(
        [],
      );
      expect(
        mirrorEdges(deepFrozen(stackOf(WORLD, screen('menuView'), SOCIAL)), ['menuView', ...shown]),
        `social over the menu, ${label}`,
      ).toEqual([]);
      expect(
        mirrorEdges(deepFrozen(stackOf(battle('7'), stamped('social', '7'))), shown),
        `a stamped social over its battle, ${label}`,
      ).toEqual([]);
      still += 1;
    }
    expect(still, 'ANTI-VACUITY: every non-empty set of panels').toBe(7);

    // No panel visible: social pops, by its id.
    expect(mirrorEdges(deepFrozen(stackOf(WORLD, SOCIAL)), []), 'nothing shown').toEqual([
      popEdge('social'),
    ]);
    expect(
      mirrorEdges(deepFrozen(stackOf(WORLD, screen('menuView'), SOCIAL)), ['menuView']),
      'the menu stays, social pops',
    ).toEqual([popEdge('social')]);
    expect(
      mirrorEdges(deepFrozen(stackOf(battle('7'), stamped('social', '7'))), ['battleView']),
      'a stamped social pops by its id too',
    ).toEqual([popEdge('social')]);
    // A frame shown beside a standing Social frame is pushed alone.
    expect(
      mirrorEdges(deepFrozen(stackOf(WORLD, SOCIAL)), ['pvpView', 'claimView']),
      'a new frame above Social',
    ).toEqual([pushEdge(screen('claimView'))]);

    // Generated: whatever the start stack and the visible list, no panel frame is pushed, social
    // is pushed once exactly when a panel shows and it is not on the stack, the folded stack holds
    // social exactly while a panel shows, and a second mirror is a no-op.
    const startPool = FRAME_IDS.filter((id) => !isPanel(id) && id !== 'battleView');
    let multiPanel = 0;
    let socialPushes = 0;
    fc.assert(
      fc.property(
        fc.constantFrom<BaseFrame>(WORLD, battle('1')),
        fc
          .shuffledSubarray([...startPool])
          .chain((ids) =>
            fc.tuple(
              ...ids.map((id) =>
                fc.constantFrom<UpperFrame>(screen(id), prompt(id), textEntry(id)),
              ),
            ),
          ),
        fc.shuffledSubarray([...OVERLAY_IDS]),
        (base, start, visible) => {
          const from = stackOf(base, ...start);
          const edges = mirrorEdges(deepFrozen(from), visible);
          const pushedIds = pushed(edges).map(frameId);
          expect(pushedIds.filter(isPanel), 'no panel frame is ever pushed').toEqual([]);
          const anyPanel = visible.some(isPanel);
          const socialBefore = start.some((f) => frameId(f) === 'social');
          expect(
            pushedIds.filter((id) => id === 'social').length,
            'social is pushed once when a panel shows and it is not on the stack',
          ).toBe(anyPanel && !socialBefore ? 1 : 0);
          const folded = fold(from, edges).stack;
          const ids = (folded.slice(1) as readonly UpperFrame[]).map(frameId);
          expect(ids.filter(isPanel), 'no panel frame on the folded stack').toEqual([]);
          expect(ids.includes('social'), 'social is on the stack exactly while a panel shows').toBe(
            anyPanel,
          );
          expect(mirrorEdges(folded, visible), 'mirroring again is a no-op').toEqual([]);
          if (visible.filter(isPanel).length >= 2) multiPanel += 1;
          if (anyPanel && !socialBefore) socialPushes += 1;
        },
      ),
      { numRuns: 300 },
    );
    expect(multiPanel, 'ANTI-VACUITY: many runs showed two or three panels').toBeGreaterThan(50);
    expect(socialPushes, 'ANTI-VACUITY: many runs pushed the Social frame').toBeGreaterThan(50);

    // The policy: a player frame a battle drops, never battle-safe; the panel rows unchanged.
    expect(SCREEN_POLICY.social, 'the Social frame').toEqual({
      owner: 'player',
      onBattle: 'drop',
      battleSafe: false,
    });
    expect(SCREEN_POLICY.tradeView, 'the trade panel row').toEqual({
      owner: 'player',
      onBattle: 'drop',
      battleSafe: false,
    });
    expect(SCREEN_POLICY.pvpView, 'the pvp panel row').toEqual({
      owner: 'player',
      onBattle: 'drop',
      battleSafe: false,
    });
    expect(SCREEN_POLICY.leaderboardView, 'the leaderboard panel row stays battle-safe').toEqual({
      owner: 'player',
      onBattle: 'drop',
      battleSafe: true,
    });

    // reconcile closes a Social frame (through one `close` for `social`) when a battle arrives,
    // over its own battle too, under a shown outcome, and when a conversation arrives.
    const battleArrives = reconcile(deepFrozen(stackOf(WORLD, SOCIAL)), serverView('7', false));
    expect(battleArrives.stack, 'a battle: only its base is left').toEqual(stackOf(battle('7')));
    expect(battleArrives.commands, 'clearHeld for the base, one close for social').toEqual([
      { kind: 'clearHeld' },
      closeCmd('social'),
    ]);
    const stampedOver = reconcile(
      deepFrozen(stackOf(battle('7'), stamped('social', '7'))),
      serverView('7', false),
    );
    expect(stampedOver.stack, 'not battle-safe: dropped even over its own battle').toEqual(
      stackOf(battle('7')),
    );
    expect(stampedOver.commands).toEqual([closeCmd('social')]);
    const outcome = reconcile(
      deepFrozen(stackOf(WORLD, SOCIAL)),
      serverView(undefined, false, true),
    );
    expect(outcome.stack, 'a shown outcome drops it').toEqual(WORLD_STACK);
    expect(outcome.commands).toEqual([closeCmd('social')]);
    const conversation = reconcile(
      deepFrozen(stackOf(WORLD, screen('menuView'), SOCIAL)),
      serverView(undefined, true),
    );
    expect(conversation.stack, 'a conversation takes the menu and Social').toEqual(WORLD_STACK);
    expect(conversation.commands, 'one close each, in stack order').toEqual([
      closeCmd('menuView'),
      closeCmd('social'),
    ]);
    const quiet = reconcile(deepFrozen(stackOf(WORLD, SOCIAL)), serverView(undefined, false));
    expect(quiet.stack, 'control: nothing arrives, Social stays').toEqual(stackOf(WORLD, SOCIAL));
    expect(quiet.commands).toEqual([]);
  });
});

// ==========================================================================================
// ctl-11a: accelerators are denied over server-owned frames, text entries and prompts (CTL11A.2)
// ==========================================================================================
//
// `acceleratorsDenied(stack)` is true exactly when the TOP frame is a text entry, a prompt, or a
// screen whose owner is the server (the dialogue and the battle screen). The world base, a battle
// base, a frame beneath the top and every player-owned screen (the menu included) never deny.
//
// The server-owned set is a HARD-CODED literal, never read from SCREEN_POLICY.

/** The two frame ids the server owns. HARD-CODED. */
const SERVER_OWNED: readonly FrameId[] = ['dialogueView', 'battleView'];

describe('context stack: the accelerator denial (ctl-11a, CTL11A.2)', () => {
  it('CTL11A-2-DENY-PREDICATE: only a top frame that is a text entry, a prompt or a server-owned screen (the dialogue, the battle screen) denies accelerators; both bases, a bare stack, every player screen (stamped or not) and any frame beneath the top do not; the stack is not mutated', () => {
    // WRONG IMPL KILLED: a predicate that denies the dialogue only (a typed J in the Name field would
    // open the Journal), one that reads every `drop` frame as server-owned (the menu, the box and
    // Social would deny their own accelerators and the one-key replace would die), one that forgets
    // the battle outcome screen (the player is told to press A, not J), a textEntry or prompt that
    // is let through, a denial keyed to ANY frame in the stack (a dialogue suspended under a menu
    // over a battle would lock every accelerator for good), one keyed to the base (a battle base
    // would deny at the bare battle), one that reads the frame's `kind` screen but ignores its id
    // (every screen denies), a stamped screen (overBattle) that reads differently from an
    // unstamped one, a Social frame treated as server-owned, and a predicate that mutates its input
    // or answers a truthy non-boolean.
    expect(SERVER_OWNED, 'ANTI-VACUITY: two server-owned frame ids').toHaveLength(2);

    // Both bases, bare: never denied.
    for (const base of [WORLD, battle('7'), battle('42')]) {
      expect(acceleratorsDenied(deepFrozen(stackOf(base))), `bare ${base.kind}`).toBe(false);
    }

    // Every frame id as the top screen, over both bases, plain and stamped: denied iff server-owned.
    let screens = 0;
    for (const id of FRAME_IDS) {
      const want = SERVER_OWNED.includes(id);
      expect(acceleratorsDenied(deepFrozen(stackOf(WORLD, screen(id)))), `world / ${id}`).toBe(
        want,
      );
      expect(
        acceleratorsDenied(deepFrozen(stackOf(battle('7'), screen(id)))),
        `battle / ${id}`,
      ).toBe(want);
      expect(
        acceleratorsDenied(deepFrozen(stackOf(battle('7'), stamped(id, '7')))),
        `stamped over a battle / ${id}`,
      ).toBe(want);
      expect(
        acceleratorsDenied(deepFrozen(stackOf(WORLD, screen('menuView'), screen(id)))),
        `over the menu / ${id}`,
      ).toBe(want);
      screens += 4;
    }
    expect(screens, 'ANTI-VACUITY: every frame id over four shapes').toBe(FRAME_IDS.length * 4);
    expect(
      FRAME_IDS.filter((id) => acceleratorsDenied(deepFrozen(stackOf(WORLD, screen(id))))),
      'exactly the dialogue and the battle screen deny',
    ).toEqual(FRAME_IDS.filter((id) => SERVER_OWNED.includes(id)));

    // A text entry or a prompt on top denies, whichever frame it belongs to and whatever the base.
    for (const id of FRAME_IDS) {
      for (const base of [WORLD, battle('7')]) {
        expect(
          acceleratorsDenied(deepFrozen(stackOf(base, textEntry(id)))),
          `${base.kind} / textEntry(${id})`,
        ).toBe(true);
        expect(
          acceleratorsDenied(deepFrozen(stackOf(base, prompt(id)))),
          `${base.kind} / prompt(${id})`,
        ).toBe(true);
        expect(
          acceleratorsDenied(deepFrozen(stackOf(base, screen(id), textEntry(id)))),
          `${base.kind} / screen(${id}) under its own textEntry`,
        ).toBe(true);
        expect(
          acceleratorsDenied(deepFrozen(stackOf(base, screen('menuView'), prompt(id)))),
          `${base.kind} / menu under prompt(${id})`,
        ).toBe(true);
      }
    }

    // Only the TOP frame decides.
    const beneath: ReadonlyArray<{
      readonly name: string;
      readonly stack: Stack;
      readonly deny: boolean;
    }> = [
      {
        name: 'a dialogue suspended under a stamped menu over a battle',
        stack: stackOf(battle('7'), screen('dialogueView'), stamped('menuView', '7')),
        deny: false,
      },
      {
        name: 'the battle outcome under the menu',
        stack: stackOf(WORLD, screen('battleView'), screen('menuView')),
        deny: false,
      },
      {
        name: 'a text entry under a player screen',
        stack: stackOf(WORLD, textEntry(RENAME), screen('helpView')),
        deny: false,
      },
      {
        name: 'a prompt under a player screen',
        stack: stackOf(WORLD, screen(PVP), prompt(PVP), screen('menuView')),
        deny: false,
      },
      {
        name: 'a player screen under a dialogue',
        stack: stackOf(battle('7'), screen('menuView'), screen('dialogueView')),
        deny: true,
      },
      {
        name: 'a player screen under a prompt under nothing else',
        stack: stackOf(WORLD, screen(BOX), prompt(PVP)),
        deny: true,
      },
      {
        name: 'two player screens under a text entry',
        stack: stackOf(WORLD, screen('menuView'), screen(BOX), textEntry(BOX)),
        deny: true,
      },
    ];
    for (const row of beneath) {
      expect(acceleratorsDenied(deepFrozen(row.stack)), row.name).toBe(row.deny);
    }

    // Property: the answer is the top frame's kind-and-owner rule, whatever sits beneath it.
    const frameArb: fc.Arbitrary<UpperFrame> = fc.oneof(
      fc.constantFrom(...FRAME_IDS).map(screen),
      fc.constantFrom(...FRAME_IDS).map(prompt),
      fc.constantFrom(...FRAME_IDS).map(textEntry),
      fc.constantFrom(...FRAME_IDS).map((id) => stamped(id, '7')),
    );
    const baseArb: fc.Arbitrary<BaseFrame> = fc.constantFrom(WORLD, battle('1'), battle('7'));
    let denials = 0;
    let passes = 0;
    fc.assert(
      fc.property(baseArb, fc.array(frameArb, { maxLength: 6 }), (base, frames) => {
        const top = frames.at(-1);
        const expected =
          top !== undefined &&
          (top.kind !== 'screen' || SERVER_OWNED.includes((top as { id: FrameId }).id));
        const got = acceleratorsDenied(deepFrozen(stackOf(base, ...frames)));
        expect(got).toBe(expected);
        if (expected) denials += 1;
        else passes += 1;
      }),
      { numRuns: 400 },
    );
    expect(denials, 'ANTI-VACUITY: many generated stacks denied').toBeGreaterThan(50);
    expect(passes, 'ANTI-VACUITY: many generated stacks passed').toBeGreaterThan(50);
  });
});
