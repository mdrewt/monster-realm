//! `account_checks` — server-module domain submodule.
//!
//! A world asks our account service itself whether a player's account owns the game, through
//! three procedures, and keeps the answer in `world_account`.
//!
//! First contact: a client whose identity the world does not know gets a one-use ticket from
//! the account service (`POST /ticket`) and calls [`check_account`]. The world presents the
//! ticket, the names it answers to and its database identity at `POST /world/check`, and stores
//! what the service answers: the account's handle in this world and whether it owns the game.
//! An identity the access rule has not admitted cannot connect, so the world's owner relays its
//! ticket through [`check_account_for`]. Until a character can move between identities, a handle
//! another identity holds is refused, and so is a second account for an identity that holds one.
//!
//! Each later connection: the connect reducer arms a one-shot [`recheck_account`] run for an
//! identity whose row was last checked [`RECHECK_MIN_AGE_MS`] ago or more
//! ([`arm_recheck_at_connect`]). The run presents the stored handle and stores the answer. The
//! connection is admitted and entitled by the stored row the whole time, and a run that gets no
//! answer leaves it unchanged; the host spends the one-shot row after its one run, so nothing
//! asks again until the next connection.
//!
//! A build asks the account service its profile names (`BuildProfile::world_check_url`). A
//! build that names none checks no account: each procedure answers
//! [`REJECT_BUILD_CHECKS_NOTHING`] as its first statement, and [`account_entitled`] answers
//! `false` without reading.
//!
//! Every request carries a [`CHECK_TIMEOUT_MS`] timeout. Other transactions run while a
//! request waits, and a transaction's body may run twice, so the transaction that stores an
//! answer reads again every row it decides on, and a body logs nothing: a refusal is logged
//! once, outside any transaction. No log line, table or return value holds a ticket, and no
//! log line or return value holds a handle.
//!
//! WRITE-ISOLATION: this module alone declares and writes `world_account`,
//! `world_check_budget` and `recheck_schedule`. Its procedures write nothing else but
//! `world_allowlist`, through `crate::world_binding`: the owner's own handle under the
//! `Allowlist` rule, and a handle the service answered under a newer key. They read the owner,
//! the rule and the admission through `crate::access`, the world's names through
//! `crate::world_binding` and the deletion state through `crate::accounts`.

use crate::accounts::{BuildProfile, BUILD_PROFILE};
use crate::guards::log_reject;
use crate::marshal::now_ms;
use crate::schema::WorldAccessRule;
use crate::world_binding::is_visible_ascii;
use serde::{Deserialize, Serialize};
use spacetimedb::http::{Request, Timeout};
use spacetimedb::{Identity, ProcedureContext, ReducerContext, ScheduleAt, Table, TimeDuration};

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
/// The service answered `403`: the ticket is unknown, spent or expired, or names another world.
/// Also the refusal of an answer whose name this world does not answer to when it lands.
pub(crate) const REJECT_TICKET_REFUSED: &str = "the account service refused the ticket";
/// No usable answer: the request failed or timed out, the status was neither `200` nor a
/// ticket's `403`, or the body is not the answer's shape.
pub(crate) const REJECT_CHECK_UNANSWERED: &str = "the account service gave no answer";
pub(crate) const REJECT_HANDLE_HELD: &str =
    "this account already plays here under another identity";
pub(crate) const REJECT_IDENTITY_HOLDS_ANOTHER: &str =
    "this identity already holds another account here";
pub(crate) const REJECT_NOT_DATABASE: &str = "only the database runs this check";

const BUDGET_ROW: u32 = 0;
const STATUS_OK: u16 = 200;
const STATUS_FORBIDDEN: u16 = 403;

/// The account an identity of this world plays under, as the account service last answered:
/// the account's handle in this world and whether it owns the game. PRIVATE; an identity reads
/// its own row through `my_world_account`. `is_host` marks the row of the identity the host
/// plays as; nothing here sets it.
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
    ctx.db.world_account().identity().find(ctx.sender())
}

// --- Pure core --------------------------------------------------------------------------

