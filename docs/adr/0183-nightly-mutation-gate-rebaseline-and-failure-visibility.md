# 0183 — Nightly mutation gate: cap re-baseline 299 → 324 as declared debt, and per-job failure-policy visibility

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 14r-a (M-postgate fourteenth-review residuals — `specs/monster-realm-v2/M-postgate-fourteenth-review-residuals.spec.md` §14r-a)
**Supersedes:** —
**Amends:** ADR-0050 (A2 mutate-server survivor cap: 299 → 324, recorded as a dated re-baseline bullet), ADR-0118 (§4 re-baseline procedure — its per-file-diff shortcut over unchanged files was unavailable this episode; refinement recorded in D3), ADR-0137 (D4 cap/ceiling coupling — exercised for the first time, and hardened from `cap ≤ ceiling` to exact equality by D6)
**Subsystems:** ci-gates
**Decision:** Re-baseline the `mutate-server` cap 299 → 324 (exact hosted count, moved with `MUTATE_SERVER_CAP_BASELINE`) as debt-carrying — 12 killable survivors named, successor ratchets to ≤ 312; failure visibility is a per-job policy comment.

## Context

Nightly `mutation-server` was RED five consecutive nights (2026-08-09 → 2026-08-13;
latest run 31681643275), failing with

```
survivor count 324 exceeds cap 299 — mutation ratchet violated (ADR-0050)
```

The sibling nightly jobs `mutation`, `coverage` and `smoke-republish` were green
throughout, and master CI stayed green. The cap 299 was set at m17.5a (commit
`9ef0b03`, 2026-07-17). This is ADR-0118's class (c) — **stale ratchet baseline**,
not weak tests — and the third episode of it.

Two further facts framed the slice:

- Nightly has **no notification wiring** (no webhook, Slack, or issue-creating step
  anywhere in `.github/workflows/nightly.yml`).
- A documented failure policy existed for **`smoke-republish` only**; `mutation`,
  `mutation-server` and `coverage` carried none.

## Decision

### D1 — Measurement, per ADR-0118 §4 (cargo-mutants 27.1.0, `--test-tool nextest`, local 32-core)

| Tree | Mutants | Missed | Caught | Unviable | Wall clock | Timeouts |
|---|---|---|---|---|---|---|
| slice head `4d789bd` (local) | 753 | **323** | 379 | 51 | 26 min | 0 |
| baseline `9ef0b03` (local, re-run) | 513 | **299** | 181 | 33 | 13 min | 0 |
| hosted nightly `31681643275` @ master `8814416` (`ubuntu-latest`) | 753 | **324** | 377 | 52 | — | 0 |

**Gate 0 — the environment is comparable, so the ratchet is not fabricated.** Re-running
the previous baseline commit `9ef0b03` locally reproduces the committed baseline
**exactly** (299 missed of 513). The delta is therefore real crate growth, not a
tooling or host artefact.

