//! bt-3 gating tests for `tactics::events` — BT3.10: `payload_of` maps every rule event onto the
//! `battle_event` storage payload exactly, `presentation_cap_ms` is design §9.4's constitution,
//! and the payload enum is exactly the seventeen kinds of the spec's list. Variant positions of
//! the unit-only storage enums are pinned through serde's index deserializer (BSATN is
//! positional). Test names end in `_bt3_10`.

use serde::de::value::{Error as ValueError, U32Deserializer};
use serde::de::{DeserializeOwned, IntoDeserializer};

use crate::combat::types::{BattleOutcome, Effectiveness, StatusEffect};

use super::events::{
    payload_of, presentation_cap_ms, AutoPassEvent, AwardsEvent, BattleEndEvent,
    BattleStartedEvent, EndHow, EventPayload, ExecutedEvent, HaltKind, HitEffectiveness,
    ItemUsedEvent, KoEvent, MissedEvent, MovedEvent, PlanHaltedEvent, QueueVoidedEvent,
    RecruitResultEvent, RoundEndedEvent, StatusChange, StatusEvent, StoodGroundEvent, SurgeEvent,
    TargetHit, TurnEndedEvent, ACTION_CAP_MS, BATTLE_START_CAP_MS, MOVE_CAP_MS, RESULTS_CAP_MS,
    TILE_CAP_MS, UPKEEP_CAP_MS,
};
use super::outcome::{Adjudication, BattleEndHow};
use super::resolve::{TacticalEvent, TargetResult};

fn by_index<T: DeserializeOwned>(i: u32) -> Result<T, ValueError> {
    let d: U32Deserializer<ValueError> = i.into_deserializer();
    T::deserialize(d)
}

fn moved(tiles: u8) -> EventPayload {
    EventPayload::Moved(MovedEvent {
        unit: 1,
        from_x: 0,
        from_y: 0,
        to_x: 1,
        to_y: 0,
        tiles,
    })
}

/// One sample of each of the seventeen payload kinds, in the spec's order.
fn samples() -> Vec<EventPayload> {
    vec![
        EventPayload::Executed(ExecutedEvent {
            attacker: 1,
            skill_id: 10,
            results: vec![TargetHit {
                unit: 11,
                hit: true,
                damage: 9,
                effectiveness: Some(HitEffectiveness::Neutral),
                flank: true,
                guard: false,
                ko: false,
            }],
        }),
        EventPayload::Missed(MissedEvent {
            attacker: 1,
            target: 11,
        }),
        EventPayload::PlanHalted(PlanHaltedEvent {
            unit: 1,
            idx: 2,
            reason_kind: HaltKind::Geometry,
        }),
        EventPayload::QueueVoided(QueueVoidedEvent { unit: 2 }),
        EventPayload::AutoPass(AutoPassEvent { unit: 1, strike: 3 }),
        EventPayload::StoodGround(StoodGroundEvent { unit: 11 }),
        EventPayload::Status(StatusEvent {
            unit: 11,
            status: StatusEffect::Sleep { turns_remaining: 2 },
            change: StatusChange::Blocked,
            amount: 0,
        }),
        EventPayload::Surge(SurgeEvent {
            round: 9,
            unit: 1,
            amount: 5,
        }),
        EventPayload::Ko(KoEvent { unit: 11 }),
        EventPayload::RecruitResult(RecruitResultEvent {
            unit: 1,
            target: 11,
            success: true,
            pct: 37,
        }),
        EventPayload::Awards(AwardsEvent {
            unit: 1,
            xp: 120,
            essence: 4,
            currency: u64::MAX,
        }),
        moved(3),
        EventPayload::ItemUsed(ItemUsedEvent {
            unit: 1,
            item_id: 501,
            target: 2,
        }),
        EventPayload::TurnEnded(TurnEndedEvent {
            unit: 1,
            guard: true,
            committed: true,
        }),
        EventPayload::RoundEnded(RoundEndedEvent { round: 4 }),
        EventPayload::BattleStarted(BattleStartedEvent { round: 1 }),
        EventPayload::BattleEnd(BattleEndEvent {
            outcome: BattleOutcome::SideAWins,
            how: EndHow::Forfeit,
        }),
    ]
}

