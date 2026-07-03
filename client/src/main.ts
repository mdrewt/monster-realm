// monster-realm client — the integrated loop (M5a, folds in the M4c app wiring).
//
// Binds the tested pure cores into the live one-way flow (ADR-0012/0013/0014):
//   server --(SDK rows)--> connection adapter --> AuthoritativeStore  (truth in)
//   input  --> Predictor (predict via the SAME wasm rule) + send intent reducers
//   batch-applied --> Predictor.reconcile (4-step against a coherent snapshot)
//   rAF    --> Predictor.drain --> WorldRenderer.render (own=predicted, remote=auth)
//
// The own character renders from its self-owned slide clock (fractional sub-tile)
// and remotes from the interpolation buffer (now − interpDelay), via RenderResolver
// (M8.6b, ADR-0013). A DEV `window.__game()` snapshot lets the M5 two-window e2e
// assert on STATE (predicted vs authoritative tiles, presence, the zone map), never
// pixels.

// client-wasm (built `wasm-pack build client-wasm --target bundler`; resolved by
// vite-plugin-wasm + top-level-await — see vite.config.ts / server.fs.allow).
import {
  apply_move,
  move_queue_cap,
  party_size,
  party_slot_none,
  set_active_zone,
  step_ms,
  zone_map,
} from '../../client-wasm/pkg/client_wasm.js';
import {
  characterToPredictedBaseline,
  moveInputToSdk,
  type SdkCharacterFields,
  type WasmDirection,
  type WasmMoveInput,
} from './convert/convert';
import { shouldToggleBox } from './inputGuards';
import { connect } from './net/connection';
import { AuthoritativeStore } from './net/store';
import { HeldDirections, reissueDir } from './prediction/heldKeys';
import { type ApplyMove, boundSeq, Predictor } from './prediction/predictor';
import { TileMap } from './render/map';
import { RenderResolver } from './render/renderResolver';
import { installResizeHandler } from './render/resizeWiring';
import { WorldRenderer } from './render/world';
import { buildBattleViewModel, decideBattleOverlay } from './ui/battleModel';
import type { BattleView } from './ui/battleView';
import { buildBoxViewModel, buildPartyViewModel, nextFreePartySlot } from './ui/boxModel';
import type { BoxView } from './ui/boxView';
import { DIALOGUE_TREES } from './ui/dialogueContent';
import { buildDialogueViewModel } from './ui/dialogueModel';
import type { DialogueView } from './ui/dialogueView';
import { buildEvolutionViewModel } from './ui/evolutionModel';
import type { EvolutionView } from './ui/evolutionView';
import { buildHealViewModel } from './ui/healModel';
import type { HealView } from './ui/healView';
import { buildQuestLogViewModel } from './ui/questLogModel';
import type { QuestLogView } from './ui/questLogView';
import { buildRaisingViewModel } from './ui/raisingModel';
import type { RaisingView } from './ui/raisingView';

const URI = (import.meta.env.VITE_STDB_URI as string | undefined) ?? 'ws://127.0.0.1:3000';
const DB = (import.meta.env.VITE_STDB_DB as string | undefined) ?? 'monster-realm';
const ZONE_ID = 0;

// Content is single-sourced from game-core via the wasm exports (never duplicated).
const STEP_MS = step_ms();
const QUEUE_CAP = move_queue_cap();
const PARTY_SIZE = party_size();
const PARTY_SLOT_NONE = party_slot_none();
// M11c: rawMap is `let` — replaced on zone warp (zone_map() re-called for the new zone id).
let rawMap = zone_map(ZONE_ID);

const store = new AuthoritativeStore();
// The injected rule IS the client-wasm export (same compiled code as the server).
const applyMove = apply_move as unknown as ApplyMove;
let predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
// Routes own (slide clock) vs remote (interpolation buffer) renders (M8.6b).
const resolver = new RenderResolver(STEP_MS);
// Held movement keys (most-recently-pressed stack) — drives the frame-loop
// continuation re-issue so a held key keeps walking (M8.6c, ADR-0013).
const held = new HeldDirections();
// M12.5c: renderer is module-scope so switchZone (below) can call setMap without
// being inside main(). Defined here; assigned once inside main() after async init.
let renderer: WorldRenderer | undefined;
// M12.5d-4: camera hold — persists the last resolved tile position so the camera
// doesn't snap to origin when the own entity is temporarily unresolved (warp / reconnect).
const lastCamX = 0;
const lastCamY = 0;

