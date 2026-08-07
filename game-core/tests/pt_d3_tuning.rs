//! pt-d3 — playtest content tuning pass gating tests.
//!
//! RED-first: these tests are written BEFORE the tuning content lands (zone-1
//! encounter table, shop Antidote stock, `CONTENT_VERSION` bump). They encode
//! the EARS criteria for the slice and carry proof-of-teeth built from
//! SYNTHETIC RON strings / in-memory structs — never by mutating the live
//! registry files (a tooth that edits shipped content is not a tooth, it is a
//! content change; ownership of the implementation is split from this file on
//! purpose, ADR-0143 §tester-mandate).
//!
//! Zone 1's per-species weights and level bands are DELIBERATELY NOT pinned —
//! they are tuning data the playtest is meant to revise. Zone 0 IS pinned
//! byte-identically because it has a hard external dependent:
//! `client/e2e/recruit.spec.ts` derives two flake budgets from its exact
//! weights and rate. This asymmetry is a decision, not an oversight.
//!
//! Criteria:
//!   pt-d3-1  wild-legal species set is exactly {1,2,3,7,8,20,21}
//!   pt-d3-2  zone 0 stays byte-identical AND below the derived e2e ceiling
//!   pt-d3-3  no player level in [5,20] is ever encounter-less
//!   pt-d3-4  H1 recruit-chance weakening invariant holds for every wild species
//!   pt-d3-5  every status-curing item is stocked, and stocking is arbitrage-free
//!   pt-d3-6  CONTENT_VERSION floor is at least 15
//!   (T6)     RON comment hygiene extended to encounters/items/shops directories

use std::collections::{BTreeMap, BTreeSet};

use game_core::{
    base_stat_total, battle_currency_reward, battle_xp_reward, derive_stats, level_for_xp,
    load_encounters, load_items, load_shops, load_species, recruit_chance, roll_encounter,
    xp_for_level, EVs, EncounterEntry, EncounterTable, IVs, Level, Nature, NatureKind, Species, Xp,
    RECRUIT_BASE_RATE,
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
// pt-d3-2 — zone 0 frozen below the derived e2e ceiling
// ===========================================================================

/// Reads the live `MAX_ENCOUNTERS` constant out of `client/e2e/recruit.spec.ts`
/// (mirroring the `CARGO_MANIFEST_DIR`-relative path idiom used for
/// `server-module/src/lib.rs` below) so this tooth cannot silently drift from
/// the actual e2e budget the way a hand-copied literal would (`MAX_ENCOUNTERS`
/// was already bumped once in this repo, 14->30, without this test moving).
/// Panics loudly — never falls back to a guessed default — if the file cannot
/// be read, the needle is absent, or the digits following it do not parse,
/// because in any of those cases the forward lock this test enforces is
/// unverifiable and must not silently pass.
fn read_e2e_max_encounters() -> u32 {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../client/e2e/recruit.spec.ts");
    let src = std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "pt-d3-2: could not read {path} to derive MAX_ENCOUNTERS ({e}) — the forward lock \
             against client/e2e/recruit.spec.ts is unverifiable"
        )
    });
    let needle = ["MAX_ENCOUNTERS", " = "].concat();
    let idx = src.find(&needle).unwrap_or_else(|| {
        panic!(
            "pt-d3-2: needle `{needle}` not found in {path} — MAX_ENCOUNTERS could not be \
             located, the forward lock is unverifiable"
        )
    });
    let rest = &src[idx + needle.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().unwrap_or_else(|e| {
        panic!(
            "pt-d3-2: could not parse digits `{digits}` following `{needle}` in {path} as a u32 \
             ({e}) — the forward lock is unverifiable"
        )
    })
}

/// Derives the worst-case (highest base-stat-total) zone-0 spawn a recruiting
/// player can ever fight, straight from the live encounter/species registries,
/// instead of a hand-copied literal that a content change could silently
/// invalidate.
fn derive_worst_zone0_loser_bst(species_rows: &[Species], encounters: &[EncounterTable]) -> u16 {
    let zone0 = encounters.iter().find(|t| t.zone_id == 0).expect(
        "pt-d3-2: zone 0 must exist in the encounter registry to derive the worst-case loser BST",
    );
    zone0
        .entries
        .iter()
        .map(|entry| {
            let sp = find_species(species_rows, entry.species_id).unwrap_or_else(|| {
                panic!(
                    "pt-d3-2: zone-0 species {} appears in the encounter table but not in \
                     load_species()",
                    entry.species_id
                )
            });
            base_stat_total(&sp.base_stats)
        })
        .max()
        .expect("pt-d3-2: zone 0 must have at least one entry to derive the worst-case loser BST")
}

