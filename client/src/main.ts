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
import { shouldReportZoneSyncFailure } from './net/zoneSyncGuard';
import { HeldDirections, reissueDir } from './prediction/heldKeys';
import { type ApplyMove, boundSeq, Predictor } from './prediction/predictor';
import { TileMap } from './render/map';
import { RenderResolver } from './render/renderResolver';
import { installResizeHandler } from './render/resizeWiring';
import { WorldRenderer } from './render/world';
import {
  type BaitItem,
  type BattleViewModel,
  buildBattleViewModel,
  type CureItem,
  decideBattleOverlay,
  shouldSkipBattleRefresh,
} from './ui/battleModel';
import type { BattleView } from './ui/battleView';
import { buildBoxViewModel, buildPartyViewModel, nextFreePartySlot } from './ui/boxModel';
import type { BoxView } from './ui/boxView';
import { DIALOGUE_TREES } from './ui/dialogueContent';
import { buildDialogueViewModel, nearestTalkableNpcId } from './ui/dialogueModel';
import type { DialogueView } from './ui/dialogueView';
import { buildEvolutionViewModel } from './ui/evolutionModel';
import type { EvolutionView } from './ui/evolutionView';
import { buildHealViewModel, healTargetLocationId } from './ui/healModel';
import type { HealView } from './ui/healView';
import { buildQuestLogViewModel } from './ui/questLogModel';
import type { QuestLogView } from './ui/questLogView';
import { buildRaisingViewModel } from './ui/raisingModel';
import type { RaisingView } from './ui/raisingView';
import { buildShopViewModel } from './ui/shopModel';
import type { ShopView } from './ui/shopView';
import { reduceErrorMessage } from './ui/statusModel';
import { buildTradeViewModel } from './ui/tradeModel';
import type { TradeView } from './ui/tradeView';

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

// ADR-0090: stepMs injected so the store can do burst detection + jitter EWMA.
const store = new AuthoritativeStore(STEP_MS);
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
let lastCamX = 0;
let lastCamY = 0;

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
let shopView: ShopView | undefined;
let tradeView: TradeView | undefined;
// dismissPending: prevents double-sending dismiss_dialogue while server processes it (M12d).
// eslint-disable-next-line prefer-const
let dismissPending = false;
// Outcome-frame lifecycle (M8.7e): the dismissed battle id (so a resolved outcome
// renders once but never re-pops) + whether any battle has been observed this
// session (first-sight pre-dismiss of a historical/stale-on-login resolved battle).
let dismissedBattleId: bigint | null = null;
let battleSynced = false;
// m14.5d VM-compare guard: last rendered BattleViewModel — used by shouldSkipBattleRefresh
// to suppress equal-VM re-renders (churn prevention). Reset to null on hide + reset.
let lastBattleVM: BattleViewModel | null = null;

// --- M13.5b status surface (ADR-0085 D1) ------------------------------------------
// A minimal dynamically-created status line (no toast system — recorded ADR-0085
// consequence). `statusEl` is created in main() BEFORE `conn = connect(...)` is
// assigned (C8: no lifecycle callback can ever report into the void) but held at
// module scope because send sites OUTSIDE main() (the Escape-dismiss keydown handler
// and the dialogue-choice click handler) report through it too.
let statusEl: HTMLElement | undefined;

/** Surface a user-visible failure: textContent ONLY — server-supplied SenderError
 *  text must never become markup (never innerHTML) — plus console.error for logs. */
function reportError(text: string): void {
  if (statusEl !== undefined) statusEl.textContent = text;
  console.error('[status]', text);
}

/** Clear the status line (on reconnect: the frozen-link message is stale, A8). */
function clearStatus(): void {
  if (statusEl !== undefined) statusEl.textContent = '';
}

/**
 * Non-movement reducer send guard (ADR-0085 D1 + A1). While the link is frozen it
 * SHORT-CIRCUITS with "disconnected — try again" and NEVER calls the reducer: a call
 * against a dead conn is silently queued on the dead instance and its promise never
 * settles (no-settle-on-drop) — the dead-button black hole. Otherwise it attaches
 * the rejection route: reduceErrorMessage passes SenderError reasons through and
 * never leaks InternalError detail. Documented exceptions (A10): enqueueMove
 * (movement — silent prediction repair in sendIntent, M2 §3), joinGame (handled in
 * connection.ts, A4), buy/sell (shop feedback line — gated inline in main(), A6).
 */
