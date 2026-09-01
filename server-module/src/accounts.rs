//! `accounts` — server-module domain submodule (M21, ADR-0179).
//!
//! WRITE-ISOLATION (D0, WRITE-scoped not table-scoped): this module inserts /
//! updates / deletes rows ONLY in `account`, `guest_claim`,
//! `guest_claim_reaper_schedule`, `account_deletion_reaper_schedule` (rb-24,
//! ADR-0221: the deletion-grace schedule, armed on request and disarmed on
//! cancel). Every write to any pre-existing table goes
//! through a `pub(crate)` helper in that table's OWNING module — the
//! `rekey_*` family (monster_mgmt / inventory / npc / raising / economy /
//! ranking) plus `privacy::purge_export_bundles` (rb-22, ADR-0220: the
//! claim-time purge of the retired guest's export chunks). Bare reads of
//! `player` are permitted (no single owning module); the wallet is not read here
//! at all (currency-integrity ACCESSOR_BYPASS gates reads too, so
//! `economy::wallet_exists` delegates); battle liveness reuses
//! `guards::is_in_ongoing_battle` rather than touching `ctx.db.battle()`.
//!
//! BOTH scheduled reaper table + reducer pairs (`guest_claim_reaper`,
//! `account_deletion_reaper`) are colocated HERE (not schema.rs / lib.rs) so
//! each `scheduled(..)` attribute resolves as a bare ident — the ADR-0056
//! exception, mirroring movement.rs / pvp.rs / playtest.rs.
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
/// contiguous slash-slash token; it compiles to `https:` + `//auth.monster-realm.invalid/`.
/// Exactly two gates RED on a bare literal (ADR-0181; re-measured 2026-08-15 @ 7eb6980):
/// `trade-escrow-guards.eval.mjs`, which strips slash-slash line-comments BEFORE string
/// literals, so a bare literal unbalances quote-pairing and blanks later files from its
/// whole-crate blob (TR-11); and `account-e2e.eval.mjs`, whose `ISSUER_NEEDLE` pins this
/// exact token (N4 throw). `13r-c-2` owns the first. Other scanners are still unmigrated
/// and can go silently BLIND instead — `evals/scanner-migration-audit.eval.mjs` is the SSOT.
///
/// HARD SEQUENCING GATE (ADR-0182 D18): flipping ALLOWED_ISSUERS and ALLOWED_AUDIENCE to their
/// real deployment values, tightening `audience_allowed` to exact single-value equality, and the
/// live restore drill are ALL gated on `13r-c-2` landing and are explicitly OUT of the M21b-2
/// slice. Keep the placeholder values, the `concat!()` construction, and `audience_allowed`
/// unchanged here until that gate clears.
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

/// PRV1-4 distinct terminal reject reason (M22 spec para 4.5, late cancel).
/// Deliberately NOT named `REJECT_ACCOUNT_DELETED` — the spec reserves that
/// name for the operator-blocked PRV1-8(a) alternate (issue #403, ADR-0225).
const REJECT_ALREADY_DELETED: &str = "this account has already been permanently deleted";

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

/// The instant the deletion reaper fires for a request stamped at
/// `requested_at_ms` — the exact boundary at which `game_core::is_deletion_due`
/// flips true (rb-24, ADR-0221; the grace constant has ONE SSOT in game-core,
/// spec para 4.3). Saturating, mirroring `claim_expires_at`. KNOWN BOUND: at a
/// stamp above `i64::MAX - GRACE` the clamped fire instant is NOT yet due by
/// `is_deletion_due` (the sub-then-compare and add-then-compare formulations
/// diverge only there); unreachable for wall-clock stamps, pinned by its own
/// test, recorded in ADR-0221 Known limits.
pub(crate) fn deletion_fire_at_ms(requested_at_ms: i64) -> i64 {
    requested_at_ms.saturating_add(game_core::DELETION_GRACE_MS_DEFAULT)
}

