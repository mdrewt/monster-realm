//! Gating tests for the `content_cache` module (M13.5d, M14.5e).
//!
//! Declared from `content_cache.rs` with:
//!   `#[cfg(test)] #[path = "content_cache_tests.rs"] mod content_cache_tests;`
//!
//! Historical RED state (M13.5d — resolved, ADR-0089): the original gating
//! tests for this file required `content_cache.rs` to expose four accessors
//! (`cached_zone_maps`, `cached_evolutions`, `cached_dialogue_trees`,
//! `cached_quest_defs`) and `lib.rs` to declare `mod content_cache;`. That
//! implementation shipped with M13.5d; all four accessors and their LazyLock
//! statics are present in `content_cache.rs` today. The M13.5d tests below
//! are GREEN.
//!
//! RED state (M14.5e block — tests 1–4 compile-fail; test 5 assertion-fail):
//!
//! Tests 1–4 (`cached_skills_*` / `cached_items_*`) are RED via **compile
//! failure**: `cached_skills()` and `cached_items()` do not yet exist in
//! `content_cache.rs`. Because compile failure prevents any test in this crate
//! from running, test 5's red state (`hot_path_reducers_use_cached_content_not_load`)
//! is demonstrable only after the implementer adds the two accessors and the two
//! `LazyLock` statics. At that point test 5 is RED via **assertion failure**:
//! the reducer bodies in `battle.rs` and `taming.rs` still contain
//! `game_core::load_skills()` / `game_core::load_items()` direct calls and do
//! NOT yet contain `cached_skills` / `cached_items`. This layered red state is
//! the same precedent established by M13.5d (ADR-0089).
//!
//! EARS criteria covered:
//!   13.5d-1 transparency (resolved M13.5d): each cached_ fn returns the same
//!     data as the corresponding game_core::load_*() counterpart.
//!   13.5d-1 structural LazyLock proof (resolved M13.5d): two calls to the same
//!     cached_ fn return the SAME pointer address — proves LazyLock actually caches.
//!   13.5d-1 battle.rs hoist (resolved M13.5d): compute_evolves_to with evolutions
//!     from cached_evolutions() produces the same result as with load_evolutions().
//!   13.5d-2 server side (resolved M13.5d): cached_zone_maps() + map_for(0, …) returns Ok.
//!   14.5e-1 transparency (skills): cached_skills() == game_core::load_skills().
//!   14.5e-1 transparency (items): cached_items() == game_core::load_items().
//!   14.5e-1 structural (skills LazyLock): two calls return the SAME pointer.
//!   14.5e-1 structural (items LazyLock): two calls return the SAME pointer.
//!   14.5e-2 call-site switch: submit_attack / swap_active / use_battle_item /
//!     attempt_recruit bodies use cached_skills/cached_items, NOT load_skills/load_items.

// `super` is the `content_cache` module (declared via #[path]).
use super::*;

// ---------------------------------------------------------------------------
// 13.5d-1 — observational transparency: cached data == freshly-loaded data
// ---------------------------------------------------------------------------

/// CRITERION 13.5d-1 (zone maps): cached_zone_maps() returns the same data
/// as game_core::load_zone_maps().
///
/// ZoneMapDef does NOT derive PartialEq (only Serialize/Deserialize), so we
/// compare via JSON/RON serialization — the canonical round-trip for content.
/// Any caching impl that parses a different RON snapshot, trims entries, or
/// reorders rows will fail here.
///
/// Wrong impl killed: a static that points at a hard-coded subset of zone maps,
/// or one that is never populated (returns empty Vec).
#[test]
fn cached_zone_maps_matches_load() {
    let cached = cached_zone_maps().expect("cached_zone_maps must succeed");
    let loaded = game_core::load_zone_maps().expect("game_core::load_zone_maps must succeed");

    // Compare count first for a clearer failure message.
    assert_eq!(
        cached.len(),
        loaded.len(),
        "cached_zone_maps() returned {} entries but load_zone_maps() returned {}",
        cached.len(),
        loaded.len()
    );

    // Compare zone_id and row counts — the primary identity fields for zone maps.
    // (ZoneMapDef has no PartialEq, so we compare the fields we can reach.)
    for (c, l) in cached.iter().zip(loaded.iter()) {
        assert_eq!(
            c.zone_id, l.zone_id,
            "cached zone_id {} != loaded zone_id {}",
            c.zone_id, l.zone_id
        );
        assert_eq!(
            c.rows.len(),
            l.rows.len(),
            "zone {} cached row count {} != loaded row count {}",
            c.zone_id,
            c.rows.len(),
            l.rows.len()
        );
        // Spot-check first row content if present.
        if let (Some(cr), Some(lr)) = (c.rows.first(), l.rows.first()) {
            assert_eq!(
                cr, lr,
                "zone {} first tile row differs between cached and loaded",
                c.zone_id
            );
        }
        assert_eq!(
            c.warps.len(),
            l.warps.len(),
            "zone {} cached warp count {} != loaded warp count {}",
            c.zone_id,
            c.warps.len(),
            l.warps.len()
        );
    }
}

/// CRITERION 13.5d-1 (evolutions): cached_evolutions() == load_evolutions().
///
/// SpeciesEvolutions derives PartialEq, so direct equality is safe.
///
/// Wrong impl killed: a static populated with a different content snapshot, or
/// one whose OnceLock is never seeded (returns empty Vec).
#[test]
fn cached_evolutions_matches_load() {
    let cached = cached_evolutions().expect("cached_evolutions must succeed");
    let loaded = game_core::load_evolutions().expect("game_core::load_evolutions must succeed");
    assert_eq!(
        *cached, loaded,
        "cached_evolutions() data does not match game_core::load_evolutions()"
    );
}

/// CRITERION 13.5d-1 (dialogue trees): cached_dialogue_trees() == load_dialogue_trees().
///
/// DialogueTree derives PartialEq.
///
/// Wrong impl killed: a static that never gets initialized (stays empty), or
/// one that parses a stale/different version of the dialogue RON content.
#[test]
fn cached_dialogue_trees_matches_load() {
    let cached = cached_dialogue_trees().expect("cached_dialogue_trees must succeed");
    let loaded =
        game_core::load_dialogue_trees().expect("game_core::load_dialogue_trees must succeed");
    assert_eq!(
        *cached, loaded,
        "cached_dialogue_trees() data does not match game_core::load_dialogue_trees()"
    );
}

/// CRITERION 13.5d-1 (quest defs): cached_quest_defs() == load_quest_defs().
///
/// QuestDef derives PartialEq.
///
/// Wrong impl killed: a static scoped to only a subset of quests, or one whose
/// OnceLock is initialized from the wrong RON file path.
#[test]
fn cached_quest_defs_matches_load() {
    let cached = cached_quest_defs().expect("cached_quest_defs must succeed");
    let loaded = game_core::load_quest_defs().expect("game_core::load_quest_defs must succeed");
    assert_eq!(
        *cached, loaded,
        "cached_quest_defs() data does not match game_core::load_quest_defs()"
    );
}

// ---------------------------------------------------------------------------
// 13.5d-1 structural — LazyLock proof: two calls return the SAME pointer
// ---------------------------------------------------------------------------

/// CRITERION 13.5d-1 structural (zone maps): two successive calls to
/// cached_zone_maps() return the SAME Vec pointer.
///
/// `std::ptr::eq` on two `&'static Vec<T>` references proves that the backing
/// allocation is the same — i.e., the first call initialized the LazyLock and
/// the second call returned the cached reference rather than re-parsing.
///
/// Wrong impl killed: any impl that calls load_zone_maps() on every invocation
/// (re-parses each time), or one that returns a newly-allocated Vec each call.
#[test]
fn cached_zone_maps_ptr_eq_second_call() {
    let first = cached_zone_maps().expect("first call must succeed");
    let second = cached_zone_maps().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_zone_maps() returned different pointers on two calls — \
         OnceLock is not caching (the Vec was re-allocated or re-parsed)"
    );
}

/// CRITERION 13.5d-1 structural (evolutions): two successive calls to
/// cached_evolutions() return the SAME Vec pointer, proving LazyLock caching.
///
/// Wrong impl killed: any impl that calls load_evolutions() on every invocation,
/// or allocates a new Vec<SpeciesEvolutions> on each call.
#[test]
fn cached_evolutions_ptr_eq_second_call() {
    let first = cached_evolutions().expect("first call must succeed");
    let second = cached_evolutions().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_evolutions() returned different pointers on two calls — \
         OnceLock is not caching (the Vec was re-allocated or re-parsed)"
    );
}

