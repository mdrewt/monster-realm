//! `monster_mgmt_tests` — rb-41 gating test for the REKEY exists-predicate
//! `monster_mgmt::has_monsters`, authored from the EARS criterion R-rb-25-X9
//! (the ADR-0222 known-limit 2 residual, closed by the ADR-0224 migration to a
//! native host).
//!
//! Declared from `monster_mgmt.rs` as:
//!   `#[cfg(test)] #[path = "monster_mgmt_tests.rs"] mod monster_mgmt_tests;`
//! so `super` resolves to the `monster_mgmt` module (this file uses absolute
//! `crate::` paths throughout, so nothing here depends on that resolution).
//!
//! WHY IT EXISTS. ADR-0222's guest-claim-integrity gate could only READ the
//! predicate's source, so a HOLLOWED body — one that still performs the table
//! read but returns a value decoupled from it — passed every check. The test
//! below runs the shipped predicate against the in-memory host
//! (`native_host_tests`, ADR-0224) and pins its answer to the rows that
//! actually exist, which no source scan can do. Rows are seeded and removed
//! through the fixture handle, never through a database write path — so the
//! private-row/public-projection dual-write discipline is untouched here (this
//! file creates no projection row and no monster write of any kind).

use crate::native_host_tests::fixture;
use crate::schema::Monster;
use spacetimedb::Identity;

/// A complete private monster row owned by `owner`. Every column the EG1
/// schema declares is set explicitly so the seeded bytes decode exactly as the
/// generated reader expects; every non-identity scalar is ZERO on purpose, so a
/// predicate that additionally inspects a payload column (a level or a stat
/// above zero, ...) cannot pass on this row — `has_monsters` reads ownership and
/// nothing else.
fn rb41_owned_monster(owner: Identity, monster_id: u64) -> Monster {
    Monster {
        monster_id,
        owner_identity: owner,
        species_id: 0,
        nickname: String::new(),
        level: 0,
        xp: 0,
        iv_hp: 0,
        iv_attack: 0,
        iv_defense: 0,
        iv_speed: 0,
        iv_sp_attack: 0,
        iv_sp_defense: 0,
        nature_kind: game_core::NatureKind::Hardy,
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        stat_hp: 0,
        stat_attack: 0,
        stat_defense: 0,
        stat_speed: 0,
        stat_sp_attack: 0,
        stat_sp_defense: 0,
        current_hp: 0,
        party_slot: 0,
        last_care_at_ms: 0,
        essence_fire: 0,
        essence_water: 0,
        essence_plant: 0,
        essence_electric: 0,
        essence_earth: 0,
        essence_wind: 0,
        essence_light: 0,
        essence_dark: 0,
        trust_favorable_count: 0,
        trust_unfavorable_count: 0,
        trust_favorable_battle_day_epoch: 0,
        quality_time_ticks_total: 0,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
    }
}

/// EARS R-rb-25-X9: `monster_mgmt::has_monsters` must answer from the CURRENT
/// rows of the private monster table, for the ASKED owner — false with no row,
/// false while only a stranger owns one, true once the owner owns one, false
/// again once the owner's row is gone (while the stranger's row survives). The
/// paired `accounts::account_has_game_data` assertions pin the monster disjunct
/// of the six-way `||` chain that decides whether a guest holds game data —
/// the first disjunct, and the one `join_game` makes true for every player who
/// has ever pressed play.
///
/// kills:
///   - the ADR-0222 known-limit hollow, `{ let _ = <the monster read>; false }`:
///     the owner-row assertion goes red while every source scan stays green.
///   - the inverted hollow, `{ let _ = <the monster read>; true }`: the
///     empty-table assertion goes red.
///   - a body that answers does-the-table-hold-ANY-row instead of
///     does-THIS-owner-hold-one: the stranger-only assertion goes red, and so
///     does the post-removal assertion (the stranger's row is still there).
///   - a latched or memoised answer that never returns to false once it has
///     seen a row: the post-removal assertion goes red.
///   - deleting the monster disjunct from `accounts::account_has_game_data`:
///     the paired account assertion goes red while the direct predicate
///     assertion stays green.
#[test]
fn rb41_has_monsters_tracks_real_monster_rows() {
    let fx = fixture();
    let t = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
    let ctx = fx.ctx();
    let owner = Identity::from_byte_array([19u8; 32]);
    let stranger = Identity::from_byte_array([20u8; 32]);

    assert!(
        !crate::monster_mgmt::has_monsters(&ctx, owner),
        "has_monsters must be false for an owner with no monster: the table is empty here, so \
         a true answer means the return value is not derived from the table read"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be false while the owner owns no row in ANY REKEY table: \
         no row of any kind has been seeded yet"
    );

    t.seed(&rb41_owned_monster(stranger, 5_002));
    assert!(
        !crate::monster_mgmt::has_monsters(&ctx, owner),
        "has_monsters must stay false when the ONLY monster belongs to a different owner: the \
         predicate answers per-owner, never table-is-non-empty"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must stay false when the only seeded row belongs to a stranger: \
         a guest claim keys on the CALLER identity, not on global table population"
    );

    t.seed(&rb41_owned_monster(owner, 5_001));
    assert!(
        crate::monster_mgmt::has_monsters(&ctx, owner),
        "has_monsters must report true while the owner owns a monster; a body that reads the \
         table and then returns a constant false (the ADR-0222 known-limit hollow) fails \
         exactly here. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be true through its monster disjunct while the owner owns \
         a monster and nothing else; a deleted disjunct fails exactly here. Indexes the \
         generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        t.remove(owner),
        1,
        "the owner had exactly one monster row to remove: a different count means the seeded \
         state was not the state this test reasons about"
    );
    assert!(
        !crate::monster_mgmt::has_monsters(&ctx, owner),
        "has_monsters must return to false once the owner's last monster is gone: the answer \
         tracks live rows, so it can never latch on a row that no longer exists"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must return to false once the owner's last REKEY-table row is \
         gone: this is the state in which a guest claim is allowed to proceed"
    );
    assert!(
        crate::monster_mgmt::has_monsters(&ctx, stranger),
        "removing the owner's row must leave the stranger's monster untouched: without this \
         the negative above could be explained by an emptied table rather than by owner \
         scoping. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}
