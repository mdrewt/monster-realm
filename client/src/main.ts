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
import { type ApplyMove, Predictor } from './prediction/predictor';
import { installResizeHandler } from './render/resizeWiring';
import { type RenderEntity, WorldRenderer } from './render/world';
import { buildBattleViewModel } from './ui/battleModel';
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

let identity = '';
let conn: ReturnType<typeof connect> | undefined;
let boxView: BoxView | undefined;
let battleView: BattleView | undefined;

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
    step(dir);
    e.preventDefault();
    return;
  }
  if (e.code === 'Space') {
    jump();
    e.preventDefault();
  }
});

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
  const battle = store.ongoingBattle(identity);
  if (battle) {
    // Auto-hide box when battle is active to prevent overlapping overlays.
    if (boxView?.visible) boxView.hide();
    const vm = buildBattleViewModel(battle, store.skillMap(), store.speciesMap());
    if (!vm) console.warn('[battle] ongoing battle has corrupt team data; view hidden');
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
