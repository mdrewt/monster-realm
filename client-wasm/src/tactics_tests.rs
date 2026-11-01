//! bt-11 host tests over the inner tactics fns of `lib.rs` (`super::*`): the wasm wrappers take
//! `JsValue`, which is not constructible natively, so the rules composition is proven here on the
//! host and its marshaling in `client/src/tactics/wasm.test.ts` against the built pkg.
//!
//! SOURCE OF TRUTH: spec BT11.7 (+ bt-10's deferred BT10.4) and the bt-11 plan §4 as amended by
//! REV 2 A1–A17 and REV 3 A18–A21 (memory/projects/monster-realm-bt-11-plan.md). The names and
//! shapes of the `// --- Tactics rules (bt-11) ---` region of lib.rs are the contract: every call
//! below goes through them.
//!
//! HOW THE EXPECTED VALUES ARE BUILT: from game-core directly, never from what the shell prints —
//! the content join from `build_kits` / `load_species` (the server's `unit_of_row`,
//! server-module/src/tactics.rs:425 + :325), the state field by field (golden.rs:315-329), the
//! forecast traces from `damage_pipeline` at the first hitting roll and variance 85 / 100
//! (resolve.rs:512, combat/damage.rs:97), reach from `validate_at_pop` with `super::InertHooks`
//! (queue.rs:547, plan A3), danger from the A4 probe sweep over `target_set` (geometry.rs:134),
//! the plan from `spend` / `plan_cost` / `guard_granted` (economy.rs:136-203), and the status
//! clause from `resolve_attack` itself (resolve.rs:603).
//!
//! HOW THE TESTS ARE PROVEN: written red against the API-freeze stubs (every inner fn returned
//! `Err("bt-11: not implemented")`; only `bt11_variance_consts`, which pins the frozen
//! `FORECAST_VARIANCE_*` constants to the carried `draw_rolls` range, was green there by design),
//! now green against the implementation. Their bite is each test's WRONG IMPL KILLED note; the
//! round-2 tests below `bt11_status_blocked_matches_resolve` each name the red-team mutant they
//! kill (m18 spawn from the unit's tile, b2 corpse as probe, a3 tax dropped, c2 own standing tile
//! dropped, d10 restated factors, d16 unvalidated tuning, the STAB and recruit desync guards, A20).
//!
//! Names start `bt11_` (the BT11.7 CHECK filters `test(/bt11_/)`). Do NOT edit these tests to match
//! a buggy implementation; correct them from the spec only.

use game_core::tactics::{
    build_kits, damage_pipeline, disengage_taxed, draw_rolls, guard_granted, is_exhausted,
    load_battle_maps, load_tactics_skills, load_tactics_species, load_tactics_tuning, plan_cost,
    recruit_odds, resolve_attack, spend, target_set, validate_at_pop, BattleKind, BattleMapEntry,
    BoardUnit, Cell, Entry, FfFilter, MoveAction, MoveClass, Origin, QueuedAction, RecruitOdds,
    RollPair, Shape, Side, SkillGeometry, SkillTactics, SpeciesTactics, Stance, TacticalEvent,
    TacticalState, TacticalUnit, TacticsTuning, Terrain, Tier, TurnBudget, TurnEndCause, UnitKit,
    UnitState,
};
// The wild planner, named apart from `super::plan_of` and the economy's `plan_cost`.
use game_core::tactics::plan as wild_plan;
use game_core::{
    accuracy_check, load_skills, load_species, load_type_chart, Affinity, BattleOutcome,
    Effectiveness, Species, StatBlock, StatusEffect, StatusKind, TypeChart, TypeRelation,
};

use super::{BoardIn, OverlayQuery, OverlaysOut, UnitRow};

/// The design tuning (A12: the loaded `tactics_tuning.ron` must equal it — `bt11_content_loads`).
const T: TacticsTuning = TacticsTuning::DESIGN;

// ---------------------------------------------------------------------------
// Content oracle: game-core's own join
// ---------------------------------------------------------------------------

/// The live registries, joined by game-core (`build_kits`) — the oracle for the shell's join.
struct Live {
    species: Vec<Species>,
    kits: Vec<SpeciesTactics>,
    maps: Vec<BattleMapEntry>,
}

fn live() -> Live {
    let species = load_species().expect("species RON");
    let skills = load_skills().expect("skills RON");
    let tskills = load_tactics_skills().expect("tactics_skills RON");
    let tspecies = load_tactics_species().expect("tactics_species RON");
    let kits = build_kits(&species, &skills, &tskills, &tspecies).expect("live build_kits");
    let maps = load_battle_maps().expect("battle_maps RON");
    Live {
        species,
        kits,
        maps,
    }
}

/// The server's `unit_of_row` join, by hand (server-module/src/tactics.rs:325-337 + :425-445):
/// affinity from the species row, base speed / class / `[light, heavy]` from the kit, level and
/// stats from the ROW, everything else copied.
fn join(l: &Live, r: &UnitRow) -> TacticalUnit {
    let species = l
        .species
        .iter()
        .find(|s| s.id == r.species_id)
        .expect("a species row");
    let kit = l
        .kits
        .iter()
        .find(|k| k.species_id == r.species_id)
        .expect("a kit row");
    TacticalUnit {
        id: r.id,
        side: r.side,
        slot: r.slot,
        kit: UnitKit {
            species_id: r.species_id,
            affinity: species.affinity,
            level: r.level,
            stats: r.stats,
            base_speed: kit.base_speed,
            class: kit.movement,
            skills: vec![kit.light.clone(), kit.heavy.clone()],
        },
        pos: r.pos,
        cur_hp: r.cur_hp,
        status: r.status,
        budget: r.budget,
        guard: r.guard,
        first_stand: r.first_stand,
        state: r.state,
    }
}

fn side_index(side: Side) -> u8 {
    match side {
        Side::A => 0,
        Side::B => 1,
    }
}

fn opponent(side: Side) -> Side {
    match side {
        Side::A => Side::B,
        Side::B => Side::A,
    }
}

/// The rules state for a client board, field by field (plan A6 / golden.rs:315-329): the content
/// map's tiles, the joined units sorted `(side, slot)`, seed / action_seq 0, round 1, `Ongoing`.
fn state_for(l: &Live, b: &BoardIn) -> TacticalState {
    let map = &l
        .maps
        .iter()
        .find(|m| m.id == b.map_id)
        .expect("a content map")
        .map;
    let mut units: Vec<TacticalUnit> = b.units.iter().map(|r| join(l, r)).collect();
    units.sort_by_key(|u| (side_index(u.side), u.slot));
    TacticalState {
        kind: b.kind,
        seed: 0,
        action_seq: 0,
        round: 1,
        width: map.width,
        height: map.height,
        terrain: map.tiles.iter().map(|t| t.terrain).collect(),
        blocks_los: map.tiles.iter().map(|t| t.blocks_los).collect(),
        units,
        initiative: Vec::new(),
        queued: Vec::new(),
        attack_damage_dealt: [0, 0],
        outcome: BattleOutcome::Ongoing,
    }
}

// ---------------------------------------------------------------------------
// Board fixtures
// ---------------------------------------------------------------------------

const STATS: StatBlock = StatBlock {
    hp: 100,
    attack: 50,
    defense: 50,
    speed: 50,
    sp_attack: 50,
    sp_defense: 50,
};

/// A conscious, idle row of `species_id` at `(x, y)` (level 10, 100/100 HP).
fn row(id: u32, side: Side, slot: u8, species_id: u32, x: u8, y: u8) -> UnitRow {
    UnitRow {
        id,
        side,
        slot,
        species_id,
        level: 10,
        stats: STATS,
        pos: Cell { x, y },
        cur_hp: 100,
        status: None,
        budget: TurnBudget::default(),
        guard: false,
        first_stand: false,
        state: UnitState::Active,
        stance: None,
        wild_index: None,
    }
}

fn fainted(mut r: UnitRow) -> UnitRow {
    r.state = UnitState::Fainted;
    r.cur_hp = 0;
    r
}

fn board(map_id: u32, units: Vec<UnitRow>) -> BoardIn {
    BoardIn {
        kind: BattleKind::Wild,
        map_id,
        units,
    }
}

fn fresh() -> TurnBudget {
    TurnBudget::fresh(&T)
}

fn budget(ap: u8, strides_used: u8, attacks: u8, last: Option<Entry>) -> TurnBudget {
    TurnBudget {
        ap,
        strides_used,
        attacks,
        last,
    }
}

fn query(viewer: Side, selected: Option<u32>, budget: TurnBudget) -> OverlayQuery {
    OverlayQuery {
        viewer,
        selected,
        skill_id: None,
        aim: None,
        budget,
    }
}

/// The true cells of a row-major grid, row-major.
fn cells(grid: &[bool], width: u8) -> Vec<Cell> {
    let w = usize::from(width);
    grid.iter()
        .enumerate()
        .filter(|(_, hit)| **hit)
        .map(|(i, _)| Cell {
            x: u8::try_from(i % w).expect("x fits a u8"),
            y: u8::try_from(i / w).expect("y fits a u8"),
        })
        .collect()
}

