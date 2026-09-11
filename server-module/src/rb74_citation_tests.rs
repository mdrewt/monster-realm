//! rb-74 — the gating oracle for the in-place DATED RETARGET of the stale
//! `lib.rs:NNNN` citations that M8.9 / ADR-0056 stranded when the monolith was
//! split into domain submodules (`lib.rs` is 349 lines today, so every one of
//! those line numbers dangles).
//!
//! The fix this file gates is NOT a renumber. Each citation KEEPS its historical
//! number (it is true at the document's own declared base commit) and GAINS a
//! declaration-shaped LIVE anchor in a bracket immediately after it. The oracle
//! therefore pins the *pair*, not either half:
//!
//!   L1 COMPOSED   — the whole `token + bracket + anchor + file` literal occurs
//!                   EXACTLY ONCE in its own document (bijection + adjacency +
//!                   ordering in one exact-substring check).
//!   L2 RESOLUTION — each live anchor occurs EXACTLY ONCE in its named file, and
//!                   that file is on a HARDCODED 22-name production allow-list
//!                   (never derived from `lib.rs`'s `mod` lines — that would
//!                   admit the four `#[cfg(test)]` modules and let a production
//!                   claim be retargeted onto a test file).
//!   L3 CENSUS     — per document, the EXACT multiset of citation tokens, split
//!                   into server-module vs FOREIGN buckets, plus a zero-floor on
//!                   malformed/compound tokens.
//!   L4 REMOVED    — the three `removed`-class rows are a HARDCODED set; the
//!                   deleted clause must occur ZERO times across all 22
//!                   allow-listed sources (and still occur in the document, so a
//!                   mistyped needle cannot pass vacuously).
//!   L5 RANGE      — the two CONFIRM documents are measured-accurate and must
//!                   stay byte-untouched in substance: their own quoted premise,
//!                   split on U+2026, resolves inside the cited line range.
//!   L6 ROSTER     — roster self-consistency, per-document bracket counts, and
//!                   the dated preamble (EOF-anchored, so it shifts no line).
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

/// The two documents that are MEASURED-ACCURATE and must NOT be retargeted.
/// Gating them as CONFIRM rows is what stops a well-meaning editor from
/// "fixing" a citation that is already right.
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
// Live anchors — every one verified EXACTLY-ONCE in its named file, and every
// one assembled from `concat!` fragments that break the identifier so this file
// never carries a contiguous production needle.
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

/// The character existence-check bind inside the dev-gated wild-battle reducer.
/// Resolution is TEXTUAL (`include_str!`), so the `#[cfg]` gate on the enclosing
/// item does not hide it.
const RB74_A_CHAR_BIND: &str = concat!(
    "let Some(character) = ctx.db.character",
    "().entity_id().find(player.entity_id) else {"
);

/// The scheduler-only guard, in its 2.x spelling.
const RB74_A_SCHED_GUARD: &str = concat!("if ctx.sender", "() != ctx.database_identity", "() {");

const RB74_A_GRANT_ITEM: &str = concat!("pub(crate) fn ", "grant_item(");

const RB74_A_CONTENT_VERSION: &str = concat!("pub content_", "version: u32,");

const RB74_A_INVENTORY: &str = concat!("pub struct Inv", "entory {");

const RB74_A_ENCOUNTER_ENTRY: &str = concat!("pub struct Encounter", "EntryRow {");

/// An attribute line's opening token, for the two rows whose historical subject
/// is the ATTRIBUTE ABOVE a reducer (their documents' own task is "outermost
/// attr, ABOVE the reducer attribute", so pointing at the attribute is CORRECT,
/// not an off-by-one).
const RB74_ATTR_OPEN: &str = concat!("#", "[");

// ---------------------------------------------------------------------------
// The retarget SHAPE. One CONTIGUOUS literal per row, so token, bracket, anchor
// and file are pinned by a single exact-substring check.
// ---------------------------------------------------------------------------

const RB74_OPEN: &str = concat!(" [", "rb-74", ": ");
const RB74_ARROW: &str = "-> ";
const RB74_ATTR_PHRASE: &str = "the attribute line above ";
const RB74_REMOVED_PHRASE: &str = concat!("clause deleted by ", "M8.7d; live table ");
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

