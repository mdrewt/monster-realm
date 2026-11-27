//! `ranking` domain-submodule tests — m17a + m17.5d + the
//! M21/M22 profile re-key and tombstone seams.
//!
//! Declared from `server-module/src/ranking.rs` as:
//!   `#[path = "ranking_tests.rs"] mod ranking_tests;`
//! so `super::` resolves to `ranking.rs`.
//!
//! Pure seams (refresh_profile_name, tombstoned_profile, profile_with_carried_stats,
//! the deletion-name transforms) are tested directly; ctx-bound code
//! (set_profile_name, apply_pvp_rating, rekey_profile, anonymize_display_names,
//! profile_exists) runs SHIPPED under the in-memory native host. Rating arithmetic
//! delegates entirely to game_core (tested there).

use crate::schema::Profile;
use spacetimedb::Identity;

// ---------------------------------------------------------------------------
// RL-4 seed constant pin
//
// game_core::INITIAL_RATING is the SSOT for the starting rating.
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

// ---------------------------------------------------------------------------
// T1 — Executed pure-core tests of refresh_profile_name.
//
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

/// When a live player name is present (`Some`), `refresh_profile_name`
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

/// When the live player row is absent (`None`), `refresh_profile_name`
/// must return the profile completely unchanged — preserving the last-known name
/// even during a disconnect-forfeit race.
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

/// Idempotency — refreshing with the same name is a no-op.
///
/// Guards against an inequality-gated refactor that special-cases same-name
/// Some and accidentally changes other fields or returns a different struct.
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

/// A renamed player who wins a rated game must have the NEW name
/// persisted in the winner update row.
///
/// Composes `refresh_profile_name` through the apply_pvp_rating-shaped spread
/// construction — exactly `Profile { rating: new_r, wins: refreshed.wins.saturating_add(1),
/// ..refreshed }` — to prove the spread propagates the refreshed name.
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

/// A renamed player who LOSES a rated game must have the NEW name
/// persisted in the loser update row.
///
/// Mirrors d2_rename_then_rated_surfaces_new_name_winner_side for the loser path
/// (both roles must surface the new name).
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

// ===========================================================================
// M21a AUTH-25: guest->account profile re-key. Stats are copied
// FORWARD onto the destination row, then the guest's own row is ZEROED and its
// name tombstoned in place (never deleted). The zero step is load-bearing, not
// cosmetic — it is the CRITICAL unbounded ranked-stat duplication path.
//
// Pure seams tested directly via super:: (no ReducerContext required):
//   tombstoned_profile / profile_with_carried_stats / PROFILE_TOMBSTONE_NAME.
// ===========================================================================

/// THE SINGLE MOST IMPORTANT TOOTH: `tombstoned_profile`
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

/// `profile_with_carried_stats` copies the three stats onto the
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
// single-sourcing the deletion-tombstone display name in game-core, and
// pinning the M21 guest-claim sentinel (`PROFILE_TOMBSTONE_NAME`, declared
// above) as module-private so S3 cannot reach for it by mistake.
//
// B1/B2 are EXECUTED pins over the live `game_core::TOMBSTONE_DISPLAY_NAME`
// constant (mirroring the AUTH-25 `auth25_tombstone_name_is_bounded_and_
// untypable` pin above, for the DISTINCT M22 deletion sentinel).
// ===========================================================================

/// the game-core deletion tombstone `TOMBSTONE_DISPLAY_NAME`
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

/// the M22 deletion tombstone (`game_core::TOMBSTONE_DISPLAY_NAME`, read via
/// the FLAT crate-root path — this assertion doubles as the cross-crate
/// flat-reachability pin, which is why it must not be the deep
/// `game_core::accounts::deletion::...` path) must be distinct from the M21
/// guest-claim tombstone (`super::PROFILE_TOMBSTONE_NAME`), on LIVE symbols
/// on both sides.
///
/// A bare `assert_ne!` alone is not enough: `"(Claimed guest)"`
/// (case-folded) and `"(claimed  guest)"` (internal-whitespace-squashed)
/// are both `!=` the original value yet reproduce exactly the "a deleted
/// account reads as an unclaimed guest" confusion this criterion exists to
/// prevent. So this test ALSO asserts distinctness survives case-folding AND
/// whitespace-squashing together.
///
/// kills: TOMBSTONE_DISPLAY_NAME accidentally set to the live
/// PROFILE_TOMBSTONE_NAME value (direct collision, caught by the bare
/// assert_ne!); a near-miss value that only differs by case or by internal
/// whitespace from PROFILE_TOMBSTONE_NAME (a deleted account
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

// ===========================================================================
// THE DISPLAY-NAME ANONYMIZE STEP, AND THE §4.7 GATE ON
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
// WHY THIS MODULE OWNS THE STEP: `player` has no single owning
// module — accounts.rs's own header says so — and `ranking.rs` already owns the
// display-name write path (`set_profile_name` writes `player.name`; the ADR-0125
// passive mirror carries it onto `profile.name`). Putting the anonymize anywhere
// else would create a second display-name writer.
//
// WHY THE SENTINEL IS THE GAME-CORE ONE AND NOT THIS MODULE'S:
// `PROFILE_TOMBSTONE_NAME` means `an unclaimed guest whose ranked stats were
// carried forward`, and `tombstoned_profile` also ZEROES rating/wins/losses,
// which is meaningless for a deletion. Both are module-private precisely so S3
// could not reach for them by mistake; this section asserts the
// two values stay distinct rather than trusting the visibility alone.

// ===========================================================================

/// `player_with_deleted_name` and `profile_with_deleted_name`
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
        discriminator: 0,
        lead_level: 0,
    };
    let identity = before_player.identity;
    let entity_id = before_player.entity_id;
    let online = before_player.online;
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

// ===========================================================================
// the REKEY exists-predicate for `profile`, exercised against
// REAL rows instead of against its own source text.
//
// The test below runs the shipped predicate against the in-memory host
// (native_host_tests) and pins its answer to the rows that actually exist,
// which no source scan can do.
// ===========================================================================

/// `ranking::profile_exists` must answer from the CURRENT rows
/// of `profile`, for the ASKED identity — false with no row, false while only a
/// stranger owns one, true once the identity owns one, false again once that
/// row is gone (while the stranger's row survives). The paired
/// `accounts::account_has_game_data` assertions pin the `profile` disjunct of
/// the six-way `||` chain that decides whether a guest holds game data.
///
/// kills:
///   - `{ let _ = <the profile read>; false }`:
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
    let t = fx.table::<Profile>("profile", "identity", |r| r.identity);
    let ctx = fx.ctx();
    // Identities come off the rows themselves, so the seeded row and the asked
    // identity cannot drift apart.
    let owner_row = make_profile(13, "", 0, 0, 0);
    let stranger_row = make_profile(14, "", 0, 0, 0);
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

// ===========================================================================
// Native-host behavioural suite (debloat Phase 2: EV-ranking-security#rating-integrity,
// ST-ranking_tests). The bindings half — set_profile_name is the ONLY client reducer
// that can reach `player`/`profile` names, and no client reducer takes a rating — is
// client-surface-privacy clause (D).
// ===========================================================================

