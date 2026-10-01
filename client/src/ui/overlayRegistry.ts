// ui/overlayRegistry.ts — the pure modality core for the 17 mutual-exclusion overlays.
//
// FUNCTIONAL CORE. No DOM, no SDK, no import from `main.ts`, no view handles,
// no thunks — every export here is a data table, a total pure function, or
// the TYPE of the caller-supplied probe table, so the whole module stays node-testable
// with zero mocks. `anyVisible` takes the probes as an argument and holds no state of its
// own: the module owns the SHAPE of the visibility read, never a handle on a view.
//
// The name is deliberately distinct from `render/viewRegistry.ts` (the M4b sprite pool).
//
// WHY A `canOpen` REDUCER AND NOT A BLIND `hideAll()`:
// the gate this replaces is not uniform. Three tiers behave differently, and collapsing
// them regresses the modal gate — force-hiding `dialogueView` would strand the server
// `player_conversation` row (its visibility is store-derived and its close routes through
// the `dismissDialogue` reducer, `main.ts`). `canOpen` makes that distinction explicit and
// testable instead of implicit in fourteen hand-maintained guard lists.
//
// SCOPE: this module holds the DECISIONS, plus the READ substrate
// — `OverlayProbes` and `anyVisible` — plus the WRITE substrate: `visibleIds()` and the
// `OverlayHandles` TYPE, which together let all twelve `main.ts` hotkey open-guards route
// through `canOpen` instead of hand-maintained guard lists, and let `main.ts` run the
// context stack's `close` commands (ui/contextStack.ts `reconcile`) through each view's own
// hide path. What a battle or a server conversation closes is NOT decided here: that is
// `SCREEN_POLICY` in ui/contextStack.ts. What deliberately did NOT ship — zero consumers,
// the A7/A15 precedent — is per-id `open` thunks, `isVisible(id)` and `anyVisibleExcept()`.

/** The 17 mutual-exclusion overlays. `errorOverlayView` is NOT a member: it is
 *  non-blocking, F8-dismissed, and re-shows itself, so it never participates in
 *  mutual exclusion. Pinned by OR-MANIFEST-COMPLETE against `ui/*View.ts`. */
export type OverlayId =
  | 'battleView'
  | 'boxView'
  | 'raisingView'
  | 'evolutionView'
  | 'dialogueView'
  | 'questLogView'
  | 'healView'
  | 'shopView'
  | 'tradeView'
  | 'pvpView'
  | 'leaderboardView'
  | 'renameView'
  | 'tradeProposeView'
  | 'helpView'
  | 'menuView'
  // the claim overlay owns a text input, so it must GUARD movement
  // input while open — GUARD_ONLY registration gives that for free. sessionView is DELIBERATELY
  // NOT a member (a second EXCLUSIVE_TOP breaks decide(); D17): it is driven by conn.sessionState().
  | 'claimView'
  // the privacy surface. GUARD_ONLY, like every other modal a player
  // OPENS — it owns a two-step confirmation for an irreversible action, so it must never be
  // dismissed out from under that confirmation by a stray keypress.
  | 'privacyView';

/**
 * How an overlay behaves when something else wants to open over it.
 * - `EXCLUSIVE_TOP` — outranks everything; never itself a player open request.
 * - `HIDE_SWITCH`   — a sibling in the same trio may force-hide it (B/I/E switching).
 * - `GUARD_ONLY`    — deny over it, NEVER force-hide it.
 */
export type OverlayTier = 'EXCLUSIVE_TOP' | 'HIDE_SWITCH' | 'GUARD_ONLY';

/**
 * The tier SSOT. Typed `Record<OverlayId, _>` on purpose: omitting an id is a COMPILE
 * error, not a test failure. Declaration order below is the canonical iteration order
 * (see OVERLAY_IDS) and is what makes `blockedBy` deterministic.
 *
 * Grounded, tier by tier, against the behaviour this replaces:
 *  - `battleView` is the only overlay any handler refuses to open over unconditionally.
 *  - the box/raising/evolution trio legitimately hide-and-switch within itself.
 *  - everything else is guard-only: the earlier gate explicitly refused to accept a
 *    `.hide()` as satisfying mutual exclusion for a modal, because silently dismissing a
 *    modal on a stray keypress is the wrong UX (and, for dialogue, a server desync).
 */
