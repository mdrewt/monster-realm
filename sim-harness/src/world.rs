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
        let ch = self.chars.get_mut(&id).ok_or_else(|| "not joined".to_string())?;
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
            ch.state = apply_move(&ch.state, input, map, now);
        }
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
        assert_eq!(w.enqueue(id, step(Direction::East), 3).unwrap_err(), "queue full");
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
        assert_eq!(w.enqueue(id, step(Direction::East), 5).unwrap_err(), "stale seq");
        assert_eq!(w.enqueue(id, step(Direction::East), 4).unwrap_err(), "stale seq");
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
            let dirs = [Direction::East, Direction::South, Direction::West, Direction::North];
            for (i, d) in dirs.into_iter().enumerate() {
                let seq = u64::try_from(i).unwrap() + 1;
                let _ = w.enqueue(id, step(d), seq);
                w.tick_zone(0, Millis(200 * (seq as i64)), &map);
            }
            w.pos(id)
        };
        assert_eq!(run(), run());
    }
}
