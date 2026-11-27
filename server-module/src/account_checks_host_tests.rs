//! The host's own account check, executed against the in-memory host: the owner marking the
//! identity the host plays as (`mark_host`, the shipped `set_host_identity`), the hourly tick
//! (`host_account_check_under`, the shipped `host_account_check`), the reset a change of the
//! world's names makes (`names_changed`), a tick whose request fails, and a joiner's requests
//! across two days of ticks.
//!
//! Every procedure runs inside `Fixture::run_procedure` with its HTTP answers stubbed in order
//! (`HttpQueue`), and each test names the build profile it runs as. A request the stubs did not
//! expect fails the run, so "sends nothing" is an empty request record over an empty queue.

use super::*;
use crate::accounts::{build_profile, BuildFeatures, BuildProfile};
use crate::native_host_tests::{
    fixture, Caller, Fixture, Handle, HttpAnswer, HttpQueue, SentRequest,
};
use crate::schema::{Account, AccountStatus, Config, WorldAllowlist, WorldName};
use spacetimedb::sats::bsatn;
use spacetimedb::{Identity, ScheduleAt, Serialize, TimeDuration, Timestamp};

// =====================================================================================
// Vocabulary: identities, times, names, handles, URLs, profiles.
// =====================================================================================

/// Never `[0; 32]` (the dummy sender) and never the module identity `[0xDB; 32]`.
fn id(b: u8) -> Identity {
    Identity::from_byte_array([b; 32])
}

/// The world owner every world below names in `config`.
fn owner() -> Identity {
    id(0xA1)
}

/// The identity the host plays as: the marked row's.
fn alice() -> Identity {
    id(0x11)
}

fn bob() -> Identity {
    id(0x22)
}

fn carol() -> Identity {
    id(0x33)
}

/// A player who joins the world and stays connected.
fn joiner() -> Identity {
    id(0x44)
}

fn at(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms * 1000)
}

/// The start of a minute.
const T0: i64 = 1_800_000_000_000;
/// The time every single tick below runs at.
const NOW: i64 = T0 + 15_000;
/// One hour, the tick's interval.
const HOUR: i64 = 3_600_000;
/// A day before [`T0`]: the check time of every seeded row.
const LONG_AGO: i64 = T0 - 86_400_000;

const WORLD_NAME: &str = "spki:TEST-fingerprint_00/realm-one";
/// An `ip:` name carrying the IPv4 address 203.0.113.9.
const IP4_NAME: &str = "ip:203.0.113.9:3000";
/// An `ip:` name carrying the IPv6 address 2606:4700:4700::1111.
const IP6_NAME: &str = "ip:[2606:4700:4700::1111]:8443/world-1";

/// The host's account.
const HANDLE_A: &str = "k1.AbCdEf0123456789-_";
/// The host's account under the service's newer key.
const HANDLE_A2: &str = "k2.ZyXwVu9876543210_-";
const HANDLE_B: &str = "k1.BbBbBb0123456789xy";
const HANDLE_C: &str = "k1.CcCcCc0123456789zz";
/// The joiner's account.
const HANDLE_J: &str = "k1.JoInEr0123456789qq";

/// The IPv4 address the service reports by default.
const ADDRESS4: &str = "203.0.113.9";
/// Another IPv4 address.
const OTHER4: &str = "198.51.100.7";
/// An IPv6 address as `std::net::IpAddr` prints it.
const ADDRESS6: &str = "2606:4700:4700::1111";

/// The `test` and `dev-enforcing` builds' service.
const DEV_URL: &str = "https://auth.monster-realm.spookyowltech.com/world/check";
/// The `world` build's service.
const WORLD_URL: &str = "https://auth.monster-realm.invalid/world/check";

/// The refusal a build that names no account service gives.
const CHECKS_NOTHING: &str = "this server checks no account";

/// The database identity the fixture's `ctx.database_identity()` answers, as 64 lower-case hex
/// digits.
fn world_hex() -> String {
    "db".repeat(32)
}

/// The interval every armed row of `host_check_schedule` ticks at: one hour.
fn hourly() -> ScheduleAt {
    ScheduleAt::Interval(TimeDuration::from_micros(3_600_000_000))
}

const NO_FEATURE: BuildFeatures = BuildFeatures {
    official: false,
    world: false,
    dev_issuers: false,
    open_join: false,
    dev_reducers: false,
    load_test_zones: false,
};

/// The `test` build: asks the hosted-dev service.
fn test_profile() -> BuildProfile {
    build_profile(BuildFeatures {
        open_join: true,
        ..NO_FEATURE
    })
}

/// The `dev-enforcing` build: asks the hosted-dev service.
fn dev_enforcing() -> BuildProfile {
    build_profile(BuildFeatures {
        dev_issuers: true,
        ..NO_FEATURE
    })
}

/// The `world` build: asks the production service.
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
// The world: every table the host's check, the marking and a joiner's re-check reach.
// =====================================================================================

struct W<'a> {
    config: Handle<'a, Config, u32>,
    account: Handle<'a, Account>,
    names: Handle<'a, WorldName, String>,
    allow: Handle<'a, WorldAllowlist, String>,
    accounts: Handle<'a, WorldAccount>,
    egress: Handle<'a, WorldEgress, u8>,
    sched: Handle<'a, HostCheckSchedule, u64>,
    rechecks: Handle<'a, RecheckSchedule>,
    budget: Handle<'a, WorldCheckBudget, u32>,
}

/// Registers the tables. `config`, `account`, `world_name` and `world_check_budget` are
/// read-only: a write to one aborts the test. `host_check_schedule` draws its key from a
/// sequence, as `recheck_schedule` does.
fn world(fx: &Fixture) -> W<'_> {
    let _ = fx
        .table_keyed::<WorldAccount, String>("world_account", "handle", |r| r.handle.clone())
        .unique();
    let _ = fx
        .table_keyed::<RecheckSchedule, u64>("recheck_schedule", "scheduled_id", |r| r.scheduled_id)
        .unique();
    W {
        config: fx
            .table_keyed::<Config, u32>("config", "id", |r| r.id)
            .unique(),
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
        egress: fx
            .table_keyed::<WorldEgress, u8>("world_egress", "family", |r| r.family)
            .unique()
            .writable()
            .scannable(),
        sched: fx
            .table_keyed::<HostCheckSchedule, u64>("host_check_schedule", "scheduled_id", |r| {
                r.scheduled_id
            })
            .unique()
            .writable()
            .scannable()
            .auto_inc(|r| r.scheduled_id, |r, v| r.scheduled_id = v),
        rechecks: fx
            .table::<RecheckSchedule>("recheck_schedule", "identity", |r| r.identity)
            .unique()
            .writable()
            .auto_inc(|r| r.scheduled_id, |r, v| r.scheduled_id = v),
        budget: fx
            .table_keyed::<WorldCheckBudget, u32>("world_check_budget", "id", |r| r.id)
            .unique(),
    }
}

/// A world owned by [`owner`] whose names are `names`.
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

/// A world owned by [`owner`], named [`WORLD_NAME`] alone (it asks at the profile's own URL).
fn host_world(fx: &Fixture) -> W<'_> {
    named_world(fx, &[WORLD_NAME])
}

