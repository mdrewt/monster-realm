//! `world_binding` — server-module domain submodule.
//!
//! The world's names, the host's list for the `Allowlist` rule, and the attestation binding.
//!
//! A world answers to the names its owner set ([`set_world_names`]): an attestation's `aud`
//! and the name a ticket was issued for must be one of them, byte for byte.
//!
//! The host's list holds handles: what the account service answers for an account in this
//! world, kept in `world_account` (`crate::account_checks`). Under `Allowlist`
//! `access::is_admitted` admits an identity that holds a `world_account` row exactly while its
//! handle is listed. The list is the owner's to edit ([`set_world_allowlist`]). It is also
//! added to when the rule changes to `Allowlist` (`access::set_world_access` lists the handles
//! of the identities the rule in force admitted, through [`add_to_allowlist`]), and while that
//! rule is in force each of those writes keeps the owner identity's own handle on it: the
//! owner's list cannot leave it out, and a check of the owner's identity adds it. A re-check
//! that is answered under a newer handle replaces the listed one ([`replace_on_allowlist`]).
//! The list never holds more than [`MAX_ALLOWLIST_ACCOUNTS`]; a write that would exceed that
//! is refused whole. An account's deletion takes the deleted identity's handle off the list
//! ([`delist_account_of`]).
//!
//! A player erases what the world holds about its account with [`unbind_world_account`], the
//! one client-callable reducer the access rule does not gate, and the owner erases a named
//! identity's with [`drop_world_binding`]: the `world_account` row with its armed re-check, and
//! the attestation binding with its nonce. Erasing a `world_account` row withdraws that
//! identity's admission row too, so it never lets in an identity whose handle the owner
//! removed.
//!
//! The attestation binding grants nothing: no rule reads it. [`bind_identity`] still checks a
//! world attestation (a compact JWT the account service signs at `POST /attest`, naming this
//! world and carrying the nonce the world chose for that identity) and records the binding. A
//! build accepts attestations under the keys of its profile and no others
//! (`BuildProfile::attestation_keys`). A build with no key binds nothing: its four nonce and
//! bind reducers answer [`REJECT_BUILD_BINDS_NOTHING`] before they decode, read or write
//! anything. A guest claim erases the binding and nonce of the guest identity it retires
//! ([`erase_world_binding`]).
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
//! and `world_allowlist`. It reads the owner and the rule in force through `crate::access` and
//! withdraws an admission through it, reads and erases a `world_account` row through
//! `crate::account_checks`, and reads the deletion state through `crate::guards`.

use crate::accounts::{AttestationKey, BuildProfile, BUILD_PROFILE, ENTITLEMENT_BASE_GAME};
use crate::guards::log_reject;
use crate::marshal::now_ms;
use crate::schema::{
    world_allowlist, world_bind_nonce, world_binding, world_name, WorldAccessRule, WorldAllowlist,
    WorldBindNonce, WorldBinding, WorldName,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use spacetimedb::{Identity, ReducerContext, Table};
use std::collections::BTreeSet;

/// The refusal of a build that holds no attestation key, from each of the four nonce and bind
/// reducers, and of a build that neither binds nor checks an account, from the unbind and the
/// owner's drop, before anything is decoded, read or written.
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
    "an allowlist entry is a handle of 1 to 1024 visible ASCII characters";
/// The refusal of every write that would leave the list with more than
/// [`MAX_ALLOWLIST_ACCOUNTS`]: the owner's list, the handles a change to `Allowlist` adds, and
/// a check of the owner's identity under that rule.
pub(crate) const REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS: &str = "an allowlist has at most 256 accounts";
pub(crate) const REJECT_DUPLICATE_ENTRY: &str = "the list repeats an entry";
/// The owner's drop of an identity that holds neither a `world_account` row nor a binding.
pub(crate) const REJECT_NO_BINDING: &str = "that identity holds no world binding";

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
/// the account service's rule for a world's name, a nonce, an account's subject and a handle.
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
    max_bytes: crate::account_checks::HANDLE_MAX_BYTES,
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

/// The handles of `wanted` that `listed` lacks, compared byte for byte, each once, in
/// ascending byte order. `listed` holds no repeats. Refused with
/// [`REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS`] when `listed` and those additions together number
/// more than [`MAX_ALLOWLIST_ACCOUNTS`].
pub(crate) fn allowlist_additions(
    listed: &[String],
    wanted: &[String],
) -> Result<Vec<String>, &'static str> {
    let held: BTreeSet<&String> = listed.iter().collect();
    let additions: BTreeSet<&String> = wanted
        .iter()
        .filter(|account| !held.contains(account))
        .collect();
    if listed.len() + additions.len() > MAX_ALLOWLIST_ACCOUNTS {
        return Err(REJECT_TOO_MANY_ALLOWLIST_ACCOUNTS);
    }
    Ok(additions.into_iter().cloned().collect())
}

// --- Context-bound reads ----------------------------------------------------------------

/// The names this world answers to, in ascending byte order.
pub(crate) fn world_names(ctx: &ReducerContext) -> Vec<String> {
    let mut names: Vec<String> = ctx.db.world_name().iter().map(|row| row.name).collect();
    names.sort_unstable();
    names
}

