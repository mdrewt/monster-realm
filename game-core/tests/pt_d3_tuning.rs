//! Content-over-live-RON gameplay invariants for encounters, recruiting and
//! shops. Each test runs production functions (roll_encounter, recruit_chance,
//! battle_currency_reward) over the shipped registries.

use std::collections::{BTreeMap, BTreeSet};

use game_core::{
    base_stat_total, battle_currency_reward, derive_stats, load_encounters, load_evolution_paths,
    load_items, load_shops, load_species, recruit_chance, roll_encounter, EVs, EncounterTable, IVs,
    Level, Nature, NatureKind, Species, RECRUIT_BASE_RATE,
};

// ===========================================================================
// Shared synthetic-fixture helpers
// ===========================================================================

fn neutral_ivs(iv_hp: u8) -> IVs {
    IVs::new(iv_hp, 0, 0, 0, 0, 0).expect("iv within [0,31]")
}

fn find_species(species: &[Species], id: u32) -> Option<&Species> {
    species.iter().find(|s| s.id == id)
}

// ===========================================================================
// pt-d3-3 — no encounter-less player level
// ===========================================================================

// Kills: a zone-1 encounter table whose level bands leave a gap (e.g. jumping
// from max_level 8 straight to min_level 12) so some level in [5,20] has no
// eligible spawn anywhere.
#[test]
fn pt_d3_3_no_encounterless_player_level() {
    let encounters = load_encounters().expect("encounters registry must parse");
    for lvl in 5u8..=20 {
        let level = Level::new(lvl).expect("level in [1,100]");
        let covered = encounters
            .iter()
            .any(|table| roll_encounter(table, 0, level).is_some());
        assert!(
            covered,
            "pt-d3-3: player level {lvl} has NO table that yields a spawn via \
             roll_encounter(_, 0, level) — a band gap leaves this level with zero possible \
             wild encounters"
        );
    }
}

// ===========================================================================
// pt-d3-4 — H1 recruit-chance weakening invariant over every wild species
// ===========================================================================

#[test]
fn pt_d3_4_recruit_h1_weakening_dominates() {
    let encounters = load_encounters().expect("encounters registry must parse");
    let species_rows = load_species().expect("species registry must parse");
    let items = load_items().expect("items registry must parse");

    // Read the best bait bonus from content rather than hardcoding 150, so a
    // future item that pushes recruit_bonus well past bait's intended ceiling
    // (e.g. 400) breaks clause (b) here rather than silently shipping.
    let best_bait = items.iter().map(|i| i.recruit_bonus).max().unwrap_or(0);

    let mut levels_by_species: BTreeMap<u32, BTreeSet<u8>> = BTreeMap::new();
    for table in &encounters {
        for entry in &table.entries {
            // An inverted band (min_level > max_level) would silently insert
            // the species key with an EMPTY level set — it would still count
            // toward the `len() == 7` assertion below while contributing zero
            // H1 clause evaluations, i.e. the test could pass vacuously for
            // that species. Refuse that content outright.
            assert!(
                entry.min_level.as_u8() <= entry.max_level.as_u8(),
                "pt-d3-4: zone {} species {} has min_level {} > max_level {} — an inverted \
                 band",
                table.zone_id,
                entry.species_id,
                entry.min_level.as_u8(),
                entry.max_level.as_u8()
            );
            let set = levels_by_species.entry(entry.species_id).or_default();
            for lvl in entry.min_level.as_u8()..=entry.max_level.as_u8() {
                set.insert(lvl);
            }
        }
    }

    // Derive the species set FROM the encounter tables (not hardcoded): this is
    // what makes the count assertion RED today (currently 7, not 9 — rw3c
    // appends Voltkit=40 and Aurelet=42 to zone 1).
    assert_eq!(
        levels_by_species.len(),
        9,
        "pt-d3-4: expected exactly 9 wild-encounterable species once rw3c's zone-1 wave-3 \
         placement lands, found {}",
        levels_by_species.len()
    );

    for (species_id, levels) in &levels_by_species {
        assert!(
            !levels.is_empty(),
            "pt-d3-4: species {species_id} has an empty level set despite appearing in an \
             encounter table — the H1 clauses below can never be evaluated for it"
        );
    }

    let mut clause_evals = 0usize;
    for (species_id, levels) in &levels_by_species {
        let sp = find_species(&species_rows, *species_id).unwrap_or_else(|| {
            panic!("pt-d3-4: species {species_id} appears in an encounter table but not in load_species()")
        });
        for &lvl in levels {
            let level = Level::new(lvl).expect("level in [1,100]");
            for iv_hp in [0u8, 31] {
                clause_evals += 1;
                let ivs = neutral_ivs(iv_hp);
                let evs = EVs::zero();
                let nature = Nature::new(NatureKind::Hardy);
                let derived = derive_stats(&sp.base_stats, &ivs, &evs, &nature, level);
                let max_hp = derived.hp;
                let ctx = format!("species {species_id}, level {lvl}, iv_hp {iv_hp}");

                // (a) full HP, no bait -> exactly RECRUIT_BASE_RATE.
                let at_full = recruit_chance(max_hp, max_hp, RECRUIT_BASE_RATE, 0);
                assert_eq!(
                    at_full, RECRUIT_BASE_RATE,
                    "pt-d3-4 clause (a): {ctx}: recruit_chance at full HP with no bait must \
                     equal RECRUIT_BASE_RATE ({RECRUIT_BASE_RATE}), got {at_full}"
                );

                // (b) halving HP beats the best bait at full HP.
                let half = recruit_chance(max_hp, max_hp / 2, RECRUIT_BASE_RATE, 0);
                let baited_full = recruit_chance(max_hp, max_hp, RECRUIT_BASE_RATE, best_bait);
                assert!(
                    half > baited_full,
                    "pt-d3-4 clause (b): {ctx}: halving HP ({half}) must beat the best bait \
                     ({best_bait} bonus) at full HP ({baited_full}) — weakening, not luck, must \
                     remain the dominant lever"
                );

                // (c) at 1 HP, the gain over full HP must be >= 400.
                let at_one = recruit_chance(max_hp, 1, RECRUIT_BASE_RATE, 0);
                let gain = i32::from(at_one) - i32::from(at_full);
                assert!(
                    gain >= 400,
                    "pt-d3-4 clause (c): {ctx}: recruit_chance gain from full HP to 1 HP is \
                     {gain}, must be >= 400 (at_one={at_one}, at_full={at_full})"
                );

                // (d) monotone non-increasing in current_hp over 0..=max_hp.
                let mut prev = recruit_chance(max_hp, 0, RECRUIT_BASE_RATE, 0);
                for hp in 1..=max_hp {
                    let cur = recruit_chance(max_hp, hp, RECRUIT_BASE_RATE, 0);
                    assert!(
                        cur <= prev,
                        "pt-d3-4 clause (d): {ctx}: recruit_chance must be non-increasing as \
                         current_hp rises — at hp={hp} got {cur} > previous {prev}"
                    );
                    prev = cur;
                }
            }
        }
    }

    // Non-vacuity: the (species, level, iv) triple loop above must actually
    // have run at least once — otherwise every clause assertion inside it
    // trivially passed by never executing.
    assert!(
        clause_evals > 0,
        "pt-d3-4: zero H1 clause evaluations ran — the test would pass vacuously"
    );
}