/// Pure, NOT hardcoded: computes the highest player level the remote e2e gate's
/// recruit flow can *possibly* reach, by simulating the worst case — a lead
/// battler that starts at level 5 and wins the maximum `max_encounters`
/// battles against the single highest-BST zone-0 spawn every time (no losses,
/// no fleeing, no in-battle XP loss — the theoretical ceiling). Both inputs are
/// derived from the live e2e spec and the live content registries by the
/// caller (`read_e2e_max_encounters` / `derive_worst_zone0_loser_bst`) rather
/// than hand-copied constants, so this function itself stays pure and
/// side-effect-free.
///
/// If a future change to the XP curve, the zone-0 max_level, or the battle XP
/// formula raises this ceiling to 15 or above, the assertion in
/// `pt_d3_2_derived_e2e_ceiling_is_below_the_forward_lock_threshold` fails
/// LOUDLY instead of silently allowing a species newly eligible only above
/// level 15 (an evolved/late-game form, per the roster design) to slip into a
/// low band the e2e gate can reach.
fn derive_e2e_level_ceiling(max_encounters: u32, worst_loser_bst: u16) -> u8 {
    let start_level = Level::new(5).expect("5 is a valid level");
    let loser_level = Level::new(8).expect("8 is a valid level");
    let mut xp = xp_for_level(start_level);
    let mut current_level = start_level;
    for _ in 0..max_encounters {
        let gain = battle_xp_reward(current_level, worst_loser_bst, loser_level);
        xp = Xp::new(xp.value() + gain.value());
        current_level = level_for_xp(xp);
    }
    current_level.as_u8()
}

