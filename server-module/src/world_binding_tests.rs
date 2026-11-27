//! World binding, executed against the in-memory host: the attestation verifier, the nonce,
//! bind and unbind reducers, the name and allowlist setters, what a binding means for ownership
//! and for an `Allowlist` world, and the deletion step.
//!
//! Attestations are made here exactly as the account service makes them: a compact JWT whose
//! signature is Ed25519 over `<header segment>.<payload segment>`, signed with the `local-dev`
//! key derived from its public label. One attestation the account service itself produced (the
//! golden one) proves the two sides agree.
//!
//! The host models no rollback, so every refusal here is asserted to leave every registered
//! table exactly as seeded, with no write call at all.

use super::{
    attestation_expired, bind_nonce_expired, bind_world_account, bind_world_account_for,
    binds_nothing, drop_world_binding, erase_world_binding, is_visible_ascii, on_allowlist,
    request_bind_nonce, request_bind_nonce_for, set_world_allowlist, set_world_names,
    verify_attestation, VerifiedAttestation, ACCOUNT_SUBJECT_MAX_BYTES, ATTESTATION_MAX_BYTES,
    BIND_NONCE_BYTES, BIND_NONCE_SWEEP_MAX, BIND_NONCE_TTL_MS, MAX_ALLOWLIST_ACCOUNTS,
    MAX_WORLD_NAMES, REJECT_ALLOWLIST_ACCOUNT, REJECT_ATTESTATION_EXPIRED,
    REJECT_ATTESTATION_MALFORMED, REJECT_ATTESTATION_OTHER_NONCE, REJECT_ATTESTATION_OTHER_WORLD,
    REJECT_ATTESTATION_SIGNATURE, REJECT_ATTESTATION_TOO_LONG, REJECT_ATTESTATION_UNKNOWN_KEY,
    REJECT_DUPLICATE_ENTRY, REJECT_NO_BIND_NONCE, REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS,
    REJECT_TOO_MANY_WORLD_NAMES, REJECT_WORLD_NAME, WORLD_NAME_MAX_BYTES,
};
use crate::account_checks::{RecheckSchedule, WorldAccount};
use crate::accounts::{
    build_profile, AttestationKey, BuildFeatures, BuildProfile, DEV_ATTESTATION_KEYS,
    DEV_LOGIN_ISSUERS, PRODUCTION_ATTESTATION_KEYS,
};
use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::schema::{
    Account, AccountStatus, Config, PlayerSession, WorldAccess, WorldAccessRule, WorldAdmission,
    WorldAllowlist, WorldBindNonce, WorldBinding, WorldName,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};
use spacetimedb::sats::bsatn;
use spacetimedb::{ConnectionId, Identity, ReducerContext, Serialize, Timestamp};

// =====================================================================================
// Shared vocabulary: identities, times, names.
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

fn conn_of(who: Identity) -> u128 {
    0xB1D0_0000 + u128::from(who.to_byte_array()[0])
}

fn at(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms * 1000)
}

/// The clock every attestation below is issued at, in milliseconds.
const T0: i64 = 1_800_000_000_000;
/// The `exp` of a default attestation: issued at `T0`, good for 300 seconds.
const EXP_S: i64 = T0 / 1000 + 300;
/// The time a default bind is presented: inside the attestation's window.
const BIND_AT: i64 = T0 + 1_000;
/// The `expires_at_ms` of a seeded nonce row: after the attestation's own expiry, so a
/// boundary test on `exp` is never decided by the nonce.
const NONCE_EXPIRES: i64 = T0 + 400_000;

const WORLD: &str = "spki:TEST-fingerprint_00/realm-one";
const SUB: &str = "dev:11111111-2222-4333-8444-555555555555";
const OTHER_SUB: &str = "dev:99999999-8888-4777-8666-555555555555";
const THIRD_SUB: &str = "dev:33333333-3333-4333-8333-333333333333";
const NONCE_A: &str = "00112233445566778899aabbccddeeff";
const NONCE_B: &str = "ffeeddccbbaa99887766554433221100";
const NONCE_C: &str = "0123456789abcdef0123456789abcdef";
const BASE_GAME: &str = r#"["base-game"]"#;
/// A `kid` no build holds: a binding made under it counts for nothing.
const RETIRED_KID: &str = "kid-the-build-does-not-hold";

/// The account service's label for its `local-dev` attestation signer
/// (`account-service/src/keys.ts`): the 32 seed bytes are its SHA-256.
const DEV_LABEL: &str = "monster-realm local-dev attestation key 1";

// The golden attestation: made by the account service's own `POST /attest` route (`local-dev`
// profile, clock fixed at 1 800 000 000 s). Three constants, joined at run time.
const GOLDEN_HEADER_SEGMENT: &str =
    "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiWndkYkRWYXdqMW0wT3QtaU52T1VNeWtjMV9oZ3IxZEQ1d1JNcGgzcmdXRSJ9";
const GOLDEN_PAYLOAD_SEGMENT: &str = "eyJpc3MiOiJodHRwOi8vbG9jYWxob3N0OjQ0NTUvYXR0ZXN0Iiwic3ViIjoiZGV2OjZmMWMyYTNiLTBkNGUtNGY1YS04YjZjLTdkOGU5ZjBhMWIyYyIsImF1ZCI6InNwa2k6R09MREVOLWZpbmdlcnByaW50XzAxMjM0NTY3ODlhYmNkZWYvZ29sZGVuLXJlYWxtIiwibm9uY2UiOiIwMDAxMDIwMzA0MDUwNjA3MDgwOTBhMGIwYzBkMGUwZiIsIm1yX2VudCI6WyJiYXNlLWdhbWUiXSwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAzMDAsImp0aSI6IjdmNWUzMDcwLTFhNjUtNDc0NS04ZDJkLTM2MmRkMGY0YjA1ZCJ9";
const GOLDEN_SIGNATURE_SEGMENT: &str =
    "IZBrOypA29W-ER2jKbcanTSTjlhMJ3zslC-TcPymsFShHewySggRoTe2iVlz8fq3nuyd4EGespAmiEKxYKOICg";
const GOLDEN_SUB: &str = "dev:6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c";
const GOLDEN_AUD: &str = "spki:GOLDEN-fingerprint_0123456789abcdef/golden-realm";
const GOLDEN_NONCE: &str = "000102030405060708090a0b0c0d0e0f";
const GOLDEN_EXP_S: i64 = 1_800_000_300;

fn golden() -> String {
    [
        GOLDEN_HEADER_SEGMENT,
        GOLDEN_PAYLOAD_SEGMENT,
        GOLDEN_SIGNATURE_SEGMENT,
    ]
    .join(".")
}

fn sorted<T: Ord>(mut v: Vec<T>) -> Vec<T> {
    v.sort();
    v
}

fn strings(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| (*s).to_string()).collect()
}

fn is_lower_hex_nonce(s: &str) -> bool {
    s.len() == 2 * BIND_NONCE_BYTES && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// =====================================================================================
// The signer and the attestation builder.
// =====================================================================================

/// The `local-dev` signer, derived from its label as the account service derives it.
fn dev_signer() -> SigningKey {
    let digest = Sha256::digest(DEV_LABEL.as_bytes());
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&digest[..]);
    SigningKey::from_bytes(&seed)
}

/// A signer no build lists.
fn other_signer(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

fn dev_kid() -> &'static str {
    DEV_ATTESTATION_KEYS[0].kid
}

fn listed_key(kid: &'static str, signer: &SigningKey) -> AttestationKey {
    AttestationKey {
        kid,
        public_key: signer.verifying_key().to_bytes(),
    }
}

fn leak(keys: Vec<AttestationKey>) -> &'static [AttestationKey] {
    Box::leak(keys.into_boxed_slice())
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The unpadded base64url length of `n` bytes.
fn b64_len(n: usize) -> usize {
    (n * 4).div_ceil(3)
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).expect("a string always serialises")
}

fn header_json(kid: &str) -> String {
    format!(r#"{{"alg":"Ed25519","kid":{}}}"#, json_str(kid))
}

/// A compact attestation over raw header and payload JSON (any bytes at all, so malformed
/// shapes can be made), signed by `signer` over `<header segment>.<payload segment>`.
fn signed(signer: &SigningKey, header: &str, payload: &str) -> String {
    let input = format!("{}.{}", b64(header.as_bytes()), b64(payload.as_bytes()));
    let signature = signer.sign(input.as_bytes()).to_bytes();
    format!("{input}.{}", b64(&signature))
}

/// The three segments of a compact attestation.
fn segments(att: &str) -> [String; 3] {
    let parts: Vec<&str> = att.split('.').collect();
    assert_eq!(parts.len(), 3, "fixture: an attestation of three segments");
    [
        parts[0].to_string(),
        parts[1].to_string(),
        parts[2].to_string(),
    ]
}

/// The claims of an attestation, written in the account service's member order.
#[derive(Clone)]
struct Claims {
    sub: String,
    aud: String,
    nonce: String,
    exp: i64,
    /// The raw JSON of `mr_ent`, or no member at all.
    mr_ent: Option<String>,
    /// Raw JSON members appended after the last one, each starting with a comma.
    extra: String,
}

impl Claims {
    /// For [`SUB`], naming [`WORLD`], carrying `nonce`, expiring at [`EXP_S`], entitled.
    fn new(nonce: &str) -> Self {
        Claims {
            sub: SUB.to_string(),
            aud: WORLD.to_string(),
            nonce: nonce.to_string(),
            exp: EXP_S,
            mr_ent: Some(BASE_GAME.to_string()),
            extra: String::new(),
        }
    }

    fn with_sub(mut self, sub: &str) -> Self {
        self.sub = sub.to_string();
        self
    }

    fn with_aud(mut self, aud: &str) -> Self {
        self.aud = aud.to_string();
        self
    }

    fn with_ent(mut self, raw: Option<&str>) -> Self {
        self.mr_ent = raw.map(str::to_string);
        self
    }

    fn with_extra(mut self, raw: &str) -> Self {
        self.extra = raw.to_string();
        self
    }

    fn json(&self) -> String {
        let ent = self
            .mr_ent
            .as_deref()
            .map(|e| format!(r#","mr_ent":{e}"#))
            .unwrap_or_default();
        format!(
            r#"{{"iss":"http://localhost:4455/attest","sub":{},"aud":{},"nonce":{}{ent},"iat":{},"exp":{},"jti":"5b1c0de0-0000-4000-8000-000000000001"{}}}"#,
            json_str(&self.sub),
            json_str(&self.aud),
            json_str(&self.nonce),
            self.exp - 300,
            self.exp,
            self.extra,
        )
    }
}

/// `claims` signed by the `local-dev` key under its own `kid`.
fn dev_attestation(claims: &Claims) -> String {
    signed(&dev_signer(), &header_json(dev_kid()), &claims.json())
}

/// What `verify_attestation` answers for `claims` signed by the `local-dev` key.
fn expected(claims: &Claims, entitled: bool) -> VerifiedAttestation {
    VerifiedAttestation {
        key_id: dev_kid().to_string(),
        subject: claims.sub.clone(),
        audience: claims.aud.clone(),
        nonce: claims.nonce.clone(),
        expires_at_s: claims.exp,
        entitled,
    }
}

fn verify_dev(att: &str) -> Result<VerifiedAttestation, &'static str> {
    verify_attestation(DEV_ATTESTATION_KEYS, att)
}

/// A `local-dev` attestation exactly `target` bytes long: a long `pad` claim (and, when the
/// payload alone cannot reach the length, a short header member) fills it. Lengths are
/// computed before signing; the signature is always 64 bytes.
fn attestation_of_length(target: usize) -> (String, Claims) {
    let signature_len = b64_len(64);
    for header_pad in 0..3usize {
        let header = if header_pad == 0 {
            header_json(dev_kid())
        } else {
            format!(
                r#"{{"alg":"Ed25519","kid":{},"hp":"{}"}}"#,
                json_str(dev_kid()),
                "h".repeat(header_pad)
            )
        };
        let header_len = b64_len(header.len());
        for payload_pad in 0..target {
            let claims = Claims::new(NONCE_A)
                .with_extra(&format!(r#","pad":"{}""#, "p".repeat(payload_pad)));
            let total = header_len + 1 + b64_len(claims.json().len()) + 1 + signature_len;
            if total == target {
                let att = signed(&dev_signer(), &header, &claims.json());
                assert_eq!(att.len(), target, "fixture: the computed length holds");
                return (att, claims);
            }
            if total > target {
                break;
            }
        }
    }
    panic!("fixture: no attestation of exactly {target} bytes")
}

// =====================================================================================
// The world: every table the binding paths read or write.
// =====================================================================================

struct W<'a> {
    config: Handle<'a, Config, u32>,
    access: Handle<'a, WorldAccess, u32>,
    admission: Handle<'a, WorldAdmission>,
    account: Handle<'a, Account>,
    session: Handle<'a, PlayerSession>,
    binding: Handle<'a, WorldBinding>,
    nonce: Handle<'a, WorldBindNonce>,
    names: Handle<'a, WorldName, String>,
    allow: Handle<'a, WorldAllowlist, String>,
    accounts: Handle<'a, WorldAccount>,
    rechecks: Handle<'a, RecheckSchedule>,
}

/// A handle as the account service answers one: `<kid>.<base64url>`.
const HANDLE: &str = "k1.AbCdEf0123456789-_";
/// Another account's handle.
const OTHER_HANDLE: &str = "k1.ZyXwVu9876543210_-";
/// The world owner's handle.
const OWNER_HANDLE: &str = "k1.OwNeR0123456789abcd";

/// `who`'s checked account under `handle`.
fn account_row(who: Identity, handle: &str, entitled: bool, checked_at_ms: i64) -> WorldAccount {
    WorldAccount {
        handle: handle.to_string(),
        identity: who,
        entitled,
        checked_at_ms,
        is_host: false,
    }
}

/// `who`'s armed re-check numbered `n`.
fn recheck_row(who: Identity, n: u64) -> RecheckSchedule {
    RecheckSchedule {
        scheduled_id: n,
        scheduled_at: spacetimedb::ScheduleAt::Time(at(T0 + 1)),
        identity: who,
    }
}

/// Registers what the binding, nonce, setter and connect paths touch. `config`,
/// `world_access`, `world_admission` and `account` are read-only here: a write to one aborts
/// the test. The nonce table is registered on its `expires_at_ms` index too, so the sweep's
/// range read finds rows; the name and allowlist tables are scannable so a setter can replace
/// the whole set.
fn world(fx: &Fixture) -> W<'_> {
    let _ = fx
        .table_keyed::<PlayerSession, ConnectionId>("player_session", "connection_id", |r| {
            r.connection_id
        })
        .unique();
    let _ = fx.table_keyed::<WorldBindNonce, i64>("world_bind_nonce", "expires_at_ms", |r| {
        r.expires_at_ms
    });
    W {
        config: fx
            .table_keyed::<Config, u32>("config", "id", |r| r.id)
            .unique(),
        access: fx
            .table_keyed::<WorldAccess, u32>("world_access", "id", |r| r.id)
            .unique(),
        admission: fx
            .table::<WorldAdmission>("world_admission", "identity", |r| r.identity)
            .unique(),
        account: fx
            .table::<Account>("account", "identity", |r| r.identity)
            .unique(),
        session: fx
            .table::<PlayerSession>("player_session", "identity", |r| r.identity)
            .writable()
            .scannable(),
        binding: fx
            .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
            .unique()
            .writable(),
        nonce: fx
            .table::<WorldBindNonce>("world_bind_nonce", "identity", |r| r.identity)
            .unique()
            .writable(),
        names: fx
            .table_keyed::<WorldName, String>("world_name", "name", |r| r.name.clone())
            .unique()
            .writable()
            .scannable(),
        allow: fx
            .table_keyed::<WorldAllowlist, String>("world_allowlist", "account_subject", |r| {
                r.account_subject.clone()
            })
            .unique()
            .writable()
            .scannable(),
        accounts: {
            let _ = fx
                .table_keyed::<WorldAccount, String>("world_account", "handle", |r| {
                    r.handle.clone()
                })
                .unique();
            fx.table::<WorldAccount>("world_account", "identity", |r| r.identity)
                .unique()
                .writable()
                .scannable()
        },
        rechecks: {
            let _ = fx
                .table_keyed::<RecheckSchedule, u64>("recheck_schedule", "scheduled_id", |r| {
                    r.scheduled_id
                })
                .unique();
            fx.table::<RecheckSchedule>("recheck_schedule", "identity", |r| r.identity)
                .unique()
                .writable()
        },
    }
}

/// A world owned by [`owner`].
fn owned_world(fx: &Fixture) -> W<'_> {
    let w = world(fx);
    w.config.seed(&Config {
        id: 0,
        content_version: 0,
        owner_identity: owner(),
    });
    w
}

/// An `Open` world named [`WORLD`] where [`alice`] holds [`NONCE_A`], and a bystander,
/// [`bob`], holds a nonce of its own and a binding: a default attestation from `alice` binds
/// here, and nothing of `bob`'s may change.
fn valid_world(fx: &Fixture) -> W<'_> {
    let w = owned_world(fx);
    seed_names(&w, &[WORLD]);
    w.nonce.seed(&nonce_row(alice(), NONCE_A, NONCE_EXPIRES));
    w.nonce.seed(&nonce_row(bob(), NONCE_B, NONCE_EXPIRES));
    w.binding
        .seed(&binding_row(bob(), OTHER_SUB, T0 - 5_000, true, dev_kid()));
    w
}

fn seed_names(w: &W<'_>, names: &[&str]) {
    for name in names {
        w.names.seed(&WorldName {
            name: (*name).to_string(),
        });
    }
}

fn seed_allowed(w: &W<'_>, accounts: &[&str]) {
    for account in accounts {
        w.allow.seed(&WorldAllowlist {
            account_subject: (*account).to_string(),
        });
    }
}

fn nonce_row(who: Identity, nonce: &str, expires_at_ms: i64) -> WorldBindNonce {
    WorldBindNonce {
        identity: who,
        nonce: nonce.to_string(),
        expires_at_ms,
    }
}

fn binding_row(
    who: Identity,
    subject: &str,
    bound_at_ms: i64,
    entitled: bool,
    kid: &str,
) -> WorldBinding {
    WorldBinding {
        identity: who,
        account_subject: subject.to_string(),
        bound_at_ms,
        entitled,
        key_id: kid.to_string(),
    }
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
        auth_issuer: DEV_LOGIN_ISSUERS[0].to_string(),
        created_at_ms: 10,
        last_login_at_ms: 20,
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(30),
        claimed_from: None,
        claimed_at_ms: None,
        terminal_at_ms: None,
    }
}

fn rule_row(rule: WorldAccessRule) -> WorldAccess {
    let (password_salt, password_hash) = if rule == WorldAccessRule::Password {
        (vec![1; 16], vec![2; 32])
    } else {
        (Vec::new(), Vec::new())
    };
    WorldAccess {
        id: 0,
        rule,
        password_salt,
        password_hash,
    }
}

// =====================================================================================
// Observations.
// =====================================================================================

type BindingView = ([u8; 32], String, i64, bool, String);
type NonceView = ([u8; 32], String, i64);
type Footprint = Vec<(&'static str, Vec<Vec<u8>>, u32)>;

fn bview(who: Identity, subject: &str, bound_at_ms: i64, entitled: bool, kid: &str) -> BindingView {
    (
        who.to_byte_array(),
        subject.to_string(),
        bound_at_ms,
        entitled,
        kid.to_string(),
    )
}

fn nview(who: Identity, nonce: &str, expires_at_ms: i64) -> NonceView {
    (who.to_byte_array(), nonce.to_string(), expires_at_ms)
}

/// The binding rows, sorted.
fn bindings(w: &W<'_>) -> Vec<BindingView> {
    sorted(
        w.binding
            .rows()
            .into_iter()
            .map(|r| {
                (
                    r.identity.to_byte_array(),
                    r.account_subject,
                    r.bound_at_ms,
                    r.entitled,
                    r.key_id,
                )
            })
            .collect(),
    )
}

/// The nonce rows, sorted.
fn nonces(w: &W<'_>) -> Vec<NonceView> {
    sorted(
        w.nonce
            .rows()
            .into_iter()
            .map(|r| (r.identity.to_byte_array(), r.nonce, r.expires_at_ms))
            .collect(),
    )
}

/// `who`'s nonce, if it holds one.
fn nonce_of(w: &W<'_>, who: Identity) -> Option<(String, i64)> {
    w.nonce
        .rows()
        .into_iter()
        .find(|r| r.identity == who)
        .map(|r| (r.nonce, r.expires_at_ms))
}

fn names(w: &W<'_>) -> Vec<String> {
    sorted(w.names.rows().into_iter().map(|r| r.name).collect())
}

fn allowed(w: &W<'_>) -> Vec<String> {
    sorted(
        w.allow
            .rows()
            .into_iter()
            .map(|r| r.account_subject)
            .collect(),
    )
}

fn sessions_of(w: &W<'_>, who: Identity) -> Vec<u128> {
    sorted(
        w.session
            .rows()
            .into_iter()
            .filter(|r| r.identity == who)
            .map(|r| r.connection_id.to_u128())
            .collect(),
    )
}

fn enc<T: Serialize>(row: &T) -> Vec<u8> {
    bsatn::to_vec(row).expect("a row always BSATN-encodes")
}

fn encs<T: Serialize>(rows: &[T]) -> Vec<Vec<u8>> {
    sorted(rows.iter().map(enc).collect())
}

/// Every stored row of every registered table, with each table's write count.
fn footprint(fx: &Fixture, w: &W<'_>) -> Footprint {
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
        ("account", encs(&w.account.rows()), fx.writes_to("account")),
        (
            "player_session",
            encs(&w.session.rows()),
            fx.writes_to("player_session"),
        ),
        (
            "world_binding",
            encs(&w.binding.rows()),
            fx.writes_to("world_binding"),
        ),
        (
            "world_bind_nonce",
            encs(&w.nonce.rows()),
            fx.writes_to("world_bind_nonce"),
        ),
        (
            "world_name",
            encs(&w.names.rows()),
            fx.writes_to("world_name"),
        ),
        (
            "world_allowlist",
            encs(&w.allow.rows()),
            fx.writes_to("world_allowlist"),
        ),
        (
            "world_account",
            encs(&w.accounts.rows()),
            fx.writes_to("world_account"),
        ),
        (
            "recheck_schedule",
            encs(&w.rechecks.rows()),
            fx.writes_to("recheck_schedule"),
        ),
    ]
}

/// `act` answers exactly `want`, and every registered table holds what it held before, with
/// no write call made.
fn assert_refused(
    fx: &Fixture,
    w: &W<'_>,
    want: &str,
    label: &str,
    act: impl FnOnce() -> Result<(), String>,
) {
    fx.reset_writes();
    let before = footprint(fx, w);
    assert_eq!(act(), Err(want.to_string()), "{label}");
    assert_eq!(
        footprint(fx, w),
        before,
        "{label}: every table as seeded, and no write call"
    );
}

// =====================================================================================
// Calls, each over an anonymous client connection of the caller.
// =====================================================================================

fn call<T>(fx: &Fixture, who: Identity, ms: i64, f: impl FnOnce(&ReducerContext) -> T) -> T {
    fx.run_as_conn_at(who, conn_of(who), None, at(ms), f)
}

fn bind(fx: &Fixture, who: Identity, ms: i64, att: &str) -> Result<(), String> {
    call(fx, who, ms, |ctx| bind_world_account(ctx, att.to_string()))
}

fn bind_for(
    fx: &Fixture,
    caller: Identity,
    who: Identity,
    ms: i64,
    att: &str,
) -> Result<(), String> {
    call(fx, caller, ms, |ctx| {
        bind_world_account_for(ctx, who, att.to_string())
    })
}

fn ask(fx: &Fixture, who: Identity, ms: i64) -> Result<(), String> {
    call(fx, who, ms, request_bind_nonce)
}

fn ask_for(fx: &Fixture, caller: Identity, who: Identity, ms: i64) -> Result<(), String> {
    call(fx, caller, ms, |ctx| request_bind_nonce_for(ctx, who))
}

fn set_names(fx: &Fixture, caller: Identity, list: Vec<String>) -> Result<(), String> {
    call(fx, caller, T0, |ctx| set_world_names(ctx, list))
}

fn set_allow(fx: &Fixture, caller: Identity, list: Vec<String>) -> Result<(), String> {
    call(fx, caller, T0, |ctx| set_world_allowlist(ctx, list))
}

fn passes(fx: &Fixture, who: Identity, ms: i64) -> Result<(), String> {
    call(fx, who, ms, |ctx| {
        crate::access::require_admitted(ctx, "probe")
    })
}

/// `who` erases its own binding (`unbind_world_account`).
fn unbind(fx: &Fixture, who: Identity, ms: i64) -> Result<(), String> {
    call(fx, who, ms, super::unbind_world_account)
}

/// `caller` drops the binding of `who` (`drop_world_binding`).
fn drop_binding_of(fx: &Fixture, caller: Identity, who: Identity, ms: i64) -> Result<(), String> {
    call(fx, caller, ms, |ctx| drop_world_binding(ctx, who))
}

// =====================================================================================
// The real `join_game` world, for the build modules (registered here: the movement suite's
// join helpers are private to it).
// =====================================================================================

#[allow(dead_code)]
mod join_fixture {
    use super::{at, conn_of, encs};
    use crate::movement::MovementTickSchedule;
    use crate::native_host_tests::{Fixture, Handle};
    use crate::schema::{
        Battle, Character, Inventory, LastPosition, Monster, MonsterPub, MoveIntent, Player,
        PlayerDialogueStateRow, PlayerHandle, PlayerWallet, SpeciesRow, TradeOffer,
    };
    use game_core::Affinity;
    use spacetimedb::Identity;

