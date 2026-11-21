//! `access` — server-module domain submodule.
//!
//! Who may join this world. The host's rule is the one row of the private `world_access`
//! table; a world with no row is `Open`. Under `Password` an identity may join once it is the
//! owner (`config.owner_identity`) or holds a `world_admission` row. The connect reducer
//! refuses anyone else ([`require_admitted_at_connect`]), which holds that identity off every
//! table and every reducer, and every reducer of the generated client roster that is not
//! owner-only makes the same check as its first statement ([`require_admitted`]), because the
//! host checks a connection only when it opens. The reducers that exist only in a dev build
//! (`dev_reducers`, `load_test_zones`) are outside that roster and make no check.
//!
//! An identity that is not admitted can call nothing, so admission is granted by the two
//! reducers here, which only the owner can call: [`set_world_access`] sets the rule and admits
//! identities outright, and [`admit`] is the door, where the owner relays a joiner's password.
//!
//! WRITE-ISOLATION: this module alone writes `world_access`, `world_admission` and
//! `world_admission_attempt`. It reads `config` for the owner and, when the rule leaves `Open`,
//! the live sessions through `crate::live_session_identities`.

use crate::guards::log_reject;
use crate::marshal::now_ms;
use crate::schema::{
    config, world_access, world_admission, world_admission_attempt, WorldAccess, WorldAccessRule,
    WorldAdmission, WorldAdmissionAttempt,
};
use argon2::{Algorithm, Argon2, Params, Version};
use spacetimedb::{Identity, ReducerContext, Table};

/// The refusal an identity gets, at connect and from every reducer a player can call, while the
/// rule is `Password` and it is neither the owner nor admitted.
pub(crate) const REJECT_NOT_ADMITTED: &str = "not admitted";
pub(crate) const REJECT_NOT_WORLD_OWNER: &str = "caller is not the world owner";
pub(crate) const REJECT_ADMIT_LOCKED: &str = "too many wrong passwords for this identity";
pub(crate) const REJECT_NO_PASSWORD_RULE: &str = "this world has no password rule";
pub(crate) const REJECT_PASSWORD_LENGTH: &str = "a password is 1 to 128 bytes";
pub(crate) const REJECT_OPEN_TAKES_NO_PASSWORD: &str = "an open world takes no password";
pub(crate) const REJECT_PASSWORD_REQUIRED: &str = "a password world needs a password";
/// The log reason of a wrong password at the door. The call itself answers `Ok` (see [`admit`]).
const LOG_WRONG_PASSWORD: &str = "wrong password";

/// The door refuses an identity while this many of its wrong passwords are less than
/// [`ADMIT_ATTEMPT_WINDOW_MS`] old.
pub(crate) const ADMIT_MAX_WRONG_ATTEMPTS: usize = 5;
pub(crate) const ADMIT_ATTEMPT_WINDOW_MS: i64 = 10 * 60 * 1000;
pub(crate) const PASSWORD_MAX_BYTES: usize = 128;
pub(crate) const PASSWORD_SALT_BYTES: usize = 16;
pub(crate) const PASSWORD_HASH_BYTES: usize = 32;

/// Argon2id cost: 19 MiB, two passes, one lane, the parameters the account service hashes its
/// own passwords with. One hash is about 18 ms of native release time.
const ARGON2_MEMORY_KIB: u32 = 19_456;
const ARGON2_PASSES: u32 = 2;
const ARGON2_LANES: u32 = 1;

const WORLD_ACCESS_ROW: u32 = 0;
const CONFIG_ROW: u32 = 0;

/// Limits the refused-connection log line to one a minute: under `Password` every stranger who
/// reaches the server takes this path.
static NOT_ADMITTED_CONNECT_LOG_LIMITER: crate::movement::RateLimiter =
    crate::movement::RateLimiter::new();
const NOT_ADMITTED_CONNECT_LOG_WINDOW_MS: i64 = 60_000;

// --- Pure decision seams -------------------------------------------------------

/// The rule in force: the stored row's, or `Open` for a world with no row.
pub(crate) fn effective_rule(row: Option<&WorldAccess>) -> WorldAccessRule {
    row.map_or(WorldAccessRule::Open, |r| r.rule)
}

