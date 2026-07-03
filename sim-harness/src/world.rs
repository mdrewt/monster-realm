//! Headless model of the M2 authoritative movement loop, for in-CI netcode tests
//! without a live module: a per-character intent queue + a per-zone tick that
//! drains ONE move/character/tick via the SAME `game_core::apply_move` the server
//! reducer calls. It verifies the loop CONTRACT (ADR-0011): drain-one (server pace),
//! bounded queue (anti-flood), monotonic `seq`, zoned isolation, replay-determinism.
//! The actual reducer is the thin shell over the same rule; this proves the logic.

use std::collections::BTreeMap;

use game_core::{
    apply_move, spawn, ActionState, CharacterState, Direction, Millis, MoveInput, TileMap, TilePos,
    MOVE_QUEUE_CAP,
};

#[derive(Debug, Clone)]
struct SimChar {
    zone_id: u32,
    state: CharacterState,
    queue: Vec<MoveInput>,
    last_seq: u64,
}

/// The authoritative world model (server side).
#[derive(Debug, Default)]
pub struct ServerWorld {
    chars: BTreeMap<u64, SimChar>,
    next_id: u64,
}

impl ServerWorld {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a character in `zone_id` at the authoritative spawn; returns its id.
    pub fn join(&mut self, zone_id: u32) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.chars.insert(
            id,
            SimChar {
                zone_id,
                state: CharacterState {
                    pos: spawn(),
                    facing: Direction::South,
                    action: ActionState::Idle,
                    move_started_at: Millis(0),
                },
                queue: Vec::new(),
                last_seq: 0,
            },
        );
        id
    }

    /// Mirror of `enqueue_move`: monotonic `seq` + bounded queue + intent-only
    /// (never computes movement).
    ///
    /// # Errors
    /// `Err` if the id is unknown, `seq` is stale, or the queue is full.
    pub fn enqueue(&mut self, id: u64, input: MoveInput, seq: u64) -> Result<(), String> {
        let ch = self
            .chars
            .get_mut(&id)
            .ok_or_else(|| "not joined".to_string())?;
        if seq <= ch.last_seq {
            return Err("stale seq".to_string());
        }
        if ch.queue.len() >= MOVE_QUEUE_CAP {
            return Err("queue full".to_string());
        }
        ch.queue.push(input);
        ch.last_seq = seq;
        Ok(())
    }

    /// Mirror of the per-zone `movement_tick`: drain ≤1 move per character whose
    /// `zone_id == zone`, via `apply_move`. Snapshots ids before mutating.
    ///
    /// Warp resolution mirrors `movement_tick` (ADR-0020/0066): if a moved
    /// character lands on a warp tile (`map.warp_at`), their `zone_id` and `pos`
    /// are updated to the destination and the queue is cleared (12.5f-1). Delta
    /// from `movement_tick`: the harness has NO player/battle tables, so the
    /// battle-guard is omitted — every moved character resolves warps unconditionally.
    pub fn tick_zone(&mut self, zone: u32, now: Millis, map: &TileMap) {
        let ids: Vec<u64> = self
            .chars
            .iter()
            .filter(|(_, c)| c.zone_id == zone)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let Some(ch) = self.chars.get_mut(&id) else {
                continue;
            };
            if ch.queue.is_empty() {
                ch.state.action = ActionState::Idle;
                continue;
            }
            let input = ch.queue.remove(0);
            let prev = ch.state.pos; // capture BEFORE apply_move (mirrors movement.rs:194)
            ch.state = apply_move(&ch.state, input, map, now);
            // Warp resolution: only when the character actually moved (guard 1: no bump warp).
            // Battle-guard (movement.rs:207-220) is omitted — harness has no battle tables.
            if prev != ch.state.pos {
                if let Some(warp) = map.warp_at(ch.state.pos) {
                    ch.zone_id = warp.to_zone;
                    ch.state.pos = warp.to_tile;
                    ch.queue.clear(); // clear queued intents across zone boundary
                    ch.state.action = ActionState::Idle; // arrive idle in new zone
                }
            }
        }
    }

    /// Returns the `zone_id` of character `id`, or `None` if not joined.
    #[must_use]
    pub fn zone_of(&self, id: u64) -> Option<u32> {
        self.chars.get(&id).map(|c| c.zone_id)
    }

    #[must_use]
    pub fn pos(&self, id: u64) -> Option<TilePos> {
        self.chars.get(&id).map(|c| c.state.pos)
    }

    #[must_use]
    pub fn action(&self, id: u64) -> Option<ActionState> {
        self.chars.get(&id).map(|c| c.state.action)
    }

    #[must_use]
    pub fn queue_len(&self, id: u64) -> usize {
        self.chars.get(&id).map_or(0, |c| c.queue.len())
    }
}

