//! bt-3 gating tests for `tactics::types` — BT3.1: the closed `QueuedAction` enum and the storage
//! enums (`TurnState`, `Phase`), serde-identical and with no defaulted field.
//!
//! Variant POSITIONS are pinned through serde's index deserializer (`U32Deserializer`): BSATN is
//! positional, so the declaration order is the wire format; a unit variant deserializes from its
//! index, a newtype variant refuses a bare index. Test names end in `_bt3_1`.

use serde::de::value::{Error as ValueError, U32Deserializer};
use serde::de::{DeserializeOwned, IntoDeserializer};
use serde::Serialize;

use crate::combat::types::BattleOutcome;

use super::geometry::Cell;
use super::types::{
    ActionKind, ActionTarget, ItemAction, MoveAction, Phase, QueuedAction, RecruitAction,
    SkillAction, TurnState, MAX_PLAN_ACTIONS, MAX_STORED_ENTRIES,
};

/// The variant at declaration index `i`, through serde's index deserializer.
fn by_index<T: DeserializeOwned>(i: u32) -> Result<T, ValueError> {
    let d: U32Deserializer<ValueError> = i.into_deserializer();
    T::deserialize(d)
}

/// serde_json round trip.
fn round_trip<T: Serialize + DeserializeOwned>(value: &T) -> T {
    let json = serde_json::to_string(value).expect("storage types serialize");
    serde_json::from_str(&json).expect("storage types deserialize what they serialize")
}

/// One of each of the six entry kinds, in declaration order.
fn all_six() -> [QueuedAction; 6] {
    [
        QueuedAction::Move(MoveAction {
            x: 3,
            y: 5,
            strides: 2,
        }),
        QueuedAction::Skill(SkillAction {
            skill_id: 10,
            target: ActionTarget::Unit(11),
        }),
        QueuedAction::Item(ItemAction {
            item_id: 501,
            target: ActionTarget::SelfTarget,
        }),
        QueuedAction::Recruit(RecruitAction {
            target: 11,
            bait: Some(502),
        }),
        QueuedAction::Flee,
        QueuedAction::EndTurn,
    ]
}

/// The declaration ordinal of an entry. Exhaustive: a seventh kind (or a removed one) is a
/// compile error here.
fn ordinal(a: &QueuedAction) -> usize {
    match a {
        QueuedAction::Move(_) => 0,
        QueuedAction::Skill(_) => 1,
        QueuedAction::Item(_) => 2,
        QueuedAction::Recruit(_) => 3,
        QueuedAction::Flee => 4,
        QueuedAction::EndTurn => 5,
    }
}

/// BT3.1: `QueuedAction` is exactly Move, Skill, Item, Recruit, Flee, EndTurn; `kind()` names
/// each; `is_action()` is false for EndTurn only.
/// Kills: a `kind()` that maps two variants to one kind; `is_action` true for EndTurn or false
/// for Flee/Recruit.
#[test]
fn queued_action_is_exactly_six_kinds_and_only_end_turn_is_not_an_action_bt3_1() {
    let six = all_six();
    let ordinals: Vec<usize> = six.iter().map(ordinal).collect();
    assert_eq!(ordinals, vec![0, 1, 2, 3, 4, 5]);
    let kinds: Vec<ActionKind> = six.iter().map(QueuedAction::kind).collect();
    assert_eq!(
        kinds,
        vec![
            ActionKind::Move,
            ActionKind::Skill,
            ActionKind::Item,
            ActionKind::Recruit,
            ActionKind::Flee,
            ActionKind::EndTurn,
        ]
    );
    let actions: Vec<bool> = six.iter().map(QueuedAction::is_action).collect();
    assert_eq!(actions, vec![true, true, true, true, true, false]);
}

/// BT3.1: `MoveAction::dest` is the bound tile `(x, y)` — never swapped, at the board corners too.
/// Kills: `Cell { x: y, y: x }`; a dest offset by the stride count.
#[test]
fn move_action_dest_is_its_bound_tile_bt3_1() {
    for (x, y, strides) in [
        (3u8, 5u8, 1u8),
        (0, 0, 2),
        (7, 0, 1),
        (0, 7, 2),
        (255, 254, 255),
    ] {
        assert_eq!(
            MoveAction { x, y, strides }.dest(),
            Cell { x, y },
            "Move to ({x}, {y}) with {strides} strides"
        );
    }
}

/// BT3.1: a deployed battle is `Active` while `Ongoing` and `Finished` once decided — every
/// decided outcome; `Deploying` is server-only and never the answer.
/// Kills: `Fled` read as still Active; `Ongoing` read as Deploying.
#[test]
fn phase_of_is_active_while_ongoing_and_finished_once_decided_bt3_1() {
    assert_eq!(Phase::of(BattleOutcome::Ongoing), Phase::Active);
    for decided in [
        BattleOutcome::SideAWins,
        BattleOutcome::SideBWins,
        BattleOutcome::Fled,
    ] {
        assert_eq!(Phase::of(decided), Phase::Finished, "{decided:?}");
    }
    // The stored positions: Deploying 0, Active 1, Finished 2 (nothing at 3).
    assert_eq!(by_index::<Phase>(0).ok(), Some(Phase::Deploying));
    assert_eq!(
        by_index::<Phase>(1).ok(),
        Some(Phase::of(BattleOutcome::Ongoing))
    );
    assert_eq!(
        by_index::<Phase>(2).ok(),
        Some(Phase::of(BattleOutcome::Fled))
    );
    assert!(
        by_index::<Phase>(3).is_err(),
        "Phase has exactly three variants"
    );
}