fn strictly_row_major(list: &[Cell]) -> bool {
    list.windows(2).all(|p| (p[0].y, p[0].x) < (p[1].y, p[1].x))
}

/// Plan A3: the least `s` for which the execution gate accepts `Move{to, s}` for `unit` with its
/// budget replaced by `basis` — `None` when no stride count is accepted.
fn least_strides(state: &TacticalState, unit: u32, basis: TurnBudget, to: Cell) -> Option<u8> {
    let mut st = state.clone();
    if let Some(u) = st.unit_mut(unit) {
        u.budget = basis;
    }
    (1..=T.max_strides_per_turn).find(|&s| {
        let action = QueuedAction::Move(MoveAction {
            x: to.x,
            y: to.y,
            strides: s,
        });
        validate_at_pop(&st, unit, &action, &super::InertHooks, &T).is_ok()
    })
}

/// reach1 / reach2 by the real gate (plan A3), row-major.
fn reach_oracle(state: &TacticalState, unit: u32, basis: TurnBudget) -> (Vec<Cell>, Vec<Cell>) {
    let own = state.unit(unit).map(|u| u.pos);
    let (mut r1, mut r2) = (Vec::new(), Vec::new());
    for y in 0..state.height {
        for x in 0..state.width {
            let to = Cell { x, y };
            if Some(to) == own {
                continue;
            }
            match least_strides(state, unit, basis, to) {
                Some(1) => r1.push(to),
                Some(2) => r2.push(to),
                _ => {}
            }
        }
    }
    (r1, r2)
}

/// Plan A4 danger for every conscious unit with `side != viewer`, in `(side, slot)` order: from a
/// fresh budget, every standing tile (its own at s = 0, else the least `s` of A3), every kit skill
/// whose `[Move{s, taxed}?, Attack(tier), EndTurn]` `plan_cost` affords, and the PROBE sweep: a
/// tile is threatened when `target_set` from the moved board hits the unit standing on it — the
/// living occupant, else a conscious probe of the caster's opponent (id u32::MAX, Walk). A tile
/// with no LIVING unit is empty (dead units never occupy, movement.rs:159-163, geometry.rs:185).
fn danger_oracle(state: &TacticalState, viewer: Side) -> Vec<Vec<Cell>> {
    let base = fresh();
    let board = state.board();
    let (w, h) = (state.width, state.height);
    let mut out = Vec::new();
    for e in state
        .units
        .iter()
        .filter(|u| u.side != viewer && u.is_conscious())
    {
        let taxed = disengage_taxed(&board, e.id, e.pos).expect("a conscious unit on the board");
        let mut standing = vec![(e.pos, 0_u8)];
        for y in 0..h {
            for x in 0..w {
                let to = Cell { x, y };
                if to == e.pos {
                    continue;
                }
                if let Some(s) = least_strides(state, e.id, base, to) {
                    standing.push((to, s));
                }
            }
        }
        let mut hit = vec![false; usize::from(w) * usize::from(h)];
        for &(at, s) in &standing {
            for k in &e.kit.skills {
                let mut entries = Vec::new();
                if s > 0 {
                    entries.push(Entry::Move { strides: s, taxed });
                }
                entries.push(Entry::Attack(k.tier));
                entries.push(Entry::EndTurn);
                if plan_cost(&base, &entries, &T).is_err() {
                    continue;
                }
                let mut moved = board.clone();
                if let Some(me) = moved.units.iter_mut().find(|u| u.id == e.id) {
                    me.pos = at;
                }
                for y in 0..h {
                    for x in 0..w {
                        let c = Cell { x, y };
                        let mut probed = moved.clone();
                        let occupant = probed
                            .units
                            .iter()
                            .find(|u| u.alive && u.pos == c)
                            .map(|u| u.id);
                        let id = match occupant {
                            Some(id) => id,
                            None => {
                                probed.units.push(BoardUnit {
                                    id: u32::MAX,
                                    side: opponent(e.side),
                                    pos: c,
                                    alive: true,
                                    class: MoveClass::Walk,
                                });
                                u32::MAX
                            }
                        };
                        let aim = match k.geometry.origin {
                            Origin::Caster => at,
                            Origin::TargetUnit => c,
                        };
                        if target_set(&k.geometry, e.id, aim, &probed)
                            .is_ok_and(|ids| ids.contains(&id))
                        {
                            hit[usize::from(y) * usize::from(w) + usize::from(x)] = true;
                        }
                    }
                }
            }
        }
        out.push(cells(&hit, w));
    }
    out
}

// ---------------------------------------------------------------------------
// Forecast fixtures
// ---------------------------------------------------------------------------

/// A level-30 battler with 300 max HP, a fresh budget, no kit skills.
fn fighter(id: u32, side: Side, x: u8, affinity: Affinity) -> TacticalUnit {
    TacticalUnit {
        id,
        side,
        slot: 0,
        kit: UnitKit {
            species_id: id,
            affinity,
            level: 30,
            stats: StatBlock {
                hp: 300,
                attack: 90,
                defense: 40,
                speed: 50,
                sp_attack: 50,
                sp_defense: 50,
            },
            base_speed: 50,
            class: MoveClass::Walk,
            skills: Vec::new(),
        },
        pos: Cell { x, y: 0 },
        cur_hp: 300,
        status: None,
        budget: fresh(),
        guard: false,
        first_stand: false,
        state: UnitState::Active,
    }
}

/// A Light, range 1..2 single-target skill (the attacker stands next to its target).
fn lance(
    skill_id: u32,
    affinity: Affinity,
    power: u16,
    accuracy: u8,
    applies_status: Option<StatusKind>,
) -> SkillTactics {
    SkillTactics {
        skill_id,
        tier: Tier::Light,
        affinity,
        power,
        accuracy,
        applies_status,
        geometry: SkillGeometry {
            range_min: 1,
            range_max: 2,
            origin: Origin::TargetUnit,
            shape: Shape::Single,
            radius: 0,
            ff_filter: FfFilter::Enemies,
        },
    }
}

fn content_chart() -> TypeChart {
    TypeChart::new(&load_type_chart().expect("type_chart RON"))
}

/// A 4x4 Plain duel: the attacker (id 1) at (0,0) carrying `skill`, the target (id 2) at (1,0).
fn duel(skill: &SkillTactics, target: &TacticalUnit) -> (TacticalUnit, TacticalState) {
    let mut attacker = fighter(1, Side::A, 0, Affinity::Fire);
    attacker.kit.skills = vec![skill.clone()];
    let state = TacticalState {
        kind: BattleKind::Wild,
        seed: 0,
        action_seq: 0,
        round: 1,
        width: 4,
        height: 4,
        terrain: vec![Terrain::Plain; 16],
        blocks_los: vec![false; 16],
        units: vec![attacker.clone(), target.clone()],
        initiative: Vec::new(),
        queued: Vec::new(),
        attack_damage_dealt: [0, 0],
        outcome: BattleOutcome::Ongoing,
    };
    (attacker, state)
}

/// The first seed whose first `draw_rolls` pair has this variance (the carried stream).
fn seed_with_variance(state: &TacticalState, variance: u8) -> u64 {
    (0_u64..20_000)
        .find(|&seed| {
            let mut probe = state.clone();
            probe.seed = seed;
            probe.action_seq = 0;
            draw_rolls(&mut probe).variance == variance
        })
        .expect("a seed with that variance exists")
}

// ===========================================================================
// Tests
// ===========================================================================

/// The content singleton mirrors game-core's own loaders (A12): kits from `build_kits`, maps from
/// `load_battle_maps`, the tuning equal to `TacticsTuning::DESIGN`, map 1 7x7 (battle_maps
/// 000-core.ron:8-27), the fresh budget `TurnBudget::fresh`, an unknown map refused by id.
///
/// WRONG IMPL KILLED: kits built without the carried skill rows (power/accuracy/affinity
/// defaulted); a tuning that is not the RON / DESIGN; a map list missing an entry; a fresh budget
/// of `TurnBudget::default()` (ap 0); an unknown map answered with map 1.
#[test]
fn bt11_content_loads() {
    let content = super::tactics_content().expect("the tactical content loads");
    let l = live();
    assert!(!content.kits.is_empty(), "kits are non-empty");
    assert_eq!(
        content.kits, l.kits,
        "the kits are build_kits' join, in registry order"
    );
    assert_eq!(content.tuning, T, "the tuning is the design's");
    assert_eq!(
        content.tuning,
        load_tactics_tuning().expect("tactics_tuning RON"),
        "the tuning is the loaded RON"
    );
    assert_eq!(content.maps, l.maps, "every content map, in registry order");
    assert_eq!(
        content.species.iter().map(|s| s.id).collect::<Vec<_>>(),
        l.species.iter().map(|s| s.id).collect::<Vec<_>>(),
        "every species row"
    );
    assert_eq!(
        content.chart.effectiveness(Affinity::Fire, Affinity::Plant),
        20,
        "the embedded type chart (Fire beats Plant)"
    );
    let m1 = super::map_of(1).expect("map 1");
    assert_eq!(
        (m1.width, m1.height, m1.tiles.len()),
        (7, 7, 49),
        "map 1 is the 7x7 Open Field"
    );
    assert_eq!(m1.spawn_b[0], Cell { x: 1, y: 5 }, "map 1 spawn_b[0]");
    let m5 = super::map_of(5).expect("map 5");
    assert_eq!(
        m5.tiles[3 * 8].terrain,
        Terrain::Water,
        "map 5 (8x8) row 3 starts with Water"
    );
    assert_eq!(
        super::fresh_budget(),
        Ok(fresh()),
        "TurnBudget::fresh(tuning)"
    );
    let err = super::map_of(4242).expect_err("an unknown map is refused");
    assert!(err.contains("4242"), "the error names the map id: {err}");
}

