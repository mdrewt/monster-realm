//! The world access rule (local-play design A1), executed against the in-memory host.
//!
//! One module per criterion: `open_by_default` (a world with no rule row is open),
//! `unadmitted` (a `Password` world refuses an unadmitted connection before anything is
//! recorded), `owner_only` (only `config.owner_identity` sets the rule), `owner_admits` (the
//! owner's admit list), `allowlist` (an `Allowlist` world admits a bound identity by its
//! account and an unbound one by its admission row), `allowlist_seed` (a switch to
//! `Allowlist` lists the accounts the rule in force admitted), `password_rule` (the owner's
//! `Password` rule stores no salt and no hash), `legacy_password` (a salt and hash an earlier
//! module stored admit nobody and go at the owner's next call) and `admitted_outright` (on a
//! `Password` world the owner set, the identities the owner named get in and nobody else).
//!
//! The host models no rollback, so every refusal here is asserted to write nothing at all.

use super::{
    effective_rule, is_admitted, require_admitted, require_admitted_at_connect, set_world_access,
    REJECT_NOT_ADMITTED, REJECT_NOT_WORLD_OWNER,
};
use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::schema::{
    Account, Config, PlayerSession, WorldAccess, WorldAccessRule, WorldAdmission,
    WorldAdmissionAttempt,
};
use spacetimedb::sats::bsatn;
use spacetimedb::{ConnectionId, Identity, ReducerContext, Serialize, Timestamp};

// --- a salt and hash as an earlier module stored them -------------------------
//
// A real Argon2id v1.3 hash (m = 19456 KiB, t = 2, p = 1, 32-byte tag) under a 16-byte salt,
// computed by an independent implementation (OpenSSL through Node's `crypto.argon2Sync`): the
// shape of the `world_access` row an earlier module wrote for a `Password` world.

const KAT_SALT: &[u8; 16] = b"0123456789abcdef";
const KAT_HASH_HEX: &str = "ae4d8c8b713876044c8347c76986a9b5655944aaacfffe9bea4dff9e7b6a1899";

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("a known answer is hex"))
        .collect()
}

// --- fixture vocabulary ------------------------------------------------------

const T0: i64 = 1_700_000_000_000;

fn at(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms * 1000)
}

/// Never `[0; 32]` (the dummy sender) and never the module identity `[0xDB; 32]`.
fn id(b: u8) -> Identity {
    Identity::from_byte_array([b; 32])
}

/// The world owner every world below names in `config`.
fn owner() -> Identity {
    id(0xA1)
}

fn conn_of(who: Identity) -> u128 {
    0xACC0_0000 + u128::from(who.to_byte_array()[0])
}

fn enc<T: Serialize>(row: &T) -> Vec<u8> {
    bsatn::to_vec(row).expect("a row always BSATN-encodes")
}

fn encs<T: Serialize>(rows: &[T]) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = rows.iter().map(enc).collect();
    out.sort();
    out
}

/// The token a signed-in player's connection carries (an allowed issuer and audience).
fn good_jwt() -> String {
    format!(
        r#"{{"iss":"{}","aud":"{}","sub":"subject-access"}}"#,
        crate::accounts::ALLOWED_ISSUERS[0],
        crate::accounts::ALLOWED_AUDIENCE[0]
    )
}

// --- the world -----------------------------------------------------------------

struct W<'a> {
    config: Handle<'a, Config, u32>,
    access: Handle<'a, WorldAccess, u32>,
    admission: Handle<'a, WorldAdmission>,
    attempt: Handle<'a, WorldAdmissionAttempt>,
    session: Handle<'a, PlayerSession>,
    account: Handle<'a, Account>,
}

/// Registers exactly what the access paths touch. `config` is NOT writable: a write to it
/// aborts the test. `player_session` is scannable for the `Open` -> `Password` step and
/// writable for `on_connect`; `account` is writable for a signed-in connection.
fn world(fx: &Fixture) -> W<'_> {
    let _ = fx
        .table_keyed::<PlayerSession, ConnectionId>("player_session", "connection_id", |r| {
            r.connection_id
        })
        .unique();
    let _ = fx.table_keyed::<WorldAdmissionAttempt, i64>(
        "world_admission_attempt",
        "last_wrong_at_ms",
        |r| r.last_wrong_at_ms,
    );
    // The checked accounts: read by `identity` for admission under `Allowlist`, scanned by a
    // switch to `Allowlist` for its seed, never written here.
    let _ = fx
        .table_keyed::<crate::account_checks::WorldAccount, String>(
            "world_account",
            "handle",
            |r| r.handle.clone(),
        )
        .unique();
    let _ = fx
        .table::<crate::account_checks::WorldAccount>("world_account", "identity", |r| r.identity)
        .unique()
        .scannable();
    W {
        config: fx
            .table_keyed::<Config, u32>("config", "id", |r| r.id)
            .unique(),
        access: fx
            .table_keyed::<WorldAccess, u32>("world_access", "id", |r| r.id)
            .unique()
            .writable(),
        admission: fx
            .table::<WorldAdmission>("world_admission", "identity", |r| r.identity)
            .unique()
            .writable(),
        attempt: fx
            .table::<WorldAdmissionAttempt>("world_admission_attempt", "identity", |r| r.identity)
            .unique()
            .writable(),
        session: fx
            .table::<PlayerSession>("player_session", "identity", |r| r.identity)
            .writable()
            .scannable(),
        account: fx
            .table::<Account>("account", "identity", |r| r.identity)
            .unique()
            .writable(),
    }
}

fn seed_owner(w: &W<'_>, who: Identity) {
    w.config.seed(&Config {
        id: 0,
        content_version: 0,
        owner_identity: who,
    });
}

/// A `Password` row holding [`KAT_SALT`] and the Argon2id hash under it, as an earlier module
/// stored it.
fn password_row() -> WorldAccess {
    WorldAccess {
        id: 0,
        rule: WorldAccessRule::Password,
        password_salt: KAT_SALT.to_vec(),
        password_hash: unhex(KAT_HASH_HEX),
    }
}

/// The row the owner's `set_world_access` stores for `rule`: no salt and no hash.
fn stored_row(rule: WorldAccessRule) -> WorldAccess {
    WorldAccess {
        id: 0,
        rule,
        password_salt: Vec::new(),
        password_hash: Vec::new(),
    }
}

fn open_row() -> WorldAccess {
    WorldAccess {
        id: 0,
        rule: WorldAccessRule::Open,
        password_salt: Vec::new(),
        password_hash: Vec::new(),
    }
}

/// A world owned by [`owner`] whose rule is `Password`, its row as [`password_row`].
fn password_world(fx: &Fixture) -> W<'_> {
    let w = world(fx);
    seed_owner(&w, owner());
    w.access.seed(&password_row());
    w
}

fn admission_row(who: Identity, ms: i64) -> WorldAdmission {
    WorldAdmission {
        identity: who,
        admitted_at_ms: ms,
    }
}

fn attempt_row(who: Identity, stamps: &[i64]) -> WorldAdmissionAttempt {
    WorldAdmissionAttempt {
        identity: who,
        wrong_at_ms: stamps.to_vec(),
        last_wrong_at_ms: *stamps.last().expect("an attempt row holds a stamp"),
    }
}

fn session_row(who: Identity, conn: u128) -> PlayerSession {
    PlayerSession {
        connection_id: ConnectionId::from_u128(conn),
        identity: who,
    }
}

// --- calls -----------------------------------------------------------------------

/// Run `f` as `who` over an anonymous client connection at `ms`.
fn call<T>(fx: &Fixture, who: Identity, ms: i64, f: impl FnOnce(&ReducerContext) -> T) -> T {
    fx.run_as_conn_at(who, conn_of(who), None, at(ms), f)
}

/// Run `f` as `who` over a signed-in client connection at `ms`.
fn call_signed_in<T>(
    fx: &Fixture,
    who: Identity,
    ms: i64,
    f: impl FnOnce(&ReducerContext) -> T,
) -> T {
    let jwt = good_jwt();
    fx.run_as_conn_at(who, conn_of(who), Some(&jwt), at(ms), f)
}

/// The admission check a player reducer makes first, as `who`.
fn passes(fx: &Fixture, who: Identity, ms: i64) -> Result<(), String> {
    call(fx, who, ms, |ctx| require_admitted(ctx, "join_game"))
}

/// `caller` sets the rule to `rule` and admits `list` at `ms`.
fn set_access(
    fx: &Fixture,
    caller: Identity,
    rule: WorldAccessRule,
    list: Vec<Identity>,
    ms: i64,
) -> Result<(), String> {
    call(fx, caller, ms, |ctx| set_world_access(ctx, rule, list))
}

// --- observations ------------------------------------------------------------------

/// Every stored row of the six registered tables, with each table's write count.
fn footprint(fx: &Fixture, w: &W<'_>) -> Vec<(&'static str, Vec<Vec<u8>>, u32)> {
    vec![
        ("config", encs(&w.config.rows()), fx.writes_to("config")),
        (
            "world_access",
            encs(&w.access.rows()),
            fx.writes_to("world_access"),
        ),
        (
            "world_admission",
            encs(&w.admission.rows()),
            fx.writes_to("world_admission"),
        ),
        (
            "world_admission_attempt",
            encs(&w.attempt.rows()),
            fx.writes_to("world_admission_attempt"),
        ),
        (
            "player_session",
            encs(&w.session.rows()),
            fx.writes_to("player_session"),
        ),
        ("account", encs(&w.account.rows()), fx.writes_to("account")),
    ]
}

/// The admission rows as `(identity bytes, admitted_at_ms)`, sorted.
fn admissions(w: &W<'_>) -> Vec<([u8; 32], i64)> {
    let mut out: Vec<([u8; 32], i64)> = w
        .admission
        .rows()
        .into_iter()
        .map(|r| (r.identity.to_byte_array(), r.admitted_at_ms))
        .collect();
    out.sort_unstable();
    out
}

fn attempts_of(w: &W<'_>, who: Identity) -> Option<(Vec<i64>, i64)> {
    w.attempt
        .rows()
        .into_iter()
        .find(|r| r.identity == who)
        .map(|r| (r.wrong_at_ms, r.last_wrong_at_ms))
}

fn admitted_at(w: &W<'_>, who: Identity) -> Option<i64> {
    w.admission
        .rows()
        .into_iter()
        .find(|r| r.identity == who)
        .map(|r| r.admitted_at_ms)
}

/// The connection ids `who` has a session row for, sorted.
fn sessions_of(w: &W<'_>, who: Identity) -> Vec<u128> {
    let mut out: Vec<u128> = w
        .session
        .rows()
        .into_iter()
        .filter(|r| r.identity == who)
        .map(|r| r.connection_id.to_u128())
        .collect();
    out.sort_unstable();
    out
}

fn access_row(w: &W<'_>) -> Vec<u8> {
    let rows = w.access.rows();
    assert_eq!(rows.len(), 1, "the world holds exactly one access row");
    enc(&rows[0])
}

// =====================================================================================
// A world with no `world_access` row is `Open`.
// =====================================================================================

mod open_by_default {
    use super::*;

    /// No row is `Open`; a row's rule is the row's own, whatever its salt and hash hold.
    ///
    /// kills: `effective_rule` answering a constant; a `Password` row read as `Open` because
    /// its salt or hash is empty.
    #[test]
    fn a_world_with_no_access_row_is_open_and_a_row_keeps_its_own_rule() {
        assert_eq!(effective_rule(None), WorldAccessRule::Open);
        assert_eq!(effective_rule(Some(&open_row())), WorldAccessRule::Open);
        assert_eq!(
            effective_rule(Some(&password_row())),
            WorldAccessRule::Password
        );
        let bare = WorldAccess {
            password_salt: Vec::new(),
            password_hash: Vec::new(),
            ..password_row()
        };
        assert_eq!(
            effective_rule(Some(&bare)),
            WorldAccessRule::Password,
            "the rule column decides the rule, not the presence of a hash"
        );
    }

    /// With no access row, a stranger passes the admission check and its connection is
    /// accepted and recorded; nothing access-related is written.
    ///
    /// kills: a missing row read as `Password` (every stranger refused); an open world that
    /// records admissions.
    #[test]
    fn a_stranger_passes_and_connects_on_a_world_with_no_access_row() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        let stranger = id(0x11);
        assert_eq!(passes(&fx, stranger, T0), Ok(()));
        assert!(call(&fx, stranger, T0, |ctx| is_admitted(ctx, stranger)));
        assert_eq!(call(&fx, stranger, T0, require_admitted_at_connect), Ok(()));
        assert_eq!(call(&fx, stranger, T0, crate::on_connect), Ok(()));
        assert_eq!(
            sessions_of(&w, stranger),
            vec![conn_of(stranger)],
            "the stranger's connection is recorded"
        );
        assert!(w.access.rows().is_empty(), "no access row is written");
        assert!(w.admission.rows().is_empty(), "no admission is recorded");
        assert_eq!(fx.writes_to("world_access"), 0);
        assert_eq!(fx.writes_to("world_admission"), 0);
        assert_eq!(fx.writes_to("world_admission_attempt"), 0);
    }

    /// A row whose rule is `Open` admits a stranger exactly as no row does, with or without a
    /// `config` row.
    ///
    /// kills: the mere presence of an access row read as a password rule.
    #[test]
    fn an_open_rule_row_admits_a_stranger_as_no_row_does() {
        let fx = fixture();
        let w = world(&fx);
        w.access.seed(&open_row());
        let stranger = id(0x12);
        assert_eq!(
            passes(&fx, stranger, T0),
            Ok(()),
            "an open world with no config row"
        );
        seed_owner(&w, owner());
        assert_eq!(passes(&fx, stranger, T0), Ok(()));
        assert!(call(&fx, stranger, T0, |ctx| is_admitted(ctx, stranger)));
        assert_eq!(call(&fx, stranger, T0, crate::on_connect), Ok(()));
        assert_eq!(sessions_of(&w, stranger), vec![conn_of(stranger)]);
        assert_eq!(
            access_row(&w),
            enc(&open_row()),
            "the open row is untouched"
        );
        assert!(w.admission.rows().is_empty());
    }
}

