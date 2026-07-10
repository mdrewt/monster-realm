//! The movement world: a zone-tagged `TileMap` and the SOLE movement rule
//! `apply_move` — total, pure, deterministic, integer-tile. The server (M2) and
//! the client predictor (M3) both call THIS function, so prediction can never
//! numerically diverge from authority (ADR-0003 SSOT).

use crate::types::{
    action_code, action_from_code, dir_code, dir_from_code, ActionState, CharacterState, Millis,
    MoveInput, TileKind, TilePos,
};

/// Step duration / server tick cadence: one tile per `STEP_MS` ms. Defined ONCE
/// here; the M2 tick/queue consume it.
pub const STEP_MS: i64 = 200;

/// Bounded move-buffer cap (M2 anti-flood; the tick cadence is the real limit).
pub const MOVE_QUEUE_CAP: usize = 2;

/// Party size (slots 0..PARTY_SIZE) — single-sourced; the client + server consume it.
pub const PARTY_SIZE: u8 = 6;

/// The party-slot sentinel meaning "boxed" (not in the party).
pub const PARTY_SLOT_NONE: u8 = 255;

/// Why a party-slot assignment was rejected (pure; never stored or sent on wire).
///
/// Mirrors the `SwapError` pattern (`combat/types.rs`, ADR-0053) — a typed error
/// with `Display` so the reducer can log and convert to `String` without losing
/// context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotError {
    /// `slot` is neither a valid party index (`0..PARTY_SIZE`) nor `PARTY_SLOT_NONE`.
    OutOfRange,
    /// `slot` is a valid party index but is already occupied by another monster.
    Occupied,
}

impl std::fmt::Display for SlotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SlotError::OutOfRange => write!(
                f,
                "slot out of range (0..{PARTY_SIZE} or {PARTY_SLOT_NONE} for box)"
            ),
            SlotError::Occupied => write!(f, "party slot already occupied"),
        }
    }
}

/// Legality check for a party-slot assignment (pure; ADR-0053 SwapError pattern).
///
/// `PARTY_SLOT_NONE` (255, "box") is always legal. A party index must satisfy
/// `slot < PARTY_SIZE` and must not appear in `occupied_slots`. The caller must
/// provide only the PARTY slots (0..PARTY_SIZE) of OTHER monsters — boxed monsters
/// (`party_slot == PARTY_SLOT_NONE`) must be excluded from the slice.
///
/// # Errors
/// - `SlotError::OutOfRange` if `slot != PARTY_SLOT_NONE && slot >= PARTY_SIZE`.
/// - `SlotError::Occupied` if `slot` is a valid party index found in `occupied_slots`.
pub fn check_party_slot(slot: u8, occupied_slots: &[u8]) -> Result<(), SlotError> {
    if slot == PARTY_SLOT_NONE {
        return Ok(());
    }
    if slot >= PARTY_SIZE {
        return Err(SlotError::OutOfRange);
    }
    if occupied_slots.contains(&slot) {
        return Err(SlotError::Occupied);
    }
    Ok(())
}

/// The single M1 zone's hand-authored art (`zone_id = 0`). A `const`-style source
/// until M11 swaps in the Tiled→RON pipeline (ADR-0008); the swap is localized to
/// `zone_0`.
// `~` = tall grass (walkable floor that can trigger a wild encounter, M8). Grass
// is placed only on interior `.` tiles NOT asserted plain by the world/zone_0
// tests: avoid spawn (1,1), (2,1), (3,3), (4,3), (1,0).
const ZONE_0_ROWS: &[&str] = &[
    "##########",
    "#........#",
    "#.~~....~#",
    "#...##..~#",
    "#..~~...~#",
    "#......~~#",
    "##########",
];

/// A zone-tagged, bounds-safe walkability grid (row-major).
///
/// `Serialize` is one-way only (no `Deserialize`): the M3 `client-wasm`
/// `zone_map()` export hands the renderer the SAME map the rule evaluates
/// (visual-SSOT — a hard-coded TS map would visually desync). It is **not**
/// deserialized back, so the `from_rows` parse-don't-validate constructor stays
/// the sole way to build an invariant-holding `TileMap`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TileMap {
    pub zone_id: u32,
    pub width: i32,
    pub height: i32,
    walkable: Vec<bool>,
    /// Parallel, row-major, SAME length as `walkable` — `true` where the tile is
    /// `TallGrass` (M8). Rides the one-way `Serialize` so the TS renderer's grass
    /// overlay reads the SAME layer the rule evaluates (visual-SSOT).
    grass: Vec<bool>,
    /// M11c: warp overlay list — serializes through zone_map() wasm export
    /// (intentional ABI so the TS client always sees the warps field).
    /// `from_rows` produces `warps: vec![]`; `map_for` sets them from ZoneMapDef.
    pub warps: Vec<crate::content::WarpDef>,
}

impl TileMap {
    /// Build a map from string-art rows (`'.'` floor, `'#'` wall). Fails LOUD at
    /// the single offending site on ragged rows or an unknown tile char
    /// (parse-don't-validate, not a silent default).
    ///
    /// # Errors
    /// Returns `Err` if rows are ragged or contain an unknown tile glyph.
    pub fn from_rows(zone_id: u32, rows: &[&str]) -> Result<TileMap, String> {
        build_grid(zone_id, rows)
    }

    #[must_use]
    pub fn in_bounds(&self, p: TilePos) -> bool {
        p.x >= 0 && p.y >= 0 && p.x < self.width && p.y < self.height
    }

    /// An out-of-range tile is a WALL, never a panic (bounds-safe `get`).
    #[must_use]
    pub fn is_walkable(&self, p: TilePos) -> bool {
        if !self.in_bounds(p) {
            return false;
        }
        let idx = p.y as usize * self.width as usize + p.x as usize;
        self.walkable.get(idx).copied().unwrap_or(false)
    }

    /// `true` iff `p` is a tall-grass tile. Out-of-range → `false`, never a panic
    /// (mirrors `is_walkable`).
    #[must_use]
    pub fn is_grass(&self, p: TilePos) -> bool {
        if !self.in_bounds(p) {
            return false;
        }
        let idx = p.y as usize * self.width as usize + p.x as usize;
        self.grass.get(idx).copied().unwrap_or(false)
    }

    /// Returns the warp whose `from` tile equals `p`, or `None`.
    /// Bounds-safe: out-of-range coordinates simply find no match.
    #[must_use]
    pub fn warp_at(&self, p: TilePos) -> Option<&crate::content::WarpDef> {
        self.warps.iter().find(|w| w.from == p)
    }
}

/// Pure trigger geometry: a character "stepped onto grass" iff its position
/// actually CHANGED and the new tile is grass. Fires on floor→grass, grass→grass
/// (entering a NEW grass tile), and a jump that MOVES onto grass; never on a bump,
/// standstill, or blocked move (all of which leave `prev == next`).
#[must_use]
pub fn stepped_onto_grass(prev: TilePos, next: TilePos, map: &TileMap) -> bool {
    prev != next && map.is_grass(next)
}

