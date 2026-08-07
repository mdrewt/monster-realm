//! `movement` server-module gating tests — slice 11r-a / ADR-0166 D4.
//!
//! Source-guard pattern (house convention): read production source via
//! `include_str!`, strip comments AND string literals, squash whitespace, search
//! for **concat!-assembled** needles.  No needle is written verbatim in this
//! file, so the scan can never pass by matching the test's own text.
//!
//! EARS criterion covered:
//!   E3  `movement_tick`'s warp branch SHALL reject the warp for a character in an
//!       ongoing battle in EITHER role (side A *or* side B), by delegating to the
//!       ADR-0122 both-role SSOT `guards::is_in_ongoing_battle(ctx, identity)` and
//!       passing the **character's own player identity**.
//!
//! Why a source scan and not a behavioural test: `movement_tick` needs a live
//! `ReducerContext` and this crate has no reducer-executing harness
//! (`battle_tests.rs:2151-2153`).  The behavioural half of E3 is already owned by
//! `guards_tests.rs` (the SSOT predicate's own both-role/WILD_IDENTITY tests); the
//! residue a scan uniquely sees is **call-site adoption with the right argument**.
//!
//! Why no brace-matched block extractor (ADR-0166 "considered alternatives"): one
//! composite *adjacency* needle on the squashed body is both simpler and stronger
//! than co-occurrence inside an extracted block — it pins `.map(|p| … )` →
//! `is_in_ongoing_battle(ctx, p.identity)` → `.unwrap_or(true)` as one contiguous
//! expression, so the legitimate `player_identity()` at `movement.rs:254` (the
//! grass-encounter pre-check) stops being a hazard to design around.  Precedent:
//! `raising_tests.rs:883-914`.

// ---------------------------------------------------------------------------
// Source constant
// ---------------------------------------------------------------------------

const MOVEMENT_RS: &str = include_str!("movement.rs");

// ---------------------------------------------------------------------------
// Comment- AND string-stripping helper.
//
// A LOCAL copy on purpose: the sibling test modules each keep their own
// (`pvp_tests.rs:64`, `trading_tests.rs:457`, `taming_tests.rs:42`,
// `economy_tests.rs:936`).  A shared `scan_helpers` module would need a `lib.rs`
// edit, which is outside 11r-a's touch set — recorded as ADR-0166 residual R5.
//
// Removed bytes are replaced with spaces so byte offsets are preserved (the
// squash step drops them again anyway).
//
// STRING LITERALS ARE BLANKED TOO — this is load-bearing, not tidiness.  An
// earlier draft of this file stripped comments only, on the reasoning that every
// needle is code-shaped.  A red-team then defeated the whole file with three
// lines: a dead `let _decoy = r#"<the needle's squashed text>"#;` satisfied the
// contiguity needles, the exactly-once counts AND the index-ordering assertions
// at once, while the real guard was absent — all green, vulnerability live.
// Blanking literal CONTENT (delimiters included) makes that unrepresentable:
// the only place a needle can now live is executable code.
//
// Handled in one sequential pass, so a construct can never be re-scanned in the
// wrong state: block comments, line comments, `"…"` (with `\` escapes), `b"…"`,
// raw strings `r"…"` / `r#"…"#` / `r##"…"##` and their `br` forms, and char /
// byte-char literals (consumed ATOMICALLY — a char literal holding a double
// quote would otherwise open a phantom string and blank the rest of the file,
// which is also why `DQUOTE` below is a number).  Char literals are
// copied through rather than blanked: at most a few bytes, they cannot host a
// needle, and copying keeps a mis-detected lifetime tick harmless.
// `assert_stripper_preconditions` fails loudly on the two constructs this does
// NOT handle (see its doc comment).
// ---------------------------------------------------------------------------

/// The ASCII double-quote byte, spelled as a NUMBER on purpose.
///
/// Writing the obvious byte-char literal would put a bare, unpaired double-quote
/// CHARACTER into this file's source. The evals concatenate every `.rs` file in
/// this crate and run `stripRustStrings` over the result — a stripper with no
/// char-literal lexer — so that quote reads as opening a string literal and
/// inverts string/code polarity for everything after it. Measured cost of the
/// obvious spelling: `pub fn init(` in `lib.rs` was blanked and the zone-warp
/// eval's W5 check failed with "init not found". Same cross-file blast radius as
/// the block-comment opener warned about below. Every double-quote in this file
/// is now part of a balanced Rust string literal; keep it that way.
const DQUOTE: u8 = 0x22;

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// If a STRING literal starts at `i`, the index one past its closing delimiter.
///
/// Covers `"…"`, `b"…"`, and raw `r"…"` / `r#"…"#` / `r##"…"##` plus the `br`
/// forms. A `b` / `r` prefix only counts when it is not itself part of a longer
/// identifier, so `ctx.db` and `row` are never mistaken for literal openers.
fn string_literal_end(bytes: &[u8], i: usize) -> Option<usize> {
    let len = bytes.len();
    let first = bytes[i];
    if first != DQUOTE && first != b'r' && first != b'b' {
        return None;
    }
    let prev_is_ident = i > 0 && is_ident_byte(bytes[i - 1]);
    let mut p = i;
    if first == b'b' {
        if prev_is_ident || p + 1 >= len {
            return None;
        }
        if bytes[p + 1] != DQUOTE && bytes[p + 1] != b'r' {
            return None;
        }
        p += 1;
    } else if first == b'r' && prev_is_ident {
        return None;
    }
    if bytes[p] == b'r' {
        let mut hashes = 0usize;
        while p + 1 + hashes < len && bytes[p + 1 + hashes] == b'#' {
            hashes += 1;
        }
        if p + 1 + hashes >= len || bytes[p + 1 + hashes] != DQUOTE {
            return None;
        }
        let mut j = p + 2 + hashes;
        while j < len {
            if bytes[j] == DQUOTE {
                let mut k = 0usize;
                while k < hashes && j + 1 + k < len && bytes[j + 1 + k] == b'#' {
                    k += 1;
                }
                if k == hashes {
                    return Some(j + 1 + hashes);
                }
            }
            j += 1;
        }
        return Some(len);
    }
    let mut j = p + 1;
    while j < len {
        if bytes[j] == b'\\' {
            j += 2;
        } else if bytes[j] == DQUOTE {
            return Some(j + 1);
        } else {
            j += 1;
        }
    }
    Some(len)
}

/// If a CHAR (or byte-char) literal starts at `i`, the index one past it.
///
/// A `'` is only read as a literal when a closing `'` follows within four bytes;
/// otherwise it is a lifetime tick (`&'a str`) and is left alone. The point of
/// this branch is a char literal HOLDING a double quote: unconsumed, that quote
/// opens a phantom string literal and everything after it would be blanked.
fn char_literal_end(bytes: &[u8], i: usize) -> Option<usize> {
    let len = bytes.len();
    if bytes[i] != b'\'' {
        return None;
    }
    let escaped = i + 1 < len && bytes[i + 1] == b'\\';
    let first = if escaped { 3 } else { 2 };
    for k in first..=4 {
        if i + k < len && bytes[i + k] == b'\'' {
            return Some(i + k + 1);
        }
    }
    None
}

fn strip_comments_and_strings(src: &str) -> String {
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
        } else if let Some(end) = string_literal_end(bytes, i) {
            i = end;
        } else if let Some(end) = char_literal_end(bytes, i) {
            while i < end {
                out[i] = bytes[i];
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// Loud preconditions covering the two constructs the stripper deliberately does
/// NOT handle. A silent misalignment in a stripper is the worst possible failure
/// mode for a source-scan gate — it blanks the wrong bytes and every needle
/// below turns vacuous — so each one fails with an explicit message instead.
///
/// 1. **Raw strings with three or more hashes.** Depth 0/1/2 is handled; deeper
///    is rejected here rather than mis-parsed.
/// 2. **A surviving block-comment CLOSE marker in the stripped output.** This
///    stripper, like every sibling copy in the crate, treats block comments as
///    NON-nesting: it stops at the first close marker. Rust allows nesting, so a
///    nested block comment leaves the outer comment's tail exposed to the scan as
///    if it were executable code — a hiding place for needle text. Correctly
///    stripped source cannot contain a close marker (code cannot spell one, and
///    string literals are now blanked), so finding one proves that shape.
fn assert_stripper_preconditions(raw: &str, stripped: &str) {
    let deep_raw = ["r#", "##"].concat();
    assert!(
        !raw.contains(deep_raw.as_str()),
        "SCAN PRECONDITION: the scanned source contains a raw-string opener with \
         three or more hashes, which this file's byte-sequential stripper does not \
         handle — it would blank the wrong byte range and silently hollow out every \
         needle below. Extend the stripper's hash-depth handling before adding such \
         a literal to the scanned file."
    );
    let close_marker = ["*", "/"].concat();
    assert!(
        !stripped.contains(close_marker.as_str()),
        "SCAN PRECONDITION: a block-comment CLOSE marker survived stripping, which \
         means the scanned source contains a NESTED block comment. This stripper \
         stops at the FIRST close marker, so the outer comment's tail is handed to \
         the scan as if it were executable code — a place to hide needle text and \
         turn a red test green. Un-nest the comment, or extend the stripper with a \
         nesting depth counter."
    );
}

/// `movement.rs` with comments AND string literals blanked and ALL whitespace
/// squashed out, so a rustfmt line split can never cause a false RED and no
/// needle can be satisfied by inert text.
fn squashed_movement() -> String {
    let stripped = strip_comments_and_strings(MOVEMENT_RS);
    assert_stripper_preconditions(MOVEMENT_RS, &stripped);
    stripped.split_whitespace().collect()
}

/// The squashed warp branch: everything from `warp_at(` up to the
/// grass-encounter trigger `stepped_onto_grass(`.
///
/// Region-scoping (rather than whole-file counting) is what makes the
/// `player_identity()` and `ctx.sender` assertions below both TIGHT and stable:
/// the grass-encounter pre-check at `movement.rs:251-256` legitimately keeps its
/// own single-role `player_identity()` lookup (ADR-0166 residual R4, deliberately
/// out of scope for 11r-a), and three unrelated reducers above legitimately use
/// `ctx.sender`. A whole-file count would have to encode those as magic numbers
/// and would drift the moment anything else in the file changes.
///
/// Both tests in this file use it, so there is no dead code and no drift between
/// two hand-copied slices.
fn warp_region(squashed: &str) -> &str {
    let warp_marker = ["warp", "_at("].concat();
    let grass_marker = ["stepped_onto", "_grass("].concat();
    let start = squashed
        .find(warp_marker.as_str())
        .expect("movement_tests: `warp_at(` not found in movement.rs");
    let len = squashed[start..]
        .find(grass_marker.as_str())
        .expect("movement_tests: `stepped_onto_grass(` not found after `warp_at(`");
    &squashed[start..start + len]
}

// ---------------------------------------------------------------------------
// E3: the warp guard uses the both-role SSOT, with the CHARACTER's identity
//
// EARS E3: WHEN a character steps onto a warp tile WHILE that character's player
// is in an ongoing battle in EITHER role, the server SHALL NOT warp them.
//
// At HEAD (`movement.rs:209-222`) the guard is an inline
// `battle().player_identity().filter(p.identity)` scan — the **side-A role only**.
// A PvP side-B player (`opponent_identity`) walks straight through a warp tile
// mid-ranked-battle, changing zones while the battle row stays Ongoing.
// ---------------------------------------------------------------------------

/// **E3** (ADR-0166 D4) — `movement_tick`'s warp branch must ask the ADR-0122
/// both-role SSOT, and must ask it about **`p.identity`**.
///
/// Layers 1, 1b, 1c and 2 are RED at HEAD; layer 3 is an ANTI-EVASION fence that
/// is green today.  Layers 1b and 1c were added after a red-team EMPIRICALLY
/// built and ran a wrong implementation that passed the first draft's layers 1
/// and 2 while leaving the vulnerability fully live.  The pure ADR-0070
/// anti-regression fences moved into their own test
/// ([`movement_warp_guard_unwrap_or_true_is_preserved`]) so that they actually
/// run — behind layer 1 they could never be observed green.
///
/// 1. **The composite adjacency needle (RED at HEAD).**  The squashed body must
///    contain `.map(|p| is_in_ongoing_battle(ctx, p.identity)).unwrap_or(true)` as
///    ONE contiguous expression.  Presence-only (`body.contains("is_in_ongoing_battle(")`)
///    is not enough — it is satisfied by a call whose result is discarded while the
///    old single-role filter remains the effective condition.
///
///    **The `p.identity` argument is the load-bearing part.** `movement_tick` is
///    scheduler-only (`movement.rs:156`), so inside it `ctx.sender` is the
///    **module** identity, and `let me = ctx.sender;` opens nearly every other
///    reducer in this file — making `is_in_ongoing_battle(ctx, ctx.sender)` a
///    thoroughly plausible copy-paste.  It would make the guard *always false* and
///    warp EVERY player out of EVERY battle, PvE and PvP alike: strictly worse
///    than the bug being fixed.  A presence-only needle cannot see that; this one
///    does.
///
///    **1b (EV-3a) — the guard's VALUE must be the branch condition.**  Layer 1
///    proves the SSOT is *called*; nothing in it proves anything *consumes* the
///    result.  A red-team kept a textbook-perfect SSOT call, discarded it with
///    `let _ = skip_warp;`, and left a differently-spelled inline single-role
///    filter (`ctx.db.battle().iter().any(|b| b.player_identity == p.identity &&
///    ..)`) as the effective condition — passing layers 1 AND 2 with the
///    vulnerability fully live.  Requiring `.unwrap_or(true);if!skip_warp{` as one
///    contiguous needle closes it, and pins the ADR-0166 D4 `in_battle` →
///    `skip_warp` rename at the same time.
///
///    **1c (EV-3b) — `battle()` exactly once, file-wide.**  The
///    spelling-independent backstop to layer 2: any inline re-implementation of
///    the battle scan, in ANY spelling, must name the `battle()` table accessor.
///    HEAD has two (`:217` warp guard, `:253` grass pre-check); after the fix the
///    warp guard reaches the table through `guards::is_in_ongoing_battle` and only
///    the grass one remains.
///
/// 2. **`player_identity()` count == 0 in the warp branch (RED at HEAD).**
///    Scoped to `warp_at(` … `stepped_onto_grass(` rather than counted file-wide:
///    same teeth, but immune to unrelated edits and to the eventual fix of
///    ADR-0166 residual R4 (the grass-encounter pre-check at `:254` keeps its own
///    single-role lookup on purpose — out of scope for 11r-a).  A count of 1
///    alongside a passing layer 1 is the "belt-and-braces" shell that calls the
///    SSOT *and* keeps the old filter.
///
/// 3. **ANTI-EVASION (green today): no `ctx.sender` between `warp_at(` and
///    `stepped_onto_grass(`.**  A second, independent line of defence against the
///    module-identity mutant described in layer 1 — it also catches a
///    `let me = ctx.sender;` hoisted just above the guard and passed in under
///    another name.
///
/// RED state at HEAD: layer 1 fails (no `is_in_ongoing_battle` in `movement.rs`);
/// 1b fails (the local is named `in_battle`); 1c fails (`battle()` count is 2);
/// layer 2 fails (`player_identity()` count in the warp branch is 1, not 0).
///
/// HONEST LIMITS.
/// (a) Layers 1 and 1b pin exact spellings.  A semantically identical rewrite —
/// binding the identity to a local first, an `if let Some(p) = … else`, or
/// inverting the branch to `if skip_warp { } else { …warp… }` — would false-RED.
/// The required text is stated verbatim in each failure message and ADR-0166 D4
/// fixes it as the sanctioned shape; layer 1 additionally accepts the
/// expression-bodied and block-bodied closure forms and the bare, `guards::` and
/// `crate::guards::` path spellings.  This is a deliberate trade: adjacency is
/// the only property that distinguishes "the SSOT decides the branch" from "the
/// SSOT is called somewhere nearby", and the latter was empirically shipped past
/// the first draft of this test.
/// (b) Layer 1c is a whole-file count with a hand-derived number (2 at HEAD → 1
/// after the fix).  Unlike layer 2 it cannot be region-scoped, because its whole
/// point is to catch a re-implementation wherever it is put.  It is therefore the
/// one assertion here that an unrelated edit to `movement.rs` can disturb; when
/// it fires, check whether the new `battle()` use is legitimate before changing
/// the number.
#[test]
fn e3_warp_guard_uses_the_both_role_ssot_with_the_player_identity() {
    let squashed = squashed_movement();
    let region = warp_region(&squashed);

    // --- Layer 1: composite adjacency needle, argument pinned ----------------
    // Accepted spellings: bare / `guards::` / `crate::guards::` path, and an
    // expression-bodied or block-bodied closure. Everything else about the
    // expression is pinned adjacently.
    let ssot = ["is_in_ongoing", "_battle"].concat();
    let tail_expr = ["(ctx,p.identity)).unwrap_or(", "true)"].concat();
    let tail_block = ["(ctx,p.identity)}).unwrap_or(", "true)"].concat();
    let mut variants: Vec<String> = Vec::new();
    for path in ["", "guards::", "crate::guards::"] {
        variants.push([".map(|p|", path, ssot.as_str(), tail_expr.as_str()].concat());
        variants.push([".map(|p|{", path, ssot.as_str(), tail_block.as_str()].concat());
    }
    let found = variants.iter().any(|n| squashed.contains(n.as_str()));
    assert!(
        found,
        "TEETH (E3/D4 layer 1): `movement.rs` must contain the warp battle guard as ONE \
         contiguous expression — whitespace-squashed: \
         `.map(|p|is_in_ongoing_battle(ctx,p.identity)).unwrap_or(true)` (the \
         `guards::` / `crate::guards::` path spellings and a block-bodied closure are \
         also accepted). \
         Two things are pinned and both matter: (a) the call goes to the ADR-0122 \
         BOTH-ROLE SSOT `guards::is_in_ongoing_battle` — the inline \
         `battle().player_identity().filter(..)` at HEAD sees side A only, so a PvP \
         side-B player walks through a warp tile mid-ranked-battle; (b) the argument \
         is `p.identity` — the CHARACTER's player identity. `movement_tick` is \
         scheduler-only, so `ctx.sender` here is the MODULE identity: \
         `is_in_ongoing_battle(ctx, ctx.sender)` would make the guard always false \
         and warp every player out of every battle, PvE and PvP alike — strictly \
         worse than the bug being fixed. RED at HEAD: the SSOT is not called."
    );

    // --- Layer 1b (EV-3a): the guard's VALUE is the branch condition ---------
    // Layer 1 proves the SSOT is CALLED. It does not prove anything CONSUMES the
    // result. A red-team kept the call, wrote `let _ = skip_warp;`, and let a
    // differently-spelled inline single-role filter decide the branch — passing
    // layers 1 and 2 with the vulnerability fully live. Requiring the assignment
    // and its `if !` to be contiguous closes it, and pins the ADR-0166 D4
    // `in_battle` → `skip_warp` rename at the same time.
    let branch = [".unwrap_or(", "true);if!skip_warp{"].concat();
    assert!(
        squashed.contains(branch.as_str()),
        "TEETH (E3/D4 layer 1b): the squashed source must contain \
         `.unwrap_or(true);if!skip_warp{{` — i.e. the guard's value must be bound to \
         `skip_warp` and immediately negated as the warp branch's condition. \
         Layer 1 proves the SSOT is CALLED; only this proves its result DECIDES the \
         branch. A red-team kept a perfect SSOT call, discarded it (`let _ = \
         skip_warp;`), and left an inline single-role filter as the effective \
         condition — passing layers 1 and 2 with the bug fully live. \
         This also pins the ADR-0166 D4 rename: the local must be `skip_warp`, not \
         `in_battle`. The old name makes `unwrap_or(true)` read as a bug, which is \
         exactly how a future cleanup flips it to `false` and teleports NPCs out of \
         their home zones. RED at HEAD: the local is still named `in_battle`."
    );

    // --- Layer 1d (NEW-4): the guard gates the WRITE, not just the `continue` -
    // The most plausible real-implementer slip, and a red-team proved it passes
    // every other needle in this file: hoist the three warp writes OUT of the
    // branch, leaving only the bookkeeping inside.
    //
    //     let (to_zone, tx, ty) = (..);
    //     row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;   // <-- hoisted
    //     let skip_warp = ..map(|p| is_in_ongoing_battle(ctx, p.identity))
    //         .unwrap_or(true);
    //     if !skip_warp { row.move_queue.clear(); ..; continue; }
    //
    // Layers 1, 1b, 1c, 2, 3 and the fence all still pass verbatim — but when
    // `skip_warp` is TRUE the code simply falls out of the `if let` to the normal
    // one-write path at movement.rs:237, which PERSISTS the warped zone anyway.
    // Every player in a battle warps (PvE and PvP), and so does every NPC. Pure
    // statement ordering; nothing that looks at needles alone can see it.
    let guard_open = ["if!skip", "_warp{"].concat();
    let warp_write = ["if!skip_warp{row.", "zone_id=to_zone;"].concat();
    assert!(
        region.contains(warp_write.as_str()),
        "TEETH (E3/D4 layer 1d, NEW-4): the warp branch must contain \
         `if!skip_warp{{row.zone_id=to_zone;` as ONE contiguous squashed \
         expression — the zone write must be the FIRST statement INSIDE the \
         guarded block. If the writes are hoisted above the guard, a `skip_warp` \
         of true no longer prevents anything: control falls out of the `if let` to \
         the normal one-write path (movement.rs:237) and the warped zone is \
         persisted regardless, warping every battling player AND every NPC. Layers \
         1, 1b, 1c, 2 and 3 all pass on that shell — this is the only assertion \
         that sees it."
    );
    let zone_write = ["row.", "zone_id"].concat();
    let guard_at = region
        .find(guard_open.as_str())
        .expect("E3: `if!skip_warp{` not found in the warp branch");
    let n_pre_write = region[..guard_at].matches(zone_write.as_str()).count();
    assert_eq!(
        n_pre_write, 0,
        "TEETH (E3/D4 layer 1d, NEW-4): `row.zone_id` is written {n_pre_write} \
         time(s) BEFORE `if !skip_warp {{` in the warp branch; it must be written \
         only INSIDE the guarded block. The contiguous needle above is satisfied by \
         a shell that hoists the write AND repeats it inside the branch; this \
         assertion is what makes the hoist itself unrepresentable."
    );

    // --- Layer 1c (EV-3b): no inline battle scan survives, in ANY spelling ---
    let battle_accessor = ["battle", "()"].concat();
    let n_battle = squashed.matches(battle_accessor.as_str()).count();
    assert_eq!(
        n_battle, 1,
        "TEETH (E3/D4 layer 1c): `movement.rs` must contain the `ctx.db.battle()` \
         table accessor EXACTLY ONCE; found {n_battle}. The arithmetic: HEAD has two \
         — `:217` (the warp guard's inline single-role scan, which this slice \
         REPLACES with the guards.rs SSOT) and `:253` (the grass-encounter \
         pre-check, deliberately NOT touched here — ADR-0166 residual R4). After the \
         fix only the grass one remains, because the warp guard reaches the battle \
         table through `guards::is_in_ongoing_battle`. \
         This is the spelling-INDEPENDENT version of layer 2: it kills any inline \
         re-implementation regardless of whether it uses the `player_identity()` \
         btree accessor, `.iter().any(|b| b.player_identity == ..)`, or anything \
         else — all of them must name `battle()`. If a later slice legitimately \
         fixes R4, this number changes; update it DELIBERATELY."
    );
    // NEW-3: layer 1 accepts the BARE `is_in_ongoing_battle(..)` call spelling, so
    // a file-local shim of the same name would satisfy it while answering `false`
    // for everyone — and a shim never names `battle()`, so layer 1c misses it too.
    // Forbidding movement.rs from DEFINING the name closes it in one assertion,
    // and unlike an import check it stays correct for all three accepted path
    // spellings.
    let local_shim = ["fnis_in_ongoing", "_battle"].concat();
    let n_shim = squashed.matches(local_shim.as_str()).count();
    assert_eq!(
        n_shim, 0,
        "TEETH (E3/D4 layer 1c, NEW-3): `movement.rs` must not DEFINE \
         `is_in_ongoing_battle`; found {n_shim} definition(s). Layer 1 accepts the \
         bare call spelling, so a file-local shim \
         (`fn is_in_ongoing_battle(_: &ReducerContext, _: Identity) -> bool \
         {{ false }}`) satisfies it verbatim while shadowing the ADR-0122 SSOT and \
         answering `false` for every player — and because a shim never touches the \
         `battle()` table, layer 1c does not see it either. The guard must resolve \
         to `crate::guards::is_in_ongoing_battle` (guards.rs:264), whether reached \
         through the import at movement.rs:13 or a qualified path."
    );

    // --- Layer 2 (M3): the single-role filter is GONE from the warp branch ---
    // Scoped to the warp region rather than counted file-wide: same teeth, but
    // immune to unrelated edits and to residual R4's eventual fix.
    let accessor = ["player_", "identity()"].concat();
    let accessor_count = region.matches(accessor.as_str()).count();
    assert_eq!(
        accessor_count, 0,
        "TEETH (E3/D4 layer 2): the warp branch (`warp_at(` … \
         `stepped_onto_grass(`) must contain ZERO `{accessor}` btree accessors; \
         found {accessor_count} (HEAD has 1, at movement.rs:218). That accessor IS \
         the single-role filter: it matches only `battle.player_identity`, so a PvP \
         side-B player — whose row names them as `opponent_identity` — walks through \
         a warp tile mid-ranked-battle. A count of 1 alongside a passing layer 1 \
         means the old filter was left in place ALONGSIDE the SSOT call, which \
         layer 1's needle alone cannot see."
    );

    // --- Layer 3: ANTI-EVASION — no module identity in the warp region -------
    let sender_needle = ["ctx.", "sender"].concat();
    let sender_count = region.matches(sender_needle.as_str()).count();
    assert_eq!(
        sender_count, 0,
        "ANTI-EVASION (E3/D4 layer 3, green at HEAD): `ctx.sender` appears \
         {sender_count} time(s) between `warp_at(` and `stepped_onto_grass(`. \
         `movement_tick` is scheduler-only (`movement.rs:156` rejects any other \
         sender), so `ctx.sender` inside it is the MODULE identity and can never be a \
         player. Asking the battle guard about it returns false for everyone, warping \
         every player out of every battle. The warp guard must ask about the \
         character's own `p.identity`."
    );
}

/// **ADR-0070 / ADR-0166 D4 fence** — `.unwrap_or(true)` at the warp guard must
/// survive this slice verbatim, and `.unwrap_or(false)` must never appear there.
///
/// A pure ANTI-REGRESSION fence: **green at HEAD, green after the fix**, red only
/// if someone "corrects" the default. It is a separate `#[test]` on purpose —
/// folded into E3 it would sit behind layer 1, which panics at HEAD, so it could
/// never be observed passing and would prove nothing about the fix.
///
/// `unwrap_or(true)` means "this character has no `player` row ⇒ it is an NPC ⇒
/// **SKIP the warp**" (ADR-0070 home-zone policy). It does NOT mean "is in
/// battle" — which is exactly what the pre-slice local name `in_battle` implied,
/// and why ADR-0166 D4 renames it `skip_warp`. Flipping the default to `false`
/// treats every NPC as not-in-battle and teleports it through warp tiles,
/// stranding it in a zone it can never wander home from.
///
/// `npc_tests.rs:351-371` pins the same text from OUTSIDE this slice's touch set
/// and must stay green through the rename; this test is the local canary for it.
#[test]
fn movement_warp_guard_unwrap_or_true_is_preserved() {
    let squashed = squashed_movement();
    let region = warp_region(&squashed);

    let unwrap_true = [".unwrap_or(", "true)"].concat();
    assert!(
        region.contains(unwrap_true.as_str()),
        "ANTI-REGRESSION (ADR-0070 / E3-D4): `.unwrap_or(true)` must survive in the \
         warp branch verbatim. It means `no player row ⇒ an NPC ⇒ SKIP the warp`, \
         not `is in battle`. `npc_tests.rs:351-371` pins the same text from outside \
         this slice's touch set and would go red with it."
    );
    let unwrap_false = [".unwrap_or(", "false)"].concat();
    let false_count = region.matches(unwrap_false.as_str()).count();
    assert_eq!(
        false_count, 0,
        "ANTI-REGRESSION (ADR-0070 / E3-D4): found {false_count} occurrence(s) of \
         `.unwrap_or(false)` in the warp branch. Flipping the default treats every \
         NPC (no `player` row) as not-in-battle and teleports it through warp tiles, \
         stranding it in a zone it can never wander back from. This is the exact \
         'cleanup' the `in_battle` → `skip_warp` rename exists to prevent."
    );
}

// ===========================================================================
// 11r-c (ADR-0168) — the REAL server battle movement lock
//
// EARS criteria covered below:
//
//   E1  WHILE a character's player is in an ongoing battle in EITHER role, the
//       scheduled `movement_tick` SHALL NOT drain that character's move queue:
//       the character stays at its pre-lock tile across ticks (a FREEZE), its
//       queue survives intact, and its `action` normalises to `Idle`.
//
//   E2  WHEN a player calls `enqueue_move` or `set_move` WHILE they are in an
//       ongoing battle in EITHER role, THE SYSTEM SHALL reject the call with
//       `Err("cannot move during an ongoing battle")` — reject-not-clamp at the
//       trust boundary.
//
//   (anti-decision) `clear_queue` SHALL remain UNGUARDED — ADR-0168 D3.
//
// Same source-scan doctrine as E3 above (there is still no reducer-executing
// harness — ADR-0156 P7), but hardened one step further: a plan red-team
// EMPIRICALLY defeated every presence/adjacency needle drafted for this slice
//   * CRITICAL-1: a drain guard whose block simply FALLS THROUGH (no `continue;`)
//     — present, well-named, argument-correct, and completely inert.
//   * CRITICAL-2: an intake guard neutered by a nested condition
//     (`if is_in_ongoing_battle(..) { if seq == 0 { return Err(..) } }`).
// Both are unrepresentable against a FULL-BLOCK contiguous pin, so every needle
// in this section pins a whole block — reachability by construction, not by
// presence. That is a deliberate exact-shape trade; ADR-0168 D1/D2 sanction the
// exact text and every failure message below restates it verbatim.
// ===========================================================================

/// The squashed DRAIN region: from the empty-queue early-continue
/// (`move_queue.is_empty()`) up to the warp branch's `warp_at(`.
///
/// This is exactly the window ADR-0168 D1 places the drain guard in, and it is
/// disjoint from [`warp_region`] (which starts at `warp_at(`), so the 11r-a
/// fences and the 11r-c fences can never fight over the same bytes.
///
/// `.expect`s loudly rather than returning an empty region: a silently-missing
/// anchor would turn every assertion scoped to this region into a vacuous pass.
fn drain_region(squashed: &str) -> &str {
    let start_marker = ["move_queue.is", "_empty()"].concat();
    let end_marker = ["warp", "_at("].concat();
    let start = squashed
        .find(start_marker.as_str())
        .expect("movement_tests: `move_queue.is_empty()` not found in movement.rs");
    let len = squashed[start..]
        .find(end_marker.as_str())
        .expect("movement_tests: `warp_at(` not found after `move_queue.is_empty()`");
    &squashed[start..start + len]
}

/// The squashed source of ONE `pub fn` reducer in `movement.rs`: from its
/// `pubfn<name>(` marker up to the NEXT `pubfn` (or end of file).
///
/// Deliberately crude (no brace walk): every reducer in this file is `pub fn`
/// and they are laid out one after another, so "up to the next `pub fn`" is a
/// superset of the body and can only ever make an "is present" assertion
/// weaker, never a "must be absent" one. The hijack risk a crude extractor
/// carries — a decoy `pub fn enqueue_move(` planted earlier in the file so the
/// region lands somewhere harmless — is closed by the I0 uniqueness counts in
/// [`e2_intake_rejects_movement_intent_during_an_ongoing_battle`].
fn reducer_region<'a>(squashed: &'a str, fn_marker: &str) -> &'a str {
    let start = squashed
        .find(fn_marker)
        .expect("movement_tests: reducer marker not found in movement.rs");
    let rest_at = start + fn_marker.len();
    let next_fn = ["pub", "fn"].concat();
    let end = squashed[rest_at..]
        .find(next_fn.as_str())
        .map_or(squashed.len(), |off| rest_at + off);
    &squashed[start..end]
}

