// ui/a11yCopy.ts — the flat accessible-name copy catalog and its resolver (m23-s0, ADR-0205 D4/D5).
//
// A typed SSOT `const` (the `helpModel` / `dialogueContent` / `renameModel` precedent) — NOT a
// RON data file (YAGNI: this is client chrome, not game content). Pure and total in the shape
// that matters: no DOM, no SDK, no module state, no IO. `t()` returns a primitive, so unlike
// `buildHelpViewModel` (ui/helpModel.ts:14) there is nothing here a caller could mutate and
// poison for the next call — the catalog itself is never handed out.
//
// THE M24 SEAM (ADR-0033, M23 §2.8). Accessible names are CATALOG KEYS from the first commit,
// never string literals at the call site, so M24 swaps the resolver — this `t` for a real i18n
// one — and M23's keys become catalog entries with ZERO renaming. What M23 deliberately does NOT
// ship, because nothing consumes it yet: no ICU syntax (`{`/`}` are banned in a key AND in a
// value, and that ban is mechanically gated), no placeholders, no plural rules, no fallback
// chain, no locale switching. The key shape is `a11y.<namespace>.<…>` with the OverlayId kept
// VERBATIM — `a11y.overlay.boxView.title`, capital V — so the key is DERIVABLE from `OverlayId`
// with zero mapping table (ADR-0205 D5). A kebab-cased key would reintroduce exactly the
// hand-kept id↔key correspondence the derivation exists to kill.
//
// WHY `t` THROWS RATHER THAN RETURNING THE KEY (ADR-0205 D4 — reject, do not clamp; the same
// reasoning as `anyVisible`'s deliberate absence of a try/catch, ui/overlayRegistry.ts:366).
// Both silent alternatives have a user-visible cost:
//   - returning the key announces the literal "a11y.overlay.boxView.title" to a screen-reader
//     user, and it makes an UNWIRED catalog look wired — the precise vacuity M23 §5.1 kills;
//   - returning '' ships an UNLABELLED dialog, a WORSE WCAG failure than shipping no dialog
//     role at all.
// `t` is partial on `string` but TOTAL on the domain CI guarantees: A11Y-4 makes an unresolvable
// `labelKey` a CI failure, so in shipped code the throw is unreachable. It is a fail-loud
// backstop, and its message names the key so a caller can tell WHICH entry is unwired.

/**
 * The catalog. Flat `Record<string, string>` — no nesting, no interpolation, one key per
 * announced string. The seventeen `a11y.overlay.<OverlayId>.title` entries are the accessible
 * NAMES of the seventeen mutual-exclusion overlays (`ui/overlayRegistry.ts` OVERLAY_A11Y), so each
 * one reads as a dialog name: short, title-cased, no trailing punctuation. Each is the wording
 * the overlay already shows the player, so what an AT announces and what is on screen agree.
 *
 * FROZEN, not merely `Readonly<>`. The type annotation is erased at runtime, so a caller that
 * casts it away could rewrite this shared module singleton for every later importer — and `t`
 * would then resolve the corrupted value. `Object.freeze` makes the declared invariant real.
 *
 * The set of `a11y.overlay.*` keys here is gated for SET EQUALITY against the keys derived from
 * OVERLAY_IDS, in both directions — a missing entry and a stowaway are each a red. It is
 * deliberately NOT gated as "only this namespace" or "exactly N keys": S1 lands `a11y.world.*`
 * and `a11y.announce.*` the moment it starts, and each namespace is orphan-checked by the slice
 * that owns its consumer (ADR-0205 D5).
 */
export const a11yCopy: Readonly<Record<string, string>> = Object.freeze({
  // Constructed overlays — the wording is the <h2> each view builds today.
  'a11y.overlay.battleView.title': 'Battle', // ui/battleView.ts:60
  'a11y.overlay.boxView.title': 'Party & Box', // ui/boxView.ts:41
  'a11y.overlay.raisingView.title': 'Raising & Inventory', // ui/raisingView.ts:56
  'a11y.overlay.evolutionView.title': 'Evolution', // ui/evolutionView.ts:47
  // Static-shell overlays. Where the shell has a menu leaf, the wording is that leaf's own label
  // (ui/menuModel.ts) so the announced name matches what the player picked to get here.
  // `dialogueView` and `healView` have NO menu leaf and no static heading — both are reached by
  // walking up to something in the world and pressing T — so their names are authored here, from
  // the domain vocabulary (`player_conversation`) and the heal action respectively.
  'a11y.overlay.dialogueView.title': 'Conversation',
  'a11y.overlay.questLogView.title': 'Journal (Quests)',
  'a11y.overlay.healView.title': 'Heal',
  'a11y.overlay.shopView.title': 'Shop', // ui/shopView.ts:103
  'a11y.overlay.tradeView.title': 'Incoming Trade', // ui/menuModel.ts:83
  'a11y.overlay.pvpView.title': 'PvP Challenge', // ui/pvpView.ts:103
  'a11y.overlay.leaderboardView.title': 'Leaderboard', // ui/menuModel.ts:92
  'a11y.overlay.renameView.title': 'Rename Profile', // ui/menuModel.ts:99
  'a11y.overlay.tradeProposeView.title': 'Offer a Trade', // ui/menuModel.ts:84
  'a11y.overlay.helpView.title': 'Controls & Goals', // index.html:86
  'a11y.overlay.menuView.title': 'Menu', // ui/menuModel.ts:325
  'a11y.overlay.claimView.title': 'Account & Sign-in', // ui/menuModel.ts:103
  // rb-52: reached from the Account & Sign-in overlay (ADR-0231 A2-D5), so the name says what the
  // surface is FOR rather than repeating its parent's label.
  'a11y.overlay.privacyView.title': 'Privacy & Account Data',
  // The canvas world region (m23-s4, M23 §2.3). NOT an overlay: `render/world.ts` sets
  // role="application" + tabindex="0" on `app.canvas` itself and labels it from here, so the
  // hotkey-vs-quick-nav collision has a named landing place a screen reader can reach. The S0
  // header predicted this `a11y.world.*` namespace; the set-equality gate is scoped to
  // `a11y.overlay.*` on BOTH sides precisely so it could be added without weakening that gate,
  // and its orphan check belongs to the slice owning the consumer (D5) — here, world.test.ts.
  'a11y.world.region': 'World map',
});

/**
 * Resolve one catalog key. Pure and total on the catalog's own domain; THROWS on a miss, naming
 * the key (ADR-0205 D4). Never returns the key, never returns '', never caches, never mutates.
 *
 * `Object.hasOwn`, NOT `key in a11yCopy`: an object literal inherits `toString`, `constructor`,
 * `hasOwnProperty` and `valueOf` from `Object.prototype`, and `in` is true for every one of
 * them — an `in`-guarded resolver hands back an inherited FUNCTION for `t('toString')` instead
 * of throwing.
 */
export function t(key: string): string {
  if (!Object.hasOwn(a11yCopy, key)) {
    throw new Error(`a11yCopy: no entry for key '${key}' — the catalog is unwired for this key`);
  }
  return a11yCopy[key];
}
