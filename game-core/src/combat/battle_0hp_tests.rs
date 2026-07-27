//! battle-0hp-fix gating tests — the 0 HP lead defect (ADR-0156).
//!
//! Criterion → test mapping:
//!   EARS E5 (regression reproducing Drew's r2 sequence)
//!       → drew_r2_zero_hp_lead_is_never_sent_out_and_produces_no_phantom_swap
//!         [GREEN since ADR-0156 D1 landed; was RED — `with_lead` did not exist]
//!   EARS E5 (proof-of-teeth control for the above)
//!       → drew_r2_control_the_old_hardcoded_lead_did_produce_the_phantom_swap
//!         [GREEN before AND after `with_lead` landed — by design; see its doc]
//!   ADR-0156 "Consequences" (entry abilities fire on the REAL lead)
//!       → entry_ability_fires_on_the_real_lead_not_on_the_corpse
//!         [GREEN since ADR-0156 D1 landed; was RED]
//!   ADR-0156 D3 (rejected: hardening the pure resolver against a fainted actor)
//!       → a_zero_hp_active_state_self_repairs_and_never_becomes_a_fixpoint
//!         [GREEN today — pins the behavior D3 forbids removing; the ONLY test
//!          here that catches an ACTING-side fainted early-return]
//!   ADR-0156 D3 + ADR-0100 D6 (Faint→Switch adjacency)
//!       → fainted_defender_still_faints_and_auto_switches
//!         [GREEN today — pins the self-repair mechanism D3 depends on;
//!          DEFENDER-side only, see its docstring]
//!
//! # Deterministic-fixture discipline
//!
//! Every fixture here uses `weather: None`, an EMPTY `BattleStatusStore` and an
//! EMPTY `AbilityStore` (except where an ability is the subject under test).
//! That is not incidental: the post-turn DoT phase (`status.rs`) and the weather
//! chip phase (`weather.rs`) can each independently emit `Faint` and the
//! following auto-`Switch`. A poisoned or hailed monster would inject exactly the
//! events the E5 regression asserts are absent, turning a passing fix into a
//! red test for a reason that has nothing to do with lead selection.
//!
//! Damage is kept deliberately small (level 10, attack 40, power 40) against
//! 500 HP monsters so no *conscious* monster can faint inside a fixture — the
//! only faints that can occur are the ones the tests are about.

use crate::combat::ability::{apply_entry_ability, AbilityEffect, AbilityStore};
use crate::combat::resolve::resolve_full_turn;
use crate::combat::status::{BattleStatusStore, StatusVariance};
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnChoice,
    TurnVariance,
};
use crate::content::SkillDef;
use crate::monster::types::{Affinity, StatBlock};

// ===========================================================================
// Fixture helpers (idiom borrowed from m14_5h_tests.rs)
// ===========================================================================

fn make_stat_block(speed: u16) -> StatBlock {
    StatBlock {
        hp: 500,
        attack: 40,
        defense: 40,
        speed,
        sp_attack: 50,
        sp_defense: 50,
    }
}

/// A level-10 battler. `current_hp == 0` makes it a corpse; `max_hp` is always
/// 500 so a 0 HP monster is a *fainted* monster, not a 0-max-HP oddity.
fn make_monster(species_id: u32, affinity: Affinity, current_hp: u16, speed: u16) -> BattleMonster {
    BattleMonster {
        species_id,
        affinity,
        level: 10,
        current_hp,
        max_hp: 500,
        stats: make_stat_block(speed),
        known_skill_ids: vec![1],
        status: None,
    }
}

/// The only skill in these fixtures: Fire, power 40, accuracy 100.
///
/// Affinity choices are load-bearing, and are read from the embedded content
/// `game-core/content/type_chart.ron` — the file `make_type_chart()` actually
/// loads (via `crate::content::load_type_chart()`). Fire is super-effective (20)
/// vs Plant, which guarantees the corpse is *hit*: an `Immune` (0) hit returns
/// from `resolve_one_attack` BEFORE the faint branch and would silently vacate
/// the control fixture. Fire is not-very-effective (5) vs Water and vs Fire,
/// which keeps every conscious monster comfortably alive. That chart lists no
/// `effectiveness: 0` pair at all, so no fixture here can reach the `Immune` path.
fn fire_skill() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Ember".to_string(),
        affinity: Affinity::Fire,
        power: 40,
        accuracy: 100,
        pp: 25,
        sets_weather: None,
        applies_status: None,
    }
}

