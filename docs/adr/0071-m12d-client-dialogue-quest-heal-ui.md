# ADR-0071: M12d client dialogue/quest/heal UI design

**Status:** accepted  
**Date:** 2026-07-03  
**Slice:** M12d (client-only; no schema changes)

## Context

M12d builds the client-facing UI for dialogue, quest log, and heal interaction after M12b (server) and M12c (content). The client receives game state via three new subscribed tables: `player_conversation` (current dialogue node), `player_quest` (active quests), `heal_location_row` (heal locations). Two additional content tables are subscribed: `npc` (NPC definitions including `dialogueTreeId`) and `heal_location_row` (already listed).

Three non-obvious design questions arise:

1. How does the client render dialogue node text/choices when only `currentNodeId` is in the subscribed state?
2. What is the quest log's scope when completed quests are in a private unsubscribed table?
3. How should the three new overlays integrate with the existing overlay lifecycle?

## Decision 1: Dialogue tree content bundle

**Decision:** Bundle dialogue tree display content as a static TypeScript constant map in `client/src/ui/dialogueContent.ts`, mirrored from `game-core/content/dialogue_trees/*.ron`.

**Rationale:** The `player_conversation` table only stores `currentNodeId`. The actual dialogue text/choices are in RON files embedded in the server binary and are not in any subscribed table. Changing schema or adding a subscribed `dialogue_node` table is out of scope for M12d (would require bindings regen within the blocked touches set).

The content bundle is a **display asset only**: it maps `(dialogueTreeId, nodeId) → { text, choices[] }`. The server remains the SSOT for all state transitions, condition checks, and effect application. The client NEVER evaluates choice conditions or applies effects — it only renders text and sends `advance_dialogue({ choiceIdx })`. A mismatch between bundle and server content shows `"..."` text (graceful degradation). A future content-pipeline task will auto-generate this file from the RON source to prevent drift.

**Considered alternatives:**
- *Fetch at runtime*: HTTP endpoint or SpacetimeDB procedure; adds async complexity; no suitable RPC pattern in 2.6.
- *Schema extension*: Add `dialogue_node` table storing current node text/choices; requires M12e schema+bindings work; M12d is client-only.
- *Show node IDs*: Acceptable during dev but poor UX for a playable build.

## Decision 2: Quest log shows active quests only

**Decision:** The quest log renders only active quests from `player_quest`. Completed quests are not displayed.

**Rationale:** On quest completion, the server DELETES the `player_quest` row and moves the quest id into `player_dialogue_state.done_quests` (a private, unsubscribed table). The client cannot observe completed quests through the current subscription set. Showing active-only is correct and honest.

**Known limitation:** A "Completed" section in the quest log requires either (a) a public `completed_quest` table (future additive schema change), or (b) client-side mirroring of deletions via `player_quest.onDelete` callbacks (lossy across reconnects — reject). The right fix is a future additive table.

**Considered alternatives:**
- *Mirror deletes in client memory*: lossy on reconnect; violates the authoritative-store reset contract (ADR-0014).
- *Sentinel stepIndex*: Not applicable — completion deletes the row.

## Decision 3: Overlay lifecycle integration

**Decision:** Follow the existing overlay lifecycle pattern (ADR-0014/0052). Dialogue auto-shows/hides via server state (like battle). Quest log and heal view are KeyQ/KeyH toggled with mutual exclusivity.

**Mutual exclusivity order (highest to lowest):** dialogue > battle > box > raising > evolution > quest-log > heal

Dialogue auto-show is triggered by `player_conversation` presence for own identity in `refreshDialogue()` (batch-applied listener, same pattern as `refreshBattle()`). Auto-hide fires when the row is deleted.

Escape key: sends `dismiss_dialogue({})` when dialogue is visible (tells server to clean up state).

**Why dialogue > battle?** An NPC might be near a battle trigger; the dialogue takes precedence since the player actively initiated it. A battle started while in dialogue is a server-level concern (the server rejects overlapping).

## Implications

- `client/src/ui/dialogueContent.ts` is a new content-bundle file — content changes require updating both the RON and this file until a gen pipeline is added.
- `player_quest` subscription delivers all player quests (RLS deferred to M16 per ADR-0069); client-side owner filter `ownQuests(identity)` is the privacy guard.
- `player_conversation` subscription similarly delivers all conversations; `ownConversation(identity)` is the guard.
- The existing `onHealParty` callback in `boxView` (hardcoded `locationId: 1`) should be replaced/supplemented by the new HealView which reads `heal_location_row` dynamically and passes the correct `locationId`. The boxView callback remains as a fallback until M12d is complete.
