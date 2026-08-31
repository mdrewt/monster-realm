//! `privacy_tests` — gating tests for rb-22 (ADR-0220): the pre-claim
//! `export_bundle` orphan, purged at claim time by `privacy::purge_export_bundles`.
//!
//! Declared from `privacy.rs` as a cfg-test-gated `#[path]` module declaration
//! (the accounts.rs:608-610 form; the exact token sequence is pinned by the
//! accounts_tests.rs arm, and is deliberately not spelled contiguously anywhere
//! in this file). THAT PARENT DECLARATION IS LOAD-BEARING TWICE:
//!   - it is what compiles this module at all, so every `rb22p_` test below
//!     silently ceases to exist without it (the accounts_tests.rs arm pins it,
//!     because a test cannot prove its own existence); and
//!   - it is the ONLY thing that justifies this file's exclusion from
//!     `monster-privacy.eval.mjs`'s scan surface. That eval accepts either a raw
//!     outer cfg-test attribute inside the file OR a gated parent declaration,
//!     and an inner `#![cfg(test)]` does NOT contain the substring the eval
//!     searches for — so the parent form is the justification here, deliberately.
//!
//! WHAT THIS GATES (EO-2 / EO-3 / EO-5): the helper is declared exactly once with
//! the frozen owner-generic signature; its body is EXACTLY the sanctioned
//! filter-collect-delete sequence; it filters by the owner btree index and never
//! sweeps the whole table; it has no early return; it writes `export_bundle` and
//! nothing else, with every write attributable to a SAME-STATEMENT `ctx.db.`
//! chain; it binds no alias of the db handle or of the reducer context; and it
//! constructs no `Identity`.
//!
//! SCAN-HYGIENE CONTRACT (rb-22 plan F4/F5 + the reviewer's MAJOR M1). At least a
//! dozen evals concatenate EVERY `.rs` file under `server-module/src` — INCLUDING
//! `_tests.rs` files — into one blob and strip block comments with a naive
//! non-greedy regex.
//! `privacy*` sorts before `pvp` / `raising` / `schema` in that blob, so ONE
//! unpaired block-comment opener in this file or in `privacy.rs` silently blanks
//! an arbitrary span of OTHER modules and turns unrelated gates green over a
//! truncated world. Therefore, in BOTH files: no block comments (line comments
//! only), no raw strings, no logging token, no print macros, and no escaped
//! double quote (which unbalances a naive quote-pairing stripper).
//! `rb22p_scan_hygiene` asserts all of that over `privacy.rs` AND over THIS
//! FILE, which is why every dangerous needle here is assembled from `concat!`
//! fragments and never written contiguously.
//!
//! ONE ban is PRODUCTION-ONLY and says so in the test: a double quote inside a
//! char literal. Any file carrying the string stripper below must spell the byte
//! literal for a quote character, so the ban is unsatisfiable for a `_tests.rs`
//! file that owns its own scan machinery — accounts_tests.rs and ranking_tests.rs
//! have shipped with exactly that byte literal for many slices. Scoping it to
//! `privacy.rs` keeps the rule true instead of quietly deleting it.
//!
//! MACHINERY: the three-stage strip pipeline is a VERBATIM copy of the proven
//! helpers in `accounts_tests.rs` (per-module convention — sibling `_tests.rs`
//! modules never import each other; a re-derivation would risk silent
//! divergence). `rb22p_machinery_comment_string_blind` is its non-vacuity
//! control.

#![cfg(test)]

// ===========================================================================
// Scan machinery (local copies of the accounts_tests.rs helpers, verbatim).
// strings -> comments -> squash_ws.
// ===========================================================================

/// Blank the CONTENT (and delimiters) of string literals with spaces. Must run
/// BEFORE `strip_rust_comments`.
fn strip_rust_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;
    while i < len {
        if bytes[i] == b'r' {
            let mut hashes: usize = 0;
            let mut j = i + 1;
            while j < len && bytes[j] == b'#' && hashes < 6 {
                hashes += 1;
                j += 1;
            }
            if j < len && bytes[j] == b'"' {
                out.push(b' ');
                out.resize(out.len() + hashes, b' ');
                out.push(b' ');
                j += 1;
                loop {
                    if j >= len {
                        break;
                    }
                    if bytes[j] == b'"' {
                        let mut k = j + 1;
                        let mut closing: usize = 0;
                        while k < len && bytes[k] == b'#' && closing < hashes {
                            closing += 1;
                            k += 1;
                        }
                        if closing == hashes {
                            out.push(b' ');
                            out.resize(out.len() + hashes, b' ');
                            j = k;
                            break;
                        }
                    }
                    out.push(b' ');
                    j += 1;
                }
                i = j;
                continue;
            }
        }
        if bytes[i] == b'"' {
            out.push(b' ');
            i += 1;
            loop {
                if i >= len {
                    break;
                }
                if bytes[i] == b'\\' && i + 1 < len {
                    out.push(b' ');
                    out.push(b' ');
                    i += 2;
                } else if bytes[i] == b'"' {
                    out.push(b' ');
                    i += 1;
                    break;
                } else {
                    out.push(b' ');
                    i += 1;
                }
            }
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).expect("string-stripped source must be valid UTF-8")
}

