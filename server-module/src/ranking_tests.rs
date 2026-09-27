//! `ranking` domain-submodule tests — m17a (ADR-0119) + m17.5d (ADR-0125) + the
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
    };
    for (who, name) in [(rk_a(), "Alice"), (rk_b(), "Bob")] {
        w.players.seed(&RkPlayer {
            identity: who,
            entity_id: u64::from(who.to_byte_array()[0]),
            name: name.to_string(),
            online: true,
            last_input_seq: 0,
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

/// EV-ranking-security#rating-integrity: `set_profile_name` refuses an unjoined or a
/// deletion-gated caller and an invalid name without writing; on success it writes ONLY
/// the caller's `player.name` (validated/normalised) — the caller's profile row (rating,
/// W/L, leaderboard name) and every other row stay byte-identical.
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

    // Deletion-gated caller (m22-s3b): refused before any write.
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
