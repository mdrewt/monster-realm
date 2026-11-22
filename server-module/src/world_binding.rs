//! `world_binding` — server-module domain submodule.
//!
//! The account behind an identity of this world. A player connects under the world's own
//! anonymous token and proves an account once, with a world attestation: a compact JWT the
//! account service signs (`POST /attest`), naming this world and carrying the nonce the world
//! chose for that identity. [`bind_identity`] checks it and records the binding. On a build
//! that enforces ownership `accounts::entitled` entitles an identity whose binding carried the
//! entitlement, and under the `Allowlist` rule `access::is_admitted` admits one whose bound
//! account the host listed.
//!
//! A build accepts attestations under the keys of its profile and no others
//! (`BuildProfile::attestation_keys`). A build with no key binds nothing: its four binding
//! reducers answer [`REJECT_BUILD_BINDS_NOTHING`] before they decode, read or write anything,
//! and [`trusted_binding`] answers `None` without reading. A binding records the `kid` that
//! signed it and counts only while the build holds that key.
//!
//! What the verifier reads from a token it has not yet authenticated is the header's `kid`,
//! which only selects one of the build's own keys; the header's `alg` is never read. `iss`,
//! `iat` and `jti` are not read either: the key list is the trust anchor, and the nonce, which
//! lives [`BIND_NONCE_TTL_MS`] and is spent by one bind, bounds an attestation's life and use.
//! The nonce is drawn from `ctx.random()`, which is a function of the call's timestamp: a
//! caller who knows the timestamp can predict it, and nothing here rests on its being secret.
//! What it has to be is one identity's alone, so the identity is mixed into it.
//!
//! WRITE-ISOLATION: this module alone writes `world_binding`, `world_bind_nonce`, `world_name`
//! and `world_allowlist`. It reads the owner and the admission through `crate::access`, and
//! the deletion state through `crate::guards`.

use crate::accounts::{AttestationKey, BuildProfile, BUILD_PROFILE, ENTITLEMENT_BASE_GAME};
use crate::guards::log_reject;
use crate::marshal::now_ms;
use crate::schema::{
    world_allowlist, world_bind_nonce, world_binding, world_name, WorldAllowlist, WorldBindNonce,
    WorldBinding, WorldName,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use spacetimedb::{Identity, ReducerContext, Table};

/// The refusal of a build that holds no attestation key, from each of the four binding
/// reducers, before anything is decoded, read or written.
pub(crate) const REJECT_BUILD_BINDS_NOTHING: &str = "this server takes no world binding";
pub(crate) const REJECT_ATTESTATION_TOO_LONG: &str = "attestation too long";
pub(crate) const REJECT_ATTESTATION_MALFORMED: &str = "malformed attestation";
pub(crate) const REJECT_ATTESTATION_UNKNOWN_KEY: &str = "unknown attestation key";
pub(crate) const REJECT_ATTESTATION_SIGNATURE: &str = "attestation signature does not verify";
pub(crate) const REJECT_ATTESTATION_EXPIRED: &str = "attestation expired";
pub(crate) const REJECT_ATTESTATION_OTHER_WORLD: &str = "attestation names another world";
pub(crate) const REJECT_NO_BIND_NONCE: &str = "no outstanding nonce for this identity";
pub(crate) const REJECT_ATTESTATION_OTHER_NONCE: &str = "attestation carries another nonce";
pub(crate) const REJECT_WORLD_NAME: &str = "a world name is 1 to 512 visible ASCII characters";
pub(crate) const REJECT_TOO_MANY_WORLD_NAMES: &str = "a world has at most 16 names";
pub(crate) const REJECT_ALLOWLIST_ACCOUNT: &str =
    "an allowlist account is 1 to 255 visible ASCII characters";
pub(crate) const REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS: &str = "an allowlist has at most 256 accounts";
pub(crate) const REJECT_DUPLICATE_ENTRY: &str = "the list repeats an entry";

/// A signature check hashes the whole token, so its cost grows with the token's length and a
/// token that fails costs what a valid one costs. An attestation at the account service's
/// bounds for a world's name, a nonce and a subject is about 1.6 KB.
pub(crate) const ATTESTATION_MAX_BYTES: usize = 4096;
/// How long a bind nonce is good for: the lifetime of the attestation that carries it.
pub(crate) const BIND_NONCE_TTL_MS: i64 = 5 * 60 * 1000;
/// A nonce is this many random bytes, written as twice as many lowercase hex characters.
pub(crate) const BIND_NONCE_BYTES: usize = 16;
/// The most expired nonce rows one nonce request deletes: a request costs the same however
/// many rows have expired.
pub(crate) const BIND_NONCE_SWEEP_MAX: usize = 32;
/// The account service's bound on the world an attestation names (`MAX_WORLD_LENGTH`).
pub(crate) const WORLD_NAME_MAX_BYTES: usize = 512;
pub(crate) const MAX_WORLD_NAMES: usize = 16;
/// The account service's bound on an account's subject.
pub(crate) const ACCOUNT_SUBJECT_MAX_BYTES: usize = 255;
pub(crate) const MAX_ALLOWLIST_ACCOUNTS: usize = 256;

// --- Pure core --------------------------------------------------------------------------

/// What a verified attestation says.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct VerifiedAttestation {
    /// The `kid` of the key whose signature verified.
    pub(crate) key_id: String,
    pub(crate) subject: String,
    pub(crate) audience: String,
    pub(crate) nonce: String,
    pub(crate) expires_at_s: i64,
    /// One element of `mr_ent` is the base game.
    pub(crate) entitled: bool,
}