    pub(super) struct JoinWorld<'a> {
        pub(super) players: Handle<'a, Player>,
        chars: Handle<'a, Character, u64>,
        intents: Handle<'a, MoveIntent, u64>,
        monsters: Handle<'a, Monster, u64>,
        pubs: Handle<'a, MonsterPub, u64>,
        ticks: Handle<'a, MovementTickSchedule, u64>,
        saved: Handle<'a, LastPosition>,
        inventory: Handle<'a, Inventory>,
        wallet: Handle<'a, PlayerWallet>,
        dialogue: Handle<'a, PlayerDialogueStateRow>,
        handle: Handle<'a, PlayerHandle>,
        species: Handle<'a, SpeciesRow, u32>,
    }

    fn species1() -> SpeciesRow {
        SpeciesRow {
            id: 1,
            name: "s1".to_string(),
            base_hp: 30,
            base_attack: 31,
            base_defense: 32,
            base_speed: 33,
            base_sp_attack: 34,
            base_sp_defense: 35,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![1],
            ability: None,
            tier: 0,
        }
    }

    /// Every table a first join reads or writes: the caller's presence (`player`,
    /// `character`, `move_intent`), the zone tick, both battle-role indexes, the trade
    /// indexes, the starter monster (`monster`, `monster_pub`, auto-inc keys), the saved
    /// position, the starter kit (`inventory`, `player_wallet`, `player_dialogue_state`) and
    /// the handle the join mints.
    pub(super) fn join_world(fx: &Fixture) -> JoinWorld<'_> {
        let _ = fx.table_keyed::<Player, u64>("player", "entity_id", |r| r.entity_id);
        let _ = fx.table_keyed::<Character, u32>("character", "zone_id", |r| r.zone_id);
        let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
        let _ = fx.table::<Battle>("battle", "player_identity", |r| r.player_identity);
        let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
        let _ = fx.table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator);
        let _ = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
        let _ = fx.table_composite::<Monster, Identity, u8>(
            "monster",
            ["owner_identity", "party_slot"],
            |r| (r.owner_identity, r.party_slot),
        );
        let species = fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id);
        species.seed(&species1());
        let inventory = fx
            .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
            .writable()
            .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
        let _ = fx
            .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
            .unique();
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
        JoinWorld {
            players: fx
                .table::<Player>("player", "identity", |r| r.identity)
                .writable()
                .unique(),
            chars: fx
                .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
                .writable()
                .unique()
                .auto_inc(|r| r.entity_id, |r, id| r.entity_id = id),
            intents: fx
                .table_keyed::<MoveIntent, u64>("move_intent", "entity_id", |r| r.entity_id)
                .writable()
                .unique(),
            monsters: fx
                .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
                .writable()
                .unique()
                .auto_inc(|r| r.monster_id, |r, id| r.monster_id = id),
            pubs: fx
                .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
                .writable()
                .unique(),
            ticks: fx
                .table_keyed::<MovementTickSchedule, u64>("movement_tick_schedule", "id", |r| r.id)
                .writable()
                .scannable()
                .unique()
                .auto_inc(|r| r.id, |r, v| r.id = v),
            saved: fx
                .table::<LastPosition>("last_position", "owner_identity", |r| r.owner_identity)
                .writable()
                .unique(),
            inventory,
            wallet: fx
                .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
                .writable()
                .unique(),
            dialogue: fx
                .table::<PlayerDialogueStateRow>("player_dialogue_state", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable()
                .unique(),
            handle,
            species,
        }
    }

    /// Every row of every join table, with each table's write count.
    pub(super) fn join_footprint(fx: &Fixture, jw: &JoinWorld<'_>) -> super::Footprint {
        vec![
            ("player", encs(&jw.players.rows()), fx.writes_to("player")),
            (
                "character",
                encs(&jw.chars.rows()),
                fx.writes_to("character"),
            ),
            (
                "move_intent",
                encs(&jw.intents.rows()),
                fx.writes_to("move_intent"),
            ),
            (
                "monster",
                encs(&jw.monsters.rows()),
                fx.writes_to("monster"),
            ),
            (
                "monster_pub",
                encs(&jw.pubs.rows()),
                fx.writes_to("monster_pub"),
            ),
            (
                "movement_tick_schedule",
                encs(&jw.ticks.rows()),
                fx.writes_to("movement_tick_schedule"),
            ),
            (
                "last_position",
                encs(&jw.saved.rows()),
                fx.writes_to("last_position"),
            ),
            (
                "inventory",
                encs(&jw.inventory.rows()),
                fx.writes_to("inventory"),
            ),
            (
                "player_wallet",
                encs(&jw.wallet.rows()),
                fx.writes_to("player_wallet"),
            ),
            (
                "player_dialogue_state",
                encs(&jw.dialogue.rows()),
                fx.writes_to("player_dialogue_state"),
            ),
            (
                "player_handle",
                encs(&jw.handle.rows()),
                fx.writes_to("player_handle"),
            ),
            (
                "species_row",
                encs(&jw.species.rows()),
                fx.writes_to("species_row"),
            ),
        ]
    }

    /// The names of `who`'s `player` rows.
    pub(super) fn joined(jw: &JoinWorld<'_>, who: Identity) -> Vec<String> {
        jw.players
            .rows()
            .into_iter()
            .filter(|p| p.identity == who)
            .map(|p| p.name)
            .collect()
    }

    /// The real `join_game` as `who`, over a client connection carrying `jwt` (`None`: no
    /// token at all).
    pub(super) fn join(
        fx: &Fixture,
        who: Identity,
        jwt: Option<&str>,
        ms: i64,
    ) -> Result<(), String> {
        fx.run_as_conn_at(who, conn_of(who), jwt, at(ms), |ctx| {
            crate::movement::join_game(ctx, "Ada".to_string())
        })
    }
}

// =====================================================================================
// A verified attestation binds the identity and spends its nonce.
// =====================================================================================

mod bind_accepts {
    use super::*;

    /// The sender's binding is the attestation's account, the call's time, its entitlement
    /// and the signing key's `kid`; its nonce row goes; the bystander's nonce and binding and
    /// the world's names stay.
    ///
    /// kills: the binding keyed on anything but the sender; `bound_at_ms` not the call's time;
    /// `key_id` not the header's `kid`; the nonce kept; another identity's rows touched.
    #[test]
    fn a_verified_attestation_binds_the_sender_by_value_and_spends_its_nonce_lpw15_1() {
        let fx = fixture();
        let w = valid_world(&fx);
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_eq!(bind(&fx, alice(), BIND_AT, &att), Ok(()));
        assert_eq!(
            bindings(&w),
            sorted(vec![
                bview(alice(), SUB, BIND_AT, true, dev_kid()),
                bview(bob(), OTHER_SUB, T0 - 5_000, true, dev_kid()),
            ]),
            "the sender is bound by value; the bystander's binding is untouched"
        );
        assert_eq!(
            nonces(&w),
            vec![nview(bob(), NONCE_B, NONCE_EXPIRES)],
            "the sender's nonce is spent; the bystander's stays"
        );
        assert_eq!(names(&w), strings(&[WORLD]), "the names are untouched");
        assert!(w.admission.rows().is_empty(), "binding admits nobody");
    }

