//! rb-74 — the gating oracle for the in-place DATED RETARGET of the stale
//! `lib.rs:NNNN` citations that M8.9 / ADR-0056 stranded when the monolith was
//! split into domain submodules (`lib.rs` is 349 lines today, so every one of
//! those line numbers dangles).
//!
//! The fix this file gates is NOT a renumber. Each citation KEEPS its historical
//! number (it is true at the document's own declared base commit) and GAINS a
//! live anchor in a bracket immediately after it. Twelve of the fifteen anchors
//! are a DECLARATION; the other three cite a STATEMENT, and those name the
//! statement together with the declaration that CONTAINS it, so every bracket
//! still resolves through a named declaration. The oracle pins the *pair*, not
//! either half:
//!
//!   L1 COMPOSED   — the whole `token + bracket + anchor + file` literal occurs
//!                   EXACTLY ONCE in its own document (bijection + adjacency +
//!                   ordering in one exact-substring check).
//!   L2 RESOLUTION — each anchor occurs EXACTLY ONCE in its named file, and that
//!                   file is on a HARDCODED 22-name production allow-list (never
//!                   derived from `lib.rs`'s `mod` lines — that would admit the
//!                   `#[cfg(test)]` modules and let a production claim be
//!                   retargeted onto a test file). Statement-level rows resolve
//!                   by CONTAINMENT inside the declaration's body window;
//!                   attribute-level rows pin the attribute's exact identity.
//!   L3 CENSUS     — per document, the EXACT multiset of citation tokens, split
//!                   into server-module vs FOREIGN buckets, plus a zero-floor on
//!                   malformed/compound tokens.
//!   L4 REMOVED    — the three `removed`-class rows are a HARDCODED set; the
//!                   deleted clause must occur ZERO times across all 22
//!                   allow-listed sources (and still occur in the document, so a
//!                   mistyped needle cannot pass vacuously).
//!   L5 RANGE      — the two CONFIRM documents are measured-accurate and must
//!                   stay byte-untouched in substance: their own quoted premise,
//!                   split on U+2026, resolves inside the cited line range. The
//!                   size of the gated document set is pinned FIRST, so deleting
//!                   a CONFIRM entry cannot make the leg vacuous.
//!   L6 ROSTER     — roster self-consistency, the per-document bracket census in
//!                   BOTH spellings (contiguous run and bare namespace prefix),
//!                   and the dated preamble (EOF-anchored, so it shifts no line).
//!   L7 SUBJECT    — each bracket stays beside the SUBJECT it annotates: the
//!                   backticked span immediately left of the citation on its own
//!                   line is pinned per row, and that subject's identifier must
//!                   occur in the anchor text the row retargets onto. Without
//!                   this, two citations on one line can be swapped and every
//!                   other leg stays green while the document tells a lie.
//!
//! SCAN HYGIENE (the house rule; precedent + rule statement at
//! `accounts_tests.rs:16844-16854`): several evals concatenate
//! `server-module/src/**/*.rs` wholesale, so a contiguous production needle in
//! THIS file becomes a false positive somewhere else. Every anchor, every
//! phrase-needle and every composed fragment below is therefore assembled from
//! `concat!` pieces that break the identifier. This file carries no table or
//! reducer attribute, no block comment and no raw string.
//!
//! WIRING (load-bearing, measured): the `mod` declaration for this file is
//! APPENDED AT THE END of `lib.rs`, not placed beside the three existing
//! `#[cfg(test)]` modules near the top. Inserting it there shifts every later
//! line by +4 and breaks a sibling ADR's executed line pins, which live outside
//! this slice's touch-set. Appending at EOF shifts nothing.

// ---------------------------------------------------------------------------
// Documents under gate
// ---------------------------------------------------------------------------

const RB74_DOC_0221: usize = 0;
const RB74_DOC_0054: usize = 1;
const RB74_DOC_87B: usize = 2;
const RB74_DOC_87D: usize = 3;

/// One gated document: its path (for messages), its text, the base commit its
/// line numbers are true at, and the EXACT citation-token census it must carry.
struct Rb74Doc {
    key: &'static str,
    text: &'static str,
    base: &'static str,
    cites: &'static [&'static str],
    foreign: &'static [&'static str],
    retargeted: bool,
}

const RB74_CITES_0221: &[&str] = &["lib.rs:214-231"];

const RB74_CITES_0054: &[&str] = &[
    "server-module/src/lib.rs:1484",
    "server-module/src/lib.rs:2064",
    "lib.rs:939",
    "lib.rs:1492-1502",
    "lib.rs:940",
    "lib.rs:1868",
    "lib.rs:67",
    "lib.rs:273-274",
];

const RB74_CITES_87B: &[&str] = &[
    "lib.rs:1483",
    "lib.rs:2063",
    "lib.rs:1492-1502",
    "lib.rs:273-274",
];

const RB74_CITES_87D: &[&str] = &["server-module/src/lib.rs:275-276", "lib.rs:152"];

const RB74_CITES_NONE: &[&str] = &[];

const RB74_FOREIGN_NONE: &[&str] = &[];

const RB74_FOREIGN_SIM: &[&str] = &["sim-harness/src/lib.rs:222-226"];

/// The size of the gated document set, pinned so no leg can be emptied into
/// vacuity by deleting an entry. Four retargeted documents plus the two
/// MEASURED-ACCURATE CONFIRM documents, which are gated precisely so a
/// well-meaning editor cannot "fix" a citation that is already right.
const RB74_DOC_COUNT: usize = 6;
const RB74_CONFIRM_DOCS: usize = 2;