/// Blank block and line comments with spaces. Run AFTER `strip_rust_strings`.
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
    String::from_utf8(out).expect("comment-stripped source must be valid UTF-8")
}

/// Remove all whitespace (rustfmt-proof needle matching).
fn squash_ws(src: &str) -> String {
    src.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Full structural pipeline: strings blanked -> comments blanked -> whitespace
/// squashed.
fn stripped_for_scan(src: &str) -> String {
    squash_ws(&strip_rust_comments(&strip_rust_strings(src)))
}

/// Extract the brace-bounded body of a fn from an ALREADY-squashed source.
fn extract_squashed_fn_body<'a>(squashed: &'a str, fn_needle: &str) -> Option<&'a str> {
    let fn_start = squashed.find(fn_needle)?;
    let after = &squashed[fn_start..];
    let brace_rel = after.find('{')?;
    let body_start = fn_start + brace_rel + 1;
    let bytes = squashed.as_bytes();
    let mut depth: usize = 1;
    let mut i = body_start;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&squashed[body_start..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Extract the squashed signature slice (fn_needle .. first open brace).
fn extract_squashed_fn_sig<'a>(squashed: &'a str, fn_needle: &str) -> Option<&'a str> {
    let fn_start = squashed.find(fn_needle)?;
    let after = &squashed[fn_start..];
    let brace_rel = after.find('{')?;
    Some(&squashed[fn_start..fn_start + brace_rel])
}

/// Non-overlapping occurrences of `needle` in `hay`.
fn rb22p_count(hay: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut n = 0usize;
    let mut start = 0usize;
    while let Some(rel) = hay[start..].find(needle) {
        n += 1;
        start += rel + needle.len();
    }
    n
}

/// Is `b` a Rust identifier byte? (Word-boundary tests over squashed source.)
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

// ===========================================================================
// Sources under test, and the frozen contract.
// ===========================================================================

const PRIVACY_RS: &str = include_str!("privacy.rs");
/// This very file. The hygiene rule that protects every OTHER eval from an
/// unpaired comment delimiter has to cover the file that states it, or it is
/// advice rather than a gate.
const PRIVACY_TESTS_RS: &str = include_str!("privacy_tests.rs");

/// A literal double quote built from its byte, so this file carries neither a
/// `\` escape before a quote nor a quote inside a char literal.
fn rb22p_dq() -> char {
    char::from(34u8)
}

/// The squashed `fn` needle for the helper.
fn rb22p_nd_fn() -> String {
    concat!("fnpurge_export", "_bundles(").to_string()
}

/// THE FROZEN BODY PIN, in squashed form. Same literal as the accounts_tests.rs
/// arm; the messages differ so a mutant can be attributed to either arm.
///
/// Containment pins alone were MEASURED insufficient (red-team, clippy-clean and
/// green against every needle clause): `if false ...` wrapping a correct body; a
/// shadowed `let ids = Vec::new();`; a shadowed in-loop `let id: u64 = 0;`; an
/// appended aliased foreign write. Equality closes the whole family at once.
fn rb22p_frozen_body() -> String {
    [
        "letids:Vec<u64>=",
        concat!("ctx", ".db."),
        concat!("export", "_bundle()"),
        ".owner_identity().filter(owner).map(|c|c.chunk_id).collect();",
        "foridinids{",
        concat!("ctx", ".db."),
        concat!("export", "_bundle()"),
        concat!(".chunk_id().del", "ete(id);"),
        "}",
    ]
    .concat()
}

/// The frozen signature slice `extract_squashed_fn_sig` returns.
///
/// It starts at the `fn` needle, so the visibility keyword is NOT part of it —
/// `pub(crate)` is pinned separately, as a prefix containment check.
fn rb22p_frozen_sig() -> String {
    concat!(
        "fnpurge_export",
        "_bundles(ctx:&ReducerContext,owner:Identity)"
    )
    .to_string()
}

/// The SAME body as `rb22p_frozen_body`, but as whitespace-bearing SOURCE text.
///
/// Feeding this through the live pipeline must reproduce `rb22p_frozen_body()`
/// byte for byte. That positive control is what makes the equality pin provably
/// SATISFIABLE: a hand-typed squashed literal with one character wrong is an
/// unsatisfiable gate, which reads exactly like a missing implementation and
/// sends the implementer reverse-engineering the test instead of the spec.
fn rb22p_frozen_body_source() -> String {
    [
        "\n    let ids: Vec<u64> = ",
        concat!("ctx", ".db."),
        concat!("export", "_bundle()"),
        "\n        .owner_identity()\n        .filter(owner)\n        .map(|c| c.chunk_id)\n",
        "        .collect();\n    for id in ids ",
        "{\n        ",
        concat!("ctx", ".db."),
        concat!("export", "_bundle()"),
        concat!(".chunk_id().del", "ete(id);"),
        "\n    }\n",
    ]
    .concat()
}