/// The `Account` legal-state invariant (ADR-0195 D3) — ONE pure predicate,
/// `debug_assert!`ed at the return of every Account-returning constructor
/// below. True iff ALL of:
///   - `Active` implies `deletion_requested_at_ms.is_none()`;
///   - `PendingDeletion` implies `deletion_requested_at_ms.is_some()`;
///   - `terminal_at_ms.is_some()` implies `PendingDeletion` AND
///     `deletion_requested_at_ms.is_some()` (M22-S2, spec §4.1: the terminal
///     marker is stamped only by a completed deletion cascade, so a marker on
///     an `Active` row — or with no request behind it — is a resurrected
///     tombstone and must be unrepresentable);
///   - `claimed_from.is_some() == claimed_at_ms.is_some()` (claim provenance
///     is a PAIR — set together or not at all).
///
/// The `match` on `status` is deliberately exhaustive with NO wildcard arm:
/// when M22 extends `delete_account` and adds a variant, this fn fails to
/// compile until the new state's timestamp rules are derived here. The
/// struct-shape tripwire in `accounts_tests.rs` pins `Account`'s field list
/// for the same reason — a shape change forces a conscious re-derivation of
/// this predicate rather than a silent widening of the state space; the
/// M22-S2 shape move (`terminal_at_ms`) discharged that contract by adding
/// the terminal clause here in the same change.
pub(crate) fn account_state_is_legal(account: &Account) -> bool {
    let status_stamp_paired = match account.status {
        AccountStatus::Active => account.deletion_requested_at_ms.is_none(),
        AccountStatus::PendingDeletion => account.deletion_requested_at_ms.is_some(),
    };
    let terminal_implies_completed_deletion = match account.terminal_at_ms {
        None => true,
        Some(_) => {
            account.status == AccountStatus::PendingDeletion
                && account.deletion_requested_at_ms.is_some()
        }
    };
    status_stamp_paired
        && terminal_implies_completed_deletion
        && (account.claimed_from.is_some() == account.claimed_at_ms.is_some())
}

/// A fresh `Active` account row (AUTH-4). `created_at_ms == last_login_at_ms`.
pub(crate) fn new_account_row(identity: Identity, auth_issuer: String, now_ms: i64) -> Account {
    let out = Account {
        identity,
        auth_issuer,
        created_at_ms: now_ms,
        last_login_at_ms: now_ms,
        status: AccountStatus::Active,
        deletion_requested_at_ms: None,
        claimed_from: None,
        claimed_at_ms: None,
        terminal_at_ms: None,
    };
    debug_assert!(
        account_state_is_legal(&out),
        "new_account_row: illegal Account state (ADR-0195 D3)"
    );
    out
}

/// Stamp ONLY `last_login_at_ms` on an existing account (AUTH-5).
pub(crate) fn touch_login(existing: Account, now_ms: i64) -> Account {
    let out = Account {
        last_login_at_ms: now_ms,
        ..existing
    };
    debug_assert!(
        account_state_is_legal(&out),
        "touch_login: illegal Account state (ADR-0195 D3)"
    );
    out
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
    let out = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(now_ms),
        ..existing
    };
    debug_assert!(
        account_state_is_legal(&out),
        "requested_deletion: illegal Account state (ADR-0195 D3)"
    );
    out
}

/// Reverse a pending deletion (AUTH-29). `claimed_from`/`claimed_at_ms` survive —
/// a cancel must never resurrect a spent claim.
pub(crate) fn cancelled_deletion(existing: Account) -> Account {
    let out = Account {
        status: AccountStatus::Active,
        deletion_requested_at_ms: None,
        ..existing
    };
    debug_assert!(
        account_state_is_legal(&out),
        "cancelled_deletion: illegal Account state (ADR-0195 D3)"
    );
    out
}

/// Stamp claim provenance on the destination account (AUTH-21). Set once.
pub(crate) fn claimed_account(existing: Account, guest: Identity, now_ms: i64) -> Account {
    let out = Account {
        claimed_from: Some(guest),
        claimed_at_ms: Some(now_ms),
        ..existing
    };
    debug_assert!(
        account_state_is_legal(&out),
        "claimed_account: illegal Account state (ADR-0195 D3)"
    );
    out
}

/// True when the row carries the M22 terminal marker (`terminal_at_ms`).
///
/// DELIBERATELY THE MARKER HALF ALONE of spec para 4.1, whose defined
/// `terminal` is the conjunction `status == PendingDeletion &&
/// terminal_at_ms.is_some()` — hence the name `account_has_terminal_marker`,
/// not `account_is_terminal` (ADR-0225). On the ILLEGAL `Active` + marker
/// shape (a resurrected tombstone, forbidden by `account_state_is_legal` but
/// only debug_assert-guarded) the marker half still answers true, which is
/// the fail-closed direction at every call site: an already-erased account
/// must never be cancelled back to life, re-armed, or allowed new
/// commitments.
pub(crate) fn account_has_terminal_marker(account: &Account) -> bool {
    account.terminal_at_ms.is_some()
}

