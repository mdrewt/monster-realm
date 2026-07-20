# pt-c2b Build Plan — In-client help overlay + `docs/PLAYTEST.md`

Slice **pt-c2b** (M-playtest-c residual). Client-only, SERIAL (fan-out-ineligible:
adds ADR-0135, edits ARCHITECTURE.md + main.ts). Base: origin/master @ 3a9cde4.
ADR reserved: **0135**.

## Scope (right-sized) — ship exactly TWO deliverables
1. **In-client help overlay** — display-only modal listing controls (key→action) +
   session goals, opened by `?`, toggle-close on `?`, Escape-close, mutually
   exclusive with every overlay. NO text input, NO submit, NO reducer.
2. **`docs/PLAYTEST.md`** — tester onboarding runbook.

### PARKED → pt-c2c (explicit deferrals, do NOT build here)
- First-join auto-show ("shown once, store-flagged") — needs a NEW localStorage/
  persistence seam (client has zero localStorage today); PLAYTEST.md closes the
  discovery gap by naming the `?` key, so auto-show is a UX enhancement, not gate-blocking.
- Trade-propose item-offer rows + counterparty monster/item selection (counterparty
  side is RLS-impossible from the client).

## Functional-core / imperative-shell split
| Layer | File | Nature | Coverage |
|---|---|---|---|
| Pure VM + SSOT | `client/src/ui/helpModel.ts` (NEW) | total `buildHelpViewModel()` → `{ controls:{key,action}[]; goals:string[] }`; controls list a typed SSOT `const` (dialogueContent/renameModel precedent). No DOM/SDK/throw. | unit |
| DOM shell | `client/src/ui/helpView.ts` (NEW) | thin `HelpView`: `#overlay` ref, `visible`, `show/hide/toggle`, `render(vm)` painting `textContent`-only `<li>`s via `replaceChildren`. NO input/submit/#pending/callbacks. | full happy-dom unit |
| Shell | `client/index.html` (EDIT — touches-delta, SERIAL-safe) | `<div id="help-overlay" style="display:none">` + `#help-controls`/`#help-goals` `<ul>`s. Mirror `#leaderboard-overlay`. | e2e |
| Wiring | `client/src/main.ts` (EDIT) | import + `let helpView` + dynamic-import + zero-arg `new HelpViewClass()` + `?` handler + full fan-out. | source-scan |
| Wiring teeth | `client/src/main.wiring.test.ts` (EDIT — append describe) | source-scan assertions (indexOf/includes/split; NEVER `new RegExp`). | — |
| e2e (recommended) | `client/e2e/help-overlay.spec.ts` (NEW) | open/toggle/Escape/movement-suppression/mutual-exclusion. | Playwright |
| Doc | `docs/PLAYTEST.md` (NEW) | prose. | — |
| ADR | `docs/adr/0135-pt-c2b-help-overlay.md` (NEW) | decision record. | — |

**Do NOT touch:** `client/vite.config.ts`, `dom-shell-coverage-exclusion.eval.mjs`,
`server-module/`, `game-core/`, `client/src/module_bindings/`, `evals/`.

## Fan-out checklist (main.ts) — 24 additions + 1 deliberate omission
Scaffolding (4): import · `let helpView` · dynamic-import+destructure · zero-arg construct.
Self-branch (1): `?` handler `if (e.key === '?')` — self-guard lists all 13 siblings;
on open `held.clear()` + `helpView?.render(buildHelpViewModel())`; toggle-close; `e.preventDefault()`.
Sibling open-guards +`&& !helpView?.visible` (12): KeyB/I/E/Q/H/G/U/P/L/N/O/T.
Escape (1): `if (e.code==='Escape' && helpView?.visible){ helpView.hide(); preventDefault; return }` adjacent to rename/tradePropose Escape branches.
Movement-suppression OR-blocks +`helpView?.visible ||` (3): reconcile-diverge block · keydown movement block · rAF held-key re-issue block.
PvP aggregate (1): `anyOverlayVisible` += `helpView?.visible ||`.
Battle-supersession (1): `refreshBattle()` show-path += `if (helpView?.visible) helpView.hide()`.

**DELIBERATE OMISSION (D3, ADR-0135):** `onReconnect` DOES NOT hide helpView.
Rationale: rename/tradePropose/shop/trade are hidden on reconnect only because they
hold an in-flight `#pending` reducer lock that never settles on a dropped link
(ADR-0085). helpView holds no lock and no server state (static const) → surviving a
reconnect is correct. Pinned by tooth `W-HELP-NO-RECONNECT-HIDE` (asserts the
onReconnect region does NOT contain `helpView?.hide`) so a future "consistency" edit
can't silently add one.

## Help-key decision (ADR-0135)
`?` via `e.key === '?'` (glyph, not physical position — movement uses `e.code`;
help is about the character, robust across layouts). `?`/Slash unclaimed in the
keymap. `F1` rejected: browser-intercepts help + less discoverable than an on-screen "press ?".

## Anti-patterns forbidden (each → a biting tooth)
1. Missing fan-out site → count-floor tooth `W-HELP-FANOUT-COUNT` (freeze literal N =
   authoring-time `tradeProposeView?.visible` count) PLUS per-context anchored teeth
   (keydown/reconcile/rAF/pvp/battle/escape/key) — a count floor alone is the m17b
   fan-out-coverage-trap.
