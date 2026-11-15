//! Content-over-live-RON gameplay invariants for encounters, recruiting and
//! shops. Each test runs production functions (roll_encounter, recruit_chance,
//! battle_currency_reward) over the shipped registries.

use std::collections::{BTreeMap, BTreeSet};

use game_core::interact::npc_offers_shop;
use game_core::tactics::{effective_pack, roll_pack_size, MAX_PACK};
use game_core::{
    base_stat_total, battle_currency_reward, build_monster, derive_stats, eligible_evolution_paths,
    load_encounters, load_evolution_paths, load_heal_locations, load_items, load_npc_defs,
    load_shops, load_species, load_starter_kit, load_tactics_items, load_tactics_zones,
    recruit_chance, roll_encounter, EVs, EncounterTable, HealLocationDef, IVs, Level, Nature,
    NatureKind, NpcDef, ShopDef, Species, RECRUIT_BASE_RATE,
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
// Wave-3 tier-0 species are obtainable (wild-legal)
// ===========================================================================

// A tier-0 species that is in no encounter table (and is no edge target) can
// never be obtained.
#[test]
fn wave3_tier0_species_are_wild_legal() {
    let species = load_species().expect("species registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");

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
}

// ===========================================================================
// No wild catch is evolution-eligible on the spot (every species, every table)
// ===========================================================================

// Auto-evolution fires as soon as exactly one path is eligible, so a wild catch
// that is ALREADY eligible evolves the moment it is caught. The oracle is the
// real eligibility query over a monster built exactly as a recruit is
// (build_monster at the band's max_level: no essence, no Trust/Quality-Time
// history) — not a level-only comparison: an edge whose min_level the band
// reaches is fine when its other gates (essence, trust, ...) cannot be met by a
// fresh catch. Species 7 is that case (spawns to L16; edge 7->30 gates at L15 but
// also needs 100 Water essence).
//
// KNOWN EXCEPTION, surfaced to the user (ledger BUG-evolution-edge2-forecloses-branches), NOT
// fixed here because the Phase-3 ruling is "no content change": zone 1 spawns species 1 up to
// L20 and edge 1 (1->4) gates at exactly L20 with no other requirement, so a max-level wild
// Flameling is eligible for 1->4 alone and auto-evolves on its first credit, foreclosing 1->6.
// The exception list is exact: an entry that stops being eligible fails this test too, so the
// list cannot silently outlive the content it describes.
const KNOWN_ELIGIBLE_AT_CATCH: &[(u32, u32, u32)] = &[(1, 1, 1)]; // (zone, species, edge)

#[test]
fn no_wild_catch_is_evolution_eligible_on_the_spot() {
    let species = load_species().expect("species registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");
    let edges = load_evolution_paths().expect("evolution_paths registry must parse");
    let by_id: BTreeMap<u32, &Species> = species.iter().map(|s| (s.id, s)).collect();

    let mut checked = 0usize;
    let mut level_reached = 0usize;
    let mut excepted: Vec<(u32, u32, u32)> = Vec::new();
    for table in &encounters {
        for entry in &table.entries {
            let sp = by_id.get(&entry.species_id).unwrap_or_else(|| {
                panic!(
                    "encounter species {} is not in the registry",
                    entry.species_id
                )
            });
            let caught = build_monster(0, sp, entry.max_level);
            let mut eligible = eligible_evolution_paths(&caught, &edges);
            eligible.retain(|&i| {
                let key = (table.zone_id, entry.species_id, edges[i].edge_id);
                let known = KNOWN_ELIGIBLE_AT_CATCH.contains(&key);
                if known {
                    excepted.push(key);
                }
                !known
            });
            assert!(
                eligible.is_empty(),
                "zone {} species {} caught at max_level {} is already eligible for edge(s) {:?}: \
                 it would auto-evolve the moment it is caught",
                table.zone_id,
                entry.species_id,
                entry.max_level.as_u8(),
                eligible
                    .iter()
                    .map(|&i| edges[i].edge_id)
                    .collect::<Vec<_>>()
            );
            checked += 1;
            if edges.iter().any(|e| {
                e.from_species == entry.species_id && e.min_level.as_u8() <= entry.max_level.as_u8()
            }) {
                level_reached += 1;
            }
        }
    }
    assert!(checked > 0, "no encounter entries were checked");
    assert_eq!(
        excepted,
        KNOWN_ELIGIBLE_AT_CATCH.to_vec(),
        "KNOWN_ELIGIBLE_AT_CATCH is stale: every listed (zone, species, edge) must still be \
         eligible at catch (remove fixed entries)"
    );
    assert!(
        level_reached > 0,
        "no band reaches an out-edge min_level, so this test no longer exercises the non-level \
         gates (species 7 used to): re-check the oracle"
    );
}

// ===========================================================================
// Faucet/sink tuning — the kit, the heal sink, the recruit loop and battle-item prices.
// The reasoning behind each relation lives in docs/economy-tuning.md.
// ===========================================================================

/// The Lure Berry's item id (item ids are append-only, so the constant is a stable handle).
const LURE_BERRY_ITEM_ID: u32 = 1;

/// Zone 0, Verdant Hollow: the zone a fresh player battles in first.
const ZONE0_ID: u32 = 0;

/// The most zone-0 recruit-heavy battles one Lure Berry may cost.
const LURE_BERRY_BATTLE_BUDGET: u64 = 15;

/// The shops some NPC offers, by the server's own predicate (`npc_offers_shop`). A shop no NPC
/// offers has no price a player pays. Whether the NPC's tile can be walked to is world content
/// this file does not check.
fn npc_opened_shops<'a>(shops: &'a [ShopDef], npcs: &[NpcDef]) -> Vec<&'a ShopDef> {
    shops
        .iter()
        .filter(|shop| {
            npcs.iter()
                .any(|npc| npc_offers_shop(npc.interaction, Some(shop.id)))
        })
        .collect()
}

