//! `economy_tests` — behavioural tests for the server-module economy submodule
//! (server-module/src/economy.rs).
//!
//! Declared from `economy.rs` as:
//!   `#[cfg(test)] #[path = "economy_tests.rs"] mod economy_tests;`
//! so `super` resolves to the `economy` module.
//!
//! Everything here runs the SHIPPED helpers and reducers — pure seams directly,
//! ctx-bound code under the in-memory native host (`native_host_tests`). The
//! wallet table's privacy and the no-client-price reducer signatures are the
//! generated-bindings surface (evals/client-surface-privacy.eval.mjs).

use super::*;
use game_core::currency::MAX_BALANCE;

// ===========================================================================
// M21a AUTH-24 / AUTH-23: guest->account wallet re-key credits the
// balance forward via grant_currency, then zeroes the guest row IN PLACE — never
// deletes. Pure seam here; the ctx-bound credit-forward is executed by
// nh_rekey_wallet_credits_forward_and_erase_wallet_deletes_only_the_owner.
//
// economy_tests.rs is exempt from currency-integrity ACCESSOR_BYPASS, so a
// `PlayerWallet { .. }` literal here is legitimate (unlike accounts_tests.rs).
// ===========================================================================

/// `zeroed_wallet` sets `balance == 0` and PRESERVES the PK owner
/// (the guest row survives with a zero balance — never a delete).
///
/// Kills: a mutant that also rewrites `owner_identity`, or that returns the row
/// unchanged (balance not zeroed — the source could re-donate its balance to a
/// second fresh account via a later claim).
#[test]
fn auth24_zeroed_wallet_zeroes_balance_preserves_owner() {
    let owner = Identity::from_byte_array([9u8; 32]);
    let before = PlayerWallet {
        owner_identity: owner,
        balance: 500,
    };
    let after = zeroed_wallet(before);
    assert_eq!(
        after.balance, 0,
        "AUTH-24: the re-keyed guest wallet must be zeroed."
    );
    assert_eq!(
        after.owner_identity, owner,
        "AUTH-24/23: the wallet PK owner must be preserved (the row is zeroed, never deleted)."
    );
}

// ===========================================================================
// the REKEY exists-predicate for the wallet table, exercised
// against REAL rows instead of against its own source text.
//
// The test below runs the shipped predicate against the in-memory host
// (native_host_tests) and pins its answer to the rows that actually exist,
// which no source scan can do.
// ===========================================================================

/// `economy::wallet_exists` must answer from the CURRENT rows
/// of the wallet table, for the ASKED owner — false with no row, false while
/// only a stranger owns one, true once the owner owns one, false again once the
/// owner's row is gone (while the stranger's row survives). The paired
/// `accounts::account_has_game_data` assertions pin this table's disjunct of
/// the six-way `||` chain that decides whether a guest holds game data.
///
/// kills:
///   - `{ let _ = <the wallet read>; false }`:
///     the owner-row assertion goes red while every source scan stays green.
///   - the inverted hollow, `{ let _ = <the wallet read>; true }`: the
///     empty-table assertion goes red.
///   - a body that answers does-the-table-hold-ANY-row instead of
///     does-THIS-owner-hold-one: the stranger-only assertion goes red, and so
///     does the post-removal assertion (the stranger's row is still there).
///   - a latched or memoised answer that never returns to false once it has
///     seen a row: the post-removal assertion goes red.
///   - deleting the wallet disjunct from `accounts::account_has_game_data`:
///     the paired account assertion goes red while the direct predicate
///     assertion stays green, naming the missing disjunct exactly.
#[test]
fn rb41_wallet_exists_tracks_real_wallet_rows() {
    let fx = crate::native_host_tests::fixture();
    let t = fx.table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity);
    let ctx = fx.ctx();
    let owner = Identity::from_byte_array([11u8; 32]);
    let stranger = Identity::from_byte_array([12u8; 32]);

    assert!(
        !crate::economy::wallet_exists(&ctx, owner),
        "wallet_exists must be false for an owner with no wallet row: the table is empty here, \
         so a true answer means the return value is not derived from the table read"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be false while the owner owns no row in ANY REKEY table: \
         no row of any kind has been seeded yet"
    );

    t.seed(&PlayerWallet {
        owner_identity: stranger,
        balance: 0,
    });
    assert!(
        !crate::economy::wallet_exists(&ctx, owner),
        "wallet_exists must stay false when the ONLY wallet row belongs to a different owner: \
         the predicate answers per-owner, never table-is-non-empty"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must stay false when the only seeded row belongs to a stranger: \
         a guest claim keys on the CALLER identity, not on global table population"
    );

    t.seed(&PlayerWallet {
        owner_identity: owner,
        balance: 0,
    });
    assert!(
        crate::economy::wallet_exists(&ctx, owner),
        "wallet_exists must report true while the owner holds a wallet row; a body that reads \
         the table and then returns a constant false (the ADR-0222 known-limit hollow) fails \
         exactly here. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be true through its wallet disjunct while the owner holds a \
         wallet row and nothing else; a deleted disjunct fails exactly here. Indexes the \
         generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        t.remove(owner),
        1,
        "the owner had exactly one wallet row to remove: a different count means the seeded \
         state was not the state this test reasons about"
    );
    assert!(
        !crate::economy::wallet_exists(&ctx, owner),
        "wallet_exists must return to false once the owner's wallet row is gone: the answer \
         tracks live rows, so it can never latch on a row that no longer exists"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must return to false once the owner's last REKEY-table row is \
         gone: this is the state in which a guest claim is allowed to proceed"
    );
    assert!(
        crate::economy::wallet_exists(&ctx, stranger),
        "removing the owner's row must leave the stranger's row untouched: without this the \
         negative above could be explained by an emptied table rather than by owner scoping. \
         Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}

// ===========================================================================
// the caller-only deletion gate on the shop.
//
// WHY THE SHOP IS IN SCOPE AT ALL: selects gate targets
// mechanically from the tables they move, and `player_wallet` + `inventory` are
// both ERASE-policy tables. A mid-grace account trading currency for items — or
// items for currency — is opening exactly the kind of new commitment the grace
// window exists to stop, and every unit of it lands in a table the cascade is
// about to erase.
//
// The SHIPPED reducers run (`native_host_tests`)
// against real `account` and `player` rows, through a five-state progression
// with a mid-grace STRANGER row present throughout: POLARITY (the gate refuses
// the two deleting states), REACHABILITY (it ADMITS the other three) and
// CALLER-KEYING (the stranger never refuses anybody).
// ===========================================================================

/// Seed the one `player` row every shop reducer's joined check needs.
///
/// The handle is registered against the SAME fixture the caller's account handle
/// comes from — rows live in the host store, not in the handle, so seeding
/// through a locally-scoped handle is exactly equivalent to seeding through one
/// the test holds. The row is a plain struct literal, which is the house pattern
/// for `Player`: unlike `Account` it has no pure constructor to route through and
/// carries no legal-state invariant to violate.
fn rb46_seed_player(fx: &crate::native_host_tests::Fixture, me: Identity) {
    let players = fx.table::<crate::schema::Player>("player", "identity", |r| r.identity);
    players.seed(&crate::schema::Player {
        identity: me,
        entity_id: 7,
        name: String::new(),
        online: true,
        last_input_seq: 0,
    });
}

/// A mid-grace account row for somebody who is NOT the caller.
///
/// Seeded once per behavioural test and never removed, so the account table is
/// never empty of deleting rows. Without it a TABLE-keyed gate — refuse if
/// ANYBODY is deleting — is observationally identical to the caller-keyed one in
/// all five states, because the fixture would only ever hold the sender's row.
/// `remove` and `find` are `Identity`-keyed, so this row never disturbs the
/// per-state `remove(me) == 1` assertions.
fn rb46_seed_deleting_stranger(
    acct: &crate::native_host_tests::Handle<'_, crate::schema::Account>,
) {
    let stranger = Identity::from_byte_array([9u8; 32]);
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));
}

