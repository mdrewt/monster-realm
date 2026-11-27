//! A world's own account checks, executed against the in-memory host: `check_account` and
//! `check_account_for` (first contact), `recheck_account` (each later connection), the arming at
//! connect, the reads the door and the admission rule make, the unbind's erasure and the
//! `my_world_account` view.
//!
//! Every procedure runs inside `Fixture::run_procedure` with its HTTP answers stubbed in order
//! (`HttpQueue`), and each test names the build profile it runs as, so no test depends on the
//! features the suite is built with. A request the stubs did not expect fails the run, so
//! "no request" is an empty request record over an empty queue.

use super::*;
use crate::access::{REJECT_NOT_ADMITTED, REJECT_NOT_WORLD_OWNER};
use crate::accounts::{build_profile, BuildFeatures, BuildProfile, ERR_OWNERSHIP_REQUIRED};
use crate::guards::REJECT_DELETION_GATED;
use crate::native_host_tests::{
    fixture, Caller, Fixture, Handle, HttpAnswer, HttpQueue, SentRequest, VIEW_MY_WORLD_ACCOUNT,
};
use crate::schema::{
    Account, AccountStatus, Config, WorldAccess, WorldAccessRule, WorldAdmission, WorldAllowlist,
    WorldBindNonce, WorldBinding, WorldName,
};
use crate::world_binding::REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS;
use spacetimedb::sats::bsatn;
use spacetimedb::{Identity, ScheduleAt, Serialize, TimeDuration, Timestamp};

// =====================================================================================
// Vocabulary: identities, times, names, tickets, handles, profiles.
// =====================================================================================

/// Never `[0; 32]` (the dummy sender) and never the module identity `[0xDB; 32]`.
fn id(b: u8) -> Identity {
    Identity::from_byte_array([b; 32])
}

/// The world owner every world below names in `config`.
fn owner() -> Identity {
    id(0xA1)
}

fn alice() -> Identity {
    id(0x11)
}

fn bob() -> Identity {
    id(0x22)
}

fn carol() -> Identity {
    id(0x33)
}

/// The `n`-th identity of a pool of first-contact callers.
fn pool(n: u8) -> Identity {
    id(0x40 + n)
}

/// The handle the service answers for [`pool`] `n`.
fn pool_handle(n: u8) -> String {
    format!("k1.Pool{n:02}0123456789-_")
}

fn at(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms * 1000)
}

/// The start of a minute: 1 800 000 000 000 is a whole number of 60 000 ms.
const T0: i64 = 1_800_000_000_000;
/// The time every single check below runs at: 15 s into the minute that starts at [`T0`].
const NOW: i64 = T0 + 15_000;

const WORLD_NAME: &str = "spki:TEST-fingerprint_00/realm-one";
const IP_NAME: &str = "ip:203.0.113.9:3000";
const OTHER_NAME: &str = "spki:OTHER-fingerprint_01/realm-two";

/// Alice's account, as the service spells it.
const HANDLE_A: &str = "k1.AbCdEf0123456789-_";
/// Alice's account under the service's newer key.
const HANDLE_A2: &str = "k2.ZyXwVu9876543210_-";
/// Bob's account.
const HANDLE_B: &str = "k1.BbBbBb0123456789xy";
/// The owner's account.
const HANDLE_OWNER: &str = "k1.OwNeR0123456789abcd";

/// The address the service reports, the one [`IP_NAME`] carries: a usable answer stores it as
/// the world's IPv4 address, which confirms [`IP_NAME`].
const ADDRESS: &str = "203.0.113.9";

/// The 64 URL-safe base64 characters.
const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// A well-formed ticket: the last 43 characters of the alphabet, `-` and `_` included.
fn ticket() -> String {
    ALPHABET[ALPHABET.len() - 43..].to_string()
}

/// The database identity the fixture's `ctx.database_identity()` answers, as 64 lower-case hex
/// digits.
fn world_hex() -> String {
    "db".repeat(32)
}

/// The request timeout every check carries: 3 s.
fn three_seconds() -> Option<TimeDuration> {
    Some(TimeDuration::from_micros(3_000_000))
}

const NO_FEATURE: BuildFeatures = BuildFeatures {
    official: false,
    world: false,
    dev_issuers: false,
    open_join: false,
    dev_reducers: false,
    load_test_zones: false,
};

/// The `test` build: does not enforce ownership, asks the hosted-dev service.
fn test_profile() -> BuildProfile {
    build_profile(BuildFeatures {
        open_join: true,
        ..NO_FEATURE
    })
}

/// The `dev-enforcing` build: enforces ownership, asks the hosted-dev service.
fn dev_enforcing() -> BuildProfile {
    build_profile(BuildFeatures {
        dev_issuers: true,
        ..NO_FEATURE
    })
}

/// The `world` build: enforces ownership, asks the production service.
fn world_profile() -> BuildProfile {
    build_profile(BuildFeatures {
        world: true,
        ..NO_FEATURE
    })
}

/// The three builds that name no account service: `official`, `conflict`, `default`.
fn checkless_profiles() -> Vec<BuildProfile> {
    let profiles = vec![
        build_profile(BuildFeatures {
            official: true,
            ..NO_FEATURE
        }),
        build_profile(BuildFeatures {
            official: true,
            world: true,
            ..NO_FEATURE
        }),
        build_profile(NO_FEATURE),
    ];
    let names: Vec<&str> = profiles.iter().map(|p| p.name).collect();
    assert_eq!(names, vec!["official", "conflict", "default"], "fixture");
    for p in &profiles {
        assert!(
            p.world_check_url.is_none(),
            "fixture: {} names no service",
            p.name
        );
    }
    profiles
}

// =====================================================================================
// The world: every table the check paths read or write.
// =====================================================================================

struct W<'a> {
    config: Handle<'a, Config, u32>,
    access: Handle<'a, WorldAccess, u32>,
    admission: Handle<'a, WorldAdmission>,
    account: Handle<'a, Account>,
    names: Handle<'a, WorldName, String>,
    allow: Handle<'a, WorldAllowlist, String>,
    accounts: Handle<'a, WorldAccount>,
    budget: Handle<'a, WorldCheckBudget, u32>,
    rechecks: Handle<'a, RecheckSchedule>,
    moves: Handle<'a, WorldMove>,
    egress: Handle<'a, WorldEgress, u8>,
}

/// Registers what the checks, the arming, the view and the unbind touch. `config`,
/// `world_access` and `account` are read-only: a write to one aborts the test. The account
/// rows are read on both their keys; the re-check rows on both of theirs, the key drawn from a
/// sequence; the binding and nonce tables are registered for the unbind's erasure; the
/// world's addresses are found, updated and inserted by `family`.
fn world(fx: &Fixture) -> W<'_> {
    let _ = fx
        .table_keyed::<WorldAccount, String>("world_account", "handle", |r| r.handle.clone())
        .unique();
    let _ = fx
        .table_keyed::<RecheckSchedule, u64>("recheck_schedule", "scheduled_id", |r| r.scheduled_id)
        .unique();
    let _ = fx
        .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
        .unique()
        .writable();
    let _ = fx
        .table::<WorldBindNonce>("world_bind_nonce", "identity", |r| r.identity)
        .unique()
        .writable();
    W {
        config: fx
            .table_keyed::<Config, u32>("config", "id", |r| r.id)
            .unique(),
        access: fx
            .table_keyed::<WorldAccess, u32>("world_access", "id", |r| r.id)
            .unique(),
        admission: fx
            .table::<WorldAdmission>("world_admission", "identity", |r| r.identity)
            .unique()
            .writable(),
        account: fx
            .table::<Account>("account", "identity", |r| r.identity)
            .unique(),
        names: fx
            .table_keyed::<WorldName, String>("world_name", "name", |r| r.name.clone())
            .unique()
            .scannable(),
        allow: fx
            .table_keyed::<WorldAllowlist, String>("world_allowlist", "account_subject", |r| {
                r.account_subject.clone()
            })
            .unique()
            .writable()
            .scannable(),
        accounts: fx
            .table::<WorldAccount>("world_account", "identity", |r| r.identity)
            .unique()
            .writable()
            .scannable(),
        budget: fx
            .table_keyed::<WorldCheckBudget, u32>("world_check_budget", "id", |r| r.id)
            .unique()
            .writable(),
        rechecks: fx
            .table::<RecheckSchedule>("recheck_schedule", "identity", |r| r.identity)
            .unique()
            .writable()
            .auto_inc(|r| r.scheduled_id, |r, v| r.scheduled_id = v),
        moves: fx
            .table::<WorldMove>("world_move", "identity", |r| r.identity)
            .unique()
            .writable(),
        egress: fx
            .table_keyed::<WorldEgress, u8>("world_egress", "family", |r| r.family)
            .unique()
            .writable(),
    }
}

/// An `Open` world owned by [`owner`], named [`WORLD_NAME`] and [`IP_NAME`], where the
/// bystander [`bob`] holds a checked account under [`HANDLE_B`].
fn owned_world(fx: &Fixture) -> W<'_> {
    let w = world(fx);
    w.config.seed(&Config {
        id: 0,
        content_version: 0,
        owner_identity: owner(),
    });
    for name in [WORLD_NAME, IP_NAME] {
        w.names.seed(&WorldName {
            name: name.to_string(),
        });
    }
    w.accounts
        .seed(&account_row(bob(), HANDLE_B, true, T0 - 86_400_000, false));
    w
}

fn rule_row(rule: WorldAccessRule) -> WorldAccess {
    WorldAccess { id: 0, rule }
}

fn admission_row(who: Identity) -> WorldAdmission {
    WorldAdmission {
        identity: who,
        admitted_at_ms: T0 - 60_000,
    }
}

/// An account mid-deletion: the deletion gate refuses its identity.
fn deleting_account(who: Identity) -> Account {
    Account {
        identity: who,
        auth_issuer: crate::accounts::DEV_LOGIN_ISSUERS[0].to_string(),
        created_at_ms: 10,
        last_login_at_ms: 20,
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(30),
        claimed_from: None,
        claimed_at_ms: None,
        terminal_at_ms: None,
    }
}

fn account_row(
    who: Identity,
    handle: &str,
    entitled: bool,
    checked_at_ms: i64,
    is_host: bool,
) -> WorldAccount {
    WorldAccount {
        handle: handle.to_string(),
        identity: who,
        entitled,
        checked_at_ms,
        is_host,
    }
}

fn recheck_of(who: Identity, n: u64) -> RecheckSchedule {
    RecheckSchedule {
        scheduled_id: n,
        scheduled_at: ScheduleAt::Time(at(NOW)),
        identity: who,
    }
}

fn budget_row(minute_start_ms: i64, redeems: u32) -> WorldCheckBudget {
    WorldCheckBudget {
        id: 0,
        minute_start_ms,
        redeems,
    }
}

fn list(w: &W<'_>, handles: &[&str]) {
    for handle in handles {
        w.allow.seed(&WorldAllowlist {
            account_subject: (*handle).to_string(),
        });
    }
}

// =====================================================================================
// Answers the service gives.
// =====================================================================================

/// The service's answer to a ticket.
fn ticket_answer(handle: &str, entitled: bool, name: &str) -> String {
    serde_json::json!({
        "handle": handle,
        "entitled": entitled,
        "address": ADDRESS,
        "name": name,
    })
    .to_string()
}

/// The service's answer to a handle it knows.
fn handle_answer(handle: &str, entitled: bool) -> String {
    serde_json::json!({ "handle": handle, "entitled": entitled, "address": ADDRESS }).to_string()
}

/// The service's answer to a handle it does not know.
fn unknown_handle_answer(entitled: bool) -> String {
    serde_json::json!({ "entitled": entitled, "address": ADDRESS }).to_string()
}

/// The service's answer to a ticket whose `address` member is `address`, or absent on `None`.
fn ticket_answer_with(
    handle: &str,
    entitled: bool,
    name: &str,
    address: Option<serde_json::Value>,
) -> String {
    let mut body = serde_json::json!({ "handle": handle, "entitled": entitled, "name": name });
    if let Some(address) = address {
        body["address"] = address;
    }
    body.to_string()
}

/// The service's answer to a handle it knows, whose `address` member is `address`, or absent
/// on `None`.
fn handle_answer_with(handle: &str, entitled: bool, address: Option<serde_json::Value>) -> String {
    let mut body = serde_json::json!({ "handle": handle, "entitled": entitled });
    if let Some(address) = address {
        body["address"] = address;
    }
    body.to_string()
}

fn ok_answer<'q>(body: String) -> HttpAnswer<'q> {
    HttpAnswer::status(200, body)
}

/// A stubbed outcome: a status and body, or the text of a transport error.
type Stubbed = Result<(u16, String), String>;

/// The stubbed answer for `outcome`.
fn answer_of<'q>(outcome: &Stubbed) -> HttpAnswer<'q> {
    match outcome {
        Ok((code, body)) => HttpAnswer::status(*code, body.clone()),
        Err(text) => HttpAnswer::error(text.clone()),
    }
}

// =====================================================================================
// Observations.
// =====================================================================================

type AccountView = (String, [u8; 32], bool, i64, bool);
type Footprint = Vec<(&'static str, Vec<Vec<u8>>, u32)>;

fn view(row: &WorldAccount) -> AccountView {
    (
        row.handle.clone(),
        row.identity.to_byte_array(),
        row.entitled,
        row.checked_at_ms,
        row.is_host,
    )
}

fn sorted<T: Ord>(mut v: Vec<T>) -> Vec<T> {
    v.sort();
    v
}

/// Every `world_account` row, sorted.
fn accounts(w: &W<'_>) -> Vec<AccountView> {
    sorted(w.accounts.rows().iter().map(view).collect())
}

/// Every `world_move` row as `(identity, moved_at_ms)`, sorted.
fn moves(w: &W<'_>) -> Vec<([u8; 32], i64)> {
    sorted(
        w.moves
            .rows()
            .iter()
            .map(|r| (r.identity.to_byte_array(), r.moved_at_ms))
            .collect(),
    )
}

/// Every `world_egress` row as `(family, address, confirmed_at_ms)`, sorted.
fn egress(w: &W<'_>) -> Vec<(u8, String, i64)> {
    sorted(
        w.egress
            .rows()
            .into_iter()
            .map(|r| (r.family, r.address, r.confirmed_at_ms))
            .collect(),
    )
}

/// The `world_egress` row of `family` holding `address`, confirmed at `ms`.
fn egress_row(family: u8, address: &str, ms: i64) -> WorldEgress {
    WorldEgress {
        family,
        address: address.to_string(),
        confirmed_at_ms: ms,
    }
}

/// The budget rows as `(id, minute_start_ms, redeems)`.
fn budget(w: &W<'_>) -> Vec<(u32, i64, u32)> {
    w.budget
        .rows()
        .into_iter()
        .map(|r| (r.id, r.minute_start_ms, r.redeems))
        .collect()
}

fn listed(w: &W<'_>) -> Vec<String> {
    sorted(
        w.allow
            .rows()
            .into_iter()
            .map(|r| r.account_subject)
            .collect(),
    )
}

fn strings(xs: &[&str]) -> Vec<String> {
    sorted(xs.iter().map(|x| (*x).to_string()).collect())
}

fn encs<T: Serialize>(rows: &[T]) -> Vec<Vec<u8>> {
    sorted(
        rows.iter()
            .map(|r| bsatn::to_vec(r).expect("a row always BSATN-encodes"))
            .collect(),
    )
}

/// Every stored row of the tables a check may write, with each table's write count.
fn footprint(fx: &Fixture, w: &W<'_>) -> Footprint {
    vec![
        (
            "world_account",
            encs(&w.accounts.rows()),
            fx.writes_to("world_account"),
        ),
        (
            "world_check_budget",
            encs(&w.budget.rows()),
            fx.writes_to("world_check_budget"),
        ),
        (
            "world_allowlist",
            encs(&w.allow.rows()),
            fx.writes_to("world_allowlist"),
        ),
        (
            "recheck_schedule",
            encs(&w.rechecks.rows()),
            fx.writes_to("recheck_schedule"),
        ),
        (
            "world_admission",
            encs(&w.admission.rows()),
            fx.writes_to("world_admission"),
        ),
        (
            "world_move",
            encs(&w.moves.rows()),
            fx.writes_to("world_move"),
        ),
        (
            "world_egress",
            encs(&w.egress.rows()),
            fx.writes_to("world_egress"),
        ),
    ]
}

/// Every table a check could read.
const READ_TABLES: [&str; 11] = [
    "config",
    "world_access",
    "world_admission",
    "account",
    "world_name",
    "world_allowlist",
    "world_account",
    "world_check_budget",
    "recheck_schedule",
    "world_move",
    "world_egress",
];

fn assert_nothing_read(fx: &Fixture, label: &str) {
    for table in READ_TABLES {
        assert_eq!(fx.rows_read(table), 0, "{label}: read {table}");
    }
}

/// The request body, which is one JSON object.
fn body_of(req: &SentRequest) -> serde_json::Map<String, serde_json::Value> {
    let value: serde_json::Value =
        serde_json::from_slice(&req.body).expect("the request body is JSON");
    value
        .as_object()
        .expect("the request body is one JSON object")
        .clone()
}

fn keys_of(body: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    sorted(body.keys().cloned().collect())
}

/// `req` is a first-contact check: `POST` to `url` with the 3 s timeout and exactly
/// `{"ticket", "names", "world"}`, `names` holding `names` in any order and `world` the
/// database identity's hex.
fn assert_first_contact(req: &SentRequest, url: &str, ticket: &str, names: &[&str]) {
    assert_eq!(req.method, "POST", "a check is a POST");
    assert_eq!(req.url, url, "a check goes to the profile's service");
    assert_eq!(req.timeout, three_seconds(), "a check waits 3 s at most");
    let body = body_of(req);
    assert_eq!(keys_of(&body), strings(&["names", "ticket", "world"]));
    assert_eq!(body["ticket"], ticket);
    let sent: Vec<String> = body["names"]
        .as_array()
        .expect("`names` is an array")
        .iter()
        .map(|n| n.as_str().expect("a name is a string").to_string())
        .collect();
    assert_eq!(
        sorted(sent),
        strings(names),
        "every world name is presented"
    );
    assert_eq!(body["world"], world_hex());
}

/// `req` is a re-check: `POST` to `url` with the 3 s timeout and exactly `{"handle", "world"}`.
fn assert_recheck_request(req: &SentRequest, url: &str, handle: &str) {
    assert_eq!(req.method, "POST", "a re-check is a POST");
    assert_eq!(req.url, url, "a re-check goes to the profile's service");
    assert_eq!(req.timeout, three_seconds(), "a re-check waits 3 s at most");
    let body = body_of(req);
    assert_eq!(keys_of(&body), strings(&["handle", "world"]));
    assert_eq!(body["handle"], handle);
    assert_eq!(body["world"], world_hex());
}

// =====================================================================================
// Calls.
// =====================================================================================

/// `who` calls `check_account(ticket)` under `profile` at `ms`.
fn check_as(
    fx: &Fixture,
    who: Identity,
    ms: i64,
    http: &mut HttpQueue<'_>,
    profile: &BuildProfile,
    ticket: &str,
) -> Result<bool, String> {
    fx.run_procedure(Caller::Sender(who), at(ms), http, |ctx| {
        check_account_under(ctx, profile, ticket)
    })
}

/// `caller` calls `check_account_for(who, ticket)` under `profile` at `ms`.
fn relay_as(
    fx: &Fixture,
    caller: Identity,
    who: Identity,
    ms: i64,
    http: &mut HttpQueue<'_>,
    profile: &BuildProfile,
    ticket: &str,
) -> Result<bool, String> {
    fx.run_procedure(Caller::Sender(caller), at(ms), http, |ctx| {
        check_account_for_under(ctx, profile, who, ticket)
    })
}

/// `caller` runs `recheck_account(row)` under `profile` at `ms`.
fn recheck_as(
    fx: &Fixture,
    caller: Caller,
    ms: i64,
    http: &mut HttpQueue<'_>,
    profile: &BuildProfile,
    row: RecheckSchedule,
) -> Result<(), String> {
    fx.run_procedure(caller, at(ms), http, |ctx| {
        recheck_account_under(ctx, profile, row)
    })
}

/// [`alice`] checks [`ticket`] on the `test` build at [`NOW`] with one stubbed answer.
fn alice_checks(fx: &Fixture, answer: HttpAnswer<'_>) -> (Result<bool, String>, Vec<SentRequest>) {
    let mut http = HttpQueue::new();
    http.push(answer);
    let got = check_as(fx, alice(), NOW, &mut http, &test_profile(), &ticket());
    (got, http.requests().to_vec())
}

// =====================================================================================
// First contact: the stored outcome.
// =====================================================================================

mod first_contact {
    use super::*;

    /// An identity the world does not know checks a ticket the service accepts: one POST to
    /// the profile's service over the IPv4 family the world's `ip:` name carries, with the
    /// ticket, every world name and the world's identity, and the answered handle and
    /// entitlement stored for the caller at the transaction's time, in one write. The
    /// bystander's row stays.
    ///
    /// kills: the inert procedure; the row stored under the bystander or the owner; the
    /// stored time another than the check's; a name left out of the request; more than one
    /// write to `world_account`.
    #[test]
    fn an_unknown_identity_with_an_accepted_ticket_stores_the_answered_account_lpw23_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        let bob_before = accounts(&w);
        fx.reset_writes();
        let (got, sent) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        assert_eq!(got, Ok(true), "the caller is told the outcome");
        assert_eq!(sent.len(), 1, "one request");
        assert_first_contact(
            &sent[0],
            "https://ipv4.auth.monster-realm.spookyowltech.com/world/check",
            &ticket(),
            &[WORLD_NAME, IP_NAME],
        );
        let mut want = bob_before;
        want.push(view(&account_row(alice(), HANDLE_A, true, NOW, false)));
        assert_eq!(accounts(&w), sorted(want), "alice's row, beside bob's");
        assert_eq!(
            fx.writes_to("world_account"),
            1,
            "one write to world_account"
        );
    }

    /// A negative answer is stored too, and the caller is told `false`.
    ///
    /// kills: a negative answer refused or left unstored; `Ok(true)` whatever the answer.
    #[test]
    fn a_negative_answer_is_stored_and_answered_false_lpw23_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        let (got, sent) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A, false, IP_NAME)));
        assert_eq!(got, Ok(false));
        assert_eq!(sent.len(), 1);
        assert!(
            accounts(&w).contains(&view(&account_row(alice(), HANDLE_A, false, NOW, false))),
            "alice's row says not entitled: {:?}",
            accounts(&w)
        );
    }

    /// A `world` build asks the production service: the URL is the profile's, not a constant
    /// of the module, asked over the IPv4 family the world's `ip:` name carries.
    ///
    /// kills: the URL hard-coded to the dev service.
    #[test]
    fn a_world_build_asks_the_production_service_lpw23_1() {
        let fx = fixture();
        let _w = owned_world(&fx);
        let mut http = HttpQueue::new();
        http.push(ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        let got = check_as(&fx, alice(), NOW, &mut http, &world_profile(), &ticket());
        assert_eq!(got, Ok(true));
        assert_eq!(http.requests().len(), 1);
        assert_eq!(
            http.requests()[0].url,
            "https://ipv4.auth.monster-realm.invalid/world/check"
        );
    }

    /// The shipped procedure runs as this build's profile: on the `test` build it asks the
    /// hosted-dev service and stores the row.
    ///
    /// kills: `check_account` not wired to `check_account_under`.
    #[cfg(all(
        feature = "open_join",
        not(feature = "official"),
        not(feature = "world")
    ))]
    #[test]
    fn the_shipped_procedure_checks_under_the_builds_own_profile_lpw23_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        let mut http = HttpQueue::new();
        http.push(ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        let got = fx.run_procedure(Caller::Sender(alice()), at(NOW), &mut http, |ctx| {
            check_account(ctx, ticket())
        });
        assert_eq!(got, Ok(true));
        assert_eq!(
            http.requests()[0].url,
            "https://ipv4.auth.monster-realm.spookyowltech.com/world/check"
        );
        assert!(accounts(&w).contains(&view(&account_row(alice(), HANDLE_A, true, NOW, false))));
    }

    /// A caller already holding the answered handle has its row updated in `entitled` and
    /// `checked_at_ms` only: `is_host` keeps what it held.
    ///
    /// kills: a second row inserted; `is_host` reset; the stored time kept.
    #[test]
    fn a_caller_holding_the_answered_handle_is_updated_in_entitlement_and_time_only_lpw23_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            false,
            T0 - 86_400_000,
            true,
        ));
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        assert_eq!(got, Ok(true));
        assert_eq!(
            accounts(&w),
            sorted(vec![
                view(&account_row(alice(), HANDLE_A, true, NOW, true)),
                view(&account_row(bob(), HANDLE_B, true, T0 - 86_400_000, false)),
            ])
        );
    }

    /// The owner relays a check for [`alice`], whom a `Password` world does not admit: the
    /// row is stored for `who`, and the owner holds none.
    ///
    /// kills: the row stored for the caller; the relayed subject required to be admitted.
    #[test]
    fn the_owners_relay_stores_the_row_for_who_lpw23_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.access.seed(&rule_row(WorldAccessRule::Password));
        let mut http = HttpQueue::new();
        http.push(ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        let got = relay_as(
            &fx,
            owner(),
            alice(),
            NOW,
            &mut http,
            &test_profile(),
            &ticket(),
        );
        assert_eq!(got, Ok(true));
        assert_eq!(http.requests().len(), 1);
        assert_first_contact(
            &http.requests()[0],
            "https://ipv4.auth.monster-realm.spookyowltech.com/world/check",
            &ticket(),
            &[WORLD_NAME, IP_NAME],
        );
        let rows = accounts(&w);
        assert!(rows.contains(&view(&account_row(alice(), HANDLE_A, true, NOW, false))));
        assert!(
            rows.iter().all(|r| r.1 != owner().to_byte_array()),
            "the owner holds no row"
        );
    }

    /// Under `Allowlist`, the owner's own check lists its handle beside the list's rows.
    ///
    /// kills: the owner's rule of the binding not carried over to handles.
    #[test]
    fn under_allowlist_the_owners_own_check_lists_its_handle_lpw23_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.access.seed(&rule_row(WorldAccessRule::Allowlist));
        list(&w, &[HANDLE_B]);
        let mut http = HttpQueue::new();
        http.push(ok_answer(ticket_answer(HANDLE_OWNER, true, WORLD_NAME)));
        let got = check_as(&fx, owner(), NOW, &mut http, &test_profile(), &ticket());
        assert_eq!(got, Ok(true));
        assert_eq!(listed(&w), strings(&[HANDLE_B, HANDLE_OWNER]));
    }

    /// Under `Allowlist`, a joiner's check and a check outside `Allowlist` leave the list as it
    /// is, with no write.
    ///
    /// kills: every checked handle listed.
    #[test]
    fn a_joiners_check_and_a_check_outside_allowlist_write_no_list_row_lpw23_1() {
        for (rule, who, handle) in [
            (WorldAccessRule::Allowlist, alice(), HANDLE_A),
            (WorldAccessRule::Password, owner(), HANDLE_OWNER),
            (WorldAccessRule::Open, owner(), HANDLE_OWNER),
        ] {
            let fx = fixture();
            let w = owned_world(&fx);
            w.access.seed(&rule_row(rule));
            list(&w, &[HANDLE_A]);
            if rule != WorldAccessRule::Open {
                w.admission.seed(&admission_row(alice()));
            }
            fx.reset_writes();
            let mut http = HttpQueue::new();
            http.push(ok_answer(ticket_answer(handle, true, WORLD_NAME)));
            let got = check_as(&fx, who, NOW, &mut http, &test_profile(), &ticket());
            assert_eq!(got, Ok(true), "{rule:?}");
            assert_eq!(listed(&w), strings(&[HANDLE_A]), "{rule:?}");
            assert_eq!(
                fx.writes_to("world_allowlist"),
                0,
                "{rule:?}: no list write"
            );
        }
    }

    /// The owner's check under `Allowlist` onto a full list that lacks its handle is refused
    /// with no `world_account` row and no list write.
    ///
    /// kills: the list bound ignored; the row stored when the list refuses.
    #[test]
    fn under_allowlist_the_owners_check_onto_a_full_list_is_refused_lpw23_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.access.seed(&rule_row(WorldAccessRule::Allowlist));
        let full: Vec<String> = (0..256).map(|i| format!("k1.full{i:04}")).collect();
        let refs: Vec<&str> = full.iter().map(String::as_str).collect();
        list(&w, &refs);
        let rows_before = accounts(&w);
        fx.reset_writes();
        let mut http = HttpQueue::new();
        http.push(ok_answer(ticket_answer(HANDLE_OWNER, true, WORLD_NAME)));
        let got = check_as(&fx, owner(), NOW, &mut http, &test_profile(), &ticket());
        assert_eq!(got, Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS.to_string()));
        assert_eq!(accounts(&w), rows_before, "no account row");
        assert_eq!(fx.writes_to("world_account"), 0);
        assert_eq!(fx.writes_to("world_allowlist"), 0);
        assert_eq!(listed(&w).len(), 256);
    }

    /// An answered handle another identity holds, whose holder owns no character, is stored
    /// for the caller on the handle's one row, updated in place: the answer's entitlement at
    /// the check's time, and the holder keeps no row.
    ///
    /// kills: the held handle refused; a second row under one handle; the holder's row kept
    /// beside the caller's; the stored time or entitlement left at the holder's.
    #[test]
    fn a_handle_another_identity_holds_is_stored_for_the_caller_lpw23_1() {
        let fx = fixture();
        let m = super::character_move::move_world(&fx);
        m.c.accounts
            .seed(&account_row(bob(), HANDLE_B, false, T0 - 86_400_000, false));
        fx.reset_writes();
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_B, true, WORLD_NAME)));
        assert_eq!(got, Ok(true));
        assert_eq!(
            accounts(&m.c),
            vec![view(&account_row(alice(), HANDLE_B, true, NOW, false))]
        );
        assert_eq!(
            fx.writes_to("world_account"),
            1,
            "one write to world_account"
        );
    }

    /// A caller holding a row under another handle is refused, and its row stays.
    ///
    /// kills: the caller's row replaced at first contact.
    #[test]
    fn a_caller_holding_another_handle_is_refused_lpw23_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, T0 - 1_000, false));
        let before = accounts(&w);
        fx.reset_writes();
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A2, true, WORLD_NAME)));
        assert_eq!(got, Err(REJECT_IDENTITY_HOLDS_ANOTHER.to_string()));
        assert_eq!(accounts(&w), before);
        assert_eq!(fx.writes_to("world_account"), 0);
    }
}

