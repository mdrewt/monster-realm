---
title: "Soulbound: Online — Reference Game Design Document"
slug: soulbound-online-gdd
domain: gameplay
tags: [mmo, roguelite, bullet-heaven, skill-progression, player-economy, housing, extraction, live-ops, gdd-reference]
status: active
updated: 2026-11-06
confidence: medium
sources: 20
supersedes:
abstract: "Reconstructed GDD for Soulbound: Online (2026 EA pixel MMO roguelite); systems + launch lessons for monster-realm."
---

# Soulbound: Online — Reference Game Design Document

> **Provenance note.** This is a *reconstructed* GDD: SpiderWare has not published a
> real design document, so this was assembled from the official press kit, the Steam
> store page, the official help site and dev blog, the community wiki
> (wiki.soulbound.game), launch press coverage, and Steam review analysis as of
> November 2026. The game is in Early Access and patches weekly, so treat all numbers
> as snapshot values. Anything not directly sourced is marked **[inferred]**. Conflicts
> between sources are called out inline. A gap ledger is at the end.

## 1. Overview

| | |
|---|---|
| **Title** | Soulbound: Online |
| **Developer / Publisher** | SpiderWare — small indie studio, London UK, founded 2021 |
| **Release** | July 21, 2026 — Steam Early Access (planned EA length: 12–18 months) |
| **Platforms** | PC via Steam. Store page lists Windows + macOS requirements; the official help site says Windows-only — conflict, likely macOS added later |
| **Price** | $14.99, one-time purchase. Steam lists "in-app purchases" (cosmetics; see §14) |
| **Genre** | Pixel-art MMO + roguelite "bullet heaven" dungeon crawler + life-sim skilling |
| **Modes** | Solo, 3-player co-op dungeons, 5–8 player raids, shared MMO overworld |
| **History** | Formerly *Worldwide Webb*, a browser/Discord blockchain MMO launched 2020 by artist/game designer Thomas Webb (crypto payments, NFT characters and land). Web3 fully removed May 2026 and the game relaunched as Soulbound: Online. 1M+ accounts claimed from the browser era. Won Discord's 2024 "Adventure Together" App Pitch |
| **Reception** | Steam "Mixed" — 59% positive of ~635 reviews at ~3.5 months. Core loop praised; server lag and bugs are the dominant complaints |
| **Scope anchor** | ~800 MB install; 100+ hours of content at EA launch; 25 dungeons across 6 tiers; 50+ handwritten quests; 500+ achievements |

**High concept.** An old-school skilling MMO (fish, mine, farm, cook, craft — think
RuneScape) welded to a Vampire Survivors-style roguelite dungeon crawler. The world is
split in two: a cozy, combat-free shared overworld where you gather, build, and trade,
and an instanced "underworld" of dungeons where all the combat lives. Your character is
permanent; your dungeon build is rebuilt from scratch every run.

## 2. Design pillars

1. **Two worlds, two moods.** The overworld is safe, social, and slow (no hostile mobs
   at all). Dungeons are fast, loud, and dangerous. The player chooses which mood they
   want minute to minute, and each side feeds the other: gathering funds crafting,
   crafting powers dungeon runs, dungeon loot funds the economy.
2. **Classless, horizontal progression.** No character level and no class picker. 14
   skills each level independently (5 combat, 5 gathering, 4 artisanal), and your
   *equipped gear and abilities* define your role (tank / healer / DPS / hybrid).
   Respec is instant between runs.
3. **The run is disposable; the account is permanent.** In-run power (relics) resets
   every dungeon. Out-of-run power (skills, gear, upgrades, base stations, account
   unlocks) only ever grows. Losing a run never deletes permanent progress.
4. **Extraction tension.** Dungeon loot is only yours once you leave through the exit
   portal. The mid-run choice between "heal now" and "bonus chest" and the quote the
   wiki uses — "sometimes the smart play is to get out with your loot" — make greed a
   mechanic.
5. **Player-run economy.** A player auction house (PixelBay) with player-set prices,
   a fixed vendor price as the floor, tradable gold, and crafting chains deep enough
   that someone can "run a blacksmith shop." The press kit calls a player-run economy
   the studio's founding goal.
6. **Readable, low-friction combat.** Bullet-heaven combat with manual, auto-aim, and
   auto-cast modes per weapon/ability, so both action players and cozy players can
   clear content. "Easy to pick up" is an explicit studio goal.
