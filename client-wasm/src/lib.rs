//! `client-wasm` — the thin client-side prediction shell.
//!
//! Wraps `game-core` (the SAME rule code the server runs) for client-side
//! prediction, exported across the wasm boundary via `wasm-bindgen` and built
//! with `wasm-pack`. It depends on `game-core` WITHOUT the `spacetimedb` feature —
//! the client must never pull a server-only dependency (the feature-isolation
//! eval makes this mechanical).
//!
//! The prediction-parity evals run these exports natively (the server path) and
//! through the wasm-pack build and assert byte-identical output — the anti-desync
//! spine — before any real rule depends on it.

#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::LazyLock;

use wasm_bindgen::prelude::*;

use game_core::{CharacterState, Millis, MoveInput};

/// The active zone id — set by `set_active_zone()` on every zone transition so
/// that `apply_move` always walks the correct zone's tile map.
static ACTIVE_ZONE_ID: AtomicU32 = AtomicU32::new(0);

// Parse the zone registry once per WASM instance lifetime: content is
// compile-time-embedded and immutable between deploys.
// LazyLock<Result<...>> caches both successes and failures; deterministic for
// compile-time-embedded content so caching the error is correct.
static ZONE_MAPS: LazyLock<Result<Vec<game_core::ZoneMapDef>, String>> =
    LazyLock::new(game_core::load_zone_maps);

// Active-zone TileMap: cached to avoid re-running build_grid on every apply_move.
// Invalidated (set to None) in set_active_zone so the first apply_move after a
// zone transition rebuilds for the new zone. thread_local is idiomatic
// for WASM (single-threaded execution model).
thread_local! {
    static ACTIVE_TILE_MAP: RefCell<Option<game_core::TileMap>> = const { RefCell::new(None) };
}

/// Return a reference to the cached zone-maps registry.
///
/// On the first call the embedded RON is parsed and the result stored. All
/// subsequent calls return the cached `&'static` reference (or the cached error).
fn cached_zone_maps() -> Result<&'static Vec<game_core::ZoneMapDef>, String> {
    (*ZONE_MAPS).as_ref().map_err(Clone::clone)
}

/// Set the active zone id for client-side movement prediction. Must be called
/// by the client on every zone warp BEFORE the first `apply_move` in that zone.
///
/// Clears the cached TileMap so the next `apply_move` rebuilds for the new zone
#[wasm_bindgen]
pub fn set_active_zone(zone_id: u32) {
    ACTIVE_ZONE_ID.store(zone_id, Ordering::Relaxed);
    // Invalidate cached TileMap: the new zone has a different layout.
    ACTIVE_TILE_MAP.with(|m| *m.borrow_mut() = None);
}

// ---------------------------------------------------------------------------
// Native-safe serialization helpers (M11c, C6).
//
// `serde_wasm_bindgen` and `JsValue::from_str` panic on non-wasm targets (the
// wasm-bindgen runtime is not available). The native `cargo test` run for C6
// only needs `Result::is_ok()` / `Result::is_err()` — not the actual JsValue
// content. We use `JsValue::UNDEFINED` (a const, no runtime call) as a
// sentinel for both Ok and Err on native, then do real serialization on wasm.
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn zone_map_ok(map: &game_core::TileMap) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(map).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(not(target_arch = "wasm32"))]
fn zone_map_ok(_map: &game_core::TileMap) -> Result<JsValue, JsValue> {
    // Native tests only check .is_ok(); no JsValue runtime call needed.
    Ok(JsValue::UNDEFINED)
}

#[cfg(target_arch = "wasm32")]
fn zone_map_err(msg: String) -> JsValue {
    JsValue::from_str(&msg)
}

#[cfg(not(target_arch = "wasm32"))]
fn zone_map_err(_msg: String) -> JsValue {
    // Native tests only check .is_err(); JsValue::UNDEFINED is a const (no runtime call).
    JsValue::UNDEFINED
}

/// The M0 trivial proof-rule across the wasm boundary (`u64` <-> `BigInt`).
#[wasm_bindgen]
pub fn predict_tick(state: u64, input: u64, seed: u64) -> u64 {
    game_core::tick_seed(state, input, seed)
}

/// Predict movement over `zone_0` — the SAME `apply_move` the server runs, across
/// the wasm boundary, for the movement-parity eval. Flat codes (see game-core):
/// facing/dir 0=N,1=S,2=E,3=W; action 0=Idle,1=Walk,2=Jump; input_kind 0=Step,
/// 1=Jump. Returns `[x, y, facing_code, action_code]` (an `Int32Array` in JS).
///
/// # Errors
/// Throws a JS error if `facing`, `action`, or `step_dir` (when `input_kind == 0`)
/// is not a valid code — fail-loud parity with the serde `apply_move` path.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn predict_move(
    x: i32,
    y: i32,
    facing: u8,
    action: u8,
    started_ms: i64,
    input_kind: u8,
    step_dir: u8,
    now_ms: i64,
) -> Result<Vec<i32>, JsValue> {
    let out = game_core::apply_move_coded(
        x, y, facing, action, started_ms, input_kind, step_dir, now_ms,
    )
    .map_err(|e| zone_map_err(e.to_string()))?;
    Ok(out.to_vec())
}

