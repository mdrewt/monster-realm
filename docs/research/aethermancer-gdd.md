---
title: "Aethermancer — Reference Game Design Document"
slug: aethermancer-gdd
domain: gameplay
tags: [monster-taming, roguelite, turn-based-combat, aether-economy, permadeath, rebirth, meta-progression, gdd-reference]
status: active
updated: 2026-11-06
confidence: medium
sources: 12
supersedes:
abstract: "Reconstructed GDD for Aethermancer (Early Access 2025), gaps filled from Monster Sanctuary (2019); monster-realm reference."
---

# Aethermancer — Reference Game Design Document

> **What this is.** A reverse-engineered GDD for *Aethermancer* (moi rai games / offbrand
> games, Steam Early Access since 2025-09-23), written 2026-11-06 as reference material for
> the Monster Realm GDD. It is organized the way a real GDD would be, so its structure can
> be copied as well as its content.
>
> **How to read it.** Everything unmarked is sourced from the Steam page, the official wiki
> (aethermancer.wiki.gg), and Early Access reviews/guides as of November 2026. Anything
> marked **[MS-inferred]** is a gap filled by assuming Aethermancer made a similar decision
> to the developer's previous game, *Monster Sanctuary*, adjusted for the roguelite format.
> Known conflicts between sources are called out inline, and a claim-by-claim gap ledger
> is in §18. Numbers may have drifted since the patches these sources describe.
>
> **Originality note (per SEED-DOMAINS.md).** This document is for mining ideas and
> structure, not for cloning. Names, lore, and exact numbers here belong to moi rai games.

---

## 1. Game Overview

**One-line pitch.** A monster-taming roguelite: build a bond with a party of three
monsters, take them through short procedurally generated runs of turn-based battles, lose
them, and bring their souls back stronger — until they prove themselves Worthy enough to
escape their cycle of death and rebirth.

| Field | Value |
|---|---|
| Title | Aethermancer |
| Developer / Publisher | moi rai games / offbrand games |
| Genre | Monster-taming roguelite, turn-based party RPG |
| Platform | PC (Windows, Linux), single-player |
| Price | $25.99 (Early Access); planned increase at 1.0 |
| Status | Early Access 2026: ~93% positive on Steam ("Very Positive") |
| Engine/presentation | 2D pixel art, side-view battles, dark-fantasy tone |
| Session length | Short runs (~30–60 min), designed for "one more run" |
| Key timeline | Reveal Mar 2023 → closed alpha Apr 2024 → demo Feb 2025 → EA Sep 23, 2025; ~1.5 years of EA planned |

**Audience and positioning.** Players of *Monster Sanctuary* (the studio's previous game),
Pokémon-likes, and deck/run roguelites (*Slay the Spire*, *Wildfrost*). The hook is the
crossover: monster collecting gives the roguelite long-term attachment; the roguelite gives
monster collecting stakes and replayability.

**Unique selling points.**

1. **Death matters but never wastes your time.** Monsters permanently die in runs, yet
   their souls return and are reborn stronger. Attachment survives permadeath.
2. **A shared-pool mana economy (Aether)** instead of per-monster MP, making every turn a
   team-level resource puzzle.
3. **No type-effectiveness chart.** Elements matter through the Aether economy and the
   Poise/stagger system instead of a rock-paper-scissors damage table.
4. **Builds are drafted, not planned.** Each level-up offers a choice from a dynamic skill
   pool shaped by the monster's elements, types, teammates, and earlier picks — the same
   monster plays differently every run.
5. **The town grows out of your runs.** NPCs rescued during runs settle in the hub,
   sell permanent upgrades, and make the meta-progression feel like worldbuilding.

---

## 2. Design Pillars

These pillars are inferred from how the systems consistently resolve trade-offs; a real
internal GDD would state them up front.

1. **Bond through loss.** The emotional core is keeping monsters across lifetimes. Every
   system that destroys something (permadeath, Corruption, single-use shrines) is paired
   with a system that preserves identity (Mementos, Souls, Worthiness).
2. **Plan the turn, not the matchup.** Depth lives inside a battle (Aether budgeting,
   telegraph reading, Poise timing), not in pre-battle counter-picking. Hence: no type
   chart, visible enemy intents, and a shared resource pool.
3. **Variance you can steer.** Random skill offers, random monsters, random rooms — but
   rerolls, drafts, and unlockable "weights" (soulbonds, hidden-monster unlocks) let the
   player bend the randomness rather than fight it.
4. **Short runs, long arcs.** A run is disposable; a monster's Worthiness, the Memento
   collection, and the town are forever. Every run must advance at least one permanent
   track even when it fails.

---

## 3. Setting & Story

- **World.** Monsters called **Terastae** that defy the world's virtues are trapped in an
  endless cycle of death and rebirth. The run environment is the **Fractured Ruins** — a
  shifting, procedurally generated dreamlike space.
- **Player fantasy.** You are an **Aethermancer** — a human mage who does not fight
  directly but soul-bonds with monsters and guides them. Your goal is to help your
  monsters earn **Worthiness** and break their eternal loop.
- **Hub.** **Pilgrim's Rest**, a village you repopulate and decorate. NPCs met and rescued
  during runs appear there afterwards with dynamic dialogue.
- **Storytelling method.** Light-touch: lore flows through NPC conversations, encounters,
  and the town's growth rather than cutscenes. The time-loop premise is load-bearing — it
  *diegetically explains* the roguelite structure (why runs repeat, why the dead return).
- **Endings.** Multiple endings, including "true endings," are planned for 1.0.

> **Design takeaway:** pick a premise that makes the genre's loop canon. "You are stuck in
> a cycle" turns run-resets from a game-ism into the plot.

---

## 4. Core Gameplay Loops

**Macro loop (minutes → hours):**
Pilgrim's Rest (spend Aether Crystals on permanent upgrades, soulbond monsters, pick
starters/class/difficulty) → run through the Fractured Ruins → run ends in victory or
party wipe → return to town with Aether Crystals, Mementos, and Worthiness gained →
repeat, stronger.

