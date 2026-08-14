// ui/menuModel.test.ts — uxd3-a RED gating tests for the PURE two-level menu-nav core.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M-postgate-ux-design.spec.md §uxd3 — AC-11, AC-13..AC-18.
//   docs/uxd3-plan.md §3 (tree + API + pinned semantics) and §6, AS AMENDED BY §A:
//     A11 hover/click carry their OWN index: they FIRST set the level's index to
//         input.index, and `click` THEN applies `enter`. menuStep is TOTAL — an
//         out-of-range index yields {state: s, effect:{kind:'none'}} — and
//         buildMenuViewModel CLAMPS rather than indexing out of bounds.
//     A13 AC-18 needs an explicit MenuLeafId -> keyGlyph table, not just membership.
//     A15 there is NO MenuInput.right variant (ArrowRight maps to `enter`), and
//         menuKeyInput takes ONLY `code` (the `key` parameter is dropped).
//
// RED REASON: client/src/ui/menuModel.ts DOES NOT EXIST. Every test in this file fails at
// module-link time ("Failed to resolve import './menuModel'") until the implementer ships
// it; MM-KEYGLYPH-FROM-HELP-SSOT additionally stays red until helpModel.ts gains its
// { key: 'M', action: 'Open the main menu' } row (plan T1.5). Nothing below guesses at an
// API shape — the contract is the one the plan hands the specialist verbatim.
//
// AMENDED by M21b-2 (ADR-0182 D17 / spec AUTH task checklist): the System category gains an
// `'account'` leaf (keyGlyph 'C', target 'claimView'), taking the tree to 5 categories / 12
// leaves. THE MENU LEAF AND THE DIRECT KeyC HOTKEY BOTH SHIP — they are not alternatives: the
// hotkey is the fast path AND the pre-join path (main.ts's KeyM front door carries
// `identity !== ''`, so the menu is dead before join, while a failed FIRST sign-in must still
// be able to reach the claim/account UI — AUTH-48). The leaf is the discoverable path, and
// AC-18's SSOT rule means adding it MECHANICALLY forces a `C` row in helpModel.ts CONTROLS
// (and, through playtestControlsDoc.test.ts's bidirectional A1/A3 gate, in docs/PLAYTEST.md).
//
// PINNED CONTRACT (the specialist matches this EXACTLY):
//   export type MenuCategoryId = 'party' | 'world' | 'trade' | 'compete' | 'system';
//   export type MenuLeafId = 'box' | 'backpack' | 'evolve' | 'interact' | 'journal'
//     | 'incomingTrade' | 'offerTrade' | 'pvp' | 'leaderboard' | 'rename' | 'account' | 'help';
//   export interface MenuLeafDef { id; title; keyGlyph; target: OverlayId | 'interact' }
//   export interface MenuCategoryDef { id; title; leaves: readonly MenuLeafDef[] }
//   export const MENU_TREE: readonly MenuCategoryDef[];            // 5 categories, 12 leaves
//   export interface MenuAvailability {
//     hasInteractTarget: boolean; hasTradeTargets: boolean; hasPvpTargets: boolean }
//   export function leafAvailable(leaf: MenuLeafId, a: MenuAvailability): boolean;
//   export type MenuNavState =
//     | { level: 'categories'; categoryIndex: number }
//     | { level: 'leaves'; categoryIndex: number; leafIndex: number };
//   export const MENU_INITIAL: MenuNavState;                       // categories / 0
//   export type MenuInput = { kind:'up' } | { kind:'down' } | { kind:'enter' }
//     | { kind:'left' } | { kind:'escape' }
//     | { kind:'hover'; index:number } | { kind:'click'; index:number };
//   export type MenuEffect = { kind:'none' } | { kind:'close' }
//     | { kind:'activate'; leaf: MenuLeafDef };
//   export interface MenuStep { state: MenuNavState; effect: MenuEffect }
//   export function menuStep(s: MenuNavState, i: MenuInput, a: MenuAvailability): MenuStep;
//   export function menuKeyInput(code: string): MenuInput | undefined;   // arity 1 (A15)
//   export interface MenuRowVm {
//     index:number; title:string; keyGlyph:string|null; selected:boolean; disabled:boolean }
//   export interface MenuViewModel {
//     level:'categories'|'leaves'; heading:string; rows: readonly MenuRowVm[]; backHint:string }
//   export function buildMenuViewModel(s: MenuNavState, a: MenuAvailability): MenuViewModel;
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan only.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildHelpViewModel } from './helpModel';
import {
  buildMenuViewModel,
  leafAvailable,
  MENU_INITIAL,
  MENU_TREE,
  type MenuAvailability,
  type MenuLeafId,
  type MenuNavState,
  menuKeyInput,
  menuStep,
} from './menuModel';

// ---------------------------------------------------------------------------
// Fixtures. Availability enters the core as three PLAIN BOOLEANS (anti-pattern 7:
// menuModel never touches the store), so no mock of any kind is needed here.
// ---------------------------------------------------------------------------

const ALL: MenuAvailability = {
  hasInteractTarget: true,
  hasTradeTargets: true,
  hasPvpTargets: true,
};
const NONE: MenuAvailability = {
  hasInteractTarget: false,
  hasTradeTargets: false,
  hasPvpTargets: false,
};

