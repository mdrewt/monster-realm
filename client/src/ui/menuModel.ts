// ui/menuModel.ts — the pure two-level main-menu core (uxd3, ADR-0162).
//
// FUNCTIONAL CORE (ADR-0014): no DOM, no SDK, no store access. Availability enters as
// three plain booleans, so every nav rule is node-testable with zero mocks and the DOM
// shell (`menuView.ts`) stays a dumb painter.
//
// TAXONOMY — why these five categories and these eleven leaves:
//  - Drew asked that "Backpack" (items) and "Journal" (quests) be discoverable. Neither is
//    a new screen: `raisingView` IS the inventory (`refreshRaising` feeds it
//    `store.ownInventory`) and `questLogView` IS the journal. A top-level Backpack category
//    would therefore be one leaf pointing at the same overlay as Raise — a menu promising a
//    screen the game does not have, which is the worst outcome for a discoverability
//    surface. So the words ship as leaf TITLES at zero cost, and a Backpack leaf can split
//    in place if an items-only overlay ever lands.
//  - "Shop & Trade" became "Trade": uxd2 (ADR-0161 D5) deleted the global shop/heal hotkeys
//    on Drew's explicit instruction, so Shop and Heal are world-contextual and reachable
//    only through Interact. A "first shop" leaf would resurrect exactly what was removed.
//  - `battleView` / `dialogueView` are registry members but NOT leaves — context overlays
//    that preempt the menu rather than destinations you navigate to.
//  - Settings is a future slot, deliberately not built.
//
// DEPTH IS STRUCTURAL: `MenuNavState` is a two-member union, so a third level is
// unrepresentable. There is no back-stack array to cap at 2 — that would be strictly more
// code and strictly weaker.
import type { OverlayId } from './overlayRegistry';

export type MenuCategoryId = 'party' | 'world' | 'trade' | 'compete' | 'system';

export type MenuLeafId =
  | 'box'
  | 'backpack'
  | 'evolve'
  | 'interact'
  | 'journal'
  | 'incomingTrade'
  | 'offerTrade'
  | 'pvp'
  | 'leaderboard'
  | 'rename'
  | 'help';

export interface MenuLeafDef {
  readonly id: MenuLeafId;
  readonly title: string;
  /** MUST equal a `key` in helpModel's CONTROLS SSOT (MM-KEYGLYPH-FROM-HELP-SSOT).
   *  Scoped to the key TOKEN, not the action prose: the SSOT copy says "nearby" for
   *  P and O, but availability is online-player EXISTENCE, not proximity. */
  readonly keyGlyph: string;
  /** The registry member this leaf opens, or `'interact'` for the KeyT dispatch,
   *  whose real target is resolved at runtime (talk / shop / heal). */
  readonly target: OverlayId | 'interact';
}

export interface MenuCategoryDef {
  readonly id: MenuCategoryId;
  readonly title: string;
  readonly leaves: readonly MenuLeafDef[];
}

export const MENU_TREE: readonly MenuCategoryDef[] = [
  {
    id: 'party',
    title: 'Party',
    leaves: [
      { id: 'box', title: 'Monster Box', keyGlyph: 'B', target: 'boxView' },
      { id: 'backpack', title: 'Backpack & Raising', keyGlyph: 'I', target: 'raisingView' },
      { id: 'evolve', title: 'Evolve & Fuse', keyGlyph: 'E', target: 'evolutionView' },
    ],
  },
  {
    id: 'world',
    title: 'World',
    leaves: [
      { id: 'interact', title: 'Interact', keyGlyph: 'T', target: 'interact' },
      { id: 'journal', title: 'Journal (Quests)', keyGlyph: 'Q', target: 'questLogView' },
    ],
  },
  {
    id: 'trade',
    title: 'Trade',
    leaves: [
      { id: 'incomingTrade', title: 'Incoming Trade', keyGlyph: 'U', target: 'tradeView' },
      { id: 'offerTrade', title: 'Offer a Trade', keyGlyph: 'O', target: 'tradeProposeView' },
    ],
  },
  {
    id: 'compete',
    title: 'Compete',
    leaves: [
      { id: 'pvp', title: 'PvP Challenge', keyGlyph: 'P', target: 'pvpView' },
      { id: 'leaderboard', title: 'Leaderboard', keyGlyph: 'L', target: 'leaderboardView' },
    ],
  },
  {
    id: 'system',
    title: 'System',
    leaves: [
      { id: 'rename', title: 'Rename Profile', keyGlyph: 'N', target: 'renameView' },
      { id: 'help', title: 'Controls & Help', keyGlyph: '?', target: 'helpView' },
    ],
  },
];