const RB74_DOCS: &[Rb74Doc] = &[
    Rb74Doc {
        key: "docs/adr/0221-account-deletion-reaper-schedule-declared.md",
        text: include_str!("../../docs/adr/0221-account-deletion-reaper-schedule-declared.md"),
        base: "5962b7a",
        cites: RB74_CITES_0221,
        foreign: RB74_FOREIGN_NONE,
        retargeted: true,
    },
    Rb74Doc {
        key: "docs/adr/0054-dev-reducer-release-gating.md",
        text: include_str!("../../docs/adr/0054-dev-reducer-release-gating.md"),
        base: "6187102",
        cites: RB74_CITES_0054,
        foreign: RB74_FOREIGN_NONE,
        retargeted: true,
    },
    Rb74Doc {
        key: "docs/m8.7b-plan.md",
        text: include_str!("../../docs/m8.7b-plan.md"),
        base: "6187102",
        cites: RB74_CITES_87B,
        foreign: RB74_FOREIGN_NONE,
        retargeted: true,
    },
    Rb74Doc {
        key: "docs/m8.7d-plan.md",
        text: include_str!("../../docs/m8.7d-plan.md"),
        base: "d0c265e",
        cites: RB74_CITES_87D,
        foreign: RB74_FOREIGN_NONE,
        retargeted: true,
    },
    Rb74Doc {
        key: "docs/specs/nh2-plan.md",
        text: include_str!("../../docs/specs/nh2-plan.md"),
        base: "",
        cites: RB74_CITES_NONE,
        foreign: RB74_FOREIGN_SIM,
        retargeted: false,
    },
    Rb74Doc {
        key: "docs/adr/0148-held-key-continuation-outstanding-gate.md",
        text: include_str!("../../docs/adr/0148-held-key-continuation-outstanding-gate.md"),
        base: "",
        cites: RB74_CITES_NONE,
        foreign: RB74_FOREIGN_SIM,
        retargeted: false,
    },
];

// ---------------------------------------------------------------------------
// The HARDCODED production allow-list: `lib.rs` + the 21 domain submodules
// (ADR-0056's canonical `touches:` vocabulary). Deliberately NOT derived by
// scanning `lib.rs` for `mod` lines: that derivation admits the four
// `#[cfg(test)]` modules, and a doc could then retarget a production claim onto
// a test file and still pass.
// ---------------------------------------------------------------------------

const RB74_SOURCES: &[(&str, &str)] = &[
    ("server-module/src/lib.rs", include_str!("lib.rs")),
    ("server-module/src/accounts.rs", include_str!("accounts.rs")),
    ("server-module/src/battle.rs", include_str!("battle.rs")),
    ("server-module/src/content.rs", include_str!("content.rs")),
    (
        "server-module/src/content_cache.rs",
        include_str!("content_cache.rs"),
    ),
    ("server-module/src/economy.rs", include_str!("economy.rs")),
    (
        "server-module/src/evolution.rs",
        include_str!("evolution.rs"),
    ),
    ("server-module/src/guards.rs", include_str!("guards.rs")),
    (
        "server-module/src/inventory.rs",
        include_str!("inventory.rs"),
    ),
    ("server-module/src/marshal.rs", include_str!("marshal.rs")),
    (
        "server-module/src/monster_mgmt.rs",
        include_str!("monster_mgmt.rs"),
    ),
    ("server-module/src/movement.rs", include_str!("movement.rs")),
    ("server-module/src/npc.rs", include_str!("npc.rs")),
    (
        "server-module/src/observability.rs",
        include_str!("observability.rs"),
    ),
    ("server-module/src/playtest.rs", include_str!("playtest.rs")),
    ("server-module/src/privacy.rs", include_str!("privacy.rs")),
    ("server-module/src/pvp.rs", include_str!("pvp.rs")),
    ("server-module/src/raising.rs", include_str!("raising.rs")),
    ("server-module/src/ranking.rs", include_str!("ranking.rs")),
    ("server-module/src/schema.rs", include_str!("schema.rs")),
    ("server-module/src/taming.rs", include_str!("taming.rs")),
    ("server-module/src/trading.rs", include_str!("trading.rs")),
];

/// The CONFIRM documents' shared subject, read as text. Not on the production
/// allow-list on purpose — it is a different crate, and L5 is the only leg that
/// may read it.
const RB74_SIM_HARNESS: &str = include_str!("../../sim-harness/src/lib.rs");

// ---------------------------------------------------------------------------
// Live anchors — every DECLARATION anchor verified EXACTLY-ONCE in its named
// file, every CONTAINED statement verified exactly-once inside its declaration's
// body window. All assembled from `concat!` fragments that break the identifier
// so this file never carries a contiguous production needle.
// ---------------------------------------------------------------------------

/// `on_disconnect`'s head — the SOURCE MATERIAL the shared resolver bundle was
/// factored OUT of. Deliberately NOT the bundle function: that function did not
/// exist at 0221's base commit, and the citing sentence says "factor the bundle
/// FROM this", so anchoring the citation at the bundle would read "factor X
/// from X".
const RB74_A_DISCONNECT: &str = concat!("pub fn ", "on_disconnect(");

const RB74_A_START_WILD: &str = concat!("pub fn ", "start_wild_battle(");

const RB74_A_GRANT_BAIT: &str = concat!("pub fn ", "grant_bait(");

const RB74_A_MOVE_TICK: &str = concat!("pub fn ", "movement_tick(");

const RB74_A_GRANT_ITEM: &str = concat!("pub(crate) fn ", "grant_item(");

const RB74_A_CONTENT_VERSION: &str = concat!("pub content_", "version: u32,");

const RB74_A_INVENTORY: &str = concat!("pub struct Inv", "entory {");

const RB74_A_ENCOUNTER_ENTRY: &str = concat!("pub struct Encounter", "EntryRow {");

/// CONTAINED statement: the character existence-check bind. It is NOT unique in
/// the crate and must never be resolved file-wide — resolution is scoped to
/// `start_wild_battle`'s body. Resolution is TEXTUAL (`include_str!`), so the
/// `#[cfg]` gate on the enclosing item does not hide it.
const RB74_I_CHAR_BIND: &str = concat!(
    "let Some(character) = ctx.db.character",
    "().entity_id().find(player.entity_id) else {"
);

/// CONTAINED statement: the scheduler-only guard, in its 2.x spelling. MEASURED:
/// this line occurs 14 times across the module's own `.rs` sources, so a file-wide
/// uniqueness pin would make an ordinary second scheduler-only reducer in
/// `movement.rs` red a markdown-citation test. Scoped to `movement_tick`'s body.
const RB74_I_SCHED_GUARD: &str = concat!("if ctx.sender", "() != ctx.database_identity", "() {");

/// The document's OWN span for the scheduler-guard citation: the crate 1.x
/// spelling of the same guard. Fragmented like every other needle here, and for
/// a sharper reason than usual — `ctx.sender` in its field form and
/// `ctx.identity()` are exactly what the 1.x-to-2.x port scanners look for, so
/// this file must not carry either contiguously even inside a subject pin.
const RB74_S_SCHED_GUARD_1X: &str =
    concat!("if ctx.send", "er != ctx.ident", "ity() { return Err }");

/// Subject spans that are call-shaped in the document. Split so no fragment is
/// a call site on its own.
const RB74_S_START_WILD_CALL: &str = concat!("start_wild_battle", "(zone_id)");
const RB74_S_GRANT_BAIT_CALL: &str = concat!("grant_bait", "(item_id, qty)");