// =====================================================================================
// An unadmitted connection to a `Password` world gets nothing.
// =====================================================================================

mod unadmitted {
    use super::*;

    /// On a `Password` world a stranger's admission check refuses with nothing written; the
    /// owner and an admitted identity pass.
    ///
    /// kills: `require_admitted` answering `Ok` regardless; the owner refused; an admission
    /// row ignored; a refusal that records something.
    #[test]
    fn a_stranger_is_refused_by_the_admission_check_and_the_owner_and_admitted_pass() {
        let fx = fixture();
        let w = password_world(&fx);
        let stranger = id(0x13);
        let let_in = id(0x14);
        w.admission.seed(&admission_row(let_in, T0 - 5));
        let before = footprint(&fx, &w);
        assert_eq!(
            passes(&fx, stranger, T0),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        assert!(!call(&fx, stranger, T0, |ctx| is_admitted(ctx, stranger)));
        assert_eq!(
            footprint(&fx, &w),
            before,
            "a refused admission check writes nothing"
        );
        assert_eq!(passes(&fx, owner(), T0), Ok(()), "the owner passes");
        assert!(call(&fx, stranger, T0, |ctx| is_admitted(ctx, owner())));
        assert_eq!(
            passes(&fx, let_in, T0),
            Ok(()),
            "an admitted identity passes"
        );
        assert!(call(&fx, stranger, T0, |ctx| is_admitted(ctx, let_in)));
        assert_eq!(footprint(&fx, &w), before, "passing writes nothing either");
    }

    /// A stranger's anonymous connection to a `Password` world is refused before its session
    /// is recorded.
    ///
    /// kills: the connect check placed after `open_player_session` (a refused connection
    /// leaves a session row); `on_connect` with no connect check.
    #[test]
    fn a_strangers_anonymous_connection_is_refused_before_its_session_is_recorded() {
        let fx = fixture();
        let w = password_world(&fx);
        let stranger = id(0x15);
        assert_eq!(
            call(&fx, stranger, T0, require_admitted_at_connect),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        let before = footprint(&fx, &w);
        assert_eq!(
            call(&fx, stranger, T0, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        assert!(
            sessions_of(&w, stranger).is_empty(),
            "a refused connection has no session row"
        );
        assert_eq!(fx.writes_to("player_session"), 0);
        assert_eq!(footprint(&fx, &w), before, "the refusal writes nothing");
    }

    /// A stranger's signed-in connection (an allowed issuer) is refused before its account is
    /// provisioned.
    ///
    /// kills: the connect check placed after `provision_or_touch_account`.
    #[test]
    fn a_strangers_signed_in_connection_is_refused_before_its_account_is_provisioned() {
        let fx = fixture();
        let w = password_world(&fx);
        let stranger = id(0x16);
        let before = footprint(&fx, &w);
        assert_eq!(
            call_signed_in(&fx, stranger, T0, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        assert!(
            w.account.rows().is_empty(),
            "no account is provisioned for a refused connection"
        );
        assert!(sessions_of(&w, stranger).is_empty());
        assert_eq!(fx.writes_to("account"), 0);
        assert_eq!(fx.writes_to("player_session"), 0);
        assert_eq!(footprint(&fx, &w), before);
    }

    /// A refused connection writes to no table the module declares — the table list is the
    /// GENERATED module definition, not a hand list.
    ///
    /// kills: any write (to any table) that precedes the connect check.
    #[test]
    fn a_refused_connection_writes_to_no_table_the_module_declares() {
        let fx = fixture();
        let _w = password_world(&fx);
        let stranger = id(0x17);
        let tables: Vec<String> = {
            let def = fx.module_def();
            def.tables()
                .unwrap_or_else(|| panic!("the generated module def carries no Tables section"))
                .iter()
                .map(|t| t.source_name.to_string())
                .collect()
        };
        assert_eq!(
            tables.len(),
            crate::schema::DATA_LIFECYCLE_MANIFEST.len(),
            "the module def lists every table the manifest classifies"
        );
        for table in ["player_session", "account", "world_admission", "config"] {
            assert!(
                tables.iter().any(|t| t == table),
                "fixture: `{table}` is a generated table"
            );
        }
        let jwt = good_jwt();
        for token in [None, Some(jwt.as_str())] {
            let got = fx.run_as_conn_at(
                stranger,
                conn_of(stranger),
                token,
                at(T0),
                crate::on_connect,
            );
            assert_eq!(
                got,
                Err(REJECT_NOT_ADMITTED.to_string()),
                "refused (jwt: {})",
                token.is_some()
            );
        }
        let written: Vec<&String> = tables.iter().filter(|t| fx.writes_to(t) > 0).collect();
        assert!(
            written.is_empty(),
            "a refused connection wrote to {written:?}"
        );
    }

    /// The owner and an admitted identity connect to a `Password` world and get their session
    /// row; the admitted identity's signed-in connection is provisioned as usual.
    ///
    /// kills: a connect check that refuses the owner or an admitted identity.
    #[test]
    fn the_owner_and_an_admitted_identity_connect_and_get_their_session() {
        let fx = fixture();
        let w = password_world(&fx);
        let let_in = id(0x18);
        w.admission.seed(&admission_row(let_in, T0 - 5));
        assert_eq!(call(&fx, owner(), T0, crate::on_connect), Ok(()));
        assert_eq!(sessions_of(&w, owner()), vec![conn_of(owner())]);
        assert_eq!(
            call_signed_in(&fx, let_in, T0 + 1, crate::on_connect),
            Ok(())
        );
        assert_eq!(sessions_of(&w, let_in), vec![conn_of(let_in)]);
        assert_eq!(
            encs(&w.account.rows()),
            encs(&[crate::accounts::new_account_row(
                let_in,
                crate::accounts::ALLOWED_ISSUERS[0].to_string(),
                T0 + 1
            )]),
            "the admitted identity's signed-in connection is provisioned"
        );
        assert_eq!(
            admissions(&w),
            vec![(let_in.to_byte_array(), T0 - 5)],
            "connecting writes no admission"
        );
    }

    /// A `Password` world with no `config` row has no owner: it admits only identities with
    /// an admission row — not the all-zero identity, not the database identity.
    ///
    /// kills: a missing config row read as "anyone is the owner"; an owner defaulted to the
    /// all-zero identity.
    #[test]
    fn a_password_world_with_no_config_row_admits_only_admission_rows() {
        let fx = fixture();
        let w = world(&fx);
        w.access.seed(&password_row());
        let let_in = id(0x19);
        w.admission.seed(&admission_row(let_in, T0 - 5));
        let zero = Identity::from_byte_array([0u8; 32]);
        let database = id(0xD1);
        fx.set_database_identity(database);
        for who in [id(0x1A), owner(), zero, database] {
            assert_eq!(
                passes(&fx, who, T0),
                Err(REJECT_NOT_ADMITTED.to_string()),
                "with no config row {} is nobody's owner",
                who.to_hex()
            );
        }
        assert_eq!(
            call(&fx, zero, T0, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        assert!(sessions_of(&w, zero).is_empty());
        assert_eq!(passes(&fx, let_in, T0), Ok(()));
    }

    /// The owner is `config.owner_identity`: the database identity is refused when it is not
    /// the owner, and so is the identity whose session row the world recorded first.
    ///
    /// kills: the owner taken from `ctx.database_identity()`; the owner taken from the first
    /// `player_session` row.
    #[test]
    fn the_owner_is_the_config_owner_not_the_database_identity_or_the_first_session() {
        let fx = fixture();
        let w = password_world(&fx);
        let database = id(0xD2);
        fx.set_database_identity(database);
        let first = id(0x1B);
        w.session.seed(&session_row(first, 0x0F00));
        w.session.seed(&session_row(owner(), 0x0F01));
        assert_eq!(
            passes(&fx, database, T0),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        assert_eq!(
            call(&fx, database, T0, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        assert!(sessions_of(&w, database).is_empty());
        assert_eq!(
            passes(&fx, first, T0),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "the first recorded session is not the owner"
        );
        assert_eq!(passes(&fx, owner(), T0), Ok(()));
    }
}

// =====================================================================================
// Only `config.owner_identity` may call `set_world_access`.
// =====================================================================================

mod owner_only {
    use super::*;

    /// A stranger on an `Open` world cannot set the rule or admit itself.
    ///
    /// kills: the owner check dropped from `set_world_access`.
    #[test]
    fn a_stranger_on_an_open_world_cannot_set_the_rule() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        let stranger = id(0x31);
        let before = footprint(&fx, &w);
        assert_eq!(
            set_access(&fx, stranger, WorldAccessRule::Password, vec![stranger], T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            set_access(&fx, stranger, WorldAccessRule::Open, vec![stranger], T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(footprint(&fx, &w), before, "nothing is written");
    }

    /// An ADMITTED non-owner on a `Password` world is refused `set_world_access`, so the
    /// refusal is the owner check's, not the admission check's.
    ///
    /// kills: `set_world_access` gated on admission instead of ownership.
    #[test]
    fn an_admitted_non_owner_cannot_set_the_rule() {
        let fx = fixture();
        let w = password_world(&fx);
        let let_in = id(0x32);
        w.admission.seed(&admission_row(let_in, T0 - 1));
        assert_eq!(passes(&fx, let_in, T0), Ok(()), "fixture: it is admitted");
        let before = footprint(&fx, &w);
        assert_eq!(
            set_access(&fx, let_in, WorldAccessRule::Open, Vec::new(), T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            set_access(&fx, let_in, WorldAccessRule::Password, vec![id(0x33)], T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(footprint(&fx, &w), before, "nothing is written");
    }

    /// The database identity is not the owner when `config` names someone else.
    ///
    /// kills: the owner taken from `ctx.database_identity()`.
    #[test]
    fn the_database_identity_is_refused_when_it_is_not_the_owner() {
        let fx = fixture();
        let w = password_world(&fx);
        let database = id(0xD3);
        fx.set_database_identity(database);
        let before = footprint(&fx, &w);
        assert_eq!(
            set_access(&fx, database, WorldAccessRule::Open, Vec::new(), T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(footprint(&fx, &w), before);
    }

    /// A `config` row whose owner is the all-zero identity (the column default: an owner
    /// never registered) names nobody: the all-zero caller is refused `set_world_access` with
    /// no write, and on a `Password` world it is refused by the admission check unless it
    /// holds an admission row.
    ///
    /// kills: the unregistered-owner clause dropped (the all-zero identity treated as the
    /// owner it matches).
    #[test]
    fn an_unregistered_all_zero_owner_is_nobody() {
        let fx = fixture();
        let w = world(&fx);
        let zero = Identity::from_byte_array([0u8; 32]);
        seed_owner(&w, zero);
        let before = footprint(&fx, &w);
        assert_eq!(
            set_access(&fx, zero, WorldAccessRule::Password, vec![zero], T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            set_access(&fx, zero, WorldAccessRule::Open, Vec::new(), T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(footprint(&fx, &w), before, "nothing is written");

        w.access.seed(&password_row());
        assert_eq!(passes(&fx, zero, T0), Err(REJECT_NOT_ADMITTED.to_string()));
        assert!(!call(&fx, zero, T0, |ctx| is_admitted(ctx, zero)));
        w.admission.seed(&admission_row(zero, T0 - 1));
        assert_eq!(
            passes(&fx, zero, T0),
            Ok(()),
            "an admission row admits it like anyone else"
        );
    }

    /// With no `config` row nobody owns the world: every caller — a stranger, the would-be
    /// owner, the all-zero identity, the database identity — is refused `set_world_access`.
    ///
    /// kills: a missing config row read as "anyone is the owner"; an owner defaulted to the
    /// all-zero identity or the database identity.
    #[test]
    fn with_no_config_row_every_caller_is_refused() {
        let fx = fixture();
        let w = world(&fx);
        let database = id(0xD4);
        fx.set_database_identity(database);
        let zero = Identity::from_byte_array([0u8; 32]);
        let before = footprint(&fx, &w);
        for caller in [id(0x36), owner(), zero, database] {
            assert_eq!(
                set_access(&fx, caller, WorldAccessRule::Password, vec![caller], T0),
                Err(REJECT_NOT_WORLD_OWNER.to_string()),
                "set_world_access by {}",
                caller.to_hex()
            );
        }
        assert_eq!(footprint(&fx, &w), before, "nothing is written");
    }
}

// =====================================================================================
// The owner's admit list admits without a password.
// =====================================================================================

mod owner_admits {
    use super::*;

    /// An admit list under `Open` writes the admission, and it still holds after the rule
    /// becomes `Password`.
    ///
    /// kills: the admit list honoured only under `Password`; admissions dropped when the
    /// rule changes.
    #[test]
    fn an_admit_list_under_open_holds_after_the_rule_becomes_password() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        let x = id(0x43);
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Open, vec![x], T0),
            Ok(())
        );
        assert_eq!(access_row(&w), enc(&open_row()));
        assert_eq!(admissions(&w), vec![(x.to_byte_array(), T0)]);
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Password, Vec::new(), T0 + 5),
            Ok(())
        );
        assert_eq!(
            admissions(&w),
            vec![(x.to_byte_array(), T0)],
            "the earlier admission holds, unchanged"
        );
        assert_eq!(passes(&fx, x, T0 + 6), Ok(()));
    }

    /// Leaving `Open` admits every identity with a `player_session` row except the owner, one
    /// row per identity however many sockets it holds.
    ///
    /// kills: leaving `Open` admitting nobody (connected players locked out of their own
    /// world); an identity with two sockets aborting the call or getting two rows; the owner
    /// given a row.
    #[test]
    fn leaving_open_admits_every_connected_identity_once() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        w.access.seed(&open_row());
        let a = id(0x44);
        let b = id(0x45);
        w.session.seed(&session_row(a, 0x0A01));
        w.session.seed(&session_row(b, 0x0B01));
        w.session.seed(&session_row(a, 0x0A02));
        w.session.seed(&session_row(owner(), 0x0C01));
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Password, Vec::new(), T0),
            Ok(())
        );
        let mut want = vec![(a.to_byte_array(), T0), (b.to_byte_array(), T0)];
        want.sort_unstable();
        assert_eq!(admissions(&w), want);
        assert_eq!(passes(&fx, a, T0 + 1), Ok(()));
        assert_eq!(passes(&fx, b, T0 + 1), Ok(()));
        assert_eq!(
            passes(&fx, id(0x46), T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
    }

    /// Admitting an identity twice keeps its first admission time — through the admit list
    /// and through leaving `Open`.
    ///
    /// kills: an admission overwritten (or duplicated) on a second admit.
    #[test]
    fn admitting_twice_keeps_the_first_admission_time() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        let x = id(0x49);
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Open, vec![x], T0),
            Ok(())
        );
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Open, vec![x, x], T0 + 50),
            Ok(())
        );
        assert_eq!(admissions(&w), vec![(x.to_byte_array(), T0)]);
        w.session.seed(&session_row(x, 0x0E01));
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Password, vec![x], T0 + 100),
            Ok(())
        );
        assert_eq!(admissions(&w), vec![(x.to_byte_array(), T0)]);
    }

    /// Admitting an identity drops its attempt row, and only its own.
    ///
    /// kills: an admitted identity left with wrong-password stamps; the drop keyed on the
    /// wrong identity.
    #[test]
    fn admitting_drops_that_identitys_attempt_row() {
        let fx = fixture();
        let w = password_world(&fx);
        let x = id(0x4A);
        let y = id(0x4B);
        w.attempt.seed(&attempt_row(x, &[T0 - 3, T0 - 2]));
        w.attempt.seed(&attempt_row(y, &[T0 - 3, T0 - 1]));
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Password, vec![x], T0),
            Ok(())
        );
        assert_eq!(attempts_of(&w, x), None);
        assert_eq!(attempts_of(&w, y), Some((vec![T0 - 3, T0 - 1], T0 - 1)));
        assert_eq!(admitted_at(&w, x), Some(T0));
    }
}

// =====================================================================================
// An `Allowlist` world admits a bound identity by its account on the list, and an identity
// with no trusted binding by its admission row.
// =====================================================================================

mod allowlist {
    use super::*;
    use crate::account_checks::WorldAccount;
    use crate::schema::WorldAllowlist;

    const ALICE: &str = "k1.alice-6f1c2a3b";
    const BOB: &str = "k1.bob-0d4e4f5a";
    const CAROL: &str = "k1.carol-8b6c7d8e";

    /// The access tables of [`world`] plus `world_account` (read by `identity`, and scanned by
    /// a switch to `Allowlist`) and `world_allowlist` (read by handle, and scanned and written
    /// by the handles a switch to `Allowlist` lists). `world_account` is not writable: no path
    /// under test writes it, and a write to it aborts the test.
    struct A<'a> {
        w: W<'a>,
        accounts: Handle<'a, WorldAccount>,
        list: Handle<'a, WorldAllowlist, String>,
    }

    fn tables(fx: &Fixture) -> A<'_> {
        A {
            w: world(fx),
            accounts: fx
                .table::<WorldAccount>("world_account", "identity", |r| r.identity)
                .unique()
                .scannable(),
            list: fx
                .table_keyed::<WorldAllowlist, String>("world_allowlist", "account_subject", |r| {
                    r.account_subject.clone()
                })
                .unique()
                .writable()
                .scannable(),
        }
    }

    fn allowlist_row() -> WorldAccess {
        WorldAccess {
            id: 0,
            rule: WorldAccessRule::Allowlist,
            password_salt: Vec::new(),
            password_hash: Vec::new(),
        }
    }

    /// A world owned by [`owner`] whose rule is `Allowlist`, with an empty list.
    fn allowlist_world(fx: &Fixture) -> A<'_> {
        let a = tables(fx);
        seed_owner(&a.w, owner());
        a.w.access.seed(&allowlist_row());
        a
    }

    /// `who` holds a checked account under `handle`, checked too recently for a connection to
    /// arm a re-check.
    fn bind(a: &A<'_>, who: Identity, handle: &str) {
        a.accounts.seed(&WorldAccount {
            handle: handle.to_string(),
            identity: who,
            entitled: true,
            checked_at_ms: T0 - 100,
            is_host: false,
        });
    }

    fn enlist(a: &A<'_>, subjects: &[&str]) {
        for subject in subjects {
            a.list.seed(&WorldAllowlist {
                account_subject: (*subject).to_string(),
            });
        }
    }

    /// Every stored row of every registered table, with each table's write count.
    fn footprint_all(fx: &Fixture, a: &A<'_>) -> Vec<(&'static str, Vec<Vec<u8>>, u32)> {
        let mut out = footprint(fx, &a.w);
        out.push((
            "world_account",
            encs(&a.accounts.rows()),
            fx.writes_to("world_account"),
        ));
        out.push((
            "world_allowlist",
            encs(&a.list.rows()),
            fx.writes_to("world_allowlist"),
        ));
        out
    }

    fn footprint_but_sessions(fx: &Fixture, a: &A<'_>) -> Vec<(&'static str, Vec<Vec<u8>>, u32)> {
        footprint_all(fx, a)
            .into_iter()
            .filter(|(table, _, _)| *table != "player_session")
            .collect()
    }

    /// `who` passes both doors: the admission check of a client-callable reducer, and the
    /// connect reducer, which records its connection and writes nothing else. Any session row
    /// `who` holds is dropped first (its earlier connection closed).
    #[track_caller]
    fn assert_admitted(fx: &Fixture, a: &A<'_>, who: Identity, ms: i64, case: &str) {
        let _ = a.w.session.remove(who);
        let before = footprint_but_sessions(fx, a);
        assert_eq!(passes(fx, who, ms), Ok(()), "{case}: the admission check");
        assert!(
            call(fx, who, ms, |ctx| is_admitted(ctx, who)),
            "{case}: is_admitted"
        );
        assert_eq!(
            call(fx, who, ms, crate::on_connect),
            Ok(()),
            "{case}: the connection"
        );
        assert_eq!(
            sessions_of(&a.w, who),
            vec![conn_of(who)],
            "{case}: the connection is recorded"
        );
        assert_eq!(
            footprint_but_sessions(fx, a),
            before,
            "{case}: admitting writes nothing but the session"
        );
    }

    /// `who` is refused at both doors, anonymous and signed in, with `REJECT_NOT_ADMITTED`, and
    /// no registered table changes.
    #[track_caller]
    fn assert_refused(fx: &Fixture, a: &A<'_>, who: Identity, ms: i64, case: &str) {
        let before = footprint_all(fx, a);
        assert_eq!(
            passes(fx, who, ms),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "{case}: the admission check"
        );
        assert!(
            !call(fx, who, ms, |ctx| is_admitted(ctx, who)),
            "{case}: is_admitted"
        );
        assert_eq!(
            call(fx, who, ms, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "{case}: the anonymous connection"
        );
        assert_eq!(
            call_signed_in(fx, who, ms, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "{case}: the signed-in connection"
        );
        assert_eq!(
            footprint_all(fx, a),
            before,
            "{case}: a refusal writes nothing"
        );
    }

    fn sorted(mut rows: Vec<([u8; 32], i64)>) -> Vec<([u8; 32], i64)> {
        rows.sort_unstable();
        rows
    }

    // --- who the rule admits ---------------------------------------------------------

    /// kills: a bound identity sent to the admission table (refused for want of a row); an
    /// admission row written at connect; a rule that admits every bound identity.
    #[test]
    fn a_bound_identity_whose_account_is_listed_is_admitted_with_no_admission_row() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE, BOB]);
        let listed = id(0x61);
        let unlisted = id(0x62);
        bind(&a, listed, ALICE);
        bind(&a, unlisted, CAROL);
        assert_admitted(&fx, &a, listed, T0, "bound to a listed account");
        assert!(
            a.w.admission.rows().is_empty(),
            "the admission is not recorded"
        );
        assert_refused(&fx, &a, unlisted, T0, "bound to an unlisted account");
    }

    /// kills: a non-empty list read as "admit every bound identity"; another identity's
    /// admission row read for this one; a refusal placed after the account is provisioned.
    #[test]
    fn a_bound_identity_whose_account_is_not_listed_is_refused_with_no_write() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE, BOB]);
        let who = id(0x63);
        bind(&a, who, CAROL);
        a.w.admission.seed(&admission_row(id(0x64), T0 - 10));
        assert_refused(&fx, &a, who, T0, "bound to an unlisted account");
    }

    /// kills: an admission row that overrides the list for a bound identity.
    #[test]
    fn a_bound_identity_whose_account_is_not_listed_is_refused_despite_an_admission_row() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE]);
        let who = id(0x65);
        bind(&a, who, CAROL);
        a.w.admission.seed(&admission_row(who, T0 - 50));
        assert_refused(
            &fx,
            &a,
            who,
            T0,
            "bound to an unlisted account, with an admission row",
        );
        assert_eq!(a.accounts.remove(who), 1, "fixture: the account row goes");
        assert_admitted(
            &fx,
            &a,
            who,
            T0 + 1,
            "the same identity with no account row, admitted before",
        );
    }

    /// kills: an unbound identity refused outright (no way in for a joiner who presents no
    /// attestation).
    #[test]
    fn an_unbound_identity_admitted_before_is_admitted() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE]);
        let seen = id(0x66);
        let new = id(0x67);
        a.w.admission.seed(&admission_row(seen, T0 - 20));
        assert_admitted(&fx, &a, seen, T0, "no binding, admitted before");
        assert_eq!(admissions(&a.w), vec![(seen.to_byte_array(), T0 - 20)]);
        assert_refused(&fx, &a, new, T0, "no binding, never admitted");
    }

    /// kills: an `Allowlist` world that admits an identity with neither a binding nor an
    /// admission row; a refusal that records something.
    #[test]
    fn an_unbound_identity_never_admitted_is_refused_with_no_write() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE]);
        bind(&a, id(0x68), ALICE);
        a.w.admission.seed(&admission_row(id(0x69), T0 - 5));
        assert_refused(&fx, &a, id(0x6A), T0, "no binding, no admission row");
    }

    /// The owner is admitted before the binding is read: with no binding and no admission
    /// row, and bound to an account that is not listed.
    ///
    /// kills: the owner clause dropped; the owner governed by the list when it is bound.
    #[test]
    fn the_owner_is_admitted_with_no_binding_and_with_an_unlisted_binding() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE]);
        assert_admitted(&fx, &a, owner(), T0, "the owner, unbound and unadmitted");
        assert_refused(&fx, &a, id(0x6B), T0, "a stranger");
        bind(&a, owner(), CAROL);
        assert_admitted(
            &fx,
            &a,
            owner(),
            T0 + 1,
            "the owner, bound to an unlisted account",
        );
    }

    /// Taking a handle off the list refuses its identity at its next check, one with an
    /// admission row too; an identity whose handle is still listed stays in.
    ///
    /// kills: the list cached at connect or copied into an admission row; an admission row
    /// that outlives delisting.
    #[test]
    fn taking_an_account_off_the_list_refuses_its_identities_at_the_next_check() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE, BOB, CAROL]);
        let who = id(0x71);
        let seen = id(0x72);
        let other = id(0x73);
        bind(&a, who, ALICE);
        bind(&a, seen, CAROL);
        bind(&a, other, BOB);
        a.w.admission.seed(&admission_row(seen, T0 - 40));
        assert_admitted(&fx, &a, who, T0, "listed");
        assert_admitted(&fx, &a, seen, T0, "listed, admitted before");
        assert_eq!(
            a.list.remove(ALICE.to_string()),
            1,
            "fixture: ALICE leaves the list"
        );
        assert_eq!(
            a.list.remove(CAROL.to_string()),
            1,
            "fixture: CAROL leaves the list"
        );
        assert_refused(&fx, &a, who, T0 + 1, "delisted");
        assert_refused(&fx, &a, seen, T0 + 1, "delisted, admitted before");
        assert_admitted(&fx, &a, other, T0 + 1, "a handle still listed");
    }

    /// kills: an empty list read as "no restriction"; an empty list that closes the world to
    /// an unbound identity admitted before.
    #[test]
    fn an_empty_allowlist_admits_no_bound_identity() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        let p = id(0x77);
        let q = id(0x78);
        let seen = id(0x79);
        bind(&a, p, ALICE);
        bind(&a, q, BOB);
        a.w.admission.seed(&admission_row(seen, T0 - 3));
        assert!(a.list.rows().is_empty(), "fixture: the list is empty");
        assert_refused(&fx, &a, p, T0, "bound to ALICE, empty list");
        assert_refused(&fx, &a, q, T0, "bound to BOB, empty list");
        assert_admitted(&fx, &a, seen, T0, "unbound, admitted before");
    }

    /// The bound account is compared with the list byte for byte.
    ///
    /// kills: a case-folded comparison; a prefix or substring match in either direction.
    #[test]
    fn the_account_on_the_list_must_be_the_bound_account_exactly() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        let bound = "dev:Alice-0001";
        let who = id(0x7A);
        bind(&a, who, bound);
        let near = [
            "dev:alice-0001".to_string(),
            bound.to_uppercase(),
            format!("{bound}2"),
            format!("{bound}-x"),
            bound[..bound.len() - 1].to_string(),
            "dev:Alice".to_string(),
        ];
        for listed in &near {
            assert_ne!(listed, bound, "fixture: a near miss");
            enlist(&a, &[listed.as_str()]);
            assert_refused(
                &fx,
                &a,
                who,
                T0,
                &format!("listed {listed:?}, bound {bound:?}"),
            );
            assert_eq!(a.list.remove(listed.clone()), 1);
        }
        enlist(&a, &[bound]);
        assert_admitted(&fx, &a, who, T0, "the exact account listed");
    }

    /// The list is read only under `Allowlist`: under `Open` an unbound, unadmitted identity
    /// is admitted; under `Password` a bound identity on the list is refused for want of an
    /// admission row; under `Allowlist` the bound one is admitted and the unbound one refused.
    ///
    /// kills: the list read under `Password`; the binding read under `Open`.
    #[test]
    fn the_list_counts_only_under_the_allowlist_rule() {
        let fx = fixture();
        let a = tables(&fx);
        seed_owner(&a.w, owner());
        enlist(&a, &[ALICE]);
        let bound = id(0x7B);
        let stranger = id(0x7C);
        bind(&a, bound, ALICE);
        assert_admitted(&fx, &a, stranger, T0, "no access row: unbound, unadmitted");
        a.w.access.seed(&open_row());
        assert_admitted(&fx, &a, stranger, T0, "Open: unbound, unadmitted");
        assert_admitted(&fx, &a, bound, T0, "Open: bound and listed");
        assert_eq!(a.w.access.remove(0), 1);
        a.w.access.seed(&password_row());
        assert_refused(
            &fx,
            &a,
            bound,
            T0,
            "Password: bound and listed, no admission",
        );
        assert_refused(&fx, &a, stranger, T0, "Password: unbound, unadmitted");
        assert_eq!(a.w.access.remove(0), 1);
        a.w.access.seed(&allowlist_row());
        assert_admitted(&fx, &a, bound, T0, "Allowlist: bound and listed");
        assert_refused(&fx, &a, stranger, T0, "Allowlist: unbound, unadmitted");
    }

    // --- setting the rule ------------------------------------------------------------

    /// `Allowlist` stores the rule with an empty salt and hash, over no row and over a stored
    /// salt and hash, which it clears; `effective_rule` reads the stored row as `Allowlist`,
    /// and the rule is in force.
    ///
    /// kills: a stored salt or hash kept; a stored `Allowlist` row read as another rule.
    #[test]
    fn allowlist_is_stored_with_an_empty_salt_and_hash() {
        let fx = fixture();
        let a = tables(&fx);
        seed_owner(&a.w, owner());
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Allowlist, Vec::new(), T0),
            Ok(())
        );
        assert_eq!(access_row(&a.w), enc(&allowlist_row()), "over no row");
        let rows = a.w.access.rows();
        assert_eq!(effective_rule(rows.first()), WorldAccessRule::Allowlist);
        assert_refused(&fx, &a, id(0x7F), T0 + 1, "the rule is in force");

        assert_eq!(a.w.access.remove(0), 1);
        a.w.access.seed(&password_row());
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Allowlist, Vec::new(), T0 + 2),
            Ok(())
        );
        assert_eq!(
            access_row(&a.w),
            enc(&allowlist_row()),
            "the stored salt and hash are cleared"
        );
    }

    /// `Open` (no row, or an `Open` row) to `Allowlist` admits every identity with a live
    /// session at the call's time, once each, and not the owner.
    ///
    /// kills: the live sessions admitted only on `Open` to `Password`; an identity with two
    /// sockets given two rows; the owner given a row.
    #[test]
    fn open_to_allowlist_admits_every_live_session_but_the_owner() {
        for stored in [None, Some(open_row())] {
            let fx = fixture();
            let a = tables(&fx);
            seed_owner(&a.w, owner());
            if let Some(row) = &stored {
                a.w.access.seed(row);
            }
            let p = id(0x80);
            let q = id(0x81);
            a.w.session.seed(&session_row(p, 0x0801));
            a.w.session.seed(&session_row(q, 0x0811));
            a.w.session.seed(&session_row(p, 0x0802));
            a.w.session.seed(&session_row(owner(), 0x0821));
            assert_eq!(
                set_access(&fx, owner(), WorldAccessRule::Allowlist, Vec::new(), T0),
                Ok(()),
                "over {:?}",
                stored.as_ref().map(|r| r.rule)
            );
            assert_eq!(
                admissions(&a.w),
                sorted(vec![(p.to_byte_array(), T0), (q.to_byte_array(), T0)])
            );
            assert_eq!(access_row(&a.w), enc(&allowlist_row()));
            assert_eq!(passes(&fx, p, T0 + 1), Ok(()));
            assert_eq!(passes(&fx, q, T0 + 1), Ok(()));
            assert_eq!(
                passes(&fx, id(0x82), T0 + 1),
                Err(REJECT_NOT_ADMITTED.to_string())
            );
        }
    }

    /// `Password` to `Allowlist`: a live identity holding an admission row keeps exactly that
    /// row, a live identity holding none (its row removed while its connection stayed open)
    /// gets none and is refused under `Allowlist` at its next check, an admission of an
    /// identity with no connection stays, and the live owner gets no row.
    ///
    /// kills: every live session admitted on a rule change (a removed identity still
    /// connected let back in); an existing admission re-stamped or dropped; the owner given a
    /// row.
    #[test]
    fn password_to_allowlist_keeps_live_admissions_and_admits_no_live_identity_without_one() {
        let fx = fixture();
        let a = tables(&fx);
        seed_owner(&a.w, owner());
        a.w.access.seed(&password_row());
        let x = id(0x83);
        let y = id(0x84);
        let z = id(0x85);
        a.w.admission.seed(&admission_row(x, T0 - 30));
        a.w.admission.seed(&admission_row(z, T0 - 40));
        a.w.session.seed(&session_row(x, 0x0831));
        a.w.session.seed(&session_row(y, 0x0841));
        a.w.session.seed(&session_row(owner(), 0x0851));
        assert_eq!(
            passes(&fx, y, T0 - 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "fixture: the rule in force refuses the live identity with no row"
        );
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Allowlist, Vec::new(), T0),
            Ok(())
        );
        assert_eq!(
            admissions(&a.w),
            sorted(vec![
                (x.to_byte_array(), T0 - 30),
                (z.to_byte_array(), T0 - 40),
            ]),
            "x keeps its row unchanged; y and the owner get none"
        );
        assert_eq!(access_row(&a.w), enc(&allowlist_row()));
        assert_eq!(passes(&fx, x, T0 + 1), Ok(()), "x is admitted by its row");
        assert_refused(
            &fx,
            &a,
            y,
            T0 + 1,
            "a live identity the password rule refused",
        );
    }

    /// `Allowlist` to `Password`: of the live identities with no admission row only the one
    /// the list admitted (bound under a key the build holds to a listed account) gets a row;
    /// one bound to an account that is not listed (delisted while connected) and one with no
    /// binding get none and are refused under `Password`; a live unbound identity holding a
    /// row keeps it; the live owner gets none.
    ///
    /// kills: every live session admitted on a rule change (a delisted or never-admitted
    /// identity still connected let in); the identity the list admitted left without a row
    /// (locked out of the world it is in); an existing admission re-stamped; the owner given a
    /// row.
    #[test]
    fn allowlist_to_password_admits_only_live_identities_the_list_admitted() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE]);
        let listed = id(0x86);
        let delisted = id(0x90);
        let seen = id(0x91);
        let fresh = id(0x92);
        bind(&a, listed, ALICE);
        bind(&a, delisted, CAROL);
        a.w.admission.seed(&admission_row(seen, T0 - 12));
        a.w.session.seed(&session_row(listed, 0x0861));
        a.w.session.seed(&session_row(owner(), 0x0862));
        a.w.session.seed(&session_row(delisted, 0x0901));
        a.w.session.seed(&session_row(seen, 0x0911));
        a.w.session.seed(&session_row(fresh, 0x0921));
        assert_eq!(
            passes(&fx, listed, T0 - 1),
            Ok(()),
            "fixture: the list admits the identity bound to a listed account"
        );
        for (who, case) in [(delisted, "delisted"), (fresh, "unbound, never admitted")] {
            assert_eq!(
                passes(&fx, who, T0 - 1),
                Err(REJECT_NOT_ADMITTED.to_string()),
                "fixture: the list refuses the live identity {case}"
            );
        }
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Password, Vec::new(), T0 + 1),
            Ok(())
        );
        assert_eq!(
            admissions(&a.w),
            sorted(vec![
                (listed.to_byte_array(), T0 + 1),
                (seen.to_byte_array(), T0 - 12),
            ]),
            "only the identity the list admitted gets a row; the held row stays unchanged"
        );
        assert_eq!(passes(&fx, listed, T0 + 2), Ok(()), "listed: admitted");
        assert_eq!(
            passes(&fx, seen, T0 + 2),
            Ok(()),
            "seen: admitted by its row"
        );
        assert_refused(&fx, &a, delisted, T0 + 2, "delisted while connected");
        assert_refused(&fx, &a, fresh, T0 + 2, "unbound, never admitted");
        let rows = a.w.access.rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].rule, WorldAccessRule::Password);
    }

    /// Setting `Allowlist` again, and leaving it for `Open`, admits no live session; the
    /// admissions already held stay.
    ///
    /// kills: every call that stores a non-`Open` rule admitting the live sessions (setting
    /// the same rule again would let every connection the list refused in).
    #[test]
    fn allowlist_again_or_to_open_admits_no_live_session() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        let s = id(0x88);
        let x = id(0x89);
        a.w.session.seed(&session_row(s, 0x0881));
        a.w.admission.seed(&admission_row(x, T0 - 9));
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Allowlist, Vec::new(), T0),
            Ok(())
        );
        assert_eq!(admissions(&a.w), vec![(x.to_byte_array(), T0 - 9)]);
        assert_eq!(fx.writes_to("world_admission"), 0);
        assert_eq!(access_row(&a.w), enc(&allowlist_row()));
        assert_eq!(passes(&fx, s, T0 + 1), Err(REJECT_NOT_ADMITTED.to_string()));
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Open, Vec::new(), T0 + 2),
            Ok(())
        );
        assert_eq!(admissions(&a.w), vec![(x.to_byte_array(), T0 - 9)]);
        assert_eq!(fx.writes_to("world_admission"), 0);
        assert_eq!(access_row(&a.w), enc(&open_row()));
    }

    /// The admit list admits under `Allowlist` as under the other rules; the row admits an
    /// unbound identity and not one bound to an unlisted account.
    ///
    /// kills: the admit list dropped under `Allowlist`.
    #[test]
    fn the_admit_list_admits_under_allowlist() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE]);
        let x = id(0x8A);
        let y = id(0x8B);
        bind(&a, y, CAROL);
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Allowlist, vec![x, y], T0),
            Ok(())
        );
        assert_eq!(
            admissions(&a.w),
            sorted(vec![(x.to_byte_array(), T0), (y.to_byte_array(), T0)])
        );
        assert_admitted(&fx, &a, x, T0 + 1, "unbound, on the admit list");
        assert_refused(
            &fx,
            &a,
            y,
            T0 + 1,
            "bound to an unlisted account, on the admit list",
        );
    }

    /// kills: the owner check skipped for `Allowlist`.
    #[test]
    fn a_non_owner_cannot_set_the_allowlist_rule() {
        let fx = fixture();
        let a = tables(&fx);
        seed_owner(&a.w, owner());
        a.w.access.seed(&open_row());
        enlist(&a, &[ALICE]);
        let stranger = id(0x8D);
        let listed = id(0x8E);
        bind(&a, listed, ALICE);
        a.w.admission.seed(&admission_row(listed, T0 - 1));
        let before = footprint_all(&fx, &a);
        for caller in [stranger, listed] {
            assert_eq!(
                set_access(&fx, caller, WorldAccessRule::Allowlist, vec![caller], T0),
                Err(REJECT_NOT_WORLD_OWNER.to_string()),
                "set_world_access by {}",
                caller.to_hex()
            );
        }
        assert_eq!(footprint_all(&fx, &a), before, "nothing is written");
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Allowlist, Vec::new(), T0 + 1),
            Ok(())
        );
        assert_refused(
            &fx,
            &a,
            stranger,
            T0 + 2,
            "the stranger under the owner's rule",
        );
        assert_admitted(&fx, &a, listed, T0 + 2, "bound and listed");
    }
}

