---
title: "Monster Realm — Game Design Document"
slug: monster-realm-gdd
domain: gameplay
tags: [monster-taming, turn-based-combat, gdd]
status: active
updated: 2026-08-04
confidence: low
sources: 0
supersedes:
abstract: "Early draft of a game design document for the monster-realm project. Several sections may be out-of-date."
---

# Monster Relm — Game Design Document

> **What this is.** An early rough-draft of a GDD for *Monster Realm*, written 2026-08-04 as
> reference material.
>
> **How to read it.** Nothing is to be considered finalized and several sections may contain
> outdated information. Treat with caution. Additionally, this is an initial rough draft and
> does not contain all available information. Many sections are not exhaustive and lack key
> details. Thin sections may need to be fleshed out with additional context. Many sections
> are incomplete and may be explicitly called out as "To Be Determined" (TBD) or "To Do"
> (TODO) but this is not consistent.
>
> **Originality note** This document is the original creation of Drew Teter and may be freely
> used to further the development of the monster-realm project.

---

## 1. Game Overview

**One-line pitch.** A nostolgic 2D-HD monster-taming tactical RPG: build a bonds with a party
of monsters that you recruit and train, evolve them into a variety of higher tier monsters
that depends on how they are raised, adventure and explore a steampunk world with a dark-cozy
tone, themes include "Greedy Exploitation versus Harmonious Cooperation", "Uncharted Frontiers",
and "Nature versus Industry".

| Field | Value |
|---|---|
| Title | Monster Realm |
| Developer / Publisher | Drew Teter / Spooky Owl Technologies |
| Genre | Tactical Monster-Tamer, Dark Cozy, Indie, MMORPG, Top Down 2D, turn-based party RPG |
| Platform | PC (Windows, Linux), Browser, local single-player or online multiplayer |
| Price | $24.99 (Early Access) |
| Status | Very Early Development, not currently open to the public |
| Engine/presentation | 2D pixel art, tactical battles, dark-fantasy tone |
| Session length | Short runs (~30–60 min), designed for "one more run" |
| Key timeline | Reveal Jan 2027 → closed alpha Mar 2027 → demo Jun 2027 → EA Aug 2027; ~1.5 years of EA planned |

**Audience and positioning.** Pokémon-likes.

**Unique selling points.**

1. **Story rich.** Contains a full and emotional storyline where the player's decisions matter.
2. **Both single-player and multiplayer.** Like games such as minecraft and pal world, you can choose
   to play in a solely single player world, host your own server and play with your friends, or play
   it as an MMO on an official server.
3. **Unique Evolution Mechanics.** Every monster has multiple possible evolution paths that continue
   to branch as they progress to higher and higher tiers of evolution. What a monster eventually
   becomes depends on how the player has raised it.
4. **Tactical Battles.** Exciting battles that pit teams of monsters against each other on a tactical
   battlefield where positioning and strategy matter just as much as power.

---

## 2. Design Pillars

TODO

---

## 3. Setting & Story

- **World.** Monster Realm takes place in a fictional country that is similar to Victorian England, but the exact location in reference to other countries is left intentionally ambiguous, allowing us to pull inspiration from many regionally distinct cultures. In addition, the setting will make heavy use of steampunk and clockwork technology, as well as many other elements of the steampunk genre. Themes such as "Greedy Exploitation versus Harmonious Cooperation", "Nature versus Industry", "Uncharted Frontiers", and others common to the steampunk and punk genres will play a prominent role as the player explores the game, makes choices, and adopts various playstyles. The maps will include a variety of different types of environments, including urban, rural, and natural. Most of the biomes will be temperate, with specific locations changing to arid deserts, frozen mountains, and tropical islands.
- **Monsters.** Drawn from monsters in legends, mythology, and folklore from all over the world. Magical animals and supernatural creatures will be pull from North American, Central American, South American, European, Middle Eastern, Indian, African, and Asian religions and cultures. Populating them all will be a research task. The findings from the research will be used to help determine the monster's tier, type, connections to other monsters on the evolution tree, stats, behavior, aggressiveness, rarity, natural environment, map locations, and appearance. Different variations of a monster may exist if appropriate.
- TODO

---

## 4. Core Gameplay Loops

**Macro loop (minutes → hours):**
Recruit numerous monsters → raise them in specific ways to evolve them to higher
tiers → Use the monsters you raise to accomplish quests, advance the story, and
unlock new areas containing different types of monsters → repeat.

**Mid loop (one quest, ~30–60 min):**
Engage with an NPC or encounter an element of the main story → learn about the world
and be given a goal to accomplish → explore the map and attempt to accomplish the
goal → fight against monsters and meet other characters → finish the quest → return
to the NPC and/or gain a reward. (Optional)

**Micro loop (one battle, ~2–5 min):**
Use your party of monsters to fight against another party of monsters and defeat or recruit them.

