//! `inventory_tests` the REKEY exists-predicate
//! `inventory::has_items`.
//!
//! Declared from `inventory.rs` as a cfg(test) `#[path = "inventory_tests.rs"]
//! mod inventory_tests;` so `super` resolves to the `inventory` module (this
//! file uses absolute `crate::` paths throughout, so nothing here depends on
//! that resolution).
//!
//! The test below runs the shipped predicate against the in-memory host
//! (`native_host_tests`) and pins its answer to the rows that actually exist,
//! which no source scan can do. Rows are seeded and removed through the
//! fixture handle, never through a database write path.

use crate::native_host_tests::fixture;
use crate::schema::Inventory;
use spacetimedb::Identity;

/// `inventory::has_items` must answer from the CURRENT rows of
/// `inventory`, for the ASKED owner — false with no row, false while only a
/// stranger owns one, true once the owner owns one, false again once the
/// owner's row is gone (while the stranger's row survives). The paired
/// `accounts::account_has_game_data` assertions pin the `inventory` disjunct of
/// the six-way `||` chain that decides whether a guest holds game data.
///
/// kills:
///   - `{ let _ = <the inventory read>; false }`:
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

/// EV-inventory-single-stack, as post-state: every item-granting path keeps AT
/// MOST ONE `inventory` row per `(owner, item_id)`. `grant_item` is the single
/// inserter every path funnels through (buy, trade confirm, dialogue GrantItem,
/// quest reward items, and the dev-only grant_bait); it is driven directly here —
/// first grant, merge, zero-qty, a second item, a second owner. The buy path is
/// `economy_tests`
/// `nh_buy_success_spends_wallet_and_grants_one_stack`; the trade path is the
/// one-row-per-pair assertion in `trading_tests`
/// `nh_trade_confirm_swaps_every_asset_and_conserves_every_total`. The dialogue
/// GrantItem and quest reward-item paths carry no shipped content (no GrantItem
/// effect, `reward.items` empty), so they are covered only through `grant_item`.
///
/// kills: a grant that inserts instead of merging (a second row), a merge keyed
/// on item only / owner only (a stranger's stack grows), a zero-qty zombie row.
#[test]
fn nh_every_grant_path_keeps_one_stack_per_owner_and_item() {
    let fx = fixture();
    let me = Identity::from_byte_array([31u8; 32]);
    let stranger = Identity::from_byte_array([32u8; 32]);
    const ITEM: u32 = 900;
    const OTHER: u32 = 901;
    let stacks = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable()
        .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
    let _by_id = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    let table = || {
        let mut v: Vec<(Identity, u32, u32)> = stacks
            .rows()
            .iter()
            .map(|r| (r.owner_identity, r.item_id, r.count))
            .collect();
        v.sort_unstable();
        v
    };

    let ctx = fx.ctx();
    crate::inventory::grant_item(&ctx, me, ITEM, 2);
    crate::inventory::grant_item(&ctx, me, ITEM, 3);
    crate::inventory::grant_item(&ctx, me, ITEM, 0);
    crate::inventory::grant_item(&ctx, me, OTHER, 1);
    crate::inventory::grant_item(&ctx, stranger, ITEM, 4);
    assert_eq!(
        table(),
        {
            let mut want = vec![(me, ITEM, 5), (me, OTHER, 1), (stranger, ITEM, 4)];
            want.sort_unstable();
            want
        },
        "grant_item: merged per (owner, item), zero-qty writes nothing"
    );
}

