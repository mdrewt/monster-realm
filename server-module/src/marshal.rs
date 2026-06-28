//! `marshal` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Row <-> `game-core` domain marshaling helpers (and `now_ms`, the platform
//! timestamp -> `game_core::Millis` i64 marshal). Intentionally repetitive — DRY
//! does not cross the marshaling boundary. These are pure (no DB I/O); `now_ms`
//! reads only `ctx.timestamp`.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::schema::{
    Character, EncounterEntryRow, EncounterRow, Monster, MonsterPub, SkillRow, SpeciesRow,
    TypeRelationRow,
};
use game_core::{
    derive_stats, roll_individuality, BattleMonster, CharacterState, EVs, EncounterEntry,
    EncounterTable, Level, Millis, MonsterInstance, SkillDef, StatBlock, StatKind, TilePos,
    TypeChart,
};
use spacetimedb::{Identity, ReducerContext};

pub(crate) fn now_ms(ctx: &ReducerContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch().max(0) / 1000
}

// `convert` seam: flatten `game-core::CharacterState` <-> `character` columns. The
// shared type stays the SSOT while the table stays queryable. Intentionally
// repetitive — DRY does not cross the marshaling boundary.
pub(crate) fn char_state(row: &Character) -> CharacterState {
    CharacterState {
        pos: TilePos {
            x: row.tile_x,
            y: row.tile_y,
        },
        facing: row.facing,
        action: row.action,
        move_started_at: Millis(row.move_started_at_ms),
    }
}

pub(crate) fn apply_state(row: &mut Character, next: &CharacterState) {
    row.tile_x = next.pos.x;
    row.tile_y = next.pos.y;
    row.facing = next.facing;
    row.action = next.action;
    row.move_started_at_ms = next.move_started_at.0;
}

// `convert` seam: flatten `game-core::MonsterInstance` -> `Monster` table row.
// Intentionally repetitive — DRY does not cross the marshaling boundary.
pub(crate) fn monster_from_instance(
    owner: Identity,
    inst: &MonsterInstance,
    party_slot: u8,
) -> Monster {
    Monster {
        monster_id: 0, // auto_inc
        owner_identity: owner,
        species_id: inst.species_id,
        nickname: inst.nickname.clone().unwrap_or_default(),
        level: inst.level.as_u8(),
        xp: inst.xp.value(),
        bond: inst.bond.value(),
        iv_hp: inst.ivs.get(StatKind::Hp),
        iv_attack: inst.ivs.get(StatKind::Attack),
        iv_defense: inst.ivs.get(StatKind::Defense),
        iv_speed: inst.ivs.get(StatKind::Speed),
        iv_sp_attack: inst.ivs.get(StatKind::SpAttack),
        iv_sp_defense: inst.ivs.get(StatKind::SpDefense),
        nature_kind: inst.nature.kind(),
        ev_hp: inst.evs.get(StatKind::Hp),
        ev_attack: inst.evs.get(StatKind::Attack),
        ev_defense: inst.evs.get(StatKind::Defense),
        ev_speed: inst.evs.get(StatKind::Speed),
        ev_sp_attack: inst.evs.get(StatKind::SpAttack),
        ev_sp_defense: inst.evs.get(StatKind::SpDefense),
        stat_hp: inst.derived_stats.hp,
        stat_attack: inst.derived_stats.attack,
        stat_defense: inst.derived_stats.defense,
        stat_speed: inst.derived_stats.speed,
        stat_sp_attack: inst.derived_stats.sp_attack,
        stat_sp_defense: inst.derived_stats.sp_defense,
        current_hp: inst.current_hp,
        party_slot,
    }
}

// `convert` seam: flatten `game-core::EncounterTable` -> private `EncounterRow`.
// No `ctx` — pure marshaling. `Level` flattens to `u8` (like `Millis` -> `i64`).
pub(crate) fn encounter_rows_from_table(table: &game_core::EncounterTable) -> EncounterRow {
    EncounterRow {
        zone_id: table.zone_id,
        encounter_rate: table.encounter_rate,
        entries: table
            .entries
            .iter()
            .map(|e| EncounterEntryRow {
                species_id: e.species_id,
                weight: e.weight,
                min_level: e.min_level.as_u8(),
                max_level: e.max_level.as_u8(),
            })
            .collect(),
    }
}

// `convert` seam: inverse of `encounter_rows_from_table` — rebuild the pure
// `game_core::EncounterTable` from the private `EncounterRow` so the grass/manual
// paths can call `resolve_encounter` (the SSOT trigger decision). Pure, no `ctx`.
pub(crate) fn table_from_encounter_row(row: &EncounterRow) -> Result<EncounterTable, String> {
    let mut entries = Vec::with_capacity(row.entries.len());
    for e in &row.entries {
        entries.push(EncounterEntry {
            species_id: e.species_id,
            weight: e.weight,
            min_level: Level::new(e.min_level)?,
            max_level: Level::new(e.max_level)?,
        });
    }
    Ok(EncounterTable {
        zone_id: row.zone_id,
        encounter_rate: row.encounter_rate,
        entries,
    })
}