7. **Community as a system.** Weekly patches, a bug-bounty currency, a currency earned
   by editing the community wiki, creator program, and roadmap shaped by Discord/Steam
   feedback. The live community *is* part of the design.

## 3. Setting, story, and world structure

**Fiction.** The game takes place inside a vast digital reality. The player wakes with
no memory, hunted by the **Anima** — malevolent entities — and is pulled to safety by a
robotic companion. The player becomes a **Pioneer**: someone who sets up a home base on
the frontier and digs into what is lurking beneath the surface. The digital-world frame
neatly excuses game-y systems (respawns, portals, "hacking" as a gathering skill).
**[inferred]** It is also a quiet nod to the game's own past as a web game.

**Structure.** The story is chaptered ("Chapter 1" currently). The main questline is the
spine of early progression: it teaches each system, grants ~42,000 skill XP across 13
skills, hands out combat abilities and upgrade materials, and unlocks regions and
dungeon tiers. Quests gate each other, so the critical path is mostly linear; side
content (50+ handwritten side quests, hundreds of NPCs, contracts, events) hangs off it.

**Geography.** One shared overworld with named regions: **Arcadia** (main city — auction
house, café, arena), **Neo-Tilus** (home of the Librarian), **Everdune**, **Farpoint**,
**Minamoto**, **Eastern Reach** (Virelda), and the **Lunar Plateau**, plus a **Tutorial
Island** with its own beginner mega-dungeon (**The Deep**). Each region hosts its own
dungeon entrances ("beacons") and gathering nodes, so regions double as difficulty bands.
Live regional servers exist, and characters can be created per region.

## 4. Narrative design

The narrative is deliberately **light-touch scaffolding**, not the product. Public
material tells you *how* story is used more than *what* the story is:

- **Story as tutorial.** The Chapter 1 main questline exists to walk the player through
  every system — each major quest hands out an ability, a material type, or access to a
  region. Named quest-givers are remembered for what they unlock, not who they are:
  **Aster** grants the Gleam Twins guns, the **Witch Doctor's** questline grants Healing
  Pulse. That is the clearest signal of priorities: NPCs are progression dispensers
  with personality sprinkled on.
- **Planned structural shift.** The wiki states Chapter 1 is "a linear main storyline
  with optional side quests," while later chapters are "expected to adopt a more
  nonlinear structure" — linear on-ramp first, open structure once the player is
  system-literate.
- **Mystery as the retention hook.** The only long-arc promise is the Anima and the
  "hostile forces lurking beneath the surface." The setting's central question (what is
  this digital world, what happened to your memory) is a drip-feed for future chapters
  rather than a resolved plot. **[inferred]** This fits an EA roadmap: the story can
  grow sideways with new zones without rewriting what shipped.
- **Tone.** Light, cozy sci-fi with pun-forward quest naming ("Love at First Byte,"
  "Romeo, O Romeo," "An Audience with M0RPH-OS") and recurring low-stakes civic bits
  (a three-part "Blackwake Vote" series across regions). Press coverage describes the
  tone as pleasant; nothing in the sources suggests darkness beyond the Anima threat.
- **Volume and distribution.** Roughly 60 side quests are documented, heavily clustered
  in Arcadia (~25) and Virelda (~17), with thinner regions (Farpoint lists none) —
  content density visibly tracks the intended player path. The 1.0 roadmap promises
  more than double the quest count plus continued story chapters.

**Depth assessment for a reader:** do not mine this game for narrative technique. Its
useful lesson is the *shape* — a linear story spine that doubles as the systems
tutorial, cheap episodic side content for place-identity, and one withheld mystery for
long-term pull.

## 5. Art and audio direction

