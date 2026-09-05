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

import { Identity } from 'spacetimedb';
// client-wasm (built `wasm-pack build client-wasm --target bundler`; resolved by
// vite-plugin-wasm + top-level-await — see vite.config.ts / server.fs.allow).
import {
  apply_move,
  deletion_grace_ms_default,
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
import type { PvpAction } from './module_bindings/types';
import { BUILD_INFO, formatBuildStamp } from './net/buildInfo';
import { claimCode } from './net/claimCode';
import { connect } from './net/connection';
import { resolveConnectionConfig } from './net/connectionConfig';
import {
  makeFateLogger,
  makeSendLogger,
  RATE_LIMIT_INITIAL,
  rateLimitTick,
  resolveDevLogLevel,
} from './net/devLog';
import { AuthoritativeStore, ownPerspective } from './net/store';
import { shouldReportZoneSyncFailure } from './net/zoneSyncGuard';
import { resolveTelemetryConfig } from './observability/config';
import { createFrameWindow, frameTick } from './observability/frameWindow';
import { maxRemoteGapMs } from './observability/interpGap';
import {
  type ClientTelemetry,
  loadOtelSdk,
  NOOP_TELEMETRY,
  startClientTelemetry,
} from './observability/telemetry';
import { HeldDirections, reissueDir } from './prediction/heldKeys';
import { type ApplyMove, boundSeq, Predictor } from './prediction/predictor';
import { TileMap } from './render/map';
import { motionPreferenceFromWindow } from './render/motionPreference';
import { RenderResolver } from './render/renderResolver';
import { installResizeHandler } from './render/resizeWiring';
import { WorldRenderer } from './render/world';
import { t } from './ui/a11yCopy';
import { type A11ySnapshot, announcementsFor } from './ui/announcements';
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
// pt-b1 (ADR-0130): F9 bug-bundle observability — session event ring + error ring +
// pure bundle assembler + error overlay. main.ts emits only the 6 CORE constructors;
// the 8 parked constructors stay exported in eventRing.ts for pt-b1b.
import {
  bugBundleFilename,
  buildBugBundle,
  type KeyStoreSnapshot,
  serializeBugBundle,
} from './ui/bugBundle';
import { performCare } from './ui/careAction';
import {
  buildClaimViewModel,
  CLAIM_INITIAL,
  type ClaimEvent,
  type ClaimModelState,
  claimStep,
} from './ui/claimModel';
import type { ClaimView, ClaimViewHandlers } from './ui/claimView';
import { DIALOGUE_TREES } from './ui/dialogueContent';
import { buildDialogueViewModel } from './ui/dialogueModel';
import type { DialogueView } from './ui/dialogueView';
import { buildErrorOverlayModel } from './ui/errorOverlayModel';
import { ErrorOverlayView } from './ui/errorOverlayView';
import { ErrorRing } from './ui/errorRing';
import {
  EventRing,
  isPvpBattle,
  makeBattleEnd,
  makeBattleStart,
  makeConnect,
  makeDisconnect,
  makeRankedMatch,
  makeZoneChange,
} from './ui/eventRing';
import { buildEvolutionViewModel } from './ui/evolutionModel';
import type { EvolutionView } from './ui/evolutionView';
import {
  buildHealViewModel,
  buildHealViewModelForLocation,
  healTargetLocationId,
} from './ui/healModel';
import type { HealView } from './ui/healView';
import { buildHelpViewModel } from './ui/helpModel';
import type { HelpView } from './ui/helpView';
import { interactPrompt, nearestInteractable } from './ui/interactModel';
import { buildLeaderboardViewModel } from './ui/leaderboardModel';
import type { LeaderboardView } from './ui/leaderboardView';
import { LiveRegion } from './ui/liveRegion';
import {
  buildMenuViewModel,
  MENU_INITIAL,
  type MenuAvailability,
  type MenuInput,
  type MenuLeafDef,
  type MenuNavState,
  menuKeyInput,
  menuStep,
} from './ui/menuModel';
import type { MenuView } from './ui/menuView';
// uxd3-c (ADR-0164): this import block is pinned by
// W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY Part B — the clause that proves every fan-out
// surface, every hotkey open-guard and the force-hide table resolve to the node-tested
// registry rather than a local decoy, instead of to a locally-declared shadow (red-team F2 /
// the W-CARE-IMPORT pattern). The needle is applied AFTER squashWhitespace, so this block is
// left in Biome's canonical order and wrapping — the tooth pins WHICH VALUES are imported,
// which is the load-bearing part; the specifier order is incidental and is the formatter's.
import {
  anyVisible,
  type CanOpenVerdict,
  canOpen,
  hideAllExceptPlan,
  type OverlayHandles,
  type OverlayId,
  type OverlayProbes,
  visibleIds,
} from './ui/overlayRegistry';
import { buildPrivacyViewModel, privacyBannerLabel } from './ui/privacyBanner';
import {
  type DeletionCountdown,
  deriveDeletionCountdown,
  PRIVACY_INITIAL,
  type PrivacyEvent,
  type PrivacyModelState,
  privacyStep,
} from './ui/privacyModel';
import type { PrivacyView, PrivacyViewHandlers } from './ui/privacyView';
import { buildPvpChallengeViewModel } from './ui/pvpModel';
import type { PvpView } from './ui/pvpView';
import { buildQuestLogViewModel } from './ui/questLogModel';
import type { QuestLogView } from './ui/questLogView';
import { buildRaisingViewModel } from './ui/raisingModel';
import type { RaisingView } from './ui/raisingView';
import { buildRenameViewModel } from './ui/renameModel';
import type { RenameView } from './ui/renameView';
import {
  buildSessionViewModel,
  SESSION_INITIAL,
  type SessionEvent,
  type SessionModelState,
  sessionStep,
} from './ui/sessionModel';
import type { SessionView, SessionViewHandlers } from './ui/sessionView';
import { buildShopViewModel, buildShopViewModelForShop } from './ui/shopModel';
import type { ShopView } from './ui/shopView';
import { reduceErrorMessage } from './ui/statusModel';
import { buildTradeViewModel } from './ui/tradeModel';
import { buildProposeLists, type TradeProposeArgs } from './ui/tradeProposeModel';
import type { TradeProposeView } from './ui/tradeProposeView';
import type { TradeView } from './ui/tradeView';

// pt-a1 (ADR-0128): resolve the SpacetimeDB target at MODULE scope (eager, like the old
// URI/DB consts) so a misconfigured PRODUCTION build fails loud here — before connect() is
// reachable — rather than silently writing to the dev-default database `monster-realm`.
// Kept at module scope on purpose (guarded by main.wiring.test.ts F-3): moving it inside
// main() could let a try/catch swallow the throw.
const { uri: URI, db: DB } = resolveConnectionConfig(
  {
    uri: import.meta.env.VITE_STDB_URI as string | undefined,
    db: import.meta.env.VITE_STDB_DB as string | undefined,
  },
  import.meta.env.DEV,
);
// dev-observability (ADR-0157): resolve VITE_MR_DEVLOG at MODULE scope too, for the same
// F-3 reason — the resolver RETHROWS in dev, and a throw from inside main() could be
// swallowed by a try/catch there. Asymmetric on purpose (inverted vs pt-a1): dev rethrows,
// prod degrades to 'off' with one console.error, because this line runs BEFORE the
// window.onerror / unhandledrejection listeners below. `sendLogger` is undefined at level
// 'off', which is what keeps wrapReducerLogging strict identity in the default prod build.
// console.log, NOT console.debug (Chrome hides debug behind the Verbose level).
const DEV_LOG_LEVEL = resolveDevLogLevel(
  import.meta.env.VITE_MR_DEVLOG as string | undefined,
  import.meta.env.DEV,
  (m) => console.error(m),
);
const sendLogger = makeSendLogger(DEV_LOG_LEVEL, (line) => console.log(line));
// ADR-0172 D2: the INBOUND fate line, same level/sink/undefined-at-'off' discipline as
// sendLogger. CONSOLE-ONLY — a ring push smuggled into this sink would ship reducer args
// (player free text) into the shared F9 bundle (ADR-0157 §4).
const fateLogger = makeFateLogger(DEV_LOG_LEVEL, (line) => console.log(line));

const ZONE_ID = 0;

// Content is single-sourced from game-core via the wasm exports (never duplicated).
const STEP_MS = step_ms();
const QUEUE_CAP = move_queue_cap();
const PARTY_SIZE = party_size();
const PARTY_SLOT_NONE = party_slot_none();
// rb-51 (PRV1-1): the deletion grace window, read ONCE per session — it is a build constant, and
// re-reading it per frame would cross the wasm boundary ~60x/s for a value that cannot change.
const DELETION_GRACE_MS_DEFAULT = deletion_grace_ms_default();
// M11c: rawMap is `let` — replaced on zone warp (zone_map() re-called for the new zone id).
let rawMap = zone_map(ZONE_ID);

// m20c (ADR-0180): wasm-ready mark — the import above is top-level-awaited, so the exports are
// callable here (the metric's definition: ms from timeOrigin), captured once per session.
const WASM_READY_MS = performance.now();
// m20c: module-scope resolve (F-3 pattern); jitter injected so the resolver stays pure (AM12).
const TELEMETRY_CONFIG = resolveTelemetryConfig(
  {
    endpoint: import.meta.env.VITE_MR_OTLP_ENDPOINT as string | undefined,
    intervalMs: import.meta.env.VITE_MR_OTLP_INTERVAL_MS as string | undefined,
  },
  import.meta.env.DEV,
  Math.random(),
);
// Seeded with the shared no-op; re-assigned once by the init hunk iff the bootstrap resolves.
let telemetry: ClientTelemetry = NOOP_TELEMETRY;
// m20c frame accumulator — created ONCE, carried across rAF frames by the frame hunk.
let frameWindow = createFrameWindow(performance.now());

// ADR-0090: stepMs injected so the store can do burst detection + jitter EWMA.
const store = new AuthoritativeStore(STEP_MS);
// The injected rule IS the client-wasm export (same compiled code as the server).
const applyMove = apply_move as unknown as ApplyMove;
let predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
// Routes own (slide clock) vs remote (interpolation buffer) renders (M8.6b).
const resolver = new RenderResolver(STEP_MS);
// A11Y-27: closes render/motionPreference.ts's S7 cross-slice contract. Constructed ONCE
// (its change listener is page-lifetime by design); `.reduceMotion` is a live getter, so the
// per-frame read at the resolve() call below re-reads it rather than a boot-time snapshot.
const motionPreference = motionPreferenceFromWindow();
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
// pt-b1 (ADR-0130): event-emit latches. `activeBattleId` tracks the battle we saw START so
// battleEnd only fires for a battle we witnessed (guards a stale-terminal-at-first-sight).
// `lastOwnRating` baselines the ranked-delta detector. BOTH reset to null on
// reconnect/zone-switch (resetPredictionState) so they re-baseline — the RINGS do NOT reset.
let activeBattleId: bigint | null = null;
let lastOwnRating: number | null = null;
// pt-b1 review (red-team M-1) + 16r-f + 17r-b: set on RECONNECT only. A still-Ongoing battle
// that survived the drop must NOT re-emit battleStart. Armed until the connection signals
// hydration-complete (onHydrated) — never resolved by what a flush happens to read, so a partial
// hydration cannot burn it; reseedPrevBattleId is the drop-time battle so only ITS re-sighting
// is silent. hydratedSinceReconnect is reset on EVERY reconnect and set by onHydrated.
let battleReseedPending = false;
let reseedPrevBattleId: bigint | null = null;
let hydratedSinceReconnect = false;
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
let pvpView: PvpView | undefined;
// m17b: ranked leaderboard overlay (ADR-0120) — pure subscription view (RL-15).
let leaderboardView: LeaderboardView | undefined;
// pt-c1b: profile-rename overlay (ADR-0133) — the first text-input overlay; wires the
// merged set_profile_name reducer (ADR-0132) to a KeyN rename form.
let renameView: RenameView | undefined;
// pt-c2: trade-PROPOSE overlay (ADR-0134) — KeyO "Offer" form; wires reducers.proposeTrade
// to let a human initiate a "sell my monster(s) + gold for your gold" trade.
let tradeProposeView: TradeProposeView | undefined;
// pt-c2b: in-client help overlay (ADR-0135) — display-only `?` overlay listing
// controls + goals. No callbacks / reducer (zero-arg construction).
let helpView: HelpView | undefined;
// uxd3 (ADR-0162): the two-level main menu — the 15th mutual-exclusion overlay.
let menuView: MenuView | undefined;
// M21b-2 (ADR-0182 D16/D17): the guest-claim overlay (registry GUARD_ONLY) and the
// session-lifecycle overlay (registry-EXTERNAL, driven by conn.sessionState()), each backed by
// its pure model state carried at module scope.
let claimView: ClaimView | undefined;
let privacyView: PrivacyView | undefined;
let sessionView: SessionView | undefined;
let claimModelState: ClaimModelState = CLAIM_INITIAL;
let sessionModelState: SessionModelState = SESSION_INITIAL;
// m16b: tracks the turn number at the time the player submitted a PvP action.
// When the server resolves the turn (battle.turnNumber increments beyond this),
// pvpPendingTurnNumber is cleared and pvpPendingSubmit becomes false.
// battle_action is PRIVATE (ADR-0015 must-never-leak) — this is the ONLY signal
// the client has about its own submission state.
let pvpPendingTurnNumber: number | null = null;
// dismissPending: prevents double-sending dismiss_dialogue while server processes it (M12d).
// eslint-disable-next-line prefer-const
let dismissPending = false;
// uxd2 (ADR-0161 D4/D5): deferred shop-open + bound-overlay view state.
// pendingShopId is set by the [data-shop-id] dialogue click branch and
// consumed-and-cleared atomically by the dialogue batch listener's
// no-conversation arm — the open is NEVER performed inline (adjudication 1).
// boundShopId / boundHealLocationId record which shop / heal location the
// visible overlay is bound to, so a refresh batch never silently swaps a bound
// view back to the first-row default. All three clear on Escape-cancel paths
// and on reconnect (the store reset invalidates the ids).
let pendingShopId: number | null = null;
let boundShopId: number | null = null;
let boundHealLocationId: number | null = null;

// UXD3B-PROBES-BEGIN
// uxd3-b (ADR-0163): the ONE probe table. Every fan-out surface below reads visibility
// through it, so a 16th overlay is a COMPILE error here instead of 5 silent omissions.
// Each entry is intentionally byte-identical `<id>: () => <id>?.visible ?? false` —
// W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY Part B pins that literal shape, because
// main.ts is coverage-excluded and a single negated or `?? true` probe would corrupt all
// five surfaces at once while every other tooth stayed green.
// ⚠ No quoted hotkey literal may appear in this block (W-UXD3-HOTKEY-ANCHORS-AFTER-KEYDOWN).
const overlayProbes: OverlayProbes = {
  battleView: () => battleView?.visible ?? false,
  boxView: () => boxView?.visible ?? false,
  raisingView: () => raisingView?.visible ?? false,
  evolutionView: () => evolutionView?.visible ?? false,
  dialogueView: () => dialogueView?.visible ?? false,
  questLogView: () => questLogView?.visible ?? false,
  healView: () => healView?.visible ?? false,
  shopView: () => shopView?.visible ?? false,
  tradeView: () => tradeView?.visible ?? false,
  pvpView: () => pvpView?.visible ?? false,
  leaderboardView: () => leaderboardView?.visible ?? false,
  renameView: () => renameView?.visible ?? false,
  tradeProposeView: () => tradeProposeView?.visible ?? false,
  helpView: () => helpView?.visible ?? false,
  menuView: () => menuView?.visible ?? false,
  claimView: () => claimView?.visible ?? false,
  privacyView: () => privacyView?.visible ?? false,
};
// UXD3B-PROBES-END

// UXD3C-HANDLES-BEGIN
// uxd3-c (ADR-0164): the ONE force-hide handle table — the WRITE mirror of `overlayProbes`.
// Typed `OverlayHandles` (a total `Record<OverlayId, _>`), so a 16th overlay is a COMPILE
// error here rather than an overlay a verdict can name and nothing can hide. Every entry is
// intentionally byte-identical `<id>: () => <id>?.hide()` — W-UXD3C-HANDLE-TABLE pins that
// literal per id, because main.ts is coverage-excluded and a copy-pasted sibling thunk
// (`raisingView: () => boxView?.hide()`) type-checks perfectly while hiding the wrong overlay.
// `dialogueView` is the SOLE `undefined` entry and must stay that way: it is the only member
// of NEVER_FORCE_HIDE, because hiding a live conversation client-side strands the server
// `player_conversation` row (ptc5c/ADR-0139, ADR-0162 AC-9). Consumers read
// `overlayHandles[id]?.()`; only verdicts decide WHICH ids they call.
// ⚠ No quoted hotkey literal may appear in this block (W-UXD3-HOTKEY-ANCHORS-AFTER-KEYDOWN).
const overlayHandles: OverlayHandles = {
  battleView: () => battleView?.hide(),
  boxView: () => boxView?.hide(),
  raisingView: () => raisingView?.hide(),
  evolutionView: () => evolutionView?.hide(),
  dialogueView: undefined,
  questLogView: () => questLogView?.hide(),
  healView: () => healView?.hide(),
  shopView: () => shopView?.hide(),
  tradeView: () => tradeView?.hide(),
  pvpView: () => pvpView?.hide(),
  leaderboardView: () => leaderboardView?.hide(),
  renameView: () => renameView?.hide(),
  tradeProposeView: () => tradeProposeView?.hide(),
  helpView: () => helpView?.hide(),
  menuView: () => menuView?.hide(),
  claimView: () => claimView?.hide(),
  privacyView: () => privacyView?.hide(),
};
// UXD3C-HANDLES-END

// UXD3C-CANOPEN-BEGIN
// uxd3-c (ADR-0164): the ONE gate binder. Returns the VERDICT, not a boolean, because the
// three hide-switch handlers consume `forceHide`; each call site spells `.kind === 'allow'`
// itself, deliberately, so no single `!` can invert eleven gates at once. Re-probes through
// `visibleIds(overlayProbes)` on EVERY call — this table is built while every view binding is
// still undefined, so anything cached would be permanently empty.
// ⚠ No quoted hotkey literal may appear in this block (W-UXD3-HOTKEY-ANCHORS-AFTER-KEYDOWN).
function overlayVerdict(id: OverlayId): CanOpenVerdict {
  return canOpen(id, visibleIds(overlayProbes));
}
// UXD3C-CANOPEN-END

/** uxd2 (ADR-0161 D4), rewired by uxd3-b (ADR-0163): the ONE shared predicate over the
 *  17 mutual-exclusion overlays. Every per-overlay read now lives in `overlayProbes`
 *  above — this body holds none. Six consumers: the four negated fan-out surfaces, the
 *  deferred shop-open gate and the frame-loop prompt. The hotkey handlers still keep
 *  their inline guard lists (each exempts its own overlay); routing those through
 *  `canOpen` is uxd3-c. The NAME is load-bearing (anti-pattern 18). */
function anyOverlayVisible(): boolean {
  return anyVisible(overlayProbes);
}

/** entityId → positional tile snapshot for the interact resolver (uxd2, ADR-0161).
 *  store.characters() is the WHOLE character table (players + NPCs); entityId is
 *  globally unique (one auto_inc sequence), so joining the NPC registry against
 *  this map always lands on the NPC's own row. Shared by the KeyT dispatch and
 *  the frame-loop prompt so the two sites can never diverge. */
function characterTileMap(): Map<bigint, { zoneId: number; tileX: number; tileY: number }> {
  return new Map(
    [...store.characters()].map((c) => [
      c.row.entityId,
      { zoneId: c.row.zoneId, tileX: c.row.tileX, tileY: c.row.tileY },
    ]),
  );
}

// M21b-2 (ADR-0182 D17): true while the session terminal (expired / unreachable) owns the
// screen. sessionView is registry-EXTERNAL, so anyOverlayVisible() cannot see it — this predicate
// is the ONE SSOT the keydown handler AND the frame loop both consult, checked first on every
// input path. `hidden` is the ordinary case and must NOT block.
function sessionGateBlocks(): boolean {
  const s = conn?.sessionState();
  return s !== undefined && s !== 'hidden';
}

// --- M21b-2 (ADR-0182 D16/D17): claim / session model drivers ------------------------------
function renderSession(): void {
  sessionView?.render(buildSessionViewModel(sessionModelState));
}

function applySession(event: SessionEvent): void {
  const step = sessionStep(sessionModelState, event);
  sessionModelState = step.next;
  if (step.effect === 'continue-anonymously') conn?.continueAnonymously();
  if (step.effect === 'retry-connect') conn?.reconnectNow();
  renderSession();
}

function renderClaim(): void {
  // rb-52: ClaimPhase cannot represent "dismissed" (S4-claimView-REOPEN-AFTER-HIDE), so a later
  // claim-lifecycle render would re-open the claim overlay ON TOP of the privacy modal, stealing
  // its focus trap mid-confirmation. DEFERRED, not dropped: renderClaim is the only path by which
  // the reconnect-driven claim flow pops itself up, so discarding the paint would strand a pending
  // claim with no UI at all. The privacy overlay's dismissal flushes it.
  if (privacyView?.visible) {
    claimRenderPending = true;
    return;
  }
  claimRenderPending = false;
  claimView?.render(buildClaimViewModel(claimModelState));
}
/** Set when a claim paint was deferred because the privacy overlay owned the screen. */
let claimRenderPending = false;

function applyClaim(event: ClaimEvent): void {
  const step = claimStep(claimModelState, event);
  claimModelState = step.next;
  // The AUTHORITATIVE claim-code veto lives in connection.ts's onApplied (G18); here we only mirror
  // the local storage effect so a declined / dead code stops vetoing the next connection's join.
  if (step.effect === 'delete-code-and-permit-join') claimCode.clear(globalThis, URI, DB);
  if (step.effect === 'join') conn?.live()?.reducers.joinGame({ name: 'Player' });
  renderClaim();
}

// --- rb-52 (PRV1-3/PRV1-4): the privacy surface ------------------------------------
// Decisions live in ui/privacyModel.ts (rules) and ui/privacyBanner.ts (copy); this block only
// dispatches and paints. Rationale is ADR-0231 Amendment A2, not repeated here.
let privacyModelState: PrivacyModelState = PRIVACY_INITIAL;
// The last countdown fed to the model. `account-changed` writes `inFlight: 'none'`, so pumping it
// every frame would give the double-submit guard a ~16ms life (A2-D9).
let lastPrivacyCountdown: DeletionCountdown | undefined;
// The countdown as of THIS frame. The model is pumped only on a permission/phase change (A2-D9),
// but the surface's status line FORMATS `remainingMs` — so rendering from the model's stored
// countdown would freeze the deadline at the value the last phase change left behind, i.e. for the
// whole grace window, while the HUD banner beside it ticks. Two contradictory deletion deadlines
// from one derivation is the worst outcome available on a compliance surface. Written every frame,
// read only at render: no model write, so `inFlight` is untouched.
let livePrivacyCountdown: DeletionCountdown | undefined;
// The last status line painted, so the per-frame render is a no-op until the label actually moves.
let lastPrivacyStatusLabel: string | undefined;

function renderPrivacy(): void {
  const vm = buildPrivacyViewModel(
    livePrivacyCountdown === undefined
      ? privacyModelState
      : { ...privacyModelState, countdown: livePrivacyCountdown },
  );
  lastPrivacyStatusLabel = vm.statusLabel;
  privacyView?.render(vm);
}

// A2-D8: a missing live handle is a NON-DELIVERY. sendGuarded cannot see it — `undefined?.catch()`
// is silent — so inFlight would stick forever and every later click would be a silent no-op.
function privacyLinkLive(): boolean {
  return conn?.live() !== undefined && !conn.linkFrozen();
}

function applyPrivacy(event: PrivacyEvent): void {
  const step = privacyStep(privacyModelState, event);
  privacyModelState = step.next;
  switch (step.effect) {
    case 'none':
      break;
    case 'call-delete-account':
      sendPrivacy('delete-account', 'delete', () => conn?.live()?.reducers.deleteAccount({}));
      break;
    case 'call-cancel-account-deletion':
      sendPrivacy('cancel-account-deletion', 'cancel', () =>
        conn?.live()?.reducers.cancelAccountDeletion({}),
      );
      break;
    case 'call-request-data-export':
      sendPrivacy('request-data-export', 'export', () =>
        conn?.live()?.reducers.requestDataExport({}),
      );
      break;
  }
  renderPrivacy();
}

// Like sendGuarded, but the rejection is routed BACK INTO THE MODEL as well as to the error ring:
// `privacyModel.ts` keys PRV1-4's terminal notice on the message text, and reduceErrorMessage
// composes exactly the `${where}: ${message}` shape its `endsWith` guard expects.
function sendPrivacy(
  where: string,
  which: 'delete' | 'cancel' | 'export',
  call: () => Promise<void> | undefined,
): void {
  call()?.then(
    () => applyPrivacy({ kind: 'request-succeeded', which }),
    (err: unknown) => {
      const message = reduceErrorMessage(err, where);
      reportError(message);
      applyPrivacy({ kind: 'request-failed', which, message });
    },
  );
}

// A2-D5: the claim overlay is hidden FIRST. openOverlayA11y captures document.activeElement as its
// return target and closeOverlayA11y restores it while the node is still isConnected — which a
// display:none node is — so showing first would park focus in a hidden subtree on close and kill
// every overlay hotkey until the player clicks the canvas.
function openPrivacy(): void {
  // The verdict is taken BEFORE the hide. `claimView` is never a legitimate blocker — this surface
  // is reached FROM it — and it is safe to read that off `blockedBy` rather than re-probing,
  // because `canOpen` reports the FIRST denier in OVERLAY_IDS order and `claimView` is
  // second-to-last, so a `claimView` verdict means nothing else denied. Hiding first and
  // discovering the deny afterwards would leave the player with NEITHER overlay and no message.
  const verdict = overlayVerdict('privacyView');
  if (verdict.kind === 'deny' && verdict.blockedBy !== 'claimView') {
    reportError('privacy: close the other overlay first');
    return;
  }
  // Only now. A2-D5: hiding claim BEFORE show() is what keeps openOverlayA11y from capturing a
  // soon-to-be-hidden node as its focus-return target.
  claimView?.hide();
  renderPrivacy();
  privacyView?.show();
}

// AUTH-51: "signed in" is store.ownAccount(identity) !== undefined — the row the SERVER wrote —
// never a storage marker or the credential kind (ADR-0182 D15).
function openClaim(): void {
  applyClaim({
    kind: 'claim-ui-opened',
    nudgeAlreadySeen: claimCode.hasSeenFirstRunNudge(globalThis, URI, DB),
  });
  claimCode.markFirstRunNudgeSeen(globalThis, URI, DB);
  claimView?.show();
  renderClaim();
}
// --- uxd3 (ADR-0162): the main menu ------------------------------------------------
//
// ⚠ ANCHOR DISCIPLINE (plan anti-pattern 14b): this block sits ABOVE the keydown listener,
// and many wiring teeth slice forward from the FIRST indexOf of a quoted hotkey literal.
// No quoted hotkey anchor may appear anywhere below until the listener — describe keys in
// prose only. Pinned by W-UXD3-HOTKEY-ANCHORS-AFTER-KEYDOWN.
//
// ONE OPEN PATH PER OVERLAY: each openX() below is the single build-VM-and-show body for
// its overlay, called by BOTH its hotkey handler and the menu. The view contract is
// non-uniform (dialogue/questLog/heal expose render() with no show(); pvp takes
// refresh(vm, forceVisible)), so these are per-id thunks, never a generic view.show().

/** Nav position inside the menu. Reset by openMenu() — four paths (the M toggle-close,
 *  refreshBattle, the dialogue preempt, onReconnect) hide the view WITHOUT going through
 *  menuStep, so resetting on close would miss them. Pinned by W-OPENMENU-RESETS-STATE. */
let menuState: MenuNavState = MENU_INITIAL;

function openQuestLog(): void {
  questLogView?.render(buildQuestLogViewModel(store.ownQuests(identity)));
}

function openTrade(): void {
  tradeView?.render(
    buildTradeViewModel(store.allTradeOffers(), identity, store.speciesMap(), store.itemDefs()),
  );
  tradeView?.show();
}

function openPvp(): void {
  // forceVisible=true: the player explicitly opened it — stay up even with no live challenge.
  pvpView?.refresh(
    buildPvpChallengeViewModel(store.allChallenges(), identity, store.allPlayers()),
    true,
  );
}

function openLeaderboard(): void {
  leaderboardView?.render(buildLeaderboardViewModel(store.allProfiles(), identity));
  leaderboardView?.show();
}

function openRename(): void {
  renameView?.render(buildRenameViewModel(store.player(identity)?.name ?? '', ''));
  renameView?.show();
}

function openPropose(): void {
  tradeProposeView?.render(
    buildProposeLists(
      store.allPlayers(),
      store.ownMonsters(identity),
      store.speciesMap(),
      identity,
    ),
  );
  tradeProposeView?.show();
}

function openHelp(): void {
  helpView?.render(buildHelpViewModel());
  helpView?.show();
}

/** The interact dispatch, extracted so the menu's Interact leaf and the interact hotkey
 *  share ONE exhaustive `switch (target.kind)` — duplicating it would destroy the
 *  single-site compiler flag a 4th NpcInteraction kind relies on (ADR-0161). */
function interactAtNearest(): void {
  const own = store.ownCharacter(identity);
  if (own === undefined) return;
  const target = nearestInteractable(
    own.row,
    store.allNpcs(),
    characterTileMap(),
    store.healLocations(),
  );
  if (target === undefined) return;
  // Exhaustive switch on the descriptor kind — NO default arm, so a 4th
  // NpcInteraction-driven kind compiler-flags this dispatch site.
  switch (target.kind) {
    case 'dialogue':
    case 'shop':
      sendGuarded('talk', () => conn?.live()?.reducers.talk({ npcEntityId: target.npcEntityId }));
      break;
    case 'heal':
      boundHealLocationId = target.locationId;
      healView?.render(
        buildHealViewModelForLocation(target.locationId, store.healLocations(), store.itemDefs()),
      );
      break;
  }
}

/** Store reads → the three plain booleans the pure core consumes. TOTAL: pre-join and
 *  mid-reconnect `ownCharacter` is undefined, and PvP/Offer are online-player EXISTENCE,
 *  never a proximity test (the help copy says "nearby", but no reducer has a range rule —
 *  a distance check would grey both leaves out permanently). W-MENU-AVAILABILITY-SOURCES. */
function menuAvailability(): MenuAvailability {
  const own = store.ownCharacter(identity);
  const hasInteractTarget =
    own !== undefined &&
    nearestInteractable(own.row, store.allNpcs(), characterTileMap(), store.healLocations()) !==
      undefined;
  const pvpVm = buildPvpChallengeViewModel(store.allChallenges(), identity, store.allPlayers());
  return {
    hasInteractTarget,
    hasTradeTargets:
      buildProposeLists(
        store.allPlayers(),
        store.ownMonsters(identity),
        store.speciesMap(),
        identity,
      ).targets.length > 0,
    hasPvpTargets: pvpVm.challengeablePlayers.length > 0 || pvpVm.incoming !== null,
  };
}

function renderMenu(): void {
  menuView?.render(buildMenuViewModel(menuState, menuAvailability()));
}

/** The SINGLE entry point. Resets the nav position so the menu always opens at the
 *  top-level category list, whatever hid it last. */
function openMenu(): void {
  menuState = MENU_INITIAL;
  renderMenu();
  menuView?.show();
}

/** Route a chosen leaf. The menu has already closed itself, so Escape from the overlay
 *  this opens returns to the world in ONE press and can never re-open the menu. */
function activateMenuLeaf(leaf: MenuLeafDef): void {
  menuView?.hide(); // close FIRST — the target opens over the world, never over the menu
  // Leaf activation is a SECOND route to talk / proposeTrade / store.ownCharacter(identity),
  // all of which throw or send garbage before the join round-trip completes. The KeyM guard
  // is not enough: activation happens later. identity is '' until the first onReady and is
  // REASSIGNED (never cleared) on reconnect, so this is the pre-join gate only.
  if (identity !== '') {
    // Exhaustive switch, no default arm: a new leaf compiler-flags this site.
    switch (leaf.id) {
      // The menu is GUARD_ONLY, so canOpen denies it over any of the box/raising/evolution
      // trio — none of them can be visible here, and no force-hide is needed.
      case 'box':
        boxView?.show();
        refreshBox();
        break;
      case 'backpack':
        raisingView?.show();
        refreshRaising();
        break;
      case 'evolve':
        evolutionView?.show();
        refreshEvolution();
        break;
      case 'interact':
        interactAtNearest();
        break;
      case 'journal':
        openQuestLog();
        break;
      case 'incomingTrade':
        openTrade();
        break;
      case 'offerTrade':
        openPropose();
        break;
      case 'pvp':
        openPvp();
        break;
      case 'leaderboard':
        openLeaderboard();
        break;
      case 'rename':
        openRename();
        break;
      case 'account':
        openClaim();
        break;
      case 'help':
        openHelp();
        break;
    }
  }
}

/** Feed one nav input through the pure reducer and apply its effect. */
function handleMenuInput(input: MenuInput): void {
  const step = menuStep(menuState, input, menuAvailability());
  menuState = step.state;
  switch (step.effect.kind) {
    case 'none':
      renderMenu();
      break;
    case 'close':
      menuView?.hide();
      break;
    case 'activate': {
      activateMenuLeaf(step.effect.leaf);
      break;
    }
  }
}

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
  // pt-b1 (E-3): unify UI/reducer failures into the error ring so the F9 bundle captures them.
  pushError('reducer', text);
}

