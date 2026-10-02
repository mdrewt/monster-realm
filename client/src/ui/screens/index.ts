// ui/screens/index.ts — the adapter table and the screen host (design §4, §12; CTL6B.1, CTL7C.2).
// The router hands a button to `ScreenHost.button`, which asks ONLY the top frame: the base's own
// rule (`baseButton`), the typing rule over a text-entry frame, or that screen's adapter fed its own
// view model and the state the host keeps for it. A store batch goes to `ScreenHost.observe`, which
// asks every open frame whose adapter observes (CTL7D.6). No DOM, SDK or module state: main.ts
// holds the one host, binds the stack and the context and runs the returned command.
import type { BaseFrame, FrameId, Stack, UpperFrame } from '../contextStack';
import type { NavInput } from '../nav';
import { legacyAdapter } from './legacyAdapter';
import type { ScreenAdapter, ScreenContext, ScreenResult } from './types';

export type ScreenAdapters = Readonly<Record<FrameId, ScreenAdapter<unknown, unknown>>>;

/** Total over every frame id, so a new overlay without an adapter fails client-typecheck. Every
 *  entry is the legacy adapter until its ctl-8 screen slice swaps it. */
export const SCREEN_ADAPTERS: ScreenAdapters = {
  battleView: legacyAdapter,
  boxView: legacyAdapter,
  raisingView: legacyAdapter,
  evolutionView: legacyAdapter,
  dialogueView: legacyAdapter,
  questLogView: legacyAdapter,
  healView: legacyAdapter,
  shopView: legacyAdapter,
  tradeView: legacyAdapter,
  pvpView: legacyAdapter,
  leaderboardView: legacyAdapter,
  renameView: legacyAdapter,
  tradeProposeView: legacyAdapter,
  helpView: legacyAdapter,
  menuView: legacyAdapter,
  claimView: legacyAdapter,
  privacyView: legacyAdapter,
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
 *  frame's first step or observe until it opens again, and the view each state is painted into. */
export class ScreenHost {
  readonly #states = new Map<FrameId, unknown>();
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

  /** A frame opened: its adapter starts over from `init` at its next step. A text-entry frame is
   *  typing over its owner, whose state stays. Runs no adapter code. The shell calls it when the
   *  stack gains the frame, so a frame hidden and shown again between two syncs keeps its state:
   *  an adapter whose content can be replaced while it is open keys its state on that content. */
  opened(frame: UpperFrame): void {
    if (frame.kind !== 'textEntry') this.#states.delete(frame.id);
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

  /** A store batch was applied (CTL7D.6): every screen or prompt frame on the stack whose adapter
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
        const kept = this.#states.has(frame.id) ? this.#states.get(frame.id) : adapter.init(vm);
        const next = adapter.observe(vm, kept, ctx.now());
        if (next !== kept && adapter.paint !== undefined) {
          const view = this.#viewOf(frame.id);
          if (view !== undefined) adapter.paint(view, vm, next);
        }
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
    const state = this.#states.has(id) ? this.#states.get(id) : adapter.init(vm);
    const step = adapter.onButton(vm, state, btn);
    this.#states.set(id, step.state);
    if (adapter.paint !== undefined) {
      const view = this.#viewOf(id);
      if (view !== undefined) {
        try {
          adapter.paint(view, vm, step.state);
        } catch (err) {
          this.#onPaintError(err);
        }
      }
    }
    return step.result;
  }
}
