//! The world access rule (local-play design A1), executed against the in-memory host.
//!
//! One module per criterion: `open_by_default` (a world with no rule row is open),
//! `unadmitted` (a `Password` world refuses an unadmitted connection before anything is
//! recorded), `wrong_password` (the door and its lockout), `owner_only` (only
//! `config.owner_identity` sets the rule or works the door), `owner_admits` (the owner's
//! admit list), `password_hash` (the Argon2id parameters, against an independent
//! implementation's known answers), and `allowlist` (an `Allowlist` world admits a bound
//! identity by its account and an unbound one by its admission row).
//!
//! The host models no rollback, so every refusal here is asserted to write nothing at all, and
//! a counted wrong password is asserted to return `Ok` (a real host rolls back an `Err`, which
//! would forget the count).

use super::{
    admit, attempts_locked, effective_rule, hash_password, is_admitted, password_matches,
    recent_wrong_attempts, require_admitted, require_admitted_at_connect, set_world_access,
    ADMIT_ATTEMPT_WINDOW_MS, ADMIT_MAX_WRONG_ATTEMPTS, PASSWORD_HASH_BYTES, PASSWORD_MAX_BYTES,
    PASSWORD_SALT_BYTES, REJECT_ADMIT_LOCKED, REJECT_NOT_ADMITTED, REJECT_NOT_WORLD_OWNER,
    REJECT_NO_PASSWORD_RULE, REJECT_OPEN_TAKES_NO_PASSWORD, REJECT_PASSWORD_LENGTH,
    REJECT_PASSWORD_REQUIRED,
};
use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::schema::{
    Account, Config, PlayerSession, WorldAccess, WorldAccessRule, WorldAdmission,
    WorldAdmissionAttempt,
};
use spacetimedb::sats::bsatn;
use spacetimedb::{ConnectionId, Identity, ReducerContext, Serialize, Timestamp};

// --- known answers -----------------------------------------------------------
//
// Argon2id v1.3, m = 19456 KiB, t = 2, p = 1, 32-byte tag, computed by an independent
// implementation (OpenSSL through Node's `crypto.argon2Sync`).

const KAT_SALT: &[u8; 16] = b"0123456789abcdef";
const KAT_PASSWORD: &str = "correct horse";
const KAT_HASH_HEX: &str = "ae4d8c8b713876044c8347c76986a9b5655944aaacfffe9bea4dff9e7b6a1899";
const KAT2_PASSWORD: &str = "p";
const KAT2_HASH_HEX: &str = "721231c82ccd80f45d6e9cacf6bedf24ac5fb55f2cbde872d43a2f36243b2bfa";

/// A password that is not [`KAT_PASSWORD`].
const WRONG: &str = "wrong horse";

/// The second known answer's salt: the bytes 0, 1, ..., 15.
fn kat2_salt() -> Vec<u8> {
    (0u8..16).collect()
}

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

