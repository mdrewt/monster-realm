//! Shared movement value types — the cross-boundary contract (server table cols,
//! the wasm/TS wire). They derive `serde` always (the wire round-trip) and
//! `SpacetimeType` ONLY under the `spacetimedb` feature: `server-module` enables
//! it, `client-wasm` must not (feature-isolation).
//!
//! Positions are **integer tiles** (`i32`) — no floats in the rule, so the native
//! server path and the wasm client path cannot numerically diverge.

use serde::{Deserialize, Serialize};

/// Milliseconds since the unix epoch, injected at the boundary (round-trips
/// SpacetimeDB `ctx.timestamp`). `Ord` so the server can order stamps. `game-core`
/// never reads a clock — callers pass `now` in (the determinism contract).
// NOTE: no `SpacetimeType` derive — `Millis` is stored as a flat `i64` column
// (M2 flattens), and the derive panics on a newtype tuple struct in crate 1.12.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Millis(pub i64);

/// A cardinal facing/step direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum Direction {
    North,
    South,
    East,
    West,
}

/// An integer tile coordinate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct TilePos {
    pub x: i32,
    pub y: i32,
}

impl TilePos {
    /// One tile in `d`. **Saturating, never wrapping**: an extreme coord stays at
    /// the `i32` bound (an out-of-range tile, which `is_walkable` treats as a wall
    /// → bump), so `apply_move` is TOTAL over arbitrary state. `wrapping_add` would
    /// be a bug (it could teleport to a valid in-bounds tile). Screen coords:
    /// North decreases `y`.
    #[must_use]
    pub fn step(self, d: Direction) -> TilePos {
        match d {
            Direction::North => TilePos {
                x: self.x,
                y: self.y.saturating_sub(1),
            },
            Direction::South => TilePos {
                x: self.x,
                y: self.y.saturating_add(1),
            },
            Direction::East => TilePos {
                x: self.x.saturating_add(1),
                y: self.y,
            },
            Direction::West => TilePos {
                x: self.x.saturating_sub(1),
                y: self.y,
            },
        }
    }
}

/// What a character is currently doing (drives the M4 renderer's animation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum ActionState {
    Idle,
    Walking,
    Jumping,
}

/// A movement INTENT — the only thing that crosses the wire. There is **no
/// position-bearing variant**, so a client physically cannot assert "I am at
/// (x,y)"; only intent crosses, authority resolves position (illegal states
/// unrepresentable).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum MoveInput {
    Step(Direction),
    Jump,
}

/// A tile's terrain class — THE class table (glyph, Tiled GID, walkability,
/// encounter flag) that the zone-map RON rows, `tiled_import` and the style guide
/// (`docs/art/style-guide.md`) cite; nothing else defines it. Variants are
/// TAIL-APPENDED only: the `SpacetimeType` derive encodes them positionally (the
/// spacetime-type-snapshot eval pins the order) and the wire name the client reads
/// is the variant name (`serde`, no renames). Every method below is an exhaustive
/// `match` with no wildcard on `TileKind`, so an eleventh class is a compile
/// error at each site (OCP-inverted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum TileKind {
    /// Ground (short grass): `.`, GID 1, walkable.
    Floor,
    /// `#`, GID 0, blocks.
    Wall,
    /// Walkable floor that can trigger a wild encounter when stepped onto (M8):
    /// `~`, GID 2 — the only encounter class.
    TallGrass,
    /// `=`, GID 3, walkable.
    Path,
    /// `:`, GID 4, walkable.
    Sand,
    /// `w`, GID 5, blocks; the shore band is drawn where it meets land.
    ShallowWater,
    /// `W`, GID 6, blocks; borders only water (`validate_zone_maps`).
    DeepWater,
    /// `^`, GID 7, blocks.
    Rock,
    /// `T`, GID 8, blocks.
    Tree,
    /// `*`, GID 9, blocks.
    Bush,
}

