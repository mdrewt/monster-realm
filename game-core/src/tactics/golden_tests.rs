//! bt-1 gating tests — BT1.9 (`tactics::golden`): the native half of the native = wasm
//! byte-identity harness — plus bt-2's BT2.5 additions (the roll stream, economy, Surge, status
//! tick, initiative, priority, pipeline and adjudication kinds join the same fixture).
//!
//! The fixture `game-core/tests/fixtures/tactics_golden.json` is `{"cases": [...], "expected":
//! [...]}` (serde EXTERNALLY tagged, plan A10). Every `expected` entry was hand-derived from the
//! contracts (never captured from the implementation). The vitest
//! `client/src/tactics/golden.parity.test.ts` reads the SAME file and runs it through the
//! `tactics_golden` wasm export; both halves compare the CANONICAL form (compact JSON with
//! object keys sorted recursively, plan A1) so a key-order or number-format drift is caught.
//!
//! Names start `bt1_9_` (BT1.9) or end `_bt2_5` (BT2.5) — the acceptance ledgers' CHECKs filter
//! on those tags.
//!
//! # How the bt-2 expected values were derived
//!
//! Rolls: the stream is `splitmix64(seed ^ seq)`. The known outputs used are `splitmix64(0)` =
//! 0xE220_A839_7B1D_CDAF (`tick_seed(0, 0, 0)`), `splitmix64(1)` = 0x910A_2DEC_8902_5CC1 (worked
//! by hand through the three mix steps, and the published seed-1 first output), `splitmix64(6)`
//! = 0xBD64_A5D9_ADEF_E000 (`tick_seed(1, 2, 3)`) and `splitmix64(0x1_8B9E_F457)` =
//! 0x3FDF_67C5_BA9F_477A (`tick_seed(0xDEAD_BEEF, 0x1234_5678, 0x9ABC_DEF0)`). Their residues,
//! by summing hex digits against 16^k mod 100 (1, 16, 56, 96, 36, 76, then 16, 56, … repeating):
//!
//! ```text
//! splitmix64(0)  mod 100 = 35   mod 16 = 15   low bit 1
//! splitmix64(1)  mod 100 = 65   mod 16 = 1    low bit 1
//! splitmix64(6)  mod 100 = 92   mod 16 = 0    low bit 0
//! splitmix64(0x1_8B9E_F457)     low bit 0
//! ```
//!
//! So `Rolls { seed 0, seq 0 }` draws x = 0 then x = 1 → (35, 85 + 1 = 86); `{ seed 2, seq 2 }`
//! draws 2^2 = 0 then 2^3 = 1 → (35, 86) again (an additive `seed + seq` would not); `{ seed 7,
//! seq 6 }` draws 7^6 = 1 then 7^7 = 0 → (65, 85 + 15 = 100).
//!
//! `Rolls { seed 5, seq 9, draws 3 }` draws x = 5^9, 5^10, …, 5^14 = 12, 15, 14, 9, 8, 11. For
//! a small x the first step is linear: x + γ differs from γ = 0x9E37_79B9_7F4A_7C15 only in its
//! low byte, so after `^ (>> 30)` the state is v(0) + b with b = (0x15 + x) ^ 0xE5, and the first
//! product is w(x) = w(0) + (b − 0xF0)·C1, w(0) = 0x6F68_261B_57E7_A770 (the x = 0 step that
//! reproduces 0xE220_A839_7B1D_CDAF, and x = 1 the 0x910A… value). Worked by hand from there:
//!
//! ```text
//! x  b     w(x)                    splitmix64(x)            used
//! 12 0xC4  0x8C3B_DF5A_6090_2BA4   0x943F_F9FC_99DE_8F03    mod 100 = 23
//! 15 0xC1  0x4E33_0913_09E1_7A79   …… low nibble 5          mod 16  = 5  → 90
//! 14 0xC6  0x0AEC_6E34_9A59_F716   0x6AA9_D614_35DB_E63E    mod 100 = 38
//!  9 0xFB  0xA833_37CB_95BD_8663   …… low nibble 4          mod 16  = 4  → 89
//!  8 0xF8  0x6A2A_6184_3F0E_D538   0x9E56_51B0_EF95_3636    mod 100 = 22
//! 11 0xC5  0x4B94_26C7_7D75_115D   …… low nibble 13         mod 16  = 13 → 98
//! ```
//!
//! (for the three variance draws only z mod 2^35 of the second product is needed: the output's
//! low nibble is z's bits 0..3 XOR bits 31..34) → `[(23, 90), (38, 89), (22, 98)]`.
//!
//! Priority seeds 24 301 (0x5EED),
//! 24 300 (0x5EEC) and 24 299 (0x5EEB) salt to x = 0, 1 and 6 (B, B, A); 6 637 398 714
//! (0x1_8B9E_AABA) salts to 0x1_8B9E_F457 (A). Adjudication coins use seed ^ round = 0, 6, 1
//! and 0x1_8B9E_F457 (seed 6 637 417 560, round 15).
//!
//! Pipeline (carried `calc_damage`, weather None; `base = (2·L/5 + 2)·P·A/D/50 + 2`):
//!
//! ```text
//! Water L5 A40 → Wind D40, Fire P40, v100: base 5, no STAB, ×10/10 = 5;
//!     flank 25/4 = 6, Guard 18/4 = 4 (Guard first: 15/4 = 3, 15/4 = 3)
//! Fire L5 A40 → Plant D40, Fire P40, v100: base 5, STAB 7, ×20/10 = 14; flank 70/4 = 17,
//!     Guard 51/4 = 12; at v85: 14·85/100 = 11
//! Water L5 A10 → Water D100, Fire P20, v85: base 2, ×5/10 = 1, ×85/100 = 0 → floor 1;
//!     flank 5/4 = 1, Guard max(1, 3/4) = 1
//! Fire L50 A120 → Earth D80, Fire P75, v92: 22·75·120/80/50 = 49, base 51, STAB 76,
//!     ×5/10 = 38, ×92/100 = 34; flank 170/4 = 42
//! First-Stand: d3 ≥ hp saves at 1 HP and applies hp − 1 (14 into 14 → 13; 12 into 12 → 11);
//!     d3 14 into 15 HP is an ordinary hit to 1 (applied 14, no save)
//! ```
//!
//! An invalid Pipeline unit is `BadCase("invalid unit: {DeployError:?}")`, the attacker
//! validated before the target.

use serde_json::Value;

use crate::combat::types::{Effectiveness, StatusEffect};

use super::economy::{EconomyError, Entry, Tier, TurnBudget};
use super::geometry::{BoardUnit, Cell, FfFilter, Origin, Shape, Side, SkillGeometry};
use super::golden::{run_golden, GoldenBoard, GoldenCase, GoldenResult};
use super::initiative::Contender;
use super::movement::{MoveClass, Path, PathError, Terrain};
use super::outcome::{Adjudication, StepSnapshot};
use super::resolve::{PipelineTrace, RollPair, TacticalUnit};
use super::resolve_tests as rt;
use super::tuning::BattleKind;