/// One roster row. `anchor` and `file` are what L2 resolves; `composed()` is
/// what L1 requires verbatim in `doc`. Building the composed literal FROM the
/// anchor and file means the document can never name one anchor while the
/// resolution leg checks another.
struct Rb74Row {
    id: &'static str,
    doc: usize,
    token: &'static str,
    backticked: bool,
    kind: Rb74Kind,
    anchor: &'static str,
    file: &'static str,
    note: &'static str,
}

const RB74_ROWS: &[Rb74Row] = &[
    Rb74Row {
        id: "R1",
        doc: RB74_DOC_0221,
        token: "lib.rs:214-231",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_DISCONNECT,
        file: "server-module/src/lib.rs",
        note: "; the bundle was factored OUT of this hook",
    },
    Rb74Row {
        id: "R2",
        doc: RB74_DOC_0054,
        token: "server-module/src/lib.rs:1484",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_START_WILD,
        file: "server-module/src/battle.rs",
        note: "",
    },
    Rb74Row {
        id: "R3",
        doc: RB74_DOC_0054,
        token: "server-module/src/lib.rs:2064",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_GRANT_BAIT,
        file: "server-module/src/taming.rs",
        note: "",
    },
    Rb74Row {
        id: "R4",
        doc: RB74_DOC_0054,
        token: "lib.rs:939",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_MOVE_TICK,
        file: "server-module/src/movement.rs",
        note: "",
    },
    Rb74Row {
        id: "R5",
        doc: RB74_DOC_0054,
        token: "lib.rs:1492-1502",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_CHAR_BIND,
        file: "server-module/src/battle.rs",
        note: "",
    },
    Rb74Row {
        id: "R6",
        doc: RB74_DOC_0054,
        token: "lib.rs:940",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_SCHED_GUARD,
        file: "server-module/src/movement.rs",
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
        file: "server-module/src/inventory.rs",
        note: "",
    },
    Rb74Row {
        id: "R8",
        doc: RB74_DOC_0054,
        token: "lib.rs:67",
        backticked: true,
        kind: Rb74Kind::Live,
        anchor: RB74_A_CONTENT_VERSION,
        file: "server-module/src/schema.rs",
        note: "",
    },
    Rb74Row {
        id: "R9",
        doc: RB74_DOC_0054,
        token: "lib.rs:273-274",
        backticked: true,
        kind: Rb74Kind::Removed,
        anchor: RB74_A_INVENTORY,
        file: "server-module/src/schema.rs",
        note: "",
    },
    Rb74Row {
        id: "R10",
        doc: RB74_DOC_87B,
        token: "lib.rs:1483",
        backticked: false,
        kind: Rb74Kind::AttrAbove,
        anchor: RB74_A_START_WILD,
        file: "server-module/src/battle.rs",
        note: "",
    },
    Rb74Row {
        id: "R11",
        doc: RB74_DOC_87B,
        token: "lib.rs:2063",
        backticked: false,
        kind: Rb74Kind::AttrAbove,
        anchor: RB74_A_GRANT_BAIT,
        file: "server-module/src/taming.rs",
        note: "",
    },
    Rb74Row {
        id: "R12",
        doc: RB74_DOC_87B,
        token: "lib.rs:1492-1502",
        backticked: false,
        kind: Rb74Kind::Live,
        anchor: RB74_A_CHAR_BIND,
        file: "server-module/src/battle.rs",
        note: "",
    },
    Rb74Row {
        id: "R13",
        doc: RB74_DOC_87B,
        token: "lib.rs:273-274",
        backticked: false,
        kind: Rb74Kind::Removed,
        anchor: RB74_A_INVENTORY,
        file: "server-module/src/schema.rs",
        note: "",
    },
    Rb74Row {
        id: "R14",
        doc: RB74_DOC_87D,
        token: "server-module/src/lib.rs:275-276",
        backticked: true,
        kind: Rb74Kind::Removed,
        anchor: RB74_A_INVENTORY,
        file: "server-module/src/schema.rs",
        note: "",
    },
    Rb74Row {
        id: "R15",
        doc: RB74_DOC_87D,
        token: "lib.rs:152",
        backticked: false,
        kind: Rb74Kind::Live,
        anchor: RB74_A_ENCOUNTER_ENTRY,
        file: "server-module/src/schema.rs",
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
/// it, then one contiguous bracket carrying the live anchor and its file.
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
    s.push_str(row.anchor);
    s.push_str(RB74_MID);
    s.push_str(row.file);
    s.push('`');
    s.push_str(row.note);
    s.push(']');
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
/// by intervening prose, and a duplicated bracket all fail here.
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

/// Every live anchor resolves to EXACTLY ONE site in its named file, and every
/// named file is on the hardcoded 22-name production allow-list. The two
/// `AttrAbove` rows additionally require that the line directly above the
/// resolved declaration really IS an attribute line — the claim their brackets
/// make.
#[test]
fn rb74_leg2_anchors_resolve_uniquely_on_allowlisted_sources() {
    let label = "[rb74/L2-RESOLUTION]";
    let mut failures: Vec<String> = Vec::new();

    assert_eq!(
        RB74_SOURCES.len(),
        22,
        "{label} the production allow-list must hold lib.rs plus the 21 domain submodules"
    );

    for row in RB74_ROWS {
        let Some(text) = rb74_source(row.file) else {
            failures.push(format!(
                "{}: {} is NOT on the 22-name production allow-list",
                row.id, row.file
            ));
            continue;
        };
        let hits = rb74_count(text, row.anchor);
        if hits != 1 {
            failures.push(format!(
                "{}: anchor must resolve exactly once in {}, found {hits}",
                row.id, row.file
            ));
            continue;
        }
        if row.kind == Rb74Kind::AttrAbove {
            let idx = text.find(row.anchor).unwrap_or(0);
            let line_no = rb74_line_of(text, idx);
            let lines: Vec<&str> = text.lines().collect();
            if line_no < 2 {
                failures.push(format!(
                    "{}: the cited subject is the line ABOVE the declaration, but the \
                     declaration is on line {line_no} of {}",
                    row.id, row.file
                ));
                continue;
            }
            let above = lines[line_no - 2].trim_start();
            if !above.starts_with(RB74_ATTR_OPEN) {
                failures.push(format!(
                    "{}: line {} of {} must be an attribute line (the cited subject), got: {above}",
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
#[test]
fn rb74_leg5_confirm_documents_quote_resolves_inside_the_cited_range() {
    let label = "[rb74/L5-RANGE]";
    let mut failures: Vec<String> = Vec::new();

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
// L6 ROSTER + PREAMBLE
// ---------------------------------------------------------------------------

/// Roster self-consistency, the per-document bracket census, and the dated
/// preamble. The bracket census is what stops a partial retarget from hiding
/// behind L1 (which only ever looks at rows it already knows about) and what
/// stops decoy brackets being sprinkled in. The preamble is required to be the
/// LAST non-empty content of its document: an inserted top-of-file line would
/// shift every citation below it and break inbound line pins from other files.
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
        let composed = rb74_composed(row);
        if !composed.starts_with(&rb74_token_text(row)) {
            failures.push(format!(
                "{}: composed literal must open with its token",
                row.id
            ));
        }
        if !composed.contains(row.anchor) || !composed.contains(row.file) {
            failures.push(format!(
                "{}: composed literal must carry its own anchor and file",
                row.id
            ));
        }
    }

    for (idx, doc) in RB74_DOCS.iter().enumerate() {
        let want_brackets = RB74_ROWS.iter().filter(|r| r.doc == idx).count();
        let got_brackets = rb74_count(doc.text, RB74_OPEN);
        if got_brackets != want_brackets {
            failures.push(format!(
                "{}: expected exactly {want_brackets} rb-74 bracket(s), found {got_brackets}",
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
                    "{}: expected the dated preamble exactly once (full matches {hits}, \
                     preamble openings {openings}). Required literal (verbatim): {preamble}",
                    doc.key
                ));
            } else {
                let at = doc.text.find(&preamble).unwrap_or(0);
                let tail = &doc.text[at + preamble.len()..];
                if !tail.trim().is_empty() {
                    failures.push(format!(
                        "{}: the preamble must be the LAST non-empty content of the file — \
                         inserting it higher shifts every line below it",
                        doc.key
                    ));
                }
            }
        } else if openings != 0 || hits != 0 {
            failures.push(format!(
                "{}: a CONFIRM document is measured-accurate and must carry no rb-74 \
                 preamble (openings {openings}, full matches {hits})",
                doc.key
            ));
        }
    }
    rb74_fail(label, &failures);
}
