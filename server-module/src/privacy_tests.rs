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
// ===========================================================================
// m22-s4 — EXPORT GATING TESTS (PRV1-11 / PRV1-12 / PRV1-13 + the S4 security
// amendments). APPEND-ONLY BLOCK: everything above this banner is rb-22's
// shipped suite and is unchanged; every symbol below carries the `m22s4_` /
// `M22S4_` prefix so it can never collide with an `rb22p_` helper.
//
// WHAT THIS GATES (spec M22 section 5; ADR-0226):
//   PRV1-11  one chunk per exportable:true table, own rows only, per-column JSON.
//   PRV1-12  no exportable:false table is ever named by the export machinery.
//   PRV1-13  sub-chunking at game_core::EXPORT_CHUNK_ROWS, request-wide
//            chunk_index and total_chunks.
//   plus the S4 guards (subject existence, deletion gate, cooldown), the battle
//   redaction, and the owner-scoped view that is the entire client read path.
//   PRV1-14 (the TTL reaper) is DEFERRED to S4b and deliberately ungated here.
//
// THE SPLIT (ADR-0225 D5): a ReducerContext is not constructible off-instance,
// so every PURE seam below is EXECUTED and every ctx-bound shell property is a
// SOURCE-STRUCTURE pin over PRIVACY_RS through this module's existing
// three-stage strip pipeline. Source pins are the weaker instrument and each
// one says so; the behavioural tests carry the real teeth.
//
// SCAN HYGIENE (this file is scanned by rb22p_scan_hygiene, and concatenated by
// a dozen evals that strip comments naively):
//   * line comments only, never a block-comment delimiter, and no regex literal
//     in a comment (a slash-star or star-slash inside one blanks a span of every
//     LATER module in a concatenated blob);
//   * no raw-string prefix, no logging token, no print macro;
//   * NO backslash immediately followed by a double quote anywhere. Every
//     backslash below comes from m22s4_bs() and every double quote from
//     rb22p_dq(), and no string literal ends in a backslash escape;
//   * no double quote inside a comment (balanced-quote rule) and none inside a
//     char literal (it desynchronises downstream eval string strippers);
//   * the purge helper is NEVER spelled contiguously (crate-wide naming census,
//     accounts_tests.rs) — always a concat! split;
//   * the wallet row struct is reached through an IMPORT ALIAS and the wallet
//     accessor spelling is never followed by an empty argument list, because
//     evals/currency-integrity.eval.mjs scans EVERY .rs under server-module/src
//     (test files included) and its allowlist is an exact-path match that does
//     not cover this file. The alternative (adding privacy_tests.rs to that
//     allowlist, the economy_tests.rs precedent) is recorded as an open review
//     question in ADR-0226 implementation-time discoveries;
//   * attribute needles are assembled from concat! fragments (the
//     accounts_tests.rs house convention) so a scanner that concatenates this
//     file cannot mistake a pinned literal for a live declaration.

use crate::playtest::{PlaytestEvent, PLAYTEST_EVENT_CAP};
use crate::schema::PlayerWallet as M22s4WalletRow;
use crate::schema::{
    Account, AccountStatus, Battle, BattleAction, BattleChallenge, ChallengeStatus, Character,
    DataLifecycleEntry, DeletionPolicy, HealCooldown, Inventory, Monster, MonsterPub, Player,
    PlayerConversation, PlayerDialogueStateRow, PlayerQuestRow, Profile, TradeOffer,
    DATA_LIFECYCLE_MANIFEST,
};
use game_core::{
    ActionState, Affinity, BattleMonster, BattleOutcome, BattleSide, BattleState, Direction,
    MonsterCard, MoveInput, NatureKind, PvpAction, StatBlock, TradeItem, TradeStatus, TrustTier,
};
use proptest::prelude::*;
use spacetimedb::Identity;

// ===========================================================================
// m22-s4 primitives: the two hazard characters, spelled by code point.
// ===========================================================================

/// A literal backslash, built from its byte so this file never carries a
/// backslash adjacent to a double quote (the rb22p_scan_hygiene ban, which
/// exists because that pair desynchronises a naive quote-pairing stripper in
/// every eval that concatenates this crate).
fn m22s4_bs() -> char {
    char::from(92u8)
}

/// One LOWERCASE base-16 digit. The escaping contract emits every C0 control as
/// a six-character escape with lowercase hex.
fn m22s4_hex_digit(nibble: u32) -> char {
    char::from_digit(nibble, 16).expect("m22s4: a nibble is always a valid base-16 digit")
}

/// The contract's escape for one C0 control code point: backslash, `u`, `00`,
/// then the byte as two lowercase hex digits. A reference implementation of the
/// RULE, written from the spec — never read off the production source.
fn m22s4_u_esc(code: u32) -> String {
    let mut out = String::new();
    out.push(m22s4_bs());
    out.push('u');
    out.push('0');
    out.push('0');
    out.push(m22s4_hex_digit((code >> 4) & 0xF));
    out.push(m22s4_hex_digit(code & 0xF));
    out
}

/// Backslash + double quote (the escaped-quote output form).
fn m22s4_esc_quote() -> String {
    let mut out = String::new();
    out.push(m22s4_bs());
    out.push(rb22p_dq());
    out
}

/// Two backslashes (the escaped-backslash output form).
fn m22s4_esc_backslash() -> String {
    let mut out = String::new();
    out.push(m22s4_bs());
    out.push(m22s4_bs());
    out
}

// ===========================================================================
// m22-s4 JSON EXPECTATION builders (independent of the production emitter).
//
// The contract: an object is `{` then comma-separated name/value pairs then
// `}`; u64 and i64 are QUOTED decimal strings (JSON.parse silently rounds above
// 2^53 and wallet balances, row ids and input seqs are all u64); everything at
// 32 bits or narrower, plus bool, is a BARE JSON literal.
// ===========================================================================

/// An object from an ORDERED field list. Field order is part of the pin: the
/// serializers emit columns in DECLARATION order, so a reordered struct is a
/// visible diff rather than a silent reshuffle of a durable artifact.
fn m22s4_obj(fields: &[(&str, String)]) -> String {
    let q = rb22p_dq();
    let mut out = String::new();
    out.push('{');
    let mut first = true;
    for (name, value) in fields {
        if !first {
            out.push(',');
        }
        first = false;
        out.push(q);
        out.push_str(name);
        out.push(q);
        out.push(':');
        out.push_str(value);
    }
    out.push('}');
    out
}

/// An array from already-rendered element texts.
fn m22s4_arr(items: &[String]) -> String {
    let mut out = String::new();
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(item);
    }
    out.push(']');
    out
}

/// A BARE JSON number (every column 32 bits or narrower).
fn m22s4_bare(v: i128) -> String {
    v.to_string()
}

/// A QUOTED decimal string (every u64 / i64 column — the 64-bit rule).
fn m22s4_quoted_num(v: i128) -> String {
    let q = rb22p_dq();
    let mut out = String::new();
    out.push(q);
    out.push_str(&v.to_string());
    out.push(q);
    out
}

/// Quote an ALREADY-ESCAPED payload (string columns, enum variant names, hex).
fn m22s4_qtxt(escaped: &str) -> String {
    let q = rb22p_dq();
    let mut out = String::new();
    out.push(q);
    out.push_str(escaped);
    out.push(q);
    out
}

/// The JSON null literal.
fn m22s4_null() -> String {
    "null".to_string()
}

/// A JSON bool literal.
fn m22s4_bool(b: bool) -> String {
    if b {
        "true".to_string()
    } else {
        "false".to_string()
    }
}

// ===========================================================================
// Identity fixtures.
//
// UNIFORM byte arrays on purpose: Identity's Display is fixed-width lowercase
// hex, but whether it renders the byte array big- or little-endian is not
// something this suite should silently depend on. With every byte equal the two
// renderings coincide, so the expected hex is the nibble pair repeated 32
// times either way — an INDEPENDENT spelling of the emitter's output.
// ===========================================================================

/// `Identity::from_byte_array` is banned in privacy.rs (rb22p_no_identity_ctor)
/// and in accounts.rs (the eval's identity-ctor clause). Neither ban covers a
/// `_tests.rs` fixture, and lib.rs uses the same constructor for WILD_IDENTITY.
fn m22s4_id(byte: u8) -> Identity {
    Identity::from_byte_array([byte; 32])
}

/// The 64-character lowercase hex an all-`byte` identity must render as, built
/// WITHOUT calling Display — the independent oracle for the identity emitter.
fn m22s4_id_hex(byte: u8) -> String {
    let mut out = String::new();
    for _ in 0..32 {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The quoted hex an identity column must serialize to.
fn m22s4_qid(id: Identity) -> String {
    m22s4_qtxt(&id.to_string())
}

/// Requester A.
fn m22s4_id_a() -> Identity {
    m22s4_id(0xAB)
}

/// Counterparty B.
fn m22s4_id_b() -> Identity {
    m22s4_id(0x3C)
}

/// A third party who participates in nothing.
fn m22s4_id_c() -> Identity {
    m22s4_id(0x77)
}

// ===========================================================================
// The one adversarial string every String-typed fixture column carries, and its
// escaped form derived from the CONTRACT rather than from the implementation.
// ===========================================================================

/// Quote, backslash, two distinct C0 controls (one of them the line feed, whose
/// two-character short form the contract deliberately does NOT use), a solidus
/// and a DEL (both explicitly UNESCAPED), plus 2-, 3- and 4-byte UTF-8 that must
/// pass through untouched.
fn m22s4_nasty() -> String {
    let mut s = String::new();
    s.push('a');
    s.push(rb22p_dq());
    s.push(m22s4_bs());
    s.push('\u{0001}');
    s.push('\u{000A}');
    s.push('/');
    s.push('\u{007F}');
    s.push('\u{00E9}');
    s.push('\u{4E2D}');
    s.push('\u{1F600}');
    s.push('z');
    s
}

/// `m22s4_nasty()` after the escaping rule, WITHOUT the surrounding quotes.
fn m22s4_nasty_escaped() -> String {
    let mut s = String::new();
    s.push('a');
    s.push_str(&m22s4_esc_quote());
    s.push_str(&m22s4_esc_backslash());
    s.push_str(&m22s4_u_esc(0x01));
    s.push_str(&m22s4_u_esc(0x0A));
    s.push('/');
    s.push('\u{007F}');
    s.push('\u{00E9}');
    s.push('\u{4E2D}');
    s.push('\u{1F600}');
    s.push('z');
    s
}

/// `m22s4_nasty()` as a complete JSON string value.
fn m22s4_nasty_json() -> String {
    m22s4_qtxt(&m22s4_nasty_escaped())
}

// ===========================================================================
// Thin wrappers over the production emitters (each writes into a fresh buffer).
// ===========================================================================

/// `json_escape_into` over a fresh buffer.
fn m22s4_esc(s: &str) -> String {
    let mut out = String::new();
    super::json_escape_into(&mut out, s);
    out
}

/// `json_str_into` over a fresh buffer (quote + escape + quote).
fn m22s4_str(s: &str) -> String {
    let mut out = String::new();
    super::json_str_into(&mut out, s);
    out
}

/// `json_u64_into` over a fresh buffer.
fn m22s4_u64_out(v: u64) -> String {
    let mut out = String::new();
    super::json_u64_into(&mut out, v);
    out
}

/// `json_i64_into` over a fresh buffer.
fn m22s4_i64_out(v: i64) -> String {
    let mut out = String::new();
    super::json_i64_into(&mut out, v);
    out
}

/// `json_u32_into` over a fresh buffer.
fn m22s4_u32_out(v: u32) -> String {
    let mut out = String::new();
    super::json_u32_into(&mut out, v);
    out
}

/// `json_u16_into` over a fresh buffer.
fn m22s4_u16_out(v: u16) -> String {
    let mut out = String::new();
    super::json_u16_into(&mut out, v);
    out
}

/// `json_u8_into` over a fresh buffer.
fn m22s4_u8_out(v: u8) -> String {
    let mut out = String::new();
    super::json_u8_into(&mut out, v);
    out
}

/// `json_i32_into` over a fresh buffer.
fn m22s4_i32_out(v: i32) -> String {
    let mut out = String::new();
    super::json_i32_into(&mut out, v);
    out
}

/// `json_bool_into` over a fresh buffer.
fn m22s4_bool_out(v: bool) -> String {
    let mut out = String::new();
    super::json_bool_into(&mut out, v);
    out
}

/// `json_null_into` over a fresh buffer.
fn m22s4_null_out() -> String {
    let mut out = String::new();
    super::json_null_into(&mut out);
    out
}

/// `json_identity_into` over a fresh buffer.
fn m22s4_ident_out(id: Identity) -> String {
    let mut out = String::new();
    super::json_identity_into(&mut out, id);
    out
}

// ===========================================================================
// The REFERENCE UNESCAPER (test-only, by design).
// ===========================================================================

/// The inverse of the escaping contract. It lives HERE and only here: shipping
/// an inverse in privacy.rs would give the round-trip property a shared bug to
/// agree on.
///
/// STRICT on purpose — an unexpected byte is an Err, never a pass-through, so
/// the property fails on a lossy escaper instead of quietly recovering from it.
fn m22s4_unescape(esc: &str) -> Result<String, String> {
    let chars: Vec<char> = esc.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c != m22s4_bs() {
            if c == rb22p_dq() {
                return Err(format!(
                    "m22s4 [escape/raw-quote]: an UNESCAPED double quote at char {i}. It closes \
                     the JSON string early, so the rest of the payload is parsed as structure."
                ));
            }
            let code = c as u32;
            if code < 0x20 {
                return Err(format!(
                    "m22s4 [escape/raw-control]: a raw C0 control U+{code:04X} at char {i}. Raw \
                     control bytes are invalid inside a JSON string."
                ));
            }
            out.push(c);
            i += 1;
            continue;
        }
        if i + 1 >= chars.len() {
            return Err(
                "m22s4 [escape/trailing]: the output ends in a lone backslash.".to_string(),
            );
        }
        let next = chars[i + 1];
        if next == m22s4_bs() {
            out.push(m22s4_bs());
            i += 2;
            continue;
        }
        if next == rb22p_dq() {
            out.push(rb22p_dq());
            i += 2;
            continue;
        }
        if next != 'u' {
            return Err(format!(
                "m22s4 [escape/unknown]: backslash followed by {next:?} at char {i}. The contract \
                 admits exactly three escapes: the quote, the backslash, and the UNIFORM \
                 six-character control form."
            ));
        }
        if i + 5 >= chars.len() {
            return Err("m22s4 [escape/short-u]: a truncated unicode escape.".to_string());
        }
        let hex: String = chars[i + 2..i + 6].iter().collect();
        if hex.chars().any(|h| h.is_ascii_uppercase()) {
            return Err(format!(
                "m22s4 [escape/case]: the unicode escape {hex:?} uses UPPERCASE hex digits; the \
                 contract is lowercase."
            ));
        }
        let code = u32::from_str_radix(&hex, 16)
            .map_err(|e| format!("m22s4 [escape/hex]: {hex:?} is not four hex digits ({e})"))?;
        let decoded = char::from_u32(code)
            .ok_or_else(|| format!("m22s4 [escape/scalar]: U+{code:04X} is not a scalar value"))?;
        out.push(decoded);
        i += 6;
    }
    Ok(out)
}

// ===========================================================================
// A minimal, WHITESPACE-INTOLERANT JSON well-formedness oracle.
//
// Deliberately not a parser with a value model: it answers exactly one
// question — does this text parse as EXACTLY ONE compact JSON value with no
// trailing garbage? It is the non-vacuity control on the expectation builders
// above (if THEY were wrong, an equality assertion would still pass) and the
// independent instrument the empty-chunk clause reads.
// ===========================================================================

/// Does `s` parse as exactly one compact JSON value?
fn m22s4_json_is_wellformed(s: &str) -> bool {
    let b = s.as_bytes();
    match m22s4_json_value(b, 0) {
        Some(end) => end == b.len(),
        None => false,
    }
}

/// Parse one JSON value at `i`; return the index just past it.
fn m22s4_json_value(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        34u8 => m22s4_json_string(b, i),
        b'{' => m22s4_json_object(b, i),
        b'[' => m22s4_json_array(b, i),
        b't' => m22s4_json_lit(b, i, "true"),
        b'f' => m22s4_json_lit(b, i, "false"),
        b'n' => m22s4_json_lit(b, i, "null"),
        _ => m22s4_json_number(b, i),
    }
}

/// Match a bare literal.
fn m22s4_json_lit(b: &[u8], i: usize, lit: &str) -> Option<usize> {
    let end = i + lit.len();
    if end <= b.len() && &b[i..end] == lit.as_bytes() {
        Some(end)
    } else {
        None
    }
}

/// Parse a JSON string, rejecting raw controls, raw quotes and any escape the
/// contract does not admit.
fn m22s4_json_string(b: &[u8], i: usize) -> Option<usize> {
    if *b.get(i)? != 34u8 {
        return None;
    }
    let mut j = i + 1;
    while j < b.len() {
        let c = b[j];
        if c == 34u8 {
            return Some(j + 1);
        }
        if c < 0x20 {
            return None;
        }
        if c == 92u8 {
            let n = *b.get(j + 1)?;
            if n == b'u' {
                if j + 6 > b.len() {
                    return None;
                }
                if !b[j + 2..j + 6].iter().all(|d| d.is_ascii_hexdigit()) {
                    return None;
                }
                j += 6;
                continue;
            }
            if n != 92u8 && n != 34u8 {
                return None;
            }
            j += 2;
            continue;
        }
        j += 1;
    }
    None
}

/// Parse an integer JSON number (the only numeric shape this export emits).
fn m22s4_json_number(b: &[u8], i: usize) -> Option<usize> {
    let mut j = i;
    if b.get(j) == Some(&b'-') {
        j += 1;
    }
    let start = j;
    while j < b.len() && b[j].is_ascii_digit() {
        j += 1;
    }
    if j == start {
        return None;
    }
    Some(j)
}

/// Parse a JSON array.
fn m22s4_json_array(b: &[u8], i: usize) -> Option<usize> {
    if *b.get(i)? != b'[' {
        return None;
    }
    let mut j = i + 1;
    if b.get(j) == Some(&b']') {
        return Some(j + 1);
    }
    loop {
        j = m22s4_json_value(b, j)?;
        match b.get(j) {
            Some(&b',') => j += 1,
            Some(&b']') => return Some(j + 1),
            _ => return None,
        }
    }
}

/// Parse a JSON object.
fn m22s4_json_object(b: &[u8], i: usize) -> Option<usize> {
    if *b.get(i)? != b'{' {
        return None;
    }
    let mut j = i + 1;
    if b.get(j) == Some(&b'}') {
        return Some(j + 1);
    }
    loop {
        j = m22s4_json_string(b, j)?;
        if b.get(j) != Some(&b':') {
            return None;
        }
        j += 1;
        j = m22s4_json_value(b, j)?;
        match b.get(j) {
            Some(&b',') => j += 1,
            Some(&b'}') => return Some(j + 1),
            _ => return None,
        }
    }
}

// ===========================================================================
// Chunk-payload expectation builders.
//
// Payload shape: an object with the table NAME and a `rows` array. Nothing else
// is duplicated from the ExportBundle columns, so the artifact is
// self-describing after download without restating total_chunks.
// ===========================================================================

/// The literal prefix every chunk payload for `table` must open with.
fn m22s4_chunk_prefix(table: &str) -> String {
    let q = rb22p_dq();
    let mut s = String::new();
    s.push('{');
    s.push(q);
    s.push_str("table");
    s.push(q);
    s.push(':');
    s.push(q);
    s.push_str(table);
    s.push(q);
    s.push(',');
    s.push(q);
    s.push_str("rows");
    s.push(q);
    s.push(':');
    s.push('[');
    s
}

/// The complete expected payload for one chunk.
fn m22s4_expected_payload(table: &str, rows: &[String]) -> String {
    let mut s = m22s4_chunk_prefix(table);
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(row);
    }
    s.push(']');
    s.push('}');
    s
}

/// A synthetic, uniquely identifiable row text for the planner fixtures.
fn m22s4_row_text(table: &str, index: usize) -> String {
    m22s4_obj(&[("t", m22s4_qtxt(table)), ("i", m22s4_bare(index as i128))])
}

/// The chunk count the sub-chunking rule requires for `rows` rows at `per` per
/// chunk. An INDEPENDENT reference (a saturating loop, never a division): an
/// empty table still emits exactly ONE chunk, which `slice::chunks()` does not.
fn m22s4_expected_chunk_count(rows: usize, per: usize) -> usize {
    assert!(per > 0, "m22s4: the chunk size must be non-zero");
    if rows == 0 {
        return 1;
    }
    let mut count = 0usize;
    let mut left = rows;
    while left > 0 {
        count += 1;
        left = left.saturating_sub(per);
    }
    count
}

