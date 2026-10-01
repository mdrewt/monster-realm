//! CTL9.1 / CTL9.2 — the interaction target rule: the tile in front, else your own
//! tile; same zone only; within a tile `kind` (NPC < heal < player) then numeric id.
//! Every assertion pins the EXACT returned `Vec<usize>` (indices into the input).

use proptest::prelude::*;

use crate::interact::{interact_candidates, InteractEntity, InteractKind};
use crate::types::{Direction, TilePos};
use crate::TALK_RANGE;

const ZONE: u32 = 3;
const OTHER_ZONE: u32 = 4;
const ME: TilePos = TilePos { x: 5, y: 5 };

/// Every facing with the offset `TilePos::step` applies for it (screen coords:
/// North decreases y).
const FACINGS: [(Direction, i32, i32); 4] = [
    (Direction::North, 0, -1),
    (Direction::South, 0, 1),
    (Direction::East, 1, 0),
    (Direction::West, -1, 0),
];

fn ent(kind: InteractKind, x: i32, y: i32, zone: u32, id: u64) -> InteractEntity {
    InteractEntity {
        kind,
        pos: TilePos { x, y },
        zone,
        id,
    }
}

/// An NPC `id` standing at `ME + (dx, dy)` in the character's zone.
fn npc_at(dx: i32, dy: i32, id: u64) -> InteractEntity {
    ent(InteractKind::Npc, ME.x + dx, ME.y + dy, ZONE, id)
}

// ---------------------------------------------------------------------------
// CTL9.1 — tiers: faced tile, else own tile, nothing else
// ---------------------------------------------------------------------------

#[test]
fn ctl9_1_each_facing_selects_exactly_its_own_faced_tile() {
    // One NPC on each of the four neighbours, input order N,S,E,W: only the one in
    // front of the character is a candidate, whichever way it faces.
    let entities: Vec<InteractEntity> = FACINGS
        .iter()
        .enumerate()
        .map(|(i, (_, dx, dy))| npc_at(*dx, *dy, i as u64 + 1))
        .collect();
    for (i, (facing, _, _)) in FACINGS.iter().enumerate() {
        assert_eq!(
            interact_candidates(ME, *facing, ZONE, &entities),
            vec![i],
            "facing {facing:?} must offer only the entity on its own faced tile"
        );
    }
}

#[test]
fn ctl9_1_nothing_but_the_faced_and_own_tiles_is_a_candidate() {
    // Every other tile in the 7x7 block around the character — directly behind, two
    // tiles ahead, the four diagonals, tiles sharing only one coordinate with the
    // faced tile — holds an NPC. None of them is a candidate, for any facing.
    for (facing, fdx, fdy) in FACINGS {
        let mut entities = Vec::new();
        for dx in -3..=3 {
            for dy in -3..=3 {
                if (dx, dy) == (fdx, fdy) || (dx, dy) == (0, 0) {
                    continue;
                }
                entities.push(npc_at(dx, dy, 1));
            }
        }
        assert_eq!(entities.len(), 47, "fixture covers the 7x7 block minus 2");
        assert_eq!(
            interact_candidates(ME, facing, ZONE, &entities),
            Vec::<usize>::new(),
            "facing {facing:?}: only the faced and own tiles may offer anyone"
        );
    }
}

#[test]
fn ctl9_1_neither_tier_populated_returns_empty() {
    for (facing, _, _) in FACINGS {
        assert_eq!(
            interact_candidates(ME, facing, ZONE, &[]),
            Vec::<usize>::new()
        );
    }
}

#[test]
fn ctl9_1_own_tile_is_the_fallback_when_the_faced_tile_is_empty() {
    for (facing, _, _) in FACINGS {
        // A far decoy at index 0, the own-tile NPC at index 1.
        let entities = [npc_at(3, 3, 1), npc_at(0, 0, 4)];
        assert_eq!(
            interact_candidates(ME, facing, ZONE, &entities),
            vec![1],
            "facing {facing:?}: an empty faced tile falls back to the own tile"
        );
    }
}

#[test]
fn ctl9_1_faced_tile_wins_over_the_own_tile_even_for_a_higher_priority_kind() {
    for (facing, dx, dy) in FACINGS {
        // The own tile holds an NPC (the highest-priority kind, lowest id); the faced
        // tile holds only a player. The faced tier is non-empty, so it alone wins.
        let entities = [
            ent(InteractKind::Npc, ME.x, ME.y, ZONE, 1),
            ent(InteractKind::Player, ME.x + dx, ME.y + dy, ZONE, 99),
        ];
        assert_eq!(
            interact_candidates(ME, facing, ZONE, &entities),
            vec![1],
            "facing {facing:?}: the own-tile NPC must not be mixed into the faced tier"
        );
    }
}

