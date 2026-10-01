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
  type Command,
  contextStep,
  type Edge,
  mirrorEdges,
  movementEnabled,
  SCREEN_POLICY,
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