/// The row join is the server's `unit_of_row` for EVERY content species, and species 1 (Flameling,
/// species/000-core.ron:3-10; tactics_species/000-core.ron:12) carries content skills 1 (Ember,
/// skills/000-core.ron:6 + tactics_skills/000-core.ron:17) and 2 (Fire Fang, :7 + :8) with its
/// species base speed 65 — while level and stats come from the ROW.
///
/// WRONG IMPL KILLED: level/stats taken from the species base stats; base_speed from the row's
/// levelled speed; the class from anything but the tactics row; the kit in another order
/// (heavy first); a skill with the sidecar geometry but defaulted power/accuracy; any copied row
/// field dropped or swapped (status, budget, guard, first_stand, state); an unknown species joined
/// to a default kit.
#[test]
fn bt11_unit_join() {
    let l = live();
    let skills = load_skills().expect("skills RON");
    let tskills = load_tactics_skills().expect("tactics_skills RON");
    let joined = |id: u32| -> SkillTactics {
        let def = skills.iter().find(|s| s.id == id).expect("a skill row");
        let sidecar = tskills
            .iter()
            .find(|s| s.skill_id == id)
            .expect("a tactics_skills row");
        SkillTactics {
            skill_id: id,
            tier: sidecar.tier,
            affinity: def.affinity,
            power: def.power,
            accuracy: def.accuracy,
            applies_status: def.applies_status,
            geometry: sidecar.geometry(),
        }
    };
    let flameling = l.species.iter().find(|s| s.id == 1).expect("species 1");
    let mut r = row(7, Side::B, 2, 1, 4, 5);
    r.level = 37;
    r.stats = StatBlock {
        hp: 211,
        attack: 53,
        defense: 59,
        speed: 61,
        sp_attack: 67,
        sp_defense: 71,
    };
    r.cur_hp = 173;
    r.status = Some(StatusEffect::Sleep { turns_remaining: 2 });
    r.budget = budget(
        5,
        1,
        1,
        Some(Entry::Move {
            strides: 1,
            taxed: true,
        }),
    );
    r.guard = true;
    r.first_stand = true;
    r.state = UnitState::Fainted;
    let want = TacticalUnit {
        id: 7,
        side: Side::B,
        slot: 2,
        kit: UnitKit {
            species_id: 1,
            affinity: flameling.affinity,
            level: 37,
            stats: r.stats,
            base_speed: flameling.base_stats.speed,
            class: MoveClass::Walk,
            skills: vec![joined(1), joined(2)],
        },
        pos: Cell { x: 4, y: 5 },
        cur_hp: 173,
        status: Some(StatusEffect::Sleep { turns_remaining: 2 }),
        budget: r.budget,
        guard: true,
        first_stand: true,
        state: UnitState::Fainted,
    };
    assert_eq!(
        flameling.base_stats.speed, 65,
        "Flameling's base speed (the RON)"
    );
    assert_eq!(
        super::unit_of_row(&r),
        Ok(want),
        "species 1: the hand-built join (row fields verbatim, kit from content)"
    );

    let mut joined_species = 0;
    for kit in &l.kits {
        let mut r = row(40 + kit.species_id, Side::A, 1, kit.species_id, 2, 3);
        r.state = UnitState::Recruited;
        r.status = Some(StatusEffect::Paralysis);
        assert_eq!(
            super::unit_of_row(&r),
            Ok(join(&l, &r)),
            "species {}: the server's unit_of_row join",
            kit.species_id
        );
        joined_species += 1;
    }
    assert_eq!(
        joined_species,
        l.kits.len(),
        "every tactics species was joined"
    );
    assert!(joined_species >= 20, "ANTI-VACUITY: the whole roster");

    let err = super::unit_of_row(&row(1, Side::A, 0, 9999, 0, 0))
        .expect_err("an unknown species is refused");
    assert!(err.contains("9999"), "the error names the species: {err}");
}

/// `FORECAST_VARIANCE_MIN/MAX` are the extremes of the carried variance draw (`85 + roll % 16`,
/// resolve.rs:478-482), measured over 500 seeds. GREEN AT THE STUB (frozen constants).
///
/// WRONG IMPL KILLED: a min of 79 or 80 (the 1v1 `TurnVariance` lore), a max of 99.
#[test]
fn bt11_variance_consts() {
    let (_, base) = duel(
        &lance(1, Affinity::Fire, 40, 100, None),
        &fighter(2, Side::B, 1, Affinity::Plant),
    );
    let (mut lo, mut hi) = (u8::MAX, u8::MIN);
    for seed in 0_u64..500 {
        let mut st = base.clone();
        st.seed = seed;
        st.action_seq = 0;
        let rolls = draw_rolls(&mut st);
        assert!(rolls.accuracy < 100, "seed {seed}: accuracy in 0..100");
        lo = lo.min(rolls.variance);
        hi = hi.max(rolls.variance);
    }
    assert_eq!(
        super::FORECAST_VARIANCE_MIN,
        lo,
        "the variance floor of the carried draw"
    );
    assert_eq!(
        super::FORECAST_VARIANCE_MAX,
        hi,
        "the variance ceiling of the carried draw"
    );
    assert_eq!((lo, hi), (85, 100), "design §9.3: variance 85 and 100");
}

