// gamepadSource.ts — polls the Gamepad API (injected as `getPads`) into source-agnostic
// `{button, down}` edges and menu accelerators. It keeps its own copy of what each pad held at the
// last read, so one press gives one down edge and one up edge, even when the browser hands back the
// same snapshot object mutated in place. Every connected pad feeds the same edges; a pad whose
// `mapping` is not `standard` gets the button table but its axes are ignored (wheels and pedals
// rest at -1). The left stick and the D-pad button of one direction are separate holders.
import type { ButtonEdge, VButton } from './buttons';
import {
  isBindablePadIndex,
  PAD_DEFAULT_BINDINGS,
  type PadBindings,
  type PadIndex,
  padAccelFor,
  padButtonFor,
} from './padBindings';
import type { MenuAccel } from './router';
import { type DpadDir, stickToDpad } from './stick';

/** The `Gamepad` fields the source reads (a real `Gamepad` satisfies it). */
export interface PadLike {
  readonly index: number;
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly buttons: readonly { readonly pressed: boolean }[];
  readonly axes: readonly number[];
}

export interface GamepadSourceOptions {
  /** Called once per source, the first time `getPads` throws. */
  readonly onError?: (err: unknown) => void;
}

export interface PadPoll {
  readonly edges: readonly ButtonEdge[];
  readonly accels: readonly MenuAccel[];
}

/** One pad slot as the source last read it. */
interface PadState {
  readonly id: string;
  /** Each held index, with the virtual button whose up edge it owes, or null when it owes nothing:
   *  an accelerator, an unbound or reserved index, a captured press, or anything held at
   *  `releaseAll` / `rebind` (the router was cleared then). */
  readonly held: Map<PadIndex, VButton | null>;
  /** The stick's direction at the last read: the hysteresis input. */
  stick: DpadDir | null;
  /** The direction whose up edge the stick owes. */
  stickOwed: DpadDir | null;
  /** The stick emits nothing until it next reads centre. */
  stickLatched: boolean;
}

/** What the source copied out of one connected pad in one read. */
interface PadSnapshot {
  readonly index: number;
  readonly id: string;
  /** Whether each button index is pressed. */
  readonly pressed: readonly boolean[];
  /** The left stick, `standard` pads only; any other pad's stick reads centred. */
  readonly x: number;
  readonly y: number;
}

/** What a newly pressed index does: the virtual button it pressed, or null. */
type OnPress = (i: PadIndex) => VButton | null;

export class GamepadSource {
  readonly #getPads: () => readonly (PadLike | null)[];
  readonly #onError: ((err: unknown) => void) | undefined;
  #bindings: PadBindings;
  #errorReported = false;
  readonly #pads = new Map<number, PadState>();
  /** Up edges a `capture()` read owed; the next `poll()` emits them first. */
  #pending: ButtonEdge[] = [];

  constructor(
    getPads: () => readonly (PadLike | null)[],
    bindings: PadBindings = PAD_DEFAULT_BINDINGS,
    options: GamepadSourceOptions = {},
  ) {
    this.#getPads = getPads;
    this.#bindings = bindings;
    this.#onError = options.onError;
  }