**Mid loop (one run, ~30–60 min):**
Pick a starting party of three → traverse a biome room by room → after each room, choose
the next room's type (fight, merchant, rest site, event, loot) → rest sites and Monster
Shrines punctuate biomes → biome boss / Champion → next biome (a run spans ~3 biomes of
3–4 rooms each) → final boss or wipe.

**Micro loop (one battle, ~2–5 min):**
Read enemy telegraphs → budget the team's Aether → order your three monsters' actions →
generate Aether with cheap actions, spend it on expensive ones → break Poise to stagger →
end-of-battle rewards (XP, Worthiness, gold, crystals; capture opportunities).

**Out-of-battle verbs.** Exploration is light but real: Aethermancer class abilities let
you sneak past fights, leap from platforms to pre-damage Poise (Void Blitz), parry to open
fights advantageously, and reveal secrets (Search Command). Rooms hold gold, Aether
Crystals, chests, and equipment.

---

## 5. Run Structure

- **Biomes (4 in EA):** Pilgrimage Path, Alchemical Woods, Forbidden Fortress, Garden
  District. One run crosses three of them; an unlock lets you choose an alternate starting
  biome. Each biome has its own monster roster (~8–10 species) plus unlockable "hidden
  monsters."
- **Rooms.** 3–4 per biome. After each room the player picks the next room's type — the
  classic roguelite "path choice" compressed into a menu. Known room types: combat,
  merchant (items + XP), loot/rare-drop, rest site, event/NPC rescue.
- **Rest sites.** Heal, feed monsters (XP or Corruption cleanse), and host optional camp
  NPCs unlocked via meta-upgrades (the knight joins rest site 1, the witch rest site 2, an
  epic loot drop rest site 3).
- **Monster Shrines.** One per main area and at rest sites; each shrine is single-use.
  Shrines are where dead monsters are reborn (see §8.3) and where the Alchemist class
  performs Infusions.
- **Champions.** Elite monster fights that award bonus gold and Aether Crystals and large
  Worthiness bonuses (+30 points).
- **Monster Deities.** Major boss fights (2 in EA, more at 1.0) worth +100 Worthiness.
- **Run end.** Victory or party wipe both return you to Pilgrim's Rest. Nothing earned is
  lost on a wipe — crystals, Mementos, and Worthiness all persist — only the run state
  (levels, equipment, gold) resets.

> **Design takeaway:** "choose the next room type" gives roguelite agency without building
> a map screen; single-use shrines convert party deaths into a spatial resource.

---

## 6. Combat System

### 6.1 Turn structure

- Battles are **3v3**, turn-based, side-view.
- **The player always acts first** and chooses the order in which their three monsters
  act. Every monster must act each turn; then all enemies act.
- Once per turn, while at least one of your monsters still has an action left, you may use
  an **Artifact** (limited-charge battle item). If all monsters act first, the artifact
  window closes — a small sequencing rule that rewards planning.
