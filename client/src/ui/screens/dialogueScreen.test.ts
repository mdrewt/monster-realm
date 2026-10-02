// ui/screens/dialogueScreen.test.ts — ctl-8a (CTL8A.1): the dialogue frame's pure adapter.
//
// Node env, no DOM. `dialogueScreen` is driven only through its public surface: `viewModel(ctx)`,
// `init(vm)`, `onButton(vm, state, btn)`, `observe(vm, state, now)` and `paint(view, vm, state)`
// into a recording fake view. The context is a fake store with exactly the three reads the plan's
// view model makes (`ownConversation`, `allNpcs`, `ongoingBattle`), and the content is the shipped
// `DIALOGUE_TREES` (the Elder Oak's one-choice greeting; the shopkeeper's Leave + Shop). Cases that
// need more choices than the bundle has build the view model literally. Time is always explicit:
// `vm.now` (what `ctx.now()` returned) and observe's `now`; no case reads a real clock.
//
// The cursor is read through `paint` (`{ active, revealStart }`), never off the state's nav keys.
//
// The contract (plan §1, CTL8A.1):
//   reveal    a node the frame has not keyed yet starts a reveal at the `now` that keys it (none
//             under reduced motion); it runs while `vm.now - revealStart < DIALOGUE_REVEAL_MS`. A
//             finishes it and does nothing else; B is never gated by it.
//   list      the choices, then the shop action, are ONE list: a fresh Up/Down wraps, a repeat
//             clamps. A acts on the cursor: a choice advances with its idx, the shop action picks
//             the shop, a leaf (no items) dismisses.
//   keying    observe answers the SAME state for the same node and a new one (first item, new
//             reveal) for another; init is unkeyed.
//   resend    A is swallowed for DIALOGUE_RESEND_MS after it issued a command for this node.
//   re-push   a fresh init state's first A only keys and paints the frame.
//   battle    in an ongoing battle B, Start and Select are answered, everything else is
//             'unhandled'.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type { StoreNpcRow, StorePlayerConversation } from '../../net/store';
import { DIALOGUE_TREES } from '../dialogueContent';
import { buildDialogueViewModel, type DialogueViewModel } from '../dialogueModel';
import type { DialoguePaint, DialogueView } from '../dialogueView';
import {
  DIALOGUE_RESEND_MS,
  DIALOGUE_REVEAL_MS,
  type DialogueScreenState,
  type DialogueScreenVm,
  dialogueScreen,
} from './dialogueScreen';
import type { ButtonStep, ScreenContext, ScreenResult } from './types';

const ME = 'ab'.repeat(32);
const R = DIALOGUE_REVEAL_MS;

function npc(
  entityId: bigint,
  npcId: string,
  dialogueTreeId: string,
  interaction: StoreNpcRow['interaction'],
): StoreNpcRow {
  return {
    entityId,
    npcId,
    zoneId: 1,
    homeX: 4,
    homeY: 6,
    wanderRadius: 0,
    dialogueTreeId,
    interaction,
  };
}

/** The Elder Oak (plain dialogue) and two shopkeepers whose greeting carries the shop action, one
 *  of them for shop 0. */
const OAK = npc(11n, 'elder_oak', 'elder_oak_talk', { kind: 'dialogue' });
const KEEPER_0 = npc(12n, 'keeper_zero', 'shopkeeper_greeting', { kind: 'shop', shopId: 0 });
const KEEPER_5 = npc(13n, 'keeper_five', 'shopkeeper_greeting', { kind: 'shop', shopId: 5 });
const NPCS: readonly StoreNpcRow[] = [OAK, KEEPER_0, KEEPER_5];

const talk = (who: StoreNpcRow, currentNodeId = 'greeting'): StorePlayerConversation => ({
  ownerIdentity: ME,
  npcEntityId: who.entityId,
  currentNodeId,
});

/** What the fake store holds; a case edits it between view models as a batch would. */
interface World {
  conv: StorePlayerConversation | undefined;
  battle: boolean;
}

/** The battle row the fake store reports for the player while `battle` is set. */
const ONGOING = { battleId: 9n, playerIdentity: ME, outcome: 'Ongoing' };

function ctxOf(world: World, now: number, reduceMotion: boolean): ScreenContext {
  const store = {
    ownConversation: (owner: string) => (owner === ME ? world.conv : undefined),
    allNpcs: () => [...NPCS],
    ongoingBattle: (identity: string) => (world.battle && identity === ME ? ONGOING : undefined),
  };
  return {
    store,
    identity: ME,
    bindings: DEFAULT_BINDINGS,
    now: () => now,
    shopId: null,
    healLocationId: null,
    reduceMotion,
  } as unknown as ScreenContext;
}

