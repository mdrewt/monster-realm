//! `account_checks` — server-module domain submodule.
//!
//! A world asks our account service itself whether a player's account owns the game, through
//! four procedures, and keeps the answer in `world_account`. An account plays one character
//! in a world, whatever the client: a check under a handle another identity holds moves that
//! character to the caller.
//!
//! First contact: a client whose identity the world does not know gets a one-use ticket from
//! the account service (`POST /ticket`) and calls [`check_account`]. The world presents the
//! ticket, its names ([`name_presented`]) and its database identity at `POST /world/check`, and
//! stores what the service answers: the account's handle in this world and whether it owns the
//! game.
//! An identity the access rule has not admitted cannot connect, so the world's owner relays its
//! ticket through [`check_account_for`]. A second account for an identity that holds one is
//! refused. A handle another identity holds is the same account at another client: its character
//! moves to the identity the ticket is redeemed for (`accounts::move_character`), the handle's row
//! points at it, and `world_move` records the identity the character left, which reads its own
//! row through `my_world_move` and is refused `join_game` until it checks in again. The move
//! runs only through a ticket whose name can carry one ([`name_carries_move`]) and is refused
//! while the caller owns a character or [`move_gates`] refuses.
//!
//! Each later connection: the connect reducer arms a one-shot [`recheck_account`] run for an
//! identity whose row was last checked [`RECHECK_MIN_AGE_MS`] ago or more
//! ([`arm_recheck_at_connect`]), and stamps the row's `checked_at_ms` as it arms, so the world
//! asks about one identity at most once in that time however often it connects and whatever the
//! run does. The run presents the stored handle and stores the answer. The connection is
//! admitted and entitled by the stored row the whole time, and a run that gets no answer leaves
//! whether the account owns the game unchanged; the host spends the one-shot row at its one run.
//!
//! The host's own check: the world's owner names the identity the host plays as
//! ([`set_host_identity`]), which marks that identity's row and arms one row of
//! `host_check_schedule`. The row ticks [`host_account_check`] every
//! [`HOST_CHECK_INTERVAL_MS`], and a tick asks about the marked row's handle, and no other,
//! once the last success is [`HOST_CHECK_MIN_AGE_MS`] old, and never while the marked account
//! is pending deletion. A world nobody reconnects to so learns within about a day whether its
//! host's account owns the game, and what address it is reached at. A tick that gets no answer
//! writes nothing and the next one asks again.
//!
//! The world's address: every answer reports the address the service saw the request leave
//! from, and the world stores it in `world_egress`, one row per address family. A world asks
//! over the family its `ip:` names are in ([`asked_family`], [`check_url`]). It presents an
//! `ip:` name in a redeem only while no address of that family is stored or the stored one is
//! the name's own and under [`EGRESS_MAX_AGE_MS`] old, and a ticket through an `ip:` name
//! carries a move only while the stored address confirms the name ([`ip_name_confirmed`]). An
//! address can change hands, and a name that went on being presented would vouch for another
//! host's world. A change of the world's names has the host's own check ask at its next tick
//! ([`names_changed`]).
//!
//! A build asks the account service its profile names (`BuildProfile::world_check_url`). A
//! build that names none checks no account: each procedure answers
//! [`REJECT_BUILD_CHECKS_NOTHING`] as its first statement, [`set_host_identity`] answers it to
//! the owner, and [`account_entitled`] answers `false` without reading.
//!
//! Every request carries a [`CHECK_TIMEOUT_MS`] timeout. Other transactions run while a
//! request waits, and a transaction's body may run twice, so the transaction that stores an
//! answer reads again every row it decides on, and a body logs nothing: a refusal is logged
//! once, outside any transaction. No log line, table or return value holds a ticket, and no
//! log line or return value holds a handle.
//!
//! WRITE-ISOLATION: this module alone declares and writes `world_account`,
//! `world_check_budget`, `recheck_schedule`, `world_move`, `world_egress` and
//! `host_check_schedule`. Its procedures write three things else, each through the owning
//! module: `world_allowlist` through `crate::world_binding` (the owner's own handle under the
//! `Allowlist` rule, and a handle the service answered under a newer key), the tables of a
//! character through `crate::accounts::move_character`, and an admission row a move would
//! otherwise bring back into force through `crate::access`. They read the owner, the rule and
//! the admission through `crate::access`, the world's names through `crate::world_binding`, and
//! the deletion state and what an identity owns through `crate::accounts`.
//! `crate::world_binding` writes `host_check_schedule` only through [`names_changed`].

