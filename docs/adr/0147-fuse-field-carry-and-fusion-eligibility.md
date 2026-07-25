# 0147 — fuse() field-carry repair (taxed, not reset) + fusion_eligible guard SSOT

**Status:** Accepted
**Date:** 2026-07-25
**Slice:** A0 (M-postgate-evolution-fusion-hardening — fuse() field-carry fix + fusion_eligible extraction; EARS A0-1..A0-9)
**Supersedes:** —
**Amends:** ADR-0061 (fuse's fresh-body offspring model — level-1/zero-EV/default-bond/no-nickname — is replaced by the taxed carry below; IV-max, nature, party_slot, order-independence rules unchanged)
**Subsystems:** evolution-fusion, ci-gates
**Decision:** fuse() carries taxed individuality: bond=75% of max, level=max(75% of avg, 50% of max)>=1, EVs=75% of per-stat avg, xp=level^3, nickname param. Pure fusion_eligible (no self-fuse; both parents level>=10, bond>=120) is the sole guard SSOT.

## Context

Drew's 2026-07-25 playtest report said fusion "erases the individual monsters." Grounding
against live code (35-agent `monster-realm-evolution-fusion-redesign` workflow; harness
ADR-0019 amendment 2026-07-25) verified the complaint as a real drift from ADR-0019's own
"carry/combine… not erase" intent: `evolve()` carries 100% of individuality verbatim, while
`fuse()` correctly combined the *genetic* half (per-stat IV max, higher-bond nature) but
hard-reset the *relationship* half — level→1, EVs→0, bond→default(70), nickname→None. The
converged decision: repair `fuse()`'s field-carry (do NOT replace fusion with evolution;
fusion stays permanent/destructive), and gate fusion on investment minimums so the carry
cannot be farmed. The reference spec pins the formulas and constants exactly
(`M-postgate-evolution-fusion-hardening.spec.md` §A0); this ADR records the build-time
decisions, deviations, and honest consequences.

## Decision detail

1. **Carry formulas** (`game-core/src/evolution/transform.rs`; `scale_u32(v,pct)=v*pct/100`,
   `avg` = integer floor):
   - bond = `scale_u32(max(a.bond, b.bond), FUSION_EFFICIENCY=75)` — never `default_bond()`.
   - level = `max(scale_u32(avg(a.level,b.level),75), scale_u32(max(a.level,b.level),
     LEVEL_RETENTION_FLOOR=50)).max(1)` — pinned: (34,10)→17, (12,10)→8, (60,10)→30,
     (100,10)→50, (34,34)→25. Range is exactly [1,75].
   - xp = `xp_for_level(level)` so `level_for_xp(xp)==level` always (curve is level³, exact).
   - EVs per stat = `scale_u32(avg(a.ev,b.ev),75)`, built by `EVs::new(..).expect(..)` with
     inline bounds proofs (per-stat ≤189≤252; total ≤382≤510 — both bounds attained).
   - `chosen_nickname: Option<String>` param: `Some(s)`→`Some(s)`; `None`→`None` (parents'
     nicknames are never carried implicitly — a fused monster is named by its owner in A1).
   - Unchanged: IV per-stat max, higher-bond nature (tie→a), party_slot min-of-present,
     current_hp = full at the new derived stats, derived_stats from the TAXED level+EVs.
   - All new formulas are symmetric in (a,b), so ADR-0061's order-independence invariant
     (fuse(a,b)==fuse(b,a) when bonds differ) is preserved.
2. **`fusion_eligible(a_id, b_id, a: &MonsterInstance, b: &MonsterInstance) ->
   Result<(), FusionError>`** in `eligibility.rs`; checks self-fusion (id equality) first,
   then both levels ≥ `MIN_FUSION_LEVEL=10`, then both raw pre-tax bonds ≥
   `MIN_FUSION_BOND=120`. `FusionError { SelfFusion, BelowMinLevel, BelowMinBond }` — unit
   variants, no Display (CareError precedent); the server maps variants→strings once.
   **Deviation from spec A0-7's literal signature:** the spec wrote `fusion_eligible(a, b)`;
   `MonsterInstance` has no id field, so self-fusion is undetectable from instances alone —
   the two ids are passed as opaque equality-only handles (function stays pure).
3. **Single delegation point:** `reject_if_not_fusable(a_id, b_id, &a_inst, &b_inst)` in
   `server-module/src/evolution.rs` (NOT guards.rs — out of the slice touch-set; naming
   exception to the `reject_if_*`-lives-in-guards.rs convention, recorded here) delegates to
   `game_core::fusion_eligible` and owns the variant→message mapping. Both the real `fuse`
   reducer and the `fuse_seam` test double call it; the reducer's inline `a_id == b_id` and
   the seam's hand-duplicated guard copy are DELETED (A0-7: delete, don't migrate).