/// The declaration line of the fixture helper, as SOURCE text.
fn rb22p_frozen_decl_source() -> String {
    concat!(
        "pub(crate) fn purge_export",
        "_bundles(ctx: &ReducerContext, owner: Identity) "
    )
    .to_string()
}

/// The `Identity` CONSTRUCTORS banned outright in this module (the E2 defense,
/// ported from `accounts_tests.rs:623-630`). Nothing in a delete-only privacy
/// helper legitimately CONSTRUCTS an identity: the owner arrives as a parameter,
/// derived by the caller from `ctx.sender()` or from a row it read.
fn rb22p_identity_ctor_needles() -> [String; 4] {
    [
        concat!("Identity::", "from_hex(").to_string(),
        concat!("Identity::", "from_byte_array(").to_string(),
        concat!("Identity::", "from_be_byte_array(").to_string(),
        concat!("Identity::", "from_str(").to_string(),
    ]
}

// --- write attribution (local, HARDENED port of write_target_accessors) ------

const RB22P_NO_ANCHOR: &str = "<<unattributable-write-no-anchor>>";
const RB22P_CROSS_STATEMENT: &str = "<<unattributable-write-statement-boundary>>";
const RB22P_EMPTY_ACCESSOR: &str = "<<unattributable-write-empty-accessor>>";

/// The accessor name behind every write verb in an already-squashed source.
///
/// HARDENED against the MEASURED red-team Finding 1: the shipped
/// `write_target_accessors` (accounts_tests.rs:2139-2165) takes the nearest
/// EARLIER `ctx.db.` as the anchor without checking that it belongs to the same
/// statement, and DROPS a write with no anchor at all with no else-branch. So
/// `let db = &ctx.db; db.account().identity().delete(owner);` in this module is
/// misattributed to the previous statement's `export_bundle` accessor — green,
/// clippy-clean, and deleting a foreign table's rows.
///
/// Here, an unattributable write pushes a POISON MARKER instead of being dropped
/// or misattributed, and the caller fails loud on it. Scoped to this new file on
/// purpose: hardening the SHARED helper would re-baseline accounts.rs's existing
/// write census, which is why EO-11 is DEFERred to its own slice.
fn rb22p_write_targets(squashed: &str) -> Vec<String> {
    let prefix = concat!("ctx", ".db.");
    let verbs = [
        concat!(".ins", "ert(").to_string(),
        concat!(".upd", "ate(").to_string(),
        concat!(".del", "ete(").to_string(),
    ];
    let mut acc: Vec<String> = Vec::new();
    for verb in &verbs {
        let mut start = 0usize;
        while let Some(rel) = squashed[start..].find(verb.as_str()) {
            let vpos = start + rel;
            match squashed[..vpos].rfind(prefix) {
                None => acc.push(RB22P_NO_ANCHOR.to_string()),
                Some(dbrel) => {
                    if squashed[dbrel..vpos].contains(';') {
                        acc.push(RB22P_CROSS_STATEMENT.to_string());
                    } else {
                        let name: String = squashed[dbrel + prefix.len()..]
                            .chars()
                            .take_while(|c| c.is_alphanumeric() || *c == '_')
                            .collect();
                        if name.is_empty() {
                            acc.push(RB22P_EMPTY_ACCESSOR.to_string());
                        } else {
                            acc.push(name);
                        }
                    }
                }
            }
            start = vpos + verb.len();
        }
    }
    acc
}

/// The scoped, squashed body of the helper — every body clause below reads it
/// through this seam rather than through a whole-file `contains`, so text living
/// in a DECOY function can never satisfy a clause about this one (red-team
/// MEDIUM finding; `rb22p_machinery_comment_string_blind` proves the scoping).
fn rb22p_body(squashed: &str) -> String {
    extract_squashed_fn_body(squashed, &rb22p_nd_fn())
        .unwrap_or_else(|| {
            panic!(
                "rb22p [scope]: purge_export_bundles was not found in privacy.rs, or its body \
                 is not brace-balanced. Every body clause in this module would otherwise run \
                 over an empty or arbitrary span and pass VACUOUSLY."
            )
        })
        .to_string()
}

// ===========================================================================
// Tests.
// ===========================================================================

