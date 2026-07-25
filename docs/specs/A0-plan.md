# Plan — Slice A0: `fuse()` field-carry hardening + `fusion_eligible` gate (ADR-0147)

**Spec:** harness `specs/monster-realm-v2/M-postgate-evolution-fusion-hardening.spec.md` §A0 (EARS A0-1..A0-9).
**Shape:** ONE atomic PR — `fuse()`'s signature change is compiler-enforced across `game-core` → `server-module`; splitting would leave master non-compiling. Tasks are sequenced *within* the PR.
**Orchestrator corrections applied to the planner draft:** (1) the full gate is `just ci` (there is no `just gate`; mutation gates are nightly — we run *scoped* `cargo mutants` locally for the changed files as the DoD changed-module mutation check); (2) we do NOT edit `docs/adr/0061-*.md` (out of touch-set; the amendment relationship is recorded inside ADR-0147 itself); (3) `evals/evolution-reducer-security.eval.mjs` is a **forced touches-delta** (its E3 check hard-pins the inline `a_id==b_id` that A0-7 mandates deleting) — verified disjoint from the concurrent sibling slice nh1 (client-only).

---

## 0. Decisions

### D1 — `fusion_eligible` signature

```rust
// game-core/src/evolution/eligibility.rs
pub fn fusion_eligible(
    a_id: u64,
    b_id: u64,
    a: &MonsterInstance,
    b: &MonsterInstance,
) -> Result<(), FusionError>
```

`MonsterInstance` has no id (types.rs:538), so self-fusion is undetectable from instances alone. Ids are passed as **opaque identity handles compared only for equality** — the function stays pure; `game-core` gains no DB knowledge. Rejected: a `same_monster: bool` param (pushes the decision back to the caller = the duplication A0-7 deletes) and a generic `<Id: PartialEq>` (YAGNI).

### D2 — `FusionError` shape

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FusionError { SelfFusion, BelowMinLevel, BelowMinBond }
```

Unit variants, no which-parent payload — matches the `CareError`/`FocusTrainError` convention (unit variants, no `Display`; the server maps variants → strings). Payload-free means the parity matrix compares plain values, per-parent check order is unobservable, and fewer mutants against the zero-tolerance `mutate-core` gate. **No `#[non_exhaustive]`** — exhaustive matching is the compile gate (ADR-0061 discipline). No `Display` in game-core; one server-side mapping site (D3).

### D3 — String boundary: one shared server helper

```rust
// server-module/src/evolution.rs (NOT guards.rs — out of touch-set)
pub(crate) fn reject_if_not_fusable(
    a_id: u64, b_id: u64, a: &MonsterInstance, b: &MonsterInstance,
) -> Result<(), String>
```

Delegates to `game_core::fusion_eligible` and maps variants → messages **once**; both the real reducer and `fuse_seam` call it. Named into the `reject_if_*` family. Messages `format!` over `game_core::MIN_FUSION_LEVEL`/`MIN_FUSION_BOND` so numerals cannot drift:

| Variant | Message |
|---|---|
| `SelfFusion` | `"cannot fuse a monster with itself"` (byte-compatible with `test_fuse_self_fuse_rejects`) |
| `BelowMinLevel` | `"both monsters must be at least level 10 to fuse"` |
| `BelowMinBond` | `"both monsters must have at least 120 bond to fuse"` |

This also moves the branching out of the reducer body (unreachable by mutation tests) into a helper the seam tests exercise (mitigates R2). Reducer logs via `log_reject`, seam does not (same asymmetry as the same-owner check today).

### D4 — Check order inside `fusion_eligible` (the parity oracle)

`self → level (both, `||`) → bond (both, `||`)`. Self first (comparing "both parents'" stats is meaningless on the same row); level before bond (coarser gate). Per-parent order unobservable (unit variants) — the matrix pins *category* order only. The `||` form is what one-parent-below fixtures kill.

### D5 — Reducer + seam guard order → marshal early, eligibility right after same-owner