**Art.** Clean, readable 2D pixel art, consistently the most-praised thing about the
game ("beautiful, nostalgic" in reviews; "very appealing... with small charming
details" in press). Design-relevant specifics:

- **Readability over spectacle.** In a bullet-heaven game the art's first job is
  telegraphing: portal icons are pictographic (sword/heart/skull/chest/home), enemy
  density is high, and reviewers specifically call the visuals "clean and readable"
  under swarm combat.
- **Place-making.** Towns are dressed as explorable spaces rather than menu hubs —
  press singles out Virelda as "a place players want to explore." Regions carry
  distinct palettes/themes (desert Everdune, lunar plateau, neon Neo-Tilus).
  **[inferred from region names and screenshots]**
- **Cosmetics are the art pipeline's economy.** Hundreds of cosmetic gear pieces,
  follower skins, and mounts — all stat-free — mean the art team's output is directly
  monetizable and rewardable without touching balance (§13, §14).

**Audio.** Unusually well-documented for an indie, via the studio's own dev blog:

- **Scale:** hundreds of pieces composed for dungeons, towns, NPCs, and quests; 90+ in
  the current build. Each dungeon gets its own track written to complement its region's
  zone music. No composer is credited by name in public material.
- **Adaptive zone system:** music starts/stops/transitions on zone boundaries; zones
  can swap tracks by time of day (described as "darker, softer, or cozier as night
  falls"); multiple variations per area are picked at random; seamless looping is
  treated as a hard requirement.
- **Palette example (Virelda's theme):** duduk (Armenian woodwind) lead for a breathy,
  vocal tone, harps, solo cello, string ensemble, light percussion — warm, calm,
  "safety after a long journey." The track exists in day and night versions, plus a
  re-orchestrated legacy version from the Worldwide Webb era kept as a bonus — an
  intentional continuity gesture to veteran players.
- **Not documented:** sound-effect design and audio middleware.

**Takeaway:** the audio design is zone-reactive ambience, not combat-reactive scoring —
mood tracking *where you are and when*, which is cheap to implement and fits a game
whose overworld is about place, not threat.

## 6. Core gameplay loop

```
 OVERWORLD (safe, shared)                    UNDERWORLD (instanced, 1–3 players)
 gather (stamina) ──► craft/cook/upgrade ──► run dungeon (draft relics as you fight)
      ▲                 at base stations          │
      │                                           ▼
 sell/buy on PixelBay ◄── extract loot via exit portal (or risk it for more)
```

- **Session shape:** a loop iteration is short — a beacon run is 8 stages (minutes, not
  hours), a gathering errand is bounded by stamina, crafting is queued at stations.
  **[inferred]** This is browser/Discord DNA: the game was built for drop-in sessions.
- **Tutorial (~10 min):** gather materials → plant, water, harvest one crop → clear one
  dungeon. Both halves of the game in the first ten minutes.
- **Early unlock cadence:** clearing the first three dungeons unlocks your own base;
  story quests unlock each region's first dungeons; your first successful extraction on
  a tier unlocks the next tier in that region.

## 7. Combat design

- **Camera/controls:** top-down 2D pixel art; WASD / mouse / controller.
- **Loadout:** one weapon + a set of abilities (10+ abilities exist; more than a dozen
  per the press release). Weapon archetypes play differently: swords are fast arcs,
  longswords slow line pokes, heavy weapons ground slams with aftershocks; staves,
  hammers, greatswords, miniguns, chakrams, bombs, drones, turret-like "Fortify" etc.
  appear across the five combat skills.
- **Aiming modes are the accessibility story:** every weapon can be set to *manual*,
  *auto-aim*, or *auto-cast*; abilities to *manual* or *auto-cast* (shift-click the
  hotbar to toggle). Fully automated, it plays like Vampire Survivors; fully manual, it
  plays like a twin-stick ARPG. One system serves both audiences.
- **Roles without classes:** deep skill trees + upgradeable abilities let players build
  tank, healer, DPS, or hybrids; parties of 3 encourage (but don't require) role
  spread. Instant respec between runs keeps experimentation cheap.
- **Each combat skill is a weapon family:** Strength (melee), Knowledge (magic/support),
  Dexterity (kusarigama/chakram/bomb), Technology (drones/turrets/gadgets),
  Marksmanship (guns). Dealing damage with a family's weapon or ability levels that
  skill — so *using* a build is how you progress it.

## 8. Dungeons (the underworld)

**Beacon runs — the bread-and-butter format.** 8 stages connected by portals:

| Stage | Content |
|---|---|
| 1–3 | Normal enemy floors (advance by kills or timer) |
| 4 | Demi-boss |
| after 4 | **Choice:** Healing Oasis (full heal) *or* bonus-chest portal (T1–T2 only) |
| 5–7 | Normal enemy floors, escalating |
| 8 | Final boss → treasure chest → green home portal (extraction) |

A count-up timer raises difficulty the longer you linger; a "Sandstorm" shrinks the
playable arena over time and mobs spawn constantly — both are anti-camping pressure.
Portal icons telegraph what's next (sword/heart/skull/chest/home), so risk decisions
are informed.

**Difficulty tiers.** Six tiers per the press release — wiki names them **Stable →
Fractured → Collapsing → Shattered → Abyssal** (+ special labels: Tutorial, Normal,
Unstable, Raid). Higher tiers mean more enemies, faster enemies, new enemy types, and
higher-tier gear drops. Tiers 5–6 and raids gate behind a quest ("Onward and Upward").

**Other formats:** single-boss **arenas** (speedrun-able in <30s when overgeared),
wave-based **defence dungeons** (Train Defence, 4p; Virelda Outskirts, 6p), objective
dungeons, **The Deep** (50 consecutive rooms, boss every 10 — the tutorial island's
long-form dungeon), and **raids**: Mecha Titan (1–3p), Spectra's Lair (6p, Abyssal),
and a weekly 5-player Abyssal raid. Ability loadouts are *randomized* in the tutorial
and Abyssal raid dungeons — a built-in variety/fairness lever.

**Death and failure.** Current rules are forgiving: dying early costs nothing; in a
party you revive at 10–20% HP when teammates clear the stage; gear/bag loss existed
once and was disabled (§17). The real stake is the **extraction rule** — leave through
the home portal or the run's loot can be lost — plus an opt-in high-stakes mode ("High
Rollers") that does risk gear.

**Co-op scaling:** party size raises the kill-count requirements. Most beacons cap at 3
players; a few list larger caps (up to 30, unconfirmed by the wiki itself).

## 9. Relics — the in-run build draft

Relics are the roguelite half of the design: temporary upgrades that exist only inside
the current dungeon.

- **Acquisition:** enemies drop **Yoku crystals** (relic XP). Each time the bar fills,
  pick **1 of 3** offered relics — the Hades/Vampire Survivors draft.
- **Three kinds:** *passive* (stat boosts — max 4 per run, each with up to 8 levels),
  *ability relics* (phased, usually 3 phases, each phase adds an effect — unlock as the
  linked ability hits levels 3/5/10), and *weapon relics* (tied to the equipped weapon
  archetype).
- **Rarity:** Common → Uncommon → Rare → Epic → Legendary, color-coded.
- **Exclusive paths:** some relics share a pool — taking one locks out its rivals for
  the run (e.g. Hammer: Frostbreaker vs Stormbreaker vs Bulwark; Chain Lightning: Fire
  path vs Void path). This forces distinct builds instead of "take everything."
- **Offers are shaped by permanent progression:** which relics can appear depends on
  your equipped weapon, ability tiers, and *permanent upgrade levels* bought outside
  runs. Meta-progression doesn't add raw stats to runs; it widens and deepens the draft
  pool. This is the cleanest link between the MMO half and the roguelite half.
- **Exhaustion fallback:** when under 3 distinct options remain, repeatable filler
  relics appear (+3% crit / +3% damage / +5% HP).
- **Example synergy:** Blackhole Bomb's "Storm Singularity" phase 3 triggers chain
  lightning on up to 3 enemies — explicitly designed to stack with the Chain Lightning
  ability.

## 10. Progression — five permanent axes

There is **no character level**. Power comes from five independent, permanent tracks:

1. **Skills (14, each with its own XP, same XP curve).** Capped at 40 in Chapter 1;
   target cap 99. *Conflict:* the launch press release says "60 levels of progression"
   and Steam says "content up to level 50" — the cap has visibly moved during EA; the
   roadmap says levels 51–99 are coming. Skill levels gate equipment, seeds, recipes,
   and achievements. A displayed "Total Level" (sum of all skills) is the
   RuneScape-style prestige number.
2. **Gear.** Rarities Common → Uncommon → Rare → Epic → Legendary → Unique, with 0–6
   bonus stats *rolled per drop* on top of fixed Power/Will/Vitality — "thousands of
   variants" from one loot table. Sources: dungeon chests (tier-scaled), crafting,
   quests, trading. Gear carries skill-level requirements (including gathering/crafting
   skills — so a pure fighter still has reasons to fish).
3. **Upgrades.** Permanent enhancements to weapons and abilities, paid for with a
   material chain (Power Cores → Core Fragments → Core Residues in grades → Living
   Essence). Besides raw power, upgrades unlock better relic options mid-run (§9).
4. **Account-wide unlocks.** 500+ achievements feed an **Achievement Hunter** ladder
   (Initiate → … → Master → Paragon) paying out QoL rather than stats: teleport
   talismans, extra bag/belt storage, mounts, map shortcuts, bonus drop tables, bonus
   gathering. Achievement "diaries" bundle regional goals — straight out of OSRS.
5. **Housing stations (§12).** Station level, not just skill level, gates what you can
   craft — an underpowered base is a progression bottleneck by design.

**Quest/contract glue:** repeatable **contracts** from location boards (hold 5, refresh
for gold) pay bonus XP on top of the activity — the daily-ish structure without a
hard daily cap.

**Stamina, not energy-gating:** gathering actions cost 3 stamina each; stamina regens
passively (even offline) and from food/café sitting. Combat and dungeon entry are *not*
stamina-gated. A third resource ("Yoku" daily energy, once needed to open dungeon
chests) was **removed** during EA (§17) — the studio walked away from its last
mobile/web-style monetization-shaped gate.

## 11. Overworld life-sim

- **Gathering (5 skills):** Foraging (plants), Mining (ore), Fishing (schools; each
  catch 3 stamina), Farming (seeds → crops at the Homestead or apartment plots), and
  **Hacking** (extracting components from robotic nodes — the sci-fi reskin of a
  gathering skill, unique to the fiction).
- **Artisanal (4 skills):** Cooking (stat/stamina food), Chemistry (buff potions),
  Crafting/Fabrication (components), Gearforging/Smithing (weapons and armor).
  Food and potions are the consumable bridge into dungeons.
- **Crafting is real-time:** stations run timed jobs with limited slots (reviews call
  the timers "lengthy" — a notable friction point).
- **The overworld is 100% mob-free.** All hostile content is instanced. Thousands of
  players share regions purely for gathering, trading, events, and socializing.

## 12. Housing and base-building

- The base ("apartment"/Homestead) unlocks after the first three dungeons and is the
  **crafting and progression hub**, not just decoration.
- **Stations** are built, then upgraded through 3–5 levels each (Kitchen, Chemistry
  Lab, Smelter, Gearforge, Weapon Station, Manufacturing Table, Power Core Forge,
  Generator). Each level unlocks higher recipe tiers and more parallel crafting slots.
- **Power budget:** stations draw power from the Generator (fed with coal); an
  under-powered home limits which stations can run at once — a resource-allocation
  minigame inside the base.
- **Social housing:** a room-layout editor, decoration, inviting friends, and shared
  resources; the press kit pitches "run a blacksmith shop" as an aspirational player
  identity.
- The **Homestead** is the scaled-up farming property distinct from the apartment.

## 13. Economy, trading, and social systems

- **Gold** is the single tradable currency: earned from contracts, chests, quests;
  spent on trading, crafting, and the auction house.
- **PixelBay** (auction house, in Arcadia): list any sellable item with quantity,
  price-per-item, and duration; buyers search/sort by unit price; a History tab records
  all transactions. **Vendors pay a fixed Sell Value instantly**, which acts as the
  economy's price floor — list on PixelBay only above vendor price. Clean, legible
  two-tier sink/market design.
- **Non-tradable prestige currencies** keep cosmetics out of the gold economy:
  Commission Medals (weekly event challenges → Monthly Vendor), Commission Credits
  (daily challenges → Weekly Vendor), **Bug Credits** (bug-bounty program → Bug Vendor
  cosmetics), **Librarian Credits** (awarded monthly for wiki contributions that
  survive review). Rewarding bug reports and wiki editing with in-game currency is a
  standout community-as-content idea.
- **Followers (pets) and mounts:** followers are explicitly **non-combat** cosmetic
  companions equipped in a dedicated slot — earned from achievements, events, guild
  caches, gathering activities, task rewards, or bought with "Soulbits" in a cosmetics
  store (§14). Named examples: gathering-themed "Twibbi" companions, Pet Rock (raid
  reward), Pioneer Guild Owls. Mounts come mostly from the achievement ladder.
- **Cosmetics never carry stats** — a hard visual/stat separation with hundreds of
  pieces.
- **Group tooling:** dungeon finder, in-game + Steam leaderboards, seasonal ladders,
  scheduled live events, party system. The **Pioneer's Guild** is an NPC faction
  (contracts, monthly vendor); whether player-created guilds exist is unclear ("Guild
  Cache rewards" exist — see gap ledger).

## 14. Monetization and business model

- **$14.99 one-time EA purchase**; studio says no price change planned at 1.0.
- Steam lists **in-app purchases**; the wiki shows a cosmetics store priced in
  **Soulbits** (~400–1,250 per follower). Whether Soulbits are purchasable with real
  money or only earned is **unconfirmed** — reviewers currently describe "no
  real-money shop, no pay-to-win, no loot boxes," and the studio says it is "exploring
  monetization with the community." **[inferred]** Cosmetic-only cash shop is the
  likely end state.
- **The Web3 retreat is the defining business event:** as Worldwide Webb, players paid
  crypto and owned NFT characters/land; land ownership created pay-to-win pressure and
  Steam bans crypto/NFT games outright. SpiderWare deleted all Web3 in May 2026 and
  did **not** carry over blockchain assets — earning Steam eligibility and goodwill
  from new players, but lasting distrust from both former NFT holders and
  crypto-skeptical reviewers ("crypto allegations persist" in reviews). Trust debt
  outlives the feature that created it.

## 15. Online and technical architecture

What can be established or reasonably inferred about how the game actually runs — the
layer where its launch succeeded or failed:

- **Topology: shared hub + small instances.** Thousands of players share overworld
  regions; all combat happens in instances capped at 3 (dungeons) to 6–8 (raids). This
  is a latency-risk split: the overworld hosts only movement, gathering, chat, and
  trade — activities that tolerate high latency — while the latency-critical
  bullet-heaven simulation runs in tiny instances. **[inferred]** The design is sound;
  the execution (below) is what failed.
- **Regional servers, regional characters.** Live servers per region, with characters
  created per region (not a global character roster). Six additional servers plus a
  "fresh start" promotion were added about 7 weeks post-launch — capacity and
  population distribution were visibly being tuned live.
- **Client/engine: unconfirmed, but web-native DNA.** The game shipped for years as a
  browser and Discord-embedded client; no engine is named anywhere public. The ~800 MB
  install, the 16 KB-era pixel aesthetic, and the odd performance profile (reviews
  skew *negative on mid-range 8–15 GB VRAM GPUs and positive below 8 GB*, which is
  backwards for a native engine) are consistent with a ported web/JS stack rather than
  a rewritten native client. **[inferred — flagged, not established]**
- **Where it hurts: instance netcode under load.** The dominant complaint is ping
  above 200 ms and dungeon lag that worsens at higher tiers — exactly where entity
  counts explode (more, faster enemies + 3 players' projectiles). Whether combat is
  server-authoritative or client-trusted is not public; either way, the simulation
  visibly does not scale with entity count at current server capacity.
- **Mitigation visible in patches:** a dedicated "Overworld Performance Boost" patch
  (6.5) and the server expansion both landed within two months of launch — performance
  was being firefought, not pre-provisioned.
- **Platform spread:** Windows (primary), macOS listed on Steam (conflicting with the
  help site), Steam Deck "playable but compromised," Linux/Proton feedback mostly
  positive. Full Steam Deck support is a stated 1.0 goal.
- **Always-online**, including solo play; accounts are auto-created from Steam
  identity with no separate login.

**The architectural lesson in one line:** the two-world split correctly quarantines
latency risk into small instances — but a bullet-heaven instance is the *hardest*
real-time workload per player, so quarantining it is not the same as solving it.

## 16. Live ops and community operations

- Weekly updates and hotfixes through EA; see the design-change timeline (§17) for the
  documented patch history.
- Support praised as fast (often same-day fixes for stuck quests) via in-game support
  chat, Discord, and email.
- Roadmap: levels 51–99, more raids, 2× quests, new zones/story, more languages, full
  Steam Deck support, economy refinement — 12–18 months of EA.
- Creator program with open monetization rights; press/brand kit maintained; the
  official wiki is community-run but studio-rewarded (Librarian Credits).

## 17. Design-change timeline — what shipped, what was walked back

A live game's design is a trajectory, not a snapshot. The documented reversals are the
most instructive part of the whole case study:

| When | Change | What it tells you |
|---|---|---|
| 2020–2025 | *Worldwide Webb*: crypto payments, NFT avatars/pets/land | Land-as-NFT created pay-to-win and progression gating by wealth |
| May 2026 | **All Web3 removed**; rebrand to Soulbound: Online; no blockchain assets carried over | Required for Steam at all (Valve bans crypto/NFT games); bought goodwill from new players, permanent grievance from asset holders |
| EA launch (Jul 2026) | Dungeon tiers 5–6, dungeon finder, overhauled combat added | The launch itself was the biggest content/systems rework |
| during EA | **"Yoku" daily energy removed** (was needed to open dungeon chests, 50–200/chest, daily recharge) | The last web/mobile-style engagement gate deleted; premium PC buyers reject daily energy |
| during EA | **Chest costs removed** entirely; end-of-run chest now free | Double-charging (clear the run *and* pay to open loot) read as punitive |
| during EA | **Death gear/bag loss disabled**; party revive at 10–20% HP added | Hard extraction-loss was too spiky for the audience; risk got re-concentrated into the opt-in "High Rollers" mode instead |
| Sep 4, 2026 | Patch 6.5: overworld performance boost | Performance firefighting, ~6 weeks post-launch |
| Sep 9, 2026 | Patch 7: crafting overhaul + salvaging added | Crafting friction (timers, dead items) was bad enough to need a systems rework, not tuning |
| Sep 10, 2026 | 6 new servers + 35% discount "fresh start" push | Capacity + population reboot — lag and a shrinking pool were being fought with infrastructure *and* marketing at once |
| Sep 17 / 24, 2026 | Patch 8: Spectra's Lair raid; Patch 9: Cactaro General's Arena | Weekly endgame content cadence resumed once stability work landed |

**Pattern:** every reversal removed friction or risk that made sense in a
free-to-play browser context and failed in a $15 premium Steam context. The audience
contract changed; the systems had to follow.

## 18. Retention cadence calendar

The time-structure of the live game, assembled from the currency and event systems:

| Cadence | Mechanism | Reward loop |
|---|---|---|
| **Per-session** | Stamina-bounded gathering; queued real-time crafting jobs | Come back to collect finished crafts; stamina regens even offline (no hard daily wall) |
| **Daily** | 1-day event challenges | Commission Credits → Weekly Vendor cosmetics |
| **Weekly** | Weekly event challenges; weekly 5-player Abyssal raid; contract board refreshes | Commission Medals → Monthly Vendor; raid loot lockout **[inferred]** |
| **Monthly** | Monthly Vendor stock; Librarian Credit awards (wiki work that survives a month) | High-tier cosmetics; community-labor payout |
| **Seasonal** | Seasonal ladders, leaderboards, scheduled live events, competitive gathering events | Rank rewards, event loot tables, event-exclusive followers |
| **Open-ended** | 500+ achievements + regional diaries → Achievement Hunter ladder | QoL unlocks (teleports, storage, mounts, drop tables) — the long tail |

**Design posture:** after the Yoku removal, *nothing gates how much you can play* —
all cadence pressure is pull (bonus rewards on daily/weekly timers), not push (energy
walls). Prestige/cosmetic currencies are deliberately non-tradable so the calendar
can't be bought through the gold economy.

## 19. Reception snapshot and lessons (for monster-realm)

**What players love:** the dungeon loop ("fun, addictive"), the pixel art, developer
responsiveness, honest one-time-purchase monetization.

**What is sinking the score (59% Mixed):**

1. **Server lag above all** — 43 mentions in review analysis; ping >200 ms common;
   high-tier dungeon lag called "unplayable." For a bullet-heaven game, netcode *is*
   the game feel. The lesson for a server-authoritative SpacetimeDB game is blunt:
   prediction/reconciliation quality and region latency budgets are launch-blocking
   features, not polish.
2. **Bugs block the critical path** — a tutorial-quest bug that stops progression is
   the worst possible place for a bug. Gate the first hour behind the most-tested code.
3. **Mid-game grind wall** — enjoyment fades when the questline hands you to raw
   skilling; slow gathering + long real-time crafting timers read as padding. Timers
   that made sense in a browser/idle context hurt in a premium Steam game.
4. **Small population breaks matchmaking** — the dungeon finder fails at low pop;
   3-player content with solo viability (which they have) is the right hedge.
5. **Trust debt compounds** — the NFT past still costs reviews a year later.

**Transferable design wins worth copying:**
- The **two-world split** (safe social overworld / instanced combat) cleanly separates
  netcode risk tiers — the overworld tolerates latency, dungeons don't (§15).
- **Meta-progression that widens the in-run draft pool instead of adding raw stats**
  (§9) keeps runs fresh without power-creeping early content.
- **Aiming-mode toggles** (manual/auto-aim/auto-cast) as a one-system difficulty and
  accessibility dial.
- **Extraction choice** as cheap, legible risk/reward (heal vs bonus chest).
- **Skill-based classless progression** where *using* a thing levels it, with gear as
  the role definition.
- **Vendor floor + player auction house** as a self-balancing economy primitive.
- **Community labor as rewarded content** (bug bounty and wiki currencies).
- **Pull-based retention calendar with no energy walls** (§18) — cadence through
  bonuses, never through lockouts, after they learned that lesson the hard way (§17).

## 20. Gap ledger (things sources don't settle)

| Gap | Status |
|---|---|
| PvP | No source mentions any PvP; presumed PvE-only. **[inferred]** |
| Player-created guilds | "Guild Cache rewards (tiers 1–6)" exist, but only the NPC Pioneer's Guild is documented |
| Soulbits acquisition | Real-money or earned-only unconfirmed; monetization "being explored" |
| Level cap | 40 (wiki, Ch. 1) vs 50 (Steam) vs 60 (press release) vs 99 (roadmap) — moving EA target |
| Follower gameplay effects | Documented as non-combat; no buffs listed, but gathering-themed followers hint at utility |
| Death penalty history | Gear/bag loss "existed previously," now disabled; exact old rules undocumented |
| Engine / tech stack | Never named; web-native origins known, native-vs-ported client unconfirmed (§15) |
| Server authority model | Whether combat is server-authoritative or client-trusted is not public |
| Composer / audio team | Uncredited in all public material; sound-effect design undocumented |
| Main-story beats | Only the premise (Anima, amnesia, Pioneer) is public; no chapter plot summaries exist |
| macOS support | Steam lists macOS requirements; help site says Windows-only |
| XP curve | Table only public for levels 1–40 |
| The Deep vs Tutorial Dungeon | Wiki flags its own 50-room vs 5-room conflict as unresolved |

## 21. Sources

1. [Official press kit — soulbound.game/press](https://soulbound.game/press/)
2. [Steam store page (app 4369490)](https://store.steampowered.com/app/4369490/)
3. [Early Access launch press release — Game Developer](https://www.gamedeveloper.com/press-release/out-now-soulbound-online-enters-steam-early-access-inviting-players-to-help-guide-its-future)
4. [Getting-started guide — soulbound.game/help](https://soulbound.game/help/getting-started-in-soulbound-your-first-steps/)
5. [MeinMMO (EN): blockchain history and rework](https://mein-mmo.de/en/mmorpg-launched-with-blockchain-decided-against-it-now-wants-to-convince-you-with-a-demo-on-steam,1573855/)
6. [Gaming Nexus EA launch impressions](https://www.gamingnexus.com/News/73370/Soulbound-Online2c-launching-today-into-Early-Access2c-deserves-a-second-look-/)
7. [Dev blog: "The Sound of Soulbound — Creating the Music of Virelda"](https://soulbound.game/news/the-sound-of-soulbound-creating-the-music-of-virelda/)
8. [Dev blog: "How to Compose Music for Video Games"](https://soulbound.game/blog/how-to-compose-music-for-video-games/)
9. [Community wiki — home / news list](https://wiki.soulbound.game/)
10. [Wiki: Skill](https://wiki.soulbound.game/Skill)
11. [Wiki: Follower (Pets)](https://wiki.soulbound.game/Pets)
12. [Wiki: Dungeon](https://wiki.soulbound.game/Dungeon)
13. [Wiki: Relic](https://wiki.soulbound.game/Relic)
14. [Wiki: Leveling and Progression](https://wiki.soulbound.game/Leveling_and_Progression)
15. [Wiki: Energy](https://wiki.soulbound.game/Energy)
16. [Wiki: Currency](https://wiki.soulbound.game/Currency)
17. [Wiki: Controls and Mechanics](https://wiki.soulbound.game/Controls_and_Mechanics)
18. [Wiki: PixelBay](https://wiki.soulbound.game/PixelBay)
19. [Wiki: Quests](https://wiki.soulbound.game/Quests)
20. [Vaporlens Steam review analysis](https://vaporlens.app/app/4369490/soulbound_online)