use crate::native_host_tests::{fixture as rk_fixture, Fixture as RkFixture, Handle as RkHandle};
use crate::schema::{Account as RkAccount, Battle as RkBattle, Player as RkPlayer};
use game_core::BattleOutcome as RkOutcome;

fn rk_a() -> Identity {
    Identity::from_byte_array([0x3A; 32])
}
fn rk_b() -> Identity {
    Identity::from_byte_array([0x3B; 32])
}

struct RkWorld<'a> {
    players: RkHandle<'a, RkPlayer>,
    profiles: RkHandle<'a, Profile>,
    accounts: RkHandle<'a, RkAccount>,
    /// sr-4b: every `profile` writer ends with the membership rescan.
    ladder: RkHandle<'a, crate::schema::LeaderboardTop>,
}

fn rk_world(fx: &RkFixture) -> RkWorld<'_> {
    let w = RkWorld {
        players: fx
            .table::<RkPlayer>("player", "identity", |r| r.identity)
            .writable()
            .unique(),
        profiles: fx
            .table::<Profile>("profile", "identity", |r| r.identity)
            .writable()
            .unique(),
        accounts: fx.table::<RkAccount>("account", "identity", |r| r.identity),
        ladder: fx.ladder(),
    };
    for (who, name) in [(rk_a(), "Alice"), (rk_b(), "Bob")] {
        w.players.seed(&RkPlayer {
            identity: who,
            entity_id: u64::from(who.to_byte_array()[0]),
            name: name.to_string(),
            online: true,
            discriminator: 0,
            lead_level: 0,
        });
    }
    w
}

impl RkWorld<'_> {
    fn name(&self, who: Identity) -> Option<String> {
        self.players
            .rows()
            .into_iter()
            .find(|p| p.identity == who)
            .map(|p| p.name)
    }
    fn profile(&self, who: Identity) -> Option<(String, i32, u32, u32)> {
        self.profiles
            .rows()
            .into_iter()
            .find(|p| p.identity == who)
            .map(|p| (p.name, p.rating, p.wins, p.losses))
    }
    fn seed_profile(&self, who: Identity, name: &str, rating: i32, wins: u32, losses: u32) {
        self.profiles.seed(&Profile {
            identity: who,
            name: name.to_string(),
            rating,
            wins,
            losses,
        });
    }
    fn snapshot(&self) -> Vec<Vec<u8>> {
        use spacetimedb::sats::bsatn::to_vec;
        vec![
            to_vec(&self.players.rows()).unwrap(),
            to_vec(&self.profiles.rows()).unwrap(),
        ]
    }
}

/// `set_profile_name` refuses an unjoined or a deletion-gated caller and an invalid name
/// without writing; on success it writes ONLY the caller's `player.name`
/// (validated/normalised) — the caller's profile row (rating, W/L, leaderboard name) and
/// every other row stay byte-identical.
/// kills: set_profile_name -> Ok(()), validation skipped, deletion gate removed, a
/// profile write added, the wrong player row updated.
#[test]
fn nh_set_profile_name_writes_only_the_callers_player_name() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    w.seed_profile(rk_a(), "Alice", 1234, 5, 6);
    w.seed_profile(rk_b(), "Bob", 999, 1, 2);
    let before = w.snapshot();
    let ghost = Identity::from_byte_array([0x3F; 32]);
    assert_eq!(
        fx.run_as(ghost, |ctx| super::set_profile_name(
            ctx,
            "Ghost".to_string()
        )),
        Err("not joined".to_string())
    );
    let long = "x".repeat(crate::MAX_NAME_LEN + 1);
    for bad in ["", "   ", "(claimed guest)", long.as_str()] {
        let got = fx.run_as(rk_a(), |ctx| super::set_profile_name(ctx, bad.to_string()));
        assert_eq!(
            got,
            crate::guards::validate_name(bad).map(|_| ()),
            "invalid name {bad:?}"
        );
        assert!(got.is_err(), "{bad:?} must be refused");
    }
    assert_eq!(w.snapshot(), before, "refusals write nothing");
    assert_eq!(
        fx.run_as(rk_a(), |ctx| super::set_profile_name(
            ctx,
            "  Alicia ".to_string()
        )),
        Ok(())
    );
    assert_eq!(
        w.name(rk_a()),
        Some("Alicia".to_string()),
        "the validated (trimmed) name lands"
    );
    assert_eq!(
        w.name(rk_b()),
        Some("Bob".to_string()),
        "no other player is renamed"
    );
    assert_eq!(
        w.profile(rk_a()),
        Some(("Alice".to_string(), 1234, 5, 6)),
        "the profile row (rating, W/L, leaderboard name) is untouched"
    );
    assert_eq!(w.profile(rk_b()), Some(("Bob".to_string(), 999, 1, 2)));

    // Deletion-gated caller: refused before any write.
    drop(fx);
    let fx = rk_fixture();
    let w = rk_world(&fx);
    w.accounts.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(rk_a(), String::new(), 0),
        1,
    ));
    let before = w.snapshot();
    assert!(fx
        .run_as(rk_a(), |ctx| super::set_profile_name(
            ctx,
            "Evil".to_string()
        ))
        .is_err());
    assert_eq!(
        w.snapshot(),
        before,
        "a deletion-gated caller cannot un-tombstone a name"
    );
}

