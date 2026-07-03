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

use crate::evolution::compute_evolves_to;
use crate::marshal::{encounter_rows_from_table, pub_from_monster};
use crate::schema::{
    character, config, encounter, fusion, heal_location_row, item_row, monster, monster_pub, npc,
    skill_row, species_row, type_relation_row, zone_def, Character, Fusion, HealLocationRow,
    ItemRow, Monster, Npc, SkillRow, SpeciesRow, TypeRelationRow, ZoneDefRow,
};
use crate::CONTENT_VERSION;
use game_core::{
    derive_stats, load_dialogue_trees, load_encounters, load_evolutions, load_fusion,
    load_heal_locations, load_items, load_npc_defs, load_quest_defs, load_skills, load_species,
    load_type_chart, load_zone_maps, validate_content, validate_encounters,
    validate_evolution_fusion, validate_npc_content, validate_zone_maps, ActionState, Direction,
    EVs, EvolutionCondition, IVs, Level, Nature, StatBlock,
};
// Species and SpeciesEvolutions are only used by the test-only recheck seam.
#[cfg(test)]
use game_core::{Species, SpeciesEvolutions};
use spacetimedb::{ReducerContext, Table};

pub(crate) fn sync_content_inner(ctx: &ReducerContext) -> Result<(), String> {
    // Version gate (M1/ADR-0054): skip re-seed when content is already current.
    if let Some(cfg) = ctx.db.config().id().find(0) {
        if cfg.content_version == CONTENT_VERSION {
            return Ok(());
        }
    }

    // ====== LOAD PHASE ======
    let zones = game_core::load_zones().map_err(|e| format!("zones: {e}"))?;
    let zone_maps = load_zone_maps().map_err(|e| format!("zone_maps: {e}"))?;
    let species = load_species().map_err(|e| format!("species: {e}"))?;
    let skills = load_skills().map_err(|e| format!("skills: {e}"))?;
    let type_chart = load_type_chart().map_err(|e| format!("type_chart: {e}"))?;
    let items = load_items().map_err(|e| format!("items: {e}"))?;
    let encounters = load_encounters().map_err(|e| format!("encounters: {e}"))?;
    let evolutions = load_evolutions().map_err(|e| format!("evolutions: {e}"))?;
    let fusions = load_fusion().map_err(|e| format!("fusions: {e}"))?;
    let npc_defs = load_npc_defs().map_err(|e| format!("npcs: {e}"))?;
    let dialogue_trees = load_dialogue_trees().map_err(|e| format!("dialogue_trees: {e}"))?;
    let quest_defs = load_quest_defs().map_err(|e| format!("quests: {e}"))?;
    let heal_defs = load_heal_locations().map_err(|e| format!("heal_locations: {e}"))?;

    // ====== VALIDATE PHASE (all-before-any-write, ADR-0073 §12.5b-2) ======
    game_core::validate_zones(&zones).map_err(|e| format!("zones invalid: {e}"))?;
    // M2: validate_zone_maps BEFORE zone_def writes (M11b, ADR-0066)
    validate_zone_maps(&zone_maps, &zones).map_err(|e| format!("zone_maps invalid: {e}"))?;
    validate_content(&species, &skills, &type_chart, &items)
        .map_err(|e| format!("content invalid: {e}"))?;
    validate_encounters(&encounters, &species, &zones)
        .map_err(|e| format!("encounters invalid: {e}"))?;
    validate_evolution_fusion(&species, &evolutions, &fusions, &encounters, &items)
        .map_err(|e| format!("evolution_fusion invalid: {e}"))?;
    validate_npc_content(
        &npc_defs,
        &dialogue_trees,
        &quest_defs,
        &zones,
        &items,
        &heal_defs,
    )
    .map_err(|e| format!("npc_content invalid: {e}"))?;

    // ====== WRITE PHASE ======
    // zone_def upserts (M2: after validate_zone_maps; M3: find+update not delete+insert)
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
    seed_npc_entities_from(ctx, &npc_defs);
    seed_heal_locations_from(ctx, &heal_defs);

    // ====== RE-DERIVE PASS (12.5b-3): update all monster rows for new content ======
    // Log-and-continue per-row: a corrupt row should not abort sync for everyone.
    for mut m in ctx.db.monster().iter().collect::<Vec<_>>() {
        let Some(species_row) = ctx.db.species_row().id().find(m.species_id) else {
            log::error!(
                "{{\"evt\":\"sync_content_rederive_skip\",\"monster_id\":{},\"reason\":\"species {} not found\"}}",
                m.monster_id, m.species_id
            );
            continue;
        };
        let monster_evolutions = evolutions
            .iter()
            .find(|se| se.species_id == m.species_id)
            .map(|se| &se.evolutions[..])
            .unwrap_or(&[]);
        recompute_monster_derived_fields(&mut m, &species_row, monster_evolutions);
        let pub_row = pub_from_monster(&m);
        ctx.db.monster().monster_id().update(m);
        ctx.db.monster_pub().monster_id().update(pub_row);
    }

    // ====== VERSION STAMP ======
    match ctx.db.config().id().find(0) {
        Some(mut cfg) => {
            cfg.content_version = CONTENT_VERSION;
            ctx.db.config().id().update(cfg);
        }
        None => {
            return Err("sync_content_inner: config row missing at stamp".to_string());
        }
    }

    Ok(())
}