    /// `entitled` is whether one `mr_ent` element equals `base-game`, byte for byte.
    ///
    /// kills: `entitled` always true; a substring or prefix match; a case-folded match; only
    /// the first element read; a missing `mr_ent` read as entitled.
    #[test]
    fn entitled_is_true_only_when_an_mr_ent_element_is_the_base_game_lpw15_1() {
        let cases: [(Option<&str>, bool); 8] = [
            (None, false),
            (Some("[]"), false),
            (Some(r#"["dlc-x"]"#), false),
            (Some(r#"["xbase-gamex"]"#), false),
            (Some(r#"["base-game-2"]"#), false),
            (Some(r#"["BASE-GAME"]"#), false),
            (Some(r#"["other","base-game"]"#), true),
            (Some(BASE_GAME), true),
        ];
        for (raw, want) in cases {
            let label = raw.unwrap_or("no mr_ent");
            let claims = Claims::new(NONCE_A).with_ent(raw);
            let att = dev_attestation(&claims);
            assert_eq!(
                verify_dev(&att),
                Ok(expected(&claims, want)),
                "{label}: the verifier's answer"
            );
            let fx = fixture();
            let w = valid_world(&fx);
            assert_eq!(bind(&fx, alice(), BIND_AT, &att), Ok(()), "{label}: binds");
            assert!(
                bindings(&w).contains(&bview(alice(), SUB, BIND_AT, want, dev_kid())),
                "{label}: bound with entitled == {want}, got {:?}",
                bindings(&w)
            );
        }
    }

    /// The owner relays `who`'s attestation: `who` is bound and its nonce spent; the owner
    /// gains no binding and keeps its own nonce.
    ///
    /// kills: the relayed form binding the sender; the sender's nonce spent instead of `who`'s.
    #[test]
    fn the_owner_relays_an_attestation_and_binds_who_not_itself_lpw15_1() {
        let fx = fixture();
        let w = valid_world(&fx);
        w.nonce.seed(&nonce_row(owner(), NONCE_C, NONCE_EXPIRES));
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_eq!(bind_for(&fx, owner(), alice(), BIND_AT, &att), Ok(()));
        assert_eq!(
            bindings(&w),
            sorted(vec![
                bview(alice(), SUB, BIND_AT, true, dev_kid()),
                bview(bob(), OTHER_SUB, T0 - 5_000, true, dev_kid()),
            ])
        );
        assert_eq!(
            nonces(&w),
            sorted(vec![
                nview(bob(), NONCE_B, NONCE_EXPIRES),
                nview(owner(), NONCE_C, NONCE_EXPIRES),
            ]),
            "who's nonce is spent; the owner's stays"
        );
    }

    /// A later bind with a fresh nonce replaces the identity's one row: the same account with
    /// another entitlement, then another account.
    ///
    /// kills: the first binding kept; a second row for one identity; the entitlement or the
    /// time not refreshed.
    #[test]
    fn a_later_bind_with_a_fresh_nonce_replaces_the_identitys_binding_lpw15_1() {
        let fx = fixture();
        let w = valid_world(&fx);
        let bob_row = bview(bob(), OTHER_SUB, T0 - 5_000, true, dev_kid());
        assert_eq!(
            bind(
                &fx,
                alice(),
                BIND_AT,
                &dev_attestation(&Claims::new(NONCE_A))
            ),
            Ok(())
        );
        w.nonce.seed(&nonce_row(alice(), NONCE_C, NONCE_EXPIRES));
        let unentitled = Claims::new(NONCE_C).with_ent(None);
        assert_eq!(
            bind(&fx, alice(), BIND_AT + 10, &dev_attestation(&unentitled)),
            Ok(())
        );
        assert_eq!(
            bindings(&w),
            sorted(vec![
                bview(alice(), SUB, BIND_AT + 10, false, dev_kid()),
                bob_row.clone()
            ]),
            "the same account, its entitlement replaced"
        );
        w.nonce.seed(&nonce_row(alice(), NONCE_A, NONCE_EXPIRES));
        let another = Claims::new(NONCE_A).with_sub(THIRD_SUB);
        assert_eq!(
            bind(&fx, alice(), BIND_AT + 20, &dev_attestation(&another)),
            Ok(())
        );
        assert_eq!(
            bindings(&w),
            sorted(vec![
                bview(alice(), THIRD_SUB, BIND_AT + 20, true, dev_kid()),
                bob_row
            ]),
            "another account replaces the binding"
        );
        assert_eq!(nonce_of(&w, alice()), None);
    }

    /// The attestation the account service produced binds on a world that holds its `aud`
    /// for the identity holding its nonce, inside its window.
    ///
    /// kills: a verifier or signing input that disagrees with the account service (segment
    /// order, the signed bytes, the base64 flavour, the claim names).
    #[test]
    fn the_account_services_golden_attestation_binds_lpw15_1() {
        let clock = GOLDEN_EXP_S * 1000 - 295_000;
        let want = VerifiedAttestation {
            key_id: dev_kid().to_string(),
            subject: GOLDEN_SUB.to_string(),
            audience: GOLDEN_AUD.to_string(),
            nonce: GOLDEN_NONCE.to_string(),
            expires_at_s: GOLDEN_EXP_S,
            entitled: true,
        };
        assert_eq!(verify_dev(&golden()), Ok(want));
        let fx = fixture();
        let w = owned_world(&fx);
        seed_names(&w, &[GOLDEN_AUD]);
        w.nonce.seed(&nonce_row(
            alice(),
            GOLDEN_NONCE,
            GOLDEN_EXP_S * 1000 + 60_000,
        ));
        assert_eq!(bind(&fx, alice(), clock, &golden()), Ok(()));
        assert_eq!(
            bindings(&w),
            vec![bview(alice(), GOLDEN_SUB, clock, true, dev_kid())]
        );
        assert!(nonces(&w).is_empty(), "the golden nonce is spent");
    }

    /// `request_bind_nonce` leaves the sender exactly one row: 32 lowercase hex characters
    /// expiring `BIND_NONCE_TTL_MS` after the call. Asking again replaces it; another
    /// identity's row is its own.
    ///
    /// kills: a second row per identity; an expiry not the call's time plus the TTL; a nonce
    /// that is not 32 lowercase hex; a row keyed on anything but the sender; a request that
    /// rewrites another identity's row.
    #[test]
    fn requesting_a_nonce_leaves_the_sender_one_fresh_hex_row_lpw15_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        assert_eq!(ask(&fx, alice(), T0), Ok(()));
        let rows = nonces(&w);
        assert_eq!(rows.len(), 1, "one row: {rows:?}");
        assert_eq!(rows[0].0, alice().to_byte_array(), "the sender's row");
        assert!(
            is_lower_hex_nonce(&rows[0].1),
            "32 lowercase hex: {}",
            rows[0].1
        );
        assert_eq!(rows[0].2, T0 + BIND_NONCE_TTL_MS);

        let later = T0 + 7_000;
        assert_eq!(ask(&fx, alice(), later), Ok(()));
        let rows = nonces(&w);
        assert_eq!(rows.len(), 1, "asking again leaves one row: {rows:?}");
        assert_eq!(rows[0].0, alice().to_byte_array());
        assert!(
            is_lower_hex_nonce(&rows[0].1),
            "32 lowercase hex: {}",
            rows[0].1
        );
        assert_eq!(
            rows[0].2,
            later + BIND_NONCE_TTL_MS,
            "the row is replaced: it expires a TTL after the second call"
        );
        let alices = rows[0].clone();

        assert_eq!(ask(&fx, bob(), later + 1), Ok(()));
        let rows = nonces(&w);
        assert_eq!(rows.len(), 2, "two identities, two rows: {rows:?}");
        assert!(
            rows.contains(&alices),
            "alice's row is untouched by bob's request"
        );
        let bobs = rows
            .iter()
            .find(|r| r.0 == bob().to_byte_array())
            .expect("bob holds a row");
        assert!(is_lower_hex_nonce(&bobs.1));
        assert_eq!(bobs.2, later + 1 + BIND_NONCE_TTL_MS);
    }

    /// The owner asks for `who`'s nonce: `who` holds the row, the owner none.
    ///
    /// kills: the relayed form keyed on the sender.
    #[test]
    fn the_owner_requests_a_nonce_for_who_lpw15_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        assert_eq!(ask_for(&fx, owner(), alice(), T0), Ok(()));
        let rows = nonces(&w);
        assert_eq!(rows.len(), 1, "one row: {rows:?}");
        assert_eq!(
            rows[0].0,
            alice().to_byte_array(),
            "who's row, not the owner's"
        );
        assert!(is_lower_hex_nonce(&rows[0].1));
        assert_eq!(rows[0].2, T0 + BIND_NONCE_TTL_MS);
    }

    /// The 16 bytes a nonce's 32 lowercase hex characters spell.
    fn nonce_bytes(nonce: &str) -> [u8; BIND_NONCE_BYTES] {
        assert!(is_lower_hex_nonce(nonce), "32 lowercase hex: {nonce}");
        let mut out = [0u8; BIND_NONCE_BYTES];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&nonce[2 * i..2 * i + 2], 16).expect("hex");
        }
        out
    }

    /// `who`'s nonce XORed with the first 16 bytes of `who`: the random bytes it was made of.
    fn unmasked(w: &W<'_>, who: Identity) -> [u8; BIND_NONCE_BYTES] {
        let (nonce, _) = nonce_of(w, who).expect("the identity holds a nonce");
        let mut out = nonce_bytes(&nonce);
        for (byte, mask) in out.iter_mut().zip(who.to_byte_array()) {
            *byte ^= mask;
        }
        out
    }

    /// Two identities asking at the same instant hold different nonces, through
    /// `request_bind_nonce` and through the owner's `request_bind_nonce_for` alike.
    ///
    /// kills: a nonce of the call's random bytes alone (the same for every identity at one
    /// instant); the identity mixed into one form and not the other.
    #[test]
    fn two_identities_asking_at_one_instant_hold_different_nonces_lpw15_1() {
        {
            let fx = fixture();
            let w = owned_world(&fx);
            assert_eq!(ask(&fx, alice(), T0), Ok(()));
            assert_eq!(ask(&fx, bob(), T0), Ok(()));
            let a = nonce_of(&w, alice()).expect("alice holds a nonce");
            let b = nonce_of(&w, bob()).expect("bob holds a nonce");
            assert_ne!(a.0, b.0, "request_bind_nonce at one instant");
        }
        {
            let fx = fixture();
            let w = owned_world(&fx);
            assert_eq!(ask_for(&fx, owner(), alice(), T0), Ok(()));
            assert_eq!(ask_for(&fx, owner(), bob(), T0), Ok(()));
            let a = nonce_of(&w, alice()).expect("alice holds a nonce");
            let b = nonce_of(&w, bob()).expect("bob holds a nonce");
            assert_ne!(a.0, b.0, "request_bind_nonce_for at one instant");
        }
    }

    /// One identity asking at two instants holds a different nonce the second time, and
    /// three identities asking at three instants hold three distinct nonces.
    ///
    /// kills: a constant nonce (or a constant mixed with the identity); a nonce that is not
    /// replaced when asked again.
    #[test]
    fn nonces_asked_at_different_instants_differ_lpw15_1() {
        {
            let fx = fixture();
            let w = owned_world(&fx);
            assert_eq!(ask(&fx, alice(), T0), Ok(()));
            let first = nonce_of(&w, alice()).expect("alice holds a nonce").0;
            assert_eq!(ask(&fx, alice(), T0 + 7_000), Ok(()));
            let second = nonce_of(&w, alice()).expect("alice holds a nonce").0;
            assert_ne!(first, second, "the same identity at two instants");
        }
        {
            let fx = fixture();
            let w = owned_world(&fx);
            let carol = id(0x33);
            assert_eq!(ask(&fx, alice(), T0), Ok(()));
            assert_eq!(ask(&fx, bob(), T0 + 1), Ok(()));
            assert_eq!(ask(&fx, carol, T0 + 2), Ok(()));
            let mut held: Vec<String> = [alice(), bob(), carol]
                .into_iter()
                .map(|who| nonce_of(&w, who).expect("each holds a nonce").0)
                .collect();
            held.sort();
            held.dedup();
            assert_eq!(
                held.len(),
                3,
                "three identities at three instants: {held:?}"
            );
        }
    }

    /// A nonce is the call instant's 16 random bytes XORed with the first 16 bytes of the
    /// identity it is for: every call at one instant, by either form, unmasks to the same 16
    /// bytes, whatever they are.
    ///
    /// kills: the identity mixed in some other way (hashed, appended, the last 16 bytes); a
    /// relayed form that mixes in the sender rather than `who`.
    #[test]
    fn a_nonce_is_the_instants_random_bytes_xored_with_the_identitys_first_16_bytes_lpw15_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        let carol = id(0x33);
        let dave = id(0x44);
        assert_eq!(ask(&fx, alice(), T0), Ok(()));
        assert_eq!(ask(&fx, bob(), T0), Ok(()));
        assert_eq!(ask_for(&fx, owner(), carol, T0), Ok(()));
        assert_eq!(ask_for(&fx, owner(), dave, T0), Ok(()));
        let random = unmasked(&w, alice());
        assert_eq!(unmasked(&w, bob()), random, "bob, asking itself");
        assert_eq!(unmasked(&w, carol), random, "carol, asked for by the owner");
        assert_eq!(unmasked(&w, dave), random, "dave, asked for by the owner");
    }

    /// The header's `alg`, and every member but `kid`, is never read: `none`, `ES256`, no
    /// `alg` and an extra member all verify under a correct Ed25519 signature.
    ///
    /// kills: a verifier that trusts or checks the header's `alg`; one that refuses unknown
    /// header members.
    #[test]
    fn the_headers_alg_is_never_read_lpw15_1() {
        let claims = Claims::new(NONCE_A);
        let kid = json_str(dev_kid());
        for header in [
            format!(r#"{{"alg":"none","kid":{kid}}}"#),
            format!(r#"{{"alg":"ES256","kid":{kid}}}"#),
            format!(r#"{{"kid":{kid}}}"#),
            format!(r#"{{"typ":"JWT","kid":{kid},"alg":"HS256"}}"#),
        ] {
            let att = signed(&dev_signer(), &header, &claims.json());
            assert_eq!(verify_dev(&att), Ok(expected(&claims, true)), "{header}");
        }
    }

    /// With two keys listed, a token verifies under either `kid` and reports that `kid`.
    ///
    /// kills: only the first key tried; `key_id` taken from the first listed key.
    #[test]
    fn a_list_of_two_keys_verifies_under_either_kid_and_reports_it_lpw15_1() {
        let second = other_signer(7);
        let claims = Claims::new(NONCE_A);
        let by_second = signed(&second, &header_json("second-kid"), &claims.json());
        let by_dev = dev_attestation(&claims);
        for keys in [
            leak(vec![
                DEV_ATTESTATION_KEYS[0],
                listed_key("second-kid", &second),
            ]),
            leak(vec![
                listed_key("second-kid", &second),
                DEV_ATTESTATION_KEYS[0],
            ]),
        ] {
            assert_eq!(
                verify_attestation(keys, &by_second),
                Ok(VerifiedAttestation {
                    key_id: "second-kid".to_string(),
                    ..expected(&claims, true)
                })
            );
            assert_eq!(
                verify_attestation(keys, &by_dev),
                Ok(expected(&claims, true))
            );
        }
    }

    /// One millisecond before `exp * 1000` the bind is accepted.
    ///
    /// kills: `>` replaced by `>=` the wrong way round (expiry a millisecond early); seconds
    /// compared with milliseconds.
    #[test]
    fn one_millisecond_before_exp_the_bind_is_accepted_lpw15_1() {
        let fx = fixture();
        let w = valid_world(&fx);
        let clock = EXP_S * 1000 - 1;
        assert_eq!(
            bind(&fx, alice(), clock, &dev_attestation(&Claims::new(NONCE_A))),
            Ok(())
        );
        assert!(bindings(&w).contains(&bview(alice(), SUB, clock, true, dev_kid())));
    }

    /// An attestation exactly `ATTESTATION_MAX_BYTES` long verifies.
    ///
    /// kills: the length bound off by one (`>=`).
    #[test]
    fn an_attestation_of_exactly_the_maximum_length_verifies_lpw15_1() {
        let (att, claims) = attestation_of_length(ATTESTATION_MAX_BYTES);
        assert_eq!(verify_dev(&att), Ok(expected(&claims, true)));
    }

    /// `set_world_names` replaces the set by value and an empty list clears it; an `aud`
    /// equal to any one of several names binds.
    ///
    /// kills: names appended rather than replaced; only the first name matched; an empty list
    /// ignored.
    #[test]
    fn the_owner_replaces_the_world_names_and_any_one_of_them_binds_lpw15_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        seed_names(&w, &["spki:stale/one"]);
        let first = "spki:first-fingerprint/realm";
        let third = "spki:third-fingerprint/realm";
        assert_eq!(
            set_names(&fx, owner(), strings(&[first, WORLD, third])),
            Ok(())
        );
        assert_eq!(names(&w), sorted(strings(&[first, WORLD, third])));

        w.nonce.seed(&nonce_row(alice(), NONCE_A, NONCE_EXPIRES));
        w.nonce.seed(&nonce_row(bob(), NONCE_B, NONCE_EXPIRES));
        let to_third = dev_attestation(&Claims::new(NONCE_A).with_aud(third));
        let to_first = dev_attestation(&Claims::new(NONCE_B).with_aud(first).with_sub(OTHER_SUB));
        assert_eq!(bind(&fx, alice(), BIND_AT, &to_third), Ok(()));
        assert_eq!(bind(&fx, bob(), BIND_AT, &to_first), Ok(()));
        assert_eq!(
            bindings(&w),
            sorted(vec![
                bview(alice(), SUB, BIND_AT, true, dev_kid()),
                bview(bob(), OTHER_SUB, BIND_AT, true, dev_kid()),
            ])
        );

        assert_eq!(set_names(&fx, owner(), strings(&[third])), Ok(()));
        assert_eq!(names(&w), strings(&[third]), "the set is replaced");
        assert_eq!(set_names(&fx, owner(), Vec::new()), Ok(()));
        assert!(names(&w).is_empty(), "an empty list clears the set");
    }

    /// `set_world_allowlist` replaces the set by value and an empty list clears it.
    ///
    /// kills: accounts appended rather than replaced; an empty list ignored.
    #[test]
    fn the_owner_replaces_and_clears_the_allowlist_lpw15_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        seed_allowed(&w, &["dev:stale"]);
        assert_eq!(set_allow(&fx, owner(), strings(&[SUB, OTHER_SUB])), Ok(()));
        assert_eq!(allowed(&w), sorted(strings(&[SUB, OTHER_SUB])));
        assert_eq!(set_allow(&fx, owner(), strings(&[THIRD_SUB])), Ok(()));
        assert_eq!(allowed(&w), strings(&[THIRD_SUB]), "the set is replaced");
        assert_eq!(set_allow(&fx, owner(), Vec::new()), Ok(()));
        assert!(allowed(&w).is_empty(), "an empty list clears the set");
    }

    /// The whole flow through the real calls: request a nonce, read it, sign an attestation
    /// for it, bind; the binding is present and the nonce gone.
    ///
    /// kills: a nonce the bind does not accept (stored in one form, compared in another).
    #[test]
    fn the_real_flow_requests_signs_and_binds_lpw15_1() {
        let fx = fixture();
        let w = owned_world(&fx);
        seed_names(&w, &[WORLD]);
        assert_eq!(ask(&fx, alice(), T0), Ok(()));
        let (nonce, _) = nonce_of(&w, alice()).expect("alice holds a nonce");
        let att = dev_attestation(&Claims::new(&nonce));
        assert_eq!(bind(&fx, alice(), T0 + 2_000, &att), Ok(()));
        assert_eq!(
            bindings(&w),
            vec![bview(alice(), SUB, T0 + 2_000, true, dev_kid())]
        );
        assert!(nonces(&w).is_empty(), "the nonce is spent");
    }
}

// =====================================================================================
// An attestation that fails a check, or a spent or expired nonce, is refused with no write.
// =====================================================================================

mod bind_refuses {
    use super::*;

    type Fields = Vec<(&'static str, String)>;

    /// The members of a default payload, as raw JSON values.
    fn base_fields() -> Fields {
        vec![
            ("iss", json_str("http://localhost:4455/attest")),
            ("sub", json_str(SUB)),
            ("aud", json_str(WORLD)),
            ("nonce", json_str(NONCE_A)),
            ("mr_ent", BASE_GAME.to_string()),
            ("iat", (EXP_S - 300).to_string()),
            ("exp", EXP_S.to_string()),
        ]
    }

    fn object(fields: &[(&'static str, String)]) -> String {
        let members: Vec<String> = fields
            .iter()
            .map(|(k, v)| format!("{}:{v}", json_str(k)))
            .collect();
        format!("{{{}}}", members.join(","))
    }

    fn replaced(name: &str, raw: &str) -> Fields {
        base_fields()
            .into_iter()
            .map(|(k, v)| {
                if k == name {
                    (k, raw.to_string())
                } else {
                    (k, v)
                }
            })
            .collect()
    }

    fn without(name: &str) -> Fields {
        base_fields()
            .into_iter()
            .filter(|(k, _)| *k != name)
            .collect()
    }

    fn twice(name: &'static str) -> Fields {
        let mut fields = base_fields();
        let value = fields
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.clone())
            .expect("fixture: a base member");
        fields.push((name, value));
        fields
    }

    fn dev_signed_payload(payload: &str) -> String {
        signed(&dev_signer(), &header_json(dev_kid()), payload)
    }

    fn default_attestation() -> String {
        dev_attestation(&Claims::new(NONCE_A))
    }

    /// The fixture every verifier refusal changes one thing of: it verifies.
    fn assert_base_verifies() {
        assert_eq!(
            verify_dev(&default_attestation()),
            Ok(expected(&Claims::new(NONCE_A), true)),
            "fixture: the unchanged attestation verifies"
        );
    }

    /// A well-formed, correctly signed attestation whose three segments each end in a partial
    /// base64 quantum (so `=` padding applies) and each hold a `-` or `_` (so the standard
    /// alphabet spells it differently). A `~` at every offset of a filler puts a 62 or 63
    /// sextet into the text segments.
    fn alphabet_fixture() -> (String, Claims) {
        for j in 0..3usize {
            let header = format!(
                r#"{{"alg":"Ed25519","kid":{},"h":"~~~{}"}}"#,
                json_str(dev_kid()),
                "h".repeat(j)
            );
            for k in 0..64usize {
                let claims =
                    Claims::new(NONCE_A).with_extra(&format!(r#","f":"~~~{}""#, "f".repeat(k)));
                let att = signed(&dev_signer(), &header, &claims.json());
                if segments(&att)
                    .iter()
                    .all(|s| s.len() % 4 != 0 && s.contains(['-', '_']))
                {
                    return (att, claims);
                }
            }
        }
        panic!("fixture: no attestation with every segment padded and url-safe")
    }

    fn with_char_at_middle(segment: &str, c: char) -> String {
        let mid = segment.len() / 2;
        format!("{}{c}{}", &segment[..mid], &segment[mid..])
    }

    // --- the verifier ----------------------------------------------------------------

    /// One byte over `ATTESTATION_MAX_BYTES` is refused for its length alone, before anything
    /// is decoded: a well-formed signed one, and one that is not even three segments.
    ///
    /// kills: no length bound; the bound off by one; the length checked after decoding.
    #[test]
    fn one_byte_over_the_maximum_is_too_long_before_anything_is_decoded_lpw15_2() {
        let (att, _) = attestation_of_length(ATTESTATION_MAX_BYTES + 1);
        assert_eq!(verify_dev(&att), Err(REJECT_ATTESTATION_TOO_LONG));
        let junk = "!".repeat(ATTESTATION_MAX_BYTES + 1);
        assert_eq!(verify_dev(&junk), Err(REJECT_ATTESTATION_TOO_LONG));
    }

    /// Not exactly three non-empty `.`-separated segments is malformed.
    ///
    /// kills: a split that takes the first three segments; an empty segment decoded as empty
    /// bytes and carried on.
    #[test]
    fn not_exactly_three_segments_is_malformed_lpw15_2() {
        assert_base_verifies();
        let [h, p, s] = segments(&default_attestation());
        for (label, att) in [
            ("two segments", format!("{h}.{p}")),
            ("four segments", format!("{h}.{p}.{s}.{s}")),
            ("a trailing dot", format!("{h}.{p}.{s}.")),
            ("an empty header segment", format!(".{p}.{s}")),
            ("an empty payload segment", format!("{h}..{s}")),
            ("an empty signature segment", format!("{h}.{p}.")),
            ("nothing at all", String::new()),
        ] {
            assert_eq!(
                verify_dev(&att),
                Err(REJECT_ATTESTATION_MALFORMED),
                "{label}"
            );
        }
    }

    /// Each segment in turn spelled any way but strict unpadded base64url is malformed:
    /// `=` padding, the standard alphabet's `+` and `/`, a space, a newline.
    ///
    /// kills: a lenient decoder (padding allowed, either alphabet, whitespace skipped).
    #[test]
    fn a_segment_that_is_not_strict_unpadded_base64url_is_malformed_lpw15_2() {
        let (att, claims) = alphabet_fixture();
        assert_eq!(
            verify_dev(&att),
            Ok(expected(&claims, true)),
            "fixture: the canonical spelling verifies"
        );
        let segs = segments(&att);
        for (i, seg) in segs.iter().enumerate() {
            let pad = "=".repeat((4 - seg.len() % 4) % 4);
            let standard = seg.replace('-', "+").replace('_', "/");
            assert_ne!(&standard, seg, "fixture: segment {i} spells differently");
            for (label, variant) in [
                ("padded", format!("{seg}{pad}")),
                ("standard alphabet", standard),
                ("a space inside", with_char_at_middle(seg, ' ')),
                ("a newline inside", with_char_at_middle(seg, '\n')),
                ("a trailing newline", format!("{seg}\n")),
            ] {
                let mut parts = segs.clone();
                parts[i] = variant;
                assert_eq!(
                    verify_dev(&parts.join(".")),
                    Err(REJECT_ATTESTATION_MALFORMED),
                    "segment {i}: {label}"
                );
            }
        }
    }

    /// A signature segment whose last character carries non-zero unused bits is malformed,
    /// though a lenient decoder reads the same 64 bytes from it.
    ///
    /// kills: decoding with trailing bits allowed.
    #[test]
    fn a_signature_with_non_canonical_trailing_bits_is_malformed_lpw15_2() {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        assert_base_verifies();
        let [h, p, s] = segments(&default_attestation());
        assert_eq!(s.len(), 86, "fixture: 64 bytes are 86 characters");
        let last = *s.as_bytes().last().expect("a signature segment");
        let index = ALPHABET
            .iter()
            .position(|&c| c == last)
            .expect("a base64url character");
        assert_eq!(index % 16, 0, "fixture: the canonical last character");
        let tweaked = format!("{}{}", &s[..85], char::from(ALPHABET[index + 1]));
        let lenient = base64::engine::GeneralPurpose::new(
            &base64::alphabet::URL_SAFE,
            base64::engine::general_purpose::NO_PAD.with_decode_allow_trailing_bits(true),
        );
        assert_eq!(
            lenient
                .decode(tweaked.as_bytes())
                .expect("a lenient decoder reads it"),
            lenient
                .decode(s.as_bytes())
                .expect("a lenient decoder reads it"),
            "fixture: the same 64 bytes under a lenient decoder"
        );
        assert_eq!(
            verify_dev(&format!("{h}.{p}.{tweaked}")),
            Err(REJECT_ATTESTATION_MALFORMED)
        );
    }

    /// A header that is not a JSON object holding one string `kid` is malformed, signed
    /// correctly so nothing else can refuse it.
    ///
    /// kills: a header read positionally (a JSON array of one string taken as an object); a
    /// repeated `kid` resolved to one of its values; a non-string `kid` coerced.
    #[test]
    fn a_header_without_exactly_one_string_kid_is_malformed_lpw15_2() {
        let kid = json_str(dev_kid());
        let payload = Claims::new(NONCE_A).json();
        for (label, header) in [
            ("not JSON", "not json".to_string()),
            ("a JSON array", format!("[{kid}]")),
            ("a JSON string", kid.clone()),
            ("no kid", r#"{"alg":"Ed25519"}"#.to_string()),
            ("kid null", r#"{"alg":"Ed25519","kid":null}"#.to_string()),
            ("kid a number", r#"{"alg":"Ed25519","kid":5}"#.to_string()),
            (
                "kid twice",
                format!(r#"{{"alg":"Ed25519","kid":{kid},"kid":{kid}}}"#),
            ),
        ] {
            let att = signed(&dev_signer(), &header, &payload);
            assert_eq!(
                verify_dev(&att),
                Err(REJECT_ATTESTATION_MALFORMED),
                "{label}"
            );
        }
    }

    /// A `kid` no listed key has, and an empty key list, is an unknown key.
    ///
    /// kills: a fallback to the first listed key; an empty list read as "trust anything".
    #[test]
    fn a_kid_no_listed_key_has_is_an_unknown_key_lpw15_2() {
        let claims = Claims::new(NONCE_A);
        let unknown = signed(
            &dev_signer(),
            &header_json("kid-nobody-has"),
            &claims.json(),
        );
        assert_eq!(verify_dev(&unknown), Err(REJECT_ATTESTATION_UNKNOWN_KEY));
        assert_base_verifies();
        assert_eq!(
            verify_attestation(&[], &default_attestation()),
            Err(REJECT_ATTESTATION_UNKNOWN_KEY)
        );
    }

    /// A signature of 63 or 65 bytes is malformed.
    ///
    /// kills: a signature length check dropped (a truncated or padded signature handed on).
    #[test]
    fn a_signature_that_is_not_64_bytes_is_malformed_lpw15_2() {
        assert_base_verifies();
        let [h, p, _] = segments(&default_attestation());
        let input = format!("{h}.{p}");
        let signature = dev_signer().sign(input.as_bytes()).to_bytes();
        let short = b64(&signature[..63]);
        let mut long_bytes = signature.to_vec();
        long_bytes.push(0);
        let long = b64(&long_bytes);
        assert_eq!(
            verify_dev(&format!("{input}.{short}")),
            Err(REJECT_ATTESTATION_MALFORMED),
            "63 bytes"
        );
        assert_eq!(
            verify_dev(&format!("{input}.{long}")),
            Err(REJECT_ATTESTATION_MALFORMED),
            "65 bytes"
        );
    }

    /// A signature that does not verify under the listed key for the header's `kid`.
    ///
    /// kills: no signature check; the check over the payload segment alone; a check under
    /// any listed key rather than the `kid`'s.
    #[test]
    fn a_signature_that_does_not_verify_is_refused_lpw15_2() {
        assert_base_verifies();
        let claims = Claims::new(NONCE_A);
        let base = default_attestation();

        let swapped = leak(vec![listed_key(dev_kid(), &other_signer(9))]);
        assert_eq!(
            verify_attestation(swapped, &base),
            Err(REJECT_ATTESTATION_SIGNATURE),
            "the right kid mapped to another public key"
        );

        let [h, _, s] = segments(&base);
        let changed = Claims::new("00112233445566778899aabbccddeefe");
        assert_eq!(changed.json().len(), claims.json().len());
        let p2 = b64(changed.json().as_bytes());
        assert_eq!(
            verify_dev(&format!("{h}.{p2}.{s}")),
            Err(REJECT_ATTESTATION_SIGNATURE),
            "one payload byte changed under the original signature"
        );

        let foreign = signed(&other_signer(9), &header_json(dev_kid()), &claims.json());
        assert_eq!(
            verify_dev(&foreign),
            Err(REJECT_ATTESTATION_SIGNATURE),
            "another key's signature under the dev kid"
        );

        let [h, p, _] = segments(&base);
        let payload_only = b64(&dev_signer().sign(p.as_bytes()).to_bytes());
        assert_eq!(
            verify_dev(&format!("{h}.{p}.{payload_only}")),
            Err(REJECT_ATTESTATION_SIGNATURE),
            "a signature over the payload segment alone"
        );
    }

    /// A listed key whose bytes are not a curve point is a signature failure, not a panic.
    /// The bytes are found by asking `VerifyingKey::from_bytes` itself, the decoder the
    /// verifier uses, so the fixture is refused by the same code.
    ///
    /// kills: an `expect` on the key decode (a panic); a bad key read as "skip the check".
    #[test]
    fn a_listed_key_that_is_not_a_curve_point_is_a_signature_failure_lpw15_2() {
        let not_a_point = (2u8..=255)
            .map(|n| {
                let mut bytes = [0u8; 32];
                bytes[0] = n;
                bytes
            })
            .find(|bytes| VerifyingKey::from_bytes(bytes).is_err())
            .expect("fixture: some small y has no point on the curve");
        let keys = leak(vec![AttestationKey {
            kid: dev_kid(),
            public_key: not_a_point,
        }]);
        assert_eq!(
            verify_attestation(keys, &default_attestation()),
            Err(REJECT_ATTESTATION_SIGNATURE)
        );
    }

    /// The payload is parsed only after the signature verifies: a payload that is not JSON
    /// under a signature that does not verify is a signature failure, and the same payload
    /// correctly signed by the dev key is malformed.
    ///
    /// kills: the payload parsed before the signature is checked (unauthenticated bytes read
    /// as claims).
    #[test]
    fn a_payload_that_is_not_json_is_read_only_after_the_signature_verifies_lpw15_2() {
        let not_json = "{not json at all";
        let header = header_json(dev_kid());
        let input = format!("{}.{}", b64(header.as_bytes()), b64(not_json.as_bytes()));
        let foreign = other_signer(9).sign(input.as_bytes()).to_bytes();
        for (label, signature) in [
            ("another key's signature", foreign),
            ("64 bytes of 0x5a", [0x5a; 64]),
        ] {
            assert_eq!(
                verify_dev(&format!("{input}.{}", b64(&signature))),
                Err(REJECT_ATTESTATION_SIGNATURE),
                "{label} over a payload that is not JSON"
            );
        }
        assert_eq!(
            verify_dev(&signed(&dev_signer(), &header, not_json)),
            Err(REJECT_ATTESTATION_MALFORMED),
            "the same payload signed by the dev key"
        );
    }

    /// The listed key here is the Ed25519 identity point (`[1, 0, ..., 0]`, a small-order
    /// key) and the signature is `R` = the identity point's encoding followed by `S` = 32
    /// zero bytes: a non-strict check accepts that signature for every message under this
    /// key, and the strict check refuses it whatever the payload.
    ///
    /// kills: `verify` in place of `verify_strict` (a small-order key accepted).
    #[test]
    fn a_small_order_key_and_its_trivial_signature_are_a_signature_failure_lpw15_2() {
        let mut identity_point = [0u8; 32];
        identity_point[0] = 1;
        let kid = "small-order-kid";
        let keys = leak(vec![AttestationKey {
            kid,
            public_key: identity_point,
        }]);
        let mut signature = [0u8; 64];
        signature[..32].copy_from_slice(&identity_point);
        let header = b64(header_json(kid).as_bytes());
        for payload in [
            Claims::new(NONCE_A).json(),
            "{}".to_string(),
            "{not json at all".to_string(),
        ] {
            let att = format!("{header}.{}.{}", b64(payload.as_bytes()), b64(&signature));
            assert_eq!(
                verify_attestation(keys, &att),
                Err(REJECT_ATTESTATION_SIGNATURE),
                "{payload}"
            );
        }
    }

    /// The bounds the account service and the spec agree on, by value.
    ///
    /// kills: a bound changed on one side only.
    #[test]
    fn the_attestation_nonce_name_and_allowlist_bounds_hold_their_agreed_values_lpw15_2() {
        assert_eq!(std::hint::black_box(ATTESTATION_MAX_BYTES), 4096);
        assert_eq!(std::hint::black_box(BIND_NONCE_TTL_MS), 300_000);
        assert_eq!(std::hint::black_box(BIND_NONCE_BYTES), 16);
        assert_eq!(std::hint::black_box(BIND_NONCE_SWEEP_MAX), 32);
        assert_eq!(std::hint::black_box(WORLD_NAME_MAX_BYTES), 512);
        assert_eq!(std::hint::black_box(MAX_WORLD_NAMES), 16);
        assert_eq!(std::hint::black_box(ACCOUNT_SUBJECT_MAX_BYTES), 255);
        assert_eq!(std::hint::black_box(MAX_ALLOWLIST_ACCOUNTS), 256);
    }

    /// Correctly signed payloads that are not the claims' shape are malformed: not an
    /// object, a required member missing, a member of the wrong type, a member repeated.
    ///
    /// kills: a payload read positionally (an array taken as the claims); a missing member
    /// defaulted; a float or string `exp` coerced; `aud` taken from an array; non-string
    /// `mr_ent` elements skipped; a repeated member resolved to one of its values.
    #[test]
    fn a_signed_payload_of_the_wrong_shape_is_malformed_lpw15_2() {
        assert_eq!(
            verify_dev(&dev_signed_payload(&object(&base_fields()))),
            Ok(expected(&Claims::new(NONCE_A), true)),
            "fixture: the base members verify"
        );
        let positional = format!(
            "[{},{},{},{EXP_S}]",
            json_str(SUB),
            json_str(WORLD),
            json_str(NONCE_A)
        );
        let mut cases: Vec<(String, String)> = vec![
            ("a JSON array".to_string(), positional),
            ("a JSON string".to_string(), json_str(SUB)),
            ("a number".to_string(), "5".to_string()),
            ("null".to_string(), "null".to_string()),
        ];
        for name in ["sub", "aud", "nonce", "exp"] {
            cases.push((format!("no {name}"), object(&without(name))));
        }
        for (label, name, raw) in [
            ("exp a string", "exp", format!("\"{EXP_S}\"")),
            ("exp a float", "exp", "1.5e9".to_string()),
            ("exp a whole float", "exp", format!("{EXP_S}.0")),
            ("aud an array", "aud", format!("[{}]", json_str(WORLD))),
            ("nonce a number", "nonce", "12345".to_string()),
            ("mr_ent a string", "mr_ent", json_str("base-game")),
            ("mr_ent holding a number", "mr_ent", "[1]".to_string()),
            (
                "mr_ent holding the claim and a number",
                "mr_ent",
                r#"["base-game",1]"#.to_string(),
            ),
            ("sub a number", "sub", "7".to_string()),
        ] {
            cases.push((label.to_string(), object(&replaced(name, &raw))));
        }
        for name in ["sub", "aud", "nonce", "exp", "mr_ent"] {
            cases.push((format!("{name} twice"), object(&twice(name))));
        }
        for (label, payload) in cases {
            assert_eq!(
                verify_dev(&dev_signed_payload(&payload)),
                Err(REJECT_ATTESTATION_MALFORMED),
                "{label}: {payload}"
            );
        }
    }

    /// A `sub` that is not 1 to 255 visible ASCII bytes is malformed; one of exactly 255
    /// visible ASCII bytes, every printable character among them, verifies.
    ///
    /// kills: no subject bound; the bound off by one; a space, a tab or a non-ASCII character
    /// admitted; JSON escapes in `sub` left undecoded.
    #[test]
    fn a_sub_that_is_not_1_to_255_visible_ascii_bytes_is_malformed_lpw15_2() {
        let e_acute = char::from_u32(0xE9).expect("U+00E9 is a char");
        for (label, sub) in [
            ("empty", String::new()),
            ("256 bytes", "a".repeat(ACCOUNT_SUBJECT_MAX_BYTES + 1)),
            ("a space", "dev:a b".to_string()),
            ("a tab", "dev:a\tb".to_string()),
            ("a non-ASCII character", format!("dev:{e_acute}")),
        ] {
            let att = dev_attestation(&Claims::new(NONCE_A).with_sub(&sub));
            assert_eq!(
                verify_dev(&att),
                Err(REJECT_ATTESTATION_MALFORMED),
                "{label}"
            );
        }
        let visible: String = (0..ACCOUNT_SUBJECT_MAX_BYTES)
            .map(|i| char::from(0x21 + u8::try_from(i % 94).expect("fits")))
            .collect();
        assert_eq!(visible.len(), ACCOUNT_SUBJECT_MAX_BYTES);
        let claims = Claims::new(NONCE_A).with_sub(&visible);
        assert_eq!(
            verify_dev(&dev_attestation(&claims)),
            Ok(expected(&claims, true)),
            "255 visible ASCII bytes verify"
        );
    }

    // --- the bind ----------------------------------------------------------------------

    /// At exactly `exp * 1000` ms, and after, the attestation has expired.
    ///
    /// kills: expiry compared with `>`; seconds compared with milliseconds; no expiry check.
    #[test]
    fn an_attestation_at_or_after_exp_is_expired_with_no_write_lpw15_2() {
        let fx = fixture();
        let w = valid_world(&fx);
        let att = dev_attestation(&Claims::new(NONCE_A));
        for clock in [EXP_S * 1000, EXP_S * 1000 + 1] {
            assert_refused(&fx, &w, REJECT_ATTESTATION_EXPIRED, "at exp", || {
                bind(&fx, alice(), clock, &att)
            });
        }
    }

    /// An `aud` that is not one of the world's names, byte for byte, names another world:
    /// another name, a world with no names, and the near misses.
    ///
    /// kills: no audience check; a prefix, suffix or case-insensitive match; a world with no
    /// names read as "any name".
    #[test]
    fn an_aud_not_among_the_worlds_names_is_another_world_with_no_write_lpw15_2() {
        {
            let fx = fixture();
            let w = valid_world(&fx);
            let prefix = &WORLD[..WORLD.len() - 1];
            let slashed = format!("{WORLD}/");
            let recased = WORLD.replacen("realm", "Realm", 1);
            assert_ne!(recased, WORLD, "fixture: one letter recased");
            for (label, aud) in [
                ("another world", "spki:OTHER-fingerprint/realm"),
                ("a prefix of the name", prefix),
                ("the name and a slash", slashed.as_str()),
                ("one letter recased", recased.as_str()),
            ] {
                let att = dev_attestation(&Claims::new(NONCE_A).with_aud(aud));
                assert_refused(&fx, &w, REJECT_ATTESTATION_OTHER_WORLD, label, || {
                    bind(&fx, alice(), BIND_AT, &att)
                });
            }
        }
        {
            let fx = fixture();
            let w = owned_world(&fx);
            w.nonce.seed(&nonce_row(alice(), NONCE_A, NONCE_EXPIRES));
            let att = dev_attestation(&Claims::new(NONCE_A));
            assert_refused(
                &fx,
                &w,
                REJECT_ATTESTATION_OTHER_WORLD,
                "a world with no names",
                || bind(&fx, alice(), BIND_AT, &att),
            );
        }
    }

    /// No nonce row for the identity, or one whose expiry is the call's time, is no
    /// outstanding nonce.
    ///
    /// kills: no nonce check; nonce expiry compared with `>`; the nonce looked up by value
    /// rather than by identity.
    #[test]
    fn no_outstanding_nonce_is_refused_with_no_write_lpw15_2() {
        let att = dev_attestation(&Claims::new(NONCE_A));
        {
            let fx = fixture();
            let w = owned_world(&fx);
            seed_names(&w, &[WORLD]);
            w.nonce.seed(&nonce_row(bob(), NONCE_A, NONCE_EXPIRES));
            assert_refused(
                &fx,
                &w,
                REJECT_NO_BIND_NONCE,
                "no nonce row for the caller (another identity holds that value)",
                || bind(&fx, alice(), BIND_AT, &att),
            );
        }
        {
            let fx = fixture();
            let w = owned_world(&fx);
            seed_names(&w, &[WORLD]);
            w.nonce.seed(&nonce_row(alice(), NONCE_A, BIND_AT));
            assert_refused(
                &fx,
                &w,
                REJECT_NO_BIND_NONCE,
                "a nonce expiring at the call's time",
                || bind(&fx, alice(), BIND_AT, &att),
            );
        }
    }

    /// The claim carries a nonce that is not the caller's: an unknown one, or another
    /// identity's outstanding nonce while the caller holds its own.
    ///
    /// kills: no nonce comparison; a nonce accepted when any identity holds it.
    #[test]
    fn a_claim_with_another_nonce_is_refused_with_no_write_lpw15_2() {
        let fx = fixture();
        let w = valid_world(&fx);
        for (label, nonce) in [
            ("an unknown nonce", NONCE_C),
            ("bob's outstanding nonce", NONCE_B),
        ] {
            let att = dev_attestation(&Claims::new(nonce));
            assert_refused(&fx, &w, REJECT_ATTESTATION_OTHER_NONCE, label, || {
                bind(&fx, alice(), BIND_AT, &att)
            });
        }
    }

    /// The same attestation presented again after it bound finds no nonce, and the binding
    /// keeps its first time.
    ///
    /// kills: the nonce not spent (a replay rebinds).
    #[test]
    fn an_attestation_presented_twice_is_refused_the_second_time_lpw15_2() {
        let fx = fixture();
        let w = valid_world(&fx);
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_eq!(bind(&fx, alice(), BIND_AT, &att), Ok(()));
        assert!(bindings(&w).contains(&bview(alice(), SUB, BIND_AT, true, dev_kid())));
        assert_refused(&fx, &w, REJECT_NO_BIND_NONCE, "the replay", || {
            bind(&fx, alice(), BIND_AT + 50, &att)
        });
    }

    /// A nonce replaced by a second request: the attestation for the first carries another
    /// nonce.
    ///
    /// kills: a request that keeps the first nonce valid beside the second.
    #[test]
    fn an_attestation_for_a_replaced_nonce_carries_another_nonce_lpw15_2() {
        let fx = fixture();
        let w = valid_world(&fx);
        assert_eq!(ask(&fx, alice(), BIND_AT), Ok(()));
        let (fresh, _) = nonce_of(&w, alice()).expect("alice holds a nonce");
        assert_ne!(fresh, NONCE_A, "fixture: the request drew another nonce");
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_refused(
            &fx,
            &w,
            REJECT_ATTESTATION_OTHER_NONCE,
            "the first nonce",
            || bind(&fx, alice(), BIND_AT + 10, &att),
        );
    }

    // --- the guards -----------------------------------------------------------------

    /// On a `Password` world an identity the rule does not admit can neither bind nor ask
    /// for a nonce; the sweep of an expired row does not run for it. Once admitted, the same
    /// call binds.
    ///
    /// kills: the admission guard dropped or placed after the sweep or a write.
    #[test]
    fn an_unadmitted_identity_cannot_bind_or_ask_for_a_nonce_lpw15_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.access.seed(&rule_row(WorldAccessRule::Password));
        seed_names(&w, &[WORLD]);
        w.nonce.seed(&nonce_row(alice(), NONCE_A, NONCE_EXPIRES));
        w.nonce.seed(&nonce_row(bob(), NONCE_B, T0 - 1));
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_refused(
            &fx,
            &w,
            crate::access::REJECT_NOT_ADMITTED,
            "bind_world_account",
            || bind(&fx, alice(), BIND_AT, &att),
        );
        assert_refused(
            &fx,
            &w,
            crate::access::REJECT_NOT_ADMITTED,
            "request_bind_nonce",
            || ask(&fx, alice(), BIND_AT),
        );
        w.admission.seed(&admission_row(alice()));
        assert_eq!(
            bind(&fx, alice(), BIND_AT, &att),
            Ok(()),
            "control: admitted, the same call binds"
        );
    }

    /// A caller whose account is pending deletion can neither bind nor ask for a nonce.
    ///
    /// kills: the deletion gate dropped from either reducer.
    #[test]
    fn a_caller_pending_deletion_cannot_bind_or_ask_for_a_nonce_lpw15_2() {
        let fx = fixture();
        let w = valid_world(&fx);
        w.account.seed(&deleting_account(alice()));
        w.nonce.seed(&nonce_row(id(0x55), NONCE_C, T0 - 1));
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_refused(
            &fx,
            &w,
            crate::guards::REJECT_DELETION_GATED,
            "bind_world_account",
            || bind(&fx, alice(), BIND_AT, &att),
        );
        assert_refused(
            &fx,
            &w,
            crate::guards::REJECT_DELETION_GATED,
            "request_bind_nonce",
            || ask(&fx, alice(), BIND_AT),
        );
    }

    /// Only the owner calls the relayed forms and the two setters; an admitted non-owner is
    /// refused each.
    ///
    /// kills: the owner guard dropped from any of the four.
    #[test]
    fn a_non_owner_cannot_relay_or_set_the_names_or_the_allowlist_lpw15_2() {
        let fx = fixture();
        let w = valid_world(&fx);
        seed_allowed(&w, &[SUB]);
        let att = dev_attestation(&Claims::new(NONCE_A));
        let not_owner = crate::access::REJECT_NOT_WORLD_OWNER;
        assert_refused(&fx, &w, not_owner, "bind_world_account_for", || {
            bind_for(&fx, alice(), alice(), BIND_AT, &att)
        });
        assert_refused(&fx, &w, not_owner, "request_bind_nonce_for", || {
            ask_for(&fx, alice(), alice(), BIND_AT)
        });
        assert_refused(&fx, &w, not_owner, "set_world_names", || {
            set_names(&fx, alice(), strings(&["spki:mine/taken"]))
        });
        assert_refused(&fx, &w, not_owner, "set_world_allowlist", || {
            set_allow(&fx, alice(), strings(&[OTHER_SUB]))
        });
    }

    /// The owner's relayed forms refuse a `who` whose account is pending deletion.
    ///
    /// kills: the relayed forms gating the sender instead of `who`, or not at all.
    #[test]
    fn the_relayed_forms_refuse_a_who_pending_deletion_lpw15_2() {
        let fx = fixture();
        let w = valid_world(&fx);
        w.account.seed(&deleting_account(alice()));
        w.nonce.seed(&nonce_row(id(0x55), NONCE_C, T0 - 1));
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_refused(
            &fx,
            &w,
            crate::guards::REJECT_DELETION_GATED,
            "bind_world_account_for",
            || bind_for(&fx, owner(), alice(), BIND_AT, &att),
        );
        assert_refused(
            &fx,
            &w,
            crate::guards::REJECT_DELETION_GATED,
            "request_bind_nonce_for",
            || ask_for(&fx, owner(), alice(), BIND_AT),
        );
    }

    // --- the setters ----------------------------------------------------------------

    /// `set_world_names` refuses more than 16 names, an entry that is not 1 to 512 visible
    /// ASCII bytes, and a repeated entry, leaving the stored set; 16 names of 512 bytes are
    /// accepted.
    ///
    /// kills: no count bound or one off by one; an entry check that reads only the first
    /// entry; a byte bound off by one; a space, control or non-ASCII character admitted; a
    /// repeat collapsed silently.
    #[test]
    fn set_world_names_refuses_a_bad_list_and_keeps_the_stored_set_lpw15_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        seed_names(&w, &[WORLD]);
        let too_many: Vec<String> = (0..=MAX_WORLD_NAMES).map(|i| format!("name-{i}")).collect();
        assert_refused(&fx, &w, REJECT_TOO_MANY_WORLD_NAMES, "17 names", || {
            set_names(&fx, owner(), too_many)
        });
        let e_acute = char::from_u32(0xE9).expect("U+00E9 is a char");
        for (label, bad) in [
            ("empty", String::new()),
            ("513 bytes", "n".repeat(WORLD_NAME_MAX_BYTES + 1)),
            ("a space", "spki:a b".to_string()),
            (
                "a control character",
                format!("spki:a{}b", char::from(0x01u8)),
            ),
            (
                "a delete character",
                format!("spki:a{}b", char::from(0x7Fu8)),
            ),
            ("a non-ASCII character", format!("spki:{e_acute}")),
        ] {
            assert_refused(&fx, &w, REJECT_WORLD_NAME, label, || {
                set_names(&fx, owner(), vec!["spki:fine/realm".to_string(), bad])
            });
        }
        assert_refused(&fx, &w, REJECT_DUPLICATE_ENTRY, "a repeated entry", || {
            set_names(&fx, owner(), strings(&["spki:a", "spki:b", "spki:a"]))
        });
        assert_eq!(names(&w), strings(&[WORLD]), "the stored set is untouched");

        let full: Vec<String> = (0..MAX_WORLD_NAMES)
            .map(|i| format!("{i:03}{}", "n".repeat(WORLD_NAME_MAX_BYTES - 3)))
            .collect();
        assert_eq!(set_names(&fx, owner(), full.clone()), Ok(()));
        assert_eq!(names(&w), sorted(full), "16 names of 512 bytes are stored");
    }

    /// `set_world_allowlist` refuses more than 256 accounts, an entry that is not 1 to 255
    /// visible ASCII bytes, and a repeated entry, leaving the stored set; 256 accounts of 255
    /// bytes are accepted.
    ///
    /// kills: no count bound or one off by one; a byte bound off by one; a space admitted; a
    /// repeat collapsed silently.
    #[test]
    fn set_world_allowlist_refuses_a_bad_list_and_keeps_the_stored_set_lpw15_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        seed_allowed(&w, &[SUB]);
        let too_many: Vec<String> = (0..=MAX_ALLOWLIST_ACCOUNTS)
            .map(|i| format!("dev:{i}"))
            .collect();
        assert_refused(
            &fx,
            &w,
            REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS,
            "257 accounts",
            || set_allow(&fx, owner(), too_many),
        );
        for (label, bad) in [
            ("empty", String::new()),
            (
                "1025 bytes",
                "a".repeat(crate::account_checks::HANDLE_MAX_BYTES + 1),
            ),
            ("a space", "dev:a b".to_string()),
        ] {
            assert_refused(&fx, &w, REJECT_ALLOWLIST_ACCOUNT, label, || {
                set_allow(&fx, owner(), vec![OTHER_SUB.to_string(), bad])
            });
        }
        assert_refused(&fx, &w, REJECT_DUPLICATE_ENTRY, "a repeated entry", || {
            set_allow(&fx, owner(), strings(&[OTHER_SUB, THIRD_SUB, OTHER_SUB]))
        });
        assert_eq!(allowed(&w), strings(&[SUB]), "the stored set is untouched");

        let full: Vec<String> = (0..MAX_ALLOWLIST_ACCOUNTS)
            .map(|i| {
                format!(
                    "{i:03}{}",
                    "a".repeat(crate::account_checks::HANDLE_MAX_BYTES - 3)
                )
            })
            .collect();
        assert_eq!(set_allow(&fx, owner(), full.clone()), Ok(()));
        assert_eq!(
            allowed(&w),
            sorted(full),
            "256 handles of 1024 bytes are stored"
        );
    }

    // --- the sweep ------------------------------------------------------------------

    /// One request deletes at most `BIND_NONCE_SWEEP_MAX` expired rows of other identities,
    /// keeps every unexpired row, and leaves the caller's new row.
    ///
    /// kills: an unbounded sweep; no sweep; a sweep that deletes unexpired rows; a sweep
    /// that rewrites the rows it keeps.
    #[test]
    fn one_request_sweeps_at_most_the_bound_of_expired_nonces_lpw15_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        let left_over = 8;
        let expired_count = BIND_NONCE_SWEEP_MAX + left_over;
        let mut expired: Vec<NonceView> = Vec::new();
        for n in 1..=expired_count {
            let who = id(u8::try_from(n).expect("fits"));
            let row = nonce_row(
                who,
                &format!("{n:032x}"),
                T0 - 1_000 * i64::try_from(n).expect("fits"),
            );
            expired.push(nview(who, &row.nonce, row.expires_at_ms));
            w.nonce.seed(&row);
        }
        let mut unexpired: Vec<NonceView> = Vec::new();
        for n in 0..3u8 {
            let who = id(0x70 + n);
            let row = nonce_row(who, &format!("{:032x}", 0x700 + u32::from(n)), T0 + 100_000);
            unexpired.push(nview(who, &row.nonce, row.expires_at_ms));
            w.nonce.seed(&row);
        }
        let caller = id(0x60);
        assert_eq!(ask(&fx, caller, T0), Ok(()));
        let rows = nonces(&w);
        let kept_expired: Vec<&NonceView> = rows.iter().filter(|r| expired.contains(r)).collect();
        assert_eq!(
            kept_expired.len(),
            left_over,
            "exactly the expired rows beyond the bound remain"
        );
        for row in &unexpired {
            assert!(rows.contains(row), "an unexpired row stays: {row:?}");
        }
        let mine: Vec<&NonceView> = rows
            .iter()
            .filter(|r| r.0 == caller.to_byte_array())
            .collect();
        assert_eq!(mine.len(), 1, "the caller's one row");
        assert_eq!(mine[0].2, T0 + BIND_NONCE_TTL_MS);
        assert_eq!(
            rows.len(),
            left_over + unexpired.len() + 1,
            "no other row: {rows:?}"
        );
    }

    /// A nonce row whose expiry is the call's time is expired, so the sweep takes it.
    ///
    /// kills: the sweep's range excluding its upper end.
    #[test]
    fn the_sweep_takes_a_nonce_expiring_at_the_call_time_lpw15_2() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.nonce.seed(&nonce_row(bob(), NONCE_B, T0));
        assert_eq!(ask(&fx, alice(), T0), Ok(()));
        assert_eq!(nonce_of(&w, bob()), None, "bob's row expired at T0: swept");
        assert!(nonce_of(&w, alice()).is_some());
    }

    // --- the pure helpers -------------------------------------------------------------

    /// Expired at and after `exp * 1000` ms, not one millisecond before; `i64::MAX` seconds
    /// saturates instead of overflowing.
    ///
    /// kills: `>` for `>=`; seconds not scaled; a wrapping multiply (it reads as expired).
    #[test]
    fn attestation_expired_is_at_or_after_exp_in_milliseconds_lpw15_2() {
        let exp = EXP_S;
        assert!(!attestation_expired(exp, exp * 1000 - 1));
        assert!(attestation_expired(exp, exp * 1000));
        assert!(attestation_expired(exp, exp * 1000 + 1));
        assert!(
            !attestation_expired(exp, exp),
            "seconds compared as milliseconds"
        );
        assert!(!attestation_expired(i64::MAX, 0));
        assert!(!attestation_expired(i64::MAX, i64::MAX - 1));
        assert!(attestation_expired(i64::MAX, i64::MAX));
    }

    /// A nonce is expired at and after its `expires_at_ms`, not one millisecond before.
    ///
    /// kills: `>` for `>=`; the arguments swapped.
    #[test]
    fn bind_nonce_expired_is_at_or_after_its_expiry_lpw15_2() {
        let e = NONCE_EXPIRES;
        assert!(!bind_nonce_expired(e, e - 1));
        assert!(bind_nonce_expired(e, e));
        assert!(bind_nonce_expired(e, e + 1));
    }

    /// 1 to `max` bytes, each 0x21..=0x7E.
    ///
    /// kills: empty admitted; the bound off by one; a fixed bound in place of the argument; a
    /// space, DEL or non-ASCII byte admitted; `!` or `~` refused.
    #[test]
    fn is_visible_ascii_is_1_to_max_bytes_of_0x21_to_0x7e_lpw15_2() {
        let e_acute = char::from_u32(0xE9).expect("U+00E9 is a char");
        assert!(!is_visible_ascii("", 5), "empty");
        assert!(is_visible_ascii("abcde", 5), "max");
        assert!(!is_visible_ascii("abcdef", 5), "max + 1");
        assert!(!is_visible_ascii(" ", 5), "0x20");
        assert!(
            !is_visible_ascii(&char::from(0x7Fu8).to_string(), 5),
            "0x7F"
        );
        assert!(is_visible_ascii("!", 5), "0x21");
        assert!(is_visible_ascii("~", 5), "0x7E");
        assert!(is_visible_ascii("!~", 5));
        assert!(!is_visible_ascii(&e_acute.to_string(), 5), "non-ASCII");
        assert!(
            !is_visible_ascii(&format!("ab{e_acute}"), 5),
            "non-ASCII inside"
        );
        assert!(!is_visible_ascii("a b", 5), "a space inside");
        assert!(
            is_visible_ascii(&"a".repeat(WORLD_NAME_MAX_BYTES), WORLD_NAME_MAX_BYTES),
            "the bound is the argument"
        );
        assert!(!is_visible_ascii(
            &"a".repeat(WORLD_NAME_MAX_BYTES + 1),
            WORLD_NAME_MAX_BYTES
        ));
    }
}

// =====================================================================================
// What a build binds, and what a binding means for ownership, on every build.
// =====================================================================================

mod binding_build {
    use super::*;

    fn features(bits: u8) -> BuildFeatures {
        BuildFeatures {
            official: bits & 1 != 0,
            world: bits & 2 != 0,
            dev_issuers: bits & 4 != 0,
            open_join: bits & 8 != 0,
            dev_reducers: bits & 16 != 0,
            load_test_zones: bits & 32 != 0,
        }
    }

    fn profile_with(keys: &'static [AttestationKey], enforces: bool) -> BuildProfile {
        BuildProfile {
            name: "probe",
            enforces_ownership: enforces,
            login_issuers: &[],
            dev_reducers: false,
            attestation_keys: keys,
            world_check_url: None,
        }
    }

    /// Over all 64 feature sets a profile binds nothing exactly when it holds no key; by
    /// name, `official`, `default` and `conflict` hold none, `test` and `dev-enforcing` the
    /// dev keys, `world` the production keys; no profile holds a key of both lists.
    ///
    /// kills: the build guard keyed on the profile's name; a dev key in a release profile; a
    /// dev profile with no key.
    #[test]
    fn a_build_binds_nothing_exactly_when_it_holds_no_attestation_key_lpw15_3() {
        let dev = std::hint::black_box(DEV_ATTESTATION_KEYS);
        assert!(!dev.is_empty(), "fixture: the dev list holds a key");
        for bits in 0..64u8 {
            let profile = build_profile(features(bits));
            let label = format!("{bits:06b} ({})", profile.name);
            assert_eq!(
                binds_nothing(&profile),
                profile.attestation_keys.is_empty(),
                "{label}"
            );
            let want: &[AttestationKey] = match profile.name {
                "official" | "default" | "conflict" => &[],
                "test" | "dev-enforcing" => DEV_ATTESTATION_KEYS,
                "world" => PRODUCTION_ATTESTATION_KEYS,
                other => panic!("{label}: an unknown profile {other}"),
            };
            assert_eq!(profile.attestation_keys, want, "{label}");
            let holds_dev = profile
                .attestation_keys
                .iter()
                .any(|k| DEV_ATTESTATION_KEYS.contains(k));
            let holds_production = profile
                .attestation_keys
                .iter()
                .any(|k| PRODUCTION_ATTESTATION_KEYS.contains(k));
            let holds_both = holds_dev && holds_production;
            assert!(!holds_both, "{label}: a key of both lists");
        }
        assert!(binds_nothing(&profile_with(&[], true)));
        assert!(!binds_nothing(&profile_with(DEV_ATTESTATION_KEYS, true)));
    }

    /// Over the six profiles, `official`, `conflict` and `default` keep no account, and
    /// `world`, `test` and `dev-enforcing` do. `world` is the case that matters: it names an
    /// account service, so an unbind and a drop run there whatever keys it holds.
    ///
    /// kills: `keeps_no_account` decided from the attestation keys alone; decided from the
    /// account service alone; keyed on the profile's name.
    #[test]
    fn a_build_keeps_no_account_only_with_no_key_and_no_account_service_lpw23_10() {
        let cases: [(u8, &str, bool); 6] = [
            (1, "official", true),
            (3, "conflict", true),
            (0, "default", true),
            (2, "world", false),
            (8, "test", false),
            (4, "dev-enforcing", false),
        ];
        for (bits, name, want) in cases {
            let profile = build_profile(features(bits));
            assert_eq!(profile.name, name, "fixture: {bits:06b} builds `{name}`");
            assert_eq!(
                super::super::keeps_no_account(&profile),
                want,
                "`{name}`: keeps no account"
            );
        }
        let service_only = BuildProfile {
            world_check_url: Some("https://example.invalid/world/check"),
            ..profile_with(&[], true)
        };
        assert!(
            !super::super::keeps_no_account(&service_only),
            "a profile with no key that names an account service keeps an account"
        );
        assert!(
            super::super::keeps_no_account(&profile_with(&[], true)),
            "a profile with no key and no account service keeps none"
        );
    }

    /// `entitled` for a caller with no login token on the enforcing dev build: an entitled
    /// attestation binding under the build's own key entitles nobody, and the identity's
    /// entitled `world_account` row does. The binding stays where it was.
    ///
    /// kills: `entitled` still reading `world_binding`; `entitled` blind to `world_account`.
    #[test]
    fn an_entitled_attestation_binding_entitles_nobody_on_an_enforcing_build_lpw23_7() {
        let fx = fixture();
        let w = world(&fx);
        let accounts = fx
            .table::<crate::account_checks::WorldAccount>("world_account", "identity", |r| {
                r.identity
            })
            .unique();
        let enforcing = build_profile(features(4));
        assert_eq!(
            enforcing.name, "dev-enforcing",
            "fixture: the enforcing dev build"
        );
        assert!(
            enforcing.world_check_url.is_some(),
            "fixture: it names a service"
        );
        let entitled_under = |who: Identity| {
            call(&fx, who, T0, |ctx| {
                crate::accounts::entitled(ctx, &enforcing)
            })
        };
        let bound = binding_row(alice(), SUB, T0, true, dev_kid());
        w.binding.seed(&bound);
        assert!(
            !entitled_under(alice()),
            "an entitled binding under the dev key entitles nobody"
        );
        accounts.seed(&crate::account_checks::WorldAccount {
            handle: "k1.AbCdEf0123456789-_".to_string(),
            identity: bob(),
            entitled: true,
            checked_at_ms: T0 - 1_000,
            is_host: false,
        });
        assert!(
            entitled_under(bob()),
            "an entitled world_account row entitles"
        );
        assert!(
            !entitled_under(alice()),
            "the neighbour's row entitles only its own identity"
        );
        assert_eq!(
            w.binding.rows().iter().map(enc).collect::<Vec<_>>(),
            vec![enc(&bound)],
            "the binding is unchanged"
        );
    }

    /// The dev list is the published `local-dev` list followed by the `hosted-dev` list, the
    /// production list is the published `production` list, and every published key is an
    /// Ed25519 OKP key.
    ///
    /// kills: a key list drifting from what the account service publishes.
    #[test]
    fn the_key_lists_are_the_published_attestation_keys_lpw15_3() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../account-service/attestation-public-keys.json"
        );
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("the generated key file {path} reads: {e}"));
        let doc: serde_json::Value =
            serde_json::from_str(&text).expect("the generated key file is JSON");
        let published = |list: &str| -> Vec<(String, [u8; 32])> {
            doc[list]
                .as_array()
                .unwrap_or_else(|| panic!("`{list}` is an array"))
                .iter()
                .map(|jwk| {
                    assert_eq!(jwk["kty"], "OKP", "{list}: {jwk}");
                    assert_eq!(jwk["crv"], "Ed25519", "{list}: {jwk}");
                    let kid = jwk["kid"].as_str().expect("a string kid").to_string();
                    let x = URL_SAFE_NO_PAD
                        .decode(jwk["x"].as_str().expect("a string x"))
                        .expect("x is base64url");
                    let x: [u8; 32] = x.try_into().expect("x is 32 bytes");
                    (kid, x)
                })
                .collect()
        };
        let ours = |keys: &[AttestationKey]| -> Vec<(String, [u8; 32])> {
            keys.iter()
                .map(|k| (k.kid.to_string(), k.public_key))
                .collect()
        };
        let mut dev = published("local-dev");
        dev.extend(published("hosted-dev"));
        assert_eq!(ours(DEV_ATTESTATION_KEYS), dev);
        assert_eq!(ours(PRODUCTION_ATTESTATION_KEYS), published("production"));
    }

    /// The signer derived from the `local-dev` label is the first dev key, and it reproduces
    /// the golden attestation's signature byte for byte.
    ///
    /// kills: a test signer that is not the account service's (every acceptance test here
    /// would then prove nothing about interop).
    #[test]
    fn the_dev_signer_is_the_first_dev_key_and_reproduces_the_golden_signature_lpw15_3() {
        assert_eq!(
            dev_signer().verifying_key().to_bytes(),
            DEV_ATTESTATION_KEYS[0].public_key
        );
        let input = format!("{GOLDEN_HEADER_SEGMENT}.{GOLDEN_PAYLOAD_SEGMENT}");
        assert_eq!(
            b64(&dev_signer().sign(input.as_bytes()).to_bytes()),
            GOLDEN_SIGNATURE_SEGMENT
        );
    }
}

// =====================================================================================
// The real official build binds nothing.
// =====================================================================================

#[cfg(all(feature = "official", not(feature = "world")))]
mod official_build {
    use super::super::REJECT_BUILD_BINDS_NOTHING;
    use super::join_fixture::{join, join_footprint, join_world, joined};
    use super::*;

    /// An outstanding nonce, a world name and a dev-signed attestation for them (the
    /// construction the default build accepts), plus an expired nonce of another identity
    /// a sweep would take.
    fn bindable_world(fx: &Fixture) -> W<'_> {
        let w = valid_world(fx);
        w.nonce.seed(&nonce_row(id(0x55), NONCE_C, T0 - 1));
        w
    }

    #[test]
    fn the_official_build_refuses_the_bind_with_no_write_lpw15_3() {
        let fx = fixture();
        let w = bindable_world(&fx);
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_refused(
            &fx,
            &w,
            REJECT_BUILD_BINDS_NOTHING,
            "bind_world_account",
            || bind(&fx, alice(), BIND_AT, &att),
        );
        assert_eq!(
            nonce_of(&w, alice()),
            Some((NONCE_A.to_string(), NONCE_EXPIRES)),
            "the nonce row stays"
        );
    }

    #[test]
    fn the_official_build_refuses_a_nonce_request_with_no_write_lpw15_3() {
        let fx = fixture();
        let w = bindable_world(&fx);
        assert_refused(
            &fx,
            &w,
            REJECT_BUILD_BINDS_NOTHING,
            "request_bind_nonce",
            || ask(&fx, alice(), BIND_AT),
        );
    }

    #[test]
    fn the_official_build_refuses_the_owners_relayed_forms_lpw15_3() {
        let fx = fixture();
        let w = bindable_world(&fx);
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_refused(
            &fx,
            &w,
            REJECT_BUILD_BINDS_NOTHING,
            "bind_world_account_for",
            || bind_for(&fx, owner(), alice(), BIND_AT, &att),
        );
        assert_refused(
            &fx,
            &w,
            REJECT_BUILD_BINDS_NOTHING,
            "request_bind_nonce_for",
            || ask_for(&fx, owner(), alice(), BIND_AT),
        );
    }

    /// Every table [`world`] registers: none of them is read by a call the build refuses.
    const REGISTERED: [&str; 9] = [
        "config",
        "world_access",
        "world_admission",
        "account",
        "player_session",
        "world_binding",
        "world_bind_nonce",
        "world_name",
        "world_allowlist",
    ];

    /// `act` answers `REJECT_BUILD_BINDS_NOTHING`, reads no row of any registered table and
    /// leaves every one of them as seeded, with no write call.
    fn assert_refused_unread(
        fx: &Fixture,
        w: &W<'_>,
        label: &str,
        act: impl FnOnce() -> Result<(), String>,
    ) {
        fx.reset_writes();
        let before = footprint(fx, w);
        fx.reset_reads();
        let answer = act();
        let reads: Vec<(&str, u32)> = REGISTERED
            .iter()
            .map(|table| (*table, fx.rows_read(table)))
            .collect();
        assert_eq!(
            answer,
            Err(REJECT_BUILD_BINDS_NOTHING.to_string()),
            "{label}"
        );
        assert_eq!(
            reads,
            REGISTERED
                .iter()
                .map(|table| (*table, 0u32))
                .collect::<Vec<(&str, u32)>>(),
            "{label}: no row read"
        );
        assert_eq!(
            footprint(fx, w),
            before,
            "{label}: every table as seeded, and no write call"
        );
    }

    /// On a `Password` world, an identity the rule does not admit asking for a nonce or
    /// binding, and a non-owner calling either relayed form, are each refused by the build
    /// before the admission or owner check reads anything.
    ///
    /// kills: the build guard placed after `require_admitted`, `require_world_owner` or the
    /// deletion gate in any of the four reducers.
    #[test]
    fn the_build_refusal_comes_before_every_other_check_lpw15_3() {
        let fx = fixture();
        let w = bindable_world(&fx);
        w.access.seed(&rule_row(WorldAccessRule::Password));
        w.account.seed(&deleting_account(bob()));
        let att = dev_attestation(&Claims::new(NONCE_A));
        assert_refused_unread(&fx, &w, "request_bind_nonce, unadmitted", || {
            ask(&fx, alice(), BIND_AT)
        });
        assert_refused_unread(&fx, &w, "bind_world_account, unadmitted", || {
            bind(&fx, alice(), BIND_AT, &att)
        });
        assert_refused_unread(&fx, &w, "request_bind_nonce_for, not the owner", || {
            ask_for(&fx, alice(), bob(), BIND_AT)
        });
        assert_refused_unread(&fx, &w, "bind_world_account_for, not the owner", || {
            bind_for(&fx, alice(), bob(), BIND_AT, &att)
        });
        assert!(
            w.admission.rows().is_empty(),
            "fixture: alice is not admitted"
        );
    }

    /// A caller with an entitled binding row under the dev key cannot join: the official
    /// build reads no binding.
    #[test]
    fn an_entitled_binding_does_not_let_a_caller_join_on_the_official_build_lpw15_3() {
        let fx = fixture();
        let w = owned_world(&fx);
        let jw = join_world(&fx);
        w.binding
            .seed(&binding_row(alice(), SUB, T0 - 5_000, true, dev_kid()));
        fx.reset_writes();
        let before = (footprint(&fx, &w), join_footprint(&fx, &jw));
        assert_eq!(
            join(&fx, alice(), None, BIND_AT),
            Err(crate::accounts::ERR_OWNERSHIP_REQUIRED.to_string())
        );
        assert!(joined(&jw, alice()).is_empty(), "no player row");
        assert_eq!((footprint(&fx, &w), join_footprint(&fx, &jw)), before);
    }

    /// A bound caller's unbind is refused with no write: its binding, its nonce and its
    /// admission row all stay.
    ///
    /// kills: the inert reducer (`Ok`); an unbind that erases on a build that binds nothing.
    #[test]
    fn the_official_build_refuses_the_unbind_with_no_write_lpw22_4() {
        let fx = fixture();
        let w = bindable_world(&fx);
        w.binding
            .seed(&binding_row(alice(), SUB, T0 - 5_000, true, dev_kid()));
        w.admission.seed(&admission_row(alice()));
        assert_refused(
            &fx,
            &w,
            REJECT_BUILD_BINDS_NOTHING,
            "unbind_world_account",
            || unbind(&fx, alice(), BIND_AT),
        );
        assert!(
            bindings(&w).contains(&bview(alice(), SUB, T0 - 5_000, true, dev_kid())),
            "the binding stays"
        );
        assert_eq!(
            nonce_of(&w, alice()),
            Some((NONCE_A.to_string(), NONCE_EXPIRES)),
            "the nonce row stays"
        );
        assert_eq!(w.admission.rows().len(), 1, "the admission row stays");
    }

    /// The build's refusal is the unbind's first step and reads nothing: on an `Allowlist`
    /// world, for a bound caller pending deletion that holds an admission row, and for a
    /// caller with no binding at all.
    ///
    /// kills: the build guard placed after the binding lookup (a caller with no binding
    /// answered `Ok`, a bound one read), after the deletion gate, or after the no-readmit
    /// rule.
    #[test]
    fn the_official_build_refuses_the_unbind_before_any_other_step_lpw22_4() {
        let fx = fixture();
        let w = bindable_world(&fx);
        w.access.seed(&rule_row(WorldAccessRule::Allowlist));
        seed_allowed(&w, &[SUB]);
        w.binding
            .seed(&binding_row(alice(), SUB, T0 - 5_000, true, dev_kid()));
        w.admission.seed(&admission_row(alice()));
        w.account.seed(&deleting_account(alice()));
        assert_refused_unread(&fx, &w, "a bound caller pending deletion", || {
            unbind(&fx, alice(), BIND_AT)
        });
        assert_refused_unread(&fx, &w, "a caller with no binding", || {
            unbind(&fx, id(0x44), BIND_AT)
        });
    }

    /// The owner's drop of a bound identity holding a nonce and an admission row is refused
    /// with no write: the binding, the nonce and the admission row all stay.
    ///
    /// kills: the inert reducer (`Ok`); a drop that erases on a build that binds nothing.
    #[test]
    fn the_official_build_refuses_the_owners_drop_with_no_write_wr261127a_6_official() {
        let fx = fixture();
        let w = bindable_world(&fx);
        w.binding
            .seed(&binding_row(alice(), SUB, T0 - 5_000, true, dev_kid()));
        w.admission.seed(&admission_row(alice()));
        assert_refused(
            &fx,
            &w,
            REJECT_BUILD_BINDS_NOTHING,
            "drop_world_binding",
            || drop_binding_of(&fx, owner(), alice(), BIND_AT),
        );
        assert!(
            bindings(&w).contains(&bview(alice(), SUB, T0 - 5_000, true, dev_kid())),
            "the binding stays"
        );
        assert_eq!(
            nonce_of(&w, alice()),
            Some((NONCE_A.to_string(), NONCE_EXPIRES)),
            "the nonce row stays"
        );
        assert_eq!(w.admission.rows().len(), 1, "the admission row stays");
    }

    /// The build's refusal is the drop's first step and reads nothing: for a caller that is
    /// not the owner, for the owner naming an identity pending deletion, and for the owner
    /// naming an identity with no binding.
    ///
    /// kills: the build guard placed after the owner check, after the deletion gate or after
    /// the binding lookup.
    #[test]
    fn the_build_refusal_comes_before_every_other_drop_check_wr261127a_6_official() {
        let fx = fixture();
        let w = bindable_world(&fx);
        w.binding
            .seed(&binding_row(alice(), SUB, T0 - 5_000, true, dev_kid()));
        w.account.seed(&deleting_account(alice()));
        assert_refused_unread(&fx, &w, "a caller that is not the owner", || {
            drop_binding_of(&fx, id(0x44), bob(), BIND_AT)
        });
        assert_refused_unread(&fx, &w, "a target pending deletion", || {
            drop_binding_of(&fx, owner(), alice(), BIND_AT)
        });
        assert_refused_unread(&fx, &w, "a target with no binding", || {
            drop_binding_of(&fx, owner(), id(0x44), BIND_AT)
        });
    }
}

// =====================================================================================
// A hostile host relays an attestation the player fetched for the host's own world.
// =====================================================================================

mod relay_rig {
    use super::*;

    /// The hostile host's own world.
    const H_NAME: &str = "spki:HOSTILE-fingerprint/rig-world";
    /// The world the hostile host connects to.
    const V_NAME: &str = "spki:VICTIM-fingerprint/realm";
    const H_NONCE: &str = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";

    /// The hostile host's identity on the world it connects to.
    fn h() -> Identity {
        id(0x33)
    }

    /// A world named `names` where `h` holds an outstanding nonce.
    fn relay_world<'a>(fx: &'a Fixture, names: &[&str]) -> W<'a> {
        let w = owned_world(fx);
        seed_names(&w, names);
        w.nonce.seed(&nonce_row(h(), H_NONCE, NONCE_EXPIRES));
        w
    }

    /// The attestation the player's client fetched for the hostile host's world: its name,
    /// the nonce `h` holds on the victim world, the dev key, unexpired, entitled.
    fn relayed() -> String {
        dev_attestation(&Claims::new(H_NONCE).with_aud(H_NAME))
    }

    #[test]
    fn a_relayed_attestation_for_the_hosts_own_world_is_refused_lpw15_4() {
        let fx = fixture();
        let w = relay_world(&fx, &[V_NAME]);
        let att = relayed();
        assert_refused(
            &fx,
            &w,
            REJECT_ATTESTATION_OTHER_WORLD,
            "presented by h",
            || bind(&fx, h(), BIND_AT, &att),
        );
        assert_refused(
            &fx,
            &w,
            REJECT_ATTESTATION_OTHER_WORLD,
            "relayed by the victim world's owner",
            || bind_for(&fx, owner(), h(), BIND_AT, &att),
        );
        assert!(bindings(&w).is_empty(), "no binding");
        assert_eq!(
            nonce_of(&w, h()),
            Some((H_NONCE.to_string(), NONCE_EXPIRES)),
            "the nonce row stays"
        );
    }

    /// Control: the identical attestation binds on a world that holds the host's name.
    #[test]
    fn the_same_attestation_binds_on_a_world_holding_the_hosts_name_lpw15_4() {
        let fx = fixture();
        let w = relay_world(&fx, &[H_NAME]);
        assert_eq!(bind(&fx, h(), BIND_AT, &relayed()), Ok(()));
        assert_eq!(
            bindings(&w),
            vec![bview(h(), SUB, BIND_AT, true, dev_kid())]
        );
    }
}

// =====================================================================================
// Under `Allowlist`, the relayed bind is the way in.
// =====================================================================================

mod allowlist {
    use super::*;
    use crate::access::REJECT_NOT_ADMITTED;

    /// The joiner.
    fn who() -> Identity {
        id(0x66)
    }

    /// An `Allowlist` world named [`WORLD`] listing `accounts`.
    fn allowlist_world<'a>(fx: &'a Fixture, accounts: &[&str]) -> W<'a> {
        let w = owned_world(fx);
        w.access.seed(&rule_row(WorldAccessRule::Allowlist));
        seed_names(&w, &[WORLD]);
        seed_allowed(&w, accounts);
        w
    }

    /// The owner asks for `who`'s nonce, reads it, and relays `who`'s attestation for
    /// `subject`.
    fn owner_binds(fx: &Fixture, w: &W<'_>, subject: &str) {
        assert_eq!(
            ask_for(fx, owner(), who(), T0),
            Ok(()),
            "the relayed nonce request"
        );
        let (nonce, _) = nonce_of(w, who()).expect("who holds a nonce");
        let att = dev_attestation(&Claims::new(&nonce).with_sub(subject));
        assert_eq!(
            bind_for(fx, owner(), who(), T0 + 1_000, &att),
            Ok(()),
            "the relayed bind"
        );
        assert_eq!(
            bindings(w),
            vec![bview(who(), subject, T0 + 1_000, true, dev_kid())]
        );
    }

    /// The bind of an account not on the list succeeds, and the identity is still refused.
    ///
    /// kills: any binding read as admission.
    #[test]
    fn a_bound_account_not_on_the_list_is_still_refused_lpw15_5() {
        let fx = fixture();
        let w = allowlist_world(&fx, &[OTHER_SUB]);
        owner_binds(&fx, &w, SUB);
        assert_eq!(
            call(&fx, who(), T0 + 2_000, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
        assert!(sessions_of(&w, who()).is_empty());
        assert_eq!(
            passes(&fx, who(), T0 + 2_000),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
    }

    /// An identity holding an account row is governed by the list alone: an admission row
    /// does not let in one whose handle is not listed. An attestation binding under the dev
    /// key to a subject the list lacks counts for nothing, so the admission row decides.
    ///
    /// kills: an admission row overriding delisting; a binding read for admission.
    #[test]
    fn a_binding_never_governs_admission_and_an_account_row_answers_to_the_list_lpw23_7() {
        {
            let fx = fixture();
            let w = allowlist_world(&fx, &[OTHER_SUB]);
            w.admission.seed(&admission_row(who()));
            w.accounts
                .seed(&account_row(who(), HANDLE, true, T0 - 5_000));
            assert_eq!(
                passes(&fx, who(), T0),
                Err(REJECT_NOT_ADMITTED.to_string()),
                "an unlisted handle: refused despite the admission row"
            );
        }
        {
            let fx = fixture();
            let w = allowlist_world(&fx, &[SUB]);
            w.admission.seed(&admission_row(who()));
            w.binding
                .seed(&binding_row(who(), OTHER_SUB, T0 - 5_000, true, dev_kid()));
            assert_eq!(
                passes(&fx, who(), T0),
                Ok(()),
                "a binding to an unlisted subject: the admission row admits"
            );
        }
    }

    /// `on_allowlist` is exact membership.
    ///
    /// kills: a prefix or case-insensitive match; a constant answer.
    #[test]
    fn on_allowlist_is_exact_membership_lpw15_5() {
        let fx = fixture();
        let _w = allowlist_world(&fx, &[SUB]);
        let ctx = fx.ctx();
        assert!(on_allowlist(&ctx, SUB));
        assert!(!on_allowlist(&ctx, OTHER_SUB));
        assert!(!on_allowlist(&ctx, &SUB[..SUB.len() - 1]));
        assert!(!on_allowlist(&ctx, &SUB.to_uppercase()));
    }
}

// =====================================================================================
// The dev-enforcing build: only a trusted, entitled binding joins.
// =====================================================================================

#[cfg(all(feature = "dev_issuers", not(feature = "open_join")))]
mod acs6_enforcing_bound {
    use super::join_fixture::{join, join_footprint, join_world, joined, JoinWorld};
    use super::*;
    use crate::accounts::ERR_OWNERSHIP_REQUIRED;

    fn host_minted() -> String {
        r#"{"iss":"localhost","sub":"host-sub","aud":["spacetimedb"],"iat":1}"#.to_string()
    }

    const RULES: [WorldAccessRule; 3] = [
        WorldAccessRule::Open,
        WorldAccessRule::Password,
        WorldAccessRule::Allowlist,
    ];

    /// A world under `rule` where [`alice`] holds `binding` and `account` and is admitted: by
    /// its handle on the list when it holds an account row under `Allowlist`, by an admission
    /// row otherwise (an attestation binding governs no admission).
    fn admitted_world<'a>(
        fx: &'a Fixture,
        rule: WorldAccessRule,
        binding: Option<&WorldBinding>,
        account: Option<&crate::account_checks::WorldAccount>,
    ) -> (W<'a>, JoinWorld<'a>) {
        let w = owned_world(fx);
        let jw = join_world(fx);
        if rule != WorldAccessRule::Open {
            w.access.seed(&rule_row(rule));
        }
        if let Some(row) = binding {
            w.binding.seed(row);
        }
        if let Some(row) = account {
            w.accounts.seed(row);
        }
        match (rule, account) {
            (WorldAccessRule::Open, _) => {}
            (WorldAccessRule::Allowlist, Some(row)) => seed_allowed(&w, &[row.handle.as_str()]),
            _ => w.admission.seed(&admission_row(alice())),
        }
        assert_eq!(
            passes(fx, alice(), BIND_AT),
            Ok(()),
            "fixture: {rule:?} admits the caller"
        );
        (w, jw)
    }

    /// Under every rule and over both token shapes, `join_game` answers the ownership error
    /// and no table changes.
    fn assert_join_refused(
        binding: Option<WorldBinding>,
        account: Option<crate::account_checks::WorldAccount>,
        label: &str,
    ) {
        for rule in RULES {
            for jwt in [None, Some(host_minted())] {
                let fx = fixture();
                let (w, jw) = admitted_world(&fx, rule, binding.as_ref(), account.as_ref());
                fx.reset_writes();
                let before = (footprint(&fx, &w), join_footprint(&fx, &jw));
                assert_eq!(
                    join(&fx, alice(), jwt.as_deref(), BIND_AT),
                    Err(ERR_OWNERSHIP_REQUIRED.to_string()),
                    "{label}, {rule:?}, token {}",
                    jwt.is_some()
                );
                assert_eq!(
                    (footprint(&fx, &w), join_footprint(&fx, &jw)),
                    before,
                    "{label}, {rule:?}: nothing written"
                );
            }
        }
    }

    #[test]
    fn a_connection_with_no_binding_is_refused_under_every_rule_lpw15_7() {
        assert_join_refused(None, None, "no binding");
    }

    #[test]
    fn a_binding_without_the_entitlement_is_refused_under_every_rule_lpw15_7() {
        assert_join_refused(
            Some(binding_row(alice(), SUB, T0, false, dev_kid())),
            None,
            "an unentitled binding",
        );
    }

    #[test]
    fn an_entitled_binding_under_a_key_the_build_lacks_is_refused_under_every_rule_lpw15_7() {
        assert_join_refused(
            Some(binding_row(alice(), SUB, T0, true, RETIRED_KID)),
            None,
            "a binding under a retired key",
        );
    }

    /// kills: `entitled` still reading an attestation binding.
    #[test]
    fn an_entitled_binding_under_the_dev_key_is_refused_under_every_rule_lpw23_7() {
        assert_join_refused(
            Some(binding_row(alice(), SUB, T0, true, dev_kid())),
            None,
            "an entitled binding under the dev key",
        );
    }

    /// kills: the row's `entitled` ignored.
    #[test]
    fn a_world_account_row_that_says_not_entitled_is_refused_under_every_rule_lpw23_7() {
        assert_join_refused(
            None,
            Some(account_row(alice(), HANDLE, false, T0)),
            "a row that says not entitled",
        );
    }

    /// A `world_account` row that says entitled, checked at the epoch, lets `join_game` go
    /// ahead under every rule, with or without the host-minted token.
    ///
    /// kills: `entitled` blind to `world_account`; a freshness bound on the stored row.
    #[test]
    fn an_entitled_world_account_row_however_old_joins_under_every_rule_lpw23_7() {
        let row = account_row(alice(), HANDLE, true, 0);
        for rule in RULES {
            for jwt in [None, Some(host_minted())] {
                let fx = fixture();
                let (_w, jw) = admitted_world(&fx, rule, None, Some(&row));
                assert_eq!(
                    join(&fx, alice(), jwt.as_deref(), BIND_AT),
                    Ok(()),
                    "{rule:?}, token {}",
                    jwt.is_some()
                );
                assert_eq!(joined(&jw, alice()), vec!["Ada".to_string()], "{rule:?}");
            }
        }
    }
}

// =====================================================================================
// The dev-enforcing build: an identity that unbinds loses its checked account and is refused
// the join.
// =====================================================================================

#[cfg(all(feature = "dev_issuers", not(feature = "open_join")))]
mod acs6_enforcing_unbind {
    use super::join_fixture::{join, join_footprint, join_world, joined};
    use super::*;
    use crate::accounts::ERR_OWNERSHIP_REQUIRED;

    /// `caller` holds an entitled `world_account` row under `handle` and no admission row, and
    /// is admitted by `rule` (as everyone under `Open`, as the owner otherwise; under
    /// `Allowlist` its handle is listed too). In one world it joins; in another it unbinds and
    /// has not joined, and `join_game` then answers the ownership refusal and writes nothing.
    fn assert_refused_once_unbound(rule: WorldAccessRule, caller: Identity, handle: &str) {
        fn seed_into(w: &W<'_>, rule: WorldAccessRule, caller: Identity, handle: &str) {
            w.access.seed(&rule_row(rule));
            w.accounts
                .seed(&account_row(caller, handle, true, T0 - 5_000));
            if rule == WorldAccessRule::Allowlist {
                seed_allowed(w, &[handle]);
            }
        }
        {
            let fx = fixture();
            let w = owned_world(&fx);
            let jw = join_world(&fx);
            seed_into(&w, rule, caller, handle);
            assert_eq!(
                join(&fx, caller, None, T0 + 1),
                Ok(()),
                "{rule:?}: the control, still checked, joins"
            );
            assert_eq!(joined(&jw, caller), vec!["Ada".to_string()], "{rule:?}");
        }
        let fx = fixture();
        let w = owned_world(&fx);
        let jw = join_world(&fx);
        seed_into(&w, rule, caller, handle);
        assert_eq!(
            passes(&fx, caller, T0),
            Ok(()),
            "fixture: {rule:?} admits the caller"
        );
        assert_eq!(unbind(&fx, caller, T0), Ok(()), "{rule:?}: the unbind");
        assert!(
            w.accounts.rows().is_empty(),
            "{rule:?}: the caller's row is gone"
        );

        fx.reset_writes();
        let before = (footprint(&fx, &w), join_footprint(&fx, &jw));
        assert_eq!(
            join(&fx, caller, None, T0 + 1),
            Err(ERR_OWNERSHIP_REQUIRED.to_string()),
            "{rule:?}: unbound, the join is refused"
        );
        assert_eq!(
            (footprint(&fx, &w), join_footprint(&fx, &jw)),
            before,
            "{rule:?}: the refused join writes nothing"
        );
        assert!(joined(&jw, caller).is_empty(), "{rule:?}: no player row");
    }

    /// kills: an unbind that leaves the `world_account` row (the join goes ahead).
    #[test]
    fn under_open_an_unbound_caller_is_refused_the_join_lpw22_6() {
        assert_refused_once_unbound(WorldAccessRule::Open, alice(), HANDLE);
    }

    /// Under `Password` and `Allowlist` the caller the ownership refusal reaches after an
    /// unbind is the owner, always admitted: any other identity loses its admission row with
    /// its account row and is refused admission first.
    ///
    /// kills: an unbind that leaves the `world_account` row.
    #[test]
    fn under_password_the_unbound_owner_is_refused_the_join_lpw22_6() {
        assert_refused_once_unbound(WorldAccessRule::Password, owner(), OWNER_HANDLE);
    }

    /// kills: an unbind that leaves the `world_account` row.
    #[test]
    fn under_allowlist_the_unbound_owner_is_refused_the_join_lpw22_6() {
        assert_refused_once_unbound(WorldAccessRule::Allowlist, owner(), OWNER_HANDLE);
    }
}

// =====================================================================================
// A build that does not enforce ownership needs no binding.
// =====================================================================================

#[cfg(feature = "open_join")]
mod open_join_unbound {
    use super::join_fixture::{join, join_world, joined};
    use super::*;

    #[test]
    fn an_unbound_connection_joins_an_open_world_on_a_build_that_does_not_enforce() {
        let fx = fixture();
        let w = owned_world(&fx);
        let jw = join_world(&fx);
        assert_eq!(join(&fx, alice(), None, T0), Ok(()));
        assert_eq!(joined(&jw, alice()), vec!["Ada".to_string()]);
        assert!(bindings(&w).is_empty(), "joining binds nothing");
    }
}

// =====================================================================================
// The deletion step.
// =====================================================================================

mod lifecycle {
    use super::*;

    /// `erase_world_binding` deletes the identity's binding and nonce, and nobody else's.
    ///
    /// kills: either table left; another identity's rows deleted.
    #[test]
    fn erasing_deletes_the_identitys_binding_and_nonce_only() {
        let fx = fixture();
        let w = valid_world(&fx);
        w.binding
            .seed(&binding_row(alice(), SUB, T0 - 1_000, true, dev_kid()));
        erase_world_binding(&fx.ctx(), alice());
        assert_eq!(
            bindings(&w),
            vec![bview(bob(), OTHER_SUB, T0 - 5_000, true, dev_kid())]
        );
        assert_eq!(nonces(&w), vec![nview(bob(), NONCE_B, NONCE_EXPIRES)]);
    }
}

// =====================================================================================
// The owner-scoped read paths.
// =====================================================================================

mod views {
    use super::*;
    use crate::native_host_tests::{VIEW_MY_BIND_NONCE, VIEW_MY_WORLD_BINDING};

    /// `my_world_binding` and `my_bind_nonce` each answer the sender's own row and nothing
    /// else: a caller holding no row reads nothing.
    ///
    /// kills: a view answering nothing; a view answering another identity's row or every row.
    #[test]
    fn owner_scoped_binding_and_nonce_views_return_only_the_callers_row() {
        let fx = fixture();
        let w = world(&fx);
        let carol = id(0x33);
        w.binding
            .seed(&binding_row(alice(), SUB, T0 - 1_000, true, dev_kid()));
        w.binding.seed(&binding_row(
            bob(),
            OTHER_SUB,
            T0 - 5_000,
            false,
            RETIRED_KID,
        ));
        w.nonce.seed(&nonce_row(alice(), NONCE_A, NONCE_EXPIRES));
        w.nonce.seed(&nonce_row(bob(), NONCE_B, NONCE_EXPIRES + 7));

        let binding_seen = |who: Identity| -> Vec<BindingView> {
            fx.call_view::<WorldBinding>(VIEW_MY_WORLD_BINDING, who)
                .into_iter()
                .map(|r| {
                    bview(
                        r.identity,
                        &r.account_subject,
                        r.bound_at_ms,
                        r.entitled,
                        &r.key_id,
                    )
                })
                .collect()
        };
        let nonce_seen = |who: Identity| -> Vec<NonceView> {
            fx.call_view::<WorldBindNonce>(VIEW_MY_BIND_NONCE, who)
                .into_iter()
                .map(|r| nview(r.identity, &r.nonce, r.expires_at_ms))
                .collect()
        };

        let alice_binding = binding_seen(alice());
        assert_eq!(
            alice_binding,
            vec![bview(alice(), SUB, T0 - 1_000, true, dev_kid())]
        );
        assert_eq!(
            binding_seen(bob()),
            vec![bview(bob(), OTHER_SUB, T0 - 5_000, false, RETIRED_KID)]
        );
        assert_eq!(binding_seen(carol), Vec::<BindingView>::new());

        let alice_nonce = nonce_seen(alice());
        assert_eq!(alice_nonce, vec![nview(alice(), NONCE_A, NONCE_EXPIRES)]);
        assert_eq!(
            nonce_seen(bob()),
            vec![nview(bob(), NONCE_B, NONCE_EXPIRES + 7)]
        );
        assert_eq!(nonce_seen(carol), Vec::<NonceView>::new());

        for (_, subject, _, _, kid) in &alice_binding {
            assert_ne!(
                subject, OTHER_SUB,
                "alice must never read bob's account subject"
            );
            assert_ne!(kid, RETIRED_KID, "alice must never read bob's key id");
        }
        for (_, nonce, _) in &alice_nonce {
            assert_ne!(nonce, NONCE_B, "alice must never read bob's nonce");
        }
    }
}

// =====================================================================================
// The two parts of a seed: the accounts the build counts, and what the list lacks of them.
// =====================================================================================

mod seed_parts {
    use super::super::allowlist_additions;
    use super::*;
    use proptest::prelude::*;
    use std::collections::BTreeSet;

    /// Account `n` of a generated pool; zero-padded, so byte order is numeric order.
    fn acct(n: usize) -> String {
        format!("dev:pool-{n:04}")
    }

    fn accts(range: impl Iterator<Item = usize>) -> Vec<String> {
        range.map(acct).collect()
    }

    /// `allowlist_additions` by example: the accounts of `wanted` that `listed` lacks, each
    /// once, ascending by byte, whatever order either list is in.
    ///
    /// kills: the additions answered unsorted or in `wanted`'s order; a repeat kept; an
    /// account already listed answered again; `listed` assumed sorted.
    #[test]
    fn allowlist_additions_answers_what_the_list_lacks_once_in_byte_order_lpw21_2() {
        let cases: [(&[&str], &[&str], &[&str]); 5] = [
            (&[], &["dev:b", "dev:a", "dev:b"], &["dev:a", "dev:b"]),
            (
                &["dev:a"],
                &["dev:c", "dev:a", "dev:B"],
                &["dev:B", "dev:c"],
            ),
            (
                &["dev:z", "dev:a"],
                &["dev:a", "dev:m", "dev:z"],
                &["dev:m"],
            ),
            (&["dev:a", "dev:b"], &["dev:b", "dev:a"], &[]),
            (&["dev:a"], &[], &[]),
        ];
        for (listed, wanted, want) in cases {
            assert_eq!(
                allowlist_additions(&strings(listed), &strings(wanted)),
                Ok(strings(want)),
                "listed {listed:?}, wanted {wanted:?}"
            );
        }
    }

    /// `allowlist_additions` at the bound: refused exactly when the list and the additions
    /// number more than 256, counting an account once however often `wanted` names it and
    /// not at all when it is already listed.
    ///
    /// kills: a bound off by one either way; the bound counted on `wanted`'s length; the
    /// bound counted on the additions alone; a full list refusing accounts it already holds.
    #[test]
    fn allowlist_additions_is_refused_exactly_past_256_lpw21_2() {
        let too_many: Result<Vec<String>, &str> = Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS);
        let kept: Vec<String> = accts((0..200).rev());
        let mut wanted = accts(200..256);
        wanted.extend(accts(0..10));
        wanted.extend(accts(200..206));
        assert_eq!(
            allowlist_additions(&kept, &wanted),
            Ok(accts(200..256)),
            "200 kept and 56 new"
        );
        assert_eq!(
            allowlist_additions(&kept, &accts(200..257)),
            too_many,
            "200 kept and 57 new"
        );
        let full = accts((0..MAX_ALLOWLIST_ACCOUNTS).rev());
        assert_eq!(
            allowlist_additions(&full, &accts(0..MAX_ALLOWLIST_ACCOUNTS)),
            Ok(Vec::new()),
            "a full list and accounts it holds"
        );
        assert_eq!(
            allowlist_additions(&full, &[acct(MAX_ALLOWLIST_ACCOUNTS)]),
            too_many,
            "a full list and one new account"
        );
        let mut twice = accts(0..MAX_ALLOWLIST_ACCOUNTS);
        twice.extend(accts((0..MAX_ALLOWLIST_ACCOUNTS).rev()));
        assert_eq!(
            allowlist_additions(&[], &twice),
            Ok(accts(0..MAX_ALLOWLIST_ACCOUNTS)),
            "256 accounts named twice each"
        );
        assert_eq!(
            allowlist_additions(&[], &accts(0..=MAX_ALLOWLIST_ACCOUNTS)),
            too_many,
            "257 accounts"
        );
    }

    /// `allowlist_additions` compares accounts byte for byte: spellings that differ only by
    /// case, and an account that is a strict prefix of another, are different accounts,
    /// answered when the other spelling is listed and counted apart toward the bound.
    ///
    /// kills: a case-insensitive comparison; a prefix or substring match in either
    /// direction; a listed spelling that hides the wanted one from the bound.
    #[test]
    fn allowlist_additions_compares_accounts_byte_for_byte_lpw21_2() {
        let cases: [(&[&str], &[&str], &[&str]); 5] = [
            (&["dev:ALICE"], &["dev:alice"], &["dev:alice"]),
            (
                &["dev:alice"],
                &["dev:Alice", "dev:ALICE"],
                &["dev:ALICE", "dev:Alice"],
            ),
            (&["dev:alice1"], &["dev:alice"], &["dev:alice"]),
            (&["dev:alice"], &["dev:alice1"], &["dev:alice1"]),
            (
                &["dev:ALICE", "dev:alice1"],
                &["dev:alice", "dev:ALICE"],
                &["dev:alice"],
            ),
        ];
        for (listed, wanted, want) in cases {
            assert_eq!(
                allowlist_additions(&strings(listed), &strings(wanted)),
                Ok(strings(want)),
                "listed {listed:?}, wanted {wanted:?}"
            );
        }
        let too_many: Result<Vec<String>, &str> = Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS);
        let mut listed = accts(0..254);
        listed.push("dev:ALICE".to_string());
        assert_eq!(
            allowlist_additions(&listed, &strings(&["dev:alice"])),
            Ok(strings(&["dev:alice"])),
            "255 listed, one of them the other case"
        );
        assert_eq!(
            allowlist_additions(&listed, &strings(&["dev:alice", "dev:alice1"])),
            too_many,
            "255 listed and two new spellings"
        );
        listed.push("dev:alice1".to_string());
        assert_eq!(
            allowlist_additions(&listed, &strings(&["dev:alice"])),
            too_many,
            "a full list holding the other spellings"
        );
    }

    proptest! {
        /// For any listed set (in any order) and any wanted list over one pool of accounts:
        /// the answer is the distinct accounts of `wanted` that `listed` lacks, ascending,
        /// or the too-many refusal exactly when the list and those additions number more
        /// than 256.
        ///
        /// kills: any answer other than that difference, at any size up to and past the
        /// bound.
        #[test]
        fn allowlist_additions_is_the_sorted_distinct_difference_under_the_bound_lpw21_2(
            listed in prop::collection::btree_set(0usize..400, 0..=MAX_ALLOWLIST_ACCOUNTS),
            wanted in prop::collection::vec(0usize..400, 0..300),
        ) {
            let listed: Vec<String> = listed.iter().rev().map(|&n| acct(n)).collect();
            let wanted: Vec<String> = wanted.iter().map(|&n| acct(n)).collect();
            let additions: Vec<String> = wanted
                .iter()
                .filter(|account| !listed.contains(account))
                .cloned()
                .collect::<BTreeSet<String>>()
                .into_iter()
                .collect();
            let want = if listed.len() + additions.len() > MAX_ALLOWLIST_ACCOUNTS {
                Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS)
            } else {
                Ok(additions)
            };
            prop_assert_eq!(allowlist_additions(&listed, &wanted), want);
        }
    }
}

// =====================================================================================
// Under `Allowlist` the owner's checked handle stays on the list: the owner's own list keeps
// it. A bind writes no list row.
// =====================================================================================

mod owner_account {
    use super::*;
    use crate::access::REJECT_NOT_ADMITTED;

