//! `accounts` — server-module domain submodule (M21, ADR-0179).
//!
//! WRITE-ISOLATION (D0, WRITE-scoped not table-scoped): this module inserts /
//! updates / deletes rows ONLY in `account`, `guest_claim`,
//! `guest_claim_reaper_schedule`. Every write to any pre-existing table goes
//! through a `pub(crate) fn rekey_*` helper in that table's OWNING module
//! (monster_mgmt / inventory / npc / raising / economy / ranking). Bare reads of
//! `player` are permitted (no single owning module); the wallet is not read here
//! at all (currency-integrity ACCESSOR_BYPASS gates reads too, so
//! `economy::wallet_exists` delegates); battle liveness reuses
//! `guards::is_in_ongoing_battle` rather than touching `ctx.db.battle()`.
//!
//! The scheduled reaper table + reducer are colocated HERE (not schema.rs /
//! lib.rs) so the `scheduled(guest_claim_reaper)` attribute resolves as a bare
//! ident — the ADR-0056 exception, mirroring movement.rs / pvp.rs / playtest.rs.
//! (A `scheduled(crate::accounts::guest_claim_reaper)` path form compiles but the
//! `scheduled(`-name scanners would extract the literal `crate`.)
//!
//! `has_jwt()` is true for EVERY connection (the SpacetimeDB host mints its own
//! identity JWT even for a tokenless connect — probed live 2026-08-08), so the
//! load-bearing "is this an account holder?" predicate is `is_account_holder`
//! (an `account`-row lookup), never `has_jwt()`. See ADR-0179 D1″/D4′.
//!
//! This file name extends the canonical `touches:` vocabulary (ADR-0056) — keep it stable.

use crate::guards::{is_in_ongoing_battle, log_reject};
use crate::marshal::now_ms;
use crate::schema::{account, guest_claim, player, Account, AccountStatus, GuestClaim};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table, Timestamp};

// --- Deployment config (ADR-0179 D1; provider selection is spec OQ1) ----------

/// Which OIDC issuers may provision an `account`. Deployment config, not a game
/// rule — provider selection changes exactly these two constants + a republish.
/// The `.invalid` reserved TLD (RFC 2606) is a FAIL-CLOSED placeholder: until
/// OQ1 is answered no real token matches, so no `account` is ever provisioned,
/// while anonymous play is completely unaffected (D1″). INVARIANT: the host's
/// own anonymous issuer is NEVER placed here — it is not an account provider,
/// and that is what keeps the audience-disconnect branch outage-safe.
/// The URL is assembled from two literals so the SOURCE TEXT carries no
/// contiguous slash-slash token: several server-module source-scan evals strip
/// slash-slash line-comments BEFORE string literals, so a bare literal with the
/// scheme slashes would truncate there, unbalance their quote-pairing, and
/// cascade a spurious failure into unrelated files (trade-escrow-guards TR-11
/// went red this way). A real issuer URL configured at OQ1 trips the same latent
/// eval bug — M21c (which owns evals/) should make those strippers
/// string-literal-aware. Compiles to `https:` + `//auth.monster-realm.invalid/`.
pub(crate) const ALLOWED_ISSUERS: &[&str] = &[concat!("https:/", "/auth.monster-realm.invalid/")];
/// Which `aud` values scope a token to THIS application (D1).
pub(crate) const ALLOWED_AUDIENCE: &[&str] = &["monster-realm"];

/// Orphan-hygiene TTL only, NOT a security parameter — entropy is client-minted
/// and real (D3). 15 min covers a redirect + provider MFA / magic-link round trip.
pub(crate) const CLAIM_TTL_MS: i64 = 15 * 60 * 1000;
/// 32 bytes of `crypto.getRandomValues` rendered as lowercase hex.
pub(crate) const CLAIM_CODE_LEN: usize = 64;