/// Build a wild `BattleMonster` (no owned `monster` row) from a species, the
/// server-loaded skill ids, a level, and the individuality seed (M8c, ADR-0045).
/// PURE / deterministic in `seed` — no `ctx`. Full-HP, EVs zero; IVs+nature come
/// from `roll_individuality(seed)` and stats from `derive_stats`, so the stored
/// seed rebuilds THIS exact wild in M8d. `known_skill_ids` = the species'
/// `learnable_skill_ids` intersected with `skill_ids`, iterated in learnable order
/// (so `[1,2,3] ∩ [2,3,9] == [2,3]`). An out-of-range `level` is a loud `Err`,
/// never a panic.
pub(crate) fn wild_battle_monster(
    species: &SpeciesRow,
    skill_ids: &[u32],
    level: u8,
    seed: u32,
) -> Result<BattleMonster, String> {
    let lvl = Level::new(level)?;
    let (ivs, nature) = roll_individuality(seed);
    let evs = EVs::zero();
    let base = StatBlock {
        hp: species.base_hp,
        attack: species.base_attack,
        defense: species.base_defense,
        speed: species.base_speed,
        sp_attack: species.base_sp_attack,
        sp_defense: species.base_sp_defense,
    };
    let stats = derive_stats(&base, &ivs, &evs, &nature, lvl);
    let known_skill_ids: Vec<u32> = species
        .learnable_skill_ids
        .iter()
        .copied()
        .filter(|id| skill_ids.contains(id))
        .collect();
    Ok(BattleMonster {
        species_id: species.id,
        affinity: species.affinity,
        level,
        current_hp: stats.hp,
        max_hp: stats.hp,
        stats,
        known_skill_ids,
    })
}

/// Derive the public projection from a private monster row. No hidden fields.
pub(crate) fn pub_from_monster(m: &Monster) -> MonsterPub {
    MonsterPub {
        monster_id: m.monster_id,
        owner_identity: m.owner_identity,
        species_id: m.species_id,
        nickname: m.nickname.clone(),
        level: m.level,
        xp: m.xp,
        bond: m.bond,
        current_hp: m.current_hp,
        stat_hp: m.stat_hp,
        stat_attack: m.stat_attack,
        stat_defense: m.stat_defense,
        stat_speed: m.stat_speed,
        stat_sp_attack: m.stat_sp_attack,
        stat_sp_defense: m.stat_sp_defense,
        party_slot: m.party_slot,
    }
}

// --- Battle helpers (M7b, pure marshaling — no ctx) ---------------------------

/// Marshal a Monster row + its species + its known skills into a BattleMonster.
///
/// Trust boundary (ADR-0049, reject-not-clamp): a row with `stat_defense == 0`
/// is rejected with `Err` rather than passed into the pure core, where it would
/// divide-by-zero in `calc_damage`.
pub(crate) fn battle_monster_from_row(
    monster: &Monster,
    species: &SpeciesRow,
    skills: &[SkillRow],
) -> Result<BattleMonster, String> {
    if monster.stat_defense == 0 {
        return Err(format!(
            "monster {} has stat_defense 0 (illegal: would divide-by-zero in calc_damage)",
            monster.monster_id
        ));
    }
    Ok(BattleMonster {
        species_id: monster.species_id,
        affinity: species.affinity,
        level: monster.level,
        current_hp: monster.current_hp,
        max_hp: monster.stat_hp,
        stats: StatBlock {
            hp: monster.stat_hp,
            attack: monster.stat_attack,
            defense: monster.stat_defense,
            speed: monster.stat_speed,
            sp_attack: monster.stat_sp_attack,
            sp_defense: monster.stat_sp_defense,
        },
        known_skill_ids: skills.iter().map(|s| s.id).collect(),
    })
}

/// Write post-battle HP back from a BattleMonster to the persistent Monster row.
pub(crate) fn write_back_hp(monster: &mut Monster, bm: &BattleMonster) {
    monster.current_hp = bm.current_hp;
}

/// Sum the six base stats of a species (for the XP formula).
///
/// Pure marshaling (ADR-0049): the base-stat-total definition is owned by the
/// rule layer (`game_core::base_stat_total`, SSOT). This shell only builds a
/// `StatBlock` from the species row's six `base_*` columns and delegates.
pub(crate) fn loser_base_stat_total(species: &SpeciesRow) -> u16 {
    let base = game_core::StatBlock {
        hp: species.base_hp,
        attack: species.base_attack,
        defense: species.base_defense,
        speed: species.base_speed,
        sp_attack: species.base_sp_attack,
        sp_defense: species.base_sp_defense,
    };
    game_core::base_stat_total(&base)
}

/// Build a `Vec<SkillDef>` from the DB skill rows for the resolver.
pub(crate) fn skill_defs_from_rows(rows: &[SkillRow]) -> Vec<SkillDef> {
    rows.iter()
        .map(|r| SkillDef {
            id: r.id,
            name: r.name.clone(),
            affinity: r.affinity,
            power: r.power,
            accuracy: r.accuracy,
            pp: r.pp,
        })
        .collect()
}