/// Does `region` contain ANY of the accepted `variants` of a needle?
///
/// Every needle in this section is accepted in several equivalent path spellings
/// (bare / `guards::` / `crate::guards::`) and, where a closure is involved, in
/// expression- and block-bodied form. This is the shared "any variant matches"
/// step, so the three call sites cannot drift apart.
fn contains_any(region: &str, variants: &[String]) -> bool {
    variants.iter().any(|v| region.contains(v.as_str()))
}

/// The three accepted path spellings (bare / `guards::` / `crate::guards::`) of
/// the ADR-0168 D2 intake-reject block, as the STRING-STRIPPED squash sees it.
///
/// The block's two string literals are blanked before matching, so the needle is
/// `…{lete=.to_string();log_reject(,ctx.sender,&e);returnErr(e);}`. That is a
/// deliberate trade made when string-blanking closed the decoy-literal hole: the
/// error MESSAGE and the reducer NAME in the log call are no longer pinned, which
/// makes this needle identical for `enqueue_move` and `set_move` — the per-reducer
/// REGIONS at the call sites are what prove each reducer carries its own guard.
/// Neither string is a security property: the message is a `raising.rs` idiom and
/// the log label only affects an observability line. Everything that DECIDES —
/// the SSOT call, its argument, the block's statements, and the `return Err` —
/// is code, and all of it is still pinned contiguously.
///
/// Assembled from fragments (house rule): no needle exists verbatim anywhere in
/// this file, so neither this scan nor any eval that concatenates every `.rs`
/// file under `server-module/src` into one blob can be satisfied by the test's
/// own text.
///
/// WARNING when editing any comment in this crate: a slash immediately followed
/// by an asterisk opens a block comment for the evals' REGEX comment-stripper,
/// which runs over the concatenated sources and swallows everything up to the
/// next closing marker — ACROSS FILE BOUNDARIES. Writing that sequence here
/// (e.g. as a glob) silently deletes a later file's reducers from the eval's
/// view and false-REDs an unrelated check. Never write it; say ".rs file under
/// <dir>" instead.
fn intake_reject_variants() -> Vec<String> {
    let ssot = ["is_in_ongoing", "_battle"].concat();
    let args = ["(ctx,ctx.", "sender){"].concat();
    let bind = ["lete=.to", "_string();"].concat();
    let log = ["log_re", "ject(,ctx.sender,&e);"].concat();
    let ret = ["return", "Err(e);}"].concat();
    let body = [bind.as_str(), log.as_str(), ret.as_str()].concat();
    let mut out = Vec::new();
    for path in ["", "guards::", "crate::guards::"] {
        let head = ["if", path, ssot.as_str()].concat();
        out.push([head.as_str(), args.as_str(), body.as_str()].concat());
    }
    out
}

/// **E1** (ADR-0168 D1) — `movement_tick` must FREEZE a character whose player is
/// in an ongoing battle: skip the drain entirely, leave the queue intact.
///
/// RED at HEAD — all three layers fail:
///   * L1: `movement.rs` has no drain guard at all (the only `is_in_ongoing_battle(`
///     in the file is the 11r-a warp guard, 20 lines further down).
///   * L2: `ifbattle_locked{` occurs 0 times (must be exactly 1).
///   * L3: there is no guard index to compare against `move_queue.remove(`.
///
/// 1. **L1 — the full-block mega-needle.** The squashed source must contain, as
///    ONE contiguous string:
///
///    ```text
///    letbattle_locked=ctx.db.player().entity_id().filter(id).next()
///        .map(|p|is_in_ongoing_battle(ctx,p.identity)).unwrap_or(false);
///    ifbattle_locked{ifrow.action!=ActionState::Idle{
///        row.action=ActionState::Idle;
///        ctx.db.character().entity_id().update(row);}continue;}
///    ```
///
///    Six variants are accepted: bare / `guards::` / `crate::guards::` path
///    spellings × expression-bodied and block-bodied closure. Everything else is
///    pinned, and every pinned part earns its place:
///
///    * **The whole lookup chain, not just the `.map(..)` tail.** Pinning
///      `ctx.db.player().entity_id().filter(id).next()` kills the WRONG-SOURCE
///      evasion: a guard that looks the player up by something that can never
///      match (`.filter(row.entity_id)` after `row` was moved, a `find(0)`, the
///      *warp* branch's hoisted local, `ctx.db.player().identity().find(..)` on a
///      module identity …) computes `None` → `unwrap_or(false)` → never locks,
///      while presenting a textbook-perfect SSOT call to any presence needle.
///      `.filter(id)` is exactly right because the loop variable `id` IS the
///      character's `entity_id` (movement.rs:184-185).
///    * **`p.identity`, never `ctx.sender`.** `movement_tick` is scheduler-only
///      (movement.rs:156), so `ctx.sender` inside it is the MODULE identity;
///      `is_in_ongoing_battle(ctx, ctx.sender)` is false for everyone and the
///      lock never fires — strictly worse than the bug, because it *looks* fixed.
///      (The sibling sentinel [`movement_drain_region_uses_no_module_identity`]
///      is the independent, spelling-free line of defence against this.)
///    * **`unwrap_or(false)` is a FACT here, not a policy.** "No `player` row ⇒
///      not a player ⇒ cannot appear in a `battle` row ⇒ not battle-locked."
///      This is NOT the warp guard's `unwrap_or(true)` fifteen lines below, which
///      encodes the ADR-0070 home-zone POLICY ("no player row ⇒ an NPC ⇒ skip the
///      warp"). Two opposing defaults in one function is intentional; do not
///      unify them. Failure direction: `true` here would freeze a hypothetical
///      queued NPC move forever, `false` degrades to today's behavior.
///    * **`if battle_locked {` — the value decides the branch.** Layer 1 of the
///      E3 test above exists because a red-team once kept a perfect SSOT call and
///      discarded it (`let _ = ..;`); binding and branching contiguously makes
///      that unrepresentable here too.
///    * **The block's CONTENTS.** Write-on-change `Idle` (an unconditional
///      `update` would churn the row ~5×/s per battling player and broadcast a
///      no-op to every subscriber), exactly ONE `update`, and — decisively —
///      NOTHING that touches `move_queue`. A "lock" that consumes the move it
///      refuses to apply silently deletes player input; a "lock" that pushes the
///      move back re-orders the queue. Both are killed by pinning the block whole.
///    * **`continue;` before the block's closing brace.** This is red-team
///      CRITICAL-1 and the single most important byte in the needle: a guard
///      block that merely normalises `action` and then FALLS THROUGH to
///      `move_queue.remove(0)` passes every presence, ordering, argument and
///      naming check ever drafted for this slice while the character walks
///      through the battle exactly as before.
///
/// 2. **L2 — `ifbattle_locked{` EXACTLY ONCE, file-wide.** L1 proves a correct
///    block EXISTS; it cannot prove there is not a SECOND one. The decoy pair —
///    a perfect guard sitting on an unreachable path (or after the drain) plus
///    the real, `continue`-less one before it — satisfies L1 and L3. Count at
///    HEAD: 0. Required after the fix: 1.
///
/// 3. **L3 — the guard precedes the drain.** `idx(ifbattle_locked{)` must be less
///    than `idx(move_queue.remove()`. A guard placed after the drain has already
///    consumed the move and (with `apply_move` already run) already moved the
///    character. `move_queue.remove(` is asserted unique first, so the index
///    comparison cannot be defeated by a second, later drain site.
///
/// HONEST LIMITS.
/// (a) L1 is an EXACT-SHAPE pin. A semantically identical rewrite — `if let
/// Some(p) = ..`, a `match`, an inverted `if !battle_locked { ..drain.. }`, or
/// hoisting the player row into a local — would false-RED even though it is
/// correct. That is the accepted price of reachability-by-construction: the two
/// mutants above were built and shown to pass every weaker formulation. ADR-0168
/// D1 fixes this text as THE sanctioned shape; a future slice that legitimately
/// needs a different shape must change the ADR and this needle together.
/// (b) This is a source scan, not an execution. It proves the guard is written
/// and reachable; the *semantics* of the lock (frozen tile, queue intact) are
/// proven behaviorally by the sim-harness's `battle_locked_character_does_not_advance`
/// / BL-2 / BL-3 in the same `just ci` run, and the SSOT predicate's own
/// both-role behavior by `guards_tests.rs`. Nothing here executes a reducer
/// (ADR-0156 P7) — do not call this an integration test.
/// (c) Comments are stripped but string literals are not, so a sufficiently
/// determined `log::info!("<the entire block>")` would satisfy L1. It would still
/// have to defeat L2's exact count and L3's ordering, and the eval layer
/// (zone-warp W6) scans the extracted function body independently.
#[test]
fn e1_drain_time_battle_lock_freezes_an_in_battle_character() {
    let squashed = squashed_movement();

    // --- L1: full-chain, full-block mega-needle -----------------------------
    let ssot = ["is_in_ongoing", "_battle"].concat();
    let head_expr = [
        "letbattle_locked=ctx.db.player()",
        ".entity_id().filter(id).next().map(|p|",
    ]
    .concat();
    let head_block = [head_expr.as_str(), "{"].concat();
    let mid_expr = ["(ctx,p.identity)).unwrap_or(", "false);"].concat();
    let mid_block = ["(ctx,p.identity)}).unwrap_or(", "false);"].concat();
    let tail = [
        "ifbattle_locked{ifrow.action!=ActionState::Idle{",
        "row.action=ActionState::Idle;ctx.db.character().entity_id().update(row);}continue;}",
    ]
    .concat();
    let mut variants: Vec<String> = Vec::new();
    for path in ["", "guards::", "crate::guards::"] {
        let expr_head = [head_expr.as_str(), path, ssot.as_str(), mid_expr.as_str()].concat();
        let block_head = [head_block.as_str(), path, ssot.as_str(), mid_block.as_str()].concat();
        variants.push([expr_head.as_str(), tail.as_str()].concat());
        variants.push([block_head.as_str(), tail.as_str()].concat());
    }
    let found = contains_any(&squashed, &variants);
    assert!(
        found,
        "TEETH (E1/ADR-0168 D1, layer 1): `movement.rs` must contain the drain-time \
         battle lock as ONE contiguous whitespace-squashed block, placed after the \
         empty-queue early-continue and before `move_queue.remove(0)`: \
         `letbattle_locked=ctx.db.player().entity_id().filter(id).next()\
         .map(|p|is_in_ongoing_battle(ctx,p.identity)).unwrap_or(false);\
         ifbattle_locked{{ifrow.action!=ActionState::Idle{{\
         row.action=ActionState::Idle;ctx.db.character().entity_id().update(row);}}\
         continue;}}` \
         (the `guards::` / `crate::guards::` path spellings and a block-bodied \
         closure are also accepted — six variants in all). \
         WHY EVERY PART IS PINNED: (1) the FULL lookup chain \
         `ctx.db.player().entity_id().filter(id).next()` — `id` is the loop \
         variable and IS the character's entity_id, so a guard that looks the \
         player up by anything else yields None -> unwrap_or(false) -> never \
         locks, while still showing a perfect SSOT call to a presence-only needle; \
         (2) the argument is `p.identity`, the CHARACTER's player identity — \
         `movement_tick` is scheduler-only, so `ctx.sender` here is the MODULE \
         identity and would make the guard always false (strictly worse than the \
         bug, because it looks fixed); (3) `.unwrap_or(false)` is a FACT (no \
         `player` row => not a player => can never appear in a `battle` row), NOT \
         the warp guard's ADR-0070 `.unwrap_or(true)` POLICY fifteen lines below \
         (no player row => an NPC => skip the warp). The two opposing defaults in \
         one function are deliberate — do NOT unify them; (4) `if battle_locked {{` \
         makes the guard's VALUE the branch condition (a discarded `let _ = ..` \
         cannot satisfy this); (5) the block's CONTENTS: write-on-change `Idle`, \
         exactly one `update`, and nothing that touches `move_queue` — a lock that \
         consumes the refused move silently deletes player input, and an \
         unconditional update churns the row ~5x/s per battling player to every \
         subscriber; (6) `continue;` before the closing brace — a guard block that \
         normalises `action` and then FALLS THROUGH to `move_queue.remove(0)` is \
         completely inert and passes every presence/naming/ordering check ever \
         drafted for this slice (red-team CRITICAL-1). \
         RED at HEAD: `movement.rs` has no drain guard — its only \
         `is_in_ongoing_battle(` call is the 11r-a warp guard, 20 lines lower. \
         HONEST LIMITS: this is an exact-shape pin (an `if let Some(p) = ..` or an \
         inverted branch would false-RED); ADR-0168 D1 sanctions this exact text \
         as the shape, and it is the only formulation that makes fall-through and \
         wrong-source evasions unrepresentable."
    );

    // --- L2: exactly ONE guard block, file-wide ------------------------------
    // Layer 1 proves a CORRECT block exists. It cannot prove there is not a
    // SECOND one: a decoy pair (a perfect but unreachable/after-the-drain guard,
    // plus the real `continue`-less one) satisfies L1 and L3 together.
    let guard_open = ["ifbattle", "_locked{"].concat();
    let n_guard = squashed.matches(guard_open.as_str()).count();
    assert_eq!(
        n_guard, 1,
        "TEETH (E1/ADR-0168 D1, layer 2): `movement.rs` must contain \
         `ifbattle_locked{{` EXACTLY ONCE (whitespace-squashed); found {n_guard}. \
         The arithmetic: 0 at HEAD (no drain guard exists) -> exactly 1 after the \
         fix (the single drain guard from D1). \
         Layer 1 proves a correct block EXISTS; only this count proves it is the \
         ONLY one. The evasion it kills: ship the real guard as a fall-through \
         block sited before the drain, and a second, textbook-perfect copy \
         somewhere unreachable (or after `move_queue.remove(0)`) — layer 1 matches \
         the decoy, layer 3 matches the real one, and the lock never fires. \
         Like the E3 test's layer 1c this is a hand-derived whole-file count: if a \
         later slice legitimately needs a second lock site, update this number \
         DELIBERATELY, after checking the new site is reachable."
    );

    // --- L3: the guard precedes the drain ------------------------------------
    let remove_marker = ["move_queue.", "remove("].concat();
    let n_remove = squashed.matches(remove_marker.as_str()).count();
    assert_eq!(
        n_remove, 1,
        "TEETH (E1/ADR-0168 D1, layer 3 precondition): `move_queue.remove(` must \
         appear EXACTLY ONCE in `movement.rs`; found {n_remove}. HEAD has exactly \
         one (movement.rs:195 — the single drain site). This is asserted BEFORE the \
         ordering comparison below because with two drain sites an `idx(guard) < \
         idx(first remove)` comparison is satisfiable while a SECOND, unguarded \
         drain runs later in the same loop iteration."
    );
    let guard_at = squashed
        .find(guard_open.as_str())
        .expect("E1 layer 3: `ifbattle_locked{` not found (layer 2 should have fired first)");
    let remove_at = squashed
        .find(remove_marker.as_str())
        .expect("E1 layer 3: `move_queue.remove(` not found in movement.rs");
    assert!(
        guard_at < remove_at,
        "TEETH (E1/ADR-0168 D1, layer 3): the drain guard must PRECEDE the drain — \
         `ifbattle_locked{{` is at squashed byte {guard_at} but \
         `move_queue.remove(` is at {remove_at}. A guard placed after the drain has \
         already consumed the queued input AND already run `apply_move` + \
         `apply_state`, so the character has moved: the lock would be a decorative \
         no-op (or, with a push-back 'fix', would silently re-order the queue). \
         ADR-0168 D1 places the guard after the empty-queue early-continue \
         (so idle characters pay zero probes) and before `move_queue.remove(0)`. \
         RED at HEAD: no guard exists."
    );
}