/** Category positions, pinned by MM-TREE-SHAPE below and used by every nav case. */
const PARTY = 0;
const WORLD = 1;
const TRADE = 2;
const COMPETE = 3;
const SYSTEM = 4;

const cats = (categoryIndex: number): MenuNavState => ({ level: 'categories', categoryIndex });
const leaves = (categoryIndex: number, leafIndex: number): MenuNavState => ({
  level: 'leaves',
  categoryIndex,
  leafIndex,
});

/**
 * The ONLY three contextual leaves (spec `:153`), and which availability flag each reads.
 * Hard-coded rather than derived from leafAvailable, so this table is an INDEPENDENT
 * oracle for both MM-AVAILABILITY-SEMANTICS and MM-DISABLED-LEAF-ALWAYS-RENDERED.
 */
const CONTEXTUAL: Readonly<Partial<Record<MenuLeafId, keyof MenuAvailability>>> = {
  interact: 'hasInteractTarget',
  offerTrade: 'hasTradeTargets',
  pvp: 'hasPvpTargets',
};

function expectedDisabled(id: MenuLeafId, a: MenuAvailability): boolean {
  const flag = CONTEXTUAL[id];
  return flag === undefined ? false : !a[flag];
}

/** AC-18 / A13: the explicit MenuLeafId -> keyGlyph expectation table (12 pairs since M21b-2).
 *  The order is `flat` order (MENU_TREE flattened), so it also pins WHERE the new leaf sits. */
const EXPECTED_KEY_GLYPHS: readonly (readonly [MenuLeafId, string])[] = [
  ['box', 'B'],
  ['backpack', 'I'],
  ['evolve', 'E'],
  ['interact', 'T'],
  ['journal', 'Q'],
  ['incomingTrade', 'U'],
  ['offerTrade', 'O'],
  ['pvp', 'P'],
  ['leaderboard', 'L'],
  ['rename', 'N'],
  // ★ M21b-2 (ADR-0182): 'C' for Claim/aCcount. Deliberately NOT 'A' — `KeyA` is a MOVEMENT
  // key (menuKeyInput maps it to `left`, and KEY_DIR binds it in the world), so an 'A' glyph
  // would advertise a shortcut that walks the player left instead. 'C' was verified UNBOUND
  // in main.ts before this slice, the same check KeyM got in uxd3.
  ['account', 'C'],
  ['help', '?'],
];

// ===========================================================================
// BLOCK A — the tree itself (the taxonomy decided in plan §3).
// ===========================================================================