const vmAt = (world: World, now: number, reduceMotion = false): DialogueScreenVm =>
  dialogueScreen.viewModel(ctxOf(world, now, reduceMotion));

/** A view model built literally: `choices` choices, then the shop action when `shopId` is set. */
function litVm(choices: number, shopId: number | null, now: number): DialogueScreenVm {
  const dialogue: DialogueViewModel = {
    npcName: 'Rowan',
    nodeText: 'Welcome, traveller.',
    choices: Array.from({ length: choices }, (_, idx) => ({ text: `Choice ${idx}`, idx })),
    canDismiss: true,
    shopAction: shopId === null ? null : { shopId },
  };
  return { dialogue, nodeKey: 'literal:node', now, reduceMotion: false, inBattle: false };
}

const press = (
  vm: DialogueScreenVm,
  state: DialogueScreenState,
  button: VButton,
  repeat = false,
): ButtonStep<DialogueScreenState> => dialogueScreen.onButton(vm, state, { button, repeat });

function observe(vm: DialogueScreenVm, state: DialogueScreenState, now: number) {
  if (dialogueScreen.observe === undefined) throw new Error('dialogueScreen must define observe');
  return dialogueScreen.observe(vm, state, now);
}

/** A frame whose open was observed `R` ms before `vm.now`: keyed, its reveal over. */
const ready = (vm: DialogueScreenVm): DialogueScreenState =>
  observe(vm, dialogueScreen.init(vm), vm.now - R);

/** Every paint `paint(view, vm, state)` hands the view. */
function painted(vm: DialogueScreenVm, state: DialogueScreenState): DialoguePaint[] {
  const out: DialoguePaint[] = [];
  const view = {
    paint: (p: DialoguePaint) => {
      out.push(p);
    },
  } as unknown as DialogueView;
  if (dialogueScreen.paint === undefined) throw new Error('dialogueScreen must define paint');
  dialogueScreen.paint(view, vm, state);
  return out;
}

/** The painted cursor: a choice idx, 'shop', or null. */
function cursorOf(vm: DialogueScreenVm, state: DialogueScreenState): DialoguePaint['active'] {
  const p = painted(vm, state);
  expect(p, 'exactly one paint').toHaveLength(1);
  return (p[0] as DialoguePaint).active;
}