/// The single M1 zone (`zone_id = 0`). Its art is a compile-time invariant.
#[must_use]
pub fn zone_0() -> TileMap {
    TileMap::from_rows(0, ZONE_0_ROWS).expect("zone_0 art is valid")
}

/// The authoritative, guaranteed-walkable spawn for `zone_0` (one source of truth
/// for the server + tests; never hard-coded elsewhere).
#[must_use]
pub fn spawn() -> TilePos {
    TilePos { x: 1, y: 1 }
}

// ===========================================================================
// M11a: build_grid (private), map_for, validate_zone_maps
// ===========================================================================

/// Private grid builder — the body formerly in `from_rows`. Produces a `TileMap`
/// with `warps: vec![]`; `map_for` sets the warps afterward from the ZoneMapDef.
fn build_grid(zone_id: u32, rows: &[&str]) -> Result<TileMap, String> {
    let height = i32::try_from(rows.len()).map_err(|_| "map too tall".to_string())?;
    let width = i32::try_from(rows.first().map_or(0, |r| r.chars().count()))
        .map_err(|_| "map too wide".to_string())?;
    let mut walkable = Vec::with_capacity((width * height).max(0) as usize);
    let mut grass = Vec::with_capacity((width * height).max(0) as usize);
    for (y, row) in rows.iter().enumerate() {
        let row_len = i32::try_from(row.chars().count()).unwrap_or(i32::MAX);
        if row_len != width {
            return Err(format!(
                "ragged map: row {y} has width {row_len}, expected {width}"
            ));
        }
        for (x, c) in row.chars().enumerate() {
            let kind = TileKind::from_char(c).map_err(|e| format!("{e} at ({x},{y})"))?;
            walkable.push(kind.is_walkable());
            grass.push(matches!(kind, TileKind::TallGrass));
        }
    }
    Ok(TileMap {
        zone_id,
        width,
        height,
        walkable,
        grass,
        warps: vec![],
    })
}

/// Build a `TileMap` for `zone_id` from the given `zone_maps` slice.
/// Sets the warp overlay from the matching `ZoneMapDef`.
///
/// # Errors
/// Returns `Err` (naming `zone_id`) if no matching `ZoneMapDef` is found,
/// or if the rows are ragged / contain an unknown glyph.
pub fn map_for(zone_id: u32, zone_maps: &[crate::content::ZoneMapDef]) -> Result<TileMap, String> {
    let def = zone_maps
        .iter()
        .find(|m| m.zone_id == zone_id)
        .ok_or_else(|| format!("no zone map for zone_id {zone_id}"))?;
    let row_refs: Vec<&str> = def.rows.iter().map(String::as_str).collect();
    let mut map = build_grid(zone_id, &row_refs)?;
    map.warps = def.warps.clone();
    Ok(map)
}

/// Validate a `zone_maps` slice against the `zones` registry.
///
/// Checks (in order):
///
/// 1. All rows build valid TileMaps (well-formedness).
/// 2. zone_ids within zone_maps are unique.
/// 3. Every zone_id in zone_maps exists in the zones registry.
/// 4. Map dims ≤ ZoneDef bounds.
/// 5. Warp source tile is in-bounds and walkable in its own map.
/// 6. Warp to_zone exists in the zones registry.
/// 7. (check 6.5) Warp to_zone has a ZoneMapDef entry.
/// 8. Warp to_tile is walkable in the target map.
///
/// # Errors
/// Returns the first violation found.
pub fn validate_zone_maps(
    zone_maps: &[crate::content::ZoneMapDef],
    zones: &[crate::content::ZoneDef],
) -> Result<(), String> {
    let zone_ids: std::collections::HashSet<u32> = zones.iter().map(|z| z.id).collect();
    let map_zone_ids: std::collections::HashSet<u32> =
        zone_maps.iter().map(|m| m.zone_id).collect();

    // Check 1: build (and validate) all grids once; reused by checks 4 and 5–7.
    let built: Vec<TileMap> = zone_maps
        .iter()
        .map(|m| {
            let row_refs: Vec<&str> = m.rows.iter().map(String::as_str).collect();
            build_grid(m.zone_id, &row_refs)
                .map_err(|e| format!("zone_map zone_id {}: {}", m.zone_id, e))
        })
        .collect::<Result<_, _>>()?;

    // Check 2: unique zone_id
    {
        let mut seen = std::collections::HashSet::new();
        for m in zone_maps {
            if !seen.insert(m.zone_id) {
                return Err(format!("zone_maps: duplicate zone_id {}", m.zone_id));
            }
        }
    }

    // Check 3: every zone_id in zones registry
    for m in zone_maps {
        if !zone_ids.contains(&m.zone_id) {
            return Err(format!(
                "zone_map has zone_id {} not found in zones registry",
                m.zone_id
            ));
        }
    }

    // Check 4: map dims <= ZoneDef bounds
    for (m, tile_map) in zone_maps.iter().zip(built.iter()) {
        if let Some(zone_def) = zones.iter().find(|z| z.id == m.zone_id) {
            let max_w = i32::try_from(zone_def.width).map_err(|_| {
                format!(
                    "zone_def zone_id {}: width {} out of i32 range",
                    m.zone_id, zone_def.width
                )
            })?;
            let max_h = i32::try_from(zone_def.height).map_err(|_| {
                format!(
                    "zone_def zone_id {}: height {} out of i32 range",
                    m.zone_id, zone_def.height
                )
            })?;
            if tile_map.width > max_w || tile_map.height > max_h {
                return Err(format!(
                    "zone_map zone_id {}: map {}×{} exceeds ZoneDef bounds {}×{}",
                    m.zone_id, tile_map.width, tile_map.height, zone_def.width, zone_def.height
                ));
            }
        }
    }

    // Checks 5–7: warp validation
    for (m, src_map) in zone_maps.iter().zip(built.iter()) {
        let mut seen_sources = std::collections::HashSet::new();
        for warp in &m.warps {
            // Check 5a: duplicate warp source positions are unreachable via warp_at (find returns first)
            if !seen_sources.insert(warp.from) {
                return Err(format!(
                    "zone_map zone_id {}: duplicate warp source {:?}",
                    m.zone_id, warp.from
                ));
            }

            // Check 5b: warp source in-bounds + walkable
            if !src_map.is_walkable(warp.from) {
                return Err(format!(
                    "zone_map zone_id {}: warp source {:?} is not walkable",
                    m.zone_id, warp.from
                ));
            }

            // Check 6: warp to_zone in zones registry
            if !zone_ids.contains(&warp.to_zone) {
                return Err(format!(
                    "zone_map zone_id {}: warp to_zone {} not in zones registry",
                    m.zone_id, warp.to_zone
                ));
            }

            // Check 6.5: warp to_zone has a ZoneMapDef
            if !map_zone_ids.contains(&warp.to_zone) {
                return Err(format!(
                    "zone_map zone_id {}: warp to_zone {} exists in zones registry but has no ZoneMapDef",
                    m.zone_id, warp.to_zone
                ));
            }

            // Check 7: warp to_tile walkable in target map
            let target_idx = zone_maps
                .iter()
                .position(|x| x.zone_id == warp.to_zone)
                .unwrap(); // guaranteed by check 6.5
            if !built[target_idx].is_walkable(warp.to_tile) {
                return Err(format!(
                    "zone_map zone_id {}: warp to_tile {:?} in zone {} is not walkable",
                    m.zone_id, warp.to_tile, warp.to_zone
                ));
            }
        }
    }

    Ok(())
}