/// [`host_world`] where [`alice`]'s row is marked (not entitled, checked [`LONG_AGO`]), the
/// bystander [`bob`] holds an unmarked entitled row, and `host_check_schedule` holds row 100
/// with `last` as its last success.
fn marked_world(fx: &Fixture, last: Option<i64>) -> W<'_> {
    let w = host_world(fx);
    w.accounts
        .seed(&account_row(alice(), HANDLE_A, false, LONG_AGO, true));
    w.accounts
        .seed(&account_row(bob(), HANDLE_B, true, LONG_AGO, false));
    w.sched.seed(&sched_row(100, last));
    w
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

fn sched_row(scheduled_id: u64, last_success_ms: Option<i64>) -> HostCheckSchedule {
    HostCheckSchedule {
        scheduled_id,
        scheduled_at: hourly(),
        last_success_ms,
    }
}

fn egress_row(family: u8, address: &str, confirmed_at_ms: i64) -> WorldEgress {
    WorldEgress {
        family,
        address: address.to_string(),
        confirmed_at_ms,
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

/// Replaces `who`'s row by `row`, as another transaction would.
fn replace_row(w: &W<'_>, who: Identity, row: &WorldAccount) {
    assert_eq!(w.accounts.remove(who), 1, "fixture: {who:?} holds one row");
    w.accounts.seed(row);
}

// =====================================================================================
// Answers the service gives.
// =====================================================================================

/// The service's answer to a handle, reporting `address`.
fn answer_from(handle: &str, entitled: bool, address: &str) -> String {
    serde_json::json!({ "handle": handle, "entitled": entitled, "address": address }).to_string()
}

/// The service's answer to a handle, reporting [`ADDRESS4`].
fn handle_answer(handle: &str, entitled: bool) -> String {
    answer_from(handle, entitled, ADDRESS4)
}

/// The service's answer to a handle it holds no account under.
fn unknown_handle_answer(entitled: bool) -> String {
    serde_json::json!({ "entitled": entitled, "address": ADDRESS4 }).to_string()
}

fn ok<'q>(body: String) -> HttpAnswer<'q> {
    HttpAnswer::status(200, body)
}

/// A stubbed outcome: a status and body, or the text of a transport error.
type Stubbed = Result<(u16, String), String>;

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
type ScheduleView = (u64, ScheduleAt, Option<i64>);
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

fn row_view(
    who: Identity,
    handle: &str,
    entitled: bool,
    checked_at_ms: i64,
    is_host: bool,
) -> AccountView {
    view(&account_row(who, handle, entitled, checked_at_ms, is_host))
}

fn sorted<T: Ord>(mut v: Vec<T>) -> Vec<T> {
    v.sort();
    v
}

fn strings(xs: &[&str]) -> Vec<String> {
    sorted(xs.iter().map(|x| (*x).to_string()).collect())
}

/// Every `world_account` row, sorted.
fn accounts(w: &W<'_>) -> Vec<AccountView> {
    sorted(w.accounts.rows().iter().map(view).collect())
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

/// Every `host_check_schedule` row, by id.
fn schedule(w: &W<'_>) -> Vec<ScheduleView> {
    let mut rows: Vec<ScheduleView> = w
        .sched
        .rows()
        .into_iter()
        .map(|r| (r.scheduled_id, r.scheduled_at, r.last_success_ms))
        .collect();
    rows.sort_by_key(|r| r.0);
    rows
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

/// `host_check_schedule` holds exactly one row, which ticks hourly, holds `last` and has an
/// id none of `old` holds.
fn assert_one_new_row(w: &W<'_>, old: &[u64], last: Option<i64>) {
    let rows = schedule(w);
    assert_eq!(rows.len(), 1, "host_check_schedule holds one row: {rows:?}");
    let (id, every, stamp) = &rows[0];
    assert_eq!(*every, hourly(), "the row ticks hourly");
    assert_eq!(*stamp, last, "the row's last success");
    assert!(!old.contains(id), "a fresh row, not row {id}");
}

/// The one `host_check_schedule` row, as the host hands it to the procedure it fires.
fn stored_row(w: &W<'_>) -> HostCheckSchedule {
    let mut rows = w.sched.rows();
    assert_eq!(
        rows.len(),
        1,
        "host_check_schedule holds one row: {:?}",
        schedule(w)
    );
    rows.remove(0)
}

fn encs<T: Serialize>(rows: &[T]) -> Vec<Vec<u8>> {
    sorted(
        rows.iter()
            .map(|r| bsatn::to_vec(r).expect("a row always BSATN-encodes"))
            .collect(),
    )
}

/// Every stored row of the tables a tick or a marking may write, with each table's write count.
fn footprint(fx: &Fixture, w: &W<'_>) -> Footprint {
    vec![
        (
            "world_account",
            encs(&w.accounts.rows()),
            fx.writes_to("world_account"),
        ),
        (
            "world_egress",
            encs(&w.egress.rows()),
            fx.writes_to("world_egress"),
        ),
        (
            "host_check_schedule",
            encs(&w.sched.rows()),
            fx.writes_to("host_check_schedule"),
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
            "world_check_budget",
            encs(&w.budget.rows()),
            fx.writes_to("world_check_budget"),
        ),
    ]
}

/// Every registered table.
const READ_TABLES: [&str; 9] = [
    "config",
    "account",
    "world_name",
    "world_allowlist",
    "world_account",
    "world_egress",
    "host_check_schedule",
    "recheck_schedule",
    "world_check_budget",
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

/// The handle a request asks about.
fn handle_of(req: &SentRequest) -> String {
    body_of(req)["handle"]
        .as_str()
        .expect("`handle` is a string")
        .to_string()
}

/// `req` asks about `handle`: `POST` to `url` with the 3 s timeout and exactly
/// `{"handle", "world"}`, `world` the database identity's hex.
fn assert_handle_request(req: &SentRequest, url: &str, handle: &str) {
    assert_eq!(req.method, "POST", "a check is a POST");
    assert_eq!(req.url, url, "the URL a check goes to");
    assert_eq!(
        req.timeout,
        Some(TimeDuration::from_micros(3_000_000)),
        "a check waits 3 s at most"
    );
    let body = body_of(req);
    let keys: Vec<String> = body.keys().cloned().collect();
    assert_eq!(sorted(keys), strings(&["handle", "world"]));
    assert_eq!(body["handle"], handle);
    assert_eq!(body["world"], world_hex());
}

// =====================================================================================
// Calls.
// =====================================================================================

/// `mark_host(who)` under `profile` at the single tick time.
fn mark_as(fx: &Fixture, profile: &BuildProfile, who: Identity) -> Result<(), String> {
    fx.run_as_at(owner(), at(NOW), |ctx| mark_host(ctx, profile, who))
}

/// `caller` calls the shipped `set_host_identity(who)` at the single tick time.
fn set_host_as(fx: &Fixture, caller: Identity, who: Identity) -> Result<(), String> {
    fx.run_as_at(caller, at(NOW), |ctx| set_host_identity(ctx, who))
}

/// `caller` runs `host_account_check(row)` under `profile` at `ms`.
fn tick(
    fx: &Fixture,
    caller: Caller,
    ms: i64,
    http: &mut HttpQueue<'_>,
    profile: &BuildProfile,
    row: HostCheckSchedule,
) -> Result<(), String> {
    fx.run_procedure(caller, at(ms), http, |ctx| {
        host_account_check_under(ctx, profile, row)
    })
}

/// The stored schedule row fires at `ms` on the `test` build, run as the database, with
/// `answer` stubbed (none: a request fails the run).
fn fire(
    fx: &Fixture,
    w: &W<'_>,
    ms: i64,
    answer: Option<HttpAnswer<'_>>,
) -> (Result<(), String>, Vec<SentRequest>) {
    let row = stored_row(w);
    let mut http = HttpQueue::new();
    if let Some(answer) = answer {
        http.push(answer);
    }
    let got = tick(fx, Caller::Database, ms, &mut http, &test_profile(), row);
    (got, http.requests().to_vec())
}

// =====================================================================================
// The owner marks the host's identity.
// =====================================================================================

mod marking {
    use super::*;

    /// The marking sets `who`'s mark and clears it on every other marked row, every other
    /// column kept.
    ///
    /// kills: the inert marking; only one other mark cleared; another column rewritten.
    #[test]
    fn marking_sets_whos_mark_and_clears_every_other_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, false));
        w.accounts
            .seed(&account_row(bob(), HANDLE_B, false, LONG_AGO + 1, true));
        w.accounts
            .seed(&account_row(carol(), HANDLE_C, true, LONG_AGO + 2, true));
        assert_eq!(mark_as(&fx, &test_profile(), alice()), Ok(()));
        assert_eq!(
            accounts(&w),
            sorted(vec![
                row_view(alice(), HANDLE_A, true, LONG_AGO, true),
                row_view(bob(), HANDLE_B, false, LONG_AGO + 1, false),
                row_view(carol(), HANDLE_C, true, LONG_AGO + 2, false),
            ])
        );
    }

    /// Only the rows whose mark changes are written: `who`'s and the one marked bystander's,
    /// never the unmarked bystanders'.
    ///
    /// kills: every row rewritten; `who`'s row not written.
    #[test]
    fn a_row_whose_mark_does_not_change_is_not_written_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, false));
        w.accounts
            .seed(&account_row(bob(), HANDLE_B, true, LONG_AGO, true));
        w.accounts
            .seed(&account_row(carol(), HANDLE_C, true, LONG_AGO, false));
        w.accounts
            .seed(&account_row(joiner(), HANDLE_J, false, LONG_AGO, false));
        fx.reset_writes();
        assert_eq!(mark_as(&fx, &test_profile(), alice()), Ok(()));
        assert_eq!(fx.writes_to("world_account"), 2, "alice's row and bob's");
    }

    /// With no schedule row the marking arms one: hourly, no success yet.
    ///
    /// kills: the marking arming nothing; a row stamped at arming; another interval.
    #[test]
    fn marking_with_no_schedule_row_arms_one_unstamped_hourly_row_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, false));
        assert_eq!(mark_as(&fx, &test_profile(), alice()), Ok(()));
        assert_one_new_row(&w, &[], None);
    }

    /// The mark moving to another identity replaces a stamped schedule row by one unstamped
    /// row: one row in total, under a new id.
    ///
    /// kills: the stamp kept across a change of host; a second row added; the row updated in
    /// place.
    #[test]
    fn a_mark_that_moves_replaces_the_stamped_row_with_an_unstamped_one_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, false));
        w.accounts
            .seed(&account_row(bob(), HANDLE_B, true, LONG_AGO, true));
        w.sched.seed(&sched_row(100, Some(NOW - HOUR)));
        assert_eq!(mark_as(&fx, &test_profile(), alice()), Ok(()));
        assert_one_new_row(&w, &[100], None);
    }

    /// Marking the already marked row over exactly one schedule row writes no schedule row and
    /// keeps its stamp, while the call still clears a bystander's mark.
    ///
    /// kills: the stamp reset by a marking that changes no host; a schedule write on every
    /// marking.
    #[test]
    fn remarking_the_marked_row_keeps_a_lone_schedule_row_and_its_stamp_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, true));
        w.accounts
            .seed(&account_row(bob(), HANDLE_B, true, LONG_AGO, true));
        w.sched.seed(&sched_row(100, Some(NOW - 1_000)));
        let before = encs(&w.sched.rows());
        fx.reset_writes();
        assert_eq!(mark_as(&fx, &test_profile(), alice()), Ok(()));
        assert_eq!(
            accounts(&w),
            sorted(vec![
                row_view(alice(), HANDLE_A, true, LONG_AGO, true),
                row_view(bob(), HANDLE_B, true, LONG_AGO, false),
            ]),
            "bob's mark is cleared"
        );
        assert_eq!(encs(&w.sched.rows()), before, "the stamped row stays");
        assert_eq!(fx.writes_to("host_check_schedule"), 0, "no schedule write");
    }

    /// Marking the already marked row over two schedule rows leaves one unstamped row.
    ///
    /// kills: "already marked" judged alone; one of two rows deleted.
    #[test]
    fn remarking_the_marked_row_over_two_schedule_rows_leaves_one_unstamped_row_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, true));
        w.sched.seed(&sched_row(100, Some(NOW - 1_000)));
        w.sched.seed(&sched_row(101, Some(NOW - 2_000)));
        assert_eq!(mark_as(&fx, &test_profile(), alice()), Ok(()));
        assert_one_new_row(&w, &[100, 101], None);
    }

    /// An identity that holds no `world_account` row is refused and nothing is written.
    ///
    /// kills: a row inserted for it; the marks cleared before the refusal; a row armed.
    #[test]
    fn an_identity_with_no_account_row_is_refused_and_nothing_is_written_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(bob(), HANDLE_B, true, LONG_AGO, true));
        w.sched.seed(&sched_row(100, Some(NOW - HOUR)));
        fx.reset_writes();
        let before = footprint(&fx, &w);
        assert_eq!(
            mark_as(&fx, &test_profile(), alice()),
            Err("that identity holds no account here".to_string())
        );
        assert_eq!(footprint(&fx, &w), before, "nothing changes");
    }

    /// Each build that names no account service refuses the marking before reading a table.
    ///
    /// kills: a marking on a build that checks nobody; the refusal after a read.
    #[test]
    fn a_build_that_names_no_service_refuses_the_mark_and_reads_nothing_lpw43_1() {
        for profile in checkless_profiles() {
            let fx = fixture();
            let w = host_world(&fx);
            w.accounts
                .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, false));
            fx.reset_writes();
            fx.reset_reads();
            let before = footprint(&fx, &w);
            assert_eq!(
                mark_as(&fx, &profile, alice()),
                Err(CHECKS_NOTHING.to_string()),
                "{}",
                profile.name
            );
            assert_nothing_read(&fx, profile.name);
            assert_eq!(
                footprint(&fx, &w),
                before,
                "{}: nothing changes",
                profile.name
            );
        }
    }

    /// The owner's call on this build: a build that names a service marks `who`; one that
    /// names none refuses with the build's reason, past both gates.
    fn assert_owner_call_passes_the_gates(fx: &Fixture, w: &W<'_>, who: Identity) {
        let got = set_host_as(fx, owner(), who);
        if BUILD_PROFILE.world_check_url.is_some() {
            assert_eq!(got, Ok(()), "the owner's call");
            assert!(
                accounts(w)
                    .iter()
                    .any(|r| r.1 == who.to_byte_array() && r.4),
                "the owner's call marks: {:?}",
                accounts(w)
            );
        } else {
            assert_eq!(got, Err(CHECKS_NOTHING.to_string()), "the owner's call");
        }
    }

    /// A caller that is not the world's owner is refused and nothing is written; the owner's
    /// same call passes.
    ///
    /// kills: the shipped reducer with no owner check; the owner refused too.
    #[test]
    fn the_shipped_reducer_refuses_a_caller_that_is_not_the_owner_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, false));
        fx.reset_writes();
        let before = footprint(&fx, &w);
        assert_eq!(
            set_host_as(&fx, carol(), alice()),
            Err(crate::access::REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(footprint(&fx, &w), before, "nothing changes");
        assert_owner_call_passes_the_gates(&fx, &w, alice());
    }

    /// A stranger naming an identity pending deletion is told it is not the owner: the owner
    /// check comes first.
    ///
    /// kills: the deletion gate judged before the owner check.
    #[test]
    fn the_shipped_reducer_refuses_a_stranger_before_the_deletion_gate_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, false));
        w.account.seed(&deleting_account(alice()));
        assert_eq!(
            set_host_as(&fx, carol(), alice()),
            Err(crate::access::REJECT_NOT_WORLD_OWNER.to_string())
        );
    }

    /// The owner naming an identity pending deletion is refused by the deletion gate and
    /// nothing is written; with the deletion gone the same call passes.
    ///
    /// kills: the shipped reducer with no deletion gate; the gate pointed at the caller.
    #[test]
    fn the_shipped_reducer_refuses_an_identity_pending_deletion_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, false));
        w.account.seed(&deleting_account(alice()));
        fx.reset_writes();
        let before = footprint(&fx, &w);
        assert_eq!(
            set_host_as(&fx, owner(), alice()),
            Err(crate::guards::REJECT_DELETION_GATED.to_string())
        );
        assert_eq!(footprint(&fx, &w), before, "nothing changes");
        assert_eq!(w.account.remove(alice()), 1, "fixture: the deletion goes");
        assert_owner_call_passes_the_gates(&fx, &w, alice());
    }

    /// The shipped reducer, called by the owner, marks `who` and arms the hourly row under the
    /// build's own profile.
    ///
    /// kills: `set_host_identity` not wired to `mark_host`.
    #[cfg(all(
        feature = "open_join",
        not(feature = "official"),
        not(feature = "world")
    ))]
    #[test]
    fn the_shipped_reducer_marks_and_arms_under_the_builds_own_profile_lpw43_1() {
        let fx = fixture();
        let w = host_world(&fx);
        w.accounts
            .seed(&account_row(alice(), HANDLE_A, true, LONG_AGO, false));
        w.accounts
            .seed(&account_row(bob(), HANDLE_B, true, LONG_AGO, true));
        assert_eq!(set_host_as(&fx, owner(), alice()), Ok(()));
        assert_eq!(
            accounts(&w),
            sorted(vec![
                row_view(alice(), HANDLE_A, true, LONG_AGO, true),
                row_view(bob(), HANDLE_B, true, LONG_AGO, false),
            ])
        );
        assert_one_new_row(&w, &[], None);
    }
}