// =====================================================================================
// First contact: the ticket's shape and the budget.
// =====================================================================================

mod ticket_and_budget {
    use super::*;

    /// Tickets that are not 43 URL-safe base64 characters.
    fn malformed() -> Vec<(&'static str, String)> {
        let good = ticket();
        let with = |c: char| format!("{}{c}", &good[..42]);
        vec![
            ("42 characters", good[..42].to_string()),
            ("44 characters", format!("{good}A")),
            ("a `+`", with('+')),
            ("a `/`", with('/')),
            ("a `=`", with('=')),
            ("a space", with(' ')),
            (
                "a non-ASCII letter",
                with(char::from_u32(0xE9).expect("a letter")),
            ),
            ("empty", String::new()),
        ]
    }

    /// Each malformed ticket is refused, by `check_account` and by the owner's relay, before
    /// any table is read: no request, no write.
    ///
    /// kills: no shape check; standard base64 accepted; a padded ticket accepted; a length
    /// bound off by one either way; a check that reads before judging the ticket.
    #[test]
    fn a_ticket_that_is_not_43_base64url_characters_is_refused_with_no_request_lpw23_2() {
        for (label, bad) in malformed() {
            let fx = fixture();
            let w = owned_world(&fx);
            w.budget.seed(&budget_row(T0, 3));
            fx.reset_writes();
            fx.reset_reads();
            let before = footprint(&fx, &w);
            let mut http = HttpQueue::new();
            assert_eq!(
                check_as(&fx, alice(), NOW, &mut http, &test_profile(), &bad),
                Err(REJECT_TICKET_MALFORMED.to_string()),
                "{label}"
            );
            assert_eq!(
                relay_as(&fx, owner(), alice(), NOW, &mut http, &test_profile(), &bad),
                Err(REJECT_TICKET_MALFORMED.to_string()),
                "{label}: relayed"
            );
            assert!(http.requests().is_empty(), "{label}: no request");
            assert_eq!(footprint(&fx, &w), before, "{label}: no write");
            assert_nothing_read(&fx, label);
        }
    }

    /// A ticket of exactly 43 characters of every kind the alphabet holds is sent.
    ///
    /// kills: `-` or `_` refused; digits refused.
    #[test]
    fn a_ticket_of_43_base64url_characters_is_sent_lpw23_2() {
        for good in [
            ALPHABET[..43].to_string(),
            ALPHABET[ALPHABET.len() - 43..].to_string(),
            "A".repeat(43),
        ] {
            let fx = fixture();
            let _w = owned_world(&fx);
            let mut http = HttpQueue::new();
            http.push(ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
            assert_eq!(
                check_as(&fx, alice(), NOW, &mut http, &test_profile(), &good),
                Ok(true),
                "{good}"
            );
            assert_eq!(body_of(&http.requests()[0])["ticket"], good.as_str());
        }
    }

    /// 30 redeems sent in one minute (60 000 ms) are each answered; the 31st in that minute is
    /// refused with no request and no write; the first one of the next minute is sent, and
    /// the budget row counts from 1 in it.
    ///
    /// kills: no budget; a bound of 29 or 31; a window that is not the minute; the budget
    /// charged on the refused call.
    #[test]
    fn the_31st_redeem_in_one_minute_is_refused_and_the_next_minute_sends_again_lpw23_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        let profile = test_profile();
        let mut http = HttpQueue::new();
        for n in 0..30u8 {
            http.push(ok_answer(ticket_answer(&pool_handle(n), true, WORLD_NAME)));
        }
        for n in 0..30u8 {
            let ms = T0 + i64::from(n) * 2_000;
            assert_eq!(
                check_as(&fx, pool(n), ms, &mut http, &profile, &ticket()),
                Ok(true),
                "redeem {}",
                n + 1
            );
        }
        assert_eq!(http.requests().len(), 30, "30 requests sent");
        assert_eq!(budget(&w), vec![(0, T0, 30)]);
        fx.reset_writes();
        let before = footprint(&fx, &w);
        assert_eq!(
            check_as(&fx, pool(30), T0 + 59_999, &mut http, &profile, &ticket()),
            Err(REJECT_CHECK_BUDGET.to_string()),
            "the 31st in the minute"
        );
        assert_eq!(http.requests().len(), 30, "the 31st sends no request");
        assert_eq!(footprint(&fx, &w), before, "the 31st writes nothing");
        http.push(ok_answer(ticket_answer(&pool_handle(30), true, WORLD_NAME)));
        assert_eq!(
            check_as(&fx, pool(30), T0 + 60_000, &mut http, &profile, &ticket()),
            Ok(true),
            "the first of the next minute"
        );
        assert_eq!(http.requests().len(), 31);
        assert_eq!(budget(&w), vec![(0, T0 + 60_000, 1)]);
    }

    /// A budget row of an earlier minute, however full, refuses nothing: the check is sent and
    /// the row counts 1 from the start of the check's minute.
    ///
    /// kills: the minute start not read; the count not reset in a new minute; the minute
    /// start taken as the check's own time.
    #[test]
    fn a_full_budget_of_an_earlier_minute_refuses_nothing_lpw23_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.budget.seed(&budget_row(T0 - 60_000, 30));
        let (got, sent) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        assert_eq!(got, Ok(true));
        assert_eq!(sent.len(), 1);
        assert_eq!(budget(&w), vec![(0, T0, 1)]);
    }

    /// A check refused before the charge spends none of the budget: with 29 spent, an
    /// unadmitted caller, a malformed ticket and an unnamed world each leave the row at 29,
    /// and the next admitted caller's check is sent as the 30th.
    ///
    /// kills: the budget charged before the admission, ticket or name checks.
    #[test]
    fn a_refusal_before_the_charge_spends_no_budget_lpw23_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.access.seed(&rule_row(WorldAccessRule::Password));
        w.admission.seed(&admission_row(carol()));
        w.budget.seed(&budget_row(T0, 29));
        let profile = test_profile();
        let mut http = HttpQueue::new();
        assert_eq!(
            check_as(&fx, alice(), NOW, &mut http, &profile, &ticket()),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        assert_eq!(
            check_as(&fx, carol(), NOW, &mut http, &profile, "short"),
            Err(REJECT_TICKET_MALFORMED.to_string())
        );
        assert_eq!(budget(&w), vec![(0, T0, 29)], "nothing spent");
        assert!(http.requests().is_empty());
        http.push(ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        assert_eq!(
            check_as(&fx, carol(), NOW, &mut http, &profile, &ticket()),
            Ok(true),
            "the 30th"
        );
        assert_eq!(budget(&w), vec![(0, T0, 30)]);
        drop(fx);

        let fx = fixture();
        let w = world(&fx);
        w.config.seed(&Config {
            id: 0,
            content_version: 0,
            owner_identity: owner(),
        });
        w.budget.seed(&budget_row(T0, 29));
        let mut http = HttpQueue::new();
        assert_eq!(
            check_as(&fx, alice(), NOW, &mut http, &profile, &ticket()),
            Err(REJECT_WORLD_UNNAMED.to_string()),
            "a world with no name"
        );
        assert!(http.requests().is_empty(), "no request");
        assert_eq!(budget(&w), vec![(0, T0, 29)], "nothing spent");
    }

    /// The owner's relay counts in the same budget and is never refused by it: with 30 spent
    /// it is sent and the row counts 31, and a client's own check is then refused.
    ///
    /// kills: the relay outside the budget; the relay refused by a full budget.
    #[test]
    fn the_owners_relay_shares_the_budget_and_is_never_refused_by_it_lpw23_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.budget.seed(&budget_row(T0, 30));
        let profile = test_profile();
        let mut http = HttpQueue::new();
        http.push(ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        assert_eq!(
            relay_as(&fx, owner(), alice(), NOW, &mut http, &profile, &ticket()),
            Ok(true)
        );
        assert_eq!(budget(&w), vec![(0, T0, 31)]);
        assert_eq!(
            check_as(&fx, carol(), NOW, &mut http, &profile, &ticket()),
            Err(REJECT_CHECK_BUDGET.to_string())
        );
        assert_eq!(http.requests().len(), 1, "the client's check sends nothing");
    }
}

// =====================================================================================
// First contact: an answer the check cannot use.
// =====================================================================================

mod bad_answers {
    use super::*;

    fn cases() -> Vec<(&'static str, Stubbed, &'static str)> {
        let good = |handle: &str| ticket_answer(handle, true, WORLD_NAME);
        let raw = |text: &str| -> Stubbed { Ok((200, text.to_string())) };
        let over_long = format!("k1.{}", "a".repeat(1022));
        let non_ascii = format!("k1.{}", char::from_u32(0xE9).expect("a letter"));
        vec![
            ("403", Ok((403, good(HANDLE_A))), REJECT_TICKET_REFUSED),
            ("500", Ok((500, good(HANDLE_A))), REJECT_CHECK_UNANSWERED),
            ("429", Ok((429, good(HANDLE_A))), REJECT_CHECK_UNANSWERED),
            ("201", Ok((201, good(HANDLE_A))), REJECT_CHECK_UNANSWERED),
            (
                "a transport error",
                Err("the request timed out".to_string()),
                REJECT_CHECK_UNANSWERED,
            ),
            ("not JSON", raw("not json at all"), REJECT_CHECK_UNANSWERED),
            ("an empty body", raw(""), REJECT_CHECK_UNANSWERED),
            ("null", raw("null"), REJECT_CHECK_UNANSWERED),
            (
                "an array",
                Ok((200, format!("[{}]", good(HANDLE_A)))),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "no handle",
                raw(r#"{"entitled":true,"address":"203.0.113.9","name":"ip:203.0.113.9:3000"}"#),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "no name",
                raw(r#"{"handle":"k1.AbCdEf0123456789-_","entitled":true}"#),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "no entitled",
                raw(r#"{"handle":"k1.AbCdEf0123456789-_","name":"ip:203.0.113.9:3000"}"#),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "entitled a string",
                raw(
                    r#"{"handle":"k1.AbCdEf0123456789-_","entitled":"true","name":"ip:203.0.113.9:3000"}"#,
                ),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "handle a number",
                raw(r#"{"handle":7,"entitled":true,"name":"ip:203.0.113.9:3000"}"#),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "name null",
                raw(r#"{"handle":"k1.AbCdEf0123456789-_","entitled":true,"name":null}"#),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "a repeated handle",
                raw(
                    r#"{"handle":"k1.AbCdEf0123456789-_","handle":"k1.other","entitled":true,"name":"ip:203.0.113.9:3000"}"#,
                ),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "an empty handle",
                Ok((200, good(""))),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "a handle with a space",
                Ok((200, good("k1.Ab Cd"))),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "a non-ASCII handle",
                Ok((200, good(&non_ascii))),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "a 1025-byte handle",
                Ok((200, good(&over_long))),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "a name the world does not hold",
                Ok((200, ticket_answer(HANDLE_A, true, OTHER_NAME))),
                REJECT_TICKET_REFUSED,
            ),
        ]
    }

    /// Each answer the check cannot use refuses the call with its constant and writes no
    /// `world_account` row, for an identity the world does not know and for one that holds a
    /// row (which stays byte for byte). The one request carries the 3 s timeout, and the
    /// budget charge for it stays spent.
    ///
    /// kills: a `403` read as no answer, or another status as a refusal; a status other than
    /// 200 accepted; a lenient reader (an array, a repeated or mistyped member, a missing
    /// member); a handle not judged as 1 to 1024 visible ASCII characters; the answered name
    /// not judged; a row written or touched on a failure; the budget charge rolled back.
    #[test]
    fn an_answer_the_check_cannot_use_refuses_and_changes_no_account_row_lpw23_3() {
        assert_eq!("k1.".len() + 1022, 1025, "fixture: the over-long handle");
        for holds_row in [false, true] {
            for (label, outcome, want) in cases() {
                let fx = fixture();
                let w = owned_world(&fx);
                if holds_row {
                    w.accounts.seed(&account_row(
                        alice(),
                        HANDLE_A,
                        false,
                        T0 - 86_400_000,
                        true,
                    ));
                }
                let before = accounts(&w);
                fx.reset_writes();
                let (got, sent) = alice_checks(&fx, answer_of(&outcome));
                let label = format!("{label}, holds a row: {holds_row}");
                assert_eq!(got, Err(want.to_string()), "{label}");
                assert_eq!(accounts(&w), before, "{label}: the rows stay");
                assert_eq!(fx.writes_to("world_account"), 0, "{label}: no write");
                assert_eq!(sent.len(), 1, "{label}: the one request");
                assert_eq!(
                    sent[0].timeout,
                    Some(TimeDuration::from_micros(3_000_000)),
                    "{label}: 3 s"
                );
                assert_eq!(budget(&w), vec![(0, T0, 1)], "{label}: the charge stays");
            }
        }
    }

    /// A handle of exactly 1024 visible ASCII characters is stored.
    ///
    /// kills: a bound below 1024.
    #[test]
    fn a_1024_byte_handle_is_stored_lpw23_3() {
        let fx = fixture();
        let w = owned_world(&fx);
        let longest = format!("k1.{}", "a".repeat(1021));
        assert_eq!(longest.len(), 1024, "fixture");
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(&longest, true, WORLD_NAME)));
        assert_eq!(got, Ok(true));
        assert!(accounts(&w).contains(&view(&account_row(alice(), &longest, true, NOW, false))));
    }
}

// =====================================================================================
// A row changed while the request waits.
// =====================================================================================

mod during_the_wait {
    use super::*;

    /// Another identity takes the answered handle while the request waits: the outcome is the
    /// one the rows after the wait call for, so the handle's one row is the caller's and the
    /// identity that took it during the wait is left a `world_move` row.
    ///
    /// kills: the handle judged from the first transaction's read (a second row inserted
    /// under the handle, or no `world_move` row for the identity holding it after the wait).
    #[test]
    fn a_handle_taken_during_the_wait_is_judged_as_held_after_the_wait_lpw23_4() {
        let fx = fixture();
        let m = super::character_move::move_world(&fx);
        let answer = ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)).while_waiting(|| {
            m.c.accounts
                .seed(&account_row(carol(), HANDLE_A, true, NOW, false));
        });
        let (got, _) = alice_checks(&fx, answer);
        assert_eq!(got, Ok(true));
        assert_eq!(
            accounts(&m.c),
            vec![view(&account_row(alice(), HANDLE_A, true, NOW, false))]
        );
        assert_eq!(moves(&m.c), vec![(carol().to_byte_array(), NOW)]);
    }

    /// The caller loses its admission row while the request waits on a `Password` world:
    /// refused with [`REJECT_NOT_ADMITTED`], no row.
    ///
    /// kills: admission judged only before the request.
    #[test]
    fn a_caller_whose_admission_goes_during_the_wait_is_refused_lpw23_4() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.access.seed(&rule_row(WorldAccessRule::Password));
        w.admission.seed(&admission_row(alice()));
        let answer = ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)).while_waiting(|| {
            assert_eq!(
                w.admission.remove(alice()),
                1,
                "the wait removes the admission"
            );
        });
        let (got, _) = alice_checks(&fx, answer);
        assert_eq!(got, Err(REJECT_NOT_ADMITTED.to_string()));
        assert!(accounts(&w).iter().all(|r| r.1 != alice().to_byte_array()));
    }

    /// The caller's account enters its deletion grace while the request waits: refused by the
    /// deletion gate, no row.
    ///
    /// kills: the deletion gate judged only before the request.
    #[test]
    fn a_caller_whose_deletion_starts_during_the_wait_is_refused_lpw23_4() {
        let fx = fixture();
        let w = owned_world(&fx);
        let answer = ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)).while_waiting(|| {
            w.account.seed(&deleting_account(alice()));
        });
        let (got, _) = alice_checks(&fx, answer);
        assert_eq!(got, Err(REJECT_DELETION_GATED.to_string()));
        assert!(accounts(&w).iter().all(|r| r.1 != alice().to_byte_array()));
    }

    /// The world changes owner while the owner's relay waits: refused with
    /// [`REJECT_NOT_WORLD_OWNER`], no row for `who`.
    ///
    /// kills: ownership judged only before the request.
    #[test]
    fn a_relay_whose_caller_stops_owning_the_world_during_the_wait_is_refused_lpw23_4() {
        let fx = fixture();
        let w = owned_world(&fx);
        let mut http = HttpQueue::new();
        http.push(
            ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)).while_waiting(|| {
                assert_eq!(w.config.remove(0), 1, "the wait removes the config row");
                w.config.seed(&Config {
                    id: 0,
                    content_version: 0,
                    owner_identity: carol(),
                });
            }),
        );
        let got = relay_as(
            &fx,
            owner(),
            alice(),
            NOW,
            &mut http,
            &test_profile(),
            &ticket(),
        );
        assert_eq!(got, Err(REJECT_NOT_WORLD_OWNER.to_string()));
        assert!(accounts(&w).iter().all(|r| r.1 != alice().to_byte_array()));
    }

    /// The answered name leaves the world while the request waits: refused with
    /// [`REJECT_TICKET_REFUSED`]; and a name the world gains during the wait is accepted.
    ///
    /// kills: the name judged against the first transaction's names.
    #[test]
    fn the_answered_name_is_judged_as_the_world_holds_it_after_the_wait_lpw23_4() {
        let fx = fixture();
        let w = owned_world(&fx);
        let answer = ok_answer(ticket_answer(HANDLE_A, true, IP_NAME)).while_waiting(|| {
            assert_eq!(
                w.names.remove(IP_NAME.to_string()),
                1,
                "the wait removes the name"
            );
        });
        let (got, _) = alice_checks(&fx, answer);
        assert_eq!(
            got,
            Err(REJECT_TICKET_REFUSED.to_string()),
            "a name removed"
        );
        assert!(accounts(&w).iter().all(|r| r.1 != alice().to_byte_array()));
        drop(fx);

        let fx = fixture();
        let w = owned_world(&fx);
        let answer = ok_answer(ticket_answer(HANDLE_A, true, OTHER_NAME)).while_waiting(|| {
            w.names.seed(&WorldName {
                name: OTHER_NAME.to_string(),
            });
        });
        let (got, _) = alice_checks(&fx, answer);
        assert_eq!(got, Ok(true), "a name added");
    }

    /// The re-checked row is unbound while the re-check waits: no account row is written.
    ///
    /// kills: the answer written from the first transaction's row.
    #[test]
    fn a_row_unbound_during_the_recheck_writes_nothing_lpw23_4() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            false,
            T0 - 86_400_000,
            false,
        ));
        let mut http = HttpQueue::new();
        http.push(ok_answer(handle_answer(HANDLE_A, true)).while_waiting(|| {
            assert_eq!(w.accounts.remove(alice()), 1, "the wait unbinds alice");
        }));
        let before_writes = fx.writes_to("world_account");
        let got = recheck_as(
            &fx,
            Caller::Database,
            NOW,
            &mut http,
            &test_profile(),
            recheck_of(alice(), 1),
        );
        assert_eq!(got, Ok(()));
        assert!(accounts(&w).iter().all(|r| r.1 != alice().to_byte_array()));
        assert_eq!(fx.writes_to("world_account"), before_writes, "no write");
    }

    /// A newer first contact replaces the re-checked row while the re-check waits (a later
    /// `checked_at_ms`): the older answer is not written over it.
    ///
    /// kills: an older answer overwriting a newer one.
    #[test]
    fn a_row_checked_again_during_the_recheck_keeps_the_newer_check_lpw23_4() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            false,
            T0 - 86_400_000,
            false,
        ));
        let mut http = HttpQueue::new();
        http.push(ok_answer(handle_answer(HANDLE_A, true)).while_waiting(|| {
            assert_eq!(w.accounts.remove(alice()), 1);
            w.accounts
                .seed(&account_row(alice(), HANDLE_A, false, NOW - 1, false));
        }));
        let got = recheck_as(
            &fx,
            Caller::Database,
            NOW,
            &mut http,
            &test_profile(),
            recheck_of(alice(), 1),
        );
        assert_eq!(got, Ok(()));
        assert!(
            accounts(&w).contains(&view(&account_row(
                alice(),
                HANDLE_A,
                false,
                NOW - 1,
                false
            ))),
            "the newer row stays as it is: {:?}",
            accounts(&w)
        );
    }
}

