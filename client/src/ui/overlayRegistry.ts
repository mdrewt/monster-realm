// ui/overlayRegistry.ts — the pure modality core for the 15 mutual-exclusion overlays
// (uxd3, ADR-0162).
//
// FUNCTIONAL CORE (ADR-0014). No DOM, no SDK, no import from `main.ts`, no view handles,
// no thunks — every export here is a data table, a total pure function, or (since uxd3-b)
// the TYPE of the caller-supplied probe table, so the whole module stays node-testable
// with zero mocks. `anyVisible` takes the probes as an argument and holds no state of its
// own: the module owns the SHAPE of the visibility read, never a handle on a view.
//
// The name is deliberately distinct from `render/viewRegistry.ts` (the M4b sprite pool).
//
// WHY A `canOpen` REDUCER AND NOT A BLIND `hideAll()`:
// the gate this replaces is not uniform. Three tiers behave differently, and collapsing
// them regresses ptc5c/ADR-0139 — force-hiding `dialogueView` would strand the server
// `player_conversation` row (its visibility is store-derived and its close routes through
// the `dismissDialogue` reducer, `main.ts`). `canOpen` makes that distinction explicit and
// testable instead of implicit in fourteen hand-maintained guard lists.
//
// SCOPE (uxd3-a + uxd3-b + uxd3-c): this module holds the DECISIONS, plus the READ substrate
// — `OverlayProbes` and `anyVisible`, which uxd3-b's five `main.ts` fan-out surfaces consume
// — plus, since uxd3-c (ADR-0164), the WRITE substrate: `visibleIds()` and the
// `OverlayHandles` TYPE, which together let all twelve `main.ts` hotkey open-guards and
// `refreshBattle` route through `canOpen`/`hideAllExceptPlan` instead of fourteen
// hand-maintained guard lists. `visibleIds()` is an explicit REVERSAL of A7's deletion, and
// the reversal is the YAGNI rule working rather than churn: it landed the slice it acquired
// its two production consumers (the `canOpen` gate binder and `refreshBattle`'s force-hide
// loop). What uxd3-c deliberately did NOT ship, for exactly that same reason — zero consumers,
// the A7/A15 precedent — is per-id `open` thunks, `hideAllExcept` (the pure
// `hideAllExceptPlan` below is what `refreshBattle` consumes), `isVisible(id)` and
// `anyVisibleExcept()`.

/** The 15 mutual-exclusion overlays. `errorOverlayView` is NOT a member: it is
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
  | 'menuView';

/**
 * How an overlay behaves when something else wants to open over it.
 * - `EXCLUSIVE_TOP` — outranks everything; may force-hide the `BATTLE_FORCE_HIDE` subset.
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
 *  - everything else is guard-only: the pre-uxd3 gate explicitly refused to accept a
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
};

/**
 * The canonical id list, DERIVED from the tier table rather than hand-maintained beside
 * it: an id present in one but not the other is unrepresentable. String keys iterate in
 * insertion order, so this is deterministic — which `canOpen` relies on for `blockedBy`.
 */
export const OVERLAY_IDS: readonly OverlayId[] = Object.keys(OVERLAY_TIERS) as OverlayId[];

/**
 * Exactly what a battle auto-show force-hides — `refreshBattle`'s existing subset in its
 * own source order, plus `menuView` (the menu must never occlude a battle, AC-19).
 *
 * `dialogueView` is ABSENT and must stay absent: hiding a live conversation client-side
 * leaves the server `player_conversation` row open, so the player is stuck in a phantom
 * conversation. `shopView`/`tradeView`/`pvpView`/`questLogView`/`healView` are likewise
 * absent because `refreshBattle` does not hide them today. Pinned exactly (not by
 * membership) by OR-FORCEHIDE-EXACT, and cross-checked against `main.ts` by
 * W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST.
 */
export const BATTLE_FORCE_HIDE: readonly OverlayId[] = [
  'helpView',
  'boxView',
  'raisingView',
  'evolutionView',
  'leaderboardView',
  'renameView',
  'tradeProposeView',
  'menuView',
];

/**
 * Overlays no verdict may EVER force-hide, whatever the tier table later says.
 *
 * This is a stronger guarantee than narrowing `forceHide`'s element type to the
 * hide-switch trio would be: the EXCLUSIVE_TOP row legitimately force-hides GUARD_ONLY
 * ids (help, leaderboard, rename, tradePropose), so the narrow type is unsound. The
 * invariant is enforced over every (target × blocker-set) pair by OR-NEVER-FORCE-HIDE.
 */
export const NEVER_FORCE_HIDE: readonly OverlayId[] = ['dialogueView'];

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
  // EXCLUSIVE_TOP as the TARGET: a battle opening is not a normal open. It force-hides
  // exactly the subset it is allowed to, and is denied by anything outside it — which is
  // precisely the set `refreshBattle` leaves alone.
  if (OVERLAY_TIERS[target] === 'EXCLUSIVE_TOP') {
    return BATTLE_FORCE_HIDE.includes(blocker) ? 'hide' : 'deny';
  }
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

/**
 * The ids a `hideAllExcept(keep)` would hide, as a PLAN — this function performs nothing.
 *
 * Only the battle force-hides anything; every other `keep` plans an empty list. That is a
 * faithful model of the code as it stands, and deliberately NOT generalised into a
 * per-overlay force-hide table: fourteen empty arrays would be dead weight, and inventing
 * force-hide behaviour no overlay has is how a "unification" refactor grows bugs.
 */
export function hideAllExceptPlan(
  keep: OverlayId,
  currentlyVisible: readonly OverlayId[],
): readonly OverlayId[] {
  if (keep !== 'battleView') return [];
  return BATTLE_FORCE_HIDE.filter((id) => id !== keep && currentlyVisible.includes(id));
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
 *  `canOpen`/`hideAllExceptPlan` take. Re-probes on EVERY call, same contract as
 *  `anyVisible`: `main.ts` builds its probe table at module scope while all fifteen view
 *  bindings are still `undefined`, so a cached list would be permanently empty and mutual
 *  exclusion would never engage. NO try/catch, for `anyVisible`'s reason. The deterministic
 *  order is load-bearing — it is what makes `canOpen`'s `blockedBy` reproducible. */
export function visibleIds(probes: OverlayProbes): readonly OverlayId[] {
  return OVERLAY_IDS.filter((id) => probes[id]());
}

/** Per-id force-hide thunks — the WRITE mirror of `OverlayProbes`, and the same division of
 *  labour: this module owns the SHAPE of the write, `main.ts` owns the handles.
 *
 *  Total `Record<OverlayId, _>` on purpose, so a 16th overlay is a COMPILE error here rather
 *  than a silently unhidable overlay. The value type admits `undefined`, and exactly the
 *  `NEVER_FORCE_HIDE` members supply it. For `dialogueView` that is not style: `main.ts` must
 *  contain ZERO `dialogueView?.hide` occurrences (ADR-0162 AC-9,
 *  W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE), because a client-side hide strands the server
 *  `player_conversation` row — so a table of REQUIRED thunks cannot compile in this codebase
 *  at all. Deliberately NOT `Partial<>`: that would let ANY id go missing, not just the one
 *  that must. */
export type OverlayHandles = Readonly<Record<OverlayId, (() => void) | undefined>>;