/// The pt-d3-2 eligibility predicate, factored out so a synthetic counterexample
/// can prove it is not vacuously green. Returns every zone-0 entry's
/// `species_id` that is BOTH eligible at some level in `[1, up_to_level]` AND
/// not one of the three legacy zone-0 species {1,2,3}.
fn zone0_low_band_intruders(table: &EncounterTable, up_to_level: u8) -> Vec<u32> {
    let allowed = [1u32, 2, 3];
    let mut out: Vec<u32> = table
        .entries
        .iter()
        .filter(|e| e.min_level.as_u8() <= up_to_level)
        .filter(|e| !allowed.contains(&e.species_id))
        .map(|e| e.species_id)
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

#[test]
fn pt_d3_2_derived_e2e_ceiling_is_below_the_forward_lock_threshold() {
    let max_encounters = read_e2e_max_encounters();
    let encounters = load_encounters().expect("encounters registry must parse");
    let species_rows = load_species().expect("species registry must parse");
    let worst_loser_bst = derive_worst_zone0_loser_bst(&species_rows, &encounters);
    let ceiling = derive_e2e_level_ceiling(max_encounters, worst_loser_bst);
    assert!(
        ceiling < 15,
        "pt-d3-2: the derived e2e reachable-level ceiling is {ceiling}, which is >= 15 — \
         a future XP/level-curve change has widened the window the recruit e2e gate can \
         reach; re-check the derivations against client/e2e/recruit.spec.ts and the live \
         content registries before relaxing this bound"
    );
}

#[test]
fn pt_d3_2_zone0_table_is_byte_identical_to_the_pre_tuning_shape() {
    let encounters = load_encounters().expect("encounters registry must parse");
    let zone0 = encounters
        .iter()
        .find(|t| t.zone_id == 0)
        .expect("pt-d3-2: zone 0 must still exist in the encounter registry");

    assert_eq!(
        zone0.encounter_rate, 200,
        "pt-d3-2: zone 0 encounter_rate must stay byte-identical at 200"
    );

    let want = vec![
        EncounterEntry {
            species_id: 1,
            weight: 10,
            min_level: Level::new(3).expect("valid level"),
            max_level: Level::new(7).expect("valid level"),
        },
        EncounterEntry {
            species_id: 2,
            weight: 7,
            min_level: Level::new(3).expect("valid level"),
            max_level: Level::new(7).expect("valid level"),
        },
        EncounterEntry {
            species_id: 3,
            weight: 5,
            min_level: Level::new(4).expect("valid level"),
            max_level: Level::new(8).expect("valid level"),
        },
    ];
    assert_eq!(
        zone0.entries, want,
        "pt-d3-2: zone 0's three entries must stay byte-identical (species/weight/band) — \
         the tuning pass appends a NEW zone-1 table, it must never touch zone 0"
    );

    for level in 1u8..=14 {
        let intruders = zone0_low_band_intruders(zone0, level);
        assert!(
            intruders.is_empty(),
            "pt-d3-2: at player level {level}, zone 0 has an eligible entry for \
             species {intruders:?} outside the legacy {{1,2,3}} set — a new species was \
             added to zone 0 (forbidden) or added below the derived e2e ceiling"
        );
    }
}

#[test]
fn pt_d3_2_teeth_low_band_intruder_predicate_is_not_vacuous() {
    // TEETH(pt-d3-2): a synthetic zone-0-shaped table carrying a fourth entry
    // (species 7, eligible from level 5) must be caught when checked up to
    // level 14 — this proves `zone0_low_band_intruders` is not vacuously empty.
    let synthetic = EncounterTable {
        zone_id: 0,
        encounter_rate: 200,
        entries: vec![
            EncounterEntry {
                species_id: 1,
                weight: 10,
                min_level: Level::new(3).expect("valid level"),
                max_level: Level::new(7).expect("valid level"),
            },
            EncounterEntry {
                species_id: 7,
                weight: 8,
                min_level: Level::new(5).expect("valid level"),
                max_level: Level::new(16).expect("valid level"),
            },
        ],
    };
    assert_eq!(
        zone0_low_band_intruders(&synthetic, 14),
        vec![7],
        "TEETH(pt-d3-2): a species eligible below the ceiling that is not in {{1,2,3}} \
         must be reported by species id"
    );
    // Non-vacuity, other direction: the legacy set alone reports nothing.
    let legacy_only = EncounterTable {
        zone_id: 0,
        encounter_rate: 200,
        entries: vec![EncounterEntry {
            species_id: 1,
            weight: 10,
            min_level: Level::new(3).expect("valid level"),
            max_level: Level::new(7).expect("valid level"),
        }],
    };
    assert!(
        zone0_low_band_intruders(&legacy_only, 14).is_empty(),
        "TEETH(pt-d3-2): the legacy-only table must never be flagged"
    );
}

// ===========================================================================
// pt-d3-1 — wild-legal species set is exact
// ===========================================================================

// Kills: an implementation that only adds SOME of the new wild species (e.g.
// forgets species 8 or 21), or that smuggles an extra species into an
// encounter table beyond the pinned {1,2,3,7,8,20,21} set.
#[test]
fn pt_d3_1_wild_legal_set_is_exact() {
    let encounters = load_encounters().expect("encounters registry must parse");
    let mut wild: BTreeSet<u32> = BTreeSet::new();
    for table in &encounters {
        for entry in &table.entries {
            wild.insert(entry.species_id);
        }
    }
    let want: BTreeSet<u32> = [1u32, 2, 3, 7, 8, 20, 21].into_iter().collect();
    assert_eq!(
        wild, want,
        "pt-d3-1: the union of every encounter table's species_id must be EXACTLY \
         {{1,2,3,7,8,20,21}} — set EQUALITY (not superset) so both a dropped base form \
         and a smuggled derived form bite. Currently RED: only species {{1,2,3}} are wild."
    );

    let derived: BTreeSet<u32> = [4u32, 5, 6, 9, 10, 22, 23].into_iter().collect();
    // Documentation-only / belt-and-suspenders: this is logically implied by
    // the `assert_eq!` above (the `want` set and `derived` are already
    // disjoint by construction), kept as an explicit, independently-readable
    // invariant rather than relied on implicitly.
    assert!(
        wild.is_disjoint(&derived),
        "pt-d3-1: the wild-legal set must be disjoint from the derived-only set \
         {{4,5,6,9,10,22,23}} — a derived species in an encounter table must be rejected by \
         `validate_evolution_fusion` step 6 (derived-forms-not-wild), so if this fires the \
         validator itself has a gap, not just this test"
    );
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
    // what makes the count assertion RED today (currently 3, not 7).
    assert_eq!(
        levels_by_species.len(),
        7,
        "pt-d3-4: expected exactly 7 wild-encounterable species once zone 1 lands, found {}",
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
// pt-d3-6 — CONTENT_VERSION floor
// ===========================================================================

/// Copied verbatim from `game-core/tests/pt_d1_roster.rs` (already correct:
/// word-boundary-anchored, uniqueness-required, `None` on two genuine
/// declarations). Not re-derived here to avoid two subtly-different parsers
/// drifting apart; `pt_d1_roster.rs` is deliberately NOT edited by this slice
/// (its residual note about `evals/content-version.eval.mjs`'s weaker
/// first-substring-wins scan is recorded as ADR-0145 here, not fixed there).
fn parse_content_version(src: &str) -> Option<u32> {
    let needle = ["CONTENT_VERSION", ": u32 = "].concat();
    let mut found: Option<u32> = None;
    let mut from = 0usize;
    while let Some(rel) = src[from..].find(&needle) {
        let idx = from + rel;
        from = idx + needle.len();
        let preceded_by_ident = src[..idx]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        if preceded_by_ident {
            continue;
        }
        let rest = &src[from..];
        let end = match rest.find(';') {
            Some(e) => e,
            None => continue,
        };
        let value = rest[..end].trim().parse::<u32>().ok()?;
        if found.is_some() {
            return None;
        }
        found = Some(value);
    }
    found
}

#[test]
fn pt_d3_6_content_version_floor_is_at_least_15() {
    let src = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../server-module/src/lib.rs"
    ))
    .expect("server-module/src/lib.rs must be readable from game-core/tests");
    let version = parse_content_version(&src)
        .expect("pt-d3-6: the CONTENT_VERSION declaration must be present and parseable");
    // An upper bound was considered and declined: an oversized CONTENT_VERSION
    // is harmless (it only gates the re-seed), so there is no failure mode
    // behind such a gate.
    assert!(
        version >= 15,
        "pt-d3-6: CONTENT_VERSION is {version}; the tuning pass (zone-1 encounters, Antidote \
         shop stock) needs >= 15 or sync_content_inner early-returns and the new content never \
         reaches a live DB"
    );
}

#[test]
fn pt_d3_6_teeth_needle_parser_survives_a_decoy_above_the_real_declaration() {
    // TEETH(pt-d3-6/1): a decoy constant whose name merely ENDS IN the needle,
    // declared ABOVE the real one, must not shadow it.
    let decoyed = [
        "pub(crate) const MIN_SUPPORTED_",
        "CONTENT_VERSION",
        ": u32 = ",
        "99;\npub(crate) const ",
        "CONTENT_VERSION",
        ": u32 = ",
        "15;\n",
    ]
    .concat();
    assert_eq!(
        parse_content_version(&decoyed),
        Some(15),
        "TEETH(pt-d3-6/1): a decoy constant ending in the needle, declared above the real \
         one, must NOT shadow the real CONTENT_VERSION"
    );

    // TEETH(pt-d3-6/2): two genuine declarations are ambiguous; refuse to guess.
    let doubled = [
        "const ",
        "CONTENT_VERSION",
        ": u32 = ",
        "15;\nconst ",
        "CONTENT_VERSION",
        ": u32 = ",
        "16;\n",
    ]
    .concat();
    assert_eq!(
        parse_content_version(&doubled),
        None,
        "TEETH(pt-d3-6/2): two real declarations must be reported as unparseable, not silently \
         resolved to the first hit"
    );
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
// T6 — RON comment hygiene extended to encounters/items/shops directories.
// A regression lock (green by design against today's content); teeth are
// synthetic strings only, never a mutation of the shipped RON.
// ===========================================================================

/// Returns every zone-0-shaped RON comment (line OR block) that carries an
/// id-shaped needle. This is a DELIBERATE hardening over
/// `pt_d1_roster.rs::comment_needle_violations`: that helper only sees `//`
/// line comments. The `ron` crate also accepts `/* ... */` block comments, and
/// a red-team pass showed a phantom id hidden inside one — including a block
/// comment spanning multiple lines — is completely invisible to a line-based
/// scanner. `append-only-ids.eval.mjs` strips whole-line `//` comments only and
/// never strips block comments at all: it REFUSES the whole registry when a
/// needle sits inside one. Its EG5-1 sibling
/// `evolution-content-integrity.eval.mjs` (renamed from
/// `evolution-fusion-content-integrity.eval.mjs`) takes the same refusal stance
/// for the `edge_id:` needles its R12 ledger depends on. So ANY needle inside a
/// block-comment span is dangerous — unlike a whole-line `//` comment, which
/// both evals do strip and is therefore safe.
fn comment_needle_violations(file_label: &str, src: &str) -> Vec<String> {
    let needles = ["to_species:", "species_id:", "id:"];
    let mut out = Vec::new();

    let chars: Vec<char> = src.chars().collect();
    let len = chars.len();
    let mut i = 0usize;
    let mut line_no = 1usize;
    // Whether any non-whitespace, non-comment content has been seen so far on
    // the CURRENT physical line — used only to decide whether a `//` line
    // comment is "trailing" (unsafe) or "whole-line" (safe, mirrors pt-d1).
    // Block comments are unconditionally flagged regardless of this flag.
    let mut code_seen_on_line = false;
    // Whether we are currently inside a RON `"..."` string literal — needed so
    // e.g. `description: "See http://wiki.example/lore#id: 5"` is not misread
    // as containing a trailing `//` comment with an `id:` needle.
    let mut in_string = false;

    while i < len {
        let c = chars[i];
        if c == '\n' {
            line_no += 1;
            code_seen_on_line = false;
            i += 1;
            continue;
        }

        if in_string {
            if c == '\\' {
                i += 2;
            } else if c == '"' {
                in_string = false;
                i += 1;
            } else {
                i += 1;
            }
            code_seen_on_line = true;
            continue;
        }

        if c == '"' {
            in_string = true;
            code_seen_on_line = true;
            i += 1;
            continue;
        }

        if c == '/' && i + 1 < len && chars[i + 1] == '*' {
            let start_line = line_no;
            let mut j = i + 2;
            let mut comment = String::new();
            let mut depth = 1usize;
            while j < len {
                if chars[j] == '\n' {
                    line_no += 1;
                }
                if chars[j] == '/' && j + 1 < len && chars[j + 1] == '*' {
                    depth += 1;
                    comment.push(chars[j]);
                    comment.push(chars[j + 1]);
                    j += 2;
                    continue;
                }
                if chars[j] == '*' && j + 1 < len && chars[j + 1] == '/' {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        break;
                    }
                    comment.push('*');
                    comment.push('/');
                    continue;
                }
                comment.push(chars[j]);
                j += 1;
            }
            if let Some(needle) = needles.iter().find(|n| comment.contains(*n)) {
                out.push(format!(
                    "{file_label}:{start_line}: block comment `/* ... */` contains `{needle}` \
                     — use the `id=N` form (block comments are NEVER stripped by \
                     append-only-ids.eval.mjs, which refuses the registry instead; \
                     evolution-content-integrity.eval.mjs refuses the same way for its \
                     `edge_id:` needles)"
                ));
            }
            i = j;
            continue;
        }

        if c == '/' && i + 1 < len && chars[i + 1] == '/' {
            let mut j = i + 2;
            let mut comment_rest = String::new();
            while j < len && chars[j] != '\n' {
                comment_rest.push(chars[j]);
                j += 1;
            }
            if code_seen_on_line {
                if let Some(needle) = needles.iter().find(|n| comment_rest.contains(*n)) {
                    out.push(format!(
                        "{file_label}:{line_no}: trailing comment contains `{needle}` — use \
                         the `id=N` form"
                    ));
                }
            }
            i = j;
            continue;
        }

        if !c.is_whitespace() {
            code_seen_on_line = true;
        }
        i += 1;
    }

    out
}

#[test]
fn t6_ron_comment_hygiene_over_tuning_dirs() {
    // Dirs pt-d1's `pt_d1_7` does NOT cover (it scans only `species/**` +
    // `evolutions.ron`).
    let content_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/content");
    let dirs = ["encounters", "items", "shops"];
    let mut violations = Vec::new();

    for dir in dirs {
        let path = format!("{content_dir}/{dir}");
        let mut parts: Vec<_> = std::fs::read_dir(&path)
            .unwrap_or_else(|e| panic!("t6: content directory {path} must exist: {e}"))
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "ron"))
            .collect();
        parts.sort();
        assert!(
            !parts.is_empty(),
            "t6: expected at least one .ron part file in {path}"
        );
        for p in &parts {
            let label = format!("{dir}/{}", p.file_name().unwrap().to_string_lossy());
            let src = std::fs::read_to_string(p)
                .unwrap_or_else(|e| panic!("t6: {label} must be readable: {e}"));
            violations.extend(comment_needle_violations(&label, &src));
        }
    }

    assert!(
        violations.is_empty(),
        "t6: RON comments in encounters/items/shops must not carry id-shaped needles (line OR \
         block): {violations:?}"
    );
}