/// The EXACT attribute the two attribute-level rows cite. Identity, not shape:
/// a `#[` prefix test accepts an unrelated attribute (an `#[allow(...)]`)
/// inserted between the reducer attribute and the declaration, which silently
/// moves the cited line off the historical subject.
const RB74_ATTR_REDUCER: &str = concat!("#", "[spacetimedb", "::reducer", "]");

// ---------------------------------------------------------------------------
// The retarget SHAPE. One CONTIGUOUS literal per row, so token, bracket, anchor
// and file are pinned by a single exact-substring check.
// ---------------------------------------------------------------------------

/// The bracket opening as it must appear in running prose: one leading space,
/// one space after the colon.
const RB74_OPEN: &str = concat!(" [", "rb-74", ": ");
/// The bare NAMESPACE prefix. Counted separately from `RB74_OPEN` so every
/// spelling of the namespace is enumerated: a bracket at column 0 (no leading
/// space) and a bracket with no space after the colon are both invisible to the
/// contiguous-run count and both visible here.
const RB74_BARE_OPEN: &str = concat!("[", "rb-74", ":");
const RB74_ARROW: &str = "-> ";
const RB74_ATTR_PHRASE: &str = "the attribute line above ";
const RB74_REMOVED_PHRASE: &str = concat!("clause deleted by ", "M8.7d; live table ");
const RB74_INSIDE: &str = "` inside `";
const RB74_MID: &str = "` in `";

const RB74_PRE_A: &str = concat!(
    "**rb-74 retarget note (2026-09-11, ADR-0056):** the `lib.rs` line numbers cited above are ",
    "HISTORICAL, against this document's base commit `"
);
const RB74_PRE_B: &str = concat!(
    "`; M8.9 split `server-module/src/lib.rs` into domain submodules, so each stale citation ",
    "carries a bracketed live anchor immediately after it."
);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Rb74Kind {
    /// The cited subject still exists; the bracket names it in its new home.
    Live,
    /// The cited subject is the ATTRIBUTE LINE above a live declaration.
    AttrAbove,
    /// The cited CLAUSE was deleted outright; the bracket names the live table
    /// the claim was about, and L4 proves the clause is gone from every source.
    Removed,
}

/// One roster row.
///
/// `anchor` is the DECLARATION L2 resolves file-wide; `inner`, when present, is
/// the statement that must live inside that declaration's body. `subject` is the
/// backticked span the document must carry immediately before the citation on
/// its own line — the thing the bracket annotates. `None` means the citation
/// line names no backticked subject (the sentence's subject is on an earlier
/// line), and the count of such rows is pinned so a row cannot become
/// subject-less silently.
struct Rb74Row {
    id: &'static str,
    doc: usize,
    token: &'static str,
    backticked: bool,
    kind: Rb74Kind,
    anchor: &'static str,
    inner: Option<&'static str>,
    file: &'static str,
    subject: Option<&'static str>,
    note: &'static str,
}

/// Rows whose citation line carries no backticked subject before the token:
/// R1 (the token opens its line), R5 (the line opens `(` + token), R13 (the
/// subject is written in bare prose) and R14 (the token opens its list item).
const RB74_UNBOUND_ROWS: usize = 4;

/// Rows whose cited subject is a STATEMENT resolved by containment: R5, R6, R12.
const RB74_CONTAINED_ROWS: usize = 3;

const RB74_ROWS: &[Rb74Row] = &[
    Rb74Row {
        id: "R1",
        doc: RB74_DOC_0221,
        token: "lib.rs:214-231",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_DISCONNECT,
        inner: None,
        file: "server-module/src/lib.rs",
        subject: None,
        note: "; the bundle was factored OUT of this hook",
    },
    Rb74Row {
        id: "R2",
        doc: RB74_DOC_0054,
        token: "server-module/src/lib.rs:1484",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_START_WILD,
        inner: None,
        file: "server-module/src/battle.rs",
        subject: Some(RB74_S_START_WILD_CALL),
        note: "",
    },
    Rb74Row {
        id: "R3",
        doc: RB74_DOC_0054,
        token: "server-module/src/lib.rs:2064",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_GRANT_BAIT,
        inner: None,
        file: "server-module/src/taming.rs",
        subject: Some(RB74_S_GRANT_BAIT_CALL),
        note: "",
    },
    Rb74Row {
        id: "R4",
        doc: RB74_DOC_0054,
        token: "lib.rs:939",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_MOVE_TICK,
        inner: None,
        file: "server-module/src/movement.rs",
        subject: Some("movement_tick"),
        note: "",
    },
    Rb74Row {
        id: "R5",
        doc: RB74_DOC_0054,
        token: "lib.rs:1492-1502",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_START_WILD,
        inner: Some(RB74_I_CHAR_BIND),
        file: "server-module/src/battle.rs",
        subject: None,
        note: "",
    },
    Rb74Row {
        id: "R6",
        doc: RB74_DOC_0054,
        token: "lib.rs:940",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_MOVE_TICK,
        inner: Some(RB74_I_SCHED_GUARD),
        file: "server-module/src/movement.rs",
        subject: Some(RB74_S_SCHED_GUARD_1X),
        // The live anchor is the 2.x spelling and sits immediately beside the
        // document's own quoted 1.x spelling, so the respelling is visible in
        // the retarget without this file (or the document) re-typing the
        // deprecated form and perturbing any spelling census.
        note: "; same guard, respelled by the crate 1.x-to-2.x port (ADR-0197)",
    },
    Rb74Row {
        id: "R7",
        doc: RB74_DOC_0054,
        token: "lib.rs:1868",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_GRANT_ITEM,
        inner: None,
        file: "server-module/src/inventory.rs",
        subject: Some("grant_item"),
        note: "",
    },
    Rb74Row {
        id: "R8",
        doc: RB74_DOC_0054,
        token: "lib.rs:67",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_CONTENT_VERSION,
        inner: None,
        file: "server-module/src/schema.rs",
        subject: Some("Config.content_version"),
        note: "",
    },
    Rb74Row {
        id: "R9",
        doc: RB74_DOC_0054,
        token: "lib.rs:273-274",
        backticked: true,
        kind: Rb74Kind::Removed,
        anchor: RB74_A_INVENTORY,
        inner: None,
        file: "server-module/src/schema.rs",
        subject: Some("inventory"),
        note: "",
    },
    Rb74Row {
        id: "R10",
        doc: RB74_DOC_87B,
        token: "lib.rs:1483",
        backticked: false,
        kind: Rb74Kind::AttrAbove,
        anchor: RB74_A_START_WILD,
        inner: None,
        file: "server-module/src/battle.rs",
        subject: Some("start_wild_battle"),
        note: "",
    },
    Rb74Row {
        id: "R11",
        doc: RB74_DOC_87B,
        token: "lib.rs:2063",
        backticked: false,
        kind: Rb74Kind::AttrAbove,
        anchor: RB74_A_GRANT_BAIT,
        inner: None,
        file: "server-module/src/taming.rs",
        subject: Some("grant_bait"),
        note: "",
    },
    Rb74Row {
        id: "R12",
        doc: RB74_DOC_87B,
        token: "lib.rs:1492-1502",
        backticked: false,
        kind: Rb74Kind::Live,
        anchor: RB74_A_START_WILD,
        inner: Some(RB74_I_CHAR_BIND),
        file: "server-module/src/battle.rs",
        subject: Some("Character"),
        note: "",
    },
    Rb74Row {
        id: "R13",
        doc: RB74_DOC_87B,
        token: "lib.rs:273-274",
        backticked: false,
        kind: Rb74Kind::Removed,
        anchor: RB74_A_INVENTORY,
        inner: None,
        file: "server-module/src/schema.rs",
        subject: None,
        note: "",
    },
    Rb74Row {
        id: "R14",
        doc: RB74_DOC_87D,
        token: "server-module/src/lib.rs:275-276",
        backticked: true,
        kind: Rb74Kind::Removed,
        anchor: RB74_A_INVENTORY,
        inner: None,
        file: "server-module/src/schema.rs",
        subject: None,
        note: "",
    },
    Rb74Row {
        id: "R15",
        doc: RB74_DOC_87D,
        token: "lib.rs:152",
        backticked: false,
        kind: Rb74Kind::Live,
        anchor: RB74_A_ENCOUNTER_ENTRY,
        inner: None,
        file: "server-module/src/schema.rs",
        subject: Some("EncounterEntryRow"),
        note: "",
    },
];