// --- the JS-consumable marshaling boundary (NO game rules live here) ------
// Each export marshals JS -> game-core serde types, delegates to game-core, and
// marshals the result back.

/// Predict one move from JS: deserialize `state`/`input`, call the SAME
/// `game_core::apply_move` the server runs, and serialize the next state back.
/// `now` is a JS `performance.now()`-style float; it is floored and clamped to a
/// sane `>= 0` baseline before becoming the integer `Millis` the rule consumes.
///
/// M11c: uses `ACTIVE_ZONE_ID` (set by `set_active_zone`) to load the correct
/// zone map. Fails loud (returns Err) on unknown zone rather than silently falling
/// back to zone_0 — a wrong-map fallback would predict through zone N's walls
/// using zone 0's layout. In practice this path never fires because
/// `set_active_zone` is only called after `zone_map(id)` succeeds.
///
/// # Errors
/// Returns a JS error if `state`/`input` is not valid, or if the active zone map
/// cannot be loaded (unknown zone id or embedded-content parse failure).
#[wasm_bindgen]
pub fn apply_move(state: JsValue, input: JsValue, now: f64) -> Result<JsValue, JsValue> {
    let state: CharacterState = serde_wasm_bindgen::from_value(state)?;
    let input: MoveInput = serde_wasm_bindgen::from_value(input)?;
    let zone_id = ACTIVE_ZONE_ID.load(Ordering::Relaxed);
    // Build or reuse the cached TileMap for the active zone.
    // Invariant: ACTIVE_TILE_MAP holds a TileMap for exactly the current ACTIVE_ZONE_ID.
    // set_active_zone() resets it to None on every zone transition, so a non-None
    // cache here always corresponds to the zone_id read above.
    let zone_map = ACTIVE_TILE_MAP.with(|cell| {
        let mut cache = cell.borrow_mut();
        if cache.is_none() {
            let maps = cached_zone_maps().map_err(zone_map_err)?;
            *cache = Some(game_core::map_for(zone_id, maps).map_err(zone_map_err)?);
        }
        // Clone is cheap relative to RON parse; TileMap is a few hundred bools.
        Ok::<game_core::TileMap, JsValue>(cache.as_ref().expect("just set above").clone())
    })?;
    let next = game_core::apply_move(
        &state,
        input,
        &zone_map,
        Millis(now.floor().max(0.0) as i64),
    );
    Ok(serde_wasm_bindgen::to_value(&next)?)
}

/// The step cadence (ms per tile), single-sourced from `game-core` so TS never
/// hard-codes it.
#[wasm_bindgen]
#[must_use]
pub fn step_ms() -> u32 {
    game_core::STEP_MS as u32
}

/// The bounded move-queue cap, single-sourced from `game-core`.
#[wasm_bindgen]
#[must_use]
pub fn move_queue_cap() -> u32 {
    game_core::MOVE_QUEUE_CAP as u32
}

/// The party size (slot count), single-sourced from `game-core` so TS never
/// hard-codes it.
#[wasm_bindgen]
#[must_use]
pub fn party_size() -> u32 {
    game_core::PARTY_SIZE as u32
}

/// The party-slot "boxed" sentinel, single-sourced from `game-core`.
#[wasm_bindgen]
#[must_use]
pub fn party_slot_none() -> u32 {
    game_core::PARTY_SLOT_NONE as u32
}

/// The account-deletion grace window in ms — the window between a deletion
/// request and irreversible erasure, single-sourced from `game-core` so TS
/// never hard-codes it.
///
/// Returns `i64`, which crosses the boundary as a JS `BigInt`. That is
/// deliberate: `deletion_requested_at_ms` is an `Option<i64>` column and
/// therefore `bigint | undefined` in TS, so a countdown computing
/// `requestedAt + grace - now` must stay in `BigInt` arithmetic — a `number`
/// accessor would throw `Cannot mix BigInt and other types` at runtime, and a
/// `u32` one would additionally cap the window at ~49.7 days.
///
/// `_default` is load-bearing and must not be dropped: it means "the literal
/// an operator replaces" (M22 spec §8.1 escalation #1 is UNRESOLVED), NOT that
/// a runtime override column exists. See the HONESTY NOTE beside the constant
/// in `game-core/src/accounts/deletion.rs`; the number itself is deliberately
/// not restated here, so this doc comment can never drift from it.
#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    game_core::DELETION_GRACE_MS_DEFAULT
}

/// The per-side monster-count cap of one proposed trade, single-sourced from
/// `game-core` so TS never hard-codes it (the server rejects above it).
#[wasm_bindgen]
#[must_use]
pub fn max_trade_monsters_per_side() -> u32 {
    game_core::MAX_TRADE_MONSTERS_PER_SIDE as u32
}