/// The spec ordinal of a payload. Exhaustive: an eighteenth kind, or a missing one, is a compile
/// error here.
fn ordinal(p: &EventPayload) -> usize {
    match p {
        EventPayload::Executed(_) => 0,
        EventPayload::Missed(_) => 1,
        EventPayload::PlanHalted(_) => 2,
        EventPayload::QueueVoided(_) => 3,
        EventPayload::AutoPass(_) => 4,
        EventPayload::StoodGround(_) => 5,
        EventPayload::Status(_) => 6,
        EventPayload::Surge(_) => 7,
        EventPayload::Ko(_) => 8,
        EventPayload::RecruitResult(_) => 9,
        EventPayload::Awards(_) => 10,
        EventPayload::Moved(_) => 11,
        EventPayload::ItemUsed(_) => 12,
        EventPayload::TurnEnded(_) => 13,
        EventPayload::RoundEnded(_) => 14,
        EventPayload::BattleStarted(_) => 15,
        EventPayload::BattleEnd(_) => 16,
    }
}

/// BT3.10: `Executed` maps per target — unit, hit, damage, flank, guard, ko and the
/// effectiveness mirror (all four buckets) — and a miss keeps `effectiveness: None`; the
/// attacker and skill id carry over and the target order is kept.
/// Kills: effectiveness buckets crossed; a miss given an effectiveness; flags dropped; results
/// re-sorted.
#[test]
fn payload_of_maps_executed_per_target_with_its_effectiveness_bt3_10() {
    let result = |unit: u32, effectiveness: Option<Effectiveness>| TargetResult {
        unit,
        hit: effectiveness.is_some(),
        damage: if effectiveness.is_some() { 7 } else { 0 },
        effectiveness,
        flank: unit == 13,
        guard: unit == 14,
        ko: unit == 12,
    };
    let event = TacticalEvent::Executed {
        attacker: 3,
        skill_id: 77,
        results: vec![
            result(15, Some(Effectiveness::SuperEffective)),
            result(12, Some(Effectiveness::Immune)),
            result(13, Some(Effectiveness::NotVeryEffective)),
            result(14, Some(Effectiveness::Neutral)),
            result(11, None),
        ],
    };
    let hit = |unit: u32, effectiveness: Option<HitEffectiveness>| TargetHit {
        unit,
        hit: effectiveness.is_some(),
        damage: if effectiveness.is_some() { 7 } else { 0 },
        effectiveness,
        flank: unit == 13,
        guard: unit == 14,
        ko: unit == 12,
    };
    assert_eq!(
        payload_of(&event),
        EventPayload::Executed(ExecutedEvent {
            attacker: 3,
            skill_id: 77,
            results: vec![
                hit(15, Some(HitEffectiveness::SuperEffective)),
                hit(12, Some(HitEffectiveness::Immune)),
                hit(13, Some(HitEffectiveness::NotVeryEffective)),
                hit(14, Some(HitEffectiveness::Neutral)),
                hit(11, None),
            ],
        })
    );
    assert_eq!(
        payload_of(&TacticalEvent::Executed {
            attacker: 1,
            skill_id: 50,
            results: vec![],
        }),
        EventPayload::Executed(ExecutedEvent {
            attacker: 1,
            skill_id: 50,
            results: vec![],
        }),
        "an empty target set stays empty"
    );
    // HitEffectiveness positions mirror Effectiveness: Immune, NVE, Neutral, SE.
    let order = [
        HitEffectiveness::Immune,
        HitEffectiveness::NotVeryEffective,
        HitEffectiveness::Neutral,
        HitEffectiveness::SuperEffective,
    ];
    for (i, want) in order.iter().enumerate() {
        let i = u32::try_from(i).expect("small");
        assert_eq!(by_index::<HitEffectiveness>(i).ok(), Some(*want));
    }
    assert!(by_index::<HitEffectiveness>(4).is_err());
}

/// BT3.10: StatusApplied / StatusTick / StatusCured become `Status{Applied | Tick | Cured}` with
/// the status carried and `amount` = the tick's damage (0 otherwise).
/// Kills: the three kinds collapsed; the tick amount dropped or put on Applied; Sleep's turns lost.
#[test]
fn payload_of_maps_status_applied_tick_and_cured_bt3_10() {
    assert_eq!(
        payload_of(&TacticalEvent::StatusApplied {
            unit: 4,
            status: StatusEffect::Burn,
        }),
        EventPayload::Status(StatusEvent {
            unit: 4,
            status: StatusEffect::Burn,
            change: StatusChange::Applied,
            amount: 0,
        })
    );
    assert_eq!(
        payload_of(&TacticalEvent::StatusTick {
            unit: 5,
            status: StatusEffect::Poison,
            amount: 12,
        }),
        EventPayload::Status(StatusEvent {
            unit: 5,
            status: StatusEffect::Poison,
            change: StatusChange::Tick,
            amount: 12,
        })
    );
    assert_eq!(
        payload_of(&TacticalEvent::StatusCured {
            unit: 6,
            status: StatusEffect::Sleep { turns_remaining: 2 },
        }),
        EventPayload::Status(StatusEvent {
            unit: 6,
            status: StatusEffect::Sleep { turns_remaining: 2 },
            change: StatusChange::Cured,
            amount: 0,
        })
    );
    let order = [
        StatusChange::Applied,
        StatusChange::Tick,
        StatusChange::Cured,
        StatusChange::Blocked,
    ];
    for (i, want) in order.iter().enumerate() {
        let i = u32::try_from(i).expect("small");
        assert_eq!(by_index::<StatusChange>(i).ok(), Some(*want));
    }
    assert!(by_index::<StatusChange>(4).is_err());
}

