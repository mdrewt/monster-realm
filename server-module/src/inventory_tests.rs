//! `inventory_tests` — rb-41 gating test for the REKEY exists-predicate
//! `inventory::has_items`, authored from the EARS criterion R-rb-25-X9 (the
//! ADR-0222 known-limit 2 residual, closed by the ADR-0224 migration to a
//! native host).
//!
//! Declared from `inventory.rs` as a cfg(test) `#[path = "inventory_tests.rs"]
//! mod inventory_tests;` (the attribute is not spelled here on purpose — see
//! native_host_tests.rs on the monster-privacy `[SCOPE]` raw-text branch)
//! so `super` resolves to the `inventory` module (this file uses absolute
//! `crate::` paths throughout, so nothing here depends on that resolution).
//!
//! WHY IT EXISTS. ADR-0222's guest-claim-integrity gate could only READ the
//! predicate's source, so a HOLLOWED body — one that still performs the table
//! read but returns a value decoupled from it — passed every check. The test
//! below runs the shipped predicate against the in-memory host
//! (`native_host_tests`, ADR-0224) and pins its answer to the rows that
//! actually exist, which no source scan can do. Rows are seeded and removed
//! through the fixture handle, never through a database write path.

use crate::native_host_tests::fixture;
use crate::schema::Inventory;
use spacetimedb::Identity;

/// EARS R-rb-25-X9: `inventory::has_items` must answer from the CURRENT rows of
/// `inventory`, for the ASKED owner — false with no row, false while only a
/// stranger owns one, true once the owner owns one, false again once the
/// owner's row is gone (while the stranger's row survives). The paired
/// `accounts::account_has_game_data` assertions pin the `inventory` disjunct of
/// the six-way `||` chain that decides whether a guest holds game data.
///
/// kills:
///   - the ADR-0222 known-limit hollow, `{ let _ = <the inventory read>; false }`:
///     the owner-row assertion goes red while every source scan stays green.
///   - the inverted hollow, `{ let _ = <the inventory read>; true }`: the
///     empty-table assertion goes red.
///   - a body that answers does-the-table-hold-ANY-row instead of
///     does-THIS-owner-hold-one: the stranger-only assertion goes red, and so
///     does the post-removal assertion (the stranger's row is still there).
///   - a latched or memoised answer that never returns to false once it has
///     seen a row: the post-removal assertion goes red.
///   - deleting the `inventory` disjunct from
///     `accounts::account_has_game_data`: the paired account assertion goes red
///     while the direct predicate assertion stays green.
#[test]
fn rb41_has_items_tracks_real_inventory_rows() {
    let fx = fixture();
    let t = fx.table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity);
    let ctx = fx.ctx();
    let owner = Identity::from_byte_array([17u8; 32]);
    let stranger = Identity::from_byte_array([18u8; 32]);

    assert!(
        !crate::inventory::has_items(&ctx, owner),
        "has_items must be false for an owner holding no stack: the table is empty here, so a \
         true answer means the return value is not derived from the table read"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be false while the owner owns no row in ANY REKEY table: \
         no row of any kind has been seeded yet"
    );

    t.seed(&Inventory {
        inv_id: 7_002,
        owner_identity: stranger,
        item_id: 1,
        count: 0,
    });
    assert!(
        !crate::inventory::has_items(&ctx, owner),
        "has_items must stay false when the ONLY stack belongs to a different owner: the \
         predicate answers per-owner, never table-is-non-empty"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must stay false when the only seeded row belongs to a stranger: \
         a guest claim keys on the CALLER identity, not on global table population"
    );

    t.seed(&Inventory {
        inv_id: 7_001,
        owner_identity: owner,
        item_id: 1,
        count: 0,
    });
    assert!(
        crate::inventory::has_items(&ctx, owner),
        "has_items must report true while the owner holds a stack; a body that reads the table \
         and then returns a constant false (the ADR-0222 known-limit hollow) fails exactly \
         here. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be true through its inventory disjunct while the owner \
         holds a stack and nothing else; a deleted disjunct fails exactly here. Indexes the \
         generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        t.remove(owner),
        1,
        "the owner had exactly one inventory row to remove: a different count means the seeded \
         state was not the state this test reasons about"
    );
    assert!(
        !crate::inventory::has_items(&ctx, owner),
        "has_items must return to false once the owner's last stack is gone: the answer tracks \
         live rows, so it can never latch on a row that no longer exists"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must return to false once the owner's last REKEY-table row is \
         gone: this is the state in which a guest claim is allowed to proceed"
    );
    assert!(
        crate::inventory::has_items(&ctx, stranger),
        "removing the owner's row must leave the stranger's stack untouched: without this the \
         negative above could be explained by an emptied table rather than by owner scoping. \
         Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}