/// The forecast is `damage_pipeline` at the FIRST hitting accuracy roll, variance 85 (min) and 100
/// (max) — both at roll 99 / variance 100 when nothing hits (plan §4.1) — and its flags are read
/// off those traces. An injected Immune chart (A8: content has no Immune pair) gives d3 0, no kill,
/// and a blocked status.
///
/// WRONG IMPL KILLED: the min at variance 79/80 or the max at 99; the miss path computed at a
/// hitting roll; `hit_pct` = accuracy (101 / 255 rows: the roll is 0..100); kills_* from d3 >=
/// cur_hp ignoring First-Stand; first_stand_saves from one trace only; status_blocked ignoring
/// Immune or an existing status; the factors restated instead of read from the tuning; an invalid
/// unit forecast silently.
#[test]
fn bt11_forecast_matches_pipeline() {
    let chart = content_chart();
    let mut rows = 0;
    for &(accuracy, flank, guard, first_stand, cur_hp, status) in &[
        (100_u8, false, false, false, 300_u16, None),
        (95, true, false, false, 300, Some(StatusEffect::Burn)),
        (90, false, true, true, 120, None),
        (90, true, true, true, 1, None),
        (1, false, false, false, 7, None),
        (0, true, true, true, 300, None),
        (101, false, false, false, 60, Some(StatusEffect::Freeze)),
        (255, true, false, true, 90, None),
    ] {
        let skill = lance(7, Affinity::Fire, 70, accuracy, Some(StatusKind::Burn));
        let mut attacker = fighter(1, Side::A, 0, Affinity::Fire);
        attacker.kit.skills = vec![skill.clone()];
        let mut target = fighter(2, Side::B, 1, Affinity::Plant);
        target.guard = guard;
        target.first_stand = first_stand;
        target.cur_hp = cur_hp;
        target.status = status;
        let f = super::forecast_of(&chart, &T, &attacker, &target, &skill, flank)
            .expect("both units are valid");
        let first = (0_u8..100).find(|&r| accuracy_check(accuracy, r));
        let (roll, low) = match first {
            Some(r) => (r, 85),
            None => (99, 100),
        };
        let min = damage_pipeline(
            &attacker,
            &target,
            &skill,
            &chart,
            flank,
            RollPair {
                accuracy: roll,
                variance: low,
            },
            &T,
        );
        let max = damage_pipeline(
            &attacker,
            &target,
            &skill,
            &chart,
            flank,
            RollPair {
                accuracy: roll,
                variance: 100,
            },
            &T,
        );
        let label = format!("accuracy {accuracy} flank {flank} guard {guard} hp {cur_hp}");
        assert_eq!(f.min, min, "{label}: min = the pipeline at variance 85");
        assert_eq!(f.max, max, "{label}: max = the pipeline at variance 100");
        assert_eq!(
            usize::from(f.hit_pct),
            (0_u8..100).filter(|&r| accuracy_check(accuracy, r)).count(),
            "{label}: hit_pct counts the hitting rolls"
        );
        assert!(f.stab, "{label}: Fire skill from a Fire attacker is STAB");
        assert_eq!(
            (f.flank, f.guard),
            (flank, guard),
            "{label}: flank and Guard"
        );
        assert_eq!(f.effectiveness, min.effectiveness, "{label}: effectiveness");
        assert_eq!(
            f.kills_min,
            min.hit && min.hp_after == 0,
            "{label}: kills_min"
        );
        assert_eq!(
            f.kills_max,
            max.hit && max.hp_after == 0,
            "{label}: kills_max"
        );
        assert_eq!(
            f.first_stand_saves,
            min.stood_ground || max.stood_ground,
            "{label}: first_stand_saves"
        );
        assert_eq!(
            f.status,
            Some(StatusKind::Burn),
            "{label}: the skill's status"
        );
        assert_eq!(
            f.status_blocked,
            status.is_some(),
            "{label}: blocked exactly by an existing status (content has no Immune pair)"
        );
        assert_eq!(
            (f.flank_factor, f.guard_factor),
            ((T.flank_num, T.flank_den), (T.guard_num, T.guard_den)),
            "{label}: the tuning's factors"
        );
        rows += 1;
    }
    assert_eq!(rows, 8, "ANTI-VACUITY: every row ran");

    let off_stab = lance(8, Affinity::Water, 70, 100, None);
    let mut attacker = fighter(1, Side::A, 0, Affinity::Fire);
    attacker.kit.skills = vec![off_stab.clone()];
    let target = fighter(2, Side::B, 1, Affinity::Plant);
    let f =
        super::forecast_of(&chart, &T, &attacker, &target, &off_stab, false).expect("valid units");
    assert!(!f.stab, "a Water skill from a Fire attacker is not STAB");
    assert_eq!(f.status, None, "a skill with no status");

    let immune = TypeChart::new(&[TypeRelation {
        attacker: Affinity::Fire,
        defender: Affinity::Water,
        effectiveness: 0,
    }]);
    let burn = lance(7, Affinity::Fire, 70, 100, Some(StatusKind::Burn));
    let mut attacker = fighter(1, Side::A, 0, Affinity::Fire);
    attacker.kit.skills = vec![burn.clone()];
    let mut water = fighter(2, Side::B, 1, Affinity::Water);
    water.cur_hp = 1;
    let f = super::forecast_of(&immune, &T, &attacker, &water, &burn, true)
        .expect("valid units on the injected chart");
    assert_eq!(
        f.effectiveness,
        Some(Effectiveness::Immune),
        "the injected Immune pair"
    );
    assert_eq!((f.min.d3, f.max.d3), (0, 0), "an Immune hit deals 0");
    assert!(
        !f.kills_min && !f.kills_max,
        "an Immune hit never kills (1 HP target)"
    );
    assert!(
        f.status_blocked,
        "Immune blocks the status (resolve.rs:674-675)"
    );

    let mut dead = fighter(2, Side::B, 1, Affinity::Plant);
    dead.cur_hp = 0;
    let err = super::forecast_of(&chart, &T, &attacker, &dead, &burn, false)
        .expect_err("a 0-HP target fails validate_unit");
    assert!(
        err.contains("invalid unit"),
        "the golden BadCase class: {err}"
    );
    let mut soft = fighter(1, Side::A, 0, Affinity::Fire);
    soft.kit.skills = vec![burn.clone()];
    soft.kit.stats.defense = 0;
    let err = super::forecast_of(&chart, &T, &soft, &target, &burn, false)
        .expect_err("a 0-defense attacker fails validate_unit");
    assert!(
        err.contains("invalid unit"),
        "the golden BadCase class: {err}"
    );
}

/// Differential against the resolver itself: seeds whose first draw has variance 85 (or 100) and
/// hits; `resolve_attack` on that state leaves the target at the forecast trace's `hp_after`,
/// emits `StoodGround` exactly when the trace stood, and `StatusApplied` exactly when the panel
/// would show a status that the roll does not KO away.
///
/// WRONG IMPL KILLED: a forecast whose min is not what an 85-roll actually does (or max a
/// 100-roll); First-Stand predicted on the wrong trace; status_blocked not matching the
/// resolver's preconditions (an existing status).
#[test]
fn bt11_forecast_vs_resolve_attack() {
    let chart = content_chart();
    let skill = lance(11, Affinity::Fire, 70, 100, Some(StatusKind::Burn));
    let mut cases = 0;
    let mut seen_stood = false;
    let mut seen_applied = false;
    let mut seen_ko = false;
    for &(cur_hp, first_stand, status) in &[
        (300_u16, false, None),
        (300, false, Some(StatusEffect::Poison)),
        (5, true, None),
        (5, false, None),
    ] {
        let mut target = fighter(2, Side::B, 1, Affinity::Plant);
        target.cur_hp = cur_hp;
        target.first_stand = first_stand;
        target.status = status;
        let (attacker, base) = duel(&skill, &target);
        let f =
            super::forecast_of(&chart, &T, &attacker, &target, &skill, false).expect("valid units");
        for variance in [85_u8, 100] {
            let mut st = base.clone();
            st.seed = seed_with_variance(&base, variance);
            let outcome = resolve_attack(&mut st, 1, 11, target.pos, &chart, &T)
                .expect("a valid adjacent attack");
            let (trace, kills) = if variance == 85 {
                (&f.min, f.kills_min)
            } else {
                (&f.max, f.kills_max)
            };
            let label =
                format!("hp {cur_hp} first_stand {first_stand} status {status:?} v{variance}");
            assert!(trace.hit, "{label}: accuracy 100 always hits");
            assert_eq!(
                st.unit(2).map(|u| u.cur_hp),
                Some(trace.hp_after),
                "{label}: the resolver leaves the forecast hp_after"
            );
            let stood = outcome
                .events
                .iter()
                .any(|e| matches!(e, TacticalEvent::StoodGround { unit: 2 }));
            assert_eq!(stood, trace.stood_ground, "{label}: StoodGround");
            let applied = outcome
                .events
                .iter()
                .any(|e| matches!(e, TacticalEvent::StatusApplied { unit: 2, .. }));
            assert_eq!(
                applied,
                f.status.is_some() && !f.status_blocked && !kills,
                "{label}: StatusApplied exactly when shown and not KO'd"
            );
            seen_stood |= stood;
            seen_applied |= applied;
            seen_ko |= kills;
            cases += 1;
        }
    }
    assert_eq!(cases, 8, "ANTI-VACUITY: four targets at both variances");
    assert!(
        seen_stood && seen_applied && seen_ko,
        "ANTI-VACUITY: a save, an applied status and a KO were all exercised"
    );
}

/// `hit_pct` counts `r in 0..100` with `roll < accuracy` (combat/damage.rs:97-99).
///
/// WRONG IMPL KILLED: `hit_pct = accuracy` (101 / 200 / 255 overflow the percent); `<=` (91 for
/// accuracy 90, 1 for 0); counting `0..=100`.
#[test]
fn bt11_hit_pct_table() {
    let chart = content_chart();
    let target = fighter(2, Side::B, 1, Affinity::Plant);
    for &(accuracy, pct) in &[
        (0_u8, 0_u8),
        (1, 1),
        (50, 50),
        (90, 90),
        (99, 99),
        (100, 100),
        (101, 100),
        (200, 100),
        (255, 100),
    ] {
        let skill = lance(7, Affinity::Fire, 70, accuracy, None);
        let mut attacker = fighter(1, Side::A, 0, Affinity::Fire);
        attacker.kit.skills = vec![skill.clone()];
        let f =
            super::forecast_of(&chart, &T, &attacker, &target, &skill, false).expect("valid units");
        assert_eq!(f.hit_pct, pct, "accuracy {accuracy}");
        assert_eq!(
            f.min.hit,
            pct > 0,
            "accuracy {accuracy}: the min trace hits iff any roll does"
        );
    }
}