    const HOST_SUB: &str = "dev:aaaaaaaa-0000-4000-8000-00000000a1a1";
    const KEPT_SUB: &str = "dev:kept-0000-4000-8000-000000000000";

    /// A world owned by [`owner`] and named [`WORLD`], under `rule` (`None`: no rule row),
    /// listing `listed`.
    fn world_under<'a>(fx: &'a Fixture, rule: Option<WorldAccessRule>, listed: &[&str]) -> W<'a> {
        let w = owned_world(fx);
        if let Some(rule) = rule {
            w.access.seed(&rule_row(rule));
        }
        seed_names(&w, &[WORLD]);
        seed_allowed(&w, listed);
        w
    }

    /// The owner's checked account under `handle`.
    fn bind_owner_row(w: &W<'_>, handle: &str) {
        w.accounts
            .seed(&account_row(owner(), handle, true, T0 - 9_000));
    }

    /// `n` accounts that are not the owner's.
    fn others(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("dev:other-{i:03}")).collect()
    }

    /// The owner asks for its own nonce at `ms` and binds itself to `subject` at `ms + 1`:
    /// through `request_bind_nonce` and `bind_world_account`, or `relayed` through the `_for`
    /// forms naming itself.
    fn owner_binds(
        fx: &Fixture,
        w: &W<'_>,
        relayed: bool,
        subject: &str,
        ms: i64,
    ) -> Result<(), String> {
        let asked = if relayed {
            ask_for(fx, owner(), owner(), ms)
        } else {
            ask(fx, owner(), ms)
        };
        assert_eq!(asked, Ok(()), "the owner's nonce request");
        let (nonce, _) = nonce_of(w, owner()).expect("the owner holds a nonce");
        let att = dev_attestation(&Claims::new(&nonce).with_sub(subject));
        if relayed {
            bind_for(fx, owner(), owner(), ms + 1, &att)
        } else {
            bind(fx, owner(), ms + 1, &att)
        }
    }

    // --- the owner's list ------------------------------------------------------------

    /// Under `Allowlist`, with the owner's account row under `HOST_SUB`, the owner's
    /// `set_world_allowlist` stores the named set and `HOST_SUB`: a list that omits it, an
    /// empty list, and a list that names it (stored once).
    ///
    /// kills: the owner's handle dropped by the owner's own list; the handle stored twice
    /// when named; the kept handle read from another identity's row.
    #[test]
    fn under_allowlist_the_owners_list_keeps_the_owners_account_lpw21_3() {
        let fx = fixture();
        let w = world_under(&fx, Some(WorldAccessRule::Allowlist), &[KEPT_SUB]);
        bind_owner_row(&w, HOST_SUB);
        w.accounts
            .seed(&account_row(alice(), THIRD_SUB, true, T0 - 9_000));
        assert_eq!(set_allow(&fx, owner(), strings(&[SUB, OTHER_SUB])), Ok(()));
        assert_eq!(allowed(&w), sorted(strings(&[HOST_SUB, OTHER_SUB, SUB])));
        assert_eq!(set_allow(&fx, owner(), Vec::new()), Ok(()));
        assert_eq!(allowed(&w), strings(&[HOST_SUB]), "an empty list");
        assert_eq!(set_allow(&fx, owner(), strings(&[SUB, HOST_SUB])), Ok(()));
        assert_eq!(
            allowed(&w),
            sorted(strings(&[HOST_SUB, SUB])),
            "named: stored once"
        );
    }

    /// Under `Allowlist` with an owner account row, 256 other handles are refused with the
    /// too-many error and no write, the stored set intact; 255 others are stored with the
    /// owner's as the 256th, and so are 255 others and the owner's named.
    ///
    /// kills: the list grown past 256 by the kept handle; the list trimmed to fit; the bound
    /// checked on the named list alone; the owner's handle counted twice when named.
    #[test]
    fn under_allowlist_256_others_are_refused_and_255_take_the_owners_as_the_256th_lpw21_3() {
        let fx = fixture();
        let w = world_under(&fx, Some(WorldAccessRule::Allowlist), &[KEPT_SUB]);
        bind_owner_row(&w, HOST_SUB);
        assert_refused(
            &fx,
            &w,
            REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS,
            "256 others",
            || set_allow(&fx, owner(), others(256)),
        );
        assert_eq!(
            allowed(&w),
            strings(&[KEPT_SUB]),
            "the stored set is intact"
        );
        let mut want = others(255);
        want.push(HOST_SUB.to_string());
        let want = sorted(want);
        assert_eq!(set_allow(&fx, owner(), others(255)), Ok(()));
        assert_eq!(allowed(&w), want, "255 others and the owner's");
        let mut named = others(255);
        named.push(HOST_SUB.to_string());
        assert_eq!(set_allow(&fx, owner(), named), Ok(()));
        assert_eq!(allowed(&w), want, "255 others and the owner's, named");
    }

    /// Outside `Allowlist` (no rule row, `Open`, `Password`), and under `Allowlist` with an
    /// owner holding no account row (an attestation binding included), the set is stored
    /// exactly as named: a list without the owner's handle, an empty list, 256 others. Under
    /// `Allowlist` with an owner account row it is not (the control).
    ///
    /// kills: the owner's handle kept under every rule; the owner's binding read as its
    /// account.
    #[test]
    fn outside_allowlist_or_without_an_owner_account_the_set_is_stored_as_named_lpw21_3() {
        {
            let fx = fixture();
            let w = world_under(&fx, Some(WorldAccessRule::Allowlist), &[]);
            bind_owner_row(&w, HOST_SUB);
            assert_eq!(set_allow(&fx, owner(), strings(&[SUB])), Ok(()));
            assert_eq!(
                allowed(&w),
                sorted(strings(&[HOST_SUB, SUB])),
                "control: an owner account row under Allowlist"
            );
        }
        let cases: [(&str, Option<WorldAccessRule>, bool); 4] = [
            ("no rule row", None, true),
            ("Open", Some(WorldAccessRule::Open), true),
            ("Password", Some(WorldAccessRule::Password), true),
            (
                "Allowlist, the owner holding only a binding",
                Some(WorldAccessRule::Allowlist),
                false,
            ),
        ];
        for (label, rule, checked) in cases {
            let fx = fixture();
            let w = world_under(&fx, rule, &[KEPT_SUB]);
            if checked {
                bind_owner_row(&w, HOST_SUB);
            } else {
                w.binding
                    .seed(&binding_row(owner(), HOST_SUB, T0 - 9_000, true, dev_kid()));
            }
            assert_eq!(
                set_allow(&fx, owner(), strings(&[SUB, OTHER_SUB])),
                Ok(()),
                "{label}"
            );
            assert_eq!(
                allowed(&w),
                sorted(strings(&[SUB, OTHER_SUB])),
                "{label}: as named"
            );
            assert_eq!(set_allow(&fx, owner(), Vec::new()), Ok(()), "{label}");
            assert!(allowed(&w).is_empty(), "{label}: an empty list clears it");
            assert_eq!(set_allow(&fx, owner(), others(256)), Ok(()), "{label}");
            assert_eq!(allowed(&w), sorted(others(256)), "{label}: 256 others");
        }
    }

    /// The handle kept is the owner's alone: under `Allowlist` the owner's list that omits
    /// another identity's handle takes it off, and that identity is refused.
    ///
    /// kills: every checked identity's handle kept.
    #[test]
    fn the_owners_list_that_omits_another_bound_identitys_account_removes_it_lpw21_3() {
        let fx = fixture();
        let w = world_under(&fx, Some(WorldAccessRule::Allowlist), &[SUB, HOST_SUB]);
        bind_owner_row(&w, HOST_SUB);
        w.accounts
            .seed(&account_row(alice(), SUB, true, T0 - 9_000));
        assert_eq!(passes(&fx, alice(), T0), Ok(()), "control: alice is listed");
        assert_eq!(set_allow(&fx, owner(), Vec::new()), Ok(()));
        assert_eq!(allowed(&w), strings(&[HOST_SUB]));
        assert_eq!(
            passes(&fx, alice(), T0 + 1),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
    }

    // --- the owner's bind ------------------------------------------------------------

    /// The owner's bind under every rule (no rule row, `Open`, `Password`, `Allowlist`),
    /// self-serve and relayed, stores its binding and leaves the list untouched, with no
    /// write: the list holds handles, and a binding names none.
    ///
    /// kills: a bind that lists the attested subject.
    #[test]
    fn the_owners_bind_never_writes_the_list_lpw23_7() {
        for rule in [
            None,
            Some(WorldAccessRule::Open),
            Some(WorldAccessRule::Password),
            Some(WorldAccessRule::Allowlist),
        ] {
            for relayed in [false, true] {
                let fx = fixture();
                let label = format!("{rule:?}, relayed {relayed}");
                let w = world_under(&fx, rule, &[KEPT_SUB]);
                fx.reset_writes();
                assert_eq!(
                    owner_binds(&fx, &w, relayed, HOST_SUB, T0),
                    Ok(()),
                    "{label}"
                );
                assert_eq!(
                    bindings(&w),
                    vec![bview(owner(), HOST_SUB, T0 + 1, true, dev_kid())],
                    "{label}"
                );
                assert_eq!(fx.writes_to("world_allowlist"), 0, "{label}");
                assert_eq!(allowed(&w), strings(&[KEPT_SUB]), "{label}");
            }
        }
    }

    /// A joiner's bind under `Allowlist`, self-serve (an unbound identity holding an
    /// admission row) and relayed by the owner, leaves the list untouched.
    ///
    /// kills: a bind under `Allowlist` listing its subject (a joiner letting itself in); the
    /// relayed form keyed on the caller instead of `who`.
    #[test]
    fn a_joiners_bind_under_allowlist_leaves_the_list_untouched_lpw21_3() {
        let fx = fixture();
        let w = world_under(&fx, Some(WorldAccessRule::Allowlist), &[KEPT_SUB]);
        w.admission.seed(&admission_row(alice()));
        assert_eq!(ask(&fx, alice(), T0), Ok(()));
        let (nonce, _) = nonce_of(&w, alice()).expect("alice holds a nonce");
        let att = dev_attestation(&Claims::new(&nonce).with_sub(SUB));
        fx.reset_writes();
        assert_eq!(bind(&fx, alice(), T0 + 1, &att), Ok(()), "self-serve");
        assert_eq!(fx.writes_to("world_allowlist"), 0, "self-serve");
        assert_eq!(allowed(&w), strings(&[KEPT_SUB]), "self-serve");
        assert_eq!(ask_for(&fx, owner(), bob(), T0 + 2), Ok(()));
        let (nonce, _) = nonce_of(&w, bob()).expect("bob holds a nonce");
        let att = dev_attestation(&Claims::new(&nonce).with_sub(OTHER_SUB));
        fx.reset_writes();
        assert_eq!(
            bind_for(&fx, owner(), bob(), T0 + 3, &att),
            Ok(()),
            "relayed"
        );
        assert_eq!(fx.writes_to("world_allowlist"), 0, "relayed");
        assert_eq!(allowed(&w), strings(&[KEPT_SUB]), "relayed");
        assert_eq!(
            bindings(&w),
            sorted(vec![
                bview(alice(), SUB, T0 + 1, true, dev_kid()),
                bview(bob(), OTHER_SUB, T0 + 3, true, dev_kid()),
            ])
        );
    }

    // --- accounts are byte strings ---------------------------------------------------

    /// The owner's handle, in lower case.
    const LOWER_SUB: &str = "dev:alice-host-0001";
    /// [`LOWER_SUB`] in upper case: another account.
    const UPPER_SUB: &str = "dev:ALICE-HOST-0001";
    /// [`LOWER_SUB`] and one more character: another account.
    const LONGER_SUB: &str = "dev:alice-host-00012";

    /// Under `Allowlist`, with the owner's handle `LOWER_SUB`, the owner's list naming only
    /// its upper-case spelling, or only an account it is a strict prefix of, stores the named
    /// account and the owner's; 255 others and the upper-case spelling are refused as 257
    /// accounts, with no write.
    ///
    /// kills: the owner's account taken as listed when another case of it, or a longer
    /// account it begins, is named.
    #[test]
    fn the_owners_list_keeps_its_account_beside_another_spelling_of_it_lpw21_3() {
        let fx = fixture();
        let w = world_under(&fx, Some(WorldAccessRule::Allowlist), &[]);
        bind_owner_row(&w, LOWER_SUB);
        assert_eq!(set_allow(&fx, owner(), strings(&[UPPER_SUB])), Ok(()));
        assert_eq!(
            allowed(&w),
            sorted(strings(&[LOWER_SUB, UPPER_SUB])),
            "the upper-case spelling named"
        );
        assert_eq!(set_allow(&fx, owner(), strings(&[LONGER_SUB])), Ok(()));
        assert_eq!(
            allowed(&w),
            sorted(strings(&[LONGER_SUB, LOWER_SUB])),
            "a longer account named"
        );
        let mut named = others(255);
        named.push(UPPER_SUB.to_string());
        assert_refused(
            &fx,
            &w,
            REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS,
            "255 others and the upper-case spelling",
            || set_allow(&fx, owner(), named),
        );
    }
}