/// Pure validation seam (12.5b-2, ADR-0073): verify species + evolutions are
/// minimally valid before any DB write. Called from sync_content_inner (which
/// does the real full validation) and unit-testable without a DB context.
/// Checks: species non-empty; every evolution entry references a known species_id.
/// Full graph-level validation (cycles, fusion coherence) is done by
/// `validate_evolution_fusion` in sync_content_inner's validate phase.
/// Test-only: this function has no production call site. The `#[cfg(test)]` gate
/// ensures it does not cause a dead_code lint error in `just lint` (clippy -D warnings).
#[cfg(test)]
pub(crate) fn sync_content_inner_recheck(
    species: &[Species],
    evolutions: &[SpeciesEvolutions],
) -> Result<(), String> {
    if species.is_empty() {
        return Err(
            "species registry must not be empty (would wipe all species on seed)".to_string(),
        );
    }
    let species_ids: std::collections::HashSet<u32> = species.iter().map(|s| s.id).collect();
    for ev in evolutions {
        if !species_ids.contains(&ev.species_id) {
            return Err(format!(
                "evolution entry references unknown species_id {}",
                ev.species_id
            ));
        }
    }
    Ok(())
}

/// Pure re-derive seam (12.5b-3, ADR-0073): update a Monster row in-place with
/// stats derived from `species` (new base stats) and recomputed `evolves_to`.
/// Clamps `current_hp` to the new `stat_hp` (no-idle-accrual, ADR-0058).
/// Returns without mutating on invalid IV/EV/level values (data integrity guard).
pub(crate) fn recompute_monster_derived_fields(
    monster: &mut Monster,
    species: &SpeciesRow,
    evolutions: &[EvolutionCondition],
) {
    let base = StatBlock {
        hp: species.base_hp,
        attack: species.base_attack,
        defense: species.base_defense,
        speed: species.base_speed,
        sp_attack: species.base_sp_attack,
        sp_defense: species.base_sp_defense,
    };
    if let (Ok(ivs), Ok(evs), Ok(lvl)) = (
        IVs::new(
            monster.iv_hp,
            monster.iv_attack,
            monster.iv_defense,
            monster.iv_speed,
            monster.iv_sp_attack,
            monster.iv_sp_defense,
        ),
        EVs::new(
            monster.ev_hp,
            monster.ev_attack,
            monster.ev_defense,
            monster.ev_speed,
            monster.ev_sp_attack,
            monster.ev_sp_defense,
        ),
        Level::new(monster.level),
    ) {
        let nature = Nature::new(monster.nature_kind);
        let derived = derive_stats(&base, &ivs, &evs, &nature, lvl);
        monster.stat_hp = derived.hp;
        monster.stat_attack = derived.attack;
        monster.stat_defense = derived.defense;
        monster.stat_speed = derived.speed;
        monster.stat_sp_attack = derived.sp_attack;
        monster.stat_sp_defense = derived.sp_defense;
        // Clamp current_hp — sync_content is not a heal (no-idle-accrual, ADR-0058).
        monster.current_hp = monster.current_hp.min(derived.hp);
        // Recompute evolves_to with the new content.
        monster.evolves_to = compute_evolves_to(evolutions, monster);
    }
}