/// The whole expected plan for a request: `(table, chunk_index, payload)` in
/// dispatch order, with the request-wide contiguous index.
fn m22s4_reference_plan(
    per_table: &[(&'static str, Vec<String>)],
    per: usize,
) -> Vec<(&'static str, u32, String)> {
    let mut out: Vec<(&'static str, u32, String)> = Vec::new();
    let mut idx: u32 = 0;
    for (table_ref, rows) in per_table {
        let table: &'static str = table_ref;
        if rows.is_empty() {
            out.push((table, idx, m22s4_expected_payload(table, &[])));
            idx += 1;
            continue;
        }
        for slice in rows.chunks(per) {
            out.push((table, idx, m22s4_expected_payload(table, slice)));
            idx += 1;
        }
    }
    out
}

/// Fixture table names for the planner property (never a live accessor name).
const M22S4_PLAN_TABLES: [&str; 5] = ["m22s4_t0", "m22s4_t1", "m22s4_t2", "m22s4_t3", "m22s4_t4"];

// ===========================================================================
// m22-s4 SOURCE-SCAN helpers (over this module's existing strip pipeline).
// ===========================================================================

/// Poison marker for a call whose parentheses do not balance.
const M22S4_UNBALANCED: &str = "<<m22s4-unbalanced-call>>";

/// The argument text of every call spelled `<needle>...)` in ALREADY-SQUASHED
/// source. `needle` must end with the opening paren.
///
/// Refusing to classify is the safe direction: an unbalanced span pushes the
/// poison marker instead of being dropped, and every caller fails loud on it.
fn m22s4_call_arg_lists(squashed: &str, needle: &str) -> Vec<String> {
    assert!(
        needle.ends_with('('),
        "m22s4 [args/needle]: the call needle {needle:?} must end with the opening paren."
    );
    let bytes = squashed.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut start = 0usize;
    while let Some(rel) = squashed[start..].find(needle) {
        let open = start + rel + needle.len() - 1;
        let mut depth = 0usize;
        let mut i = open;
        let mut end: Option<usize> = None;
        while i < bytes.len() {
            match bytes[i] {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(i);
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        match end {
            Some(e) => out.push(squashed[open + 1..e].to_string()),
            None => out.push(M22S4_UNBALANCED.to_string()),
        }
        start = open + 1;
    }
    out
}

/// The inner text of the brace-bounded span whose opening brace is at `open`.
fn m22s4_braced_span(squashed: &str, open: usize) -> Option<&str> {
    let bytes = squashed.as_bytes();
    if bytes.get(open) != Some(&b'{') {
        return None;
    }
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&squashed[open + 1..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The brace depth immediately before index `at` in already-squashed text.
fn m22s4_brace_depth_at(squashed: &str, at: usize) -> i64 {
    let mut depth = 0i64;
    for b in squashed[..at].bytes() {
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth -= 1;
        }
    }
    depth
}

/// First-occurrence index of `needle` in `hay`, or a loud panic naming it.
fn m22s4_idx(hay: &str, needle: &str, what: &str) -> usize {
    hay.find(needle).unwrap_or_else(|| {
        panic!(
            "m22s4 [order/missing]: {what} — the needle {needle:?} does not occur in the scanned \
             span at all, so any ORDERING or DEPTH clause reading it would compare a missing \
             position and pass VACUOUSLY. Failing loud instead."
        )
    })
}

/// Is `c` a Rust identifier character?
fn m22s4_is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Occurrences of `needle` in ALREADY-SQUASHED source preceded by a
/// non-identifier byte (a LEFT-only word boundary).
///
/// Left-only, measured against this module's own pipeline, for the reason
/// rb22p_no_early_return_in_purge records: squash_ws fuses a return keyword into
/// the expression that follows it, so a RIGHT boundary would blind the count to
/// exactly the shape it exists to count.
fn m22s4_left_bounded_count(squashed: &str, needle: &str) -> usize {
    let bytes = squashed.as_bytes();
    let mut n = 0usize;
    let mut start = 0usize;
    while let Some(rel) = squashed[start..].find(needle) {
        let at = start + rel;
        if at == 0 || !is_word_byte(bytes[at - 1]) {
            n += 1;
        }
        start = at + needle.len();
    }
    n
}

/// Every `ctx.db.<accessor>` name in an already-squashed span.
fn m22s4_db_accessors(squashed: &str) -> Vec<String> {
    let prefix = concat!("ctx", ".db.");
    let mut out: Vec<String> = Vec::new();
    let mut start = 0usize;
    while let Some(rel) = squashed[start..].find(prefix) {
        let at = start + rel + prefix.len();
        let name: String = squashed[at..]
            .chars()
            .take_while(|c| m22s4_is_word_char(*c))
            .collect();
        out.push(name);
        start = at;
    }
    out
}

// --- squashed needles, assembled from fragments ------------------------------

/// The squashed `fn` needle for the S4 reducer.
fn m22s4_nd_reducer_fn() -> String {
    concat!("fnrequest_data", "_export(").to_string()
}

/// The frozen squashed signature of the S4 reducer.
fn m22s4_reducer_sig_pin() -> String {
    concat!(
        "fnrequest_data",
        "_export(ctx:&ReducerContext)->Result<(),String>"
    )
    .to_string()
}

/// The reducer attribute, split so this file never carries it contiguously.
fn m22s4_nd_reducer_attr() -> String {
    concat!("#[spacetimedb::", "reducer]").to_string()
}

/// The squashed `fn` needle for the owner-scoped view.
fn m22s4_nd_view_fn() -> String {
    concat!("fnmy_export", "_bundle(").to_string()
}

/// The squashed view attribute pin.
fn m22s4_view_attr_pin() -> String {
    concat!(
        "#[spacetimedb::",
        "view(accessor=my_export",
        "_bundle,public)]"
    )
    .to_string()
}

/// The frozen squashed signature of the view.
fn m22s4_view_sig_pin() -> String {
    concat!(
        "fnmy_export",
        "_bundle(ctx:&spacetimedb::ViewContext)->Vec<ExportBundle>"
    )
    .to_string()
}

/// The frozen squashed view BODY.
fn m22s4_view_body_pin() -> String {
    [
        concat!("ctx", ".db."),
        concat!("export", "_bundle()"),
        ".owner_identity()",
        ".filter(",
        concat!("ctx", ".sender()"),
        ")",
        ".collect()",
    ]
    .concat()
}

/// The accepted BORROW twin of the view body (the my_monster_pub precedent
/// compiles either way, so both spellings are sanctioned).
fn m22s4_view_body_pin_borrowed() -> String {
    [
        concat!("ctx", ".db."),
        concat!("export", "_bundle()"),
        ".owner_identity()",
        ".filter(&",
        concat!("ctx", ".sender()"),
        ")",
        ".collect()",
    ]
    .concat()
}

/// The view declaration as WHITESPACE-BEARING source text (the positive
/// control's input).
fn m22s4_view_decl_source() -> String {
    [
        concat!(
            "#[spacetimedb::",
            "view(accessor = my_export",
            "_bundle, public)]\n"
        ),
        concat!(
            "fn my_export",
            "_bundle(ctx: &spacetimedb::ViewContext) -> Vec<ExportBundle> "
        ),
    ]
    .concat()
}

/// The view body as WHITESPACE-BEARING source text (the positive control's
/// input). Independently spelled from the pin above: feeding this through the
/// LIVE pipeline must reproduce the pin byte for byte, which is what proves the
/// equality pin is SATISFIABLE rather than a typo nobody can ever match.
fn m22s4_view_body_source() -> String {
    [
        "\n    ",
        concat!("ctx", ".db"),
        "\n        .",
        concat!("export", "_bundle()"),
        "\n        .owner_identity()",
        "\n        .filter(",
        concat!("ctx", ".sender()"),
        ")",
        "\n        .collect()\n",
    ]
    .concat()
}

/// The bare purge token (never spelled contiguously — crate naming census).
fn m22s4_purge_token() -> String {
    concat!("purge_export", "_bundles").to_string()
}

/// The sanctioned squashed call spelling inside the reducer.
fn m22s4_purge_call_pin() -> String {
    concat!("purge_export", "_bundles(ctx,me);").to_string()
}

/// The squashed `ctx.db.export_bundle()` accessor chain.
fn m22s4_nd_bundle_accessor() -> String {
    [concat!("ctx", ".db."), concat!("export", "_bundle()")].concat()
}

/// The squashed export_bundle write verb.
fn m22s4_nd_bundle_insert() -> String {
    [
        m22s4_nd_bundle_accessor(),
        concat!(".ins", "ert(").to_string(),
    ]
    .concat()
}

/// The squashed, scoped body of `request_data_export`, or a loud panic.
///
/// Scoped, never whole-file: rb22p_machinery_comment_string_blind's decoy arm
/// records why (text sitting in a sibling fn must never satisfy a clause about
/// this one).
fn m22s4_reducer_body(squashed: &str) -> String {
    let needle = m22s4_nd_reducer_fn();
    let n = rb22p_count(squashed, &needle);
    assert_eq!(
        n, 1,
        "m22s4 [reducer/scope]: privacy.rs must define `{needle}` exactly once; found {n}. Zero \
         means the S4 reducer does not exist yet (the intended RED before the implementer lands \
         it); two makes every body clause below read whichever definition the extractor reaches \
         first, leaving the other completely ungated."
    );
    let body = extract_squashed_fn_body(squashed, &needle).unwrap_or_else(|| {
        panic!(
            "m22s4 [reducer/scope]: `{needle}` was found but its body is not brace-balanced, so \
             every clause scoped to it would run over an arbitrary span and pass VACUOUSLY."
        )
    });
    assert!(
        body.len() > 80,
        "m22s4 [reducer/vacuity]: the reducer body is only {} squashed byte(s). An empty or stub \
         body makes every ordering and containment clause below pass over nothing.",
        body.len()
    );
    body.to_string()
}

/// The squashed, scoped body of one `rows_<table>` shell reader, with its
/// signature pinned first so a renamed or re-shaped reader reds LOUD.
///
/// SIGNATURE NORMALIZATION (the rustfmt vertical-wrap twin). The one-line
/// spelling of the longest reader name is 101 characters, one past rustfmt's
/// max_width, so rustfmt MUST break its parameter list across lines — and its
/// vertical argument form appends a trailing comma, which squashes to
/// `owner:Identity,)`. The escape hatch is not available either: a
/// rustfmt-skip attribute is banned crate-wide, because skipping the formatter
/// defeats fmt-as-normalizer, which every squashed scan in this crate relies
/// on. So the comma is NOT a stylistic choice the implementer can make either
/// way — for that one reader it is mandatory. This helper therefore drops ONE
/// comma sitting immediately before the parameter list's closing paren before
/// comparing. The two spellings are the same Rust: parameter NAMES, TYPES,
/// ARITY and the RETURN TYPE all stay pinned exactly, so nothing this pin
/// exists to protect is loosened — a second parameter still reds, because it
/// changes the text between the parens, not the comma before them.
fn m22s4_rows_body(squashed: &str, table: &str) -> String {
    let needle = format!("fnrows_{table}(");
    let n = rb22p_count(squashed, &needle);
    assert_eq!(
        n, 1,
        "m22s4 [rows/scope]: privacy.rs must declare `{needle}` exactly once; found {n}. Zero is \
         the intended RED before the implementer lands the shell reader; two makes every clause \
         below read whichever one the extractor reaches first."
    );

    let sig = extract_squashed_fn_sig(squashed, &needle)
        .unwrap_or_else(|| panic!("m22s4 [rows/sig]: `{needle}` has no opening brace."));

    // Walk from the parameter list's opening paren to its matching close. The
    // walk is depth-counted rather than a search for the last paren, so a
    // parenthesised TYPE in some future parameter cannot move the target.
    let bytes = sig.as_bytes();
    let open = sig
        .find('(')
        .unwrap_or_else(|| panic!("m22s4 [rows/sig]: `{needle}` has no parameter list."));
    let mut depth = 0usize;
    let mut found: Option<usize> = None;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    found = Some(i);
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let close = found.unwrap_or_else(|| {
        panic!(
            "m22s4 [rows/sig]: the parameter list of `{needle}` is not paren-balanced, so the \
             normalization below would read an arbitrary span. Refusing to classify is the safe \
             direction."
        )
    });
    let normalized: String = if close > 0 && bytes[close - 1] == b',' {
        let mut out = String::with_capacity(sig.len() - 1);
        out.push_str(&sig[..close - 1]);
        out.push_str(&sig[close..]);
        out
    } else {
        sig.to_string()
    };

    let expected =
        format!("fnrows_{table}(ctx:&ReducerContext,owner:Identity)->Result<Vec<String>,String>");
    assert_eq!(
        normalized, expected,
        "m22s4 [rows/sig]: the `{table}` shell reader must carry the frozen signature. The \
         context is named `ctx` (every alias ban in this module keys on that name) and the \
         subject arrives as `owner: Identity` — a reader that takes any OTHER identity-typed \
         parameter, or none, is a caller-chosen-owner read of a private table. The comparison \
         is made after dropping ONE comma sitting immediately before the parameter list's \
         closing paren: that trailing-comma twin is ACCEPTED because rustfmt wraps any \
         signature past its max_width and its vertical argument form emits the comma, while a \
         rustfmt-skip attribute is banned crate-wide (skipping the formatter defeats \
         fmt-as-normalizer, which every squashed scan here depends on) — so for the longest \
         reader name no fmt-canonical spelling can avoid it. Only the comma is normalized; \
         parameter names, types, arity and the return type are still pinned exactly."
    );

    let body = extract_squashed_fn_body(squashed, &needle)
        .unwrap_or_else(|| panic!("m22s4 [rows/scope]: `{needle}` body is not brace-balanced."));
    assert!(
        !body.is_empty(),
        "m22s4 [rows/vacuity]: `{needle}` has an EMPTY body, so every own-rows clause about it \
         would pass over nothing."
    );
    body.to_string()
}

// ===========================================================================
// Cross-manifest extraction: the JS re-key manifest, read as TEXT.
//
// A LOCAL PORT of the accounts_tests.rs T9 idiom, not an import: sibling
// `_tests.rs` modules never import each other in this crate (per-module
// convention), and a shared helper would couple two independent gate files.
// ===========================================================================

/// The re-key manifest eval, read as TEXT (never imported).
const M22S4_REKEY_EVAL_MJS: &str = include_str!("../../evals/guest-claim-integrity.eval.mjs");

/// Blank every to-end-of-line comment in a JS source.
///
/// Load-bearing, not cosmetic: the manifest's COMMENT prose contains
/// apostrophes, and one apostrophe inside a comment silently swallowed a key
/// when the accounts_tests.rs twin of this scan was first drafted without it.
fn m22s4_strip_js_line_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut in_comment = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            in_comment = false;
            out.push(b'\n');
            i += 1;
            continue;
        }
        if !in_comment && bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            in_comment = true;
            i += 2;
            continue;
        }
        if !in_comment {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(out).expect("m22s4: comment-stripped JS source must be valid UTF-8")
}

/// Is `s` shaped like a table-dot-column manifest key?
fn m22s4_is_table_column_key(s: &str) -> bool {
    let mut dots = 0usize;
    for c in s.chars() {
        if c == '.' {
            dots += 1;
            continue;
        }
        if !m22s4_is_word_char(c) {
            return false;
        }
    }
    if dots != 1 {
        return false;
    }
    match s.split_once('.') {
        Some((table, column)) => !table.is_empty() && !column.is_empty(),
        None => false,
    }
}

/// Every table-dot-column key inside the JS re-key manifest object literal.
///
/// Brace-walked from the sole anchor; a key is a single-quoted span immediately
/// followed by a colon that is shaped like a column key, so the object VALUES —
/// also single-quoted, several of them carrying apostrophes — cannot be
/// mistaken for keys.
fn m22s4_rekey_manifest_keys() -> Vec<String> {
    let src = m22s4_strip_js_line_comments(M22S4_REKEY_EVAL_MJS);
    let anchor = concat!("REKEY_MAN", "IFEST = freezeManifest({");
    let at = src.find(anchor).unwrap_or_else(|| {
        panic!(
            "m22s4 [rekey/anchor]: the anchor {anchor:?} was not found in \
             evals/guest-claim-integrity.eval.mjs. The JS manifest moved or was renamed, so the \
             cross-manifest proof has NO input and must never pass vacuously. FORMATTER TRAP: a \
             biome quote-style rewrite has silently truncated an include_str key scan in this \
             repo before, which is why the caller also asserts a floor AND a named anchor key."
        )
    });
    let open = at + anchor.len() - 1;
    let bytes = src.as_bytes();
    assert_eq!(
        bytes[open], b'{',
        "m22s4 [rekey/anchor]: the anchor did not land on the object literal's opening brace."
    );
    let mut depth = 0usize;
    let mut end = open;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = i;
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    assert!(
        end > open,
        "m22s4 [rekey/braces]: the re-key manifest object literal is not brace-balanced from its \
         anchor, so the key scan would read an arbitrary suffix of the file."
    );

    let block = &src[open..end];
    let block_bytes = block.as_bytes();
    let mut keys: Vec<String> = Vec::new();
    let mut k = 0usize;
    while k < block_bytes.len() {
        if block_bytes[k] != b'\'' {
            k += 1;
            continue;
        }
        let mut j = k + 1;
        while j < block_bytes.len() && block_bytes[j] != b'\'' {
            j += 1;
        }
        if j >= block_bytes.len() {
            break;
        }
        let span = &block[k + 1..j];
        let after = if j + 1 < block_bytes.len() {
            block_bytes[j + 1]
        } else {
            b' '
        };
        if after == b':' && m22s4_is_table_column_key(span) {
            keys.push(span.to_string());
        }
        k = j + 1;
    }
    keys
}

// ===========================================================================
// THE FILTER FACTS: how each of the seventeen exportable tables is read, and
// which identity column carries the own-rows proof (plan section 2.7).
// ===========================================================================

/// The read shape a `rows_<table>` shell reader must use.
enum M22s4Read {
    /// The identity column is indexed (btree or PK), so the reader keys the
    /// index scan directly on `owner`: either a find or a filter.
    Direct,
    /// No index on the identity column: a full table scan IMMEDIATELY bounded
    /// by the named extracted pure predicate.
    ScanPredicate(&'static str),
    /// No Identity column at all: reached through the owning player row's
    /// entity_id (the manifest's join-only classification).
    ViaPlayerJoin,
}

/// One table's own-rows contract.
struct M22s4FilterFact {
    /// The table accessor, exactly as DATA_LIFECYCLE_MANIFEST spells it.
    table: &'static str,
    /// Its Identity column(s). EMPTY only for the join-only `character`.
    columns: &'static [&'static str],
    shape: M22s4Read,
}

/// All seventeen exportable tables. The set is re-proved EQUAL to the manifest's
/// exportable set inside the test, so this table cannot silently drift.
///
/// The wallet accessor name is concat!-split for the reason stated in this
/// block's header.
const M22S4_FILTER_FACTS: &[M22s4FilterFact] = &[
    M22s4FilterFact {
        table: "monster",
        columns: &["owner_identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "monster_pub",
        columns: &["owner_identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "inventory",
        columns: &["owner_identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "player_dialogue_state",
        columns: &["owner_identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "player_quest",
        columns: &["owner_identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "player_conversation",
        columns: &["owner_identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "heal_cooldown",
        columns: &["owner_identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: concat!("player", "_wallet"),
        columns: &["owner_identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "playtest_event",
        columns: &["identity"],
        shape: M22s4Read::ScanPredicate("playtest_event_is_own"),
    },
    M22s4FilterFact {
        table: "trade_offer",
        columns: &["initiator", "counterparty"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "battle_challenge",
        columns: &["challenger", "target"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "battle_action",
        columns: &["player_identity"],
        shape: M22s4Read::ScanPredicate("battle_action_is_own"),
    },
    M22s4FilterFact {
        table: "player",
        columns: &["identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "profile",
        columns: &["identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "account",
        columns: &["identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "battle",
        columns: &["player_identity", "opponent_identity"],
        shape: M22s4Read::Direct,
    },
    M22s4FilterFact {
        table: "character",
        columns: &[],
        shape: M22s4Read::ViaPlayerJoin,
    },
];

/// The identity fact a join-only table borrows from its owning parent.
const M22S4_JOIN_PARENT_KEY: &str = "player.identity";

/// The exportable:true table names, read off the LIVE manifest.
fn m22s4_manifest_exportable() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in DATA_LIFECYCLE_MANIFEST {
        if entry.exportable {
            out.push(entry.table.to_string());
        }
    }
    out
}

/// The exportable:false table names, read off the LIVE manifest.
fn m22s4_manifest_not_exportable() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in DATA_LIFECYCLE_MANIFEST {
        if !entry.exportable {
            out.push(entry.table.to_string());
        }
    }
    out
}

// ===========================================================================
// Battle fixtures (shared by the four redaction tests).
// ===========================================================================

/// A BattleState carrying deliberately DISTINCTIVE, multi-digit field values.
///
/// It exists so the omission test has something REAL to prove absent: every
/// banned needle in m22s4_battle_state_blob_is_never_emitted is first asserted
/// PRESENT in this value's Debug rendering, which is what proves the ban list
/// names actual BattleState content rather than typos nobody can ever match.
fn m22s4_battle_state() -> BattleState {
    let monster = BattleMonster {
        species_id: 9091,
        affinity: Affinity::Electric,
        level: 213,
        current_hp: 1777,
        max_hp: 8888,
        stats: StatBlock {
            hp: 8181,
            attack: 6161,
            defense: 6262,
            speed: 6363,
            sp_attack: 6464,
            sp_defense: 6565,
        },
        known_skill_ids: vec![7007, 8008],
        status: None,
    };
    BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![monster.clone()],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![monster],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 3131,
        weather: None,
    }
}

/// A battle row with the frozen fixture ids/timestamps and the state blob.
fn m22s4_battle_row(player: Identity, opponent: Identity) -> Battle {
    Battle {
        battle_id: 14,
        player_identity: player,
        opponent_identity: opponent,
        state: m22s4_battle_state(),
        party_monster_ids: vec![1, 2],
        opponent_monster_ids: vec![3],
        created_at_ms: 46,
    }
}

/// The expected json_battle output for one row, given what each identity column
/// and each monster-id list must render as.
///
/// SIX fields, in DECLARATION order, with `state` ABSENT: the state blob is
/// omitted entirely and neither outcome nor turn_number is lifted out of it
/// (they are BattleState fields, not Battle columns).
fn m22s4_expected_battle(
    player: String,
    opponent: String,
    party: String,
    opponent_ids: String,
) -> String {
    m22s4_obj(&[
        ("battle_id", m22s4_quoted_num(14)),
        ("player_identity", player),
        ("opponent_identity", opponent),
        ("party_monster_ids", party),
        ("opponent_monster_ids", opponent_ids),
        ("created_at_ms", m22s4_quoted_num(46)),
    ])
}

/// The party list: u64 elements QUOTED per the 64-bit rule.
fn m22s4_party_ids_json() -> String {
    m22s4_arr(&[m22s4_quoted_num(1), m22s4_quoted_num(2)])
}

/// The opponent list.
fn m22s4_opponent_ids_json() -> String {
    m22s4_arr(&[m22s4_quoted_num(3)])
}

/// A battle_action row for the own-rows fixtures. Both fixtures share ONE
/// battle_id on purpose: a predicate keyed on battle_id instead of on the
/// submitting identity returns true for BOTH rows and is killed here.
fn m22s4_action_row(action_id: u64, who: Identity) -> BattleAction {
    BattleAction {
        action_id,
        battle_id: 99,
        player_identity: who,
        action: PvpAction::Attack { skill_id: 3 },
        turn_number: 7,
        submitted_at_ms: 45,
    }
}

/// A playtest_event row for the own-rows fixtures. Same shared-battle_id trap.
fn m22s4_playtest_row(event_id: u64, who: Identity) -> PlaytestEvent {
    PlaytestEvent {
        event_id,
        identity: who,
        kind: 1,
        created_at_ms: 12345,
        battle_id: 99,
        species_id: 9,
        hp_permille: 750,
        bait_item_id: 3,
        success: true,
    }
}

// ===========================================================================
// PRV1-11 / X1 — the seventeen pure per-table serializers.
// ===========================================================================

/// PRV1-11 / X1: every exportable table's row serializes to EXACTLY the
/// sanctioned JSON object — every column, in declaration order, with the
/// contract's encoding per type.
///
/// EXHAUSTIVE STRUCT LITERALS, no spread and no default, in every fixture. That
/// is the whole privacy posture expressed as a test: a new column added to an
/// exportable table is a COMPILE ERROR here, which forces a deliberate
/// export-or-omit decision per column instead of a silent auto-export.
///
/// EQUALITY, not containment. A containment check is green on an appended
/// field, on a reordered pair and on a widened encoding alike — and the export
/// is a durable artifact a subject may hand to a regulator, so its shape is a
/// contract, not an implementation detail.
///
/// Kills: emitting a u64/i64 as a BARE JSON number (the fixtures deliberately
///        sit past 2^53, where JSON.parse silently rounds);
///        quoting a 32-bit-or-narrower column (breaks the client's arithmetic);
///        dropping or reordering any column;
///        emitting an enum by discriminant instead of by variant NAME;
///        a wildcard match arm that renders two variants alike (every enum
///        fixture picks a NON-first variant, so a match collapsed to its first
///        arm fails);
///        leaking a raw quote / backslash / control byte out of a
///        player-authored string (every String column carries the same
///        adversarial value);
///        emitting null for an empty Vec instead of an empty array.
#[test]
fn m22s4_serializer_per_table_shape() {
    let owner = m22s4_id_a();
    let other = m22s4_id_b();
    let nasty = m22s4_nasty();
    let nasty_json = m22s4_nasty_json();

    // --- monster (44 columns, the widest row in the export) -----------------
    let monster = Monster {
        monster_id: 7,
        owner_identity: owner,
        species_id: 3,
        nickname: nasty.clone(),
        level: 5,
        xp: 1234,
        iv_hp: 11,
        iv_attack: 12,
        iv_defense: 13,
        iv_speed: 14,
        iv_sp_attack: 15,
        iv_sp_defense: 16,
        nature_kind: NatureKind::Sassy,
        ev_hp: 21,
        ev_attack: 22,
        ev_defense: 23,
        ev_speed: 24,
        ev_sp_attack: 25,
        ev_sp_defense: 26,
        stat_hp: 31,
        stat_attack: 32,
        stat_defense: 33,
        stat_speed: 34,
        stat_sp_attack: 35,
        stat_sp_defense: 36,
        current_hp: 41,
        party_slot: 2,
        last_care_at_ms: -9,
        essence_fire: 51,
        essence_water: 52,
        essence_plant: 53,
        essence_electric: 54,
        essence_earth: 55,
        essence_wind: 56,
        essence_light: 57,
        essence_dark: 58,
        trust_favorable_count: 61,
        trust_unfavorable_count: 62,
        trust_favorable_battle_day_epoch: 63,
        quality_time_ticks_total: 64,
        quality_time_accum_ms: 65,
        quality_time_window_ms: 66,
        quality_time_window_start_ms: 9_007_199_254_740_993,
        last_essence_train_at_ms: i64::MIN,
    };
    let out_monster = super::json_monster(&monster);
    assert_eq!(
        out_monster,
        m22s4_obj(&[
            ("monster_id", m22s4_quoted_num(7)),
            ("owner_identity", m22s4_qid(owner)),
            ("species_id", m22s4_bare(3)),
            ("nickname", nasty_json.clone()),
            ("level", m22s4_bare(5)),
            ("xp", m22s4_bare(1234)),
            ("iv_hp", m22s4_bare(11)),
            ("iv_attack", m22s4_bare(12)),
            ("iv_defense", m22s4_bare(13)),
            ("iv_speed", m22s4_bare(14)),
            ("iv_sp_attack", m22s4_bare(15)),
            ("iv_sp_defense", m22s4_bare(16)),
            ("nature_kind", m22s4_qtxt("Sassy")),
            ("ev_hp", m22s4_bare(21)),
            ("ev_attack", m22s4_bare(22)),
            ("ev_defense", m22s4_bare(23)),
            ("ev_speed", m22s4_bare(24)),
            ("ev_sp_attack", m22s4_bare(25)),
            ("ev_sp_defense", m22s4_bare(26)),
            ("stat_hp", m22s4_bare(31)),
            ("stat_attack", m22s4_bare(32)),
            ("stat_defense", m22s4_bare(33)),
            ("stat_speed", m22s4_bare(34)),
            ("stat_sp_attack", m22s4_bare(35)),
            ("stat_sp_defense", m22s4_bare(36)),
            ("current_hp", m22s4_bare(41)),
            ("party_slot", m22s4_bare(2)),
            ("last_care_at_ms", m22s4_quoted_num(-9)),
            ("essence_fire", m22s4_bare(51)),
            ("essence_water", m22s4_bare(52)),
            ("essence_plant", m22s4_bare(53)),
            ("essence_electric", m22s4_bare(54)),
            ("essence_earth", m22s4_bare(55)),
            ("essence_wind", m22s4_bare(56)),
            ("essence_light", m22s4_bare(57)),
            ("essence_dark", m22s4_bare(58)),
            ("trust_favorable_count", m22s4_bare(61)),
            ("trust_unfavorable_count", m22s4_bare(62)),
            ("trust_favorable_battle_day_epoch", m22s4_bare(63)),
            ("quality_time_ticks_total", m22s4_bare(64)),
            ("quality_time_accum_ms", m22s4_bare(65)),
            ("quality_time_window_ms", m22s4_bare(66)),
            (
                "quality_time_window_start_ms",
                m22s4_quoted_num(9_007_199_254_740_993),
            ),
            (
                "last_essence_train_at_ms",
                m22s4_quoted_num(i64::MIN as i128),
            ),
        ]),
        "m22s4 [X1/monster]: the private monster row must emit every column in declaration order \
         — the six IV columns, the six EV columns and the nature NAME included (the export is \
         the SUBJECT's own data, so the need-to-know rule that hides genes from OTHER players \
         does not apply), u64/i64 as QUOTED decimal strings, and the nickname escaped."
    );

    // --- monster_pub (26 columns) -------------------------------------------
    let monster_pub = MonsterPub {
        monster_id: 8,
        owner_identity: owner,
        species_id: 4,
        nickname: nasty.clone(),
        level: 6,
        xp: 4321,
        current_hp: 42,
        stat_hp: 71,
        stat_attack: 72,
        stat_defense: 73,
        stat_speed: 74,
        stat_sp_attack: 75,
        stat_sp_defense: 76,
        party_slot: 3,
        tier: 1,
        essence_fire: 81,
        essence_water: 82,
        essence_plant: 83,
        essence_electric: 84,
        essence_earth: 85,
        essence_wind: 86,
        essence_light: 87,
        essence_dark: 88,
        trust_tier: TrustTier::Devoted,
        quality_time_tier: 4,
        nutrition_pct: 55,
    };
    let out_monster_pub = super::json_monster_pub(&monster_pub);
    assert_eq!(
        out_monster_pub,
        m22s4_obj(&[
            ("monster_id", m22s4_quoted_num(8)),
            ("owner_identity", m22s4_qid(owner)),
            ("species_id", m22s4_bare(4)),
            ("nickname", nasty_json.clone()),
            ("level", m22s4_bare(6)),
            ("xp", m22s4_bare(4321)),
            ("current_hp", m22s4_bare(42)),
            ("stat_hp", m22s4_bare(71)),
            ("stat_attack", m22s4_bare(72)),
            ("stat_defense", m22s4_bare(73)),
            ("stat_speed", m22s4_bare(74)),
            ("stat_sp_attack", m22s4_bare(75)),
            ("stat_sp_defense", m22s4_bare(76)),
            ("party_slot", m22s4_bare(3)),
            ("tier", m22s4_bare(1)),
            ("essence_fire", m22s4_bare(81)),
            ("essence_water", m22s4_bare(82)),
            ("essence_plant", m22s4_bare(83)),
            ("essence_electric", m22s4_bare(84)),
            ("essence_earth", m22s4_bare(85)),
            ("essence_wind", m22s4_bare(86)),
            ("essence_light", m22s4_bare(87)),
            ("essence_dark", m22s4_bare(88)),
            ("trust_tier", m22s4_qtxt("Devoted")),
            ("quality_time_tier", m22s4_bare(4)),
            ("nutrition_pct", m22s4_bare(55)),
        ]),
        "m22s4 [X1/monster_pub]: all 26 columns in declaration order. trust_tier is a \
         five-variant enum whose derived default is the MIDDLE band, so the fixture picks the \
         LAST variant: an encoder collapsed to its first arm, or one that renders the default, \
         fails here."
    );

    // --- inventory ----------------------------------------------------------
    let inventory = Inventory {
        inv_id: 9,
        owner_identity: owner,
        item_id: 12,
        count: 34,
    };
    let out_inventory = super::json_inventory(&inventory);
    assert_eq!(
        out_inventory,
        m22s4_obj(&[
            ("inv_id", m22s4_quoted_num(9)),
            ("owner_identity", m22s4_qid(owner)),
            ("item_id", m22s4_bare(12)),
            ("count", m22s4_bare(34)),
        ]),
        "m22s4 [X1/inventory]: inv_id is u64 (quoted); item_id and count are u32 (bare)."
    );

    // --- player_dialogue_state (two string-list columns) --------------------
    let dialogue = PlayerDialogueStateRow {
        owner_identity: owner,
        flags: vec![nasty.clone(), "plain".to_string()],
        done_quests: vec![],
    };
    let out_dialogue = super::json_player_dialogue_state(&dialogue);
    assert_eq!(
        out_dialogue,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(owner)),
            (
                "flags",
                m22s4_arr(&[nasty_json.clone(), m22s4_qtxt("plain")]),
            ),
            ("done_quests", m22s4_arr(&[])),
        ]),
        "m22s4 [X1/player_dialogue_state]: a string list is a JSON ARRAY of escaped strings, and \
         an EMPTY list is an empty array — never null and never an omitted key. Dialogue flags \
         gate content branches, so the subject is entitled to them verbatim."
    );

    // --- player_quest -------------------------------------------------------
    let quest = PlayerQuestRow {
        pq_id: 10,
        owner_identity: owner,
        quest_id: nasty.clone(),
        step_index: 3,
    };
    let out_quest = super::json_player_quest(&quest);
    assert_eq!(
        out_quest,
        m22s4_obj(&[
            ("pq_id", m22s4_quoted_num(10)),
            ("owner_identity", m22s4_qid(owner)),
            ("quest_id", nasty_json.clone()),
            ("step_index", m22s4_bare(3)),
        ]),
        "m22s4 [X1/player_quest]: pq_id is u64 (quoted); step_index is u32 (bare)."
    );

    // --- player_conversation ------------------------------------------------
    let conversation = PlayerConversation {
        owner_identity: owner,
        npc_entity_id: 77,
        current_node_id: nasty.clone(),
    };
    let out_conversation = super::json_player_conversation(&conversation);
    assert_eq!(
        out_conversation,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(owner)),
            ("npc_entity_id", m22s4_quoted_num(77)),
            ("current_node_id", nasty_json.clone()),
        ]),
        "m22s4 [X1/player_conversation]: npc_entity_id is a u64 entity key and is quoted."
    );

    // --- heal_cooldown ------------------------------------------------------
    let heal = HealCooldown {
        owner_identity: owner,
        last_heal_at_ms: 1_700_000_000_000,
    };
    let out_heal = super::json_heal_cooldown(&heal);
    assert_eq!(
        out_heal,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(owner)),
            ("last_heal_at_ms", m22s4_quoted_num(1_700_000_000_000)),
        ]),
        "m22s4 [X1/heal_cooldown]: a wall-clock ms stamp is i64 and must be a QUOTED decimal \
         string."
    );

    // --- the wallet row (alias-imported; see this block's hygiene header) ----
    let wallet = M22s4WalletRow {
        owner_identity: owner,
        balance: u64::MAX,
    };
    let out_wallet = super::json_player_wallet(&wallet);
    assert_eq!(
        out_wallet,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(owner)),
            ("balance", m22s4_quoted_num(u64::MAX as i128)),
        ]),
        "m22s4 [X1/wallet]: the balance is u64 and MUST be a quoted decimal string. At u64::MAX a \
         BARE JSON number round-trips through the client parser as a rounded value — a silently \
         WRONG balance in the subject's own export."
    );

    // --- playtest_event -----------------------------------------------------
    let playtest = m22s4_playtest_row(100, owner);
    let out_playtest = super::json_playtest_event(&playtest);
    assert_eq!(
        out_playtest,
        m22s4_obj(&[
            ("event_id", m22s4_quoted_num(100)),
            ("identity", m22s4_qid(owner)),
            ("kind", m22s4_bare(1)),
            ("created_at_ms", m22s4_quoted_num(12345)),
            ("battle_id", m22s4_quoted_num(99)),
            ("species_id", m22s4_bare(9)),
            ("hp_permille", m22s4_bare(750)),
            ("bait_item_id", m22s4_bare(3)),
            ("success", m22s4_bool(true)),
        ]),
        "m22s4 [X1/playtest_event]: identity-scoped telemetry is the subject's personal data \
         (manifest policy Erase, exportable true). kind and hp_permille are u16 and success is a \
         bool — all three BARE."
    );

    // --- trade_offer (nested item and card arrays) --------------------------
    let trade = TradeOffer {
        trade_id: 11,
        initiator: owner,
        counterparty: other,
        initiator_monster_ids: vec![1, 2],
        initiator_items: vec![TradeItem { item_id: 5, qty: 6 }],
        initiator_currency: 1000,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![MonsterCard {
            monster_id: 3,
            species_id: 4,
            nickname: nasty.clone(),
            level: 5,
            current_hp: 6,
            stat_hp: 7,
        }],
        counterparty_cards: vec![],
        status: TradeStatus::ConfirmedByCounterparty,
        created_at_ms: 42,
    };
    let expected_card = m22s4_obj(&[
        ("monster_id", m22s4_quoted_num(3)),
        ("species_id", m22s4_bare(4)),
        ("nickname", nasty_json.clone()),
        ("level", m22s4_bare(5)),
        ("current_hp", m22s4_bare(6)),
        ("stat_hp", m22s4_bare(7)),
    ]);
    let expected_item = m22s4_obj(&[("item_id", m22s4_bare(5)), ("qty", m22s4_bare(6))]);
    let out_trade = super::json_trade_offer(&trade);
    assert_eq!(
        out_trade,
        m22s4_obj(&[
            ("trade_id", m22s4_quoted_num(11)),
            ("initiator", m22s4_qid(owner)),
            ("counterparty", m22s4_qid(other)),
            (
                "initiator_monster_ids",
                m22s4_arr(&[m22s4_quoted_num(1), m22s4_quoted_num(2)]),
            ),
            ("initiator_items", m22s4_arr(&[expected_item])),
            ("initiator_currency", m22s4_quoted_num(1000)),
            ("counterparty_monster_ids", m22s4_arr(&[])),
            ("counterparty_items", m22s4_arr(&[])),
            ("counterparty_currency", m22s4_quoted_num(0)),
            ("initiator_cards", m22s4_arr(&[expected_card])),
            ("counterparty_cards", m22s4_arr(&[])),
            ("status", m22s4_qtxt("ConfirmedByCounterparty")),
            ("created_at_ms", m22s4_quoted_num(42)),
        ]),
        "m22s4 [X1/trade_offer]: nested item and card values are OBJECTS with their own field \
         order; every u64 (trade_id, the monster-id lists, both currency columns, the card's \
         monster_id) is quoted; status is the SECOND variant, so an encoder collapsed to its \
         first arm fails. The spec names battle as the ONLY redacted table, so the counterparty \
         identity on a trade the subject is a party to is exported as-is."
    );

    // --- battle_challenge ---------------------------------------------------
    let challenge = BattleChallenge {
        challenge_id: 12,
        challenger: owner,
        target: other,
        challenger_party_ids: vec![9],
        status: ChallengeStatus::Cancelled,
        created_at_ms: 43,
    };
    let out_challenge = super::json_battle_challenge(&challenge);
    assert_eq!(
        out_challenge,
        m22s4_obj(&[
            ("challenge_id", m22s4_quoted_num(12)),
            ("challenger", m22s4_qid(owner)),
            ("target", m22s4_qid(other)),
            ("challenger_party_ids", m22s4_arr(&[m22s4_quoted_num(9)])),
            ("status", m22s4_qtxt("Cancelled")),
            ("created_at_ms", m22s4_quoted_num(43)),
        ]),
        "m22s4 [X1/battle_challenge]: the challenge status renders as its variant NAME, and the \
         fixture picks the LAST of the four variants so a first-arm collapse fails."
    );

    // --- battle_action (nested payload enum) --------------------------------
    let action = BattleAction {
        action_id: 13,
        battle_id: 44,
        player_identity: owner,
        action: PvpAction::Swap { team_index: 2 },
        turn_number: 7,
        submitted_at_ms: 45,
    };
    let out_action = super::json_battle_action(&action);
    assert_eq!(
        out_action,
        m22s4_obj(&[
            ("action_id", m22s4_quoted_num(13)),
            ("battle_id", m22s4_quoted_num(44)),
            ("player_identity", m22s4_qid(owner)),
            (
                "action",
                m22s4_obj(&[("kind", m22s4_qtxt("Swap")), ("team_index", m22s4_bare(2)),]),
            ),
            ("turn_number", m22s4_bare(7)),
            ("submitted_at_ms", m22s4_quoted_num(45)),
        ]),
        "m22s4 [X1/battle_action]: a payload-carrying enum is a TAGGED OBJECT — a kind \
         discriminator plus the variant's own fields — not a bare variant name, which would \
         silently drop team_index, the entire content of the action. The fixture picks the \
         SECOND variant."
    );

    // --- player -------------------------------------------------------------
    let player = Player {
        identity: owner,
        entity_id: 21,
        name: nasty.clone(),
        online: true,
        last_input_seq: 9_007_199_254_740_993,
    };
    let out_player = super::json_player(&player);
    assert_eq!(
        out_player,
        m22s4_obj(&[
            ("identity", m22s4_qid(owner)),
            ("entity_id", m22s4_quoted_num(21)),
            ("name", nasty_json.clone()),
            ("online", m22s4_bool(true)),
            ("last_input_seq", m22s4_quoted_num(9_007_199_254_740_993)),
        ]),
        "m22s4 [X1/player]: last_input_seq is u64 and the fixture sits one above 2^53 — a bare \
         number here loses the low bit in the client assembler."
    );

    // --- profile (the only signed 32-bit column in the export) --------------
    let profile = Profile {
        identity: owner,
        name: nasty.clone(),
        rating: -25,
        wins: 3,
        losses: 4,
    };
    let out_profile = super::json_profile(&profile);
    assert_eq!(
        out_profile,
        m22s4_obj(&[
            ("identity", m22s4_qid(owner)),
            ("name", nasty_json.clone()),
            ("rating", m22s4_bare(-25)),
            ("wins", m22s4_bare(3)),
            ("losses", m22s4_bare(4)),
        ]),
        "m22s4 [X1/profile]: rating is i32 with no floor and must render BARE and SIGNED — an \
         unsigned emitter would wrap a negative rating to about 4.29 billion."
    );

    // --- account (the only option-bearing row) ------------------------------
    let account = Account {
        identity: owner,
        auth_issuer: nasty.clone(),
        created_at_ms: 1,
        last_login_at_ms: 2,
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(3),
        claimed_from: Some(other),
        claimed_at_ms: Some(5),
        terminal_at_ms: None,
    };
    let out_account = super::json_account(&account);
    assert_eq!(
        out_account,
        m22s4_obj(&[
            ("identity", m22s4_qid(owner)),
            ("auth_issuer", nasty_json.clone()),
            ("created_at_ms", m22s4_quoted_num(1)),
            ("last_login_at_ms", m22s4_quoted_num(2)),
            ("status", m22s4_qtxt("PendingDeletion")),
            ("deletion_requested_at_ms", m22s4_quoted_num(3)),
            ("claimed_from", m22s4_qid(other)),
            ("claimed_at_ms", m22s4_quoted_num(5)),
            ("terminal_at_ms", m22s4_null()),
        ]),
        "m22s4 [X1/account]: a present option renders as the value in its OWN encoding and an \
         absent one renders the null LITERAL — never an omitted key, which would make \
         terminal_at_ms indistinguishable from a schema the client does not know about. The \
         fixture is a LEGAL account state (pending deletion pairs with a request stamp; claim \
         provenance is set as a pair) so it cannot be dismissed as unreachable."
    );

    // --- battle (redacting; the requester is side A) ------------------------
    let battle = m22s4_battle_row(owner, other);
    let out_battle = super::json_battle(&battle, owner).unwrap_or_else(|e| {
        panic!("m22s4 [X1/battle]: json_battle must succeed on a row the requester holds: {e}")
    });
    assert_eq!(
        out_battle,
        m22s4_expected_battle(
            m22s4_qid(owner),
            m22s4_null(),
            m22s4_party_ids_json(),
            m22s4_null(),
        ),
        "m22s4 [X1/battle]: the battle row exports SIX columns in declaration order with `state` \
         omitted entirely, and the counterparty's identity and monster list nulled for a \
         requester on side A."
    );

    // --- character (join-only; the nested move queue) -----------------------
    let character = Character {
        entity_id: 15,
        zone_id: 1,
        tile_x: -4,
        tile_y: 9,
        facing: Direction::West,
        action: ActionState::Jumping,
        move_started_at_ms: 47,
        sprite_id: 0,
        move_queue: vec![MoveInput::Step(Direction::North), MoveInput::Jump],
    };
    let out_character = super::json_character(&character);
    assert_eq!(
        out_character,
        m22s4_obj(&[
            ("entity_id", m22s4_quoted_num(15)),
            ("zone_id", m22s4_bare(1)),
            ("tile_x", m22s4_bare(-4)),
            ("tile_y", m22s4_bare(9)),
            ("facing", m22s4_qtxt("West")),
            ("action", m22s4_qtxt("Jumping")),
            ("move_started_at_ms", m22s4_quoted_num(47)),
            ("sprite_id", m22s4_bare(0)),
            (
                "move_queue",
                m22s4_arr(&[
                    m22s4_obj(&[
                        ("kind", m22s4_qtxt("Step")),
                        ("direction", m22s4_qtxt("North")),
                    ]),
                    m22s4_obj(&[("kind", m22s4_qtxt("Jump"))]),
                ]),
            ),
        ]),
        "m22s4 [X1/character]: tile_x and tile_y are i32 and render BARE and SIGNED; facing and \
         action are the LAST variants of their enums; the move queue is an array of tagged \
         objects where the payload-free variant carries the tag ALONE (a null direction there \
         would invent a field the type does not have)."
    );

    // --- non-vacuity of the expectation builder itself ----------------------
    //
    // Every assertion above compares against a string THIS FILE built. If the
    // builder were wrong in the same way twice it would still pass, so each
    // output is independently re-read by the compact JSON oracle.
    for (label, out) in [
        ("monster", &out_monster),
        ("monster_pub", &out_monster_pub),
        ("inventory", &out_inventory),
        ("player_dialogue_state", &out_dialogue),
        ("player_quest", &out_quest),
        ("player_conversation", &out_conversation),
        ("heal_cooldown", &out_heal),
        ("wallet", &out_wallet),
        ("playtest_event", &out_playtest),
        ("trade_offer", &out_trade),
        ("battle_challenge", &out_challenge),
        ("battle_action", &out_action),
        ("player", &out_player),
        ("profile", &out_profile),
        ("account", &out_account),
        ("battle", &out_battle),
        ("character", &out_character),
    ] {
        assert!(
            m22s4_json_is_wellformed(out),
            "m22s4 [X1/wellformed]: the `{label}` serializer produced text that is NOT exactly \
             one well-formed compact JSON value: {out:?}. The equality clause above compares \
             against a string this test file built, so this independent oracle is what catches a \
             shared mistake in both."
        );
    }
}

/// PRV1-11 / X1 (the zero-state half): an owner who holds NOTHING still gets a
/// well-formed, meaningful export.
///
/// TWO CLAUSES, because empty means two different things in this feature:
///   (a) the PLANNER: a table with no rows still emits EXACTLY ONE chunk whose
///       rows array is empty. `slice::chunks()` on an empty slice yields ZERO
///       chunks, so the planner must special-case it. Without that the table
///       silently vanishes from the export while every count-based test stays
///       green, and the written table_name set stops equalling the manifest's
///       exportable set.
///   (b) the SERIALIZERS: zero-state rows (empty strings, empty lists, all
///       options absent, the zero identity) still produce well-formed objects
///       with every key present.
///
/// Kills: forwarding straight to `chunks(n)` with no empty special case;
///        omitting an empty collection or an absent option instead of emitting
///        an empty array / the null literal;
///        an if-there-is-nothing-return-early shortcut anywhere in the pair.
#[test]
fn m22s4_serializer_empty_owner() {
    // --- (a) the empty table still gets its chunk ---------------------------
    let plan = super::plan_export_chunks(vec![("monster", Vec::new())]);
    assert_eq!(
        plan.len(),
        1,
        "m22s4 [X1/empty-chunk]: a table with zero owned rows must still produce EXACTLY ONE \
         chunk. slice::chunks() on an empty slice yields ZERO chunks, so an implementation that \
         forwards straight to it drops the table from the export entirely — and a compliance \
         export that says NOTHING about a table is not the same artifact as one that says the \
         subject has no rows there."
    );
    assert_eq!(
        plan[0].table, "monster",
        "m22s4 [X1/empty-chunk]: the empty chunk must carry the table it stands for."
    );
    assert_eq!(
        plan[0].chunk_index, 0,
        "m22s4 [X1/empty-chunk]: the sole chunk of the request is index 0."
    );
    let expected_empty = m22s4_expected_payload("monster", &[]);
    assert_eq!(
        plan[0].payload, expected_empty,
        "m22s4 [X1/empty-chunk]: the payload must be the self-describing header with an EMPTY \
         rows array."
    );
    assert!(
        m22s4_json_is_wellformed(&plan[0].payload),
        "m22s4 [X1/empty-chunk]: the empty-table payload is not well-formed JSON: {:?}",
        plan[0].payload
    );

    // --- (b) zero-state rows still serialize --------------------------------
    let zero = m22s4_id(0x00);

    let dialogue = PlayerDialogueStateRow {
        owner_identity: zero,
        flags: vec![],
        done_quests: vec![],
    };
    let out_dialogue = super::json_player_dialogue_state(&dialogue);
    assert_eq!(
        out_dialogue,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(zero)),
            ("flags", m22s4_arr(&[])),
            ("done_quests", m22s4_arr(&[])),
        ]),
        "m22s4 [X1/zero-state]: two empty string-list columns must BOTH render an empty array."
    );

    let trade = TradeOffer {
        trade_id: 0,
        initiator: zero,
        counterparty: zero,
        initiator_monster_ids: vec![],
        initiator_items: vec![],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };
    let out_trade = super::json_trade_offer(&trade);
    assert_eq!(
        out_trade,
        m22s4_obj(&[
            ("trade_id", m22s4_quoted_num(0)),
            ("initiator", m22s4_qid(zero)),
            ("counterparty", m22s4_qid(zero)),
            ("initiator_monster_ids", m22s4_arr(&[])),
            ("initiator_items", m22s4_arr(&[])),
            ("initiator_currency", m22s4_quoted_num(0)),
            ("counterparty_monster_ids", m22s4_arr(&[])),
            ("counterparty_items", m22s4_arr(&[])),
            ("counterparty_currency", m22s4_quoted_num(0)),
            ("initiator_cards", m22s4_arr(&[])),
            ("counterparty_cards", m22s4_arr(&[])),
            ("status", m22s4_qtxt("Pending")),
            ("created_at_ms", m22s4_quoted_num(0)),
        ]),
        "m22s4 [X1/zero-state]: six empty collections in one row must all render an empty array, \
         and a zero u64 is still the QUOTED string form."
    );

    let character = Character {
        entity_id: 0,
        zone_id: 0,
        tile_x: 0,
        tile_y: 0,
        facing: Direction::North,
        action: ActionState::Idle,
        move_started_at_ms: 0,
        sprite_id: 0,
        move_queue: vec![],
    };
    let out_character = super::json_character(&character);
    assert_eq!(
        out_character,
        m22s4_obj(&[
            ("entity_id", m22s4_quoted_num(0)),
            ("zone_id", m22s4_bare(0)),
            ("tile_x", m22s4_bare(0)),
            ("tile_y", m22s4_bare(0)),
            ("facing", m22s4_qtxt("North")),
            ("action", m22s4_qtxt("Idle")),
            ("move_started_at_ms", m22s4_quoted_num(0)),
            ("sprite_id", m22s4_bare(0)),
            ("move_queue", m22s4_arr(&[])),
        ]),
        "m22s4 [X1/zero-state]: an empty move queue renders an empty array."
    );

    let account = Account {
        identity: zero,
        auth_issuer: String::new(),
        created_at_ms: 0,
        last_login_at_ms: 0,
        status: AccountStatus::Active,
        deletion_requested_at_ms: None,
        claimed_from: None,
        claimed_at_ms: None,
        terminal_at_ms: None,
    };
    let out_account = super::json_account(&account);
    assert_eq!(
        out_account,
        m22s4_obj(&[
            ("identity", m22s4_qid(zero)),
            ("auth_issuer", m22s4_qtxt("")),
            ("created_at_ms", m22s4_quoted_num(0)),
            ("last_login_at_ms", m22s4_quoted_num(0)),
            ("status", m22s4_qtxt("Active")),
            ("deletion_requested_at_ms", m22s4_null()),
            ("claimed_from", m22s4_null()),
            ("claimed_at_ms", m22s4_null()),
            ("terminal_at_ms", m22s4_null()),
        ]),
        "m22s4 [X1/zero-state]: an EMPTY string is a pair of quotes, not an omitted key and not \
         null; all four absent options render the null literal."
    );

    for (label, out) in [
        ("player_dialogue_state", &out_dialogue),
        ("trade_offer", &out_trade),
        ("character", &out_character),
        ("account", &out_account),
    ] {
        assert!(
            m22s4_json_is_wellformed(out),
            "m22s4 [X1/zero-state/wellformed]: the zero-state `{label}` output is not exactly one \
             well-formed compact JSON value: {out:?}"
        );
    }
}