fn skills_vec() -> Vec<SkillDef> {
    vec![fire_skill()]
}

/// Always hits (roll 0 < accuracy 100), maximum damage roll, A wins speed ties.
fn always_hit_variance() -> TurnVariance {
    TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: true,
    }
}

/// `StatusVariance` that never blocks and never thaws.
fn no_block_sv() -> StatusVariance {
    StatusVariance {
        action_skip_roll_a: 99,
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    }
}

/// Side A's party as Drew had it: a 0 HP monster in slot 0, a healthy one in slot 1.
/// Slot 0 is Plant so a Fire hit on it is super-effective (never `Immune`).
fn drew_party() -> Vec<BattleMonster> {
    vec![
        make_monster(10, Affinity::Plant, 0, 30), // the 0 HP lead — Drew's slot 0
        make_monster(11, Affinity::Water, 500, 30), // the healthy backup
    ]
}

/// The wild opponent: one conscious Fire monster.
fn lone_opponent() -> Vec<BattleMonster> {
    vec![make_monster(20, Affinity::Fire, 500, 40)]
}

fn is_faint(e: &BattleEvent, s: SideId) -> bool {
    matches!(e, BattleEvent::Faint { side } if *side == s)
}

fn is_switch(e: &BattleEvent, s: SideId) -> bool {
    matches!(e, BattleEvent::Switch { side, .. } if *side == s)
}

// ===========================================================================
// EARS E5 — the regression: a 0 HP lead is never sent out, and no phantom swap
// ===========================================================================