/// The M22 para-4.7 deletion gate — true when gameplay writes must be
/// refused: the account is mid-grace (`PendingDeletion`) OR already erased
/// (terminal marker present).
///
/// EXPLICIT DISJUNCTION on purpose: on legal states the marker implies
/// `PendingDeletion`, so the second arm looks redundant — it is the
/// fail-closed arm for the illegal `Active` + marker shape and must never be
/// simplified away. This is the SSOT `is_pending_deletion` delegates to and
/// the entry point the S5 gameplay-gate fan-out calls (via a `guards.rs`
/// wrapper that delegates, never re-derives — ADR-0225). A third disjunct
/// added here widens BOTH consumers: re-derive the delegation first.
pub(crate) fn should_reject_for_deletion(account: &Account) -> bool {
    account.status == AccountStatus::PendingDeletion || account_has_terminal_marker(account)
}

/// PRV1-5 — should the deletion-grace reaper run the cascade for this row at
/// `now_ms`?
///
/// Defined DIRECTLY (not composed over `should_reject_for_deletion`) so a
/// future widening of the gameplay gate can never silently widen what the
/// reaper erases: exactly `PendingDeletion`, no terminal marker yet, and the
/// request past its grace window. `is_deletion_due(None, _) == false` is
/// load-bearing — a cancel clears the stamp, so `None` IS the cancelled
/// state and must never read as due.
pub(crate) fn reaper_should_run_cascade(account: &Account, now_ms: i64) -> bool {
    account.status == AccountStatus::PendingDeletion
        && !account_has_terminal_marker(account)
        && game_core::is_deletion_due(account.deletion_requested_at_ms, now_ms)
}

// --- Context-bound predicates (SSOT) ------------------------------------------

/// The load-bearing "is this an account holder?" gate (D4′). Only a verified
/// allowed-issuer/audience token ever produces an `account` row, so this is
/// strictly more precise than `has_jwt()` (true for every connection).
pub(crate) fn is_account_holder(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db.account().identity().find(identity).is_some()
}

/// True iff `identity` holds an account the deletion gate refuses (false when
/// no row). D7 SSOT — reused by `complete_guest_claim` here and by M22
/// gameplay-gate call sites, never re-derived. Since m22-s3 this DELEGATES to
/// `should_reject_for_deletion`: on every legal state that is exactly the old
/// `status == PendingDeletion` test (the marker implies `PendingDeletion`),
/// and on the illegal `Active` + marker shape it is fail-closed where the old
/// spelling waved the row through (ADR-0225).
pub(crate) fn is_pending_deletion(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .account()
        .identity()
        .find(identity)
        .is_some_and(|a| should_reject_for_deletion(&a))
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
///
/// MANIFEST CROSS-REFERENCE (M22-S2, ADR-0207): the claim-flow re-key policy
/// (this manifest, transcribed as `REKEY_MANIFEST` in
/// `evals/guest-claim-integrity.eval.mjs`) is one axis; the DELETION policy
/// dimension (`deletion_policy` + `basis` + `exportable` per table, spec §3)
/// lives as `schema::DATA_LIFECYCLE_MANIFEST` beside the table declarations.
/// A gate test proves every REKEY key's table is also lifecycle-classified,
/// so the two manifests cannot drift apart on a rename.
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
        ctx.db
            .guest_claim_reaper_schedule()
            .scheduled_id()
            .delete(id);
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
            log_reject("client_connected", ctx.sender(), REJECT_UNRECOGNIZED_ISSUER);
        }
        return Ok(());
    }
    if !audience_allowed(claims.audience(), ALLOWED_AUDIENCE) {
        log_reject(
            "client_connected",
            ctx.sender(),
            REJECT_UNRECOGNIZED_AUDIENCE,
        );
        return Err(REJECT_UNRECOGNIZED_AUDIENCE.to_string());
    }
    let now = now_ms(ctx);
    match ctx.db.account().identity().find(ctx.sender()) {
        Some(existing) => {
            ctx.db
                .account()
                .identity()
                .update(touch_login(existing, now));
        }
        None => {
            ctx.db
                .account()
                .insert(new_account_row(ctx.sender(), issuer.to_string(), now));
        }
    }
    Ok(())
}

// --- Guest-claim reducers -----------------------------------------------------

