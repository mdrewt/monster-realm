# ux1 build plan — persistent help-affordance hint + battle-result continue hint

**Slice:** `ux1` (M-postgate-ux-hardening) · **ADR:** 0151 (supervisor-assigned) · **Base:** master `bb87d74`

Spec: `specs/monster-realm-v2/M-postgate-ux-hardening.spec.md` §ux1 (harness repo).
EARS: **ux1-1** persistent always-visible "Press ? for controls & help" hint · **ux1-2** persistent
"Press Esc to continue" on battle-result (victory/flee/defeat) · **ux1-3** proof-of-teeth for both.

## The finding that reshaped the plan (red-team CRITICAL-1, independently confirmed)

`#help-overlay` (`client/index.html:79`) is a **static, in-flow `<div>`** carrying only
`style="display:none"` — no `position`, no `z-index` — and it sits **after** `#app`, which holds a
`window.innerHeight`-tall PixiJS canvas (`client/src/render/world.ts:57-63`). There is **no CSS file
anywhere in the repo** (`find client -name '*.css'` → zero hits) and `HelpView` only ever
reads/writes `style.display` (`client/src/ui/helpView.ts:36-51`). So `HelpView.show()` paints the
overlay at `y ≈ innerHeight` — **entirely below the fold** — in default black text on the
`#0b0d12` body background.

Corroboration, three independent sources:

- in-tree, ADR-0146 (`client/src/main.ts:502-504`): *"an open overlay makes the document taller than
  the viewport-sized canvas, so those defaults scroll the game out from under the player."*
- `memory/projects/PlaytestReport.md:85` on the structurally-identical `#shop-overlay`: *"opens a
  shopping menu **at the bottom of the page** … its placement is awkward."*
- `PlaytestReport.md:41`: *"there is **no help text or instructions of any kind**"* — Drew never
  found the `?` overlay at all.

**Consequence:** shipping ux1-1's hint alone would advertise an affordance that appears to do
nothing when followed — a net-negative UX change that passes 100% of its own static-markup teeth.
So ux1-1 is delivered as **two parts**: make the advertised target viewport-anchored (1 inline
style, same file, in touch-set), then advertise it. Recorded as a disclosed extension in ADR-0151
(nh1/ADR-0146 `e.repeat` precedent).

Scope discipline: **only `#help-overlay`** is repositioned. The other nine in-flow overlay shells
(`dialogue`, `quest-log`, `heal`, `shop`, `trade`, `pvp-challenge`, `leaderboard`, `rename`,
`tradepropose`) have the identical defect and are named as a residual for
`M-postgate-overlay-registry` — not fixed here.

## Design

### ux1-1a — `#help-overlay` becomes viewport-anchored (`client/index.html`)

`display:none;position:fixed;inset:0;z-index:100;overflow:auto;background:rgba(0,0,0,0.88);padding:24px;font:14px/1.6 monospace;color:#e0e0e0`

Mirrors the four JS-created modal roots (`boxView.ts:32`, `raisingView.ts:29`, `evolutionView.ts:39`
are `position:fixed;inset:0;z-index:100`), stays **below** `battleView`'s `z-index:110`
(`battleView.ts:51`) so a battle auto-show still supersedes it. `HelpView.show()/hide()/visible`
touch only `style.display`, so `show()` (`display = ''`) leaves every other declaration intact —
no view-class change needed.

### ux1-1b — the hint (`client/index.html`)

`<div id="help-hint" style="position:fixed;bottom:16px;left:6px;font:11px/1.3 monospace;color:#9aa0b4;pointer-events:none;z-index:50">Press ? for controls &amp; help</div>`

- `bottom:16px` **stacks above** `#build-stamp` (`bottom:2px;right:4px`), so the two never collide —
  red-team measured a real overlap at 360 px width with a shared `bottom:2px`.
- `pointer-events:none` — load-bearing: a fixed element over the canvas must not eat clicks.
- `z-index:50` — below the modal band, above the static canvas (red-team `elementFromPoint` at
  1280×720 / 480×800 / 360×640 returns `help-hint`, not the canvas).
