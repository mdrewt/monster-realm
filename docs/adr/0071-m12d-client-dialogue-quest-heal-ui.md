# 0071. M12d: Client dialogue/quest/heal UI — static bundle, pure models, dismissal gating

**Status:** Accepted
**Date:** 2026-07-03
**Slice:** m12d
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, economy-quests
**Decision:** Client dialogue/quest/heal UI uses a static bundle, pure models, dismissal gating via keyboard/overlay mutex, and promise-rejection feedback for reducer errors.


**Date:** 2026-07-03
**Status:** Accepted
**Authors:** Supervisor, Claude Sonnet 4.6
**Milestone:** M12d

## Context and problem statement

M12b shipped the server-side reducers and table schema for NPC dialogue, quests, and healing; M12c loaded RON content and validated integrity. M12d implements the client-side UI: the dialogue screen, quest-log view, and heal-location interaction. Three architectural decisions must be made:

1. **Dialogue text source:** The server stores only `player_conversation.npc_id` and `player_dialogue_state.node_id` (no display text). Where should dialogue text live on the client — subscribe a new server table, embed a static bundle, or mirror from RON?

2. **Completed quests visibility:** The server marks quests complete by moving them to a private `player_dialogue_state.done_quests` vector (not a separate table row). How should the client display quest history — subscribe a new table, show only active quests, or defer to M16 RLS?

3. **Heal cooldown tracking:** The server stores cooldown timestamps in a private `heal_cooldown` table. Should the client subscribe to this table, derive it from a view-model calculation, or track locally?

## Considered alternatives

### Dialogue text source

1. **Static client bundle (chosen):** `dialogueContent.ts` imports `DIALOGUE_TREES` from game-core's parsed `000-core.ron`, mirrors the server's data shape, and is never changed after bundle time.
   - Pros: client owns no read path to the server; dialogue is data; the bundle is deterministic and test-fixture-stable.
   - Cons: text duplication; requires explicit sync on content changes.

2. **Subscribe a server table:** Add a new `dialogue_content` table, seeded at `sync_content`, and subscribe.
   - Pros: single source of truth; O(1) lookup client-side.
   - Cons: adds a table (schema cost); redundant subscription bandwidth; server becomes the display-text SSOT (mixes logic + presentation).

3. **Mirror RON at compile time via build.rs:** Import the parsed trees during client build.
   - Pros: deterministic; scales with content.
   - Cons: requires cross-workspace crate coordination; build dependency complexity (Rust-only).

### Completed quests visibility

1. **Active-only quest log (chosen):** The client subscribes `player_quest` and displays quests where `quest_state == Active`. Completed quests are deleted server-side (moved to `player_dialogue_state.done_quests` vector, private).
   - Pros: no new table; completed state is deterministic (not a row).
   - Cons: quest history is invisible; future M16 RLS will require backfill.

2. **Public completed-quests table:** A new `player_quest_completed` table, upserted on completion.
   - Pros: history is queryable; client can display past achievements.
   - Cons: schema cost; redundant with the private done-set; violates ADR-0015 privacy model (client would subscribe and de-privatize the completion state).

3. **Defer to M16 RLS:** Store completed quests in the private vector; render nothing until M16 adds per-player RLS filtering.
   - Pros: correct privacy model from day one.
   - Cons: no visible quest feedback loop; later RLS work is required for parity.

### Heal cooldown tracking

1. **Pass-through the bigint cooldown (chosen):** The server-sent `heal_cooldown.last_healed_at_ms` is a bigint in the SDK bindings. The client receives it via `heal_location_row` subscription (one-to-many join via location_id) or a separate subscription, stores it as-is, and derives cooldown remaining via `(now() - last_healed_at_ms) < COOLDOWN_MS`.
   - Pros: server-authoritative; no client clock sync needed (accept the imprecision per ADR-0012).
   - Cons: `bigint` → `number` conversion is lossy; a gating test must pin the boundary.