export const OVERLAY_TIERS: Readonly<Record<OverlayId, OverlayTier>> = {
  battleView: 'EXCLUSIVE_TOP',
  boxView: 'HIDE_SWITCH',
  raisingView: 'HIDE_SWITCH',
  evolutionView: 'HIDE_SWITCH',
  dialogueView: 'GUARD_ONLY',
  questLogView: 'GUARD_ONLY',
  healView: 'GUARD_ONLY',
  shopView: 'GUARD_ONLY',
  tradeView: 'GUARD_ONLY',
  pvpView: 'GUARD_ONLY',
  leaderboardView: 'GUARD_ONLY',
  renameView: 'GUARD_ONLY',
  tradeProposeView: 'GUARD_ONLY',
  helpView: 'GUARD_ONLY',
  menuView: 'GUARD_ONLY',
  claimView: 'GUARD_ONLY',
  privacyView: 'GUARD_ONLY',
};

/**
 * The canonical id list, DERIVED from the tier table rather than hand-maintained beside
 * it: an id present in one but not the other is unrepresentable. String keys iterate in
 * insertion order, so this is deterministic — which `canOpen` relies on for `blockedBy`.
 */
export const OVERLAY_IDS: readonly OverlayId[] = Object.keys(OVERLAY_TIERS) as OverlayId[];

/**
 * The a11y contract for ONE overlay, as data: what an assistive technology is told the thing
 * is (`role`), what it is CALLED (`labelKey`, resolved through `ui/a11yCopy.ts`), where focus
 * lands the moment it opens (`initialFocusSelector`), and whether Escape closes it
 * (`dismissible`). M23 §2.1.
 *
 * `labelKey` is a CATALOG KEY, never a literal name. That is the M24 seam: M24 swaps
 * the resolver and these keys become catalog entries with ZERO renaming.
 *
 * `role` is a CLOSED two-member union rather than `string` on purpose. It is what
 * makes `role="presentation"` — the single most common way to silently un-label a modal — a
 * COMPILE error here rather than something a text scan might miss. `alertdialog` is unused
 * today and stays in the union anyway: an id earns it only when its sole purpose is a blocking
 * urgent message.
 */
export interface A11yMeta {
  readonly role: 'dialog' | 'alertdialog';
  readonly labelKey: string;
  readonly initialFocusSelector: string;
  readonly dismissible: boolean;
}

/**
 * The a11y metadata SSOT. Typed `Record<OverlayId, _>` for exactly the
 * reason OVERLAY_TIERS is (`:76`): omitting an id is a COMPILE error, not a test failure, so an
 * eighteenth overlay cannot ship half-registered. Declaration order mirrors OVERLAY_TIERS, so
 * OVERLAY_IDS (`:100`) indexes this table too — one derived id list, never a second hand-kept
 * one. Seventeen per-view ARIA retrofits have no completeness oracle; one total table does.
 *
 * WHY THIS BELONGS IN THIS MODULE (recorded as a verification — spec §2.0 made the
 * placement call). The purity rule at `:4`-`:8` bans DOM, SDK, `main.ts` imports, view handles
 * and thunks; every export here is a data table, a total pure function, or the TYPE of a
 * caller-supplied table. A CSS selector string and an ARIA role name are STRINGS IN A DATA
 * TABLE — none of those five things. This module still has zero imports, touches no browser
 * globals, and stays node-testable with zero mocks. `A11yMeta` is the exact analogue of
 * `OverlayProbes`/`OverlayHandles` (`:362`, `:393`): this module owns the SHAPE of the a11y
 * contract, and S1's `ui/overlayA11y.ts` owns the writes it implies.
 *
 * HARD CONSTRAINT FOR EVERY LATER SLICE: this table holds NO thunks and NO functions. If a
 * per-id BEHAVIOUR is ever needed it belongs in `overlayA11y.ts` — a lazy
 * `initialFocusSelector: () => '…'` would drag a live handle back into the functional core and
 * re-open the coupling `anyVisible`'s probes-as-argument shape exists to prevent.
 *
 * `role` IS `'dialog'` FOR ALL SEVENTEEN — the reason is on `A11yMeta` above.
 *
 * `dismissible` IS THE CONSTRAINT, NOT THE VARIATION: spec §2.1 phrases it over the TIER
 * (`EXCLUSIVE_TOP`/`GUARD_ONLY` ⇒ `true`, `HIDE_SWITCH` unconstrained), and the gate reads
 * OVERLAY_TIERS rather than a hardcoded id list so a RETIERING cannot slip past it.
 *
 * `initialFocusSelector` IS A STABLE, CONSTRUCTOR-TIME ANCHOR — never a
 * render-time control. `battleView` calls `replaceChildren()` on its skills container and its
 * action row on every server tick (`ui/battleView.ts:241`, `:270`), so a focused skill button is
 * destroyed mid-battle and focus falls to `<body>`: pointing at one would be INCORRECT, not
 * merely brittle. Where an overlay has nothing natively focusable, the anchor is its heading or
 * first content node and the shell-owning slice (S2 for the static shells, S4 for the four
 * `#app`-mounted overlays) makes it focusable with `tabindex` — the ARIA APG dialog fallback.
 * That obligation is DERIVED from this table by S2/S4's own gates, never listed here as a second
 * array (the A7/A15 zero-consumer rule at `:26`-`:30`). One landmine
 * worth restating: `#menu-rows` takes `tabindex="0"`, never `-1` — it is the `aria-activedescendant`
 * listbox AND it carries a delegated click listener.
 */