/// The SOLE movement rule — total, pure, deterministic. A bump (blocked step) or a
/// blocked jump is a legal no-op, never an `Err`. `move_started_at` is stamped on
/// EVERY call.
#[must_use]
pub fn apply_move(
    state: &CharacterState,
    input: MoveInput,
    map: &TileMap,
    now: Millis,
) -> CharacterState {
    let mut next = *state;
    next.move_started_at = now;
    match input {
        MoveInput::Step(dir) => {
            next.facing = dir; // you always turn to face, even into a wall
            let target = state.pos.step(dir);
            if map.is_walkable(target) {
                next.pos = target;
                next.action = ActionState::Walking;
            } else {
                next.action = ActionState::Idle; // bump: a legal no-op
            }
        }
        MoveInput::Jump => {
            next.action = ActionState::Jumping;
            let target = state.pos.step(state.facing); // facing unchanged
            if map.is_walkable(target) {
                next.pos = target;
            }
            // blocked jump = hop in place
        }
    }
    // Invariant: an in-bounds character stays in-bounds (vacuous for an already
    // out-of-bounds state — apply_move must remain total over arbitrary input).
    debug_assert!(
        !map.in_bounds(state.pos) || map.in_bounds(next.pos),
        "apply_move must keep an in-bounds character in-bounds"
    );
    next
}

/// Flat-code parity helper over `zone_0()`: shared by the native bin and the wasm
/// export so the movement-parity eval compares the SAME `apply_move` compiled for
/// two targets, not two encodings. Returns `[x, y, facing_code, action_code]`.
///
/// # Errors
/// Returns `Err` if any of `facing`, `action`, or `step_dir` (when `input_kind == 0`)
/// is not a valid code — fail-loud parity with the serde path (`apply_move` wasm export).
#[allow(clippy::too_many_arguments)]
pub fn apply_move_coded(
    x: i32,
    y: i32,
    facing: u8,
    action: u8,
    started_ms: i64,
    input_kind: u8,
    step_dir: u8,
    now_ms: i64,
) -> Result<[i32; 4], String> {
    let state = CharacterState {
        pos: TilePos { x, y },
        facing: dir_from_code(facing).ok_or_else(|| format!("invalid facing code: {facing}"))?,
        action: action_from_code(action).ok_or_else(|| format!("invalid action code: {action}"))?,
        move_started_at: Millis(started_ms),
    };
    let input = if input_kind == 0 {
        MoveInput::Step(
            dir_from_code(step_dir).ok_or_else(|| format!("invalid step_dir code: {step_dir}"))?,
        )
    } else {
        MoveInput::Jump
    };
    let out = apply_move(&state, input, &zone_0(), Millis(now_ms));
    Ok([
        out.pos.x,
        out.pos.y,
        i32::from(dir_code(out.facing)),
        i32::from(action_code(out.action)),
    ])
}

#[cfg(test)]
mod tests {
    use super::{
        apply_move, map_for, spawn, validate_zone_maps, zone_0, TileMap, MOVE_QUEUE_CAP, STEP_MS,
        ZONE_0_ROWS,
    };
    use crate::content::{WarpDef, ZoneDef, ZoneMapDef};
    use crate::types::{ActionState, CharacterState, Direction, Millis, MoveInput, TilePos};
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // M11a gating tests — map_for, warp_at, validate_zone_maps (START RED)
    //
    // These tests reference types and functions that do NOT exist yet:
    //   WarpDef, ZoneMapDef   — in content.rs (not yet added)
    //   map_for               — in world.rs (not yet added)
    //   validate_zone_maps    — in world.rs (not yet added)
    //   TileMap::warp_at      — new method (not yet added)
    //   TileMap::warps field  — not yet added
    //
    // All tests in this block MUST be RED until the implementation lands.
    // -----------------------------------------------------------------------

    // --- helper: minimal zone registry for fixture use ---------------------

    fn zone_def(id: u32, width: u32, height: u32) -> ZoneDef {
        ZoneDef {
            id,
            name: format!("Zone{id}"),
            width,
            height,
        }
    }

    fn zone_map_def(zone_id: u32, rows: Vec<&str>, warps: Vec<WarpDef>) -> ZoneMapDef {
        ZoneMapDef {
            zone_id,
            rows: rows.into_iter().map(String::from).collect(),
            warps,
        }
    }

    fn walkable_rows_3x3() -> Vec<String> {
        vec!["...".to_string(), "...".to_string(), "...".to_string()]
    }

    // -----------------------------------------------------------------------
    // Backward-compat guard — from_rows must keep warps empty (must stay GREEN
    // after the warps field is added; included here so the guard lives next to
    // its kin and fails loud if a refactor breaks the empty-warps invariant).
    // This test compiles only once TileMap gains the `warps` field (RED until
    // field added, GREEN after).
    // -----------------------------------------------------------------------

    /// Criterion: `from_rows` stays unchanged and keeps `warps = []` (backward compat).
    /// Kills: any impl that sets warps on a from_rows-built TileMap.
    #[test]
    fn from_rows_still_produces_empty_warps() {
        let map = TileMap::from_rows(0, &["...", "...", "..."]).unwrap();
        assert!(
            map.warps.is_empty(),
            "from_rows must keep warps empty for backward compat"
        );
    }

    // -----------------------------------------------------------------------
    // map_for tests
    // -----------------------------------------------------------------------

    /// Criterion: map_for(0, …) produces the SAME walkable grid as zone_0().
    /// Kills: an impl that builds zone_0 differently from from_rows / ZONE_0_ROWS.
    /// A SetMove replayed from different art rows would land on a different tile.
    #[test]
    fn map_for_zone_0_matches_zone_0_art() {
        let rows_strs: Vec<String> = ZONE_0_ROWS.iter().map(|s| s.to_string()).collect();
        let zone_maps = vec![ZoneMapDef {
            zone_id: 0,
            rows: rows_strs,
            warps: vec![],
        }];
        let via_map_for = map_for(0, &zone_maps).expect("map_for(0) must succeed");
        let canonical = zone_0();
        // Grid parity: every (x, y) must agree on walkability and width/height.
        assert_eq!(
            via_map_for.width, canonical.width,
            "width must match zone_0()"
        );
        assert_eq!(
            via_map_for.height, canonical.height,
            "height must match zone_0()"
        );
        for y in 0..canonical.height {
            for x in 0..canonical.width {
                let p = TilePos { x, y };
                assert_eq!(
                    via_map_for.is_walkable(p),
                    canonical.is_walkable(p),
                    "is_walkable mismatch at ({x},{y})"
                );
                assert_eq!(
                    via_map_for.is_grass(p),
                    canonical.is_grass(p),
                    "is_grass mismatch at ({x},{y})"
                );
            }
        }
    }

