//! `ranking` domain-submodule tests — m17a (ADR-0119) + m17.5d (ADR-0125).
//!
//! Declared from `server-module/src/ranking.rs` as:
//!   `#[path = "ranking_tests.rs"] mod ranking_tests;`
//! so `super::` resolves to `ranking.rs`.
//!
//! Design: server-module/src/ranking.rs contains no ctx-free pure functions
//! (all logic delegates to game_core::apply_elo / compute_rating_update, which
//! are fully tested in game-core/src/ranking.rs). The active behavioral tests
//! for RL-7 module invariants live in pvp_tests.rs (m17a section (e)), where
//! the file is read via std::fs and the teeth are already engaged.
//!
//! This file therefore contains one lightweight test that:
//!   - Pins the RL-4 seed constant via game_core::INITIAL_RATING (SSOT).
//!   - References `super` to make the module declaration non-dormant once
//!     ranking.rs exists (the declaration itself acts as a compile gate).
//!
//! Active behavioral teeth for RL-7:
//!   See pvp_tests.rs — m17a_rl7_server_ranking_module_invariants() (runtime
//!   std::fs read, RED until ranking.rs is created).
//!
//! m17.5d (ADR-0125) adds:
//!   T1 executed tests (d1_*/d2_*): pure-core `refresh_profile_name` fn — RED
//!     as compile-fail until implementer adds the fn to ranking.rs.
//!   T2 source-scan tests: needle checks over ranking.rs via include_str! —
//!     RED by needle-absence until impl wires the helper correctly (except two
//!     documented regression pins which start GREEN).

use crate::schema::Profile;
use spacetimedb::Identity;

// ---------------------------------------------------------------------------
// RL-4 seed constant pin
//
// game_core::INITIAL_RATING is the SSOT for the starting rating (ADR-0119 D1).
// get_or_init_profile must use this constant, not the literal 1000 (which is
// enforced by the pvp_tests.rs (e-iii) SSOT scan on the stripped source).
//
// This test pins the value one more time from the server-module perspective,
// confirming the game-core dependency delivers 1000.
// ---------------------------------------------------------------------------

/// RL-4 pin: game_core::INITIAL_RATING must be 1000 as seen from server-module.
///
/// Kills: a game-core change that silently redefines INITIAL_RATING to a
/// different value without triggering a review — this test catches it at the
/// server-module boundary.
#[test]
fn rl4_initial_rating_ssot_pin() {
    assert_eq!(
        game_core::INITIAL_RATING,
        1000_i32,
        "RL-4: game_core::INITIAL_RATING must be 1000 as seen from server-module. \
         get_or_init_profile seeds new profiles with this constant (ADR-0119 D1). \
         If this value changed, update the ADR and all dependent tests."
    );
}

// ===========================================================================
// m17.5d — EARS 17.5d-1/17.5d-2: profile.name passive mirror (ADR-0125)
//
// T1: Executed pure-core tests for refresh_profile_name.
//     These call `super::refresh_profile_name` which does NOT yet exist →
//     the whole crate's test build fails with a compile error. That is the
//     accepted red state for pure-core slices (m17.5a precedent).
//
// T2: Source-scan tests over ranking.rs (read via include_str! — file exists
//     at @a0d5743). Needles whitespace-free (squash_ws) and assembled with
//     concat!() to prevent self-matching. Two regression pins start GREEN.
// ===========================================================================

// ---------------------------------------------------------------------------
// Scan machinery (local copies — do NOT import from pvp_tests.rs or
// taming_tests.rs; per-module convention, ADR-0125 anti-pattern #5).
// ---------------------------------------------------------------------------

