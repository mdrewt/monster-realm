// monster-realm client — the integrated loop (M5a, folds in the M4c app wiring).
//
// Binds the tested pure cores into the live one-way flow (ADR-0012/0013/0014):
//   server --(SDK rows)--> connection adapter --> AuthoritativeStore  (truth in)
//   input  --> Predictor (predict via the SAME wasm rule) + send intent reducers
//   batch-applied --> Predictor.reconcile (4-step against a coherent snapshot)
//   rAF    --> Predictor.drain --> WorldRenderer.render (own=predicted, remote=auth)
//
// The renderer paints integer tiles here; the M4b smoothness layer (slide clock +
// remote interpolation buffer) lands with M5b's smoothness assertions. A DEV
// `window.__game()` snapshot lets the M5 two-window e2e assert on STATE (predicted
// vs authoritative tiles, presence, the zone map), never pixels.
import { connect } from './net/connection';
import { AuthoritativeStore } from './net/store';
import { Predictor, type ApplyMove } from './prediction/predictor';
import {
  characterToPredictedBaseline,
  moveInputToSdk,
  type SdkCharacterFields,
  type WasmDirection,
  type WasmMoveInput,
} from './convert/convert';
import { WorldRenderer, type RenderEntity } from './render/world';
// client-wasm (built `wasm-pack build client-wasm --target bundler`; resolved by
// vite-plugin-wasm + top-level-await — see vite.config.ts / server.fs.allow).
import { apply_move, zone_map, step_ms, move_queue_cap } from '../../client-wasm/pkg/client_wasm.js';

const URI = (import.meta.env.VITE_STDB_URI as string | undefined) ?? 'ws://127.0.0.1:3000';
const DB = (import.meta.env.VITE_STDB_DB as string | undefined) ?? 'monster-realm';
const ZONE_ID = 0;

// Content is single-sourced from game-core via the wasm exports (never duplicated).
const STEP_MS = step_ms();
const QUEUE_CAP = move_queue_cap();
const rawMap = zone_map(ZONE_ID);

const store = new AuthoritativeStore();
// The injected rule IS the client-wasm export (same compiled code as the server).
const applyMove = apply_move as unknown as ApplyMove;
let predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);

let identity = '';
let conn: ReturnType<typeof connect> | undefined;

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
  conn.conn.reducers.enqueueMove({ input: moveInputToSdk(input), seq: BigInt(intent.seq) });
}
const step = (dir: WasmDirection): void => sendIntent({ Step: dir });
const jump = (): void => sendIntent('Jump');

const KEY_DIR: Readonly<Record<string, WasmDirection>> = {
  ArrowUp: 'North', KeyW: 'North',
  ArrowDown: 'South', KeyS: 'South',
  ArrowLeft: 'West', KeyA: 'West',
  ArrowRight: 'East', KeyD: 'East',
};
window.addEventListener('keydown', (e) => {
  const dir = KEY_DIR[e.code];
  if (dir !== undefined) { step(dir); e.preventDefault(); return; }
  if (e.code === 'Space') { jump(); e.preventDefault(); }
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
    presenceCount: store.characterCount,
    ownEntityId: store.ownEntityId(identity)?.toString() ?? null,
    ownPredictedTile: pred ? { x: pred.pos.x, y: pred.pos.y } : null,
    ownAuthTile: own ? { x: own.row.tileX, y: own.row.tileY } : null,
    characters: [...store.characters()].map((c) => ({
      entityId: c.row.entityId.toString(),
      tileX: c.row.tileX,
      tileY: c.row.tileY,
      facing: c.row.facing,
      action: c.row.action,
    })),
    step,
    jump,
  };
}
(window as unknown as { __game: typeof snapshot }).__game = snapshot;

// --- render loop: own at predicted tile, remote at authoritative tile ------------
function renderEntities(): RenderEntity[] {
  const ownEid = store.ownEntityId(identity);
  const pred = predictor.predicted;
  const out: RenderEntity[] = [];
  for (const c of store.characters()) {
    const isOwn = ownEid !== undefined && c.row.entityId === ownEid;
    out.push({
      entityId: c.row.entityId,
      x: isOwn && pred ? pred.pos.x : c.row.tileX,
      y: isOwn && pred ? pred.pos.y : c.row.tileY,
      action: isOwn && pred ? pred.action : c.row.action,
      facing: isOwn && pred ? pred.facing : c.row.facing,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const renderer = new WorldRenderer();
  const mount = document.getElementById('app');
  if (mount !== null) await renderer.init(mount, rawMap);

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
      // Clean re-init: the store already dropped stale rows; rebuild prediction.
      predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    },
    onError: (where, message) => console.error(`[net:${where}] ${message}`),
  });

  const frame = (): void => {
    predictor.drain(performance.now());
    renderer.render(renderEntities());
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
