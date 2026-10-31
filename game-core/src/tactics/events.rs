//! The `battle_event` payload — design §8.1 / §6.3: what the executor emits, ONLY at execution.
//!
//! [`EventPayload`] is the BSATN storage enum (gated `SpacetimeType`, append-only — the variant
//! order is the design's list, then bt-3's additions). [`payload_of`] maps every rule event
//! (`resolve::TacticalEvent`) onto it exhaustively, so a new rule event is a compile error here
//! until it has a storage shape. A halted plan's discarded tail never produces an event: only
//! `PlanHalted{unit, idx, reason_kind}` does, and `HaltKind` carries no payload that could leak
//! the unexecuted entries.
//!
//! [`presentation_cap_ms`] is design §9.4's constitution (400 ms per action, 100 ms per tile up to
//! 400, 1 000 ms per upkeep batch, 2 000 ms battle start, 3 000 ms results). The server's clock pad
//! is the deterministic sum of these caps (§2.3), so they live here, once, for both the server and
//! the client's playback.

use serde::{Deserialize, Serialize};

use crate::combat::types::{BattleOutcome, Effectiveness, StatusEffect};

use super::outcome::{Adjudication, BattleEndHow};
use super::resolve::{TacticalEvent, TargetResult};

/// Per-action playback cap (§9.4).
pub const ACTION_CAP_MS: u32 = 400;
/// Per-tile movement cap (§9.4).
pub const TILE_CAP_MS: u32 = 100;
/// Movement cap ceiling (§9.4).
pub const MOVE_CAP_MS: u32 = 400;
/// The end-of-round upkeep batch (§9.4).
pub const UPKEEP_CAP_MS: u32 = 1_000;
/// Battle start (§9.4).
pub const BATTLE_START_CAP_MS: u32 = 2_000;
/// Results screen (§9.4).
pub const RESULTS_CAP_MS: u32 = 3_000;

/// The storage mirror of `combat::types::Effectiveness`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum HitEffectiveness {
    Immune,
    NotVeryEffective,
    Neutral,
    SuperEffective,
}

/// One target of an `Executed` attack: `Executed{per-target dmg, hit, flank, guard}`.
/// A miss has `hit false`, `damage 0`, `effectiveness None`, every flag false.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct TargetHit {
    pub unit: u32,
    pub hit: bool,
    pub damage: u16,
    pub effectiveness: Option<HitEffectiveness>,
    pub flank: bool,
    pub guard: bool,
    pub ko: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct ExecutedEvent {
    pub attacker: u32,
    pub skill_id: u32,
    pub results: Vec<TargetHit>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct MissedEvent {
    pub attacker: u32,
    pub target: u32,
}

/// Why an entry failed at pop — the coarse, payload-free kind stored in `PlanHalted`
/// (`queue::HaltReason::kind`). Append-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum HaltKind {
    CannotAct,
    BadShape,
    UnknownSkill,
    TargetGone,
    Unreachable,
    TooFar,
    Geometry,
    NotAdjacent,
    NotWild,
    NotAllowed,
    NoHeadroom,
    ItemNotHeld,
    Unaffordable,
    /// A unit row or tuning the rules cannot run on (the bt-2 hostile-state guards).
    BadState,
}

/// `PlanHalted{unit, idx, reason_kind}`: entry `idx` (0-based) and everything after it was wasted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct PlanHaltedEvent {
    pub unit: u32,
    pub idx: u8,
    pub reason_kind: HaltKind,
}

/// A READY plan was deleted without executing (KO, recruit, battle end, turn-skip status).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct QueueVoidedEvent {
    pub unit: u32,
}

/// A PvP window expired: the unit's turn ended uncommitted (no Guard); `strike` is the owner's
/// running auto-pass count (the 4th forfeits).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct AutoPassEvent {
    pub unit: u32,
    pub strike: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct StoodGroundEvent {
    pub unit: u32,
}