// =====================================================================================
// A switch to `Allowlist` lists the account of every trusted binding the rule in force
// admitted, keeps every account already listed, and stays within the list's bound; leaving
// `Allowlist` keeps the list and reads it no more.
// =====================================================================================

mod allowlist_seed {
    use super::*;
    use crate::account_checks::WorldAccount;
    use crate::schema::{WorldAllowlist, WorldBinding};
    use crate::world_binding::{
        set_world_allowlist, MAX_ALLOWLIST_ACCOUNTS, REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS,
    };

    const ALPHA: &str = "k1.seed-alpha";
    const BRAVO: &str = "k1.seed-bravo";
    const CHARLIE: &str = "k1.seed-charlie";
    const DELTA: &str = "k1.seed-delta";
    const KEPT: &str = "k1.seed-kept";
    const HOST: &str = "k1.seed-host";

    /// The access tables of [`world`] plus `world_account` (read by `identity` and scanned;
    /// not writable, so a write to it aborts the test) and `world_allowlist` (read by handle,
    /// scanned and written).
    struct S<'a> {
        w: W<'a>,
        accounts: Handle<'a, WorldAccount>,
        list: Handle<'a, WorldAllowlist, String>,
    }

    fn tables(fx: &Fixture) -> S<'_> {
        S {
            w: world(fx),
            accounts: fx
                .table::<WorldAccount>("world_account", "identity", |r| r.identity)
                .unique()
                .scannable(),
            list: fx
                .table_keyed::<WorldAllowlist, String>("world_allowlist", "account_subject", |r| {
                    r.account_subject.clone()
                })
                .unique()
                .writable()
                .scannable(),
        }
    }

    /// A world owned by [`owner`] whose stored rule row is `stored` (`None`: no row).
    fn owned(fx: &Fixture, stored: Option<WorldAccess>) -> S<'_> {
        let s = tables(fx);
        seed_owner(&s.w, owner());
        if let Some(row) = stored {
            s.w.access.seed(&row);
        }
        s
    }

    fn allowlist_row() -> WorldAccess {
        WorldAccess {
            id: 0,
            rule: WorldAccessRule::Allowlist,
            password_salt: Vec::new(),
            password_hash: Vec::new(),
        }
    }

    /// `who` holds a checked account under `handle` that says `entitled`, checked too recently
    /// for a connection to arm a re-check.
    fn check_in(s: &S<'_>, who: Identity, handle: &str, entitled: bool) {
        s.accounts.seed(&WorldAccount {
            handle: handle.to_string(),
            identity: who,
            entitled,
            checked_at_ms: T0 - 100,
            is_host: false,
        });
    }

    /// `who` holds an entitled checked account under `handle`.
    fn bind(s: &S<'_>, who: Identity, handle: &str) {
        check_in(s, who, handle, true);
    }

    fn enlist(s: &S<'_>, subjects: &[&str]) {
        for subject in subjects {
            s.list.seed(&WorldAllowlist {
                account_subject: (*subject).to_string(),
            });
        }
    }

    /// The listed accounts, sorted.
    fn listed(s: &S<'_>) -> Vec<String> {
        let mut out: Vec<String> = s
            .list
            .rows()
            .into_iter()
            .map(|r| r.account_subject)
            .collect();
        out.sort();
        out
    }

    /// `xs` as owned strings, sorted.
    fn accounts(xs: &[&str]) -> Vec<String> {
        let mut out: Vec<String> = xs.iter().map(|x| (*x).to_string()).collect();
        out.sort();
        out
    }

    /// Admission rows as [`admissions`] reports them.
    fn pairs(rows: &[(Identity, i64)]) -> Vec<([u8; 32], i64)> {
        let mut out: Vec<([u8; 32], i64)> = rows
            .iter()
            .map(|(who, ms)| (who.to_byte_array(), *ms))
            .collect();
        out.sort_unstable();
        out
    }

    /// Identity `n` of a generated crowd: bytes 0 and 1 carry `n` and every other byte is
    /// 0x5A, so it is never all zeros, the owner or the module identity.
    fn crowd(n: usize) -> Identity {
        let mut bytes = [0x5A; 32];
        let [hi, lo] = u16::try_from(n)
            .expect("a crowd index fits a u16")
            .to_be_bytes();
        bytes[0] = hi;
        bytes[1] = lo;
        Identity::from_byte_array(bytes)
    }

    /// Account `n` of a generated crowd; zero-padded, so byte order is numeric order.
    fn acct(n: usize) -> String {
        format!("dev:crowd-{n:04}")
    }

    fn sorted_accts(range: impl Iterator<Item = usize>) -> Vec<String> {
        let mut out: Vec<String> = range.map(acct).collect();
        out.sort();
        out
    }

    /// Every stored row of every registered table, with each table's write count.
    fn footprint_all(fx: &Fixture, s: &S<'_>) -> Vec<(&'static str, Vec<Vec<u8>>, u32)> {
        let mut out = footprint(fx, &s.w);
        out.push((
            "world_account",
            encs(&s.accounts.rows()),
            fx.writes_to("world_account"),
        ));
        out.push((
            "world_allowlist",
            encs(&s.list.rows()),
            fx.writes_to("world_allowlist"),
        ));
        out
    }

    /// The owner switches the world to `Allowlist`, admitting `admit`.
    fn to_allowlist(fx: &Fixture, admit: Vec<Identity>, ms: i64) -> Result<(), String> {
        set_access(fx, owner(), WorldAccessRule::Allowlist, admit, ms)
    }

    /// The owner's `set_world_allowlist`.
    fn set_list(fx: &Fixture, list: &[&str], ms: i64) -> Result<(), String> {
        let named: Vec<String> = list.iter().map(|x| (*x).to_string()).collect();
        call(fx, owner(), ms, |ctx| set_world_allowlist(ctx, named))
    }

    // --- what the switch lists -------------------------------------------------------

    /// From no rule row and from a stored `Open` row, the switch to `Allowlist` lists the
    /// handle of every checked account (connected, admitted, or neither; the owner's too),
    /// each once, and keeps every handle listed before; the rule row is `Allowlist`, and the
    /// live identity gets the carry-over's admission row.
    ///
    /// kills: no seed; a seed that replaces the kept list; a seed of the live sessions only; a
    /// seed of the admission rows only; the owner's handle left out; a handle already listed
    /// inserted again.
    #[test]
    fn open_to_allowlist_lists_every_checked_handle_and_keeps_the_list_lpw21_1() {
        for stored in [None, Some(open_row())] {
            let fx = fixture();
            let label = format!("over {:?}", stored.as_ref().map(|r| r.rule));
            let s = owned(&fx, stored);
            let live = id(0xB1);
            let seen = id(0xB2);
            let quiet = id(0xB3);
            bind(&s, live, ALPHA);
            bind(&s, seen, BRAVO);
            bind(&s, quiet, CHARLIE);
            bind(&s, owner(), HOST);
            s.w.session.seed(&session_row(live, 0x0B11));
            s.w.admission.seed(&admission_row(seen, T0 - 20));
            enlist(&s, &[KEPT, ALPHA]);
            assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()), "{label}");
            assert_eq!(
                listed(&s),
                accounts(&[ALPHA, BRAVO, CHARLIE, HOST, KEPT]),
                "{label}: every checked handle, once, and the kept list"
            );
            assert_eq!(access_row(&s.w), enc(&allowlist_row()), "{label}");
            assert_eq!(
                admissions(&s.w),
                pairs(&[(live, T0), (seen, T0 - 20)]),
                "{label}: the live identity is carried over; the held row stays"
            );
            assert_eq!(
                fx.writes_to("world_account"),
                0,
                "{label}: no account row is written"
            );
        }
    }

    /// From `Password`, the switch lists the handles of the checked accounts whose identity
    /// holds an admission row, and the owner's (the owner holds none); not that of an
    /// identity with no admission row, connected or not; an admitted identity with no
    /// account row adds nothing.
    ///
    /// kills: every handle seeded whatever the rule; the owner's handle left out under
    /// `Password`; a live session read as admitted.
    #[test]
    fn password_to_allowlist_lists_the_admitted_identities_accounts_and_the_owners_lpw21_1() {
        let fx = fixture();
        let s = owned(&fx, Some(password_row()));
        let admitted = id(0xB6);
        let live_refused = id(0xB7);
        let quiet_refused = id(0xB8);
        let stale = id(0xB9);
        let unbound = id(0xBA);
        bind(&s, admitted, ALPHA);
        bind(&s, live_refused, BRAVO);
        bind(&s, quiet_refused, CHARLIE);
        bind(&s, owner(), HOST);
        s.w.admission.seed(&admission_row(admitted, T0 - 30));
        s.w.admission.seed(&admission_row(stale, T0 - 31));
        s.w.admission.seed(&admission_row(unbound, T0 - 32));
        s.w.session.seed(&session_row(live_refused, 0x0B71));
        enlist(&s, &[KEPT]);
        assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()));
        assert_eq!(listed(&s), accounts(&[ALPHA, HOST, KEPT]));
        assert_eq!(
            admissions(&s.w),
            pairs(&[(admitted, T0 - 30), (stale, T0 - 31), (unbound, T0 - 32)]),
            "the live identity the password rule refused gets no row"
        );
        assert_eq!(passes(&fx, admitted, T0 + 1), Ok(()));
        assert_eq!(
            passes(&fx, quiet_refused, T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
    }

    /// The owner's own checked handle is listed by the switch from no row, from `Open` and
    /// from `Password`, with no admission row and no session.
    ///
    /// kills: the owner's account read through the admission table (it holds no row); the
    /// owner skipped as it is skipped by the carry-over.
    #[test]
    fn the_owners_checked_handle_is_seeded_from_every_rule_lpw21_1() {
        for stored in [None, Some(open_row()), Some(password_row())] {
            let fx = fixture();
            let label = format!("over {:?}", stored.as_ref().map(|r| r.rule));
            let s = owned(&fx, stored);
            bind(&s, owner(), HOST);
            assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()), "{label}");
            assert_eq!(listed(&s), accounts(&[HOST]), "{label}");
            assert!(s.w.admission.rows().is_empty(), "{label}: no admission row");
        }
    }

    /// After the switch from `Open`, identities whose accounts the switch listed (with no
    /// session at the switch) pass the admission check and connect with no admission row of
    /// their own; an identity bound afterwards to an account that is not listed, and a
    /// stranger, are refused.
    ///
    /// kills: the seeded accounts not written (the seeded identities locked out); the seed
    /// written as admission rows instead of list rows.
    #[test]
    fn after_the_seeded_switch_a_seeded_identity_passes_with_no_admission_row_lpw21_1() {
        let fx = fixture();
        let s = owned(&fx, None);
        let p = id(0xBD);
        let q = id(0xBE);
        bind(&s, p, ALPHA);
        bind(&s, q, BRAVO);
        assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()));
        assert!(s.w.admission.rows().is_empty(), "nobody was connected");
        for who in [p, q] {
            assert_eq!(passes(&fx, who, T0 + 1), Ok(()), "{}", who.to_hex());
            assert!(call(&fx, who, T0 + 1, |ctx| is_admitted(ctx, who)));
            assert_eq!(call(&fx, who, T0 + 1, crate::on_connect), Ok(()));
        }
        assert!(
            s.w.admission.rows().is_empty(),
            "admitted by the list alone"
        );
        let late = id(0xBF);
        bind(&s, late, DELTA);
        assert_eq!(
            passes(&fx, late, T0 + 2),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "bound to an account that is not listed"
        );
        assert_eq!(
            call(&fx, late, T0 + 2, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        assert_eq!(
            passes(&fx, id(0xC0), T0 + 2),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "a stranger"
        );
    }

    /// `Allowlist` set while `Allowlist` is in force seeds nothing: after the seeding switch
    /// from `Open`, with a joiner checked in under a handle that is not listed (the row the
    /// owner's relayed check makes under `Allowlist`), the second call leaves the list as it
    /// stands, writes no list row and hands out no account row.
    ///
    /// The list alone cannot show a seed here: under `Allowlist` the rule admits the owner,
    /// whose handle the list holds, and identities whose handle the list holds, so a seed
    /// would add nothing. The account rows left unread show that no seed ran.
    ///
    /// kills: a seed on every call that sets `Allowlist`; the list rewritten by an unchanged
    /// rule.
    #[test]
    fn allowlist_over_allowlist_adds_nothing_to_the_list_lpw21_1() {
        let fx = fixture();
        let s = owned(&fx, None);
        bind(&s, id(0xC1), ALPHA);
        bind(&s, owner(), HOST);
        assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()));
        assert_eq!(listed(&s), accounts(&[ALPHA, HOST]), "the first switch");
        let joiner = id(0xC2);
        bind(&s, joiner, BRAVO);
        assert_eq!(
            passes(&fx, joiner, T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "fixture: the joiner's account is not listed"
        );
        fx.reset_writes();
        fx.reset_reads();
        assert_eq!(to_allowlist(&fx, Vec::new(), T0 + 2), Ok(()));
        assert_eq!(listed(&s), accounts(&[ALPHA, HOST]), "nothing is added");
        assert_eq!(
            fx.writes_to("world_allowlist"),
            0,
            "the list is not written"
        );
        assert_eq!(
            fx.rows_read("world_account"),
            0,
            "no account row is handed out"
        );
    }

    /// A checked account that does not own the game is seeded as an entitled one is, from no
    /// row, from `Open` and from `Password` (its identity holding an admission row), and its
    /// identity passes the admission check after the switch: entitlement decides
    /// `join_game`, not admission.
    ///
    /// kills: the seed filtered on `entitled`.
    #[test]
    fn an_unentitled_account_is_seeded_as_an_entitled_one_is_lpw21_1() {
        for stored in [None, Some(open_row()), Some(password_row())] {
            let fx = fixture();
            let label = format!("over {:?}", stored.as_ref().map(|r| r.rule));
            let s = owned(&fx, stored);
            let plain = id(0xE1);
            let entitled = id(0xE2);
            check_in(&s, plain, BRAVO, false);
            bind(&s, entitled, ALPHA);
            s.w.admission.seed(&admission_row(plain, T0 - 6));
            s.w.admission.seed(&admission_row(entitled, T0 - 6));
            assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()), "{label}");
            assert_eq!(
                listed(&s),
                accounts(&[ALPHA, BRAVO]),
                "{label}: the unentitled account's handle is listed"
            );
            assert_eq!(
                passes(&fx, plain, T0 + 1),
                Ok(()),
                "{label}: the unentitled identity is admitted by the list"
            );
        }
    }

    /// A kept account and a bound account that differ only by case, or where one is a strict
    /// prefix of the other, are different accounts: the switch from `Open` keeps each listed
    /// spelling, lists each bound one beside it, and the identities bound to the new
    /// spellings pass the admission check.
    ///
    /// kills: the seed compared with the kept list without case, or by prefix (a bound
    /// account taken as listed and never stored, its identity locked out).
    #[test]
    fn a_seed_spelled_apart_from_a_kept_account_is_listed_beside_it_lpw21_1() {
        let fx = fixture();
        let s = owned(&fx, None);
        enlist(&s, &["dev:SEED-CASE", "dev:seed-prefix1"]);
        let cased = id(0xE4);
        let short = id(0xE5);
        bind(&s, cased, "dev:seed-case");
        bind(&s, short, "dev:seed-prefix");
        assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()));
        assert_eq!(
            listed(&s),
            accounts(&[
                "dev:SEED-CASE",
                "dev:seed-case",
                "dev:seed-prefix",
                "dev:seed-prefix1"
            ])
        );
        assert_eq!(
            passes(&fx, cased, T0 + 1),
            Ok(()),
            "the other-case spelling"
        );
        assert_eq!(passes(&fx, short, T0 + 1), Ok(()), "the shorter spelling");
    }

    /// The `admit` argument plays no part in the seed: from `Password`, a bound identity
    /// named there with no admission row of its own gets its row and its account is not
    /// listed (so the list refuses it), while an identity holding an admission row is listed.
    ///
    /// kills: the admitted set computed after the `admit` rows are written; the `admit`
    /// argument added to the seed.
    #[test]
    fn the_admit_argument_seeds_nothing_lpw21_1() {
        let fx = fixture();
        let s = owned(&fx, Some(password_row()));
        let named = id(0xC3);
        let held = id(0xC4);
        bind(&s, named, ALPHA);
        bind(&s, held, BRAVO);
        s.w.admission.seed(&admission_row(held, T0 - 40));
        assert_eq!(to_allowlist(&fx, vec![named], T0), Ok(()));
        assert_eq!(listed(&s), accounts(&[BRAVO]));
        assert_eq!(
            admissions(&s.w),
            pairs(&[(named, T0), (held, T0 - 40)]),
            "the named identity gets its admission row"
        );
        assert_eq!(
            passes(&fx, named, T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "bound to an unlisted account: the list alone governs it"
        );
        assert_eq!(passes(&fx, held, T0 + 1), Ok(()));
    }

    // --- the bound -------------------------------------------------------------------

    /// A seed of 257 distinct accounts from no row and from a stored `Open` row is refused
    /// with the too-many error and writes nothing: not the rule row, not the carry-over for
    /// two live sessions, not the `admit` argument's row, not a list row.
    ///
    /// kills: no bound; the bound checked after the rule row or an admission is written; a
    /// seed trimmed to fit.
    #[test]
    fn a_seed_of_257_accounts_is_refused_with_no_write_lpw21_2() {
        for stored in [None, Some(open_row())] {
            let fx = fixture();
            let label = format!("over {:?}", stored.as_ref().map(|r| r.rule));
            let s = owned(&fx, stored);
            for n in 0..=MAX_ALLOWLIST_ACCOUNTS {
                bind(&s, crowd(n), &acct(n));
            }
            s.w.session.seed(&session_row(crowd(0), 0x0C01));
            s.w.session.seed(&session_row(crowd(1), 0x0C02));
            let named = id(0xC5);
            fx.reset_writes();
            let before = footprint_all(&fx, &s);
            assert_eq!(
                to_allowlist(&fx, vec![named], T0),
                Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS.to_string()),
                "{label}"
            );
            assert_eq!(
                footprint_all(&fx, &s),
                before,
                "{label}: every table as it was, and no write call"
            );
        }
    }

    /// A seed of exactly 256 distinct accounts is accepted and lists every one.
    ///
    /// kills: a bound off by one (256 refused); a seed trimmed.
    #[test]
    fn a_seed_of_exactly_256_accounts_is_accepted_and_lists_every_one_lpw21_2() {
        let fx = fixture();
        let s = owned(&fx, None);
        for n in 0..MAX_ALLOWLIST_ACCOUNTS {
            bind(&s, crowd(n), &acct(n));
        }
        assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()));
        assert_eq!(listed(&s), sorted_accts(0..MAX_ALLOWLIST_ACCOUNTS));
        assert_eq!(access_row(&s.w), enc(&allowlist_row()));
    }

    /// The bound counts the union of the kept list and the seed: a kept list of 200 and a
    /// seed of 56 new handles and 10 already listed is accepted (256 distinct); the same with
    /// 57 new handles is refused with no write.
    ///
    /// kills: the kept list plus every account row counted (overlaps counted twice: the 256
    /// case refused); the seed alone counted (the 257 case accepted); the kept list replaced
    /// by the seed.
    #[test]
    fn the_bound_counts_the_kept_list_and_the_seed_once_each_lpw21_2() {
        for (new, accepted) in [(56usize, true), (57, false)] {
            let fx = fixture();
            let s = owned(&fx, None);
            for n in 0..200 {
                s.list.seed(&WorldAllowlist {
                    account_subject: acct(n),
                });
            }
            let mut seed: Vec<String> = (200..200 + new).map(acct).collect();
            seed.extend((0..10).map(acct));
            for (n, subject) in seed.iter().enumerate() {
                bind(&s, crowd(n), subject);
            }
            if accepted {
                assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()), "{new} new");
                assert_eq!(listed(&s), sorted_accts(0..256), "{new} new");
            } else {
                fx.reset_writes();
                let before = footprint_all(&fx, &s);
                assert_eq!(
                    to_allowlist(&fx, Vec::new(), T0),
                    Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS.to_string()),
                    "{new} new"
                );
                assert_eq!(footprint_all(&fx, &s), before, "{new} new: no write");
            }
        }
    }

    /// From `Password` the bound counts only the accounts the rule admitted: of 300 trusted
    /// bindings three identities hold an admission row; with the owner bound, the switch is
    /// accepted and lists those three, the owner's and the kept account.
    ///
    /// kills: the bound counted on every binding whatever the rule (300 refused); every
    /// binding seeded.
    #[test]
    fn from_password_the_bound_counts_only_the_admitted_identities_accounts_lpw21_2() {
        let fx = fixture();
        let s = owned(&fx, Some(password_row()));
        for n in 0..300 {
            bind(&s, crowd(n), &acct(n));
        }
        for n in [7, 150, 299] {
            s.w.admission.seed(&admission_row(crowd(n), T0 - 5));
        }
        bind(&s, owner(), HOST);
        enlist(&s, &[KEPT]);
        assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()));
        let mut want: Vec<String> = [7, 150, 299].into_iter().map(acct).collect();
        want.extend([HOST.to_string(), KEPT.to_string()]);
        want.sort();
        assert_eq!(listed(&s), want);
    }

    /// From `Password` the bound counts the kept list and the accounts the rule admitted,
    /// the owner's among them. A kept list of 250, the owner's account and five admitted
    /// identities' accounts (256) is accepted and lists them all; with a sixth admitted
    /// identity (257) the switch is refused with the too-many error and no write call: the
    /// `Password` row byte for byte as stored, no admission row for the live admitted
    /// identity or for the `admit` argument, that identity's wrong-password record kept, no
    /// list row. Twenty bound identities with no admission row count for nothing.
    ///
    /// kills: the seed from `Password` written with no bound; the bound checked after the
    /// rule row, an admission or a list row is written; the owner's account left out of the
    /// count (257 accepted); the unadmitted bindings counted (256 refused).
    #[test]
    fn from_password_a_seed_past_256_is_refused_with_no_write_lpw21_2() {
        for (admitted, accepted) in [(5usize, true), (6, false)] {
            let fx = fixture();
            let s = owned(&fx, Some(password_row()));
            for n in 0..250 {
                s.list.seed(&WorldAllowlist {
                    account_subject: acct(n),
                });
            }
            bind(&s, owner(), HOST);
            for n in 300..300 + admitted {
                bind(&s, crowd(n), &acct(n));
                s.w.admission.seed(&admission_row(crowd(n), T0 - 5));
            }
            for n in 400..420 {
                bind(&s, crowd(n), &acct(n));
            }
            s.w.session.seed(&session_row(crowd(300), 0x0D01));
            s.w.session.seed(&session_row(crowd(400), 0x0D02));
            let named = id(0xE3);
            s.w.attempt.seed(&attempt_row(named, &[T0 - 10]));
            if accepted {
                assert_eq!(
                    to_allowlist(&fx, vec![named], T0),
                    Ok(()),
                    "{admitted} admitted"
                );
                let mut want = sorted_accts((0..250).chain(300..300 + admitted));
                want.push(HOST.to_string());
                want.sort();
                assert_eq!(want.len(), MAX_ALLOWLIST_ACCOUNTS, "fixture: exactly 256");
                assert_eq!(listed(&s), want, "{admitted} admitted");
            } else {
                fx.reset_writes();
                let before = footprint_all(&fx, &s);
                assert_eq!(
                    to_allowlist(&fx, vec![named], T0),
                    Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS.to_string()),
                    "{admitted} admitted"
                );
                assert_eq!(
                    footprint_all(&fx, &s),
                    before,
                    "{admitted} admitted: every table as it was, and no write call"
                );
                assert_eq!(access_row(&s.w), enc(&password_row()), "the rule row");
            }
        }
    }

    // --- leaving the rule --------------------------------------------------------------

    /// A seeded `Allowlist` world switched to `Open` admits as `Open` does: a stranger with
    /// no binding, an identity bound to an account that is not listed, and one whose account
    /// is listed; the list stays exactly as the switch left it, unwritten; no admission check
    /// hands out a list row, even for the identity whose bound account is a stored row.
    ///
    /// kills: the list cleared or rewritten on leaving `Allowlist`; `Open` that reads the
    /// list; the list governing under `Open`.
    #[test]
    fn a_seeded_allowlist_switched_to_open_admits_as_open_and_reads_no_list_row_lpw21_5() {
        let fx = fixture();
        let s = owned(&fx, None);
        let p = id(0xC6);
        let q = id(0xC7);
        bind(&s, p, ALPHA);
        bind(&s, q, BRAVO);
        assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()));
        assert_eq!(listed(&s), accounts(&[ALPHA, BRAVO]), "the seeded list");
        let late = id(0xC8);
        let stranger = id(0xC9);
        bind(&s, late, DELTA);
        assert_eq!(
            passes(&fx, late, T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "control: refused under Allowlist"
        );
        fx.reset_writes();
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Open, Vec::new(), T0 + 2),
            Ok(())
        );
        assert_eq!(access_row(&s.w), enc(&open_row()));
        assert_eq!(listed(&s), accounts(&[ALPHA, BRAVO]), "the list is kept");
        assert_eq!(
            fx.writes_to("world_allowlist"),
            0,
            "the list is not written"
        );
        for (who, case) in [
            (stranger, "a stranger"),
            (late, "bound to an unlisted account"),
            (p, "bound to a listed account"),
        ] {
            fx.reset_reads();
            assert_eq!(passes(&fx, who, T0 + 3), Ok(()), "{case}");
            assert!(
                call(&fx, who, T0 + 3, |ctx| is_admitted(ctx, who)),
                "{case}"
            );
            assert_eq!(call(&fx, who, T0 + 3, crate::on_connect), Ok(()), "{case}");
            assert_eq!(
                fx.rows_read("world_allowlist"),
                0,
                "{case}: no list row is handed out"
            );
        }
    }

    /// A seeded `Allowlist` world switched to `Password` admits as `Password` does: the owner
    /// and an identity holding an admission row pass, an identity whose bound account is
    /// listed and that holds no admission row is refused, the list stays as the switch left
    /// it, and no check hands out a list row.
    ///
    /// kills: the list read under `Password` (a listed identity let in); the list cleared on
    /// leaving `Allowlist`.
    #[test]
    fn a_seeded_allowlist_switched_to_password_admits_as_password_and_reads_no_list_row_lpw21_5() {
        let fx = fixture();
        let s = owned(&fx, None);
        let p = id(0xCA);
        let q = id(0xCB);
        bind(&s, p, ALPHA);
        bind(&s, q, BRAVO);
        bind(&s, owner(), HOST);
        assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()));
        assert_eq!(
            listed(&s),
            accounts(&[ALPHA, BRAVO, HOST]),
            "the seeded list"
        );
        s.w.admission.seed(&admission_row(p, T0 + 1));
        fx.reset_writes();
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Password, Vec::new(), T0 + 2),
            Ok(())
        );
        assert_eq!(s.w.access.rows()[0].rule, WorldAccessRule::Password);
        assert_eq!(
            listed(&s),
            accounts(&[ALPHA, BRAVO, HOST]),
            "the list is kept"
        );
        assert_eq!(
            fx.writes_to("world_allowlist"),
            0,
            "the list is not written"
        );
        for (who, want, case) in [
            (owner(), Ok(()), "the owner"),
            (p, Ok(()), "listed, with an admission row"),
            (
                q,
                Err(REJECT_NOT_ADMITTED.to_string()),
                "listed, with no admission row",
            ),
        ] {
            fx.reset_reads();
            assert_eq!(passes(&fx, who, T0 + 3), want, "{case}");
            assert_eq!(
                fx.rows_read("world_allowlist"),
                0,
                "{case}: no list row is handed out"
            );
        }
    }

    /// Back to `Allowlist` from `Open` and from `Password`, the list is the kept list and the
    /// new seed: an account the owner took off while the rule was off is listed again when
    /// the rule in force admits its identity, an account bound while the rule was off is
    /// listed, and under `Password` the account of a bound identity with no admission row is
    /// not.
    ///
    /// kills: the second switch replacing the kept list with the seed; the second switch
    /// seeding nothing (the list taken as already seeded); the seed read from the first
    /// switch's list.
    #[test]
    fn switching_back_to_allowlist_adds_the_new_seed_to_the_kept_list_lpw21_5() {
        for off in [WorldAccessRule::Open, WorldAccessRule::Password] {
            let fx = fixture();
            let s = owned(&fx, None);
            let p = id(0xCC);
            let q = id(0xCD);
            bind(&s, p, ALPHA);
            bind(&s, q, BRAVO);
            assert_eq!(to_allowlist(&fx, Vec::new(), T0), Ok(()), "{off:?}");
            assert_eq!(
                listed(&s),
                accounts(&[ALPHA, BRAVO]),
                "{off:?}: the first seed"
            );
            assert_eq!(
                set_access(&fx, owner(), off, Vec::new(), T0 + 1),
                Ok(()),
                "{off:?}"
            );
            assert_eq!(set_list(&fx, &[ALPHA], T0 + 2), Ok(()), "{off:?}");
            assert_eq!(
                listed(&s),
                accounts(&[ALPHA]),
                "{off:?}: BRAVO is taken off"
            );
            let r = id(0xCE);
            let u = id(0xCF);
            bind(&s, r, CHARLIE);
            bind(&s, u, DELTA);
            if off == WorldAccessRule::Password {
                s.w.admission.seed(&admission_row(q, T0 + 3));
                s.w.admission.seed(&admission_row(r, T0 + 3));
            }
            assert_eq!(to_allowlist(&fx, Vec::new(), T0 + 4), Ok(()), "{off:?}");
            let want = if off == WorldAccessRule::Password {
                accounts(&[ALPHA, BRAVO, CHARLIE])
            } else {
                accounts(&[ALPHA, BRAVO, CHARLIE, DELTA])
            };
            assert_eq!(listed(&s), want, "{off:?}: the kept list and the new seed");
        }
    }

    // --- the owner drops checked accounts until the seed fits --------------------------

    /// [`owned`] with no rule row, `world_account` writable as well as scannable, and the
    /// binding, nonce and re-check tables registered on their `identity` key, writable: what
    /// the owner's `drop_world_binding` reads and writes.
    fn droppable(fx: &Fixture) -> S<'_> {
        let s = owned(fx, None);
        let _ = fx
            .table::<WorldAccount>("world_account", "identity", |r| r.identity)
            .unique()
            .writable()
            .scannable();
        let _ = fx
            .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
            .unique()
            .writable();
        let _ = fx
            .table::<crate::schema::WorldBindNonce>("world_bind_nonce", "identity", |r| r.identity)
            .unique()
            .writable();
        let _ = fx
            .table::<crate::account_checks::RecheckSchedule>("recheck_schedule", "identity", |r| {
                r.identity
            })
            .unique()
            .writable();
        s
    }

    /// The owner drops `who`'s checked account.
    fn drop_bound(fx: &Fixture, who: Identity, ms: i64) -> Result<(), String> {
        call(fx, owner(), ms, |ctx| {
            crate::world_binding::drop_world_binding(ctx, who)
        })
    }

    /// The switch is refused with the too-many error, every table unchanged and no write
    /// call made.
    fn assert_switch_refused(fx: &Fixture, s: &S<'_>, ms: i64, label: &str) {
        fx.reset_writes();
        let before = footprint_all(fx, s);
        assert_eq!(
            to_allowlist(fx, Vec::new(), ms),
            Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS.to_string()),
            "{label}"
        );
        assert_eq!(
            footprint_all(fx, s),
            before,
            "{label}: every table as it was, and no write call"
        );
    }

    /// The list starts empty and 257 identities hold checked accounts under distinct
    /// handles, on an `Open` world that admits every identity. The switch to `Allowlist` is
    /// refused with no write; the owner drops one account row; the switch is then accepted
    /// and lists exactly the 256 remaining handles, the dropped one absent.
    ///
    /// kills: the inert drop (the switch stays refused); a drop that leaves the account row
    /// the seed reads.
    #[test]
    fn dropping_one_of_257_bound_accounts_lets_the_switch_seed_the_other_256_wr261127a_7() {
        let fx = fixture();
        let s = droppable(&fx);
        for n in 0..=MAX_ALLOWLIST_ACCOUNTS {
            bind(&s, crowd(n), &acct(n));
        }
        assert_eq!(
            s.accounts.rows().len(),
            257,
            "fixture: 257 checked accounts"
        );
        assert!(listed(&s).is_empty(), "fixture: the list starts empty");
        assert_switch_refused(&fx, &s, T0, "257 distinct accounts");

        assert_eq!(drop_bound(&fx, crowd(100), T0 + 1), Ok(()), "the drop");
        assert_eq!(to_allowlist(&fx, Vec::new(), T0 + 2), Ok(()), "the switch");
        let want = sorted_accts((0..=MAX_ALLOWLIST_ACCOUNTS).filter(|&n| n != 100));
        assert_eq!(want.len(), 256, "fixture: 256 remaining accounts");
        assert_eq!(listed(&s), want, "exactly the remaining accounts");
        assert!(
            !listed(&s).contains(&acct(100)),
            "the dropped account is not listed"
        );
        assert_eq!(access_row(&s.w), enc(&allowlist_row()));
    }
}