const FIXTURE: &str = include_str!("../../tests/fixtures/tactics_golden.json");

/// The pinned size of the fixture. Growing it (BT2.5, BT4.8, BT11.7 join the harness) is a
/// deliberate edit here AND in the vitest.
const CASE_COUNT: usize = 304;
/// Cases that must come back `BadCase`: a malformed board (no rows / too large / ragged / bad
/// glyph) or, since bt-2, a Pipeline unit that fails `validate_unit`.
const BAD_CASE_COUNT: usize = 17;

/// Every `GoldenCase` kind. Each must appear in the fixture at least once.
const KINDS: [&str; 18] = [
    "Distance",
    "Adjacent",
    "TargetSet",
    "Flank",
    "Los",
    "Stride",
    "Weight",
    "Path",
    "Disengage",
    "Rolls",
    "Economy",
    "SurgeDamage",
    "StatusTick",
    "Initiative",
    "Priority",
    "Pipeline",
    "Adjudicate",
    "AiPlan",
];

/// The kinds bt-2 added (BT2.5).
const BT2_KINDS: [&str; 8] = [
    "Rolls",
    "Economy",
    "SurgeDamage",
    "StatusTick",
    "Initiative",
    "Priority",
    "Pipeline",
    "Adjudicate",
];

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("fixture is valid JSON")
}

fn fixture_cases(fx: &Value) -> Vec<GoldenCase> {
    serde_json::from_value(fx["cases"].clone()).expect("every fixture case deserializes")
}

fn expected_array(fx: &Value) -> &Vec<Value> {
    fx["expected"].as_array().expect("expected is an array")
}

fn cases_array(fx: &Value) -> &Vec<Value> {
    fx["cases"].as_array().expect("cases is an array")
}

/// Compact JSON with object keys sorted recursively (the byte-identity form, plan A1).
fn canon(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("key serializes"),
                        canon(&m[k.as_str()])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canon).collect::<Vec<_>>().join(",")),
        other => serde_json::to_string(other).expect("scalar serializes"),
    }
}

/// The single external tag of a `{"Kind": ...}` value.
fn kind_of(v: &Value) -> String {
    let m = v.as_object().expect("externally tagged object");
    assert_eq!(m.len(), 1, "exactly one tag: {v}");
    m.keys().next().expect("one key").clone()
}

fn run_fixture() -> Vec<Value> {
    let fx = fixture();
    let results = run_golden(&fixture_cases(&fx));
    serde_json::to_value(&results)
        .expect("results serialize")
        .as_array()
        .expect("results serialize to an array")
        .clone()
}

// ===========================================================================
// BT1.9 — the fixture
// ===========================================================================

#[test]
fn bt1_9_run_golden_reproduces_the_expected_fixture_in_canonical_form() {
    let fx = fixture();
    let cases = cases_array(&fx);
    let expected = expected_array(&fx);
    let got = run_fixture();
    assert_eq!(got.len(), expected.len(), "one result per case");
    for (i, (g, e)) in got.iter().zip(expected).enumerate() {
        assert_eq!(canon(g), canon(e), "case #{i}: {}", canon(&cases[i]));
    }
    // And the whole document at once — the exact string the wasm half compares.
    assert_eq!(canon(&Value::Array(got)), canon(&fx["expected"]));
}

#[test]
fn bt1_9_fixture_size_is_pinned() {
    let fx = fixture();
    assert_eq!(cases_array(&fx).len(), CASE_COUNT);
    assert_eq!(expected_array(&fx).len(), CASE_COUNT);
    assert_eq!(fixture_cases(&fx).len(), CASE_COUNT);
    assert_eq!(
        run_golden(&fixture_cases(&fx)).len(),
        CASE_COUNT,
        "one result per case"
    );
}

#[test]
fn bt1_9_every_case_kind_appears_and_no_unknown_kind_does() {
    let fx = fixture();
    let kinds: Vec<String> = cases_array(&fx).iter().map(kind_of).collect();
    for want in KINDS {
        assert!(
            kinds.iter().any(|k| k == want),
            "fixture has no {want} case (kinds present: {kinds:?})"
        );
    }
    for k in &kinds {
        assert!(KINDS.contains(&k.as_str()), "unknown case kind {k}");
    }
}

#[test]
fn bt1_9_each_result_has_its_cases_kind_in_the_same_order() {
    let fx = fixture();
    let case_kinds: Vec<String> = cases_array(&fx).iter().map(kind_of).collect();
    let got_kinds: Vec<String> = run_fixture().iter().map(kind_of).collect();
    let want_kinds: Vec<String> = expected_array(&fx).iter().map(kind_of).collect();
    assert_eq!(got_kinds.len(), case_kinds.len());
    for (i, ((case, got), want)) in case_kinds
        .iter()
        .zip(&got_kinds)
        .zip(&want_kinds)
        .enumerate()
    {
        assert_eq!(got, want, "result #{i} kind");
        // A result is its case's kind, or BadCase (malformed board) — never another kind.
        assert!(
            got == case || got == "BadCase",
            "result #{i} is {got} for a {case} case"
        );
    }
}