/// Bind a CLIENT-minted claim code to the anonymous caller (AUTH-7..11). The
/// server performs zero randomness; the code is a caller-invented secret, the
/// identity comes from `ctx.sender()`.
#[spacetimedb::reducer]
pub fn start_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let me = ctx.sender();
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
    let me = ctx.sender();
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
        return reject(
            "complete_guest_claim",
            me,
            "close your other tab, then retry",
        );
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
    // rb-22 (ADR-0220): the guest identity retires at this claim, so its
    // pre-claim export_bundle chunks would orphan — the S3 cascade keys on a
    // live account's own identity and cannot reach them. Purge them here, in
    // the same transaction, via the owning module (G5/D0).
    crate::privacy::purge_export_bundles(ctx, guest);
    consume_claim_and_disarm(ctx, guest);
    ctx.db
        .account()
        .identity()
        .update(claimed_account(account, guest, now_ms(ctx)));
    Ok(())
}

// --- Deletion (M21 half — AUTH-28/29/37/38, D7; rb-24 arm/disarm, ADR-0221) ---

/// Arm the one-shot deletion-grace reaper for `account` (rb-24, PRV1-1). Fire
/// instant derives from the SAME `requested_at_ms` the caller stamped on the
/// row (never a second clock read), through the pure `deletion_fire_at_ms`
/// seam. Saturating ms to us, mirroring `arm_claim_reaper`.
fn arm_deletion_reaper(ctx: &ReducerContext, account: Identity, requested_at_ms: i64) {
    ctx.db
        .account_deletion_reaper_schedule()
        .insert(AccountDeletionReaperSchedule {
            scheduled_id: 0, // auto_inc
            scheduled_at: ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(
                deletion_fire_at_ms(requested_at_ms).saturating_mul(1_000),
            )),
            account_identity: account,
        });
}

/// Disarm the pending deletion-reaper schedule row(s) for `account` (rb-24,
/// PRV1-3; ADR-0126 D4 — collect-then-delete via the `account_identity` btree
/// index, then delete by PK; mirrors `disarm_claim_reaper`). Owner-GENERIC so
/// S3's cascade-era callers can reuse it verbatim.
fn disarm_deletion_reaper(ctx: &ReducerContext, account: Identity) {
    let ids: Vec<u64> = ctx
        .db
        .account_deletion_reaper_schedule()
        .account_identity()
        .filter(account)
        .map(|s| s.scheduled_id)
        .collect();
    for id in ids {
        ctx.db
            .account_deletion_reaper_schedule()
            .scheduled_id()
            .delete(id);
    }
}

/// Request account deletion — sets `PendingDeletion` and arms the deletion-grace
/// reaper LAST (rb-24/ADR-0221: spec para 4.2 places the schedule-insert after
/// the status write; the reducer is one transaction, so the two cannot
/// separate, and the arm-last order is what keeps the M21 pins byte-stable).
/// Idempotent (AUTH-28): the second call writes nothing and arms nothing.
#[spacetimedb::reducer]
pub fn delete_account(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender();
    // AUTH-37 — reject a caller with no JWT (symmetric with AUTH-7/12).
    if !ctx.sender_auth().has_jwt() {
        return reject("delete_account", me, "sign in required");
    }
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("delete_account", me, "no account");
    };
    // m22-s3 (ADR-0225): the terminal marker wins over status. On the illegal
    // Active + marker shape the AUTH-28 gate below would answer yes and
    // launder the row into a legal PendingDeletion + marker state, arming a
    // SECOND cascade over an already-erased account. `Ok` shape, not a
    // reject — PRV1-2 keeps its letter (a terminal row IS status-Pending).
    if account_has_terminal_marker(&account) {
        return Ok(());
    }
    // AUTH-28 — the second call writes nothing (never re-stamps the timestamp).
    if !needs_deletion_write(account.status) {
        return Ok(());
    }
    // ONE clock read shared by the row stamp and the reaper fire time — a
    // second `now_ms(ctx)` here would silently decouple the two instants.
    let now = now_ms(ctx);
    ctx.db
        .account()
        .identity()
        .update(requested_deletion(account, now));
    arm_deletion_reaper(ctx, me, now);
    Ok(())
}

/// Reverse a pending deletion. Idempotent no-op on an already-`Active` account
/// (AUTH-38), so `PendingDeletion` is never a trap state within M21.
#[spacetimedb::reducer]
pub fn cancel_account_deletion(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender();
    if !ctx.sender_auth().has_jwt() {
        return reject("cancel_account_deletion", me, "sign in required");
    }
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("cancel_account_deletion", me, "no account");
    };
    // PRV1-4 (m22-s3, ADR-0225): a completed erasure is not reversible — a
    // late cancel gets a DISTINCT error, never a silent success. Guard-first
    // is fail-closed on the illegal Active + marker shape, where the AUTH-38
    // gate below would otherwise wave the row through to a silent Ok.
    if account_has_terminal_marker(&account) {
        return reject("cancel_account_deletion", me, REJECT_ALREADY_DELETED);
    }
    // AUTH-38 — no write when already Active.
    if !needs_cancel_write(account.status) {
        return Ok(());
    }
    ctx.db
        .account()
        .identity()
        .update(cancelled_deletion(account));
    // rb-24 (PRV1-3, ADR-0126 D4): actively disarm the pending reaper row —
    // inside the gate (an Active account owns no armed row by construction)
    // and after the status write, mirroring the arm-last rule on the request
    // side. The PRV1-4 terminal guard above (m22-s3) precedes the AUTH-38
    // gate, so no terminal row can ever reach this write path.
    disarm_deletion_reaper(ctx, me);
    Ok(())
}

