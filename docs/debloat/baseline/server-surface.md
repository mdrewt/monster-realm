# Server public surface — Phase 0 snapshot

Distilled from the generated okf-export bundle (docs/knowledge/, generated 2026-09-19); exact column shapes are pinned by evals-baselines/table-schemas.json and spacetime-types.json.

## Tables (43)

- `account` — private
- `account_deletion_reaper_schedule` — private
- `battle` — private
- `battle_action` — private
- `battle_challenge` — public
- `battle_challenge_reaper_schedule` — private
- `battle_wild` — private
- `character` — public
- `config` — public
- `encounter` — private
- `evolution_path` — public
- `export_bundle` — private
- `export_bundle_reaper_schedule` — private
- `guest_claim` — private
- `guest_claim_reaper_schedule` — private
- `heal_cooldown` — private
- `heal_location_row` — public
- `inventory` — public
- `item_row` — public
- `monster` — private
- `monster_pub` — private
- `movement_tick_schedule` — private
- `mr_heartbeat_schedule` — private
- `npc` — public
- `pending_evolution_notice` — private
- `player` — public
- `player_conversation` — private
- `player_dialogue_state` — private
- `player_quest` — public
- `player_session` — private
- `player_wallet` — private
- `playtest_event` — private
- `playtest_reaper_schedule` — private
- `profile` — public
- `pvp_deadline_schedule` — private
- `shop_item_row` — public
- `shop_row` — public
- `skill_row` — public
- `species_row` — public
- `trade_offer` — public
- `trade_offer_reaper_schedule` — private
- `type_relation_row` — public
- `zone_def` — public

## Reducer signatures (54)

```rust
pub fn accept_challenge(
    ctx: &ReducerContext,
    challenge_id: u64,
    party_ids: Vec<u64>,
) -> Result<(), String>
```

```rust
pub fn account_deletion_reaper(
    ctx: &ReducerContext,
    args: AccountDeletionReaperSchedule,
) -> Result<(), String>
```

```rust
pub fn ack_evolution_notices(ctx: &ReducerContext, count: u32) -> Result<(), String>
```

```rust
pub fn advance_dialogue(ctx: &ReducerContext, choice_idx: u32) -> Result<(), String>
```

```rust
pub fn attempt_recruit(
    ctx: &ReducerContext,
    battle_id: u64,
    bait_item_id: Option<u32>,
) -> Result<(), String>
```

```rust
pub fn battle_challenge_reaper(
    ctx: &ReducerContext,
    args: BattleChallengeReaperSchedule,
) -> Result<(), String>
```

```rust
pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) -> Result<(), String>
```

```rust
pub fn cancel_account_deletion(ctx: &ReducerContext) -> Result<(), String>
```

```rust
pub fn cancel_challenge(ctx: &ReducerContext, challenge_id: u64) -> Result<(), String>
```

```rust
pub fn cancel_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String>
```

```rust
pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String>
```

```rust
pub fn challenge_pvp(
    ctx: &ReducerContext,
    target: Identity,
    party_ids: Vec<u64>,
) -> Result<(), String>
```

```rust
pub fn clear_queue(ctx: &ReducerContext, seq: u64) -> Result<(), String>
```

```rust
pub fn complete_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String>
```

```rust
pub fn confirm_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String>
```

```rust
pub fn consume_crystalized_essence(
    ctx: &ReducerContext,
    monster_id: u64,
    item_id: u32,
) -> Result<(), String>
```

```rust
pub fn decline_challenge(ctx: &ReducerContext, challenge_id: u64) -> Result<(), String>
```

```rust
pub fn delete_account(ctx: &ReducerContext) -> Result<(), String>
```

```rust
pub fn dismiss_dialogue(ctx: &ReducerContext) -> Result<(), String>
```

```rust
pub fn enqueue_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String>
```

```rust
pub fn essence_train(
    ctx: &ReducerContext,
    monster_id: u64,
    affinity: Affinity,
) -> Result<(), String>
```

```rust
pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String>
```

```rust
pub fn export_bundle_reaper(
    ctx: &ReducerContext,
    _sched: ExportBundleReaperSchedule,
) -> Result<(), String>
```

```rust
pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String>
```

```rust
pub fn grant_bait(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String>
```

```rust
pub fn guest_claim_reaper(
    ctx: &ReducerContext,
    args: GuestClaimReaperSchedule,
) -> Result<(), String>
```

```rust
pub fn heal_party(ctx: &ReducerContext, location_id: u32) -> Result<(), String>
```


```rust
pub fn init(ctx: &ReducerContext)
```

```rust
pub fn join_game(ctx: &ReducerContext, name: String) -> Result<(), String>
```

```rust
pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String>
```

```rust
pub fn mr_heartbeat(ctx: &ReducerContext, _sched: MrHeartbeatSchedule) -> Result<(), String>
```

```rust
pub fn on_connect(ctx: &ReducerContext) -> Result<(), String>
```

```rust
pub fn on_disconnect(ctx: &ReducerContext)
```

```rust
pub fn playtest_reaper(ctx: &ReducerContext, _sched: PlaytestReaperSchedule) -> Result<(), String>
```

```rust
pub fn propose_trade(
    ctx: &ReducerContext,
    counterparty: Identity,
    initiator_monster_ids: Vec<u64>,
    initiator_items: Vec<TradeItem>,
    initiator_currency: u64,
    counterparty_monster_ids: Vec<u64>,
    counterparty_items: Vec<TradeItem>,
    counterparty_currency: u64,
) -> Result<(), String>
```

```rust
pub fn pvp_deadline_reaper(ctx: &ReducerContext, args: PvpDeadlineSchedule) -> Result<(), String>
```

```rust
pub fn request_data_export(ctx: &ReducerContext) -> Result<(), String>
```

```rust
pub fn respond_trade(ctx: &ReducerContext, trade_id: u64, accepted: bool) -> Result<(), String>
```

```rust
pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String>
```

```rust
pub fn set_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String>
```

```rust
pub fn set_nickname(ctx: &ReducerContext, monster_id: u64, nickname: String) -> Result<(), String>
```

```rust
pub fn set_party_slot(ctx: &ReducerContext, monster_id: u64, slot: u8) -> Result<(), String>
```

```rust
pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String>
```

```rust
pub fn start_battle(
    ctx: &ReducerContext,
    opponent_identity: Identity,
    party_monster_ids: Vec<u64>,
    opponent_monster_ids: Vec<u64>,
) -> Result<(), String>
```

```rust
pub fn start_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String>
```

```rust
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String>
```

```rust
pub fn submit_attack(ctx: &ReducerContext, battle_id: u64, skill_id: u32) -> Result<(), String>
```

```rust
pub fn submit_pvp_action(
    ctx: &ReducerContext,
    battle_id: u64,
    action: PvpAction,
) -> Result<(), String>
```

```rust
pub fn swap_active(ctx: &ReducerContext, battle_id: u64, team_index: u32) -> Result<(), String>
```

```rust
pub fn sync_content(ctx: &ReducerContext) -> Result<(), String>
```

```rust
pub fn talk(ctx: &ReducerContext, npc_entity_id: u64) -> Result<(), String>
```

```rust
pub fn trade_offer_reaper(
    ctx: &ReducerContext,
    args: TradeOfferReaperSchedule,
) -> Result<(), String>
```

```rust
pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String>
```

```rust
pub fn use_battle_item(ctx: &ReducerContext, battle_id: u64, item_id: u32) -> Result<(), String>
```