#[test]
fn bt1_9_bad_cases_are_exactly_the_malformed_boards() {
    let fx = fixture();
    let got = run_fixture();
    let case_kinds: Vec<String> = cases_array(&fx).iter().map(kind_of).collect();
    let mut bad = Vec::new();
    for (i, g) in got.iter().enumerate() {
        if kind_of(g) == "BadCase" {
            // Only board-carrying kinds can be malformed — and, since bt-2, a Pipeline case
            // whose unit fails `validate_unit`.
            assert!(
                ["TargetSet", "Los", "Path", "Disengage", "Pipeline"]
                    .contains(&case_kinds[i].as_str()),
                "case #{i} ({}) cannot be malformed",
                case_kinds[i]
            );
            bad.push(
                g["BadCase"]
                    .as_str()
                    .expect("BadCase payload is a string")
                    .to_string(),
            );
        }
    }
    assert_eq!(bad.len(), BAD_CASE_COUNT);
    let mut want: Vec<String> = [
        "empty board",
        "empty board",
        "ragged row 1",
        "ragged row 2",
        "bad terrain 'x' at (1,1)",
        "bad terrain 'q' at (1,0)",
        "bad terrain 'W' at (2,1)",
        "bad terrain ' ' at (0,1)",
        "empty board",
        "board too large",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    want.push(format!("bad terrain '{}' at (1,0)", e_acute()));
    want.push("bad terrain 'x' at (0,0)".to_string());
    want.push("ragged row 1".to_string());
    // bt-2 (BT2.5): Pipeline units failing `validate_unit`, the attacker checked first.
    for text in [
        "invalid unit: Fainted { id: 7 }",
        "invalid unit: HpAboveMax { id: 8, cur_hp: 101, max_hp: 100 }",
        "invalid unit: ZeroDefense { id: 8 }",
        "invalid unit: ZeroDefense { id: 7 }",
    ] {
        want.push(text.to_string());
    }
    assert_eq!(bad, want);
}

/// U+00E9, built from its code point (never a pasted or escaped literal).
fn e_acute() -> char {
    char::from_u32(0xE9).expect("U+00E9 is a scalar value")
}

#[test]
fn bt1_9_fixture_carries_a_row_wider_than_255_columns_that_is_board_too_large() {
    let fx = fixture();
    let cases = cases_array(&fx);
    let expected = expected_array(&fx);
    let wide_idx = cases
        .iter()
        .position(|case| {
            case.as_object()
                .and_then(|m| m.values().next())
                .and_then(|body| body["board"]["rows"][0].as_str())
                .is_some_and(|row| row.chars().count() > 255)
        })
        .expect("the fixture has a first row wider than 255 columns");
    assert_eq!(
        expected[wide_idx],
        serde_json::json!({ "BadCase": "board too large" })
    );
}

#[test]
fn bt1_9_fixture_exercises_both_ok_and_err_branches_of_every_fallible_kind() {
    let fx = fixture();
    let expected = expected_array(&fx);
    for kind in ["TargetSet", "Path", "Disengage"] {
        let mut ok = 0;
        let mut err = 0;
        for e in expected {
            if kind_of(e) == kind {
                if e[kind].get("Ok").is_some() {
                    ok += 1;
                } else if e[kind].get("Err").is_some() {
                    err += 1;
                }
            }
        }
        assert!(ok >= 1 && err >= 1, "{kind}: ok {ok}, err {err}");
    }
    // Weight must exercise both the Some and the None (JSON null) arm.
    let weights: Vec<&Value> = expected
        .iter()
        .filter(|e| kind_of(e) == "Weight")
        .map(|e| &e["Weight"])
        .collect();
    assert_eq!(weights.len(), 16, "the full 4x4 table");
    assert_eq!(weights.iter().filter(|w| w.is_null()).count(), 6);
}

#[test]
fn bt1_9_run_golden_is_pure_and_deterministic() {
    let fx = fixture();
    let cases = fixture_cases(&fx);
    let first = run_golden(&cases);
    assert_eq!(run_golden(&cases), first);
    // The order of results follows the order of cases (reverse the input, reverse the output).
    let mut reversed = cases.clone();
    reversed.reverse();
    let mut want = first;
    want.reverse();
    assert_eq!(run_golden(&reversed), want);
}

#[test]
fn bt1_9_run_golden_of_nothing_is_nothing() {
    assert_eq!(run_golden(&[]), Vec::<GoldenResult>::new());
}

// ===========================================================================
// BT1.9 — run_golden dispatch, independent of the fixture
// ===========================================================================

fn c(x: u8, y: u8) -> Cell {
    Cell { x, y }
}

fn unit(id: u32, side: Side, class: MoveClass, x: u8, y: u8) -> BoardUnit {
    BoardUnit {
        id,
        side,
        pos: c(x, y),
        alive: true,
        class,
    }
}

fn board(rows: &[&str], units: Vec<BoardUnit>) -> GoldenBoard {
    GoldenBoard {
        rows: rows.iter().map(|r| (*r).to_string()).collect(),
        units,
    }
}

#[test]
fn bt1_9_run_golden_dispatches_every_case_kind_to_its_result_kind() {
    let units = vec![
        unit(1, Side::A, MoveClass::Walk, 0, 0),
        unit(2, Side::B, MoveClass::Walk, 1, 0),
    ];
    let b = board(&["...", "...", "..."], units.clone());
    let cases = vec![
        GoldenCase::Distance {
            a: c(0, 0),
            b: c(7, 7),
        },
        GoldenCase::Adjacent {
            a: c(0, 0),
            b: c(0, 1),
        },
        GoldenCase::TargetSet {
            board: b.clone(),
            caster: 1,
            aim: c(1, 0),
            geometry: SkillGeometry {
                range_min: 1,
                range_max: 1,
                origin: Origin::TargetUnit,
                shape: Shape::Single,
                radius: 0,
                ff_filter: FfFilter::Enemies,
            },
        },
        GoldenCase::Flank {
            units: vec![
                unit(1, Side::A, MoveClass::Walk, 1, 0),
                unit(2, Side::A, MoveClass::Walk, 0, 1),
            ],
            attacker: 1,
            target: c(0, 0),
        },
        GoldenCase::Los {
            board: b.clone(),
            from: c(0, 0),
            to: c(2, 2),
        },
        GoldenCase::Stride { base_speed: 50 },
        GoldenCase::Weight {
            class: MoveClass::Swim,
            terrain: Terrain::Water,
        },
        GoldenCase::Path {
            board: b.clone(),
            mover: 1,
            start: c(0, 0),
            dest: c(0, 2),
        },
        GoldenCase::Disengage {
            board: b,
            mover: 1,
            start: c(0, 0),
        },
    ];
    assert_eq!(
        run_golden(&cases),
        vec![
            GoldenResult::Distance(14),
            GoldenResult::Adjacent(true),
            GoldenResult::TargetSet(Ok(vec![2])),
            GoldenResult::Flank(true),
            GoldenResult::Los(true),
            GoldenResult::Stride(3),
            GoldenResult::Weight(Some(1)),
            GoldenResult::Path(Ok(Path {
                steps: vec![c(0, 1), c(0, 2)],
                cost: 2
            })),
            GoldenResult::Disengage(Ok(true)),
        ]
    );
}

#[test]
fn bt1_9_run_golden_surfaces_rule_errors_as_values_not_panics() {
    let b = board(&["..."], vec![unit(1, Side::A, MoveClass::Walk, 0, 0)]);
    assert_eq!(
        run_golden(&[GoldenCase::Path {
            board: b.clone(),
            mover: 9,
            start: c(0, 0),
            dest: c(1, 0)
        }]),
        vec![GoldenResult::Path(Err(PathError::UnknownMover(9)))]
    );
    assert_eq!(
        run_golden(&[GoldenCase::Disengage {
            board: b,
            mover: 9,
            start: c(0, 0)
        }]),
        vec![GoldenResult::Disengage(Err(PathError::UnknownMover(9)))]
    );
}

#[test]
fn bt1_9_malformed_boards_are_golden_errors_with_exact_text() {
    let geometry = SkillGeometry {
        range_min: 0,
        range_max: 0,
        origin: Origin::Caster,
        shape: Shape::Single,
        radius: 0,
        ff_filter: FfFilter::All,
    };
    let bad = |rows: &[&str]| -> Vec<GoldenResult> {
        run_golden(&[
            GoldenCase::Los {
                board: board(rows, vec![]),
                from: c(0, 0),
                to: c(0, 0),
            },
            GoldenCase::TargetSet {
                board: board(rows, vec![]),
                caster: 1,
                aim: c(0, 0),
                geometry,
            },
            GoldenCase::Path {
                board: board(rows, vec![]),
                mover: 1,
                start: c(0, 0),
                dest: c(1, 0),
            },
            GoldenCase::Disengage {
                board: board(rows, vec![]),
                mover: 1,
                start: c(0, 0),
            },
        ])
    };
    let all =
        |text: &str| -> Vec<GoldenResult> { vec![GoldenResult::BadCase(text.to_string()); 4] };
    assert_eq!(bad(&[]), all("empty board"), "no rows");
    assert_eq!(bad(&[""]), all("empty board"), "zero-length first row");
    assert_eq!(
        bad(&["", "."]),
        all("empty board"),
        "zero-length first row beats ragged"
    );
    assert_eq!(bad(&["...", "..", "..."]), all("ragged row 1"));
    assert_eq!(
        bad(&["..", "...", ".."]),
        all("ragged row 1"),
        "first differing row, longer"
    );
    assert_eq!(bad(&["..", "..", "."]), all("ragged row 2"));
    assert_eq!(bad(&["..", ".x"]), all("bad terrain 'x' at (1,1)"));
    assert_eq!(
        bad(&["x.", "y."]),
        all("bad terrain 'x' at (0,0)"),
        "y then x scan order"
    );
    assert_eq!(bad(&["..", "y.", ".x"]), all("bad terrain 'y' at (0,1)"));
    assert_eq!(
        bad(&["..R"]),
        all("bad terrain 'R' at (2,0)"),
        "uppercase is not a glyph"
    );
    // The four legal glyphs are accepted (no BadCase).
    let fine = run_golden(&[GoldenCase::Los {
        board: board(&[".rw#"], vec![]),
        from: c(0, 0),
        to: c(3, 0),
    }]);
    assert_eq!(fine, vec![GoldenResult::Los(true)]);
}

/// The same malformed board through all four board-carrying case kinds.
fn bad_results(rows: &[&str]) -> Vec<GoldenResult> {
    let geometry = SkillGeometry {
        range_min: 0,
        range_max: 0,
        origin: Origin::Caster,
        shape: Shape::Single,
        radius: 0,
        ff_filter: FfFilter::All,
    };
    run_golden(&[
        GoldenCase::Los {
            board: board(rows, vec![]),
            from: c(0, 0),
            to: c(0, 0),
        },
        GoldenCase::TargetSet {
            board: board(rows, vec![]),
            caster: 1,
            aim: c(0, 0),
            geometry,
        },
        GoldenCase::Path {
            board: board(rows, vec![]),
            mover: 1,
            start: c(0, 0),
            dest: c(1, 0),
        },
        GoldenCase::Disengage {
            board: board(rows, vec![]),
            mover: 1,
            start: c(0, 0),
        },
    ])
}

fn all_bad(text: &str) -> Vec<GoldenResult> {
    vec![GoldenResult::BadCase(text.to_string()); 4]
}

#[test]
fn bt1_9_board_size_limit_is_255_columns_by_255_rows() {
    let los = |rows: Vec<String>| {
        let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
        run_golden(&[GoldenCase::Los {
            board: board(&refs, vec![]),
            from: c(0, 0),
            to: c(0, 0),
        }])
    };
    let too_large = vec![GoldenResult::BadCase("board too large".to_string())];
    assert_eq!(los(vec![".".repeat(255)]), vec![GoldenResult::Los(true)]);
    assert_eq!(los(vec![".".repeat(256)]), too_large);
    assert_eq!(
        los(vec![".".to_string(); 255]),
        vec![GoldenResult::Los(true)]
    );
    assert_eq!(los(vec![".".to_string(); 256]), too_large);
}

#[test]
fn bt1_9_bad_case_precedence_empty_then_too_large_then_per_row_ragged_then_glyph() {
    let wide = ".".repeat(256);
    let mut tall = vec!["..."; 256];
    // Too large (any row count > 255) beats raggedness further down.
    tall[1] = "..";
    assert_eq!(bad_results(&tall), all_bad("board too large"));
    // ...but an empty first row is "empty board" even on a 256-row board.
    tall[0] = "";
    assert_eq!(bad_results(&tall), all_bad("empty board"));
    // A first row wider than 255 characters beats a bad glyph on a later row.
    assert_eq!(
        bad_results(&[wide.as_str(), "x"]),
        all_bad("board too large")
    );
    // Per row, in order: row 0's glyph error precedes row 1's raggedness...
    assert_eq!(
        bad_results(&["x..", ".."]),
        all_bad("bad terrain 'x' at (0,0)")
    );
    assert_eq!(
        bad_results(&[".x", "..."]),
        all_bad("bad terrain 'x' at (1,0)")
    );
    // ...and within one row the ragged check precedes its glyph check.
    assert_eq!(bad_results(&["..", "x"]), all_bad("ragged row 1"));
    assert_eq!(bad_results(&["...", ""]), all_bad("ragged row 1"));
    // Row 1's glyph error precedes row 2's raggedness.
    assert_eq!(
        bad_results(&["..", "x.", "."]),
        all_bad("bad terrain 'x' at (0,1)")
    );
}

#[test]
fn bt1_9_bad_case_counts_characters_not_bytes() {
    let e = e_acute();
    let with_e = format!(".{e}.");
    assert_eq!(
        bad_results(&[with_e.as_str()]),
        all_bad(&format!("bad terrain '{e}' at (1,0)"))
    );
    // 130 characters = 260 bytes: by characters this is NOT too large, so the glyph is named.
    let many_e: String = std::iter::repeat_n(e, 130).collect();
    assert_eq!(
        bad_results(&[many_e.as_str()]),
        all_bad(&format!("bad terrain '{e}' at (0,0)"))
    );
    // Row 1 is one character (two bytes) against a two-character row 0: ragged by characters.
    let one_e = e.to_string();
    assert_eq!(
        bad_results(&["..", one_e.as_str()]),
        all_bad("ragged row 1")
    );
}

// ===========================================================================
// BT2.5 — the bt-2 kinds join the harness
// ===========================================================================

/// BT2.5: every bt-2 kind is in the fixture (at least twice) and each of its cases reproduces
/// its hand-derived expected value (module doc) in canonical form — the native half of the
/// "golden vectors pin the order natively and in wasm" clause.
/// Kills: a bt-2 rule left out of the golden join; any drift in a bt-2 kind's answer.
#[test]
fn every_bt2_golden_kind_reproduces_its_hand_derived_fixture_values_bt2_5() {
    let fx = fixture();
    let cases = cases_array(&fx);
    let expected = expected_array(&fx);
    let got = run_fixture();
    assert_eq!(got.len(), cases.len());
    for kind in BT2_KINDS {
        let idx: Vec<usize> = cases
            .iter()
            .enumerate()
            .filter(|(_, case)| kind_of(case) == kind)
            .map(|(i, _)| i)
            .collect();
        assert!(idx.len() >= 2, "{kind}: {} fixture cases", idx.len());
        for i in idx {
            assert_eq!(
                canon(&got[i]),
                canon(&expected[i]),
                "case #{i}: {}",
                canon(&cases[i])
            );
        }
    }
}

/// BT2.5: `run_golden` answers each bt-2 kind with its rule (values hand-derived in the module
/// doc): the seed-0 roll pair (35, 86); Heavy + Light refused with 2 AP left; Surge 5 for 19 HP
/// at round 14; Burn 10 of 160; the tie-rank order; the wild round-2 priority B; the
/// flank-then-Guard trace 5 → 6 → 4; the HP-percent adjudication.
/// Kills: a kind dispatched to the wrong rule; a rule run at a tuning other than the design's.
#[test]
fn run_golden_answers_every_bt2_kind_with_its_rule_bt2_5() {
    let fresh = TurnBudget {
        ap: 6,
        strides_used: 0,
        attacks: 0,
        last: None,
    };
    let mut guarded = rt::wind_target(100);
    guarded.guard = true;
    let tie = |id: u32, side: Side, slot: u8| Contender {
        id,
        side,
        slot,
        eff_speed: 50,
        base_speed: 50,
    };
    assert_eq!(
        run_golden(&[
            GoldenCase::Rolls {
                seed: 0,
                action_seq: 0,
                draws: 1
            },
            GoldenCase::Economy {
                start: fresh,
                entries: vec![Entry::Attack(Tier::Heavy), Entry::Attack(Tier::Light)],
            },
            GoldenCase::SurgeDamage {
                max_hp: 19,
                round: 14
            },
            GoldenCase::StatusTick {
                status: StatusEffect::Burn,
                max_hp: 160
            },
            GoldenCase::Initiative {
                contenders: vec![tie(1, Side::A, 0), tie(2, Side::B, 1)],
                priority: Side::B,
            },
            GoldenCase::Priority {
                kind: BattleKind::Wild,
                seed: 0x5EED,
                round: 2
            },
            GoldenCase::Pipeline {
                attacker: rt::water_attacker(),
                target: guarded,
                skill: rt::fire40(),
                flank: true,
                rolls: rt::SURE,
            },
            GoldenCase::Adjudicate {
                snapshot: StepSnapshot {
                    hp_pct: [150, 149],
                    conscious: [1, 3]
                },
                attack_damage_dealt: [0, 900],
                seed: 0,
                round: 1,
            },
        ]),
        vec![
            GoldenResult::Rolls(vec![RollPair {
                accuracy: 35,
                variance: 86
            }]),
            GoldenResult::Economy(Err(EconomyError::Unaffordable { cost: 4, ap: 2 })),
            GoldenResult::SurgeDamage(Some(5)),
            GoldenResult::StatusTick(Some(10)),
            GoldenResult::Initiative(vec![2, 1]),
            GoldenResult::Priority(Side::B),
            GoldenResult::Pipeline(PipelineTrace {
                hit: true,
                d0: 5,
                d1: 6,
                d2: 4,
                d3: 4,
                effectiveness: Some(Effectiveness::Neutral),
                applied: 4,
                hp_after: 96,
                stood_ground: false,
            }),
            GoldenResult::Adjudicate((Side::A, Adjudication::HpPercent)),
        ]
    );
}

/// BT2.5 (plan A4): a Pipeline case whose unit fails `validate_unit` comes back
/// `BadCase("invalid unit: {DeployError:?}")` — never a panic, never a clamped unit — with the
/// attacker validated before the target; a valid pair beside them still resolves.
/// Kills: `calc_damage` reached with defence 0 (a divide-by-zero panic); a 0-HP or over-max
/// unit clamped and resolved; the target checked first.
#[test]
fn an_invalid_pipeline_unit_is_a_bad_case_naming_its_deploy_error_bt2_5() {
    let ok_attacker = rt::fire_attacker();
    let ok_target = rt::plant_target(30);
    let mut fainted = rt::fire_attacker();
    fainted.id = 7;
    fainted.cur_hp = 0;
    let mut soft_attacker = rt::fire_attacker();
    soft_attacker.id = 7;
    soft_attacker.kit.stats.defense = 0;
    let mut over = rt::plant_target(100);
    over.id = 8;
    over.cur_hp = 101;
    let mut soft = rt::plant_target(30);
    soft.id = 8;
    soft.kit.stats.defense = 0;
    let mut dead_target = rt::plant_target(30);
    dead_target.id = 8;
    dead_target.cur_hp = 0;
    let case = |attacker: &TacticalUnit, target: &TacticalUnit| GoldenCase::Pipeline {
        attacker: attacker.clone(),
        target: target.clone(),
        skill: rt::fire40(),
        flank: false,
        rolls: rt::SURE,
    };
    let bad = |text: &str| GoldenResult::BadCase(text.to_string());
    assert_eq!(
        run_golden(&[
            case(&fainted, &ok_target),
            case(&ok_attacker, &over),
            case(&ok_attacker, &soft),
            case(&soft_attacker, &dead_target),
            case(&ok_attacker, &ok_target),
        ]),
        vec![
            bad("invalid unit: Fainted { id: 7 }"),
            bad("invalid unit: HpAboveMax { id: 8, cur_hp: 101, max_hp: 100 }"),
            bad("invalid unit: ZeroDefense { id: 8 }"),
            bad("invalid unit: ZeroDefense { id: 7 }"),
            GoldenResult::Pipeline(PipelineTrace {
                hit: true,
                d0: 14,
                d1: 14,
                d2: 14,
                d3: 14,
                effectiveness: Some(Effectiveness::SuperEffective),
                applied: 14,
                hp_after: 16,
                stood_ground: false,
            }),
        ]
    );
}

/// BT2.5: the golden `Rolls` kind is the per-target stream — pair i is the accuracy from
/// `splitmix64(seed ^ (seq + 2i))` then the variance from `splitmix64(seed ^ (seq + 2i + 1))`
/// (recomputed here with `tick_seed`) — and 0 draws is an empty stream.
/// Kills: a golden adapter that draws one value per pair or restarts the stream for each pair.
#[test]
fn golden_rolls_are_the_per_target_stream_from_seed_xor_action_seq_bt2_5() {
    for (seed, seq, draws) in [
        (0xDEAD_BEEF_u64, 0x0F0F_u64, 3u8),
        (1 << 52, 99, 2),
        (0x5EED, 0, 0),
    ] {
        let want: Vec<RollPair> = (0..u64::from(draws))
            .map(|i| rt::rolls_at(seed, seq + 2 * i))
            .collect();
        assert_eq!(
            run_golden(&[GoldenCase::Rolls {
                seed,
                action_seq: seq,
                draws
            }]),
            vec![GoldenResult::Rolls(want)],
            "seed {seed:#x} seq {seq}"
        );
    }
}

// ===========================================================================
// BT4.8 — the wild planner joins the harness (intent-chip parity)
// ===========================================================================
//
// The 18 AiPlan fixture cases (#286..=#303, in this order) and how each expected plan was derived.
// All run at the DESIGN tuning on 7×7 boards; the wild is unit 11 (side B, levelled speed 80, base
// speed 30 = stride 2 unless stated, 100/100 HP unless stated), players are side A. The arithmetic
// is `ai_tests.rs`'s module doc: 6 AP; Move 2 AP per stride (+1 when an enemy is adjacent to the
// wild's tile), Light 2, Heavy 4, End 0, ≤ 2 strides; Walk pays 1 per Plain, 2 per Rough; tile key
// `(primary, path cost, y, x)`, target key `(distance, cur_hp, slot, y, x)`.
//
//  1 Aggressive, melee kit, W (3,3), P1 (4,3) adjacent: Heavy from its own tile (4 AP)
//    → [Skill 20 → 1, End]
//  2 Aggressive, J9 kit (Light r1–3, Heavy melee), W (1,3), P1 (4,3): a stationary Light exists,
//    but Heavy after one stride to (3,3) (cost 2, 6 AP) wins — tier before tile
//    → [Move (3,3) ×1, Skill 20 → 1, End]
//  3 Aggressive, ranged kit (both r2–3), W (3,3), P1 adjacent: the taxed one-stride Heavy is 7
//    (refused), the taxed one-stride Light 5; cost-1 tiles 2 from P1: (3,2), (2,3), (3,4)
//    → lowest y → [Move (3,2) ×1, Skill 10 → 1, End]
//  4 Aggressive, melee, W (0,3), P1 (6,3), Rough (2,3): no attack in reach; (4,3) (d 2) costs
//    1+2+1+1 = 5 > 4; (3,3) (d 3) costs 4 → [Move (3,3) ×2, End]
//  5 Aggressive, melee, W (3,3), P1 (3,0), row 2 Blocked: P1's side is unreachable; every
//    reachable tile has d ≥ 3 = d(own tile) → [End]
//  6 Territorial (spawn (6,3)), melee, W (4,3), P1 (1,3): the attack tiles (2,3), (1,2), (1,4)
//    are 4–6 from the spawn → no attack → [End]
//  7 Territorial (spawn (6,3)), melee, W (5,3), P1 (6,1): one-stride Heavy tiles (5,1) (3 from
//    the spawn: refused) and (6,2) (1 from it), both cost 2 → [Move (6,2) ×1, Skill 20 → 1, End]
//  8 Skittish, ranged kit, W (3,2), P1 (3,0): Heavy tiles at the farthest d 3, all cost 1:
//    (2,2), (4,2), (3,3) → (2,2) → [Move (2,2) ×1, Skill 20 → 1, End]
//  9 Skittish, melee (band 1 + 2 = 3), W (0,2), P1 (0,0), (0,1) Blocked: (1,0) costs 3, no
//    Heavy; farthest in band d 3: (1,2) cost 1 beats (0,3) cost 1 (y) and (2,1) cost 3
//    → [Move (1,2) ×1, End]
// 10 Skittish, melee (band 3), W (6,6), P1 (0,0): no in-band tile in reach → approach; d 8 at
//    (2,6), (3,5), (4,4), (5,3), (6,2), all cost 4 → [Move (6,2) ×2, End]
// 11 Aggressive, J9 kit, W (1,3) at 24/100 (96 < 100: Exhausted), P1 (4,3): its own tile only,
//    the Light reaches (3 away) → [Skill 10 → 1, End]
// 12 the same at 25/100 (100 is not below 100): not Exhausted → case 2's plan
// 13 Skittish, melee, W (1,3) at 24/100, P1 (4,3): Exhausted, nothing in range from its tile
//    → [End]
// 14 Aggressive, Light r1–3 + Heavy lance r1–2, W (3,3); P1 (slot 0, 90 HP) at (3,1) and P2
//    (slot 1, 40 HP) at (5,3), both 2 away → the lower cur_hp, P2, Heavy from its own tile
//    → [Skill 20 → 2, End]
// 15 Aggressive, Light melee + Heavy 30 Caster Burst(1), W (1,3), P1 (4,3): the ring holds P1
//    from (3,3), one stride → [Move (3,3) ×1, Skill 30 → SelfTarget, End]
// 16 Aggressive, melee, base speed 95 (stride 4; the levelled speed 80 would give 3), W (0,3),
//    P1 (5,3): (4,3) costs 4 = one stride → Heavy (6 AP) → [Move (4,3) ×1, Skill 20 → 1, End]
// 17 case 2 with seed 9 007 199 254 740 991 and action_seq 7 → case 2's plan (seed-blind)
// 18 case 2 with the wild's stored budget fresh (ap 6) instead of idle → case 2's plan (J14)

use crate::combat::types::BattleOutcome;
use crate::monster::types::Affinity;

use super::ai::Stance;
use super::economy::spend;
use super::events::EventPayload;
use super::queue::{validate_at_pop, HaltReason, Hooks, Validated};
use super::resolve::{SkillTactics, TacticalState};
use super::tuning::TacticsTuning;
use super::types::{ActionTarget, MoveAction, QueuedAction, SkillAction};

/// The AiPlan cases the fixture carries (the bt-4 matrix above).
const AI_PLAN_CASES: usize = 18;

/// The gate's hooks for Move / Skill / EndTurn entries (none of those reads a hook).
struct NoHooks;

impl Hooks for NoHooks {
    fn item_count(&self, _unit: u32, _item_id: u32) -> u32 {
        0
    }

    fn take_item(&mut self, _unit: u32, _item_id: u32) -> bool {
        false
    }

    fn recruit_headroom(&self, _unit: u32) -> bool {
        false
    }

    fn plan_ai(&self, _state: &TacticalState, _unit: u32) -> Vec<QueuedAction> {
        vec![QueuedAction::EndTurn]
    }

    fn validate_delegated(
        &self,
        _state: &TacticalState,
        _unit: u32,
        _validated: &Validated,
    ) -> Result<(), HaltReason> {
        Ok(())
    }

    fn resolve_delegated(
        &mut self,
        _state: &mut TacticalState,
        _unit: u32,
        _validated: &Validated,
    ) -> Vec<EventPayload> {
        Vec::new()
    }
}

/// The fixture indices of the AiPlan cases.
fn ai_case_indices(fx: &Value) -> Vec<usize> {
    cases_array(fx)
        .iter()
        .enumerate()
        .filter(|(_, case)| kind_of(case) == "AiPlan")
        .map(|(i, _)| i)
        .collect()
}

/// The plan inside an `{"AiPlan": [...]}` result.
fn ai_plan_of(result: &Value) -> Vec<QueuedAction> {
    serde_json::from_value(result["AiPlan"].clone())
        .unwrap_or_else(|e| panic!("not an AiPlan result {result}: {e}"))
}

fn shape_of(plan: &[QueuedAction]) -> &'static str {
    match plan {
        [QueuedAction::Skill(_), QueuedAction::EndTurn] => "[Skill, End]",
        [QueuedAction::Move(_), QueuedAction::Skill(_), QueuedAction::EndTurn] => {
            "[Move, Skill, End]"
        }
        [QueuedAction::Move(_), QueuedAction::EndTurn] => "[Move, End]",
        [QueuedAction::EndTurn] => "[End]",
        _ => "another shape",
    }
}

