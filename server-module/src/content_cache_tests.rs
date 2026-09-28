//! Gating tests for the `content_cache` module.
//!
//! Declared from `content_cache.rs` with:
//!   `#[cfg(test)] #[path = "content_cache_tests.rs"] mod content_cache_tests;`

// `super` is the `content_cache` module (declared via #[path]).
use super::*;

// ---------------------------------------------------------------------------
// Observational transparency: cached data == freshly-loaded data
// ---------------------------------------------------------------------------

/// cached_zone_maps() returns the same data as game_core::load_zone_maps().
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

/// cached_dialogue_trees() == load_dialogue_trees().
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

/// cached_quest_defs() == load_quest_defs().
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
// LazyLock proof: two calls return the SAME pointer
// ---------------------------------------------------------------------------

/// two successive calls to cached_zone_maps() return the SAME Vec pointer.
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

// ---------------------------------------------------------------------------
// zone-map lookup: cached data works through game_core::map_for
// ---------------------------------------------------------------------------

/// verifies that zone 0 can be found via game_core::map_for(0,
/// cached_zone_maps().unwrap()).
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

// ===========================================================================
// ===========================================================================
//
// ===========================================================================

/// `cached_skills()` returns exactly the same data as
/// `game_core::load_skills()` — same count and same contents.
///
/// `SkillDef` derives `PartialEq + Eq`, so direct `assert_eq!` is safe and
/// produces a precise diff on failure. Count is checked first for a clearer
/// failure message.
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

/// `cached_items()` returns exactly the same data as
/// `game_core::load_items()` — same count and same contents.
///
/// `ItemDef` derives `PartialEq + Eq`, so direct `assert_eq!` is safe. Count
/// is checked first for a clearer failure message.
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

/// two successive calls to `cached_skills()` return the SAME `Vec` pointer.
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

/// two successive calls to `cached_items()` return the SAME `Vec` pointer.
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
// Abilities + heal-locations caches, and the
// version-keyed type-chart cache
//
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

/// `cached_abilities()` returns exactly the same data as
/// `game_core::load_abilities()` — same count and same contents.
///
/// `AbilityDef` derives `PartialEq + Eq`, so a direct `assert_eq!` gives a
/// precise diff. Count is checked first for a clearer message.
///
/// Wrong impl killed: a static that hard-codes a subset of abilities, returns an
/// empty Vec, parses a stale snapshot, or reorders entries. Abilities drive
/// `apply_entry_ability`, so a truncated registry silently disables abilities in
/// every battle rather than failing loudly.
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

/// two successive calls to `cached_abilities()` return the SAME `Vec` pointer.
///
/// `std::ptr::eq` on two `&'static Vec<AbilityDef>` references proves the backing
/// allocation is identical — the first call initialised the `LazyLock` and the
/// second returned the cached reference without re-parsing.
///
/// Wrong impl killed: an accessor that calls `game_core::load_abilities()` on
/// every invocation. four battle.rs call sites would still re-parse the abilities
/// RON on every battle action.
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

/// `cached_heal_locations()` returns exactly the same data as
/// `game_core::load_heal_locations()`.
///
/// `HealLocationDef` derives `PartialEq + Eq`.
///
/// Wrong impl killed: a static that drops entries or parses a stale snapshot.
/// `heal_party` reads `cost_currency` out of this registry, so a wrong snapshot
/// is a wrong PRICE — either a free heal at a paid location or a charge at a free
/// one, both of which move real currency.
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

/// two successive calls to `cached_heal_locations()` return the SAME `Vec`
/// pointer.
///
/// Wrong impl killed: an accessor that re-parses the heal registry on every call.
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

/// a lookup at a version the cell already holds
/// returns the cached `Arc` and does NOT call the rebuild closure.
///
/// The second lookup is handed a closure that would build a DIFFERENT chart
/// (effectiveness 20 instead of 0), so the test proves three things at once: the
/// closure was not called (`calls == 1`), the same allocation came back
/// (`Arc::ptr_eq`), and the returned chart is the FIRST one (`probe == 0`).
///
/// Wrong impl killed: a cache that stores the version but rebuilds anyway;
/// and a cache that returns a fresh `Arc` wrapping a re-cloned chart, which
/// would make the refcount-bump-per-hit design a lie.
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

/// a lookup at a DIFFERENT version rebuilds and returns the new chart.
///
/// Wrong impl killed:
/// `type_relation_row` is DB data written by `sync_content`, so a cache that
/// ignores the version key serves a permanently stale chart after any reseed —
/// cache poisoning of every battle's damage math, silently, forever. A
/// version-ignoring impl returns the version-1 chart here, so `probe` reads 0
/// instead of 20 and this assertion fires.
///
/// The `!Arc::ptr_eq` assertion additionally kills an impl that mutates the chart
/// INSIDE the existing `Arc` (which would change the chart under any reference a
/// caller is still holding).
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

/// a failed rebuild surfaces `Err`, and the NEXT lookup at the same version
/// rebuilds again.
///
/// Wrong impl killed: an impl that mirrors the six compile-time-embedded
/// `LazyLock` registries above and caches the failure. That policy is correct for
/// `include_str!`-embedded RON (a parse failure is deterministic — see this
/// module's doc comment) and WRONG here: the chart is derived from DB rows, which
/// a later transaction can fix. Caching the Err would leave every battle
/// permanently broken after one transient failure, with no retry path short of a
/// redeploy.
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

/// after a good entry at version 1 and a FAILED rebuild at version 2, a later
/// lookup at version 1 must HIT — without rebuilding — and return the original
/// chart.
///
/// The three assertions pin all three halves that could go wrong:
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

/// a lock poisoned by an unrelated panic does not brick the cache.
///
/// A real poisoning, not a source scan: a spawned thread takes the cell's lock
/// and panics while holding it, the join is asserted to have failed, the cell is
/// asserted to BE poisoned (so the test cannot pass vacuously if a future std
/// change stops poisoning mutexes), and only then is the lookup exercised.
///
/// Wrong impl killed: `cell.lock().unwrap()`.
/// IF the host unwinds panics and keeps the module instance
/// alive, one unrelated panic must not make every subsequent battle action fail
/// for the process lifetime. (If the host instead traps and recycles the
/// instance, the recovery path is dead code — harmless either way, and the host's
/// actual behaviour is not determinable from source.)
///
/// Native-test only, by construction: the wasm target has no threads. That is
/// fine — this crate's unit tests always run natively.
#[test]
fn type_chart_cache_recovers_from_a_poisoned_lock() {
    let cell = std::sync::Arc::new(TypeChartCell::new(None));
    let poisoner = std::sync::Arc::clone(&cell);

    let handle = std::thread::spawn(move || {
        let _guard = poisoner
            .lock()
            .expect("C-6: the uncontended lock must succeed");
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