/// The `removed` class as a HARDCODED set of (row id, document, deleted clause).
/// NEVER inferred from document prose: inference is exactly the hole that lets
/// an editor silently reclassify a LIVE row as `removed` to dodge L2.
const RB74_REMOVED_SET: &[(&str, usize, &str)] = &[
    ("R9", RB74_DOC_0054, RB74_DELETED_CLAUSE),
    ("R13", RB74_DOC_87B, RB74_DELETED_CLAUSE),
    ("R14", RB74_DOC_87D, RB74_DELETED_CLAUSE),
];

/// The deleted clause, backtick-free (both the backticked and the bare spelling
/// in the three documents normalize onto this).
const RB74_DELETED_CLAUSE: &str = concat!("RLS ", "by ", "owner_identity");

/// The FOREIGN token both CONFIRM documents carry, and whose numeric range L5
/// derives its bounds from (never re-typed).
const RB74_SIM_TOKEN: &str = concat!("sim-harness/src/", "lib.rs:222-226");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn rb74_count(hay: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    hay.matches(needle).count()
}

fn rb74_fail(label: &str, failures: &[String]) {
    assert!(
        failures.is_empty(),
        "{label} {} failure(s):\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}

fn rb74_token_text(row: &Rb74Row) -> String {
    let mut s = String::new();
    if row.backticked {
        s.push('`');
        s.push_str(row.token);
        s.push('`');
    } else {
        s.push_str(row.token);
    }
    s
}

/// THE required literal for one row: the token exactly as the document spells
/// it, then one contiguous bracket carrying the live anchor and its file. A
/// statement-level row names the statement AND the declaration containing it.
fn rb74_composed(row: &Rb74Row) -> String {
    let mut s = rb74_token_text(row);
    s.push_str(RB74_OPEN);
    match row.kind {
        Rb74Kind::Live => s.push_str(RB74_ARROW),
        Rb74Kind::AttrAbove => {
            s.push_str(RB74_ARROW);
            s.push_str(RB74_ATTR_PHRASE);
        }
        Rb74Kind::Removed => s.push_str(RB74_REMOVED_PHRASE),
    }
    s.push('`');
    if let Some(inner) = row.inner {
        s.push_str(inner);
        s.push_str(RB74_INSIDE);
    }
    s.push_str(row.anchor);
    s.push_str(RB74_MID);
    s.push_str(row.file);
    s.push('`');
    s.push_str(row.note);
    s.push(']');
    s
}

/// Everything the row's bracket claims about live source: the declaration, plus
/// the contained statement when there is one.
fn rb74_anchor_text(row: &Rb74Row) -> String {
    let mut s = String::from(row.anchor);
    if let Some(inner) = row.inner {
        s.push(' ');
        s.push_str(inner);
    }
    s
}

fn rb74_preamble(base: &str) -> String {
    let mut s = String::new();
    s.push_str(RB74_PRE_A);
    s.push_str(base);
    s.push_str(RB74_PRE_B);
    s
}

fn rb74_source(name: &str) -> Option<&'static str> {
    RB74_SOURCES
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, text)| *text)
}

/// 1-based line number of the byte at `idx`.
fn rb74_line_of(hay: &str, idx: usize) -> usize {
    hay[..idx].matches('\n').count() + 1
}

/// The body window of the declaration that starts at `anchor`: from the
/// declaration head to the first line that is exactly a closing brace at column
/// zero, inclusive.
///
/// WINDOW CHOICE, deliberate: neither a brace matcher nor a byte count. Rust
/// source in this tree carries braces inside string literals — `movement.rs`
/// builds JSON log lines that spell doubled braces — and inside comments, so a
/// naive brace counter desyncs, a failure mode this repo has measured. rustfmt
/// indents every nested closer, so after a top-level item the first column-zero
/// closer IS that item's terminator. A missing terminator is reported as a
/// FAILURE, never a silent widening to end-of-file.
fn rb74_body_window<'a>(text: &'a str, anchor: &str) -> Option<&'a str> {
    let start = text.find(anchor)?;
    let rest = &text[start..];
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if offset > 0 && line.starts_with('}') && line.trim_end() == "}" {
            return Some(&rest[..offset + line.len()]);
        }
        offset += line.len();
    }
    None
}

