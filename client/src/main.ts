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
import { type ApplyMove, Predictor } from './prediction/predictor';
import { RenderResolver } from './render/renderResolver';
import { installResizeHandler } from './render/resizeWiring';
import { WorldRenderer } from './render/world';
import { buildBattleViewModel, decideBattleOverlay } from './ui/battleModel';
import type { BattleView } from './ui/battleView';
import { buildBoxViewModel, buildPartyViewModel, nextFreePartySlot } from './ui/boxModel';
import type { BoxView } from './ui/boxView';

const URI = (import.meta.env.VITE_STDB_URI as string | undefined) ?? 'ws://127.0.0.1:3000';
const DB = (import.meta.env.VITE_STDB_DB as string | undefined) ?? 'monster-realm';
const ZONE_ID = 0;

// Content is single-sourced from game-core via the wasm exports (never duplicated).
const STEP_MS = step_ms();
const QUEUE_CAP = move_queue_cap();
const PARTY_SIZE = party_size();
const PARTY_SLOT_NONE = party_slot_none();
const rawMap = zone_map(ZONE_ID);

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
  predictor.reconcile(baseline, own.row.moveQueue, Number(player.lastInputSeq), now);
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
      boxView?.toggle();
      if (boxView?.visible) refreshBox();
    }
    e.preventDefault();
    return;
  }
  // Escape priority: battle > box > movement (ADR-0014 exit ordering).
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
  // Suppress movement input while an overlay is open.
  if (battleView?.visible || boxView?.visible) return;
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

// --- battle view: refresh on batch, auto-show/hide (M7c, ADR-0014/0042) --------
function refreshBattle(): void {
  if (!battleView || identity === '') return;
  const latest = store.latestPlayerBattle(identity);
  const r = decideBattleOverlay(latest, { dismissedBattleId, synced: battleSynced });
  dismissedBattleId = r.dismissedBattleId;
  battleSynced = r.synced;
  if (r.action.kind === 'show') {
    if (boxView?.visible) boxView.hide(); // active/outcome overlay supersedes the box
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
  const [{ BoxView: BoxViewClass }, { BattleView: BattleViewClass }] = await Promise.all([
    import('./ui/boxView'),
    import('./ui/battleView'),
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
      predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
      resolver.reset();
      held.clear();
      sawFractionalOwnMotion = false;
      // Reset the outcome-frame lifecycle so a re-subscribed historical resolved
      // battle is pre-dismissed again at first sight (M8.7e).
      dismissedBattleId = null;
      battleSynced = false;
    },
    onError: (where, message) => console.error(`[net:${where}] ${message}`),
  });

  const frame = (): void => {
    const now = performance.now();
    // Re-issue the held dir so a held key keeps walking — but only when no overlay
    // is visible, so a held key resumes after an overlay closes yet never walks
    // under one (M8.6c, ADR-0013). sendIntent routes through the backpressured
    // predictor.enqueue + reducer send, and no-ops if declined.
    if (!(battleView?.visible || boxView?.visible)) {
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
    if (ownEntityId !== undefined && predicted !== undefined) {
      const own = entities.find((e) => e.entityId === ownEntityId);
      if (own !== undefined && (!Number.isInteger(own.x) || !Number.isInteger(own.y))) {
        sawFractionalOwnMotion = true;
      }
    }
    renderer.render(entities);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