/// ST-pvp_tests#settle-rating (rt_m17_01 as behaviour): `apply_pvp_rating` maps the
/// winner from the outcome — SideAWins rates `player_identity` up, SideBWins rates
/// `opponent_identity` up — updating existing rows IN PLACE from their current ratings
/// (one compute for both) and refreshing the leaderboard name from the live player row;
/// Fled / Ongoing and a practice self-battle never touch the ladder.
/// kills: winner/loser swapped, wins/losses swapped, INITIAL used instead of the stored
/// rating, is_ranked_pvp guard removed, Fled rated.
#[test]
fn nh_apply_pvp_rating_maps_winner_from_outcome_and_updates_in_place() {
    let battle = |player: Identity, opponent: Identity, outcome: RkOutcome| {
        let mut b = RkBattle {
            battle_id: 1,
            player_identity: player,
            opponent_identity: opponent,
            state: game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![],
                },
                outcome: RkOutcome::Ongoing,
                turn_number: 3,
                weather: None,
            },
            party_monster_ids: vec![],
            opponent_monster_ids: vec![],
            created_at_ms: 0,
        };
        b.state.outcome = outcome;
        b
    };
    for (outcome, winner, loser) in [
        (RkOutcome::SideAWins, rk_a(), rk_b()),
        (RkOutcome::SideBWins, rk_b(), rk_a()),
    ] {
        let fx = rk_fixture();
        let w = rk_world(&fx);
        let start = |who: Identity| if who == rk_a() { 1200 } else { 800 };
        w.seed_profile(rk_a(), "stale-a", start(rk_a()), 3, 4);
        w.seed_profile(rk_b(), "stale-b", start(rk_b()), 1, 1);
        let record = |who: Identity| if who == rk_a() { (3u32, 4u32) } else { (1, 1) };
        super::apply_pvp_rating(&fx.ctx(), &battle(rk_a(), rk_b(), outcome));
        let (rw, rl) = game_core::compute_rating_update(start(winner), start(loser));
        let live = |who: Identity| (if who == rk_a() { "Alice" } else { "Bob" }).to_string();
        let (ww, wl) = record(winner);
        let (lw, ll) = record(loser);
        assert_eq!(
            w.profile(winner),
            Some((live(winner), rw, ww + 1, wl)),
            "{outcome:?}: winner"
        );
        assert_eq!(
            w.profile(loser),
            Some((live(loser), rl, lw, ll + 1)),
            "{outcome:?}: loser"
        );
        assert_eq!(
            w.profiles.rows().len(),
            2,
            "updated in place, nothing inserted or deleted"
        );
    }
    for (label, b) in [
        ("Fled", battle(rk_a(), rk_b(), RkOutcome::Fled)),
        ("Ongoing", battle(rk_a(), rk_b(), RkOutcome::Ongoing)),
        (
            "practice self-battle",
            battle(rk_a(), rk_a(), RkOutcome::SideAWins),
        ),
        (
            "wild battle",
            battle(rk_a(), crate::WILD_IDENTITY, RkOutcome::SideAWins),
        ),
    ] {
        let fx = rk_fixture();
        let w = rk_world(&fx);
        super::apply_pvp_rating(&fx.ctx(), &b);
        assert!(
            w.profiles.rows().is_empty(),
            "{label}: never rated (no profile created)"
        );
    }
    // First rated game for fresh identities: both rows inserted from INITIAL_RATING.
    let fx = rk_fixture();
    let w = rk_world(&fx);
    super::apply_pvp_rating(&fx.ctx(), &battle(rk_a(), rk_b(), RkOutcome::SideAWins));
    let (rw, rl) =
        game_core::compute_rating_update(game_core::INITIAL_RATING, game_core::INITIAL_RATING);
    assert_eq!(w.profile(rk_a()), Some(("Alice".to_string(), rw, 1, 0)));
    assert_eq!(w.profile(rk_b()), Some(("Bob".to_string(), rl, 0, 1)));
}

/// EV-ranking-security#rating-integrity (rekey) + AUTH-23/25: `rekey_profile` carries the
/// guest's rating/W/L onto the destination (creating it with the destination's live name
/// when absent, keeping an existing destination's name) and TOMBSTONES the guest row in
/// place — the un-typable claimed-guest name, zeroed stats — never deleting it; a guest
/// with no profile is a no-op.
/// kills: rekey_profile -> (), tombstone skipped, stats not carried, guest deleted.
#[test]
fn nh_rekey_profile_carries_stats_and_tombstones_the_guest() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    w.seed_profile(rk_a(), "Guest", 1300, 5, 2);
    let ctx = fx.ctx();
    super::rekey_profile(&ctx, rk_a(), rk_b());
    assert_eq!(
        w.profile(rk_b()),
        Some(("Bob".to_string(), 1300, 5, 2)),
        "stats carried, live name"
    );
    assert_eq!(
        w.profile(rk_a()),
        Some((super::PROFILE_TOMBSTONE_NAME.to_string(), 0, 0, 0)),
        "the guest row is tombstoned in place, not deleted"
    );
    assert!(
        crate::guards::validate_name(super::PROFILE_TOMBSTONE_NAME).is_err(),
        "un-typable"
    );

    drop(fx);
    let fx = rk_fixture();
    let w = rk_world(&fx);
    w.seed_profile(rk_a(), "Guest", 1300, 5, 2);
    w.seed_profile(rk_b(), "Kept", 700, 9, 9);
    super::rekey_profile(&fx.ctx(), rk_a(), rk_b());
    assert_eq!(
        w.profile(rk_b()),
        Some(("Bob".to_string(), 1300, 5, 2)),
        "existing dest overwritten with carried stats"
    );
    assert_eq!(w.profiles.rows().len(), 2);

    drop(fx);
    let fx = rk_fixture();
    let w = rk_world(&fx);
    super::rekey_profile(&fx.ctx(), rk_a(), rk_b());
    assert!(
        w.profiles.rows().is_empty(),
        "no guest profile: nothing created"
    );
}

/// PRV1-6 display-name anonymize as behaviour: `anonymize_display_names` renames the
/// owner's `player` AND `profile` rows to the deletion tombstone (keeping every other
/// field), leaves other players alone, and is a no-op for absent rows.
/// kills: either loop removed, the wrong owner renamed, stats clobbered.
#[test]
fn nh_anonymize_display_names_tombstones_only_the_owner() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    w.seed_profile(rk_a(), "Alice", 1111, 2, 3);
    w.seed_profile(rk_b(), "Bob", 999, 1, 1);
    super::anonymize_display_names(&fx.ctx(), rk_a());
    let t = game_core::TOMBSTONE_DISPLAY_NAME.to_string();
    assert_eq!(w.name(rk_a()), Some(t.clone()));
    assert_eq!(
        w.profile(rk_a()),
        Some((t, 1111, 2, 3)),
        "only the name changes"
    );
    assert_eq!(w.name(rk_b()), Some("Bob".to_string()));
    assert_eq!(w.profile(rk_b()), Some(("Bob".to_string(), 999, 1, 1)));
    let before = w.snapshot();
    super::anonymize_display_names(&fx.ctx(), Identity::from_byte_array([0x3F; 32]));
    assert_eq!(w.snapshot(), before, "absent rows: no-op");
}

/// A joined player (its `player` row carries discriminator 4207 and lead level 13, its
/// `player_handle` row holds 4207, a second player holds a handle too) renames through
/// `set_profile_name`: the name changes, `player.discriminator` and `lead_level` keep
/// their values, both handle rows are byte-identical and `player_handle` sees no write
/// (the table is registered writable, so a stray write is counted, not an abort).
///
/// kills: a rename that re-mints or re-reads the tag into the row; a rename that
/// rewrites the handle row; a rename that resets `discriminator` or `lead_level`.
#[test]
fn a_rename_leaves_the_handle_and_the_player_discriminator_unchanged_ih1_4() {
    use crate::schema::PlayerHandle;
    use spacetimedb::sats::bsatn::to_vec;
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let handles = fx
        .table::<PlayerHandle>("player_handle", "owner_identity", |r| r.owner_identity)
        .writable()
        .unique()
        .auto_inc(
            |r| u64::from(r.discriminator),
            |r, v| r.discriminator = u32::try_from(v).expect("a test sequence value fits a u32"),
        );
    let _ = fx
        .table_keyed::<PlayerHandle, u32>("player_handle", "discriminator", |r| r.discriminator)
        .unique();
    assert_eq!(w.players.remove(rk_a()), 1, "the seeded untagged row goes");
    w.players.seed(&RkPlayer {
        identity: rk_a(),
        entity_id: u64::from(rk_a().to_byte_array()[0]),
        name: "Alice".to_string(),
        online: true,
        discriminator: 4_207,
        lead_level: 13,
    });
    handles.seed(&PlayerHandle {
        owner_identity: rk_a(),
        discriminator: 4_207,
    });
    handles.seed(&PlayerHandle {
        owner_identity: rk_b(),
        discriminator: 9_000_001,
    });
    let handles_before = to_vec(&handles.rows()).expect("rows encode");
    fx.reset_writes();

    assert_eq!(
        fx.run_as(rk_a(), |ctx| super::set_profile_name(
            ctx,
            "Alicia".to_string()
        )),
        Ok(())
    );

    assert_eq!(
        w.name(rk_a()),
        Some("Alicia".to_string()),
        "the rename lands"
    );
    let tags: Vec<(u32, u8)> = w
        .players
        .rows()
        .into_iter()
        .filter(|p| p.identity == rk_a())
        .map(|p| (p.discriminator, p.lead_level))
        .collect();
    assert_eq!(
        tags,
        vec![(4_207, 13)],
        "the player row keeps its discriminator and lead level"
    );
    assert_eq!(
        to_vec(&handles.rows()).expect("rows encode"),
        handles_before,
        "every handle row is byte-identical"
    );
    assert_eq!(
        fx.writes_to("player_handle"),
        0,
        "a rename writes nothing to player_handle"
    );
}