/// Shared reject reason for AUTH-15 (malformed / never-existed) and AUTH-35
/// (already consumed) — ONE const so the two are indistinguishable to a caller
/// by construction (no code-existence oracle; ADR-0179 D3).
pub(crate) const ERR_INVALID_CODE: &str = "invalid or already-used code";
/// Static reject reasons on the connect path (AUTH-36 / G12 no-PII-in-logs);
/// named so M21c's G12 can value-pin them rather than scan for identifier names.
const REJECT_UNRECOGNIZED_ISSUER: &str = "unrecognized issuer";
const REJECT_UNRECOGNIZED_AUDIENCE: &str = "unrecognized audience";

/// Rate-limits the unrecognized-issuer reject log (D1″ makes it the modal path —
/// every non-account connection carries the host's own unrecognized-issuer
/// token). One line per minute keeps a real ALLOWED_ISSUERS misconfiguration
/// visible without flooding. Mirrors the movement.rs limiter statics.
static UNRECOGNIZED_ISSUER_LOG_LIMITER: crate::movement::RateLimiter =
    crate::movement::RateLimiter::new();
const UNRECOGNIZED_ISSUER_LOG_WINDOW_MS: i64 = 60_000;

// --- Pure decision seams (functional core — directly unit-testable) -----------

/// Exactly 64 lowercase hex characters. Byte-length + all-ASCII-hex ⇒ no
/// uppercase (do NOT use `is_ascii_hexdigit`), no non-ASCII, no whitespace,
/// no wrong length.
pub(crate) fn is_valid_claim_code(code: &str) -> bool {
    code.len() == CLAIM_CODE_LEN && code.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Exact-match issuer allowlist (no prefix/suffix/case tolerance).
pub(crate) fn issuer_allowed(issuer: &str, allowed: &[&str]) -> bool {
    allowed.contains(&issuer)
}

/// At least one `aud` entry is in the allowlist. An empty `aud` vec ⇒ reject
/// (AUTH-3) — the token was minted for no audience at all.
pub(crate) fn audience_allowed(audience: &[String], allowed: &[&str]) -> bool {
    audience.iter().any(|a| allowed.contains(&a.as_str()))
}

/// Expiry instant for a claim minted at `created_at_ms` (saturating).
pub(crate) fn claim_expires_at(created_at_ms: i64) -> i64 {
    created_at_ms.saturating_add(CLAIM_TTL_MS)
}

/// Boundary-INCLUSIVE expiry test (`now >= expires`), mirroring the repo's
/// cooldown-ready convention.
pub(crate) fn claim_is_expired(expires_at_ms: i64, now_ms: i64) -> bool {
    now_ms >= expires_at_ms
}

/// A fresh `Active` account row (AUTH-4). `created_at_ms == last_login_at_ms`.
pub(crate) fn new_account_row(identity: Identity, auth_issuer: String, now_ms: i64) -> Account {
    Account {
        identity,
        auth_issuer,
        created_at_ms: now_ms,
        last_login_at_ms: now_ms,
        status: AccountStatus::Active,
        deletion_requested_at_ms: None,
        claimed_from: None,
        claimed_at_ms: None,
    }
}

/// Stamp ONLY `last_login_at_ms` on an existing account (AUTH-5).
pub(crate) fn touch_login(existing: Account, now_ms: i64) -> Account {
    Account {
        last_login_at_ms: now_ms,
        ..existing
    }
}

/// A new in-flight claim row (AUTH-9). `guest_name` is the caller's own
/// `player.name`, never a reducer argument.
pub(crate) fn claim_row(
    guest_identity: Identity,
    code: String,
    guest_name: String,
    now_ms: i64,
) -> GuestClaim {
    GuestClaim {
        guest_identity,
        code,
        guest_name,
        created_at_ms: now_ms,
        expires_at_ms: claim_expires_at(now_ms),
    }
}

/// True when `delete_account` must write (AUTH-28: the second call, on an
/// already-`PendingDeletion` account, writes nothing).
pub(crate) fn needs_deletion_write(status: AccountStatus) -> bool {
    matches!(status, AccountStatus::Active)
}

/// True when `cancel_account_deletion` must write (AUTH-38: a cancel on an
/// already-`Active` account writes nothing).
pub(crate) fn needs_cancel_write(status: AccountStatus) -> bool {
    matches!(status, AccountStatus::PendingDeletion)
}

/// Transition to `PendingDeletion` (AUTH-28 half of D7).
pub(crate) fn requested_deletion(existing: Account, now_ms: i64) -> Account {
    Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(now_ms),
        ..existing
    }
}