// Sticky DEV latch: set once the own entity renders a fractional sub-tile position
// (proves the slide clock is wired, not raw integer tiles). Never reset to false
// except on reconnect. The e2e reads it via window.__game().
let sawFractionalOwnMotion = false;

let identity = '';
let conn: ReturnType<typeof connect> | undefined;
let boxView: BoxView | undefined;
let battleView: BattleView | undefined;
let raisingView: RaisingView | undefined;
let evolutionView: EvolutionView | undefined;
let dialogueView: DialogueView | undefined;
let questLogView: QuestLogView | undefined;
let healView: HealView | undefined;
// dismissPending: prevents double-sending dismiss_dialogue while server processes it (M12d).
// eslint-disable-next-line prefer-const
let dismissPending = false;
// Outcome-frame lifecycle (M8.7e): the dismissed battle id (so a resolved outcome
// renders once but never re-pops) + whether any battle has been observed this
// session (first-sight pre-dismiss of a historical/stale-on-login resolved battle).
let dismissedBattleId: bigint | null = null;
let battleSynced = false;

let resolveReady: () => void = () => {};
const ready = new Promise<void>((r) => {
  resolveReady = r;
});

// --- M12.5c: prediction-state reset (moved to module scope for switchZone access) ----
// Resets the predictor, slide clock, held keys, and sticky latches without touching
// the store or rawMap. Called from switchZone AND from onReconnect.
function resetPredictionState(): void {
  predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
  resolver.reset();
  held.clear();
  sawFractionalOwnMotion = false;
  dismissedBattleId = null;
  battleSynced = false;
  // M12.5d-4: reset camera hold so a fresh zone/reconnect starts at origin rather than
  // holding a position from a prior zone.
  lastCamX = 0;
  lastCamY = 0;
}

// --- M12.5c: idempotent zone-switch (12.5c-1/2/3) --------------------------------
// Validates the new zone's map BEFORE mutating any state (12.5c-3: parse-first).
// Does NOT call store.resetCharacters(): the render filter (currentZoneId) excludes
// stale-zone characters, so idle remotes in the destination zone stay visible (12.5c-2).
// Idempotent: a no-op if newZoneId already matches rawMap (prevents double-switch when
// both onOwnWarp and the reconcile listener fire on the same live warp).
function switchZone(newZoneId: number): void {
  if (newZoneId === rawMap.zone_id) return;
  try {
    const newRawMap = zone_map(newZoneId);
    TileMap.fromRaw(newRawMap); // validate BEFORE any mutation (12.5c-3) — throws on bad data
    renderer?.setMap(newRawMap); // draw BEFORE committing zone state (RT-SZ-01: atomicity)
    set_active_zone(newZoneId);
    rawMap = newRawMap;
    resetPredictionState();
  } catch (err) {
    console.error('[zone-sync] zone switch to %s failed — keeping current zone', newZoneId, err);
  }
}