/// The `Password` row whose password is [`KAT_PASSWORD`].
fn password_row() -> WorldAccess {
    WorldAccess {
        id: 0,
        rule: WorldAccessRule::Password,
        password_salt: KAT_SALT.to_vec(),
        password_hash: unhex(KAT_HASH_HEX),
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

/// A world owned by [`owner`] whose rule is `Password` with [`KAT_PASSWORD`].
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

/// The owner works the door for `who`.
fn door(fx: &Fixture, who: Identity, password: &str, ms: i64) -> Result<(), String> {
    door_as(fx, owner(), who, password, ms)
}

fn door_as(
    fx: &Fixture,
    caller: Identity,
    who: Identity,
    password: &str,
    ms: i64,
) -> Result<(), String> {
    call(fx, caller, ms, |ctx| admit(ctx, who, password.to_string()))
}

fn set_access(
    fx: &Fixture,
    caller: Identity,
    rule: WorldAccessRule,
    password: Option<&str>,
    list: Vec<Identity>,
    ms: i64,
) -> Result<(), String> {
    call(fx, caller, ms, |ctx| {
        set_world_access(ctx, rule, password.map(str::to_string), list)
    })
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

/// [`footprint`] without one table.
fn footprint_except(fx: &Fixture, w: &W<'_>, skip: &str) -> Vec<(&'static str, Vec<Vec<u8>>, u32)> {
    footprint(fx, w)
        .into_iter()
        .filter(|(table, _, _)| *table != skip)
        .collect()
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

/// The attempt rows as `(identity bytes, wrong_at_ms, last_wrong_at_ms)`, sorted.
fn attempts(w: &W<'_>) -> Vec<([u8; 32], Vec<i64>, i64)> {
    let mut out: Vec<([u8; 32], Vec<i64>, i64)> = w
        .attempt
        .rows()
        .into_iter()
        .map(|r| {
            (
                r.identity.to_byte_array(),
                r.wrong_at_ms,
                r.last_wrong_at_ms,
            )
        })
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
// The door refuses a wrong password, and five wrong ones lock an identity out.
// =====================================================================================

mod wrong_password {
    use super::*;
    use proptest::prelude::*;

    /// One wrong password: `Ok(())` (a counted refusal must commit), no admission, one stamp,
    /// and no write to any table but `world_admission_attempt`.
    ///
    /// kills: `admit` returning `Err` on a wrong password (the real host would roll the count
    /// back); a wrong password admitted; the stamp keyed on the caller instead of `who`; a
    /// write to the rule, config, session or admission tables.
    #[test]
    fn one_wrong_password_is_taken_counted_and_writes_nothing_else() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x21);
        let before = footprint_except(&fx, &w, "world_admission_attempt");
        assert_eq!(
            door(&fx, who, WRONG, T0),
            Ok(()),
            "a wrong password is answered Ok so its count commits"
        );
        assert_eq!(admitted_at(&w, who), None, "a wrong password admits nobody");
        assert_eq!(
            attempts(&w),
            vec![(who.to_byte_array(), vec![T0], T0)],
            "exactly one attempt row, for `who`, holding this call's time"
        );
        assert_eq!(
            footprint_except(&fx, &w, "world_admission_attempt"),
            before,
            "no table but world_admission_attempt is written"
        );
        assert_eq!(
            passes(&fx, who, T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
    }

    /// Four wrong passwords and then the right one: admitted at that call's time, and the
    /// attempt row is gone.
    ///
    /// kills: a lock at four (`>= 4` or `> 3`); a right password that leaves the attempt row.
    #[test]
    fn four_wrong_then_the_right_password_admits_and_clears_the_attempts() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x22);
        for i in 0..4 {
            assert_eq!(door(&fx, who, WRONG, T0 + i), Ok(()));
        }
        assert_eq!(
            attempts_of(&w, who),
            Some((vec![T0, T0 + 1, T0 + 2, T0 + 3], T0 + 3))
        );
        assert_eq!(door(&fx, who, KAT_PASSWORD, T0 + 4), Ok(()));
        assert_eq!(admitted_at(&w, who), Some(T0 + 4));
        assert_eq!(attempts_of(&w, who), None, "admitting clears the attempts");
        assert_eq!(passes(&fx, who, T0 + 5), Ok(()));
        assert_eq!(call(&fx, who, T0 + 5, crate::on_connect), Ok(()));
        assert_eq!(sessions_of(&w, who), vec![conn_of(who)]);
    }

    /// Five wrong passwords inside ten minutes, then the right one: refused as locked, with
    /// no write at all on that call.
    ///
    /// kills: the lock at `> 5` (the sixth attempt is taken); a locked identity's right
    /// password admitted; a locked call that still writes.
    #[test]
    fn five_wrong_then_the_right_password_is_locked_out_with_no_write() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x23);
        let n = i64::try_from(ADMIT_MAX_WRONG_ATTEMPTS).expect("the attempt cap fits an i64");
        for i in 0..n {
            assert_eq!(door(&fx, who, WRONG, T0 + i * 1000), Ok(()));
        }
        let stamps: Vec<i64> = (0..n).map(|i| T0 + i * 1000).collect();
        assert_eq!(attempts_of(&w, who), Some((stamps, T0 + (n - 1) * 1000)));
        fx.reset_writes();
        let before = footprint(&fx, &w);
        assert_eq!(
            door(&fx, who, KAT_PASSWORD, T0 + 10_000),
            Err(REJECT_ADMIT_LOCKED.to_string())
        );
        assert_eq!(
            footprint(&fx, &w),
            before,
            "a locked call writes nothing at all"
        );
        assert_eq!(admitted_at(&w, who), None);
        assert_eq!(
            passes(&fx, who, T0 + 10_001),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
    }

    /// The lock is per identity: another identity's right password admits it while `who` is
    /// locked, and `who` stays locked.
    ///
    /// kills: a lock counted per world (every identity locked by one guesser).
    #[test]
    fn the_lockout_is_per_identity() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x24);
        let other = id(0x25);
        w.attempt
            .seed(&attempt_row(who, &[T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4]));
        assert_eq!(door(&fx, other, WRONG, T0 + 5), Ok(()));
        assert_eq!(door(&fx, other, KAT_PASSWORD, T0 + 6), Ok(()));
        assert_eq!(admitted_at(&w, other), Some(T0 + 6));
        assert_eq!(
            door(&fx, who, KAT_PASSWORD, T0 + 7),
            Err(REJECT_ADMIT_LOCKED.to_string())
        );
        assert_eq!(admitted_at(&w, who), None);
        assert_eq!(
            attempts_of(&w, who),
            Some((vec![T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4], T0 + 4)),
            "the locked identity's stamps are its own"
        );
    }

    /// The boundary: the right password is refused at the oldest stamp + 599 999 ms and
    /// admits at the oldest stamp + 600 000 ms.
    ///
    /// kills: a lock that expires early; `<=` in the window test (the lock outlives ten
    /// minutes by one millisecond); a lock that never expires.
    #[test]
    fn the_lock_ends_exactly_ten_minutes_after_the_oldest_wrong_attempt() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x26);
        w.attempt
            .seed(&attempt_row(who, &[T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4]));
        assert_eq!(
            door(&fx, who, KAT_PASSWORD, T0 + ADMIT_ATTEMPT_WINDOW_MS - 1),
            Err(REJECT_ADMIT_LOCKED.to_string()),
            "one millisecond before the oldest stamp ages out the identity is still locked"
        );
        assert_eq!(admitted_at(&w, who), None);
        assert_eq!(
            door(&fx, who, KAT_PASSWORD, T0 + ADMIT_ATTEMPT_WINDOW_MS),
            Ok(())
        );
        assert_eq!(admitted_at(&w, who), Some(T0 + ADMIT_ATTEMPT_WINDOW_MS));
        assert_eq!(attempts_of(&w, who), None);
    }

    /// The window slides: four wrong at t0 and a fifth at t0 + 599 000 lock; at t0 + 600 000
    /// the first four have aged out, so one more attempt is taken and the row keeps only the
    /// recent stamps plus the new one.
    ///
    /// kills: a lock that never expires; stale stamps kept in the row; a lock reset to zero
    /// rather than slid.
    #[test]
    fn the_window_slides_and_aged_out_stamps_leave_the_row() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x27);
        w.attempt.seed(&attempt_row(who, &[T0, T0, T0, T0]));
        let fifth = T0 + 599_000;
        assert_eq!(door(&fx, who, WRONG, fifth), Ok(()));
        assert_eq!(
            attempts_of(&w, who),
            Some((vec![T0, T0, T0, T0, fifth], fifth))
        );
        assert_eq!(
            door(&fx, who, KAT_PASSWORD, T0 + 599_500),
            Err(REJECT_ADMIT_LOCKED.to_string())
        );
        let later = T0 + ADMIT_ATTEMPT_WINDOW_MS;
        assert_eq!(
            door(&fx, who, WRONG, later),
            Ok(()),
            "the four oldest stamps have aged out: the attempt is taken"
        );
        assert_eq!(
            attempts_of(&w, who),
            Some((vec![fifth, later], later)),
            "the row is its recent stamps plus this one"
        );
        assert_eq!(door(&fx, who, KAT_PASSWORD, later + 1), Ok(()));
        assert_eq!(admitted_at(&w, who), Some(later + 1));
    }

    /// A clock that runs backwards does not unlock: stamps ahead of the clock are recent.
    ///
    /// kills: `now - t` computed so a future stamp falls out of the window.
    #[test]
    fn a_clock_that_runs_backwards_does_not_unlock() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x28);
        let stamps = [T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4];
        w.attempt.seed(&attempt_row(who, &stamps));
        for earlier in [
            T0 - 1,
            T0 - ADMIT_ATTEMPT_WINDOW_MS,
            T0 - 10 * ADMIT_ATTEMPT_WINDOW_MS,
        ] {
            assert_eq!(
                door(&fx, who, KAT_PASSWORD, earlier),
                Err(REJECT_ADMIT_LOCKED.to_string()),
                "at {earlier} the five stamps ahead of the clock still lock"
            );
        }
        assert_eq!(admitted_at(&w, who), None);
        assert_eq!(attempts_of(&w, who), Some((stamps.to_vec(), T0 + 4)));
    }

    /// A clock that steps backwards does not let the sweep clear a lock. Four wrong passwords
    /// at `t`; the clock steps back eleven minutes and a fifth is taken (the four ahead of
    /// the clock still count). The row's sweep key is its LATEST stamp, `t`, not the time of
    /// that call. Another identity's wrong password one minute before `t` runs the sweep,
    /// which must keep `who`'s row because its stamps at `t` still count; a millisecond
    /// earlier all five count again and the right password is refused as locked.
    ///
    /// kills: `last_wrong_at_ms` stored as the call's time (the sweep then deletes a row
    /// that still holds counting stamps, and the lock is gone).
    #[test]
    fn a_clock_that_steps_backwards_does_not_let_the_sweep_clear_a_lock() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x51);
        let other = id(0x52);
        let t = T0;
        w.attempt.seed(&attempt_row(who, &[t, t, t, t]));
        let stepped_back = t - 11 * 60_000;
        assert_eq!(door(&fx, who, WRONG, stepped_back), Ok(()));
        assert_eq!(
            attempts_of(&w, who),
            Some((vec![t, t, t, t, stepped_back], t)),
            "five counting stamps, keyed for the sweep on the latest of them"
        );
        let sweep_at = t - 60_000;
        assert_eq!(door(&fx, other, WRONG, sweep_at), Ok(()));
        assert_eq!(
            attempts_of(&w, who),
            Some((vec![t, t, t, t, stepped_back], t)),
            "the sweep keeps a row whose latest stamp is inside the window"
        );
        assert_eq!(
            door(&fx, who, KAT_PASSWORD, sweep_at - 1),
            Err(REJECT_ADMIT_LOCKED.to_string()),
            "all five stamps count, so `who` is still locked"
        );
        assert_eq!(admitted_at(&w, who), None);
    }

    /// An already-admitted `who` given a wrong password: `Ok(())`, no attempt row, nothing
    /// written.
    ///
    /// kills: an admitted identity's wrong guess counted, or its admission dropped.
    #[test]
    fn an_admitted_who_with_a_wrong_password_is_ok_and_counts_nothing() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x29);
        w.admission.seed(&admission_row(who, T0 - 9));
        let before = footprint(&fx, &w);
        assert_eq!(door(&fx, who, WRONG, T0), Ok(()));
        assert_eq!(footprint(&fx, &w), before, "nothing is written");
        assert_eq!(attempts_of(&w, who), None);
        assert_eq!(admitted_at(&w, who), Some(T0 - 9));
    }

    /// The door on an `Open` world (no row, or an `Open` row) is refused with no write.
    ///
    /// kills: the rule check dropped (the door counts or admits on an open world).
    #[test]
    fn the_door_on_an_open_world_is_refused_with_no_write() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        let who = id(0x2A);
        let before = footprint(&fx, &w);
        for password in [WRONG, KAT_PASSWORD] {
            assert_eq!(
                door(&fx, who, password, T0),
                Err(REJECT_NO_PASSWORD_RULE.to_string())
            );
        }
        assert_eq!(footprint(&fx, &w), before);
        w.access.seed(&open_row());
        let before = footprint(&fx, &w);
        assert_eq!(
            door(&fx, who, WRONG, T0),
            Err(REJECT_NO_PASSWORD_RULE.to_string())
        );
        assert_eq!(footprint(&fx, &w), before);
    }

    /// An empty password and one over `PASSWORD_MAX_BYTES` bytes (counted in BYTES) are
    /// refused and not counted; one of exactly `PASSWORD_MAX_BYTES` bytes is a counted wrong
    /// attempt.
    ///
    /// kills: the length checked in chars; an off-by-one at the maximum; an over-long
    /// password counted as a wrong attempt.
    #[test]
    fn an_empty_or_oversize_password_is_refused_and_not_counted() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x2B);
        let e_acute = char::from_u32(0xE9).expect("U+00E9 is a char");
        let two_byte: String = std::iter::repeat_n(e_acute, PASSWORD_MAX_BYTES / 2 + 1).collect();
        assert!(two_byte.chars().count() <= PASSWORD_MAX_BYTES);
        assert!(two_byte.len() > PASSWORD_MAX_BYTES);
        let before = footprint(&fx, &w);
        for password in [String::new(), "x".repeat(PASSWORD_MAX_BYTES + 1), two_byte] {
            assert_eq!(
                door(&fx, who, &password, T0),
                Err(REJECT_PASSWORD_LENGTH.to_string()),
                "a {}-byte password",
                password.len()
            );
        }
        assert_eq!(footprint(&fx, &w), before, "not counted, nothing written");
        assert_eq!(
            door(&fx, who, &"x".repeat(PASSWORD_MAX_BYTES), T0 + 1),
            Ok(())
        );
        assert_eq!(
            attempts_of(&w, who),
            Some((vec![T0 + 1], T0 + 1)),
            "a maximum-length wrong password is a counted attempt"
        );
    }

    /// A writing door call sweeps every OTHER identity's attempt row whose last stamp is a
    /// full window behind, and keeps a fresh one; the right-password path sweeps too.
    ///
    /// kills: the sweep dropped (stale rows accumulate forever); a sweep that deletes a fresh
    /// row; a sweep off by one at the window edge.
    #[test]
    fn a_writing_call_sweeps_stale_attempt_rows_and_keeps_fresh_ones() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x2C);
        let stale = id(0x2D);
        let fresh = id(0x2E);
        let stale_later = id(0x2F);
        let edge = T0 - ADMIT_ATTEMPT_WINDOW_MS;
        w.attempt.seed(&attempt_row(stale, &[edge - 5, edge]));
        w.attempt
            .seed(&attempt_row(fresh, &[T0 - ADMIT_ATTEMPT_WINDOW_MS + 1]));
        assert_eq!(door(&fx, who, WRONG, T0), Ok(()));
        assert_eq!(attempts_of(&w, stale), None, "a full window behind: swept");
        assert_eq!(
            attempts_of(&w, fresh),
            Some((
                vec![T0 - ADMIT_ATTEMPT_WINDOW_MS + 1],
                T0 - ADMIT_ATTEMPT_WINDOW_MS + 1
            )),
            "one millisecond inside the window: kept"
        );
        w.attempt.seed(&attempt_row(
            stale_later,
            &[T0 + 1 - ADMIT_ATTEMPT_WINDOW_MS],
        ));
        assert_eq!(door(&fx, who, KAT_PASSWORD, T0 + 1), Ok(()));
        assert_eq!(
            attempts_of(&w, stale_later),
            None,
            "the admitting call sweeps too"
        );
        assert_eq!(
            attempts_of(&w, fresh),
            None,
            "a full window behind T0 + 1: swept"
        );
        assert_eq!(admitted_at(&w, who), Some(T0 + 1));
    }

    /// The door writes rows for `who` only: never for the calling owner, never for anybody
    /// else.
    ///
    /// kills: an admission or attempt keyed on `ctx.sender()`.
    #[test]
    fn the_door_writes_no_row_for_anyone_but_who() {
        let fx = fixture();
        let w = password_world(&fx);
        let who = id(0x30);
        assert_eq!(door(&fx, who, WRONG, T0), Ok(()));
        assert_eq!(attempts(&w), vec![(who.to_byte_array(), vec![T0], T0)]);
        assert!(w.admission.rows().is_empty());
        assert_eq!(door(&fx, who, KAT_PASSWORD, T0 + 1), Ok(()));
        assert_eq!(admissions(&w), vec![(who.to_byte_array(), T0 + 1)]);
        assert!(w.attempt.rows().is_empty());
        assert_eq!(admitted_at(&w, owner()), None, "the owner gains no row");
    }

    /// The pure window: the stamps strictly less than a window behind `now` (a stamp ahead of
    /// the clock is recent), order kept; the lock is five or more recent stamps.
    ///
    /// kills: `<=` at the edge; future stamps dropped; the order changed; an overflowing
    /// subtraction; a lock at `> 5`.
    #[test]
    fn the_recent_stamps_and_the_lock_follow_the_window() {
        let w = ADMIT_ATTEMPT_WINDOW_MS;
        let now = T0 + w;
        assert_eq!(
            recent_wrong_attempts(&[T0, T0 + 1, now, now + 5], now),
            vec![T0 + 1, now, now + 5]
        );
        assert_eq!(
            recent_wrong_attempts(&[now - 1, now - 9, now - 3], now),
            vec![now - 1, now - 9, now - 3],
            "order is kept"
        );
        assert!(recent_wrong_attempts(&[], now).is_empty());
        assert!(recent_wrong_attempts(&[i64::MIN], i64::MAX).is_empty());
        assert_eq!(recent_wrong_attempts(&[i64::MAX], i64::MIN), vec![i64::MAX]);

        let recent = |n: usize| -> Vec<i64> { (0..n).map(|i| now - i as i64).collect() };
        assert!(!attempts_locked(&recent(ADMIT_MAX_WRONG_ATTEMPTS - 1), now));
        assert!(attempts_locked(&recent(ADMIT_MAX_WRONG_ATTEMPTS), now));
        assert!(attempts_locked(&recent(ADMIT_MAX_WRONG_ATTEMPTS + 1), now));
        let mut aged = recent(ADMIT_MAX_WRONG_ATTEMPTS - 1);
        aged.insert(0, now - w);
        assert!(
            !attempts_locked(&aged, now),
            "a stamp a full window behind does not count"
        );
        assert!(attempts_locked(
            &recent(ADMIT_MAX_WRONG_ATTEMPTS),
            now - 1_000_000
        ));
    }

    proptest! {
        /// For any stamps near any clock: the recent stamps are exactly those less than a
        /// window behind (order kept), and the identity is locked exactly when five or more
        /// are recent — never more than four recent stamps lock-free.
        #[test]
        fn the_lock_is_exactly_five_or_more_recent_stamps(
            now in -1_000_000_000_000i64..4_000_000_000_000i64,
            offsets in prop::collection::vec(-1_300_000i64..1_300_000i64, 0..10),
        ) {
            let stamps: Vec<i64> = offsets.iter().map(|o| now + o).collect();
            let want: Vec<i64> = stamps
                .iter()
                .copied()
                .filter(|&t| now.saturating_sub(t) < ADMIT_ATTEMPT_WINDOW_MS)
                .collect();
            let locked = want.len() >= ADMIT_MAX_WRONG_ATTEMPTS;
            prop_assert_eq!(recent_wrong_attempts(&stamps, now), want);
            prop_assert_eq!(attempts_locked(&stamps, now), locked);
        }
    }
}