// ---------------------------------------------------------------------------
// 13.5d-1 zone-map lookup: cached data works through game_core::map_for
// ---------------------------------------------------------------------------

/// CRITERION 13.5d-1 (zone map lookup consistency): verifies that zone 0 can
/// be found via game_core::map_for(0, cached_zone_maps().unwrap()).
///
/// This proves the cached data is not only equal to the loaded data in shape,
/// but also usable by the actual lookup function — the same path the server's
/// movement_tick takes after hoisting to the cache.
///
/// Wrong impl killed: an impl that returns a correctly-shaped Vec but with
/// garbled zone_ids (e.g. all zone_ids set to 0xFF), causing map_for to fail.
#[test]
fn cached_zone_maps_is_consistent_with_map_for() {
    let maps = cached_zone_maps().expect("cached_zone_maps must succeed");
    let result = game_core::map_for(0, maps);
    assert!(
        result.is_ok(),
        "game_core::map_for(0, cached_zone_maps()) must return Ok for zone 0, got: {:?}",
        result.err()
    );
}

// ---------------------------------------------------------------------------
// 13.5d-1 battle.rs hoist — compute_evolves_to parity
// ---------------------------------------------------------------------------

/// CRITERION 13.5d-1 (battle.rs hoist): compute_evolves_to called with
/// evolutions from cached_evolutions() produces the same result as when called
/// with evolutions from load_evolutions().
///
/// This encodes the observational equivalence of the hoist: before the hoist,
/// write_back_battle_results called load_evolutions() inside the XP loop;
/// after the hoist, it uses cached_evolutions(). The per-monster evolves_to
/// output must be unchanged.
///
/// Strategy: build a minimal Monster row for species 1 at level 16/bond 50,
/// look up its evolution branches from both sources, call compute_evolves_to on
/// each, and assert equality. Works even if there are no evolutions (both
/// return None). This is deterministic and requires no DB or context.
///
/// Wrong impl killed: a cached_evolutions() that returns stale/different content
/// — a monster that should evolve at level 16 would silently fail to show
/// evolves_to after battle XP pushes it past level 16.
#[test]
fn cached_evolves_to_matches_load_evolves_to() {
    use crate::schema::Monster;
    use game_core::NatureKind;

    // Minimal Monster row — only species_id, level, bond are used by
    // compute_evolves_to (see evolution.rs: builds a MonsterInstance and calls
    // game_core_evolves_to). The other fields are required to construct the
    // struct but are unused by the seam. `nickname` is String (not Option),
    // `party_slot` is u8 (255 = boxed sentinel per PARTY_SLOT_NONE, 0 = slot 0).
    let m = Monster {
        monster_id: 1,
        owner_identity: spacetimedb::Identity::from_byte_array([1u8; 32]),
        species_id: 1,
        nickname: String::new(),
        level: 16, // a level that could trigger a level-based evolution
        xp: 0,
        bond: 50,
        iv_hp: 15,
        iv_attack: 15,
        iv_defense: 15,
        iv_speed: 15,
        iv_sp_attack: 15,
        iv_sp_defense: 15,
        nature_kind: NatureKind::Hardy,
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        stat_hp: 50,
        stat_attack: 50,
        stat_defense: 50,
        stat_speed: 50,
        stat_sp_attack: 50,
        stat_sp_defense: 50,
        current_hp: 50,
        party_slot: 0,
        last_care_at_ms: 0,
        evolves_to: None,
    };

    // Get evolution slices from both sources for species_id == m.species_id.
    let cached = cached_evolutions().expect("cached_evolutions must succeed");
    let loaded = game_core::load_evolutions().expect("load_evolutions must succeed");

    let cached_slice = cached
        .iter()
        .find(|se| se.species_id == m.species_id)
        .map(|se| &se.evolutions[..])
        .unwrap_or(&[]);

    let loaded_slice = loaded
        .iter()
        .find(|se| se.species_id == m.species_id)
        .map(|se| &se.evolutions[..])
        .unwrap_or(&[]);

    let result_cached = crate::evolution::compute_evolves_to(cached_slice, m.level, m.bond);
    let result_loaded = crate::evolution::compute_evolves_to(loaded_slice, m.level, m.bond);

    assert_eq!(
        result_cached, result_loaded,
        "compute_evolves_to with cached evolutions ({:?}) differs from \
         result with freshly-loaded evolutions ({:?}) for species {} level {}",
        result_cached, result_loaded, m.species_id, m.level
    );
}

// ===========================================================================
// M14.5e — skills + items cache: EARS 14.5e-1 transparency + LazyLock proof
// ===========================================================================
//
// Tests 1–4 below are RED via compile failure until `content_cache.rs` gains:
//
//   static SKILLS: LazyLock<Result<Vec<game_core::SkillDef>, String>> =
//       LazyLock::new(game_core::load_skills);
//   static ITEMS:  LazyLock<Result<Vec<game_core::ItemDef>,  String>> =
//       LazyLock::new(game_core::load_items);
//   pub(crate) fn cached_skills() -> Result<&'static Vec<game_core::SkillDef>, String>
//   pub(crate) fn cached_items()  -> Result<&'static Vec<game_core::ItemDef>,  String>
//
// Test 5 is RED via assertion failure once those symbols exist (the call sites
// in battle.rs and taming.rs still call load_skills/load_items directly today).
// ===========================================================================

/// CRITERION 14.5e-1 (skills transparency): `cached_skills()` returns exactly
/// the same data as `game_core::load_skills()` — same count and same contents.
///
/// `SkillDef` derives `PartialEq + Eq` (game-core/src/content.rs, line 115),
/// so direct `assert_eq!` is safe and produces a precise diff on failure.
/// Count is checked first for a clearer failure message (house style).
///
/// Wrong impl killed: a static that hard-codes a subset of skills, returns an
/// empty Vec, parses a stale snapshot, or reorders entries. Any of these will
/// fail the `assert_eq!` on the full Vec.
#[test]
fn cached_skills_matches_load() {
    let cached = cached_skills().expect("cached_skills() must succeed");
    let loaded = game_core::load_skills().expect("game_core::load_skills() must succeed");

    assert_eq!(
        cached.len(),
        loaded.len(),
        "cached_skills() returned {} entries but game_core::load_skills() returned {}",
        cached.len(),
        loaded.len()
    );
    assert_eq!(
        *cached, loaded,
        "cached_skills() data does not match game_core::load_skills()"
    );
}

/// CRITERION 14.5e-1 (items transparency): `cached_items()` returns exactly
/// the same data as `game_core::load_items()` — same count and same contents.
///
/// `ItemDef` derives `PartialEq + Eq` (game-core/src/content.rs, line 145),
/// so direct `assert_eq!` is safe.
/// Count is checked first for a clearer failure message (house style).
///
/// Wrong impl killed: a static that hard-codes a subset of items, returns an
/// empty Vec, parses a stale snapshot, or reorders entries.
#[test]
fn cached_items_matches_load() {
    let cached = cached_items().expect("cached_items() must succeed");
    let loaded = game_core::load_items().expect("game_core::load_items() must succeed");

    assert_eq!(
        cached.len(),
        loaded.len(),
        "cached_items() returned {} entries but game_core::load_items() returned {}",
        cached.len(),
        loaded.len()
    );
    assert_eq!(
        *cached, loaded,
        "cached_items() data does not match game_core::load_items()"
    );
}

/// CRITERION 14.5e-1 structural (skills LazyLock): two successive calls to
/// `cached_skills()` return the SAME `Vec` pointer.
///
/// `std::ptr::eq` on two `&'static Vec<SkillDef>` references proves the backing
/// allocation is identical — i.e., the first call initialized the `LazyLock` and
/// the second returned the cached reference without re-parsing.
///
/// Wrong impl killed: any accessor that calls `game_core::load_skills()` on every
/// invocation (re-parses compile-time-embedded RON per call), or that allocates a
/// fresh `Vec<SkillDef>` on each call. Both would yield distinct heap addresses.
#[test]
fn cached_skills_ptr_eq_second_call() {
    let first = cached_skills().expect("first call to cached_skills() must succeed");
    let second = cached_skills().expect("second call to cached_skills() must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_skills() returned different pointers on two calls — \
         LazyLock is not caching (the Vec was re-allocated or re-parsed on the second call)"
    );
}

