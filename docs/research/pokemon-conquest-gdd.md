---
title: "Pokémon Conquest — Reference Game Design Document"
slug: pokemon-conquest-gdd
domain: gameplay
tags: [monster-taming, tactics, grand-strategy, link-system, type-system, recruitment, kingdom-management, gdd-reference]
status: active
updated: 2026-11-06
confidence: medium
sources: 20
supersedes:
abstract: "Reconstructed GDD for Pokémon Conquest (DS, 2012): link system, tactics battles, kingdom layer; monster-realm reference."
---

# Pokémon Conquest — Reference Game Design Document

> **Provenance note.** This is a *reconstructed* GDD: no official design document for
> *Pokémon Conquest* was ever published. It was assembled from Wikipedia, Bulbapedia,
> Serebii, veekun's Conquest dex, GamerGuides, WikiDex, and launch-era coverage. Claims
> the sources did not confirm are marked **[assumed]** (confident recall, unverified
> this pass) or **[unresolved]** (sources conflict or are silent). A gap ledger is at
> the end. Written as inspiration for the monster-realm GDD — the "why it works" notes
> matter more than the exact numbers.

## 1. Overview

| | |
|---|---|
| **Title** | Pokémon Conquest (JP: *Pokémon + Nobunaga's Ambition*) |
| **Developer** | Tecmo Koei (programming, art, sound); design shared with The Pokémon Company |
| **Publisher** | The Pokémon Company (JP), Nintendo (worldwide) |
| **Director / Producer** | Osamu Mieda / Hisashi Koinuma |
| **Release** | JP March 17, 2012; NA June 18, 2012; EU July 27, 2012 |
| **Platform** | Nintendo DS (single cart, local wireless 1–2 players) |
| **Genre** | Tactical RPG + light grand strategy, crossover of two franchises |
| **Content scale** | 200 Pokémon, 200 Warriors (nearly all real Sengoku-era figures), 17 kingdoms |
| **Length** | ~20 hour main story; 33+ post-game episodes multiply that several times over |
| **Reception** | Metacritic 80; IGN 9/10, Famitsu 34/40, Game Informer 7/10 |
| **Sales** | 172k first week in Japan (#1 that week); 341k in Japan by end of 2012 |

**High concept.** Feudal-Japan war story meets monster collecting. The player is a
young Warlord who must unite the 17 kingdoms of Ransei by winning grid-based tactics
battles, where every unit is a *pair*: one human Warrior bonded ("linked") to one
Pokémon. Growth, recruitment, and evolution all run through the strength of that bond
instead of experience levels. A kingdom-management layer between battles turns the
collect-a-thon into a war campaign.

**Why it matters as a reference.** Conquest is the best-known proof that the
monster-taming loop (catch → bond → evolve → collect) survives being transplanted
into a completely different battle genre — and that the *bond* can replace the XP
level as the single growth number.

## 2. Audience and player fantasy

**Who it was built for.** Two audiences with very different literacy, on purpose:

1. **Pokémon players, including children.** Famitsu's praise centered on how
   approachable the game is for young and genre-new players. Every simplification in
   this document (one move, four stats, one growth number) exists to serve them.
2. **Koei strategy fans and lapsed SRPG players.** The crossover began because The
   Pokémon Company's president, Tsunekazu Ishihara, was a *Nobunaga's Ambition* fan
   and pitched Koei's Hisashi Koinuma directly. Koinuma said the hardest part of
   development was tuning the challenge so Pokémon fans could clear it — the
   strategy audience was instead served by the post-game (§14).

Western marketing leaned on the slogan **"A new way to play Pokémon"** because
strategy RPGs were considered a niche genre outside Japan — the brand carried the
genre, not the other way around.

**The fantasies being sold** (worth naming explicitly, since a GDD should commit to
them):

- **The commander fantasy** — raise an army, hold territory, unite a map. New to
  Pokémon; supplied by the Koei half.
- **The collection fantasy** — complete the gallery (200 Pokémon, 200 Warriors,
  one Perfect Link each). Carried over intact from the Pokémon half.
- **The crossover fantasy** — famous historical warlords, drawn as anime
  characters, bonded to fitting monsters (Nobunaga gets Zekrom). Fan service as a
  content pillar, not an afterthought.

**Design consequences.** Easy main campaign, aggressive onboarding, no difficulty
options; all mastery content (perfect links, ranks, legendaries, hard episodes)
pushed past the credits. The split works, but §14's criticisms are the bill for it.

## 3. Design pillars

1. **The pair is the unit.** A Pokémon is never fielded alone and neither is a human.
   Warrior choice changes a Pokémon's ceiling, its passive support, and its one-shot
   battle skill; Pokémon choice changes range, movement, and typing. Team-building is
   a matching problem, not a stat race.
2. **One bond number replaces the level curve.** Link % is simultaneously the XP bar,
   the stat multiplier, the evolution trigger, and the "friendship" meter. One number,
   four jobs — extremely easy to read, still deep to optimize.
3. **One move per Pokémon.** Each species knows exactly one move (usually its
   signature, e.g. Excadrill's Drill Run). Depth moves out of the moveset menu and
   into positioning: range shape, area of effect, knockback, and terrain do the work
   four move slots would normally do.
4. **Two game speeds that feed each other.** A slow monthly kingdom layer (economy,
   recruiting, garrisons) sets up a fast tactical layer (6v6 grid battles), and every
   battle result flows back into the map. Neither layer is deep alone; the loop
   between them is the game.
5. **Everything is recruitable, through play.** Beaten enemy Warriors join you if you
   beat them *stylishly* (fast, super-effective, or untouched). Wild Pokémon join
   through a timing minigame plus personality compatibility. Recruitment is a skill
   expression, not a drop table.
6. **Accessibility first, mastery later.** Small stat set, one move, visible type
   advice, auto-delegation of kingdoms. The optimization game (perfect links, warlord
   ranks, episode completion) is layered on top and never required.

## 4. Story, setting, and tone

**Setting.** Ransei: a war-torn region of **17 kingdoms**, each themed after one of
the (Gen V-era) 17 Pokémon types. The geography *is* the type chart: each kingdom's
castle, battlefield, wild Pokémon, and resident Warriors all express its type
(full table in §5).

**The legend.** Whoever unites all 17 kingdoms will meet the legendary Pokémon said
to have created Ransei (Arceus). This legend motivates every faction, including the
antagonist.

**Premise.** The player, a newly-minted teenage Warlord of Aurora (notably able to
understand Pokémon speech), allies with **Oichi**, who warns that **Nobunaga**, the
Warlord of Dragnor, is conquering Ransei to seize/destroy Arceus's power. The main
story is a straightforward conquest campaign: defend Aurora, take kingdoms one by
one, beat Nobunaga, meet Arceus, win a final rematch. Kingdoms are returned to
their owners afterward — which cleanly resets the board for the post-game episodes.

**Tone.** Kid-friendly Sengoku. Real historical warlords (Nobunaga, Hideyoshi,
Ieyasu, Kenshin, Shingen…) drawn in bright anime style; war with zero death.
Localization deliberately kept the Japanese names and setting intact. The tone
proves a licensed collect-em-up can carry a "serious" historical frame without
aging up its rating.

## 5. The 17 kingdoms (content table)

The kingdom list is the game's master content spec: one row defines a region's type
identity, boss, battlefield twist, and economy. Types and warlords are confirmed;
battlefield notes are confirmed where cited, **[assumed]** where from recall, "—"
where unknown.

| # | Kingdom | Type | Warlord | Battlefield / gimmick |
|---|---|---|---|---|
| 1 | Aurora | Normal | the player (Hero/Heroine) | Plain introductory field; 20-turn defeat-all battles. A wild-skirmish sub-map (the Ravine, 10 turns) with a treasure-box tile |
| 2 | Ignis | Fire | Hideyoshi | Lava flows, lava beds, and fire spouts to fight around |
| 3 | Greenleaf | Grass | Motonari | — (forest theming) |
| 4 | Fontaine | Water | Motochika | Water channels; Water-types cross terrain others must route around |
| 5 | Violight | Electric | Ginchiyo | Electric tiles, switches, and a map-wide "electric system" (paralysis hazards) |
| 6 | Chrysalia | Bug | Yoshimoto | — |
| 7 | Pugilis | Fighting | Yoshihiro | Elevated arena ring of banners: hold all banners 5 turns to win, banner tiles heal, edge hits knock units off the ring; 30-turn limit |
| 8 | Terrera | Ground | Shingen | Desert with oases, lifts, and a wind gust; win by claiming all 3 banners; 20-turn limit |
| 9 | Illusio | Psychic | Kenshin | Warp panels **[assumed]** |
| 10 | Cragspur | Rock | Ujiyasu | — (cliff/elevation theming **[assumed]**) |
| 11 | Avia | Flying | Masamune | Floating islands with springboards that bounce units around **[assumed — a review describes the map without naming the kingdom]** |
| 12 | Viperia | Poison | Nene | Poison swamp tiles **[assumed]** |
| 13 | Yaksha | Dark | Kotarō | — |
| 14 | Valora | Steel | Ieyasu | Mechanical castle with moving passages **[assumed — same caveat as Avia]** |
| 15 | Spectra | Ghost | Nō | Roaming fireballs that move between turns and inflict burn/freeze/paralysis/poison/sleep/confusion on contact; statues |
| 16 | Nixtorm | Ice | Mitsuhide | Ice tiles **[assumed]** |
| 17 | Dragnor | Dragon | Nobunaga | Indoor final map with Revival Nodes — white tiles that heal HP and cure status of adjacent units |

Points to copy from the shape of this table, not just its contents:

- **One type per region, no repeats** — the roster of regions and the type chart are
  the same list, so "where am I?" always answers "what will I fight and what should
  I bring?"
- **The gimmick is the type, mechanized.** Fire = hazard floor, Fighting = arena
  ring, Ghost = roaming status hazards, Dragon = endurance map with healing nodes.
  Each battlefield teaches its type's fantasy through terrain rules.
- **Objectives and turn limits vary per row** (defeat-all 20 turns; claim 3 banners;
  hold banners 5 turns within 30) — map variety carries the battle variety that
  one-move units can't (§3 pillar 3, §14).
- **Facilities are also type-flavored per row** (Violight has a power plant,
  Nixtorm an icy peak, Dragnor a dragon chamber), so the strategy layer re-uses the
  same theming budget.

## 6. Core gameplay loop

```
STRATEGY LAYER (one turn = one month)
  assign each Warrior one action:
    march on an adjacent kingdom ──────────────┐
    visit a facility (shop / train / heal)     │
    search wild areas for Pokémon/Warriors     │
    mine gold, delegate, defend                │
                                               ▼
TACTICS LAYER (6v6 grid battle, turn limit)
  win castle battle → take kingdom, loot, recruit offers
  lose → army retreats, kingdom stays enemy
                                               │
  link % gains, evolutions, new recruits ◄─────┘
  → back to the map; enemy armies also act every month
```

Session texture: a month of planning takes a minute or two; a battle takes 5–15
minutes. The two long loops on top are **completion** (200 Pokémon, 200 Warriors,
perfect links) and the **episode treadmill** (§14).

## 7. Strategy layer: kingdoms, months, economy

- **Monthly turns.** The map advances in months. Every Warrior in your army takes
  **one action per month** — fight, move, shop, train, or search. Enemy kingdoms act
  too, including attacking kingdoms you hold, so garrisons matter.
- **Facilities.** Each conquered kingdom has type-flavored locations: a **shop**
  (items), a **Ponigiri shop** (feeds Pokémon to raise Energy, §8.3), a **bank**
  (invest 500 / 1,000 / 2,000 gold to level up another facility — leveling a shop
  expands its stock), **gold mines** (send Warriors to earn income), a **mystery
  spring** (pay 3,000 gold to reroll a Pokémon's ability; 10,000 for its rare third
  ability), and **wild areas** where new Pokémon and free Warriors appear.
- **Economy.** Gold is the only currency. Sources: mines, battle rewards, monthly
  income. Sinks: items, bank investments, springs. The real cost is *opportunity*:
  a Warrior mining gold is a Warrior not fighting or training this month.
- **Delegation.** Whole kingdoms can be flagged for AI self-management — the single
  most important anti-tedium valve once you hold 10+ kingdoms. Catch: delegated
  actions never trigger evolution checks (§13), a sharp lesson in making automation
  strictly *weaker* than manual play, never equal.
- **Monthly variety.** Random events, traveling merchants (exclusive stock, e.g. the
  best Ponigiri), and **Pokémon swarms** (a species floods a kingdom for the month,
  easier to link) roll each month, so identical months still differ.
- **Army capacity** scales with kingdoms held, up to **102 Warriors** at all 17 —
  the cap forces mid-game roster triage rather than hoarding.

## 8. Units: Warriors and Pokémon

### 8.1 Warriors (the human half)

- **Three stats:** Power, Wisdom, Charisma (roughly: battle support strength,
  skill/utility quality, recruiting/link affinity). Small, readable, and never the
  player's main lever — the Pokémon fights; the Warrior shapes it.
- **Type specialty.** Each Warrior has one or two specialty types that set their
  **maximum link** with each Pokémon (e.g. an Electric-specialist caps at 70% with
  Pichu but 50% with Magikarp). The cap system is how 200 × 200 pairings stay
  meaningful: most pairs work, few pairs excel.
- **Perfect Link.** Every Warrior has exactly **one evolutionary family** that can
  reach **100%** link — their "destined partner," usually mirrored in the character's
  costume. This gives every one of 200 collectibles a built-in chase goal.
- **Warrior Skill.** One active skill, usable **once per battle**: heals, stat
  surges, extra movement, skill-cancels; Warlord skills are unique and signature
  (Nobunaga's lets his Pokémon act twice with a flinch chance). The one-use limit
  makes skills tempo decisions instead of rotations.
- **Warlords** are the elite subset (gold icon; kingdom rulers and famous generals)
  with stronger stats, unique skills, unique art, and **ranks** (§13.2). Regular
  Warriors are the mass roster filling garrisons and mines.

### 8.2 Pokémon (the monster half)

- **Four battle stats:** HP, Attack, Defense, Speed — plus a species **movement
  range** (tiles per turn) and its single move. That's the whole statline; a
  Conkeldurr is HP 320 / Atk 285 / Def 165 / Spd 95 and Superpower, full stop.
- **One move,** species-fixed (§3 pillar 3). Moves carry power, accuracy, a **range
  shape** (adjacent, line, diagonal, multi-tile splash…), and often a rider:
  knockback, flinch, stat change, status. The move *is* the species' identity.
- **Abilities.** Each species draws from up to three passive abilities; an
  individual has one active (rerollable at a mystery spring). Passive, positional,
  or conditional (e.g. Levitate ignores ground hazards and obstacles).
- **Typing** uses the main-series chart (single and dual types, super-effective /
  not-very-effective / immune). Type is doing triple duty: damage math, kingdom
  theming, and Warrior specialty caps.

### 8.3 Energy (condition)

A 5-level mood/condition meter per Pokémon, shown as a single arrow icon:

- High energy = slightly higher stats **and faster link growth**; low = the reverse.
- Decays one level every 3 months regardless of use; restored by feeding **Ponigiri**
  (rice-ball tiers: +1 / +2 / +3 / +4 levels — better tiers gated behind shop levels
  and traveling merchants). The shopkeeper sometimes offers a free second helping
  that either tops energy out or backfires — a tiny push-your-luck beat.
- Design intent: a soft upkeep loop that pulls players back through conquered
  kingdoms and gives the economy a recurring, non-punishing sink.

## 9. The Link system (signature mechanic)

Link is a 0–100% bond between one Warrior and one Pokémon. It **replaces levels,
XP, and EXP curves entirely.**

- **Growth:** rises from acting in battles (bigger gains from harder fights and
  high energy); also nudged by some facilities and items. There is no XP number
  anywhere in the game.
- **Stats scale with link %.** A Pokémon's displayed stats are its species line
  scaled by the current link — switch the same Pokémon to a better-matched Warrior
  and it is immediately, visibly stronger.
- **Caps come from the Warrior** (specialty types, §8.1) and compatibility
  (the Warrior's personality vs. the Pokémon's nature, set at linking time —
  mismatches cap lower). Perfect Links (100%) are one family per Warrior.
- **Evolution and Warlord rank-ups key off link thresholds** (§13), so the one
  number also drives the two biggest "payoff" moments in the game.

**Why it works.** Every system reads and writes the same scalar, so the player
always knows what to do ("raise the bond") and the UI only ever has to teach one
meter. The cost: per-individual variety is thin — two Jigglypuff at 60% are
identical — Conquest spends its variety budget on *pairings* instead of IVs.

## 10. Tactical battle system

**Format.** Up to **6 Warrior–Pokémon pairs per side** on a handcrafted grid map
(one map per kingdom, plus wild-area skirmish maps). Armies alternate phases; on
your phase each pair moves up to its range and may attack / use an item / trigger
its Warrior Skill **[assumed — phase structure from recall]**.

**Objectives vary by map.** The default is "defeat all enemy Pokémon," but several
castles use alternates — Pugilis requires holding every banner simultaneously for 5
turns (the enemy can win the same way), Terrera requires claiming its 3 banners.
Battles carry **per-map turn limits** (20 turns at Aurora and Terrera, 30 at
Pugilis, ~10 for wild skirmishes); timing out is a loss for the attacker, which
makes stalling a real defensive strategy.

**Terrain is the fourth stat.** Every kingdom's battlefield expresses its type as a
mechanic (full table in §5): Ignis's lava and fire spouts, Violight's paralyzing
electric tiles and switches, Spectra's roaming status-inflicting fireballs,
Terrera's lifts and wind gust, Dragnor's healing Revival Nodes, Pugilis's
knock-off-the-edge arena ring. Flying/Levitate-style mobility explicitly bypasses
ground hazards — so typing matters even before damage is rolled.

**No KO permanence.** A KO'd Pokémon is out for the battle; the pair retreats and is
fine next month. All attrition is positional and within-battle; the campaign-level
cost of losing is tempo (the month) and ground (the kingdom), not units. This keeps
the war layer friendly and the roster disposable-free.

**In-battle support:** consumable items are carried by Warriors and used on their
Pokémon; one Warrior Skill per Warrior per battle (§8.1).

## 11. Opposition and AI design

What the AI actually does (from reviews, community documentation, and recall —
Conquest shipped no difficulty options, so the AI *is* the difficulty):

- **Tactical AI is deliberately beatable.** Contemporary and retrospective coverage
  agrees the battle AI is passive and exploitable for most of the game —
  TV Tropes bluntly calls it "strategically incompetent"; Smogon's review opens
  with "Pokémon Conquest is easy." Documented exploits include enemies idling on
  objective tiles (standing on a banner and never leaving) and defenders waiting
  in place while the player sets up **[behavior partially assumed]**.
- **Difficulty is delivered by content, not cleverness.** The curve comes from
  enemy stats, rosters, type coverage, and map hazards rising — late-game maps
  "introduce battlefields with all manner of natural hazards" — and from the
  post-game episodes, where enemy armies also become *strategically* aggressive
  and start invading castles on the map layer frequently.
- **Map-layer pressure is real but gentle in the main story:** enemy kingdoms can
  attack your holdings each month, forcing garrison decisions, but rarely press an
  advantage hard until the post-game **[assumed]**.

**The design reading — weak AI is load-bearing here.** Recruitment (§12) demands
the player win *fast, super-effectively, or untouched*. Those conditions are only
reliably achievable against an opponent that lets you dictate the fight. A sharper
AI would directly starve the army-building loop; Conquest chose recruitment feel
over challenge and took the review hit (Game Informer's 7/10) for it. The honest
lesson for any recruit-by-performance design: **AI sharpness and recruit
conditions are one tuning surface, not two.** If the AI gets smarter, the style
conditions must get looser, or recruitment dies.

A second lesson: with no difficulty options, the two audiences of §2 got one
curve, and reviews from the strategy side dinged exactly that. Separate dials (or
an episode-style hard track available earlier) would have cost little.

## 12. Recruitment

### 12.1 Enemy Warriors — "impress them"

A defeated enemy Warrior offers to join your army if, during the battle, you beat
them while meeting **any one** of:

1. KO their Pokémon **within 4 turns** of the battle starting;
2. KO it **with a super-effective move**;
3. KO it **without their Pokémon ever damaging yours**.

**Warlords** demand the same *plus* the finishing blow must come from another
Warlord's Pokémon — rank respects rank.

**Why it works.** The conditions are exactly "play fast, play the type chart, play
clean" — the game's three skill axes — so recruiting doubles as a skill tutorial,
and every battle vs. humans carries a side-quest the player sets for themselves.
It also means your army is literally built out of your best-played fights.

### 12.2 Wild Pokémon — the linking minigame

Wild Pokémon appear in kingdom wild areas (refreshing monthly, boosted by swarms).
Linking is a short **timing minigame** (press on the beat as orbs align — reviewers
compared it to a rhythm game) rather than an item throw. Success and the resulting
link ceiling depend on the Warrior's personality vs. the Pokémon's nature. Energy
and the chosen Warrior matter; there is no "ball" economy at all.

### 12.3 Starter

The player starts with a single **Eevee** — a deliberate pick: its branching
evolutions showcase the condition-based evolution system (§13) and give the
protagonist a flexible type identity.

## 13. Evolution

### 13.1 Pokémon

No levels means no level-up evolution. Every evolution is a **condition**, checked
whenever the pair completes a *manual* action (never a delegated one):

| Trigger class | Example |
|---|---|
| Link % threshold | most lines evolve around **50–70%** link |
| Stat threshold | Timburr → Gurdurr: finish an action with **Attack ≥ 81** |
| Deed-based | Gurdurr → Conkeldurr: land a KO that makes a Warrior offer to join, at **≥ 60%** link (replaces trade evolution) |
| Item + condition | held evolution items, sometimes combined with a recruitment-style deed |
| Location | win/act in a specific kingdom (replaces location evolution) |

Known wart: a stat-based evolution can *block* an intended item-based branch —
players deliberately lower Energy to duck under the stat check. Lesson: when
multiple evolution paths can be simultaneously true, the player needs an explicit
choice, not a priority rule.

### 13.2 Warlords rank up too

Warlords have **Rank I / Rank II** forms: new art, better stats, a new unique
skill, sometimes a new specialty type. Rank-ups trigger on character-specific
conditions, usually "reach X% link with a specific (often legendary-adjacent)
Pokémon." Non-player Warlords can only rank up in the post-game. Humans getting
"evolutions" with the same vocabulary as the monsters is a big part of the
crossover's charm — and doubles the collection checklist.

## 14. Progression, post-game, replay structure

- **Main story** ("The Legend of Ransei"): ~20 hours, gentle difficulty, fixed
  protagonist; functions as the long tutorial for the systems above.
- **Post-game: 33 special episodes** (Serebii's count; Bulbapedia's story list
  counts up to 37 with Wi-Fi extras **[unresolved]**). Each episode is a **mini
  campaign starring a different Warlord**: a fresh slice of the Ransei map, its own
  premise and win condition (unify N kingdoms, collect 100 Pokémon, beat a rival
  before an in-game date…), with partial roster/link resets. 8 are open
  immediately; the rest unlock by clearing episodes and meeting milestones
  (befriend 40 Warlords, 100 Pokémon…). A final episode ("The Two Heroes of
  Ransei") reruns the grand campaign with everything unlocked.
- **Why this structure is clever:** the episodes reuse 100% of the existing map,
  roster, and systems while changing only the starting state and goal — dozens of
  hours of content for near-zero new assets. They also let every major historical
  figure be *playable protagonist* for an evening, which is the crossover fantasy
  fulfilled.
- **Legendaries** (Arceus, Reshiram, Zekrom, Mewtwo, etc.) are post-game chase
  content, gated behind specific ranked-up Warlords, episodes, and link conditions.

## 15. Multiplayer and live content

Thin by design — Conquest is a single-player game with garnish:

- **Local wireless 1v1** tactics battles between two carts.
- **Passwords** (codes publishable in magazines/online) spawn rare wild Pokémon.
- **Wi-Fi episode downloads** delivered a drip of extra episodes post-launch.

The takeaway is less the features than the restraint: the recruit/link/episode
loops are all single-player-complete, and multiplayer never touches the campaign.

## 16. Presentation, UX, and screen inventory

**Screen inventory** (reconstruction — the set of screens and what each commits to
showing; layout details **[assumed]** where unsourced):

| Screen | Job | Always-visible info |
|---|---|---|
| Region map (strategy hub) | pick this month's actions | 17 kingdom nodes, who holds what, army positions, current month |
| Kingdom view | spend a Warrior's action | facility slots, stationed Warriors/garrison, kingdom gold |
| Army management | roster triage, equip, re-pair | Warrior↔Pokémon pairs with link %, specialty types, energy arrows |
| Battle (bottom screen) | the tactics fight | isometric grid, units, objective + turn counter |
| Battle (top screen) | remove memorization | selected unit's stats and move, type-effectiveness forecast vs. target |
| Link minigame | catch wild Pokémon | timing orbs, Warrior/Pokémon compatibility feedback |
| Gallery | completion chase | Pokémon and Warrior collections with Perfect-Link progress |
| Episode select (post-game) | replay structure | episode list, difficulty stars, unlock conditions |

**Readability decisions worth copying:**

- The DS's second screen is spent entirely on **removing memorization**: type
  matchups and stats are *always* on screen during battle, so the type chart is
  advice, not homework.
- **One move per unit means every enemy's threat is fully predictable** from its
  position — the whole battlefield can be read at a glance, which is what lets the
  game stay fun for the §2 audience without a tutorial wall.
- **Link % is surfaced everywhere a Pokémon's name appears**, because it is the
  only number that matters; the player can never be confused about what to grow.
- **Costumes telegraph Perfect Links** — character art doubles as a collection
  hint system.
- Recruit conditions are implicit but consistent, so the community compressed them
  to one sentence; a modern design should just show them.

**Art & audio.** Bright anime portraits for 200 humans; isometric chibi battle
sprites; each kingdom visually themed to its type; Koei's orchestral Sengoku style
over Pokémon motifs.

## 17. Balance and known issues (lessons)

What the 2012 reception and later retrospectives consistently flag:

1. **The tactics AI is passive and the main story is easy** (§11). Veterans of
   SRPGs found little resistance until the post-game. *Lesson: when two genres
   share one difficulty dial, tune for the stricter audience's floor, not the
   laxer one's — or ship two dials.*
2. **One-move depth runs out.** Late game, fights between full teams of
   single-move units get repetitive; the map variety of §5 and the episode
   structure (new goals) paper over it. *Lesson: if units are simple, the variety
   budget must ship in objectives and maps — Conquest's banner maps and turn
   limits are doing load-bearing work.*
3. **Post-game grind spikes.** Perfect links, warlord ranks, and legendaries swing
   from "gentle story" to "hundreds of battles" with no middle gear. *Lesson:
   collection chases need intermediate milestones, not a cliff.*
4. **Delegation that can't evolve Pokémon** quietly punishes the anti-tedium
   feature players most need late game. *Lesson: automation should be worse than
   manual play by a visible, chosen margin — not by a hidden rule discovered on a
   wiki.*
5. **What clearly worked:** the link-as-level unification, recruit-by-style
   conditions, type-themed kingdoms making the type chart physical, the pair-unit
   team builder, and the episode replay structure — these are the five ideas the
   game is remembered for.

## 18. Takeaways for monster-realm

(Project-local notes; the rest of the doc is general.)

1. **Link-as-level** is the cleanest precedent for collapsing XP, friendship, and
   evolution-readiness into one server-side scalar per (tamer, monster) pair —
   cheap to store, trivially explainable, and it makes *who raised it* part of a
   monster's identity. Caps-by-affinity is how it stays a decision.
2. **Recruit-by-performance** (fast / super-effective / untouched ⇒ join offer)
   is a richer recruit model than a flat catch roll and is pure server-side math
   over the battle log — it composes with the existing recruit/taming flow and
   with [[red-team-tests-by-writing-the-cheat]]-style gating since conditions are
   objectively checkable. Caveat from §11: this mechanic and encounter AI are one
   tuning surface — sharper AI must come with looser style conditions.
3. **One-move (or few-move) units** are worth considering for monster-realm's
   tactical layer: species identity through range shape + rider effect keeps the
   combat UI small and makes enemy intent fully readable — a big win in
   multiplayer where opponents' threats must be legible at a glance.
4. **Type-themed territory** (each region expresses one type as terrain mechanics,
   spawns, and theming) turns `type_chart.ron` from a damage table into level
   design — and gives the overworld's encounter bands a natural organizing axis.
5. **The §5 kingdom table is a content-spec format to steal outright**: one row
   per region = type identity + boss + battlefield twist + objective variant +
   facilities. A monster-realm GDD section shaped like that table becomes the
   region backlog directly.
6. **The episode structure** is the cheapest replay multiplier in the reference
   set: same map + same systems + new starting state and win condition. For a
   persistent multiplayer world the analogue is seasonal scenarios/resets rather
   than post-game unlocks.
7. **Energy/condition as soft upkeep** is a light-touch retention loop (decay on
   a long timer + a cheap feed interaction) — but Conquest shows it must stay
   *soft*: ±small stats and link-gain speed, never a hard lockout.
8. **Anti-lessons (§17)**: don't let automation silently disable progression
   checks; don't ship a single difficulty curve across two genres' audiences; and
   if units are simple, invest the saved complexity in objectives and maps.

## 19. Glossary

The game's invented vocabulary — a model for the "ubiquitous language" section a
GDD should open with:

| Term | Meaning |
|---|---|
| **Ransei** | The region: 17 type-themed kingdoms |
| **Kingdom** | One territory node: castle battlefield + facilities + wild areas + garrison |
| **Warrior** | A human unit; pairs with one Pokémon to form the fielded unit |
| **Warlord** | Elite Warrior: unique art/skill, can hold kingdoms, has Ranks |
| **Rank (I/II)** | A Warlord's "evolution": new art, stats, and skill, via a character-specific condition |
| **Link** | The 0–100% bond of one Warrior–Pokémon pair; the game's only growth number |
| **Perfect Link** | The one evolutionary family a given Warrior can take to 100% |
| **Specialty** | A Warrior's 1–2 types; sets their link caps per Pokémon |
| **Warrior Skill** | A Warrior's once-per-battle active ability |
| **Energy** | 5-level per-Pokémon condition meter; small stat and link-gain modifier |
| **Ponigiri** | Rice-ball food item/shop that restores Energy (tiers +1…+4) |
| **Delegation** | Flagging a kingdom for AI self-management; delegated actions skip evolution checks |
| **Swarm** | A monthly event flooding a kingdom with one easily-linked species |
| **Episode** | A post-game mini-campaign: new protagonist, starting state, and win condition on the same map |

## 20. Gap ledger — confirmed vs. assumed

| Claim | Status |
|---|---|
| Release data, credits, sales, scores | Confirmed (Wikipedia) |
| 17 type-themed kingdoms; legend of Arceus; Nobunaga premise; Eevee starter | Confirmed (Wikipedia, Bulbapedia) |
| Kingdom ↔ warlord table (all 17) | Confirmed (WikiDex, cross-checked with press/guides) |
| Kingdom ↔ type table | Aurora=Normal, Pugilis=Fighting, Terrera=Ground, Spectra=Ghost, Violight=Electric, Ignis=Fire, Nixtorm=Ice, Dragnor=Dragon confirmed; rest from recall, corroborated by themed facilities **[high confidence]** |
| Battlefield gimmicks: Ignis, Violight, Terrera, Spectra, Dragnor, Pugilis (incl. objectives & turn limits) | Confirmed (Bulbapedia kingdom pages via search, GamerGuides, press) |
| Battlefield gimmicks: Illusio, Nixtorm, Viperia, Cragspur; Avia/Valora attribution of reviewed maps | **[assumed]** |
| 200 Pokémon; 200 Warriors; 102 army cap; Sengoku figures | Confirmed (Wikipedia, Bulbapedia) |
| One move per species; 4 stats (HP/Atk/Def/Spd); up to 3 abilities | Confirmed (Wikipedia, veekun) |
| Link replaces XP; caps by specialty (70%/50% example); Perfect Link = 100%, one family per Warrior | Confirmed (Bulbapedia) |
| Warrior recruit conditions (4 turns / super-effective / untouched; Warlord-only finisher for Warlords) | Confirmed (Bulbapedia) |
| Wild linking = timing minigame + personality/nature compatibility | Confirmed (Wikipedia, Grokipedia) |
| Evolution condition classes + Timburr line numbers; delegated actions skip evolution checks | Confirmed (veekun, Bulbapedia) |
| Energy: 5 levels, Ponigiri +1/+2/+3/+4, decay 1 level / 3 months, stat & link-gain effects | Confirmed (Bulbapedia) |
| Bank invest tiers 500/1k/2k; mystery spring 3k/10k | Confirmed (Bulbapedia) |
| 33 special episodes, 8 initially, final episode unlock | Confirmed (Serebii); Bulbapedia counts up to 37 with Wi-Fi extras **[unresolved]** |
| AI "strategically incompetent" / easy; objective-tile idling; post-game map aggression | Confirmed (TV Tropes, Smogon, Metacritic user reports — community sources, not formal docs) |
| Alternating army phases; main-story map-layer passivity; screen layout details | **[assumed]** |
| Warrior stats Power/Wisdom/Charisma | Confirmed (Grokipedia) — exact gameplay effects **[unresolved]** |
| Origin story (Ishihara fan pitch; Koinuma on balancing); "A new way to play Pokémon" slogan rationale | Confirmed (Wikipedia) |

## 21. Sources

- [Wikipedia — Pokémon Conquest](https://en.wikipedia.org/wiki/Pok%C3%A9mon_Conquest)
- [Bulbapedia — Link (Conquest)](https://bulbapedia.bulbagarden.net/wiki/Link) *(via search snippets; direct fetch blocked)*
- [Bulbapedia — Warrior](https://bulbapedia.bulbagarden.net/wiki/Warrior) *(via search snippets)*
- [Bulbapedia — Warrior Skill](https://bulbapedia.bulbagarden.net/wiki/Warrior_Skill) *(via search snippets)*
- [Bulbapedia — Ponigiri / item pages](https://bulbapedia.bulbagarden.net/wiki/Ponigiri) *(via search snippets)*
- [Bulbapedia — Kingdom location / Kingdom event](https://bulbapedia.bulbagarden.net/wiki/Kingdom_location) *(via search snippets)*
- [Bulbapedia — Terrera / Spectra / Violight / Dragnor kingdom pages](https://bulbapedia.bulbagarden.net/wiki/Terrera) *(via search snippets)*
- [WikiDex — Ransei (kingdom/warlord/facility table)](https://www.wikidex.net/wiki/Ransei)
- [Serebii — Conquest section index](https://serebii.net/conquest/)
- [Serebii — Battle mechanics](https://serebii.net/conquest/battle.shtml)
- [Serebii — Special episodes](https://serebii.net/conquest/episodes.shtml)
- [veekun — Conquest dex (Conkeldurr)](https://veekun.com/dex/conquest/pokemon/conkeldurr)
- [GamerGuides — Pokémon Conquest kingdom walkthroughs](https://www.gamerguides.com/pokemon-conquest/guide/the-main-kingdoms/kingdoms-one-to-seventeen)
- [Grokipedia — Pokémon Conquest](https://grokipedia.com/page/Pok%C3%A9mon_Conquest) *(used only where corroborated)*
- [StrategyWiki — Pokémon Conquest](https://strategywiki.org/wiki/Pok%C3%A9mon_Conquest/Table_of_Contents)
- [Ludo.guide — evolution mechanics](https://www.ludo.guide/guide/pokemon-conquest/evolution-mechanics)
- [Nintendo Fandom wiki — Pokémon Conquest](https://nintendo.fandom.com/wiki/Pok%C3%A9mon_Conquest)
- [Smogon — Pokémon Conquest review](https://www.smogon.com/smog/issue21/review)
- [Destructoid — Pokémon Conquest review](https://www.destructoid.com/reviews/review-pokemon-conquest/)
- [Nintendo press — new features reveal (battlefield descriptions)](https://purenintendo.com/nintendo-reveals-new-features-to-conquer-in-pokemon-conquest/)