/// The battle an AiPlan case describes (kind Wild, round 1, the units and the secret stream AS
/// GIVEN), rebuilt here from the rows independently of the adapter.
fn ai_board_state(
    rows: &[String],
    units: &[TacticalUnit],
    seed: u64,
    action_seq: u64,
) -> TacticalState {
    let height = u8::try_from(rows.len()).expect("fixture boards fit u8");
    let width =
        u8::try_from(rows.first().map_or(0, |r| r.chars().count())).expect("fixture boards fit u8");
    let terrain: Vec<Terrain> = rows
        .iter()
        .flat_map(|r| r.chars())
        .map(|ch| match ch {
            '.' => Terrain::Plain,
            'r' => Terrain::Rough,
            'w' => Terrain::Water,
            '#' => Terrain::Blocked,
            other => panic!("fixture glyph {other:?}"),
        })
        .collect();
    let n = terrain.len();
    TacticalState {
        kind: BattleKind::Wild,
        seed,
        action_seq,
        round: 1,
        width,
        height,
        terrain,
        blocks_los: vec![false; n],
        units: units.to_vec(),
        initiative: Vec::new(),
        queued: Vec::new(),
        attack_damage_dealt: [0, 0],
        outcome: BattleOutcome::Ongoing,
    }
}

/// Replay `plan` for `actor` as the executor would — the actor's budget fresh (TurnStart), each
/// entry through `validate_at_pop` on the board as it then stands, the costed entry spent on the
/// budget (the trailing EndTurn included) and the actor relocated after a Move. The first refusal,
/// as text.
fn gate_replay(mut state: TacticalState, actor: u32, plan: &[QueuedAction]) -> Result<(), String> {
    let t = TacticsTuning::DESIGN;
    if plan.last() != Some(&QueuedAction::EndTurn) {
        return Err("the plan does not end with EndTurn".to_owned());
    }
    state
        .unit_mut(actor)
        .ok_or_else(|| format!("no unit {actor}"))?
        .budget = TurnBudget::fresh(&t);
    for (k, action) in plan.iter().enumerate() {
        let validated = validate_at_pop(&state, actor, action, &NoHooks, &t)
            .map_err(|e| format!("entry {k} {action:?} refused: {e:?}"))?;
        let entry = match &validated {
            Validated::Move { entry, .. } => *entry,
            Validated::Skill { skill_id, .. } => {
                let tier = state
                    .unit(actor)
                    .and_then(|u| u.kit.skills.iter().find(|s| s.skill_id == *skill_id))
                    .map(|s| s.tier)
                    .ok_or_else(|| format!("entry {k}: skill {skill_id} is not in the kit"))?;
                Entry::Attack(tier)
            }
            Validated::EndTurn => Entry::EndTurn,
            other => return Err(format!("entry {k}: {other:?} is not a planner entry")),
        };
        let u = state
            .unit_mut(actor)
            .ok_or_else(|| format!("entry {k}: unit {actor} is gone"))?;
        spend(&mut u.budget, entry, &t)
            .map_err(|e| format!("entry {k} {action:?} unaffordable: {e:?}"))?;
        if let QueuedAction::Move(m) = action {
            u.pos = m.dest();
        }
    }
    Ok(())
}

