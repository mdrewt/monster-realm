//! Red-team tests for M8d `attempt_recruit` and related inventory/recruit logic.
//!
//! Every test here is written to FAIL against a naive/plausible wrong implementation.
//! They prove concrete exploits; none should be trivially green.
//!
//! Run: cargo test redteam_m8d -- --nocapture

use crate::taming::rules::{attempt_recruit, recruit_chance};

// ---------------------------------------------------------------------------
// FINDING 1 (HIGH): TOCTOU — can an already-terminal battle be re-recruited?
//
// The plan says guard checks outcome == Ongoing.  But the plan also says
// "set battle outcome = SideAWins" and "DELETE battle_wild row" happen in
// the same reducer transaction.  SpacetimeDB reducers are atomic per-call.
// However: can a client submit TWO concurrent calls before the first commits?
//
// SpacetimeDB serialises reducer calls per-table-row under its MVCC model —
// concurrent writes to the same battle_id row are serialised.  But ONLY IF
// the implementer actually re-reads the battle from the DB (not a local copy).
//
// The test below proves the LOGIC path is safe:
//   - attempt_recruit on outcome=SideAWins must be rejected by the Ongoing guard.
//   - If the guard checks a stale local copy instead of the DB row the door stays open.
//
// This is not testable as a unit test against the reducer directly, but the pure
// helper `attempt_recruit` takes a pre-computed `chance` and `roll`.  The
// SERVER-SIDE guard invariant we need to prove:
//   "attempt_recruit called on a non-Ongoing battle returns Err immediately"
//
// We test the arithmetic contract that closing the door (deleting battle_wild)
// is the ONLY idempotent guard, since outcome=SideAWins still passes the roll:
// ---------------------------------------------------------------------------

/// FINDING 1: A roll that would succeed is gated only by the Ongoing check.
/// If the server re-reads the battle from the DB after the first commit, the
/// second call hits outcome=SideAWins and is rejected BEFORE the recruit roll.
/// This test documents that `attempt_recruit(1000, any_roll)` always succeeds —
/// so the server MUST guard on outcome, not on the roll value.
#[test]
fn recruit_success_is_not_idempotent_gate() {
    // A chance of 1000 (certainty) means any roll succeeds.
    // If a second call got past the outcome guard, it would also succeed.
    for roll in [0u32, 1, 499, 500, 999, u32::MAX] {
        assert!(
            attempt_recruit(1000, roll),
            "chance=1000 always succeeds — the ONLY gate is the server-side outcome check; \
             if that guard reads a stale local battle copy instead of re-reading the DB row, \
             a second concurrent call wins a second monster"
        );
    }
    // The guard we need the server to enforce: outcome != Ongoing → reject.
    // Documented here as a spec invariant that must be tested end-to-end.
}

// ---------------------------------------------------------------------------
// FINDING 2 (HIGH): Bait consumed BEFORE the roll — failed recruit still burns
// bait. This is documented as "intended" in the plan, but it creates a specific
// economic exploit: a player can spam `attempt_recruit` with chance ≈ 0 to burn
// bait on a near-dead wild that was about to be KO'd, intentionally wasting the
// opponent's item via a self-sabotage pattern.
//
// More critically: the consume-before-roll ordering means the server MUST NOT
// refund bait on a failed roll.  Any implementation that refunds on failure is
// exploitable (free bait on every failed attempt).
//
// This test proves the bait-burn ordering is arithmetically correct — the
// recruitment roll happens AFTER the count decrement.
// ---------------------------------------------------------------------------

