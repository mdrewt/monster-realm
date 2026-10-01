// router.ts — the pure input router: consumes source-agnostic `{button, down}` edges and
// decides what they do (design §12). In ctl-1 it owns only the D-pad and X (Jump); every
// other button is unconsumed and the legacy ladder in main.ts keeps those keys.
//
// No DOM, SDK, module state or clock: main.ts applies the returned effects.
import type { WasmDirection } from '../convert/convert';
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
  | { readonly kind: 'jump' };

export interface RouteContext {
  /** True when no overlay is open, so world input (walk, jump) applies. */
  readonly worldActive: boolean;
}

export interface RouteResult {
  readonly consumed: boolean;
  readonly effects: readonly RouterEffect[];
}

const NOT_CONSUMED: RouteResult = { consumed: false, effects: [] };
const SWALLOWED: RouteResult = { consumed: true, effects: [] };

export class InputRouter {
  // Down edges per D-pad button not yet matched by an up edge, across every source. A
  // direction is released only when its last holder lets go (two keys, or key + pad).
  readonly #holders = new Map<VButton, number>();

  route(edge: ButtonEdge, ctx: RouteContext): RouteResult {
    const { button, down } = edge;
    const dir = dpadDir(button);
    if (dir !== undefined) {
      const count = this.#holders.get(button) ?? 0;
      if (down) {
        this.#holders.set(button, count + 1);
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
      return { consumed: true, effects: [{ kind: 'dirUp', dir }] };
    }
    if (button === 'X') {
      // Jump does not hold-repeat: only the press acts.
      return down && ctx.worldActive ? { consumed: true, effects: [{ kind: 'jump' }] } : SWALLOWED;
    }
    return NOT_CONSUMED;
  }

  /** Release every held button (blur, tab hidden): one `dirUp` per held direction. */
  releaseAll(): readonly RouterEffect[] {
    const effects: RouterEffect[] = [];
    for (const button of this.#holders.keys()) {
      const dir = dpadDir(button);
      if (dir !== undefined) effects.push({ kind: 'dirUp', dir });
    }
    this.#holders.clear();
    return effects;
  }
}