/// Whether the host listed `handle`, byte for byte. The column that holds a handle is named
/// `account_subject`.
pub(crate) fn on_allowlist(ctx: &ReducerContext, handle: &str) -> bool {
    ctx.db
        .world_allowlist()
        .account_subject()
        .find(handle.to_string())
        .is_some()
}

/// Erase what this module holds about `identity`: its binding and its bind nonce. The step for
/// these two tables of the deletion cascade, and of a guest claim for the guest identity it
/// retires.
pub(crate) fn erase_world_binding(ctx: &ReducerContext, identity: Identity) {
    ctx.db.world_binding().identity().delete(identity);
    ctx.db.world_bind_nonce().identity().delete(identity);
}

/// Take the handle of `identity`'s `world_account` row off the host's list. The deletion
/// cascade's step for `world_allowlist`. It runs before `account_checks::erase_world_account`:
/// the row is the only record of the handle, so an identity with no row takes nothing off the
/// list, one that unbound or was dropped before its deletion included. An entry the host typed
/// that equals the handle goes too, because it names the same account.
pub(crate) fn delist_account_of(ctx: &ReducerContext, identity: Identity) {
    let Some(account) = crate::account_checks::account_of(ctx, identity) else {
        return;
    };
    if on_allowlist(ctx, &account.handle) {
        ctx.db
            .world_allowlist()
            .account_subject()
            .delete(account.handle);
    }
}

// --- Guards and writes ------------------------------------------------------------------

/// Log a refusal and return it. The reason is always one of this module's constants.
fn reject(reducer: &str, sender: Identity, reason: &str) -> Result<(), String> {
    log_reject(reducer, sender, reason);
    Err(reason.to_string())
}

/// Add `handles` to the host's list, keeping every row it holds and writing only the ones it
/// lacks. Refused, with nothing written, when the list would then hold more than
/// [`MAX_ALLOWLIST_ACCOUNTS`].
pub(crate) fn add_to_allowlist(
    ctx: &ReducerContext,
    handles: &[String],
) -> Result<(), &'static str> {
    let listed: Vec<String> = ctx
        .db
        .world_allowlist()
        .iter()
        .map(|row| row.account_subject)
        .collect();
    for account_subject in allowlist_additions(&listed, handles)? {
        ctx.db
            .world_allowlist()
            .insert(WorldAllowlist { account_subject });
    }
    Ok(())
}