/// Reverse a pending deletion (AUTH-29). `claimed_from`/`claimed_at_ms` survive —
/// a cancel must never resurrect a spent claim.
pub(crate) fn cancelled_deletion(existing: Account) -> Account {
    Account {
        status: AccountStatus::Active,
        deletion_requested_at_ms: None,
        ..existing
    }
}

/// Stamp claim provenance on the destination account (AUTH-21). Set once.
pub(crate) fn claimed_account(existing: Account, guest: Identity, now_ms: i64) -> Account {
    Account {
        claimed_from: Some(guest),
        claimed_at_ms: Some(now_ms),
        ..existing
    }
}

// --- Context-bound predicates (SSOT) ------------------------------------------

/// The load-bearing "is this an account holder?" gate (D4′). Only a verified
/// allowed-issuer/audience token ever produces an `account` row, so this is
/// strictly more precise than `has_jwt()` (true for every connection).
pub(crate) fn is_account_holder(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db.account().identity().find(identity).is_some()
}

/// True iff `identity` holds an account whose status is `PendingDeletion`
/// (false when no row). D7's SSOT — reused by `complete_guest_claim` here and by
/// M22's additional gameplay gate call sites, never re-derived.
pub(crate) fn is_pending_deletion(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .account()
        .identity()
        .find(identity)
        .is_some_and(|a| a.status == AccountStatus::PendingDeletion)
}

/// True if `identity` owns any row in any REKEY-policy table (D5 guard 3). The
/// `account` row itself never counts. Delegates every check to the owning
/// module (D0). Short-circuits most-discriminating-first (`join_game` grants a
/// monster unconditionally on first play).
pub(crate) fn account_has_game_data(ctx: &ReducerContext, identity: Identity) -> bool {
    crate::monster_mgmt::has_monsters(ctx, identity)
        || crate::inventory::has_items(ctx, identity)
        || crate::economy::wallet_exists(ctx, identity)
        || crate::ranking::profile_exists(ctx, identity)
        || crate::npc::has_quest_or_dialogue_state(ctx, identity)
        || crate::raising::has_heal_cooldown(ctx, identity)
}

/// Re-key every REKEY-policy table from `from` onto `to`, one delegated helper
/// per table in D6-manifest order. `?` on the fallible monster re-key rolls the
/// whole claim transaction back (fail-loud on a broken dual-write invariant).
pub(crate) fn rekey_all(ctx: &ReducerContext, from: Identity, to: Identity) -> Result<(), String> {
    crate::monster_mgmt::rekey_monsters(ctx, from, to)?;
    crate::inventory::rekey_inventory(ctx, from, to);
    crate::npc::rekey_npc_state(ctx, from, to);
    crate::raising::rekey_heal_cooldown(ctx, from, to);
    crate::economy::rekey_wallet(ctx, from, to);
    crate::ranking::rekey_profile(ctx, from, to);
    Ok(())
}

// --- Claim / reaper lifecycle helpers -----------------------------------------

/// Delete only the `guest_claim` row (used by the reaper — the runtime deletes
/// the fired one-shot schedule row itself, so the reaper must NOT disarm, C3).
fn delete_claim(ctx: &ReducerContext, guest: Identity) {
    ctx.db.guest_claim().guest_identity().delete(guest);
}