impl TileKind {
    /// Every class in declaration (= wire) order — the roster `client-wasm`'s
    /// `terrain_kinds()` exports so the client's name list is pinned to this enum.
    pub const ALL: [TileKind; 10] = [
        TileKind::Floor,
        TileKind::Wall,
        TileKind::TallGrass,
        TileKind::Path,
        TileKind::Sand,
        TileKind::ShallowWater,
        TileKind::DeepWater,
        TileKind::Rock,
        TileKind::Tree,
        TileKind::Bush,
    ];

    /// Authoring char → tile kind (parse-don't-validate; unknown chars fail loud
    /// at the call site).
    ///
    /// # Errors
    /// Returns `Err` for any char that is not a known tile glyph.
    pub fn from_char(c: char) -> Result<TileKind, String> {
        match c {
            '.' => Ok(TileKind::Floor),
            '#' => Ok(TileKind::Wall),
            '~' => Ok(TileKind::TallGrass),
            '=' => Ok(TileKind::Path),
            ':' => Ok(TileKind::Sand),
            'w' => Ok(TileKind::ShallowWater),
            'W' => Ok(TileKind::DeepWater),
            '^' => Ok(TileKind::Rock),
            'T' => Ok(TileKind::Tree),
            '*' => Ok(TileKind::Bush),
            other => Err(format!("unknown tile char {other:?}")),
        }
    }

    /// The authoring glyph (the inverse of `from_char`).
    #[must_use]
    pub fn glyph(self) -> char {
        match self {
            TileKind::Floor => '.',
            TileKind::Wall => '#',
            TileKind::TallGrass => '~',
            TileKind::Path => '=',
            TileKind::Sand => ':',
            TileKind::ShallowWater => 'w',
            TileKind::DeepWater => 'W',
            TileKind::Rock => '^',
            TileKind::Tree => 'T',
            TileKind::Bush => '*',
        }
    }

    /// Tiled GID → tile kind (`tiled_import`); `None` for a GID the table does
    /// not own (the caller rejects it, never defaults).
    #[must_use]
    pub fn from_gid(gid: u32) -> Option<TileKind> {
        match gid {
            0 => Some(TileKind::Wall),
            1 => Some(TileKind::Floor),
            2 => Some(TileKind::TallGrass),
            3 => Some(TileKind::Path),
            4 => Some(TileKind::Sand),
            5 => Some(TileKind::ShallowWater),
            6 => Some(TileKind::DeepWater),
            7 => Some(TileKind::Rock),
            8 => Some(TileKind::Tree),
            9 => Some(TileKind::Bush),
            _ => None,
        }
    }

    #[must_use]
    pub fn is_walkable(self) -> bool {
        match self {
            TileKind::Floor | TileKind::TallGrass | TileKind::Path | TileKind::Sand => true,
            TileKind::Wall
            | TileKind::ShallowWater
            | TileKind::DeepWater
            | TileKind::Rock
            | TileKind::Tree
            | TileKind::Bush => false,
        }
    }

    /// `true` for the one class that can start a wild encounter when stepped
    /// onto (`TileMap::is_grass` reads this layer).
    #[must_use]
    pub fn is_encounter(self) -> bool {
        match self {
            TileKind::TallGrass => true,
            TileKind::Floor
            | TileKind::Wall
            | TileKind::Path
            | TileKind::Sand
            | TileKind::ShallowWater
            | TileKind::DeepWater
            | TileKind::Rock
            | TileKind::Tree
            | TileKind::Bush => false,
        }
    }
}

/// An NPC's interaction role: the server-anchored enum column
/// that drives the client's context-sensitive interact key. Payloads
/// cross-reference the content registries — `Shop(shop_id)` → `ShopDef.id`,
/// `Heal(location_id)` → `HealLocationDef.location_id` — validated by
/// `content::validate_npc_interactions`. Grows with its milestone; the
/// exhaustive `match` will then compiler-flag every site (OCP-inverted
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum NpcInteraction {
    /// Plain conversation — the `#[serde(default)]` every legacy NPC row inherits.
    #[default]
    Dialogue,
    /// Shopkeeper: the greet-then-shop affordance binds the shop overlay to this shop id.
    Shop(u32),
    /// Heal-provider NPC: binds the heal overlay to this heal-location id.
    Heal(u32),
}