#[test]
fn ctl9_1_mixed_tiers_return_only_the_faced_tiers_indices_in_priority_order() {
    // Facing East: faced tile is (6,5). Indices are into the INPUT slice, not into
    // any filtered list.
    // 0 far; 1 faced heal; 2 own tile; 3 faced NPC; 4 faced but other zone;
    // 5 diagonal; 6 faced player.
    let entities = [
        npc_at(-3, 2, 1),
        ent(InteractKind::Heal, ME.x + 1, ME.y, ZONE, 2),
        ent(InteractKind::Npc, ME.x, ME.y, ZONE, 1),
        ent(InteractKind::Npc, ME.x + 1, ME.y, ZONE, 7),
        ent(InteractKind::Npc, ME.x + 1, ME.y, OTHER_ZONE, 3),
        npc_at(1, 1, 5),
        ent(InteractKind::Player, ME.x + 1, ME.y, ZONE, 1),
    ];
    assert_eq!(
        interact_candidates(ME, Direction::East, ZONE, &entities),
        vec![3, 1, 6]
    );
}

// ---------------------------------------------------------------------------
// CTL9.1 — zone filter on both tiers
// ---------------------------------------------------------------------------

#[test]
fn ctl9_1_another_zones_faced_entity_does_not_make_the_faced_tier_non_empty() {
    // Faced tile: only an other-zone NPC. Own tile: a same-zone heal. The faced tier
    // is empty once the zone filter applies, so the own tile's heal is the answer.
    let entities = [
        ent(InteractKind::Npc, ME.x + 1, ME.y, OTHER_ZONE, 1),
        ent(InteractKind::Heal, ME.x, ME.y, ZONE, 2),
    ];
    assert_eq!(
        interact_candidates(ME, Direction::East, ZONE, &entities),
        vec![1]
    );
}

#[test]
fn ctl9_1_another_zones_entities_are_excluded_on_both_tiers() {
    let entities = [
        ent(InteractKind::Npc, ME.x + 1, ME.y, OTHER_ZONE, 1),
        ent(InteractKind::Heal, ME.x, ME.y, 0, 2),
    ];
    assert_eq!(
        interact_candidates(ME, Direction::East, ZONE, &entities),
        Vec::<usize>::new()
    );
}

#[test]
fn ctl9_1_a_higher_priority_other_zone_entity_never_displaces_a_same_zone_one() {
    // Faced tile: other-zone NPC (index 0) beside a same-zone player (index 1).
    let faced = [
        ent(InteractKind::Npc, ME.x, ME.y - 1, OTHER_ZONE, 1),
        ent(InteractKind::Player, ME.x, ME.y - 1, ZONE, 2),
    ];
    assert_eq!(
        interact_candidates(ME, Direction::North, ZONE, &faced),
        vec![1]
    );
    // Own tile (faced tile empty): the same shape.
    let own = [
        ent(InteractKind::Npc, ME.x, ME.y, OTHER_ZONE, 1),
        ent(InteractKind::Heal, ME.x, ME.y, ZONE, 2),
    ];
    assert_eq!(
        interact_candidates(ME, Direction::North, ZONE, &own),
        vec![1]
    );
}

// ---------------------------------------------------------------------------
// CTL9.1 — within a tile: kind (NPC < heal < player), then numeric id, then index
// ---------------------------------------------------------------------------

/// Every input order of one NPC, one heal and one player sharing `tile`; ids run
/// OPPOSITE to the kind order (NPC 30, heal 20, player 10) so an id-only sort
/// would invert the expectation.
fn assert_kind_order_on_tile(facing: Direction, tile: TilePos) {
    let kinds = [
        (InteractKind::Npc, 30u64),
        (InteractKind::Heal, 20),
        (InteractKind::Player, 10),
    ];
    let perms: [[usize; 3]; 6] = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    for perm in perms {
        let entities: Vec<InteractEntity> = perm
            .iter()
            .map(|&k| ent(kinds[k].0, tile.x, tile.y, ZONE, kinds[k].1))
            .collect();
        // Rank k (0 = NPC, 1 = heal, 2 = player) sits at input index `position`.
        let expected: Vec<usize> = (0..3)
            .map(|rank| perm.iter().position(|&p| p == rank).expect("rank present"))
            .collect();
        assert_eq!(
            interact_candidates(ME, facing, ZONE, &entities),
            expected,
            "input order {perm:?} on {tile:?}"
        );
    }
}