use crate::accounts::{BuildProfile, BUILD_PROFILE};
use crate::guards::log_reject;
use crate::marshal::now_ms;
use crate::schema::WorldAccessRule;
use crate::world_binding::is_visible_ascii;
use serde::{Deserialize, Serialize};
use spacetimedb::http::{Request, Timeout};
use spacetimedb::{Identity, ProcedureContext, ReducerContext, ScheduleAt, Table, TimeDuration};
use std::net::IpAddr;

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
/// The world presents no name in a redeem: it has none, or each one it has is an `ip:` name the
/// address rule withholds ([`name_presented`]).
pub(crate) const REJECT_WORLD_UNNAMED: &str = "this world has no name to check an account under";
/// The service answered `403`: the ticket is unknown, spent or expired, or names another world.
/// Also the refusal of an answer whose name this world does not present when it lands.
pub(crate) const REJECT_TICKET_REFUSED: &str = "the account service refused the ticket";
/// No usable answer: the request failed or timed out, the status was neither `200` nor a
/// ticket's `403`, or the body is not the answer's shape.
pub(crate) const REJECT_CHECK_UNANSWERED: &str = "the account service gave no answer";
pub(crate) const REJECT_HANDLE_HELD: &str =
    "this account already plays here under another identity";
pub(crate) const REJECT_IDENTITY_HOLDS_ANOTHER: &str =
    "this identity already holds another account here";
pub(crate) const REJECT_NOT_DATABASE: &str = "only the database runs this check";
pub(crate) const REJECT_CALLER_OWNS_CHARACTER: &str =
    "this identity already plays a character here";
pub(crate) const REJECT_MOVE_NOT_NOW: &str = "this character cannot change clients right now";
pub(crate) const REJECT_MOVE_FAILED: &str = "the character could not be moved";
pub(crate) const REJECT_CHARACTER_MOVED: &str =
    "this character is playing on another client; sign in again to play here";
pub(crate) const REJECT_NO_HOST_ACCOUNT: &str = "that identity holds no account here";

/// How often the host's own check ticks.
pub(crate) const HOST_CHECK_INTERVAL_MS: i64 = 60 * 60 * 1000;
/// The host's own check asks once its last success is this old.
pub(crate) const HOST_CHECK_MIN_AGE_MS: i64 = 23 * 60 * 60 * 1000;
/// A stored address vouches for an `ip:` name for this long after it was confirmed.
pub(crate) const EGRESS_MAX_AGE_MS: i64 = 25 * 60 * 60 * 1000;

const BUDGET_ROW: u32 = 0;
const STATUS_OK: u16 = 200;
/// What a world name that names an address starts with.
const IP_NAME_PREFIX: &str = "ip:";
/// The `family` of a `world_egress` row that holds an IPv4 address, and of one that holds an
/// IPv6 address.
const FAMILY_V4: u8 = 4;
const FAMILY_V6: u8 = 6;
const STATUS_FORBIDDEN: u16 = 403;

/// The account an identity of this world plays under, as the account service last answered:
/// the account's handle in this world and whether it owns the game. `checked_at_ms` is when the
/// world last asked about the row: the time of the last answer stored, or of the last re-check
/// armed. PRIVATE; an identity reads its own row through `my_world_account`. `is_host` marks the
/// row of the identity the host plays as: [`set_host_identity`] sets it, on one row at most, and
/// the row keeps it through a newer handle and a move to another identity.
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

/// The identity a character left for another client, and when. PRIVATE; an identity reads its
/// own row through `my_world_move`. The identity's next successful check deletes the row.
#[spacetimedb::table(accessor = world_move)]
pub struct WorldMove {
    #[primary_key]
    pub identity: Identity,
    pub moved_at_ms: i64,
}

/// The address the account service last saw this world's requests leave from, one row per
/// address family: `family` is 4 or 6, `address` that family's address in its one spelling.
/// PRIVATE.
#[spacetimedb::table(accessor = world_egress)]
pub struct WorldEgress {
    #[primary_key]
    pub family: u8,
    pub address: String,
    pub confirmed_at_ms: i64,
}

/// The tick of the host's own check: one interval row, and when that check last succeeded.
/// PRIVATE.
#[spacetimedb::table(accessor = host_check_schedule, scheduled(host_account_check))]
pub struct HostCheckSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub last_success_ms: Option<i64>,
}

/// Owner-scoped read path for `world_account`: the sender's own row.
#[spacetimedb::view(accessor = my_world_account, public)]
fn my_world_account(ctx: &spacetimedb::ViewContext) -> Option<WorldAccount> {
    ctx.db.world_account().identity().find(ctx.sender())
}

/// Owner-scoped read path for `world_move`: the sender's own row.
#[spacetimedb::view(accessor = my_world_move, public)]
fn my_world_move(ctx: &spacetimedb::ViewContext) -> Option<WorldMove> {
    ctx.db.world_move().identity().find(ctx.sender())
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
    address: Option<String>,
}