/// `buy` refuses a deletion-gated caller, ADMITS everybody else, and answers from
/// the CALLER's row.
///
/// The shipped reducer runs through five account
/// states, with the exact verdict pinned in each: no row, `Active`,
/// `PendingDeletion`, `PendingDeletion` + the terminal marker, and row removed.
/// The three admitted states are the positive control, and they are what make the
/// two refused states mean anything at all. A mid-grace STRANGER row is present in
/// every one of the five states (see `rb46_seed_deleting_stranger`), so the
/// admitted states additionally prove the gate keys on `ctx.sender()`.
///
/// WHY THE ADMITTED STATES ERR, and why that is the honest claim. The caller is
/// joined but has no `character` row (and no NPC offers any shop), so it is not
/// beside a shop: the reducer stops at the shop-reach guard — the first guard past
/// the gate, and well before the stock lookup and any wallet write. Every write
/// syscall ABORTS the process (uncatchable, so `#[should_panic]` is not available
/// here). The claim this test proves is therefore: a deletion-gated caller is
/// refused by the gate, and every other caller is ADMITTED past the joined check,
/// the ownership guard and the gate into the shop-reach guard — not that currency
/// changed hands.
///
/// The ordinary error is pinned EXACTLY rather than as any-error: without that, a
/// regression in the joined check (which would return a not-joined error instead)
/// would masquerade as a pass in all three admitted states, and the whole positive
/// control would go quietly vacuous.
///
/// The dummy sender is the all-zero identity; nothing in `buy` treats it
/// specially. Account rows are built with the shipped pure constructors only, so
/// this test can never assemble a state the module itself cannot. `seed` PUSHES
/// rather than upserting, so each state removes the previous row and asserts that
/// exactly one row went.
///
/// kills:
///   - the dropped `buy` gate (and any later deletion of it).
///   - the discarded verdict `let _ = ..` at the `buy` call site: the two
///     refused states go red exactly as a dropped gate does.
///   - an `if false` wrapper or any other unreachable placement.
///   - a constant reject: the three admitted states fail.
///   - INVERTED POLARITY, invisible to every source pin in this slice: the
///     `Active` and no-row states would return the deletion reject instead, which
///     is a total shop outage for every honest player.
///   - a row-exists-keyed fake (`is_some()` rather than the status test): the
///     `Active` state fails.
///   - A TABLE-WIDE SCAN OR ANY-ROW-PENDING FAKE: the three admitted states fail
///     while the stranger is mid-grace. (Written as a full-table iteration it
///     aborts the process on the unmodelled scan syscall instead — also a
///     failure, and a louder one.)
///   - a latched answer that never returns to admitting: the removed-row state
///     fails.
#[test]
fn rb46_buy_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    rb46_seed_player(&fx, me);

    let call = || crate::economy::buy(&ctx, 1, 1, 1);

    let ordinary: Result<(), String> = Err("the shop is not close enough".to_string());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    rb46_seed_deleting_stranger(&acct);

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, no account row): `buy` returned {got:?} \
         for a joined caller with NO account row, while a STRANGER's row is mid-grace. A \
         caller who never authenticated is not inside the deletion gate and must be admitted \
         into the ordinary guard chain; the expected error is the shop-reach guard's, and \
         pinning it EXACTLY is what stops a regression in the joined check from masquerading \
         as a pass. A deletion reject here means the gate answers from the TABLE rather than \
         from the caller's own row. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: an Active account row -------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, Active account): `buy` returned {got:?} \
         for a caller whose account row is `Active` (a stranger's row is mid-grace). This is \
         the ordinary player, and refusing them is a TOTAL SHOP OUTAGE that every source pin \
         in this slice would report as correctly gated — the call text is byte-identical \
         whichever way the decision runs. It is also exactly what a row-EXISTS-keyed fake \
         produces, what an any-row-pending TABLE scan produces, and what an inverted branch \
         produces."
    );

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `Active` account row was seeded for the CALLER and must \
         be removed before the next state is pushed — `seed` appends rather than upserting, \
         so a miscount would leave two rows for one identity and the unique-index lookup \
         would assert instead of answering. `remove` is Identity-keyed, so the stranger's \
         row is deliberately untouched and must never be counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, mid-grace): `buy` returned {got:?} for a \
         caller whose account is `PendingDeletion`; it must return the module's single static \
         deletion reject. THIS IS THE RED STATE AT HEAD — at HEAD `buy` carries no deletion \
         gate, so a mid-grace account can still spend currency into an inventory the cascade \
         is about to erase. The expected value is compared against the CONSTANT, never a \
         re-typed literal, so a reworded reason cannot drift silently into text no client \
         ever receives."
    );

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `PendingDeletion` account row was seeded for the CALLER \
         and must be removed before the terminal row is pushed (`seed` appends, it never \
         upserts; the stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, terminal): `buy` returned {got:?} for a \
         caller whose account carries the M22 terminal marker. An already-erased account has \
         no wallet and no inventory left — the cascade deleted both — so a purchase here \
         would recreate rows the deletion just removed. The pure decision is an explicit \
         disjunction (`accounts::should_reject_for_deletion`) precisely so this state is \
         fail-closed even on the illegal `Active`-plus-marker shape."
    );

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one terminal account row was seeded for the CALLER and must \
         be removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, row removed): `buy` returned {got:?} once \
         the caller's account row was gone again (the stranger's mid-grace row is still \
         there). The verdict must track LIVE rows FOR THE CALLER: an answer that latches on a \
         row it has already seen — a memoised predicate, a cached decision, a process-wide \
         flag — would keep refusing this identity forever, and an any-row-pending answer \
         would refuse it because of somebody else. No state above can distinguish either of \
         those from a correct gate on its own."
    );
}

/// `sell` refuses a deletion-gated caller, ADMITS everybody else, and answers from
/// the CALLER's row.
///
/// The same five-state progression the `buy` test above runs — mid-grace stranger
/// included — applied to `sell`, whose ordinary next-guard error is the same
/// shop-reach refusal: the caller has no `character` row, so the reducer stops one
/// guard past the gate, before the item lookup and any consume. A separate
/// `#[test]` from `buy` on purpose — the
/// two reducers carry separate call sites, so one dropped gate must fail with a
/// message naming which.
///
/// kills: (the dropped `sell` gate) · a discarded verdict at the `sell` call
/// site · an unreachable placement · a constant reject (the three admitted states)
/// · inverted polarity (the `Active` and no-row states) · a row-exists-keyed fake
/// (the `Active` state) · A TABLE-WIDE SCAN OR ANY-ROW-PENDING FAKE (the three
/// admitted states, while the stranger is mid-grace) · a latched answer (the
/// removed-row state). It ALSO kills a gate wired into `buy` only: without this
/// test, half the shop would be gated.
#[test]
fn rb46_sell_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    rb46_seed_player(&fx, me);

    let call = || crate::economy::sell(&ctx, 1, 1);

    let ordinary: Result<(), String> = Err("the shop is not close enough".to_string());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    rb46_seed_deleting_stranger(&acct);

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, no account row): `sell` returned {got:?} \
         for a joined caller with NO account row, while a STRANGER's row is mid-grace. A \
         caller who never authenticated is not inside the deletion gate and must be admitted \
         into the ordinary guard chain; the expected error is the shop-reach guard's, and \
         pinning it EXACTLY is what stops a regression in the joined check from masquerading \
         as a pass. A deletion reject here means the gate answers from the TABLE rather than \
         from the caller's own row. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: an Active account row -------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, Active account): `sell` returned {got:?} \
         for a caller whose account row is `Active` (a stranger's row is mid-grace). This is \
         the ordinary player, and refusing them is a TOTAL SHOP OUTAGE that every source pin \
         in this slice would report as correctly gated. It is also what a row-EXISTS-keyed \
         fake produces, what an any-row-pending TABLE scan produces, and what an inverted \
         branch produces — and an inverted gate here would additionally trap value: a player \
         could no longer liquidate an inventory the cascade is about to erase."
    );

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `Active` account row was seeded for the CALLER and must \
         be removed before the next state is pushed — `seed` appends rather than upserting, \
         so a miscount would leave two rows for one identity and the unique-index lookup \
         would assert instead of answering. `remove` is Identity-keyed, so the stranger's \
         row is deliberately untouched and must never be counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, mid-grace): `sell` returned {got:?} for a \
         caller whose account is `PendingDeletion`; it must return the module's single static \
         deletion reject. THIS IS THE RED STATE AT HEAD — at HEAD `sell` carries no deletion \
         gate, so a mid-grace account can still consume inventory and credit a wallet the \
         cascade is about to erase. The expected value is compared against the CONSTANT, \
         never a re-typed literal, so a reworded reason cannot drift silently into text no \
         client ever receives."
    );

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `PendingDeletion` account row was seeded for the CALLER \
         and must be removed before the terminal row is pushed (`seed` appends, it never \
         upserts; the stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, terminal): `sell` returned {got:?} for a \
         caller whose account carries the M22 terminal marker. An already-erased account has \
         no inventory and no wallet left, so a sale here would recreate a wallet row the \
         cascade deleted. The pure decision is an explicit disjunction \
         (`accounts::should_reject_for_deletion`) precisely so this state is fail-closed even \
         on the illegal `Active`-plus-marker shape."
    );

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one terminal account row was seeded for the CALLER and must \
         be removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, row removed): `sell` returned {got:?} once \
         the caller's account row was gone again (the stranger's mid-grace row is still \
         there). The verdict must track LIVE rows FOR THE CALLER: an answer that latches on a \
         row it has already seen would keep refusing this identity forever, and an \
         any-row-pending answer would refuse it because of somebody else."
    );
}