/// `plan_of` is `spend` per entry on a copy: the per-entry charges, their total (== `plan_cost`),
/// the budget left, Guard from `guard_granted(EndTurn, remaining)`; the first refusal passes
/// through as `plan_cost`'s own error.
///
/// WRONG IMPL KILLED: costs summed in the shell from a table (Exert on the second attack, the
/// tax); a total that is not plan_cost's; `remaining` not the spent copy (strides / attacks /
/// last); a hard-coded guard_on_end; an Err rewritten or clamped to Ok.
#[test]
fn bt11_plan_matches_plan_cost() {
    let mv = |strides: u8, taxed: bool| Entry::Move { strides, taxed };
    let cases: Vec<(TurnBudget, Vec<Entry>)> = vec![
        (
            fresh(),
            vec![mv(1, false), Entry::Attack(Tier::Heavy), Entry::EndTurn],
        ),
        (
            fresh(),
            vec![Entry::Attack(Tier::Light), Entry::Attack(Tier::Light)],
        ),
        (
            fresh(),
            vec![Entry::Attack(Tier::Heavy), Entry::Attack(Tier::Light)],
        ),
        (fresh(), vec![mv(2, true)]),
        (fresh(), vec![mv(1, false), mv(2, false)]),
        (budget(5, 0, 0, None), vec![Entry::Recruit]),
        (fresh(), vec![Entry::Recruit]),
        (fresh(), vec![Entry::Item, Entry::EndTurn]),
        (fresh(), Vec::new()),
        (fresh(), vec![Entry::EndTurn]),
        (
            budget(4, 0, 1, Some(Entry::Attack(Tier::Light))),
            vec![Entry::Attack(Tier::Light), Entry::EndTurn],
        ),
        (fresh(), vec![mv(0, false)]),
        (budget(6, 2, 0, Some(mv(2, false))), vec![mv(1, false)]),
        (budget(2, 0, 0, Some(Entry::Item)), vec![Entry::EndTurn]),
        (budget(1, 0, 0, None), vec![Entry::EndTurn]),
        (budget(6, 0, 0, Some(Entry::Flee)), Vec::new()),
        (fresh(), vec![Entry::Flee]),
        (budget(3, 0, 0, None), vec![mv(1, true)]),
    ];
    let (mut oks, mut errs, mut guards, mut no_guards) = (0, 0, 0, 0);
    for (start, entries) in &cases {
        let got = super::plan_of(start, entries).expect("the content loads");
        match (got, plan_cost(start, entries, &T)) {
            (Ok(p), Ok(total)) => {
                let mut copy = *start;
                let costs: Vec<u8> = entries
                    .iter()
                    .map(|e| spend(&mut copy, *e, &T).expect("an Ok plan spends every entry"))
                    .collect();
                assert_eq!(p.total, total, "{entries:?}: total == plan_cost");
                assert_eq!(p.costs, costs, "{entries:?}: the per-entry charges");
                assert_eq!(p.remaining, copy, "{entries:?}: the spent copy");
                let guard = guard_granted(TurnEndCause::EndTurn, &copy, &T);
                assert_eq!(p.guard_on_end, guard, "{entries:?}: guard_granted(EndTurn)");
                if guard {
                    guards += 1;
                } else {
                    no_guards += 1;
                }
                oks += 1;
            }
            (Err(got), Err(want)) => {
                assert_eq!(got, want, "{entries:?}: plan_cost's own refusal");
                errs += 1;
            }
            (got, want) => panic!("{entries:?}: plan_of {got:?} disagrees with plan_cost {want:?}"),
        }
    }
    assert_eq!(cases.len(), 18, "the pinned case count");
    assert!(
        oks >= 10 && errs >= 5,
        "ANTI-VACUITY: Ok {oks} / Err {errs}"
    );
    assert!(
        guards >= 3 && no_guards >= 3,
        "ANTI-VACUITY: guard {guards} / none {no_guards}"
    );
}

/// reach1 / reach2 are exactly the tiles whose least accepted stride count at the execution gate
/// (`validate_at_pop`, `Move{tile, s}`, the query's budget substituted) is 1 / 2 (plan A2 + A3) —
/// on open, enemy-taxed, water (Swim and Walk) and rough maps, under six budgets.
///
/// WRONG IMPL KILLED: Manhattan reach (the enemy at (4,3) forces a detour); stride points from
/// the levelled speed; the tax ignored (ap 4 / ap 5 taxed rows); the unit's own row budget used
/// instead of the query's; reach2 that ignores `strides_used`; occupied tiles or the own tile
/// listed; Swim treated as Walk on water.
#[test]
fn bt11_reach_matches_validate_at_pop() {
    let l = live();
    let boards: Vec<(BoardIn, u32)> = vec![
        (
            board(
                1,
                vec![
                    row(1, Side::A, 0, 1, 3, 3),
                    row(2, Side::A, 1, 3, 3, 2),
                    fainted(row(12, Side::B, 1, 1, 2, 3)),
                    row(11, Side::B, 0, 3, 0, 6),
                ],
            ),
            1,
        ),
        (
            board(
                1,
                vec![row(1, Side::A, 0, 1, 3, 3), row(11, Side::B, 0, 1, 4, 3)],
            ),
            1,
        ),
        (
            board(
                2,
                vec![row(1, Side::A, 0, 2, 3, 2), row(11, Side::B, 0, 3, 3, 6)],
            ),
            1,
        ),
        (
            board(
                2,
                vec![row(1, Side::A, 0, 3, 3, 2), row(11, Side::B, 0, 3, 3, 6)],
            ),
            1,
        ),
        (
            board(
                3,
                vec![
                    row(1, Side::A, 0, 4, 1, 1),
                    row(2, Side::A, 1, 1, 3, 1),
                    row(11, Side::B, 0, 3, 3, 5),
                ],
            ),
            2,
        ),
        (
            board(
                5,
                vec![row(1, Side::A, 0, 2, 3, 1), row(11, Side::B, 0, 1, 4, 6)],
            ),
            1,
        ),
    ];
    let mv1 = Entry::Move {
        strides: 1,
        taxed: false,
    };
    let budgets = [
        fresh(),
        budget(2, 0, 0, None),
        budget(4, 0, 0, None),
        budget(5, 0, 0, None),
        budget(6, 1, 0, Some(mv1)),
        budget(0, 0, 0, None),
    ];
    let (mut r1_seen, mut r2_seen, mut r2_cut) = (0, 0, 0);
    for (b, sel) in &boards {
        let st = state_for(&l, b);
        for basis in budgets {
            let (want1, want2) = reach_oracle(&st, *sel, basis);
            let q = query(Side::A, Some(*sel), basis);
            let out = super::overlays_of(b, &q).expect("a valid board and selection");
            let label = format!("map {} unit {sel} budget {basis:?}", b.map_id);
            assert_eq!(out.reach1, want1, "{label}: reach1");
            assert_eq!(out.reach2, want2, "{label}: reach2");
            r1_seen += usize::from(!want1.is_empty());
            r2_seen += usize::from(!want2.is_empty());
            r2_cut += usize::from(!want1.is_empty() && want2.is_empty());
        }
    }
    assert!(
        r1_seen >= 12 && r2_seen >= 6 && r2_cut >= 6,
        "ANTI-VACUITY: reach1 {r1_seen}, reach2 {r2_seen}, reach1-without-reach2 {r2_cut}"
    );
}

/// `state_of` is field by field (A6): Fainted and Recruited units and a wiped side load (never
/// `TacticalState::new`), the units joined and sorted `(side, slot)`, `kind` from the board,
/// seed / action_seq 0, round 1; a permuted row order changes nothing; duplicate ids, an unknown
/// map and an unknown species are refused by id.
///
/// WRONG IMPL KILLED: `TacticalState::new` (refuses the fainted / wiped board); the input row
/// order kept; kind hard-coded Wild; round 0; a duplicate id silently deduplicated; an unknown map
/// defaulted.
#[test]
fn bt11_state_of_field_by_field() {
    let l = live();
    let mut lead = row(1, Side::A, 0, 1, 1, 1);
    lead.status = Some(StatusEffect::Sleep { turns_remaining: 2 });
    lead.budget = budget(3, 1, 1, Some(Entry::Attack(Tier::Light)));
    lead.guard = true;
    lead.first_stand = true;
    let mut recruited = row(3, Side::A, 2, 2, 5, 1);
    recruited.state = UnitState::Recruited;
    recruited.cur_hp = 50;
    let wiped = BoardIn {
        kind: BattleKind::Pvp,
        map_id: 4,
        units: vec![
            fainted(row(5, Side::B, 1, 3, 6, 6)),
            fainted(row(4, Side::B, 0, 1, 2, 6)),
            recruited,
            lead,
            fainted(row(2, Side::A, 1, 4, 3, 1)),
        ],
    };
    let got = super::state_of(&wiped).expect("fainted, recruited and a wiped side still load");
    assert_eq!(
        got.units.iter().map(|u| u.id).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5],
        "sorted (side, slot)"
    );
    assert_eq!(got.kind, BattleKind::Pvp, "kind from the board");
    assert_eq!(
        (got.seed, got.action_seq, got.round),
        (0, 0, 1),
        "seed-free, round 1"
    );
    assert_eq!(
        got,
        state_for(&l, &wiped),
        "the whole state, field by field"
    );

    // A wild row (stance + wild_index, A7) joins like any other.
    let mut wild = row(12, Side::B, 1, 42, 1, 5);
    wild.stance = Some(Stance::Skittish);
    wild.wild_index = Some(0);
    let normal = board(
        1,
        vec![
            row(1, Side::A, 0, 1, 3, 3),
            row(2, Side::A, 1, 3, 3, 2),
            row(11, Side::B, 0, 3, 4, 3),
            wild,
        ],
    );
    assert_eq!(
        super::state_of(&normal),
        Ok(state_for(&l, &normal)),
        "a board with a wild row, field by field"
    );
    let mut permuted = normal.clone();
    permuted.units.reverse();
    let q = OverlayQuery {
        viewer: Side::A,
        selected: Some(1),
        skill_id: Some(2),
        aim: Some(Cell { x: 4, y: 3 }),
        budget: fresh(),
    };
    let a = super::overlays_of(&normal, &q).expect("a valid board");
    assert_eq!(
        super::overlays_of(&permuted, &q),
        Ok(a),
        "a permuted row order gives the identical OverlaysOut"
    );
    assert_eq!(
        super::state_of(&permuted),
        super::state_of(&normal),
        "and the identical state"
    );

    let dup = board(
        1,
        vec![
            row(7777, Side::A, 0, 1, 1, 1),
            row(7777, Side::B, 0, 1, 5, 5),
        ],
    );
    let err = super::state_of(&dup).expect_err("duplicate ids are refused");
    assert!(
        err.contains("7777"),
        "the error names the duplicate id: {err}"
    );
    let err = super::overlays_of(&dup, &query(Side::A, None, fresh()))
        .expect_err("overlays refuse duplicate ids too");
    assert!(
        err.contains("7777"),
        "the error names the duplicate id: {err}"
    );
    let err = super::state_of(&board(4242, vec![row(1, Side::A, 0, 1, 1, 1)]))
        .expect_err("an unknown map is refused");
    assert!(err.contains("4242"), "the error names the map: {err}");
    let err = super::state_of(&board(1, vec![row(1, Side::A, 0, 9999, 1, 1)]))
        .expect_err("an unknown species is refused");
    assert!(err.contains("9999"), "the error names the species: {err}");
}