/// The wild of the inline cases: unit 11, side B, slot 0, 100/100 HP, levelled speed 80, base 30.
fn golden_wild(x: u8, y: u8, skills: Vec<SkillTactics>) -> TacticalUnit {
    rt::unit(
        11,
        Side::B,
        0,
        c(x, y),
        rt::kit(
            2,
            Affinity::Water,
            5,
            rt::stat_block(100, 10, rt::CHIP_DEF, 80),
            30,
            MoveClass::Walk,
            skills,
        ),
        100,
    )
}

/// A side-A player: 100/100 HP, speed 30, no skills.
fn golden_player(id: u32, x: u8, y: u8) -> TacticalUnit {
    rt::unit(
        id,
        Side::A,
        0,
        c(x, y),
        rt::water(100, rt::CHIP_DEF, 30, Vec::new()),
        100,
    )
}

/// BT4.8: every AiPlan fixture case (at least the 18 above) reproduces its hand-derived plan in
/// canonical form — the native half of the intent-chip parity (the vitest compares the SAME
/// expected values through the wasm `tactics_golden`).
/// Kills: any drift in the planner's answer on a frozen board; an AiPlan dispatched elsewhere.
#[test]
fn every_ai_plan_fixture_case_reproduces_its_hand_derived_plan_bt4_8() {
    let fx = fixture();
    let cases = cases_array(&fx);
    let expected = expected_array(&fx);
    let got = run_fixture();
    let idx = ai_case_indices(&fx);
    assert!(
        idx.len() >= AI_PLAN_CASES,
        "{} AiPlan cases in the fixture",
        idx.len()
    );
    for i in idx {
        assert_eq!(kind_of(&expected[i]), "AiPlan", "expected #{i}");
        assert_eq!(
            canon(&got[i]),
            canon(&expected[i]),
            "case #{i}: {}",
            canon(&cases[i])
        );
    }
}

