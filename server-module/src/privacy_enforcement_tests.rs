//! rb-45 — the [DEL-06] crate-wide deletion-gate census (ADR-0258).
//!
//! EARS under gate. (rb-45) WHEN a reducer writes any manifest-classified table
//! without the gate call or `STATE_TRANSITION_OWNERS` membership THE SYSTEM
//! SHALL fail CI. (rb-49, [DEL-06]) WHEN a reducer writes any manifest-classified
//! table outside `STATE_TRANSITION_OWNERS` THE SYSTEM SHALL require a preceding
//! deletion-guard call — a `require_*` wrapper over the rejection predicate,
//! spelled as ADR-0248 D1 pins it — mechanically enforced.
//!
//! OWNERSHIP SPLIT. The `rb45_*` tests and the rosters below are GATING: they are
//! revised from ADR-0258 and the slice plan, NEVER edited to fit an engine. The
//! `census` module is the implementation half; the rest of the file is its contract.
//!
//! FIXTURE HYGIENE — MANDATORY for every future editor. Several eval scripts
//! concatenate the `*_tests.rs` files and scan them as TEXT with string-unaware
//! comment strippers, so a contiguous production marker here reds an unrelated CI
//! gate. Therefore, in this file:
//!   - every production-looking marker inside a fixture is assembled from
//!     `concat!` pieces, spelled ONCE in a `fixture_*` helper or a const near the
//!     top (reducer and table attributes, the accessor spelling, write calls, the
//!     guard paths, the pending predicate, macro and impl-block shapes, the
//!     table-handle type, cfg and path attributes);
//!   - no forward slash inside ANY string literal, no block comment, no raw
//!     string, no include macro, no macro metavariable splice;
//!   - lines stay inside 100 columns and the file stays rustfmt-clean.

use std::collections::BTreeSet;

// ---------------------------------------------------------------------------
// The census engine (implementation half — frozen API, bodies land in T3)
// ---------------------------------------------------------------------------

mod census {
    use std::collections::{BTreeMap, BTreeSet};

    pub(super) const WRITE_VERBS: &[&str] = &[
        "insert",
        "try_insert",
        "update",
        "delete",
        "clear",
        "insert_or_update",
        "try_insert_or_update",
    ];

