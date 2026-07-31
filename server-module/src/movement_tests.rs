//! `movement` server-module gating tests — slice 11r-a / ADR-0166 D4.
//!
//! Source-guard pattern (house convention): read production source via
//! `include_str!`, strip comments, squash whitespace, search for
//! **concat!-assembled** needles.  No needle is written verbatim in this file, so
//! the scan can never pass by matching the test's own text.
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
// Comment-stripping helper.
//
// A LOCAL copy on purpose: the sibling test modules each keep their own
// (`pvp_tests.rs:64`, `trading_tests.rs:457`, `taming_tests.rs:42`,
// `economy_tests.rs:936`).  A shared `scan_helpers` module would need a `lib.rs`
// edit, which is outside 11r-a's touch set — recorded as ADR-0166 residual R5.
//
// Removed bytes are replaced with spaces so byte offsets are preserved (the
// squash step drops them again anyway).  No string-literal stripper is needed
// here: every needle below is code-shaped and `movement.rs` contains no string
// literal that could host one.
// ---------------------------------------------------------------------------

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
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
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
/// Four layers.  Layers 1 and 2 are RED at HEAD; layers 3 and 4 are labelled
/// ANTI-REGRESSION / ANTI-EVASION and are green today — they exist so the fix
/// cannot introduce a *worse* bug while repairing this one.
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
/// 2. **`player_identity()` whole-file count == 1 (RED at HEAD).**  Arithmetic,
///    counted by hand at HEAD: `movement.rs` uses the `player_identity()` btree
///    accessor exactly TWICE — `:218` (the warp guard being replaced) and `:254`
///    (the grass-encounter pre-check, which this slice deliberately does NOT touch
///    — ADR-0166 residual R4).  After the fix the warp occurrence is gone and
///    exactly ONE remains.  This is what kills a "belt-and-braces" implementation
///    that calls the SSOT *and* keeps the old inline filter: the composite needle
///    alone would pass such a shell.  If a future slice fixes R4 too, this number
///    goes to 0 and the assertion must be updated DELIBERATELY — that is the
///    intended failure mode, not a defect.
///
/// 3. **ANTI-REGRESSION (green today, must stay green): `.unwrap_or(true)`
///    survives and `.unwrap_or(false)` never appears.**  `unwrap_or(true)` means
///    "no `player` row ⇒ an NPC ⇒ **skip the warp**" (ADR-0070 home-zone policy),
///    NOT "is in battle".  Flipping it to `false` teleports wandering NPCs out of
///    their home zones permanently.  `npc_tests.rs:351-371` (outside this slice's
///    touch set) pins the same text and must stay green through the
///    `in_battle`→`skip_warp` rename; this assertion is the local canary for that.
///
/// 4. **ANTI-EVASION (green today): no `ctx.sender` between `warp_at(` and
///    `stepped_onto_grass(`.**  A second, independent line of defence against the
///    module-identity mutant described in layer 1 — it also catches a
///    `let me = ctx.sender;` hoisted just above the guard and passed in under
///    another name.
///
/// RED state at HEAD: layer 1 fails (no `is_in_ongoing_battle` anywhere in
/// `movement.rs`); layer 2 fails (count is 2, not 1).
///
/// HONEST LIMIT: the composite needle pins one exact spelling of the closure.  A
/// semantically identical but differently-spelled fix (e.g. binding the identity
/// to a local first, or an `if let Some(p) = … else` rewrite) would false-RED.
/// The required text is stated verbatim in the failure message, and ADR-0166 D4
/// fixes it as the sanctioned shape; both the expression-bodied and
/// block-bodied closure forms are accepted, as are the bare, `guards::` and
/// `crate::guards::` path spellings.
#[test]
fn e3_warp_guard_uses_the_both_role_ssot_with_the_player_identity() {
    let squashed: String = strip_rust_comments(MOVEMENT_RS)
        .split_whitespace()
        .collect();

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

    // --- Layer 2: the single-role filter is GONE, not merely supplemented ----
    let accessor = ["player_", "identity()"].concat();
    let accessor_count = squashed.matches(accessor.as_str()).count();
    assert_eq!(
        accessor_count, 1,
        "TEETH (E3/D4 layer 2): `movement.rs` must contain the `{accessor}` btree \
         accessor EXACTLY ONCE; found {accessor_count}. The arithmetic: at HEAD there \
         are two — `:218` (the warp guard, replaced by this slice) and `:254` (the \
         grass-encounter pre-check, deliberately NOT touched here — ADR-0166 residual \
         R4). After the fix only the grass-encounter one remains. A count of 2 means \
         the old single-role filter was left in place ALONGSIDE the SSOT call, which \
         layer 1's needle alone cannot see: the effective condition would still be \
         side-A-only. A count of 0 means the grass guard was collaterally rewritten \
         — out of scope for 11r-a. If a later slice legitimately fixes R4, update \
         this number deliberately."
    );

    // --- Layer 3: ANTI-REGRESSION (green today — do not mistake green for teeth)
    let unwrap_true = [".unwrap_or(", "true)"].concat();
    let unwrap_false = [".unwrap_or(", "false)"].concat();
    assert!(
        squashed.contains(unwrap_true.as_str()),
        "ANTI-REGRESSION (E3/D4 layer 3): `.unwrap_or(true)` must survive the rewrite \
         verbatim. It means `no player row ⇒ an NPC ⇒ SKIP the warp` (ADR-0070 \
         home-zone policy) — it does NOT mean `is in battle`, which is what the old \
         local name `in_battle` misleadingly implied. `npc_tests.rs:351-371` pins the \
         same text from outside this slice's touch set and must stay green."
    );
    let false_count = squashed.matches(unwrap_false.as_str()).count();
    assert_eq!(
        false_count, 0,
        "ANTI-REGRESSION (E3/D4 layer 3): found {false_count} occurrence(s) of \
         `.unwrap_or(false)` in movement.rs. Flipping the warp guard's default to \
         `false` treats every NPC (no `player` row) as not-in-battle and teleports it \
         through warp tiles, stranding it in a zone it can never wander back from \
         (ADR-0070). This is the exact 'cleanup' the `in_battle`→`skip_warp` rename \
         exists to prevent."
    );

    // --- Layer 4: ANTI-EVASION — no module identity in the warp region -------
    let warp_marker = ["warp", "_at("].concat();
    let grass_marker = ["stepped_onto", "_grass("].concat();
    let warp_pos = squashed
        .find(warp_marker.as_str())
        .expect("E3: `warp_at(` not found in movement.rs — the warp branch must exist");
    let grass_rel = squashed[warp_pos..]
        .find(grass_marker.as_str())
        .expect("E3: `stepped_onto_grass(` not found after `warp_at(` in movement.rs");
    let warp_region = &squashed[warp_pos..warp_pos + grass_rel];
    let sender_needle = ["ctx.", "sender"].concat();
    let sender_count = warp_region.matches(sender_needle.as_str()).count();
    assert_eq!(
        sender_count, 0,
        "ANTI-EVASION (E3/D4 layer 4): `ctx.sender` appears {sender_count} time(s) \
         between `warp_at(` and `stepped_onto_grass(`. `movement_tick` is \
         scheduler-only (`movement.rs:156` rejects any other sender), so `ctx.sender` \
         inside it is the MODULE identity and can never be a player. Asking the battle \
         guard about it returns false for everyone, warping every player out of every \
         battle. The warp guard must ask about the character's own `p.identity`."
    );
}