// =====================================================================================
// Each later connection: the arming and the re-check.
// =====================================================================================

mod recheck {
    use super::*;

    fn armed(w: &W<'_>) -> Vec<[u8; 32]> {
        sorted(
            w.rechecks
                .rows()
                .into_iter()
                .map(|r| r.identity.to_byte_array())
                .collect(),
        )
    }

    /// On a build that names no service the arming arms nothing, while the same row on the
    /// `test` build arms one re-check firing at the call's time.
    ///
    /// kills: arming that ignores the profile.
    #[test]
    fn the_arming_arms_nothing_on_a_build_that_names_no_service_lpw23_5() {
        for profile in checkless_profiles() {
            let fx = fixture();
            let w = owned_world(&fx);
            w.accounts.seed(&account_row(
                alice(),
                HANDLE_A,
                true,
                NOW - 3_600_000,
                false,
            ));
            fx.run_as_at(alice(), at(NOW), |ctx| {
                arm_recheck_at_connect(ctx, &profile)
            });
            assert_eq!(armed(&w), Vec::<[u8; 32]>::new(), "{}", profile.name);
        }
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            true,
            NOW - 3_600_000,
            false,
        ));
        fx.run_as_at(alice(), at(NOW), |ctx| {
            arm_recheck_at_connect(ctx, &test_profile())
        });
        let rows = w.rechecks.rows();
        assert_eq!(rows.len(), 1, "the control arms one");
        assert_eq!(rows[0].identity, alice());
        assert!(
            matches!(rows[0].scheduled_at, ScheduleAt::Time(t) if t == at(NOW)),
            "it fires at the call's time"
        );
    }

    /// The re-check of a stored row asks about its handle and stores the answer: entitled,
    /// then not entitled, each at the run's time.
    ///
    /// kills: the inert procedure; the request carrying the ticket shape; the answer not
    /// stored; the time not stored.
    #[test]
    fn the_recheck_asks_about_the_stored_handle_and_stores_the_answer_lpw23_5() {
        for (stored, answered) in [(false, true), (true, false)] {
            let fx = fixture();
            let w = owned_world(&fx);
            w.accounts.seed(&account_row(
                alice(),
                HANDLE_A,
                stored,
                T0 - 86_400_000,
                false,
            ));
            w.rechecks.seed(&recheck_of(alice(), 1));
            let mut http = HttpQueue::new();
            http.push(ok_answer(handle_answer(HANDLE_A, answered)));
            let got = recheck_as(
                &fx,
                Caller::Database,
                NOW,
                &mut http,
                &test_profile(),
                recheck_of(alice(), 1),
            );
            assert_eq!(got, Ok(()), "answered {answered}");
            assert_eq!(http.requests().len(), 1);
            assert_recheck_request(
                &http.requests()[0],
                "https://ipv4.auth.monster-realm.spookyowltech.com/world/check",
                HANDLE_A,
            );
            assert_eq!(
                accounts(&w),
                sorted(vec![
                    view(&account_row(alice(), HANDLE_A, answered, NOW, false)),
                    view(&account_row(bob(), HANDLE_B, true, T0 - 86_400_000, false)),
                ]),
                "answered {answered}"
            );
            assert_eq!(
                fx.writes_to("recheck_schedule"),
                0,
                "the run writes no schedule row"
            );
        }
    }

    /// The service does not know the handle: the row says not entitled, whatever the
    /// answer's `entitled` says, its handle kept and its time the run's.
    ///
    /// kills: an unknown handle's `entitled: true` believed; the row erased.
    #[test]
    fn an_unknown_handle_is_stored_as_not_entitled_lpw23_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, T0 - 86_400_000, true));
        let mut http = HttpQueue::new();
        http.push(ok_answer(unknown_handle_answer(true)));
        let got = recheck_as(
            &fx,
            Caller::Database,
            NOW,
            &mut http,
            &test_profile(),
            recheck_of(alice(), 1),
        );
        assert_eq!(got, Ok(()));
        assert!(
            accounts(&w).contains(&view(&account_row(alice(), HANDLE_A, false, NOW, true))),
            "{:?}",
            accounts(&w)
        );
    }

    /// A failed re-check (a transport error, a status other than 200, a body that does not
    /// parse) is refused and changes nothing: the row and the armed schedule row stay, and
    /// the run writes no table.
    ///
    /// kills: a failure stored as not entitled; the schedule re-armed by the run.
    #[test]
    fn a_failed_recheck_leaves_the_status_and_arms_nothing_lpw23_5() {
        let failures: Vec<(&str, Stubbed)> = vec![
            (
                "a transport error",
                Err("the request timed out".to_string()),
            ),
            ("500", Ok((500, handle_answer(HANDLE_A, false)))),
            ("403", Ok((403, handle_answer(HANDLE_A, false)))),
            ("not JSON", Ok((200, "nope".to_string()))),
            (
                "an array",
                Ok((200, format!("[{}]", handle_answer(HANDLE_A, false)))),
            ),
            (
                "entitled a string",
                Ok((
                    200,
                    r#"{"handle":"k1.AbCdEf0123456789-_","entitled":"no"}"#.to_string(),
                )),
            ),
            (
                "a 1025-byte handle",
                Ok((
                    200,
                    handle_answer(&format!("k1.{}", "a".repeat(1022)), false),
                )),
            ),
        ];
        for (label, outcome) in failures {
            let fx = fixture();
            let w = owned_world(&fx);
            w.accounts.seed(&account_row(
                alice(),
                HANDLE_A,
                true,
                T0 - 86_400_000,
                false,
            ));
            w.rechecks.seed(&recheck_of(alice(), 1));
            fx.reset_writes();
            let before = footprint(&fx, &w);
            let mut http = HttpQueue::new();
            http.push(answer_of(&outcome));
            let got = recheck_as(
                &fx,
                Caller::Database,
                NOW,
                &mut http,
                &test_profile(),
                recheck_of(alice(), 1),
            );
            assert_eq!(got, Err(REJECT_CHECK_UNANSWERED.to_string()), "{label}");
            assert_eq!(footprint(&fx, &w), before, "{label}: nothing changes");
        }
    }

    /// A re-check of an identity that holds no row sends nothing and writes nothing.
    ///
    /// kills: a request with an empty handle.
    #[test]
    fn a_recheck_of_an_identity_with_no_row_sends_nothing_lpw23_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        fx.reset_writes();
        let before = footprint(&fx, &w);
        let mut http = HttpQueue::new();
        let got = recheck_as(
            &fx,
            Caller::Database,
            NOW,
            &mut http,
            &test_profile(),
            recheck_of(alice(), 1),
        );
        assert_eq!(got, Ok(()));
        assert!(http.requests().is_empty());
        assert_eq!(footprint(&fx, &w), before);
    }

    /// While a re-check is armed and unanswered, the door admits by the stored status: an
    /// entitled row passes `require_entitled` on the enforcing build, an unentitled one is
    /// refused.
    ///
    /// kills: an armed re-check that suspends the stored status.
    #[test]
    fn the_stored_status_admits_while_a_recheck_is_armed_lpw23_5() {
        for (entitled, want) in [
            (true, Ok(())),
            (false, Err(ERR_OWNERSHIP_REQUIRED.to_string())),
        ] {
            let fx = fixture();
            let w = owned_world(&fx);
            w.accounts.seed(&account_row(
                alice(),
                HANDLE_A,
                entitled,
                T0 - 86_400_000,
                false,
            ));
            w.rechecks.seed(&recheck_of(alice(), 1));
            let got = fx.run_as_conn_at(alice(), 0xACC7_0001, None, at(NOW), |ctx| {
                crate::accounts::require_entitled(ctx, &dev_enforcing(), "join_game")
            });
            assert_eq!(got, want, "stored entitled {entitled}");
        }
    }
}

// =====================================================================================
// A newer key: the handle is replaced.
// =====================================================================================

mod newer_key {
    use super::*;

    fn run(fx: &Fixture, answer: String) -> Result<(), String> {
        let mut http = HttpQueue::new();
        http.push(ok_answer(answer));
        recheck_as(
            fx,
            Caller::Database,
            NOW,
            &mut http,
            &test_profile(),
            recheck_of(alice(), 1),
        )
    }

    /// An answer under a newer key replaces alice's row by one under the new handle (its
    /// `is_host` kept) and her listed handle by the new one, in the one write transaction:
    /// the run commits exactly two transactions, the read and the write.
    ///
    /// kills: the first row kept beside the new; the list left naming the first handle; the
    /// list written in a third transaction; `is_host` reset.
    #[test]
    fn a_newer_handle_replaces_the_row_and_the_list_entry_in_one_transaction_lpw23_6() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            false,
            T0 - 86_400_000,
            true,
        ));
        list(&w, &[HANDLE_A, HANDLE_B]);
        assert_eq!(fx.procedure_commits(), 0, "fixture");
        assert_eq!(run(&fx, handle_answer(HANDLE_A2, true)), Ok(()));
        assert_eq!(
            accounts(&w),
            sorted(vec![
                view(&account_row(alice(), HANDLE_A2, true, NOW, true)),
                view(&account_row(bob(), HANDLE_B, true, T0 - 86_400_000, false)),
            ])
        );
        assert_eq!(listed(&w), strings(&[HANDLE_A2, HANDLE_B]));
        assert_eq!(fx.procedure_commits(), 2, "the read and the one write");
    }

    /// An old handle that is not listed adds no list entry.
    ///
    /// kills: the new handle listed whatever the list held.
    #[test]
    fn an_unlisted_old_handle_adds_no_list_entry_lpw23_6() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            true,
            T0 - 86_400_000,
            false,
        ));
        list(&w, &[HANDLE_B]);
        fx.reset_writes();
        assert_eq!(run(&fx, handle_answer(HANDLE_A2, true)), Ok(()));
        assert_eq!(listed(&w), strings(&[HANDLE_B]));
        assert_eq!(fx.writes_to("world_allowlist"), 0);
        assert!(accounts(&w).contains(&view(&account_row(alice(), HANDLE_A2, true, NOW, false))));
    }

    /// A new handle already listed is not listed twice; the replaced one leaves the list.
    ///
    /// kills: a second insert of the new handle.
    #[test]
    fn a_new_handle_already_listed_is_not_listed_twice_lpw23_6() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            true,
            T0 - 86_400_000,
            false,
        ));
        list(&w, &[HANDLE_A, HANDLE_A2]);
        assert_eq!(run(&fx, handle_answer(HANDLE_A2, true)), Ok(()));
        assert_eq!(listed(&w), strings(&[HANDLE_A2]));
    }

    /// A new handle another identity holds: alice's standing is stored on her row under the
    /// handle it has, the other identity's row stays, and the list is not written.
    ///
    /// kills: the other identity's row overwritten; a second row under one handle; the
    /// standing dropped.
    #[test]
    fn a_new_handle_another_identity_holds_stores_the_standing_on_the_old_row_lpw23_6() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            false,
            T0 - 86_400_000,
            false,
        ));
        list(&w, &[HANDLE_A, HANDLE_B]);
        fx.reset_writes();
        assert_eq!(run(&fx, handle_answer(HANDLE_B, true)), Ok(()));
        assert_eq!(
            accounts(&w),
            sorted(vec![
                view(&account_row(alice(), HANDLE_A, true, NOW, false)),
                view(&account_row(bob(), HANDLE_B, true, T0 - 86_400_000, false)),
            ])
        );
        assert_eq!(listed(&w), strings(&[HANDLE_A, HANDLE_B]));
        assert_eq!(fx.writes_to("world_allowlist"), 0);
    }
}

// =====================================================================================
// Who may run which procedure, and the build that checks nothing.
// =====================================================================================

mod callers {
    use super::*;

    /// A caller that is not the owner is refused the relay with no request and no write.
    ///
    /// kills: the relay open to any caller; an owner check after the request.
    #[test]
    fn anyone_but_the_owner_is_refused_the_relay_with_no_request_lpw23_8() {
        for caller in [alice(), bob(), Identity::from_byte_array([0xDB; 32])] {
            let fx = fixture();
            let w = owned_world(&fx);
            fx.reset_writes();
            let before = footprint(&fx, &w);
            let mut http = HttpQueue::new();
            assert_eq!(
                relay_as(
                    &fx,
                    caller,
                    carol(),
                    NOW,
                    &mut http,
                    &test_profile(),
                    &ticket()
                ),
                Err(REJECT_NOT_WORLD_OWNER.to_string())
            );
            assert!(http.requests().is_empty(), "no request");
            assert_eq!(footprint(&fx, &w), before, "no write");
        }
    }

    /// A client, the owner included, is refused `recheck_account` with no request and no
    /// write; only the database runs it.
    ///
    /// kills: the re-check open to clients.
    #[test]
    fn anyone_but_the_database_is_refused_the_recheck_with_no_request_lpw23_8() {
        for caller in [alice(), owner()] {
            let fx = fixture();
            let w = owned_world(&fx);
            w.accounts.seed(&account_row(
                alice(),
                HANDLE_A,
                false,
                T0 - 86_400_000,
                false,
            ));
            fx.reset_writes();
            let before = footprint(&fx, &w);
            let mut http = HttpQueue::new();
            assert_eq!(
                recheck_as(
                    &fx,
                    Caller::Sender(caller),
                    NOW,
                    &mut http,
                    &test_profile(),
                    recheck_of(alice(), 1),
                ),
                Err(REJECT_NOT_DATABASE.to_string())
            );
            assert!(http.requests().is_empty(), "no request");
            assert_eq!(footprint(&fx, &w), before, "no write");
        }
    }

    /// On `official`, `conflict` and `default` every procedure refuses with
    /// [`REJECT_BUILD_CHECKS_NOTHING`] as its first statement: a malformed ticket and a
    /// client's re-check get the build refusal too, and nothing is sent, read or written.
    ///
    /// kills: the build refusal after any other check; a read before it.
    #[test]
    fn a_build_that_names_no_service_refuses_every_procedure_first_lpw23_8() {
        for profile in checkless_profiles() {
            let fx = fixture();
            let w = owned_world(&fx);
            w.accounts.seed(&account_row(
                alice(),
                HANDLE_A,
                false,
                T0 - 86_400_000,
                false,
            ));
            fx.reset_writes();
            fx.reset_reads();
            let before = footprint(&fx, &w);
            let mut http = HttpQueue::new();
            let refused = Err(REJECT_BUILD_CHECKS_NOTHING.to_string());
            for bad in [ticket(), "short".to_string()] {
                assert_eq!(
                    check_as(&fx, alice(), NOW, &mut http, &profile, &bad),
                    refused.clone(),
                    "{}: check_account",
                    profile.name
                );
                assert_eq!(
                    relay_as(&fx, owner(), alice(), NOW, &mut http, &profile, &bad),
                    refused.clone(),
                    "{}: check_account_for",
                    profile.name
                );
            }
            for caller in [Caller::Database, Caller::Sender(alice())] {
                assert_eq!(
                    recheck_as(
                        &fx,
                        caller,
                        NOW,
                        &mut http,
                        &profile,
                        recheck_of(alice(), 1)
                    )
                    .map(|()| true),
                    refused.clone(),
                    "{}: recheck_account",
                    profile.name
                );
            }
            assert!(http.requests().is_empty(), "{}: no request", profile.name);
            assert_eq!(footprint(&fx, &w), before, "{}: no write", profile.name);
            assert_nothing_read(&fx, profile.name);
        }
    }

    /// An unadmitted caller, a caller pending deletion, a relay for a `who` pending deletion
    /// and a check on a world with no name are refused before the request: no request, no
    /// write.
    ///
    /// kills: a gate missing; a gate judged only after the request.
    #[test]
    fn the_gates_before_the_request_refuse_with_no_request_lpw23_8() {
        let cases: Vec<(&str, &str)> = vec![
            ("unadmitted", REJECT_NOT_ADMITTED),
            ("caller deleting", REJECT_DELETION_GATED),
            ("who deleting", REJECT_DELETION_GATED),
            ("unnamed", REJECT_WORLD_UNNAMED),
        ];
        for (label, want) in cases {
            let fx = fixture();
            let w = if label == "unnamed" {
                let w = world(&fx);
                w.config.seed(&Config {
                    id: 0,
                    content_version: 0,
                    owner_identity: owner(),
                });
                w
            } else {
                owned_world(&fx)
            };
            match label {
                "unadmitted" => w.access.seed(&rule_row(WorldAccessRule::Password)),
                "caller deleting" | "who deleting" => {
                    w.account.seed(&deleting_account(alice()));
                }
                _ => {}
            }
            fx.reset_writes();
            let before = footprint(&fx, &w);
            let mut http = HttpQueue::new();
            let got = if label == "who deleting" {
                relay_as(
                    &fx,
                    owner(),
                    alice(),
                    NOW,
                    &mut http,
                    &test_profile(),
                    &ticket(),
                )
            } else {
                check_as(&fx, alice(), NOW, &mut http, &test_profile(), &ticket())
            };
            assert_eq!(got, Err(want.to_string()), "{label}");
            assert!(http.requests().is_empty(), "{label}: no request");
            assert_eq!(footprint(&fx, &w), before, "{label}: no write");
        }
    }
}

// =====================================================================================
// The unbind and the view.
// =====================================================================================

mod own_row {
    use super::*;

    fn seen(fx: &Fixture, who: Identity) -> Vec<AccountView> {
        fx.call_view::<WorldAccount>(VIEW_MY_WORLD_ACCOUNT, who)
            .iter()
            .map(view)
            .collect()
    }

    /// The unbind erases the caller's `world_account` row and its armed re-check, and no
    /// other identity's.
    ///
    /// kills: an unbind blind to `world_account`; the re-check left armed; the bystander's
    /// rows erased.
    #[test]
    fn the_unbind_erases_the_callers_own_account_row_and_recheck_only_lpw23_10() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, T0 - 1_000, false));
        w.rechecks.seed(&recheck_of(alice(), 1));
        w.rechecks.seed(&recheck_of(bob(), 2));
        let got = fx.run_as_conn_at(alice(), 0xACC7_0002, None, at(NOW), |ctx| {
            crate::world_binding::unbind_world_account(ctx)
        });
        assert_eq!(got, Ok(()));
        assert_eq!(
            accounts(&w),
            vec![view(&account_row(
                bob(),
                HANDLE_B,
                true,
                T0 - 86_400_000,
                false
            ))]
        );
        let armed: Vec<[u8; 32]> = w
            .rechecks
            .rows()
            .into_iter()
            .map(|r| r.identity.to_byte_array())
            .collect();
        assert_eq!(armed, vec![bob().to_byte_array()]);
    }

    /// Each identity reads its own row alone through `my_world_account`; a stranger reads
    /// none; after alice's unbind she reads none and bob still reads his.
    ///
    /// kills: a view answering every row, another identity's, or none.
    #[test]
    fn my_world_account_answers_the_senders_own_row_alone_lpw23_11() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, T0 - 1_000, true));
        let alice_row = view(&account_row(alice(), HANDLE_A, true, T0 - 1_000, true));
        let bob_row = view(&account_row(bob(), HANDLE_B, true, T0 - 86_400_000, false));
        assert_eq!(seen(&fx, alice()), vec![alice_row]);
        assert_eq!(seen(&fx, bob()), vec![bob_row.clone()]);
        assert_eq!(seen(&fx, carol()), Vec::<AccountView>::new());
        let got = fx.run_as_conn_at(alice(), 0xACC7_0003, None, at(NOW), |ctx| {
            crate::world_binding::unbind_world_account(ctx)
        });
        assert_eq!(got, Ok(()));
        assert_eq!(
            seen(&fx, alice()),
            Vec::<AccountView>::new(),
            "after the unbind"
        );
        assert_eq!(seen(&fx, bob()), vec![bob_row], "bob's row stays");
    }
}

// =====================================================================================
// One character per account: a ticket for a handle another identity holds moves that
// identity's character to the identity the ticket is redeemed for.
// =====================================================================================

mod character_move {
    use super::*;
    use crate::marshal::pub_from_monster;
    use crate::native_host_tests::VIEW_MY_WORLD_MOVE;
    use crate::playtest::PlaytestEvent;
    use crate::privacy::ExportBundleReaperSchedule;
    use crate::pvp::BattleChallengeReaperSchedule;
    use crate::schema::{
        Battle, BattleChallenge, BattleClock, BattleDeploy, BattleQueue, BattleSummary, BattleUnit,
        ChallengeStatus, Character, DeletionPolicy, EvolutionRevealRow, ExportBundle, HealCooldown,
        Inventory, LastPosition, LeaderboardTop, Monster, MonsterPub, MoveIntent,
        PendingEvolutionNotice, Player, PlayerConversation, PlayerDialogueStateRow,
        PlayerFormation, PlayerHandle, PlayerQuestRow, PlayerSession, PlayerWallet, Profile,
        TradeOffer, TradeSession, WorldAdmissionAttempt, DATA_LIFECYCLE_MANIFEST,
    };
    use game_core::tactics::tuning::BattleKind;
    use game_core::{BattleOutcome, Direction};
    use spacetimedb::ConnectionId;
    use std::collections::{BTreeMap, BTreeSet};

