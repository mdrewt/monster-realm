//! `ranking` domain-submodule tests — m17a (ADR-0119) + m17.5d (ADR-0125).
//!
//! Declared from `server-module/src/ranking.rs` as:
//!   `#[path = "ranking_tests.rs"] mod ranking_tests;`
//! so `super::` resolves to `ranking.rs`.
//!
//! After m17.5d (ADR-0125), ranking.rs has two private helpers that are
//! pure/ctx-free enough to test directly:
//!   - `refresh_profile_name(profile, live_name)` — pure struct transform,
//!     no ctx, no DB I/O.
//!   - `live_player_name(ctx, identity)` — ctx helper; its exact inline shape
//!     is pinned by T2 source-scan rather than an executed test (ReducerContext
//!     is not constructible in unit tests).
//!
//! Rating arithmetic still delegates entirely to game_core (tested there).
//!
//! Tests in this file:
//!   - RL-4 pin: game_core::INITIAL_RATING value from server-module boundary.
//!   - T1 executed (d1_*/d2_*): pure-core refresh_profile_name behaviour —
//!     RED as compile-fail until ranking.rs exposes the fn (m17.5a convention).
//!   - T2 source-scan: needle checks over ranking.rs (include_str!) verifying
//!     wiring shape, helper count, write-count, and absence of split-bindings —
//!     mostly RED until impl; two regression pins start GREEN.
//!
//! RL-7 module invariants (no reducer, get_or_init_profile present, etc.)
//! remain in pvp_tests.rs — m17a_rl7_server_ranking_module_invariants().

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
// T2: Source-scan tests over ranking.rs (read via include_str!). Needles
//     whitespace-free (squash_ws) and assembled with concat!() to prevent
//     self-matching. Two regression pins start GREEN.
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
/// Must run BEFORE `strip_rust_comments`: string content is blanked first so
/// a `//` or `/*` inside a string literal is already spaces before the comment
/// pass walks the buffer. Our byte-walk comment stripper does not track string
/// context, so without this ordering it would truncate on `//` in a string.
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
                out.resize(out.len() + hashes, b' '); // opening # hashes
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
                            out.resize(out.len() + hashes, b' '); // closing # hashes
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