/// When the host's list holds the handle `old`, put `new` in its place: `old` goes, and `new`
/// is added unless the list already holds it. A list that does not hold `old` is not written.
/// The list never grows by this.
pub(crate) fn replace_on_allowlist(ctx: &ReducerContext, old: &str, new: &str) {
    if !on_allowlist(ctx, old) {
        return;
    }
    ctx.db
        .world_allowlist()
        .account_subject()
        .delete(old.to_string());
    if !on_allowlist(ctx, new) {
        ctx.db.world_allowlist().insert(WorldAllowlist {
            account_subject: new.to_string(),
        });
    }
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

/// Whether a build of `profile` holds nothing an unbind or a drop could erase: it neither
/// binds nor checks an account.
fn keeps_no_account(profile: &BuildProfile) -> bool {
    binds_nothing(profile) && profile.world_check_url.is_none()
}

/// Whether `who` holds a `world_account` row or a binding.
fn holds_an_account(ctx: &ReducerContext, who: Identity) -> bool {
    crate::account_checks::account_of(ctx, who).is_some()
        || ctx.db.world_binding().identity().find(who).is_some()
}

/// Erase what the world holds about `who`'s account: the `world_account` row with its armed
/// re-check, and the binding with the bind nonce `who` holds, expired or not. When a
/// `world_account` row went, `who`'s admission row goes with it, under every rule: while the
/// row existed `Allowlist` governed `who` by its handle alone and left the admission row
/// unread, so keeping it would let in an identity whose handle the owner removed. What an
/// unbind and the owner's drop share.
fn forget_account(ctx: &ReducerContext, who: Identity) {
    if crate::account_checks::erase_world_account(ctx, who) {
        crate::access::withdraw_admission(ctx, who);
    }
    if ctx.db.world_binding().identity().find(who).is_some() {
        ctx.db.world_binding().identity().delete(who);
    }
    if ctx.db.world_bind_nonce().identity().find(who).is_some() {
        ctx.db.world_bind_nonce().identity().delete(who);
    }
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
/// world; no outstanding nonce for `who` (none, or one that has expired); and a nonce that is
/// not `who`'s. Otherwise `who`'s binding becomes what the attestation says, replacing one it
/// already holds, and its nonce is spent. The host's list is not written.
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
/// not admitted cannot connect, so under `Allowlist` the owner asks for it and reads the
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

/// Erase what the world holds about the caller's own account ([`forget_account`]). A caller
/// with neither a `world_account` row nor a binding gets `Ok` with no write, a nonce it holds
/// kept. A build that neither binds nor checks an account refuses first.
///
/// The one client-callable reducer the access rule does not gate, so an identity the rule
/// refuses (one whose handle the owner took off the list included) can still erase its link,
/// over a connection the connect reducer let in. A caller whose account is pending deletion is
/// refused by the deletion gate.
///
/// Once its `world_account` row is gone, the identity gets back into a world that is not
/// `Open` only by the owner: the door, the admission list of `access::set_world_access`, a
/// relayed check, or a change of rule from `Open` while it is connected.
#[spacetimedb::reducer]
pub fn unbind_world_account(ctx: &ReducerContext) -> Result<(), String> {
    if keeps_no_account(&BUILD_PROFILE) {
        return reject(
            "unbind_world_account",
            ctx.sender(),
            REJECT_BUILD_BINDS_NOTHING,
        );
    }
    let who = ctx.sender();
    if !holds_an_account(ctx, who) {
        return Ok(());
    }
    crate::guards::require_not_deleting(ctx, "unbind_world_account")?;
    forget_account(ctx, who);
    Ok(())
}

/// Erase what the world holds about `identity`'s account, by the world's owner: what
/// [`unbind_world_account`] erases for its caller. Refused with no write, in this order: a build
/// that neither binds nor checks an account; a caller that is not the owner; an `identity`
/// whose account is pending deletion (the cascade erases its rows, and reads the handle to take
/// off the list from them); an `identity` with neither row ([`REJECT_NO_BINDING`]). The host's
/// list is not written: the handle stays listed until the owner's [`set_world_allowlist`]
/// leaves it out. Under `Open` the dropped identity can check in again at once. Under the other
/// rules an identity whose `world_account` row went is refused, its admission row gone, until
/// the owner admits it or relays a check.
#[spacetimedb::reducer]
pub fn drop_world_binding(ctx: &ReducerContext, identity: Identity) -> Result<(), String> {
    if keeps_no_account(&BUILD_PROFILE) {
        return reject(
            "drop_world_binding",
            ctx.sender(),
            REJECT_BUILD_BINDS_NOTHING,
        );
    }
    crate::access::require_world_owner(ctx, "drop_world_binding")?;
    crate::guards::require_subject_not_deleting(ctx, identity)?;
    if !holds_an_account(ctx, identity) {
        return reject("drop_world_binding", ctx.sender(), REJECT_NO_BINDING);
    }
    forget_account(ctx, identity);
    Ok(())
}

/// Replace the names this world answers to. Owner-only. Refused with no write: more than
/// [`MAX_WORLD_NAMES`], an entry that is not 1 to [`WORLD_NAME_MAX_BYTES`] visible ASCII
/// characters, a repeated entry. An empty list leaves the world with no name, and a world with
/// no name accepts no binding and checks no account. A call that stores another set of names
/// than the world held has the host's own account check ask at its next tick
/// (`account_checks::names_changed`); the same names in another order are no change.
#[spacetimedb::reducer]
pub fn set_world_names(ctx: &ReducerContext, names: Vec<String>) -> Result<(), String> {
    crate::access::require_world_owner(ctx, "set_world_names")?;
    if let Err(reason) = check_entries(&names, &WORLD_NAMES_RULE) {
        return reject("set_world_names", ctx.sender(), reason);
    }
    let stored: BTreeSet<String> = ctx.db.world_name().iter().map(|row| row.name).collect();
    let changed = stored != names.iter().cloned().collect::<BTreeSet<String>>();
    for name in stored {
        ctx.db.world_name().name().delete(name);
    }
    for name in names {
        ctx.db.world_name().insert(WorldName { name });
    }
    if changed {
        crate::account_checks::names_changed(ctx);
    }
    Ok(())
}

/// Replace the handles the `Allowlist` rule lets in. Owner-only. Refused with no write: more
/// than [`MAX_ALLOWLIST_ACCOUNTS`], an entry that is not 1 to
/// `account_checks::HANDLE_MAX_BYTES` visible ASCII characters, a repeated entry. While the
/// rule in force is `Allowlist` and the owner's identity holds a `world_account` row, its
/// handle is stored whether or not the call names it, and a call that names
/// [`MAX_ALLOWLIST_ACCOUNTS`] other handles is refused; otherwise the set is stored as named.
/// An identity whose handle leaves the list is refused at its next check.
#[spacetimedb::reducer]
pub fn set_world_allowlist(ctx: &ReducerContext, accounts: Vec<String>) -> Result<(), String> {
    crate::access::require_world_owner(ctx, "set_world_allowlist")?;
    if let Err(reason) = check_entries(&accounts, &ALLOWLIST_RULE) {
        return reject("set_world_allowlist", ctx.sender(), reason);
    }
    let mut accounts = accounts;
    if crate::access::rule_in_force(ctx) == WorldAccessRule::Allowlist {
        if let Some(own) = crate::account_checks::account_of(ctx, ctx.sender()) {
            match allowlist_additions(&accounts, &[own.handle]) {
                Ok(kept) => accounts.extend(kept),
                Err(reason) => return reject("set_world_allowlist", ctx.sender(), reason),
            }
        }
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