2. **Embed COOLDOWN_MS in client constant:** Derive client-side without subscribing.
   - Pros: no subscription bandwidth.
   - Cons: client clock drift → perceived cooldown != server cooldown; violates server-authority.

3. **Subscribe a derived view:** Add a server-computed `heal_cooldown_remaining_ms` column.
   - Pros: client receives a u32 (no bigint loss); one-way data flow.
   - Cons: adds computation per tick; mixes logic into the schema (ADR-0003 violation).

## Decision outcome

### 1. Static client dialogue bundle (`dialogueContent.ts`)

`client/src/ui/dialogueContent.ts` is a generated TS mirror of `content/npc/000-core.ron` and any additional dialogue content. It exports a `DIALOGUE_TREES: Record<number, DialogueTree>` keyed by dialogue_id, matching the game-core `DialogueTree` shape. The bundle is **never mutated at runtime**; it is a read-only data fixture.

- `dialogueModel.ts` consults the bundle via `DIALOGUE_TREES[dialogueId]` when rendering the current node.
- The gating test `RT-DLG-01` in `dialogueModel.test.ts` imports both `DIALOGUE_TREES` and the raw RON and asserts equality on every commit.
- If dialogue content changes (RON edit), the bundle is regenerated manually (or via a future build.rs step) before deployment.
- **Known limitation:** If bundle and server content diverge, the client renders stale text. The gating test + discipline catch divergences in CI.

### 2. Active-only quest log

`questLogModel.ts` subscribes `player_quest` (public table) and builds a `QuestLogViewModel` where all visible quests have `quest_state == Active`. The model is pure and side-effect-free; it is consumed by `questLogView.ts` (DOM shell, coverage-excluded).

- Completed quests are deleted server-side (moved to the private `player_dialogue_state.done_quests` vector).
- The client has no way to display quest history until M16 (per-player RLS on `player_quest_completed` or equivalent table).
- Known limitation: quest completion gives no visible feedback loop; future implementations may add a toast/animation callback.

### 3. Heal cooldown via pass-through bigint

`healModel.ts` subscribes `heal_location_row` (keyed by location_id) and optionally `heal_cooldown` (PRIVATE on server, no subscription available). Alternatively, the reducer response includes `last_healed_at_ms` baked into the `heal_location_row` subscription or via a separate subscription point (deferred to final implementation).

The model calculates `isOnCooldown = (now() - lastHealedAtMs) < COOLDOWN_MS` using the client's local time (ADR-0012, lossy baseline). A gating test in `rowConvert.test.ts` pins the `bigint` → `number` boundary and asserts no silent truncation above `Number.MAX_SAFE_INTEGER`.

- Cooldown is **not** a displayed countdown; it is a gate for the heal button (enable/disable).
- The exact cooldown value is server-authoritative; client time drift is accepted (ADR-0012).
- Known limitation: client can drift up to a few seconds from server truth; M16 or later can add server-sent remaining-ms for exact parity.

## Store and subscription additions

- **`StorePlayerConversation`** — public table subscription, keyed by (player_identity, npc_id, dialogue_id). Holds current dialogue session state.
- **`StorePlayerQuest`** — public table subscription. Tracks active quest progress.
- **`StoreHealLocationRow`** — public table subscription. NPC healing locations.
- **`StoreNpcRow`** — public table subscription. NPC entity data (zone, position, home, wander_radius). **Known limitation:** subscription is global (no zone scoping); M16 should add per-zone subscription filtering.

New columns in existing tables:
- `StoreMonsterPub.last_care_at_ms: bigint` (from M9b; used in raising view).

## Mechanical gates (proof-of-teeth)

1. **`RT-DLG-01` (gating test in `dialogueModel.test.ts`):** Imports `DIALOGUE_TREES`, compares shape/text to the RON source. Fails if bundle is stale. *Note:* updates to dialogue content require manual bundle regeneration + test fix in the same commit.

