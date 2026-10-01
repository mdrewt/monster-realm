// keyboardSource.ts — maps keyboard events through the binding table into `{button, down}`
// edges (design §3, §12). It records which physical codes are down, so the router sees one
// press per physical key held and one release per recorded press: that is what makes the
// router's per-button count equal "keys holding this button".
import { type Bindings, buttonForCode, DEFAULT_BINDINGS } from './bindings';
import type { ButtonEdge, VButton } from './buttons';
import { type OwnershipEvent, ownership } from './router';

/** The KeyboardEvent fields the source reads (a real KeyboardEvent satisfies it). */
export interface KeyEventLike extends OwnershipEvent {
  readonly repeat?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly target?: unknown;
}

/** Ctrl/Alt/Meta chords belong to the browser, never to the game (design §3). */
export const isChord = (e: KeyEventLike): boolean =>
  e.ctrlKey === true || e.altKey === true || e.metaKey === true;

export class KeyboardSource {
  readonly #bindings: Bindings;
  readonly #down = new Map<string, VButton>();

  constructor(bindings: Bindings = DEFAULT_BINDINGS) {
    this.#bindings = bindings;
  }

  buttonFor(code: string): VButton | undefined {
    return buttonForCode(this.#bindings, code);
  }

  /** The edges a keydown produces: none for a chord, an OS repeat, a key the focused element
   *  owns, or an unbound key. A non-repeat keydown on a code already recorded down means its
   *  keyup was lost (macOS drops keyups while Cmd is held), so it releases before pressing:
   *  otherwise the key would be dead and its direction would stay held. */
  keydown(e: KeyEventLike): readonly ButtonEdge[] {
    if (isChord(e) || e.repeat === true || ownership(e.target, e) === 'target') return [];
    const button = this.buttonFor(e.code);
    if (button === undefined) return [];
    const lost = this.#down.get(e.code);
    this.#down.set(e.code, button);
    const press: ButtonEdge = { button, down: true };
    return lost === undefined ? [press] : [{ button: lost, down: false }, press];
  }

  /** A release for a recorded code, whatever the modifiers or target: filtering keyups
   *  would leave keys stuck down. */
  keyup(e: KeyEventLike): readonly ButtonEdge[] {
    const button = this.#down.get(e.code);
    if (button === undefined) return [];
    this.#down.delete(e.code);
    return [{ button, down: false }];
  }

  /** Forget every recorded code (blur, tab hidden). */
  releaseAll(): void {
    this.#down.clear();
  }
}