// ===========================================================================
// PRV1-11 / PRV1-12 / X2 — dispatch totality against the manifest.
// ===========================================================================

/// X2: the exporter registry and the manifest's exportable set are the SAME
/// SET, in BOTH directions, at exactly seventeen tables, in manifest ORDER.
///
/// Neither direction alone is enough. A forward-only check (every exporter
/// names an exportable table) is green on a registry that exports three tables
/// — a silently truncated subject-access response. A reverse-only check (every
/// exportable table has an exporter) is green on a registry that ALSO exports
/// something the manifest marks non-exportable, which is a PRV1-12 breach. The
/// ORDER clause is what makes chunk_index reproducible across two runs.
///
/// Kills: a missing exporter (the table is simply never walked);
///        an exporter for a non-exportable table;
///        two exporters registered under the same name (one shadows the other
///        and the set compare stays green by coincidence);
///        a registry re-sorted away from manifest order, which reshuffles every
///        chunk_index in the artifact for no reason.
#[test]
fn m22s4_exporter_set_equals_manifest_both_directions() {
    let manifest_order = m22s4_manifest_exportable();
    assert_eq!(
        manifest_order.len(),
        17,
        "m22s4 [X2/floor]: DATA_LIFECYCLE_MANIFEST carries {} exportable entries; the spec's \
         export scope is exactly SEVENTEEN (twelve erase tables plus four anonymize tables plus \
         character). If that number legitimately changed, the registry and this floor move \
         together, in one reviewed diff.",
        manifest_order.len()
    );

    let registry: Vec<String> = super::EXPORTERS.iter().map(|e| e.0.to_string()).collect();
    assert_eq!(
        registry.len(),
        17,
        "m22s4 [X2/floor]: the exporter registry carries {} entries; the manifest's exportable \
         set is 17.",
        registry.len()
    );

    let mut sorted_registry = registry.clone();
    sorted_registry.sort();
    for pair in sorted_registry.windows(2) {
        assert_ne!(
            pair[0], pair[1],
            "m22s4 [X2/dup]: the table `{}` is registered TWICE. A duplicate makes one of the two \
             entries dead while every set comparison stays green, and it writes the same \
             table_name into two different chunk groups of one request.",
            pair[0]
        );
    }

    for table in &manifest_order {
        assert!(
            registry.iter().any(|name| name == table),
            "m22s4 [X2/missing]: the manifest marks `{table}` exportable but the registry has no \
             reader for it. PRV1-11 promises one chunk per exportable table; an unregistered \
             table is silently absent from every subject-access response."
        );
    }
    for name in &registry {
        assert!(
            manifest_order.iter().any(|table| table == name),
            "m22s4 [X2/extra]: the registry registers `{name}`, which the manifest does NOT mark \
             exportable. Export scope is a THIRD, orthogonal axis and must stay structurally \
             NARROWER than deletion scope (PRV1-12)."
        );
    }

    assert_eq!(
        registry, manifest_order,
        "m22s4 [X2/order]: the registry must dispatch in MANIFEST ORDER. The two lists hold the \
         same names in a different sequence, so the request-wide chunk_index assigned to each \
         table would depend on the registry's internal ordering rather than on the documented \
         partition order."
    );
}