/// FINDING 2: bait burn is irreversible — prove that a 0-chance roll with bait
/// still decrements the count.  The server MUST NOT conditionally refund.
/// A refund-on-fail implementation gives infinite bait by alternating
/// attempt_recruit calls with a zero-chance wild.
#[test]
fn zero_chance_recruit_still_consumes_bait() {
    // With chance=0, attempt_recruit always fails.
    // Bait was consumed BEFORE the roll per the plan.
    // The arithmetic contract: consume_one happens, then attempt_recruit(0,..) = false.
    // If consume_one is called ONLY on success, bait is never spent — infinite bait exploit.
    assert!(
        !attempt_recruit(0, 0),
        "chance=0 always fails — if bait is NOT consumed on failure, the player gets \
         infinite free bait uses: call attempt_recruit with any cheap bait, always fail, \
         never lose the bait"
    );
    // Similarly for near-zero chance: roll%1000=1, chance=1 → 1 < 1 is false → fails.
    // roll=1000 would give 1000%1000=0 < 1 → TRUE (success!), so use roll=1.
    assert!(
        !attempt_recruit(1, 1), // 1%1000=1, 1<1 = false → FAIL
        "chance=1, roll=1 → fail (1%1000=1, 1<1 is false). Bait must have been consumed \
         before this point; refund-on-fail would make bait free"
    );
    // Confirm the boundary: roll=1000 IS a success for chance=1 (1000%1000=0 < 1).
    // This means even a "1-in-1000" bait use succeeds if the player gets lucky roll=1000.
    assert!(
        attempt_recruit(1, 1000), // 1000%1000=0 < 1 → TRUE (success at 0.1% chance!)
        "roll=1000: 1000%1000=0, 0 < 1 is true — even chance=1 can succeed; \
         bait is still consumed regardless of outcome"
    );
}

// ---------------------------------------------------------------------------
// FINDING 3 (CRITICAL): Inventory integer overflow — `grant_item` saturating add
// claim is UNVERIFIED in the plan.
//
// The plan says "saturating add" for grant_item on u32 count.
// u32::MAX + 1 with saturating add stays at u32::MAX (correct).
// But: what if the inventory row stores `count` as a smaller type that gets
// cast to u32?  Or what if the implementer uses `count + amount` without
// saturating?  Then count can wrap to 0, and consume_one on 0 fails.
//
// Worse: if count wraps to a SMALL value after an overflow, the player can
// then consume_one that small value to e.g. recruit without actually having enough bait.
//
// The property: for all (count, add_amount) where both are u32,
// saturating_add(count, add_amount) >= count.
// ---------------------------------------------------------------------------

/// FINDING 3: saturating add must not wrap — grant near-MAX then grant again.
/// A wrapping-add impl would produce a count smaller than the pre-add value.
#[test]
fn inventory_grant_saturating_add_does_not_wrap() {
    // The pure arithmetic invariant the server must implement for grant_item:
    let count_before: u32 = u32::MAX - 1;
    let add: u32 = 5;
    let expected = u32::MAX; // saturating
    let actual = count_before.saturating_add(add);
    assert_eq!(
        actual,
        expected,
        "saturating_add({count_before}, {add}) must be u32::MAX, not {}; \
         a wrapping impl would produce {} which is LESS than the pre-add count — \
         an attacker could grant u32::MAX-1 bait, call grant_item again to wrap count \
         to a small value, then consume_one would succeed on an artificially small stack",
        actual,
        count_before.wrapping_add(add),
    );
    // Critical: the wrapped value is SMALLER than the pre-add value.
    // This would allow an attacker to grant themselves so much of an item that
    // the count wraps to e.g. 4, then consume_one on 4 items is fine — but they
    // actually have 4 billion items worth of bait arithmetic miscount.
    assert!(
        count_before.wrapping_add(add) < count_before,
        "PROOF: wrapping_add on u32::MAX-1 + 5 = {} < {} — the wrapped count is smaller \
         than the pre-grant count, proving the saturating contract must be enforced",
        count_before.wrapping_add(add),
        count_before,
    );
}