/// What the service answers a handle. It names no handle when it does not know the one asked
/// about.
#[derive(Deserialize)]
struct HandleAnswer {
    handle: Option<String>,
    entitled: bool,
    address: Option<String>,
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

/// Whether a ticket issued for the world name `name` may carry a character from one identity
/// to another: a `spki:` name, a `dns:` name, or an `ip:` name when `ip_confirmed` says the
/// world has confirmed it as its address. An address can change hands while its name is still
/// presented, and a ticket through it would carry the character to the address's new holder.
fn name_carries_move(name: &str, ip_confirmed: bool) -> bool {
    name.starts_with("spki:")
        || name.starts_with("dns:")
        || (ip_confirmed && name.starts_with(IP_NAME_PREFIX))
}

/// Whether the host's own check asks at `now_ms`, given when it last succeeded: with no success
/// yet, once the last is [`HOST_CHECK_MIN_AGE_MS`] old, and when the last lies after `now_ms`,
/// so a clock that stepped back asks again.
fn host_check_due(last_success_ms: Option<i64>, now_ms: i64) -> bool {
    last_success_ms
        .is_none_or(|last| now_ms < last || now_ms.saturating_sub(last) >= HOST_CHECK_MIN_AGE_MS)
}

/// `text` as an address, an IPv4-mapped IPv6 address read as the IPv4 address it carries. A
/// zone, brackets or a port make `text` no address.
fn parse_address(text: &str) -> Option<IpAddr> {
    text.parse::<IpAddr>()
        .ok()
        .map(|address| address.to_canonical())
}

/// The `family` a `world_egress` row holds `address` under.
fn family_of(address: IpAddr) -> u8 {
    if address.is_ipv4() {
        FAMILY_V4
    } else {
        FAMILY_V6
    }
}

/// The address an `ip:` name carries: after `ip:`, an IPv6 address between brackets, or an IPv4
/// address up to the first `:` or `/`. What follows the address is not read, and an IPv4-mapped
/// IPv6 address is the IPv4 address it carries. Every other name carries none.
fn ip_name_address(name: &str) -> Option<IpAddr> {
    let rest = name.strip_prefix(IP_NAME_PREFIX)?;
    let address = match rest.strip_prefix('[') {
        Some(bracketed) => IpAddr::V6(bracketed.split_once(']')?.0.parse().ok()?),
        None => IpAddr::V4(rest.split([':', '/']).next()?.parse().ok()?),
    };
    Some(address.to_canonical())
}

/// The address family a world named `names` asks the account service over: IPv4 when an `ip:`
/// name carries an IPv4 address, otherwise IPv6 when one carries an IPv6 address, otherwise
/// none. The service reports the address a request left from, one family a request, so a world
/// asks over the family its `ip:` names are in.
fn asked_family(names: &[String]) -> Option<u8> {
    let mut asked = None;
    for address in names.iter().filter_map(|name| ip_name_address(name)) {
        if address.is_ipv4() {
            return Some(FAMILY_V4);
        }
        asked = Some(FAMILY_V6);
    }
    asked
}

/// The address `url` is asked at over the address family `family`: the service's check name for
/// that family, `ipv4.` or `ipv6.` put in front of the host. No family, a number that is neither,
/// and a `url` with no `://` give `url` as it is.
fn check_url(url: &str, family: Option<u8>) -> String {
    let label = match family {
        Some(FAMILY_V4) => "ipv4.",
        Some(FAMILY_V6) => "ipv6.",
        _ => return url.to_string(),
    };
    match url.split_once("://") {
        Some((scheme, rest)) => format!("{scheme}://{label}{rest}"),
        None => url.to_string(),
    }
}

/// Whether the stored address `row` vouches for `address` at `now_ms`: it holds that address,
/// compared as an address, and was confirmed less than [`EGRESS_MAX_AGE_MS`] ago. A row stamped
/// after `now_ms` vouches for nothing.
fn egress_confirms(row: &WorldEgress, address: IpAddr, now_ms: i64) -> bool {
    let age_ms = now_ms.saturating_sub(row.confirmed_at_ms);
    (0..EGRESS_MAX_AGE_MS).contains(&age_ms) && parse_address(&row.address) == Some(address)
}

/// Whether the world has confirmed the `ip:` name `name` as its address at `now_ms`: the name
/// carries an address and `stored`, the address stored for that address's family, vouches for
/// it ([`egress_confirms`]).
fn ip_name_confirmed(name: &str, stored: Option<&WorldEgress>, now_ms: i64) -> bool {
    ip_name_address(name)
        .is_some_and(|address| stored.is_some_and(|row| egress_confirms(row, address, now_ms)))
}

/// Whether a world that asks over `family` presents its name `name` in a redeem at `now_ms`,
/// `stored` being the address stored for `family`. A name that is no `ip:` name is presented.
/// An `ip:` name is presented when it carries an address of `family` and either no address is
/// stored for `family` or the stored one vouches for it ([`egress_confirms`]): once the service
/// has reported another address, or none for [`EGRESS_MAX_AGE_MS`], the name may be another
/// host's.
fn name_presented(
    name: &str,
    family: Option<u8>,
    stored: Option<&WorldEgress>,
    now_ms: i64,
) -> bool {
    if !name.starts_with(IP_NAME_PREFIX) {
        return true;
    }
    ip_name_address(name).is_some_and(|address| {
        Some(family_of(address)) == family
            && stored.is_none_or(|row| egress_confirms(row, address, now_ms))
    })
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

/// `identity`'s move record, on any build.
pub(crate) fn move_of(ctx: &ReducerContext, identity: Identity) -> Option<WorldMove> {
    ctx.db.world_move().identity().find(identity)
}

/// Refuses a caller that holds a `world_move` row, whose character plays under another
/// identity until it checks in again, with [`REJECT_CHARACTER_MOVED`]. Reads that row and
/// writes nothing.
pub(crate) fn require_not_moved(ctx: &ReducerContext, reducer: &str) -> Result<(), String> {
    if move_of(ctx, ctx.sender()).is_none() {
        return Ok(());
    }
    log_reject(reducer, ctx.sender(), REJECT_CHARACTER_MOVED);
    Err(REJECT_CHARACTER_MOVED.to_string())
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

/// The address family this world asks the account service over ([`asked_family`]), from its
/// names as the transaction `tx` reads them.
fn family_world_asks(tx: &ReducerContext) -> Option<u8> {
    asked_family(&crate::world_binding::world_names(tx))
}

/// What one transaction reads to judge this world's names: the names, the address family the
/// world asks over, the address stored for that family, and the transaction's time.
struct NameStanding {
    names: Vec<String>,
    family: Option<u8>,
    stored: Option<WorldEgress>,
    now_ms: i64,
}

/// The standing of this world's names as the transaction `tx` reads it.
fn name_standing(tx: &ReducerContext) -> NameStanding {
    let names = crate::world_binding::world_names(tx);
    let family = asked_family(&names);
    let stored = family.and_then(|family| tx.db.world_egress().family().find(family));
    NameStanding {
        names,
        family,
        stored,
        now_ms: now_ms(tx),
    }
}

impl NameStanding {
    /// Whether `name` is, byte for byte, a name of this world that a redeem presents
    /// ([`name_presented`]).
    fn presents(&self, name: &str) -> bool {
        self.names.iter().any(|own| own == name)
            && name_presented(name, self.family, self.stored.as_ref(), self.now_ms)
    }

    /// The names a redeem presents, in ascending byte order.
    fn presented(&self) -> Vec<String> {
        self.names
            .iter()
            .filter(|name| name_presented(name, self.family, self.stored.as_ref(), self.now_ms))
            .cloned()
            .collect()
    }

    /// Whether the world has confirmed `name`, a name it presents, as its address
    /// ([`ip_name_confirmed`]). A presented `ip:` name is of the family the world asks over, so
    /// the address read for that family is the one that vouches for it.
    fn confirms(&self, name: &str) -> bool {
        ip_name_confirmed(name, self.stored.as_ref(), self.now_ms)
    }
}

// --- Writes -----------------------------------------------------------------------------

/// Delete `identity`'s armed re-check, when one is armed.
fn disarm_recheck(ctx: &ReducerContext, identity: Identity) {
    if ctx
        .db
        .recheck_schedule()
        .identity()
        .find(identity)
        .is_some()
    {
        ctx.db.recheck_schedule().identity().delete(identity);
    }
}

/// Delete `identity`'s move record, when it holds one: at its next successful check, and as
/// the step for `world_move` of the deletion cascade and of a guest claim for the guest
/// identity it retires. An unbind and the owner's drop do not run it: a moved-away identity
/// that could clear its own record without checking in would pass `join_game`'s refusal and be
/// granted a second starter.
pub(crate) fn erase_world_move(ctx: &ReducerContext, identity: Identity) {
    if move_of(ctx, identity).is_some() {
        ctx.db.world_move().identity().delete(identity);
    }
}

/// Erase what this module holds about the account `identity` plays under: its row and its
/// armed re-check. Answers whether a `world_account` row went. The step for these two tables
/// of the deletion cascade, of a guest claim for the guest identity it retires, of an unbind
/// and of the owner's drop.
pub(crate) fn erase_world_account(ctx: &ReducerContext, identity: Identity) -> bool {
    disarm_recheck(ctx, identity);
    if account_of(ctx, identity).is_none() {
        return false;
    }
    ctx.db.world_account().identity().delete(identity);
    true
}

/// Arm one re-check of the connecting identity's account, when the build of `profile` names an
/// account service, the identity holds a row last checked [`RECHECK_MIN_AGE_MS`] ago or more,
/// its account is not pending deletion, and none is armed. Arming stamps the row's
/// `checked_at_ms`, so a run that gets no answer, and a connection made while a run waits, arm
/// nothing for that long: the host spends the one-shot row before the run ends, and without the
/// stamp a client that reconnects in a loop would have the world send a request at each
/// connection. Writes nothing otherwise.
pub(crate) fn arm_recheck_at_connect(ctx: &ReducerContext, profile: &BuildProfile) {
    if profile.world_check_url.is_none() {
        return;
    }
    let who = ctx.sender();
    let Some(account) = account_of(ctx, who) else {
        return;
    };
    let now = now_ms(ctx);
    if !recheck_due(account.checked_at_ms, now) {
        return;
    }
    if crate::accounts::is_pending_deletion(ctx, who) {
        return;
    }
    if ctx.db.recheck_schedule().identity().find(who).is_some() {
        return;
    }
    ctx.db.world_account().handle().update(WorldAccount {
        checked_at_ms: now,
        ..account
    });
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

/// The transaction before a redeem is sent: the gates, then the names the world presents
/// ([`name_presented`]) with the address family it asks over, then the budget. A world that
/// presents no name is refused. A refusal aborts the transaction, so it spends none of the
/// budget; the gates are judged first, so a caller the world refuses is told so whatever the
/// budget holds.
fn prepare_redeem(
    tx: &ReducerContext,
    who: Identity,
    relayed: bool,
) -> Result<(Vec<String>, Option<u8>), &'static str> {
    redeem_gates(tx, who, relayed)?;
    let standing = name_standing(tx);
    let names = standing.presented();
    if names.is_empty() {
        return Err(REJECT_WORLD_UNNAMED);
    }
    charge_budget(tx, relayed)?;
    Ok((names, standing.family))
}

/// Store `address`, the address the account service saw a request of this world leave from, as
/// its family's row, stamped with the transaction's time. The other family's row is left alone.
fn store_egress(tx: &ReducerContext, address: IpAddr) {
    let row = WorldEgress {
        family: family_of(address),
        address: address.to_string(),
        confirmed_at_ms: now_ms(tx),
    };
    if tx.db.world_egress().family().find(row.family).is_some() {
        tx.db.world_egress().family().update(row);
    } else {
        tx.db.world_egress().insert(row);
    }
}

/// The address an answer reports in its `address` member, when the member holds one.
fn reported_address(address: Option<&String>) -> Option<IpAddr> {
    address.and_then(|text| parse_address(text))
}

/// What refuses moving the character `from` owns to `who`: `who` owning a character, and, under
/// one reason so the answer tells nothing of the other identity's state, either identity in a
/// battle or a trade or `from`'s account pending deletion (the cascade keyed on `from` must
/// still find the character).
fn move_gates(tx: &ReducerContext, from: Identity, who: Identity) -> Result<(), &'static str> {
    if crate::accounts::owns_character(tx, who) {
        return Err(REJECT_CALLER_OWNS_CHARACTER);
    }
    if crate::accounts::in_battle_or_trade(tx, from)
        || crate::accounts::in_battle_or_trade(tx, who)
        || crate::accounts::is_pending_deletion(tx, from)
    {
        return Err(REJECT_MOVE_NOT_NOW);
    }
    Ok(())
}

/// The transaction that stores a redeemed ticket's answer for `who`, deciding from the rows as
/// they are now, the address the answer reported among them. Refused with no write: a gate that
/// fails now; an answered name that is not a name this world presents now ([`name_presented`]),
/// so an answer that shows an `ip:` name's address to be another's is not stored; `who` holding
/// another handle; and, when `who` is the world's owner under `Allowlist`, a full list that
/// lacks the handle.
///
/// A handle another identity holds is the same account at another client, so its character
/// moves to `who` (`accounts::move_character`) and the handle's row points at `who`, keeping its
/// host mark. That is refused, again with no write, when the ticket's name cannot carry a move
/// ([`name_carries_move`]; an `ip:` name carries one while the stored address confirms it,
/// [`ip_name_confirmed`]), by [`move_gates`], and when the move itself fails. The identity the
/// character left gets a `world_move` row and loses its armed re-check, and its admission row too
/// when the access rule was refusing it, so the move admits nobody. A holder that owns no
/// character is re-pointed the same way.
///
/// Otherwise `who`'s row holds the answer. Either way the owner's handle is on the list under
/// `Allowlist`, and `who`'s own `world_move` row is deleted: it has checked in.
fn store_redeem(
    tx: &ReducerContext,
    who: Identity,
    relayed: bool,
    answer: &TicketAnswer,
) -> Result<bool, &'static str> {
    redeem_gates(tx, who, relayed)?;
    let standing = name_standing(tx);
    if !standing.presents(&answer.name) {
        return Err(REJECT_TICKET_REFUSED);
    }
    let held = tx
        .db
        .world_account()
        .handle()
        .find(answer.handle.clone())
        .filter(|row| row.identity != who);
    if held.is_some() && !name_carries_move(&answer.name, standing.confirms(&answer.name)) {
        return Err(REJECT_HANDLE_HELD);
    }
    let own = account_of(tx, who);
    if own.as_ref().is_some_and(|row| row.handle != answer.handle) {
        return Err(REJECT_IDENTITY_HOLDS_ANOTHER);
    }
    if let Some(row) = &held {
        move_gates(tx, row.identity, who)?;
    }
    if crate::access::is_world_owner(tx, who)
        && crate::access::rule_in_force(tx) == WorldAccessRule::Allowlist
    {
        crate::world_binding::add_to_allowlist(tx, std::slice::from_ref(&answer.handle))?;
    }
    let checked_at_ms = standing.now_ms;
    match (held, own) {
        (Some(row), _) => {
            let from = row.identity;
            crate::accounts::move_character(tx, from, who).map_err(|_| REJECT_MOVE_FAILED)?;
            // Without an account row the rule reads `from`'s admission row. One the rule was
            // not honouring goes, so the move admits nobody.
            if !crate::access::is_admitted(tx, from) {
                crate::access::withdraw_admission(tx, from);
            }
            disarm_recheck(tx, from);
            tx.db.world_account().handle().update(WorldAccount {
                identity: who,
                entitled: answer.entitled,
                checked_at_ms,
                ..row
            });
            erase_world_move(tx, from);
            tx.db.world_move().insert(WorldMove {
                identity: from,
                moved_at_ms: checked_at_ms,
            });
        }
        (None, Some(row)) => {
            tx.db.world_account().handle().update(WorldAccount {
                entitled: answer.entitled,
                checked_at_ms,
                ..row
            });
        }
        (None, None) => {
            tx.db.world_account().insert(WorldAccount {
                handle: answer.handle.clone(),
                identity: who,
                entitled: answer.entitled,
                checked_at_ms,
                is_host: false,
            });
        }
    }
    erase_world_move(tx, who);
    Ok(answer.entitled)
}

/// The row an answer about `asked` is stored on: `asked`'s identity's row, `asked` being the row
/// as it stood when the request was sent. None when that row is gone or holds another handle or
/// check time: an unbind, a newer check or another re-check landed during the wait, and an older
/// answer never overwrites a newer one.
fn row_asked_about(tx: &ReducerContext, asked: &WorldAccount) -> Option<WorldAccount> {
    account_of(tx, asked.identity)
        .filter(|row| row.handle == asked.handle && row.checked_at_ms == asked.checked_at_ms)
}

/// Store on `row` what the service answered a handle check about it. An answer that names no
/// handle stores not entitled. An answer under another handle replaces the row and its entry on
/// the host's list, unless another identity holds that handle: the standing is then stored on
/// the row as it is. The row keeps its host mark either way.
fn store_status(tx: &ReducerContext, row: WorldAccount, answer: &HandleAnswer) {
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

/// The transaction that stores a re-check's answer about `asked`: the address it reports, and
/// its status on the row asked about ([`row_asked_about`], [`store_status`]). The address is
/// stored also when the row is left alone.
fn store_recheck(tx: &ReducerContext, asked: &WorldAccount, answer: &HandleAnswer) {
    let row = row_asked_about(tx, asked);
    if let Some(address) = reported_address(answer.address.as_ref()) {
        store_egress(tx, address);
    }
    if let Some(row) = row {
        store_status(tx, row, answer);
    }
}

/// Replace the rows `stored` of `host_check_schedule` by one row that ticks every
/// [`HOST_CHECK_INTERVAL_MS`] and holds `last_success_ms`. A row is replaced and never updated:
/// the host re-queues an updated scheduled row at the call and drops that queue entry when the
/// transaction then aborts, which would stop an interval row ticking until the host restarts,
/// while a delete and an insert that roll back leave the first row's entry queued.
fn replace_host_schedule(
    ctx: &ReducerContext,
    stored: impl IntoIterator<Item = u64>,
    last_success_ms: Option<i64>,
) {
    for scheduled_id in stored {
        ctx.db
            .host_check_schedule()
            .scheduled_id()
            .delete(scheduled_id);
    }
    ctx.db.host_check_schedule().insert(HostCheckSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Interval(TimeDuration::from_micros(
            HOST_CHECK_INTERVAL_MS * 1000,
        )),
        last_success_ms,
    });
}

/// Mark `who`'s row as the one the host plays as, clear the mark on every other row, and arm
/// the host's own check: the body of [`set_host_identity`] past its gates, as a build of
/// `profile` runs it. Refused with nothing read on a build that names no account service, and
/// with nothing written when `who` holds no row. A row whose mark does not change is not
/// written. `host_check_schedule` is left as it is when `who`'s row was marked already and the
/// table holds one row; otherwise it is left holding one row with no success yet, so the next
/// tick asks about the newly marked account.
pub(crate) fn mark_host(
    ctx: &ReducerContext,
    profile: &BuildProfile,
    who: Identity,
) -> Result<(), String> {
    const REDUCER: &str = "set_host_identity";
    if profile.world_check_url.is_none() {
        return refuse(REDUCER, ctx.sender(), REJECT_BUILD_CHECKS_NOTHING);
    }
    let Some(own) = account_of(ctx, who) else {
        return refuse(REDUCER, ctx.sender(), REJECT_NO_HOST_ACCOUNT);
    };
    let marked_elsewhere: Vec<WorldAccount> = ctx
        .db
        .world_account()
        .iter()
        .filter(|row| row.is_host && row.identity != who)
        .collect();
    for row in marked_elsewhere {
        ctx.db.world_account().handle().update(WorldAccount {
            is_host: false,
            ..row
        });
    }
    let was_marked = own.is_host;
    if !was_marked {
        ctx.db.world_account().handle().update(WorldAccount {
            is_host: true,
            ..own
        });
    }
    let armed: Vec<u64> = ctx
        .db
        .host_check_schedule()
        .iter()
        .map(|row| row.scheduled_id)
        .collect();
    if !(was_marked && armed.len() == 1) {
        replace_host_schedule(ctx, armed, None);
    }
    Ok(())
}

/// Have the host's own check ask at its next tick, because the names this world answers to
/// changed and with them what its `ip:` names claim. Writes nothing when no check is armed, and
/// when the one armed row holds no success; otherwise `host_check_schedule` is left holding one
/// row with no success yet. Called by `world_binding::set_world_names`.
pub(crate) fn names_changed(ctx: &ReducerContext) {
    let armed: Vec<HostCheckSchedule> = ctx.db.host_check_schedule().iter().collect();
    let nothing_to_reset = matches!(
        armed.as_slice(),
        [] | [HostCheckSchedule {
            last_success_ms: None,
            ..
        }]
    );
    if nothing_to_reset {
        return;
    }
    replace_host_schedule(ctx, armed.into_iter().map(|row| row.scheduled_id), None);
}

/// What a tick of the host's own check read before it asked: the schedule row that fired and
/// the success it held, the marked row the check asks about, and the address family the world
/// asks over.
struct HostCheck {
    scheduled_id: u64,
    last_success_ms: Option<i64>,
    asked: WorldAccount,
    family: Option<u8>,
}

/// The check a tick of the schedule row `scheduled_id` makes at this transaction's time. None,
/// and the tick sends nothing, when `host_check_schedule` holds no row under that id, when the
/// row is not due ([`host_check_due`], judged on the stored row), when no row is marked, and when
/// the marked identity's account is pending deletion.
fn due_host_check(tx: &ReducerContext, scheduled_id: u64) -> Option<HostCheck> {
    let fired = tx
        .db
        .host_check_schedule()
        .scheduled_id()
        .find(scheduled_id)?;
    if !host_check_due(fired.last_success_ms, now_ms(tx)) {
        return None;
    }
    let asked = tx.db.world_account().iter().find(|row| row.is_host)?;
    if crate::accounts::is_pending_deletion(tx, asked.identity) {
        return None;
    }
    Some(HostCheck {
        scheduled_id,
        last_success_ms: fired.last_success_ms,
        asked,
        family: family_world_asks(tx),
    })
}

/// The transaction that stores the answer to the host's own check: the address it reports, and
/// its status as a re-check stores it ([`row_asked_about`], [`store_status`]), except on a row
/// whose identity's account is pending deletion, which is left alone. The success is stamped, the
/// fired row replaced by one that holds this transaction's time, only when the status was stored
/// on a row that is still marked, the fired row still holds the success it held when the tick
/// read it, and the world still asks over the address family the request went over, each judged
/// on the rows as this transaction first reads them. After a change of host during the wait, or
/// a change of the world's names that reset the check or changed the family asked, the schedule
/// row holds no success and stands: the next tick asks again.
fn store_host_check(tx: &ReducerContext, check: &HostCheck, answer: &HandleAnswer) {
    let row = row_asked_about(tx, &check.asked)
        .filter(|row| !crate::accounts::is_pending_deletion(tx, row.identity));
    let fired_unchanged = tx
        .db
        .host_check_schedule()
        .scheduled_id()
        .find(check.scheduled_id)
        .is_some_and(|fired| fired.last_success_ms == check.last_success_ms);
    let stamps = fired_unchanged
        && family_world_asks(tx) == check.family
        && row.as_ref().is_some_and(|row| row.is_host);
    if let Some(address) = reported_address(answer.address.as_ref()) {
        store_egress(tx, address);
    }
    if let Some(row) = row {
        store_status(tx, row, answer);
    }
    if stamps {
        replace_host_schedule(tx, [check.scheduled_id], Some(now_ms(tx)));
    }
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

/// Ask the account service at `url` about the account under `handle`. None when there is no
/// usable answer: the request failed or timed out, the status is not `200`, or the body is not
/// the answer's shape.
fn ask_about(ctx: &ProcedureContext, url: &str, handle: &str) -> Option<HandleAnswer> {
    let world = world_of(ctx);
    let body = serde_json::to_vec(&HandleCheck {
        handle,
        world: &world,
    })
    .ok()?;
    match post_json(ctx, url, body) {
        Some((STATUS_OK, bytes)) => parse_handle_answer(&bytes),
        _ => None,
    }
}

/// Log a refusal of the procedure or reducer `callee` and return it. The reason is always a
/// constant of this crate.
fn refuse<T>(callee: &str, sender: Identity, reason: &str) -> Result<T, String> {
    log_reject(callee, sender, reason);
    Err(reason.to_string())
}

/// Redeem `ticket` for `who` at `url`, over the address family the world asks over, and store
/// the answer: the body of both first-contact procedures, whose refusals and order the module
/// comment and `store_redeem` give. The address a usable answer reports is stored in a
/// transaction of its own before the one that stores the account, so a redeem that is then
/// refused has still stored it.
fn redeem(
    ctx: &mut ProcedureContext,
    url: &str,
    who: Identity,
    relayed: bool,
    ticket: &str,
) -> Result<bool, String> {
    let procedure = if relayed {
        "check_account_for"
    } else {
        "check_account"
    };
    let sender = ctx.sender();
    if !is_ticket(ticket) {
        return refuse(procedure, sender, REJECT_TICKET_MALFORMED);
    }
    let (names, family) = match ctx.try_with_tx(|tx| prepare_redeem(tx, who, relayed)) {
        Ok(prepared) => prepared,
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
    let answer = match post_json(ctx, &check_url(url, family), body) {
        Some((STATUS_OK, bytes)) => parse_ticket_answer(&bytes),
        Some((STATUS_FORBIDDEN, _)) => return refuse(procedure, sender, REJECT_TICKET_REFUSED),
        _ => None,
    };
    let Some(answer) = answer else {
        return refuse(procedure, sender, REJECT_CHECK_UNANSWERED);
    };
    if let Some(address) = reported_address(answer.address.as_ref()) {
        ctx.with_tx(|tx| store_egress(tx, address));
    }
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
    redeem(ctx, url, who, false, ticket)
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
    redeem(ctx, url, who, true, ticket)
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
    let read =
        ctx.with_tx(|tx| account_of(tx, row.identity).map(|asked| (asked, family_world_asks(tx))));
    let Some((asked, family)) = read else {
        return Ok(());
    };
    let Some(answer) = ask_about(ctx, &check_url(url, family), &asked.handle) else {
        return refuse(PROCEDURE, ctx.sender(), REJECT_CHECK_UNANSWERED);
    };
    ctx.with_tx(|tx| store_recheck(tx, &asked, &answer));
    Ok(())
}

/// [`host_account_check`] as a build of `profile` runs it.
pub(crate) fn host_account_check_under(
    ctx: &mut ProcedureContext,
    profile: &BuildProfile,
    row: HostCheckSchedule,
) -> Result<(), String> {
    const PROCEDURE: &str = "host_account_check";
    let Some(url) = profile.world_check_url else {
        return refuse(PROCEDURE, ctx.sender(), REJECT_BUILD_CHECKS_NOTHING);
    };
    if ctx.sender() != ctx.database_identity() {
        return refuse(PROCEDURE, ctx.sender(), REJECT_NOT_DATABASE);
    }
    let Some(check) = ctx.with_tx(|tx| due_host_check(tx, row.scheduled_id)) else {
        return Ok(());
    };
    let Some(answer) = ask_about(ctx, &check_url(url, check.family), &check.asked.handle) else {
        return refuse(PROCEDURE, ctx.sender(), REJECT_CHECK_UNANSWERED);
    };
    ctx.with_tx(|tx| store_host_check(tx, &check, &answer));
    Ok(())
}

/// Name the identity the host plays as: mark `who`'s `world_account` row, clear the mark on
/// every other, and arm the host's own check ([`mark_host`]). Owner-only. Refused with no
/// write, in this order: a caller that is not the world's owner
/// (`access::REJECT_NOT_WORLD_OWNER`); a `who` whose account is pending deletion; a build that
/// names no account service ([`REJECT_BUILD_CHECKS_NOTHING`]); a `who` that holds no row
/// ([`REJECT_NO_HOST_ACCOUNT`]). The mark stays on the row until another identity is named or
/// the row is erased.
#[spacetimedb::reducer]
pub fn set_host_identity(ctx: &ReducerContext, who: Identity) -> Result<(), String> {
    crate::access::require_world_owner(ctx, "set_host_identity")?;
    crate::guards::require_subject_not_deleting(ctx, who)?;
    mark_host(ctx, &BUILD_PROFILE, who)
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
/// Run by the host from a `recheck_schedule` row; any other caller is refused before anything
/// is sent ([`REJECT_NOT_DATABASE`], after a build that names no account service has answered
/// [`REJECT_BUILD_CHECKS_NOTHING`]).
#[spacetimedb::procedure]
pub fn recheck_account(ctx: &mut ProcedureContext, row: RecheckSchedule) -> Result<(), String> {
    recheck_account_under(ctx, &BUILD_PROFILE, row)
}

/// The host's own check: ask the account service about the account the marked row holds, and
/// store the answer and, when it lands on that row, the time of the success. Run by the host
/// from the `host_check_schedule` row every [`HOST_CHECK_INTERVAL_MS`]; any other caller is
/// refused before anything is read or sent ([`REJECT_NOT_DATABASE`], after a build that names no
/// account service has answered [`REJECT_BUILD_CHECKS_NOTHING`]). A tick sends nothing while the
/// last success is under [`HOST_CHECK_MIN_AGE_MS`] old, no row is marked, or the marked account
/// is pending deletion, and one that gets no answer writes nothing, so the next tick asks again.
/// It asks about the marked row's handle and no other.
#[spacetimedb::procedure]
pub fn host_account_check(
    ctx: &mut ProcedureContext,
    row: HostCheckSchedule,
) -> Result<(), String> {
    host_account_check_under(ctx, &BUILD_PROFILE, row)
}

#[cfg(test)]
#[path = "account_checks_tests.rs"]
mod account_checks_tests;

#[cfg(test)]
#[path = "account_checks_host_tests.rs"]
mod account_checks_host_tests;