#[cfg(test)]
mod tests {
    use super::ServerWorld;
    use game_core::{zone_0, ActionState, Direction, Millis, MoveInput, TilePos};

    fn step(d: Direction) -> MoveInput {
        MoveInput::Step(d)
    }

    #[test]
    fn join_spawns_at_authoritative_spawn() {
        let mut w = ServerWorld::new();
        let id = w.join(0);
        assert_eq!(w.pos(id), Some(game_core::spawn()));
    }

    #[test]
    fn tick_drains_one_move_and_applies_rule() {
        let mut w = ServerWorld::new();
        let map = zone_0();
        let id = w.join(0);
        w.enqueue(id, step(Direction::East), 1).unwrap();
        w.tick_zone(0, Millis(200), &map);
        assert_eq!(w.pos(id), Some(TilePos { x: 2, y: 1 })); // spawn (1,1) -> east
        assert_eq!(w.action(id), Some(ActionState::Walking));
        assert_eq!(w.queue_len(id), 0);
    }

    #[test]
    fn server_paced_one_tile_per_tick_regardless_of_burst() {
        let mut w = ServerWorld::new();
        let map = zone_0();
        let id = w.join(0);
        // Burst beyond the cap within one "frame": cap accepts 2, the 3rd rejects.
        assert!(w.enqueue(id, step(Direction::East), 1).is_ok());
        assert!(w.enqueue(id, step(Direction::East), 2).is_ok());
        assert_eq!(
            w.enqueue(id, step(Direction::East), 3).unwrap_err(),
            "queue full"
        );
        // One tick advances at most one tile.
        w.tick_zone(0, Millis(200), &map);
        assert_eq!(w.pos(id), Some(TilePos { x: 2, y: 1 }));
        assert_eq!(w.queue_len(id), 1);
    }

    #[test]
    fn rejects_stale_seq() {
        let mut w = ServerWorld::new();
        let id = w.join(0);
        w.enqueue(id, step(Direction::East), 5).unwrap();
        assert_eq!(
            w.enqueue(id, step(Direction::East), 5).unwrap_err(),
            "stale seq"
        );
        assert_eq!(
            w.enqueue(id, step(Direction::East), 4).unwrap_err(),
            "stale seq"
        );
    }

    #[test]
    fn zoned_isolation_a_zone_tick_touches_only_its_zone() {
        let mut w = ServerWorld::new();
        let map = zone_0();
        let a = w.join(0);
        let b = w.join(1);
        w.enqueue(a, step(Direction::East), 1).unwrap();
        w.enqueue(b, step(Direction::East), 1).unwrap();
        w.tick_zone(0, Millis(200), &map); // only zone 0
        assert_eq!(w.pos(a), Some(TilePos { x: 2, y: 1 })); // moved
        assert_eq!(w.pos(b), Some(game_core::spawn())); // untouched
    }

    #[test]
    fn replay_is_deterministic() {
        let run = || {
            let mut w = ServerWorld::new();
            let map = zone_0();
            let id = w.join(0);
            let dirs = [
                Direction::East,
                Direction::South,
                Direction::West,
                Direction::North,
            ];
            for (i, d) in dirs.into_iter().enumerate() {
                let seq = u64::try_from(i).unwrap() + 1;
                let _ = w.enqueue(id, step(d), seq);
                w.tick_zone(0, Millis(200 * (seq as i64)), &map);
            }
            w.pos(id)
        };
        assert_eq!(run(), run());
    }