/// **E1 ANTI-EVASION sentinel** — no module identity anywhere in the drain region.
///
/// GREEN at HEAD and GREEN after the fix; RED only if someone reaches for
/// `ctx.sender` inside `movement_tick`'s drain path. A SEPARATE `#[test]` on
/// purpose: folded into `e1_drain_time_battle_lock_freezes_an_in_battle_character`
/// it would sit behind layer 1, which panics at HEAD, so it could never be
/// observed passing and would prove nothing (the same reasoning that split
/// [`movement_warp_guard_unwrap_or_true_is_preserved`] out of the E3 test).
///
/// WHY IT MATTERS: `movement_tick` is scheduler-only (`movement.rs:156` rejects
/// any other sender), so `ctx.sender` inside it is the MODULE identity — never a
/// player. `is_in_ongoing_battle(ctx, ctx.sender)` there is false for every
/// character on every tick: the lock never fires, yet the code reads as a
/// complete, correctly-named, SSOT-delegating guard. That is strictly worse than
/// today's missing check, because it retires the finding. And it is a thoroughly
/// plausible slip: `let me = ctx.sender;` opens nearly every other reducer in
/// this file, and the ADR-0168 D2 intake guards being added in the SAME slice use
/// `ctx.sender` legitimately (there the caller IS a player) — so the wrong line is
/// literally on screen while the drain guard is written.
///
/// This is the spelling-INDEPENDENT half of the E1 layer-1 argument: layer 1 pins
/// `p.identity` inside one exact expression, while this sees a `let me =
/// ctx.sender;` hoisted above the guard and passed in under any other name.
///
/// The region anchor's uniqueness is asserted first: a silently-missing or
/// duplicated `move_queue.is_empty()` would make the scoped count vacuous.
///
/// HONEST LIMIT: the region ends at `warp_at(`, so it deliberately does NOT cover
/// the warp branch — that half is already owned by the E3 test's layer 3, and the
/// two regions are disjoint by construction.
#[test]
fn movement_drain_region_uses_no_module_identity() {
    let squashed = squashed_movement();

    let anchor = ["move_queue.is", "_empty()"].concat();
    let n_anchor = squashed.matches(anchor.as_str()).count();
    assert_eq!(
        n_anchor, 1,
        "SENTINEL PRECONDITION (E1): `move_queue.is_empty()` must appear EXACTLY \
         ONCE in `movement.rs` (it is the drain region's opening anchor); found \
         {n_anchor}. With zero the region cannot be built at all; with two the \
         region below could silently shrink to a few harmless bytes and this \
         sentinel would pass vacuously. If the empty-queue arm is legitimately \
         restructured, re-derive the anchor — do not delete the assertion."
    );

    let region = drain_region(&squashed);
    let sender_needle = ["ctx.", "sender"].concat();
    let sender_count = region.matches(sender_needle.as_str()).count();
    assert_eq!(
        sender_count, 0,
        "ANTI-EVASION (E1/ADR-0168 D1, green at HEAD): `ctx.sender` appears \
         {sender_count} time(s) in the drain region (`move_queue.is_empty()` … \
         `warp_at(`), which must contain ZERO. `movement_tick` is scheduler-only \
         (movement.rs:156 rejects any other sender), so `ctx.sender` inside it is \
         the MODULE identity and can never be a player: a drain guard asking \
         `is_in_ongoing_battle(ctx, ctx.sender)` is false for every character on \
         every tick — the lock never fires, while the code reads as a complete, \
         well-named, SSOT-delegating guard. That is strictly WORSE than the bug it \
         claims to fix, because it retires the finding. The drain guard must ask \
         about the character's own `p.identity` (E1 layer 1 pins the expression; \
         this catches a `let me = ctx.sender;` hoisted above it and passed under \
         another name). NOTE: the intake guards added by the same slice \
         (`enqueue_move` / `set_move`) DO use `ctx.sender` and that is correct — \
         those are player-called reducers, and they live outside this region."
    );
}

/// **E1 ANTI-EVASION sentinel (loop-variable shadow)** — `id` inside the drain
/// loop must stay the binding from `for id in ids`.
///
/// GREEN at HEAD and GREEN after the fix. A SIBLING of
/// [`movement_drain_region_uses_no_module_identity`] rather than another layer of
/// the E1 test, for the same reason: behind E1's layer 1 (which panics at HEAD)
/// it could never be observed passing.
///
/// THE ATTACK IT KILLS (red-team, empirically green against every other needle in
/// this file): insert ONE line just above the pinned guard —
///
/// ```text
/// let id = u64::MAX;
/// let battle_locked = ctx.db.player().entity_id().filter(id).next()… // unchanged
/// ```
///
/// The mega-needle still matches BYTE FOR BYTE — the shadowing `let` sits before
/// it, and `.filter(id)` still reads `id`. But `id` now names a sentinel that no
/// character's `entity_id` can equal, so the lookup always yields `None`,
/// `unwrap_or(false)` reports "not battle-locked", and the drain proceeds for
/// everyone. Same class as the module-identity mutant: the guard is textually
/// perfect and permanently false. Contiguity cannot see it, because the poison is
/// OUTSIDE the pinned span.
///
/// The fence is a region-scoped absence: between the loop header `for id in ids {`
/// and `warp_at(`, `id` may be READ but never re-bound. Four spellings are
/// forbidden (`let id =`, `let id:`, `let mut id =`, `let mut id:`), covering the
/// annotated and mutable variants. HEAD's real bindings in that span —
/// `let Some(mut row)`, `let input`, `let prev`, `let next`, `let entity_id` — none
/// match, and neither does the drain guard's own `let battle_locked`.
///
/// The loop-header anchor's uniqueness is asserted first: `movement.rs` has a
/// SECOND loop (`for entity_id in npc_entity_ids`), so a silently-moved anchor
/// would scope this to the wrong body.
///
/// HONEST LIMITS. (a) It fences the NAME, not the value: rebinding through a
/// different route (`let ids = vec![u64::MAX];` above the loop) is not seen here —
/// but that shape changes which characters are iterated at all and is visible to
/// the whole drain, not just the guard, so it is a different (and much louder)
/// defect class. (b) Region-scoped to before `warp_at(`: a shadow after the warp
/// branch cannot affect a guard that has already been evaluated.
#[test]
fn movement_drain_loop_variable_id_is_not_shadowed() {
    let squashed = squashed_movement();

    let loop_anchor = ["foridin", "ids{"].concat();
    let n_anchor = squashed.matches(loop_anchor.as_str()).count();
    assert_eq!(
        n_anchor, 1,
        "SENTINEL PRECONDITION (E1 shadow fence): `foridinids{{` must appear EXACTLY \
         ONCE in the squashed `movement.rs`; found {n_anchor}. It is the drain \
         loop's header (`for id in ids {{`) and the opening anchor of the region \
         scanned below. `movement.rs` also contains `for entity_id in \
         npc_entity_ids {{`, which deliberately does NOT match; if the drain loop is \
         renamed, re-derive this anchor rather than deleting the assertion — with \
         zero matches the region cannot be built and the fence would be vacuous."
    );

    let start = squashed
        .find(loop_anchor.as_str())
        .expect("movement_tests: `for id in ids {` not found in movement.rs");
    let warp_marker = ["warp", "_at("].concat();
    let len = squashed[start..]
        .find(warp_marker.as_str())
        .expect("movement_tests: `warp_at(` not found after the drain loop header");
    let region = &squashed[start..start + len];

    let shadows = [
        ["letid", "="].concat(),
        ["letid", ":"].concat(),
        ["letmutid", "="].concat(),
        ["letmutid", ":"].concat(),
    ];
    for shadow in &shadows {
        let n = region.matches(shadow.as_str()).count();
        assert_eq!(
            n, 0,
            "TEETH (E1/ADR-0168 D1, shadow fence — green at HEAD): found {n} \
             occurrence(s) of `{shadow}` between the drain loop header \
             (`for id in ids {{`) and `warp_at(`, which must contain ZERO. \
             `id` there must remain the LOOP BINDING — it is the character's own \
             `entity_id` (movement.rs:177-185), and the drain guard's \
             `ctx.db.player().entity_id().filter(id)` depends on that identity. \
             Re-binding `id` to anything else (`let id = u64::MAX;` is the \
             red-team's one-line version) leaves E1 layer 1's contiguous needle \
             matching BYTE FOR BYTE while the player lookup can never succeed: \
             `.next()` is always `None`, `unwrap_or(false)` always says \
             'not battle-locked', and every battling player walks. The poison sits \
             OUTSIDE the pinned span, so no contiguity needle can see it — only \
             this absence assertion can."
        );
    }
}

/// **E2** (ADR-0168 D2) — `enqueue_move` and `set_move` must reject movement
/// intent while the caller is in an ongoing battle, in either role.
///
/// RED at HEAD: neither reducer has any battle guard (I1/I2 fail; I3's count is 1,
/// not 4). I0 is a green precondition.
///
/// * **I0 — region-extractor integrity.** `pubfnenqueue_move(` and
///   `pubfnset_move(` must each occur EXACTLY once in the squashed file. The
///   crude "next `pub fn`" extractor used below is otherwise hijackable: plant a
///   decoy `pub fn enqueue_move(..)` earlier in the file, put the sanctioned
///   block in the decoy, and I1's region-scoped `contains` passes while the real
///   reducer stays open (red-team HIGH-3). Green at HEAD.
///
/// * **I1 / I2 — the full-block needle, per reducer.** The reducer's region must
///   contain, contiguously, squashed and string-blanked:
///   `ifis_in_ongoing_battle(ctx,ctx.sender){lete=.to_string();
///   log_reject(,ctx.sender,&e);returnErr(e);}`
///   (bare / `guards::` / `crate::guards::` path spellings accepted) — i.e. the
///   source must read `if is_in_ongoing_battle(ctx, ctx.sender) { let e = "cannot
///   move during an ongoing battle".to_string(); log_reject("<reducer>",
///   ctx.sender, &e); return Err(e); }`.
///
///   The two string literals are blanked by the scan, so I1 and I2 use the SAME
///   needle text and the per-reducer REGION is what proves each reducer carries
///   its own guard (I0 proves those regions are unambiguous). One guard written
///   in `enqueue_move` cannot satisfy I2, and vice versa.
///
///   The BLOCK is what has teeth. Red-team CRITICAL-2 shipped
///   `if is_in_ongoing_battle(ctx, ctx.sender) { if seq == 0 { return Err(..) } }`
///   past every presence and ordering needle drafted for this slice: correct
///   predicate, correct argument, correct position, and the reject fires for
///   essentially nobody. Pinning the block whole also kills log-without-return
///   (a guard that logs a rejection and then falls through and enqueues anyway).
///
///   `ctx.sender` is CORRECT here and only here — these are player-called
///   reducers, unlike the scheduler-only `movement_tick`.
///
///   No ordering assertion accompanies these needles, by design: placing the
///   guard before or after `authorize_move` is observationally identical, because
///   an `Err` rolls the whole SpacetimeDB transaction back including
///   `authorize_move`'s accept-time ack (`guards.rs:87-94`). ADR-0168 D2 sites it
///   first only to avoid doing the lookups and the ack write on a doomed call —
///   a preference, not a correctness property, so pinning it would be a fence
///   with no defect behind it.
///
/// * **I3 — `is_in_ongoing_battle(` EXACTLY 4× file-wide.** The arithmetic:
///   1 (11r-a warp guard) + 1 (D1 drain guard) + 1 (`enqueue_move`) +
///   1 (`set_move`) = 4. HEAD has 1, so this is RED. It is the wrapper-kill
///   (red-team HIGH-4): a differently-named local helper — say
///   `fn move_blocked(ctx, who) -> bool { is_in_ongoing_battle(ctx, who) }` —
///   re-introduces one EXTRA internal call, making 5, and trips this even though
///   every block needle above could be satisfied by the wrapper's own body.
///   Combined with the E3 test's NEW-3 fence (`movement.rs` must not DEFINE
///   `is_in_ongoing_battle`) and with `clear_queue_is_deliberately_not_battle_guarded`
///   (whose full-body pin means `clear_queue` cannot route through a wrapper
///   either), the indirection has nowhere to hide.
///   Like the E3 test's layer 1c, this is a hand-derived whole-file count: an
///   unrelated future edit that legitimately changes it must update the number
///   DELIBERATELY, after re-deriving the arithmetic.
///
/// HONEST LIMITS. (a) I1/I2 pin the exact sanctioned CODE shape; a semantically
/// identical rewrite (an early-return helper, a `match`) would false-RED. ADR-0168
/// D2 fixes the shape and the same trade was taken by 11r-a. (b) What is NO LONGER
/// pinned, since string literals are blanked before matching: the error message
/// text and the reducer name passed to `log_reject`. Neither is a security
/// property — the message is a `raising.rs` idiom ("cannot care during an ongoing
/// battle") and the label only affects one observability line — and the price
/// buys the far more valuable property that no dead string literal can satisfy
/// any needle in this file (a red-team defeated the whole file with a single
/// `let _decoy = r#"…"#;` before the stripper handled literals). (c) Source scan,
/// not execution — no reducer-executing harness exists (ADR-0156 P7).
#[test]
fn e2_intake_rejects_movement_intent_during_an_ongoing_battle() {
    let squashed = squashed_movement();

    // --- I0: the region extractor cannot be hijacked -------------------------
    let enqueue_name = ["enqueue", "_move"].concat();
    let set_name = ["set", "_move"].concat();
    let enqueue_marker = ["pubfn", enqueue_name.as_str(), "("].concat();
    let set_marker = ["pubfn", set_name.as_str(), "("].concat();

    let n_enqueue = squashed.matches(enqueue_marker.as_str()).count();
    assert_eq!(
        n_enqueue, 1,
        "TEETH (E2/ADR-0168 D2, I0): `pubfnenqueue_move(` must appear EXACTLY ONCE \
         in the squashed `movement.rs`; found {n_enqueue}. The region extractor \
         used by I1 takes the FIRST match up to the next `pub fn`, so a decoy \
         `pub fn enqueue_move(..)` planted earlier in the file (or a second, \
         differently-parameterised overload) would let the sanctioned guard block \
         live in the decoy while the real reducer stays wide open — I1 would pass \
         on the decoy's text (red-team HIGH-3). Green at HEAD; if this ever fires, \
         the extraction is ambiguous and every I1/I2 result below is untrustworthy."
    );
    let n_set = squashed.matches(set_marker.as_str()).count();
    assert_eq!(
        n_set, 1,
        "TEETH (E2/ADR-0168 D2, I0): `pubfnset_move(` must appear EXACTLY ONCE in \
         the squashed `movement.rs`; found {n_set}. Same reasoning as the \
         `enqueue_move` count above: an ambiguous region makes I2 vacuous."
    );

    // --- I1: enqueue_move's full-block reject --------------------------------
    // ONE needle set, TWO regions: string literals are blanked before matching,
    // so the reducer name in the log call is not part of the needle. What proves
    // each reducer has its OWN guard is that the needle is found inside each
    // reducer's own region (I0 above proves those regions are unambiguous).
    let variants = intake_reject_variants();
    let enqueue_region = reducer_region(&squashed, enqueue_marker.as_str());
    let enqueue_ok = contains_any(enqueue_region, &variants);
    assert!(
        enqueue_ok,
        "TEETH (E2/ADR-0168 D2, I1): `enqueue_move` must contain the intake reject \
         as ONE contiguous block. Whitespace-squashed AND string-literal-blanked \
         (which is how this scan sees the file), the required text is: \
         `ifis_in_ongoing_battle(ctx,ctx.sender){{lete=.to_string();\
         log_reject(,ctx.sender,&e);returnErr(e);}}` — i.e. the source must read \
         `if is_in_ongoing_battle(ctx, ctx.sender) {{ let e = \"cannot move during \
         an ongoing battle\".to_string(); log_reject(\"enqueue_move\", ctx.sender, \
         &e); return Err(e); }}` \
         (the `guards::` / `crate::guards::` path spellings are also accepted). \
         The BLOCK is the point, not the call: a red-team shipped \
         `if is_in_ongoing_battle(ctx, ctx.sender) {{ if seq == 0 {{ return \
         Err(..); }} }}` past every presence-and-ordering needle drafted for this \
         slice — correct predicate, correct argument, correct position, rejects \
         essentially nobody (red-team CRITICAL-2). The same pin kills \
         log-without-return (log the rejection, fall through, enqueue anyway) and \
         a swallowed `Err`. `ctx.sender` is CORRECT here — `enqueue_move` is \
         player-called (unlike the scheduler-only `movement_tick`, where the same \
         expression would be the module identity). Placement inside the reducer is \
         NOT asserted: an `Err` rolls the whole SpacetimeDB transaction back, ack \
         included (guards.rs:87-94), so before/after `authorize_move` is \
         observationally identical — ADR-0168 D2 sites it first purely to avoid \
         doing the lookups and the ack write on a doomed call. \
         RED at HEAD: `enqueue_move` has no battle guard of any kind."
    );

    // --- I2: set_move's full-block reject ------------------------------------
    let set_region = reducer_region(&squashed, set_marker.as_str());
    let set_ok = contains_any(set_region, &variants);
    assert!(
        set_ok,
        "TEETH (E2/ADR-0168 D2, I2): `set_move` must contain the same intake reject \
         block INSIDE ITS OWN BODY — squashed and string-blanked: \
         `ifis_in_ongoing_battle(ctx,ctx.sender){{lete=.to_string();\
         log_reject(,ctx.sender,&e);returnErr(e);}}`, written with `set_move`'s own \
         name in the log call (the name is blanked before matching, so it is I1/I2's \
         REGION scoping — not the needle text — that proves each reducer is guarded \
         separately; a single shared guard placed in one reducer fails the other). \
         `set_move` REPLACES the entire undrained queue, so it adds movement intent \
         exactly as `enqueue_move` does and must be guarded identically. It has no \
         production caller today (`main.wiring.test.ts` W-NH2-NO-CANCEL forbids one) \
         — but it is a public reducer and the client is hostile, which is precisely \
         why an unguarded `set_move` would be the cheapest bypass of a guarded \
         `enqueue_move`. The block (not the bare call) is pinned for the same \
         nested-condition reason as I1. \
         RED at HEAD: `set_move` has no battle guard."
    );

    // --- I3: wrapper-kill count ----------------------------------------------
    let ssot_call = ["is_in_ongoing", "_battle("].concat();
    let n_calls = squashed.matches(ssot_call.as_str()).count();
    assert_eq!(
        n_calls, 4,
        "TEETH (E2/ADR-0168 D2, I3): `is_in_ongoing_battle(` must appear EXACTLY \
         4 times in the squashed `movement.rs`; found {n_calls}. \
         THE ARITHMETIC: 1 (the 11r-a warp guard, movement.rs:223) \
         + 1 (the D1 drain-time lock) + 1 (`enqueue_move`) + 1 (`set_move`) = 4. \
         The `use crate::guards::{{..}}` import does not count — it has no `(`. \
         HEAD has 1, so this assertion is RED until all three new call sites exist. \
         WHAT IT KILLS (red-team HIGH-4): a differently-named local wrapper — \
         `fn move_blocked(ctx, who) -> bool {{ is_in_ongoing_battle(ctx, who) }}` — \
         adds one EXTRA internal call, making 5, and trips this even though the \
         block needles above could be satisfied by the wrapper's own body. The \
         wrapper matters because it is the invisible way to re-guard `clear_queue`, \
         which ADR-0168 D3 deliberately leaves UNGUARDED. \
         Like the E3 test's layer 1c this is a hand-derived whole-file count: if a \
         later slice legitimately adds or removes a call site, re-derive the \
         arithmetic and update this number DELIBERATELY — never to make a red \
         build green."
    );
}