- **Enemy intents are telegraphed**: next-turn attacks appear as icons above enemies, so
  the turn is a puzzle with near-full information. (EA reviews noted icon readability as a
  weak point; a combat-inspect feature was added in a January 2026 patch.)

### 6.2 The Aether economy

Aether is the shared action-resource system and the game's signature mechanic.

- **Five Aether kinds:** Fire, Water, Earth, Wind, and **Wild** (wildcard). (Sources
  conflict on the count — Steam's own copy says "four elements of Aether"; read here as
  four true elements plus Wild as the wildcard. See §18.)
- **Generation:** some Aether appears automatically at the start of each round; the rest
  is produced by cheap actions (basic attacks and generator skills) and by Traits.
  Different monsters produce different kinds.
- **Spending:** strong Actions consume specific Aether kinds and amounts. The team shares
  the pool, so one monster can generate for another's payoff — the economy creates team
  roles (generator / spender / support) on top of combat roles.
- **Counterplay:** **Purge** destroys enemy Aether and **Steal** takes it; enemies' own
  telegraphed attacks can *fizzle* when the Aether they needed is gone. Denial is a
  first-class strategy, not a gimmick.
- **Capacity** is bounded and upgradable via meta-progression.

**[MS-inferred]** *Monster Sanctuary* used per-monster mana plus a combo meter that grew
with each hit in a turn and multiplied later hits, making action order matter. Aethermancer
appears to fold both ideas into Aether: generation-then-spend ordering replaces the combo
meter as the reason sequencing matters.

### 6.3 Elements without a type chart

- Each monster has **two Elements** (or the single Wild element). Elements gate which
  Actions a monster can learn and which Aether it tends to generate/spend.
- **There is explicitly no elemental weakness/resistance table.** Elements matter through
  (a) the Aether economy and (b) Poise matching (§6.5).

> **Design takeaway:** removing the type chart removes memorization and counter-pick
> pressure, and relocates elemental identity into resources and stagger — a deliberate
> break from Pokémon convention that suits a game about drafting under randomness.

### 6.4 Monster Types (roles)

Each monster has **three Types** out of 19 (e.g., Tank, Heal, Shield, Poison, Burn, Purge,
Critical, Dodge, Summon, Sidekick, Regeneration, Force, Terror, Weakness, Affliction, Age,
Power, Aether). Types define the monster's battle roles and, crucially, **weight which
Traits and Actions it is offered on level-up** — they are the draft's probability dials as
much as combat keywords.

### 6.5 Poise & Stagger

The defense-break system, and also the capture system's gate:

- Enemies show a **Poise diamond**: a hit count plus an element (or physical) icon.
- Hits with the **matching element** reduce Poise; **Wild attacks always count**.
- Breaking all Poise **Staggers** the enemy: it loses its next action and takes **+50%
  damage**. Out-of-combat tools (Void Blitz platform dives, Parry) can pre-damage Poise.
- Enemies can use Recover-type actions, so mistimed stagger chains waste turns.

### 6.6 Statuses & keywords

Confirmed status/keyword vocabulary: Poison (damage over time), Burn, Shield (absorbs and
prevents Corruption), Power (buff), Dodge/Evasion, Weakness, Terror, Age, crit chance/crit
damage, redirects/taunts **[MS-inferred: taunt-style redirection existed in Monster
Sanctuary]**, buff/debuff counting effects (class perks count unique buff/debuff types).
Healing and overheal are tracked distinctly (overheal earns no Worthiness).

### 6.7 Corruption (the attrition system)

- Whenever a monster takes **unshielded** damage, it gains Corruption.
- Accumulated Corruption **lowers that monster's starting/max HP** in subsequent battles
  — chip damage has run-level consequences, and Shields become a strategic (not just
  tactical) tool. (Sources conflict on duration — the wiki says it affects "the next
  battle," a guide says it persists for the whole run; read here as accumulating
  run-long unless cleansed. See §18.)
- Cleansing is a running economy of its own: meals at rest sites, Salves, Blessed Ponds,
  specific skills/perks/artifacts, and Worthiness level IV's permanent "+1 cleanse."
- Accessibility: Corruption can be disabled entirely in the options.

### 6.8 Items in battle

- **Monster Flask:** a *Slay the Spire*-style healing potion with limited charges
  (3 base, upgradable to 4 / stronger heals).
