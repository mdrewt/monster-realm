//! `accounts` — server-module domain submodule.
//!
//! WRITE-ISOLATION: this module inserts / updates / deletes rows ONLY in
//! `account`, `guest_claim`, `guest_claim_reaper_schedule`,
//! `account_deletion_reaper_schedule`. Every write to any pre-existing table goes
//! through a `pub(crate)` helper in that table's OWNING module — the `rekey_*`
//! family (monster_mgmt / inventory / npc / raising / economy / ranking /
//! `schema::rekey_formation`), `privacy::purge_export_bundles`, and the
//! `erase_*` / `anonymize_*` cascade family the deletion reaper delegates to
//! (the tactical tables' `schema::erase_tactical_rows` included). The guest
//! claim delegates to two of that family, `schema::erase_tactical_rows` and
//! `battle::anonymize_battles`, for the guest identity it retires. Bare reads of
//! `player` are permitted (no single owning module); the wallet is not read
//! here at all; battle liveness
//! reuses `guards::is_in_ongoing_battle` rather than touching `ctx.db.battle()`.
//!
//! BOTH scheduled reaper table + reducer pairs (`guest_claim_reaper`,
//! `account_deletion_reaper`) are colocated HERE (not schema.rs / lib.rs) so
//! each `scheduled(..)` attribute resolves as a bare ident.
//! (A `scheduled(crate::accounts::guest_claim_reaper)` path form compiles but the
//! `scheduled(`-name scanners would extract the literal `crate`.)
//!
//! `has_jwt()` is true for EVERY connection (the SpacetimeDB host mints its own
//! identity JWT even for a tokenless connect), so the
//! load-bearing "is this an account holder?" predicate is `is_account_holder`
//! (an `account`-row lookup), never `has_jwt()`.

use crate::guards::{is_in_ongoing_battle, log_reject};
use crate::marshal::now_ms;
use crate::schema::{account, guest_claim, player, Account, AccountStatus, GuestClaim};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table, Timestamp};

// --- Deployment config ----------

/// The production login issuer, the only one an `official` build trusts. Deployment config,
/// not a game rule. The `.invalid` reserved TLD (RFC 2606) is a FAIL-CLOSED placeholder: no real
/// token matches it, so an `official` build provisions no `account` and admits nobody.
/// INVARIANT: the host's own anonymous issuer is NEVER placed in a login-issuer list — it is
/// not an account provider, and that is what keeps the audience-disconnect branch outage-safe.
///
/// HARD SEQUENCING GATE: replacing this placeholder and ALLOWED_AUDIENCE with their real
/// deployment values, tightening `audience_allowed` to exact single-value equality, and the
/// live restore drill are ALL gated on the real-deployment follow-up landing. Keep the
/// placeholder values and `audience_allowed` unchanged here until that gate clears.
pub(crate) const PRODUCTION_LOGIN_ISSUERS: &[&str] = &["https://auth.monster-realm.invalid/"];
/// The account service's `local-dev` issuer (`account-service/src/config.ts`).
/// `account-e2e.eval.mjs` patches this exact declaration line (its `ISSUER_NEEDLE`) to point
/// at a local stub issuer.
const LOCAL_DEV_ISSUER: &str = "http://localhost:4455";
/// The account service's `hosted-dev` issuer.
const HOSTED_DEV_ISSUER: &str = "https://auth.monster-realm.spookyowltech.com";
/// The dev login issuers. Their accounts are made by an admin command, so no release build
/// trusts them.
pub(crate) const DEV_LOGIN_ISSUERS: &[&str] = &[LOCAL_DEV_ISSUER, HOSTED_DEV_ISSUER];

/// The cargo features a build names: the build input for ownership.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BuildFeatures {
    pub(crate) official: bool,
    pub(crate) world: bool,
    pub(crate) dev_issuers: bool,
    pub(crate) open_join: bool,
    pub(crate) dev_reducers: bool,
    pub(crate) load_test_zones: bool,
}

/// What a build does about ownership. `name` is one of `official`, `world`, `conflict` (both
/// release features), `test`, `dev-enforcing` and `default` (no feature).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BuildProfile {
    pub(crate) name: &'static str,
    /// `join_game` refuses a caller who is not entitled.
    pub(crate) enforces_ownership: bool,
    /// The issuers whose tokens are accounts.
    pub(crate) login_issuers: &'static [&'static str],
    /// The build compiles a dev reducer.
    pub(crate) dev_reducers: bool,
}

/// The profile of a feature set (`docs/local-play.md` §3, "The build input"). A release
/// feature wins over a dev feature: a build that names `official` or `world` enforces and
/// trusts no dev issuer whatever else it names, and one that names both trusts nothing.
/// Otherwise a build enforces unless it names `open_join`, and trusts the dev issuers when it
/// names `dev_issuers`. Cargo's own implications (`load_test_zones` and `dev_reducers` name
/// `open_join`, which names `dev_issuers`) are applied here too, so a feature handed to the
/// compiler from outside cargo yields no other profile.
pub(crate) const fn build_profile(features: BuildFeatures) -> BuildProfile {
    let dev_reducers = features.dev_reducers || features.load_test_zones;
    let open_join = features.open_join || dev_reducers;
    let dev_issuers = features.dev_issuers || open_join;
    let (name, enforces_ownership, login_issuers): (&str, bool, &[&str]) =
        match (features.official, features.world) {
            (true, false) => ("official", true, PRODUCTION_LOGIN_ISSUERS),
            (false, true) => ("world", true, &[]),
            (true, true) => ("conflict", true, &[]),
            (false, false) if open_join => ("test", false, DEV_LOGIN_ISSUERS),
            (false, false) if dev_issuers => ("dev-enforcing", true, DEV_LOGIN_ISSUERS),
            (false, false) => ("default", true, &[]),
        };
    BuildProfile {
        name,
        enforces_ownership,
        login_issuers,
        dev_reducers,
    }
}