// =====================================================================================
// Only `config.owner_identity` may call `set_world_access` (or work the door).
// =====================================================================================

mod owner_only {
    use super::*;

    /// A stranger on an `Open` world cannot set the rule, admit itself, or work the door.
    ///
    /// kills: the owner check dropped from either access reducer.
    #[test]
    fn a_stranger_on_an_open_world_cannot_set_the_rule_or_work_the_door() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        let stranger = id(0x31);
        let before = footprint(&fx, &w);
        assert_eq!(
            set_access(
                &fx,
                stranger,
                WorldAccessRule::Password,
                Some("mine now"),
                vec![stranger],
                T0
            ),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            set_access(
                &fx,
                stranger,
                WorldAccessRule::Open,
                None,
                vec![stranger],
                T0
            ),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            door_as(&fx, stranger, stranger, KAT_PASSWORD, T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(footprint(&fx, &w), before, "nothing is written");
    }

    /// An ADMITTED non-owner on a `Password` world is refused both access reducers, so the
    /// refusal is the owner check's, not the admission check's.
    ///
    /// kills: `set_world_access` or `admit` gated on admission instead of ownership.
    #[test]
    fn an_admitted_non_owner_cannot_set_the_rule_or_work_the_door() {
        let fx = fixture();
        let w = password_world(&fx);
        let let_in = id(0x32);
        w.admission.seed(&admission_row(let_in, T0 - 1));
        assert_eq!(passes(&fx, let_in, T0), Ok(()), "fixture: it is admitted");
        let before = footprint(&fx, &w);
        assert_eq!(
            set_access(&fx, let_in, WorldAccessRule::Open, None, Vec::new(), T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            set_access(
                &fx,
                let_in,
                WorldAccessRule::Password,
                None,
                vec![id(0x33)],
                T0
            ),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            door_as(&fx, let_in, id(0x33), KAT_PASSWORD, T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(footprint(&fx, &w), before, "nothing is written");
    }

    /// A non-owner giving the right password to the door is refused, writes nothing and
    /// admits nobody — for itself or for another.
    ///
    /// kills: the door open to any caller who knows the password; an attempt or admission
    /// written before the owner check.
    #[test]
    fn a_non_owner_giving_the_right_password_to_the_door_is_refused() {
        let fx = fixture();
        let w = password_world(&fx);
        let stranger = id(0x34);
        let before = footprint(&fx, &w);
        for who in [stranger, id(0x35)] {
            for password in [KAT_PASSWORD, WRONG] {
                assert_eq!(
                    door_as(&fx, stranger, who, password, T0),
                    Err(REJECT_NOT_WORLD_OWNER.to_string())
                );
            }
        }
        assert_eq!(footprint(&fx, &w), before, "nothing is written");
        assert_eq!(
            passes(&fx, stranger, T0),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
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
            set_access(&fx, database, WorldAccessRule::Open, None, Vec::new(), T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            door_as(&fx, database, database, KAT_PASSWORD, T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(footprint(&fx, &w), before);
    }

    /// A `config` row whose owner is the all-zero identity (the column default: an owner
    /// never registered) names nobody: the all-zero caller is refused both access reducers
    /// with no write, and on a `Password` world it is refused by the admission check unless
    /// it holds an admission row.
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
            set_access(
                &fx,
                zero,
                WorldAccessRule::Password,
                Some("pw"),
                vec![zero],
                T0
            ),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            set_access(&fx, zero, WorldAccessRule::Open, None, Vec::new(), T0),
            Err(REJECT_NOT_WORLD_OWNER.to_string())
        );
        assert_eq!(
            door_as(&fx, zero, zero, KAT_PASSWORD, T0),
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
    /// owner, the all-zero identity, the database identity — is refused both reducers, before
    /// the door's rule check.
    ///
    /// kills: a missing config row read as "anyone is the owner"; an owner defaulted to the
    /// all-zero identity or the database identity; the door's rule check run first.
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
                set_access(
                    &fx,
                    caller,
                    WorldAccessRule::Password,
                    Some("pw"),
                    vec![caller],
                    T0
                ),
                Err(REJECT_NOT_WORLD_OWNER.to_string()),
                "set_world_access by {}",
                caller.to_hex()
            );
            assert_eq!(
                door_as(&fx, caller, caller, KAT_PASSWORD, T0),
                Err(REJECT_NOT_WORLD_OWNER.to_string()),
                "admit by {}",
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

    /// The owner sets a password and admits `x` in the same call: `x` is admitted at the
    /// call's time with no password given for it, passes the check and connects; the stored
    /// row is a 16-byte salt and the hash of the password under it.
    ///
    /// kills: the admit list ignored; an admission time not the call's; the password stored
    /// in the clear or hashed under another salt; a salt of the wrong length.
    #[test]
    fn the_owner_admits_an_identity_without_its_password() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        let x = id(0x41);
        let typed = "hunter two";
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                Some(typed),
                vec![x],
                T0
            ),
            Ok(())
        );
        let rows = w.access.rows();
        assert_eq!(rows.len(), 1, "one access row");
        let row = &rows[0];
        assert_eq!(row.id, 0);
        assert_eq!(row.rule, WorldAccessRule::Password);
        assert_eq!(row.password_salt.len(), PASSWORD_SALT_BYTES);
        assert_eq!(row.password_hash.len(), PASSWORD_HASH_BYTES);
        assert_eq!(
            row.password_hash,
            hash_password(&row.password_salt, typed),
            "the stored hash is the password's hash under the stored salt"
        );
        assert_eq!(admissions(&w), vec![(x.to_byte_array(), T0)]);
        assert_eq!(passes(&fx, x, T0 + 1), Ok(()));
        assert_eq!(call(&fx, x, T0 + 1, crate::on_connect), Ok(()));
        assert_eq!(sessions_of(&w, x), vec![conn_of(x)]);
        assert_eq!(
            passes(&fx, id(0x42), T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "the rule took effect for everyone else"
        );
    }

    /// Each password is stored under a fresh salt: the same password set at two different
    /// times gets two different salts and so two different hashes, and no salt is one byte
    /// repeated.
    ///
    /// kills: a fixed salt (every world's hash of a password is the same, so one
    /// precomputed table serves them all).
    #[test]
    fn the_same_password_set_twice_is_stored_under_two_fresh_salts() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        let chosen = "same every time";
        let mut stored: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        for ms in [T0, T0 + 1] {
            assert_eq!(
                set_access(
                    &fx,
                    owner(),
                    WorldAccessRule::Password,
                    Some(chosen),
                    Vec::new(),
                    ms
                ),
                Ok(())
            );
            let rows = w.access.rows();
            assert_eq!(rows.len(), 1);
            stored.push((rows[0].password_salt.clone(), rows[0].password_hash.clone()));
        }
        for (salt, _) in &stored {
            assert_eq!(salt.len(), PASSWORD_SALT_BYTES);
            assert!(
                salt.iter().any(|b| *b != salt[0]),
                "a salt that is one byte repeated is not random: {salt:?}"
            );
        }
        assert_ne!(stored[0].0, stored[1].0, "a fresh salt per password");
        assert_ne!(
            stored[0].1, stored[1].1,
            "so the same password hashes differently"
        );
    }

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
            set_access(&fx, owner(), WorldAccessRule::Open, None, vec![x], T0),
            Ok(())
        );
        assert_eq!(access_row(&w), enc(&open_row()));
        assert_eq!(admissions(&w), vec![(x.to_byte_array(), T0)]);
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                Some("pw one"),
                Vec::new(),
                T0 + 5
            ),
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
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                Some("pw two"),
                Vec::new(),
                T0
            ),
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

    /// `Password` -> `Password` admits nobody but the admit list: a connected, unadmitted
    /// identity stays refused.
    ///
    /// kills: a password change admitting everyone connected.
    #[test]
    fn a_password_change_admits_no_connected_unadmitted_identity() {
        let fx = fixture();
        let w = password_world(&fx);
        let s = id(0x47);
        let x = id(0x48);
        w.session.seed(&session_row(s, 0x0D01));
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Password, None, vec![x], T0),
            Ok(())
        );
        assert_eq!(admissions(&w), vec![(x.to_byte_array(), T0)]);
        assert_eq!(passes(&fx, s, T0 + 1), Err(REJECT_NOT_ADMITTED.to_string()));
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                Some("pw three"),
                Vec::new(),
                T0 + 2
            ),
            Ok(())
        );
        assert_eq!(admissions(&w), vec![(x.to_byte_array(), T0)]);
        assert_eq!(passes(&fx, s, T0 + 3), Err(REJECT_NOT_ADMITTED.to_string()));
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
            set_access(&fx, owner(), WorldAccessRule::Open, None, vec![x], T0),
            Ok(())
        );
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Open,
                None,
                vec![x, x],
                T0 + 50
            ),
            Ok(())
        );
        assert_eq!(admissions(&w), vec![(x.to_byte_array(), T0)]);
        w.session.seed(&session_row(x, 0x0E01));
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                Some("pw four"),
                vec![x],
                T0 + 100
            ),
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
            set_access(&fx, owner(), WorldAccessRule::Password, None, vec![x], T0),
            Ok(())
        );
        assert_eq!(attempts_of(&w, x), None);
        assert_eq!(attempts_of(&w, y), Some((vec![T0 - 3, T0 - 1], T0 - 1)));
        assert_eq!(admitted_at(&w, x), Some(T0));
    }

    /// Every validation refuses before any write: `Open` with a password, an empty or
    /// over-long password, and `Password` with no password while no hash is stored (no row,
    /// an `Open` row, a `Password` row with no hash). A password of exactly the maximum is
    /// taken.
    ///
    /// kills: `Password` + `None` accepted on a world that never had a password; a password
    /// length checked in chars or off by one; a validation that writes before refusing.
    #[test]
    fn the_access_call_validates_before_any_write() {
        let fx = fixture();
        let w = world(&fx);
        seed_owner(&w, owner());
        let x = id(0x4C);
        let e_acute = char::from_u32(0xE9).expect("U+00E9 is a char");
        let two_byte: String = std::iter::repeat_n(e_acute, PASSWORD_MAX_BYTES / 2 + 1).collect();
        let no_hash = WorldAccess {
            password_salt: Vec::new(),
            password_hash: Vec::new(),
            ..password_row()
        };
        let cases: [(Option<WorldAccess>, WorldAccessRule, Option<String>, &str); 9] = [
            (
                Some(password_row()),
                WorldAccessRule::Open,
                Some("pw".to_string()),
                REJECT_OPEN_TAKES_NO_PASSWORD,
            ),
            (
                None,
                WorldAccessRule::Open,
                Some("pw".to_string()),
                REJECT_OPEN_TAKES_NO_PASSWORD,
            ),
            (
                None,
                WorldAccessRule::Password,
                Some(String::new()),
                REJECT_PASSWORD_LENGTH,
            ),
            (
                None,
                WorldAccessRule::Password,
                Some("x".repeat(PASSWORD_MAX_BYTES + 1)),
                REJECT_PASSWORD_LENGTH,
            ),
            (
                Some(password_row()),
                WorldAccessRule::Password,
                Some(two_byte),
                REJECT_PASSWORD_LENGTH,
            ),
            (
                Some(password_row()),
                WorldAccessRule::Password,
                Some(String::new()),
                REJECT_PASSWORD_LENGTH,
            ),
            (
                None,
                WorldAccessRule::Password,
                None,
                REJECT_PASSWORD_REQUIRED,
            ),
            (
                Some(open_row()),
                WorldAccessRule::Password,
                None,
                REJECT_PASSWORD_REQUIRED,
            ),
            (
                Some(no_hash),
                WorldAccessRule::Password,
                None,
                REJECT_PASSWORD_REQUIRED,
            ),
        ];
        for (stored, rule, password, want) in cases {
            let _ = w.access.remove(0);
            if let Some(row) = &stored {
                w.access.seed(row);
            }
            fx.reset_writes();
            let before = footprint(&fx, &w);
            assert_eq!(
                set_access(&fx, owner(), rule, password.as_deref(), vec![x], T0),
                Err(want.to_string()),
                "{rule:?} with a {:?}-byte password over {:?}",
                password.as_ref().map(String::len),
                stored.as_ref().map(|r| r.rule)
            );
            assert_eq!(footprint(&fx, &w), before, "refused before any write");
            assert_eq!(admitted_at(&w, x), None, "the admit list is not applied");
        }
        let _ = w.access.remove(0);
        let longest = "x".repeat(PASSWORD_MAX_BYTES);
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                Some(&longest),
                Vec::new(),
                T0
            ),
            Ok(()),
            "a password of exactly the maximum is taken"
        );
    }

    /// `Password` with no new password keeps the stored salt and hash byte for byte, and the
    /// old password still admits through the door.
    ///
    /// kills: `Password` + `None` re-salting, re-hashing or clearing the stored hash.
    #[test]
    fn password_with_no_new_password_keeps_the_salt_and_hash_byte_for_byte() {
        let fx = fixture();
        let w = password_world(&fx);
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                None,
                Vec::new(),
                T0
            ),
            Ok(())
        );
        assert_eq!(access_row(&w), enc(&password_row()));
        let who = id(0x4D);
        assert_eq!(door(&fx, who, KAT_PASSWORD, T0 + 1), Ok(()));
        assert_eq!(admitted_at(&w, who), Some(T0 + 1));
    }

    /// Returning to `Open` empties the salt and hash (admissions survive), opens the world,
    /// and `Password` + `None` is then refused as needing a password.
    ///
    /// kills: returning to `Open` keeping the old salt or hash (a later `Password` + `None`
    /// would silently restore the old password); admissions dropped on the way.
    #[test]
    fn returning_to_open_empties_the_salt_and_hash_and_then_a_password_is_required() {
        let fx = fixture();
        let w = password_world(&fx);
        let x = id(0x4E);
        w.admission.seed(&admission_row(x, T0 - 7));
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Open, None, Vec::new(), T0),
            Ok(())
        );
        assert_eq!(access_row(&w), enc(&open_row()));
        assert_eq!(passes(&fx, id(0x4F), T0 + 1), Ok(()), "the world is open");
        assert_eq!(admissions(&w), vec![(x.to_byte_array(), T0 - 7)]);
        let before = footprint(&fx, &w);
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                None,
                Vec::new(),
                T0 + 2
            ),
            Err(REJECT_PASSWORD_REQUIRED.to_string())
        );
        assert_eq!(footprint(&fx, &w), before);
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                Some("pw five"),
                Vec::new(),
                T0 + 3
            ),
            Ok(())
        );
        assert_eq!(
            admissions(&w),
            vec![(x.to_byte_array(), T0 - 7)],
            "the admission survives the return to Open and the new password"
        );
    }

    /// After a password change the new password admits through the door and the old one is a
    /// counted wrong attempt.
    ///
    /// kills: a password change that keeps accepting the old password, or keeps the old
    /// salt and hash.
    #[test]
    fn after_a_password_change_the_new_password_admits_and_the_old_one_is_wrong() {
        let fx = fixture();
        let w = password_world(&fx);
        let fresh = "battery staple";
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                Some(fresh),
                Vec::new(),
                T0
            ),
            Ok(())
        );
        let rows = w.access.rows();
        assert_eq!(rows.len(), 1);
        assert_ne!(
            rows[0].password_hash,
            unhex(KAT_HASH_HEX),
            "the hash changed"
        );
        assert_eq!(rows[0].password_salt.len(), PASSWORD_SALT_BYTES);
        let who = id(0x50);
        assert_eq!(door(&fx, who, KAT_PASSWORD, T0 + 1), Ok(()));
        assert_eq!(
            admitted_at(&w, who),
            None,
            "the old password no longer admits"
        );
        assert_eq!(attempts_of(&w, who), Some((vec![T0 + 1], T0 + 1)));
        assert_eq!(door(&fx, who, fresh, T0 + 2), Ok(()));
        assert_eq!(admitted_at(&w, who), Some(T0 + 2));
    }
}