/** Clear the status line (on reconnect: the frozen-link message is stale, A8). */
function clearStatus(): void {
  if (statusEl !== undefined) statusEl.textContent = '';
}

// --- pt-b1 (ADR-0130): F9 bug-bundle observability rings + error overlay -----------
// The rings are the SESSION buffer (survive reconnect/zone-switch — only the emit
// latches re-baseline). tMs comes from Date.now() in production; the rings inject the
// clock so their unit tests stay deterministic. The overlay is mounted in main().
const eventRing = new EventRing(() => Date.now());
const errorRing = new ErrorRing(() => Date.now());
let errorOverlayView: ErrorOverlayView | undefined;
// Re-entrancy guard: if rendering the overlay itself throws and re-enters pushError,
// short-circuit so a render fault cannot recurse into a stack overflow.
let handlingError = false;

/** Record an error into the ring and reflect it in the overlay. TOTAL (never throws to
 *  the caller): a render/ring fault routes to console.error. */
function pushError(source: 'uncaught' | 'unhandledrejection' | 'reducer', raw: unknown): void {
  if (handlingError) return;
  handlingError = true;
  try {
    errorRing.push(source, raw);
    if (errorOverlayView) {
      // ADR-0172 D3: the movement breadcrumb is BUNDLE-bound, never OVERLAY-bound. This ring
      // IS the overlay's source (newest 8), so unfiltered the 16 capped breadcrumbs would
      // surface silent rejections (M2 §3) and evict real errors from the visible window.
      errorOverlayView.render(
        buildErrorOverlayModel(
          errorRing.snapshot().filter((r) => !r.message.startsWith(MOVE_REJECT_PREFIX)),
        ),
      );
      if (!errorOverlayView.visible) errorOverlayView.show();
    }
  } catch (e) {
    console.error('[obs] pushError', e);
  } finally {
    handlingError = false;
  }
}

