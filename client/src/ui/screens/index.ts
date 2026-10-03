// ui/screens/index.ts — the adapter table and the screen host (design §4, §12; CTL6B.1, CTL7C.2).
// The router hands a button to `ScreenHost.button`, which asks ONLY the top frame: the base's own
// rule (`baseButton`), the typing rule over a text-entry frame, or that screen's adapter fed its own
// view model and the state the host keeps for it. A store batch goes to `ScreenHost.observe`, which
// asks every open frame whose adapter observes. No DOM, SDK or module state: main.ts holds the
// one host, binds the stack and the context and runs the returned command.
import type { BaseFrame, FrameId, Stack, UpperFrame } from '../contextStack';
import type { NavInput } from '../nav';
import { dialogueScreen } from './dialogueScreen';
import { healScreen } from './healScreen';
import { legacyAdapter } from './legacyAdapter';
import { monstersScreen } from './monstersScreen';
import { shopScreen } from './shopScreen';
import type { ScreenAdapter, ScreenContext, ScreenResult } from './types';

export type ScreenAdapters = Readonly<Record<FrameId, ScreenAdapter<unknown, unknown>>>;

/** Total over every frame id, so a new overlay without an adapter fails client-typecheck. Every
 *  entry is the legacy adapter until its ctl-8 screen slice swaps it (ctl-8a: the dialogue, heal
 *  and shop frames; ctl-8b: the box frame, as Monsters). The trade, pvp and leaderboard overlays
 *  show as the one `social` frame (ctl-8s), so their own entries are never asked. */
export const SCREEN_ADAPTERS: ScreenAdapters = {
  battleView: legacyAdapter,
  boxView: monstersScreen,
  raisingView: legacyAdapter,
  evolutionView: legacyAdapter,
  dialogueView: dialogueScreen,
  questLogView: legacyAdapter,
  healView: healScreen,
  shopView: shopScreen,
  tradeView: legacyAdapter,
  pvpView: legacyAdapter,
  leaderboardView: legacyAdapter,
  renameView: legacyAdapter,
  tradeProposeView: legacyAdapter,
  helpView: legacyAdapter,
  menuView: legacyAdapter,
  claimView: legacyAdapter,
  privacyView: legacyAdapter,
  social: legacyAdapter,
};

/** A button with nothing above the base. Start opens the menu at the world and does nothing on a
 *  battle (B17: an ongoing battle is never hidden; ctl-6c gives it the menu). B is swallowed: its
 *  world meaning (dismiss the top notice) has no notice to act on yet. */
export function baseButton(base: BaseFrame, btn: NavInput): ScreenResult {
  switch (btn.button) {
    case 'Start':
      return base.kind === 'world' ? { kind: 'openMenu' } : 'consumed';
    case 'Select':
      return { kind: 'toggleHelp' };
    case 'B':
      return 'consumed';
    default:
      return 'unhandled';
  }
}

/** The shell's side of the adapter seam (CTL7C.2): one adapter state per frame id, kept from the
 *  frame's first step or observe until it opens again, and the view each state is painted into.
 *  For an adapter that opts in (`remember`, CTL8S.1) it also keeps the state the frame last closed
 *  with, and hands it to the next `init`. */
export class ScreenHost {
  readonly #states = new Map<FrameId, unknown>();
  readonly #remembered = new Map<FrameId, unknown>();
  readonly #adapters: ScreenAdapters;
  readonly #viewOf: (id: FrameId) => unknown;
  readonly #onPaintError: (err: unknown) => void;

  /** `viewOf` lends a frame's view instance (undefined until it is built); `onPaintError` takes
   *  what a view's paint throws. */
  constructor(
    adapters: ScreenAdapters,
    viewOf: (id: FrameId) => unknown,
    onPaintError: (err: unknown) => void,
  ) {
    this.#adapters = adapters;
    this.#viewOf = viewOf;
    this.#onPaintError = onPaintError;
  }

  /** A frame opened: its adapter starts over from `init` at its next step or observe. A text-entry
   *  frame is typing over its owner, whose state stays. Runs no adapter code. The shell calls it
   *  when the stack gains the frame, so a frame hidden and shown again between two syncs keeps its
   *  state: an adapter whose content can be replaced while it is open keys its state on that
   *  content. An adapter that opted in has the state it is leaving remembered for that `init`. */
  opened(frame: UpperFrame): void {
    if (frame.kind === 'textEntry') return;
    if (this.#adapters[frame.id].remember === true && this.#states.has(frame.id)) {
      this.#remembered.set(frame.id, this.#states.get(frame.id));
    }
    this.#states.delete(frame.id);
  }