fn seed_npc_entities_from(ctx: &ReducerContext, npc_defs: &[game_core::NpcDef]) {
    for def in npc_defs {
        // Idempotent: O(1) lookup via #[unique] npc_id index
        if ctx.db.npc().npc_id().find(def.npc_id.clone()).is_some() {
            continue;
        }
        let ch = ctx.db.character().insert(Character {
            entity_id: 0,
            zone_id: def.zone_id,
            tile_x: def.spawn_x,
            tile_y: def.spawn_y,
            facing: Direction::South,
            action: ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: def.sprite_id,
            move_queue: vec![],
        });
        ctx.db.npc().insert(Npc {
            entity_id: ch.entity_id,
            npc_id: def.npc_id.clone(),
            zone_id: def.zone_id,
            home_x: def.home_x,
            home_y: def.home_y,
            wander_radius: def.wander_radius,
            dialogue_tree_id: def.dialogue_tree_id.clone(),
        });
    }
}

fn seed_heal_locations_from(ctx: &ReducerContext, defs: &[game_core::HealLocationDef]) {
    for def in defs {
        // Content integrity (F4): cost_item_id without cost_qty is a config error
        if def.cost_item_id.is_some() && def.cost_qty == 0 {
            log::error!(
                "{{\"evt\":\"seed_heal_error\",\"location_id\":{},\"reason\":\"cost_item_id set but cost_qty is 0\"}}",
                def.location_id
            );
            continue;
        }
        let row = HealLocationRow {
            location_id: def.location_id,
            zone_id: def.zone_id,
            tile_x: def.tile_x,
            tile_y: def.tile_y,
            cost_item_id: def.cost_item_id,
            cost_qty: def.cost_qty,
            cooldown_ms: def.cooldown_ms,
        };
        match ctx
            .db
            .heal_location_row()
            .location_id()
            .find(def.location_id)
        {
            Some(_) => {
                ctx.db.heal_location_row().location_id().update(row);
            }
            None => {
                ctx.db.heal_location_row().insert(row);
            }
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

    // =========================================================================
    // M12.5b structural tests (source-guard pattern; see battle_tests.rs for
    // the established strip_rust_comments/extract_fn_body helpers).
    // =========================================================================

    const LIB_RS_SOURCE: &str = include_str!("lib.rs");
    const CONTENT_RS_SOURCE: &str = include_str!("content.rs");

    /// Strip Rust block comments and line comments from `src` (mirrors the helper
    /// in battle_tests.rs; duplicated here so content_tests need not cross-crate).
    fn strip_rust_comments(src: &str) -> String {
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
        String::from_utf8(out).expect("stripped source must be valid UTF-8")
    }

    // =========================================================================
    // 12.5b-1: sync_content guard must use owner_identity (NOT ctx.identity())
    //
    // Criterion: the `sync_content` guard must check `ctx.sender` against a stored
    // `owner_identity` in `Config`, NOT against `ctx.identity()` (module identity).
    //
    // RED state: lib.rs currently contains `ctx.sender != ctx.identity()` and does NOT
    // reference `owner_identity` in the guard. Both assertions below will fail today:
    //   - negative: the forbidden pattern IS present → assertion fires
    //   - positive: `owner_identity` is NOT in the guard body → assertion fires
    //
    // This test starts RED because the current guard in lib.rs reads:
    //   if ctx.sender != ctx.identity() {
    //       return Err("sync_content is module-only".to_string());
    //   }
    // The fix requires replacing that with an owner_identity lookup in Config.
    // =========================================================================

    /// 12.5b-1: sync_content must NOT gate on `ctx.identity()` (module identity).
    /// KILLS: the current guard `ctx.sender != ctx.identity()` which blocks any DB
    /// owner from calling sync_content (only the module itself can call ctx.identity()).
    /// The correct guard checks a stored `owner_identity` in the Config row.
    #[test]
    fn sync_content_guard_does_not_use_ctx_identity() {
        let stripped = strip_rust_comments(LIB_RS_SOURCE);

        // Assemble the forbidden pattern from parts so the literal does not appear
        // verbatim in this test source (which is inside the include_str! captured file).
        let _forbidden_a = ["ctx", ".identity()"].concat();
        let forbidden_b = ["ctx.sender", " != ctx.identity()"].concat();

        // Locate the sync_content function body to scope the check.
        // We search the full stripped source for the guard because extract_fn_body is
        // not available here; the guard is close to the reducer attribute, so
        // searching the whole stripped lib.rs is adequate for this structural check.
        assert!(
            !stripped.contains(forbidden_b.as_str()),
            "TEETH(12.5b-1): lib.rs `sync_content` must NOT guard with `ctx.sender != ctx.identity()`; \
             that pattern blocks any DB owner from calling sync_content (only the module itself can \
             produce ctx.identity()). Replace the guard with an owner_identity lookup in Config. \
             The forbidden fragment `{}` was found in lib.rs.",
            forbidden_b
        );
    }

    /// 12.5b-1 positive: the `sync_content` reducer body must reference `owner_identity`
    /// (scoped to the function body only, not the full file).
    ///
    /// KILLS: a guard that was removed entirely (no access check) or replaced with a
    /// constant-true/false — either leaves sync_content callable by anyone, or
    /// permanently broken.
    ///
    /// Scoping to the function body (not full file) prevents a false-green where
    /// `owner_identity` already appears in `on_disconnect` and unrelated reducers.
    #[test]
    fn sync_content_guard_references_owner_identity() {
        let stripped = strip_rust_comments(LIB_RS_SOURCE);

        // Extract the sync_content body by finding the function declaration and walking
        // to the matching closing brace. Built from parts to avoid self-match.
        let fn_needle = ["pub fn sync_content", "(ctx:"].concat();
        let fn_pos = stripped
            .find(fn_needle.as_str())
            .expect("sync_content reducer must be declared in lib.rs");

        // Walk forward from fn_pos to find the opening brace.
        let after = &stripped[fn_pos..];
        let brace_offset = after.find('{').expect("sync_content must have a body");
        let body_start = fn_pos + brace_offset + 1;

        // Count braces to find the matching closing brace.
        let mut depth: usize = 1;
        let chars: Vec<char> = stripped[body_start..].chars().collect();
        let mut char_i = 0;
        let mut byte_off = 0usize;
        while char_i < chars.len() && depth > 0 {
            match chars[char_i] {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            byte_off += chars[char_i].len_utf8();
            char_i += 1;
        }
        let body = &stripped[body_start..body_start + byte_off];

        // `owner_identity` must appear inside the sync_content body (not just anywhere
        // in the file). Assembled from parts to prevent self-match in this test text.
        let guard_field = ["owner", "_identity"].concat();

        assert!(
            body.contains(guard_field.as_str()),
            "TEETH(12.5b-1): the `sync_content` reducer body must reference `owner_identity` \
             to gate the call; the correct implementation reads Config.owner_identity and \
             compares it to ctx.sender. Currently the body contains only the `ctx.identity()` \
             pattern (wrong) and does not reference owner_identity at all. \
             Add `Config.owner_identity` field and guard with: \
             `if cfg.owner_identity != ctx.sender {{ return Err(...); }}`"
        );
    }

    // =========================================================================
    // 12.5b-2: sync_content_inner must return Result<(), String>
    //
    // Criterion: `sync_content_inner` must return `Result<(), String>` so that a
    // validation failure at ANY registry point can bubble up and leave the DB
    // entirely unchanged (txn atomic).
    //
    // RED state: current signature is `pub(crate) fn sync_content_inner(ctx: &ReducerContext)`
    // (returns unit). The structural test below fails because the current source
    // does NOT contain the required `Result<(), String>` return type annotation.
    // =========================================================================

    /// 12.5b-2: sync_content_inner must declare `-> Result<(), String>` in its signature.
    /// KILLS: the current unit-return signature — without Result the function cannot
    /// propagate validation errors to the caller, making atomic load-all-then-write-all
    /// impossible to implement correctly.
    #[test]
    fn sync_content_inner_returns_result() {
        let stripped = strip_rust_comments(CONTENT_RS_SOURCE);

        // Look for the function signature with Result return type.
        // The canonical form: `fn sync_content_inner(ctx: &ReducerContext) -> Result<(), String>`
        // We check for the Result annotation in the vicinity of the function declaration.
        // Assemble from parts to avoid the literal appearing in this test body.
        let fn_name = ["sync_content_inner", "(ctx"].concat();
        let result_type = ["Result", "<(), String>"].concat();

        let fn_pos = stripped
            .find(fn_name.as_str())
            .expect("sync_content_inner function must be declared in content.rs");
        // Extract a window after the function name to check the return type annotation.
        // The signature can span ~200 chars; check a generous window.
        let window = &stripped[fn_pos..std::cmp::min(fn_pos + 300, stripped.len())];

        assert!(
            window.contains(result_type.as_str()),
            "TEETH(12.5b-2): `sync_content_inner` must return `Result<(), String>` so that \
             validation errors propagate atomically to the caller; \
             current signature returns unit `()`. Add `-> Result<(), String>` and replace \
             early-return bare-return stubs with `return Err(...)`. \
             Searched in: {:?}",
            &window[..std::cmp::min(200, window.len())]
        );
    }

    /// 12.5b-2: sync_content_inner must use `?` or explicit `Err` propagation, not
    /// silent `return;` on validation failure.
    /// KILLS: an impl that keeps the `return;` pattern — a bare return swallows the
    /// error and continues with incomplete data, violating the load-all-before-write-all
    /// contract.
    #[test]
    fn sync_content_inner_no_bare_returns_on_error() {
        let stripped = strip_rust_comments(CONTENT_RS_SOURCE);

        // In the current (unfixed) implementation, all error paths use `return;`
        // (bare unit return). After the fix, error paths must use `return Err(...)`.
        // We count bare `return;` occurrences inside the function body.
        // A simple proxy: if the source has `return;` (semicolon, no value), those
        // are the unfixed paths. After the fix all early returns carry an Err value.
        //
        // NOTE: a bare `return;` in a Result-returning function is a compile error
        // (type mismatch: () vs Result<(), String>). So once the signature is fixed
        // and bare `return;` remains, the file does NOT compile → tests stay RED.
        // This structural test is a belt-and-suspenders assertion documenting the
        // contract so the criterion is explicit even before compilation.
        let bare_ret = ["return", ";"].concat();
        // Only check production code — test helpers (e.g. early-exit on Option::None)
        // legitimately use bare unit-returns inside #[test] functions. The marker
        // "mod tests {" delimits production code from the test module in this file.
        let tests_start = stripped.find("mod tests {").unwrap_or(stripped.len());
        let production_code = &stripped[..tests_start];
        let count = production_code.matches(bare_ret.as_str()).count();

        assert_eq!(
            count, 0,
            "TEETH(12.5b-2): content.rs production code must have zero bare unit-returns              after the sync_content_inner signature change to Result<(), String>;              found {} occurrence(s). Replace each bare unit-return with an Err variant              and propagate with `?`.",
            count
        );
    }

    // =========================================================================
    // test-seam-only functions must not leak into production builds as dead code.
    //
    // Invariant: any function in content.rs that is ONLY called from #[cfg(test)]
    // code must itself carry a `#[cfg(test)]` attribute (or be called from production
    // code). Without this attribute, `cargo clippy --all-targets -D warnings` fails
    // with `dead_code` — a CI-blocking error (see `just lint`).
    //
    // Red-team finding (M12.5b): `sync_content_inner_recheck` was added as a
    // test-only pure-seam function but declared `pub(crate)` without `#[cfg(test)]`.
    // It has no production call site → dead_code warning → CI failure.
    //
    // This test is the gating guard: it fails if a future developer re-introduces
    // the pattern (adds a test-only seam to content.rs without `#[cfg(test)]`).
    // =========================================================================

    /// GATE(test-seam-no-dead-code): every function in content.rs that is declared
    /// as a test-only seam (pattern: seam functions whose name ends in `_recheck`)
    /// must have a `#[cfg(test)]` attribute on the line immediately before their
    /// `pub(crate) fn` declaration, or be called from production code.
    ///
    /// KILLS: a test-seam function added without `#[cfg(test)]` — that breaks
    ///        `just lint` (clippy -D warnings → dead_code error). The canonical
    ///        correct form is:
    ///           #[cfg(test)]
    ///           pub(crate) fn sync_content_inner_recheck(...)
    ///        OR the function has a production call site in content.rs.
    ///
    /// Note: built from assembled parts to avoid self-match (this file is the
    /// CONTENT_RS_SOURCE). The actual string `#[cfg(test)]` does appear in this
    /// file (legitimately, before the `mod tests` block); the structural check
    /// below constrains it to the specific vicinity of `_recheck`.
    #[test]
    fn test_seam_recheck_functions_are_cfg_test_gated() {
        let stripped = strip_rust_comments(CONTENT_RS_SOURCE);

        // Assemble the seam function name from parts to avoid self-match.
        let recheck_fn = ["sync_content_inner", "_recheck"].concat();
        let fn_decl = ["pub(crate) fn ", recheck_fn.as_str()].concat();

        // If the function has been removed, the constraint is vacuously satisfied.
        // Use if-let (not bare return;) to avoid tripping the bare-return counter in
        // the `sync_content_inner_no_bare_returns_on_error` test above.
        if let Some(fn_pos) = stripped.find(fn_decl.as_str()) {
            // Look backward from fn_pos for `#[cfg(test)]` in the preceding ~200 bytes.
            let window_start = fn_pos.saturating_sub(200);
            let preceding = &stripped[window_start..fn_pos];
            let cfg_gate = ["#[cfg", "(test)]"].concat();

            // Detect a genuine production *call* site (not the declaration itself).
            // Scan the region before any test module for `recheck_fn(` that is NOT
            // preceded by `fn ` (which would be the declaration, not a call).
            let tests_mod_marker = ["mod ", "tests"].concat();
            let tests_mod_pos = stripped
                .find(tests_mod_marker.as_str())
                .unwrap_or(stripped.len());
            let production_region = &stripped[..tests_mod_pos];
            let call_needle = [recheck_fn.as_str(), "("].concat();
            let fn_decl_prefix = ["fn ", recheck_fn.as_str(), "("].concat();
            let called_in_production = production_region.contains(call_needle.as_str())
                && !production_region.contains(fn_decl_prefix.as_str());

            assert!(
                preceding.contains(cfg_gate.as_str()) || called_in_production,
                "GATE(test-seam-no-dead-code): `{}` is a test-only seam function but \
                 lacks `#[cfg(test)]` before its `pub(crate) fn` declaration AND has no \
                 production call site. This causes a `dead_code` lint error in `just lint` \
                 (clippy -D warnings). Fix: add `#[cfg(test)]` on the line immediately \
                 before `pub(crate) fn {}(...)`, or add a production call site. \
                 Preceding 80-byte context: {:?}",
                recheck_fn,
                recheck_fn,
                &preceding[preceding.len().saturating_sub(80)..],
            );
        }
    }
}

// =========================================================================
// content_tests module — M12.5b unit tests for sync_content_inner seam
// Declared here (not in a sibling file) because content.rs is the domain
// module and the tests exercise its exported seam functions directly.
// =========================================================================
#[cfg(test)]
#[path = "content_tests.rs"]
mod content_tests;