  /** Read every pad and return the edges and accelerators since the last read. */
  poll(): PadPoll {
    const edges = this.#pending;
    this.#pending = [];
    const accels: MenuAccel[] = [];
    const onPress: OnPress = (i) => {
      if (!isBindablePadIndex(i)) return null;
      const accel = padAccelFor(this.#bindings, i);
      if (accel !== undefined) {
        accels.push(accel);
        return null;
      }
      const button = padButtonFor(this.#bindings, i) ?? null;
      if (button !== null) edges.push({ button, down: true });
      return button;
    };
    for (const { pad, state } of this.#read(edges)) {
      this.#diffButtons(pad, state, onPress, edges);
      this.#diffStick(pad, state, edges, true);
    }
    return { edges, accels };
  }

  /** Owe nothing for what is held now: each held button and stick direction emits nothing until
   *  it is released and pressed again, and the up edges a `capture()` queued are dropped (the
   *  caller has cleared the router's holders). */
  releaseAll(): void {
    this.#pending = [];
    for (const state of this.#pads.values()) {
      for (const i of state.held.keys()) state.held.set(i, null);
      state.stickOwed = null;
      state.stickLatched = state.stick !== null;
    }
  }

  /** Swap the binding table; everything held now latches, as with `releaseAll`. */
  rebind(next: PadBindings): void {
    this.releaseAll();
    this.#bindings = next;
  }

  /** Read every pad without emitting a press, and return the lowest newly pressed bindable index,
   *  `'refused'` when only reserved or unbindable indices were newly pressed, or undefined. A
   *  captured press owes nothing; an owed release seen here reaches the next `poll()`. */
  capture(): PadIndex | 'refused' | undefined {
    let best: PadIndex | undefined;
    let refused = false;
    const onPress: OnPress = (i) => {
      if (!isBindablePadIndex(i)) refused = true;
      else if (best === undefined || i < best) best = i;
      return null;
    };
    for (const { pad, state } of this.#read(this.#pending)) {
      this.#diffButtons(pad, state, onPress, this.#pending);
      this.#diffStick(pad, state, this.#pending, false);
    }
    return best ?? (refused ? 'refused' : undefined);
  }

  /** The connected pads, each with its state. A slot whose pad vanished, disconnected or changed
   *  `id` first releases everything it owed into `edges` and starts over. */
  #read(edges: ButtonEdge[]): { pad: PadSnapshot; state: PadState }[] {
    const present = new Map<number, PadSnapshot>();
    for (const pad of this.#snapshot()) present.set(pad.index, pad);
    for (const [slot, state] of this.#pads) {
      if (present.get(slot)?.id === state.id) continue;
      for (const i of [...state.held.keys()].sort((a, b) => a - b)) {
        const button = state.held.get(i);
        if (button) edges.push({ button, down: false });
      }
      if (state.stickOwed !== null) edges.push({ button: state.stickOwed, down: false });
      this.#pads.delete(slot);
    }
    const out: { pad: PadSnapshot; state: PadState }[] = [];
    for (const [slot, pad] of present) {
      let state = this.#pads.get(slot);
      if (state === undefined) {
        state = { id: pad.id, held: new Map(), stick: null, stickOwed: null, stickLatched: false };
        this.#pads.set(slot, state);
      }
      out.push({ pad, state });
    }
    return out;
  }

  /** Copy what the source reads out of every connected pad, so a snapshot the browser mutates in
   *  place is never read twice. A `getPads()` that throws or returns something malformed reads as no
   *  pads (reported once). */
  #snapshot(): PadSnapshot[] {
    try {
      const out: PadSnapshot[] = [];
      for (const pad of Array.from(this.#getPads())) {
        if (pad === null || pad.connected !== true) continue;
        const standard = pad.mapping === 'standard';
        out.push({
          index: pad.index,
          id: pad.id,
          pressed: Array.from(pad.buttons, (b) => b?.pressed === true),
          x: standard ? (pad.axes[0] ?? 0) : 0,
          y: standard ? (pad.axes[1] ?? 0) : 0,
        });
      }
      return out;
    } catch (err) {
      if (!this.#errorReported) {
        this.#errorReported = true;
        try {
          this.#onError?.(err);
        } catch {
          // A failing reporter must not stop the poll that releases held buttons.
        }
      }
      return [];
    }
  }

  /** Diff the pad's pressed buttons against `state.held`, index ascending: a new press records
   *  what `onPress` returns, a release emits the up edge it owes. */
  #diffButtons(pad: PadSnapshot, state: PadState, onPress: OnPress, edges: ButtonEdge[]): void {
    const pressed = new Set<PadIndex>();
    pad.pressed.forEach((down, i) => {
      if (down) pressed.add(i);
    });
    const indices = [...new Set([...pressed, ...state.held.keys()])].sort((a, b) => a - b);
    for (const i of indices) {
      const wasHeld = state.held.has(i);
      if (pressed.has(i) && !wasHeld) {
        state.held.set(i, onPress(i));
      } else if (!pressed.has(i) && wasHeld) {
        const button = state.held.get(i);
        state.held.delete(i);
        if (button) edges.push({ button, down: false });
      }
    }
  }

  /** Emit the left stick's changes: the owed direction's up edge before the new direction's down
   *  edge. A latched stick emits no down edge until it reads centre; `emitDown` false latches a
   *  new one. */
  #diffStick(pad: PadSnapshot, state: PadState, edges: ButtonEdge[], emitDown: boolean): void {
    const next = stickToDpad(pad.x, pad.y, state.stick);
    state.stick = next;
    if (next === null) state.stickLatched = false;
    if (next === state.stickOwed) return;
    if (state.stickOwed !== null) edges.push({ button: state.stickOwed, down: false });
    state.stickOwed = null;
    if (next === null || state.stickLatched) return;
    if (emitDown) {
      edges.push({ button: next, down: true });
      state.stickOwed = next;
    } else {
      state.stickLatched = true;
    }
  }
}
