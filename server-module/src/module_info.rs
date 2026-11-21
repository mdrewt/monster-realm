//! `module_info` — server-module domain submodule.
//!
//! The module's protocol numbers, published in the single `module_info` row so a client can
//! tell whether it can speak to this server. The numbers are `game-core`'s `PROTOCOL_VERSION`
//! and `MIN_CLIENT_PROTOCOL`. `init` and the owner's `sync_content` call
//! [`ensure_module_info`], so the row follows the module that was last published and synced.

use crate::schema::{module_info, ModuleInfo};
use game_core::{MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION};
use spacetimedb::{ReducerContext, Table};

/// Brings row 0 of `module_info` in line with this build's protocol numbers: inserts the row
/// when it is missing, updates it in place when either number differs, and writes nothing when
/// it is already current (an unchanged update would still reach every subscriber).
pub(crate) fn ensure_module_info(ctx: &ReducerContext) {
    let current = ModuleInfo {
        id: 0,
        protocol: PROTOCOL_VERSION,
        min_client_protocol: MIN_CLIENT_PROTOCOL,
    };
    match ctx.db.module_info().id().find(current.id) {
        Some(row)
            if row.protocol == current.protocol
                && row.min_client_protocol == current.min_client_protocol => {}
        Some(_) => {
            ctx.db.module_info().id().update(current);
        }
        None => {
            ctx.db.module_info().insert(current);
        }
    }
}

#[cfg(test)]
#[path = "module_info_tests.rs"]
mod module_info_tests;