/// The one member of a token's header that is read. A second `kid` is an error.
#[derive(Deserialize)]
struct AttestationHeader {
    kid: String,
}

/// The claims that are read. A second one of any of them, or one of another type, is an error;
/// every other member is ignored. An `mr_ent` that is absent or `null` names no entitlement.
#[derive(Deserialize)]
struct AttestationClaims {
    sub: String,
    aud: String,
    nonce: String,
    exp: i64,
    mr_ent: Option<Vec<String>>,
}

/// Whether `text` is 1 to `max_bytes` bytes, each a visible ASCII character (0x21 to 0x7E):
/// the account service's rule for a world's name, a nonce and an account's subject.
pub(crate) fn is_visible_ascii(text: &str, max_bytes: usize) -> bool {
    !text.is_empty() && text.len() <= max_bytes && text.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Whether a build of `profile` accepts no world binding: it holds no attestation key.
pub(crate) fn binds_nothing(profile: &BuildProfile) -> bool {
    profile.attestation_keys.is_empty()
}

/// Whether an attestation that expires at `expires_at_s` (whole seconds) has expired at
/// `now_ms`. The instant of expiry counts as expired.
pub(crate) fn attestation_expired(expires_at_s: i64, now_ms: i64) -> bool {
    now_ms >= expires_at_s.saturating_mul(1000)
}

/// Whether a bind nonce good until `expires_at_ms` has expired at `now_ms`. The instant of
/// expiry counts as expired.
pub(crate) fn bind_nonce_expired(expires_at_ms: i64, now_ms: i64) -> bool {
    now_ms >= expires_at_ms
}

/// One segment of a compact token: unpadded base64url, decoded strictly. Padding, a character
/// of another alphabet, whitespace and non-canonical trailing bits are all refused, so one
/// token has one spelling.
fn decode_segment(segment: &str) -> Result<Vec<u8>, &'static str> {
    URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| REJECT_ATTESTATION_MALFORMED)
}

