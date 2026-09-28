# De-bloat program — final report

Executed 2026-09-27 → 2026-09-28, from tag `pre-debloat` (950c083) to the Phase-5 head.
The audit trail is `ledger.ndjson` in this directory (1,122 rows, one per named invariant /
criterion / bug, every executed row carrying the commit SHA(s) that executed it), validated
by `check-ledger.mjs`. `baseline/` is the frozen Phase-0 "before" snapshot. Merged PRs:
#520 (Phase 0), #521 (Phase 1 ledger — the user checkpoint), #523 (Phase 2), #524 (Phase 3),
#525 (Phase 4), and the Phase-5 PR that carries this report. Phase-exit tags:
`debloat/phase-2-complete`, `debloat/phase-3-complete`, `debloat/phase-4-complete`.

## Outcome

The repo halved: **628,279 → 311,567 tracked lines (−50.4%)**, with zero game features
removed, zero reverts, and the checking that remains executing production code instead of
reading its text. Nine player-visible or production bugs were fixed test-first along the way
(inventory rows were world-readable; the browser guest-claim flow was doubly unreachable;
see the bugs section).

## Headline metrics (like-for-like, `baseline/loc-by-category.md` vs the same script at Phase 5)

| category | before (files / lines) | after (files / lines) | delta |
|---|---:|---:|---:|
| evals | 195 / 145,169 | 40 / 8,463 | −94% |
| client-tests (e2e + `*.test.*`) | 155 / 140,177 | 154 / 110,442 | −21% |
| server-tests | 34 / 135,312 | 28 / 50,665 | −63% |
| production | 219 / 100,802 | 203 / 96,452 | −4% |
| docs-md | 442 / 62,435 | 38 / 4,149 | −93% |
| scripts-ops-ci | 56 / 23,799 | 48 / 10,712 | −55% |
| other | 184 / 16,685 | 247 / 26,799 | +61% |
| generated-bindings | 69 / 2,812 | 69 / 2,812 | 0 |
| content | 23 / 1,088 | 23 / 1,073 | −1% |
| **total tracked** | **1,377 / 628,279** | **850 / 311,567** | **−50.4%** |

The "other" growth is this program's own audit trail (the ledger, the frozen baseline
snapshot, and rosters — ~11.6k lines under `docs/debloat/`), kept deliberately.

- **Eval scripts: 99 → 15** (the six behavioral parity/determinism evals plus the T2
  machine-contract tier: `bindings-drift`, `client-surface-privacy`, `append-only-ids`,
  `battle-schema-snapshot`, `spacetime-type-snapshot`, `content-version`, `account-e2e`,
  `determinism-fail-loud`, `monster-spritesheet-format`, `feature-isolation`).
- **Docs: a 514-file markdown sprawl → a 12-file tree** (README, ARCHITECTURE, CHANGELOG,
  CONTRIBUTING, CODE_OF_CONDUCT, AGENTS, docs/DECISIONS.md with 22 distilled decisions,
  docs/PLAYTEST.md, three runbooks, docs/research/SEED-DOMAINS.md pending the user's own
  relocation). All 240 ADRs, the 647KB ARCHITECTURE log, slice plans, memory cards, and the
  generated knowledge bundle are gone; every surviving claim was re-derived from code.
- **justfile: 736 → 283 lines / 31 recipes**; `evals/run.mjs` rebuilt to its four real teeth;
  `nightly.yml` rebuilt (mutate-core zero-tolerance kept; coverage report-only; semgrep, SBOM,
  changelog-freshness, i18n-TMS and a11y-e2e recipes dropped per the six ratified policy calls).
- **Zero process vocabulary** (rb-NN, ADR-NNNN, milestone tags, gate/needle/pin narration) in
  production source and docs outside this audit directory; the 2,108 `concat!` needle-breakers
  and all EOF-placement/line-pin armor are gone.

## Suites and CI

| suite | before | after |
|---|---:|---:|
| cargo nextest | 2,500 tests | 1,954 tests |
| vitest | 3,447 tests | 3,130 tests |
| Playwright e2e | 77 listed (76 run + 1 permanent skip), 21 files | 90 listed (89 run + same skip), 24 files |
| eval scripts | 99 | 15 |
| warm `just ci` | 144 s over 9 steps | 87 s over 10 steps (79 s on the comparable 9; a new `client-verify-build` step was added) |