// =====================================================================================
// The owner edits the list a switch to `Allowlist` made: a removed account's identities are
// refused everywhere at their next call, and a returned one's are let in.
// =====================================================================================

mod list_edits {
    use super::join_fixture::{join, join_footprint, join_world, joined};
    use super::*;
    use crate::access::REJECT_NOT_ADMITTED;
    use crate::schema::WorldAdmissionAttempt;

    const HOST_SUB: &str = "dev:aaaaaaaa-0000-4000-8000-00000000a1a1";
    const X1_CONN: u128 = 0x0C1C;

    /// Checked in under [`SUB`], connected at the switch.
    fn x1() -> Identity {
        id(0xC1)
    }

    /// Checked in under [`THIRD_SUB`], never connected.
    fn x2() -> Identity {
        id(0xC2)
    }

    /// Checked in under [`OTHER_SUB`].
    fn y() -> Identity {
        id(0xC3)
    }

    /// [`owned_world`] named [`WORLD`], with what `set_world_access` touches registered too:
    /// `world_access` and `world_admission` writable, `world_binding` scannable, and
    /// `world_admission_attempt` read by `identity` (not writable: no identity here holds a
    /// wrong-password record). [`world`] registers `world_account` scannable for the seed.
    fn switchable_world(fx: &Fixture) -> W<'_> {
        let w = owned_world(fx);
        let _ = fx
            .table_keyed::<WorldAccess, u32>("world_access", "id", |r| r.id)
            .unique()
            .writable();
        let _ = fx
            .table::<WorldAdmission>("world_admission", "identity", |r| r.identity)
            .unique()
            .writable();
        let _ = fx
            .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
            .unique()
            .writable()
            .scannable();
        let _ = fx
            .table::<WorldAdmissionAttempt>("world_admission_attempt", "identity", |r| r.identity)
            .unique();
        seed_names(&w, &[WORLD]);
        w
    }

    /// The owner switches the world to `Allowlist` at `ms`.
    fn switch(fx: &Fixture, ms: i64) -> Result<(), String> {
        call(fx, owner(), ms, |ctx| {
            crate::access::set_world_access(ctx, WorldAccessRule::Allowlist, Vec::new())
        })
    }

    /// An `Open` world where [`x1`] (connected) holds an account row under [`SUB`], [`x2`]
    /// under [`THIRD_SUB`], [`y`] under [`OTHER_SUB`] and the owner under `HOST_SUB`. The owner
    /// switches it to `Allowlist`, which lists the four handles and gives [`x1`] an admission
    /// row, and then sets the list to [`OTHER_SUB`] alone, which keeps the owner's handle.
    fn delisted_world(fx: &Fixture) -> W<'_> {
        let w = switchable_world(fx);
        for (who, handle) in [
            (x1(), SUB),
            (x2(), THIRD_SUB),
            (y(), OTHER_SUB),
            (owner(), HOST_SUB),
        ] {
            w.accounts.seed(&account_row(who, handle, true, T0 - 5_000));
        }
        w.session.seed(&PlayerSession {
            connection_id: ConnectionId::from_u128(X1_CONN),
            identity: x1(),
        });
        assert_eq!(switch(fx, T0), Ok(()), "the switch");
        assert_eq!(
            allowed(&w),
            sorted(strings(&[HOST_SUB, OTHER_SUB, SUB, THIRD_SUB])),
            "the switch lists every checked handle"
        );
        let admitted: Vec<([u8; 32], i64)> = w
            .admission
            .rows()
            .into_iter()
            .map(|r| (r.identity.to_byte_array(), r.admitted_at_ms))
            .collect();
        assert_eq!(
            admitted,
            vec![(x1().to_byte_array(), T0)],
            "the carry-over admits the connected identity"
        );
        assert_eq!(set_allow(fx, owner(), strings(&[OTHER_SUB])), Ok(()));
        assert_eq!(
            allowed(&w),
            sorted(strings(&[HOST_SUB, OTHER_SUB])),
            "SUB and THIRD_SUB are off the list; the owner's handle is kept"
        );
        w
    }

    /// [`footprint`] without the list.
    fn footprint_but_list(fx: &Fixture, w: &W<'_>) -> Footprint {
        footprint(fx, w)
            .into_iter()
            .filter(|(table, _, _)| *table != "world_allowlist")
            .collect()
    }

    /// After the owner takes `SUB` and `THIRD_SUB` off the list the switch made, both
    /// identities checked in under them, the connected one holding the admission row the
    /// carry-over gave it and the other holding none, are refused with `REJECT_NOT_ADMITTED` by the admission check, at
    /// connect, by `request_bind_nonce` and by the real `join_game`, each with no write; the
    /// identity bound to an account still listed passes and joins.
    ///
    /// kills: the list read once at the switch and remembered; the carry-over's admission
    /// row overriding the list; a refusal that writes.
    #[test]
    fn taking_an_account_off_the_seeded_list_refuses_every_identity_bound_to_it_lpw21_4() {
        let fx = fixture();
        let jw = join_world(&fx);
        let w = delisted_world(&fx);
        for who in [x1(), x2()] {
            let label = format!("bound to the delisted account, {}", who.to_hex());
            assert_refused(
                &fx,
                &w,
                REJECT_NOT_ADMITTED,
                &format!("{label}: the admission check"),
                || passes(&fx, who, T0 + 10),
            );
            assert_refused(
                &fx,
                &w,
                REJECT_NOT_ADMITTED,
                &format!("{label}: connect"),
                || call(&fx, who, T0 + 10, crate::on_connect),
            );
            assert_refused(
                &fx,
                &w,
                REJECT_NOT_ADMITTED,
                &format!("{label}: request_bind_nonce"),
                || ask(&fx, who, T0 + 10),
            );
            fx.reset_writes();
            let before = (footprint(&fx, &w), join_footprint(&fx, &jw));
            assert_eq!(
                join(&fx, who, None, T0 + 10),
                Err(REJECT_NOT_ADMITTED.to_string()),
                "{label}: join_game"
            );
            assert_eq!(
                (footprint(&fx, &w), join_footprint(&fx, &jw)),
                before,
                "{label}: join_game writes nothing"
            );
            assert!(joined(&jw, who).is_empty(), "{label}");
        }
        assert_eq!(
            passes(&fx, y(), T0 + 10),
            Ok(()),
            "bound to an account still listed"
        );
        assert_eq!(join(&fx, y(), None, T0 + 11), Ok(()));
        assert_eq!(joined(&jw, y()), vec!["Ada".to_string()]);
    }

    /// When the owner puts `SUB` and `THIRD_SUB` back, the owner's call writes nothing but
    /// the list, and each identity checked in under them passes at its next call: the
    /// admission check, a nonce request, the connection, and the real `join_game`.
    ///
    /// kills: a delisted identity held out after its handle returns (a refusal recorded);
    /// the owner's list call writing an admission or an account row.
    #[test]
    fn putting_the_account_back_admits_its_identities_at_their_next_call_lpw21_4() {
        let fx = fixture();
        let jw = join_world(&fx);
        let w = delisted_world(&fx);
        fx.reset_writes();
        let before = footprint_but_list(&fx, &w);
        assert_eq!(
            set_allow(&fx, owner(), strings(&[OTHER_SUB, SUB, THIRD_SUB])),
            Ok(())
        );
        assert_eq!(
            allowed(&w),
            sorted(strings(&[HOST_SUB, OTHER_SUB, SUB, THIRD_SUB]))
        );
        assert_eq!(
            footprint_but_list(&fx, &w),
            before,
            "the owner's call writes nothing but the list"
        );
        for who in [x1(), x2()] {
            assert_eq!(passes(&fx, who, T0 + 20), Ok(()), "{}", who.to_hex());
        }
        assert_eq!(ask(&fx, x1(), T0 + 21), Ok(()), "a nonce request");
        assert!(nonce_of(&w, x1()).is_some(), "the nonce is issued");
        assert_eq!(call(&fx, x2(), T0 + 21, crate::on_connect), Ok(()));
        assert_eq!(join(&fx, x2(), None, T0 + 22), Ok(()));
        assert_eq!(joined(&jw, x2()), vec!["Ada".to_string()]);
    }
}