    /// A `dns:` name; a test that answers with it seeds it in `world_name`.
    const DNS_NAME: &str = "dns:realm-one.example.net";
    /// A second check-in, an hour after [`NOW`].
    const LATER: i64 = NOW + 3_600_000;

    const SRC_MONSTERS: [u64; 2] = [901, 902];
    /// `(inv_id, item_id, count)` of each stack the source holds.
    const SRC_STACKS: [(u64, u32, u32); 2] = [(911, 4, 3), (912, 7, 1)];
    const SRC_QUEST: u64 = 921;
    const SRC_BALANCE: u64 = 1_234;
    const SRC_DISCRIMINATOR: u32 = 9_100_051;
    /// The source's outgoing and incoming challenges.
    const CH_OUT: u64 = 941;
    const CH_IN: u64 = 942;
    const SRC_CHUNK: u64 = 951;
    const FINISHED_BATTLE: u64 = 700;
    const LIVE_ENTITY: u64 = 77;
    const BYSTANDER_ENTITY: u64 = 78;
    const BYSTANDER_MONSTER: u64 = 931;

    // ---------------------------------------------------------------------------------
    // The world: the check tables plus every table the move reads or writes.
    // ---------------------------------------------------------------------------------

    pub(super) struct MW<'a> {
        pub(super) c: W<'a>,
        binding: Handle<'a, WorldBinding>,
        bind_nonce: Handle<'a, WorldBindNonce>,
        admission_attempt: Handle<'a, WorldAdmissionAttempt>,
        player: Handle<'a, Player>,
        session: Handle<'a, PlayerSession>,
        character: Handle<'a, Character, u64>,
        intent: Handle<'a, MoveIntent, u64>,
        monster: Handle<'a, Monster>,
        monster_pub: Handle<'a, MonsterPub, u64>,
        notice: Handle<'a, PendingEvolutionNotice>,
        inventory: Handle<'a, Inventory>,
        quest: Handle<'a, PlayerQuestRow>,
        dialogue: Handle<'a, PlayerDialogueStateRow>,
        conversation: Handle<'a, PlayerConversation>,
        heal: Handle<'a, HealCooldown>,
        last_position: Handle<'a, LastPosition>,
        wallet: Handle<'a, PlayerWallet>,
        profile: Handle<'a, Profile>,
        ladder: Handle<'a, LeaderboardTop>,
        formation: Handle<'a, PlayerFormation>,
        handle: Handle<'a, PlayerHandle>,
        challenge: Handle<'a, BattleChallenge>,
        challenge_reaper: Handle<'a, BattleChallengeReaperSchedule, u64>,
        export: Handle<'a, ExportBundle>,
        export_reaper: Handle<'a, ExportBundleReaperSchedule, u64>,
        battle: Handle<'a, Battle>,
        summary: Handle<'a, BattleSummary, u64>,
        unit: Handle<'a, BattleUnit, u64>,
        queue: Handle<'a, BattleQueue, u64>,
        deploy: Handle<'a, BattleDeploy, u64>,
        clock: Handle<'a, BattleClock, u64>,
        playtest: Handle<'a, PlaytestEvent, u64>,
        trade: Handle<'a, TradeOffer>,
        trade_session: Handle<'a, TradeSession, u64>,
    }

    /// An `Open` world owned by [`owner`] and named [`WORLD_NAME`] and [`IP_NAME`], holding no
    /// account row, with every index the move, the guards and the redeem read or write through
    /// registered (writable where a path writes, scannable where it scans).
    pub(super) fn move_world(fx: &Fixture) -> MW<'_> {
        let c = world(fx);
        c.config.seed(&Config {
            id: 0,
            content_version: 0,
            owner_identity: owner(),
        });
        for name in [WORLD_NAME, IP_NAME] {
            c.names.seed(&WorldName {
                name: name.to_string(),
            });
        }
        let _ =
            fx.table_keyed::<PlayerSession, ConnectionId>("player_session", "connection_id", |r| {
                r.connection_id
            });
        let _ = fx.table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id);
        let _ = fx.table_composite::<Monster, Identity, u8>(
            "monster",
            ["owner_identity", "party_slot"],
            |r| (r.owner_identity, r.party_slot),
        );
        let _ = fx.table::<MonsterPub>("monster_pub", "owner_identity", |r| r.owner_identity);
        let _ = fx.table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id);
        let _ = fx.table_keyed::<PlayerQuestRow, u64>("player_quest", "pq_id", |r| r.pq_id);
        let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
        let _ = fx.table_keyed::<TradeOffer, u64>("trade_offer", "trade_id", |r| r.trade_id);
        let _ = fx.table::<BattleChallenge>("battle_challenge", "target", |r| r.target);
        let _ = fx.table_keyed::<BattleChallenge, u64>("battle_challenge", "challenge_id", |r| {
            r.challenge_id
        });
        let _ = fx.table_keyed::<BattleChallengeReaperSchedule, u64>(
            "battle_challenge_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        );
        let _ = fx.table_keyed::<ExportBundle, u64>("export_bundle", "chunk_id", |r| r.chunk_id);
        let _ = fx.table_keyed::<ExportBundle, i64>("export_bundle", "created_at_ms", |r| {
            r.created_at_ms
        });
        let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
        let _ = fx.table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id);
        let _ =
            fx.table::<BattleSummary>("battle_summary", "player_identity", |r| r.player_identity);
        let _ = fx.table::<BattleSummary>("battle_summary", "opponent_identity", |r| {
            r.opponent_identity
        });
        let _ = fx.table::<TradeSession>("trade_session", "opener", |r| r.opener);
        let _ = fx.table::<TradeSession>("trade_session", "partner", |r| r.partner);
        let handle = fx
            .table::<PlayerHandle>("player_handle", "owner_identity", |r| r.owner_identity)
            .writable()
            .unique()
            .auto_inc(
                |r| u64::from(r.discriminator),
                |r, v| {
                    r.discriminator = u32::try_from(v).expect("a test sequence value fits a u32")
                },
            );
        let _ = fx
            .table_keyed::<PlayerHandle, u32>("player_handle", "discriminator", |r| r.discriminator)
            .unique();
        let profile = fx
            .table::<Profile>("profile", "identity", |r| r.identity)
            .writable();
        MW {
            binding: fx
                .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
                .unique()
                .writable(),
            bind_nonce: fx
                .table::<WorldBindNonce>("world_bind_nonce", "identity", |r| r.identity)
                .unique()
                .writable(),
            admission_attempt: fx
                .table::<WorldAdmissionAttempt>("world_admission_attempt", "identity", |r| {
                    r.identity
                })
                .unique()
                .writable(),
            player: fx
                .table::<Player>("player", "identity", |r| r.identity)
                .writable(),
            session: fx
                .table::<PlayerSession>("player_session", "identity", |r| r.identity)
                .writable(),
            character: fx
                .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
                .writable(),
            intent: fx
                .table_keyed::<MoveIntent, u64>("move_intent", "entity_id", |r| r.entity_id)
                .writable(),
            monster: fx
                .table::<Monster>("monster", "owner_identity", |r| r.owner_identity)
                .writable(),
            monster_pub: fx
                .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
                .writable(),
            notice: fx
                .table::<PendingEvolutionNotice>(
                    "pending_evolution_notice",
                    "owner_identity",
                    |r| r.owner_identity,
                )
                .writable(),
            inventory: fx
                .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
                .writable(),
            quest: fx
                .table::<PlayerQuestRow>("player_quest", "owner_identity", |r| r.owner_identity)
                .writable(),
            dialogue: fx
                .table::<PlayerDialogueStateRow>("player_dialogue_state", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable(),
            conversation: fx
                .table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable(),
            heal: fx
                .table::<HealCooldown>("heal_cooldown", "owner_identity", |r| r.owner_identity)
                .writable(),
            last_position: fx
                .table::<LastPosition>("last_position", "owner_identity", |r| r.owner_identity)
                .unique()
                .writable(),
            wallet: fx
                .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
                .writable(),
            profile,
            ladder: fx.ladder(),
            formation: fx
                .table::<PlayerFormation>("player_formation", "owner_identity", |r| {
                    r.owner_identity
                })
                .unique()
                .writable(),
            handle,
            challenge: fx
                .table::<BattleChallenge>("battle_challenge", "challenger", |r| r.challenger)
                .writable(),
            challenge_reaper: fx
                .table_keyed::<BattleChallengeReaperSchedule, u64>(
                    "battle_challenge_reaper_schedule",
                    "challenge_id",
                    |r| r.challenge_id,
                )
                .writable(),
            export: fx
                .table::<ExportBundle>("export_bundle", "owner_identity", |r| r.owner_identity)
                .writable()
                .scannable()
                .auto_inc(|r| r.chunk_id, |r, v| r.chunk_id = v),
            export_reaper: fx
                .table_keyed::<ExportBundleReaperSchedule, u64>(
                    "export_bundle_reaper_schedule",
                    "id",
                    |r| r.id,
                )
                .writable()
                .scannable()
                .auto_inc(|r| r.id, |r, v| r.id = v),
            battle: fx
                .table::<Battle>("battle", "player_identity", |r| r.player_identity)
                .writable(),
            summary: fx
                .table_keyed::<BattleSummary, u64>("battle_summary", "battle_id", |r| r.battle_id)
                .writable(),
            unit: fx
                .table_keyed::<BattleUnit, u64>("battle_unit", "battle_id", |r| r.battle_id)
                .writable()
                .scannable(),
            queue: fx
                .table_keyed::<BattleQueue, u64>("battle_queue", "battle_id", |r| r.battle_id)
                .writable(),
            deploy: fx
                .table_keyed::<BattleDeploy, u64>("battle_deploy", "battle_id", |r| r.battle_id)
                .writable(),
            clock: fx
                .table_keyed::<BattleClock, u64>("battle_clock", "battle_id", |r| r.battle_id)
                .writable(),
            playtest: fx
                .table_keyed::<PlaytestEvent, u64>("playtest_event", "event_id", |r| r.event_id)
                .writable()
                .scannable(),
            trade: fx
                .table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator)
                .writable(),
            trade_session: fx
                .table_keyed::<TradeSession, u64>("trade_session", "session_id", |r| r.session_id)
                .unique()
                .writable()
                .auto_inc(|r| r.session_id, |r, v| r.session_id = v),
            c,
        }
    }

    // ---------------------------------------------------------------------------------
    // Rows. Each builder takes the owner, so a row moved to another identity is the same
    // builder called with that identity.
    // ---------------------------------------------------------------------------------

    fn mon(monster_id: u64, owner: Identity) -> Monster {
        Monster {
            monster_id,
            owner_identity: owner,
            species_id: 1,
            nickname: format!("mon-{monster_id}"),
            level: 12,
            xp: 900,
            iv_hp: 11,
            iv_attack: 12,
            iv_defense: 13,
            iv_speed: 14,
            iv_sp_attack: 15,
            iv_sp_defense: 16,
            nature_kind: game_core::NatureKind::Hardy,
            ev_hp: 1,
            ev_attack: 2,
            ev_defense: 3,
            ev_speed: 4,
            ev_sp_attack: 5,
            ev_sp_defense: 6,
            stat_hp: 40,
            stat_attack: 41,
            stat_defense: 42,
            stat_speed: 43,
            stat_sp_attack: 44,
            stat_sp_defense: 45,
            current_hp: 39,
            party_slot: 0,
            last_care_at_ms: 7,
            essence_fire: 1,
            essence_water: 0,
            essence_plant: 0,
            essence_electric: 0,
            essence_earth: 0,
            essence_wind: 0,
            essence_light: 0,
            essence_dark: 0,
            trust_favorable_count: 3,
            trust_unfavorable_count: 1,
            trust_favorable_battle_day_epoch: 0,
            quality_time_ticks_total: 5,
            quality_time_accum_ms: 0,
            quality_time_window_ms: 0,
            quality_time_window_start_ms: 0,
            last_essence_train_at_ms: 0,
        }
    }

    fn notice_row(who: Identity) -> PendingEvolutionNotice {
        PendingEvolutionNotice {
            owner_identity: who,
            entries: vec![EvolutionRevealRow {
                monster_id: SRC_MONSTERS[0],
                from_species: 1,
                to_species: 2,
                evolved_at_ms: T0 - 3,
            }],
        }
    }

    fn stack(inv_id: u64, who: Identity, item_id: u32, count: u32) -> Inventory {
        Inventory {
            inv_id,
            owner_identity: who,
            item_id,
            count,
        }
    }

    fn quest_row(pq_id: u64, who: Identity) -> PlayerQuestRow {
        PlayerQuestRow {
            pq_id,
            owner_identity: who,
            quest_id: "q_forest".to_string(),
            step_index: 2,
        }
    }

    /// A non-system flag, the starter marker and one done quest.
    fn dialogue_row(who: Identity) -> PlayerDialogueStateRow {
        PlayerDialogueStateRow {
            owner_identity: who,
            flags: vec![
                "met_elder".to_string(),
                crate::npc::STARTER_CLAIMED_FLAG.to_string(),
            ],
            done_quests: vec!["q_intro".to_string()],
        }
    }

    fn conversation_row(who: Identity) -> PlayerConversation {
        PlayerConversation {
            owner_identity: who,
            npc_entity_id: 3,
            current_node_id: "n_greet".to_string(),
        }
    }

    fn heal_row(who: Identity) -> HealCooldown {
        HealCooldown {
            owner_identity: who,
            last_heal_at_ms: T0 - 5_000,
        }
    }

    fn wallet_row(who: Identity, balance: u64) -> PlayerWallet {
        PlayerWallet {
            owner_identity: who,
            balance,
        }
    }

    fn profile_row(who: Identity) -> Profile {
        Profile {
            identity: who,
            name: "Wanderer".to_string(),
            rating: 1_640,
            wins: 12,
            losses: 5,
        }
    }

    fn formation_row(who: Identity) -> PlayerFormation {
        PlayerFormation {
            owner_identity: who,
            monster_ids: SRC_MONSTERS.to_vec(),
        }
    }

    fn handle_row(who: Identity, discriminator: u32) -> PlayerHandle {
        PlayerHandle {
            owner_identity: who,
            discriminator,
        }
    }

    fn saved_position(who: Identity) -> LastPosition {
        LastPosition {
            owner_identity: who,
            zone_id: 1,
            tile_x: 7,
            tile_y: 9,
            facing: Direction::West,
        }
    }

    fn challenge_row(challenge_id: u64, challenger: Identity, target: Identity) -> BattleChallenge {
        BattleChallenge {
            challenge_id,
            challenger,
            target,
            challenger_party_ids: vec![],
            status: ChallengeStatus::Pending,
            created_at_ms: T0,
            format: 0,
        }
    }

    fn challenge_reaper_row(challenge_id: u64) -> BattleChallengeReaperSchedule {
        BattleChallengeReaperSchedule {
            scheduled_id: challenge_id + 10_000,
            scheduled_at: ScheduleAt::Time(at(NOW + 60_000)),
            challenge_id,
        }
    }

    fn chunk_row(chunk_id: u64, who: Identity) -> ExportBundle {
        ExportBundle {
            chunk_id,
            owner_identity: who,
            request_id: 1,
            table_name: "monster".to_string(),
            chunk_index: 0,
            total_chunks: 1,
            payload_json: "{}".to_string(),
            created_at_ms: NOW - 1_000,
        }
    }

    fn battle_row(
        battle_id: u64,
        player: Identity,
        opponent: Identity,
        outcome: BattleOutcome,
    ) -> Battle {
        let lead = game_core::BattleMonster {
            species_id: 1,
            affinity: game_core::Affinity::Fire,
            level: 7,
            current_hp: 30,
            max_hp: 30,
            stats: game_core::StatBlock {
                hp: 30,
                attack: 20,
                defense: 20,
                speed: 20,
                sp_attack: 20,
                sp_defense: 20,
            },
            known_skill_ids: vec![1],
            status: None,
        };
        Battle {
            battle_id,
            player_identity: player,
            opponent_identity: opponent,
            state: game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![lead.clone()],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![lead],
                },
                outcome,
                turn_number: 1,
                weather: None,
            },
            party_monster_ids: vec![],
            opponent_monster_ids: vec![],
            created_at_ms: 1,
        }
    }

    fn summary_row(battle_id: u64, player: Identity, opponent: Identity) -> BattleSummary {
        BattleSummary {
            battle_id,
            player_identity: player,
            opponent_identity: opponent,
            kind: BattleKind::Pvp,
            outcome: BattleOutcome::SideAWins,
            rounds: 5,
            wall_ms: 90_000,
            idle_ms_a: 1_000,
            idle_ms_b: 2_000,
            windows_histogram: vec![0, 3, 1],
            autopasses: 0,
            recruit_attempts: 0,
            recruit_successes: 0,
            weaken_first: false,
            items_used: 1,
            damage_dealt_a: 40,
            damage_dealt_b: 30,
            hits: 6,
            misses: 2,
            unit_turns_prequeued: 3,
            unit_turns_live: 4,
            halted_plans: 1,
            se_kos_after_r1: 0,
            kos_after_r1: 0,
            end_how: None,
        }
    }

    fn playtest_row(event_id: u64, who: Identity) -> PlaytestEvent {
        PlaytestEvent {
            event_id,
            identity: who,
            kind: 1,
            created_at_ms: T0 - 9_000,
            battle_id: FINISHED_BATTLE,
            species_id: 1,
            hp_permille: 500,
            bait_item_id: 0,
            success: true,
        }
    }

    fn session_row(session_id: u64, opener: Identity, partner: Identity) -> TradeSession {
        TradeSession {
            session_id,
            opener,
            partner,
            opener_offer: game_core::trading::TradeSessionOffer::default(),
            partner_offer: game_core::trading::TradeSessionOffer::default(),
            opener_confirmed: false,
            partner_confirmed: false,
            revision: 3,
            created_at_ms: NOW - 60_000,
        }
    }

    fn trade_row(trade_id: u64, initiator: Identity, counterparty: Identity) -> TradeOffer {
        TradeOffer {
            trade_id,
            initiator,
            counterparty,
            initiator_monster_ids: vec![],
            initiator_items: vec![],
            initiator_currency: 5,
            counterparty_monster_ids: vec![],
            counterparty_items: vec![],
            counterparty_currency: 0,
            initiator_cards: vec![],
            counterparty_cards: vec![],
            status: game_core::TradeStatus::Pending,
            created_at_ms: 1,
        }
    }

    fn player_row(who: Identity, entity_id: u64) -> Player {
        Player {
            identity: who,
            entity_id,
            name: "Wanderer".to_string(),
            online: true,
            discriminator: SRC_DISCRIMINATOR,
            lead_level: 12,
        }
    }

    fn character_at(
        entity_id: u64,
        zone_id: u32,
        tile_x: i32,
        tile_y: i32,
        facing: Direction,
    ) -> Character {
        Character {
            entity_id,
            zone_id,
            tile_x,
            tile_y,
            facing,
            action: game_core::ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: Vec::new(),
            acked_seq: 0,
        }
    }

    fn intent_row(entity_id: u64) -> MoveIntent {
        MoveIntent {
            entity_id,
            queue: vec![game_core::MoveInput::Jump],
            last_input_seq: 4,
        }
    }

    fn active_account(who: Identity) -> Account {
        Account {
            identity: who,
            auth_issuer: crate::accounts::DEV_LOGIN_ISSUERS[0].to_string(),
            created_at_ms: 10,
            last_login_at_ms: 20,
            status: AccountStatus::Active,
            deletion_requested_at_ms: None,
            claimed_from: None,
            claimed_at_ms: None,
            terminal_at_ms: None,
        }
    }

    fn session_of(who: Identity) -> PlayerSession {
        PlayerSession {
            connection_id: ConnectionId::from_u128(
                0x5E55_0000 + u128::from(who.to_byte_array()[0]),
            ),
            identity: who,
        }
    }

    // ---------------------------------------------------------------------------------
    // Seeding.
    // ---------------------------------------------------------------------------------

    /// `who` holds `handle`, last checked a day ago and not entitled.
    fn hold(m: &MW<'_>, who: Identity, handle: &str, is_host: bool) {
        m.c.accounts
            .seed(&account_row(who, handle, false, T0 - 86_400_000, is_host));
    }

    /// One character: two monsters with their `monster_pub` twins, an evolution notice, two
    /// stacks, a quest, the dialogue row, a heal cooldown, a wallet, a profile, a formation,
    /// a handle and a saved position.
    fn seed_character(m: &MW<'_>, who: Identity) {
        for id in SRC_MONSTERS {
            let row = mon(id, who);
            m.monster_pub.seed(&pub_from_monster(&row, 0));
            m.monster.seed(&row);
        }
        m.notice.seed(&notice_row(who));
        for (inv_id, item_id, count) in SRC_STACKS {
            m.inventory.seed(&stack(inv_id, who, item_id, count));
        }
        m.quest.seed(&quest_row(SRC_QUEST, who));
        m.dialogue.seed(&dialogue_row(who));
        m.heal.seed(&heal_row(who));
        m.wallet.seed(&wallet_row(who, SRC_BALANCE));
        m.profile.seed(&profile_row(who));
        m.formation.seed(&formation_row(who));
        m.handle.seed(&handle_row(who, SRC_DISCRIMINATOR));
        m.last_position.seed(&saved_position(who));
    }

    /// A conversation, an outgoing and an incoming challenge (each with its reaper row) and
    /// one export chunk.
    fn seed_transient(m: &MW<'_>, who: Identity, peer: Identity) {
        m.conversation.seed(&conversation_row(who));
        m.challenge.seed(&challenge_row(CH_OUT, who, peer));
        m.challenge.seed(&challenge_row(CH_IN, peer, who));
        m.challenge_reaper.seed(&challenge_reaper_row(CH_OUT));
        m.challenge_reaper.seed(&challenge_reaper_row(CH_IN));
        m.export.seed(&chunk_row(SRC_CHUNK, who));
    }

    /// A finished battle against `peer` and its summary, a playtest event, an admission, an
    /// account row and a connection.
    fn seed_history(m: &MW<'_>, who: Identity, peer: Identity) {
        m.battle.seed(&battle_row(
            FINISHED_BATTLE,
            who,
            peer,
            BattleOutcome::SideAWins,
        ));
        m.summary.seed(&summary_row(FINISHED_BATTLE, who, peer));
        m.playtest.seed(&playtest_row(961, who));
        m.c.admission.seed(&admission_row(who));
        m.c.account.seed(&active_account(who));
        m.session.seed(&session_of(who));
    }

    /// A bystander's own monster, wallet and profile.
    fn seed_bystander(m: &MW<'_>, who: Identity) {
        let row = mon(BYSTANDER_MONSTER, who);
        m.monster_pub.seed(&pub_from_monster(&row, 0));
        m.monster.seed(&row);
        m.wallet.seed(&wallet_row(who, 77));
        m.profile.seed(&Profile {
            identity: who,
            name: "Bystander".to_string(),
            rating: 1_500,
            wins: 3,
            losses: 4,
        });
    }

    /// [`bob`] holds [`HANDLE_B`] (the host's row) with a whole character, transient rows and
    /// history, and an armed re-check; [`carol`] is a bystander with her own re-check; both
    /// rank on the leaderboard; [`alice`] holds nothing.
    pub(super) fn moving_world(fx: &Fixture) -> MW<'_> {
        let m = move_world(fx);
        hold(&m, bob(), HANDLE_B, true);
        seed_character(&m, bob());
        seed_transient(&m, bob(), carol());
        seed_history(&m, bob(), carol());
        seed_bystander(&m, carol());
        for who in [bob(), carol()] {
            m.ladder.seed(&LeaderboardTop { identity: who });
        }
        m.c.rechecks.seed(&recheck_of(bob(), 1));
        m.c.rechecks.seed(&recheck_of(carol(), 2));
        m
    }

    /// The ticket answer naming [`HANDLE_B`], entitled, under the world's `spki:` name.
    fn spki_answer<'q>() -> HttpAnswer<'q> {
        ok_answer(ticket_answer(HANDLE_B, true, WORLD_NAME))
    }

    // ---------------------------------------------------------------------------------
    // Observations: per table, the encoded rows naming an identity.
    // ---------------------------------------------------------------------------------

    pub(super) type Snapshot = Vec<(&'static str, Vec<Vec<u8>>)>;

    fn naming<R: Serialize>(rows: Vec<R>, keep: impl Fn(&R) -> bool) -> Vec<Vec<u8>> {
        let picked: Vec<R> = rows.into_iter().filter(keep).collect();
        encs(&picked)
    }

    /// The rows a character is made of, per table.
    pub(super) fn character_rows(m: &MW<'_>, who: Identity) -> Snapshot {
        vec![
            (
                "monster",
                naming(m.monster.rows(), |r: &Monster| r.owner_identity == who),
            ),
            (
                "monster_pub",
                naming(m.monster_pub.rows(), |r: &MonsterPub| {
                    r.owner_identity == who
                }),
            ),
            (
                "pending_evolution_notice",
                naming(m.notice.rows(), |r: &PendingEvolutionNotice| {
                    r.owner_identity == who
                }),
            ),
            (
                "inventory",
                naming(m.inventory.rows(), |r: &Inventory| r.owner_identity == who),
            ),
            (
                "player_quest",
                naming(m.quest.rows(), |r: &PlayerQuestRow| r.owner_identity == who),
            ),
            (
                "player_dialogue_state",
                naming(m.dialogue.rows(), |r: &PlayerDialogueStateRow| {
                    r.owner_identity == who
                }),
            ),
            (
                "heal_cooldown",
                naming(m.heal.rows(), |r: &HealCooldown| r.owner_identity == who),
            ),
            (
                "player_wallet",
                naming(m.wallet.rows(), |r: &PlayerWallet| r.owner_identity == who),
            ),
            (
                "profile",
                naming(m.profile.rows(), |r: &Profile| r.identity == who),
            ),
            (
                "player_formation",
                naming(m.formation.rows(), |r: &PlayerFormation| {
                    r.owner_identity == who
                }),
            ),
            (
                "player_handle",
                naming(m.handle.rows(), |r: &PlayerHandle| r.owner_identity == who),
            ),
            (
                "last_position",
                naming(m.last_position.rows(), |r: &LastPosition| {
                    r.owner_identity == who
                }),
            ),
        ]
    }

    /// [`character_rows`] of a character [`seed_character`] gave to `who`.
    pub(super) fn character_expected(who: Identity) -> Snapshot {
        let monsters: Vec<Monster> = SRC_MONSTERS.iter().map(|&id| mon(id, who)).collect();
        let pubs: Vec<MonsterPub> = monsters.iter().map(|r| pub_from_monster(r, 0)).collect();
        let stacks: Vec<Inventory> = SRC_STACKS
            .iter()
            .map(|&(inv_id, item_id, count)| stack(inv_id, who, item_id, count))
            .collect();
        vec![
            ("monster", encs(&monsters)),
            ("monster_pub", encs(&pubs)),
            ("pending_evolution_notice", encs(&[notice_row(who)])),
            ("inventory", encs(&stacks)),
            ("player_quest", encs(&[quest_row(SRC_QUEST, who)])),
            ("player_dialogue_state", encs(&[dialogue_row(who)])),
            ("heal_cooldown", encs(&[heal_row(who)])),
            ("player_wallet", encs(&[wallet_row(who, SRC_BALANCE)])),
            ("profile", encs(&[profile_row(who)])),
            ("player_formation", encs(&[formation_row(who)])),
            ("player_handle", encs(&[handle_row(who, SRC_DISCRIMINATOR)])),
            ("last_position", encs(&[saved_position(who)])),
        ]
    }

    /// The rows a move clears: the conversation, the challenges naming `who` on either side,
    /// its export chunks and its presence row.
    fn transient_rows(m: &MW<'_>, who: Identity) -> Snapshot {
        vec![
            (
                "player_conversation",
                naming(m.conversation.rows(), |r: &PlayerConversation| {
                    r.owner_identity == who
                }),
            ),
            (
                "battle_challenge",
                naming(m.challenge.rows(), |r: &BattleChallenge| {
                    r.challenger == who || r.target == who
                }),
            ),
            (
                "export_bundle",
                naming(m.export.rows(), |r: &ExportBundle| r.owner_identity == who),
            ),
            (
                "player",
                naming(m.player.rows(), |r: &Player| r.identity == who),
            ),
        ]
    }

    /// The rows whose presence refuses a move.
    fn refusing_rows(m: &MW<'_>, who: Identity) -> Snapshot {
        vec![
            (
                "trade_offer",
                naming(m.trade.rows(), |r: &TradeOffer| {
                    r.initiator == who || r.counterparty == who
                }),
            ),
            (
                "trade_session",
                naming(m.trade_session.rows(), |r: &TradeSession| {
                    r.opener == who || r.partner == who
                }),
            ),
        ]
    }

    /// The rows a move leaves where they are.
    fn history_rows(m: &MW<'_>, who: Identity) -> Snapshot {
        vec![
            (
                "playtest_event",
                naming(m.playtest.rows(), |r: &PlaytestEvent| r.identity == who),
            ),
            (
                "player_session",
                naming(m.session.rows(), |r: &PlayerSession| r.identity == who),
            ),
            (
                "battle_unit",
                naming(m.unit.rows(), |r: &BattleUnit| r.owner == Some(who)),
            ),
            (
                "battle_queue",
                naming(m.queue.rows(), |r: &BattleQueue| r.owner == who),
            ),
            (
                "battle_deploy",
                naming(m.deploy.rows(), |r: &BattleDeploy| r.owner == who),
            ),
            (
                "battle_clock",
                naming(m.clock.rows(), |r: &BattleClock| r.player == who),
            ),
            (
                "world_admission",
                naming(m.c.admission.rows(), |r: &WorldAdmission| r.identity == who),
            ),
            (
                "world_admission_attempt",
                naming(m.admission_attempt.rows(), |r: &WorldAdmissionAttempt| {
                    r.identity == who
                }),
            ),
            (
                "world_binding",
                naming(m.binding.rows(), |r: &WorldBinding| r.identity == who),
            ),
            (
                "world_bind_nonce",
                naming(m.bind_nonce.rows(), |r: &WorldBindNonce| r.identity == who),
            ),
            (
                "account",
                naming(m.c.account.rows(), |r: &Account| r.identity == who),
            ),
            (
                "battle",
                naming(m.battle.rows(), |r: &Battle| {
                    r.player_identity == who || r.opponent_identity == who
                }),
            ),
            (
                "battle_summary",
                naming(m.summary.rows(), |r: &BattleSummary| {
                    r.player_identity == who || r.opponent_identity == who
                }),
            ),
        ]
    }

    /// Every row of every registered table but `world_check_budget` and `world_egress`, the two a
    /// redeem refused after its answer still writes.
    pub(super) fn snapshot(m: &MW<'_>) -> Snapshot {
        vec![
            ("config", encs(&m.c.config.rows())),
            ("world_access", encs(&m.c.access.rows())),
            ("world_admission", encs(&m.c.admission.rows())),
            ("account", encs(&m.c.account.rows())),
            ("world_name", encs(&m.c.names.rows())),
            ("world_allowlist", encs(&m.c.allow.rows())),
            ("world_account", encs(&m.c.accounts.rows())),
            ("recheck_schedule", encs(&m.c.rechecks.rows())),
            ("world_move", encs(&m.c.moves.rows())),
            ("world_binding", encs(&m.binding.rows())),
            ("world_bind_nonce", encs(&m.bind_nonce.rows())),
            ("world_admission_attempt", encs(&m.admission_attempt.rows())),
            ("player", encs(&m.player.rows())),
            ("player_session", encs(&m.session.rows())),
            ("character", encs(&m.character.rows())),
            ("move_intent", encs(&m.intent.rows())),
            ("monster", encs(&m.monster.rows())),
            ("monster_pub", encs(&m.monster_pub.rows())),
            ("pending_evolution_notice", encs(&m.notice.rows())),
            ("inventory", encs(&m.inventory.rows())),
            ("player_quest", encs(&m.quest.rows())),
            ("player_dialogue_state", encs(&m.dialogue.rows())),
            ("player_conversation", encs(&m.conversation.rows())),
            ("heal_cooldown", encs(&m.heal.rows())),
            ("last_position", encs(&m.last_position.rows())),
            ("player_wallet", encs(&m.wallet.rows())),
            ("profile", encs(&m.profile.rows())),
            ("leaderboard_top", encs(&m.ladder.rows())),
            ("player_formation", encs(&m.formation.rows())),
            ("player_handle", encs(&m.handle.rows())),
            ("battle_challenge", encs(&m.challenge.rows())),
            (
                "battle_challenge_reaper_schedule",
                encs(&m.challenge_reaper.rows()),
            ),
            ("export_bundle", encs(&m.export.rows())),
            (
                "export_bundle_reaper_schedule",
                encs(&m.export_reaper.rows()),
            ),
            ("battle", encs(&m.battle.rows())),
            ("battle_summary", encs(&m.summary.rows())),
            ("battle_unit", encs(&m.unit.rows())),
            ("battle_queue", encs(&m.queue.rows())),
            ("battle_deploy", encs(&m.deploy.rows())),
            ("battle_clock", encs(&m.clock.rows())),
            ("playtest_event", encs(&m.playtest.rows())),
            ("trade_offer", encs(&m.trade.rows())),
            ("trade_session", encs(&m.trade_session.rows())),
        ]
    }

    /// The tables of [`snapshot`] written since the last `reset_writes`, with their counts.
    pub(super) fn written(fx: &Fixture, m: &MW<'_>) -> Vec<(&'static str, u32)> {
        snapshot(m)
            .into_iter()
            .map(|(table, _)| (table, fx.writes_to(table)))
            .filter(|(_, n)| *n != 0)
            .collect()
    }

    /// The tables of `snap` that hold a row, with their counts.
    fn nonempty(snap: Snapshot) -> Vec<(&'static str, usize)> {
        snap.into_iter()
            .filter(|(_, rows)| !rows.is_empty())
            .map(|(table, rows)| (table, rows.len()))
            .collect()
    }

    fn rows_in<'s>(snap: &'s [(&'static str, Vec<Vec<u8>>)], table: &str) -> &'s [Vec<u8>] {
        snap.iter()
            .find(|(t, _)| *t == table)
            .map(|(_, rows)| rows.as_slice())
            .unwrap_or_else(|| panic!("no observer reads {table}"))
    }

    /// A redeem refused after an answer that reports [`ADDRESS`] has stored that address, and
    /// nothing else, at the check's time.
    fn assert_answer_address_stored(m: &MW<'_>, label: &str) {
        assert_eq!(
            egress(&m.c),
            vec![(4, ADDRESS.to_string(), NOW)],
            "{label}: the answer's address is stored"
        );
    }

    fn armed(m: &MW<'_>) -> Vec<[u8; 32]> {
        sorted(
            m.c.rechecks
                .rows()
                .iter()
                .map(|r| r.identity.to_byte_array())
                .collect(),
        )
    }

    fn members(m: &MW<'_>) -> Vec<[u8; 32]> {
        sorted(
            m.ladder
                .rows()
                .iter()
                .map(|r| r.identity.to_byte_array())
                .collect(),
        )
    }

    fn ids(who: &[Identity]) -> Vec<[u8; 32]> {
        sorted(who.iter().map(|w| w.to_byte_array()).collect())
    }

    /// `who` holds no row of a character and none of the rows a move clears.
    pub(super) fn assert_holds_nothing(m: &MW<'_>, who: Identity, label: &str) {
        assert_eq!(
            nonempty(character_rows(m, who)),
            Vec::<(&str, usize)>::new(),
            "{label}: character rows left"
        );
        assert_eq!(
            nonempty(transient_rows(m, who)),
            Vec::<(&str, usize)>::new(),
            "{label}: rows a move clears left"
        );
    }

    // ---------------------------------------------------------------------------------
    // The move.
    // ---------------------------------------------------------------------------------

    /// A ticket for the handle another identity holds moves that identity's whole character to
    /// the caller: every character row is under the caller with its content unchanged, the
    /// source holds none and none of the rows a move clears (the conversation, both
    /// challenges and their reapers, the export chunk), the handle's row is the caller's with
    /// the answer's entitlement at the check's time and its `is_host` kept, the source holds a
    /// `world_move` row stamped with the check's time and no armed re-check, the leaderboard
    /// is rescanned, and the finished battle, its summary, the playtest event, the admission,
    /// the account and the connection stay byte for byte, as do the bystander's rows.
    ///
    /// kills: the inert move; any one table not moved, moved with changed content, or left
    /// copied at the source; the dialogue row reduced to its system flags at the caller or a
    /// marker row left at the source; the wallet left zeroed at the source; the profile name
    /// or stats dropped; the handle's discriminator re-minted; a challenge, a reaper row or the
    /// chunk left; `is_host` reset; the stored time or entitlement kept; the re-check left
    /// armed or the bystander's dropped; no `world_move` row, or one for the caller; a finished
    /// battle, its summary or the telemetry moved or erased; a bystander's row touched.
    #[test]
    fn a_full_move_carries_the_whole_character_to_the_caller_lpw42_1() {
        let fx = fixture();
        let m = moving_world(&fx);
        let history = history_rows(&m, bob());
        let bystander = character_rows(&m, carol());
        let (got, sent) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Ok(true), "the answer's entitlement");
        assert_eq!(sent.len(), 1, "one request");
        assert_eq!(
            character_rows(&m, alice()),
            character_expected(alice()),
            "every character row is under the caller, unchanged"
        );
        assert_holds_nothing(&m, bob(), "the source");
        assert!(
            m.challenge_reaper
                .rows()
                .iter()
                .all(|r| r.challenge_id != CH_OUT && r.challenge_id != CH_IN),
            "the challenges' reaper rows go with them"
        );
        assert_eq!(
            accounts(&m.c),
            vec![view(&account_row(alice(), HANDLE_B, true, NOW, true))],
            "the handle's one row is the caller's"
        );
        assert_eq!(moves(&m.c), vec![(bob().to_byte_array(), NOW)]);
        assert_eq!(armed(&m), ids(&[carol()]), "the source's re-check goes");
        assert_eq!(
            members(&m),
            ids(&[alice(), carol()]),
            "the board is rescanned"
        );
        assert_eq!(history_rows(&m, bob()), history, "history stays");
        assert_eq!(
            character_rows(&m, carol()),
            bystander,
            "the bystander's rows"
        );
    }

    /// The owner's relay for an identity that is not connected moves the character the same
    /// way: the rows are under `who`, the handle is `who`'s, and the source holds a
    /// `world_move` row.
    ///
    /// kills: the move run for the relay's caller; the relay refused a held handle.
    #[test]
    fn the_owners_relay_moves_the_character_to_who_lpw42_1() {
        let fx = fixture();
        let m = moving_world(&fx);
        let mut http = HttpQueue::new();
        http.push(spki_answer());
        let got = relay_as(
            &fx,
            owner(),
            alice(),
            NOW,
            &mut http,
            &test_profile(),
            &ticket(),
        );
        assert_eq!(got, Ok(true));
        assert_eq!(character_rows(&m, alice()), character_expected(alice()));
        assert_holds_nothing(&m, bob(), "the source");
        assert_holds_nothing(&m, owner(), "the relay's caller");
        assert_eq!(
            accounts(&m.c),
            vec![view(&account_row(alice(), HANDLE_B, true, NOW, true))]
        );
        assert_eq!(moves(&m.c), vec![(bob().to_byte_array(), NOW)]);
    }

    /// A holder that owns no character is re-pointed the same way: the handle's row is the
    /// caller's and the holder holds a `world_move` row stamped with the check's time.
    ///
    /// kills: the `world_move` row written only when rows moved; the re-point skipped.
    #[test]
    fn a_holder_that_owns_no_character_is_re_pointed_and_told_lpw42_1() {
        let fx = fixture();
        let m = move_world(&fx);
        hold(&m, bob(), HANDLE_B, false);
        let (got, _) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Ok(true));
        assert_eq!(
            accounts(&m.c),
            vec![view(&account_row(alice(), HANDLE_B, true, NOW, false))]
        );
        assert_eq!(moves(&m.c), vec![(bob().to_byte_array(), NOW)]);
    }

    /// A `world_move` row the source already holds from an earlier move is replaced by one
    /// stamped with this check's time: one row.
    ///
    /// kills: the stale row kept; a second insert under the same identity.
    #[test]
    fn a_stale_world_move_row_at_the_source_is_replaced_lpw42_1() {
        let fx = fixture();
        let m = move_world(&fx);
        hold(&m, bob(), HANDLE_B, false);
        m.c.moves.seed(&WorldMove {
            identity: bob(),
            moved_at_ms: T0 - 999,
        });
        let (got, _) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Ok(true));
        assert_eq!(moves(&m.c), vec![(bob().to_byte_array(), NOW)]);
    }

    /// A source whose second monster has lost its `monster_pub` twin cannot be moved: the check
    /// answers "the character could not be moved" and every registered table keeps its rows
    /// with no write but the budget's charge and the answer's address (the first monster's
    /// re-key is rolled back).
    ///
    /// kills: the move's error swallowed (`let _ = move_character(..)`), which re-points the
    /// handle over a half-moved character; the refusal text changed; the address rolled back
    /// with the refused redeem.
    #[test]
    fn a_move_that_fails_refuses_and_changes_nothing_lpw42_1() {
        assert_eq!(REJECT_MOVE_FAILED, "the character could not be moved");
        let fx = fixture();
        let m = moving_world(&fx);
        assert_eq!(
            m.monster_pub.remove(SRC_MONSTERS[1]),
            1,
            "fixture: the second monster's twin goes"
        );
        let before = snapshot(&m);
        fx.reset_writes();
        let (got, _) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Err(REJECT_MOVE_FAILED.to_string()));
        assert_eq!(snapshot(&m), before, "every row stays");
        assert_eq!(
            written(&fx, &m),
            Vec::<(&str, u32)>::new(),
            "no write but the budget's and the address's"
        );
        assert_answer_address_stored(&m, "a move that fails");
    }

    /// The world's owner checks itself in under `Allowlist` with a ticket for a handle another
    /// identity holds and that the list lacks: the character moves to the owner, the handle's
    /// row is the owner's, and the handle is on the list.
    ///
    /// kills: the owner's list step skipped when the handle is held.
    #[test]
    fn the_owners_own_move_under_allowlist_lists_its_handle_lpw42_1() {
        let fx = fixture();
        let m = moving_world(&fx);
        m.c.access.seed(&rule_row(WorldAccessRule::Allowlist));
        let mut http = HttpQueue::new();
        http.push(spki_answer());
        let got = check_as(&fx, owner(), NOW, &mut http, &test_profile(), &ticket());
        assert_eq!(got, Ok(true));
        assert_eq!(listed(&m.c), strings(&[HANDLE_B]), "the handle is listed");
        assert_eq!(character_rows(&m, owner()), character_expected(owner()));
        assert_eq!(
            accounts(&m.c),
            vec![view(&account_row(owner(), HANDLE_B, true, NOW, true))]
        );
    }

    /// The same check onto a full list (256 handles, none the answered one) is refused with
    /// the list's reason, and every registered table keeps its rows with no write but the
    /// budget's charge and the answer's address.
    ///
    /// kills: the list bound skipped when the handle is held; the character moved before the
    /// list refuses; the address rolled back with the refused redeem.
    #[test]
    fn the_owners_own_move_onto_a_full_allowlist_is_refused_and_changes_nothing_lpw42_1() {
        let fx = fixture();
        let m = moving_world(&fx);
        m.c.access.seed(&rule_row(WorldAccessRule::Allowlist));
        let full: Vec<String> = (0..256).map(|i| format!("k1.full{i:04}")).collect();
        let refs: Vec<&str> = full.iter().map(String::as_str).collect();
        list(&m.c, &refs);
        let before = snapshot(&m);
        fx.reset_writes();
        let mut http = HttpQueue::new();
        http.push(spki_answer());
        let got = check_as(&fx, owner(), NOW, &mut http, &test_profile(), &ticket());
        assert_eq!(got, Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS.to_string()));
        assert_eq!(snapshot(&m), before, "every row stays");
        assert_eq!(
            written(&fx, &m),
            Vec::<(&str, u32)>::new(),
            "no write but the budget's and the address's"
        );
        assert_answer_address_stored(&m, "a full list");
    }

    /// What a move does with a table that holds an identity's rows.
    #[derive(Clone, Copy, Debug)]
    enum Fate {
        /// Every row of the source is under the caller, its owner column re-keyed and nothing
        /// else changed; the source holds none.
        Moved,
        /// Neither identity holds a row afterwards.
        Cleared,
        /// Derived from `profile`: the caller is a member exactly when its profile ranks, the
        /// source is not.
        Rederived,
        /// A row naming either identity refuses the move (the refusal tests below).
        RefusedWhilePresent(&'static str),
        /// The source keeps its rows byte for byte, for the reason given.
        Stays(&'static str),
        /// Written by the redeem itself, not by the move.
        Redeem,
    }

    const FATES: &[(&str, Fate)] = &[
        ("monster", Fate::Moved),
        ("monster_pub", Fate::Moved),
        ("inventory", Fate::Moved),
        ("player_dialogue_state", Fate::Moved),
        ("player_quest", Fate::Moved),
        ("player_conversation", Fate::Cleared),
        ("heal_cooldown", Fate::Moved),
        ("last_position", Fate::Moved),
        ("player_wallet", Fate::Moved),
        (
            "playtest_event",
            Fate::Stays("telemetry of finished battles, left as the guest claim leaves it"),
        ),
        (
            "trade_offer",
            Fate::RefusedWhilePresent("a trade in either role"),
        ),
        (
            "trade_session",
            Fate::RefusedWhilePresent("a trade in either role"),
        ),
        ("battle_challenge", Fate::Cleared),
        ("export_bundle", Fate::Cleared),
        (
            "player_session",
            Fate::Stays("about the identity's own connection, not the character"),
        ),
        ("pending_evolution_notice", Fate::Moved),
        ("battle_unit", Fate::Stays("finished battles are history")),
        ("battle_queue", Fate::Stays("finished battles are history")),
        ("battle_deploy", Fate::Stays("finished battles are history")),
        ("battle_clock", Fate::Stays("finished battles are history")),
        ("player_formation", Fate::Moved),
        ("player_handle", Fate::Moved),
        (
            "world_admission",
            Fate::Stays("about the identity's own admission, not the character"),
        ),
        (
            "world_admission_attempt",
            Fate::Stays("about the identity's own admission, not the character"),
        ),
        (
            "world_binding",
            Fate::Stays("an attestation-era binding that entitles nobody"),
        ),
        (
            "world_bind_nonce",
            Fate::Stays("an attestation-era nonce that entitles nobody"),
        ),
        ("world_account", Fate::Redeem),
        ("recheck_schedule", Fate::Redeem),
        ("world_move", Fate::Redeem),
        ("player", Fate::Cleared),
        ("profile", Fate::Moved),
        ("leaderboard_top", Fate::Rederived),
        (
            "account",
            Fate::Stays("the identity's own account; a pending deletion refuses the move"),
        ),
        ("battle", Fate::Stays("finished battles are history")),
        (
            "battle_summary",
            Fate::Stays("finished battles are history"),
        ),
    ];

    /// Every `Erase` and `Anonymize` table of the lifecycle manifest has a stated fate in a
    /// move, and a full move meets each one: a table added later fails here until it is
    /// classified and observed.
    ///
    /// kills: a table that holds an identity's rows left out of the move's reckoning; a moved
    /// table left at the source; a cleared table moved; a staying table moved or erased.
    #[test]
    fn every_erase_and_anonymize_table_has_a_fate_the_move_meets_lpw42_1() {
        let manifest: BTreeSet<&str> = DATA_LIFECYCLE_MANIFEST
            .iter()
            .filter(|e| matches!(e.policy, DeletionPolicy::Erase | DeletionPolicy::Anonymize))
            .map(|e| e.table)
            .collect();
        let roster: BTreeSet<&str> = FATES.iter().map(|(table, _)| *table).collect();
        assert_eq!(roster.len(), FATES.len(), "each table is classified once");
        assert_eq!(roster, manifest, "the fates name exactly these tables");

        let fx = fixture();
        let m = moving_world(&fx);
        let moved_before = character_rows(&m, bob());
        let stays_before = history_rows(&m, bob());
        let (got, _) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Ok(true));
        let expected = character_expected(alice());
        let moved_to = character_rows(&m, alice());
        let moved_from = character_rows(&m, bob());
        let cleared_from = transient_rows(&m, bob());
        let cleared_to = transient_rows(&m, alice());
        let refusing = [refusing_rows(&m, bob()), refusing_rows(&m, alice())];
        let stays_after = history_rows(&m, bob());
        for (table, fate) in FATES {
            match fate {
                Fate::Moved => {
                    assert!(
                        !rows_in(&moved_before, table).is_empty(),
                        "{table}: the source held a row"
                    );
                    assert_eq!(
                        rows_in(&moved_to, table),
                        rows_in(&expected, table),
                        "{table}: under the caller"
                    );
                    assert!(
                        rows_in(&moved_from, table).is_empty(),
                        "{table}: left at the source"
                    );
                }
                Fate::Cleared => {
                    assert!(
                        rows_in(&cleared_from, table).is_empty(),
                        "{table}: left at the source"
                    );
                    assert!(
                        rows_in(&cleared_to, table).is_empty(),
                        "{table}: given to the caller"
                    );
                }
                Fate::Rederived => match *table {
                    "leaderboard_top" => {
                        assert_eq!(members(&m), ids(&[alice(), carol()]), "{table}");
                    }
                    other => panic!("no observer reads {other}"),
                },
                Fate::RefusedWhilePresent(reason) => {
                    for snap in &refusing {
                        assert!(
                            rows_in(snap, table).is_empty(),
                            "{table} ({reason}): a successful move had no such row"
                        );
                    }
                }
                Fate::Stays(reason) => {
                    assert_eq!(
                        rows_in(&stays_after, table),
                        rows_in(&stays_before, table),
                        "{table} stays: {reason}"
                    );
                }
                Fate::Redeem => match *table {
                    "world_account" => {
                        assert_eq!(
                            accounts(&m.c),
                            vec![view(&account_row(alice(), HANDLE_B, true, NOW, true))],
                            "{table}"
                        );
                    }
                    "recheck_schedule" => {
                        assert_eq!(armed(&m), ids(&[carol()]), "{table}");
                    }
                    "world_move" => {
                        assert_eq!(moves(&m.c), vec![(bob().to_byte_array(), NOW)], "{table}");
                    }
                    other => panic!("no observer reads {other}"),
                },
            }
        }
    }

    /// The row writes of one move of a source holding 100 monsters (each with its twin), 5
    /// stacks, 1 quest, one row in each single-row table, two challenges with their reaper
    /// rows and one export chunk, and the procedure's three committed transactions (the charge,
    /// the answer's address, then the redeem). Each count follows from the helper the move goes
    /// through:
    ///
    /// - `monster`, `monster_pub`: `monster_mgmt::rekey_monsters` updates each row and its
    ///   twin in place through `update_monster_synced` (1 + 1 per monster; the level and
    ///   slot are unchanged, so no lead refresh writes `player`).
    /// - `inventory`: `rekey_inventory`, 1 update per stack.
    /// - `player_quest`: `npc::rekey_npc_state` 1 update; `erase_npc_state` then finds none.
    /// - `player_dialogue_state`: `rekey_npc_state` deletes the source row, inserts the
    ///   caller's and inserts the source's marker row (3); `erase_npc_state` deletes that
    ///   marker (1).
    /// - `player_conversation`: `erase_npc_state`'s point delete (1).
    /// - `pending_evolution_notice`, `heal_cooldown`, `player_formation`, `player_handle`,
    ///   `last_position` (saved, not live): delete then insert (2 each).
    /// - `player_wallet`: `economy::rekey_wallet` inserts the caller's row through
    ///   `grant_currency` and zeroes the source's in place (2); `erase_wallet` deletes it (1).
    /// - `profile`: `ranking::move_profile` deletes then inserts (2); `leaderboard_top`: its
    ///   one rescan deletes the source's membership and inserts the caller's (2).
    /// - `battle_challenge`, `battle_challenge_reaper_schedule`: `pvp::erase_pvp_rows`
    ///   deletes each challenge and its one reaper row (2 + 2).
    /// - `export_bundle`: `privacy::purge_export_bundles` deletes the chunk (1); the emptied
    ///   table had no reaper row, so its re-arm writes none.
    /// - `world_account`: the handle's row updated in place (1); `recheck_schedule`: the
    ///   source's armed row deleted (1); `world_check_budget`: the charge (1).
    ///
    /// - `world_move`: the source's row inserted (1); the caller holds none, so nothing else
    ///   is written to it.
    /// - `world_egress`: the answer's address inserted (1), in a transaction of its own
    ///   between the charge and the redeem.
    ///
    /// Every other registered table is written 0 times (in this `Open` world `world_admission`
    /// among them).
    ///
    /// kills: a move that re-writes rows it need not (a second pass over the monsters, a
    /// rescan per table, a wallet row deleted and re-created); a write to a table the move
    /// leaves alone; a fourth procedure transaction.
    #[test]
    fn the_cost_of_one_move_for_a_collection_of_100_monsters_lpw42_1() {
        let fx = fixture();
        let m = move_world(&fx);
        hold(&m, bob(), HANDLE_B, false);
        for id in 1_000..1_100u64 {
            let row = mon(id, bob());
            m.monster_pub.seed(&pub_from_monster(&row, 0));
            m.monster.seed(&row);
        }
        for n in 0..5u32 {
            m.inventory
                .seed(&stack(2_000 + u64::from(n), bob(), 10 + n, 1));
        }
        m.quest.seed(&quest_row(SRC_QUEST, bob()));
        m.notice.seed(&notice_row(bob()));
        m.dialogue.seed(&dialogue_row(bob()));
        m.heal.seed(&heal_row(bob()));
        m.wallet.seed(&wallet_row(bob(), SRC_BALANCE));
        m.profile.seed(&profile_row(bob()));
        m.ladder.seed(&LeaderboardTop { identity: bob() });
        m.formation.seed(&formation_row(bob()));
        m.handle.seed(&handle_row(bob(), SRC_DISCRIMINATOR));
        m.last_position.seed(&saved_position(bob()));
        seed_transient(&m, bob(), carol());
        m.c.rechecks.seed(&recheck_of(bob(), 1));
        fx.reset_writes();
        assert_eq!(fx.procedure_commits(), 0, "fixture");
        let (got, _) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Ok(true));
        assert_eq!(
            m.monster
                .rows()
                .iter()
                .filter(|r| r.owner_identity == alice())
                .count(),
            100,
            "the collection moved"
        );
        let mut tables: Vec<&'static str> = snapshot(&m).into_iter().map(|(t, _)| t).collect();
        tables.push("world_check_budget");
        tables.push("world_egress");
        let got_writes: BTreeMap<&str, u32> = tables
            .into_iter()
            .map(|t| (t, fx.writes_to(t)))
            .filter(|(_, n)| *n != 0)
            .collect();
        let want: BTreeMap<&str, u32> = [
            ("world_check_budget", 1),
            ("world_account", 1),
            ("recheck_schedule", 1),
            ("monster", 100),
            ("monster_pub", 100),
            ("inventory", 5),
            ("player_quest", 1),
            ("player_dialogue_state", 4),
            ("player_conversation", 1),
            ("pending_evolution_notice", 2),
            ("heal_cooldown", 2),
            ("player_wallet", 3),
            ("profile", 2),
            ("leaderboard_top", 2),
            ("player_formation", 2),
            ("player_handle", 2),
            ("last_position", 2),
            ("battle_challenge", 2),
            ("battle_challenge_reaper_schedule", 2),
            ("export_bundle", 1),
            ("world_move", 1),
            ("world_egress", 1),
        ]
        .into_iter()
        .collect();
        assert_eq!(got_writes, want, "the writes of one move");
        assert_eq!(
            fx.procedure_commits(),
            3,
            "the charge, the address and the redeem"
        );
    }

    // ---------------------------------------------------------------------------------
    // The move back.
    // ---------------------------------------------------------------------------------

    /// After a move from bob to alice, bob checks in again with the same account later: the
    /// character is back under bob whole, alice holds none of it, bob's `world_move` row is
    /// gone and alice holds one stamped with the second check's time.
    ///
    /// kills: a move that only runs one way; bob refused as owning a character (a marker row
    /// left at him by the first move); bob's `world_move` row kept; alice's stamped with the
    /// first check's time.
    #[test]
    fn the_first_identity_checking_in_again_gets_the_character_back_lpw42_2() {
        let fx = fixture();
        let m = moving_world(&fx);
        let (first, _) = alice_checks(&fx, spki_answer());
        assert_eq!(first, Ok(true), "fixture: the first move");
        let mut http = HttpQueue::new();
        http.push(spki_answer());
        let back = check_as(&fx, bob(), LATER, &mut http, &test_profile(), &ticket());
        assert_eq!(back, Ok(true));
        assert_eq!(character_rows(&m, bob()), character_expected(bob()));
        assert_holds_nothing(&m, alice(), "the first move's caller");
        assert_eq!(moves(&m.c), vec![(alice().to_byte_array(), LATER)]);
        assert_eq!(
            accounts(&m.c),
            vec![view(&account_row(bob(), HANDLE_B, true, LATER, true))]
        );
    }

    /// A check-in for a handle no one holds deletes the caller's own `world_move` row, and
    /// a bystander's stays.
    ///
    /// kills: the row deleted only on a move; every `world_move` row deleted.
    #[test]
    fn a_check_in_for_a_free_handle_deletes_the_callers_world_move_row_lpw42_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        for (who, ms) in [(alice(), T0 - 1), (bob(), T0 - 2)] {
            w.moves.seed(&WorldMove {
                identity: who,
                moved_at_ms: ms,
            });
        }
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        assert_eq!(got, Ok(true));
        assert_eq!(moves(&w), vec![(bob().to_byte_array(), T0 - 2)]);
    }

    /// A check-in for the handle the caller already holds deletes its own `world_move` row.
    ///
    /// kills: the row deleted only on first contact.
    #[test]
    fn a_check_in_for_the_callers_own_handle_deletes_its_world_move_row_lpw42_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, T0 - 1_000, false));
        w.moves.seed(&WorldMove {
            identity: alice(),
            moved_at_ms: T0 - 1,
        });
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        assert_eq!(got, Ok(true));
        assert_eq!(moves(&w), Vec::<([u8; 32], i64)>::new());
    }

    /// A refused check-in leaves the caller's `world_move` row as it is (a name the world does
    /// not hold; a caller holding another handle); the next accepted one deletes it.
    ///
    /// kills: the row deleted before the decision; the deletion surviving the abort.
    #[test]
    fn a_refused_check_in_deletes_no_world_move_row_lpw42_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, T0 - 1_000, false));
        w.moves.seed(&WorldMove {
            identity: alice(),
            moved_at_ms: T0 - 1,
        });
        let kept = vec![(alice().to_byte_array(), T0 - 1)];
        for (answer, want) in [
            (
                ticket_answer(HANDLE_A, true, OTHER_NAME),
                REJECT_TICKET_REFUSED,
            ),
            (
                ticket_answer(HANDLE_A2, true, WORLD_NAME),
                REJECT_IDENTITY_HOLDS_ANOTHER,
            ),
        ] {
            let (got, _) = alice_checks(&fx, ok_answer(answer));
            assert_eq!(got, Err(want.to_string()));
            assert_eq!(moves(&w), kept, "{want}: the row stays");
        }
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        assert_eq!(got, Ok(true), "control");
        assert_eq!(moves(&w), Vec::<([u8; 32], i64)>::new(), "control: deleted");
    }

    // ---------------------------------------------------------------------------------
    // The refusals.
    // ---------------------------------------------------------------------------------

    /// What each refusal case adds to [`moving_world`].
    fn twist(m: &MW<'_>, case: &str) {
        match case {
            "the caller has only a player row" => m.player.seed(&player_row(alice(), 61)),
            "the caller has only a handle" => m.handle.seed(&handle_row(alice(), 9_100_061)),
            "the source plays an ongoing battle" => {
                m.battle
                    .seed(&battle_row(711, bob(), carol(), BattleOutcome::Ongoing))
            }
            "the source is an ongoing battle's opponent" => {
                m.battle
                    .seed(&battle_row(712, carol(), bob(), BattleOutcome::Ongoing))
            }
            "the caller plays an ongoing battle" => {
                m.battle
                    .seed(&battle_row(713, alice(), carol(), BattleOutcome::Ongoing))
            }
            "the caller is an ongoing battle's opponent" => {
                m.battle
                    .seed(&battle_row(714, carol(), alice(), BattleOutcome::Ongoing))
            }
            "the source opened a trade session" => {
                m.trade_session.seed(&session_row(41, bob(), carol()));
            }
            "the source is a trade session's partner" => {
                m.trade_session.seed(&session_row(42, carol(), bob()));
            }
            "the source made a trade offer" => m.trade.seed(&trade_row(51, bob(), carol())),
            "the source was offered a trade" => m.trade.seed(&trade_row(52, carol(), bob())),
            "the caller opened a trade session" => {
                m.trade_session.seed(&session_row(43, alice(), carol()));
            }
            "the caller is a trade session's partner" => {
                m.trade_session.seed(&session_row(44, carol(), alice()));
            }
            "the caller made a trade offer" => m.trade.seed(&trade_row(53, alice(), carol())),
            "the source's account is pending deletion" => {
                assert_eq!(
                    m.c.account.remove(bob()),
                    1,
                    "fixture: bob's active account"
                );
                m.c.account.seed(&deleting_account(bob()));
            }
            "the caller has a player row and plays an ongoing battle" => {
                twist(m, "the caller has only a player row");
                twist(m, "the caller plays an ongoing battle");
            }
            "the caller holds another handle and owns a monster" => {
                m.c.accounts
                    .seed(&account_row(alice(), HANDLE_A, true, T0 - 1_000, false));
                let row = mon(981, alice());
                m.monster_pub.seed(&pub_from_monster(&row, 0));
                m.monster.seed(&row);
            }
            other => panic!("no case {other}"),
        }
    }

    /// In [`moving_world`] with `case` added, alice's ticket for bob's handle is refused with
    /// `want`, and every registered table keeps its rows with no write but the budget's
    /// charge and the answer's address.
    fn assert_refused_unchanged(case: &str, want: &str) {
        let fx = fixture();
        let m = moving_world(&fx);
        twist(&m, case);
        let before = snapshot(&m);
        fx.reset_writes();
        let (got, sent) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Err(want.to_string()), "{case}");
        assert_eq!(sent.len(), 1, "{case}: refused after the answer");
        assert_eq!(snapshot(&m), before, "{case}: every row stays");
        assert_eq!(
            written(&fx, &m),
            Vec::<(&str, u32)>::new(),
            "{case}: no write but the budget's and the address's"
        );
        assert_answer_address_stored(&m, case);
    }

    /// kills: `owns_character` blind to a `player` row or to a game-data row.
    #[test]
    fn a_caller_that_owns_a_character_is_refused_and_nothing_changes_lpw42_3() {
        for case in [
            "the caller has only a player row",
            "the caller has only a handle",
        ] {
            assert_refused_unchanged(case, REJECT_CALLER_OWNS_CHARACTER);
        }
    }

    /// kills: the battle guard on the caller only; the opponent arm missing.
    #[test]
    fn a_source_in_an_ongoing_battle_is_refused_and_nothing_changes_lpw42_3() {
        for case in [
            "the source plays an ongoing battle",
            "the source is an ongoing battle's opponent",
        ] {
            assert_refused_unchanged(case, REJECT_MOVE_NOT_NOW);
        }
    }

    /// The caller has the battle row alone, so it owns no character.
    ///
    /// kills: the battle guard on the source only.
    #[test]
    fn a_caller_in_an_ongoing_battle_is_refused_and_nothing_changes_lpw42_3() {
        for case in [
            "the caller plays an ongoing battle",
            "the caller is an ongoing battle's opponent",
        ] {
            assert_refused_unchanged(case, REJECT_MOVE_NOT_NOW);
        }
    }

    /// kills: a trade guard blind to sessions, to offers, or to one role.
    #[test]
    fn a_source_in_a_trade_is_refused_and_nothing_changes_lpw42_3() {
        for case in [
            "the source opened a trade session",
            "the source is a trade session's partner",
            "the source made a trade offer",
            "the source was offered a trade",
        ] {
            assert_refused_unchanged(case, REJECT_MOVE_NOT_NOW);
        }
    }

    /// kills: the trade guard on the source only.
    #[test]
    fn a_caller_in_a_trade_is_refused_and_nothing_changes_lpw42_3() {
        for case in [
            "the caller opened a trade session",
            "the caller is a trade session's partner",
            "the caller made a trade offer",
        ] {
            assert_refused_unchanged(case, REJECT_MOVE_NOT_NOW);
        }
    }

    /// kills: a character moved away from an account the deletion cascade is about to erase.
    #[test]
    fn a_source_pending_deletion_is_refused_and_nothing_changes_lpw42_3() {
        assert_refused_unchanged(
            "the source's account is pending deletion",
            REJECT_MOVE_NOT_NOW,
        );
    }

    /// A caller that owns a character and is in a battle is told it owns a character.
    ///
    /// kills: the battle and trade guard judged before `owns_character`.
    #[test]
    fn a_caller_owning_a_character_is_told_so_before_its_battle_lpw42_3() {
        assert_refused_unchanged(
            "the caller has a player row and plays an ongoing battle",
            REJECT_CALLER_OWNS_CHARACTER,
        );
    }

    /// A caller holding another handle is told so even when it owns a character.
    ///
    /// kills: `owns_character` judged before the caller's own handle.
    #[test]
    fn a_caller_holding_another_handle_is_told_so_before_its_character_lpw42_3() {
        assert_refused_unchanged(
            "the caller holds another handle and owns a monster",
            REJECT_IDENTITY_HOLDS_ANOTHER,
        );
    }

    /// Finished battles at the source and at the caller refuse nothing: the character moves.
    ///
    /// kills: a battle guard that counts a finished battle.
    #[test]
    fn a_finished_battle_at_either_identity_does_not_refuse_lpw42_3() {
        let fx = fixture();
        let m = moving_world(&fx);
        m.battle
            .seed(&battle_row(715, alice(), carol(), BattleOutcome::SideAWins));
        m.battle
            .seed(&battle_row(716, carol(), alice(), BattleOutcome::Fled));
        let (got, _) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Ok(true));
        assert_eq!(character_rows(&m, alice()), character_expected(alice()));
    }

    /// Whether the rule in force lets `who` in, read as `who` at [`NOW`].
    fn admitted(fx: &Fixture, who: Identity) -> bool {
        fx.run_as_at(who, at(NOW), |ctx| crate::access::is_admitted(ctx, who))
    }

    fn admission_of(m: &MW<'_>, who: Identity) -> Vec<Vec<u8>> {
        naming(m.c.admission.rows(), |r: &WorldAdmission| r.identity == who)
    }

    /// Under `Allowlist`, a source whose handle the list lacks is refused before the move
    /// despite its `world_admission` row; the owner relays the caller's ticket, the character
    /// moves, the source's admission row is deleted, and the source is still refused.
    ///
    /// kills: a move that leaves the stale admission row, which admits the source once the
    /// handle's row is no longer its own.
    #[test]
    fn a_move_admits_no_source_the_list_refused_lpw42_3() {
        let fx = fixture();
        let m = moving_world(&fx);
        m.c.access.seed(&rule_row(WorldAccessRule::Allowlist));
        assert!(
            !admission_of(&m, bob()).is_empty(),
            "fixture: the source holds an admission row"
        );
        assert!(!admitted(&fx, bob()), "refused before the move");
        let mut http = HttpQueue::new();
        http.push(spki_answer());
        let got = relay_as(
            &fx,
            owner(),
            alice(),
            NOW,
            &mut http,
            &test_profile(),
            &ticket(),
        );
        assert_eq!(got, Ok(true));
        assert_eq!(character_rows(&m, alice()), character_expected(alice()));
        assert_eq!(
            admission_of(&m, bob()),
            Vec::<Vec<u8>>::new(),
            "the source's admission row goes"
        );
        assert!(!admitted(&fx, bob()), "refused after the move");
    }

    /// Under `Allowlist`, a source whose handle is listed (so it is admitted) keeps its
    /// `world_admission` row through the move, byte for byte and unwritten.
    ///
    /// kills: the admission row deleted whatever the rule says of the source.
    #[test]
    fn a_move_keeps_the_admission_of_a_source_the_list_admits_lpw42_3() {
        let fx = fixture();
        let m = moving_world(&fx);
        m.c.access.seed(&rule_row(WorldAccessRule::Allowlist));
        list(&m.c, &[HANDLE_B]);
        assert!(admitted(&fx, bob()), "fixture: admitted before the move");
        let before = admission_of(&m, bob());
        assert!(
            !before.is_empty(),
            "fixture: the source holds an admission row"
        );
        fx.reset_writes();
        let mut http = HttpQueue::new();
        http.push(spki_answer());
        let got = relay_as(
            &fx,
            owner(),
            alice(),
            NOW,
            &mut http,
            &test_profile(),
            &ticket(),
        );
        assert_eq!(got, Ok(true));
        assert_eq!(character_rows(&m, alice()), character_expected(alice()));
        assert_eq!(admission_of(&m, bob()), before, "the admission row stays");
        assert_eq!(fx.writes_to("world_admission"), 0, "and is not written");
    }

    // ---------------------------------------------------------------------------------
    // A source in the game.
    // ---------------------------------------------------------------------------------

    /// The source is in the game (a `player` row, its character at zone 2, tile (14, 15)
    /// facing North, a `move_intent` row, a conversation, no saved position): the caller holds
    /// a `last_position` row with that zone, tile and facing, and the source holds no
    /// `player`, `character`, `move_intent`, `player_conversation` or `last_position` row. A
    /// bystander in the game keeps its presence rows.
    ///
    /// kills: the live position dropped, or the saved one taken over it; the presence rows
    /// re-keyed or left; a bystander's character deleted.
    #[test]
    fn a_source_in_the_game_leaves_its_live_position_to_the_caller_lpw42_4() {
        let fx = fixture();
        let m = move_world(&fx);
        hold(&m, bob(), HANDLE_B, false);
        seed_character(&m, bob());
        assert_eq!(
            m.last_position.remove(bob()),
            1,
            "fixture: an identity in the game has no saved position"
        );
        m.player.seed(&player_row(bob(), LIVE_ENTITY));
        m.character
            .seed(&character_at(LIVE_ENTITY, 2, 14, 15, Direction::North));
        m.intent.seed(&intent_row(LIVE_ENTITY));
        m.conversation.seed(&conversation_row(bob()));
        m.player.seed(&player_row(carol(), BYSTANDER_ENTITY));
        m.character
            .seed(&character_at(BYSTANDER_ENTITY, 0, 1, 2, Direction::South));
        m.intent.seed(&intent_row(BYSTANDER_ENTITY));
        let (got, _) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Ok(true));
        assert_eq!(
            encs(&m.last_position.rows()),
            encs(&[LastPosition {
                owner_identity: alice(),
                zone_id: 2,
                tile_x: 14,
                tile_y: 15,
                facing: Direction::North,
            }]),
            "the live position, under the caller alone"
        );
        assert_eq!(
            encs(&m.player.rows()),
            encs(&[player_row(carol(), BYSTANDER_ENTITY)]),
            "the source's player row goes; the bystander's stays"
        );
        assert_eq!(
            encs(&m.character.rows()),
            encs(&[character_at(BYSTANDER_ENTITY, 0, 1, 2, Direction::South)]),
            "the source's character goes"
        );
        assert_eq!(
            encs(&m.intent.rows()),
            encs(&[intent_row(BYSTANDER_ENTITY)]),
            "the source's move_intent goes"
        );
        assert_eq!(
            encs(&m.conversation.rows()),
            Vec::<Vec<u8>>::new(),
            "the conversation goes"
        );
    }

    // ---------------------------------------------------------------------------------
    // The names that carry a move.
    // ---------------------------------------------------------------------------------

    /// `spki:` and `dns:` names carry a move whatever `ip_confirmed` says; an `ip:` name
    /// exactly when it is confirmed; nothing else does.
    ///
    /// kills: the inert `false`; an `ip:` name carrying a move unconfirmed; a case-blind or
    /// space-trimming prefix test; a prefix with no colon accepted.
    #[test]
    fn a_name_carries_a_move_when_it_is_spki_dns_or_a_confirmed_ip_name_lpw42_5() {
        let rows: Vec<(&str, bool, bool)> = vec![
            (WORLD_NAME, false, true),
            (WORLD_NAME, true, true),
            (DNS_NAME, false, true),
            (DNS_NAME, true, true),
            (IP_NAME, false, false),
            (IP_NAME, true, true),
            ("", false, false),
            ("", true, false),
            ("spki", false, false),
            ("spki", true, false),
            ("SPKI:TEST-fingerprint_00/realm-one", false, false),
            ("SPKI:TEST-fingerprint_00/realm-one", true, false),
            (" spki:TEST-fingerprint_00/realm-one", false, false),
            (" spki:TEST-fingerprint_00/realm-one", true, false),
            ("dns", true, false),
            ("DNS:realm-one.example.net", true, false),
            (" dns:realm-one.example.net", true, false),
            ("ip", true, false),
            ("IP:203.0.113.9:3000", true, false),
            (" ip:203.0.113.9:3000", true, false),
        ];
        for (name, ip_confirmed, want) in rows {
            assert_eq!(
                crate::account_checks::name_carries_move(name, ip_confirmed),
                want,
                "{name:?}, ip confirmed: {ip_confirmed}"
            );
        }
    }

    /// A ticket answered with the world's `ip:` name for a handle another identity holds, by an
    /// answer that reports no address on a world with no stored address, presents the name but
    /// does not confirm it: refused with [`REJECT_HANDLE_HELD`], nothing moved and nothing
    /// stored; the same world answered with its `spki:` name moves the character.
    ///
    /// kills: `ip_confirmed = true` whenever the name is presented; an `ip:` name confirmed by
    /// an empty `world_egress`; any held handle moved.
    #[test]
    fn an_ip_name_moves_nothing_lpw42_5() {
        let fx = fixture();
        let m = moving_world(&fx);
        let before = snapshot(&m);
        fx.reset_writes();
        let (got, _) = alice_checks(
            &fx,
            ok_answer(ticket_answer_with(HANDLE_B, true, IP_NAME, None)),
        );
        assert_eq!(got, Err(REJECT_HANDLE_HELD.to_string()));
        assert_eq!(snapshot(&m), before, "every row stays");
        assert_eq!(
            written(&fx, &m),
            Vec::<(&str, u32)>::new(),
            "no write but the budget's"
        );
        assert_eq!(egress(&m.c), Vec::<(u8, String, i64)>::new(), "no address");
        assert_eq!(fx.writes_to("world_egress"), 0, "no address written");
        drop(fx);

        let fx = fixture();
        let m = moving_world(&fx);
        let (got, _) = alice_checks(&fx, spki_answer());
        assert_eq!(got, Ok(true), "control: the spki name");
        assert_eq!(character_rows(&m, alice()), character_expected(alice()));
    }

    /// A ticket answered with a `dns:` name the world holds moves the character.
    ///
    /// kills: a move limited to `spki:` names.
    #[test]
    fn a_dns_name_the_world_holds_moves_the_character_lpw42_5() {
        let fx = fixture();
        let m = move_world(&fx);
        m.c.names.seed(&WorldName {
            name: DNS_NAME.to_string(),
        });
        hold(&m, bob(), HANDLE_B, false);
        seed_character(&m, bob());
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_B, true, DNS_NAME)));
        assert_eq!(got, Ok(true));
        assert_eq!(character_rows(&m, alice()), character_expected(alice()));
        assert_holds_nothing(&m, bob(), "the source");
        assert_eq!(moves(&m.c), vec![(bob().to_byte_array(), NOW)]);
    }

    // ---------------------------------------------------------------------------------
    // The read path.
    // ---------------------------------------------------------------------------------

    /// Two identities each hold a `world_move` row and each reads its own alone through
    /// `my_world_move`; a third reads none.
    ///
    /// kills: the inert view; a view answering every row or another identity's.
    #[test]
    fn my_world_move_answers_the_senders_own_row_alone_lpw42_6() {
        let fx = fixture();
        let w = owned_world(&fx);
        for (who, ms) in [(alice(), T0 - 1), (bob(), T0 - 2)] {
            w.moves.seed(&WorldMove {
                identity: who,
                moved_at_ms: ms,
            });
        }
        let seen = |who: Identity| -> Vec<([u8; 32], i64)> {
            fx.call_view::<WorldMove>(VIEW_MY_WORLD_MOVE, who)
                .iter()
                .map(|r| (r.identity.to_byte_array(), r.moved_at_ms))
                .collect()
        };
        assert_eq!(seen(alice()), vec![(alice().to_byte_array(), T0 - 1)]);
        assert_eq!(seen(bob()), vec![(bob().to_byte_array(), T0 - 2)]);
        assert_eq!(seen(carol()), Vec::<([u8; 32], i64)>::new());
    }
}

