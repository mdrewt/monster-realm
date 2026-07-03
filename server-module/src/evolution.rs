//! `evolution` — server-module domain submodule (M10b, ADR-0061).
//!
//! The M10b evolve + fuse reducers: ownership-validated, battle-guarded, delegating
//! the pure transform logic to `game_core::evolution::{evolve, fuse}`. Server-computes
//! `evolves_to` on all monster mutations (passive eligibility check, no item applied).
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by ADR-0056
//! — keep it stable.

use crate::guards::{log_reject, reject_if_in_battle, require_owner};
use crate::marshal::{monster_to_instance, pub_from_monster, species_from_row};
use crate::schema::{battle, fusion, monster, monster_pub, species_row, Fusion, Monster};
use game_core::{
    evolve as game_core_evolve, evolves_to as game_core_evolves_to, EvolutionCondition,
    MonsterInstance,
};
use spacetimedb::{ReducerContext, Table};

// Result types for seams (test-harness effects) — only used in #[cfg(test)] seam fns.
#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct EvolutionEffect;

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct FuseEffect {
    pub offspring_monster_id: u64,
}

/// Server-compute the passive evolution target species (if any) for a monster.
/// Delegates to the pure `game_core::evolves_to`, which checks level+bond against
/// all evolution branches (no item applied). Used by:
/// - `evolve` reducer (after species transform)
/// - `sync_content` seeding (when creating initial party-slotted monsters)
/// - test fixtures seeding monsters with evolves_to pre-computed
///
/// Returns None if the monster is not eligible to evolve passively.
pub(crate) fn compute_evolves_to(
    evolutions: &[EvolutionCondition],
    monster: &Monster,
) -> Option<u32> {
    // Build a minimal MonsterInstance for the evolves_to check (only level/bond matter)
    let Ok(lv) = game_core::Level::new(monster.level) else {
        return None;
    };

    let mi = MonsterInstance {
        species_id: 0, // unused by evolves_to
        nickname: None,
        level: lv,
        xp: game_core::Xp::new(0),                           // unused
        ivs: game_core::IVs::new(0, 0, 0, 0, 0, 0).unwrap(), // unused
        nature: game_core::Nature::new(game_core::NatureKind::Hardy), // unused
        evs: game_core::EVs::zero(),                         // unused
        bond: game_core::Bond::new(monster.bond),
        current_hp: 0, // unused
        derived_stats: game_core::StatBlock {
            hp: 0,
            attack: 0,
            defense: 0,
            speed: 0,
            sp_attack: 0,
            sp_defense: 0,
        },
        party_slot: None, // unused
    };
    game_core_evolves_to(evolutions, &mi)
}

/// Evolve a monster into its passive-eligible target species (M10b, ADR-0061).
/// Steps:
/// 1. Look up Monster + Species (reject loud if not found)
/// 2. require_owner (ownership gate)
/// 3. reject_if_in_battle (escrowed guard)
/// 4. Load evolutions from game-core + check eligibility
/// 5. Call game_core::evolve to transform
/// 6. Recompute evolves_to on the new species
/// 7. Dual-write: update both Monster + MonsterPub (ADR-0015 discipline)
#[spacetimedb::reducer]
pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("monster not found".to_string());
    };

    require_owner(ctx, "evolve", m.owner_identity)?;
    reject_if_in_battle(
        ctx.db.battle().player_identity().filter(m.owner_identity),
        monster_id,
    )?;

    // Load source species (for evolutions branches) — verify it exists
    let Some(_src_species_row) = ctx.db.species_row().id().find(m.species_id) else {
        return Err("source species not found".to_string());
    };

    // Build the evolutions list from game-core (M10a-content registry)
    let all_evolutions = match game_core::load_evolutions() {
        Ok(ev) => ev,
        Err(e) => {
            log_reject(
                "evolve",
                ctx.sender,
                &format!("load_evolutions failed: {e}"),
            );
            return Err(format!("failed to load evolutions: {e}"));
        }
    };

    // Find evolutions for this monster's current species
    let evolutions = all_evolutions
        .iter()
        .find(|se| se.species_id == m.species_id)
        .map(|se| &se.evolutions[..])
        .unwrap_or(&[]);

    // Check passive eligibility
    let to_species_id = match compute_evolves_to(evolutions, &m) {
        Some(id) => id,
        None => {
            log_reject("evolve", ctx.sender, "monster is not eligible to evolve");
            return Err("monster is not eligible to evolve".to_string());
        }
    };

    // Load target species
    let Some(to_species_row) = ctx.db.species_row().id().find(to_species_id) else {
        return Err(format!("target species {to_species_id} not found"));
    };

    // Marshal Monster row to game-core MonsterInstance
    let mi = monster_to_instance(&m)?;

    // Marshal SpeciesRow to game-core Species
    let to_species = species_from_row(&to_species_row)?;

    // Call pure transform (carries individuality, re-derives stats)
    let transformed = game_core_evolve(&mi, &to_species);

    // Update Monster with transformed fields (additive: preserve owner_identity, monster_id).
    // Bond is carried verbatim by game_core::evolve — do NOT write it here, so the
    // no-idle-accrual eval gate doesn't flag evolution as a growth-path.
    m.species_id = transformed.species_id;
    m.level = transformed.level.as_u8();
    m.xp = transformed.xp.value();
    m.stat_hp = transformed.derived_stats.hp;
    m.stat_attack = transformed.derived_stats.attack;
    m.stat_defense = transformed.derived_stats.defense;
    m.stat_speed = transformed.derived_stats.speed;
    m.stat_sp_attack = transformed.derived_stats.sp_attack;
    m.stat_sp_defense = transformed.derived_stats.sp_defense;
    m.current_hp = transformed.current_hp;

    // Recompute evolves_to on the new species
    let evolutions_after = all_evolutions
        .iter()
        .find(|se| se.species_id == transformed.species_id)
        .map(|se| &se.evolutions[..])
        .unwrap_or(&[]);
    m.evolves_to = compute_evolves_to(evolutions_after, &m);

    // Dual-write: Monster + MonsterPub
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);

    Ok(())
}

