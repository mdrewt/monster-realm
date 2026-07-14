---
type: Schema Overview
title: Monster Realm Schema Overview
slug: schema-overview
updated: 2026-07-14
tags: [schema, spacetimedb, overview]
abstract: "29-table SpacetimeDB schema for Monster Realm: public/private split (ADR-0040). 38 reducers."
source: scripts/okf-export.mjs@server-module/src/
---

## Tables

### Public (19)

- [battle](tables/battle.md)
- [battle_challenge](tables/battle_challenge.md)
- [character](tables/character.md)
- [config](tables/config.md)
- [fusion](tables/fusion.md)
- [heal_location_row](tables/heal_location_row.md)
- [inventory](tables/inventory.md)
- [item_row](tables/item_row.md)
- [monster_pub](tables/monster_pub.md)
- [npc](tables/npc.md)
- [player](tables/player.md)
- [player_quest](tables/player_quest.md)
- [shop_item_row](tables/shop_item_row.md)
- [shop_row](tables/shop_row.md)
- [skill_row](tables/skill_row.md)
- [species_row](tables/species_row.md)
- [trade_offer](tables/trade_offer.md)
- [type_relation_row](tables/type_relation_row.md)
- [zone_def](tables/zone_def.md)

### Private (10)

- [battle_action](tables/battle_action.md)
- [battle_wild](tables/battle_wild.md)
- [encounter](tables/encounter.md)
- [heal_cooldown](tables/heal_cooldown.md)
- [monster](tables/monster.md) → public projection: [monster_pub](tables/monster_pub.md)
- [movement_tick_schedule](tables/movement_tick_schedule.md)
- [player_conversation](tables/player_conversation.md)
- [player_dialogue_state](tables/player_dialogue_state.md)
- [player_wallet](tables/player_wallet.md)
- [pvp_deadline_schedule](tables/pvp_deadline_schedule.md)

## Reducers (38)

- [accept_challenge](reducers/accept_challenge.md)
- [advance_dialogue](reducers/advance_dialogue.md)
- [attempt_recruit](reducers/attempt_recruit.md)
- [buy](reducers/buy.md)
- [cancel_challenge](reducers/cancel_challenge.md)
- [cancel_trade](reducers/cancel_trade.md)
- [care](reducers/care.md)
- [challenge_pvp](reducers/challenge_pvp.md)
- [clear_queue](reducers/clear_queue.md)
- [confirm_trade](reducers/confirm_trade.md)
- [decline_challenge](reducers/decline_challenge.md)
- [dismiss_dialogue](reducers/dismiss_dialogue.md)
- [enqueue_move](reducers/enqueue_move.md)
- [evolve](reducers/evolve.md)
- [flee](reducers/flee.md)
- [fuse](reducers/fuse.md)
- [grant_bait](reducers/grant_bait.md)
- [heal_party](reducers/heal_party.md)
- [init](reducers/init.md)
- [join_game](reducers/join_game.md)
- [movement_tick](reducers/movement_tick.md)
- [on_disconnect](reducers/on_disconnect.md)
- [propose_trade](reducers/propose_trade.md)
- [pvp_deadline_reaper](reducers/pvp_deadline_reaper.md)
- [respond_trade](reducers/respond_trade.md)
- [sell](reducers/sell.md)
- [set_move](reducers/set_move.md)
- [set_nickname](reducers/set_nickname.md)
- [set_party_slot](reducers/set_party_slot.md)
- [start_battle](reducers/start_battle.md)
- [start_wild_battle](reducers/start_wild_battle.md)
- [submit_attack](reducers/submit_attack.md)
- [submit_pvp_action](reducers/submit_pvp_action.md)
- [swap_active](reducers/swap_active.md)
- [sync_content](reducers/sync_content.md)
- [talk](reducers/talk.md)
- [train](reducers/train.md)
- [use_battle_item](reducers/use_battle_item.md)
