# nh1 — build plan (M-postgate-netcode-hardening)

Slice: **nh1** · ADR: **0146** · Branch: `feat/nh1-movement-suppression-preventdefault` (from `3d02b38`)

## Scope

Fix: the keydown handler in `client/src/main.ts` returns without `e.preventDefault()` on two
paths, so movement keys leak to the browser's native page-scroll while an overlay is open.

**Touches (declared):** `client/src/main.ts` + sibling test `client/src/main.wiring.test.ts`.
**Doc outputs:** `docs/adr/0146-*.md`, `docs/adr/DIGEST.md`, `ARCHITECTURE.md`, this plan.
**Out:** predictor/queue work (nh2), server, any new source module (`inputGuards.ts` etc.),
`client/e2e/**`, `CHANGELOG.md` (git-cliff), `docs/adr/README.md` (supervisor).

## EARS

- **nh1-1** — WHEN the movement-suppression branch is taken AND the key is a movement key
  (`KEY_DIR[e.code] !== undefined`) OR `Space`, THE handler SHALL call `e.preventDefault()`
  before returning.
- **nh1-1e** (disclosed extension, ADR-0146) — the same SHALL hold on the `e.repeat` early
  return, since each OS-repeat keydown carries its own default action and holding a key is the
  dominant real-world case.
- **nh1-1t** (regression guard, ADR-0146) — the suppression SHALL NOT cancel a key whose
  native action the event target owns (`INPUT`/`TEXTAREA`/`SELECT`/`contentEditable`; `Space`
  on `BUTTON`/`A`).
- **nh1-2** (proof-of-teeth) — a test SHALL assert the suppression is wired on both paths and
  starts RED; removing it re-fails the assertion.

## Implementation shape

Next to `KEY_DIR` in `main.ts`, two non-exported helpers: `targetOwnsKey(e)` and
`suppressNativeMovementDefault(e)`. Called at the `e.repeat` early-out and inside the
14-overlay suppression block, before each `return`. No other behavior changes.

## Gate design (`client/src/main.wiring.test.ts`, source-scan)

`main.ts` is not importable under vitest (module-scope DOM/PIXI/wasm side effects) — teeth are
source-scan, per this file's established precedent. **No `new RegExp`** (Semgrep
`detect-non-literal-regexp`): `indexOf`/`includes`/`split` only.

Regions are **anchor-bounded, never fixed-width** — a fixed forward window from the suppression
comment overruns into the movement branch at `main.ts:1028`, which already contains a legitimate
`e.preventDefault()`, making the tooth vacuous against the unfixed baseline.

| Tooth | Region | Kills |
|---|---|---|
| `W-NH1-HELPER` | helper definition | missing helper; `&&`-for-`||` swap (contiguous `!== undefined ||` needle); missing `Space` |
| `W-NH1-SUPPRESS` | overlay block (comment → `const dir = KEY_DIR[e.code];`) | the current unfixed code; call placed after the `return` |
| `W-NH1-REPEAT` | `e.repeat` early-out | first-keydown-only fix (held key still scrolls) |
| `W-NH1-TARGET` | `targetOwnsKey` body | blanket target-skip that reopens arrow-scroll on a focused button (`Space` must be gated for `BUTTON`/`A`); missing `SELECT`/`INPUT`/`TEXTAREA`/`isContentEditable` |
| anti-vacuity | all | every anchor asserted found (fail loud, no empty-slice pass); line comments stripped before matching |

**Known limit (disclosed in ADR-0146):** substring scanning cannot catch an inverted
`=== undefined`. A behavioral test needs a shared module (out of touch-set) or e2e (out of
touch-set) — named as follow-up.

## Tasks

1. ADR-0146 + this plan → `wip:` checkpoint. ✅
2. `tester` (separate agent) writes the teeth → verify RED.
3. Implement red→green in `main.ts` (implementer does not edit the gating tests).
4. Re-run the sibling gates that slice the same anchor
   (`W-RN-FANOUT-KEYDOWN`, `W-TP-FANOUT-KEYDOWN`, `W-HELP-FANOUT-KEYDOWN`,
   `W-OVERLAY-FANOUT-MUTEX`) — their needles sit *before* the insertion point, so they should be
   unaffected; verify rather than assume.
5. Parallel lenses: `reviewer` + `red-team` + desync `review-lens` → `verifier`.
6. `just adr-digest` (DIGEST regen), `ARCHITECTURE.md` note, full `just ci`, PR.