/// BUG-inventory-world-readable: `inventory` is a PRIVATE table and clients read it ONLY
/// through the SHIPPED `my_inventory` view, run here through the runtime's own view entry
/// point. Each sender sees exactly their own stacks (all of them — it is a multi-row view);
/// a stranger sees none of the owner's, and a stranger with stacks sees only theirs.
///
/// kills: a whole-table view, a view keyed on anything but `ctx.sender()`, a view that
/// returns only the first row (`find` instead of `filter`), an empty view.
#[test]
fn nh_my_inventory_view_returns_only_the_senders_rows() {
    use crate::native_host_tests::VIEW_MY_INVENTORY;
    let fx = fixture();
    let t = fx.table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity);
    let owner = Identity::from_byte_array([21u8; 32]);
    let stranger = Identity::from_byte_array([22u8; 32]);
    let stack = |inv_id: u64, owner_identity: Identity, item_id: u32, count: u32| Inventory {
        inv_id,
        owner_identity,
        item_id,
        count,
    };
    let seen = |who: Identity| {
        let mut rows: Vec<(u64, Identity, u32, u32)> = fx
            .call_view::<Inventory>(VIEW_MY_INVENTORY, who)
            .into_iter()
            .map(|r| (r.inv_id, r.owner_identity, r.item_id, r.count))
            .collect();
        rows.sort_unstable();
        rows
    };

    t.seed(&stack(1, owner, 4, 3));
    t.seed(&stack(2, owner, 5, 9));
    assert_eq!(
        seen(owner),
        vec![(1, owner, 4, 3), (2, owner, 5, 9)],
        "the owner sees every one of their own stacks"
    );
    assert!(
        seen(stranger).is_empty(),
        "a stranger with no stacks sees none of the owner's counts"
    );

    t.seed(&stack(3, stranger, 4, 1));
    assert_eq!(
        seen(stranger),
        vec![(3, stranger, 4, 1)],
        "a stranger with a stack sees only their own, never the owner's"
    );
    assert_eq!(
        seen(owner),
        vec![(1, owner, 4, 3), (2, owner, 5, 9)],
        "the owner's view is unchanged by a stranger's row"
    );
}

/// `grant_item` onto a stack that is already AT or OVER the cap is a complete
/// no-op: it neither shrinks the stack nor touches the datastore at all.
///
/// The `inventory` table is deliberately NOT marked `writable`, and in this host
/// an insert or update on a non-writable table aborts the test process. So the
/// only way this test finishes is if `grant_item` issued no write whatsoever for
/// the full stack (count == cap) and the over-cap stack (count > cap). The control
/// `grant_item_onto_a_stack_one_below_cap_clamps_to_cap` proves the cap boundary
/// is exact.
///
/// kills: the existing-stack guard `count < MAX_ITEM_STACK` loosened to `<=`
/// (a redundant identical-row update at exactly the cap, which the host aborts).
#[test]
fn grant_item_onto_an_at_or_over_cap_stack_performs_no_write() {
    use game_core::MAX_ITEM_STACK;
    let fx = fixture();
    let me = Identity::from_byte_array([41u8; 32]);
    const FULL: u32 = 910;
    const OVER: u32 = 911;
    let stacks = fx.table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity);
    let stack = |inv_id: u64, item_id: u32, count: u32| Inventory {
        inv_id,
        owner_identity: me,
        item_id,
        count,
    };
    stacks.seed(&stack(1, FULL, MAX_ITEM_STACK));
    stacks.seed(&stack(2, OVER, MAX_ITEM_STACK + 7));

    let ctx = fx.ctx();
    crate::inventory::grant_item(&ctx, me, FULL, 1);
    crate::inventory::grant_item(&ctx, me, OVER, 5);

    let mut counts: Vec<(u32, u32)> = stacks.rows().iter().map(|r| (r.item_id, r.count)).collect();
    counts.sort_unstable();
    assert_eq!(
        counts,
        vec![(FULL, MAX_ITEM_STACK), (OVER, MAX_ITEM_STACK + 7)],
        "a full / over-cap stack is neither grown nor shrunk"
    );
}

/// Control for the test above: a stack one below the cap DOES take a write and
/// clamps at the cap, so the no-write result above is the cap boundary and not a
/// `grant_item` that never writes an existing stack.
#[test]
fn grant_item_onto_a_stack_one_below_cap_clamps_to_cap() {
    use game_core::MAX_ITEM_STACK;
    let fx = fixture();
    let me = Identity::from_byte_array([42u8; 32]);
    const ITEM: u32 = 912;
    let stacks = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable();
    let _by_id = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    stacks.seed(&Inventory {
        inv_id: 1,
        owner_identity: me,
        item_id: ITEM,
        count: MAX_ITEM_STACK - 1,
    });
    crate::inventory::grant_item(&fx.ctx(), me, ITEM, 5);
    let counts: Vec<u32> = stacks.rows().iter().map(|r| r.count).collect();
    assert_eq!(counts, vec![MAX_ITEM_STACK]);
}