// Global capture of uncaught errors + unhandled rejections into the error ring (E-1/E-2).
window.addEventListener('error', (e) => pushError('uncaught', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => pushError('unhandledrejection', e.reason));

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
  // nh3 (ADR-0152) Case M2: the rebuilt predictor must never re-issue a seq already
  // sent on this socket — otherwise the server rejects the player's first post-warp
  // move as "stale seq" and it is (correctly, same-epoch) evicted. Floor the fresh
  // instance to the highest seq ever sent; the gap this leaves is legal because the
  // server's stale-seq guard is monotonic, not consecutive (ADR-0085 SDK-evidence).
  predictor.seedSeq(lastSentSeq);
  resolver.reset();
  held.clear();
  sawFractionalOwnMotion = false;
  dismissedBattleId = null;
  battleSynced = false;
  lastBattleVM = null;
  // m16b: pending PvP submit state must be cleared on reconnect/zone-switch — the
  // server will have GC'd the old battle and any pending action is no longer relevant.
  pvpPendingTurnNumber = null;
  // M12.5d-4: reset camera hold so a fresh zone/reconnect starts at origin rather than
  // holding a position from a prior zone.
  lastCamX = 0;
  lastCamY = 0;
  // pt-b1 (ADR-0130): re-baseline the event-emit latches (NOT the rings — those are the
  // session buffer). After a reconnect/zone-switch the old battle is GC'd and the rating
  // baseline must be re-seeded from the first fresh batch, not carried across.
  activeBattleId = null;
  lastOwnRating = null;
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
    // pt-b1: capture the origin zone BEFORE the commit overwrites rawMap.
    const fromZone = rawMap.zone_id;
    const newRawMap = zone_map(newZoneId);
    TileMap.fromRaw(newRawMap); // validate BEFORE any mutation (12.5c-3) — throws on bad data
    renderer?.setMap(newRawMap); // draw BEFORE committing zone state (RT-SZ-01: atomicity)
    set_active_zone(newZoneId);
    rawMap = newRawMap;
    // M20C-ZONE-BEGIN
    telemetry.setZone(newZoneId);
    // M20C-ZONE-END
    // nh5 (ADR-0192): preserve the held stack across the WARP rebuild only — the
    // reconnect arm's clear is load-bearing (ADR-0152 per-path invariant).
    const heldSnapshot = held.snapshot();
    resetPredictionState();
    held.restore(heldSnapshot);
    zoneSyncFailureCount = 0; // success: reset streak
    // pt-b1: emit the zone-change event ONLY on the success path, after set_active_zone.
    eventRing.push(makeZoneChange(fromZone, newZoneId));
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
    // M20C-RECONCILE-BEGIN
    telemetry.recordReconcile();
    if (diverged) telemetry.recordCorrection();
    // M20C-RECONCILE-END
    // Honor reconcile's documented divergence return (ADR-0013): on a genuine server
    // pullback, re-commit the held direction so a held key keeps walking from the
    // corrected baseline (same held-state-guarded dedup + hold-commit tap/hold
    // discrimination as the rAF frame loop, ADR-0158).
    // nh2 (ADR-0148): gate this second continuation emitter on the same outstanding-work
    // predicate as the rAF loop. Cost is bounded by the next authoritative batch
    // (<= ~STEP_MS + RTT), never stuck: every server-side queue mutation writes the
    // character row, and the reject path force-reconciles here (ADR-0085).
    if (diverged && predictor.outstandingSteps === 0 && !anyOverlayVisible()) {
      const heldDir = reissueDir(held.committedActive(now), predictor.lastQueuedDir);
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
// nh3 (ADR-0152): highest seq ever handed to enqueueMove — the seedSeq floor for rebuilds.
let lastSentSeq = 0;

// --- 11r-h (ADR-0172): movement-rejection diagnostics -----------------------------
// Rejections stay SILENT to the player (M2 §3), so an F9 bundle from a rubber-banding
// session used to show nothing. Two sinks close that: the flag-gated console fate line
// and a rate-limited errorRing breadcrumb (bundle-only, overlay-filtered). ONE prefix
// const feeds both the formatter and that filter, so they cannot drift apart.
const MOVE_REJECT_PREFIX = 'movement-reject ';
// ADR-0172 D1: 16 breadcrumbs leave >= 48 of the 64 ring slots for real crash records.
// `minGapMs`, not `windowMs` — the substring `window` reds the dev-observability eval.
const MOVE_REJECT_POLICY = { minGapMs: 3_000, cap: 16 };
// MODULE scope: inside the helper this would re-initialise per rejection and the gap and
// the cap would both silently do nothing.
let moveRejectLimit = RATE_LIMIT_INITIAL;
// ADR-0187 (b): DEV e2e observability — intents actually issued / rejection callbacks seen.
let moveSendCount = 0;
let moveRejectCount = 0;
/** Record one rejected movement intent. TOTAL — see the catch. */
function noteMoveRejection(seq: number, dropped: boolean): void {
  try {
    moveRejectCount += 1; // ADR-0187: every rejection callback, dropped or not
    fateLogger?.('enqueueMove', 'rejected', [{ seq, dropped }]);
    // Monotonic clock, as elsewhere on this path. rateLimitTick is PURE — write it back.
    const tick = rateLimitTick(moveRejectLimit, performance.now(), MOVE_REJECT_POLICY);
    moveRejectLimit = tick.state;
    if (tick.emit) {
      errorRing.push(
        'reducer',
        `${MOVE_REJECT_PREFIX}seq=${seq} dropped=${dropped ? 1 : 0} count=${tick.emit.pending} breadcrumb=${tick.state.emitted}/${MOVE_REJECT_POLICY.cap}`,
      );
    }
    if (dropped) telemetry.recordIntentReject();
  } catch {
    // Diagnostics must never escalate a movement rejection into a user-visible error:
    // a throw here rejects the .catch handler's promise, which reaches the
    // unhandledrejection listener, which calls pushError, which SHOWS the overlay.
  }
}
function sendIntent(input: WasmMoveInput): void {
  // Single choke point for the movement freeze (ADR-0085 D3): the keydown first
  // step, the frame-loop held re-issue, AND the reconcile-listener divergence
  // re-issue all route through here, so this one gate covers every movement path.
  // No prediction against a dead link either — enqueue is skipped, not just the send.
  if (conn === undefined || conn.linkFrozen()) return;
  const intent = predictor.enqueue(input);
  if (intent === undefined) return; // ADR-0052: declined (queue at cap) — predict & send nothing
  const seq = intent.seq;
  const epoch = intent.epoch;
  lastSentSeq = seq; // nh3 Case-M2 floor: reached only when the reducer call below is issued
  moveSendCount += 1; // ADR-0187: every intent issued to the reducer (DEV e2e send budget)
  const t0 = performance.now();
  // ADR-0182 D13: conn.conn widened to `DbConnection | undefined`; live() is the guarded read.
  // Unreachable-undefined given the frozen gate above (G26 invariant), but tsc requires the check.
  const live = conn.live();
  if (live === undefined) return;
  const sent = live.reducers.enqueueMove({ input: moveInputToSdk(input), seq: BigInt(seq) });
  sent
    .then(() => {
      // m20c RTT sample — self-guarded (AM8) so no fault here can reach the rejection handler.
      try {
        telemetry.recordRtt(performance.now() - t0);
      } catch {
        // swallowed (AM8)
      }
    })
    .catch(() => {
      // Movement rejections stay SILENT to the user (M2 §3) — prediction repair only.
      // ADR-0085 A2 (amended by nh3/ADR-0152): this closure captures ONLY PRIMITIVES —
      // `seq` and `epoch`, both consts read from the intent BEFORE the closure exists —
      // and reads the module-scope `predictor` at fire time. Never capture the intent
      // object or the predictor instance here: a rejection promise may never settle
      // after a socket drop (SDK no-settle-on-drop), so anything non-primitive it
      // closes over is retained indefinitely. Cross-instance staleness is now guarded
      // MECHANICALLY: dropRejected no-ops when the captured epoch is not the live
      // instance's own generation (Case M1), and the send-seq floor above + the
      // seedSeq call in the prediction reset remove the post-rebuild seq collision
      // itself (Case M2), so a genuine "stale seq" rejection of the first post-warp
      // move never comes into existence. The ordering invariant that previously
      // carried this seam alone — rejections settle only on message receipt from the
      // live socket, so a stale `.catch` drains as a microtask against the OLD
      // predictor before any rebuild — is hereby DEMOTED to defense-in-depth, not
      // retracted: it still holds, but it rests on observed SDK 2.6.0 behavior, not
      // on a contract, and the epoch guard is the mechanical backstop if it drifts.
      // ADR-0085 A3: burst rejections (N rejects → N drop+reconcile microtasks in one
      // turn) are harmless — the microtask checkpoint drains before the next rAF, the
      // renderer reads predictor state only in rAF, and each reconcile is a total
      // re-derivation from store truth (idempotent, converging). No coalescing needed.
      const dropped = predictor.dropRejected(seq, epoch);
      if (dropped) reconcileFromStore();
      noteMoveRejection(seq, dropped);
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

// nh1 (ADR-0146): true when the browser's native action for THIS key on THIS target is the
// target's own and must not be cancelled. Text fields and <select>s consume arrows AND Space;
// a focused <button>/<a> consumes only Space (activation). Arrows over a button are NOT owned,
// so the page-scroll fix still applies in the commonest state — a button keeps focus after a
// click. Only renameView/tradeProposeView stopPropagation their focusables; the other eight
// overlays' buttons/selects bubble straight here, so this guard is what keeps them usable.
const targetOwnsKey = (e: KeyboardEvent): boolean => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return e.code === 'Space' && (tag === 'BUTTON' || tag === 'A');
};

// nh1 (ADR-0146): movement keys and Space carry native browser defaults (page scroll) that MUST
// be cancelled on the handler's EARLY-RETURN paths too — an open overlay makes the document
// taller than the viewport-sized canvas, so those defaults scroll the game out from under the
// player. Called on BOTH early returns; each OS key-repeat keydown carries its own default, so
// suppressing only the first one would leave a held arrow key scrolling on every repeat tick.
const suppressNativeMovementDefault = (e: KeyboardEvent): void => {
  if ((KEY_DIR[e.code] !== undefined || e.code === 'Space') && !targetOwnsKey(e))
    e.preventDefault();
};

// M23S5-WORLDFOCUS-BEGIN
// m23-s5 (ADR-0206 D1, M23 §2.3; A1): the scoped world-focus gate for the twelve overlay-open
// hotkeys. The `=== document.body` disjunct is LOAD-BEARING and must never be "cleaned up"
// (A11Y-35): a store-driven render(null) blurs a focused control back to <body>, and without
// it every hotkey would be dead forever afterwards. Before main() runs, worldCanvasEl is null
// and activeElement is <body>, so this is true and behaviour is identical to pre-M23.
// A1 (fix cycle 1): each guard is `allow && (<self>?.visible || worldHasFocus())` — a same-key
// press on an ALREADY-OPEN overlay is a toggle-CLOSE and is never gated; the gate covers only
// the OPEN transitions (three merged e2e feature tests encode same-key-to-close).
let worldCanvasEl: HTMLElement | null = null;
const worldHasFocus = (): boolean => {
  const a = document.activeElement;
  return a === null || a === document.body || a === worldCanvasEl;
};
// The ONE announcer (S1 ships the machine; S5 owns the singleton and pumps it — a live region
// nothing flushes is permanently silent and nothing else reds).
const liveRegion = new LiveRegion();
let lastA11ySnapshot: A11ySnapshot = { topOverlay: null, message: '' };
// M23S5-WORLDFOCUS-END

// m23-s5 fix cycle 2 (ADR-0206 A1 follow-up): the stale-focus discriminator.
// After a close, real Chromium leaves document.activeElement on a node INSIDE the hidden
// overlay for up to ~200 ms (its blur fixup is async, and closeOverlayA11y's explicit
// restore to <body> is a no-op there because <body> carries no tabindex) — so the close
// edge's worldHasFocus() reads a stale anchor and focus never returns to the world.
// Inline `style.display = 'none'` is this repo's ONE hiding idiom — every overlay in both
// shell families hides that way — so the ancestor walk is the exact discriminator, and it
// is engine-independent. `checkVisibility()` was rejected: this happy-dom version does not
// implement it, which would make the unit-tier proof vacuous. The walk cannot match the
// always-on corner affordance (it and every ancestor are display-visible), so the D4
// no-steal guarantee survives — pinned by S5T-FOCUS-NO-STEAL.
const focusInsideHiddenSubtree = (): boolean => {
  for (
    let el: Element | null = document.activeElement;
    el instanceof HTMLElement;
    el = el.parentElement
  ) {
    if (el.style.display === 'none') return true;
  }
  return false;
};

window.addEventListener('keydown', (e) => {
  // M21b-2 (ADR-0182 D17, G20): the session terminal outranks every input path — checked FIRST,
  // before the menu intercept, the battle-Escape branch and the movement-suppression surface.
  // Suppress the native default (not a bare return) so a held arrow does not scroll on key-repeat.
  // biome-ignore format: pinned single-line session gate (main.wiring.test.ts W-M21B2-SESSION-GATE-FIRST).
  if (sessionGateBlocks()) { suppressNativeMovementDefault(e); return; }
  if (e.repeat) {
    // ignore OS key-repeat (the frame loop re-issues held keys) — but still cancel its default
    suppressNativeMovementDefault(e);
    return;
  }
  // m23-s5 fix cycle 2 (ADR-0206 A1b): a press can arrive INSIDE the stale-focus window,
  // before the frame edge has run — heal first, so the twelve gates read the healed state.
  if (focusInsideHiddenSubtree()) worldCanvasEl?.focus();
  // pt-b1 (ADR-0130): F9 downloads the local bug bundle; F8 dismisses the error overlay.
  // Handled EARLY (before letter-key branches) so they work under any overlay.
  if (e.code === 'F9') {
    downloadBugBundle();
    e.preventDefault();
    return;
  }
  if (e.code === 'F8') {
    // Only preventDefault when the overlay is actually visible (non-blocking otherwise).
    if (errorOverlayView?.visible) {
      errorOverlayView.dismiss();
      e.preventDefault();
    }
    return;
  }
  // uxd3 (ADR-0162): while the menu is open it owns the arrow/WASD/Enter keys, so this
  // intercept must precede every movement and hotkey path below. Unrecognised keys fall
  // through to the normal handlers (and then to the movement-suppression block, which
  // keeps nh1's preventDefault). Nav does NOT key-repeat: the e.repeat gate at the top of
  // this listener returns first — accepted, the lists are <= 5 rows and wrap (ADR-0162).
  if (menuView?.visible) {
    const menuInput = menuKeyInput(e.code);
    if (menuInput !== undefined) {
      handleMenuInput(menuInput);
      e.preventDefault();
      return;
    }
  }
  if (e.code === 'KeyB') {
    // uxd3-c (ADR-0164): the 12-term guard list is GONE — one verdict from the registry
    // reproduces it exactly. WHAT THE LIST USED TO SAY IN PLACE, recorded here because the
    // retired W-OVERLAY-FANOUT-MUTEX was its last statement in main.ts (KeyI/KeyE below share
    // this note): modals are GUARDED, NEVER DISMISSED. `canOpen` DENIES over every GUARD_ONLY
    // overlay — dialogue, questLog, heal, shop, trade, pvp, leaderboard, rename, tradePropose,
    // help, menu — and over a live battle (EXCLUSIVE_TOP); the only ids it ever returns in
    // `forceHide` are the box/raising/evolution HIDE_SWITCH siblings this trio legitimately
    // switches between. Silently dismissing a modal on a stray keypress is wrong UX, and for
    // dialogue it is a server desync (ptc5c/ADR-0139). The tier table (ui/overlayRegistry.ts)
    // is now the SSOT for that distinction, exhaustively proved by the OR-CANOPEN-* teeth.
    const boxVerdict = overlayVerdict('boxView');
    if (boxVerdict.kind === 'allow' && (boxView?.visible || worldHasFocus())) {
      for (const id of boxVerdict.forceHide) overlayHandles[id]?.();
      boxView?.toggle();
      if (boxView?.visible) refreshBox();
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyI') {
    // Inventory/raising overlay — the same verdict-driven gate as the box above, whose
    // comment records why modals are guarded rather than dismissed (ptc5c/ADR-0139) and why
    // `forceHide` can only ever name the two hide-switch siblings.
    const raisingVerdict = overlayVerdict('raisingView');
    if (raisingVerdict.kind === 'allow' && (raisingView?.visible || worldHasFocus())) {
      for (const id of raisingVerdict.forceHide) overlayHandles[id]?.();
      raisingView?.toggle();
      if (raisingView?.visible) refreshRaising();
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyE') {
    // Evolution overlay — third member of the hide-switch trio, same verdict-driven
    // gate as box/raising above (see the KeyB comment for the guard-never-dismiss rule).
    const evolutionVerdict = overlayVerdict('evolutionView');
    if (evolutionVerdict.kind === 'allow' && (evolutionView?.visible || worldHasFocus())) {
      for (const id of evolutionVerdict.forceHide) overlayHandles[id]?.();
      evolutionView?.toggle();
      if (evolutionView?.visible) refreshEvolution();
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyQ') {
    // Quest log overlay — mutual exclusivity with all other overlays (M12d, ADR-0071),
    // through the ONE registry verdict since uxd3-c. Self is exempt, so the toggle-close
    // below still works while the quest log itself is open.
    if (
      overlayVerdict('questLogView').kind === 'allow' &&
      (questLogView?.visible || worldHasFocus())
    ) {
      if (questLogView?.visible) {
        questLogView.hide();
      } else {
        openQuestLog();
      }
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyU') {
    // Trade overlay — mutual exclusivity with all other overlays (m15b, ADR-0107).
    // Shows the active offer involving this player; "No active trade" when none.
    if (overlayVerdict('tradeView').kind === 'allow' && (tradeView?.visible || worldHasFocus())) {
      if (tradeView?.visible) {
        tradeView.hide();
      } else {
        openTrade();
      }
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyP') {
    // PvP challenge overlay — mutual exclusivity with all other overlays (m16b, ADR-0110).
    // Not available during an active battle (ADR-0014 exit ordering) — the registry's
    // EXCLUSIVE_TOP tier is what carries that half now.
    if (overlayVerdict('pvpView').kind === 'allow' && (pvpView?.visible || worldHasFocus())) {
      if (pvpView?.visible) {
        pvpView.hide();
      } else {
        openPvp();
      }
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyL') {
    // Leaderboard overlay — mutual exclusivity with all other overlays (m17b, ADR-0120).
    // Renders once on open from store.allProfiles(); the batch listener below keeps
    // it live while visible. Pure subscription view — no write path (RL-15).
    if (
      overlayVerdict('leaderboardView').kind === 'allow' &&
      (leaderboardView?.visible || worldHasFocus())
    ) {
      if (leaderboardView?.visible) {
        leaderboardView.hide();
      } else {
        openLeaderboard();
      }
    }
    e.preventDefault();
    return;
  }
  // pt-c1b (ADR-0133 PTC1B-1): KeyN opens the profile-rename overlay — the first text-input
  // overlay. Mutual exclusion is the ONE registry verdict since uxd3-c (self exempt). On open:
  // held.clear() (RT-RN-01 D3-3) so no held movement key straddles the open/close boundary,
  // render the current name from store.player(identity)?.name (D6), then show (deferred focus).
  // e.preventDefault() (RT-RN-05) stops the opening 'n' from reaching the field.
  if (e.code === 'KeyN') {
    e.preventDefault(); // RT-RN-05: suppress the opening 'n' char reaching the field.
    if (overlayVerdict('renameView').kind === 'allow' && (renameView?.visible || worldHasFocus())) {
      if (renameView?.visible) {
        renameView.hide();
      } else {
        held.clear(); // the opening keypress must not leave a held movement key latched
        openRename();
      }
    }
    return;
  }
  // pt-c2 (ADR-0134 D7): KeyO opens the trade-PROPOSE overlay ("Offer"). Mutual-exclusion
  // is the ONE registry verdict since uxd3-c. identity !== '' (red-team L-1) so we
  // never open before the player is joined. On open: held.clear() so no held movement key
  // straddles the open/close boundary, build+render the lists, then show (deferred focus).
  // e.preventDefault() suppresses any default action for the 'o' key.
  if (e.code === 'KeyO') {
    e.preventDefault();
    if (
      overlayVerdict('tradeProposeView').kind === 'allow' &&
      identity !== '' &&
      (tradeProposeView?.visible || worldHasFocus())
    ) {
      if (tradeProposeView?.visible) {
        tradeProposeView.hide();
      } else {
        held.clear(); // the opening keypress must not leave a held movement key latched
        openPropose();
      }
    }
    return;
  }
  if (e.code === 'KeyT') {
    // INTERACT (uxd2, ADR-0161 D3/D4 — generalizes the M13.5c TALK key):
    // only when NO overlay is visible, resolve the nearest interactable
    // (store.allNpcs() joined to character rows + heal tiles, same zone,
    // Manhattan <= 2 of the own AUTHORITATIVE tile) and dispatch by kind:
    // dialogue/shop share the ONE existing talk-reducer arm (greet-then-shop);
    // heal binds the heal overlay VIEW to the resolved location — no reducer
    // (interact opens UI, it never transacts). The client-side range check is
    // latency hygiene, NOT security — the server re-validates zone + range
    // (npc.rs talk Steps 4-5, TALK_RANGE at npc.rs:20).
    // uxd3-c (ADR-0164): NOT a canOpen() site — interact opens no overlay of its own, so it
    // has no id to exempt and its guard is the plain "nothing is open" predicate, in the same
    // contiguous shape the AC-12 click front door uses.
    if (!anyOverlayVisible() && identity !== '') {
      // uxd3 (ADR-0162): the dispatch body now lives in interactAtNearest() so this hotkey
      // and the menu's Interact leaf share ONE exhaustive switch (ADR-0161's compiler flag).
      interactAtNearest();
    }
    e.preventDefault();
    return;
  }
  // pt-c2b (ADR-0135): `?` toggles the display-only help overlay. Sole e.key branch
  // (help is about the glyph, not physical position). Mutual exclusion is the ONE registry
  // verdict since uxd3-c (self exempt, so the toggle-close survives). held.clear() for consistency
  // (help does not capture focus).
  if (e.key === '?') {
    e.preventDefault();
    if (overlayVerdict('helpView').kind === 'allow' && (helpView?.visible || worldHasFocus())) {
      if (helpView?.visible) {
        helpView.hide();
      } else {
        held.clear();
        openHelp();
      }
    }
    return;
  }
  // uxd3 (ADR-0162): the menu front-door. KeyM was verified UNBOUND before this slice — no
  // KEY_DIR/letter/`?` collision and no browser default. Escape is deliberately NOT overloaded
  // to open the menu: it stays a pure close/back key, so mashing Escape never surprises the
  // player with a menu. This is the 12th open-handler; since uxd3-c its guard is the ONE
  // registry verdict plus `identity !== ''` — menuAvailability() reads
  // store.ownCharacter(identity), which is undefined before join, and this listener has no
  // try/catch. The AC-12 click front door carries the SAME predicate (ADR-0163 D6 closed).
  if (e.code === 'KeyM') {
    e.preventDefault();
    if (
      overlayVerdict('menuView').kind === 'allow' &&
      identity !== '' &&
      (menuView?.visible || worldHasFocus())
    ) {
      if (menuView?.visible) {
        menuView.hide();
      } else {
        held.clear();
        openMenu();
      }
    }
    return;
  }
  // M21b-2 (ADR-0182 D16/D17, AUTH-48): the account/claim front door. carriesIdentity is FALSE on
  // purpose — a failed FIRST sign-in has never joined (identity === ''), and the claim overlay
  // reads store.ownAccount(identity) whose own-identity filter returns undefined for '' (no throw).
  if (e.code === 'KeyC') {
    e.preventDefault();
    if (overlayVerdict('claimView').kind === 'allow' && (claimView?.visible || worldHasFocus())) {
      if (claimView?.visible) {
        claimView.hide();
      } else {
        held.clear();
        openClaim();
      }
    }
    return;
  }
  // pt-c1b (ADR-0133 PTC1B-6): Escape closes the rename overlay. Highest priority so a
  // text-input overlay never traps Escape behind another overlay's branch. The rename
  // input's OWN keydown listener also handles Escape while focused (D3-1, stopPropagation'd);
  // this window-level branch covers the (rare) unfocused-overlay case.
  if (e.code === 'Escape' && renameView?.visible) {
    renameView.hide();
    e.preventDefault();
    return;
  }
  // pt-c2 (ADR-0134 D7): Escape closes the trade-PROPOSE overlay — adjacent to the rename
  // branch so this text/select-input overlay gets highest Escape priority. The currency
  // inputs' own keydown listeners also handle Escape while focused (D6, stopPropagation'd);
  // this window-level branch covers the (rare) unfocused-overlay case.
  if (e.code === 'Escape' && tradeProposeView?.visible) {
    tradeProposeView.hide();
    e.preventDefault();
    return;
  }
  // pt-c2b (ADR-0135): Escape closes the help overlay — adjacent to the sibling Escape branches.
  if (e.code === 'Escape' && helpView?.visible) {
    helpView.hide();
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
    // uxd2 (ADR-0161 D4): Escape CANCELS a pending shop-open (last-intent-wins)
    // — without this, "click Shop, change your mind, Escape" still pops the
    // shop when the dismiss lands.
    pendingShopId = null;
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
        return conn
          ?.live()
          ?.reducers.dismissDialogue({})
          .catch((err: unknown) => {
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
    boundHealLocationId = null; // uxd2: closing unbinds the heal view (ADR-0161 D5)
    healView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && shopView?.visible) {
    boundShopId = null; // uxd2: closing unbinds the shop view (ADR-0161 D5)
    shopView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && tradeView?.visible) {
    tradeView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && pvpView?.visible) {
    pvpView.hide();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && leaderboardView?.visible) {
    leaderboardView.hide();
    e.preventDefault();
    return;
  }
  // rb-52: LAST in the Escape stack on purpose — the first `e.code === 'Escape'` in this file is
  // pinned as the rename branch and three teeth slice fixed windows forward from it.
  if (e.code === 'Escape' && privacyView?.visible) {
    privacyView.hide();
    e.preventDefault();
    return;
  }
  // Suppress movement input while an overlay is open.
  if (anyOverlayVisible()) {
    suppressNativeMovementDefault(e);
    return;
  }
  const dir = KEY_DIR[e.code];
  if (dir !== undefined) {
    // ADR-0187 dualkey-dedup: KEY_DIR binds two codes per dir — a second code while the dir is
    // already held must not fire another ungated first step (pure not-emit; F3 escape intact).
    if (!held.isHeld(dir)) step(dir); // immediate first step (latency + deliberate double-tap)
    held.press(dir, performance.now()); // mark held (stamped) so the frame loop re-issues it once hold-committed (ADR-0158)
    e.preventDefault();
    return;
  }
  if (e.code === 'Space') {
    // m23-s5 (ADR-0206 D5): a focused <button>/<a> OWNS Space (targetOwnsKey, ADR-0146) —
    // jumping here would also cancel its NATIVE activation, leaving the delegated menu badge's
    // front door Enter-only. Same exemption suppressNativeMovementDefault already applies.
    if (!targetOwnsKey(e)) {
      jump(); // Jump does not hold-repeat
      e.preventDefault();
    }
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
  // EG4-8: the same authored-edge set feeds both lists, so a boxed monster and a party
  // monster badge identically (the badge is computed in boxModel's shared toCard).
  const paths = [...store.evolutionPaths()];
  boxView.refresh(
    buildPartyViewModel(monsters, speciesMap, PARTY_SIZE, paths),
    buildBoxViewModel(monsters, speciesMap, PARTY_SLOT_NONE, paths),
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

// --- evolution view: refresh on batch when visible (EG4, ADR-0014/0174) ---------
// MUST be total (never throw): defense-in-depth — store.flushBatch has per-listener
// try/catch since M10.5d, but a throwing function here signals a logic bug.
function refreshEvolution(): void {
  if (!evolutionView?.visible || identity === '') return;
  const monsters = store.ownMonsters(identity);
  const speciesMap = store.speciesMap();
  evolutionView.refresh(buildEvolutionViewModel(monsters, speciesMap, [...store.evolutionPaths()]));
}
store.onBatchApplied(() => refreshEvolution());

// --- battle view: refresh on batch, auto-show/hide (M7c, ADR-0014/0042) --------
function refreshBattle(): void {
  if (!battleView || identity === '') return;
  // 11r-b (ADR-0167 D2): the ONE view-perspective projection in the client — it re-seats
  // the local player as sideA so a PvP accepter (stored in opponentIdentity) gets their
  // OWN cards/skills/bench from a view layer that hardcodes sideA = the local player.
  // Every OTHER read of these accessors (diagnostics, observability) stays RAW by design.
  const latest = ownPerspective(store.latestPlayerBattle(identity), identity);
  const r = decideBattleOverlay(latest, { dismissedBattleId, synced: battleSynced });
  dismissedBattleId = r.dismissedBattleId;
  battleSynced = r.synced;
  if (r.action.kind === 'show') {
    // uxd3-c (ADR-0164): the eight hand-written `if (X?.visible) X.hide();` lines are gone —
    // BATTLE_FORCE_HIDE (ui/overlayRegistry.ts) now DRIVES the loop, so the manifest and the
    // code cannot drift apart (they used to be two independently-authored lists kept in sync
    // only by a test). Same ids, same order, same behaviour: help, box, raising, evolution,
    // leaderboard, rename, tradePropose, menu — and NOT dialogue/shop/trade/pvp/questLog/heal,
    // which a battle auto-show leaves standing exactly as before. Deliberately NOT canOpen():
    // a battle auto-show is server truth and must fire even over a GUARD_ONLY overlay that
    // would deny it.
    // UXD3C-BATTLEHIDE-BEGIN
    for (const id of hideAllExceptPlan('battleView', visibleIds(overlayProbes))) {
      overlayHandles[id]?.();
    }
    // UXD3C-BATTLEHIDE-END
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
    // m16b: clear pvpPendingTurnNumber when the server has resolved the turn (turnNumber
    // advanced past the pending value) OR when the battle is no longer Ongoing (terminal
    // outcomes include forfeit — apply_pvp_forfeit skips advance_turn so turnNumber stays
    // at N; the strict > condition would never fire; check outcome as the fallback).
    if (
      pvpPendingTurnNumber !== null &&
      (r.action.battle.turnNumber > pvpPendingTurnNumber || r.action.battle.outcome !== 'Ongoing')
    ) {
      pvpPendingTurnNumber = null;
    }
    const pvpPendingSubmit = pvpPendingTurnNumber !== null;
    // Resolve opponent name for PvP label: find the player row whose identity is not ours.
    const pvpOpponentIdentity = r.action.battle.opponentIdentity;
    const pvpOpponentName =
      pvpOpponentIdentity !== r.action.battle.playerIdentity
        ? (store.allPlayers().find((p) => p.identity === pvpOpponentIdentity)?.name ?? null)
        : null;
    const vm = buildBattleViewModel(
      r.action.battle,
      store.skillMap(),
      store.speciesMap(),
      baitItems,
      cureItems,
      pvpPendingSubmit,
      pvpOpponentName,
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
    // uxd3 (ADR-0162): a server-pushed conversation preempts the menu. Guarded on conv so
    // this per-batch listener cannot close a just-opened menu on the very next batch.
    if (conv !== undefined && menuView?.visible) menuView?.hide();
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
    if (!conv) {
      dismissPending = false;
      // UXD2-SHOPOPEN-BEGIN (ADR-0161 D4): the deferred greet-then-shop open.
      // Consume-and-clear ATOMICALLY (read to a local, null the module var
      // first), then open ONLY if no overlay is visible at consumption time —
      // a battle that popped during the dismiss round-trip drops the pending
      // open silently rather than stacking two overlays.
      if (pendingShopId !== null) {
        const openShopId = pendingShopId;
        pendingShopId = null;
        if (!anyOverlayVisible()) {
          boundShopId = openShopId;
          shopView?.render(
            buildShopViewModelForShop(
              openShopId,
              store.allShops(),
              store.allShopItems(),
              store.itemDefs(),
              store.ownInventory(identity),
              store.ownWallet(identity),
            ),
          );
          shopView?.show();
        }
      }
      // UXD2-SHOPOPEN-END
    }
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
  // Heal overlay is user-opened (KeyT on a heal tile); only refresh when
  // already open (ADR-0014 pattern). uxd2 (ADR-0161 D5): while bound, refresh
  // through the SAME bound-location selector the open used — never let a
  // batch silently widen a bound view to the all-locations default.
  if (!healView?.visible) return;
  try {
    const itemDefs = store.itemDefs();
    healView.render(
      boundHealLocationId !== null
        ? buildHealViewModelForLocation(boundHealLocationId, store.healLocations(), itemDefs)
        : buildHealViewModel(store.healLocations(), itemDefs),
    );
  } catch (err) {
    console.error('[M12d] heal batch listener error', err);
  }
});

// --- M13d: shop view batch listener (ADR-0084) -----------------------------------
// MUST be total (never throw): defense-in-depth (store.flushBatch has per-listener try/catch since M10.5d).
store.onBatchApplied(() => {
  if (!shopView?.visible || identity === '') return;
  try {
    // uxd2 (ADR-0161 D5): while bound to a shopkeeper's shop, refresh through
    // the bound-shop selector — a batch must never silently swap the visible
    // catalogue to the first-shop default. Unbound (defensive: the overlay now
    // only opens bound) keeps the pre-uxd2 default path unchanged.
    shopView.render(
      boundShopId !== null
        ? buildShopViewModelForShop(
            boundShopId,
            store.allShops(),
            store.allShopItems(),
            store.itemDefs(),
            store.ownInventory(identity),
            store.ownWallet(identity),
          )
        : buildShopViewModel(
            store.allShops(),
            store.allShopItems(),
            store.itemDefs(),
            store.ownInventory(identity),
            store.ownWallet(identity),
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

// --- m16b: PvP challenge overlay batch listener (ADR-0110) -----------------------
// Auto-shows the overlay when an incoming challenge arrives; refreshes when already
// open (status/list changes). MUST be total (never throw): defense-in-depth.
store.onBatchApplied(() => {
  if (identity === '') return;
  try {
    const vm = buildPvpChallengeViewModel(store.allChallenges(), identity, store.allPlayers());
    // Auto-show on incoming challenge ONLY when no other overlay is visible — never
    // pop the PvP overlay over an active battle or another overlay (mutual-exclusivity).
    // Always preserve a manually-opened overlay (pvpView.visible) regardless.
    const anyOverlayVisible = anyVisible(overlayProbes, 'pvpView');
    const forceVisible =
      !anyOverlayVisible && (vm.incoming !== null || (pvpView?.visible ?? false));
    pvpView?.refresh(vm, forceVisible);
  } catch (err) {
    console.error('[m16b] pvpView batch listener error', err);
  }
});

// --- m17b: leaderboard batch listener (ADR-0120) -----------------------------------
// Refresh-only-when-visible (ADR-0014 pattern): ratings/W/L stay live while the
// board is open as profile rows update. MUST be total (never throw): defense-in-depth
// (store.flushBatch has per-listener try/catch since M10.5d).
store.onBatchApplied(() => {
  if (!leaderboardView?.visible || identity === '') return;
  try {
    leaderboardView.render(buildLeaderboardViewModel(store.allProfiles(), identity));
  } catch (err) {
    console.error('[m17b] leaderboard batch listener error', err);
  }
});

// --- pt-b1 (ADR-0130): battleStart / battleEnd emit listener -----------------------
// Dedicated batch listener (UNCONDITIONAL — not visibility-gated). battleEnd only fires
// for a battle we saw START (activeBattleId latch): a battle first-seen already terminal
// has activeBattleId !== its id, so neither branch fires — guarding a stale-terminal login.
store.onBatchApplied(() => {
  if (identity === '') return;
  try {
    const latest = store.latestPlayerBattle(identity);
    // red-team M-1 + 16r-f + 17r-b: re-baseline ONLY the battle that survived the drop, without
    // emitting. The latch resolves on the first flush AFTER hydration-complete (ADR-0130
    // residual d): a pre-hydration flush — empty OR carrying an older surviving row — must not
    // burn it. Post-hydration an undefined read is definitive (no battle rows) and resolves it.
    if (battleReseedPending) {
      if (!hydratedSinceReconnect) return;
      battleReseedPending = false;
      const survivedId = reseedPrevBattleId;
      reseedPrevBattleId = null;
      if (latest?.outcome === 'Ongoing' && latest.battleId === survivedId) {
        activeBattleId = latest.battleId;
        return;
      }
    }
    if (!latest) return;
    // reviewer H-1: wild battles carry the all-zero WILD_IDENTITY (!== player) but no owned
    // opponent party — identity-inequality alone mislabels them PvP. Use the party-guarded rule.
    const isPvp = isPvpBattle(latest);
    if (latest.outcome === 'Ongoing' && latest.battleId !== activeBattleId) {
      activeBattleId = latest.battleId;
      eventRing.push(makeBattleStart(latest.battleId.toString(), isPvp));
    } else if (latest.outcome !== 'Ongoing' && activeBattleId === latest.battleId) {
      activeBattleId = null;
      // 11r-b (ADR-0167 D3): `outcome` here is the SERVER-side tag — SideA is always the
      // challenger — and is deliberately NOT perspective-mapped, so a PvP accepter's ring
      // records SideAWins for their own loss. That is intentional: two players' event rings
      // and bug bundles must agree on who won. Do not "fix" this to the local perspective.
      eventRing.push(makeBattleEnd(latest.battleId.toString(), latest.outcome, latest.turnNumber));
    }
  } catch (err) {
    console.error('[obs] battle', err);
  }
});

// --- pt-b1 (ADR-0130): rankedMatch emit listener -----------------------------------
// Dedicated batch listener (its OWN, not folded into the visibility-gated leaderboard
// listener above). Baselines lastOwnRating on first sight, then emits a delta event on
// each rating change with the current battle id (or '' if none).
store.onBatchApplied(() => {
  if (identity === '') return;
  try {
    const prof = store.profile(identity);
    if (!prof) return;
    if (lastOwnRating === null) {
      lastOwnRating = prof.rating;
      return;
    }
    if (prof.rating !== lastOwnRating) {
      const delta = prof.rating - lastOwnRating;
      lastOwnRating = prof.rating;
      // red-team M-2: latestPlayerBattle() returns the highest-id battle of ANY kind, which
      // may be a wild encounter — attach the id ONLY if it is genuinely a PvP battle, else ''
      // (a wrong battleId corrupts the H3 correlation; the delta is the load-bearing signal).
      const b = store.latestPlayerBattle(identity);
      const battleId = b && isPvpBattle(b) ? b.battleId.toString() : '';
      eventRing.push(makeRankedMatch(battleId, delta));
    }
  } catch (err) {
    console.error('[obs] ranked', err);
  }
});

// --- M12d: dialogue choice click handler -----------------------------------------
// Reads data-choice-idx from the clicked button and calls advance_dialogue.
document.addEventListener('click', (e) => {
  // UXD2-SHOPBTN-BEGIN (ADR-0161 D4): the greet-then-shop button. It carries
  // data-shop-id and NO choice index, so it gets its own branch ABOVE the
  // choice delegation. Record the pending open ALWAYS (last-intent-wins), then
  // end the conversation via dismissDialogue under the dismissPending in-flight
  // guard (C6 discipline, mirroring the Escape-dismiss branch) — the shop open
  // itself is DEFERRED to the dialogue batch listener's no-conversation arm.
  const shopBtn = (e.target as HTMLElement).closest('[data-shop-id]') as HTMLElement | null;
  if (shopBtn !== null) {
    const clickedShopId = Number(shopBtn.dataset.shopId);
    if (!Number.isNaN(clickedShopId)) {
      pendingShopId = clickedShopId;
      if (!dismissPending) {
        sendGuarded('dismiss', () => {
          dismissPending = true;
          return conn
            ?.live()
            ?.reducers.dismissDialogue({})
            .catch((err: unknown) => {
              dismissPending = false;
              pendingShopId = null;
              throw err;
            });
        });
      }
    }
    return;
  }
  // UXD2-SHOPBTN-END
  // UXD3B-LAUNCHER-BEGIN
  // uxd3-b (ADR-0163, AC-12): the click front door. Delegated on the data-attribute, the
  // house idiom in this listener — so main.ts still never NAMES the badge and acquires no
  // reference to it (W-UX1-HINT-NO-JS-OWNER stays green verbatim; ADR-0151 D2's "no owner
  // that can hide or remove it" survives).
  // uxd3-c (ADR-0164, closing ADR-0163 D6): the two front doors are UNIFIED — this branch now
  // carries the SAME predicate the menu hotkey does, so a single verdict decides both. The one
  // difference from the retired `!anyOverlayVisible()` form, stated rather than glossed:
  // canOpen exempts self, so with ONLY the menu visible this branch would re-open (resetting
  // menuState) where it previously dead-clicked. Unreachable in practice — #menu-overlay is
  // position:fixed;inset:0;z-index:100 over the badge's z-index:50, so a click while the menu
  // is open never reaches the badge and closest() returns null. The identity guard is
  // preserved: menuAvailability() reads store.ownCharacter(identity) and this listener has no
  // try/catch.
  if ((e.target as HTMLElement).closest('[data-menu-launcher]') !== null) {
    if (overlayVerdict('menuView').kind === 'allow' && identity !== '') {
      held.clear();
      openMenu();
    }
    return;
  }
  // UXD3B-LAUNCHER-END
  const btn = (e.target as HTMLElement).closest('[data-choice-idx]') as HTMLElement | null;
  if (!btn) return;
  const raw = btn.dataset.choiceIdx;
  if (raw === undefined) return;
  const choiceIdx = parseInt(raw, 10);
  if (!Number.isNaN(choiceIdx)) {
    sendGuarded('advance', () => conn?.live()?.reducers.advanceDialogue({ choiceIdx }));
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
    moveSendCount,
    moveRejectCount,
    characters: [...store.characters()].map((c) => ({
      entityId: c.row.entityId.toString(),
      tileX: c.row.tileX,
      tileY: c.row.tileY,
      facing: c.row.facing,
      action: c.row.action,
    })),
    monsterCount: store.monsterCount,
    battleCount: store.battleCount,
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

// m16.5d: test hook exposing trade reducers + subscription queries for two-context e2e.
// Mirrors window.__game pattern. All BigInt values cross the page.evaluate boundary as
// strings; the hook converts them back to BigInt internally (BigInt cannot pass the
// structured-clone boundary used by Playwright evaluate).
//
// NOTE: this hook's shape is re-declared as MrTrade in client/e2e/trade-full.spec.ts.
// Both must be kept in sync manually — page.evaluate() crosses a structured-clone
// boundary that the type system cannot check across. See that file if you change any
// method signature or return shape here.
//
// NOTE (D-17.5-E, ADR-0127 — amends ADR-0115 D1): __game, __mrTrade, and __mrPvp are
// DEV-gated — the window assignments live inside `if (import.meta.env.DEV)` below, so
// production builds drop them. The guarantee is the minifier's dead-branch elimination
// after Vite's define-replacement of import.meta.env.DEV (NOT Rollup tree-shaking): a
// `vite build --minify false` bundle would retain the dead branch. Server-side identity
// authz still prevents privilege escalation (callers can only act as themselves).
const mrTradeHook = {
  proposeTrade(args: {
    counterparty: string;
    initiatorMonsterIds: string[];
    initiatorItems: { itemId: number; qty: number }[];
    initiatorCurrency: string;
    counterpartyMonsterIds: string[];
    counterpartyItems: { itemId: number; qty: number }[];
    counterpartyCurrency: string;
  }): Promise<void> | undefined {
    return conn?.live()?.reducers.proposeTrade({
      counterparty: new Identity(args.counterparty),
      initiatorMonsterIds: args.initiatorMonsterIds.map(BigInt),
      initiatorItems: args.initiatorItems,
      initiatorCurrency: BigInt(args.initiatorCurrency),
      counterpartyMonsterIds: args.counterpartyMonsterIds.map(BigInt),
      counterpartyItems: args.counterpartyItems,
      counterpartyCurrency: BigInt(args.counterpartyCurrency),
    });
  },
  respondTrade(tradeId: string, accepted: boolean): Promise<void> | undefined {
    return conn?.live()?.reducers.respondTrade({ tradeId: BigInt(tradeId), accepted });
  },
  confirmTrade(tradeId: string): Promise<void> | undefined {
    return conn?.live()?.reducers.confirmTrade({ tradeId: BigInt(tradeId) });
  },
  cancelTrade(tradeId: string): Promise<void> | undefined {
    return conn?.live()?.reducers.cancelTrade({ tradeId: BigInt(tradeId) });
  },
  allTradeOffers(): Array<{
    tradeId: string;
    initiator: string;
    counterparty: string;
    status: string;
  }> {
    return store.allTradeOffers().map((o) => ({
      tradeId: o.tradeId.toString(),
      initiator: o.initiator,
      counterparty: o.counterparty,
      status: o.status,
    }));
  },
  allPlayers(): Array<{ identity: string; name: string }> {
    return store.allPlayers().map((p) => ({ identity: p.identity, name: p.name }));
  },
};

// m17.5f: test hook exposing PvP challenge/battle reducers + subscription reads for
// two-context e2e. Mirrors window.__mrTrade. All BigInt values cross the page.evaluate
// boundary as strings; the hook converts them back to BigInt internally (BigInt cannot
// pass the structured-clone boundary used by Playwright evaluate).
//
// NOTE: this hook's shape is re-declared as MrPvp in client/e2e/pvp-full.spec.ts.
// Both must be kept in sync manually — page.evaluate() crosses a structured-clone
// boundary that the type system cannot check across. See that file if you change any
// method signature or return shape here.
//
// NOTE: like __game and __mrTrade, this hook is DEV-gated (ADR-0127, amends ADR-0115
// D1) — the window assignment below only exists when import.meta.env.DEV is true, and
// the dead branch is dropped by the minifier in a default `vite build` (a
// `--minify false` build would retain it; server-side ctx.sender authz still holds).
const mrPvpHook = {
  challengePvp(targetHex: string, partyIds: string[]): Promise<void> | undefined {
    return conn?.live()?.reducers.challengePvp({
      target: new Identity(targetHex),
      partyIds: partyIds.map(BigInt),
    });
  },
  acceptChallenge(challengeId: string, partyIds: string[]): Promise<void> | undefined {
    return conn?.live()?.reducers.acceptChallenge({
      challengeId: BigInt(challengeId),
      partyIds: partyIds.map(BigInt),
    });
  },
  declineChallenge(challengeId: string): Promise<void> | undefined {
    return conn?.live()?.reducers.declineChallenge({ challengeId: BigInt(challengeId) });
  },
  cancelChallenge(challengeId: string): Promise<void> | undefined {
    return conn?.live()?.reducers.cancelChallenge({ challengeId: BigInt(challengeId) });
  },
  submitPvpAction(
    battleId: string,
    action: { tag: string; value: number },
  ): Promise<void> | undefined {
    // The structured-clone boundary erases the PvpAction union type; the cast restores
    // it. An unknown tag would fail BSATN encode/server decode — never a silent no-op.
    return conn?.live()?.reducers.submitPvpAction({
      battleId: BigInt(battleId),
      action: action as PvpAction,
    });
  },
  allChallenges(): Array<{
    challengeId: string;
    challenger: string;
    target: string;
    status: string;
  }> {
    return store.allChallenges().map((c) => ({
      challengeId: c.challengeId.toString(),
      challenger: c.challenger,
      target: c.target,
      status: c.status,
    }));
  },
  allPlayers(): Array<{ identity: string; name: string }> {
    return store.allPlayers().map((p) => ({ identity: p.identity, name: p.name }));
  },
  // BOTH-SIDES battle read: store.battle(id) hits the by-id map directly and exposes BOTH
  // sides' internals to a test driver — which the production path deliberately never does
  // (it reads only the local player's own row, via the either-role accessors, and sees the
  // opponent only through the view model). Returns null when the battle is absent (not yet
  // arrived or GC'd). activeSkillIds are the ACTIVE monster's known skill ids for each
  // side, so either page can pick a legal skill for its role.
  // An EMPTY activeSkillIds array means the side's active index was out of bounds —
  // an abnormal server state; callers must not submit an action built from it.
  battleById(battleId: string): {
    battleId: string;
    outcome: string;
    turnNumber: number;
    sideA: { active: number; activeSkillIds: number[] };
    sideB: { active: number; activeSkillIds: number[] };
  } | null {
    const b = store.battle(BigInt(battleId));
    if (!b) return null;
    return {
      battleId: b.battleId.toString(),
      outcome: b.outcome,
      turnNumber: b.turnNumber,
      sideA: {
        active: b.sideA.active,
        activeSkillIds: [...(b.sideA.team[b.sideA.active]?.knownSkillIds ?? [])],
      },
      sideB: {
        active: b.sideB.active,
        activeSkillIds: [...(b.sideB.team[b.sideB.active]?.knownSkillIds ?? [])],
      },
    };
  },
};

// D-17.5-E (ADR-0127): DEV-only test hooks. Only the window ASSIGNMENTS are gated —
// the hook consts above stay top-level (still referenced here, so no unused-var lint).
if (import.meta.env.DEV) {
  (window as unknown as { __game: typeof snapshot }).__game = snapshot;
  (window as unknown as { __mrTrade: typeof mrTradeHook }).__mrTrade = mrTradeHook;
  (window as unknown as { __mrPvp: typeof mrPvpHook }).__mrPvp = mrPvpHook;
}

// pt-a1 (ADR-0128): the build stamp is UNGATED — present in the production playtest build,
// the deliberate contrast with the DEV-gated debug hooks above. The M-playtest-b F9
// bug-report bundle reads window.__mrBuild to pin which build a finding came from; it carries
// only non-secret build metadata (short sha + timestamp), so there is no leak/authz concern.
(window as unknown as { __mrBuild: typeof BUILD_INFO }).__mrBuild = BUILD_INFO;

// F9-BUNDLE-BEGIN (pt-b1, ADR-0130): client-only bug bundle — NO network (works when the connection is the bug).
/** Project the store into the no-PII KeyStoreSnapshot — reads only ids/counts, never a name. */
function projectKeyStore(): KeyStoreSnapshot {
  const prof = identity !== '' ? store.profile(identity) : undefined;
  return {
    playerCount: store.playerCount,
    ownEntityId: identity !== '' ? (store.ownEntityId(identity)?.toString() ?? null) : null,
    currentZoneId: rawMap.zone_id,
    ongoingBattleId: (() => {
      const b = identity !== '' ? store.ongoingBattle(identity) : undefined;
      return b ? b.battleId.toString() : null;
    })(),
    ownRating: prof?.rating ?? null,
    ownWins: prof?.wins ?? null,
    ownLosses: prof?.losses ?? null,
    ownMonsterCount: identity !== '' ? store.ownMonsters(identity).length : 0,
    inventoryCount: identity !== '' ? store.ownInventory(identity).length : 0,
  };
}
function downloadBugBundle(): void {
  // reviewer L-1: one timestamp for both the bundle body and the filename (they must match).
  const capturedAtMs = Date.now();
  const bundle = buildBugBundle({
    build: BUILD_INFO,
    identity,
    zoneId: rawMap.zone_id,
    capturedAtMs,
    events: eventRing.snapshot(),
    errors: errorRing.snapshot(),
    store: projectKeyStore(),
  });
  // red-team L-1: serialize INSIDE the try so a (bigint-total, but defense-in-depth) serialize
  // fault also routes to the console fallback rather than escaping the keydown handler.
  let json = '';
  try {
    json = serializeBugBundle(bundle);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = bugBundleFilename(BUILD_INFO.sha, capturedAtMs);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // CSP/sandbox/serialize fallback: never silently no-op. Log whatever we have.
    console.log('[bug-bundle]', json || bundle);
    reportError('bug bundle: download blocked — copy from console');
  }
}
// F9-BUNDLE-END

async function main(): Promise<void> {
  // pt-a1 (ADR-0128): surface the build stamp in the non-intrusive corner element (#build-stamp
  // in index.html). BUILD_INFO is ungated, so this shows in the production playtest build too.
  const buildStampEl = document.getElementById('build-stamp');
  if (buildStampEl !== null) buildStampEl.textContent = formatBuildStamp(BUILD_INFO);

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
    { PvpView: PvpViewClass },
    { LeaderboardView: LeaderboardViewClass },
    { RenameView: RenameViewClass },
    { TradeProposeView: TradeProposeViewClass },
    { HelpView: HelpViewClass },
    { MenuView: MenuViewClass },
    { ClaimView: ClaimViewClass },
    { SessionView: SessionViewClass },
    { PrivacyView: PrivacyViewClass },
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
    import('./ui/pvpView'),
    import('./ui/leaderboardView'),
    import('./ui/renameView'),
    import('./ui/tradeProposeView'),
    import('./ui/helpView'),
    import('./ui/menuView'),
    import('./ui/claimView'),
    import('./ui/sessionView'),
    import('./ui/privacyView'),
  ]);
  renderer = new WorldRenderer();
  const mount = document.getElementById('app');
  if (mount !== null) {
    await renderer.init(mount, rawMap);
    // M23S5-CANVASREF-BEGIN
    // m23-s5 (ADR-0206 D1): render/world.ts appends app.canvas to this same mount and puts
    // role="application"/tabindex="0" on it (m23-s4). It is out of this slice's touches:, so a
    // querySelector on the mount main.ts already holds is the only in-touches route.
    worldCanvasEl = mount.querySelector('canvas');
    // M23S5-CANVASREF-END
    installResizeHandler(renderer, window); // fit the stage to the window + on resize
    boxView = new BoxViewClass(mount, {
      onSetNickname: (monsterId, nickname) => {
        sendGuarded('nickname', () => conn?.live()?.reducers.setNickname({ monsterId, nickname }));
      },
      onSetPartySlot: (monsterId, slot) => {
        const finalSlot =
          slot === -1
            ? (nextFreePartySlot(store.ownMonsters(identity), PARTY_SIZE) ?? PARTY_SLOT_NONE)
            : slot;
        sendGuarded('party', () =>
          conn?.live()?.reducers.setPartySlot({ monsterId, slot: finalSlot }),
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
          sendGuarded('heal', () => conn?.live()?.reducers.healParty({ locationId }));
        }
      },
    });
    battleView = new BattleViewClass(mount, {
      onAttack: (battleId, skillId) => {
        sendGuarded('attack', () => conn?.live()?.reducers.submitAttack({ battleId, skillId }));
      },
      onFlee: (battleId) => {
        sendGuarded('flee', () => conn?.live()?.reducers.flee({ battleId }));
      },
      onSwap: (battleId, teamIndex) => {
        sendGuarded('swap', () => conn?.live()?.reducers.swapActive({ battleId, teamIndex }));
      },
      onRecruit: (battleId, baitItemId) => {
        sendGuarded('recruit', () =>
          conn?.live()?.reducers.attemptRecruit({ battleId, baitItemId }),
        );
      },
      onUseItem: (battleId, itemId) => {
        sendGuarded('use-item', () => conn?.live()?.reducers.useBattleItem({ battleId, itemId }));
      },
      // m16b: PvP action submission. pvpPendingTurnNumber is set INSIDE the lambda
      // so sendGuarded's frozen-check runs first — a frozen-link click must not
      // lock pvpPendingSubmit permanently (the turn never advances on a dropped send).
      // Cleared on rejection (mirroring dismissPending pattern from dialogue dismiss).
      onPvpAttack: (battleId, skillId) => {
        sendGuarded('pvp-attack', () => {
          pvpPendingTurnNumber = store.latestPlayerBattle(identity)?.turnNumber ?? null;
          // 15r-sec-a: refresh explicitly — the pending flag is client-local, and
          // since ADR-0198 D5 an unchanged battle row no longer re-notifies the
          // batch (the old banner render piggybacked on that spurious notify).
          refreshBattle();
          return conn
            ?.live()
            ?.reducers.submitPvpAction({ battleId, action: { tag: 'Attack', value: skillId } })
            ?.catch((err: unknown) => {
              pvpPendingTurnNumber = null;
              refreshBattle();
              throw err;
            });
        });
      },
      onPvpSwap: (battleId, teamIndex) => {
        sendGuarded('pvp-swap', () => {
          pvpPendingTurnNumber = store.latestPlayerBattle(identity)?.turnNumber ?? null;
          // 15r-sec-a: same explicit refresh as onPvpAttack above (ADR-0198 D5).
          refreshBattle();
          return conn
            ?.live()
            ?.reducers.submitPvpAction({ battleId, action: { tag: 'Swap', value: teamIndex } })
            ?.catch((err: unknown) => {
              pvpPendingTurnNumber = null;
              refreshBattle();
              throw err;
            });
        });
      },
    });
    raisingView = new RaisingViewClass(mount, {
      onTrain: (monsterId, foodItemId) => {
        sendGuarded('train', () => conn?.live()?.reducers.train({ monsterId, foodItemId }));
      },
      // ADR-0159 D1: care used to run through sendGuarded, which attaches ONLY a
      // .catch — a successful care was acknowledged by nothing, and the rejection
      // it did raise went to statusEl, which this overlay paints over. The whole
      // decision (frozen gate / await / exactly-one message) now lives in the
      // tested performCare core; this closure is the adapter that binds the real
      // connection and the real overlay to it. Returned (not `void`ed) so the
      // view's #pending lock stays held until the reducer promise settles.
      onCare: (monsterId) =>
        performCare({
          // ADR-0085 A1 frozen gate (onBuy/onSell shape): a call against a dead
          // conn is silently queued and never settles — report `undefined` so
          // performCare shows the disconnected line instead of hanging.
          callCare: () =>
            conn === undefined || conn.linkFrozen()
              ? undefined
              : conn.live()?.reducers.care({ monsterId }),
          // Visibility gate (onBuy/onSell idiom): KeyB/KeyE call
          // raisingView.hide() unconditionally, which clears the feedback
          // line. Without this check a care that settles after the overlay
          // was force-hidden writes a stale message the player then sees on
          // the NEXT open, with no click behind it.
          showFeedback: (message) => {
            if (raisingView?.visible) raisingView.showFeedback(message);
          },
        }),
    });
    evolutionView = new EvolutionViewClass(mount, {
      // EG4-3: the CHOSEN species is forwarded from the panel's path picker. The client
      // never resolves an ambiguous evolution itself (EG4-2) — the player picks, and the
      // server re-validates the same gates before applying.
      onEvolve: (monsterId, toSpecies) => {
        sendGuarded('evolve', () => conn?.live()?.reducers.evolve({ monsterId, toSpecies }));
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
          await conn.live()?.reducers.buy({ shopId, itemId, qty: SHOP_QTY });
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
          await conn.live()?.reducers.sell({ itemId, qty: SHOP_QTY });
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
          await conn.live()?.reducers.respondTrade({ tradeId, accepted: true });
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
          await conn.live()?.reducers.respondTrade({ tradeId, accepted: false });
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
          await conn.live()?.reducers.confirmTrade({ tradeId });
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
          await conn.live()?.reducers.cancelTrade({ tradeId });
          if (tradeView?.visible) tradeView.showFeedback('Trade cancelled.');
        } catch (err) {
          if (tradeView?.visible) tradeView.showFeedback(reduceErrorMessage(err, 'cancel-trade'));
        }
      },
    });
    // m16b: PvP challenge overlay (ADR-0110).
    // All action reducers use sendGuarded so a dead link is rejected loudly.
    pvpView = new PvpViewClass({
      onChallenge: (targetIdentity) => {
        const partyIds = store
          .ownMonsters(identity)
          .filter((m) => m.partySlot !== PARTY_SLOT_NONE)
          .map((m) => m.monsterId);
        sendGuarded('pvp-challenge', () =>
          conn?.live()?.reducers.challengePvp({ target: new Identity(targetIdentity), partyIds }),
        );
      },
      onAccept: (challengeId) => {
        const partyIds = store
          .ownMonsters(identity)
          .filter((m) => m.partySlot !== PARTY_SLOT_NONE)
          .map((m) => m.monsterId);
        sendGuarded('pvp-accept', () =>
          conn?.live()?.reducers.acceptChallenge({ challengeId, partyIds }),
        );
      },
      onDecline: (challengeId) => {
        sendGuarded('pvp-decline', () => conn?.live()?.reducers.declineChallenge({ challengeId }));
      },
      onCancel: (challengeId) => {
        sendGuarded('pvp-cancel', () => conn?.live()?.reducers.cancelChallenge({ challengeId }));
      },
    });
    // m17b: leaderboard DOM shell (ADR-0120). ZERO-arg construction — RL-15: the
    // leaderboard is a pure subscription view; there is no client write path to profile.
    leaderboardView = new LeaderboardViewClass();
    // pt-c2b (ADR-0135): display-only help overlay — ZERO-arg construction (no callbacks,
    // leaderboardView precedent). Opened by `?`; content is a static SSOT const.
    helpView = new HelpViewClass();
    // uxd3 (ADR-0162): the menu forwards every input to the pure menuStep reducer; it
    // decides nothing itself (ADR-0014 functional core / imperative shell).
    menuView = new MenuViewClass({ onInput: handleMenuInput });
    // M21b-2 (ADR-0182 D16): the guest-claim overlay. Its actions drive the pure claimModel;
    // the AUTHORITATIVE join veto lives in connection.ts's onApplied (G18), so these are UI-only.
    const claimHandlers: ClaimViewHandlers = {
      onSignIn: () => {
        conn?.startSignIn();
      },
      onJoin: () =>
        applyClaim({
          kind: 'join-requested',
          hasLiveConnection: conn !== undefined && !conn.linkFrozen(),
        }),
      onDeclineRequested: () => applyClaim({ kind: 'decline-requested' }),
      onDeclineConfirmed: () =>
        applyClaim({
          kind: 'decline-confirmed',
          hasLiveConnection: conn !== undefined && !conn.linkFrozen(),
        }),
      onDeclineCancelled: () => applyClaim({ kind: 'decline-cancelled' }),
      onPrivacy: () => openPrivacy(),
    };
    claimView = new ClaimViewClass(claimHandlers);
    const privacyHandlers: PrivacyViewHandlers = {
      onDeleteRequested: () => applyPrivacy({ kind: 'delete-requested' }),
      onDeleteConfirmed: () =>
        applyPrivacy({ kind: 'delete-confirmed', hasLiveConnection: privacyLinkLive() }),
      onConfirmCancelled: () => applyPrivacy({ kind: 'confirm-cancelled' }),
      onCancelDeletion: () =>
        applyPrivacy({ kind: 'cancel-deletion-requested', hasLiveConnection: privacyLinkLive() }),
      onExportRequested: () =>
        applyPrivacy({ kind: 'export-requested', hasLiveConnection: privacyLinkLive() }),
      onDismissed: () => {
        applyPrivacy({ kind: 'confirm-cancelled' });
        // Flush a claim paint deferred while this overlay owned the screen.
        if (claimRenderPending) renderClaim();
      },
    };
    privacyView = new PrivacyViewClass(privacyHandlers);
    // M21b-2 (ADR-0182 D17): the session-lifecycle overlay (registry-external). Its actions drive
    // the pure sessionModel; a confirmed continue-anonymously routes to conn.continueAnonymously().
    const sessionHandlers: SessionViewHandlers = {
      onContinueRequested: () => applySession({ kind: 'continue-anonymously-requested' }),
      onContinueConfirmed: () =>
        applySession({
          kind: 'continue-anonymously-confirmed',
          hasLiveConnection: conn !== undefined && !conn.linkFrozen(),
        }),
      onConfirmCancelled: () => applySession({ kind: 'confirm-cancelled' }),
      onRetry: () =>
        applySession({
          kind: 'retry-requested',
          hasLiveConnection: conn !== undefined && !conn.linkFrozen(),
        }),
    };
    sessionView = new SessionViewClass(sessionHandlers);
    // pt-c1b (ADR-0133): rename overlay. onSubmit calls set_profile_name (ADR-0132) with the
    // frozen-link gate FIRST (ADR-0085 A1) — never send on a dead link. Feedback goes into
    // #rename-feedback via reduceErrorMessage on reject (no InternalError leak, PTC1B-4);
    // shop/trade feedback pattern, NOT sendGuarded/reportError. The overlay stays open on
    // both success and reject; the view's #pending lock is reset by its own .finally().
    renameView = new RenameViewClass({
      onSubmit: async (name) => {
        if (conn === undefined || conn.linkFrozen()) {
          if (renameView?.visible) renameView.showFeedback('disconnected — try again');
          return;
        }
        try {
          await conn.live()?.reducers.setProfileName({ name });
          if (renameView?.visible) renameView.showFeedback('Name updated!');
        } catch (err) {
          if (renameView?.visible) {
            renameView.showFeedback(reduceErrorMessage(err, 'set-profile-name'));
          }
        }
      },
    });
    // pt-c2 (ADR-0134 D4): trade-PROPOSE overlay. onSubmit consumes the model's typed args
    // (no DOM re-derive) and calls reducers.proposeTrade with the frozen-link gate FIRST
    // (ADR-0085 A1). The model's targetIdentity string is wrapped in `new Identity(...)` here
    // (the SDK boundary); the counterparty side is currency-only (RLS — D2), so the monster/
    // item request fields are always empty. Feedback into #tradepropose-feedback via
    // reduceErrorMessage on reject (no InternalError leak, PTC2-15).
    tradeProposeView = new TradeProposeViewClass({
      onSubmit: async (args: TradeProposeArgs) => {
        if (conn === undefined || conn.linkFrozen()) {
          if (tradeProposeView?.visible) tradeProposeView.showFeedback('disconnected — try again');
          return;
        }
        try {
          await conn.live()?.reducers.proposeTrade({
            counterparty: new Identity(args.targetIdentity),
            initiatorMonsterIds: [...args.initiatorMonsterIds],
            initiatorItems: [],
            initiatorCurrency: args.initiatorCurrency,
            counterpartyMonsterIds: [],
            counterpartyItems: [],
            counterpartyCurrency: args.counterpartyCurrency,
          });
          if (tradeProposeView?.visible) tradeProposeView.showFeedback('Offer sent!');
        } catch (err) {
          if (tradeProposeView?.visible) {
            tradeProposeView.showFeedback(reduceErrorMessage(err, 'propose-trade'));
          }
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

  // uxd2 (ADR-0161 D6): the on-world interact prompt — created inline beside
  // the #status precedent. pointer-events:none so it can NEVER shadow the
  // document-level dialogue/shop click delegation; z-index below the overlays
  // (help sits at 100); translate(-50%,-100%) hangs the label above the anchor
  // (tile-top centre). Positioned each frame via renderer.screenFor(...).
  const interactPromptEl = document.createElement('div');
  interactPromptEl.id = 'interact-prompt';
  interactPromptEl.style.position = 'fixed';
  interactPromptEl.style.pointerEvents = 'none';
  interactPromptEl.style.display = 'none';
  interactPromptEl.style.transform = 'translate(-50%, -100%)';
  interactPromptEl.style.zIndex = '40';
  interactPromptEl.style.font = '12px/1.4 monospace';
  interactPromptEl.style.color = '#e8ecf5';
  interactPromptEl.style.background = 'rgba(10, 14, 24, 0.75)';
  interactPromptEl.style.padding = '1px 6px';
  interactPromptEl.style.borderRadius = '3px';
  document.body.appendChild(interactPromptEl);
  // Memoized last-applied prompt state: style/text writes happen ONLY when the
  // (actionWord, screen position) key changes — never unconditionally per frame.
  let lastPromptKey = 'none';

  // rb-51 (PRV1-1): the deletion-grace countdown banner — created at runtime beside the
  // #status / #interact-prompt precedent, and deliberately NOT an overlay: it must be visible
  // WHENEVER the window is live, not only once the player opens something. It carries no
  // aria-live and no implicit-live role: a region that changes every second would interrupt an
  // assistive-technology user continuously; ui/liveRegion.ts stays the sole announcement owner.
  const privacyCountdownEl = document.createElement('div');
  privacyCountdownEl.id = 'privacy-countdown';
  privacyCountdownEl.style.position = 'fixed';
  privacyCountdownEl.style.top = '4px';
  privacyCountdownEl.style.left = '50%';
  privacyCountdownEl.style.transform = 'translateX(-50%)';
  privacyCountdownEl.style.pointerEvents = 'none';
  privacyCountdownEl.style.display = 'none';
  privacyCountdownEl.style.zIndex = '45';
  privacyCountdownEl.style.font = '12px/1.4 monospace';
  privacyCountdownEl.style.color = '#ffd9d9';
  privacyCountdownEl.style.background = 'rgba(60, 12, 12, 0.82)';
  privacyCountdownEl.style.padding = '2px 8px';
  privacyCountdownEl.style.borderRadius = '3px';
  document.body.appendChild(privacyCountdownEl);
  // The memo key is the RENDERED LABEL (`null` when nothing should show): the derived remaining
  // time changes every frame, the label once a second.
  let lastCountdownLabel: string | null = null;
  const renderPrivacyCountdown = (label: string | null): void => {
    if (label === lastCountdownLabel) return;
    lastCountdownLabel = label;
    // The hide arm is load-bearing: without it a cancelled deletion — or a dead session — leaves
    // a frozen deadline on screen for the rest of the page's life.
    privacyCountdownEl.textContent = label ?? '';
    privacyCountdownEl.style.display = label === null ? 'none' : 'block';
  };

  // pt-b1 (ADR-0130): mount the F9 error overlay (self-mounting, starts hidden,
  // non-blocking pointer-events:none). pushError renders into it on the first error.
  errorOverlayView = new ErrorOverlayView();

  // M20C-INIT-BEGIN
  // Fire-and-forget (never awaited: the SDK chunk must not delay connect()) and contractually
  // non-rejecting (T-P1). Host reads happen HERE — the observability modules are host-blind.
  startClientTelemetry(TELEMETRY_CONFIG, {
    loadSdk: loadOtelSdk,
    buildSha: BUILD_INFO.sha,
    hints: {
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
    },
  }).then((t) => {
    telemetry = t;
    telemetry.recordWasmReady(WASM_READY_MS);
    telemetry.setZone(rawMap.zone_id);
  });
  // M20C-INIT-END

  conn = connect({
    uri: URI,
    db: DB,
    name: 'Player',
    store,
    // M21b-2 (ADR-0182 D11/D12): OIDC config from env. The `?? ''` fallback degrades gracefully
    // today (no issuer → the flow contacts no network, AUTH-44) and lights up once 13r-c-2 deploys.
    authIssuer: import.meta.env.VITE_MR_OIDC_ISSUER ?? '',
    authClientId: import.meta.env.VITE_MR_OIDC_CLIENT_ID ?? '',
    authRedirectUri: import.meta.env.VITE_MR_OIDC_REDIRECT_URI ?? '',
    // ADR-0157: undefined unless VITE_MR_DEVLOG is set — then the connection installs the
    // outbound-log Proxy. Bare identifier by design (no inline sink: the ring must stay
    // unreachable from the send path).
    onSend: sendLogger,
    onReady: (id) => {
      identity = id;
      // pt-b1: record the connect edge (identity-hex is the allowed field, U-3).
      eventRing.push(makeConnect(identity));
      resolveReady();
      // M21b-2 (ADR-0182 D17): a successful connection clears any session terminal overlay.
      applySession({ kind: 'connected' });
    },
    // 17r-b (ADR-0130 residual d): the store now holds the applied snapshot, so the reseed latch
    // may resolve on this flush. Set here, consumed by the battle emit listener.
    onHydrated: () => {
      hydratedSinceReconnect = true;
    },
    onReconnect: (id) => {
      // 17r-b (ADR-0130 residual e): a rebuild can mint a NEW identity — refresh FIRST so every
      // identity-gated listener (and the connect event below) sees this connection's identity.
      identity = id;
      // 16r-f: capture BEFORE resetPredictionState nulls activeBattleId; a 2nd drop while a
      // reseed is still pending must keep the FIRST capture (not overwrite it with null).
      if (!battleReseedPending) reseedPrevBattleId = activeBattleId;
      // Clean re-init: the store already dropped stale rows; rebuild prediction and
      // drop the own slide clock so the post-reconnect re-seed starts fresh.
      // Zone state is corrected by the reconcile listener's state-based check on
      // the first post-reconnect batch (12.5c-1 — no special zone logic needed here).
      resetPredictionState();
      // pt-c1b (ADR-0133 D4 / RT-RN-02): hide the rename overlay on reconnect — the store
      // was reset (stale current-name), and an in-flight submit will never settle on the
      // dropped link. hide() also resets the input value + feedback (stale-draft guard).
      renameView?.hide();
      // pt-c2 (ADR-0134 D7 reviewer M-2 / red-team C-2): hide the trade-PROPOSE overlay on
      // reconnect too. WITHOUT this, the view's #pending lock survives the link drop (the SDK
      // never settles the in-flight proposeTrade promise) → dead submit button forever.
      tradeProposeView?.hide();
      menuView?.hide(); // uxd3: grey-out reads store state that the reset invalidated
      // pt-b1 (red-team M-1): re-baseline a surviving Ongoing battle on the next batch
      // instead of re-emitting a spurious battleStart for it. 17r-b: armed until onHydrated —
      // reset UNCONDITIONALLY (unlike the guarded capture above) so a second drop re-arms
      // against ITS OWN hydration, never a stale one.
      battleReseedPending = true;
      hydratedSinceReconnect = false;
      // RT-PL-01: a buy/sell in flight at drop time never settles (SDK — no settle
      // on drop), so the shop's double-spend lock would stay held forever. hide()
      // resets it (shopView.ts is outside this slice's touch-set; the reset rides
      // the existing public hide()). Escape-only recovery during the gap (uxd2:
      // the global shop hotkey is gone — ADR-0161 D5).
      shopView?.hide();
      // rb-52: the same never-settling-promise class as the four hides above, for the privacy
      // surface's `inFlight` lock. Clearing the memo makes the next frame re-pump
      // `account-changed`, which clears `inFlight` — without it, a drop during an export requested
      // while the phase was already `unknown` (the ordinary guest state) leaves all three controls
      // disabled, with no notice, for the life of the page.
      lastPrivacyCountdown = undefined;
      // uxd2 (ADR-0161 D4/D5): the store was reset, so a pending or bound
      // shop / heal id refers to rows that may no longer exist — clear all three
      // (a stale pendingShopId would otherwise pop a shop on the first
      // post-reconnect dialogue dismissal).
      pendingShopId = null;
      boundShopId = null;
      boundHealLocationId = null;
      // m15b: trade's double-spend lock must also be reset on reconnect (same reason as shop).
      tradeView?.hide();
      // m16b: hide the PvP overlay on reconnect — any pending challenge state is stale.
      pvpView?.hide();
      // m17b: hide the leaderboard on reconnect — the store was reset, so a stale/empty
      // board must not linger (no lock to reset; re-renders on the next open/batch).
      leaderboardView?.hide();
      // The "connection lost — reconnecting…" status line is now stale (ADR-0085 A8).
      clearStatus();
      // pt-b1: record the reconnect edge as a fresh connect (the refreshed identity, 17r-b).
      eventRing.push(makeConnect(identity));
      // M21b-2 (ADR-0182 D17): a successful reconnect clears any session terminal overlay.
      applySession({ kind: 'connected' });
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
    onError: (where, message) => {
      reportError(`${where}: ${message}`);
      // pt-b1 (B-1): emit disconnect ONLY on the link-level edge — not for other `where`
      // values (which fire for non-link failures too).
      if (where === 'link') eventRing.push(makeDisconnect());
    },
    // M21b-2 (ADR-0182 D17): the session-lifecycle terminals drive the registry-external overlay.
    onSessionExpired: () => applySession({ kind: 'session-expired' }),
    onAuthServiceUnreachable: () => applySession({ kind: 'auth-service-unreachable' }),
    // AUTH-48: a failed FIRST sign-in routes to the claim UI (never the session overlay).
    onSignInFailed: (reason) => {
      applyClaim({ kind: 'sign-in-failed', reason });
      claimView?.show();
      renderClaim();
    },
    // M21b-2 (ADR-0182 D16): the reconnect-triggered guest-claim lifecycle.
    onClaimPending: (code) => applyClaim({ kind: 'claim-pending', code }),
    onClaimAwaitingAccount: () => applyClaim({ kind: 'claim-awaiting-account' }),
    onClaimResult: (result) => {
      if (result.ok) {
        applyClaim({ kind: 'claim-succeeded' });
        return;
      }
      // AUTH-51 / D15: the ONLY authoritative "am I signed in" signal is store.ownAccount(identity),
      // the row the SERVER wrote — its claimedFrom disambiguates ERR_INVALID_CODE (ADR-0182 D16).
      applyClaim({
        kind: 'claim-rejected',
        message: result.message,
        claimedFrom: store.ownAccount(identity)?.claimedFrom,
      });
    },
  });

  // 12.5c-4: frame loop is wrapped in try/catch so a wasm/predictor throw does not
  // kill the loop permanently. rAF re-arm is in `finally` so it always fires, even
  // on error. The reconcile call is inside the batch-listener's try-catch (above).
  const frame = (): void => {
    try {
      // M21b-2 (ADR-0182 D17, G20b): the session terminal also outranks the render/dispatch loop —
      // skip this frame's held-key re-issue so the predictor never ghost-walks into a dead link.
      // The rAF re-arm lives in this loop's finally, so an early return skips work, not the loop.
      if (sessionGateBlocks()) {
        // The session terminal means the store is no longer a live view of this account, and the
        // person at the keyboard may not be the one who scheduled the deletion — so the deadline
        // comes DOWN rather than freezing at its last value (rb-51, ADR-0231 Amendment A1).
        renderPrivacyCountdown(null);
        return;
      }
      const now = performance.now();
      // M23S5-A11YSNAPSHOT-BEGIN
      // m23-s5 (ADR-0206 D3): the ONE announcement edge and the ONE focus return, at the TOP
      // of the frame so a recurring throw further down cannot silence the region. The world
      // branch and announcementsFor are disjoint by construction (the reducer emits only when
      // next.topOverlay is non-null), so neither transition is ever uttered twice.
      const top = visibleIds(overlayProbes)[0] ?? null;
      const nextSnapshot: A11ySnapshot = { topOverlay: top, message: '' };
      for (const m of announcementsFor(lastA11ySnapshot, nextSnapshot)) liveRegion.announce(m, now);
      if (lastA11ySnapshot.topOverlay !== null && top === null) {
        liveRegion.announce(t('a11y.world.region'), now);
        if (worldHasFocus() || focusInsideHiddenSubtree()) worldCanvasEl?.focus();
      }
      lastA11ySnapshot = nextSnapshot;
      liveRegion.flush(now);
      // M23S5-A11YSNAPSHOT-END
      // rb-51 (PRV1-1): the ticking deletion countdown, ABOVE the render path on purpose — a
      // recurring throw below is swallowed by this frame's catch, and a frozen legal deadline is
      // worse than a blank one.
      const privacyAccount = store.ownAccount(identity);
      // ONE derivation per frame, reused by the banner AND the rb-52 surface — a second call site
      // would be a second seam for the same fact (and is pinned at exactly one).
      const privacyCountdown = deriveDeletionCountdown({
        status: privacyAccount?.status,
        deletionRequestedAtMs: privacyAccount?.deletionRequestedAtMs,
        terminalAtMs: privacyAccount?.terminalAtMs,
        // Wall clock, and INTEGRAL by construction: `performance.now()` is ms since navigation
        // (every deadline would read millennia away) and a fractional argument makes `BigInt`
        // throw, in a block that sits above the render path.
        nowMs: BigInt(Math.trunc(Date.now())),
        graceMs: DELETION_GRACE_MS_DEFAULT,
      });
      renderPrivacyCountdown(privacyBannerLabel(privacyCountdown));
      // rb-52: the OVERLAY's status line formats `remainingMs` too, so it must be repainted from
      // the live countdown or it freezes at the value the last phase change left behind. A RENDER,
      // never a model write. Memoized on the label so a still countdown costs nothing.
      livePrivacyCountdown = privacyCountdown;
      if (privacyView?.visible) {
        const nextLabel = buildPrivacyViewModel({
          ...privacyModelState,
          countdown: privacyCountdown,
        }).statusLabel;
        if (nextLabel !== lastPrivacyStatusLabel) renderPrivacy();
      }
      // rb-52 (A2-D9): CHANGE-DETECTED, never per frame. `account-changed` clears `inFlight`, and
      // that is the only double-submit guard. `remainingMs` moves every frame, so the comparison
      // deliberately ignores it — the model reads permissions and the phase, never the number.
      if (
        lastPrivacyCountdown === undefined ||
        lastPrivacyCountdown.phase !== privacyCountdown.phase ||
        lastPrivacyCountdown.cancelPermitted !== privacyCountdown.cancelPermitted ||
        lastPrivacyCountdown.cancelPermanentlyRejected !==
          privacyCountdown.cancelPermanentlyRejected ||
        lastPrivacyCountdown.deletePermitted !== privacyCountdown.deletePermitted ||
        lastPrivacyCountdown.exportPermitted !== privacyCountdown.exportPermitted
      ) {
        lastPrivacyCountdown = privacyCountdown;
        applyPrivacy({ kind: 'account-changed', countdown: privacyCountdown });
      }
      // nh2 (ADR-0148 R1): drain BEFORE the continuation re-issue, so a step emitted below is
      // never drained by the frame that issued it. This is a RESIDUAL fix, not the primary one:
      // measured, the outstanding-work gate takes press-phase render teleports from 88% to ~2%
      // (6% at 30Hz), and this reordering takes that remainder to 0 — R1 WITHOUT the gate
      // removes essentially none of them, so the two must not be separated. The teleport is
      // RenderResolver's chebyshev>1 snap (ADR-0141) firing when `predicted` advances two tiles
      // between rendered frames. Do NOT move this back below the block.
      const { snapped } = predictor.drain(now);
      // Re-issue the held dir so a held key keeps walking — but only when no overlay
      // is visible, so a held key resumes after an overlay closes yet never walks
      // under one (M8.6c, ADR-0013) + hold-commit tap/hold discrimination (ADR-0158).
      // sendIntent routes through the backpressured
      // predictor.enqueue + reducer send, and no-ops if declined.
      // nh2 (ADR-0148): ...and only while the server owes nothing. Pure NOT-EMIT: it never
      // cancels or writes predictor state, so reconcileFromStore stays the one repair path.
      if (predictor.outstandingSteps === 0 && !anyOverlayVisible()) {
        const heldDir = reissueDir(held.committedActive(now), predictor.lastQueuedDir);
        if (heldDir !== undefined) sendIntent({ Step: heldDir });
      }
      const ownEntityId = store.ownEntityId(identity);
      const predicted = predictor.predicted;
      const entities = resolver.resolve({
        characters: store.characters(),
        ownEntityId,
        predicted,
        snapped,
        now,
        currentZoneId: rawMap.zone_id,
        reduceMotion: motionPreference.reduceMotion,
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
      // M20C-FRAME-BEGIN
      const obsTick = frameTick(frameWindow, now);
      frameWindow = obsTick.state;
      if (obsTick.sample !== undefined) {
        telemetry.recordFrameSample(obsTick.sample);
        telemetry.recordInterpGap(
          ownEntityId === undefined
            ? undefined
            : maxRemoteGapMs(
                Array.from(store.characters()).filter((c) => c.row.entityId !== ownEntityId),
                STEP_MS,
              ),
        );
      }
      // M20C-FRAME-END
      // uxd2 (ADR-0161 D6): recompute the on-world interact prompt EVERY frame
      // — the SAME resolver KeyT dispatches on, so the prompt can never
      // advertise a target KeyT refuses, and it self-heals on zone switch /
      // reconnect / overlay open. Positioned via renderer.screenFor — the
      // exact camera offset + stageScale the stage applied THIS frame.
      const ownChar = store.ownCharacter(identity);
      // Overlay-open frames skip the resolve entirely (the prompt is guaranteed
      // hidden), so the per-frame map/array allocations only happen in-world.
      const overlayUp = anyOverlayVisible();
      const promptTarget =
        !overlayUp && ownChar !== undefined
          ? nearestInteractable(
              ownChar.row,
              store.allNpcs(),
              characterTileMap(),
              store.healLocations(),
            )
          : undefined;
      const promptVm = interactPrompt(promptTarget, overlayUp);
      const promptPos =
        promptVm !== null
          ? renderer?.screenFor({ x: promptVm.anchorWorldX, y: promptVm.anchorWorldY })
          : undefined;
      const promptKey =
        promptVm !== null && promptPos !== undefined
          ? `${promptVm.actionWord}|${promptPos.x}|${promptPos.y}`
          : 'none';
      if (promptKey !== lastPromptKey) {
        lastPromptKey = promptKey;
        if (promptVm !== null && promptPos !== undefined) {
          interactPromptEl.textContent = `${promptVm.actionWord} [${promptVm.keyGlyph}]`;
          interactPromptEl.style.left = `${promptPos.x}px`;
          interactPromptEl.style.top = `${promptPos.y}px`;
          interactPromptEl.style.display = 'block';
        } else {
          interactPromptEl.style.display = 'none';
        }
      }
    } catch (err) {
      console.error('[frame] uncaught error', err);
    } finally {
      requestAnimationFrame(frame); // always re-arm (12.5c-4)
    }
  };
  requestAnimationFrame(frame);
}

void main();
