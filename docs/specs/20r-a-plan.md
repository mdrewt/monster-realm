# 20r-a — In-flight guards for server-bound client actions: Plan + Tasks

Spec: `specs/monster-realm-v2/M-postgate-twentieth-review-residuals.spec.md` §20r-a (harness).
Worktree: `.claude/worktrees/20r-a`. Paths below are relative to `client/src/` unless stated.
Touches: battleView.ts/.test.ts, raisingView.ts/.test.ts, evolutionView.ts/.test.ts,
pvpView.ts/.test.ts, main.ts (+ main.wiring.test.ts as main.ts's sibling test, ARCHITECTURE.md).

**No new ADR** (no number reserved by the supervisor). Rationale lives in file headers + PR body.
Follow-up flag: an amendment to ADR-0159 D1 generalising "lock lifetime = reducer-promise settle
for PvE/train/evolve/pvp-lifecycle; PvP *action* lifetime = VM turn gate (ADR-0110)".

## 0. Design decisions

| # | Finding | Decision |
|---|---|---|
| D1 | happy-dom's `HTMLButtonElement.dispatchEvent` returns `false` for a click on a disabled button, and `.click()` goes through it — the seed "two clicks → one callback" is satisfied by `btn.disabled = true` alone; the pending key is invisible to it. | Every double-click test ALSO asserts `disabled===true`; the key's own teeth come from (a) the mid-flight `refresh()` rebuild test and (b) a "hostile re-enable" test that sets `live.disabled = false` by hand before the second click. |
| D2 | `pvpView.test.ts:410-431` clicks Accept then Decline synchronously and expects both; a view-wide lock reds it. | Keep the view-wide lock (all four lifecycle actions mutate ONE challenge state; a per-button lock leaves accept-then-decline open — the contradictory-outcome class). The tester makes that test `async` with `await flushPromises()` between the clicks, citing 20r-a. |
| D3 | `Promise.resolve(cb())` throws synchronously if `cb` throws, after the lock is set → dead until `hide()`. | New lock code uses `new Promise<void>((resolve) => resolve(cb(...)))` (synchronous call, sync throw → rejection). NOT `.then(() => cb())` — that defers the dispatch by a microtask and reds the existing synchronous-after-click asserts. Existing Care block (`raisingView.ts:216-236`) byte-unchanged (C4/C6 pins; `evals/keyboard-operable-rows.eval.mjs:201` cites its lines in prose). |
| D4 | Per-button `.disabled = locked` lines would touch the PvP branches RT-PVP-DS-01 pins. | One post-render pass: `refresh()` calls `#applyPendingLock(vm.battleId)` after `#renderActions`; it iterates `querySelectorAll('button')` under `#skillsEl` + `#actionsEl` — the containers ARE the live-button registry. PvP handlers never take the lock. |
| D5 | `sendGuarded` returning `Promise<void>`: when `call()` returns `undefined` (`conn.live()` undefined) the lock must not hang. | Return `Promise.resolve()` on both the frozen short-circuit and the `undefined` call result; otherwise the `.catch`-chained promise (always resolves). No `try/catch` inside `sendGuarded` — the other sites keep their exact semantics. |
| D6 | Should a pending Care block Train on the same monster? | No — different reducers, different failure modes. Separate `#pendingTrain: Set<bigint>` + `#trainButtons: Map<bigint, HTMLButtonElement[]>`; all Train buttons of that monster disable together. |
| D7 | `evolutionView.ts:254` comment "re-enabled on the next server-tick refresh" becomes a false present-tense claim. | Rewrite it in the same edit. Per-monster set; a click disables ALL of that monster's choice buttons (a second *different* choice mid-flight is the irreversible double-evolve). |
| D8 | `hide()` release ordering vs the S4 pins (close-last, unguarded). | Release + re-enable BEFORE `closeOverlayA11y(...)`; the close stays the last statement and unguarded. |
| D10 | (red-team #1) `onReconnect` (main.ts ~:2946-3005) hides rename/tradePropose/shop/trade/pvp/menu because the SDK never settles an in-flight reducer promise after a link drop — but NOT battle/raising/evolution. The new locks (and the shipped Care lock, whose `#pending` is only cleared by `hide()`) would stay held for the session. | Add `battleView?.hide(); raisingView?.hide(); evolutionView?.hide();` to `onReconnect` beside `pvpView?.hide()` (a surviving battle re-shows on the next batch: `shouldSkipBattleRefresh` is false while hidden). Tooth W-20RA-RECONNECT in main.wiring.test.ts using the existing `onReconnect:` → `onOwnWarp` window idiom (:870-890). |
| D11 | (red-team #2) Cross-generation clobber: a lock keyed by bare Set/Map membership lets a STALE promise's `.finally` (click → `hide()` clears the set → reopen → click again → first promise settles) delete the NEW pending key and re-enable the live button while the second call is in flight. | Object-identity generation token: battle `#pending: { readonly battleId: bigint } \| null` with `const lock = { battleId }`; raising/evolution `Map<bigint, object>` with `const lock = {}`; pvp `#pending: object \| null`. Every `.finally` releases ONLY IF the stored lock `===` its own token. Tests BV-11/RV-5/EV-5/PV-6 model two overlapping generations. |
| D12 | (red-team #3/#4) Presence-only source scans on main.ts are decoy-bypassable (`return sendGuarded('dead', () => undefined)` after the real untracked call; a dead `if (false) return Promise.resolve()` + an `as Promise<void>` cast). | M-1: bound each callback body (anchor → next sibling key, comment-stripped, whitespace-squashed) with the file's `regionOrThrow`/`expectUniqueAnchor` idiom; assert EXACTLY ONE `sendGuarded(` in the body and that the body starts with `{ return sendGuarded(` (canonical spelling: block-bodied `return`). M-2: anchor each `return Promise.resolve();` to its own branch (`conn.linkFrozen()` and `p === undefined` windows, unique), and ban ` as ` / `!.` in the `sendGuarded` body. |
| D9 | Why NOT generalize `pvpPendingSubmit` in the VM? | PvP pending lifetime is "until the server advances the turn" (needs `turnNumber` → VM-gated, ADR-0110). PvE/train/evolve/pvp-lifecycle lifetime is "until this call settles" (promise-gated — the Care/tradePropose precedent). `battleModel.ts` is outside `touches:` and the wrong seam anyway. |

## 1. Design per file

**main.ts** — `sendGuarded(where, call): Promise<void>`: frozen → `reportError(...); return Promise.resolve();`
else `const p = call(); if (p === undefined) return Promise.resolve(); return p.catch(...)`. Docstring: always-resolving;
callers that hold a UI lock `return` it. Callbacks `return sendGuarded(...)`: onAttack/onFlee/onSwap/onRecruit/onUseItem,
onTrain, onEvolve (keep `onEvolve: (monsterId, toSpecies) =>` verbatim and `reducers.evolve(` within 600 chars — W-EVOLVE pins),
onChallenge/onAccept/onDecline/onCancel — block-bodied `{ return sendGuarded(...); }` (D12). onPvpAttack/onPvpSwap/onCare untouched. `onReconnect`: add the three `hide()` calls (D10).
`ARCHITECTURE.md` "Send gating" bullet: one sentence.

**battleView.ts** — `#pending: { readonly battleId: bigint } | null` (object identity = generation token, D11); callback types `=> void | Promise<void>` (onCare docstring rationale);
`#dispatch(battleId, run)`: no-op if any pending; set; `#setActionButtonsDisabled(true)`;
`void new Promise<void>((resolve) => resolve(run())).finally(release-if-same-battle + re-enable).catch(console.error)`;
inline `if (this.#pending?.battleId === vm.battleId) this.#setActionButtonsDisabled(true);` as the last statement of `refresh()` (simplify: no third helper); five PvE listeners route through `#dispatch`; `hide()` releases before `closeOverlayA11y`.

**raisingView.ts** — `onTrain` widened; `#pendingTrain: Map<bigint, object>` (D11) + `#trainButtons` (cleared beside `#careButtons.clear()`);
`trainBtn.disabled = #pendingTrain.has(monsterId)`; listener with the same finally/catch shape re-enabling the LIVE list;
`hide()` clears `#pendingTrain` beside `#pending.clear()`.

**evolutionView.ts** — `onEvolve` widened; `#pending: Map<bigint, object>` (D11) + `#choiceButtons: Map<bigint, HTMLButtonElement[]>`
(cleared in `refresh()`); `#renderChoice`: `btn.disabled = #pending.has(monsterId)`; click disables all of the monster's
choices; finally releases + re-enables the LIVE list; `hide()` clears before `closeOverlayA11y`; :254 comment rewritten.

**pvpView.ts** — four callback types widened; `#pending: object | null = null` (view-wide, identity token D11); `#dispatch(run)` +
`#setLifecycleDisabled(disabled)` over `#incomingEl`/`#outgoingEl`/`#playerListEl` (never `#root`); the four listeners
route through `#dispatch`; `refresh()` re-applies after `#renderPlayerList`; `hide()` releases before `closeOverlayA11y`.

## 2. Functional core / imperative shell
All four files are coverage-excluded DOM shells (`evals/dom-shell-coverage-exclusion.eval.mjs`). The "core" is the lock
discipline, fully observable under happy-dom: `vi.fn()` callbacks returning a hand-controlled promise, `.disabled` on live
nodes, `await flushPromises()` (3× `await Promise.resolve()`, per `raisingView.test.ts:367-373`). `main.ts` is un-importable
under vitest; its changes are gated by source scans in `main.wiring.test.ts`.

## 3. EARS → test matrix (names carry the `20r-a` tag so the ledger CHECK can `-t "20r-a"`)

| ID | Criterion | Test | Wrong impl killed |
|---|---|---|---|
| BV-1 | PvE double dispatch | two `.click()` on the same skill button while `onAttack` unsettled → one call; button + Flee/Swap/Recruit/Use-Item `disabled` | no lock; clicked-button-only lock |
| BV-2 | cross-action | skill pending, click Flee → `onFlee` not called | per-action lock |
| BV-3 | hostile re-enable | click; set `disabled=false` by hand; click → one call | disabled-only impl (D1) |
| BV-4 | mid-flight refresh | click; `refresh(sameVm)` → new button disabled; click → one call; settle → NEW button enabled | render not re-deriving; releasing the DETACHED node |
| BV-5 | other battle | pending battle 1; `refresh(battle 2)` → enabled; settle 1 → 2 still enabled + clickable | boolean lock; release without same-battle check |
| BV-6 | settle-with-rejection | `onAttack` rejects; flush → enabled, next click fires; no unhandled rejection | `.catch` before `.finally`; resolve-only release |
| BV-7 | sync throw | `onAttack` throws → click doesn't throw; after flush enabled + re-clickable | `Promise.resolve(cb())` (D3) |
| BV-8 | `hide()` releases | pending; `hide()`; `refresh(vm)` → enabled, click fires | link-drop dead control |
| BV-9 | PvP untouched | RT-PVP-DS-01 block green; PvP Submit with unsettled `onPvpAttack` does NOT disable siblings | PvP routed through `#dispatch` |
| BV-11 | generations | click (P1 unsettled); `hide()`; `show()`+`refresh(vm)`; click (P2); resolve P1 + flush → buttons STILL disabled, third click swallowed; resolve P2 → enabled | membership-keyed release (D11) |
| BV-10 | order | callback invoked synchronously inside `.click()` | `.then(() => cb())` deferral |
| RV-1 | Train double | same monster/food two clicks → one `onTrain`; all Train of that monster disabled; its Care ENABLED; sibling monster's Train enabled | shared boolean; Care/Train cross-block |
| RV-2 | mid-flight refresh + live re-enable | as BV-4 | detached-node re-enable |
| RV-3 | rejection + sync throw | as BV-6/7 | |
| RV-1b | hostile re-enable | as BV-3 on Train | disabled-only impl |
| RV-5 | generations | as BV-11 on Train (hide → reopen → second click → first settles) | D11 |
| RV-4 | hide | `hide()` clears `#pendingTrain`; C4/C6 Care tests unchanged | |
| EV-1 | evolve rejection (seed) | `onEvolve` rejects; before flush disabled; after flush enabled with NO `refresh()` | re-enable-on-next-batch (shipped) |
| EV-2 | all choices lock | click choice A → choice B (same monster) disabled + ignored; other monster's enabled | per-button; view-wide |
| EV-3 | mid-flight refresh + live re-enable | as BV-4 | |
| EV-2b | hostile re-enable | as BV-3 on a choice button | disabled-only impl |
| EV-5 | generations | as BV-11 on evolve | D11 |
| EV-4 | existing evolution tests green | regression | |
| PV-1 | lifecycle lock | Accept unsettled → Decline ignored; Cancel + every challenge-player button disabled | per-button lock |
| PV-2 | rejection/short-circuit release | as BV-6; Accept + Decline enabled after flush | |
| PV-3 | mid-flight refresh | `refresh(vm,true)` during pending → rebuilt disabled; settle → enabled | |
| PV-4 | hide/force-hide | `refresh(vm,false)` while pending → next `refresh(vm,true)` enabled | tradePropose pattern missing |
| PV-1b | hostile re-enable | as BV-3 on Accept | disabled-only impl |
| PV-6 | generations | as BV-11 (refresh(vm,false) → refresh(vm,true) → second click → first settles) | D11 |
| PV-5 | :410-431 edit | `await flushPromises()` between Accept and Decline; still asserts both | documents D2 |
| M-1 | main.wiring source scan | `function sendGuarded(` line contains `): Promise<void>`; per D12 each of the 11 callback bodies (`onAttack:`…`onUseItem:`, `onTrain:`, `onEvolve:`, pvp `onChallenge:`/`onAccept:`/`onDecline:`/`onCancel:`) contains EXACTLY ONE `sendGuarded(` and starts with `{ return sendGuarded(` after whitespace-squash | void-returning callback → lock releases after one microtask (tsc-invisible) |
| M-2 | frozen short-circuit resolves | per D12: each `return Promise.resolve();` anchored to its own branch window, unique; no ` as ` / `!.` in the body | never-settling short-circuit; cast-hidden `undefined` return |
| M-3 | reconnect release | `onReconnect:`→`onOwnWarp` window contains `battleView?.hide()`, `raisingView?.hide()`, `evolutionView?.hide()` exactly once each | D10 |

## 4. Anti-patterns
1. Releasing the lock on ANY `refresh()`. 2. Keying pvp by challengeId; keying battle by a boolean. 3. Editing `battleModel.ts`.
4. Shared boolean across monsters. 5. `.catch` before `.finally`; `.finally` without trailing `.catch`. 6. `Promise.resolve(cb())`
/ `.then(() => cb())`. 7. Re-enabling the closure-captured node instead of the LIVE one. 8. Disabling `<select>`s or `#root`-wide
queries in pvpView. 9. Guarding `closeOverlayA11y` / moving it off the last statement. 10. Long comments inside `onEvolve` (600-char
window). 11. `try/catch` inside `sendGuarded`. 12. Leaving the false :254 comment.

## 5. Mutation-readiness
Each new statement has a named killer in §3 (pending check → BV-3/RV-1/EV-2/PV-1; same-battle finally check → BV-5;
`#applyPendingLock` → BV-4; hide release → BV-8/RV-4/PV-4; `new Promise` shape → BV-7/RV-3; `.catch` swallow → BV-6;
map `.clear()` → RV-2/EV-3; `return` in main.ts → M-1; `Promise.resolve()` → M-2).

## 6. Risks / follow-ups
- **R-20r-a-FOCUS** (a11y, real browser only): disabling the focused button drops focus to `<body>`; the trap is inert until the
  next refresh. Today the same focus loss happens on the NEXT BATCH for every one of these buttons (their containers are
  `replaceChildren`'d on refresh); this slice moves it to click time for Train/Evolve/pvp. Registered as a residual
  (mr-gates residuals add) — fix = move focus to the overlay anchor at dispatch or `aria-disabled` + key check; happy-dom cannot measure it.
- Shipped Care lock (`raisingView.ts:216-232`) has the D11 generation hole too; byte-pinned block, out of scope → residual R-20r-a-CARE-GEN.
- Evolve resolve→batch window: a second click after resolve but before the batch is server-rejected. Accepted.
- e2e: Playwright `click()` auto-waits for enabled; no `force:true` in `client/e2e`.
- Hidden-dependency watch (STOP if hit): `battleModel.ts`, `overlayA11y.ts`, shared test utils, `evals/*` censuses.

Reviewer minors: retire the `refresh()` "BYTE-UNCHANGED (plan T7)" clause in `pvpView.test.ts:17,27` (m23-s3's obligation, now
false); acknowledge line-citation drift (`evals/keyboard-operable-rows.eval.mjs:201` prose cites `raisingView.ts:209,219`;
ADR line cites into battleView/evolutionView) in the PR body per the ADR-0155:223 precedent — comment-only, no eval edit.

## 7. Tasks
1. tester: helpers + RV/EV/BV/PV/M tests (RED except regressions). 2. main.ts + ARCHITECTURE.md. 3. raisingView. 4. evolutionView.
5. pvpView (+ PV-5 test edit by tester). 6. battleView. 7. verifier mutants; `just ci`; PR body with D1–D9 + follow-ups.