/// X2 (the const-fn teeth): `exporters_cover_manifest` and its `str_eq` helper
/// actually DECIDE, on fixture inputs the real manifest can never present.
///
/// The shipped const-eval assertion is a compile-time proof over ONE input
/// pair, which is exactly the input for which a hollowed-out predicate that
/// always returns true is indistinguishable from a correct one. These fixtures
/// are the only place the predicate is exercised on inputs that must come back
/// FALSE — plus a positive control, because a predicate that always returns
/// false would satisfy every negative on its own.
///
/// Kills: exporters_cover_manifest hardcoded to true (negatives 1-3);
///        hardcoded to false (the positive control);
///        a one-directional implementation that only checks manifest-to-exporter
///        (negative 2) or only exporter-to-manifest (negative 1);
///        an implementation that never reads the exportable flag (negative 3);
///        str_eq reduced to a length compare or a prefix compare.
#[test]
fn m22s4_exporter_totality_negative_fixtures() {
    // A real fn pointer of the registry's own type, borrowed rather than
    // written, so the fixtures need no shell reader of their own.
    let reader: super::ExportRows = super::EXPORTERS[0].1;

    // --- str_eq: the const-fn string primitive both directions rest on ------
    assert!(
        super::str_eq("alpha", "alpha"),
        "m22s4 [X2/str_eq]: str_eq must accept two equal strings."
    );
    assert!(
        !super::str_eq("alpha", "gamma"),
        "m22s4 [X2/str_eq]: str_eq must reject two DIFFERENT strings of the SAME length — a \
         length-only compare passes this pair."
    );
    assert!(
        !super::str_eq("player", "player_quest"),
        "m22s4 [X2/str_eq]: str_eq must reject a strict PREFIX. This is not hypothetical: the \
         live table names contain that exact prefix pair, so a prefix-tolerant compare would let \
         the `player` exporter satisfy the `player_quest` manifest entry and leave quest progress \
         out of the export."
    );
    assert!(
        !super::str_eq("player_quest", "player"),
        "m22s4 [X2/str_eq]: the prefix rejection must hold in BOTH argument orders."
    );
    assert!(
        super::str_eq("", ""),
        "m22s4 [X2/str_eq]: two empty strings are equal."
    );

    // --- positive control: the predicate can return TRUE --------------------
    let manifest_ok = [
        DataLifecycleEntry {
            table: "alpha",
            policy: DeletionPolicy::Erase,
            basis: "m22s4 fixture: an exportable table",
            exportable: true,
        },
        DataLifecycleEntry {
            table: "gamma",
            policy: DeletionPolicy::NotOwned,
            basis: "m22s4 fixture: a non-exportable table",
            exportable: false,
        },
    ];
    let exporters_ok: [(&str, super::ExportRows); 1] = [("alpha", reader)];
    assert!(
        super::exporters_cover_manifest(&manifest_ok, &exporters_ok),
        "m22s4 [X2/control]: exporters_cover_manifest must return TRUE for a manifest whose one \
         exportable table has exactly one exporter and whose non-exportable table has none. \
         Without this control every negative below is satisfied by a predicate that is simply \
         always false — which would ALSO turn the shipped const assertion into a compile error, \
         a very different failure to debug."
    );

    // --- negative 1: an exportable table with NO exporter -------------------
    let manifest_missing = [
        DataLifecycleEntry {
            table: "alpha",
            policy: DeletionPolicy::Erase,
            basis: "m22s4 fixture: an exportable table with a reader",
            exportable: true,
        },
        DataLifecycleEntry {
            table: "beta",
            policy: DeletionPolicy::Erase,
            basis: "m22s4 fixture: an exportable table with NO reader",
            exportable: true,
        },
    ];
    assert!(
        !super::exporters_cover_manifest(&manifest_missing, &exporters_ok),
        "m22s4 [X2/negative-missing]: a manifest with TWO exportable tables and only ONE exporter \
         must NOT be covered. This is the direction that fires when someone adds an exportable \
         table and forgets the reader — the case PRV1-11's totality claim exists for."
    );

    // --- negative 2: an exporter for a table the manifest never mentions ----
    let exporters_extra: [(&str, super::ExportRows); 2] = [("alpha", reader), ("delta", reader)];
    assert!(
        !super::exporters_cover_manifest(&manifest_ok, &exporters_extra),
        "m22s4 [X2/negative-extra]: an exporter naming a table that appears NOWHERE in the \
         manifest must NOT be covered. Unchecked, this direction lets the walk emit a table the \
         data-lifecycle classification never reviewed."
    );

    // --- negative 3: an exporter for a NON-exportable table (PRV1-12) -------
    let exporters_false_table: [(&str, super::ExportRows); 2] =
        [("alpha", reader), ("gamma", reader)];
    assert!(
        !super::exporters_cover_manifest(&manifest_ok, &exporters_false_table),
        "m22s4 [X2/negative-not-exportable]: `gamma` IS in the fixture manifest but carries \
         exportable false, and an exporter for it must NOT be covered. An implementation that \
         only checks table-name membership and never reads the exportable flag passes negatives 1 \
         and 2 and fails only here — and it is exactly the shape that would let the wild-seed \
         side table into a subject's export."
    );
}

// ===========================================================================
// PRV1-12 / X3 — no non-exportable table is ever named.
// ===========================================================================

/// PRV1-12 / X3: over squashed, comment-stripped privacy.rs, NO non-exportable
/// table's accessor is named, and the wild individuality seed column never
/// appears. The Rust twin of the spec's export-scope negative fixture.
///
/// The banned set is DERIVED from the live manifest at runtime, never
/// hand-listed: a table reclassified from exportable to non-exportable becomes
/// banned here automatically, and a hand-list would rot the first time the
/// manifest grows.
///
/// ONE EXEMPTION, stated rather than hidden: `export_bundle` itself. It is the
/// module's own write target (purge, cooldown read, insert loop) and the only
/// non-exportable accessor privacy.rs may legitimately name; the whole-file
/// write census (rb22p_writes_only_export_bundle) is what keeps that naming
/// honest.
///
/// Kills: reading battle_wild, guest_claim, config or any other unclassified
///        table into the export walk;
///        an export of the wild individuality seed (the must-never-leak column
///        the private side table exists to hold).
#[test]
fn m22s4_no_exportable_false_table_is_named() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let banned = m22s4_manifest_not_exportable();

    assert!(
        !banned.is_empty(),
        "m22s4 [X3/vacuity]: the manifest yields ZERO non-exportable tables, so the ban loop \
         below would iterate an empty set and this gate would say `clean` about nothing."
    );
    assert!(
        banned.iter().any(|t| t == "battle_wild"),
        "m22s4 [X3/vacuity]: the derived ban set does not contain battle_wild, the table that \
         holds the raw RNG individuality seed. Either the derivation broke or the classification \
         changed; both must red LOUD rather than silently shrink the ban set."
    );

    let exempt = concat!("export", "_bundle");
    let mut checked = 0usize;
    for table in &banned {
        if table == exempt {
            continue;
        }
        let needle = format!("{table}(");
        let n = rb22p_count(&squashed, &needle);
        assert_eq!(
            n, 0,
            "m22s4 [X3/named]: privacy.rs names the accessor `{needle}` {n} time(s). `{table}` is \
             classified NON-exportable, so no export code path may read it: export scope is \
             structurally narrower than deletion scope (PRV1-12). The only sanctioned exception \
             is the module's own write target, which is exempted by name above."
        );
        checked += 1;
    }
    assert!(
        checked >= 20,
        "m22s4 [X3/floor]: only {checked} non-exportable accessors were checked; the live \
         manifest classifies 23 (24 minus the module's own write target). A shrunken ban set is a \
         ban set that stopped looking."
    );

    let seed = concat!("individuality", "_seed");
    assert_eq!(
        rb22p_count(&squashed, seed),
        0,
        "m22s4 [X3/seed]: privacy.rs names `{seed}`. That column is the raw RNG seed the private \
         wild side table exists to keep server-only; it is not the subject's personal data and it \
         must never appear in an export payload under any name."
    );
}

// ===========================================================================
// PRV1-13 / X4 — sub-chunking and the request-wide index.
// ===========================================================================

