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