// ===========================================================================
// pt-d3-5 — status-curing items stocked, and stocking is arbitrage-free
// ===========================================================================

// Kills: an implementation that stocks a status-curing item nowhere, or that
// prices a stocked cure item's sell_price >= buy_price (a free-money
// buy-then-sell arbitrage loop).
#[test]
fn pt_d3_5_cures_stocked_and_arbitrage_free() {
    let items = load_items().expect("items registry must parse");
    let shops = load_shops().expect("shops registry must parse");

    for item in &items {
        if item.cure_status.is_none() {
            continue;
        }
        let stocked = shops
            .iter()
            .any(|shop| shop.stock.iter().any(|entry| entry.item_id == item.id));
        assert!(
            stocked,
            "pt-d3-5: item {} ({}) cures {:?} but is not stocked in ANY shop — a status \
             cure a player can never buy",
            item.id, item.name, item.cure_status
        );
    }

    // Anti-arbitrage: sell_price < buy_price for every stocked entry (no
    // infinite-money buy-then-sell loop). Deliberately NOT a ratio band — a
    // blanket 30-50% band was reviewed and rejected as scope-creepy; the
    // convention in this registry today is roughly 40% (see items/000-core.ron),
    // but that convention is not gated here.
    for shop in &shops {
        for entry in &shop.stock {
            let item = items
                .iter()
                .find(|i| i.id == entry.item_id)
                .unwrap_or_else(|| {
                    panic!(
                        "pt-d3-5: shop {} stocks item_id {} which does not exist in the items \
                     registry",
                        shop.id, entry.item_id
                    )
                });
            assert!(
                item.sell_price < entry.buy_price,
                "pt-d3-5: item {} ({}) has sell_price {} >= buy_price {} in shop {} — this is \
                 an arbitrage loop (buy then sell for a profit or break-even)",
                item.id,
                item.name,
                item.sell_price,
                entry.buy_price,
                shop.id
            );
        }
    }
}

// ===========================================================================
// Sanity bands — kills nonsense content (not a tuning pin)
// ===========================================================================

/// A representative wild-battle currency reward, derived from the live
/// content registries rather than a hardcoded number: the max, over every
/// encounter-table entry's species, of `battle_currency_reward`. Used only as a
/// sanity denominator for shop pricing, never as a tuning pin.
///
/// `battle_currency_reward` is a pure function of the LOSER's base-stat total
/// (`bst / BATTLE_CURRENCY_BST_DIVISOR`) — it takes neither level, so no winner
/// or loser level is threaded through here.
fn typical_wild_battle_currency_reward(
    species_rows: &[Species],
    encounters: &[EncounterTable],
) -> u64 {
    encounters
        .iter()
        .flat_map(|table| table.entries.iter())
        .map(|entry| {
            let sp = find_species(species_rows, entry.species_id).unwrap_or_else(|| {
                panic!(
                    "pt-d3-content-sanity: species {} appears in an encounter table but not in \
                     load_species()",
                    entry.species_id
                )
            });
            battle_currency_reward(base_stat_total(&sp.base_stats))
        })
        .max()
        .unwrap_or(0)
}