/// A JSON object read into `T`. A derived reader also accepts an array, filling fields by
/// position, so anything but an object is refused first.
fn parse_object<'a, T: Deserialize<'a>>(json: &'a [u8]) -> Result<T, &'static str> {
    let opens_an_object = json
        .iter()
        .find(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        == Some(&b'{');
    if !opens_an_object {
        return Err(REJECT_ATTESTATION_MALFORMED);
    }
    serde_json::from_slice(json).map_err(|_| REJECT_ATTESTATION_MALFORMED)
}

/// Check `attestation` against `keys` and answer what it says. Each refusal is one of this
/// module's constants, and the checks run in this order:
///
/// 1. longer than [`ATTESTATION_MAX_BYTES`]: too long, before anything is decoded;
/// 2. not three `.`-separated segments, each non-empty strict unpadded base64url: malformed;
/// 3. a header that is not a JSON object with one string `kid`: malformed;
/// 4. no key of `keys` has that `kid`: unknown key;
/// 5. a signature that is not 64 bytes: malformed;
/// 6. the key's Ed25519 signature over `<header segment>.<payload segment>` does not verify
///    strictly (a non-canonical signature, a small-order key and a listed key that is not a
///    curve point included): signature;
/// 7. a payload that is not a JSON object with string `sub`, `aud` and `nonce`, integer `exp`
///    and, when present, `mr_ent` an array of strings, or whose `sub` is not 1 to
///    [`ACCOUNT_SUBJECT_MAX_BYTES`] visible ASCII characters: malformed.
///
/// The payload is parsed only after the signature verified. The key and the algorithm come
/// from `keys`, never from the token.
pub(crate) fn verify_attestation(
    keys: &[AttestationKey],
    attestation: &str,
) -> Result<VerifiedAttestation, &'static str> {
    if attestation.len() > ATTESTATION_MAX_BYTES {
        return Err(REJECT_ATTESTATION_TOO_LONG);
    }
    let segments: Vec<&str> = attestation.split('.').collect();
    let &[header_segment, payload_segment, signature_segment] = segments.as_slice() else {
        return Err(REJECT_ATTESTATION_MALFORMED);
    };
    if segments.iter().any(|segment| segment.is_empty()) {
        return Err(REJECT_ATTESTATION_MALFORMED);
    }
    let header_json = decode_segment(header_segment)?;
    let payload_json = decode_segment(payload_segment)?;
    let signature_bytes = decode_segment(signature_segment)?;

    let header: AttestationHeader = parse_object(&header_json)?;
    let key = keys
        .iter()
        .find(|key| key.kid == header.kid)
        .ok_or(REJECT_ATTESTATION_UNKNOWN_KEY)?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| REJECT_ATTESTATION_MALFORMED)?;
    let verifying_key =
        VerifyingKey::from_bytes(&key.public_key).map_err(|_| REJECT_ATTESTATION_SIGNATURE)?;
    let signed = &attestation.as_bytes()[..header_segment.len() + 1 + payload_segment.len()];
    verifying_key
        .verify_strict(signed, &signature)
        .map_err(|_| REJECT_ATTESTATION_SIGNATURE)?;

    let claims: AttestationClaims = parse_object(&payload_json)?;
    if !is_visible_ascii(&claims.sub, ACCOUNT_SUBJECT_MAX_BYTES) {
        return Err(REJECT_ATTESTATION_MALFORMED);
    }
    let entitled = claims
        .mr_ent
        .is_some_and(|entitlements| entitlements.iter().any(|e| e == ENTITLEMENT_BASE_GAME));
    Ok(VerifiedAttestation {
        key_id: header.kid,
        subject: claims.sub,
        audience: claims.aud,
        nonce: claims.nonce,
        expires_at_s: claims.exp,
        entitled,
    })
}

/// What a setter's list may hold, and the refusal for each bound.
struct ListRule {
    max_entries: usize,
    too_many: &'static str,
    max_bytes: usize,
    bad_entry: &'static str,
}

const WORLD_NAMES_RULE: ListRule = ListRule {
    max_entries: MAX_WORLD_NAMES,
    too_many: REJECT_TOO_MANY_WORLD_NAMES,
    max_bytes: WORLD_NAME_MAX_BYTES,
    bad_entry: REJECT_WORLD_NAME,
};
const ALLOWLIST_RULE: ListRule = ListRule {
    max_entries: MAX_ALLOWLIST_ACCOUNTS,
    too_many: REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS,
    max_bytes: ACCOUNT_SUBJECT_MAX_BYTES,
    bad_entry: REJECT_ALLOWLIST_ACCOUNT,
};

