// ui/screens/index.ts — the adapter table and the screen host (design §4, §12; CTL6B.1, CTL7C.2).
// The router hands a button to `ScreenHost.button`, which asks ONLY the top frame: the world's own
// rule (`worldButton`'s picker and action sheet, ctl-10a, then `baseButton`), the battle's cursor
// adapter at a bare battle base (`battleScreen`, ctl-8i), the typing rule over a text-entry frame,
// or that screen's adapter fed its own view model and the state the host keeps for it. A store
// batch goes to `ScreenHost.observe`, which asks every open frame whose adapter observes. No DOM,
// SDK or module state: main.ts holds the one host, binds the stack and the context and runs the
// returned command.
import type { SheetState } from '../actionSheetModel';
import type { BaseFrame, FrameId, Stack, UpperFrame } from '../contextStack';
import type { InteractAction, InteractCandidate } from '../interactModel';
import type { NavInput } from '../nav';
import type { Notice, RequestNotice, RequestSheet } from '../noticeModel';
import { bagScreen } from './bagScreen';
import { battleScreen } from './battleScreen';
import { dialogueScreen } from './dialogueScreen';
import { healScreen } from './healScreen';
import { helpScreen } from './helpScreen';
import { journalScreen } from './journalScreen';
import { legacyAdapter } from './legacyAdapter';
import { monstersScreen } from './monstersScreen';
import { controlsScreen } from './optionsScreen';
import { accountScreen, nameScreen, privacyScreen } from './profileScreen';
import { shopScreen } from './shopScreen';
import { socialScreen } from './socialScreen';
import { tradeProposeScreen } from './tradeProposeScreen';
import type { ScreenAdapter, ScreenContext, ScreenResult } from './types';
import { worldButton } from './worldScreen';

export type ScreenAdapters = Readonly<Record<FrameId, ScreenAdapter<unknown, unknown>>>;

/** Total over every frame id, so a new overlay without an adapter fails client-typecheck. (The
 *  battle BASE is not a frame: the host steps `battleScreen` there itself, ctl-8i; `battleView`'s
 *  entry answers only the outcome frame over the world.) Every
 *  entry is the legacy adapter until its ctl-8 screen slice swaps it (ctl-8a: the dialogue, heal
 *  and shop frames; ctl-8b: the box frame, as Monsters; ctl-8d: the Social frame; ctl-8e: the
 *  trade-propose wizard; ctl-8f: the raising frame, as Bag, and the quest log, as Journal; ctl-8h:
 *  the rename, claim and privacy frames, as Profile's Name, Account and Privacy; ctl-12b: the
 *  controls frame, as Options › Controls; ctl-14: Help). The trade, pvp
 *  and leaderboard overlays show as the one `social` frame (ctl-8s), so their own entries are
 *  never asked. */
export const SCREEN_ADAPTERS: ScreenAdapters = {
  battleView: legacyAdapter,
  boxView: monstersScreen,
  raisingView: bagScreen,
  evolutionView: legacyAdapter,
  dialogueView: dialogueScreen,
  questLogView: journalScreen,
  healView: healScreen,
  shopView: shopScreen,
  tradeView: legacyAdapter,
  pvpView: legacyAdapter,
  leaderboardView: legacyAdapter,
  renameView: nameScreen,
  tradeProposeView: tradeProposeScreen,
  helpView: helpScreen,
  menuView: legacyAdapter,
  claimView: accountScreen,
  privacyView: privacyScreen,
  controlsView: controlsScreen,
  social: socialScreen,
};

/** A button with nothing above the base. Start opens the menu at the world and is swallowed on a
 *  battle (B17: an ongoing battle is never hidden; main.ts's `battleButton` opens the menu over a
 *  bare battle before any screen is asked, ctl-6c). B is swallowed: with a notice showing, the world
 *  rule (`worldButton`, ctl-13) has already dismissed it. The host asks it only at the world: a bare battle base
 *  is `battleScreen`'s (ctl-8i), which gives B, Start and Select these same answers. */
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

/** What the world base acts on (ctl-10a): the candidates in front of the character, and the
 *  shell's runner for one action (talk, or open the heal frame: neither is a `Command`). */
export interface WorldPort {
  candidates(): readonly InteractCandidate[];
  run(action: InteractAction): void;
  /** The world's notices (ctl-13): optional, so a port without them is the ctl-10a world. */
  notices?: WorldNoticePort;
}

