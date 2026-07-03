# M12d Plan — Client Dialogue Screen + Quest Log + Heal UI

**Slice:** M12d (client-only)  
**ADR:** 0071 (reserved)  
**Touches:** `client/src/**` (excl. `module_bindings/`), `client/test/**`, `evals/**`, `docs/m12d-plan.md`, `docs/adr/0071-*.md`, `ARCHITECTURE.md` (minimal)  
**Must NOT touch:** schema, module_bindings, game-core, server-module, Cargo.*

## Scope Summary

Build the frontend for M12 dialogue, quest log, and heal-location interaction. The server (M12a/b/c) is the sole evaluator of dialogue/quest logic (ADR-0014); the client reads server state and sends intents.

**Tables to subscribe (NEW):**
- `player_conversation { ownerIdentity, npcEntityId, currentNodeId }` — active conversation (own row only, client-filtered)
- `player_quest { pqId, ownerIdentity, questId, stepIndex }` — quest progress (own rows, client-filtered)
- `heal_location_row { locationId, zoneId, tileX, tileY, costItemId?, costQty, cooldownMs }` — heal locations (content, public)
- `npc { entityId, npcId, zoneId, homeX, homeY, wanderRadius, dialogueTreeId }` — NPC defs (content, public)

**Reducers sent (existing):**
- `talk({ npcEntityId })` — *not* invoked from dialogue view (player is already in dialogue when the view shows)
- `advance_dialogue({ choiceIdx })` — on choice button click
- `dismiss_dialogue({})` — on Escape or close button
- `heal_party({ locationId })` — on Heal button in HealView

## Architecture Decisions

### ADR-0071: Dialogue content bundle (client/src/ui/dialogueContent.ts)

**Problem:** `player_conversation.currentNodeId` tells the client WHICH node to display, but the node text/choices are in RON content embedded server-side. No `dialogue_tree` subscribed table exists and schema changes are out of scope for M12d.

**Decision:** Bundle dialogue tree display content as a static TypeScript constant map in `client/src/ui/dialogueContent.ts`, mirroring `game-core/content/dialogue_trees/*.ron`. This is a DISPLAY ASSET only — no logic, no conditions evaluation, no effects computation. The server remains SSOT for dialogue state transitions, condition checks, and effect application.

**Why not schema change?** Schema is out of scope for M12d; any new table requires bindings regen (not within M12d touches).  
**Why not fetch?** Would require an HTTP endpoint or procedure; SpacetimeDB 2.6 procedures don't support this pattern; adds async complexity to the render path.  
**Maintenance:** A mismatch between server content and client bundle shows "..." for unknown nodes (graceful degradation). This gap is small and will be fixed when content tooling (RON → TS asset pipeline) is added in a later milestone.

### UI Lifecycle

Dialogue auto-shows when `player_conversation` exists for own identity (same as battle overlay pattern). Auto-hides when row deleted (server-side auto-advance to `None` or server dismiss after RT-ADV-01 check). Escape sends `dismiss_dialogue({})`.

Quest log toggled by **KeyQ**. Heal view toggled by **KeyH**. Mutual exclusivity:
```
dialogue > battle > box > raising > evolution > quest-log > heal
```
Upper-precedence overlays hide lower ones on open; movement suppressed when any overlay open.

## File Changes

### Infrastructure (store + rowConvert + connection)

**`client/src/net/store.ts`** — Add:
- Types: `StorePlayerConversation`, `StorePlayerQuest`, `StoreHealLocationRow`, `StoreNpcRow`  
- Private maps: `#conversations`, `#quests`, `#healLocations`, `#npcs`
- Ingest: `upsertConversation/removeConversation`, `upsertQuest/removeQuest`, `upsertHealLocation/removeHealLocation`, `upsertNpc/removeNpc`
- Read: `ownConversation(identity)`, `ownQuests(identity)`, `healLocations()`, `npc(entityId)`, `npcByNpcId(npcId)`, `reset()` extended
- `reset()` clears all 4 new maps

**`client/src/net/rowConvert.ts`** — Add 4 interface + converter pairs:
- `SdkPlayerConversationRow` → `playerConversationRowToStore`
- `SdkPlayerQuestRow` → `playerQuestRowToStore`
- `SdkHealLocationRowRow` → `healLocationRowToStore`
- `SdkNpcRow` → `npcRowToStore`

**`client/src/net/connection.ts`** — Add to subscribe list:
```
'SELECT * FROM player_conversation',
'SELECT * FROM player_quest',
'SELECT * FROM heal_location_row',
'SELECT * FROM npc',
```
Add 4 × 3 row callbacks (onInsert/onUpdate/onDelete) + import new converters.

### Pure Models

**`client/src/ui/dialogueContent.ts`** — Static content bundle:
- `DIALOGUE_TREES: ReadonlyMap<string, ClientDialogueTree>` keyed by tree id
- `ClientDialogueTree { rootNodeId, nodes: ReadonlyMap<string, ClientDialogueNode> }`
- `ClientDialogueNode { text, choices: readonly { text: string }[] }`
- Seeded from `game-core/content/dialogue_trees/000-core.ron` (one tree, one node)

**`client/src/ui/dialogueModel.ts`** — Pure view-model:
- `buildDialogueViewModel(conv, npc, npcs, content): DialogueViewModel | null`
- Returns null when no active conversation
- `DialogueViewModel { npcName, nodeText, choices: readonly { text, idx }[], canDismiss }`
- Never evaluates conditions/effects (SSOT on server)
- TOTAL: never throws