/// Every tile list of `OverlaysOut` is strictly row-major `(y, x)` ascending — sorted AND
/// de-duplicated (A9) — over several boards and queries.
///
/// WRONG IMPL KILLED: lists in path-discovery or unit order; x-major order; a danger union
/// concatenated per skill without de-duplication; HashSet iteration order.
#[test]
fn bt11_outputs_sorted() {
    let b1 = board(
        1,
        vec![
            row(1, Side::A, 0, 1, 3, 3),
            row(2, Side::A, 1, 42, 1, 1),
            row(11, Side::B, 0, 3, 3, 5),
            row(12, Side::B, 1, 1, 4, 3),
            row(13, Side::B, 2, 42, 5, 1),
        ],
    );
    let b5 = board(
        5,
        vec![
            row(1, Side::A, 0, 2, 3, 1),
            row(2, Side::A, 1, 3, 5, 2),
            row(11, Side::B, 0, 1, 4, 6),
            row(12, Side::B, 1, 2, 2, 6),
        ],
    );
    let queries = [
        (
            &b1,
            OverlayQuery {
                viewer: Side::A,
                selected: Some(1),
                skill_id: Some(2),
                aim: Some(Cell { x: 4, y: 3 }),
                budget: fresh(),
            },
        ),
        (
            &b1,
            OverlayQuery {
                viewer: Side::A,
                selected: Some(2),
                skill_id: Some(42),
                aim: Some(Cell { x: 1, y: 1 }),
                budget: fresh(),
            },
        ),
        (
            &b1,
            OverlayQuery {
                viewer: Side::B,
                selected: Some(11),
                skill_id: Some(6),
                aim: Some(Cell { x: 3, y: 3 }),
                budget: fresh(),
            },
        ),
        (
            &b5,
            OverlayQuery {
                viewer: Side::A,
                selected: Some(1),
                skill_id: Some(6),
                aim: Some(Cell { x: 4, y: 6 }),
                budget: fresh(),
            },
        ),
        (&b5, query(Side::B, Some(11), fresh())),
    ];
    let mut long_lists = 0;
    for (i, (b, q)) in queries.iter().enumerate() {
        let out: OverlaysOut = super::overlays_of(b, q).expect("a valid board and query");
        let mut lists: Vec<(&str, &Vec<Cell>)> = vec![
            ("reach1", &out.reach1),
            ("reach2", &out.reach2),
            ("range", &out.range),
            ("aoe", &out.aoe),
            ("shield", &out.shield),
        ];
        for d in &out.danger {
            lists.push(("danger", d));
        }
        for (name, list) in lists {
            assert!(
                strictly_row_major(list),
                "query {i}: {name} is not strictly row-major: {list:?}"
            );
            long_lists += usize::from(list.len() >= 2);
        }
    }
    assert!(
        long_lists >= 15,
        "ANTI-VACUITY: {long_lists} lists had two or more tiles"
    );
}

/// Danger is the A4 probe sweep: one list per CONSCIOUS enemy of the viewer in `(side, slot)`
/// order (a fainted enemy has none, a sleeping one still threatens), and a species-42 enemy (kit
/// 42 = the Caster-origin Burst r1, tactics_skills/000-core.ron:22) threatens the four neighbours
/// of every tile it can stand on — EMPTY tiles included, which an aim-at-a-unit search never
/// finds.
///
/// WRONG IMPL KILLED: "aim must equal a target" (empty neighbours missing); the Burst centred on
/// the aim instead of the standing tile; a fainted enemy given a list (or the list count wrong);
/// a sleeping enemy dropped; the lists in row order instead of `(side, slot)`; `viewer` ignored.
#[test]
fn bt11_danger_probe_burst() {
    let l = live();
    let burst = board(
        1,
        vec![
            row(1, Side::A, 0, 1, 3, 1),
            row(2, Side::A, 1, 3, 0, 0),
            row(13, Side::B, 0, 42, 3, 4),
        ],
    );
    let out = super::overlays_of(&burst, &query(Side::A, None, fresh())).expect("a valid board");
    assert_eq!(out.danger.len(), 1, "one conscious enemy, one list");
    assert_eq!(
        out.danger,
        danger_oracle(&state_for(&l, &burst), Side::A),
        "the probe-sweep danger of the species-42 enemy"
    );
    // Every tile within 2 of the Flyer is a standing tile for Move{1} + the Light Burst (any stride
    // is >= 2, movement.rs:55-61; Fly pays no tax and weight 1, 2 + 2 AP <= 6).
    let at = Cell { x: 3, y: 4 };
    let mut standing_checked = 0;
    for ry in 0..7_u8 {
        for rx in 0..7_u8 {
            let r = Cell { x: rx, y: ry };
            if u16::from(r.x.abs_diff(at.x)) + u16::from(r.y.abs_diff(at.y)) > 2 {
                continue;
            }
            if burst.units.iter().any(|u| u.id != 13 && u.pos == r) {
                continue;
            }
            for n in [
                (i16::from(r.x), i16::from(r.y) - 1),
                (i16::from(r.x) - 1, i16::from(r.y)),
                (i16::from(r.x) + 1, i16::from(r.y)),
                (i16::from(r.x), i16::from(r.y) + 1),
            ] {
                if !(0..7).contains(&n.0) || !(0..7).contains(&n.1) {
                    continue;
                }
                let n = Cell {
                    x: u8::try_from(n.0).expect("in board"),
                    y: u8::try_from(n.1).expect("in board"),
                };
                assert!(
                    out.danger[0].contains(&n),
                    "standing at {r:?} the Burst threatens its neighbour {n:?}"
                );
            }
            standing_checked += 1;
        }
    }
    assert!(
        standing_checked >= 12,
        "ANTI-VACUITY: {standing_checked} standing tiles checked"
    );

    let mut sleeper = row(22, Side::B, 0, 3, 4, 4);
    sleeper.status = Some(StatusEffect::Sleep { turns_remaining: 2 });
    // The fainted B unit sits at (0,0): >= 7 tiles from both living B Walkers (species 3, stride
    // 2: standing <= 4 + range <= 2, or <= 2 + range 3 — at most 6) and >= 12 from both A units
    // (species 1, stride 3: standing <= 6 + range <= 3 — at most 9), so for EITHER viewer its tile
    // is outside every threat zone. A corpse INSIDE a zone: `bt11_danger_probes_a_corpse_tile`.
    let mixed = board(
        4,
        vec![
            row(21, Side::B, 2, 3, 6, 1),
            sleeper,
            fainted(row(23, Side::B, 1, 3, 0, 0)),
            row(1, Side::A, 0, 1, 7, 7),
            row(2, Side::A, 1, 1, 5, 7),
        ],
    );
    let st = state_for(&l, &mixed);
    let out_a = super::overlays_of(&mixed, &query(Side::A, None, fresh())).expect("a valid board");
    assert_eq!(
        out_a.danger.len(),
        2,
        "two conscious enemies (the fainted one has no list)"
    );
    assert_eq!(
        out_a.danger,
        danger_oracle(&st, Side::A),
        "slot 0 (the sleeper) then slot 2, each the probe sweep"
    );
    let out_b = super::overlays_of(&mixed, &query(Side::B, None, fresh())).expect("a valid board");
    assert_eq!(
        out_b.danger,
        danger_oracle(&st, Side::B),
        "viewer B: the A units' danger"
    );
    assert_ne!(
        out_a.danger, out_b.danger,
        "the viewer flips which side is the enemy"
    );
}