/// The backticked span sitting immediately to the LEFT of byte `at`, on that
/// byte's own line. `Ok(None)` means the line carries no backticked span before
/// the citation. An odd number of backticks cannot be paired and is an error
/// rather than a silent `None`.
fn rb74_preceding_span(doc: &str, at: usize) -> Result<Option<String>, String> {
    let line_start = doc[..at].rfind('\n').map_or(0, |i| i + 1);
    let left = &doc[line_start..at];
    let ticks = rb74_count(left, "`");
    if !ticks.is_multiple_of(2) {
        return Err(format!(
            "the text left of the citation has {ticks} backticks and cannot be paired"
        ));
    }
    if ticks == 0 {
        return Ok(None);
    }
    let close = left
        .rfind('`')
        .ok_or_else(|| "no closing backtick".to_string())?;
    let open = left[..close]
        .rfind('`')
        .ok_or_else(|| "no opening backtick".to_string())?;
    Ok(Some(left[open + 1..close].to_string()))
}

/// The longest `[a-z0-9_]` run in `s`, lowercased — the identifier a subject
/// span is ABOUT, DERIVED from the span rather than transcribed beside it.
fn rb74_longest_ident(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let best = lower
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .max_by_key(|t| t.len())
        .unwrap_or("");
    best.to_string()
}

/// The path-character class the citation grammar walks LEFT over.
fn rb74_path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'/' || b == b'-'
}

/// Parse `<path>:<lo>[-<hi>]` back into its numeric bounds, so L5's range is
/// DERIVED from the cited token rather than re-typed beside it.
fn rb74_token_range(token: &str) -> Option<(usize, usize)> {
    let colon = token.rfind(':')?;
    let nums = &token[colon + 1..];
    match nums.split_once('-') {
        Some((lo, hi)) => Some((lo.parse().ok()?, hi.parse().ok()?)),
        None => {
            let n: usize = nums.parse().ok()?;
            Some((n, n))
        }
    }
}

/// Census of citation tokens in `doc`, returned as
/// `(server_module_tokens, foreign_tokens, malformed_count)`.
///
/// The grammar walks LEFT over the path-character class so a foreign crate's
/// `lib.rs` is classified FOREIGN rather than counted as a server-module cite,
/// and is PREFIX-FREE on the right: the byte after the number may not be a
/// digit, `-` or `/`, so a smuggled compound cannot be swallowed as one token
/// and a short token can never be satisfied by a longer one.
fn rb74_scan_cites(doc: &str) -> (Vec<String>, Vec<String>, usize) {
    let needle = concat!("lib", ".rs:");
    let bytes = doc.as_bytes();
    let mut server: Vec<String> = Vec::new();
    let mut foreign: Vec<String> = Vec::new();
    let mut malformed = 0usize;
    let mut from = 0usize;
    while let Some(rel) = doc[from..].find(needle) {
        let start = from + rel;
        let after_colon = start + needle.len();
        from = after_colon;

        let mut j = after_colon;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j == after_colon {
            continue;
        }
        let mut end = j;
        if end < bytes.len() && bytes[end] == b'-' {
            let mut k = end + 1;
            while k < bytes.len() && bytes[k].is_ascii_digit() {
                k += 1;
            }
            if k > end + 1 {
                end = k;
            }
        }
        if end < bytes.len() {
            let next = bytes[end];
            if next.is_ascii_digit() || next == b'-' || next == b'/' {
                malformed += 1;
                continue;
            }
        }

        let mut p = start;
        while p > 0 && rb74_path_byte(bytes[p - 1]) {
            p -= 1;
        }
        let path = &doc[p..start + 6];
        let full = doc[p..end].to_string();
        if path == "lib.rs" || path == "server-module/src/lib.rs" {
            server.push(full);
        } else {
            foreign.push(full);
        }
    }
    (server, foreign, malformed)
}

/// Whitespace-squash a body of text, dropping backticks and any leading `//` or
/// `///` comment marker, and return a parallel BYTE-indexed map from the
/// squashed text back to 1-based source line numbers.
fn rb74_squash(src: &str) -> (String, Vec<usize>) {
    let mut out = String::new();
    let mut map: Vec<usize> = Vec::new();
    for (idx, raw) in src.lines().enumerate() {
        let lineno = idx + 1;
        let mut body = raw.trim_start();
        if let Some(rest) = body.strip_prefix("///") {
            body = rest;
        } else if let Some(rest) = body.strip_prefix("//") {
            body = rest;
        }
        for ch in body.chars() {
            if ch == '`' {
                continue;
            }
            if ch.is_whitespace() {
                if out.is_empty() || out.ends_with(' ') {
                    continue;
                }
                out.push(' ');
                map.push(lineno);
            } else {
                out.push(ch);
                for _ in 0..ch.len_utf8() {
                    map.push(lineno);
                }
            }
        }
        if !out.is_empty() && !out.ends_with(' ') {
            out.push(' ');
            map.push(lineno);
        }
    }
    (out, map)
}

fn rb74_squash_text(src: &str) -> String {
    rb74_squash(src).0.trim().to_string()
}

/// Split the document's OWN quoted premise (the one immediately before
/// `token`) on U+2026 and return the two squashed fragments. The fragments are
/// DERIVED from the document — re-typing them here would make the leg a
/// self-oracle.
fn rb74_quoted_premise(doc: &str, token: &str) -> Result<(String, String), String> {
    let tok = doc
        .find(token)
        .ok_or_else(|| "cited token is absent".to_string())?;
    let close = doc[..tok]
        .rfind('"')
        .ok_or_else(|| "no closing quote before the cited token".to_string())?;
    let open = doc[..close]
        .rfind('"')
        .ok_or_else(|| "no opening quote before the closing quote".to_string())?;
    let quoted = &doc[open + 1..close];
    let ellipses = rb74_count(quoted, "\u{2026}");
    if ellipses != 1 {
        return Err(format!(
            "the quoted premise must carry exactly one U+2026 ellipsis, found {ellipses}"
        ));
    }
    let mut parts = quoted.split('\u{2026}');
    let head = rb74_squash_text(parts.next().unwrap_or(""));
    let tail = rb74_squash_text(parts.next().unwrap_or(""));
    Ok((head, tail))
}

// ---------------------------------------------------------------------------
// L1 COMPOSED
// ---------------------------------------------------------------------------

