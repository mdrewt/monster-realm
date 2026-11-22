//! World binding, executed against the in-memory host: the attestation verifier, the nonce and
//! bind reducers, the name and allowlist setters, what a binding means for ownership and for an
//! `Allowlist` world, and the deletion step.
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
    binds_nothing, bound_entitled, erase_world_binding, is_visible_ascii, on_allowlist,
    request_bind_nonce, request_bind_nonce_for, set_world_allowlist, set_world_names,
    trusted_binding, verify_attestation, VerifiedAttestation, ACCOUNT_SUBJECT_MAX_BYTES,
    ATTESTATION_MAX_BYTES, BIND_NONCE_BYTES, BIND_NONCE_SWEEP_MAX, BIND_NONCE_TTL_MS,
    MAX_ALLOWLIST_ACCOUNTS, MAX_WORLD_NAMES, REJECT_ALLOWLIST_ACCOUNT, REJECT_ATTESTATION_EXPIRED,
    REJECT_ATTESTATION_MALFORMED, REJECT_ATTESTATION_OTHER_NONCE, REJECT_ATTESTATION_OTHER_WORLD,
    REJECT_ATTESTATION_SIGNATURE, REJECT_ATTESTATION_TOO_LONG, REJECT_ATTESTATION_UNKNOWN_KEY,
    REJECT_DUPLICATE_ENTRY, REJECT_NO_BIND_NONCE, REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS,
    REJECT_TOO_MANY_WORLD_NAMES, REJECT_WORLD_NAME, WORLD_NAME_MAX_BYTES,
};
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
            ("256 bytes", "a".repeat(ACCOUNT_SUBJECT_MAX_BYTES + 1)),
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
            .map(|i| format!("{i:03}{}", "a".repeat(ACCOUNT_SUBJECT_MAX_BYTES - 3)))
            .collect();
        assert_eq!(set_allow(&fx, owner(), full.clone()), Ok(()));
        assert_eq!(
            allowed(&w),
            sorted(full),
            "256 accounts of 255 bytes are stored"
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

    /// An entitled binding under the dev key: no trusted binding under a keyless profile
    /// (read without touching the table) or one that lacks the key; the row under one that
    /// holds it. An unentitled row is trusted but not entitled.
    ///
    /// kills: a binding trusted whatever key signed it; a keyless build that reads bindings;
    /// `bound_entitled` ignoring `entitled`.
    #[test]
    fn a_binding_counts_only_under_a_profile_holding_its_key_lpw15_3() {
        let fx = fixture();
        let w = world(&fx);
        let entitled_row = binding_row(alice(), SUB, T0, true, dev_kid());
        let unentitled_row = binding_row(bob(), OTHER_SUB, T0, false, dev_kid());
        w.binding.seed(&entitled_row);
        w.binding.seed(&unentitled_row);
        let ctx = fx.ctx();

        let keyless = build_profile(features(0));
        assert!(
            keyless.attestation_keys.is_empty(),
            "fixture: the default build"
        );
        fx.reset_reads();
        assert!(trusted_binding(&ctx, &keyless, alice()).is_none());
        assert!(!bound_entitled(&ctx, &keyless, alice()));
        assert_eq!(
            fx.rows_read("world_binding"),
            0,
            "a keyless build reads no binding"
        );

        let lacking = profile_with(
            leak(vec![listed_key("another-kid", &other_signer(3))]),
            true,
        );
        assert!(trusted_binding(&ctx, &lacking, alice()).is_none());
        assert!(!bound_entitled(&ctx, &lacking, alice()));

        let holding = profile_with(DEV_ATTESTATION_KEYS, true);
        assert_eq!(
            trusted_binding(&ctx, &holding, alice()).map(|r| enc(&r)),
            Some(enc(&entitled_row))
        );
        assert!(bound_entitled(&ctx, &holding, alice()));

        assert_eq!(
            trusted_binding(&ctx, &holding, bob()).map(|r| enc(&r)),
            Some(enc(&unentitled_row)),
            "an unentitled binding is trusted"
        );
        assert!(!bound_entitled(&ctx, &holding, bob()), "and not entitled");
        assert!(
            trusted_binding(&ctx, &holding, id(0x99)).is_none(),
            "no row"
        );
        assert!(!bound_entitled(&ctx, &holding, id(0x99)));
    }

    /// Under a profile holding two keys, a binding made under either key's `kid` is trusted
    /// and, entitled, entitles; one made under a third `kid` is neither.
    ///
    /// kills: only the first listed key compared; only the last; the key list read as one
    /// key.
    #[test]
    fn a_binding_under_any_key_of_the_profile_counts_lpw15_3() {
        let fx = fixture();
        let w = world(&fx);
        let two = profile_with(
            leak(vec![
                listed_key("first-kid", &other_signer(4)),
                listed_key("second-kid", &other_signer(5)),
            ]),
            true,
        );
        let carol = id(0x33);
        let by_second = binding_row(alice(), SUB, T0, true, "second-kid");
        let by_first = binding_row(bob(), OTHER_SUB, T0, true, "first-kid");
        let by_third = binding_row(carol, THIRD_SUB, T0, true, "third-kid");
        w.binding.seed(&by_second);
        w.binding.seed(&by_first);
        w.binding.seed(&by_third);
        let ctx = fx.ctx();
        for (who, row, label) in [
            (alice(), &by_second, "the second key's kid"),
            (bob(), &by_first, "the first key's kid"),
        ] {
            assert_eq!(
                trusted_binding(&ctx, &two, who).map(|r| enc(&r)),
                Some(enc(row)),
                "{label}: trusted"
            );
            assert!(
                bound_entitled(&ctx, &two, who),
                "{label}: bound and entitled"
            );
            assert!(
                call(&fx, who, T0, |c| crate::accounts::entitled(c, &two)),
                "{label}: entitled on an enforcing profile"
            );
        }
        assert!(
            trusted_binding(&ctx, &two, carol).is_none(),
            "a third kid: not trusted"
        );
        assert!(
            !bound_entitled(&ctx, &two, carol),
            "a third kid: not entitled"
        );
        assert!(
            !call(&fx, carol, T0, |c| crate::accounts::entitled(c, &two)),
            "a third kid: refused on an enforcing profile"
        );
    }

    /// `entitled` for a caller with no login token: every caller on a profile that does not
    /// enforce; on one that enforces, only a trusted, entitled binding.
    ///
    /// kills: `entitled` blind to bindings; a binding read on a non-enforcing profile as a
    /// refusal; an untrusted or unentitled binding admitted; a keyless enforcing profile
    /// reading a binding.
    #[test]
    fn entitled_reads_a_trusted_entitled_binding_on_an_enforcing_profile_lpw15_3() {
        let fx = fixture();
        let w = world(&fx);
        let entitled_under = |who: Identity, profile: &BuildProfile| {
            call(&fx, who, T0, |ctx| crate::accounts::entitled(ctx, profile))
        };

        let open = profile_with(&[], false);
        assert!(entitled_under(alice(), &open), "not enforcing, no binding");

        let enforcing = profile_with(DEV_ATTESTATION_KEYS, true);
        assert!(!entitled_under(alice(), &enforcing), "no binding");

        w.binding
            .seed(&binding_row(alice(), SUB, T0, true, dev_kid()));
        assert!(
            entitled_under(alice(), &enforcing),
            "a trusted, entitled binding"
        );
        assert!(entitled_under(alice(), &open));

        w.binding
            .seed(&binding_row(bob(), OTHER_SUB, T0, false, dev_kid()));
        assert!(!entitled_under(bob(), &enforcing), "an unentitled binding");

        let carol = id(0x33);
        w.binding
            .seed(&binding_row(carol, THIRD_SUB, T0, true, RETIRED_KID));
        assert!(
            !entitled_under(carol, &enforcing),
            "a key the profile lacks"
        );

        let keyless_enforcing = profile_with(&[], true);
        assert!(
            !entitled_under(alice(), &keyless_enforcing),
            "a keyless enforcing profile, even with an entitled row"
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

    /// An identity with no binding and no admission is refused at connect; after the owner
    /// relays its bind for a listed account, it connects and passes the admission check.
    ///
    /// kills: `Allowlist` admitting everyone; a binding not consulted; the list not read.
    #[test]
    fn a_relayed_bind_for_a_listed_account_lets_the_identity_in_lpw15_5() {
        let fx = fixture();
        let w = allowlist_world(&fx, &[SUB]);
        assert_eq!(
            call(&fx, who(), T0, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "unbound and unadmitted"
        );
        assert!(sessions_of(&w, who()).is_empty());
        owner_binds(&fx, &w, SUB);
        assert_eq!(call(&fx, who(), T0 + 2_000, crate::on_connect), Ok(()));
        assert_eq!(sessions_of(&w, who()), vec![conn_of(who())]);
        assert_eq!(passes(&fx, who(), T0 + 2_000), Ok(()));
        assert!(
            w.admission.rows().is_empty(),
            "connecting writes no admission"
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

    /// Taking the account off the list refuses the bound identity at the next check.
    ///
    /// kills: admission recorded at bind or connect time and kept after delisting.
    #[test]
    fn taking_the_account_off_the_list_refuses_the_bound_identity_lpw15_5() {
        let fx = fixture();
        let w = allowlist_world(&fx, &[SUB, OTHER_SUB]);
        owner_binds(&fx, &w, SUB);
        assert_eq!(passes(&fx, who(), T0 + 2_000), Ok(()), "listed: admitted");
        assert_eq!(set_allow(&fx, owner(), strings(&[OTHER_SUB])), Ok(()));
        assert_eq!(
            passes(&fx, who(), T0 + 3_000),
            Err(REJECT_NOT_ADMITTED.to_string()),
            "delisted: refused at the next check"
        );
        assert_eq!(
            call(&fx, who(), T0 + 3_000, crate::on_connect),
            Err(REJECT_NOT_ADMITTED.to_string())
        );
    }

    /// A bound identity is governed by the list alone: an admission row does not let in an
    /// identity whose trusted binding names an unlisted account. A binding under a key the
    /// build lacks counts for nothing, so the admission row decides.
    ///
    /// kills: an admission row overriding delisting; an untrusted binding read as a binding.
    #[test]
    fn a_trusted_binding_is_governed_by_the_list_alone_lpw15_5() {
        {
            let fx = fixture();
            let w = allowlist_world(&fx, &[OTHER_SUB]);
            w.admission.seed(&admission_row(who()));
            w.binding
                .seed(&binding_row(who(), SUB, T0 - 5_000, true, dev_kid()));
            assert_eq!(
                passes(&fx, who(), T0),
                Err(REJECT_NOT_ADMITTED.to_string()),
                "bound to an unlisted account: refused despite the admission row"
            );
        }
        {
            let fx = fixture();
            let w = allowlist_world(&fx, &[OTHER_SUB]);
            w.admission.seed(&admission_row(who()));
            w.binding
                .seed(&binding_row(who(), SUB, T0 - 5_000, true, RETIRED_KID));
            assert_eq!(
                passes(&fx, who(), T0),
                Ok(()),
                "an untrusted binding: the admission row admits"
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

    /// A world under `rule` where [`alice`] holds `binding` and is admitted: by its account on
    /// the list when the binding is trusted under `Allowlist`, by an admission row otherwise.
    fn admitted_world<'a>(
        fx: &'a Fixture,
        rule: WorldAccessRule,
        binding: Option<&WorldBinding>,
    ) -> (W<'a>, JoinWorld<'a>) {
        let w = owned_world(fx);
        let jw = join_world(fx);
        if rule != WorldAccessRule::Open {
            w.access.seed(&rule_row(rule));
        }
        if let Some(row) = binding {
            w.binding.seed(row);
        }
        let trusted =
            binding.is_some_and(|row| DEV_ATTESTATION_KEYS.iter().any(|k| k.kid == row.key_id));
        match rule {
            WorldAccessRule::Open => {}
            WorldAccessRule::Allowlist if trusted => {
                let row = binding.expect("a trusted binding");
                seed_allowed(&w, &[row.account_subject.as_str()]);
            }
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
    fn assert_join_refused(binding: Option<WorldBinding>, label: &str) {
        for rule in RULES {
            for jwt in [None, Some(host_minted())] {
                let fx = fixture();
                let (w, jw) = admitted_world(&fx, rule, binding.as_ref());
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
        assert_join_refused(None, "no binding");
    }

    #[test]
    fn a_binding_without_the_entitlement_is_refused_under_every_rule_lpw15_7() {
        assert_join_refused(
            Some(binding_row(alice(), SUB, T0, false, dev_kid())),
            "an unentitled binding",
        );
    }

    #[test]
    fn an_entitled_binding_under_a_key_the_build_lacks_is_refused_under_every_rule_lpw15_7() {
        assert_join_refused(
            Some(binding_row(alice(), SUB, T0, true, RETIRED_KID)),
            "a binding under a retired key",
        );
    }

    #[test]
    fn an_entitled_binding_under_the_dev_key_joins_under_every_rule_lpw15_7() {
        let row = binding_row(alice(), SUB, T0, true, dev_kid());
        for rule in RULES {
            for jwt in [None, Some(host_minted())] {
                let fx = fixture();
                let (_w, jw) = admitted_world(&fx, rule, Some(&row));
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

    /// The real flow on this build: refused, a nonce, a signed attestation, the bind, and
    /// the join goes ahead.
    #[test]
    fn the_real_flow_binds_and_then_joins_lpw15_7() {
        let fx = fixture();
        let w = owned_world(&fx);
        seed_names(&w, &[WORLD]);
        let jw = join_world(&fx);
        assert_eq!(
            join(&fx, alice(), None, T0),
            Err(ERR_OWNERSHIP_REQUIRED.to_string()),
            "unbound: refused"
        );
        assert_eq!(ask(&fx, alice(), T0 + 1), Ok(()));
        let (nonce, _) = nonce_of(&w, alice()).expect("alice holds a nonce");
        assert_eq!(
            bind(&fx, alice(), T0 + 2, &dev_attestation(&Claims::new(&nonce))),
            Ok(())
        );
        assert_eq!(join(&fx, alice(), None, T0 + 3), Ok(()), "bound: joins");
        assert_eq!(joined(&jw, alice()), vec!["Ada".to_string()]);
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