/// A character's authoritative movement state. Zone-agnostic — the entity's
/// `zone_id` lives on the table (M2); `apply_move` works within the one `TileMap`
/// it is handed.
// No `SpacetimeType` derive — M2 FLATTENS `CharacterState` into table columns
// (tile_x/tile_y/facing/action/move_started_at_ms) via a thin convert seam, so it
// is never stored as one opaque column (and it holds `Millis`, which has none).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CharacterState {
    pub pos: TilePos,
    pub facing: Direction,
    pub action: ActionState,
    /// Stamped from `now` on every `apply_move` (move, bump, or hop) — bookkeeping/
    /// ordering for the renderer, NOT an interpolation clock; M3's reconciler never
    /// diffs it.
    pub move_started_at: Millis,
}

// --- Flat codes (for the wasm-boundary parity helper; total mappings) ---------

#[must_use]
pub fn dir_code(d: Direction) -> u8 {
    match d {
        Direction::North => 0,
        Direction::South => 1,
        Direction::East => 2,
        Direction::West => 3,
    }
}

#[must_use]
pub fn dir_from_code(c: u8) -> Option<Direction> {
    match c {
        0 => Some(Direction::North),
        1 => Some(Direction::South),
        2 => Some(Direction::East),
        3 => Some(Direction::West),
        _ => None,
    }
}

#[must_use]
pub fn action_code(a: ActionState) -> u8 {
    match a {
        ActionState::Idle => 0,
        ActionState::Walking => 1,
        ActionState::Jumping => 2,
    }
}