// `economy.rs`'s REDUCER ROSTER IS CLOSED. WHEN a reducer file other than
// trading.rs gains a new bare reducer attribute THE SYSTEM SHALL fail a
// closed-roster test NAMING THE FILE.
// ==========================================================================

/// `buy`'s SUCCESS path, executed.
///
/// the caller is set with `run_as` (not the all-zero dummy) and stands at the shop
/// counter beside shop 3's keeper, the wallet is writable, and the inventory is
/// registered under BOTH its owner index (the reducer's read) and its primary key
/// (the update's lookup) with the auto-inc id modelled.
///
/// Post-state is pinned in full: the caller pays exactly `price * qty`, a
/// STRANGER's wallet is untouched (the debit keys on `ctx.sender()`), the first
/// purchase INSERTS one stack with a generated id, and the second UPDATES that
/// same stack in place (still one row, same id). kills: a skipped spend, a spend
/// against the wrong wallet, a grant that appends a second stack instead of
/// updating, an auto-inc id never written back, and a price not multiplied by qty.
#[test]
fn nh_buy_success_spends_wallet_and_grants_one_stack() {
    use crate::schema::{Inventory, PlayerWallet, ShopItemRow};
    let fx = crate::native_host_tests::fixture();
    let me = Identity::from_byte_array([21u8; 32]);
    let stranger = Identity::from_byte_array([22u8; 32]);
    rb46_seed_player(&fx, me);
    let (chars, npcs) = ec_reach_tables(&fx);
    ec_seed_counter(&chars, &npcs, 7);
    let stock = fx.table_keyed::<ShopItemRow, u32>("shop_item_row", "shop_id", |r| r.shop_id);
    stock.seed(&ShopItemRow {
        shop_item_id: 1,
        shop_id: 3,
        item_id: 5,
        buy_price: 10,
    });
    let wallets = fx
        .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
        .writable()
        .unique();
    wallets.seed(&PlayerWallet {
        owner_identity: me,
        balance: 100,
    });
    wallets.seed(&PlayerWallet {
        owner_identity: stranger,
        balance: 100,
    });
    let stacks = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable()
        .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
    let _by_id = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();

    let balance_of = |who: Identity| {
        wallets
            .rows()
            .into_iter()
            .find(|w| w.owner_identity == who)
            .map(|w| w.balance)
    };
    let stack_rows = || {
        stacks
            .rows()
            .into_iter()
            .map(|r| (r.inv_id, r.owner_identity, r.item_id, r.count))
            .collect::<Vec<_>>()
    };

    let got = fx.run_as(me, |ctx| crate::economy::buy(ctx, 3, 5, 3));
    assert_eq!(
        got,
        Ok(()),
        "first buy must succeed; indexes asked: {:?}",
        fx.requested_indexes()
    );
    assert_eq!(
        balance_of(me),
        Some(70),
        "the caller pays price * qty = 30 out of 100"
    );
    assert_eq!(
        balance_of(stranger),
        Some(100),
        "a stranger's wallet must never be debited"
    );
    assert_eq!(
        stack_rows(),
        vec![(1, me, 5, 3)],
        "one new stack, auto-inc id 1, count 3"
    );

    let got = fx.run_as(me, |ctx| crate::economy::buy(ctx, 3, 5, 3));
    assert_eq!(got, Ok(()), "second buy must succeed");
    assert_eq!(
        balance_of(me),
        Some(40),
        "the second purchase debits another 30"
    );
    assert_eq!(
        balance_of(stranger),
        Some(100),
        "the stranger is still untouched"
    );
    assert_eq!(
        stack_rows(),
        vec![(1, me, 5, 6)],
        "the SAME stack grows in place: one row, id 1"
    );
}

// ===========================================================================
// Native-host behavioural suite.
//
// Every helper/reducer runs against real rows through the native host. HOST LIMIT:
// no transaction rollback, so each refusal is asserted as refusal BEFORE any write
// (wallets + stacks byte-identical). `buy`/`sell` never take a client price.
// ===========================================================================

use crate::native_host_tests::{fixture as ec_fixture, Fixture as EcFixture, Handle as EcHandle};
use crate::schema::{
    Character, Inventory, ItemRow, Npc, Player, PlayerWallet, ShopItemRow, TradeOffer,
};
use game_core::NpcInteraction;

fn ec_me() -> Identity {
    Identity::from_byte_array([0xE1; 32])
}
fn ec_other() -> Identity {
    Identity::from_byte_array([0xE2; 32])
}
/// The character `entity_id` the `ec_world` player row of `who` names.
fn ec_entity(who: Identity) -> u64 {
    u64::from(who.to_byte_array()[0])
}

/// The zone of the shop counter every ordinary economy test shops at.
const EC_ZONE: u32 = 0;
/// The counter: the keepers of shop 3 and of shop 4 both live on this tile (radius 0).
const EC_COUNTER: (i32, i32) = (12, 4);

/// A `character` row for `entity_id` standing on `(x, y)` in `zone_id`.
fn ec_character(entity_id: u64, zone_id: u32, x: i32, y: i32) -> Character {
    Character {
        entity_id,
        zone_id,
        tile_x: x,
        tile_y: y,
        facing: game_core::Direction::South,
        action: game_core::ActionState::Idle,
        move_started_at_ms: 0,
        sprite_id: 0,
        move_queue: vec![],
        acked_seq: 0,
    }
}

/// An `npc` row whose home is `home` in `zone_id`.
fn ec_npc(
    entity_id: u64,
    zone_id: u32,
    home: (i32, i32),
    wander_radius: u8,
    interaction: NpcInteraction,
) -> Npc {
    Npc {
        entity_id,
        npc_id: format!("npc{entity_id}"),
        zone_id,
        home_x: home.0,
        home_y: home.1,
        wander_radius,
        dialogue_tree_id: String::new(),
        interaction,
    }
}

/// The two tables the shop reach guard reads: `character` by `entity_id` (the caller's tile)
/// and `npc` by `zone_id` (the keepers of the caller's zone).
fn ec_reach_tables(fx: &EcFixture) -> (EcHandle<'_, Character, u64>, EcHandle<'_, Npc, u32>) {
    (
        fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id),
        fx.table_keyed::<Npc, u32>("npc", "zone_id", |r| r.zone_id),
    )
}

/// The shop counter: the keepers of shop 3 and shop 4 at `EC_COUNTER`, and the character
/// `entity_id` one tile south of it, so its owner is in reach of both shops.
fn ec_seed_counter(
    chars: &EcHandle<'_, Character, u64>,
    npcs: &EcHandle<'_, Npc, u32>,
    entity_id: u64,
) {
    for (keeper, shop_id) in [(803, 3), (804, 4)] {
        npcs.seed(&ec_npc(
            keeper,
            EC_ZONE,
            EC_COUNTER,
            0,
            NpcInteraction::Shop(shop_id),
        ));
        chars.seed(&ec_character(keeper, EC_ZONE, EC_COUNTER.0, EC_COUNTER.1));
    }
    chars.seed(&ec_character(
        entity_id,
        EC_ZONE,
        EC_COUNTER.0,
        EC_COUNTER.1 + 1,
    ));
}

/// Every table the economy surface reads or writes, under the indexes it uses.
struct EcWorld<'a> {
    wallets: EcHandle<'a, PlayerWallet>,
    stacks: EcHandle<'a, Inventory>,
    stock: EcHandle<'a, ShopItemRow, u32>,
    items: EcHandle<'a, ItemRow, u32>,
    offers: EcHandle<'a, TradeOffer, u64>,
    chars: EcHandle<'a, Character, u64>,
    npcs: EcHandle<'a, Npc, u32>,
}

/// `ec_bare_world` with the caller (`ec_me()`) standing at the shop counter, in reach of the
/// keepers of shop 3 and shop 4.
fn ec_world(fx: &EcFixture) -> EcWorld<'_> {
    let w = ec_bare_world(fx);
    ec_seed_counter(&w.chars, &w.npcs, ec_entity(ec_me()));
    w
}