// =====================================================================================
// A player erases their own binding whatever the rule says of them. A binding the build counts
// takes the caller's admission row with it under every rule, so an unbind lets nobody in.
// =====================================================================================

mod unbind {
    use super::join_fixture::{join, join_footprint, join_world, joined};
    use super::*;
    use crate::access::REJECT_NOT_ADMITTED;
    use crate::native_host_tests::VIEW_MY_WORLD_BINDING;
    use crate::schema::WorldAdmissionAttempt;

    const RULES: [WorldAccessRule; 3] = [
        WorldAccessRule::Open,
        WorldAccessRule::Password,
        WorldAccessRule::Allowlist,
    ];

    /// What an unbind writes for a caller holding a binding and a nonce.
    const BINDING_AND_NONCE: [&str; 2] = ["world_binding", "world_bind_nonce"];
    /// What an unbind writes for a caller holding an account row, a binding and a nonce.
    const ACCOUNT_BINDING_AND_NONCE: [&str; 3] =
        ["world_account", "world_binding", "world_bind_nonce"];
    /// The same when the caller also holds an admission row, which goes with the account row.
    const ACCOUNT_BINDING_NONCE_AND_ADMISSION: [&str; 4] = [
        "world_account",
        "world_binding",
        "world_bind_nonce",
        "world_admission",
    ];

    /// An identity holding nothing: no binding, no nonce, no admission row.
    fn carol() -> Identity {
        id(0x33)
    }

    /// An identity whose one row is a wrong-password record.
    fn stranger() -> Identity {
        id(0x44)
    }

    /// [`alice`]'s entitled binding to [`SUB`] under `kid`.
    fn alice_bound(kid: &str) -> WorldBinding {
        binding_row(alice(), SUB, T0 - 1_000, true, kid)
    }

    /// [`alice`]'s checked account under [`SUB`], beside her dev-key binding to it.
    fn alice_checked(w: &W<'_>) {
        w.binding.seed(&alice_bound(dev_kid()));
        w.accounts
            .seed(&account_row(alice(), SUB, true, T0 - 1_000));
    }

    /// The bystander's binding, as [`valid_world`] seeds it.
    fn bob_binding() -> BindingView {
        bview(bob(), OTHER_SUB, T0 - 5_000, true, dev_kid())
    }

    /// The bystander's nonce, as [`valid_world`] seeds it.
    fn bob_nonce() -> NonceView {
        nview(bob(), NONCE_B, NONCE_EXPIRES)
    }

    fn attempt_row(who: Identity) -> WorldAdmissionAttempt {
        WorldAdmissionAttempt {
            identity: who,
            wrong_at_ms: vec![T0 - 3_000, T0 - 2_000],
            last_wrong_at_ms: T0 - 2_000,
        }
    }

    /// [`valid_world`] with `rule` stored: named [`WORLD`], [`alice`] holding [`NONCE_A`] and no
    /// binding, the bystander [`bob`] holding a nonce and a dev-key binding to [`OTHER_SUB`].
    /// `world_admission` is writable here (the no-readmit rule deletes a row of it), and the
    /// wrong-password records are registered on their key, read-only.
    fn unbind_world(
        fx: &Fixture,
        rule: WorldAccessRule,
    ) -> (W<'_>, Handle<'_, WorldAdmissionAttempt>) {
        let w = valid_world(fx);
        let _ = fx
            .table::<WorldAdmission>("world_admission", "identity", |r| r.identity)
            .unique()
            .writable();
        let attempts = fx
            .table::<WorldAdmissionAttempt>("world_admission_attempt", "identity", |r| r.identity)
            .unique();
        w.access.seed(&rule_row(rule));
        (w, attempts)
    }

    /// [`unbind_world`] with what the owner's `set_world_access` writes or scans registered
    /// too: `world_access` writable, and `world_binding` scannable (a switch to `Allowlist`
    /// reads every binding for its seed).
    fn switchable_unbind_world(
        fx: &Fixture,
        rule: WorldAccessRule,
    ) -> (W<'_>, Handle<'_, WorldAdmissionAttempt>) {
        let (w, attempts) = unbind_world(fx, rule);
        let _ = fx
            .table_keyed::<WorldAccess, u32>("world_access", "id", |r| r.id)
            .unique()
            .writable();
        let _ = fx
            .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
            .unique()
            .writable()
            .scannable();
        (w, attempts)
    }

    /// The owner sets the rule to `rule` at `ms`, with the admit list `admit`.
    fn set_rule(
        fx: &Fixture,
        rule: WorldAccessRule,
        admit: Vec<Identity>,
        ms: i64,
    ) -> Result<(), String> {
        call(fx, owner(), ms, |ctx| {
            crate::access::set_world_access(ctx, rule, admit)
        })
    }

    /// [`footprint`] and the wrong-password records, with their write count.
    fn everything(
        fx: &Fixture,
        w: &W<'_>,
        attempts: &Handle<'_, WorldAdmissionAttempt>,
    ) -> Footprint {
        let mut all = footprint(fx, w);
        all.push((
            "world_admission_attempt",
            encs(&attempts.rows()),
            fx.writes_to("world_admission_attempt"),
        ));
        all
    }

    /// `fp` without the entries of the tables in `changed`.
    fn but(fp: &Footprint, changed: &[&str]) -> Footprint {
        fp.iter()
            .filter(|(table, _, _)| !changed.contains(table))
            .cloned()
            .collect()
    }

    /// `who` unbinds and is answered `Ok`; every table outside `changed` then holds what it
    /// held before, with no write call.
    fn assert_unbinds(
        fx: &Fixture,
        w: &W<'_>,
        attempts: &Handle<'_, WorldAdmissionAttempt>,
        who: Identity,
        changed: &[&str],
        label: &str,
    ) {
        fx.reset_writes();
        let before = everything(fx, w, attempts);
        assert_eq!(unbind(fx, who, BIND_AT), Ok(()), "{label}: the unbind");
        assert_eq!(
            but(&everything(fx, w, attempts), changed),
            but(&before, changed),
            "{label}: every other table as it was, with no write call"
        );
    }

    /// The identities holding an admission row, sorted.
    fn admitted(w: &W<'_>) -> Vec<[u8; 32]> {
        sorted(
            w.admission
                .rows()
                .into_iter()
                .map(|r| r.identity.to_byte_array())
                .collect(),
        )
    }

    fn refused() -> Result<(), String> {
        Err(REJECT_NOT_ADMITTED.to_string())
    }

    // --- The caller's binding and nonce go, and nothing else -----------------------------