#[test]
fn t6_teeth_trailing_line_comment_needle_is_flagged() {
    let bad = "    (species_id: 1, weight: 10, min_level: 3, max_level: 7), // species_id: 99\n";
    let violations = comment_needle_violations("f.ron", bad);
    assert_eq!(
        violations.len(),
        1,
        "TEETH(t6/1): a trailing `//` comment carrying `species_id:` must be flagged exactly \
         once, got {violations:?}"
    );
}

#[test]
fn t6_teeth_single_line_block_comment_needle_is_flagged() {
    let bad = "    (species_id: 1, weight: 10 /* species_id: 99, to_species: 4 */),\n";
    let violations = comment_needle_violations("f.ron", bad);
    assert_eq!(
        violations.len(),
        1,
        "TEETH(t6/2): a single-line `/* ... */` block comment carrying an id-shaped needle \
         must be flagged — this is exactly the phantom-id injection invisible to a line-based \
         scanner; got {violations:?}"
    );
}

#[test]
fn t6_teeth_multiline_block_comment_interior_needle_is_flagged() {
    let bad = "    (species_id: 1, weight: 10), /* a note here\n     species_id: 99 on an \
               interior line\n     end of note */\n";
    let violations = comment_needle_violations("f.ron", bad);
    assert_eq!(
        violations.len(),
        1,
        "TEETH(t6/3): a needle on an INTERIOR line of a multi-line block comment must still be \
         flagged — got {violations:?}"
    );
}