// ===========================================================================
// consume_n — the one item debit `sell`, `heal_party` and `apply_swap` share.
// Every call runs on the native host with the `inventory` table writable under
// both indexes the debit reads and writes through (`owner_identity` to find the
// stack, `inv_id` to update or delete it). `writes_to("inventory")` counts the
// insert / update / delete syscalls, which is what a subscriber is told about.
// ===========================================================================

/// The `consume_n` refusal for a stack holding fewer units than asked.
const NOT_ENOUGH_ITEM: &str = "not enough of that item";

/// The `inventory` table, writable, read by owner and written by `inv_id`.
fn cn_stacks(
    fx: &crate::native_host_tests::Fixture,
) -> crate::native_host_tests::Handle<'_, Inventory> {
    let stacks = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable()
        .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
    let _by_id = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    stacks
}

/// Every stack as `(inv_id, owner, item_id, count)`, sorted.
fn cn_rows(
    stacks: &crate::native_host_tests::Handle<'_, Inventory>,
) -> Vec<(u64, Identity, u32, u32)> {
    let mut rows: Vec<(u64, Identity, u32, u32)> = stacks
        .rows()
        .iter()
        .map(|r| (r.inv_id, r.owner_identity, r.item_id, r.count))
        .collect();
    rows.sort_unstable();
    rows
}

fn cn_stack(inv_id: u64, owner_identity: Identity, item_id: u32, count: u32) -> Inventory {
    Inventory {
        inv_id,
        owner_identity,
        item_id,
        count,
    }
}

/// `consume_n` removes exactly `qty` from the owner's stack, in place (same
/// `inv_id`); `qty` equal to the count deletes the row; more than the count is
/// refused with exactly `"not enough of that item"` and the row byte-identical,
/// with no write at all — also for `u32::MAX`, which a wrapping or saturating
/// subtraction would turn into a windfall or an empty stack.
///
/// kills:
///   - a per-unit loop of `consume_one` behind the new name: the shortfall drains
///     the stack and deletes it before refusing (the row is gone, writes > 0).
///   - `saturating_sub` for `checked_sub`: the shortfall empties the stack.
///   - `wrapping_sub`: the shortfall leaves a 2^32-ish count.
///   - delete-at-zero dropped: the drained row stays at count 0.
///   - `<=` for `<` in the shortfall test: taking exactly the count is refused.
///   - a debit that ignores `qty` (always 1): 10 - 3 reads 9.
///   - a shortfall reported with another text (`"item count is zero"`,
///     `"item not in inventory"`).
#[test]
fn consume_n_removes_the_quantity_deletes_a_drained_stack_and_rejects_a_shortfall_unchanged() {
    let fx = fixture();
    let stacks = cn_stacks(&fx);
    let me = Identity::from_byte_array([51u8; 32]);
    const ITEM: u32 = 920;
    stacks.seed(&cn_stack(1, me, ITEM, 10));
    let ctx = fx.ctx();

    assert_eq!(crate::inventory::consume_n(&ctx, me, ITEM, 3), Ok(()));
    assert_eq!(
        cn_rows(&stacks),
        vec![(1, me, ITEM, 7)],
        "exactly 3 of 10 removed, the same row updated in place"
    );

    for qty in [8, 100, u32::MAX] {
        let before = cn_rows(&stacks);
        fx.reset_writes();
        assert_eq!(
            crate::inventory::consume_n(&ctx, me, ITEM, qty),
            Err(NOT_ENOUGH_ITEM.to_string()),
            "{qty} of a stack of 7 is a shortfall"
        );
        assert_eq!(
            cn_rows(&stacks),
            before,
            "a refused {qty} leaves the stack exactly as it was"
        );
        assert_eq!(
            fx.writes_to("inventory"),
            0,
            "a refused {qty} makes no inventory write at all"
        );
    }

    assert_eq!(
        crate::inventory::consume_n(&ctx, me, ITEM, 7),
        Ok(()),
        "exactly the whole stack may be taken"
    );
    assert_eq!(
        cn_rows(&stacks),
        vec![],
        "a stack drained to 0 is deleted, never left as an empty row"
    );
}