    /// Under `Open`, a caller holding no admission row unbinds: its binding and nonce go. The
    /// list the rule keeps while it is off, the bystander's binding, nonce and admission row,
    /// and every other table stay, with no write call (none on `world_admission` either).
    ///
    /// kills: the inert reducer (binding and nonce kept); another identity's rows deleted; the
    /// list written; a write to `world_admission` for a caller that holds no row of it.
    #[test]
    fn under_open_a_bound_caller_unbinds_and_nothing_else_is_written_lpw22_1() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Open);
        w.binding.seed(&alice_bound(dev_kid()));
        w.admission.seed(&admission_row(bob()));
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        assert_unbinds(&fx, &w, &attempts, alice(), &BINDING_AND_NONCE, "Open");
        assert_eq!(
            bindings(&w),
            vec![bob_binding()],
            "only the bystander is bound"
        );
        assert_eq!(
            nonces(&w),
            vec![bob_nonce()],
            "only the bystander holds a nonce"
        );
    }

    /// Under `Password`, the world's owner, admitted as the owner and holding no admission row,
    /// unbinds: its binding and nonce go, and every other table stays (alice's admission row
    /// and a stranger's wrong-password record among them), with no write call.
    ///
    /// kills: the inert reducer; another identity's admission row withdrawn; the
    /// wrong-password records written; a write to `world_admission` for a caller that holds no
    /// row of it.
    #[test]
    fn under_password_the_bound_owner_unbinds_and_nothing_else_is_written_lpw22_1() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Password);
        w.binding.seed(&binding_row(
            owner(),
            THIRD_SUB,
            T0 - 2_000,
            true,
            dev_kid(),
        ));
        w.nonce.seed(&nonce_row(owner(), NONCE_C, NONCE_EXPIRES));
        w.admission.seed(&admission_row(alice()));
        attempts.seed(&attempt_row(stranger()));
        assert_eq!(
            passes(&fx, owner(), T0),
            Ok(()),
            "fixture: the owner is admitted"
        );
        assert_unbinds(&fx, &w, &attempts, owner(), &BINDING_AND_NONCE, "the owner");
        assert_eq!(
            bindings(&w),
            vec![bob_binding()],
            "the owner's binding is gone"
        );
        assert_eq!(
            nonces(&w),
            sorted(vec![nview(alice(), NONCE_A, NONCE_EXPIRES), bob_nonce()]),
            "the owner's nonce is gone; the others stay"
        );
    }

    /// Under `Allowlist`, a caller let in by its listed handle, holding no admission row,
    /// unbinds: its account row, binding and nonce go and nothing else is written, not even a
    /// delete call on `world_admission`, which holds no row of the caller. The list and a
    /// bystander's admission row stay.
    ///
    /// kills: the inert reducer; the handle taken off the list; another identity's admission
    /// row withdrawn; a write to `world_admission` for a caller that holds no row of it.
    #[test]
    fn under_allowlist_a_listed_caller_unbinds_and_nothing_else_is_written_lpw22_1() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        alice_checked(&w);
        w.admission.seed(&admission_row(carol()));
        assert_eq!(
            passes(&fx, alice(), T0),
            Ok(()),
            "fixture: the listed handle admits alice"
        );
        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &ACCOUNT_BINDING_AND_NONCE,
            "Allowlist",
        );
        assert!(w.accounts.rows().is_empty(), "alice's account row is gone");
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
        assert_eq!(
            allowed(&w),
            sorted(strings(&[SUB, OTHER_SUB])),
            "the account stays listed"
        );
    }

    /// A binding under a key the build does not hold is erased too, under `Open` and under
    /// `Password`, where a row admits the caller; the row stays.
    ///
    /// kills: an unbind that erases only a binding the build counts (`trusted_binding`).
    #[test]
    fn a_binding_under_a_key_the_build_does_not_hold_is_erased_too_lpw22_1() {
        for rule in [WorldAccessRule::Open, WorldAccessRule::Password] {
            let fx = fixture();
            let (w, attempts) = unbind_world(&fx, rule);
            w.binding.seed(&alice_bound(RETIRED_KID));
            w.admission.seed(&admission_row(alice()));
            let label = format!("{rule:?}, a binding under a retired key");
            assert_unbinds(&fx, &w, &attempts, alice(), &BINDING_AND_NONCE, &label);
            assert_eq!(bindings(&w), vec![bob_binding()], "{label}");
            assert_eq!(nonces(&w), vec![bob_nonce()], "{label}");
        }
    }

    /// A bound caller holding no nonce: only `world_binding` is written. The nonce table, and
    /// the bystander's nonce in it, are not written at all.
    ///
    /// kills: the inert reducer; a nonce delete issued for a caller that holds none.
    #[test]
    fn a_bound_caller_with_no_nonce_writes_only_the_binding_table_lpw22_1() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Open);
        assert_eq!(w.nonce.remove(alice()), 1, "fixture: alice holds no nonce");
        w.binding.seed(&alice_bound(dev_kid()));
        assert_unbinds(&fx, &w, &attempts, alice(), &["world_binding"], "no nonce");
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
    }

    /// The caller's nonce goes with its binding whether or not it has expired; another
    /// identity's expired nonce stays.
    ///
    /// kills: an unbind that deletes only an outstanding (unexpired) nonce; an unbind that
    /// sweeps other identities' expired nonces.
    #[test]
    fn an_expired_nonce_goes_with_the_binding_and_nobody_elses_does_lpw22_1() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Open);
        assert_eq!(
            w.nonce.remove(alice()),
            1,
            "fixture: alice's live nonce removed"
        );
        w.nonce.seed(&nonce_row(alice(), NONCE_A, T0 - 1));
        w.nonce.seed(&nonce_row(id(0x55), NONCE_C, T0 - 1));
        w.binding.seed(&alice_bound(dev_kid()));
        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &BINDING_AND_NONCE,
            "an expired nonce",
        );
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(
            nonces(&w),
            sorted(vec![bob_nonce(), nview(id(0x55), NONCE_C, T0 - 1)]),
            "alice's expired nonce is gone; the other expired nonce stays"
        );
    }

    /// A bound caller whose account is pending deletion is refused by the deletion gate with
    /// no write: its binding and nonce stay.
    ///
    /// kills: the inert reducer (`Ok`); an unbind with no deletion gate before its first write.
    #[test]
    fn a_bound_caller_pending_deletion_is_refused_by_the_deletion_gate() {
        let fx = fixture();
        let (w, _attempts) = unbind_world(&fx, WorldAccessRule::Open);
        w.binding.seed(&alice_bound(dev_kid()));
        w.account.seed(&deleting_account(alice()));
        assert_refused(
            &fx,
            &w,
            crate::guards::REJECT_DELETION_GATED,
            "a bound caller pending deletion",
            || unbind(&fx, alice(), BIND_AT),
        );
        assert!(
            bindings(&w).contains(&bview(alice(), SUB, T0 - 1_000, true, dev_kid())),
            "the binding stays"
        );
        assert_eq!(
            nonce_of(&w, alice()),
            Some((NONCE_A.to_string(), NONCE_EXPIRES)),
            "the nonce stays"
        );
    }

    // --- No binding: success with no write -----------------------------------------------

    /// A caller with no binding is answered `Ok` and nothing is written, under every rule
    /// (under `Password` and `Allowlist` the rule refuses both callers here), whether it holds
    /// a nonce ([`alice`], whose nonce stays) or nothing at all (carol).
    ///
    /// kills (a control against the inert reducer): the nonce of a caller with no binding
    /// deleted; a delete call on a table that holds no row of the caller; a caller with no
    /// binding refused.
    #[test]
    fn a_caller_with_no_binding_succeeds_with_no_write_lpw22_2() {
        for rule in RULES {
            for who in [alice(), carol()] {
                let fx = fixture();
                let (w, attempts) = unbind_world(&fx, rule);
                let label = format!("{rule:?}, {}", who.to_hex());
                fx.reset_writes();
                let before = everything(&fx, &w, &attempts);
                assert_eq!(unbind(&fx, who, BIND_AT), Ok(()), "{label}");
                assert_eq!(
                    everything(&fx, &w, &attempts),
                    before,
                    "{label}: every table as it was, with no write call"
                );
            }
        }
    }

    /// A caller with no binding whose account is pending deletion is answered `Ok` with no
    /// write: there is nothing to erase, and its nonce stays.
    ///
    /// kills (a control against the inert reducer): the deletion gate placed before the
    /// binding lookup.
    #[test]
    fn a_caller_with_no_binding_pending_deletion_succeeds_with_no_write_lpw22_2() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Open);
        w.account.seed(&deleting_account(alice()));
        fx.reset_writes();
        let before = everything(&fx, &w, &attempts);
        assert_eq!(unbind(&fx, alice(), BIND_AT), Ok(()));
        assert_eq!(
            everything(&fx, &w, &attempts),
            before,
            "every table as it was, with no write call"
        );
    }

    // --- A caller the rule refuses still unbinds -----------------------------------------

    /// Under `Password`, a bound caller with no admission row and a wrong-password record is
    /// refused by the rule, and unbinds: its binding and nonce go; its wrong-password record
    /// and every other table stay, with no write call.
    ///
    /// kills: the inert reducer; an admission check in the unbind; the wrong-password record
    /// erased.
    #[test]
    fn under_password_a_caller_the_rule_refuses_still_unbinds_lpw22_3() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Password);
        w.binding.seed(&alice_bound(dev_kid()));
        attempts.seed(&attempt_row(alice()));
        assert_eq!(
            passes(&fx, alice(), T0),
            refused(),
            "fixture: the rule refuses alice"
        );
        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &BINDING_AND_NONCE,
            "unadmitted",
        );
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
    }

    /// Under `Allowlist`, the owner takes the caller's account off the list; the rule refuses
    /// the caller, which holds no admission row, and it unbinds: its binding and nonce go and
    /// nothing else is written.
    ///
    /// kills: the inert reducer; an admission check in the unbind.
    #[test]
    fn under_allowlist_a_delisted_caller_with_no_admission_row_still_unbinds_lpw22_3() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        w.binding.seed(&alice_bound(dev_kid()));
        assert_eq!(set_allow(&fx, owner(), strings(&[OTHER_SUB])), Ok(()));
        assert_eq!(
            passes(&fx, alice(), T0),
            refused(),
            "fixture: delisted, the rule refuses alice"
        );
        assert_unbinds(&fx, &w, &attempts, alice(), &BINDING_AND_NONCE, "delisted");
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
        assert_eq!(
            allowed(&w),
            strings(&[OTHER_SUB]),
            "the list as the owner set it"
        );
    }

    /// The same for a delisted caller holding an account row and an admission row: refused by
    /// the rule, it unbinds, and its account row, binding, nonce and admission row go.
    ///
    /// kills: the inert reducer; an admission check in the unbind; the admission row kept.
    #[test]
    fn under_allowlist_a_delisted_caller_holding_an_admission_row_still_unbinds_lpw22_3() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        alice_checked(&w);
        w.admission.seed(&admission_row(alice()));
        assert_eq!(set_allow(&fx, owner(), strings(&[OTHER_SUB])), Ok(()));
        assert_eq!(
            passes(&fx, alice(), T0),
            refused(),
            "fixture: delisted, the rule refuses alice despite the row"
        );
        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &ACCOUNT_BINDING_NONCE_AND_ADMISSION,
            "delisted, holding a row",
        );
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
        assert!(w.accounts.rows().is_empty(), "the account row is gone");
        assert!(
            admitted(&w).is_empty(),
            "the admission row goes with the account row"
        );
    }

    // --- The owner-scoped view ------------------------------------------------------------

    /// Two bound identities each read only their own binding through `my_world_binding`, and
    /// a third reads none; once [`alice`] unbinds she reads none, and [`bob`] still reads his
    /// own.
    ///
    /// kills: the inert reducer (alice still reads her row); an unbind that erases the
    /// bystander's binding.
    #[test]
    fn each_identity_reads_only_its_own_binding_and_none_once_it_unbinds_lpw22_5() {
        let fx = fixture();
        let w = owned_world(&fx);
        w.binding.seed(&alice_bound(dev_kid()));
        w.binding.seed(&binding_row(
            bob(),
            OTHER_SUB,
            T0 - 5_000,
            false,
            RETIRED_KID,
        ));
        let seen = |who: Identity| -> Vec<BindingView> {
            fx.call_view::<WorldBinding>(VIEW_MY_WORLD_BINDING, who)
                .into_iter()
                .map(|r| {
                    bview(
                        r.identity,
                        &r.account_subject,
                        r.bound_at_ms,
                        r.entitled,
                        &r.key_id,
                    )
                })
                .collect()
        };
        let alice_row = bview(alice(), SUB, T0 - 1_000, true, dev_kid());
        let bob_row = bview(bob(), OTHER_SUB, T0 - 5_000, false, RETIRED_KID);
        assert_eq!(seen(alice()), vec![alice_row], "alice reads her own");
        assert_eq!(seen(bob()), vec![bob_row.clone()], "bob reads his own");
        assert_eq!(seen(carol()), Vec::<BindingView>::new(), "carol reads none");

        assert_eq!(unbind(&fx, alice(), BIND_AT), Ok(()));
        assert_eq!(
            seen(alice()),
            Vec::<BindingView>::new(),
            "unbound, alice reads none"
        );
        assert_eq!(seen(bob()), vec![bob_row], "bob still reads his own");
        assert_eq!(seen(carol()), Vec::<BindingView>::new(), "carol reads none");
    }

    // --- The no-readmit rule ---------------------------------------------------------------

    /// Under `Allowlist`, [`alice`] holds an account row under a listed handle (and a dev-key
    /// binding) and an admission row; the owner takes the handle off the list, and she
    /// unbinds. Her account row, binding, nonce and admission row go, while carol's admission
    /// row, a stranger's wrong-password record and every other table stay, with no write
    /// call. She is then refused with no write by the admission check, at connect, by
    /// `request_bind_nonce` and by the real `join_game`.
    ///
    /// kills: an unbind that keeps the admission row (it would let the unbound identity back
    /// in); the inert reducer; the wrong-password records written with the admission.
    #[test]
    fn a_delisted_caller_that_unbinds_is_not_let_back_in_by_its_admission_readmit_lpw22_6() {
        let fx = fixture();
        let jw = join_world(&fx);
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        alice_checked(&w);
        w.admission.seed(&admission_row(alice()));
        w.admission.seed(&admission_row(carol()));
        attempts.seed(&attempt_row(stranger()));
        assert_eq!(
            passes(&fx, alice(), T0),
            Ok(()),
            "fixture: listed, admitted"
        );
        assert_eq!(set_allow(&fx, owner(), strings(&[OTHER_SUB])), Ok(()));
        assert_eq!(passes(&fx, alice(), T0), refused(), "fixture: delisted");

        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &ACCOUNT_BINDING_NONCE_AND_ADMISSION,
            "delisted",
        );
        assert_eq!(bindings(&w), vec![bob_binding()], "alice's binding is gone");
        assert_eq!(nonces(&w), vec![bob_nonce()], "alice's nonce is gone");
        assert_eq!(
            admitted(&w),
            vec![carol().to_byte_array()],
            "alice's admission row is gone; carol's stays"
        );

        let later = BIND_AT + 10;
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "unbound: the admission check",
            || passes(&fx, alice(), later),
        );
        assert_refused(&fx, &w, REJECT_NOT_ADMITTED, "unbound: connect", || {
            call(&fx, alice(), later, crate::on_connect)
        });
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "unbound: request_bind_nonce",
            || ask(&fx, alice(), later),
        );
        fx.reset_writes();
        let before = (everything(&fx, &w, &attempts), join_footprint(&fx, &jw));
        assert_eq!(
            join(&fx, alice(), None, later),
            refused(),
            "unbound: join_game"
        );
        assert_eq!(
            (everything(&fx, &w, &attempts), join_footprint(&fx, &jw)),
            before,
            "the refused join writes nothing"
        );
        assert!(joined(&jw, alice()).is_empty(), "no player row");
    }

    /// Under `Allowlist`, [`alice`] unbinds while her handle is still listed: her admission
    /// row goes with her account row, so she is refused at once, and still after the owner
    /// takes the handle off the list. The handle itself stays listed until then.
    ///
    /// kills: an unbind that keeps the admission row (the identity would escape the list for
    /// good); the inert reducer.
    #[test]
    fn unbinding_while_listed_is_refused_at_once_and_after_delisting_readmit_lpw22_6() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        alice_checked(&w);
        w.admission.seed(&admission_row(alice()));
        assert_eq!(
            passes(&fx, alice(), T0),
            Ok(()),
            "fixture: listed, admitted"
        );

        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &ACCOUNT_BINDING_NONCE_AND_ADMISSION,
            "listed",
        );
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
        assert!(
            admitted(&w).is_empty(),
            "the admission row goes with the account row"
        );
        assert_eq!(
            allowed(&w),
            sorted(strings(&[SUB, OTHER_SUB])),
            "the account stays listed"
        );
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "unbound while listed: the admission check",
            || passes(&fx, alice(), BIND_AT + 1),
        );
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "unbound while listed: connect",
            || call(&fx, alice(), BIND_AT + 1, crate::on_connect),
        );

        assert_eq!(set_allow(&fx, owner(), strings(&[OTHER_SUB])), Ok(()));
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "after delisting: the admission check",
            || passes(&fx, alice(), BIND_AT + 2),
        );
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "after delisting: connect",
            || call(&fx, alice(), BIND_AT + 2, crate::on_connect),
        );
    }

    /// Under `Password`, a caller the host admitted by a row, holding an account row, unbinds:
    /// its account row, binding, nonce and admission row go, and a stranger's wrong-password
    /// record and every other table stay, with no write call. It is then refused with no write,
    /// at the admission check, at connect and by `request_bind_nonce`, until the owner admits
    /// it again through `set_world_access`'s admit list.
    ///
    /// kills: an unbind that keeps the admission row under `Password` (the identity would keep
    /// its way in without its account); an unbind that withdraws it only under `Allowlist`;
    /// the inert reducer; the wrong-password records written.
    #[test]
    fn under_password_an_unbound_caller_stays_out_until_the_owner_admits_it_readmit_lpw22_6() {
        let fx = fixture();
        let (w, attempts) = switchable_unbind_world(&fx, WorldAccessRule::Password);
        alice_checked(&w);
        w.admission.seed(&admission_row(alice()));
        attempts.seed(&attempt_row(stranger()));
        assert_eq!(
            passes(&fx, alice(), T0),
            Ok(()),
            "fixture: the row admits alice"
        );

        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &ACCOUNT_BINDING_NONCE_AND_ADMISSION,
            "Password",
        );
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
        assert!(
            admitted(&w).is_empty(),
            "the admission row goes with the account row"
        );

        let later = BIND_AT + 10;
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "unbound: the admission check",
            || passes(&fx, alice(), later),
        );
        assert_refused(&fx, &w, REJECT_NOT_ADMITTED, "unbound: connect", || {
            call(&fx, alice(), later, crate::on_connect)
        });
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "unbound: request_bind_nonce",
            || ask(&fx, alice(), later),
        );

        assert_eq!(
            set_rule(&fx, WorldAccessRule::Password, vec![alice()], later + 1),
            Ok(()),
            "the owner admits alice again"
        );
        assert_eq!(
            passes(&fx, alice(), later + 2),
            Ok(()),
            "admitted again by the owner's admit list"
        );
    }

    /// Under `Open`, a caller holding a stale admission row and an account row unbinds: the
    /// admission row goes with the account row, binding and nonce, a bystander's row stays,
    /// and the caller is still admitted, as everyone is under `Open`.
    ///
    /// kills: an unbind that withdraws the admission row only under `Allowlist` or `Password`;
    /// another identity's row withdrawn; the inert reducer.
    #[test]
    fn under_open_an_account_row_takes_a_stale_admission_row_with_it_readmit_lpw22_6() {
        let fx = fixture();
        let (w, attempts) = unbind_world(&fx, WorldAccessRule::Open);
        alice_checked(&w);
        w.admission.seed(&admission_row(alice()));
        w.admission.seed(&admission_row(bob()));
        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &ACCOUNT_BINDING_NONCE_AND_ADMISSION,
            "Open, a stale row",
        );
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
        assert_eq!(
            admitted(&w),
            vec![bob().to_byte_array()],
            "alice's row goes; bob's stays"
        );
        assert_eq!(
            passes(&fx, alice(), BIND_AT + 1),
            Ok(()),
            "Open admits everyone"
        );
    }

    /// Control: a caller whose binding is under a key the build does not hold, admitted by its
    /// row (under `Open` by the rule itself), unbinds under every rule and keeps the row: it
    /// stays admitted.
    ///
    /// kills: the admission row withdrawn for a binding the build does not count; the inert
    /// reducer (the binding stays).
    #[test]
    fn an_uncounted_binding_leaves_the_admission_row_under_every_rule_readmit_lpw22_6() {
        for rule in RULES {
            let fx = fixture();
            let (w, attempts) = unbind_world(&fx, rule);
            seed_allowed(&w, &[OTHER_SUB]);
            w.binding.seed(&alice_bound(RETIRED_KID));
            w.admission.seed(&admission_row(alice()));
            let label = format!("{rule:?}, an uncounted binding");
            assert_eq!(
                passes(&fx, alice(), T0),
                Ok(()),
                "fixture: {label}, alice is admitted"
            );
            assert_unbinds(&fx, &w, &attempts, alice(), &BINDING_AND_NONCE, &label);
            assert_eq!(bindings(&w), vec![bob_binding()], "{label}");
            assert_eq!(
                admitted(&w),
                vec![alice().to_byte_array()],
                "{label}: the row stays"
            );
            assert_eq!(
                passes(&fx, alice(), BIND_AT + 1),
                Ok(()),
                "{label}: still admitted"
            );
        }
    }

    /// A `Password` interlude opens no way past the list. Under `Allowlist`, [`alice`] holds an
    /// account row under a listed handle and an admission row; the owner switches to
    /// `Password`, she unbinds (her row goes with the account row), and the owner takes the
    /// handle off the list and switches back to `Allowlist`. She is refused with no write: by
    /// the admission check, at connect, by `request_bind_nonce` and by the real `join_game`.
    ///
    /// kills: an unbind that withdraws the admission row only while the rule is `Allowlist`
    /// (the row would let her in after the switch back); an unbind that keeps the row; the
    /// inert reducer.
    #[test]
    fn a_password_interlude_does_not_let_an_unbound_identity_past_the_list_readmit_lpw22_6() {
        let fx = fixture();
        let jw = join_world(&fx);
        let (w, attempts) = switchable_unbind_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        alice_checked(&w);
        w.admission.seed(&admission_row(alice()));
        assert_eq!(
            passes(&fx, alice(), T0),
            Ok(()),
            "fixture: listed, admitted"
        );

        assert_eq!(
            set_rule(&fx, WorldAccessRule::Password, Vec::new(), T0),
            Ok(()),
            "the owner switches to Password"
        );
        assert_eq!(
            passes(&fx, alice(), T0),
            Ok(()),
            "under Password, her row admits her"
        );
        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &ACCOUNT_BINDING_NONCE_AND_ADMISSION,
            "under Password",
        );
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
        assert!(admitted(&w).is_empty(), "her row goes with the account row");

        assert_eq!(set_allow(&fx, owner(), strings(&[OTHER_SUB])), Ok(()));
        assert_eq!(
            set_rule(&fx, WorldAccessRule::Allowlist, Vec::new(), BIND_AT + 1),
            Ok(()),
            "the owner switches back to Allowlist"
        );
        assert!(admitted(&w).is_empty(), "the switch back admits nobody");
        assert_eq!(allowed(&w), strings(&[OTHER_SUB]), "SUB is off the list");

        let later = BIND_AT + 10;
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "after the interlude: the admission check",
            || passes(&fx, alice(), later),
        );
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "after the interlude: connect",
            || call(&fx, alice(), later, crate::on_connect),
        );
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "after the interlude: request_bind_nonce",
            || ask(&fx, alice(), later),
        );
        fx.reset_writes();
        let before = (everything(&fx, &w, &attempts), join_footprint(&fx, &jw));
        assert_eq!(
            join(&fx, alice(), None, later),
            refused(),
            "after the interlude: join_game"
        );
        assert_eq!(
            (everything(&fx, &w, &attempts), join_footprint(&fx, &jw)),
            before,
            "the refused join writes nothing"
        );
        assert!(joined(&jw, alice()).is_empty(), "no player row");
    }

    /// An `Open` interlude opens no way past the list either. Under `Allowlist`, [`alice`]
    /// holds an account row under a listed handle and an admission row; the owner switches to
    /// `Open`, she unbinds (her row goes with the account row), and the owner takes the handle
    /// off the list and switches back to `Allowlist`. She holds no live session at the switch
    /// back, so its carry-over admits nobody, and she is refused with no write: by the
    /// admission check, at connect, by `request_bind_nonce` and by the real `join_game`.
    ///
    /// kills: an unbind that withdraws the admission row only under `Password` and `Allowlist`
    /// (the row kept under `Open` would let her in after the switch back); an unbind that keeps
    /// the row; the inert reducer.
    #[test]
    fn an_open_interlude_does_not_let_an_unbound_identity_past_the_list_readmit_lpw22_6() {
        let fx = fixture();
        let jw = join_world(&fx);
        let (w, attempts) = switchable_unbind_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        alice_checked(&w);
        w.admission.seed(&admission_row(alice()));
        assert_eq!(
            passes(&fx, alice(), T0),
            Ok(()),
            "fixture: listed, admitted"
        );

        assert_eq!(
            set_rule(&fx, WorldAccessRule::Open, Vec::new(), T0),
            Ok(()),
            "the owner switches to Open"
        );
        assert_unbinds(
            &fx,
            &w,
            &attempts,
            alice(),
            &ACCOUNT_BINDING_NONCE_AND_ADMISSION,
            "under Open",
        );
        assert_eq!(bindings(&w), vec![bob_binding()]);
        assert_eq!(nonces(&w), vec![bob_nonce()]);
        assert!(admitted(&w).is_empty(), "her row goes with the account row");

        assert_eq!(set_allow(&fx, owner(), strings(&[OTHER_SUB])), Ok(()));
        assert!(
            sessions_of(&w, alice()).is_empty(),
            "fixture: alice holds no live session at the switch back"
        );
        assert_eq!(
            set_rule(&fx, WorldAccessRule::Allowlist, Vec::new(), BIND_AT + 1),
            Ok(()),
            "the owner switches back to Allowlist"
        );
        assert!(admitted(&w).is_empty(), "the switch back admits nobody");
        assert_eq!(allowed(&w), strings(&[OTHER_SUB]), "SUB is off the list");

        let later = BIND_AT + 10;
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "after the interlude: the admission check",
            || passes(&fx, alice(), later),
        );
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "after the interlude: connect",
            || call(&fx, alice(), later, crate::on_connect),
        );
        assert_refused(
            &fx,
            &w,
            REJECT_NOT_ADMITTED,
            "after the interlude: request_bind_nonce",
            || ask(&fx, alice(), later),
        );
        fx.reset_writes();
        let before = (everything(&fx, &w, &attempts), join_footprint(&fx, &jw));
        assert_eq!(
            join(&fx, alice(), None, later),
            refused(),
            "after the interlude: join_game"
        );
        assert_eq!(
            (everything(&fx, &w, &attempts), join_footprint(&fx, &jw)),
            before,
            "the refused join writes nothing"
        );
        assert!(joined(&jw, alice()).is_empty(), "no player row");
    }

    /// Under `Allowlist`, once [`alice`], delisted and holding an admission row, unbinds, she
    /// is refused until she holds an account row again: a relayed bind alone does not let her
    /// in; the account row a fresh check under a listed handle stores does, at the admission
    /// check and at connect.
    ///
    /// kills: an unbind that keeps the admission row (she would be let in before a fresh
    /// check); the inert reducer; a refusal recorded at the unbind that outlives a fresh check;
    /// a bind read as admission.
    #[test]
    fn a_fresh_account_row_under_a_listed_handle_admits_the_identity_again_readmit_lpw22_6() {
        let fx = fixture();
        let (w, _attempts) = unbind_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        alice_checked(&w);
        w.admission.seed(&admission_row(alice()));
        assert_eq!(set_allow(&fx, owner(), strings(&[OTHER_SUB])), Ok(()));
        assert_eq!(unbind(&fx, alice(), BIND_AT), Ok(()), "the unbind");
        assert!(admitted(&w).is_empty(), "the admission row is gone");
        assert_eq!(
            passes(&fx, alice(), BIND_AT + 1),
            refused(),
            "unbound: refused"
        );

        assert_eq!(ask_for(&fx, owner(), alice(), T0 + 2_000), Ok(()));
        let (nonce, _) = nonce_of(&w, alice()).expect("alice holds a fresh nonce");
        let att = dev_attestation(&Claims::new(&nonce).with_sub(OTHER_SUB));
        assert_eq!(
            bind_for(&fx, owner(), alice(), T0 + 3_000, &att),
            Ok(()),
            "the relayed bind"
        );
        assert_eq!(
            passes(&fx, alice(), T0 + 3_500),
            refused(),
            "a binding to a listed subject does not admit"
        );
        w.accounts
            .seed(&account_row(alice(), OTHER_HANDLE, true, T0 + 3_600));
        seed_allowed(&w, &[OTHER_HANDLE]);
        assert_eq!(
            passes(&fx, alice(), T0 + 4_000),
            Ok(()),
            "a listed handle: admitted"
        );
        assert_eq!(call(&fx, alice(), T0 + 4_000, crate::on_connect), Ok(()));
        assert_eq!(sessions_of(&w, alice()), vec![conn_of(alice())]);
    }
}