4. **Reducer guard order** (new): lookups → require_owner ×2 → marshal both →
   `reject_if_not_fusable` → battle ×2 → trade ×2 → species rows → recipe → transform.
   Ownership precedes eligibility (convention/hygiene — NOT a security property:
   `monster_pub` already exposes level/bond/xp world-readably). Eligibility precedes the
   recipe lookup so self-fusion reports itself (not "no fusion recipe") and a future
   same-species recipe can never delete a monster fusing with itself. The unreachable
   same-owner branch (dead after two `require_owner` calls — a guaranteed mutation-ratchet
   survivor) is deleted from reducer and seam; eval E1 (require_owner ×2) remains the
   mechanical invariant. Reducer signature stays `fuse(ctx, a_id, b_id)` — no bindings or
   schema change; the reducer passes `None` for the nickname until A1's UI lands.
5. **Eval E3 rewritten** (`evals/evolution-reducer-security.eval.mjs`): the old check pinned
   the inline `a_id==b_id` this slice deletes. New check: the fuse body calls
   `reject_if_not_fusable(a_id,b_id,` before `find_fusion_recipe(`; contains no inline
   `a_id==b_id`/`b_id==a_id` (a lint against the deleted literal form, not a proof of
   absence); and `reject_if_not_fusable`'s own body calls the fully-qualified
   `game_core::fusion_eligible(` — body-scoped, test-file-blind, string-literal-stripped,
   so test code or a comment can never satisfy it (the prior file-level scan could be).

## Consequences (honest, including the unflattering ones)

- **The carrier-exploit claim, stated precisely:** the 75% output tax pre-empts the
  reusable-high-bond-carrier loop that an UNTAXED carry would have introduced (under the old
  reset-to-70 behavior nothing was "reused" — both parents are deleted). The true invariant:
  `offspring.bond < max(parent bonds)` whenever max ≥ 1 — the tax decays a lineage's PEAK
  bond (255→191→143→107: three generations ≥120 from one 255-bond carrier); it does NOT
  bound offspring by the weaker parent. Chained fusion is unreachable in shipped content
  today (single recipe (1,2)→6; species 6 is a parent in no recipe) — the A0-8 teeth seed a
  synthetic recipe to prove the gate bites.
- **Reachability (Drew balance decision, pre-playtest):** bond starts at 70; `care` is the
  only bond writer (+5 per 6h cooldown), so `MIN_FUSION_BOND=120` costs 10 care actions ≈
  54h wall-clock per parent (×2 parents; a re-fuse of a taxed 90-bond offspring costs 6
  more). A playtest shorter than ~2 days cannot reach a fusion. Also: the gate demands ≥120
  from BOTH parents but the carry uses `max(a.bond,b.bond)` only, so the weaker parent's
  bond investment has no mechanical effect on the output (pinned honestly by a test).
  Constants ship exactly as the spec's first-cut defaults (its own Decisions section defers
  tuning to post-playtest evidence); this paragraph is the flagged input to that decision.
- **Balance surface:** offspring now emerge up to L75 with carried EVs and full HP. Fusion
  therefore erodes (not bypasses) the heal-economy sink — two fainted parents become one
  full-HP monster with no currency spend, bounded by 2-in-1-out and the single recipe. The
  EV taxed-average is also a deliberate partial EV-RESET path (a mis-trained 510-total
  monster fused with a zero-EV partner emerges at ~37% of the bad spread) — capability
  `focus_train` cannot provide; named here rather than discovered in playtest.
- **`evolves_to` at birth:** offspring eligibility is computed with the new taxed values
  (up to L75/bond-191 inputs, vs L1/70 before). Unreachable today (species 6 has no
  evolutions block), but the moment a fusion output gains a Level(≤75)/Bond(≤191) branch,
  fuse→evolve chaining at creation becomes live. Keep fusion outputs out of
  `evolutions.ron` or accept the chain deliberately.
- **Error-precedence changes** (no test pinned the old orders): `fuse(ctx, X, X)` with X
  nonexistent now reports "monster a not found" (was "cannot fuse a monster with itself");
  an ineligible pair reports the eligibility error before battle/trade/recipe errors; a
  corrupt row fails marshal before the battle guard.
- **No migration:** already-fused monsters keep their rolled values (one-time grandfather,
  per spec §4). No schema, bindings, client, or content change in this slice.

## Alternatives considered

- **Replace fusion with typed-energy evolution** (Drew's original pitch) — deferred, not
  rejected, by the 35-agent workflow (harness ADR-0019 amendment); revisit only on weak-H2
  playtest evidence.
- **`fusion_eligible` inside `fuse()`** — rejected: fuse stays a total constructor (property
  tests need totality; the reducer composes gate + transform).
- **`Display` on `FusionError` in game-core** — rejected: CareError precedent keeps
  player-facing copy at the server boundary, one mapping site.
- **Bond carry from avg instead of max / one-sided bond gate** — would resolve the
  weaker-parent-irrelevance tension but deviates from the spec's pinned formulas; left to
  the post-playtest balance pass with the tension recorded above.
- **A `fuse_with_nickname` wrapper** (spare ~22 call-site edits) — rejected: two entry
  points is exactly the drift class A0-7 deletes; compiler-forced call-site review is a
  feature.