/// **ADR-0168 D3 anti-decision sentinel** — `clear_queue` must stay UNGUARDED, and
/// its body must not change at all.
///
/// GREEN at HEAD and GREEN after the fix; RED the moment someone "completes the
/// symmetry". This is the load-bearing paragraph of the ADR rendered as a test:
/// without it, the next consistency-minded pass adds the missing symmetric guard
/// and ships a bug — the exact failure mode ADR-0166 D2 documented for
/// "or flee" / "or forfeit".
///
/// WHY `clear_queue` IS NOT GUARDED (ADR-0168 D3 — keep these three reasons with
/// the test; they are the whole justification for the asymmetry):
///   1. `clear_queue` is PURE CANCELLATION. It cannot cause movement and enables
///      no attack: the worst a hostile client achieves by calling it mid-battle is
///      emptying its own queue.
///   2. Rejecting it would force the stale pre-battle queue to SURVIVE until
///      battle end — turning the post-battle stale drain (a residual D1 merely
///      tolerates: ≤ MOVE_QUEUE_CAP = 2 moves draining after the battle) into a
///      GUARANTEED behavior. Strictly worse than not guarding.
///   3. It would deny an honest client's key-release cancel while the battle
///      overlay is opening — the one moment a real player is most likely to send
///      it.
///
/// WHAT THE FULL-BODY PIN KILLS. The needle is the whole body INCLUDING both
/// braces (`{` … `Ok(())}`), so it is anchored at both ends:
///   * a direct guard prepended before `let mut ch = ..` (a body-only `contains`
///     would still match — the guard would simply sit in front of the needle);
///   * a differently-named wrapper indirection — `authorize_move_checked(..)`,
///     `guarded_clear(..)` — which is how the guard gets re-introduced *without*
///     the word `battle` appearing anywhere near `clear_queue`;
///   * any other change to the body, deliberately: this reducer's exact shape is
///     an ADR-level decision, not an implementation detail.
///
/// Comment-stripping runs before the match, so the D3 rationale comment the
/// implementer is asked to add INSIDE the body cannot break this pin. String
/// literals are blanked too, so the `"clear_queue"` label handed to
/// `authorize_move` is no longer pinned (only the log line would change if it
/// were altered); the pin is anchored instead on the `pub fn clear_queue(`
/// marker, which is code and survives stripping. That trade is what makes a dead
/// `let _decoy = r#"…"#;` unable to satisfy any needle in this file.
///
/// HONEST LIMIT: pinning a whole body means a legitimate future change to
/// `clear_queue` (a new ack scheme, a rename of `authorize_move`) turns this red.
/// That is intended. When it fires, re-argue the three reasons above, change
/// ADR-0168 D3 if the answer really has changed, and update the pin
/// DELIBERATELY — never to make a red build green.
#[test]
fn clear_queue_is_deliberately_not_battle_guarded() {
    let squashed = squashed_movement();

    // Region-scoped, not whole-file: string literals are blanked before matching,
    // so the `"clear_queue"` label inside `authorize_move(..)` is no longer part
    // of the needle. Anchoring on the fn NAME — which is code and survives
    // stripping — is what still proves this body belongs to `clear_queue`.
    let marker = ["pubfnclear", "_queue("].concat();
    let n_marker = squashed.matches(marker.as_str()).count();
    assert_eq!(
        n_marker, 1,
        "ANTI-DECISION PRECONDITION (ADR-0168 D3): `pubfnclear_queue(` must appear \
         EXACTLY ONCE in the squashed `movement.rs`; found {n_marker}. With zero \
         the reducer was renamed or deleted — re-argue D3 before adjusting this \
         test. With two, the region extractor takes the first match and a decoy \
         could carry the pinned body while the real `clear_queue` is guarded."
    );
    let region = reducer_region(&squashed, marker.as_str());

    // Assembled from fragments (house rule): the full body never appears
    // verbatim in this file, so no scan over the concatenated server sources can
    // be satisfied by the test's own text.
    let body_pin = [
        "{letmutch=authorize_move(ctx,,seq)?;ch.move_queue.clear();",
        "ctx.db.character().entity_id().update(ch);Ok(())}",
    ]
    .concat();
    assert!(
        region.contains(body_pin.as_str()),
        "ANTI-DECISION SENTINEL (ADR-0168 D3, green at HEAD): `clear_queue`'s ENTIRE \
         body must remain, brace-to-brace — squashed and string-blanked (which is \
         how this scan sees the file): \
         `{{letmutch=authorize_move(ctx,,seq)?;ch.move_queue.clear();\
         ctx.db.character().entity_id().update(ch);Ok(())}}` — i.e. the source must \
         still read `let mut ch = authorize_move(ctx, \"clear_queue\", seq)?;` and \
         nothing else. \
         `clear_queue` is deliberately NOT battle-guarded, and this is the fence \
         that keeps it that way. THE THREE REASONS (ADR-0168 D3): \
         (1) it is PURE CANCELLATION — it cannot cause movement and enables no \
         attack; the worst a hostile client gains is emptying its own queue. \
         (2) Guarding it would force the stale pre-battle queue to SURVIVE to \
         battle end, turning the post-battle stale drain that D1 merely tolerates \
         (<= MOVE_QUEUE_CAP = 2 moves) into a GUARANTEED behavior — strictly worse. \
         (3) It would deny an honest key-release cancel exactly when the battle \
         overlay is opening. \
         The pin includes BOTH braces on purpose: a body-only needle would still \
         match with a battle guard prepended in front of it. It also kills the \
         differently-named wrapper indirection (`authorize_move_checked(..)`, \
         `guarded_clear(..)`) — the way this guard gets re-introduced without the \
         word `battle` appearing anywhere near `clear_queue`. \
         Comments are stripped before matching, so the D3 rationale comment inside \
         the body is safe. \
         HONEST LIMIT: the body may not change AT ALL. A legitimate future change \
         to `clear_queue` must re-argue the three reasons above, amend ADR-0168 D3 \
         if they no longer hold, and update this pin DELIBERATELY — never to turn a \
         red build green."
    );
}

// ===========================================================================
// 11r-g (ADR-0170 D4) — rate-limited, JSON-escaped wild-encounter failure logs
//
// EARS criteria covered below:
//
//   M-1  A fresh `RateLimiter`'s first `check` SHALL emit, reporting zero
//        suppressed events.
//   M-2  WHILE inside the window a `check` SHALL suppress (return `None`) and
//        count; the next emit SHALL report the EXACT suppressed count and then
//        reset it to zero.
//   M-3  The window boundary SHALL be INCLUSIVE: `elapsed == window` emits,
//        `elapsed == window - 1` suppresses.
//   M-4  WHEN the injected clock goes BACKWARDS the limiter SHALL emit and
//        re-anchor to the new (earlier) instant rather than suppress forever.
//   M-5  For extreme operands (`i64::MIN`, `i64::MAX`) `check` SHALL NOT panic.
//        This workspace ships `overflow-checks = true`, so a bare subtraction
//        would PANIC the zone tick in production — the exact failure this
//        feature exists to surface.
//   M-6  `movement_tick` SHALL pass every interpolated error reason through
//        `json_escape`, including the two pre-existing `movement_tick_error`
//        sites (ADR-0170 D4 last bullet).
//   M-7  The two swallow sites in the grass-encounter block SHALL become logged
//        no-ops, each gated by its OWN process-static limiter — a spammy
//        bad-content zone must not mask `begin_encounter` failures (one of
//        `begin_encounter`'s Err paths, "party has no conscious monster", is
//        ROUTINE gameplay and can burst).
//
// RED STATE.
//   * M-1..M-5 are COMPILE-RED: `RateLimiter` does not exist in `movement.rs`,
//     so `use super::RateLimiter;` cannot resolve and the crate does not build
//     (the house precedent for a new seam — `content_cache_tests.rs:14-25`).
//   * M-6 / M-7 and the RateLimiter source-scan are ASSERTION-RED once the type
//     exists: HEAD has zero limiter statics, zero `json_escape` calls and two
//     (not four) `log::error!` sites inside `movement_tick`, and it still spells
//     both swallow sites as `let _ = begin_encounter(..)` and a bare
//     `let Ok(table) = .. else` binding.
//   * `movement_tick_grass_block_never_aborts_the_tick` is a GREEN-AT-HEAD
//     fence, a separate `#[test]` for the reason recorded at line ~917: behind a
//     failing assertion it could never be observed passing.
//
// Same source-scan doctrine as the sections above (no reducer-executing
// harness, ADR-0156 P7), with one addition: the two new `evt` names live inside
// STRING literals, which `squashed_movement()` deliberately blanks. Those two
// needles therefore run against a comments-only view
// ([`squashed_movement_keeping_strings`]) while every needle with teeth — the
// limiter statics, their `.check(` calls, `json_escape(`, and the two negative
// needles — runs against the string-blanked view where only executable code
// survives.
// ===========================================================================

use super::RateLimiter;

/// The window every `RateLimiter` unit test below uses. Production picks 5000 ms
/// (ADR-0170 D4); the tests pass it explicitly so they pin the SEMANTICS of the
/// parameter rather than a constant that a later tuning slice may legitimately
/// change.
const TEST_WINDOW_MS: i64 = 5_000;

/// `movement.rs` with comments blanked, string literals KEPT, and whitespace
/// squashed.
///
/// The complement of [`squashed_movement`], and used for exactly one thing: the
/// two new `evt` names are string-literal CONTENT, so the string-blanking view
/// cannot see them. Comments are still stripped, so a comment naming the evt
/// cannot satisfy the needle.
///
/// This view is deliberately NOT used for any needle that decides whether the
/// feature works — a dead `let _decoy = "…";` could satisfy it (the red-team hole
/// documented at line ~45). The structural needles all stay on the blanked view.
fn squashed_movement_keeping_strings() -> String {
    let bytes = MOVEMENT_RS.as_bytes();
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
    let stripped = String::from_utf8(out).expect("stripped source must be valid UTF-8");
    stripped.split_whitespace().collect()
}

/// The brace-matched body that follows `marker` in `squashed`.
///
/// Scans forward from `marker` to the first `{`, then counts braces to the
/// matching `}`. Safe on the STRING-BLANKED squash only: string literals are
/// blanked there, so a brace inside a log format string cannot corrupt the count
/// (`movement.rs` contains no char literals, the one other construct this file's
/// stripper copies through).
///
/// `.expect`s loudly rather than returning an empty slice: a silently-missing
/// anchor would turn every assertion scoped to the region into a vacuous pass.
fn brace_body<'a>(squashed: &'a str, marker: &str) -> &'a str {
    let start = squashed
        .find(marker)
        .expect("movement_tests: brace-region marker not found in movement.rs");
    let bytes = squashed.as_bytes();
    let mut i = start + marker.len();
    while i < bytes.len() && bytes[i] != b'{' {
        i += 1;
    }
    assert!(
        i < bytes.len(),
        "movement_tests: no opening brace after the brace-region marker in movement.rs"
    );
    let body_start = i + 1;
    let mut depth: usize = 1;
    let mut j = body_start;
    while j < bytes.len() && depth > 0 {
        match bytes[j] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        j += 1;
    }
    assert_eq!(
        depth, 0,
        "movement_tests: unbalanced braces while extracting a brace region from movement.rs"
    );
    &squashed[body_start..j - 1]
}

/// `movement_tick`'s brace-matched body, from the string-blanked squash.
fn movement_tick_body(squashed: &str) -> &str {
    let marker = ["pubfnmovement", "_tick("].concat();
    brace_body(squashed, marker.as_str())
}

/// The grass-encounter tail of `movement_tick`'s body: from the
/// `stepped_onto_grass(` trigger to the end of the reducer.
///
/// Deliberately a TAIL rather than a brace-matched block: the two failure arms
/// this slice changes sit at different nesting depths (one is a `match`/`else`
/// arm on the table lookup, the other is inside `if let Some(w) = ..`), and the
/// NPC-wander loop that follows contains no `log::error!`, no `?` and no
/// `return` — so including it cannot weaken any assertion below.
fn grass_region(body: &str) -> &str {
    let marker = ["stepped_onto", "_grass("].concat();
    let at = body
        .find(marker.as_str())
        .expect("movement_tests: `stepped_onto_grass(` not found in movement_tick's body");
    &body[at..]
}

/// **M-1** — a fresh limiter's FIRST `check` emits, reporting zero suppressed.
///
/// kills: an impl that stores `last_emit_ms` as a plain `i64` initialised to 0
/// (or any magic sentinel) instead of `Option<i64>`. With a 0 sentinel and the
/// tick's injected clock at, say, 1_000 ms, the first `elapsed` is 1_000 — inside
/// the window — so the very first content fault is SILENTLY DROPPED, which is
/// precisely the swallowing this feature exists to end. Also kills an impl whose
/// first emit reports a non-zero suppressed count (a fabricated backlog in the
/// first log line an operator ever sees).
///
/// COMPILE-RED: `RateLimiter` does not exist in `movement.rs` yet.
#[test]
fn rate_limiter_first_check_emits_zero_suppressed() {
    let limiter = RateLimiter::new();
    let first = limiter.check(1_000, TEST_WINDOW_MS);
    assert_eq!(
        first,
        Some(0),
        "TEETH (11r-g M-1, ADR-0170 D4): a fresh RateLimiter's first check must be \
         Some(0) — EMIT, with zero suppressed — but it returned {first:?}. \
         `last_emit_ms` is `Option<i64>` exactly so that never-emitted is \
         unrepresentable as a magic value: with a 0 sentinel the first check at a \
         non-zero clock reads as `elapsed = 1000 < window` and the FIRST content \
         fault is dropped, which is the swallowing ADR-0170 D4 exists to end."
    );
}

/// **M-1b** — `RateLimiter::new()` is a `const fn` and the type is `Sync`.
///
/// A COMPILE-TIME proof, not a runtime one: `static PROBE: RateLimiter =
/// RateLimiter::new();` only compiles if `new` is `const` and `RateLimiter: Sync`.
/// Both are load-bearing — ADR-0170 D4 makes the two limiters PROCESS STATICS
/// (`static X: RateLimiter = RateLimiter::new();`), and a non-const constructor
/// would force a `LazyLock`/`OnceLock` wrapper whose extra indirection is exactly
/// what the `Mutex`-inside-the-struct design avoids.
///
/// kills: an impl whose `new` is a plain `fn`, and an impl that reaches for a
/// `Cell`/`RefCell` (not `Sync`) instead of a `Mutex` — the latter would also
/// silently drop the read-decide-write-back atomicity the single lock provides.
///
/// The probe static is function-local, so it shares no state with any other test.
///
/// COMPILE-RED: `RateLimiter` does not exist in `movement.rs` yet.
#[test]
fn rate_limiter_new_is_const_and_the_type_is_sync() {
    static PROBE: RateLimiter = RateLimiter::new();
    let first = PROBE.check(0, TEST_WINDOW_MS);
    assert_eq!(
        first,
        Some(0),
        "TEETH (11r-g M-1b, ADR-0170 D4): a limiter declared as a process `static` \
         must behave exactly like a locally constructed one on its first check; got \
         {first:?}. The real content of this test is that it COMPILES: \
         `static PROBE: RateLimiter = RateLimiter::new();` requires `new` to be a \
         `const fn` and `RateLimiter` to be `Sync`, which is what lets ADR-0170 D4 \
         declare the two production limiters as plain statics."
    );
}

/// **M-2** — inside the window `check` suppresses and COUNTS; the next emit
/// reports the exact count and resets it.
///
/// The sequence (window 5_000): emit at 0, three suppressed checks at 1_000 /
/// 2_000 / 3_000, an emit at 5_000 that must report exactly `Some(3)`, then one
/// suppressed check and a second emit that must report exactly `Some(1)`.
///
/// kills, in order: (a) an impl that never suppresses (every check would emit, so
/// a bad-content zone re-logs at 5 Hz per character and the rate limit does
/// nothing); (b) an impl that suppresses but does not count (the emit would
/// report `Some(0)` and the loss would be invisible — ADR-0170 D4 makes the
/// suppressed count the ONLY surviving evidence of what was dropped); (c) an impl
/// that forgets to RESET the counter on emit — the second emit would report 4
/// instead of 1, so every subsequent log line over-reports a monotonically
/// growing backlog; (d) an off-by-one in the counter (Some(2) or Some(4) at the
/// first emit).
///
/// COMPILE-RED: `RateLimiter` does not exist in `movement.rs` yet.
#[test]
fn rate_limiter_suppresses_in_window_then_reports_the_exact_count() {
    let limiter = RateLimiter::new();

    let opening = limiter.check(0, TEST_WINDOW_MS);
    assert_eq!(
        opening,
        Some(0),
        "TEETH (11r-g M-2 precondition): the opening check must emit Some(0); got \
         {opening:?}. Every count below is measured relative to this anchor."
    );

    for now in [1_000i64, 2_000, 3_000] {
        let suppressed = limiter.check(now, TEST_WINDOW_MS);
        assert_eq!(
            suppressed, None,
            "TEETH (11r-g M-2, ADR-0170 D4): check({now}) is {now} ms after the emit \
             at 0 — inside the 5_000 ms window — so it must SUPPRESS (None); got \
             {suppressed:?}. An impl that emits here re-logs the same content fault \
             on every tick for every character in the zone, which is the log flood \
             the limiter exists to prevent."
        );
    }

    let after_window = limiter.check(5_000, TEST_WINDOW_MS);
    assert_eq!(
        after_window,
        Some(3),
        "TEETH (11r-g M-2, ADR-0170 D4): the emit at the window boundary must report \
         EXACTLY the three checks it suppressed — Some(3) — but it returned \
         {after_window:?}. Some(0) means the impl suppresses without counting, and \
         the suppressed count is the only surviving evidence of what was dropped (a \
         window conflates zones AND reasons, so nothing else records the loss)."
    );

    let suppressed_again = limiter.check(5_001, TEST_WINDOW_MS);
    assert_eq!(
        suppressed_again, None,
        "TEETH (11r-g M-2, ADR-0170 D4): one ms after an emit must suppress; got \
         {suppressed_again:?}. This also proves the emit at 5_000 RE-ANCHORED the \
         window rather than leaving it at 0."
    );

    let second_emit = limiter.check(10_001, TEST_WINDOW_MS);
    assert_eq!(
        second_emit,
        Some(1),
        "TEETH (11r-g M-2, ADR-0170 D4): the second emit must report exactly the ONE \
         check suppressed since the previous emit — Some(1) — but it returned \
         {second_emit:?}. Some(4) is the signature of an impl that never resets the \
         counter, which makes every later log line over-report a backlog that has \
         already been reported."
    );
}

/// **M-3** — the window boundary is INCLUSIVE.
///
/// Two independent, freshly constructed limiters so neither assertion can be
/// perturbed by the other's suppressed count:
///   * limiter A: emit at 0, then `window - 1` must SUPPRESS.
///   * limiter B: emit at 0, then exactly `window` must EMIT, with Some(0)
///     because nothing was suppressed in between.
///
/// kills: the `>` / `>=` mutant in `elapsed >= window`. A strict `>` makes
/// limiter B return None (the assertion fires); an `elapsed >= window - 1` or a
/// `>` flipped the other way makes limiter A emit. This is the single most
/// mutable line in the whole struct, and both directions are covered.
///
/// COMPILE-RED: `RateLimiter` does not exist in `movement.rs` yet.
#[test]
fn rate_limiter_window_boundary_is_inclusive() {
    let just_inside = RateLimiter::new();
    let opened_a = just_inside.check(0, TEST_WINDOW_MS);
    assert_eq!(
        opened_a,
        Some(0),
        "TEETH (11r-g M-3 precondition): limiter A's opening check must emit Some(0); \
         got {opened_a:?}."
    );
    let one_short = just_inside.check(TEST_WINDOW_MS - 1, TEST_WINDOW_MS);
    assert_eq!(
        one_short, None,
        "TEETH (11r-g M-3, ADR-0170 D4): one ms SHORT of the window must suppress, \
         but check(window - 1) returned {one_short:?}. Together with the assertion \
         below this pins the comparison as `elapsed >= window`: an impl using \
         `elapsed >= window - 1` (or no comparison at all) emits here."
    );

    let exactly_at = RateLimiter::new();
    let opened_b = exactly_at.check(0, TEST_WINDOW_MS);
    assert_eq!(
        opened_b,
        Some(0),
        "TEETH (11r-g M-3 precondition): limiter B's opening check must emit Some(0); \
         got {opened_b:?}."
    );
    let at_boundary = exactly_at.check(TEST_WINDOW_MS, TEST_WINDOW_MS);
    assert_eq!(
        at_boundary,
        Some(0),
        "TEETH (11r-g M-3, ADR-0170 D4): EXACTLY at the window must emit with zero \
         suppressed, but check(window) returned {at_boundary:?}. This kills the \
         `elapsed > window` mutant, which would silently stretch every window by one \
         millisecond and — with a tick clock that lands on exact multiples — could \
         drop an emit entirely. A SECOND, freshly constructed limiter is used here \
         so limiter A's suppressed check cannot leak into this count."
    );
}