// =====================================================================================
// The hourly tick.
// =====================================================================================

mod ticking {
    use super::*;

    /// The tick is due with no success yet, at 23 h after the last success or more, and when
    /// the stamp lies ahead of the clock; not 1 ms short of 23 h.
    ///
    /// kills: `>` for `>=`; 24 h; a clock set back read as fresh.
    #[test]
    fn the_host_check_falls_due_at_23_hours_or_when_the_clock_steps_back_lpw43_2() {
        let cases: [(&str, Option<i64>, bool); 6] = [
            ("no success yet", None, true),
            ("exactly 23 h", Some(NOW - 82_800_000), true),
            ("23 h less 1 ms", Some(NOW - 82_799_999), false),
            ("stamped at this instant", Some(NOW), false),
            ("stamped 1 ms ahead", Some(NOW + 1), true),
            ("25 h", Some(NOW - 90_000_000), true),
        ];
        for (label, last, due) in cases {
            assert_eq!(host_check_due(last, NOW), due, "{label}");
        }
    }

    /// A due tick sends one handle check about the marked row's handle to the profile's
    /// service, on each build that names one.
    ///
    /// kills: the inert tick; a ticket-shaped body; another URL; no timeout.
    #[test]
    fn a_due_tick_posts_one_handle_check_about_the_marked_handle_lpw43_2() {
        for (profile, url) in [
            (test_profile(), DEV_URL),
            (dev_enforcing(), DEV_URL),
            (world_profile(), WORLD_URL),
        ] {
            let fx = fixture();
            let w = marked_world(&fx, None);
            let mut http = HttpQueue::new();
            http.push(ok(handle_answer(HANDLE_A, true)));
            let got = tick(
                &fx,
                Caller::Database,
                NOW,
                &mut http,
                &profile,
                stored_row(&w),
            );
            assert_eq!(got, Ok(()), "{}", profile.name);
            assert_eq!(http.requests().len(), 1, "{}: one request", profile.name);
            assert_handle_request(&http.requests()[0], url, HANDLE_A);
        }
    }