    /// Honest drift gate: zone_0() SSOT (ZONE_0_ROWS in code) MUST match the
    /// authored RON in `content/zone_maps/000-core.ron` (loaded via load_zone_maps).
    ///
    /// The previous test `map_for_zone_0_matches_zone_0_art` is tautological —
    /// it builds the comparison ZoneMapDef from the SAME in-code ZONE_0_ROWS
    /// constant that `zone_0()` reads, so it can never detect drift between the
    /// code constant and the authored content file (12.5f-1).
    ///
    /// Kill target: an edit to ZONE_0_ROWS WITHOUT updating the RON (or vice
    /// versa) — the tautological test passes; THIS test fails loud.
    #[test]
    fn zone_0_matches_authored_ron() {
        let zone_maps = crate::content::load_zone_maps()
            .expect("embedded zone_maps RON must parse (content/zone_maps/000-core.ron)");
        let via_ron = map_for(0, &zone_maps).expect(
            "zone 0 must have a ZoneMapDef in the embedded RON (content/zone_maps/000-core.ron)",
        );
        let canonical = zone_0();

        // Grid parity (width / height / every tile walkable + grass flag).
        assert_eq!(
            via_ron.width, canonical.width,
            "zone_0 code width != authored RON width — ZONE_0_ROWS and the RON have drifted"
        );
        assert_eq!(
            via_ron.height, canonical.height,
            "zone_0 code height != authored RON height — ZONE_0_ROWS and the RON have drifted"
        );
        for y in 0..canonical.height {
            for x in 0..canonical.width {
                let p = TilePos { x, y };
                assert_eq!(
                    via_ron.is_walkable(p),
                    canonical.is_walkable(p),
                    "walkability mismatch at ({x},{y}) between ZONE_0_ROWS (code) and the \
                     authored RON — one was changed without the other (12.5f-1 drift gate)"
                );
                assert_eq!(
                    via_ron.is_grass(p),
                    canonical.is_grass(p),
                    "grass mismatch at ({x},{y}) between ZONE_0_ROWS (code) and the \
                     authored RON — one was changed without the other (12.5f-1 drift gate)"
                );
            }
        }

        // Warp parity: zone_0() has warps:vec![] (code constant); the RON has the
        // (5,5)→zone1 warp. Assert that the RON-loaded map carries that warp, and
        // record the known delta (zone_0() intentionally omits warps — it is a
        // pre-M11 convenience function; map_for is the authoritative path).
        assert!(
            via_ron.warp_at(TilePos { x: 5, y: 5 }).is_some(),
            "the authored RON zone 0 must have a warp at (5,5) — \
             kill target: RON that silently removed the zone-crossing warp"
        );
    }

    /// Criterion: map_for(99, …) errors and names "99" in the message.
    /// Kills: an impl that returns a generic error without naming the zone_id.
    #[test]
    fn map_for_unknown_zone_errors() {
        let rows_strs: Vec<String> = ZONE_0_ROWS.iter().map(|s| s.to_string()).collect();
        let zone_maps = vec![ZoneMapDef {
            zone_id: 0,
            rows: rows_strs,
            warps: vec![],
        }];
        let err = map_for(99, &zone_maps).unwrap_err();
        assert!(
            err.contains("99"),
            "error must name the missing zone_id (99), got: {err}"
        );
    }