/// EO-2: the helper is declared EXACTLY once, `pub(crate)`, with the frozen
/// owner-generic signature.
///
/// Kills: a second overloaded or cfg-gated definition (which makes every
///        body-scoped clause below read whichever one the extractor finds first);
///        a rename; a private fn (the accounts.rs call would not resolve);
///        a bare `pub` (needless crate-external surface);
///        a claim-specific `guest: Identity` parameter, which would block the S3
///        account-deletion cascade from reusing this helper verbatim.
#[test]
fn rb22p_purge_fn_declared_exactly_once() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let needle = rb22p_nd_fn();
    let n = rb22p_count(&squashed, &needle);
    assert_eq!(
        n, 1,
        "rb22p [decl/count]: privacy.rs must define `{needle}` exactly once; found {n}. Two \
         definitions make every body-scoped clause in this module read whichever one the \
         extractor happens to reach first, so the other is completely ungated."
    );

    let sig = extract_squashed_fn_sig(&squashed, &needle)
        .expect("rb22p [decl/sig]: the helper signature has no opening brace");
    assert_eq!(
        sig,
        rb22p_frozen_sig(),
        "rb22p [decl/sig]: the helper signature is not the frozen one. It takes the reducer \
         context under the name `ctx` (every alias ban in this module keys on that name) and an \
         OWNER-GENERIC `owner: Identity`, never a claim-specific `guest`, so S3's account \
         deletion cascade can reuse it verbatim."
    );

    assert!(
        squashed.contains(concat!("pub(crate)fnpurge_export", "_bundles(")),
        "rb22p [decl/vis]: the helper must be `pub(crate)` — private makes the accounts.rs call \
         site unresolvable, bare `pub` widens the crate's external surface for nothing."
    );
}

/// EO-2 (THE BACKSTOP TOOTH): the helper body is EXACTLY the sanctioned
/// collect-then-delete sequence, byte for byte in squashed form.
///
/// This owns the kills that no semantic clause reaches first, all four MEASURED
/// as clippy-clean and green against containment pins: a correct body wrapped in
/// a dead `if false` branch; `let ids = Vec::new();` shadowing the collected PKs;
/// an in-loop `let id: u64 = 0;` re-pointing every delete at one constant key;
/// and an extra aliased write appended to an otherwise-correct body.
///
/// The pin is proven SATISFIABLE by the positive control in
/// `rb22p_machinery_comment_string_blind`, which derives this exact string from
/// source text through the live pipeline.
#[test]
fn rb22p_purge_body_exact() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let body = rb22p_body(&squashed);
    assert_eq!(
        body,
        rb22p_frozen_body(),
        "rb22p [body/exact]: purge_export_bundles body must be exactly the flat \
         filter-collect-delete sequence — no conditionals, no extra bindings, no extra \
         statements (kills dead-branch, shadowed-ids, shadowed-id, aliased-write bypasses; \
         red-team /tmp/rb22-attack)."
    );
}

/// EO-2 (owner scope): the delete set is filtered through the `owner_identity`
/// btree index, and the module NEVER iterates the whole `export_bundle` table.
///
/// Kills: swapping `.owner_identity().filter(owner)` for a full-table
///        `.iter()` sweep (with or without a later in-Rust predicate) — which
///        deletes EVERY owner's export chunks, i.e. turns a privacy fix into
///        mass data loss, while the body still collects and deletes.
#[test]
fn rb22p_owner_scoped_filter_never_iter() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let body = rb22p_body(&squashed);

    let filter = concat!("owner_identity()", ".filter(owner)");
    assert!(
        body.contains(filter),
        "rb22p [owner/filter]: the helper must select rows through `{filter}` — the \
         owner_identity btree index, with the PASSED owner as the key. Any other selection \
         either scans the whole table or filters on something the caller did not ask for."
    );

    let sweep = concat!("export", "_bundle()", ".iter()");
    assert!(
        !squashed.contains(sweep),
        "rb22p [owner/no-iter]: privacy.rs contains `{sweep}`. A full-table sweep deletes OTHER \
         owners' export chunks: the guest-orphan fix would become the largest data-loss bug in \
         the module. Selection is by owner index only."
    );
}

/// EO-1 / EO-2 (reachability): the helper contains no early `return`.
///
/// The body is straight-line by design — a collect and a loop. A `return` can
/// only skip part of the erasure, leaving some of the retired identity's chunks
/// behind while the collect-and-delete shape still reads as correct.
///
/// TOKEN SEMANTICS, MEASURED against the pipeline: a word boundary is required on
/// the LEFT ONLY. `squash_ws` fuses `return Err(..)` into `returnErr(` and
/// `return;` into `return}` or `return;` — requiring a non-word byte on the RIGHT
/// would blind this clause to exactly the shapes it exists to catch, while the
/// left-hand boundary still rejects an identifier such as `early_return`.
#[test]
fn rb22p_no_early_return_in_purge() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let body = rb22p_body(&squashed);
    let bytes = body.as_bytes();
    let mut scan = 0usize;
    while let Some(rel) = body[scan..].find("return") {
        let at = scan + rel;
        let is_token = at == 0 || !is_word_byte(bytes[at - 1]);
        assert!(
            !is_token,
            "rb22p [flow/no-return]: purge_export_bundles contains a `return` token. The body is \
             straight-line by design (collect the owner's PKs, then delete each one); an early \
             exit can only leave part of the retired identity's export chunks behind, while \
             every containment clause about the collect and the delete stays green."
        );
        scan = at + "return".len();
    }
}