#[test]
fn ctl9_1_kind_order_is_npc_then_heal_then_player_on_the_faced_tile() {
    let faced = ME.step(Direction::East);
    assert_eq!(faced, TilePos { x: 6, y: 5 }, "fixture: the faced tile");
    assert_kind_order_on_tile(Direction::East, faced);
}

#[test]
fn ctl9_1_kind_order_is_npc_then_heal_then_player_on_the_own_tile() {
    assert_kind_order_on_tile(Direction::West, ME);
}

#[test]
fn ctl9_1_ids_order_numerically_so_9_comes_before_10() {
    let entities = [npc_at(1, 0, 10), npc_at(1, 0, 9)];
    assert_eq!(
        interact_candidates(ME, Direction::East, ZONE, &entities),
        vec![1, 0]
    );
}

#[test]
fn ctl9_1_ids_order_numerically_across_digit_widths_and_the_u64_range() {
    // Lexicographic order of these would be 10,100,2,9,99.
    let ids = [100u64, 2, 99, 10, 9];
    let entities: Vec<InteractEntity> = ids.iter().map(|&id| npc_at(1, 0, id)).collect();
    assert_eq!(
        interact_candidates(ME, Direction::East, ZONE, &entities),
        vec![1, 4, 3, 2, 0]
    );
    // Beyond u32, and the u64 extremes.
    let wide = [u64::MAX, 4_294_967_296, 1, 0];
    let entities: Vec<InteractEntity> = wide.iter().map(|&id| npc_at(1, 0, id)).collect();
    assert_eq!(
        interact_candidates(ME, Direction::East, ZONE, &entities),
        vec![3, 2, 1, 0]
    );
}

#[test]
fn ctl9_1_kind_outranks_id() {
    // Highest id on the highest-priority kind still comes first.
    let entities = [
        ent(InteractKind::Player, ME.x, ME.y + 1, ZONE, 0),
        ent(InteractKind::Heal, ME.x, ME.y + 1, ZONE, 1),
        ent(InteractKind::Npc, ME.x, ME.y + 1, ZONE, u64::MAX),
    ];
    assert_eq!(
        interact_candidates(ME, Direction::South, ZONE, &entities),
        vec![2, 1, 0]
    );
}

#[test]
fn ctl9_1_equal_kind_and_id_tie_break_by_input_index() {
    let entities = [
        npc_at(0, -1, 5),
        npc_at(0, -1, 3),
        npc_at(0, -1, 5),
        npc_at(0, -1, 3),
    ];
    assert_eq!(
        interact_candidates(ME, Direction::North, ZONE, &entities),
        vec![1, 3, 0, 2]
    );
    let same = [
        ent(InteractKind::Heal, ME.x, ME.y, ZONE, 1),
        ent(InteractKind::Heal, ME.x, ME.y, ZONE, 1),
        ent(InteractKind::Heal, ME.x, ME.y, ZONE, 1),
    ];
    assert_eq!(
        interact_candidates(ME, Direction::North, ZONE, &same),
        vec![0, 1, 2]
    );
}

#[test]
fn ctl9_1_a_large_group_of_identical_keys_keeps_input_order_and_is_never_truncated() {
    // 200 entities on the faced tile, all the same kind and id: the answer is the
    // COMPLETE group (the design says "the complete set of same-zone entities on
    // the winning tile", so no cap such as 8 or 64), in input order. A group this
    // size is beyond the small-slice insertion-sort range, so an unstable sort has
    // room to reorder it.
    for (facing, dx, dy) in FACINGS {
        let entities: Vec<InteractEntity> = (0..200).map(|_| npc_at(dx, dy, 7)).collect();
        assert_eq!(
            interact_candidates(ME, facing, ZONE, &entities),
            (0..200).collect::<Vec<usize>>(),
            "facing {facing:?}: all 200 identical-key entities, in input order"
        );
    }
    // The same on the own-tile fallback.
    let own: Vec<InteractEntity> = (0..200)
        .map(|_| ent(InteractKind::Heal, ME.x, ME.y, ZONE, 7))
        .collect();
    assert_eq!(
        interact_candidates(ME, Direction::North, ZONE, &own),
        (0..200).collect::<Vec<usize>>()
    );
}

