//! `hot_paths` — the criterion harness + perf-budget gate. `fn main` is ours (`harness = false`): clean the
//! criterion output dirs (AM1), bench the budgeted hot paths over REAL
//! shipped content (the public `load_*` loaders — never cfg(test) builders),
//! read criterion's `mean.point_estimate` back, and exit non-zero on any
//! violation, missing measurement, or unreadable estimate.
//!
//! Scope notes (plan §6e): `attempt_recruit` is deliberately NOT benched
//! (sub-nanosecond modulo compare — the harness would measure itself);
//! client-wasm marshaling is not benched here either (OBS-7/D7 forbids a
//! criterion dep outside game-core) — `map_for` covers the game-core side of
//! that boundary. No wall-clock reads in this file: criterion owns all timing
//! (`clippy.toml` bans `Instant::now`; criterion's internals are exempt).

mod budgets;

use budgets::BUDGETS;
use criterion::{BatchSize, Criterion};
use game_core::tactics::{
    build_kits, deploy_unit, load_battle_maps, load_tactics_skills, load_tactics_species,
    load_tactics_tuning, plan, BattleKind, QueuedAction, Side, Stance, TacticalState, UnitKit,
};
use game_core::{
    apply_move, build_monster, derive_stats, eligible_evolution_paths, evolve, load_encounters,
    load_evolution_paths, load_skills, load_species, load_type_chart, load_zone_maps, map_for,
    resolve_encounter, resolve_turn, spawn, ActionState, BattleMonster, BattleOutcome, BattleSide,
    BattleState, CharacterState, Direction, Level, Millis, MoveInput, Species, TurnChoice,
    TurnVariance, TypeChart,
};
use std::hint::black_box;
use std::path::PathBuf;
use std::process;
use std::time::Duration;

/// Output-dir resolution. Only the `CRITERION_HOME` branch is exercised in
/// practice — the `perf-budget:` recipe always exports it, and `clean_ids`/
/// `read_measurements` resolve through this same function, so a mismatch fails
/// loud rather than reading stale data. The fallbacks below are a best-effort
/// approximation, NOT criterion's exact logic: criterion additionally consults
/// `cargo metadata` for the workspace target dir before falling back to a
/// cwd-relative `target/criterion`, so a bare `cargo bench --bench hot_paths`
/// without `CRITERION_HOME` set may fail with a missing-estimates error here
/// (diagnosis: run via `just perf-budget`, which sets the env var).
fn criterion_home() -> PathBuf {
    if let Some(home) = std::env::var_os("CRITERION_HOME") {
        return PathBuf::from(home);
    }
    if let Some(target) = std::env::var_os("CARGO_TARGET_DIR") {
        return PathBuf::from(target).join("criterion");
    }
    PathBuf::from("target").join("criterion")
}

/// Project a species into a battle monster at level 50 with one known skill.
/// Individuality comes from `build_monster` (seeded, deterministic).
fn battle_monster(species: &Species, seed: u32, skill_id: u32) -> BattleMonster {
    let level = Level::new(50).expect("50 is a valid level");
    let m = build_monster(seed, species, level);
    BattleMonster {
        species_id: m.species_id,
        affinity: species.affinity,
        level: m.level.as_u8(),
        current_hp: m.current_hp,
        max_hp: m.derived_stats.hp,
        stats: m.derived_stats,
        known_skill_ids: vec![skill_id],
        status: None,
    }
}