/** The shell's side of the notices: what shows, what waits, and B's and View's effects. */
export interface WorldNoticePort {
  notices(): readonly Notice[];
  pending(): readonly RequestNotice[];
  dismiss(key: string): void;
  view(n: RequestNotice): void;
}

/** The shell's side of the adapter seam (CTL7C.2): one adapter state per frame id, kept from the
 *  frame's first step, observe or seat until it opens again, and the view each state is painted
 *  into. For an adapter that opts in (`remember`, CTL8S.1) it also keeps the last state the frame
 *  had before it opened again, and hands it to the next `init`. */
export class ScreenHost {
  readonly #states = new Map<FrameId, unknown>();
  readonly #remembered = new Map<FrameId, unknown>();
  readonly #adapters: ScreenAdapters;
  readonly #viewOf: (id: FrameId) => unknown;
  readonly #onPaintError: (err: unknown) => void;
  /** The world base's open picker or action sheet (ctl-10a); null when none. */
  #sheet: SheetState | null = null;
  /** The world base's open request sheet (ctl-13); null when none. */
  #request: RequestSheet | null = null;

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
    this.#sheet = null;
    this.#request = null;
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
    this.#sheet = null;
    this.#request = null;
    this.#remembered.clear();
    for (const id of [...this.#states.keys()]) {
      if (this.#adapters[id].remember === true) this.#states.delete(id);
    }
  }

  /** The world base's open picker or action sheet, else null. */
  get sheet(): SheetState | null {
    return this.#sheet;
  }

  /** The world base's open request sheet, else null. */
  get request(): RequestSheet | null {
    return this.#request;
  }

  /** Whether either world sheet is open: movement and held input key on this, never `sheet`. */
  get sheetOpen(): boolean {
    return this.#sheet !== null || this.#request !== null;
  }

  /** Close the world sheets: the shell calls it when the stack is no longer the bare world. */
  closeSheet(): void {
    this.#sheet = null;
    this.#request = null;
  }

  /** Close the request sheet once its request is no longer pending (withdrawn, answered elsewhere
   *  or replaced), so a stale Accept never stays on screen. */
  settleRequest(pending: readonly RequestNotice[]): void {
    const open = this.#request;
    if (open !== null && !pending.some((n) => n.key === open.notice.key)) this.#request = null;
  }

  /** Whether the top frame takes the D-pad (CTL7C.1): a bare battle base (CTL8I.1), or a screen or
   *  prompt whose adapter is nav-capable, or the world base while its sheet is open (ctl-10a). */
  takesNav(stack: Stack): boolean {
    const top = stack[stack.length - 1];
    if (top.kind === 'world') return this.sheetOpen;
    if (top.kind === 'battle') return battleScreen.nav === true;
    return (top.kind === 'screen' || top.kind === 'prompt') && this.#adapters[top.id].nav === true;
  }

  /** Route one button to the top frame. A text-entry frame owns every key but Start, which stops
   *  typing (pops that frame; the owner stays), and A, which commits through the owner's adapter. */
  button(stack: Stack, btn: NavInput, ctx: ScreenContext, world?: WorldPort): ScreenResult {
    const top = stack[stack.length - 1];
    switch (top.kind) {
      case 'world': {
        if (world === undefined) return baseButton(top, btn);
        const port = world.notices;
        const step = worldButton(
          this.#sheet,
          world.candidates(),
          btn,
          port === undefined
            ? undefined
            : { notices: port.notices(), pending: port.pending(), request: this.#request },
        );
        this.#sheet = step.sheet;
        this.#request = step.request;
        if (step.run !== undefined) world.run(step.run);
        if (step.dismiss !== undefined) port?.dismiss(step.dismiss);
        if (step.view !== undefined) port?.view(step.view);
        if (step.command !== undefined) return step.command;
        return step.result === 'consumed' ? 'consumed' : baseButton(top, btn);
      }
      // The battle's cursor ops paint into the battle view, whose frame id keys their state.
      case 'battle':
        return this.#step('battleView', btn, ctx, battleScreen);
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
   *  broken. `adapter` defaults to the frame's own. */
  #step(
    id: FrameId,
    btn: NavInput,
    ctx: ScreenContext,
    adapter: ScreenAdapter<unknown, unknown> = this.#adapters[id],
  ): ScreenResult {
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