/// Whether `entries` is a list a setter may store under `rule`: at most `max_entries`, each
/// `is_visible_ascii` within `max_bytes`, none repeated.
fn check_entries(entries: &[String], rule: &ListRule) -> Result<(), &'static str> {
    if entries.len() > rule.max_entries {
        return Err(rule.too_many);
    }
    if !entries.iter().all(|e| is_visible_ascii(e, rule.max_bytes)) {
        return Err(rule.bad_entry);
    }
    let mut sorted: Vec<&String> = entries.iter().collect();
    sorted.sort_unstable();
    if sorted.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(REJECT_DUPLICATE_ENTRY);
    }
    Ok(())
}

// --- Context-bound reads ----------------------------------------------------------------

/// `identity`'s binding, when the build counts it: a row whose `key_id` is the `kid` of one of
/// `profile`'s attestation keys. A build with no key answers `None` without reading.
pub(crate) fn trusted_binding(
    ctx: &ReducerContext,
    profile: &BuildProfile,
    identity: Identity,
) -> Option<WorldBinding> {
    if binds_nothing(profile) {
        return None;
    }
    ctx.db
        .world_binding()
        .identity()
        .find(identity)
        .filter(|binding| {
            profile
                .attestation_keys
                .iter()
                .any(|key| key.kid == binding.key_id)
        })
}

/// Whether `identity` holds a trusted binding whose attestation carried the base game.
pub(crate) fn bound_entitled(
    ctx: &ReducerContext,
    profile: &BuildProfile,
    identity: Identity,
) -> bool {
    trusted_binding(ctx, profile, identity).is_some_and(|binding| binding.entitled)
}

/// Whether the host listed `account_subject`, byte for byte.
pub(crate) fn on_allowlist(ctx: &ReducerContext, account_subject: &str) -> bool {
    ctx.db
        .world_allowlist()
        .account_subject()
        .find(account_subject.to_string())
        .is_some()
}

/// Erase what this module holds about `identity`: its binding and its bind nonce. The deletion
/// cascade's step for these two tables.
pub(crate) fn erase_world_binding(ctx: &ReducerContext, identity: Identity) {
    ctx.db.world_binding().identity().delete(identity);
    ctx.db.world_bind_nonce().identity().delete(identity);
}

// --- Guards and writes ------------------------------------------------------------------

/// Log a refusal and return it. The reason is always one of this module's constants.
fn reject(reducer: &str, sender: Identity, reason: &str) -> Result<(), String> {
    log_reject(reducer, sender, reason);
    Err(reason.to_string())
}

/// The first statement of a binding reducer: a build of `profile` that binds nothing refuses
/// the call here.
fn require_binding_build(
    ctx: &ReducerContext,
    profile: &BuildProfile,
    reducer: &str,
) -> Result<(), String> {
    if binds_nothing(profile) {
        return reject(reducer, ctx.sender(), REJECT_BUILD_BINDS_NOTHING);
    }
    Ok(())
}

/// The nonce for `who` from one call's random bytes: each byte XORed with the byte of the
/// identity at its place, as lowercase hex. Two calls at one instant draw the same bytes, and
/// the nonce is what ties an attestation to one identity, so two identities never get the
/// same one.
fn nonce_for(who: Identity, random: [u8; BIND_NONCE_BYTES]) -> String {
    random
        .iter()
        .zip(who.to_byte_array())
        .map(|(random_byte, identity_byte)| format!("{:02x}", random_byte ^ identity_byte))
        .collect()
}