/// Players, wallets, stacks, stock, items and offers, with the `character` and `npc` tables
/// registered but empty: nobody stands anywhere and no NPC offers anything.
fn ec_bare_world(fx: &EcFixture) -> EcWorld<'_> {
    let players = fx.table::<Player>("player", "identity", |r| r.identity);
    for who in [ec_me(), ec_other()] {
        players.seed(&Player {
            identity: who,
            entity_id: ec_entity(who),
            name: String::new(),
            online: true,
            last_input_seq: 0,
        });
    }
    let (chars, npcs) = ec_reach_tables(fx);
    let wallets = fx
        .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
        .writable()
        .unique();
    let stacks = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable()
        .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
    let _ = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    let stock = fx.table_keyed::<ShopItemRow, u32>("shop_item_row", "shop_id", |r| r.shop_id);
    let items = fx.table_keyed::<ItemRow, u32>("item_row", "id", |r| r.id);
    let offers = fx.table_keyed::<TradeOffer, u64>("trade_offer", "trade_id", |r| r.trade_id);
    let _ = fx.table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator);
    let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
    // Shop 3 stocks item 5 at 10 and item 6 at 7; shop 4 stocks item 5 at 99 (a
    // wrong-shop price lookup is visible). Item 5 sells for 4, item 8 is unsellable.
    for (shop_item_id, shop_id, item_id, buy_price) in [(1, 3, 5, 10), (2, 3, 6, 7), (3, 4, 5, 99)]
    {
        stock.seed(&ShopItemRow {
            shop_item_id,
            shop_id,
            item_id,
            buy_price,
        });
    }
    for (id, sell_price) in [(5, 4), (6, 3), (8, 0)] {
        items.seed(&ItemRow {
            id,
            name: format!("item{id}"),
            description: String::new(),
            recruit_bonus: 0,
            train_stat: None,
            train_amount: 0,
            sell_price,
            cure_status: None,
        });
    }
    EcWorld {
        wallets,
        stacks,
        stock,
        items,
        offers,
        chars,
        npcs,
    }
}

impl EcWorld<'_> {
    fn wallet(&self, owner: Identity, balance: u64) {
        self.wallets.seed(&PlayerWallet {
            owner_identity: owner,
            balance,
        });
    }
    /// Seeded stack ids start at 1000 so the modelled auto-inc (1, 2, ...) never collides.
    fn stack(&self, owner: Identity, item_id: u32, count: u32) {
        self.stacks.seed(&Inventory {
            inv_id: 1000 + u64::from(owner.to_byte_array()[0]) * 100 + u64::from(item_id),
            owner_identity: owner,
            item_id,
            count,
        });
    }
    fn balance(&self, owner: Identity) -> Option<u64> {
        self.wallets
            .rows()
            .into_iter()
            .find(|w| w.owner_identity == owner)
            .map(|w| w.balance)
    }
    fn count(&self, owner: Identity, item_id: u32) -> Option<u32> {
        self.stacks
            .rows()
            .into_iter()
            .find(|r| r.owner_identity == owner && r.item_id == item_id)
            .map(|r| r.count)
    }
    fn snapshot(&self) -> Vec<Vec<u8>> {
        use spacetimedb::sats::bsatn::to_vec;
        vec![
            to_vec(&self.wallets.rows()).unwrap(),
            to_vec(&self.stacks.rows()).unwrap(),
            to_vec(&self.stock.rows()).unwrap(),
            to_vec(&self.items.rows()).unwrap(),
            to_vec(&self.chars.rows()).unwrap(),
            to_vec(&self.npcs.rows()).unwrap(),
        ]
    }
    /// Stand `who`'s character on `(x, y)` in `zone_id`, replacing any row it had.
    fn place(&self, who: Identity, zone_id: u32, x: i32, y: i32) {
        let entity_id = ec_entity(who);
        self.chars.remove(entity_id);
        self.chars.seed(&ec_character(entity_id, zone_id, x, y));
    }
    /// A Pending offer from `ec_me()` listing `currency` and item 5 x `qty`.
    fn escrow(&self, currency: u64, qty: u32) {
        self.offers.seed(&TradeOffer {
            trade_id: 77,
            initiator: ec_me(),
            counterparty: ec_other(),
            initiator_monster_ids: vec![],
            initiator_items: if qty > 0 {
                vec![game_core::TradeItem { item_id: 5, qty }]
            } else {
                vec![]
            },
            initiator_currency: currency,
            counterparty_monster_ids: vec![],
            counterparty_items: vec![],
            counterparty_currency: 0,
            initiator_cards: vec![],
            counterparty_cards: vec![],
            status: game_core::TradeStatus::Pending,
            created_at_ms: 0,
        });
    }
}

/// EV-currency-integrity#arithmetic (grant half): `grant_currency` inserts a missing
/// wallet with exactly the amount, adds to an existing one, saturates at exactly
/// MAX_BALANCE (both at and past the headroom boundary), creates no phantom row for 0,
/// and touches no other wallet.
/// kills: grant_currency -> (), `== 0` -> `!= 0`, update/insert swapped, a replace-not-add.
#[test]
fn nh_grant_currency_upserts_adds_and_saturates_at_max_balance() {
    let fx = ec_fixture();
    let w = ec_world(&fx);
    w.wallet(ec_other(), 5);
    let ctx = fx.ctx();
    grant_currency(&ctx, ec_me(), 0);
    assert_eq!(
        w.balance(ec_me()),
        None,
        "a 0 grant inserts no phantom wallet row"
    );
    grant_currency(&ctx, ec_me(), 40);
    assert_eq!(
        w.balance(ec_me()),
        Some(40),
        "a missing wallet is created with exactly the amount"
    );
    grant_currency(&ctx, ec_me(), 2);
    assert_eq!(
        w.balance(ec_me()),
        Some(42),
        "an existing wallet is ADDED to, not replaced"
    );
    grant_currency(&ctx, ec_me(), 0);
    assert_eq!(
        w.balance(ec_me()),
        Some(42),
        "a 0 grant leaves an existing balance alone"
    );
    grant_currency(&ctx, ec_me(), MAX_BALANCE - 43);
    assert_eq!(
        w.balance(ec_me()),
        Some(MAX_BALANCE - 1),
        "one below the cap is exact"
    );
    grant_currency(&ctx, ec_me(), 1);
    assert_eq!(
        w.balance(ec_me()),
        Some(MAX_BALANCE),
        "landing exactly on the cap is exact"
    );
    grant_currency(&ctx, ec_me(), 1);
    assert_eq!(
        w.balance(ec_me()),
        Some(MAX_BALANCE),
        "past the cap saturates, never wraps"
    );
    grant_currency(&ctx, ec_me(), u64::MAX);
    assert_eq!(
        w.balance(ec_me()),
        Some(MAX_BALANCE),
        "a u64::MAX grant saturates too"
    );
    assert_eq!(
        w.wallets.rows().len(),
        2,
        "exactly one wallet row per owner"
    );
    assert_eq!(
        w.balance(ec_other()),
        Some(5),
        "a bystander's wallet is untouched"
    );
}

/// EV-currency-integrity#arithmetic (spend half): `spend_currency` debits exactly,
/// admits spending the whole balance (boundary), refuses one more than the balance with
/// the row unchanged, refuses a missing wallet without creating one, and treats 0 as a
/// no-op.
/// kills: spend_currency -> Ok(()), checked_sub -> saturating_sub, `== 0` guard removed.
#[test]
fn nh_spend_currency_debits_exactly_and_refuses_overdraft() {
    let fx = ec_fixture();
    let w = ec_world(&fx);
    w.wallet(ec_me(), 30);
    w.wallet(ec_other(), 5);
    let ctx = fx.ctx();
    assert_eq!(spend_currency(&ctx, ec_me(), 0), Ok(()));
    assert_eq!(w.balance(ec_me()), Some(30), "a 0 spend changes nothing");
    assert_eq!(spend_currency(&ctx, ec_me(), 12), Ok(()));
    assert_eq!(w.balance(ec_me()), Some(18), "debits exactly the amount");
    assert!(
        spend_currency(&ctx, ec_me(), 19).is_err(),
        "one past the balance is refused"
    );
    assert_eq!(
        w.balance(ec_me()),
        Some(18),
        "a refused spend writes nothing"
    );
    assert_eq!(
        spend_currency(&ctx, ec_me(), 18),
        Ok(()),
        "the whole balance is spendable"
    );
    assert_eq!(
        w.balance(ec_me()),
        Some(0),
        "an emptied wallet stays (balance 0)"
    );
    let ghost = Identity::from_byte_array([0xEF; 32]);
    assert_eq!(spend_currency(&ctx, ghost, 1), Err("no wallet".to_string()));
    assert_eq!(
        spend_currency(&ctx, ghost, 0),
        Ok(()),
        "0 from a missing wallet is a no-op"
    );
    assert_eq!(
        w.balance(ghost),
        None,
        "no wallet is ever created by a spend"
    );
    assert_eq!(
        w.balance(ec_other()),
        Some(5),
        "a bystander's wallet is untouched"
    );
}

