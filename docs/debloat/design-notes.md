# De-bloat program — execution appendix

Companion to the approved plan (`~/.claude/plans/pasted-content-id-1e45-this-project-cozy-rainbow.md`).
Operational detail distilled from the three design passes (2026-09-27). Working file; pruned at
Phase 5 to REPORT.md + ledger.

## Verified anchor facts

- Gate-of-gates anchors (all three severed in Commit A): `lefthook.yml:12`, `.github/workflows/ci.yml:129`
  (plus the comment at :128 saying the eval pattern-matches that exact `- run:` line), and auto-discovery
  by `evals/run.mjs`.
- `evals/run.mjs`: fails on zero eval files; the "rb-5 exit-verdict" handler guards a *measured* incident
  (an eval's module-scope `process.exit` truncated the suite at 37/90 with exit 0). Keep those teeth in the
  ~25-line rewrite.
- 99 evals; behavioral six (613 LOC total): `prediction-parity` (65), `movement-parity` (75),
  `js-path-parity` (111), `netcode-determinism` (52), `netcode-convergence` (261), `feature-isolation` (49).
- `monster_pub` is a real private TABLE (`schema.rs:309`), `my_monster_pub` a view (`schema.rs:375`) —
  dual-write divergence is silent today; only text-guarded.
- `native_host_tests.rs` (690 lines) implements 7/11 host syscalls via `ReducerContext::__dummy()`;
  `database_identity()` is unstubbed (a test reaching it is a LINK failure of the whole lib-test binary).
- client-wasm already exports constants: `step_ms()`, `move_queue_cap()`, `party_size()`,
  `party_slot_none()`, `deletion_grace_ms_default()`, `zone_map(zone_id)` — the §6 dedup pattern.
- Client tests excluded from tsc (`client/tsconfig.json` excludes `**/*.test.ts`); happy-dom 20.x already
  used via `@vitest-environment` pragmas.
- e2e: 22 Playwright specs incl. real axe (`a11y.spec.ts`), two-identity privacy specs, trade/pvp/wallet.
  Gaps: no evolution, no wild-encounter→battle, no accounts spec (accounts covered only by
  `evals/account-e2e.eval.mjs`, 5,499 lines).
- `.cargo/mutants.toml`: 3 line-pinned equivalent-mutant exclusions (keep verbatim; delete the eval that
  mirrors them). mutate-server ratchet cap = 324, mirrored in an eval (both die; re-baseline nightly later).
- Ground truth: `git -C /home/mdrewt/projects/ai-apps/claude-harness show 1be412c:specs/monster-realm-v2/<file>`
  (PLAN.md 298-line version, game-design.md, M0–M25, design ADRs 0001–0034); user's own words in
  `memory/projects/PlaytestReport.md` and `future-prompts.md:106-194` (build-loop prompt; its "record the
  call as an ADR" + "don't pause to ask" lines explain the ADR explosion).

## Eval dispositions (from the checking-layer design; ledger overrides on conflict)

| Category (files/LOC) | Disposition |
|---|---|
| Behavioral 6 (613) + 2 teeth crates | KEEP |
| Security/privacy text scans (37/54k) | REPLACE→DELETE: (a) hidden-fields → new `client-surface-privacy.eval.mjs` (~350 LOC over generated bindings: denylist `iv_*`,`ev_*`,`nature*`,weights; accessor allowlist) + existing two-identity e2e; (b) sender/ownership/state checks → ~40 native-host tests (~3k LOC), dedupe vs interleaved behavioral tests; (c) conservation (trade multiset, wallet delta, dual-write) → native-host post-state asserts; fallback = game-core pure-plan tests (`build_swap_plan`); (d) dev-reducer gating → keep `scripts/verify-release-reducers.mjs`, add to e2e job, delete 3 scan evals |
| Gate-of-gates (15/27k) | DELETE, no replacement (meta-gate axiom). Salvage: run.mjs verdict handler; port `e2e-desync-teeth`'s desync fixture into game-core proptest regressions if it encodes a real historical desync |
| Observability/playtest (7/18k) | Keep `just observability-validate` + `ops/observability/checks/stack-config-checks.mjs` + direct test (shrunk); DELETE wrapper evals + redteam-of-checker suite; playtest contracts move out of `just ci` to `just playtest-*` |
| a11y scans (6/11k) | DELETE (axe e2e + reduced-motion project + 8-file unit tier cover the criteria). Keep the two "KNOWN DEFECT (renderer arm)" reduced-motion tests — they document a real defect (also `kind:bug` ledger row). Simplify `a11y-e2e` recipe: drop the 3 inline `node -e` forensics + pinned titles; keep modest pass-count floors |
| Content/tuning pins (11/11k) | DELETE (one-time content-drop freezes; game-core content tests already execute `load_*`). `CONTENT_VERSION` bump invariant → ~40-LOC Rust hash-pair test (content changed without bump silently serves stale rows to existing DBs) |
| Schema/ID snapshots (12/11k) | T2 core: KEEP `bindings-drift`; MERGE 3 append-only-id evals → 1 (~500 LOC, live-DB save compat); `battle-schema-snapshot` → ~200-LOC migration-freeze-only snapshot (scheduled tables, ideally over the module def / `DATA_LIFECYCLE_MANIFEST`, not schema.rs regex); keep nightly `smoke-republish` (the behavioral migration gate); fold compat halves of `spacetime-type-snapshot`/`bsatn-compat-smoke`/`rekey-contract-surface`/`deletion-grace-wasm-ssot` into those, delete rest |
| Doc gates (5/7k) | DELETE from CI (+ `rb74_citation_tests.rs`, `rb73_session_tests.rs`, `rb82_ron_comment_claims.rs` die whole) |

Server tests: T3 ≈ 54% of 1,110 tests. Two deliberate T3 conversions: (1) syn-based deletion-compliance
census (`privacy_enforcement_tests.rs`) → engine + one test (~800 LOC) — guards "every reducer writing a
lifecycle-classified table passes a deletion guard", which enumerative tests decay on; (2) a sender-auth
census ONLY if the guards.rs mutation probe shows the native-host suite is too sparse (default: no).
The 2,108 `concat!` needle-breakers were armor against the eval scanners; they die with them (Phase 3).

Client replacements written FIRST: `main.boot.test.ts` (~250, happy-dom, stub SDK+wasm, boot/connect/
error-overlay wiring), `indexShell.smoke.test.ts` (~120, parse real index.html), `dist-surface.test.mjs`
(~60, built bundle drops `__mrTrade`/`__mrPvp`/`__game`, keeps `__mrBuild` — run in e2e job).
`hardcodedStrings.ts` (545-line scanner in prod src, test-only importers) → `client/tools/` or dies with
its suite. i18n `catalogRoundTrip`/`catalogShape` behavioral → KEEP.

## Teardown order constraints (Phase 2)

Delete importers before imported: client scan tests import eval helpers (10–15 files) → land before their
evals; 21 evals import sibling evals (`gate-teeth` imports 3 — importers are safe to delete first);
justfile parses evals AND evals parse the justfile — broken only by Commit A. `just test` embeds
fail-closed count parsers ("exactly 9" adr-digest, "floor 62" observability) — removed with the justfile
rewrite; keep exit-code-only `node --test` for surviving ops suites. `perf-budget` sits inside `eval:`
because an eval pinned the `ci:` dependency list — moves to nightly after Commit A.

## Risk registers (discriminating tests)

Likeliest FALSE-POSITIVE deletions (keep/replace instead): append-only-ids (renumber a species → orphaned
rows on publish-over-data); bindings-drift (edit reducer sig w/o `just gen` → only it reds); native-host
harness (delete → behavioral tests stop compiling); deletion census (add unguarded toy reducer → only it
reds); monster-dual-write (drop one mirror write → nothing else reds); run.mjs verdict handler;
mutants.toml exclusions; smoke-republish; reduced-motion KNOWN-DEFECT tests; CONTENT_VERSION invariant.

Likeliest FALSE-NEGATIVE keeps (delete): proof-of-teeth fixture halves; the two count-floor parsers in
`just test`; a11y-e2e report forensics; rb73/rb74 citation suites; `pt-d3-tuning` E2E_BUDGET_AGREEMENT
(asserts a spec's comments); `gate-teeth`; `stack-config-checks.redteam.test.mjs`; rb82 RON-comment tests;
`comment_needle_violations` tests; client structural specs that rebuild the fixture they assert on.

## Comment cleanup rubric (Phase 3)

Pass 1 regex families: `ADR-\d{4}`, `rb-\d+`, `\bm?\d+(\.\d+)?[a-z]?-`(slice), `ptc\d|nh\d|uxd\d|EG\d|OBS-\d+|PRV\d|A11Y-\d+|R-rb-`,
eval/test filenames, `needle|byte-frozen|pinned|proof-of-teeth|plan adjudication|handoff|reviewer|red-team|touches:`.
Parenthetical cite in a standalone sentence → strip parenthetical; cite-only line → drop line; all-process
block → drop block. EXCLUDE generated bindings + i18n `// @desc:` notes. Guard: comment-strip before/after
→ byte-identical remainders.

Pass 2 (files >0.30 comment:code after Pass 1): sentence survives (≤3 lines) iff a maintainer without it
could plausibly reintroduce the warned bug. Invariant-candidate = names same-file symbol + runtime
consequence (`would|otherwise|breaks|panics|leaks|stalls|desync|silently|never|must`); process-candidate =
grammatical subject is the dev process. Worked examples: `client/src/ui/liveRegion.ts:1-45` → ~12 lines
keeping 4 invariants (trailing-edge coalescing "latest wins"; time is a caller-supplied monotonic arg;
dedup vs `pending ?? lastWritten`; DOM node resolved per write). `game-core/src/accounts/deletion.rs:22-40`
→ 2 lines ("7 days is an unsourced placeholder; `_DEFAULT` implies no runtime override column").
`marshal.rs` keeps "intentionally repetitive — DRY does not cross the marshaling boundary".
`accounts.rs` keeps the WRITE-ISOLATION rule (~4 lines), drops the slice chain.

## Dead code & test reorg (Phase 3)

Verified dead TS exports: 8 `eventRing` playtest constructors (`eventRing.ts:84,101`), 5 `convert.ts`
helpers, `shouldToggleBox`, `JitterEstimator`, `screenToWorld`, `sortedByZ`, `SIGN_IN_REASONS`,
`SESSION_EVENT_KINDS`; check import direction on `claimRejectPermitsJoin` (oidc.ts may be a prod consumer).
~204 no-prod-importer exports → un-export case-by-case. Rust: `sync_content_inner_recheck`
(`content.rs:330`) delete after porting its 2 unique assertions to the production validator's tests;
client-wasm `*_for_test` fns → cfg(test) or die with their gate tests. Test merges by feature:
`m14a_tests` → `status/weather/ability_tests.rs` etc.; `cargo test -- --list` count parity == old −
ledgered deletions, exactly. Server reducers are invoked BY NAME — "unused" needs no-binding/e2e/
`spacetime call` evidence too.

## ADR triage (Phase 4)

Stage A: collapse chains to terminal state (0042+0109+0198 → "battle table private; `my_battle` view").
Stage B kill filters: title/slice matches rb/residual/gate/pin/prose vocab; Decision names only a
test/eval/CI job; named symbols fail existence checks. Stage C: survives iff constrains live code AND the
why isn't re-derivable in ≤10 min. Stage D: 10–25 lines each, claims re-derived from code.
Expected survivors (executor re-derives): integer damage (0041+0092); wasm boundary (0036); table-privacy
pattern (0040/0044/0045/0087/0194/0198 → one entry); inventory (0046); recruit (0047); panic-as-content-
invariant (0049); bounded prediction queue (0052); pure legality rules (0053); server layout (0056);
content dirs (0057); evolution graph (0174–0177); accounts/auth (0179+0182); observability net-of-9-
amendments (0180); SDK 2.x lockstep (0197); deletion lifecycle (0207/0210/0221/0228/0229 → design only);
i18n (0256/0262/0264); reject-don't-clamp (cross-cutting). Known contradiction to fix: DIGEST still shows
0042 "public" as live. Numbering collision with harness 0055–0057 dissolves when project numbers cease
to exist; target = zero bare ADR-NNNN cites in project docs.

## Known bugs / defects already spotted (seed `kind:bug` rows)

- Reduced-motion renderer arm: two Playwright tests marked "RENDERER ARM (KNOWN DEFECT)" encode a real,
  disclosed defect (see a11y-manual-protocol / a11y-e2e notes).
- `docs/PLAYTEST.md:15` "no accounts yet" vs shipped accounts (doc bug).
- ADR-0042/DIGEST stale "Battle table public" vs private + `my_battle` view (doc bug).
- Evolution eligibility re-implemented in TS (`ui/evolutionModel.ts` vs `game-core/evolution/eligibility.rs`)
  — drift risk; Phase 3 §6 adds the executable parity test (wasm export + fast-check) instead of text pins.

## Phase-0 runner sketch

Preconditions: Docker up (WSL: dangling `/usr/bin/docker` symlink when Desktop is down; start via
powershell.exe absolute path, ~15 s); NO spacetime running; `client/node_modules` present; no leaked vite
(scan `/proc/*/cwd`, kill by PID only). Runner: background task loops
`lint typecheck test eval security wasm client-typecheck client-test observability-validate`, appending
`<step> OK|FAIL <secs>` to a marker log; verdict read on the completion event (fallback wakeup ~15 min).
Then exclusively: spacetime up (PID file) → Monitor for readiness → `just e2e` with
`PLAYWRIGHT_JSON_OUTPUT_NAME` → `unexpected=0` → kill by PID. Copy `mutants.out/missed.txt` to scratchpad
after every mutation run (next run clobbers it).