    /// Manifest tables whose `DeletionPolicy` is not `NotOwned`, read from the
    /// real `crate::schema::DATA_LIFECYCLE_MANIFEST`.
    pub(super) fn classified_tables() -> BTreeSet<&'static str> {
        unimplemented!("rb-45 T3: engine not yet implemented")
    }

    /// The real corpus: `[("crate", lib.rs source), (module, module source)…]`,
    /// derived by parsing lib.rs and read through `env!("CARGO_MANIFEST_DIR")`.
    pub(super) fn real_sources() -> Result<Vec<(String, String)>, CensusError> {
        unimplemented!("rb-45 T3: engine not yet implemented")
    }

    pub(super) fn census(
        sources: &[(String, String)],
        classified: &BTreeSet<&str>,
        owners: &[&str],
    ) -> Result<Report, CensusError> {
        let _ = (sources, classified, owners);
        unimplemented!("rb-45 T3: engine not yet implemented")
    }

    #[derive(Debug)]
    pub(super) struct Report {
        pub verdicts: BTreeMap<String, Verdict>,
        pub modules: Vec<String>,
    }

    impl Report {
        pub(super) fn ungated(&self) -> BTreeSet<&str> {
            unimplemented!("rb-45 T3: engine not yet implemented")
        }

        pub(super) fn names_with(&self, pred: impl Fn(&Verdict) -> bool) -> BTreeSet<&str> {
            let _ = pred;
            unimplemented!("rb-45 T3: engine not yet implemented")
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) enum Verdict {
        Owner,
        Lifecycle,
        Scheduled,
        NoClassifiedWrites,
        Gated {
            gate_stmt: usize,
            first_write_stmt: usize,
        },
        Ungated {
            writes: BTreeSet<String>,
            first_write_stmt: usize,
            gate_stmt: Option<usize>,
            via: Vec<String>,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) enum CensusError {
        Parse { module: String, msg: String },
        MissingModuleFile { module: String },
        DuplicateReducer { name: String },
        UnsupportedShape { module: String, what: String },
    }
}

// ---------------------------------------------------------------------------
// Roster 1 — the declared exemptions (ADR-0258 D6)
//
// Every reducer the census reports as UNGATED must appear here with a basis, and
// every row here must still be ungated: the comparison is exact in BOTH
// directions, never a count and never a floor. Paying the debt down is a
// conscious edit of this roster, and so is widening it.
// ---------------------------------------------------------------------------

const DELIBERATE_EXEMPTIONS: &[(&str, &str)] = &[
    // (i) acts on an already-open commitment, which PRV1-10 and ADR-0227 D5 keep
    // completable while a deletion is pending.
    (
        "submit_attack",
        "acts on an already-open battle commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "swap_active",
        "acts on an already-open battle commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "flee",
        "unwinds an already-open battle commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "use_battle_item",
        "acts on an already-open battle commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "submit_pvp_action",
        "acts on an already-open PvP commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "cancel_trade",
        "unwinds an already-open trade commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "confirm_trade",
        "closes an already-open trade commitment; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "cancel_challenge",
        "unwinds an already-open challenge; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    (
        "decline_challenge",
        "unwinds an already-open challenge; PRV1-10 and ADR-0227 D5 keep it completable",
    ),
    // (ii) the decline arm runs before the stamp-aware accept gate by design.
    (
        "respond_trade",
        "the decline arm unwinds the offer BEFORE the stamp-aware accept gate (ADR-0237)",
    ),
    // (iii) operator-only surface, unreachable by a player caller.
    (
        "sync_content",
        "operator-only behind the module-owner identity guard; no player caller exists",
    ),
    // (iv) KNOWN GAP — spec para 4.7 names these as gate targets and no slice has
    // gated them yet. Debt with a registered drain (one reject test per reducer),
    // not a decision that they stay ungated.
    (
        "join_game",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "evolve",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "care",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "train",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "essence_train",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "consume_crystalized_essence",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "attempt_recruit",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "set_nickname",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "set_party_slot",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "enqueue_move",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "set_move",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "clear_queue",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "dismiss_dialogue",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
    (
        "ack_evolution_notices",
        "KNOWN GAP: a spec para 4.7 gate target, pending the roster-drain slice",
    ),
];

// ---------------------------------------------------------------------------
// Roster 2 — the structural facts of the REAL crate (ADR-0258 D2, D5)
//
// The corpus is lib.rs plus every bare `mod x;` it declares, in declaration
// order; the two structural exemption sets are pinned EXACTLY so a new free ride
// is a conscious edit rather than a silent widening.
// ---------------------------------------------------------------------------

const EXPECTED_MODULES: &[&str] = &[
    "crate",
    "accounts",
    "battle",
    "content",
    "content_cache",
    "economy",
    "evolution",
    "guards",
    "inventory",
    "marshal",
    "monster_mgmt",
    "movement",
    "npc",
    "observability",
    "playtest",
    "privacy",
    "pvp",
    "raising",
    "ranking",
    "schema",
    "taming",
    "trading",
];

const EXPECTED_LIFECYCLE: &[&str] = &["init", "on_connect", "on_disconnect"];

const EXPECTED_SCHEDULED: &[&str] = &[
    "battle_challenge_reaper",
    "export_bundle_reaper",
    "guest_claim_reaper",
    "movement_tick",
    "mr_heartbeat",
    "playtest_reaper",
    "pvp_deadline_reaper",
    "trade_offer_reaper",
];

/// Every reducer that carries a depth-0 gate before its first write today. Pinned
/// as a SET in both directions: losing a gate is as much a regression as a new
/// ungated writer, and it is the half the exemption roster cannot see.
const EXPECTED_GATED: &[&str] = &[
    "accept_challenge",
    "advance_dialogue",
    "buy",
    "challenge_pvp",
    "complete_guest_claim",
    "grant_bait",
    "heal_party",
    "propose_trade",
    "request_data_export",
    "sell",
    "set_profile_name",
    "start_battle",
    "start_wild_battle",
    "talk",
];

/// Reducers that reach no classified write at all.
const EXPECTED_NO_WRITES: &[&str] = &["start_guest_claim"];

/// Vacuity floor for the manifest-derived classified set (24 tables at rb-45):
/// the set itself is derived in the test from `DATA_LIFECYCLE_MANIFEST`, so this
/// only refuses a manifest that shrank to nothing.
const CLASSIFIED_TABLE_FLOOR: usize = 24;

/// Reducer floor for the real corpus (54 at rb-45), so the per-reducer verdict
/// pin cannot be satisfied by an engine that finds almost none of them.
const REDUCER_FLOOR: usize = 54;

// ---------------------------------------------------------------------------
// Pure comparison helpers (test-side, never part of the engine)
// ---------------------------------------------------------------------------

/// Compare the census's ungated set against the declared roster in BOTH
/// directions and reject duplicate or basis-less roster rows. The failure
/// message prints each unrostered reducer's write set and helper chain, so a
/// widening is visible in review (ADR-0258 D6: the roster pins WHICH reducers
/// are ungated, not WHAT they write).
fn roster_mismatch(report: &census::Report, roster: &[(&str, &str)]) -> Result<(), String> {
    let rostered: BTreeSet<&str> = roster.iter().map(|&(name, _)| name).collect();
    let duplicates: BTreeSet<&str> = roster
        .iter()
        .map(|&(name, _)| name)
        .filter(|n| roster.iter().filter(|&&(m, _)| m == *n).count() > 1)
        .collect();
    let blank_basis: BTreeSet<&str> = roster
        .iter()
        .filter(|&&(_, basis)| basis.trim().is_empty())
        .map(|&(name, _)| name)
        .collect();
    let ungated = report.ungated();
    let unrostered: Vec<&str> = ungated
        .iter()
        .copied()
        .filter(|n| !rostered.contains(n))
        .collect();
    let stale: Vec<&str> = rostered
        .iter()
        .copied()
        .filter(|n| !ungated.contains(n))
        .collect();
    if duplicates.is_empty() && blank_basis.is_empty() && unrostered.is_empty() && stale.is_empty()
    {
        return Ok(());
    }
    let mut msg = String::from("the deletion-gate census does not match DELIBERATE_EXEMPTIONS");
    if !duplicates.is_empty() {
        msg.push_str(&format!("\n  duplicate roster rows: {duplicates:?}"));
    }
    if !blank_basis.is_empty() {
        msg.push_str(&format!(
            "\n  roster rows with an empty basis: {blank_basis:?}"
        ));
    }
    for name in &unrostered {
        msg.push_str(&format!(
            "\n  UNGATED and unrostered: {name} -- {}",
            describe_verdict(report, name)
        ));
    }
    for name in &stale {
        msg.push_str(&format!(
            "\n  rostered but no longer ungated: {name} -- {}",
            describe_verdict(report, name)
        ));
    }
    Err(msg)
}

/// One reducer's verdict rendered for the roster-failure message.
fn describe_verdict(report: &census::Report, name: &str) -> String {
    match report.verdicts.get(name) {
        Some(census::Verdict::Ungated {
            writes,
            first_write_stmt,
            gate_stmt,
            via,
        }) => {
            let writes: Vec<&str> = writes.iter().map(String::as_str).collect();
            let via: Vec<&str> = via.iter().map(String::as_str).collect();
            format!(
                "writes {writes:?}, first write-reaching statement {first_write_stmt}, \
                 gate statement {gate_stmt:?}, reached via {via:?}"
            )
        }
        Some(other) => format!("{other:?}"),
        None => String::from("no verdict at all"),
    }
}

fn classified_of(names: &[&'static str]) -> BTreeSet<&'static str> {
    names.iter().copied().collect()
}

fn census_of(sources: Vec<(String, String)>, classified: &[&'static str]) -> census::Report {
    let classified = classified_of(classified);
    census::census(&sources, &classified, game_core::STATE_TRANSITION_OWNERS)
        .unwrap_or_else(|e| panic!("the synthetic corpus must census cleanly, got {e:?}"))
}

fn census_one(module: &str, source: String, classified: &[&'static str]) -> census::Report {
    census_of(vec![(module.to_string(), source)], classified)
}

fn verdict_of<'a>(report: &'a census::Report, name: &str) -> &'a census::Verdict {
    report
        .verdicts
        .get(name)
        .unwrap_or_else(|| panic!("every reducer needs a verdict; none for {name}"))
}

fn assert_verdict(report: &census::Report, name: &str, want: census::Verdict) {
    assert_eq!(verdict_of(report, name), &want, "verdict for {name}");
}

/// Assert `name` is ungated with exactly `writes` and `gate_stmt`, and hand back
/// its first write-reaching statement index for the caller to pin.
fn assert_ungated(
    report: &census::Report,
    name: &str,
    writes: &[&str],
    gate_stmt: Option<usize>,
) -> usize {
    match verdict_of(report, name) {
        census::Verdict::Ungated {
            writes: got,
            first_write_stmt,
            gate_stmt: got_gate,
            via: _,
        } => {
            let want: BTreeSet<String> = writes.iter().map(|w| (*w).to_string()).collect();
            assert_eq!(got, &want, "ungated write set for {name}");
            assert_eq!(*got_gate, gate_stmt, "recorded gate statement for {name}");
            *first_write_stmt
        }
        other => panic!("{name} must be ungated, got {other:?}"),
    }
}

fn assert_via_non_empty(report: &census::Report, name: &str) {
    match verdict_of(report, name) {
        census::Verdict::Ungated { via, .. } => {
            assert!(
                !via.is_empty(),
                "the helper chain for {name} must be reported"
            );
        }
        other => panic!("{name} must be ungated, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Fixture builders — EVERY production-looking marker is spelled exactly once
// here, split across `concat!` pieces. Never inline one of these literals.
// ---------------------------------------------------------------------------

const CTX_DB: &str = concat!("ctx", ".db.");
const GUARDS_PATH: &str = concat!("crate::guards", "::");
const ACCOUNTS_PATH: &str = concat!("crate::accounts", "::");
const PENDING_PRED: &str = concat!("is_pending_", "deletion");
const REDUCER_CTX: &str = "ctx: &ReducerContext";
const OK_TAIL: &str = "Ok(())";

/// The qualified reducer-attribute head. Spelled ONCE here, split so it is never
/// contiguous in this file; the real-crate test counts reducers with this needle.
const REDUCER_ATTR_HEAD: &str = concat!("#[spacetimedb", "::reducer");

fn fixture_reducer_attr(arg: &str) -> String {
    if arg.is_empty() {
        format!("{REDUCER_ATTR_HEAD}]")
    } else {
        format!("{REDUCER_ATTR_HEAD}({arg})]")
    }
}

/// The bare spelling the engine must also accept.
fn fixture_reducer_attr_bare() -> String {
    String::from(concat!("#[re", "ducer]"))
}

fn fixture_table_attr(accessor: &str, extra: &str) -> String {
    let head = concat!("#[spacetimedb", "::table(", "accessor", " = ");
    if extra.is_empty() {
        format!("{head}{accessor})]")
    } else {
        format!("{head}{accessor}, {extra})]")
    }
}

fn fixture_sched_arg(reducer: &str) -> String {
    format!("{}{reducer})", concat!("schedul", "ed("))
}

fn fixture_table_item(accessor: &str, extra: &str, type_name: &str) -> String {
    format!(
        "{}\npub struct {type_name} {{\n    pub id: u64,\n}}\n\n",
        fixture_table_attr(accessor, extra)
    )
}

fn fixture_handle(accessor: &str) -> String {
    format!("{CTX_DB}{accessor}()")
}

fn fixture_method(receiver: &str, name: &str, args: &str) -> String {
    format!("{receiver}.{name}({args})")
}

fn fixture_write_stmt(accessor: &str, verb: &str) -> String {
    format!(
        "{};",
        fixture_method(&fixture_handle(accessor), verb, "row")
    )
}

/// The same write spelled across TWO source lines: a statement-index engine sees
/// one statement, a line-offset engine sees two and misreports every later index.
fn fixture_write_stmt_wrapped(accessor: &str, verb: &str) -> String {
    format!("{}\n        .{verb}(row);", fixture_handle(accessor))
}

/// One call to a gate-named wrapper, under an arbitrary path `prefix` and with an
/// arbitrary `suffix` — only the fully-qualified `?;` spelling is a gate.
fn fixture_gate_call(prefix: &str, wrapper: &str, suffix: &str) -> String {
    format!("{prefix}{wrapper}(ctx, tag){suffix}")
}

fn fixture_gate_stmt(wrapper: &str) -> String {
    fixture_gate_call(GUARDS_PATH, wrapper, "?;")
}

fn fixture_discarded_gate() -> String {
    format!(
        "let _ = {}",
        fixture_gate_call(GUARDS_PATH, "require_not_deleting", ";")
    )
}

/// Gate shape (b): `prefix` is the qualifying path, an empty string for the bare
/// spelling inside the accounts module, or a negation for the non-gate shape.
fn fixture_pending_if(prefix: &str, body: &str) -> String {
    format!("if {prefix}{PENDING_PRED}(ctx, me) {{ {body} }}")
}

fn fixture_reducer(attr: &str, name: &str, extra_params: &str, body: &[String]) -> String {
    let mut out = String::from(attr);
    out.push('\n');
    out.push_str(&format!(
        "pub fn {name}({REDUCER_CTX}{extra_params}) -> Result<(), String> {{\n"
    ));
    for stmt in body {
        out.push_str("    ");
        out.push_str(stmt);
        out.push('\n');
    }
    out.push_str("}\n\n");
    out
}

fn fixture_helper_fn(name: &str, body: &[String]) -> String {
    let mut out = format!("pub(crate) fn {name}({REDUCER_CTX}) {{\n");
    for stmt in body {
        out.push_str("    ");
        out.push_str(stmt);
        out.push('\n');
    }
    out.push_str("}\n\n");
    out
}

const SYNTH_UNGATED: &str = "synth_ungated_writer";

/// THE mandated tooth's payload: one table and one reducer that writes it with
/// no gate anywhere in the body.
fn fixture_synthetic_ungated_module() -> String {
    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_reducer(
        &fixture_reducer_attr(""),
        SYNTH_UNGATED,
        "",
        &[
            fixture_write_stmt("monster", "insert"),
            String::from(OK_TAIL),
        ],
    ));
    src
}

// ---------------------------------------------------------------------------
// The gating tests
// ---------------------------------------------------------------------------

#[test]
fn rb45_synthetic_ungated_reducer_is_flagged() {
    let synthetic = fixture_synthetic_ungated_module();

    let alone = census_one("synth", synthetic.clone(), &["monster"]);
    let first_write = assert_ungated(&alone, SYNTH_UNGATED, &["monster"], None);
    assert_eq!(
        first_write, 0,
        "the unguarded insert is statement 0 of the body"
    );

    let classified = census::classified_tables();
    let owners = game_core::STATE_TRANSITION_OWNERS;

    let mut injected_sources = census::real_sources().expect("real_sources must read the crate");
    injected_sources.push((String::from("synth"), synthetic));
    let injected = census::census(&injected_sources, &classified, owners)
        .expect("the real corpus plus one synthetic module must census cleanly");
    let failure = roster_mismatch(&injected, DELIBERATE_EXEMPTIONS)
        .expect_err("an injected ungated writer must fail the roster comparison");
    assert!(
        failure.contains(SYNTH_UNGATED),
        "the roster failure must name the offending reducer, got: {failure}"
    );

    let real_sources = census::real_sources().expect("real_sources must read the crate");
    let real = census::census(&real_sources, &classified, owners)
        .expect("the real corpus must census cleanly");
    if let Err(msg) = roster_mismatch(&real, DELIBERATE_EXEMPTIONS) {
        panic!("{msg}");
    }
}

#[test]
fn rb45_gate_after_the_first_write_is_ungated() {
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_reducer(
        &attr,
        "late_gate",
        "",
        &[
            fixture_write_stmt_wrapped("monster", "insert"),
            fixture_gate_stmt("require_not_deleting"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "late_pending_gate",
        "",
        &[
            fixture_write_stmt("monster", "insert"),
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, "return Err(e);"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "nested_write_before_gate",
        "",
        &[
            format!("if flag {{ {} }}", fixture_write_stmt("monster", "insert")),
            fixture_gate_stmt("require_not_deleting"),
            String::from(OK_TAIL),
        ],
    ));

    let report = census_one("synth", src, &["monster"]);
    let first_write = assert_ungated(&report, "late_gate", &["monster"], Some(1));
    assert_eq!(
        first_write, 0,
        "the write is statement 0 and the gate is statement 1"
    );
    let first_write = assert_ungated(&report, "late_pending_gate", &["monster"], Some(2));
    assert_eq!(
        first_write, 0,
        "gate shape (b) at statement 2 is still after the write"
    );
    let first_write = assert_ungated(&report, "nested_write_before_gate", &["monster"], Some(1));
    assert_eq!(
        first_write, 0,
        "a write nested inside statement 0 makes statement 0 the first write-reaching one"
    );
}

#[test]
fn rb45_conditional_nested_negated_or_discarded_gate_is_not_a_gate() {
    let gate = fixture_gate_stmt("require_not_deleting");
    let write = fixture_write_stmt("monster", "insert");
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("monster", "", "SynthMonster");

    src.push_str(&fixture_reducer(
        &attr,
        "gate_under_a_condition",
        "",
        &[format!("if flag {{ {gate} }}"), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_inside_a_block",
        "",
        &[format!("{{ {gate} }}"), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_under_a_negation",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(&format!("!{ACCOUNTS_PATH}"), "return Err(e);"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_with_a_discarded_verdict",
        "",
        &[fixture_discarded_gate(), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_hidden_in_a_helper",
        "",
        &[String::from("helper_that_gates(ctx)?;"), write.clone()],
    ));
    src.push_str(&fixture_helper_fn("helper_that_gates", &[gate]));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_without_a_return",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, "log_something();"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_without_the_question_mark",
        "",
        &[
            fixture_gate_call(GUARDS_PATH, "require_not_deleting", ";"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_with_an_ok_suffix",
        "",
        &[
            fixture_gate_call(GUARDS_PATH, "require_not_deleting", ".ok();"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_without_full_qualification",
        "",
        &[
            fixture_gate_call("guards::", "require_not_deleting", "?;"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "bare_gate_name",
        "",
        &[
            fixture_gate_call("", "require_not_deleting", "?;"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "bare_predicate_outside_accounts",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if("", "return Err(e);"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "return_not_last_in_then_branch",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(
                ACCOUNTS_PATH,
                "if other { return Err(e); } log_something();",
            ),
            write,
        ],
    ));

    let report = census_one("synth", src, &["monster"]);
    for name in [
        "gate_under_a_condition",
        "gate_inside_a_block",
        "gate_under_a_negation",
        "gate_with_a_discarded_verdict",
        "gate_hidden_in_a_helper",
        "gate_without_a_return",
        "gate_without_the_question_mark",
        "gate_with_an_ok_suffix",
        "gate_without_full_qualification",
        "bare_gate_name",
        "bare_predicate_outside_accounts",
        "return_not_last_in_then_branch",
    ] {
        assert_ungated(&report, name, &["monster"], None);
    }
}

#[test]
fn rb45_table_handle_alias_write_is_a_write() {
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("battle", "", "SynthBattle");
    src.push_str(&fixture_table_item("character", "", "SynthCharacter"));

    src.push_str(&fixture_reducer(
        &attr,
        "writes_through_a_handle_alias",
        "",
        &[
            format!("let battles = {};", fixture_handle("battle")),
            format!(
                "{};",
                fixture_method(&fixture_method("battles", "battle_id", ""), "update", "row")
            ),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "writes_through_an_index_alias",
        "",
        &[
            format!(
                "let h = {};",
                fixture_method(&fixture_handle("battle"), "battle_id", "")
            ),
            format!("{};", fixture_method("h", "delete", "1")),
        ],
    ));
    let found_row = fixture_method(
        &fixture_method(
            &fixture_method(&fixture_handle("character"), "entity_id", ""),
            "find",
            "1",
        ),
        "unwrap",
        "",
    );
    src.push_str(&fixture_reducer(
        &attr,
        "clears_a_field_of_a_found_row",
        "",
        &[
            format!("let row = {found_row};"),
            format!("{};", fixture_method("row.move_queue", "clear", "")),
        ],
    ));

    let report = census_one("synth", src, &["battle", "character"]);
    let first = assert_ungated(&report, "writes_through_a_handle_alias", &["battle"], None);
    assert_eq!(
        first, 1,
        "the alias binding is statement 0; the write is statement 1"
    );
    let first = assert_ungated(&report, "writes_through_an_index_alias", &["battle"], None);
    assert_eq!(
        first, 1,
        "the alias binding is statement 0; the write is statement 1"
    );
    assert_verdict(
        &report,
        "clears_a_field_of_a_found_row",
        census::Verdict::NoClassifiedWrites,
    );
}

#[test]
fn rb45_helper_delegated_write_is_a_write() {
    let attr = fixture_reducer_attr("");
    let write = fixture_write_stmt("player_wallet", "insert");

    let mut synth = fixture_table_item("player_wallet", "", "SynthWallet");
    synth.push_str(&fixture_reducer(
        &attr,
        "spends_through_a_same_module_helper",
        "",
        &[String::from("pay(ctx);"), String::from(OK_TAIL)],
    ));
    synth.push_str(&fixture_helper_fn("pay", std::slice::from_ref(&write)));
    synth.push_str(&fixture_reducer(
        &attr,
        "spends_through_two_hops",
        "",
        &[
            String::from("crate::economy::grant(ctx);"),
            String::from(OK_TAIL),
        ],
    ));
    synth.push_str(&fixture_reducer(
        &attr,
        "spends_through_a_cycle",
        "",
        &[String::from("a(ctx);"), String::from(OK_TAIL)],
    ));
    synth.push_str(&fixture_helper_fn("a", &[String::from("b(ctx);")]));
    synth.push_str(&fixture_helper_fn(
        "b",
        &[
            String::from("a(ctx);"),
            fixture_write_stmt("player_wallet", "delete"),
        ],
    ));

    let mut economy = fixture_helper_fn("grant", &[String::from("inner(ctx);")]);
    economy.push_str(&fixture_helper_fn("inner", &[write]));

    let report = census_of(
        vec![
            (String::from("synth"), synth),
            (String::from("economy"), economy),
        ],
        &["player_wallet"],
    );
    for name in [
        "spends_through_a_same_module_helper",
        "spends_through_two_hops",
        "spends_through_a_cycle",
    ] {
        let first = assert_ungated(&report, name, &["player_wallet"], None);
        assert_eq!(first, 0, "the delegating call is statement 0 for {name}");
        assert_via_non_empty(&report, name);
    }
}

#[test]
fn rb45_owner_lifecycle_and_scheduled_are_exempt_with_precedence() {
    let owners = game_core::STATE_TRANSITION_OWNERS;
    assert!(
        owners.len() >= 2,
        "this fixture needs two distinct owner names"
    );
    let plain_owner = owners[0];
    let scheduled_owner = owners[owners.len() - 1];
    let attr = fixture_reducer_attr("");
    let write = fixture_write_stmt("monster", "insert");

    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_table_item(
        "tick_schedule",
        &fixture_sched_arg("tick"),
        "TickSchedule",
    ));
    src.push_str(&fixture_table_item(
        "owner_schedule",
        &fixture_sched_arg(scheduled_owner),
        "OwnerSchedule",
    ));

    let one_write = std::slice::from_ref(&write);
    src.push_str(&fixture_reducer(&attr, plain_owner, "", one_write));
    src.push_str(&fixture_reducer(
        &fixture_reducer_attr("client_connected"),
        "whatever_name",
        "",
        one_write,
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "tick",
        ", _s: TickSchedule",
        one_write,
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "not_scheduled",
        ", _s: TickSchedule",
        one_write,
    ));
    src.push_str(&fixture_reducer(&attr, scheduled_owner, "", one_write));

    let report = census_one("synth", src, &["monster"]);
    assert_verdict(&report, plain_owner, census::Verdict::Owner);
    assert_verdict(&report, "whatever_name", census::Verdict::Lifecycle);
    assert_verdict(&report, "tick", census::Verdict::Scheduled);
    assert_ungated(&report, "not_scheduled", &["monster"], None);
    assert_verdict(&report, scheduled_owner, census::Verdict::Owner);
}

#[test]
fn rb45_not_owned_and_foreign_writes_are_not_classified() {
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_table_item("config", "", "SynthConfig"));
    src.push_str(&fixture_table_item("player_wallet", "", "SynthWallet"));

    src.push_str(&fixture_reducer(
        &attr,
        "writes_a_not_owned_table",
        "",
        &[
            fixture_write_stmt("config", "insert"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "writes_outside_the_classified_argument",
        "",
        &[
            fixture_write_stmt("player_wallet", "insert"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &fixture_reducer_attr_bare(),
        "writes_a_hash_map",
        "",
        &[
            String::from("let mut counts = HashMap::new();"),
            format!("{};", fixture_method("counts", "insert", "key, value")),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "clears_a_vec",
        "",
        &[
            String::from("let mut seen = Vec::new();"),
            format!("{};", fixture_method("seen", "clear", "")),
        ],
    ));

    let report = census_one("synth", src, &["monster"]);
    for name in [
        "writes_a_not_owned_table",
        "writes_outside_the_classified_argument",
        "writes_a_hash_map",
        "clears_a_vec",
    ] {
        assert_verdict(&report, name, census::Verdict::NoClassifiedWrites);
    }
}

#[test]
fn rb45_both_gate_shapes_and_every_write_verb_are_recognised() {
    let frozen: BTreeSet<&str> = [
        "insert",
        "try_insert",
        "update",
        "delete",
        "clear",
        "insert_or_update",
        "try_insert_or_update",
    ]
    .into_iter()
    .collect();
    let declared: BTreeSet<&str> = census::WRITE_VERBS.iter().copied().collect();
    assert_eq!(
        declared, frozen,
        "the write-verb roster is frozen by ADR-0258 D3"
    );

    let wrappers = [
        "require_not_deleting",
        "require_subject_not_deleting",
        "require_commitment_predates_deletion",
    ];
    let attr = fixture_reducer_attr("");
    let write = fixture_write_stmt("monster", "insert");
    let mut src = fixture_table_item("monster", "", "SynthMonster");

    for wrapper in wrappers {
        src.push_str(&fixture_reducer(
            &attr,
            &format!("gated_by_{wrapper}"),
            "",
            &[fixture_gate_stmt(wrapper), write.clone()],
        ));
    }
    src.push_str(&fixture_reducer(
        &attr,
        "gated_by_the_pending_predicate",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, "return Err(e);"),
            write.clone(),
        ],
    ));
    for &verb in census::WRITE_VERBS {
        src.push_str(&fixture_reducer(
            &attr,
            &format!("ungated_by_{verb}"),
            "",
            &[fixture_write_stmt("monster", verb)],
        ));
    }

    let report = census_one("synth", src, &["monster"]);
    for wrapper in wrappers {
        assert_verdict(
            &report,
            &format!("gated_by_{wrapper}"),
            census::Verdict::Gated {
                gate_stmt: 0,
                first_write_stmt: 1,
            },
        );
    }
    assert_verdict(
        &report,
        "gated_by_the_pending_predicate",
        census::Verdict::Gated {
            gate_stmt: 1,
            first_write_stmt: 2,
        },
    );
    for &verb in census::WRITE_VERBS {
        assert_ungated(&report, &format!("ungated_by_{verb}"), &["monster"], None);
    }

    let mut accounts_src = fixture_table_item("monster", "", "SynthMonster");
    accounts_src.push_str(&fixture_reducer(
        &attr,
        "gated_by_the_bare_predicate",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if("", "return Err(e);"),
            write,
        ],
    ));
    let accounts_report = census_one("accounts", accounts_src, &["monster"]);
    assert_verdict(
        &accounts_report,
        "gated_by_the_bare_predicate",
        census::Verdict::Gated {
            gate_stmt: 1,
            first_write_stmt: 2,
        },
    );
}

/// One refused shape: the module it lives in, its source, and a keyword the
/// engine's `what` must name it by (compared case-insensitively). The keyword is
/// part of the contract — a hard error that cannot say WHAT it refused is not
/// actionable.
struct RefusedShape {
    label: &'static str,
    module: &'static str,
    source: String,
    keyword: &'static str,
}

fn refused_shapes() -> Vec<RefusedShape> {
    let attr = fixture_reducer_attr("");
    let mut fn_pointer = fixture_helper_fn("helper", &[]);
    fn_pointer.push_str(&fixture_reducer(
        &attr,
        "binds_a_fn_pointer",
        "",
        &[
            String::from("let f = crate::synth::helper;"),
            String::from("let g = helper;"),
            String::from(OK_TAIL),
        ],
    ));

    vec![
        RefusedShape {
            label: "an item-position macro invocation",
            module: "synth",
            source: String::from("synth_macro! { }\n"),
            keyword: "macro",
        },
        RefusedShape {
            label: "a crate-local macro definition",
            module: "synth",
            source: String::from(concat!("macro_", "rules! synth { () => {} }\n")),
            keyword: "macro",
        },
        RefusedShape {
            label: "a nested mod inside a scanned module",
            module: "synth",
            source: String::from("mod inner;\n"),
            keyword: "mod",
        },
        RefusedShape {
            label: "an inline nested mod inside a scanned module",
            module: "synth",
            source: String::from("mod inline_inner {}\n"),
            keyword: "mod",
        },
        RefusedShape {
            label: "a crate-root mod under an inverted cfg",
            module: "crate",
            source: String::from(concat!("#[cf", "g(not(test))]\nmod hidden;\n")),
            keyword: "cfg",
        },
        RefusedShape {
            label: "a crate-root mod carrying only a path attribute",
            module: "crate",
            source: String::from(concat!("#[pa", "th = \"hidden.rs\"]\nmod hidden_path;\n")),
            keyword: "mod",
        },
        RefusedShape {
            label: "an import rename",
            module: "synth",
            source: String::from("use crate::schema::monster as m;\n"),
            keyword: "use as",
        },
        RefusedShape {
            label: "a fn-pointer let binding of a crate fn",
            module: "synth",
            source: fn_pointer,
            keyword: "pointer",
        },
        RefusedShape {
            label: "an impl-block fn that takes a reducer context",
            module: "synth",
            source: format!(
                "{}SynthThing {{\n    pub fn run({REDUCER_CTX}) {{}}\n}}\n",
                concat!("imp", "l ")
            ),
            keyword: "impl",
        },
        RefusedShape {
            label: "a helper returning a table handle",
            module: "synth",
            source: format!(
                "pub(crate) fn handle_of({REDUCER_CTX}) -> {} {{\n    lookup(ctx)\n}}\n",
                concat!("Table", "Handle")
            ),
            keyword: "handle",
        },
        RefusedShape {
            label: "a UFCS write spelling",
            module: "synth",
            source: fixture_reducer(
                &attr,
                "writes_by_ufcs",
                "",
                &[
                    format!("{}delete(&h, row);", concat!("Table", "::")),
                    String::from(OK_TAIL),
                ],
            ),
            keyword: "ufcs",
        },
        RefusedShape {
            label: "a procedure item",
            module: "synth",
            source: fixture_reducer(
                concat!("#[proce", "dure]"),
                "a_procedure",
                "",
                &[String::from(OK_TAIL)],
            ),
            keyword: "procedure",
        },
        RefusedShape {
            label: "a gate-named fn defined outside the guards module",
            module: "synth",
            source: format!(
                "pub(crate) fn require_not_deleting({REDUCER_CTX}, tag: &str) -> Result<(), \
                 String> {{\n    {OK_TAIL}\n}}\n"
            ),
            keyword: "shadow",
        },
    ]
}

fn accepted_shapes() -> Vec<(&'static str, &'static str, String)> {
    let cfg_test = concat!("#[cf", "g(test)]");
    let path_attr = concat!("#[pa", "th = \"synth_tests.rs\"]");
    vec![
        (
            "a test-only mod at the crate root",
            "crate",
            format!("{cfg_test}\nmod synth_tests;\n"),
        ),
        (
            "a test-only path mod at the crate root, the rb-77 wiring form",
            "crate",
            format!("{cfg_test}\n{path_attr}\nmod synth_tests;\n"),
        ),
        (
            "a test-only path mod inside a scanned module",
            "synth",
            format!("{cfg_test}\n{path_attr}\nmod synth_tests;\n"),
        ),
        (
            "an inline test-only mod inside a scanned module",
            "synth",
            format!("{cfg_test}\nmod tests {{}}\n"),
        ),
        (
            "a helper returning an encounter table",
            "synth",
            format!("pub(crate) fn table_of({REDUCER_CTX}) -> EncounterTable {{\n    load()\n}}\n"),
        ),
    ]
}

#[test]
fn rb45_unsupported_shapes_are_hard_errors() {
    let owners = game_core::STATE_TRANSITION_OWNERS;
    let classified = classified_of(&["monster"]);

    let rows = refused_shapes();
    assert_eq!(
        rows.len(),
        13,
        "every refused shape in ADR-0258 D2 needs a row"
    );
    let distinct: BTreeSet<String> = rows
        .iter()
        .map(|row| {
            let sources = vec![(String::from(row.module), row.source.clone())];
            match census::census(&sources, &classified, owners) {
                Err(census::CensusError::UnsupportedShape { module, what }) => {
                    assert_eq!(module, row.module, "module reported for {}", row.label);
                    assert!(
                        what.to_lowercase().contains(row.keyword),
                        "the refusal for {} must name it with the keyword {}, got: {what}",
                        row.label,
                        row.keyword
                    );
                    what
                }
                other => {
                    panic!(
                        "{} must be refused as an unsupported shape, got {other:?}",
                        row.label
                    )
                }
            }
        })
        .collect();
    assert_eq!(
        distinct.len(),
        rows.len(),
        "each refused shape needs its OWN message; one catch-all cannot serve them all"
    );

    let broken = vec![(String::from("synth"), String::from("pub fn ( {"))];
    assert!(
        matches!(
            census::census(&broken, &classified, owners),
            Err(census::CensusError::Parse { .. })
        ),
        "unparseable source must be a parse error, never an empty census"
    );

    let twin = fixture_reducer(
        &fixture_reducer_attr(""),
        "twin",
        "",
        &[String::from(OK_TAIL)],
    );
    let duplicated = vec![
        (String::from("synth"), twin.clone()),
        (String::from("economy"), twin),
    ];
    assert!(
        matches!(
            census::census(&duplicated, &classified, owners),
            Err(census::CensusError::DuplicateReducer { .. })
        ),
        "one reducer name may carry only one verdict"
    );

    let accepted = accepted_shapes();
    assert_eq!(
        accepted.len(),
        5,
        "the accepted shapes keep the refusals from over-reaching"
    );
    for (label, module, source) in accepted {
        let sources = vec![(String::from(module), source)];
        census::census(&sources, &classified, owners)
            .unwrap_or_else(|e| panic!("{label} must be accepted, got {e:?}"));
    }
}

#[test]
fn rb45_real_crate_matches_the_rosters() {
    let derived: BTreeSet<&str> = crate::schema::DATA_LIFECYCLE_MANIFEST
        .iter()
        .filter(|entry| !matches!(entry.policy, crate::schema::DeletionPolicy::NotOwned))
        .map(|entry| entry.table)
        .collect();
    assert!(
        derived.len() >= CLASSIFIED_TABLE_FLOOR,
        "the manifest classifies {} tables, below the rb-45 floor",
        derived.len()
    );
    let classified = census::classified_tables();
    assert_eq!(
        classified, derived,
        "the classified set IS the manifest minus NotOwned"
    );
    for table in ["monster", "battle", "pvp_deadline_schedule"] {
        assert!(classified.contains(table), "{table} is manifest-classified");
    }
    assert!(
        !classified.contains("config"),
        "a not-owned table is out of scope"
    );

    let owners = game_core::STATE_TRANSITION_OWNERS;
    let sources = census::real_sources().expect("real_sources must read the crate");
    let report =
        census::census(&sources, &classified, owners).expect("the real corpus must census cleanly");

    let want_n: usize = sources
        .iter()
        .map(|(_, source)| {
            source
                .lines()
                .filter(|line| line.trim_start().starts_with(REDUCER_ATTR_HEAD))
                .count()
        })
        .sum();
    assert!(
        want_n >= REDUCER_FLOOR,
        "the corpus carries {want_n} reducer attributes, below the rb-45 floor"
    );
    assert_eq!(
        report.verdicts.len(),
        want_n,
        "every reducer attribute in the corpus gets exactly one verdict"
    );

    if let Err(msg) = roster_mismatch(&report, DELIBERATE_EXEMPTIONS) {
        panic!("{msg}");
    }

    let lifecycle: BTreeSet<&str> = EXPECTED_LIFECYCLE.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Lifecycle)),
        lifecycle,
        "the lifecycle exemption set is pinned exactly"
    );

    let scheduled: BTreeSet<&str> = EXPECTED_SCHEDULED.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Scheduled)),
        scheduled,
        "the scheduled exemption set is pinned exactly"
    );

    let owner_set: BTreeSet<&str> = owners.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Owner)),
        owner_set,
        "every owner is a real reducer and nothing else is exempt as one"
    );

    let gated: BTreeSet<&str> = EXPECTED_GATED.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Gated { .. })),
        gated,
        "the gated set is pinned exactly, so losing a gate fails CI too"
    );

    let no_writes: BTreeSet<&str> = EXPECTED_NO_WRITES.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::NoClassifiedWrites)),
        no_writes,
        "only these reducers reach no classified write at all"
    );

    assert_eq!(
        report.modules.first().map(String::as_str),
        Some("crate"),
        "lib.rs is the first corpus entry"
    );
    let modules: Vec<&str> = report.modules.iter().map(String::as_str).collect();
    assert_eq!(
        modules,
        EXPECTED_MODULES.to_vec(),
        "the corpus is lib.rs plus its bare mods"
    );

    for name in ["grant_bait", "start_wild_battle"] {
        assert!(
            matches!(verdict_of(&report, name), census::Verdict::Gated { .. }),
            "{name} is gated today and is scanned even though its cfg hides it"
        );
    }

    for &(name, _basis) in DELIBERATE_EXEMPTIONS {
        assert!(
            report.verdicts.contains_key(name),
            "roster row {name} names a reducer that no longer exists"
        );
    }
}