/// The features this build names. `cfg!` keeps every branch of `build_profile` compiled in
/// every build.
pub(crate) const BUILD_FEATURES: BuildFeatures = BuildFeatures {
    official: cfg!(feature = "official"),
    world: cfg!(feature = "world"),
    dev_issuers: cfg!(feature = "dev_issuers"),
    open_join: cfg!(feature = "open_join"),
    dev_reducers: cfg!(feature = "dev_reducers"),
    load_test_zones: cfg!(feature = "load_test_zones"),
};
/// This build's profile.
pub(crate) const BUILD_PROFILE: BuildProfile = build_profile(BUILD_FEATURES);
// A release build ships no dev reducer: the profile can switch enforcement on, but it cannot
// remove a reducer. Clippy's `--all-features` run names every feature at once.
const _: () = assert!(
    cfg!(clippy)
        || !((BUILD_FEATURES.official || BUILD_FEATURES.world) && BUILD_PROFILE.dev_reducers),
    "a release build (`official` or `world`) cannot name `dev_reducers` or `load_test_zones`"
);
/// Which OIDC issuers may provision an `account` in this build.
pub(crate) const ALLOWED_ISSUERS: &[&str] = BUILD_PROFILE.login_issuers;
/// Which `aud` values scope a token to THIS application (D1).
pub(crate) const ALLOWED_AUDIENCE: &[&str] = &["monster-realm"];
/// The entitlement every player needs: the claim `mr_ent` of a login token names it.
pub(crate) const ENTITLEMENT_BASE_GAME: &str = "base-game";

/// Orphan-hygiene TTL only, NOT a security parameter — entropy is client-minted
/// and real (D3). 15 min covers a redirect + provider MFA / magic-link round trip.
pub(crate) const CLAIM_TTL_MS: i64 = 15 * 60 * 1000;
/// 32 bytes of `crypto.getRandomValues` rendered as lowercase hex.
pub(crate) const CLAIM_CODE_LEN: usize = 64;

/// Shared reject reason for AUTH-15 (malformed / never-existed) and AUTH-35
/// (already consumed) — ONE const so the two are indistinguishable to a caller
/// by construction (no code-existence oracle).
pub(crate) const ERR_INVALID_CODE: &str = "invalid or already-used code";
/// Static reject reasons on the connect path (AUTH-36 / G12 no-PII-in-logs);
/// named so M21c's G12 can value-pin them rather than scan for identifier names.
/// The one refusal of a caller who is not entitled, whatever the reason: no token, an
/// unlisted issuer, another audience or no entitlement. The VALUE is a client contract.
pub(crate) const ERR_OWNERSHIP_REQUIRED: &str = "ownership required";
const REJECT_UNRECOGNIZED_ISSUER: &str = "unrecognized issuer";
const REJECT_UNRECOGNIZED_AUDIENCE: &str = "unrecognized audience";

/// Deliberately NOT named `REJECT_ACCOUNT_DELETED` — the spec reserves that
/// name for the operator-blocked PRV1-8(a) alternate.
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

/// Whether a token's JSON payload names `entitlement` in its `mr_ent` claim: the payload is
/// one JSON object, the key `mr_ent` occurs exactly once at its top level, and its value is an
/// array one of whose elements is the string `entitlement`.
///
/// Keys and elements are compared as the bytes between their quotes, so one written with an
/// escape never matches, and a backslash in any top-level key is refused outright: a reader
/// that decodes escapes would take the last of two spellings of one key. Anything else it
/// cannot follow (a second `mr_ent`, text that is not one well-formed object) is `false`.
pub(crate) fn token_names_entitlement(raw_payload: &str, entitlement: &str) -> bool {
    let b = raw_payload.as_bytes();
    let mut at = 0;
    skip_json_ws(b, &mut at);
    if b.get(at) != Some(&b'{') {
        return false;
    }
    at += 1;
    skip_json_ws(b, &mut at);
    // `None` until the key is met, then whether its array holds the entitlement.
    let mut named: Option<bool> = None;
    if b.get(at) == Some(&b'}') {
        at += 1;
    } else {
        loop {
            skip_json_ws(b, &mut at);
            let Some(key) = read_json_string(b, &mut at) else {
                return false;
            };
            if key.contains(&b'\\') || !skip_json_colon(b, &mut at) {
                return false;
            }
            if key == b"mr_ent" {
                if named.is_some() {
                    return false;
                }
                named = if b.get(at) == Some(&b'[') {
                    json_array_holds(b, &mut at, entitlement.as_bytes())
                } else {
                    skip_json_value(b, &mut at).then_some(false)
                };
                if named.is_none() {
                    return false;
                }
            } else if !skip_json_value(b, &mut at) {
                return false;
            }
            skip_json_ws(b, &mut at);
            match b.get(at) {
                Some(b',') => at += 1,
                Some(b'}') => {
                    at += 1;
                    break;
                }
                _ => return false,
            }
        }
    }
    skip_json_ws(b, &mut at);
    at == b.len() && named == Some(true)
}

fn skip_json_ws(b: &[u8], at: &mut usize) {
    while matches!(b.get(*at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        *at += 1;
    }
}

/// The bytes between the quotes of the string that opens at `*at`, escapes left as written.
/// `None` when no string opens there or it never closes.
fn read_json_string<'a>(b: &'a [u8], at: &mut usize) -> Option<&'a [u8]> {
    if b.get(*at) != Some(&b'"') {
        return None;
    }
    let start = *at + 1;
    let mut i = start;
    loop {
        match b.get(i)? {
            b'"' => {
                *at = i + 1;
                return Some(&b[start..i]);
            }
            b'\\' => i += 2,
            _ => i += 1,
        }
    }
}

/// Steps over the colon after a key and the whitespace on both sides of it.
fn skip_json_colon(b: &[u8], at: &mut usize) -> bool {
    skip_json_ws(b, at);
    if b.get(*at) != Some(&b':') {
        return false;
    }
    *at += 1;
    skip_json_ws(b, at);
    true
}