/// The Lure Berry's price: the lowest `buy_price` any NPC-opened shop asks for it. No
/// NPC-opened shop stocking it is a panic, and the price is above 0.
fn lure_berry_price(opened: &[&ShopDef]) -> u64 {
    let price = opened
        .iter()
        .flat_map(|shop| shop.stock.iter())
        .filter(|entry| entry.item_id == LURE_BERRY_ITEM_ID)
        .map(|entry| entry.buy_price)
        .min()
        .unwrap_or_else(|| {
            panic!(
                "no shop an NPC opens stocks the Lure Berry (item {LURE_BERRY_ITEM_ID}): stock it \
                 in a shop in game-core/content/shops/000-core.ron that an NPC opens with \
                 `interaction: Shop(id)` in game-core/content/npcs/000-core.ron (reasoning: \
                 docs/economy-tuning.md)"
            )
        });
    assert!(
        price > 0,
        "the Lure Berry (item {LURE_BERRY_ITEM_ID}) has buy_price 0 in a shop an NPC opens: a 0 \
         price means not for sale — fix its `buy_price` in game-core/content/shops/000-core.ron \
         (reasoning: docs/economy-tuning.md)"
    );
    price
}

// The starter kit's currency alone buys one Lure Berry at the cheapest shop an NPC opens.
#[test]
fn starter_kit_currency_buys_one_lure_berry() {
    let items = load_items().expect("items registry must parse");
    let shops = load_shops().expect("shops registry must parse");
    let npcs = load_npc_defs().expect("npc registry must parse");
    let kit = load_starter_kit().expect("starter kit must parse");

    let lure = items
        .iter()
        .find(|item| item.id == LURE_BERRY_ITEM_ID)
        .unwrap_or_else(|| {
            panic!(
                "item {LURE_BERRY_ITEM_ID} (the Lure Berry) is missing from \
                 game-core/content/items/000-core.ron (reasoning: docs/economy-tuning.md)"
            )
        });
    assert!(
        lure.recruit_bonus > 0,
        "item {LURE_BERRY_ITEM_ID} ({}) has recruit_bonus 0, so it is not a bait: the Lure Berry \
         constant points at the wrong item in game-core/content/items/000-core.ron (reasoning: \
         docs/economy-tuning.md)",
        lure.name
    );

    let opened = npc_opened_shops(&shops, &npcs);
    let price = lure_berry_price(&opened);
    assert!(
        kit.currency >= price,
        "the starter kit's currency {} cannot buy one Lure Berry at {price}: raise `currency` in \
         game-core/content/starter_kit.ron or lower the Lure Berry's `buy_price` in \
         game-core/content/shops/000-core.ron (reasoning: docs/economy-tuning.md)",
        kit.currency
    );
}