export const OVERLAY_A11Y: Readonly<Record<OverlayId, A11yMeta>> = {
  battleView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.battleView.title',
    initialFocusSelector: '[data-testid="battle-title"]',
    dismissible: true,
  },
  boxView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.boxView.title',
    initialFocusSelector: '[data-testid="box-title"]',
    dismissible: true,
  },
  raisingView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.raisingView.title',
    initialFocusSelector: '[data-testid="raising-title"]',
    dismissible: true,
  },
  evolutionView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.evolutionView.title',
    initialFocusSelector: '[data-testid="evolution-title"]',
    dismissible: true,
  },
  dialogueView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.dialogueView.title',
    initialFocusSelector: '#dialogue-npc-name',
    dismissible: true,
  },
  questLogView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.questLogView.title',
    initialFocusSelector: '#quest-log-list',
    dismissible: true,
  },
  healView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.healView.title',
    initialFocusSelector: '#heal-list',
    dismissible: true,
  },
  shopView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.shopView.title',
    initialFocusSelector: '#shop-title',
    dismissible: true,
  },
  tradeView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.tradeView.title',
    initialFocusSelector: '#trade-status',
    dismissible: true,
  },
  pvpView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.pvpView.title',
    initialFocusSelector: '#pvp-challenge-status',
    dismissible: true,
  },
  leaderboardView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.leaderboardView.title',
    initialFocusSelector: '#leaderboard-title',
    dismissible: true,
  },
  renameView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.renameView.title',
    initialFocusSelector: '#rename-input',
    dismissible: true,
  },
  tradeProposeView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.tradeProposeView.title',
    initialFocusSelector: '#tradepropose-target',
    dismissible: true,
  },
  helpView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.helpView.title',
    initialFocusSelector: '#help-title',
    dismissible: true,
  },
  menuView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.menuView.title',
    initialFocusSelector: '#menu-rows',
    dismissible: true,
  },
  claimView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.claimView.title',
    initialFocusSelector: '#claim-signin-btn',
    dismissible: true,
  },
  privacyView: {
    role: 'dialog',
    labelKey: 'a11y.overlay.privacyView.title',
    // A NATIVE <button>, not a tabindex-ed heading.
    //
    // THE CLOSE BUTTON, NOT THE DELETE BUTTON (A2-D10). `#privacy-delete-btn` carries `disabled`
    // in every phase except `active` — and a disabled control is unfocusable, so in `grace`
    // (PRV1-3's own state) `.focus()` would be a silent no-op leaving focus on <body>, where
    // `focusTrap`'s capture listener on the root never fires and Tab walks the page behind the
    // modal. In `terminal` — this criterion's flagship state — every other control is disabled or
    // hidden, so the trap would have NO focusable content at all. The close control is the one
    // thing enabled in all five phases.
    initialFocusSelector: '#privacy-close-btn',
    dismissible: true,
  },
};

/**
 * The verdict. A `deny` carries NO `forceHide` field at all — the union makes
 * "denied, but hide these anyway" unrepresentable rather than merely untested.
 */
export type CanOpenVerdict =
  | { readonly kind: 'allow'; readonly forceHide: readonly OverlayId[] }
  | { readonly kind: 'deny'; readonly blockedBy: OverlayId };

