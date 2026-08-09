//! `hot_paths` — the OBS-5/OBS-6 criterion harness + perf-budget gate (m20a
//! plan §6, ADR-0180 D7). `fn main` is ours (`harness = false`): clean the
//! criterion output dirs (AM1), bench the 7 budgeted hot paths over REAL
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

/// Criterion's own output-dir resolution, mirrored exactly (the `perf-budget:`
/// recipe exports `CRITERION_HOME`, so the env var is the normal path): the
/// `CRITERION_HOME` env var, else `$CARGO_TARGET_DIR/criterion`, else
/// `target/criterion`.
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

    // --- Bench: fixed configuration, no CLI parsing (`cargo bench` passes
    // libtest-style flags this binary must ignore, so `configure_from_args` is
    // deliberately NOT called).
    let mut c = Criterion::default()
        .warm_up_time(Duration::from_millis(500))
        .measurement_time(Duration::from_secs(2))
        .sample_size(30);

    c.bench_function("apply_move", |b| {
        b.iter(|| {
            apply_move(
                black_box(&walker),
                black_box(MoveInput::Step(Direction::North)),
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