#[test]
fn ctl9_1_a_large_mixed_group_with_many_duplicate_keys_is_complete_and_stably_ordered() {
    // 300 entities on the faced tile (East of ME) with kinds and ids scrambled by a
    // fixed LCG (15 distinct (kind, id) keys, so every key repeats ~20 times), plus
    // one in seven in another zone (excluded). The expectation is built
    // independently of the implementation: bucket the input indices per
    // (kind rank, id) in input order, then concatenate the buckets in key order.
    let mut state: u64 = 0x2545_F491_4F6C_DD1D;
    let mut entities = Vec::new();
    let mut rank_of_entity = Vec::new();
    for _ in 0..300 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let r = state >> 33;
        let (kind, rank) = match r % 3 {
            0 => (InteractKind::Npc, 0u8),
            1 => (InteractKind::Heal, 1u8),
            _ => (InteractKind::Player, 2u8),
        };
        let id = (r / 3) % 5;
        let zone = if (r / 15) % 7 == 0 { OTHER_ZONE } else { ZONE };
        entities.push(ent(kind, ME.x + 1, ME.y, zone, id));
        rank_of_entity.push(rank);
    }
    let mut buckets: std::collections::BTreeMap<(u8, u64), Vec<usize>> =
        std::collections::BTreeMap::new();
    for (i, e) in entities.iter().enumerate() {
        if e.zone == ZONE {
            buckets
                .entry((rank_of_entity[i], e.id))
                .or_default()
                .push(i);
        }
    }
    let expected: Vec<usize> = buckets.into_values().flatten().collect();
    // Non-vacuity: far past any plausible cap, and genuinely out of input order.
    assert!(expected.len() > 200, "fixture size: {}", expected.len());
    assert!(
        expected.windows(2).any(|w| w[0] > w[1]),
        "fixture must need real reordering"
    );
    assert_eq!(
        interact_candidates(ME, Direction::East, ZONE, &entities),
        expected
    );
}

// ---------------------------------------------------------------------------
// CTL9.1 — extreme coordinates: `step` saturates, never wraps
// ---------------------------------------------------------------------------

#[test]
fn ctl9_1_saturated_step_makes_the_faced_tile_the_own_tile_offered_once() {
    // East of x = i32::MAX saturates to x = i32::MAX: the faced tile IS the own tile.
    let pos = TilePos { x: i32::MAX, y: 0 };
    let entities = [
        ent(InteractKind::Heal, i32::MAX, 0, ZONE, 2),
        ent(InteractKind::Npc, i32::MAX, 0, ZONE, 9),
    ];
    assert_eq!(
        interact_candidates(pos, Direction::East, ZONE, &entities),
        vec![1, 0],
        "each own-tile entity appears exactly once, in kind order"
    );
    // North of y = i32::MIN saturates likewise.
    let pos = TilePos {
        x: i32::MIN,
        y: i32::MIN,
    };
    let entities = [ent(InteractKind::Player, i32::MIN, i32::MIN, ZONE, 1)];
    assert_eq!(
        interact_candidates(pos, Direction::North, ZONE, &entities),
        vec![0]
    );
}

#[test]
fn ctl9_1_a_step_past_the_i32_bound_never_wraps_to_the_far_side() {
    let east_edge = TilePos { x: i32::MAX, y: 0 };
    let wrapped_only = [ent(InteractKind::Npc, i32::MIN, 0, ZONE, 1)];
    assert_eq!(
        interact_candidates(east_edge, Direction::East, ZONE, &wrapped_only),
        Vec::<usize>::new()
    );
    let south_edge = TilePos { x: 0, y: i32::MAX };
    let wrapped_only = [ent(InteractKind::Npc, 0, i32::MIN, ZONE, 1)];
    assert_eq!(
        interact_candidates(south_edge, Direction::South, ZONE, &wrapped_only),
        Vec::<usize>::new()
    );
    let west_edge = TilePos { x: i32::MIN, y: 0 };
    let wrapped_only = [ent(InteractKind::Npc, i32::MAX, 0, ZONE, 1)];
    assert_eq!(
        interact_candidates(west_edge, Direction::West, ZONE, &wrapped_only),
        Vec::<usize>::new()
    );
}

// ---------------------------------------------------------------------------
// CTL9.1 / CTL9.2 — properties
// ---------------------------------------------------------------------------

fn kind_of(n: u8) -> InteractKind {
    match n % 3 {
        0 => InteractKind::Npc,
        1 => InteractKind::Heal,
        _ => InteractKind::Player,
    }
}

/// Near-range coordinates plus the saturation extremes.
fn coord() -> impl Strategy<Value = i32> {
    prop_oneof![
        6 => -6i32..=6,
        1 => Just(i32::MIN),
        1 => Just(i32::MIN + 1),
        1 => Just(i32::MAX - 1),
        1 => Just(i32::MAX),
    ]
}