/// EV-shop-reducer-security: `buy` charges exactly the SERVER price of the (shop, item)
/// row times qty and refuses — before any write — an unjoined caller, qty 0, an item this
/// shop does not stock, funds one short, currency escrowed in a live offer, and a buy that
/// would overflow the item stack cap (boundary: cap-qty is admitted).
/// kills: price lookup ignoring shop_id, `total > available` -> `>=`, headroom skipped,
/// spend_currency before the guards, grant_item skipped.
#[test]
fn nh_buy_refuses_before_writing_and_charges_the_server_price() {
    const CAP: u32 = game_core::MAX_ITEM_STACK;
    let fx = ec_fixture();
    let w = ec_world(&fx);
    w.wallet(ec_me(), 30);
    w.wallet(ec_other(), 1000);
    let before = w.snapshot();
    let refusals: Vec<(&str, Identity, u32, u32, u32)> = vec![
        (
            "unjoined caller",
            Identity::from_byte_array([0xEF; 32]),
            3,
            5,
            1,
        ),
        ("qty 0", ec_me(), 3, 5, 0),
        ("item not stocked by this shop", ec_me(), 4, 6, 1),
        ("unknown shop", ec_me(), 9, 5, 1),
        ("funds one short (4 x 10 > 30)", ec_me(), 3, 5, 4),
    ];
    for (label, who, shop, item, qty) in refusals {
        let got = fx.run_as(who, |ctx| buy(ctx, shop, item, qty));
        assert!(got.is_err(), "{label}: must be refused, got {got:?}");
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }
    // Exact funds: 3 x 10 == 30 is admitted and empties the wallet (shop 3's price,
    // never shop 4's 99 for the same item).
    assert_eq!(fx.run_as(ec_me(), |ctx| buy(ctx, 3, 5, 3)), Ok(()));
    assert_eq!(
        w.balance(ec_me()),
        Some(0),
        "charged exactly shop 3's 10 x 3"
    );
    assert_eq!(w.count(ec_me(), 5), Some(3), "credited exactly qty");
    assert_eq!(
        w.balance(ec_other()),
        Some(1000),
        "a stranger is never debited"
    );

    // Escrow: 25 of a 30 balance is listed in a live offer, so 1 x 7 > 5 is refused.
    drop(fx);
    let fx = ec_fixture();
    let w = ec_world(&fx);
    w.wallet(ec_me(), 30);
    w.escrow(25, 0);
    let before = w.snapshot();
    assert_eq!(
        fx.run_as(ec_me(), |ctx| buy(ctx, 3, 6, 1)),
        Err("currency is in an active trade".to_string())
    );
    assert_eq!(w.snapshot(), before, "escrow refusal writes nothing");

    // Item-cap headroom: at CAP-1 buying 2 is refused (wallet untouched), buying 1 lands
    // exactly on the cap.
    drop(fx);
    let fx = ec_fixture();
    let w = ec_world(&fx);
    w.wallet(ec_me(), 1000);
    w.stack(ec_me(), 5, CAP - 1);
    let before = w.snapshot();
    let want = game_core::check_item_headroom(CAP - 1, 2, 5)
        .unwrap_err()
        .to_string();
    assert_eq!(fx.run_as(ec_me(), |ctx| buy(ctx, 3, 5, 2)), Err(want));
    assert_eq!(w.snapshot(), before, "headroom refusal before the spend");
    assert_eq!(fx.run_as(ec_me(), |ctx| buy(ctx, 3, 5, 1)), Ok(()));
    assert_eq!(
        w.count(ec_me(), 5),
        Some(CAP),
        "cap reached exactly, same stack"
    );
    assert_eq!(
        w.stacks.rows().len(),
        1,
        "grew the existing stack, no second row"
    );
    assert_eq!(w.balance(ec_me()), Some(990));
}

/// EV-shop-reducer-security: `sell` credits exactly item_row.sell_price x qty and
/// consumes exactly qty (deleting an emptied stack); it refuses — before any write — qty
/// 0, an unknown or unsellable item, more than held, items escrowed in a live offer, and
/// proceeds that would overflow MAX_BALANCE (boundary: landing on the cap is admitted).
/// kills: sell -> Ok(()), sell_price from the wrong row, headroom skipped, consume loop
/// off-by-one, grant_currency skipped.
#[test]
fn nh_sell_refuses_before_writing_and_credits_the_server_price() {
    let fx = ec_fixture();
    let w = ec_world(&fx);
    w.wallet(ec_me(), 10);
    w.stack(ec_me(), 5, 3);
    w.stack(ec_me(), 8, 2);
    let before = w.snapshot();
    let refusals: Vec<(&str, Identity, u32, u32)> = vec![
        (
            "unjoined caller",
            Identity::from_byte_array([0xEF; 32]),
            5,
            1,
        ),
        ("qty 0", ec_me(), 5, 0),
        ("unknown item", ec_me(), 404, 1),
        ("unsellable item (sell_price 0)", ec_me(), 8, 1),
        ("more than held", ec_me(), 5, 4),
    ];
    for (label, who, item, qty) in refusals {
        let got = fx.run_as(who, |ctx| sell(ctx, item, qty));
        assert!(got.is_err(), "{label}: must be refused, got {got:?}");
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }
    assert_eq!(fx.run_as(ec_me(), |ctx| sell(ctx, 5, 2)), Ok(()));
    assert_eq!(w.balance(ec_me()), Some(18), "credited exactly 4 x 2");
    assert_eq!(w.count(ec_me(), 5), Some(1), "consumed exactly 2");
    assert_eq!(fx.run_as(ec_me(), |ctx| sell(ctx, 5, 1)), Ok(()));
    assert_eq!(w.count(ec_me(), 5), None, "an emptied stack is deleted");
    assert_eq!(w.balance(ec_me()), Some(22));

    // Escrow: 2 of 3 listed in a live offer, so selling 2 is refused; 1 is admitted.
    drop(fx);
    let fx = ec_fixture();
    let w = ec_world(&fx);
    w.stack(ec_me(), 5, 3);
    w.escrow(0, 2);
    let before = w.snapshot();
    assert_eq!(
        fx.run_as(ec_me(), |ctx| sell(ctx, 5, 2)),
        Err("item is in an active trade".to_string())
    );
    assert_eq!(w.snapshot(), before, "escrow refusal writes nothing");
    assert_eq!(fx.run_as(ec_me(), |ctx| sell(ctx, 5, 1)), Ok(()));
    assert_eq!(
        w.balance(ec_me()),
        Some(4),
        "a missing wallet is created by the proceeds"
    );

    // Currency-cap headroom: 3 x 4 = 12 onto MAX-11 is refused (inventory untouched);
    // 2 x 4 = 8 onto MAX-11 is admitted; then 3 more lands exactly on the cap.
    drop(fx);
    let fx = ec_fixture();
    let w = ec_world(&fx);
    w.wallet(ec_me(), MAX_BALANCE - 11);
    w.stack(ec_me(), 5, 5);
    let before = w.snapshot();
    let want = game_core::check_currency_headroom(MAX_BALANCE - 11, 12)
        .unwrap_err()
        .to_string();
    assert_eq!(fx.run_as(ec_me(), |ctx| sell(ctx, 5, 3)), Err(want));
    assert_eq!(w.snapshot(), before, "cap refusal before any consume");
    assert_eq!(fx.run_as(ec_me(), |ctx| sell(ctx, 5, 2)), Ok(()));
    assert_eq!(w.balance(ec_me()), Some(MAX_BALANCE - 3));
    w.stack(ec_me(), 6, 1);
    assert_eq!(fx.run_as(ec_me(), |ctx| sell(ctx, 6, 1)), Ok(()));
    assert_eq!(
        w.balance(ec_me()),
        Some(MAX_BALANCE),
        "exactly the cap is admitted"
    );
}

/// EV-wallet-privacy (native half): the SHIPPED `my_wallet` view, run through the
/// runtime's own view entry point, answers each sender with exactly their own row —
/// a stranger with no wallet sees nothing, a stranger with a wallet sees only theirs.
/// kills: a view keyed on anything but ctx.sender(), a whole-table view, `find` -> None.
#[test]
fn nh_my_wallet_view_returns_only_the_senders_row() {
    use crate::native_host_tests::VIEW_MY_WALLET;
    let fx = ec_fixture();
    let w = ec_world(&fx);
    w.wallet(ec_me(), 77);
    let mine: Vec<PlayerWallet> = fx.call_view(VIEW_MY_WALLET, ec_me());
    assert_eq!(
        mine.iter()
            .map(|r| (r.owner_identity, r.balance))
            .collect::<Vec<_>>(),
        vec![(ec_me(), 77)],
        "the owner sees exactly their own row"
    );
    let theirs: Vec<PlayerWallet> = fx.call_view(VIEW_MY_WALLET, ec_other());
    assert!(theirs.is_empty(), "a stranger without a wallet sees no row");
    w.wallet(ec_other(), 5);
    let theirs: Vec<PlayerWallet> = fx.call_view(VIEW_MY_WALLET, ec_other());
    assert_eq!(
        theirs
            .iter()
            .map(|r| (r.owner_identity, r.balance))
            .collect::<Vec<_>>(),
        vec![(ec_other(), 5)],
        "a stranger with a wallet sees only their own, never the owner's 77"
    );
}