// =====================================================================================
// The hash: Argon2id at the production parameters, against independent known answers.
// =====================================================================================

mod password_hash {
    use super::*;

    /// kills: any parameter drift (memory, passes, lanes, version, variant, tag length); a
    /// salt or password fed in another encoding.
    #[test]
    fn hash_password_matches_an_independent_argon2id_at_the_production_parameters() {
        assert_eq!(hash_password(KAT_SALT, KAT_PASSWORD), unhex(KAT_HASH_HEX));
        assert_eq!(
            hash_password(&kat2_salt(), KAT2_PASSWORD),
            unhex(KAT2_HASH_HEX)
        );
        assert_eq!(unhex(KAT_HASH_HEX).len(), PASSWORD_HASH_BYTES);
    }

    /// A malformed stored row (an empty hash, an empty salt, a 31-byte hash) matches no
    /// password at all — the empty one and the right one included.
    ///
    /// kills: `password_matches` accepting anything against an empty stored hash; a prefix
    /// comparison.
    #[test]
    fn password_matches_refuses_every_password_against_a_malformed_row() {
        let mut short = unhex(KAT_HASH_HEX);
        short.truncate(PASSWORD_HASH_BYTES - 1);
        let malformed = [
            WorldAccess {
                password_hash: Vec::new(),
                ..password_row()
            },
            WorldAccess {
                password_salt: Vec::new(),
                ..password_row()
            },
            WorldAccess {
                password_hash: short,
                ..password_row()
            },
        ];
        for row in &malformed {
            for password in [KAT_PASSWORD, "", WRONG] {
                assert!(
                    !password_matches(row, password),
                    "salt {} bytes, hash {} bytes, password {password:?}",
                    row.password_salt.len(),
                    row.password_hash.len()
                );
            }
        }
    }