/// **M-4** — a clock that goes BACKWARDS emits and RE-ANCHORS.
///
/// ADR-0170 D4 accepts the trade explicitly: a persistently jittery host clock
/// forces an emit per oscillation, which is a host-reliability scenario and not
/// attacker-reachable; suppressing forever is the unacceptable alternative.
///
/// The sequence proves both halves. After an emit at 1_000 and one suppressed
/// check at 2_000, a check at 500 (backwards) must return `Some(1)` — it EMITS
/// and reports the suppressed check. The two follow-up probes then prove the
/// anchor moved to 500 rather than staying at 1_000: `500 + window - 1`
/// suppresses, and `500 + window` emits. With the anchor left at 1_000 the second
/// probe is only 4_500 ms elapsed and would return None.
///
/// kills: (a) an impl with NO backwards branch that just computes
/// `now.saturating_sub(last)` — it yields 0, suppresses, and (with a clock that
/// jumped back far enough) the limiter is stuck suppressing until the clock
/// catches up, so a real content fault is silently swallowed for as long as the
/// jump; (b) an impl that emits on backwards but does NOT re-anchor, which leaves
/// the window computed against a future instant.
///
/// COMPILE-RED: `RateLimiter` does not exist in `movement.rs` yet.
#[test]
fn rate_limiter_clock_backwards_emits_and_reanchors() {
    let limiter = RateLimiter::new();

    let opening = limiter.check(1_000, TEST_WINDOW_MS);
    assert_eq!(
        opening,
        Some(0),
        "TEETH (11r-g M-4 precondition): the opening check at 1_000 must emit \
         Some(0); got {opening:?}."
    );
    let inside = limiter.check(2_000, TEST_WINDOW_MS);
    assert_eq!(
        inside, None,
        "TEETH (11r-g M-4 precondition): check(2_000) is inside the window and must \
         suppress; got {inside:?}."
    );

    let backwards = limiter.check(500, TEST_WINDOW_MS);
    assert_eq!(
        backwards,
        Some(1),
        "TEETH (11r-g M-4, ADR-0170 D4): a check whose clock reading is EARLIER than \
         the last emit must EMIT and report the one suppressed check — Some(1) — but \
         it returned {backwards:?}. None is the signature of an impl with no \
         backwards branch, which just computes `now.saturating_sub(last)` = 0: after \
         a backwards clock jump such a limiter suppresses until the clock catches up \
         again, silently swallowing every content fault in between."
    );

    let short_of_new_window = limiter.check(500 + TEST_WINDOW_MS - 1, TEST_WINDOW_MS);
    assert_eq!(
        short_of_new_window, None,
        "TEETH (11r-g M-4, ADR-0170 D4): one ms short of the window measured from the \
         NEW anchor (500) must suppress; got {short_of_new_window:?}."
    );
    let at_new_window = limiter.check(500 + TEST_WINDOW_MS, TEST_WINDOW_MS);
    assert_eq!(
        at_new_window,
        Some(1),
        "TEETH (11r-g M-4, ADR-0170 D4): exactly one window after the NEW anchor (500) \
         must emit, reporting the one check suppressed since — Some(1) — but it \
         returned {at_new_window:?}. This is the assertion that proves the backwards \
         check RE-ANCHORED: with the anchor left at 1_000 this instant is only 4_500 \
         ms elapsed, so a non-re-anchoring impl returns None here while passing every \
         assertion above it."
    );
}

/// **M-5** — extreme clock operands never panic.
///
/// This workspace sets `overflow-checks = true` (and `cargo test` builds with
/// them on by default), so a bare `now - last` on these operands ABORTS. In
/// production that abort is a panicking zone tick — the exact catastrophic
/// failure a LOGGING feature must never introduce, and it would fire on the very
/// path that exists to make faults visible.
///
/// kills: any non-saturating arithmetic in `check`. The decisive row is the
/// fresh limiter anchored at `i64::MIN` and then checked at `i64::MAX`:
/// `i64::MAX - i64::MIN` overflows, while `i64::MAX.saturating_sub(i64::MIN)`
/// saturates to `i64::MAX`, which is past any window and therefore emits. The
/// other rows cover the backwards branch at the extremes and the `MIN + window`
/// boundary, all of which a mutant that "fixes" only one subtraction would still
/// blow up on.
///
/// COMPILE-RED: `RateLimiter` does not exist in `movement.rs` yet.
#[test]
fn rate_limiter_extreme_clock_operands_never_panic() {
    // Row 1 — an emit at 0, then the clock jumps to i64::MIN (backwards).
    let jumped_back = RateLimiter::new();
    let anchor = jumped_back.check(0, TEST_WINDOW_MS);
    assert_eq!(
        anchor,
        Some(0),
        "TEETH (11r-g M-5 precondition): the opening check at 0 must emit Some(0); \
         got {anchor:?}."
    );
    let at_min = jumped_back.check(i64::MIN, TEST_WINDOW_MS);
    assert_eq!(
        at_min,
        Some(0),
        "TEETH (11r-g M-5, ADR-0170 D4): check(i64::MIN) after an emit at 0 is the \
         backwards case at the extreme — it must emit Some(0) and re-anchor, not \
         panic; got {at_min:?}."
    );
    let min_plus_window = jumped_back.check(i64::MIN + TEST_WINDOW_MS, TEST_WINDOW_MS);
    assert_eq!(
        min_plus_window,
        Some(0),
        "TEETH (11r-g M-5, ADR-0170 D4): exactly one window after an anchor at \
         i64::MIN must emit Some(0); got {min_plus_window:?}."
    );

    // Row 2 — the decisive overflow row: anchored at i64::MIN, checked at i64::MAX.
    let full_span = RateLimiter::new();
    let anchored_at_min = full_span.check(i64::MIN, TEST_WINDOW_MS);
    assert_eq!(
        anchored_at_min,
        Some(0),
        "TEETH (11r-g M-5 precondition): a fresh limiter's first check must emit \
         Some(0) whatever the clock reads; got {anchored_at_min:?}."
    );
    let at_max = full_span.check(i64::MAX, TEST_WINDOW_MS);
    assert_eq!(
        at_max,
        Some(0),
        "TEETH (11r-g M-5, ADR-0170 D4): with the anchor at i64::MIN, a check at \
         i64::MAX must emit Some(0); got {at_max:?}. THIS IS THE OVERFLOW ROW: a bare \
         `now - last` computes `i64::MAX - i64::MIN`, which PANICS under this \
         workspace's `overflow-checks = true` — in production that is a panicking \
         zone tick raised by the very code path added to make faults visible. \
         `now.saturating_sub(last)` saturates to i64::MAX, which is past any window, \
         so the correct answer is an emit."
    );
    let immediately_again = full_span.check(i64::MAX, TEST_WINDOW_MS);
    assert_eq!(
        immediately_again, None,
        "TEETH (11r-g M-5, ADR-0170 D4): a second check at the same extreme instant \
         is zero ms elapsed and must suppress; got {immediately_again:?}. This proves \
         the saturating subtraction did not simply make every comparison true."
    );
}

/// **M-5b / structural** — the limiter's arithmetic saturates and its lock
/// recovers from poisoning.
///
/// Three properties that a pure unit test cannot reach from outside the type:
///   * `saturating_add` — the suppressed counter must saturate at `u32::MAX`.
///     A test cannot drive 4.3 billion suppressed checks, so this is pinned as a
///     source needle. kills a bare `suppressed += 1`, which panics under
///     `overflow-checks = true` after a long enough burst — a panicking zone tick
///     raised by the log path.
///   * `saturating_sub` — pinned even though `rate_limiter_extreme_clock_operands_never_panic`
///     also bites, because the source needle names the fix rather than only the
///     symptom.
///   * `into_inner` — ADR-0170 D1/D4 recover a poisoned lock as
///     defence-in-depth: if the host unwinds panics and keeps the instance alive,
///     one unrelated panic must not brick every encounter log for the process
///     lifetime. kills a `.lock().unwrap()`, which would do exactly that. The
///     `RateLimiter`'s `Mutex` is private and `check` calls no user code, so
///     there is no way to poison it from a test — a source needle is the only
///     available gate. (Its sibling `type_chart_cache_lookup` IS poisoned and
///     exercised for real in `content_cache_tests.rs`, because that cell is
///     passed in by the caller.)
///
/// The cell type is pinned as well: `Mutex<(Option<i64>, u32)>` is ADR-0170 D4's
/// sanctioned shape. `Option<i64>` makes "never emitted" unrepresentable as a
/// magic value, and the SINGLE lock makes read-decide-write-back atomic by
/// construction — two separate atomics would lose an update under concurrent
/// checks and mis-report the suppressed count.
///
/// ASSERTION-RED at HEAD: `movement.rs` declares no `RateLimiter` at all.
///
/// HONEST LIMIT: an exact-shape pin. A semantically identical struct with named
/// fields would false-RED; ADR-0170 D4 fixes this text as the shape, and a future
/// slice that needs a different one must change the ADR and this needle together.
#[test]
fn rate_limiter_arithmetic_saturates_and_lock_poisoning_recovers() {
    let squashed = squashed_movement();

    let struct_marker = ["structRate", "Limiter"].concat();
    assert!(
        squashed.contains(struct_marker.as_str()),
        "TEETH (11r-g M-5b, ADR-0170 D4): `movement.rs` must declare a `RateLimiter` \
         struct. RED at HEAD — the two swallow sites in the grass block log nothing \
         at all today."
    );

    let cell_type = ["Mutex<(Option<i64>,", "u32)>"].concat();
    assert!(
        squashed.contains(cell_type.as_str()),
        "TEETH (11r-g M-5b, ADR-0170 D4): `RateLimiter` must wrap \
         `Mutex<(Option<i64>, u32)>` — last-emit instant and suppressed count behind \
         ONE lock. `Option<i64>` makes never-emitted unrepresentable as a magic value \
         (no i64::MIN sentinel that a real clock could collide with), and the single \
         lock makes read-decide-write-back atomic by construction; two separate \
         atomics would lose updates and mis-report the suppressed count that is the \
         only evidence of dropped logs."
    );

    let impl_marker = ["implRate", "Limiter"].concat();
    let n_impl = squashed.matches(impl_marker.as_str()).count();
    assert_eq!(
        n_impl, 1,
        "SCAN PRECONDITION (11r-g M-5b): `implRateLimiter` must appear EXACTLY ONCE \
         in the squashed `movement.rs`; found {n_impl}. With zero the region below \
         cannot be built and every needle in it would be vacuous; with two the \
         extractor takes the first block and a decoy could carry the saturating \
         arithmetic while the real one overflows."
    );

    let region = brace_body(&squashed, impl_marker.as_str());

    let sat_add = ["saturating", "_add("].concat();
    assert!(
        region.contains(sat_add.as_str()),
        "TEETH (11r-g M-5b, ADR-0170 D4): `RateLimiter`'s impl must increment the \
         suppressed counter with `saturating_add` so it pins at u32::MAX. A bare \
         `+= 1` PANICS under this workspace's `overflow-checks = true` once a long \
         enough burst accumulates — a panicking zone tick raised by the logging path \
         itself. No unit test can drive 4.3 billion suppressed checks, so this needle \
         is the only available gate."
    );

    let sat_sub = ["saturating", "_sub("].concat();
    assert!(
        region.contains(sat_sub.as_str()),
        "TEETH (11r-g M-5b, ADR-0170 D4): `RateLimiter`'s impl must compute the \
         elapsed time with `saturating_sub`. `rate_limiter_extreme_clock_operands_never_panic` \
         bites on the symptom (a panic at i64::MAX minus i64::MIN); this needle names \
         the fix, so a reader of a failing build is told what to write."
    );

    let into_inner = ["into", "_inner()"].concat();
    assert!(
        region.contains(into_inner.as_str()),
        "TEETH (11r-g M-5b, ADR-0170 D1/D4): `RateLimiter`'s impl must recover a \
         POISONED lock via `into_inner()` rather than `.unwrap()`ing the \
         `PoisonError`. If the host unwinds panics and keeps the module instance \
         alive, one unrelated panic while the lock is held would brick every \
         encounter-failure log for the whole process lifetime — the feature would \
         silently stop working exactly after something went wrong. The `Mutex` is \
         private and `check` calls no user code, so a test cannot poison it; this \
         needle is the only available gate (its sibling `type_chart_cache_lookup` is \
         poisoned for real in `content_cache_tests.rs`)."
    );
}

/// **M-7** (ADR-0170 D4) — the two grass-block swallow sites become logged
/// no-ops, each gated by its OWN limiter.
///
/// ASSERTION-RED at HEAD on every layer: the grass block logs nothing, and both
/// swallow sites are still spelled as the discarding forms this test forbids.
///
/// LAYER BY LAYER, and what each kills:
///
///   * **Two limiter STATICS, each declared exactly once, each a `RateLimiter`.**
///     ADR-0170 D4 requires two INDEPENDENT limiters and gives the concrete
///     reason: one of `begin_encounter`'s Err paths ("party has no conscious
///     monster") is ROUTINE gameplay — a fainted party walking through grass — so
///     it bursts. A single shared limiter would let that routine burst mask a
///     real content defect in the encounter table, which is the failure this
///     whole feature exists to surface. Kills the natural simplification of one
///     shared static.
///
///   * **A shared `const ENCOUNTER_ERR_WINDOW_MS: i64 = 5000;`.** Named, not two
///     inline literals, because the contiguous gate needles below pin the window
///     BY NAME — which also makes the two arms provably share one window value
///     instead of drifting apart.
///
///   * **Each log lives INSIDE its own limiter's gate — pinned CONTIGUOUSLY.**
///     This is the layer a red-team defeated in the first draft. A presence-only
///     `LIMITER.check(` needle is satisfied by
///     `let _ = ENCOUNTER_TABLE_ERR_LIMITER.check(..); log::error!(..);`: the
///     limiter is consulted, its answer is DISCARDED, and the error line fires on
///     every tick for every character in the zone — a worse flood than the
///     silence this slice replaces, passing every count-based needle. Requiring
///     `ifletSome(suppressed)=<LIMITER>.check(now.0,ENCOUNTER_ERR_WINDOW_MS){log::error!(`
///     as ONE squashed string makes it unrepresentable (E3/E1 precedent, this
///     file). Because the binding is `suppressed` and not `_suppressed`, the
///     compiler itself then forces the log body to consume it.
///
///   * **The routine-reason filter sits IMMEDIATELY OUTSIDE the begin-encounter
///     gate, spelled `!=`.** `NO_CONSCIOUS_MONSTER_REASON` is client-reachable
///     (walk grass with an all-fainted party), so it must consume neither the log
///     NOR the limiter window — a filter placed inside the `if let Some(..)` block
///     would still let it `.check(`, re-anchoring the window and resetting the
///     suppressed counter, which is a client-driven way to mask genuine faults.
///     Pinning filter+gate as one contiguous sequence also kills the
///     `replace != with ==` mutant that a cargo-mutants run found surviving every
///     other assertion here (inverted, only the non-event is ever logged and every
///     real fault is permanently silent).
///
///   * **Neither limiter is consulted anywhere ELSE in the tail (exactly once
///     each).** The gate needle proves one correct call exists; only the count
///     proves it is the only one. A second, discarded `check` re-anchors the
///     window and resets the suppressed counter, so the emitted count
///     under-reports the loss it exists to report.
///
///   * **Exactly TWO `log::error!` sites in the grass region.** Zero at HEAD.
///     Pins one log per failure arm: with one, only one arm was wired; with
///     three, something else in the block started logging and the pairing with
///     the `json_escape` count in
///     [`movement_tick_error_reasons_are_json_escaped`] would no longer hold.
///
///   * **The two OLD spellings are gone.** `let _ = begin_encounter(` is the
///     literal swallow ADR-0170 exists to delete; a `let Ok(table) = .. else`
///     binding discards the Err before anything can log it. Leaving either in
///     place while ADDING a log elsewhere is the most plausible partial fix, and
///     only these negative needles see it.
///
///   * **Both calls SURVIVE.** `table_from_encounter_row(` and
///     `begin_encounter(` must still appear exactly once each. Without this, the
///     cheapest way to satisfy every negative needle is to delete the encounter
///     path outright — which would silently end wild encounters.
///
/// HONEST LIMITS. (a) Source scan, not execution (ADR-0156 P7). (b) The needles
/// run on the string-BLANKED squash, so the JSON payload shape is not pinned
/// here; the two `evt` names are pinned separately by
/// [`movement_tick_encounter_error_events_are_named`], which runs on the
/// comments-only view. (c) Hand-derived counts: if a later slice legitimately
/// adds a third failure arm, re-derive them DELIBERATELY.
#[test]
fn movement_tick_encounter_failures_are_logged_and_rate_limited() {
    let squashed = squashed_movement();
    let body = movement_tick_body(&squashed);
    let region = grass_region(body);

    // --- Layer 1: two distinct limiter statics, of the right type -------------
    let table_static = ["staticENCOUNTER_TABLE_ERR", "_LIMITER"].concat();
    let n_table_static = squashed.matches(table_static.as_str()).count();
    assert_eq!(
        n_table_static, 1,
        "TEETH (11r-g M-7, ADR-0170 D4): `movement.rs` must declare the \
         encounter-table error limiter as a process static EXACTLY ONCE; found \
         {n_table_static} (HEAD has 0). Process-static, not per-zone: a per-zone map \
         is unbounded growth for a log path, and the zone id rides in the payload."
    );

    let begin_static = ["staticBEGIN_ENCOUNTER_ERR", "_LIMITER"].concat();
    let n_begin_static = squashed.matches(begin_static.as_str()).count();
    assert_eq!(
        n_begin_static, 1,
        "TEETH (11r-g M-7, ADR-0170 D4): `movement.rs` must declare the \
         begin-encounter error limiter as a SECOND, separate process static EXACTLY \
         ONCE; found {n_begin_static} (HEAD has 0). Two independent limiters are the \
         decision, not an accident: `begin_encounter`'s 'party has no conscious \
         monster' Err is ROUTINE gameplay (a fainted party walking grass) and bursts, \
         so a shared limiter would let it mask a real content defect in the encounter \
         table — the exact fault this feature exists to surface."
    );

    let typed_static = ["_LIMITER:Rate", "Limiter"].concat();
    let n_typed = squashed.matches(typed_static.as_str()).count();
    assert_eq!(
        n_typed, 2,
        "TEETH (11r-g M-7, ADR-0170 D4): exactly TWO statics must be typed \
         `RateLimiter`; found {n_typed}. This is the spelling-independent version of \
         the two counts above — it catches a second limiter introduced under a \
         different name, and a limiter declared with some other (unlocked, \
         non-saturating) type."
    );

    // --- Layer 1b: the shared window constant exists, at the ADR's value ------
    let window_const = ["constENCOUNTER_ERR_WINDOW", "_MS:i64="].concat();
    let window_variants = [
        [window_const.as_str(), "5000;"].concat(),
        [window_const.as_str(), "5_000;"].concat(),
    ];
    let window_ok = window_variants
        .iter()
        .any(|v| squashed.contains(v.as_str()));
    assert!(
        window_ok,
        "TEETH (11r-g M-7, ADR-0170 D4): `movement.rs` must declare a file-level \
         `const ENCOUNTER_ERR_WINDOW_MS: i64 = 5000;` (the `5_000` spelling is also \
         accepted) — the 5000 ms window both limiters share. It is a NAMED constant, \
         not two inline literals, because the two contiguous gate needles below pin \
         it by name: an inline number in one arm and a different one in the other is \
         exactly the drift this constant removes. RED at HEAD."
    );

    // --- Layer 2: each log is INSIDE its own limiter's gate -------------------
    // Contiguous mega-needles, the E3/E1 precedent in this file. A presence-only
    // needle for `LIMITER.check(` is satisfied by
    // `let _ = LIMITER.check(..); log::error!(..)` — the limiter is consulted, its
    // answer is thrown away, and the log fires on EVERY tick for EVERY character
    // in the zone. That shell passed every earlier draft of this test.
    let gate_open = ["ifletSome(suppressed)", "="].concat();
    let gate_tail = [".check(now.0,ENCOUNTER_ERR_WINDOW", "_MS){log::error!("].concat();
    let gate = |limiter: &str| [gate_open.as_str(), limiter, gate_tail.as_str()].concat();

    let table_gate = gate(&["ENCOUNTER_TABLE_ERR", "_LIMITER"].concat());
    let n_table_gate = region.matches(table_gate.as_str()).count();
    assert_eq!(
        n_table_gate, 1,
        "TEETH (11r-g M-7, ADR-0170 D4): the encounter-table arm must contain, as ONE \
         contiguous whitespace-squashed expression, \
         `ifletSome(suppressed)=ENCOUNTER_TABLE_ERR_LIMITER.check(now.0,\
         ENCOUNTER_ERR_WINDOW_MS){{log::error!(` — i.e. the source must read \
         `if let Some(suppressed) = ENCOUNTER_TABLE_ERR_LIMITER.check(now.0, \
         ENCOUNTER_ERR_WINDOW_MS) {{ log::error!(..` — found {n_table_gate}. \
         WHY CONTIGUITY: a presence-only `LIMITER.check(` needle is satisfied by \
         `let _ = ENCOUNTER_TABLE_ERR_LIMITER.check(..); log::error!(..);` — the \
         limiter is consulted, its answer DISCARDED, and the error line fires on \
         every tick for every character in the zone. That is a worse log flood than \
         the silence this slice replaces, and it passes every count-based needle. \
         Only pinning the `if let Some(..) = ..` gate and the log's opening token as \
         ONE string makes it unrepresentable. `now.0` is the tick's INJECTED clock \
         (ADR-0003, movement.rs:181) — never a wall clock. The `suppressed` binding \
         is not underscore-prefixed, so the compiler itself requires the log body to \
         consume it. RED at HEAD."
    );

    let begin_gate = gate(&["BEGIN_ENCOUNTER_ERR", "_LIMITER"].concat());
    let n_begin_gate = region.matches(begin_gate.as_str()).count();
    assert_eq!(
        n_begin_gate, 1,
        "TEETH (11r-g M-7, ADR-0170 D4): the begin-encounter arm must contain the \
         SAME contiguous gate, with its OWN limiter: \
         `ifletSome(suppressed)=BEGIN_ENCOUNTER_ERR_LIMITER.check(now.0,\
         ENCOUNTER_ERR_WINDOW_MS){{log::error!(` — found {n_begin_gate}. This is the \
         arm where an ungated log hurts most: the routine 'party has no conscious \
         monster' Err fires on EVERY grass step of EVERY fainted party, so a \
         discarded `check` answer turns a bounded one-line-per-window signal into a \
         5 Hz per-character ERROR flood. RED at HEAD."
    );

    // --- Layer 2-filter: the routine-reason filter, and its COMPARISON DIRECTION
    // A refinement of layer 2's begin-encounter gate, so it lives here rather than
    // after the counts below. Added after a cargo-mutants run showed
    // `replace != with == at movement.rs:433` SURVIVING every other assertion in
    // this file: the filter was present, contiguous, correctly placed, and
    // semantically inverted.
    let routine_filter = ["ife!=NO_CONSCIOUS_MONSTER", "_REASON{"].concat();
    let filtered_gate = [
        routine_filter.as_str(),
        gate_open.as_str(),
        "BEGIN_ENCOUNTER_ERR",
        "_LIMITER.check(",
    ]
    .concat();
    let n_filtered = region.matches(filtered_gate.as_str()).count();
    assert_eq!(
        n_filtered, 1,
        "TEETH (11r-g M-7 layer 2-filter, ADR-0170 D4): the begin-encounter arm must \
         contain, as ONE contiguous whitespace-squashed sequence, \
         `ife!=NO_CONSCIOUS_MONSTER_REASON{{ifletSome(suppressed)=\
         BEGIN_ENCOUNTER_ERR_LIMITER.check(` — i.e. the source must read \
         `if e != NO_CONSCIOUS_MONSTER_REASON {{ if let Some(suppressed) = \
         BEGIN_ENCOUNTER_ERR_LIMITER.check(..` — found {n_filtered}. \
         THE MUTANT THIS KILLS: `replace != with ==` at movement.rs:433, which a \
         cargo-mutants run found SURVIVING every other assertion in this file — the \
         filter is still present, still contiguous, still correctly placed, and \
         exactly backwards. Inverted, the limiter and the log fire ONLY for the \
         routine fainted-party reason and NEVER for a genuine fault \
         (species-not-found, stat corruption): those are permanently silenced, while \
         the one non-event that must never be logged becomes the only thing in the \
         log. It is strictly worse than the pre-slice silence, because it looks like \
         a working feature. The `==` spelling squashes to `ife==…` and cannot match \
         this needle. \
         WHY THE FILTER AND THE GATE ARE PINNED ADJACENTLY: the routine reason is \
         client-reachable (walk grass with an all-fainted party), so it must consume \
         NEITHER the log NOR the limiter window. A filter wrapped around the \
         `log::error!` alone — inside the `if let Some(suppressed)` block instead of \
         outside it — still lets the routine reason call `.check(`, which re-anchors \
         the window and resets the suppressed counter: a client could then saturate \
         the limiter and mask genuine faults, the exact attack the filter exists to \
         close. Only requiring the filter IMMEDIATELY OUTSIDE the gate rules that out. \
         A dropped filter fails this needle too (the sequence simply does not occur). \
         GREEN at HEAD. \
         HONEST LIMIT: this pins the comparison and its position, not the CONSTANT's \
         value — `NO_CONSCIOUS_MONSTER_REASON` is a `pub(crate) const` in `battle.rs`, \
         outside this file's scan, and is the SSOT precisely so the reason string \
         cannot drift apart from the guard that produces it."
    );

    // --- Layer 2b: neither limiter is consulted anywhere ELSE in the tail -----
    let table_check = ["ENCOUNTER_TABLE_ERR", "_LIMITER.check("].concat();
    let n_table_check = region.matches(table_check.as_str()).count();
    assert_eq!(
        n_table_check, 1,
        "TEETH (11r-g M-7, ADR-0170 D4): the encounter-table limiter must be \
         consulted EXACTLY ONCE inside `movement_tick`'s grass block; found \
         {n_table_check}. Layer 2 proves ONE correct gated call exists; this proves \
         it is the ONLY call. A second, discarded `check` alongside the good one \
         burns the window (it re-anchors and resets the suppressed count), so the \
         emitted count under-reports what was dropped — the one number ADR-0170 D4 \
         relies on to make the loss visible."
    );

    let begin_check = ["BEGIN_ENCOUNTER_ERR", "_LIMITER.check("].concat();
    let n_begin_check = region.matches(begin_check.as_str()).count();
    assert_eq!(
        n_begin_check, 1,
        "TEETH (11r-g M-7, ADR-0170 D4): the begin-encounter limiter must be \
         consulted EXACTLY ONCE inside `movement_tick`'s grass block; found \
         {n_begin_check}. Same reasoning as the encounter-table count above: a second \
         `check` silently re-anchors the window and resets the suppressed counter."
    );

    // --- Layer 3: exactly two error logs in the grass region ------------------
    let log_error = ["log::err", "or!("].concat();
    let n_log_error = region.matches(log_error.as_str()).count();
    assert_eq!(
        n_log_error, 2,
        "TEETH (11r-g M-7, ADR-0170 D4): `movement_tick`'s grass block must contain \
         EXACTLY TWO `log::error!` sites — one per failure arm; found {n_log_error} \
         (HEAD has 0, which is the swallowing this slice ends). One means only one \
         arm was wired. Three or more means something else started logging and the \
         escape/log pairing asserted by \
         `movement_tick_error_reasons_are_json_escaped` no longer holds — re-derive \
         both counts DELIBERATELY in that case."
    );

    // --- Layer 4: the OLD swallowing spellings are gone -----------------------
    let discarded_call = ["let_=begin", "_encounter("].concat();
    let n_discarded = region.matches(discarded_call.as_str()).count();
    assert_eq!(
        n_discarded, 0,
        "TEETH (11r-g M-7, ADR-0170 D4): the discarding `let _ = begin_encounter(..)` \
         form must be GONE; found {n_discarded} (HEAD has 1, at movement.rs:326). \
         That single line is the swallow: every `begin_encounter` failure — content \
         faults included — disappears with no trace anywhere. The Err must now be \
         bound, escaped and logged through the begin-encounter limiter."
    );

    let bare_table_binding = ["letOk(table)=table_from_encounter", "_row("].concat();
    let n_bare = region.matches(bare_table_binding.as_str()).count();
    assert_eq!(
        n_bare, 0,
        "TEETH (11r-g M-7, ADR-0170 D4): the bare `let Ok(table) = \
         table_from_encounter_row(..) else` binding must be GONE; found {n_bare} \
         (HEAD has 1, at movement.rs:319). A refutable `let Ok(..) else` DISCARDS the \
         Err before anything can log it, so a malformed encounter row silently stops \
         all wild encounters in that zone with no diagnostic at all. The Err must be \
         bound (a `match` or `if let Err(e)`), escaped and logged."
    );

    // --- Layer 5: the calls themselves survive --------------------------------
    let table_call = ["table_from_encounter", "_row("].concat();
    let n_table_call = region.matches(table_call.as_str()).count();
    assert_eq!(
        n_table_call, 1,
        "ANTI-VACUITY (11r-g M-7): `table_from_encounter_row(` must still be called \
         EXACTLY ONCE in the grass block; found {n_table_call}. Without this, the \
         cheapest way to satisfy layer 4's negative needle is to delete the encounter \
         table lookup outright — which silently ends wild encounters everywhere."
    );

    let begin_call = ["begin", "_encounter("].concat();
    let n_begin_call = region.matches(begin_call.as_str()).count();
    assert_eq!(
        n_begin_call, 1,
        "ANTI-VACUITY (11r-g M-7): `begin_encounter(` must still be called EXACTLY \
         ONCE in the grass block; found {n_begin_call}. The uppercase limiter static \
         `BEGIN_ENCOUNTER_ERR_LIMITER` does not match this lowercase needle, so the \
         count is unambiguous. Deleting the call would satisfy every negative needle \
         above while removing wild encounters entirely."
    );
}