// =====================================================================================
// The owner's `Password` rule is stored with no salt and no hash, and admits only the owner
// and the identities holding an admission row.
// =====================================================================================

mod password_rule {
    use super::*;

    /// The rows a world holds when the owner sets it to `Password`: none, a stored `Open` row
    /// and a stored `Allowlist` row.
    fn prior_rows() -> [Option<WorldAccess>; 3] {
        [
            None,
            Some(open_row()),
            Some(stored_row(WorldAccessRule::Allowlist)),
        ]
    }

    /// From no row, from an `Open` row and from an `Allowlist` row, the owner's
    /// `set_world_access(Password, [])` is `Ok` and leaves exactly one row, equal byte for
    /// byte to `{0, Password, [], []}`.
    ///
    /// kills: `Password` refused for want of a stored or a new password; a salt or a hash
    /// written (random bytes, a hash of anything); a second row; a row under another id or
    /// another rule.
    #[test]
    fn the_owners_password_rule_is_stored_with_no_salt_and_no_hash_lpw20_1() {
        for prior in prior_rows() {
            let fx = fixture();
            let w = world(&fx);
            seed_owner(&w, owner());
            let label = format!("over {:?}", prior.as_ref().map(|r| r.rule));
            if let Some(row) = &prior {
                w.access.seed(row);
            }
            assert_eq!(
                set_access(&fx, owner(), WorldAccessRule::Password, Vec::new(), T0),
                Ok(()),
                "{label}"
            );
            assert_eq!(
                access_row(&w),
                enc(&stored_row(WorldAccessRule::Password)),
                "{label}: the row holds the rule alone"
            );
        }
    }

