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
/// Three sub-assertions (all whitespace-free):
///   (a) profile().identity().update( count == 2 — the two existing apply_pvp_rating
///       writes; an eager Some-arm write would make it 3. (Starts GREEN — regression pin.)
///   (b) `=ctx.db.profile()` absent — split-binding evasion of the never-deleted scan.
///       Starts GREEN: the current file's profile accesses are `match ctx.db.profile()...`
///       and `.insert(` — no `=`-binding of the accessor. Gate fires if a bad impl adds one.
///   (c) `=ctx.db.player()` absent — forces all player-table reads in ranking.rs through
///       the `live_player_name` helper (ADR-0125 D3). Lifecycle: started RED pre-impl
///       (old None arm bound `let name = ctx.db.player()...`, squashing to
///       `letname=ctx.db.player()` which matched the needle); turned GREEN after the impl
///       routed both get_or_init_profile arms through live_player_name; stays as a gate
///       against split-binding regressions in future edits. The needle cannot distinguish
///       binding-the-accessor from binding-a-chain-result — it bans both forms intentionally.
///
/// Update-count == 2 is a REGRESSION PIN — documented as green-at-birth by design.
/// Sub-assertion (b) also starts GREEN (no profile-accessor binding in current code).
/// Sub-assertion (c) started RED pre-impl, now GREEN post-impl (see lifecycle above).
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
            let me = ctx.sender;
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
            let me = ctx.sender;
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
            let mut player = match ctx.db.player().identity().find(ctx.sender) {{
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