describe('menuModel — MENU_TREE', () => {
  it('MM-TREE-SHAPE BITES: 5 categories / 12 leaves, with Backpack and Journal as LEAVES and no Shop or Heal leaf', () => {
    // WRONG IMPL KILLED (1): a 6th "Settings" category (anti-pattern 10 — future slot only).
    // WRONG IMPL KILLED (2): a top-level "Backpack" or "Journal" CATEGORY — each would hold a
    //   single leaf pointing at raisingView/questLogView, i.e. a duplicated source of truth and
    //   a menu that promises a screen the game does not have (plan §3).
    // WRONG IMPL KILLED (3): a Shop or Heal leaf (anti-pattern 8) — uxd2/ADR-0161 D5 deleted
    //   the global KeyG/KeyH on Drew's explicit "Do not keep"; a menu leaf that opens "the first
    //   shop" globally resurrects exactly that. Shop and Heal are world-contextual, reachable
    //   only through Interact.
    // WRONG IMPL KILLED (4): battleView/dialogueView/menuView appearing as leaves — they are
    //   registry members but context overlays, never menu destinations (spec `:129`).
    expect(MENU_TREE.map((c) => c.id)).toEqual(['party', 'world', 'trade', 'compete', 'system']);
    expect(MENU_TREE.map((c) => c.title)).toEqual(['Party', 'World', 'Trade', 'Compete', 'System']);

    // ★ M21b-2 (ADR-0182): the 12th leaf. It joins SYSTEM (beside Rename Profile and Controls
    // & Help), not a new 6th category — anti-pattern 10 forbids a category per feature, and
    // "your account" is exactly the kind of session-level chrome System already holds.
    // Positioned BETWEEN rename and help deliberately: Help stays LAST because it is the
    // recovery affordance a lost player scans to the bottom for.
    const flat = MENU_TREE.flatMap((c) => c.leaves);
    expect(flat.length, 'ANTI-VACUITY: the tree must hold exactly 12 leaves').toBe(12);
    expect(new Set(flat.map((l) => l.id)).size, 'leaf ids must be unique').toBe(12);

    expect(
      MENU_TREE.map((c) => c.leaves.map((l) => l.id)),
      'the exact leaf assignment per category (plan §3, + M21b-2`s account leaf in System)',
    ).toEqual([
      ['box', 'backpack', 'evolve'],
      ['interact', 'journal'],
      ['incomingTrade', 'offerTrade'],
      ['pvp', 'leaderboard'],
      ['rename', 'account', 'help'],
    ]);

    expect(flat.map((l) => l.title)).toEqual([
      'Monster Box',
      'Backpack & Raising',
      'Evolve & Fuse',
      'Interact',
      'Journal (Quests)',
      'Incoming Trade',
      'Offer a Trade',
      'PvP Challenge',
      'Leaderboard',
      'Rename Profile',
      'Account & Sign-in',
      'Controls & Help',
    ]);

    expect(
      flat.map((l) => l.target),
      'each leaf points at its registry member; Interact dispatches (talk/shop/heal). The ' +
        'account leaf targets `claimView` — the registry member (GUARD_ONLY, G19) — and NOT ' +
        '`sessionView`, which is registry-EXTERNAL by design (ADR-0182 D17) and therefore not ' +
        'a legal MenuLeafDef.target at all',
    ).toEqual([
      'boxView',
      'raisingView',
      'evolutionView',
      'interact',
      'questLogView',
      'tradeView',
      'tradeProposeView',
      'pvpView',
      'leaderboardView',
      'renameView',
      'claimView',
      'helpView',
    ]);
  });

  it('MM-KEYGLYPH-FROM-HELP-SSOT BITES: every leaf glyph matches the 12-pair table AND is documented in the helpModel CONTROLS SSOT, incl. the M and C rows (AC-18)', () => {
    // WRONG IMPL KILLED (1): a leaf advertising a key the help overlay does not document — the
    //   menu would teach a shortcut that does nothing.
    // WRONG IMPL KILLED (2, the A13 reason this test is not membership-only): a Journal leaf
    //   advertising 'B'. 'B' IS in the SSOT, so a pure membership check passes while the menu
    //   displays a flatly wrong key. AC-18 requires failure "if any displayed key diverges", so
    //   the exact per-leaf table below is the primary assertion.
    // WRONG IMPL KILLED (3): shipping the menu without adding "M — Open the main menu" to the
    //   CONTROLS SSOT — KeyM would be the one load-bearing key the help overlay never mentions,
    //   and the front door would be undiscoverable (spec `:125`).
    //
    // The SSOT pull is scoped to the KEY TOKEN, not the action prose (spec residual `:173`).
    const ssotKeys = buildHelpViewModel().controls.map((c) => c.key);
    expect(ssotKeys.length, 'ANTI-VACUITY: the CONTROLS SSOT must be non-empty').toBeGreaterThan(
      10,
    );

    const flat = MENU_TREE.flatMap((c) => c.leaves);
    expect(
      flat.map((l) => [l.id, l.keyGlyph]),
      'the exact MenuLeafId -> keyGlyph table (A13)',
    ).toEqual(EXPECTED_KEY_GLYPHS.map(([id, glyph]) => [id, glyph]));

    for (const leaf of flat) {
      expect(
        ssotKeys.includes(leaf.keyGlyph),
        `leaf '${leaf.id}' advertises key '${leaf.keyGlyph}', which the helpModel CONTROLS ` +
          'SSOT does not document',
      ).toBe(true);
    }

    expect(
      ssotKeys.includes('M'),
      "helpModel's CONTROLS SSOT must document the 'M' menu front-door key (spec `:125`)",
    ).toBe(true);
    // ★ M21b-2. Stated on its own line for the same reason the 'M' clause is: the per-leaf
    // loop above reports "leaf 'account' advertises key 'C', which the SSOT does not
    // document", which is true but buries the ACTION. WRONG IMPL KILLED: shipping the account
    // leaf and the KeyC handler without adding the CONTROLS row — KeyC would be the one
    // load-bearing key the help overlay never mentions, and (through
    // playtestControlsDoc.test.ts's bidirectional A1/A3 gate) docs/PLAYTEST.md would silently
    // disagree with the shipped keymap.
    expect(
      ssotKeys.includes('C'),
      "helpModel's CONTROLS SSOT must document the 'C' account/claim key (ADR-0182). Adding " +
        'this row is NOT optional bookkeeping: it is what makes the menu leaf`s advertised ' +
        'glyph true, and it mechanically forces the matching docs/PLAYTEST.md §3 row',
    ).toBe(true);
  });

  it('MM-AVAILABILITY-SEMANTICS BITES: only Interact / Offer / PvP are contextual, and each reads its OWN flag (AC-16)', () => {
    // WRONG IMPL KILLED (1): the SSOT-copy trap (anti-pattern 9) — the help text says
    //   "Challenge a NEARBY player", but Offer/PvP availability is ONLINE-PLAYER EXISTENCE, not
    //   proximity. A proximity implementation greys the leaf out for the whole session in a
    //   two-player playtest where the other tester is across the map.
    // WRONG IMPL KILLED (2): a leaf reading the WRONG flag (pvp reading hasTradeTargets) —
    //   swapping them keeps every "some leaf is disabled" assertion green.
    // WRONG IMPL KILLED (3): making a non-contextual leaf (Box, Journal, Help, Rename...)
    //   conditional — Help in particular must NEVER be greyed, it is the recovery affordance.
    const flat = MENU_TREE.flatMap((c) => c.leaves);
    expect(flat.length, 'ANTI-VACUITY').toBe(12);

    // One flag true at a time: only the leaf that owns the flag flips.
    const singles: readonly (keyof MenuAvailability)[] = [
      'hasInteractTarget',
      'hasTradeTargets',
      'hasPvpTargets',
    ];
    let contextualSeen = 0;
    for (const leaf of flat) {
      expect(
        leafAvailable(leaf.id, ALL),
        `'${leaf.id}' must be available when everything is available`,
      ).toBe(true);
      expect(leafAvailable(leaf.id, NONE), `'${leaf.id}' availability with no context`).toBe(
        CONTEXTUAL[leaf.id] === undefined,
      );
      if (CONTEXTUAL[leaf.id] !== undefined) contextualSeen += 1;
    }
    expect(contextualSeen, 'exactly 3 leaves are contextual').toBe(3);

    for (const flag of singles) {
      const a: MenuAvailability = { ...NONE, [flag]: true };
      for (const leaf of flat) {
        expect(leafAvailable(leaf.id, a), `'${leaf.id}' with only ${flag} set`).toBe(
          !expectedDisabled(leaf.id, a),
        );
      }
    }
  });
});

