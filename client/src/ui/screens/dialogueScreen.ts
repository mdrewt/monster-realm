// ui/screens/dialogueScreen.ts — the dialogue frame as a pure screen over the nav kit (design §5,
// CTL8A.1). No DOM, SDK, module state or clock: the context's `now()` rides on the view model, the
// shell hands `observe` its clock, and `dialogueView.ts` paints what `paint` hands it.
//
// A conversation is server-owned: its node arrives and is replaced by store batches, so the state
// is KEYED on the node (`nodeKey`). `observe` re-keys it when a batch replaces the node and stamps
// the new reveal's start; `init` is unkeyed, so the observe that follows an open (or a re-push of a
// frame that never closed) always paints. The reveal itself is a class-driven animation in
// styles.css (`.is-revealing`, `DIALOGUE_REVEAL_MS` long): the state only knows when it began.
//
// The choices and then the greet-then-shop action form ONE wrapping list. A finishes a running
// reveal, then acts on the cursor: a choice advances, the shop action picks the shop, a leaf
// (no items) ends the talk. B ends the talk at once, whatever the reveal is doing. While the player
// is in an ongoing battle the frame is suspended under it and answers only B, Start and Select,
// so A raises no battle refusal per press.

import { DIALOGUE_TREES } from '../dialogueContent';
import type { DialogueViewModel } from '../dialogueModel';
import { buildDialogueViewModel } from '../dialogueModel';
import type { DialoguePaint, DialogueView } from '../dialogueView';
import { type ItemLayout, list, type NavState, navInit, navReconcile, navStep } from '../nav';
import type { ButtonStep, ScreenAdapter, ScreenContext, ScreenResult } from './types';

/** How long a node's text reveal runs. The same length as the `mr-reveal` animation in
 *  styles.css (`.is-revealing`): change both together. */
export const DIALOGUE_REVEAL_MS = 600;
/** How long after an A-issued command a second A is swallowed: a double tap inside the server
 *  round trip must not land on the next, unseen node. A refused command self-heals after it. */
export const DIALOGUE_RESEND_MS = 1000;

export interface DialogueScreenVm {
  readonly dialogue: DialogueViewModel | null;
  /** `${npcEntityId}:${nodeId}`; null with no conversation. */
  readonly nodeKey: string | null;
  /** `ctx.now()` when the view model was built. */
  readonly now: number;
  readonly reduceMotion: boolean;
  readonly inBattle: boolean;
}

export interface DialogueScreenState {
  /** The node this state belongs to; null until the first sync keys it. */
  readonly nodeKey: string | null;
  /** When the reveal began, on the shell's clock; null once it is finished or was never run. */
  readonly revealStart: number | null;
  /** The cursor over the choices, then the shop action. */
  readonly nav: NavState;
  /** When A last issued a command for this node; null before. */
  readonly sentAt: number | null;
}

const SHOP_KEY = 'shop';
const choiceKey = (idx: number): string => `c${idx}`;

/** The choices in order, then the shop action. Keys never collide: a choice is `c<idx>`. */
function layoutOf(dialogue: DialogueViewModel | null): ItemLayout {
  if (dialogue === null) return list([]);
  const items = dialogue.choices.map((c) => ({ key: choiceKey(c.idx), enabled: true }));
  if (dialogue.shopAction !== null) items.push({ key: SHOP_KEY, enabled: true });
  return list(items);
}

/** `state` if it belongs to the view model's node, else a fresh state for that node: the cursor
 *  on the first item and a reveal starting `now` (none under reduced motion or with no node). */
function sync(vm: DialogueScreenVm, state: DialogueScreenState, now: number): DialogueScreenState {
  const layout = layoutOf(vm.dialogue);
  if (state.nodeKey === vm.nodeKey) {
    // The same node, but its items may have changed under it (an npc row replaced): re-seat.
    const nav = navReconcile(layout, layout, state.nav);
    return nav === state.nav ? state : { ...state, nav };
  }
  return {
    nodeKey: vm.nodeKey,
    revealStart: vm.reduceMotion || vm.nodeKey === null ? null : now,
    nav: navInit(layout),
    // Under reduced motion the new node has no reveal to gate A, so a node that follows an
    // A-issued command keeps the resend guard from its arrival (a double tap must not land on it).
    sentAt: vm.reduceMotion && state.sentAt !== null ? now : null,
  };
}