/// `rekey_wallet` credits the whole guest balance forward onto the destination (adding to
/// any existing balance) and ZEROES the guest row in place — never deletes it; a missing
/// guest is a no-op. `erase_wallet` deletes exactly the owner's row.
/// kills: rekey_wallet -> (), zero-before-read, delete instead of zero, erase_wallet -> ().
#[test]
fn nh_rekey_wallet_credits_forward_and_erase_wallet_deletes_only_the_owner() {
    let fx = ec_fixture();
    let w = ec_world(&fx);
    let dest = Identity::from_byte_array([0xE3; 32]);
    w.wallet(ec_me(), 40);
    w.wallet(dest, 2);
    w.wallet(ec_other(), 9);
    let ctx = fx.ctx();
    rekey_wallet(&ctx, ec_me(), dest);
    assert_eq!(
        w.balance(dest),
        Some(42),
        "the guest balance is credited forward, added"
    );
    assert_eq!(
        w.balance(ec_me()),
        Some(0),
        "the guest row is zeroed in place, not deleted"
    );
    let ghost = Identity::from_byte_array([0xEF; 32]);
    rekey_wallet(&ctx, ghost, dest);
    assert_eq!(w.balance(dest), Some(42), "a missing guest re-keys nothing");
    assert_eq!(w.balance(ghost), None);
    erase_wallet(&ctx, ec_me());
    assert_eq!(w.balance(ec_me()), None, "erase deletes the owner's row");
    assert_eq!(w.balance(dest), Some(42), "and no other");
    assert_eq!(w.balance(ec_other()), Some(9));
}

// ===========================================================================
// ctl-16 (CTL16.3): no buying or selling during an Ongoing battle. The SHIPPED `buy`
// and `sell` run as a caller in an Ongoing battle in either role (wild and PvP side
// A, PvP side B, practice) and must refuse before the quantity check, with wallets,
// stacks and trade offers byte-identical; the controls (no battle row, the caller's
// finished battles, a stranger's Ongoing battle) still trade at the server price.
// Every case gets a fresh fixture, because the host has no rollback.
// ===========================================================================
mod ctl16_shop_battle_guard {
    use super::*;

    use crate::schema::Battle;
    use game_core::BattleOutcome;
    use spacetimedb::sats::bsatn::to_vec;

    const BUY_REFUSED: &str = "cannot buy during an ongoing battle";
    const SELL_REFUSED: &str = "cannot sell during an ongoing battle";

    fn empty_side() -> game_core::BattleSide {
        game_core::BattleSide {
            active: 0,
            team: vec![],
        }
    }

    /// A battle row in `outcome`, `player` on side A and `opponent` on side B.
    pub(super) fn battle(
        battle_id: u64,
        player: Identity,
        opponent: Identity,
        outcome: BattleOutcome,
    ) -> Battle {
        Battle {
            battle_id,
            player_identity: player,
            opponent_identity: opponent,
            state: game_core::BattleState {
                side_a: empty_side(),
                side_b: empty_side(),
                outcome,
                turn_number: 1,
                weather: None,
            },
            party_monster_ids: vec![],
            opponent_monster_ids: vec![],
            created_at_ms: 0,
        }
    }

    fn third_player() -> Identity {
        Identity::from_byte_array([0xE3; 32])
    }

    /// Worlds where the caller is in an Ongoing battle, in either role, as the battle
    /// rows to seed in order: each shape alone, then two two-row worlds (production
    /// keeps each player's latest finished battle next to a new Ongoing one).
    fn refused_worlds() -> Vec<(&'static str, Vec<Battle>)> {
        let (me, other) = (ec_me(), ec_other());
        let (wild, live) = (crate::WILD_IDENTITY, BattleOutcome::Ongoing);
        let shapes = [
            ("wild, side A", me, wild),
            ("PvP, side A", me, other),
            ("PvP, side B", other, me),
            ("practice", me, me),
        ];
        let mut out = Vec::new();
        for (label, a, b) in shapes {
            out.push((label, vec![battle(1, a, b, live)]));
        }
        let finished_then_live = vec![
            battle(1, me, other, BattleOutcome::SideAWins),
            battle(2, me, wild, live),
        ];
        out.push(("finished A, then Ongoing A", finished_then_live));
        let live_then_finished = vec![
            battle(1, third_player(), me, live),
            battle(2, other, me, BattleOutcome::Fled),
        ];
        out.push(("Ongoing B, then finished B", live_then_finished));
        out
    }

    /// Worlds where the caller is in no Ongoing battle: no battle row; their own battle
    /// finished (every terminal outcome, on side A and on side B); a stranger's Ongoing
    /// battle against the wild and against a third player.
    fn controls() -> Vec<(&'static str, Vec<Battle>)> {
        let (me, other) = (ec_me(), ec_other());
        let (wild, third) = (crate::WILD_IDENTITY, third_player());
        let shapes = [
            ("A/SideAWins", me, other, BattleOutcome::SideAWins),
            ("A/SideBWins", me, other, BattleOutcome::SideBWins),
            ("A/Fled", me, other, BattleOutcome::Fled),
            ("B/SideAWins", other, me, BattleOutcome::SideAWins),
            ("B/SideBWins", other, me, BattleOutcome::SideBWins),
            ("B/Fled", other, me, BattleOutcome::Fled),
            ("stranger/wild", other, wild, BattleOutcome::Ongoing),
            ("stranger/PvP", other, third, BattleOutcome::Ongoing),
        ];
        let mut out = vec![("no battle row", vec![])];
        for (label, a, b, outcome) in shapes {
            out.push((label, vec![battle(1, a, b, outcome)]));
        }
        out
    }

    /// `ec_world` where buying 2 x item 5 at shop 3 (20) and selling 2 x item 5 (8)
    /// would both succeed: 1000 in the wallet, 3 of item 5, and a live offer that
    /// escrows 25 currency and 1 x item 5. Plus the battle table under BOTH participant
    /// indexes (one row store), with `battles` seeded in order through one handle.
    fn shop_world<'a>(fx: &'a EcFixture, battles: &[Battle]) -> EcWorld<'a> {
        let w = ec_world(fx);
        w.wallet(ec_me(), 1000);
        w.stack(ec_me(), 5, 3);
        w.escrow(25, 1);
        let handle = fx.table::<Battle>("battle", "player_identity", |r| r.player_identity);
        let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
        for row in battles {
            handle.seed(row);
        }
        w
    }

    /// Wallets, stacks, stock and items (`EcWorld::snapshot`) plus the trade offers.
    fn snapshot(w: &EcWorld<'_>) -> Vec<Vec<u8>> {
        let mut all = w.snapshot();
        all.push(to_vec(&w.offers.rows()).unwrap());
        all
    }

    /// CTL16.3 (buy): a buy that would succeed is refused for a caller in an Ongoing
    /// battle, in any role, with the exact message, and wallets, stacks and the escrow
    /// offer stay byte-identical. Also at qty 0: the guard precedes the quantity check.
    /// kills: no guard in buy; a check of one role, or of one row per role, only; the
    /// guard placed after the qty check or after the spend.
    #[test]
    fn ctl16_3_buy_refused_in_ongoing_battle_either_role_store_unchanged() {
        for (label, rows) in refused_worlds() {
            for qty in [2, 0] {
                let fx = ec_fixture();
                let w = shop_world(&fx, &rows);
                let before = snapshot(&w);
                assert_eq!(
                    fx.run_as(ec_me(), |ctx| buy(ctx, 3, 5, qty)),
                    Err(BUY_REFUSED.to_string()),
                    "{label}, qty {qty}"
                );
                assert_eq!(snapshot(&w), before, "{label}, qty {qty}: unchanged");
            }
        }
    }

    /// CTL16.3 (sell): a sale that would succeed (2 of 3 held, 1 escrowed) is refused
    /// for a caller in an Ongoing battle, in any role, with the exact message, and
    /// wallets, stacks and the escrow offer stay byte-identical. Also at qty 0: the
    /// guard precedes the quantity check.
    /// kills: no guard in sell; a check of one role, or of one row per role, only; the
    /// guard placed after the qty check or after the consume.
    #[test]
    fn ctl16_3_sell_refused_in_ongoing_battle_either_role_store_unchanged() {
        for (label, rows) in refused_worlds() {
            for qty in [2, 0] {
                let fx = ec_fixture();
                let w = shop_world(&fx, &rows);
                let before = snapshot(&w);
                assert_eq!(
                    fx.run_as(ec_me(), |ctx| sell(ctx, 5, qty)),
                    Err(SELL_REFUSED.to_string()),
                    "{label}, qty {qty}"
                );
                assert_eq!(snapshot(&w), before, "{label}, qty {qty}: unchanged");
            }
        }
    }

    /// CTL16.3 controls: with no battle row, only the caller's finished battles, or a
    /// stranger's Ongoing battle, buy and then sell are admitted and move exactly the
    /// server price (shop 3 charges 10 per item 5, item 5 sells for 4). This is what
    /// makes the refusals' "unchanged" non-vacuous.
    /// kills: a guard ignoring the outcome; a table-wide check; refuse-everything.
    #[test]
    fn ctl16_3_buy_and_sell_admitted_without_an_ongoing_battle_of_the_callers() {
        for (label, rows) in controls() {
            let fx = ec_fixture();
            let w = shop_world(&fx, &rows);
            assert_eq!(
                fx.run_as(ec_me(), |ctx| buy(ctx, 3, 5, 2)),
                Ok(()),
                "{label}: buy admitted"
            );
            assert_eq!(w.balance(ec_me()), Some(980), "{label}: paid 20");
            assert_eq!(w.count(ec_me(), 5), Some(5), "{label}: got 2");
            assert_eq!(
                fx.run_as(ec_me(), |ctx| sell(ctx, 5, 2)),
                Ok(()),
                "{label}: sell admitted"
            );
            assert_eq!(w.balance(ec_me()), Some(988), "{label}: got 8");
            assert_eq!(w.count(ec_me(), 5), Some(3), "{label}: sold 2");
        }
    }
}