    /// With other rows present, entitled or not and checked before or after the marked one,
    /// the tick names the marked handle alone.
    ///
    /// kills: the first row asked about; every row asked about; the oldest row asked about.
    #[test]
    fn a_due_tick_names_no_handle_but_the_marked_one_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        w.accounts
            .seed(&account_row(carol(), HANDLE_C, false, NOW - 1_000, false));
        w.accounts.seed(&account_row(
            joiner(),
            HANDLE_J,
            true,
            LONG_AGO - HOUR,
            false,
        ));
        let (got, sent) = fire(&fx, &w, NOW, Some(ok(handle_answer(HANDLE_A, true))));
        assert_eq!(got, Ok(()));
        let handles: Vec<String> = sent.iter().map(handle_of).collect();
        assert_eq!(handles, vec![HANDLE_A.to_string()]);
    }

    /// The answer's status lands on the marked row: `entitled` and the tick's time, every
    /// other column kept, the bystander untouched; for a positive and a negative answer.
    ///
    /// kills: the answer not stored; the time not stored; the mark cleared; the bystander
    /// written.
    #[test]
    fn the_answered_status_is_stored_on_the_marked_row_alone_lpw43_2() {
        for (stored, answered) in [(false, true), (true, false)] {
            let fx = fixture();
            let w = marked_world(&fx, None);
            replace_row(
                &w,
                alice(),
                &account_row(alice(), HANDLE_A, stored, LONG_AGO, true),
            );
            let (got, _) = fire(&fx, &w, NOW, Some(ok(handle_answer(HANDLE_A, answered))));
            assert_eq!(got, Ok(()), "answered {answered}");
            assert_eq!(
                accounts(&w),
                sorted(vec![
                    row_view(alice(), HANDLE_A, answered, NOW, true),
                    row_view(bob(), HANDLE_B, true, LONG_AGO, false),
                ]),
                "answered {answered}"
            );
        }
    }

    /// An answer under a newer handle replaces the marked row's handle and its entry on the
    /// host's list; the mark and the other entry stay.
    ///
    /// kills: the newer handle ignored; the list entry left stale; the mark lost on the move.
    #[test]
    fn an_answer_under_a_newer_handle_replaces_the_handle_and_its_list_entry_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        for handle in [HANDLE_A, HANDLE_B] {
            w.allow.seed(&WorldAllowlist {
                account_subject: handle.to_string(),
            });
        }
        let (got, _) = fire(&fx, &w, NOW, Some(ok(handle_answer(HANDLE_A2, true))));
        assert_eq!(got, Ok(()));
        assert_eq!(
            accounts(&w),
            sorted(vec![
                row_view(alice(), HANDLE_A2, true, NOW, true),
                row_view(bob(), HANDLE_B, true, LONG_AGO, false),
            ])
        );
        assert_eq!(listed(&w), strings(&[HANDLE_A2, HANDLE_B]));
    }

    /// An answer that names no handle stores the marked row as not entitled, whatever its
    /// `entitled` says.
    ///
    /// kills: an answer with no handle believed.
    #[test]
    fn an_answer_naming_no_handle_stores_not_entitled_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        replace_row(
            &w,
            alice(),
            &account_row(alice(), HANDLE_A, true, LONG_AGO, true),
        );
        let (got, _) = fire(&fx, &w, NOW, Some(ok(unknown_handle_answer(true))));
        assert_eq!(got, Ok(()));
        assert!(
            accounts(&w).contains(&row_view(alice(), HANDLE_A, false, NOW, true)),
            "{:?}",
            accounts(&w)
        );
    }

    /// A success replaces the fired row by one hourly row stamped with the tick's time, from
    /// no success and from a success 23 h old.
    ///
    /// kills: no stamp; the row updated in place; a second row inserted beside it.
    #[test]
    fn a_success_replaces_the_fired_row_with_one_stamped_hourly_row_lpw43_2() {
        for last in [None, Some(NOW - 82_800_000)] {
            let fx = fixture();
            let w = marked_world(&fx, last);
            let (got, _) = fire(&fx, &w, NOW, Some(ok(handle_answer(HANDLE_A, true))));
            assert_eq!(got, Ok(()), "{last:?}");
            assert_one_new_row(&w, &[100], Some(NOW));
        }
    }

    /// A tick 1 ms short of 23 h after the last success sends nothing and writes nothing; the
    /// tick 1 ms later asks.
    ///
    /// kills: a tick that asks every hour.
    #[test]
    fn a_tick_under_23_hours_after_the_last_success_sends_nothing_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, Some(NOW - 82_799_999));
        fx.reset_writes();
        let before = footprint(&fx, &w);
        let (got, sent) = fire(&fx, &w, NOW, None);
        assert_eq!(got, Ok(()));
        assert!(sent.is_empty(), "no request: {sent:?}");
        assert_eq!(footprint(&fx, &w), before, "nothing changes");
        let (got, sent) = fire(&fx, &w, NOW + 1, Some(ok(handle_answer(HANDLE_A, true))));
        assert_eq!(got, Ok(()));
        assert_eq!(sent.len(), 1, "exactly 23 h asks");
    }

    /// With no marked row the tick sends nothing and writes nothing; once a row is marked the
    /// same tick asks.
    ///
    /// kills: some other row asked about when none is marked; a request with an empty handle.
    #[test]
    fn a_tick_with_no_marked_row_sends_nothing_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        replace_row(
            &w,
            alice(),
            &account_row(alice(), HANDLE_A, false, LONG_AGO, false),
        );
        fx.reset_writes();
        let before = footprint(&fx, &w);
        let (got, sent) = fire(&fx, &w, NOW, None);
        assert_eq!(got, Ok(()));
        assert!(sent.is_empty(), "no request: {sent:?}");
        assert_eq!(footprint(&fx, &w), before, "nothing changes");
        replace_row(
            &w,
            alice(),
            &account_row(alice(), HANDLE_A, false, LONG_AGO, true),
        );
        let (got, sent) = fire(&fx, &w, NOW, Some(ok(handle_answer(HANDLE_A, true))));
        assert_eq!(got, Ok(()));
        assert_eq!(sent.len(), 1, "a marked row is asked about");
    }

    /// A tick whose row `host_check_schedule` does not hold sends nothing and writes nothing;
    /// the stored row asks.
    ///
    /// kills: the fired row's own stamp trusted over the table; a stale tick stamping.
    #[test]
    fn a_tick_whose_row_is_gone_sends_nothing_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        fx.reset_writes();
        let before = footprint(&fx, &w);
        let mut http = HttpQueue::new();
        let got = tick(
            &fx,
            Caller::Database,
            NOW,
            &mut http,
            &test_profile(),
            sched_row(7, None),
        );
        assert_eq!(got, Ok(()));
        assert!(
            http.requests().is_empty(),
            "no request: {:?}",
            http.requests()
        );
        assert_eq!(footprint(&fx, &w), before, "nothing changes");
        let (got, sent) = fire(&fx, &w, NOW, Some(ok(handle_answer(HANDLE_A, true))));
        assert_eq!(got, Ok(()));
        assert_eq!(sent.len(), 1, "the stored row asks");
    }

    /// A caller that is not the database is refused before any read, with no request and no
    /// write, on a world where the database's tick asks.
    ///
    /// kills: the tick open to any caller; the caller judged after a read.
    #[test]
    fn a_caller_that_is_not_the_database_is_refused_before_any_read_lpw43_2() {
        for caller in [owner(), alice()] {
            let fx = fixture();
            let w = marked_world(&fx, None);
            fx.reset_writes();
            fx.reset_reads();
            let before = footprint(&fx, &w);
            let mut http = HttpQueue::new();
            let got = tick(
                &fx,
                Caller::Sender(caller),
                NOW,
                &mut http,
                &test_profile(),
                stored_row(&w),
            );
            assert_eq!(got, Err("only the database runs this check".to_string()));
            assert!(http.requests().is_empty(), "no request");
            assert_nothing_read(&fx, "a client caller");
            assert_eq!(footprint(&fx, &w), before, "nothing changes");
        }
    }

    /// Each build that names no account service refuses the tick first, the database's own
    /// included, before any read and with no request.
    ///
    /// kills: a tick on a build that checks nobody; the caller judged before the build.
    #[test]
    fn a_build_that_names_no_service_refuses_the_tick_first_lpw43_2() {
        for profile in checkless_profiles() {
            for caller in [Caller::Database, Caller::Sender(owner())] {
                let fx = fixture();
                let w = marked_world(&fx, None);
                fx.reset_writes();
                fx.reset_reads();
                let before = footprint(&fx, &w);
                let mut http = HttpQueue::new();
                let got = tick(&fx, caller, NOW, &mut http, &profile, stored_row(&w));
                let label = format!("{} as {caller:?}", profile.name);
                assert_eq!(got, Err(CHECKS_NOTHING.to_string()), "{label}");
                assert!(http.requests().is_empty(), "{label}: no request");
                assert_nothing_read(&fx, &label);
                assert_eq!(footprint(&fx, &w), before, "{label}: nothing changes");
            }
        }
    }

    /// The tick asks at the service's check name for the family the world's `ip:` names use:
    /// `ipv4.` when one carries an IPv4 address, else `ipv6.` when one carries an IPv6
    /// address, else the profile's own URL.
    ///
    /// kills: the profile's URL on every world; IPv6 preferred over IPv4; an `ip:` name with
    /// no address counted.
    #[test]
    fn the_tick_asks_over_the_family_its_ip_names_use_lpw43_2() {
        let cases: Vec<(&str, BuildProfile, Vec<&str>, &str)> = vec![
            (
                "an IPv4 ip: name",
                test_profile(),
                vec![WORLD_NAME, IP4_NAME],
                "https://ipv4.auth.monster-realm.spookyowltech.com/world/check",
            ),
            (
                "an IPv6 ip: name",
                test_profile(),
                vec![WORLD_NAME, IP6_NAME],
                "https://ipv6.auth.monster-realm.spookyowltech.com/world/check",
            ),
            (
                "ip: names of both families",
                test_profile(),
                vec![IP6_NAME, IP4_NAME],
                "https://ipv4.auth.monster-realm.spookyowltech.com/world/check",
            ),
            (
                "an ip: name carrying no address",
                test_profile(),
                vec![WORLD_NAME, "ip:example.com:1"],
                DEV_URL,
            ),
            ("no ip: name", test_profile(), vec![WORLD_NAME], DEV_URL),
            (
                "an IPv4 ip: name on the world build",
                world_profile(),
                vec![WORLD_NAME, IP4_NAME],
                "https://ipv4.auth.monster-realm.invalid/world/check",
            ),
        ];
        for (label, profile, names, url) in cases {
            let fx = fixture();
            let w = named_world(&fx, &names);
            w.accounts
                .seed(&account_row(alice(), HANDLE_A, false, LONG_AGO, true));
            w.sched.seed(&sched_row(100, None));
            let mut http = HttpQueue::new();
            http.push(ok(handle_answer(HANDLE_A, true)));
            let got = tick(
                &fx,
                Caller::Database,
                NOW,
                &mut http,
                &profile,
                stored_row(&w),
            );
            assert_eq!(got, Ok(()), "{label}");
            assert_eq!(http.requests().len(), 1, "{label}: one request");
            assert_eq!(http.requests()[0].url, url, "{label}");
        }
    }

    /// The answer's IPv4 address is stored for family 4 at the tick's time, replacing that
    /// family's row; the IPv6 row is untouched.
    ///
    /// kills: the address dropped; a second family-4 row; the other family overwritten.
    #[test]
    fn the_answers_address_is_stored_for_its_family_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        w.egress.seed(&egress_row(4, OTHER4, LONG_AGO));
        w.egress.seed(&egress_row(6, ADDRESS6, LONG_AGO));
        let (got, _) = fire(&fx, &w, NOW, Some(ok(handle_answer(HANDLE_A, true))));
        assert_eq!(got, Ok(()));
        assert_eq!(
            egress(&w),
            vec![
                (4, ADDRESS4.to_string(), NOW),
                (6, ADDRESS6.to_string(), LONG_AGO),
            ]
        );
    }

    /// An IPv6 address spelled in full is stored for family 6 in the one spelling
    /// `std::net::IpAddr` prints.
    ///
    /// kills: the answer's own text stored; IPv6 filed as family 4.
    #[test]
    fn an_ipv6_address_is_stored_as_std_prints_it_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        let answer = answer_from(HANDLE_A, true, "2606:4700:4700:0000:0000:0000:0000:1111");
        let (got, _) = fire(&fx, &w, NOW, Some(ok(answer)));
        assert_eq!(got, Ok(()));
        assert_eq!(egress(&w), vec![(6, ADDRESS6.to_string(), NOW)]);
    }

    /// An IPv4-mapped IPv6 address counts as the IPv4 address it carries.
    ///
    /// kills: a mapped address filed as family 6.
    #[test]
    fn an_ipv4_mapped_address_is_stored_as_ipv4_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        let answer = answer_from(HANDLE_A, true, "::ffff:203.0.113.9");
        let (got, _) = fire(&fx, &w, NOW, Some(ok(answer)));
        assert_eq!(got, Ok(()));
        assert_eq!(egress(&w), vec![(4, ADDRESS4.to_string(), NOW)]);
    }

    /// An answer whose `address` is absent, `null` or a string that is no address stores no
    /// address, and its status is stored as usual.
    ///
    /// kills: a non-address stored; such an answer refused as unanswered.
    #[test]
    fn an_answer_with_no_usable_address_stores_the_status_and_no_address_lpw43_2() {
        let bodies: Vec<(&str, String)> = vec![
            (
                "no address",
                serde_json::json!({ "handle": HANDLE_A, "entitled": true }).to_string(),
            ),
            (
                "a null address",
                serde_json::json!({ "handle": HANDLE_A, "entitled": true, "address": null })
                    .to_string(),
            ),
            ("a word", answer_from(HANDLE_A, true, "not-an-address")),
            (
                "an address with a port",
                answer_from(HANDLE_A, true, "203.0.113.9:3000"),
            ),
            (
                "a bracketed address",
                answer_from(HANDLE_A, true, "[2606:4700:4700::1111]"),
            ),
        ];
        for (label, body) in bodies {
            let fx = fixture();
            let w = marked_world(&fx, None);
            let (got, _) = fire(&fx, &w, NOW, Some(ok(body)));
            assert_eq!(got, Ok(()), "{label}");
            assert!(
                accounts(&w).contains(&row_view(alice(), HANDLE_A, true, NOW, true)),
                "{label}: the status is stored: {:?}",
                accounts(&w)
            );
            assert_eq!(egress(&w), Vec::<(u8, String, i64)>::new(), "{label}");
        }
    }

    /// The shipped procedure runs under the build's own profile: on the `test` build it asks
    /// the hosted-dev service and stores the answer.
    ///
    /// kills: `host_account_check` not wired to `host_account_check_under`.
    #[cfg(all(
        feature = "open_join",
        not(feature = "official"),
        not(feature = "world")
    ))]
    #[test]
    fn the_shipped_procedure_checks_under_the_builds_own_profile_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        let row = stored_row(&w);
        let mut http = HttpQueue::new();
        http.push(ok(handle_answer(HANDLE_A, true)));
        let got = fx.run_procedure(Caller::Database, at(NOW), &mut http, |ctx| {
            host_account_check(ctx, row)
        });
        assert_eq!(got, Ok(()));
        assert_eq!(http.requests().len(), 1);
        assert_handle_request(&http.requests()[0], DEV_URL, HANDLE_A);
        assert!(accounts(&w).contains(&row_view(alice(), HANDLE_A, true, NOW, true)));
    }
}

