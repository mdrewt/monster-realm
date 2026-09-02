# rb-36 plan (v2, post plan-review) — fix drifted `main.ts:<N>` citations

## Ground truth (measured on origin/master b5302aa; independently re-derived by both lenses)
- Sole production `dialogueView.render` call site: `client/src/main.ts:1641`
  (`dialogueView?.render(dialogueVm)`), inside the `store.onBatchApplied` listener at `:1627`,
  under the unique banner `// --- M12d: dialogue / quest log / heal views (ADR-0071)` at `:1625`.
- `main.ts:1574` = a `cureItems` flatMap. CONFIRMED DRIFT.
- `main.ts:362` = `boxView: () => boxView?.hide(),`. The force-hide table spans `:360-377`,
  `dialogueView: undefined` is at `:365`. ALSO DRIFTED (same class, same declared files).

## Strategy: cite a GATE-PROTECTED / unique landmark, and keep the number as a dated hint
Re-pointing a bare number reproduces the defect on a delay. Both plan-review lenses agreed:
anchor is load-bearing, line number stays as a navigability hint marked "today".

**Red-team find (adopted):** `main.ts:348`/`:378` already carry `// UXD3C-HANDLES-BEGIN` /
`// UXD3C-HANDLES-END` around the handle table, and `client/src/main.wiring.test.ts:4867` pins
that literal against `readMainTs()` — so it is CI-protected against silent removal. That is a
strictly better citation target than any line number, and needs ZERO `main.ts` edits.

**Decoy-literal guard:** citations reference the anchor WITHOUT reproducing the pinned literal
form (`// UXD3C-HANDLES-BEGIN` with its `// ` prefix) and WITHOUT reproducing the M12d banner
verbatim — a planted duplicate literal is the `first-hit-anchor-is-forgeable` failure mode.

## Sites (6)
| # | file:line | current | replacement | scope |
|---|-----------|---------|-------------|-------|
| 1 | dialogueView.ts:16   | main.ts:1574 | `main.ts`'s M12d dialogue/quest-log/heal `store.onBatchApplied` listener (`:1627-1641` today) | core |
| 2 | dialogueView.test.ts:243 | main.ts:1574 | same | core |
| 3 | dialogueView.test.ts:289 | main.ts:1574 | same | core |
| 4 | dialogueView.test.ts:371 | main.ts:1574 | same | core |
| 5 | dialogueView.ts:21   | main.ts:362  | `main.ts`'s `UXD3C-HANDLES`-delimited force-hide table, `dialogueView: undefined` at `:365` today | boyscout |
| 6 | dialogueView.test.ts:448 | main.ts:362 | same | boyscout |

Sites 5/6: identical defect class, SAME declared files, five lines from a block already being
edited. Attributed `boyscout-delta:` (comment accuracy) because the brief named only the four
`:1574` sites. ~6 changed lines, 2 hunks — far inside the ~40-line / <=3-hunk cap.

## Always-in-scope companions
- `ARCHITECTURE.md:1923` — SAME `main.ts:1574` citation for the SAME fact -> corrected (one line).
  Verified safe: `evals/rekey-contract-surface.eval.mjs`'s `ARCH_PARAGRAPHS` pins only the
  `**rb-2**`/`**rb-3**` markers, not `**m23-s3**` (:1923) or `**rb-18**` (:2123).
- `ARCHITECTURE.md` gains an appended `**rb-36**` slice record (rb-15/rb-17/rb-18 convention;
  the file's slice-record log is append-at-end, currently ending at :2123).
- `ARCHITECTURE.md:2123` (rb-18's record) states the drift as a flag rb-18 LEFT OPEN. That is a
  true historical statement -> NOT edited. rb-36's own record closes it.
- No `CHANGELOG.md` hand-edit (git cliff). No `docs/adr/README.md`.

## Out of scope — follow-up flags only (do NOT touch; task does not REQUIRE them)
- `client/src/ui/overlayA11yWiring.test.ts:289-296` — prose meta-citation. Note honestly: it goes
  stale as a DIRECT CONSEQUENCE of this slice's own edit ("the other two are flagged, not
  touched" becomes false). Prose only, no assertion, CI-neutral.
- `client/src/main.a11yFocus.test.ts:782` — same `:1574` drift, undeclared file.
- `docs/adr/0206-...:194` — same drift. **Corrected exclusion reason** (the first draft's was a
  non sequitur): the companion rule admits `docs/adr/**` for THIS SLICE'S RESERVED NUMBER ONLY,
  and this slice has none reserved (`None`), so an existing third-party ADR is outside the
  admitted set. Not a governance claim about editing ADR bodies.

## Non-goals
- No behaviour change. No new `evals/*.eval.mjs` (ADR-0224). No manufactured gate for a prose fix.
- No `main.ts` edit (outside `touches:`).
- No new ADR: no dependency and no production pattern is added (rb-15/rb-17/rb-18 precedent).

## Verification (one-shot, NOT a shipped gate)
Every replacement anchor must resolve UNIQUELY in `client/src/main.ts` and the fact it asserts
must be true of the resolved code. Executed by the tester lens; `just ci` is the merge gate.

## Gate
`just ci` green. Acceptance ledger: 0 seeded criteria (prose-only residual) — nothing to DEFER.