/// The wrong-password stamps that still count at `now`: those less than
/// [`ADMIT_ATTEMPT_WINDOW_MS`] old, in their stored order. A stamp ahead of `now` (the clock ran
/// backwards) counts, so a clock step never unlocks an identity.
pub(crate) fn recent_wrong_attempts(wrong_at_ms: &[i64], now: i64) -> Vec<i64> {
    wrong_at_ms
        .iter()
        .copied()
        .filter(|&at| now.saturating_sub(at) < ADMIT_ATTEMPT_WINDOW_MS)
        .collect()
}

/// Whether the door refuses an identity with these stamps at `now`: a sliding window, so no ten
/// minutes ever hold more than [`ADMIT_MAX_WRONG_ATTEMPTS`] wrong passwords for one identity,
/// and the refusal lifts when the oldest of them turns ten minutes old.
pub(crate) fn attempts_locked(wrong_at_ms: &[i64], now: i64) -> bool {
    recent_wrong_attempts(wrong_at_ms, now).len() >= ADMIT_MAX_WRONG_ATTEMPTS
}

/// Argon2id (version 1.3) of `password` under `salt`, [`PASSWORD_HASH_BYTES`] long. Reads no
/// clock and no randomness. Panics on a salt Argon2 refuses (under 8 bytes); every caller passes
/// a [`PASSWORD_SALT_BYTES`] salt.
pub(crate) fn hash_password(salt: &[u8], password: &str) -> Vec<u8> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_PASSES,
        ARGON2_LANES,
        Some(PASSWORD_HASH_BYTES),
    )
    .expect("the Argon2id cost constants are inside the algorithm's bounds");
    let mut hash = vec![0u8; PASSWORD_HASH_BYTES];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut hash)
        .expect("Argon2id accepts a 16-byte salt and a password of at most 128 bytes");
    hash
}

