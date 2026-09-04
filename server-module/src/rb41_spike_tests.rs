//! TEMPORARY rb-41 spike — deleted before the tester writes the real tests.
use crate::native_host_tests::fixture;
use crate::schema::HealCooldown;
use spacetimedb::Identity;

#[test]
fn rb41_spike_heal_cooldown_roundtrip() {
    let fx = fixture();
    let t = fx.table::<HealCooldown>("heal_cooldown", "heal_cooldown_owner_identity_idx_btree", |r| r.owner_identity);
    let ctx = fx.ctx();
    let owner = Identity::from_byte_array([41u8; 32]);
    let stranger = Identity::from_byte_array([42u8; 32]);
    assert!(!crate::raising::has_heal_cooldown(&ctx, owner), "requested: {:?}", fx.requested_indexes());
    assert!(!crate::accounts::account_has_game_data(&ctx, owner), "requested: {:?}", fx.requested_indexes());
    t.seed(&HealCooldown { owner_identity: stranger, last_heal_at_ms: 5 });
    assert!(!crate::raising::has_heal_cooldown(&ctx, owner));
    t.seed(&HealCooldown { owner_identity: owner, last_heal_at_ms: 7 });
    assert!(crate::raising::has_heal_cooldown(&ctx, owner), "requested: {:?}", fx.requested_indexes());
    assert!(crate::accounts::account_has_game_data(&ctx, owner), "requested: {:?}", fx.requested_indexes());
    assert_eq!(t.remove(owner), 1);
    assert!(!crate::raising::has_heal_cooldown(&ctx, owner));
    assert!(!crate::accounts::account_has_game_data(&ctx, owner));
    eprintln!("REQUESTED_INDEXES={:?}", fx.requested_indexes());
}
