# m17c Build Plan — M17 ranked-ladder evals tail (RL-16/17/18)

> Slice-internal planning artifact (committed as a wip checkpoint for resume-safety;
> removed before the PR opens — the ADR + spec are the durable records).

## Executive summary

m17c is a **pure evals + e2e slice**: two new `evals/ranking-*.eval.mjs` static-scan gates and one new `client/e2e/ranked-forfeit.spec.ts` two-context server-truth e2e. Zero production code, zero client `src/**` touches. The slice re-pins the m17a security contract at the eval layer (independent of the Rust `pvp_tests.rs` needle tests) and proves the zero-sum rating flow end-to-end against a live world. All m17a source facts verified as GREEN-able: `ranking.rs` declares no reducers, `apply_pvp_rating` has exactly one production caller (`pvp.rs:457`, path-qualified `ranking::apply_pvp_rating(`), `on_disconnect` (lib.rs:181) never touches `profile`.

**Workflow: solo slice** (no fan-out inside the slice): mechanical, well-precedented eval/e2e work (5+ prior `*-reducer-security.eval.mjs` and the M16.5d two-context e2e are direct templates) with a single empirical risk (identity-hex normalization in sql assertions).

## 1. File decision: TWO eval files + ONE e2e spec

- `evals/ranking-security.eval.mjs` — RL-16 (module-write-only, once-only call-site count, never-deleted scan). Reads `ranking.rs`, `pvp.rs`, `lib.rs`, `schema.rs`.
- `evals/ranking-pve-exclusion.eval.mjs` — RL-17 (four battle.rs PvP-reject guards + ordering + the no-op-body hardening). Reads `battle.rs`; imports checkers from `battle-reducer-security.eval.mjs`.
- `client/e2e/ranked-forfeit.spec.ts` — RL-18.

Justification: M16c precedent splits pvp evals by threat surface (`pvp-handshake-guards` / `pvp-action-privacy` / `pvp-deadline-disconnect`). RL-16 (ranking-module integrity) and RL-17 (battle-reducer PvE-path closure) are different threat surfaces reading different files; failure isolation matters (a battle.rs refactor should fail pve-exclusion, not muddy module-write-only). `ranking-pve-exclusion` is the natural home for the checker imports, keeping `ranking-security` self-contained.

No eval-count gate breaks: `run.mjs` guards only `files.length === 0`; ci-gate-wiring pins the presence of that guard string, not a count. Auto-discovery — no registration.

## 2. `evals/ranking-security.eval.mjs` (RL-16)

House style: named checker fns, each with bad+good(+evasion) proof-of-teeth fixtures run FIRST, short-circuit `TEETH FAILED`, then real-source scan. Recursive `readServerModuleSources` helper (copy from battle-reducer-security tail). No `new RegExp`. Always `stripRustComments` then `stripRustStrings` before needle counts (ranking.rs doc-comments name every scanned symbol).

### Criterion A — MODULE_WRITE_ONLY (RL-7)
- A1: `ranking.rs` (stripped) must NOT contain `#[spacetimedb::reducer`.
- A2: `ctx.db.profile()` table access must appear ONLY in ranking.rs across non-test sources (verified currently true: lines 28/38/79/84).

Fixtures: bad-reducer (reducer attr in ranking-shaped fixture → flag); bad-external-write (`ctx.db.profile().identity().update(` in non-ranking fixture → flag); good (real shape → pass); evasion (`let _dead = "#[spacetimedb::reducer]";` in string → NOT flagged after strip).

### Criterion B — ONCE_ONLY_CALLSITE (RL-10, RT-SEC-02 style)
Count path-qualified `ranking::apply_pvp_rating(` across non-test domain sources (exclude `ranking.rs` definition + all `*_tests.rs`), expect exactly 1 (pvp.rs settle funnel). Count on stripped text.