New order in `fuse` reducer: lookups → require_owner ×2 → same-owner → **marshal a,b (moved up)** → **reject_if_not_fusable (NEW)** → battle ×2 → trade ×2 → species rows → recipe → offspring species → canonicalize → `game_core::fuse(..., None)` → evolves_to → row build → atomic swap. Rationale vs eligibility-late: late placement cannot own self-fusion — with the inline check deleted, `fuse(ctx,1,1)` would hit `"no fusion recipe"` first (breaking the existing pin), and if a same-species recipe ever ships, a self-fuse would DELETE the parent and mint an offspring from one monster. Ownership precedes eligibility in both options (no stats leak on foreign monsters). Marshal-early is safe: `monster_to_instance` reads only the Monster row.

**Accepted behavior changes (record in ADR-0147):** `fuse(ctx,7,7)` with 7 nonexistent: `"monster a not found"` (was "cannot fuse itself"); corrupt row fails marshal before battle/trade guards; ineligible pairs report eligibility error before battle/trade/recipe errors.

### D6 — Placement, constants, exports

| Item | Location | Visibility |
|---|---|---|
| `FusionError`, `fusion_eligible` | eligibility.rs | pub |
| `MIN_FUSION_LEVEL: u8 = 10`, `MIN_FUSION_BOND: u8 = 120` | eligibility.rs | pub const |
| `FUSION_EFFICIENCY: u32 = 75`, `LEVEL_RETENTION_FLOOR: u32 = 50` | transform.rs | pub const |
| `fn scale_u32(v: u32, pct: u32) -> u32`, `fn avg_u32(a: u32, b: u32) -> u32` | transform.rs | **private** (unit-tested via `mod tests` `use super::*`) |

`eligibility.rs` = predicate layer; `transform.rs` = constructor layer (spec default confirmed). The 120×0.75=90<120 relationship is documented once in ADR-0147, cross-referenced from both doc comments. **`scale_u32`/`avg_u32` names+signatures are a contract** — tester writes against them; implementer must not rename/inline.

Exports — mod.rs: `pub use eligibility::{evolves_to, fusion_eligible, resolve_evolution, FusionError, MIN_FUSION_BOND, MIN_FUSION_LEVEL}; pub use transform::{evolve, fuse, FUSION_EFFICIENCY, LEVEL_RETENTION_FLOOR};` lib.rs:60 (touches-delta, NARROW — never glob): add `fusion_eligible, FusionError, MIN_FUSION_BOND, MIN_FUSION_LEVEL` to the existing evolution use-line.

### D7 — `fuse()` signature: single function, 4 params

```rust
pub fn fuse(a: &MonsterInstance, b: &MonsterInstance,
            offspring: &Species, chosen_nickname: Option<String>) -> MonsterInstance
```

`Option<String>` by value (moves into `offspring.nickname`). No `fuse_with_nickname` wrapper (two entry points = the drift A0-7 deletes; compiler-forced call-site review is a feature). **`fuse` does NOT call `fusion_eligible` internally** — total constructor; the reducer composes. **The `fuse` REDUCER signature stays `(ctx, a_id, b_id)`** — no bindings/schema change; reducer passes `None` (A1 adds the client arg).

### D8 — `fuse()` body sketch (bounds proofs are mandatory inline comments)

```rust
// bond: taxed max. 255*75/100 = 191 <= u8::MAX — provably infallible.
let bond_raw = u32::from(a.bond.value().max(b.bond.value()));
let bond = Bond::new(u8::try_from(scale_u32(bond_raw, FUSION_EFFICIENCY))
    .expect("max bond 255 * 75 / 100 = 191 <= u8::MAX"));

// level: retention floor protects a lopsided pair; .max(1) protects two level-1 parents.
let (la, lb) = (u32::from(a.level.as_u8()), u32::from(b.level.as_u8()));
let level_raw = scale_u32(avg_u32(la, lb), FUSION_EFFICIENCY)
    .max(scale_u32(la.max(lb), LEVEL_RETENTION_FLOOR))
    .max(1);
let level = Level::new(u8::try_from(level_raw).expect("<= 75 <= u8::MAX"))
    .expect("level_raw in 1..=75 by the .max(1) floor and 75% ceiling");

// evs: per-stat taxed average. avg <= 252 -> *75/100 <= 189 <= 252 (per-stat cap);
// total: sum of floors <= 0.75 * 510 = 382.5 -> <= 382 <= 510 (budget).
let ev = |k: StatKind| -> u16 { u16::try_from(scale_u32(
    avg_u32(u32::from(a.evs.get(k)), u32::from(b.evs.get(k))), FUSION_EFFICIENCY))
    .expect("per-stat avg <= 252 -> taxed <= 189") };
let evs = EVs::new(ev(Hp), ev(Attack), ev(Defense), ev(Speed), ev(SpAttack), ev(SpDefense))
    .expect("per-stat <= 189 <= 252; total <= 382 <= 510");

let derived = derive_stats(&offspring.base_stats, &ivs, &evs, &nature, level);
// nickname: chosen_nickname, xp: xp_for_level(level), current_hp: derived.hp,
// ivs/nature/party_slot: UNCHANGED from today.
```