    // ===========================================================================
    // 12.5f-1: warp resolution tests
    //
    // These tests use `load_zone_maps()` (real authored RON) + `map_for` so
    // the harness exercises the SAME content the server loads. Zone 0 has a warp
    // at (5,5) → zone 1; zone 1 has a return warp at (5,5) → zone 0.
    //
    // NOTE: the direct path East×4, South×4 is BLOCKED — row y=3 in both zone
    // maps has walls at x=4 and x=5 ("#...##..~#"). Walkable path to (5,5):
    //   East×2 → (3,1); South×3 → (3,4); East×2 → (5,4); South×1 → (5,5).
    //   8 steps total; each step is one tick (MOVE_QUEUE_CAP = 2, paced 1/tick).
    // ===========================================================================

    /// Walk a character from spawn (1,1) via the navigable route to the warp tile (5,5).
    /// Assert zone_id flips from 0 to 1 and pos becomes (5,5) at the destination.
    ///
    /// Kill target: tick_zone that never checks map.warp_at → char stays in zone 0
    /// at (5,5); or apply_stream using warp-less zone_0() → no warp tile at (5,5).
    #[test]
    fn warp_crossing_moves_character_to_destination_zone() {
        let zone_maps =
            game_core::load_zone_maps().expect("embedded zone_maps RON must parse (12.5f-1)");
        let map0 = game_core::map_for(0, &zone_maps)
            .expect("zone 0 must have a ZoneMapDef in the embedded RON");

        // Verify the warp tile exists in the real-content map (kill target:
        // map built from zone_0() which has warps:[] and no warp at (5,5)).
        assert!(
            map0.warp_at(game_core::TilePos { x: 5, y: 5 }).is_some(),
            "zone 0 must have a warp at (5,5) — kill target: map built from warp-less zone_0()"
        );

        let mut w = ServerWorld::new();
        let id = w.join(0);
        // Paced walk: enqueue and tick one step at a time (MOVE_QUEUE_CAP=2).
        // Path avoids wall at (4,3)/(5,3): E,E→(3,1); S,S,S→(3,4); E,E→(5,4); S→(5,5).
        let moves = [
            Direction::East,
            Direction::East, // (1,1)→(3,1)
            Direction::South,
            Direction::South,
            Direction::South, // (3,1)→(3,4)
            Direction::East,
            Direction::East,  // (3,4)→(5,4)
            Direction::South, // (5,4)→(5,5) = warp
        ];
        for (seq, &dir) in moves.iter().enumerate() {
            let seq = u64::try_from(seq).unwrap() + 1;
            w.enqueue(id, step(dir), seq)
                .expect("paced walk must not overflow the queue");
            let now = Millis(200 * i64::try_from(seq).unwrap());
            w.tick_zone(0, now, &map0);
        }

        // After the warp step, the char is in zone 1, not zone 0.
        assert_eq!(
            w.zone_of(id),
            Some(1),
            "after stepping onto the (5,5) warp tile, zone_id must be 1 — \
             kill target: tick_zone without warp resolution leaves zone_id=0"
        );
        assert_eq!(
            w.pos(id),
            Some(game_core::TilePos { x: 5, y: 5 }),
            "landing pos in zone 1 must be (5,5) — warp to_tile (5,5) → (5,5)"
        );
        // Queue must be cleared on warp (mirrors movement.rs:225).
        assert_eq!(
            w.queue_len(id),
            0,
            "queue must be cleared on warp (mirrors movement.rs:225 move_queue.clear())"
        );
    }