- **Artifacts:** chargeable battle items bought from a vendor; epic rarities exist;
  meta-upgrades can recharge them at Champion fights.

### 6.9 Win/loss and rewards

Victory pays XP, gold, Worthiness (per the formulas in §8.4), and sometimes capture
opportunities. A monster that dies mid-battle earns none of that battle's Worthiness —
death is punished in the permanent currency, not just the run. Party wipe ends the run.

---

## 7. Monsters

### 7.1 Roster

- **40 species in EA** (28 at EA launch; one review counts "over 50" — see §18; more
  planned for 1.0), each with a **Shifted
  variant** — an alternate-color form with **different types, stats, and signature
  trait** (closer to a sibling species than a cosmetic shiny). Shifted variants share
  their base form's Worthiness.
- Four fixed **starters** per save (Jotunn, Nixe, Minokawa, Cherufe); more starters come
  from soulbonding captured species.
- Rosters are biome-scoped (~8–10 species per biome), with rare "hidden monsters"
  unlockable per biome.

### 7.2 A monster's data sheet

Each species defines:

| Field | Notes |
|---|---|
| Two Elements (or Wild) | Gates learnable Actions; drives Aether generation |
| Three Types | Battle roles + trait-pool weighting (19 types total) |
| Signature Trait | Unique passive, the species' mechanical identity |
| Skill pool | Actions (active) + Traits (passive), drawn from 500+ abilities |
| Base stats | **[MS-inferred]** HP, attack-style scaling, crit chance, evasion; Monster Sanctuary used Health/Mana/Attack/Magic/Defense, and Aethermancer demonstrably tracks max HP, crit chance, and evasion |
| Shifted variant | Different types/stats/signature trait |

### 7.3 Leveling: the draft

- Monsters level up **within a run only** (roughly level 8 by a biome's end when clearing
  all fights, per EA guides); levels reset between runs.
- **Every level offers a choice of skills** — each offer is an Action or a Trait pulled
  from a **dynamic pool weighted by the monster's elements, its types, the party's
  composition, and previous picks**. The same species drafts differently next to different
  teammates: build synergy is discovered mid-run, not pre-planned.
- **Skill rerolls** are a scarce resource (start-of-run stock is upgradable; a hub NPC
  rerolls an action/trait/perk; some class perks grant rerolls on rebirth).
- **Maverick Skills:** low-probability off-pool skill offers (chance raised by Worthiness
  level V and Maverick-class upgrades) — controlled wildcards in the draft.
- XP sources: winning fights, merchant-bought XP, feeding meals.

**[MS-inferred]** This replaces Monster Sanctuary's fixed three-branch skill trees. The
studio kept "every monster is a build" but moved authorship from pre-planning (trees +
respec) to in-run drafting (offers + rerolls), matching the roguelite frame.

### 7.4 Equipment

Monsters carry equipment with base effects plus random **affixes**; rarities up to Epic.
A traveling knight NPC grants and swaps gear during runs; "Torment's Blessing" upgrades
equipment (and pays Worthiness). Equipment is run-scoped — it resets on run end.
**[MS-inferred]** Monster Sanctuary's loadout was one weapon + up to three accessories per
monster; Aethermancer likely uses a similar small per-monster slot count so gear reads at
a glance.

---

## 8. Collection, Death & Persistence

This is the heart of the design — the systems most worth studying for Monster Realm.

### 8.1 Capture: Stagger → Memento

1. Break a wild monster's Poise to **Stagger** it (element-matched hits; §6.5).
2. While it is staggered, spend a **Blank Memento** (a consumable found in rooms or bought
   from merchants) to record it.
3. You now permanently own that species' **Memento** — a soul-record, not the monster
   itself. Mementos are the collection; they never expire.

**[MS-inferred]** Monster Sanctuary awarded monster eggs based on a 1–6★ end-of-battle
performance rating. Aethermancer keeps "capture = play well" (you must engineer a stagger,
which requires element planning) but moves the moment of capture *into* the fight and makes
the consumable, not the rating, the limiting resource.

### 8.2 Soulbond

In town, the witch NPC sells **Soulbonds** for Aether Crystals (30–200 by rarity tier,
grouped by biome). Soulbonding a captured species makes it available as a **starter** and
as a rebirth option from the start of a run. Capture gets you the record; soulbond makes
it part of your stable.

### 8.3 Rebirth: Souls + Shrines