/// A successful `consume_n` makes exactly ONE `inventory` write whatever `qty`
/// is (one update, or one delete for a drained stack), `qty == 0` makes none,
/// and only the asked `(owner, item)` stack moves: a stranger's stack of the
/// same item and the owner's stack of another item are byte-identical.
///
/// kills:
///   - a loop of single-unit debits (qty writes for qty units).
///   - a debit that updates the row and then deletes it at zero (two writes).
///   - a `qty == 0` call that rewrites the row unchanged (one write a
///     subscriber would see).
///   - a lookup keyed on the item alone (the stranger's stack moves) or on the
///     owner alone (the owner's other stack moves).
#[test]
fn consume_n_writes_the_stack_once_whatever_the_quantity() {
    let fx = fixture();
    let stacks = cn_stacks(&fx);
    let me = Identity::from_byte_array([52u8; 32]);
    let stranger = Identity::from_byte_array([53u8; 32]);
    const ITEM: u32 = 921;
    const OTHER: u32 = 922;
    stacks.seed(&cn_stack(1, me, ITEM, 50));
    stacks.seed(&cn_stack(2, me, OTHER, 4));
    stacks.seed(&cn_stack(3, stranger, ITEM, 20));
    let ctx = fx.ctx();

    let mut held = 50;
    for qty in [1, 3, 17] {
        fx.reset_writes();
        assert_eq!(crate::inventory::consume_n(&ctx, me, ITEM, qty), Ok(()));
        held -= qty;
        assert_eq!(
            fx.writes_to("inventory"),
            1,
            "taking {qty} units is one inventory write, not one per unit"
        );
        assert_eq!(
            cn_rows(&stacks),
            vec![
                (1, me, ITEM, held),
                (2, me, OTHER, 4),
                (3, stranger, ITEM, 20)
            ],
            "after taking {qty}: only the owner's stack of the item moved"
        );
    }

    fx.reset_writes();
    assert_eq!(crate::inventory::consume_n(&ctx, me, ITEM, held), Ok(()));
    assert_eq!(
        fx.writes_to("inventory"),
        1,
        "draining the stack ({held} units) is one write: the delete"
    );
    assert_eq!(
        cn_rows(&stacks),
        vec![(2, me, OTHER, 4), (3, stranger, ITEM, 20)],
        "the drained stack is gone; the other two are untouched"
    );

    fx.reset_writes();
    assert_eq!(
        crate::inventory::consume_n(&ctx, me, OTHER, 0),
        Ok(()),
        "taking nothing is accepted"
    );
    assert_eq!(
        fx.writes_to("inventory"),
        0,
        "taking nothing writes nothing"
    );
    assert_eq!(
        cn_rows(&stacks),
        vec![(2, me, OTHER, 4), (3, stranger, ITEM, 20)],
        "taking nothing changes no stack"
    );
}