/// Disarm the reaper schedule row(s) for `guest` (collect-then-delete via the
/// `guest_identity` btree index, then delete by PK; mirrors ADR-0126).
fn disarm_claim_reaper(ctx: &ReducerContext, guest: Identity) {
    let ids: Vec<u64> = ctx
        .db
        .guest_claim_reaper_schedule()
        .guest_identity()
        .filter(guest)
        .map(|s| s.scheduled_id)
        .collect();
    for id in ids {
        ctx.db.guest_claim_reaper_schedule().scheduled_id().delete(id);
    }
}

/// Delete a claim AND disarm its reaper in the same transaction. Used by the
/// success path (AUTH-34 single-use) and the replace path (AUTH-10) — NEVER by
/// the reaper (C3).
pub(crate) fn consume_claim_and_disarm(ctx: &ReducerContext, guest: Identity) {
    delete_claim(ctx, guest);
    disarm_claim_reaper(ctx, guest);
}

/// Arm the one-shot TTL reaper. Fire time is derived from the row's OWN
/// `expires_at_ms` (one SSOT for expiry + schedule). Saturating ms→µs.
fn arm_claim_reaper(ctx: &ReducerContext, guest: Identity, expires_at_ms: i64) {
    ctx.db
        .guest_claim_reaper_schedule()
        .insert(GuestClaimReaperSchedule {
            scheduled_id: 0, // auto_inc
            scheduled_at: ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(
                expires_at_ms.saturating_mul(1_000),
            )),
            guest_identity: guest,
        });
}

/// Log a reject and return the `Err`. Reason is always a static literal.
fn reject(reducer: &str, sender: Identity, reason: &str) -> Result<(), String> {
    log_reject(reducer, sender, reason);
    Err(reason.to_string())
}

// --- Provisioning (AUTH-2..5, AUTH-36 / G3, G12) ------------------------------

/// Lazy-provision or touch an `account` for a JWT-bearing connection.
///
/// D1″ (asymmetric): an unrecognized *issuer* returns `Ok` with NO row (fail
/// SAFE to anonymous — this is the host's own token path, which must never
/// disconnect); an allowed issuer with an unrecognized *audience* returns `Err`
/// (disconnect) — a same-issuer cross-app confused-deputy token, never a
/// legitimate player. Both preserve AUTH-2/3's "SHALL NOT insert an `account`
/// row". Called only from `on_connect`.
pub(crate) fn provision_or_touch_account(ctx: &ReducerContext) -> Result<(), String> {
    let Some(claims) = ctx.sender_auth().jwt() else {
        return Ok(()); // belt (has_jwt() is true for every connection in practice)
    };
    let issuer = claims.issuer();
    if !issuer_allowed(issuer, ALLOWED_ISSUERS) {
        if UNRECOGNIZED_ISSUER_LOG_LIMITER
            .check(now_ms(ctx), UNRECOGNIZED_ISSUER_LOG_WINDOW_MS)
            .is_some()
        {
            log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_ISSUER);
        }
        return Ok(());
    }
    if !audience_allowed(claims.audience(), ALLOWED_AUDIENCE) {
        log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_AUDIENCE);
        return Err(REJECT_UNRECOGNIZED_AUDIENCE.to_string());
    }
    let now = now_ms(ctx);
    match ctx.db.account().identity().find(ctx.sender) {
        Some(existing) => {
            ctx.db.account().identity().update(touch_login(existing, now));
        }
        None => {
            ctx.db
                .account()
                .insert(new_account_row(ctx.sender, issuer.to_string(), now));
        }
    }
    Ok(())
}

// --- Guest-claim reducers -----------------------------------------------------