// ===========================================================================
// BLOCK B — navigation (AC-11, AC-13, AC-14).
// ===========================================================================

describe('menuModel — navigation', () => {
  it('MM-INITIAL-IS-CATEGORIES BITES: MENU_INITIAL is the top-level list at index 0 (AC-11)', () => {
    // WRONG IMPL KILLED: a MENU_INITIAL that starts inside a submenu — KeyM would open the
    // player straight into Party instead of the category list the spec requires.
    expect(MENU_INITIAL).toEqual({ level: 'categories', categoryIndex: 0 });
  });

  it('MM-NAV-CATEGORY-UPDOWN-WRAPS BITES: up/down move one row and WRAP over the 5 categories (AC-13)', () => {
    // WRONG IMPL KILLED (1): a clamp instead of a wrap — from the last row, Down would dead-end
    //   (and menu nav does NOT key-repeat, so the player feels it immediately).
    // WRONG IMPL KILLED (2): an off-by-one modulo, e.g. `(i - 1) % n` for `up`, which yields
    //   -1 in JavaScript rather than n-1.
    expect(menuStep(cats(0), { kind: 'down' }, ALL)).toEqual({
      state: cats(1),
      effect: { kind: 'none' },
    });
    expect(menuStep(cats(4), { kind: 'down' }, ALL)).toEqual({
      state: cats(0),
      effect: { kind: 'none' },
    });
    expect(menuStep(cats(0), { kind: 'up' }, ALL)).toEqual({
      state: cats(4),
      effect: { kind: 'none' },
    });
    expect(menuStep(cats(2), { kind: 'up' }, ALL)).toEqual({
      state: cats(1),
      effect: { kind: 'none' },
    });
  });

  it('MM-NAV-LEAF-UPDOWN-WRAPS BITES: up/down wrap within the CURRENT category leaf count, not a fixed 5 (AC-13)', () => {
    // WRONG IMPL KILLED: wrapping modulo MENU_TREE.length (5) at the leaf level — World has 2
    // leaves, so Down from leaf 1 would land on the non-existent leaf 2 and render nothing.
    expect(menuStep(leaves(WORLD, 0), { kind: 'down' }, ALL).state).toEqual(leaves(WORLD, 1));
    expect(menuStep(leaves(WORLD, 1), { kind: 'down' }, ALL).state).toEqual(leaves(WORLD, 0));
    expect(menuStep(leaves(WORLD, 0), { kind: 'up' }, ALL).state).toEqual(leaves(WORLD, 1));
    expect(menuStep(leaves(PARTY, 0), { kind: 'up' }, ALL).state).toEqual(leaves(PARTY, 2));
  });

  it('MM-NAV-ENTER-OPENS-SUBMENU BITES: enter (and ArrowRight/KeyD via the mapper) opens the SELECTED category at leaf 0 (AC-13)', () => {
    // WRONG IMPL KILLED (1): an enter that opens category 0 regardless of the selection.
    // WRONG IMPL KILLED (2): an enter that preserves a stale leafIndex from a previous visit —
    //   entering Compete (2 leaves) after leaving System at leaf 1 must still start at leaf 0.
    // WRONG IMPL KILLED (3): an enter that emits an `activate` effect at the CATEGORY level.
    expect(menuStep(cats(COMPETE), { kind: 'enter' }, ALL)).toEqual({
      state: leaves(COMPETE, 0),
      effect: { kind: 'none' },
    });
    // A15: there is no MenuInput.right — ArrowRight/KeyD/Enter all map to `enter`.
    expect(menuKeyInput('ArrowRight')).toEqual({ kind: 'enter' });
    expect(menuKeyInput('KeyD')).toEqual({ kind: 'enter' });
    expect(menuKeyInput('Enter')).toEqual({ kind: 'enter' });
  });

  it('MM-NAV-HOVER-MOVES-ONLY BITES: hover sets the level index from input.index and NEVER activates (AC-13 + A11)', () => {
    // WRONG IMPL KILLED (1): a hover that also activates — sweeping the mouse across the menu
    //   would fire every overlay in turn.
    // WRONG IMPL KILLED (2): a hover that ignores input.index and just re-emits the current
    //   selection (A11) — the highlight would never follow the pointer.
    expect(menuStep(cats(0), { kind: 'hover', index: 3 }, ALL)).toEqual({
      state: cats(3),
      effect: { kind: 'none' },
    });
    expect(menuStep(leaves(PARTY, 0), { kind: 'hover', index: 2 }, ALL)).toEqual({
      state: leaves(PARTY, 2),
      effect: { kind: 'none' },
    });
    // Hovering a DISABLED leaf still moves the selection (grey-not-hide is still selectable).
    expect(menuStep(leaves(WORLD, 1), { kind: 'hover', index: 0 }, NONE)).toEqual({
      state: leaves(WORLD, 0),
      effect: { kind: 'none' },
    });
  });

  it('MM-CLICK-SETS-INDEX-THEN-ENTERS BITES: a click on an UNSELECTED row acts on the CLICKED row, not the selected one (A11)', () => {
    // WRONG IMPL KILLED: the §3-as-written semantics, where enter/click acts on the CURRENTLY
    // SELECTED index. A click on an unselected row would then open the WRONG category. In a
    // real browser it accidentally looks right because `mouseover` fires first and moves the
    // selection — but a bare synthetic click (and a touch/tap, which fires no mouseover) does
    // not, so the shipped menu opens Party no matter which row the player taps.
    expect(menuStep(cats(0), { kind: 'click', index: COMPETE }, ALL)).toEqual({
      state: leaves(COMPETE, 0),
      effect: { kind: 'none' },
    });

    // At the leaf level a click = set index + enter, so it activates the CLICKED leaf.
    const clicked = menuStep(leaves(PARTY, 0), { kind: 'click', index: 2 }, ALL);
    expect(clicked.effect).toEqual({ kind: 'activate', leaf: MENU_TREE[PARTY]!.leaves[2] });
    expect(clicked.state, 'activate always resets — nothing remembers a pending menu').toEqual(
      MENU_INITIAL,
    );

    // Clicking a DISABLED leaf moves the selection but does NOT route (AC-15).
    const dead = menuStep(leaves(WORLD, 1), { kind: 'click', index: 0 }, NONE);
    expect(dead.effect).toEqual({ kind: 'none' });
    expect(dead.state, 'the click still moved the selection onto the greyed row').toEqual(
      leaves(WORLD, 0),
    );
  });

  it('MM-NAV-BACK-PRESERVES-CATEGORY BITES: Escape/Left from a submenu pops to the category list with the SAME category selected (AC-14)', () => {
    // WRONG IMPL KILLED (1): a back that returns to MENU_INITIAL — the player would be thrown
    //   to Party every time they backed out of System.
    // WRONG IMPL KILLED (2): an Escape at the leaf level that CLOSES the whole menu — that is
    //   the two-press-to-world regression AC-14 exists to prevent (Escape pops, then closes).
    for (const input of [{ kind: 'escape' } as const, { kind: 'left' } as const]) {
      expect(menuStep(leaves(SYSTEM, 1), input, ALL), `${input.kind} from a submenu`).toEqual({
        state: cats(SYSTEM),
        effect: { kind: 'none' },
      });
    }
  });

  it('MM-ESCAPE-TOP-CLOSES BITES: Escape at the top level emits `close` and resets to MENU_INITIAL (AC-14)', () => {
    // WRONG IMPL KILLED (1): an Escape at the top level that emits `none` — the menu would be
    //   unclosable by keyboard (and Escape is deliberately NOT overloaded to OPEN it, so the
    //   player would be trapped).
    // WRONG IMPL KILLED (2): a close that keeps categoryIndex — combined with the KeyM
    //   toggle-close path this is how the menu re-opens inside a stale selection.
    expect(menuStep(cats(TRADE), { kind: 'escape' }, ALL)).toEqual({
      state: MENU_INITIAL,
      effect: { kind: 'close' },
    });
    expect(menuStep(MENU_INITIAL, { kind: 'escape' }, NONE)).toEqual({
      state: MENU_INITIAL,
      effect: { kind: 'close' },
    });
  });

  it('MM-LEFT-AT-TOP-IS-NOOP BITES: Left at the category list neither closes the menu nor moves the selection', () => {
    // WRONG IMPL KILLED: a `left` that falls through to the same arm as `escape` and CLOSES the
    // menu. Left is a "back one level" key; at the top there is no level to pop, and closing on
    // it would make an accidental ArrowLeft dismiss the menu mid-navigation.
    expect(menuStep(cats(TRADE), { kind: 'left' }, ALL)).toEqual({
      state: cats(TRADE),
      effect: { kind: 'none' },
    });
  });

  it('MM-STEP-TOTAL-OOB-INDEX BITES: an out-of-range hover/click index is a no-op, never a throw or a phantom row (A11)', () => {
    // WRONG IMPL KILLED (1): `MENU_TREE[i].leaves` / `leaves[i].id` on an unvalidated index —
    //   the DOM shell reads `data-menu-index` off the clicked <li>, and a click landing between
    //   a `replaceChildren` re-render and the read can carry a stale index from the PREVIOUS
    //   level (5 categories vs 2 leaves). An unguarded read throws inside a DOM event handler,
    //   which silently kills the listener for the rest of the session.
    // WRONG IMPL KILLED (2): a BOUNDS-ONLY guard (`i < 0 || i >= len`). `Number(undefined)` is
    //   NaN — exactly what a missing or misspelt data-menu-index yields — and NaN fails BOTH
    //   comparisons, so a bounds-only guard passes it straight through to `MENU_TREE[NaN]`.
    //   The validation must be `Number.isInteger(i) && 0 <= i && i < len`.
    const oob: readonly number[] = [-1, 5, 99, 1.5, Number.NaN];
    for (const index of oob) {
      expect(menuStep(cats(2), { kind: 'hover', index }, ALL), `hover ${index}`).toEqual({
        state: cats(2),
        effect: { kind: 'none' },
      });
      expect(menuStep(cats(2), { kind: 'click', index }, ALL), `click ${index}`).toEqual({
        state: cats(2),
        effect: { kind: 'none' },
      });
    }
    // World has only 2 leaves: index 2 is out of range there even though it is a valid
    // CATEGORY index — the bound must come from the CURRENT level, not from MENU_TREE.length.
    expect(menuStep(leaves(WORLD, 1), { kind: 'click', index: 2 }, ALL)).toEqual({
      state: leaves(WORLD, 1),
      effect: { kind: 'none' },
    });
  });
});