Test counts fell while coverage rose in meaning: what was deleted asserted source text
(30k-line `privacy_tests.rs`, `readFileSync` scan suites, censuses of comments); what was
added executes production code — ~40 native-host reducer tests (in-memory SpacetimeDB host,
wrong-identity/wrong-state calls asserting refusal and post-state), `main.boot.test.ts`,
`indexShell.smoke.test.ts`, a built-bundle `dist-surface` check, a bindings-derived privacy
eval with an exact client-visible-surface allowlist, and three new e2e smokes (evolution,
encounter→battle, accounts) that closed real oracle gaps.

A fresh-worktree rehearsal (clean checkout of master, `npm ci` + `just setup` + all 10 CI
steps) passed end-to-end, proving no reliance on local state.

## Mutation testing

- **game-core: missed = 0 at every gate** (Phase-2 exit, Phase-3 exit, and the Phase-5 final
  run; 1,167 mutants tested). This is the tooth that lets the behavioral layer be trusted.
- **server-module: 125 raw survivors at Phase-3 entry → 31 accepted survivors**, each
  individually adjudicated and recorded in `MUT-server-*` ledger rows by category
  (defended-equivalent, unreachable-with-shipped-config, logging/metrics-only). New survivors
  at privacy/economy/guard decision points got behavioral kills, never resurrected text pins.
  The nightly cap fell 324 → 34. The raw survivor count is honest: the old text tests
  "killed" mutants vacuously by matching source bytes, so the old baseline understated real
  gaps rather than outperforming this one.
- Scoped before/after `cargo mutants --file` probes gated every REPLACE-FIRST module
  (trade, battle, evolution, raising/recruit, shop/economy, pvp/ranking, accounts/guest-claim):
  the after missed-set had to be a subset of before's.

## Bugs

### Fixed test-first (gameplay- or production-visible first)

1. **Inventory was world-readable** (`BUG-inventory-world-readable`, bf1cdf2): every player
   received every player's item counts. The `inventory` table is now private with an
   owner-scoped `my_inventory` view — the program's one approved frozen-surface exception
   (automigration-legal ChangeAccess + AddView, proven by a publish-over-live-data probe;
   bindings regenerated; wasm export surface grew by 3 exports, a strict superset of the
   Phase-0 baseline). **Release note: already-open tabs on the previous client bundle break
   on this publish (whole-batch subscription error, blank world) — a hard refresh is required.**
2. **The browser guest-claim flow was doubly unreachable** (3942d49, d6fd5cc): signing in
   never called `start_guest_claim` (the account-e2e driver masked this by calling the reducer
   directly), and the claim overlay's action buttons were hidden/unlabelled. Both fixed;
   the claim path now works end-to-end in a real browser.
3. **Box→Party with a full party was a silent no-op** (`BUG-party-full-to-party-silent-noop`):
   the client fell back to "move to box" for an already-boxed monster. The player now gets
   the real reason instead of nothing.
4. **The help list and main menu advertised "Evolve & Fuse"** — fusion doesn't exist
   (9c4d75e).
5. **`heal_party` carried a tautological `require_owner(ctx, …, me)` self-check** — dead
   security theater deleted; the real authorization (player-row lookup) is tested.
6. **`A11Y_TOKEN_MAX_LEN` permitted 4-char tokens the badge pill cannot render** — ceiling
   corrected to 3 with the contradiction's tests unified.
7. **12 hand-copied monster/monster_pub dual-write blocks** collapsed into one
   `update_monster_synced` helper (94ee09f) — the silent-divergence risk is now structural,
   not text-guarded.
8. **Practice-XP doc drift**: per the user's ruling (PvP grants full XP; reduced XP is for
   practicing against one's own monsters), the code was already correct — the xp.rs doc and
   eval header carried the wrong predicate and were fixed.
9. **Doc falsehoods**: PLAYTEST.md's "no accounts yet", the stale "battle table is public"
   digest line, stale "KNOWN DEFECT" reduced-motion titles (the defect no longer exists —
   the tests assert never-fractional under reduce and their mirror proves non-vacuity),
   a dead `AssertNoA11yParamKey` type alias whose "caught at tsc time" claim was false.

### Adjudicated closed (no code change; ledger rows carry the full rationale)

- **Auto-evolution** already matches the user's ruling: exactly one eligible path
  auto-evolves; two or more hold for a player choice.