  /** Seat a frame the shell has just opened (CTL8S.3): with no kept state it starts from `init`
   *  now, and that state is kept and painted once, so a screen that chooses what it opens on shows
   *  it at the open, not at its first button or batch. A frame that has a state, or a text entry,
   *  is left alone. A throw is reported, never thrown; only a paint that threw keeps the state. */
  seat(frame: UpperFrame, ctx: ScreenContext): void {
    if (frame.kind === 'textEntry' || this.#states.has(frame.id)) return;
    const adapter = this.#adapters[frame.id];
    try {
      const vm = adapter.viewModel(ctx);
      const state = adapter.init(vm, this.#remembered.get(frame.id));
      this.#states.set(frame.id, state);
      this.#paint(frame.id, adapter, vm, state);
    } catch (err) {
      this.#onPaintError(err);
    }
  }

  /** The session changed (a reconnect, a new identity): nothing remembered outlives it. The kept
   *  state of an adapter that opted in goes too, or its next open would remember it. */
  forget(): void {
    this.#remembered.clear();
    for (const id of [...this.#states.keys()]) {
      if (this.#adapters[id].remember === true) this.#states.delete(id);
    }
  }

  /** Whether the top frame takes the D-pad (CTL7C.1): a screen or prompt whose adapter is
   *  nav-capable. */
  takesNav(stack: Stack): boolean {
    const top = stack[stack.length - 1];
    return (top.kind === 'screen' || top.kind === 'prompt') && this.#adapters[top.id].nav === true;
  }

  /** Route one button to the top frame. A text-entry frame owns every key but Start, which stops
   *  typing (pops that frame; the owner stays), and A, which commits through the owner's adapter. */
  button(stack: Stack, btn: NavInput, ctx: ScreenContext): ScreenResult {
    const top = stack[stack.length - 1];
    switch (top.kind) {
      case 'world':
      case 'battle':
        return baseButton(top, btn);
      case 'textEntry':
        if (btn.button === 'Start') return { kind: 'pop' };
        return btn.button === 'A' ? this.#step(top.owner, btn, ctx) : 'unhandled';
      case 'screen':
      case 'prompt':
        return this.#step(top.id, btn, ctx);
    }
  }

  /** A store batch was applied: every screen or prompt frame on the stack whose adapter
   *  defines `observe` is asked once, bottom up, with its own view model, its kept state (its
   *  `init` the first time since it opened) and the context's clock. The state it answers is
   *  kept, and painted once when it is a different object. A throw from the adapter or its paint
   *  is reported and leaves that frame's state as it was; the frames above are still asked. */
  observe(stack: Stack, ctx: ScreenContext): void {
    for (const frame of stack) {
      if (frame.kind !== 'screen' && frame.kind !== 'prompt') continue;
      const adapter = this.#adapters[frame.id];
      if (adapter.observe === undefined) continue;
      try {
        const vm = adapter.viewModel(ctx);
        const kept = this.#start(frame.id, adapter, vm);
        const next = adapter.observe(vm, kept, ctx.now());
        if (next !== kept) this.#paint(frame.id, adapter, vm, next);
        this.#states.set(frame.id, next);
      } catch (err) {
        this.#onPaintError(err);
      }
    }
  }

  /** One adapter step: the frame's kept state (its `init` the first time since it opened) goes in,
   *  the next one is kept and painted once into the frame's view, and the result comes back. A
   *  paint that throws never loses the result: B and Start must still close a frame whose view is
   *  broken. */
  #step(id: FrameId, btn: NavInput, ctx: ScreenContext): ScreenResult {
    const adapter = this.#adapters[id];
    const vm = adapter.viewModel(ctx);
    const step = adapter.onButton(vm, this.#start(id, adapter, vm), btn);
    this.#states.set(id, step.state);
    try {
      this.#paint(id, adapter, vm, step.state);
    } catch (err) {
      this.#onPaintError(err);
    }
    return step.result;
  }

  /** The state a frame's adapter goes on from: the kept one, else its `init`, handed what the
   *  frame last closed with when the adapter opted in. */
  #start(id: FrameId, adapter: ScreenAdapter<unknown, unknown>, vm: unknown): unknown {
    return this.#states.has(id) ? this.#states.get(id) : adapter.init(vm, this.#remembered.get(id));
  }

  /** Paint `state` into the frame's lent view, when the adapter paints and a view is lent. */
  #paint(id: FrameId, adapter: ScreenAdapter<unknown, unknown>, vm: unknown, state: unknown): void {
    if (adapter.paint === undefined) return;
    const view = this.#viewOf(id);
    if (view !== undefined) adapter.paint(view, vm, state);
  }
}