// ===========================================================================
// BLOCK C — activation (AC-15, AC-17).
// ===========================================================================

describe('menuModel — leaf activation', () => {
  it('MM-LEAF-ACTIVATE-EMITS-ACTIVATE BITES: every available leaf emits activate carrying its FULL definition (AC-15)', () => {
    // WRONG IMPL KILLED (1): an effect carrying only the leaf id — main.ts's activateMenuLeaf
    //   switch needs the def (target/keyGlyph) and the exhaustive-switch compiler flag depends
    //   on the union type flowing through.
    // WRONG IMPL KILLED (2): an off-by-one that activates the neighbouring leaf (opening the
    //   Evolution overlay from the Backpack row is a silent, plausible-looking wrong open).
    let activated = 0;
    for (let c = 0; c < MENU_TREE.length; c += 1) {
      const cat = MENU_TREE[c]!;
      for (let i = 0; i < cat.leaves.length; i += 1) {
        const step = menuStep(leaves(c, i), { kind: 'enter' }, ALL);
        expect(step.effect, `enter on ${cat.id}/${cat.leaves[i]!.id}`).toEqual({
          kind: 'activate',
          leaf: cat.leaves[i],
        });
        activated += 1;
      }
    }
    expect(activated, 'ANTI-VACUITY: all 12 leaves must have been activated').toBe(12);
  });

  it('MM-LEAF-DISABLED-EMITS-NONE-AND-KEEPS-STATE BITES: an unavailable leaf routes NOTHING and leaves the menu open (AC-15)', () => {
    // WRONG IMPL KILLED (1): an impl that routes anyway — `activateMenuLeaf('interact')` with no
    //   nearby interactable would run the KeyT dispatch against `undefined`.
    // WRONG IMPL KILLED (2): an impl that emits `close` (or resets to MENU_INITIAL) on a dead
    //   leaf — pressing Enter on a greyed row would dismiss the menu with no feedback at all.
    const deadRows: readonly (readonly [number, number, MenuLeafId])[] = [
      [WORLD, 0, 'interact'],
      [TRADE, 1, 'offerTrade'],
      [COMPETE, 0, 'pvp'],
    ];
    for (const [c, i, id] of deadRows) {
      expect(MENU_TREE[c]!.leaves[i]!.id, 'fixture sanity: the row under test').toBe(id);
      const s = leaves(c, i);
      expect(menuStep(s, { kind: 'enter' }, NONE), `enter on the disabled '${id}'`).toEqual({
        state: s,
        effect: { kind: 'none' },
      });
    }
    // The other 9 leaves still activate under the SAME (all-false) availability — a disabled
    // leaf must not disable its neighbours. M21b-2: 8 -> 9 with the account leaf, which is
    // NON-contextual on purpose — the claim/account UI must be reachable with no nearby NPC,
    // no trade partner and (per AUTH-48) before the player has even joined.
    let stillLive = 0;
    for (let c = 0; c < MENU_TREE.length; c += 1) {
      const cat = MENU_TREE[c]!;
      for (let i = 0; i < cat.leaves.length; i += 1) {
        if (CONTEXTUAL[cat.leaves[i]!.id] !== undefined) continue;
        expect(menuStep(leaves(c, i), { kind: 'enter' }, NONE).effect.kind).toBe('activate');
        stillLive += 1;
      }
    }
    expect(stillLive, 'ANTI-VACUITY: 9 non-contextual leaves stay live').toBe(9);
  });

  it('MM-ACTIVATE-RESETS-STATE BITES: an activate always returns state === MENU_INITIAL, so nothing remembers a pending menu (AC-17)', () => {
    // WRONG IMPL KILLED: the classic console-menu instinct — remembering where the player was
    // so the menu can be re-shown when the launched overlay closes (anti-pattern 4). That
    // breaks today's muscle memory: Escape from a menu-opened overlay must return to the WORLD
    // in ONE press. Returning MENU_INITIAL makes AC-17 true BY CONSTRUCTION rather than by a
    // main.ts flag someone can forget to clear.
    for (let c = 0; c < MENU_TREE.length; c += 1) {
      const cat = MENU_TREE[c]!;
      for (let i = 0; i < cat.leaves.length; i += 1) {
        const step = menuStep(leaves(c, i), { kind: 'enter' }, ALL);
        expect(step.state, `state after activating ${cat.id}/${cat.leaves[i]!.id}`).toEqual(
          MENU_INITIAL,
        );
      }
    }
  });
});

