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

/// The address the service reports; a check never reads it.
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
}

/// Registers what the checks, the arming, the view and the unbind touch. `config`,
/// `world_access` and `account` are read-only: a write to one aborts the test. The account
/// rows are read on both their keys; the re-check rows on both of theirs, the key drawn from a
/// sequence; the binding and nonce tables are registered for the unbind's erasure.
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
    ]
}

/// Every table a check could read.
const READ_TABLES: [&str; 9] = [
    "config",
    "world_access",
    "world_admission",
    "account",
    "world_name",
    "world_allowlist",
    "world_account",
    "world_check_budget",
    "recheck_schedule",
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
    /// the profile's service with the ticket, every world name and the world's identity, and
    /// the answered handle and entitlement stored for the caller at the transaction's time,
    /// in one write. The bystander's row stays.
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
            "https://auth.monster-realm.spookyowltech.com/world/check",
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
    /// of the module.
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
            "https://auth.monster-realm.invalid/world/check"
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
            "https://auth.monster-realm.spookyowltech.com/world/check"
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
            "https://auth.monster-realm.spookyowltech.com/world/check",
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

    /// An answered handle another identity holds is refused, and nothing is written.
    ///
    /// kills: the handle's row taken over by the caller; a second row under one handle.
    #[test]
    fn a_handle_another_identity_holds_is_refused_lpw23_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        let before = accounts(&w);
        fx.reset_writes();
        let (got, _) = alice_checks(&fx, ok_answer(ticket_answer(HANDLE_B, true, WORLD_NAME)));
        assert_eq!(got, Err(REJECT_HANDLE_HELD.to_string()));
        assert_eq!(accounts(&w), before);
        assert_eq!(fx.writes_to("world_account"), 0);
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

    /// Another identity takes the answered handle while the request waits: refused with
    /// [`REJECT_HANDLE_HELD`], and the caller holds no row.
    ///
    /// kills: the handle judged from the first transaction's read.
    #[test]
    fn a_handle_taken_during_the_wait_is_refused_lpw23_4() {
        let fx = fixture();
        let w = owned_world(&fx);
        let answer = ok_answer(ticket_answer(HANDLE_A, true, WORLD_NAME)).while_waiting(|| {
            w.accounts
                .seed(&account_row(carol(), HANDLE_A, true, NOW, false));
        });
        let (got, _) = alice_checks(&fx, answer);
        assert_eq!(got, Err(REJECT_HANDLE_HELD.to_string()));
        assert!(accounts(&w).iter().all(|r| r.1 != alice().to_byte_array()));
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

    /// The re-checked row is unbound while the re-check waits: nothing is written.
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
                "https://auth.monster-realm.spookyowltech.com/world/check",
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
