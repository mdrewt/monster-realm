//! `world_binding` — server-module domain submodule. lpw-15 SKELETON: every rule is a stub.

use crate::accounts::{AttestationKey, BuildProfile, BUILD_PROFILE};
use crate::schema::WorldBinding;
use spacetimedb::{Identity, ReducerContext};

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

pub(crate) const ATTESTATION_MAX_BYTES: usize = 4096;
pub(crate) const BIND_NONCE_TTL_MS: i64 = 5 * 60 * 1000;
pub(crate) const BIND_NONCE_BYTES: usize = 16;
pub(crate) const BIND_NONCE_SWEEP_MAX: usize = 32;
pub(crate) const WORLD_NAME_MAX_BYTES: usize = 512;
pub(crate) const MAX_WORLD_NAMES: usize = 16;
pub(crate) const ACCOUNT_SUBJECT_MAX_BYTES: usize = 255;
pub(crate) const MAX_ALLOWLIST_ACCOUNTS: usize = 256;

const NOT_BUILT: &str = "lpw-15: not built";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedAttestation {
    pub(crate) key_id: String,
    pub(crate) subject: String,
    pub(crate) audience: String,
    pub(crate) nonce: String,
    pub(crate) expires_at_s: i64,
    pub(crate) entitled: bool,
}

pub(crate) fn verify_attestation(
    _keys: &[AttestationKey],
    _attestation: &str,
) -> Result<VerifiedAttestation, &'static str> {
    Err(NOT_BUILT)
}

pub(crate) fn attestation_expired(_expires_at_s: i64, _now_ms: i64) -> bool {
    false
}

pub(crate) fn bind_nonce_expired(_expires_at_ms: i64, _now_ms: i64) -> bool {
    false
}

pub(crate) fn is_visible_ascii(_text: &str, _max_bytes: usize) -> bool {
    false
}

pub(crate) fn binds_nothing(_profile: &BuildProfile) -> bool {
    false
}

pub(crate) fn trusted_binding(
    _ctx: &ReducerContext,
    _profile: &BuildProfile,
    _identity: Identity,
) -> Option<WorldBinding> {
    None
}

pub(crate) fn bound_entitled(
    _ctx: &ReducerContext,
    _profile: &BuildProfile,
    _identity: Identity,
) -> bool {
    false
}

pub(crate) fn on_allowlist(_ctx: &ReducerContext, _account_subject: &str) -> bool {
    false
}

pub(crate) fn erase_world_binding(_ctx: &ReducerContext, _identity: Identity) {}

pub(crate) fn bind_identity(
    _ctx: &ReducerContext,
    _profile: &BuildProfile,
    _who: Identity,
    _attestation: &str,
    _reducer: &str,
) -> Result<(), String> {
    Err(NOT_BUILT.to_string())
}

#[spacetimedb::reducer]
pub fn request_bind_nonce(_ctx: &ReducerContext) -> Result<(), String> {
    Err(NOT_BUILT.to_string())
}

#[spacetimedb::reducer]
pub fn request_bind_nonce_for(_ctx: &ReducerContext, _who: Identity) -> Result<(), String> {
    Err(NOT_BUILT.to_string())
}

#[spacetimedb::reducer]
pub fn bind_world_account(ctx: &ReducerContext, attestation: String) -> Result<(), String> {
    bind_identity(
        ctx,
        &BUILD_PROFILE,
        ctx.sender(),
        &attestation,
        "bind_world_account",
    )
}

#[spacetimedb::reducer]
pub fn bind_world_account_for(
    ctx: &ReducerContext,
    who: Identity,
    attestation: String,
) -> Result<(), String> {
    bind_identity(
        ctx,
        &BUILD_PROFILE,
        who,
        &attestation,
        "bind_world_account_for",
    )
}

#[spacetimedb::reducer]
pub fn set_world_names(_ctx: &ReducerContext, _names: Vec<String>) -> Result<(), String> {
    Err(NOT_BUILT.to_string())
}

#[spacetimedb::reducer]
pub fn set_world_allowlist(_ctx: &ReducerContext, _accounts: Vec<String>) -> Result<(), String> {
    Err(NOT_BUILT.to_string())
}

#[cfg(test)]
#[path = "world_binding_tests.rs"]
mod world_binding_tests;