// ===========================================================================
// BLOCK D — the view model (AC-15's grey-not-hide half).
// ===========================================================================

describe('menuModel — buildMenuViewModel', () => {
  it('MM-VM-CATEGORIES-SHAPE BITES: the top level renders 5 keyless rows under "Menu" with the close hint and exactly one selection', () => {
    // WRONG IMPL KILLED (1): a category row carrying a keyGlyph — categories have no hotkey, and
    //   the view renders `${keyGlyph} — ${title}` whenever it is non-null, so a stray '' would
    //   paint " — Party".
    // WRONG IMPL KILLED (2): the leaf-level back hint at the top level — it would tell the
    //   player Escape goes "back" when it actually closes the menu.
    // WRONG IMPL KILLED (3): zero or multiple selected rows.
    const vm = buildMenuViewModel(cats(TRADE), ALL);
    expect(vm.level).toBe('categories');
    expect(vm.heading).toBe('Menu');
    expect(vm.backHint).toBe('Escape — close');
    expect(vm.rows.map((r) => r.title)).toEqual(['Party', 'World', 'Trade', 'Compete', 'System']);
    expect(vm.rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(vm.rows.map((r) => r.keyGlyph)).toEqual([null, null, null, null, null]);
    expect(
      vm.rows.map((r) => r.disabled),
      'a category is never greyed out',
    ).toEqual([false, false, false, false, false]);
    expect(vm.rows.filter((r) => r.selected).map((r) => r.index)).toEqual([TRADE]);
  });

  it('MM-VM-LEAVES-SHAPE BITES: a submenu renders the category title, the back hint, and one keyed row per leaf', () => {
    // WRONG IMPL KILLED (1): a heading still reading 'Menu' inside a submenu — the player would
    //   lose track of which category they entered (there is no breadcrumb).
    // WRONG IMPL KILLED (2): rows whose `index` is a running global counter rather than the
    //   position within the CURRENT level — the DOM shell writes it to data-menu-index and feeds
    //   it straight back into menuStep, so a global index would activate the wrong leaf.
    const vm = buildMenuViewModel(leaves(PARTY, 1), ALL);
    expect(vm.level).toBe('leaves');
    expect(vm.heading).toBe('Party');
    expect(vm.backHint).toBe('Escape / ← — back');
    expect(vm.rows.map((r) => r.title)).toEqual([
      'Monster Box',
      'Backpack & Raising',
      'Evolve & Fuse',
    ]);
    expect(vm.rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(vm.rows.map((r) => r.keyGlyph)).toEqual(['B', 'I', 'E']);
    expect(vm.rows.filter((r) => r.selected).map((r) => r.index)).toEqual([1]);
    expect(vm.rows.map((r) => r.disabled)).toEqual([false, false, false]);
  });

  it('MM-VM-CLAMPS-OOB BITES: an out-of-range index CLAMPS instead of indexing out of bounds (A11)', () => {
    // WRONG IMPL KILLED: `MENU_TREE[s.categoryIndex].leaves.map(...)` on a stale index —
    // buildMenuViewModel runs inside renderMenu(), which runs from a DOM event handler and from
    // the KeyM open path; a throw there leaves the overlay painted with stale rows forever.
    const high = buildMenuViewModel(cats(99), ALL);
    expect(high.rows.length).toBe(5);
    expect(high.rows.filter((r) => r.selected).map((r) => r.index)).toEqual([4]);

    const low = buildMenuViewModel(cats(-1), ALL);
    expect(low.rows.length).toBe(5);
    expect(low.rows.filter((r) => r.selected).map((r) => r.index)).toEqual([0]);

    const oobLeaf = buildMenuViewModel(leaves(WORLD, 7), ALL);
    expect(oobLeaf.heading).toBe('World');
    expect(oobLeaf.rows.length).toBe(2);
    expect(oobLeaf.rows.filter((r) => r.selected).map((r) => r.index)).toEqual([1]);

    const oobCat = buildMenuViewModel(leaves(99, 0), ALL);
    expect(oobCat.heading).toBe('System');
    // M21b-2: System holds 3 leaves now (rename / account / help).
    expect(oobCat.rows.length).toBe(3);
  });

  it('MM-DISABLED-LEAF-ALWAYS-RENDERED BITES: the row count is invariant across all 2^3 availability combos — a dead leaf is GREYED, never removed (AC-15)', () => {
    // WRONG IMPL KILLED: the "helpful" filter — `leaves.filter(l => leafAvailable(l.id, a))`.
    // Hiding a leaf exactly when the player is exploring toward its precondition is the
    // anti-discoverability failure this whole slice exists to fix (anti-pattern 5): the Interact
    // row would simply not exist until the player already stood next to an NPC, so nothing ever
    // teaches them that walking up to an NPC is a thing.
    //
    // NOTE (vitest + fast-check): block-body arrow. An expression body hands fast-check the
    // matcher's return value, which it reads as a falsy predicate result and reports as a
    // spurious counterexample. See standards/testing-tdd.md [[vitest-fast-check]].
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: MENU_TREE.length - 1 }),
        (hasInteractTarget, hasTradeTargets, hasPvpTargets, c) => {
          const a: MenuAvailability = { hasInteractTarget, hasTradeTargets, hasPvpTargets };
          const cat = MENU_TREE[c]!;
          const vm = buildMenuViewModel(leaves(c, 0), a);

          expect(vm.rows.length, `row count for '${cat.id}'`).toBe(cat.leaves.length);
          expect(vm.rows.map((r) => r.title)).toEqual(cat.leaves.map((l) => l.title));
          expect(vm.rows.map((r) => r.keyGlyph)).toEqual(cat.leaves.map((l) => l.keyGlyph));
          expect(
            vm.rows.map((r) => r.disabled),
            `disabled flags for '${cat.id}' at ${JSON.stringify(a)}`,
          ).toEqual(cat.leaves.map((l) => expectedDisabled(l.id, a)));
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// BLOCK E — the keyboard mapper (A15) and totality.
// ===========================================================================

describe('menuModel — menuKeyInput', () => {
  it('MM-KEYINPUT-MAPPING BITES: the physical-key table maps exactly the nav keys and returns undefined for everything else', () => {
    // WRONG IMPL KILLED (1): mapping a key the menu must NOT swallow. The nav intercept sits
    //   BEFORE every movement path and calls preventDefault()+return on any defined result, so
    //   mapping (say) 'KeyM' or 'Space' here would make the menu unclosable by its own front
    //   door / eat the jump key.
    // WRONG IMPL KILLED (2): returning `{kind:'right'}` for ArrowRight — A15 removed that
    //   variant; menuStep would then fall through to its default no-op arm and Right would do
    //   nothing at all.
    // WRONG IMPL KILLED (3): reading `e.key` instead of `e.code` (an 'ArrowUp' key value is the
    //   same, but 'KeyW' is not — `key` would be 'w'/'W' depending on Shift).
    expect(menuKeyInput('ArrowUp')).toEqual({ kind: 'up' });
    expect(menuKeyInput('KeyW')).toEqual({ kind: 'up' });
    expect(menuKeyInput('ArrowDown')).toEqual({ kind: 'down' });
    expect(menuKeyInput('KeyS')).toEqual({ kind: 'down' });
    expect(menuKeyInput('ArrowLeft')).toEqual({ kind: 'left' });
    expect(menuKeyInput('KeyA')).toEqual({ kind: 'left' });
    expect(menuKeyInput('Escape')).toEqual({ kind: 'escape' });

    // M21b-2 adds 'KeyC' to this list for the same reason 'KeyM' is on it: the nav intercept
    // calls preventDefault()+return on ANY defined result, so mapping the account/claim hotkey
    // here would make it dead while the menu is open — and the menu is exactly where a player
    // who just read the 'C — …' glyph is standing.
    for (const code of [
      'KeyM',
      'KeyC',
      'Space',
      'KeyB',
      'KeyQ',
      'F9',
      'Tab',
      'ArrowRightExtra',
      '',
    ]) {
      expect(menuKeyInput(code), `'${code}' must not be swallowed by the menu`).toBeUndefined();
    }
  });

  it('MM-KEYINPUT-ARITY-CODE-ONLY BITES: menuKeyInput takes exactly one parameter (A15)', () => {
    // WRONG IMPL KILLED: keeping the unused `key: string` second parameter from plan §3 — it
    // trips tsconfig's noUnusedParameters, and it invites a future impl to branch on `key`,
    // which is layout- and Shift-dependent.
    expect(menuKeyInput.length).toBe(1);
  });

  it('MM-STEP-TOTAL BITES: menuStep never throws and always returns a well-formed step, for any state and any input', () => {
    // WRONG IMPL KILLED: any unguarded index read. menuStep runs inside the window keydown
    // listener and inside two delegated DOM listeners; one uncaught throw there permanently
    // breaks the menu (and, from the keydown path, every hotkey after it).
    const stateArb: fc.Arbitrary<MenuNavState> = fc.oneof(
      fc.record({
        level: fc.constant<'categories'>('categories'),
        categoryIndex: fc.integer({ min: -3, max: 8 }),
      }),
      fc.record({
        level: fc.constant<'leaves'>('leaves'),
        categoryIndex: fc.integer({ min: -3, max: 8 }),
        leafIndex: fc.integer({ min: -3, max: 8 }),
      }),
    );
    const inputArb = fc.oneof(
      fc.constantFrom(
        { kind: 'up' } as const,
        { kind: 'down' } as const,
        { kind: 'enter' } as const,
        { kind: 'left' } as const,
        { kind: 'escape' } as const,
      ),
      fc.record({
        kind: fc.constantFrom<'hover' | 'click'>('hover', 'click'),
        index: fc.integer({ min: -5, max: 20 }),
      }),
    );
    const availArb = fc.record({
      hasInteractTarget: fc.boolean(),
      hasTradeTargets: fc.boolean(),
      hasPvpTargets: fc.boolean(),
    });

    fc.assert(
      fc.property(stateArb, inputArb, availArb, (s, i, a) => {
        const step = menuStep(s, i, a);
        expect(['categories', 'leaves']).toContain(step.state.level);
        expect(['none', 'close', 'activate']).toContain(step.effect.kind);
        if (step.effect.kind === 'activate') {
          // An activate may only ever name a REAL, AVAILABLE leaf.
          const all = MENU_TREE.flatMap((c) => c.leaves);
          expect(all).toContainEqual(step.effect.leaf);
          expect(leafAvailable(step.effect.leaf.id, a)).toBe(true);
          expect(step.state).toEqual(MENU_INITIAL);
        }
      }),
      { numRuns: 500 },
    );
  });
});
