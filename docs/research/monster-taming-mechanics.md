---
type: Research Note
title: Monster-taming genre — core mechanics & gameplay inspirations
slug: monster-taming-mechanics
domain: gameplay
tags: [capture, party, progression, battle, breeding, multiplayer]
status: active
updated: 2026-06-26
confidence: medium
sources: 3
supersedes:
abstract: "Core monster-taming loops (capture, party, progression, battle, breeding) and how to adapt them for a server-authoritative multiplayer game."
---
## Scope
Genre-level mechanics shared across monster-taming games, the main design axes where
titles differ, and what each implies for monster-realm specifically — a
**server-authoritative SpacetimeDB multiplayer** game (capture/battle outcomes must be
decided by the reducer, never the client).

## Key findings
- **The shared spine:** acquire creatures → train them → battle with them. Everything
  else is variation on those three verbs.
- **Capture** usually = weaken in combat, then attempt containment; success scales with
  target HP, status effects, and player buffs/items. A minority use non-combat capture
  (bribery/gifting/befriending). The capture *roll* is the genre's signature
  risk/reward beat.
- **Party** is a small active roster (the canonical cap is **6**) backed by larger
  storage. Smallness is what forces team-composition decisions (typing, roles,
  resistances).
- **Progression** runs on XP from battles → stat growth + new moves, plus **evolution**
  at thresholds (a visible, motivating power/identity shift). Item-assisted move
  learning is common.
- **Battle** is most often turn-based, but the genre tolerates wide variation:
  real-time, rock-paper-scissors triads (power/speed/technique), stacking/fusion,
  suggestion-based commands.
- **Long-tail retention** comes from **breeding/fusion** — combining creatures to yield
  results unobtainable by normal capture; the main driver of experimentation and
  end-game.

## Concrete examples & references
- Turn-based canon (six-slot party, weaken-then-capture, evolution): the Pokémon model
  is the genre's reference point ([Wikipedia](https://en.wikipedia.org/wiki/Monster-taming_game)).
- Mechanic divergences worth studying: item-synthesis, suggestion commands, ally
  stacking, and monster fusion are catalogued as deliberate departures from the canon
  ([GameRant — unique monster-taming mechanics](https://gamerant.com/rpgs-unique-monster-taming-mechanics/)).
- Capture-by-bribery / gifting as an alternative to combat capture is an established
  variant, not a novelty ([Grokipedia](https://grokipedia.com/page/Monster-taming_game)).

## Design implications for THIS project
- **Server-authoritative capture:** the capture roll (RNG + HP + status + item
  modifiers) MUST run in the reducer; the client only requests and animates the result.
  This is also the natural anti-cheat boundary — see `netcode-determinism` evals.
- **Party cap is a balance lever, not a constant:** a smaller active cap raises the
  stakes of each slot in multiplayer PvP; pick it deliberately and treat it as tunable.
- **Evolution & breeding are write-heavy, identity-changing events** → model them as
  explicit, append-only state transitions (fits the existing append-only-ids / zoned
  schema evals) so history is auditable and desync-resistant.
- **Battle model choice cascades into netcode:** turn-based is the cheapest to make
  authoritative and lag-tolerant; real-time would demand prediction/reconciliation
  (the prediction-parity / movement-parity machinery already in this repo).

## Open questions
- Capture: pure combat, befriending, or hybrid? Affects PvE pacing and PvP fairness.
- Battle: turn-based (cheap, authoritative) vs real-time (expensive, needs prediction)?
- Is breeding/fusion in scope for v1, or a post-launch retention lever?

## Sources
- https://en.wikipedia.org/wiki/Monster-taming_game
- https://grokipedia.com/page/Monster-taming_game
- https://gamerant.com/rpgs-unique-monster-taming-mechanics/
