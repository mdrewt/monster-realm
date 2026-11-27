//! `account_checks` — server-module domain submodule.
//!
//! WRITE-ISOLATION: this module alone declares and writes `world_account`,
//! `world_check_budget` and `recheck_schedule`.

use crate::accounts::{BuildProfile, BUILD_PROFILE};
use spacetimedb::{Identity, ProcedureContext, ReducerContext, ScheduleAt};

/// A ticket is this many base64url characters: 32 random bytes, unpadded.
pub(crate) const TICKET_LEN: usize = 43;
/// The ticket redeems a world sends in one minute before `check_account` refuses.
pub(crate) const FIRST_CONTACT_BUDGET: u32 = 30;
pub(crate) const BUDGET_WINDOW_MS: i64 = 60_000;
/// How long a request to the account service may take.
pub(crate) const CHECK_TIMEOUT_MS: i64 = 3_000;
/// A connection arms a re-check only for a row checked at least this long ago.
pub(crate) const RECHECK_MIN_AGE_MS: i64 = 10 * 60 * 1000;
/// The account service's bound on a handle.
pub(crate) const HANDLE_MAX_BYTES: usize = 1024;

pub(crate) const REJECT_BUILD_CHECKS_NOTHING: &str = "this server checks no account";
pub(crate) const REJECT_TICKET_MALFORMED: &str = "a ticket is 43 base64url characters";
pub(crate) const REJECT_CHECK_BUDGET: &str =
    "too many account checks this minute; try again shortly";
pub(crate) const REJECT_WORLD_UNNAMED: &str = "this world has no name to check an account under";
pub(crate) const REJECT_TICKET_REFUSED: &str = "the account service refused the ticket";
pub(crate) const REJECT_CHECK_UNANSWERED: &str = "the account service gave no answer";
pub(crate) const REJECT_HANDLE_HELD: &str =
    "this account already plays here under another identity";
pub(crate) const REJECT_IDENTITY_HOLDS_ANOTHER: &str =
    "this identity already holds another account here";
pub(crate) const REJECT_NOT_DATABASE: &str = "only the database runs this check";

/// The account an identity of this world plays under, as the account service last answered:
/// the account's handle in this world and whether it owns the game. PRIVATE; an identity reads
/// its own row through `my_world_account`.
#[spacetimedb::table(accessor = world_account)]
pub struct WorldAccount {
    #[primary_key]
    pub handle: String,
    #[unique]
    pub identity: Identity,
    pub entitled: bool,
    pub checked_at_ms: i64,
    pub is_host: bool,
}

/// The ticket redeems this world sent in the minute that starts at `minute_start_ms`: one row,
/// `id` always 0. PRIVATE.
#[spacetimedb::table(accessor = world_check_budget)]
pub struct WorldCheckBudget {
    #[primary_key]
    pub id: u32,
    pub minute_start_ms: i64,
    pub redeems: u32,
}

/// One armed re-check of an identity's account: a one-shot row the host spends when it runs
/// `recheck_account`. PRIVATE.
#[spacetimedb::table(accessor = recheck_schedule, scheduled(recheck_account))]
pub struct RecheckSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[unique]
    pub identity: Identity,
}

/// Owner-scoped read path for `world_account`: the sender's own row.
#[spacetimedb::view(accessor = my_world_account, public)]
fn my_world_account(ctx: &spacetimedb::ViewContext) -> Option<WorldAccount> {
    let _ = ctx;
    None
}

const NOT_BUILT: &str = "account checks are not built";

pub(crate) fn account_of(ctx: &ReducerContext, identity: Identity) -> Option<WorldAccount> {
    let _ = (ctx, identity);
    None
}

pub(crate) fn account_entitled(
    ctx: &ReducerContext,
    profile: &BuildProfile,
    identity: Identity,
) -> bool {
    let _ = (ctx, profile, identity);
    false
}

pub(crate) fn admitted_handles(
    ctx: &ReducerContext,
    admits: impl Fn(Identity) -> bool,
) -> Vec<String> {
    let _ = (ctx, admits);
    Vec::new()
}

pub(crate) fn erase_world_account(ctx: &ReducerContext, identity: Identity) -> bool {
    let _ = (ctx, identity);
    false
}

pub(crate) fn arm_recheck_at_connect(ctx: &ReducerContext, profile: &BuildProfile) {
    let _ = (ctx, profile);
}

pub(crate) fn check_account_under(
    ctx: &mut ProcedureContext,
    profile: &BuildProfile,
    ticket: &str,
) -> Result<bool, String> {
    let _ = (ctx, profile, ticket);
    Err(NOT_BUILT.to_string())
}

pub(crate) fn check_account_for_under(
    ctx: &mut ProcedureContext,
    profile: &BuildProfile,
    who: Identity,
    ticket: &str,
) -> Result<bool, String> {
    let _ = (ctx, profile, who, ticket);
    Err(NOT_BUILT.to_string())
}

pub(crate) fn recheck_account_under(
    ctx: &mut ProcedureContext,
    profile: &BuildProfile,
    row: RecheckSchedule,
) -> Result<(), String> {
    let _ = (ctx, profile, row);
    Err(NOT_BUILT.to_string())
}

#[spacetimedb::procedure]
pub fn check_account(ctx: &mut ProcedureContext, ticket: String) -> Result<bool, String> {
    check_account_under(ctx, &BUILD_PROFILE, &ticket)
}

#[spacetimedb::procedure]
pub fn check_account_for(
    ctx: &mut ProcedureContext,
    who: Identity,
    ticket: String,
) -> Result<bool, String> {
    check_account_for_under(ctx, &BUILD_PROFILE, who, &ticket)
}

#[spacetimedb::procedure]
pub fn recheck_account(ctx: &mut ProcedureContext, row: RecheckSchedule) -> Result<(), String> {
    recheck_account_under(ctx, &BUILD_PROFILE, row)
}

#[cfg(test)]
#[path = "account_checks_tests.rs"]
mod account_checks_tests;