/// `player_with_deleted_name` over a row with discriminator 4207 and lead level 13:
/// both come back 0, the name is the game-core deletion tombstone, and `identity`,
/// `entity_id` and `online` are unchanged.
///
/// kills: a tombstone that leaves the tag or the lead level on the surviving row (the
/// row stays linkable to a tag seen elsewhere); a zeroing that also clobbers the
/// presence column.
#[test]
fn the_deletion_tombstone_zeroes_the_discriminator_and_the_lead_level_ih1_7() {
    let before = RkPlayer {
        identity: Identity::from_byte_array([0x47; 32]),
        entity_id: 4_243,
        name: "Ash".to_string(),
        online: true,
        discriminator: 4_207,
        lead_level: 13,
    };
    let identity = before.identity;

    let after = super::player_with_deleted_name(before);

    assert_eq!(after.discriminator, 0, "the discriminator is zeroed");
    assert_eq!(after.lead_level, 0, "the lead level is zeroed");
    assert_eq!(
        after.name,
        game_core::TOMBSTONE_DISPLAY_NAME,
        "the name is the deletion tombstone"
    );
    assert_eq!(after.identity, identity, "the primary key survives");
    assert_eq!(after.entity_id, 4_243, "the entity id survives");
    assert!(after.online, "the presence flag survives");
}

// ===========================================================================
// sr-4b — the leaderboard membership (`leaderboard_top`).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-scale-readiness.spec.md §sr-4b (sr-4b.1, sr-4b.2)
// and §Decisions `leaderboard-shape=membership-table-plus-join`: after every transaction that
// writes `profile`, `leaderboard_top` holds exactly the identities of the top 100 profiles by
// rating desc, name asc (UTF-16 code units, the client's order), identity asc. The oracle is
// `native_host_tests::ladder_oracle`, an independent sort; `top_identities` never checks itself.
// A board that changes no member is written nothing (an unchanged write still reaches every
// join subscriber), so the write counts below are part of the contract.
// ===========================================================================

use crate::native_host_tests::{ladder_oracle, sorted_hexes};
use crate::schema::LeaderboardTop;

/// The spec's board size (`decision-defaulted:leaderboard-top-k=100`), as a literal.
const SR4B_K: usize = 100;

/// The `n`th filler identity `[b; 32]`: `b` counts up from 1, skipping the two players
/// (`rk_a`, `rk_b`), the absent owner `0x3F` and the module identity `0xDB`.
fn sr4b_filler(n: usize) -> Identity {
    let b = (1u8..=250)
        .filter(|b| ![0x3A, 0x3B, 0x3F, 0xDB].contains(b))
        .nth(n)
        .expect("a test asks for at most 245 fillers");
    Identity::from_byte_array([b; 32])
}

/// Seeds fillers `from..from + count`, rated `rating(i)`, named from a small pool (equal names
/// recur, an empty one included), with records that vary.
fn sr4b_seed_fillers(w: &RkWorld<'_>, from: usize, count: usize, rating: impl Fn(usize) -> i32) {
    const NAMES: [&str; 6] = ["Ivy", "Oak", "ivy", "Ash", "", "Oak2"];
    for i in from..from + count {
        w.seed_profile(
            sr4b_filler(i),
            NAMES[i % NAMES.len()],
            rating(i),
            (i % 7) as u32,
            (i % 5) as u32,
        );
    }
}

/// A ranked PvP battle, `rk_a` on side A against `rk_b` on side B, that ended with `outcome`.
fn sr4b_battle(outcome: RkOutcome) -> RkBattle {
    RkBattle {
        battle_id: 1,
        player_identity: rk_a(),
        opponent_identity: rk_b(),
        state: game_core::BattleState {
            side_a: game_core::BattleSide {
                active: 0,
                team: vec![],
            },
            side_b: game_core::BattleSide {
                active: 0,
                team: vec![],
            },
            outcome,
            turn_number: 3,
            weather: None,
        },
        party_monster_ids: vec![],
        opponent_monster_ids: vec![],
        created_at_ms: 0,
    }
}

fn sr4b_profile(identity: Identity, name: &str, rating: i32) -> Profile {
    Profile {
        identity,
        name: name.to_string(),
        rating,
        wins: 0,
        losses: 0,
    }
}

impl RkWorld<'_> {
    /// The board's members as sorted hex (a duplicate member shows twice).
    fn members(&self) -> Vec<String> {
        sorted_hexes(self.ladder.rows().into_iter().map(|r| r.identity))
    }

    /// The true top 100 over every profile row stored now, as sorted hex.
    fn true_top(&self) -> Vec<String> {
        sorted_hexes(ladder_oracle(&self.profiles.rows(), SR4B_K))
    }

    /// Every stored profile's identity, as sorted hex.
    fn every_profile(&self) -> Vec<String> {
        sorted_hexes(self.profiles.rows().into_iter().map(|p| p.identity))
    }

    fn is_member(&self, who: Identity) -> bool {
        self.ladder.rows().iter().any(|r| r.identity == who)
    }

    /// Seeds the board with the true top 100 of the profiles stored now: the invariant holds
    /// before the transaction under test.
    fn seed_true_board(&self) {
        for identity in ladder_oracle(&self.profiles.rows(), SR4B_K) {
            self.ladder.seed(&LeaderboardTop { identity });
        }
    }
}

/// A first rated game between two players with no profile inserts both profiles and makes both
/// members: the board is exactly the two of them, written by exactly two inserts.
///
/// kills: no rescan at the end of `apply_pvp_rating` (an empty board); a rescan that clears and
/// rewrites the board.
#[test]
fn a_first_rated_game_makes_both_players_members_sr4b_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    fx.reset_writes();
    super::apply_pvp_rating(&fx.ctx(), &sr4b_battle(RkOutcome::SideAWins));
    assert_eq!(
        w.every_profile(),
        sorted_hexes([rk_a(), rk_b()]),
        "precondition: the settle inserted both players' profiles"
    );
    assert_eq!(
        w.members(),
        sorted_hexes([rk_a(), rk_b()]),
        "both players are members after their first rated game"
    );
    assert_eq!(w.members(), w.true_top(), "the board is the true ladder");
    assert_eq!(
        fx.writes_to("leaderboard_top"),
        2,
        "the two members are inserted and nothing else is written"
    );
}