- When a monster dies in a run, it is gone **for that run** unless reborn.
- At any **Monster Shrine** (one per area; single-use), spend **Monster Souls** to rebirth
  a monster from your Memento collection (soulbound at run start, or captured during the
  run). Souls are found in runs, granted by meta-upgrades (up to +3 at run start), and
  sometimes sold.
- The shrine offers a choice of monsters (rerollable via meta-upgrades); a "Collector"
  class upgrade shows *all* soulbound monsters at a higher Soul cost.
- A reborn monster **keeps its identity and Worthiness but re-drafts its skills** — its
  learnable pool depends on current elements/types/team/choices, so each life plays
  differently. If the party is full (3), rebirth replaces a member.

### 8.4 Worthiness: the permanent spine

**Worthiness is the only attribute of a monster that persists across runs** — levels,
skills, and equipment all reset. It is simultaneously:

1. **The narrative win condition** (monsters seek Worthiness to escape the cycle),
2. **The per-monster meta-progression track,** and
3. **A meta-currency faucet** (each Worthiness level-up pays Aether Crystals).

Points are scored after every battle with published formulas that **pay every role**:
damage dealt (1 per 10, DoTs included), support damage (1 per 3), healing (1 per 3
missing-HP restored; overheal excluded), damage prevented (1 per 5, shields and redirects),
actions prevented (stagger/purge/kills; scales with biome tier), Aether generated, a
speed bonus for short fights, and boss bonuses (+30 Champion, +100 Deity). Harder
difficulties pay +20%/+40%. A monster that dies mid-battle forfeits that battle's points.

Worthiness levels I–V each grant a **Perk** (permanent passive): levels I–III are
species-specific, IV is always "+1 Corruption cleanse," V is "+25% Maverick skill chance"
plus the monster physically appearing in Pilgrim's Rest. Thresholds climb 300 → 1,500
points; past V, levels keep paying crystals effectively forever.

> **Design takeaway:** the support-role problem ("healers feel useless in score systems")
> is solved by scoring *outcomes* per role — healing, prevention, denial, and economy all
> have exchange rates into the same permanent currency.

### 8.5 What persists vs. what resets

| Scope | Persists | Resets |
|---|---|---|
| Battle → battle (in run) | HP, Corruption, levels, skills, gear, gold, Souls, Mementos | Aether pool, Poise, statuses |
| Run → run | Worthiness + Perks, Mementos, Soulbonds, Aether Crystals, meta-upgrades, town state, unlocks | Levels, drafted skills, equipment, gold, Souls, Corruption |
| Save → save | — | Everything |

---

## 9. Economy

| Currency/resource | Earned | Spent on | Scope |
|---|---|---|---|
| Gold | Rooms, Champions | In-run merchants (items, XP) | Run |
| Aether Crystals | Exploration, chests, Champions, Worthiness level-ups | All permanent town upgrades, Soulbonds | Permanent |
| Monster Souls | Found in runs, start-of-run upgrades, rare shops | Rebirths at shrines, Infusions | Run |
| Blank Mementos | Found/bought; +1 start upgrade | Capturing staggered monsters | Run |
| Mementos (unique) | Captures | Collection; **gate meta-upgrades** ("requires N unique Mementos" / specific species) | Permanent |
| Flask charges / Artifacts / Salves / Meals | Shops, rest sites, drops | Healing, battle effects, Corruption cleansing, XP | Run |