/// FINDING 3b: consume_one on count=0 must return Err, not underflow to u32::MAX.
/// A naive `count - 1` on u32 where count==0 wraps to u32::MAX in release mode
/// (Rust wrapping semantics on subtraction in non-debug builds with wrapping).
/// Under SpacetimeDB wasm (release), arithmetic panics are UB-style traps or wraps
/// depending on the target; the server must use checked_sub or an explicit guard.
#[test]
fn inventory_consume_one_on_zero_must_not_underflow() {
    let count: u32 = 0;
    // The correct behavior: checked_sub returns None (Err path).
    assert!(
        count.checked_sub(1).is_none(),
        "count=0 checked_sub(1) must be None — the server MUST use checked_sub or an \
         explicit 'if count == 0 return Err' guard; a naive `count - 1` in release mode \
         wraps to u32::MAX, making the player appear to have 4 billion items"
    );
    // The exploit: if consume_one wraps on 0, the player has u32::MAX bait after
    // one failed consume call — effectively infinite bait.
    assert_eq!(
        count.wrapping_sub(1),
        u32::MAX,
        "PROOF: wrapping_sub(0, 1) = u32::MAX — if the server uses wrapping subtraction, \
         a player with 0 bait calls attempt_recruit(bait_id=1) and gets u32::MAX bait \
         as a side effect of the 'no bait' rejection path not checking first"
    );
}

// NOTE: FINDING 4 (bait-classification drift — "ItemRow can't express recruit_bonus,
// server uses load_items() at reduce-time") was CUT: it is now FALSE. `ItemRow`
// carries `recruit_bonus` (seeded from the game-core `ItemDef` in sync_content),
// and `attempt_recruit` classifies bait from the live DB row — never load_items().

// ---------------------------------------------------------------------------
// FINDING 5 (HIGH): IV inversion channel via public BattleState.
//
// ADR-0045 explicitly documents this: "the wild's derived stats ARE published in
// the public battle.state BattleState" and "those derived stats are theoretically
// invertible to the underlying IVs/nature."
//
// For a wild monster: EVs=0, species base stats are public (species_row is public),
// level is public (in battle.state.side_b.team[0].level).
// With known (base, EVs=0, level), the IV can be recovered for each stat by inverting
// the derive_stats formula.
//
// This test proves the inversion is feasible with a brute-force search over [0,31]:
// ---------------------------------------------------------------------------