/// EO-3 (module write isolation, D0): privacy.rs writes `export_bundle` and
/// nothing else, and EVERY write verb is attributable to a same-statement
/// `ctx.db.<table>()` chain.
///
/// Kills: any foreign-table write added to this module (its accessor is outside
///        the owned set);
///        the MEASURED alias bypass `let db = &ctx.db; db.account()...delete(..)`,
///        which the shipped helper silently misattributes to the previous
///        statement's accessor — here the intervening `;` makes it a POISON
///        marker and the test fails loud instead;
///        a write with no `ctx.db.` anchor at all, which the shipped helper drops
///        on the floor.
#[test]
fn rb22p_writes_only_export_bundle() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let targets = rb22p_write_targets(&squashed);

    assert!(
        !targets.is_empty(),
        "rb22p [W/non-vacuity]: privacy.rs contains NO write verb at all. The module exists to \
         perform exactly one delete; with zero writes found, every clause below passes over an \
         empty set and this gate says `clean` about nothing."
    );

    for t in &targets {
        assert!(
            !t.starts_with("<<"),
            "rb22p [W/attribution]: a write verb in privacy.rs could not be attributed to a \
             same-statement `ctx.db.` chain (marker {t}). Refusing to classify is the safe \
             direction: an unattributed write is an UNGATED write, and the measured shape is an \
             aliased db handle whose foreign-table delete is silently credited to the previous \
             statement's accessor."
        );
    }

    let allowed = concat!("export", "_bundle");
    for t in &targets {
        assert_eq!(
            t.as_str(),
            allowed,
            "rb22p [W/target]: privacy.rs writes table `{t}`, which is not `{allowed}`. This \
             module owns exactly one table's writes; every other table's writes belong to that \
             table's own owning module (G5 / D0)."
        );
    }
}

/// EO-3 (alias bans): the module binds no alias of the db handle, and every
/// reducer-context parameter is named `ctx`.
///
/// The eval's strong `[W/db-binding]` / `[W/ctx-binding]` clauses scan the
/// accounts.rs source ONLY, so they do not see this new module; this is their
/// Rust-side, privacy.rs-scoped counterpart.
///
/// HONEST LIMITS, stated rather than implied: this clause does NOT catch a
/// context taken by value (`ctx: ReducerContext`), a handle obtained by any route
/// that does not spell `= ctx.db` or `= &ctx.db`, or an alias created inside a
/// macro. Those are closed instead by `rb22p_purge_body_exact`, which forbids ANY
/// statement or binding in the helper beyond the two sanctioned ones, and by
/// `rb22p_writes_only_export_bundle`'s poison markers.
#[test]
fn rb22p_no_db_or_ctx_alias() {
    let squashed = stripped_for_scan(PRIVACY_RS);

    let by_ref = concat!("=&", "ctx", ".db");
    assert!(
        !squashed.contains(by_ref),
        "rb22p [alias/db-ref]: privacy.rs binds the database handle by reference (`{by_ref}`). \
         A red-team PROVED this exact shape defeats write attribution: the aliased handle's \
         foreign-table delete is credited to the nearest earlier accessor, so a delete of \
         another table's rows reads as an `export_bundle` write. Chain every write directly off \
         `ctx.db.` in the statement that performs it."
    );

    let by_move = concat!("=", "ctx", ".db;");
    assert!(
        !squashed.contains(by_move),
        "rb22p [alias/db-move]: privacy.rs binds the database handle (`{by_move}`) — see \
         [alias/db-ref]; the same attribution defeat applies to a by-value binding."
    );

    let ctx_param = ":&ReducerContext";
    let occurrences = rb22p_count(&squashed, ctx_param);
    assert!(
        occurrences >= 1,
        "rb22p [alias/non-vacuity]: privacy.rs declares no `{ctx_param}` parameter at all, so \
         the naming clause below would iterate an empty set. The module's only helper takes the \
         reducer context; a file without one is not the file this gate means to check."
    );

    let bytes = squashed.as_bytes();
    let mut scan = 0usize;
    while let Some(rel) = squashed[scan..].find(ctx_param) {
        let at = scan + rel;
        let mut s = at;
        while s > 0 && is_word_byte(bytes[s - 1]) {
            s -= 1;
        }
        let name = &squashed[s..at];
        assert_eq!(
            name, "ctx",
            "rb22p [alias/ctx-name]: privacy.rs takes the reducer context under the name \
             `{name}`; it must be `ctx`. Every db-handle ban in this module is spelled against \
             that name, so a context bound under any other name reopens the alias hole by \
             renaming rather than by aliasing."
        );
        scan = at + ctx_param.len();
    }
}