// =====================================================================================
// The world's address: the pure rules, what an answer stores, and which names a redeem
// presents.
// =====================================================================================

mod egress_rules {
    use super::*;
    use serde_json::{json, Value};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    const DNS: &str = "dns:realm-one.example.net";
    /// An `ip:` name carrying the IPv6 address [`IP6`].
    const IP6_NAME: &str = "ip:[2606:4700:4700::1111]:8443/world-1";
    /// An IPv6 address as std prints it.
    const IP6: &str = "2606:4700:4700::1111";
    /// [`IP6`] with its zero run spelled out.
    const IP6_LONG: &str = "2606:4700:4700:0:0:0:0:1111";
    /// An IPv4 address [`IP_NAME`] does not carry.
    const OTHER_ADDRESS: &str = "198.51.100.7";
    const DEV_URL: &str = "https://auth.monster-realm.spookyowltech.com/world/check";
    const DEV_V4: &str = "https://ipv4.auth.monster-realm.spookyowltech.com/world/check";
    const DEV_V6: &str = "https://ipv6.auth.monster-realm.spookyowltech.com/world/check";

    fn v4() -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9))
    }

    fn v6() -> IpAddr {
        IpAddr::V6(Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111))
    }

    // ---------------------------------------------------------------------------------
    // The pure rules.
    // ---------------------------------------------------------------------------------

    /// An `ip:` name carries the address before its port or path, an IPv6 one in brackets;
    /// every other name carries none.
    ///
    /// kills: the inert `None`; the port or path read as part of the address; brackets
    /// refused around IPv6 or accepted around IPv4; an unbracketed IPv6 address read; a
    /// case-blind prefix; a host name accepted; an unclosed bracket read to the end.
    #[test]
    fn ip_name_address_reads_the_address_an_ip_name_carries_lpw43_5() {
        let rows: Vec<(&str, Option<IpAddr>)> = vec![
            ("ip:203.0.113.9:3000", Some(v4())),
            ("ip:203.0.113.9:3000/world-1", Some(v4())),
            ("ip:203.0.113.9/world-1", Some(v4())),
            ("ip:203.0.113.9", Some(v4())),
            (IP6_NAME, Some(v6())),
            ("ip:[2606:4700:4700::1111]", Some(v6())),
            (WORLD_NAME, None),
            (DNS, None),
            ("IP:203.0.113.9:1", None),
            ("ip:[203.0.113.9]:1", None),
            ("ip:2606:4700::1111:1", None),
            ("ip:example.com:1", None),
            ("ip:", None),
            ("ip:[::1", None),
        ];
        for (name, want) in rows {
            assert_eq!(crate::account_checks::ip_name_address(name), want, "{name}");
        }
    }

    /// kills: an IPv4-mapped address kept as an IPv6 address.
    #[test]
    fn an_ipv4_mapped_ip_name_carries_the_ipv4_address_lpw43_5() {
        assert_eq!(
            crate::account_checks::ip_name_address("ip:[::ffff:203.0.113.9]:1"),
            Some(v4())
        );
    }

    /// `check_url` puts `ipv4.` or `ipv6.` directly after the first `://`, and leaves every
    /// other case as it is.
    ///
    /// kills: the inert identity; the label put before the scheme or after the host; another
    /// family number labelled; a URL with no scheme labelled; the label put after a later
    /// `://`.
    #[test]
    fn check_url_labels_the_host_with_the_family_lpw43_5() {
        let world_url = "https://auth.monster-realm.invalid/world/check";
        let rows: Vec<(&str, Option<u8>, &str)> = vec![
            (DEV_URL, Some(4), DEV_V4),
            (DEV_URL, Some(6), DEV_V6),
            (DEV_URL, None, DEV_URL),
            (DEV_URL, Some(5), DEV_URL),
            (DEV_URL, Some(0), DEV_URL),
            (
                world_url,
                Some(4),
                "https://ipv4.auth.monster-realm.invalid/world/check",
            ),
            (
                world_url,
                Some(6),
                "https://ipv6.auth.monster-realm.invalid/world/check",
            ),
            (
                "auth.monster-realm.invalid/world/check",
                Some(4),
                "auth.monster-realm.invalid/world/check",
            ),
            (
                "https://a.example/next?to=https://b.example",
                Some(4),
                "https://ipv4.a.example/next?to=https://b.example",
            ),
        ];
        for (url, family, want) in rows {
            assert_eq!(
                crate::account_checks::check_url(url, family),
                want,
                "{url} over {family:?}"
            );
        }
    }

    // ---------------------------------------------------------------------------------
    // What an answer stores.
    // ---------------------------------------------------------------------------------

    /// The two procedures that store an answer's address.
    #[derive(Clone, Copy, Debug)]
    enum Path {
        Redeem,
        Recheck,
    }

    const PATHS: [Path; 2] = [Path::Redeem, Path::Recheck];

    /// Seeds what `path` needs on [`owned_world`]: for the re-check, alice's row.
    fn prepare(w: &W<'_>, path: Path) {
        if let Path::Recheck = path {
            w.accounts.seed(&account_row(
                alice(),
                HANDLE_A,
                false,
                T0 - 86_400_000,
                false,
            ));
        }
    }

    /// `path` at [`NOW`] on the `test` build, answered `200` with `address` as the answer's
    /// `address` member: alice redeems a ticket the service accepts for [`HANDLE_A`] under
    /// [`WORLD_NAME`], or the database re-checks alice's row.
    fn run(fx: &Fixture, path: Path, address: Option<Value>) -> Result<(), String> {
        let mut http = HttpQueue::new();
        match path {
            Path::Redeem => {
                http.push(ok_answer(ticket_answer_with(
                    HANDLE_A, true, WORLD_NAME, address,
                )));
                check_as(fx, alice(), NOW, &mut http, &test_profile(), &ticket()).map(|_| ())
            }
            Path::Recheck => {
                http.push(ok_answer(handle_answer_with(HANDLE_A, true, address)));
                recheck_as(
                    fx,
                    Caller::Database,
                    NOW,
                    &mut http,
                    &test_profile(),
                    recheck_of(alice(), 1),
                )
            }
        }
    }

    /// What `path` leaves on an [`owned_world`] holding `rows` in `world_egress`, answered with
    /// `address`.
    struct After {
        got: Result<(), String>,
        egress: Vec<(u8, String, i64)>,
        egress_writes: u32,
        /// Alice's row holds the answer: [`HANDLE_A`], entitled, at [`NOW`].
        answer_stored: bool,
    }

    fn after(path: Path, rows: &[WorldEgress], address: Option<Value>) -> After {
        let fx = fixture();
        let w = owned_world(&fx);
        prepare(&w, path);
        for row in rows {
            w.egress.seed(row);
        }
        fx.reset_writes();
        let got = run(&fx, path, address);
        After {
            got,
            egress: egress(&w),
            egress_writes: fx.writes_to("world_egress"),
            answer_stored: accounts(&w).contains(&view(&account_row(
                alice(),
                HANDLE_A,
                true,
                NOW,
                false,
            ))),
        }
    }

    /// kills: the inert store; the address stored under family 6 or at another time; the
    /// answer's own storing skipped.
    #[test]
    fn an_ipv4_address_is_stored_for_family_4_lpw43_5() {
        for path in PATHS {
            let a = after(path, &[], Some(json!(ADDRESS)));
            assert_eq!(a.got, Ok(()), "{path:?}");
            assert_eq!(a.egress, vec![(4, ADDRESS.to_string(), NOW)], "{path:?}");
            assert!(a.answer_stored, "{path:?}: the answer is stored");
        }
    }

    /// An IPv6 address the service spells out in full is stored as std prints it.
    ///
    /// kills: the answer's text stored as it came; the family taken as 4.
    #[test]
    fn an_ipv6_address_is_stored_for_family_6_as_std_prints_it_lpw43_5() {
        for path in PATHS {
            let a = after(path, &[], Some(json!(IP6_LONG)));
            assert_eq!(a.got, Ok(()), "{path:?}");
            assert_eq!(a.egress, vec![(6, IP6.to_string(), NOW)], "{path:?}");
        }
    }

    /// kills: an IPv4-mapped IPv6 address stored as family 6.
    #[test]
    fn an_ipv4_mapped_address_is_stored_as_the_ipv4_address_lpw43_5() {
        for path in PATHS {
            let a = after(path, &[], Some(json!("::ffff:203.0.113.9")));
            assert_eq!(a.got, Ok(()), "{path:?}");
            assert_eq!(a.egress, vec![(4, ADDRESS.to_string(), NOW)], "{path:?}");
        }
    }

    /// A stored row of the answer's family is replaced; the other family's row stays.
    ///
    /// kills: a second insert under one family; the family's row kept; the other family's row
    /// erased or restamped.
    #[test]
    fn a_stored_row_of_the_same_family_is_replaced_and_the_other_family_kept_lpw43_5() {
        let rows = [
            egress_row(4, OTHER_ADDRESS, T0 - 5_000),
            egress_row(6, IP6, T0 - 7_000),
        ];
        for path in PATHS {
            let a = after(path, &rows, Some(json!(ADDRESS)));
            assert_eq!(a.got, Ok(()), "{path:?}");
            assert_eq!(
                a.egress,
                vec![
                    (4, ADDRESS.to_string(), NOW),
                    (6, IP6.to_string(), T0 - 7_000),
                ],
                "{path:?}"
            );
        }
    }

    /// An absent or `null` address and a string that is no address store nothing, and the
    /// rest of the answer is stored as usual; a string that is an address, on the same path, is
    /// stored.
    ///
    /// kills: the answer refused for its address; the text stored unparsed; a bracketed, zoned
    /// or ported address accepted; a stored row cleared by an answer that reports none.
    #[test]
    fn an_absent_null_or_unparsable_address_stores_nothing_lpw43_5() {
        let cases: Vec<(&str, Option<Value>)> = vec![
            ("absent", None),
            ("null", Some(Value::Null)),
            ("a word", Some(json!("not-an-address"))),
            ("empty", Some(json!(""))),
            ("bracketed", Some(json!("[2606:4700:4700::1111]"))),
            ("with a zone", Some(json!("fe80::1%1"))),
            ("with a port", Some(json!("203.0.113.9:3000"))),
        ];
        let kept = egress_row(6, IP6, T0 - 1_000);
        for path in PATHS {
            for (label, address) in cases.clone() {
                let a = after(path, std::slice::from_ref(&kept), address);
                assert_eq!(a.got, Ok(()), "{path:?}, {label}");
                assert!(a.answer_stored, "{path:?}, {label}: the answer is stored");
                assert_eq!(
                    a.egress,
                    vec![(6, IP6.to_string(), T0 - 1_000)],
                    "{path:?}, {label}: the stored row stays"
                );
                assert_eq!(a.egress_writes, 0, "{path:?}, {label}: no address written");
            }
            let control = after(path, &[], Some(json!(ADDRESS)));
            assert_eq!(
                control.egress,
                vec![(4, ADDRESS.to_string(), NOW)],
                "{path:?}: control"
            );
        }
    }

    /// An answer reporting the address its family's row holds, confirmed 5 h before the call,
    /// restamps that row with the call's time and keeps its address.
    ///
    /// kills: a stored row left as it is when the reported address is the one it holds.
    #[test]
    fn an_answer_reporting_the_stored_address_restamps_its_row_lpw43_5() {
        let rows = [egress_row(4, ADDRESS, NOW - 18_000_000)];
        for path in PATHS {
            let a = after(path, &rows, Some(json!(ADDRESS)));
            assert_eq!(a.got, Ok(()), "{path:?}");
            assert!(a.answer_stored, "{path:?}: the answer is stored");
            assert_eq!(a.egress, vec![(4, ADDRESS.to_string(), NOW)], "{path:?}");
        }
    }

    /// An answer whose `address` member is absent or `null` leaves the row of the family the
    /// world asks over as it is, with no write to `world_egress`, and stores the rest of the
    /// answer.
    ///
    /// kills: the asked family's row deleted or restamped by an answer that reports no address.
    #[test]
    fn an_answer_with_no_address_leaves_the_asked_familys_row_alone_lpw43_5() {
        let seeded = egress_row(4, ADDRESS, NOW - 18_000_000);
        for path in PATHS {
            for (label, address) in [("absent", None), ("null", Some(Value::Null))] {
                let a = after(path, std::slice::from_ref(&seeded), address);
                assert_eq!(a.got, Ok(()), "{path:?}, {label}");
                assert!(a.answer_stored, "{path:?}, {label}: the answer is stored");
                assert_eq!(
                    a.egress,
                    vec![(4, ADDRESS.to_string(), NOW - 18_000_000)],
                    "{path:?}, {label}: the asked family's row stays"
                );
                assert_eq!(a.egress_writes, 0, "{path:?}, {label}: no address written");
            }
        }
    }

    /// An `address` member of another JSON type makes the body no answer: refused with
    /// [`REJECT_CHECK_UNANSWERED`], no account row written and no address stored.
    ///
    /// kills: the member ignored when it is not a string; the address read out of an array or
    /// object.
    #[test]
    fn an_address_of_another_json_type_is_no_answer_lpw43_5() {
        let cases: Vec<(&str, Value)> = vec![
            ("a number", json!(7)),
            ("a boolean", json!(true)),
            ("an array", json!([ADDRESS])),
            ("an object", json!({ "address": ADDRESS })),
        ];
        for path in PATHS {
            for (label, address) in cases.clone() {
                let fx = fixture();
                let w = owned_world(&fx);
                prepare(&w, path);
                let before = accounts(&w);
                fx.reset_writes();
                let got = run(&fx, path, Some(address));
                assert_eq!(
                    got,
                    Err(REJECT_CHECK_UNANSWERED.to_string()),
                    "{path:?}, {label}"
                );
                assert_eq!(accounts(&w), before, "{path:?}, {label}: the rows stay");
                assert_eq!(fx.writes_to("world_account"), 0, "{path:?}, {label}");
                assert_eq!(
                    egress(&w),
                    Vec::<(u8, String, i64)>::new(),
                    "{path:?}, {label}"
                );
                assert_eq!(fx.writes_to("world_egress"), 0, "{path:?}, {label}");
            }
        }
    }

    /// A redeem answered with no usable answer stores no address, though the body reports one;
    /// the same world answered usably stores it.
    ///
    /// kills: the address read from a `403` or another status; the address stored before the
    /// body is judged the answer's shape.
    #[test]
    fn a_redeem_with_no_usable_answer_stores_no_address_lpw43_5() {
        let raw = |text: &str| -> Stubbed { Ok((200, text.to_string())) };
        let good = ticket_answer(HANDLE_A, true, WORLD_NAME);
        let cases: Vec<(&str, Stubbed, &str)> = vec![
            ("403", Ok((403, good.clone())), REJECT_TICKET_REFUSED),
            ("500", Ok((500, good.clone())), REJECT_CHECK_UNANSWERED),
            (
                "a transport error",
                Err("the request timed out".to_string()),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "no handle",
                raw(r#"{"entitled":true,"address":"203.0.113.9","name":"ip:203.0.113.9:3000"}"#),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "entitled a string",
                raw(
                    r#"{"handle":"k1.AbCdEf0123456789-_","entitled":"true","address":"203.0.113.9","name":"ip:203.0.113.9:3000"}"#,
                ),
                REJECT_CHECK_UNANSWERED,
            ),
            (
                "a 1025-byte handle",
                Ok((
                    200,
                    ticket_answer(&format!("k1.{}", "a".repeat(1022)), true, WORLD_NAME),
                )),
                REJECT_CHECK_UNANSWERED,
            ),
        ];
        for (label, outcome, want) in cases {
            let fx = fixture();
            let w = owned_world(&fx);
            fx.reset_writes();
            let (got, sent) = alice_checks(&fx, answer_of(&outcome));
            assert_eq!(sent.len(), 1, "{label}: the one request");
            assert_eq!(got, Err(want.to_string()), "{label}");
            assert_eq!(egress(&w), Vec::<(u8, String, i64)>::new(), "{label}");
            assert_eq!(fx.writes_to("world_egress"), 0, "{label}");
        }
        let fx = fixture();
        let w = owned_world(&fx);
        let (got, _) = alice_checks(&fx, ok_answer(good));
        assert_eq!(got, Ok(true), "control");
        assert_eq!(egress(&w), vec![(4, ADDRESS.to_string(), NOW)], "control");
    }

    /// A redeem refused when it lands (the caller holds another handle) has still stored the
    /// answer's address, and its account row stays.
    ///
    /// kills: the address stored in the transaction that stores the account row, so the
    /// refusal rolls it back.
    #[test]
    fn a_redeem_refused_after_its_answer_has_stored_the_address_lpw43_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, T0 - 1_000, false));
        let before = accounts(&w);
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A2, true, WORLD_NAME)));
        assert_eq!(got, Err(REJECT_IDENTITY_HOLDS_ANOTHER.to_string()));
        assert_eq!(accounts(&w), before, "the account rows stay");
        assert_eq!(egress(&w), vec![(4, ADDRESS.to_string(), NOW)]);
    }

    /// The owner's relay for [`alice`], answered with a usable address, stores the row for her
    /// and the address for its family at the call's time.
    ///
    /// kills: the address stored only on a caller's own `check_account`.
    #[test]
    fn the_owners_relay_stores_the_answers_address_lpw43_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        let mut http = HttpQueue::new();
        http.push(ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        let got = relay_as(
            &fx,
            owner(),
            alice(),
            NOW,
            &mut http,
            &test_profile(),
            &ticket(),
        );
        assert_eq!(got, Ok(true));
        assert!(accounts(&w).contains(&view(&account_row(alice(), HANDLE_A, true, NOW, false))));
        assert_eq!(egress(&w), vec![(4, ADDRESS.to_string(), NOW)]);
    }

    /// The owner's relay refused when it lands (`who` holds another handle) has still stored
    /// the answer's address, and the account rows stay.
    ///
    /// kills: the relay's address stored in the transaction that stores the account row, so
    /// the refusal rolls it back; the address stored only on a caller's own `check_account`.
    #[test]
    fn a_relay_refused_after_its_answer_has_stored_the_address_lpw43_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, T0 - 1_000, false));
        let before = accounts(&w);
        let mut http = HttpQueue::new();
        http.push(ok_answer(ticket_answer(HANDLE_A2, true, WORLD_NAME)));
        let got = relay_as(
            &fx,
            owner(),
            alice(),
            NOW,
            &mut http,
            &test_profile(),
            &ticket(),
        );
        assert_eq!(got, Err(REJECT_IDENTITY_HOLDS_ANOTHER.to_string()));
        assert_eq!(accounts(&w), before, "the account rows stay");
        assert_eq!(egress(&w), vec![(4, ADDRESS.to_string(), NOW)]);
    }

    /// A re-check whose row is checked again while it waits leaves the newer row alone and
    /// still stores the answer's address.
    ///
    /// kills: the address stored only when the account row is.
    #[test]
    fn a_recheck_whose_row_changed_during_the_wait_has_stored_the_address_lpw43_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            false,
            T0 - 86_400_000,
            false,
        ));
        let mut http = HttpQueue::new();
        http.push(ok_answer(handle_answer(HANDLE_A, true)).while_waiting(|| {
            assert_eq!(w.accounts.remove(alice()), 1);
            w.accounts
                .seed(&account_row(alice(), HANDLE_A, false, NOW - 1, false));
        }));
        let got = recheck_as(
            &fx,
            Caller::Database,
            NOW,
            &mut http,
            &test_profile(),
            recheck_of(alice(), 1),
        );
        assert_eq!(got, Ok(()));
        assert!(
            accounts(&w).contains(&view(&account_row(
                alice(),
                HANDLE_A,
                false,
                NOW - 1,
                false
            ))),
            "the newer row stays: {:?}",
            accounts(&w)
        );
        assert_eq!(egress(&w), vec![(4, ADDRESS.to_string(), NOW)]);
    }

    /// A re-check answered with no handle stores the row not entitled and stores the answer's
    /// address for its family at the run's time.
    ///
    /// kills: the address stored only when the answer names a handle.
    #[test]
    fn a_recheck_answered_with_no_handle_stores_the_address_lpw43_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            true,
            T0 - 86_400_000,
            false,
        ));
        let mut http = HttpQueue::new();
        http.push(ok_answer(unknown_handle_answer(false)));
        let got = recheck_as(
            &fx,
            Caller::Database,
            NOW,
            &mut http,
            &test_profile(),
            recheck_of(alice(), 1),
        );
        assert_eq!(got, Ok(()));
        assert!(
            accounts(&w).contains(&view(&account_row(alice(), HANDLE_A, false, NOW, false))),
            "{:?}",
            accounts(&w)
        );
        assert_eq!(egress(&w), vec![(4, ADDRESS.to_string(), NOW)]);
    }

    // ---------------------------------------------------------------------------------
    // Which names a redeem presents, and where it asks.
    // ---------------------------------------------------------------------------------

    /// A world owned by [`owner`] named `names`, holding no account row.
    fn named_world<'a>(fx: &'a Fixture, names: &[&str]) -> W<'a> {
        let w = world(fx);
        w.config.seed(&Config {
            id: 0,
            content_version: 0,
            owner_identity: owner(),
        });
        for name in names {
            w.names.seed(&WorldName {
                name: (*name).to_string(),
            });
        }
        w
    }

    /// The request's `names`, sorted.
    fn sent_names(req: &SentRequest) -> Vec<String> {
        sorted(
            body_of(req)["names"]
                .as_array()
                .expect("`names` is an array")
                .iter()
                .map(|n| n.as_str().expect("a name is a string").to_string())
                .collect(),
        )
    }

    /// The names alice's redeem at [`NOW`] presents, and the URL it asks, on a world named
    /// `names` holding `rows` in `world_egress`.
    fn presented(names: &[&str], rows: &[WorldEgress]) -> (Vec<String>, String) {
        let fx = fixture();
        let w = named_world(&fx, names);
        for row in rows {
            w.egress.seed(row);
        }
        let (_, sent) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)));
        assert_eq!(sent.len(), 1, "one request");
        (sent_names(&sent[0]), sent[0].url.clone())
    }

    /// A row of the other family leaves the world's IPv4 `ip:` name presented, beside its
    /// `spki:` and `dns:` names, over IPv4.
    ///
    /// kills: the other family's row read as disowning the name; the request sent over the
    /// profile's own URL.
    #[test]
    fn an_ip_name_is_presented_while_its_family_holds_no_address_lpw43_5() {
        assert_eq!(
            presented(
                &[WORLD_NAME, DNS, IP_NAME],
                &[egress_row(6, IP6, NOW - 1_000)]
            ),
            (strings(&[WORLD_NAME, DNS, IP_NAME]), DEV_V4.to_string())
        );
    }

    /// kills: a freshness bound below 25 h.
    #[test]
    fn an_ip_name_confirmed_25_hours_less_1_ms_ago_is_presented_lpw43_5() {
        assert_eq!(
            presented(
                &[WORLD_NAME, DNS, IP_NAME],
                &[egress_row(4, ADDRESS, NOW - 89_999_999)]
            ),
            (strings(&[WORLD_NAME, DNS, IP_NAME]), DEV_V4.to_string())
        );
    }

    /// kills: no freshness bound; a bound above 25 h; `<=` for `<`.
    #[test]
    fn an_ip_name_confirmed_exactly_25_hours_ago_is_not_presented_lpw43_5() {
        assert_eq!(
            presented(
                &[WORLD_NAME, DNS, IP_NAME],
                &[egress_row(4, ADDRESS, NOW - 90_000_000)]
            ),
            (strings(&[WORLD_NAME, DNS]), DEV_V4.to_string())
        );
    }

    /// kills: the stored address not compared; any row of the family read as confirming.
    #[test]
    fn an_ip_name_whose_family_holds_another_address_is_not_presented_lpw43_5() {
        assert_eq!(
            presented(
                &[WORLD_NAME, DNS, IP_NAME],
                &[egress_row(4, OTHER_ADDRESS, NOW - 1_000)]
            ),
            (strings(&[WORLD_NAME, DNS]), DEV_V4.to_string())
        );
    }

    /// kills: a row stamped after the check's time read as fresh (an unsigned or absolute age).
    #[test]
    fn an_ip_name_confirmed_after_now_is_not_presented_lpw43_5() {
        assert_eq!(
            presented(
                &[WORLD_NAME, DNS, IP_NAME],
                &[egress_row(4, ADDRESS, NOW + 1)]
            ),
            (strings(&[WORLD_NAME, DNS]), DEV_V4.to_string())
        );
    }

    /// kills: a family-6 row judged stale by a bound below 25 h.
    #[test]
    fn an_ipv6_ip_name_confirmed_25_hours_less_1_ms_ago_is_presented_lpw43_5() {
        assert_eq!(
            presented(
                &[WORLD_NAME, IP6_NAME],
                &[egress_row(6, IP6, NOW - 89_999_999)]
            ),
            (strings(&[WORLD_NAME, IP6_NAME]), DEV_V6.to_string())
        );
    }

    /// kills: freshness judged for family 4 only; a family-6 bound above 25 h; `<=` for `<`.
    #[test]
    fn an_ipv6_ip_name_confirmed_exactly_25_hours_ago_is_not_presented_lpw43_5() {
        assert_eq!(
            presented(
                &[WORLD_NAME, IP6_NAME],
                &[egress_row(6, IP6, NOW - 90_000_000)]
            ),
            (strings(&[WORLD_NAME]), DEV_V6.to_string())
        );
    }

    /// An IPv6 `ip:` name spelling its address in full matches the stored address std prints.
    ///
    /// kills: the addresses compared as text.
    #[test]
    fn an_ipv6_ip_name_spelled_another_way_is_presented_lpw43_5() {
        let name = "ip:[2606:4700:4700:0:0:0:0:1111]:8443";
        assert_eq!(
            presented(&[WORLD_NAME, DNS, name], &[egress_row(6, IP6, NOW - 1_000)]),
            (strings(&[WORLD_NAME, DNS, name]), DEV_V6.to_string())
        );
    }

    /// An `ip:` name carrying an IPv4-mapped address is an IPv4 name: asked over IPv4 and
    /// confirmed by the IPv4 row.
    ///
    /// kills: the mapped name read as IPv6 (asked over IPv6, or never presented).
    #[test]
    fn an_ipv4_mapped_ip_name_is_presented_as_ipv4_lpw43_5() {
        let name = "ip:[::ffff:203.0.113.9]:3000";
        assert_eq!(
            presented(
                &[WORLD_NAME, DNS, name],
                &[egress_row(4, ADDRESS, NOW - 1_000)]
            ),
            (strings(&[WORLD_NAME, DNS, name]), DEV_V4.to_string())
        );
    }

    /// An `ip:` name that carries no address is never presented, and gives the world no
    /// family.
    ///
    /// kills: every name not starting with `spki:` or `dns:` presented while no row is stored;
    /// a host name read as a family.
    #[test]
    fn an_ip_name_that_carries_no_address_is_never_presented_lpw43_5() {
        assert_eq!(
            presented(&[WORLD_NAME, DNS, "ip:example.com:3000"], &[]),
            (strings(&[WORLD_NAME, DNS]), DEV_URL.to_string())
        );
    }

    /// A world naming `ip:` names of both families asks over IPv4 and never presents the
    /// IPv6 one.
    ///
    /// kills: IPv6 preferred; the name of the other family presented.
    #[test]
    fn a_world_with_ip_names_of_both_families_asks_over_ipv4_only_lpw43_5() {
        assert_eq!(
            presented(&[WORLD_NAME, IP_NAME, IP6_NAME], &[]),
            (strings(&[WORLD_NAME, IP_NAME]), DEV_V4.to_string())
        );
    }

    /// kills: the family fixed at 4; an IPv6 name never presented.
    #[test]
    fn a_world_naming_only_an_ipv6_ip_name_asks_over_ipv6_lpw43_5() {
        assert_eq!(
            presented(&[WORLD_NAME, IP6_NAME], &[]),
            (strings(&[WORLD_NAME, IP6_NAME]), DEV_V6.to_string())
        );
    }

    /// kills: a family label added to a world with no `ip:` name.
    #[test]
    fn a_world_with_no_ip_name_asks_the_profiles_own_url_lpw43_5() {
        assert_eq!(
            presented(&[WORLD_NAME, DNS], &[egress_row(4, ADDRESS, NOW - 1_000)]),
            (strings(&[WORLD_NAME, DNS]), DEV_URL.to_string())
        );
    }

    /// A world whose only name is an `ip:` name its row disowns presents no name: refused with
    /// [`REJECT_WORLD_UNNAMED`] before the charge, with no request; the same world whose row
    /// holds the name's address sends.
    ///
    /// kills: the unnamed check made on the stored names, not the presented ones; the budget
    /// charged before it; a request with an empty `names`.
    #[test]
    fn a_world_that_presents_no_name_is_unnamed_lpw43_5() {
        let fx = fixture();
        let w = named_world(&fx, &[IP_NAME]);
        w.egress.seed(&egress_row(4, OTHER_ADDRESS, NOW - 1_000));
        w.budget.seed(&budget_row(T0, 3));
        fx.reset_writes();
        let mut http = HttpQueue::new();
        let got = check_as(&fx, alice(), NOW, &mut http, &test_profile(), &ticket());
        assert_eq!(got, Err(REJECT_WORLD_UNNAMED.to_string()));
        assert!(http.requests().is_empty(), "no request");
        assert_eq!(budget(&w), vec![(0, T0, 3)], "nothing spent");
        assert_eq!(fx.writes_to("world_check_budget"), 0);
        drop(fx);

        let fx = fixture();
        let w = named_world(&fx, &[IP_NAME]);
        w.egress.seed(&egress_row(4, ADDRESS, NOW - 1_000));
        let mut http = HttpQueue::new();
        http.push(ok_answer(ticket_answer(HANDLE_A, true, IP_NAME)));
        let got = check_as(&fx, alice(), NOW, &mut http, &test_profile(), &ticket());
        assert_eq!(got, Ok(true), "control");
        assert_eq!(http.requests().len(), 1, "control: one request");
        assert_eq!(sent_names(&http.requests()[0]), strings(&[IP_NAME]));
    }

    // ---------------------------------------------------------------------------------
    // The name judged when the answer lands.
    // ---------------------------------------------------------------------------------

    /// A world with no stored address presents its `ip:` name; an answer naming it that
    /// reports another address is refused with [`REJECT_TICKET_REFUSED`], stores no account
    /// row, and has stored the reported address.
    ///
    /// kills: the answered name judged against the names as stored, not as presented after
    /// the answer's address; the refusal rolling back the address.
    #[test]
    fn an_answer_reporting_another_address_than_its_ip_name_is_refused_lpw43_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        let before = accounts(&w);
        fx.reset_writes();
        let (got, sent) = alice_checks(
            &fx,
            ok_answer(ticket_answer_with(
                HANDLE_A,
                true,
                IP_NAME,
                Some(json!(OTHER_ADDRESS)),
            )),
        );
        assert_eq!(sent.len(), 1, "one request");
        assert_eq!(
            sent_names(&sent[0]),
            strings(&[WORLD_NAME, IP_NAME]),
            "the name is presented"
        );
        assert_eq!(got, Err(REJECT_TICKET_REFUSED.to_string()));
        assert_eq!(accounts(&w), before, "no account row");
        assert_eq!(fx.writes_to("world_account"), 0);
        assert_eq!(egress(&w), vec![(4, OTHER_ADDRESS.to_string(), NOW)]);
    }

    /// The same world answered with the name's own address stores the row, and the name is
    /// confirmed.
    ///
    /// kills: an `ip:` answer refused whatever it reports; the address not stored.
    #[test]
    fn an_answer_reporting_its_ip_names_own_address_is_stored_and_confirms_it_lpw43_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_A, true, IP_NAME)));
        assert_eq!(got, Ok(true));
        assert!(accounts(&w).contains(&view(&account_row(alice(), HANDLE_A, true, NOW, false))));
        assert_eq!(egress(&w), vec![(4, ADDRESS.to_string(), NOW)]);
    }

    /// kills: the re-check left on the profile's own URL.
    #[test]
    fn a_recheck_asks_over_the_family_of_the_worlds_ip_name_lpw43_5() {
        let fx = fixture();
        let w = named_world(&fx, &[WORLD_NAME, IP6_NAME]);
        w.accounts.seed(&account_row(
            alice(),
            HANDLE_A,
            false,
            T0 - 86_400_000,
            false,
        ));
        let mut http = HttpQueue::new();
        http.push(ok_answer(handle_answer(HANDLE_A, true)));
        let got = recheck_as(
            &fx,
            Caller::Database,
            NOW,
            &mut http,
            &test_profile(),
            recheck_of(alice(), 1),
        );
        assert_eq!(got, Ok(()));
        assert_eq!(http.requests().len(), 1);
        assert_recheck_request(&http.requests()[0], DEV_V6, HANDLE_A);
    }
}