#[test]
fn pt_d3_content_sanity_bands() {
    let encounters = load_encounters().expect("encounters registry must parse");
    let species_rows = load_species().expect("species registry must parse");
    let shops = load_shops().expect("shops registry must parse");

    for table in &encounters {
        // Sanity guard, NOT a tuning pin: 0 makes the zone dead, 999 makes
        // almost every step an encounter. The exact rate within [1,400] is
        // deliberately unconstrained here.
        assert!(
            (1..=400).contains(&table.encounter_rate),
            "pt-d3-content-sanity: zone {}'s encounter_rate {} is outside the sane band \
             [1,400] — this is a SANITY guard, not a tuning pin",
            table.zone_id,
            table.encounter_rate
        );
        for entry in &table.entries {
            assert!(
                entry.min_level.as_u8() <= entry.max_level.as_u8(),
                "pt-d3-content-sanity: zone {} species {} has min_level {} > max_level {}",
                table.zone_id,
                entry.species_id,
                entry.min_level.as_u8(),
                entry.max_level.as_u8()
            );
            let band_width = entry.max_level.as_u8() - entry.min_level.as_u8();
            // Sanity guard, NOT a tuning pin: kills a catch-all L1-100 band
            // that would trivially (and meaninglessly) satisfy pt-d3-3.
            assert!(
                band_width <= 12,
                "pt-d3-content-sanity: zone {} species {} has level band {}..{} ({} levels \
                 wide), exceeding the sane 12-level width — this is a SANITY guard, not a \
                 tuning pin",
                table.zone_id,
                entry.species_id,
                entry.min_level.as_u8(),
                entry.max_level.as_u8(),
                band_width
            );
        }
    }

    // Shop prices must stay within 100x the typical wild-battle currency
    // faucet, tracked from the real reward formula rather than hardcoded, so a
    // nonsense price (e.g. buy_price: 999999) cannot slip through.
    let typical_reward = typical_wild_battle_currency_reward(&species_rows, &encounters);
    let ceiling = typical_reward * 100;
    for shop in &shops {
        for entry in &shop.stock {
            assert!(
                entry.buy_price <= ceiling,
                "pt-d3-content-sanity: shop {} item_id {} has buy_price {} which exceeds 100x \
                 the typical wild-battle currency reward ({typical_reward}) — this tracks the \
                 real faucet, not a hardcoded price cap",
                shop.id,
                entry.item_id,
                entry.buy_price
            );
        }
    }
}

// ===========================================================================
// Wave-3 tier-0 species are obtainable: wild-legal, and caught below their gate
// ===========================================================================

// A tier-0 species that is in no encounter table (and is no edge target) can
// never be obtained. And level_gate_met is inclusive (>=) while auto-evolution
// fires as soon as exactly one path is eligible, so a wild band reaching the
// lowest outgoing edge min_level ships catches that evolve on the spot.
//
// Scoped to wave 3 (ids 40..=49): species 7 spawns to level 16 in zone 1 while
// its lowest edge gates at 15. Widening this registry-wide waits on
// BUG-evolution-edge2-forecloses-branches, whose Phase-3 fix covers that
// band overlap.
#[test]
fn wave3_tier0_species_are_wild_legal_and_caught_below_their_gate() {
    let species = load_species().expect("species registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");
    let edges = load_evolution_paths().expect("evolution_paths registry must parse");

    let tier0: BTreeSet<u32> = species
        .iter()
        .filter(|s| (40..=49).contains(&s.id) && s.tier == 0)
        .map(|s| s.id)
        .collect();
    assert!(
        !tier0.is_empty(),
        "the wave-3 tier-0 set (ids 40..=49, tier 0) must be non-empty"
    );

    let wild: BTreeSet<u32> = encounters
        .iter()
        .flat_map(|t| t.entries.iter().map(|e| e.species_id))
        .collect();
    let missing: Vec<u32> = tier0.difference(&wild).copied().collect();
    assert!(
        missing.is_empty(),
        "wave-3 tier-0 species in no encounter table: {missing:?}"
    );

    for table in &encounters {
        for entry in table
            .entries
            .iter()
            .filter(|e| tier0.contains(&e.species_id))
        {
            let gate = edges
                .iter()
                .filter(|e| e.from_species == entry.species_id)
                .map(|e| e.min_level.as_u8())
                .min();
            if let Some(gate) = gate {
                assert!(
                    entry.max_level.as_u8() < gate,
                    "zone {} species {} spawns up to level {} but its lowest evolution edge \
                     gates at {gate}: a wild catch at max_level auto-evolves immediately",
                    table.zone_id,
                    entry.species_id,
                    entry.max_level.as_u8()
                );
            }
        }
    }
}