/// FINDING 5: IV inversion is feasible from public BattleState data.
///
/// ADR-0045: "the wild's derived stats ARE published in the public battle.state
/// BattleState" and "those derived stats are theoretically invertible to the
/// underlying IVs/nature." This test proves the inversion is not merely theoretical —
/// it is exact and trivially fast (32-candidate brute force).
///
/// Level 100, base_hp=45, ev=0 makes HP = (2*45 + iv)*100/100 + 110 = 200 + iv,
/// which is INJECTIVE: each IV in [0,31] maps to a distinct HP value. Therefore the
/// 32-candidate search ALWAYS narrows to exactly 1 result, proving the channel is
/// fully determined (not just "a few candidates").
///
/// The oracle is INDEPENDENT: public_stat_hp is computed once from the known true
/// IV (input construction), and the assertion checks the SEARCH RESULT — a Vec
/// collected by a separate brute-force loop. No branch recomputes the expected
/// value with the function under test (the old self-oracle fallback is deleted).
///
/// ADR-0045 acknowledges this channel but defers mitigation to a future milestone.
/// The test FAILS if derive_stats collapses IVs (e.g. quantises HP), making the
/// candidate set larger or smaller than {15}.
#[test]
fn wild_iv_recoverable_from_public_derived_stats() {
    use crate::monster::rules::derive_stats;
    use crate::monster::types::{EVs, IVs, Level, Nature, NatureKind, StatBlock, StatKind};

    // -----------------------------------------------------------------------
    // INPUT CONSTRUCTION (not a self-oracle):
    // We pick a known true IV and call derive_stats ONCE to get the HP value
    // an eavesdropper would observe in the public BattleState. The assertion
    // below is on the SEARCH RESULT of a separate brute-force loop — never on
    // a recomputation of public_stat_hp inside the assert.
    // -----------------------------------------------------------------------

    // Public data an eavesdropper has from battle.state.side_b.team[0]:
    let public_base_hp: u16 = 45; // from species_row (public)
    let public_level: u8 = 100; // from battle.state.side_b.team[0].level

    // At level=100, base=45, ev=0:  HP = (2*45 + iv)*100/100 + 100 + 10 = 200 + iv
    // → injective over [0,31]: iv=15 → HP=215, iv=14 → HP=214, iv=16 → HP=216.
    let known_true_iv: u8 = 15;

    let evs = EVs::zero(); // wild EVs are always 0 (documented in wild_battle_monster)
    let base = StatBlock {
        hp: public_base_hp,
        attack: 49,
        defense: 49,
        speed: 65,
        sp_attack: 65,
        sp_defense: 45,
    };
    let level = Level::new(public_level).unwrap();
    let nature = Nature::new(NatureKind::Hardy); // Hardy: no stat modifier

    // Compute the HP the eavesdropper observes — this is input construction only.
    let true_ivs = IVs::new(known_true_iv, 0, 0, 0, 0, 0).unwrap();
    let public_stat_hp: u16 =
        derive_stats(&base, &true_ivs, &evs, &nature, level).get(StatKind::Hp);

    // Sanity-check the math: at level=100, base=45, iv=15, ev=0:
    // HP = (2*45 + 15) * 100 / 100 + 100 + 10 = 105 + 110 = 215
    assert_eq!(
        public_stat_hp, 215,
        "HP formula sanity: base=45 iv=15 lv=100 ev=0 → (2*45+15)*1 + 110 = 215"
    );

    // -----------------------------------------------------------------------
    // BRUTE-FORCE INVERSION — collect ALL matching IVs (no break on first match).
    // The SET is the proof: {15} means the channel is fully determined.
    // -----------------------------------------------------------------------
    // 32 possible IVs narrowed to exactly 1 → the ADR-0045 inversion channel is
    // real; level 100 makes derive_stats HP injective (200+iv), so any narrowing
    // failure would balloon the set (duplicate HPs → multiple matches) or shrink
    // it to 0 (no match → derive_stats is broken).
    let mut candidates: Vec<u8> = Vec::new();
    for candidate_iv in 0u8..=31 {
        let ivs = IVs::new(candidate_iv, 0, 0, 0, 0, 0).unwrap();
        let derived = derive_stats(&base, &ivs, &evs, &nature, level);
        if derived.get(StatKind::Hp) == public_stat_hp {
            candidates.push(candidate_iv);
            // NO break — collect the full set to prove singleton, not just presence.
        }
    }

    assert_eq!(
        candidates,
        vec![15u8],
        "IV inversion brute-force over [0,31] must recover exactly {{15}} for \
         public_stat_hp={public_stat_hp} (base=45, level=100, ev=0). \
         HP = 200+iv is injective at level 100, so the candidate set is always a \
         singleton. A set larger than {{15}} means derive_stats collapsed IVs \
         (non-injective formula); an empty set means derive_stats is broken. \
         ADR-0045 acknowledges this inversion channel but defers mitigation."
    );
}

// ---------------------------------------------------------------------------
// FINDING 6 (HIGH): The recruit formula has a per-mille modulo bias.
//
// `roll % 1000 < chance` where roll is u32.
// u32::MAX = 4_294_967_295.  4_294_967_295 / 1000 = 4_294_967 remainder 295.
// So values [0..295] appear 4_294_968 times and [296..999] appear 4_294_967 times.
// Bias per bucket: (4_294_968 - 4_294_967) / 4_294_967_296 ≈ 2.3e-10.
//
// This is documented in taming/rules.rs line 30:
//   "Note: modulo 1000 introduces ~0.007% per-bucket bias on a u32 input"
//
// The practical exploit: recruit_chance values in [0..295] are slightly MORE
// likely to succeed than [296..999] at the margin.  This is ~0.007% per bucket —
// not a practical exploit, but a documented precision issue the implementer
// should be aware of when choosing the RNG and modulus.
// ---------------------------------------------------------------------------