// =====================================================================================
// A change of the world's names.
// =====================================================================================

mod names {
    use super::*;

    /// After a names change the next tick asks although the last success is an hour old.
    ///
    /// kills: `names_changed` inert; the stamp kept across a names change.
    #[test]
    fn a_names_change_makes_the_next_tick_ask_inside_23_hours_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, Some(NOW - HOUR));
        fx.run_as_at(owner(), at(NOW - 1_000), names_changed);
        let (got, sent) = fire(&fx, &w, NOW, Some(ok(handle_answer(HANDLE_A, true))));
        assert_eq!(got, Ok(()));
        assert_eq!(sent.len(), 1, "the tick asks");
        assert_handle_request(&sent[0], DEV_URL, HANDLE_A);
    }

    /// A names change with no schedule row writes nothing and arms nothing; over one stamped
    /// row it leaves one unstamped row.
    ///
    /// kills: a names change arming a check no host asked for.
    #[test]
    fn a_names_change_with_no_schedule_row_writes_nothing_lpw43_2() {
        let fx = fixture();
        let w = host_world(&fx);
        fx.reset_writes();
        fx.run_as_at(owner(), at(NOW), names_changed);
        assert!(schedule(&w).is_empty(), "no row armed");
        assert_eq!(fx.writes_to("host_check_schedule"), 0, "no write");
        w.sched.seed(&sched_row(100, Some(NOW - 1_000)));
        fx.run_as_at(owner(), at(NOW), names_changed);
        assert_one_new_row(&w, &[100], None);
    }

    /// A names change over one unstamped row writes nothing; over one stamped row it replaces
    /// it.
    ///
    /// kills: a write on every names change.
    #[test]
    fn a_names_change_keeps_a_lone_unstamped_row_lpw43_2() {
        let fx = fixture();
        let w = host_world(&fx);
        w.sched.seed(&sched_row(100, None));
        let before = encs(&w.sched.rows());
        fx.reset_writes();
        fx.run_as_at(owner(), at(NOW), names_changed);
        assert_eq!(encs(&w.sched.rows()), before, "the row stays");
        assert_eq!(fx.writes_to("host_check_schedule"), 0, "no write");
        assert_eq!(w.sched.remove(100), 1, "fixture");
        w.sched.seed(&sched_row(100, Some(NOW - 1_000)));
        fx.run_as_at(owner(), at(NOW), names_changed);
        assert_one_new_row(&w, &[100], None);
    }

    /// A names change over two rows leaves one unstamped row in total.
    ///
    /// kills: only the stamped rows replaced; a third row added.
    #[test]
    fn a_names_change_over_two_rows_leaves_one_unstamped_row_lpw43_2() {
        let fx = fixture();
        let w = host_world(&fx);
        w.sched.seed(&sched_row(100, None));
        w.sched.seed(&sched_row(101, Some(NOW - 1_000)));
        fx.run_as_at(owner(), at(NOW), names_changed);
        assert_one_new_row(&w, &[100, 101], None);
    }
}