/// BT4.8: on the fixture boards the planner answers every plan shape — `[Skill, End]`,
/// `[Move, Skill, End]`, `[Move, End]`, `[End]` — and no other.
/// Kills: a planner (or an adapter) that collapses to one shape; an extra entry.
#[test]
fn the_planner_answers_every_plan_shape_on_the_fixture_boards_bt4_8() {
    let fx = fixture();
    let got = run_fixture();
    let shapes: Vec<&str> = ai_case_indices(&fx)
        .into_iter()
        .map(|i| shape_of(&ai_plan_of(&got[i])))
        .collect();
    for want in ["[Skill, End]", "[Move, Skill, End]", "[Move, End]", "[End]"] {
        assert!(shapes.contains(&want), "no {want} plan among {shapes:?}");
    }
    assert!(!shapes.contains(&"another shape"), "{shapes:?}");
}

/// BT4.8: the execution gate is the independent oracle — every AiPlan the planner answers on a
/// fixture board, and every hand-derived expected plan, passes `queue::validate_at_pop` entry by
/// entry on its own board (the actor relocated and the entry spent on a budget copy between
/// entries, the trailing EndTurn affordable) — so an intent chip can never show a plan the
/// server would halt.
/// Kills: a planned Move the gate re-paths as TooFar / unreachable; an aim the gate's
/// `target_set` refuses; an unaffordable sequence.
#[test]
fn every_fixture_ai_plan_is_accepted_by_the_execution_gate_entry_by_entry_bt4_8() {
    let fx = fixture();
    let expected = expected_array(&fx);
    let got = run_fixture();
    let cases = fixture_cases(&fx);
    let idx = ai_case_indices(&fx);
    assert!(idx.len() >= AI_PLAN_CASES);
    for i in idx {
        let GoldenCase::AiPlan {
            rows,
            units,
            seed,
            action_seq,
            unit,
            ..
        } = &cases[i]
        else {
            panic!("case #{i} is an AiPlan case");
        };
        for (label, value) in [("planned", &got[i]), ("expected", &expected[i])] {
            let plan = ai_plan_of(value);
            let state = ai_board_state(rows, units, *seed, *action_seq);
            if let Err(why) = gate_replay(state, *unit, &plan) {
                panic!("case #{i}, {label} {plan:?}: {why}");
            }
        }
    }
}