/**
 * The three contextual facts the menu needs, as plain booleans — the core never touches
 * the store (that binding lives in `main.ts`'s `menuAvailability()`).
 *
 * `hasPvpTargets` / `hasTradeTargets` are ONLINE-PLAYER EXISTENCE, deliberately NOT a
 * proximity check: the help copy reads "a nearby player", but no reducer has a proximity
 * rule for challenge or trade-propose, so a distance test would grey both leaves out
 * permanently.
 */
export interface MenuAvailability {
  readonly hasInteractTarget: boolean;
  readonly hasTradeTargets: boolean;
  readonly hasPvpTargets: boolean;
}

/** Only Interact / Offer / PvP are contextual; every other leaf is always reachable. */
export function leafAvailable(leaf: MenuLeafId, a: MenuAvailability): boolean {
  switch (leaf) {
    case 'interact':
      return a.hasInteractTarget;
    case 'offerTrade':
      return a.hasTradeTargets;
    case 'pvp':
      return a.hasPvpTargets;
    default:
      return true;
  }
}

export type MenuNavState =
  | { readonly level: 'categories'; readonly categoryIndex: number }
  | { readonly level: 'leaves'; readonly categoryIndex: number; readonly leafIndex: number };

export const MENU_INITIAL: MenuNavState = { level: 'categories', categoryIndex: 0 };

export type MenuInput =
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'enter' }
  | { readonly kind: 'left' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'hover'; readonly index: number }
  | { readonly kind: 'click'; readonly index: number };

export type MenuEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'close' }
  | { readonly kind: 'activate'; readonly leaf: MenuLeafDef };

export interface MenuStep {
  readonly state: MenuNavState;
  readonly effect: MenuEffect;
}

/** Clamp a possibly-out-of-range stored index onto a real row. Used on READ so a stale
 *  state can never index past the end — `buildMenuViewModel` runs on the KeyM open path
 *  and a throw there would leave the overlay painted with stale rows forever. */
function clamp(i: number, len: number): number {
  if (!Number.isFinite(i)) return 0;
  return Math.min(Math.max(Math.trunc(i), 0), Math.max(len - 1, 0));
}

/** Validate an index supplied by the DOM (`data-menu-index`). NOT a bounds-only check:
 *  `Number(undefined)` is NaN, which fails BOTH `< 0` and `>= len`, so a bounds-only
 *  guard would pass NaN straight through to `MENU_TREE[NaN]`. */
function validIndex(i: number, len: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < len;
}

function categoryAt(index: number): MenuCategoryDef {
  // MENU_TREE is a non-empty literal, so the clamped read is always defined.
  return MENU_TREE[clamp(index, MENU_TREE.length)] as MenuCategoryDef;
}

/** Row count at the level the state is currently on. */
function rowCount(s: MenuNavState): number {
  return s.level === 'categories' ? MENU_TREE.length : categoryAt(s.categoryIndex).leaves.length;
}

function currentIndex(s: MenuNavState): number {
  return clamp(s.level === 'categories' ? s.categoryIndex : s.leafIndex, rowCount(s));
}

function withIndex(s: MenuNavState, index: number): MenuNavState {
  return s.level === 'categories'
    ? { level: 'categories', categoryIndex: index }
    : {
        level: 'leaves',
        categoryIndex: clamp(s.categoryIndex, MENU_TREE.length),
        leafIndex: index,
      };
}

/** Enter/activate at whatever level the (already index-corrected) state sits on. */
function enterAt(s: MenuNavState, a: MenuAvailability): MenuStep {
  if (s.level === 'categories') {
    // Always start a submenu at leaf 0 — never resume a stale leafIndex from a prior visit.
    return {
      state: { level: 'leaves', categoryIndex: currentIndex(s), leafIndex: 0 },
      effect: { kind: 'none' },
    };
  }
  const leaf = categoryAt(s.categoryIndex).leaves[currentIndex(s)] as MenuLeafDef;
  // Grey-not-hide: an unavailable leaf stays selected and rendered, it just does not route.
  if (!leafAvailable(leaf.id, a)) return { state: s, effect: { kind: 'none' } };
  // Activate ALWAYS resets to the top. This is the mechanism that makes AC-17 true by
  // construction: nothing remembers a pending menu, so Escape from the overlay the menu
  // opened returns to the world in one press and can never re-open the menu.
  return { state: MENU_INITIAL, effect: { kind: 'activate', leaf } };
}

/**
 * The whole nav reducer. TOTAL — it runs inside the window keydown listener and inside two
 * delegated DOM listeners, where a single uncaught throw permanently kills the menu (and,
 * from the keydown path, every hotkey after it).
 */