    /// On a world the owner set to `Password` from each of those rows, the owner and an
    /// identity holding a `world_admission` row pass the admission check and connect, their
    /// sessions recorded; a stranger is refused by the admission check and at connect,
    /// anonymous and signed in, with `REJECT_NOT_ADMITTED`, and no registered table changes.
    ///
    /// kills: `Password` refused (the world never closes, a stranger let in under `Open` or
    /// by the list); the owner or an admission row ignored under `Password`; a refusal placed
    /// after the session or the account is written.
    #[test]
    fn a_password_world_admits_only_the_owner_and_the_admitted_lpw20_1() {
        for prior in prior_rows() {
            let fx = fixture();
            let w = world(&fx);
            seed_owner(&w, owner());
            let label = format!("over {:?}", prior.as_ref().map(|r| r.rule));
            if let Some(row) = &prior {
                w.access.seed(row);
            }
            let let_in = id(0x93);
            let stranger = id(0x94);
            w.admission.seed(&admission_row(let_in, T0 - 5));
            assert_eq!(
                set_access(&fx, owner(), WorldAccessRule::Password, Vec::new(), T0),
                Ok(()),
                "{label}"
            );
            for who in [owner(), let_in] {
                assert_eq!(
                    passes(&fx, who, T0 + 1),
                    Ok(()),
                    "{label}: {} passes the admission check",
                    who.to_hex()
                );
                assert_eq!(
                    call(&fx, who, T0 + 1, crate::on_connect),
                    Ok(()),
                    "{label}: {} connects",
                    who.to_hex()
                );
                assert_eq!(sessions_of(&w, who), vec![conn_of(who)], "{label}");
            }
            let before = footprint(&fx, &w);
            assert_eq!(
                passes(&fx, stranger, T0 + 2),
                Err(REJECT_NOT_ADMITTED.to_string()),
                "{label}: the stranger at the admission check"
            );
            assert_eq!(
                call(&fx, stranger, T0 + 2, crate::on_connect),
                Err(REJECT_NOT_ADMITTED.to_string()),
                "{label}: the stranger's anonymous connection"
            );
            assert_eq!(
                call_signed_in(&fx, stranger, T0 + 2, crate::on_connect),
                Err(REJECT_NOT_ADMITTED.to_string()),
                "{label}: the stranger's signed-in connection"
            );
            assert!(
                sessions_of(&w, stranger).is_empty(),
                "{label}: the stranger has no session"
            );
            assert_eq!(
                footprint(&fx, &w),
                before,
                "{label}: the refusals write nothing"
            );
        }
    }
}