fn any_facing() -> impl Strategy<Value = Direction> {
    prop_oneof![
        Just(Direction::North),
        Just(Direction::South),
        Just(Direction::East),
        Just(Direction::West),
    ]
}

/// `(dx, dy, zone, kind seed, id)` per entity, placed relative to the character.
fn raw_entities() -> impl Strategy<Value = Vec<(i32, i32, u32, u8, u64)>> {
    prop::collection::vec((-3i32..=3, -3i32..=3, 0u32..3, 0u8..3, 0u64..8), 0..16)
}

fn place(me: TilePos, raw: &[(i32, i32, u32, u8, u64)]) -> Vec<InteractEntity> {
    raw.iter()
        .map(|&(dx, dy, zone, kind, id)| InteractEntity {
            kind: kind_of(kind),
            pos: TilePos {
                x: me.x.saturating_add(dx),
                y: me.y.saturating_add(dy),
            },
            zone,
            id,
        })
        .collect()
}

fn manhattan(a: TilePos, b: TilePos) -> i64 {
    (i64::from(a.x) - i64::from(b.x)).abs() + (i64::from(a.y) - i64::from(b.y)).abs()
}

proptest! {
    /// CTL9.2: every NPC the rule offers is one the server's `talk` accepts —
    /// within `TALK_RANGE` Manhattan tiles, in the same zone.
    #[test]
    fn ctl9_2_every_offered_npc_is_within_talk_range_and_in_the_same_zone(
        x in coord(),
        y in coord(),
        facing in any_facing(),
        zone in 0u32..3,
        raw in raw_entities(),
    ) {
        let me = TilePos { x, y };
        let entities = place(me, &raw);
        let faced = me.step(facing);
        let out = interact_candidates(me, facing, zone, &entities);
        for &i in &out {
            prop_assert!(i < entities.len(), "index {} out of range", i);
            let e = entities[i];
            prop_assert_eq!(e.zone, zone);
            prop_assert!(
                e.pos == faced || e.pos == me,
                "offered entity at {:?} is neither the faced tile {:?} nor own tile {:?}",
                e.pos, faced, me
            );
            if e.kind == InteractKind::Npc {
                prop_assert!(
                    manhattan(me, e.pos) <= TALK_RANGE,
                    "offered NPC at {:?} is {} tiles from {:?}, beyond TALK_RANGE {}",
                    e.pos, manhattan(me, e.pos), me, TALK_RANGE
                );
            }
        }
    }

    /// Non-vacuity for CTL9.2: an NPC placed on the faced tile is ALWAYS offered
    /// (the property above passes trivially on an empty answer), and when it is,
    /// the faced tier shadows the own tile entirely.
    #[test]
    fn ctl9_2_an_npc_on_the_faced_tile_is_always_offered_and_shadows_the_own_tile(
        x in coord(),
        y in coord(),
        facing in any_facing(),
        zone in 0u32..3,
        raw in raw_entities(),
        id in 0u64..8,
    ) {
        let me = TilePos { x, y };
        let mut entities = place(me, &raw);
        let faced = me.step(facing);
        entities.push(InteractEntity {
            kind: InteractKind::Npc,
            pos: faced,
            zone,
            id,
        });
        let planted = entities.len() - 1;
        let out = interact_candidates(me, facing, zone, &entities);
        prop_assert!(out.contains(&planted), "planted faced NPC {} missing from {:?}", planted, out);
        for &i in &out {
            prop_assert_eq!(entities[i].pos, faced);
        }
    }

    /// CTL9.1 against an independent reference: the first non-empty same-zone tier,
    /// ordered by (kind, id, input index).
    #[test]
    fn ctl9_1_result_matches_the_tier_and_order_reference(
        x in coord(),
        y in coord(),
        facing in any_facing(),
        zone in 0u32..3,
        raw in raw_entities(),
    ) {
        let me = TilePos { x, y };
        let entities = place(me, &raw);
        let faced = me.step(facing);
        let on = |tile: TilePos| -> Vec<usize> {
            (0..entities.len())
                .filter(|&i| entities[i].zone == zone && entities[i].pos == tile)
                .collect()
        };
        let mut expected = on(faced);
        if expected.is_empty() {
            expected = on(me);
        }
        expected.sort_by_key(|&i| (entities[i].kind, entities[i].id, i));
        prop_assert_eq!(interact_candidates(me, facing, zone, &entities), expected);
    }
}