// Source for T2 scans (m17a/ADR-0119 introduced ranking.rs; ADR-0125 extended it).
// The T2 tests read the current file; they are red when impl needles are absent
// and green once the implementer wires the helpers correctly.
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
/// The call-site needle matches only call shapes, not the function definition.
/// Assumption: the fn definition's squashed param list is
/// `(ctx:&ReducerContext,identity:Identity)` — the needle requires `(ctx,identity)`
/// (bare identifiers, no types), so the definition cannot match. Count == 2 pins
/// exactly the two call sites in get_or_init_profile (Some arm + None arm).
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
/// Sub-assertions (all whitespace-free):
///   (a) PER-FUNCTION profile().identity().update( counts (RE-SCOPED for M21a):
///       apply_pvp_rating == 2, get_or_init_profile == 0, rekey_profile == 2, and a
///       whole-file backstop == 4. M21a's rekey_profile added two profile writers, so
///       the historical whole-file ==2 pin would false-fail; bumping it 2->4 would
///       delete the tooth (a writer could be moved into get_or_init's Some arm and the
///       count would stay 4). The per-fn pins keep the eager-write tooth for
///       get_or_init while accounting for rekey_profile's legitimate two writes.
///   (b) `=ctx.db.profile()` absent — split-binding evasion of the never-deleted scan.
///       rekey_profile reads the guest via `match ctx.db.profile()`, so this stays GREEN
///       (the `match` keyword breaks the `=ctx.db.profile()` needle).
///   (c) `=ctx.db.player()` absent — forces all player-table reads in ranking.rs through
///       the `live_player_name` helper (ADR-0125 D3).
///
/// Kills:
///   - eager DB write added in get_or_init_profile's Some arm (its per-fn count becomes 1)
///   - either rekey_profile write dropped (copy-forward OR the mandatory zero — count 1)
///   - a 5th profile writer added anywhere (whole-file backstop fires)
///   - split-binding `= ctx.db.profile()` / `= ctx.db.player()` added anywhere
#[test]
fn d1_scan_no_eager_write_in_get_or_init() {
    let squashed = stripped_for_scan(RANKING_RS);

    // (a) PER-FUNCTION profile-update-count pins (RE-SCOPED for M21a / AUTH-25).
    //
    // M21a's ranking::rekey_profile adds two MORE profile().identity().update(
    // calls (copy-forward + tombstone), so the historical whole-file ==2 pin now
    // sees 4. Bumping the whole-file pin 2->4 would DELETE the tooth (any of the
    // four writers could then be moved into get_or_init_profile's Some arm and the
    // count would still be 4). Instead, pin each writer's body exactly, plus a
    // whole-file backstop == 4 ("no fifth writer"). extract_squashed_fn_body is
    // defined below in this file (pt-c1 section) and works on squashed source.
    let update_needle = concat!("profile().identity()", ".update(");

    // apply_pvp_rating writes the winner + loser rows: exactly 2.
    let apply_body = extract_squashed_fn_body(&squashed, concat!("fnapply_pvp", "_rating("))
        .expect("d1_scan (update-count): fn apply_pvp_rating not found in ranking.rs");
    let apply_updates = apply_body.matches(update_needle).count();
    assert_eq!(
        apply_updates, 2,
        "17.5d-1 FAIL (d1_scan_no_eager_write_in_get_or_init / apply_pvp_rating pin): \
         apply_pvp_rating must contain exactly 2 profile().identity().update( calls \
         (winner + loser). Found {}. If 1, one rating spread was deleted; if 3+, an \
         eager write crept in.",
        apply_updates
    );

    // get_or_init_profile is a READ/seed seam: it must add NO eager update (the
    // refresh is in-memory only; persistence rides apply_pvp_rating's spreads).
    let get_body = extract_squashed_fn_body(&squashed, concat!("fnget_or_init", "_profile("))
        .expect("d1_scan (update-count): fn get_or_init_profile not found in ranking.rs");
    let get_updates = get_body.matches(update_needle).count();
    assert_eq!(
        get_updates, 0,
        "17.5d-1 FAIL (d1_scan_no_eager_write_in_get_or_init / get_or_init_profile pin): \
         get_or_init_profile must contain ZERO profile().identity().update( calls — the \
         Some-arm refresh is in-memory only (ADR-0125 D1). Found {}.",
        get_updates
    );

    // rekey_profile (M21a, AUTH-25) writes exactly 2: the destination copy-forward
    // and the guest-row tombstone-in-place. Never a delete (a separate scan).
    let rekey_body = extract_squashed_fn_body(&squashed, concat!("fnrekey", "_profile("))
        .expect("d1_scan (update-count): fn rekey_profile not found in ranking.rs");
    let rekey_updates = rekey_body.matches(update_needle).count();
    assert_eq!(
        rekey_updates, 2,
        "AUTH-25 FAIL (d1_scan_no_eager_write_in_get_or_init / rekey_profile pin): \
         rekey_profile must contain exactly 2 profile().identity().update( calls (copy \
         stats forward onto the destination, THEN zero+tombstone the guest row in place). \
         Found {}. If 1, either the copy-forward or the mandatory zero step was dropped.",
        rekey_updates
    );

    // anonymize_display_names (m22-s3b, PRV1-6c) writes exactly 1: the profile
    // row's name is overwritten with game_core::TOMBSTONE_DISPLAY_NAME, in place.
    // Pinned per-fn for the same reason the three pins above are: the whole-file
    // backstop below widens 4 -> 5 to admit it, and a bare bumped number would
    // let ANY of the five writers move into get_or_init_profile's Some arm while
    // the total stayed correct.
    let anon_body = extract_squashed_fn_body(&squashed, concat!("fnanonymize_display", "_names("))
        .expect(
            "d1_scan (update-count): fn anonymize_display_names not found in ranking.rs. \
             m22-s3b delegates the `player`/`profile` ANONYMIZE step to this module (the one \
             that already owns the display-name write path), so without it PRV1-6c never \
             runs and the deleted player's name stays on the public leaderboard.",
        );
    let anon_updates = anon_body.matches(update_needle).count();
    assert_eq!(
        anon_updates, 1,
        "PRV1-6c FAIL (d1_scan_no_eager_write_in_get_or_init / anonymize_display_names pin): \
         anonymize_display_names must contain exactly 1 profile().identity().update( call — \
         the in-place name tombstone. Found {}. ZERO means the profile row keeps the deleted \
         player's display name on a PUBLIC, world-readable leaderboard forever; 2+ is a \
         second, unreviewed profile write in the one flow that cannot be undone.",
        anon_updates
    );

    // Whole-file backstop: exactly 5 (apply_pvp_rating 2 + rekey_profile 2 +
    // anonymize_display_names 1). Catches a SIXTH writer added anywhere (e.g. an
    // eager write reachable through a helper the per-fn body scans would not
    // textually contain). RE-DERIVED 4 -> 5 by m22-s3b (ADR-0228 D7(g)) and paid
    // for by the per-fn pin immediately above: the four pins together account for
    // every one of the five, so the total is a closed sum rather than a ceiling.
    let total_updates = squashed.matches(update_needle).count();
    assert_eq!(
        total_updates, 5,
        "17.5d-1/AUTH-25/PRV1-6c FAIL (d1_scan_no_eager_write_in_get_or_init / whole-file \
         backstop): ranking.rs must contain exactly 5 profile().identity().update( calls \
         total (apply_pvp_rating's 2 + rekey_profile's 2 + anonymize_display_names' 1). \
         Found {}. A 6th is an unaccounted profile writer. Note the four per-fn pins above \
         account for all five, so this clause is a CLOSED SUM: a writer that moved between \
         those functions reds there, and one that appeared outside them reds here.",
        total_updates
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

/// Module-hardening regression pins closing 3 cargo-mutants survivors in
/// apply_pvp_rating (nightly mutate-server baseline, pre-existing; closed by
/// this slice's scan coverage of ranking.rs).
///
/// EARS 17.5d-adjacent — GREEN at birth by design (all three needles present
/// in current ranking.rs). Kills:
///   - `delete ! in apply_pvp_rating` (ranking.rs:88): removing the `!` from
///     `if !crate::guards::is_ranked_pvp(battle)` would rate everything that is
///     NOT ranked PvP and skip everything that IS — needle 1 catches this.
///   - `delete field rating from winner update spread` (ranking.rs:109): removing
///     `rating: new_winner_rating` from the winner Profile spread would leave the
///     winner's rating unchanged (stale via `..winner`) — needle 2 catches this.
///   - `delete field rating from loser update spread` (ranking.rs:114): same
///     for the loser — needle 3 catches this.
#[test]
fn d1_scan_rated_write_survivor_pins() {
    let squashed = stripped_for_scan(RANKING_RS);

    // Needle 1: `if !crate::guards::is_ranked_pvp(battle) { return; }`.
    // Split at "is_ranked" + "_pvp" to prevent self-match.
    // The `!` is load-bearing: its deletion is the mutant we kill.
    let guard_needle = concat!("if!crate::guards::", "is_ranked", "_pvp(battle){return;}");
    assert!(
        squashed.contains(guard_needle),
        "17.5d-adjacent FAIL (d1_scan_rated_write_survivor_pins / guard): \
         apply_pvp_rating must contain {:?} (whitespace-free). \
         The `!` is required: without it, the guard logic inverts and the function \
         rates everything that is NOT ranked PvP (nightly mutant survivor, ranking.rs:88).",
        guard_needle
    );

    // Needle 2: `rating: new_winner_rating` in the winner update spread.
    // Split at "rating:new_" + "winner_rating" to prevent self-match.
    let winner_rating_needle = concat!("rating:new_", "winner_rating");
    assert!(
        squashed.contains(winner_rating_needle),
        "17.5d-adjacent FAIL (d1_scan_rated_write_survivor_pins / winner-rating): \
         apply_pvp_rating's winner spread must contain {:?} (whitespace-free). \
         Without this explicit field, `..winner` would propagate the stale pre-compute \
         rating, silently leaving the winner's rating unchanged \
         (nightly mutant survivor, ranking.rs:109).",
        winner_rating_needle
    );

    // Needle 3: `rating: new_loser_rating` in the loser update spread.
    // Split at "rating:new_" + "loser_rating" to prevent self-match.
    let loser_rating_needle = concat!("rating:new_", "loser_rating");
    assert!(
        squashed.contains(loser_rating_needle),
        "17.5d-adjacent FAIL (d1_scan_rated_write_survivor_pins / loser-rating): \
         apply_pvp_rating's loser spread must contain {:?} (whitespace-free). \
         Without this explicit field, `..loser` would propagate the stale pre-compute \
         rating, silently leaving the loser's rating unchanged \
         (nightly mutant survivor, ranking.rs:114).",
        loser_rating_needle
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
    // The None arm deliberately preserves the pre-impl historical shape (old
    // inline player lookup) to exercise the machinery, not the current code.
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
    // Fixture 3 — EVASION (red-team test-fan F1): BAD Some arm + string literals
    // containing the needle and call-site text. strip_rust_strings must blank them
    // so the needle does NOT match and the call-site count stays 0 (no inflation).
    // Literal contents built at runtime via concat! to preserve self-match protection.
    // -------------------------------------------------------------------------
    let evasion_literal_content = concat!(
        "Some(existing)=>",
        "refresh_pro",
        "file_name(existing,live_player_name(ctx,identity))"
    );
    let evasion_call_content = concat!("live_player", "_name(ctx,identity)");

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

// ===========================================================================
// pt-c1 — EARS pt-c1-1/-2/-3/-4/-5/-6: set_profile_name reducer (ADR-0132)
//
// The server-side rename write path. `set_profile_name` is the FIRST (and only)
// #[spacetimedb::reducer] in ranking.rs; it validates via guards::validate_name
// and writes ONLY player.name — the ADR-0125 passive mirror surfaces the rename
// on the leaderboard at the next rated game (Option a, no direct profile write).
//
// These are source-scan tests over RANKING_RS (ReducerContext is not
// unit-constructible for this module — the established honest proof, ADR-0125).
// They start RED (needle-absence) until the specialist implements the reducer,
// and are BODY-BOUNDED so the legitimate profile access in apply_pvp_rating /
// get_or_init_profile does NOT satisfy (or falsely trip) the reducer's scans.
//
// Coverage map:
//   pt-c1-1 (sets player.name on valid input)   → ptc1_scan_body_validates_and_writes_player_name
//   pt-c1-2 (rejects invalid name, no write)    → ptc1_scan_body_validates_and_writes_player_name
//   pt-c1-3 (rejects "not joined", no write)    → ptc1_scan_body_rejects_when_not_joined
//   pt-c1-4 (name surfaces via ADR-0125 mirror) → ptc1_scan_body_is_profile_untouching (indirect)
//                                                  + pre-existing d2_rename_then_rated_* executed pins
//   pt-c1-5 (profile-untouching)                → ptc1_scan_body_is_profile_untouching
//                                                  + ptc1_scan_profile_insert_count_is_one
//   pt-c1-6 (exactly one reducer, named)        → ptc1_scan_set_profile_name_fn_present
//                                                  + m17a_rl7_server_ranking_module_invariants (pvp_tests.rs)
// ===========================================================================

/// Extract the brace-bounded body of a fn from ALREADY-squashed source (the
/// output of `stripped_for_scan`). Whitespace is gone but braces survive, so a
/// depth counter over `{`/`}` isolates the exact function body. Mirrors the
/// intent of pvp_tests.rs::extract_pvp_fn_body but operates on squashed text.
///
/// `fn_needle` is the squashed signature prefix, e.g. `fnset_profile_name(`
/// (a `pub fn` squashes to `pubfn...` which still contains `fnset_profile...`).
/// Returns the body slice between the outermost `{ }` after the signature, or
/// `None` if the fn or a balanced body is not found.
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

/// pt-c1-6: ranking.rs must declare the `set_profile_name` reducer fn.
///
/// Needle split at "set_profile" via concat! so ranking_tests.rs cannot
/// self-match if it is ever scanned by the never-deleted repo scan.
///
/// Starts RED: the reducer does not yet exist in ranking.rs.
///
/// Kills:
///   - the reducer is absent (rename write path never shipped — H2 gap)
///   - the reducer is named something else (F4-adjacent at the source level)
#[test]
fn ptc1_scan_set_profile_name_fn_present() {
    let squashed = stripped_for_scan(RANKING_RS);
    let fn_needle = concat!("fnset_profile", "_name(");
    assert!(
        squashed.contains(fn_needle),
        "pt-c1-6 FAIL (ptc1_scan_set_profile_name_fn_present): ranking.rs must contain \
         `{}` (whitespace-free) — the single client-callable rename reducer (ADR-0132 D1). \
         RED pre-impl: the reducer does not yet exist.",
        fn_needle
    );
}

/// pt-c1-1 / pt-c1-2: the `set_profile_name` body must COMPOSE the validated
/// write of the display name — it contains `validate_name(` (reject-not-clamp
/// canonicalization) AND `player().identity().update(` (the player.name write).
///
/// Body-bounded via `extract_squashed_fn_body` so apply_pvp_rating's own
/// `player`/`profile` accesses cannot satisfy these needles for the reducer.
///
/// Starts RED: fn absent → extract returns None → the unwrap panics with the
/// documented RED message.
///
/// Kills:
///   - reducer writes player.name WITHOUT validating (validate_name dropped →
///     pt-c1-2 charset/length/bidi guard bypassed)
///   - reducer validates but never writes the row (player().identity().update
///     missing → pt-c1-1 no-op rename)
#[test]
fn ptc1_scan_body_validates_and_writes_player_name() {
    let squashed = stripped_for_scan(RANKING_RS);
    let fn_needle = concat!("fnset_profile", "_name(");
    let body = extract_squashed_fn_body(&squashed, fn_needle).unwrap_or_else(|| {
        panic!(
            "pt-c1-1/-2 (ptc1_scan_body_validates_and_writes_player_name): \
             `set_profile_name` fn not found in ranking.rs — RED pre-impl; the reducer \
             must exist for the body-composition scan to be meaningful (ADR-0132 D1)."
        )
    });

    // (a) validates the name (reject-not-clamp; canonical trimmed/NFC form).
    let validate_needle = concat!("validate", "_name(");
    assert!(
        body.contains(validate_needle),
        "pt-c1-2 FAIL (ptc1_scan_body_validates_and_writes_player_name / validate): \
         the `set_profile_name` body must call `{}` — the name must be validated with the \
         same SSOT rules as join_game (reject-not-clamp: empty / > MAX_NAME_LEN / \
         non-alphanumeric-non-space incl. bidi/zero-width). Body (whitespace-free): {:?}",
        validate_needle,
        body
    );

    // (b) writes player.name back via the player table update.
    let write_needle = concat!("player().identity()", ".update(");
    assert!(
        body.contains(write_needle),
        "pt-c1-1 FAIL (ptc1_scan_body_validates_and_writes_player_name / write): \
         the `set_profile_name` body must call `{}` — the reducer sets player.name to the \
         canonical validated name and writes the row back (ADR-0132 D1). Without this the \
         rename is a no-op. Body (whitespace-free): {:?}",
        write_needle,
        body
    );
}

/// pt-c1-5: the `set_profile_name` body is PROFILE-UNTOUCHING — it reads/writes
/// no `profile` table row (no leaderboard-row create, no rating/W/L mutation).
/// The rename surfaces via the ADR-0125 passive mirror on the next rated game,
/// NOT a direct profile write here.
///
/// Body-bounded (extract_squashed_fn_body): apply_pvp_rating and
/// get_or_init_profile legitimately touch profile, so this MUST scan only the
/// reducer body — a whole-file scan would be permanently red and is unsound.
///
/// This is an ALLOWLIST property (the reducer touches nothing profile), not a
/// `rating:`/`wins:` blocklist which a mutable-binding/helper-indirection write
/// evades (red-team F1/F2). The get_or_init_profile / profile().insert bans
/// close the rating-1000 leaderboard-injection hole (red-team F3).
///
/// Starts RED: fn absent → extract returns None → unwrap panics (RED message).
///
/// Kills:
///   - reducer adds an eager profile().identity().update( (F1/F2 — would also
///     break the whole-file ==2 update pin, but this is the direct body tooth)
///   - reducer calls get_or_init_profile( / profile().insert( (F3 injection)
///   - reducer binds `= ctx.db.profile()` (split-binding evasion)
///   - reducer calls refresh_profile_name( (would imply a profile round-trip)
#[test]
fn ptc1_scan_body_is_profile_untouching() {
    let squashed = stripped_for_scan(RANKING_RS);
    let fn_needle = concat!("fnset_profile", "_name(");
    let body = extract_squashed_fn_body(&squashed, fn_needle).unwrap_or_else(|| {
        panic!(
            "pt-c1-5 (ptc1_scan_body_is_profile_untouching): `set_profile_name` fn not \
             found in ranking.rs — RED pre-impl; the reducer must exist for the \
             profile-untouching body scan to be meaningful (ADR-0132 D3)."
        )
    });

    for forbidden in &[
        concat!("profile().", "identity()"),
        concat!("profile().", "insert"),
        concat!("get_or_init", "_profile("),
        concat!("refresh_profile", "_name("),
    ] {
        assert!(
            !body.contains(forbidden),
            "pt-c1-5 FAIL (ptc1_scan_body_is_profile_untouching): the `set_profile_name` body \
             contains `{}` (whitespace-free) — the name-setter must touch NO profile table \
             (ADR-0132 D3). It writes only player.name; the ADR-0125 mirror surfaces the \
             rename on the leaderboard at the next rated game. Any profile read/write here \
             either adds a third profile update (breaks the ==2 pin) or injects a rating-1000 \
             leaderboard row for an unrated player (red-team F1/F2/F3). Body: {:?}",
            forbidden,
            body
        );
    }

    // Split-binding of the profile accessor is also banned (would risk a later
    // .delete()/.update() on the bound handle; mirrors C1b).
    let profile_binding = concat!("=ctx.db.", "profile()");
    assert!(
        !body.contains(profile_binding),
        "pt-c1-5 FAIL (ptc1_scan_body_is_profile_untouching / split-binding): the \
         `set_profile_name` body contains `{}` (whitespace-free) — binding the profile \
         accessor is the documented evasion of the profile-untouching property (ADR-0132 D3).",
        profile_binding
    );
}

/// pt-c1-3: the `set_profile_name` body must REJECT a not-joined caller with a
/// literal `Err(` and must NOT use `.unwrap(` on the player row lookup.
///
/// Three body-bounded needles (control-flow-agnostic — accepts BOTH the
/// `match … None => return Err` form the plan uses AND a `let Some(..) = … else
/// { return Err }` form; does NOT pin control-flow shape, only the authz
/// properties):
///
///   (a) `player().identity().find(` present — the body resolves the caller's row.
///   (b) `Err(` present — an explicit reject exists in the body. The `?` on
///       `validate_name(…)?` does NOT emit a literal `Err(` in source, so the
///       only literal `Err(` in a correct body is the not-joined `return Err(…)`.
///   (c) `.unwrap(` absent — bans `…find(me).unwrap()` (panics on None) and
///       `…find(me).unwrap_or_default()` (inserts a default-identity player row
///       and silently "renames" a not-joined caller — the authz hole). Mirrors
///       the anti-unwrap pin on `live_player_name` (~ranking_tests.rs:499).
///
/// The hole closed: `ctx.db.player().identity().find(me).unwrap_or_default()`
/// passes the pt-c1-1/-2/-5 needles yet silently inserts a zero-valued player
/// row when the caller has no `player` row (not joined) instead of rejecting.
///
/// Starts RED: fn absent → extract returns None → documented panic.
///
/// Kills:
///   - `find(me).unwrap()` — panics on None (not joined → 500, no authz message)
///   - `find(me).unwrap_or_default()` — silently renames a not-joined caller by
///     creating a default-identity player row (authz hole, pt-c1-3 violation)
///   - body has no `Err(` literal — the not-joined reject branch was removed
#[test]
fn ptc1_scan_body_rejects_when_not_joined() {
    let squashed = stripped_for_scan(RANKING_RS);
    let fn_needle = concat!("fnset_profile", "_name(");
    let body = extract_squashed_fn_body(&squashed, fn_needle).unwrap_or_else(|| {
        panic!(
            "pt-c1-3 (ptc1_scan_body_rejects_when_not_joined): `set_profile_name` fn not \
             found in ranking.rs — RED pre-impl; the reducer must exist for the not-joined \
             reject scan to be meaningful (ADR-0132 D1)."
        )
    });

    // (a) The body resolves the caller's player row — a lookup must be present.
    let find_needle = concat!("player().identity()", ".find(");
    assert!(
        body.contains(find_needle),
        "pt-c1-3 FAIL (ptc1_scan_body_rejects_when_not_joined / find): \
         the `set_profile_name` body must contain `{}` (whitespace-free) — the reducer \
         must attempt to resolve the caller's player row before writing. \
         Body (whitespace-free): {:?}",
        find_needle,
        body
    );

    // (b) An explicit `Err(` literal is present — the not-joined reject branch.
    // `validate_name(…)?` desugars to Err propagation but emits NO literal `Err(`
    // in source; the only source-level `Err(` is the not-joined return.
    let err_needle = "Err(";
    assert!(
        body.contains(err_needle),
        "pt-c1-3 FAIL (ptc1_scan_body_rejects_when_not_joined / Err): \
         the `set_profile_name` body must contain `{}` (whitespace-free) — the explicit \
         not-joined rejection (`return Err(e)` or equivalent). validate_name(…)? does NOT \
         produce a source-level `Err(` literal, so its presence proves the not-joined \
         branch exists. Body (whitespace-free): {:?}",
        err_needle,
        body
    );

    // (c) No `.unwrap(` anywhere in the body — bans panic-on-None and
    // unwrap_or_default silently-creates-row (the authz hole).
    // `.unwrap` (no paren) so the ban catches `.unwrap()`, `.unwrap_or_default()`,
    // `.unwrap_or(`, `.unwrap_err()` — the paren form would miss `unwrap_or_default`.
    let unwrap_needle = ".unwrap";
    assert!(
        !body.contains(unwrap_needle),
        "pt-c1-3 FAIL (ptc1_scan_body_rejects_when_not_joined / unwrap): \
         the `set_profile_name` body contains `{}` (whitespace-free) — `.unwrap()` \
         panics when the caller is not joined (no player row) and \
         `.unwrap_or_default()` silently writes a zero-identity player row instead of \
         rejecting, violating pt-c1-3 (not-joined must reject). \
         The not-joined case must use an explicit None-arm that returns `Err(…)`. \
         Body (whitespace-free): {:?}",
        unwrap_needle,
        body
    );
}

/// Machinery self-teeth for `ptc1_scan_body_rejects_when_not_joined`:
/// proves the three not-joined authz needles BITE.
///
///   BAD  — `find(me).unwrap_or_default()` body with no `Err(` literal:
///          needle (b) fires (no `Err(`); needle (c) fires (`.unwrap(`).
///   GOOD — `find(me)` + `return Err(…)` + no unwrap:
///          all three needles pass.
///
/// If this test fails, the pt-c1-3 pin above cannot be trusted.
#[test]
fn ptc1_scan_rejects_not_joined_teeth() {
    let fn_needle = concat!("fnset_profile", "_name(");
    let find_needle = concat!("player().identity()", ".find(");
    let err_needle = "Err(";
    // `.unwrap` (no paren) so the ban catches `.unwrap()`, `.unwrap_or_default()`,
    // `.unwrap_or(`, `.unwrap_err()` — the paren form would miss `unwrap_or_default`.
    let unwrap_needle = ".unwrap";

    // -------------------------------------------------------------------------
    // BAD: uses find(me).unwrap_or_default() — no Err( literal in body.
    // Kills: an impl that silently "renames" a not-joined caller via the
    // default-identity row instead of rejecting (pt-c1-3 authz hole).
    // -------------------------------------------------------------------------
    let bad_fixture = "
        #[spacetimedb::reducer]
        pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
            let me = ctx.sender();
            let mut player = ctx.db.player().identity().find(me).unwrap_or_default();
            let validated = validate_name(&name)?;
            player.name = validated;
            ctx.db.player().identity().update(player);
            Ok(())
        }
    ";
    let bad_squashed = stripped_for_scan(bad_fixture);
    let bad_body = extract_squashed_fn_body(&bad_squashed, fn_needle)
        .expect("ptc1_scan_rejects_not_joined_teeth (BAD): fixture must contain set_profile_name");

    // Needle (b): no Err( in a body using unwrap_or_default.
    assert!(
        !bad_body.contains(err_needle),
        "ptc1_scan_rejects_not_joined_teeth FAIL (BAD / Err-absent): the BAD fixture body \
         unexpectedly contains `Err(` — fix the fixture so the authz-hole shape has no \
         literal Err( (only the ?-propagation from validate_name), else needle (b) cannot \
         demonstrate its bite."
    );
    // Needle (c): .unwrap( present in a body using unwrap_or_default.
    assert!(
        bad_body.contains(unwrap_needle),
        "ptc1_scan_rejects_not_joined_teeth FAIL (BAD / unwrap-present): the BAD fixture body \
         does NOT contain `.unwrap(` — the fixture is malformed; `unwrap_or_default()` must \
         appear as `.unwrap(` substring for needle (c) to demonstrate its bite."
    );

    // -------------------------------------------------------------------------
    // GOOD: find(me) + match-arm or else returning Err, no unwrap.
    // Must pass all three needles.
    // -------------------------------------------------------------------------
    let good_fixture = "
        #[spacetimedb::reducer]
        pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
            let me = ctx.sender();
            let mut player = match ctx.db.player().identity().find(me) {
                Some(p) => p,
                None => {
                    let e = \"not joined\".to_string();
                    log_reject(\"set_profile_name\", me, &e);
                    return Err(e);
                }
            };
            let validated = validate_name(&name).inspect_err(|e| log_reject(\"set_profile_name\", me, e))?;
            player.name = validated;
            ctx.db.player().identity().update(player);
            Ok(())
        }
    ";
    let good_squashed = stripped_for_scan(good_fixture);
    let good_body = extract_squashed_fn_body(&good_squashed, fn_needle)
        .expect("ptc1_scan_rejects_not_joined_teeth (GOOD): fixture must contain set_profile_name");

    assert!(
        good_body.contains(find_needle),
        "ptc1_scan_rejects_not_joined_teeth FAIL (GOOD / find): GOOD fixture body is missing \
         `{}` — machinery or fixture is broken.",
        find_needle
    );
    assert!(
        good_body.contains(err_needle),
        "ptc1_scan_rejects_not_joined_teeth FAIL (GOOD / Err): GOOD fixture body is missing \
         `Err(` after string-strip — string-stripping blanked the return Err(e) literal, \
         but `e` is a variable (not a string literal) so it must survive. \
         Check the strip pipeline: only string CONTENTS are blanked, not identifiers.",
    );
    assert!(
        !good_body.contains(unwrap_needle),
        "ptc1_scan_rejects_not_joined_teeth FAIL (GOOD / no-unwrap): GOOD fixture body \
         unexpectedly contains `.unwrap(` — fix the fixture.",
    );
}

/// pt-c1-5 backstop (F3): whole-file `profile().insert(` count == 1.
///
/// There is exactly ONE legitimate profile insert in ranking.rs — the None arm
/// of get_or_init_profile (seeds a new rated profile). A second insert anywhere
/// (e.g. inside set_profile_name — the leaderboard-injection hole) drives the
/// count to 2 and fires. Complements the body-bounded scan above with a
/// whole-file backstop that catches an insert added via a helper the body scan
/// might not textually contain.
///
/// REGRESSION PIN: starts GREEN (current ranking.rs has exactly 1 insert, in
/// get_or_init_profile's None arm). Documented green-at-birth by design; it goes
/// RED if the impl adds a second insert.
///
/// Kills:
///   - set_profile_name (or any new helper) calls profile().insert( → count 2
#[test]
fn ptc1_scan_profile_insert_count_is_one() {
    let squashed = stripped_for_scan(RANKING_RS);
    let insert_needle = concat!("profile().", "insert(");
    let count = squashed.matches(insert_needle).count();
    assert_eq!(
        count, 1,
        "pt-c1-5 FAIL (ptc1_scan_profile_insert_count_is_one): ranking.rs must contain \
         exactly 1 `{}` (whitespace-free) — the single get_or_init_profile None-arm seed. \
         Found {}. If 2+, a new profile insert was added (e.g. set_profile_name injecting a \
         rating-1000 leaderboard row for an unrated player — red-team F3). If 0, the \
         get_or_init_profile seed was removed.",
        insert_needle, count
    );
}

/// Machinery self-teeth for the pt-c1 profile-untouching body scan: proves the
/// `extract_squashed_fn_body` + forbidden-needle scan actually BITES.
///
///   BAD     — a set_profile_name that writes profile
///             (`ctx.db.profile().identity().update(p)`): the forbidden needle
///             `profile().identity()` MUST fire.
///   GOOD    — a clean set_profile_name that writes only player.name: NO
///             forbidden needle fires; the required needles DO.
///   EVASION — a clean body PLUS a dead string literal containing the forbidden
///             `ctx.db.profile().identity().update(...)` text: strip_rust_strings
///             must blank it so the scan does NOT fire (red-team test-fan F1).
///
/// If this test fails, the pt-c1 body scans above cannot be trusted.
#[test]
fn ptc1_scan_machinery_teeth() {
    let fn_needle = concat!("fnset_profile", "_name(");
    let forbidden = concat!("profile().", "identity()");
    let validate_needle = concat!("validate", "_name(");
    let write_needle = concat!("player().identity()", ".update(");

    // BAD: writes profile in the reducer body → forbidden needle must fire.
    let bad_fixture = "
        #[spacetimedb::reducer]
        pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
            let me = ctx.sender();
            let validated = validate_name(&name)?;
            let mut p = ctx.db.profile().identity().find(me).unwrap();
            p.rating = 9999;
            ctx.db.profile().identity().update(p);
            Ok(())
        }
    ";
    let bad_stripped = stripped_for_scan(bad_fixture);
    let bad_body = extract_squashed_fn_body(&bad_stripped, fn_needle)
        .expect("ptc1_scan_machinery_teeth (BAD): fixture must contain set_profile_name body");
    assert!(
        bad_body.contains(forbidden),
        "ptc1_scan_machinery_teeth FAIL (BAD): a set_profile_name body that writes \
         profile did NOT trip the forbidden needle {:?} — the profile-untouching scan is \
         broken and would not catch a profile write (red-team F1/F2).",
        forbidden
    );

    // GOOD: writes only player.name → no forbidden needle, required needles present.
    let good_fixture = "
        #[spacetimedb::reducer]
        pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
            let me = ctx.sender();
            let mut player = match ctx.db.player().identity().find(me) {
                Some(p) => p,
                None => return Err(\"not joined\".to_string()),
            };
            let validated = validate_name(&name)?;
            player.name = validated;
            ctx.db.player().identity().update(player);
            Ok(())
        }
    ";
    let good_stripped = stripped_for_scan(good_fixture);
    let good_body = extract_squashed_fn_body(&good_stripped, fn_needle)
        .expect("ptc1_scan_machinery_teeth (GOOD): fixture must contain set_profile_name body");
    assert!(
        !good_body.contains(forbidden),
        "ptc1_scan_machinery_teeth FAIL (GOOD): a clean player-only set_profile_name body \
         incorrectly tripped the forbidden needle {:?} — false positive; the scan cannot \
         distinguish a player.name write from a profile write.",
        forbidden
    );
    assert!(
        good_body.contains(validate_needle) && good_body.contains(write_needle),
        "ptc1_scan_machinery_teeth FAIL (GOOD): a clean set_profile_name body is missing the \
         required needles {:?} / {:?} — the required-needle scan would false-negative on a \
         correct impl.",
        validate_needle,
        write_needle
    );

    // EVASION: clean body + dead string literal containing the forbidden text.
    // Built via concat! so this file cannot self-match; strip_rust_strings must
    // blank the literal so the forbidden needle does NOT fire.
    let evasion_literal = concat!("ctx.db.", "profile().", "identity()", ".update(p)");
    let evasion_fixture = format!(
        "
        #[spacetimedb::reducer]
        pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {{
            let _ = \"{}\";
            let mut player = match ctx.db.player().identity().find(ctx.sender()) {{
                Some(p) => p,
                None => return Err(\"not joined\".to_string()),
            }};
            player.name = validate_name(&name)?;
            ctx.db.player().identity().update(player);
            Ok(())
        }}
        ",
        evasion_literal,
    );
    let evasion_stripped = stripped_for_scan(&evasion_fixture);
    let evasion_body = extract_squashed_fn_body(&evasion_stripped, fn_needle)
        .expect("ptc1_scan_machinery_teeth (EVASION): fixture must contain set_profile_name body");
    assert!(
        !evasion_body.contains(forbidden),
        "ptc1_scan_machinery_teeth FAIL (EVASION): the string-literal evasion was NOT caught — \
         forbidden needle {:?} matched after stripped_for_scan even though the profile-write \
         text appeared only inside a dead string literal. strip_rust_strings is not working \
         (red-team test-fan F1).",
        forbidden
    );
}

// ===========================================================================
// M21a AUTH-25 (ADR-0179 D6): guest->account profile re-key. Stats are copied
// FORWARD onto the destination row, then the guest's own row is ZEROED and its
// name tombstoned in place (never deleted). The zero step is load-bearing, not
// cosmetic — it is the CRITICAL unbounded ranked-stat duplication path.
//
// Pure seams tested directly via super:: (no ReducerContext required):
//   tombstoned_profile / profile_with_carried_stats / PROFILE_TOMBSTONE_NAME.
// ===========================================================================

/// AUTH-25 (pure) — THE SINGLE MOST IMPORTANT TOOTH IN M21a: `tombstoned_profile`
/// zeroes rating/wins/losses AND overwrites the name with the tombstone constant,
/// preserving the guest identity (the row is RETAINED, never deleted).
///
/// Kills (proof-of-teeth): delete ANY of the three `= 0` assignments — the guest
/// identity could then donate the same ranked stats to an UNBOUNDED number of
/// later fresh accounts via repeat claims. Each zero is asserted independently so
/// dropping exactly one still goes RED.
#[test]
fn auth25_tombstoned_profile_zeroes_all_stats_and_tombstones_name() {
    let guest = make_profile(9, "Ash", 1800, 40, 3);
    let id = guest.identity;
    let out = super::tombstoned_profile(guest);
    assert_eq!(
        out.rating, 0,
        "AUTH-25: rating MUST be zeroed — this is the unbounded ranked-duplication path."
    );
    assert_eq!(out.wins, 0, "AUTH-25: wins MUST be zeroed.");
    assert_eq!(out.losses, 0, "AUTH-25: losses MUST be zeroed.");
    assert_eq!(
        out.name,
        super::PROFILE_TOMBSTONE_NAME,
        "AUTH-25: the guest name MUST be overwritten with the tombstone constant."
    );
    assert_eq!(
        out.identity, id,
        "AUTH-25: the guest identity (PK) is preserved — the row is retained, never deleted."
    );
}

/// AUTH-25 (pure): `profile_with_carried_stats` copies the three stats onto the
/// DESTINATION row while preserving the destination's OWN identity and name.
///
/// Kills (proof-of-teeth): a mutant that copies the guest's `name` onto the
/// destination — D6 requires the destination keep its own display name; carrying
/// the guest name across would leak it onto the claimer's public leaderboard row.
#[test]
fn auth25_profile_with_carried_stats_preserves_dest_identity_and_name() {
    let dest = make_profile(2, "DestName", 1000, 0, 0);
    let dest_id = dest.identity;
    let out = super::profile_with_carried_stats(dest, 1800, 40, 3);
    assert_eq!(
        out.rating, 1800,
        "AUTH-25: destination rating := carried guest rating."
    );
    assert_eq!(
        out.wins, 40,
        "AUTH-25: destination wins := carried guest wins."
    );
    assert_eq!(
        out.losses, 3,
        "AUTH-25: destination losses := carried guest losses."
    );
    assert_eq!(
        out.identity, dest_id,
        "AUTH-25: the destination identity (PK) is preserved."
    );
    assert_eq!(
        out.name, "DestName",
        "AUTH-25: the destination keeps its OWN name (never the guest's name)."
    );
}

/// AUTH-25 (pure): the tombstone constant fits the display-name cap and is
/// deliberately UN-TYPABLE — `guards::validate_name` rejects it, so no player can
/// mint a name that impersonates a claimed-guest tombstone.
///
/// Kills: setting PROFILE_TOMBSTONE_NAME to something a player could type (which
/// would let a griefer masquerade as a tombstone) or to something over the cap.
#[test]
fn auth25_tombstone_name_is_bounded_and_untypable() {
    assert!(
        super::PROFILE_TOMBSTONE_NAME.chars().count() <= crate::MAX_NAME_LEN,
        "AUTH-25: PROFILE_TOMBSTONE_NAME must be <= MAX_NAME_LEN ({}) characters.",
        crate::MAX_NAME_LEN
    );
    assert!(
        crate::guards::validate_name(super::PROFILE_TOMBSTONE_NAME).is_err(),
        "AUTH-25: the tombstone name must be UN-TYPABLE (validate_name rejects it), so no \
         player can impersonate a claimed-guest tombstone on the leaderboard."
    );
}

// ===========================================================================
// RB7 — slice rb-7 (M22 §3 vs. M21 AUTH-25 / ADR-0179 D6): single-sourcing
// the deletion-tombstone display name in game-core, and pinning the M21
// guest-claim sentinel (`PROFILE_TOMBSTONE_NAME`, declared above) as
// module-private so S3 cannot reach for it by mistake.
//
// B1/B2 are EXECUTED pins over the live `game_core::TOMBSTONE_DISPLAY_NAME`
// constant (mirroring the AUTH-25 `auth25_tombstone_name_is_bounded_and_
// untypable` pin above, for the DISTINCT M22 deletion sentinel).
//
// B3a/B3b/B3c are source-scan pins over `PROFILE_TOMBSTONE_NAME`'s
// declaration, identifier-occurrence count, and value-occurrence count in
// ranking.rs, reusing this file's existing `stripped_for_scan` / `squash_ws`
// / `RANKING_RS` machinery (per-module convention, ADR-0125 anti-pattern
// #5 — no cross-file import of scan helpers).
//
// B5 is the proof-of-teeth battery for the three small scan-logic fns B3a/
// B3b/B3c share with it (`rb7_decl_occurrence`, `rb7_identifier_occurrence_
// count`, `rb7_value_occurrence_count`), mirroring the shape of
// `ptc1_scan_machinery_teeth` above.
// ===========================================================================

/// RB7-B1 (M22 §3): the game-core deletion tombstone `TOMBSTONE_DISPLAY_NAME`
/// is non-blank, fits the display-name cap, and is deliberately UN-TYPABLE —
/// `guards::validate_name` rejects it — mirroring the AUTH-25
/// `auth25_tombstone_name_is_bounded_and_untypable` pin above for the
/// distinct M21 guest-claim sentinel.
///
/// All three assertions are load-bearing TOGETHER, never individually:
/// `validate_name(..).is_err()` alone is satisfied by `""` (an empty name is
/// rejected) AND by an ordinary 30-char alphanumeric name (an over-length
/// name is also rejected) — neither of those is the bounded, deliberately
/// un-typable sentinel this criterion actually requires. Only the trio
/// together (non-blank AND within the length cap AND rejected) pins it.
///
/// kills: TOMBSTONE_DISPLAY_NAME defined as `""` (passes is_err() alone,
/// fails the non-blank assertion here); TOMBSTONE_DISPLAY_NAME defined as an
/// over-cap string longer than `MAX_NAME_LEN` (passes is_err() alone, fails
/// the length-cap assertion here).
#[test]
fn rb7_deletion_tombstone_is_bounded_and_untypable() {
    assert!(
        !game_core::TOMBSTONE_DISPLAY_NAME.trim().is_empty(),
        "RB7-B1 FAIL: game_core::TOMBSTONE_DISPLAY_NAME must not be blank / \
         whitespace-only"
    );
    assert!(
        game_core::TOMBSTONE_DISPLAY_NAME.chars().count() <= crate::MAX_NAME_LEN,
        "RB7-B1 FAIL: game_core::TOMBSTONE_DISPLAY_NAME must be <= MAX_NAME_LEN ({}) \
         characters",
        crate::MAX_NAME_LEN
    );
    assert!(
        crate::guards::validate_name(game_core::TOMBSTONE_DISPLAY_NAME).is_err(),
        "RB7-B1 FAIL: game_core::TOMBSTONE_DISPLAY_NAME must be UN-TYPABLE \
         (validate_name rejects it), so no player can mint a display name that \
         impersonates a deleted-account tombstone"
    );
}

/// RB7-B2 (M22 §3 vs. M21 AUTH-25): the M22 deletion tombstone
/// (`game_core::TOMBSTONE_DISPLAY_NAME`, read via the FLAT crate-root path —
/// this assertion doubles as the cross-crate flat-reachability pin, which is
/// why it must not be the deep `game_core::accounts::deletion::...` path)
/// must be distinct from the M21 guest-claim tombstone
/// (`super::PROFILE_TOMBSTONE_NAME`), on LIVE symbols on both sides.
///
/// A bare `assert_ne!` alone is not enough: `"(Claimed guest)"`
/// (case-folded) and `"(claimed  guest)"` (internal-whitespace-squashed)
/// are both `!=` the original value yet reproduce exactly the "a deleted
/// account reads as an unclaimed guest" confusion this criterion exists to
/// prevent (measured red-team finding #12). So this test ALSO asserts
/// distinctness survives case-folding AND whitespace-squashing together.
///
/// kills: TOMBSTONE_DISPLAY_NAME accidentally set to the live
/// PROFILE_TOMBSTONE_NAME value (direct collision, caught by the bare
/// assert_ne!); a near-miss value that only differs by case or by internal
/// whitespace from PROFILE_TOMBSTONE_NAME (finding #12 — a deleted account
/// would still read as an unclaimed guest to any case-insensitive or
/// whitespace-normalizing leaderboard consumer, caught only by the
/// fold-then-compare assertion).
#[test]
fn rb7_deletion_tombstone_is_distinct_from_guest_claim() {
    assert_ne!(
        game_core::TOMBSTONE_DISPLAY_NAME,
        super::PROFILE_TOMBSTONE_NAME,
        "RB7-B2 FAIL: the M22 deletion tombstone must not equal the M21 guest-claim \
         tombstone (super::PROFILE_TOMBSTONE_NAME) — a deleted account must never be \
         indistinguishable from an unclaimed guest"
    );

    let fold = |s: &str| -> String {
        s.chars()
            .filter(|c| !c.is_whitespace())
            .flat_map(char::to_lowercase)
            .collect()
    };
    assert_ne!(
        fold(game_core::TOMBSTONE_DISPLAY_NAME),
        fold(super::PROFILE_TOMBSTONE_NAME),
        "RB7-B2 FAIL: the M22 deletion tombstone and the M21 guest-claim tombstone \
         must remain distinct even after case-folding and whitespace-squashing — \
         \"(Claimed guest)\" and \"(claimed  guest)\" both pass a bare assert_ne! yet \
         reproduce exactly the \"deleted account reads as an unclaimed guest\" \
         confusion this criterion exists to prevent (measured red-team finding #12)"
    );
}

// ---------------------------------------------------------------------------
// RB7 scan-logic helpers — shared verbatim between the B3a/B3b/B3c pins
// below and the B5 proof-of-teeth battery, so the battery proves the exact
// logic the pins run, not a re-description of it.
// ---------------------------------------------------------------------------

/// RB7 scan helper for B3a: count of the squashed `const<IDENT>` declaration
/// needle for `PROFILE_TOMBSTONE_NAME` in `stripped` (the output of
/// `stripped_for_scan`), and the character immediately preceding its
/// (single) occurrence when the count is exactly 1.
///
/// Every visibility form squashes to a preceding `b` (`pubconst...`, from
/// `pub const`) or `)` (`pub(crate)const...`, `pub(super)const...`,
/// `pub(self)const...`, `pub(in crate::ranking)const...`), while a
/// legitimate `#[allow(dead_code)]` attribute squashes to a preceding `]`
/// and an ordinary item boundary squashes to `}` or `;` — but ALSO to a
/// module-open `{`, an attribute-close `]`, or (at the very start of a
/// scanned fragment) nothing at all. Callers must not therefore write this
/// as a positive allowlist of `}`/`;` — that would FALSE-RED a compliant
/// attribute-annotated const (measured red-team finding #7). Instead callers
/// check the NEGATIVE: the preceding char is neither `b` nor `)`.
fn rb7_decl_occurrence(stripped: &str) -> (usize, Option<char>) {
    rb7_item_occurrence(stripped, concat!("const", "PROFILE_TOMBSTONE_NAME"))
}

/// RB7 scan helper, generic over the item needle: occurrence count of `needle`
/// in `stripped`, plus the character immediately preceding its single
/// occurrence when the count is exactly 1. Shared by the const-declaration pin
/// (`rb7_decl_occurrence`) and the writer-fn pin
/// (`rb7_guest_claim_tombstone_writer_is_module_private`) so both run the same
/// preceding-char logic rather than two copies that can drift apart.
fn rb7_item_occurrence(stripped: &str, needle: &str) -> (usize, Option<char>) {
    let count = stripped.matches(needle).count();
    let preceding = if count == 1 {
        stripped
            .find(needle)
            .and_then(|idx| stripped[..idx].chars().next_back())
    } else {
        None
    };
    (count, preceding)
}

/// RB7 scan helper for B3b: count of the bare identifier
/// `PROFILE_TOMBSTONE_NAME` in `stripped` (the output of
/// `stripped_for_scan`). The declaration itself is one occurrence; every
/// legitimate use is another. A correct ranking.rs has exactly 2 (the
/// declaration and the single use in `tombstoned_profile`).
fn rb7_identifier_occurrence_count(stripped: &str) -> usize {
    let needle = concat!("PROFILE_TOMBSTONE", "_NAME");
    stripped.matches(needle).count()
}

/// RB7 scan helper for B3c: count of the guest-claim VALUE (never spelled
/// whole — assembled via `concat!`) in `raw` (the UNSTRIPPED source).
/// Deliberately raw: `stripped_for_scan` blanks string CONTENT, so a
/// stripped scan for a string VALUE is structurally vacuous.
fn rb7_value_occurrence_count(raw: &str) -> usize {
    let value = concat!("(claimed ", "guest)");
    raw.matches(value).count()
}

/// RB7-B3a (M22 §3 SSOT hardening): the `PROFILE_TOMBSTONE_NAME` const
/// declaration in ranking.rs must be MODULE-PRIVATE (a bare `const`, no
/// visibility modifier) — this slice moves it from `pub(crate)` so S3
/// cannot reach for it as the M22 deletion tombstone by mistake.
///
/// Fails LOUD and distinctly on 0 occurrences (the declaration was removed
/// or renamed — the scan itself found nothing to check) and on >1
/// occurrences (an ambiguous scan target), and only then checks the
/// preceding-char property on the single occurrence.
///
/// kills: `pub const`, `pub(crate) const`, `pub(super) const`,
/// `pub(self) const`, `pub(in crate::ranking) const` — every visibility
/// form that keeps the constant reachable from outside `ranking.rs`.
#[test]
fn rb7_guest_claim_tombstone_declaration_is_module_private() {
    let squashed = stripped_for_scan(RANKING_RS);
    let (count, preceding) = rb7_decl_occurrence(&squashed);
    match count {
        0 => panic!(
            "RB7-B3a FAIL (zero occurrences): the squashed const-declaration needle \
             for PROFILE_TOMBSTONE_NAME was not found in ranking.rs at all — the \
             declaration was removed or renamed."
        ),
        1 => {
            let Some(preceding) = preceding else {
                panic!("RB7-B3a FAIL: count == 1 but no preceding char was captured");
            };
            assert!(
                preceding != 'b' && preceding != ')',
                "RB7-B3a FAIL: the character immediately preceding the const \
                 declaration is {preceding:?} — every visibility form (`pub const` \
                 squashes to a preceding 'b'; `pub(crate) const` / `pub(super) const` \
                 / `pub(self) const` / `pub(in crate::ranking) const` all squash to a \
                 preceding ')') leaves PROFILE_TOMBSTONE_NAME reachable outside \
                 ranking.rs. It must be a bare, module-private `const`."
            );
        }
        n => panic!(
            "RB7-B3a FAIL ({n} occurrences): expected exactly one const declaration \
             for PROFILE_TOMBSTONE_NAME in ranking.rs, found {n}."
        ),
    }
}

/// RB7-B3b (M22 §3 SSOT hardening): the bare identifier
/// `PROFILE_TOMBSTONE_NAME` must occur EXACTLY TWICE in ranking.rs — the
/// declaration and its single legitimate use in `tombstoned_profile`.
/// This is the clause B3a is blind to: B3a only pins the
/// DECLARATION's own visibility keyword; it cannot see a re-export or an
/// accessor fn that hands the value back out under a different name.
///
/// kills: `pub(crate) use self::PROFILE_TOMBSTONE_NAME;` added elsewhere in
/// ranking.rs (re-exports the module-private const — count becomes 3); a
/// `pub(crate) fn guest_claim_tombstone() -> &'static str {
/// PROFILE_TOMBSTONE_NAME }` accessor (hands the value back out through a
/// public fn — count becomes 3). Either shape defeats the module-privacy
/// RB7-B3a enforces while leaving B3a itself green.
#[test]
fn rb7_guest_claim_tombstone_identifier_is_not_re_exported() {
    let squashed = stripped_for_scan(RANKING_RS);
    let count = rb7_identifier_occurrence_count(&squashed);
    assert_eq!(
        count, 2,
        "RB7-B3b FAIL: PROFILE_TOMBSTONE_NAME must occur exactly 2 times in ranking.rs \
         (its sole declaration + the single use in tombstoned_profile), \
         found {count}. A 3rd occurrence means either a `pub(crate) use \
         self::PROFILE_TOMBSTONE_NAME;` re-export was added elsewhere in the file, or \
         a `pub(crate) fn guest_claim_tombstone() -> &'static str {{ \
         PROFILE_TOMBSTONE_NAME }}` accessor was added — either shape hands the \
         module-private value back out and defeats RB7-B3a."
    );
}

/// RB7-B3c (M22 §3 SSOT hardening): the guest-claim sentinel VALUE (never
/// spelled whole in this test file — assembled via `concat!`) must occur
/// EXACTLY ONCE in the RAW, UNSTRIPPED ranking.rs source. Deliberately raw:
/// `stripped_for_scan` blanks string CONTENT, so a stripped scan for a
/// string VALUE would be structurally vacuous (it would always read as 0,
/// declaration included).
///
/// A comment mentioning the value verbatim will also RED this test, and
/// that is intended: the value must appear exactly once, in its
/// declaration, nowhere else — not even in a comment.
///
/// kills: a SECOND `pub(crate) const GUEST_TOMBSTONE_NAME: &str = "(claimed
/// guest)";` under a different identifier (B3b's identifier scan cannot see
/// this — it is a different identifier); a `#[macro_export] macro_rules!`
/// yielding the same literal (also invisible to B3a/B3b, which scan for the
/// identifier and the declaration keyword, not the value).
#[test]
fn rb7_guest_claim_tombstone_value_is_not_duplicated() {
    let count = rb7_value_occurrence_count(RANKING_RS);
    assert_eq!(
        count, 1,
        "RB7-B3c FAIL: the guest-claim value must occur exactly once in ranking.rs \
         (its sole declaration), found {count}. A 2nd occurrence means a \
         duplicate const under a different identifier, or a macro_rules! (or a \
         comment) carrying the same literal — none of which RB7-B3a/B3b's \
         identifier/declaration scans can see."
    );
}

/// RB7-B3d (M22 §3 SSOT hardening): `tombstoned_profile` — the only OTHER
/// symbol in this module that WRITES `PROFILE_TOMBSTONE_NAME` — must also be
/// module-private.
///
/// B3a/B3b/B3c between them stop the guest-claim VALUE escaping `ranking.rs`
/// as data. This clause stops it escaping as BEHAVIOUR. A `pub(crate) fn
/// tombstoned_profile` is reachable from `accounts.rs` by exactly the
/// `crate::ranking::…` path that file already uses elsewhere, and calling it
/// is a doubly-wrong deletion step: the row renders as an unclaimed guest AND
/// its ladder history is wiped by a stats-zeroing that ADR-0179 D6 scopes to
/// the guest-claim flow alone. B3b cannot see it — an `accounts.rs` CALL SITE
/// leaves this file's identifier count at 2.
///
/// kills: re-widening `tombstoned_profile` to `pub`, `pub(crate)`,
/// `pub(super)`, `pub(self)` or `pub(in …)`.
#[test]
fn rb7_guest_claim_tombstone_writer_is_module_private() {
    let squashed = stripped_for_scan(RANKING_RS);
    let needle = concat!("fn", "tombstoned_profile(");
    let (count, preceding) = rb7_item_occurrence(&squashed, needle);
    assert_eq!(
        count, 1,
        "RB7-B3d FAIL: expected exactly one `fn tombstoned_profile(` declaration in \
         ranking.rs, found {count} — the writer-privacy scan has no unambiguous target."
    );
    let Some(preceding) = preceding else {
        panic!("RB7-B3d FAIL: count == 1 but no preceding char was captured");
    };
    assert!(
        preceding != 'b' && preceding != ')',
        "RB7-B3d FAIL: the character immediately preceding `fn tombstoned_profile(` is \
         {preceding:?} — every visibility form squashes to a preceding 'b' (`pub fn`) or \
         ')' (`pub(crate) fn` and friends). Crate-visible, this fn hands the M21 \
         guest-claim tombstone AND an AUTH-25 stats-wipe to any caller, including M22's \
         deletion cascade. It must be a bare, module-private `fn`."
    );
}

/// RB7-B5 — proof-of-teeth battery for `rb7_decl_occurrence` /
/// `rb7_identifier_occurrence_count` / `rb7_value_occurrence_count`, the
/// exact three fns RB7-B3a/B3b/B3c run against `RANKING_RS`. Mirrors the
/// shape of `ptc1_scan_machinery_teeth` above: run the SAME logic against
/// small synthetic fixtures instead of the real file, and prove it produces
/// the expected verdict on each.
///
/// If this test fails, the RB7-B3a/B3b/B3c pins above cannot be trusted.
#[test]
fn rb7_scan_machinery_teeth() {
    let mut pass = 0u32;
    let mut bite = 0u32;
    let mut loud = 0u32;

    // -------------------------------------------------------------------------
    // MUST PASS 1/2 — bare private const with one legitimate use.
    // -------------------------------------------------------------------------
    let pass_bare = "
        mod fixture {
            const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
            fn use_it() -> String {
                PROFILE_TOMBSTONE_NAME.to_string()
            }
        }
    ";
    {
        let squashed = stripped_for_scan(pass_bare);
        let (count, preceding) = rb7_decl_occurrence(&squashed);
        assert_eq!(
            count, 1,
            "RB7-B5 FAIL (PASS/bare): decl count must be 1, was {count}"
        );
        let preceding = preceding.unwrap_or_else(|| {
            panic!("RB7-B5 FAIL (PASS/bare): count == 1 must carry a preceding char")
        });
        assert!(
            preceding != 'b' && preceding != ')',
            "RB7-B5 FAIL (PASS/bare): bare private const wrongly flagged (preceding \
             char {preceding:?})"
        );
        assert_eq!(
            rb7_identifier_occurrence_count(&squashed),
            2,
            "RB7-B5 FAIL (PASS/bare): identifier count must be 2 (decl + one use)"
        );
        assert_eq!(
            rb7_value_occurrence_count(pass_bare),
            1,
            "RB7-B5 FAIL (PASS/bare): value count must be 1 (the sole declaration)"
        );
        pass += 1;
    }

    // -------------------------------------------------------------------------
    // MUST PASS 2/2 — regression pin for finding #7: an `#[allow(dead_code)]`
    // attribute-annotated private const must NOT be flagged by B3a.
    // -------------------------------------------------------------------------
    let pass_attr = "
        mod fixture {
            #[allow(dead_code)]
            const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
            fn use_it() -> String {
                PROFILE_TOMBSTONE_NAME.to_string()
            }
        }
    ";
    {
        let squashed = stripped_for_scan(pass_attr);
        let (count, preceding) = rb7_decl_occurrence(&squashed);
        assert_eq!(
            count, 1,
            "RB7-B5 FAIL (PASS/attr): decl count must be 1, was {count}"
        );
        let preceding = preceding.unwrap_or_else(|| {
            panic!("RB7-B5 FAIL (PASS/attr): count == 1 must carry a preceding char")
        });
        assert!(
            preceding != 'b' && preceding != ')',
            "RB7-B5 FAIL (PASS/attr, finding #7 regression): an #[allow(dead_code)] \
             attribute-annotated private const was wrongly flagged (preceding char \
             {preceding:?}) — the scan must not use a positive item-boundary allowlist."
        );
        pass += 1;
    }

    // -------------------------------------------------------------------------
    // MUST BITE B3a (4 visibility-leak shapes).
    // -------------------------------------------------------------------------
    let bite_a_fixtures: [(&str, &str); 5] = [
        (
            "pub const",
            "mod fixture {
                pub const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                fn use_it() -> String { PROFILE_TOMBSTONE_NAME.to_string() }
            }",
        ),
        (
            "pub(crate) const",
            "mod fixture {
                pub(crate) const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                fn use_it() -> String { PROFILE_TOMBSTONE_NAME.to_string() }
            }",
        ),
        (
            "pub(super) const",
            "mod fixture {
                pub(super) const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                fn use_it() -> String { PROFILE_TOMBSTONE_NAME.to_string() }
            }",
        ),
        (
            "pub(self) const",
            "mod fixture {
                pub(self) const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                fn use_it() -> String { PROFILE_TOMBSTONE_NAME.to_string() }
            }",
        ),
        (
            "pub(in crate::ranking) const",
            "mod fixture {
                pub(in crate::ranking) const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                fn use_it() -> String { PROFILE_TOMBSTONE_NAME.to_string() }
            }",
        ),
    ];
    for (label, fixture) in bite_a_fixtures {
        let squashed = stripped_for_scan(fixture);
        let (count, preceding) = rb7_decl_occurrence(&squashed);
        assert_eq!(
            count, 1,
            "RB7-B5 FAIL (BITE-A/{label}): decl count must be 1, was {count}"
        );
        let preceding = preceding.unwrap_or_else(|| {
            panic!("RB7-B5 FAIL (BITE-A/{label}): count == 1 must carry a preceding char")
        });
        assert!(
            preceding == 'b' || preceding == ')',
            "RB7-B5 FAIL (BITE-A/{label}): visibility leak did NOT trip B3a (preceding \
             char {preceding:?}) — the declaration-privacy scan is broken."
        );
        bite += 1;
    }

    // -------------------------------------------------------------------------
    // MUST BITE B3b (2 re-export shapes: `use self::…` and an accessor fn).
    // -------------------------------------------------------------------------
    let bite_b_fixtures: [(&str, &str); 2] = [
        (
            "use self:: re-export",
            "mod fixture {
                const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                pub(crate) use self::PROFILE_TOMBSTONE_NAME;
                fn use_it() -> String { PROFILE_TOMBSTONE_NAME.to_string() }
            }",
        ),
        (
            "accessor fn",
            "mod fixture {
                const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                fn use_it() -> String { PROFILE_TOMBSTONE_NAME.to_string() }
                pub(crate) fn guest_claim_tombstone() -> &'static str {
                    PROFILE_TOMBSTONE_NAME
                }
            }",
        ),
    ];
    for (label, fixture) in bite_b_fixtures {
        let squashed = stripped_for_scan(fixture);
        let count = rb7_identifier_occurrence_count(&squashed);
        assert_ne!(
            count, 2,
            "RB7-B5 FAIL (BITE-B/{label}): re-export/accessor shape did NOT trip B3b \
             (identifier count stayed at 2) — the not-re-exported scan is broken."
        );
        bite += 1;
    }

    // -------------------------------------------------------------------------
    // MUST BITE B3c (2 value-duplication shapes: alias const, macro_rules!).
    // -------------------------------------------------------------------------
    let bite_c_fixtures: [(&str, &str); 2] = [
        (
            "alias const",
            "mod fixture {
                const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                const GUEST_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                fn use_it() -> String { PROFILE_TOMBSTONE_NAME.to_string() }
            }",
        ),
        (
            "macro_rules!",
            "mod fixture {
                const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\";
                fn use_it() -> String { PROFILE_TOMBSTONE_NAME.to_string() }
                macro_rules! guest_tombstone_literal {
                    () => { \"(claimed guest)\" };
                }
            }",
        ),
    ];
    for (label, fixture) in bite_c_fixtures {
        let count = rb7_value_occurrence_count(fixture);
        assert_ne!(
            count, 1,
            "RB7-B5 FAIL (BITE-C/{label}): value-duplication shape did NOT trip B3c \
             (value count stayed at 1) — the not-duplicated scan is broken."
        );
        bite += 1;
    }

    // -------------------------------------------------------------------------
    // MUST PASS / MUST BITE B3d — the writer fn's own visibility.
    // -------------------------------------------------------------------------
    let writer_private = "
        mod fixture {
            fn tombstoned_profile(guest: Profile) -> Profile { guest }
        }
    ";
    {
        let squashed = stripped_for_scan(writer_private);
        let needle = concat!("fn", "tombstoned_profile(");
        let (count, preceding) = rb7_item_occurrence(&squashed, needle);
        assert_eq!(
            count, 1,
            "RB7-B5 FAIL (PASS/writer-private): writer decl count must be 1, was {count}"
        );
        let preceding = preceding.unwrap_or_else(|| {
            panic!("RB7-B5 FAIL (PASS/writer-private): count == 1 must carry a preceding char")
        });
        assert!(
            preceding != 'b' && preceding != ')',
            "RB7-B5 FAIL (PASS/writer-private): a bare private fn was wrongly flagged \
             (preceding char {preceding:?})"
        );
        pass += 1;
    }

    let writer_bite_fixtures: [(&str, &str); 2] = [
        (
            "pub fn",
            "mod fixture {
                pub fn tombstoned_profile(guest: Profile) -> Profile { guest }
            }",
        ),
        (
            "pub(crate) fn",
            "mod fixture {
                pub(crate) fn tombstoned_profile(guest: Profile) -> Profile { guest }
            }",
        ),
    ];
    for (label, fixture) in writer_bite_fixtures {
        let squashed = stripped_for_scan(fixture);
        let needle = concat!("fn", "tombstoned_profile(");
        let (count, preceding) = rb7_item_occurrence(&squashed, needle);
        assert_eq!(
            count, 1,
            "RB7-B5 FAIL (BITE-D/{label}): writer decl count must be 1, was {count}"
        );
        let preceding = preceding.unwrap_or_else(|| {
            panic!("RB7-B5 FAIL (BITE-D/{label}): count == 1 must carry a preceding char")
        });
        assert!(
            preceding == 'b' || preceding == ')',
            "RB7-B5 FAIL (BITE-D/{label}): a crate-visible writer fn did NOT trip B3d \
             (preceding char {preceding:?}) — the writer-privacy scan is broken."
        );
        bite += 1;
    }

    // -------------------------------------------------------------------------
    // MUST FAIL LOUD (0 occurrences, never a silent pass): the identifier
    // appearing ONLY inside a comment, and ONLY inside a string literal.
    // -------------------------------------------------------------------------
    let loud_comment_only = "
        mod fixture {
            // PROFILE_TOMBSTONE_NAME lives elsewhere now.
            fn use_it() -> String {
                String::new()
            }
        }
    ";
    {
        let squashed = stripped_for_scan(loud_comment_only);
        let (decl_count, _) = rb7_decl_occurrence(&squashed);
        let ident_count = rb7_identifier_occurrence_count(&squashed);
        assert_eq!(
            decl_count, 0,
            "RB7-B5 FAIL (LOUD/comment-only): a comment-only mention must not be read \
             as a declaration (decl count must be 0, was {decl_count})"
        );
        assert_eq!(
            ident_count, 0,
            "RB7-B5 FAIL (LOUD/comment-only): a comment-only mention must not be \
             counted as an identifier occurrence (count must be 0, was {ident_count})"
        );
        loud += 1;
    }

    let loud_string_only = "
        mod fixture {
            fn use_it() -> &'static str {
                \"PROFILE_TOMBSTONE_NAME\"
            }
        }
    ";
    {
        let squashed = stripped_for_scan(loud_string_only);
        let (decl_count, _) = rb7_decl_occurrence(&squashed);
        let ident_count = rb7_identifier_occurrence_count(&squashed);
        assert_eq!(
            decl_count, 0,
            "RB7-B5 FAIL (LOUD/string-only): a string-literal-only mention must not be \
             read as a declaration (decl count must be 0, was {decl_count})"
        );
        assert_eq!(
            ident_count, 0,
            "RB7-B5 FAIL (LOUD/string-only): a string-literal-only mention must not be \
             counted as an identifier occurrence (count must be 0, was {ident_count})"
        );
        loud += 1;
    }

    // -------------------------------------------------------------------------
    // Red-team finding #8: an ordinary char literal (e.g. a quote-char
    // constant) desyncs `strip_rust_strings` — it has no char-literal lexer,
    // so a `"` inside `'...'` is misread as opening a real string literal.
    // For THIS fixture the true declaration is bare-private (would PASS if
    // read correctly), but the desync collapses BOTH B3a's declaration
    // needle and B3b's identifier count to 0 — it fails CLOSED, never open,
    // so the next maintainer reads "the scan desynced", not "the symbol was
    // removed". The char literal is built at runtime from a 0x22 byte
    // constant, never as a literal double-quote inside single quotes in
    // THIS file's own source (house rule: `evals/zone-warp-server-runtime
    // .eval.mjs`'s W-pre check REDs CI on that shape in production source,
    // and several evals concatenate every Rust source under server-module,
    // test files included, through naive strippers. For the same reason this
    // comment does not spell a slash-star glob: that two-character sequence
    // opens a block comment for those strippers and blanks everything after
    // it -- a full-CI-only false RED, measured on this very slice).
    // -------------------------------------------------------------------------
    let quote = char::from(0x22u8);
    let finding8_fixture = format!(
        "mod fixture {{ const Q: char = '{}'; \
         const PROFILE_TOMBSTONE_NAME: &str = \"(claimed guest)\"; \
         fn use_it() -> String {{ PROFILE_TOMBSTONE_NAME.to_string() }} }}",
        quote
    );
    {
        let squashed = stripped_for_scan(&finding8_fixture);
        let (decl_count, _) = rb7_decl_occurrence(&squashed);
        let ident_count = rb7_identifier_occurrence_count(&squashed);
        assert_eq!(
            decl_count, 0,
            "RB7-B5 FAIL (finding #8, char-literal desync): expected the desync to \
             collapse the declaration scan to 0 occurrences (fail CLOSED), found \
             {decl_count} — if this is 1, the scan machinery no longer desyncs on a \
             char literal the way the measured red-team finding described; re-verify \
             the finding is still live before trusting B3a/B3b on real ranking.rs."
        );
        assert_eq!(
            ident_count, 0,
            "RB7-B5 FAIL (finding #8, char-literal desync): expected the desync to \
             collapse the identifier-occurrence scan to 0 (fail CLOSED), found \
             {ident_count}."
        );
        loud += 1;
    }

    let total = pass + bite + loud;
    assert_eq!(
        (pass, bite, loud),
        (3, 11, 3),
        "RB7-B5 FAIL: the fixture battery has changed size — it must run 3 MUST-PASS, \
         11 MUST-BITE and 3 MUST-FAIL-LOUD fixtures. A shrunken battery is how a teeth \
         suite decays into decoration."
    );
    // The marker the rb-7 acceptance gate greps for, written through `Write`
    // rather than a print macro: `spacetime generate` rejects any print macro
    // anywhere in the module source, `#[cfg(test)]` included.
    let line = format!("RB7-TEETH-OK {total} fixtures (pass={pass} bite={bite} loud={loud})\n");
    std::io::Write::write_all(&mut std::io::stdout(), line.as_bytes())
        .expect("RB7-B5: writing the teeth marker to stdout must succeed");
}