/// BT4.8: a malformed `rows` in an AiPlan case is a `BadCase` with the `GoldenBoard` texts, first
/// match wins (no rows / an empty first row → "empty board"; ragged rows 1 and 2; a bad glyph at
/// (1,1); 256 columns or 256 rows → "board too large") — and a well-formed board beside them
/// plans: on `...` the melee wild at (0,0) faces P1 at (1,0) → `[Skill 20 → 1, End]`.
/// Kills: a second row parser with other texts; a panic on a malformed board.
#[test]
fn a_malformed_ai_plan_board_is_a_bad_case_with_the_golden_board_texts_bt4_8() {
    let melee = || {
        vec![
            rt::light(10, Affinity::Fire, rt::melee()),
            rt::heavy(20, Affinity::Fire, 65, rt::melee()),
        ]
    };
    let ai = |rows: Vec<String>| GoldenCase::AiPlan {
        rows,
        units: vec![golden_player(1, 1, 0), golden_wild(0, 0, melee())],
        seed: 0,
        action_seq: 0,
        unit: 11,
        stance: Stance::Aggressive,
        spawn: c(0, 0),
    };
    let lines = |r: &[&str]| -> Vec<String> { r.iter().map(|s| (*s).to_string()).collect() };
    let bad = |text: &str| GoldenResult::BadCase(text.to_string());
    assert_eq!(
        run_golden(&[
            ai(Vec::new()),
            ai(lines(&[""])),
            ai(lines(&["...", "..", "..."])),
            ai(lines(&["..", "..", "."])),
            ai(lines(&["..", ".x"])),
            ai(vec![".".repeat(256)]),
            ai(vec![".".to_string(); 256]),
            ai(lines(&["..."])),
        ]),
        vec![
            bad("empty board"),
            bad("empty board"),
            bad("ragged row 1"),
            bad("ragged row 2"),
            bad("bad terrain 'x' at (1,1)"),
            bad("board too large"),
            bad("board too large"),
            GoldenResult::AiPlan(vec![
                QueuedAction::Skill(SkillAction {
                    skill_id: 20,
                    target: ActionTarget::Unit(1),
                }),
                QueuedAction::EndTurn,
            ]),
        ]
    );
}