/// EO-3 (E2 defense): privacy.rs never CONSTRUCTS an `Identity`.
///
/// Port of `g2_no_identity_constructor` (accounts_tests.rs:2092-2105), scoped to
/// the new module. The owner arrives as a parameter that the caller derived from
/// `ctx.sender()` or from a row it read; a constructor here would let a future
/// caller (or a future reducer in this module) name an arbitrary victim identity
/// and erase their export bundles.
#[test]
fn rb22p_no_identity_constructor() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    for ctor in rb22p_identity_ctor_needles() {
        assert!(
            !squashed.contains(ctor.as_str()),
            "rb22p [ctor/identity]: privacy.rs calls `{ctor}`. Nothing in a delete-only privacy \
             helper legitimately constructs an Identity: the owner is a parameter, derived by \
             the caller from ctx.sender() or from a row it read. A constructor here turns the \
             purge into an arbitrary-victim erase."
        );
    }
}

/// EO-4 (whole-tree gate safety): the scan-hygiene contract, enforced over
/// privacy.rs AND over THIS FILE.
///
/// MEASURED, not stylistic. At least a dozen evals concatenate every `.rs` file
/// under `server-module/src` — `_tests.rs` files included — and strip block
/// comments with a naive non-greedy regex. `privacy` sorts before `pvp`,
/// `raising` and `schema` in that blob, so one unpaired block-comment opener in
/// either of these two files silently blanks a span of OTHER modules and turns
/// unrelated gates green over a truncated world. A raw string, a logging token, a
/// print macro or an escaped double quote each blind a different scanner in the
/// same way.
///
/// Self-scanning is the point: a hygiene rule that exempts the file stating it is
/// advice, not a gate. Every needle below is assembled from `concat!` fragments
/// precisely so this test cannot trip on itself.
///
/// ONE ban is deliberately PRODUCTION-ONLY — a double quote inside a char
/// literal. Any file that carries the string stripper above must spell the byte
/// literal for a quote character, so applying that ban to a `_tests.rs` file that
/// owns its own scan machinery would make it unsatisfiable (accounts_tests.rs and
/// ranking_tests.rs have shipped with exactly that byte literal for many slices).
/// Scoping it to `privacy.rs`, where the contract really is "no such literal",
/// keeps the rule TRUE rather than quietly deleting it.
#[test]
fn rb22p_scan_hygiene() {
    let dq = rb22p_dq();
    let mut escaped_quote = String::new();
    escaped_quote.push('\\');
    escaped_quote.push(dq);
    let quote_char = format!("'{dq}'");

    let banned: [(String, &str); 8] = [
        (
            concat!("/", "*").to_string(),
            "a block-comment OPENER (blanks a span of every LATER module in a concatenated \
             eval blob)",
        ),
        (
            concat!("*", "/").to_string(),
            "a block-comment CLOSER (same blob-truncation family)",
        ),
        (
            concat!("r", "#").to_string(),
            "a raw-string prefix (string-stripping scanners do not model it)",
        ),
        (
            concat!("lo", "g", "::").to_string(),
            "a logging token (banned in this module; the reducer that calls the helper owns \
             any logging)",
        ),
        (
            concat!("print", "ln", "!").to_string(),
            "the println macro (also covers eprintln; spacetime generate rejects print macros \
             and reds bindings-drift rather than the build)",
        ),
        (
            concat!("pri", "nt", "!").to_string(),
            "the print macro (also covers eprint)",
        ),
        (concat!("db", "g", "!").to_string(), "the dbg macro"),
        (
            escaped_quote,
            "an escaped double quote (unbalances a naive quote-pairing string stripper, which \
             then blanks an arbitrary span of the concatenated blob)",
        ),
    ];

    for (path, src) in [
        ("privacy.rs", PRIVACY_RS),
        ("privacy_tests.rs", PRIVACY_TESTS_RS),
    ] {
        assert!(
            src.len() > 200,
            "rb22p [hygiene]: {path} is only {} bytes — too short to be the file this scan \
             means to check, so every ban below would pass vacuously.",
            src.len()
        );
        for (needle, what) in &banned {
            assert!(
                !src.contains(needle.as_str()),
                "rb22p [hygiene]: {path} contains {what}. See this module's header: the ban is \
                 measured, not stylistic — it protects a dozen OTHER evals that concatenate \
                 every src file, this one included."
            );
        }
    }

    assert!(
        !PRIVACY_RS.contains(quote_char.as_str()),
        "rb22p [hygiene/prod-only]: privacy.rs contains a double quote inside a char literal, \
         which desynchronises every quote-pairing string stripper downstream of it in a \
         concatenated eval blob. This module holds one delete-only helper and needs no such \
         literal. (The ban is production-only by design: a _tests.rs file carrying its own \
         string stripper must spell that byte literal, so applying it here too would make the \
         rule unsatisfiable rather than strict.)"
    );
}