/// BT3.10: `BattleEnd` keeps its outcome and flattens `how` — SideEmpty, the four
/// `Adjudicated(..)` kinds, FixedOrder, RoundCap — onto `EndHow`; `EndHow`'s positions are the
/// spec's (the three machine-only ends after the bt-2 ones).
/// Kills: two adjudication kinds crossed; the outcome rewritten; FixedOrder ↔ RoundCap.
#[test]
fn payload_of_maps_every_battle_end_how_bt3_10() {
    let cases = [
        (
            BattleOutcome::SideAWins,
            BattleEndHow::SideEmpty,
            EndHow::SideEmpty,
        ),
        (
            BattleOutcome::SideBWins,
            BattleEndHow::Adjudicated(Adjudication::HpPercent),
            EndHow::AdjudicatedHpPercent,
        ),
        (
            BattleOutcome::SideAWins,
            BattleEndHow::Adjudicated(Adjudication::Conscious),
            EndHow::AdjudicatedConscious,
        ),
        (
            BattleOutcome::SideBWins,
            BattleEndHow::Adjudicated(Adjudication::DamageDealt),
            EndHow::AdjudicatedDamageDealt,
        ),
        (
            BattleOutcome::SideAWins,
            BattleEndHow::Adjudicated(Adjudication::Coin),
            EndHow::AdjudicatedCoin,
        ),
        (
            BattleOutcome::SideBWins,
            BattleEndHow::FixedOrder,
            EndHow::FixedOrder,
        ),
        (
            BattleOutcome::Fled,
            BattleEndHow::RoundCap,
            EndHow::RoundCap,
        ),
    ];
    for (outcome, how, want) in cases {
        assert_eq!(
            payload_of(&TacticalEvent::BattleEnd { outcome, how }),
            EventPayload::BattleEnd(BattleEndEvent { outcome, how: want }),
            "{how:?}"
        );
    }
    let order = [
        EndHow::SideEmpty,
        EndHow::AdjudicatedHpPercent,
        EndHow::AdjudicatedConscious,
        EndHow::AdjudicatedDamageDealt,
        EndHow::AdjudicatedCoin,
        EndHow::FixedOrder,
        EndHow::RoundCap,
        EndHow::Forfeit,
        EndHow::Fled,
        EndHow::AutoFlee,
    ];
    for (i, want) in order.iter().enumerate() {
        let i = u32::try_from(i).expect("small");
        assert_eq!(by_index::<EndHow>(i).ok(), Some(*want), "EndHow at {i}");
    }
    assert!(by_index::<EndHow>(10).is_err());
}

/// BT3.10: Missed, StoodGround, Surge, Ko and QueueVoided map one-to-one with every field.
/// Kills: attacker/target swapped on Missed; Surge's round dropped; Ko ↔ QueueVoided.
#[test]
fn payload_of_maps_the_bookkeeping_events_one_to_one_bt3_10() {
    let cases = [
        (
            TacticalEvent::Missed {
                attacker: 2,
                target: 13,
            },
            EventPayload::Missed(MissedEvent {
                attacker: 2,
                target: 13,
            }),
        ),
        (
            TacticalEvent::StoodGround { unit: 14 },
            EventPayload::StoodGround(StoodGroundEvent { unit: 14 }),
        ),
        (
            TacticalEvent::Surge {
                round: 12,
                unit: 3,
                amount: 20,
            },
            EventPayload::Surge(SurgeEvent {
                round: 12,
                unit: 3,
                amount: 20,
            }),
        ),
        (
            TacticalEvent::Ko { unit: 15 },
            EventPayload::Ko(KoEvent { unit: 15 }),
        ),
        (
            TacticalEvent::QueueVoided { unit: 16 },
            EventPayload::QueueVoided(QueueVoidedEvent { unit: 16 }),
        ),
    ];
    for (event, want) in cases {
        assert_eq!(payload_of(&event), want, "{event:?}");
    }
}