// =====================================================================================
// A change made while the tick's request waits.
// =====================================================================================

mod during_the_wait {
    use super::*;

    /// A names change during the wait: the status is stored, the tick writes no schedule row
    /// (one unstamped row stands), and the next tick asks again.
    ///
    /// kills: the stamp judged on the first transaction's read, overwriting the reset.
    #[test]
    fn a_names_change_during_the_wait_leaves_the_tick_unstamped_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, Some(NOW - 82_800_000));
        let answer = ok(handle_answer(HANDLE_A, true)).while_waiting(|| {
            names_changed(&fx.ctx_at(at(NOW)));
        });
        let (got, _) = fire(&fx, &w, NOW, Some(answer));
        assert_eq!(got, Ok(()));
        assert!(
            accounts(&w).contains(&row_view(alice(), HANDLE_A, true, NOW, true)),
            "the status is stored: {:?}",
            accounts(&w)
        );
        assert_one_new_row(&w, &[100], None);
        let (got, sent) = fire(&fx, &w, NOW + HOUR, Some(ok(handle_answer(HANDLE_A, true))));
        assert_eq!(got, Ok(()));
        assert_eq!(sent.len(), 1, "the next tick asks");
    }

    /// The mark moves to another identity during the wait: no stamp, one unstamped row.
    ///
    /// kills: the stamp given for a row whose mark left it during the wait.
    #[test]
    fn a_mark_moved_during_the_wait_leaves_one_unstamped_row_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        let answer = ok(handle_answer(HANDLE_A, true)).while_waiting(|| {
            assert_eq!(
                mark_host(&fx.ctx_at(at(NOW)), &test_profile(), bob()),
                Ok(()),
                "the wait marks bob"
            );
        });
        let (got, _) = fire(&fx, &w, NOW, Some(answer));
        assert_eq!(got, Ok(()));
        assert_one_new_row(&w, &[100], None);
        assert_eq!(
            accounts(&w),
            sorted(vec![
                row_view(alice(), HANDLE_A, true, NOW, false),
                row_view(bob(), HANDLE_B, true, LONG_AGO, true),
            ])
        );
    }

    /// The mark leaves the asked row during the wait while the fired row stays: the status is
    /// stored and the schedule row is not written.
    ///
    /// kills: the "still marked" condition of the stamp left out.
    #[test]
    fn a_mark_cleared_during_the_wait_stores_the_status_and_stamps_nothing_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        let before = encs(&w.sched.rows());
        let answer = ok(handle_answer(HANDLE_A, true)).while_waiting(|| {
            replace_row(
                &w,
                alice(),
                &account_row(alice(), HANDLE_A, false, LONG_AGO, false),
            );
            replace_row(
                &w,
                bob(),
                &account_row(bob(), HANDLE_B, true, LONG_AGO, true),
            );
        });
        fx.reset_writes();
        let (got, _) = fire(&fx, &w, NOW, Some(answer));
        assert_eq!(got, Ok(()));
        assert_eq!(
            accounts(&w),
            sorted(vec![
                row_view(alice(), HANDLE_A, true, NOW, false),
                row_view(bob(), HANDLE_B, true, LONG_AGO, true),
            ])
        );
        assert_eq!(
            encs(&w.sched.rows()),
            before,
            "the fired row stays unstamped"
        );
        assert_eq!(fx.writes_to("host_check_schedule"), 0, "no schedule write");
    }

    /// The marked row is checked again during the wait: its status is left alone and nothing
    /// is stamped, while the answer's address is stored.
    ///
    /// kills: an older answer over a newer check; the stamp given for a row checked again.
    #[test]
    fn a_row_checked_again_during_the_wait_keeps_its_status_and_stamps_nothing_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        let before = encs(&w.sched.rows());
        let answer = ok(handle_answer(HANDLE_A, true)).while_waiting(|| {
            replace_row(
                &w,
                alice(),
                &account_row(alice(), HANDLE_A, false, NOW - 1, true),
            );
        });
        fx.reset_writes();
        let (got, _) = fire(&fx, &w, NOW, Some(answer));
        assert_eq!(got, Ok(()));
        assert_eq!(
            accounts(&w),
            sorted(vec![
                row_view(alice(), HANDLE_A, false, NOW - 1, true),
                row_view(bob(), HANDLE_B, true, LONG_AGO, false),
            ])
        );
        assert_eq!(
            encs(&w.sched.rows()),
            before,
            "the fired row stays unstamped"
        );
        assert_eq!(fx.writes_to("host_check_schedule"), 0, "no schedule write");
        assert_eq!(egress(&w), vec![(4, ADDRESS4.to_string(), NOW)]);
    }

    /// The asked row goes during the wait: no account row is written and nothing is stamped,
    /// and the answer's address is stored.
    ///
    /// kills: the address stored only with the status.
    #[test]
    fn the_address_is_stored_when_the_asked_row_goes_during_the_wait_lpw43_2() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        let before = encs(&w.sched.rows());
        let answer = ok(handle_answer(HANDLE_A, true)).while_waiting(|| {
            assert_eq!(w.accounts.remove(alice()), 1, "the wait erases alice's row");
        });
        fx.reset_writes();
        let (got, _) = fire(&fx, &w, NOW, Some(answer));
        assert_eq!(got, Ok(()));
        assert_eq!(egress(&w), vec![(4, ADDRESS4.to_string(), NOW)]);
        assert_eq!(
            accounts(&w),
            vec![row_view(bob(), HANDLE_B, true, LONG_AGO, false)]
        );
        assert_eq!(fx.writes_to("world_account"), 0, "no account write");
        assert_eq!(
            encs(&w.sched.rows()),
            before,
            "the fired row stays unstamped"
        );
    }
}