/// The forecast's `status_blocked` is the resolver's precondition (resolve.rs:674-675): an
/// existing status or an Immune hit blocks, a clean target takes the status.
///
/// WRONG IMPL KILLED: status_blocked hard-coded false; Immune ignored; only Poison counted as an
/// existing status.
#[test]
fn bt11_status_blocked_matches_resolve() {
    let chart = content_chart();
    let immune = TypeChart::new(&[TypeRelation {
        attacker: Affinity::Fire,
        defender: Affinity::Water,
        effectiveness: 0,
    }]);
    let skill = lance(11, Affinity::Fire, 70, 100, Some(StatusKind::Burn));
    let mut rows = 0;
    for &(affinity, status, use_immune, blocked) in &[
        (Affinity::Plant, None, false, false),
        (Affinity::Plant, Some(StatusEffect::Freeze), false, true),
        (Affinity::Plant, Some(StatusEffect::Paralysis), false, true),
        (Affinity::Water, None, true, true),
    ] {
        let ch = if use_immune { &immune } else { &chart };
        let mut target = fighter(2, Side::B, 1, affinity);
        target.status = status;
        let (attacker, base) = duel(&skill, &target);
        let f = super::forecast_of(ch, &T, &attacker, &target, &skill, false).expect("valid units");
        assert_eq!(
            f.status_blocked, blocked,
            "{affinity:?} {status:?}: status_blocked"
        );
        let mut st = base.clone();
        st.seed = seed_with_variance(&base, 100);
        let outcome = resolve_attack(&mut st, 1, 11, target.pos, ch, &T).expect("a valid attack");
        let applied = outcome
            .events
            .iter()
            .any(|e| matches!(e, TacticalEvent::StatusApplied { unit: 2, .. }));
        assert_eq!(
            applied, !blocked,
            "{affinity:?} {status:?}: the resolver agrees"
        );
        rows += 1;
    }
    assert_eq!(rows, 4, "ANTI-VACUITY: every row ran");
}

// ===========================================================================
// Round 2 — the red-team gaps (each test names the mutant it kills)
// ===========================================================================

/// A Territorial wild is leashed to `spawn_b[wild_index]` (plan A7; ai.rs:78-79), not to the tile
/// it happens to stand on. Species 3 at (0,4) with spawn (1,5): every leash tile is >= 4 from the
/// player at (0,0) — beyond Vine Whip (1..2) and Razor Leaf (2..3) — so it holds; leashed to (0,4)
/// itself it could step to (0,3) and Razor Leaf the player.
///
/// WRONG IMPL KILLED: the spawn taken from the unit's own tile (red-team m18 planned Move + Skill);
/// spawn_a instead of spawn_b; the intent chip planned from a different spawn than `ai_plan_of`.
#[test]
fn bt11_territorial_wild_plans_from_spawn_b() {
    let l = live();
    let mut wild = row(13, Side::B, 0, 3, 0, 4);
    wild.stance = Some(Stance::Territorial);
    wild.wild_index = Some(0);
    let b = board(1, vec![row(1, Side::A, 0, 1, 0, 0), wild]);
    let st = state_for(&l, &b);
    let spawn = l
        .maps
        .iter()
        .find(|m| m.id == 1)
        .expect("map 1")
        .map
        .spawn_b[0];
    assert_eq!(
        spawn,
        Cell { x: 1, y: 5 },
        "map 1 spawn_b[0] (battle_maps/000-core.ron:25)"
    );
    let want = wild_plan(&st, 13, Stance::Territorial, spawn, &T);
    assert_eq!(
        want,
        vec![QueuedAction::EndTurn],
        "leashed to (1,5) nothing is in reach: hold"
    );
    let from_own_tile = wild_plan(&st, 13, Stance::Territorial, Cell { x: 0, y: 4 }, &T);
    assert_ne!(
        from_own_tile, want,
        "ANTI-VACUITY: leashed to its own tile the wild would attack"
    );
    assert_eq!(
        super::ai_plan_of(&b, 13),
        Ok(want.clone()),
        "ai_plan_of plans from spawn_b[wild_index]"
    );
    let out = super::overlays_of(&b, &query(Side::A, None, fresh())).expect("a valid board");
    let intent = out
        .intents
        .iter()
        .find(|i| i.unit == 13)
        .expect("the conscious wild has an intent");
    assert_eq!(
        intent.plan, want,
        "the intent chip plans from spawn_b[wild_index] too"
    );
}

/// A corpse occupies nothing (dead units never block, occupy or get hit: movement.rs:159-163,
/// geometry.rs:185), so the A4 probe stands on a dead unit's tile like on an empty one: the tile of
/// the fainted A unit beside a live melee enemy is threatened.
///
/// WRONG IMPL KILLED: the dead unit taken as the tile's occupant (red-team b2: its id never comes
/// back from `target_set`, so the tile vanished from danger).
#[test]
fn bt11_danger_probes_a_corpse_tile() {
    let l = live();
    let b = board(
        1,
        vec![
            row(1, Side::A, 0, 1, 0, 6),
            fainted(row(2, Side::A, 1, 1, 3, 4)),
            row(11, Side::B, 0, 1, 3, 3),
        ],
    );
    let out = super::overlays_of(&b, &query(Side::A, None, fresh())).expect("a valid board");
    assert_eq!(out.danger.len(), 1, "one conscious enemy, one list");
    assert!(
        out.danger[0].contains(&Cell { x: 3, y: 4 }),
        "the corpse's tile (3,4), beside Fire Fang's reach, is threatened: {:?}",
        out.danger[0]
    );
    assert_eq!(
        out.danger,
        danger_oracle(&state_for(&l, &b), Side::A),
        "the probe-sweep oracle"
    );
}

/// The enemy's Move entries carry the disengage tax of its own tile (plan A4 `Move{s, taxed_e}`):
/// species 3 at (3,4) beside an A unit pays +1 per Move, so Move{2} + a Light (5 + 2) and Move{1}
/// + the Heavy (3 + 4) no longer fit 6 AP — the zone shrinks against the same enemy untaxed.
///
/// WRONG IMPL KILLED: the tax dropped from the feasibility entries (red-team a3: 47 tiles instead
/// of 34); the tax judged at the standing tile instead of the enemy's own tile.
#[test]
fn bt11_danger_charges_the_disengage_tax() {
    let l = live();
    let taxed = board(
        1,
        vec![row(1, Side::A, 0, 1, 3, 3), row(11, Side::B, 0, 3, 3, 4)],
    );
    let free = board(
        1,
        vec![row(1, Side::A, 0, 1, 0, 0), row(11, Side::B, 0, 3, 3, 4)],
    );
    let dt = super::overlays_of(&taxed, &query(Side::A, None, fresh()))
        .expect("a valid board")
        .danger;
    let df = super::overlays_of(&free, &query(Side::A, None, fresh()))
        .expect("a valid board")
        .danger;
    assert_eq!(
        dt,
        danger_oracle(&state_for(&l, &taxed), Side::A),
        "taxed: the probe-sweep oracle"
    );
    assert_eq!(
        df,
        danger_oracle(&state_for(&l, &free), Side::A),
        "untaxed: the probe-sweep oracle"
    );
    assert!(
        dt[0].len() < df[0].len(),
        "the tax shrinks the zone: {} taxed vs {} untaxed",
        dt[0].len(),
        df[0].len()
    );
}

/// The enemy's own tile is a standing tile (`s = 0`, plan A4): boxed in by two A units it cannot
/// move at all, yet it still threatens from where it stands.
///
/// WRONG IMPL KILLED: standing tiles drawn only from Move destinations (red-team c2: 0 tiles).
#[test]
fn bt11_danger_keeps_the_standing_tile() {
    let l = live();
    let boxed = board(
        1,
        vec![
            row(1, Side::A, 0, 1, 1, 0),
            row(2, Side::A, 1, 1, 0, 1),
            row(11, Side::B, 0, 1, 0, 0),
        ],
    );
    let out = super::overlays_of(&boxed, &query(Side::A, None, fresh())).expect("a valid board");
    assert_eq!(out.danger.len(), 1, "one conscious enemy, one list");
    assert!(
        out.danger[0].contains(&Cell { x: 1, y: 0 })
            && out.danger[0].contains(&Cell { x: 0, y: 1 }),
        "Fire Fang from (0,0) threatens both boxing units: {:?}",
        out.danger[0]
    );
    assert_eq!(
        out.danger,
        danger_oracle(&state_for(&l, &boxed), Side::A),
        "the probe-sweep oracle"
    );
}