/// BT3.10 / design §9.4: Executed, ItemUsed and RecruitResult cap at 400 ms; RoundEnded 1 000;
/// BattleStarted 2 000; BattleEnd 3 000; every per-target or bookkeeping kind 0; the named
/// constants carry the design's numbers.
/// Kills: a bookkeeping event padding the clock; the upkeep / start / results caps crossed.
#[test]
fn presentation_caps_follow_the_constitution_bt3_10() {
    assert_eq!(
        (
            ACTION_CAP_MS,
            TILE_CAP_MS,
            MOVE_CAP_MS,
            UPKEEP_CAP_MS,
            BATTLE_START_CAP_MS,
            RESULTS_CAP_MS
        ),
        (400, 100, 400, 1_000, 2_000, 3_000)
    );
    let want: [u32; 17] = [
        400,   // Executed
        0,     // Missed
        0,     // PlanHalted
        0,     // QueueVoided
        0,     // AutoPass
        0,     // StoodGround
        0,     // Status
        0,     // Surge
        0,     // Ko
        400,   // RecruitResult
        0,     // Awards
        300,   // Moved, 3 tiles
        400,   // ItemUsed
        0,     // TurnEnded
        1_000, // RoundEnded
        2_000, // BattleStarted
        3_000, // BattleEnd
    ];
    let got: Vec<u32> = samples().iter().map(presentation_cap_ms).collect();
    assert_eq!(got, want.to_vec());
}

/// BT3.10 / §9.4: a Move caps at 100 ms per tile up to 400 — 0 tiles 0, 1 → 100, 2 → 200,
/// 4 → 400, 7 → 400, 255 → 400.
/// Kills: no ceiling; the ceiling applied as a floor; a per-tile cap other than 100.
#[test]
fn a_moves_cap_is_one_hundred_per_tile_up_to_four_hundred_bt3_10() {
    for (tiles, cap) in [
        (0u8, 0u32),
        (1, 100),
        (2, 200),
        (3, 300),
        (4, 400),
        (5, 400),
        (7, 400),
        (255, 400),
    ] {
        assert_eq!(presentation_cap_ms(&moved(tiles)), cap, "{tiles} tiles");
    }
}

/// BT3.10: the payload enum is exactly the seventeen kinds of the spec's list in its order
/// (Executed … BattleEnd); the bookkeeping kinds an action rides on cost no pad of their own.
/// Kills: a kind dropped or duplicated; a sample set out of the spec order.
#[test]
fn event_payload_is_exactly_the_seventeen_spec_kinds_bt3_10() {
    let all = samples();
    assert_eq!(all.len(), 17);
    let ordinals: Vec<usize> = all.iter().map(ordinal).collect();
    assert_eq!(ordinals, (0..17).collect::<Vec<usize>>());
    let padded: Vec<usize> = all
        .iter()
        .filter(|p| presentation_cap_ms(p) > 0)
        .map(ordinal)
        .collect();
    assert_eq!(padded, vec![0, 9, 11, 12, 14, 15, 16]);
}

/// BT3.10: every payload — the seventeen samples and the `payload_of` image of every rule-event
/// kind — round-trips through serde identically (the client decodes what the server stores).
/// Kills: a lossy field on any payload struct.
#[test]
fn every_payload_round_trips_through_serde_bt3_10() {
    let mut all = samples();
    for event in [
        TacticalEvent::Executed {
            attacker: 1,
            skill_id: 10,
            results: vec![TargetResult {
                unit: 11,
                hit: false,
                damage: 0,
                effectiveness: None,
                flank: false,
                guard: false,
                ko: false,
            }],
        },
        TacticalEvent::Missed {
            attacker: 1,
            target: 11,
        },
        TacticalEvent::StoodGround { unit: 11 },
        TacticalEvent::StatusApplied {
            unit: 11,
            status: StatusEffect::Paralysis,
        },
        TacticalEvent::StatusTick {
            unit: 11,
            status: StatusEffect::Burn,
            amount: 6,
        },
        TacticalEvent::StatusCured {
            unit: 11,
            status: StatusEffect::Freeze,
        },
        TacticalEvent::Surge {
            round: 10,
            unit: 1,
            amount: 10,
        },
        TacticalEvent::Ko { unit: 11 },
        TacticalEvent::QueueVoided { unit: 2 },
        TacticalEvent::BattleEnd {
            outcome: BattleOutcome::SideBWins,
            how: BattleEndHow::Adjudicated(Adjudication::Coin),
        },
    ] {
        all.push(payload_of(&event));
    }
    assert_eq!(all.len(), 27);
    for p in &all {
        let json = serde_json::to_string(p).expect("serializes");
        let back: EventPayload = serde_json::from_str(&json).expect("deserializes");
        assert_eq!(&back, p);
    }
}