Preserved verbatim: per-stat IV max closure (A0-1), higher-bond nature `>=` tie→a, party_slot min-of-present, current_hp full at new level, derived_stats from **the taxed level and taxed EVs** (a "derive with zero EVs then assign" mutant must die). **No `as` casts** — `try_from(..).expect("<proof>")` throughout (`-D warnings`).

### D9 — Doc rewrites (currently describe the deleted fresh-body model)

transform.rs:1-12 module doc + fuse doc (48-67) → carry/tax model, exact formulas, `chosen_nickname`, order-independence caveat, cite ADR-0019+0147 · mod.rs:8-10 → carry model · eligibility.rs:1-12 → widen to fusion eligibility · evolution.rs:191-198 step list (+eligibility gate, +trade guard missing today; step 5 "L1" → carry) · eval header prose lines 12-14 (stale "the pure rule also catches it") · ARCHITECTURE.md ~671, ~811 "fresh-L1" → carry/tax, cite ADR-0147.

---

## 1. Sub-slices + EARS (S1 pure rules · S2 eligibility · S3 reducer/seam · S4 teeth+docs)

- **S1-AC1** *(A0-1)* offspring IVs = per-stat max — unchanged (regression guard).
- **S1-AC2** *(A0-2)* bond = `scale_u32(max(a.bond,b.bond), 75)`.
- **S1-AC3** *(A0-3)* level = `max(scale_u32(avg,75), scale_u32(max,50)).max(1)`; exact pins (34,10)→17, (12,10)→8, (60,10)→30, (100,10)→50, (34,34)→25.
- **S1-AC4** *(A0-4)* xp = `xp_for_level(L)`, `level_for_xp(xp)==L`.
- **S1-AC5** *(A0-5)* per-stat EV = `scale_u32(avg,75)`; EVs::new never panics for valid parents.
- **S1-AC6** *(A0-6)* Some(s)→Some(s); None→None regardless of parents' nicknames.
- **S1-AC7** derived_stats from taxed level+EVs; current_hp = that full HP.
- **S1-AC8** order-independence when bonds differ still holds (all new formulas symmetric).
- **S2-AC1..4** *(A0-7)* SelfFusion regardless of stats · level<10 either parent → BelowMinLevel · bond<120 either parent (raw pre-tax) → BelowMinBond · boundaries inclusive (10/120 pass).
- **S3-AC1** reducer evaluates eligibility exactly once via `reject_if_not_fusable` → `game_core::fusion_eligible`; NO inline `a_id == b_id`.
- **S3-AC2** ownership rejects before any stats-derived error (privacy).
- **S3-AC3** offspring Monster ROW carries taxed level/xp/bond/EVs (marshal already flows them).
- **S3-AC4** *(A0-8)* bond-120 parents → offspring bond 90; re-fuse attempt with offspring → bond error.
- **S3-AC5** *(A0-9)* parity matrix: seam accept/reject == fusion_eligible on every boundary case; messages correspond.
- **S4-AC1..3** rewritten E3 eval fails on: hand-rolled checks; inline+delegation both; eligibility before ownership. **S4-AC4** full `just ci` green + scoped `cargo mutants` on changed files clean/no-new-missed.

## 2. Test inventory (tester owns; exact expected values HARDCODED, never derived from the constants)