/// Give `who` a fresh bind nonce, replacing the one it holds, after deleting at most
/// [`BIND_NONCE_SWEEP_MAX`] expired rows.
fn issue_bind_nonce(ctx: &ReducerContext, who: Identity) {
    let now = now_ms(ctx);
    let expired: Vec<Identity> = ctx
        .db
        .world_bind_nonce()
        .expires_at_ms()
        .filter(..=now)
        .take(BIND_NONCE_SWEEP_MAX)
        .map(|row| row.identity)
        .collect();
    for identity in expired {
        ctx.db.world_bind_nonce().identity().delete(identity);
    }
    let row = WorldBindNonce {
        identity: who,
        nonce: nonce_for(who, ctx.random()),
        expires_at_ms: now.saturating_add(BIND_NONCE_TTL_MS),
    };
    if ctx.db.world_bind_nonce().identity().find(who).is_some() {
        ctx.db.world_bind_nonce().identity().update(row);
    } else {
        ctx.db.world_bind_nonce().insert(row);
    }
}

/// Bind `who` to the account `attestation` names, under `profile`'s keys. Refused, each with
/// its own constant and nothing written: an attestation [`verify_attestation`] refuses; one
/// that has expired at this call's time; one whose `aud` is not, byte for byte, a name of this
/// world; no outstanding nonce for `who` (none, or one that has expired); a nonce that is not
/// `who`'s. Otherwise `who`'s binding becomes what the attestation says, replacing one it
/// already holds, and its nonce is spent.
pub(crate) fn bind_identity(
    ctx: &ReducerContext,
    profile: &BuildProfile,
    who: Identity,
    attestation: &str,
    reducer: &str,
) -> Result<(), String> {
    let refuse = |reason: &str| reject(reducer, ctx.sender(), reason);
    let verified = match verify_attestation(profile.attestation_keys, attestation) {
        Ok(verified) => verified,
        Err(reason) => return refuse(reason),
    };
    let now = now_ms(ctx);
    if attestation_expired(verified.expires_at_s, now) {
        return refuse(REJECT_ATTESTATION_EXPIRED);
    }
    if ctx.db.world_name().name().find(verified.audience).is_none() {
        return refuse(REJECT_ATTESTATION_OTHER_WORLD);
    }
    let Some(outstanding) = ctx
        .db
        .world_bind_nonce()
        .identity()
        .find(who)
        .filter(|row| !bind_nonce_expired(row.expires_at_ms, now))
    else {
        return refuse(REJECT_NO_BIND_NONCE);
    };
    if outstanding.nonce != verified.nonce {
        return refuse(REJECT_ATTESTATION_OTHER_NONCE);
    }
    let binding = WorldBinding {
        identity: who,
        account_subject: verified.subject,
        bound_at_ms: now,
        entitled: verified.entitled,
        key_id: verified.key_id,
    };
    if ctx.db.world_binding().identity().find(who).is_some() {
        ctx.db.world_binding().identity().update(binding);
    } else {
        ctx.db.world_binding().insert(binding);
    }
    ctx.db.world_bind_nonce().identity().delete(who);
    Ok(())
}

// --- Reducers ---------------------------------------------------------------------------

/// Ask this world for a bind nonce. The caller reads it through `my_bind_nonce`, has the
/// account service put it in an attestation, and presents that to [`bind_world_account`].
/// One nonce is outstanding per identity; asking again replaces it.
#[spacetimedb::reducer]
pub fn request_bind_nonce(ctx: &ReducerContext) -> Result<(), String> {
    require_binding_build(ctx, &BUILD_PROFILE, "request_bind_nonce")?;
    crate::access::require_admitted(ctx, "request_bind_nonce")?;
    crate::guards::require_not_deleting(ctx, "request_bind_nonce")?;
    issue_bind_nonce(ctx, ctx.sender());
    Ok(())
}