/// PRV1-13 / X4: the planner splits at exactly the game-core boundary, and an
/// empty table still emits one chunk.
///
/// Seven row counts around the boundary, each checked for BOTH the chunk COUNT
/// (against an independent saturating-loop reference) and the exact payload of
/// every chunk (so a split at the right count but the wrong offsets fails).
///
/// Kills: an off-by-one boundary (499/500/501 disagree);
///        forwarding an empty vec straight to chunks() (0 rows would yield 0
///        chunks);
///        a planner that re-orders or duplicates rows across the split.
#[test]
fn m22s4_plan_chunks_boundaries() {
    let per = game_core::EXPORT_CHUNK_ROWS as usize;
    assert!(
        per >= 2,
        "m22s4 [X4/vacuity]: the game-core chunk size is {per}; the boundary cases below need at \
         least 2 to be distinguishable."
    );

    for rows_n in [0usize, 1, per - 1, per, per + 1, 2 * per, 2 * per + 1] {
        let rows: Vec<String> = (0..rows_n).map(|i| m22s4_row_text("monster", i)).collect();
        let plan = super::plan_export_chunks(vec![("monster", rows.clone())]);
        let expected_n = m22s4_expected_chunk_count(rows_n, per);
        assert_eq!(
            plan.len(),
            expected_n,
            "m22s4 [X4/count]: {rows_n} row(s) at {per} per chunk must plan {expected_n} chunk(s), \
             not {}. Zero rows is the load-bearing case: slice::chunks() yields NO chunks there, \
             so the table would vanish from the export.",
            plan.len()
        );
        for (k, chunk) in plan.iter().enumerate() {
            assert_eq!(
                chunk.chunk_index, k as u32,
                "m22s4 [X4/index]: chunk {k} of the {rows_n}-row case carries index {}, not {k}.",
                chunk.chunk_index
            );
            assert_eq!(
                chunk.table, "monster",
                "m22s4 [X4/table]: every chunk of a single-table request carries that table."
            );
            let lo = k * per;
            let hi = std::cmp::min(lo + per, rows_n);
            assert_eq!(
                chunk.payload,
                m22s4_expected_payload("monster", &rows[lo..hi]),
                "m22s4 [X4/payload]: chunk {k} of the {rows_n}-row case does not carry rows \
                 {lo}..{hi} in input order. A split with the right COUNT but the wrong offsets \
                 duplicates or drops the subject's rows while every count clause stays green."
            );
        }
    }
}

/// PRV1-13 / X4: the sub-chunk boundary IS the game-core constant, proven both
/// behaviourally and at the call site.
///
/// Kills: a hand-typed 500 in privacy.rs (the source clause), which would keep
///        working today and silently diverge the moment the constant is retuned;
///        a second, differently-sized chunks() call somewhere in the module.
#[test]
fn m22s4_chunk_boundary_is_game_core_constant() {
    let per = game_core::EXPORT_CHUNK_ROWS as usize;

    // --- behavioural: the observed split IS at `per` ------------------------
    let rows: Vec<String> = (0..(2 * per + 1))
        .map(|i| m22s4_row_text("monster", i))
        .collect();
    let plan = super::plan_export_chunks(vec![("monster", rows.clone())]);
    assert_eq!(
        plan.len(),
        3,
        "m22s4 [X4/const-behaviour]: {} rows at {per} per chunk must plan 3 chunks.",
        2 * per + 1
    );
    assert_eq!(
        plan[0].payload,
        m22s4_expected_payload("monster", &rows[0..per]),
        "m22s4 [X4/const-behaviour]: the FIRST chunk must hold exactly the first {per} rows — \
         that count IS game_core::EXPORT_CHUNK_ROWS, read symbolically here so retuning the \
         constant retunes this test with it."
    );
    assert_eq!(
        plan[1].payload,
        m22s4_expected_payload("monster", &rows[per..2 * per]),
        "m22s4 [X4/const-behaviour]: the SECOND chunk must hold the next {per} rows."
    );
    assert_eq!(
        plan[2].payload,
        m22s4_expected_payload("monster", &rows[2 * per..]),
        "m22s4 [X4/const-behaviour]: the remainder chunk must hold the single trailing row."
    );

    // --- source: the call site names the constant ---------------------------
    let squashed = stripped_for_scan(PRIVACY_RS);
    let call = ".chunks(";
    let n = rb22p_count(&squashed, call);
    assert_eq!(
        n, 1,
        "m22s4 [X4/const-site]: privacy.rs contains {n} `{call}` call(s); exactly one is the \
         contract. Zero means the sub-chunking moved somewhere this clause cannot see; two means \
         a second, independently-sized split exists."
    );
    let at = m22s4_idx(&squashed, call, "the sub-chunking call site");
    let rest = &squashed[at + call.len()..];
    let close = m22s4_idx(rest, ")", "the sub-chunking call's closing paren");
    let arg = &rest[..close];
    assert!(
        arg.contains("EXPORT_CHUNK_ROWS"),
        "m22s4 [X4/const-site]: the sub-chunk size is spelled `{arg}`, which does not name \
         EXPORT_CHUNK_ROWS. game-core owns that number and its own doc instructs this module to \
         cast it at the chunks() call site; a hand-typed literal is a second source of truth that \
         passes every behavioural clause today and diverges silently the day it is retuned."
    );
}

/// PRV1-13 / X4 (scale): the largest bounded table in the export plans exactly
/// the count the boundary rule implies.
///
/// The telemetry table is globally capped, so its cap is the realistic worst
/// case for one owner. Both the literal expectation and the derived one are
/// asserted: the literal catches a silently changed cap, the derived one
/// catches a silently changed boundary.
///
/// Kills: a planner that degrades (drops or merges chunks) above some internal
///        size; an off-by-one in the final partial chunk at scale.
#[test]
fn m22s4_plan_chunks_at_playtest_cap_scale() {
    let per = game_core::EXPORT_CHUNK_ROWS as usize;
    let cap = PLAYTEST_EVENT_CAP as usize;
    assert_eq!(
        cap, 20_000,
        "m22s4 [X4/scale-vacuity]: the telemetry cap is {cap}, not the 20000 this scale case was \
         sized against. Re-derive the expected chunk count before editing anything else."
    );

    let rows: Vec<String> = (0..cap)
        .map(|i| m22s4_row_text("playtest_event", i))
        .collect();
    let plan = super::plan_export_chunks(vec![("playtest_event", rows.clone())]);

    assert_eq!(
        plan.len(),
        40,
        "m22s4 [X4/scale]: {cap} rows at {per} per chunk must plan exactly 40 chunks, not {}.",
        plan.len()
    );
    assert_eq!(
        plan.len(),
        m22s4_expected_chunk_count(cap, per),
        "m22s4 [X4/scale-derived]: the planned count must also equal the INDEPENDENTLY derived \
         count, so the literal 40 above and the boundary rule cannot drift apart."
    );
    for (k, chunk) in plan.iter().enumerate() {
        assert_eq!(
            chunk.chunk_index, k as u32,
            "m22s4 [X4/scale]: chunk indices must stay contiguous at scale; chunk {k} carries {}.",
            chunk.chunk_index
        );
        assert_eq!(
            chunk.table, "playtest_event",
            "m22s4 [X4/scale]: every chunk must carry the table it stands for."
        );
    }
    assert_eq!(
        plan[0].payload,
        m22s4_expected_payload("playtest_event", &rows[0..per]),
        "m22s4 [X4/scale]: the first chunk at scale must still hold exactly the first {per} rows."
    );
    assert_eq!(
        plan[39].payload,
        m22s4_expected_payload("playtest_event", &rows[39 * per..cap]),
        "m22s4 [X4/scale]: the LAST chunk must hold the trailing rows and nothing else — the \
         place an off-by-one at scale actually shows up."
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// PRV1-13 / X4 (request-wide invariants): over random per-table row counts,
    /// the plan's chunk_index is EXACTLY 0..N-1 (unique and contiguous ACROSS
    /// tables, not per table), every input table appears, an empty table appears
    /// exactly once, and grouping by table then reading in chunk_index order
    /// reproduces the input row order.
    ///
    /// total_chunks is not a field of the planned chunk: it IS the plan length,
    /// identical on every row of the request, which is what makes the client's
    /// wait rule (collected chunks equals total_chunks) implementable at all. A
    /// per-table index would make that rule incoherent.
    ///
    /// Kills: a per-table chunk_index restarting at 0 for each table;
    ///        a plan that skips or repeats an index;
    ///        a table dropped because it had no rows;
    ///        rows reordered across the split.
    #[test]
    fn m22s4_plan_chunks_request_wide_invariants(
        counts in prop::collection::vec(
            prop::sample::select(vec![0usize, 1, 2, 250, 499, 500, 501, 750, 1000, 1001]),
            1..=5usize,
        ),
    ) {
        let per = game_core::EXPORT_CHUNK_ROWS as usize;
        let mut per_table: Vec<(&'static str, Vec<String>)> = Vec::new();
        for (t, n) in counts.iter().enumerate() {
            let table = M22S4_PLAN_TABLES[t];
            let rows: Vec<String> = (0..*n).map(|i| m22s4_row_text(table, i)).collect();
            per_table.push((table, rows));
        }
        let expected = m22s4_reference_plan(&per_table, per);
        let plan = super::plan_export_chunks(per_table.clone());

        prop_assert_eq!(
            plan.len(),
            expected.len(),
            "the plan must hold one chunk per sub-chunk plus one per EMPTY table"
        );
        for (k, chunk) in plan.iter().enumerate() {
            prop_assert_eq!(
                expected[k].1,
                k as u32,
                "the reference plan itself must number chunks contiguously"
            );
            prop_assert_eq!(
                chunk.chunk_index,
                k as u32,
                "chunk_index must be REQUEST-wide and contiguous, never restarted per table"
            );
            prop_assert_eq!(
                chunk.table,
                expected[k].0,
                "chunks must be grouped by table in dispatch order"
            );
            prop_assert_eq!(
                &chunk.payload,
                &expected[k].2,
                "each chunk must carry its own slice of the input rows, in input order"
            );
        }
        for (table, rows) in &per_table {
            let seen = plan.iter().filter(|c| c.table == *table).count();
            prop_assert!(
                seen >= 1,
                "every input table must appear in the plan, including one with no rows"
            );
            if rows.is_empty() {
                prop_assert_eq!(seen, 1, "a table with no rows must appear EXACTLY once");
            }
        }
    }
}

// ===========================================================================
// PRV1-11 / X5 — own rows only.
// ===========================================================================

/// PRV1-11 / X5: EVERY exportable table's shell reader keys its read on the
/// subject, and every unindexed scan is IMMEDIATELY bounded by the extracted
/// own-row predicate.
///
/// Source-structure, and it says so: a ReducerContext is not constructible
/// off-instance, so the behavioural half of this criterion lives in the two
/// predicate tests and in the serializer tests; this clause proves the READ
/// SHAPE. Every clause is scoped through extract_squashed_fn_body — never a
/// whole-file contains — and every count is exact, so a decoy chain in a
/// sibling fn cannot satisfy a claim about this one.
///
/// Kills: a reader that drops the key and scans the whole table;
///        a reader keyed on a DIFFERENT identity (the needle pins the argument
///        `owner`, not merely the presence of a filter);
///        an unindexed scan with NO predicate, or with the predicate applied
///        somewhere other than immediately after the scan (which would leak
///        every other player's per-turn secret action and telemetry);
///        a predicate keyed on the battle rather than on the submitter (the
///        predicate-body clause pins the identity COLUMN);
///        the join-only table reached by anything other than the subject's own
///        player row;
///        the practice-battle dedup rewritten as a self-comparison, which
///        deletes every practice battle from its own player's export.
#[test]
fn m22s4_reducer_filters_every_read_on_sender() {
    let squashed = stripped_for_scan(PRIVACY_RS);

    // --- the fact table cannot drift from the manifest ----------------------
    let mut fact_tables: Vec<String> = M22S4_FILTER_FACTS
        .iter()
        .map(|f| f.table.to_string())
        .collect();
    let mut manifest_tables = m22s4_manifest_exportable();
    fact_tables.sort();
    manifest_tables.sort();
    assert_eq!(
        fact_tables, manifest_tables,
        "m22s4 [X5/fact-set]: this test's own read-shape table and the manifest's exportable set \
         are not the same set. A fact table that drifts is a fact table that stops checking a \
         live export path — add the new table's read shape here in the SAME diff that adds it to \
         the manifest."
    );

    let mut facts = 0usize;
    for fact in M22S4_FILTER_FACTS {
        let body = m22s4_rows_body(&squashed, fact.table);
        match &fact.shape {
            M22s4Read::Direct => {
                for col in fact.columns {
                    let find = format!(".{col}().find(owner)");
                    let filter = format!(".{col}().filter(owner)");
                    let n = rb22p_count(&body, &find) + rb22p_count(&body, &filter);
                    assert_eq!(
                        n, 1,
                        "m22s4 [X5/key]: the `{}` reader must key its `{col}` read on the subject \
                         EXACTLY once — either an index find or an index filter, with `owner` as \
                         the key. Found {n} such reads. Zero means the read is unkeyed (a whole \
                         table returned to one subject); more than one means a second, separately \
                         keyed path this clause cannot attribute.",
                        fact.table
                    );
                    facts += 1;
                }
            }
            M22s4Read::ScanPredicate(predicate) => {
                let col = fact.columns[0];
                let scan = ".iter()";
                let n_scan = rb22p_count(&body, scan);
                assert_eq!(
                    n_scan, 1,
                    "m22s4 [X5/scan]: `{}` carries NO index on its identity column, so its reader \
                     scans the table exactly once; found {n_scan} scans.",
                    fact.table
                );
                let call = format!("{predicate}(");
                let n_pred = rb22p_count(&body, &call);
                assert_eq!(
                    n_pred, 1,
                    "m22s4 [X5/predicate]: the `{}` reader must call `{call}` exactly once; found \
                     {n_pred}. An unindexed scan with no predicate returns EVERY player's rows.",
                    fact.table
                );
                let scan_at = m22s4_idx(&body, scan, "the unindexed scan");
                let pred_at = m22s4_idx(&body, &call, "the own-row predicate call");
                assert!(
                    pred_at > scan_at,
                    "m22s4 [X5/predicate-order]: in the `{}` reader the own-row predicate is \
                     applied BEFORE the scan it is supposed to bound.",
                    fact.table
                );
                let gap = &body[scan_at + scan.len()..pred_at];
                let opener = ".filter(|";
                assert!(
                    gap.len() > opener.len() && gap.starts_with(opener) && gap.ends_with('|'),
                    "m22s4 [X5/predicate-adjacency]: in the `{}` reader the text between the scan \
                     and the predicate is {gap:?}; it must be exactly a filter closure header. \
                     Anything else means rows escape the scan unfiltered — for instance collected \
                     first and narrowed later, which is a full-table read of a must-never-leak \
                     table however it is narrowed afterwards.",
                    fact.table
                );
                assert!(
                    gap[opener.len()..gap.len() - 1]
                        .chars()
                        .all(m22s4_is_word_char),
                    "m22s4 [X5/predicate-adjacency]: the closure header {gap:?} binds something \
                     other than a single row identifier."
                );
                let args = m22s4_call_arg_lists(&body, &call);
                assert_eq!(
                    args.len(),
                    1,
                    "m22s4 [X5/predicate-args]: expected exactly one `{call}` call site."
                );
                assert_ne!(
                    args[0], M22S4_UNBALANCED,
                    "m22s4 [X5/predicate-args]: the `{call}` argument list is not \
                     paren-balanced, so refusing to classify is the safe direction."
                );
                assert!(
                    args[0].ends_with(",owner"),
                    "m22s4 [X5/predicate-args]: `{call}` is called with arguments {:?}; the \
                     second argument MUST be `owner`. A predicate handed any other identity \
                     silently exports another player's rows while every count clause stays green.",
                    args[0]
                );

                // The predicate itself must compare the table's identity COLUMN.
                let pred_fn = format!("fn{predicate}(");
                assert_eq!(
                    rb22p_count(&squashed, &pred_fn),
                    1,
                    "m22s4 [X5/predicate-decl]: `{pred_fn}` must be declared exactly once."
                );
                let pred_body =
                    extract_squashed_fn_body(&squashed, &pred_fn).unwrap_or_else(|| {
                        panic!("m22s4 [X5/predicate-decl]: `{pred_fn}` body is not brace-balanced.")
                    });
                let compare = format!(".{col}==me");
                assert!(
                    pred_body.contains(&compare),
                    "m22s4 [X5/predicate-column]: `{predicate}` does not compare `{compare}`. Its \
                     body reads {pred_body:?}. Both scan fixtures share ONE battle id on purpose: \
                     a predicate keyed on the battle rather than on the submitting identity \
                     returns true for the counterparty's row too."
                );
                facts += 1;
            }
            M22s4Read::ViaPlayerJoin => {
                let parent = [
                    concat!("ctx", ".db."),
                    "player()",
                    ".identity().find(owner)",
                ]
                .concat();
                assert_eq!(
                    rb22p_count(&body, &parent),
                    1,
                    "m22s4 [X5/join]: `{}` has no identity column of its own, so its reader must \
                     reach it through the SUBJECT's own parent row: exactly one `{parent}` \
                     lookup. Any other entry point is a caller-chosen-owner join.",
                    fact.table
                );
                assert_eq!(
                    rb22p_count(&body, ".entity_id().find("),
                    1,
                    "m22s4 [X5/join]: the join-only reader must key the child read on the parent \
                     row's entity id exactly once."
                );
                assert_eq!(
                    rb22p_count(&body, ".iter()"),
                    0,
                    "m22s4 [X5/join]: the join-only reader must not scan its table at all."
                );
                facts += 1;
            }
        }
    }

    assert!(
        facts >= 17,
        "m22s4 [X5/floor]: only {facts} own-rows facts were proven; the seventeen exportable \
         tables carry at least that many (three of them have TWO identity columns). A shrunken \
         fact count is a scan that stopped looking, and the table a leak lands in is exactly the \
         one that would go missing."
    );

    // --- the practice-battle dedup, pinned by VALUE -------------------------
    //
    // The participant-scoped read is two index scans chained together; the
    // trailing predicate excludes the rows the FIRST scan already emitted, so a
    // practice battle (both sides the same identity) arrives exactly once.
    let battle_body = m22s4_rows_body(&squashed, "battle");
    assert!(
        battle_body.contains(".chain("),
        "m22s4 [X5/battle-chain]: the battle reader must chain the two index scans; without the \
         second, every battle the subject fought as the OPPONENT is missing from their export."
    );
    let dedup = "player_identity!=owner";
    assert!(
        battle_body.contains(dedup),
        "m22s4 [X5/battle-dedup]: the battle reader's dedup predicate must compare the row's \
         player_identity against `owner`. Rewriting it to compare the row's two identity columns \
         against EACH OTHER deletes every practice battle from its own player's export — the \
         exact inversion the shipped participant view documents as forbidden."
    );
}

/// PRV1-11 / X5 (cross-manifest): every column the shell readers key on is one
/// of the identity columns the claim-flow re-key manifest already classifies.
///
/// SUBSET, not equality, and deliberately so: the re-key manifest classifies
/// identity columns that are correctly NOT export filters (a write-target
/// provenance column, for instance), so an equality claim would be false.
/// The safe direction is the one asserted: an export must not key on an
/// identity column nobody has classified.
///
/// FORMATTER TRAP: a quote-style rewrite by the JS formatter has silently
/// truncated an include_str key scan in this repo before, which is why the
/// extraction is followed by an independent co-scan — a floor AND a named
/// anchor key — rather than trusted on its own.
///
/// Kills: an export keyed on an unclassified identity column;
///        a silently emptied or truncated key extraction (the floor + anchor);
///        the join-only table quietly keyed on something other than its parent.
#[test]
fn m22s4_filter_columns_are_rekey_manifest_columns() {
    let keys = m22s4_rekey_manifest_keys();

    assert!(
        keys.len() >= 20,
        "m22s4 [X5/rekey-floor]: only {} re-key manifest keys were extracted; the live manifest \
         classifies well over twenty identity columns. A shrunken key list makes every subset \
         check below vacuous in the WRONG direction (fewer keys means MORE failures, but a list \
         truncated to zero would make the loop below fail loudly rather than pass — this floor is \
         what turns that into a legible message).",
        keys.len()
    );
    assert!(
        keys.iter().any(|k| k == "account.identity"),
        "m22s4 [X5/rekey-anchor]: the extracted key list does not contain the account identity \
         anchor, so the extraction read something other than the manifest it names. Co-scan twin \
         of the floor above: a formatter rewrite that truncates the scan changes the COUNT, and a \
         scan that latched onto the wrong object literal changes the CONTENT."
    );

    let mut checked = 0usize;
    for fact in M22S4_FILTER_FACTS {
        match &fact.shape {
            M22s4Read::ViaPlayerJoin => {
                assert!(
                    keys.iter().any(|k| k == M22S4_JOIN_PARENT_KEY),
                    "m22s4 [X5/rekey-join]: `{}` has no identity column, so its identity FACT is \
                     the parent lookup `{M22S4_JOIN_PARENT_KEY}` — which must itself be a \
                     classified identity column.",
                    fact.table
                );
                checked += 1;
            }
            M22s4Read::Direct | M22s4Read::ScanPredicate(_) => {
                for col in fact.columns {
                    let key = format!("{}.{col}", fact.table);
                    assert!(
                        keys.contains(&key),
                        "m22s4 [X5/rekey-subset]: the export keys `{}` on `{col}`, but `{key}` is \
                         NOT a classified identity column in the re-key manifest. Every identity \
                         column in the schema carries an explicit claim-flow policy there; an \
                         export filter on a column nobody classified means either the column is \
                         new and unreviewed, or the export is keyed on something that is not an \
                         owner at all.",
                        fact.table
                    );
                    checked += 1;
                }
            }
        }
    }
    assert!(
        checked >= 17,
        "m22s4 [X5/rekey-count]: only {checked} filter columns were cross-checked; the seventeen \
         exportable tables carry at least that many."
    );
}

/// PRV1-11 / X5 (behavioural): the per-turn secret action's own-row predicate
/// answers on IDENTITY, not on the battle.
///
/// TWO ROWS, ONE battle id. That is the whole point: a leaked pending PvP pick
/// is a competitively decisive exploit, and the shape that leaks it is a
/// predicate written against the row's battle rather than its submitter — which
/// a single-row fixture cannot distinguish.
///
/// Kills: a predicate keyed on battle_id (true for BOTH rows here);
///        a predicate that ignores its identity argument (true for both);
///        an inverted comparison (false for both);
///        a predicate keyed on action_id or turn_number.
#[test]
fn m22s4_battle_action_own_predicate() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let c = m22s4_id_c();
    let mine = m22s4_action_row(1, a);
    let theirs = m22s4_action_row(2, b);

    assert_eq!(
        mine.battle_id, theirs.battle_id,
        "m22s4 [X5/action-vacuity]: the two fixtures must share one battle id, or a predicate \
         keyed on the battle would be indistinguishable from a correct one."
    );

    assert!(
        super::battle_action_is_own(&mine, a),
        "m22s4 [X5/action]: the submitter's own row IS their own."
    );
    assert!(
        !super::battle_action_is_own(&theirs, a),
        "m22s4 [X5/action]: the COUNTERPARTY's row in the SAME battle is NOT the subject's. A \
         predicate keyed on battle_id returns true here and hands a live opponent's pending pick \
         to the other player."
    );
    assert!(
        super::battle_action_is_own(&theirs, b),
        "m22s4 [X5/action]: the predicate must answer true for the OTHER identity's own row too, \
         so a constant-false implementation fails."
    );
    assert!(
        !super::battle_action_is_own(&mine, b),
        "m22s4 [X5/action]: mirror image of the leak case."
    );
    assert!(
        !super::battle_action_is_own(&mine, c),
        "m22s4 [X5/action]: a third party who submitted nothing owns neither row."
    );
    assert!(
        !super::battle_action_is_own(&theirs, c),
        "m22s4 [X5/action]: a third party who submitted nothing owns neither row."
    );
}

/// PRV1-11 / X5 (behavioural): the telemetry table's own-row predicate answers
/// on IDENTITY, not on the battle. Same two-row, one-battle trap as above.
///
/// Kills: a predicate keyed on battle_id, event_id, kind or created_at_ms;
///        a predicate that ignores its identity argument;
///        an inverted comparison.
#[test]
fn m22s4_playtest_event_own_predicate() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let c = m22s4_id_c();
    let mine = m22s4_playtest_row(1, a);
    let theirs = m22s4_playtest_row(2, b);

    assert_eq!(
        mine.battle_id, theirs.battle_id,
        "m22s4 [X5/telemetry-vacuity]: the two fixtures must share one battle id."
    );
    assert_eq!(
        mine.kind, theirs.kind,
        "m22s4 [X5/telemetry-vacuity]: the two fixtures must share one event kind, so a \
         predicate keyed on the kind is not accidentally correct."
    );

    assert!(
        super::playtest_event_is_own(&mine, a),
        "m22s4 [X5/telemetry]: the subject's own telemetry row IS their own."
    );
    assert!(
        !super::playtest_event_is_own(&theirs, a),
        "m22s4 [X5/telemetry]: another identity's row from the SAME battle is NOT the subject's. \
         The table is unindexed and must-never-leak, so the scan's only bound is this predicate."
    );
    assert!(
        super::playtest_event_is_own(&theirs, b),
        "m22s4 [X5/telemetry]: the predicate must answer true for the other identity's own row."
    );
    assert!(
        !super::playtest_event_is_own(&mine, b),
        "m22s4 [X5/telemetry]: mirror image of the leak case."
    );
    assert!(
        !super::playtest_event_is_own(&mine, c),
        "m22s4 [X5/telemetry]: a third party owns neither row."
    );
    assert!(
        !super::playtest_event_is_own(&theirs, c),
        "m22s4 [X5/telemetry]: a third party owns neither row."
    );
}