// ===========================================================================
// m22-s3b (ADR-0228) — THE DISPLAY-NAME ANONYMIZE STEP, AND THE §4.7 GATE ON
// THE ONE REDUCER THAT COULD UNDO IT.
//
// EARS criteria:
//   PRV1-6c  `player.name` and `profile.name` are overwritten with the deletion
//            tombstone; the primary key and every other field survive (spec §3
//            classifies both tables ANONYMIZE, and ADR-0119 carries an explicit
//            never-delete invariant for `profile`).
//   PRV1-9   a caller inside the §4.7 deletion gate cannot rename themselves —
//            without which a still-connected terminal session un-tombstones its
//            own display name one call after the cascade, hollowing PRV1-6c.
//
// WHY THIS MODULE OWNS THE STEP (ADR-0228 D1): `player` has no single owning
// module — accounts.rs's own header says so — and `ranking.rs` already owns the
// display-name write path (`set_profile_name` writes `player.name`; the ADR-0125
// passive mirror carries it onto `profile.name`). Putting the anonymize anywhere
// else would create a second display-name writer.
//
// WHY THE SENTINEL IS THE GAME-CORE ONE AND NOT THIS MODULE'S:
// `PROFILE_TOMBSTONE_NAME` means `an unclaimed guest whose ranked stats were
// carried forward`, and `tombstoned_profile` also ZEROES rating/wins/losses,
// which is meaningless for a deletion. Both are module-private precisely so S3
// could not reach for them by mistake (rb-7, ADR-0211); this section asserts the
// two values stay distinct rather than trusting the visibility alone.
//
// SCAN HYGIENE: needles are assembled with `concat!` per this file's
// convention; no bare double-quote appears inside any comment here, and this
// section spells no block-comment delimiter and never writes the guest-claim
// sentinel VALUE.
// ===========================================================================