/// Whether `password` is the one `row` was built from. A row that does not hold a full salt and
/// a full hash matches nothing. Every byte is compared whatever the first difference, so the
/// time taken does not say where two hashes part.
pub(crate) fn password_matches(row: &WorldAccess, password: &str) -> bool {
    if row.password_salt.len() != PASSWORD_SALT_BYTES
        || row.password_hash.len() != PASSWORD_HASH_BYTES
    {
        return false;
    }
    let candidate = hash_password(&row.password_salt, password);
    let mut difference = 0u8;
    for (a, b) in candidate.iter().zip(row.password_hash.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

fn password_length_ok(password: &str) -> bool {
    !password.is_empty() && password.len() <= PASSWORD_MAX_BYTES
}

// --- Context-bound predicates and guards ---------------------------------------

/// Whether `identity` is the world's owner. A world with no `config` row, or one whose owner
/// was never registered (the all-zero default), has no owner.
fn is_world_owner(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .config()
        .id()
        .find(CONFIG_ROW)
        .is_some_and(|cfg| cfg.owner_identity != Identity::ZERO && cfg.owner_identity == identity)
}

/// Whether the host's rule lets `identity` in: always under `Open`; under `Password` only the
/// owner and an identity with a `world_admission` row.
pub(crate) fn is_admitted(ctx: &ReducerContext, identity: Identity) -> bool {
    let access = ctx.db.world_access().id().find(WORLD_ACCESS_ROW);
    match effective_rule(access.as_ref()) {
        WorldAccessRule::Open => true,
        WorldAccessRule::Password => {
            is_world_owner(ctx, identity)
                || ctx.db.world_admission().identity().find(identity).is_some()
        }
    }
}

/// The admission check of a client-callable reducer: its first statement, so an identity the
/// rule does not admit is refused before anything is read or written on its behalf.
pub(crate) fn require_admitted(ctx: &ReducerContext, reducer: &str) -> Result<(), String> {
    if is_admitted(ctx, ctx.sender()) {
        return Ok(());
    }
    reject(reducer, ctx.sender(), REJECT_NOT_ADMITTED)
}

/// The admission check of the connect reducer: its first statement. The `Err` makes the host
/// refuse the connection, so the identity reads no table and calls no reducer.
pub(crate) fn require_admitted_at_connect(ctx: &ReducerContext) -> Result<(), String> {
    if is_admitted(ctx, ctx.sender()) {
        return Ok(());
    }
    if NOT_ADMITTED_CONNECT_LOG_LIMITER
        .check(now_ms(ctx), NOT_ADMITTED_CONNECT_LOG_WINDOW_MS)
        .is_some()
    {
        log_reject("client_connected", ctx.sender(), REJECT_NOT_ADMITTED);
    }
    Err(REJECT_NOT_ADMITTED.to_string())
}

fn require_world_owner(ctx: &ReducerContext, reducer: &str) -> Result<(), String> {
    if is_world_owner(ctx, ctx.sender()) {
        return Ok(());
    }
    reject(reducer, ctx.sender(), REJECT_NOT_WORLD_OWNER)
}

/// Log a refusal and return it. The reason is always one of this module's constants.
fn reject(reducer: &str, sender: Identity, reason: &str) -> Result<(), String> {
    log_reject(reducer, sender, reason);
    Err(reason.to_string())
}

// --- Table writes ---------------------------------------------------------------

/// Admit `who` at `now`: one `world_admission` row per identity, so an identity admitted before
/// keeps the row it has. Its wrong-password record, if any, goes.
fn admit_identity(ctx: &ReducerContext, who: Identity, now: i64) {
    if ctx.db.world_admission().identity().find(who).is_none() {
        ctx.db.world_admission().insert(WorldAdmission {
            identity: who,
            admitted_at_ms: now,
        });
    }
    if ctx
        .db
        .world_admission_attempt()
        .identity()
        .find(who)
        .is_some()
    {
        ctx.db.world_admission_attempt().identity().delete(who);
    }
}

/// Delete every wrong-password record whose latest stamp is [`ADMIT_ATTEMPT_WINDOW_MS`] or more
/// behind `now`: none of its stamps counts any longer.
fn sweep_stale_attempts(ctx: &ReducerContext, now: i64) {
    let cutoff = now.saturating_sub(ADMIT_ATTEMPT_WINDOW_MS);
    let stale: Vec<Identity> = ctx
        .db
        .world_admission_attempt()
        .last_wrong_at_ms()
        .filter(..=cutoff)
        .map(|attempt| attempt.identity)
        .collect();
    for identity in stale {
        ctx.db.world_admission_attempt().identity().delete(identity);
    }
}

/// Erase what this module holds about `identity`: its admission and its wrong-password record.
/// The deletion cascade's step for these two tables.
pub(crate) fn erase_admission(ctx: &ReducerContext, identity: Identity) {
    ctx.db.world_admission().identity().delete(identity);
    ctx.db.world_admission_attempt().identity().delete(identity);
}

// --- Reducers --------------------------------------------------------------------

/// Set the world's access rule and admit identities outright. Owner-only.
///
/// `Open` takes no password and clears the stored one. `Password` with `Some` stores a fresh
/// salt and the hash of the new password; `Password` with `None` keeps the stored password and
/// is refused when there is none. When the rule leaves `Open`, every identity with a live
/// connection is admitted, so no connection the rule never admitted stays open. Each identity in
/// `admit` is admitted under either rule, without a password: this is how the host admits its
/// own player. Admissions outlive a password change and a return to `Open`.
#[spacetimedb::reducer]
pub fn set_world_access(
    ctx: &ReducerContext,
    rule: WorldAccessRule,
    password: Option<String>,
    admit: Vec<Identity>,
) -> Result<(), String> {
    require_world_owner(ctx, "set_world_access")?;
    let stored = ctx.db.world_access().id().find(WORLD_ACCESS_ROW);
    let was = effective_rule(stored.as_ref());
    let (password_salt, password_hash) = match (rule, password) {
        (WorldAccessRule::Open, None) => (Vec::new(), Vec::new()),
        (WorldAccessRule::Open, Some(_)) => {
            return reject(
                "set_world_access",
                ctx.sender(),
                REJECT_OPEN_TAKES_NO_PASSWORD,
            );
        }
        (WorldAccessRule::Password, Some(new_password)) => {
            if !password_length_ok(&new_password) {
                return reject("set_world_access", ctx.sender(), REJECT_PASSWORD_LENGTH);
            }
            let salt: [u8; PASSWORD_SALT_BYTES] = ctx.random();
            (salt.to_vec(), hash_password(&salt, &new_password))
        }
        (WorldAccessRule::Password, None) => match stored.as_ref() {
            Some(row)
                if row.rule == WorldAccessRule::Password
                    && row.password_salt.len() == PASSWORD_SALT_BYTES
                    && row.password_hash.len() == PASSWORD_HASH_BYTES =>
            {
                (row.password_salt.clone(), row.password_hash.clone())
            }
            _ => {
                return reject("set_world_access", ctx.sender(), REJECT_PASSWORD_REQUIRED);
            }
        },
    };
    let row = WorldAccess {
        id: WORLD_ACCESS_ROW,
        rule,
        password_salt,
        password_hash,
    };
    if stored.is_some() {
        ctx.db.world_access().id().update(row);
    } else {
        ctx.db.world_access().insert(row);
    }
    let now = now_ms(ctx);
    if was == WorldAccessRule::Open && rule == WorldAccessRule::Password {
        for identity in crate::live_session_identities(ctx) {
            if !is_world_owner(ctx, identity) {
                admit_identity(ctx, identity, now);
            }
        }
    }
    for identity in admit {
        admit_identity(ctx, identity, now);
    }
    Ok(())
}

/// The door of a `Password` world: admit `who` when `password` is the host's. Owner-only, since
/// an identity that is not admitted can call nothing; the owner relays the joiner's password.
///
/// Refused with `Err` and no write: a caller that is not the owner; a world whose rule is not
/// `Password`; a `who` with [`ADMIT_MAX_WRONG_ATTEMPTS`] wrong passwords in the last ten minutes
/// (the right password included, and before any hashing); an empty or over-long password. An
/// already admitted `who` is `Ok` with no write.
///
/// A WRONG PASSWORD ANSWERS `Ok(())`: an `Err` rolls the transaction back, and the wrong attempt
/// has to be recorded for the lockout to count it. Nothing is written but that record. The
/// caller learns the outcome from the `world_admission` row: present after the call, `who` is
/// admitted.
#[spacetimedb::reducer]
pub fn admit(ctx: &ReducerContext, who: Identity, password: String) -> Result<(), String> {
    require_world_owner(ctx, "admit")?;
    let Some(access) = ctx
        .db
        .world_access()
        .id()
        .find(WORLD_ACCESS_ROW)
        .filter(|row| row.rule == WorldAccessRule::Password)
    else {
        return reject("admit", ctx.sender(), REJECT_NO_PASSWORD_RULE);
    };
    if ctx.db.world_admission().identity().find(who).is_some() {
        return Ok(());
    }
    let now = now_ms(ctx);
    let attempt = ctx.db.world_admission_attempt().identity().find(who);
    let stamps: &[i64] = attempt
        .as_ref()
        .map_or(&[], |row| row.wrong_at_ms.as_slice());
    if attempts_locked(stamps, now) {
        return reject("admit", ctx.sender(), REJECT_ADMIT_LOCKED);
    }
    if !password_length_ok(&password) {
        return reject("admit", ctx.sender(), REJECT_PASSWORD_LENGTH);
    }
    if password_matches(&access, &password) {
        admit_identity(ctx, who, now);
        sweep_stale_attempts(ctx, now);
        return Ok(());
    }
    let mut wrong_at_ms = recent_wrong_attempts(stamps, now);
    wrong_at_ms.push(now);
    // The sweep's key is the latest stamp, not this call's time: after the clock steps back a
    // row still holds stamps ahead of `now`, and they still count.
    let last_wrong_at_ms = wrong_at_ms.iter().copied().max().unwrap_or(now);
    let record = WorldAdmissionAttempt {
        identity: who,
        wrong_at_ms,
        last_wrong_at_ms,
    };
    if attempt.is_some() {
        ctx.db.world_admission_attempt().identity().update(record);
    } else {
        ctx.db.world_admission_attempt().insert(record);
    }
    sweep_stale_attempts(ctx, now);
    log_reject("admit", ctx.sender(), LOG_WRONG_PASSWORD);
    Ok(())
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod access_tests;