**The two trees catalogue the same mutants.** The only `server-module/` difference
between the hosted tree (`8814416`) and the slice head (`4d789bd`) is a **6-line doc
comment** in `accounts.rs` (M21b-2's ADR-0182 D18 sequencing note). Both catalogue
753 mutants; the trees are semantically identical for this measurement.

**Hosted vs local, line-number-normalised survivor-set diff: exactly one hosted-only
survivor** — `server-module/src/lib.rs: replace == with != in sync_content`, the
`owner_identity == Identity::from_byte_array([0u8; 32])` check inside the
`sync_content` reducer body (a ctx-taking reducer, i.e. legitimate-shell either way).
Caught locally, missed on the hosted runner. Unviable likewise differs by one
(51 local / 52 hosted). The hosted number was stable across three consecutive
nightly runs (2026-08-11 / 08-12 / 08-13).

### D2 — The cap is 324, not 323

The convention is **cap == the exact measured survivor count, with no headroom**
(ADR-0118 §3 rejected headroom in the cap; ADR-0137 D4 removed it from the ceiling
too). The gate **executes on the hosted runner**, so the measurement that matters is
the hosted one: **324**, stable over three consecutive nights on a semantically
identical tree.

- Setting **323** (the local number) leaves the nightly RED and defeats the slice.
- Setting anything **above 324** is headroom by another name — precisely what the two
  prior ADRs removed.

The ±1 environment sensitivity is confined to a single reducer-body mutant (D1) and is
**documented here rather than absorbed silently**. Because the acceptance surface is
the hosted runner, the first post-merge nightly is the real acceptance evidence for
this cap move.

### D3 — Triage: growth is new-file growth; pre-existing files net NEGATIVE

Per-file survivor counts, base `9ef0b03` → head `4d789bd`:

| File | base | head | Δ |
|---|---|---|---|
| `server-module/src/accounts.rs` | 0 | 27 | +27 |
| `server-module/src/battle.rs` | 47 | 38 | −9 |
| `server-module/src/content.rs` | 17 | 14 | −3 |
| `server-module/src/economy.rs` | 15 | 17 | +2 |
| `server-module/src/evolution.rs` | 14 | 7 | −7 |
| `server-module/src/guards.rs` | 12 | 11 | −1 |
| `server-module/src/inventory.rs` | 10 | 13 | +3 |
| `server-module/src/lib.rs` | 4 | 3 | −1 |
| `server-module/src/marshal.rs` | 6 | 14 | +8 |
| `server-module/src/monster_mgmt.rs` | 5 | 7 | +2 |
| `server-module/src/movement.rs` | 15 | 9 | −6 |
| `server-module/src/npc.rs` | 9 | 12 | +3 |
| `server-module/src/observability.rs` | 0 | 2 | +2 |
| `server-module/src/playtest.rs` | 0 | 11 | +11 |
| `server-module/src/pvp.rs` | 74 | 64 | −10 |
| `server-module/src/raising.rs` | 13 | 17 | +4 |
| `server-module/src/ranking.rs` | 3 | 2 | −1 |
| `server-module/src/schema.rs` | 1 | 2 | +1 |
| `server-module/src/taming.rs` | 9 | 9 | ±0 |
| `server-module/src/trading.rs` | 45 | 44 | −1 |

Growth is concentrated in files that **did not exist** at `9ef0b03` — `accounts.rs`
+27, `playtest.rs` +11, `observability.rs` +2 — while **pre-existing files net −16**
(battle −9, pvp −10, evolution −7, movement −6, content −3, and others). Per ADR-0118
§4 that is a re-baseline, not a test regression.

**41 net-new survivor instances live in pre-existing files.** Of those:

- **32 are legitimate-shell** — the enclosing fn is `#[reducer]`-annotated or takes
  `&ReducerContext`; `schema.rs my_account` takes `&ViewContext` via `#[view]`:
  `battle.rs` `resolve_wild_battle_on_disconnect`, `write_back_battle_results`,
  `lead_party_ids`; `economy.rs` `wallet_exists`; `evolution.rs` `check_and_evolve`;
  `inventory.rs` `rekey_inventory`, `has_items`; `lib.rs` `on_connect`
  (`#[reducer(client_connected)]`); `monster_mgmt.rs` `has_monsters`; `npc.rs`
  `rekey_npc_state`, `has_quest_or_dialogue_state`; `raising.rs`
  `accrue_quality_time`, `consume_crystalized_essence` (`#[reducer]`),
  `rekey_heal_cooldown`, `has_heal_cooldown`; `ranking.rs` `profile_exists`;
  `schema.rs` `my_account`.
- **9 are weak-test** — pure and in-crate killable (enumerated in D4).

**Procedure refinement, amending ADR-0118 §4.** EVERY non-test
`server-module/src/*.rs` file changed since `9ef0b03`, so §4's per-file-diff shortcut
over *unchanged* files was unavailable: a **full re-run at the baseline commit** was
required to get a comparable per-file table (13 min here). The next episode should
budget for the full re-run whenever the baseline is more than one milestone old.

### D4 — Re-baseline WITH NAMED DEBT, not silent absorption

Cap 299 → **324** in the `justfile` `mutate-server cap=` default **and**
`MUTATE_SERVER_CAP_BASELINE` in `evals/nightly-smoke-wiring.eval.mjs`, in the SAME
commit (ADR-0137 D4's coupling; first time it is exercised).

The re-baseline does **not** claim the survivors are all irreducible. Twelve are
killable in-crate today, enumerated so the debt is a lookup rather than a
re-derivation:

| # | Site | Signature | Assertion that kills it |
|---|---|---|---|
| 1–7 | `marshal.rs:208` (7 instances, lines 214–217) | `pub_from_monster(m: &Monster, tier: u8) -> MonsterPub` | assert `nutrition_pct` with ALL SIX `ev_*` columns set to distinct nonzero values |
| 8 | `marshal.rs:253` (line 284) | `monster_to_instance(m: &Monster) -> Result<MonsterInstance, String>` | assert `.party_slot` is `None` for `PARTY_SLOT_NONE` and `Some(n)` for a partied row |
| 9 | `raising.rs:503` (line 505) | `apply_quality_time_credit(m: &mut Monster, now: i64) -> bool` | `now == quality_time_window_start_ms` boundary must NOT take the backwards-clock branch |
| 10 | `accounts.rs:286` | `reject(reducer, &str, sender, reason) -> Result<(), String>` (no ctx) | direct call-and-assert on the returned message |
| 11 | `playtest.rs:62` (`>` → `>=` at :82) | `plan_reap(rows, now_ms, ttl_ms, cap, batch) -> Vec<u64>` (no ctx) | exact-boundary row at `now_ms - ttl_ms` |
| 12 | `observability.rs:72` | `mr_log(evt, &str extra_fields_json)` (no ctx) | log-capture test on the emitted line |

They could **not** be killed in this slice: `server-module/**` is outside 14r-a's
declared `touches:` set. So the cap is declared **debt-carrying**, with an explicit
ratchet-down target of **≤ 312** for the follow-up kill slice, which this ADR names as
a **required successor** (spec §14r-b's `after: 14r-a` ordering exists for exactly
this reason: re-baseline first, then ratchet DOWN).

Two survivor groups are explicitly NOT part of that debt:

- `playtest.rs:47` `PlaytestKind::code -> u16` is a **genuinely equivalent** mutant
  today — the enum has a single variant, so the body-replacement mutant is
  indistinguishable. It becomes killable when pt-b2b adds codes `2..=5`.
- `playtest.rs:10` `const PLAYTEST_EVENT_TTL_MS` contributes **8** const-site
  survivors with no enclosing function to test.

### D5 — Failure visibility: the documented reversible default

Decision-hook `mdrewt/claude-harness#14` (rev14-nightly-red-policy) is **OPEN and
UNANSWERED**. Per doctrine the slice implemented the documented reversible default and
did not block: a per-job **failure-policy comment** on `mutation`, `mutation-server`
and `coverage`, mirroring the `smoke-republish` precedent —

> triaged and inserted as the next slice in the milestone queue, same tier as
> fix-red-master, below it in ordering.

**No issue-creating Action, webhook, or notification step was added**, because that
would pre-empt an open decision irreversibly.
`decision-defaulted: nightly-red-wiring-shape=mirror-smoke-republish-pattern`.

**Stated plainly, because it would be easy to overclaim:** the active surfacing channel
remains GitHub Actions' existing **red-X job status** — these three jobs already carry
no `continue-on-error`, and that is unchanged. What this slice adds is the
**attributed, mechanically-enforced policy** that says what happens once that red
appears. No alerting channel was built. #14's answer may later replace the comment
with an active channel; the comment is deliberately cheap to replace.

### D6 — The two new predicates, and why their shapes are what they are

**`jobHasFailurePolicyComment(yaml, jobName)`** (`evals/nightly-smoke-wiring.eval.mjs`)
scans the contiguous **2-space comment preamble immediately ABOVE the job key**,
anchored to appear after the top-level `jobs:` line, and requires the anchored phrase
`` failure policy for `<job>`: `` on a **single** normalised comment line, plus a
routing keyword (`next slice` / `queue` / `priority`) anywhere in the preamble.

- **Why the preamble, not the block.** `extractJobBlock` starts at the job key and
  stops at the next indent-0/indent-2 line, so the preamble is structurally outside the
  block — and an in-block 2-space comment would *truncate* the block for every other
  predicate that reads it.
- **Why the phrase and the backticked job name must share one line.** It forecloses
  cross-attribution: a policy written for a neighbouring job, credited to this one
  merely because this job's name appears somewhere in the preamble.
- **Why backticks.** They stop the `mutation` ⊂ `mutation-server` substring bleed
  **without a regex** — `detect-non-literal-regexp` has bitten this repo three times.
- **KNOWN LIMITATION, accepted and stated:** a keyword gate cannot detect negated
  prose. It proves the policy is **documented and attributed**, not that it is
  semantically affirmative. Semantic review stays with the reviewer and this ADR.

**`justfileCapEqualsCeiling(justfileText)`** asserts **exact equality** between the
justfile `mutate-server cap=` default and the eval's `MUTATE_SERVER_CAP_BASELINE`.
This closes a real hole in the pre-existing check, which was `cap ≤ ceiling`: raising
the **ceiling alone** produced no eval-visible change, after which a later slice could
raise the cap into the fresh headroom **with no eval diff at all**. Pinning equality
makes the two numbers one number — they move together or the check reds, and the red
names both sides so it is obvious which one drifted.

**Bite-proofs executed against the real tree** (not synthetic-only): deleting each of
the three policy comments reds the eval **naming that specific job**; a 6-space in-block
comment reds it; a 2-space in-block comment reds it via block truncation; swapping the
backticked job name reds it; cap-above-ceiling and cap-below-ceiling both red.

## Consequences

- **Positive:** nightly `mutation-server` returns to green with its exact-count ratchet
  intact and its debt named rather than absorbed; the cap and the eval ceiling can no
  longer drift apart in either direction; the three nightly gates that previously had
  no documented failure policy now carry one, mechanically enforced and attributed to
  the correct job.
- **Negative / accepted:** cap-as-absolute-count still reds the nightly whenever server
  code grows — by design, at the cost of recurring red episodes when a milestone
  forgets the ceremony (third occurrence). The failure-policy comment documents a
  policy; it does not notify anyone.
- **Residuals — named, deliberately NOT actioned here:**
  1. **The kill slice** for the 12 survivors of D4, ratcheting the cap to **≤ 312**.
     This ADR names it a required successor.
  2. **`mutateServerRecipeIntact`'s scope-narrowing ban list is incomplete.** It bans
     only `--shard`, `--file`, `--exclude-re`, ` -o `, `--output`. The cargo-mutants
     short forms (`-e`, `-E`, `-f`, `-F`) and `--in-diff`, `--iterate`, `--exclude`,
     `--skip-calls`, `--test-package`, `--baseline` are **not** banned, and any of them
     could empty `missed.txt` and make the gate **vacuously green**. Pre-existing;
     verified by execution against the committed predicate; parked as its own slice
     rather than widened here (widening it inside a re-baseline slice would mix a
     silent-false-green fix into a cap move).
  3. **cargo-mutants is installed unpinned** in nightly (`tool: cargo-mutants`), so an
     engine release changes the mutant catalogue and re-reds the exact-count cap. This
     fails LOUD, not false-green, so it is left as-is and recorded.
  4. **The ±1 hosted/local environment sensitivity** (D1/D2) means the FIRST post-merge
     nightly is the real acceptance evidence for the cap move.

## Confirmation

- `evals/nightly-smoke-wiring.eval.mjs` — `justfileCapEqualsCeiling` pins the `justfile`
  `mutate-server cap=` default to `MUTATE_SERVER_CAP_BASELINE` by exact equality (both
  now 324), and `jobHasFailurePolicyComment` requires the attributed failure-policy
  preamble on `mutation`, `mutation-server` and `coverage` in
  `.github/workflows/nightly.yml`. Both ship the ADR-0010 proof-of-teeth fixtures listed
  in D6, executed against the real tree. Runs under `just eval` / `just ci`.
- **Acceptance checkpoint:** WHEN the nightly `mutation-server` job fails, the failure is
  surfaced through the job's red status and triaged per the now-documented per-job
  policy within one nightly cycle.

## References

- ADR-0050 A2/A3 (the mutation ratchet and the wiring-eval ceiling this amends),
  ADR-0118 §3/§4 (no-headroom convention; the re-baseline procedure followed here),
  ADR-0137 D4 (cap/ceiling lockstep coupling), ADR-0079 (the `smoke-republish` failure
  policy this mirrors), ADR-0010 (proof-of-teeth), ADR-0182 D18 (the `accounts.rs` doc
  comment that is the only server-module delta between `8814416` and `4d789bd`).
- Nightly run 31681643275 (2026-08-13, latest red of the episode); baseline commit
  `9ef0b03` (m17.5a, 2026-07-17); slice head `4d789bd`.
- Decision-hook `mdrewt/claude-harness#14` (rev14-nightly-red-policy) — open; D5 is its
  reversible default.