/// Bind a CLIENT-minted claim code to the anonymous caller (AUTH-7..11). The
/// server performs zero randomness; the code is a caller-invented secret, the
/// identity comes from `ctx.sender`.
#[spacetimedb::reducer]
pub fn start_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let me = ctx.sender;
    // AUTH-7 — an account holder cannot start a guest claim (D4′).
    if is_account_holder(ctx, me) {
        return reject("start_guest_claim", me, "already signed in");
    }
    // AUTH-8 — code must be exactly 64 lowercase hex chars.
    if !is_valid_claim_code(&code) {
        return reject("start_guest_claim", me, "invalid claim code");
    }
    // guest_name is snapshotted from player.name (AUTH-9); an identity with no
    // player row has nothing to claim (spec-gap decision — reject, matching the
    // repo's standard "not joined").
    let Some(player) = ctx.db.player().identity().find(me) else {
        return reject("start_guest_claim", me, "not joined");
    };
    // AUTH-10 — replace any prior in-flight claim BEFORE inserting (GuestClaim PK
    // is guest_identity → insert-before-delete would PK-collide). Idempotent.
    consume_claim_and_disarm(ctx, me);
    let now = now_ms(ctx);
    let row = claim_row(me, code, player.name, now);
    let expires_at_ms = row.expires_at_ms;
    ctx.db.guest_claim().insert(row);
    arm_claim_reaper(ctx, me, expires_at_ms);
    Ok(())
}

/// Complete a guest→account claim: re-key the guest's game data onto the caller,
/// consume the code (single-use), stamp provenance (AUTH-12..21, 26, 34, 35).
///
/// Guard ordering: all caller-state checks (1–4) run BEFORE any code resolution
/// (5+), so an unauthorized caller can never use this reducer as a claim-code
/// oracle. Every reject modifies nothing (AUTH-26) — including the expiry path
/// (a reducer `Err` cannot persist a delete; the reaper owns expired cleanup).
#[spacetimedb::reducer]
pub fn complete_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let me = ctx.sender;
    // Guard 1 (AUTH-12) — cheap JWT pre-filter (belt; guard 2 is load-bearing).
    if !ctx.sender_auth().has_jwt() {
        return reject("complete_guest_claim", me, "sign in required");
    }
    // Guard 2 (AUTH-12) — caller must hold an account row (D4′).
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("complete_guest_claim", me, "no account");
    };
    // Guard 3 (AUTH-13) — not pending deletion (reuses the D7 SSOT predicate).
    if is_pending_deletion(ctx, me) {
        return reject("complete_guest_claim", me, "account pending deletion");
    }
    // Guard 4 (AUTH-14) — one claim per account, ever.
    if account.claimed_from.is_some() {
        return reject("complete_guest_claim", me, "account already claimed");
    }
    // Guard 5 (AUTH-15a) — code well-formed.
    if !is_valid_claim_code(&code) {
        return reject("complete_guest_claim", me, ERR_INVALID_CODE);
    }
    // Guard 6 (AUTH-15b + AUTH-35) — code resolves to a live claim. A consumed
    // or never-existed code both land here, same reason (no oracle).
    let Some(claim) = ctx.db.guest_claim().code().find(&code) else {
        return reject("complete_guest_claim", me, ERR_INVALID_CODE);
    };
    let guest = claim.guest_identity;
    // Guard 7 (AUTH-16) — expiry. NO side effect: a reducer `Err` rolls back its
    // own writes, so cleanup here cannot persist; the reaper owns it.
    if claim_is_expired(claim.expires_at_ms, now_ms(ctx)) {
        return reject("complete_guest_claim", me, "code expired");
    }
    // Guard 8 (AUTH-17) — cannot claim your own session.
    if guest == me {
        return reject("complete_guest_claim", me, "cannot claim your own session");
    }
    // Guard 9 (AUTH-18) — guest's presence row must be gone (liveness oracle,
    // sound because on_disconnect deletes `player` strictly last, D5.1).
    if ctx.db.player().identity().find(guest).is_some() {
        return reject("complete_guest_claim", me, "close your other tab, then retry");
    }
    // Guard 10 (AUTH-19) — neither identity mid-battle (reuse the SSOT predicate;
    // `accounts.rs` never touches `ctx.db.battle()` itself, D0/G5).
    if is_in_ongoing_battle(ctx, guest) || is_in_ongoing_battle(ctx, me) {
        return reject("complete_guest_claim", me, "already in an ongoing battle");
    }
    // Guard 11 (AUTH-20) — destination owns no game data (fail closed, D5.3).
    if account_has_game_data(ctx, me) {
        return reject("complete_guest_claim", me, "already has game data");
    }
    // Re-key → consume (single-use, AUTH-34) → stamp provenance (AUTH-21). No
    // TOCTOU: reducers are fully serialized (ADR-0106 D8), atomicity is free.
    rekey_all(ctx, guest, me)?;
    consume_claim_and_disarm(ctx, guest);
    ctx.db
        .account()
        .identity()
        .update(claimed_account(account, guest, now_ms(ctx)));
    Ok(())
}