    /// A non-warp step at (5,5) on the warp-less zone_0() map must NOT change the zone.
    ///
    /// Kill target: warp resolution that fires unconditionally rather than being
    /// gated on `map.warp_at()` returning Some.
    #[test]
    fn no_spurious_warp_without_warp_tile() {
        // zone_0() has warps: vec![] — no warp at any tile.
        let map = game_core::zone_0();
        assert!(
            map.warp_at(game_core::TilePos { x: 5, y: 5 }).is_none(),
            "zone_0() must NOT have a warp at (5,5) — used to verify no-spurious-warp"
        );

        let mut w = ServerWorld::new();
        let id = w.join(0);
        // Walk to (5,5) via the navigable path (same as warp_crossing_moves_character_to_destination_zone):
        // E,E→(3,1); S,S,S→(3,4); E,E→(5,4); S→(5,5). The direct E×4,S×4 path is BLOCKED
        // at (5,3) (wall in ZONE_0_ROWS row y=3). Using the navigable path ensures the character
        // actually lands on (5,5) — making the kill target non-vacuous.
        let moves = [
            Direction::East,
            Direction::East, // (1,1)→(3,1)
            Direction::South,
            Direction::South,
            Direction::South, // (3,1)→(3,4)
            Direction::East,
            Direction::East,  // (3,4)→(5,4)
            Direction::South, // (5,4)→(5,5) — warp-less in zone_0()
        ];
        for (seq, &dir) in moves.iter().enumerate() {
            let seq = u64::try_from(seq).unwrap() + 1;
            let _ = w.enqueue(id, step(dir), seq);
            w.tick_zone(0, Millis(200 * i64::try_from(seq).unwrap()), &map);
        }
        // No warp → still in zone 0.
        assert_eq!(
            w.zone_of(id),
            Some(0),
            "without a warp tile at (5,5) the zone_id must remain 0 — \
             kill target: unconditional warp resolution that ignores map.warp_at()"
        );
    }

    /// Bump on a wall tile adjacent to the warp tile must NOT trigger warp
    /// (guard 1: `prev != next.pos`). The warp at (5,5) must only fire when
    /// the character MOVES onto (5,5), not when it bumps into a wall from (5,5).
    ///
    /// Kill target: warp code that fires on warp_at(new_pos) without the bump guard.
    #[test]
    fn bump_adjacent_to_warp_does_not_warp() {
        let zone_maps = game_core::load_zone_maps().expect("embedded zone_maps RON must parse");
        let map0 = game_core::map_for(0, &zone_maps).expect("zone 0 must be in RON");
        let map1 = game_core::map_for(1, &zone_maps).expect("zone 1 must be in RON");

        // Walk through zone 0 to (5,5) via the navigable path, triggering the warp
        // to zone 1. The character then sits at (5,5) in zone 1 — zone 1 also has
        // a warp at (5,5), but it must NOT fire on a subsequent bump into wall (5,6).
        let mut w = ServerWorld::new();
        let id = w.join(0); // start in zone 0; the warp moves us to zone 1
        let moves_z0 = [
            Direction::East,
            Direction::East, // (1,1)→(3,1)
            Direction::South,
            Direction::South,
            Direction::South, // (3,1)→(3,4)
            Direction::East,
            Direction::East,  // (3,4)→(5,4)
            Direction::South, // (5,4)→(5,5) = warp → zone 1
        ];
        for (seq, &dir) in moves_z0.iter().enumerate() {
            let seq = u64::try_from(seq).unwrap() + 1;
            let _ = w.enqueue(id, step(dir), seq);
            w.tick_zone(0, Millis(200 * i64::try_from(seq).unwrap()), &map0);
        }
        // Verify the warp fired: character must be in zone 1 at (5,5).
        assert_eq!(
            w.zone_of(id),
            Some(1),
            "prerequisite: warp must have fired, moving character to zone 1"
        );
        assert_eq!(w.pos(id), Some(game_core::TilePos { x: 5, y: 5 }));

        // Now bump South into the wall at (5,6) in zone 1. The zone 1 return-warp
        // at (5,5)→zone 0 must NOT fire — prev==new_pos on a bump blocks the check.
        w.enqueue(id, step(Direction::South), 9).unwrap();
        w.tick_zone(1, Millis(1_800), &map1);

        // After the bump, zone_id remains 1 (warp only fires when the character
        // MOVES — prev != next.pos — not on a bump where prev == next.pos).
        assert_eq!(
            w.zone_of(id),
            Some(1),
            "bump into wall adjacent to warp tile must NOT trigger warp — \
             kill target: warp resolution without the `prev != new_pos` bump guard"
        );
        assert_eq!(
            w.pos(id),
            Some(game_core::TilePos { x: 5, y: 5 }),
            "pos must remain (5,5) after a southward bump into the wall at (5,6)"
        );
    }
}