2. `innerHTML`/interpolated HTML in helpView → `helpView.test.ts` XSS tooth (a
   `<script>`-looking VM string renders as literal textContent).
3. `new RegExp(...)` anywhere (Semgrep detect-non-literal-regexp — bitten twice).
4. Adding helpView to coverage.exclude/DOM_SHELLS (it's fully covered — fix low
   coverage with MORE test, never an exclude).
5. Scope-widening into parked items / protected trees.
6. Over-engineering help content into RON (YAGNI — typed TS const SSOT).

## EARS PTC2B-1..12
1 help-open · 2 toggle-close · 3 Escape-close · 4 mutual-excl (help suppressed under any
overlay) · 5 mutual-excl (siblings suppressed while help visible) · 6 movement suppression
(keydown+reconcile+rAF) · 7 no PvP auto-show over help · 8 battle supersession hides help ·
9 reconnect survival (asymmetry — help NOT hidden) · 10 content=controls+goals textContent-only,
rebuilt authoritatively · 11 display-only (no input/submit/reducer) · 12 PLAYTEST.md 8 sections.

## docs/PLAYTEST.md outline (8 sections)
What-this-is · Launch (`just playtest-up`, ref docs/playtest-ops.md — don't duplicate) ·
Controls (from helpModel SSOT; `?` = Help) · First-15-minutes · Known issues ·
F9 bug-bundle ritual (ADR-0130/pt-b1) · Feedback channel · Anonymous-identity caveat
(per-browser until M21).

## Tasks (tester-first)
T1 tester helpModel.test · T2 tester helpView.test · T3 tester main.wiring append ·
T4 tester e2e (recommended) → T5 impl helpModel · T6 impl helpView+index.html ·
T7 wire main.ts · T8 PLAYTEST.md · T9 ADR-0135 + ARCHITECTURE (doc writes MUST target
the worktree — recurring doc-keeper main-checkout trap m17.5c/d/e).

## Plan-review resolutions (reviewer + red-team — FINAL, binding on the tester)
Both lenses confirmed the fan-out SET is complete + the onReconnect asymmetry is safe. The
corrections are all in the source-scan TOOTH design (the tester MUST implement these exactly):

- **Count-floor = 19, NOT 21** (reviewer HIGH-1 / red-team F1). `helpView?.visible` appears
  exactly 19× — structurally identical to `leaderboardView?.visible` (verified = 19).
  tradePropose's 21 includes 2 sites help cannot have (reducer-response feedback + Identity self-branch).
  Assert `>= 19` (or exact 19) — freezing 21 makes the tooth unsatisfiable by a correct impl.
- **rAF tooth window** (red-team F2): help's `||` goes at the TOP of the movement OR-block, ~630 chars
  BEFORE `predictor.drain(` — OUTSIDE the existing `drain-500` backward window. Anchor on the
  block-opening comment (`Re-issue the held dir`) and slice FORWARD, OR slice `drain-700` back.
  Verify the matched `helpView?.visible` is physically inside the OR-block.
- **`W-HELP-NO-RECONNECT-HIDE` = two-endpoint region** (red-team F3): bound by BOTH ends —
  `region = src.slice(indexOf('onReconnect:'), indexOf('onOwnWarp'))` — then assert
  `!region.includes('helpView?.hide')`. NEVER a fixed `+N` forward slice for a negative-containment
  assertion (the onReconnect body is ~2254 chars; a hide appended at the bottom would false-pass).
- **Dedicated `W-HELP-FANOUT-BATTLE` tooth** (red-team F4): anchor on `r.action.kind === 'show'`
  (unique), assert `helpView` within ~900 chars (existing tradePropose force-hide is at delta 880).
  Guard syntax MUST be exactly `helpView?.visible` (in the `if (helpView?.visible) helpView.hide()`
  form) so the count-floor needle credits it too.
- **KeyB/I/E carry a pre-existing dialogue/questLog/heal omission** (reviewer HIGH-2): add
  `!helpView?.visible` to their existing (incomplete) lists but DO NOT fix that omission (ptc5c scope;
  SERIAL-main.ts collision). pt-c2b teeth stay scoped to "`helpView?.visible` appears in each open-guard."
- **Drop the e2e** (reviewer MEDIUM-4): a display-only overlay with no server round-trip is fully
  covered by unit + happy-dom + source-scan; an e2e adds flake/wasm-clobber surface for no distinct
  defect class. (Tester role STILL mandatory for the unit + source-scan tests.)
- **PLAYTEST.md controls table = hand-written** to match helpModel (reviewer MEDIUM-5) — no generator,
  no drift gate (YAGNI). helpModel is the runtime SSOT for the overlay only.
- **`e.key === '?'` documented** as the sole `e.key` branch + Shift+Slash note (reviewer MEDIUM-2).
  `held.clear()` kept for consistency, NOT tooth-pinned (reviewer MEDIUM-3).
- **F5 dialogue auto-show** = known symmetric gap, DEFERRED to ptc5c (help matches siblings; ADR-0135
  documents it). Recount: header says "24" → actually **23 additions** (of which 19 contain the literal).
- **EARS PTC2B-9** reconnect-survival is enforced by the negative tooth `W-HELP-NO-RECONNECT-HIDE`
  (traceability).