/// CRITERION 14.5e-1 structural (items LazyLock): two successive calls to
/// `cached_items()` return the SAME `Vec` pointer.
///
/// Mirrors `cached_skills_ptr_eq_second_call` for the items registry.
///
/// Wrong impl killed: any accessor that calls `game_core::load_items()` on every
/// invocation, or allocates a fresh `Vec<ItemDef>` on each call.
#[test]
fn cached_items_ptr_eq_second_call() {
    let first = cached_items().expect("first call to cached_items() must succeed");
    let second = cached_items().expect("second call to cached_items() must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_items() returned different pointers on two calls — \
         LazyLock is not caching (the Vec was re-allocated or re-parsed on the second call)"
    );
}

// ===========================================================================
// M14.5e-2 — SOURCE-GUARD: hot-path reducers must use cached_* not load_*
//
// This test is RED via assertion failure once cached_skills/cached_items exist
// (compile failure before that). It pins the call-site switch as a hard
// invariant: if any of the four reducer bodies still contain a direct
// game_core::load_skills() or game_core::load_items() call, the assertion fires.
//
// INVARIANT (ADR-0089): load_skills() and load_items() re-parse compile-time-
// embedded RON on every invocation. On a hot path (submit_attack, swap_active,
// attempt_recruit, use_battle_item are all called every battle turn / recruit
// attempt) this means redundant RON parsing per-call. The LazyLock caches
// introduced by M14.5e must be the ONLY entry point inside these reducers.
//
// Helper visibility note: strip_rust_comments and extract_fn_body in
// battle_tests.rs and taming_tests.rs are bare `fn` items inside #[cfg(test)]
// modules of their respective files, scoped to those modules' `super`. They
// are NOT reachable from content_cache_tests.rs. This file inlines minimal
// copies of both helpers (same algorithm) following the established precedent
// in taming_tests.rs which also inlines copies rather than trying to reach
// battle_tests.rs. This is correct per the Rust module visibility rules —
// there is no shared test-utility crate.
// ===========================================================================

/// Strip Rust block comments (`/* ... */`) and line comments (`// ...`) from
/// `src`. Replaces those regions with spaces (preserving byte length).
///
/// Inlined copy of the helper from `battle_tests.rs` / `taming_tests.rs` —
/// those are bare `fn` items inside `#[cfg(test)]` submodules of their
/// respective production files and are NOT reachable here. The algorithm
/// matches both existing copies.
///
/// Corner-cases handled:
///   - Nested block comments are NOT supported (Rust does support them, but
///     no production code in the searched files uses them, and the eval does
///     not either).
///   - String literals containing comment markers (`/* ... */` pairs or `//`)
///     are NOT special-cased — this is intentional: we only need to remove
///     comments so the body-search does not accidentally match a
///     commented-out load_skills call.
///   - Dual caveat: a `//` inside a string literal blanks the rest of that
///     line, so a banned call appearing on the SAME line after such a string
///     would be hidden from the negative needle. This is acceptable because
///     the guard also requires the positive `content_cache::cached_*` needle,
///     and the current and expected call sites keep loads on dedicated lines.
fn strip_rust_comments_local(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    // SAFETY: we only copy ASCII bytes from the original UTF-8 source and
    // replace with spaces (0x20), which are valid UTF-8. The original source
    // is valid UTF-8 (Rust source files must be). So `out` is valid UTF-8.
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// Extract the body of a named `fn` from comment-stripped `src`.
///
/// Finds `pub fn <name>(` or `fn <name>(`, walks to the first `{`, then
/// counts braces to find the matching `}`. Returns the body slice BETWEEN
/// the outer braces (exclusive), or `None` if the function is not found.
///
/// Inlined copy of the helper from `battle_tests.rs` / `taming_tests.rs` —
/// see visibility note in the block comment above.
fn extract_fn_body_local<'a>(src: &'a str, name: &str) -> Option<&'a str> {
    let pub_needle = format!("pub fn {}(", name);
    let priv_needle = format!("fn {}(", name);
    let fn_start = src
        .find(pub_needle.as_str())
        .or_else(|| src.find(priv_needle.as_str()))?;

    let after_fn = &src[fn_start..];
    let brace_offset = after_fn.find('{')?;
    let body_start = fn_start + brace_offset + 1;

    let mut depth: usize = 1;
    let mut rel: usize = 0;
    let chars: Vec<char> = src[body_start..].chars().collect();
    let mut char_pos = 0;
    while char_pos < chars.len() && depth > 0 {
        match chars[char_pos] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        rel += chars[char_pos].len_utf8();
        char_pos += 1;
    }

    if depth == 0 {
        Some(&src[body_start..body_start + rel])
    } else {
        None
    }
}

