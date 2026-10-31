//! bt-1 gating tests — BT1.9 (`tactics::golden`): the native half of the native = wasm
//! byte-identity harness.
//!
//! The fixture `game-core/tests/fixtures/tactics_golden.json` is `{"cases": [...], "expected":
//! [...]}` (serde EXTERNALLY tagged, plan A10). Every `expected` entry was hand-derived from the
//! contracts (never captured from the implementation). The vitest
//! `client/src/tactics/golden.parity.test.ts` reads the SAME file and runs it through the
//! `tactics_golden` wasm export; both halves compare the CANONICAL form (compact JSON with
//! object keys sorted recursively, plan A1) so a key-order or number-format drift is caught.
//!
//! Names start `bt1_9_` — the acceptance ledger's CHECKs filter on that prefix.

use serde_json::Value;

use super::geometry::{BoardUnit, Cell, FfFilter, Origin, Shape, Side, SkillGeometry};
use super::golden::{run_golden, GoldenBoard, GoldenCase, GoldenResult};
use super::movement::{MoveClass, Path, PathError, Terrain};

const FIXTURE: &str = include_str!("../../tests/fixtures/tactics_golden.json");

/// The pinned size of the fixture. Growing it (BT2.5, BT4.8, BT11.7 join the harness) is a
/// deliberate edit here AND in the vitest.
const CASE_COUNT: usize = 182;
/// Cases whose board is malformed (no rows / ragged / bad glyph): they must come back `BadCase`.
const BAD_CASE_COUNT: usize = 9;

/// Every `GoldenCase` kind. Each must appear in the fixture at least once.
const KINDS: [&str; 9] = [
    "Distance",
    "Adjacent",
    "TargetSet",
    "Flank",
    "Los",
    "Stride",
    "Weight",
    "Path",
    "Disengage",
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
            // Only board-carrying kinds can be malformed.
            assert!(
                ["TargetSet", "Los", "Path", "Disengage"].contains(&case_kinds[i].as_str()),
                "case #{i} ({}) cannot carry a board",
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
    assert_eq!(
        bad,
        [
            "empty board",
            "empty board",
            "ragged row 1",
            "ragged row 2",
            "bad terrain 'x' at (1,1)",
            "bad terrain 'q' at (1,0)",
            "bad terrain 'W' at (2,1)",
            "bad terrain ' ' at (0,1)",
            "empty board",
        ]
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
