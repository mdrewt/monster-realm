---
title: "BitCraft Online — Reference Game Design Document"
slug: bitcraft-online-gdd
domain: gameplay
tags: [mmo, sandbox, spacetimedb, crafting, settlements, empires, player-economy, server-architecture, gdd-reference]
status: active
updated: 2026-11-06
confidence: medium
sources: 31
supersedes:
abstract: "Reconstructed GDD for BitCraft Online (2025 EA sandbox MMO on SpacetimeDB); design systems + server architecture."
---

# BitCraft Online — Reference Game Design Document

> **Provenance note.** This is a *reconstructed* GDD: Clockwork Labs has not published a
> real design document, so this was assembled (2026-11-06) from the Steam page, the
> official site and dev blog, the community wiki, press coverage, and — uniquely for this
> library — the game's own open-sourced server module
> (`github.com/clockworklabs/BitCraftPublic`). Claims marked **[repo]** were verified in
> that source code and are high-confidence. Anything unverified is marked
> **UNCONFIRMED**; a gap ledger is at the end. Numbers are Early Access snapshots that
> patches change often. This doc exists as a reference for monster-realm, which shares
> BitCraft's backend (SpacetimeDB) — section 11 is deliberately the deepest.

## 1. Overview

| | |
|---|---|
| **Title** | BitCraft Online |
| **Developer / publisher** | Clockwork Laboratories, Inc. (San Francisco) — also the makers of SpacetimeDB itself |
| **Release** | Steam Early Access June 21, 2025 (a surprise early launch; June 27 was planned). Playtests since 2022; Closed Alpha 2 July 2024; "Early Access 2 — A New World" Feb 27, 2026 |
| **Platforms** | Windows (Steam). Others UNCONFIRMED |
| **Price** | $29.99 at EA launch → cut to $15.99 at EA2; stated plan is free-to-play at 1.0 ("could change", possibly a subscription) |
| **Genre** | Single-world sandbox community MMO: survival-lite PvE, gathering/crafting, town building, terraforming, player economy. Steam tags include "Cozy", "Idler", "Incremental" |
| **Backend** | SpacetimeDB (Clockwork's own database-is-the-server engine); Rust server module, Unity client |
| **Reception** | ~71% "Mostly Positive" (~2,650 reviews); ~100,000 copies sold in EA; all-time Steam peak ~4,400 concurrent, mid-2026 lows ~500–750 |
| **Scope anchor** | ~150 server tables, 200+ player-action reducers, 20 scheduled server agents **[repo]** |

**High concept.** One persistent, procedurally generated, "functionally infinite" world
shared by every player — no shards, no servers to pick. Players level 18+ professions,
terraform hex terrain, found settlements that other players depend on, and (optionally)
run empires that fight over territory. The bet: the real content of an MMO is *other
players' interdependence*, so make distance, specialization, and logistics matter and
the players will generate the content themselves.

## 2. Design pillars

1. **One world, and distance has meaning.** Everyone plays in the same world. Travel
   time, hauling costs, and regional goods make geography a real constraint, which makes
   local communities and trade routes matter. The game director calls this a core pillar.
2. **Interdependence over self-sufficiency.** 12 professions plus tier-gated crafting
   mean no one reaches high tiers alone. Deliberately fewer settlements than players, so
   settlements become social and trading hubs ("a symbiotic relationship between
   character scale and settlement scale" — Letter from the Producer).
3. **The world is fully editable.** Terrain is millions of hexagonal pillars whose
   height players change via terraforming sites. Anti-grief is built into the physics:
   pushing terrain away from its natural state is slow, restoring it is fast.
4. **Slow, cozy, long-horizon progression.** Skills grow over months or years. Actions
   are click-driven and tick-based (hence the "Idler/Incremental" tags). Top specialists
   get community recognition (titles, outfits) rather than power spikes.
5. **Three nested scales.** Character (grind and specialize), settlement (build the hub
   that gates everyone's crafting tier), empire (prestige-only territorial competition).
   Empire rewards are deliberately capped so the competitive layer never dominates the
   cozy layers.
6. **PvE-first; conflict is channeled, not open.** No open-world PvP. Duels are opt-in.
   Direct conflict is routed into empire sieges, economic competition between towns, and
   racing for resource-rich land.

## 3. World design

- **Terrain.** The world is built from millions of hexagonal pillars. Terraforming
  raises or lowers pillar height through a dedicated "terraforming site" building, so
  rivers can be redirected and hills flattened for towns.
- **Generation.** Procedural, described as functionally infinite; fields, mountains,
  valleys, and ruins of past civilizations. The world is spatially partitioned into
  server regions (see §11.2), which the devs say "unlocks near-infinite scaling of
  player count and world size" (Beta 1 patch notes).
- **No developer towns.** There are no central hub cities. Ruined towns act as public
  hubs where **Traveler** NPCs give newcomers basic amenities and paid tasks.
- **Hexite.** The central region of the map has "strange phenomena" tied to Hexite
  Energy — the resource that (post-EA2) fuels empire upkeep and buffing shrines, which
  pushes empires to compete over specific land.
- UNCONFIRMED: exact world dimensions, biome roster, seasons/day-night presentation
  (a `day_night` agent exists server-side **[repo]** but its init is not wired in).

## 4. The three scales

The whole game is structured as three progression layers that feed each other:

| Scale | Who | Core loop | Reward style |
|---|---|---|---|
| **Character** | Every player | Gather → craft → level professions | Levels, titles (every 10), outfits (every 20), tool tiers |
| **Settlement** | Groups (or ambitious solos) | Claim land → build stations → keep supplies stocked | Claim tiers gate crafting tiers; towns earn game-generated currency when visitors use their facilities |
| **Empire** | Large organized groups | Claim territory with watchtowers → logistics → sieges | Prestige, cosmetics, fame — deliberately *not* power |

The key design trick: **settlement tier gates crafting tier** (you cannot place a tier-3
station on a tier-1 claim), so individual progression is impossible without communal
infrastructure. And settlement income is "generated directly by the game (not taken from
other players)", so towns compete for *residents and visitors*, not against each other's
wallets — a positive-sum competitive layer under a zero-sum prestige layer (empires).

## 5. Professions, skills, and tiers

**12 professions** (wiki): gathering — Foraging, Hunting, Mining, Farming, Fishing,
Forestry; crafting — Carpentry, Leatherworking, Masonry, Smithing, Tailoring; both —
Scholar. **Plus 6 "skills"**: Cooking, Construction, Merchanting, Slayer (combat),
Taming, Sailing.

- **Leveling.** Doing an action grants XP in its profession. Levels can pass 100, but
  there is no new content beyond 100 — the long tail is pure recognition. Titles every
  10 levels; profession outfits unlock in the Vault every 20.
- **Tiers.** Every material tier requires the previous tier to craft. Higher-tier tools
  need higher profession levels but have more tool power, which speeds up each action
  tick. **Scholar** drives tier advancement, with knowledge found mainly in ancient
  ruins — so exploration feeds the crafting ladder.
- **Onboarding fix (EA2).** XP for levels ≤25 was cut and per-profession intro quests
  added, after grind complaints (see §12).
- UNCONFIRMED: the exact tier count (often cited as 10) and XP curve numbers.

## 6. Claims and settlements

- **Claiming.** Place a Claim Totem. The wiki lists a Writ of Settlement Foundation from
  the Traveler Rumbagh at 5,000 Hex Coins + 10 Codices (may have changed since).
- **Upkeep.** Claims drain **Supplies** continuously: 0.4 per hex per hour up to 100
  hexes, 0.5 beyond. If supplies run out, the claim turns public — anyone can use it,
  loot containers, and deconstruct buildings. Upkeep is the anti-land-hoarding tool:
  active towns easily afford it; absentee claims decay back into the commons.
- **Tiers.** Claim tier is unlocked with Codices (not refunded on deconstruction) and
  caps the tier of crafting stations inside — the lynchpin coupling of §4.
- **Ownership is absolute while maintained.** "If you own a claim and maintain it,
  nobody else can alter anything in it" (official blog). This is the core anti-grief
  guarantee; there is no theft from maintained claims.
- **Open facilities.** Non-members can use a settlement's public stations, markets, and
  (per-bank) storage — that usage is what earns the town its income.
- UNCONFIRMED: the member role/permission matrix.

## 7. Empires and territorial conflict

- **Territory** is held by **watchtowers** (each includes a small neutral claim; cannot
  be placed near other claims or ruins).
- **Sieges.** Attackers craft **Hexite Capsules** in capital Foundries, haul one to the
  enemy watchtower, and feed the **Hexite Cannon**. The cannon slowly spends the
  capsule's energy against the tower's shield; if the attacker's energy runs out first,
  the defense holds (leftover defensive energy banks into the tower, capped at 10k).
  Long supply lines are the real cost — "the farther the empire extends, the more
  logistics are needed." Direct attacker-vs-defender combat during sieges is only
  "under consideration".
- **Rewards are prestige-only.** No power bonuses from territory; large empires get
  cosmetics, emotes, titles, and territory-entry fanfare. Systems deliberately favor
  new empires and challenge incumbents; empires can reportedly be usurped from within.
- **The monetization U-turn** (important lesson): Hexite Capsules — i.e., territorial
  attack/defense — originally cost premium currency. After sustained backlash, the
  Feb 2026 "Empires are changing" post removed real money from founding, expanding,
  maintaining, and fighting over territory entirely; EA2 moved empire upkeep to
  world-gathered Hexite Energy, which also powers optional buffing shrines on specific
  land (creating a PvE-flavored territorial race).
- UNCONFIRMED: taxes, ranks, and the exact post-EA2 siege rules.

## 8. Economy and trade

- **Hex Coins** (soft currency) enter the economy mainly through **Traveler tasks**:
  NPC-posted jobs that reset globally every 4 hours and pay coins + XP in one skill
  (e.g. Rumbagh's level 1–30 tier pays 250 coins + 1,000 Merchanting XP; the 40–60 tier
  pays up to 1,100). Each Traveler maps to one skill (Svim→Sailing, Heimlich→Cooking,
  Brico→Construction, Alesi→Taming, Ramparte→Slayer).
- **Markets are physical and local.** No global auction house. Each market building has
  its own order book (sell orders; lowest listing shown first), and each bank has a
  separate inventory. Rare goods can be region-specific, so arbitrage requires actual
  trade runs — the economy is deliberately coupled to the travel/logistics system.
- **Hauling is the friction that makes trade a profession.** Teleporting via waystones
  costs Teleport Energy scaling with distance *and inventory weight*, so bulk goods
  move by cart, wagon (Construction 20), boat, or mount (high Taming). The devs keep
  rebalancing to kill "cheese" transport and keep hauling meaningful.
- **Sinks**: claim writs and supplies, Codices, construction. The devs state they design
  so coins/items can't be straightforwardly converted into XP (anti-RMT stance).
- **Hexite Shards** (premium) are *tradable*, so premium currency can flow to
  non-paying players through the economy (see §10).
- EA2 added storehouses and exchange buildings and raised stack limits — quality-of-life
  for an economy that lives on moving goods.

## 9. Moment-to-moment play

- **Loop.** Walk (click-to-move; right-mouse-hold steering) → gather/craft via
  tick-based actions whose speed scales with tool power → queue passive crafts at
  stations and collect later → haul output to storage/market → take Traveler tasks for
  coins. It is deliberately low-APM; the texture is closer to a cozy incremental game
  than an action MMO.
- **Survival pressure** is mild: food/hunger exists (a `starving` server agent and
  `player_regen`/`environment_debuff` agents are in the code **[repo]**), hostile
  creatures ambush explorers and threaten settlements, but the game is explicitly
  pitched to cozy players too. Sprint/stamina friction was removed mid-EA (run is now
  the default speed).
- **Combat** is basic by design: a stat system rework, buffs/effects, the Slayer skill,
  and small dungeons arrived during EA; AoE, enemy phases, and threat mechanics are
  "planned". PvE only, plus opt-in duels (used by players for tournaments).
- **Death.** Reaching zero HP = ~1 minute knockout, then respawn in place or travel home
  at an energy cost, plus a short stacking "knocked out" debuff that slows actions. No
  item loss, no corpse runs — consistent with the cozy positioning.
- **Travel.** Waystones must be discovered before use; teleport cost scales with
  distance and carried weight (home teleport is a flat 1 point). Carts can be "vaulted"
  (despawned to safety) and summoned, and can't be stolen.

## 10. Monetization and business model

- **Model:** paid Early Access ($29.99 → $15.99) with a stated plan to go F2P at 1.0
  (hedged: "could change", possibly subscription). Stated reasons for charging during
  EA: Steam featuring, *throttling the player influx while scaling a single-world MMO*,
  and revenue.
- **Hexite Shards** (premium, tradable): empire emblems/banners/statues, empire
  character cosmetics (capes, effects), later building/pathway and character cosmetics.
  Large empires additionally get social perks (emotes, titles, chat features, fanfare).
- **Red lines** (stated): no crypto/NFTs; no clean conversion of money → XP; and — after
  the capsule backlash — no real money anywhere in territorial power (§7).
- **Lesson:** even cosmetic-plus-logistics monetization of the *competitive* layer read
  as pay-to-win to players; the reversal cost a rework but recent goodwill coverage
  credits it.

## 11. Technical architecture on SpacetimeDB

*This section is almost entirely verified from the open-sourced server module
(`clockworklabs/BitCraftPublic`, Apache-2.0, published Jan 2026 — server only; the Unity
client stays closed over asset rights). The repo is "Phase 1": the module compiles but
the Relay, Mob Manager, and Map sidecar services ("Phase 2") are not yet public.*

### 11.1 The shape of the thing

There is no bespoke game server. The entire backend is **two Rust SpacetimeDB modules**
(crates compiled to WASM `cdylib`, pinned to `spacetimedb 2.10.0`): `game/` (deployed
once per world region) and `global_module/` (deployed once). All game state lives in
module tables; all game logic is reducers; all client I/O is subscriptions. Shared table
definitions are literally symlinked between the two crates, with a local proc-macro
crate providing `#[shared_table]` and an `Operations` derive for replication hooks.

### 11.2 Topology: one global + N regions

- The "one world" is **sharded across many SpacetimeDB databases**: one global module
  plus N region modules (`bitcraft_region_*`) arranged in a square grid —
  `init_region_info` requires `region_count` to be a perfect square and derives each
  region's chunk offset from its index **[repo]**. Production ran ~9 regions per a dev
  podcast; a community mirror observed 14. 
- **Why:** each SpacetimeDB database is "currently limited in size to fitting in-memory
  on a single machine", so the world is partitioned "on top of SpacetimeDB, not inside
  it" (official post).
- **Cross-region communication is tables, not RPC.** Each module has a public
  `InterModuleMessage` table (versioned `_v2`…`_v5`) with an auto-inc id and a
  recipient; receivers track `last_processed_message_id` in a counter table (sender
  numbering + receiver dedup); failures land in an `InterModuleMessageErrors` table.
  Payloads are a versioned `MessageContents` enum (`TransferPlayerRequest`,
  `EmpireCreate`, `TableUpdate`, …) with `From<V4>` upgrade impls **[repo]**. A Relay
  sidecar (not yet open) ferries rows between databases.
- **Region handoff.** `player_region_crossover` verifies the player is in the Overworld
  within a crossover distance of a region edge with a live neighbor, then sends a
  `TransferPlayerMsg` (equipment presets, task credits, etc.) targeting a point 2 tiles
  past the edge **[repo]**.
- **Ownership-tagged replication:** shared tables carry an ownership direction — e.g.
  `UserModerationState` is global-owned and pushed to regions; `UserState`,
  `ClaimState`, `ClaimMemberState` are region-owned and collected globally **[repo]**.

### 11.3 Data model: ECS-style narrow tables

- An entity is just `entity_id: u64`. Each aspect is its own narrow public table keyed
  by that id: `HealthState`, `LocationState`, `MobileEntityState`, `InventoryState`,
  `BuildingState`, `ClaimState`, … (~150 tables total, ~130 public) **[repo]**.
- Naming convention: `*_state` = runtime data, `*_desc` = static design data
  (`item_desc`, `cargo_desc`, `parameters_desc`), imported by dedicated import reducers.
  **All tuning numbers live in data tables, not code.**
- Spatial key: `chunk_index` is **denormalized onto every hot table**
  (`location_state`, `mobile_entity_state`, resources), with btree indexes on it and a
  composite `[x, z, chunk_index]` index — the backbone of chunk-scoped client
  subscriptions and server queries **[repo]**.
- Performance archaeology in the comments: fields ordered by decreasing size "to take
  advantage of a serialization fast-path"; `MobileEntityState` is `#[repr(C)]`,
  hand-padded, and `const`-asserted to be exactly 48 bytes; `LocationState` asserted at
  32; and a warning — "DO NOT add dimension index — it leads to massive perf
  degradation" **[repo]**.

### 11.4 Reducers: one per player action, server-authoritative

- Granularity is **one reducer per verb**: 200+ handler files grouped by domain folders
  (`player/`, `player_craft/`, `player_trade/`, `claim/`, `buildings/`, `empires/`,
  `queue/`, plus `admin/`, `dev/`, `cheats/`, `migration/`) **[repo]**.
- Every reducer returns `Result<(), String>` and front-loads validation — the official
  post's stated pattern: permission checks are asserts at the top; any failure rolls
  back the whole transaction, which "removes partial-failure bugs" (their example:
  trade-based item duplication is impossible by construction).
- **Identity:** the client never names its own entity. `actor_id(ctx)` resolves the
  acting entity from `ctx.sender`; roles via `has_role(ctx, ctx.sender(), Role::Gm)`;
  server-only reducers call `ServerIdentity::validate_server_or_admin` **[repo]**.
- **Connection lifecycle:** `identity_connected` rejects blocked/unknown identities
  (the login queue lives outside the connect hook); policy is *newest connection wins*;
  `identity_disconnected` signs out only if the disconnecting socket is still the
  current one — guarding against a stale socket killing a fresh session **[repo]**.

### 11.5 Scheduled agents: the world's heartbeat

All simulation is **scheduled reducers** ("agents") — 20 in the region module
(`resources_regen`, `player_regen`, `starving`, `growth`, `building_decay`, `npc_ai`,
`auto_logout`, `teleportation_energy_regen`, `rent_collector`,
`player_housing_income`, `environment_debuff`, `day_night`, …) and 3 in the global
module (`empire_decay`, `empire_siege`, `chat_cleanup`) **[repo]**. The pattern:

```rust
#[spacetimedb::table(accessor = resources_regen_loop_timer,
    scheduled(resources_regen, at = scheduled_at))]
pub struct ResourcesRegenLoopTimer {
    #[primary_key] #[auto_inc] pub scheduled_id: u64,
    pub scheduled_at: spacetimedb::ScheduleAt,
}
```

- Tick intervals come from `parameters_desc` rows (admin reducers can retune them live).
- Every tick is double-guarded: reject non-server callers, and early-return unless a
  `Config.agents_enabled` flag is set — with `stop_agents` / `start_agents` admin
  switches (and a warning that force-starting "MAY CAUSE AGENTS TO GET DUPLICATED").
- Resource respawn is throttled and randomized: only below 95% of a `world_target`,
  ~10% of the deficit per tick, spots via `ctx.rng()`, skipping claimed tiles via a
  precomputed occupancy set **[repo]**.
- Player-facing timers (passive crafting) are *not* per-item scheduled rows: queue /
  process / collect reducers plus timestamps, with the client collecting results.

### 11.6 Movement: validated intent, tolerant enforcement

- The client sends a `PlayerMoveRequest` — origin, destination, timestamp, duration,
  move type — i.e. a declared straight-line segment, never a raw position write.
- The server resolves the actor, checks incapacitation, checks terrain/elevation via a
  chunk cache, then (for non-GMs) validates the timestamp, the move geometry, and speed
  against terrain/water/paving multipliers **[repo]**.
- **A speed violation is a strike, not a rejection** (`move_validation_strike`) —
  tolerance for clock jitter and lag, with enforcement at the pattern level.
- The accepted segment (origin, destination, timestamp) is written to
  `mobile_entity_state`, which is exactly what other clients need to *interpolate* the
  mover — the table layout is the netcode.
- Honest warts in the code: climb/swim validation is commented out ("TODO: enable this
  at some point"), and GMs bypass the speed checks entirely.

### 11.7 Client and subscriptions

- Unity/C# with generated SpacetimeDB bindings (only types reachable from tables or
  reducers are generated). The client is closed; exact subscription queries are
  UNCONFIRMED, but the pervasive `chunk_index` columns make chunk-filtered
  subscriptions (`WHERE chunk_index IN (…)`) the evident design — visibility is
  controlled by subscription filters, not table privacy, since ~130/150 tables are
  public.
- No official client-prediction story; the origin/destination/timestamp model suggests
  optimistic local movement + interpolation of others, with the strike system (not
  position snapping) as the corrective.
- A third-party mirror observed production speaking Brotli-compressed BSATN over ~14
  WebSocket sessions (one per region DB) — community claim, not official.

### 11.8 Operational lessons visible in the code

- A `migration/` folder of one-shot fixup reducers (`migrate_equipment_slots`,
  `migrate_achievements`, …) plus versioned tables (`deployable_state_v2`) and
  versioned message enums: **schema evolution happened in place, by explicit migration
  reducers and side-by-side table versions, not by wipes** **[repo]**.
- Live redeploys while clients stay connected are a stated, used capability.
- The hand-tuned row layouts and banned indexes show where single-machine in-memory
  scale actually bit them: serialization and hot-loop table scans.

## 12. Live-ops timeline and lessons

| When | What | Lesson |
|---|---|---|
| 2022–2024 | Playtests; Alpha 2 (Jul 2024) ships Empires | Competitive layer added *late*, on top of a proven cozy core |
| Apr–Jun 2025 | Open-sourcing announced alongside EA; EA launches early at $29.99 | "Community > company" positioning; paid EA used deliberately as a throughput throttle for a single-world launch |
| Mid–late 2025 | Mixed (→ ~71%) reviews: grind, time demand, "paying for a future F2P game"; praise for vibe/visuals; "not enough players" coverage | Single-world games *show* their population; emptiness is a visible failure mode |
| Sep 2025 | Transport overhaul direction: kill cheese routes, rebalance carts/boats/mounts, reward hauling | They defend the "distance matters" pillar even when players optimize against it |
| Feb 4, 2026 | Premium currency removed from all empire territory mechanics | Don't monetize the competitive layer, even indirectly |
| Feb 27, 2026 | EA2 "A New World": price cut to $15.99, shard bundle removed, onboarding quests, ≤25 XP cut, empire upkeep → gatherable Hexite, storehouses/exchanges; wipe (sources conflict on whether it was optional) | A paid-EA reset: cheaper, kinder opening hours, premium currency pulled further from power |

## 13. Lessons for monster-realm

**Architecture (same backend, so these transfer almost directly):**

1. **Narrow component tables keyed by `entity_id`, with the spatial key denormalized
   onto every hot table.** BitCraft's whole interest-management story is "put
   `chunk_index` on the row and filter subscriptions by it." Monster-realm's
   region/zone interest can follow the identical shape.
2. **Movement as validated intent + strike-based enforcement.** Origin, destination,
   timestamp, duration; server speed checks against terrain; violations accumulate
   strikes instead of hard-rejecting. The segment row doubles as the interpolation feed
   for other clients. This is a proven answer to the desync/rubberband class of
   problems on this exact stack.
3. **Scheduled-reducer agents with a global kill-switch.** One timer table per system,
   intervals read from a static-data table, every tick guarded by server-identity +
   an `agents_enabled` config flag. Also copy the throttled-respawn shape (target
   density, % of deficit per tick, RNG placement, occupancy exclusion) for wild monster
   spawning.
4. **`*_desc` / `*_state` split.** All tuning in static data tables imported by
   reducers — monster-realm's data-driven content pipeline has a 1:1 precedent here.
5. **Newest-connection-wins sessions** with the stale-socket sign-out guard, and
   validation-asserts-at-the-top reducers so atomicity kills dupe bugs by construction.
6. **Plan schema evolution early:** migration reducers + side-by-side versioned tables
   beat wipes, and versioned message enums with upgrade impls are how they kept
   cross-module messages compatible.
7. **Defer the heroics.** The `repr(C)` padding, size asserts, and banned indexes are
   real but only mattered at BitCraft's scale; measure first.

**Design:**

8. **Gate individual progression on communal infrastructure** (claim tier → station
   tier) if monster-realm wants players to *need* each other — it is BitCraft's single
   strongest retention coupling.
9. **Make the competitive layer prestige-only and keep money out of it.** BitCraft paid
   twice for violating this (backlash + rework).
10. **Upkeep-decay-to-public is elegant anti-hoarding** for any player-placed
    persistent structure.
11. **Faucets as NPC task boards** (Traveler tasks, global 4h reset, coin + targeted
    XP) are a simple, tunable faucet that also steers players toward underused skills.
12. **Single-world visibility cuts both ways:** a shared world advertises its own
    emptiness. Population density per visible area is a launch-sizing decision, not a
    nice-to-have.
13. **Death as knockout + stacking slow-debuff** (no loss, no corpse run) matches a
    cozy-leaning multiplayer game without making death meaningless.

## 14. Gap ledger

- Exact world dimensions, biome list, and whether day/night is player-visible.
- Tier count (commonly said to be 10) and XP/tier curve numbers.
- Claim member roles/permissions matrix.
- Post-EA2 siege rules in detail; empire taxes/ranks; usurpation mechanics.
- Market order mechanics beyond sell orders (buy orders exist as a reducer
  `order_post_buy_order` **[repo]**, so both sides exist; UI/fee details unknown).
- Food/hunger numbers (a `starving` agent exists server-side; design-side details
  weren't found).
- Production region count (9 vs 14) and players-per-module; official perf figures.
- Whether the EA2 wipe was mandatory (JP coverage says wiped; EN coverage says
  optional).
- Exact client subscription queries and prediction approach (client is closed).

## 15. Sources

**Official**
1. https://store.steampowered.com/app/3454650
2. https://bitcraftonline.com/news/letter-from-the-producer
3. https://bitcraftonline.com/news/monetization-in-bitcraft-online
4. https://bitcraftonline.com/news/empires-are-changing
5. https://bitcraftonline.com/news/bitcraft-empires-a-detailed-guide
6. https://bitcraftonline.com/news/our-thoughts-on-combat-conflict-and-griefing-in-bitcraft
7. https://bitcraftonline.com/news/bitcraft-open-sourcing-update
8. https://bitcraftonline.com/news/spacetimedb-and-bitcraft
9. https://bitcraftonline.com/blog/shaping-the-world
10. https://clockwork-labs.medium.com/answers-from-the-developers-5f6dd3cb8c3b

**Repo (primary technical source)**
11. https://github.com/clockworklabs/BitCraftPublic — esp.
    `BitCraftServer/packages/game/Cargo.toml`, `game/src/lib.rs`,
    `game/src/messages/components.rs`, `game/src/messages/inter_module.rs`,
    `game/src/agents/resources_regen.rs`, `game/src/agents/npc_ai_agent.rs`,
    `game/src/game/handlers/player/player_move.rs`,
    `game/src/game/handlers/player/player_region_crossover.rs`

**Wiki**
12. https://bitcraft.wiki.gg/wiki/Professions
13. https://bitcraft.wiki.gg/wiki/Claims
14. https://bitcraft.wiki.gg/wiki/Empires
15. https://bitcraft.wiki.gg/wiki/Travelers
16. https://bitcraft.wiki.gg/wiki/Patch_Notes/Alpha_2
17. https://bitcraft.wiki.gg/wiki/Patch_Notes/Beta_1

**Press / community**
18. https://www.pcgamesn.com/bitcraft-online/shared-world-mmorpg-out-now
19. https://monstervine.com/2025/05/bitcraft-online-early-access-open-source-announced/
20. https://automaton-media.com/articles/newsjp/20260302-425651/
21. https://mmohuts.com/news/bitcraft-kicks-off-early-access-2-with-a-big-patch-and-a-launch-week-discount
22. https://mmohuts.com/news/bitcraft-online-is-removing-premium-currency-from-empires-with-a-wipe-likely-coming
23. https://mmobomb.com/news/f2p-mmorpg-bitcraft-online-decides-community-more-powerful-together-will-make-game-open-source
24. https://mmobomb.com/news/bitcraft-upcoming-empire-system-an-interesting-form-of-monetization
25. https://www.pulse.bot/gaming/news/clockwork-labs-bitcraft-online-sells-100000-copies-in-early-access-2a1d4e83-0274-4428-953e-95cce742413a/
26. https://www.gamersunchained.com/news/bitcraft-online-game-director-outlines-major-overhaul-to-item-transportation
27. https://mein-mmo.de/en/players-pay-26-euros-for-a-free-mmorpg-on-steam-praise-the-gameplay-but-are-still-angry,1402796
28. https://www.magicgameworld.com/bitcraft-online-beginners-guide-15-essential-tips-for-getting-started/
29. https://github.com/ekscrypto/spacetimedb-bitcraft-mirror (third-party observation)
30. https://zencastr.com/z/TEsVoQVS (dev podcast transcript, undated)
31. https://spacetimedb.com/features/requests/17