/// Whether `text` is [`TICKET_LEN`] characters of the base64url alphabet.
fn is_ticket(text: &str) -> bool {
    text.len() == TICKET_LEN
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The start of the budget minute `now_ms` falls in.
fn budget_minute(now_ms: i64) -> i64 {
    now_ms - now_ms.rem_euclid(BUDGET_WINDOW_MS)
}

/// The redeems `row` counts for the minute that starts at `minute_start_ms`: none when it
/// counts another minute.
fn redeems_in(row: Option<&WorldCheckBudget>, minute_start_ms: i64) -> u32 {
    row.filter(|row| row.minute_start_ms == minute_start_ms)
        .map_or(0, |row| row.redeems)
}

/// Whether a row last checked at `checked_at_ms` is due a re-check at `now_ms`.
fn recheck_due(checked_at_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(checked_at_ms) >= RECHECK_MIN_AGE_MS
}

/// The body that redeems a ticket.
#[derive(Serialize)]
struct TicketCheck<'a> {
    ticket: &'a str,
    names: &'a [String],
    world: &'a str,
}

/// The body that asks about an account the world already knows.
#[derive(Serialize)]
struct HandleCheck<'a> {
    handle: &'a str,
    world: &'a str,
}

/// What the service answers a redeemed ticket. A member of another type or a repeated member is
/// an error; every other member is ignored.
#[derive(Deserialize)]
struct TicketAnswer {
    handle: String,
    entitled: bool,
    name: String,
}

/// What the service answers a handle. It names no handle when it does not know the one asked
/// about.
#[derive(Deserialize)]
struct HandleAnswer {
    handle: Option<String>,
    entitled: bool,
}

/// A JSON object read into `T`. A derived reader also accepts an array, filling fields by
/// position, so anything but an object is refused first.
fn parse_answer<'a, T: Deserialize<'a>>(body: &'a [u8]) -> Option<T> {
    let opens_an_object = body
        .iter()
        .find(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        == Some(&b'{');
    if !opens_an_object {
        return None;
    }
    serde_json::from_slice(body).ok()
}

fn is_handle(text: &str) -> bool {
    is_visible_ascii(text, HANDLE_MAX_BYTES)
}

/// A redeemed ticket's answer, when its handle is one.
fn parse_ticket_answer(body: &[u8]) -> Option<TicketAnswer> {
    let answer: TicketAnswer = parse_answer(body)?;
    is_handle(&answer.handle).then_some(answer)
}

/// A handle's answer, when the handle it names, if any, is one.
fn parse_handle_answer(body: &[u8]) -> Option<HandleAnswer> {
    let answer: HandleAnswer = parse_answer(body)?;
    match answer.handle.as_deref() {
        Some(handle) if !is_handle(handle) => None,
        _ => Some(answer),
    }
}

// --- Context-bound reads ----------------------------------------------------------------

/// `identity`'s row, on any build.
pub(crate) fn account_of(ctx: &ReducerContext, identity: Identity) -> Option<WorldAccount> {
    ctx.db.world_account().identity().find(identity)
}

/// Whether `identity`'s row says its account owns the game. A build of a `profile` that names
/// no account service answers `false` without reading.
pub(crate) fn account_entitled(
    ctx: &ReducerContext,
    profile: &BuildProfile,
    identity: Identity,
) -> bool {
    profile.world_check_url.is_some() && account_of(ctx, identity).is_some_and(|row| row.entitled)
}

/// The handle of every row whose identity `admits` accepts, in ascending byte order.
pub(crate) fn admitted_handles(
    ctx: &ReducerContext,
    admits: impl Fn(Identity) -> bool,
) -> Vec<String> {
    let mut handles: Vec<String> = ctx
        .db
        .world_account()
        .iter()
        .filter(|row| admits(row.identity))
        .map(|row| row.handle)
        .collect();
    handles.sort_unstable();
    handles
}

// --- Writes -----------------------------------------------------------------------------

/// Erase what this module holds about `identity`: its row and its armed re-check. Answers
/// whether a `world_account` row went. The step for these two tables of the deletion cascade,
/// of a guest claim for the guest identity it retires, of an unbind and of the owner's drop.
pub(crate) fn erase_world_account(ctx: &ReducerContext, identity: Identity) -> bool {
    if ctx
        .db
        .recheck_schedule()
        .identity()
        .find(identity)
        .is_some()
    {
        ctx.db.recheck_schedule().identity().delete(identity);
    }
    if account_of(ctx, identity).is_none() {
        return false;
    }
    ctx.db.world_account().identity().delete(identity);
    true
}

/// Arm one re-check of the connecting identity's account, when the build of `profile` names an
/// account service, the identity holds a row last checked [`RECHECK_MIN_AGE_MS`] ago or more,
/// and none is armed. Writes nothing otherwise.
pub(crate) fn arm_recheck_at_connect(ctx: &ReducerContext, profile: &BuildProfile) {
    if profile.world_check_url.is_none() {
        return;
    }
    let who = ctx.sender();
    let Some(account) = account_of(ctx, who) else {
        return;
    };
    if !recheck_due(account.checked_at_ms, now_ms(ctx)) {
        return;
    }
    if ctx.db.recheck_schedule().identity().find(who).is_some() {
        return;
    }
    ctx.db.recheck_schedule().insert(RecheckSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(ctx.timestamp),
        identity: who,
    });
}