// ===========================================================================
// ts-6b-2.1 — shop reach. `buy` and `sell` serve only a caller whose character stands in
// the zone of an NPC that offers the shop, within TALK_RANGE + that NPC's wander_radius
// (Manhattan, inclusive) of the NPC's HOME tile: `buy` needs the keeper of the named
// shop, `sell` the keeper of any shop. Every other caller (another zone, too far, no
// character) gets one refusal, checked right after the deletion gate and before the
// battle, quantity, stock, escrow, wallet and inventory guards, and nothing is written.
// ===========================================================================

/// The one refusal `buy` and `sell` give a caller who is not beside a shop.
const SHOP_NOT_CLOSE: &str = "the shop is not close enough";
/// The reach world's zone, and another zone.
const RC_ZONE: u32 = 1;
const RC_OTHER_ZONE: u32 = 2;
/// Shop 3's keeper: home (40, 10), x != y; wanders 3 tiles, so its reach is 2 + 3 = 5. Its
/// `character` row stands AWAY from home, outside its wander disc, at (50, 10).
const RC_X_HOME: (i32, i32) = (40, 10);
const RC_X_RADIUS: u8 = 3;
const RC_X_NOW: (i32, i32) = (50, 10);
/// Shop 4's keeper: home (-60, 70); wanders 2 tiles, so its reach is 4.
const RC_Y_HOME: (i32, i32) = (-60, 70);
/// A `Dialogue` NPC and a `Heal(1)` NPC, radius 0.
const RC_TALKER_HOME: (i32, i32) = (100, -20);
const RC_HEALER_HOME: (i32, i32) = (-100, -40);
/// A keeper of shop 3 in `RC_OTHER_ZONE`, radius 0.
const RC_ELSEWHERE_HOME: (i32, i32) = (-200, 30);

/// One shop call, run as the caller.
type RcCall<'a> = &'a dyn Fn() -> Result<(), String>;

impl EcWorld<'_> {
    /// Seed `npc` with its `character` row standing on `now`.
    fn npc_at(&self, npc: Npc, now: (i32, i32)) {
        self.chars
            .seed(&ec_character(npc.entity_id, npc.zone_id, now.0, now.1));
        self.npcs.seed(&npc);
    }
}

/// `ec_bare_world` plus the five NPCs above, 1000 in the caller's wallet, 30 of item 5 in
/// its inventory and 7 in a bystander's wallet. The caller stands nowhere until placed.
fn rc_world(fx: &EcFixture) -> EcWorld<'_> {
    use game_core::NpcInteraction::{Dialogue, Heal, Shop};
    let w = ec_bare_world(fx);
    let keeper_x = ec_npc(901, RC_ZONE, RC_X_HOME, RC_X_RADIUS, Shop(3));
    w.npc_at(keeper_x, RC_X_NOW);
    w.npc_at(ec_npc(902, RC_ZONE, RC_Y_HOME, 2, Shop(4)), RC_Y_HOME);
    let talker = ec_npc(903, RC_ZONE, RC_TALKER_HOME, 0, Dialogue);
    w.npc_at(talker, RC_TALKER_HOME);
    let healer = ec_npc(904, RC_ZONE, RC_HEALER_HOME, 0, Heal(1));
    w.npc_at(healer, RC_HEALER_HOME);
    let keeper_elsewhere = ec_npc(905, RC_OTHER_ZONE, RC_ELSEWHERE_HOME, 0, Shop(3));
    w.npc_at(keeper_elsewhere, RC_ELSEWHERE_HOME);
    w.wallet(ec_me(), 1000);
    w.stack(ec_me(), 5, 30);
    w.wallet(ec_other(), 7);
    w
}

