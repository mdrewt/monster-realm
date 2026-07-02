//! `content` — server-module domain submodule (M8.9, ADR-0056).
//!
//! The SERVER seed-from-game-core path: `sync_content_inner` re-derives the
//! public content tables (zones, species, skills, type chart, items) and the
//! private `encounter` tables from the `game-core` RON registries when the
//! stored content version is stale (ADR-0054). Independent of workstream B
//! (M8.9e game-core content glob loading).
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::marshal::encounter_rows_from_table;
use crate::schema::{
    config, encounter, fusion, item_row, skill_row, species_row, type_relation_row, zone_def,
    Fusion, ItemRow, SkillRow, SpeciesRow, TypeRelationRow, ZoneDefRow,
};
use crate::CONTENT_VERSION;
use game_core::{
    load_encounters, load_evolutions, load_fusion, load_items, load_skills, load_species,
    load_type_chart, validate_content, validate_encounters, validate_evolution_fusion,
};
use spacetimedb::{ReducerContext, Table};

pub(crate) fn sync_content_inner(ctx: &ReducerContext) {
    // Re-derive only when the stored content version is stale (ADR-0054). A
    // redundant sync_content with a current version is a no-op.
    if let Some(cfg) = ctx.db.config().id().find(0) {
        if cfg.content_version == CONTENT_VERSION {
            return;
        }
    }
    let zones = match game_core::load_zones() {
        Ok(z) => z,
        Err(e) => {
            log::error!("{{\"evt\":\"sync_content_error\",\"reason\":\"{e}\"}}");
            return;
        }
    };
    if let Err(e) = game_core::validate_zones(&zones) {
        log::error!("{{\"evt\":\"sync_content_invalid\",\"reason\":\"{e}\"}}");
        return;
    }
    for z in &zones {
        match ctx.db.zone_def().zone_id().find(z.id) {
            Some(existing) => {
                if existing.name != z.name
                    || existing.width != z.width
                    || existing.height != z.height
                {
                    ctx.db.zone_def().zone_id().update(ZoneDefRow {
                        zone_id: z.id,
                        name: z.name.clone(),
                        width: z.width,
                        height: z.height,
                    });
                }
            }
            None => {
                ctx.db.zone_def().insert(ZoneDefRow {
                    zone_id: z.id,
                    name: z.name.clone(),
                    width: z.width,
                    height: z.height,
                });
            }
        }
    }

    // --- M6b content: species, skills, type chart, items ---
    let species = match load_species() {
        Ok(s) => s,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"species\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    let skills = match load_skills() {
        Ok(s) => s,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"skills\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    let type_chart = match load_type_chart() {
        Ok(t) => t,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"type_chart\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    let items = match load_items() {
        Ok(i) => i,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"items\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    if let Err(e) = validate_content(&species, &skills, &type_chart, &items) {
        log::error!("{{\"evt\":\"sync_content_invalid\",\"reason\":\"{e}\"}}");
        return;
    }

    for sp in &species {
        let row = SpeciesRow {
            id: sp.id,
            name: sp.name.clone(),
            base_hp: sp.base_stats.hp,
            base_attack: sp.base_stats.attack,
            base_defense: sp.base_stats.defense,
            base_speed: sp.base_stats.speed,
            base_sp_attack: sp.base_stats.sp_attack,
            base_sp_defense: sp.base_stats.sp_defense,
            affinity: sp.affinity,
            learnable_skill_ids: sp.learnable_skill_ids.clone(),
        };
        match ctx.db.species_row().id().find(sp.id) {
            Some(_) => {
                ctx.db.species_row().id().update(row);
            }
            None => {
                ctx.db.species_row().insert(row);
            }
        }
    }
    for sk in &skills {
        let row = SkillRow {
            id: sk.id,
            name: sk.name.clone(),
            affinity: sk.affinity,
            power: sk.power,
            accuracy: sk.accuracy,
            pp: sk.pp,
        };
        match ctx.db.skill_row().id().find(sk.id) {
            Some(_) => {
                ctx.db.skill_row().id().update(row);
            }
            None => {
                ctx.db.skill_row().insert(row);
            }
        }
    }
    // Type chart: clear and re-insert (no stable PK; the logical key is the pair).
    for existing in ctx.db.type_relation_row().iter().collect::<Vec<_>>() {
        ctx.db.type_relation_row().id().delete(existing.id);
    }
    for rel in &type_chart {
        ctx.db.type_relation_row().insert(TypeRelationRow {
            id: 0, // auto_inc
            attacker: rel.attacker,
            defender: rel.defender,
            effectiveness: rel.effectiveness,
        });
    }
    for item in &items {
        let row = ItemRow {
            id: item.id,
            name: item.name.clone(),
            description: item.description.clone(),
            recruit_bonus: item.recruit_bonus,
            train_stat: item.train_stat,
            train_amount: item.train_amount,
        };
        match ctx.db.item_row().id().find(item.id) {
            Some(_) => {
                ctx.db.item_row().id().update(row);
            }
            None => {
                ctx.db.item_row().insert(row);
            }
        }
    }

    // --- M8b encounter tables (PRIVATE; ADR-0040 must-never-leak) ---
    // Validate BEFORE any write so a bad registry never wipes/partially seeds.
    let encounters = match load_encounters() {
        Ok(e) => e,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"encounters\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    if let Err(e) = validate_encounters(&encounters, &species, &zones) {
        log::error!("{{\"evt\":\"sync_content_invalid\",\"reason\":\"{e}\"}}");
        return;
    }
    for table in &encounters {
        let row = encounter_rows_from_table(table);
        match ctx.db.encounter().zone_id().find(table.zone_id) {
            Some(_) => {
                ctx.db.encounter().zone_id().update(row);
            }
            None => {
                ctx.db.encounter().insert(row);
            }
        }
    }

    // --- M10b evolution/fusion registries (ADR-0060/0062) ---
    // Load evolutions (used only for cross-validation here; reducers load at call-time)
    let evolutions = match load_evolutions() {
        Ok(e) => e,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"evolutions\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    let fusions = match load_fusion() {
        Ok(f) => f,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"fusion\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    let encounters_for_validate = match load_encounters() {
        Ok(e) => e,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"encounters_recheck\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    let items_for_validate = match load_items() {
        Ok(i) => i,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"registry\":\"items_recheck\",\"reason\":\"{e}\"}}"
            );
            return;
        }
    };
    if let Err(e) = validate_evolution_fusion(
        &species,
        &evolutions,
        &fusions,
        &encounters_for_validate,
        &items_for_validate,
    ) {
        log::error!("{{\"evt\":\"sync_content_invalid\",\"registry\":\"evolution_fusion\",\"reason\":\"{e}\"}}");
        return;
    }
    // Fusion table: clear-and-reinsert (no stable species-pair PK; auto_inc fusion_id).
    for existing in ctx.db.fusion().iter().collect::<Vec<_>>() {
        ctx.db.fusion().fusion_id().delete(existing.fusion_id);
    }
    for r in &fusions {
        let (a_species, b_species) = if r.a <= r.b { (r.a, r.b) } else { (r.b, r.a) };
        ctx.db.fusion().insert(Fusion {
            fusion_id: 0, // auto_inc
            a_species,
            b_species,
            to_species: r.to,
        });
    }

    // Stamp the now-current content version so a later redundant sync_content
    // short-circuits at the top of this function (ADR-0054). A missing config row
    // here is an invariant violation (init always inserts it) — fail loud, don't
    // silently skip, consistent with this function's other error logging.
    match ctx.db.config().id().find(0) {
        Some(mut cfg) => {
            cfg.content_version = CONTENT_VERSION;
            ctx.db.config().id().update(cfg);
        }
        None => {
            log::error!(
                "{{\"evt\":\"sync_content_error\",\"reason\":\"config row missing at stamp\"}}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Content parses and validates end-to-end.
    #[test]
    fn content_parses_and_validates() {
        let species = load_species().expect("species parse");
        let skills = load_skills().expect("skills parse");
        let chart = load_type_chart().expect("type_chart parse");
        let items = load_items().expect("items parse");
        validate_content(&species, &skills, &chart, &items).expect("content valid");
        assert!(
            !species.is_empty(),
            "species registry must have entries for starter"
        );
        assert!(!skills.is_empty(), "skills registry must have entries");
    }

    /// Fusion registry parses and is non-empty (M10b gate).
    /// KILLS: an impl of sync_content_inner that omits the fusion seeding block, or a
    /// fusion.ron that accidentally becomes empty (empty table → fuse always rejects).
    #[test]
    fn fusion_registry_parses_and_is_nonempty_for_seeding() {
        let recipes = game_core::load_fusion().expect("fusion RON must parse");
        assert!(
            !recipes.is_empty(),
            "fusion.ron must contain at least one recipe — an empty registry means fuse() always rejects"
        );
    }
}