/// Every roster row's fully composed literal occurs EXACTLY ONCE in its own
/// document. This is the leg that pins token-to-anchor BIJECTION, adjacency and
/// ordering in one check: a bracket attached to the wrong token, a bracket
/// naming the wrong anchor or the wrong file, a bracket detached from its token
/// by intervening prose, and a duplicated bracket all fail here. It does NOT
/// bind the bracket to the prose on its LEFT — that is L7's job.
#[test]
fn rb74_leg1_composed_literal_occurs_exactly_once_per_row() {
    let label = "[rb74/L1-COMPOSED]";
    let mut failures: Vec<String> = Vec::new();
    for row in RB74_ROWS {
        let doc = &RB74_DOCS[row.doc];
        let composed = rb74_composed(row);
        let hits = rb74_count(doc.text, &composed);
        if hits != 1 {
            failures.push(format!(
                "{} {}: expected the composed literal exactly once, found {hits}. Required \
                 literal (verbatim, one contiguous run): {composed}",
                row.id, doc.key
            ));
        }
    }
    rb74_fail(label, &failures);
}

// ---------------------------------------------------------------------------
// L2 RESOLUTION
// ---------------------------------------------------------------------------

/// Every declaration anchor resolves to EXACTLY ONE site in its named file, and
/// every named file is on the hardcoded 22-name production allow-list.
/// Statement-level rows additionally require their statement exactly once INSIDE
/// that declaration's body window — containment, so an ordinary new reducer
/// elsewhere in the same file cannot red a markdown-citation gate. The
/// attribute-level rows require the line above the declaration to be EXACTLY the
/// reducer attribute, which is the cited historical subject.
#[test]
fn rb74_leg2_anchors_resolve_uniquely_on_allowlisted_sources() {
    let label = "[rb74/L2-RESOLUTION]";
    let mut failures: Vec<String> = Vec::new();

    assert_eq!(
        RB74_SOURCES.len(),
        22,
        "{label} the production allow-list must hold lib.rs plus the 21 domain submodules"
    );
    assert_eq!(
        RB74_ROWS.iter().filter(|r| r.inner.is_some()).count(),
        RB74_CONTAINED_ROWS,
        "{label} the number of statement-level (contained) citations is PINNED — a row may \
         not drop its containment requirement silently"
    );

    for row in RB74_ROWS {
        let Some(text) = rb74_source(row.file) else {
            failures.push(format!(
                "[rb74/L2-ALLOWLIST] {}: {} is NOT on the 22-name production allow-list",
                row.id, row.file
            ));
            continue;
        };
        let hits = rb74_count(text, row.anchor);
        if hits != 1 {
            failures.push(format!(
                "[rb74/L2-DECL] {}: the declaration anchor must resolve exactly once in {}, \
                 found {hits}",
                row.id, row.file
            ));
            continue;
        }

        if let Some(inner) = row.inner {
            let Some(window) = rb74_body_window(text, row.anchor) else {
                failures.push(format!(
                    "[rb74/L2-CONTAINMENT] {}: no column-zero closing brace was found after \
                     the declaration in {}, so the body window is unbounded",
                    row.id, row.file
                ));
                continue;
            };
            let window_lines = window.lines().count();
            if window_lines < 3 {
                failures.push(format!(
                    "[rb74/L2-CONTAINMENT] {}: the body window in {} is degenerate \
                     ({window_lines} line(s)) and proves nothing",
                    row.id, row.file
                ));
                continue;
            }
            let inner_hits = rb74_count(window, inner);
            if inner_hits != 1 {
                failures.push(format!(
                    "[rb74/L2-CONTAINMENT] {}: the cited statement must occur exactly once \
                     INSIDE the declaration's {window_lines}-line body in {}, found \
                     {inner_hits}",
                    row.id, row.file
                ));
            }
        }

        if row.kind == Rb74Kind::AttrAbove {
            let idx = text.find(row.anchor).unwrap_or(0);
            let line_no = rb74_line_of(text, idx);
            let lines: Vec<&str> = text.lines().collect();
            if line_no < 2 {
                failures.push(format!(
                    "[rb74/L2-ATTRID] {}: the cited subject is the line ABOVE the declaration, \
                     but the declaration is on line {line_no} of {}",
                    row.id, row.file
                ));
                continue;
            }
            let above = lines[line_no - 2].trim();
            if above != RB74_ATTR_REDUCER {
                failures.push(format!(
                    "[rb74/L2-ATTRID] {}: line {} of {} must be EXACTLY the reducer attribute \
                     the citation points at, got: {above}",
                    row.id,
                    line_no - 1,
                    row.file
                ));
            }
        }
    }
    rb74_fail(label, &failures);
}

// ---------------------------------------------------------------------------
// L3 CENSUS
// ---------------------------------------------------------------------------

/// Per document, the EXACT multiset of citation tokens in BOTH buckets, plus a
/// zero-floor on malformed tokens. Asserting both buckets is what stops a
/// reclassification dodge: rewriting a server-module cite into a foreign-looking
/// path moves it between the two counts and reds here.
#[test]
fn rb74_leg3_citation_token_census_per_document() {
    let label = "[rb74/L3-CENSUS]";
    let mut failures: Vec<String> = Vec::new();

    for doc in RB74_DOCS {
        let (mut got, mut got_f, malformed) = rb74_scan_cites(doc.text);
        got.sort();
        got_f.sort();

        if malformed != 0 {
            failures.push(format!(
                "{}: {malformed} malformed/compound citation token(s) — a token's number must \
                 not be followed by a digit, a dash or a slash",
                doc.key
            ));
        }

        let mut want: Vec<String> = doc.cites.iter().copied().map(String::from).collect();
        want.sort();
        if got.len() != want.len() {
            failures.push(format!(
                "{}: expected {} server-module citation token(s), found {}: {:?}",
                doc.key,
                want.len(),
                got.len(),
                got
            ));
        }
        if got != want {
            failures.push(format!(
                "{}: server-module citation tokens changed. want {want:?}, got {got:?}",
                doc.key
            ));
        }

        let mut want_f: Vec<String> = doc.foreign.iter().copied().map(String::from).collect();
        want_f.sort();
        if got_f.len() != want_f.len() {
            failures.push(format!(
                "{}: expected {} FOREIGN citation token(s), found {}: {:?}",
                doc.key,
                want_f.len(),
                got_f.len(),
                got_f
            ));
        }
        if got_f != want_f {
            failures.push(format!(
                "{}: FOREIGN citation tokens changed. want {want_f:?}, got {got_f:?}",
                doc.key
            ));
        }
    }
    rb74_fail(label, &failures);
}

// ---------------------------------------------------------------------------
// L4 REMOVED-NEGATIVE
// ---------------------------------------------------------------------------