Two deliberate couplings stand out: **Worthiness feeds Crystals** (playing well with a
monster funds the town), and **Mementos gate upgrades** (collection completion is a
progression key, not just a dex percentage — many upgrades require N unique Mementos or a
specific species' Memento).

---

## 10. Meta-progression & Pilgrim's Rest

Four meta systems (per the EA notes), all living in the town as characters:

| Vendor | Sells | Flavor of progression |
|---|---|---|
| **Gustavo** (mayor) | General run upgrades: starting gold/Mementos/rerolls, max-HP growth, merchant improvements, shrine rerolls, rest-site camp NPCs | "Make every run start stronger" |
| **Alioth** (envoy) | Flask upgrades, Soul starts, Worthiness +10%, anti-Corruption meals, **class-specific enhancement trees** | "Deepen your class and economy" |
| **Lily** (witch) | Soulbonds (new starters); in-run rerolls | "Grow the stable" |
| **Sir Tiberion** (knight) | New starting biome, per-biome hidden monsters, Shifted-monster crafting/finding, equipment start, +2% crit/evasion | "Widen the content pool" |
| **Ivy** | Town decorations by district (cosmetic) | "Make the town yours" |
| **Myrne** | Meals (XP / cleanse); risky Corruption-for-Worthiness deals | "Tempting bargains" |

Rescued NPCs settle in town with dynamic dialogue (flavor-only in EA; reviewers asked for
a friendship system). Decorating is purely cosmetic and sold cheap — an intentional
"express yourself" sink, separate from power.

> **Design takeaway:** every meta-progression line is a *person*. The upgrade shop screen
> becomes worldbuilding, and "new vendor appears" doubles as a content-unlock beat.

---

## 11. Player Classes

Classes change how **you** (the human) support the team, not the monsters' kits. EA
launched with 2, with more planned; three are visible in current upgrade trees:

- **Aether Tamer** — field-combat interaction: Void Blitz (platform dive pre-staggers),
  Parry, a once-per-run death save, elemental-neutralizing strikes, cheaper shrine
  browsing of the whole stable.
- **Aether Alchemist** — shrine-centric: **Infusions** (shrine rituals trading Corruption
  for power), free Souls, XP from infusions.
- **Aether Maverick** — variance-centric: more Maverick (off-pool) skills, bravery-pick
  rebirth bonuses, party-wide buffs/debuffs scaling with build diversity.

Each class has its own meta-upgrade branch at Alioth, so class choice stays meaningful
across hundreds of runs.

---

## 12. Difficulty & Accessibility

- **4 difficulty modes** in EA; higher modes (Heroic, Mythic) pay +20%/+40% Worthiness —
  risk is rewarded in the permanent currency.
- Independent **accessibility toggles**: disable Corruption, weaken enemies — difficulty à
  la carte rather than one slider.
- EA reviews name readability (small combat icons) as the main UX risk of a dense keyword
  game; the studio shipped a combat-inspect feature mid-EA in response.

---

## 13. Art, Audio & UX Direction

- Detailed 2D **pixel art**, dark-fantasy palette, atmospheric rather than cute — tags and
  trailers position it closer to *Darkest Dungeon* mood than Pokémon brightness.
  **[MS-inferred]** Monster Sanctuary's readable side-view battle staging (two rows of
  three) carries over; monster silhouettes must read at small sprite sizes.
- UI must surface a heavy information load per turn: enemy intents, Poise diamonds, the
  shared Aether pool, statuses, Corruption. The EA lesson: **iconography is the
  bottleneck** — budget for an inspect/inspector mode from day one.
- Music: **[MS-inferred]** Monster Sanctuary shipped a prominent original soundtrack;
  expect per-biome themes.

---

## 14. Content Scope & Roadmap

**At EA (post-launch updates included):** 40 monsters × 2 forms, 19 types, 500+ abilities,
4 biomes, 4 difficulty modes, 2–3 classes, 2 Monster Deity fights, 4 meta-progression
systems, town decorations. 6 GB install; eight languages.

**Planned for 1.0 (~1.5 years of EA):** more monsters and biomes, an end-game area, more
Deity fights, more classes, multiple endings (including true endings), polish/QoL;
price increase at 1.0. Major updates roughly quarterly.

> **Scope takeaway:** EA shipped with ~28 monsters and 3 biomes and was received "Very
> Positive." A tight, systemic core with ~30 monsters is a shippable first slice for this
> genre.

---

## 15. Known Issues & Lessons from Reception

Early Access reception is strongly positive (~93%), but the documented critiques map
exactly where this design is fragile — a checklist of traps for any game borrowing
from it:

1. **Iconography was the bottleneck.** Reviewers found combat symbols small and hard to
   decipher, with abilities sometimes looking different in combat than in the monster's
   inspect menu. The studio had to retrofit a combat-inspect feature mid-EA (January
   2026). *Lesson: a keyword-dense battler needs an inspect mode and an icon legibility
   pass in the first shipped build, not as a patch.*
2. **Procedural layout alone reads as repetitive.** "Short runs" and "repetitive biomes"
   are the recurring cons — 3–4 rooms per biome plus a room-type choice is not enough
   structural variety by itself; the variety players praise comes from the monster draft
   and team composition. *Lesson: in a run game, build variety is cheaper and more
   durable than map variety; budget content accordingly.*
3. **Interlocking currencies cost onboarding.** One reviewer needed several runs just to
   understand most mechanics: five Aether kinds, Poise, Corruption, Worthiness, Gold,
   Crystals, Souls, Mementos, and Soulbonds each introduce a named concept. *Lesson:
   every keyword and currency is an onboarding tax — count them as a budget.*