/// Count one ticket redeem in the current minute. A caller's own check is refused once the
/// minute holds [`FIRST_CONTACT_BUDGET`]; the owner's relay is counted and never refused, so a
/// world whose budget strangers spend can still check in whoever its host chooses.
fn charge_budget(tx: &ReducerContext, relayed: bool) -> Result<(), &'static str> {
    let minute_start_ms = budget_minute(now_ms(tx));
    let stored = tx.db.world_check_budget().id().find(BUDGET_ROW);
    let spent = redeems_in(stored.as_ref(), minute_start_ms);
    if !relayed && spent >= FIRST_CONTACT_BUDGET {
        return Err(REJECT_CHECK_BUDGET);
    }
    let row = WorldCheckBudget {
        id: BUDGET_ROW,
        minute_start_ms,
        redeems: spent.saturating_add(1),
    };
    if stored.is_some() {
        tx.db.world_check_budget().id().update(row);
    } else {
        tx.db.world_check_budget().insert(row);
    }
    Ok(())
}

/// Who may have `who`'s ticket redeemed: for the owner's relay the caller is the world's
/// owner; otherwise the rule admits `who`, the caller. Either way `who`'s account is not
/// pending deletion. Read before the request is sent and again before its answer is stored.
fn redeem_gates(tx: &ReducerContext, who: Identity, relayed: bool) -> Result<(), &'static str> {
    if relayed {
        if !crate::access::is_world_owner(tx, tx.sender()) {
            return Err(crate::access::REJECT_NOT_WORLD_OWNER);
        }
    } else if !crate::access::is_admitted(tx, who) {
        return Err(crate::access::REJECT_NOT_ADMITTED);
    }
    crate::guards::deletion_gate(crate::accounts::is_pending_deletion(tx, who))
}

/// The transaction before a redeem is sent: the gates, then the names the world presents,
/// then the budget, charged last so a refusal spends none of it.
fn prepare_redeem(
    tx: &ReducerContext,
    who: Identity,
    relayed: bool,
) -> Result<Vec<String>, &'static str> {
    redeem_gates(tx, who, relayed)?;
    let names = crate::world_binding::world_names(tx);
    if names.is_empty() {
        return Err(REJECT_WORLD_UNNAMED);
    }
    charge_budget(tx, relayed)?;
    Ok(names)
}

/// The transaction that stores a redeemed ticket's answer for `who`, deciding from the rows as
/// they are now. Refused with no write: a gate that fails now; an answered name this world does
/// not answer to now; a handle another identity holds; `who` holding another handle; and, when
/// `who` is the world's owner under `Allowlist`, a full list that lacks the handle. Otherwise
/// `who`'s row holds the answer, and the owner's handle is on the list under `Allowlist`.
fn store_redeem(
    tx: &ReducerContext,
    who: Identity,
    relayed: bool,
    answer: &TicketAnswer,
) -> Result<bool, &'static str> {
    redeem_gates(tx, who, relayed)?;
    if !crate::world_binding::is_world_name(tx, &answer.name) {
        return Err(REJECT_TICKET_REFUSED);
    }
    let holder = tx.db.world_account().handle().find(answer.handle.clone());
    if holder.is_some_and(|row| row.identity != who) {
        return Err(REJECT_HANDLE_HELD);
    }
    let own = account_of(tx, who);
    if own.as_ref().is_some_and(|row| row.handle != answer.handle) {
        return Err(REJECT_IDENTITY_HOLDS_ANOTHER);
    }
    if crate::access::is_world_owner(tx, who)
        && crate::access::rule_in_force(tx) == WorldAccessRule::Allowlist
    {
        crate::world_binding::add_to_allowlist(tx, std::slice::from_ref(&answer.handle))?;
    }
    let checked_at_ms = now_ms(tx);
    match own {
        Some(row) => {
            tx.db.world_account().handle().update(WorldAccount {
                entitled: answer.entitled,
                checked_at_ms,
                ..row
            });
        }
        None => {
            tx.db.world_account().insert(WorldAccount {
                handle: answer.handle.clone(),
                identity: who,
                entitled: answer.entitled,
                checked_at_ms,
                is_host: false,
            });
        }
    }
    Ok(answer.entitled)
}