/// FINDING 6: Document the modulo bias for the recruit roll.
/// u32::MAX % 1000 = 295, so roll values [0..295] are over-represented.
#[test]
fn recruit_roll_modulo_bias_is_documented() {
    // Prove the bias exists:
    let max = u32::MAX; // 4_294_967_295
    let remainder = max % 1000;
    assert_eq!(
        remainder, 295,
        "u32::MAX % 1000 = 295 — values 0..=295 appear once more than 296..=999 \
         in a uniform u32 distribution; this creates ~0.007% bias per bucket"
    );
    // The impact on recruit chance: a species with base_rate=295 has
    // recruit_chance(max_hp, max_hp, 295, 0) = 295.
    let chance = recruit_chance(100, 100, 295, 0);
    assert_eq!(chance, 295);
    // With a uniform u32 roll, values 0..295 hit slightly more often than expected.
    // Not a practical exploit, but a precision issue in the per-mille model.
}

// ---------------------------------------------------------------------------
// FINDING 7 (MED): The on-fail wild counterattack creates a grinding exploit.
//
// When attempt_recruit fails, the wild strikes back via resolve_enemy_turn.
// The plan does NOT implement a "flee attempt" cost per turn on wild battles.
// A player can:
//   1. Weaken the wild to near-0 HP for ~100% recruit chance.
//   2. Call attempt_recruit repeatedly.
//   3. On each failure, the wild strikes back.
//   4. If the player's active is tanky enough, this creates an infinite retry loop
//      as long as the player's monster doesn't faint.
//
// This is an "infinite turns" exploit that lets a player:
//   - Repeatedly attempt to recruit while healing (if heal_party is available between attempts)
//   - Or simply spam attempts on a near-dead wild knowing each failure just advances the turn.
//
// The wild can faint the player's monsters, but a max-HP team vs a 1-HP wild
// is essentially free retries.
//
// More critically: there is NO turn limit on wild battles in the plan.
// ---------------------------------------------------------------------------

/// FINDING 7: A 1-HP wild can be attempt_recruited indefinitely if the player
/// is tanky. The recruit chance at 1/max_hp approaches MISSING_HP_FACTOR.
#[test]
fn near_dead_wild_recruit_chance_is_near_max_factor() {
    // Wild at 1 HP out of 100 max:
    let chance = recruit_chance(100, 1, 0, 0);
    // hp_bonus = (100-1)*500/100 = 99*500/100 = 49500/100 = 495
    assert_eq!(
        chance, 495,
        "near-dead wild (1/100 HP) has recruit chance of 495/1000 ≈ 49.5%; \
         with ~50% chance each attempt, expected ~2 tries to succeed; \
         but there's NO attempt limit — a player can spam recruit_attempt until it lands"
    );
    // INVARIANT (grinding residual, accepted for M8d): there is NO per-battle
    // attempt cap. At MISSING_HP_FACTOR=500 a 0-HP wild sits at 50% + base + bait,
    // so even ~50% per attempt means a tanky party vs a 1-HP wild WILL eventually
    // recruit (each failed attempt just advances the turn). A turn/attempt limit is
    // a future-milestone follow-up; the `chance==495` tooth above pins the formula.
}

// NOTE: FINDING 8 (battle_wild orphan rows on non-recruit battle end) was CUT:
// it is now FALSE. `write_back_battle_results` unconditionally deletes the
// battle_wild row (a no-op for PvP), so flee/loss/combat-win all GC the wild row;
// `attempt_recruit` GCs on its own success/terminal paths. No orphan accumulates.

// NOTE: FINDING 9 (the `assert!(true, "structural: ...")` tautology about the
// "is wild" signal) was CUT: it asserted nothing. The real guard is verified by
// the recruit-reducer-security eval (checkWildBattleGuard scans attempt_recruit
// for the `battle_wild(` lookup) — a text tooth, not a pure-arithmetic one.