/// EARS E5 (ADR-0156 D1): Drew's r2 playtest sequence, reproduced.
///
/// Repro from the ledger (episode `r2-2026-07-26`, items 005/030/031/036–039):
/// the lead party monster is at 0 HP at battle start, it is still sent out for
/// round 1, the attack button appears to work, and round 2 "silently swaps" to
/// the next monster with no player-visible explanation.
///
/// With `BattleSide::with_lead` the corpse is never seated, so the enemy's
/// counter-attack lands on a *conscious* monster and the faint/auto-switch
/// branch of `resolve_one_attack` never fires for side A. The observable
/// signature of the defect — a `Faint { SideA }` followed by a `Switch { SideA }`
/// on a turn the player did nothing wrong — is therefore absent.
///
/// Determinism (see module docs): `weather: None` and an EMPTY
/// `BattleStatusStore` are chosen EXPLICITLY. The post-turn DoT phase and the
/// weather-chip phase can each emit `Faint` + `Switch` on their own; either
/// would make the "no Faint / no Switch" assertions fail for a reason that has
/// nothing whatsoever to do with lead selection.
///
/// Non-vacuity (S4): the two "no such event" claims are ABSENCE claims, and an
/// absence claim is trivially true on an empty stream. Two drifts inside THIS
/// body — an `outcome` other than `Ongoing` (every resolver early-returns, so
/// `events == []`) and a `Pass` for side B (the lead is never attacked) — were
/// each verified to leave the whole suite green. The test therefore asserts the
/// positive fact FIRST: exactly one non-zero `Damage { side: SideA }`, exactly one
/// `Damage { side: SideB }`, and slot 1 damaged-but-alive. The control test below
/// covers drift in the SHARED helpers; these assertions cover drift in here.
///
/// Kills: the pre-fix `BattleSide { active: 0, team }` literal (side A would be
/// seated at slot 0 and both forbidden events would appear — see the control
/// test below, which asserts exactly that); a `with_lead` that returns `active`
/// pointing at a fainted slot; a `with_lead` that rotates the conscious monster
/// into slot 0 (`side_a.active == 1` before the turn would fail); a future edit
/// that defuses the turn instead of fixing the code.
#[test]
fn drew_r2_zero_hp_lead_is_never_sent_out_and_produces_no_phantom_swap() {
    let chart = make_type_chart();

    let side_a = BattleSide::with_lead(drew_party())
        .expect("EARS E5: a party with a conscious slot 1 must produce a side");
    let side_b =
        BattleSide::with_lead(lone_opponent()).expect("EARS E5: the wild opponent is conscious");

    let mut state = BattleState {
        side_a,
        side_b,
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        // EXPLICIT: no weather — the weather-chip phase must not be able to
        // manufacture the Faint/Switch pair this test asserts is absent.
        weather: None,
    };

    // The lead is chosen BEFORE anything resolves: this is the fix itself.
    assert_eq!(
        state.side_a.active, 1,
        "TEETH (E5): the conscious slot-1 monster must be the lead, not the \
         0 HP slot-0 monster. Pre-fix this is 0 and the corpse is sent out."
    );
    assert_eq!(
        state.side_a.team[0].current_hp, 0,
        "fixture integrity: slot 0 must still be the 0 HP monster (with_lead \
         must not have reordered or healed the team)"
    );

    // EXPLICIT: an empty status store — no DoT can fire in the post-turn phase.
    let mut status = BattleStatusStore::new(2, 1);
    let abilities = AbilityStore::new(2, 1);
    let sv = no_block_sv();
    let variance = always_hit_variance();

    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // S4 — the assertions below are ABSENCE claims, and an absence claim is
    // vacuously true on an empty or truncated event stream. Two drifts inside
    // this very body would defuse them silently: setting `outcome` to anything
    // but `Ongoing` (both `resolve_turn` and `resolve_full_turn`'s post-turn
    // phases early-return, yielding `events == []`), or changing side B's choice
    // to `Pass` (side A's lead is never attacked, so of course it never faints).
    // Pin the positive fact FIRST — the enemy actually hit side A's lead — so the
    // no-Faint/no-Switch claims are conditional on the turn having happened.
    let damage_to_a = events
        .iter()
        .filter(
            |e| matches!(e, BattleEvent::Damage { side: SideId::SideA, amount, .. } if *amount > 0),
        )
        .count();
    assert_eq!(
        damage_to_a, 1,
        "TEETH (E5 non-vacuity): the enemy must land exactly one non-zero hit on \
         side A's lead this turn. Zero means the turn did not happen (a non-Ongoing \
         `outcome` early-returns, or side B was given `Pass`) and every absence \
         assertion below would be vacuously true. Events: {events:?}"
    );
    let damage_to_b = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                BattleEvent::Damage {
                    side: SideId::SideB,
                    ..
                }
            )
        })
        .count();
    assert_eq!(
        damage_to_b, 1,
        "TEETH (E5 non-vacuity): side A's lead must also act — exactly one hit on \
         side B. Zero means side A was blocked or passed. Events: {events:?}"
    );
    // The hit must have landed on the LEAD (slot 1), not on the corpse in slot 0:
    // damaged but still standing, with slot 0 untouched at 0 HP.
    assert!(
        state.side_a.team[1].current_hp > 0 && state.side_a.team[1].current_hp < 500,
        "TEETH (E5): side A's slot-1 lead must have taken the enemy hit and \
         survived it (0 < hp < 500); found {}. If it is still at 500 the enemy \
         struck slot 0 instead, and the absence assertions below prove nothing.",
        state.side_a.team[1].current_hp
    );

    let faint_a: Vec<usize> = events
        .iter()
        .enumerate()
        .filter_map(|(i, e)| is_faint(e, SideId::SideA).then_some(i))
        .collect();
    assert!(
        faint_a.is_empty(),
        "TEETH (E5): no `Faint {{ side: SideA }}` may be emitted — side A's lead \
         is conscious and survives the counter-attack. Found at event indices \
         {faint_a:?} in {events:?}. Pre-fix the corpse is the active and the \
         enemy's hit trips the already-fainted defender branch."
    );

    let switch_a: Vec<usize> = events
        .iter()
        .enumerate()
        .filter_map(|(i, e)| is_switch(e, SideId::SideA).then_some(i))
        .collect();
    assert!(
        switch_a.is_empty(),
        "TEETH (E5): no `Switch {{ side: SideA, .. }}` may be emitted — this IS \
         Drew's unexplained round-2 swap. Found at event indices {switch_a:?} in \
         {events:?}."
    );

    assert_eq!(
        state.side_a.active, 1,
        "TEETH (E5): the active slot must not move during the turn — a swap the \
         player never asked for is the reported defect"
    );
}