/** What a single visible overlay does to a single open request. */
type Outcome = 'deny' | 'hide';

function decide(target: OverlayId, blocker: OverlayId): Outcome {
  // EXCLUSIVE_TOP as the TARGET: a battle is server truth, never a player open request. It
  // arrives through the context stack's `reconcile`, which closes what `SCREEN_POLICY` drops.
  if (OVERLAY_TIERS[target] === 'EXCLUSIVE_TOP') return 'deny';
  // A battle already up outranks every other open request.
  if (OVERLAY_TIERS[blocker] === 'EXCLUSIVE_TOP') return 'deny';
  // Guard-only means guard: deny over it, never dismiss it.
  if (OVERLAY_TIERS[blocker] === 'GUARD_ONLY') return 'deny';
  // The blocker is HIDE_SWITCH. Only a fellow switcher may take its place; a guard-only
  // target still just gets denied (pressing Q over the open Box does nothing today).
  return OVERLAY_TIERS[target] === 'GUARD_ONLY' ? 'deny' : 'hide';
}

/**
 * May `target` open, given everything currently visible?
 *
 * TOTAL and pure. Re-opening/toggling SELF is never blocked by self, which is what
 * preserves every hotkey handler's "my own overlay is exempt" behaviour. Blockers are
 * considered in OVERLAY_IDS order and ALL of them are examined — so the reported
 * `blockedBy` is deterministic and `forceHide` is the complete qualifying set, not
 * whichever blocker happened to come first in the caller's array.
 */
export function canOpen(target: OverlayId, currentlyVisible: readonly OverlayId[]): CanOpenVerdict {
  const blockers = OVERLAY_IDS.filter((id) => id !== target && currentlyVisible.includes(id));
  const denier = blockers.find((b) => decide(target, b) === 'deny');
  if (denier !== undefined) return { kind: 'deny', blockedBy: denier };
  return { kind: 'allow', forceHide: blockers.filter((b) => decide(target, b) === 'hide') };
}

/** Per-id visibility probes. `Record<OverlayId, _>` ⇒ omitting an id is a COMPILE error,
 *  not a test failure. Each probe MUST read THIS overlay's own `visible` getter. */
export type OverlayProbes = Readonly<Record<OverlayId, () => boolean>>;

/** True iff any overlay other than `exempt` is currently visible (AC-7).
 *  Re-probes on EVERY call — nothing is cached, so it can be built at module scope
 *  before the views exist. NO try/catch on purpose: swallowing a throwing probe would
 *  return `false` silently, i.e. a mutual-exclusion breach that looks like working code. */
export function anyVisible(probes: OverlayProbes, exempt?: OverlayId): boolean {
  return OVERLAY_IDS.some((id) => id !== exempt && probes[id]());
}

/** Which overlays are visible right now, in OVERLAY_IDS declaration order — the argument
 *  `canOpen` takes. Re-probes on EVERY call, same contract as
 *  `anyVisible`: `main.ts` builds its probe table at module scope while all seventeen view
 *  bindings are still `undefined`, so a cached list would be permanently empty and mutual
 *  exclusion would never engage. NO try/catch, for `anyVisible`'s reason. The deterministic
 *  order is load-bearing — it is what makes `canOpen`'s `blockedBy` reproducible. */
export function visibleIds(probes: OverlayProbes): readonly OverlayId[] {
  return OVERLAY_IDS.filter((id) => probes[id]());
}

/** Per-id force-hide thunks — the WRITE mirror of `OverlayProbes`, and the same division of
 *  labour: this module owns the SHAPE of the write, `main.ts` owns the handles.
 *
 *  Total `Record<OverlayId, _>` on purpose, so a 17th overlay is a COMPILE error here rather
 *  than a silently unhidable overlay. The value type admits `undefined`, and only
 *  `dialogueView` supplies it. That is not style: `main.ts` must
 *  contain ZERO `dialogueView?.hide` occurrences,
 *  because a client-side hide strands the server
 *  `player_conversation` row — so a table of REQUIRED thunks cannot compile in this codebase
 *  at all. Deliberately NOT `Partial<>`: that would let ANY id go missing, not just the one
 *  that must. */
export type OverlayHandles = Readonly<Record<OverlayId, (() => void) | undefined>>;
