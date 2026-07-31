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