// ===========================================================================
// X6 — the battle redaction (the only redaction that does anything).
// ===========================================================================

/// X6: the side-of-the-battle classifier is TOTAL and answers all four cases.
///
/// `Both` is not a defensive extra: a practice battle stores the same identity
/// on both sides, and collapsing it into `A` (or into `B`) is what would let a
/// later reader redact half of a row the subject wholly owns.
///
/// Kills: an if/else that returns A whenever the subject is on side A and never
///        reaches Both;
///        a classifier that returns A (or B) for a stranger, which would emit a
///        battle between two other players into a third party's export;
///        a comparison against the wrong column.
#[test]
fn m22s4_battle_side_of_truth_table() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let c = m22s4_id_c();

    let pvp = m22s4_battle_row(a, b);
    assert_eq!(
        super::battle_side_of(a, &pvp),
        super::BattleSideOwnership::A,
        "m22s4 [X6/side]: the identity on player_identity holds side A."
    );
    assert_eq!(
        super::battle_side_of(b, &pvp),
        super::BattleSideOwnership::B,
        "m22s4 [X6/side]: the identity on opponent_identity holds side B."
    );
    assert_eq!(
        super::battle_side_of(c, &pvp),
        super::BattleSideOwnership::Neither,
        "m22s4 [X6/side]: a third party holds NEITHER side. This is the arm that stops a filter \
         bug from emitting two other players' battle into a stranger's export."
    );

    let practice = m22s4_battle_row(a, a);
    assert_eq!(
        super::battle_side_of(a, &practice),
        super::BattleSideOwnership::Both,
        "m22s4 [X6/side]: a practice battle stores ONE identity on both columns, and the subject \
         holds BOTH sides. Collapsing this into A (the shape a plain if/else produces) makes the \
         serializer redact half of a row the subject wholly owns."
    );
    assert_eq!(
        super::battle_side_of(c, &practice),
        super::BattleSideOwnership::Neither,
        "m22s4 [X6/side]: a stranger holds neither side of a practice battle either."
    );
}

/// X6: the counterparty's identity AND monster list are nulled, the practice
/// battle is emitted whole, and a row the requester participates in on neither
/// side is a LOUD error.
///
/// Kills: redacting the identity but not the monster-id list (the list is a
///        durable fingerprint of the other player's team);
///        redacting the wrong side (mirror-image bug — both directions are
///        asserted);
///        redacting a practice battle's own second half;
///        silently skipping a not-mine row instead of failing loud, which turns
///        a filter bug into a silent partial export;
///        emitting the counterparty's identity anywhere in the payload (each
///        direction additionally asserts the raw hex is ABSENT, not merely that
///        the column is null).
#[test]
fn m22s4_battle_redacts_counterparty() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let c = m22s4_id_c();
    let row = m22s4_battle_row(a, b);

    // --- the requester is side A -------------------------------------------
    let out_a = super::json_battle(&row, a)
        .unwrap_or_else(|e| panic!("m22s4 [X6/redact]: side A must serialize: {e}"));
    assert_eq!(
        out_a,
        m22s4_expected_battle(
            m22s4_qid(a),
            m22s4_null(),
            m22s4_party_ids_json(),
            m22s4_null(),
        ),
        "m22s4 [X6/redact-a]: for a requester on side A, the OPPONENT identity and the OPPONENT \
         monster-id list must BOTH be null, and the requester's own side must be intact."
    );
    assert!(
        !out_a.contains(&b.to_string()),
        "m22s4 [X6/redact-a]: the counterparty's identity hex appears in the payload. Nulling the \
         column is not enough if the value is echoed anywhere else in the object."
    );
    assert!(
        !out_a.contains(&m22s4_opponent_ids_json()),
        "m22s4 [X6/redact-a]: the counterparty's monster-id list appears in the payload. That \
         list is a durable fingerprint of the other player's team."
    );

    // --- the requester is side B (the mirror image) ------------------------
    let out_b = super::json_battle(&row, b)
        .unwrap_or_else(|e| panic!("m22s4 [X6/redact]: side B must serialize: {e}"));
    assert_eq!(
        out_b,
        m22s4_expected_battle(
            m22s4_null(),
            m22s4_qid(b),
            m22s4_null(),
            m22s4_opponent_ids_json(),
        ),
        "m22s4 [X6/redact-b]: the mirror image. An implementation that always nulls the OPPONENT \
         columns passes the side-A clause and leaks the other player's identity to every side-B \
         requester."
    );
    assert!(
        !out_b.contains(&a.to_string()),
        "m22s4 [X6/redact-b]: the counterparty's identity hex appears in the payload."
    );
    assert!(
        !out_b.contains(&m22s4_party_ids_json()),
        "m22s4 [X6/redact-b]: the counterparty's monster-id list appears in the payload."
    );

    // --- a practice battle is emitted whole --------------------------------
    let practice = m22s4_battle_row(a, a);
    let out_p = super::json_battle(&practice, a)
        .unwrap_or_else(|e| panic!("m22s4 [X6/redact]: a practice battle must serialize: {e}"));
    assert_eq!(
        out_p,
        m22s4_expected_battle(
            m22s4_qid(a),
            m22s4_qid(a),
            m22s4_party_ids_json(),
            m22s4_opponent_ids_json(),
        ),
        "m22s4 [X6/practice]: a practice battle has ONE participant on both sides, so there is no \
         counterparty and NOTHING is redacted. Every column belongs to the subject."
    );
    assert_eq!(
        rb22p_count(&out_p, "null"),
        0,
        "m22s4 [X6/practice]: a practice battle's payload must contain no null at all. A \
         classifier that collapses Both into A would null two of the subject's own columns here."
    );

    // --- neither side is a LOUD error --------------------------------------
    let stranger = super::json_battle(&row, c);
    assert!(
        stranger.is_err(),
        "m22s4 [X6/neither]: serializing a battle the requester participates in on NEITHER side \
         must be a loud error, never a redacted-but-emitted row and never a silent skip. That \
         call is only reachable through a bug in the owner-scoped read, and the whole value of \
         the arm is that such a bug stops the export instead of quietly shipping two other \
         players' battle into a third party's personal-data download."
    );
}

/// X6: the nested battle-state blob is NEVER emitted.
///
/// The state column is a deep game-core structure holding both sides' full
/// team rosters; field-level redaction of it is high-cost and high-risk, so it
/// is OMITTED entirely and the subject's live access to it is unaffected. This
/// test proves the omission by VALUE, not by field name alone: every fixture
/// value inside the state is distinctive and multi-digit, and each is first
/// asserted PRESENT in the state's own debug rendering (so the ban list cannot
/// be a list of typos) and then asserted ABSENT from the payload.
///
/// Kills: emitting the state as a nested object;
///        lifting any part of it (an outcome, a turn counter, a team roster)
///        into the row object;
///        a debug-format fallback that stringifies the whole struct.
#[test]
fn m22s4_battle_state_blob_is_never_emitted() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let row = m22s4_battle_row(a, b);
    let out = super::json_battle(&row, a)
        .unwrap_or_else(|e| panic!("m22s4 [X6/state]: the row must serialize: {e}"));
    let rendered = format!("{:?}", m22s4_battle_state());

    for needle in [
        "9091",
        "213",
        "1777",
        "8888",
        "8181",
        "6161",
        "6262",
        "6363",
        "6464",
        "6565",
        "7007",
        "8008",
        "3131",
        "Electric",
        "Ongoing",
        "side_a",
        "side_b",
        "outcome",
        "turn_number",
        "weather",
        "team",
        "active",
        "known_skill_ids",
        "max_hp",
        "affinity",
        "stats",
    ] {
        assert!(
            rendered.contains(needle),
            "m22s4 [X6/state-vacuity]: `{needle}` does not appear in the battle state's own \
             rendering, so banning it from the payload proves nothing. Fix the fixture, never the \
             ban list."
        );
        assert!(
            !out.contains(needle),
            "m22s4 [X6/state]: the battle payload contains `{needle}`, which comes from the \
             nested state blob. The state column is deliberately OMITTED from the export: it \
             carries both sides' full team rosters, and field-level redaction of a deep nested \
             structure is strictly more code and more risk than omission. Payload: {out:?}"
        );
    }

    assert!(
        !out.contains("state"),
        "m22s4 [X6/state]: the payload names the `state` column. It must not appear as a key at \
         all, not even with a null or an empty value."
    );
    assert_eq!(
        rb22p_count(&out, ":"),
        6,
        "m22s4 [X6/state-arity]: the battle payload must carry EXACTLY six key/value pairs (the \
         seven columns minus the omitted state). A seventh key is either the state creeping back \
         or an unreviewed addition to a durable artifact. Payload: {out:?}"
    );
}

/// X6: the per-turn secret action table needs no redaction because the own-rows
/// filter already makes one structurally impossible — asserted, not assumed.
///
/// The redaction is VACUOUS BY CONSTRUCTION and that is a claim with teeth: it
/// holds only while the own-rows predicate is the SOLE bound on the scan and
/// every surviving row belongs to the subject. Both halves are checked here,
/// behaviourally and structurally.
///
/// Kills: a serializer that nulls the submitter's OWN identity (over-redaction
///        that silently empties the subject's own export);
///        a reader that serializes before it filters, so a foreign row is
///        rendered (and could be logged or partially emitted) on the way;
///        a second, unfiltered read path into the same table.
#[test]
fn m22s4_battle_action_own_rows_only() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let mine = m22s4_action_row(1, a);
    let theirs = m22s4_action_row(2, b);

    // --- behavioural: the filter is what makes the redaction vacuous -------
    let kept: Vec<&BattleAction> = [&mine, &theirs]
        .into_iter()
        .filter(|row| super::battle_action_is_own(row, a))
        .collect();
    assert_eq!(
        kept.len(),
        1,
        "m22s4 [X6/action-filter]: of two rows in one battle, exactly ONE is the subject's."
    );
    assert_eq!(
        kept[0].action_id, 1,
        "m22s4 [X6/action-filter]: the surviving row must be the subject's own."
    );

    let out = super::json_battle_action(kept[0]);
    assert!(
        out.contains(&a.to_string()),
        "m22s4 [X6/action-no-redaction]: the subject's OWN identity must be emitted unredacted. \
         The redaction is vacuous because no counterparty row is ever in the result set — not \
         because the column is blanked. Nulling it here would empty the subject's own export."
    );
    assert!(
        !out.contains(&b.to_string()),
        "m22s4 [X6/action-no-redaction]: no other identity may appear in the payload."
    );
    assert_eq!(
        rb22p_count(&out, "null"),
        0,
        "m22s4 [X6/action-no-redaction]: this table has no nullable column and needs no \
         redaction; a null in the payload means something was blanked that should not have been."
    );

    // --- structural: the scan is bounded BEFORE anything is serialized -----
    let squashed = stripped_for_scan(PRIVACY_RS);
    let body = m22s4_rows_body(&squashed, "battle_action");
    let pred_at = m22s4_idx(&body, "battle_action_is_own(", "the own-row predicate call");
    let ser_at = m22s4_idx(&body, "json_battle_action(", "the row serializer call");
    assert!(
        pred_at < ser_at,
        "m22s4 [X6/action-order]: the reader serializes rows BEFORE narrowing them to the \
         subject's own. The own-rows filter is the only thing standing between an unindexed scan \
         of a must-never-leak table and every player's pending pick, so it must bound the scan, \
         not post-process its output."
    );
    assert_eq!(
        rb22p_count(&body, ".iter()"),
        1,
        "m22s4 [X6/action-order]: exactly one scan; a second read path into this table would be \
         unbounded by the clause above."
    );
}

// ===========================================================================
// X7 — the JSON escaping and numeric-encoding contract.
// ===========================================================================

/// X7: the escaper's edge cases, each spelled from the CONTRACT.
///
/// The rule is deliberately UNIFORM: exactly three escapes exist — the quote,
/// the backslash, and the six-character control form with LOWERCASE hex. No
/// two-character short forms, because one branch is one test family and a short
/// form is a second, separately-buggy path. The solidus and DEL are explicitly
/// NOT escaped, and everything at or above the space passes through as UTF-8.
///
/// Kills: escaping only the quote and not the backslash (or vice versa);
///        a short form for line feed / tab / carriage return;
///        UPPERCASE hex in the control form (a strict consumer rejects neither,
///        but the contract is one spelling and the reference unescaper below
///        enforces it);
///        escaping the solidus or DEL (harmless but off-contract, and it makes
///        the round-trip property's reference implementation wrong);
///        mangling multi-byte UTF-8 by working over bytes instead of chars.
#[test]
fn m22s4_escape_edge_cases() {
    let dq = rb22p_dq().to_string();
    assert_eq!(
        m22s4_esc(&dq),
        m22s4_esc_quote(),
        "m22s4 [X7/quote]: a double quote must become backslash + quote. Unescaped, it CLOSES the \
         JSON string early and the rest of a player-authored name is parsed as structure."
    );

    let bs = m22s4_bs().to_string();
    assert_eq!(
        m22s4_esc(&bs),
        m22s4_esc_backslash(),
        "m22s4 [X7/backslash]: a backslash must be doubled. Left alone it turns the NEXT \
         character into an escape the consumer never intended."
    );

    for code in 0u32..0x20 {
        let c = char::from_u32(code).expect("m22s4 [X7/control]: every C0 code is a scalar value");
        assert_eq!(
            m22s4_esc(&c.to_string()),
            m22s4_u_esc(code),
            "m22s4 [X7/control]: the C0 byte U+{code:04X} must become the UNIFORM six-character \
             escape with lowercase hex. Raw control bytes are invalid inside a JSON string, and a \
             two-character short form for some of them is a second branch with its own bugs."
        );
    }

    assert_eq!(
        m22s4_esc("/"),
        "/",
        "m22s4 [X7/solidus]: the solidus is NOT escaped. Escaping it is legal JSON but it is not \
         this contract, and the reference unescaper would then reject the output."
    );
    assert_eq!(
        m22s4_esc("\u{007F}"),
        "\u{007F}",
        "m22s4 [X7/del]: DEL is not a C0 control and is NOT escaped."
    );
    assert_eq!(
        m22s4_esc("\u{00E9}\u{4E2D}\u{1F600}"),
        "\u{00E9}\u{4E2D}\u{1F600}",
        "m22s4 [X7/utf8]: 2-, 3- and 4-byte UTF-8 pass through untouched. An escaper written over \
         BYTES rather than chars mangles all three."
    );

    assert_eq!(
        m22s4_esc(&m22s4_nasty()),
        m22s4_nasty_escaped(),
        "m22s4 [X7/composite]: the whole adversarial string, escaped in one pass, must equal the \
         concatenation of the per-case rules above."
    );
    assert_eq!(
        m22s4_str(&m22s4_nasty()),
        m22s4_nasty_json(),
        "m22s4 [X7/framing]: the string emitter is quote + escape + quote, and the framing quotes \
         are the ONLY unescaped quotes in its output."
    );

    let mut short_form = String::new();
    short_form.push(m22s4_bs());
    short_form.push('n');
    assert_ne!(
        m22s4_esc("\n"),
        short_form,
        "m22s4 [X7/no-short-form]: the line feed must NOT use the two-character short form. The \
         contract has exactly one control branch on purpose."
    );
}

proptest! {
    /// X7 (round trip): for ANY string, the escaper is LOSSLESS under a
    /// reference unescaper that exists only in this test file.
    ///
    /// The inverse lives here and only here: shipping one in privacy.rs would
    /// give the property a shared bug to agree on. The generator is explicit
    /// rather than the default string strategy, which excludes control
    /// characters — exactly the class this property exists to cover.
    ///
    /// Kills: dropping a character; emitting an escape the contract does not
    ///        admit; uppercase hex; a truncated control escape; double-escaping.
    #[test]
    fn m22s4_escape_roundtrip_property(s in m22s4_arb_text()) {
        let escaped = m22s4_esc(&s);
        match m22s4_unescape(&escaped) {
            Ok(back) => {
                prop_assert_eq!(
                    back,
                    s,
                    "the escaper must be LOSSLESS: unescaping its output must reproduce the input"
                );
            }
            Err(why) => {
                prop_assert!(
                    false,
                    "the escaper emitted text the contract's own inverse rejects: {}",
                    why
                );
            }
        }
    }

    /// X7 (structural): the escaper's output carries NO raw control byte and no
    /// unescaped quote, checked by an INDEPENDENT backslash-parity walk rather
    /// than through the reference unescaper — so a shared misunderstanding
    /// between the escaper and the unescaper cannot make both green.
    ///
    /// Kills: a raw quote surviving into the output (it terminates the string
    ///        early and everything after it is parsed as structure);
    ///        a raw control byte surviving (invalid JSON, and a real injection
    ///        surface in a downloadable artifact);
    ///        an escape whose partner character is itself a control byte;
    ///        a string emitter whose framing quotes are not exactly two.
    #[test]
    fn m22s4_escape_output_has_no_raw_control_or_quote(s in m22s4_arb_text()) {
        let escaped = m22s4_esc(&s);
        let chars: Vec<char> = escaped.chars().collect();
        let mut i = 0usize;
        while i < chars.len() {
            let c = chars[i];
            prop_assert!(
                (c as u32) >= 0x20,
                "a RAW control character survived escaping at char {}",
                i
            );
            if c == m22s4_bs() {
                prop_assert!(i + 1 < chars.len(), "the output ends in a lone backslash");
                prop_assert!(
                    (chars[i + 1] as u32) >= 0x20,
                    "an escape at char {} is followed by a raw control character",
                    i
                );
                i += 2;
                continue;
            }
            prop_assert!(
                c != rb22p_dq(),
                "an UNESCAPED double quote survived at char {}",
                i
            );
            i += 1;
        }

        let quoted = m22s4_str(&s);
        prop_assert_eq!(
            quoted.chars().count(),
            escaped.chars().count() + 2,
            "the string emitter must add exactly two framing quotes and nothing else"
        );
        prop_assert!(
            m22s4_json_is_wellformed(&quoted),
            "the quoted output must parse as exactly ONE JSON string value"
        );
    }
}

/// Text generator for the two escaper properties.
///
/// The DEFAULT string strategy excludes control characters, so it would never
/// exercise the branch this contract is mostly about. This one is weighted
/// toward the hazards: C0 controls, the quote, the backslash, the solidus, DEL,
/// printable ASCII, the basic multilingual plane and astral scalars.
fn m22s4_arb_char() -> impl Strategy<Value = char> {
    prop_oneof![
        4 => prop::char::range('\u{0000}', '\u{001F}'),
        3 => Just(rb22p_dq()),
        3 => Just(m22s4_bs()),
        1 => Just('/'),
        1 => Just('\u{007F}'),
        6 => prop::char::range('\u{0020}', '\u{007E}'),
        3 => prop::char::range('\u{00A0}', '\u{D7FF}'),
        2 => prop::char::range('\u{10000}', '\u{10FFFF}'),
    ]
}

