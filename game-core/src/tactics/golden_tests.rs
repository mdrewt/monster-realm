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
//! seq 6 }` draws 7^6 = 1 then 7^7 = 0 → (65, 85 + 15 = 100). Priority seeds 24 301 (0x5EED),
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
const CASE_COUNT: usize = 285;
/// Cases that must come back `BadCase`: a malformed board (no rows / too large / ragged / bad
/// glyph) or, since bt-2, a Pipeline unit that fails `validate_unit`.
const BAD_CASE_COUNT: usize = 17;

/// Every `GoldenCase` kind. Each must appear in the fixture at least once.
const KINDS: [&str; 17] = [
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