// =====================================================================================
// The world's owner drops the binding of an identity it names. A binding the build counts
// takes that identity's admission row with it; nothing of the owner's, and nothing of anyone
// else's, changes.
// =====================================================================================

mod drop_binding {
    use super::super::REJECT_NO_BINDING;
    use super::*;
    use crate::access::{REJECT_NOT_ADMITTED, REJECT_NOT_WORLD_OWNER};
    use crate::guards::REJECT_DELETION_GATED;
    use crate::schema::WorldAdmissionAttempt;

    /// What the drop writes when the named identity holds an account row, a binding, a nonce
    /// and an admission row.
    const ACCOUNT_BINDING_NONCE_AND_ADMISSION: [&str; 4] = [
        "world_account",
        "world_binding",
        "world_bind_nonce",
        "world_admission",
    ];
    /// What the drop writes for a named identity holding a binding and a nonce, and no
    /// admission row the drop withdraws.
    const BINDING_AND_NONCE: [&str; 2] = ["world_binding", "world_bind_nonce"];

    /// An identity holding nothing: no binding, no nonce, no admission row.
    fn carol() -> Identity {
        id(0x33)
    }

    /// An identity with a binding of its own whose account is pending deletion.
    fn dave() -> Identity {
        id(0x66)
    }

    fn attempt_row(who: Identity) -> WorldAdmissionAttempt {
        WorldAdmissionAttempt {
            identity: who,
            wrong_at_ms: vec![T0 - 3_000, T0 - 2_000],
            last_wrong_at_ms: T0 - 2_000,
        }
    }

    /// [`alice`]'s entitled binding to [`SUB`] under `kid`.
    fn alice_bound(kid: &str) -> WorldBinding {
        binding_row(alice(), SUB, T0 - 1_000, true, kid)
    }

    fn bob_binding() -> BindingView {
        bview(bob(), OTHER_SUB, T0 - 5_000, true, dev_kid())
    }

    fn bob_nonce() -> NonceView {
        nview(bob(), NONCE_B, NONCE_EXPIRES)
    }

    fn owner_binding() -> BindingView {
        bview(owner(), THIRD_SUB, T0 - 2_000, true, dev_kid())
    }

    fn owner_nonce() -> NonceView {
        nview(owner(), NONCE_C, NONCE_EXPIRES)
    }

    /// [`valid_world`] with `rule` stored: [`alice`] holds [`NONCE_A`] and no binding; the
    /// bystander [`bob`] holds a nonce, a dev-key binding to [`OTHER_SUB`] and an admission
    /// row; the owner holds a dev-key binding to [`THIRD_SUB`], a nonce and an admission row
    /// of its own. `world_admission` is writable (the drop withdraws a row of it), and the
    /// wrong-password records are registered on their key, read-only.
    fn drop_world(
        fx: &Fixture,
        rule: WorldAccessRule,
    ) -> (W<'_>, Handle<'_, WorldAdmissionAttempt>) {
        let w = valid_world(fx);
        let _ = fx
            .table::<WorldAdmission>("world_admission", "identity", |r| r.identity)
            .unique()
            .writable();
        let attempts = fx
            .table::<WorldAdmissionAttempt>("world_admission_attempt", "identity", |r| r.identity)
            .unique();
        w.access.seed(&rule_row(rule));
        w.binding.seed(&binding_row(
            owner(),
            THIRD_SUB,
            T0 - 2_000,
            true,
            dev_kid(),
        ));
        w.nonce.seed(&nonce_row(owner(), NONCE_C, NONCE_EXPIRES));
        w.admission.seed(&admission_row(owner()));
        w.admission.seed(&admission_row(bob()));
        (w, attempts)
    }

    /// [`footprint`] and the wrong-password records, with their write count.
    fn everything(
        fx: &Fixture,
        w: &W<'_>,
        attempts: &Handle<'_, WorldAdmissionAttempt>,
    ) -> Footprint {
        let mut all = footprint(fx, w);
        all.push((
            "world_admission_attempt",
            encs(&attempts.rows()),
            fx.writes_to("world_admission_attempt"),
        ));
        all
    }

    /// `fp` without the entries of the tables in `changed`.
    fn but(fp: &Footprint, changed: &[&str]) -> Footprint {
        fp.iter()
            .filter(|(table, _, _)| !changed.contains(table))
            .cloned()
            .collect()
    }

    /// The owner drops `who`'s binding and is answered `Ok`; every table outside `changed`
    /// then holds what it held before, with no write call.
    fn assert_drops(
        fx: &Fixture,
        w: &W<'_>,
        attempts: &Handle<'_, WorldAdmissionAttempt>,
        who: Identity,
        changed: &[&str],
        label: &str,
    ) {
        fx.reset_writes();
        let before = everything(fx, w, attempts);
        assert_eq!(
            drop_binding_of(fx, owner(), who, BIND_AT),
            Ok(()),
            "{label}: the drop"
        );
        assert_eq!(
            but(&everything(fx, w, attempts), changed),
            but(&before, changed),
            "{label}: every other table as it was, with no write call"
        );
    }

    /// `caller`'s drop of `who` answers exactly `want`, and every registered table holds what
    /// it held before, with no write call.
    fn assert_drop_refused(
        fx: &Fixture,
        w: &W<'_>,
        attempts: &Handle<'_, WorldAdmissionAttempt>,
        (caller, who): (Identity, Identity),
        want: &str,
        label: &str,
    ) {
        fx.reset_writes();
        let before = everything(fx, w, attempts);
        assert_eq!(
            drop_binding_of(fx, caller, who, BIND_AT),
            Err(want.to_string()),
            "{label}"
        );
        assert_eq!(
            everything(fx, w, attempts),
            before,
            "{label}: every table as seeded, and no write call"
        );
    }

    /// The identities holding an admission row, sorted.
    fn admitted(w: &W<'_>) -> Vec<[u8; 32]> {
        sorted(
            w.admission
                .rows()
                .into_iter()
                .map(|r| r.identity.to_byte_array())
                .collect(),
        )
    }

    // --- The named identity's rows go, and nothing else ---------------------------------

    /// Under `Allowlist`, [`alice`], admitted by her listed handle and holding a dev-key
    /// binding, an admission row and a wrong-password record, is dropped by the owner: her
    /// account row, binding, nonce and admission row go and she is refused. The owner's own
    /// binding, nonce and admission row, the bystander's, the list (her handle still on it)
    /// and her wrong-password record all stay, with no write call outside the four tables.
    ///
    /// kills: the inert reducer; the caller's (owner's) rows erased in place of the named
    /// identity's; the admission never withdrawn with the account row; the list, the
    /// wrong-password records or a bystander's rows written.
    #[test]
    fn the_owner_drops_an_account_row_with_its_binding_nonce_and_admission_wr261127a_5() {
        let fx = fixture();
        let (w, attempts) = drop_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB, THIRD_SUB]);
        w.binding.seed(&alice_bound(dev_kid()));
        w.accounts
            .seed(&account_row(alice(), SUB, true, T0 - 1_000));
        w.admission.seed(&admission_row(alice()));
        attempts.seed(&attempt_row(alice()));
        assert_eq!(
            passes(&fx, alice(), T0),
            Ok(()),
            "fixture: the listed handle admits alice"
        );
        assert_drops(
            &fx,
            &w,
            &attempts,
            alice(),
            &ACCOUNT_BINDING_NONCE_AND_ADMISSION,
            "an account row",
        );
        assert!(w.accounts.rows().is_empty(), "alice's account row is gone");
        assert_eq!(
            bindings(&w),
            sorted(vec![bob_binding(), owner_binding()]),
            "alice's binding is gone; the owner's and the bystander's stay"
        );
        assert_eq!(
            nonces(&w),
            sorted(vec![bob_nonce(), owner_nonce()]),
            "alice's nonce is gone; the owner's and the bystander's stay"
        );
        assert_eq!(
            admitted(&w),
            sorted(vec![bob().to_byte_array(), owner().to_byte_array()]),
            "alice's admission row is gone; the owner's and the bystander's stay"
        );
        assert_eq!(
            passes(&fx, alice(), BIND_AT + 1),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "dropped and holding no admission row, alice is refused"
        );
    }

    /// Under `Open` and under `Password`, [`alice`] holds an account row, a dev-key binding, a
    /// nonce and an admission row, and the bystander holds an admission row. The owner's drop
    /// takes her account row, binding, nonce and admission row; the owner's and the
    /// bystander's rows stay, with no write call outside the four tables.
    ///
    /// kills: the admission withdrawn only when the rule in force is `Allowlist`.
    #[test]
    fn under_open_and_password_an_account_rows_admission_goes_with_the_drop_wr261127a_5() {
        for (rule, label) in [
            (WorldAccessRule::Open, "under Open"),
            (WorldAccessRule::Password, "under Password"),
        ] {
            let fx = fixture();
            let (w, attempts) = drop_world(&fx, rule);
            w.binding.seed(&alice_bound(dev_kid()));
            w.accounts
                .seed(&account_row(alice(), SUB, true, T0 - 1_000));
            w.admission.seed(&admission_row(alice()));
            assert!(
                admitted(&w).contains(&alice().to_byte_array()),
                "{label}: fixture: alice holds an admission row"
            );
            assert_drops(
                &fx,
                &w,
                &attempts,
                alice(),
                &ACCOUNT_BINDING_NONCE_AND_ADMISSION,
                label,
            );
            assert_eq!(
                bindings(&w),
                sorted(vec![bob_binding(), owner_binding()]),
                "{label}: alice's binding is gone; the owner's and the bystander's stay"
            );
            assert_eq!(
                nonces(&w),
                sorted(vec![bob_nonce(), owner_nonce()]),
                "{label}: alice's nonce is gone; the owner's and the bystander's stay"
            );
            assert_eq!(
                admitted(&w),
                sorted(vec![bob().to_byte_array(), owner().to_byte_array()]),
                "{label}: alice's admission row is gone; the owner's and the bystander's stay"
            );
        }
    }

    /// Under `Password`, a binding under a key the build does not hold is dropped too, with
    /// its nonce; the identity's admission row stays, with no write call on
    /// `world_admission`, and still admits it.
    ///
    /// kills: a drop that erases only a binding the build counts; the admission withdrawn
    /// for a binding the build does not count.
    #[test]
    fn the_owner_drops_an_uncounted_binding_and_its_admission_stays_wr261127a_5() {
        let fx = fixture();
        let (w, attempts) = drop_world(&fx, WorldAccessRule::Password);
        w.binding.seed(&alice_bound(RETIRED_KID));
        w.admission.seed(&admission_row(alice()));
        assert_drops(
            &fx,
            &w,
            &attempts,
            alice(),
            &BINDING_AND_NONCE,
            "an uncounted binding",
        );
        assert_eq!(bindings(&w), sorted(vec![bob_binding(), owner_binding()]));
        assert_eq!(nonces(&w), sorted(vec![bob_nonce(), owner_nonce()]));
        assert_eq!(
            passes(&fx, alice(), BIND_AT + 1),
            Ok(()),
            "the admission row still admits alice"
        );
    }

    /// The named identity's nonce goes with its binding whether or not it has expired, and
    /// another identity's expired nonce stays. It holds no admission row, so
    /// `world_admission` is not written.
    ///
    /// kills: a drop that deletes only an outstanding (unexpired) nonce, or none; a sweep of
    /// other identities' expired nonces; an admission delete issued for an identity that
    /// holds no admission row.
    #[test]
    fn an_expired_nonce_goes_with_the_dropped_binding_wr261127a_5() {
        let fx = fixture();
        let (w, attempts) = drop_world(&fx, WorldAccessRule::Open);
        assert_eq!(
            w.nonce.remove(alice()),
            1,
            "fixture: alice's live nonce removed"
        );
        w.nonce.seed(&nonce_row(alice(), NONCE_A, T0 - 1));
        w.nonce.seed(&nonce_row(id(0x55), NONCE_C, T0 - 1));
        w.binding.seed(&alice_bound(dev_kid()));
        assert_drops(
            &fx,
            &w,
            &attempts,
            alice(),
            &BINDING_AND_NONCE,
            "an expired nonce",
        );
        assert_eq!(bindings(&w), sorted(vec![bob_binding(), owner_binding()]));
        assert_eq!(
            nonces(&w),
            sorted(vec![
                bob_nonce(),
                owner_nonce(),
                nview(id(0x55), NONCE_C, T0 - 1)
            ]),
            "alice's expired nonce is gone; the other expired nonce stays"
        );
    }

    /// A bound identity holding no nonce and no admission row: only `world_binding` is
    /// written.
    ///
    /// kills: a nonce delete issued for an identity that holds none; an admission delete
    /// issued for an identity that holds none.
    #[test]
    fn a_bound_identity_with_no_nonce_writes_only_the_binding_table_wr261127a_5() {
        let fx = fixture();
        let (w, attempts) = drop_world(&fx, WorldAccessRule::Open);
        assert_eq!(w.nonce.remove(alice()), 1, "fixture: alice holds no nonce");
        w.binding.seed(&alice_bound(dev_kid()));
        assert_drops(&fx, &w, &attempts, alice(), &["world_binding"], "no nonce");
        assert_eq!(bindings(&w), sorted(vec![bob_binding(), owner_binding()]));
        assert_eq!(nonces(&w), sorted(vec![bob_nonce(), owner_nonce()]));
    }

    // --- Refusals ---------------------------------------------------------------------

    /// Under `Allowlist`, every caller but the owner is refused with the owner refusal and no
    /// write: an admitted, bound caller naming a bound bystander, naming itself, naming an
    /// identity with no binding and naming an identity pending deletion; a bound bystander
    /// naming it; and an unbound caller the rule refuses.
    ///
    /// kills: the inert reducer; no owner check; the binding lookup or the deletion gate
    /// placed before the owner check.
    #[test]
    fn anyone_but_the_owner_is_refused_with_no_write_wr261127a_6() {
        let fx = fixture();
        let (w, attempts) = drop_world(&fx, WorldAccessRule::Allowlist);
        seed_allowed(&w, &[SUB, OTHER_SUB]);
        w.binding.seed(&alice_bound(dev_kid()));
        w.admission.seed(&admission_row(alice()));
        w.binding
            .seed(&binding_row(dave(), THIRD_SUB, T0 - 3_000, true, dev_kid()));
        w.account.seed(&deleting_account(dave()));
        assert_eq!(
            passes(&fx, alice(), T0),
            Ok(()),
            "fixture: alice is admitted"
        );
        for (pair, label) in [
            ((alice(), bob()), "alice naming bob"),
            ((alice(), alice()), "alice naming herself"),
            (
                (alice(), carol()),
                "alice naming an identity with no binding",
            ),
            (
                (alice(), dave()),
                "alice naming an identity pending deletion",
            ),
            ((bob(), alice()), "bob naming alice"),
            ((carol(), alice()), "an unbound, unadmitted caller"),
        ] {
            assert_drop_refused(&fx, &w, &attempts, pair, REJECT_NOT_WORLD_OWNER, label);
        }
    }

    /// The owner naming an identity with no binding is refused with no write, whether it
    /// holds nothing (carol) or a nonce and an admission row ([`alice`], whose rows stay).
    ///
    /// kills: the inert reducer; `Ok` for an identity with no binding; its nonce or its
    /// admission row deleted.
    #[test]
    fn the_owner_naming_an_identity_with_no_binding_is_refused_wr261127a_6() {
        let fx = fixture();
        let (w, attempts) = drop_world(&fx, WorldAccessRule::Password);
        w.admission.seed(&admission_row(alice()));
        for who in [carol(), alice()] {
            let label = format!("no binding: {}", who.to_hex());
            assert_drop_refused(
                &fx,
                &w,
                &attempts,
                (owner(), who),
                REJECT_NO_BINDING,
                &label,
            );
        }
        assert_eq!(
            nonce_of(&w, alice()),
            Some((NONCE_A.to_string(), NONCE_EXPIRES)),
            "alice's nonce stays"
        );
        assert!(
            admitted(&w).contains(&alice().to_byte_array()),
            "alice's admission row stays"
        );
    }

    /// The owner naming a bound identity whose account is pending deletion is refused by the
    /// deletion gate with no write: its binding, nonce and admission row stay.
    ///
    /// kills: the inert reducer; no deletion gate on the named identity.
    #[test]
    fn the_owner_naming_a_bound_identity_pending_deletion_is_refused_wr261127a_6() {
        let fx = fixture();
        let (w, attempts) = drop_world(&fx, WorldAccessRule::Open);
        w.binding.seed(&alice_bound(dev_kid()));
        w.admission.seed(&admission_row(alice()));
        w.account.seed(&deleting_account(alice()));
        assert_drop_refused(
            &fx,
            &w,
            &attempts,
            (owner(), alice()),
            REJECT_DELETION_GATED,
            "a bound identity pending deletion",
        );
        assert!(
            bindings(&w).contains(&bview(alice(), SUB, T0 - 1_000, true, dev_kid())),
            "the binding stays"
        );
    }

    /// The owner naming an identity with no binding whose account is pending deletion gets
    /// the deletion gate's refusal, not the no-binding one: the gate comes before the
    /// binding is read.
    ///
    /// kills: the binding lookup placed before the deletion gate.
    #[test]
    fn the_deletion_gate_comes_before_the_binding_lookup_wr261127a_6() {
        let fx = fixture();
        let (w, attempts) = drop_world(&fx, WorldAccessRule::Open);
        w.account.seed(&deleting_account(alice()));
        assert_drop_refused(
            &fx,
            &w,
            &attempts,
            (owner(), alice()),
            REJECT_DELETION_GATED,
            "an unbound identity pending deletion",
        );
    }
}

// =====================================================================================
// The checked account: the unbind, the owner's drop, the host's list and admission under
// `Allowlist` read and erase `world_account` rows, keyed by handle.
// =====================================================================================

mod checked_accounts {
    use super::*;
    use crate::access::REJECT_NOT_ADMITTED;

    type AccountView = (String, [u8; 32], bool, i64, bool);

    fn accounts(w: &W<'_>) -> Vec<AccountView> {
        sorted(
            w.accounts
                .rows()
                .into_iter()
                .map(|r| {
                    (
                        r.handle,
                        r.identity.to_byte_array(),
                        r.entitled,
                        r.checked_at_ms,
                        r.is_host,
                    )
                })
                .collect(),
        )
    }

    fn rechecks_of(w: &W<'_>) -> Vec<[u8; 32]> {
        sorted(
            w.rechecks
                .rows()
                .into_iter()
                .map(|r| r.identity.to_byte_array())
                .collect(),
        )
    }

    fn admitted(w: &W<'_>) -> Vec<[u8; 32]> {
        sorted(
            w.admission
                .rows()
                .into_iter()
                .map(|r| r.identity.to_byte_array())
                .collect(),
        )
    }

    fn view(row: &WorldAccount) -> AccountView {
        (
            row.handle.clone(),
            row.identity.to_byte_array(),
            row.entitled,
            row.checked_at_ms,
            row.is_host,
        )
    }

    /// [`valid_world`] under `rule`, `world_admission` writable. [`alice`] holds an account
    /// row under [`HANDLE`], an armed re-check and an admission row; the bystander [`bob`]
    /// (whose dev-key binding [`valid_world`] seeds) holds the same three under
    /// [`OTHER_HANDLE`].
    fn checked_world(fx: &Fixture, rule: WorldAccessRule) -> W<'_> {
        let w = valid_world(fx);
        let _ = fx
            .table::<WorldAdmission>("world_admission", "identity", |r| r.identity)
            .unique()
            .writable();
        w.access.seed(&rule_row(rule));
        w.accounts
            .seed(&account_row(alice(), HANDLE, true, T0 - 9_000));
        w.accounts
            .seed(&account_row(bob(), OTHER_HANDLE, true, T0 - 8_000));
        w.rechecks.seed(&recheck_row(alice(), 1));
        w.rechecks.seed(&recheck_row(bob(), 2));
        w.admission.seed(&admission_row(alice()));
        w.admission.seed(&admission_row(bob()));
        w
    }

    /// Under every rule, the caller's unbind erases its account row, its armed re-check and
    /// its admission row (it holds no binding), and the bystander's three rows stay.
    ///
    /// kills: an unbind that answers `Ok` with no write for a caller holding no binding; the
    /// re-check left armed; the admission row kept beside an erased account row; the
    /// bystander's rows erased.
    #[test]
    fn an_unbind_erases_the_callers_account_row_recheck_and_admission_and_no_others_lpw23_10() {
        for rule in [
            WorldAccessRule::Open,
            WorldAccessRule::Password,
            WorldAccessRule::Allowlist,
        ] {
            let fx = fixture();
            let w = checked_world(&fx, rule);
            if rule == WorldAccessRule::Allowlist {
                seed_allowed(&w, &[HANDLE, OTHER_HANDLE]);
            }
            let bob_row = view(&account_row(bob(), OTHER_HANDLE, true, T0 - 8_000));
            assert_eq!(unbind(&fx, alice(), T0), Ok(()), "{rule:?}: the unbind");
            assert_eq!(accounts(&w), vec![bob_row], "{rule:?}: alice's row goes");
            assert_eq!(
                rechecks_of(&w),
                vec![bob().to_byte_array()],
                "{rule:?}: alice's re-check goes"
            );
            assert_eq!(
                admitted(&w),
                vec![bob().to_byte_array()],
                "{rule:?}: alice's admission goes with her account row"
            );
            assert_eq!(
                bindings(&w),
                vec![bob_binding_view()],
                "{rule:?}: bob's binding stays"
            );
        }
    }

    /// A caller whose only link is an attestation binding unbinds: the binding and nonce go,
    /// and its admission row stays (a binding governs no admission).
    ///
    /// kills: the admission row withdrawn because an attestation binding went.
    #[test]
    fn erasing_an_attestation_binding_alone_withdraws_no_admission_lpw23_10() {
        let fx = fixture();
        let w = checked_world(&fx, WorldAccessRule::Password);
        assert_eq!(
            w.accounts.remove(alice()),
            1,
            "fixture: alice holds no account row"
        );
        w.binding
            .seed(&binding_row(alice(), SUB, T0 - 1_000, true, dev_kid()));
        assert_eq!(unbind(&fx, alice(), T0), Ok(()), "the unbind");
        assert_eq!(
            bindings(&w),
            vec![bob_binding_view()],
            "alice's binding goes"
        );
        assert_eq!(
            admitted(&w),
            vec![alice().to_byte_array(), bob().to_byte_array()],
            "alice's admission row stays"
        );
    }

    /// The owner drops [`alice`], who holds an account row and no binding: her account row,
    /// re-check and admission row go; bob's stay.
    ///
    /// kills: a drop refused with `REJECT_NO_BINDING` for an identity holding an account
    /// row; the wrong identity's rows erased.
    #[test]
    fn the_owners_drop_erases_the_named_identitys_account_row_and_no_others_lpw23_10() {
        let fx = fixture();
        let w = checked_world(&fx, WorldAccessRule::Password);
        let bob_row = view(&account_row(bob(), OTHER_HANDLE, true, T0 - 8_000));
        assert_eq!(
            drop_binding_of(&fx, owner(), alice(), T0),
            Ok(()),
            "the drop"
        );
        assert_eq!(accounts(&w), vec![bob_row], "alice's row goes");
        assert_eq!(
            rechecks_of(&w),
            vec![bob().to_byte_array()],
            "her re-check goes"
        );
        assert_eq!(
            admitted(&w),
            vec![bob().to_byte_array()],
            "her admission goes"
        );
    }

    /// Under `Allowlist`: an identity whose account row's handle is listed is admitted with
    /// no admission row; one whose handle is not listed is refused despite an admission row;
    /// an identity with no account row is admitted by an admission row; an identity bound
    /// by attestation to a listed subject, with no account row and no admission row, is
    /// refused.
    ///
    /// kills: `is_admitted` still reading the binding; the handle not compared with the
    /// list; an admission row letting a listed-account holder past the list.
    #[test]
    fn under_allowlist_an_account_row_is_admitted_by_its_listed_handle_alone_lpw23_7() {
        let fx = fixture();
        let w = checked_world(&fx, WorldAccessRule::Allowlist);
        let carol = id(0x33);
        let dave = id(0x44);
        assert_eq!(
            w.admission.remove(alice()),
            1,
            "fixture: alice has no admission row"
        );
        seed_allowed(&w, &[HANDLE, SUB]);
        w.admission.seed(&admission_row(carol));
        w.binding
            .seed(&binding_row(dave, SUB, T0 - 1_000, true, dev_kid()));
        assert_eq!(passes(&fx, alice(), T0), Ok(()), "a listed handle");
        assert_eq!(
            passes(&fx, bob(), T0),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "an unlisted handle, an admission row held"
        );
        assert_eq!(
            passes(&fx, carol, T0),
            Ok(()),
            "no account row, an admission row"
        );
        assert_eq!(
            passes(&fx, dave, T0),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "a binding to a listed subject"
        );
        assert_eq!(passes(&fx, owner(), T0), Ok(()), "the owner");
    }

    /// The owner, holding an account row, sets the list under `Allowlist`: entries are
    /// handles up to `HANDLE_MAX_BYTES` (1024) visible ASCII bytes, so a 1024-byte handle is
    /// stored and a 1025-byte one refuses the whole call with no write, and the owner's own
    /// handle is kept whether or not the call names it.
    ///
    /// kills: the 255-byte subject bound kept; the owner's handle dropped from its own list;
    /// the owner's handle read from a binding.
    #[test]
    fn under_allowlist_the_owners_list_takes_handles_and_keeps_the_owners_lpw23_7() {
        let fx = fixture();
        let w = checked_world(&fx, WorldAccessRule::Allowlist);
        w.accounts
            .seed(&account_row(owner(), OWNER_HANDLE, true, T0 - 7_000));
        let long_ok = format!("k1.{}", "a".repeat(1024 - 3));
        assert_eq!(long_ok.len(), 1024, "fixture: a 1024-byte handle");
        let long_bad = format!("{long_ok}b");
        fx.reset_writes();
        let before = footprint(&fx, &w);
        assert_eq!(
            set_allow(&fx, owner(), vec![HANDLE.to_string(), long_bad]),
            Err(REJECT_ALLOWLIST_ACCOUNT.to_string()),
            "a 1025-byte entry"
        );
        assert_eq!(
            footprint(&fx, &w),
            before,
            "the refused call writes nothing"
        );
        assert_eq!(
            set_allow(&fx, owner(), vec![HANDLE.to_string(), long_ok.clone()]),
            Ok(())
        );
        assert_eq!(
            allowed(&w),
            sorted(vec![HANDLE.to_string(), long_ok, OWNER_HANDLE.to_string()]),
            "the named handles and the owner's own"
        );
    }

    /// The owner's handle under `Allowlist` takes one of the 256 places: 256 other handles
    /// are refused, 255 are stored with it.
    ///
    /// kills: the owner's handle not counted toward the bound.
    #[test]
    fn under_allowlist_the_owners_handle_counts_toward_the_256_lpw23_7() {
        let fx = fixture();
        let w = checked_world(&fx, WorldAccessRule::Allowlist);
        w.accounts
            .seed(&account_row(owner(), OWNER_HANDLE, true, T0 - 7_000));
        let others =
            |n: usize| -> Vec<String> { (0..n).map(|i| format!("k1.other{i:04}")).collect() };
        assert_eq!(
            set_allow(&fx, owner(), others(256)),
            Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS.to_string()),
            "256 others and the owner's"
        );
        assert_eq!(set_allow(&fx, owner(), others(255)), Ok(()));
        let mut want = others(255);
        want.push(OWNER_HANDLE.to_string());
        assert_eq!(allowed(&w), sorted(want), "255 others and the owner's");
    }

    /// [`bob`]'s binding as [`valid_world`] seeds it.
    fn bob_binding_view() -> BindingView {
        bview(bob(), OTHER_SUB, T0 - 5_000, true, dev_kid())
    }
}