    /// A row matches the password it was built from and nothing else.
    ///
    /// kills: `password_matches` answering a constant; a comparison that ignores the salt or
    /// trims the password.
    #[test]
    fn password_matches_is_true_only_for_the_password_the_row_was_built_from() {
        let row = password_row();
        assert!(password_matches(&row, KAT_PASSWORD));
        for other in ["correct horsE", "correct horse ", " correct horse", WRONG] {
            assert!(!password_matches(&row, other), "{other:?}");
        }
        let second = WorldAccess {
            password_salt: kat2_salt(),
            password_hash: unhex(KAT2_HASH_HEX),
            ..password_row()
        };
        assert!(password_matches(&second, KAT2_PASSWORD));
        let swapped_salt = WorldAccess {
            password_salt: KAT_SALT.to_vec(),
            ..second
        };
        assert!(
            !password_matches(&swapped_salt, KAT2_PASSWORD),
            "the same password under another salt does not match"
        );
    }
}

// =====================================================================================
// An `Allowlist` world admits a bound identity by its account on the list, and an identity
// with no trusted binding by its admission row.
// =====================================================================================

mod allowlist {
    use super::super::REJECT_ALLOWLIST_TAKES_NO_PASSWORD;
    use super::*;
    use crate::schema::{WorldAllowlist, WorldBinding};