/// Build the type chart from DB rows.
pub(crate) fn type_chart_from_rows(rows: impl Iterator<Item = TypeRelationRow>) -> TypeChart {
    let rels: Vec<game_core::TypeRelation> = rows
        .map(|r| game_core::TypeRelation {
            attacker: r.attacker,
            defender: r.defender,
            effectiveness: r.effectiveness,
        })
        .collect();
    game_core::TypeChart::new(&rels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PARTY_SLOT_NONE;
    use game_core::{roll_starter, ActionState, Affinity, Direction};

    fn row() -> Character {
        Character {
            entity_id: 1,
            zone_id: 0,
            tile_x: 3,
            tile_y: 4,
            facing: Direction::East,
            action: ActionState::Walking,
            move_started_at_ms: 123,
            sprite_id: 0,
            move_queue: Vec::new(),
        }
    }

    #[test]
    fn convert_seam_round_trips() {
        let r = row();
        let s = char_state(&r);
        assert_eq!(s.pos, TilePos { x: 3, y: 4 });
        assert_eq!(s.facing, Direction::East);
        assert_eq!(s.move_started_at, Millis(123));
        let mut r2 = row();
        let next = CharacterState {
            pos: TilePos { x: 9, y: 9 },
            facing: Direction::North,
            action: ActionState::Idle,
            move_started_at: Millis(500),
        };
        apply_state(&mut r2, &next);
        assert_eq!((r2.tile_x, r2.tile_y), (9, 9));
        assert_eq!(r2.facing, Direction::North);
        assert_eq!(r2.move_started_at_ms, 500);
    }

    // === M6b tests ===

    fn test_species() -> game_core::Species {
        game_core::Species {
            id: 1,
            name: "Flameling".to_string(),
            base_stats: StatBlock {
                hp: 45,
                attack: 49,
                defense: 49,
                speed: 65,
                sp_attack: 65,
                sp_defense: 45,
            },
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![1, 2],
        }
    }

    /// monster_from_instance flattens a MonsterInstance into the correct columns.
    #[test]
    fn monster_from_instance_flattens_correctly() {
        let sp = test_species();
        let inst = roll_starter(42, &sp);
        let identity = Identity::from_byte_array([0u8; 32]);
        let m = monster_from_instance(identity, &inst, 0);

        assert_eq!(m.species_id, inst.species_id);
        assert_eq!(m.level, inst.level.as_u8());
        assert_eq!(m.xp, inst.xp.value());
        assert_eq!(m.bond, inst.bond.value());
        assert_eq!(m.iv_hp, inst.ivs.get(StatKind::Hp));
        assert_eq!(m.iv_attack, inst.ivs.get(StatKind::Attack));
        assert_eq!(m.iv_defense, inst.ivs.get(StatKind::Defense));
        assert_eq!(m.iv_speed, inst.ivs.get(StatKind::Speed));
        assert_eq!(m.iv_sp_attack, inst.ivs.get(StatKind::SpAttack));
        assert_eq!(m.iv_sp_defense, inst.ivs.get(StatKind::SpDefense));
        assert_eq!(m.nature_kind, inst.nature.kind());
        assert_eq!(m.ev_hp, inst.evs.get(StatKind::Hp));
        assert_eq!(m.stat_hp, inst.derived_stats.hp);
        assert_eq!(m.stat_attack, inst.derived_stats.attack);
        assert_eq!(m.current_hp, inst.current_hp);
        assert_eq!(m.party_slot, 0);
        assert_eq!(m.owner_identity, identity);
    }

    /// pub_from_monster produces a projection with NO hidden fields.
    #[test]
    fn pub_from_monster_omits_hidden_fields() {
        let sp = test_species();
        let inst = roll_starter(42, &sp);
        let identity = Identity::from_byte_array([1u8; 32]);
        let m = monster_from_instance(identity, &inst, PARTY_SLOT_NONE);
        let p = pub_from_monster(&m);

        // Public fields match
        assert_eq!(p.monster_id, m.monster_id);
        assert_eq!(p.owner_identity, m.owner_identity);
        assert_eq!(p.species_id, m.species_id);
        assert_eq!(p.nickname, m.nickname);
        assert_eq!(p.level, m.level);
        assert_eq!(p.xp, m.xp);
        assert_eq!(p.bond, m.bond);
        assert_eq!(p.current_hp, m.current_hp);
        assert_eq!(p.stat_hp, m.stat_hp);
        assert_eq!(p.stat_attack, m.stat_attack);
        assert_eq!(p.stat_defense, m.stat_defense);
        assert_eq!(p.stat_speed, m.stat_speed);
        assert_eq!(p.stat_sp_attack, m.stat_sp_attack);
        assert_eq!(p.stat_sp_defense, m.stat_sp_defense);
        assert_eq!(p.party_slot, m.party_slot);
        // The MonsterPub struct has no IV/EV/nature fields — this is a compile-time
        // guarantee; the privacy eval enforces it at the source level.
    }

    // =========================================================================
    // M7b gating tests — server-module helper seams
    //
    // These tests gate the three pure helper functions that the battle reducers
    // will depend on. They are RED until the implementer adds these helpers to
    // server-module/src/lib.rs.
    //
    // The helpers being gated:
    //   1. battle_monster_from_row(monster, skills) -> BattleMonster
    //      Marshaling seam: Monster table row + species skills -> BattleMonster.
    //
    //   2. write_back_hp(monster_row, battle_monster)
    //      Writes HP from the battle-engine state back to the Monster row.
    //
    //   3. loser_base_stat_total(species_row) -> u16
    //      Sums the six base stats from a SpeciesRow for the XP formula.
    //
    // None of these functions touch ReducerContext — they are pure transformers
    // that can be tested without a SpacetimeDB runtime.
    // =========================================================================

    // -------------------------------------------------------------------------
    // Fixture builders for M7b tests
    // -------------------------------------------------------------------------

    fn m7b_test_monster_row() -> Monster {
        Monster {
            monster_id: 42,
            owner_identity: Identity::from_byte_array([7u8; 32]),
            species_id: 1,
            nickname: "Sparky".to_string(),
            level: 15,
            xp: 0,
            bond: 0,
            iv_hp: 20,
            iv_attack: 25,
            iv_defense: 10,
            iv_speed: 30,
            iv_sp_attack: 15,
            iv_sp_defense: 5,
            nature_kind: game_core::NatureKind::Hardy,
            ev_hp: 0,
            ev_attack: 0,
            ev_defense: 0,
            ev_speed: 0,
            ev_sp_attack: 0,
            ev_sp_defense: 0,
            // Derived stats (set explicitly for test predictability)
            stat_hp: 120,
            stat_attack: 55,
            stat_defense: 45,
            stat_speed: 70,
            stat_sp_attack: 50,
            stat_sp_defense: 40,
            current_hp: 90, // damaged — not at max
            party_slot: 0,
        }
    }

    fn m7b_test_skill_rows() -> Vec<SkillRow> {
        vec![
            SkillRow {
                id: 1,
                name: "Ember".to_string(),
                affinity: Affinity::Fire,
                power: 40,
                accuracy: 100,
                pp: 25,
            },
            SkillRow {
                id: 2,
                name: "Scratch".to_string(),
                affinity: Affinity::Fire,
                power: 40,
                accuracy: 100,
                pp: 35,
            },
        ]
    }

    fn m7b_test_species_row() -> SpeciesRow {
        SpeciesRow {
            id: 1,
            name: "Flameling".to_string(),
            base_hp: 45,
            base_attack: 49,
            base_defense: 49,
            base_speed: 65,
            base_sp_attack: 65,
            base_sp_defense: 45,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![1, 2],
        }
    }

    // -------------------------------------------------------------------------
    // TEST M7b-SM-1: battle_monster_from_row marshaling seam
    //
    // Kills: an impl that swaps species_id and affinity, maps the wrong HP
    // column (using stat_hp instead of current_hp or vice-versa), or copies
    // known_skill_ids from learnable_skill_ids without filtering.
    // -------------------------------------------------------------------------

    /// The function `battle_monster_from_row` must exist in the server module
    /// and produce a BattleMonster whose fields correctly reflect the Monster
    /// table row and the provided skill list.
    ///
    /// Kills: maps stat_hp → current_hp (wrong — battle starts with actual HP),
    /// or maps current_hp → max_hp (wrong — max_hp must equal stat_hp).
    #[test]
    fn m7b_battle_monster_from_row_maps_hp_correctly() {
        let monster = m7b_test_monster_row();
        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let bm: game_core::BattleMonster =
            battle_monster_from_row(&monster, &species, &skills).expect("valid row builds");

        // current_hp in battle = Monster.current_hp (the persisted damage state)
        assert_eq!(
            bm.current_hp, monster.current_hp,
            "BattleMonster.current_hp must equal Monster.current_hp (90), not stat_hp (120)"
        );
        // max_hp in battle = Monster.stat_hp (the computed maximum)
        assert_eq!(
            bm.max_hp, monster.stat_hp,
            "BattleMonster.max_hp must equal Monster.stat_hp (120), not current_hp (90)"
        );
    }

    /// Kills: an impl that copies all learnable_skill_ids instead of only
    /// the skill_ids present in the provided skills slice, or that maps the
    /// wrong species_id / affinity / level.
    #[test]
    fn m7b_battle_monster_from_row_maps_identity_fields() {
        let monster = m7b_test_monster_row();
        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let bm: game_core::BattleMonster =
            battle_monster_from_row(&monster, &species, &skills).expect("valid row builds");

        assert_eq!(bm.species_id, monster.species_id, "species_id must match");
        assert_eq!(
            bm.affinity,
            Affinity::Fire,
            "affinity must come from species (Fire)"
        );
        assert_eq!(bm.level, monster.level, "level must match monster.level");
    }

    /// Kills: an impl that uses derived stats from the wrong columns (e.g.
    /// reads iv_attack instead of stat_attack for the StatBlock).
    #[test]
    fn m7b_battle_monster_from_row_maps_derived_stats() {
        let monster = m7b_test_monster_row();
        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let bm: game_core::BattleMonster =
            battle_monster_from_row(&monster, &species, &skills).expect("valid row builds");

        // The StatBlock in BattleMonster must come from the derived stat columns,
        // not from raw IV/EV values or base stats.
        assert_eq!(bm.stats.hp, monster.stat_hp, "stats.hp must be stat_hp");
        assert_eq!(
            bm.stats.attack, monster.stat_attack,
            "stats.attack must be stat_attack"
        );
        assert_eq!(
            bm.stats.defense, monster.stat_defense,
            "stats.defense must be stat_defense"
        );
        assert_eq!(
            bm.stats.speed, monster.stat_speed,
            "stats.speed must be stat_speed"
        );
        assert_eq!(
            bm.stats.sp_attack, monster.stat_sp_attack,
            "stats.sp_attack must be stat_sp_attack"
        );
        assert_eq!(
            bm.stats.sp_defense, monster.stat_sp_defense,
            "stats.sp_defense must be stat_sp_defense"
        );
    }

    /// Kills: an impl that puts all learnable_skill_ids (from the species) into
    /// known_skill_ids instead of only the IDs present in the provided skills slice.
    /// The skill slice represents what the server has loaded for this monster;
    /// known_skill_ids must reflect exactly those IDs.
    #[test]
    fn m7b_battle_monster_from_row_known_skill_ids_match_skills_slice() {
        let monster = m7b_test_monster_row();
        let species = m7b_test_species_row();
        // Only provide skill 1 (not skill 2) — simulates the monster only knowing one move.
        let one_skill = vec![m7b_test_skill_rows().remove(0)];

        let bm: game_core::BattleMonster =
            battle_monster_from_row(&monster, &species, &one_skill).expect("valid row builds");

        assert_eq!(
            bm.known_skill_ids,
            vec![1u32],
            "known_skill_ids must match the provided skills slice (only skill 1)"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M7b-SM-2: write_back_hp writes battle HP to the monster row
    //
    // Kills: an impl that writes max_hp instead of current_hp, writes to the
    // wrong Monster field (e.g. stat_hp), or does not write at all.
    // -------------------------------------------------------------------------

    /// Kills: write_back_hp writes 0 (fainted) back as current_hp.
    #[test]
    fn m7b_write_back_hp_writes_fainted_state() {
        let mut monster = m7b_test_monster_row(); // current_hp = 90
                                                  // Build a BattleMonster representing the fainted state after combat.
        let bm = game_core::BattleMonster {
            species_id: monster.species_id,
            affinity: Affinity::Fire,
            level: monster.level,
            current_hp: 0, // fainted in battle
            max_hp: monster.stat_hp,
            stats: game_core::StatBlock {
                hp: monster.stat_hp,
                attack: monster.stat_attack,
                defense: monster.stat_defense,
                speed: monster.stat_speed,
                sp_attack: monster.stat_sp_attack,
                sp_defense: monster.stat_sp_defense,
            },
            known_skill_ids: vec![1],
        };

        // write_back_hp does not exist yet — this test is RED.
        write_back_hp(&mut monster, &bm);

        assert_eq!(
            monster.current_hp, 0,
            "write_back_hp must set Monster.current_hp = 0 (fainted)"
        );
        // stat_hp must NOT be modified — it is derived, not a battle value.
        assert_eq!(monster.stat_hp, 120, "write_back_hp must not touch stat_hp");
    }

    /// Kills: write_back_hp that caps HP at max_hp (ignoring current_hp).
    #[test]
    fn m7b_write_back_hp_writes_partial_damage() {
        let mut monster = m7b_test_monster_row(); // current_hp = 90 initially
        let partial_hp: u16 = 37;
        let bm = game_core::BattleMonster {
            species_id: monster.species_id,
            affinity: Affinity::Fire,
            level: monster.level,
            current_hp: partial_hp,
            max_hp: monster.stat_hp,
            stats: game_core::StatBlock {
                hp: monster.stat_hp,
                attack: monster.stat_attack,
                defense: monster.stat_defense,
                speed: monster.stat_speed,
                sp_attack: monster.stat_sp_attack,
                sp_defense: monster.stat_sp_defense,
            },
            known_skill_ids: vec![1],
        };

        write_back_hp(&mut monster, &bm);

        assert_eq!(
            monster.current_hp, partial_hp,
            "write_back_hp must write current_hp = {partial_hp}, not cap or round"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M7b-SM-3: loser_base_stat_total sums the six base stats correctly
    //
    // Kills: an impl that sums derived stats (stat_hp etc.) instead of base
    // stats, sums only five stats (off-by-one), or wraps on overflow.
    // -------------------------------------------------------------------------

    /// Kills: an impl that returns the sum of derived stats (monster row's
    /// stat_hp etc.) instead of the six BASE stat columns from the species row.
    /// 45 + 49 + 49 + 65 + 65 + 45 = 318 (Flameling base stat total).
    #[test]
    fn m7b_loser_base_stat_total_flameling() {
        let species = m7b_test_species_row();

        // The explicit `u16` binding pins the signature: a return-type
        // regression (or dropping the game_core::base_stat_total delegation
        // for a wider type) fails to compile here.
        let bst: u16 = loser_base_stat_total(&species);

        assert_eq!(
            bst, 318,
            "loser_base_stat_total must sum the six BASE stats: \
             45+49+49+65+65+45 = 318, got {bst}"
        );
    }

    /// Kills: an impl that only sums five stats (off-by-one on the stat fields).
    #[test]
    fn m7b_loser_base_stat_total_high_bst_species() {
        // A species with high base stats — verifies all six fields are summed.
        let species = SpeciesRow {
            id: 99,
            name: "Apexion".to_string(),
            base_hp: 100,
            base_attack: 120,
            base_defense: 90,
            base_speed: 100,
            base_sp_attack: 130,
            base_sp_defense: 90,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![],
        };
        // 100 + 120 + 90 + 100 + 130 + 90 = 630
        let bst: u16 = loser_base_stat_total(&species);
        assert_eq!(
            bst, 630,
            "loser_base_stat_total must sum all six base stats: \
             100+120+90+100+130+90 = 630, got {bst}"
        );
    }

    /// Kills: an impl that wraps on u16 overflow. All six base stats at 255 = 1530,
    /// which fits in u16 (max 65535). But if the impl uses u8 intermediates, 255*6=1530
    /// wraps to 250. This test catches that.
    #[test]
    fn m7b_loser_base_stat_total_max_stats_no_overflow() {
        let species = SpeciesRow {
            id: 0,
            name: "MaxStat".to_string(),
            base_hp: 255,
            base_attack: 255,
            base_defense: 255,
            base_speed: 255,
            base_sp_attack: 255,
            base_sp_defense: 255,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![],
        };
        // 255 * 6 = 1530, which fits in u16.
        let bst: u16 = loser_base_stat_total(&species);
        assert_eq!(
            bst, 1530,
            "loser_base_stat_total must not overflow u8; 255*6=1530, got {bst}"
        );
    }

    // =========================================================================
    // M8.5b gating tests — battle_monster_from_row trust boundary (defense==0)
    //
    // These tests gate the signature change for `battle_monster_from_row`:
    // it must become `-> Result<BattleMonster, String>` and reject rows
    // where `monster.stat_defense == 0`.
    //
    // All tests in this block are compile-RED until the signature changes.
    // =========================================================================

    // -------------------------------------------------------------------------
    // TEST M8.5b-A-3: battle_monster_from_row rejects zero defense
    //
    // Kills: an impl that passes defense==0 through to BattleMonster (which
    // would later cause a divide-by-zero in calc_damage).
    // -------------------------------------------------------------------------

    /// Kills: an impl that silently returns Ok(..) for a zero-defense row instead
    /// of Err. If battle_monster_from_row doesn't validate stat_defense, a
    /// defense==0 BattleMonster reaches calc_damage and causes UB/panic there.
    ///
    /// PROOF-OF-TEETH: the positive sibling below ensures the implementer can't
    /// trivially make this pass by returning Err for ALL inputs.
    ///
    /// RED state: compile-RED because `battle_monster_from_row` currently returns
    /// `BattleMonster` (not `Result`), so `.is_err()` does not compile.
    #[test]
    fn battle_monster_from_row_rejects_zero_defense() {
        let mut monster = m7b_test_monster_row();
        monster.stat_defense = 0; // precondition violation: defense must be >= 1

        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let result: Result<game_core::BattleMonster, String> =
            battle_monster_from_row(&monster, &species, &skills);

        assert!(
            result.is_err(),
            "TEETH: battle_monster_from_row must reject stat_defense==0 with Err; \
             an impl that passes it through would return Ok(..) and this assertion fails"
        );
    }

    /// Sibling positive test: a normal row (defense > 0) must succeed.
    ///
    /// Kills: a vacuous always-Err impl. Without this test, an implementer could
    /// make the reject test pass by unconditionally returning Err("nope"), which
    /// would break all callers. This test ensures the happy path still works.
    ///
    /// RED state: compile-RED (same signature change required).
    #[test]
    fn battle_monster_from_row_accepts_nonzero_defense() {
        let monster = m7b_test_monster_row(); // stat_defense = 45 (non-zero)
        let species = m7b_test_species_row();
        let skills = m7b_test_skill_rows();

        let result: Result<game_core::BattleMonster, String> =
            battle_monster_from_row(&monster, &species, &skills);

        assert!(
            result.is_ok(),
            "battle_monster_from_row must return Ok(..) for a valid row with \
             stat_defense={} (> 0); got Err",
            monster.stat_defense
        );
        // Spot-check that the result still maps correctly (regression guard)
        let bm = result.unwrap();
        assert_eq!(bm.stats.defense, monster.stat_defense);
    }

    // =========================================================================
    // M8b gating tests — encounter_rows_from_table marshaling seam
    //
    // These tests gate the pure function `encounter_rows_from_table` that the
    // implementer will add to server-module/src/lib.rs. The function does NOT
    // exist yet — this entire block is RED (crate won't compile until added).
    //
    // Mirror: monster_from_instance_flattens_correctly (lib.rs ~1359).
    // Flatten-at-boundary: Level -> u8 (same pattern as Millis -> i64).
    //
    // Symbols referenced (not yet defined — intentionally RED):
    //   encounter_rows_from_table(&game_core::EncounterTable) -> EncounterRow
    //   struct EncounterRow { zone_id: u32, encounter_rate: u16, entries: Vec<EncounterEntryRow> }
    //   struct EncounterEntryRow { species_id: u32, weight: u16, min_level: u8, max_level: u8 }
    // =========================================================================

    // -------------------------------------------------------------------------
    // Fixture builder for M8b marshaling tests
    // -------------------------------------------------------------------------

    fn m8b_test_encounter_table() -> game_core::EncounterTable {
        game_core::EncounterTable {
            zone_id: 42,
            encounter_rate: 350,
            entries: vec![
                game_core::EncounterEntry {
                    species_id: 1,
                    weight: 60,
                    min_level: game_core::Level::new(3).expect("valid level"),
                    max_level: game_core::Level::new(7).expect("valid level"),
                },
                game_core::EncounterEntry {
                    species_id: 2,
                    weight: 30,
                    min_level: game_core::Level::new(5).expect("valid level"),
                    max_level: game_core::Level::new(10).expect("valid level"),
                },
                game_core::EncounterEntry {
                    species_id: 3,
                    weight: 10,
                    min_level: game_core::Level::new(8).expect("valid level"),
                    max_level: game_core::Level::new(15).expect("valid level"),
                },
            ],
        }
    }

    // -------------------------------------------------------------------------
    // TEST M8b-SM-1: encounter_rows_from_table flattens correctly
    //
    // Kills: min/max swap; Level-not-flattened (storing a newtypes struct instead
    // of u8); wrong zone_id or encounter_rate copied; entry count wrong.
    // -------------------------------------------------------------------------

    /// encounter_rows_from_table must flatten a game_core::EncounterTable into
    /// an EncounterRow with the correct zone_id, encounter_rate, entry count,
    /// and correct per-entry species_id/weight/min_level/max_level (as u8).
    ///
    /// Kills: an impl that swaps min_level/max_level columns,
    ///        stores Level newtype instead of u8,
    ///        or copies the wrong zone_id.
    #[test]
    fn encounter_rows_from_table_flattens_correctly() {
        let table = m8b_test_encounter_table();

        // encounter_rows_from_table does not exist yet — this test is RED.
        let row: EncounterRow = encounter_rows_from_table(&table);

        // Top-level fields
        assert_eq!(row.zone_id, 42, "zone_id must be copied from table.zone_id");
        assert_eq!(
            row.encounter_rate, 350,
            "encounter_rate must be copied from table.encounter_rate"
        );
        assert_eq!(
            row.entries.len(),
            3,
            "entries.len() must equal source table entries count (3)"
        );

        // Entry 0: species=1, weight=60, min=3, max=7
        assert_eq!(
            row.entries[0].species_id, 1,
            "entries[0].species_id must be 1"
        );
        assert_eq!(row.entries[0].weight, 60, "entries[0].weight must be 60");
        assert_eq!(
            row.entries[0].min_level, 3,
            "entries[0].min_level must be 3 (Level flattened to u8)"
        );
        assert_eq!(
            row.entries[0].max_level, 7,
            "entries[0].max_level must be 7 (Level flattened to u8)"
        );

        // Entry 1: species=2, weight=30, min=5, max=10
        assert_eq!(
            row.entries[1].species_id, 2,
            "entries[1].species_id must be 2"
        );
        assert_eq!(row.entries[1].weight, 30, "entries[1].weight must be 30");
        assert_eq!(
            row.entries[1].min_level, 5,
            "entries[1].min_level must be 5"
        );
        assert_eq!(
            row.entries[1].max_level, 10,
            "entries[1].max_level must be 10"
        );

        // Entry 2: species=3, weight=10, min=8, max=15
        assert_eq!(
            row.entries[2].species_id, 3,
            "entries[2].species_id must be 3"
        );
        assert_eq!(row.entries[2].weight, 10, "entries[2].weight must be 10");
        assert_eq!(
            row.entries[2].min_level, 8,
            "entries[2].min_level must be 8"
        );
        assert_eq!(
            row.entries[2].max_level, 15,
            "entries[2].max_level must be 15"
        );
    }

    /// ORDER PRESERVATION: entry[i] in the source maps to entries[i] in the row.
    /// Kills: an impl that reverses or re-sorts entries.
    #[test]
    fn encounter_rows_from_table_preserves_entry_order() {
        let table = m8b_test_encounter_table();
        let row: EncounterRow = encounter_rows_from_table(&table);

        // The species_ids in insertion order are [1, 2, 3] — verify the row
        // preserves this order exactly.
        let species_order: Vec<u32> = row.entries.iter().map(|e| e.species_id).collect();
        assert_eq!(
            species_order,
            vec![1u32, 2, 3],
            "entry order must be preserved: [1,2,3] → kills any sorting/reversing impl"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M8b-SM-2: distinct min/max levels are preserved (not swapped, not const)
    //
    // Kills: an impl that writes min into max (or vice-versa), or uses a single
    // constant level for all entries.
    // -------------------------------------------------------------------------

    /// Each entry in the fixture has DISTINCT min and max levels (min != max,
    /// and all three entries have different min/max pairs). This test verifies
    /// that both fields are individually correct, killing a mutant that copies
    /// min into max or uses a constant.
    ///
    /// Kills: min-into-max copy; max-into-min copy; const(1) for all levels.
    #[test]
    fn encounter_rows_from_table_preserves_distinct_levels() {
        let table = m8b_test_encounter_table();
        let row: EncounterRow = encounter_rows_from_table(&table);

        // All three entries have distinct min ≠ max — ensures neither field is
        // aliased to the other.
        for (i, entry) in row.entries.iter().enumerate() {
            assert_ne!(
                entry.min_level, entry.max_level,
                "entries[{i}]: min_level ({}) must differ from max_level ({}) — \
                 kills any impl that copies one field into the other",
                entry.min_level, entry.max_level
            );
        }

        // Verify the actual u8 values of all six level fields are distinct enough
        // to catch a constant-level impl (e.g., always writing 1).
        // min levels: 3, 5, 8 — all different
        let min_levels: Vec<u8> = row.entries.iter().map(|e| e.min_level).collect();
        assert_eq!(
            min_levels,
            vec![3u8, 5, 8],
            "min_levels across entries must be [3,5,8] — kills const-level impl"
        );

        // max levels: 7, 10, 15 — all different
        let max_levels: Vec<u8> = row.entries.iter().map(|e| e.max_level).collect();
        assert_eq!(
            max_levels,
            vec![7u8, 10, 15],
            "max_levels across entries must be [7,10,15] — kills const-level impl"
        );
    }

    // -------------------------------------------------------------------------
    // TEST M8b-SM-3: empty entries → empty row entries, no panic
    //
    // B1 validation prevents empty tables from reaching sync_content_inner, but
    // encounter_rows_from_table must be total (no panic on empty input).
    // -------------------------------------------------------------------------

    /// encounter_rows_from_table with empty entries must produce a row with
    /// entries.is_empty() == true and must not panic.
    ///
    /// Kills: any impl that indexes entries[0] unconditionally.
    #[test]
    fn encounter_rows_from_table_empty_entries() {
        let table = game_core::EncounterTable {
            zone_id: 99,
            encounter_rate: 100,
            entries: vec![],
        };

        // Must not panic — B1 blocks empties before seeding, but the helper
        // must be total regardless.
        let row: EncounterRow = encounter_rows_from_table(&table);

        assert_eq!(row.zone_id, 99, "zone_id preserved for empty-entries table");
        assert_eq!(
            row.encounter_rate, 100,
            "encounter_rate preserved for empty-entries table"
        );
        assert!(
            row.entries.is_empty(),
            "empty source entries → empty row entries (no panic)"
        );
    }

    // =========================================================================
    // --- M8c gating tests ---
    //
    // Gate the PURE wild-monster build helper the implementer will add:
    //   fn wild_battle_monster(species: &SpeciesRow, skill_ids: &[u32],
    //                          level: u8, seed: u32) -> Result<BattleMonster, String>
    // (full-HP, EVs-zero, IVs/nature from game_core::roll_individuality(seed),
    //  derived via game_core::derive_stats, Level::new(level)?).
    //
    // The helper does NOT exist yet → this block is RED (won't compile until it
    // is added). Mirrors the M7b `battle_monster_from_row` tests above.
    //
    // ASSUMPTION (documented per the handoff): the pure signature is
    //   wild_battle_monster(&SpeciesRow, &[u32], u8, u32) -> Result<BattleMonster, String>
    // where `skill_ids` is the set of skill ids the server has loaded; the helper
    // intersects them with the species' learnable_skill_ids for known_skill_ids
    // (same contract as battle_monster_from_row's skill handling). If the
    // implementer picks a slightly different PURE signature it must keep: no ctx,
    // deterministic in seed, full-HP, EVs-zero, Err (not panic) on bad level.
    // =========================================================================

    fn m8c_test_species_row() -> SpeciesRow {
        SpeciesRow {
            id: 7,
            name: "Wildling".to_string(),
            base_hp: 50,
            base_attack: 55,
            base_defense: 45,
            base_speed: 60,
            base_sp_attack: 65,
            base_sp_defense: 50,
            affinity: Affinity::Plant,
            learnable_skill_ids: vec![1, 2, 3],
        }
    }

    /// EARS (R-D / M8d rebuild contract): the wild build is DETERMINISTIC in the
    /// seed — same seed ⇒ byte-identical BattleMonster.
    /// Kills: an impl that draws from a non-seed RNG or ignores the seed when
    /// rolling individuality (so the stored seed could not rebuild the same wild).
    #[test]
    fn wild_battle_monster_is_deterministic_in_seed() {
        let sp = m8c_test_species_row();
        let skill_ids = [1u32, 2, 3];
        let a = wild_battle_monster(&sp, &skill_ids, 12, 0xABCD_1234)
            .expect("valid level builds a wild");
        let b = wild_battle_monster(&sp, &skill_ids, 12, 0xABCD_1234)
            .expect("valid level builds a wild");
        assert_eq!(a, b, "same seed must build an identical BattleMonster");
    }

    /// EARS: a freshly-spawned wild is at FULL HP — current_hp == max_hp == derived
    /// HP, and the level/species come through.
    /// Kills: an impl that starts the wild damaged (current_hp != max_hp), or that
    /// sets max_hp from the wrong stat.
    #[test]
    fn wild_battle_monster_is_full_hp_and_carries_level_species() {
        let sp = m8c_test_species_row();
        let bm = wild_battle_monster(&sp, &[1, 2, 3], 18, 42).expect("valid level builds a wild");
        assert_eq!(
            bm.current_hp, bm.max_hp,
            "a fresh wild must be at full HP (current_hp == max_hp)"
        );
        assert_eq!(
            bm.max_hp, bm.stats.hp,
            "max_hp must equal the derived HP stat"
        );
        assert_eq!(bm.level, 18, "level must be the requested wild level");
        assert_eq!(
            bm.species_id, sp.id,
            "species_id must come from the species"
        );
        assert_eq!(
            bm.affinity, sp.affinity,
            "affinity must come from the species"
        );
    }

    /// EARS: known_skill_ids = the species' learnable filtered by the provided
    /// skill ids (same contract as the owned-monster build).
    /// Kills: an impl that copies ALL provided skill ids (ignoring learnable), or
    /// copies ALL learnable (ignoring the provided set).
    #[test]
    fn wild_battle_monster_known_skills_are_learnable_intersect_provided() {
        let sp = m8c_test_species_row(); // learnable = [1,2,3]
                                         // Provide skill ids 2, 3, and 9 — but 9 is NOT learnable by this species.
        let bm = wild_battle_monster(&sp, &[2, 3, 9], 10, 5).expect("valid level builds a wild");
        assert_eq!(
            bm.known_skill_ids,
            vec![2u32, 3],
            "known_skill_ids must be learnable ∩ provided ([1,2,3] ∩ [2,3,9] = [2,3]); \
             kills copy-all-provided (would include 9) and copy-all-learnable (would include 1)"
        );
    }

    /// EARS (R-D): an out-of-range level is a loud `Err`, NEVER a panic (the wild
    /// build must be total over arbitrary content levels).
    /// Kills: an impl that calls `Level::new(level).unwrap()` (panics on 0 / 250)
    /// instead of propagating the error.
    #[test]
    fn wild_battle_monster_bad_level_is_err_not_panic() {
        let sp = m8c_test_species_row();
        assert!(
            wild_battle_monster(&sp, &[1, 2, 3], 0, 1).is_err(),
            "level 0 must be an Err (Level::new rejects 0), not a panic"
        );
        assert!(
            wild_battle_monster(&sp, &[1, 2, 3], 250, 1).is_err(),
            "level 250 must be an Err (Level::new rejects > 100), not a panic"
        );
        // A boundary valid level must still succeed.
        assert!(
            wild_battle_monster(&sp, &[1, 2, 3], 100, 1).is_ok(),
            "level 100 is valid and must build a wild"
        );
    }

    /// EARS (M8d rebuild contract — the load-bearing one): the wild's derived stats
    /// are EXACTLY what `game_core::roll_individuality(seed)` → `derive_stats(...)`
    /// produces with EVs zero. This is what makes the stored `individuality_seed`
    /// truly rebuild the same wild in M8d.
    /// Kills: an impl that rolls individuality from a different seed transform,
    /// uses non-zero EVs, or derives stats with the wrong inputs — any of which
    /// would make the persisted seed rebuild a DIFFERENT monster than the one fought.
    #[test]
    fn wild_battle_monster_stats_match_roll_individuality_then_derive_stats() {
        let sp = m8c_test_species_row();
        let seed = 0x0BAD_F00D;
        let wild_level = 14u8;
        let bm = wild_battle_monster(&sp, &[1, 2, 3], wild_level, seed)
            .expect("valid level builds a wild");

        // Reconstruct the EXACT expected derived stats from the SSOT pure path.
        let (ivs, nature) = game_core::roll_individuality(seed);
        let base = StatBlock {
            hp: sp.base_hp,
            attack: sp.base_attack,
            defense: sp.base_defense,
            speed: sp.base_speed,
            sp_attack: sp.base_sp_attack,
            sp_defense: sp.base_sp_defense,
        };
        let level = game_core::Level::new(wild_level).expect("valid level");
        let expected =
            game_core::derive_stats(&base, &ivs, &game_core::EVs::zero(), &nature, level);

        assert_eq!(
            bm.stats, expected,
            "wild stats must equal roll_individuality(seed) → derive_stats(.., EVs::zero, ..); \
             this is the M8d 'rebuild THAT exact wild' contract"
        );
        // And max_hp must equal the derived HP stat (full-HP coupling).
        assert_eq!(
            bm.max_hp, expected.hp,
            "max_hp must equal the derived HP stat from the same roll"
        );
    }
}