/// **M-7b** (ADR-0170 D4) — the two new log lines carry their own `evt` names.
///
/// ASSERTION-RED at HEAD: neither name exists anywhere in `movement.rs`.
///
/// This is the ONE assertion in this section that runs on the comments-only view
/// ([`squashed_movement_keeping_strings`]), because an `evt` name is string
/// literal CONTENT and the string-blanking squash every other needle uses cannot
/// see it. Comments are still stripped, so a comment naming the evt cannot
/// satisfy it.
///
/// The weakness of that view is understood and bounded: a dead
/// `let _decoy = "encounter_table_error";` would satisfy these two needles. It
/// would NOT satisfy any needle in
/// [`movement_tick_encounter_failures_are_logged_and_rate_limited`], which is
/// where all the structural teeth live — the limiter statics, their `.check(`
/// calls and the `log::error!` count are code and are asserted on the blanked
/// view. This test's job is narrower: pin the two names an operator greps for,
/// and pin that they are DISTINCT.
///
/// kills: a single shared `evt` name for both arms (which would make the two
/// separate limiters pointless — an operator could not tell which fault fired),
/// and the deletion of the two pre-existing `movement_tick_error` events while
/// retrofitting them with `json_escape`.
#[test]
fn movement_tick_encounter_error_events_are_named() {
    let squashed = squashed_movement_keeping_strings();

    let table_evt = ["encounter_table", "_error"].concat();
    assert!(
        squashed.contains(table_evt.as_str()),
        "TEETH (11r-g M-7b, ADR-0170 D4): `movement.rs` must emit an \
         `encounter_table_error` event for a failed `table_from_encounter_row`. RED \
         at HEAD — that failure is a bare `continue` with no diagnostic, so a \
         malformed encounter row silently stops wild encounters in that zone."
    );

    let begin_evt = ["begin_encounter", "_error"].concat();
    assert!(
        squashed.contains(begin_evt.as_str()),
        "TEETH (11r-g M-7b, ADR-0170 D4): `movement.rs` must emit a distinct \
         `begin_encounter_error` event for a failed `begin_encounter`. RED at HEAD. \
         A DISTINCT name (not one shared with the table fault) is what makes the two \
         independent limiters useful: an operator must be able to tell a routine \
         'no conscious monster' burst from a real content defect."
    );

    let tick_evt = ["movement_tick", "_error"].concat();
    let n_tick_evt = squashed.matches(tick_evt.as_str()).count();
    assert_eq!(
        n_tick_evt, 2,
        "ANTI-REGRESSION (11r-g M-7b): the two pre-existing `movement_tick_error` \
         events must SURVIVE the `json_escape` retrofit; found {n_tick_evt} (HEAD has \
         2, at movement.rs:186 and :193). Green at HEAD — this fires only if the \
         retrofit renames or deletes them, which would break whatever already greps \
         for the name."
    );
}

/// **M-6** (ADR-0170 D4, final bullet) — EVERY error reason interpolated inside
/// `movement_tick` goes through `json_escape`.
///
/// ASSERTION-RED at HEAD: the body holds two `log::error!` sites and zero
/// `json_escape(` calls.
///
/// THE PAIRED COUNTS ARE THE POINT. Four `log::error!` sites is the arithmetic
/// ADR-0170 D4 fixes: the two pre-existing `movement_tick_error` sites (:186 —
/// the zone-map cache failure, :193 — `map_for`) plus the two new grass-block
/// arms. Each interpolates exactly one error reason, so at least four
/// `json_escape(` calls must be present. Asserting BOTH numbers, and asserting
/// that the escapes are at least as many as the logs, means a fifth error log
/// added later cannot quietly ship an unescaped reason: the count assertion fires
/// and forces the arithmetic to be re-derived on purpose.
///
/// WHY THE TWO OLD SITES ARE IN SCOPE AT ALL: they are the same defect class in
/// the same file. `map_for`'s Err carries content-derived text, and
/// `cached_zone_maps`'s Err is a RON parse error — precisely the shape that
/// contains a double quote. They are NOT rate-limited (ADR-0170 residual 3), and
/// deliberately so: they fire at most once per zone per tick, so the per-step
/// spam risk does not apply.
///
/// The count runs on the string-BLANKED squash, so a log format string mentioning
/// the helper cannot inflate it — only executable calls count. The needle keeps
/// the opening paren so the `use crate::guards::{..}` import (which has none)
/// is not counted, and it is scoped to `movement_tick`'s brace-matched body so
/// the import cannot be reached at all.
///
/// THE DISCARD IDIOM IS CLOSED BY A NEGATIVE NEEDLE, NOT BY THE LINT GATE.
/// An earlier draft of this comment claimed `-D warnings` made
/// `let _ = json_escape(&e);` beside a raw interpolation a build failure. That is
/// WRONG: `let _ = expr;` binds to the wildcard pattern, which `unused_variables`
/// never reports (and `let _esc = ..` would only be a warning-level lint, not the
/// hard error the claim assumed). The same evasion with the same wrong
/// justification was found and fixed once before in this crate —
/// `trading_tests.rs:1959-2039`. What actually closes it here is the ZERO-`let_`
/// assertion below: every discard spelling (`let _ =`, `let _esc =`,
/// `let _unused:`) squashes to a string containing `let_`, while the legitimate
/// shadowing form `let reason = json_escape(&e);` squashes to `letreason=` and
/// does not match.
///
/// HONEST LIMIT: the counts pin that the escape is CALLED as many times as
/// reasons are logged, and the `let_` needle pins that no call's result is
/// discarded; together they leave only "escaped into the wrong slot of the right
/// log line", which no lexical scan can see. That residue is covered by
/// `guards_tests.rs`'s G-1..G-3 (the helper is worth calling) and by the eval
/// layer's independent body scan.
#[test]
fn movement_tick_error_reasons_are_json_escaped() {
    let squashed = squashed_movement();
    let body = movement_tick_body(&squashed);

    let log_error = ["log::err", "or!("].concat();
    let n_log_error = body.matches(log_error.as_str()).count();
    assert_eq!(
        n_log_error, 4,
        "TEETH (11r-g M-6, ADR-0170 D4): `movement_tick`'s body must contain EXACTLY \
         FOUR `log::error!` sites; found {n_log_error}. THE ARITHMETIC: 2 pre-existing \
         `movement_tick_error` sites (movement.rs:186 zone-map cache failure, :193 \
         `map_for`) + 2 new grass-block arms (encounter table, begin encounter) = 4. \
         HEAD has 2, so this is RED. It is paired with the escape count below: a \
         fifth error log added later trips this assertion and forces someone to \
         re-derive the arithmetic rather than quietly shipping an unescaped reason."
    );

    let escape = ["json", "_escape("].concat();
    let n_escape = body.matches(escape.as_str()).count();
    assert!(
        n_escape >= 4,
        "TEETH (11r-g M-6, ADR-0170 D4): `movement_tick`'s body must pass every \
         interpolated error reason through the JSON escape helper — at least FOUR \
         calls — but it makes {n_escape}. HEAD makes 0: `map_for`'s Err carries \
         content-derived text and `cached_zone_maps`'s Err is a RON parse error, \
         exactly the shape that contains a double quote and emits a malformed log \
         line. The needle keeps the opening paren, so the `use crate::guards::{{..}}` \
         import does not count, and it is scoped to the reducer body so the import is \
         out of reach. String literals are blanked before counting, so only executable \
         calls are seen."
    );

    assert!(
        n_escape >= n_log_error,
        "TEETH (11r-g M-6, ADR-0170 D4): `movement_tick` makes {n_escape} escape \
         call(s) for {n_log_error} `log::error!` site(s). Every error log in this \
         reducer interpolates exactly one error reason, so the escapes can never be \
         fewer than the logs. This is the invariant that survives a future slice \
         adding a fifth log line."
    );

    // --- The discard kill: no underscore binding anywhere in the body --------
    // `let _ = json_escape(&e);` next to a RAW interpolation satisfies both counts
    // above while every log line stays malformed. It is NOT a compile error and
    // NOT a lint failure — `let _ = expr;` is a wildcard pattern and
    // `unused_variables` never fires on it. (Same evasion, same wrong "the lint
    // will catch it" justification: trading_tests.rs:1959-2039.)
    //
    // The needle is the three-character `let_` on the squashed body, which catches
    // `let _ =`, `let _esc =` and `let _: String =` alike, while the legitimate
    // shadowing form `let reason = json_escape(&e);` squashes to `letreason=` and
    // does not match.
    //
    // AT HEAD this is RED, and the arithmetic is exact: `movement_tick`'s body
    // contains exactly ONE underscore binding today — `let _ = begin_encounter(..)`
    // at movement.rs:326 — which this slice deletes. Every other binding in the
    // body is named (`zone_maps`, `map`, `ids`, `row`, `battle_locked`, `input`,
    // `prev`, `next`, `entity_id`, `to_zone`, `skip_warp`, `player`,
    // `player_identity`, `already`, `party_ids`, `player_level`, `enc_row`,
    // `table`, `seed`, `tick_counter`, `npc_entity_ids`, `npc_row`, `ch`,
    // `current`, `home`, `st`, `dir`, `next_state`), and none of them ENDS in
    // `let` before an underscore, so none can produce the substring by accident.
    // After the slice the count must be 0 and stay 0.
    let discard = ["let", "_"].concat();
    let n_discard = body.matches(discard.as_str()).count();
    assert_eq!(
        n_discard, 0,
        "TEETH (11r-g M-6, ADR-0170 D4): `movement_tick`'s body contains {n_discard} \
         underscore binding(s) (`let _`) and must contain ZERO. \
         WHAT THIS KILLS: `let _ = json_escape(&e); log::error!(.., e);` — the escape \
         is called (satisfying both counts above), its result is thrown away, and the \
         reason is still interpolated RAW, so a parse error containing a double quote \
         still emits a malformed JSON log line. This is NOT caught by the compiler or \
         by `-D warnings`: `let _ = expr;` binds the wildcard pattern and \
         `unused_variables` never reports it. The same evasion with the same wrong \
         'the lint gate catches it' justification was found and fixed before in this \
         crate at trading_tests.rs:1959-2039. \
         AT HEAD the count is 1 — `let _ = begin_encounter(..)` at movement.rs:326, \
         the swallow this slice deletes — so this assertion is RED now and must be \
         green after. Use the escaped value directly in the format arguments, or \
         bind it under a real name (`let reason = json_escape(&e);` squashes to \
         `letreason=` and does not match). If a future slice genuinely needs a \
         discarded expression here, it must re-argue this needle rather than delete \
         it."
    );
}

/// **ADR-0066 fence** — a grass-block content fault must stay a logged NO-OP and
/// never abort the zone tick.
///
/// GREEN AT HEAD and green after the slice; RED the moment either new failure arm
/// is written with `?` or an early `return`.
///
/// A SEPARATE `#[test]` on purpose, for the reason recorded at line ~917: folded
/// into `movement_tick_encounter_failures_are_logged_and_rate_limited` it would
/// sit behind assertions that fail at HEAD, so it could never be observed passing
/// and would prove nothing about the fix.
///
/// WHY IT IS A REAL HAZARD, not a hypothetical. The natural way to bind an Err so
/// you can log it is `let table = table_from_encounter_row(&enc_row)
/// .map_err(|e| ..)?;` — and the `?` is invisible in a diff full of new logging.
/// That single character converts one character's content fault into a failure of
/// the WHOLE zone tick: every other character in the zone stops moving, and the
/// NPC-wander loop below never runs. ADR-0066 is explicit that a content fault
/// must never abort the tick, and ADR-0170 D4 restates it ("both still
/// `continue`").
///
/// The region is the whole grass tail of `movement_tick`, which also covers the
/// NPC-wander loop — neither contains a `?` or a `return` at HEAD, so including
/// it costs nothing and closes the same hazard there.
///
/// HONEST LIMIT: it forbids the two ABORT spellings, not every possible abort. A
/// `std::process::exit` or a panic is not seen here; both are already out of
/// reach in a `spacetimedb::reducer` and would be caught by the crate's other
/// gates.
#[test]
fn movement_tick_grass_block_never_aborts_the_tick() {
    let squashed = squashed_movement();
    let body = movement_tick_body(&squashed);
    let region = grass_region(body);

    let n_try = region.matches('?').count();
    assert_eq!(
        n_try, 0,
        "TEETH (11r-g / ADR-0066, green at HEAD): the grass tail of `movement_tick` \
         contains {n_try} `?` operator(s) and must contain ZERO. The natural way to \
         bind an Err so it can be logged is \
         `table_from_encounter_row(&enc_row).map_err(..)?`, and that one character \
         turns ONE character's content fault into a failure of the WHOLE zone tick: \
         every other character in the zone stops moving and the NPC-wander loop never \
         runs. ADR-0066 requires a content fault to be a logged NO-OP; ADR-0170 D4 \
         restates it — both new arms log and then `continue`."
    );

    let n_return = region.matches("return").count();
    assert_eq!(
        n_return, 0,
        "TEETH (11r-g / ADR-0066, green at HEAD): the grass tail of `movement_tick` \
         contains {n_return} `return` statement(s) and must contain ZERO. An early \
         `return Ok(())` reads as harmless — the reducer still succeeds — but it \
         abandons every remaining character in the zone AND the entire NPC-wander \
         loop for that tick, on the strength of one character's bad content row. The \
         two pre-existing `return Ok(())` sites in this reducer are legitimate and \
         sit ABOVE this region (they abort a tick whose MAP could not be loaded, \
         where there is nothing left to do)."
    );
}

// ===========================================================================
// EG2 — the MOVEMENT call site for Quality-Time accrual and auto-evolution
// (spec `M-evolution-essence-graph.spec.md` §2 EG2-8 / EG2-9 / EG2-12;
//  ADR-0175 D1/D3)
//
// EARS criteria covered below:
//
//   EG2-8   The Quality-Time accrual SHALL be called DIRECTLY from exactly the
//           listed reducers, and — uniquely at this call site — ONCE PER PARTY
//           MONSTER, looping over `lead_party_ids(ctx, owner)`'s full returned id
//           list, NOT just the lead (party_slot 0). Drew's directive wording is
//           "playtime with the monster actively in the party", not "the lead
//           monster". (12r-e E2 re-point: the id-only resolver, so an unparseable
//           LEAD level cannot silently disable the whole party's growth tail.)
//
//   EG2-9   The accrual and the auto-evolution check SHALL NEVER be called
//           DIRECTLY from a SCHEDULED reducer's own body. `movement_tick` is the
//           scheduled reducer in this file; wiring the hooks there is precisely
//           the afk-farming vulnerability the no-idle-accrual gate exists to
//           close — a player could enqueue moves and walk away while the 200 ms
//           tick kept crediting growth with no further engagement.
//
//   EG2-12  The auto-evolution check SHALL be called as the LAST step of the same
//           five reducers, after that reducer's own mutation.
//
// SEAM AVAILABILITY (stated honestly): there is still no reducer-executing
// harness in this crate (ADR-0156 P7, restated in the headers above) and no
// TestDb — every reducer test in this file is a source scan, and the only
// behavioural tests here are `RateLimiter` unit tests on a pure struct. So
// EG2-8's "every party monster, not just the lead" cannot be observed by
// EXECUTING `enqueue_move` in this crate; it is carried by the loop-shape pin in
// `enqueue_move_body_loops_party_growth_tails` below, which reads the loop's
// binding and both call arguments rather than merely checking that the two
// helpers are mentioned somewhere. That is stated as a limit, not sold as
// equivalent to a behavioural test.
//
// Needles are assembled from fragments (house rule), so no needle exists verbatim
// in this file and neither this scan nor any eval that concatenates the crate's
// sources can be satisfied by the test's own text.
// ===========================================================================

