# ADR-0071: M12d client dialogue/quest/heal UI design

**Status:** accepted  
**Date:** 2026-07-03  
**Slice:** M12d (client-only; no schema changes)

## Context and problem statement

M12d builds the client-facing UI for dialogue, quest log, and heal interaction after M12b (server) and M12c (content). The client receives game state via new subscribed tables: `player_conversation` (current dialogue node), `player_quest` (active quests), `heal_location_row` (heal location definitions), and `npc` (NPC definitions including `dialogueTreeId`).

Three non-obvious design questions arise:

1. How does the client render dialogue node text/choices when the subscribed `player_conversation` table only stores `currentNodeId` — not the actual text/choices?
2. What is the quest log's scope when quest completion **deletes** the `player_quest` row and moves the quest id into private unsubscribed `player_dialogue_state.done_quests`?
3. How do the three new overlays integrate with the existing overlay lifecycle (battle, box, raising, evolution)?

## Decision outcome

**Decision 1: Bundle dialogue tree content client-side as a static TypeScript constant.**  
**Decision 2: Quest log shows active quests only.**  
**Decision 3: Dialogue auto-shows/hides from server state; quest log and heal are key-toggled; mutual exclusivity order is dialogue > battle > box > raising > evolution > quest-log > heal.**

## Considered alternatives

### Decision 1 alternatives

**Option A: Schema extension — add `dialogue_node` table storing current node text/choices.**
- Pro: server-authoritative, no drift.
- Con: requires bindings regen, schema changes are out of scope for M12d.

**Option B: Fetch at runtime via HTTP or SpacetimeDB procedure.**
- Pro: dynamic, no bundle to maintain.
- Con: no suitable RPC endpoint in SpacetimeDB 2.6 for this pattern; adds async complexity to the render path; breaks the synchronous one-way store→render flow.

**Option C: Show raw node IDs to the player.**
- Unacceptable UX for any playable build.

**Option D (chosen): Static TypeScript constant bundle in `client/src/ui/dialogueContent.ts`, mirroring `game-core/content/dialogue_trees/*.ron`.**
- The bundle is a **display asset only** — it maps `(dialogueTreeId, nodeId)` → `{ text, choices[] }`.
- The server remains SSOT for all state transitions, condition checks, and effect application.
- A mismatch between bundle and server content shows `"..."` text (graceful degradation).
- An eval tooth (`dialogue-client-integrity.eval.mjs`) cross-references RON node IDs and choice counts against the bundle to mechanically detect drift.
- A future content-pipeline task will auto-generate this file from RON.

### Decision 2 alternatives

**Option: Mirror `player_quest` deletions in client memory across reconnects.**
- Con: violates AuthoritativeStore reset contract (ADR-0014). On reconnect, `store.reset()` drops all rows; client-side mirrors would be stale.

**Option: Add sentinel `stepIndex` value (e.g. u32::MAX) for completed quests.**
- Con: the server does not use sentinels — it deletes the row. Implementing this requires a schema change.

**Chosen: Active-only quest log, with a named limitation (fix: future additive `completed_quest` public table).**

### Decision 3 alternatives

**Dialogue: key-toggled (like box/raising/evolution).**
- Rejected: dialogue state is server-driven. Dialogue must appear immediately when the server creates a `player_conversation` row (e.g. after `talk(npcEntityId)` succeeds), not only when the player presses a key. Auto-show matches the battle overlay pattern.

**Lower overlay precedence for dialogue vs. battle.**
- Rejected: the player explicitly initiated dialogue; it should supersede spectator battle display. The server rejects `advance_dialogue` during an active battle anyway (guard F5), so showing dialogue above battle is safe.

## Positive consequences

- Server remains SSOT for all dialogue/quest logic; client never evaluates conditions or effects.
- Dialogue auto-shows/hides based on server state — no stale UI after server auto-dismiss (RT-ADV-01).
- Content bundle is mechanically gated against drift by the eval tooth.
- The three new overlays integrate into the existing lifecycle with clear precedence.

## Negative consequences and known limitations

- `dialogueContent.ts` must be manually updated when dialogue tree RON content changes, until an automated gen pipeline is added.
- Completed quests are not displayed in the quest log (private `done_quests` state). Fix requires a future additive public `completed_quest` table.
- `SELECT * FROM npc` and `SELECT * FROM player_conversation` deliver all rows pre-RLS (M16). Client-side owner filter (`ownConversation(identity)`, `ownQuests(identity)`) is the privacy guard. Blast radius: a stale row from another player's conversation is filtered out but sits in the store until `reset()`.
- `SELECT * FROM npc` is zone-unscoped (global). NPC set is small in current content; a zone-scoped NPC subscription is a future optimization when content scales.
- `heal_cooldown` PK = per-player global (not per-location). `HealLocationViewModel.cooldownMs` displays the cooldown DURATION for the location; the client never knows remaining cooldown (private table). The server rejects if on cooldown.