**`client/src/ui/questLogModel.ts`** — Pure view-model:
- `buildQuestLogViewModel(quests): QuestLogViewModel`
- `QuestLogViewModel { active: readonly QuestEntryViewModel[] }` — active quests only
- `QuestEntryViewModel { questId, stepIndex, displayName }` — displayName is `questId` (no bundled quest metadata; known limitation)
- **Completed quests are NOT shown**: on server completion, the `player_quest` row is DELETED and the quest id moves to `player_dialogue_state.done_quests` (private, unsubscribed). The client has no visibility into completed quests. This is documented in ADR-0071 as a known limitation (fix: add a public completed-quest table in a future slice).

**`client/src/ui/healModel.ts`** — Pure view-model:
- `buildHealViewModel(healLocations, itemDefs): HealViewModel`
- `HealViewModel { locations: readonly HealLocationViewModel[] }`
- `HealLocationViewModel { locationId, zoneId, tileX, tileY, costItemName: string | null, costQty: number, cooldownMs: number, isFree: boolean }`
- Resolves costItemId → item name from itemDefs (or "Unknown item" graceful)

### View Shells (coverage-excluded)

**`client/src/ui/dialogueView.ts`** — DOM shell:
- Constructor: `(parent, callbacks: { onAdvance(choiceIdx), onDismiss() })`
- `show(vm: DialogueViewModel)`, `hide()`, `refresh(vm: DialogueViewModel)`
- Shows NPC name, node text, choice buttons (auto-numbers), dismiss button
- NEVER calls server logic or evaluates conditions

**`client/src/ui/questLogView.ts`** — DOM shell:
- Constructor: `(parent)` (no reducer callbacks needed — display only)
- `show(vm)`, `hide()`, `toggle()`, `visible`, `refresh(vm)`
- Shows active/completed quest lists with step info

**`client/src/ui/healView.ts`** — DOM shell:
- Constructor: `(parent, callbacks: { onHeal(locationId) })`
- `show(vm)`, `hide()`, `toggle()`, `visible`, `refresh(vm)`
- Shows heal location cost/cooldown, Heal button per location

### Main loop wiring (client/src/main.ts)

- Import + instantiate the 3 new views in `main()`
- Add 3 batch-applied listeners: `refreshDialogue()`, `refreshQuestLog()`, `refreshHeal()`
- `refreshDialogue()`: check `store.ownConversation(identity)` → auto-show/hide + refresh
- Add KeyQ → toggle questLogView (mutual exclusivity: hide other overlays, guard battle)
- Add KeyH → toggle healView (mutual exclusivity: guard battle)
- Add Escape handlers for dialogue (→ conn.reducers.dismissDialogue({})), questLog, healView
- Guard movement/re-issue when new overlays visible

## Test Plan

### Unit tests (new files in client/src/ui/)

**`dialogueModel.test.ts`**:
- Returns null when no conversation
- Returns null when NPC not found
- Returns correct text for known node
- Returns "..." text for unknown node (graceful)
- Returns correct choices with indices
- Never throws on any partial/missing input (TOTAL property)

**`questLogModel.test.ts`**:
- Empty quests → empty active + completed lists
- Active quest appears in active list
- Completed quest (stepIndex at sentinel) appears in completed list
- Never throws

**`healModel.test.ts`**:
- Free heal location: isFree = true, costItemName = null
- Paid heal location: costItemName resolved from itemDefs
- Unknown item falls back to null/Unknown
- Never throws

### Store tests (extend client/src/net/store.test.ts or new file)
- Prove `ownConversation` filters by identity
- Prove `ownQuests` filters by identity
- Prove `reset()` clears all new maps

### Evals (new)

**`evals/dialogue-client-integrity.eval.mjs`** — Proof-of-teeth:
1. dialogueModel.ts imports NO SDK module (purity gate)
2. dialogueModel.ts does NOT call `advance_dialogue` or reducer logic (server-SSOT gate)
3. questLogModel.ts has no step-advance logic (no `advance_quest`/`complete_quest` calls)
4. healModel.ts has no `heal_party` call (view-only)
5. dialogueContent.ts has NO dynamic RegExp, no `new RegExp(`, no `fetch(` (static-asset gate)
6. dialogueView.ts, questLogView.ts, healView.ts are excluded from coverage (dom-shell gate)

**Extend `evals/dom-shell-coverage-exclusion.eval.mjs`**:
Add `dialogueView.ts`, `questLogView.ts`, `healView.ts` to the checked exclusion list.

## Anti-patterns to Avoid

- NO condition/effect evaluation in dialogueModel (server-SSOT)
- NO `new RegExp(` anywhere (use literal `/pattern/` or `indexOf`) — ReDoS/detect-non-literal-regexp has bitten twice
- NO throw in model functions (total: store batch listener isolation)
- NO unfiltered accessor for `player_conversation` or `player_quest` (privacy by filter, same as inventory)
- NO hardcoded `locationId: 1` in healView (use data from `store.healLocations()`)

## Definition of Done

- `just ci` green: tsc clean, 452+ client tests (existing) + new model tests green, 37+ evals pass, semgrep clean
- DialogueView shows/hides based on server conversation state
- QuestLogView shows own quests by quest_id + step
- HealView shows cost/cooldown, dispatches heal with correct locationId
- All EARS criteria in M12 §3 have a passing test for the client rendering path
- proof-of-teeth: dialogue integrity eval bites on mutation
- ADR-0071 written, ARCHITECTURE.md updated
