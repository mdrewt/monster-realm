//! `module_info` tests: `ensure_module_info` records the module's protocol numbers.
//!
//! Declared from `server-module/src/module_info.rs` as
//! `#[cfg(test)] #[path = "module_info_tests.rs"] mod module_info_tests;`,
//! so `super::` is `crate::module_info`.
//!
//! The helper runs straight through the native host with `fx.ctx()`, with ONLY the
//! `module_info` table registered. The expected numbers are game-core's constants; the
//! "other" numbers are derived from them so they can never coincide.

use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::schema::{module_info, ModuleInfo};
use game_core::{MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION};

fn table(fx: &Fixture) -> Handle<'_, ModuleInfo, u32> {
    fx.table_keyed::<ModuleInfo, u32>("module_info", "id", |r| r.id)
        .writable()
        .unique()
}

/// Every stored row as `(id, protocol, min_client_protocol)`, sorted.
fn numbers(rows: &Handle<'_, ModuleInfo, u32>) -> Vec<(u32, u32, u32)> {
    let mut v: Vec<(u32, u32, u32)> = rows
        .rows()
        .iter()
        .map(|r| (r.id, r.protocol, r.min_client_protocol))
        .collect();
    v.sort_unstable();
    v
}

fn the_modules_numbers() -> Vec<(u32, u32, u32)> {
    vec![(0, PROTOCOL_VERSION, MIN_CLIENT_PROTOCOL)]
}

fn bytes(row: &ModuleInfo) -> Vec<u8> {
    spacetimedb::sats::bsatn::to_vec(row).expect("rows encode")
}

/// kills: no insert on a missing row; the numbers swapped or hard-coded; a row at
/// another id; a second write.
#[test]
fn ensure_module_info_inserts_the_modules_numbers_when_the_row_is_missing() {
    let fx = fixture();
    let rows = table(&fx);
    assert_eq!(numbers(&rows), vec![], "precondition: an empty table");
    super::ensure_module_info(&fx.ctx());
    assert_eq!(
        numbers(&rows),
        the_modules_numbers(),
        "exactly one row holding the module's numbers"
    );
    assert_eq!(fx.writes_to("module_info"), 1, "one insert");
}

/// Three starts, each in a fresh host: both numbers differ, only `protocol` differs,
/// only `min_client_protocol` differs. Each ends with one row holding the module's
/// numbers after ONE write (an update in place, not a delete and an insert).
/// kills: a comparison on one column only; an insert that fails over an existing key;
/// a delete-then-insert restore; a restore that keeps either stale column.
#[test]
fn ensure_module_info_overwrites_a_row_holding_other_numbers() {
    let starts = [
        (
            "both numbers differ",
            PROTOCOL_VERSION.wrapping_add(7),
            MIN_CLIENT_PROTOCOL.wrapping_add(3),
        ),
        (
            "only protocol differs",
            PROTOCOL_VERSION.wrapping_add(7),
            MIN_CLIENT_PROTOCOL,
        ),
        (
            "only min_client_protocol differs",
            PROTOCOL_VERSION,
            MIN_CLIENT_PROTOCOL.wrapping_add(3),
        ),
    ];
    for (case, protocol, min_client_protocol) in starts {
        let fx = fixture();
        let rows = table(&fx);
        rows.seed(&ModuleInfo {
            id: 0,
            protocol,
            min_client_protocol,
        });
        assert_ne!(
            numbers(&rows),
            the_modules_numbers(),
            "precondition ({case}): the row holds other numbers"
        );
        super::ensure_module_info(&fx.ctx());
        assert_eq!(
            numbers(&rows),
            the_modules_numbers(),
            "{case}: exactly one row holding the module's numbers"
        );
        assert_eq!(
            fx.writes_to("module_info"),
            1,
            "{case}: one update in place"
        );
    }
}

/// A row already holding the module's numbers: no write, the bytes unchanged, and the
/// helper did read the table (so the zero is not an unregistered or unread table).
/// kills: an unconditional update (a byte-identical write still notifies every
/// subscriber); a delete-then-insert.
#[test]
fn ensure_module_info_writes_nothing_when_the_row_is_current() {
    let fx = fixture();
    let rows = table(&fx);
    let current = ModuleInfo {
        id: 0,
        protocol: PROTOCOL_VERSION,
        min_client_protocol: MIN_CLIENT_PROTOCOL,
    };
    rows.seed(&current);
    let ctx = fx.ctx();
    let visible = ctx.db.module_info().id().find(0);
    assert_eq!(
        visible.as_ref().map(bytes),
        Some(bytes(&current)),
        "precondition: the seeded row is visible through the id index"
    );
    fx.reset_writes();
    fx.reset_reads();
    super::ensure_module_info(&ctx);
    assert_eq!(fx.writes_to("module_info"), 0, "no write when current");
    assert!(
        fx.rows_read("module_info") >= 1,
        "the helper read module_info (asked {:?})",
        fx.requested_indexes()
    );
    let stored: Vec<Vec<u8>> = rows.rows().iter().map(bytes).collect();
    assert_eq!(stored, vec![bytes(&current)], "the row is unchanged");
}