const revealing = (vm: DialogueScreenVm, state: DialogueScreenState): boolean =>
  state.revealStart !== null && vm.now - state.revealStart < DIALOGUE_REVEAL_MS;

const finished = (state: DialogueScreenState): DialogueScreenState =>
  state.revealStart === null ? state : { ...state, revealStart: null };

/** What A does on the cursor once the text is shown; null with nothing to act on. */
function activate(dialogue: DialogueViewModel, item: string | null): ScreenResult | null {
  if (item === null) return { kind: 'dismissDialogue' }; // a leaf: no item at all
  if (item === SHOP_KEY) {
    return dialogue.shopAction === null
      ? null
      : { kind: 'pickShop', shopId: dialogue.shopAction.shopId };
  }
  const choice = dialogue.choices.find((c) => choiceKey(c.idx) === item);
  return choice === undefined ? null : { kind: 'advanceDialogue', choiceIdx: choice.idx };
}

export const dialogueScreen: ScreenAdapter<DialogueScreenVm, DialogueScreenState, DialogueView> = {
  nav: true,

  viewModel(ctx: ScreenContext): DialogueScreenVm {
    const conv = ctx.store.ownConversation(ctx.identity);
    // The npc map is built only while a conversation is open, as main.ts's batch listener does.
    const npcs = new Map(conv === undefined ? [] : ctx.store.allNpcs().map((n) => [n.entityId, n]));
    const dialogue = buildDialogueViewModel(conv, npcs, DIALOGUE_TREES);
    return {
      dialogue,
      nodeKey:
        dialogue === null || conv === undefined
          ? null
          : `${conv.npcEntityId}:${conv.currentNodeId}`,
      now: ctx.now(),
      reduceMotion: ctx.reduceMotion,
      inBattle: ctx.store.ongoingBattle(ctx.identity) !== undefined,
    };
  },

  /** Unkeyed on purpose: the first observe or step after an open keys the node and paints it. */
  init(): DialogueScreenState {
    return { nodeKey: null, revealStart: null, nav: navInit(list([])), sentAt: null };
  },

  onButton(vm, kept, btn): ButtonStep<DialogueScreenState> {
    const state = sync(vm, kept, vm.now);
    const rekeyed = state !== kept;
    const done = (result: ScreenResult): ButtonStep<DialogueScreenState> => ({ state, result });
    switch (btn.button) {
      case 'Start':
        return done(btn.repeat ? 'consumed' : { kind: 'popToBase' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      case 'B':
        // Ends the talk at once (battle-safe): the reveal is moot once the frame is closing.
        if (btn.repeat || vm.dialogue === null) return done('consumed');
        return { state: finished(state), result: { kind: 'dismissDialogue' } };
      default:
        break;
    }
    if (vm.inBattle) return done('unhandled');
    if (vm.dialogue === null) return done('consumed');
    switch (btn.button) {
      case 'Up':
      case 'Down':
      case 'Left':
      case 'Right': {
        const { state: nav } = navStep(layoutOf(vm.dialogue), state.nav, btn);
        return nav === state.nav
          ? done('consumed')
          : { state: { ...state, nav }, result: 'consumed' };
      }
      case 'A': {
        if (btn.repeat || rekeyed) return done('consumed'); // a re-keying press only paints
        if (revealing(vm, state)) return { state: finished(state), result: 'consumed' };
        if (state.sentAt !== null && vm.now - state.sentAt < DIALOGUE_RESEND_MS) {
          return done('consumed');
        }
        const result = activate(vm.dialogue, state.nav.item);
        if (result === null) return done('consumed');
        return { state: { ...state, sentAt: vm.now }, result };
      }
      default:
        return done('unhandled');
    }
  },

  observe: (vm, state, now) => sync(vm, state, now),

  paint(view, vm, state): void {
    if (vm.dialogue === null) return;
    const item = state.nav.item;
    let active: DialoguePaint['active'] = null;
    if (item === SHOP_KEY) active = 'shop';
    else if (item !== null) {
      active = vm.dialogue.choices.find((c) => choiceKey(c.idx) === item)?.idx ?? null;
    }
    view.paint({ active, revealStart: state.revealStart });
  },
};
