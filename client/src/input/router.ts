// router.ts — the pure input router: consumes source-agnostic `{button, down}` edges and
// decides what they do (design §12). It owns the D-pad and X (Jump) at the world; under a nav
// frame it synthesizes D-pad auto-repeat, and under the main menu (ctl-5) it also owns A, B and Y.
// Every other button goes to the top frame's screen adapter (ctl-6b), and so does the D-pad of a
// nav-capable screen (ctl-7c); what that adapter leaves `unhandled` is unconsumed, and the page
// keeps the key. It also decides each accelerator (ctl-11a): `accelDecision` names the menu path
// it opens, or refuses it, or makes it act as Start.
//
// No DOM, SDK, module state or clock: the caller passes `now` and applies the returned effects.
import type { WasmDirection } from '../convert/convert';
import { acceleratorsDenied, type FrameId, type Stack } from '../ui/contextStack';
import type { MonstersTab } from '../ui/monstersModel';
import type { NavInput } from '../ui/nav';
import type { Command, ScreenResult } from '../ui/screens/types';
import { type Accel, type ButtonEdge, dpadDir, type VButton } from './buttons';

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

/** The game screen as ownership reads it: only whether it holds the focused element. */
export interface GameScreen {
  contains(node: unknown): boolean;
}

/**
 * Whether `target` is focus outside the game screen (design §3, CTL11B.1): an element that is not
 * `<body>` or `<html>` and that `screen` does not hold. With no screen (a shell-less page) nothing
 * is outside.
 */
export function outsideGameScreen(target: unknown, screen: GameScreen | null): boolean {
  if (screen === null || typeof target !== 'object' || target === null) return false;
  const { tagName } = target as { tagName?: unknown };
  if (typeof tagName !== 'string') return false;
  const tag = tagName.toUpperCase();
  return tag !== 'BODY' && tag !== 'HTML' && !screen.contains(target);
}

/**
 * Whether `target`'s native behaviour owns this key (design §3 "Native-key ownership").
 * Reads `tagName` / `isContentEditable` structurally, so it needs no DOM: the window, the
 * body and the canvas (or a non-element) all leave the key to the router. Focus outside the
 * game screen owns every key.
 */
export function ownership(
  target: unknown,
  e: OwnershipEvent,
  screen: GameScreen | null = null,
): Owner {
  if (outsideGameScreen(target, screen)) return 'target';
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

// The INPUT types that take typed text; every other type (checkbox, range, button…) is a control.
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  '',
  'text',
  'search',
  'email',
  'password',
  'tel',
  'url',
  'number',
]);

/** Typing mode (CTL6B.5, design §3): the two keys a focused field releases keep their meaning
 *  whatever the binding table says, so a remap can never take them from the field. Escape in a
 *  text field stops typing (the shell moves focus out of the field and keeps its text) instead of
 *  acting as Start. Enter in any field commits: it is the A button there, even when the table
 *  binds Enter to something else or to nothing. A composing key is the IME's. */
export function typingKey(target: unknown, e: OwnershipEvent): 'stopTyping' | 'commit' | undefined {
  if (e.isComposing === true || e.keyCode === 229) return undefined;
  if (typeof target !== 'object' || target === null) return undefined;
  const { tagName, type, isContentEditable } = target as {
    tagName?: unknown;
    type?: unknown;
    isContentEditable?: unknown;
  };
  const tag = typeof tagName === 'string' ? tagName.toUpperCase() : '';
  if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    return isContentEditable === true || TEXT_FIELD_TAGS.has(tag) ? 'commit' : undefined;
  }
  if (e.code !== 'Escape') return undefined;
  const text =
    isContentEditable === true ||
    tag === 'TEXTAREA' ||
    (tag === 'INPUT' && TEXT_INPUT_TYPES.has(typeof type === 'string' ? type : ''));
  return text ? 'stopTyping' : undefined;
}

/** The accelerators that open a menu path; F8 and F9 keep their own handlers. */
export type MenuAccel = Exclude<Accel, 'F8' | 'F9'>;

/** An accelerator's canonical menu path (design §3): the main-menu entry keys, root first, the
 *  frame its leaf opens, and the Monsters tab it opens on. */
export interface AccelPath {
  readonly menu: readonly string[];
  readonly frame: FrameId;
  readonly tab?: MonstersTab;
}

export const ACCEL_PATHS: Readonly<Record<MenuAccel, AccelPath>> = {
  B: { menu: ['monsters'], frame: 'boxView', tab: 'storage' },
  I: { menu: ['bag'], frame: 'raisingView' },
  V: { menu: ['monsters'], frame: 'boxView', tab: 'party' },
  J: { menu: ['journal'], frame: 'questLogView' },
  U: { menu: ['social', 'trades'], frame: 'social' },
  P: { menu: ['social', 'challenges'], frame: 'social' },
  L: { menu: ['social', 'rankings'], frame: 'social' },
  N: { menu: ['profile', 'name'], frame: 'renameView' },
  C: { menu: ['profile', 'account'], frame: 'claimView' },
};

export type AccelDecision =
  | { readonly kind: 'denied' }
  /** Its own screen is on top: the accelerator acts as Start. */
  | { readonly kind: 'start' }
  /** Pop to the base, then open `path` through the main menu. */
  | { readonly kind: 'open'; readonly path: AccelPath };