fn main() {
    let ids: Vec<&str> = BUDGETS.iter().map(|b| b.id).collect();
    let home = criterion_home();

    // AM1 FIRST: kill each budgeted id's stale dir before criterion runs, so a
    // cache-restored estimates.json can never be read back as this run's
    // measurement (Swatinem/rust-cache restores target/ across CI runs).
    if let Err(e) = budgets::clean_ids(&home, &ids) {
        eprintln!(
            "perf-budget: could not clean stale criterion dirs under {}: {e}",
            home.display()
        );
        process::exit(1);
    }

    // --- Fixtures: REAL shipped content, built ONCE outside the measured
    // closures (plan §6e). Content-load failures are content bugs — fail loud.
    let species = load_species().expect("species content must load");
    let skills = load_skills().expect("skills content must load");
    let relations = load_type_chart().expect("type-chart content must load");
    let chart = TypeChart::new(&relations);
    let paths = load_evolution_paths().expect("evolution-paths content must load");
    let encounters = load_encounters().expect("encounters content must load");
    let zone_maps = load_zone_maps().expect("zone-maps content must load");

    let map = map_for(0, &zone_maps).expect("zone 0 map must build");
    let walker = CharacterState {
        pos: spawn(),
        facing: Direction::South,
        action: ActionState::Idle,
        move_started_at: Millis(0),
    };

    let base_species = species.first().expect("species registry is non-empty");
    let foe_species = species.get(1).unwrap_or(base_species);
    let skill_id = skills.first().expect("skills registry is non-empty").id;
    let battle = BattleState {
        side_a: BattleSide::with_lead(vec![battle_monster(base_species, 1, skill_id)])
            .expect("side A has a conscious lead"),
        side_b: BattleSide::with_lead(vec![battle_monster(foe_species, 2, skill_id)])
            .expect("side B has a conscious lead"),
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };
    let variance = TurnVariance::from_ctx_random(7);

    let table = encounters
        .iter()
        .find(|t| !t.entries.is_empty())
        .expect("an encounter table with entries exists");
    let enc_level = Level::new(4).expect("4 is a valid level");
    // A seed that exercises the FULL spawn path (trigger + weighted species
    // pick + level band), so the bench does not measure the cheap-roll early
    // return. Deterministic: the first triggering seed is always the same.
    let enc_seed = (0..100_000u32)
        .find(|&s| resolve_encounter(table, s, enc_level).is_some())
        .expect("a triggering encounter seed exists in the first 100k");

    let edge = paths
        .first()
        .expect("evolution-paths registry is non-empty");
    let evolver_species = species
        .iter()
        .find(|s| s.id == edge.from_species)
        .expect("the first evolution edge's from_species exists");
    let target_species = species
        .iter()
        .find(|s| s.id == edge.to_species)
        .expect("the first evolution edge's to_species exists");
    let evolver = build_monster(3, evolver_species, Level::new(50).expect("valid level"));

    let (base, ivs, evs, nature) = {
        let m = build_monster(5, base_species, Level::new(50).expect("valid level"));
        (base_species.base_stats, m.ivs, m.evs, m.nature)
    };
    let stat_level = Level::new(50).expect("valid level");

    // The opening board of a wild 3v3 on the first 8x8 PvE map, every unit the first Aggressive
    // battler (the stance that weighs its whole reach); the planned unit is the first wild.
    let tuning = load_tactics_tuning().expect("tactics tuning content must load");
    let kits = build_kits(
        &species,
        &skills,
        &load_tactics_skills().expect("tactics skill content must load"),
        &load_tactics_species().expect("tactics species content must load"),
    )
    .expect("the shipped kits join");
    let battler = kits
        .iter()
        .find(|k| k.stance == Stance::Aggressive)
        .expect("an Aggressive battler exists");
    let battler_species = species
        .iter()
        .find(|s| s.id == battler.species_id)
        .expect("the battler's species exists");
    let battle_maps = load_battle_maps().expect("battle-map content must load");
    let arena = &battle_maps
        .iter()
        .find(|m| !m.pvp && m.map.width == 8 && m.map.height == 8)
        .expect("an 8x8 PvE battle map exists")
        .map;
    let battler_stats =
        build_monster(9, battler_species, Level::new(50).expect("valid level")).derived_stats;
    let battler_kit = UnitKit {
        species_id: battler.species_id,
        affinity: battler_species.affinity,
        level: 50,
        stats: battler_stats,
        base_speed: battler.base_speed,
        class: battler.movement,
        skills: vec![battler.light.clone(), battler.heavy.clone()],
    };
    let wild_id = 101;
    let wild_spawn = arena.spawn_b[0];
    let mut tactical_units = Vec::new();
    for slot in 0..3u8 {
        let i = usize::from(slot);
        for (id_base, side, spawns) in [
            (1, Side::A, &arena.spawn_a),
            (wild_id, Side::B, &arena.spawn_b),
        ] {
            tactical_units.push(
                deploy_unit(
                    id_base + u32::from(slot),
                    side,
                    slot,
                    spawns[i],
                    battler_kit.clone(),
                    battler_stats.hp,
                )
                .expect("a level-50 battler deploys"),
            );
        }
    }
    let tactical = TacticalState::new(BattleKind::Wild, 7, arena, tactical_units)
        .expect("the 3v3 opening board is legal");
    // The bench must measure a full plan (reach, candidates, a chosen tile), not the `[EndTurn]`
    // early return of a refused board.
    assert!(
        matches!(
            plan(&tactical, wild_id, Stance::Aggressive, wild_spawn, &tuning).first(),
            Some(QueuedAction::Move(_))
        ),
        "the first wild opens the 3v3 with a Move"
    );

    // --- Bench: fixed configuration, no CLI parsing (`cargo bench` passes
    // libtest-style flags this binary must ignore, so `configure_from_args` is
    // deliberately NOT called).
    let mut c = Criterion::default()
        .warm_up_time(Duration::from_millis(500))
        .measurement_time(Duration::from_secs(2))
        .sample_size(30);

    // East from spawn (1,1) is open floor in zone 0, so this exercises the real
    // successful-move write path; North is the border wall and would measure
    // only the bump branch (reviewer finding, m20a impl review).
    c.bench_function("apply_move", |b| {
        b.iter(|| {
            apply_move(
                black_box(&walker),
                black_box(MoveInput::Step(Direction::East)),
                black_box(&map),
                black_box(Millis(16)),
            )
        })
    });

    c.bench_function("derive_stats", |b| {
        b.iter(|| {
            derive_stats(
                black_box(&base),
                black_box(&ivs),
                black_box(&evs),
                black_box(&nature),
                black_box(stat_level),
            )
        })
    });

    // AM5: resolve_turn mutates in place; iterating on one state drives the
    // battle terminal in a few iterations and the early-return would dominate
    // the measurement. Clone a fresh state per iteration, outside the timing.
    c.bench_function("resolve_turn", |b| {
        b.iter_batched(
            || battle.clone(),
            |mut s| {
                resolve_turn(
                    black_box(&mut s),
                    black_box(TurnChoice::Attack { skill_id }),
                    black_box(TurnChoice::Attack { skill_id }),
                    black_box(&skills),
                    black_box(&chart),
                    black_box(&variance),
                )
            },
            BatchSize::SmallInput,
        )
    });

    c.bench_function("resolve_encounter", |b| {
        b.iter(|| resolve_encounter(black_box(table), black_box(enc_seed), black_box(enc_level)))
    });

    c.bench_function("evolution_eligible_paths", |b| {
        b.iter(|| eligible_evolution_paths(black_box(&evolver), black_box(&paths)))
    });

    c.bench_function("evolve", |b| {
        b.iter(|| evolve(black_box(&evolver), black_box(target_species)))
    });

    c.bench_function("map_for", |b| {
        b.iter(|| map_for(black_box(0), black_box(&zone_maps)))
    });

    c.bench_function("tactics_plan", |b| {
        b.iter(|| {
            plan(
                black_box(&tactical),
                black_box(wild_id),
                black_box(Stance::Aggressive),
                black_box(wild_spawn),
                black_box(&tuning),
            )
        })
    });

    c.final_summary();

    // --- The gate: read back, then fail loud on any gap or breach.
    let measured = match budgets::read_measurements(&home, &ids) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("perf-budget: {e}");
            process::exit(1);
        }
    };
    let pairs: Vec<(&str, f64)> = measured.iter().map(|(id, ns)| (id.as_str(), *ns)).collect();

    let absent = budgets::missing(&pairs, BUDGETS);
    if !absent.is_empty() {
        eprintln!(
            "perf-budget: budgeted id(s) with no measurement: {}",
            absent.join(", ")
        );
        process::exit(1);
    }

    let breaches = budgets::violations(&pairs, BUDGETS);
    if !breaches.is_empty() {
        for breach in &breaches {
            eprintln!("{breach}");
        }
        process::exit(1);
    }

    println!(
        "perf-budget: all {} hot paths within their ceilings",
        BUDGETS.len()
    );
}
