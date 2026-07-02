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
import { RenderResolver } from './render/renderResolver';
import { installResizeHandler } from './render/resizeWiring';
import { WorldRenderer } from './render/world';
import { buildBattleViewModel, decideBattleOverlay } from './ui/battleModel';
import type { BattleView } from './ui/battleView';
import { buildBoxViewModel, buildPartyViewModel, nextFreePartySlot } from './ui/boxModel';
import type { BoxView } from './ui/boxView';
import { buildEvolutionViewModel } from './ui/evolutionModel';
import type { EvolutionView } from './ui/evolutionView';
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
// Outcome-frame lifecycle (M8.7e): the dismissed battle id (so a resolved outcome
// renders once but never re-pops) + whether any battle has been observed this
// session (first-sight pre-dismiss of a historical/stale-on-login resolved battle).
let dismissedBattleId: bigint | null = null;
let battleSynced = false;

let resolveReady: () => void = () => {};
const ready = new Promise<void>((r) => {
  resolveReady = r;
});

// --- reconcile own character on every coherent (batched) authoritative snapshot --
store.onBatchApplied(() => {
  if (identity === '') return;
  const own = store.ownCharacter(identity);
  const player = store.player(identity);
  if (own === undefined || player === undefined) return;
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
  // Fail-loud u64→number bound (M8.8e §B) replacing the unbounded downcast. Contain
  // the throw HERE: this is the first store batch-listener and store.flushBatch has no
  // per-listener isolation, so an uncaught RangeError would starve the sibling
  // refreshBox/refreshBattle listeners (a UI stall). A last_input_seq past the
  // safe-integer bound is a corrupt/hostile server field (unreachable for a well-behaved
  // u64 for ~50k years) — log loudly and skip THIS batch's reconcile, never wedge the UI.
  let ackedSeq: number;
  try {
    ackedSeq = boundSeq(player.lastInputSeq);
  } catch (err) {
    console.error(`[reconcile] ${(err as Error).message}; skipping batch`);
    return;
  }
  // Reconnect re-seed (M8.8e §A): keep #nextSeq ≥ the server ack at all times — a
  // no-op in steady state, the fix on reconnect / fresh-login-with-prior-session so
  // post-reconnect intents clear the ack and survive reconcile's seq filter.
  predictor.seedSeq(ackedSeq);
  const diverged = predictor.reconcile(baseline, own.row.moveQueue, ackedSeq, now);
  // Honor reconcile's documented divergence return (ADR-0013), previously discarded: on
  // a genuine server pullback, re-commit the held direction at the divergence point so a
  // held key keeps walking from the corrected baseline. Routed through the SAME held-
  // state-guarded dedup as the rAF frame loop (reissueDir) — so it never double-issues
  // nor re-issues a key released during the divergence; the move drains on the next rAF.
  if (
    diverged &&
    !(battleView?.visible || boxView?.visible || raisingView?.visible || evolutionView?.visible)
  ) {
    const heldDir = reissueDir(held.active(), predictor.lastQueuedDir);
    if (heldDir !== undefined) sendIntent({ Step: heldDir });
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
  // Escape priority: battle > box > raising > evolution > movement (ADR-0014 exit ordering).
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
  // Suppress movement input while an overlay is open.
  if (battleView?.visible || boxView?.visible || raisingView?.visible || evolutionView?.visible)
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
    presenceCount: store.characterCount,
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
  };
}
(window as unknown as { __game: typeof snapshot }).__game = snapshot;

async function main(): Promise<void> {
  const [
    { BoxView: BoxViewClass },
    { BattleView: BattleViewClass },
    { RaisingView: RaisingViewClass },
    { EvolutionView: EvolutionViewClass },
  ] = await Promise.all([
    import('./ui/boxView'),
    import('./ui/battleView'),
    import('./ui/raisingView'),
    import('./ui/evolutionView'),
  ]);
  const renderer = new WorldRenderer();
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
        conn?.conn.reducers.healParty({});
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
  }

  // M11c: extracted from onReconnect so onOwnWarp can reuse the same body (ADR-0067).
  // Resets the client prediction state without touching the store (the store is reset
  // separately by connection.ts on disconnect, or resetCharacters() on zone warp).
  function resetPredictionState(): void {
    predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    resolver.reset();
    held.clear();
    sawFractionalOwnMotion = false;
    dismissedBattleId = null;
    battleSynced = false;
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
      resetPredictionState();
    },
    onOwnWarp: (newZoneId) => {
      // Zone transition: clear stale-zone character positions, reload the map for the
      // new zone, update the wasm movement predictor's zone, and reset prediction state.
      // The store keeps all non-character tables (players, monsters, species, etc.).
      // try/catch: zone_map() throws on unknown zone ids; onBatchApplied has no per-
      // listener isolation so an uncaught throw would starve sibling listeners (M8.8e).
      try {
        store.resetCharacters();
        rawMap = zone_map(newZoneId);
        set_active_zone(newZoneId);
        renderer.setMap(rawMap);
        resetPredictionState();
      } catch (err) {
        console.error(`[warp] zone transition to ${newZoneId} failed — keeping current zone`, err);
      }
    },
    onError: (where, message) => console.error(`[net:${where}] ${message}`),
  });

  const frame = (): void => {
    const now = performance.now();
    // Re-issue the held dir so a held key keeps walking — but only when no overlay
    // is visible, so a held key resumes after an overlay closes yet never walks
    // under one (M8.6c, ADR-0013). sendIntent routes through the backpressured
    // predictor.enqueue + reducer send, and no-ops if declined.
    if (
      !(battleView?.visible || boxView?.visible || raisingView?.visible || evolutionView?.visible)
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
    // M11c: pass own tile position for follow-camera (WorldRenderer.render).
    const ownX = ownEntity?.x ?? 0;
    const ownY = ownEntity?.y ?? 0;
    renderer.render(entities, ownX, ownY);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
