//! `access` — server-module domain submodule.
//!
//! Who may join this world. The host's rule is the one row of the private `world_access`
//! table; a world with no row is `Open`. Under `Password` an identity may join once it is the
//! owner (`config.owner_identity`) or holds a `world_admission` row. Under `Allowlist` the
//! owner may join; an identity with a binding the build counts
//! (`world_binding::trusted_binding`) may join exactly while its bound account is on the
//! host's list, whatever else it holds; and an identity with no such binding may join when it
//! holds a `world_admission` row, so one the world admitted before gets in with no attestation
//! and a new one does not. The list is read at every check and nothing is stored from it.
//!
//! A change to `Allowlist` adds to the list the accounts of the players the rule in force let
//! in ([`set_world_access`]). Under `Open` and `Password` the list is kept and not read.
//!
//! The connect reducer refuses anyone the rule does not admit
//! ([`require_admitted_at_connect`]), which holds that identity off every table and every
//! reducer, and every reducer of the generated client roster that is not owner-only makes the
//! same check ([`require_admitted`]) before it reads or writes anything else, because the host
//! checks a connection only when it opens. The one exception is
//! `world_binding::unbind_world_account`, which makes no admission check, so an identity the
//! rule refuses can still erase its own binding over a connection already open. The binding
//! reducers of `world_binding.rs` answer their build's refusal first, which reads nothing. The
//! reducers that exist only in a dev build (`dev_reducers`, `load_test_zones`) are outside that
//! roster and make no check.
//!
//! An identity that is not admitted can call nothing but that unbind, so admission is granted
//! by reducers only the owner can call: [`set_world_access`] sets the rule and admits
//! identities outright, and under `Allowlist` the owner relays the joiner's bind
//! (`world_binding::bind_world_account_for`).
//!
//! No reducer of this module takes a password or a value derived from one, because the host's
//! commit log keeps every committed call's arguments in the clear. A `Password` world's password
//! is checked by the host gate (`docs/local-play.md` §3), which admits a joiner who gives it
//! through the owner's [`set_world_access`]; `world_access` holds the rule with an empty salt and
//! hash, and the module reads neither.
//!
//! WRITE-ISOLATION: this module alone writes `world_access` and `world_admission`, and deletes
//! `world_admission_attempt` rows (an identity's, when it is admitted or erased); an unbind and
//! the owner's drop of a binding delete an admission row through [`withdraw_admission`]. It
//! reads `config` for the owner,
//! reads a binding and the host's list and adds to that list through `crate::world_binding`, and,
//! when the rule changes, reads the live sessions through `crate::live_session_identities`.

use crate::guards::log_reject;
use crate::marshal::now_ms;
use crate::schema::{
    config, world_access, world_admission, world_admission_attempt, WorldAccess, WorldAccessRule,
    WorldAdmission,
};
use spacetimedb::{Identity, ReducerContext, Table};

/// The refusal an identity gets, at connect and from every reducer a player can call, while the
/// rule does not admit it.
pub(crate) const REJECT_NOT_ADMITTED: &str = "not admitted";
pub(crate) const REJECT_NOT_WORLD_OWNER: &str = "caller is not the world owner";

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

// --- Context-bound predicates and guards ---------------------------------------

/// [`effective_rule`] of the stored row.
pub(crate) fn rule_in_force(ctx: &ReducerContext) -> WorldAccessRule {
    effective_rule(ctx.db.world_access().id().find(WORLD_ACCESS_ROW).as_ref())
}

/// Whether `identity` is the world's owner. A world with no `config` row, or one whose owner
/// was never registered (the all-zero default), has no owner.
pub(crate) fn is_world_owner(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .config()
        .id()
        .find(CONFIG_ROW)
        .is_some_and(|cfg| cfg.owner_identity != Identity::ZERO && cfg.owner_identity == identity)
}

fn holds_admission(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db.world_admission().identity().find(identity).is_some()
}