/// [`request_bind_nonce`] for `who`, relayed by the world's owner: an identity the rule has
/// not admitted can call nothing, so under `Allowlist` the owner asks for it and reads the
/// nonce from the table.
#[spacetimedb::reducer]
pub fn request_bind_nonce_for(ctx: &ReducerContext, who: Identity) -> Result<(), String> {
    require_binding_build(ctx, &BUILD_PROFILE, "request_bind_nonce_for")?;
    crate::access::require_world_owner(ctx, "request_bind_nonce_for")?;
    crate::guards::require_subject_not_deleting(ctx, who)?;
    issue_bind_nonce(ctx, who);
    Ok(())
}

/// Bind the caller to the account an attestation names ([`bind_identity`]).
#[spacetimedb::reducer]
pub fn bind_world_account(ctx: &ReducerContext, attestation: String) -> Result<(), String> {
    require_binding_build(ctx, &BUILD_PROFILE, "bind_world_account")?;
    crate::access::require_admitted(ctx, "bind_world_account")?;
    crate::guards::require_not_deleting(ctx, "bind_world_account")?;
    bind_identity(
        ctx,
        &BUILD_PROFILE,
        ctx.sender(),
        &attestation,
        "bind_world_account",
    )
}

/// [`bind_world_account`] for `who`, relayed by the world's owner. Under `Allowlist` this is
/// how a joiner gets in: once `who` is bound to a listed account it is admitted.
#[spacetimedb::reducer]
pub fn bind_world_account_for(
    ctx: &ReducerContext,
    who: Identity,
    attestation: String,
) -> Result<(), String> {
    require_binding_build(ctx, &BUILD_PROFILE, "bind_world_account_for")?;
    crate::access::require_world_owner(ctx, "bind_world_account_for")?;
    crate::guards::require_subject_not_deleting(ctx, who)?;
    bind_identity(
        ctx,
        &BUILD_PROFILE,
        who,
        &attestation,
        "bind_world_account_for",
    )
}

/// Replace the names this world answers to in an attestation. Owner-only. Refused with no
/// write: more than [`MAX_WORLD_NAMES`], an entry that is not 1 to [`WORLD_NAME_MAX_BYTES`]
/// visible ASCII characters, a repeated entry. An empty list leaves the world with no name,
/// and a world with no name accepts no binding.
#[spacetimedb::reducer]
pub fn set_world_names(ctx: &ReducerContext, names: Vec<String>) -> Result<(), String> {
    crate::access::require_world_owner(ctx, "set_world_names")?;
    if let Err(reason) = check_entries(&names, &WORLD_NAMES_RULE) {
        return reject("set_world_names", ctx.sender(), reason);
    }
    let stored: Vec<String> = ctx.db.world_name().iter().map(|row| row.name).collect();
    for name in stored {
        ctx.db.world_name().name().delete(name);
    }
    for name in names {
        ctx.db.world_name().insert(WorldName { name });
    }
    Ok(())
}

/// Replace the accounts the `Allowlist` rule lets in. Owner-only. Refused with no write: more
/// than [`MAX_ALLOWLIST_ACCOUNTS`], an entry that is not 1 to [`ACCOUNT_SUBJECT_MAX_BYTES`]
/// visible ASCII characters, a repeated entry. An identity bound to an account that leaves the
/// list is refused at its next check.
#[spacetimedb::reducer]
pub fn set_world_allowlist(ctx: &ReducerContext, accounts: Vec<String>) -> Result<(), String> {
    crate::access::require_world_owner(ctx, "set_world_allowlist")?;
    if let Err(reason) = check_entries(&accounts, &ALLOWLIST_RULE) {
        return reject("set_world_allowlist", ctx.sender(), reason);
    }
    let stored: Vec<String> = ctx
        .db
        .world_allowlist()
        .iter()
        .map(|row| row.account_subject)
        .collect();
    for account_subject in stored {
        ctx.db
            .world_allowlist()
            .account_subject()
            .delete(account_subject);
    }
    for account_subject in accounts {
        ctx.db
            .world_allowlist()
            .insert(WorldAllowlist { account_subject });
    }
    Ok(())
}

#[cfg(test)]
#[path = "world_binding_tests.rs"]
mod world_binding_tests;