// =====================================================================================
// A tick whose request fails.
// =====================================================================================

mod failing {
    use super::*;

    /// Every way the request can fail: a transport error, a status other than 200, a body that
    /// is not the answer's shape (an `address` of another JSON type included).
    fn failures() -> Vec<(&'static str, Stubbed)> {
        let body = |value: serde_json::Value| -> Stubbed { Ok((200, value.to_string())) };
        vec![
            (
                "a transport error",
                Err("the request timed out".to_string()),
            ),
            ("403", Ok((403, handle_answer(HANDLE_A, true)))),
            ("429", Ok((429, handle_answer(HANDLE_A, true)))),
            ("500", Ok((500, handle_answer(HANDLE_A, true)))),
            ("not JSON", Ok((200, "nope".to_string()))),
            (
                "an array",
                Ok((200, format!("[{}]", handle_answer(HANDLE_A, true)))),
            ),
            (
                "entitled a string",
                body(serde_json::json!({ "handle": HANDLE_A, "entitled": "yes" })),
            ),
            (
                "handle a number",
                body(serde_json::json!({ "handle": 7, "entitled": true })),
            ),
            (
                "a 1025-byte handle",
                Ok((
                    200,
                    handle_answer(&format!("k1.{}", "a".repeat(1022)), true),
                )),
            ),
            (
                "address a number",
                body(serde_json::json!({ "handle": HANDLE_A, "entitled": true, "address": 7 })),
            ),
            (
                "address a boolean",
                body(serde_json::json!({ "handle": HANDLE_A, "entitled": true, "address": true })),
            ),
            (
                "address an array",
                body(serde_json::json!({
                    "handle": HANDLE_A, "entitled": true, "address": [ADDRESS4]
                })),
            ),
            (
                "address an object",
                body(serde_json::json!({
                    "handle": HANDLE_A, "entitled": true, "address": { "ip": ADDRESS4 }
                })),
            ),
        ]
    }

