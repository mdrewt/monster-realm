# m17b build plan — ranked-ladder client leaderboard UI (RL-13 + RL-15)

**Slice:** m17b · **ADR:** 0120 (supervisor-reserved) · **Branch:** `feat/m17b-leaderboard-ui`
**Spec:** harness `specs/monster-realm-v2/M17-ranked-ladder.spec.md` §4 m17b + §5 slice table.

## Scope decision (orchestrator, at scope-verify)

- **Deliver RL-13** (leaderboard overlay: subscribe `profile`, sort rating desc with stable
  tie-break name→identity, rating/W/L display, own-row highlight, overlay mutual-exclusion)
  **+ RL-15** (no client write path to `profile` — pure subscription view, ADR-0014).
- **PARKED — `set_profile_name` flow (incl. RL-7 rejection UX):** the server reducer does not
  exist (m17a shipped none — verified: no `set_profile_name` in server-module or bindings).
  Shipping it requires `server-module/src/ranking.rs` + bindings regen + the RL-7 eval-tooth
  amendment pre-staged in ADR-0119 D6 — the eval lives in `evals/**`, owned by the concurrent
  sibling m17c. Hidden dependency → recorded for supervisor re-serialization (follow-up slice).
- **PARKED — RL-14** (post-battle rating delta in the PvP end-of-battle UI): requires
  `battleModel.ts`/`battleView.ts` edits outside the declared touch set; separable scope.
  Natural companion to the `set_profile_name` follow-up slice.
- **Fan-out constraint resolved:** `leaderboardView.ts` is NOT added to `vite.config.ts`
  coverage excludes (the m17c-owned `dom-shell-coverage-exclusion` eval exact-set-guards that
  list via `findUnsanctionedExclusions`). Instead the view ships fully unit-covered via
  happy-dom tests. **This constraint is TOTAL (red-team amendment 4): every branch — both
  constructor throw paths, empty-board render, row render, own-row marker — MUST have a
  happy-dom test; there is no escape hatch to the exclude list without touching the m17c-owned
  eval.** Nightly line threshold is 96% over included files; `replaceChildren` is confirmed
  supported in happy-dom 20.x (pvpView.ts uses it, tests green).

## File budget

Declared touches: `client/src/ui/leaderboard*.ts` (+ sibling `*.test.ts`), `client/src/main.ts`,
`client/src/net/store.ts` (+ test). Necessary companions (touches-delta, all inside m17b's half
of the m17b‖m17c partition): `client/src/net/connection.ts`, `client/src/net/rowConvert.ts`
(+ test), `client/index.html`, `docs/adr/0120-*.md`, `docs/specs/m17b-plan.md` (this file),
minimal `ARCHITECTURE.md` entry, memory card.
**Forbidden:** `evals/**`, `client/e2e/**` (m17c-owned), `client/vite.config.ts`,
`CHANGELOG.md`, `docs/adr/README.md`, server-module/game-core, `client/src/module_bindings/**`
(profile binding already present from m17a — verify, never regenerate).

## Task list (test-first; tester ≠ implementer)

- **A — store + boundary ingest.** RED: `rowConvert.test.ts` (`profileRowToStore`: identity via
  `.toHexString()`, rating/wins/losses as numbers, empty-name pass-through, exact-field probe);
  `store.test.ts` (upsertProfile keyed by identity hex + dirty flag; `allProfiles()` fresh-array
  isolation; `profile(identity)` lookup; `reset()` clears profiles). GREEN: `StoreProfile` as a
  **`type` alias, NOT `interface`** (store.ts:39 probe-cast constraint) + `#profiles` map +
  `upsertProfile` + accessors in store.ts + **explicit `this.#profiles.clear()` in `reset()`**
  (pattern: store.ts:597-604); `SdkProfileRow` + `profileRowToStore` in rowConvert.ts;
  `conn.db.profile.onInsert/onUpdate` wiring + `'SELECT * FROM profile'` subscription line in
  connection.ts. **Deliberately NO `onDelete`/`removeProfile`** (plan-review W-1): RL-2/ADR-0119
  D1 guarantee `profile` rows are never deleted — wiring a remove path would be unreachable dead
  code; a tripwire comment at the wiring site cites RL-2 so a future server-side delete is
  caught in review, not silently mirrored. `profile` is a REGULAR table (not a view): `onUpdate`
  fires normally — do NOT apply the my_conversation view-delete gating (M13.5c trap does not
  apply; plan-review W-5).
- **B — pure model.** RED: `leaderboardModel.test.ts` (sort desc; tie-break name asc code-unit
  case-sensitive; tie-break identity asc; any-input-order determinism; empty-name fallback
  `#<hex8>` display but RAW-name tie-break; isOwn; identity `''` → no own row; empty list →
  `isEmpty`). GREEN: `leaderboardModel.ts` — `buildLeaderboardViewModel(profiles, identity)`,
  TOTAL, sorts a copy, no locale/Intl/RegExp/Date/RNG.
- **C — view + DOM shell.** RED: `leaderboardView.test.ts` (`@vitest-environment happy-dom`):
  constructor throw paths (missing overlay / missing list el), visible/show/hide/toggle, empty
  render branch ("No ranked players yet"), row render (rating + W/L text, `dataset.identity`,
  own marker), XSS case (name with `<script>`/`<b>` stays literal text; no script element),
  zero-callback constructor (RL-15). GREEN: `client/index.html` overlay shell +
  `leaderboardView.ts` (constructor(), visible, show, hide, toggle, render; `textContent` +
  `replaceChildren` only — no innerHTML with data).
- **RL-15 structural tooth:** source-scan test asserting `leaderboardModel.ts` +
  `leaderboardView.ts` contain no `module_bindings` / `reducers` / `conn.` references
  (string-scan via readFileSync + indexOf — no dynamic RegExp).
