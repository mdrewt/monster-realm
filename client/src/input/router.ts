// router.ts — the pure input router: consumes source-agnostic `{button, down}` edges and
// decides what they do (design §12). It owns the D-pad and X (Jump) at the world; under a nav
// frame (the main menu, ctl-5) it also owns A, B and Y and synthesizes D-pad auto-repeat. Every
// other button is unconsumed and the legacy ladder in main.ts keeps those keys.
//
// No DOM, SDK, module state or clock: the caller passes `now` and applies the returned effects.
import type { WasmDirection } from '../convert/convert';
import type { NavInput } from '../ui/nav';
import { type ButtonEdge, dpadDir, type VButton } from './buttons';

/** Who owns a key event: the focused element's native behaviour, or the router. */
export type Owner = 'target' | 'router';

/** The event fields ownership reads. `keyCode` 229 is the legacy IME-composition marker. */
export interface OwnershipEvent {
  readonly code: string;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

const TEXT_FIELD_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const ACTIVATABLE_TAGS: ReadonlySet<string> = new Set(['BUTTON', 'A']);
// A text field keeps every key except these, which stop or commit typing.
const FIELD_RELEASED_CODES: ReadonlySet<string> = new Set(['Escape', 'Enter', 'NumpadEnter']);
// A native button or link activates on these.
const ACTIVATION_CODES: ReadonlySet<string> = new Set(['Space', 'Enter', 'NumpadEnter']);

/**
 * Whether `target`'s native behaviour owns this key (design §3 "Native-key ownership").
 * Reads `tagName` / `isContentEditable` structurally, so it needs no DOM: the window, the
 * body and the canvas (or a non-element) all leave the key to the router.
 */
export function ownership(target: unknown, e: OwnershipEvent): Owner {
  if (e.isComposing === true || e.keyCode === 229) return 'target';
  if (typeof target !== 'object' || target === null) return 'router';
  const { tagName, isContentEditable } = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
  };
  const tag = typeof tagName === 'string' ? tagName.toUpperCase() : '';
  if (isContentEditable === true || TEXT_FIELD_TAGS.has(tag)) {
    return FIELD_RELEASED_CODES.has(e.code) ? 'router' : 'target';
  }
  if (ACTIVATABLE_TAGS.has(tag) && ACTIVATION_CODES.has(e.code)) return 'target';
  return 'router';
}

/** The buttons the router consumes (and so `preventDefault`s): the D-pad and X. */
export const routerConsumes = (b: VButton): boolean => b === 'X' || dpadDir(b) !== undefined;

export type RouterEffect =
  /** A direction went down at the world: step once unless already held, then hold it. */
  | { readonly kind: 'dirDown'; readonly dir: WasmDirection }
  /** The last holder of a direction released it. */
  | { readonly kind: 'dirUp'; readonly dir: WasmDirection }
  | { readonly kind: 'jump' }
  /** An input for the uncovered nav frame: a press, or a synthesized repeat. */
  | { readonly kind: 'nav'; readonly input: NavInput }
  /** B over a covered nav frame: close the legacy frame on top. */
  | { readonly kind: 'pop' };

export interface RouteContext {
  /** True when no overlay is open, so world input (walk, jump) applies. */
  readonly worldActive: boolean;
  /** Present while a nav frame is on the stack: `covered` when a legacy frame sits above it,
   *  and the injected clock the repeat schedule runs on. */
  readonly nav?: { readonly covered: boolean; readonly now: number };
}

export interface RouteResult {
  readonly consumed: boolean;
  readonly effects: readonly RouterEffect[];
}

const NOT_CONSUMED: RouteResult = { consumed: false, effects: [] };
const SWALLOWED: RouteResult = { consumed: true, effects: [] };

/** Menu auto-repeat (design §6): the first repeat after this long held, then one per period. */
export const REPEAT_DELAY_MS = 350;
export const REPEAT_PERIOD_MS = 100;

/** The buttons an uncovered nav frame takes besides the D-pad. */
const NAV_BUTTONS: ReadonlySet<VButton> = new Set(['A', 'B', 'Y']);

const navPress = (button: VButton): RouteResult => ({
  consumed: true,
  effects: [{ kind: 'nav', input: { button, repeat: false } }],
});

export class InputRouter {
  // Down edges per D-pad button not yet matched by an up edge, across every source. A
  // direction is released only when its last holder lets go (two keys, or key + pad).
  readonly #holders = new Map<VButton, number>();
  // The D-pad button that auto-repeats under the nav frame, and when its next repeat is due.
  // Armed by a press under an uncovered nav frame; only the latest press repeats.
  #repeat: { readonly button: VButton; nextAt: number } | undefined;

  route(edge: ButtonEdge, ctx: RouteContext): RouteResult {
    const { button, down } = edge;
    const nav = ctx.nav !== undefined && !ctx.nav.covered ? ctx.nav : undefined;
    const dir = dpadDir(button);
    if (dir !== undefined) {
      const count = this.#holders.get(button) ?? 0;
      if (down) {
        this.#holders.set(button, count + 1);
        if (nav !== undefined) {
          this.#repeat = { button, nextAt: nav.now + REPEAT_DELAY_MS };
          return navPress(button);
        }
        return ctx.worldActive
          ? { consumed: true, effects: [{ kind: 'dirDown', dir }] }
          : SWALLOWED;
      }
      if (count === 0) return SWALLOWED; // an unmatched up (no underflow)
      if (count > 1) {
        this.#holders.set(button, count - 1);
        return SWALLOWED;
      }
      this.#holders.delete(button);
      if (this.#repeat?.button === button) this.#repeat = undefined;
      return { consumed: true, effects: [{ kind: 'dirUp', dir }] };
    }
    if (button === 'X') {
      // Jump does not hold-repeat: only the press acts.
      return down && ctx.worldActive ? { consumed: true, effects: [{ kind: 'jump' }] } : SWALLOWED;
    }
    if (nav !== undefined && NAV_BUTTONS.has(button)) return down ? navPress(button) : SWALLOWED;
    if (button === 'B' && ctx.nav?.covered === true) {
      return down ? { consumed: true, effects: [{ kind: 'pop' }] } : SWALLOWED;
    }
    return NOT_CONSUMED;
  }

  /** The frame-loop pump: at most one repeat edge for the armed D-pad button, once it is due,
   *  while the nav frame is uncovered. A stalled clock yields one edge, never a burst. */
  tick(ctx: RouteContext): readonly RouterEffect[] {
    const repeat = this.#repeat;
    if (repeat === undefined || ctx.nav === undefined || ctx.nav.covered) return [];
    const { now } = ctx.nav;
    if (now < repeat.nextAt) return [];
    repeat.nextAt += REPEAT_PERIOD_MS;
    if (repeat.nextAt <= now) repeat.nextAt = now + REPEAT_PERIOD_MS;
    return [{ kind: 'nav', input: { button: repeat.button, repeat: true } }];
  }

  /** Stop any repeat: a held key never repeats into a newly pushed or popped frame. */
  resetRepeat(): void {
    this.#repeat = undefined;
  }

  /** Release every held button (blur, tab hidden): one `dirUp` per held direction. */
  releaseAll(): readonly RouterEffect[] {
    const effects: RouterEffect[] = [];
    for (const button of this.#holders.keys()) {
      const dir = dpadDir(button);
      if (dir !== undefined) effects.push({ kind: 'dirUp', dir });
    }
    this.#holders.clear();
    this.#repeat = undefined;
    return effects;
  }
}