/// With fewer than 100 profiles every profile is a member, whatever its rating, name or record:
/// forty seeded rows (negative ratings, equal ratings, an empty name, both tombstone names)
/// plus the two players a settle rates for the first time.
///
/// kills: a rescan that adds only the two settled players; a board capped below the profile
/// count; a filter that drops tombstoned, empty-named or negative-rated rows.
#[test]
fn with_fewer_than_100_profiles_every_profile_is_a_member_sr4b_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let names = [
        "Ivy",
        "",
        "(claimed guest)",
        game_core::TOMBSTONE_DISPLAY_NAME,
        "ivy",
        "Oak",
    ];
    for i in 0..40usize {
        let rating = 1500 - 97 * (i % 23) as i32;
        w.seed_profile(
            sr4b_filler(i),
            names[i % names.len()],
            rating,
            (i % 7) as u32,
            (i % 5) as u32,
        );
    }
    assert!(
        w.profiles.rows().iter().any(|p| p.rating < 0),
        "fixture: a negative rating is seeded"
    );
    super::apply_pvp_rating(&fx.ctx(), &sr4b_battle(RkOutcome::SideBWins));
    assert_eq!(
        w.every_profile().len(),
        42,
        "precondition: forty seeded profiles plus the two players"
    );
    assert_eq!(w.members(), w.every_profile(), "every profile is a member");
    assert_eq!(w.members(), w.true_top(), "the board is the true ladder");
}

/// A settle that moves a member below the 100th swaps it out and the riser in. 99 profiles far
/// above; the two players tied at 1200, `rk_a` ("Alice") the 100th on the name and `rk_b`
/// ("Bob") the 101st; three far below. `rk_b` wins: it is now the 100th and `rk_a` the 101st.
///
/// kills: no rescan after the settle (the loser stays, the winner stays out); a rescan that
/// only inserts (the loser stays: 101 members); a rescan that rewrites every row (more than one
/// delete and one insert).
#[test]
fn a_settle_that_drops_a_member_below_the_100th_swaps_it_for_the_riser_sr4b_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    sr4b_seed_fillers(&w, 0, 99, |i| 2000 + (i as i32 * 7) % 50);
    w.seed_profile(rk_a(), "Alice", 1200, 4, 4);
    w.seed_profile(rk_b(), "Bob", 1200, 2, 6);
    sr4b_seed_fillers(&w, 99, 3, |i| 600 - i as i32);
    w.seed_true_board();
    assert!(
        w.is_member(rk_a()) && !w.is_member(rk_b()),
        "precondition: Alice is the 100th and Bob the 101st"
    );
    fx.reset_writes();
    super::apply_pvp_rating(&fx.ctx(), &sr4b_battle(RkOutcome::SideBWins));
    assert_eq!(
        w.members(),
        w.true_top(),
        "the board is the true ladder after the settle"
    );
    assert!(!w.is_member(rk_a()), "the loser fell below the 100th");
    assert!(w.is_member(rk_b()), "the winner rose into the top 100");
    assert_eq!(
        fx.writes_to("leaderboard_top"),
        2,
        "one delete (the loser) and one insert (the winner)"
    );
}

/// A settle whose loser falls below the 101st lets that non-participant in. 99 profiles far
/// above; `rk_b` ("Bob", 1210) the 100th; a non-participant at 1200 the 101st; `rk_a` ("Alice",
/// 500) below both, three more further down. `rk_a` wins: Bob drops below 1200, so the 101st
/// is now the 100th and Bob is out, while Alice stays below the cut before and after, so her
/// own rating write changes no membership.
///
/// kills: a rescan run before the loser's profile write in `apply_pvp_rating`, whether between
/// the winner's and the loser's write or before both (it sees Bob still at 1210, so the board
/// keeps Bob and leaves the 101st out); no rescan after the settle.
#[test]
fn a_loser_falling_below_the_100th_lets_the_101st_in_sr4b_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let riser = sr4b_filler(120);
    let (winner_rating, loser_rating, riser_rating) = (500, 1210, 1200);
    let (new_winner_rating, new_loser_rating) =
        game_core::compute_rating_update(winner_rating, loser_rating);
    assert!(
        new_loser_rating < riser_rating,
        "fixture: the loser's new rating {new_loser_rating} is below the 101st's {riser_rating}"
    );
    assert!(
        new_winner_rating < riser_rating,
        "fixture: the winner's new rating {new_winner_rating} is below the cut ({riser_rating}), \
         so the winner's own write changes no membership"
    );
    sr4b_seed_fillers(&w, 0, 99, |i| 2000 + (i as i32 * 7) % 50);
    w.seed_profile(rk_b(), "Bob", loser_rating, 6, 3);
    w.seed_profile(riser, "Kit", riser_rating, 4, 4);
    w.seed_profile(rk_a(), "Alice", winner_rating, 1, 9);
    sr4b_seed_fillers(&w, 99, 3, |i| 300 - i as i32);
    w.seed_true_board();
    assert!(
        w.is_member(rk_b()) && !w.is_member(riser) && !w.is_member(rk_a()),
        "precondition: Bob is the 100th, the non-participant the 101st, Alice below both"
    );
    fx.reset_writes();
    super::apply_pvp_rating(&fx.ctx(), &sr4b_battle(RkOutcome::SideAWins));
    let rating_of = |who| w.profile(who).map(|p| p.1);
    assert_eq!(
        (rating_of(rk_a()), rating_of(rk_b())),
        (Some(new_winner_rating), Some(new_loser_rating)),
        "precondition: the settle wrote both players' new ratings"
    );
    assert_eq!(
        w.members(),
        w.true_top(),
        "the board is the true ladder after the settle"
    );
    assert!(!w.is_member(rk_b()), "the loser fell below the 101st");
    assert!(w.is_member(riser), "the 101st rose into the top 100");
    assert!(!w.is_member(rk_a()), "the winner stays below the cut");
    assert_eq!(
        fx.writes_to("leaderboard_top"),
        2,
        "one delete (the loser) and one insert (the 101st)"
    );
}

