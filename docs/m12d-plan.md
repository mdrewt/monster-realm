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
- Resolves costItemId → item name from itemDefs (or `null` graceful — tests assert `costItemName: null` for unknown costItemId)

### View Shells (coverage-excluded)

**`client/src/ui/dialogueView.ts`** — DOM shell:
- Constructor: `(parent, callbacks: { onAdvance(choiceIdx), onDismiss() })`
- `show(vm: DialogueViewModel)`, `hide()`, `refresh(vm: DialogueViewModel)`
- Shows NPC name, node text, choice buttons (auto-numbers), dismiss button
- NEVER calls server logic or evaluates conditions

**`client/src/ui/questLogView.ts`** — DOM shell:
- Constructor: `(parent)` (no reducer callbacks needed — display only)
- `show(vm)`, `hide()`, `toggle()`, `visible`, `refresh(vm)`
- Shows ACTIVE quests only (no completed section — completed quests are deleted server-side)

**`client/src/ui/healView.ts`** — DOM shell:
- Constructor: `(parent, callbacks: { onHeal(locationId) })`
- `show(vm)`, `hide()`, `toggle()`, `visible`, `refresh(vm)`
- Shows heal location cost/cooldown, Heal button per location

### Main loop wiring (client/src/main.ts)

- Import + instantiate the 3 new views in `main()`
- Add 3 batch-applied listeners: `refreshDialogue()`, `refreshQuestLog()`, `refreshHeal()`
- `refreshDialogue()`: check `store.ownConversation(identity)` → auto-show/hide + refresh; if dialogue auto-shows, explicitly hide any open battle/box/raising/evolution/questLog/healView (dialogue > all per precedence order)
- All 3 new batch listeners MUST be TOTAL (never throw) — `store.flushBatch` has NO per-listener isolation; a throw starves reconcile + refreshBox + refreshBattle siblings. Wrap in try/catch the same way refreshRaising/refreshEvolution do.
- Add `dismissPending` flag for dialogue: set when Escape fires (reducer sent), clear when `player_conversation` row is deleted. Guard: if `dismissPending`, Escape does NOT re-send dismiss (prevents double-dismiss + server-side noise).
- Add KeyQ → toggle questLogView (mutual exclusivity: hide other overlays; guard battle)
- Add KeyH → toggle healView (mutual exclusivity: guard battle)
- Add Escape chain: dialogue (send dismissDialogue if !dismissPending) > battle > box > raising > evolution > questLog > heal
- **Two movement suppression sites** — BOTH must include new overlays:
  1. `keydown` handler line ~223: `battleView?.visible || boxView?.visible || raisingView?.visible || evolutionView?.visible || dialogueView?.visible || questLogView?.visible || healView?.visible`
  2. `frame()` re-issue guard line ~467: same expression
- Remove hardcoded `healParty({ locationId: 1 })` from boxView callback; replace with first available location from `store.healLocations()` or `locationId: 0` no-op (the new HealView is the primary heal path)
- `SELECT * FROM npc` global (no zone filter) — named deferral: NPC set is small now; zone-scoped NPC subscription is a future optimization (when content scales)
- `heal_cooldown` PK = per-player global (not per-location): `HealLocationViewModel.cooldownMs` shows the DURATION hint; the client never knows remaining cooldown (private table). Server rejects if on cooldown.

## Test Plan

### Unit tests (new files in client/src/ui/)

**`dialogueModel.test.ts`**:
- Returns null when no conversation
- Returns null when NPC not found
- Returns correct text for known node from bundle
- Returns "..." text for unknown node/tree (graceful — no throw)
- Returns correct choices with indices
- Never throws on ANY partial/missing/null/undefined input (TOTAL property — test with empty maps, undefined NPC, missing node)

**`questLogModel.test.ts`**:
- Empty quests → empty active list
- Active quest appears in active list (no "completed" section — row deletion = completion)
- Never throws

**`healModel.test.ts`**:
- Free heal location: isFree = true, costItemName = null
- Paid heal location: costItemName resolved from itemDefs
- Unknown item falls back to null/graceful
- Never throws

### RowConvert tests (extend client/src/net/rowConvert.test.ts)
- `playerConversationRowToStore`: `ownerIdentity.toHexString()` is called; result `ownerIdentity` is a hex string (not a raw Identity object) — gating test that this isn't mis-cast

### Store tests (extend client/src/net/store.test.ts)
- `ownConversation` filters by identity (another player's conversation not returned)
- `ownQuests` filters by identity
- `reset()` clears ALL 4 new maps (4 assertions, one per map) — must bite when any map.clear() is removed

### Evals (new)

**`evals/dialogue-client-integrity.eval.mjs`** — Proof-of-teeth:
1. `dialogueModel.ts` imports NO SDK module (purity gate) → tooth: sabotage by adding `import {} from 'spacetimedb'` → eval fails
2. `dialogueModel.ts` does NOT call `advance_dialogue`/`talk`/reducer logic (server-SSOT gate) → tooth: add `advanceDialogue` string → eval fails
3. `questLogModel.ts` has no quest-advance logic (no `advance_quest`/`completeQuest`/`apply_quest_step`)
4. `healModel.ts` has no `heal_party`/`healParty` call (view-only)
5. `dialogueContent.ts` has NO `new RegExp(` or `fetch(` (static-asset gate)
6. **RON vs bundle cross-reference** (C1 + M4 finding): read `game-core/content/dialogue_trees/000-core.ron`, parse nodeIds and choice counts; for each node, assert `DIALOGUE_TREES` bundle has the same nodeId AND the same number of choices → tooth: add an extra choice to RON → eval fails
7. `dialogueView.ts`, `questLogView.ts`, `healView.ts` excluded from coverage (dom-shell gate)

**Extend `evals/dom-shell-coverage-exclusion.eval.mjs`**:
Add `dialogueView.ts`, `questLogView.ts`, `healView.ts` to the checked exclusion list (existing tooth bites on removal from the exclusion config).

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