---

## 6. Combat System

TODO

---

## 7. Monsters

TODO

---

## 9. Economy

TODO

---

## 12. Difficulty & Accessibility

TODO

---

## 13. Art, Audio & UX Direction

64x64 pixel-art-based tiles. Dual grid system using 16-piece tilesets on the offset grid for terrain and additional tilesets on the main grid containing sprites for additional objects, details, and variance (to prevent tile textures from getting too repetitive). Multiple layers (by "layers" I am talking about different `zIndex` values to render certain sprites/textures on top of others.) will be used to compose tile combinations from different tilesets rather than trying to draw every possible combination of detailed tile and all their variations. For example, a "Grass" terrain tile can be layered with a "small pebbles" sprite or a "simple flower" sprite above it. This means that 4 tile variations can be made from only 3 textures. A "Grass+Nothing" tile, a "Grass+Pebbles" tile, a "Grass+Flowers" tile, and a "Grass+Pebbles+Flowers" tile. Then, just by adding a single "Dirt" tile, we add a total of 4 more tile variations and bring the total number of possible tiles we can create through layering up to 8 using only 4 textures. By expanding the base number of base terrain tiles and the number of detail/variation sprites that we can layer on top of them, the number of combinations increases exponentially. This is far more efficient than trying to manually create and save every possible variation as its own distinct tile. The main complications of this approach are that the game will have to keep track of two different grids, which sprites/tiles belong to which grid, and which layer each tile/sprite is on. Most of the base terrain will be on the offset grid, while most of the detail and item sprites (and the players) will be on the main grid. Additionally, since many of the tiles will contain transparent elements, different base colors will need to be drawn underneath the entire map, but this can be done cheaply by using large rectangles that lie underneath an entire area's worth of tiles. For example, a forest with a river running through it might use a grass tileset and a water tileset with tree, flower, and rock sprites to add detail and variation. The map might use a small number of brown rectangles representing dirt to fill all of the area underneath the green grass tiles and gray colored rectangles representing stone to serve as the base color that the blue water tiles are placed on top of. The more detailed tilesets and sprites will cover the vast majority of the map, the base colors will only peek through where the transparency of the tiles' pixels fails to cover them up.



Recruiting

In keeping with the setting's themes, players will have multiple different methods for collecting monsters, each with their pros and cons. One method will be forceful, requiring the player to find wild monsters, defeat them in battle, and then put them in cages. This method will be the quickest way to acquire new monsters, but have several side effects. (WIP feral trait, types of cages, disobedience, relationship limits, attempting to break free)

Another method will require the player to help wild monsters, completing random quests to raise your reputation with a particular monster species and a random chance that a monster from that species will choose to follow you. These monsters will not require cages and will stay with you as long as you maintain your relationship at a high enough level.

Another method will be following monsters back to their lair/nest/den/home and taking one of their eggs/young either through stealth or by defeating the parents. Baby monsters will be tier 0 (the lowest on the evolution tree) and require work to raise them appropriately; however


(Where to store monsters that are not in your main party?)

Battling

Pivot to a more Final Fantasy Tactics type of combat

Story

(TBD)

The beginning of the story takes place in an area that is instanced per player. The game will open up into the multiplayer areas of the game after the end of the initial tutorial.
A cutscene plays at the start of the game (using sprites and animations from the pixel art assets) showing the player's pre-chosen hero sprite waking up in a victorian/steampunk city, Cutscenes have controls disabled while they play, except for a skip button, which will skip to the end of the cutscene with the character in the correct state.The cutscene reveals that the player's rent is do, but they don't have any money to pay it. So the player's character decides to scavenge around the city for anything valuable that has been discarded.
The player then begins exploring the starting area of the city. They can check trash piles, garbage cans, alleyways, and other things, looking for things they can sell.
Eventually, the player triggers an event where two large monsters are chasing one baby monster into the same alley that the player is currently in. Another cutscene occurs, with the player and the baby monster fleeing from the two larger monsters together until they end up hiding in the sewers. The monster is grateful to the player for saving it and begins following the player around. The player notices this and then gives the little monster some food. The cutscene ends with the monster having joined the player's party and giving the player the option to name it.
The player and their new monster have to find a way out of the sewer (fighting other weak)


ALTERNATE IDEA: the player finds a monster egg in an alley behind a rich person's house. The rich people are monster breeders who threw out the egg because it was accidentally fertilized by the wrong sire.

Influences

Disgaea -  https://store.steampowered.com/app/405900/Disgaea_PC
Aethermancer - https://store.steampowered.com/app/2288470/Aethermancer/
Monster Sanctuary - https://store.steampowered.com/app/814370/Monster_Sanctuary/
Monster Crown Sin Eater - https://store.steampowered.com/app/3388410/Monster_Crown_Sin_Eater/