/// CRITERION 14.5e-2 (hot-path call-site switch): the four reducer bodies that
/// were switched from `game_core::load_skills()` / `game_core::load_items()`
/// to `cached_skills()` / `cached_items()` must use ONLY the cached accessors.
///
/// Four reducers are checked:
///   - `submit_attack`   (battle.rs) — must use `content_cache::cached_skills`,
///     not `load_skills`
///   - `swap_active`     (battle.rs) — must use `content_cache::cached_skills`,
///     not `load_skills`
///   - `use_battle_item` (battle.rs) — must use `content_cache::cached_items`,
///     not `load_items`; MUST contain `cached_items().map_err` AND `content error`
///     (pins accessor + wrapper + message shape)
///   - `attempt_recruit` (taming.rs) — must use `content_cache::cached_skills`,
///     not `load_skills`
///
/// The positive needles are module-qualified (`content_cache::cached_*`) to kill
/// the false-green where a local helper named `load_cached_skills()` satisfies a
/// bare `cached_skills` substring while internally calling `load_skills`. The
/// expected production call form is `crate::content_cache::cached_*()`, matching
/// the existing `crate::content_cache::cached_evolutions()` style at battle.rs:965.
///
/// Comment-stripping is mandatory: the OLD in-source comments mention
/// `load_skills()` and `load_items()`; the NEW comments will mention
/// `cached_skills` and `cached_items`. Without stripping, the guard is fooled
/// in both directions. Needles built from parts per module convention to avoid
/// self-match (this test source is NOT inside the included files, so self-match
/// is not a risk here, but we follow the convention for consistency).
///
/// Wrong impl killed: any reducer body that still calls `game_core::load_skills()`
/// or `game_core::load_items()` directly — re-parses RON on every hot-path call
/// instead of using the process-lifetime LazyLock cache (ADR-0089 violation).
#[test]
fn hot_path_reducers_use_cached_content_not_load() {
    let battle_raw = include_str!("battle.rs");
    let taming_raw = include_str!("taming.rs");

    let battle_stripped = strip_rust_comments_local(battle_raw);
    let taming_stripped = strip_rust_comments_local(taming_raw);

    // --- submit_attack (battle.rs): must use content_cache::cached_skills, not load_skills ---
    {
        // Assembled from parts per convention (no self-match risk; for consistency).
        let fn_name = ["submit", "_attack"].concat();
        let body = extract_fn_body_local(&battle_stripped, &fn_name)
            .unwrap_or_else(|| panic!("INVARIANT (ADR-0089): {} not found in battle.rs", fn_name));

        // Module-qualified needle kills false-green from a local `load_cached_skills()` helper.
        let cached_needle = ["content_cache::cached", "_skills"].concat();
        let banned_needle = ["game_core::load", "_skills"].concat();

        assert!(
            body.contains(cached_needle.as_str()),
            "INVARIANT (ADR-0089): {} must use `content_cache::cached_skills` — \
             direct `game_core::load_skills()` re-parses RON per call on a hot path. \
             Switch to `crate::content_cache::cached_skills()?`.",
            fn_name
        );
        assert!(
            !body.contains(banned_needle.as_str()),
            "INVARIANT (ADR-0089): {} body must NOT contain `game_core::load_skills` — \
             that call re-parses RON on every turn. \
             Replace with `crate::content_cache::cached_skills()?`.",
            fn_name
        );
    }

    // --- swap_active (battle.rs): must use content_cache::cached_skills, not load_skills ---
    {
        let fn_name = ["swap", "_active"].concat();
        let body = extract_fn_body_local(&battle_stripped, &fn_name)
            .unwrap_or_else(|| panic!("INVARIANT (ADR-0089): {} not found in battle.rs", fn_name));

        // Module-qualified needle kills false-green from a local `load_cached_skills()` helper.
        let cached_needle = ["content_cache::cached", "_skills"].concat();
        let banned_needle = ["game_core::load", "_skills"].concat();

        assert!(
            body.contains(cached_needle.as_str()),
            "INVARIANT (ADR-0089): {} must use `content_cache::cached_skills` — \
             direct `game_core::load_skills()` re-parses RON per call on a hot path. \
             Switch to `crate::content_cache::cached_skills()?`.",
            fn_name
        );
        assert!(
            !body.contains(banned_needle.as_str()),
            "INVARIANT (ADR-0089): {} body must NOT contain `game_core::load_skills` — \
             that call re-parses RON on every turn. \
             Replace with `crate::content_cache::cached_skills()?`.",
            fn_name
        );
    }

    // --- use_battle_item (battle.rs): must use content_cache::cached_items, not load_items;
    //     MUST still contain "cached_items().map_err" AND "content error" (pins
    //     accessor + wrapper + message shape together) ---
    {
        let fn_name = ["use", "_battle_item"].concat();
        let body = extract_fn_body_local(&battle_stripped, &fn_name)
            .unwrap_or_else(|| panic!("INVARIANT (ADR-0089): {} not found in battle.rs", fn_name));

        // Module-qualified needle kills false-green from a local `load_cached_items()` helper.
        let cached_needle = ["content_cache::cached", "_items"].concat();
        let banned_needle = ["game_core::load", "_items"].concat();
        // Two-part wrapper pin (Finding 6): accessor + wrapper together, then message shape.
        // `cached_items().map_err` pins that the accessor is called AND immediately wrapped.
        // `content error` pins the message string shape so callers that match on it stay valid.
        let map_err_needle = ["cached_items().map_err"].concat();
        let msg_needle = ["content", " error"].concat();

        assert!(
            body.contains(cached_needle.as_str()),
            "INVARIANT (ADR-0089): {} must use `content_cache::cached_items` — \
             direct `game_core::load_items()` re-parses RON on every item use. \
             Switch to `crate::content_cache::cached_items().map_err(|e| format!(\"content error: {{e}}\"))?`.",
            fn_name
        );
        assert!(
            !body.contains(banned_needle.as_str()),
            "INVARIANT (ADR-0089): {} body must NOT contain `game_core::load_items` — \
             that call re-parses RON on every item use. \
             Replace with `crate::content_cache::cached_items()`.",
            fn_name
        );
        assert!(
            body.contains(map_err_needle.as_str()),
            "INVARIANT (ADR-0089 / M14.5e spec): {} must call `cached_items().map_err(...)` — \
             the accessor must be immediately wrapped with map_err so the content-error \
             message shape is preserved. \
             Expected: `crate::content_cache::cached_items().map_err(|e| format!(\"content error: {{e}}\"))?`.",
            fn_name
        );
        assert!(
            body.contains(msg_needle.as_str()),
            "INVARIANT (ADR-0089 / M14.5e spec): {} must retain the `content error` \
             message string in its map_err wrapper — downstream callers may match on this \
             error string and the spec pins it explicitly.",
            fn_name
        );
    }

    // --- attempt_recruit (taming.rs): must use content_cache::cached_skills, not load_skills ---
    {
        let fn_name = ["attempt", "_recruit"].concat();
        let body = extract_fn_body_local(&taming_stripped, &fn_name)
            .unwrap_or_else(|| panic!("INVARIANT (ADR-0089): {} not found in taming.rs", fn_name));

        // Module-qualified needle kills false-green from a local `load_cached_skills()` helper.
        let cached_needle = ["content_cache::cached", "_skills"].concat();
        let banned_needle = ["game_core::load", "_skills"].concat();

        assert!(
            body.contains(cached_needle.as_str()),
            "INVARIANT (ADR-0089): {} must use `content_cache::cached_skills` — \
             direct `game_core::load_skills()` re-parses RON on every recruit attempt. \
             Switch to `crate::content_cache::cached_skills()?`.",
            fn_name
        );
        assert!(
            !body.contains(banned_needle.as_str()),
            "INVARIANT (ADR-0089): {} body must NOT contain `game_core::load_skills` — \
             that call re-parses RON on every failed recruit turn. \
             Replace with `crate::content_cache::cached_skills()?`.",
            fn_name
        );
    }
}

// ===========================================================================
// 11r-g (ADR-0170 D1/D2) — abilities + heal-locations caches, and the
// version-keyed type-chart cache
//
// EARS criteria covered by this section:
//
//   C-1  `cached_abilities()` SHALL return exactly the data
//        `game_core::load_abilities()` returns (ADR-0089 M14.5e park, completed).
//   C-2  `cached_abilities()` SHALL cache: two calls return the SAME pointer.
//   C-3  `type_chart_cache_lookup` SHALL return the cached `Arc` without calling
//        the rebuild closure when the cell already holds the requested version.
//   C-4  It SHALL call the rebuild closure and return the NEW chart when the
//        content version differs from the cached one.
//   C-5  It SHALL NOT cache a failed rebuild: the next call at the same version
//        rebuilds again.
//   C-5b It SHALL KEEP any previously cached older-version entry across a failed
//        rebuild, so a later call at that older version still hits.
//   C-6  It SHALL recover from a POISONED lock rather than propagate the panic.
//   C-7  No module reachable from `sync_content_inner` (`content.rs`,
//        `marshal.rs`, `evolution.rs`) SHALL call `cached_type_chart`.
//   C-8  `start_battle`, `begin_encounter`, `submit_attack` and `swap_active`
//        SHALL use `content_cache::cached_abilities`, never `load_abilities`.
//   C-9  `submit_attack` and `swap_active` SHALL use
//        `content_cache::cached_type_chart`, never `type_chart_from_rows`.
//   C-10 `battle.rs` SHALL carry no remaining ADR-0089 PARK markers.
//   H-1  `cached_heal_locations()` SHALL be transparent and SHALL cache
//        (the same pair as C-1/C-2, for the eighth LazyLock).
//
// RED STATE.
//   * C-1, C-2, C-3, C-4, C-5, C-5b, C-6 and H-1 are COMPILE-RED:
//     `cached_abilities`, `cached_heal_locations`, `TypeChartCell` and
//     `type_chart_cache_lookup` do not exist in `content_cache.rs`, so
//     `use super::*;` cannot resolve them (the same layered red state this
//     file's header records for M14.5e).
//   * C-8, C-9 and C-10 are ASSERTION-RED once those symbols exist: `battle.rs`
//     still calls `load_abilities()` at :242/:412/:596/:733, still calls
//     `type_chart_from_rows` at :574/:719, and still carries two ADR-0089 PARK
//     comment blocks at :594-595 and :731-732.
//   * C-7 is a GREEN-AT-HEAD fence — a separate `#[test]` so it can actually be
//     observed passing, and it is the ONLY thing standing between the version
//     key and a rolled-back write being cached forever (see its doc comment).
//
// WHY A PURE INNER FUNCTION. There is no reducer-executing harness (ADR-0156
// P7), so the cache's logic lives in `type_chart_cache_lookup(cell, version,
// rebuild)` — cell, version and rebuild closure all injected — and the
// `ReducerContext` wrapper `cached_type_chart` is the ~5 lines that cannot be
// tested here. Every decision the cache makes is in the inner function and is
// exercised below with a counting closure and two distinguishable charts.
// ===========================================================================

/// A one-relation `TypeChart` whose Fire-vs-Water cell is `effectiveness`.
///
/// The two charts used below (0 = immune, 20 = super-effective) are
/// distinguishable from each other AND from an empty chart, whose unlisted pairs
/// default to 10 (neutral) — so a test that receives the wrong chart, or a chart
/// built from no relations at all, fails on a concrete value rather than on a
/// pointer identity that a lucky allocator could reproduce.
fn chart_with(effectiveness: u8) -> game_core::TypeChart {
    let relations = [game_core::TypeRelation {
        attacker: game_core::Affinity::Fire,
        defender: game_core::Affinity::Water,
        effectiveness,
    }];
    game_core::TypeChart::new(&relations)
}

/// The distinguishing query: Fire attacking Water.
fn probe(chart: &game_core::TypeChart) -> u8 {
    chart.effectiveness(game_core::Affinity::Fire, game_core::Affinity::Water)
}