/// BT4.8: the seed twin (case 17: seed 2^53 − 1, action_seq 7) and the budget twin (case 18: the
/// wild's stored budget fresh) each have a base board in the fixture (the same case with the
/// secret stream zeroed and every budget idle — case 2), and twin and base have identical
/// expected AND identical planned answers.
/// Kills: a planner whose answer moves with the secret stream or the stored budget.
#[test]
fn the_seed_twin_and_the_budget_twin_plan_exactly_like_their_base_board_bt4_8() {
    let fx = fixture();
    let expected = expected_array(&fx);
    let got = run_fixture();
    let cases = fixture_cases(&fx);
    let ai = ai_case_indices(&fx);
    let base_of = |case: &GoldenCase| -> GoldenCase {
        let mut base = case.clone();
        if let GoldenCase::AiPlan {
            units,
            seed,
            action_seq,
            ..
        } = &mut base
        {
            *seed = 0;
            *action_seq = 0;
            for u in units.iter_mut() {
                u.budget = TurnBudget::default();
            }
        }
        base
    };
    let seed_twin = ai
        .iter()
        .copied()
        .find(|&i| {
            matches!(
                &cases[i],
                GoldenCase::AiPlan {
                    seed: 9_007_199_254_740_991,
                    action_seq: 7,
                    ..
                }
            )
        })
        .expect("the fixture has the seed twin (seed 2^53 - 1, action_seq 7)");
    let budget_twin = ai
        .iter()
        .copied()
        .find(|&i| {
            matches!(
                &cases[i],
                GoldenCase::AiPlan { units, .. }
                    if units.iter().any(|u| u.budget != TurnBudget::default())
            )
        })
        .expect("the fixture has the budget twin (a stored budget that is not idle)");
    for (label, twin) in [("seed", seed_twin), ("budget", budget_twin)] {
        let base = base_of(&cases[twin]);
        let b = ai
            .iter()
            .copied()
            .find(|&i| i != twin && cases[i] == base)
            .unwrap_or_else(|| {
                panic!("the {label} twin #{twin} has its base board in the fixture")
            });
        assert_eq!(
            canon(&expected[twin]),
            canon(&expected[b]),
            "{label} twin #{twin} vs base #{b}: expected"
        );
        assert_eq!(
            canon(&got[twin]),
            canon(&got[b]),
            "{label} twin #{twin} vs base #{b}: planned"
        );
        assert_eq!(
            canon(&got[twin]),
            canon(&expected[twin]),
            "{label} twin #{twin}"
        );
    }
}

/// BT4.8: `run_golden` answers an inline AiPlan case with `ai::plan` at the design tuning and the
/// case's stance and spawn. The J9 board (Light r1–3 + Heavy melee wild at (1,3), P1 at (4,3);
/// seed 5, action_seq 3): Aggressive → `[Move (3,3) ×1, Skill 20 → 1, End]` (case 2);
/// Territorial with spawn (6,3) — (3,3) is 3 from the spawn and no other attack tile in reach is
/// within 2 of it — → the stationary Light `[Skill 10 → 1, End]`.
/// Kills: the stance or spawn dropped by the adapter; a tuning other than DESIGN.
#[test]
fn run_golden_answers_an_inline_ai_plan_with_the_planner_at_the_design_tuning_bt4_8() {
    let reach = vec![
        rt::light(
            10,
            Affinity::Fire,
            SkillGeometry {
                range_min: 1,
                range_max: 3,
                origin: Origin::TargetUnit,
                shape: Shape::Single,
                radius: 0,
                ff_filter: FfFilter::Enemies,
            },
        ),
        rt::heavy(20, Affinity::Fire, 65, rt::melee()),
    ];
    let case = |stance: Stance, spawn: Cell| GoldenCase::AiPlan {
        rows: vec![".......".to_string(); 7],
        units: vec![golden_player(1, 4, 3), golden_wild(1, 3, reach.clone())],
        seed: 5,
        action_seq: 3,
        unit: 11,
        stance,
        spawn,
    };
    assert_eq!(
        run_golden(&[
            case(Stance::Aggressive, c(1, 3)),
            case(Stance::Territorial, c(6, 3)),
        ]),
        vec![
            GoldenResult::AiPlan(vec![
                QueuedAction::Move(MoveAction {
                    x: 3,
                    y: 3,
                    strides: 1,
                }),
                QueuedAction::Skill(SkillAction {
                    skill_id: 20,
                    target: ActionTarget::Unit(1),
                }),
                QueuedAction::EndTurn,
            ]),
            GoldenResult::AiPlan(vec![
                QueuedAction::Skill(SkillAction {
                    skill_id: 10,
                    target: ActionTarget::Unit(1),
                }),
                QueuedAction::EndTurn,
            ]),
        ]
    );
}