/// Steps over `true`, `false`, `null` or a number. A number is read as a run of the bytes a
/// number is made of; whatever follows a scalar must be a separator its caller accepts.
fn skip_json_scalar(b: &[u8], at: &mut usize) -> bool {
    let rest = &b[*at..];
    for word in [&b"true"[..], b"false", b"null"] {
        if rest.starts_with(word) {
            *at += word.len();
            return true;
        }
    }
    let digits = rest
        .iter()
        .take_while(|c| matches!(c, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
        .count();
    *at += digits;
    matches!(rest.first(), Some(b'0'..=b'9' | b'-'))
}

/// Steps over one JSON value of any depth, without recursion. `false` when it is malformed
/// or cut short.
fn skip_json_value(b: &[u8], at: &mut usize) -> bool {
    // The containers still open, innermost last: `{` or `[`.
    let mut open: Vec<u8> = Vec::new();
    loop {
        // A value starts here.
        skip_json_ws(b, at);
        let opener = b.get(*at).copied();
        match opener {
            Some(b'"') => {
                if read_json_string(b, at).is_none() {
                    return false;
                }
            }
            Some(b'{' | b'[') => {
                let closer = if opener == Some(b'{') { b'}' } else { b']' };
                *at += 1;
                skip_json_ws(b, at);
                if b.get(*at) == Some(&closer) {
                    *at += 1;
                } else {
                    open.push(closer);
                    if closer == b'}' && !skip_json_key(b, at) {
                        return false;
                    }
                    continue;
                }
            }
            _ => {
                if !skip_json_scalar(b, at) {
                    return false;
                }
            }
        }
        // A value has ended: close what it completes, or move to the next one.
        loop {
            let Some(&closer) = open.last() else {
                return true;
            };
            skip_json_ws(b, at);
            match b.get(*at) {
                Some(b',') => {
                    *at += 1;
                    if closer == b'}' && !skip_json_key(b, at) {
                        return false;
                    }
                    break;
                }
                Some(c) if *c == closer => {
                    *at += 1;
                    open.pop();
                }
                _ => return false,
            }
        }
    }
}

/// Steps over an object member's key and its colon.
fn skip_json_key(b: &[u8], at: &mut usize) -> bool {
    skip_json_ws(b, at);
    read_json_string(b, at).is_some() && skip_json_colon(b, at)
}

/// Reads the array that opens at `*at` and answers whether one of its elements is the string
/// `want`. Elements of any other type are stepped over, not searched. `None` when the array
/// is malformed.
fn json_array_holds(b: &[u8], at: &mut usize, want: &[u8]) -> Option<bool> {
    *at += 1;
    skip_json_ws(b, at);
    if b.get(*at) == Some(&b']') {
        *at += 1;
        return Some(false);
    }
    let mut found = false;
    loop {
        skip_json_ws(b, at);
        if b.get(*at) == Some(&b'"') {
            found |= read_json_string(b, at)? == want;
        } else if !skip_json_value(b, at) {
            return None;
        }
        skip_json_ws(b, at);
        match b.get(*at) {
            Some(b',') => *at += 1,
            Some(b']') => {
                *at += 1;
                return Some(found);
            }
            _ => return None,
        }
    }
}

const fn bool_text(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

/// Writes `text` into `out` from `at`, as far as it fits, and answers the position after it.
const fn put_text<const N: usize>(mut out: [u8; N], mut at: usize, text: &str) -> ([u8; N], usize) {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if at < N {
            out[at] = bytes[i];
        }
        at += 1;
        i += 1;
    }
    (out, at)
}

/// The text a build carries about itself in its artefact's `mr_build_profile` section, one
/// `key=value` line each: `profile`, `enforces_ownership`, `dev_reducers`, then a
/// `login_issuer` line per trusted issuer. Answers the first `N` bytes and the whole length.
const fn render_profile_section<const N: usize>(profile: &BuildProfile) -> ([u8; N], usize) {
    let (out, at) = put_text([0u8; N], 0, "profile=");
    let (out, at) = put_text(out, at, profile.name);
    let (out, at) = put_text(out, at, "\nenforces_ownership=");
    let (out, at) = put_text(out, at, bool_text(profile.enforces_ownership));
    let (out, at) = put_text(out, at, "\ndev_reducers=");
    let (out, at) = put_text(out, at, bool_text(profile.dev_reducers));
    let (mut out, mut at) = put_text(out, at, "\n");
    let mut i = 0;
    while i < profile.login_issuers.len() {
        (out, at) = put_text(out, at, "login_issuer=");
        (out, at) = put_text(out, at, profile.login_issuers[i]);
        (out, at) = put_text(out, at, "\n");
        i += 1;
    }
    (out, at)
}

/// The byte length of a profile's `mr_build_profile` section.
pub(crate) const fn profile_section_len(profile: &BuildProfile) -> usize {
    render_profile_section::<0>(profile).1
}

/// A profile's `mr_build_profile` section; `N` is `profile_section_len(profile)`.
pub(crate) const fn profile_section<const N: usize>(profile: &BuildProfile) -> [u8; N] {
    render_profile_section::<N>(profile).0
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
/// flips true (the grace constant has ONE SSOT in game-core).
/// Saturating, mirroring `claim_expires_at`. KNOWN BOUND: at a
/// stamp above `i64::MAX - GRACE` the clamped fire instant is NOT yet due by
/// `is_deletion_due` (the sub-then-compare and add-then-compare formulations
/// diverge only there); unreachable for wall-clock stamps, pinned by its own
/// test.
pub(crate) fn deletion_fire_at_ms(requested_at_ms: i64) -> i64 {
    requested_at_ms.saturating_add(game_core::DELETION_GRACE_MS_DEFAULT)
}

/// The `Account` legal-state invariant — ONE pure predicate,
/// `debug_assert!`ed at the return of every Account-returning constructor
/// below. True iff ALL of:
///   - `Active` implies `deletion_requested_at_ms.is_none()`;
///   - `PendingDeletion` implies `deletion_requested_at_ms.is_some()`;
///   - `terminal_at_ms.is_some()` implies `PendingDeletion` AND
///     `deletion_requested_at_ms.is_some()` (the terminal
///     marker is stamped only by a completed deletion cascade, so a marker on
///     an `Active` row — or with no request behind it — is a resurrected
///     tombstone and must be unrepresentable);
///   - `claimed_from.is_some() == claimed_at_ms.is_some()` (claim provenance
///     is a PAIR — set together or not at all).
///
/// The `match` on `status` is deliberately exhaustive with NO wildcard arm:
/// this fn fails to compile until the new state's timestamp rules are derived
/// here. The struct-shape tripwire in `accounts_tests.rs` pins `Account`'s
/// field list for the same reason — a shape change forces a conscious
/// re-derivation of this predicate rather than a silent widening of the state
/// space.
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
        "new_account_row: illegal Account state"
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
        "touch_login: illegal Account state"
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
        "requested_deletion: illegal Account state"
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
        "cancelled_deletion: illegal Account state"
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
        "claimed_account: illegal Account state"
    );
    out
}

/// True when the row carries the terminal marker (`terminal_at_ms`).
///
/// DELIBERATELY THE MARKER HALF ALONE, whose defined
/// `terminal` is the conjunction `status == PendingDeletion &&
/// terminal_at_ms.is_some()` — hence the name `account_has_terminal_marker`,
/// not `account_is_terminal`. On the ILLEGAL `Active` + marker
/// shape (a resurrected tombstone, forbidden by `account_state_is_legal` but
/// only debug_assert-guarded) the marker half still answers true, which is
/// the fail-closed direction at every call site: an already-erased account
/// must never be cancelled back to life, re-armed, or allowed new
/// commitments.
pub(crate) fn account_has_terminal_marker(account: &Account) -> bool {
    account.terminal_at_ms.is_some()
}

/// The deletion gate — true when gameplay writes must be
/// refused: the account is mid-grace (`PendingDeletion`) OR already erased
/// (terminal marker present).
///
/// EXPLICIT DISJUNCTION on purpose: on legal states the marker implies
/// `PendingDeletion`, so the second arm looks redundant — it is the
/// fail-closed arm for the illegal `Active` + marker shape and must never be
/// simplified away. This is the SSOT `is_pending_deletion` delegates to and
/// the entry point the gameplay-gate fan-out calls (via a `guards.rs`
/// wrapper that delegates, never re-derives). A third disjunct
/// added here widens BOTH consumers: re-derive the delegation first.
pub(crate) fn should_reject_for_deletion(account: &Account) -> bool {
    account.status == AccountStatus::PendingDeletion || account_has_terminal_marker(account)
}

/// The stamp-aware refinement of the gate: true
/// when a deletion-gated account must be refused a commitment that was OPENED
/// at `opened_at_ms` — a trade offer created at that instant, judged for the
/// accepting counterparty. PRV1-10 keeps commitments that PREDATE the deletion
/// request completable, so a mid-grace row refuses only offers stamped at or
/// after its own request. Inclusive on purpose: both stamps come from the same
/// ms-floored transaction clock, so an offer created IN the request millisecond
/// does not predate it, and the attack this closes is "request deletion, then
/// have a confederate propose immediately".
///
/// Composed DIRECTLY over the two SSOT halves, never re-derived: the mid-grace
/// arm delegates to `should_reject_for_deletion` (a third disjunct added there
/// widens this consumer with it), and the terminal marker is tested
/// FIRST and OUTSIDE the stamp comparison, because an already-erased account is
/// refused every commitment however old — the cascade has emptied it, sweeping
/// both offer columns in the same transaction that stamps the marker, so this
/// clause is unreachable in production and kept as the stated contract. Unlike
/// `reaper_should_run_cascade`, which is defined DIRECTLY so the gate can never
/// widen what the reaper erases, this consumer WANTS to widen with the gate —
/// composing over the SSOT halves is the point (`reaper_rearm_at_ms` and
/// `plan_deletion_rearms` compose their own halves the same way). A gated row
/// with NO request stamp is the illegal stamp-less shape that
/// `account_state_is_legal` only debug-asserts away; `None` is the fail-closed
/// arm and is spelled as an explicit match arm on purpose — every `unwrap_or`
/// default hides the decision inside a value and admits some stamp range
/// silently.
pub(crate) fn opened_commitment_is_refused(account: &Account, opened_at_ms: i64) -> bool {
    account_has_terminal_marker(account)
        || (should_reject_for_deletion(account)
            && match account.deletion_requested_at_ms {
                None => true,
                Some(requested) => opened_at_ms >= requested,
            })
}

/// Should the deletion-grace reaper run the cascade for this row at
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

/// The not-yet-due re-arm decision: `Some(requested)`
/// iff the row is still `PendingDeletion`, carries no terminal marker, and its
/// request is not yet due. The runtime deletes a fired one-shot schedule row
/// regardless of what the reducer does, so this is what keeps a not-yet-due
/// account armed. The stamp resolves FIRST: on the illegal `PendingDeletion` +
/// `None` shape there is nothing to re-arm from, and every `unwrap_or`
/// spelling is a disguised clock-relative or epoch-past re-arm — `None` (no
/// re-arm) is the fail-closed direction. Defined DIRECTLY, never as
/// `!reaper_should_run_cascade`: that negation is also true for `Active` and
/// terminal rows, which must never re-arm (a terminal re-arm loops forever).
pub(crate) fn reaper_rearm_at_ms(account: &Account, now_ms: i64) -> Option<i64> {
    let requested = account.deletion_requested_at_ms?;
    if account.status == AccountStatus::PendingDeletion
        && !account_has_terminal_marker(account)
        && !game_core::is_deletion_due(Some(requested), now_ms)
    {
        Some(requested)
    } else {
        None
    }
}

/// tombstone the one PII field, `auth_issuer`. Identity, timestamps and the
/// claim pair are retained, so on every row the cascade
/// recheck admits, legality holds by field-disjointness.
pub(crate) fn anonymized_account(existing: Account) -> Account {
    let out = Account {
        auth_issuer: game_core::TOMBSTONE_AUTH_ISSUER.to_string(),
        ..existing
    };
    debug_assert!(
        account_state_is_legal(&out),
        "anonymized_account: illegal Account state"
    );
    out
}

/// stamp the terminal marker — only
/// after steps 6a-6d completed without error, which the single reducer
/// transaction guarantees structurally (an `Err` aborts every prior write).
/// Touches nothing but `terminal_at_ms`; the cascade recheck already proved
/// `PendingDeletion` with a `Some` request stamp, so legality is a theorem
/// here.
pub(crate) fn terminal_account(existing: Account, now_ms: i64) -> Account {
    let out = Account {
        terminal_at_ms: Some(now_ms),
        ..existing
    };
    debug_assert!(
        account_state_is_legal(&out),
        "terminal_account: illegal Account state"
    );
    out
}

/// which accounts need a deletion-grace schedule row armed, and at what REQUEST
/// stamp (the fire instant derives from it inside `arm_deletion_reaper`, the one
/// place that computes it). Emits, in INPUT ORDER, `(identity, requested_at_ms)`
/// for every `PendingDeletion` row with no terminal marker, a present request
/// stamp, and no already-armed schedule row. Mirrors `plan_schedule_reconcile`'s
/// pure-planner shape (lib.rs). A past-due stamp is still emitted —
/// `ScheduleAt::Time` in the past fires immediately, which is exactly what an
/// overdue account needs.
pub(crate) fn plan_deletion_rearms(
    accounts: &[Account],
    already_armed: &[Identity],
) -> Vec<(Identity, i64)> {
    accounts
        .iter()
        .filter(|a| {
            a.status == AccountStatus::PendingDeletion
                && !account_has_terminal_marker(a)
                && !already_armed.contains(&a.identity)
        })
        .filter_map(|a| {
            a.deletion_requested_at_ms
                .map(|requested| (a.identity, requested))
        })
        .collect()
}

/// Which of the caller's live INCOMING trade offers must
/// be declined when a pending deletion is cancelled — given the row as it
/// stands BEFORE the cancel writes it, and the offers as `(trade_id,
/// created_at_ms)` pairs, the ids of every offer the stamp gate refuses
/// for that row, in input order. Composed DIRECTLY over
/// `opened_commitment_is_refused`: the inclusive boundary, the terminal arm and
/// the fail-closed missing-stamp arm are all inherited, so on the illegal
/// stamp-less `PendingDeletion` shape every incoming offer is swept, and on an
/// `Active` row nothing is. Judged after the row has flipped to `Active` it
/// would sweep nothing — which is why the call site reads `&account` before
/// `cancelled_deletion(account)` moves it. Mirrors the `plan_deletion_rearms`
/// pure-planner shape; the ctx halves live in `trading`
/// (`open_offers_addressed_to` / `decline_offers`) because only that module
/// reads and writes `trade_offer`.
pub(crate) fn plan_declines_at_cancel(account: &Account, offers: &[(u64, i64)]) -> Vec<u64> {
    offers
        .iter()
        .filter(|(_, opened_at_ms)| opened_commitment_is_refused(account, *opened_at_ms))
        .map(|(trade_id, _)| *trade_id)
        .collect()
}

// --- Context-bound predicates (SSOT) ------------------------------------------

/// The load-bearing "is this an account holder?" gate. Only a verified
/// allowed-issuer/audience token ever produces an `account` row, so this is
/// strictly more precise than `has_jwt()` (true for every connection).
pub(crate) fn is_account_holder(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db.account().identity().find(identity).is_some()
}

/// True iff `identity` holds an account the deletion gate refuses (false when
/// no row). SSOT — reused by `complete_guest_claim` here and by
/// gameplay-gate call sites, never re-derived. It DELEGATES to
/// `should_reject_for_deletion`.
pub(crate) fn is_pending_deletion(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .account()
        .identity()
        .find(identity)
        .is_some_and(|a| should_reject_for_deletion(&a))
}

/// The ctx-bound half of the refinement: does `identity`'s
/// account refuse a commitment opened at `opened_at_ms`? False when there is no
/// row — a guest has no deletion state — exactly as `is_pending_deletion`
/// decides, and with the same lookup shape on purpose.
/// Identity-taking like its sibling, and therefore an oracle primitive: the
/// ONLY sanctioned consumer is `guards::require_commitment_predates_deletion`,
/// which reads `ctx.sender()` and cannot be pointed at a third party. a reducer
/// that consults this predicate about another player is the deletion-status
/// oracle.
pub(crate) fn refuses_commitment_opened_at(
    ctx: &ReducerContext,
    identity: Identity,
    opened_at_ms: i64,
) -> bool {
    ctx.db
        .account()
        .identity()
        .find(identity)
        .is_some_and(|a| opened_commitment_is_refused(&a, opened_at_ms))
}

/// True if `identity` owns any row in any REKEY-policy table (D5 guard 3). The
/// `account` row itself never counts. Delegates every check to the owning
/// module (D0). Short-circuits most-discriminating-first (`join_game` grants a
/// monster unconditionally on first play).
pub(crate) fn account_has_game_data(ctx: &ReducerContext, identity: Identity) -> bool {
    crate::monster_mgmt::has_monsters(ctx, identity)
        || crate::evolution::has_evolution_notices(ctx, identity)
        || crate::inventory::has_items(ctx, identity)
        || crate::economy::wallet_exists(ctx, identity)
        || crate::ranking::profile_exists(ctx, identity)
        || crate::npc::has_quest_or_dialogue_state(ctx, identity)
        || crate::raising::has_heal_cooldown(ctx, identity)
        || crate::schema::has_formation(ctx, identity)
        || crate::movement::has_last_position(ctx, identity)
        || crate::onboarding::has_handle(ctx, identity)
}

/// Re-key every REKEY-policy table from `from` onto `to`, one delegated helper
/// per table. `?` on the fallible monster re-key rolls the
/// whole claim transaction back (fail-loud on a broken dual-write invariant).
/// Trade sessions are not re-keyed: every session naming either identity is
/// deleted.
///
/// MANIFEST CROSS-REFERENCE: the claim-flow re-key policy
/// is one axis; the DELETION policy dimension (`deletion_policy` + `basis` +
/// `exportable` per table, spec §3) lives as `schema::DATA_LIFECYCLE_MANIFEST`
/// beside the table declarations.
/// A gate test proves every REKEY key's table is also lifecycle-classified,
/// so the two manifests cannot drift apart on a rename.
pub(crate) fn rekey_all(ctx: &ReducerContext, from: Identity, to: Identity) -> Result<(), String> {
    crate::monster_mgmt::rekey_monsters(ctx, from, to)?;
    crate::evolution::rekey_evolution_notices(ctx, from, to);
    crate::inventory::rekey_inventory(ctx, from, to);
    crate::npc::rekey_npc_state(ctx, from, to);
    crate::raising::rekey_heal_cooldown(ctx, from, to);
    crate::economy::rekey_wallet(ctx, from, to);
    crate::ranking::rekey_profile(ctx, from, to);
    crate::schema::rekey_formation(ctx, from, to);
    crate::movement::rekey_last_position(ctx, from, to);
    crate::onboarding::rekey_handle(ctx, from, to);
    crate::trading_session::delete_sessions_of(ctx, from);
    crate::trading_session::delete_sessions_of(ctx, to);
    Ok(())
}

// --- Claim / reaper lifecycle helpers -----------------------------------------

/// Delete only the `guest_claim` row (used by the reaper — the runtime deletes
/// the fired one-shot schedule row itself, so the reaper must NOT disarm, C3).
fn delete_claim(ctx: &ReducerContext, guest: Identity) {
    ctx.db.guest_claim().guest_identity().delete(guest);
}

/// Disarm the reaper schedule row(s) for `guest` (collect-then-delete via the
/// `guest_identity` btree index, then delete by PK).
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

// --- Ownership ----------------------------------------------------------------

/// Whether the caller may play under `profile`. A build that does not enforce ownership
/// admits everyone and never reads the token. An enforcing build admits a connection whose
/// token is from one of the profile's login issuers, is addressed to this application and
/// names the base game. The audience of a token from any other issuer is never read.
pub(crate) fn entitled(ctx: &ReducerContext, profile: &BuildProfile) -> bool {
    if !profile.enforces_ownership {
        return true;
    }
    let Some(claims) = ctx.sender_auth().jwt() else {
        return false;
    };
    issuer_allowed(claims.issuer(), profile.login_issuers)
        && audience_allowed(claims.audience(), ALLOWED_AUDIENCE)
        && token_names_entitlement(claims.raw_payload(), ENTITLEMENT_BASE_GAME)
}

/// Refuses a caller who is not entitled under `profile` with `ERR_OWNERSHIP_REQUIRED`. Reads
/// no table and writes nothing.
pub(crate) fn require_entitled(
    ctx: &ReducerContext,
    profile: &BuildProfile,
    reducer: &str,
) -> Result<(), String> {
    if entitled(ctx, profile) {
        return Ok(());
    }
    reject(reducer, ctx.sender(), ERR_OWNERSHIP_REQUIRED)
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
        // a terminal account re-registers FRESH. Every field at
        // `new_account_row` defaults, identity/auth_issuer from the LIVE
        // connection, no pre-deletion value carried forward — the arm body
        // deliberately never reads the matched row (the guard binding is the
        // only mention). `update`, not insert: the row exists. Keyed on the
        // marker HALF (fail-closed on the illegal Active+marker shape, like
        // every other marker call site).
        Some(existing) if account_has_terminal_marker(&existing) => {
            ctx.db.account().identity().update(new_account_row(
                ctx.sender(),
                issuer.to_string(),
                now,
            ));
        }
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
    crate::access::require_admitted(ctx, "start_guest_claim")?;
    let me = ctx.sender();
    // AUTH-7 — an account holder cannot start a guest claim (D4′).
    if is_account_holder(ctx, me) {
        return reject("start_guest_claim", me, "already signed in");
    }
    // AUTH-8 — code must be exactly 64 lowercase hex chars.
    if !is_valid_claim_code(&code) {
        return reject("start_guest_claim", me, "invalid claim code");
    }
    // guest_name is snapshotted from player.name; an identity with no
    // player row has nothing to claim.
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
/// erase what stays behind under the retired guest identity (its export bundles
/// and its finished battles), consume the code (single-use), stamp provenance
/// (AUTH-12..21, 26, 34, 35).
///
/// Guard ordering: all caller-state checks (1–4) run BEFORE any code resolution
/// (5+), so an unauthorized caller can never use this reducer as a claim-code
/// oracle. Every reject modifies nothing (AUTH-26) — including the expiry path
/// (a reducer `Err` cannot persist a delete; the reaper owns expired cleanup).
#[spacetimedb::reducer]
pub fn complete_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String> {
    crate::access::require_admitted(ctx, "complete_guest_claim")?;
    let me = ctx.sender();
    // Guard 1 (AUTH-12) — cheap JWT pre-filter (belt; guard 2 is load-bearing).
    if !ctx.sender_auth().has_jwt() {
        return reject("complete_guest_claim", me, "sign in required");
    }
    // Guard 2 (AUTH-12) — caller must hold an account row (D4′).
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("complete_guest_claim", me, "no account");
    };
    // Guard 3 — deletion gate, terminal first:
    // a completed erasure gets the DISTINCT static reason; the mid-grace
    // state keeps the generic one. Ordering matters — the disjunction inside
    // `is_pending_deletion` would otherwise swallow the terminal case into
    // the generic message.
    if account_has_terminal_marker(&account) {
        return reject("complete_guest_claim", me, REJECT_ALREADY_DELETED);
    }
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
    // TOCTOU: reducers are fully serialized, atomicity is free.
    rekey_all(ctx, guest, me)?;
    // The guest identity retires at this claim, so its
    // pre-claim export_bundle chunks would orphan — the S3 cascade keys on a
    // live account's own identity and cannot reach them. Purge them here, in
    // the same transaction, via the owning module (G5/D0). The helper reports
    // how many chunks it deleted; the count is published
    // below, once nothing can roll the claim back.
    let purged = crate::privacy::purge_export_bundles(ctx, guest);
    // The guest's finished battles are not re-keyed (why: docs/DECISIONS.md,
    // "Accounts, guest identity and the claim flow"). The claim erases them as
    // the deletion cascade erases its subject's: the per-battle tactical rows
    // go, and the guest's side of each `battle` and `battle_summary` row
    // becomes the tombstone identity, the other side untouched. The order is
    // load-bearing: both calls AFTER `rekey_all` (the erase deletes the
    // formation under the identity it is handed, and the guest's has moved by
    // now), the erase BEFORE the tombstone swap (it finds battles through the
    // anchors that still name the guest). Guard 10 leaves no `Ongoing` row for
    // the swap to force, so it logs nothing here.
    crate::schema::erase_tactical_rows(ctx, guest);
    crate::battle::anonymize_battles(ctx, guest);
    consume_claim_and_disarm(ctx, guest);
    ctx.db
        .account()
        .identity()
        .update(claimed_account(account, guest, now_ms(ctx)));
    // The purge is observable — ONE line through the blessed
    // emission point, as the TERMINAL statement: a host log
    // line survives a later rollback while the deletes do not, so nothing may
    // run after it. The evt literal is bare on purpose (a const or concat! is
    // invisible to a grep for the event name).
    crate::observability::mr_log("guest_claim_export_purge", &purge_fields(guest, purged));
    Ok(())
}

/// The ONE field fragment of the claim-time export-purge line
/// PURE, no `ctx`, no table read, so the value is unit-testable off-instance.
/// `guest` is the RETIRED guest identity (the SUBJECT of the erasure; already
/// persists the guest-to-claimer linkage on the row) rendered through the
/// `Identity` Display impl — 64 lowercase hex digits, structurally quote-safe.
/// `chunks` is the count `purge_export_bundles` returned, unquoted. No
/// player-authored field and no pre-tombstone value may ever join this
/// fragment.
fn purge_fields(guest: Identity, chunks: usize) -> String {
    format!("\"guest\":\"{guest}\",\"chunks\":{chunks}")
}

/// The ONE field fragment of the deletion-cascade line —
/// the `purge_fields` shape: PURE, no `ctx`, no table read, unit-tested by
/// value. `subject` is the ERASED account identity — the SUBJECT of the
/// erasure, the key an audit is answered by; the Anonymize-policy `account`
/// row keeps that same key permanently, so this 30-day host-log copy is the
/// shorter-lived one — rendered through the `Identity` Display impl (64
/// lowercase hex digits, structurally quote-safe). `export_bundle` is the
/// count step 6b's `purge_export_bundles` returned, unquoted, keyed by the
/// helper noun so the deferred per-step counts append beside it.
/// No player-authored field and no pre-tombstone value may ever join
/// this fragment (which name this reducer literally).
fn cascade_fields(subject: Identity, export_chunks: usize) -> String {
    format!("\"subject\":\"{subject}\",\"export_bundle\":{export_chunks}")
}

// --- Deletion ---

/// Arm the one-shot deletion-grace reaper for `account`. Fire
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

/// Disarm the pending deletion-reaper schedule row(s) for `account`.
/// Owner-GENERIC.
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

/// (re-)arm the deletion-grace reaper for every account sitting
/// `PendingDeletion` with no terminal marker and no schedule row. Called from
/// `init` and `sync_content` beside `ensure_playtest_reaper` /
/// `ensure_mr_heartbeat`; the body lives HERE because the sole-writer teeth
/// close the schedule table to every other module. Idempotent via the pure
/// `plan_deletion_rearms` seam: an already-armed identity is never re-armed,
/// so repeated publishes add nothing.
pub(crate) fn ensure_deletion_reapers_armed(ctx: &ReducerContext) {
    let accounts: Vec<Account> = ctx.db.account().iter().collect();
    let already_armed: Vec<Identity> = ctx
        .db
        .account_deletion_reaper_schedule()
        .iter()
        .map(|s| s.account_identity)
        .collect();
    for (identity, requested_at_ms) in plan_deletion_rearms(&accounts, &already_armed) {
        arm_deletion_reaper(ctx, identity, requested_at_ms);
    }
}

/// Request account deletion — sets `PendingDeletion` and arms the deletion-grace
/// reaper LAST. Idempotent: the second call writes nothing and arms nothing.
#[spacetimedb::reducer]
pub fn delete_account(ctx: &ReducerContext) -> Result<(), String> {
    crate::access::require_admitted(ctx, "delete_account")?;
    let me = ctx.sender();
    // AUTH-37 — reject a caller with no JWT (symmetric with AUTH-7/12).
    if !ctx.sender_auth().has_jwt() {
        return reject("delete_account", me, "sign in required");
    }
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("delete_account", me, "no account");
    };
    // The terminal marker wins over status. On the illegal
    // Active + marker shape would answer yes and
    // launder the row into a legal PendingDeletion + marker state, arming a
    // SECOND cascade over an already-erased account. `Ok` shape, not a
    // reject.
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
    crate::access::require_admitted(ctx, "cancel_account_deletion")?;
    let me = ctx.sender();
    if !ctx.sender_auth().has_jwt() {
        return reject("cancel_account_deletion", me, "sign in required");
    }
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("cancel_account_deletion", me, "no account");
    };
    // A completed erasure is not reversible — a
    // late cancel gets a DISTINCT error, never a silent success. Guard-first
    // is fail-closed on the illegal Active + marker shape, where
    // would otherwise wave the row through to a silent Ok.
    if account_has_terminal_marker(&account) {
        return reject("cancel_account_deletion", me, REJECT_ALREADY_DELETED);
    }
    // AUTH-38 — no write when already Active.
    if !needs_cancel_write(account.status) {
        return Ok(());
    }
    // Decline every incoming offer the stamp gate
    // refused for THIS pre-cancel row — the confederate's post-request
    // proposals — so the cancel cannot launder them into an accept.
    // and before the status write, because `account` is moved into the
    // constructor below and a row judged after the flip refuses nothing.
    crate::trading::decline_offers(
        ctx,
        &plan_declines_at_cancel(&account, &crate::trading::open_offers_addressed_to(ctx, me)),
    );
    crate::trading_session::decline_sessions(
        ctx,
        &plan_declines_at_cancel(
            &account,
            &crate::trading_session::open_sessions_addressed_to(ctx, me),
        ),
    );
    ctx.db
        .account()
        .identity()
        .update(cancelled_deletion(account));
    // Actively disarm the pending reaper row — inside the gate (an Active
    // account owns no armed row by construction) and after the status write,
    // mirroring the arm-last rule on the request side.
    disarm_deletion_reaper(ctx, me);
    Ok(())
}