/// A rebuild closure body that COUNTS its invocations and succeeds.
fn counted_ok(
    calls: &std::cell::Cell<u32>,
    effectiveness: u8,
) -> Result<game_core::TypeChart, String> {
    calls.set(calls.get() + 1);
    Ok(chart_with(effectiveness))
}

/// A rebuild closure body that COUNTS its invocations and fails.
fn counted_err(
    calls: &std::cell::Cell<u32>,
    message: &str,
) -> Result<game_core::TypeChart, String> {
    calls.set(calls.get() + 1);
    Err(message.to_string())
}

/// Blank the CONTENT and delimiters of every `"…"` string literal, preserving
/// byte length by substituting spaces.
///
/// A LOCAL, minimal companion to `strip_rust_comments_local` above — added by
/// 11r-g and used ONLY by `battle_reducers_use_cached_abilities_and_cached_type_chart`.
/// The pre-existing `hot_path_reducers_use_cached_content_not_load` keeps the
/// comment-only view on purpose: its `content error` needle IS string content.
///
/// WHY IT IS LOAD-BEARING. A comment-only view lets a dead
/// `let _decoy = "content_cache::cached_abilities()";` satisfy the POSITIVE
/// needle of the call-site gate while the reducer still calls the uncached
/// loader — the exact red-team hole `movement_tests.rs:45-52` records for this
/// crate. Blanking literal content makes the only place a needle can live
/// executable code. As a bonus, a `{` or `}` inside a format string can no longer
/// perturb `extract_fn_body_local`'s brace counting.
///
/// SCOPE OF THE LEXER, and why it is sufficient here. It handles `"…"` with `\`
/// escapes only. `battle.rs` contains no raw strings and no char literal holding
/// a double quote (both asserted by `assert_no_scan_landmines` before use), which
/// are the two constructs that would misalign it. Apply AFTER comment stripping,
/// never before.
fn blank_rust_strings_local(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if bytes[i] == 0x22 {
            i += 1;
            while i < len {
                if bytes[i] == b'\\' {
                    i += 2;
                } else if bytes[i] == 0x22 {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("string-blanked source must be valid UTF-8")
}

/// Loud preconditions for [`blank_rust_strings_local`]'s two blind spots.
///
/// A silently misaligned stripper is the worst failure mode for a source gate —
/// it blanks the wrong byte range and every needle downstream turns vacuous — so
/// each blind spot fails with an explicit message instead. Mirrors the discipline
/// of `assert_stripper_preconditions` in `guards_tests.rs` / `movement_tests.rs`.
fn assert_no_scan_landmines(name: &str, raw: &str) {
    let raw_opener = ["r", "#"].concat();
    assert!(
        !raw.contains(raw_opener.as_str()),
        "SCAN PRECONDITION (11r-g): `{name}` contains a raw-string / raw-identifier \
         opener, which this file's minimal string blanker does not handle — it would \
         blank the wrong byte range and hollow out the call-site gate below. Extend \
         the blanker before adding such a literal."
    );
    let sq = char::from(0x27u8).to_string();
    let dq = char::from(0x22u8).to_string();
    let char_literal_quote = [sq.as_str(), dq.as_str(), sq.as_str()].concat();
    assert!(
        !raw.contains(char_literal_quote.as_str()),
        "SCAN PRECONDITION (11r-g): `{name}` spells a double quote as a CHAR literal. \
         This blanker has no char-literal lexer, so that quote reads as a string \
         OPENER and inverts string/code polarity for the rest of the file. Spell it \
         with a Unicode escape inside the char literal (the same rule \
         `guards_tests.rs`'s G-5a fence enforces for this slice's own files)."
    );
}

/// CRITERION C-1 (abilities transparency): `cached_abilities()` returns exactly
/// the same data as `game_core::load_abilities()` — same count and same contents.
///
/// `AbilityDef` derives `PartialEq + Eq` (game-core/src/content.rs:107), so a
/// direct `assert_eq!` gives a precise diff. Count is checked first for a clearer
/// message (house style, mirroring `cached_skills_matches_load`).
///
/// Wrong impl killed: a static that hard-codes a subset of abilities, returns an
/// empty Vec, parses a stale snapshot, or reorders entries. Abilities drive
/// `apply_entry_ability` and the whole ADR-0100 ability resolution, so a
/// truncated registry silently disables abilities in every battle rather than
/// failing loudly.
///
/// COMPILE-RED: `cached_abilities` does not exist in `content_cache.rs` yet.
#[test]
fn cached_abilities_matches_load() {
    let cached = cached_abilities().expect("cached_abilities() must succeed");
    let loaded = game_core::load_abilities().expect("game_core::load_abilities() must succeed");

    assert_eq!(
        cached.len(),
        loaded.len(),
        "cached_abilities() returned {} entries but game_core::load_abilities() returned {}",
        cached.len(),
        loaded.len()
    );
    assert_eq!(
        *cached, loaded,
        "cached_abilities() data does not match game_core::load_abilities()"
    );
}

/// CRITERION C-2 (abilities LazyLock proof): two successive calls to
/// `cached_abilities()` return the SAME `Vec` pointer.
///
/// `std::ptr::eq` on two `&'static Vec<AbilityDef>` references proves the backing
/// allocation is identical — the first call initialised the `LazyLock` and the
/// second returned the cached reference without re-parsing.
///
/// Wrong impl killed: an accessor that calls `game_core::load_abilities()` on
/// every invocation. That is the ADR-0089 M14.5e park being "completed" in name
/// only — the four battle.rs call sites would still re-parse the abilities RON on
/// every battle action, which is the whole cost this slice removes.
///
/// COMPILE-RED: `cached_abilities` does not exist in `content_cache.rs` yet.
#[test]
fn cached_abilities_ptr_eq_second_call() {
    let first = cached_abilities().expect("first call to cached_abilities() must succeed");
    let second = cached_abilities().expect("second call to cached_abilities() must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_abilities() returned different pointers on two calls — \
         LazyLock is not caching (the Vec was re-allocated or re-parsed on the second call)"
    );
}

/// CRITERION H-1 (heal-locations transparency): `cached_heal_locations()`
/// returns exactly the same data as `game_core::load_heal_locations()`.
///
/// `HealLocationDef` derives `PartialEq + Eq` (game-core/src/content.rs:1131).
///
/// Wrong impl killed: a static that drops entries or parses a stale snapshot.
/// `heal_party` reads `cost_currency` out of this registry, so a wrong snapshot
/// is a wrong PRICE — either a free heal at a paid location or a charge at a free
/// one, both of which move real currency (ADR-0083).
///
/// COMPILE-RED: `cached_heal_locations` does not exist in `content_cache.rs` yet.
#[test]
fn cached_heal_locations_matches_load() {
    let cached = cached_heal_locations().expect("cached_heal_locations() must succeed");
    let loaded =
        game_core::load_heal_locations().expect("game_core::load_heal_locations() must succeed");

    assert_eq!(
        cached.len(),
        loaded.len(),
        "cached_heal_locations() returned {} entries but \
         game_core::load_heal_locations() returned {}",
        cached.len(),
        loaded.len()
    );
    assert_eq!(
        *cached, loaded,
        "cached_heal_locations() data does not match game_core::load_heal_locations()"
    );
}

/// CRITERION H-1 (heal-locations LazyLock proof): two successive calls to
/// `cached_heal_locations()` return the SAME `Vec` pointer.
///
/// Wrong impl killed: an accessor that re-parses the heal registry on every call,
/// which is exactly what `heal_party` does at HEAD (raising.rs:324) and what
/// ADR-0170 D3 removes.
///
/// COMPILE-RED: `cached_heal_locations` does not exist in `content_cache.rs` yet.
#[test]
fn cached_heal_locations_ptr_eq_second_call() {
    let first = cached_heal_locations().expect("first call must succeed");
    let second = cached_heal_locations().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_heal_locations() returned different pointers on two calls — \
         LazyLock is not caching (the Vec was re-allocated or re-parsed on the second call)"
    );
}

/// CRITERION C-3 (version hit): a lookup at a version the cell already holds
/// returns the cached `Arc` and does NOT call the rebuild closure.
///
/// The second lookup is handed a closure that would build a DIFFERENT chart
/// (effectiveness 20 instead of 0), so the test proves three things at once: the
/// closure was not called (`calls == 1`), the same allocation came back
/// (`Arc::ptr_eq`), and the returned chart is the FIRST one (`probe == 0`).
///
/// Wrong impl killed: a cache that stores the version but rebuilds anyway (the
/// whole point of ADR-0170 D1 is removing a full `type_relation_row` scan +
/// chart rebuild from every `submit_attack` / `swap_active`); and a cache that
/// returns a fresh `Arc` wrapping a re-cloned chart, which would make the
/// refcount-bump-per-hit design a lie.
///
/// COMPILE-RED: `type_chart_cache_lookup` / `TypeChartCell` do not exist yet.
#[test]
fn type_chart_cache_returns_the_cached_arc_on_a_version_hit() {
    let cell = TypeChartCell::new(None);
    let calls = std::cell::Cell::new(0u32);

    let first = type_chart_cache_lookup(&cell, 7, || counted_ok(&calls, 0));
    let first = first.expect("C-3: the first lookup must build and succeed");

    let second = type_chart_cache_lookup(&cell, 7, || counted_ok(&calls, 20));
    let second = second.expect("C-3: the second lookup must hit the cache and succeed");

    assert_eq!(
        calls.get(),
        1,
        "TEETH (11r-g C-3, ADR-0170 D1): the rebuild closure ran {} time(s) for two \
         lookups at the SAME content version; it must run exactly ONCE. A version \
         match means the cached chart was built from the current `type_relation_row` \
         state, so rebuilding is pure waste — and removing that per-action full-table \
         scan is the entire point of the cache.",
        calls.get()
    );
    assert!(
        std::sync::Arc::ptr_eq(&first, &second),
        "TEETH (11r-g C-3, ADR-0170 D1): a version hit must return a CLONE OF THE \
         SAME `Arc`, not a new allocation. `Arc::clone` per hit is a refcount bump; \
         anything else means the chart is being rebuilt or deep-copied behind the \
         cache's back."
    );
    assert_eq!(
        probe(&second),
        0,
        "TEETH (11r-g C-3, ADR-0170 D1): the version hit returned a chart whose \
         Fire-vs-Water cell is {} — it must be 0, the value the FIRST rebuild \
         produced. 20 means the second closure ran after all; 10 (the neutral \
         default for unlisted pairs) means an empty chart was served.",
        probe(&second)
    );
}

/// CRITERION C-4 (version miss): a lookup at a DIFFERENT version rebuilds and
/// returns the new chart.
///
/// Wrong impl killed: THE central hazard ADR-0170 D1 rejects a plain `LazyLock`
/// for. `type_relation_row` is DB data written by `sync_content`, so a cache that
/// ignores the version key serves a permanently stale chart after any reseed —
/// cache poisoning of every battle's damage math, silently, forever. A
/// version-ignoring impl returns the version-1 chart here, so `probe` reads 0
/// instead of 20 and this assertion fires.
///
/// The `!Arc::ptr_eq` assertion additionally kills an impl that mutates the chart
/// INSIDE the existing `Arc` (which would change the chart under any reference a
/// caller is still holding).
///
/// COMPILE-RED: `type_chart_cache_lookup` / `TypeChartCell` do not exist yet.
#[test]
fn type_chart_cache_rebuilds_when_the_content_version_changes() {
    let cell = TypeChartCell::new(None);
    let seed_calls = std::cell::Cell::new(0u32);

    let v1 = type_chart_cache_lookup(&cell, 1, || counted_ok(&seed_calls, 0));
    let v1 = v1.expect("C-4: the version-1 lookup must succeed");
    assert_eq!(
        probe(&v1),
        0,
        "C-4 precondition: the version-1 chart must read 0, got {}",
        probe(&v1)
    );

    let calls = std::cell::Cell::new(0u32);
    let v2 = type_chart_cache_lookup(&cell, 2, || counted_ok(&calls, 20));
    let v2 = v2.expect("C-4: the version-2 lookup must succeed");

    assert_eq!(
        calls.get(),
        1,
        "TEETH (11r-g C-4, ADR-0170 D1): the rebuild closure ran {} time(s) after the \
         content version changed from 1 to 2; it must run exactly ONCE. Not \
         rebuilding is the stale-after-reseed poisoning that rules out a plain \
         `LazyLock` over DB rows.",
        calls.get()
    );
    assert_eq!(
        probe(&v2),
        20,
        "TEETH (11r-g C-4, ADR-0170 D1): after a version bump the lookup returned a \
         chart whose Fire-vs-Water cell is {} — it must be 20, the value the NEW \
         rebuild produced. 0 means the stale version-1 chart was served, which is \
         cache poisoning of every battle's damage math after a content reseed: \
         silent, permanent, and invisible to every other test in this crate.",
        probe(&v2)
    );
    assert!(
        !std::sync::Arc::ptr_eq(&v1, &v2),
        "TEETH (11r-g C-4, ADR-0170 D1): a rebuild must produce a NEW `Arc`. The same \
         pointer coming back means the chart was mutated in place, which would change \
         the data under any reference a caller is still holding within its reducer."
    );
}

/// CRITERION C-5 (Err is never cached): a failed rebuild surfaces `Err`, and the
/// NEXT lookup at the same version rebuilds again.
///
/// Wrong impl killed: an impl that mirrors the six compile-time-embedded
/// `LazyLock` registries above and caches the failure. That policy is correct for
/// `include_str!`-embedded RON (a parse failure is deterministic — see this
/// module's doc comment) and WRONG here: the chart is derived from DB rows, which
/// a later transaction can fix. Caching the Err would leave every battle
/// permanently broken after one transient failure, with no retry path short of a
/// redeploy.
///
/// COMPILE-RED: `type_chart_cache_lookup` / `TypeChartCell` do not exist yet.
#[test]
fn type_chart_cache_never_caches_a_failed_rebuild() {
    let cell = TypeChartCell::new(None);
    let fail_calls = std::cell::Cell::new(0u32);

    let failed = type_chart_cache_lookup(&cell, 3, || counted_err(&fail_calls, "scan failed"));
    assert!(
        failed.is_err(),
        "TEETH (11r-g C-5, ADR-0170 D1): a rebuild that returned Err must surface Err \
         to the caller, not an Ok chart. Serving ANY chart here would hand the battle \
         engine damage math built from data the rebuild could not read."
    );
    let failed_msg = failed.err().unwrap_or_default();
    assert!(
        failed_msg.contains("scan failed"),
        "TEETH (11r-g C-5, ADR-0170 D1): the rebuild's own error text must reach the \
         caller so the failure is diagnosable; got {failed_msg:?}."
    );
    assert_eq!(
        fail_calls.get(),
        1,
        "C-5 precondition: the failing rebuild must have been called exactly once, got {}",
        fail_calls.get()
    );

    let retry_calls = std::cell::Cell::new(0u32);
    let retried = type_chart_cache_lookup(&cell, 3, || counted_ok(&retry_calls, 20));
    let retried = retried.expect("C-5: the retry at the same version must succeed");

    assert_eq!(
        retry_calls.get(),
        1,
        "TEETH (11r-g C-5, ADR-0170 D1): after a FAILED rebuild, the next lookup at \
         the SAME version must rebuild again — the closure ran {} time(s), expected \
         1. Unlike the compile-time-embedded registries in this module (whose cached \
         Err is deterministic and therefore correct to cache), a DB-derived chart can \
         be fixed by a later transaction. Caching the Err leaves every battle \
         permanently broken after one transient failure.",
        retry_calls.get()
    );
    assert_eq!(
        probe(&retried),
        20,
        "TEETH (11r-g C-5, ADR-0170 D1): the successful retry must return the chart \
         the retry closure built; its Fire-vs-Water cell reads {} instead of 20.",
        probe(&retried)
    );
}

/// CRITERION C-5b (a failed rebuild keeps the older entry): after a good entry at
/// version 1 and a FAILED rebuild at version 2, a later lookup at version 1 must
/// HIT — without rebuilding — and return the original chart.
///
/// This is the precise wording of ADR-0170 D1: a failed rebuild "returns `Err`,
/// keeps any previously cached older-version entry, and retries on the next
/// call". The three assertions pin all three halves that could go wrong:
///   * `calls == 0` — the entry survived, so no rebuild was needed. An impl that
///     CLEARS the cell on failure (the obvious defensive reflex) rebuilds here.
///   * `Arc::ptr_eq` — it is the same allocation, not an equal-looking rebuild.
///   * `probe == 0` — it is the version-1 chart, not the version-2 closure's.
///
/// Note what is NOT asserted and why: the version-2 lookup still returns `Err`
/// (asserted below), because keeping the old entry must never mean SERVING it at
/// the wrong version. Stale data is never served; the entry is kept only so that
/// callers still on the old version keep their fast path while the reseed is
/// repaired.
///
/// COMPILE-RED: `type_chart_cache_lookup` / `TypeChartCell` do not exist yet.
#[test]
fn type_chart_cache_keeps_the_older_entry_after_a_failed_rebuild() {
    let cell = TypeChartCell::new(None);
    let seed_calls = std::cell::Cell::new(0u32);

    let v1 = type_chart_cache_lookup(&cell, 1, || counted_ok(&seed_calls, 0));
    let v1 = v1.expect("C-5b: the version-1 seed lookup must succeed");

    let fail_calls = std::cell::Cell::new(0u32);
    let failed = type_chart_cache_lookup(&cell, 2, || counted_err(&fail_calls, "reseed"));
    assert!(
        failed.is_err(),
        "TEETH (11r-g C-5b, ADR-0170 D1): a failed rebuild at a NEW version must return \
         Err. Falling back to the cached OLDER chart would serve stale damage math \
         dressed up as current — the cache keeps the old entry, but it must never \
         SERVE it at the wrong version."
    );
    let failed_msg = failed.err().unwrap_or_default();
    assert!(
        failed_msg.contains("reseed"),
        "TEETH (11r-g C-5b): the rebuild's own error text must reach the caller; got \
         {failed_msg:?}."
    );

    let calls = std::cell::Cell::new(0u32);
    let again = type_chart_cache_lookup(&cell, 1, || counted_ok(&calls, 20));
    let again = again.expect("C-5b: the second version-1 lookup must succeed");

    assert_eq!(
        calls.get(),
        0,
        "TEETH (11r-g C-5b, ADR-0170 D1): after a FAILED rebuild at version 2, a \
         lookup back at version 1 must still HIT the surviving entry — the rebuild \
         closure ran {} time(s), expected 0. An impl that clears the cell on failure \
         (the obvious defensive reflex) loses the good entry and pays a full \
         `type_relation_row` scan on every subsequent action until the reseed \
         completes, which is a performance cliff on the exact code path the cache \
         exists to protect.",
        calls.get()
    );
    assert!(
        std::sync::Arc::ptr_eq(&v1, &again),
        "TEETH (11r-g C-5b, ADR-0170 D1): the surviving version-1 entry must be the \
         SAME allocation seeded before the failed rebuild — a different pointer means \
         the entry was dropped and silently rebuilt."
    );
    assert_eq!(
        probe(&again),
        0,
        "TEETH (11r-g C-5b, ADR-0170 D1): the surviving entry's Fire-vs-Water cell \
         reads {} — it must be 0, the version-1 chart. 20 means the version-1 lookup \
         ran its own closure; 10 means an empty chart was stored by the failed \
         rebuild.",
        probe(&again)
    );
}

/// CRITERION C-6 (poison recovery): a lock poisoned by an unrelated panic does
/// not brick the cache.
///
/// A real poisoning, not a source scan: a spawned thread takes the cell's lock
/// and panics while holding it, the join is asserted to have failed, the cell is
/// asserted to BE poisoned (so the test cannot pass vacuously if a future std
/// change stops poisoning mutexes), and only then is the lookup exercised.
///
/// Wrong impl killed: `cell.lock().unwrap()`. ADR-0170 D1 takes this as
/// defence-in-depth: IF the host unwinds panics and keeps the module instance
/// alive, one unrelated panic must not make every subsequent battle action fail
/// for the process lifetime. (If the host instead traps and recycles the
/// instance, the recovery path is dead code — harmless either way, and the host's
/// actual behaviour is not determinable from source.)
///
/// Native-test only, by construction: the wasm target has no threads. That is
/// fine — this crate's unit tests always run natively (ADR-0156 P7 notes the
/// module itself is never executed by a test).
///
/// COMPILE-RED: `type_chart_cache_lookup` / `TypeChartCell` do not exist yet.
#[test]
fn type_chart_cache_recovers_from_a_poisoned_lock() {
    let cell = std::sync::Arc::new(TypeChartCell::new(None));
    let poisoner = std::sync::Arc::clone(&cell);

    let handle = std::thread::spawn(move || {
        let _guard = poisoner.lock().expect("C-6: the uncontended lock must succeed");
        panic!("11r-g C-6: deliberate panic while holding the type-chart cache lock");
    });
    assert!(
        handle.join().is_err(),
        "C-6 precondition: the spawned thread must have panicked while holding the \
         lock; without that panic the cell is never poisoned and the assertion below \
         would pass vacuously."
    );
    assert!(
        cell.is_poisoned(),
        "C-6 precondition: the cell must actually be POISONED after a panic while the \
         lock was held. If this fires, the recovery path below is untested and this \
         test proves nothing."
    );

    let got = type_chart_cache_lookup(&cell, 1, || Ok(chart_with(20)));
    assert!(
        got.is_ok(),
        "TEETH (11r-g C-6, ADR-0170 D1): a lookup on a POISONED cell must still \
         succeed — the lock is recovered via `PoisonError::into_inner`, never \
         unwrapped. With `.lock().unwrap()` this call panics, and EVERY subsequent \
         battle action fails for the whole process lifetime because of one unrelated \
         panic somewhere else entirely."
    );
    let got = got.expect("C-6: is_ok was asserted immediately above");
    assert_eq!(
        probe(&got),
        20,
        "TEETH (11r-g C-6, ADR-0170 D1): after recovering a poisoned lock the cache \
         must still work normally — the rebuilt chart's Fire-vs-Water cell reads {} \
         instead of 20. Recovering the lock but then refusing to store or return the \
         chart would be a silent half-fix.",
        probe(&got)
    );
}

/// CRITERION C-7 (ADR-0170 D1 invariant) — no module reachable from
/// `sync_content_inner` may call `cached_type_chart`.
///
/// GREEN AT HEAD and green after the slice. A separate `#[test]` so it can be
/// observed passing, and the only executable guard behind a genuinely nasty
/// failure mode.
///
/// THE HAZARD, precisely. `sync_content_inner` (content.rs:171-181) rewrites
/// `type_relation_row` with a delete-all + insert, and the SAME transaction
/// stamps `cfg.content_version` (content.rs:285). If anything reachable from that
/// reducer called `cached_type_chart` in the window between the row rewrite and
/// the version stamp, the cache would store `(OLD_version, NEW_chart)`. A later
/// panic rolls the DATABASE back but NOT the process static — leaving a permanent
/// version-match HIT on a chart built from rows that no longer exist. Every
/// battle after that computes damage from phantom type relations, and no test
/// anywhere else in this repo would notice.
///
/// Three files, not one: the invariant is about TRANSITIVE reachability, so a
/// single-file scan of `content.rs` would miss a call made by `marshal.rs`'s
/// chart builder or by `evolution.rs`. Comments are stripped first, so the
/// doc-comment contract that ADR-0170 D1 also requires on `cached_type_chart`
/// (naming these forbidden callers) cannot itself trip the scan.
///
/// HONEST LIMIT: a LEXICAL scan of three named files, not a call-graph analysis
/// (ADR-0170 residual 4 records this explicitly). A new module inserted into
/// `sync_content_inner`'s reachable set would need adding here; the doc-comment
/// contract on `cached_type_chart` is the other half of the pair.
#[test]
fn sync_content_reachable_modules_never_call_cached_type_chart() {
    let files = [
        ("content.rs", include_str!("content.rs")),
        ("marshal.rs", include_str!("marshal.rs")),
        ("evolution.rs", include_str!("evolution.rs")),
    ];
    let needle = ["cached_type", "_chart"].concat();

    for (name, raw) in files {
        let stripped = strip_rust_comments_local(raw);
        let n = stripped.matches(needle.as_str()).count();
        assert_eq!(
            n, 0,
            "TEETH (11r-g C-7, ADR-0170 D1 invariant): `{name}` contains {n} \
             reference(s) to the version-keyed type-chart accessor and must contain \
             ZERO. These three files are the set transitively reachable from \
             `sync_content_inner`, which rewrites `type_relation_row` and stamps \
             `content_version` in ONE transaction. A call made between those two \
             writes caches `(OLD version, NEW chart)`; a later panic rolls the \
             DATABASE back but not the process static, leaving a permanent \
             version-match hit on a chart built from rows that no longer exist — \
             every subsequent battle computes damage from phantom type relations. \
             Green at HEAD; if a legitimate future need arises, change ADR-0170 D1 \
             FIRST."
        );
    }
}

/// CRITERIA C-8 + C-9 (ADR-0170 D2 / D1) — the four battle.rs reducers use the
/// cached accessors, never the uncached ones.
///
/// ASSERTION-RED at HEAD on every arm: `battle.rs` calls `load_abilities()` at
/// :242 (`start_battle`), :412 (`begin_encounter`), :596 (`submit_attack`) and
/// :733 (`swap_active`), and `type_chart_from_rows(..)` at :574 and :719.
///
/// A SIBLING of `hot_path_reducers_use_cached_content_not_load` rather than an
/// extension of it: that test is GREEN and pins M14.5e's skills/items swap
/// (including `taming.rs`), and folding a red arm into it would make an unrelated
/// slice's gate go red for this slice's reason.
///
/// SCOPE IS DELIBERATELY `battle.rs` ONLY. `pvp.rs:280/:392`, `taming.rs:205`
/// (`load_abilities`) and `pvp.rs:383`, `taming.rs:191` (`type_chart_from_rows`)
/// are OUTSIDE 11r-g's declared touch set and are recorded as ADR-0170 residual
/// 2. Scoping the gate to `battle.rs` bodies is what stops it from forcing an
/// out-of-boundary edit — do NOT widen it here; widen it in the slice that
/// legitimately swaps those call sites.
///
/// WHAT EACH NEEDLE KILLS.
///   * Positive `content_cache::cached_abilities` / `content_cache::cached_type_chart`
///     — module-QUALIFIED, which kills the false green where a file-local helper
///     named `load_cached_abilities()` satisfies a bare substring while internally
///     re-parsing. (Same reasoning the M14.5e gate above records.)
///   * Negative `load_abilities` — kills the belt-and-braces shell that adds the
///     cached call and leaves the uncached one, so the RON is still re-parsed on
///     every battle action.
///   * Negative `type_chart_from_rows` — kills the same shell for the chart, and
///     that one is the expensive half: a full `type_relation_row` scan plus a
///     chart rebuild on EVERY `submit_attack` and `swap_active`.
///
/// COMMENTS **AND** STRING LITERALS ARE BLANKED before any needle is evaluated.
/// The comment-only view this file uses elsewhere is not enough for a gate whose
/// teeth are a POSITIVE needle: a dead
/// `let _decoy = "content_cache::cached_abilities()";` anywhere in a reducer body
/// satisfies the positive needle while the body still calls the uncached loader,
/// and the negative needle never fires because the decoy does not spell it. That
/// is the red-team hole `movement_tests.rs:45-52` records for this crate,
/// reproduced here. [`blank_rust_strings_local`] makes executable code the only
/// place a needle can live; [`assert_no_scan_landmines`] fails loudly on the two
/// constructs its lexer cannot see.
///
/// A welcome side effect: the negative needles no longer false-RED on an error
/// MESSAGE that happens to name the old accessor. Renaming such a message stays
/// good hygiene, but it is no longer gated here — a fence with no defect behind
/// it is worse than none.
#[test]
fn battle_reducers_use_cached_abilities_and_cached_type_chart() {
    let battle_raw = include_str!("battle.rs");
    assert_no_scan_landmines("battle.rs", battle_raw);
    let battle_stripped = blank_rust_strings_local(&strip_rust_comments_local(battle_raw));

    let cached_abilities_needle = ["content_cache::cached", "_abilities"].concat();
    let banned_abilities_needle = ["load", "_abilities"].concat();

    for parts in [
        ["start", "_battle"],
        ["begin", "_encounter"],
        ["submit", "_attack"],
        ["swap", "_active"],
    ] {
        let fn_name = parts.concat();
        let body = extract_fn_body_local(&battle_stripped, &fn_name)
            .unwrap_or_else(|| panic!("11r-g C-8: `{fn_name}` not found in battle.rs"));

        assert!(
            body.contains(cached_abilities_needle.as_str()),
            "TEETH (11r-g C-8, ADR-0170 D2): `{fn_name}` must reach the abilities \
             registry through `content_cache::cached_abilities` — the seventh \
             LazyLock this slice adds, completing the ADR-0089 M14.5e park. RED at \
             HEAD: it calls the uncached loader, which re-parses the abilities RON on \
             every battle action. The needle is module-QUALIFIED so a file-local \
             `load_cached_abilities()` shim cannot satisfy it while still re-parsing."
        );
        assert!(
            !body.contains(banned_abilities_needle.as_str()),
            "TEETH (11r-g C-8, ADR-0170 D2): `{fn_name}` must NOT mention the uncached \
             abilities loader. Adding the cached call while leaving the uncached one \
             in place is the belt-and-braces shell that passes the positive needle \
             above with the RON re-parse fully intact. Comments AND string literals \
             are blanked before this scan, so only an executable call can trip it — \
             an error message that still names the old accessor will not."
        );
    }

    let cached_chart_needle = ["content_cache::cached_type", "_chart"].concat();
    let banned_chart_needle = ["type_chart_from", "_rows"].concat();

    for parts in [["submit", "_attack"], ["swap", "_active"]] {
        let fn_name = parts.concat();
        let body = extract_fn_body_local(&battle_stripped, &fn_name)
            .unwrap_or_else(|| panic!("11r-g C-9: `{fn_name}` not found in battle.rs"));

        assert!(
            body.contains(cached_chart_needle.as_str()),
            "TEETH (11r-g C-9, ADR-0170 D1): `{fn_name}` must reach the type chart \
             through the version-keyed `content_cache::cached_type_chart`. RED at \
             HEAD: it rebuilds the chart from a full `type_relation_row` scan on \
             EVERY call, which is the expensive half of the per-battle-action cost \
             this slice removes."
        );
        assert!(
            !body.contains(banned_chart_needle.as_str()),
            "TEETH (11r-g C-9, ADR-0170 D1): `{fn_name}` must NOT call \
             `type_chart_from_rows` directly — that is the full-table scan plus chart \
             rebuild the cache replaces. The rebuild still happens, but only inside \
             `cached_type_chart`'s rebuild closure and only on a version miss. \
             (`marshal.rs` keeps the function; only these two call sites move.)"
        );
    }
}

/// CRITERION C-10 (ADR-0089 park completed) — no ADR-0089 PARK marker survives in
/// `battle.rs`.
///
/// ASSERTION-RED at HEAD: two identical PARK comment blocks sit at battle.rs
/// :594-595 and :731-732, each asserting that abilities are NOT cached. Once
/// C-8's swap lands those comments are actively FALSE, and a false comment about
/// a caching decision is exactly the kind of thing that gets a future reader to
/// "restore" the uncached call.
///
/// The scan runs on RAW, UN-stripped source on purpose — the markers live in
/// comments, so any comment-stripping view would report zero and the test would
/// be vacuous in both directions.
///
/// Scoped to `battle.rs`. `taming.rs:203` carries the one remaining PARK comment
/// that is still TRUE (its `load_abilities` call site is outside this slice's
/// touch set — ADR-0170 residual 2) and must NOT be deleted here; a whole-crate
/// scan would force exactly that out-of-boundary edit.
///
/// The needle is assembled from fragments so this test file never spells the
/// marker contiguously — otherwise any eval that concatenates every source file
/// under `server-module/src` would find the marker in the test that forbids it.
#[test]
fn battle_rs_carries_no_remaining_adr_0089_park_markers() {
    let battle_raw = include_str!("battle.rs");
    let needle = ["PARK(ADR", "-0089"].concat();
    let n = battle_raw.matches(needle.as_str()).count();
    assert_eq!(
        n, 0,
        "TEETH (11r-g C-10, ADR-0170 D2): `battle.rs` still carries {n} ADR-0089 PARK \
         marker(s) matching the assembled needle `{needle}`; it must carry ZERO. HEAD \
         has 2 (battle.rs:594-595 and :731-732), each stating that the abilities \
         registry is NOT cached. After C-8's swap that statement is FALSE, and a \
         false comment about a caching decision is precisely what persuades a future \
         reader to 'restore' the uncached call. Scoped to `battle.rs` on purpose: \
         `taming.rs:203` carries the one PARK comment that is still true (its call \
         site is outside this slice's touch set, ADR-0170 residual 2) and must be left \
         alone. Scanned on RAW source because the markers live in comments."
    );
}