/// What happened to a status: applied by an attack, ticked in upkeep (`amount` HP), cured, or it
/// `Blocked` the unit's turn at TurnStart (Sleep/Freeze always, Paralysis on its roll).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum StatusChange {
    Applied,
    Tick,
    Cured,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct StatusEvent {
    pub unit: u32,
    pub status: StatusEffect,
    pub change: StatusChange,
    /// Tick damage; 0 for every other change.
    pub amount: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct SurgeEvent {
    pub round: u16,
    pub unit: u32,
    pub amount: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct KoEvent {
    pub unit: u32,
}

/// Emitted by bt-5's recruit rule (through `queue::Hooks::resolve_delegated`): shown == rolled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct RecruitResultEvent {
    pub unit: u32,
    pub target: u32,
    pub success: bool,
    pub pct: u8,
}

/// Emitted by bt-5's reward ledger (through `queue::Hooks::resolve_delegated`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct AwardsEvent {
    pub unit: u32,
    pub xp: u32,
    pub essence: u32,
    pub currency: u64,
}

/// A Move executed: the unit walked `tiles` tiles from `(from_x, from_y)` to `(to_x, to_y)` along
/// the cheapest path (the client re-derives the path with the same `find_path`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct MovedEvent {
    pub unit: u32,
    pub from_x: u8,
    pub from_y: u8,
    pub to_x: u8,
    pub to_y: u8,
    pub tiles: u8,
}

/// An Item entry executed (the debit happened in the same transaction).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct ItemUsedEvent {
    pub unit: u32,
    pub item_id: u32,
    pub target: u32,
}

/// A unit-turn ended: whether Guard was granted and whether the end was committed (design §2.1.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct TurnEndedEvent {
    pub unit: u32,
    pub guard: bool,
    pub committed: bool,
}

/// The end-of-round upkeep for `round` ran (the §9.4 upkeep batch).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct RoundEndedEvent {
    pub round: u16,
}

/// The battle left `NotActive` for its first round.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct BattleStartedEvent {
    pub round: u16,
}

/// How a battle ended — `outcome::BattleEndHow` flattened for storage, plus the two ends only the
/// turn machine produces (`Forfeit` on the 4th PvP auto-pass, `Fled`/`AutoFlee` through the flee rule).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum EndHow {
    SideEmpty,
    AdjudicatedHpPercent,
    AdjudicatedConscious,
    AdjudicatedDamageDealt,
    AdjudicatedCoin,
    FixedOrder,
    RoundCap,
    Forfeit,
    Fled,
    AutoFlee,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct BattleEndEvent {
    pub outcome: BattleOutcome,
    pub how: EndHow,
}

/// The `battle_event.payload` enum. Order: the design's list (§8.1), then bt-3's additions.
/// Append-only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum EventPayload {
    Executed(ExecutedEvent),
    Missed(MissedEvent),
    PlanHalted(PlanHaltedEvent),
    QueueVoided(QueueVoidedEvent),
    AutoPass(AutoPassEvent),
    StoodGround(StoodGroundEvent),
    Status(StatusEvent),
    Surge(SurgeEvent),
    Ko(KoEvent),
    RecruitResult(RecruitResultEvent),
    Awards(AwardsEvent),
    Moved(MovedEvent),
    ItemUsed(ItemUsedEvent),
    TurnEnded(TurnEndedEvent),
    RoundEnded(RoundEndedEvent),
    BattleStarted(BattleStartedEvent),
    BattleEnd(BattleEndEvent),
}

/// The storage payload of a rule event. Exhaustive: `StatusApplied`/`StatusTick`/`StatusCured`
/// become `Status{Applied|Tick|Cured}` (`amount` = the tick's damage, else 0); `BattleEnd`'s
/// `how` flattens `Adjudicated(which)` into the four `Adjudicated*` kinds.
#[must_use]
pub fn payload_of(event: &TacticalEvent) -> EventPayload {
    match event {
        TacticalEvent::Executed {
            attacker,
            skill_id,
            results,
        } => EventPayload::Executed(ExecutedEvent {
            attacker: *attacker,
            skill_id: *skill_id,
            results: results.iter().map(target_hit_of).collect(),
        }),
        TacticalEvent::Missed { attacker, target } => EventPayload::Missed(MissedEvent {
            attacker: *attacker,
            target: *target,
        }),
        TacticalEvent::StoodGround { unit } => {
            EventPayload::StoodGround(StoodGroundEvent { unit: *unit })
        }
        TacticalEvent::StatusApplied { unit, status } => EventPayload::Status(StatusEvent {
            unit: *unit,
            status: *status,
            change: StatusChange::Applied,
            amount: 0,
        }),
        TacticalEvent::StatusTick {
            unit,
            status,
            amount,
        } => EventPayload::Status(StatusEvent {
            unit: *unit,
            status: *status,
            change: StatusChange::Tick,
            amount: *amount,
        }),
        TacticalEvent::StatusCured { unit, status } => EventPayload::Status(StatusEvent {
            unit: *unit,
            status: *status,
            change: StatusChange::Cured,
            amount: 0,
        }),
        TacticalEvent::Surge {
            round,
            unit,
            amount,
        } => EventPayload::Surge(SurgeEvent {
            round: *round,
            unit: *unit,
            amount: *amount,
        }),
        TacticalEvent::Ko { unit } => EventPayload::Ko(KoEvent { unit: *unit }),
        TacticalEvent::QueueVoided { unit } => {
            EventPayload::QueueVoided(QueueVoidedEvent { unit: *unit })
        }
        TacticalEvent::BattleEnd { outcome, how } => EventPayload::BattleEnd(BattleEndEvent {
            outcome: *outcome,
            how: end_how_of(*how),
        }),
    }
}

