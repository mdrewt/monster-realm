# Economy tuning: where each number lives and what holds them together

This is the worksheet for whoever retunes a price, a reward or the starter kit. It names every
faucet and sink, the file and field that holds its number, and the reasoning that ties the numbers
together. It copies no value: each relation below is a test over the shipped content, named here,
so a retune that breaks the reasoning fails that test. The tests are in
`game-core/tests/pt_d3_tuning.rs` unless a line says otherwise.

## Stance

The economy is not a major part of the game. Items, prices and rewards are balanced as in a
single-player game: every number must feel fair to one player with nobody to trade with. A rule
that exists only for a shared economy is an exception, and it is named as one (see "Shared-economy
caveat").

## Faucets

| Faucet | Paid | Number lives in |
|---|---|---|
| Starter kit | once per identity, at the first join | `game-core/content/starter_kit.ron` (`currency`, `items`) |
| Wild KO | each wild the player's side knocks out in a wild battle, paid when the battle ends | `battle_currency_reward` (`game-core/src/currency.rs`): the victim species' base-stat total over `BATTLE_CURRENCY_BST_DIVISOR` |
| Quest reward | once per identity per quest | `reward.currency` in `game-core/content/quests/` |
| Selling an item | per item sold | `sell_price` in `game-core/content/items/` |

A recruited wild pays nothing: the monster is the reward
(<https://github.com/mdrewt/monster-realm/issues/587>, D1). The wilds knocked out earlier in the
same battle still pay. The recruit-win cases in `server-module/src/tactics_settle_tests.rs` prove
both halves. Practice and PvP battles pay no currency (`game-core/src/tactics/rewards_tests.rs`).

## Sinks

| Sink | Number lives in | State |
|---|---|---|
| Shop purchases | `buy_price` in `game-core/content/shops/` | the only live currency sink |
| Healing | `cost_currency`, `cost_item_id`, `cost_qty` in `game-core/content/heal_locations/` | inert: every location is free |
| Monsters | none | no mechanic consumes a monster |

A price counts only in a shop a player can open: one that an NPC names with
`interaction: Shop(id)` in `game-core/content/npcs/`. The tests read prices from those shops alone,
so a shop no NPC opens cannot make a relation pass.

**Healing is free.** `heal_party` (`server-module/src/raising.rs`) charges whatever a heal location
names, so the price is data, and the shipped data names none. Under the stance a heal charge is a
sink against one player's faucet, and it taxes losing. `shipped_heal_locations_charge_nothing`
fails when any location names a currency cost, a cost item or a cost quantity. It destructures the
whole `HealLocationDef`, so a cost field added later stops it compiling until someone decides what
"free" means for that field. The design doc's economy section (GDD §7) lists a town healing cost
as a sink; that line is not in force.

**There is no monster sink.** Recruiting only adds monsters; nothing removes one
(<https://github.com/mdrewt/monster-realm/issues/587>, D4). Read every number here with that gap
in mind: monster supply is unbounded, and no price can depend on monsters being scarce.

## The relations a retune must keep

| Relation | Numbers it reads | Test |
|---|---|---|
| The kit's currency alone buys one Lure Berry | kit `currency`; the Lure Berry's lowest reachable `buy_price` | `starter_kit_currency_buys_one_lure_berry` |
| Healing charges nothing | every heal location's three cost fields | `shipped_heal_locations_charge_nothing` |
| Recruit-heavy play in zone 0 earns a Lure Berry within the battle budget | zone 0 `pack_weights`; zone 0 encounter `weight`s and their species' base stats; the divisor; the Lure Berry's price; `LURE_BERRY_BATTLE_BUDGET` in the test | `recruit_heavy_zone0_battles_buy_a_lure_berry_within_15` |
| Every battle-usable item is for sale at or below its shop's median price | `game-core/content/tactics_items/`; shop `buy_price`s | `every_battle_usable_item_sells_at_or_below_its_shop_median` |
| Buying and reselling never profits; every status cure is stocked | `sell_price`; `buy_price` | `pt_d3_5_cures_stocked_and_arbitrage_free` |
| No price is out of reach of battle income | `buy_price`; the best-paying wild's KO reward | `pt_d3_content_sanity_bands` |
| quest_001 pays its shipped reward, once | `reward.currency` | `m12c_quest_defs_parity_snapshot` (`game-core/src/content.rs`); `nh_quest_complete_grants_exactly_the_content_currency_reward` (`server-module/src/npc_tests.rs`); `client/e2e/dialogue.spec.ts` and `client/e2e/wallet-balance.spec.ts` |

## Gold per loop against the sinks

One KO pays `battle_currency_reward` of the victim's base-stat total. A wild battle fields a pack
whose size is rolled from the zone's `pack_weights` and then clamped to the number of conscious
monsters in the player's party (`effective_pack`, `game-core/src/tactics/encounter.rs`).

- **Win everything:** the battle pays one KO per wild in the pack.
- **Recruit-heavy** (every battle ends in a recruit, the rest of the pack knocked out): the battle
  pays one KO fewer than the pack. A lone wild pays nothing.

Battles to afford a shop item are its `buy_price` over the loop's expected gold per battle. To
place a new price, work that out for the cheapest and for the median reachable price (the median as
`every_battle_usable_item_sells_at_or_below_its_shop_median` computes it: the sorted prices' lower
middle). The win-everything loop bounds every price through `pt_d3_content_sanity_bands`. The
recruit-heavy loop is the slow one, and it is the loop the game is built around, so it carries its
own budget: `recruit_heavy_zone0_battles_buy_a_lure_berry_within_15` takes zone 0's pack roll over
every per-mille outcome, pays each KO at the reward of the encounter table's spawn-weighted mean
base-stat total, and requires the budget's worth of battles to cover the Lure Berry's price.

**That budget assumes a full party:** at least `MAX_PACK` conscious monsters. The pack clamp makes
a smaller party earn less from recruit-heavy play:

| Conscious party | Packs it meets | Recruit-heavy KOs per battle |
|---|---|---|
| one | lone wilds only | none |
| two | one or two wilds | the share of rolls above a lone wild |
| `MAX_PACK` or more | the full `pack_weights` roll | as the test computes |

A fresh player has one monster, so their first recruits pay nothing in gold. The kit's Lure
Berries and its currency (which buys another) carry those first recruits, and quest_001 pays once
on top. The battle loop takes over as the party grows.

**The quest is the recruit loop's faucet.** Because a recruit pays nothing, a player who mostly
recruits earns less from battles than one who mostly fights. Quest rewards make up the difference:
they pay for play that is not knocking wilds out. One quest ships; its reward is content, and the
server credits exactly what the content names.

## Battle items: a price for the flat AP cost

Using an item in a tactical battle costs the same AP whatever the item is (`item_cost`,
`game-core/content/tactics_tuning.ron`). A flat cost is fair only while each use also costs the
player something outside the battle (feedback item pt3-2026-10-145). Two things do that: the item
is used up, and it has to be bought. `every_battle_usable_item_sells_at_or_below_its_shop_median`
keeps the second half honest: every row of `game-core/content/tactics_items/` must be for sale, in
a shop a player can open, at a price above zero and no higher than that shop's median. An item
that becomes battle-usable without a shop price, or at a luxury price, fails it.

## Judgement calls no test pins

- **quest_001's reward is meant to cover the cheapest shop item.** Nothing ties the two numbers.
  When either moves, re-read the other.
- **Sell price is a fixed fraction of buy price** by convention (the comments in
  `game-core/content/shops/` state it). The test only requires selling below buying.
- **The kit's item list.** Its exact contents are pinned by the shipped-kit snapshot test beside
  `validate_starter_kit` (`game-core/src/content.rs`) and by the first-join tests in
  `server-module/src/onboarding_tests.rs`; the grant rule is "The starter is a once-per-identity
  grant recorded by a marker; ownership is never the test" in `docs/DECISIONS.md`.

## Shared-economy caveat

The kit and each quest reward are paid once per identity, and both are ordinary tradeable gold and
items. On a server that admits anonymous identities, a throwaway identity can join, finish the
quest, and hand its kit and reward to another identity through a trade. In a single-player world
or among friends that is harmless. Raising the kit or a quest reward raises what each throwaway
identity is worth, so before a server we operate opens to strangers, either trading requires an
account on both sides or these payouts become untradeable.

## Retuning

1. Edit the content file. Any edit under `game-core/content/` needs `CONTENT_VERSION`
   (`server-module/src/lib.rs`) bumped and `evals/baselines/content-hash.json` re-recorded with
   the command the `content-version` eval prints.
2. Run `cargo nextest run -p game-core --test pt_d3_tuning`. A red test names the field to move
   and this file.
3. A change to a quest reward or the kit also moves the snapshot tests and the two e2e specs named
   in the table above.
4. If the reasoning itself changes (a heal charge, a recruit payout, a monster sink), change the
   test and this file in the same commit, and the entry "Healing is free, and quests are the
   recruit loop's faucet" in `docs/DECISIONS.md`.