/** What an accelerator press does over `stack` (CTL11A.1, CTL11A.2). */
export function accelDecision(accel: MenuAccel, stack: Stack): AccelDecision {
  if (acceleratorsDenied(stack)) return { kind: 'denied' };
  const path = ACCEL_PATHS[accel];
  const top = stack[stack.length - 1];
  return top.kind === 'screen' && top.id === path.frame
    ? { kind: 'start' }
    : { kind: 'open', path };
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
  /** A command the top frame's adapter issued for a button. */
  | { readonly kind: 'command'; readonly command: Command };

export interface RouteContext {
  /** True when no overlay is open, so world input (walk, jump) applies. */
  readonly worldActive: boolean;
  /** Present while a nav frame is on the stack: `covered` when a legacy frame sits above it, the
   *  injected clock the repeat schedule runs on, and `screen` when that frame is a nav-capable
   *  screen (CTL7C.1): its D-pad presses and repeats go to `screen` below, as its other buttons
   *  do, instead of becoming `nav` effects. */
  readonly nav?: { readonly covered: boolean; readonly now: number; readonly screen?: boolean };
  /** The top frame's screen adapter: asked for every button but X, the main menu's own (`nav`
   *  effects) and a D-pad edge no nav-capable screen takes. */
  readonly screen?: (btn: NavInput) => ScreenResult;
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

/** The buttons the uncovered main menu takes besides the D-pad. */
const NAV_BUTTONS: ReadonlySet<VButton> = new Set(['A', 'B', 'Y']);

const navPress = (button: VButton): RouteResult => ({
  consumed: true,
  effects: [{ kind: 'nav', input: { button, repeat: false } }],
});

/** A D-pad input for a nav-capable screen: its adapter's command, if it answered with one. */
const dpadToScreen = (ctx: RouteContext, input: NavInput): readonly RouterEffect[] => {
  const result = ctx.screen?.(input);
  return typeof result === 'object' ? [{ kind: 'command', command: result }] : [];
};

export class InputRouter {
  // Down edges per D-pad button not yet matched by an up edge, across every source. A
  // direction is released only when its last holder lets go (two keys, or key + pad).
  readonly #holders = new Map<VButton, number>();
  // The D-pad button that auto-repeats under the nav frame, and when its next repeat is due.
  // Armed by a press under an uncovered nav frame; only the latest press repeats.
  #repeat: { readonly button: VButton; nextAt: number } | undefined;
  // D-pad buttons held since the last repeat reset, oldest press first: releasing the repeating
  // one hands the repeat back to the most recent of them still held.
  #pressOrder: VButton[] = [];

  route(edge: ButtonEdge, ctx: RouteContext): RouteResult {
    const { button, down } = edge;
    const nav = ctx.nav !== undefined && !ctx.nav.covered ? ctx.nav : undefined;
    const dir = dpadDir(button);
    if (dir !== undefined) {
      const count = this.#holders.get(button) ?? 0;
      if (down) {
        this.#holders.set(button, count + 1);
        this.#pressOrder = [...this.#pressOrder.filter((b) => b !== button), button];
        if (nav !== undefined) {
          this.#repeat = { button, nextAt: nav.now + REPEAT_DELAY_MS };
          if (!nav.screen) return navPress(button);
          // Always consumed, whatever the adapter answers: an arrow key must not scroll the page.
          return { consumed: true, effects: dpadToScreen(ctx, { button, repeat: false }) };
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
      this.#pressOrder = this.#pressOrder.filter((b) => b !== button);
      if (this.#repeat?.button === button) {
        const still = this.#pressOrder.at(-1);
        this.#repeat =
          still === undefined || nav === undefined
            ? undefined
            : { button: still, nextAt: nav.now + REPEAT_DELAY_MS };
      }
      return { consumed: true, effects: [{ kind: 'dirUp', dir }] };
    }
    if (button === 'X') {
      // Jump does not hold-repeat: only the press acts.
      return down && ctx.worldActive ? { consumed: true, effects: [{ kind: 'jump' }] } : SWALLOWED;
    }
    if (nav !== undefined && !nav.screen && NAV_BUTTONS.has(button)) {
      return down ? navPress(button) : SWALLOWED;
    }
    if (!down || ctx.screen === undefined) return NOT_CONSUMED;
    const result = ctx.screen({ button, repeat: false });
    if (result === 'unhandled') return NOT_CONSUMED;
    if (result === 'consumed') return SWALLOWED;
    return { consumed: true, effects: [{ kind: 'command', command: result }] };
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
    const input: NavInput = { button: repeat.button, repeat: true };
    return ctx.nav.screen ? dpadToScreen(ctx, input) : [{ kind: 'nav', input }];
  }

  /** Stop any repeat: a held key never repeats into a newly pushed or popped frame, not even
   *  when a newer key's release would hand the repeat back to it. The holder counts stay, so its
   *  release is still reported. */
  resetRepeat(): void {
    this.#repeat = undefined;
    this.#pressOrder = [];
  }

  /** Release every held button (blur, tab hidden): one `dirUp` per held direction. */
  releaseAll(): readonly RouterEffect[] {
    const effects: RouterEffect[] = [];
    for (const button of this.#holders.keys()) {
      const dir = dpadDir(button);
      if (dir !== undefined) effects.push({ kind: 'dirUp', dir });
    }
    this.#holders.clear();
    this.#pressOrder = [];
    this.#repeat = undefined;
    return effects;
  }
}