/// For every row in the HARDCODED `removed` set, the deleted clause occurs ZERO
/// times across all 22 allow-listed sources — and still occurs in the document
/// that talks about it, so a mistyped needle cannot pass the zero-count half
/// vacuously.
#[test]
fn rb74_leg4_removed_clauses_are_absent_from_every_module_source() {
    let label = "[rb74/L4-REMOVED]";
    let mut failures: Vec<String> = Vec::new();

    assert_eq!(
        RB74_REMOVED_SET.len(),
        3,
        "{label} the removed class is a fixed set of three rows"
    );

    for (id, doc_idx, clause) in RB74_REMOVED_SET {
        let doc = &RB74_DOCS[*doc_idx];

        let in_doc = rb74_count(&rb74_squash_text(doc.text), clause);
        if in_doc == 0 {
            failures.push(format!(
                "{id}: anti-vacuity — {} no longer mentions the deleted clause, so the \
                 zero-count below proves nothing",
                doc.key
            ));
        }

        for (name, text) in RB74_SOURCES {
            let hits = rb74_count(&rb74_squash_text(text), clause);
            if hits != 0 {
                failures.push(format!(
                    "{id}: the deleted clause still occurs {hits} time(s) in {name} — the row \
                     is classified removed but the claim is live"
                ));
            }
        }

        let classified = RB74_ROWS
            .iter()
            .any(|r| r.id == *id && r.kind == Rb74Kind::Removed && r.doc == *doc_idx);
        if !classified {
            failures.push(format!(
                "{id}: the roster row must be classified removed and live in {}",
                doc.key
            ));
        }
    }
    rb74_fail(label, &failures);
}

// ---------------------------------------------------------------------------
// L5 RANGE (the two CONFIRM documents)
// ---------------------------------------------------------------------------

/// The two CONFIRM documents are measured-accurate and are gated, not edited:
/// each still carries the foreign token exactly once, and the document's OWN
/// quoted premise — split on its own U+2026 — resolves inside the cited line
/// range, in order.
///
/// The set sizes are pinned FIRST. `RB74_DOCS` is this file's only collection
/// whose length the other legs do not fix, and deleting the two non-retargeted
/// entries would otherwise leave this leg examining nothing and every leg green.
#[test]
fn rb74_leg5_confirm_documents_quote_resolves_inside_the_cited_range() {
    let label = "[rb74/L5-RANGE]";
    let mut failures: Vec<String> = Vec::new();

    assert_eq!(
        RB74_DOCS.len(),
        RB74_DOC_COUNT,
        "[rb74/L5-RANGE/SETSIZE] the gated document set is four retargeted documents plus two \
         CONFIRM documents"
    );
    assert_eq!(
        RB74_DOCS.iter().filter(|d| !d.retargeted).count(),
        RB74_CONFIRM_DOCS,
        "[rb74/L5-RANGE/SETSIZE] L5 must examine exactly two CONFIRM documents — deleting one \
         makes this leg vacuous"
    );

    let Some((lo, hi)) = rb74_token_range(RB74_SIM_TOKEN) else {
        panic!("{label} the confirm token must parse into a line range");
    };
    let (squashed, map) = rb74_squash(RB74_SIM_HARNESS);
    assert_eq!(
        squashed.len(),
        map.len(),
        "{label} the squashed text and its line map must stay byte-aligned"
    );

    for doc in RB74_DOCS {
        if doc.retargeted {
            continue;
        }
        let tokens = rb74_count(doc.text, RB74_SIM_TOKEN);
        if tokens != 1 {
            failures.push(format!(
                "{}: expected the confirm token exactly once, found {tokens}",
                doc.key
            ));
        }
        let fragments = rb74_quoted_premise(doc.text, RB74_SIM_TOKEN);
        let (head, tail) = match fragments {
            Ok(pair) => pair,
            Err(why) => {
                failures.push(format!("{}: {why}", doc.key));
                continue;
            }
        };
        if head.len() < 20 || tail.len() < 20 {
            failures.push(format!(
                "{}: the derived fragments are too short to be discriminating \
                 (head {} bytes, tail {} bytes)",
                doc.key,
                head.len(),
                tail.len()
            ));
            continue;
        }

        let head_hits = rb74_count(&squashed, &head);
        let tail_hits = rb74_count(&squashed, &tail);
        if head_hits != 1 || tail_hits != 1 {
            failures.push(format!(
                "{}: each quoted fragment must occur exactly once in the cited file \
                 (head {head_hits}, tail {tail_hits}). head={head} tail={tail}",
                doc.key
            ));
            continue;
        }
        let head_line = map[squashed.find(&head).unwrap_or(0)];
        let tail_line = map[squashed.find(&tail).unwrap_or(0)];
        if head_line > tail_line {
            failures.push(format!(
                "{}: the quoted fragments resolve out of order (head line {head_line}, \
                 tail line {tail_line})",
                doc.key
            ));
        }
        if head_line < lo || head_line > hi || tail_line < lo || tail_line > hi {
            failures.push(format!(
                "{}: the assertion resolves to lines {head_line}..{tail_line}, outside the \
                 cited {lo}..={hi} — the citation is no longer accurate and must be \
                 re-derived from the source, never widened to fit",
                doc.key
            ));
        }
    }
    rb74_fail(label, &failures);
}

// ---------------------------------------------------------------------------
// L6 ROSTER + BRACKET NAMESPACE + PREAMBLE
// ---------------------------------------------------------------------------