// Every shipped heal location heals for free: no currency, no item, no quantity.
#[test]
fn shipped_heal_locations_charge_nothing() {
    let locations = load_heal_locations().expect("heal_locations registry must parse");
    assert!(
        !locations.is_empty(),
        "game-core/content/heal_locations/000-core.ron ships no heal location, so there is \
         nothing to check (reasoning: docs/economy-tuning.md)"
    );

    for location in &locations {
        // No `..`: a cost field added to HealLocationDef stops this compiling until "charges
        // nothing" is decided for it.
        let HealLocationDef {
            location_id,
            zone_id: _,
            tile_x: _,
            tile_y: _,
            cost_item_id,
            cost_qty,
            cooldown_ms: _,
            cost_currency,
        } = location;
        assert_eq!(
            *cost_currency, 0,
            "heal location {location_id} charges cost_currency {cost_currency}: set \
             `cost_currency: 0` in game-core/content/heal_locations/000-core.ron (reasoning: \
             docs/economy-tuning.md)"
        );
        assert!(
            cost_item_id.is_none(),
            "heal location {location_id} charges cost_item_id {cost_item_id:?}: set \
             `cost_item_id: None` in game-core/content/heal_locations/000-core.ron (reasoning: \
             docs/economy-tuning.md)"
        );
        assert_eq!(
            *cost_qty, 0,
            "heal location {location_id} charges cost_qty {cost_qty}: set `cost_qty: 0` in \
             game-core/content/heal_locations/000-core.ron (reasoning: docs/economy-tuning.md)"
        );
    }
}

// The expected currency of one recruit-heavy zone-0 wild battle buys a Lure Berry within
// LURE_BERRY_BATTLE_BUDGET battles. The battle KOs every wild but the one recruited, each KO
// paying the reward of the zone's spawn-weighted mean BST. The model assumes a party of
// MAX_PACK conscious monsters; a smaller party meets smaller packs.
#[test]
fn recruit_heavy_zone0_battles_buy_a_lure_berry_within_the_battle_budget() {
    let tactics_zones = load_tactics_zones().expect("tactics_zones registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");
    let species_rows = load_species().expect("species registry must parse");
    let shops = load_shops().expect("shops registry must parse");
    let npcs = load_npc_defs().expect("npc registry must parse");

    let zone0 = tactics_zones
        .iter()
        .find(|zone| zone.zone_id == ZONE0_ID)
        .unwrap_or_else(|| {
            panic!(
                "zone {ZONE0_ID} has no row in game-core/content/tactics_zones/000-core.ron \
                 (reasoning: docs/economy-tuning.md)"
            )
        });

    // The production pack roll over each per-mille residue once.
    let mut kos_per_1000: u64 = 0;
    for r in 0u64..1000 {
        let rolled = roll_pack_size(&zone0.pack_weights, r).unwrap_or_else(|e| {
            panic!(
                "roll_pack_size rejects zone {ZONE0_ID}'s pack_weights at r={r}: {e:?} — fix \
                 `pack_weights` in game-core/content/tactics_zones/000-core.ron (reasoning: \
                 docs/economy-tuning.md)"
            )
        });
        let pack = effective_pack(rolled, MAX_PACK).unwrap_or_else(|e| {
            panic!("effective_pack rejects rolled={rolled} for a party of {MAX_PACK}: {e:?}")
        });
        let kos = u64::from(pack)
            .checked_sub(1)
            .unwrap_or_else(|| panic!("effective_pack returned an empty pack at r={r}"));
        kos_per_1000 += kos;
    }
    assert!(
        kos_per_1000 > 0,
        "zone {ZONE0_ID}'s pack_weights field only single-wild packs, so a recruit-heavy battle \
         KOs nothing and pays nothing: fix `pack_weights` in \
         game-core/content/tactics_zones/000-core.ron (reasoning: docs/economy-tuning.md)"
    );

    let table = encounters
        .iter()
        .find(|table| table.zone_id == ZONE0_ID)
        .unwrap_or_else(|| {
            panic!(
                "zone {ZONE0_ID} has no table in game-core/content/encounters/000-core.ron \
                 (reasoning: docs/economy-tuning.md)"
            )
        });
    let mut weight_sum: u64 = 0;
    let mut weighted_bst: u64 = 0;
    for entry in &table.entries {
        let sp = find_species(&species_rows, entry.species_id).unwrap_or_else(|| {
            panic!(
                "zone {ZONE0_ID} encounter species {} is not in load_species() \
                 (game-core/content/species/)",
                entry.species_id
            )
        });
        let weight = u64::from(entry.weight);
        weight_sum += weight;
        weighted_bst += weight * u64::from(base_stat_total(&sp.base_stats));
    }
    assert!(
        weight_sum > 0,
        "zone {ZONE0_ID}'s encounter entries carry zero total weight in \
         game-core/content/encounters/000-core.ron, so the mean wild BST is undefined \
         (reasoning: docs/economy-tuning.md)"
    );
    let mean_bst = u16::try_from(weighted_bst / weight_sum)
        .expect("a weighted mean of u16 base-stat totals fits in u16");
    let ko_reward = battle_currency_reward(mean_bst);

    let opened = npc_opened_shops(&shops, &npcs);
    let lure_price = lure_berry_price(&opened);

    assert!(
        LURE_BERRY_BATTLE_BUDGET * ko_reward * kos_per_1000 >= lure_price * 1000,
        "{LURE_BERRY_BATTLE_BUDGET} recruit-heavy zone-{ZONE0_ID} battles pay \
         {LURE_BERRY_BATTLE_BUDGET} x {ko_reward} gold per KO x {kos_per_1000} KOs per 1000 \
         battles / 1000, short of the Lure Berry's {lure_price}: tune zone {ZONE0_ID}'s \
         `pack_weights` (game-core/content/tactics_zones/000-core.ron), its encounter `weight`s \
         (game-core/content/encounters/000-core.ron) or the Lure Berry's `buy_price` \
         (game-core/content/shops/000-core.ron) (reasoning: docs/economy-tuning.md)"
    );
}