**transform.rs `mod tests`:** T1 `scale_u32` pins (100,75)=75,(34,50)=17,(1,75)=0,(255,75)=191 · T2 `avg_u32` pins (34,10)=22,(11,10)=10,(0,0)=0,(255,255)=255 · T3 bond taxed-max (200,100)→150 both orders (kills min/untaxed/avg/a-only/b-only) · T4 bond ceiling (255,255)→191 · T5 level pinned 5 spec pairs + swapped (kills branch-drops + 75↔50 swap: (12,10)→8 kills floor-only=6; (34,34)→25,(100,10)→50 kill avg-only) · T6 (1,1)→1 (.max(1); unreachable via reducer — pure-totality, say so) · T7 (100,100)→75 ceiling · T8 xp==xp_for_level(17) ∧ level_for_xp==17 for (34,10) · T9 EV taxed-avg a=(252,0,100,0,0,0),b=(0,252,0,0,0,0)→(94,94,37,0,0,0) (kills transposition/max/untaxed) · T10 EV ceiling both (252,252,6,0,0,0)→(189,189,4,0,0,0) total 382 · T11 derived_stats==derive_stats(off.base, off.ivs, off.evs, off.nature, off.level) with level≠1, evs≠0 (kills derive-at-L1/zero-EV) · T12 current_hp full · T13 nickname None→None despite named parents; Some→used · T14 **A0-8 pure half**: parents bond 120/120 → offspring bond **90**; fusion_eligible(distinct ids, offspring, eligible-partner) → Err(BelowMinBond) · T15 honesty: parents bond 160/160 → offspring 120 → Ok (tax-not-lock; documents R8) · T16 REWRITE `fuse_produces_fresh_body` → `fuse_carries_taxed_individuality` (exact all-field pin) · keep IV/nature/tie/party-slot tests (+`, None`) · DELETE `fuse_xp_is_consistent_with_level_1` (folded into T8).

**eligibility.rs `mod tests`:** T17 exact minimums (10/10,120/120) → Ok (kills `<=` boundary bug) · T18 self-fusion (stats fine) · T19 self precedes stats (level 1, bond 0, same id → SelfFusion) · T20 level 9 on a / on b (kills `&&`, one-sided) · T21 bond 119 on a / on b · T22 a-level-9 + b-bond-119 → BelowMinLevel (category order) · T23 pin MIN_FUSION_LEVEL==10, MIN_FUSION_BOND==120.

**m10a_gating_tests.rs (proptest; arb_* already enforce the exact A0-5 preconditions):** T24 REWRITE criterion 21 → `fuse_totality_and_carry_invariants`: never panics; IVs≤31; 1≤level≤75; per-stat EV≤189; total≤382 (NOT the vacuous ≤510); current_hp==derived.hp>0; xp==xp_for_level(level) — **this is the ".expect never fires" proof** · T25 NEW property: level matches independent recomputation with literal 75/50 (formula-mirror allowed ONLY here) · criteria 17b/18a/18b determinism+order-independence unchanged (+`, None`) · criterion 22 IV-max unchanged.

**evolution_tests.rs (tester owns seam edit + tests):** fixture: ADD `make_fusable_monster_row(id, owner, level, bond)` (do NOT change `make_monster_row` — shared with evolve tests; level 20 clears MIN_FUSION_LEVEL, bond 100 does NOT clear 120) · T26 keep `test_fuse_self_fuse_rejects` (message compat through delegation) · T27 level-9 rejects a/b (msg contains "level 10") · T28 bond-119 rejects a/b (msg contains "120 bond") · T29 exact-boundary success (10/10,120/120) · T30 **A0-9 parity matrix** ~15 rows {self} ∪ ({9,10,11}×{a,b}) ∪ ({119,120,121}×{a,b}) ∪ {both-below}: valid db each row; assert `fuse_seam(..).is_err() == fusion_eligible(..).is_err()`; when Err, seam msg contains the hardcoded variant substring · T31 **A0-8 end-to-end**: fuse bond-120 parents → offspring ROW bond 90 → seed eligible partner + recipe → re-fuse → Err "120 bond" (proves taxed bond reaches the row) · T32 REWRITE `test_fuse_offspring_properties` → pin row level/xp/bond/ev_* from known parents · T33 reducer-None → row nickname=="" (unwrap_or_default) · T34 fixture-bump-only list: both_owned_creates_offspring, a/b_in_ongoing_battle, sideb_pvp ×2, recipe_not_found, offspring_species_not_found, atomic_delete_insert, order_independence, pub_id_matches (assertions unchanged — eligibility now fires before battle/recipe, so parents must be made eligible for those errors to stay reachable).

