//! `access` — server-module domain submodule (skeleton: contracts only, no behaviour yet).

use crate::schema::{WorldAccess, WorldAccessRule};
use spacetimedb::{Identity, ReducerContext};

pub(crate) const REJECT_NOT_ADMITTED: &str = "not admitted";
pub(crate) const REJECT_NOT_WORLD_OWNER: &str = "caller is not the world owner";
pub(crate) const REJECT_ADMIT_LOCKED: &str = "too many wrong passwords for this identity";
pub(crate) const REJECT_NO_PASSWORD_RULE: &str = "this world has no password rule";
pub(crate) const REJECT_PASSWORD_LENGTH: &str = "a password is 1 to 128 bytes";
pub(crate) const REJECT_OPEN_TAKES_NO_PASSWORD: &str = "an open world takes no password";
pub(crate) const REJECT_PASSWORD_REQUIRED: &str = "a password world needs a password";
pub(crate) const ADMIT_MAX_WRONG_ATTEMPTS: usize = 5;
pub(crate) const ADMIT_ATTEMPT_WINDOW_MS: i64 = 10 * 60 * 1000;
pub(crate) const PASSWORD_MAX_BYTES: usize = 128;
pub(crate) const PASSWORD_SALT_BYTES: usize = 16;
pub(crate) const PASSWORD_HASH_BYTES: usize = 32;

pub(crate) fn effective_rule(_row: Option<&WorldAccess>) -> WorldAccessRule {
    WorldAccessRule::Open
}

pub(crate) fn recent_wrong_attempts(_wrong_at_ms: &[i64], _now_ms: i64) -> Vec<i64> {
    Vec::new()
}

pub(crate) fn attempts_locked(_wrong_at_ms: &[i64], _now_ms: i64) -> bool {
    false
}

pub(crate) fn hash_password(_salt: &[u8], _password: &str) -> Vec<u8> {
    Vec::new()
}

pub(crate) fn password_matches(_row: &WorldAccess, _password: &str) -> bool {
    false
}

pub(crate) fn is_admitted(_ctx: &ReducerContext, _identity: Identity) -> bool {
    true
}

pub(crate) fn require_admitted(_ctx: &ReducerContext, _reducer: &str) -> Result<(), String> {
    Ok(())
}

pub(crate) fn require_admitted_at_connect(_ctx: &ReducerContext) -> Result<(), String> {
    Ok(())
}

pub(crate) fn erase_admission(_ctx: &ReducerContext, _identity: Identity) {}

#[spacetimedb::reducer]
pub fn set_world_access(
    _ctx: &ReducerContext,
    _rule: WorldAccessRule,
    _password: Option<String>,
    _admit: Vec<Identity>,
) -> Result<(), String> {
    Err("not built".to_string())
}

#[spacetimedb::reducer]
pub fn admit(_ctx: &ReducerContext, _who: Identity, _password: String) -> Result<(), String> {
    Err("not built".to_string())
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod access_tests;