/// The median buy price of a shop's stock: the sorted prices at index `(n - 1) / 2` (the lower
/// middle when n is even). `None` for an empty stock.
fn median_buy_price(shop: &ShopDef) -> Option<u64> {
    let mut prices: Vec<u64> = shop.stock.iter().map(|entry| entry.buy_price).collect();
    prices.sort_unstable();
    let index = prices.len().checked_sub(1)? / 2;
    prices.get(index).copied()
}

// Every battle-usable item is sold by an NPC-opened shop at a price above 0 and at or below
// that shop's median buy price, so its flat AP cost is balanced by a price a player pays.
#[test]
fn every_battle_usable_item_sells_at_or_below_its_shop_median() {
    let tactics_items = load_tactics_items().expect("tactics_items registry must parse");
    let items = load_items().expect("items registry must parse");
    let shops = load_shops().expect("shops registry must parse");
    let npcs = load_npc_defs().expect("npc registry must parse");

    assert!(
        !tactics_items.is_empty(),
        "game-core/content/tactics_items/000-core.ron ships no battle-usable item, so there is \
         nothing to check (reasoning: docs/economy-tuning.md)"
    );

    let opened = npc_opened_shops(&shops, &npcs);
    for row in &tactics_items {
        let item = items
            .iter()
            .find(|item| item.id == row.item_id)
            .unwrap_or_else(|| {
                panic!(
                    "battle-usable item {} in game-core/content/tactics_items/000-core.ron is \
                     missing from game-core/content/items/000-core.ron",
                    row.item_id
                )
            });

        // (shop id, the item's price there, that shop's median)
        let offers: Vec<(u32, u64, u64)> = opened
            .iter()
            .flat_map(|shop| {
                let median = median_buy_price(shop);
                shop.stock
                    .iter()
                    .filter(|entry| entry.item_id == row.item_id)
                    .map(move |entry| {
                        let median = median.unwrap_or_else(|| {
                            panic!(
                                "shop {} stocks item {} but has no median",
                                shop.id, entry.item_id
                            )
                        });
                        (shop.id, entry.buy_price, median)
                    })
            })
            .collect();

        let sold_fairly = offers
            .iter()
            .any(|&(_, price, median)| price > 0 && price <= median);
        assert!(
            sold_fairly,
            "battle-usable item {} ({}) is sold by no NPC-opened shop at a buy_price above 0 \
             and at or below that shop's median; NPC-opened offers as (shop, price, median): \
             {offers:?} — fix its `buy_price` in game-core/content/shops/000-core.ron or stock it \
             in a shop an NPC opens (game-core/content/npcs/000-core.ron) (reasoning: \
             docs/economy-tuning.md)",
            item.id, item.name
        );
    }
}
