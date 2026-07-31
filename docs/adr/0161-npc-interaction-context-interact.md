# 0161 — Server-anchored NpcInteraction enum and the context-sensitive KeyT interact system

**Status:** Accepted
**Date:** 2026-07-31
**Slice:** uxd2 (M-postgate-ux-design — shop-via-NPC interaction)
**Supersedes:** —
**Amends:** —
**Subsystems:** content, client-ui, schema-persistence
**Decision:** NPC roles live in a server-anchored NpcInteraction{Dialogue,Shop(u32),Heal(u32)} enum column; one pure nearestInteractable resolver drives a generalized KeyT (greet-then-shop per Drew) and an on-world prompt; global KeyG/KeyH are removed.

## Context

Drew's 2026-07-25 playtest surfaced that the shop opened from a world-unconnected global `KeyG`;
the tester expected to walk up to a shopkeeper and interact. The uxd2 design (spec
`M-postgate-ux-design.spec.md` §uxd2, converged via a multi-agent pass and grounded per file:line)
committed to a server-anchored interaction enum + a generalized interact key. Drew answered the four
open questions: **GREET-THEN-SHOP** (overriding the spec's direct-open AC default), **remove** the
global `KeyG`/`KeyH` shortcuts, ship **heal-via-tile** only (no Heal-variant NPC seeded), and place
the shopkeeper **deeper** in zone 1 with the placeholder greeting "Hello, customer!".

Facts that shaped the implementation:

1. **The client already had exactly one proven resolver** — `nearestTalkableNpcId`
   (`dialogueModel.ts:39-57`): same-zone via character-row join, Manhattan ≤ 2, min-distance,
   lowest-id tiebreak. Its sole runtime consumer was the `KeyT` handler (`main.ts:934`).
2. **Heal tiles were already public, positioned, and in the store** (`heal_location_row`,
   `store.healLocations()`), so heal interactables cost zero server work.
3. **uxd1 landed first**, so the on-world prompt consumes the uxd1 seam: `worldToScreen`
   (`render/viewport.ts:116`) under the exact camera offset + `stageScale` the renderer applied.
   Spec §4 anticipated this ordering ("if uxd1 lands first, uxd2 reuses it").
4. **`plan_npc_sync` staleness is a hand-maintained OR-chain** (`server-module/src/content.rs`,
   `npc_row_stale`) with one per-field regression tooth each — a new def-derived field that skips
   the chain silently never re-syncs (the ADR-0054 defect class).

## Decision detail

### D1 — Data model: exhaustive enum, additive column
`NpcInteraction { #[default] Dialogue, Shop(u32), Heal(u32) }` lives in `game-core/src/types.rs`
(serde always; `SpacetimeType` under the `spacetimedb` feature, ADR-0003), is an additive
`#[serde(default)]` field on `NpcDef`, and an appended column on the public `npc` table threaded
through `npc_row_from_def`. Chosen over a client-side role map (drifts; forecloses server
proximity-hardening of `buy`/`heal_party`, the documented Phase-2 gate) and over a bare
`Option<u32> shop_id` (no room for Heal-on-NPC without a second column; the repo prizes exhaustive
enums — a 4th variant compiler-flags every match site). `npc_row_stale` gains
`|| npc.interaction != def.interaction` with its own plan-level tooth (AC-15).

### D2 — Validator: separate function, independently falsifiable
`validate_npc_interactions(npcs, shops, heal_locations)` is a NEW function called in
`sync_content_inner`'s validate block (all-before-any-write) — `validate_npc_content`'s 6-arg
signature (~40 test call sites) is untouched (ADR-0010 independent falsifiability). Teeth: a
`Shop(id)`/`Heal(id)` referencing a missing shop/heal-location fails the seed with the NPC named.

### D3 — Resolver: one pure core, class-ranked determinism
`nearestInteractable` (NEW `client/src/ui/interactModel.ts`) generalizes and **replaces**
`nearestTalkableNpcId` (deleted; its 8 test cases ported). Ordering is
`(distance asc, kindRank NPC=0 < tile=1, id asc within kind)` — the class rank fires before any id
comparison, so `bigint` NPC entity ids and `number` heal location ids are never compared across
kinds (a naive single-key compare inverts NPC-before-tile almost always, since `entity_id` is a
global auto-inc; red-team PoC confirmed `tsc --strict` accepts the buggy compare silently). Heal
tiles get an explicit `zoneId` filter (NPCs inherit theirs from the character-row join). uxd3's
`Talk.available()` should consume `nearestInteractable(...)?.kind === 'dialogue'` — the symbol it
cites no longer exists.

### D4 — GREET-THEN-SHOP: the Shop affordance derives from the enum, not from content
KeyT on a Shop NPC sends the existing `talk` reducer (the dialogue and shop arms share one
dispatch arm — behaviourally identical under greet-then-shop). The greeting tree in RON is
genuinely inert (one node, "Hello, customer!", a single Leave choice). The Shop button is a
client-side affordance derived in `buildDialogueViewModel` from `npc.interaction`
(`shopAction: {shopId} | null`) — never from choice text (un-pinnable string coupling) and never
duplicated into dialogue content (would drift from the enum SSOT). Clicking it sends
`dismissDialogue` and defers the shop-open to the dialogue batch listener's `if (!conv)` arm:
the open is gated on no-overlay-visible at consumption time (a battle that opened meanwhile drops
it), consumed-and-cleared atomically, cancelled by Escape (last-intent-wins), and cleared on
reconnect. An immediate open-on-click was rejected: it stacks two overlays for a round-trip,
during which Escape hits the dialogue branch instead of the shop, and a frozen link pins the
overlap permanently. Side effect: the validator-required `dialogue_tree_id` is **live** content
under greet-then-shop, retiring the spec's dead-content residual.

### D5 — KeyG/KeyH removed; select-by-id variants
Per Drew, the `KeyG`/`KeyH` handlers and their helpModel rows are deleted (the spec's literal
"preserve KeyG" AC is superseded; spec updated). The shop overlay now opens only bound:
`buildShopViewModelForShop(shopId, …)` (thin filter-then-delegate; missing id → `no-shop`) plus a
`boundShopId` used by the shop refresh listener so a batch never silently swaps a bound shop to
first-shop. The heal overlay binds its **view** (`buildHealViewModelForLocation`, refresh-consistent
via `boundHealLocationId`) but `onHealParty`'s send keeps the first-location default —
`buy`/`heal_party` reducers and the BoxView heal path are byte-identical to master.

### D6 — Prompt: pure VM, renderer-owned transform, inline DOM node
`interactPrompt(...)` returns a VM with the anchor in SOURCE px (`(tileX+0.5)·TILE_PX` top-center).
`WorldRenderer` gains ~6 lines: it stashes the camera offset `render()` actually applied and exposes
`screenFor(world)` — the ONE tested transform (`offsetFor` + `worldToScreen`), so the DOM prompt
cannot swim against the canvas mid-slide (it tracks the same fractional camera the stage used). The
`#interact-prompt` element is created inline in `main.ts` beside the `#status` precedent —
`position:fixed`, `pointer-events:none` (the document-level dialogue click handler must never be
shadowed), memoized style writes. A dedicated view module + coverage-exclusion registrations
(4 files) was cut as over-build: the logic is in the VM; the shell is e2e-proven.

### D7 — Content placement
Shopkeeper `tideglass_shopkeeper` (id 2) seeded in zone 1 at (8,1), `wander_radius: 0`
(stationary — `npc_decide` radius-0 is a pinned special case, making the new e2e deterministic
with no retry loops), `interaction: Shop(1)`. Zone 1 keeps it off `dialogue.spec.ts`'s zone-0
walk; the zone-0 heal tile (8,3) is Manhattan 4 from that spec's talk pocket (5,4) — outside
range 2 — so the untouched dialogue e2e stays green (AC-13; a resolver node tooth pins the
NPC-before-tile tie rule regardless).

## Consequences

- Server proximity-hardening of `buy()`/`heal_party()` can later read the same enum column —
  the only shape that permits it (spec key decision) — without another schema change.
- The public `npc` row widened (BSATN): all subscribers re-sync on republish (ADR-0103 gate:
  bindings regen, snapshot baselines, CONTENT_VERSION 17, smoke-republish).
- uxd3 must consume `nearestInteractable` (D3) and inherits two vacated surfaces: the
  `trade.spec.ts:207-227` KeyG/KeyH press blocks are now vacuously green (the guard they killed
  no longer exists) and should be re-pointed or removed by a follow-up.

## Residuals / follow-ups (flagged, deliberately not done here)

- **Heal send binding** (D5) waits for a second heal location; the seam (`data-location-id` on
  the heal `<li>`, `boundHealLocationId` view state) exists.
- **Schema-widening republish has no two-ref gate**: `smoke-republish.sh` builds both publishes
  from one tree, so "old rows survive a column-adding republish" is exercised only by the real
  deployment (red-team F3). A two-ref smoke variant is its own tooling slice.
- **ux2 wallet gap**: `main.ts` never passes `ownWallet` to `buildShopViewModel`, so the shop
  balance always renders unknown — pre-existing, outside this slice's EARS set.
- **trade.spec.ts vacuous blocks** (see Consequences).