/// A rating tie at the 100th, decided by name, re-ordered by an anonymize: "Mia" is the 100th
/// and "Zed" the 101st at 1200. Deleting an account that never ranked writes no profile row,
/// so it reads no profile and writes no member. Deleting Zed's account tombstones his name to
/// `TOMBSTONE_DISPLAY_NAME`, which sorts before "Mia": Zed is in and Mia is out.
///
/// kills: no rescan at the end of `anonymize_display_names` (Zed stays out); a rescan before
/// the name write; a rescan on every deletion, ranked or not (the never-ranked deletion reads
/// every profile); a rescan that rewrites every row.
#[test]
fn a_rating_tie_at_the_100th_is_broken_by_the_anonymized_name_sr4b_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let (mia, zed) = (sr4b_filler(120), sr4b_filler(121));
    sr4b_seed_fillers(&w, 0, 99, |i| 1500 + (i as i32 % 13) * 11);
    w.seed_profile(mia, "Mia", 1200, 3, 3);
    w.seed_profile(zed, "Zed", 1200, 8, 1);
    sr4b_seed_fillers(&w, 99, 4, |i| -40 - i as i32);
    w.seed_true_board();
    assert!(
        w.is_member(mia) && !w.is_member(zed),
        "precondition: Mia is the 100th and Zed the 101st on the name"
    );
    assert!(
        "Mia".cmp(game_core::TOMBSTONE_DISPLAY_NAME).is_gt(),
        "fixture: the deletion tombstone sorts before Mia"
    );

    let never_ranked = Identity::from_byte_array([0x3F; 32]);
    fx.reset_reads();
    fx.reset_writes();
    super::anonymize_display_names(&fx.ctx(), never_ranked);
    assert_eq!(
        fx.rows_read("profile"),
        0,
        "deleting an account that never ranked writes no profile row and scans no profile"
    );
    assert_eq!(fx.writes_to("leaderboard_top"), 0, "and writes no member");

    fx.reset_writes();
    super::anonymize_display_names(&fx.ctx(), zed);
    assert_eq!(
        w.profile(zed).map(|p| p.0),
        Some(game_core::TOMBSTONE_DISPLAY_NAME.to_string()),
        "precondition: Zed's profile name is tombstoned"
    );
    assert_eq!(
        w.members(),
        w.true_top(),
        "the board is the true ladder after the anonymize"
    );
    assert!(
        w.is_member(zed),
        "the tombstoned name moved Zed into the 100th"
    );
    assert!(!w.is_member(mia), "and Mia out to the 101st");
    assert_eq!(
        fx.writes_to("leaderboard_top"),
        2,
        "one delete (Mia) and one insert (Zed)"
    );
}

/// A full tie at the 100th (rating and name) is broken by the identity's value. Two rows at
/// 1200 differ in the low and the high byte in opposite directions, so their value order (the
/// big-endian hex) is the reverse of their raw byte-array order. "Bea" is the 100th; deleting
/// her account keeps her there (the tombstone sorts before "Cal" too), which writes no member;
/// deleting Cal's account ties the two, and the smaller value takes the 100th.
///
/// kills: identities compared by their little-endian byte array; no rescan after the anonymize;
/// a rescan that rewrites an unchanged board.
#[test]
fn a_full_tie_at_the_100th_is_broken_by_the_identity_value_sr4b_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let bytes = |low: u8, high: u8| {
        let mut b = [0x5C; 32];
        b[0] = low;
        b[31] = high;
        b
    };
    let (high_bytes, low_bytes) = (bytes(0x01, 0x02), bytes(0x02, 0x01));
    let (high, low) = (
        Identity::from_byte_array(high_bytes),
        Identity::from_byte_array(low_bytes),
    );
    assert!(
        low.to_hex().to_string() < high.to_hex().to_string(),
        "fixture: `low` is the smaller value"
    );
    assert!(
        high_bytes < low_bytes,
        "fixture: the raw byte arrays order the other way, so the case discriminates"
    );
    sr4b_seed_fillers(&w, 0, 99, |i| 1500 + (i as i32 % 13) * 11);
    w.seed_profile(high, "Bea", 1200, 1, 0);
    w.seed_profile(low, "Cal", 1200, 0, 1);
    sr4b_seed_fillers(&w, 99, 2, |i| 100 - i as i32);
    w.seed_true_board();
    assert!(
        w.is_member(high) && !w.is_member(low),
        "precondition: Bea is the 100th on the name"
    );

    fx.reset_writes();
    super::anonymize_display_names(&fx.ctx(), high);
    assert_eq!(w.members(), w.true_top(), "Bea's deletion: the true ladder");
    assert!(w.is_member(high), "Bea keeps the 100th");
    assert_eq!(
        fx.writes_to("leaderboard_top"),
        0,
        "an anonymize that changes no member writes nothing to the board"
    );

    super::anonymize_display_names(&fx.ctx(), low);
    assert_eq!(w.members(), w.true_top(), "Cal's deletion: the true ladder");
    assert!(
        w.is_member(low),
        "rating and name tie: the smaller identity value takes the 100th"
    );
    assert!(!w.is_member(high), "the larger value is the 101st");
}

/// A settle that leaves the membership as it was writes nothing to the board. The first settle
/// fills an empty board with the true top 100 (106 profiles); the two players then play again,
/// both far above the 100th, and the board is untouched: zero writes.
///
/// kills: a rescan that clears and re-inserts the board, or re-inserts every wanted member
/// (each a write every join subscriber hears about); no rescan (the first settle leaves the
/// board empty).
#[test]
fn a_settle_that_changes_no_membership_writes_nothing_to_the_board_sr4b_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    sr4b_seed_fillers(&w, 0, 99, |i| 1500 + (i as i32 % 17) * 9);
    w.seed_profile(rk_a(), "Alice", 3000, 30, 2);
    w.seed_profile(rk_b(), "Bob", 2990, 28, 4);
    sr4b_seed_fillers(&w, 99, 5, |i| 900 - 2 * i as i32);
    super::apply_pvp_rating(&fx.ctx(), &sr4b_battle(RkOutcome::SideAWins));
    assert_eq!(
        w.members(),
        w.true_top(),
        "the first settle fills the board with the true ladder"
    );
    assert_eq!(w.members().len(), SR4B_K, "a full board holds 100 members");

    let before = w.members();
    fx.reset_writes();
    super::apply_pvp_rating(&fx.ctx(), &sr4b_battle(RkOutcome::SideBWins));
    assert_eq!(
        w.members(),
        before,
        "both players stay far above the 100th: the membership is unchanged"
    );
    assert_eq!(w.members(), w.true_top(), "and still the true ladder");
    assert_eq!(
        fx.writes_to("leaderboard_top"),
        0,
        "an unchanged membership writes nothing to the board"
    );
}

/// `top_identities` returns at most `k` identities in ladder order (rating desc, name asc,
/// identity asc) for input lengths 0, 1, k and k + 1, for k = 0 and for k above the length,
/// whatever order the input arrives in. An empty name sorts before "Ann"; the two "Ann" rows at
/// one rating are ordered by identity.
///
/// kills: no truncation to `k`; a `len > k` guard written `>=` (len == k is cut short) or a
/// panic at k = 0 / an empty input; the rating sorted ascending; the name sorted descending or
/// ignored; the identity tie-break missing (input order leaks through).
#[test]
fn top_identities_lists_at_most_k_in_ladder_order_sr4b_1() {
    let id = |b: u8| Identity::from_byte_array([b; 32]);
    // `Profile` is not `Clone`: each fixture row is rebuilt per use.
    let bob = || sr4b_profile(id(2), "Bob", 1300);
    let empty = || sr4b_profile(id(5), "", 1200);
    let ann1 = || sr4b_profile(id(1), "Ann", 1200);
    let ann3 = || sr4b_profile(id(3), "Ann", 1200);
    let zoe = || sr4b_profile(id(4), "Zoe", -5);
    let all = || vec![zoe(), ann3(), bob(), empty(), ann1()];
    // The ladder: Bob; at 1200 the empty name, then "Ann" ([1; 32] before [3; 32]); Zoe.
    let ladder = vec![id(2), id(5), id(1), id(3), id(4)];
    let cases: Vec<(&str, Vec<Profile>, usize, Vec<Identity>)> = vec![
        ("no profiles", vec![], 3, vec![]),
        ("one profile", vec![zoe()], 3, vec![id(4)]),
        (
            "len == k",
            vec![ann1(), empty(), bob()],
            3,
            ladder[..3].to_vec(),
        ),
        (
            "len == k + 1: the last one is cut",
            vec![ann3(), ann1(), empty(), bob()],
            3,
            ladder[..3].to_vec(),
        ),
        ("k = 0", all(), 0, vec![]),
        ("len == k, all five", all(), 5, ladder.clone()),
        ("len == k + 1, all five", all(), 4, ladder[..4].to_vec()),
        ("k above the length", all(), 10, ladder),
    ];
    for (label, input, k, want) in cases {
        assert_eq!(super::top_identities(input, k), want, "{label}");
    }
}