/// The two refusals that are not a shortfall. A row left at `count == 0` is
/// deleted and the call refused with exactly `"item count is zero"` — through
/// `consume_one` and through `consume_n` with more than one unit asked (the zero
/// check comes before the shortfall check). An owner with no stack at all is
/// refused with exactly `"item not in inventory"` and no row is created. A
/// `consume_one` on a real stack still takes exactly one unit.
///
/// kills:
///   - the zero-count cleanup dropped: the empty row survives the refusal.
///   - the shortfall check placed before the zero check in `consume_n`: a zero
///     row asked for 5 answers `"not enough of that item"` and keeps the row.
///   - `consume_one` not taking exactly one: 4 does not become 3, 1 does not
///     delete the row.
///   - a missing stack answered with another text, or an empty row inserted.
#[test]
fn consume_one_deletes_an_empty_stack_row_and_refuses() {
    let fx = fixture();
    let stacks = cn_stacks(&fx);
    let me = Identity::from_byte_array([54u8; 32]);
    let stranger = Identity::from_byte_array([55u8; 32]);
    const ZOMBIE: u32 = 923;
    const ABSENT: u32 = 924;
    const REAL: u32 = 925;
    stacks.seed(&cn_stack(9, stranger, ZOMBIE, 6));
    let ctx = fx.ctx();

    stacks.seed(&cn_stack(1, me, ZOMBIE, 0));
    assert_eq!(
        crate::inventory::consume_one(&ctx, me, ZOMBIE),
        Err("item count is zero".to_string())
    );
    assert_eq!(
        cn_rows(&stacks),
        vec![(9, stranger, ZOMBIE, 6)],
        "consume_one deletes the caller's empty row and nothing else"
    );

    stacks.seed(&cn_stack(2, me, ZOMBIE, 0));
    assert_eq!(
        crate::inventory::consume_n(&ctx, me, ZOMBIE, 5),
        Err("item count is zero".to_string()),
        "a zero row is reported as empty before any shortfall"
    );
    assert_eq!(
        cn_rows(&stacks),
        vec![(9, stranger, ZOMBIE, 6)],
        "consume_n deletes the caller's empty row and nothing else"
    );

    fx.reset_writes();
    assert_eq!(
        crate::inventory::consume_one(&ctx, me, ABSENT),
        Err("item not in inventory".to_string())
    );
    assert_eq!(
        crate::inventory::consume_n(&ctx, me, ABSENT, 3),
        Err("item not in inventory".to_string())
    );
    assert_eq!(
        crate::inventory::consume_n(&ctx, me, ZOMBIE, 1),
        Err("item not in inventory".to_string()),
        "a stranger's stack of the item is not the caller's"
    );
    assert_eq!(
        fx.writes_to("inventory"),
        0,
        "a missing stack writes nothing"
    );
    assert_eq!(
        cn_rows(&stacks),
        vec![(9, stranger, ZOMBIE, 6)],
        "no row is created for a missing stack"
    );

    stacks.seed(&cn_stack(3, me, REAL, 4));
    assert_eq!(crate::inventory::consume_one(&ctx, me, REAL), Ok(()));
    assert_eq!(
        cn_rows(&stacks),
        vec![(3, me, REAL, 3), (9, stranger, ZOMBIE, 6)],
        "consume_one takes exactly one"
    );
    stacks.remove(me);
    stacks.seed(&cn_stack(4, me, REAL, 1));
    assert_eq!(crate::inventory::consume_one(&ctx, me, REAL), Ok(()));
    assert_eq!(
        cn_rows(&stacks),
        vec![(9, stranger, ZOMBIE, 6)],
        "consume_one of the last unit deletes the row"
    );
}

/// `item_count` answers the RAW count of the asked owner's stack of the asked
/// item: 0 with no stack, the count otherwise, never a stranger's stack or the
/// owner's stack of another item.
///
/// kills: a constant answer; a lookup keyed on the item alone or the owner
/// alone; a missing stack answered with anything but 0.
#[test]
fn item_count_reads_the_owners_raw_stack() {
    let fx = fixture();
    let stacks = cn_stacks(&fx);
    let me = Identity::from_byte_array([56u8; 32]);
    let stranger = Identity::from_byte_array([57u8; 32]);
    const ITEM: u32 = 926;
    const OTHER: u32 = 927;
    let ctx = fx.ctx();
    assert_eq!(crate::inventory::item_count(&ctx, me, ITEM), 0, "no stack");
    stacks.seed(&cn_stack(1, stranger, ITEM, 40));
    stacks.seed(&cn_stack(2, me, OTHER, 9));
    assert_eq!(
        crate::inventory::item_count(&ctx, me, ITEM),
        0,
        "neither a stranger's stack nor another item counts"
    );
    stacks.seed(&cn_stack(3, me, ITEM, 7));
    assert_eq!(crate::inventory::item_count(&ctx, me, ITEM), 7);
    assert_eq!(crate::inventory::item_count(&ctx, me, OTHER), 9);
    assert_eq!(crate::inventory::item_count(&ctx, stranger, ITEM), 40);
}