function sendGuarded(where: string, call: () => Promise<void> | undefined): void {
  if (conn === undefined || conn.linkFrozen()) {
    reportError(`${where}: disconnected — try again`);
    return;
  }
  call()?.catch((err: unknown) => reportError(reduceErrorMessage(err, where)));
}

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
  lastBattleVM = null;
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

// e-2 (M13.5e): track consecutive zone-switch failures so stale content is surfaced.
let zoneSyncFailureCount = 0;

function switchZone(newZoneId: number): void {
  if (newZoneId === rawMap.zone_id) return;
  try {
    const newRawMap = zone_map(newZoneId);
    TileMap.fromRaw(newRawMap); // validate BEFORE any mutation (12.5c-3) — throws on bad data
    renderer?.setMap(newRawMap); // draw BEFORE committing zone state (RT-SZ-01: atomicity)
    set_active_zone(newZoneId);
    rawMap = newRawMap;
    resetPredictionState();
    zoneSyncFailureCount = 0; // success: reset streak
  } catch (err) {
    console.error('[zone-sync] zone switch to %s failed — keeping current zone', newZoneId, err);
    zoneSyncFailureCount++;
    if (shouldReportZoneSyncFailure(zoneSyncFailureCount)) {
      reportError('content out of date — reload');
    }
  }
}

// --- reconcile own character on every coherent (batched) authoritative snapshot --
// M13.5b (ADR-0085): extracted to a module-scope TOTAL function so BOTH callers share
// one body — the batch listener below AND the movement-rejection .catch in sendIntent.
// The rejection path MUST actively re-reconcile: when the rejected send is a burst
// tail, NO further authoritative batch arrives (server state unchanged), so waiting
// for the next batch would leave the phantom op replaying forever.
function reconcileFromStore(): void {
  // Internal try/catch is the single totality source (12.5c-4 no-throw contract):
  // neither caller can be blown up by a wasm/predictor throw in here.
  try {
    if (identity === '') return;
    const own = store.ownCharacter(identity);
    const player = store.player(identity);
    // Early-exit when own/player are absent (store reset mid-gap): SAFE, but
    // transient after a mid-gap dropRejected — #pending already dropped, #queue
    // still reflects the phantom — self-heals on the next batch reconcile
    // (ADR-0085 C1).
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
      // e-2 (M13.5e): if the switch failed, rawMap is still the old zone. Reconciling
      // against the wrong map would seed the predictor with positions from a different
      // zone and produce ghost movement. Return early — the error is already surfaced
      // by switchZone via shouldReportZoneSyncFailure / reportError.
      if (own.row.zoneId !== rawMap.zone_id) return;
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
        healView?.visible ||
        shopView?.visible ||
        tradeView?.visible
      )
    ) {
      const heldDir = reissueDir(held.active(), predictor.lastQueuedDir);
      if (heldDir !== undefined) sendIntent({ Step: heldDir });
    }
  } catch (err) {
    console.error('[reconcile] uncaught error', err);
  }
}
store.onBatchApplied(() => {
  // Belt: reconcileFromStore is total by construction (internal catch above); keep
  // the listener-level catch anyway (12.5c-4) so a future edit inside the body can
  // never starve sibling batch listeners.
  try {
    reconcileFromStore();
  } catch (err) {
    console.error('[reconcile] uncaught error in batch listener', err);
  }
});