Fixtures: bad-two-callsites (count 2 → flag); bad-zero (count 0 → flag, funnel severed); good (exactly 1 → pass); evasion (2nd occurrence in comment/string → count 1 after strip).

### Criterion C — NEVER_DELETED (RL-2)
- C1: non-test sources must NOT contain `profile()` delete forms — chained `.profile().identity().delete` AND split-binding (`= ctx.db.profile()` then `.delete(`); simplest faithful: `profile().identity().delete` absent AND `profile().delete` absent in stripped sources.
- C2: `on_disconnect` body (extract via `extractReducerBody` from lib.rs) contains NO `profile(` token.

Fixtures: bad-delete (chained delete → flag); bad-split-binding (`let p = ctx.db.profile(); p.identity().delete(id);` → flag); bad-disconnect (on_disconnect touching profile → flag); good (real sources → pass).

Anti-duplication: pvp_tests.rs pins these in Rust; the eval is an independent toolchain-boundary gate (runs in `just eval` even if Rust test module is disabled). Checker-fn + fixture idiom, not copied assertions.

## 3. `evals/ranking-pve-exclusion.eval.mjs` (RL-17)

Import `{ stripRustComments, extractReducerBody, stripRustStrings, hasPvpRejectGuard, pvpGuardAfterOngoingCheck }` from `./battle-reducer-security.eval.mjs` (frozen file, deliberately exports them). Guard the import → RED (not throw) if an export is missing.

- **R17-A — re-verify:** for `submit_attack`/`swap_active`/`flee`/`use_battle_item`, extract body from real battle.rs; assert `hasPvpRejectGuard` AND `pvpGuardAfterOngoingCheck`.
- **R17-B — harden (no-op-body kill):** new stronger checker in THIS file: `hasPvpRejectWithNonEmptyBody(body)` — find the `if is_ranked_pvp(&battle)` needle, brace-match its block, require a rejection token (`return Err`). Empty/whitespace/log-only block → false.

Fixtures: bad-noop (`{}` → false); bad-noop-whitespace (`{ }` / `{ /* nothing */ }` → false); bad-log-only (`{ log::warn!("pvp"); }` → false); good (reject body → true); good-real (4 real bodies → true).

R17-B closes the exact residual the frozen eval documents but cannot fix.

## 4. `client/e2e/ranked-forfeit.spec.ts` (RL-18)

Two-context design mirrors trade-full.spec.ts (two `chromium.launch()` instances → distinct identities; SDK caches identity in page module scope). `test.describe.serial`, copy `gameReady` helper.