/// EARS E5 PROOF-OF-TEETH (control): the pre-fix shape DOES produce the phantom swap.
///
/// This test was GREEN from the moment `BattleSide::with_lead` existed — whether
/// or not the server shells had adopted it — and it is still green now that the
/// whole slice has landed. (It could not be observed at all during the initial
/// RED state, when `with_lead` was missing and `game-core` did not build.)
/// That invariance is the entire point: it is what proves the regression
/// test above is measuring something real rather than being vacuously true. If
/// the shared fixture were somehow unable to produce a
/// `Faint`/`Switch` pair at all (an `Immune` matchup, a miss, a blocked action, a
/// terminal outcome reached earlier), the E5 test would pass no matter what
/// `with_lead` does — and this control would fail loudly instead of letting that
/// pass silently.
///
/// It builds side A with the raw literal `BattleSide { active: 0, team }` — the
/// exact pre-fix shape from `start_battle` / `begin_encounter` — and asserts the
/// defect signature: a `Faint { SideA }` immediately followed by a
/// `Switch { SideA, new_active: 1 }`.
///
/// Kills (if it ever goes red): a drift in the SHARED fixture helpers that
/// silently defuses the E5 regression test — an affinity change that makes the
/// hit `Immune`, an accuracy roll that misses, team HP that lets the corpse
/// survive, or a `StatusVariance` that blocks the action.
///
/// SCOPE LIMIT (S4): this control only covers what E5 and it hold in COMMON —
/// `drew_party()`, `lone_opponent()`, `fire_skill()`, `always_hit_variance()`,
/// `no_block_sv()`. Anything E5 constructs INLINE (its `outcome:` field, its two
/// `TurnChoice`s) is invisible here, and both of those were verified to defuse
/// E5 while leaving this control green. E5 therefore carries its own positive
/// "the enemy actually hit side A's lead" assertions; do not remove them on the
/// grounds that this control exists.
#[test]
fn drew_r2_control_the_old_hardcoded_lead_did_produce_the_phantom_swap() {
    let chart = make_type_chart();

    let mut state = BattleState {
        // The pre-fix construction, verbatim: active is hardcoded to 0 with no
        // regard for whether slot 0 is conscious.
        side_a: BattleSide {
            active: 0,
            team: drew_party(),
        },
        side_b: BattleSide {
            active: 0,
            team: lone_opponent(),
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    let mut status = BattleStatusStore::new(2, 1);
    let abilities = AbilityStore::new(2, 1);
    let sv = no_block_sv();
    let variance = always_hit_variance();

    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    let faint_idx = events
        .iter()
        .position(|e| is_faint(e, SideId::SideA))
        .unwrap_or_else(|| {
            panic!(
                "CONTROL BROKEN: the pre-fix `BattleSide {{ active: 0 }}` fixture must \
                 still emit `Faint {{ side: SideA }}` — that is the defect this slice \
                 removes. Without it the E5 regression test is vacuous. Events: {events:?}"
            )
        });

    assert_eq!(
        events.get(faint_idx + 1),
        Some(&BattleEvent::Switch {
            side: SideId::SideA,
            new_active: 1,
        }),
        "CONTROL BROKEN: `Faint {{ SideA }}` at index {faint_idx} must be \
         immediately followed by `Switch {{ SideA, new_active: 1 }}` — Drew's \
         unexplained round-2 swap. Events: {events:?}"
    );

    assert_eq!(
        state.side_a.active, 1,
        "CONTROL BROKEN: the pre-fix path auto-switches side A to slot 1"
    );
}

// ===========================================================================
// ADR-0156 "Consequences" — entry abilities fire on the REAL lead
// ===========================================================================

/// ADR-0156 Consequences (EARS E1 follow-on): the battle-start entry ability
/// must fire for the monster that is actually sent out.
///
/// Before this slice a 0 HP slot-0 monster was seated as active, so
/// `apply_entry_ability` looked up `abilities.side_a[0]`, found the corpse's
/// (absent) ability, and the *backup's* ability only fired a turn later via the
/// KO auto-switch. After `with_lead`, `active == 1` and slot 1's `EntryHeal`
/// fires at turn 0.
///
/// `EntryHeal` is chosen because its effect is directly observable in state:
/// slot 1 sits at 50/500 and `denom: 4` heals `500 / 4 = 125` → 175 HP.
///
/// Kills: the pre-fix hardcoded `active: 0` (slot 1 would remain at 50 HP because
/// `apply_entry_ability` reads `abilities.side_a[0] == None` and returns early);
/// a `with_lead` that rotates the conscious monster to slot 0 (the ability store
/// is indexed by *team slot*, so a rotation reads the wrong ability entry and the
/// assertion on `team[1]` fails).
#[test]
fn entry_ability_fires_on_the_real_lead_not_on_the_corpse() {
    let corpse = make_monster(10, Affinity::Plant, 0, 30);
    // 50 / 500 HP — deliberately below max so the EntryHeal branch is taken
    // (`apply_entry_ability` skips the heal at full HP).
    let real_lead = make_monster(11, Affinity::Water, 50, 30);

    let side_a = BattleSide::with_lead(vec![corpse, real_lead])
        .expect("a party with a conscious slot 1 must produce a side");
    let side_b = BattleSide::with_lead(lone_opponent()).expect("the opponent is conscious");

    let mut state = BattleState {
        side_a,
        side_b,
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    assert_eq!(
        state.side_a.active, 1,
        "precondition: the real lead is slot 1, not the corpse in slot 0"
    );

    // Only slot 1 carries an ability. Slot 0 (the corpse) deliberately has none,
    // so a heal on slot 1 can only come from reading the CORRECT slot.
    let mut abilities = AbilityStore::new(2, 1);
    abilities.side_a[1] = Some(AbilityEffect::EntryHeal { denom: 4 });
    let mut status = BattleStatusStore::new(2, 1);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    // heal = (max_hp / denom).max(1) = (500 / 4).max(1) = 125 → 50 + 125 = 175.
    assert_eq!(
        state.side_a.team[1].current_hp, 175,
        "TEETH (ADR-0156 Consequences): the real lead (slot 1) must be healed \
         50 -> 175 by its own EntryHeal. Pre-fix `active` is 0, the ability store \
         lookup hits the corpse's empty slot, and slot 1 stays at 50."
    );
    assert_eq!(
        state.side_a.team[0].current_hp, 0,
        "TEETH: the 0 HP slot-0 monster must NOT be revived or healed by an \
         entry ability that does not belong to it"
    );
}

// ===========================================================================
// ADR-0156 D3 — the resolver is deliberately NOT hardened against a fainted actor
// ===========================================================================

/// ADR-0156 **D3**: a legacy state whose actives are BOTH fainted must
/// self-repair; it must never become a permanent fixpoint.
///
/// This test pins a deliberate decision that reads like an omission. The obvious
/// companion change to this slice — an early return at the top of
/// `resolve_one_attack` when the **acting** side's active is fainted — was
/// planned and **rejected**, because it deletes the only mechanism that repairs a
/// 0 HP active. A red-team pass ran the state below for **100 turns** under the
/// proposed guard: no `Damage`, no `Faint`, no `Switch`, no outcome change — only
/// `turn_number` advanced. The battle never terminates. In ranked PvP, where
/// `flee` is rejected and `is_in_ongoing_battle` locks both players out of every
/// other path, the only exit would degenerate to "whoever disconnects first takes
/// a rated loss."
///
/// Under the CURRENT (kept) behavior, each corpse's attack lands on the other
/// corpse, re-triggers the already-fainted defender branch, and both sides
/// auto-switch to a conscious backup within two turns.
///
/// Consequence, stated plainly and on purpose (ADR-0156 D3): a fainted active
/// **remains a valid target** for enemy attacks, DoT and weather chip.
///
/// Kills: any future "harden the pure resolver" change — an acting-side fainted
/// guard makes this loop run out its 5 turns with `active` still 0 on both sides.
#[test]
fn a_zero_hp_active_state_self_repairs_and_never_becomes_a_fixpoint() {
    let chart = make_type_chart();

    // The legacy row shape: raw literals with a hardcoded fainted active on BOTH
    // sides, each with a conscious backup. Built with `BattleSide { .. }` on
    // purpose — `with_lead` cannot produce this state, which is exactly why D2
    // guards the reducer boundary and D3 keeps the resolver's repair path.
    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![
                make_monster(10, Affinity::Plant, 0, 30),
                make_monster(11, Affinity::Water, 500, 30),
            ],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![
                make_monster(20, Affinity::Plant, 0, 25),
                make_monster(21, Affinity::Water, 500, 25),
            ],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    let mut status = BattleStatusStore::new(2, 2);
    let abilities = AbilityStore::new(2, 2);
    let sv = no_block_sv();
    let variance = always_hit_variance();
    let skills = skills_vec();

    const MAX_TURNS: u16 = 5;
    let mut turns_used = 0u16;
    for _ in 0..MAX_TURNS {
        if !state.side_a.active_monster().is_fainted()
            && !state.side_b.active_monster().is_fainted()
        {
            break;
        }
        turns_used += 1;
        let _ = resolve_full_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills,
            &chart,
            &variance,
            &mut status,
            &sv,
            &abilities,
        );
    }

    assert_eq!(
        state.side_a.active, 1,
        "TEETH (ADR-0156 D3): side A must self-repair to its conscious slot 1 \
         within {MAX_TURNS} turns (used {turns_used}). An acting-side fainted \
         guard in resolve_one_attack makes this state a NON-TERMINATING FIXPOINT \
         — verified 100 turns with zero progress."
    );
    assert_eq!(
        state.side_b.active, 1,
        "TEETH (ADR-0156 D3): side B must self-repair to its conscious slot 1 \
         within {MAX_TURNS} turns (used {turns_used})"
    );
    assert!(
        !state.side_a.active_monster().is_fainted() && !state.side_b.active_monster().is_fainted(),
        "TEETH (ADR-0156 D3): neither side may still have a fainted active after \
         self-repair"
    );
    assert_eq!(
        state.outcome,
        BattleOutcome::Ongoing,
        "fixture integrity: both sides kept a conscious backup, so no side is \
         wiped and the battle stays Ongoing — the repair is not achieved by \
         ending the battle"
    );
}

/// ADR-0156 D3 + ADR-0100 D6: attacking an already-0 HP active still emits
/// `Faint` and an immediately-adjacent `Switch`.
///
/// This is the atomic mechanism the self-repair test above depends on, pinned
/// on its own so a regression is attributed precisely. It also pins the
/// Faint→Switch **adjacency** invariant (ADR-0100 D6): the outer resolvers detect
/// KO auto-switches by scanning the event stream with `windows(2)` in
/// `apply_ko_switch_entry_abilities`, so inserting any event between the pair
/// silently stops entry abilities firing on the switched-in monster.
///
/// Kills: a **defender-side** fainted early-return in `resolve_one_attack` (no
/// `Faint`, no `Switch`, `active` stuck at 0); any change that emits an event
/// between `Faint` and `Switch` (breaks the `windows(2)` scan); an auto-switch
/// that picks the wrong slot.
///
/// Does NOT kill the **acting-side** guard that D3 rejects — verified: injecting
/// it leaves this test green, because the acting side here (side B) is conscious
/// so the guard never fires. `a_zero_hp_active_state_self_repairs_and_never_becomes_a_fixpoint`
/// is the only test that catches that one; the two are not redundant.
#[test]
fn fainted_defender_still_faints_and_auto_switches() {
    let chart = make_type_chart();

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: drew_party(),
        },
        side_b: BattleSide {
            active: 0,
            team: lone_opponent(),
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    let mut status = BattleStatusStore::new(2, 1);
    let abilities = AbilityStore::new(2, 1);
    let sv = no_block_sv();
    let variance = always_hit_variance();

    // Only side B acts, so the event stream contains exactly one attack's worth
    // of events and the adjacency assertion is unambiguous.
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Pass,
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    let faint_idx = events
        .iter()
        .position(|e| is_faint(e, SideId::SideA))
        .unwrap_or_else(|| {
            panic!(
                "TEETH (ADR-0156 D3): striking an already-0 HP active must emit \
                 `Faint {{ side: SideA }}` — this is the self-repair path for legacy \
                 rows. A fainted-actor early-return in resolve_one_attack deletes it. \
                 Events: {events:?}"
            )
        });

    assert_eq!(
        events.get(faint_idx + 1),
        Some(&BattleEvent::Switch {
            side: SideId::SideA,
            new_active: 1,
        }),
        "TEETH (ADR-0100 D6): `Switch {{ SideA, new_active: 1 }}` must be the \
         IMMEDIATE successor of `Faint {{ SideA }}` at index {faint_idx}. \
         apply_ko_switch_entry_abilities scans with windows(2); any event inserted \
         between the pair silently stops entry abilities firing on the switch-in. \
         Events: {events:?}"
    );

    assert_eq!(
        state.side_a.active, 1,
        "TEETH (ADR-0156 D3): the auto-switch must actually move `active` to the \
         conscious backup — this is what repairs a legacy 0 HP-active row"
    );
}