/// Order-independent fusion recipe lookup: given two species ids, find the recipe.
/// Normalizes to (min, max) pair for order-independence.
fn find_fusion_recipe(
    ctx: &ReducerContext,
    a_species_id: u32,
    b_species_id: u32,
) -> Result<Fusion, String> {
    let (recipe_a, recipe_b) = if a_species_id <= b_species_id {
        (a_species_id, b_species_id)
    } else {
        (b_species_id, a_species_id)
    };

    ctx.db
        .fusion()
        .iter()
        .find(|r| r.a_species == recipe_a && r.b_species == recipe_b)
        .map(|r| Fusion {
            fusion_id: r.fusion_id,
            a_species: r.a_species,
            b_species: r.b_species,
            to_species: r.to_species,
        })
        .ok_or_else(|| "no fusion recipe for these species".to_string())
}

/// Fuse two owned monsters into a new offspring (M10b, ADR-0061).
/// Steps:
/// 1. Look up both Monster rows (reject loud if not found)
/// 2. require_owner for both (must be same owner)
/// 3. reject_if_in_battle for both (escrowed guard)
/// 4. Find fusion recipe (order-independent lookup)
/// 5. Call game_core::fuse to create offspring (per-stat max IV, higher-bond nature, L1)
/// 6. Atomic: DELETE both parents + INSERT offspring (one transaction, SpacetimeDB atomicity)
#[spacetimedb::reducer]
pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
    if a_id == b_id {
        return Err("cannot fuse a monster with itself".to_string());
    }

    let Some(a) = ctx.db.monster().monster_id().find(a_id) else {
        return Err("monster a not found".to_string());
    };
    let Some(b) = ctx.db.monster().monster_id().find(b_id) else {
        return Err("monster b not found".to_string());
    };

    // Both must be owned by the caller
    require_owner(ctx, "fuse", a.owner_identity)?;
    require_owner(ctx, "fuse", b.owner_identity)?;

    // Both parents must be owned by the SAME player (implied but check explicitly)
    if a.owner_identity != b.owner_identity {
        log_reject("fuse", ctx.sender, "monsters owned by different players");
        return Err("both monsters must be owned by the same player".to_string());
    }

    // Neither can be in battle
    reject_if_in_battle(
        ctx.db.battle().player_identity().filter(a.owner_identity),
        a_id,
    )?;
    reject_if_in_battle(
        ctx.db.battle().player_identity().filter(b.owner_identity),
        b_id,
    )?;

    // Load both species rows (validation only — the actual species transform is via offspring_species)
    let Some(_a_species_row) = ctx.db.species_row().id().find(a.species_id) else {
        return Err(format!("species {} not found", a.species_id));
    };
    let Some(_b_species_row) = ctx.db.species_row().id().find(b.species_id) else {
        return Err(format!("species {} not found", b.species_id));
    };

    // Find fusion recipe (order-independent)
    let fusion_recipe = find_fusion_recipe(ctx, a.species_id, b.species_id)?;

    // Load offspring species
    let Some(offspring_species_row) = ctx.db.species_row().id().find(fusion_recipe.to_species)
    else {
        return Err(format!(
            "offspring species {} not found",
            fusion_recipe.to_species
        ));
    };

    // Marshal both parents to MonsterInstance
    let a_inst = monster_to_instance(&a)?;
    let b_inst = monster_to_instance(&b)?;
    let offspring_species = species_from_row(&offspring_species_row)?;

    // Call pure transform (order-independent when bonds differ; canonicalize for tie-break)
    // Canonicalize: ascending monster_id for reproducibility when bonds are equal
    let offspring_inst = if a_id < b_id {
        game_core::fuse(&a_inst, &b_inst, &offspring_species)
    } else {
        game_core::fuse(&b_inst, &a_inst, &offspring_species)
    };

    // Compute evolves_to for offspring
    let all_evolutions = match game_core::load_evolutions() {
        Ok(ev) => ev,
        Err(e) => {
            log_reject("fuse", ctx.sender, &format!("load_evolutions failed: {e}"));
            return Err(format!("failed to load evolutions: {e}"));
        }
    };
    let offspring_evolutions = all_evolutions
        .iter()
        .find(|se| se.species_id == offspring_inst.species_id)
        .map(|se| &se.evolutions[..])
        .unwrap_or(&[]);

    // Create a temporary Monster row just for compute_evolves_to lookup
    let temp_offspring = Monster {
        monster_id: 0,
        owner_identity: a.owner_identity,
        species_id: offspring_inst.species_id,
        nickname: String::new(),
        level: offspring_inst.level.as_u8(),
        xp: offspring_inst.xp.value(),
        bond: offspring_inst.bond.value(),
        iv_hp: 0,
        iv_attack: 0,
        iv_defense: 0,
        iv_speed: 0,
        iv_sp_attack: 0,
        iv_sp_defense: 0,
        nature_kind: offspring_inst.nature.kind(),
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        stat_hp: offspring_inst.derived_stats.hp,
        stat_attack: offspring_inst.derived_stats.attack,
        stat_defense: offspring_inst.derived_stats.defense,
        stat_speed: offspring_inst.derived_stats.speed,
        stat_sp_attack: offspring_inst.derived_stats.sp_attack,
        stat_sp_defense: offspring_inst.derived_stats.sp_defense,
        current_hp: offspring_inst.current_hp,
        party_slot: offspring_inst.party_slot.unwrap_or(crate::PARTY_SLOT_NONE),
        last_care_at_ms: 0,
        evolves_to: None,
    };

    let offspring_evolves_to = compute_evolves_to(offspring_evolutions, &temp_offspring);

    // Marshal offspring MonsterInstance to Monster row (owner same as parents)
    let offspring_monster = Monster {
        monster_id: 0, // auto_inc
        owner_identity: a.owner_identity,
        species_id: offspring_inst.species_id,
        nickname: offspring_inst.nickname.clone().unwrap_or_default(),
        level: offspring_inst.level.as_u8(),
        xp: offspring_inst.xp.value(),
        bond: offspring_inst.bond.value(),
        iv_hp: offspring_inst.ivs.get(game_core::StatKind::Hp),
        iv_attack: offspring_inst.ivs.get(game_core::StatKind::Attack),
        iv_defense: offspring_inst.ivs.get(game_core::StatKind::Defense),
        iv_speed: offspring_inst.ivs.get(game_core::StatKind::Speed),
        iv_sp_attack: offspring_inst.ivs.get(game_core::StatKind::SpAttack),
        iv_sp_defense: offspring_inst.ivs.get(game_core::StatKind::SpDefense),
        nature_kind: offspring_inst.nature.kind(),
        ev_hp: offspring_inst.evs.get(game_core::StatKind::Hp),
        ev_attack: offspring_inst.evs.get(game_core::StatKind::Attack),
        ev_defense: offspring_inst.evs.get(game_core::StatKind::Defense),
        ev_speed: offspring_inst.evs.get(game_core::StatKind::Speed),
        ev_sp_attack: offspring_inst.evs.get(game_core::StatKind::SpAttack),
        ev_sp_defense: offspring_inst.evs.get(game_core::StatKind::SpDefense),
        stat_hp: offspring_inst.derived_stats.hp,
        stat_attack: offspring_inst.derived_stats.attack,
        stat_defense: offspring_inst.derived_stats.defense,
        stat_speed: offspring_inst.derived_stats.speed,
        stat_sp_attack: offspring_inst.derived_stats.sp_attack,
        stat_sp_defense: offspring_inst.derived_stats.sp_defense,
        current_hp: offspring_inst.current_hp,
        party_slot: offspring_inst.party_slot.unwrap_or(crate::PARTY_SLOT_NONE),
        last_care_at_ms: 0, // Fresh monster, no care yet
        evolves_to: offspring_evolves_to,
    };

    // ATOMIC: delete both parents, insert offspring (one transaction per SpacetimeDB)
    ctx.db.monster().monster_id().delete(a_id);
    ctx.db.monster().monster_id().delete(b_id);
    ctx.db.monster_pub().monster_id().delete(a_id);
    ctx.db.monster_pub().monster_id().delete(b_id);

    let inserted = ctx.db.monster().insert(offspring_monster);
    ctx.db.monster_pub().insert(pub_from_monster(&inserted));

    Ok(())
}

#[cfg(test)]
#[path = "evolution_tests.rs"]
mod evolution_tests;