/// Whether the host's rule lets `identity` in: always under `Open`; under `Password` only the
/// owner and an identity with a `world_admission` row; under `Allowlist` the owner, an
/// identity whose trusted binding names a listed account, and an identity with no trusted
/// binding that holds a `world_admission` row. A bound identity whose account is not listed
/// is refused even with an admission row: the list alone governs it, and its unbind or the
/// owner's drop takes the row with it (`world_binding::unbind_world_account`,
/// `world_binding::drop_world_binding`).
pub(crate) fn is_admitted(ctx: &ReducerContext, identity: Identity) -> bool {
    match rule_in_force(ctx) {
        WorldAccessRule::Open => true,
        WorldAccessRule::Password => {
            is_world_owner(ctx, identity) || holds_admission(ctx, identity)
        }
        WorldAccessRule::Allowlist => {
            is_world_owner(ctx, identity)
                || match crate::world_binding::trusted_binding(
                    ctx,
                    &crate::accounts::BUILD_PROFILE,
                    identity,
                ) {
                    Some(binding) => {
                        crate::world_binding::on_allowlist(ctx, &binding.account_subject)
                    }
                    None => holds_admission(ctx, identity),
                }
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

pub(crate) fn require_world_owner(ctx: &ReducerContext, reducer: &str) -> Result<(), String> {
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
/// keeps the row it has. Its wrong-password record, if an earlier module wrote one, goes.
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

/// Delete `identity`'s admission row, when it holds one, and nothing else. Called when
/// `world_binding.rs` erases a binding the build counts, for an unbind or the owner's drop.
pub(crate) fn withdraw_admission(ctx: &ReducerContext, identity: Identity) {
    if holds_admission(ctx, identity) {
        ctx.db.world_admission().identity().delete(identity);
    }
}

/// Erase what this module holds about `identity`: its admission and any wrong-password record an
/// earlier module wrote. The step for these two tables of the deletion cascade, and of a guest
/// claim for the guest identity it retires.
pub(crate) fn erase_admission(ctx: &ReducerContext, identity: Identity) {
    ctx.db.world_admission().identity().delete(identity);
    ctx.db.world_admission_attempt().identity().delete(identity);
}

// --- Reducers --------------------------------------------------------------------

/// Set the world's access rule and admit identities outright. Owner-only.
///
/// The rule is stored with an empty salt and hash under every rule, so a salt and hash an earlier
/// module stored go at the owner's next call. `Password` admits the owner and the identities
/// holding an admission row, and nothing else. When the rule changes to one that is not `Open`,
/// every identity with a live connection that the rule in force before the call admitted gets an
/// admission row, so a connection that rule let in stays admitted and one it refused (a
/// delisted account, a removed admission) is not let back in. Each identity in `admit` gets an
/// admission row under every rule: this is how the host admits its own player, and how the host
/// gate admits a joiner who gave the world's password; under `Allowlist` the row lets in only an
/// identity with no trusted binding. Admission rows outlive every rule change.
///
/// When the rule changes to `Allowlist`, the account of every binding the build counts whose
/// identity the rule in force before the call admitted is added to the host's list, beside
/// the accounts already there, so the identities bound to those accounts stay in, the owner's
/// among them. The `admit` argument adds no account. A list that would then hold more than
/// `world_binding::MAX_ALLOWLIST_ACCOUNTS` refuses the whole call with no write. Leaving
/// `Allowlist` neither reads nor writes the list.
#[spacetimedb::reducer]
pub fn set_world_access(
    ctx: &ReducerContext,
    rule: WorldAccessRule,
    admit: Vec<Identity>,
) -> Result<(), String> {
    require_world_owner(ctx, "set_world_access")?;
    let stored = ctx.db.world_access().id().find(WORLD_ACCESS_ROW);
    let was = effective_rule(stored.as_ref());
    // Read under the rule still in force: the row below replaces it.
    let carried_over: Vec<Identity> = if rule != WorldAccessRule::Open && rule != was {
        crate::live_session_identities(ctx)
            .into_iter()
            .filter(|&identity| !is_world_owner(ctx, identity) && is_admitted(ctx, identity))
            .collect()
    } else {
        Vec::new()
    };
    if rule == WorldAccessRule::Allowlist && rule != was {
        let seed = crate::world_binding::bound_accounts(
            ctx,
            &crate::accounts::BUILD_PROFILE,
            |identity| is_admitted(ctx, identity),
        );
        if let Err(reason) = crate::world_binding::add_to_allowlist(ctx, &seed) {
            return reject("set_world_access", ctx.sender(), reason);
        }
    }
    let row = WorldAccess {
        id: WORLD_ACCESS_ROW,
        rule,
        password_salt: Vec::new(),
        password_hash: Vec::new(),
    };
    if stored.is_some() {
        ctx.db.world_access().id().update(row);
    } else {
        ctx.db.world_access().insert(row);
    }
    let now = now_ms(ctx);
    for identity in carried_over {
        admit_identity(ctx, identity, now);
    }
    for identity in admit {
        admit_identity(ctx, identity, now);
    }
    Ok(())
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod access_tests;