- **Fresh-Predictor outstanding-step undercount**: benign by design, bounded to one extra
  continuation per rebuild.
- **Species-7 zone-1 spawn band** (L16 spawns above an L15 evolution edge): benign — that
  edge is also essence-gated, so a wild spawn cannot have cleared it.
- **Evolution eligibility TS port**: kept, but the text-parity guard was replaced by an
  executable one — a wasm `evolution_eligibility` export with a fast-check parity test, so
  drift is now caught by execution.

### Open items and design questions (surfaced, not decided here)

- **The heal currency sink is inert**: shipped heal locations charge nothing, so currency
  only accumulates. Spend wiring is proven (buy/trade); making healing cost >0 is a content
  decision.
- **PvP side B gets no reward** on settlement — deferred design decision (rating settles
  correctly for both sides; only the reward asymmetry is open).
- **Nothing rejects an empty species registry** (`GAP-empty-species-registry`):
  `validate_content` checks duplicates/zero-stats/dangling refs but not emptiness; a bad
  content drop that seeds zero species would be accepted.
- **Render z-order tie-break is unimplemented** (`FINDING-render-z-tiebreak`): sprites at
  equal y fall back to per-client insertion order, so overlap resolution can differ between
  clients. Cosmetic.
- **Care-style branching**: care style determines which evolution path clears first and
  auto-fires; a confirm-before-evolve UI would be a design change beyond the ruling.
- **FR-locale gap**: the in-game help controls list and main-menu entries are model literals,
  not i18n catalog entries — they render in English under `fr`.
- **`just publish` passes no `-s`** and therefore publishes to the CLI's default server; a
  stale default (`proc-test-local`) failed here once. PLAYTEST.md documents the two-setups
  distinction (dev `monster-realm` @5290 vs playtest `monster-realm-playtest` @4173) and
  that `sync_content` is owner-only.
- **SEED-DOMAINS.md** stays in-repo pending the user's own relocation (their ruling).
- **WSL environment**: the host wall clock steps every ~27 s under this WSL install, freezing
  SpacetimeDB's `movement_tick` (log line "is delayed by"); movement e2e flakes trace to it
  and only a host-side `wsl --shutdown` clears it. Not a code defect; every movement failure
  during the program was vindicated as this after log inspection.

## Honesty section

- **Revert count: 0.** No commit made by the program was reverted.
- **`--no-verify` was used on every program commit**, per the approved plan (lefthook remains
  configured for humans; CI ran the real gates on every PR, all green — one transient e2e
  rerun on PR #524, elder-oak quest, passed in isolation with 84 others green first try).
- **The raw-LOC target was missed on purpose.** The plan estimated ~130–150k total; the
  result is 311k. The delta is almost entirely suites the two-key classification verified as
  genuinely behavioral and the user-ratified ledger marked KEEP: 110k of client tests
  (e2e + view/model/net unit suites that execute code) and 50k of server behavioral tests.
  Checking:production landed at ≈1.8:1 against the plan's ~1.2:1 estimate for the same
  reason. Deleting verified-behavioral coverage to hit a line-count estimate would have
  inverted the program's purpose; the ledger wins over the estimate.
- **The `production` category barely moved** (−4%): it was measured to include inline
  `#[cfg(test)]` modules and was never the bloat locus; its change is comment
  strips + dead-code removal net of new exports/views.
- **One permanent e2e skip** predates the program (`recruit.spec.ts` R4, blocked on an
  unexposed test hook) and is carried, not hidden.
- **31 accepted server mutation survivors remain**, each recorded and re-checkable
  (`MUT-server-*` rows); "accepted" means adjudicated harmless, not untested.

## What to know as a maintainer

- The checking contract now lives in: `just ci` (10 steps), the 15 evals, the native-host
  test harness (`server-module/src/native_host_tests.rs`), the Playwright suite (90 tests,
  both projects run per PR), and nightly mutation runs (game-core zero-tolerance, server cap
  34). The client-visible surface (tables/reducers) is pinned by
  `evals/client-surface-privacy.eval.mjs` + `evals/baselines/` — changing schema means
  conductor-grade sign-off: regenerate bindings via `just gen`, refresh the baselines, and
  prove the migration with a publish-over-data probe.
- `docs/debloat/` is the program's audit trail: this report, the ledger, its checker, and
  the frozen Phase-0 baseline. Every deletion in the program traces to a verified ledger row;
  every ledger row carries its executing commit.