// --- Deletion (M21 half — AUTH-28/29/37/38, D7) -------------------------------

/// Request account deletion (M21 half only — sets `PendingDeletion`; M22 extends
/// this same body with the grace window + cascade). Idempotent (AUTH-28).
#[spacetimedb::reducer]
pub fn delete_account(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender;
    // AUTH-37 — reject a caller with no JWT (symmetric with AUTH-7/12).
    if !ctx.sender_auth().has_jwt() {
        return reject("delete_account", me, "sign in required");
    }
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("delete_account", me, "no account");
    };
    // AUTH-28 — the second call writes nothing (never re-stamps the timestamp).
    if !needs_deletion_write(account.status) {
        return Ok(());
    }
    ctx.db
        .account()
        .identity()
        .update(requested_deletion(account, now_ms(ctx)));
    Ok(())
}

/// Reverse a pending deletion. Idempotent no-op on an already-`Active` account
/// (AUTH-38), so `PendingDeletion` is never a trap state within M21.
#[spacetimedb::reducer]
pub fn cancel_account_deletion(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender;
    if !ctx.sender_auth().has_jwt() {
        return reject("cancel_account_deletion", me, "sign in required");
    }
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("cancel_account_deletion", me, "no account");
    };
    // AUTH-38 — no write when already Active.
    if !needs_cancel_write(account.status) {
        return Ok(());
    }
    ctx.db
        .account()
        .identity()
        .update(cancelled_deletion(account));
    Ok(())
}

// --- Scheduled TTL reaper (AUTH-27) -------------------------------------------

/// PRIVATE scheduled table colocated with its reducer (ADR-0056 exception).
/// `guest_identity` carries a btree index so the DISARM path filters instead of
/// scanning — mirrors `battle_challenge_reaper_schedule.challenge_id` (ADR-0126).
#[spacetimedb::table(name = guest_claim_reaper_schedule, scheduled(guest_claim_reaper))]
pub struct GuestClaimReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub guest_identity: Identity,
}

/// Reap a single expired `guest_claim` row (AUTH-27). Scheduler-only. Deletes
/// exactly the PK row named by `args` (a PK delete cannot touch another claim),
/// and only if still expired (staleness re-check: never reap a fresh replacement
/// claim after clock skew). Does NOT self-disarm — the runtime deletes the fired
/// one-shot schedule row itself (C3).
#[spacetimedb::reducer]
pub fn guest_claim_reaper(
    ctx: &ReducerContext,
    args: GuestClaimReaperSchedule,
) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("guest_claim_reaper is scheduler-only".to_string());
    }
    let Some(claim) = ctx.db.guest_claim().guest_identity().find(args.guest_identity) else {
        return Ok(()); // consumed before the TTL fired — no-op
    };
    if claim_is_expired(claim.expires_at_ms, now_ms(ctx)) {
        delete_claim(ctx, args.guest_identity);
    }
    Ok(())
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod accounts_tests;