// =====================================================================================
// A move through an `ip:` name the world has confirmed.
// =====================================================================================

mod ip_move {
    use super::character_move::{
        assert_holds_nothing, character_expected, character_rows, moving_world, snapshot, written,
        MW,
    };
    use super::*;
    use serde_json::json;

    const DNS: &str = "dns:realm-one.example.net";
    /// An IPv4 address [`IP_NAME`] does not carry.
    const OTHER_ADDRESS: &str = "198.51.100.7";
    /// An `ip:` name carrying the IPv6 address [`IP6`].
    const IP6_NAME: &str = "ip:[2606:4700:4700::1111]:8443/world-1";
    /// The address [`IP6_NAME`] carries, as std prints it.
    const IP6: &str = "2606:4700:4700::1111";
    /// The dev service's check name for IPv6.
    const DEV_V6: &str = "https://ipv6.auth.monster-realm.spookyowltech.com/world/check";

    /// The world of `m` named `names` in place of its own two names.
    fn rename(m: &MW<'_>, names: &[&str]) {
        for name in [WORLD_NAME, IP_NAME] {
            assert_eq!(m.c.names.remove(name.to_string()), 1, "fixture: {name}");
        }
        for name in names {
            m.c.names.seed(&WorldName {
                name: (*name).to_string(),
            });
        }
    }