/// The interior of the balanced parenthesis group that OPENS at or after `from`.
///
/// Safe on the STRING-BLANKED squash only (the same precondition [`brace_body`]
/// carries): a parenthesis inside a live log format string would otherwise
/// corrupt the count. Used to read a call's ARGUMENT LIST, so the EG2 pins below
/// can say which id the two growth helpers are handed instead of only that they
/// are mentioned nearby.
fn paren_interior(src: &str, from: usize) -> Option<&str> {
    let bytes = src.as_bytes();
    let open = from + src[from..].find('(')?;
    let mut depth: usize = 0;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&src[open + 1..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// `expr` with any leading borrow / deref / `mut` decoration stripped, so
/// `&mut id`, `&id`, `*id` and `id` all reduce to `id`.
///
/// Whitespace is already squashed out by the time this runs, so `&mut id` arrives
/// as one token. The point is to compare a loop BINDING with a call ARGUMENT
/// without pinning which of the four equivalent spellings the implementer picked.
fn ident_of(expr: &str) -> &str {
    let deref = |c: char| c == '&' || c == '*';
    let mut s = expr.trim_start_matches(deref);
    if let Some(rest) = s.strip_prefix("mut") {
        if !rest.is_empty() {
            s = rest;
        }
    }
    s.trim_start_matches(deref)
}

/// The first and second argument of the call whose name starts at `at`.
///
/// The split is on the FIRST comma, which is sound here because every call this
/// section inspects takes `ctx` as its first argument — a fact the callers assert
/// explicitly rather than assume.
fn first_two_args(body: &str, at: usize) -> (String, String) {
    let interior = paren_interior(body, at).unwrap_or("");
    let mut parts = interior.splitn(2, ',');
    let first = parts.next().unwrap_or("").to_string();
    let second = parts.next().unwrap_or("").to_string();
    (first, second)
}

/// **EG2-8 + EG2-12** — `enqueue_move` must resolve the caller's WHOLE active
/// party and run both growth tails once per party monster, after its own
/// character write.
///
/// **12r-e RE-POINT (E2).** The party-resolution needle in this test now targets
/// `lead_party_ids(`, NOT `lead_party(`. `enqueue_move` no longer needs the lead's
/// level (it drives the growth tails over the id list only), and `lead_party`
/// returns `None` for the WHOLE party if the lead's level byte will not parse —
/// which would silently disable Quality Time and auto-evolution for every party
/// monster on every move. The negative half of the re-point (`lead_party(` must
/// appear ZERO times in this body) lives in
/// [`enqueue_move_growth_tail_does_not_depend_on_the_lead_level`]; WITHOUT that
/// test this re-point would be a pure weakening, because an implementation that
/// called BOTH helpers would satisfy every needle here.
///
/// kills:
///   * **lead-only crediting** — `accrue_quality_time(ctx, ids[0])` with no loop,
///     the single most likely simplification. `Character` carries no monster
///     reference, so the party has to be resolved through `lead_party_ids`, and
///     the sibling `lead_party` also hands back the LEAD's level — reaching for
///     slot 0 is one keystroke away. It would silently mean only the lead accrues
///     Quality Time, so every non-lead party member's Quality-Time gate stays
///     frozen at 0 forever and its evolution never fires. EG2-8 says the full id
///     list, in Drew's own words. Layer 5 catches it by requiring the loop binding
///     and the two call arguments to be the SAME identifier.
///   * **pre-update placement** — tails hoisted above
///     `ctx.db.character().entity_id().update(..)`. The queue write and the growth
///     credits then live on opposite sides of the reducer's own commit point, and
///     an auto-evolution triggered from the tail would run before the movement
///     intent it was credited for was even persisted.
///   * **inverted tails** — the auto-evolution check before the accrual. EG2-12
///     makes the check the LAST step after every gate-relevant mutation, and
///     Quality Time is itself one of the five gate factors, so checking first can
///     leave a monster that just crossed a tier boundary un-evolved until some
///     unrelated later action (contradicting EG2-1's "the instant it becomes
///     eligible").
///   * **mismatched ids** — accruing for one monster and evolution-checking
///     another (layer 5's equality assertion).
///
/// RED BY SCAN at HEAD: `enqueue_move` calls neither helper and never touches
/// the party resolver.
///
/// HONEST LIMITS. (a) This is a source scan, not an execution: it proves the loop
/// is WRITTEN over the resolved id list, never that `lead_party_ids` returned
/// every party member at runtime — that is the helper's own contract, pinned
/// structurally by `battle_tests.rs::lead_party_ids_does_not_parse_a_level`.
/// (b) Layer 5 accepts `for id in ..`, `for &id in ..`,
/// `for mut id in ..` and `for &mut id in ..`, but not a `.for_each(..)` or an
/// index loop; those would false-RED. The `for` loop is the sanctioned shape
/// (ADR-0175 D3) and the failure message says so. (c) Every needle here is
/// position- or token-based, never whole-block, so the trade-escrow SKIP that
/// [`enqueue_move_skips_trade_escrowed_party_monsters`] requires between the loop
/// binding and the first credit does NOT disturb any of them — the two tests are
/// jointly satisfiable and the sketch above that test proves it line by line.
#[test]
fn enqueue_move_body_loops_party_growth_tails() {
    let squashed = squashed_movement();

    let enqueue_marker = ["pubfn", "enqueue", "_move("].concat();
    let n_marker = squashed.matches(enqueue_marker.as_str()).count();
    assert_eq!(
        n_marker, 1,
        "SCAN PRECONDITION (EG2-8): `pubfnenqueue_move(` must appear EXACTLY ONCE in \
         the squashed `movement.rs`; found {n_marker}. With zero the body cannot be \
         extracted at all; with two, the brace-matched extractor takes the FIRST \
         match and a decoy could carry the sanctioned loop while the real reducer \
         credits nothing — every assertion below would be untrustworthy."
    );
    let body = brace_body(&squashed, enqueue_marker.as_str());

    // 12r-e RE-POINT (E2): `_party_ids(`, not `_party(` — see the doc block above.
    let lead = ["lead", "_party_ids("].concat();
    let accrue = ["accrue_quality", "_time("].concat();
    let evolve_check = ["check_and", "_evolve("].concat();
    let char_update = ["character().entity_id()", ".update("].concat();

    // --- Layer 1: all four anchors exist inside enqueue_move's own body ------
    let update_at = body.find(char_update.as_str()).unwrap_or_else(|| {
        panic!(
            "SCAN PRECONDITION (EG2-8): `enqueue_move`'s character update \
             (`ctx.db.character().entity_id().update(..)`) is missing — the \
             placement assertions below have no anchor."
        )
    });
    let lead_at = body.find(lead.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-8 + 12r-e E2): `enqueue_move` must resolve the caller's \
             active party through `lead_party_ids(ctx, ctx.sender)` — the id-only \
             helper. RED at HEAD: it calls `lead_party(` instead, which additionally \
             parses the LEAD's level and returns `None` for the WHOLE party if that \
             byte is out of range, silently disabling both growth tails for every \
             party monster on every move. `Character` carries no monster reference, \
             so the party is the ONLY way to know which monsters this movement is \
             playtime WITH; a `None` return (no party) must simply credit nothing."
        )
    });
    let accrue_at = body.find(accrue.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-8): `enqueue_move` must call the Quality-Time accrual — it is \
             one of the mandated DIRECT call sites, and the ONE genuinely \
             player-triggered movement reducer live in the shipped client. RED at \
             HEAD: it calls nothing of the kind."
        )
    });
    let check_at = body.find(evolve_check.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-12): `enqueue_move` must call the auto-evolution check as its \
             LAST step, once per party monster. RED at HEAD: it calls nothing of the \
             kind."
        )
    });

    // --- Layer 2: the tails run AFTER the reducer's own character write ------
    assert!(
        update_at < accrue_at,
        "TEETH (EG2-8): the Quality-Time accrual is at body byte {accrue_at}, BEFORE \
         the character update at {update_at}. Both growth tails belong AFTER the \
         reducer's own write: they are tails, not preconditions, and an \
         auto-evolution triggered from a hoisted tail would fire before the movement \
         intent it was credited for is persisted."
    );
    assert!(
        update_at < check_at,
        "TEETH (EG2-12): the auto-evolution check is at body byte {check_at}, BEFORE \
         the character update at {update_at}. EG2-12 makes it the LAST step of the \
         reducer, after that reducer's own mutation."
    );

    // --- Layer 3: accrual first, evolution check last ------------------------
    assert!(
        accrue_at < check_at,
        "TEETH (EG2-12): the auto-evolution check (byte {check_at}) must run AFTER \
         the Quality-Time accrual (byte {accrue_at}). Quality Time is itself one of \
         the five evolution gate factors, so a check that runs first evaluates the \
         PRE-accrual tier and can leave a monster that just crossed a tier boundary \
         un-evolved until some unrelated later action."
    );

    // --- Layer 4: the party is resolved before anything is credited ----------
    assert!(
        lead_at < accrue_at,
        "TEETH (EG2-8): `{lead}` appears at body byte {lead_at}, AFTER the first \
         growth credit at {accrue_at}. The party lookup is what decides WHICH \
         monsters are credited; a credit written before it cannot be looping over \
         the returned ids."
    );

    // --- Layer 5: the SAME id, and it is a loop binding over the party ------
    let (accrue_ctx, accrue_id) = first_two_args(body, accrue_at);
    let (check_ctx, check_id) = first_two_args(body, check_at);
    assert_eq!(
        accrue_ctx, "ctx",
        "TEETH (EG2-8): the Quality-Time accrual's first argument is `{accrue_ctx}`, \
         not `ctx` — the helper takes the ReducerContext first. (This also makes the \
         second-argument split below sound.)"
    );
    assert_eq!(
        check_ctx, "ctx",
        "TEETH (EG2-12): the auto-evolution check's first argument is `{check_ctx}`, \
         not `ctx` — the helper takes the ReducerContext first."
    );
    assert_eq!(
        ident_of(&accrue_id),
        ident_of(&check_id),
        "TEETH (EG2-8/EG2-12): the accrual is called with `{accrue_id}` but the \
         auto-evolution check with `{check_id}`. Both tails must run for the SAME \
         monster on each iteration — crediting one monster's Quality Time and then \
         checking a different monster's eligibility means the monster that just \
         earned the tick is never re-evaluated, and EG2-1's automatic evolution \
         silently never fires for it."
    );

    let loop_var = ident_of(&accrue_id).to_string();
    assert!(
        !loop_var.is_empty(),
        "TEETH (EG2-8): the Quality-Time accrual was called with no second argument \
         at all — it takes the monster id to credit."
    );
    let between = &body[lead_at..accrue_at];
    let mut loop_forms: Vec<String> = Vec::new();
    for prefix in ["", "&", "mut", "&mut"] {
        loop_forms.push(["for", prefix, loop_var.as_str(), "in"].concat());
    }
    let looped = loop_forms.iter().any(|f| between.contains(f.as_str()));
    assert!(
        looped,
        "TEETH (EG2-8): between `{lead}` and the first growth credit there is no \
         `for {loop_var} in ..` loop — so `{loop_var}` is not a loop binding over the \
         returned party id list and only ONE monster is being credited. This is the \
         lead-only mutant, and it is the most likely simplification of this call \
         site: the helper hands back the whole slot-ordered `Vec<u64>`, so \
         `accrue_quality_time(ctx, ids[0])` compiles, reads fine, and quietly freezes \
         every non-lead party member's Quality-Time gate at 0 forever — their \
         evolution can then never fire. EG2-8 is explicit: loop over the FULL \
         returned id list, not the lead, matching Drew's directive wording \
         (\"playtime with the monster actively in the party\"). \
         Accepted spellings: `for id in ..`, `for &id in ..`, `for mut id in ..`, \
         `for &mut id in ..`; a `.for_each(..)` or an index loop would false-RED — \
         the `for` loop is the sanctioned shape."
    );
}

// ---------------------------------------------------------------------------
// ONE `enqueue_move` tail shape that satisfies EVERY movement scan at once.
//
// Written out because these tests are not editable by the implementer, so joint
// satisfiability has to be demonstrated rather than asserted. Only the tail is
// shown; everything above it (the ADR-0168 D2 battle-guard reject, the
// `authorize_move` call, the MOVE_QUEUE_CAP reject, the push and the character
// update) is unchanged:
//
//       ctx.db.character().entity_id().update(ch);              [UP]
//
//       // EG2-8/EG2-12 growth tails. Trade escrow (TR-6, ADR-0106): an escrowed
//       // party monster KEEPS its party slot until settlement, so without the
//       // skip it would keep accruing Quality Time and could AUTO-EVOLVE while
//       // the counterparty is looking at a propose-time card snapshot that
//       // confirm_trade never revalidates. Skip the monster; never reject the
//       // move (a pending trade must not freeze the player in place).
//       // 12r-e E2: the ID-ONLY resolver. `lead_party` would additionally parse
//       // the LEAD's level and return None for the WHOLE party if it is out of
//       // range — silently killing both tails for every party monster.
//       if let Some(party_ids) = lead_party_ids(ctx, ctx.sender) {       [L]
//           let escrowed: Vec<u64> = ctx.db.trade_offer()               [T]
//               .initiator().filter(ctx.sender)                          [I]
//               .chain(ctx.db.trade_offer().counterparty()               [C]
//                          .filter(ctx.sender))
//               ..active-offer filter + both monster-id lists.., collect();
//           for mid in party_ids {                                       [F]
//               if escrowed.contains(&mid) { continue; }                 [S]
//               accrue_quality_time(ctx, mid);                           [A]
//               check_and_evolve(ctx, mid);                              [K]
//           }
//       }
//       Ok(())
//
// The escrow set is collected INSIDE the `if let`, after [L], on purpose: a
// caller with no party pays zero trade-offer index reads, and this is the hottest
// player-triggered reducer in the game (roughly one call per tile-step while a
// key is held).
//
// Check against every movement assertion:
//   enqueue_move_reject_paths_precede_tails ... both rejects are above [L]   OK
//   enqueue_move_body_loops_party_growth_tails
//        [UP] < [A] and [UP] < [K]; [A] < [K]; [L] < [A];
//        both calls take (ctx, mid); `formidin` sits in [L]..[A]            OK
//   enqueue_move_skips_trade_escrowed_party_monsters
//        [T]/[I]/[C] all sit in [L]..[A]; [F]..[A] holds `contains(`
//        and `continue` and no `return`                                     OK
//   enqueue_move_growth_tail_does_not_depend_on_the_lead_level
//        [L] is `lead_party_ids(` exactly once and `lead_party(` zero times
//        (the two needles are disjoint: the byte after `lead_party` is `_`
//        in one and `(` in the other)                                       OK
//   movement_tick_body_never_calls_growth_triggers ... untouched reducers    OK
// And the pre-existing movement gates still hold: `is_in_ongoing_battle(`
// stays at 4 file-wide (the tail adds none), `battle()` stays at 1 (the tail
// reads `trade_offer()`, not `battle()`), and `clear_queue`'s body pin is
// untouched.
// ---------------------------------------------------------------------------

/// **TR-6 / ADR-0106 (trade integrity)** — the growth tail must SKIP party
/// monsters that are escrowed in an active trade offer.
///
/// kills: the unfiltered tail loop — the HIGH finding from implementation review.
/// A monster escrowed in a `Pending` / `ConfirmedByCounterparty` offer KEEPS its
/// party slot until settlement (`trading.rs:650`), so an unfiltered loop keeps
/// crediting it Quality Time and can AUTO-EVOLVE it mid-offer. The counterparty is
/// looking at a propose-time `MonsterCard` snapshot and `confirm_trade` never
/// revalidates the card, so the trade settles on a monster that is no longer the
/// one advertised: a bait-and-switch that needs no exploit, just patience and a
/// walk. Every other growth call site already guards escrow — `care`, `train`,
/// `essence_train` and `consume_crystalized_essence` each guard their ONE monster
/// via `reject_if_monster_in_trade`, and battle entry escrow-guards the whole
/// party — so this loop is the only unguarded growth path in the tree.
///
/// Two layers (the second carries three assertions):
///
/// **12r-e RE-POINT (E2).** The window's left edge is now `lead_party_ids(`, not
/// `lead_party(` — `enqueue_move` no longer resolves the party through the helper
/// that parses the lead's level. This is a pure anchor move: the window it opens
/// is the same statement in the same reducer. The negative that keeps the
/// re-point from hollowing this scan (`lead_party(` must appear ZERO times in
/// this body) is asserted by
/// [`enqueue_move_growth_tail_does_not_depend_on_the_lead_level`].
///
/// * **(a) the escrow set is collected from BOTH trade roles, before the loop.**
///   `trade_offer()`, `initiator()` and `counterparty()` must each appear after
///   the party resolution and before the first growth credit. Both index reads are pinned
///   because an initiator-only (or counterparty-only) collection leaves half of
///   all offers unguarded — the same both-roles chain `care` spells at
///   `raising.rs:96-103`, which is also why this survives the likely refactor into
///   a `guards.rs` helper: in that pattern the CALL SITE builds the iterator and
///   the helper only owns the active-offer filter.
///
/// * **(b) the skip is a per-id SKIP, not a reject.** Between the loop binding and
///   the first credit there must be a membership test (`contains(`) and a
///   `continue`, and there must be NO `return`. The negative is not decorative:
///   rejecting the MOVE when a party monster is escrowed would freeze the player
///   in place for the entire life of a trade offer — a far worse bug than the one
///   being fixed, and a tempting one-liner for anyone reaching for the existing
///   `reject_if_monster_in_trade` guard.
///
/// RED at HEAD (and red against the first implementation): `enqueue_move`'s body
/// contains no `trade_offer` read at all, and its tail loop has no skip.
///
/// HONEST LIMITS. (a) TEXTUAL — this proves the skip SHAPE exists, never that the
/// collected set is correct. Set-collection correctness rides on the pinned
/// `trade_offer().initiator()` / `.counterparty()` chain being the same shape the
/// four escrow-guarded reducers already use, plus `TradeStatus::is_active`'s own
/// tests; a scan cannot see which ids end up in the set. (b) `is_active()` is
/// deliberately NOT pinned: the moment this is factored into a `guards.rs` helper
/// (mirroring `escrowed_item_qty`), the active-offer filter moves out of this body
/// and the needle would false-RED an improvement. (c) The `continue` spelling is
/// pinned as the sanctioned shape; an equivalent
/// `for mid in ids.into_iter().filter(|id| !escrowed.contains(id))` would
/// false-RED. See the sketch above — it is the shape to write.
#[test]
fn enqueue_move_skips_trade_escrowed_party_monsters() {
    let squashed = squashed_movement();
    let enqueue_marker = ["pubfn", "enqueue", "_move("].concat();
    let body = brace_body(&squashed, enqueue_marker.as_str());

    // 12r-e RE-POINT (E2): `_party_ids(`, not `_party(` — see the doc block above.
    let lead = ["lead", "_party_ids("].concat();
    let accrue = ["accrue_quality", "_time("].concat();

    let lead_at = body.find(lead.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (TR-6 + 12r-e E2): `enqueue_move` must resolve the party via \
             `lead_party_ids(` — the id-only helper that cannot be knocked out by an \
             unparseable LEAD level. RED at HEAD: it calls `lead_party(` instead."
        )
    });
    let accrue_at = body.find(accrue.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (TR-6): `enqueue_move` has no growth credit to filter — see \
             enqueue_move_body_loops_party_growth_tails."
        )
    });

    // --- (a) both trade roles, collected between the party lookup and the loop
    let offers = ["trade", "_offer()"].concat();
    let initiator = ["initiator", "()"].concat();
    let counterparty = ["counterparty", "()"].concat();
    for needle in [offers.as_str(), initiator.as_str(), counterparty.as_str()] {
        let at = body.find(needle).unwrap_or_else(|| {
            panic!(
                "TEETH (TR-6, HIGH): `enqueue_move`'s growth tail never reads \
                 `{needle}`, so it credits Quality Time to — and can AUTO-EVOLVE — a \
                 party monster that is escrowed in an active trade offer. An \
                 escrowed monster keeps its party slot until settlement \
                 (trading.rs:650), the counterparty sees only the propose-time \
                 MonsterCard snapshot, and confirm_trade never revalidates it: the \
                 trade settles on a monster that silently changed species. Collect \
                 the caller's escrowed ids from BOTH roles \
                 (`trade_offer().initiator().filter(ctx.sender)` chained with \
                 `trade_offer().counterparty().filter(ctx.sender)` — the same shape \
                 `care` uses at raising.rs:96-103) and skip those ids in the loop. \
                 RED at HEAD: `enqueue_move` reads no trade offers at all."
            )
        });
        assert!(
            lead_at < at && at < accrue_at,
            "TEETH (TR-6): `{needle}` is at body byte {at}, outside the window \
             between the party lookup ({lead_at}) and the first growth credit \
             ({accrue_at}). The escrowed-id set must be collected ONCE, after the \
             party is resolved and before the loop that credits it — inside the \
             `if let Some(party_ids) = lead_party_ids(..)` arm, so a caller with no \
             party pays no trade-offer index reads at all (this is the hottest \
             player-triggered reducer in the game, roughly one call per tile-step \
             while a key is held). HONEST LIMIT: hoisting the collection ABOVE \
             `{lead}` is semantically equivalent and would false-RED here; the \
             sketch above this test fixes collect-after-resolve as the sanctioned \
             shape."
        );
    }

    // --- (b) the skip is a per-id SKIP, not a reject -------------------------
    let (_, accrue_id) = first_two_args(body, accrue_at);
    let loop_var = ident_of(&accrue_id).to_string();
    let between = &body[lead_at..accrue_at];
    let mut for_rel: Option<usize> = None;
    for prefix in ["", "&", "mut", "&mut"] {
        let form = ["for", prefix, loop_var.as_str(), "in"].concat();
        if let Some(rel) = between.find(form.as_str()) {
            for_rel = Some(rel);
            break;
        }
    }
    let for_rel = for_rel.unwrap_or_else(|| {
        panic!(
            "TEETH (TR-6): no `for` loop over the party ids was found before the \
             first growth credit — see enqueue_move_body_loops_party_growth_tails, \
             which owns that pin."
        )
    });
    let for_at = lead_at + for_rel;
    let window = &body[for_at..accrue_at];

    let membership = ["cont", "ains("].concat();
    assert!(
        window.contains(membership.as_str()),
        "TEETH (TR-6, HIGH): between the loop binding and the first growth credit \
         there is no `contains(` membership test — the loop credits EVERY party id, \
         escrowed or not. That is the trade bait-and-switch: a monster escrowed in a \
         Pending offer keeps accruing Quality Time and can auto-evolve out from \
         under the propose-time MonsterCard the counterparty accepted, which \
         confirm_trade never revalidates. Test each id against the escrowed set \
         collected above the loop."
    );

    let skip = ["cont", "inue"].concat();
    assert!(
        window.contains(skip.as_str()),
        "TEETH (TR-6): the escrow check between the loop binding and the first \
         growth credit does not `continue`. An escrowed monster must be SKIPPED, \
         with the loop carrying on to the rest of the party. HONEST LIMIT: an \
         equivalent `ids.into_iter().filter(|id| !escrowed.contains(id))` would \
         false-RED — write the `continue` skip shown in the sketch above this test."
    );

    let reject = ["ret", "urn"].concat();
    let n_reject = window.matches(reject.as_str()).count();
    assert_eq!(
        n_reject, 0,
        "TEETH (TR-6): the escrow check between the loop binding and the first \
         growth credit contains {n_reject} `return` statement(s); it must contain \
         ZERO. An escrowed party monster must SKIP its credit, never reject the \
         MOVE: rejecting would freeze the player in place for the entire life of a \
         trade offer — strictly worse than the bug being fixed, and a tempting \
         one-liner for anyone reaching for the existing `reject_if_monster_in_trade` \
         guard, which is built to REJECT and is the wrong tool here. (It is also the \
         wrong tool for a second reason: it takes one monster_id and would re-scan \
         every trade offer once per party member on the hottest reducer in the \
         game.)"
    );
}