#[test]
fn t6_teeth_nested_block_comment_needle_is_flagged() {
    // TEETH(t6/nesting): the `ron` crate treats nested `/* /* */ */` block
    // comments as ONE comment (verified:
    // `ron::from_str::<Vec<i32>>("[1, 2, /* note /* nested */ species_id: 99 */]")`
    // parses `Ok`). A depth-unaware scanner exits at the FIRST `*/`, leaving
    // `species_id: 99` classified as ordinary code and returning ZERO
    // violations — this tooth is what keeps the nesting-depth tracking alive.
    let bad = "    (species_id: 1, weight: 10), /* note /* nested */ species_id: 99 */\n";
    let violations = comment_needle_violations("f.ron", bad);
    assert_eq!(
        violations.len(),
        1,
        "TEETH(t6/nesting): a needle inside a nested `/* /* */ */` block comment (which `ron` \
         treats as ONE comment) must be flagged; a depth-unaware scanner that exits at the \
         first `*/` misclassifies the needle as code and reports zero violations — got \
         {violations:?}"
    );
}

#[test]
fn t6_teeth_url_in_string_literal_is_not_flagged() {
    // TEETH(t6/string): a string-unaware scanner reads the `//` inside this
    // URL as a trailing line comment and finds the `id:` needle inside it,
    // redding CI for a completely innocent content author.
    let good = "    description: \"See http://wiki.example/lore#id: 5 for background\",\n";
    let violations = comment_needle_violations("f.ron", good);
    assert!(
        violations.is_empty(),
        "TEETH(t6/string): a `//` occurring INSIDE a string literal must never be treated as a \
         comment — got {violations:?}"
    );

    // Paired counter-tooth: string-awareness must not blind the scanner to a
    // GENUINE trailing comment that merely follows a string field on the same
    // line.
    let still_bad = "    description: \"harmless text\", // id: 5\n";
    let violations = comment_needle_violations("f.ron", still_bad);
    assert_eq!(
        violations.len(),
        1,
        "TEETH(t6/string-counter): a real trailing `//` comment carrying an id-shaped needle, \
         occurring AFTER a string literal on the same line, must still be flagged — got \
         {violations:?}"
    );
}

#[test]
fn t6_teeth_good_fixture_is_accepted() {
    let good = "    // block for species_id: 7 below\n    ability: Some(2), // Vital Spirit \
                (id=2)\n";
    let violations = comment_needle_violations("f.ron", good);
    assert!(
        violations.is_empty(),
        "TEETH(t6/4): a whole-line `//` comment (stripped by both real evals) and the \
         sanctioned `id=N` form must both stay legal — got {violations:?}"
    );
}