/// A short random text over `m22s4_arb_char`.
fn m22s4_arb_text() -> impl Strategy<Value = String> {
    prop::collection::vec(m22s4_arb_char(), 0..24usize).prop_map(|v| v.into_iter().collect())
}

/// X7: 64-bit integers are QUOTED decimal strings.
///
/// The client assembles the downloaded chunks with a parser whose numbers are
/// doubles, so a bare 64-bit integer above 2^53 comes back SILENTLY WRONG — a
/// wallet balance, a row id or an input sequence off by a few units, in the
/// subject's own personal-data export. Every expected literal below is typed
/// out digit by digit rather than derived from the value under test.
///
/// Kills: a bare emitter for u64 or i64;
///        an emitter that saturates or truncates at the extremes;
///        an emitter that renders the sign outside the quotes.
#[test]
fn m22s4_u64_i64_are_quoted_strings() {
    assert_eq!(
        m22s4_u64_out(0),
        m22s4_qtxt("0"),
        "m22s4 [X7/u64]: zero is still the quoted form — the rule is per TYPE, not per value."
    );
    assert_eq!(
        m22s4_u64_out(9_007_199_254_740_993),
        m22s4_qtxt("9007199254740993"),
        "m22s4 [X7/u64]: one above 2^53 is the smallest value a double cannot represent exactly. \
         A bare number here is the silent-corruption case."
    );
    assert_eq!(
        m22s4_u64_out(u64::MAX),
        m22s4_qtxt("18446744073709551615"),
        "m22s4 [X7/u64]: the maximum must render in full, with no exponent and no rounding."
    );

    assert_eq!(
        m22s4_i64_out(0),
        m22s4_qtxt("0"),
        "m22s4 [X7/i64]: zero is still the quoted form."
    );
    assert_eq!(
        m22s4_i64_out(-1),
        m22s4_qtxt("-1"),
        "m22s4 [X7/i64]: the sign belongs INSIDE the quotes, as part of the decimal text."
    );
    assert_eq!(
        m22s4_i64_out(i64::MIN),
        m22s4_qtxt("-9223372036854775808"),
        "m22s4 [X7/i64]: the minimum has no positive counterpart, so any implementation that \
         negates before formatting overflows here."
    );
    assert_eq!(
        m22s4_i64_out(i64::MAX),
        m22s4_qtxt("9223372036854775807"),
        "m22s4 [X7/i64]: the maximum must render in full."
    );
}

/// X7: everything 32 bits or narrower, and the bool and null literals, are
/// BARE.
///
/// The mirror of the clause above and equally load-bearing: quoting a small
/// integer turns a number into a string in a durable artifact, and the client
/// assembler would then do arithmetic on text.
///
/// Kills: a blanket quoted emitter applied to every integer width;
///        a bool rendered as a quoted word or as 0/1;
///        an absent option rendered as a quoted word.
#[test]
fn m22s4_small_ints_are_bare() {
    let outputs = [
        ("u32/min", m22s4_u32_out(0), "0".to_string()),
        ("u32/max", m22s4_u32_out(u32::MAX), "4294967295".to_string()),
        ("u16/max", m22s4_u16_out(u16::MAX), "65535".to_string()),
        ("u8/max", m22s4_u8_out(u8::MAX), "255".to_string()),
        (
            "i32/min",
            m22s4_i32_out(i32::MIN),
            "-2147483648".to_string(),
        ),
        ("i32/max", m22s4_i32_out(i32::MAX), "2147483647".to_string()),
        ("i32/neg", m22s4_i32_out(-25), "-25".to_string()),
        ("bool/true", m22s4_bool_out(true), "true".to_string()),
        ("bool/false", m22s4_bool_out(false), "false".to_string()),
        ("null", m22s4_null_out(), "null".to_string()),
    ];
    for (label, got, want) in &outputs {
        assert_eq!(
            got, want,
            "m22s4 [X7/bare]: the `{label}` emitter must produce the BARE JSON literal."
        );
        assert!(
            !got.contains(rb22p_dq()),
            "m22s4 [X7/bare]: the `{label}` emitter produced a QUOTE. Quoting a 32-bit-or-narrower \
             column turns a number into a string in a durable artifact, and the client assembler \
             would then do arithmetic on text."
        );
    }
}

/// X7: an identity renders as 64 LOWERCASE hex digits inside quotes.
///
/// Three independent instruments, because a single one is either tautological
/// or blind: the SHAPE (length, charset, case), an INDEPENDENT expected value
/// built by repeating the byte's hex pair (no call to the identity's own
/// formatter), and a tie back to that formatter so the module keeps ONE
/// spelling of the rule.
///
/// Kills: uppercase hex (breaks byte-for-byte comparison against every other
///        identity rendering in the system);
///        a truncated or zero-padded-to-the-wrong-width rendering;
///        a debug rendering that wraps the hex in a type name;
///        an emitter that forgets the quotes (an unquoted hex run is not a JSON
///        value at all);
///        an emitter that renders every identity alike.
#[test]
fn m22s4_identity_is_64_lowercase_hex() {
    let id = m22s4_id(0xAB);
    let out = m22s4_ident_out(id);

    assert_eq!(
        out.chars().count(),
        66,
        "m22s4 [X7/identity-len]: the rendering must be exactly 64 hex digits plus two framing \
         quotes; got {out:?}."
    );
    assert!(
        out.starts_with(rb22p_dq()) && out.ends_with(rb22p_dq()),
        "m22s4 [X7/identity-frame]: the hex must be QUOTED — a bare hex run is not a JSON value."
    );

    let inner: String = out.chars().skip(1).take(64).collect();
    assert!(
        inner.chars().all(|c| c.is_ascii_hexdigit()),
        "m22s4 [X7/identity-charset]: the rendering contains a non-hex character: {inner:?}."
    );
    assert!(
        !inner.chars().any(|c| c.is_ascii_uppercase()),
        "m22s4 [X7/identity-case]: the rendering uses UPPERCASE hex. Every other identity \
         rendering in the system is fixed-width lowercase, and a case mismatch silently breaks \
         string comparison against them: {inner:?}."
    );
    assert_eq!(
        inner,
        m22s4_id_hex(0xAB),
        "m22s4 [X7/identity-value]: the rendering does not match the byte pattern built \
         INDEPENDENTLY of the identity formatter."
    );

    let other = m22s4_id(0x0F);
    assert_eq!(
        m22s4_ident_out(other),
        m22s4_qtxt(&m22s4_id_hex(0x0F)),
        "m22s4 [X7/identity-value]: a second identity, chosen so its hex pair needs a leading \
         zero, must also render exactly."
    );
    assert_ne!(
        m22s4_ident_out(id),
        m22s4_ident_out(other),
        "m22s4 [X7/identity-distinct]: two different identities must not render alike — a \
         constant emitter passes every shape clause above."
    );
    assert_eq!(
        out,
        m22s4_qtxt(&id.to_string()),
        "m22s4 [X7/identity-ssot]: the emitter must be the identity's own display rendering, \
         quoted — not a second, separately-drifting hex formatter."
    );
}

// ===========================================================================
// X8 — the export cooldown (reject, never clamp).
// ===========================================================================

/// X8: the cooldown predicate's truth table, boundary included.
///
/// The boundary is inclusive at exactly the window, matching every other
/// elapsed-time rule in the module. Both extremes are exercised because the
/// release profile has overflow checks ON: a wrapping subtraction here would
/// PANIC inside a reducer and abort its whole transaction in production.
///
/// Kills: a strictly-greater boundary (the request at exactly the window is
///        rejected forever if the caller retries on the same tick);
///        a request-blind comparison against the raw clock (which allows
///        everything once the epoch clock passes the threshold);
///        a wrapping subtraction (panics at the extremes);
///        accepting a future-dated stamp (clock skew would reopen the window).
#[test]
fn m22s4_cooldown_truth_table() {
    let window = super::EXPORT_REQUEST_COOLDOWN_MS;
    assert_eq!(
        window, 60_000,
        "m22s4 [X8/window]: the cooldown window is {window} ms; this suite was sized against \
         60000. Retuning it is free, but the boundary cases below must be re-derived in the same \
         diff."
    );

    assert!(
        super::export_cooldown_elapsed(None, 0),
        "m22s4 [X8/none]: NO prior export means the request is ALLOWED. This polarity is the \
         opposite of the deletion-grace rule's, and copying that function inverts the gate."
    );
    assert!(
        super::export_cooldown_elapsed(None, i64::MIN),
        "m22s4 [X8/none]: the no-prior-export answer cannot depend on the clock at all."
    );

    assert!(
        super::export_cooldown_elapsed(Some(0), window),
        "m22s4 [X8/boundary]: at EXACTLY the window the request is allowed (inclusive boundary)."
    );
    assert!(
        !super::export_cooldown_elapsed(Some(0), window - 1),
        "m22s4 [X8/boundary]: one millisecond below the window the request is REJECTED. This pair \
         is what pins the comparison operator."
    );
    assert!(
        super::export_cooldown_elapsed(Some(0), window + 1),
        "m22s4 [X8/boundary]: past the window the request is allowed."
    );
    assert!(
        !super::export_cooldown_elapsed(Some(0), 0),
        "m22s4 [X8/same-tick]: two requests on the same tick — the flood case this rule exists \
         for — must reject."
    );

    assert!(
        !super::export_cooldown_elapsed(Some(1_000_000), 500_000),
        "m22s4 [X8/skew]: a FUTURE-dated prior export (clock skew) yields negative elapsed time \
         and must read as NOT elapsed. The safe direction is over-rejection."
    );

    assert!(
        !super::export_cooldown_elapsed(Some(i64::MAX), i64::MIN),
        "m22s4 [X8/saturate]: the extreme skew case must SATURATE, not wrap. Overflow checks are \
         on in the release profile, so a wrapping subtraction panics and aborts the reducer's \
         whole transaction."
    );
    assert!(
        super::export_cooldown_elapsed(Some(i64::MIN), i64::MAX),
        "m22s4 [X8/saturate]: the opposite extreme must also saturate rather than wrap, and it \
         is unambiguously past the window."
    );
}

/// X8 (the polarity trap): the cooldown's no-prior-state answer is the OPPOSITE
/// of the deletion-grace rule's, and both are called here so the pair cannot
/// drift.
///
/// The two functions look alike enough to copy: both take an optional prior
/// timestamp plus a clock and compare an elapsed span to a window. Their
/// absent-state arms are inverted, because absent means opposite things — no
/// prior export (so ALLOW) versus no pending deletion request (so NOT DUE).
/// A copy-paste silently inverts one of them.
///
/// Kills: a cooldown whose absent arm rejects (which would make the FIRST
///        export of every subject's life impossible — the criterion this
///        whole slice exists to satisfy);
///        a deletion rule whose absent arm reads as due (which would cascade
///        over every cancelled and every ordinary account).
#[test]
fn m22s4_cooldown_polarity_differs_from_is_deletion_due() {
    let now = 1_700_000_000_000i64;

    let cooldown_none = super::export_cooldown_elapsed(None, now);
    let deletion_none = game_core::is_deletion_due(None, now);

    assert!(
        cooldown_none,
        "m22s4 [X8/polarity]: with NO prior export the cooldown must ALLOW. Absent means `this \
         subject has never exported`, so rejecting here makes the first export impossible."
    );
    assert!(
        !deletion_none,
        "m22s4 [X8/polarity]: with NO deletion request pending the grace rule must answer NOT \
         due. Absent means `cancelled or never requested`, so answering due would cascade over \
         every ordinary account. Asserted here as the fixed point the inversion is measured \
         against — if this ever flips, the comparison below stops meaning anything."
    );
    assert_ne!(
        cooldown_none, deletion_none,
        "m22s4 [X8/polarity]: the two absent-state answers are EQUAL, which means one of the two \
         rules was copied from the other without inverting its absent arm. They take the same \
         argument shapes and compare an elapsed span to a window, so the copy compiles, passes \
         clippy, and silently disables one of the two gates."
    );
}

// ===========================================================================
// X9 — the reducer wiring (the security shape).
//
// SOURCE-STRUCTURE ONLY, and it says so: a ReducerContext is not constructible
// off-instance, so these clauses pin the SHAPE of the one client entry point.
// Every clause is scoped through the fn-body extractor, never a whole-file
// contains, and every count is exact.
// ===========================================================================

/// X9: the reducer takes EXACTLY the sanctioned one-parameter signature.
///
/// This is the highest-severity pin in the slice, on a par with the view body.
/// A view or a reducer in this toolchain happily accepts extra arguments, so a
/// second parameter naming a subject — an optional on-behalf-of identity, say —
/// is a complete cross-account read of every exportable table, and it passes
/// every ordering, counting and body clause below.
///
/// Kills: an added identity-typed parameter (the caller-chosen-owner bypass);
///        an added struct parameter carrying an identity field;
///        a second definition under a cfg twin;
///        a return type that swallows the guard errors.
#[test]
fn m22s4_reducer_signature_exact() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let fn_needle = m22s4_nd_reducer_fn();

    let n = rb22p_count(&squashed, &fn_needle);
    assert_eq!(
        n, 1,
        "m22s4 [X9/decl-count]: privacy.rs must define `{fn_needle}` exactly once; found {n}. Two \
         definitions make every body clause read whichever one the extractor reaches first, so \
         the other is completely ungated."
    );

    let sig = extract_squashed_fn_sig(&squashed, &fn_needle)
        .unwrap_or_else(|| panic!("m22s4 [X9/sig]: `{fn_needle}` has no opening brace."));
    assert_eq!(
        sig,
        m22s4_reducer_sig_pin(),
        "m22s4 [X9/sig]: the export reducer's signature is not the frozen one. It takes the \
         reducer context under the name `ctx` and NOTHING ELSE. This toolchain accepts extra \
         reducer arguments, so ONE added identity-typed parameter turns the subject-access \
         export into an any-account read of every exportable table — and that shape satisfies \
         every ordering, counting and body clause in this module."
    );

    let attr = m22s4_nd_reducer_attr();
    assert_eq!(
        rb22p_count(&squashed, &attr),
        1,
        "m22s4 [X9/attr-count]: privacy.rs must declare EXACTLY one reducer. A second client \
         entry point in this module is a second, unreviewed way to reach the export machinery."
    );
    let adjacency = format!("{attr}pub{fn_needle}");
    assert_eq!(
        rb22p_count(&squashed, &adjacency),
        1,
        "m22s4 [X9/attr-adjacency]: the reducer attribute must sit IMMEDIATELY above the pinned \
         declaration. A count of the attribute and a count of the fn, taken separately, are both \
         satisfied by an attribute attached to some OTHER function."
    );
}

/// X9: the body's statement ORDER is the security shape.
///
/// Subject guard, then deletion gate, then cooldown, then the purge, then the
/// writes — with EXACTLY three guard returns before the purge. Order is not
/// cosmetic: every guard that runs after the purge has already destroyed the
/// subject's previous bundle, and every guard that runs after a write has
/// already written.
///
/// Kills: a guard moved below the purge (its rejection would still be correct,
///        but the caller's previous export is gone);
///        a fourth pre-purge return (an undeclared early exit — the one shape
///        that silently skips the whole export while returning Ok);
///        a deleted guard (each reject reason is counted, so removing one takes
///        the count to zero rather than merely reordering it);
///        the purge wrapped in a conditional (the depth clause);
///        a second purge call site.
#[test]
fn m22s4_reducer_statement_order() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let body = m22s4_reducer_body(&squashed);

    let account_read = [concat!("ctx", ".db."), "account()"].concat();
    let player_read = [concat!("ctx", ".db."), "player()"].concat();
    let purge_call = m22s4_purge_call_pin();
    let insert = m22s4_nd_bundle_insert();

    let i_account = m22s4_idx(&body, &account_read, "the subject guard's account read");
    let i_player = m22s4_idx(&body, &player_read, "the subject guard's presence read");
    let i_no_subject = m22s4_idx(
        &body,
        "export_reject_no_subject",
        "the subject reject reason",
    );
    let i_gate = m22s4_idx(
        &body,
        "is_pending_deletion(ctx,me)",
        "the deletion gate call",
    );
    let i_gate_err = m22s4_idx(
        &body,
        "export_reject_pending_deletion",
        "the deletion reject reason",
    );
    let i_cooldown = m22s4_idx(
        &body,
        "export_cooldown_elapsed(",
        "the cooldown predicate call",
    );
    let i_cooldown_err = m22s4_idx(
        &body,
        "export_reject_cooldown",
        "the cooldown reject reason",
    );
    let i_purge = m22s4_idx(&body, &purge_call, "the purge call");
    let i_insert = m22s4_idx(&body, &insert, "the first export_bundle write");

    assert!(
        i_account < i_no_subject && i_player < i_no_subject,
        "m22s4 [X9/order]: the subject guard must READ both the account row and the presence row \
         before it can reject. An anonymous connection receives a working identity, so without \
         this guard a zero-state identity can farm a full empty export on every call, forever \
         (the TTL reaper is deferred)."
    );
    assert!(
        i_no_subject < i_gate,
        "m22s4 [X9/order]: the subject guard runs BEFORE the deletion gate."
    );
    assert!(
        i_gate < i_gate_err,
        "m22s4 [X9/order]: the deletion gate is called before it can reject."
    );
    assert!(
        i_gate_err < i_cooldown,
        "m22s4 [X9/order]: the deletion gate runs BEFORE the cooldown. The export writes a \
         manifest-classified erase table, so the deletion gate applies to it."
    );
    assert!(
        i_cooldown < i_cooldown_err,
        "m22s4 [X9/order]: the cooldown predicate is called before it can reject."
    );
    assert!(
        i_cooldown_err < i_purge,
        "m22s4 [X9/order]: the cooldown REJECTS before the purge. A cooldown check placed after \
         the purge still returns an error, but it has already destroyed the caller's previous \
         bundle — so a flood of rejected calls becomes a way to keep a subject permanently \
         without an export."
    );
    assert!(
        i_purge < i_insert,
        "m22s4 [X9/order]: the purge runs BEFORE the first write. Purging afterwards deletes the \
         chunks that were just written."
    );

    for reason in [
        "export_reject_no_subject",
        "export_reject_pending_deletion",
        "export_reject_cooldown",
    ] {
        assert_eq!(
            rb22p_count(&body, reason),
            1,
            "m22s4 [X9/reason]: `{reason}` must appear EXACTLY once. Zero means the guard was \
             deleted; two means two different paths return the same static reason and the \
             ordering clauses above can no longer attribute either."
        );
    }

    assert_eq!(
        rb22p_count(&body, &purge_call),
        1,
        "m22s4 [X9/purge-count]: the purge must be called exactly once, spelled exactly \
         `{purge_call}`. Any other spelling hands a different owner to a body whose frozen-body \
         pin still reports it as correct."
    );
    assert_eq!(
        m22s4_brace_depth_at(&body, i_purge),
        0,
        "m22s4 [X9/purge-depth]: the purge call sits inside a nested block. A conditional purge is \
         a conditional purge-before-write: the branch can be always-false at that point, leaving \
         the previous request's chunks live alongside the new ones while every count and ordering \
         clause stays green."
    );

    let pre_purge = &body[..i_purge];
    let returns = m22s4_left_bounded_count(pre_purge, "return");
    assert_eq!(
        returns, 3,
        "m22s4 [X9/returns]: exactly THREE return tokens may precede the purge — the subject \
         guard, the deletion gate and the cooldown. Found {returns}. A fourth is an undeclared \
         early exit that silently produces no export while returning success; two means a guard \
         stopped rejecting."
    );

    assert_eq!(
        rb22p_count(&body, &insert),
        1,
        "m22s4 [X9/insert-count]: the body must carry exactly one export_bundle write site (the \
         insert loop). A second write site is a second, separately-shaped row."
    );
}

/// X9: the clock is read ONCE and both time columns read that binding.
///
/// A shadowed second clock read is the measured cheat here: the request id and
/// the row timestamp then come from two different instants, so the chunks of
/// ONE request no longer share a request id and the client's reassembly rule
/// (group by request, wait for the full count) silently never completes.
///
/// Kills: a second clock read anywhere in the module;
///        a request id minted from something other than the bound clock;
///        a row timestamp taken from a fresh read.
#[test]
fn m22s4_now_bound_once() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let body = m22s4_reducer_body(&squashed);

    assert_eq!(
        rb22p_count(&squashed, "now_ms("),
        1,
        "m22s4 [X9/now-file]: the whole module must read the injected clock exactly once. A \
         second read anywhere is a second instant that can disagree with the first."
    );
    assert_eq!(
        rb22p_count(&body, "letnow=now_ms(ctx);"),
        1,
        "m22s4 [X9/now-bind]: the clock must be bound once, by name, from the injected context."
    );
    assert_eq!(
        rb22p_count(&body, "request_id:nowasu64"),
        1,
        "m22s4 [X9/now-request-id]: the request id must be minted from the SAME binding. It is \
         monotone, meaningful and derived from the injected clock — never from randomness, which \
         is documented non-cryptographic here and is banned in security-sensitive paths."
    );
    assert_eq!(
        rb22p_count(&body, "created_at_ms:now"),
        1,
        "m22s4 [X9/now-stamp]: the row timestamp must read the SAME binding. With two reads the \
         chunks of one request carry two different request ids and the client waits forever."
    );
}