// --- input: predict locally + send the intent to the M2 reducer (seq-tracked) ----
function sendIntent(input: WasmMoveInput): void {
  // Single choke point for the movement freeze (ADR-0085 D3): the keydown first
  // step, the frame-loop held re-issue, AND the reconcile-listener divergence
  // re-issue all route through here, so this one gate covers every movement path.
  // No prediction against a dead link either — enqueue is skipped, not just the send.
  if (conn === undefined || conn.linkFrozen()) return;
  const intent = predictor.enqueue(input);
  if (intent === undefined) return; // ADR-0052: declined (queue at cap) — predict & send nothing
  const seq = intent.seq;
  conn.conn.reducers.enqueueMove({ input: moveInputToSdk(input), seq: BigInt(seq) }).catch(() => {
    // Movement rejections stay SILENT to the user (M2 §3) — prediction repair only.
    // ADR-0085 A2 (invariant corrected in review, RT-03): this closure captures ONLY
    // `seq` (a const) and reads the module-scope `predictor` at fire time — never
    // capture the predictor instance at send time. Cross-session safety comes from
    // ORDERING, not seq disjointness: rejections settle only on message receipt from
    // the live socket (no settle after a drop), so a stale `.catch` always drains as
    // a microtask against the OLD predictor — the fresh predictor is created ≥1s
    // later by the reconnect timer. (seedSeq alone would NOT protect the boundary:
    // seedSeq(N-1) hands the fresh predictor seq N, colliding with a stale reject
    // of N — reachable only if the drop/reconnect ordering above were violated.)
    // ADR-0085 A3: burst rejections (N rejects → N drop+reconcile microtasks in one
    // turn) are harmless — the microtask checkpoint drains before the next rAF, the
    // renderer reads predictor state only in rAF, and each reconcile is a total
    // re-derivation from store truth (idempotent, converging). No coalescing needed.
    if (predictor.dropRejected(seq)) reconcileFromStore();
  });
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
    if (
      shouldToggleBox(battleView?.visible ?? false) &&
      !shopView?.visible &&
      !tradeView?.visible
    ) {
      raisingView?.hide(); // mutual exclusivity: box and raising never co-open
      evolutionView?.hide(); // mutual exclusivity: close evolution overlay
      tradeView?.hide(); // mutual exclusivity: close trade overlay
      boxView?.toggle();
      if (boxView?.visible) refreshBox();
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyI') {
    // Inventory/raising overlay — same battle guard as the box (reuse shouldToggleBox).
    if (
      shouldToggleBox(battleView?.visible ?? false) &&
      !shopView?.visible &&
      !tradeView?.visible
    ) {
      boxView?.hide(); // mutual exclusivity: box and raising never co-open
      evolutionView?.hide(); // mutual exclusivity: close evolution overlay
      tradeView?.hide(); // mutual exclusivity: close trade overlay
      raisingView?.toggle();
      if (raisingView?.visible) refreshRaising();
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyE') {
    // Evolution/fusion overlay — same battle guard as box/raising (ADR-0014).
    if (
      shouldToggleBox(battleView?.visible ?? false) &&
      !shopView?.visible &&
      !tradeView?.visible
    ) {
      boxView?.hide(); // mutual exclusivity
      raisingView?.hide(); // mutual exclusivity
      tradeView?.hide(); // mutual exclusivity: close trade overlay
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
      !healView?.visible &&
      !shopView?.visible
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
      !questLogView?.visible &&
      !shopView?.visible
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
  if (e.code === 'KeyG') {
    // Shop overlay — mutual exclusivity with all other overlays (M13d, ADR-0084).
    // Opens with the first available shop; if no shops loaded shows "No shop available".
    if (
      !battleView?.visible &&
      !boxView?.visible &&
      !raisingView?.visible &&
      !evolutionView?.visible &&
      !dialogueView?.visible &&
      !questLogView?.visible &&
      !healView?.visible
    ) {
      if (shopView?.visible) {
        shopView.hide();
      } else {
        shopView?.render(
          buildShopViewModel(
            store.allShops(),
            store.allShopItems(),
            store.itemDefs(),
            store.ownInventory(identity),
          ),
        );
        shopView?.show();
      }
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyU') {
    // Trade overlay — mutual exclusivity with all other overlays (m15b, ADR-0107).
    // Shows the active offer involving this player; "No active trade" when none.
    if (
      !battleView?.visible &&
      !boxView?.visible &&
      !raisingView?.visible &&
      !evolutionView?.visible &&
      !dialogueView?.visible &&
      !questLogView?.visible &&
      !healView?.visible &&
      !shopView?.visible
    ) {
      if (tradeView?.visible) {
        tradeView.hide();
      } else {
        tradeView?.render(
          buildTradeViewModel(
            store.allTradeOffers(),
            identity,
            store.speciesMap(),
            store.itemDefs(),
          ),
        );
        tradeView?.show();
      }
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyT') {
    // TALK (M13.5c — implementer contract in client/e2e/dialogue.spec.ts header):
    // only when NO overlay is visible, target the nearest NPC (store.allNpcs()
    // joined to character rows, same zone) within CLIENT_TALK_RANGE of the own
    // AUTHORITATIVE tile and send the talk reducer; no-op when none is in range.
    // The client-side range check is latency hygiene, NOT security — the server
    // re-validates zone + range (npc.rs talk Steps 4-5, TALK_RANGE at npc.rs:20).
    if (
      !battleView?.visible &&
      !boxView?.visible &&
      !raisingView?.visible &&
      !evolutionView?.visible &&
      !dialogueView?.visible &&
      !questLogView?.visible &&
      !healView?.visible &&
      !shopView?.visible &&
      identity !== ''
    ) {
      const own = store.ownCharacter(identity);
      if (own !== undefined) {
        // store.characters() is the WHOLE character table (players + NPCs);
        // entityId is globally unique (one auto_inc sequence), so joining the
        // NPC registry against this map always lands on the NPC's own row.
        const characterTiles = new Map(
          [...store.characters()].map((c) => [
            c.row.entityId,
            { zoneId: c.row.zoneId, tileX: c.row.tileX, tileY: c.row.tileY },
          ]),
        );
        const npcEntityId = nearestTalkableNpcId(own.row, store.allNpcs(), characterTiles);
        if (npcEntityId !== undefined) {
          sendGuarded('talk', () => conn?.conn.reducers.talk({ npcEntityId }));
        }
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
    lastBattleVM = null;
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
      // The flag is set INSIDE the lambda (reviewer M1): sendGuarded's frozen
      // short-circuit then never sets it, so a frozen-link Escape stays a live
      // button (status line says "disconnected") instead of leaning on the
      // next-batch self-heal.
      // Site-specific catch (ADR-0085 C6): a rejection must RESET dismissPending or
      // Escape-dismiss is a dead button forever after one rejection (the flag is
      // otherwise only cleared when the conversation row disappears in a batch).
      // The rethrow keeps sendGuarded's catch as the single status reporter.
      sendGuarded('dismiss', () => {
        dismissPending = true;
        return conn?.conn.reducers.dismissDialogue({}).catch((err: unknown) => {
          dismissPending = false;
          throw err;
        });
      });
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
  if (e.code === 'Escape' && shopView?.visible) {
    shopView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && tradeView?.visible) {
    tradeView.hide();
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
    healView?.visible ||
    shopView?.visible ||
    tradeView?.visible
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
// MUST be total (never throw): defense-in-depth — store.flushBatch has per-listener
// try/catch since M10.5d, but a throwing function here signals a logic bug.
function refreshRaising(): void {
  if (!raisingView?.visible || identity === '') return;
  const monsters = store.ownMonsters(identity);
  const inventory = store.ownInventory(identity);
  const itemDefs = store.itemDefs();
  raisingView.refresh(buildRaisingViewModel(monsters, inventory, itemDefs));
}
store.onBatchApplied(() => refreshRaising());

// --- evolution/fusion view: refresh on batch when visible (M10c, ADR-0014/0019) --
// MUST be total (never throw): defense-in-depth — store.flushBatch has per-listener
// try/catch since M10.5d, but a throwing function here signals a logic bug.
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
    // Build baitItems from own inventory × item defs (12.5f-5: wire the 4th arg
    // that was already present in buildBattleViewModel with default []). The
    // function classifies by recruitBonus > 0 internally (ADR-0047 classify-by-data).
    const baitItems: BaitItem[] = store.ownInventory(identity).flatMap((inv) => {
      const def = store.itemDef(inv.itemId);
      if (!def) return [];
      return [
        { itemId: inv.itemId, name: def.name, recruitBonus: def.recruitBonus, count: inv.count },
      ];
    });
    // Build cureItems from own inventory × item defs: classify by cureStatus !== null
    // (ADR-0047 + ADR-0105). Available in any ongoing battle (not wild-only).
    const cureItems: CureItem[] = store.ownInventory(identity).flatMap((inv) => {
      const def = store.itemDef(inv.itemId);
      if (!def || def.cureStatus === null) return [];
      return [{ itemId: inv.itemId, name: def.name, cureStatus: def.cureStatus, count: inv.count }];
    });
    const vm = buildBattleViewModel(
      r.action.battle,
      store.skillMap(),
      store.speciesMap(),
      baitItems,
      cureItems,
    );
    if (!vm) console.warn('[battle] battle has corrupt team data; view hidden');
    // m14.5d VM-compare guard: skip refresh when the view is visible and the VM is
    // structurally identical to the last rendered VM (suppresses churn on no-op ticks).
    // The visible guard is the primary defense: shouldSkipBattleRefresh returns false
    // while hidden, so the post-Escape re-show always triggers a full render. The
    // lastBattleVM = null reset in the Escape handler is invariant hygiene on top.
    if (shouldSkipBattleRefresh(battleView.visible, lastBattleVM, vm)) return;
    battleView.refresh(vm);
    lastBattleVM = vm;
  } else if (battleView.visible) {
    battleView.hide();
    lastBattleVM = null;
  }
}
store.onBatchApplied(() => refreshBattle());

// --- M12d: dialogue / quest log / heal views (ADR-0071) --------------------------
// All 3 MUST be total (never throw): defense-in-depth (store.flushBatch has per-listener try/catch since M10.5d).
store.onBatchApplied(() => {
  try {
    const conv = store.ownConversation(identity);
    // e-4 guard (M13.5e): build npcsMap only when a conversation is open.
    // allNpcs() is O(n) — doing it on every batch is wasteful during normal play.
    // Reconnect-ordering assumption: NPC content rows arrive in the same batch as (or
    // before) the conversation row, so an active conv always finds its NPC in the map.
    // If ordering regresses, buildDialogueViewModel returns null → view hides safely.
    const allNpcs = conv !== undefined ? store.allNpcs() : [];
    const npcsMap = new Map(allNpcs.map((n) => [n.entityId, n]));
    const dialogueVm = buildDialogueViewModel(conv, npcsMap, DIALOGUE_TREES);
    dialogueView?.render(dialogueVm);
    // Reset on server-side dismiss. This is also the RECONNECT self-heal for
    // dismissPending: it relies on on_disconnect deleting the sender's
    // player_conversation row (lib.rs on_disconnect) so the post-reconnect
    // snapshot has no conversation — removing that server-side delete would
    // silently strand dismissPending=true across a mid-dismiss drop.
    if (!conv) dismissPending = false;
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

// --- M13d: shop view batch listener (ADR-0084) -----------------------------------
// MUST be total (never throw): defense-in-depth (store.flushBatch has per-listener try/catch since M10.5d).
store.onBatchApplied(() => {
  if (!shopView?.visible || identity === '') return;
  try {
    shopView.render(
      buildShopViewModel(
        store.allShops(),
        store.allShopItems(),
        store.itemDefs(),
        store.ownInventory(identity),
      ),
    );
  } catch (err) {
    console.error('[M13d] shop batch listener error', err);
  }
});

// --- m15b: trade view batch listener (ADR-0107) ----------------------------------
// Re-renders when visible so the overlay stays live as the offer status changes
// (e.g. Pending → ConfirmedByCounterparty when counterparty calls respond_trade).
// MUST be total (never throw): defense-in-depth (store.flushBatch has per-listener try/catch).
store.onBatchApplied(() => {
  if (!tradeView?.visible || identity === '') return;
  try {
    tradeView.render(
      buildTradeViewModel(store.allTradeOffers(), identity, store.speciesMap(), store.itemDefs()),
    );
  } catch (err) {
    console.error('[m15b] trade batch listener error', err);
  }
});

// --- M12d: dialogue choice click handler -----------------------------------------
// Reads data-choice-idx from the clicked button and calls advance_dialogue.
document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-choice-idx]') as HTMLElement | null;
  if (!btn) return;
  const raw = btn.dataset.choiceIdx;
  if (raw === undefined) return;
  const choiceIdx = parseInt(raw, 10);
  if (!Number.isNaN(choiceIdx)) {
    sendGuarded('advance', () => conn?.conn.reducers.advanceDialogue({ choiceIdx }));
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
    { ShopView: ShopViewClass },
    { TradeView: TradeViewClass },
  ] = await Promise.all([
    import('./ui/boxView'),
    import('./ui/battleView'),
    import('./ui/raisingView'),
    import('./ui/evolutionView'),
    import('./ui/dialogueView'),
    import('./ui/questLogView'),
    import('./ui/healView'),
    import('./ui/shopView'),
    import('./ui/tradeView'),
  ]);
  renderer = new WorldRenderer();
  const mount = document.getElementById('app');
  if (mount !== null) {
    await renderer.init(mount, rawMap);
    installResizeHandler(renderer, window); // fit the stage to the window + on resize
    boxView = new BoxViewClass(mount, {
      onSetNickname: (monsterId, nickname) => {
        sendGuarded('nickname', () => conn?.conn.reducers.setNickname({ monsterId, nickname }));
      },
      onSetPartySlot: (monsterId, slot) => {
        const finalSlot =
          slot === -1
            ? (nextFreePartySlot(store.ownMonsters(identity), PARTY_SIZE) ?? PARTY_SLOT_NONE)
            : slot;
        sendGuarded('party', () =>
          conn?.conn.reducers.setPartySlot({ monsterId, slot: finalSlot }),
        );
      },
      onHealParty: () => {
        // Use the first available heal location from live store data (M12d).
        // M13.5b (ADR-0085 §D + A9): SKIP the send when no location is loaded — the
        // old `?? 0` fallback sent healParty({locationId: 0}), a guaranteed invisible
        // server Err. The skip is surfaced, never silent. Server still validates
        // zone/range/cooldown on the real send.
        const locationId = healTargetLocationId(store.healLocations());
        if (locationId === undefined) {
          reportError('heal: no heal location available');
        } else {
          sendGuarded('heal', () => conn?.conn.reducers.healParty({ locationId }));
        }
      },
    });
    battleView = new BattleViewClass(mount, {
      onAttack: (battleId, skillId) => {
        sendGuarded('attack', () => conn?.conn.reducers.submitAttack({ battleId, skillId }));
      },
      onFlee: (battleId) => {
        sendGuarded('flee', () => conn?.conn.reducers.flee({ battleId }));
      },
      onSwap: (battleId, teamIndex) => {
        sendGuarded('swap', () => conn?.conn.reducers.swapActive({ battleId, teamIndex }));
      },
      onRecruit: (battleId, baitItemId) => {
        sendGuarded('recruit', () => conn?.conn.reducers.attemptRecruit({ battleId, baitItemId }));
      },
      onUseItem: (battleId, itemId) => {
        sendGuarded('use-item', () => conn?.conn.reducers.useBattleItem({ battleId, itemId }));
      },
    });
    raisingView = new RaisingViewClass(mount, {
      onTrain: (monsterId, foodItemId) => {
        sendGuarded('train', () => conn?.conn.reducers.train({ monsterId, foodItemId }));
      },
      onCare: (monsterId) => {
        sendGuarded('care', () => conn?.conn.reducers.care({ monsterId }));
      },
    });
    evolutionView = new EvolutionViewClass(mount, {
      onEvolve: (monsterId) => {
        sendGuarded('evolve', () => conn?.conn.reducers.evolve({ monsterId }));
      },
      onFuse: (aId, bId) => {
        sendGuarded('fuse', () => conn?.conn.reducers.fuse({ aId, bId }));
      },
    });
    // M12d: dialogue / quest log / heal DOM shells (ADR-0071).
    dialogueView = new DialogueViewClass();
    questLogView = new QuestLogViewClass();
    healView = new HealViewClass();
    // M13d: shop DOM shell (ADR-0084).
    // buy/sell are awaited: the STDB SDK resolves on server-commit, rejects on server-error
    // (see #reducerCallbacks in the SDK source). This is the correct surface for rejection
    // feedback — not conn.reducers.onBuy (which doesn't exist in STDB 2.6).
    // ADR-0082 D5: single-unit MVP (infinite stock; multi-unit sell → future slice).
    const SHOP_QTY = 1 as const;
    shopView = new ShopViewClass({
      onBuy: async (shopId, itemId) => {
        // ADR-0085 A1: gate on frozen FIRST — a call against a dead conn is silently
        // queued and its promise never settles (the feedback line would hang forever).
        if (conn === undefined || conn.linkFrozen()) {
          if (shopView?.visible) shopView.showFeedback('disconnected — try again');
          return;
        }
        try {
          await conn.conn.reducers.buy({ shopId, itemId, qty: SHOP_QTY });
          if (shopView?.visible) shopView.showFeedback('Purchase complete!');
        } catch (err) {
          // ADR-0085 A6: route through reduceErrorMessage — SenderError reasons pass
          // through, InternalError detail never leaks (was a raw err.message leak).
          if (shopView?.visible) shopView.showFeedback(reduceErrorMessage(err, 'buy'));
        }
      },
      onSell: async (itemId) => {
        // Same frozen gate + no-leak rejection routing as onBuy (ADR-0085 A1/A6).
        if (conn === undefined || conn.linkFrozen()) {
          if (shopView?.visible) shopView.showFeedback('disconnected — try again');
          return;
        }
        try {
          await conn.conn.reducers.sell({ itemId, qty: SHOP_QTY });
          if (shopView?.visible) shopView.showFeedback('Sale complete!');
        } catch (err) {
          if (shopView?.visible) shopView.showFeedback(reduceErrorMessage(err, 'sell'));
        }
      },
    });
    // m15b: trade DOM shell (ADR-0107).
    // respond_trade, confirm_trade, cancel_trade are awaited (SDK resolves on server-commit).
    // ADR-0085 A1: gate on frozen FIRST — a call against a dead conn never settles.
    tradeView = new TradeViewClass({
      onAccept: async (tradeId) => {
        if (conn === undefined || conn.linkFrozen()) {
          if (tradeView?.visible) tradeView.showFeedback('disconnected — try again');
          return;
        }
        try {
          await conn.conn.reducers.respondTrade({ tradeId, accepted: true });
          if (tradeView?.visible) tradeView.showFeedback('Trade accepted!');
        } catch (err) {
          if (tradeView?.visible) tradeView.showFeedback(reduceErrorMessage(err, 'respond-trade'));
        }
      },
      onReject: async (tradeId) => {
        if (conn === undefined || conn.linkFrozen()) {
          if (tradeView?.visible) tradeView.showFeedback('disconnected — try again');
          return;
        }
        try {
          await conn.conn.reducers.respondTrade({ tradeId, accepted: false });
          if (tradeView?.visible) tradeView.showFeedback('Trade rejected.');
        } catch (err) {
          if (tradeView?.visible) tradeView.showFeedback(reduceErrorMessage(err, 'respond-trade'));
        }
      },
      onConfirm: async (tradeId) => {
        if (conn === undefined || conn.linkFrozen()) {
          if (tradeView?.visible) tradeView.showFeedback('disconnected — try again');
          return;
        }
        try {
          await conn.conn.reducers.confirmTrade({ tradeId });
          if (tradeView?.visible) tradeView.showFeedback('Trade complete!');
        } catch (err) {
          if (tradeView?.visible) tradeView.showFeedback(reduceErrorMessage(err, 'confirm-trade'));
        }
      },
      onCancel: async (tradeId) => {
        if (conn === undefined || conn.linkFrozen()) {
          if (tradeView?.visible) tradeView.showFeedback('disconnected — try again');
          return;
        }
        try {
          await conn.conn.reducers.cancelTrade({ tradeId });
          if (tradeView?.visible) tradeView.showFeedback('Trade cancelled.');
        } catch (err) {
          if (tradeView?.visible) tradeView.showFeedback(reduceErrorMessage(err, 'cancel-trade'));
        }
      },
    });
  }

  // M13.5b (ADR-0085 C8): create the status surface BEFORE `conn = connect(...)` is
  // assigned so no connection lifecycle callback can ever report into the void.
  const status = document.createElement('div');
  status.id = 'status';
  document.body.appendChild(status);
  statusEl = status;

  conn = connect({
    uri: URI,
    db: DB,
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
      // RT-PL-01: a buy/sell in flight at drop time never settles (SDK — no settle
      // on drop), so the shop's double-spend lock would stay held forever. hide()
      // resets it (shopView.ts is outside this slice's touch-set; the reset rides
      // the existing public hide()). Escape/KeyG already recover it manually
      // during the gap.
      shopView?.hide();
      // m15b: trade's double-spend lock must also be reset on reconnect (same reason as shop).
      tradeView?.hide();
      // The "connection lost — reconnecting…" status line is now stale (ADR-0085 A8).
      clearStatus();
    },
    // 12.5c-1: onOwnWarp delegates to switchZone (idempotent — no-op if rawMap
    // already matches). Fires on live-warp character onUpdate (lower latency path);
    // the reconcile listener's state-based check handles reconnect-strand (character
    // INSERTED at zone 0 with no onUpdate). Both paths are safe to call: switchZone
    // checks rawMap.zone_id before doing any work.
    onOwnWarp: (newZoneId) => {
      switchZone(newZoneId);
    },
    // M13.5b (ADR-0085 D1): lifecycle failures become user-visible via the status
    // line (reportError also console.errors); pre-M13.5b this was console-only.
    onError: (where, message) => reportError(`${where}: ${message}`),
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
          healView?.visible ||
          shopView?.visible ||
          tradeView?.visible
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
