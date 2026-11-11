//! World interaction rules: which entities the interact button acts on
//! ([`interact_candidates`]) and how far apart two characters may be for the
//! server to accept an interaction between them ([`within_interact_range`]).
//!
//! The target rule is "the tile in front, then your own tile": the first non-empty
//! tier wins, and nothing else is a candidate (no nearest-within-range, no facing
//! ray). The server's `TALK_RANGE` is a latency margin, not a reach, so the target
//! rule is deliberately narrower than the range the server accepts.

use crate::npc::rules::in_talk_range;
use crate::types::{Direction, TilePos};

/// What an interactable is. Declaration order IS the within-tile priority
/// (NPC before heal location before player), via the derived `Ord`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum InteractKind {
    Npc,
    Heal,
    Player,
}

/// One interactable as the rule sees it: an NPC at its character-row position, a
/// heal location's tile, or another player's character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InteractEntity {
    pub kind: InteractKind,
    pub pos: TilePos,
    pub zone: u32,
    /// Numeric id (the NPC's or player's character `entity_id`, a heal location's
    /// `location_id`); the tie-break after `kind` within one tile.
    pub id: u64,
}

/// Indices into `entities` that the character at `pos`, facing `facing`, in
/// `zone` can interact with: the same-zone entities on the faced tile
/// (`pos.step(facing)`) if any, else the same-zone entities on `pos` itself.
/// Within the winning tile the order is `kind`, then `id`.
#[must_use]
pub fn interact_candidates(
    pos: TilePos,
    facing: Direction,
    zone: u32,
    entities: &[InteractEntity],
) -> Vec<usize> {
    let faced = on_tile(pos.step(facing), zone, entities);
    if faced.is_empty() {
        on_tile(pos, zone, entities)
    } else {
        faced
    }
}

/// Indices of the `zone` entities standing on `tile`, ordered by `kind`, then `id`
/// (a stable sort, so equal `(kind, id)` pairs keep their input order).
fn on_tile(tile: TilePos, zone: u32, entities: &[InteractEntity]) -> Vec<usize> {
    let mut hits: Vec<usize> = entities
        .iter()
        .enumerate()
        .filter(|(_, e)| e.zone == zone && e.pos == tile)
        .map(|(i, _)| i)
        .collect();
    hits.sort_by_key(|&i| (entities[i].kind, entities[i].id));
    hits
}

/// True when two characters are close enough for one to start an interaction
/// with the other (open a trade, send a challenge): the same zone and within
/// `TALK_RANGE` tiles, Manhattan, inclusive.
///
/// The range is the NPC talk range on purpose. It is a latency margin for the
/// server, not a reach: the client only ever targets the tile in front or its own
/// ([`interact_candidates`]).
#[must_use]
pub fn within_interact_range(zone_a: u32, pos_a: TilePos, zone_b: u32, pos_b: TilePos) -> bool {
    zone_a == zone_b && in_talk_range(pos_a, pos_b)
}