/// X9: the subject is derived from the caller ONCE, and nothing else in the
/// body names an identity.
///
/// The measured bypass this closes: read a victim identity off some row the
/// reducer already has in hand and pass THAT to the dispatch. Every ordering,
/// counting and reject-reason clause stays green, because the shape of the
/// reducer is unchanged — only the argument moved.
///
/// Kills: a second caller read (from which a different variable could be bound);
///        a dispatch call passing anything but the bound subject;
///        an index read keyed on anything but the bound subject;
///        a read of a table outside the three the guards and the cooldown need,
///        which is where a foreign identity would have to come from.
#[test]
fn m22s4_sender_bound_once_and_sole_identity_source() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let body = m22s4_reducer_body(&squashed);
    let sender = concat!("ctx", ".sender()");

    assert_eq!(
        rb22p_count(&body, sender),
        1,
        "m22s4 [X9/sender-count]: the reducer must read the caller EXACTLY once. Every other \
         identity in this body must be that one binding; a second read is a second place a \
         different value could be substituted."
    );
    assert_eq!(
        rb22p_count(&body, &format!("letme={sender};")),
        1,
        "m22s4 [X9/sender-bind]: the caller must be bound under the pinned name — every other \
         clause in this test spells its expectations against it."
    );

    // Every index read in the body is keyed on the bound subject.
    for verb in [".find(", ".filter("] {
        let args = m22s4_call_arg_lists(&body, verb);
        for arg in &args {
            assert_ne!(
                arg, M22S4_UNBALANCED,
                "m22s4 [X9/key-attribution]: a `{verb}` call in the reducer body is not \
                 paren-balanced. Refusing to classify is the safe direction: an unclassifiable \
                 read is an ungated read."
            );
            assert_eq!(
                arg, "me",
                "m22s4 [X9/key]: a `{verb}` call in the reducer body is keyed on `{arg}`, not on \
                 the bound subject. Every read this reducer performs is on behalf of the caller. \
                 (Iterator find/filter are deliberately not used in this body, so an argument \
                 that is not the subject is unambiguously a foreign key.)"
            );
        }
    }

    // Every call that receives the context receives it alone or with the subject.
    let mut ctx_calls = 0usize;
    let mut scan = 0usize;
    while let Some(rel) = body[scan..].find("(ctx") {
        let at = scan + rel;
        let rest = &body[at + 4..];
        if let Some(stripped) = rest.strip_prefix(',') {
            assert!(
                stripped.starts_with("me)"),
                "m22s4 [X9/dispatch-args]: a call in the reducer body passes the context together \
                 with something other than the bound subject. The dispatch is `(ctx, me)` and \
                 nothing else: a shell reader handed any other identity reads another account's \
                 rows into this subject's export while every other clause stays green."
            );
            ctx_calls += 1;
        } else if rest.starts_with(')') {
            ctx_calls += 1;
        }
        scan = at + 4;
    }
    assert!(
        ctx_calls >= 3,
        "m22s4 [X9/dispatch-args]: only {ctx_calls} context-passing call(s) were found in the \
         reducer body; the clock read, the deletion gate, the purge and the per-table dispatch \
         are four. A scan that finds too few is a scan that stopped looking."
    );

    // The only tables this body may touch are the three the guards need.
    let accessors = m22s4_db_accessors(&body);
    assert!(
        !accessors.is_empty(),
        "m22s4 [X9/accessors]: the reducer body performs NO table access at all, so the clause \
         below would pass over an empty set."
    );
    let bundle = concat!("export", "_bundle");
    for name in &accessors {
        assert!(
            name == "account" || name == "player" || name == bundle,
            "m22s4 [X9/accessors]: the reducer body reads table `{name}`. Only the subject guard's \
             two tables and the module's own write target belong here; every EXPORTABLE table is \
             read through its own shell reader, which this module pins separately. An extra read \
             in the reducer is where a foreign identity would be picked up."
        );
    }
}

/// X9: the written row names all eight columns, with the two that are not free
/// pinned by VALUE.
///
/// Kills: an omitted column (which would not compile, but the count also
///        catches a column written twice through a spread);
///        a synthetic key written as anything but the auto-increment sentinel;
///        an owner column written from anything but the bound subject — the
///        single most direct way to write one subject's data under another's
///        identity;
///        a per-table total instead of the request-wide one.
#[test]
fn m22s4_insert_row_fields_exact() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let body = m22s4_reducer_body(&squashed);

    let opener = "ExportBundle{";
    assert_eq!(
        rb22p_count(&body, opener),
        1,
        "m22s4 [X9/row-count]: the body must construct exactly one export row literal."
    );
    let at = m22s4_idx(&body, opener, "the written row literal");
    let literal = m22s4_braced_span(&body, at + opener.len() - 1).unwrap_or_else(|| {
        panic!("m22s4 [X9/row-scope]: the written row literal is not brace-balanced.")
    });

    for column in [
        "chunk_id",
        "owner_identity",
        "request_id",
        "table_name",
        "chunk_index",
        "total_chunks",
        "payload_json",
        "created_at_ms",
    ] {
        let key = format!("{column}:");
        assert_eq!(
            rb22p_count(literal, &key),
            1,
            "m22s4 [X9/row-columns]: the written row must name `{column}` exactly once. All eight \
             columns are written explicitly, so adding a column to the table is a compile error \
             here rather than a silently defaulted value in a durable artifact."
        );
    }

    assert!(
        literal.contains("chunk_id:0"),
        "m22s4 [X9/row-key]: the synthetic key must be written as the auto-increment sentinel. \
         Any other value collides rows across requests."
    );
    assert!(
        literal.contains("owner_identity:me"),
        "m22s4 [X9/row-owner]: the owner column must be the BOUND SUBJECT. Writing any other \
         identity files the caller's whole personal-data dump under someone else's owner-scoped \
         view — which is the one place it becomes readable by the wrong person."
    );
    assert!(
        body.contains(".len()asu32"),
        "m22s4 [X9/row-total]: the request-wide total must be derived from the PLAN LENGTH. A \
         per-table total makes the client's documented wait rule (collected chunks equals \
         total_chunks) unimplementable, because the client cannot know how many tables to expect."
    );
}

// ===========================================================================
// X10 — the owner-scoped view IS the whole client read path.
// ===========================================================================

/// X10: the view is declared exactly once, with the sanctioned attribute, the
/// one-parameter signature, and a body pinned by EQUALITY.
///
/// EQUALITY, not containment, and the reason is measured elsewhere in this
/// module and in the two shipped view precedents: a containment check is passed
/// by a decoy — a discarded binding that filters on the caller, followed by the
/// real expression filtering on something else. The table is private, so this
/// body is the entire boundary between one subject's personal-data dump and
/// every connected client.
///
/// The pin is proven SATISFIABLE by m22s4_view_pin_positive_control, which
/// derives these exact literals from whitespace-bearing source through the LIVE
/// strip pipeline. An unsatisfiable pin reads exactly like a missing
/// implementation and sends the next reader to reverse-engineer the test.
///
/// Kills: an added parameter (a caller-chosen-owner leak, same severity as the
///        reducer signature clause);
///        a decoy filter followed by a different one;
///        a whole-table read;
///        an attribute pointing at a different accessor;
///        a second view declaration in the module.
#[test]
fn m22s4_view_declared_once_attr_sig_body_exact() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let attr = m22s4_view_attr_pin();
    let fn_needle = m22s4_nd_view_fn();

    assert_eq!(
        rb22p_count(&squashed, &attr),
        1,
        "m22s4 [X10/attr]: privacy.rs must carry EXACTLY the sanctioned view attribute, exactly \
         once. The accessor name is the client-visible read path and the public keyword is a \
         mandatory, inert token; a different accessor name silently ships a differently-named \
         binding the client half of this contract does not know about."
    );
    assert_eq!(
        rb22p_count(&squashed, &fn_needle),
        1,
        "m22s4 [X10/decl-count]: the view function must be declared exactly once."
    );
    assert_eq!(
        rb22p_count(&squashed, &format!("{attr}{fn_needle}")),
        1,
        "m22s4 [X10/attr-adjacency]: the attribute must sit IMMEDIATELY above the view function. \
         Counting the attribute and the function separately is satisfied by an attribute attached \
         to something else entirely."
    );

    let sig = extract_squashed_fn_sig(&squashed, &fn_needle)
        .unwrap_or_else(|| panic!("m22s4 [X10/sig]: `{fn_needle}` has no opening brace."));
    assert_eq!(
        sig,
        m22s4_view_sig_pin(),
        "m22s4 [X10/sig]: the view signature is not the frozen one. A view in this toolchain \
         accepts extra arguments, so an added owner parameter is a caller-chosen-owner read of \
         every subject's export bundle — the exact attack the two shipped owner-scoped view \
         precedents pin their signatures against."
    );

    let body = extract_squashed_fn_body(&squashed, &fn_needle)
        .unwrap_or_else(|| panic!("m22s4 [X10/scope]: `{fn_needle}` body is not brace-balanced."));
    let accepted = [m22s4_view_body_pin(), m22s4_view_body_pin_borrowed()];
    assert!(
        accepted.iter().any(|pin| pin == body),
        "m22s4 [X10/body]: the view body must be EXACTLY the sender-keyed owner index filter \
         (either the value or the borrow spelling of the key). Containment is not enough: a \
         discarded decoy binding that filters on the caller, followed by the real expression \
         filtering on something else, compiles clean, is clippy-clean and satisfies every \
         presence check. Read: {body:?}"
    );
}

/// X10 (the positive control): the three view pins are SATISFIABLE.
///
/// The same device the module's existing machinery control uses: build the
/// sanctioned declaration and body as whitespace-bearing SOURCE text,
/// independently spelled from the squashed pins, run it through the LIVE strip
/// pipeline, and require it to reproduce the pins byte for byte. Without this, a
/// hand-typed squashed literal with one character wrong is an UNSATISFIABLE
/// gate that reads exactly like a missing implementation.
///
/// The blindness half is also re-proved on this slice's own needles: the same
/// text placed only inside a line comment and inside a string literal must be
/// INVISIBLE to the pipeline, or every containment clause in this block would
/// be satisfiable by prose.
///
/// Kills: a typo in any of the three pinned literals;
///        a strip pipeline that stopped blanking comments or strings (which
///        would make every ban clause in this block satisfiable by a doc
///        comment naming the right chain).
#[test]
fn m22s4_view_pin_positive_control() {
    let source = format!(
        "{}{}{}{}",
        m22s4_view_decl_source(),
        '{',
        m22s4_view_body_source(),
        '}'
    );
    let stripped = stripped_for_scan(&source);
    let fn_needle = m22s4_nd_view_fn();

    assert_eq!(
        rb22p_count(&stripped, &m22s4_view_attr_pin()),
        1,
        "m22s4 [X10/control-attr]: the ATTRIBUTE pin is unsatisfiable — the live pipeline derives \
         something else from the sanctioned declaration text. Fix the literal from the spec, \
         never the other way round."
    );
    assert_eq!(
        rb22p_count(
            &stripped,
            &format!("{}{}", m22s4_view_attr_pin(), fn_needle)
        ),
        1,
        "m22s4 [X10/control-adjacency]: the ADJACENCY pin is unsatisfiable against the sanctioned \
         declaration text."
    );

    let sig = extract_squashed_fn_sig(&stripped, &fn_needle)
        .expect("m22s4 [X10/control]: the control fixture has no signature");
    assert_eq!(
        sig,
        m22s4_view_sig_pin(),
        "m22s4 [X10/control-sig]: the SIGNATURE pin is unsatisfiable."
    );

    let body = extract_squashed_fn_body(&stripped, &fn_needle)
        .expect("m22s4 [X10/control]: the control fixture has no body");
    assert_eq!(
        body,
        m22s4_view_body_pin(),
        "m22s4 [X10/control-body]: the BODY pin is unsatisfiable — the live pipeline derives \
         something else from the sanctioned body text. An unsatisfiable equality pin is \
         indistinguishable from a missing implementation and sends the next reader to \
         reverse-engineer the test instead of the spec."
    );

    // The borrow twin must ALSO be reachable, or the accepted set is a lie.
    let borrowed_source = m22s4_view_body_source().replace(".filter(", ".filter(&");
    let borrowed = stripped_for_scan(&format!(
        "{}{}{}{}",
        m22s4_view_decl_source(),
        '{',
        borrowed_source,
        '}'
    ));
    let borrowed_body = extract_squashed_fn_body(&borrowed, &fn_needle)
        .expect("m22s4 [X10/control]: the borrow-twin fixture has no body");
    assert_eq!(
        borrowed_body,
        m22s4_view_body_pin_borrowed(),
        "m22s4 [X10/control-borrow]: the accepted BORROW twin is unsatisfiable, so the two-element \
         accepted set in the pin above is really a one-element set advertised as two."
    );

    // Blindness: the same text as prose must contribute nothing.
    let mut prose = String::new();
    prose.push_str("fn m22s4_decoy() ");
    prose.push('{');
    prose.push_str("\n    ");
    prose.push_str(concat!("/", "/ "));
    prose.push_str(&m22s4_view_body_pin());
    prose.push_str("\n    let s = ");
    prose.push(rb22p_dq());
    prose.push_str(&m22s4_view_body_pin());
    prose.push(rb22p_dq());
    prose.push_str(";\n");
    prose.push('}');
    prose.push('\n');
    assert!(
        prose.contains(&m22s4_view_body_pin()),
        "m22s4 [X10/control-blind-vacuity]: the blindness fixture does not actually carry the \
         needle, so the assertion below would prove nothing."
    );
    let stripped_prose = stripped_for_scan(&prose);
    assert_eq!(
        rb22p_count(&stripped_prose, &m22s4_view_body_pin()),
        0,
        "m22s4 [X10/control-blind]: the strip pipeline still sees the sanctioned body after it \
         was placed ONLY inside a line comment and inside a string literal. Every containment and \
         equality clause in this block would then be satisfiable by PROSE. Stripped: \
         {stripped_prose:?}"
    );
}

// ===========================================================================
// X11 — the compensating pin for the crate-wide naming budget widening.
// ===========================================================================

/// X11: privacy.rs names the purge helper EXACTLY twice — once as its own
/// declaration and once as the reducer's call — and both namings are pinned.
///
/// This test is the price of a security widening. The crate-wide naming census
/// allows this module ONE naming (its own declaration) precisely because a
/// SECOND naming is how a wrapper hands a different owner to a body whose
/// frozen-body pin still reports it as correct. This slice must raise that
/// budget to two, so the second naming has to be pinned HERE by shape,
/// position and argument — otherwise raising the budget is a NET LOOSENING and
/// the census stops meaning anything for this file.
///
/// Kills: a third naming of any kind, including an aliasing import;
///        a wrapper function that re-exports the helper under another name;
///        a call spelled with any argument other than the reducer's bound
///        subject;
///        a call moved out of the reducer, or nested inside a conditional;
///        the declaration losing its crate visibility.
#[test]
fn m22s4_purge_named_twice_declaration_and_call() {
    let squashed = stripped_for_scan(PRIVACY_RS);
    let token = m22s4_purge_token();
    let call = m22s4_purge_call_pin();

    let total = rb22p_count(&squashed, &token);
    assert_eq!(
        total, 2,
        "m22s4 [X11/census]: privacy.rs names the purge helper {total} time(s); exactly TWO are \
         sanctioned — the declaration and the one reducer call site. The crate-wide census \
         budget for this file is raised to two by this slice, and this clause is the \
         compensating pin: without it, raising that budget is a net loosening that admits a \
         wrapper or a re-export handing a different owner to a body the frozen-body pin still \
         reports as correct. The count is over the BARE token with no word boundaries, so an \
         aliasing import counts as a naming too."
    );

    let decl = format!("pub(crate)fn{token}(");
    assert_eq!(
        rb22p_count(&squashed, &decl),
        1,
        "m22s4 [X11/decl]: the first naming must be the helper's own crate-visible declaration. \
         Private makes the existing cross-module call site unresolvable; a bare public keyword \
         widens the crate's external surface for nothing."
    );

    assert_eq!(
        rb22p_count(&squashed, &call),
        1,
        "m22s4 [X11/call-spelling]: the second naming must be EXACTLY the sanctioned call \
         `{call}` — the bound subject as its owner, as a bare statement. A one-token argument \
         swap here deletes nothing (or deletes the wrong owner's chunks) while every count, \
         region and ordering clause stays green."
    );

    let body = m22s4_reducer_body(&squashed);
    assert_eq!(
        rb22p_count(&body, &call),
        1,
        "m22s4 [X11/call-scope]: the call must sit INSIDE the export reducer. A call anywhere \
         else in the module is a second erasure path outside the ceremony this slice reviewed."
    );
    let at = m22s4_idx(&body, &call, "the purge call inside the reducer");
    assert_eq!(
        m22s4_brace_depth_at(&body, at),
        0,
        "m22s4 [X11/call-depth]: the call must be a top-level statement of the reducer body. A \
         conditional purge is a conditional purge-before-write, and the condition can be \
         always-false at that point while every count clause stays green."
    );
}

// The three UFCS write-verb tokens, assembled from concat! fragments so this
// file never spells one contiguously (matching the rb22p needle discipline).
fn m22s4_ufcs_write_needles() -> [String; 3] {
    [
        concat!("::ins", "ert(").to_string(),
        concat!("::upd", "ate(").to_string(),
        concat!("::del", "ete(").to_string(),
    ]
}

/// X11 (compensating-pin completeness): privacy.rs contains ZERO UFCS-form write
/// verbs.
///
/// MEASURED (m22-s4 artifact red-team, Finding 1). rb22p_writes_only_export_bundle
/// attributes writes by scanning for the DOTTED verbs `.insert(` / `.update(` /
/// `.delete(` and walking back to the nearest `ctx.db.`. UFCS call syntax puts
/// the verb FIRST — `UniqueColumn::update(&ctx.db.profile().identity(), row)` —
/// so the verb token is `::update(`, which the dotted needle never matches and
/// the accessor sits in an ARGUMENT rather than a same-statement chain. A red-team
/// PoC landed exactly this in a `rows_` reader and observed it compile, pass
/// clippy `-D warnings`, and leave the whole crate suite AND both widened evals
/// (currency-integrity, ranking-security) green while mass-corrupting the ranked
/// ladder from inside request_data_export. Those two eval allowlist widenings
/// explicitly delegate the write direction to the Rust write census, so without
/// this clause the widenings are a net loosening.
///
/// The ban is TOTAL rather than target-attributed: every legitimate write in this
/// delete-and-insert module is dotted off `ctx.db.export_bundle()`, so a UFCS
/// write verb has no honest use here, and a UFCS call CANNOT avoid spelling
/// `::<verb>(` — so banning the three tokens outright closes the inline form, the
/// bound-table-handle form and the fully-path-qualified form in one assertion.
/// This is the privacy.rs-scoped Rust twin of `C1A_UFCS_NEEDLES`
/// (evals/ranking-security.eval.mjs), which hardened ranking.rs against the same
/// shape. Mirrors that eval's needle direction rather than re-deriving it.
#[test]
fn m22s4_no_ufcs_write_verb_in_privacy() {
    let squashed = stripped_for_scan(PRIVACY_RS);

    // Non-vacuity control: the detector must actually FIND a UFCS verb when one is
    // present, so a broken needle cannot let the zero-count assertions below pass
    // over a scanner that sees nothing.
    let probe = m22s4_ufcs_write_needles();
    let mut fixture = String::new();
    fixture.push_str("spacetimedb::table::UniqueColumn");
    fixture.push_str(&probe[1]);
    fixture.push_str("&ctx.db.profile().identity(),row);");
    let fixture_squashed = stripped_for_scan(&fixture);
    assert!(
        rb22p_count(&fixture_squashed, &probe[1]) >= 1,
        "m22s4 [X11/ufcs-vacuity]: the UFCS control fixture does not contain the `::update(` \
         token after stripping, so the zero-count assertions below would prove nothing. Stripped \
         fixture: {fixture_squashed:?}"
    );

    for needle in m22s4_ufcs_write_needles() {
        let n = rb22p_count(&squashed, &needle);
        assert_eq!(
            n, 0,
            "m22s4 [X11/ufcs-write]: privacy.rs spells the UFCS write verb `{needle}` {n} time(s); \
             exactly zero is allowed. UFCS call syntax (verb before accessor) is invisible to the \
             dotted-verb write census that rb22p_writes_only_export_bundle uses AND that the two \
             widened security evals delegate the write direction to, so a UFCS write to any table \
             from inside a `rows_` reader would corrupt foreign rows on every export call while \
             every gate stayed green (measured red-team Finding 1). Every legitimate write in \
             this module is dotted off `ctx.db.export_bundle()`; a UFCS write verb has no honest \
             use here."
        );
    }
}

// ===========================================================================
// NATIVE-LINK STUBS (test infrastructure, NOT assertions — implementer-added
// and disclosed in the PR). The m22s4 registry tests read super::EXPORTERS at
// runtime, and materializing its fn pointers makes every rows_ reader live in
// the NATIVE test binary — so the linker now demands the SpacetimeDB host
// syscalls, which exist only inside the wasm host. These no_mangle stubs
// satisfy the linker; none is ever CALLED (ReducerContext is not constructible
// off-instance, ADR-0225 D5), and each aborts the process if that ever stops
// being true. Signatures mirror spacetimedb-bindings-sys 2.8.1 raw externs.
// ===========================================================================

#[no_mangle]
extern "C" fn table_id_from_name(_name: *const u8, _name_len: usize, _out: *mut u32) -> u16 {
    std::process::abort()
}

#[no_mangle]
extern "C" fn index_id_from_name(_name_ptr: *const u8, _name_len: usize, _out: *mut u32) -> u16 {
    std::process::abort()
}

#[no_mangle]
extern "C" fn datastore_table_scan_bsatn(_table_id: u32, _out: *mut u32) -> u16 {
    std::process::abort()
}

#[no_mangle]
extern "C" fn datastore_index_scan_point_bsatn(
    _index_id: u32,
    _point_ptr: *const u8,
    _point_len: usize,
    _out: *mut u32,
) -> u16 {
    std::process::abort()
}

#[no_mangle]
extern "C" fn row_iter_bsatn_advance(
    _iter: u32,
    _buffer_ptr: *mut u8,
    _buffer_len_ptr: *mut usize,
) -> i16 {
    std::process::abort()
}

#[no_mangle]
extern "C" fn row_iter_bsatn_close(_iter: u32) -> u16 {
    std::process::abort()
}