4. **Flavor-only town NPCs disappoint.** Rescued NPCs settle in town with dynamic
   dialogue but no quests, shops, or friendship mechanics in EA, and reviewers asked for
   more. *Lesson: if the town is the emotional payoff for runs, its inhabitants need
   mechanical hooks, not just lines.*
5. **Some boss fights underwhelm** relative to regular encounters (a review con, stated
   without diagnosis). *Lesson at minimum: bosses must showcase the Aether/Poise systems,
   not bypass them.*

Counterweights that demonstrably worked: death-without-loss (Worthiness + Mementos
preserving attachment through permadeath), the shared Aether economy, capture-as-combat,
and telegraphed enemy intents — all praised across reviews. Notably, this second game
from the studio launched into EA polished enough to hold "Very Positive" from day one.

---

## 16. Multiplayer & Social

**There is none — by design.** The Steam feature list is single-player, Steam Cloud, and
Family Sharing only; no trading, co-op, or PvP exists or is announced for 1.0.
**[MS-inferred]** *Monster Sanctuary* shipped online PvP duels, so PvP is the most
plausible eventual addition, but the EA roadmap doesn't mention it.

Because Monster Realm *is* multiplayer, it's worth separating which parts of this design
assume a single player (and would need rework) from which port cleanly:

| Aethermancer system | Under multiplayer |
|---|---|
| Shared team Aether pool | Assumes one controller; co-op would need per-player pools or a negotiation layer |
| Player always acts first, free action ordering | No initiative concept at all — PvP needs one (Monster Realm already has `tactics::initiative`) |
| Run-scoped resets (levels, gear, gold) | Conflicts with a persistent shared world; the equivalent is instanced expeditions with account-scoped take-home (crystal/Worthiness analogues) |
| Worthiness, Mementos, Soulbonds, vendor meta-upgrades | Port cleanly — all per-account state |
| Single-use shrines, room-choice pathing | Fine inside an instance; meaningless in a shared overworld |

---

## 17. What Changed Since Monster Sanctuary (and Why)

The clearest window into the studio's design reasoning is what they kept, folded, or cut:

| Monster Sanctuary (2019–20) | Aethermancer (2025) | Why |
|---|---|---|
| Metroidvania world, monster overworld abilities | Procedural runs, *player-class* overworld abilities | Replayability over authored exploration; abilities stay but move to the player |
| Per-monster mana + combo meter | Shared elemental Aether pool | Same "ordering matters" payoff, one resource system instead of two |
| Type-effectiveness + buff/debuff web | No type chart; Poise element-matching | Keeps elements tactical without memorization |
| Fixed 3-branch skill trees, free respec | Per-level skill draft, scarce rerolls | Build variety per run instead of per planning session |
| Eggs from 1–6★ battle-performance rating | Stagger + Blank Memento mid-fight | Capture skill-gated *inside* combat; collection decoupled from the creature instance |
| Light/Dark shift (stat/skill bonus variants) | Shifted variants (own types/stats/signature trait) | Same collectible-depth doubling, bigger mechanical delta |
| One long save, keeper rank | Runs + Worthiness/Mementos/town | Roguelite framing; permanence relocated, not removed |
| Equipment + food permanent buffs | Run-scoped equipment/meals; Corruption cleansing | In-run economies reset so runs stay fresh |

---

## 18. Gap Ledger — Confirmed vs. Assumed vs. Unresolved