- **D — main.ts integration.** All guard sites below; no new unit file (main.ts is
  coverage-excluded, e2e is m17c-owned); reviewer diffs against the site inventory.
- **E — docs.** ADR-0120 (canonical ADR-0104 header: `**Subsystems:** client-ui`, `**Decision:**`
  one sentence ≤ 240 chars; run `just adr-digest` before committing — DIGEST drift is CI-gated) +
  minimal ARCHITECTURE.md entry + memory card + handoff.

## main.ts site inventory (each MUST gain `leaderboardView`; append after `pvpView` per convention)

1. import block: `LeaderboardView` type + `buildLeaderboardViewModel`.
2. module-scope: `let leaderboardView: LeaderboardView | undefined;`
3. reconcile-divergence held-reissue guard (`diverged && !(…)` list).
4. KeyB open guard (`!leaderboardView?.visible`).
5. KeyI open guard. 6. KeyE open guard. 7. KeyQ open guard. 8. KeyH open guard.
9. KeyG open guard. 10. KeyU open guard. 11. KeyP open guard. 12. KeyT talk guard.
13. NEW KeyL handler (after KeyP block): guard negates ALL TEN existing overlays (battle, box,
    raising, evolution, dialogue, questLog, heal, shop, trade, pvp); toggle: visible → hide,
    else `render(buildLeaderboardViewModel(store.allProfiles(), identity))` then `show()`;
    `e.preventDefault(); return;`.
14. NEW Escape handler after the pvp Escape block (hide; preventDefault; return).
15. movement-suppression block (`|| leaderboardView?.visible`).
16. NEW batch listener (trade-style refresh-only-when-visible, ADR-0014; try/catch; guard
    `!leaderboardView?.visible || identity === ''`).
17. pvp listener `anyOverlayVisible` (add `|| leaderboardView?.visible`). **Do NOT add
    `pvpView?.visible` here** — plan-review B-1 REFUTED: pvpView's absence from
    `anyOverlayVisible` is deliberate and load-bearing. `pvpView.refresh(vm, false)` HIDES the
    view (pvpView.ts:88-93); the `(pvpView?.visible ?? false)` disjunct is what preserves a
    manually-opened overlay across batches. Including pvpView in `anyOverlayVisible` would make
    the open overlay close itself on the next batch.
18. dynamic-import destructure + `Promise.all` entry.
19. view construction `leaderboardView = new LeaderboardViewClass();` (zero args — RL-15).
20. frame-loop held-reissue guard.
21. onReconnect: `leaderboardView?.hide();` (no lock to reset; avoids stale/empty board).
22. **refreshBattle 'show' branch (red-team F1, BLOCKER):** add
    `if (leaderboardView?.visible) leaderboardView.hide();` alongside the existing
    box/raising/evolution hides (~main.ts:748-750). Exploit closed: challenger has leaderboard
    open when opponent accepts the PvP challenge → battle row appears → refreshBattle auto-shows
    the battle overlay OVER the open leaderboard (movement suppression does not prevent this —
    the player is stationary; `anyOverlayVisible` gates only the pvp listener, not battle).

## ViewModel design (SSOT in leaderboardModel.ts, pinned by ADR-0120)

Row: `{ identityHex, displayName, rating, wins, losses, isOwn }` (all numbers — no bigints in
profile rows). VM: `{ rows, isEmpty }`. Comparator (strict total order, deterministic for any
input order): rating desc (`b.rating - a.rating`) → RAW name asc, code-unit, case-sensitive
(never `localeCompare`/Intl — locale-dependent) → identityHex asc (PK ⇒ total order).
Empty-name display fallback `'#' + identityHex.slice(0, 8)` (display-only; tie-break uses raw
name). No row cap (YAGNI — ranked population bounded by decisive-ranked-battle players).
Own-row: `identityHex === identity`; `identity === ''` ⇒ none. Empty board is a real state
(profiles exist only after a decisive ranked battle) → "No ranked players yet".
**Pinned display contract (test-review W-3):** each row's textContent contains the displayName,
the rating as a decimal string, and the exact fragments `W<wins>` and `L<losses>` — the compact
`W10`/`L2` form is contractual, not incidental.

## Anti-patterns pinned

innerHTML with server data (name is player-controlled → textContent/dataset only; prefer
replaceChildren over `innerHTML=''`); batch-listener throw starvation (TOTAL model + local
try/catch); dynamic `new RegExp` (eslint ReDoS ban — string scans use indexOf); bigint→Number
(N/A here, stay alert copying idioms); in-place sort of store arrays (sort a copy); guard-site
omission (the 21-site inventory is the checklist — miss #3/#15/#20 = walk-under-overlay,
#4–#12 = double-overlay, #17 = challenge pops over board).

## Parked-item ledger (for handoff + PR body)

- `set_profile_name` + RL-7 tooth amendment (ADR-0119 D6) + RL-14 rating delta → follow-up
  slice after m17c merges (needs server-module + evals/** + battleModel/View).
- **Name-bound inheritance (red-team F4):** `profile.name` is ≤24 chars only because
  `get_or_init_profile` seeds from `player.name` (validated at join_game via `validate_name`,
  MAX_NAME_LEN=24). No second enforcement at the profile-write layer. The future
  `set_profile_name` slice MUST apply `validate_name` before writing. Client display
  truncation is YAGNI at 24-char names.
- **Same-identity reconnect assumption (red-team F5):** `isOwn` uses main.ts module-scope
  `identity`, assigned only in `onReady` — correct because SpacetimeDB 2.6 reconnects reuse
  the identity; a credential-losing reconnect would mis-highlight. Documented, not defended.
- OQ: own-row pinning/scroll-to — YAGNI, highlight only (spec says highlight).
