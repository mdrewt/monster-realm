//! World interaction target rule — which entities the interact button acts on.
//!
//! The rule is "the tile in front, then your own tile": the first non-empty tier
//! wins, and nothing else is a candidate (no nearest-within-range, no facing ray).
//! The server's `TALK_RANGE` is a latency margin, not a reach, so this rule is
//! deliberately narrower than what `talk` accepts.

use crate::types::{Direction, TilePos};

/// What an interactable is. Declaration order IS the within-tile priority
/// (NPC before heal location before player), via the derived `Ord`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
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
    /// Numeric id (NPC id, heal `location_id`, player entity id); the tie-break
    /// after `kind` within one tile.
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
    let _ = (pos, facing, zone, entities);
    Vec::new()
}