| Claim | Status |
|---|---|
| Release history, developer/publisher, price, reception, EA roadmap | Confirmed (Steam, launch coverage) |
| 3v3 turn-based combat; player acts first; artifact-use window; telegraphed intents | Confirmed (wiki, reviews) |
| No type-effectiveness chart; elements gate learnable Actions; two Elements or Wild per monster; three Types from 19 | Confirmed (wiki) |
| Poise diamonds (hit count + element), Wild always counts, Stagger = lose action + 50% damage taken | Confirmed (guides) |
| Capture = stagger + Blank Memento; Soulbonds; shrine rebirth with Souls; single-use shrines; party cap 3 | Confirmed (wiki, guides) |
| Worthiness point formulas, level thresholds, Perks, "only aspect that carries over between runs" | Confirmed (wiki, detailed) |
| Meta-upgrade catalog, vendors, costs, Memento gating | Confirmed (wiki) |
| **Aether kind count** | **Conflicting**: Steam says "four elements of Aether"; wiki/guides enumerate Fire, Water, Earth, Wind + Wild, and one guide also names "Aether" itself. Read as 4 elements + Wild wildcard **[inferred]** |
| **Corruption duration** | **Conflicting**: wiki says it lowers starting HP "in the next battle"; a guide says it persists all run. Read as accumulating run-long unless cleansed **[inferred]** |
| **Player class count** | **Version drift**: 2 at EA launch (Steam) vs. 3 in current upgrade trees (wiki) |
| **Roster size** | **Conflicting**: 28 at EA launch (news), 40 per current Steam copy, "over 50" per one review — patch drift plus loose counting of Shifted variants |
| Monster stat block (HP, attack scaling, crit, evasion) | **Assumed from MS**, plus confirmed fragments (max HP, crit chance, evasion appear in upgrade text) |
| Per-monster equipment slot layout (weapon + accessories) | **Assumed from MS** |
| Combo meter → Aether lineage; battle staging; per-biome music | **Assumed from MS** / inferred |
| Exact Aether generation/costs per action, base stat values, shrine Soul costs | **Unresolved** — unpublished; the wiki's mechanics pages are stubs |
| In-run level cap (~8 by a biome's end) | **Weakly sourced** — one guide at v0.7.1 |
| Maverick Skills' exact mechanics (off-pool skill offers) | **Inferred** from upgrade text |
| Multiplayer | Confirmed absent (Steam feature list) |

## 19. Using This Document for Monster Realm

Short notes mapping the above to Monster Realm's existing systems (multiplayer,
server-authoritative, tactical grid combat, taming/evolution/raising):

1. **Persistence table first (§8.5).** The single most clarifying artifact for a
   taming game: write Monster Realm's "persists vs. resets" table across battle / session
   / account scopes before detailing systems. Multiplayer makes this harder and more
   important.
2. **Score every role (§8.4).** Worthiness's published per-role exchange rates (damage,
   healing, prevention, denial, economy → one currency) is directly reusable for XP,
   rating, or recruit-chance formulas — and is a natural fit for an integer-only rules
   crate.
3. **Diegetic structure (§3).** Pick a premise that explains the game's loop (respawns,
   instanced encounters, trading) in-world.
4. **Capture as combat skill (§8.1).** Monster Realm's taming rolls could take a page
   from stagger-gated capture: make the *setup* the skill, the roll the reward.
5. **Vendors are progression UI (§10).** Meta-progression lines presented as town NPCs
   turn menus into worldbuilding — relevant to Monster Realm's NPC/dialogue/quest systems.
6. **Collection gates progression (§9).** "Requires N unique species" on upgrades makes
   the dex a key, not a trophy case.
7. **Readability is the boss (§12–13, §15).** A keyword-dense tactical battler lives or dies
   on iconography and an inspect mode; Aethermancer's EA reviews prove players forgive
   depth but not illegibility.
8. **Ship small but systemic (§14).** ~30 species, 3 biomes, one complete loop — the EA
   reception validates a tight first slice over roster breadth.

---

## Sources

- [Steam store page](https://store.steampowered.com/app/2288470/Aethermancer/) — features, EA plan, content counts, tags, reviews
- [Official wiki — game page](https://aethermancer.wiki.gg/wiki/Aethermancer_(Game)), [Combat](https://aethermancer.wiki.gg/wiki/Combat), [Rebirth](https://aethermancer.wiki.gg/wiki/Rebirth), [Worthiness](https://aethermancer.wiki.gg/wiki/Worthiness), [Meta-upgrades](https://aethermancer.wiki.gg/wiki/Meta-upgrades)
- [Destructoid EA review](https://www.destructoid.com/reviews/aethermancer-early-access-review/) — run structure, UX critique
- [RPG Site EA announcement](https://www.rpgsite.net/news/18175-aethermancer-steam-early-access-release-date-creature-collector-roguelike-with-turn-based-combat), [RPGamer](https://rpgamer.com/2025/08/aethermancer-coming-to-steam-early-access-in-september/), [GamingOnLinux](https://gamingonlinux.com/2025/08/monster-taming-roguelite-aethermancer-from-the-monster-sanctuary-devs-arrives-september-23) — release history
- [Bonus Action guide](https://bonus-action.com/guides/aethermancer-guide-best-monsters-teams-starters/), [AI-Owl strategy guide](https://ai-owl.com/aethermancer-guide/) — capture flow, NPC roles, team archetypes, Corruption economy
- *Monster Sanctuary* (moi rai games, 2019/2020) — basis for all **[MS-inferred]** fills