/// EO-4 (whole-tree gate safety, PRODUCTION-ONLY): privacy.rs carries EXACTLY
/// ONE double-quoted string literal — the `privacy_tests.rs` path attribute —
/// and no other double quote anywhere, not even inside a line comment.
///
/// MEASURED (rb-22 artifact red-team, Finding 1). `stripped_for_scan` runs
/// `strip_rust_strings` BEFORE `strip_rust_comments`, so a BARE quote sitting
/// inside a `//` line comment opens a fake string span the comment stripper
/// never gets to see. TWO such quotes on two comment lines make the string
/// stripper blank EVERYTHING between them to spaces, which `squash_ws` then
/// deletes — so real, compiling, NON-commented Rust between those two lines
/// (measured: an arbitrary-Identity `account`-table delete) contributes ZERO
/// characters to `stripped_for_scan(PRIVACY_RS)`. It is then invisible to the
/// frozen-body equality pin, to the write census, and to the eight-needle
/// hygiene ban alike — none of which lists a bare quote. Counting raw quotes is
/// the only view that catches it, because it is the one view taken BEFORE the
/// strings-first pipeline can hide the evidence.
///
/// PRODUCTION-ONLY, and it must be: privacy_tests.rs legitimately owns hundreds
/// of balanced quotes (its own string stripper, every assertion message), so the
/// invariant is TRUE only of privacy.rs, which holds one delete-only helper.
///
/// Anti-vacuity: the sole sanctioned quoted literal is asserted PRESENT and
/// removed once before the residual count, so a renamed or dropped path
/// attribute reds LOUD rather than passing over a file that simply has no quote.
///
/// Kills: W25 — two bare quotes on two `//` comment lines wrapped around an
///        arbitrary-Identity account delete inside `purge_export_bundles`, which
///        the strings-first pipeline hides so every squashed-text pin reports the
///        exact sanctioned body.
#[test]
fn rb22p_no_bare_quote_in_privacy() {
    let dq = rb22p_dq();
    let dq_str = dq.to_string();
    let sanctioned = format!("{dq}privacy_tests.rs{dq}");

    let sanctioned_count = rb22p_count(PRIVACY_RS, sanctioned.as_str());
    assert_eq!(
        sanctioned_count, 1,
        "rb22p [hygiene/bare-quote]: privacy.rs does not carry EXACTLY ONE \
         `[path=<dq>privacy_tests.rs<dq>]` quoted literal (found {sanctioned_count}). This test \
         removes that sole sanctioned quote pair before counting the rest, so a renamed or \
         dropped path attribute must red here consciously rather than let the residual count \
         pass vacuously over a file that simply has no quote at all."
    );

    let residual = PRIVACY_RS.replacen(sanctioned.as_str(), "", 1);
    let remaining = rb22p_count(residual.as_str(), dq_str.as_str());
    assert_eq!(
        remaining, 0,
        "rb22p [hygiene/bare-quote]: privacy.rs carries {remaining} double quote(s) beyond the \
         sole sanctioned `privacy_tests.rs` path literal. stripped_for_scan runs the STRING \
         stripper BEFORE the COMMENT stripper, so a bare quote inside a `//` line comment opens \
         a fake string span the comment stripper never sees; TWO such quotes on two comment \
         lines blank EVERYTHING between them — including real, compiling, non-commented Rust — \
         to spaces that squash_ws deletes. That hidden span (measured: an arbitrary-Identity \
         account-table delete) then contributes ZERO characters to the squashed view and is \
         invisible to the frozen-body pin, the write census and the eight-needle hygiene ban. \
         privacy.rs holds one delete-only helper and needs no quoted literal beyond the path \
         attribute."
    );
}