/// **PRV1-6c (pure)** — `player_with_deleted_name` and `profile_with_deleted_name`
/// overwrite ONLY `name`, with the game-core deletion tombstone.
///
/// TWO SEAMS RATHER THAN ONE, because the two rows are different types with
/// different survivors: `player` carries the presence/reconciliation state that
/// must keep working for a still-connected session, and `profile` carries the
/// ranked ladder columns that spec §3 deliberately does NOT scrub (ADR-0228
/// records that survival as a named pseudonymization limitation, so a helper
/// that zeroed them here would silently exceed the spec rather than fall short
/// of it).
///
/// THE VALUE COMES FROM game-core AND IS ASSERTED DISTINCT FROM THE GUEST-CLAIM
/// SENTINEL. `PROFILE_TOMBSTONE_NAME` in this module means `an unclaimed guest
/// whose stats were carried forward`; writing it on a DELETED account would
/// render a deleted player as a claimed guest — the wrong tombstone, on the
/// wrong subject, in the one flow that cannot be undone. Both this module's
/// sentinel and `tombstoned_profile` are module-private for exactly that reason;
/// the inequality clause is what makes the distinction a fact rather than a
/// naming convention.
///
/// Kills: a helper that writes this module's guest-claim sentinel instead of the
///        deletion one; one that also zeroes `rating`/`wins`/`losses` (which
///        `tombstoned_profile` does, and which is what makes reaching for THAT
///        helper look plausible); one that rewrites the primary key; one that
///        touches `player.entity_id` (the join key `character` is reached
///        through) or `player.online`; an identity function.
#[test]
fn m22s3b_deleted_name_rows() {
    let tombstone = game_core::TOMBSTONE_DISPLAY_NAME;

    assert!(
        !tombstone.trim().is_empty(),
        "[m22s3b/name-nonblank] game_core::TOMBSTONE_DISPLAY_NAME must be non-blank. A blank \
         display name renders as nothing at all on the leaderboard and in every player list, \
         which is indistinguishable from a rendering bug — the row is supposed to say `this \
         account was deleted`, not to disappear."
    );
    assert_eq!(
        tombstone,
        tombstone.trim(),
        "[m22s3b/name-trim-stable] the tombstone must be trim-stable: padding renders as a \
         blank name while every non-empty and distinctness clause stays green."
    );
    assert_ne!(
        tombstone,
        super::PROFILE_TOMBSTONE_NAME,
        "[m22s3b/name-not-guest-sentinel] the DELETION tombstone must differ from this \
         module's GUEST-CLAIM sentinel. They mean different things: the guest-claim one says \
         `an unclaimed guest whose ranked stats were carried forward` and is written by \
         `tombstoned_profile`, which ALSO zeroes rating, wins and losses. Writing it on a \
         deleted account renders that account as a claimed guest AND destroys ladder columns \
         spec §3 says survive. Both are module-private (rb-7, ADR-0211) so the compiler \
         refuses the reuse, but this clause is what keeps the two VALUES from converging."
    );

    // --- player -------------------------------------------------------------
    let before_player = crate::schema::Player {
        identity: spacetimedb::Identity::from_byte_array([71u8; 32]),
        entity_id: 4_242,
        name: "Ash".to_string(),
        online: true,
        last_input_seq: 909,
    };
    let identity = before_player.identity;
    let entity_id = before_player.entity_id;
    let online = before_player.online;
    let last_input_seq = before_player.last_input_seq;
    let after_player = super::player_with_deleted_name(before_player);

    assert_eq!(
        after_player.name, tombstone,
        "[m22s3b/player-name] PRV1-6c: `player.name` must become \
         game_core::TOMBSTONE_DISPLAY_NAME. It is the display name every other client sees \
         for this identity, and it is the value the ADR-0125 passive mirror carries onto the \
         public `profile` row on the next rated game."
    );
    assert_eq!(
        after_player.identity, identity,
        "[m22s3b/player-pk] the primary key must survive: spec §3 requires the `player` row \
         itself to survive as the ANCHOR that `character` and every still-live multi-user row \
         point at. Anonymize is a field update, never a delete."
    );
    assert_eq!(
        after_player.entity_id, entity_id,
        "[m22s3b/player-entity-id] `entity_id` must survive. It is the JOIN KEY the \
         `character` sweep resolves through (the manifest pins `character` as ViaJoin \
         `player`), so clobbering it here would make the §4.4 step-4 sweep unable to find the \
         row it is supposed to delete."
    );
    assert_eq!(
        after_player.online, online,
        "[m22s3b/player-online] `online` is presence state, not PII, and must survive: the \
         cascade can fire against a CONNECTED session, and rewriting its presence flag would \
         desynchronise that session's own client from the server."
    );
    assert_eq!(
        after_player.last_input_seq, last_input_seq,
        "[m22s3b/player-seq] `last_input_seq` is the movement reconciliation ack and must \
         survive — rewinding it would replay or drop the connected session's inputs."
    );

    // --- profile ------------------------------------------------------------
    let before_profile = make_profile(72, "Ash", 1_800, 40, 3);
    let profile_identity = before_profile.identity;
    let after_profile = super::profile_with_deleted_name(before_profile);

    assert_eq!(
        after_profile.name, tombstone,
        "[m22s3b/profile-name] PRV1-6c: `profile.name` must become the same game-core \
         tombstone. `profile` is PUBLIC and world-readable — it IS the leaderboard — so this \
         is the field that actually removes the deleted player's name from every other \
         client's view."
    );
    assert_eq!(
        after_profile.identity, profile_identity,
        "[m22s3b/profile-pk] the primary key survives. ADR-0119 carries an explicit \
         NEVER-DELETE invariant for `profile`, restated in the table's own doc comment; \
         anonymize is a field update, so the invariant holds by construction rather than by \
         exception."
    );
    assert_eq!(
        after_profile.rating, 1_800,
        "[m22s3b/profile-rating] `rating` must SURVIVE. Spec §3 anonymizes `name` only, and \
         ADR-0228 records the survival of the ladder columns as a NAMED pseudonymization \
         limitation. Zeroing them here is what `tombstoned_profile` does for the GUEST-CLAIM \
         flow, and reaching for that helper is the exact mistake rb-7 made module-private to \
         prevent — it would silently exceed the spec and destroy the opponents' own rated \
         history in the process."
    );
    assert_eq!(
        after_profile.wins, 40,
        "[m22s3b/profile-wins] `wins` survives — see the rating clause."
    );
    assert_eq!(
        after_profile.losses, 3,
        "[m22s3b/profile-losses] `losses` survives — see the rating clause."
    );
}