/// STAB over all 64 (attacker affinity x skill affinity) pairs, against the carried pipeline: on an
/// all-Neutral chart the attacker's affinity enters `calc_damage` ONLY through the STAB term
/// (combat/damage.rs:69-73), so `stab` holds exactly when the attacker's d0 beats the same
/// attacker's d0 with an affinity that does not match the skill.
///
/// WRONG IMPL KILLED: stab hard-coded; stab from the target's affinity; stab from the attacker's
/// species instead of its kit affinity; the comparison inverted.
#[test]
fn bt11_stab_matches_the_pipeline() {
    const ALL: [Affinity; 8] = [
        Affinity::Fire,
        Affinity::Water,
        Affinity::Plant,
        Affinity::Electric,
        Affinity::Earth,
        Affinity::Wind,
        Affinity::Light,
        Affinity::Dark,
    ];
    let neutral = TypeChart::new(&[]);
    let rolls = RollPair {
        accuracy: 0,
        variance: 100,
    };
    let mut stabs = 0;
    let mut pairs = 0;
    for attacker_affinity in ALL {
        for skill_affinity in ALL {
            let skill = lance(7, skill_affinity, 70, 100, None);
            let mut attacker = fighter(1, Side::A, 0, attacker_affinity);
            attacker.kit.skills = vec![skill.clone()];
            let target = fighter(2, Side::B, 1, Affinity::Earth);
            let f = super::forecast_of(&neutral, &T, &attacker, &target, &skill, false)
                .expect("valid units");
            let mut other = attacker.clone();
            other.kit.affinity = if skill_affinity == Affinity::Fire {
                Affinity::Water
            } else {
                Affinity::Fire
            };
            let d0 = damage_pipeline(&attacker, &target, &skill, &neutral, false, rolls, &T).d0;
            let off = damage_pipeline(&other, &target, &skill, &neutral, false, rolls, &T).d0;
            let label = format!("attacker {attacker_affinity:?}, skill {skill_affinity:?}");
            assert_eq!(
                f.stab,
                d0 > off,
                "{label}: stab == the pipeline's STAB bonus"
            );
            assert_eq!(
                f.stab,
                attacker_affinity == skill_affinity,
                "{label}: stab == same affinity"
            );
            stabs += usize::from(f.stab);
            pairs += 1;
        }
    }
    assert_eq!(
        (pairs, stabs),
        (64, 8),
        "64 pairs, the 8 matching ones STAB"
    );
}

/// `forecast_of` reads the tuning it is GIVEN (A8 / the factors so no label restates a constant):
/// flank 7/3 and Guard 2/5 come back as the factors and shape both traces; a tuning no rule can run
/// on is refused (`TacticsTuning::validate`, plan §4.1), never divided by.
///
/// The danger half of the red-team's c1 (EndTurn dropped from the feasibility entries) is NOT
/// testable here: `overlays_of` reads the loaded tuning, whose `end_turn_cost` is 0 (DESIGN), so the
/// mutant is equivalent under every reachable tuning.
///
/// WRONG IMPL KILLED: the factors restated as 5/4 and 3/4 (red-team d10); the content tuning used
/// instead of the parameter; a zero denominator accepted (red-team d16).
#[test]
fn bt11_forecast_reads_the_given_tuning() {
    let chart = content_chart();
    let custom = TacticsTuning {
        end_turn_cost: 5,
        flank_num: 7,
        flank_den: 3,
        guard_num: 2,
        guard_den: 5,
        ..T
    };
    let skill = lance(7, Affinity::Fire, 70, 100, None);
    let mut attacker = fighter(1, Side::A, 0, Affinity::Fire);
    attacker.kit.skills = vec![skill.clone()];
    let mut target = fighter(2, Side::B, 1, Affinity::Plant);
    target.guard = true;
    let f = super::forecast_of(&chart, &custom, &attacker, &target, &skill, true)
        .expect("valid units and a usable tuning");
    assert_eq!(f.flank_factor, (7, 3), "the given flank factor");
    assert_eq!(f.guard_factor, (2, 5), "the given Guard factor");
    for (trace, variance) in [(&f.min, 85_u8), (&f.max, 100)] {
        let want = damage_pipeline(
            &attacker,
            &target,
            &skill,
            &chart,
            true,
            RollPair {
                accuracy: 0,
                variance,
            },
            &custom,
        );
        assert_eq!(
            *trace, want,
            "variance {variance}: the pipeline at the given tuning"
        );
    }

    let mut unguarded = target.clone();
    unguarded.guard = false;
    for (name, bad) in [
        ("ZeroGuardDen", TacticsTuning { guard_den: 0, ..T }),
        ("ZeroFlankDen", TacticsTuning { flank_den: 0, ..T }),
    ] {
        let err = super::forecast_of(&chart, &bad, &attacker, &unguarded, &skill, false)
            .expect_err("an unusable tuning is refused, never divided by");
        assert!(
            err.contains(name) || err.to_lowercase().contains("tuning"),
            "{name}: the error names the tuning: {err}"
        );
    }
}

/// The two plain passthroughs agree with game-core (the desync guard): `recruit_odds_of` with
/// `recruit::recruit_odds` over a sweep (Ok and Err rows, max 0, hp over max), and the
/// `tactics_is_exhausted` export with `ai::is_exhausted` on both sides of its boundaries.
///
/// WRONG IMPL KILLED: odds restated in the shell (quantized differently, the bait line uncapped);
/// the bait cap clamped; an Exhausted rule with `<=` or u16 overflow.
#[test]
fn bt11_recruit_and_exhausted_match_game_core() {
    assert_eq!(
        super::recruit_odds_of(100, 20, 150),
        Ok(RecruitOdds {
            pct: 63,
            base: 8,
            bait: 15,
            weakened: 40
        }),
        "the design example (recruit.rs:58)"
    );
    let mut rows = 0;
    for &(max_hp, hp) in &[
        (100_u16, 20_u16),
        (100, 100),
        (100, 1),
        (1, 1),
        (7, 3),
        (255, 254),
        (1000, 250),
        (65_535, 1),
        (0, 0),
        (50, 80),
    ] {
        for &bait in &[0_u16, 150, 1000, 1001] {
            assert_eq!(
                super::recruit_odds_of(max_hp, hp, bait),
                recruit_odds(max_hp, hp, bait),
                "recruit_odds({max_hp}, {hp}, {bait})"
            );
            rows += 1;
        }
    }
    assert_eq!(rows, 40, "ANTI-VACUITY: the whole sweep ran");
    for &(cur, max) in &[
        (24_u16, 100_u16),
        (25, 100),
        (0, 1),
        (1, 0),
        (0, 0),
        (1, 4),
        (1, 5),
        (16_383, 65_535),
        (16_384, 65_535),
        (65_535, 65_535),
    ] {
        assert_eq!(
            super::tactics_is_exhausted(cur, max),
            is_exhausted(cur, max),
            "is_exhausted({cur}, {max})"
        );
    }
}

/// Plan A20: `state_of` refuses a duplicate `(side, slot)` (the sort key) and a real unit carrying
/// the probe id `u32::MAX`, naming them; a CONSCIOUS selection standing off the map is refused by
/// `overlays_of` (the tax predicate's OutOfBounds, A10), naming the unit, while a DEAD one off the
/// map still yields empty selection sets.
///
/// WRONG IMPL KILLED: a duplicate slot accepted (the order then depends on the input); a real unit
/// mistaken for the probe (its tile hit by every sweep); an off-board selection answered with sets
/// (or a dead one thrown).
#[test]
fn bt11_state_of_refusals_a20() {
    // Unit 7 and unit 63 share (A, slot 7): a message naming the slot or the ids both say 7.
    let same_slot = board(
        1,
        vec![
            row(7, Side::A, 7, 1, 1, 1),
            row(63, Side::A, 7, 3, 2, 1),
            row(11, Side::B, 0, 1, 5, 5),
        ],
    );
    let err = super::state_of(&same_slot).expect_err("a duplicate (side, slot) is refused");
    assert!(err.contains('7'), "the error names the slot / ids: {err}");
    let err = super::overlays_of(&same_slot, &query(Side::A, None, fresh()))
        .expect_err("overlays refuse it too");
    assert!(err.contains('7'), "the error names the slot / ids: {err}");

    let probe_id = board(
        1,
        vec![
            row(u32::MAX, Side::A, 0, 1, 1, 1),
            row(11, Side::B, 0, 1, 5, 5),
        ],
    );
    let err = super::state_of(&probe_id).expect_err("a real unit with the probe id is refused");
    assert!(err.contains("4294967295"), "the error names the id: {err}");

    let off_board = board(
        1,
        vec![row(8181, Side::A, 0, 1, 9, 9), row(11, Side::B, 0, 1, 5, 5)],
    );
    let err = super::overlays_of(&off_board, &query(Side::A, Some(8181), fresh()))
        .expect_err("a conscious selection off the map is refused");
    assert!(err.contains("8181"), "the error names the unit: {err}");

    let dead_off_board = board(
        1,
        vec![
            fainted(row(8181, Side::A, 0, 1, 9, 9)),
            row(11, Side::B, 0, 1, 5, 5),
        ],
    );
    let q = OverlayQuery {
        viewer: Side::A,
        selected: Some(8181),
        skill_id: Some(1),
        aim: Some(Cell { x: 5, y: 5 }),
        budget: fresh(),
    };
    let out = super::overlays_of(&dead_off_board, &q).expect("a dead selection is data");
    assert!(
        out.reach1.is_empty()
            && out.reach2.is_empty()
            && out.range.is_empty()
            && out.aoe.is_empty()
            && out.shield.is_empty(),
        "a dead selection: every selection set empty, got {out:?}"
    );
}
