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

/// `movement.rs` with comments stripped and ALL whitespace squashed out, so a
/// rustfmt line split can never cause a false RED.
fn squashed_movement() -> String {
    strip_rust_comments(MOVEMENT_RS)
        .split_whitespace()
        .collect()
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