/// Names compare by UTF-16 code units, the order the client's board sorts by: at one rating, a
/// name opening with the supplementary-plane letter U+1D400 (a surrogate pair from 0xD835)
/// ranks before one opening with U+FF21 (0xFF21), which UTF-8 byte order and code-point order
/// both put first. Both are names `validate_name` accepts.
///
/// kills: names compared as Rust strings (bytes) or by chars; identity order standing in for
/// the name order.
#[test]
fn top_identities_orders_names_by_utf16_code_units_sr4b_1() {
    let bold_a = char::from_u32(0x1D400).expect("U+1D400 is a scalar value");
    let wide_a = char::from_u32(0xFF21).expect("U+FF21 is a scalar value");
    let supplementary = format!("{bold_a}x");
    let fullwidth = format!("{wide_a}x");
    for name in [&supplementary, &fullwidth] {
        assert_eq!(
            crate::guards::validate_name(name),
            Ok(name.clone()),
            "fixture: {name:?} is a name a player can choose"
        );
    }
    assert!(
        fullwidth < supplementary,
        "fixture: Rust's string order puts the U+FF21 name first, so the case discriminates"
    );
    let id = |b: u8| Identity::from_byte_array([b; 32]);
    let input = vec![
        sr4b_profile(id(7), &fullwidth, 900),
        sr4b_profile(id(9), "zz", 900),
        sr4b_profile(id(8), &supplementary, 900),
    ];
    assert_eq!(
        super::top_identities(input, 3),
        vec![id(9), id(8), id(7)],
        "\"zz\" (0x007A), then the U+1D400 name (0xD835), then the U+FF21 name (0xFF21)"
    );
}

/// A full tie (rating and name) is broken by the identity's value, the big-endian hex order:
/// two identities whose low and high bytes differ in opposite directions (the raw byte arrays
/// order them the other way) and two that differ only in the high byte. k = 3 cuts the largest.
///
/// kills: identities compared by their little-endian byte array, or by a prefix of it.
#[test]
fn top_identities_breaks_a_full_tie_by_the_identity_value_sr4b_1() {
    let with = |low: u8, high: u8| {
        let mut b = [0x66; 32];
        b[0] = low;
        b[31] = high;
        b
    };
    let raw = [
        with(0x01, 0x02),
        with(0x02, 0x01),
        with(0x66, 0x09),
        with(0x66, 0x08),
    ];
    let ids: Vec<Identity> = raw.iter().map(|b| Identity::from_byte_array(*b)).collect();
    let mut want = ids.clone();
    want.sort_by_key(|id| id.to_hex().to_string());
    let mut by_bytes = raw;
    by_bytes.sort();
    let byte_order: Vec<Identity> = by_bytes
        .iter()
        .map(|b| Identity::from_byte_array(*b))
        .collect();
    assert_ne!(
        byte_order, want,
        "fixture: the raw byte-array order differs from the value order"
    );
    // `Profile` is not `Clone`: the input is rebuilt per call.
    let input = || -> Vec<Profile> {
        ids.iter()
            .map(|&identity| sr4b_profile(identity, "Twin", 500))
            .collect()
    };
    assert_eq!(
        super::top_identities(input(), 4),
        want,
        "the four tied rows in value order"
    );
    assert_eq!(
        super::top_identities(input(), 3),
        want[..3].to_vec(),
        "k = 3 cuts the largest value"
    );
}

/// A guest claim re-keys a member over a full board: the guest (1800) is a member, the claimer
/// has no profile, and 100 other profiles are rated above zero. After `rekey_profile` the
/// claimer, carrying the guest's 1800, is a member; the guest's tombstone (rating 0) ranks below
/// all 100 others and is gone; the board is the true ladder, changed by one delete and one
/// insert.
///
/// kills: no rescan at the end of `rekey_profile` (the guest stays, the claimer stays out); a
/// rescan run before the tombstone write (the guest's 1800 keeps it in); a rescan that rewrites
/// every row.
#[test]
fn a_claim_over_a_full_board_swaps_the_guest_for_the_claimer_sr4b_2() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let (guest, claimer) = (rk_a(), rk_b());
    sr4b_seed_fillers(&w, 0, 100, |i| 1 + (i as i32 * 37) % 1500);
    w.seed_profile(guest, "Guest", 1800, 12, 3);
    w.seed_true_board();
    assert!(
        w.is_member(guest) && !w.is_member(claimer),
        "precondition: the guest is a member, the claimer has no profile"
    );
    fx.reset_writes();
    super::rekey_profile(&fx.ctx(), guest, claimer);
    assert_eq!(
        w.profile(claimer).map(|p| p.1),
        Some(1800),
        "precondition: the claimer carries the guest's rating"
    );
    assert_eq!(
        w.profile(guest).map(|p| p.1),
        Some(0),
        "precondition: the guest's row is tombstoned at 0"
    );
    assert_eq!(
        w.members(),
        w.true_top(),
        "the board is the true ladder after the claim"
    );
    assert!(w.is_member(claimer), "the claimer's row is a member");
    assert!(
        !w.is_member(guest),
        "the retired guest's tombstone ranks below the 100 others and is gone"
    );
    assert_eq!(
        fx.writes_to("leaderboard_top"),
        2,
        "one delete (the guest) and one insert (the claimer)"
    );
}

/// The same claim in a world of fewer than 100 profiles: every profile is a member (sr-4b.1),
/// so the guest's zero-rated tombstone stays one beside the claimer.
///
/// kills: no rescan at the end of `rekey_profile` (the claimer stays out); a rescan that drops
/// tombstoned or zero-rated rows.
#[test]
fn a_claim_in_a_small_world_keeps_the_guest_tombstone_a_member_sr4b_2() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let (guest, claimer) = (rk_a(), rk_b());
    sr4b_seed_fillers(&w, 0, 10, |i| 900 + (i as i32 % 4) * 25);
    w.seed_profile(guest, "Guest", 1300, 5, 2);
    w.seed_true_board();
    super::rekey_profile(&fx.ctx(), guest, claimer);
    assert_eq!(
        w.every_profile().len(),
        12,
        "precondition: ten others, the guest's tombstone and the claimer"
    );
    assert_eq!(w.members(), w.every_profile(), "every profile is a member");
    assert!(w.is_member(claimer), "the claimer is a member");
    assert!(
        w.is_member(guest),
        "the zero-rated tombstone still ranks in a world of fewer than 100"
    );
}