/// Roster self-consistency, the per-document bracket census in BOTH spellings,
/// and the dated preamble.
///
/// The bracket census is what stops a partial retarget from hiding behind L1
/// (which only ever looks at rows it already knows about) and what stops decoy
/// brackets being sprinkled in. It counts the bare NAMESPACE prefix as well as
/// the contiguous running-prose spelling, because a bracket at column zero and a
/// bracket with no space after the colon are both invisible to the latter. The
/// preamble is required to be the LAST non-empty content of its document: an
/// inserted top-of-file line would shift every citation below it and break
/// inbound line pins from other files.
#[test]
fn rb74_leg6_roster_bracket_census_and_dated_preamble() {
    let label = "[rb74/L6-ROSTER]";
    let mut failures: Vec<String> = Vec::new();

    assert_eq!(RB74_ROWS.len(), 15, "{label} the roster is fifteen rows");

    for row in RB74_ROWS {
        if RB74_ROWS.iter().filter(|r| r.id == row.id).count() != 1 {
            failures.push(format!("{}: duplicate roster id", row.id));
        }
        if row.doc >= RB74_DOCS.len() {
            failures.push(format!("{}: roster row names no known document", row.id));
            continue;
        }
        if !RB74_DOCS[row.doc].retargeted {
            failures.push(format!(
                "{}: roster row points at a CONFIRM document, which must not be retargeted",
                row.id
            ));
        }
        if row.kind == Rb74Kind::AttrAbove && row.inner.is_some() {
            failures.push(format!(
                "{}: an attribute-level citation cannot also be statement-contained",
                row.id
            ));
        }
    }

    for (idx, doc) in RB74_DOCS.iter().enumerate() {
        let want_brackets = RB74_ROWS.iter().filter(|r| r.doc == idx).count();

        let got_brackets = rb74_count(doc.text, RB74_OPEN);
        if got_brackets != want_brackets {
            failures.push(format!(
                "[rb74/L6-BRACKETS] {}: expected exactly {want_brackets} rb-74 bracket(s) in \
                 running prose, found {got_brackets}",
                doc.key
            ));
        }

        let bare = rb74_count(doc.text, RB74_BARE_OPEN);
        if bare != want_brackets {
            failures.push(format!(
                "[rb74/L6-NAMESPACE] {}: the rb-74 bracket namespace must be exhaustively \
                 enumerated — expected {want_brackets} occurrence(s) of the bare prefix, \
                 found {bare}. Every spelling counts, including a bracket at column zero and \
                 a bracket with no space after the colon",
                doc.key
            ));
        }

        let preamble = rb74_preamble(doc.base);
        let hits = rb74_count(doc.text, &preamble);
        // The base-independent opening is counted separately, so a preamble that
        // names the WRONG base commit reds loudly (openings 1, full matches 0)
        // instead of reading as a missing preamble.
        let openings = rb74_count(doc.text, RB74_PRE_A);
        if doc.retargeted {
            if hits != 1 || openings != 1 {
                failures.push(format!(
                    "[rb74/L6-PREAMBLE] {}: expected the dated preamble exactly once (full \
                     matches {hits}, preamble openings {openings}). Required literal \
                     (verbatim): {preamble}",
                    doc.key
                ));
            } else {
                let at = doc.text.find(&preamble).unwrap_or(0);
                let tail = &doc.text[at + preamble.len()..];
                if !tail.trim().is_empty() {
                    failures.push(format!(
                        "[rb74/L6-PREAMBLE] {}: the preamble must be the LAST non-empty \
                         content of the file — inserting it higher shifts every line below it",
                        doc.key
                    ));
                }
            }
        } else if openings != 0 || hits != 0 {
            failures.push(format!(
                "[rb74/L6-PREAMBLE] {}: a CONFIRM document is measured-accurate and must \
                 carry no rb-74 preamble (openings {openings}, full matches {hits})",
                doc.key
            ));
        }
    }
    rb74_fail(label, &failures);
}

// ---------------------------------------------------------------------------
// L7 SUBJECT
// ---------------------------------------------------------------------------

/// A bracket must stay beside the SUBJECT it annotates.
///
/// L1 pins `token + bracket` as one contiguous run, but says nothing about the
/// prose to the LEFT of the token. MEASURED bypass that motivated this leg: on a
/// line carrying two citations, swap the two subject names and leave both
/// brackets where they are. L1, L2, L3 and L6 all stay green, and the document
/// now asserts that the wrong function lived at the cited line.
///
/// Two independent checks per row:
///
///  * BIND — the backticked span immediately left of the citation, ON ITS OWN
///    LINE, equals the subject pinned for that row. Rows whose citation line
///    carries no backticked subject are declared `None` as explicit per-row
///    data, and the number of such rows is pinned, so "no subject here" can
///    never be a silent skip.
///  * LINK — the subject's longest identifier, DERIVED from the span rather
///    than transcribed, must occur in the anchor text the row retargets onto.
///    This is what makes the BIND pin a claim about the code rather than a
///    transcription of the prose: the subject and the anchor are independent
///    constants, and changing one without the other reds here.
#[test]
fn rb74_leg7_bracket_binds_the_subject_named_beside_it() {
    let label = "[rb74/L7-SUBJECT]";
    let mut failures: Vec<String> = Vec::new();

    assert_eq!(
        RB74_ROWS.iter().filter(|r| r.subject.is_none()).count(),
        RB74_UNBOUND_ROWS,
        "{label} the number of rows whose citation line names no backticked subject is \
         PINNED — a row may not become subject-less silently"
    );

    for row in RB74_ROWS {
        let doc = &RB74_DOCS[row.doc];
        let composed = rb74_composed(row);
        let Some(at) = doc.text.find(&composed) else {
            failures.push(format!(
                "[rb74/L7-SUBJECT/SITE] {} {}: the composed literal is absent, so the subject \
                 beside it cannot be read (L1 reports the literal)",
                row.id, doc.key
            ));
            continue;
        };
        let span = match rb74_preceding_span(doc.text, at) {
            Ok(found) => found,
            Err(why) => {
                failures.push(format!(
                    "[rb74/L7-SUBJECT/TICKS] {} {}: {why}",
                    row.id, doc.key
                ));
                continue;
            }
        };

        match (row.subject, span) {
            (None, None) => {}
            (None, Some(found)) => failures.push(format!(
                "[rb74/L7-SUBJECT/BIND] {} {}: this row is declared subject-less, but its \
                 citation line now names `{found}` before the token — declare the subject or \
                 move the citation",
                row.id, doc.key
            )),
            (Some(want), None) => failures.push(format!(
                "[rb74/L7-SUBJECT/BIND] {} {}: the citation line no longer names its subject \
                 `{want}` before the token",
                row.id, doc.key
            )),
            (Some(want), Some(found)) => {
                if found != want {
                    failures.push(format!(
                        "[rb74/L7-SUBJECT/BIND] {} {}: the backticked span immediately before \
                         the citation is `{found}`, but this row annotates `{want}` — a \
                         citation must stay beside the subject it describes",
                        row.id, doc.key
                    ));
                }
            }
        }

        if let Some(want) = row.subject {
            let ident = rb74_longest_ident(want);
            let hay = rb74_anchor_text(row).to_ascii_lowercase();
            if ident.is_empty() || !hay.contains(&ident) {
                failures.push(format!(
                    "[rb74/L7-SUBJECT/LINK] {} {}: the subject's identifier `{ident}` does not \
                     occur in the live anchor text this citation retargets onto — the document \
                     and the bracket are talking about different things",
                    row.id, doc.key
                ));
            }
        }
    }
    rb74_fail(label, &failures);
}