/// `buy` and `sell` run for a caller beside a keeper of the shop and are refused, with one
/// text and nothing written, for every other caller — whatever its battle, quantity, item,
/// wallet, escrow or inventory would say. One world, one fixture: every accepted call is
/// asserted to move exactly the server price and one item, so the refusals around it are
/// refusals of a call that would otherwise succeed.
///
/// kills:
///   - reach never checked (the shipped code before this slice): the first far tile around
///     shop 3's keeper buys and sells.
///   - `<` for `<=`: (5, 0), (-4, -1), (2, -3) and (-1, 4) from home are at exactly reach 5
///     and must be accepted.
///   - the wander radius dropped or passed as 0 (reach 2): the same four tiles.
///   - `home_x` / `home_y` swapped: home (40, 10) becomes (10, 40), every accepted tile
///     is refused.
///   - the NPC's current tile (its `character` row) used instead of home: the accepted
///     tiles are all more than 2 from (50, 10), and (50, 10) / (51, 11) — beside the
///     current tile, out of reach of home — must be refused.
///   - a bound one too wide: (6, 0), (4, 2), (-2, -4), (-1, 5), (0, -6), and one past shop
///     4's keeper.
///   - the zone ignored: the accepted tile (45, 10) in the other zone, and a tile beside
///     the other zone's shop 3 keeper's coordinates in this zone, must be refused; the
///     same tile in the keeper's zone is accepted.
///   - `buy` accepting any shop's keeper: beside shop 4's keeper `buy` from 3 is refused
///     and from 4 succeeds at 99; beside shop 3's keeper `buy` from 4 and from 9 (offered
///     by nobody) are refused; beside the `Heal(1)` NPC `buy` from 1 is refused.
///   - `sell` accepting any NPC: beside only the `Dialogue` NPC or the `Heal(1)` NPC `sell`
///     is refused; beside shop 4's keeper (not shop 3's) it succeeds.
///   - a text per cause: no `character` row, another zone and too far are compared against
///     the one literal, from `buy` and from `sell`.
///   - the reach check placed after a later guard: one tile out of reach, a caller in an
///     ongoing battle, at qty 0, naming an unstocked, unsellable or unknown item, with too
///     little or escrowed currency, a full stack, or too few or escrowed items gets the
///     reach text; one tile back in reach the same call gets that later guard's own text
///     (the control that proves the later guard was armed).
///   - a refusal that writes: wallets, stacks, stock, items, characters, NPCs, offers and
///     battles are byte-identical across every refusal.
#[test]
fn buy_and_sell_are_refused_away_from_a_shop_npc_and_accepted_beside_it() {
    use crate::schema::Battle;
    use ctl16_shop_battle_guard::battle;
    use game_core::BattleOutcome;
    use spacetimedb::sats::bsatn::to_vec;
    const CAP: u32 = game_core::MAX_ITEM_STACK;

    let fx = ec_fixture();
    let w = rc_world(&fx);
    let battles = fx.table::<Battle>("battle", "player_identity", |r| r.player_identity);
    let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
    let me = ec_me();
    let (hx, hy) = RC_X_HOME;

    let all = || {
        let mut rows = w.snapshot();
        rows.push(to_vec(&w.offers.rows()).unwrap());
        rows.push(to_vec(&battles.rows()).unwrap());
        rows
    };
    let buy_as = |shop: u32, item: u32, qty: u32| fx.run_as(me, |ctx| buy(ctx, shop, item, qty));
    let sell_as = |item: u32, qty: u32| fx.run_as(me, |ctx| sell(ctx, item, qty));
    // The one refusal, word for word, with every row the world holds unchanged.
    let refused = |label: &str, call: RcCall<'_>| {
        let before = all();
        assert_eq!(
            call(),
            Err(SHOP_NOT_CLOSE.to_string()),
            "{label}; indexes asked: {:?}",
            fx.requested_indexes()
        );
        assert_eq!(all(), before, "{label}: a refused call writes nothing");
    };
    // Buy 1 x item 5 from `shop`: Ok, exactly `price` paid, exactly one item gained.
    let bought = |label: &str, shop: u32, price: u64| {
        let (balance, held) = (w.balance(me), w.count(me, 5));
        assert_eq!(
            buy_as(shop, 5, 1),
            Ok(()),
            "{label}: buy 1 x item 5 from shop {shop}"
        );
        assert_eq!(
            w.balance(me),
            balance.map(|b| b - price),
            "{label}: paid {price}"
        );
        assert_eq!(
            w.count(me, 5),
            held.map(|n| n + 1),
            "{label}: got one item 5"
        );
    };
    // Sell 1 x item 5: Ok, exactly 4 credited, exactly one item gone.
    let sold = |label: &str| {
        let (balance, held) = (w.balance(me), w.count(me, 5));
        assert_eq!(sell_as(5, 1), Ok(()), "{label}: sell 1 x item 5");
        assert_eq!(w.balance(me), balance.map(|b| b + 4), "{label}: got 4");
        assert_eq!(
            w.count(me, 5),
            held.map(|n| n - 1),
            "{label}: one item 5 gone"
        );
    };
    // One tile out of reach the call gets the reach text; one tile back in reach, the
    // same call gets `later` — the guard that would have refused it anyway.
    let reach_first = |label: &str, call: RcCall<'_>, later: &str| {
        w.place(me, RC_ZONE, hx + 6, hy);
        refused(&format!("{label}, out of reach"), call);
        w.place(me, RC_ZONE, hx + 5, hy);
        let before = all();
        assert_eq!(
            call(),
            Err(later.to_string()),
            "{label}, in reach: the later guard's own refusal"
        );
        assert_eq!(all(), before, "{label}, in reach: nothing written");
    };

    // Around shop 3's keeper (home (40, 10), reach 5): accepted from Manhattan 0 to exactly
    // 5 — none of these tiles is within 2 of its current tile (50, 10) — refused at 6.
    for (dx, dy) in [(0, 0), (5, 0), (-4, -1), (2, -3), (-1, 4)] {
        w.place(me, RC_ZONE, hx + dx, hy + dy);
        let at = format!("({dx}, {dy}) from shop 3's home");
        bought(&at, 3, 10);
        sold(&at);
    }
    for (dx, dy) in [(6, 0), (4, 2), (-2, -4), (-1, 5), (0, -6)] {
        w.place(me, RC_ZONE, hx + dx, hy + dy);
        let at = format!("({dx}, {dy}) from shop 3's home");
        refused(&format!("{at}: buy"), &|| buy_as(3, 5, 1));
        refused(&format!("{at}: sell"), &|| sell_as(5, 1));
    }

    // The keeper's current tile is not consulted: on it, or beside it, but out of reach
    // of its home, is refused.
    for (x, y) in [RC_X_NOW, (RC_X_NOW.0 + 1, RC_X_NOW.1 + 1)] {
        w.place(me, RC_ZONE, x, y);
        let at = format!("({x}, {y}), by shop 3's current tile");
        refused(&format!("{at}: buy"), &|| buy_as(3, 5, 1));
        refused(&format!("{at}: sell"), &|| sell_as(5, 1));
    }

    // Another zone: the accepted tile (45, 10) in the other zone is refused; beside the
    // other zone's shop 3 keeper's coordinates, but in this zone, is refused; the same tile
    // in the keeper's own zone is the control.
    w.place(me, RC_OTHER_ZONE, hx + 5, hy);
    refused("other zone, (45, 10): buy", &|| buy_as(3, 5, 1));
    refused("other zone, (45, 10): sell", &|| sell_as(5, 1));
    let (ex, ey) = RC_ELSEWHERE_HOME;
    w.place(me, RC_ZONE, ex, ey + 1);
    refused("zone 1 by zone 2's keeper: buy", &|| buy_as(3, 5, 1));
    refused("zone 1 by zone 2's keeper: sell", &|| sell_as(5, 1));
    w.place(me, RC_OTHER_ZONE, ex, ey + 1);
    bought("zone 2 by zone 2's keeper", 3, 10);
    sold("zone 2 by zone 2's keeper");

    // `buy` needs the keeper of the NAMED shop. Beside shop 4's keeper (home (-60, 70),
    // reach 4): shop 3 is refused, shop 4 sells at its own price, `sell` is served; one
    // tile further, shop 4 is refused too.
    let (yx, yy) = RC_Y_HOME;
    w.place(me, RC_ZONE, yx + 3, yy - 1);
    refused("by shop 4: buy from 3", &|| buy_as(3, 5, 1));
    bought("by shop 4: buy from 4", 4, 99);
    sold("by shop 4: sell");
    w.place(me, RC_ZONE, yx + 3, yy - 2);
    refused("past shop 4: buy from 4", &|| buy_as(4, 5, 1));
    refused("past shop 4: sell", &|| sell_as(5, 1));
    // Beside shop 3's keeper: shop 4, and shop 9 that no NPC offers, are refused.
    w.place(me, RC_ZONE, hx + 1, hy);
    refused("by shop 3: buy from 4", &|| buy_as(4, 5, 1));
    refused("by shop 3: buy from 9", &|| buy_as(9, 5, 1));
    bought("by shop 3: buy from 3", 3, 10);

    // `sell` needs a shop keeper: a `Dialogue` NPC or a `Heal(1)` NPC is not one.
    let (tx, ty) = RC_TALKER_HOME;
    w.place(me, RC_ZONE, tx + 1, ty);
    refused("by a Dialogue NPC: sell", &|| sell_as(5, 1));
    refused("by a Dialogue NPC: buy", &|| buy_as(3, 5, 1));
    let (lx, ly) = RC_HEALER_HOME;
    w.place(me, RC_ZONE, lx, ly - 2);
    refused("by a Heal(1) NPC: sell", &|| sell_as(5, 1));
    refused("by a Heal(1) NPC: buy from 1", &|| buy_as(1, 5, 1));

    // No `character` row (the `player` row stays): the same refusal.
    assert_eq!(
        w.chars.remove(ec_entity(me)),
        1,
        "fixture: the caller's character"
    );
    refused("no character: buy", &|| buy_as(3, 5, 1));
    refused("no character: sell", &|| sell_as(5, 1));
    w.place(me, RC_ZONE, hx, hy);
    bought("a character again: buy", 3, 10);
    sold("a character again: sell");

    // The reach check comes before every later guard.
    let live = battle(1, me, crate::WILD_IDENTITY, BattleOutcome::Ongoing);
    battles.seed(&live);
    reach_first(
        "in an ongoing battle: buy",
        &|| buy_as(3, 5, 1),
        "cannot buy during an ongoing battle",
    );
    reach_first(
        "in an ongoing battle: sell",
        &|| sell_as(5, 1),
        "cannot sell during an ongoing battle",
    );
    assert_eq!(battles.remove(me), 1, "fixture: the one battle row");
    reach_first("qty 0: buy", &|| buy_as(3, 5, 0), "qty must be > 0");
    reach_first("qty 0: sell", &|| sell_as(5, 0), "qty must be > 0");
    reach_first(
        "an item shop 3 does not stock",
        &|| buy_as(3, 8, 1),
        "shop 3 does not stock item 8",
    );
    reach_first(
        "an unsellable item",
        &|| sell_as(8, 1),
        "item cannot be sold",
    );
    reach_first("an unknown item", &|| sell_as(404, 1), "unknown item 404");

    let balance = w.balance(me).expect("the caller's wallet");
    assert_eq!(w.wallets.remove(me), 1, "fixture: the caller's wallet");
    w.wallet(me, 9);
    reach_first(
        "9 in the wallet for a 10 purchase",
        &|| buy_as(3, 5, 1),
        "currency is in an active trade",
    );
    assert_eq!(w.wallets.remove(me), 1, "fixture: the 9 wallet");
    w.wallet(me, balance);
    w.escrow(balance - 5, 0);
    reach_first(
        "all but 5 escrowed for a 10 purchase",
        &|| buy_as(3, 5, 1),
        "currency is in an active trade",
    );
    assert_eq!(w.offers.remove(77), 1, "fixture: the currency escrow");

    w.stack(me, 6, CAP);
    let full = game_core::check_item_headroom(CAP, 1, 6)
        .unwrap_err()
        .to_string();
    reach_first("a full stack of item 6", &|| buy_as(3, 6, 1), &full);

    let held = w.count(me, 5).expect("the caller's item 5 stack");
    reach_first(
        "selling one more than held",
        &|| sell_as(5, held + 1),
        "item is in an active trade",
    );
    w.escrow(0, held);
    reach_first(
        "every held item 5 escrowed",
        &|| sell_as(5, 1),
        "item is in an active trade",
    );
    assert_eq!(w.offers.remove(77), 1, "fixture: the item escrow");

    assert_eq!(
        w.balance(ec_other()),
        Some(7),
        "a bystander is never touched"
    );
}