**evals/evolution-reducer-security.eval.mjs (forced delta):** E3 `checkFuseSelfFusionGuard` → `checkFuseEligibilityDelegation`: (1) fuse body contains compact `reject_if_not_fusable(a_id,b_id,`; (2) body does NOT contain compact `a_id==b_id`/`b_id==a_id` (anti-migration; canonicalization `a_id<b_id` unaffected); (3) file contains `game_core::fusion_eligible(`; (4) ordering `require_owner` < `reject_if_not_fusable` < `game_core::fuse(` within the body. Fixtures: BAD-no-guard (retarget), BAD-inline-only, BAD-both, BAD-eligibility-before-ownership, BAD-helper-hand-rolls (no game_core::fusion_eligible), GOOD-new-shape. Fix stale header prose (12-14). indexOf/literals only — NO `new RegExp` (Semgrep ReDoS ban).

## 3. Anti-patterns (binding on tester + implementer)

1. No guard re-implementation in `fuse_seam` — both paths call `reject_if_not_fusable`.
2. No inline `a_id == b_id` kept "for safety" (eval flags it).
3. `fuse()` never calls `fusion_eligible` internally (total constructor).
4. No `as` casts — `try_from(..).expect("<proof>")`.
5. Test expectations HARDCODED (75, 50, 17, 90, 189, 382, "level 10", "120 bond") — never derived from the constants.
6. No formula-mirroring in unit tests (allowed only in T25 proptest).
7. No `#[non_exhaustive]` on FusionError.
8. No glob re-export in lib.rs (extend the narrow line).
9. Reducer signature unchanged (bindings-drift stays green).
10. `make_monster_row` defaults untouched — add `make_fusable_monster_row`.
11. T24 must not go vacuous (≤382 and ≤189, not ≤510).
12. Never hand-edit docs/knowledge/** or CHANGELOG.md (`just knowledge` / git-cliff).
13. No nickname validation in game-core (A1 boundary concern).
14. Fixture bumps never weaken assertions (every msg.contains stays).
15. `prop_assert_eq!` with no inline `{var}` format args (macro-formatting trap, ptc5e).

## 4. Task sequence (tester ≠ implementer; implementer never edits gating tests)

T0 ADR-0147 skeleton + this plan committed (`wip:`) · T1 tester: game-core RED (transform/eligibility/m10a tests + `, None` at ~22 call sites; compile-RED by design) · T2 implementer: game-core GREEN + docs (D8/D9) + exports; `cargo nextest run -p game-core`; scoped `cargo mutants -p game-core -f src/evolution/transform.rs -f src/evolution/eligibility.rs` zero-missed · T3 tester: server RED (seam rewiring + fixture + T26-T34) · T4 implementer: server GREEN (helper + reducer reorder + inline-check delete + doc updates); `cargo nextest run -p monster-realm-module`; scoped mutants on src/evolution.rs (compare vs base — net-new missed must be ≤ 0 vs the nightly 299 ratchet) · T5 tester: eval E3 rewrite + fixtures; `just eval` · T6 doc-keeper: ADR-0147 final + ARCHITECTURE + `just knowledge` + `just adr-digest` · T7 full `just ci` once + fix via fast gates.

## 5. Risks

R1 mutate-core zero-tolerance → per-mutant test inventory; scoped mutants pre-PR; survivors get pinned examples, never formula mirrors. · R2 mutate-server 299 ratchet → branching lives in the seam-tested helper; deleting the inline `==` likely removes a missed mutant; measure scoped before/after. · R3 eval E3 red is SCHEDULED (T5), not a surprise. · R4 ~15 seam tests go ineligible under the new gate → `make_fusable_monster_row` + explicit T34 list, done in T3 before implementation. · R5 `.expect` in a reducer path = WASM trap if a proof is wrong → 4 inline proofs + T24 full-space property; `monster_to_instance` VERIFIED (marshal.rs:206-228) to reject out-of-range stored level/IVs/EVs — corrupt rows fail marshal, never reach fuse. · R6 ADR collision → 0147 supervisor-assigned; 0146 = nh1 (verified in its worktree). · R7 knowledge-bundle regen (`just knowledge`) — evolution.rs anchors shift. · R8 tax-not-lock honesty: bond≥160 parents still yield eligible offspring — T15 pins it; ADR states the precise claim (see rev-2 #8), NOT "carriers impossible". · R9 live-balance change (offspring up to L75 w/ EVs) — no migration (minted at fuse time); ADR Consequences. · R10 UX gap until A1 (no in-UI explanation of new rejections) — flagged in PR. · R11 helper names are a contract (T1 compiles against them).

---

## 6. Plan-review adjudication (rev 2 — reviewer + red-team findings folded in; BINDING deltas)

Both lenses independently re-verified every arithmetic pin (all correct: level pins, bond 191/150/90/120, EV (94,94,37,0,0,0)/(189,189,4,0,0,0) total 382 — attained, so T10 is load-bearing) and the codebase-reality claims. No BLOCKERs. Accepted deltas:

1. **Eval E3 hardening (red-team F1 — the vacuity finding).** The file-level `indexOf('game_core::fusion_eligible(')` is satisfiable by TEST code (the eval's `readServerModuleSources` includes `*_tests.rs`, unlike no-idle-accrual's reader) or a string literal (`stripRustComments` does not strip strings). Therefore: check (3) is **body-scoped to `reject_if_not_fusable`'s extracted body** and requires the fully-qualified `game_core::fusion_eligible(` call (MN-2); the reader path used by the NEW checks excludes `_tests.rs` and applies string-literal stripping (M16.5d RT-SEC-02b precedent). NEW teeth fixture: hand-rolled helper + a `_tests.rs`-shaped string containing the needle → must still flag.
2. **Eval ordering extended (MJ-1/F9):** `require_owner` < `reject_if_not_fusable(` < `find_fusion_recipe(` (< `game_core::fuse(`). Protects self-fusion precedence + the delete-one-parent hazard if a same-species recipe ever ships. Deliberately NOT pinned vs `reject_if_in_battle` (battle-vs-eligibility order is not load-bearing; don't enshrine an arbitrary choice). NEW fixture: BAD-eligibility-after-recipe.
3. **Mutation-hardening fixtures (MJ-2):** `<`→`!=` mutants survive exact-boundary-only Ok cases. ADD T17b: strictly-above pair (levels 50/50, bonds 200/200) → Ok. Every one-dimension-Err fixture sits STRICTLY above the other minimum (T20 level-9 rows use bond 200; T21 bond-119 rows use level 50).
4. **GOOD fixture migrated in place (MN-1/F6):** `GOOD_FUSE_BOTH_PARENTS` gets the new shape (inline check dropped, `reject_if_not_fusable(a_id,b_id,` added, 4-arg `game_core::fuse` prose). Legacy BAD fixtures for E1/E2/E4/E5 keep their old inline line; state explicitly which checks run against which fixtures. Anti-migration check (2) is a **lint against the literal deleted form**, not proof of absence (F7) — the load-bearing check is (1); do not over-claim in ADR-0147.
5. **Seam order explicit (MN-3/F8):** seam target order = lookup → owner ×2 → marshal → `reject_if_not_fusable` → battle ×2 → species ×2 → recipe → offspring species → canonicalize → fuse. Seam has NO trade guard (pre-existing asymmetry, unchanged, recorded). A0-9 is renamed **eligibility parity** (it proves seam∘eligibility == fusion_eligible, NOT whole-seam==reducer).
6. **Dead same-owner branch deleted (F20):** `a.owner_identity != b.owner_identity` is unreachable after two `require_owner` calls (both == ctx.sender) — a guaranteed mutation-ratchet survivor. DELETE in reducer AND seam. The TESTER reconciles `test_fuse_both_must_be_same_owner` (its fixture makes owner-b ≠ sender, so `"not owner of monster b"` fires first — verify what it pins and re-pin from the spec). Eval E1 (require_owner ×2) remains the mechanical invariant.
7. **Constants ship AS SPEC'D (MJ-3/F2/F3 — rejected as code changes, accepted as disclosures).** MIN_FUSION_BOND=120 costs ~9-10 care actions × 6h cooldown ≈ 54h wall-clock per parent from default bond 70 (care is the only bond writer, +5/action); the second parent's ≥120 buys nothing mechanically (carry uses max only). The spec's own Decisions section ships these as first-cut Drew-overridable. ADR-0147 Consequences records the math + the max-vs-both tension; the PR flags it as a pre-playtest balance decision for Drew. NEW pins: T3b `fuse(bond255, bond120).bond == 191 == fuse(bond255,bond255).bond` (names the weaker-parent-irrelevance invariant); T-reach: `(MIN_FUSION_BOND - default_bond) / CARE_BOND_AMOUNT == 10` care actions (hardcoded 10 — retunes surface the wall-clock cost).
8. **Precise ADR claims (F4/F5):** the carrier exploit is what an UNTAXED carry would have introduced (old behavior reset to 70 and deleted parents — nothing was "reused"; chained fusion is unreachable in shipped content: single recipe, output never a parent). The decay claim: `offspring.bond < max(parent bonds)` for max ≥ 1; lineage-PEAK decay (255→191→143→107 — three generations ≥120 from one 255 carrier); NOT "offspring ≤ weaker parent".
9. **ADR-0147 Consequence notes (F10/F11/F21/F12):** fusion is now a currency-free full-heal (sink EROSION, bounded by 2-monsters-in-1-out + single recipe); offspring can be born `evolves_to`-eligible the moment a fusion output gains a Level(≤75)/Bond(≤191) branch (unreachable today — species 6 has no evolutions block); EV taxed-avg = a partial EV-reset path `focus_train` cannot provide (item-sink refund); D5's ownership-first ordering is convention/hygiene, NOT a security property (monster_pub already exposes level/bond/xp world-readably).
10. **scale_u32/avg_u32 doc domain (F19):** doc comments state the safe input domain (v·pct must fit u32; callers pass ≤ 255·75). No u64 intermediates (YAGNI).
11. **MN-5 (YAGNI):** `FUSION_EFFICIENCY`/`LEVEL_RETENTION_FLOOR` stay `pub` in transform.rs only — NO mod.rs/lib.rs re-export (no consumer). mod.rs/lib.rs export ONLY `fusion_eligible, FusionError, MIN_FUSION_BOND, MIN_FUSION_LEVEL` (+ existing).
12. **MN-6/F14 (annotations):** avg-branch-only killed by (34,10)→17, (60,10)→30, (100,10)→50; floor-branch-only killed by (12,10)→8 and (34,34)→25. All five pins load-bearing.
13. **MN-7:** ADR-0147 records the deviation from spec A0-7's literal signature (ids added — MonsterInstance has no id) with rationale. **MN-8:** `reject_if_not_fusable` name kept; naming exception (lives in evolution.rs, not guards.rs — guards.rs is out of touch-set) recorded in ADR-0147.
14. **MN-4/D9 additions:** ARCHITECTURE.md sites are :671-672 AND :820 (eval-criteria description + proof-of-teeth count go stale); keep edits minimal but accurate.
15. **MJ-4 REJECTED:** `docs/adr/README.md` stays UNTOUCHED (supervisor-owned index, per standing run instructions; README staleness is a known supervisor chore and nothing in `just ci` gates it). **MN-10 REJECTED:** no CHANGELOG regen this slice (git-cliff, 1-slice-lag scoped to master tip — ptc5f precedent; the squashed Conventional Commit feeds the next docs pass).
16. **MN-9:** generated outputs expected in the diff: `docs/knowledge/**` (`just knowledge`), `docs/adr/DIGEST.md` + `docs/adr/design-corpus.json` (`just adr-digest`). ADR-0147 header gates: Decision ≤240 chars; Subsystems from the known vocab (`evolution-fusion`, `ci-gates`).