#[must_use]
pub fn action_from_code(c: u8) -> Option<ActionState> {
    match c {
        0 => Some(ActionState::Idle),
        1 => Some(ActionState::Walking),
        2 => Some(ActionState::Jumping),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{Direction, TileKind, TilePos};
    use proptest::prelude::*;

    #[test]
    fn step_moves_one_tile_each_direction() {
        let p = TilePos { x: 5, y: 5 };
        assert_eq!(p.step(Direction::North), TilePos { x: 5, y: 4 });
        assert_eq!(p.step(Direction::South), TilePos { x: 5, y: 6 });
        assert_eq!(p.step(Direction::East), TilePos { x: 6, y: 5 });
        assert_eq!(p.step(Direction::West), TilePos { x: 4, y: 5 });
    }

    #[test]
    fn step_saturates_at_i32_bounds_never_wraps() {
        let hi = TilePos {
            x: i32::MAX,
            y: i32::MAX,
        };
        assert_eq!(hi.step(Direction::East), hi); // saturates, no wrap/panic
        assert_eq!(hi.step(Direction::South), hi);
        let lo = TilePos {
            x: i32::MIN,
            y: i32::MIN,
        };
        assert_eq!(lo.step(Direction::West), lo);
        assert_eq!(lo.step(Direction::North), lo);
    }

    #[test]
    fn tile_kind_from_char_rejects_unknown() {
        assert!(TileKind::from_char('X').is_err());
        assert_eq!(TileKind::from_char('.'), Ok(TileKind::Floor));
        assert!(!TileKind::from_char('#').unwrap().is_walkable());
    }

    proptest! {
        // Serde round-trip identity — the wire contract the WASM/TS + STDB
        // boundaries depend on (using RON as a serde format proxy).
        #[test]
        fn tilepos_serde_round_trips(x in any::<i32>(), y in any::<i32>()) {
            let p = TilePos { x, y };
            let s = ron::to_string(&p).unwrap();
            let back: TilePos = ron::from_str(&s).unwrap();
            prop_assert_eq!(p, back);
        }

        // step never changes a coordinate by more than one (saturation included).
        #[test]
        fn step_distance_at_most_one(x in any::<i32>(), y in any::<i32>(), d in 0u8..4) {
            let dir = super::dir_from_code(d).expect("d in 0..4 is a valid dir code");
            let p = TilePos { x, y };
            let q = p.step(dir);
            prop_assert!((i64::from(q.x) - i64::from(p.x)).abs() <= 1);
            prop_assert!((i64::from(q.y) - i64::from(p.y)).abs() <= 1);
        }
    }

    // -----------------------------------------------------------------------
    // Nightly mutation hardening: the flat codes are a total, exact mapping.
    // -----------------------------------------------------------------------

    /// Kills: `dir_code`/`action_code` constant-replacement mutants and every
    /// deleted `dir_from_code`/`action_from_code` match arm.
    #[test]
    fn flat_codes_are_exact_and_roundtrip() {
        use super::{
            action_code, action_from_code, dir_code, dir_from_code, ActionState, Direction,
        };
        assert_eq!(dir_code(Direction::North), 0);
        assert_eq!(dir_code(Direction::South), 1);
        assert_eq!(dir_code(Direction::East), 2);
        assert_eq!(dir_code(Direction::West), 3);
        for d in [
            Direction::North,
            Direction::South,
            Direction::East,
            Direction::West,
        ] {
            assert_eq!(
                dir_from_code(dir_code(d)).expect("dir_code output is a valid code"),
                d
            );
        }
        assert_eq!(action_code(ActionState::Idle), 0);
        assert_eq!(action_code(ActionState::Walking), 1);
        assert_eq!(action_code(ActionState::Jumping), 2);
        for a in [
            ActionState::Idle,
            ActionState::Walking,
            ActionState::Jumping,
        ] {
            assert_eq!(
                action_from_code(action_code(a)).expect("action_code output is a valid code"),
                a
            );
        }
    }

    /// Proof-of-teeth: invalid codes return None (kills any impl that keeps the
    /// silent default coercion).
    #[test]
    fn dir_from_code_rejects_invalid_codes() {
        use super::{dir_from_code, Direction};
        assert_eq!(dir_from_code(4), None, "code 4 is out of range");
        assert_eq!(dir_from_code(255), None, "code 255 is out of range");
        // Valid boundary
        assert_eq!(dir_from_code(0), Some(Direction::North));
        assert_eq!(dir_from_code(3), Some(Direction::West));
    }

    #[test]
    fn action_from_code_rejects_invalid_codes() {
        use super::{action_from_code, ActionState};
        assert_eq!(action_from_code(3), None, "code 3 is out of range");
        assert_eq!(action_from_code(255), None, "code 255 is out of range");
        // Valid boundary
        assert_eq!(action_from_code(0), Some(ActionState::Idle));
        assert_eq!(action_from_code(2), Some(ActionState::Jumping));
    }

    // --- wap-1: needs the new TileKind API (compile-red before the slice) ---

    /// The terrain class table (M-world-art-pass spec, class table), HAND-TYPED:
    /// `(glyph, Tiled GID, walkable, encounter, wire name)`. Never derived from the
    /// implementation. An exhaustive `match` with no `_` arm, so an 11th variant
    /// compile-fails this roster until the table here is extended too.
    fn class_row(k: TileKind) -> (char, u32, bool, bool, &'static str) {
        match k {
            TileKind::Floor => ('.', 1, true, false, "Floor"),
            TileKind::Wall => ('#', 0, false, false, "Wall"),
            TileKind::TallGrass => ('~', 2, true, true, "TallGrass"),
            TileKind::Path => ('=', 3, true, false, "Path"),
            TileKind::Sand => (':', 4, true, false, "Sand"),
            TileKind::ShallowWater => ('w', 5, false, false, "ShallowWater"),
            TileKind::DeepWater => ('W', 6, false, false, "DeepWater"),
            TileKind::Rock => ('^', 7, false, false, "Rock"),
            TileKind::Tree => ('T', 8, false, false, "Tree"),
            TileKind::Bush => ('*', 9, false, false, "Bush"),
        }
    }

    /// The ten classes in the table's row order = the required declaration order
    /// (serde / `SpacetimeType` positional order). Hand-typed.
    const TABLE_ORDER: [TileKind; 10] = [
        TileKind::Floor,
        TileKind::Wall,
        TileKind::TallGrass,
        TileKind::Path,
        TileKind::Sand,
        TileKind::ShallowWater,
        TileKind::DeepWater,
        TileKind::Rock,
        TileKind::Tree,
        TileKind::Bush,
    ];

    /// WAP1.1: every class glyph parses to its `TileKind`, and `glyph()` is the
    /// exact inverse.
    /// Kills: a swapped glyph pair (`'w'`/`'W'`, `'^'`/`'*'`), a new glyph left
    /// unmapped in `from_char` (still a load error), or a `glyph()` arm returning
    /// another class's char.
    #[test]
    fn every_class_glyph_parses_to_its_tilekind_and_back_wap1_1() {
        for k in TABLE_ORDER {
            let (glyph, _, _, _, name) = class_row(k);
            assert_eq!(
                TileKind::from_char(glyph),
                Ok(k),
                "glyph {glyph:?} must parse to {name}"
            );
            assert_eq!(k.glyph(), glyph, "{name}.glyph() must be {glyph:?}");
        }
    }

    /// WAP1.1: walkability and the encounter flag are exactly the class table's.
    /// Kills: water/rock/tree/bush made walkable, path/sand left unwalkable, or any
    /// class other than TallGrass flagged as an encounter tile (or TallGrass not).
    #[test]
    fn every_class_has_its_exact_walkable_and_encounter_flags_wap1_1() {
        for k in TABLE_ORDER {
            let (_, _, walkable, encounter, name) = class_row(k);
            assert_eq!(
                (k.is_walkable(), k.is_encounter()),
                (walkable, encounter),
                "{name}: (is_walkable, is_encounter)"
            );
        }
    }

    /// WAP1.1 / WAP1.4 wire contract: a class serializes under its bare variant
    /// name (no serde rename) and parses back from it.
    /// Kills: a `#[serde(rename)]` / `rename_all` on `TileKind` (the TS roster
    /// `TERRAIN_KINDS` would no longer match the wire), or a lossy round-trip.
    #[test]
    fn every_class_serializes_under_its_variant_name_wap1_1() {
        for k in TABLE_ORDER {
            let (_, _, _, _, name) = class_row(k);
            assert_eq!(
                ron::to_string(&k).expect("TileKind serializes"),
                name,
                "{name} wire name"
            );
            assert_eq!(
                ron::from_str::<TileKind>(name).expect("wire name parses back"),
                k,
                "{name} round-trip"
            );
        }
    }

    /// WAP1.1 (R1): declaration order is the table's row order (old variants keep
    /// their positions; the seven new ones are tail-appended) and `TileKind::ALL`
    /// lists all ten in that order.
    /// Kills: a new variant inserted before `TallGrass` (shifts the serde /
    /// `SpacetimeType` tags of stored values), two new variants swapped, or an
    /// `ALL` that omits / reorders a class.
    #[test]
    fn all_lists_the_ten_classes_in_declaration_order_wap1_1() {
        for (i, k) in TABLE_ORDER.iter().enumerate() {
            assert_eq!(*k as usize, i, "{k:?} declaration position");
        }
        assert_eq!(TileKind::ALL.len(), 10);
        assert_eq!(TileKind::ALL, TABLE_ORDER);
        for (i, k) in TileKind::ALL.iter().enumerate() {
            assert_eq!(*k as usize, i, "TileKind::ALL[{i}] = {k:?}");
        }
    }

    /// WAP1.6: every class's Tiled GID maps to it; any other GID is `None`.
    /// Kills: a GID off-by-one (e.g. 5 → DeepWater), a swapped pair, an open-ended
    /// arm that accepts GID 10, or a default class for unknown GIDs.
    #[test]
    fn from_gid_maps_every_class_gid_and_rejects_the_rest_wap1_6() {
        for k in TABLE_ORDER {
            let (_, gid, _, _, name) = class_row(k);
            assert_eq!(TileKind::from_gid(gid), Some(k), "GID {gid} is {name}");
        }
        assert_eq!(TileKind::from_gid(10), None, "GID 10 is not a class");
        assert_eq!(
            TileKind::from_gid(u32::MAX),
            None,
            "u32::MAX is not a class"
        );
    }
}