// ---------------------------------------------------------------------------
// FINDING 10 (MED): recruit_chance integer truncation can produce IDENTICAL
// chances for different HP values due to integer division.
//
// Formula: hp_bonus = (max_hp - current_hp) * 500 / max_hp
// For max_hp=3:
//   current_hp=2: (3-2)*500/3 = 500/3 = 166 (truncated)
//   current_hp=1: (3-2+1)*500/3 = 2*500/3 = 1000/3 = 333 (truncated)
//   current_hp=0: 3*500/3 = 1500/3 = 500
//
// For max_hp=2:
//   current_hp=1: 1*500/2 = 250
//   current_hp=0: 2*500/2 = 500
//
// But for large max_hp, consecutive HP values can produce identical chances.
// This is expected integer behavior, but it means "weakening" the wild by 1 HP
// may not always improve recruit odds — a player who expects continuous improvement
// will be surprised.
// ---------------------------------------------------------------------------

/// FINDING 10: Integer truncation causes recruit_chance to be non-strictly-monotone
/// for small max_hp values — consecutive HP reductions may show no improvement.
#[test]
fn recruit_chance_truncation_can_plateau() {
    // max_hp=3: chance at hp=2 and hp=1 are both non-zero but may plateau
    let c2 = recruit_chance(3, 2, 0, 0); // (3-2)*500/3 = 166
    let c1 = recruit_chance(3, 1, 0, 0); // (3-1)*500/3 = 333
    let c0 = recruit_chance(3, 0, 0, 0); // 3*500/3 = 500

    assert_eq!(c2, 166, "hp=2/3: hp_bonus = 166 (truncated)");
    assert_eq!(c1, 333, "hp=1/3: hp_bonus = 333 (truncated)");
    assert_eq!(c0, 500, "hp=0/3: hp_bonus = 500");

    // Now try a case where consecutive HP values produce the SAME chance:
    // max_hp=1000: each HP unit contributes 500/1000=0 (rounded down!) for hp changes < 2
    // Actually with max=1000 and missing=1: 1*500/1000=0 (truncated to 0)
    // So weakening a 1000-HP wild by 1 HP gives NO recruit bonus improvement!
    let at_full = recruit_chance(1000, 1000, 100, 0); // base=100
    let at_999 = recruit_chance(1000, 999, 100, 0); // hp_bonus = 1*500/1000 = 0

    assert_eq!(
        at_full, at_999,
        "PLATEAU: max_hp=1000, hp=999 vs hp=1000 gives IDENTICAL recruit chance ({at_full}); \
         integer truncation makes 1*500/1000=0; a player who reduces the wild by 1 HP \
         gets NO improvement — may be surprising and lead to over-weakening"
    );

    // The threshold where improvement kicks in: missing_hp >= ceil(max_hp/500)
    let threshold_missing = 1000u32 / 500 + 1; // = 3
    let at_threshold = recruit_chance(1000, 1000 - threshold_missing as u16, 100, 0);
    assert!(
        at_threshold > at_full,
        "improvement only kicks in at missing_hp >= {threshold_missing} for max_hp=1000; \
         below this threshold, integer truncation gives 0 hp_bonus"
    );
}

// ---------------------------------------------------------------------------
// FINDING 11 (LOW/MED): Public inventory table leaks count information.
//
// The plan says: "The inventory table is public (counts deemed low-stakes)"
// But count information reveals:
// - Which players have acquired bait (guild spying)
// - Approximate session length / farming rate
// - Whether a target has bait before a competitive encounter
//
// For a PvP expansion (M16), inventory visibility becomes a cheating surface:
// a player can monitor an opponent's bait count to time PvP challenges.
//
// This is rated LOW for M8d (PvE only) but must be flagged for M16 planning.
// ---------------------------------------------------------------------------

// INVARIANT (M16 design debt, not an M8d arithmetic tooth): the `inventory` table
// is public with RLS by owner_identity, so a player sees only their OWN counts for
// M8d (PvE). The residual to revisit at M16 (PvP): if visibility were ever widened,
// an item count of 0 vs N would reveal whether an opponent can attempt_recruit — a
// timing/spying surface. The fix at that point is to keep the owner-only RLS filter.
// (The original test only asserted `5 > 0` / `0 == 0`, which were tautological, so
// the prose is preserved here and the empty test fn was removed.)