// ===========================================================================
// A character's `profile` row moved whole to another identity (`move_profile`).
// ===========================================================================

/// The moved profile's name: neither seeded player row's name ("Alice", "Bob"), so a name
/// read from a live `player` row shows.
const LPW42_NAME: &str = "Wanderer";

/// `from`'s profile as seeded: the moved row's name, rating, wins and losses.
fn lpw42_profile(from: Identity) -> Profile {
    Profile {
        identity: from,
        name: LPW42_NAME.to_string(),
        rating: 1450,
        wins: 8,
        losses: 3,
    }
}

/// Rows as sorted BSATN encodings: a table compared as a set of byte-equal rows.
fn lpw42_enc(rows: Vec<Profile>) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = rows
        .iter()
        .map(|r| spacetimedb::sats::bsatn::to_vec(r).expect("a row always BSATN-encodes"))
        .collect();
    out.sort();
    out
}

impl RkWorld<'_> {
    /// Every profile row except `who`'s, encoded.
    fn lpw42_others(&self, who: Identity) -> Vec<Vec<u8>> {
        lpw42_enc(
            self.profiles
                .rows()
                .into_iter()
                .filter(|p| p.identity != who)
                .collect(),
        )
    }

    /// `who`'s profile rows, encoded.
    fn lpw42_own(&self, who: Identity) -> Vec<Vec<u8>> {
        lpw42_enc(
            self.profiles
                .rows()
                .into_iter()
                .filter(|p| p.identity == who)
                .collect(),
        )
    }
}

/// `move_profile` puts `from`'s name, rating, wins and losses on exactly one row at `to`,
/// leaves `from` no row, and every other profile row byte-equal.
///
/// kills: `move_profile` a no-op; the name read from `to`'s live `player` row or reset; the
/// stats zeroed or reset to the initial rating; the source tombstoned in place instead of
/// deleted; another row rewritten.
#[test]
fn move_profile_carries_the_whole_row_to_the_destination_lpw42_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let (from, to) = (rk_a(), rk_b());
    sr4b_seed_fillers(&w, 0, 5, |i| 900 + i as i32 * 10);
    w.profiles.seed(&lpw42_profile(from));
    assert!(
        w.name(from).as_deref() != Some(LPW42_NAME) && w.name(to).as_deref() != Some(LPW42_NAME),
        "fixture: the profile's name is neither player row's name"
    );
    let others_before = w.lpw42_others(from);

    super::move_profile(&fx.ctx(), from, to);

    assert_eq!(
        w.lpw42_own(to),
        lpw42_enc(vec![Profile {
            identity: to,
            ..lpw42_profile(from)
        }]),
        "one row at the destination: the source's name, rating, wins and losses"
    );
    assert!(
        w.lpw42_own(from).is_empty(),
        "the source holds no profile row"
    );
    assert_eq!(
        w.lpw42_others(to),
        others_before,
        "every other profile row byte-equal"
    );
}

/// With `from` a member of a full board and `to` holding no profile, the move makes `to` a
/// member and `from` not, the board is the true ladder over the stored profiles, and the
/// one rescan changes it by one delete and one insert.
///
/// kills: no rescan after the move (the source stays, the destination stays out); a rescan
/// before the insert (the 101st filler enters, then leaves); a rescan that rewrites every row.
#[test]
fn move_profile_moves_the_leaderboard_membership_lpw42_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let (from, to) = (rk_a(), rk_b());
    sr4b_seed_fillers(&w, 0, 100, |i| 1 + (i as i32 * 37) % 1500);
    w.seed_profile(from, LPW42_NAME, 1800, 12, 3);
    w.seed_true_board();
    assert!(
        w.is_member(from) && !w.is_member(to),
        "precondition: the source is a member, the destination has no profile"
    );
    fx.reset_writes();

    super::move_profile(&fx.ctx(), from, to);

    assert!(w.is_member(to), "the destination is a member");
    assert!(!w.is_member(from), "the source is not");
    assert_eq!(
        w.members(),
        w.true_top(),
        "the board is the true ladder after the move"
    );
    assert_eq!(
        fx.writes_to("leaderboard_top"),
        2,
        "one delete (the source) and one insert (the destination)"
    );
}

/// A source with no profile: no write to `profile` or `leaderboard_top`, every row as it
/// was. The control moves a seeded source in the same fixture, so the silence is the empty
/// source's.
///
/// kills: an insert of an initial-rating row for an empty source; a rescan run regardless.
#[test]
fn move_profile_of_a_source_with_no_profile_writes_nothing_lpw42_1() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let (from, to) = (rk_a(), rk_b());
    sr4b_seed_fillers(&w, 0, 10, |i| 900 + (i as i32 % 4) * 25);
    w.seed_true_board();
    let profiles_before = w.lpw42_others(from);
    let members_before = w.members();
    fx.reset_writes();

    super::move_profile(&fx.ctx(), from, to);

    assert_eq!(fx.writes_to("profile"), 0, "profile took a write call");
    assert_eq!(
        fx.writes_to("leaderboard_top"),
        0,
        "leaderboard_top took a write call"
    );
    assert_eq!(
        w.lpw42_others(from),
        profiles_before,
        "profile rows as they were"
    );
    assert!(w.lpw42_own(from).is_empty() && w.lpw42_own(to).is_empty());
    assert_eq!(w.members(), members_before, "the board as it was");

    w.profiles.seed(&lpw42_profile(from));
    super::move_profile(&fx.ctx(), from, to);
    assert_eq!(
        w.profile(to),
        Some((LPW42_NAME.to_string(), 1450, 8, 3)),
        "control: a source that holds a profile is moved"
    );
}

/// Moved there and back: after `from` -> `to` the row is at `to`; after `to` -> `from`
/// `from`'s row is byte-equal to the seed and `to` holds none.
///
/// kills: `move_profile` a no-op; a move that keeps the destination's identity on the way
/// back; a field lost on either leg.
#[test]
fn move_profile_there_and_back_restores_the_source_row_lpw42_2() {
    let fx = rk_fixture();
    let w = rk_world(&fx);
    let (from, to) = (rk_a(), rk_b());
    sr4b_seed_fillers(&w, 0, 10, |i| 900 + (i as i32 % 4) * 25);
    w.profiles.seed(&lpw42_profile(from));
    w.seed_true_board();
    let seed = lpw42_enc(vec![lpw42_profile(from)]);

    super::move_profile(&fx.ctx(), from, to);
    assert!(
        w.lpw42_own(from).is_empty() && w.lpw42_own(to).len() == 1,
        "precondition: the first move put the row at the destination"
    );

    super::move_profile(&fx.ctx(), to, from);
    assert_eq!(
        w.lpw42_own(from),
        seed,
        "the source's row is the seed again"
    );
    assert!(w.lpw42_own(to).is_empty(), "the destination holds none");
}