// =====================================================================================
// A salt and hash an earlier module stored admit nobody, and the owner's next
// `set_world_access` clears them, whatever rule it sets.
// =====================================================================================

mod legacy_password {
    use super::*;
    use crate::schema::{WorldAllowlist, WorldBinding};

    /// When [`admitted`] got its admission row.
    const ADMITTED_AT: i64 = T0 - 50;
    /// The connection [`stranger`] holds open.
    const STRANGER_CONN: u128 = 0x0960;

    /// An identity holding a `world_admission` row.
    fn admitted() -> Identity {
        id(0x95)
    }

    /// An identity with a live `player_session` row and no admission row.
    fn stranger() -> Identity {
        id(0x96)
    }

    /// A world owned by [`owner`] whose rule row is `row`, where [`admitted`] holds an
    /// admission row and [`stranger`] is connected. Registered beside [`world`]'s tables:
    /// `world_binding` (read by `identity` and scanned; not writable, so a write to it aborts
    /// the test) and `world_allowlist` (read by `account_subject`, scanned and written), which
    /// a switch to `Allowlist` reads.
    fn world_holding<'a>(fx: &'a Fixture, row: &WorldAccess) -> W<'a> {
        let w = world(fx);
        let _ = fx
            .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
            .unique()
            .scannable();
        let _ = fx
            .table_keyed::<WorldAllowlist, String>("world_allowlist", "account_subject", |r| {
                r.account_subject.clone()
            })
            .unique()
            .writable()
            .scannable();
        seed_owner(&w, owner());
        w.access.seed(row);
        w.admission.seed(&admission_row(admitted(), ADMITTED_AT));
        w.session.seed(&session_row(stranger(), STRANGER_CONN));
        w
    }

    /// [`world_holding`] a `Password` row with [`KAT_SALT`] and its Argon2id hash.
    fn legacy_world(fx: &Fixture) -> W<'_> {
        world_holding(fx, &password_row())
    }

    /// Before the owner's next call, the legacy salt and hash let nobody in: the connected
    /// stranger is refused by the admission check and at connect, anonymous and signed in,
    /// with no write; the admitted identity and the owner pass and connect.
    ///
    /// kills: an admission granted by the stored salt and hash (any identity let in while
    /// they exist); a connected stranger let in because it is connected; the owner or an
    /// admission row ignored on a world that holds a hash.
    #[test]
    fn a_legacy_salt_and_hash_admit_nobody_lpw20_2() {
        let fx = fixture();
        let w = legacy_world(&fx);
        let before = footprint(&fx, &w);
        assert_eq!(
            passes(&fx, stranger(), T0),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "the stranger at the admission check"
        );
        assert!(!call(&fx, stranger(), T0, |ctx| is_admitted(
            ctx,
            stranger()
        )));
        assert_eq!(
            call(&fx, stranger(), T0, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "the stranger's anonymous connection"
        );
        assert_eq!(
            call_signed_in(&fx, stranger(), T0, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "the stranger's signed-in connection"
        );
        assert_eq!(footprint(&fx, &w), before, "the refusals write nothing");
        for who in [admitted(), owner()] {
            assert_eq!(passes(&fx, who, T0 + 1), Ok(()), "{}", who.to_hex());
            assert_eq!(
                call(&fx, who, T0 + 1, crate::on_connect),
                Ok(()),
                "{} connects",
                who.to_hex()
            );
        }
        assert_eq!(
            access_row(&w),
            enc(&password_row()),
            "only the owner's call writes the row"
        );
    }

    /// The owner's next `set_world_access(Password, [])` on a legacy world is `Ok` and stores
    /// `{0, Password, [], []}`. The unchanged rule carries nobody over: the connected
    /// stranger holds no admission row and is still refused, and the admitted identity's row
    /// keeps its time.
    ///
    /// kills: the stored salt and hash kept when the rule does not change; the connected
    /// stranger admitted by an unchanged rule; an admission row re-stamped or dropped.
    #[test]
    fn the_owners_next_password_call_clears_a_legacy_salt_and_hash_lpw20_2() {
        let fx = fixture();
        let w = legacy_world(&fx);
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Password, Vec::new(), T0),
            Ok(())
        );
        assert_eq!(
            access_row(&w),
            enc(&stored_row(WorldAccessRule::Password)),
            "the salt and hash are gone"
        );
        assert_eq!(
            admissions(&w),
            vec![(admitted().to_byte_array(), ADMITTED_AT)],
            "the admitted identity keeps its row and its time; the stranger gets none"
        );
        assert_eq!(
            passes(&fx, stranger(), T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "the stranger at the admission check"
        );
        assert_eq!(
            call(&fx, stranger(), T0 + 1, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "the stranger's connection"
        );
        assert_eq!(passes(&fx, admitted(), T0 + 1), Ok(()));
    }

    /// The owner's next call setting `Open`, and on a fresh legacy world `Allowlist`, is `Ok`
    /// and stores `{0, <rule>, [], []}`; the admitted identity's row keeps its time and the
    /// connected stranger, whom the legacy rule refused, gets none.
    ///
    /// kills: the salt and hash kept by a change of rule; a carry-over that admits the
    /// stranger the rule in force refused.
    #[test]
    fn the_owners_next_open_or_allowlist_call_clears_a_legacy_salt_and_hash_lpw20_2() {
        for rule in [WorldAccessRule::Open, WorldAccessRule::Allowlist] {
            let fx = fixture();
            let w = legacy_world(&fx);
            assert_eq!(
                set_access(&fx, owner(), rule, Vec::new(), T0),
                Ok(()),
                "{rule:?}"
            );
            assert_eq!(
                access_row(&w),
                enc(&stored_row(rule)),
                "{rule:?}: the salt and hash are gone"
            );
            assert_eq!(
                admissions(&w),
                vec![(admitted().to_byte_array(), ADMITTED_AT)],
                "{rule:?}: the admitted identity keeps its row and its time"
            );
        }
    }

    /// An `Open` row and an `Allowlist` row forged to hold the legacy salt and hash: the
    /// owner's next call with the same rule is `Ok` and stores both empty.
    ///
    /// kills: the stored salt and hash carried forward whenever the rule does not change; a
    /// clear made only for `Password`.
    #[test]
    fn a_salt_and_hash_on_an_open_or_allowlist_row_go_at_the_owners_next_call_lpw20_2() {
        for rule in [WorldAccessRule::Open, WorldAccessRule::Allowlist] {
            let fx = fixture();
            let forged = WorldAccess {
                rule,
                ..password_row()
            };
            let w = world_holding(&fx, &forged);
            assert_eq!(
                set_access(&fx, owner(), rule, Vec::new(), T0),
                Ok(()),
                "{rule:?}"
            );
            assert_eq!(
                access_row(&w),
                enc(&stored_row(rule)),
                "{rule:?}: the salt and hash are gone"
            );
        }
    }
}

// =====================================================================================
// On a `Password` world the owner set, an identity the owner admitted outright gets in, and
// an identity never admitted is refused.
// =====================================================================================

mod admitted_outright {
    use super::*;

    /// The identity the owner names in the call that sets `Password`.
    fn first() -> Identity {
        id(0x97)
    }

    /// The identity the owner names in a later call that leaves the rule `Password`.
    fn second() -> Identity {
        id(0x98)
    }

    /// A world owned by [`owner`] with no rule row, which the owner sets to `Password` at
    /// `T0`, admitting [`first`].
    fn set_by_the_owner(fx: &Fixture) -> W<'_> {
        let w = world(fx);
        seed_owner(&w, owner());
        assert_eq!(
            set_access(fx, owner(), WorldAccessRule::Password, vec![first()], T0),
            Ok(()),
            "the owner sets Password and admits the first identity"
        );
        w
    }

    /// The identity named in the call that sets `Password` holds an admission row stamped
    /// with that call's time, passes the admission check and connects, its session recorded.
    /// One named in a later call that leaves the rule `Password` does the same, signed in
    /// and provisioned, stamped with the later call's time; the first keeps its time, nobody
    /// else holds a row, and the stored row stays `{0, Password, [], []}`.
    ///
    /// kills: `Password` refused for want of a password; the admit list ignored under
    /// `Password`, at the change or with the rule unchanged; an admission stamped with
    /// another time, or re-stamped; the owner given a row; a later call that writes a salt
    /// or a hash.
    #[test]
    fn an_identity_the_owner_admits_outright_connects_and_passes_lpw20_3() {
        let fx = fixture();
        let w = set_by_the_owner(&fx);
        assert_eq!(
            admissions(&w),
            vec![(first().to_byte_array(), T0)],
            "admitted at the call's time"
        );
        assert_eq!(passes(&fx, first(), T0 + 1), Ok(()));
        assert_eq!(call(&fx, first(), T0 + 1, crate::on_connect), Ok(()));
        assert_eq!(
            sessions_of(&w, first()),
            vec![conn_of(first())],
            "its session is recorded"
        );

        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                vec![second()],
                T0 + 10
            ),
            Ok(())
        );
        assert_eq!(
            admissions(&w),
            vec![
                (first().to_byte_array(), T0),
                (second().to_byte_array(), T0 + 10),
            ],
            "the second admitted at the later call's time; the first keeps its time"
        );
        assert_eq!(passes(&fx, second(), T0 + 11), Ok(()));
        assert_eq!(
            call_signed_in(&fx, second(), T0 + 11, crate::on_connect),
            Ok(())
        );
        assert_eq!(sessions_of(&w, second()), vec![conn_of(second())]);
        assert_eq!(
            encs(&w.account.rows()),
            encs(&[crate::accounts::new_account_row(
                second(),
                crate::accounts::ALLOWED_ISSUERS[0].to_string(),
                T0 + 11
            )]),
            "the signed-in connection is provisioned"
        );
        assert_eq!(
            access_row(&w),
            enc(&stored_row(WorldAccessRule::Password)),
            "the row stays the rule alone"
        );
    }

    /// An identity the owner never admitted is refused at connect, anonymous and signed in,
    /// with no session and no write, and by the admission check.
    ///
    /// kills: a `Password` world the owner set that lets a stranger in; a connect check placed
    /// after the session or the account is written.
    #[test]
    fn an_identity_never_admitted_is_refused_at_connect_and_by_the_admission_check_lpw20_3() {
        let fx = fixture();
        let w = set_by_the_owner(&fx);
        let never = id(0x99);
        let before = footprint(&fx, &w);
        assert_eq!(
            call(&fx, never, T0 + 1, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "an anonymous connection"
        );
        assert_eq!(
            call_signed_in(&fx, never, T0 + 1, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "a signed-in connection"
        );
        assert!(sessions_of(&w, never).is_empty(), "no session is recorded");
        assert_eq!(
            passes(&fx, never, T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "the admission check"
        );
        assert!(!call(&fx, never, T0 + 1, |ctx| is_admitted(ctx, never)));
        assert_eq!(footprint(&fx, &w), before, "the refusals write nothing");
    }
}

// =====================================================================================
// A switch to `Allowlist` seeds the list with the handles of the checked accounts the rule
// in force admitted; an attestation binding seeds nothing.
// =====================================================================================

mod handle_seeding {
    use super::*;
    use crate::account_checks::WorldAccount;
    use crate::schema::{WorldAllowlist, WorldBinding};

    const HANDLE_A: &str = "k1.AbCdEf0123456789-_";
    const HANDLE_B: &str = "k1.BbBbBb0123456789xy";
    const HANDLE_OWNER: &str = "k1.OwNeR0123456789abcd";

    fn alice() -> Identity {
        id(0x11)
    }

    fn bob() -> Identity {
        id(0x22)
    }

    fn carol() -> Identity {
        id(0x33)
    }

    struct S<'a> {
        w: W<'a>,
        accounts: Handle<'a, WorldAccount>,
        binding: Handle<'a, WorldBinding>,
        list: Handle<'a, WorldAllowlist, String>,
    }

    /// [`world`] plus the checked accounts (read on both keys and scanned for the seed), the
    /// bindings (scanned, never written) and the list (read, scanned and written).
    fn seeding_world(fx: &Fixture) -> S<'_> {
        let _ = fx
            .table_keyed::<WorldAccount, String>("world_account", "handle", |r| r.handle.clone())
            .unique();
        S {
            w: world(fx),
            accounts: fx
                .table::<WorldAccount>("world_account", "identity", |r| r.identity)
                .unique()
                .scannable(),
            binding: fx
                .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
                .unique()
                .scannable(),
            list: fx
                .table_keyed::<WorldAllowlist, String>("world_allowlist", "account_subject", |r| {
                    r.account_subject.clone()
                })
                .unique()
                .writable()
                .scannable(),
        }
    }

    fn checked(s: &S<'_>, who: Identity, handle: &str) {
        s.accounts.seed(&WorldAccount {
            handle: handle.to_string(),
            identity: who,
            entitled: true,
            checked_at_ms: T0 - 1_000,
            is_host: false,
        });
    }

    fn listed(s: &S<'_>) -> Vec<String> {
        let mut out: Vec<String> = s
            .list
            .rows()
            .into_iter()
            .map(|r| r.account_subject)
            .collect();
        out.sort();
        out
    }

    fn strings(xs: &[&str]) -> Vec<String> {
        let mut out: Vec<String> = xs.iter().map(|x| (*x).to_string()).collect();
        out.sort();
        out
    }

    /// Leaving `Open`, which admits everyone, for `Allowlist` lists every checked account's
    /// handle, the owner's included; an identity bound by attestation alone adds nothing.
    ///
    /// kills: the seed still read from bindings; the owner's handle left out.
    #[test]
    fn leaving_open_for_allowlist_lists_every_checked_handle_lpw23_7() {
        let fx = fixture();
        let s = seeding_world(&fx);
        seed_owner(&s.w, owner());
        checked(&s, alice(), HANDLE_A);
        checked(&s, bob(), HANDLE_B);
        checked(&s, owner(), HANDLE_OWNER);
        s.binding.seed(&WorldBinding {
            identity: carol(),
            account_subject: "dev:carol-8b6c7d8e".to_string(),
            bound_at_ms: T0 - 100,
            entitled: true,
            key_id: crate::accounts::DEV_ATTESTATION_KEYS[0].kid.to_string(),
        });
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Allowlist, Vec::new(), T0),
            Ok(())
        );
        assert_eq!(listed(&s), strings(&[HANDLE_A, HANDLE_B, HANDLE_OWNER]));
        assert_eq!(
            passes(&fx, alice(), T0 + 1),
            Ok(()),
            "a listed handle is admitted"
        );
        assert_eq!(
            passes(&fx, carol(), T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "a binding alone is not"
        );
    }

    /// Leaving `Password` for `Allowlist` lists the handles of the identities `Password`
    /// admitted (the owner, and an identity holding an admission row) and not the others.
    ///
    /// kills: every handle listed whatever the rule admitted.
    #[test]
    fn leaving_password_for_allowlist_lists_only_the_admitted_handles_lpw23_7() {
        let fx = fixture();
        let s = seeding_world(&fx);
        seed_owner(&s.w, owner());
        s.w.access.seed(&password_row());
        checked(&s, alice(), HANDLE_A);
        checked(&s, bob(), HANDLE_B);
        checked(&s, owner(), HANDLE_OWNER);
        s.w.admission.seed(&admission_row(alice(), T0 - 5_000));
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Allowlist, Vec::new(), T0),
            Ok(())
        );
        assert_eq!(listed(&s), strings(&[HANDLE_A, HANDLE_OWNER]));
        assert_eq!(
            passes(&fx, bob(), T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "bob's handle is not listed"
        );
    }
}