    /// Bob's character is alice's: the handle's row points at her, bob holds a `world_move`
    /// row at the check's time, and every character row is under her.
    fn assert_moved_to_alice(m: &MW<'_>, label: &str) {
        assert_eq!(
            accounts(&m.c),
            vec![view(&account_row(alice(), HANDLE_B, true, NOW, true))],
            "{label}: the handle's one row is the caller's"
        );
        assert_eq!(
            moves(&m.c),
            vec![(bob().to_byte_array(), NOW)],
            "{label}: the source's world_move row"
        );
        assert_eq!(
            character_rows(m, alice()),
            character_expected(alice()),
            "{label}: every character row is under the caller"
        );
        assert_holds_nothing(m, bob(), label);
    }

    /// kills: `ip_confirmed` false whatever `world_egress` holds; the address judged before
    /// the answer's own is stored.
    #[test]
    fn an_ip_name_the_answer_confirms_moves_the_character_lpw43_6() {
        let fx = fixture();
        let m = moving_world(&fx);
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_B, true, IP_NAME)));
        assert_eq!(got, Ok(true));
        assert_moved_to_alice(&m, "confirmed by the answer");
    }

    /// kills: a confirmation that needs the answer to report the address; a freshness bound
    /// below 25 h.
    #[test]
    fn an_ip_name_a_row_confirmed_25_hours_less_1_ms_ago_moves_the_character_lpw43_6() {
        let fx = fixture();
        let m = moving_world(&fx);
        m.c.egress.seed(&egress_row(4, ADDRESS, NOW - 89_999_999));
        let (got, _) = alice_checks(
            &fx,
            ok_answer(ticket_answer_with(HANDLE_B, true, IP_NAME, None)),
        );
        assert_eq!(got, Ok(true));
        assert_moved_to_alice(&m, "confirmed by the stored row");
    }

    /// A row exactly 25 h old leaves the `ip:` name unpresented, so the service refuses the
    /// ticket (`403`) and nothing moves.
    ///
    /// kills: the stale name presented; `<=` for `<` in the freshness bound.
    #[test]
    fn an_ip_name_confirmed_exactly_25_hours_ago_moves_nothing_lpw43_6() {
        let fx = fixture();
        let m = moving_world(&fx);
        m.c.egress.seed(&egress_row(4, ADDRESS, NOW - 90_000_000));
        let before = snapshot(&m);
        fx.reset_writes();
        let (got, sent) = alice_checks(
            &fx,
            HttpAnswer::status(403, ticket_answer_with(HANDLE_B, true, IP_NAME, None)),
        );
        assert_eq!(sent.len(), 1, "one request");
        let names: Vec<String> = sorted(
            body_of(&sent[0])["names"]
                .as_array()
                .expect("`names` is an array")
                .iter()
                .map(|n| n.as_str().expect("a name is a string").to_string())
                .collect(),
        );
        assert_eq!(
            names,
            strings(&[WORLD_NAME]),
            "the ip: name is not presented"
        );
        assert_eq!(got, Err(REJECT_TICKET_REFUSED.to_string()));
        assert_eq!(snapshot(&m), before, "every row stays");
        assert_eq!(written(&fx, &m), Vec::<(&str, u32)>::new(), "no write");
        assert_eq!(
            egress(&m.c),
            vec![(4, ADDRESS.to_string(), NOW - 90_000_000)],
            "the stale row stays"
        );
    }

    /// An answer naming the `ip:` name that reports another address is refused when it lands,
    /// and nothing moves; the reported address is stored.
    ///
    /// kills: the move judged on the name alone; a held handle moved by an address the name
    /// does not carry.
    #[test]
    fn an_answer_reporting_another_address_moves_nothing_lpw43_6() {
        let fx = fixture();
        let m = moving_world(&fx);
        let before = snapshot(&m);
        fx.reset_writes();
        let (got, _) = alice_checks(
            &fx,
            ok_answer(ticket_answer_with(
                HANDLE_B,
                true,
                IP_NAME,
                Some(json!(OTHER_ADDRESS)),
            )),
        );
        assert_eq!(got, Err(REJECT_TICKET_REFUSED.to_string()));
        assert_eq!(snapshot(&m), before, "every row stays");
        assert_eq!(
            written(&fx, &m),
            Vec::<(&str, u32)>::new(),
            "no write but the budget's and the address's"
        );
        assert_eq!(egress(&m.c), vec![(4, OTHER_ADDRESS.to_string(), NOW)]);
    }

    /// With a stored row that disowns the `ip:` name, and an answer that reports that row's
    /// address, a `spki:` name and a `dns:` name each still move the character.
    ///
    /// kills: `spki:` or `dns:` names made to need a confirmed address; the presentation rule
    /// applied to names that are not `ip:` names.
    #[test]
    fn spki_and_dns_names_move_the_character_whatever_world_egress_holds_lpw43_6() {
        for name in [WORLD_NAME, DNS] {
            let fx = fixture();
            let m = moving_world(&fx);
            m.c.names.seed(&WorldName {
                name: DNS.to_string(),
            });
            m.c.egress.seed(&egress_row(4, OTHER_ADDRESS, NOW - 1_000));
            let (got, _) = alice_checks(
                &fx,
                ok_answer(ticket_answer_with(
                    HANDLE_B,
                    true,
                    name,
                    Some(json!(OTHER_ADDRESS)),
                )),
            );
            assert_eq!(got, Ok(true), "{name}");
            assert_moved_to_alice(&m, name);
            assert_eq!(
                egress(&m.c),
                vec![(4, OTHER_ADDRESS.to_string(), NOW)],
                "{name}: the reported address"
            );
        }
    }

    /// A world whose one name is an IPv6 `ip:` name asks at the `ipv6.` check name, and the
    /// answer reporting that name's own address confirms it: the character moves to the caller
    /// and the address is stored for family 6.
    ///
    /// kills: `ip_name_confirmed` true only for an IPv4 address; the IPv6 name judged before
    /// the answer's address is stored.
    #[test]
    fn an_ipv6_ip_name_alone_the_answer_confirms_moves_the_character_lpw43_6() {
        let fx = fixture();
        let m = moving_world(&fx);
        rename(&m, &[IP6_NAME]);
        let (got, sent) = alice_checks(
            &fx,
            ok_answer(ticket_answer_with(
                HANDLE_B,
                true,
                IP6_NAME,
                Some(json!(IP6)),
            )),
        );
        assert_eq!(sent.len(), 1, "one request");
        assert_first_contact(&sent[0], DEV_V6, &ticket(), &[IP6_NAME]);
        assert_eq!(got, Ok(true));
        assert_moved_to_alice(&m, "an IPv6 name alone");
        assert_eq!(egress(&m.c), vec![(6, IP6.to_string(), NOW)]);
    }

    /// Beside a `spki:` name, a ticket answered under the IPv6 `ip:` name with that name's own
    /// address moves the character to the caller.
    ///
    /// kills: `ip_name_confirmed` true only for an IPv4 address.
    #[test]
    fn an_ipv6_ip_name_beside_a_spki_name_the_answer_confirms_moves_the_character_lpw43_6() {
        let fx = fixture();
        let m = moving_world(&fx);
        rename(&m, &[WORLD_NAME, IP6_NAME]);
        let (got, sent) = alice_checks(
            &fx,
            ok_answer(ticket_answer_with(
                HANDLE_B,
                true,
                IP6_NAME,
                Some(json!(IP6)),
            )),
        );
        assert_eq!(sent.len(), 1, "one request");
        assert_first_contact(&sent[0], DEV_V6, &ticket(), &[WORLD_NAME, IP6_NAME]);
        assert_eq!(got, Ok(true));
        assert_moved_to_alice(&m, "an IPv6 name beside a spki: name");
        assert_eq!(egress(&m.c), vec![(6, IP6.to_string(), NOW)]);
    }
}