    /// [`marked_world`] with alice entitled, a stored family-4 address and alice's handle on
    /// the host's list.
    fn failing_world(fx: &Fixture) -> W<'_> {
        let w = marked_world(fx, None);
        replace_row(
            &w,
            alice(),
            &account_row(alice(), HANDLE_A, true, LONG_AGO, true),
        );
        w.egress.seed(&egress_row(4, OTHER4, LONG_AGO));
        w.allow.seed(&WorldAllowlist {
            account_subject: HANDLE_A.to_string(),
        });
        w
    }

    /// A failed request is refused as unanswered and writes no table.
    ///
    /// kills: a failure stored as not entitled; a failure stamped; a partial answer's address
    /// stored.
    #[test]
    fn a_failed_tick_is_refused_and_changes_no_table_lpw43_3() {
        for (label, outcome) in failures() {
            let fx = fixture();
            let w = failing_world(&fx);
            fx.reset_writes();
            let before = footprint(&fx, &w);
            let (got, sent) = fire(&fx, &w, NOW, Some(answer_of(&outcome)));
            assert_eq!(
                got,
                Err("the account service gave no answer".to_string()),
                "{label}"
            );
            assert_eq!(sent.len(), 1, "{label}: one request");
            assert_eq!(footprint(&fx, &w), before, "{label}: nothing changes");
        }
    }

    /// After a failed tick the next tick, an hour later, asks again and, answered, stores the
    /// status and stamps the success.
    ///
    /// kills: a failure stamped so the next tick waits 23 h.
    #[test]
    fn the_tick_after_a_failure_asks_again_and_stores_the_answer_lpw43_3() {
        for (label, outcome) in failures() {
            let fx = fixture();
            let w = failing_world(&fx);
            let (got, _) = fire(&fx, &w, NOW, Some(answer_of(&outcome)));
            assert!(got.is_err(), "{label}: the first tick fails");
            let later = NOW + HOUR;
            let (got, sent) = fire(&fx, &w, later, Some(ok(handle_answer(HANDLE_A, false))));
            assert_eq!(got, Ok(()), "{label}");
            assert_eq!(sent.len(), 1, "{label}: the next tick asks");
            assert_handle_request(&sent[0], DEV_URL, HANDLE_A);
            assert!(
                accounts(&w).contains(&row_view(alice(), HANDLE_A, false, later, true)),
                "{label}: stored {:?}",
                accounts(&w)
            );
            assert_one_new_row(&w, &[100], Some(later));
        }
    }
}

// =====================================================================================
// A joiner across two days of ticks.
// =====================================================================================

mod joining {
    use super::*;

    /// A joiner connects once (its re-check armed and answered), then 48 hourly ticks run:
    /// the joiner is asked about once, by its connection; every tick request names the host's
    /// handle; the ticks add no re-check and leave the joiner's row alone.
    ///
    /// kills: the tick asking about every row; the tick arming re-checks; a tick asking every
    /// hour; a tick never asking.
    #[test]
    fn a_joiner_is_asked_about_once_across_48_hourly_ticks_lpw43_4() {
        let fx = fixture();
        let w = marked_world(&fx, None);
        w.accounts
            .seed(&account_row(joiner(), HANDLE_J, true, LONG_AGO, false));
        let connect = NOW;
        fx.run_as_at(joiner(), at(connect), |ctx| {
            arm_recheck_at_connect(ctx, &test_profile())
        });
        let mut armed = w.rechecks.rows();
        assert_eq!(armed.len(), 1, "the connection arms one re-check");
        let armed = armed.remove(0);
        let mut http = HttpQueue::new();
        http.push(ok(handle_answer(HANDLE_J, true)));
        let got = fx.run_procedure(Caller::Database, at(connect), &mut http, |ctx| {
            recheck_account_under(ctx, &test_profile(), armed)
        });
        assert_eq!(got, Ok(()), "the connection's re-check");
        let mut sent: Vec<SentRequest> = http.requests().to_vec();
        assert_eq!(
            w.rechecks.remove(joiner()),
            1,
            "the host spends the one-shot row"
        );

        fx.reset_writes();
        let joiner_before: Vec<AccountView> = accounts(&w)
            .into_iter()
            .filter(|r| r.1 == joiner().to_byte_array())
            .collect();
        let mut asked_at: Vec<i64> = Vec::new();
        let mut tick_requests: Vec<SentRequest> = Vec::new();
        for k in 1..=48 {
            let (got, out) = fire(
                &fx,
                &w,
                connect + k * HOUR,
                Some(ok(handle_answer(HANDLE_A, true))),
            );
            assert_eq!(got, Ok(()), "tick {k}");
            if !out.is_empty() {
                asked_at.push(k);
            }
            tick_requests.extend(out);
        }
        sent.extend(tick_requests.iter().cloned());

        let about_joiner = sent.iter().filter(|r| handle_of(r) == HANDLE_J).count();
        assert_eq!(
            about_joiner, 1,
            "the joiner is asked about by its connection alone"
        );
        // No success before tick 1, then due 23 h after each success: ticks 1, 24 and 47.
        assert_eq!(asked_at, vec![1, 24, 47], "the ticks that ask");
        assert_eq!(tick_requests.len(), 3, "three requests in 48 ticks");
        for req in &tick_requests {
            assert_handle_request(req, DEV_URL, HANDLE_A);
        }
        assert!(
            w.rechecks.rows().is_empty(),
            "no re-check armed by the ticks"
        );
        assert_eq!(fx.writes_to("recheck_schedule"), 0, "no re-check write");
        let joiner_after: Vec<AccountView> = accounts(&w)
            .into_iter()
            .filter(|r| r.1 == joiner().to_byte_array())
            .collect();
        assert_eq!(joiner_after, joiner_before, "the joiner's row is untouched");
        assert_eq!(joiner_after.len(), 1, "fixture: the joiner holds its row");
    }
}