/// The transaction that stores a re-check's answer about `asked`, the row as it stood when the
/// request was sent. A row that is gone or holds another handle or check time is left alone: an
/// unbind, a newer check or another re-check landed during the wait, and an older answer never
/// overwrites a newer one. An answer that names no handle stores not entitled. An answer under
/// another handle replaces the row and its entry on the host's list, unless another identity
/// holds that handle: the standing is then stored on the row as it is.
fn store_recheck(tx: &ReducerContext, asked: &WorldAccount, answer: &HandleAnswer) {
    let Some(row) = account_of(tx, asked.identity) else {
        return;
    };
    if row.handle != asked.handle || row.checked_at_ms != asked.checked_at_ms {
        return;
    }
    let checked_at_ms = now_ms(tx);
    let Some(answered) = answer.handle.as_ref() else {
        tx.db.world_account().handle().update(WorldAccount {
            entitled: false,
            checked_at_ms,
            ..row
        });
        return;
    };
    let entitled = answer.entitled;
    let moves = *answered != row.handle
        && tx
            .db
            .world_account()
            .handle()
            .find(answered.clone())
            .is_none();
    if !moves {
        tx.db.world_account().handle().update(WorldAccount {
            entitled,
            checked_at_ms,
            ..row
        });
        return;
    }
    tx.db.world_account().handle().delete(row.handle.clone());
    crate::world_binding::replace_on_allowlist(tx, &row.handle, answered);
    tx.db.world_account().insert(WorldAccount {
        handle: answered.clone(),
        entitled,
        checked_at_ms,
        ..row
    });
}

// --- The account service ----------------------------------------------------------------

/// `POST` a JSON `body` to `url` under the check timeout. Answers the status and the body's
/// bytes, or `None` when the request could not be built or got no response.
fn post_json(ctx: &ProcedureContext, url: &str, body: Vec<u8>) -> Option<(u16, Vec<u8>)> {
    let timeout = Timeout::from(TimeDuration::from_micros(CHECK_TIMEOUT_MS * 1000));
    let request = Request::builder()
        .method("POST")
        .uri(url)
        .header("content-type", "application/json")
        .extension(timeout)
        .body(body)
        .ok()?;
    let response = ctx.http.send(request).ok()?;
    let (parts, body) = response.into_parts();
    Some((parts.status.as_u16(), body.into_bytes().to_vec()))
}

/// The world's database identity as the account service takes it: 64 lower-case hex digits.
fn world_of(ctx: &ProcedureContext) -> String {
    ctx.database_identity().to_hex().to_string()
}

/// Log a refusal and return it. The reason is always a constant of this crate.
fn refuse<T>(procedure: &str, sender: Identity, reason: &str) -> Result<T, String> {
    log_reject(procedure, sender, reason);
    Err(reason.to_string())
}

/// Redeem `ticket` for `who` at `url` and store the answer: the body of both first-contact
/// procedures, whose refusals and order the module comment and `store_redeem` give.
fn redeem(
    ctx: &mut ProcedureContext,
    url: &str,
    who: Identity,
    relayed: bool,
    ticket: &str,
    procedure: &str,
) -> Result<bool, String> {
    let sender = ctx.sender();
    if !is_ticket(ticket) {
        return refuse(procedure, sender, REJECT_TICKET_MALFORMED);
    }
    let names = match ctx.try_with_tx(|tx| prepare_redeem(tx, who, relayed)) {
        Ok(names) => names,
        Err(reason) => return refuse(procedure, sender, reason),
    };
    let world = world_of(ctx);
    let Ok(body) = serde_json::to_vec(&TicketCheck {
        ticket,
        names: &names,
        world: &world,
    }) else {
        return refuse(procedure, sender, REJECT_CHECK_UNANSWERED);
    };
    let answer = match post_json(ctx, url, body) {
        Some((STATUS_OK, bytes)) => parse_ticket_answer(&bytes),
        Some((STATUS_FORBIDDEN, _)) => return refuse(procedure, sender, REJECT_TICKET_REFUSED),
        _ => None,
    };
    let Some(answer) = answer else {
        return refuse(procedure, sender, REJECT_CHECK_UNANSWERED);
    };
    match ctx.try_with_tx(|tx| store_redeem(tx, who, relayed, &answer)) {
        Ok(entitled) => Ok(entitled),
        Err(reason) => refuse(procedure, sender, reason),
    }
}