export function menuStep(s: MenuNavState, i: MenuInput, a: MenuAvailability): MenuStep {
  const len = rowCount(s);
  switch (i.kind) {
    case 'up':
      return { state: withIndex(s, (currentIndex(s) - 1 + len) % len), effect: { kind: 'none' } };
    case 'down':
      return { state: withIndex(s, (currentIndex(s) + 1) % len), effect: { kind: 'none' } };
    case 'enter':
      return enterAt(s, a);
    case 'hover':
      // Move the highlight to the pointed row; never activate (a mouse sweep must not fire
      // every overlay in turn). An out-of-range index is a no-op, not a phantom row.
      if (!validIndex(i.index, len)) return { state: s, effect: { kind: 'none' } };
      return { state: withIndex(s, i.index), effect: { kind: 'none' } };
    case 'click': {
      // Set the index from the CLICKED row, then enter. A touch/tap fires no `mouseover`,
      // so acting on the previously-selected row would open the wrong thing.
      if (!validIndex(i.index, len)) return { state: s, effect: { kind: 'none' } };
      return enterAt(withIndex(s, i.index), a);
    }
    case 'left':
      // Back one level. At the top there is no level to pop, and closing here would let a
      // stray ArrowLeft dismiss the menu mid-navigation.
      if (s.level === 'categories') return { state: s, effect: { kind: 'none' } };
      return {
        state: { level: 'categories', categoryIndex: clamp(s.categoryIndex, MENU_TREE.length) },
        effect: { kind: 'none' },
      };
    case 'escape':
      // From a submenu: pop, preserving the category selection (one press per level).
      if (s.level === 'leaves') {
        return {
          state: { level: 'categories', categoryIndex: clamp(s.categoryIndex, MENU_TREE.length) },
          effect: { kind: 'none' },
        };
      }
      // At the top: close, and reset — a close that kept categoryIndex is how the menu
      // re-opens inside a stale selection via the KeyM toggle path.
      return { state: MENU_INITIAL, effect: { kind: 'close' } };
  }
}

/**
 * Physical-key → nav input. `code`-only (never `key`): `key` is layout- and Shift-dependent.
 * Anything unrecognised returns `undefined` so the keydown handler falls through instead of
 * the menu swallowing unrelated hotkeys.
 *
 * Escape is routed through here rather than matched inline in `main.ts`, because the
 * literal `e.code === 'Escape'` appearing before the real Escape branches would silently
 * re-anchor three existing fixed-window wiring teeth (see W-UXD3-ESCAPE-ANCHOR-FIRST).
 */
export function menuKeyInput(code: string): MenuInput | undefined {
  switch (code) {
    case 'ArrowUp':
    case 'KeyW':
      return { kind: 'up' };
    case 'ArrowDown':
    case 'KeyS':
      return { kind: 'down' };
    case 'ArrowRight':
    case 'KeyD':
    case 'Enter':
      return { kind: 'enter' };
    case 'ArrowLeft':
    case 'KeyA':
      return { kind: 'left' };
    case 'Escape':
      return { kind: 'escape' };
    default:
      return undefined;
  }
}

export interface MenuRowVm {
  readonly index: number;
  readonly title: string;
  /** `null` on category rows — only leaves advertise a shortcut. */
  readonly keyGlyph: string | null;
  readonly selected: boolean;
  readonly disabled: boolean;
}

export interface MenuViewModel {
  readonly level: 'categories' | 'leaves';
  readonly heading: string;
  readonly rows: readonly MenuRowVm[];
  readonly backHint: string;
}

/**
 * Render model for the current state. Clamps rather than indexing out of bounds, and
 * NEVER filters: an unavailable leaf is rendered `disabled`, because hiding a leaf exactly
 * when the player is exploring toward its precondition is the anti-discoverability failure
 * this slice exists to fix.
 */
export function buildMenuViewModel(s: MenuNavState, a: MenuAvailability): MenuViewModel {
  const selected = currentIndex(s);
  if (s.level === 'categories') {
    return {
      level: 'categories',
      heading: 'Menu',
      rows: MENU_TREE.map((c, index) => ({
        index,
        title: c.title,
        keyGlyph: null,
        selected: index === selected,
        disabled: false,
      })),
      backHint: 'Escape — close',
    };
  }
  const category = categoryAt(s.categoryIndex);
  return {
    level: 'leaves',
    heading: category.title,
    rows: category.leaves.map((leaf, index) => ({
      index,
      title: leaf.title,
      keyGlyph: leaf.keyGlyph,
      selected: index === selected,
      disabled: !leafAvailable(leaf.id, a),
    })),
    backHint: 'Escape / ← — back',
  };
}