const advance = (choiceIdx: number): ScreenResult => ({ kind: 'advanceDialogue', choiceIdx });
const pick = (shopId: number): ScreenResult => ({ kind: 'pickShop', shopId });
const DISMISS: ScreenResult = { kind: 'dismissDialogue' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

describe('dialogueScreen — the reveal (ctl-8a, CTL8A.1)', () => {
  it('CTL8A-1-REVEAL-A: A during the reveal finishes it and issues nothing; the next A advances with the cursor`s choiceIdx, dismisses on a leaf and picks the shop on the shop action; the reveal ends by itself at DIALOGUE_REVEAL_MS, not a millisecond before', () => {
    // WRONG IMPL KILLED: an A that advances mid-reveal (the player skips text they never read),
    // one that finishes the reveal AND advances in one press, a finishing A that moves the cursor;
    // an advance that always sends choiceIdx 0 (or the list position of the shop action); a leaf
    // that sends advanceDialogue (the server refuses a choice on a node with none) or nothing (A
    // could never end the talk); a shop action that advances instead of picking; and a reveal
    // that ends early, a millisecond late (`<=`), or never without a press.
    expect(R, 'fixture: a positive reveal length').toBeGreaterThan(0);
    const T0 = 10_000;

    // The shipped Elder Oak greeting: one choice. The observe that follows the open keys it.
    const world: World = { conv: talk(OAK), battle: false };
    const opened = observe(vmAt(world, T0), dialogueScreen.init(vmAt(world, T0)), T0);
    expect(painted(vmAt(world, T0), opened), 'a running reveal on the first choice').toEqual([
      { active: 0, revealStart: T0 },
    ]);

    const early = vmAt(world, T0 + 10);
    const finish = press(early, opened, 'A');
    expect(finish.result, 'A mid-reveal issues nothing').toBe('consumed');
    expect(painted(early, finish.state), 'the reveal is finished, the cursor unmoved').toEqual([
      { active: 0, revealStart: null },
    ]);
    expect(press(vmAt(world, T0 + 20), finish.state, 'A').result, 'the next A advances').toEqual(
      advance(0),
    );

    // Both sides of the boundary, from the same observed state.
    expect(
      press(vmAt(world, T0 + R - 1), opened, 'A').result,
      'a millisecond before the end the reveal is still running',
    ).toBe('consumed');
    expect(
      press(vmAt(world, T0 + R), opened, 'A').result,
      'at DIALOGUE_REVEAL_MS the reveal is over without any press',
    ).toEqual(advance(0));

    // The cursor's choiceIdx: three choices, the cursor moved to the third.
    const three = litVm(3, null, T0);
    let s = ready(three);
    s = press(three, s, 'Down').state;
    s = press(three, s, 'Down').state;
    expect(cursorOf(three, s)).toBe(2);
    expect(press(three, s, 'A').result, 'A advances with the cursor`s idx').toEqual(advance(2));

    // A leaf: a node the bundled tree does not have (no choices and, for the Oak, no shop).
    const leafWorld: World = { conv: talk(OAK, 'farewell'), battle: false };
    const leaf = vmAt(leafWorld, T0 + R);
    expect(leaf.dialogue?.choices, 'fixture: the leaf has no choices').toEqual([]);
    expect(leaf.dialogue?.shopAction, 'fixture: and no shop action').toBeNull();
    const leafOpen = observe(leaf, dialogueScreen.init(leaf), T0);
    expect(painted(leaf, leafOpen), 'a leaf has no cursor').toEqual([
      { active: null, revealStart: T0 },
    ]);
    expect(press(leaf, leafOpen, 'A').result, 'A on a leaf ends the talk').toEqual(DISMISS);
    expect(
      press(vmAt(leafWorld, T0 + 1), leafOpen, 'A').result,
      'and is reveal-gated like any A',
    ).toBe('consumed');

    // The shop action, after the choices.
    const shop = litVm(2, 5, T0);
    const onShop = press(shop, ready(shop), 'Up').state;
    expect(cursorOf(shop, onShop), 'fixture: Up from the first item is the shop action').toBe(
      'shop',
    );
    expect(press(shop, onShop, 'A').result).toEqual(pick(5));
  });

  it('CTL8A-1-REVEAL-B: B issues dismissDialogue at once, mid-reveal or not, on a choice, a leaf or the shop action, and leaves the state revealed; with no dialogue shown B, A and the D-pad are swallowed', () => {
    // WRONG IMPL KILLED: a B gated on the reveal like A (main.controls pins B dismissing 100 ms
    // after the batch, inside any reveal); a B that only finishes the reveal and needs a second
    // press; a B that pops the frame instead of ending the talk (the server row would survive and
    // the next batch reopen the frame); a B that leaves the reveal running; and a B or A that
    // sends a command with no conversation to act on.
    const T0 = 20_000;
    const world: World = { conv: talk(KEEPER_5), battle: false };
    const opened = observe(vmAt(world, T0), dialogueScreen.init(vmAt(world, T0)), T0);

    const mid = vmAt(world, T0 + 1);
    const b = press(mid, opened, 'B');
    expect(b.result, 'B mid-reveal ends the talk at once').toEqual(DISMISS);
    expect(painted(mid, b.state), 'and leaves the state revealed').toEqual([
      { active: 0, revealStart: null },
    ]);

    const after = vmAt(world, T0 + R + 1);
    expect(press(after, opened, 'B').result, 'B after the reveal').toEqual(DISMISS);
    const onShop = press(after, opened, 'Down').state;
    expect(cursorOf(after, onShop), 'fixture: the cursor on the shop action').toBe('shop');
    expect(press(after, onShop, 'B').result, 'B on the shop action').toEqual(DISMISS);

    const leafWorld: World = { conv: talk(OAK, 'farewell'), battle: false };
    const leaf = vmAt(leafWorld, T0 + 2);
    expect(
      press(leaf, observe(leaf, dialogueScreen.init(leaf), T0), 'B').result,
      'B on a leaf',
    ).toEqual(DISMISS);

    // No dialogue shown (the conversation row is gone, the frame not yet closed).
    const none = vmAt({ conv: undefined, battle: false }, T0);
    expect(none.dialogue, 'fixture: no dialogue').toBeNull();
    const idle = observe(none, dialogueScreen.init(none), T0);
    for (const button of ['B', 'A', 'Up', 'Down', 'Left', 'Right'] as const) {
      expect(press(none, idle, button).result, `${button} with no dialogue`).toBe('consumed');
    }
  });
});

describe('dialogueScreen — the list and reduced motion (ctl-8a, CTL8A.1)', () => {
  it('CTL8A-1-NAV-WRAP: the choices and the shop action are ONE nav-capable list: a fresh Down from the last lands on the first and a fresh Up from the first on the last, a repeat clamps at both ends and still moves in between, Left and Right are swallowed without moving, a repeat A acts on nothing; the shipped shopkeeper greeting wraps between Leave and Shop', () => {
    // WRONG IMPL KILLED: the shop action kept out of the list (Down never reaches it); two lists
    // (the shop action reachable only from the last choice); a list that clamps on a fresh press
    // or wraps on a repeat (a held arrow would spin round the choices); Left/Right moving the
    // cursor or left to the page; a repeat A that advances; and an adapter without its nav mark
    // (the router would keep the D-pad for walking under the open talk).
    expect(dialogueScreen.nav, 'the frame takes the D-pad').toBe(true);
    const vm = litVm(3, 4, 50_000);
    const first = ready(vm);
    expect(cursorOf(vm, first), 'the list starts on the first choice').toBe(0);

    let s = first;
    const seen: Array<DialoguePaint['active']> = [];
    for (let i = 0; i < 4; i += 1) {
      const step = press(vm, s, 'Down');
      expect(step.result, `Down ${i + 1} is swallowed`).toBe('consumed');
      s = step.state;
      seen.push(cursorOf(vm, s));
    }
    expect(seen, 'four Downs visit every item and wrap to the first').toEqual([1, 2, 'shop', 0]);
    const up = press(vm, first, 'Up');
    expect(up.result).toBe('consumed');
    expect(cursorOf(vm, up.state), 'a fresh Up from the first wraps to the last').toBe('shop');

    const repeatDown = press(vm, up.state, 'Down', true);
    expect(repeatDown.result).toBe('consumed');
    expect(cursorOf(vm, repeatDown.state), 'a repeat Down at the last stays').toBe('shop');
    expect(cursorOf(vm, press(vm, first, 'Up', true).state), 'a repeat Up at the first stays').toBe(
      0,
    );
    expect(cursorOf(vm, press(vm, first, 'Down', true).state), 'a repeat in between moves').toBe(1);

    for (const button of ['Left', 'Right'] as const) {
      for (const repeat of [false, true]) {
        const step = press(vm, up.state, button, repeat);
        expect(step.result, `${button}${repeat ? ' (repeat)' : ''}`).toBe('consumed');
        expect(cursorOf(vm, step.state), `${button} does not move`).toBe('shop');
      }
    }
    expect(press(vm, up.state, 'A', true).result, 'a repeat A acts on nothing').toBe('consumed');
    expect(press(vm, up.state, 'A').result, 'control: a fresh A picks the shop').toEqual(pick(4));

    // The shipped shopkeeper greeting: Leave, then Shop.
    const world: World = { conv: talk(KEEPER_5), battle: false };
    const keeper = vmAt(world, 70_000);
    let k = ready(keeper);
    expect(cursorOf(keeper, k)).toBe(0);
    k = press(keeper, k, 'Down').state;
    expect(cursorOf(keeper, k)).toBe('shop');
    k = press(keeper, k, 'Down').state;
    expect(cursorOf(keeper, k), 'Down from Shop wraps to Leave').toBe(0);
    k = press(keeper, k, 'Up').state;
    expect(cursorOf(keeper, k), 'Up from Leave wraps to Shop').toBe('shop');
    expect(press(keeper, k, 'A').result).toEqual(pick(5));
  });

  it('CTL8A-1-REDUCED-MOTION: under reduced motion a node starts revealed: the view model carries ctx.reduceMotion, the observe that opens the node paints no reveal and the very first A acts; a node a batch replaces starts revealed too', () => {
    // WRONG IMPL KILLED: a reveal that ignores the OS preference (a reduced-motion player needs
    // two presses per node and still gets the wipe class), a view model that drops or inverts
    // ctx.reduceMotion, and a preference honoured at the open but not when a batch replaces the
    // node.
    const T = 30_000;
    const world: World = { conv: talk(OAK), battle: false };
    const calm = vmAt(world, T, true);
    expect(calm.reduceMotion, 'the view model carries the preference').toBe(true);
    expect(vmAt(world, T, false).reduceMotion).toBe(false);

    const opened = observe(calm, dialogueScreen.init(calm), T);
    expect(painted(calm, opened), 'no reveal is painted').toEqual([
      { active: 0, revealStart: null },
    ]);
    expect(press(calm, opened, 'A').result, 'the first A acts at once').toEqual(advance(0));

    const moving = vmAt(world, T, false);
    expect(
      press(moving, observe(moving, dialogueScreen.init(moving), T), 'A').result,
      'contrast: with motion the same first A only finishes the reveal',
    ).toBe('consumed');

    // A batch replaces the node: the new one starts revealed as well.
    world.conv = talk(KEEPER_0);
    const next = vmAt(world, T + 5, true);
    const rekeyed = observe(next, opened, T + 5);
    expect(rekeyed, 'a new node is a new state').not.toBe(opened);
    expect(painted(next, rekeyed)).toEqual([{ active: 0, revealStart: null }]);
    expect(press(next, rekeyed, 'A').result).toEqual(advance(0));
  });
});

describe('dialogueScreen — keying and observe (ctl-8a, CTL8A.1)', () => {
  it('CTL8A-1-OBSERVE-REKEY: the view model reads the player`s own conversation; init is unkeyed, so the first observe after an open answers a new state; the same node answers the SAME state object, cursor kept, whatever the view model object; another node or another npc answers a new state whose reveal starts at observe`s now with the cursor on the first item; with no dialogue paint draws nothing', () => {
    // WRONG IMPL KILLED: an observe that answers a new object every batch (the frame repaints and
    // restarts its reveal at batch rate); one that never re-keys (a node the server replaced keeps
    // the old cursor and shows no reveal, so the player's next A acts on text they never read); a
    // key on the node id alone (two npcs' 'greeting' nodes collide) or on the npc alone; a reveal
    // stamped with the view model's clock instead of observe's; a re-key that keeps the old cursor;
    // an init keyed already (the open's observe would not paint); a view model that is not the
    // dialogue model's; and a paint that draws a cursor with no dialogue.
    const world: World = { conv: talk(KEEPER_5), battle: false };
    const vm1 = vmAt(world, 1_000);
    expect(vm1.dialogue, 'the dialogue model of the player`s own conversation').toEqual(
      buildDialogueViewModel(world.conv, new Map(NPCS.map((n) => [n.entityId, n])), DIALOGUE_TREES),
    );
    expect(vm1.now, 'the view model carries ctx.now()').toBe(1_000);
    expect(typeof vm1.nodeKey, 'a node is keyed').toBe('string');
    expect(vmAt(world, 1_777).nodeKey, 'the same node, the same key').toBe(vm1.nodeKey);

    const s0 = dialogueScreen.init(vm1);
    const s1 = observe(vm1, s0, 1_000);
    expect(s1, 'the open`s observe keys the unkeyed init state').not.toBe(s0);
    expect(painted(vm1, s1)).toEqual([{ active: 0, revealStart: 1_000 }]);
    expect(observe(vmAt(world, 1_050), s1, 1_050), 'the same node: the same object').toBe(s1);

    const moved = press(vmAt(world, 1_000 + R), s1, 'Down').state;
    const later = vmAt(world, 1_000 + R + 5);
    expect(observe(later, moved, 1_000 + R + 5), 'the cursor survives a batch').toBe(moved);
    expect(painted(later, moved), 'and the reveal is not restarted').toEqual([
      { active: 'shop', revealStart: 1_000 },
    ]);

    // Another npc on a node with the same id: a new key, a new state on the first item, its
    // reveal stamped with observe's `now` (the view model's clock reads 40 ms earlier).
    world.conv = talk(OAK);
    const oak = vmAt(world, 2_000 - 40);
    expect(oak.nodeKey, 'another npc, another key').not.toBe(vm1.nodeKey);
    const s2 = observe(oak, moved, 2_000);
    expect(s2).not.toBe(moved);
    expect(painted(oak, s2)).toEqual([{ active: 0, revealStart: 2_000 }]);

    // Another node of the same npc.
    world.conv = talk(OAK, 'farewell');
    const leaf = vmAt(world, 3_000);
    expect(leaf.nodeKey, 'another node, another key').not.toBe(oak.nodeKey);
    const s3 = observe(leaf, s2, 3_000);
    expect(s3).not.toBe(s2);
    expect(painted(leaf, s3)).toEqual([{ active: null, revealStart: 3_000 }]);

    // No conversation: no dialogue, no key, nothing painted; unchanged after that.
    world.conv = undefined;
    const none = vmAt(world, 4_000);
    expect(none.dialogue).toBeNull();
    expect(none.nodeKey).toBeNull();
    const s4 = observe(none, s3, 4_000);
    expect(s4, 'the talk went away: a new state').not.toBe(s3);
    expect(painted(none, s4), 'nothing is painted with no dialogue').toEqual([]);
    expect(observe(none, s4, 4_100), 'and nothing changes after that').toBe(s4);
    const unkeyed = dialogueScreen.init(none);
    expect(observe(none, unkeyed, 4_200), 'an init with no dialogue has nothing to key').toBe(
      unkeyed,
    );

    // The conversation comes back: it starts over.
    world.conv = talk(KEEPER_5);
    const back = vmAt(world, 5_000);
    const s5 = observe(back, s4, 5_000);
    expect(s5).not.toBe(s4);
    expect(painted(back, s5)).toEqual([{ active: 0, revealStart: 5_000 }]);
  });

  it('CTL8A-1-BATTLE-UNHANDLED: while the player is in an ongoing battle A, X, Y, LB, RB and the D-pad (fresh or repeat) are unhandled, B still dismisses (mid-reveal too), Start pops to the base and Select toggles help; out of battle the same frame answers A, the D-pad and B itself and leaves X, Y, LB and RB unhandled', () => {
    // WRONG IMPL KILLED: an A that keeps acting under a battle (each press would raise a battle
    // refusal through dispatch); a D-pad swallowed by the suspended dialogue (the battle under it
    // owns the arrows); a B lost in battle (the talk could not be ended); Start or Select that
    // change meaning; inBattle read off another identity or never read; and the reverse, a frame
    // that answers 'unhandled' out of battle too.
    const T = 40_000;
    const world: World = { conv: talk(KEEPER_5), battle: true };
    const vm = vmAt(world, T);
    expect(vm.inBattle, 'the view model reads the player`s ongoing battle').toBe(true);
    const revealing = observe(vm, dialogueScreen.init(vm), T - 5);
    for (const button of ['A', 'X', 'Y', 'LB', 'RB', 'Up', 'Down', 'Left', 'Right'] as const) {
      expect(press(vm, revealing, button).result, `${button} in battle`).toBe('unhandled');
    }
    for (const button of ['Up', 'Down', 'Left', 'Right'] as const) {
      expect(press(vm, revealing, button, true).result, `${button} (repeat) in battle`).toBe(
        'unhandled',
      );
    }
    expect(press(vm, revealing, 'B').result, 'B ends the talk in battle, mid-reveal').toEqual(
      DISMISS,
    );
    expect(press(vm, revealing, 'Start').result).toEqual(POP_TO_BASE);
    expect(press(vm, revealing, 'Select').result).toEqual(TOGGLE_HELP);

    world.battle = false;
    const calm = vmAt(world, T);
    expect(calm.inBattle).toBe(false);
    const s = ready(calm);
    expect(press(calm, s, 'A').result, 'out of battle A acts').toEqual(advance(0));
    for (const button of ['Up', 'Down', 'Left', 'Right'] as const) {
      expect(press(calm, s, button).result, `${button} out of battle`).toBe('consumed');
    }
    for (const button of ['X', 'Y', 'LB', 'RB'] as const) {
      expect(press(calm, s, button).result, `${button} has no use here`).toBe('unhandled');
    }
    expect(press(calm, s, 'B').result).toEqual(DISMISS);
    expect(press(calm, s, 'Start').result).toEqual(POP_TO_BASE);
    expect(press(calm, s, 'Select').result).toEqual(TOGGLE_HELP);
  });

  it('CTL8A-1-NO-DOUBLE-SEND: a second A within DIALOGUE_RESEND_MS of an A-issued command (an advance, a dismiss or a shop pick) is swallowed, even after a cursor move; an A at DIALOGUE_RESEND_MS acts again; B is never swallowed; a new node lifts the guard once its reveal is done', () => {
    // WRONG IMPL KILLED: no guard (a double-tap inside the server round trip lands the second A on
    // the NEXT node: a choice the player never saw); a guard that never expires (a refused advance
    // leaves A dead); one measured with `<=`; one that also swallows B (the talk could not be
    // ended inside the window); one lifted by a cursor move; one that only guards
    // advanceDialogue (a leaf's dismiss or the shop pick double-sends); and a guard carried over
    // to the next node (its first A after the reveal would be lost).
    const W = DIALOGUE_RESEND_MS;
    expect(1 + R, 'fixture: a new node`s reveal ends inside the old resend window').toBeLessThan(W);
    const T = 60_000;
    const world: World = { conv: talk(KEEPER_5), battle: false };
    const at = (now: number): DialogueScreenVm => vmAt(world, now);

    const sent = press(at(T), ready(at(T)), 'A');
    expect(sent.result, 'the first A advances').toEqual(advance(0));
    expect(press(at(T + 1), sent.state, 'A').result, 'a second A at once').toBe('consumed');
    expect(press(at(T + W - 1), sent.state, 'A').result, 'a millisecond short').toBe('consumed');
    expect(press(at(T + W), sent.state, 'A').result, 'at DIALOGUE_RESEND_MS').toEqual(advance(0));
    expect(press(at(T + 1), sent.state, 'B').result, 'B is never swallowed').toEqual(DISMISS);

    const moved = press(at(T + 2), sent.state, 'Down').state;
    expect(cursorOf(at(T + 2), moved), 'fixture: on the shop action').toBe('shop');
    expect(press(at(T + 3), moved, 'A').result, 'a cursor move lifts nothing').toBe('consumed');
    const picked = press(at(T + W), moved, 'A');
    expect(picked.result).toEqual(pick(5));
    expect(press(at(T + W + 1), picked.state, 'A').result, 'the shop pick arms it too').toBe(
      'consumed',
    );

    const leafWorld: World = { conv: talk(OAK, 'farewell'), battle: false };
    const leaf = vmAt(leafWorld, T);
    const dismissed = press(leaf, ready(leaf), 'A');
    expect(dismissed.result).toEqual(DISMISS);
    expect(
      press(vmAt(leafWorld, T + 1), dismissed.state, 'A').result,
      'a leaf`s dismiss arms it too',
    ).toBe('consumed');

    // The server moves to a new node inside the window: once its reveal is done, A acts.
    world.conv = talk(OAK);
    const next = observe(at(T + 1), sent.state, T + 1);
    expect(next, 'a new node is a new state').not.toBe(sent.state);
    expect(press(at(T + 1 + R), next, 'A').result, 'the new node`s first A acts').toEqual(
      advance(0),
    );
  });

  it('CTL8A-1-REPUSH-FIRST-A: a re-pushed frame (a fresh init state whose first event is an A, no batch between) answers consumed and paints the fresh cursor on the first item, reduced motion or not; it never acts on the cursor the frame had before; the next A acts on what was painted; B on a fresh state still dismisses', () => {
    // WRONG IMPL KILLED: a first A that acts on a state that was never painted (it would pick the
    // shop the player had moved to before Start re-pushed the frame, or advance under a cursor
    // they cannot see); a re-push that keeps the old cursor or the old reveal; the re-key skipped
    // under reduced motion (the re-key comes before the reveal check); and a re-keying press that
    // also swallows B.
    const T = 80_000;
    const world: World = { conv: talk(KEEPER_5), battle: false };
    const vm = vmAt(world, T);
    const before = press(vm, ready(vm), 'Down').state;
    expect(cursorOf(vm, before), 'fixture: before the re-push the cursor was on Shop').toBe('shop');

    for (const reduceMotion of [false, true]) {
      const label = reduceMotion ? 'reduced motion' : 'with motion';
      const v = vmAt(world, T + 100, reduceMotion);
      const first = press(v, dialogueScreen.init(v), 'A');
      expect(first.result, `${label}: the first A only keys the frame`).toBe('consumed');
      expect(painted(v, first.state), `${label}: the fresh cursor is painted`).toEqual([
        { active: 0, revealStart: reduceMotion ? null : T + 100 },
      ]);
      const after = vmAt(world, T + 100 + R, reduceMotion);
      expect(press(after, first.state, 'A').result, `${label}: the next A acts on Leave`).toEqual(
        advance(0),
      );
    }

    expect(press(vm, dialogueScreen.init(vm), 'B').result, 'B on a fresh state').toEqual(DISMISS);
  });

  it('CTL8A-1-SHOP-ZERO: on the shipped greeting of the shopkeeper of shop 0 the shop action is in the list, and A on it issues pickShop with shopId 0', () => {
    // WRONG IMPL KILLED: a shop action read by truthiness (`if (dialogue.shopAction?.shopId)`),
    // which drops shop 0 from the list or sends the Leave choice instead, and a pick that
    // defaults or coerces the id.
    const vm = vmAt({ conv: talk(KEEPER_0), battle: false }, 90_000);
    expect(vm.dialogue?.shopAction, 'fixture: the view model carries shop 0').toEqual({
      shopId: 0,
    });
    const down = press(vm, ready(vm), 'Down').state;
    expect(cursorOf(vm, down)).toBe('shop');
    expect(press(vm, down, 'A').result).toEqual(pick(0));
    const up = press(vm, ready(vm), 'Up').state;
    expect(cursorOf(vm, up), 'Up from Leave reaches it too').toBe('shop');
    expect(press(vm, up, 'A').result).toEqual(pick(0));
  });
});

describe('dialogueScreen — review-lens sync cases (ctl-8a, CTL8A.1)', () => {
  it('CTL8A-1-SYNC-RESEAT: with the node key unchanged, a cursor whose item vanished (the npc row`s shop action went away) is re-seated on the first item by observe (a new state) and by the next press; a null cursor over items that appeared is seated too; nothing changes when the items are the same', () => {
    // WRONG IMPL KILLED: a sync keyed on the node alone, so a cursor left on a vanished shop
    // action paints no cursor and A acts on an item that is not there (or on nothing); a press
    // that keeps the stale key because only observe re-seats; a leaf's null cursor that stays null
    // once choices arrive (the player could never pick one); and an observe that answers a new
    // object for a batch that left the items as they were. The press-side check uses Left (it
    // moves nothing), so what it reads is the re-seat alone.
    const T = 100_000;
    const withShop = litVm(3, 4, T);
    const onShop = press(withShop, ready(withShop), 'Up').state;
    expect(cursorOf(withShop, onShop), 'fixture: the cursor on the shop action').toBe('shop');
    expect(observe(litVm(3, 4, T), onShop, T), 'the same items: the same object').toBe(onShop);

    // Same node key, the shop action gone.
    const noShop = litVm(3, null, T);
    expect(noShop.nodeKey, 'fixture: the node key did not change').toBe(withShop.nodeKey);
    const reseated = observe(noShop, onShop, T);
    expect(reseated, 'the cursor`s item vanished: a new state').not.toBe(onShop);
    expect(cursorOf(noShop, reseated), 're-seated on the first item').toBe(0);
    expect(observe(noShop, reseated, T), 'unchanged since: the same object').toBe(reseated);
    const leftNoShop = press(noShop, onShop, 'Left');
    expect(leftNoShop.result).toBe('consumed');
    expect(
      cursorOf(noShop, leftNoShop.state),
      'a press with no observe between re-seats it too',
    ).toBe(0);

    // A leaf (no items) whose node gains two choices under the same key.
    const leaf = litVm(0, null, T);
    const onLeaf = ready(leaf);
    expect(cursorOf(leaf, onLeaf), 'fixture: a leaf has no cursor').toBeNull();
    const two = litVm(2, null, T);
    const seated = observe(two, onLeaf, T);
    expect(seated, 'items appeared: a new state').not.toBe(onLeaf);
    expect(cursorOf(two, seated), 'seated on the first item').toBe(0);
    expect(
      cursorOf(two, press(two, onLeaf, 'Left').state),
      'a press with no observe between seats it too',
    ).toBe(0);
  });

  it('CTL8A-1-REDUCED-MOTION-RESEND: under reduced motion a node keyed right after an A-issued command swallows an A within DIALOGUE_RESEND_MS of the re-key and acts at DIALOGUE_RESEND_MS; with motion the reveal is the gate and the next node acts once it ends', () => {
    // WRONG IMPL KILLED: a resend guard lifted by every re-key, which under reduced motion (no
    // reveal to wait out) lets a double-tap of A land its second press on the NEXT node, a choice
    // the player never saw; a guard that never expires on the new node; and, with motion, a guard
    // carried over on top of the reveal (the new node's first A after the reveal would be lost).
    const W = DIALOGUE_RESEND_MS;
    expect(R, 'fixture: the reveal ends inside the resend window').toBeLessThan(W);
    const T = 110_000;

    const calm: DialogueScreenVm = { ...litVm(1, null, T), reduceMotion: true };
    const calmNext = (now: number): DialogueScreenVm => ({
      ...litVm(2, null, now),
      reduceMotion: true,
      nodeKey: 'literal:other',
    });
    const sent = press(calm, ready(calm), 'A');
    expect(sent.result, 'fixture: A advanced').toEqual(advance(0));
    const next = observe(calmNext(T), sent.state, T);
    expect(next, 'a new node is a new state').not.toBe(sent.state);
    expect(painted(calmNext(T), next), 'revealed at once, on the first item').toEqual([
      { active: 0, revealStart: null },
    ]);
    expect(press(calmNext(T + 1), next, 'A').result, 'an A right after the re-key').toBe(
      'consumed',
    );
    expect(press(calmNext(T + W - 1), next, 'A').result, 'a millisecond short').toBe('consumed');
    expect(press(calmNext(T + W), next, 'A').result, 'at DIALOGUE_RESEND_MS it acts').toEqual(
      advance(0),
    );

    // With motion: the reveal gates the new node, and nothing more.
    const moving = litVm(1, null, T);
    const sentMoving = press(moving, ready(moving), 'A');
    expect(sentMoving.result).toEqual(advance(0));
    const movingNext = (now: number): DialogueScreenVm => ({
      ...litVm(2, null, now),
      nodeKey: 'literal:other',
    });
    const nextMoving = observe(movingNext(T), sentMoving.state, T);
    expect(press(movingNext(T + 1), nextMoving, 'A').result, 'mid-reveal').toBe('consumed');
    expect(
      press(movingNext(T + R), nextMoving, 'A').result,
      'the reveal over, inside the old window: A acts',
    ).toEqual(advance(0));
  });
});