/// CONTROL (non-vacuity of the machinery itself). Three fixtures, no production
/// source: a gate whose stripper silently returned an empty string, or whose
/// scoped extractor silently read the wrong function, would pass every clause in
/// this module while proving nothing.
///
/// (a) BLINDNESS: the delete chain appearing only inside a line comment and
///     inside a string literal must be INVISIBLE to `stripped_for_scan`. Without
///     this, a helper that merely mentions the right chain in its doc comment
///     would satisfy every containment clause.
/// (b) POSITIVE CONTROL: source text run through the live pipeline must reproduce
///     the frozen body and signature EXACTLY — which is what proves the equality
///     pin is satisfiable rather than a typo nobody can ever match.
/// (c) DECOY FUNCTION: with the correct body text sitting in `fn decoy_impl` and
///     `purge_export_bundles` left empty, the scoped extractor must return an
///     EMPTY body — so a whole-file `contains` would pass while the scoped read
///     correctly reports nothing. (Red-team MEDIUM finding: every body clause in
///     this module must be scoped, never whole-file.)
#[test]
fn rb22p_machinery_comment_string_blind() {
    let needle = [
        concat!("ctx", ".db."),
        concat!("export", "_bundle()"),
        concat!(".chunk_id().del", "ete(id);"),
    ]
    .concat();
    let fn_needle = rb22p_nd_fn();

    // --- (a) comment- and string-blindness ----------------------------------
    let mut fixture = String::new();
    fixture.push_str("fn f() ");
    fixture.push('{');
    fixture.push_str("\n    ");
    fixture.push_str(concat!("/", "/ "));
    fixture.push_str(&needle);
    fixture.push_str("\n    let s = ");
    fixture.push(rb22p_dq());
    fixture.push_str(&needle);
    fixture.push(rb22p_dq());
    fixture.push_str(";\n");
    fixture.push('}');
    fixture.push('\n');

    assert!(
        fixture.contains(needle.as_str()),
        "rb22p [control/fixture-a-vacuity]: the blindness fixture does not actually contain the \
         needle, so the assertion below would pass over a fixture that proves nothing."
    );
    let stripped_a = stripped_for_scan(&fixture);
    assert_eq!(
        rb22p_count(&stripped_a, &needle),
        0,
        "rb22p [control/blind]: the strip pipeline still sees the delete chain after it was \
         placed ONLY inside a line comment and inside a string literal. Every containment and \
         count clause in this module would then be satisfiable by PROSE — a doc comment naming \
         the right chain, with no code behind it. Stripped text: {stripped_a:?}"
    );

    // --- (b) positive control: the frozen pin is satisfiable ----------------
    let good = format!(
        "{}{}{}{}",
        rb22p_frozen_decl_source(),
        '{',
        rb22p_frozen_body_source(),
        '}'
    );
    let stripped_good = stripped_for_scan(&good);
    let good_sig = extract_squashed_fn_sig(&stripped_good, &fn_needle)
        .expect("rb22p [control/positive-extract]: the control fixture has no signature");
    assert_eq!(
        good_sig,
        rb22p_frozen_sig(),
        "rb22p [control/positive]: the frozen SIGNATURE pin is unsatisfiable — the live pipeline \
         derives something else from the sanctioned declaration text. An unsatisfiable pin reads \
         exactly like a missing implementation and sends the next reader to reverse-engineer the \
         test instead of the spec. Fix the literal from the spec, never the other way round."
    );
    let good_body = extract_squashed_fn_body(&stripped_good, &fn_needle)
        .expect("rb22p [control/positive-extract]: the control fixture has no body");
    assert_eq!(
        good_body,
        rb22p_frozen_body(),
        "rb22p [control/positive]: the frozen BODY pin is unsatisfiable — the live pipeline \
         derives something else from the sanctioned body text. See [control/positive] above: \
         revise the literal from the spec, never to match whatever the code happens to say."
    );

    // --- (c) decoy function: scoped reads never see a sibling's body --------
    let mut decoy = String::new();
    decoy.push_str("fn decoy_impl() ");
    decoy.push('{');
    decoy.push_str(&rb22p_frozen_body_source());
    decoy.push('}');
    decoy.push('\n');
    decoy.push_str(&rb22p_frozen_decl_source());
    decoy.push('{');
    decoy.push('}');
    decoy.push('\n');

    let stripped_decoy = stripped_for_scan(&decoy);
    assert!(
        stripped_decoy.contains(rb22p_frozen_body().as_str()),
        "rb22p [control/decoy-vacuity]: the decoy fixture does not contain the correct body text \
         at all, so the scoping assertion below proves nothing."
    );
    let scoped = extract_squashed_fn_body(&stripped_decoy, &fn_needle)
        .expect("rb22p [control/decoy-extract]: the decoy fixture's helper is not brace-balanced");
    assert_eq!(
        scoped, "",
        "rb22p [control/decoy-scope]: the scoped extractor read text from OUTSIDE \
         purge_export_bundles. With the correct body sitting in a sibling `decoy_impl` and the \
         helper itself empty, the scoped read must return nothing — otherwise every body clause \
         in this module is satisfiable by code that never runs on this path. Read: {scoped:?}"
    );
}

/// EO-2 (doc truth for the new module): privacy.rs's own module header still
/// states what it owns and why it exists.
///
/// The module is created by rb-22 ahead of M22-S4, so its header is the only
/// place a reader learns that `export_bundle` writes belong HERE (spec M22 §7.2)
/// rather than in accounts.rs. Scanned over the leading run of `//!` lines in RAW
/// text, because every comment-stripping view blanks exactly this content.
///
/// Deliberately narrow: two tokens, no prose pinning. It is a doc-truth tooth,
/// not behavioural evidence, and it must not false-RED on a rewording.
#[test]
fn rb22p_stub_probe_regression() {
    let doc_prefix = concat!("/", "/", "!");
    let mut doc = String::new();
    for line in PRIVACY_RS.lines() {
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        if !text.starts_with(doc_prefix) {
            break;
        }
        doc.push_str(text);
        doc.push(' ');
    }
    assert!(
        doc.len() > 40,
        "rb22p [doc/vacuity]: privacy.rs has no module doc header (read {} byte(s)), so the \
         token clauses below would pass over an empty string.",
        doc.len()
    );

    for (needle, what) in [
        (
            concat!("export", "_bundle"),
            "the table whose writes this module owns (spec M22 section 7.2)",
        ),
        (
            "rb-22",
            "the slice that created the module, and its ADR trail",
        ),
    ] {
        assert!(
            doc.contains(needle),
            "rb22p [doc/header]: privacy.rs's module doc does not mention `{needle}` ({what}). \
             This module is created ahead of S4 and holds one helper; its header is the only \
             place the next reader learns why the export_bundle write lives here instead of in \
             accounts.rs."
        );
    }
}