- **No** `data-testid` (`#build-stamp`/`#help-overlay` carry none; teeth query by id), **no**
  `user-select:none` (redundant under `pointer-events:none`), **no** `opacity` (colour alone dims —
  double-dimming a hint aimed at a player who couldn't find the feature is self-defeating).

### ux1-2 — continue hint (`client/src/ui/battleView.ts`)

`#continueHintEl` created in the constructor immediately after `#outcomeEl`,
`data-testid="battle-continue-hint"`, `textContent` set **once** in the constructor to
`Press Esc to continue`, `display:none` initially. Toggled inside the **existing** `#renderOutcome`
(which already branches on exactly `vm.outcome === 'Ongoing'`), plus reset in the `refresh(null)`
branch alongside `#weatherEl`/`#pvpStatusEl` (that branch's own precedent; red-team measured the
element otherwise retains `display:block` across `refresh(null)` and `hide()/show()` — latent
today, since `show()` is only reachable from inside `refresh(vm)`).

**Not** appended into `#outcomeEl`'s text: `client/e2e/recruit.spec.ts:753,779,931` use
`getByText('Victory!', { exact: true })`, and `#outcomeEl` is 18 px bold gold — wrong styling for a
hint. **Not** a child of `#outcomeEl` either: `#renderOutcome` sets `textContent`, which would wipe
a child every render. **No `isPvp` branch** — `#renderOutcome` and the Escape branch
(`main.ts:964`, gated only on `battleView?.visible`) are both battle-kind-agnostic.

## Truthfulness of "Press Esc to continue" — established, with one recorded limit

Red-team attacked this from five directions and **failed on all five**: the three higher-priority
Escape branches (rename `main.ts:943`, tradePropose `:952`, help `:958`) cannot be open over a
battle overlay — all three are force-hidden by the battle auto-show path (`main.ts:1127-1139`,
verified directly) and their open-guards all contain `!battleView?.visible`; the battle Escape
branch is a pure local `hide()` with no `sendGuarded`, so a frozen link cannot deaden it;
`dismissedBattleId` sticks (`battleModel.ts:379-381`) and reconnect pre-dismisses rather than
re-pops; and the terminal frame renders zero action buttons (`bench` is only populated inside
`if (ongoing)`, `battleModel.ts:257-270`).

**Recorded limit (pre-existing, not ux1's to fix):** a PvP battle is ONE row with
`player_identity = challenger` (`server-module/src/pvp.rs:291`), and `store.latestPlayerBattle`
filters `playerIdentity === identity` (`store.ts:718-726`), so the **challenged** player never gets
the overlay through the production path at all (`main.ts:1581` documents this for the `__mrPvp`
test hook). The PvP test case below is therefore a **decision-pin for the no-`isPvp`-branch call**,
and must not be cited as evidence of both-sides PvP truthfulness.

## Proof-of-teeth (ux1-3)

### `client/src/indexShell.test.ts` (NEW, `@vitest-environment happy-dom`)

Reads the **real** `client/index.html` off disk via `import.meta.url` (cwd-independent;
`main.wiring.test.ts:49` precedent), fail-loud on read error, then `DOMParser`-parses it.
The repo's dominant view-test idiom — hand-mirroring the shell as an inline fixture string
(`helpView.test.ts:50`, `renameView.test.ts:48`) — is **vacuous here** and is deliberately not used.

| # | Assertion | Wrong impl killed |
|---|---|---|
| H1 | `#help-hint` exists and `parentElement.tagName === 'BODY'` | deleted div; div nested inside a `display:none` overlay shell |
| H2 | `#build-stamp.parentElement.tagName === 'BODY'` | **unclosed `</div>`** — the parser adopts `#build-stamp` as a *child* of `#help-hint` (red-team measured it), silently regressing the pt-a1/ADR-0128 provenance surface while every existence check stays green |
| H3 | text contains `?` **and** lowercased text contains `help` | `"Press F1 for help"`; a bare `"?"`; an empty div |
| H4 | inline style contains `position:fixed` and `pointer-events:none` | a static hint that scrolls away with the document; a hint that eats canvas clicks |
| H5 | inline style contains **none** of `display:none` / `visibility:hidden` / `opacity:0` / `font-size:0` | the four cheapest invisibility regressions |
| H6 | raw z-index matches `/^\d+$/`, parsed value `>= 1` **and** `< #help-overlay`'s own parsed z-index | `z-index:-1` (paints behind in-flow boxes); `z-index:5e1`/`1e2` (CSS-invalid → browser drops it, but `parseInt` accepts); a `9999` copy-paste from `#build-stamp` that would float over every modal |
| H7 | `#help-overlay` has `position:fixed` and a numeric z-index in `[1,110)` | **the CRITICAL-1 regression** — the advertised affordance reverting to an in-flow, below-the-fold div |

**Honesty note baked into the test names:** happy-dom performs no layout, so this file asserts
*"present, body-anchored, and not obviously invisible"* — **not** *"visible"*. Red-team ran 26 wrong
impls through the assertion set: `opacity:0`, `visibility:hidden`, `font-size:0`, `left:-9999px`,
`transform:scale(0)`, `clip-path`, `content-visibility`, the `hidden` attribute and a zero-size
ancestor all pass a static-markup test, and `getComputedStyle` returns `visibility: ""` on a parsed
document. H5 is a deny-list for the cheap cases; real visibility belongs in `client/e2e/**`
(`toBeInViewport()`), which is **out of this slice's touch-set** — recorded as an ADR residual
rather than pretended away. No anti-vacuity existence sentinel: a broken parse makes every
`querySelector` return `null`, which is RED, not vacuously green.

### `client/src/ui/battleView.test.ts` (appended)

Reuses the existing `makeTerminalVM` (`:353`) / `makeCallbacks` (`:78`) factories.

- 3 terminal outcomes (`SideAWins` / `SideBWins` / `Fled`) → hint present, `display !== 'none'`,
  text contains `Esc`. *Kills:* an early-return before the toggle; a blanked text.
- `Ongoing` → hint hidden. *Kills:* the always-visible impl (constructor `display:block`, never
  toggled) — without this case, existence alone cannot kill it.
- PvP terminal (`{ ...makeTerminalVM('SideAWins'), isPvp: true }`) → still visible. *Kills:* a future
  `if (!vm.isPvp)` guard. Decision-pin (see the recorded limit above).
- `refresh(terminal)` then `refresh(null)` → hint hidden. *Kills:* the omitted `refresh(null)` reset.

### `client/src/main.wiring.test.ts` (appended at EOF, 2 pins)

- **`W-UX1-ESCAPE-BATTLE`** — `main.ts` contains `e.code === 'Escape' && battleView?.visible`.
  Green-before-and-after **by design**: it is a regression pin on the binding that makes ux1-2's
  promise true, and the repo has the precedent for a deliberately-green guard with a documented
  self-check (`W-HELP-NO-RECONNECT-HIDE`, `main.wiring.test.ts:1541`). Justified because the branch
  is otherwise **wholly untested**: `main.ts` is coverage-excluded (`vite.config.ts:97`) and no e2e
  presses Escape against a battle-result overlay. The pre-existing `ESCAPE_SENTINEL`
  (`main.wiring.test.ts:1683`) is used only for block-slicing and is never asserted `>= 0`.
- **`W-UX1-HINT-NO-JS-OWNER`** — `main.ts` does **not** contain `help-hint`. Converts "it's static
  markup, trust me" into an enforced invariant, and is the only tooth that pins EARS ux1-1's
  explicit *"not just on first load"* qualifier: with no JS owner, nothing can hide or remove it.

Anchor discipline: both pins are whole-file `indexOf` checks, **never** fixed-width `slice(idx, idx+N)`
windows (the nh1/nh2 post-mortem anti-pattern; a third instance of it is not being added). No
`new RegExp(...)` anywhere (Semgrep `detect-non-literal-regexp`, ADR-0064).

## Anti-patterns / deliberate non-goals

**Avoid:** a `hintView.ts`/`hintModel.ts` pair — premature abstraction *and* a coverage landmine
(`evals/dom-shell-coverage-exclusion.eval.mjs` `findUnsanctionedExclusions` exact-set-guards
`vite.config.ts` `coverage.exclude`, and **both** are out of touch-set, so a new `src/ui/*.ts` shell
would land in the 96% denominator with no legal way out). Rendering the hint from `main.ts` (which
is coverage-excluded → zero unit teeth, and the hint would be absent exactly when the client fails
to boot). `innerHTML` (ADR-0135 XSS firewall). Hand-mirrored `index.html` fixtures.

**Deliberately NOT doing:** a generic hint framework/registry (ux4's "added to box" hint, if it
happens, ships its own element); dismissible/persisted hint state; the other nine in-flow overlay
shells (→ `M-postgate-overlay-registry`); any e2e spec (`client/e2e/**` out of touch-set);
responsive/viewport sizing (spec §4 deferral).

## Tasks

1. **T1 (RED)** `client/src/indexShell.test.ts` — H1–H7.
2. **T2 (GREEN)** `client/index.html` — reposition `#help-overlay`, add `#help-hint`.
3. **T3 (RED)** `client/src/ui/battleView.test.ts` — the 6 continue-hint cases.
4. **T4 (GREEN)** `client/src/ui/battleView.ts` — element + toggle + `refresh(null)` reset.
5. **T5 (RED→pin)** `client/src/main.wiring.test.ts` — the 2 pins.
6. **T6** ADR-0151, minimal `ARCHITECTURE.md`, `just adr-digest`, `just knowledge` (expected no-op),
   mutation-bite proofs, full `just ci`.

## `touches:` reconciliation

`client/index.html` · `client/src/ui/battleView.ts` · `client/src/ui/battleView.test.ts` ·
`client/src/indexShell.test.ts` (NEW — sibling test **for `client/index.html`**; it cannot sit next
to the HTML because `vite.config.ts` restricts discovery to `src/**/*.test.ts` and `vite.config.ts`
is out of touch-set) · `client/src/main.wiring.test.ts` · `docs/adr/0151-*.md` ·
`docs/adr/DIGEST.md` (generated) · `ARCHITECTURE.md` (minimal) · this plan file.

**Not touched:** `client/src/main.ts`, `client/src/net/connection.ts` (concurrent `nh4`),
`client/vite.config.ts`, `evals/**`, `client/e2e/**`, `CHANGELOG.md`, `docs/adr/README.md`,
`server-module/**`, `game-core/**`, lockfiles.