    /// Criterion: map_for(0, &[]) errors and names "0" in the message.
    /// Kills: an impl that returns a generic "no maps" error without the id.
    #[test]
    fn map_for_error_names_missing_zone_id() {
        let err = map_for(0, &[]).unwrap_err();
        assert!(
            err.contains("0"),
            "error must name the missing zone_id (0), got: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // warp_at tests
    // -----------------------------------------------------------------------

    /// Criterion: warp_at(warp.from) returns Some(&warp) with the correct to_zone.
    /// Kills: an impl that stores warps but never indexes them, or indexes by wrong key.
    #[test]
    fn warp_at_returns_warp_on_source_tile() {
        let warp = WarpDef {
            from: TilePos { x: 2, y: 1 },
            to_zone: 7,
            to_tile: TilePos { x: 1, y: 1 },
        };
        let zone_maps = vec![ZoneMapDef {
            zone_id: 0,
            rows: walkable_rows_3x3(),
            warps: vec![warp.clone()],
        }];
        let map = map_for(0, &zone_maps).expect("map_for must succeed");
        let found = map.warp_at(TilePos { x: 2, y: 1 });
        assert!(found.is_some(), "warp_at source tile must return Some");
        let found = found.unwrap();
        assert_eq!(found.to_zone, 7, "to_zone must match");
        assert_eq!(found.to_tile, TilePos { x: 1, y: 1 }, "to_tile must match");
        assert_eq!(found.from, TilePos { x: 2, y: 1 }, "from must match");
    }

    /// Criterion: warp_at on a tile with no warp returns None.
    /// Kills: an impl that always returns Some or a wrong default.
    #[test]
    fn warp_at_returns_none_for_non_warp_tile() {
        let zone_maps = vec![ZoneMapDef {
            zone_id: 0,
            rows: walkable_rows_3x3(),
            warps: vec![WarpDef {
                from: TilePos { x: 2, y: 2 },
                to_zone: 1,
                to_tile: TilePos { x: 1, y: 1 },
            }],
        }];
        let map = map_for(0, &zone_maps).expect("map_for must succeed");
        // Tile (0, 0) has no warp
        assert!(
            map.warp_at(TilePos { x: 0, y: 0 }).is_none(),
            "warp_at on a non-warp tile must return None"
        );
    }

    /// Criterion: warp_at with out-of-bounds coords returns None and never panics.
    /// Kills: any impl that does an unchecked array index on the coordinate.
    #[test]
    fn warp_at_returns_none_off_map() {
        let zone_maps = vec![ZoneMapDef {
            zone_id: 0,
            rows: walkable_rows_3x3(),
            warps: vec![],
        }];
        let map = map_for(0, &zone_maps).expect("map_for must succeed");
        assert!(
            map.warp_at(TilePos { x: -1, y: -1 }).is_none(),
            "out-of-bounds warp_at must return None"
        );
        assert!(
            map.warp_at(TilePos {
                x: i32::MAX,
                y: i32::MAX
            })
            .is_none(),
            "extreme out-of-bounds warp_at must return None"
        );
    }

    // -----------------------------------------------------------------------
    // TileMap ABI gate: the warps field must survive serialization (M11c contract)
    // -----------------------------------------------------------------------

    /// Criterion: serializing a TileMap includes the "warps" key so M11c clients
    /// always see the field. Kills: an impl that skips warps in serde(skip) or
    /// forgets to add the field to the serializable struct.
    #[test]
    fn tilemap_serialize_shape_has_warps_field() {
        // zone_0() has warps = [] after TileMap gains the warps field.
        // Serialize with RON (the only serde format available in game-core).
        let serialized = ron::to_string(&zone_0()).expect("zone_0() must serialize to RON");
        assert!(
            serialized.contains("warps"),
            "TileMap serialization must include warps field for M11c ABI; got: {serialized}"
        );
    }

    // -----------------------------------------------------------------------
    // validate_zone_maps TEETH tests
    //
    // Proof-of-teeth message pattern mirrors the content.rs precedent:
    // "TEETH: <what was violated> must be rejected, but validation passed"
    // -----------------------------------------------------------------------

    /// TEETH: ragged rows (differing row widths) must be rejected.
    /// Kills: an impl that calls build_grid on rows without propagating its Err.
    #[test]
    fn validate_zone_maps_teeth_ragged_rows() {
        let zone_maps = vec![zone_map_def(
            0,
            vec!["...", ".."], // ragged: width 3 then 2
            vec![],
        )];
        let zones = vec![zone_def(0, 10, 10)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_err(),
            "TEETH: ragged rows must be rejected, but validation passed"
        );
    }

    /// TEETH: two ZoneMapDef entries with the same zone_id must be rejected.
    /// Kills: an impl that skips duplicate-id checks.
    #[test]
    fn validate_zone_maps_teeth_duplicate_zone_id() {
        let zone_maps = vec![
            zone_map_def(0, vec!["..."], vec![]),
            zone_map_def(0, vec!["..."], vec![]), // same id
        ];
        let zones = vec![zone_def(0, 10, 10)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_err(),
            "TEETH: duplicate zone_id in zone_maps must be rejected, but validation passed"
        );
    }

    /// TEETH: a zone_id not present in the zones registry must be rejected.
    /// Kills: an impl that skips cross-registry presence checks.
    #[test]
    fn validate_zone_maps_teeth_zone_id_not_in_registry() {
        let zone_maps = vec![zone_map_def(99, vec!["..."], vec![])];
        let zones = vec![zone_def(0, 10, 10), zone_def(1, 10, 10)]; // only 0 and 1
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_err(),
            "TEETH: zone_id 99 not in zones registry must be rejected, but validation passed"
        );
    }

    /// TEETH: a warp whose to_zone doesn't exist in the zones registry must be rejected.
    /// Kills: an impl that validates zone_id membership but skips warp target checks.
    #[test]
    fn validate_zone_maps_teeth_dangling_warp_to_zone() {
        let zone_maps = vec![zone_map_def(
            0,
            vec!["...", "..."],
            vec![WarpDef {
                from: TilePos { x: 1, y: 1 },
                to_zone: 99, // not in zones registry
                to_tile: TilePos { x: 1, y: 1 },
            }],
        )];
        let zones = vec![zone_def(0, 10, 10)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_err(),
            "TEETH: warp to_zone=99 not in zones registry must be rejected, but validation passed"
        );
    }

    /// TEETH: a warp to_zone that exists in zones but has no ZoneMapDef must be rejected.
    /// Kills: an impl that checks zone membership but misses the 6.5 map-presence check.
    #[test]
    fn validate_zone_maps_teeth_warp_to_zone_no_map() {
        // zone 1 exists in zones, but there is no ZoneMapDef for it
        let zone_maps = vec![zone_map_def(
            0,
            vec!["...", "..."],
            vec![WarpDef {
                from: TilePos { x: 1, y: 1 },
                to_zone: 1,
                to_tile: TilePos { x: 1, y: 1 },
            }],
        )];
        let zones = vec![zone_def(0, 10, 10), zone_def(1, 10, 10)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_err(),
            "TEETH: warp to_zone=1 has no ZoneMapDef (check 6.5) must be rejected, but validation passed"
        );
    }

    /// TEETH: a warp whose to_tile is a wall (not walkable) in the target map must be rejected.
    /// Kills: an impl that validates warp presence but skips target-tile walkability.
    #[test]
    fn validate_zone_maps_teeth_warp_target_not_walkable() {
        // zone 1 has a wall border; (0,0) is a wall
        let zone_maps = vec![
            zone_map_def(
                0,
                vec!["...", "..."],
                vec![WarpDef {
                    from: TilePos { x: 1, y: 1 },
                    to_zone: 1,
                    to_tile: TilePos { x: 0, y: 0 }, // wall in zone 1
                }],
            ),
            zone_map_def(1, vec!["###", "#.#", "###"], vec![]), // (0,0) is '#'
        ];
        let zones = vec![zone_def(0, 10, 10), zone_def(1, 10, 10)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_err(),
            "TEETH: warp to_tile (0,0) is a wall in target zone — must be rejected, but validation passed"
        );
    }

    /// TEETH: a warp whose source tile (from) is a wall in its own map must be rejected.
    /// Kills: an impl that only checks the target but skips the source-tile walkability.
    #[test]
    fn validate_zone_maps_teeth_warp_source_not_walkable() {
        // zone 0 has a wall at (0,0); warp source is that wall
        let zone_maps = vec![
            zone_map_def(
                0,
                vec!["###", "#.#", "###"], // (0,0) is '#'
                vec![WarpDef {
                    from: TilePos { x: 0, y: 0 }, // wall — invalid warp source
                    to_zone: 1,
                    to_tile: TilePos { x: 1, y: 1 },
                }],
            ),
            zone_map_def(1, vec!["...", "...", "..."], vec![]),
        ];
        let zones = vec![zone_def(0, 10, 10), zone_def(1, 10, 10)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_err(),
            "TEETH: warp from tile (0,0) is a wall — must be rejected, but validation passed"
        );
    }

    /// TEETH: a map whose dimensions exceed the zone_def bounds must be rejected.
    /// Kills: an impl that builds the grid but skips the dims ≤ ZoneDef check.
    #[test]
    fn validate_zone_maps_teeth_oversize_map() {
        // zone_def says 3×3 but the map is 5 columns × 2 rows
        let zone_maps = vec![zone_map_def(
            0,
            vec![".....", "....."], // 5 wide × 2 tall
            vec![],
        )];
        // zone_def declares 3×3 — the map is WIDER than allowed
        let zones = vec![zone_def(0, 3, 3)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_err(),
            "TEETH: map 5×2 exceeds zone_def 3×3 — must be rejected, but validation passed"
        );
    }

    // -----------------------------------------------------------------------
    // Red-team gating tests (M11a hardening)
    // -----------------------------------------------------------------------

    /// Gate: validate_zone_maps must reject two warps with the same 'from' tile.
    ///
    /// warp_at uses iter().find() and returns the FIRST match. If two WarpDefs
    /// share the same `from` position, the second is silently unreachable — the
    /// player can never trigger it. An authoring error that creates a shadowed warp
    /// must be caught at validation time, not silently lost at runtime.
    ///
    /// Kills: any impl that allows duplicate warp source positions to pass
    /// validate_zone_maps.
    #[test]
    fn validate_zone_maps_rejects_duplicate_warp_source() {
        let zone_maps = vec![
            zone_map_def(
                0,
                vec!["...", "...", "..."],
                vec![
                    WarpDef {
                        from: TilePos { x: 1, y: 1 },
                        to_zone: 1,
                        to_tile: TilePos { x: 1, y: 1 },
                    },
                    WarpDef {
                        from: TilePos { x: 1, y: 1 }, // duplicate source — shadows first
                        to_zone: 1,
                        to_tile: TilePos { x: 2, y: 2 },
                    },
                ],
            ),
            zone_map_def(1, vec!["...", "...", "..."], vec![]),
        ];
        let zones = vec![zone_def(0, 10, 10), zone_def(1, 10, 10)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_err(),
            "duplicate warp source (1,1) in same zone must be rejected (second warp is silently shadowed by warp_at)"
        );
    }

    // -----------------------------------------------------------------------
    // Proptest: warp_at is bounds-safe over arbitrary coordinates
    // -----------------------------------------------------------------------

    proptest! {
        /// Criterion: warp_at never panics for any i32 coordinate pair.
        /// Kills: any impl with an unchecked array index on the warp lookup.
        #[test]
        fn warp_at_never_panics(x in any::<i32>(), y in any::<i32>()) {
            let rows_strs: Vec<String> = ZONE_0_ROWS.iter().map(|s| s.to_string()).collect();
            let zone_maps = vec![ZoneMapDef {
                zone_id: 0,
                rows: rows_strs,
                warps: vec![WarpDef {
                    from: TilePos { x: 2, y: 1 },
                    to_zone: 1,
                    to_tile: TilePos { x: 1, y: 1 },
                }],
            }];
            let map = map_for(0, &zone_maps).unwrap();
            // Must not panic over any coordinate — correct assertion in block-body form
            let _result = map.warp_at(TilePos { x, y });
        }
    }

    fn at(x: i32, y: i32, facing: Direction) -> CharacterState {
        CharacterState {
            pos: TilePos { x, y },
            facing,
            action: ActionState::Idle,
            move_started_at: Millis(0),
        }
    }

    #[test]
    fn from_rows_rejects_ragged() {
        assert!(TileMap::from_rows(0, &["...", ".."]).is_err());
    }

    #[test]
    fn from_rows_rejects_unknown_char() {
        assert!(TileMap::from_rows(0, &["..X"]).is_err());
    }

    #[test]
    fn spawn_is_walkable_in_zone_0() {
        assert!(zone_0().is_walkable(spawn()));
    }

    #[test]
    fn out_of_bounds_is_a_wall_not_a_panic() {
        let m = zone_0();
        assert!(!m.is_walkable(TilePos { x: -1, y: 0 }));
        assert!(!m.is_walkable(TilePos {
            x: i32::MAX,
            y: i32::MAX
        }));
        assert!(!m.in_bounds(TilePos { x: 1000, y: 1000 }));
    }

    #[test]
    fn step_into_floor_moves_and_faces() {
        let m = zone_0();
        let s = at(1, 1, Direction::North);
        let r = apply_move(&s, MoveInput::Step(Direction::East), &m, Millis(STEP_MS));
        assert_eq!(r.pos, TilePos { x: 2, y: 1 });
        assert_eq!(r.facing, Direction::East);
        assert_eq!(r.action, ActionState::Walking);
        assert_eq!(r.move_started_at, Millis(STEP_MS));
    }

    #[test]
    fn step_into_wall_bumps_but_still_faces() {
        let m = zone_0();
        let s = at(1, 1, Direction::East);
        let r = apply_move(&s, MoveInput::Step(Direction::North), &m, Millis(7)); // (1,0) is border wall
        assert_eq!(r.pos, TilePos { x: 1, y: 1 }); // unchanged
        assert_eq!(r.facing, Direction::North); // still turned
        assert_eq!(r.action, ActionState::Idle);
        assert_eq!(r.move_started_at, Millis(7)); // stamped on a bump too
    }

    #[test]
    fn jump_into_floor_moves_keeps_facing() {
        let m = zone_0();
        let s = at(1, 1, Direction::East);
        let r = apply_move(&s, MoveInput::Jump, &m, Millis(5));
        assert_eq!(r.pos, TilePos { x: 2, y: 1 });
        assert_eq!(r.facing, Direction::East); // unchanged
        assert_eq!(r.action, ActionState::Jumping);
    }

    #[test]
    fn jump_into_wall_hops_in_place() {
        let m = zone_0();
        let s = at(3, 3, Direction::East); // (4,3) is the inner wall
        let r = apply_move(&s, MoveInput::Jump, &m, Millis(9));
        assert_eq!(r.pos, TilePos { x: 3, y: 3 }); // unchanged
        assert_eq!(r.action, ActionState::Jumping);
        assert_eq!(r.facing, Direction::East);
    }

    #[test]
    fn constants_are_the_single_source() {
        assert_eq!(STEP_MS, 200);
        assert_eq!(MOVE_QUEUE_CAP, 2);
    }

    proptest! {
        // Totality + determinism over arbitrary states (incl. extreme coords).
        #[test]
        fn apply_move_is_total_and_deterministic(
            x in any::<i32>(), y in any::<i32>(), f in 0u8..4, ik in 0u8..2, sd in 0u8..4, now in any::<i64>(),
        ) {
            let m = zone_0();
            let s = CharacterState {
                pos: TilePos { x, y },
                facing: crate::types::dir_from_code(f).expect("f in 0..4 is valid"),
                action: ActionState::Idle,
                move_started_at: Millis(0),
            };
            let input = if ik == 0 {
                MoveInput::Step(crate::types::dir_from_code(sd).expect("sd in 0..4 is valid"))
            } else {
                MoveInput::Jump
            };
            let a = apply_move(&s, input, &m, Millis(now));
            let b = apply_move(&s, input, &m, Millis(now));
            prop_assert_eq!(a, b); // determinism
            prop_assert_eq!(a.move_started_at, Millis(now)); // stamped every call
            // pos changes by at most one tile (Manhattan), saturation included
            prop_assert!((i64::from(a.pos.x) - i64::from(x)).abs() + (i64::from(a.pos.y) - i64::from(y)).abs() <= 1);
        }

        // In-bounds is preserved for a valid (in-bounds) starting character, and a
        // successful Step ends adjacent + walkable; a bump keeps pos.
        #[test]
        fn step_invariants_from_in_bounds(
            x in 0i32..10, y in 0i32..7, sd in 0u8..4, now in any::<i64>(),
        ) {
            let m = zone_0();
            let start = TilePos { x, y };
            prop_assume!(m.in_bounds(start));
            let s = CharacterState {
                pos: start, facing: Direction::South, action: ActionState::Idle, move_started_at: Millis(0),
            };
            let dir = crate::types::dir_from_code(sd).expect("sd in 0..4 is valid");
            let r = apply_move(&s, MoveInput::Step(dir), &m, Millis(now));
            prop_assert_eq!(r.facing, dir); // always face the input dir
            if r.pos == start {
                prop_assert_eq!(r.action, ActionState::Idle); // bump
            } else {
                prop_assert_eq!(r.pos, start.step(dir)); // moved exactly one step
                prop_assert!(m.is_walkable(r.pos)); // onto a walkable tile
                prop_assert_eq!(r.action, ActionState::Walking);
            }
            prop_assert!(m.in_bounds(r.pos)); // in-bounds preserved
        }
    }

    // -----------------------------------------------------------------------
    // Nightly mutation hardening.
    // -----------------------------------------------------------------------

    /// Kills: `p.x < self.width` -> `<=` (96:57) and the y-axis twin.
    /// Probes exactly-at-dimension coordinates on a 3x3 map.
    #[test]
    fn in_bounds_rejects_exact_width_and_height() {
        let map = TileMap::from_rows(9, &["...", "...", "..."]).expect("valid 3x3 map");
        assert!(map.in_bounds(TilePos { x: 2, y: 2 }));
        assert!(!map.in_bounds(TilePos { x: 3, y: 0 }), "x == width is out");
        assert!(!map.in_bounds(TilePos { x: 0, y: 3 }), "y == height is out");
        assert!(!map.in_bounds(TilePos { x: -1, y: 0 }));
        assert!(!map.in_bounds(TilePos { x: 0, y: -1 }));
    }

    /// Kills: the `apply_move_coded -> [0;4]/[1;4]/[-1;4]` constant
    /// replacements (199:5) and the `input_kind == 0` -> `!=` flip (205:31).
    /// Golden outputs from the current impl: a step East from spawn walks to
    /// (2,1) facing East; a jump stays at (1,1) facing North in Jumping.
    /// Step and jump outputs differ, so swapping the branch is observable.
    #[test]
    fn apply_move_coded_golden_step_and_jump() {
        let step =
            super::apply_move_coded(1, 1, 0, 0, 0, 0, 2, 1000).expect("valid codes must not fail");
        assert_eq!(
            step,
            [2, 1, 2, 1],
            "step East: pos (2,1), facing East, Walking"
        );
        let jump =
            super::apply_move_coded(1, 1, 0, 0, 0, 1, 2, 1000).expect("valid codes must not fail");
        assert_eq!(jump, [1, 1, 0, 2], "jump: pos (1,1), facing North, Jumping");
    }

    /// Proof-of-teeth: invalid codes surface as Err (fail-loud parity with serde path).
    /// Kills: any impl that drops the `?` propagation and silently coerces.
    #[test]
    fn apply_move_coded_rejects_invalid_codes() {
        // Invalid facing
        assert!(
            super::apply_move_coded(0, 0, 4, 0, 0, 0, 0, 0).is_err(),
            "facing=4 is out of range"
        );
        // Invalid action
        assert!(
            super::apply_move_coded(0, 0, 0, 3, 0, 0, 0, 0).is_err(),
            "action=3 is out of range"
        );
        // Invalid step_dir (only checked when input_kind == 0)
        assert!(
            super::apply_move_coded(0, 0, 0, 0, 0, 0, 4, 0).is_err(),
            "step_dir=4 is out of range"
        );
        // input_kind != 0 skips step_dir — invalid step_dir is not an error for a jump
        assert!(
            super::apply_move_coded(0, 0, 0, 0, 0, 1, 99, 0).is_ok(),
            "jump ignores step_dir — invalid step_dir code must not error for a jump"
        );
    }

    // -----------------------------------------------------------------------
    // f-4: check_party_slot proof-of-teeth (ADR-0053 SlotError pattern).
    // -----------------------------------------------------------------------

    /// Kills: any impl that treats PARTY_SLOT_NONE (255) as out-of-range.
    #[test]
    fn check_party_slot_accepts_party_slot_none() {
        use super::{check_party_slot, PARTY_SLOT_NONE};
        assert_eq!(
            check_party_slot(PARTY_SLOT_NONE, &[0, 1, 2, 3, 4, 5]),
            Ok(()),
            "boxing (PARTY_SLOT_NONE) is always valid regardless of occupied slots"
        );
    }

    /// Kills: an off-by-one on the PARTY_SIZE boundary check.
    #[test]
    fn check_party_slot_boundary_at_party_size() {
        use super::{check_party_slot, SlotError, PARTY_SIZE};
        // slot == PARTY_SIZE is out of range (valid slots are 0..PARTY_SIZE)
        assert_eq!(
            check_party_slot(PARTY_SIZE, &[]),
            Err(SlotError::OutOfRange),
            "slot == PARTY_SIZE (6) is out of range"
        );
        // slot == PARTY_SIZE - 1 is the last valid party slot
        assert_eq!(
            check_party_slot(PARTY_SIZE - 1, &[]),
            Ok(()),
            "slot 5 is the last valid party slot"
        );
        // slot 254 is also out of range
        assert_eq!(check_party_slot(254, &[]), Err(SlotError::OutOfRange));
    }

    /// Kills: any impl that ignores the occupied_slots list.
    #[test]
    fn check_party_slot_rejects_occupied_slot() {
        use super::{check_party_slot, SlotError};
        assert_eq!(
            check_party_slot(2, &[0, 2, 5]),
            Err(SlotError::Occupied),
            "slot 2 is occupied"
        );
        // Slot 3 is NOT occupied — must be Ok
        assert_eq!(check_party_slot(3, &[0, 2, 5]), Ok(()));
    }

    /// Kills: swapped Display strings between OutOfRange and Occupied.
    #[test]
    fn slot_error_display_is_distinct() {
        use super::SlotError;
        let oor = SlotError::OutOfRange.to_string();
        let occ = SlotError::Occupied.to_string();
        assert_ne!(
            oor, occ,
            "OutOfRange and Occupied must have distinct display strings"
        );
        assert!(
            occ.contains("already occupied"),
            "Occupied display must mention 'already occupied'"
        );
    }

    // -----------------------------------------------------------------------
    // RT-PS-01: party-slot uniqueness is read-then-write, not atomic.
    //
    // The set_party_slot reducer (monster_mgmt.rs) reads occupied_slots from
    // the DB and then calls check_party_slot (pure). Two concurrent connections
    // with the same identity can each read occupied_slots before either write
    // completes — both pass check_party_slot and both write the same slot,
    // producing two monsters at the same party index.
    //
    // The pure layer (check_party_slot) is correct; the race is in the
    // reducer's read-check-write gap. Closing it requires either:
    //   (a) a DB-level unique constraint on (owner_identity, party_slot)
    //       filtered to slots != PARTY_SLOT_NONE, or
    //   (b) an optimistic-lock column (e.g. version) with a compare-and-swap
    //       write that fails if the occupied_slots snapshot is stale.
    //
    // This test documents the invariant that must hold post-fix: the pure
    // function correctly rejects a second assignment to an already-occupied
    // slot even when both monsters were unslotted at the snapshot time,
    // proving that the logic is sound — the race is in the reducer's
    // snapshot timing, not in check_party_slot itself.
    // -----------------------------------------------------------------------

    /// RT-PS-01: check_party_slot is sound — the race is above the pure layer.
    ///
    /// Scenario: two concurrent set_party_slot calls each read the same
    /// occupied_slots snapshot before either write lands. Both call
    /// check_party_slot with an empty (or mismatched) occupied list and
    /// both get Ok — the pure function has no access to the concurrent write.
    ///
    /// This test proves the pure layer IS correct (given a correct snapshot),
    /// and documents that the race must be closed at the reducer/DB level.
    ///
    /// Kills: any refactoring of check_party_slot that removes the
    /// occupied_slots parameter (making the pure function stateful) —
    /// that would be the wrong fix and break the pure layer's testability.
    #[test]
    fn rt_ps_01_concurrent_slot_assignment_requires_db_uniqueness_constraint() {
        use super::{check_party_slot, SlotError, PARTY_SLOT_NONE};

        // Simulate two concurrent reducer executions, each reading occupied_slots
        // BEFORE the other's write has completed. Both see the same snapshot:
        // monster_A and monster_B are both at PARTY_SLOT_NONE (boxed).
        // Neither snapshot includes the other monster's target slot as occupied.
        let snapshot_for_monster_a: &[u8] = &[PARTY_SLOT_NONE]; // monster_B not yet written
        let snapshot_for_monster_b: &[u8] = &[PARTY_SLOT_NONE]; // monster_A not yet written

        // Both reducers check slot=2 against their own snapshot — both pass.
        assert_eq!(
            check_party_slot(2, snapshot_for_monster_a),
            Ok(()),
            "RT-PS-01: first concurrent reducer sees slot 2 as free — passes pure check"
        );
        assert_eq!(
            check_party_slot(2, snapshot_for_monster_b),
            Ok(()),
            "RT-PS-01: second concurrent reducer also sees slot 2 as free — \
             both pass the pure check and both write slot=2, producing a duplicate. \
             This is the race: check_party_slot is correct given its snapshot, but \
             the snapshot is stale. Fix requires a DB uniqueness constraint on \
             (owner_identity, party_slot) for slots != PARTY_SLOT_NONE so the \
             second write fails at the DB level regardless of the read order."
        );

        // The pure function IS correct when given the correct (post-write) snapshot:
        // after monster_A writes slot=2, monster_B's snapshot includes it.
        let correct_snapshot_for_b: &[u8] = &[2]; // monster_A already at slot 2
        assert_eq!(
            check_party_slot(2, correct_snapshot_for_b),
            Err(SlotError::Occupied),
            "RT-PS-01: with a correct post-write snapshot, check_party_slot correctly \
             rejects the duplicate assignment — the pure logic is sound; \
             only the reducer's snapshot timing allows the race"
        );
    }

    // -----------------------------------------------------------------------
    // M11b anchor: real content integration tests.
    //
    // These tests use the REAL embedded zone-map content via `load_zone_maps()`
    // to prove the M11b contract: the RON content in
    // `content/zone_maps/000-core.ron` correctly declares mutual warps between
    // zone 0 and zone 1 at tile (5,5). The server warp runtime (movement_tick)
    // delegates to map_for + warp_at over this real content, so these tests
    // are the integration anchor that proves the data is present before the
    // server logic can be verified.
    //
    // These tests START GREEN (map_for and warp_at already exist from M11a).
    // They are regression anchors — if content is accidentally removed or the
    // warp coordinates change, these tests go RED and catch the regression
    // before the server runtime is affected.
    // -----------------------------------------------------------------------

    /// Criterion: zone 0 real content has a warp at (5,5) targeting zone 1.
    /// Kills: any content edit that removes or changes the zone-0→zone-1 warp
    /// (the movement_tick server runtime reads this warp via map_for + warp_at;
    /// a missing warp means the server can never execute the warp teleport).
    #[test]
    fn zone_0_real_content_has_warp_at_5_5_to_zone_1() {
        use crate::content::load_zone_maps;
        let maps = load_zone_maps().expect("zone maps must load");
        let m = map_for(0, &maps).expect("map_for(0) must succeed");
        let warp = m
            .warp_at(TilePos { x: 5, y: 5 })
            .expect("warp at (5,5) must exist in zone 0");
        assert_eq!(warp.to_zone, 1, "zone 0 warp must target zone 1");
        assert_eq!(
            warp.to_tile,
            TilePos { x: 5, y: 5 },
            "warp to_tile must be (5,5)"
        );
    }

    /// Criterion: zone 1 real content has a return warp at (5,5) targeting zone 0.
    /// Kills: any content edit that removes the zone-1→zone-0 return warp
    /// (mutual warps are required for round-trip zone traversal; a one-way
    /// warp traps the player in zone 1 with no server path back).
    #[test]
    fn zone_1_real_content_has_return_warp_at_5_5_to_zone_0() {
        use crate::content::load_zone_maps;
        let maps = load_zone_maps().expect("zone maps must load");
        let m = map_for(1, &maps).expect("map_for(1) must succeed");
        let warp = m
            .warp_at(TilePos { x: 5, y: 5 })
            .expect("warp at (5,5) must exist in zone 1");
        assert_eq!(warp.to_zone, 0, "zone 1 warp must target zone 0");
    }

    // -----------------------------------------------------------------------
    // fix-nightly (ADR-0088): boundary tests for check 4 (map dims <= ZoneDef
    // bounds). The existing oversize-map test checks width > max_w (already
    // Errs with both `>` and `>=`) and therefore cannot kill the `>`→`>=`
    // width flip. These tests use EXACT-FIT inputs that pass the real guard
    // (`> max` is false) but FAIL under the flip (`>= max` is true → wrongly
    // Errs). Three census mutants targeted below.
    // -----------------------------------------------------------------------

    /// kills: game-core/src/world.rs:250:31: replace > with >= in validate_zone_maps
    ///
    /// A map whose width equals the ZoneDef bound (exact fit) must PASS check 4.
    /// The real `tile_map.width > max_w` is false (3 > 3 is false) → Ok.
    /// `>`→`>=`: `3 >= 3` is true → wrongly Errs.
    #[test]
    fn validate_zone_maps_accepts_width_exactly_equal_to_zone_def_bound() {
        // zone_def 3×10, map 3 wide × 1 tall (exact width fit, well within height).
        let zone_maps = vec![zone_map_def(0, vec!["..."], vec![])];
        let zones = vec![zone_def(0, 3, 10)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_ok(),
            "a map whose width equals the ZoneDef bound must pass check 4; \
             a `>`→`>=` flip makes `3 >= 3` true and wrongly Errs. Error: {:?}",
            result.err()
        );
    }

    /// kills: game-core/src/world.rs:250:58: replace > with == in validate_zone_maps
    /// kills: game-core/src/world.rs:250:58: replace > with >= in validate_zone_maps
    ///
    /// A map whose height equals the ZoneDef bound (exact fit) must PASS check 4.
    /// The real `tile_map.height > max_h` is false (2 > 2 is false) → Ok.
    /// `>`→`==`: `2 == 2` is true → wrongly Errs.
    /// `>`→`>=`: `2 >= 2` is true → wrongly Errs.
    #[test]
    fn validate_zone_maps_accepts_height_exactly_equal_to_zone_def_bound() {
        // zone_def 10×2, map 1 wide × 2 tall (well within width, exact height fit).
        let zone_maps = vec![zone_map_def(0, vec![".", "."], vec![])];
        let zones = vec![zone_def(0, 10, 2)];
        let result = validate_zone_maps(&zone_maps, &zones);
        assert!(
            result.is_ok(),
            "a map whose height equals the ZoneDef bound must pass check 4; \
             `>`→`==` and `>`→`>=` both make 2==2 or 2>=2 true and wrongly Err. Error: {:?}",
            result.err()
        );
    }
}
