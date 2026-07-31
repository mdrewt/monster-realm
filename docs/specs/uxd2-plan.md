# uxd2 build plan — Shop-via-NPC context-sensitive interact (ADR-0161)

Plan of record for the uxd2 slice (spec: harness `specs/monster-realm-v2/M-postgate-ux-design.spec.md`
§uxd2). Produced by the planner, refined by a reviewer + red-team + simplify lens pass; adjudications
below are final for this slice. Drew's answers (embedded in the spec) govern: GREET-THEN-SHOP,
KeyG/KeyH removed, heal-via-tile only, shopkeeper deeper in zone 1, greeting "Hello, customer!".

## Reconciled acceptance criteria (deltas from the spec's literal EARS)

- **AC-2 (greet-then-shop, overrides the spec's direct-open default per Drew):** KeyT on a
  `Shop(shopId)` NPC sends the existing `talk` reducer (greeting opens). The greeting overlay presents
  a Shop action **derived from the server `NpcInteraction` enum** (never from choice text). Activating
  it ends the conversation (`dismissDialogue`) and opens the shop overlay bound to `shopId`; no shop
  reducer is called anywhere.
- **AC-10′ (KeyG/KeyH removed per Drew, replacing the spec's "preserve KeyG" line):** no
  `KeyG`/`KeyH` keydown handlers; no G/H rows in the helpModel CONTROLS SSOT; the default
  (first-shop / first-location) arms of `buildShopViewModel` / `healTargetLocationId` remain
  behaviourally unchanged (regression-pinned); `buy`/`heal_party` reducers byte-identical.
- **AC-12:** prompt reads "Shop" near the shopkeeper (it names the destination, not the next
  overlay); KeyT → `#dialogue-overlay` "Hello, customer!" → Shop action → `#shop-overlay`. 3 tiles
  away: prompt hidden, KeyT opens nothing.
- **AC-15 (added):** `plan_npc_sync` emits `Update` on an interaction-only def/row diff
  (`npc_row_stale` gains `|| npc.interaction != def.interaction` — ADR-0054 silent-skip class).
- **AC-16 (added):** unknown/malformed `interaction` tag from the SDK normalizes to `dialogue`
  and never throws (subscription-callback totality). Payload reads use `??`/typeof, never `||`
  (falsy-0 trap, rowConvert.ts:277 precedent).

## Increments (strictly ordered)

- **I0** `game-core/src/types.rs`: `NpcInteraction { #[default] Dialogue, Shop(u32), Heal(u32) }`,
  derives `Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize` +
  `cfg_attr(spacetimedb, SpacetimeType)`. `game-core/src/lib.rs` re-export.
- **I1** `game-core/src/content.rs`: `NpcDef` += `#[serde(default)] pub interaction: NpcInteraction`;
  NEW `validate_npc_interactions(npcs, shops, heal_locations)` (BTreeSet cross-ref of `Shop(id)` →
  `ShopDef.id`, `Heal(id)` → `HealLocationDef.location_id`; exhaustive match, explicit `Dialogue`
  no-op arm, no wildcard). Fix `NpcDef` literals (fixture :4277, golden :4822).
- **I2** `server-module/src/schema.rs`: `Npc` += `pub interaction: NpcInteraction` (appended last).
  `server-module/src/content.rs`: `npc_row_from_def` threads it; `npc_row_stale` += interaction diff;
  `validate_npc_interactions` called in the VALIDATE block (after `validate_npc_content`, before any
  write). `server-module/src/lib.rs`: `CONTENT_VERSION` 16 → 17. Fix `Npc` literals in
  `content_tests.rs` (incl. `m13_5c_pair_from_def` :875-898).
- **I3** RON (APPEND-only; `content.rs:4835` pins elder_oak as `defs.first()`):
  `npcs/000-core.ron` += shopkeeper `id: 2, npc_id: "tideglass_shopkeeper", zone_id: 1,
  spawn/home (8,1), wander_radius: 0, dialogue_tree_id: "shopkeeper_greeting", sprite_id: 10,
  interaction: Shop(1)`. `dialogue_trees/000-core.ron` += one-node inert tree: text
  "Hello, customer!", single choice `("Leave", next_node: None)`, no effects.
- **I4** `just gen`; baselines: `evals/baselines/spacetime-types.json` += NpcInteraction,
  `table-schemas.json` npc += interaction, `node evals/content-version.eval.mjs --update`.
- **I5** `client/src/net/rowConvert.ts`: `SdkNpcRow` += `{ tag, value? }`; total converter →
  discriminated union; `HANDLED_ENUM_VARIANTS` += `NpcInteraction: ['Dialogue','Shop','Heal']`
  (only AFTER `just gen` — sdk-enum-exhaustiveness C3 rejects stale registry entries).
  `client/src/net/store.ts`: `StoreNpcRow` += `interaction:
  {kind:'dialogue'} | {kind:'shop'; shopId:number} | {kind:'heal'; locationId:number}`.
- **I6** NEW `client/src/ui/interactModel.ts`: `CLIENT_INTERACT_RANGE = 2`;
  `nearestInteractable(own, npcs, characterTiles, healLocations)` → descriptor | undefined —
  same-zone only (NPCs via character-row join; heal tiles via **explicit** `loc.zoneId ===
  own.zoneId`), range ≤ 2 Manhattan, ordering `(dist asc, kindRank npc=0 < tile=1, id asc
  within kind)` — ids are never compared across kinds (bigint/number). Descriptor arms carry
  `anchorWorldX = (tileX + 0.5) * TILE_PX`, `anchorWorldY = tileY * TILE_PX` (SOURCE px).
  `interactPrompt(target, anyOverlayVisible)` → `{visible: true, actionWord, keyGlyph:'T',
  anchorWorldX, anchorWorldY} | null`.
  DELETE `nearestTalkableNpcId` + `CLIENT_TALK_RANGE` from `dialogueModel.ts` (sole consumer is
  main.ts:934); port `dialogueModel.talk.test.ts`'s 8 cases into `interactModel.test.ts` and delete
  that file. `buildDialogueViewModel` += `shopAction: { shopId } | null` derived from
  `npc.interaction` (already receives the npcs map).
  `shopModel.ts`: NEW thin `buildShopViewModelForShop(shopId, …)` (filters then delegates; missing
  id → `no-shop`). `healModel.ts`: NEW thin `buildHealViewModelForLocation(locationId, …)` (filters;
  unknown id → empty list). Default arms untouched.
- **I6b** `client/src/render/world.ts` (+~6 lines): `render()` stashes the offset it applied;
  NEW `screenFor(world)` = `worldToScreen(world, #lastOffset, #vs.stageScale)` — the prompt consumes
  the EXACT transform the stage used this frame (no parallel camera, no mid-slide swim).
- **I7** `client/src/ui/dialogueView.ts`: render `[data-shop-id]` Shop button when `vm.shopAction`
  (no `data-choice-idx` on it). `client/src/main.ts`:
  1. DELETE KeyH (:671-696) + KeyG (:697-731) blocks; fix stale comment :2089 (Escape-only recovery).
  2. KeyT: keep 14-way guard + identity guard; exhaustive switch — `case 'dialogue': case 'shop':`
     → `sendGuarded('talk', …)`; `case 'heal':` → `boundHealLocationId = id;
     healView?.render(buildHealViewModelForLocation(id, …))` — no reducer.
  3. Shop-button click branch (next to :1421): `pendingShopId = shopId` ALWAYS; send
     `dismissDialogue` only if `!dismissPending` (set inside the lambda, C6 discipline).
  4. Escape-dialogue branch: `pendingShopId = null` (Escape cancels a pending shop-open —
     last-intent-wins).
  5. Dialogue batch listener `if (!conv)` arm: consume-and-clear `pendingShopId` atomically; open
     the shop ONLY IF no overlay is visible (extracted `anyOverlayVisible()` predicate — a battle
     that opened meanwhile drops the pending open silently). Sets `boundShopId`.
  6. Shop batch listener: re-render with `boundShopId` (never silently swap to first-shop).
     Heal refresh listener (:1270): render `ForLocation(boundHealLocationId)` when set.
  7. `onHealParty` (:1767-1779): UNTOUCHED (first-location default stays; binding the send is an
     ADR-recorded deferral until a second heal location exists — the overlay bind is view-state only).
  8. Clear `pendingShopId`/`boundShopId`/`boundHealLocationId` on reconnect (next to :2091
     `shopView?.hide()`) and on the Escape/hide branches for shop/heal.
  9. `#interact-prompt`: created inline next to the `#status` precedent (:2045) —
     `position:fixed; pointer-events:none;` display-none default. Frame loop (after
     `renderer?.render(…)` :2197): resolver → `interactPrompt(target, anyOverlayVisible())` →
     `renderer.screenFor(anchor)` → memoized style/text writes. Recomputed per frame ⇒ self-heals
     on zone switch/reconnect/overlay open.
  10. `helpModel.ts`: delete G/H rows; reword T ("Interact — talk / shop / heal"); update header
      comment. (Tester owns `helpModel.test.ts` + `main.wiring.test.ts` list rewrites.)
  11. `client/src/ui/dialogueContent.ts`: mirror the new tree (drift-gated by
      dialogue-client-integrity C6; also required for the greeting text to render at all).
- **I8** NEW `client/e2e/shop-npc.spec.ts` (single context, stepOne idiom, WORLD-FACTS header):
  zone0 (1,1) →E×5→(6,1) →S×3→(6,4) →S→(6,5) →W→(5,5) [warp; assert zone 1] →N→(5,4) →E→(6,4)
  →N→(6,3) →N→(6,2) [negative: dist 3 — prompt hidden; KeyT → nothing opens] →N→(6,1) [dist 2 —
  prompt visible "Shop"] → KeyT → `#dialogue-overlay` "Hello, customer!" → click `[data-shop-id]`
  → `#shop-overlay` visible AND `#dialogue-overlay` hidden. No retry loops (wander_radius 0).
  NOTE: the naive N,N,N,N,E route from (5,5) bumps the (5,3) wall — the x=6 column route above is
  the only clean one. `dialogue.spec.ts` stays UNMODIFIED (AC-13 regression guard).
- **I9** `docs/adr/0161-*.md` (Status Accepted from the start — digest hard-fails Proposed;
  Decision ≤ 240 chars); `just adr-digest`; `just knowledge`; spec §uxd2 reconciliation note
  (doc-keeper); handoff + progress memo.

## Adjudications (final)

1. **Deferred shop-open** (vs immediate): immediate punctures the one-overlay invariant and
   mis-routes Escape during the overlap (Escape hits the dialogue branch before the shop branch).
   Deferred degrades cleanly on a frozen link. Hardened per AC above (guard at consumption,
   clear-on-consume/Escape/reconnect).
2. **Heal send binding dropped** (view bind only): BoxView's heal is distance-independent by
   design; binding the send adds stale state for zero behavior change with one seeded location.
   Deferral recorded in ADR-0161.
3. **trade.spec.ts untouched**: its KeyG/KeyH press blocks go vacuously green after removal (the
   guard they tested no longer exists). Follow-up flag, not a defect of this slice.
4. **Two-ref smoke-republish tooling** (red-team F3: schema-widening on live rows is exercised by
   no gate): out of scope — its own tooling slice. `just smoke-republish` still runs pre-PR;
   residual recorded in ADR-0161.
5. **Out-of-declared-touches set (all mechanically forced, listed for the PR's touches-delta):**
   `rowConvert.ts` (+test), `connection.ts` (1-line local SdkNpcRow mirror — same mechanically-forced
   class as rowConvert; found at implementation), `dialogueContent.ts` (eval C6), `dialogueView.ts` (Shop button),
   `helpModel.ts` (+test — forced by the KeyG/H removal), `main.wiring.test.ts` (hard-coded key
   lists), `world.ts` (screenFor), `evals/baselines/*` (snapshot gates), `dialogueModel.talk.test.ts`
   (deleted, cases ported). uxd2 launched SOLO (supervisor note 2026-07-31): no concurrent sibling
   can own these files.

## Test matrix (tester-owned; all start RED)

| AC | Where |
|----|-------|
| 1 dialogue→talk | interactModel.test.ts kind cases · main.wiring KeyT source-scan (talk present, no buy/healParty) |
| 2 greet-then-shop | dialogueModel.test.ts shopAction derivation · main.wiring [data-shop-id]→dismiss (no shop reducer) · e2e |
| 3 heal→bound overlay | interactModel heal cases · healModel ForLocation (found/unknown→empty) · main.wiring heal arm no-reducer scan |
| 4 determinism | fast-check property (min of (dist, kindRank, idWithinKind)) + explicit ties: NPC-vs-tile equal dist → NPC; two NPCs → lowest entityId; permutation invariance; bigint-vs-number tie tooth (locationId 1 vs entityId 9007199254740993n) |
| 5 none in range | dist-3 → undefined; other-zone NPC + other-zone heal (same coords!) → undefined; prompt null |
| 6 overlay suppression | interactPrompt(target, true) → null · KeyT 14-way guard intact (wiring scan) |
| 7 prompt VM | actionWord per kind; keyGlyph T; anchorWorld = ((tileX+0.5)·TILE_PX, tileY·TILE_PX) |
| 8 validator teeth | Rust: Shop(999)→Err naming npc+id; Heal(999)→Err; valid→Ok; real content→Ok; wiring scan: sync_content_inner calls validate_npc_interactions before write phase |
| 9 serde default | 10-field RON (no interaction) parses → Dialogue; golden :4822 pins it |
| 10′ G/H removed | wiring: no `e.code === 'KeyG'/'KeyH'`; SIBLING_KEYS/OPEN_HANDLERS shrunk; helpModel.test hotkey blob 12→10; shopModel/healModel default-arm tests untouched |
| 11 reducers byte-identical | review-phase `git diff --exit-code` on economy.rs/raising.rs (verifier) |
| 12 e2e boundary | shop-npc.spec.ts (dist 3 hidden / dist 2 visible / full greet-then-shop chain) |
| 13 dialogue e2e green | dialogue.spec.ts unmodified, run in `just e2e` |
| 14 row carries interaction | content_tests: npc_row_from_def copies def.interaction |
| 15 sync diff | content_tests: plan_npc_sync_detects_only_interaction_change (sibling of the 5 existing per-field teeth) |
| 16 boundary totality | rowConvert.test: Shop/Heal/Dialogue tags; unknown tag → dialogue no-throw; missing value → dialogue; **value 0 → shopId 0 (not dropped)**; store.test upsertNpc round-trip |

## Ship-gate order

nextest game-core → ci-fast monster-realm-module → just gen → 3 baselines → client npm test →
typecheck → just eval → just knowledge(+check) → ADR + adr-digest → **full just ci (once)** →
just e2e (shop-npc + dialogue + trade) → just smoke-republish → PR.

## Anti-patterns (enforced in review)

Client-side role map · choice-text string matching · `_ =>`/`default:` on NpcInteraction ·
mixed-unit camera math (CSS px into offsetFor; missing stageScale) · throw at the SDK boundary ·
`||` on enum payloads (falsy-0) · a 15th mutual-exclusion entry or new hotkey · prepending to RON ·
editing dialogue.spec.ts · fixing the ux2 wallet gap here (D6 — separate follow-up) ·
per-frame unmemoized style writes.