// --- reconcile own character on every coherent (batched) authoritative snapshot --
// MUST be total (never throw to caller): store.flushBatch has no per-listener
// isolation, so an uncaught throw starves sibling listeners (UI stall). (12.5c-4)
store.onBatchApplied(() => {
  try {
    if (identity === '') return;
    const own = store.ownCharacter(identity);
    const player = store.player(identity);
    if (own === undefined || player === undefined) return;

    // 12.5c-1: State-based zone sync — catches reconnect-strand (a character
    // INSERTED at zone 0 after disconnect-in-zone-1 fires no onUpdate, so the
    // edge-triggered onOwnWarp never fires; but the zone mismatch IS visible here
    // on every batch). Also subsumes live-warp: switchZone is idempotent so if
    // onOwnWarp already updated rawMap this is a no-op.
    // After switchZone, fall through to reconcile: this seeds the fresh predictor
    // from the authoritative baseline so ownPredictedTile is non-null on the same
    // batch (seeding reconcile returns false → no spurious re-issue).
    if (own.row.zoneId !== rawMap.zone_id) {
      switchZone(own.row.zoneId);
    }

    const now = performance.now();
    // The store holds wasm-shaped rows; rebuild the SDK movement subset so the
    // single-sourced rebasing baseline (ADR-0012, convert.ts) stays the one rule.
    const sdkFields: SdkCharacterFields = {
      tileX: own.row.tileX,
      tileY: own.row.tileY,
      facing: { tag: own.row.facing },
      action: { tag: own.row.action },
      moveStartedAtMs: own.row.moveStartedAtMs,
    };
    const baseline = characterToPredictedBaseline(sdkFields, now, STEP_MS);
    // Fail-loud u64→number bound (M8.8e §B) replacing the unbounded downcast.
    // A last_input_seq past the safe-integer bound is a corrupt/hostile server
    // field — log loudly and skip THIS batch's reconcile, never wedge the UI.
    let ackedSeq: number;
    try {
      ackedSeq = boundSeq(player.lastInputSeq);
    } catch (err) {
      console.error(`[reconcile] ${(err as Error).message}; skipping batch`);
      return;
    }
    // Reconnect re-seed (M8.8e §A): keep #nextSeq ≥ the server ack at all times.
    predictor.seedSeq(ackedSeq);
    // predictor.reconcile is inside the outer try-catch (12.5c-4): a wasm throw
    // here is contained and never starves sibling batch listeners.
    const diverged = predictor.reconcile(baseline, own.row.moveQueue, ackedSeq, now);
    // Honor reconcile's documented divergence return (ADR-0013): on a genuine server
    // pullback, re-commit the held direction so a held key keeps walking from the
    // corrected baseline (same held-state-guarded dedup as the rAF frame loop).
    if (
      diverged &&
      !(
        battleView?.visible ||
        boxView?.visible ||
        raisingView?.visible ||
        evolutionView?.visible ||
        dialogueView?.visible ||
        questLogView?.visible ||
        healView?.visible
      )
    ) {
      const heldDir = reissueDir(held.active(), predictor.lastQueuedDir);
      if (heldDir !== undefined) sendIntent({ Step: heldDir });
    }
  } catch (err) {
    console.error('[reconcile] uncaught error in batch listener', err);
  }
});

// --- input: predict locally + send the intent to the M2 reducer (seq-tracked) ----
function sendIntent(input: WasmMoveInput): void {
  if (conn === undefined) return;
  const intent = predictor.enqueue(input);
  if (intent === undefined) return; // ADR-0052: declined (queue at cap) — predict & send nothing
  conn.conn.reducers.enqueueMove({ input: moveInputToSdk(input), seq: BigInt(intent.seq) });
}
const step = (dir: WasmDirection): void => sendIntent({ Step: dir });
const jump = (): void => sendIntent('Jump');