/// The NPC talk range (Manhattan tiles, inclusive), single-sourced from
/// `game-core` so the client's interact prompt never hard-codes it.
#[wasm_bindgen]
#[must_use]
pub fn talk_range() -> u32 {
    game_core::TALK_RANGE as u32
}

/// Marshaling-only input DTO for [`interact_candidates_coded`]: one entity as TS
/// sends it. `kind` is `"npc"`, `"heal"` or `"player"`; `id` is a decimal string
/// (a `u64` never crosses as a JS number). No rule lives here.
#[derive(serde::Deserialize)]
struct WireInteractEntity {
    kind: String,
    x: i32,
    y: i32,
    zone: u32,
    id: String,
}

/// The pure core of [`interact_candidates_coded`] (natively testable): parse the
/// facing code and every entity, then delegate to `game_core::interact_candidates`.
fn interact_candidates_core(
    own_x: i32,
    own_y: i32,
    facing: u8,
    zone: u32,
    entities: &[WireInteractEntity],
) -> Result<Vec<usize>, String> {
    let facing = game_core::types::dir_from_code(facing)
        .ok_or_else(|| format!("invalid facing code: {facing}"))?;
    let entities = entities
        .iter()
        .map(parse_interact_entity)
        .collect::<Result<Vec<_>, String>>()?;
    Ok(game_core::interact_candidates(
        game_core::TilePos { x: own_x, y: own_y },
        facing,
        zone,
        &entities,
    ))
}

/// Parse one [`WireInteractEntity`]; an unknown `kind` or a non-`u64` `id` is
/// rejected, never skipped or defaulted.
fn parse_interact_entity(wire: &WireInteractEntity) -> Result<game_core::InteractEntity, String> {
    let kind = match wire.kind.as_str() {
        "npc" => game_core::InteractKind::Npc,
        "heal" => game_core::InteractKind::Heal,
        "player" => game_core::InteractKind::Player,
        other => return Err(format!("unknown interact kind: {other:?}")),
    };
    let id = wire
        .id
        .parse::<u64>()
        .map_err(|err| format!("invalid interact id {:?}: {err}", wire.id))?;
    Ok(game_core::InteractEntity {
        kind,
        pos: game_core::TilePos {
            x: wire.x,
            y: wire.y,
        },
        zone: wire.zone,
        id,
    })
}

/// The interaction target rule across the wasm boundary. `entities` is an array
/// of `{kind, x, y, zone, id}` objects ([`WireInteractEntity`]); returns an array
/// of input indices, in priority order.
///
/// # Errors
/// Returns a JS error for an invalid `facing` code (0=N,1=S,2=E,3=W), an unknown
/// `kind`, an `id` that `u64::from_str` rejects, or a malformed `entities` value.
/// wasm-bindgen casts the scalar arguments, so a JS `facing` of 256 or more wraps
/// before it gets here (as for `predict_move`).
#[wasm_bindgen]
pub fn interact_candidates_coded(
    own_x: i32,
    own_y: i32,
    facing: u8,
    zone: u32,
    entities: JsValue,
) -> Result<JsValue, JsValue> {
    let entities: Vec<WireInteractEntity> = serde_wasm_bindgen::from_value(entities)?;
    let out =
        interact_candidates_core(own_x, own_y, facing, zone, &entities).map_err(zone_map_err)?;
    Ok(serde_wasm_bindgen::to_value(&out)?)
}

/// Marshaling-only input DTO for [`evolution_eligibility`]: exactly the
/// `MonsterInstance` fields game-core's evolution gates read (plus the EV spread
/// the Nutrition gate totals). No rule lives here.
#[derive(serde::Deserialize)]
struct EligibilityMonster {
    species_id: u32,
    /// `Level` validates 1..=100 at deserialize (parse-don't-validate).
    level: game_core::Level,
    /// Indexed by `Affinity::index()` (declaration order Fire..Dark).
    essence: [u32; 8],
    trust_favorable_count: u32,
    trust_unfavorable_count: u32,
    quality_time_ticks_total: u32,
    /// `[hp, attack, defense, speed, sp_attack, sp_defense]`, validated by `EVs::new`.
    evs: [u16; 6],
}

/// Marshaling-only output DTO for [`evolution_eligibility`]; every field is a
/// game-core result, index-aligned with the input `paths` where it is a list.
#[derive(serde::Serialize, Debug, PartialEq)]
struct EligibilityReport {
    /// `trust_tier_of` / `quality_time_tier_of` / `nutrition_pct_of` — the three
    /// derivations the server marshal layer stamps onto `MonsterPub`.
    trust_tier: game_core::TrustTier,
    quality_time_tier: u8,
    nutrition_pct: u8,
    /// `path_satisfied` per path.
    satisfied: Vec<bool>,
    /// `unmet_requirement` per path (`null` exactly when satisfied).
    unmet: Vec<Option<String>>,
    /// `eligible_evolution_paths`, mapped from indices to `edge_id`s, in index order.
    eligible_edge_ids: Vec<u32>,
}