/// BT3.1: every storage type round-trips through serde identically — all six entries (with
/// hostile payload extremes), both targets, all three turn states, all three phases — and a
/// stored entry comes back with the same kind.
/// Kills: a lossy or renamed field; a skipped variant.
#[test]
fn storage_types_round_trip_through_json_identically_bt3_1() {
    let mut entries = all_six().to_vec();
    entries.push(QueuedAction::Move(MoveAction {
        x: 255,
        y: 255,
        strides: 255,
    }));
    entries.push(QueuedAction::Recruit(RecruitAction {
        target: u32::MAX,
        bait: None,
    }));
    entries.push(QueuedAction::Skill(SkillAction {
        skill_id: u32::MAX,
        target: ActionTarget::SelfTarget,
    }));
    entries.push(QueuedAction::Item(ItemAction {
        item_id: 0,
        target: ActionTarget::Unit(u32::MAX),
    }));
    for entry in &entries {
        let back = round_trip(entry);
        assert_eq!(&back, entry);
        assert_eq!(back.kind(), entry.kind(), "{entry:?}");
    }
    for target in [ActionTarget::Unit(7), ActionTarget::SelfTarget] {
        assert_eq!(round_trip(&target), target);
    }
    for ts in [
        TurnState::NotActive,
        TurnState::Waiting(0),
        TurnState::Waiting(u32::MAX),
        TurnState::Advancing,
    ] {
        assert_eq!(round_trip(&ts), ts);
    }
    for outcome in [BattleOutcome::Ongoing, BattleOutcome::SideBWins] {
        let phase = Phase::of(outcome);
        assert_eq!(round_trip(&phase), phase);
    }
    assert_eq!(round_trip(&Phase::Deploying), Phase::Deploying);
}

/// BT3.1: no `serde(default)` compatibility assumption — a `MoveAction` missing `strides`, a
/// `SkillAction` or `ItemAction` missing its `target`, is refused, never defaulted; the full
/// shape deserializes to the bound tile.
/// Kills: `#[serde(default)]` on any field of the wire types.
#[test]
fn storage_payloads_have_no_defaulted_field_bt3_1() {
    assert!(serde_json::from_str::<MoveAction>(r#"{"x":1,"y":2}"#).is_err());
    assert!(serde_json::from_str::<MoveAction>(r#"{"x":1,"strides":1}"#).is_err());
    assert!(serde_json::from_str::<SkillAction>(r#"{"skill_id":10}"#).is_err());
    assert!(serde_json::from_str::<ItemAction>(r#"{"item_id":501}"#).is_err());
    let full: MoveAction =
        serde_json::from_str(r#"{"x":1,"y":2,"strides":1}"#).expect("the full shape");
    assert_eq!(full.dest(), Cell { x: 1, y: 2 });
    assert_eq!(full.strides, 1);
}

/// BT3.1: a full plan is `MAX_PLAN_ACTIONS` (3) actions plus the trailing EndTurn, so a stored
/// plan holds at most `MAX_STORED_ENTRIES` (4).
/// Kills: a cap of 4 actions; a stored-entry cap that forgets the EndTurn.
#[test]
fn a_full_plan_is_three_actions_plus_the_end_turn_bt3_1() {
    assert_eq!(MAX_PLAN_ACTIONS, 3);
    assert_eq!(MAX_STORED_ENTRIES, 4);
    let six = all_six();
    let full = [six[0], six[1], six[2], QueuedAction::EndTurn];
    assert_eq!(full.len(), MAX_STORED_ENTRIES);
    assert_eq!(
        full.iter().filter(|e| e.is_action()).count(),
        MAX_PLAN_ACTIONS
    );
}

/// BT3.1: the stored positions — `QueuedAction` holds Flee at 4 and EndTurn at 5 (0..=3 are the
/// payload variants, nothing at 6); `TurnState` NotActive 0, Waiting 1 (payload), Advancing 2;
/// `ActionKind` mirrors `QueuedAction`'s order, so a kind and its entry share an index.
/// Kills: a reordered or inserted variant (BSATN is positional).
#[test]
fn the_unit_variants_sit_at_their_spec_positions_bt3_1() {
    assert_eq!(by_index::<QueuedAction>(4).ok(), Some(QueuedAction::Flee));
    assert_eq!(
        by_index::<QueuedAction>(5).ok(),
        Some(QueuedAction::EndTurn)
    );
    for payload in 0..=3u32 {
        assert!(
            by_index::<QueuedAction>(payload).is_err(),
            "index {payload} is a payload variant"
        );
    }
    assert!(by_index::<QueuedAction>(6).is_err(), "exactly six variants");

    assert_eq!(by_index::<TurnState>(0).ok(), Some(TurnState::NotActive));
    assert!(
        by_index::<TurnState>(1).is_err(),
        "Waiting carries the unit"
    );
    assert_eq!(by_index::<TurnState>(2).ok(), Some(TurnState::Advancing));
    assert!(by_index::<TurnState>(3).is_err(), "exactly three variants");

    for (i, entry) in all_six().iter().enumerate() {
        let i = u32::try_from(i).expect("six fits");
        assert_eq!(
            by_index::<ActionKind>(i).ok(),
            Some(entry.kind()),
            "ActionKind at {i}"
        );
    }
    assert!(by_index::<ActionKind>(6).is_err());
}