const KEY_DIR: Readonly<Record<string, WasmDirection>> = {
  ArrowUp: 'North',
  KeyW: 'North',
  ArrowDown: 'South',
  KeyS: 'South',
  ArrowLeft: 'West',
  KeyA: 'West',
  ArrowRight: 'East',
  KeyD: 'East',
};
window.addEventListener('keydown', (e) => {
  if (e.repeat) return; // ignore OS key-repeat (the frame loop re-issues held keys)
  if (e.code === 'KeyB') {
    // Guard: don't open the box over an active battle (ADR-0014/0052 exit ordering).
    if (shouldToggleBox(battleView?.visible ?? false)) {
      raisingView?.hide(); // mutual exclusivity: box and raising never co-open
      evolutionView?.hide(); // mutual exclusivity: close evolution overlay
      boxView?.toggle();
      if (boxView?.visible) refreshBox();
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyI') {
    // Inventory/raising overlay — same battle guard as the box (reuse shouldToggleBox).
    if (shouldToggleBox(battleView?.visible ?? false)) {
      boxView?.hide(); // mutual exclusivity: box and raising never co-open
      evolutionView?.hide(); // mutual exclusivity: close evolution overlay
      raisingView?.toggle();
      if (raisingView?.visible) refreshRaising();
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyE') {
    // Evolution/fusion overlay — same battle guard as box/raising (ADR-0014).
    if (shouldToggleBox(battleView?.visible ?? false)) {
      boxView?.hide(); // mutual exclusivity
      raisingView?.hide(); // mutual exclusivity
      evolutionView?.toggle();
      if (evolutionView?.visible) refreshEvolution();
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyQ') {
    // Quest log overlay — mutual exclusivity with all other overlays (M12d, ADR-0071).
    if (
      !battleView?.visible &&
      !boxView?.visible &&
      !raisingView?.visible &&
      !evolutionView?.visible &&
      !dialogueView?.visible &&
      !healView?.visible
    ) {
      if (questLogView?.visible) {
        questLogView.hide();
      } else {
        questLogView?.render(buildQuestLogViewModel(store.ownQuests(identity)));
      }
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyH') {
    // Heal overlay — mutual exclusivity: only when no other overlay is open (M12d, ADR-0071).
    if (
      !battleView?.visible &&
      !boxView?.visible &&
      !raisingView?.visible &&
      !evolutionView?.visible &&
      !dialogueView?.visible &&
      !questLogView?.visible
    ) {
      if (healView?.visible) {
        healView.hide();
      } else {
        healView?.render(buildHealViewModel(store.healLocations(), store.itemDefs()));
      }
    }
    e.preventDefault();
    return;
  }
  // Escape priority: battle > box > raising > evolution > dialogue > questLog > heal (ADR-0071).
  if (e.code === 'Escape' && battleView?.visible) {
    const latest = store.latestPlayerBattle(identity);
    // Terminal outcome frame: permanent dismiss (don't re-pop next batch). Ongoing:
    // bare hide — the next batch auto-re-shows the active battle (existing behavior).
    if (latest !== undefined && latest.outcome !== 'Ongoing') dismissedBattleId = latest.battleId;
    battleView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && boxView?.visible) {
    boxView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && raisingView?.visible) {
    raisingView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && evolutionView?.visible) {
    evolutionView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && dialogueView?.visible) {
    // dismissPending guards against double-send while server processes the dismiss.
    if (!dismissPending) {
      dismissPending = true;
      conn?.conn.reducers.dismissDialogue({});
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && questLogView?.visible) {
    questLogView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && healView?.visible) {
    healView.hide();
    e.preventDefault();
    return;
  }
  // Suppress movement input while an overlay is open.
  if (
    battleView?.visible ||
    boxView?.visible ||
    raisingView?.visible ||
    evolutionView?.visible ||
    dialogueView?.visible ||
    questLogView?.visible ||
    healView?.visible
  )
    return;
  const dir = KEY_DIR[e.code];
  if (dir !== undefined) {
    step(dir); // immediate first step (latency + deliberate double-tap)
    held.press(dir); // mark held so the frame loop re-issues it (continuous walk)
    e.preventDefault();
    return;
  }
  if (e.code === 'Space') {
    jump(); // Jump does not hold-repeat
    e.preventDefault();
  }
});

// Release a held movement key; a still-held key falls back to the most-recent (M8.6c).
window.addEventListener('keyup', (e) => {
  const dir = KEY_DIR[e.code];
  if (dir !== undefined) held.release(dir);
});

// Drop all held keys on blur so a key isn't stuck "held" while unfocused.
window.addEventListener('blur', () => held.clear());

// --- box/party view: refresh on batch when visible (M6c, ADR-0014) ---------------
function refreshBox(): void {
  if (!boxView?.visible || identity === '') return;
  const monsters = store.ownMonsters(identity);
  const speciesMap = store.speciesMap();
  boxView.refresh(
    buildPartyViewModel(monsters, speciesMap, PARTY_SIZE),
    buildBoxViewModel(monsters, speciesMap, PARTY_SLOT_NONE),
  );
}
store.onBatchApplied(() => refreshBox());

// --- raising/inventory view: refresh on batch when visible (M9c, ADR-0014) -------
// MUST be total (never throw): store.flushBatch has no per-listener isolation, so a
// throw here would starve the sibling reconcile/refreshBox/refreshBattle listeners.
function refreshRaising(): void {
  if (!raisingView?.visible || identity === '') return;
  const monsters = store.ownMonsters(identity);
  const inventory = store.ownInventory(identity);
  const itemDefs = store.itemDefs();
  raisingView.refresh(buildRaisingViewModel(monsters, inventory, itemDefs));
}
store.onBatchApplied(() => refreshRaising());

// --- evolution/fusion view: refresh on batch when visible (M10c, ADR-0014/0019) --
// MUST be total (never throw): store.flushBatch has no per-listener isolation, so a
// throw here would starve the sibling reconcile/refreshBox/refreshBattle listeners.
function refreshEvolution(): void {
  if (!evolutionView?.visible || identity === '') return;
  const monsters = store.ownMonsters(identity);
  const speciesMap = store.speciesMap();
  evolutionView.refresh(buildEvolutionViewModel(monsters, speciesMap, [...store.fusions()]));
}
store.onBatchApplied(() => refreshEvolution());

// --- battle view: refresh on batch, auto-show/hide (M7c, ADR-0014/0042) --------
function refreshBattle(): void {
  if (!battleView || identity === '') return;
  const latest = store.latestPlayerBattle(identity);
  const r = decideBattleOverlay(latest, { dismissedBattleId, synced: battleSynced });
  dismissedBattleId = r.dismissedBattleId;
  battleSynced = r.synced;
  if (r.action.kind === 'show') {
    if (boxView?.visible) boxView.hide(); // active/outcome overlay supersedes the box
    if (raisingView?.visible) raisingView.hide(); // ...and the raising/inventory overlay
    if (evolutionView?.visible) evolutionView.hide(); // ...and the evolution overlay
    const vm = buildBattleViewModel(r.action.battle, store.skillMap(), store.speciesMap());
    if (!vm) console.warn('[battle] battle has corrupt team data; view hidden');
    battleView.refresh(vm);
  } else if (battleView.visible) {
    battleView.hide();
  }
}
store.onBatchApplied(() => refreshBattle());

// --- M12d: dialogue / quest log / heal views (ADR-0071) --------------------------
// All 3 MUST be total (never throw): store.flushBatch has no per-listener isolation.
store.onBatchApplied(() => {
  try {
    const npcsMap = new Map(store.allNpcs().map((n) => [n.entityId, n]));
    const conv = store.ownConversation(identity);
    const dialogueVm = buildDialogueViewModel(conv, npcsMap, DIALOGUE_TREES);
    dialogueView?.render(dialogueVm);
    if (!conv) dismissPending = false; // reset on server-side dismiss
  } catch (err) {
    console.error('[M12d] dialogue batch listener error', err);
  }
});

store.onBatchApplied(() => {
  // Quest log is user-toggled (KeyQ); only refresh when already open (ADR-0014 pattern).
  if (!questLogView?.visible) return;
  try {
    const quests = store.ownQuests(identity);
    questLogView.render(buildQuestLogViewModel(quests));
  } catch (err) {
    console.error('[M12d] questLog batch listener error', err);
  }
});

store.onBatchApplied(() => {
  // Heal overlay is user-toggled (KeyH); only refresh when already open (ADR-0014 pattern).
  if (!healView?.visible) return;
  try {
    const itemDefs = store.itemDefs();
    healView.render(buildHealViewModel(store.healLocations(), itemDefs));
  } catch (err) {
    console.error('[M12d] heal batch listener error', err);
  }
});

// --- M12d: dialogue choice click handler -----------------------------------------
// Reads data-choice-idx from the clicked button and calls advance_dialogue.
document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-choice-idx]') as HTMLElement | null;
  if (!btn) return;
  const raw = btn.dataset['choiceIdx'];
  if (raw === undefined) return;
  const choiceIdx = parseInt(raw, 10);
  if (!Number.isNaN(choiceIdx)) {
    conn?.conn.reducers.advanceDialogue({ choiceIdx });
  }
});

// --- DEV introspection hook (e2e asserts on this STATE, never pixels) ------------
function snapshot() {
  const own = store.ownCharacter(identity);
  const pred = predictor.predicted;
  return {
    ready,
    identity,
    stepMs: STEP_MS,
    queueCap: QUEUE_CAP,
    map: rawMap,
    presenceCount: store.playerCount,
    ownEntityId: store.ownEntityId(identity)?.toString() ?? null,
    ownPredictedTile: pred ? { x: pred.pos.x, y: pred.pos.y } : null,
    ownAuthTile: own ? { x: own.row.tileX, y: own.row.tileY } : null,
    sawFractionalOwnMotion,
    characters: [...store.characters()].map((c) => ({
      entityId: c.row.entityId.toString(),
      tileX: c.row.tileX,
      tileY: c.row.tileY,
      facing: c.row.facing,
      action: c.row.action,
    })),
    monsterCount: store.monsterCount,
    ownMonsters: store.ownMonsters(identity).map((m) => ({
      monsterId: m.monsterId.toString(),
      speciesId: m.speciesId,
      nickname: m.nickname,
      level: m.level,
      partySlot: m.partySlot,
    })),
    ownInventory: store.ownInventory(identity).map((i) => ({
      invId: i.invId.toString(),
      itemId: i.itemId,
      count: i.count,
    })),
    ongoingBattle: (() => {
      const b = store.ongoingBattle(identity);
      if (!b) return null;
      return { battleId: b.battleId.toString(), outcome: b.outcome, turnNumber: b.turnNumber };
    })(),
    step,
    jump,
    // 12.5c-5 proof-of-teeth hook: forcibly set rawMap to zone_map(zoneId) WITHOUT
    // the zone-switch protocol. Used by zoneSync.spec.ts to simulate "client kept
    // zone-1 rawMap after a disconnect, but server re-spawned character at zone 0".
    // The reconcile listener then sees own.row.zoneId(0) !== rawMap.zone_id(1) and
    // calls switchZone(0), proving the state-based fix. NOT exposed via onOwnWarp or
    // switchZone; test-only. Never used in production paths.
    setRawMapZoneForTest: (zoneId: number) => {
      try {
        rawMap = zone_map(zoneId);
      } catch (err) {
        throw new Error(`[test] zone_map(${zoneId}) not found in content`, { cause: err });
      }
    },
  };
}
(window as unknown as { __game: typeof snapshot }).__game = snapshot;

async function main(): Promise<void> {
  const [
    { BoxView: BoxViewClass },
    { BattleView: BattleViewClass },
    { RaisingView: RaisingViewClass },
    { EvolutionView: EvolutionViewClass },
    { DialogueView: DialogueViewClass },
    { QuestLogView: QuestLogViewClass },
    { HealView: HealViewClass },
  ] = await Promise.all([
    import('./ui/boxView'),
    import('./ui/battleView'),
    import('./ui/raisingView'),
    import('./ui/evolutionView'),
    import('./ui/dialogueView'),
    import('./ui/questLogView'),
    import('./ui/healView'),
  ]);
  renderer = new WorldRenderer();
  const mount = document.getElementById('app');
  if (mount !== null) {
    await renderer.init(mount, rawMap);
    installResizeHandler(renderer, window); // fit the stage to the window + on resize
    boxView = new BoxViewClass(mount, {
      onSetNickname: (monsterId, nickname) => {
        conn?.conn.reducers.setNickname({ monsterId, nickname });
      },
      onSetPartySlot: (monsterId, slot) => {
        const finalSlot =
          slot === -1
            ? (nextFreePartySlot(store.ownMonsters(identity), PARTY_SIZE) ?? PARTY_SLOT_NONE)
            : slot;
        conn?.conn.reducers.setPartySlot({ monsterId, slot: finalSlot });
      },
      onHealParty: () => {
        // Use the first available heal location from live store data (M12d).
        // Server validates zone/range/cooldown; falls back to 0 (no-op) when no locations loaded.
        const locationId = store.healLocations()[0]?.locationId ?? 0;
        conn?.conn.reducers.healParty({ locationId });
      },
    });
    battleView = new BattleViewClass(mount, {
      onAttack: (battleId, skillId) => {
        conn?.conn.reducers.submitAttack({ battleId, skillId });
      },
      onFlee: (battleId) => {
        conn?.conn.reducers.flee({ battleId });
      },
      onSwap: (battleId, teamIndex) => {
        conn?.conn.reducers.swapActive({ battleId, teamIndex });
      },
      onRecruit: (battleId, baitItemId) => {
        conn?.conn.reducers.attemptRecruit({ battleId, baitItemId });
      },
    });
    raisingView = new RaisingViewClass(mount, {
      onTrain: (monsterId, foodItemId) => {
        conn?.conn.reducers.train({ monsterId, foodItemId });
      },
      onCare: (monsterId) => {
        conn?.conn.reducers.care({ monsterId });
      },
    });
    evolutionView = new EvolutionViewClass(mount, {
      onEvolve: (monsterId) => {
        conn?.conn.reducers.evolve({ monsterId });
      },
      onFuse: (aId, bId) => {
        conn?.conn.reducers.fuse({ aId, bId });
      },
    });
    // M12d: dialogue / quest log / heal DOM shells (ADR-0071).
    dialogueView = new DialogueViewClass();
    questLogView = new QuestLogViewClass();
    healView = new HealViewClass();
  }

  conn = connect({
    uri: URI,
    db: DB,
    zoneId: ZONE_ID,
    name: 'Player',
    store,
    onReady: (id) => {
      identity = id;
      resolveReady();
    },
    onReconnect: () => {
      // Clean re-init: the store already dropped stale rows; rebuild prediction and
      // drop the own slide clock so the post-reconnect re-seed starts fresh.
      // Zone state is corrected by the reconcile listener's state-based check on
      // the first post-reconnect batch (12.5c-1 — no special zone logic needed here).
      resetPredictionState();
    },
    // 12.5c-1: onOwnWarp delegates to switchZone (idempotent — no-op if rawMap
    // already matches). Fires on live-warp character onUpdate (lower latency path);
    // the reconcile listener's state-based check handles reconnect-strand (character
    // INSERTED at zone 0 with no onUpdate). Both paths are safe to call: switchZone
    // checks rawMap.zone_id before doing any work.
    onOwnWarp: (newZoneId) => {
      switchZone(newZoneId);
    },
    onError: (where, message) => console.error(`[net:${where}] ${message}`),
  });

  // 12.5c-4: frame loop is wrapped in try/catch so a wasm/predictor throw does not
  // kill the loop permanently. rAF re-arm is in `finally` so it always fires, even
  // on error. The reconcile call is inside the batch-listener's try-catch (above).
  const frame = (): void => {
    try {
      const now = performance.now();
      // Re-issue the held dir so a held key keeps walking — but only when no overlay
      // is visible, so a held key resumes after an overlay closes yet never walks
      // under one (M8.6c, ADR-0013). sendIntent routes through the backpressured
      // predictor.enqueue + reducer send, and no-ops if declined.
      if (
        !(
          battleView?.visible ||
          boxView?.visible ||
          raisingView?.visible ||
          evolutionView?.visible ||
          dialogueView?.visible ||
          questLogView?.visible ||
          healView?.visible
        )
      ) {
        const heldDir = reissueDir(held.active(), predictor.lastQueuedDir);
        if (heldDir !== undefined) sendIntent({ Step: heldDir });
      }
      const { snapped } = predictor.drain(now);
      const ownEntityId = store.ownEntityId(identity);
      const predicted = predictor.predicted;
      const entities = resolver.resolve({
        characters: store.characters(),
        ownEntityId,
        predicted,
        snapped,
        now,
        currentZoneId: rawMap.zone_id,
      });
      // Sticky latch: count ONLY fractional motion from the slide-clock path — the own
      // entity WITH a predicted state (same predicate as RenderResolver's `isOwn`), never
      // the interpolation fallback. This keeps the e2e proving the slide clock specifically,
      // not remote-interp leaking onto the own entity during the login/reconnect gap. The
      // sole non-integer source on this path is the slide clock (predicted tiles are integers).
      // Find own entity for fractional-motion latch and follow-camera.
      const ownEntity =
        ownEntityId !== undefined ? entities.find((e) => e.entityId === ownEntityId) : undefined;
      if (ownEntityId !== undefined && predicted !== undefined) {
        if (
          ownEntity !== undefined &&
          (!Number.isInteger(ownEntity.x) || !Number.isInteger(ownEntity.y))
        ) {
          sawFractionalOwnMotion = true;
        }
      }
      // M12.5d-4: hold last camera position when own entity is unresolved (e.g. warp
      // gap) so the camera doesn't snap to origin. lastCamX/Y reset on zone switch.
      if (ownEntity !== undefined) {
        lastCamX = ownEntity.x;
        lastCamY = ownEntity.y;
      }
      renderer?.render(entities, lastCamX, lastCamY);
    } catch (err) {
      console.error('[frame] uncaught error', err);
    } finally {
      requestAnimationFrame(frame); // always re-arm (12.5c-4)
    }
  };
  requestAnimationFrame(frame);
}

void main();