/// The pure core of [`evolution_eligibility`] (natively testable): build the
/// `MonsterInstance` and delegate every answer to game-core. Fields no gate reads
/// (`ivs`, `nature`, `xp`, `current_hp`, `derived_stats`, `party_slot`,
/// `nickname`) get fixed placeholders.
fn eligibility_report(
    m: &EligibilityMonster,
    paths: &[game_core::EvolutionPath],
) -> Result<EligibilityReport, String> {
    let [hp, attack, defense, speed, sp_attack, sp_defense] = m.evs;
    let instance = game_core::MonsterInstance {
        species_id: m.species_id,
        nickname: None,
        level: m.level,
        xp: game_core::xp_for_level(m.level),
        ivs: game_core::IVs::new(0, 0, 0, 0, 0, 0)?,
        nature: game_core::Nature::new(game_core::NatureKind::Hardy),
        evs: game_core::EVs::new(hp, attack, defense, speed, sp_attack, sp_defense)?,
        essence: m.essence,
        trust_favorable_count: m.trust_favorable_count,
        trust_unfavorable_count: m.trust_unfavorable_count,
        quality_time_ticks_total: m.quality_time_ticks_total,
        current_hp: 0,
        derived_stats: game_core::StatBlock {
            hp: 0,
            attack: 0,
            defense: 0,
            speed: 0,
            sp_attack: 0,
            sp_defense: 0,
        },
        party_slot: None,
    };
    Ok(EligibilityReport {
        trust_tier: game_core::trust_tier_of(m.trust_favorable_count, m.trust_unfavorable_count),
        quality_time_tier: game_core::quality_time_tier_of(m.quality_time_ticks_total),
        nutrition_pct: game_core::nutrition_pct_of(&instance.evs),
        satisfied: paths
            .iter()
            .map(|p| game_core::path_satisfied(&instance, p))
            .collect(),
        unmet: paths
            .iter()
            .map(|p| game_core::unmet_requirement(&instance, p))
            .collect(),
        eligible_edge_ids: game_core::eligible_evolution_paths(&instance, paths)
            .into_iter()
            .map(|i| paths[i].edge_id)
            .collect(),
    })
}

/// Evolution eligibility across the wasm boundary — game-core's REAL predicate
/// (`path_satisfied` / `unmet_requirement` / `eligible_evolution_paths`) plus the
/// three tier derivations, for the executable parity test against the client's TS
/// port (`client/src/ui/evolutionModel.parity.test.ts`). `monster` is an
/// [`EligibilityMonster`]-shaped object, `paths` an array of snake_case
/// `EvolutionPath` objects; returns an [`EligibilityReport`]-shaped object
/// (`unmet` entries are `null`, never `undefined`, when satisfied).
///
/// # Errors
/// Returns a JS error if either input fails to deserialize (e.g. a level or a
/// `min_level` outside 1..=100, an unknown affinity/trust tag) or the EVs exceed
/// their caps.
#[wasm_bindgen]
pub fn evolution_eligibility(monster: JsValue, paths: JsValue) -> Result<JsValue, JsValue> {
    use serde::Serialize as _;
    let monster: EligibilityMonster = serde_wasm_bindgen::from_value(monster)?;
    let paths: Vec<game_core::EvolutionPath> = serde_wasm_bindgen::from_value(paths)?;
    let report = eligibility_report(&monster, &paths).map_err(zone_map_err)?;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(report.serialize(&serializer)?)
}

/// The renderer's map source: the SAME `TileMap` the rule evaluates.
/// Dispatches on `zone_id` via the content registry (`load_zone_maps`).
///
/// M8c: the `TileMap`'s `grass` layer serializes automatically (additive serde
/// field) — the TS `RawTileMap.grass` reads it for the grass overlay.
///
/// M11c: zone_id is now meaningful — zone 0 returns zone_0's map, zone 1 returns
/// zone 1's map, and an unknown zone_id returns a JS Error (never silently
/// falls back to zone_0).
///
/// # Errors
/// Returns a JS error if `zone_id` is unknown or serialization fails.
#[wasm_bindgen]
pub fn zone_map(zone_id: u32) -> Result<JsValue, JsValue> {
    // Cached zone registry: parse-once path.
    let maps = cached_zone_maps().map_err(zone_map_err)?;
    let tile_map = game_core::map_for(zone_id, maps).map_err(zone_map_err)?;
    zone_map_ok(&tile_map)
}

/// Install a browser panic hook so a Rust panic surfaces as a readable
/// `console.error` instead of an opaque `unreachable`. Runs once on module init.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

// ---------------------------------------------------------------------------
// Test-only seams for 13.5d caching assertions (not compiled in prod WASM).
// ---------------------------------------------------------------------------

