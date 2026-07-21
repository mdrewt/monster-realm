# ptc5d build plan — knowledge-bundle fixture exclusion + restored gate teeth

Slice of **M-playtest-c.5** (pre-gate residuals). ADR-0137. Tooling/eval hardening — no game-design/schema/reducer change. One mergeable PR.

## EARS → change → gate

| EARS | Change | Gate / proof-of-teeth |
|------|--------|-----------------------|
| ptc5d-1 | `collectRsFiles` (okf-export.mjs:65) excludes `*_tests.rs`; reconcile comments :59/:70; regen bundle (`just knowledge`) → exactly 5 files change, 42 reducers, real sources | conformance drift gate (green after regen) + ptc5d-2 real-file check (RED before regen) |
| ptc5d-2 | new pure predicate in conformance eval: no `reducers/*`/`tables/*` frontmatter `resource:`/`source:` line contains `_tests.rs` (line-prefix match, `.rs` suffix) | **synthetic** bad-fixture (temp `.md` with `source:…ranking_tests.rs`) BITES; good-fixture (`ranking.rs`) passes; real-bundle check zero offenders |
| ptc5d-3 | RT-M14.5A-02 (redteam_m14_5a_tests.rs:443-452) `return;` → `assert!(status_applied, <forensics>)` | deterministic scenario (active 3hp → −2 attack → 1hp, StatusApplied emitted → −1 chip → faint); assert bites a no-emit regression |
| ptc5d-4 | `const MUTATE_SERVER_CAP_BASELINE=299`; ceiling `cap>340`→`cap>299` (named); update 8 stale-340 sites | flip L-recap (309 accepted→rejected); add L-overcap (300 rejected) + 299-accepted control; L-bigcap (9999) + L-good (150) unchanged |

## Tester ↔ implementer split (anti reward-hacking)
- **Tester writes (RED):** ptc5d-2 predicate + synthetic teeth + real-file assertion (RED vs current bad bundle); ptc5d-4 flipped L-recap + L-overcap(300) + 299-accepted control (RED vs current 340 ceiling); ptc5d-3 `assert!` conversion (hardening — green, verifier confirms non-vacuous).
- **Implementer:** ptc5d-1 filter + comment reconciliation + `just knowledge` regen; ptc5d-4 const + ceiling change + all stale-340 comment/detail updates. Does NOT edit the tester's teeth.

## Anti-patterns to avoid
1. ptc5d-2 bad-fixture calling `runExport()` (self-defeats post-fix) → **synthetic fixed fixture**.
2. Blob `indexOf('_tests.rs')` → match only `resource:`/`source:` line-prefixes.
3. Magic `299` → named `MUTATE_SERVER_CAP_BASELINE`.
4. Missing L-recap polarity flip → reds CI on the fix commit.
5. `>=` instead of `>` at the 299 boundary → 299-accepted control catches it.
6. Leaving a false SSOT comment at okf-export.mjs:70.
7. Hand-editing generated bundle files → regen via `just knowledge`.

## Touches (declared)
`scripts/okf-export.mjs`, `evals/knowledge-bundle-conformance.eval.mjs`, `evals/nightly-smoke-wiring.eval.mjs`, `game-core/src/combat/redteam_m14_5a_tests.rs`, regenerated `docs/knowledge/**` (5 files). Companions: `docs/adr/0137-*.md`, `docs/adr/DIGEST.md` (regen), `ARCHITECTURE.md` (1 line), `docs/specs/ptc5d-plan.md`. NOT: justfile, ADR-0118 body, CHANGELOG, adr/README, server/game-core production code, module_bindings.
