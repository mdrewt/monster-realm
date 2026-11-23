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
   *  it is released and pressed again (the caller has cleared the router's holders). */
  releaseAll(): void {
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
  #read(edges: ButtonEdge[]): { pad: PadLike; state: PadState }[] {
    const present = new Map<number, PadLike>();
    for (const pad of this.#readPads()) {
      if (pad !== null && pad.connected === true) present.set(pad.index, pad);
    }
    for (const [slot, state] of this.#pads) {
      if (present.get(slot)?.id === state.id) continue;
      for (const i of [...state.held.keys()].sort((a, b) => a - b)) {
        const button = state.held.get(i);
        if (button) edges.push({ button, down: false });
      }
      if (state.stickOwed !== null) edges.push({ button: state.stickOwed, down: false });
      this.#pads.delete(slot);
    }
    const out: { pad: PadLike; state: PadState }[] = [];
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

  /** `getPads()`, read as no pads when it throws (reported once). */
  #readPads(): readonly (PadLike | null)[] {
    try {
      return this.#getPads();
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
  #diffButtons(pad: PadLike, state: PadState, onPress: OnPress, edges: ButtonEdge[]): void {
    const pressed = new Set<PadIndex>();
    for (let i = 0; i < pad.buttons.length; i++) {
      if (pad.buttons[i]?.pressed === true) pressed.add(i);
    }
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

  /** Read the left stick (a `standard` pad's axes 0 and 1; any other pad's stick reads centred)
   *  and emit its changes: the owed direction's up edge before the new direction's down edge. A
   *  latched stick emits no down edge until it reads centre; `emitDown` false latches a new one. */
  #diffStick(pad: PadLike, state: PadState, edges: ButtonEdge[], emitDown: boolean): void {
    const next =
      pad.mapping === 'standard'
        ? stickToDpad(pad.axes[0] ?? 0, pad.axes[1] ?? 0, state.stick)
        : null;
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