/// The storage shape of one target's result.
fn target_hit_of(r: &TargetResult) -> TargetHit {
    TargetHit {
        unit: r.unit,
        hit: r.hit,
        damage: r.damage,
        effectiveness: r.effectiveness.map(hit_effectiveness_of),
        flank: r.flank,
        guard: r.guard,
        ko: r.ko,
    }
}

/// `combat::types::Effectiveness` → its storage mirror.
fn hit_effectiveness_of(e: Effectiveness) -> HitEffectiveness {
    match e {
        Effectiveness::Immune => HitEffectiveness::Immune,
        Effectiveness::NotVeryEffective => HitEffectiveness::NotVeryEffective,
        Effectiveness::Neutral => HitEffectiveness::Neutral,
        Effectiveness::SuperEffective => HitEffectiveness::SuperEffective,
    }
}

/// `outcome::BattleEndHow` flattened for storage.
fn end_how_of(how: BattleEndHow) -> EndHow {
    match how {
        BattleEndHow::SideEmpty => EndHow::SideEmpty,
        BattleEndHow::Adjudicated(Adjudication::HpPercent) => EndHow::AdjudicatedHpPercent,
        BattleEndHow::Adjudicated(Adjudication::Conscious) => EndHow::AdjudicatedConscious,
        BattleEndHow::Adjudicated(Adjudication::DamageDealt) => EndHow::AdjudicatedDamageDealt,
        BattleEndHow::Adjudicated(Adjudication::Coin) => EndHow::AdjudicatedCoin,
        BattleEndHow::FixedOrder => EndHow::FixedOrder,
        BattleEndHow::RoundCap => EndHow::RoundCap,
    }
}

/// Design §9.4: the playback cap of one event — `Executed`, `ItemUsed`, `RecruitResult` 400 ms;
/// `Moved` `min(100 × tiles, 400)`; `RoundEnded` 1 000; `BattleStarted` 2 000; `BattleEnd` 3 000;
/// every per-target or bookkeeping event (`Missed`, `PlanHalted`, `QueueVoided`, `AutoPass`,
/// `StoodGround`, `Status`, `Surge`, `Ko`, `Awards`, `TurnEnded`) 0 — it rides its action's or
/// batch's cap.
#[must_use]
pub fn presentation_cap_ms(event: &EventPayload) -> u32 {
    match event {
        EventPayload::Executed(_) | EventPayload::ItemUsed(_) | EventPayload::RecruitResult(_) => {
            ACTION_CAP_MS
        }
        EventPayload::Moved(m) => (TILE_CAP_MS * u32::from(m.tiles)).min(MOVE_CAP_MS),
        EventPayload::RoundEnded(_) => UPKEEP_CAP_MS,
        EventPayload::BattleStarted(_) => BATTLE_START_CAP_MS,
        EventPayload::BattleEnd(_) => RESULTS_CAP_MS,
        EventPayload::Missed(_)
        | EventPayload::PlanHalted(_)
        | EventPayload::QueueVoided(_)
        | EventPayload::AutoPass(_)
        | EventPayload::StoodGround(_)
        | EventPayload::Status(_)
        | EventPayload::Surge(_)
        | EventPayload::Ko(_)
        | EventPayload::Awards(_)
        | EventPayload::TurnEnded(_) => 0,
    }
}