    const ALICE: &str = "dev:alice-6f1c2a3b";
    const BOB: &str = "dev:bob-0d4e4f5a";
    const CAROL: &str = "dev:carol-8b6c7d8e";

    /// The access tables of [`world`] plus `world_binding` (read by `identity`) and
    /// `world_allowlist` (read by `account_subject`). Neither of the two is writable: no path
    /// under test writes them, and a write to either aborts the test.
    struct A<'a> {
        w: W<'a>,
        binding: Handle<'a, WorldBinding>,
        list: Handle<'a, WorldAllowlist, String>,
    }

    fn tables(fx: &Fixture) -> A<'_> {
        A {
            w: world(fx),
            binding: fx
                .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
                .unique(),
            list: fx
                .table_keyed::<WorldAllowlist, String>("world_allowlist", "account_subject", |r| {
                    r.account_subject.clone()
                })
                .unique(),
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

    /// The `kid` of a key the default test build holds.
    fn trusted_kid() -> String {
        crate::accounts::DEV_ATTESTATION_KEYS[0].kid.to_string()
    }

    fn binding_row(who: Identity, subject: &str, key_id: &str) -> WorldBinding {
        WorldBinding {
            identity: who,
            account_subject: subject.to_string(),
            bound_at_ms: T0 - 100,
            entitled: true,
            key_id: key_id.to_string(),
        }
    }

    /// Bind `who` to `subject` under a key the build holds.
    fn bind(a: &A<'_>, who: Identity, subject: &str) {
        a.binding.seed(&binding_row(who, subject, &trusted_kid()));
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
            "world_binding",
            encs(&a.binding.rows()),
            fx.writes_to("world_binding"),
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
        assert_eq!(a.binding.remove(who), 1, "fixture: the binding goes");
        assert_admitted(
            &fx,
            &a,
            who,
            T0 + 1,
            "the same identity with no binding, admitted before",
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

    /// A binding signed by a key the build does not hold counts for nothing: its listed
    /// account does not admit, and its identity is admitted by its admission row as an unbound
    /// one is.
    ///
    /// kills: `key_id` ignored; the `kid` compared without case or as a prefix; an untrusted
    /// binding that still blocks the admission row.
    #[test]
    fn a_binding_under_a_key_the_build_does_not_hold_counts_for_nothing() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE]);
        let trusted = id(0x6C);
        bind(&a, trusted, ALICE);
        assert_admitted(&fx, &a, trusted, T0, "control: a trusted binding to ALICE");
        let kid = trusted_kid();
        let untrusted = [
            (id(0x6D), "kid-of-no-key".to_string()),
            (id(0x6E), kid.to_lowercase()),
            (id(0x6F), format!("{kid}A")),
            (id(0x70), kid[..kid.len() - 1].to_string()),
        ];
        for (who, key_id) in &untrusted {
            assert_ne!(*key_id, kid, "fixture: not a key of the build");
            a.binding.seed(&binding_row(*who, ALICE, key_id));
            assert_refused(
                &fx,
                &a,
                *who,
                T0,
                &format!("listed account under kid {key_id:?}, no admission row"),
            );
            a.w.admission.seed(&admission_row(*who, T0 - 30));
            assert_admitted(
                &fx,
                &a,
                *who,
                T0 + 1,
                &format!("listed account under kid {key_id:?}, admitted before"),
            );
        }
    }

    /// Taking an account off the list refuses its identities at their next check, the one
    /// with an admission row too; an identity bound to an account still listed stays in.
    ///
    /// kills: the list cached at connect or copied into an admission row; an admission row
    /// that outlives delisting.
    #[test]
    fn taking_an_account_off_the_list_refuses_its_identities_at_the_next_check() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE, BOB]);
        let who = id(0x71);
        let seen = id(0x72);
        let other = id(0x73);
        bind(&a, who, ALICE);
        bind(&a, seen, ALICE);
        bind(&a, other, BOB);
        a.w.admission.seed(&admission_row(seen, T0 - 40));
        assert_admitted(&fx, &a, who, T0, "listed");
        assert_admitted(&fx, &a, seen, T0, "listed, admitted before");
        assert_eq!(
            a.list.remove(ALICE.to_string()),
            1,
            "fixture: ALICE leaves the list"
        );
        assert_refused(&fx, &a, who, T0 + 1, "delisted");
        assert_refused(&fx, &a, seen, T0 + 1, "delisted, admitted before");
        assert_admitted(&fx, &a, other, T0 + 1, "bound to an account still listed");
    }

    /// kills: one admitted identity per account; the account read from another identity's
    /// binding.
    #[test]
    fn every_identity_bound_to_a_listed_account_is_admitted() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE]);
        let p = id(0x74);
        let q = id(0x75);
        let r = id(0x76);
        bind(&a, p, ALICE);
        bind(&a, q, ALICE);
        bind(&a, r, BOB);
        assert_admitted(&fx, &a, p, T0, "the first identity bound to ALICE");
        assert_admitted(&fx, &a, q, T0, "the second identity bound to ALICE");
        assert_refused(&fx, &a, r, T0, "an identity bound to BOB");
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

    /// `Allowlist` with any password is refused before any write, whatever rule is stored.
    ///
    /// kills: the password ignored (stored, or dropped silently); a write or an admission
    /// made before the refusal.
    #[test]
    fn allowlist_with_a_password_is_refused_and_the_stored_row_is_unchanged() {
        let fx = fixture();
        let a = tables(&fx);
        seed_owner(&a.w, owner());
        a.w.session.seed(&session_row(id(0x7D), 0x07D0));
        let x = id(0x7E);
        for stored in [
            None,
            Some(open_row()),
            Some(password_row()),
            Some(allowlist_row()),
        ] {
            for typed in ["pw", KAT_PASSWORD, ""] {
                let _ = a.w.access.remove(0);
                if let Some(row) = &stored {
                    a.w.access.seed(row);
                }
                fx.reset_writes();
                let before = footprint_all(&fx, &a);
                assert_eq!(
                    set_access(
                        &fx,
                        owner(),
                        WorldAccessRule::Allowlist,
                        Some(typed),
                        vec![x],
                        T0
                    ),
                    Err(REJECT_ALLOWLIST_TAKES_NO_PASSWORD.to_string()),
                    "password {typed:?} over {:?}",
                    stored.as_ref().map(|r| r.rule)
                );
                assert_eq!(footprint_all(&fx, &a), before, "refused before any write");
            }
        }
    }

    /// `Allowlist` with no password stores the rule with an empty salt and hash, over no row
    /// and over a stored password, which it clears; `effective_rule` reads the stored row as
    /// `Allowlist`, and the rule is in force.
    ///
    /// kills: the old salt or hash kept (a later `Password` with no password would restore
    /// it); a stored `Allowlist` row read as another rule.
    #[test]
    fn allowlist_with_no_password_is_stored_with_an_empty_salt_and_hash() {
        let fx = fixture();
        let a = tables(&fx);
        seed_owner(&a.w, owner());
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Allowlist,
                None,
                Vec::new(),
                T0
            ),
            Ok(())
        );
        assert_eq!(access_row(&a.w), enc(&allowlist_row()), "over no row");
        let rows = a.w.access.rows();
        assert_eq!(effective_rule(rows.first()), WorldAccessRule::Allowlist);
        assert_refused(&fx, &a, id(0x7F), T0 + 1, "the rule is in force");

        assert_eq!(a.w.access.remove(0), 1);
        a.w.access.seed(&password_row());
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Allowlist,
                None,
                Vec::new(),
                T0 + 2
            ),
            Ok(())
        );
        assert_eq!(
            access_row(&a.w),
            enc(&allowlist_row()),
            "the stored password is cleared"
        );
        let before = footprint_all(&fx, &a);
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                None,
                Vec::new(),
                T0 + 3
            ),
            Err(REJECT_PASSWORD_REQUIRED.to_string()),
            "no password is left to keep"
        );
        assert_eq!(footprint_all(&fx, &a), before);
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
                set_access(
                    &fx,
                    owner(),
                    WorldAccessRule::Allowlist,
                    None,
                    Vec::new(),
                    T0
                ),
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
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Allowlist,
                None,
                Vec::new(),
                T0
            ),
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

    /// `Allowlist` to `Password` needs a new password (none is stored). Given one, it stores
    /// its hash, and of the live identities with no admission row only the one the list
    /// admitted (bound under a key the build holds to a listed account) gets a row; one bound
    /// to an account that is not listed (delisted while connected) and one with no binding get
    /// none and are refused under `Password`; a live unbound identity holding a row keeps it;
    /// the live owner gets none.
    ///
    /// kills: `Password` with no password accepted over an `Allowlist` row; every live session
    /// admitted on a rule change (a delisted or never-admitted identity still connected let
    /// in); the identity the list admitted left without a row (locked out of the world it is
    /// in); an existing admission re-stamped; the owner given a row.
    #[test]
    fn allowlist_to_password_needs_a_new_password_and_admits_only_live_identities_the_list_admitted(
    ) {
        let fx = fixture();
        let a = allowlist_world(&fx);
        enlist(&a, &[ALICE]);
        let listed = id(0x86);
        let x = id(0x87);
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
        let before = footprint_all(&fx, &a);
        assert_eq!(
            set_access(&fx, owner(), WorldAccessRule::Password, None, vec![x], T0),
            Err(REJECT_PASSWORD_REQUIRED.to_string())
        );
        assert_eq!(footprint_all(&fx, &a), before, "refused before any write");
        let typed = "pw seven";
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Password,
                Some(typed),
                Vec::new(),
                T0 + 1
            ),
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
        assert_eq!(rows[0].password_salt.len(), PASSWORD_SALT_BYTES);
        assert_eq!(
            rows[0].password_hash,
            hash_password(&rows[0].password_salt, typed)
        );
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
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Allowlist,
                None,
                Vec::new(),
                T0
            ),
            Ok(())
        );
        assert_eq!(admissions(&a.w), vec![(x.to_byte_array(), T0 - 9)]);
        assert_eq!(fx.writes_to("world_admission"), 0);
        assert_eq!(access_row(&a.w), enc(&allowlist_row()));
        assert_eq!(passes(&fx, s, T0 + 1), Err(REJECT_NOT_ADMITTED.to_string()));
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Open,
                None,
                Vec::new(),
                T0 + 2
            ),
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
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Allowlist,
                None,
                vec![x, y],
                T0
            ),
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

    /// The door on an `Allowlist` world is refused with no write, and admits nobody.
    ///
    /// kills: the door working on any rule that is not `Open` (a wrong password counted, or
    /// an admission written).
    #[test]
    fn the_door_on_an_allowlist_world_is_refused_with_no_write() {
        let fx = fixture();
        let a = allowlist_world(&fx);
        let who = id(0x8C);
        let before = footprint_all(&fx, &a);
        for typed in [KAT_PASSWORD, WRONG] {
            assert_eq!(
                door(&fx, who, typed, T0),
                Err(REJECT_NO_PASSWORD_RULE.to_string())
            );
        }
        assert_eq!(footprint_all(&fx, &a), before);
        assert_refused(&fx, &a, who, T0 + 1, "the door admitted nobody");
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
                set_access(
                    &fx,
                    caller,
                    WorldAccessRule::Allowlist,
                    None,
                    vec![caller],
                    T0
                ),
                Err(REJECT_NOT_WORLD_OWNER.to_string()),
                "set_world_access by {}",
                caller.to_hex()
            );
        }
        assert_eq!(footprint_all(&fx, &a), before, "nothing is written");
        assert_eq!(
            set_access(
                &fx,
                owner(),
                WorldAccessRule::Allowlist,
                None,
                Vec::new(),
                T0 + 1
            ),
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