// --- Procedures -------------------------------------------------------------------------

/// [`check_account`] as a build of `profile` runs it.
pub(crate) fn check_account_under(
    ctx: &mut ProcedureContext,
    profile: &BuildProfile,
    ticket: &str,
) -> Result<bool, String> {
    let Some(url) = profile.world_check_url else {
        return refuse("check_account", ctx.sender(), REJECT_BUILD_CHECKS_NOTHING);
    };
    let who = ctx.sender();
    redeem(ctx, url, who, false, ticket, "check_account")
}

/// [`check_account_for`] as a build of `profile` runs it.
pub(crate) fn check_account_for_under(
    ctx: &mut ProcedureContext,
    profile: &BuildProfile,
    who: Identity,
    ticket: &str,
) -> Result<bool, String> {
    let Some(url) = profile.world_check_url else {
        return refuse(
            "check_account_for",
            ctx.sender(),
            REJECT_BUILD_CHECKS_NOTHING,
        );
    };
    redeem(ctx, url, who, true, ticket, "check_account_for")
}

/// [`recheck_account`] as a build of `profile` runs it.
pub(crate) fn recheck_account_under(
    ctx: &mut ProcedureContext,
    profile: &BuildProfile,
    row: RecheckSchedule,
) -> Result<(), String> {
    const PROCEDURE: &str = "recheck_account";
    let Some(url) = profile.world_check_url else {
        return refuse(PROCEDURE, ctx.sender(), REJECT_BUILD_CHECKS_NOTHING);
    };
    if ctx.sender() != ctx.database_identity() {
        return refuse(PROCEDURE, ctx.sender(), REJECT_NOT_DATABASE);
    }
    let Some(asked) = ctx.with_tx(|tx| account_of(tx, row.identity)) else {
        return Ok(());
    };
    let world = world_of(ctx);
    let Ok(body) = serde_json::to_vec(&HandleCheck {
        handle: &asked.handle,
        world: &world,
    }) else {
        return refuse(PROCEDURE, ctx.sender(), REJECT_CHECK_UNANSWERED);
    };
    let answer = match post_json(ctx, url, body) {
        Some((STATUS_OK, bytes)) => parse_handle_answer(&bytes),
        _ => None,
    };
    let Some(answer) = answer else {
        return refuse(PROCEDURE, ctx.sender(), REJECT_CHECK_UNANSWERED);
    };
    ctx.with_tx(|tx| store_recheck(tx, &asked, &answer));
    Ok(())
}

/// Check the caller's account by a ticket the account service issued it for this world, and
/// store the answer. `Ok` carries whether the account owns the game; a refusal is an `Err` with
/// one of this module's constants, `access::REJECT_NOT_ADMITTED`, the deletion gate's reason or
/// `world_binding::REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS`.
#[spacetimedb::procedure]
pub fn check_account(ctx: &mut ProcedureContext, ticket: String) -> Result<bool, String> {
    check_account_under(ctx, &BUILD_PROFILE, &ticket)
}

/// [`check_account`] for `who`, relayed by the world's owner: an identity the access rule has
/// not admitted cannot connect, so the owner presents its ticket. Anyone else is refused with
/// `access::REJECT_NOT_WORLD_OWNER` before anything is sent.
#[spacetimedb::procedure]
pub fn check_account_for(
    ctx: &mut ProcedureContext,
    who: Identity,
    ticket: String,
) -> Result<bool, String> {
    check_account_for_under(ctx, &BUILD_PROFILE, who, &ticket)
}

/// Ask the account service again about the account `row.identity` holds, and store the answer.
/// Run by the host from a `recheck_schedule` row; any other caller is refused with
/// [`REJECT_NOT_DATABASE`] before anything is sent.
#[spacetimedb::procedure]
pub fn recheck_account(ctx: &mut ProcedureContext, row: RecheckSchedule) -> Result<(), String> {
    recheck_account_under(ctx, &BUILD_PROFILE, row)
}

#[cfg(test)]
#[path = "account_checks_tests.rs"]
mod account_checks_tests;