**Server-truth sql, not `__game()`:** `__game()` has NO profile field (m17b's job; client/src off-limits; no `__mrPvp` hook and may not add one). Rating assertions read `spacetime sql` via `execSync`, reusing global-setup.ts env pattern (STDB_SERVER default `local`, VITE_STDB_DB default `monster-realm`, same literal-regex env-shape validation).

Timeline:
1. beforeAll: launch A + B, goto('/'), gameReady both (fresh spawns; no proximity guard on challenge_pvp).
2. Capture identityA/identityB from `__game()`.
3. A presses KeyP; waits for `pvp-challenge-player-btn` with `data-player-identity !== identityA` (15s).
4. A clicks the challenge button → `challenge_pvp`.
5. B waits for `pvp-accept-btn` (overlay auto-shows on incoming), clicks → `accept_challenge` → ranked battle.
6. Assert battle live on both pages (`__game().ongoingBattle` non-null / pvp-status present).
7. **Forfeit via disconnect:** `browserB.close()` (no client-callable forfeit reducer; `pvp::forfeit_on_disconnect` fires; 60s deadline not a race).
8. A waits for terminal outcome (ongoing battle clears / outcome-text) — 20s.
9. **Zero-sum sql assertion:** `spacetime sql` SELECT identity, rating, wins, losses FROM profile → exactly the two identity-scoped rows: winner A rating 1000+Δ wins=1 losses=0; loser B rating 1000−Δ wins=0 losses=1; sum === 2000; Δ ∈ [1,31] (bound, not a magic K/2 constant).
10. afterAll: close A. Never assert global row counts (profile rows persist into later alphabetical specs).

**Identity normalization (empirical risk):** `__game().identity` hex vs sql output format may differ (0x prefix / casing). Normalize both (lowercase, strip 0x) AND identify winner by `wins===1` row, cross-checking normalized identity — resolve format empirically with one local sql call during build.

## 5. EARS → test traceability

| EARS | Criterion | Needles re-pinned |
|------|-----------|-------------------|
| RL-16 | ranking-security A/B/C | RL-7, RL-10, RL-2 |
| RL-17 | ranking-pve-exclusion R17-A/R17-B | RL-8, RL-9, ordering (ADR-0119 D5/F1), no-op residual |
| RL-18 | ranked-forfeit.spec.ts | RL-5 (rates once via funnel), RL-2 (persists past disconnect), zero-sum (RL-11 observable form) |

RL-1/3/4/11/12 are m17a rules-layer criteria owned by game-core/ranking_tests — not re-pinned here. If an eval legitimately fails against merged m17a source → hidden dependency, escalate, don't fix source.

## 6. Anti-patterns to avoid

- Always-pass evals: every checker needs a bad fixture flagged + good fixture passed, run before real scan.
- Unbounded/positional source scans (m17a trap): always bound with `extractReducerBody`.
- Comment/string false positives: strip both before every count.
- Counting call sites in `*_tests.rs` (pvp_tests.rs mentions apply_pvp_rating ~40×): exclude test files.
- `new RegExp(...)`: banned everywhere, incl. e2e env validators.
- e2e flake: identity mismatch (normalize + wins===1 fallback); deadline race (scenario ≪ 60s); shared-world contamination (identity-scoped assertions only); m17b concurrency (depend only on M16b-era testids + __game; never leaderboard UI); browser cleanup (afterAll closes A; B closed mid-test; golden.spec asserts exact presence).
- Off-limits: battle-reducer-security.eval.mjs import-only; run.mjs untouched; client/src untouched; existing e2e specs untouched.

## 7. Risks + autonomous defaults

1. sql identity format → normalize + wins===1 match; verify empirically.
2. Δ coupling → assert bounds + zero-sum, not K/2 exact.
3. battleView race → poll `__game().ongoingBattle`, not DOM.
4. Disconnect latency → 20s timeout.
5. A2 false-positive on future code → intentional coupling; m17b set_profile_name lives in ranking.rs per ADR-0119 D6.
6. golden.spec presence → close browsers, identity-scoped asserts.
7. R17-A red against merged source → escalate as hidden dependency (expected GREEN per PR #196).

## 8. Amendments (plan-review fan: reviewer + red-team, 2026-07-17 — both APPROVE-WITH-AMENDMENTS)

**AM-1 (reviewer B-1, BLOCKER):** Criterion B uses the TWO-NEEDLE strategy mirroring `pvp_tests.rs:782` (m17a RL-10 Rust gate, ADR-0119 D3): (1) path-qualified `ranking::apply_pvp_rating(` counted in **pvp.rs only**, expect exactly 1; (2) bare identifier `apply_pvp_rating` counted in **every other non-test domain file individually** (battle.rs, lib.rs, economy.rs, trading.rs, raising.rs, movement.rs, …), expect 0 each — catches `use crate::ranking::apply_pvp_rating;` + bare-call aliasing. Read domain files individually (explicit `_tests.rs` exclusion by filename), not via the concatenated blob. Fixtures updated to match: bad-bare-alias fixture (use-import + bare call in a non-pvp file → flagged).

**AM-2 (red-team F-1, BLOCKER):** e2e step 6 asserts battle-live on **A's page only** (`__game().ongoingBattle` non-null): `store.ongoingBattle`/`latestPlayerBattle` match `player_identity` only; B (acceptor) is `opponent_identity` — B's client has NO battle view and no ongoingBattle. B's observable accept-success signal = pvpView auto-hides (challenge row deleted). Timeline: B clicks accept → wait on A for ongoingBattle non-null → close browser B.

**AM-3 (red-team F-2, BLOCKER):** `hasPvpRejectWithNonEmptyBody` algorithm pinned: (1) strip comments+strings; (2) indexOf the `if is_ranked_pvp(&battle)` needle; (3) walk forward to the first `{`; (4) brace-depth-count to the matching `}`; (5) require `return Err` INSIDE that sub-slice only. Extra fixtures: positional-evasion (guard block empty, `return Err` appears AFTER the block → false); nested-brace good (reject body containing inner `{}` e.g. format!/to_string → true); next-line-brace (`if is_ranked_pvp(&battle)\n{ return Err(...) }` → true) [reviewer W-2]. Documented residual (honest): `if is_ranked_pvp(&battle) { if false { return Err(...) } }` nested-dead-code still passes — static scan limit; covered by mutation testing + Rust tests.

**AM-4 (red-team F-3):** C1 needles made honest: C1a chained-delete needles (`profile().identity().delete` / `profile().delete`) absent in ALL non-test sources; C1b split-binding needle `= ctx.db.profile()` absent OUTSIDE ranking.rs (binding the profile handle outside the module is flagged conservatively — mirrors pvp_tests.rs:1206 needle). Fixture set matches what each needle actually catches: bad-split-binding is caught by C1b, not C1a.

**AM-5 (red-team F-4):** before waiting for `pvp-accept-btn`, press Escape on B's page (clean no-overlay state — auto-show requires `!anyOverlayVisible`).

**AM-6 (reviewer W-3):** step 3 = press KeyP on A FIRST, THEN poll for `pvp-challenge-player-btn[data-player-identity != identityA]` to APPEAR (handles B's player-row subscription lag; empty list renders "No players online to challenge" until the row arrives).

**AM-7 (reviewer W-4 + red-team F-6):** sql assertion parsing: parse the numeric rating/wins/losses columns for the zero-sum + counters (integers, no truncation risk); identity cross-ref via normalization (lowercase, strip 0x) AND winner-by-`wins===1`; if identity columns are truncated by CLI table width, fall back to numeric-only assertions + wins-mapping; **hard-fail (throw) if zero rows match after normalization** (recruit.spec.ts precedent — never warn-and-continue). Resolve format empirically first (world is live: server running, module published).

**AM-8 (reviewer W-1 / red-team F-5):** A2 checker carries an inline comment: intentionally coupled to ADR-0119 D6 — profile access lives ONLY in ranking.rs; m17b's set_profile_name is expected IN ranking.rs; if it moves elsewhere, widen the allowlist in the m17b PR (not silently).

**AM-9 (reviewer B-2):** ordering analysis corrected: golden.spec (g) runs BEFORE ranked-forfeit (r); the direction of risk is to specs AFTER `r` — ranked-forfeit sorts before recruit.spec (ranked < recruit); recruit has no clean-world dependency on profile (wild encounters only). 20s step-8 timeout failure mode: test fails, afterAll still closes A, later specs unaffected. Criterion B note (red-team F-8): test-file exclusion is by explicit filename filter, not by relying on needle occurrences in pvp_tests.rs comments being comment-stripped.

## 9. ADR-0121 sketch

Title: `0121 — m17c ranked evals tail: sql-based server-truth e2e, checker-import reuse, no-op-body hardening`. Records: (1) sql server-truth e2e decouples m17c from m17b (no __mrPvp hook; identity normalization contract); (2) checker-import reuse from frozen battle-reducer-security (guarded import → RED); (3) hasPvpRejectWithNonEmptyBody closes the documented no-op residual (block-body inspection vs empty-guard fakery); (4) two-file split by threat surface (M16c precedent); (5) eval-layer defense-in-depth across the toolchain boundary vs pvp_tests.rs.