/// **EG2-9 (hard invariant)** — the scheduled reducer must NEVER call the growth
/// triggers, and neither may the two movement reducers that are not the sanctioned
/// call site.
///
/// GREEN AT HEAD (nothing calls them yet) and green after the slice — this is a
/// FENCE, and it is the movement-local half of EG2-9's proof-of-teeth. It is a
/// separate `#[test]` for the reason recorded at line ~917: folded into the
/// enqueue_move test it would sit behind assertions that fail at HEAD and could
/// never be observed passing.
///
/// RELATIONSHIP TO THE SIBLING GATE (not a duplicate — read before deleting
/// either). `evolution_tests.rs`'s `eg2_9_no_scheduled_reducer_body_calls_growth_triggers`
/// owns the CROSS-FILE version: it discovers every
/// `#[spacetimedb::table(.. scheduled(..))]` reducer in the crate and bans both
/// helpers from all of them, with vacuity guards. This test is narrower and wider
/// at once: narrower in that it only reads `movement.rs` (a local canary sitting
/// next to the reducer an implementer is actually editing, and one that survives a
/// rotted attribute scanner), and wider in that `set_move` and `clear_queue` are
/// NOT scheduled reducers, so nothing else in the tree holds them to this rule.
///
/// kills: wiring the hooks into `movement_tick` — which is exactly where a
/// well-meaning implementer would put them, because `movement_tick` is where
/// tile-entry is ACTUALLY detected (position, warps and grass encounters are all
/// computed there, one queued move drained per character per 200 ms). It is a
/// SCHEDULED reducer that rejects any caller but the scheduler itself, so a player
/// could enqueue two moves, walk away, and have growth credited on a timer forever
/// — the precise afk-farming vulnerability `no-idle-accrual.eval.mjs` Check B
/// exists to close. `enqueue_move` is the correct site instead: a real keydown (or
/// a hold-continuation already gated on the key being physically held >= 150 ms),
/// backpressure-throttled to roughly once per tile-step, so it does not fire
/// per-frame in effect.
///
/// `set_move` and `clear_queue` are asserted clean too, for opposite reasons:
///   * `set_move` is a genuine new-movement-intent event of the same shape as
///     `enqueue_move` and WOULD need the same hook — but it has no production
///     caller today (a `main.ts` regression test forbids one after a reverted
///     attempt measured up to 1.75 tiles of backward teleport and permanent
///     desync), so hooking it now would add an unreachable, untested credit path.
///     If it is ever reactivated in the client, wire the same two tails there and
///     update this test DELIBERATELY, in the same PR.
///   * `clear_queue` never would: cancelling movement is not new engagement worth
///     crediting, and it is deliberately left unguarded (ADR-0168 D3).
///
/// HONEST LIMIT: this pins DIRECT calls only, matching `no-idle-accrual` Check B's
/// actual semantics. `movement_tick` remains transitively able to reach the battle
/// write-back through the grass-encounter path, and that is fine — EG2-7 gates
/// every credit there to wild battles, which is the real mechanism, not a
/// callgraph check.
#[test]
fn movement_tick_body_never_calls_growth_triggers() {
    let squashed = squashed_movement();

    let accrue = ["accrue_quality", "_time("].concat();
    let evolve_check = ["check_and", "_evolve("].concat();

    // --- The scheduled reducer -----------------------------------------------
    let tick_marker = ["pubfn", "movement", "_tick("].concat();
    let n_tick = squashed.matches(tick_marker.as_str()).count();
    assert_eq!(
        n_tick, 1,
        "SCAN PRECONDITION (EG2-9): `pubfnmovement_tick(` must appear EXACTLY ONCE; \
         found {n_tick}. With zero, this fence would extract nothing and pass \
         vacuously while the scheduled reducer credits growth on a timer."
    );
    let tick_body = movement_tick_body(&squashed);
    let n_tick_accrue = tick_body.matches(accrue.as_str()).count();
    assert_eq!(
        n_tick_accrue, 0,
        "TEETH (EG2-9, green at HEAD): `movement_tick`'s body calls the Quality-Time \
         accrual {n_tick_accrue} time(s); it must call it ZERO times. `movement_tick` \
         is SCHEDULED (`ScheduleAt::Interval`, scheduler-only) — it is where \
         tile-entry is actually detected, which is exactly why this is the tempting \
         wrong place. A player could enqueue moves, walk away, and the 200 ms tick \
         would keep crediting growth with no further engagement: the afk-farming \
         vulnerability `no-idle-accrual.eval.mjs` Check B exists to close. The \
         sanctioned site is `enqueue_move` — a genuinely player-triggered reducer."
    );
    let n_tick_check = tick_body.matches(evolve_check.as_str()).count();
    assert_eq!(
        n_tick_check, 0,
        "TEETH (EG2-9, green at HEAD): `movement_tick`'s body calls the \
         auto-evolution check {n_tick_check} time(s); it must call it ZERO times. \
         Same reasoning as the accrual above — and the check is listed in \
         GROWTH_WRITERS for precisely this reason, so that a scheduled reducer \
         calling it is mechanically forbidden even though the check writes nothing \
         itself."
    );

    // --- set_move: same shape as enqueue_move, but no production caller -------
    let set_marker = ["pubfn", "set", "_move("].concat();
    let n_set = squashed.matches(set_marker.as_str()).count();
    assert_eq!(
        n_set, 1,
        "SCAN PRECONDITION (EG2-9): `pubfnset_move(` must appear EXACTLY ONCE; found \
         {n_set}."
    );
    let set_body = brace_body(&squashed, set_marker.as_str());
    let n_set_accrue = set_body.matches(accrue.as_str()).count();
    let n_set_check = set_body.matches(evolve_check.as_str()).count();
    let n_set_growth = n_set_accrue + n_set_check;
    assert_eq!(
        n_set_growth, 0,
        "TEETH (EG2-9, green at HEAD): `set_move`'s body contains {n_set_growth} \
         growth-trigger call(s); it must contain ZERO in THIS slice. `set_move` is a \
         genuine new-movement-intent event of the same shape as `enqueue_move` and \
         WOULD need the same two tails — but it has no production caller today (a \
         `main.ts` regression test forbids one, after a reverted attempt at this \
         exact approach measured up to 1.75 tiles of backward teleport and permanent \
         desync), so hooking it now ships an unreachable, untested credit path. If \
         `set_move` is ever reactivated in the client, add the same tails and update \
         this assertion DELIBERATELY, in that same PR."
    );

    // --- clear_queue: cancellation is not engagement --------------------------
    let clear_marker = ["pubfn", "clear", "_queue("].concat();
    let n_clear = squashed.matches(clear_marker.as_str()).count();
    assert_eq!(
        n_clear, 1,
        "SCAN PRECONDITION (EG2-9): `pubfnclear_queue(` must appear EXACTLY ONCE; \
         found {n_clear}."
    );
    let clear_body = brace_body(&squashed, clear_marker.as_str());
    let n_clear_accrue = clear_body.matches(accrue.as_str()).count();
    let n_clear_check = clear_body.matches(evolve_check.as_str()).count();
    let n_clear_growth = n_clear_accrue + n_clear_check;
    assert_eq!(
        n_clear_growth, 0,
        "TEETH (EG2-9, green at HEAD): `clear_queue`'s body contains \
         {n_clear_growth} growth-trigger call(s); it must contain ZERO, now and \
         later. Cancelling movement is not new engagement worth crediting — unlike \
         `set_move`, this reducer will NEVER need the hook, and adding one would let \
         a client mint Quality-Time credit by spamming key-release with no movement \
         at all. (`clear_queue` is also deliberately left un-battle-guarded, \
         ADR-0168 D3 — do not 'complete the symmetry' here either.)"
    );
}

/// **EG2-8 (rejection paths)** — a REJECTED move credits nothing.
///
/// kills: tails hoisted above `enqueue_move`'s two rejects. Both rejects
/// `return Err(..)`, which rolls the whole SpacetimeDB transaction back — so the
/// credit would be rolled back too, and this is a defence-in-depth ordering pin
/// rather than a live exploit. What it really protects is the shape: the growth
/// tails must sit on the SUCCESS path, after the character write, where a future
/// refactor that turns a reject into a logged no-op (the `movement_tick`
/// per-character philosophy, already used elsewhere in this file) cannot silently
/// convert "rejected move" into "free Quality Time". The queue-full reject is the
/// one that matters most: it is exactly what a key-spamming client hits, so a
/// pre-reject credit would make flooding `enqueue_move` the CHEAPEST way to farm
/// Quality Time — strictly better for the attacker than actually walking.
///
/// **12r-e RE-POINT (E2).** The tail anchor is now `lead_party_ids(`, not
/// `lead_party(`: `enqueue_move`'s growth tail must not be gated on the lead
/// monster's level parsing. Pure anchor move — the ordering property is
/// unchanged. Paired with
/// [`enqueue_move_growth_tail_does_not_depend_on_the_lead_level`], which supplies
/// the negative (`lead_party(` count == 0 in this body) that stops the re-point
/// from being a weakening.
///
/// RED BY SCAN at HEAD: `lead_party_ids(` does not appear in `enqueue_move` (the
/// helper does not exist yet).
///
/// HONEST LIMIT: textual order inside one body, not execution order under every
/// control-flow shape. Both rejects are unconditional `return`s at the top of the
/// reducer, so the two coincide here.
#[test]
fn enqueue_move_reject_paths_precede_tails() {
    let squashed = squashed_movement();
    let enqueue_marker = ["pubfn", "enqueue", "_move("].concat();
    let body = brace_body(&squashed, enqueue_marker.as_str());

    // 12r-e RE-POINT (E2): `_party_ids(`, not `_party(` — see the doc block above.
    let lead = ["lead", "_party_ids("].concat();
    let lead_at = body.find(lead.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH (EG2-8 + 12r-e E2): `enqueue_move` must resolve the party via \
             `lead_party_ids(` before crediting anything. RED at HEAD: it calls \
             `lead_party(`, whose lead-level parse can return `None` for the whole \
             party."
        )
    });

    let ssot = ["is_in_ongoing", "_battle("].concat();
    let ssot_at = body.find(ssot.as_str()).unwrap_or_else(|| {
        panic!(
            "SCAN PRECONDITION (EG2-8 / ADR-0168 D2): `enqueue_move`'s battle-guard \
             reject vanished — see e2_intake_rejects_movement_intent_during_an_ongoing_battle."
        )
    });
    assert!(
        ssot_at < lead_at,
        "TEETH (EG2-8): the battle-guard reject is at body byte {ssot_at}, AFTER the \
         party resolution at {lead_at}. A move rejected because the caller is in an \
         ongoing battle must credit nothing at all — the growth tails belong on the \
         success path, below both rejects and below the character write."
    );

    let cap = ["MOVE_QUEUE", "_CAP"].concat();
    let cap_at = body.find(cap.as_str()).unwrap_or_else(|| {
        panic!(
            "SCAN PRECONDITION (EG2-8): `enqueue_move`'s queue-full reject \
             (`MOVE_QUEUE_CAP`) vanished — the anti-flood bound is what makes the \
             ordering assertion below meaningful."
        )
    });
    assert!(
        cap_at < lead_at,
        "TEETH (EG2-8): the queue-full reject is at body byte {cap_at}, AFTER the \
         party resolution at {lead_at}. This is the reject a key-spamming client \
         actually hits: with the credit above it, flooding `enqueue_move` would \
         become the cheapest possible way to farm Quality Time — strictly better \
         than walking. Keep both growth tails on the success path."
    );
}

// ===========================================================================
// 12r-e ITEM 2 / EARS E2 — `enqueue_move`'s growth tail must not be gated on
// the LEAD monster's level parsing.
//
// This test is the MATCHED PAIR of the three `lead_party(` -> `lead_party_ids(`
// re-points above (in `enqueue_move_body_loops_party_growth_tails`,
// `enqueue_move_skips_trade_escrowed_party_monsters` and
// `enqueue_move_reject_paths_precede_tails`). Those three are POSITIVE needles:
// on their own, a body that called BOTH helpers would satisfy every one of them
// while `lead_party`'s `None` still short-circuited the tail — i.e. the re-point
// alone HOLLOWS them out. The negative assertion below is the only thing that
// makes the re-point a strengthening rather than a weakening, which is why the
// two changes must never be reviewed apart.
//
// A second `battle.rs` cross-check rides here, deliberately in the same test:
// `lead_party` must DELEGATE to `lead_party_ids` rather than re-run the owner
// query itself. Without it the tree could end up with two independent
// definitions of "the party", free to drift on slot ordering or on the
// `party_slot != PARTY_SLOT_NONE` filter — and `ids[0]` being the lead is
// exactly the invariant `lead_party` relies on for its point-read. The other
// half of the direction pin (`lead_party_ids` must not call `lead_party`) is in
// `battle_tests.rs::lead_party_ids_does_not_parse_a_level`.
// ===========================================================================

/// `battle.rs`, read from this module so the movement-side re-point and the
/// battle-side delegation pin can live in one test.
const BATTLE_RS_FOR_E2: &str = include_str!("battle.rs");

/// `battle.rs` with comments AND string literals blanked and all whitespace
/// squashed — the same treatment [`squashed_movement`] gives `movement.rs`,
/// including the loud stripper preconditions.
fn squashed_battle_for_e2() -> String {
    let stripped = strip_comments_and_strings(BATTLE_RS_FOR_E2);
    assert_stripper_preconditions(BATTLE_RS_FOR_E2, &stripped);
    stripped.split_whitespace().collect()
}

/// **12r-e E2** — `enqueue_move` resolves the party through the ID-ONLY helper,
/// and the party query has exactly ONE definition.
///
/// THE DEFECT. `battle.rs:293` does `let lead_level = Level::new(lead.level).ok()?;`
/// — a silent `None` for the WHOLE party when the LEAD's stored level byte is
/// outside 1..=100. `movement.rs:150` consumes that as "no party" and skips
/// `accrue_quality_time` + `check_and_evolve` for EVERY party monster on EVERY
/// move. Five healthy monsters lose Quality Time and auto-evolution because of
/// one corrupt byte on a sixth, and nothing is logged. Not reachable today (every
/// `Monster.level` writer goes through `Level::new`) — this is the ADR-0175
/// Consequences (4) defense-in-depth fix.
///
/// Three layers:
///
/// 1. **`lead_party_ids(` exactly once** in `enqueue_move`'s body. Not "at least
///    once": two resolutions would mean two different id lists could be credited
///    and skipped inconsistently against one escrow set.
/// 2. **`lead_party(` exactly zero times** in the same body — THE tooth. The two
///    needles are cleanly disjoint: `lead_party(` is not a substring of
///    `lead_party_ids(`, because the byte after `lead_party` is `(` in one and
///    `_` in the other. So an implementation that keeps the old call beside the
///    new one is caught, and so is one that "resolves ids" but re-derives the
///    level from `lead_party` for some tail check.
/// 3. **`lead_party` delegates** (scanned in `battle.rs`): its body must call
///    `lead_party_ids(` exactly once and must NOT contain the owner index
///    `owner_identity()`. That is the no-duplicate-query rule and, together with
///    layer 2 of `lead_party_ids_does_not_parse_a_level`, it pins the dependency
///    DIRECTION from both ends — closing the verified red-team mirror image in
///    which `lead_party_ids` is a thin wrapper over `lead_party` and nothing
///    about the defect changes.
///
/// VACUITY LAYER. The growth tail must still BE there: both
/// `accrue_quality_time(` and `check_and_evolve(` are asserted present in
/// `enqueue_move`. Without it, deleting the entire tail would drive
/// `lead_party(` to zero and pass layer 2 while EG2-8 was destroyed.
///
/// RED at HEAD: `enqueue_move` calls `lead_party(` (movement.rs:150) and
/// `lead_party_ids` does not exist, so layer 1 fails with a count of 0 and layer 2
/// with a count of 1.
///
/// HONEST LIMITS. (a) SOURCE SCAN — this crate has no `ReducerContext` harness, so
/// nothing here executes `enqueue_move` or observes a Quality-Time credit. It
/// proves which helper is WRITTEN at the call site, never what that helper
/// returned at runtime. (b) Layer 3 pins one spelling of the owner index
/// (`owner_identity()`); a delegation that nonetheless read the party through some
/// other accessor would evade it. The count-exactly-one on `lead_party_ids(` is
/// what makes that evasion pointless rather than the ban itself. (c) Nothing here
/// checks the rate limiter on the new warn — `battle_tests.rs`
/// `lead_party_warns_on_an_unparseable_lead_level` owns the audit shape, and
/// deliberately does not pin the limiter either (documented there).
#[test]
fn enqueue_move_growth_tail_does_not_depend_on_the_lead_level() {
    let squashed = squashed_movement();
    let enqueue_marker = ["pubfn", "enqueue", "_move("].concat();
    let n_marker = squashed.matches(enqueue_marker.as_str()).count();
    assert_eq!(
        n_marker, 1,
        "SCAN PRECONDITION (12r-e E2): `pubfnenqueue_move(` must appear EXACTLY \
         ONCE in the squashed `movement.rs`; found {n_marker}. With two, the \
         brace-matched extractor takes the FIRST match and a decoy could carry the \
         id-only call while the real reducer still used the level-parsing helper."
    );
    let body = brace_body(&squashed, enqueue_marker.as_str());

    // --- Vacuity: the growth tail this test is about must exist -------------
    let accrue = ["accrue_quality", "_time("].concat();
    let evolve_check = ["check_and", "_evolve("].concat();
    for needle in [accrue.as_str(), evolve_check.as_str()] {
        assert!(
            body.contains(needle),
            "VACUITY GUARD (12r-e E2): `enqueue_move`'s body no longer contains \
             `{needle}..)`, so there is no growth tail left for E2 to protect and \
             the `lead_party(` zero-count below would pass trivially. EG2-8/EG2-12 \
             require both tails at this call site — see \
             enqueue_move_body_loops_party_growth_tails, which owns that pin."
        );
    }

    // --- Layer 1: the id-only resolver, exactly once ------------------------
    let ids_call = ["lead", "_party_ids("].concat();
    let n_ids = body.matches(ids_call.as_str()).count();
    assert_eq!(
        n_ids, 1,
        "TEETH (12r-e E2): `enqueue_move`'s body calls `{ids_call}..)` {n_ids} \
         time(s); it must call it EXACTLY once. RED at HEAD: 0 — the helper does \
         not exist and the reducer calls `lead_party(` instead. Zero means the \
         growth tail is still gated on the LEAD monster's level parsing; two would \
         mean two independently resolved id lists in one reducer, so the escrow \
         skip could be computed against a different list than the one credited."
    );

    // --- Layer 2: THE tooth — the level-parsing helper is not called here ---
    let lead_party_call = ["lead", "_party("].concat();
    let n_lead_party = body.matches(lead_party_call.as_str()).count();
    assert_eq!(
        n_lead_party, 0,
        "TEETH (12r-e E2): `enqueue_move`'s body calls `{lead_party_call}..)` \
         {n_lead_party} time(s); it must call it ZERO times. RED at HEAD: 1 \
         (movement.rs:150). `lead_party` parses the LEAD's level and returns `None` \
         for the WHOLE party if it will not — and `movement.rs:150` reads that \
         `None` as `this player has no party`, so ONE out-of-range level byte on \
         the lead silently freezes Quality Time and auto-evolution for EVERY \
         monster in the party, on EVERY move, for as long as the row survives. \
         This assertion is what stops the three re-pointed `lead_party_ids(` \
         needles in this file from being hollowed out: they are all POSITIVE, so a \
         body calling BOTH helpers would satisfy every one of them while the defect \
         lived on. `movement_tick` (movement.rs:436) and `start_wild_battle` \
         (battle.rs:497) keep calling `lead_party` — they genuinely need a `Level` \
         — and neither is scanned here."
    );

    // --- Layer 3 (battle.rs): lead_party DELEGATES; ONE party query ---------
    let battle = squashed_battle_for_e2();
    let decl = ["fnlead", "_party("].concat();
    let n_decl = battle.matches(decl.as_str()).count();
    let decl_ids = ["fnlead", "_party_ids("].concat();
    assert_eq!(
        n_decl, 1,
        "SCAN PRECONDITION (12r-e E2): `{decl}` must appear EXACTLY ONCE in the \
         squashed `battle.rs`; found {n_decl}. (Note `{decl_ids}` does NOT match \
         this needle — the byte after `_party` differs, which is what keeps the two \
         declarations distinguishable by a plain substring search.) Without exactly \
         one declaration the brace-matched body below is not the function this test \
         means."
    );
    let lead_party_body = brace_body(&battle, decl.as_str());

    let n_body_ids = lead_party_body.matches(ids_call.as_str()).count();
    assert_eq!(
        n_body_ids, 1,
        "TEETH (12r-e E2, DIRECTION): `lead_party`'s own body in battle.rs calls \
         `{ids_call}..)` {n_body_ids} time(s); it must call it EXACTLY once. \
         `lead_party_ids` is the BASE and `lead_party` is the layer on top: it \
         delegates for the ids, then point-reads `ids[0]` for the level. Zero means \
         the split produced two independent party resolvers that can drift on slot \
         ordering or on the `party_slot != PARTY_SLOT_NONE` filter — and \
         `ids[0] == the lead` is precisely the invariant `lead_party` depends on."
    );

    let owner_index = ["owner", "_identity()"].concat();
    let n_owner_index = lead_party_body.matches(owner_index.as_str()).count();
    assert_eq!(
        n_owner_index, 0,
        "TEETH (12r-e E2, NO DUPLICATE QUERY): `lead_party`'s own body still reads \
         the `{owner_index}` owner index {n_owner_index} time(s); after the split it \
         must read it ZERO times. RED at HEAD: 1 (battle.rs:287). The owner-index \
         party query must have ONE definition, and that definition is \
         `lead_party_ids`; `lead_party` delegates to it and then point-reads the \
         lead row by `monster_id`. Two copies of the query is how the two helpers \
         come to disagree about who is in the party — which would make \
         `lead_party`'s level and `enqueue_move`'s credited id list describe \
         different monsters."
    );
}