// --- Scheduled TTL reaper (AUTH-27) -------------------------------------------

/// PRIVATE scheduled table colocated with its reducer.
/// `guest_identity` carries a btree index so the DISARM path filters instead of
/// scanning — mirrors `battle_challenge_reaper_schedule.challenge_id`.
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

// --- Scheduled deletion-grace reaper

/// PRIVATE scheduled table colocated with its reducer,
/// mirroring `guest_claim_reaper_schedule` exactly. Minimal field set
/// — deliberately NO timestamp column, so staleness can only ever
/// derive from the live `account` row's own `deletion_requested_at_ms` plus the
/// injected clock, never from anything a caller could supply.
/// `account_identity` carries a btree index so filters
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

/// Deletion-grace reaper.
/// Scheduler-only first statement, then a re-read of the live
/// `account` row keyed on the SCHEDULER-supplied identity, then the pure
/// `reaper_should_run_cascade` recheck. On a not-yet-due row the recheck
/// branch RE-ARMS from the row's own request stamp (`reaper_rearm_at_ms` —
/// the runtime has already deleted the fired one-shot row)
/// before the no-op return; an `Active`, terminal or missing row re-arms
/// nothing and no-ops.
///
/// The cascade proper, one transaction: 6a force-resolve every live
/// interaction via the shared `on_disconnect` bundle — FIRST, so nothing
/// below yanks rows out from under a live battle/trade resolution; 6b the
/// delegated ERASE sweeps in manifest order (write isolation: every
/// foreign-table write lives in its owning module, the `rekey_all`
/// precedent), including the export-bundle purge; 6d `character` strictly
/// before 6c's player display-name tombstone (the spec's order pin — the join
/// key is the live `player` row); the battle anonymize sweeps its own
/// join-only children per row before each identity swap; then 6e — LAST, and
/// only reachable when everything above returned — one `account` update
/// stamping the auth-issuer tombstone and the terminal marker. An `Err`
/// anywhere aborts the whole transaction, so a partially-erased account
/// cannot persist and the marker can never precede the erasure.
/// Then, TERMINALLY, one `account_deletion_cascade` line
/// through `observability::mr_log` carrying the subject hex and the count
/// step 6b's purge returned — written pre-commit, at-least-once, never a
/// commit record: the SSOT for `was X erased` is the row's `terminal_at_ms`.
/// Scheduler-only: the guard is the entire precondition.
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
    let now = now_ms(ctx);
    if !reaper_should_run_cascade(&account, now) {
        if let Some(requested) = reaper_rearm_at_ms(&account, now) {
            arm_deletion_reaper(ctx, args.account_identity, requested);
        }
        return Ok(());
    }
    crate::resolve_all_live_interactions(ctx, args.account_identity);
    crate::monster_mgmt::erase_monsters(ctx, args.account_identity);
    crate::evolution::erase_evolution_notices(ctx, args.account_identity);
    crate::inventory::erase_inventory(ctx, args.account_identity);
    crate::npc::erase_npc_state(ctx, args.account_identity);
    crate::raising::erase_heal_cooldown(ctx, args.account_identity);
    crate::movement::erase_last_position(ctx, args.account_identity);
    crate::onboarding::erase_handle(ctx, args.account_identity);
    crate::economy::erase_wallet(ctx, args.account_identity);
    crate::playtest::erase_playtest_events(ctx, args.account_identity);
    crate::trading::erase_trade_offers(ctx, args.account_identity);
    crate::trading_session::delete_sessions_of(ctx, args.account_identity);
    crate::pvp::erase_pvp_rows(ctx, args.account_identity);
    let export_chunks = crate::privacy::purge_export_bundles(ctx, args.account_identity);
    crate::erase_character_rows(ctx, args.account_identity);
    crate::erase_player_sessions(ctx, args.account_identity);
    crate::access::erase_admission(ctx, args.account_identity);
    crate::ranking::anonymize_display_names(ctx, args.account_identity);
    crate::schema::erase_tactical_rows(ctx, args.account_identity);
    crate::battle::anonymize_battles(ctx, args.account_identity);
    ctx.db
        .account()
        .identity()
        .update(terminal_account(anonymized_account(account), now));
    // ONE cascade-wide observation, TERMINAL — after the
    // stamp, after every step, before Ok(()). A host log line survives a
    // later rollback while the writes do not, so nothing may run after it.
    // Unconditional: the zero-chunk cascade is the negative an audit needs.
    let fields = cascade_fields(args.account_identity, export_chunks);
    crate::observability::mr_log("account_deletion_cascade", &fields);
    Ok(())
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod accounts_tests;