2. **`cooldown-bigint-boundary` (gating test in `rowConvert.test.ts`):** Verifies that `heal_cooldown.last_healed_at_ms` (SDK `bigint`) converts to `number` without silent truncation below `Number.MAX_SAFE_INTEGER`. Fails if the server emits cooldown timestamps above the boundary.

3. **`C7-dismissPending-latch` (gating test in `main.ts` or evaluation tooth):** Verifies that `dismissPending` flag is set before calling `dismiss_dialogue` reducer and cleared after the response. Prevents double-send on rapid Escape presses or batch re-entrancy.

## Implementation notes

### Dialogue view (`dialogueView.ts`)

- DOM shell (coverage-excluded via `vite.config.ts`).
- Renders `dialogueModel.DialogueViewModel` (pure, unit-tested).
- Shows current node text (from `DIALOGUE_TREES`), available choices, and action buttons (Advance, Dismiss).
- Escape key dismisses via `dismissPending` latch.

### Quest log view (`questLogView.ts`)

- DOM shell (coverage-excluded).
- Renders `questLogModel.QuestLogViewModel` (pure, unit-tested).
- Shows active quests only (where `quest_state == Active`); no completed-quest history.
- 'Q' key toggles visibility (mutual exclusion per ADR-0014).

### Heal view (`healView.ts`)

- DOM shell (coverage-excluded).
- Renders `healModel.HealViewModel` (pure, unit-tested).
- Shows heal button, cooldown status, cost/effect text.
- Guards button via `isOnCooldown` and in-battle status.
- 'H' key toggles visibility (mutual exclusion per ADR-0014).

### Movement suppression in prediction loop

All three prediction-update sites must include dialogue/quest/heal visibility checks:
- **keydown handler:** Reject movement input if any overlay is visible.
- **rAF frame re-issue:** Suppress held-dir re-queue if any overlay is visible.
- **reconcile divergence:** Check overlay state before reissuing held direction at the pullback point.

Missed guards can cause movement while an overlay is open (ADR-0014 violation).

### Main integration (`main.ts`)

- Wires `dialogueView`, `questLogView`, `healView` instances.
- Escape key triggers `dismissPending` latch → `dismiss_dialogue` reducer (dialogue priority).
- Dialogue subscription setup via `connection.ts` (batch-listener wiring).
- `__game()` snapshot extended with current dialogue/quest/heal state for e2e debugging.

## Known limitations & follow-ups

1. **NPC display name:** The client has no name bundle for NPCs; `npcName` defaults to `npcId` (display as a number). Future M13+ content work should add an `npc_name` column to the server-seeded `npc` table or a separate bundle.

2. **Zone-unscoped NPC subscription:** `connection.ts` subscribes `npc` globally (no WHERE clause). This scales poorly in multi-zone worlds. M16 should add per-zone subscription filtering (part of the larger per-zone subscription scope-down).

3. **Completed-quest history invisible:** Completed quests are private (in `player_dialogue_state.done_quests` vector). Client has no render path until M16 RLS work materializes a `player_quest_completed` table or equivalent.

4. **Cooldown-on-same-batch race:** If `heal_party` succeeds and the player calls `heal_party` again in the same batch, `dismissPending` may not prevent the second call (very unlikely; parked for M16 post-analysis).

5. **`bigint` cooldown precision:** Client derives cooldown via local time (ADR-0012). Drift up to a few seconds is accepted; exact server-sent remaining-ms is a follow-up.

## Consequences

- Client is stateless for dialogue/quest/heal logic; all state lives on the server (ADR-0014, one-way flow).
- Dialogue text is a static read-only bundle; content changes require explicit sync (discipline + gating test).
- Quest log reflects only active quests; history is deferred to M16 RLS work.
- Heal cooldown is server-authoritative; client clock drift is tolerated per ADR-0012.
- Three new view-model layers (dialogueModel, questLogModel, healModel) are pure and unit-testable; three DOM shells are coverage-excluded.
- New gating tests pin bundle freshness, bigint boundaries, and dismissal-latch correctness; all green in CI.