/// **PRV1-6c (scan)** — `anonymize_display_names` writes both name rows through
/// their pure seams, deletes nothing, and never reaches the guest-claim path.
///
/// THE DELETE BAN IS AN INVARIANT, NOT TIDINESS: ADR-0119 forbids deleting a
/// `profile` row outright, and spec §3 requires the `player` row to survive as
/// the anchor `character` and every live multi-user row point at. This body is
/// the one new place in the module that could break either.
///
/// THE GUEST-CLAIM BAN IS THE rb-34 HAZARD, ONE MODULE OVER: `rekey_profile` and
/// `tombstoned_profile` write this module's guest-claim sentinel AND zero the
/// ladder columns. Reached from the deletion cascade they render a deleted
/// account as a claimed guest and destroy stats spec §3 says survive. The
/// visibility rules already make the wrong helper unreachable from accounts.rs;
/// this clause makes it unreachable from the RIGHT module too.
///
/// THE MATCH-READ RULE IS LOAD-BEARING AND EASY TO GET WRONG: this file's
/// `d1_scan_no_eager_write_in_get_or_init` clauses (b) and (c) ban the substrings
/// `=ctx.db.profile()` and `=ctx.db.player()` file-wide, because assigning a
/// table accessor to a binding is the documented evasion of the never-deleted
/// structural scan. A `let Some(p) = ctx.db.player().identity().find(owner)` in
/// this body contains that substring and reds those clauses from the other
/// direction. Read through `match`, exactly as `get_or_init_profile` and
/// `rekey_profile` already do — this body-scoped restatement is here so the
/// failure names the reason rather than pointing at a whole-file ban.
///
/// Kills: a helper that deletes either row; one that routes through
///        `rekey_profile`/`tombstoned_profile`; one that inlines the name write
///        instead of using the pure seams (which puts the field-survival rules
///        out of reach of the executed test above); a split-binding read.
#[test]
fn m22s3b_anonymize_display_names_shape() {
    let squashed = stripped_for_scan(RANKING_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fnanonymize_display", "_names("))
        .unwrap_or_else(|| {
            panic!(
                "PRV1-6c FAIL (extraction): ranking.rs declares no \
                 `fn anonymize_display_names(`. The cascade delegates the `player` and \
                 `profile` ANONYMIZE to this module because it already owns the display-name \
                 write path (ADR-0228 D1); without it PRV1-6c never runs. Fail LOUD rather \
                 than pass vacuously."
            )
        });

    for (needle, what) in [
        (
            concat!("player_with_deleted", "_name("),
            "the player-row name seam",
        ),
        (
            concat!("profile_with_deleted", "_name("),
            "the profile-row name seam",
        ),
    ] {
        let n = m22s3b_count(body, needle);
        assert_eq!(
            n, 1,
            "PRV1-6c FAIL (pure seam): anonymize_display_names must compose the row through \
             `{needle}` ({what}) EXACTLY once; found {n}. This crate has no \
             reducer-executing harness, so an inline `p.name = ..;` here puts every \
             field-survival rule — the surviving primary key, the surviving `entity_id` join \
             key, the surviving ladder columns — permanently out of reach of \
             `m22s3b_deleted_name_rows`, which is the only test that can execute them. The \
             `zeroed_wallet` / `profile_with_carried_stats` precedent is the same rule."
        );
    }

    // --- THE TWO WRITES, COUNTED (added in r2) ------------------------------
    //
    // `d1_scan_no_eager_write_in_get_or_init` pins the PROFILE write of this
    // function at exactly 1 (that is what its 4 -> 5 whole-file re-derivation
    // paid for). NOTHING pinned the PLAYER write — and a red-team measured the
    // gap: a body that composes `player_with_deleted_name(..)` and then drops the
    // result on the floor satisfies the seam clause above, deletes nothing, and
    // leaves `player.name` untouched. That is the field every other client
    // actually renders for this identity, AND the field the ADR-0125 passive
    // mirror copies onto the PUBLIC profile row at the next rated game — so the
    // profile tombstone this function did write is overwritten with the live name
    // the moment anything rates. PRV1-6c ends up worse than not done.
    for (needle, table, why) in [
        (
            concat!("player().identity().upd", "ate("),
            "player",
            "the presence row's `name` is the display name every other client sees for this \
             identity, and the ADR-0125 passive mirror copies it onto the PUBLIC `profile` \
             row on the next rated game — so leaving it live silently un-does the profile \
             tombstone this same function wrote",
        ),
        (
            concat!("profile().identity().upd", "ate("),
            "profile",
            "the `profile` row IS the public leaderboard; this is the write that removes the \
             deleted player's name from every other client's view",
        ),
    ] {
        let n = m22s3b_count(body, needle);
        assert_eq!(
            n, 1,
            "PRV1-6c FAIL ({table} write): anonymize_display_names must write the `{table}` \
             row EXACTLY once, as `{needle}`; found {n}. ZERO means {why}. MORE THAN ONE is a \
             second, unreviewed write in the one flow that cannot be undone. Composing the \
             row through its pure seam (pinned above) and never writing the result is the \
             measured cheat this clause closes — the compiler is silent about it, because a \
             pure function's return value is not `#[must_use]`."
        );
    }

    assert_eq!(
        m22s3b_count(body, concat!(".del", "ete(")),
        0,
        "PRV1-6c FAIL (never delete): anonymize_display_names contains a row delete. \
         ADR-0119 carries an explicit NEVER-DELETE invariant for `profile`, restated in the \
         table's own doc comment, and spec §3 requires the `player` row to survive as the \
         anchor `character` and every still-live multi-user row point at. Anonymize is a \
         field update and must stay one — that is what makes the invariant hold by \
         construction rather than by exception."
    );

    for banned in [concat!("rek", "ey"), concat!("tombstoned", "_profile")] {
        assert_eq!(
            m22s3b_count(body, banned),
            0,
            "PRV1-6c FAIL (wrong tombstone): anonymize_display_names names `{banned}`. That \
             path writes the M21 GUEST-CLAIM sentinel and ALSO zeroes rating, wins and \
             losses — so reached from the deletion cascade it renders a DELETED account as \
             an unclaimed guest whose stats were carried forward, and destroys ladder \
             columns spec §3 says survive. ADR-0228 D1 bans those substrings in every new \
             identifier of this slice for exactly that reason."
        );
    }

    for banned in [
        concat!("=ctx.db.", "profile()"),
        concat!("=ctx.db.", "player()"),
    ] {
        assert_eq!(
            m22s3b_count(body, banned),
            0,
            "PRV1-6c FAIL (split binding): anonymize_display_names contains `{banned}`. This \
             file bans that substring FILE-WIDE in \
             `d1_scan_no_eager_write_in_get_or_init` clauses (b) and (c), because assigning a \
             table accessor to a binding is the documented evasion of the never-deleted \
             structural scan (ADR-0119 D3 / RL-2). A `let Some(p) = ctx.db.player()...` read \
             produces it. Use the `match ctx.db.player().identity().find(owner)` form that \
             `get_or_init_profile` and `rekey_profile` already use — this body-scoped \
             restatement exists so the failure names the reason instead of pointing at a \
             whole-file ban."
        );
    }
}

/// **PRV1-9 (scan)** — `set_profile_name` carries the §4.7 deletion gate, before
/// it writes.
///
/// THE HOLE THIS CLOSES (ADR-0228 D7(h), RT-2). `set_profile_name` writes
/// `player.name`, which is an ANONYMIZE-classified column that the cascade has
/// just overwritten with the tombstone. Without the gate, a still-connected
/// terminal session calls this reducer one moment after the cascade completes
/// and puts its own display name back — on a `player` row the cascade
/// deliberately left alive, and from there onto the PUBLIC `profile` row via the
/// ADR-0125 passive mirror at the next rated game. PRV1-6c is hollowed by a
/// single reducer call, and nothing anywhere logs it.
///
/// The `?` IS PART OF THE PIN, for the reason `trading_tests.rs` and
/// `pvp_tests.rs` both already record: `let _ = crate::guards::require_not_deleting(..);`
/// compiles, calls the gate, throws the answer away, renames anyway, and stays
/// clippy-clean under `-D warnings` because `let_underscore_must_use` is off by
/// default.
///
/// DEPTH 0 IS THE REACHABILITY CLAUSE: every other assertion here is
/// POSITION-based and therefore blind to a gate nested in a never-taken block,
/// which leaves the exact text in the file and gates nothing.
///
/// Kills: no gate at all; a gate whose result is discarded; a gate nested in a
///        conditional; a gate placed after the `player` write, which renames
///        first and reports afterwards.
#[test]
fn m22s3b_set_profile_name_gated() {
    let squashed = stripped_for_scan(RANKING_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fnset_profile", "_name("))
        .expect("PRV1-9: fn set_profile_name not found in ranking.rs");

    let gate = concat!("crate::guards::require_not_", "deleting(ctx,");
    let n_gate = m22s3b_count(body, gate);
    assert_eq!(
        n_gate, 1,
        "PRV1-9 FAIL: set_profile_name must call `{gate}..)?;` EXACTLY once; found {n_gate}. \
         ZERO is the RT-2 hole ADR-0228 D7(h) closes: this reducer writes `player.name`, an \
         ANONYMIZE-classified column the cascade has just tombstoned, so a still-connected \
         terminal session can put its own display name back one call after the erasure \
         completes — and the ADR-0125 passive mirror then carries it onto the PUBLIC \
         `profile` row at the next rated game. PRV1-6c is hollowed by one reducer call. The \
         `ctx` subject is part of the needle: the gate answers about the CALLER, and it can \
         only do that from the reducer context. MORE THAN ONE is a duplicated guard."
    );

    let at_gate = body
        .find(gate)
        .expect("PRV1-9: the gate counted 1 but could not be located");

    // The `?` must be in the gate's OWN statement — a discarded result compiles,
    // calls the gate, ignores the answer, and renames anyway.
    let stmt_end = body[at_gate..]
        .find(';')
        .map(|r| at_gate + r)
        .unwrap_or(body.len());
    let stmt = &body[at_gate..stmt_end];
    assert!(
        stmt.contains('?'),
        "PRV1-9 FAIL (discarded result): the deletion-gate statement in set_profile_name \
         carries no `?` propagation operator. `let _ = crate::guards::require_not_deleting(..);` \
         compiles, CALLS the gate, throws the answer away, and renames anyway — and it stays \
         clippy-clean under -D warnings because `let_underscore_must_use` is off by default. \
         Both `trading_tests.rs` and `pvp_tests.rs` record this exact cheat against their own \
         §4.7 gates. Statement read: {stmt:?}"
    );

    // Reachability: the gate must be an unconditional top-level statement.
    let opens = body[..at_gate].matches('{').count() as i64;
    let closes = body[..at_gate].matches('}').count() as i64;
    assert_eq!(
        opens - closes,
        0,
        "PRV1-9 FAIL (reachability): the deletion gate in set_profile_name sits at brace \
         depth {} of the reducer body, not 0. Every other assertion here is POSITION-based \
         and blind to this: wrapping the statement in an always-false block, or in any other \
         conditional, leaves the exact text in the file, keeps the count at 1, keeps it \
         before the write — and never runs it.",
        opens - closes
    );

    let write = concat!("player().identity().upd", "ate(");
    let n_write = m22s3b_count(body, write);
    assert_eq!(
        n_write, 1,
        "PRV1-9 FAIL (anchor): set_profile_name must write the player row EXACTLY once; \
         found {n_write}. The ordering clause below anchors on it, so a second write would \
         steer a first-hit index — and with ZERO the ordering clause is vacuously true and \
         proves nothing."
    );
    let at_write = body
        .find(write)
        .expect("PRV1-9: the player write counted 1 but could not be located");
    assert!(
        at_gate < at_write,
        "PRV1-9 FAIL (decision before effect): the deletion gate (offset {at_gate}) must \
         precede the `player` name write (offset {at_write}). A gate that runs after the \
         rename has already un-tombstoned the row and merely reports it — and the rename is \
         the whole effect this reducer has."
    );
}

/// Non-overlapping occurrences of `needle` in `hay`.
///
/// A local, slice-prefixed counter rather than a reuse of any sibling module's:
/// every `*_tests.rs` file in this crate is a `#[cfg(test)]` child of its own
/// production file and none can reach another's bare `fn` items (the precedent
/// `content_cache_tests.rs` records for its own stripper copies).
fn m22s3b_count(hay: &str, needle: &str) -> usize {
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

// ===========================================================================
// rb-41 — R-rb-25-X9 (ADR-0222 known-limit 2, closed by the ADR-0224 native
// host migration): the REKEY exists-predicate for `profile`, exercised against
// REAL rows instead of against its own source text.
//
// ADR-0222's guest-claim-integrity gate could only READ this predicate's
// source, so a HOLLOWED body — one that still performs the table read but
// returns a value decoupled from it — passed every check. The test below runs
// the shipped predicate against the in-memory host (native_host_tests) and
// pins its answer to the rows that actually exist, which no source scan can do.
// ===========================================================================

/// EARS R-rb-25-X9: `ranking::profile_exists` must answer from the CURRENT rows
/// of `profile`, for the ASKED identity — false with no row, false while only a
/// stranger owns one, true once the identity owns one, false again once that
/// row is gone (while the stranger's row survives). The paired
/// `accounts::account_has_game_data` assertions pin the `profile` disjunct of
/// the six-way `||` chain that decides whether a guest holds game data.
///
/// kills:
///   - the ADR-0222 known-limit hollow, `{ let _ = <the profile read>; false }`:
///     the own-row assertion goes red while every source scan stays green.
///   - the inverted hollow, `{ let _ = <the profile read>; true }`: the
///     empty-table assertion goes red.
///   - a body that answers does-the-table-hold-ANY-row instead of
///     does-THIS-identity-hold-one: the stranger-only assertion goes red, and
///     so does the post-removal assertion (the stranger's row is still there).
///   - a latched or memoised answer that never returns to false once it has
///     seen a row: the post-removal assertion goes red.
///   - deleting the `profile` disjunct from `accounts::account_has_game_data`:
///     the paired account assertion goes red while the direct predicate
///     assertion stays green, naming the missing disjunct exactly.
#[test]
fn rb41_profile_exists_tracks_real_profile_rows() {
    let fx = crate::native_host_tests::fixture();
    let t = fx.table::<Profile>("profile", "profile_identity_idx_btree", |r| r.identity);
    let ctx = fx.ctx();
    // Identities come off the rows themselves, so the seeded row and the asked
    // identity cannot drift apart.
    let owner_row = make_profile(13, "rb41-owner", 1000, 0, 0);
    let stranger_row = make_profile(14, "rb41-stranger", 1000, 0, 0);
    let owner = owner_row.identity;
    let stranger = stranger_row.identity;

    assert!(
        !crate::ranking::profile_exists(&ctx, owner),
        "profile_exists must be false for an identity with no profile row: the table is empty \
         here, so a true answer means the return value is not derived from the table read"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be false while the identity owns no row in ANY REKEY \
         table: no row of any kind has been seeded yet"
    );

    t.seed(&stranger_row);
    assert!(
        !crate::ranking::profile_exists(&ctx, owner),
        "profile_exists must stay false when the ONLY profile row belongs to a different \
         identity: the predicate answers per-identity, never table-is-non-empty"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must stay false when the only seeded row belongs to a stranger: \
         a guest claim keys on the CALLER identity, not on global table population"
    );

    t.seed(&owner_row);
    assert!(
        crate::ranking::profile_exists(&ctx, owner),
        "profile_exists must report true while that identity holds a profile row; a body that \
         reads the table and then returns a constant false (the ADR-0222 known-limit hollow) \
         fails exactly here. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be true through its profile disjunct while the identity \
         holds a profile row and nothing else; a deleted disjunct fails exactly here. Indexes \
         the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        t.remove(owner),
        1,
        "the identity had exactly one profile row to remove: a different count means the \
         seeded state was not the state this test reasons about"
    );
    assert!(
        !crate::ranking::profile_exists(&ctx, owner),
        "profile_exists must return to false once that identity's profile row is gone: the \
         answer tracks live rows, so it can never latch on a row that no longer exists"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must return to false once the identity's last REKEY-table row \
         is gone: this is the state in which a guest claim is allowed to proceed"
    );
    assert!(
        crate::ranking::profile_exists(&ctx, stranger),
        "removing one identity's row must leave the stranger's row untouched: without this the \
         negative above could be explained by an emptied table rather than by identity scoping. \
         Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}