/// Strip Rust string literals from `src`, replacing their content (and
/// delimiters) with spaces.
///
/// Handles:
///   - Normal double-quoted literals `"..."` with `\"` escape sequences.
///   - Raw strings `r"..."` and `r#"..."#` (up to 6 `#` hashes, covering all
///     plausible real-world uses; ranking.rs currently contains none — noted as
///     a limitation if deeper nesting is ever added).
///   - Char literals are NOT handled (ranking.rs contains none; noted).
///
/// Must run BEFORE `strip_rust_comments` so that `/*` or `//` inside a string
/// literal does not confuse the comment stripper. This mirrors the eval order:
/// `stripRustStrings(stripRustComments(src))` in ranking-security.eval.mjs is
/// comments-then-strings; we reverse to strings-first for correctness (a `//`
/// inside a string would fool comment stripping done first). The eval's string
/// stripper is applied after comment stripping there because JS regex comment
/// stripping doesn't walk string context — our byte-walk comment stripper has
/// the same blind-spot, so we remove strings first.
///
/// Red-team string-literal evasion (test-fan F1): without this pass, a broken
/// impl can embed a needle inside a `let _ = "...needle...";` string literal
/// and fool all T2 scan assertions.
fn strip_rust_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;

    while i < len {
        // Raw string: r"..." or r#"..."# (up to 6 hashes).
        if bytes[i] == b'r' {
            // Count opening hashes.
            let mut hashes: usize = 0;
            let mut j = i + 1;
            while j < len && bytes[j] == b'#' && hashes < 6 {
                hashes += 1;
                j += 1;
            }
            if j < len && bytes[j] == b'"' {
                // This IS a raw string literal.
                // Blank the `r`, hashes, and opening `"`.
                out.push(b' '); // r
                for _ in 0..hashes {
                    out.push(b' ');
                }
                out.push(b' '); // opening "
                j += 1;
                // Build the closing delimiter: `"` followed by `hashes` `#`s.
                // Scan until we find it.
                loop {
                    if j >= len {
                        break;
                    }
                    if bytes[j] == b'"' {
                        // Check for the required number of closing hashes.
                        let mut k = j + 1;
                        let mut closing_hashes: usize = 0;
                        while k < len && bytes[k] == b'#' && closing_hashes < hashes {
                            closing_hashes += 1;
                            k += 1;
                        }
                        if closing_hashes == hashes {
                            // Found the end: blank the `"` and hashes.
                            out.push(b' '); // closing "
                            for _ in 0..hashes {
                                out.push(b' ');
                            }
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
            // Not a raw string — fall through to emit `r` normally.
        }

        // Normal double-quoted string literal.
        if bytes[i] == b'"' {
            out.push(b' '); // opening "
            i += 1;
            loop {
                if i >= len {
                    break;
                }
                if bytes[i] == b'\\' && i + 1 < len {
                    // Escape sequence: blank both bytes.
                    out.push(b' ');
                    out.push(b' ');
                    i += 2;
                } else if bytes[i] == b'"' {
                    out.push(b' '); // closing "
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

    // SAFETY: we only copy original UTF-8 bytes or ASCII spaces (0x20); the
    // result is valid UTF-8.
    String::from_utf8(out).expect("string-stripped source must be valid UTF-8")
}

/// Strip Rust block comments (`/* ... */`) and line comments (`// ...`) from
/// `src`. Returns a new String with those regions replaced by spaces.
///
/// Run AFTER `strip_rust_strings` so that `/*` or `//` inside a string literal
/// does not confuse this pass (string content is already blanked).
///
/// Corner-cases: nested block comments unsupported; char literals not handled
/// (ranking.rs contains none).
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

/// Remove ALL whitespace characters from `src` (space, tab, newline, CR, etc).
///
/// The third stage of the scan pipeline; makes needle matching rustfmt-proof.
/// (red-team F1 mitigation, ADR-0125.)
fn squash_ws(src: &str) -> String {
    src.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Full three-stage scan pipeline: strip strings → strip comments → squash_ws.
///
/// ALL T2 source-scan tests must use this helper, never a partial pipeline.
/// The string-stripping stage closes the string-literal evasion gate-hole
/// (red-team test-fan F1): without it, a broken impl can embed a needle inside
/// `let _ = "...needle...";` and fool all needle assertions.
///
/// Pipeline order:
///   1. `strip_rust_strings` — blanks `"..."`, `r"..."`, `r#"..."#` content.
///   2. `strip_rust_comments` — blanks `// ...` and `/* ... */` regions.
///      (Run after string stripping so `//` inside a string literal is already
///      blanked before the comment pass walks it.)
///   3. `squash_ws` — removes all whitespace for rustfmt-proof needle matching.
fn stripped_for_scan(src: &str) -> String {
    squash_ws(&strip_rust_comments(&strip_rust_strings(src)))
}

// Source for T2 scans. ranking.rs exists in the tree (verified @a0d5743).
// The T2 tests read the CURRENT file; they go red when the impl needles are
// absent and green once the implementer adds them.
const RANKING_RS: &str = include_str!("ranking.rs");

// ---------------------------------------------------------------------------
// T1 — Executed pure-core tests (start RED as compile-fail)
//
// `super::refresh_profile_name` is declared here but does not yet exist in
// ranking.rs → compile error is the expected red state.
// Profile has no PartialEq derive (spacetimedb::table does not add it), so
// assertions compare individual fields rather than whole-struct equality.
// Profile DOES get Clone from the spacetimedb::table macro (the production
// `..winner`/`..loser` spreads in apply_pvp_rating prove this).
// ---------------------------------------------------------------------------

fn make_profile(id_byte: u8, name: &str, rating: i32, wins: u32, losses: u32) -> Profile {
    Profile {
        identity: Identity::from_byte_array([id_byte; 32]),
        name: name.to_string(),
        rating,
        wins,
        losses,
    }
}

/// EARS 17.5d-1: When a live player name is present (`Some`), `refresh_profile_name`
/// must replace the profile's name and leave all other fields unchanged.
///
/// Kills:
///   - refresh ignores `live_name` and returns the profile unchanged
///   - refresh replaces name but also corrupts rating/wins/losses
///   - `Some` arm returns `None` branch result (identity/rating drift)
#[test]
fn d1_refresh_replaces_name_when_live_present() {
    let original = make_profile(1, "OldName", 1200, 5, 3);
    let identity = original.identity;
    let result = super::refresh_profile_name(original, Some("NewName".to_string()));

    assert_eq!(
        result.name, "NewName",
        "17.5d-1: refresh_profile_name(profile, Some(n)) must set profile.name = n. \
         Got {:?} instead of \"NewName\".",
        result.name
    );
    assert_eq!(
        result.identity, identity,
        "17.5d-1: refresh_profile_name must not change profile.identity."
    );
    assert_eq!(
        result.rating, 1200,
        "17.5d-1: refresh_profile_name must not change profile.rating."
    );
    assert_eq!(
        result.wins, 5,
        "17.5d-1: refresh_profile_name must not change profile.wins."
    );
    assert_eq!(
        result.losses, 3,
        "17.5d-1: refresh_profile_name must not change profile.losses."
    );
}

/// EARS 17.5d-1: When the live player row is absent (`None`), `refresh_profile_name`
/// must return the profile completely unchanged — preserving the last-known name
/// even during a disconnect-forfeit race (ADR-0125 D1).
///
/// Kills:
///   - refresh uses `unwrap_or_default()` on `None`, clobbering the name with ""
///   - refresh replaces the name with a sentinel value on `None`
///   - disconnect race silently clears the leaderboard entry
#[test]
fn d1_refresh_keeps_name_when_absent() {
    let original = make_profile(2, "LastKnown", 950, 2, 7);
    let identity = original.identity;
    let result = super::refresh_profile_name(original, None);

    assert_eq!(
        result.name, "LastKnown",
        "17.5d-1: refresh_profile_name(profile, None) must keep the existing name \
         unchanged (disconnect race: player row gone, keep last-known name). \
         Got {:?}.",
        result.name
    );
    assert_eq!(
        result.identity, identity,
        "17.5d-1 (None arm): identity must be unchanged."
    );
    assert_eq!(
        result.rating, 950,
        "17.5d-1 (None arm): rating must be unchanged."
    );
    assert_eq!(
        result.wins, 2,
        "17.5d-1 (None arm): wins must be unchanged."
    );
    assert_eq!(
        result.losses, 7,
        "17.5d-1 (None arm): losses must be unchanged."
    );
}

/// EARS 17.5d-1: Idempotency — refreshing with the same name is a no-op.
///
/// Guards against an inequality-gated refactor that special-cases same-name
/// Some and accidentally changes other fields or returns a different struct.
/// (No distinct mutant column claimed; see ADR-0125 reviewer N-2.)
#[test]
fn d1_refresh_idempotent_same_name() {
    let original = make_profile(3, "SameName", 1000, 0, 0);
    let identity = original.identity;
    let result = super::refresh_profile_name(original, Some("SameName".to_string()));

    assert_eq!(
        result.name, "SameName",
        "17.5d-1 (idempotent): refresh with same name must return that name."
    );
    assert_eq!(result.identity, identity, "idempotent: identity unchanged.");
    assert_eq!(result.rating, 1000, "idempotent: rating unchanged.");
    assert_eq!(result.wins, 0, "idempotent: wins unchanged.");
    assert_eq!(result.losses, 0, "idempotent: losses unchanged.");
}

/// EARS 17.5d-2: A renamed player who wins a rated game must have the NEW name
/// persisted in the winner update row.
///
/// Composes `refresh_profile_name` through the apply_pvp_rating-shaped spread
/// construction — exactly `Profile { rating: new_r, wins: refreshed.wins.saturating_add(1),
/// ..refreshed }` — to prove the spread propagates the refreshed name (reviewer W-5).
///
/// Kills:
///   - name dropped by the `..winner` spread (spread uses stale pre-refresh copy)
///   - `apply_pvp_rating` loads winner/loser raw, skipping the refresh seam
///   - winner spread carries wrong stats (wins not incremented)
#[test]
fn d2_rename_then_rated_surfaces_new_name_winner_side() {
    // Simulate: player had old name, renamed, then won a rated game.
    let old_profile = make_profile(10, "OldWinner", 1000, 3, 2);
    let new_rating = 1016_i32; // arbitrary post-compute value

    // Step 1: refresh (as get_or_init_profile's Some arm now does).
    let refreshed = super::refresh_profile_name(old_profile, Some("NewWinner".to_string()));

    // Step 2: construct the winner update row exactly as apply_pvp_rating does.
    let persisted = Profile {
        rating: new_rating,
        wins: refreshed.wins.saturating_add(1),
        ..refreshed
    };

    assert_eq!(
        persisted.name, "NewWinner",
        "17.5d-2 (winner): the persisted winner row must carry the NEW name. \
         The `..refreshed` spread must propagate the refreshed name field. \
         Got {:?}.",
        persisted.name
    );
    assert_eq!(
        persisted.rating, new_rating,
        "17.5d-2 (winner): persisted rating must be the post-compute value."
    );
    assert_eq!(
        persisted.wins, 4,
        "17.5d-2 (winner): wins must be refreshed.wins (3) + 1 = 4."
    );
    assert_eq!(
        persisted.losses, 2,
        "17.5d-2 (winner): losses must be unchanged from the refreshed profile."
    );
}

/// EARS 17.5d-2: A renamed player who LOSES a rated game must have the NEW name
/// persisted in the loser update row.
///
/// Mirrors d2_rename_then_rated_surfaces_new_name_winner_side for the loser path
/// (red-team F2 closure at the executed level: both roles must surface the new name).
///
/// Kills:
///   - name dropped by the `..loser` spread (spread uses stale pre-refresh copy)
///   - loser loaded via raw find, skipping the refresh seam
///   - loser spread carries wrong stats (losses not incremented)
#[test]
fn d2_rename_then_rated_surfaces_new_name_loser_side() {
    // Simulate: player had old name, renamed, then lost a rated game.
    let old_profile = make_profile(11, "OldLoser", 1000, 1, 4);
    let new_rating = 984_i32; // arbitrary post-compute value (rating drops on loss)

    // Step 1: refresh (as get_or_init_profile's Some arm now does).
    let refreshed = super::refresh_profile_name(old_profile, Some("NewLoser".to_string()));

    // Step 2: construct the loser update row exactly as apply_pvp_rating does.
    let persisted = Profile {
        rating: new_rating,
        losses: refreshed.losses.saturating_add(1),
        ..refreshed
    };

    assert_eq!(
        persisted.name, "NewLoser",
        "17.5d-2 (loser): the persisted loser row must carry the NEW name. \
         The `..refreshed` spread must propagate the refreshed name field. \
         Got {:?}.",
        persisted.name
    );
    assert_eq!(
        persisted.rating, new_rating,
        "17.5d-2 (loser): persisted rating must be the post-compute value."
    );
    assert_eq!(
        persisted.wins, 1,
        "17.5d-2 (loser): wins must be unchanged from the refreshed profile."
    );
    assert_eq!(
        persisted.losses, 5,
        "17.5d-2 (loser): losses must be refreshed.losses (4) + 1 = 5."
    );
}

// ---------------------------------------------------------------------------
// T2 — Source-scan tests (start RED by needle-absence, except regression pins)
// ---------------------------------------------------------------------------

/// EARS 17.5d-1: The `Some` arm of `get_or_init_profile` must compose the
/// refresh call: `Some(existing) => refresh_profile_name(existing, live_player_name(ctx, identity))`.
///
/// Needle is whitespace-free (squash_ws) and assembled via concat!() split
/// mid-token so ranking_tests.rs cannot self-match when ranking.rs is scanned.
///
/// Kills:
///   - refresh call deleted from Some arm (arm returns bare `existing`)
///   - result of refresh discarded (refresh called but return value dropped)
///   - literal `None` passed as second arg instead of the helper call
///
/// Starts RED: needle absent in current ranking.rs (Some arm returns bare `existing`).
#[test]
fn d1_scan_some_arm_composes_refresh() {
    let squashed = stripped_for_scan(RANKING_RS);

    // Needle: Some(existing)=>refresh_profile_name(existing,live_player_name(ctx,identity))
    // Split at "refresh_pro" to prevent self-match when this file is accidentally scanned.
    let needle = concat!(
        "Some(existing)=>",
        "refresh_pro",
        "file_name(existing,live_player_name(ctx,identity))"
    );

    assert!(
        squashed.contains(needle),
        "17.5d-1 FAIL (d1_scan_some_arm_composes_refresh): ranking.rs Some arm must \
         compose refresh_profile_name(existing, live_player_name(ctx, identity)). \
         Needle (whitespace-free): {:?}. \
         Current Some arm returns bare `existing` — the passive-mirror wiring is missing \
         (ADR-0125 D1).",
        needle
    );
}

/// EARS 17.5d-1: `live_player_name` must be a private fn with the exact inline-chained
/// body `ctx.db.player().identity().find(identity).map(|p| p.name)`.
///
/// The whole-fn needle pins: (a) the function signature shape, and (b) the
/// `.map(|p| p.name)` chained form — forbidding the dangerous `.unwrap()` form
/// (red-team F3) and split-binding inside the helper (red-team F6).
///
/// Kills:
///   - `live_player_name` uses `.unwrap()` (panics on disconnect race)
///   - helper body uses a split-binding (`let p = ctx.db.player()...`)
///   - function is missing entirely
///
/// Starts RED: fn absent in current ranking.rs.
#[test]
fn d1_scan_live_player_name_is_inline_chained_map() {
    let squashed = stripped_for_scan(RANKING_RS);

    // Whole-fn needle (whitespace-free).
    // Split "fnlive_player" across two fragments to avoid self-match.
    // Split "ctx.db.player()" as "ctx.db." + "player()" — same protection
    // (the never-deleted repo scan excludes ranking.rs, but defensive practice).
    let needle = concat!(
        "fnlive_player",
        "_name(ctx:&ReducerContext,identity:Identity)->Option<String>{",
        "ctx.db.",
        "player().identity().find(identity).map(|p|p.name)}"
    );

    assert!(
        squashed.contains(needle),
        "17.5d-1 FAIL (d1_scan_live_player_name_is_inline_chained_map): ranking.rs must \
         contain a private fn live_player_name with the exact inline-chained body \
         ctx.db.player().identity().find(identity).map(|p| p.name). \
         Needle (whitespace-free): {:?}. \
         An .unwrap() form panics on disconnect race; a split-binding is forbidden by \
         ADR-0125 D3 / ADR-0119 RL-2 style convention.",
        needle
    );
}

/// EARS 17.5d-1: `live_player_name(ctx, identity)` must be called exactly TWICE —
/// once in the `Some` arm and once in the `None` arm of `get_or_init_profile`.
///
/// The call-site needle matches only call shapes, not the function definition
/// (the def has a different token sequence). Count == 2 pins both arms.
///
/// Kills:
///   - None arm drifts back to an inline lookup, diverging from the helper (F5)
///   - helper call removed from one arm
///
/// Starts RED: fn absent → count is 0.
#[test]
fn d1_scan_helper_used_by_both_arms() {
    let squashed = stripped_for_scan(RANKING_RS);

    // Call-site needle. Split at "live_player" to avoid self-match.
    let call_needle = concat!("live_player", "_name(ctx,identity)");

    let count = squashed.matches(call_needle).count();
    assert_eq!(
        count, 2,
        "17.5d-1 FAIL (d1_scan_helper_used_by_both_arms): \
         live_player_name(ctx, identity) must be called exactly 2 times in ranking.rs \
         (Some arm + None arm of get_or_init_profile). Found {} call(s). \
         Needle (whitespace-free): {:?}. \
         If only 1 call, the None arm has drifted back to an inline lookup (ADR-0125 D3 F5).",
        count, call_needle
    );
}

/// EARS 17.5d-1: The `Some` arm of `get_or_init_profile` must NOT add an extra DB write.
///
/// Three sub-assertions (all whitespace-free):
///   (a) profile().identity().update( count == 2 — the two existing apply_pvp_rating
///       writes; an eager Some-arm write would make it 3. (Starts GREEN — regression pin.)
///   (b) `=ctx.db.profile()` absent — split-binding evasion of the never-deleted scan.
///       Starts GREEN: the current file's profile accesses are `match ctx.db.profile()...`
///       and `.insert(` — no `=`-binding of the accessor. Gate fires if a bad impl adds one.
///   (c) `=ctx.db.player()` absent — forces all player-table reads in ranking.rs through
///       the `live_player_name` helper (ADR-0125 D3). Starts RED: the current None arm
///       binds `let name = ctx.db.player()...`, which squashes to `letname=ctx.db.player()`
///       and matches the needle. The needle cannot distinguish binding-the-accessor from
///       binding-a-chain-result, so it effectively bans both forms — exactly the intent.
///       The needle goes green once the None arm is rewritten to `live_player_name(...)`.
///
/// Update-count == 2 is a REGRESSION PIN — documented as green-at-birth by design.
/// Sub-assertion (b) also starts GREEN (no profile-accessor binding in current code).
/// Sub-assertion (c) starts RED (current None arm has a player-table binding) — intentional.
///
/// Kills:
///   - eager DB write added in Some arm (update count becomes 3)
///   - split-binding `= ctx.db.profile()` added anywhere in the file
///   - split-binding `= ctx.db.player()` added in new code
#[test]
fn d1_scan_no_eager_write_in_get_or_init() {
    let squashed = stripped_for_scan(RANKING_RS);

    // (a) Exactly 2 profile update calls (apply_pvp_rating's two writes).
    // REGRESSION PIN: starts GREEN. Documents the write-count shape before impl.
    let update_needle = concat!("profile().identity()", ".update(");
    let update_count = squashed.matches(update_needle).count();
    assert_eq!(
        update_count, 2,
        "17.5d-1 FAIL (d1_scan_no_eager_write_in_get_or_init / update-count pin): \
         ranking.rs must contain exactly 2 calls to profile().identity().update( \
         (apply_pvp_rating's winner + loser writes). Found {} call(s). \
         If 3+, get_or_init_profile's Some arm has added an eager write (ADR-0125 D1: \
         refresh is in-memory only, persistence rides the existing two update spreads). \
         If 0, apply_pvp_rating's writes were removed.",
        update_count
    );

    // (b) No split-binding for profile table accessor.
    // Needle split: "=ctx.db." + "profile()" — same defensive split as pvp_tests.rs RL-2.
    let profile_binding_needle = concat!("=ctx.db.", "profile()");
    assert!(
        !squashed.contains(profile_binding_needle),
        "17.5d-1 FAIL (d1_scan_no_eager_write_in_get_or_init / profile-binding): \
         ranking.rs must NOT contain {:?} (whitespace-free). \
         Assigning the profile table accessor to a binding is the documented evasion \
         of the never-deleted safety convention (ADR-0119 D3 / RL-2 style). \
         Use inline chained access throughout.",
        profile_binding_needle
    );

    // (c) No split-binding for player table accessor in ranking.rs.
    // Needle split: "=ctx.db." + "player()" — prevents self-match and catches the
    // split-binding anti-pattern in new code (reviewer W-2, red-team F6).
    let player_binding_needle = concat!("=ctx.db.", "player()");
    assert!(
        !squashed.contains(player_binding_needle),
        "17.5d-1 FAIL (d1_scan_no_eager_write_in_get_or_init / player-binding): \
         ranking.rs must NOT contain {:?} (whitespace-free). \
         New code in ranking.rs must use the inline-chained helper live_player_name \
         rather than a split-binding for the player table (ADR-0125 D3 / reviewer W-2).",
        player_binding_needle
    );
}

/// EARS 17.5d-2: `apply_pvp_rating` must load BOTH winner and loser through
/// `get_or_init_profile` — this pins the symmetric path through the refresh seam.
///
/// Needles: `get_or_init_profile(ctx,winner_id)` AND `get_or_init_profile(ctx,loser_id)`.
///
/// REGRESSION PIN — starts GREEN (these calls already exist in current ranking.rs).
/// Documented as green-at-birth by design: the test ensures the implementer cannot
/// accidentally remove either call while wiring the refresh.
///
/// Kills:
///   - loser loaded via raw `ctx.db.profile().identity().find(loser_id)`,
///     skipping the refresh seam (red-team F2)
///   - either arm removed from apply_pvp_rating
#[test]
fn d1_scan_apply_rating_refreshes_both_roles() {
    let squashed = stripped_for_scan(RANKING_RS);

    // Winner needle — split at "get_or_init" to prevent self-match.
    let winner_needle = concat!("get_or_init", "_profile(ctx,winner_id)");
    assert!(
        squashed.contains(winner_needle),
        "17.5d-2 FAIL (d1_scan_apply_rating_refreshes_both_roles / winner): \
         apply_pvp_rating must call get_or_init_profile(ctx, winner_id) so the winner's \
         profile is loaded through the refresh seam (ADR-0125 D1). \
         Needle (whitespace-free): {:?}.",
        winner_needle
    );

    // Loser needle.
    let loser_needle = concat!("get_or_init", "_profile(ctx,loser_id)");
    assert!(
        squashed.contains(loser_needle),
        "17.5d-2 FAIL (d1_scan_apply_rating_refreshes_both_roles / loser): \
         apply_pvp_rating must call get_or_init_profile(ctx, loser_id) so the loser's \
         profile is loaded through the refresh seam (ADR-0125 D1, red-team F2). \
         Needle (whitespace-free): {:?}.",
        loser_needle
    );
}

/// Machinery self-teeth test: proves that `stripped_for_scan` (strip strings →
/// strip comments → squash_ws) + needle correctly:
///   1. Flags a BAD fixture (Some arm returning bare `existing`).
///   2. Accepts a GOOD fixture (Some arm with the composed refresh call).
///   3. Rejects an EVASION fixture (Some arm returning bare `existing` PLUS a
///      string literal containing the exact needle text) — closes the
///      string-literal evasion gate-hole (red-team test-fan F1).
///
/// Also verifies that the helper-count needle finds ZERO occurrences of
/// `live_player_name(ctx,identity)` in the evasion fixture (the call-site text
/// appears only inside the string literal and must be blanked by string stripping).
///
/// If this test fails, the scan machinery itself is broken and the T2 tests above
/// cannot be trusted regardless of their assertion results.
#[test]
fn scan_machinery_teeth() {
    // The primary needle (same as d1_scan_some_arm_composes_refresh).
    // concat! split to prevent self-match when ranking_tests.rs is scanned.
    let needle = concat!(
        "Some(existing)=>",
        "refresh_pro",
        "file_name(existing,live_player_name(ctx,identity))"
    );

    // Helper-count needle (same as d1_scan_helper_used_by_both_arms).
    let call_needle = concat!("live_player", "_name(ctx,identity)");

    // -------------------------------------------------------------------------
    // Fixture 1 — BAD: Some arm returns bare `existing`. Must NOT match needle.
    // -------------------------------------------------------------------------
    let bad_fixture = "
        pub(crate) fn get_or_init_profile(ctx: &ReducerContext, identity: Identity) -> Profile {
            match ctx.db.profile().identity().find(identity) {
                Some(existing) => existing,
                None => {
                    let name = ctx.db.player().identity().find(identity)
                        .map(|p| p.name)
                        .unwrap_or_default();
                    ctx.db.profile().insert(Profile {
                        identity,
                        name,
                        rating: game_core::INITIAL_RATING,
                        wins: 0,
                        losses: 0,
                    })
                }
            }
        }
    ";

    let bad_squashed = stripped_for_scan(bad_fixture);
    assert!(
        !bad_squashed.contains(needle),
        "scan_machinery_teeth FAIL (BAD fixture): bare `existing` incorrectly matched \
         the composed-refresh needle {:?}. The scan machinery is broken — \
         it cannot distinguish a missing refresh from a correct one.",
        needle
    );

    // -------------------------------------------------------------------------
    // Fixture 2 — GOOD: Some arm composes the refresh call. Must match needle.
    // No string literals — pipeline result must contain the needle.
    // -------------------------------------------------------------------------
    let good_fixture = "
        pub(crate) fn get_or_init_profile(ctx: &ReducerContext, identity: Identity) -> Profile {
            match ctx.db.profile().identity().find(identity) {
                Some(existing) => refresh_profile_name(existing, live_player_name(ctx, identity)),
                None => {
                    let name = live_player_name(ctx, identity).unwrap_or_default();
                    ctx.db.profile().insert(Profile {
                        identity,
                        name,
                        rating: game_core::INITIAL_RATING,
                        wins: 0,
                        losses: 0,
                    })
                }
            }
        }
    ";

    let good_squashed = stripped_for_scan(good_fixture);
    assert!(
        good_squashed.contains(needle),
        "scan_machinery_teeth FAIL (GOOD fixture): composed refresh call did NOT match \
         needle {:?}. The scan machinery is broken — stripped_for_scan+needle \
         fails to detect a correct implementation.",
        needle
    );

    // -------------------------------------------------------------------------
    // Fixture 3 — EVASION (red-team test-fan F1): Some arm still returns bare
    // `existing`, but also contains a string literal embedding the exact needle
    // text. The string-stripping stage must blank the literal so the needle does
    // NOT match, and the helper-count must be 0 (not inflated by the literal).
    //
    // The needle text inside the string is assembled via the same concat!
    // fragments to preserve self-match protection for this test file — the
    // string literal content is built at runtime from the same concat! result,
    // so the literal text in ranking_tests.rs source is split and not verbatim.
    // -------------------------------------------------------------------------
    //
    // Build the evasion literal content at runtime from the same needle fragments.
    // This means ranking_tests.rs itself never contains the verbatim needle string.
    let evasion_literal_content = concat!(
        "Some(existing)=>",
        "refresh_pro",
        "file_name(existing,live_player_name(ctx,identity))"
    );
    // Also embed the call-site text to test count-inflation closure.
    let evasion_call_content = concat!("live_player", "_name(ctx,identity)");

    // Construct the evasion fixture as a String (so we can interpolate the
    // literal contents without writing them verbatim in the source).
    let evasion_fixture = format!(
        "
        pub(crate) fn get_or_init_profile(ctx: &ReducerContext, identity: Identity) -> Profile {{
            // Evasion attempt: embed needle in a dead string literal.
            let _ = \"{}\";
            let _ = \"{}\";
            match ctx.db.profile().identity().find(identity) {{
                Some(existing) => existing,
                None => {{
                    let name = ctx.db.player().identity().find(identity)
                        .map(|p| p.name)
                        .unwrap_or_default();
                    ctx.db.profile().insert(Profile {{
                        identity,
                        name,
                        rating: game_core::INITIAL_RATING,
                        wins: 0,
                        losses: 0,
                    }})
                }}
            }}
        }}
        ",
        evasion_literal_content, evasion_call_content,
    );

    let evasion_squashed = stripped_for_scan(&evasion_fixture);

    // Primary needle must NOT match after string-literal stripping.
    assert!(
        !evasion_squashed.contains(needle),
        "scan_machinery_teeth FAIL (EVASION fixture): the string-literal evasion was \
         NOT caught — needle {:?} matched after stripped_for_scan even though the \
         needle text appeared only inside a string literal. \
         The strip_rust_strings stage is not working (red-team test-fan F1).",
        needle
    );

    // Count-inflation: helper call inside the string literal must NOT be counted.
    let evasion_call_count = evasion_squashed.matches(call_needle).count();
    assert_eq!(
        evasion_call_count, 0,
        "scan_machinery_teeth FAIL (EVASION fixture / count-inflation): \
         found {} occurrence(s) of {:?} in the evasion fixture after stripping, \
         expected 0. The call-site text appeared only inside string literals; \
         string stripping must blank it so the count is not inflated \
         (red-team test-fan F1, d1_scan_helper_used_by_both_arms).",
        evasion_call_count, call_needle
    );
}