// --- Scheduled TTL reaper (AUTH-27) -------------------------------------------

/// PRIVATE scheduled table colocated with its reducer (ADR-0056 exception).
/// `guest_identity` carries a btree index so the DISARM path filters instead of
/// scanning — mirrors `battle_challenge_reaper_schedule.challenge_id` (ADR-0126).
#[spacetimedb::table(accessor = guest_claim_reaper_schedule, scheduled(guest_claim_reaper))]
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
    if ctx.sender() != ctx.database_identity() {
        return Err("guest_claim_reaper is scheduler-only".to_string());
    }
    let Some(claim) = ctx
        .db
        .guest_claim()
        .guest_identity()
        .find(args.guest_identity)
    else {
        return Ok(()); // consumed before the TTL fired — no-op
    };
    if claim_is_expired(claim.expires_at_ms, now_ms(ctx)) {
        delete_claim(ctx, args.guest_identity);
    }
    Ok(())
}

// --- Scheduled deletion-grace reaper (rb-24, ADR-0221; cascade is S3's) -------

/// PRIVATE scheduled table colocated with its reducer (ADR-0056 exception),
/// mirroring `guest_claim_reaper_schedule` exactly. Minimal field set per
/// ADR-0126 D6 — deliberately NO timestamp column, so staleness can only ever
/// derive from the live `account` row's own `deletion_requested_at_ms` plus the
/// injected clock, never from anything a caller could supply.
/// `account_identity` carries a btree index so the PRV1-3 disarm path filters
/// instead of scanning.
#[spacetimedb::table(accessor = account_deletion_reaper_schedule, scheduled(account_deletion_reaper))]
pub struct AccountDeletionReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub account_identity: Identity,
}

/// Deletion-grace reaper — m22-s3 ships the PRV1-5 RECHECK SKELETON, still no
/// cascade (ADR-0225). Scheduler-only first statement, then a re-read of the
/// live `account` row keyed on the SCHEDULER-supplied identity, then the pure
/// `reaper_should_run_cascade` recheck (status is `PendingDeletion`, no
/// terminal marker yet, request past its grace window). The spec para-4.4
/// five-step cascade is S3b — blocked on G5 write isolation: accounts.rs may
/// write only its four owned tables, so every erase or anonymize step needs a
/// new helper in the owning module (the `rekey_all` delegation precedent).
///
/// TWO OBLIGATIONS S3B MUST DISCHARGE, recorded in ADR-0225: (1) the runtime
/// deletes the fired one-shot row regardless, so the not-yet-due early `Ok`
/// below drops the schedule with NO re-arm — S3b re-arms there; (2) ADR-0221
/// R2 population (accounts sitting `PendingDeletion` whose one-shot already
/// fired) needs a sweep. Exposure is nil while `ALLOWED_ISSUERS` is the
/// fail-closed `.invalid` placeholder. The reaper stamps NOTHING (PRV1-6e
/// forbids `terminal_at_ms` before the full cascade) and resolves NOTHING (a
/// half-cascade would forfeit live battles for zero deletion benefit).
/// Scheduler-only: the guard is the entire precondition of the ADR-0195 D6
/// struct-argument carve-out.
#[spacetimedb::reducer]
pub fn account_deletion_reaper(
    ctx: &ReducerContext,
    args: AccountDeletionReaperSchedule,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("account_deletion_reaper is scheduler-only".to_string());
    }
    let Some(account) = ctx.db.account().identity().find(args.account_identity) else {
        return Ok(());
    };
    if !reaper_should_run_cascade(&account, now_ms(ctx)) {
        return Ok(());
    }
    // S3b: the spec para-4.4 five-step cascade lands here (force-resolve live
    // interactions, erase, anonymize, join-sweep, then — only on full success
    // — stamp `terminal_at_ms`). S3b must ALSO re-arm on the not-yet-due
    // branch above.
    Ok(())
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod accounts_tests;