/// Expose the cached zone-maps contents for test assertions.
#[cfg(test)]
pub(crate) fn cached_zone_maps_for_test() -> &'static Vec<game_core::ZoneMapDef> {
    (*ZONE_MAPS)
        .as_ref()
        .expect("zone maps must parse successfully in tests")
}

/// Return whether the ACTIVE_TILE_MAP thread_local is currently Some.
#[cfg(test)]
pub(crate) fn active_tile_map_is_cached_for_test() -> bool {
    ACTIVE_TILE_MAP.with(|cell| cell.borrow().is_some())
}

/// Pre-populate the ACTIVE_TILE_MAP cache with zone 0's TileMap for test setup.
#[cfg(test)]
pub(crate) fn seed_active_tile_map_for_test() {
    ACTIVE_TILE_MAP.with(|cell| {
        *cell.borrow_mut() = Some(game_core::zone_0());
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn tick_matches_game_core() {
        assert_eq!(super::predict_tick(1, 2, 3), game_core::tick_seed(1, 2, 3));
    }

    #[test]
    fn move_matches_game_core() {
        assert_eq!(
            super::predict_move(1, 1, 0, 0, 0, 0, 2, 1000).unwrap(),
            game_core::apply_move_coded(1, 1, 0, 0, 0, 0, 2, 1000)
                .unwrap()
                .to_vec()
        );
    }

    // PARTY SSOT parity
    //
    // Wrong impls killed:
    //   party_size() returning a literal `6u32` not sourced from game_core::PARTY_SIZE
    //   → changing game_core::PARTY_SIZE would not propagate (assert_eq fails if they drift)
    //   party_slot_none() returning a literal `255u32` not sourced from game_core::PARTY_SLOT_NONE
    //   → same drift risk
    #[test]
    fn party_size_matches_game_core_const() {
        // Fails to compile until `party_size()` export and `game_core::PARTY_SIZE` exist.
        assert_eq!(super::party_size(), game_core::PARTY_SIZE as u32);
    }

    #[test]
    fn party_slot_none_matches_game_core_const() {
        // Fails to compile until `party_slot_none()` export and `game_core::PARTY_SLOT_NONE` exist.
        assert_eq!(super::party_slot_none(), game_core::PARTY_SLOT_NONE as u32);
    }

    // DELETION GRACE SSOT parity, on the COMPILED path.
    //
    // Wrong impls killed: delegating to a different game-core constant, and any
    // future drift between the two. NOT killed here: an identically-valued
    // re-typed literal (`604_800_000i64` verbatim).
    #[test]
    fn deletion_grace_matches_game_core_const() {
        assert_eq!(
            super::deletion_grace_ms_default(),
            game_core::DELETION_GRACE_MS_DEFAULT
        );
        // Non-vacuity backstop: a zero or negative window would make every
        // pending deletion instantly due. `game-core` already asserts this with
        // a better message (`grace_default_is_positive_so_none_cannot_alias_true`,
        // game-core/src/accounts/deletion_tests.rs), so this line is deliberate
        // redundancy for the day that test moves or is deleted -- not the
        // primary guard, and not load-bearing for the parity assert above.
        assert!(super::deletion_grace_ms_default() > 0);
    }

    // TRADE CAP SSOT parity. The value-identity proof against the retired client
    // literal (64) lives on the TS side (tradeProposeModel.test.ts EARS-3a), which
    // reads this export from the BUILT wasm binary.
    #[test]
    fn max_trade_monsters_per_side_matches_game_core_const() {
        assert_eq!(
            super::max_trade_monsters_per_side() as usize,
            game_core::MAX_TRADE_MONSTERS_PER_SIDE
        );
    }

    // TALK RANGE SSOT parity (value-identity proof vs the retired client literal 2:
    // interactModel.test.ts A1 reads this export from the built wasm binary).
    #[test]
    fn talk_range_matches_game_core_const() {
        assert_eq!(i64::from(super::talk_range()), game_core::TALK_RANGE);
    }

    // INTERACT CANDIDATES marshaling core (CTL9.3). The rule itself is proven in
    // game-core (interact_tests.rs); these pin the wire contract: x/y/zone/kind/id
    // marshalling, facing codes 0=N,1=S,2=E,3=W, ids parsed as u64 (so "9" sorts
    // before "10"), and REJECT-never-clamp on anything malformed.
    fn wire(kind: &str, x: i32, y: i32, zone: u32, id: &str) -> super::WireInteractEntity {
        super::WireInteractEntity {
            kind: kind.to_string(),
            x,
            y,
            zone,
            id: id.to_string(),
        }
    }

    #[test]
    fn ctl9_3_marshals_position_zone_kind_and_numeric_id_into_priority_order() {
        // Asymmetric own tile (5,3): an x/y swap anywhere changes the answer.
        // East of it is (6,3). Indices: 0 player, 1 npc "10", 2 npc "9", 3 heal,
        // 4 faced but another zone, 5 own tile (loses to the faced tier).
        let entities = [
            wire("player", 6, 3, 7, "1"),
            wire("npc", 6, 3, 7, "10"),
            wire("npc", 6, 3, 7, "9"),
            wire("heal", 6, 3, 7, "3"),
            wire("npc", 6, 3, 8, "2"),
            wire("npc", 5, 3, 7, "1"),
        ];
        assert_eq!(
            super::interact_candidates_core(5, 3, 2, 7, &entities),
            Ok(vec![2, 1, 3, 0])
        );
    }

    #[test]
    fn ctl9_3_falls_back_to_the_own_tile_and_excludes_behind() {
        // Facing North from (5,3): faced tile is (5,2). Own-tile NPC is index 1;
        // the entity behind at (5,4) is never a candidate.
        let entities = [wire("npc", 5, 4, 7, "1"), wire("npc", 5, 3, 7, "2")];
        assert_eq!(
            super::interact_candidates_core(5, 3, 0, 7, &entities),
            Ok(vec![1])
        );
        let only_behind = [wire("npc", 5, 4, 7, "1")];
        assert_eq!(
            super::interact_candidates_core(5, 3, 0, 7, &only_behind),
            Ok(Vec::new())
        );
    }

    #[test]
    fn ctl9_3_ids_compare_numerically_not_as_strings() {
        // As strings "10" < "100" < "2" < "9" < "99"; as numbers 2 < 9 < 10 < 99 < 100.
        let ids = ["100", "2", "99", "10", "9"];
        let entities: Vec<super::WireInteractEntity> =
            ids.iter().map(|id| wire("npc", 1, 0, 0, id)).collect();
        assert_eq!(
            super::interact_candidates_core(0, 0, 2, 0, &entities),
            Ok(vec![1, 4, 3, 2, 0])
        );
        // The full u64 range parses: u64::MAX sorts after 0.
        let wide = [
            wire("npc", 1, 0, 0, "18446744073709551615"),
            wire("npc", 1, 0, 0, "0"),
        ];
        assert_eq!(
            super::interact_candidates_core(0, 0, 2, 0, &wide),
            Ok(vec![1, 0])
        );
    }

    #[test]
    fn ctl9_3_facing_codes_map_to_north_south_east_west() {
        // Own tile (10,20); one NPC on each neighbour, input order N,S,E,W, so the
        // expected index for facing code c is exactly c.
        let entities = [
            wire("npc", 10, 19, 1, "1"),
            wire("npc", 10, 21, 1, "1"),
            wire("npc", 11, 20, 1, "1"),
            wire("npc", 9, 20, 1, "1"),
        ];
        for code in 0u8..=3 {
            assert_eq!(
                super::interact_candidates_core(10, 20, code, 1, &entities),
                Ok(vec![usize::from(code)]),
                "facing code {code}"
            );
        }
    }

    #[test]
    fn ctl9_3_empty_entity_list_is_ok_and_empty() {
        assert_eq!(
            super::interact_candidates_core(0, 0, 0, 0, &[]),
            Ok(Vec::new())
        );
    }

    #[test]
    fn ctl9_3_rejects_an_invalid_facing_code() {
        let entities = [wire("npc", 0, 1, 0, "1")];
        for code in [4u8, 5, 255] {
            assert!(
                super::interact_candidates_core(0, 0, code, 0, &entities).is_err(),
                "facing code {code} must be rejected, not clamped"
            );
            // Rejected even when there is nobody to interact with.
            assert!(
                super::interact_candidates_core(0, 0, code, 0, &[]).is_err(),
                "facing code {code} must be rejected on an empty list too"
            );
        }
        // Non-vacuity: the same call with a valid code succeeds.
        assert_eq!(
            super::interact_candidates_core(0, 0, 1, 0, &entities),
            Ok(vec![0])
        );
    }

    #[test]
    fn ctl9_3_rejects_an_unparseable_id() {
        for bad in [
            "abc",
            "-1",
            "",
            "1.5",
            "0x10",
            "18446744073709551616", // u64::MAX + 1
            // Surrounding whitespace is rejected, never trimmed/normalized.
            " 5",
            "5 ",
            "\t5",
            "5\n",
        ] {
            let entities = [wire("npc", 0, 1, 0, bad)];
            assert!(
                super::interact_candidates_core(0, 0, 1, 0, &entities).is_err(),
                "id {bad:?} must be rejected"
            );
        }
        // Non-vacuity: the same id without whitespace is accepted.
        let ok = [wire("npc", 0, 1, 0, "5")];
        assert_eq!(
            super::interact_candidates_core(0, 0, 1, 0, &ok),
            Ok(vec![0])
        );
    }

    #[test]
    fn ctl9_3_rejects_an_unknown_kind() {
        for bad in ["NPC", "Npc", "sign", "", "heal ", "players"] {
            let entities = [wire(bad, 0, 1, 0, "1")];
            assert!(
                super::interact_candidates_core(0, 0, 1, 0, &entities).is_err(),
                "kind {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn ctl9_3_one_invalid_entity_rejects_the_whole_call_even_if_it_is_not_a_candidate() {
        // A perfectly good candidate first, then an invalid entity that would never
        // be a candidate anyway (wrong zone, far away): still Err, never skipped.
        let good = || wire("npc", 0, 1, 0, "1");
        assert_eq!(
            super::interact_candidates_core(0, 0, 1, 0, &[good()]),
            Ok(vec![0]),
            "fixture: the good entity alone is a candidate"
        );
        let bad_id = [good(), wire("npc", 50, 50, 9, "not-a-number")];
        assert!(super::interact_candidates_core(0, 0, 1, 0, &bad_id).is_err());
        let bad_kind = [good(), wire("sign", 50, 50, 9, "2")];
        assert!(super::interact_candidates_core(0, 0, 1, 0, &bad_kind).is_err());
        // Invalid entity FIRST, good one after.
        let bad_first = [wire("npc", 50, 50, 9, "-3"), good()];
        assert!(super::interact_candidates_core(0, 0, 1, 0, &bad_first).is_err());
    }

    // EVOLUTION ELIGIBILITY marshaling core. The cross-language parity (TS port
    // == this export) is the fast-check suite evolutionModel.parity.test.ts; these
    // pin that the core DELEGATES to game-core over the real authored graph.
    fn sample_monster(level: u8, evs: [u16; 6]) -> super::EligibilityMonster {
        super::EligibilityMonster {
            species_id: 1,
            level: game_core::Level::new(level).expect("valid level"),
            essence: [30, 0, 5, 0, 0, 0, 0, 12],
            trust_favorable_count: 40,
            trust_unfavorable_count: 3,
            quality_time_ticks_total: 160,
            evs,
        }
    }

    #[test]
    fn eligibility_report_delegates_to_game_core_over_the_authored_graph() {
        let paths = game_core::load_evolution_paths().expect("evolution graph parses");
        let mut eligible_seen = 0usize;
        let mut ineligible_seen = 0usize;
        for level in [1u8, 16, 36, 100] {
            let m = sample_monster(level, [100, 100, 50, 0, 0, 0]);
            let report = super::eligibility_report(&m, &paths).expect("valid monster");
            let evs = game_core::EVs::new(100, 100, 50, 0, 0, 0).expect("valid EVs");
            assert_eq!(report.trust_tier, game_core::trust_tier_of(40, 3));
            assert_eq!(
                report.quality_time_tier,
                game_core::quality_time_tier_of(160)
            );
            assert_eq!(report.nutrition_pct, game_core::nutrition_pct_of(&evs));
            assert_eq!(report.satisfied.len(), paths.len());
            assert_eq!(report.unmet.len(), paths.len());
            for (i, sat) in report.satisfied.iter().enumerate() {
                assert_eq!(*sat, report.unmet[i].is_none(), "path {i}");
            }
            let expected: Vec<u32> = paths
                .iter()
                .enumerate()
                .filter(|(i, p)| p.from_species == 1 && report.satisfied[*i])
                .map(|(_, p)| p.edge_id)
                .collect();
            assert_eq!(report.eligible_edge_ids, expected, "level {level}");
            eligible_seen += report.eligible_edge_ids.len();
            ineligible_seen += report.unmet.iter().filter(|u| u.is_some()).count();
        }
        // Non-vacuity: the sweep must hit both verdicts on the real graph.
        assert!(eligible_seen > 0, "no path was ever eligible");
        assert!(ineligible_seen > 0, "no path was ever ineligible");
    }

    #[test]
    fn eligibility_report_rejects_evs_over_the_total_cap() {
        let m = sample_monster(10, [252, 252, 252, 0, 0, 0]);
        assert!(super::eligibility_report(&m, &[]).is_err());
    }

    // -------------------------------------------------------------------------
    // zone_map(zone_id) dispatches on zone_id (not always zone_0)
    //
    // Testing strategy: rather than deserializing JsValue (TileMap has no
    // Deserialize), we test the underlying game_core dispatch layer directly —
    // `zone_map()` is a thin marshal wrapper, so the contract is that it delegates
    // to `game_core::zone_0()` for zone 0 (verifiable via the public zone_id field)
    // and returns Err for unknown zones (verifiable via Result::is_err()).
    // -------------------------------------------------------------------------

    #[test]
    fn zone_map_0_returns_ok() {
        // Criterion C6a prerequisite: zone_map(0) must not return an error for the
        // known zone. Kills: an impl that erroneously returns Err for zone 0.
        let result = super::zone_map(0);
        assert!(
            result.is_ok(),
            "zone_map(0) must return Ok for the known zone 0"
        );
    }

    #[test]
    fn zone_map_0_zone_id_matches_zone_0() {
        // zone_map(0) SHALL return a map whose zone_id is 0.
        //
        // We verify the dispatch contract at the game_core level: the map that
        // zone_map(0) must produce is game_core::zone_0(), which has zone_id == 0.
        // The wasm wrapper serializes it; this test confirms the source has zone_id 0.
        //
        // Wrong impl killed: `zone_map(_zone_id)` returning zone_0() for zone_id=1
        // (tested by zone_map_999_returns_error which fails on the always-Ok path).
        let zone_0_map = game_core::zone_0();
        assert_eq!(
            zone_0_map.zone_id, 0,
            "game_core::zone_0() must have zone_id == 0 (the source for zone_map(0))"
        );
        // The Ok result of zone_map(0) must serialize the same zone_id=0 map.
        // Since TileMap has no Deserialize, we verify by checking the source:
        // zone_map(0) must return Ok (above test) and zone_0() has zone_id=0 (here).
        // Together they pin the dispatch: zone_map(0) == Ok(serialize(zone_0())).
        assert!(
            super::zone_map(0).is_ok(),
            "zone_map(0) must succeed for zone 0 (zone_id=0 confirmed above)"
        );
    }

    #[test]
    fn zone_map_999_returns_error() {
        // zone_map(999) (unknown zone) SHALL return a JS Error,
        // not a valid map.
        //
        // Wrong impl killed: any impl that returns Ok for unknown zone ids — this
        // assert!(result.is_err()) will fail loudly.
        let result = super::zone_map(999);
        assert!(
            result.is_err(),
            "zone_map(999) must return Err for an unknown zone id, but returned Ok"
        );
    }

    // -------------------------------------------------------------------------
    // client-wasm LazyLock content cache
    //
    // The client-wasm caches zone maps in a static LazyLock
    // and caches the active-zone TileMap in a thread_local RefCell<Option<TileMap>>.
    //
    // Testing strategy: expose minimal #[cfg(test)] seams rather than making
    // the statics pub. This follows the existing pattern in this file where
    // game_core sub-functions are tested through thin shims.
    // -------------------------------------------------------------------------

    /// (client-wasm zone map cache transparency):
    /// The client-wasm cached zone maps match game_core::load_zone_maps().
    ///
    /// Calls `super::cached_zone_maps_for_test()` — a #[cfg(test)] helper
    /// to give tests access to the LazyLock contents without making the static
    /// pub.
    ///
    /// Wrong impl killed: a client-wasm LazyLock populated from a stale/wrong
    /// RON snapshot, or one that returns empty even after initialization.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn wasm_cached_zone_maps_matches_load() {
        let cached = super::cached_zone_maps_for_test();
        let loaded = game_core::load_zone_maps().expect("game_core::load_zone_maps must succeed");

        assert_eq!(
            cached.len(),
            loaded.len(),
            "client-wasm cached zone maps has {} entries but load_zone_maps() returned {}",
            cached.len(),
            loaded.len()
        );
        // Compare the zone_id for each entry — ZoneMapDef has no PartialEq, use field check.
        for (c, l) in cached.iter().zip(loaded.iter()) {
            assert_eq!(
                c.zone_id, l.zone_id,
                "client-wasm cached zone {} but loaded zone {}",
                c.zone_id, l.zone_id
            );
            assert_eq!(
                c.rows.len(),
                l.rows.len(),
                "zone {} cached {} tile rows but loaded {} tile rows",
                c.zone_id,
                c.rows.len(),
                l.rows.len()
            );
        }
    }

    /// (set_active_zone invalidates TileMap cache):
    /// After calling set_active_zone(0), the ACTIVE_TILE_MAP thread_local
    /// must be None (the old cached TileMap is discarded so the next access
    /// loads the correct zone's map rather than a stale one from a prior zone).
    ///
    /// Calls `super::active_tile_map_is_cached_for_test()` — a #[cfg(test)]
    /// helper.
    ///
    /// Wrong impl killed: an impl of set_active_zone that updates ACTIVE_ZONE_ID
    /// but neglects to clear the ACTIVE_TILE_MAP thread_local, causing movement
    /// prediction to silently use a stale zone map after a zone transition.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn wasm_set_active_zone_invalidates_tile_map_cache() {
        // Pre-populate the cache so the invalidation has something to clear.
        // Without this, the test would pass even if set_active_zone never touched
        // the thread_local (the cache might already be None from test init).
        super::seed_active_tile_map_for_test();
        assert!(
            super::active_tile_map_is_cached_for_test(),
            "seed_active_tile_map_for_test() must leave ACTIVE_TILE_MAP in Some state"
        );

        // After set_active_zone, the thread_local TileMap cache must be None.
        // We call set_active_zone(0) unconditionally — even if the zone id
        // doesn't change, a zone-switch call must invalidate the cached map.
        super::set_active_zone(0);
        let is_cached = super::active_tile_map_is_cached_for_test();
        assert!(
            !is_cached,
            "ACTIVE_TILE_MAP must be None after set_active_zone() is called; \
             found Some(...) — the cache was not invalidated on zone switch, \
             which would cause movement prediction to use the wrong zone's tile map"
        );
    }
}
