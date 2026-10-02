// monster-realm client — the integrated loop (M5a, folds in the M4c app wiring).
//
// Binds the tested pure cores into the live one-way flow:
//   server --(SDK rows)--> connection adapter --> AuthoritativeStore  (truth in)
//   input  --> Predictor (predict via the SAME wasm rule) + send intent reducers
//   batch-applied --> Predictor.reconcile (4-step against a coherent snapshot)
//   rAF    --> Predictor.drain --> WorldRenderer.render (own=predicted, remote=auth)
//
// The own character renders from its self-owned slide clock (fractional sub-tile)
// and remotes from the interpolation buffer (now − interpDelay), via RenderResolver.
// A DEV `window.__game()` snapshot lets the M5 two-window e2e
// assert on STATE (predicted vs authoritative tiles, presence, the zone map), never
// pixels.

import { Identity } from 'spacetimedb';
// client-wasm (built `wasm-pack build client-wasm --target bundler`; resolved by
// vite-plugin-wasm + top-level-await — see vite.config.ts / server.fs.allow).
import {
  apply_move,
  deletion_grace_ms_default,
  max_trade_monsters_per_side,
  move_queue_cap,
  party_size,
  party_slot_none,
  set_active_zone,
  step_ms,
  talk_range,
  zone_map,
} from '../../client-wasm/pkg/client_wasm.js';
import {
  characterToPredictedBaseline,
  moveInputToSdk,
  type SdkCharacterFields,
  type WasmDirection,
  type WasmMoveInput,
} from './convert/convert';
import { DEFAULT_BINDINGS } from './input/bindings';
import type { ButtonEdge } from './input/buttons';
import { isChord, KeyboardSource } from './input/keyboardSource';
import {
  InputRouter,
  ownership,
  type RouteContext,
  type RouterEffect,
  routedBindings,
  routerConsumes,
  typingKey,
} from './input/router';
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
// F9 bug-bundle observability — session event ring + error ring +
// pure bundle assembler + error overlay.
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
import {
  baseFor,
  battleButton,
  battleRefused,
  blocksPlayerOpen,
  contextStep,
  continuedBattleId,
  type Edge,
  isBareBattle,
  mirrorEdges,
  movementEnabled,
  popToBase,
  popTop,
  reconcile,
  type Stack,
  type Command as StackCommand,
  stackDiff,
  type UpperFrame,
  WORLD_STACK,
} from './ui/contextStack';
import { DIALOGUE_TREES } from './ui/dialogueContent';
import { buildDialogueViewModel } from './ui/dialogueModel';
import type { DialogueView } from './ui/dialogueView';
import { buildErrorOverlayModel } from './ui/errorOverlayModel';
import { ErrorOverlayView } from './ui/errorOverlayView';
import { ErrorRing, type ErrorSource, normalizeError } from './ui/errorRing';
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
import {
  EvolutionNoticeBanner,
  evolutionNoticeKey,
  evolutionNoticeLabel,
  isBenignAckRejection,
  resolveEvolutionNoticeNames,
} from './ui/evolutionNotice';
import type { EvolutionView } from './ui/evolutionView';
import { assembleExportBundle, type ExportAssembly } from './ui/exportAssembly';
import {
  buildHealViewModel,
  buildHealViewModelForLocation,
  healTargetLocationId,
} from './ui/healModel';
import type { HealView } from './ui/healView';
import { buildHelpViewModel } from './ui/helpModel';
import type { HelpView } from './ui/helpView';
import { isRtl, negotiateLocale } from './ui/i18n/locale';
import { CATALOGS, t as i18nT, setLocale, tf } from './ui/i18n/resolver';
import { interactPrompt, nearestInteractable } from './ui/interactModel';
import { buildLeaderboardViewModel } from './ui/leaderboardModel';
import type { LeaderboardView } from './ui/leaderboardView';
import { LiveRegion } from './ui/liveRegion';
import type { MenuTarget } from './ui/menuModel';
import type { MenuPointerInput, MenuView } from './ui/menuView';
import { EMPTY_NAV_MEMORY } from './ui/nav';
import {
  anyVisible,
  type CanOpenVerdict,
  canOpen,
  type OverlayHandles,
  type OverlayId,
  type OverlayProbes,
  visibleIds,
} from './ui/overlayRegistry';
import {
  buildPrivacyViewModel,
  exportBundleFilename,
  privacyBannerLabel,
} from './ui/privacyBanner';
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
import { SCREEN_ADAPTERS, ScreenHost } from './ui/screens/index';
import {
  type MainMenuStep,
  mainMenuPick,
  mainMenuStep,
  menuViewModel,
  openMainMenu,
} from './ui/screens/mainMenuScreen';
import type { Command, ScreenContext } from './ui/screens/types';
import {
  buildSessionViewModel,
  SESSION_INITIAL,
  type SessionEvent,
  type SessionModelState,
  sessionStep,
} from './ui/sessionModel';
import type { SessionView, SessionViewHandlers } from './ui/sessionView';
import { buildShopViewModel, buildShopViewModelForShop } from './ui/shopModel';
import {
  type DismissPath,
  SHOP_OPEN_INITIAL,
  type ShopOpenEvent,
  shopOpenStep,
} from './ui/shopOpenModel';
import type { ShopView } from './ui/shopView';
import { reduceErrorMessage } from './ui/statusModel';
import { buildTradeViewModel } from './ui/tradeModel';
import { buildProposeLists, type TradeProposeArgs } from './ui/tradeProposeModel';
import type { TradeProposeView } from './ui/tradeProposeView';
import type { TradeView } from './ui/tradeView';

// resolve the SpacetimeDB target at MODULE scope (eager, like the old
// URI/DB consts) so a misconfigured PRODUCTION build fails loud here — before connect() is
// reachable — rather than silently writing to the dev-default database `monster-realm`.
// Kept at module scope on purpose: moving it inside main() could let a try/catch
// swallow the throw.
const { uri: URI, db: DB } = resolveConnectionConfig(
  {
    uri: import.meta.env.VITE_STDB_URI as string | undefined,
    db: import.meta.env.VITE_STDB_DB as string | undefined,
  },
  import.meta.env.DEV,
);
// dev-observability: resolve VITE_MR_DEVLOG at MODULE scope too, for the same
// F-3 reason — the resolver RETHROWS in dev, and a throw from inside main() could be
// swallowed by a try/catch there. Asymmetric on purpose (inverted vs the other resolvers): dev rethrows,
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
// The INBOUND fate line, same level/sink/undefined-at-'off' discipline as
// sendLogger. CONSOLE-ONLY — a ring push smuggled into this sink would ship reducer args
// (player free text) into the shared F9 bundle.
const fateLogger = makeFateLogger(DEV_LOG_LEVEL, (line) => console.log(line));

// negotiate the boot locale once, before any consumer.
const LOCALE = negotiateLocale(
  [...new URLSearchParams(window.location.search).getAll('locale'), ...navigator.languages],
  Object.keys(CATALOGS),
);
setLocale(LOCALE);
document.documentElement.lang = LOCALE;
document.documentElement.dir = isRtl(LOCALE) ? 'rtl' : 'ltr';

const ZONE_ID = 0;

// Content is single-sourced from game-core via the wasm exports (never duplicated).
const STEP_MS = step_ms();
const QUEUE_CAP = move_queue_cap();
const PARTY_SIZE = party_size();
const PARTY_SLOT_NONE = party_slot_none();
const MAX_TRADE_MONSTERS_PER_SIDE = max_trade_monsters_per_side();
const TALK_RANGE = talk_range();
// The deletion grace window, read ONCE per session — it is a build constant, and
// re-reading it per frame would cross the wasm boundary ~60x/s for a value that cannot change.
const DELETION_GRACE_MS_DEFAULT = deletion_grace_ms_default();
// rawMap is `let` — replaced on zone warp (zone_map() re-called for the new zone id).
let rawMap = zone_map(ZONE_ID);

// wasm-ready mark — the import above is top-level-awaited, so the exports are
// callable here (the metric's definition: ms from timeOrigin), captured once per session.
const WASM_READY_MS = performance.now();
// module-scope resolve (F-3 pattern); jitter injected so the resolver stays pure (AM12).
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
// Frame accumulator — created ONCE, carried across rAF frames by the frame hunk.
let frameWindow = createFrameWindow(performance.now());

// stepMs injected so the store can do burst detection + jitter EWMA.
const store = new AuthoritativeStore(STEP_MS);
// The injected rule IS the client-wasm export (same compiled code as the server).
const applyMove = apply_move as unknown as ApplyMove;
let predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
// Routes own (slide clock) vs remote (interpolation buffer) renders (M8.6b).
const resolver = new RenderResolver(STEP_MS);
// Closes render/motionPreference.ts's S7 cross-slice contract. Constructed ONCE
// (its change listener is page-lifetime by design); `.reduceMotion` is a live getter, so the
// per-frame read at the resolve() call below re-reads it rather than a boot-time snapshot.
const motionPreference = motionPreferenceFromWindow();
// Held movement keys (most-recently-pressed stack) — drives the frame-loop
// continuation re-issue so a held key keeps walking.
const held = new HeldDirections();
// renderer is module-scope so switchZone (below) can call setMap without
// being inside main(). Defined here; assigned once inside main() after async init.
let renderer: WorldRenderer | undefined;
// Camera hold — persists the last resolved tile position so the camera
// doesn't snap to origin when the own entity is temporarily unresolved (warp / reconnect).
let lastCamX = 0;
let lastCamY = 0;

// Sticky DEV latch: set once the own entity renders a fractional sub-tile position
// (proves the slide clock is wired, not raw integer tiles). Never reset to false
// except on reconnect. The e2e reads it via window.__game().
let sawFractionalOwnMotion = false;

let identity = '';
// event-emit latches. `activeBattleId` tracks the battle we saw START so
// battleEnd only fires for a battle we witnessed (guards a stale-terminal-at-first-sight).
// `lastOwnRating` baselines the ranked-delta detector. BOTH reset to null on
// reconnect/zone-switch (resetPredictionState) so they re-baseline — the RINGS do NOT reset.
let activeBattleId: bigint | null = null;
let lastOwnRating: number | null = null;
// set on RECONNECT only. A still-Ongoing battle that survived the drop must NOT re-emit
// battleStart. Armed until the connection signals hydration-complete (onHydrated) — never
// resolved by what a flush happens to read, so a partial hydration cannot burn it;
// reseedPrevBattleId is the drop-time battle so only ITS re-sighting is silent.
// hydratedSinceReconnect is reset on EVERY reconnect and set by onHydrated.
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
// Ranked leaderboard overlay — pure subscription view (RL-15).
let leaderboardView: LeaderboardView | undefined;
// profile-rename overlay — the first text-input overlay; wires the
// merged set_profile_name reducer to a KeyN rename form.
let renameView: RenameView | undefined;
// trade-PROPOSE overlay — KeyO "Offer" form; wires reducers.proposeTrade
// to let a human initiate a "sell my monster(s) + gold for your gold" trade.
let tradeProposeView: TradeProposeView | undefined;
// in-client help overlay — display-only `?` overlay listing
// controls + goals. No callbacks / reducer (zero-arg construction).
let helpView: HelpView | undefined;
// The main menu (ctl-5): a nav-list screen that stays open beneath the overlay it opens.
let menuView: MenuView | undefined;
// The guest-claim overlay (registry GUARD_ONLY) and the
// session-lifecycle overlay (registry-EXTERNAL, driven by conn.sessionState()), each backed by
// its pure model state carried at module scope.
let claimView: ClaimView | undefined;
let privacyView: PrivacyView | undefined;
let sessionView: SessionView | undefined;
// The post-evolve reveal banner — runtime-constructed in main(), NOT a
// registry overlay; read by the batch listener below and reset at the onReconnect tail.
let evolutionNoticeBanner: EvolutionNoticeBanner | undefined;
let claimModelState: ClaimModelState = CLAIM_INITIAL;
let sessionModelState: SessionModelState = SESSION_INITIAL;
// Tracks the turn number at the time the player submitted a PvP action.
// When the server resolves the turn (battle.turnNumber increments beyond this),
// pvpPendingTurnNumber is cleared and pvpPendingSubmit becomes false.
// battle_action is PRIVATE (must-never-leak) — this is the ONLY signal
// the client has about its own submission state.
let pvpPendingTurnNumber: number | null = null;
// The dialogue-dismiss / deferred shop-open state (ui/shopOpenModel.ts): whether a
// dismiss_dialogue is in flight, and the shop the greet-then-shop button will open on the
// first no-conversation batch — never inline. Stepped only through `stepShopOpen`.
let shopOpen = SHOP_OPEN_INITIAL;
// boundShopId / boundHealLocationId record which shop / heal location the
// visible overlay is bound to, so a refresh batch never silently swaps a bound
// view back to the first-row default. Both clear on reconnect (the store reset
// invalidates the ids); every open rebinds them.
let boundShopId: number | null = null;
let boundHealLocationId: number | null = null;

// the ONE probe table. Every fan-out surface below reads visibility
// through it, so a 16th overlay is a COMPILE error here instead of 5 silent omissions.
// Each entry is intentionally byte-identical `<id>: () => <id>?.visible ?? false` —
// that literal shape matters because
// main.ts is coverage-excluded and a single negated or `?? true` probe would corrupt all
// five surfaces at once while every other tooth stayed green.
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

// the ONE force-hide handle table — the WRITE mirror of `overlayProbes`.
// Typed `OverlayHandles` (a total `Record<OverlayId, _>`), so a 16th overlay is a COMPILE
// error here rather than an overlay a verdict can name and nothing can hide. Every entry is
// intentionally byte-identical `<id>: () => <id>?.hide()` — that
// shape matters per id, because main.ts is coverage-excluded and a copy-pasted sibling thunk
// (`raisingView: () => boxView?.hide()`) type-checks perfectly while hiding the wrong overlay.
// `dialogueView` is the SOLE `undefined` entry and must stay that way: hiding a live
// conversation client-side strands the server `player_conversation` row. Consumers read
// `overlayHandles[id]?.()`; only verdicts and the stack's `close` commands decide WHICH ids.
// A close leaves boundShopId / boundHealLocationId set: every open rebinds them, and their
// refresh listeners run only while the overlay is visible.
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

// the ONE view-lending table: each frame's view instance, which the screen host hands to that
// frame's adapter to paint after a step (CTL7C.2). Every entry is intentionally byte-identical
// `<id>: () => <id>`, one uniform thunk per id as in the probe table and for its reason: a
// copy-pasted sibling thunk type-checks perfectly while lending the wrong view. Undefined until
// main() builds the views.
const screenViews: Readonly<Record<OverlayId, () => unknown>> = {
  battleView: () => battleView,
  boxView: () => boxView,
  raisingView: () => raisingView,
  evolutionView: () => evolutionView,
  dialogueView: () => dialogueView,
  questLogView: () => questLogView,
  healView: () => healView,
  shopView: () => shopView,
  tradeView: () => tradeView,
  pvpView: () => pvpView,
  leaderboardView: () => leaderboardView,
  renameView: () => renameView,
  tradeProposeView: () => tradeProposeView,
  helpView: () => helpView,
  menuView: () => menuView,
  claimView: () => claimView,
  privacyView: () => privacyView,
};

// A view's paint threw. Logged every time, and surfaced like an uncaught frame error (tagged,
// deduped on the message: a held D-pad repeats the same step every 100 ms, and the error ring is
// small).
let lastPaintErrorMessage: string | null = null;
function reportPaintError(err: unknown): void {
  console.error('[screen] paint error', err);
  let message: string;
  try {
    message = `screen paint: ${normalizeError('uncaught', err).message}`;
  } catch {
    message = 'screen paint: [unstringifiable error]';
  }
  if (message === lastPaintErrorMessage) return;
  lastPaintErrorMessage = message;
  pushError('uncaught', message);
}

// The screen host (ui/screens/index.ts) keeps each open frame's adapter state and paints every
// step into the frame's view. A paint that throws is reported and never costs the key its result.
const screenHost = new ScreenHost(SCREEN_ADAPTERS, (id) => screenViews[id](), reportPaintError);

// the ONE gate binder. Returns the VERDICT, not a boolean, because the
// three hide-switch handlers consume `forceHide`; each call site spells `.kind === 'allow'`
// itself, deliberately, so no single `!` can invert eleven gates at once. Re-probes through
// `visibleIds(overlayProbes)` on EVERY call — this table is built while every view binding is
// still undefined, so anything cached would be permanently empty.
//
// The main menu stays open beneath the screen it opens (ctl-5), so it never blocks another
// overlay: it is left out of the visible set for every target but itself.
function overlayVerdict(id: OverlayId): CanOpenVerdict {
  const visible = visibleIds(overlayProbes);
  return canOpen(id, id === 'menuView' ? visible : visible.filter((v) => v !== 'menuView'));
}

// The context stack (ui/contextStack.ts) sits BEHIND the legacy show/hide paths: nothing
// pushes onto it directly. `syncStack()` mirrors the visible overlays into it and derives
// the base from the store, so every reader that syncs first sees the overlays and the battle
// row as they are right now, whichever listener showed them. A push of a new frame (and a
// change of base kind) clears the held directions (B14). Synced on every movementGate() read,
// at the top and tail of every keydown, at the top of every frame and at the tail of every
// batch; `__game().stack` only reads it. Server truth is reconciled into it on every batch
// (`reconcileStack`), which closes what a battle or a conversation drops. The sync also keeps two
// things that follow the stack: when a terminal outcome first topped it (A's grace), and the
// battle refusal line, cleared once the base is the world again.
let contextStack: Stack = WORLD_STACK;
function runStackCommands(commands: readonly StackCommand[]): void {
  for (const command of commands) {
    switch (command.kind) {
      case 'clearHeld':
        held.clear();
        // The menu-side twin: a push or a change of base kind also ends any auto-repeat, so a key
        // held into a battle never repeats into a frame the battle keeps (a suspended dialogue).
        inputRouter.resetRepeat();
        break;
      case 'close':
        // The view's own hide path, so its close callbacks run (CTL3.3); never a hidden one.
        if (overlayProbes[command.id]()) overlayHandles[command.id]?.();
        break;
      default:
        command satisfies never;
    }
  }
}
/** When the terminal outcome frame now on top was first mirrored (performance.now), else null:
 *  A continues it only after `OUTCOME_CONTINUE_GRACE_MS` (CTL6C.2). */
let outcomeShownAtMs: number | null = null;
/** The reason of the last battle refusal written to the status line (CTL6C.3), until the base is
 *  the world again; else null. */
let shownBattleRefusal: string | null = null;
function syncStack(): void {
  const prevBase = contextStack[0];
  const ongoing = store.ongoingBattle(identity);
  const base = baseFor(
    ongoing === undefined
      ? undefined
      : { battleId: ongoing.battleId.toString(), outcome: ongoing.outcome },
  );
  const apply = (edge: Edge): void => {
    const next = contextStep(contextStack, edge);
    contextStack = next.stack;
    runStackCommands(next.commands);
  };
  apply({ kind: 'base', base });
  for (const edge of mirrorEdges(contextStack, visibleIds(overlayProbes), prevBase)) {
    apply(edge);
    if (edge.kind === 'push') screenHost.opened(edge.frame); // a reopened frame's adapter starts over
    inputRouter.resetRepeat(); // a held key never repeats into a pushed or popped frame
  }
  const top = contextStack[contextStack.length - 1];
  const outcomeUp =
    contextStack[0].kind === 'world' && top.kind === 'screen' && top.id === 'battleView';
  if (!outcomeUp) outcomeShownAtMs = null;
  else outcomeShownAtMs ??= performance.now();
  // The battle is over: its refusal reason is stale. Anything reported over it since stays.
  if (shownBattleRefusal !== null && contextStack[0].kind === 'world') {
    if (statusEl?.textContent === shownBattleRefusal) clearStatus();
    shownBattleRefusal = null;
  }
  menuView?.setCovered(menuPlace() === 'covered');
}

/** The overlay ids of the stack's upper frames, bottom first (the base excluded). */
function upperIds(): OverlayId[] {
  const [, ...upper] = contextStack;
  return upper.map((f) => (f.kind === 'textEntry' ? f.owner : f.id));
}

/** Where the main menu sits on the context stack: the top frame, under another, or absent. */
function menuPlace(): 'top' | 'covered' | 'absent' {
  const ids = upperIds();
  if (!ids.includes('menuView')) return 'absent';
  return ids.at(-1) === 'menuView' ? 'top' : 'covered';
}

/** The batch-time reconcile (CTL3.1): mirror first, so an overlay shown since the last sync is
 *  on the stack, then pop what the battle and the conversation drop and close those overlays. */
function reconcileStack(): void {
  syncStack();
  // The terminal outcome this batch will show: refreshBattle's own decision, read without
  // committing it, so what the outcome drops closes BEFORE the outcome shows (and takes focus).
  const latest = store.latestPlayerBattle(identity);
  const outcome =
    identity !== '' && latest !== undefined && latest.outcome !== 'Ongoing'
      ? decideBattleOverlay(latest, { dismissedBattleId, synced: battleSynced }).action.kind
      : 'hide';
  const next = reconcile(contextStack, {
    ongoingBattleId: store.ongoingBattle(identity)?.battleId.toString(),
    outcomeShown: outcome === 'show',
    conversation: store.ownConversation(identity) !== undefined,
  });
  // A drop here raises no mirror edge: a held key must not repeat into the frame it uncovers.
  if (next.stack.length !== contextStack.length) inputRouter.resetRepeat();
  contextStack = next.stack;
  runStackCommands(next.commands);
}

/** The ONE movement gate (CTL2.3): false under any frame, on a battle base (even with the
 *  battle overlay hidden — B17) and while the session terminal owns the screen. */
function movementGate(): boolean {
  syncStack();
  return movementEnabled(contextStack, sessionGateBlocks());
}

/** entityId → positional tile snapshot for the interact resolver.
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

// True while the session terminal (expired / unreachable) owns the
// screen. sessionView is registry-EXTERNAL, so the overlay probes cannot see it — this predicate
// is the ONE SSOT the keydown handler AND the frame loop both consult, checked first on every
// input path. `hidden` is the ordinary case and must NOT block.
function sessionGateBlocks(): boolean {
  const s = conn?.sessionState();
  return s !== undefined && s !== 'hidden';
}

// --- claim / session model drivers ------------------------------
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
  // ClaimPhase cannot represent "dismissed" (S4-claimView-REOPEN-AFTER-HIDE), so a later
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

// --- the privacy surface ------------------------------------
// Decisions live in ui/privacyModel.ts (rules) and ui/privacyBanner.ts (copy); this block only
// dispatches and paints.
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
    exportAssembly,
  );
  lastPrivacyStatusLabel = vm.statusLabel;
  privacyView?.render(vm);
}

// --- the export transport's client end -----------------------
// The assembly of the moment, or `undefined` when none has been computed for this identity yet.
// It holds the whole artifact, so it is module state rather than store state — which is exactly
// why `onReconnect` has to clear it explicitly (A3-D9): `store.reset()` cannot reach it, and a
// rebuild can mint a NEW identity.
let exportAssembly: ExportAssembly | undefined;

// A3-D2: the SOLE `assembleExportBundle(` call site, on the arrival edge. `onBatchApplied` fires
// once per coalesced transaction burst; the frame fires ~60x/s forever, and the rAF repaint gate
// is keyed on `statusLabel` alone (which export state does not move), so this listener is the
// SOLE owner of this part of the surface.
//
// A3-D10: the recompute is OUTSIDE the visibility guard. A burst arriving while the overlay is
// closed must still be picked up — `openPrivacy()` renders from current state, so the offer is
// there on open. Only the REPAINT is conditional.
store.onBatchApplied(() => {
  // Both owner filters run: the store's client-side one and the assembler's own
  // filter-first rule. Neither is redundant — the second decides which bytes reach the file.
  exportAssembly = assembleExportBundle(store.ownExportChunks(identity), identity);
  if (privacyView?.visible) renderPrivacy();
});

// A3-D3: offered behind a gesture, never auto-downloaded — chunks re-arrive on every applied
// snapshot, so an automatic save would re-fire on each reconnect, and browsers block non-gesture
// downloads outright.
function downloadExportBundle(): void {
  const artifact = exportAssembly?.artifact;
  // Defense in depth behind `vm.downloadEnabled`: the control is painted disabled in every other
  // state, but a truncated personal-data file must be unreachable by ANY route, not merely by
  // the one the UI offers.
  if (exportAssembly?.status !== 'complete' || artifact === undefined) return;
  // Both declared BEFORE the `try` so the `finally` can release exactly what was actually
  // created. `URL.createObjectURL` is itself one of the calls a CSP/sandbox policy blocks, so it
  // has to be INSIDE the try — the F9 precedent's shape, where only the anchor work is guarded,
  // lets that throw escape a click listener in the middle of a privacy interaction.
  let url = '';
  let anchor: HTMLAnchorElement | undefined;
  try {
    url = URL.createObjectURL(new Blob([artifact], { type: 'application/json' }));
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exportBundleFilename(exportAssembly.requestId, Date.now());
    document.body.appendChild(anchor);
    anchor.click();
  } catch {
    // A3-D7: a STATIC string, deliberately unlike the F9 bug-bundle fallback this is otherwise
    // modelled on. That one logs its payload, which is safe only because the bug bundle is a
    // no-PII allowlist by construction; the artifact here is the player's entire personal-data
    // export, and logging it would retain it in the devtools buffer for the page's life and —
    // through reportError — put it on screen and into the ring the F9 bundle embeds.
    console.error('[data-export] download blocked');
    reportError(i18nT('chrome.status.exportBlocked'));
  } finally {
    // A3-D8: in a `finally`, not inside the `try` after `click()` as the F9 precedent has it —
    // a throw there would pin the object URL, and with it the whole export Blob, for the page's
    // lifetime, and leave a stray anchor in the document.
    anchor?.remove();
    if (url !== '') URL.revokeObjectURL(url);
  }
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
    reportError(i18nT('chrome.status.privacyOverlayBusy'));
    return;
  }
  // Only now. A2-D5: hiding claim BEFORE show() is what keeps openOverlayA11y from capturing a
  // soon-to-be-hidden node as its focus-return target.
  claimView?.hide();
  renderPrivacy();
  privacyView?.show();
}

// AUTH-51: "signed in" is store.ownAccount(identity) !== undefined — the row the SERVER wrote —
// never a storage marker or the credential kind.
function openClaim(): void {
  applyClaim({
    kind: 'claim-ui-opened',
    nudgeAlreadySeen: claimCode.hasSeenFirstRunNudge(globalThis, URI, DB),
  });
  claimCode.markFirstRunNudgeSeen(globalThis, URI, DB);
  claimView?.show();
  renderClaim();
}
// --- the main menu ------------------------------------------------
//
// ONE OPEN PATH PER OVERLAY: each openX() below is the single build-VM-and-show body for
// its overlay, called by BOTH its hotkey handler and the menu. The view contract is
// non-uniform (dialogue/questLog/heal expose render() with no show(); pvp takes
// refresh(vm, forceVisible)), so these are per-id thunks, never a generic view.show().

/** The main menu's screen state. Its nav memory outlives every close, so a reopened menu lands
 *  on the last entry used this session (CTL5.3). */
let menuState = openMainMenu(EMPTY_NAV_MEMORY);

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

/** The interact dispatch: ONE exhaustive `switch (target.kind)`, so a 4th NpcInteraction kind
 *  compiler-flags this single site. Its one caller, the interact hotkey, is movement-gated, which
 *  is what keeps talking out of a battle (CTL6C.3). */
function interactAtNearest(): void {
  const own = store.ownCharacter(identity);
  if (own === undefined) return;
  const target = nearestInteractable(
    own.row,
    store.allNpcs(),
    characterTileMap(),
    store.healLocations(),
    TALK_RANGE,
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

function renderMenu(): void {
  menuView?.render(menuViewModel(menuState));
}

/** The SINGLE entry point: the root list, on the last entry used. */
function openMenu(): void {
  // Over a battle the menu is read-only: what is not battle-safe is disabled (CTL6C.3).
  menuState = openMainMenu(menuState.memory, contextStack[0].kind === 'battle');
  renderMenu();
  menuView?.show();
}

/** Open a menu entry's overlay ABOVE the menu, through that overlay's single open path. The
 *  menu stays open beneath it, so whichever way the child closes, the menu is back with its
 *  cursor on the entry. */
function openMenuTarget(target: MenuTarget): void {
  // A second route to store reads keyed by identity, which is '' until the first onReady.
  if (identity === '') return;
  // Exhaustive switch, no default arm: a new target compiler-flags this site.
  switch (target) {
    case 'boxView':
      boxView?.show();
      refreshBox();
      break;
    case 'raisingView':
      raisingView?.show();
      refreshRaising();
      break;
    case 'questLogView':
      openQuestLog();
      break;
    case 'tradeView':
      openTrade();
      break;
    case 'pvpView':
      openPvp();
      break;
    case 'leaderboardView':
      openLeaderboard();
      break;
    case 'renameView':
      openRename();
      break;
    case 'claimView':
      openClaim();
      break;
    case 'privacyView':
      openPrivacy();
      break;
    case 'helpView':
      openHelp();
      break;
  }
}

/** Apply one menu step: a level change resets auto-repeat, then the effect, then a repaint. */
function applyMenuStep(step: MainMenuStep): void {
  if (step.state.level !== menuState.level) inputRouter.resetRepeat();
  menuState = step.state;
  switch (step.effect.kind) {
    case 'none':
      break;
    case 'open':
      openMenuTarget(step.effect.target);
      break;
    case 'close':
      menuView?.hide();
      break;
  }
  renderMenu();
}

/** A click on an entry; ignored while a child covers the menu. */
function handleMenuPointer(input: MenuPointerInput): void {
  if (menuPlace() === 'covered') return;
  applyMenuStep(mainMenuPick(menuState, input.key));
}

// --- the screen-adapter seam (design §4, §12) ------------------------------------------
//
// The router hands the top frame's adapter (`screenHost.button`) every button but X, the main
// menu's own nav buttons and the D-pad, and the D-pad too when that adapter is nav-capable; its
// command, and every view callback, runs through ONE exhaustive `dispatch`. Stack commands compute
// the next stack and `applyStack` closes what it drops through each view's own hide path; the
// stack itself stays the mirror of what is shown (`syncStack`).

// The bindings the router reads: LB/RB only from PageUp/PageDown while the legacy ladder owns Q
// and E (CTL6B.6, until ctl-11a).
const ROUTED_BINDINGS = routedBindings(DEFAULT_BINDINGS);

/** The read-only context adapters build their view models from. */
const screenCtx: ScreenContext = {
  store,
  get identity() {
    return identity;
  },
  bindings: ROUTED_BINDINGS,
  now: () => performance.now(),
};

/** A settled promise for the arms that have no reducer promise to hand back. */
const DONE: Promise<void> = Promise.resolve();

// Single-unit MVP (infinite stock; multi-unit sell is future work).
const SHOP_QTY = 1 as const;
// Each feedback sink paints only while its overlay is visible: a late settle must not write a
// stale line into a closed (and later reopened) overlay.
const shopFeedback = (message: string): void => {
  if (shopView?.visible) shopView.showFeedback(message);
};
const tradeFeedback = (message: string): void => {
  if (tradeView?.visible) tradeView.showFeedback(message);
};
const ownPartyIds = (): bigint[] =>
  store
    .ownMonsters(identity)
    .filter((m) => m.partySlot !== PARTY_SLOT_NONE)
    .map((m) => m.monsterId);

/** Run one command. Not async: each arm hands back its own reducer promise (a view's lock holds
 *  until it settles), and a synchronous throw stays synchronous. No default arm, so a new
 *  `Command` fails client-typecheck here. */
function dispatch(command: Command): Promise<void> {
  if (refusedInBattle(command)) return DONE;
  switch (command.kind) {
    case 'pop':
      applyStack(contextStack, popTop(contextStack));
      return DONE;
    case 'popToBase':
      applyStack(contextStack, popToBase(contextStack));
      return DONE;
    case 'openMenu': {
      // The screens the menu opens read store state keyed by identity, which is '' before join.
      // At the bare battle base Start opens it over the battle (CTL6C.1), whose overlay holds focus
      // and outranks every other open request.
      if (
        identity !== '' &&
        (isBareBattle(contextStack) ||
          (overlayVerdict('menuView').kind === 'allow' && worldHasFocus()))
      ) {
        openMenu();
      }
      return DONE;
    }
    case 'toggleHelp':
      if (helpView?.visible) {
        applyStack(contextStack, contextStep(contextStack, { kind: 'pop', id: 'helpView' }).stack);
      } else if (overlayVerdict('helpView').kind === 'allow' && worldHasFocus()) {
        openHelp();
      }
      return DONE;
    case 'care':
      // The whole decision (frozen gate / await / exactly-one message) lives in the tested
      // performCare core. RaisingView.showFeedback is a no-op while hidden (stale-message guard).
      return performCare({
        call: () => liveReducers()?.care({ monsterId: command.monsterId }),
        successMessage: i18nT('raising.feedback.cared'),
        where: 'care',
        showFeedback: (message) => raisingView?.showFeedback(message),
      });
    case 'train': {
      const { monsterId, foodItemId } = command;
      return sendGuarded('train', () => conn?.live()?.reducers.train({ monsterId, foodItemId }));
    }
    case 'evolve': {
      // The CHOSEN species, from the panel's path picker: the client never resolves an ambiguous
      // evolution itself, and the server re-validates the same gates.
      const { monsterId, toSpecies } = command;
      return sendGuarded('evolve', () => conn?.live()?.reducers.evolve({ monsterId, toSpecies }));
    }
    case 'setNickname': {
      const { monsterId, nickname } = command;
      return sendGuarded('nickname', () =>
        conn?.live()?.reducers.setNickname({ monsterId, nickname }),
      );
    }
    case 'setPartySlot': {
      const { monsterId } = command;
      let slot = command.slot;
      if (slot === -1) {
        const free = nextFreePartySlot(store.ownMonsters(identity), PARTY_SIZE);
        // A full party has no slot to move into. Sending the box sentinel would be an accepted
        // server no-op the player never sees, so say why instead.
        if (free === null) {
          reportError(i18nT('chrome.status.partyFull'));
          return DONE;
        }
        slot = free;
      }
      return sendGuarded('party', () => conn?.live()?.reducers.setPartySlot({ monsterId, slot }));
    }
    case 'healParty': {
      // The location a bound heal frame names (B13); the Box button names none, and takes the
      // first heal location in live store data (M12d). SKIP the send when there is neither —
      // inventing `locationId: 0` would be a guaranteed invisible server Err. The skip is
      // surfaced, never silent; the server still validates zone/range/cooldown on a real send.
      const locationId = command.locationId ?? healTargetLocationId(store.healLocations());
      if (locationId === undefined) {
        reportError(i18nT('chrome.status.healUnavailable'));
        return DONE;
      }
      return sendGuarded('heal', () => conn?.live()?.reducers.healParty({ locationId }));
    }
    case 'buy': {
      const { shopId, itemId } = command;
      return performCare({
        call: () => liveReducers()?.buy({ shopId, itemId, qty: SHOP_QTY }),
        successMessage: i18nT('shop.feedback.purchased'),
        where: 'buy',
        showFeedback: shopFeedback,
      });
    }
    case 'sell': {
      const { itemId } = command;
      return performCare({
        call: () => liveReducers()?.sell({ itemId, qty: SHOP_QTY }),
        successMessage: i18nT('shop.feedback.sold'),
        where: 'sell',
        showFeedback: shopFeedback,
      });
    }
    case 'respondTrade': {
      const { tradeId, accepted } = command;
      return performCare({
        call: () => liveReducers()?.respondTrade({ tradeId, accepted }),
        successMessage: accepted
          ? i18nT('trade.feedback.accepted')
          : i18nT('trade.feedback.rejected'),
        where: 'respond-trade',
        showFeedback: tradeFeedback,
      });
    }
    case 'confirmTrade': {
      const { tradeId } = command;
      return performCare({
        call: () => liveReducers()?.confirmTrade({ tradeId }),
        successMessage: i18nT('trade.feedback.completed'),
        where: 'confirm-trade',
        showFeedback: tradeFeedback,
      });
    }
    case 'cancelTrade': {
      const { tradeId } = command;
      return performCare({
        call: () => liveReducers()?.cancelTrade({ tradeId }),
        successMessage: i18nT('trade.feedback.cancelled'),
        where: 'cancel-trade',
        showFeedback: tradeFeedback,
      });
    }
    case 'proposeTrade': {
      // The model's typed args (no DOM re-derive). The targetIdentity string is wrapped in
      // `new Identity(...)` (the SDK boundary) INSIDE the call thunk, so a throw while building
      // the args lands in the core's error arm; the counterparty side is currency-only (RLS —
      // D2), so its monster/item request fields are always empty.
      const { args } = command;
      return performCare({
        call: () =>
          liveReducers()?.proposeTrade({
            counterparty: new Identity(args.targetIdentity),
            initiatorMonsterIds: [...args.initiatorMonsterIds],
            initiatorItems: [],
            initiatorCurrency: args.initiatorCurrency,
            counterpartyMonsterIds: [],
            counterpartyItems: [],
            counterpartyCurrency: args.counterpartyCurrency,
          }),
        successMessage: i18nT('tradePropose.feedback.sent'),
        where: 'propose-trade',
        showFeedback: (message) => {
          if (tradeProposeView?.visible) tradeProposeView.showFeedback(message);
        },
      });
    }
    case 'challenge': {
      // Party ids are read inside the closure, at send time.
      const target = command.targetIdentity;
      return sendGuarded('pvp-challenge', () =>
        conn
          ?.live()
          ?.reducers.challengePvp({ target: new Identity(target), partyIds: ownPartyIds() }),
      );
    }
    case 'acceptChallenge': {
      const { challengeId } = command;
      return sendGuarded('pvp-accept', () =>
        conn?.live()?.reducers.acceptChallenge({ challengeId, partyIds: ownPartyIds() }),
      );
    }
    case 'declineChallenge': {
      const { challengeId } = command;
      return sendGuarded('pvp-decline', () =>
        conn?.live()?.reducers.declineChallenge({ challengeId }),
      );
    }
    case 'cancelChallenge': {
      const { challengeId } = command;
      return sendGuarded('pvp-cancel', () =>
        conn?.live()?.reducers.cancelChallenge({ challengeId }),
      );
    }
    case 'setProfileName': {
      // performCare (frozen gate first, reduceErrorMessage on reject — no InternalError leak),
      // not sendGuarded/reportError. The overlay stays open on success and on reject.
      const { name } = command;
      return performCare({
        call: () => liveReducers()?.setProfileName({ name }),
        successMessage: i18nT('chrome.rename.updated'),
        where: 'set-profile-name',
        showFeedback: (message) => {
          if (renameView?.visible) renameView.showFeedback(message);
        },
      });
    }
    case 'attack': {
      const { battleId, skillId } = command;
      return sendGuarded('attack', () =>
        conn?.live()?.reducers.submitAttack({ battleId, skillId }),
      );
    }
    case 'flee': {
      const { battleId } = command;
      return sendGuarded('flee', () => conn?.live()?.reducers.flee({ battleId }));
    }
    case 'swap': {
      const { battleId, teamIndex } = command;
      return sendGuarded('swap', () => conn?.live()?.reducers.swapActive({ battleId, teamIndex }));
    }
    case 'recruit': {
      const { battleId, baitItemId } = command;
      return sendGuarded('recruit', () =>
        conn?.live()?.reducers.attemptRecruit({ battleId, baitItemId }),
      );
    }
    case 'useItem': {
      const { battleId, itemId } = command;
      return sendGuarded('use-item', () =>
        conn?.live()?.reducers.useBattleItem({ battleId, itemId }),
      );
    }
    case 'pvpAttack':
      return sendPvpAction('pvp-attack', command.battleId, {
        tag: 'Attack',
        value: command.skillId,
      });
    case 'pvpSwap':
      return sendPvpAction('pvp-swap', command.battleId, {
        tag: 'Swap',
        value: command.teamIndex,
      });
    case 'advanceDialogue': {
      const { choiceIdx } = command;
      return sendGuarded('advance', () => conn?.live()?.reducers.advanceDialogue({ choiceIdx }));
    }
    case 'dismissDialogue':
      // Ends the conversation and cancels a pending shop open (last intent wins). The client
      // never hides the dialogue itself: the server's row deletion does.
      stepShopOpen({ kind: 'dismissRequested' });
      return DONE;
    case 'claimSignIn':
      conn?.startSignIn();
      return DONE;
    case 'claimJoin':
      applyClaim({
        kind: 'join-requested',
        hasLiveConnection: conn !== undefined && !conn.linkFrozen(),
      });
      return DONE;
    case 'claimDecline':
      applyClaim({
        kind: 'decline-confirmed',
        hasLiveConnection: conn !== undefined && !conn.linkFrozen(),
      });
      return DONE;
    case 'deleteAccount':
      applyPrivacy({ kind: 'delete-confirmed', hasLiveConnection: privacyLinkLive() });
      return DONE;
    case 'cancelAccountDeletion':
      applyPrivacy({ kind: 'cancel-deletion-requested', hasLiveConnection: privacyLinkLive() });
      return DONE;
    case 'requestDataExport':
      applyPrivacy({ kind: 'export-requested', hasLiveConnection: privacyLinkLive() });
      return DONE;
    default:
      return command satisfies never;
  }
}

/** A command the battle refuses (CTL6C.3): the stack holds a battle base and the command is not
 *  battle-safe. Its reason goes to the status line (until the battle is over, `syncStack`) and the
 *  live region; a refusal is not an error, so nothing reaches the error ring. No sync here: every
 *  batch re-derives the base (`reconcileStack`) before any listener that dispatches. A link drop
 *  can leave it a frame stale, where a refusal on the frozen link changes nothing. */
function refusedInBattle(command: Command): boolean {
  if (!battleRefused(contextStack, command)) return false;
  const reason = i18nT('menu.disabled.inBattle');
  if (statusEl !== undefined) statusEl.textContent = reason;
  shownBattleRefusal = reason;
  liveRegion.announce(reason, performance.now());
  return true;
}

/** A PvP action. pvpPendingTurnNumber is set INSIDE the lambda so sendGuarded's frozen check runs
 *  first — a frozen-link click must not lock the pending submit permanently (the turn never
 *  advances on a dropped send) — and cleared on rejection. The explicit refresh paints the
 *  client-local pending flag: an unchanged battle row no longer re-notifies the batch. */
function sendPvpAction(where: string, battleId: bigint, action: PvpAction): Promise<void> {
  return sendGuarded(where, () => {
    pvpPendingTurnNumber = store.latestPlayerBattle(identity)?.turnNumber ?? null;
    refreshBattle();
    return conn
      ?.live()
      ?.reducers.submitPvpAction({ battleId, action })
      ?.catch((err: unknown) => {
        pvpPendingTurnNumber = null;
        refreshBattle();
        throw err;
      });
  });
}

/** Apply a stack move: close every frame `next` drops, top first (the order the retired Escape
 *  ladder closed them in, so privacy's dismiss flush still finds the claim shown), each through
 *  its own path; then re-mirror, so the stack again lists exactly what is shown. */
function applyStack(prev: Stack, next: Stack): void {
  for (const frame of stackDiff(prev, next).closed) closeFrame(frame);
  syncStack();
}

function closeFrame(frame: UpperFrame): void {
  // A text-entry frame is typing over its owner: stopping it closes nothing.
  if (frame.kind === 'textEntry') return;
  switch (frame.id) {
    case 'dialogueView':
      // A server conversation is ended, never hidden: its frame stays until the row goes.
      void dispatch({ kind: 'dismissDialogue' });
      break;
    case 'battleView':
      // The terminal outcome continues: latch it so the next batch never re-pops it.
      dismissedBattleId = continuedBattleId(store.latestPlayerBattle(identity), dismissedBattleId);
      battleView?.hide();
      lastBattleVM = null;
      break;
    default:
      // The view's own hide path, so its close callbacks run (CTL3.3); never a hidden one.
      if (overlayProbes[frame.id]()) overlayHandles[frame.id]?.();
  }
}

// Where focus goes when typing stops: the first control in the field's frame that is not itself
// a text field, so the frame's focus trap keeps it and the next Escape routes as Start.
const STOP_TYPING_TARGETS = 'button, select, input, textarea, [tabindex]:not([tabindex="-1"])';
function stopTyping(field: HTMLElement): void {
  const root = field.closest('[aria-modal="true"]');
  const next = [...(root?.querySelectorAll<HTMLElement>(STOP_TYPING_TARGETS) ?? [])].find(
    (el) => typingKey(el, { code: 'Escape' }) === undefined && !el.hasAttribute('disabled'),
  );
  field.blur();
  next?.focus();
}

// Outcome-frame lifecycle (M8.7e): the dismissed battle id (so a resolved outcome
// renders once but never re-pops) + whether any battle has been observed this
// session (first-sight pre-dismiss of a historical/stale-on-login resolved battle).
let dismissedBattleId: bigint | null = null;
let battleSynced = false;
// VM-compare guard: last rendered BattleViewModel — used by shouldSkipBattleRefresh
// to suppress equal-VM re-renders (churn prevention). Reset to null on hide + reset.
let lastBattleVM: BattleViewModel | null = null;

// --- M13.5b status surface ------------------------------------------
// A minimal dynamically-created status line (no toast system — a deliberate
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
  // unify UI/reducer failures into the error ring so the F9 bundle captures them.
  pushError('reducer', text);
}

/** Clear the status line (on reconnect: the frozen-link message is stale, A8). */
function clearStatus(): void {
  if (statusEl !== undefined) statusEl.textContent = '';
}

// --- F9 bug-bundle observability rings + error overlay -----------
// The rings are the SESSION buffer (survive reconnect/zone-switch — only the emit
// latches re-baseline). tMs comes from Date.now() in production; the rings inject the
// clock so their unit tests stay deterministic. The overlay is mounted in main().
const eventRing = new EventRing(() => Date.now());
const errorRing = new ErrorRing(() => Date.now());
let errorOverlayView: ErrorOverlayView | undefined;
// Re-entrancy guard: if rendering the overlay itself throws and re-enters pushError,
// short-circuit so a render fault cannot recurse into a stack overflow.
let handlingError = false;
// Collapses a CONSECUTIVE 60Hz thrower to ONE ring slot.
let lastFrameErrorMessage: string | null = null;

/** Record an error into the ring and reflect it in the overlay. TOTAL (never throws to
 *  the caller): a render/ring fault routes to console.error. */
function pushError(source: ErrorSource, raw: unknown): void {
  if (handlingError) return;
  handlingError = true;
  try {
    errorRing.push(source, raw);
    if (errorOverlayView) {
      // The movement breadcrumb is BUNDLE-bound, never OVERLAY-bound. This ring
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
 * Non-movement reducer send guard. While the link is frozen it
 * SHORT-CIRCUITS with "disconnected — try again" and NEVER calls the reducer: a call
 * against a dead conn is silently queued on the dead instance and its promise never
 * settles (no-settle-on-drop) — the dead-button black hole. Otherwise it attaches
 * the rejection route: reduceErrorMessage passes SenderError reasons through and
 * never leaks InternalError detail. Documented exceptions (A10): enqueueMove
 * (movement — silent prediction repair in sendIntent, M2 §3), joinGame (handled in
 * connection.ts, A4), and the overlay-feedback actions (care, shop buy/sell, trade,
 * rename, trade-propose — routed through performCare in main(), A6).
 * ALWAYS resolves (frozen, dead handle, reported rejection) — views holding an
 * in-flight lock `return` it so the lock lives exactly until the call settles.
 */
function sendGuarded(where: string, call: () => Promise<void> | undefined): Promise<void> {
  if (conn === undefined || conn.linkFrozen()) {
    reportError(tf('chrome.status.disconnected', { where }));
    return Promise.resolve();
  }
  const p = call();
  if (p === undefined) return Promise.resolve();
  return p.catch((err: unknown) => reportError(reduceErrorMessage(err, where)));
}

/**
 * The live reducer handle for a performCare `call` thunk, or `undefined` when the link is
 * frozen/disconnected — a call against a dead conn is silently queued and never settles, so
 * performCare must see `undefined` and show the disconnected line instead of hanging.
 */
function liveReducers() {
  return conn === undefined || conn.linkFrozen() ? undefined : conn.live()?.reducers;
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
  // the rebuilt predictor must never re-issue a seq already
  // sent on this socket — otherwise the server rejects the player's first post-warp
  // move as "stale seq" and it is (correctly, same-epoch) evicted. Floor the fresh
  // instance to the highest seq ever sent; the gap this leaves is legal because the
  // server's stale-seq guard is monotonic, not consecutive.
  predictor.seedSeq(lastSentSeq);
  resolver.reset();
  held.clear();
  sawFractionalOwnMotion = false;
  dismissedBattleId = null;
  battleSynced = false;
  lastBattleVM = null;
  // Pending PvP submit state must be cleared on reconnect/zone-switch — the
  // server will have GC'd the old battle and any pending action is no longer relevant.
  pvpPendingTurnNumber = null;
  // Reset camera hold so a fresh zone/reconnect starts at origin rather than
  // holding a position from a prior zone.
  lastCamX = 0;
  lastCamY = 0;
  // re-baseline the event-emit latches (NOT the rings — those are the
  // session buffer). After a reconnect/zone-switch the old battle is GC'd and the rating
  // baseline must be re-seeded from the first fresh batch, not carried across.
  activeBattleId = null;
  lastOwnRating = null;
}

// --- M12.5c: idempotent zone-switch --------------------------------
// Validates the new zone's map BEFORE mutating any state (12.5c-3: parse-first).
// Does NOT call store.resetCharacters(): the render filter (currentZoneId) excludes
// stale-zone characters, so idle remotes in the destination zone stay visible.
// Idempotent: a no-op if newZoneId already matches rawMap (prevents double-switch when
// both onOwnWarp and the reconcile listener fire on the same live warp).

// e-2 (M13.5e): track consecutive zone-switch failures so stale content is surfaced.
let zoneSyncFailureCount = 0;

function switchZone(newZoneId: number): void {
  if (newZoneId === rawMap.zone_id) return;
  try {
    // capture the origin zone BEFORE the commit overwrites rawMap.
    const fromZone = rawMap.zone_id;
    const newRawMap = zone_map(newZoneId);
    TileMap.fromRaw(newRawMap); // validate BEFORE any mutation — throws on bad data
    renderer?.setMap(newRawMap); // draw BEFORE committing zone state (RT-SZ-01: atomicity)
    set_active_zone(newZoneId);
    rawMap = newRawMap;
    telemetry.setZone(newZoneId);
    // Preserve the held stack across the WARP rebuild only — the
    // reconnect arm's clear is load-bearing (per-path invariant).
    const heldSnapshot = held.snapshot();
    resetPredictionState();
    held.restore(heldSnapshot);
    zoneSyncFailureCount = 0; // success: reset streak
    // emit the zone-change event ONLY on the success path, after set_active_zone.
    eventRing.push(makeZoneChange(fromZone, newZoneId));
  } catch (err) {
    console.error('[zone-sync] zone switch to %s failed — keeping current zone', newZoneId, err);
    zoneSyncFailureCount++;
    if (shouldReportZoneSyncFailure(zoneSyncFailureCount)) {
      reportError(i18nT('chrome.status.contentStale'));
    }
  }
}

// --- reconcile own character on every coherent (batched) authoritative snapshot --
// extracted to a module-scope TOTAL function so BOTH callers share
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
    // still reflects the phantom — self-heals on the next batch reconcile.
    if (own === undefined || player === undefined) return;

    // State-based zone sync — catches reconnect-strand (a character
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
    // single-sourced rebasing baseline (convert.ts) stays the one rule.
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
    // predictor.reconcile is inside the outer try-catch: a wasm throw
    // here is contained and never starves sibling batch listeners.
    const diverged = predictor.reconcile(baseline, own.row.moveQueue, ackedSeq, now);
    telemetry.recordReconcile();
    if (diverged) telemetry.recordCorrection();
    // Honor reconcile's documented divergence return: on a genuine server
    // pullback, re-commit the held direction so a held key keeps walking from the
    // corrected baseline (same held-state-guarded dedup + hold-commit tap/hold
    // discrimination as the rAF frame loop).
    // gate this second continuation emitter on the same outstanding-work
    // predicate as the rAF loop. Cost is bounded by the next authoritative batch
    // (<= ~STEP_MS + RTT), never stuck: every server-side queue mutation writes the
    // character row, and the reject path force-reconciles here.
    if (diverged && predictor.outstandingSteps === 0 && movementGate()) {
      const heldDir = reissueDir(held.committedActive(now), predictor.lastQueuedDir);
      if (heldDir !== undefined) sendIntent({ Step: heldDir });
    }
  } catch (err) {
    console.error('[reconcile] uncaught error', err);
  }
}
// Server truth into the context stack, FIRST of the UI listeners: what a battle or a
// conversation drops is closed before any later listener shows the battle or the dialogue.
store.onBatchApplied(() => reconcileStack());
store.onBatchApplied(() => {
  // Belt: reconcileFromStore is total by construction (internal catch above); keep
  // the listener-level catch anyway so a future edit inside the body can
  // never starve sibling batch listeners.
  try {
    reconcileFromStore();
  } catch (err) {
    console.error('[reconcile] uncaught error in batch listener', err);
  }
});

// --- input: predict locally + send the intent to the M2 reducer (seq-tracked) ----
// highest seq ever handed to enqueueMove — the seedSeq floor for rebuilds.
let lastSentSeq = 0;

// --- movement-rejection diagnostics -----------------------------
// Rejections stay SILENT to the player (M2 §3), so an F9 bundle from a rubber-banding
// session used to show nothing. Two sinks close that: the flag-gated console fate line
// and a rate-limited errorRing breadcrumb (bundle-only, overlay-filtered). ONE prefix
// const feeds both the formatter and that filter, so they cannot drift apart.
const MOVE_REJECT_PREFIX = 'movement-reject ';
// 16 breadcrumbs leave >= 48 of the 64 ring slots for real crash records.
// `minGapMs`, not `windowMs` — the substring `window` reds the dev-observability eval.
const MOVE_REJECT_POLICY = { minGapMs: 3_000, cap: 16 };
// MODULE scope: inside the helper this would re-initialise per rejection and the gap and
// the cap would both silently do nothing.
let moveRejectLimit = RATE_LIMIT_INITIAL;
// DEV e2e observability — intents actually issued / rejection callbacks seen.
let moveSendCount = 0;
let moveRejectCount = 0;
/** Record one rejected movement intent. TOTAL — see the catch. */
function noteMoveRejection(seq: number, dropped: boolean): void {
  try {
    moveRejectCount += 1; // Every rejection callback, dropped or not
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
  // Single choke point for the movement freeze: the keydown first
  // step, the frame-loop held re-issue, AND the reconcile-listener divergence
  // re-issue all route through here, so this one gate covers every movement path.
  // No prediction against a dead link either — enqueue is skipped, not just the send.
  if (conn === undefined || conn.linkFrozen()) return;
  const intent = predictor.enqueue(input);
  if (intent === undefined) return; // Declined (queue at cap) — predict & send nothing
  const seq = intent.seq;
  const epoch = intent.epoch;
  lastSentSeq = seq; // nh3 Case-M2 floor: reached only when the reducer call below is issued
  moveSendCount += 1; // Every intent issued to the reducer (DEV e2e send budget)
  const t0 = performance.now();
  // Conn.conn widened to `DbConnection | undefined`; live() is the guarded read.
  // Unreachable-undefined given the frozen gate above (G26 invariant), but tsc requires the check.
  const live = conn.live();
  if (live === undefined) return;
  const sent = live.reducers.enqueueMove({ input: moveInputToSdk(input), seq: BigInt(seq) });
  sent
    .then(() => {
      // RTT sample — self-guarded (AM8) so no fault here can reach the rejection handler.
      try {
        telemetry.recordRtt(performance.now() - t0);
      } catch {
        // swallowed (AM8)
      }
    })
    .catch(() => {
      // Movement rejections stay SILENT to the user (M2 §3) — prediction repair only.
      // This closure captures ONLY PRIMITIVES —
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
      // Burst rejections (N rejects → N drop+reconcile microtasks in one
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

// The input pipeline (design §12): the keyboard source maps keys through the ONE binding
// table into `{button, down}` edges; the pure router decides what each edge does. The router
// owns the D-pad and X (Jump), plus A, B and Y while the main menu is up, and hands every other
// button (and a nav-capable screen's D-pad) to the top frame's adapter; what that leaves unhandled
// is the legacy ladder's below.
const keyboard = new KeyboardSource(ROUTED_BINDINGS);
const inputRouter = new InputRouter();

// What the router needs to know: whether the world takes input, the nav frame (a nav-capable
// screen on top, else the main menu, on top or covered by a legacy frame) plus the clock its
// auto-repeat runs on, and the top frame's adapter.
const routeCtx = (): RouteContext => {
  const worldActive = movementGate(); // first: it syncs the stack the rest reads
  const place = menuPlace();
  const now = performance.now();
  let nav: RouteContext['nav'];
  if (screenHost.takesNav(contextStack)) {
    nav = { covered: false, now, screen: true };
  } else if (place !== 'absent') {
    nav = { covered: place === 'covered', now };
  }
  return {
    worldActive,
    nav,
    // The battle's own rules first (Start opens the menu over it, A continues its outcome).
    screen: (btn) =>
      battleButton(
        contextStack,
        btn,
        outcomeShownAtMs === null ? undefined : performance.now() - outcomeShownAtMs,
      ) ?? screenHost.button(contextStack, btn, screenCtx),
  };
};

// Apply one router effect to the movement seam, the menu, or a screen command.
const applyRouterEffect = (effect: RouterEffect): void => {
  switch (effect.kind) {
    case 'dirDown':
      // Dual-key dedup: the router reports every press at the world, so a second key or
      // source for an already-held dir must not fire another ungated first step (pure not-emit).
      if (!held.isHeld(effect.dir)) step(effect.dir); // immediate first step (latency + deliberate double-tap)
      held.press(effect.dir, performance.now()); // mark held (stamped) so the frame loop re-issues it once hold-committed
      break;
    case 'dirUp':
      held.release(effect.dir); // a still-held key falls back to the most-recent (M8.6c)
      break;
    case 'jump':
      jump(); // Jump does not hold-repeat
      break;
    case 'nav':
      applyMenuStep(mainMenuStep(menuState, effect.input));
      break;
    case 'command':
      void dispatch(effect.command);
      break;
    default:
      effect satisfies never;
  }
};

// Route one edge and apply its effects; true when the router consumed it.
const routeEdge = (edge: ButtonEdge): boolean => {
  const { consumed, effects } = inputRouter.route(edge, routeCtx());
  for (const effect of effects) applyRouterEffect(effect);
  return consumed;
};

// Codes whose press the menu or a nav-capable screen consumed: their OS key-repeats are cancelled
// until the keyup, so a held Enter that opened a child cannot activate the child's focused button.
const navHeldCodes = new Set<string>();

// Drop every held button so nothing stays "held" while the page cannot see the keyup.
const releaseAllInput = (): void => {
  keyboard.releaseAll();
  inputRouter.releaseAll();
  navHeldCodes.clear();
  held.clear();
};

// Router-consumed keys (the D-pad, Space) carry native browser defaults (page scroll) that
// MUST be cancelled on the handler's EARLY-RETURN paths too — an open overlay makes the
// document taller than the viewport-sized canvas, so those defaults scroll the game out from
// under the player. Each OS key-repeat keydown carries its own default, so suppressing only
// the first one would leave a held arrow key scrolling on every repeat tick. A chord, or a key
// the focused element owns (typing, a button's Space), is never cancelled.
const suppressNativeMovementDefault = (e: KeyboardEvent): void => {
  const button = keyboard.buttonFor(e.code);
  if (
    button !== undefined &&
    routerConsumes(button) &&
    !isChord(e) &&
    ownership(e.target, e) === 'router'
  )
    e.preventDefault();
};

// the scoped world-focus gate for the twelve overlay-open
// hotkeys. The `=== document.body` disjunct is LOAD-BEARING and must never be "cleaned up":
// a store-driven render(null) blurs a focused control back to <body>, and without
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

// the stale-focus discriminator.
// After a close, real Chromium leaves document.activeElement on a node INSIDE the hidden
// overlay for up to ~200 ms (its blur fixup is async, and closeOverlayA11y's explicit
// restore to <body> is a no-op there because <body> carries no tabindex) — so the close
// edge's worldHasFocus() reads a stale anchor and focus never returns to the world.
// Inline `style.display = 'none'` is this repo's ONE hiding idiom — every overlay in both
// shell families hides that way — so the ancestor walk is the exact discriminator, and it
// is engine-independent. `checkVisibility()` was rejected: this happy-dom version does not
// implement it, which would make the unit-tier proof vacuous. The walk cannot match the
// always-on hint-bar chips (they and every ancestor are display-visible), so the D4
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

const onKeyDown = (e: KeyboardEvent): void => {
  // The session terminal outranks every input path — checked FIRST,
  // before the typing branch, the menu intercept and the router.
  // Suppress the native default (not a bare return) so a held arrow does not scroll on key-repeat.
  // biome-ignore format: keep the session gate a single line.
  if (sessionGateBlocks()) { suppressNativeMovementDefault(e); return; }
  // Ctrl/Alt/Meta chords belong to the browser (Ctrl+P prints): no hotkey, no movement and
  // no preventDefault. Before every hotkey below, so no letter branch can claim one.
  if (isChord(e)) return;
  if (e.repeat) {
    // ignore OS key-repeat (the frame loop re-issues held keys) — but still cancel its default
    suppressNativeMovementDefault(e);
    if (navHeldCodes.has(e.code)) e.preventDefault();
    return;
  }
  // a press can arrive INSIDE the stale-focus window, before the frame edge has run — heal
  // first, so the twelve gates read the healed state.
  if (focusInsideHiddenSubtree()) worldCanvasEl?.focus();
  // F9 downloads the local bug bundle; F8 dismisses the error overlay.
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
  // An Escape that cancels an IME composition is the IME's: not prevented and not routed, and kept
  // from the field's own Escape listener, which would close the frame and drop the draft.
  if (e.code === 'Escape' && (e.isComposing || e.keyCode === 229)) {
    e.stopPropagation();
    return;
  }
  // Typing mode (CTL6B.5): Escape in the focused text field stops typing. Focus leaves the field,
  // its text stays, and the view's own Escape (a close) never runs; the next Escape is Start. A
  // stale target (focus already healed away from a closed frame's field) is not typing.
  if (
    typingKey(e.target, e) === 'stopTyping' &&
    e.target instanceof HTMLElement &&
    e.target === document.activeElement
  ) {
    stopTyping(e.target);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // This key's button edges, computed once: KeyboardSource reads a second keydown of a code it
  // holds as a lost keyup, so the event is routed at exactly one site.
  let edges: readonly ButtonEdge[] | undefined;
  const keyEdges = (): readonly ButtonEdge[] => {
    edges ??= keyboard.keydown(e);
    return edges;
  };
  // While the main menu or a nav-capable screen is the top frame the router drives it (the D-pad,
  // A, B, Y; held D-pad repeats come from the frame loop), so this precedes every movement and
  // hotkey path below. Unconsumed keys (accelerators) fall through to the ladder, unrouted a
  // second time.
  if (menuPlace() === 'top' || screenHost.takesNav(contextStack)) {
    let consumed = false;
    for (const edge of keyEdges()) consumed = routeEdge(edge) || consumed;
    if (consumed) {
      navHeldCodes.add(e.code);
      e.preventDefault();
      return;
    }
  }
  if (e.code === 'KeyB') {
    // the 12-term guard list is GONE — one verdict from the registry
    // reproduces it exactly. WHAT THE LIST USED TO SAY IN PLACE, recorded here because the
    // old guard list was its last statement in main.ts (KeyI/KeyE below share
    // this note): modals are GUARDED, NEVER DISMISSED. `canOpen` DENIES over every GUARD_ONLY
    // overlay — dialogue, questLog, heal, shop, trade, pvp, leaderboard, rename, tradePropose,
    // help — and over a live battle (EXCLUSIVE_TOP; the main menu is filtered out by
    // `overlayVerdict`, ctl-5); the only ids it ever returns in
    // `forceHide` are the box/raising/evolution HIDE_SWITCH siblings this trio legitimately
    // switches between. Silently dismissing a modal on a stray keypress is wrong UX, and for
    // dialogue it is a server desync. The tier table (ui/overlayRegistry.ts)
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
    // comment records why modals are guarded rather than dismissed and why
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
    // Quest log overlay — mutual exclusivity with all other overlays,
    // through the ONE registry verdict. Self is exempt, so the toggle-close
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
    // Trade overlay — mutual exclusivity with all other overlays.
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
    // PvP challenge overlay — mutual exclusivity with all other overlays.
    // Not available during an active battle (exit ordering) — the registry's
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
    // Leaderboard overlay — mutual exclusivity with all other overlays.
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
  // KeyN opens the profile-rename overlay — the first text-input
  // overlay. Mutual exclusion is the ONE registry verdict (self exempt). On open:
  // held.clear() (RT-RN-01 D3-3) so no held movement key straddles the open/close boundary,
  // render the current name from store.player(identity)?.name (D6), then show (deferred focus).
  // e.preventDefault() (RT-RN-05) stops the opening 'n' from reaching the field.
  if (e.code === 'KeyN') {
    e.preventDefault(); // suppress the opening 'n' char reaching the field.
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
  // KeyO opens the trade-PROPOSE overlay ("Offer"). Mutual-exclusion
  // is the ONE registry verdict. identity !== '' (red-team L-1) so we
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
    // INTERACT (generalizes the old TALK key):
    // only while movement is enabled (the same gate as the on-world prompt, so the prompt
    // never advertises a target T refuses), resolve the nearest interactable
    // (store.allNpcs() joined to character rows + heal tiles, same zone,
    // Manhattan <= TALK_RANGE of the own AUTHORITATIVE tile) and dispatch by kind:
    // dialogue/shop share the ONE existing talk-reducer arm (greet-then-shop);
    // heal binds the heal overlay VIEW to the resolved location — no reducer
    // (interact opens UI, it never transacts). The client-side range check is
    // latency hygiene, NOT security — the server re-validates zone + range
    // (npc.rs talk; TALK_RANGE is game-core's, read via the talk_range() wasm export).
    // NOT a canOpen() site — interact opens no overlay of its own, so it
    // has no id to exempt and its guard is the plain movement gate.
    if (movementGate() && identity !== '') {
      interactAtNearest();
    }
    e.preventDefault();
    return;
  }
  // the account/claim front door. carriesIdentity is FALSE on
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
  // The router owns the D-pad and Space from here: it swallows them while an overlay is open
  // (the page-scroll fix), walks or jumps at the world, and skips keys the target owns.
  if (edges !== undefined) return; // already routed at the menu intercept
  let consumed = false;
  for (const edge of keyEdges()) consumed = routeEdge(edge) || consumed;
  if (consumed) e.preventDefault();
};
// Sync the context stack on both sides of every keydown: before, so an overlay opened since
// the last frame outside a keydown or batch (a click, a connection callback) is pushed (clearing held) before this key can close it; after,
// so whatever this key opened or closed is mirrored at once.
const handleKeyDown = (e: KeyboardEvent): void => {
  try {
    syncStack();
    onKeyDown(e);
  } finally {
    syncStack();
  }
};
// Escape is routed in the CAPTURE phase, so a view's own stopPropagation can no longer trap it
// (B5: Escape was dead inside rename and trade-propose). Every other key keeps the bubble phase,
// where those views' stopPropagation still shields their fields from the letter ladder until
// their ctl-8 screens replace them.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.code === 'Escape') handleKeyDown(e);
  },
  true,
);
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') handleKeyDown(e);
});

// A release ends a hold only when the last key or source holding that direction lets go.
window.addEventListener('keyup', (e) => {
  navHeldCodes.delete(e.code);
  for (const edge of keyboard.keyup(e)) routeEdge(edge);
});

window.addEventListener('blur', releaseAllInput);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') releaseAllInput();
});

// --- box/party view: refresh on batch when visible ---------------
function refreshBox(): void {
  if (!boxView?.visible || identity === '') return;
  const monsters = store.ownMonsters(identity);
  const speciesMap = store.speciesMap();
  // The same authored-edge set feeds both lists, so a boxed monster and a party
  // monster badge identically (the badge is computed in boxModel's shared toCard).
  const paths = [...store.evolutionPaths()];
  boxView.refresh(
    buildPartyViewModel(monsters, speciesMap, PARTY_SIZE, paths),
    buildBoxViewModel(monsters, speciesMap, PARTY_SLOT_NONE, paths),
  );
}
store.onBatchApplied(() => refreshBox());

// --- raising/inventory view: refresh on batch when visible -------
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

// --- evolution view: refresh on batch when visible ---------
// MUST be total (never throw): defense-in-depth — store.flushBatch has per-listener
// try/catch since M10.5d, but a throwing function here signals a logic bug.
function refreshEvolution(): void {
  if (!evolutionView?.visible || identity === '') return;
  const monsters = store.ownMonsters(identity);
  const speciesMap = store.speciesMap();
  evolutionView.refresh(buildEvolutionViewModel(monsters, speciesMap, [...store.evolutionPaths()]));
}
store.onBatchApplied(() => refreshEvolution());

// --- battle view: refresh on batch, auto-show/hide --------
function refreshBattle(): void {
  if (!battleView || identity === '') return;
  // The ONE view-perspective projection in the client — it re-seats
  // the local player as sideA so a PvP accepter (stored in opponentIdentity) gets their
  // OWN cards/skills/bench from a view layer that hardcodes sideA = the local player.
  // Every OTHER read of these accessors (diagnostics, observability) stays RAW by design.
  const latest = ownPerspective(store.latestPlayerBattle(identity), identity);
  const r = decideBattleOverlay(latest, { dismissedBattleId, synced: battleSynced });
  dismissedBattleId = r.dismissedBattleId;
  battleSynced = r.synced;
  if (r.action.kind === 'show') {
    // What the battle drops was already closed by this batch's `reconcileStack` (SCREEN_POLICY).
    // Build baitItems from own inventory × item defs (12.5f-5: wire the 4th arg
    // that was already present in buildBattleViewModel with default []). The
    // function classifies by recruitBonus > 0 internally (classify-by-data).
    const baitItems: BaitItem[] = store.ownInventory(identity).flatMap((inv) => {
      const def = store.itemDef(inv.itemId);
      if (!def) return [];
      return [
        { itemId: inv.itemId, name: def.name, recruitBonus: def.recruitBonus, count: inv.count },
      ];
    });
    // Build cureItems from own inventory × item defs: classify by cureStatus !== null.
    // Available in any ongoing battle (not wild-only).
    const cureItems: CureItem[] = store.ownInventory(identity).flatMap((inv) => {
      const def = store.itemDef(inv.itemId);
      if (!def || def.cureStatus === null) return [];
      return [{ itemId: inv.itemId, name: def.name, cureStatus: def.cureStatus, count: inv.count }];
    });
    // Clear pvpPendingTurnNumber when the server has resolved the turn (turnNumber
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
    // VM-compare guard: skip refresh when the view is visible and the VM is
    // structurally identical to the last rendered VM (suppresses churn on no-op ticks).
    // The visible guard is the primary defense: shouldSkipBattleRefresh returns false
    // while hidden, so a re-show always triggers a full render. The lastBattleVM = null
    // reset in closeFrame (the outcome continue) is invariant hygiene on top.
    if (shouldSkipBattleRefresh(battleView.visible, lastBattleVM, vm)) return;
    battleView.refresh(vm);
    lastBattleVM = vm;
  } else if (battleView.visible) {
    battleView.hide();
    lastBattleVM = null;
  }
}
store.onBatchApplied(() => refreshBattle());

// --- dialogue dismiss + deferred shop open (ui/shopOpenModel.ts) ----------------------
function stepShopOpen(event: ShopOpenEvent): void {
  const next = shopOpenStep(shopOpen, event);
  shopOpen = next.state;
  switch (next.effect?.kind) {
    case undefined:
      break;
    case 'sendDismiss':
      sendDismiss(next.effect.path);
      break;
    case 'openShop':
      openPendingShop(next.effect.shopId);
      break;
    default:
      next.effect satisfies never;
  }
}

/** Send dismiss_dialogue. `delivered` turns true only once a reducer promise exists, so a
 *  frozen link or a missing live handle reports `dismissNotSent` and leaves no in-flight flag
 *  behind (B8). The rejection rethrows, keeping sendGuarded the single status reporter. */
function sendDismiss(path: DismissPath): void {
  let delivered = false;
  void sendGuarded('dismiss', () => {
    const p = conn?.live()?.reducers.dismissDialogue({});
    if (p === undefined) return undefined;
    delivered = true;
    return p.catch((err: unknown) => {
      stepShopOpen({ kind: 'dismissRejected', path });
      throw err;
    });
  });
  if (!delivered) stepShopOpen({ kind: 'dismissNotSent', path });
}

/** The greet-then-shop open, on the first no-conversation batch. Dropped, never retained, when
 *  a battle, its outcome or another frame holds the screen (a battle that began during the
 *  dismiss round-trip must not get a shop stacked over it). */
function openPendingShop(shopId: number): void {
  // Re-sync first: a battle or outcome this batch's earlier listeners showed must block.
  syncStack();
  if (blocksPlayerOpen(contextStack)) return;
  boundShopId = shopId;
  shopView?.render(
    buildShopViewModelForShop(
      shopId,
      store.allShops(),
      store.allShopItems(),
      store.itemDefs(),
      store.ownInventory(identity),
      store.ownWallet(identity),
    ),
  );
  shopView?.show();
}

// --- M12d: dialogue / quest log / heal views --------------------------
// All 3 MUST be total (never throw): defense-in-depth (store.flushBatch has per-listener try/catch since M10.5d).
store.onBatchApplied(() => {
  try {
    const conv = store.ownConversation(identity);
    // A server-pushed conversation has already closed every player screen (reconcileStack).
    // e-4 guard (M13.5e): build npcsMap only when a conversation is open.
    // allNpcs() is O(n) — doing it on every batch is wasteful during normal play.
    // Reconnect-ordering assumption: NPC content rows arrive in the same batch as (or
    // before) the conversation row, so an active conv always finds its NPC in the map.
    // If ordering regresses, buildDialogueViewModel returns null → view hides safely.
    const allNpcs = conv !== undefined ? store.allNpcs() : [];
    const npcsMap = new Map(allNpcs.map((n) => [n.entityId, n]));
    const dialogueVm = buildDialogueViewModel(conv, npcsMap, DIALOGUE_TREES);
    dialogueView?.render(dialogueVm);
    // A no-conversation batch ends the in-flight dismiss and consumes the pending shop open.
    // Not the reconnect self-heal: on_disconnect keeps the player_conversation row while
    // another connection of the identity is live, so onReconnect resets the step itself.
    stepShopOpen({ kind: 'batch', conversationPresent: conv !== undefined });
  } catch (err) {
    console.error('[M12d] dialogue batch listener error', err);
  }
});

store.onBatchApplied(() => {
  // Quest log is user-toggled (KeyQ); only refresh when already open.
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
  // already open. While bound, refresh
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

// --- M13d: shop view batch listener -----------------------------------
// MUST be total (never throw): defense-in-depth (store.flushBatch has per-listener try/catch since M10.5d).
store.onBatchApplied(() => {
  if (!shopView?.visible || identity === '') return;
  try {
    // While bound to a shopkeeper's shop, refresh through
    // the bound-shop selector — a batch must never silently swap the visible
    // catalogue to the first-shop default. Unbound (defensive: the overlay now
    // only opens bound) keeps the first-shop default path unchanged.
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

// --- trade view batch listener ----------------------------------
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
    console.error('[trade] batch listener error', err);
  }
});

// --- PvP challenge overlay batch listener -----------------------
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
    console.error('[pvpView] batch listener error', err);
  }
});

// --- leaderboard batch listener -----------------------------------
// Refresh-only-when-visible: ratings/W/L stay live while the
// board is open as profile rows update. MUST be total (never throw): defense-in-depth
// (store.flushBatch has per-listener try/catch since M10.5d).
store.onBatchApplied(() => {
  if (!leaderboardView?.visible || identity === '') return;
  try {
    leaderboardView.render(buildLeaderboardViewModel(store.allProfiles(), identity));
  } catch (err) {
    console.error('[leaderboard] batch listener error', err);
  }
});

// --- battleStart / battleEnd emit listener -----------------------
// Dedicated batch listener (UNCONDITIONAL — not visibility-gated). battleEnd only fires
// for a battle we saw START (activeBattleId latch): a battle first-seen already terminal
// has activeBattleId !== its id, so neither branch fires — guarding a stale-terminal login.
store.onBatchApplied(() => {
  if (identity === '') return;
  try {
    const latest = store.latestPlayerBattle(identity);
    // re-baseline ONLY the battle that survived the drop, without
    // emitting. The latch resolves on the first flush AFTER hydration-complete (the
    // hydration latch): a pre-hydration flush — empty OR carrying an older surviving row — must not
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
    // wild battles carry the all-zero WILD_IDENTITY (!== player) but no owned
    // opponent party — identity-inequality alone mislabels them PvP. Use the party-guarded rule.
    const isPvp = isPvpBattle(latest);
    if (latest.outcome === 'Ongoing' && latest.battleId !== activeBattleId) {
      activeBattleId = latest.battleId;
      eventRing.push(makeBattleStart(latest.battleId.toString(), isPvp));
    } else if (latest.outcome !== 'Ongoing' && activeBattleId === latest.battleId) {
      activeBattleId = null;
      // `outcome` here is the SERVER-side tag — SideA is always the
      // challenger — and is deliberately NOT perspective-mapped, so a PvP accepter's ring
      // records SideAWins for their own loss. That is intentional: two players' event rings
      // and bug bundles must agree on who won. Do not "fix" this to the local perspective.
      eventRing.push(makeBattleEnd(latest.battleId.toString(), latest.outcome, latest.turnNumber));
    }
  } catch (err) {
    console.error('[obs] battle', err);
  }
});

// --- rankedMatch emit listener -----------------------------------
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
      // latestPlayerBattle() returns the highest-id battle of ANY kind, which
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

// --- post-evolve reveal banner --------------
// The HEAD entry only: Vec order IS display order and the ack drains a PREFIX, so the head is
// the one reveal a `count: 1` ack may acknowledge. The `null` arm hides the banner once the
// queue drains — without it the last sentence would stay on screen and every further OK reject.
// The render argument now carries the entry's `key` alongside its `label`, so the
// banner's announce sink can edge-trigger on identity rather than on copy that a late species
// name would still be changing under it.
store.onBatchApplied(() => {
  const head = store.ownEvolutionNotices(identity)[0];
  evolutionNoticeBanner?.render(
    head === undefined
      ? null
      : {
          key: evolutionNoticeKey(head),
          label: evolutionNoticeLabel(
            head,
            resolveEvolutionNoticeNames(
              head,
              store.ownMonsters(identity),
              (id) => store.species(id)?.name,
            ),
          ),
        },
  );
});

// The LAST batch listener: mirror every overlay this batch's listeners showed or hid (a
// server-opened dialogue, a battle auto-show) so its push clears held before the next frame.
store.onBatchApplied(() => syncStack());

// --- M12d: dialogue choice click handler -----------------------------------------
// Reads data-choice-idx from the clicked button and calls advance_dialogue.
document.addEventListener('click', (e) => {
  // The greet-then-shop button. It carries
  // data-shop-id and NO choice index, so it gets its own branch ABOVE the
  // choice delegation. It records the shop (last intent wins) and ends the conversation;
  // the open itself waits for the first no-conversation batch (stepShopOpen).
  const shopBtn = (e.target as HTMLElement).closest('[data-shop-id]') as HTMLElement | null;
  if (shopBtn !== null) {
    const clickedShopId = Number(shopBtn.dataset.shopId);
    if (!Number.isNaN(clickedShopId)) stepShopOpen({ kind: 'shopPicked', shopId: clickedShopId });
    return;
  }
  // The hint bar's Start chip (ctl-7a; it replaced the #help-hint badge): the click front door
  // to the menu. Delegated on the data-attribute, the house idiom in this listener. It carries
  // the SAME verdict the menu hotkey does, so a single verdict decides both. canOpen exempts
  // self, so with ONLY the menu visible this branch would re-open it; harmless, and a child
  // covering the menu denies by its own verdict. The identity guard is preserved: the menu's
  // screens read identity-keyed state. Opening clears held keys (CTL2.4). Like every input path,
  // a chip is dead while the session terminal owns the screen.
  if ((e.target as HTMLElement).closest('[data-menu-launcher]') !== null) {
    if (!sessionGateBlocks() && overlayVerdict('menuView').kind === 'allow' && identity !== '') {
      held.clear();
      openMenu();
    }
    return;
  }
  // The Select chip: Help, through the same verdict as the `?` hotkey (CTL7A.4). Help reads no
  // identity-keyed state, so, like `?`, it needs no identity.
  if ((e.target as HTMLElement).closest('[data-help-launcher]') !== null) {
    if (!sessionGateBlocks() && overlayVerdict('helpView').kind === 'allow') {
      held.clear();
      openHelp();
    }
    return;
  }
  const btn = (e.target as HTMLElement).closest('[data-choice-idx]') as HTMLElement | null;
  if (!btn) return;
  const raw = btn.dataset.choiceIdx;
  if (raw === undefined) return;
  const choiceIdx = parseInt(raw, 10);
  if (!Number.isNaN(choiceIdx)) void dispatch({ kind: 'advanceDialogue', choiceIdx });
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
    inventoryRowCount: store.inventoryRowCount,
    ownInventory: store.ownInventory(identity).map((i) => ({
      invId: i.invId.toString(),
      itemId: i.itemId,
      count: i.count,
    })),
    // The context stack, base-first and base included (above the base = length > 1). Read
    // as last synced, never synced here, so a read cannot stand in for a missing sync point.
    stack: [...contextStack],
    // The main menu's active entry key while it is open (under a child too), else null.
    navActive: menuView?.visible ? menuState.nav.item : null,
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

// Test hook exposing trade reducers + subscription queries for two-context e2e.
// Mirrors window.__game pattern. All BigInt values cross the page.evaluate boundary as
// strings; the hook converts them back to BigInt internally (BigInt cannot pass the
// structured-clone boundary used by Playwright evaluate).
//
// NOTE: this hook's shape is re-declared as MrTrade in client/e2e/trade-full.spec.ts.
// Both must be kept in sync manually — page.evaluate() crosses a structured-clone
// boundary that the type system cannot check across. See that file if you change any
// method signature or return shape here.
//
// NOTE: __game, __mrTrade, and __mrPvp are
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

// Test hook exposing PvP challenge/battle reducers + subscription reads for
// two-context e2e. Mirrors window.__mrTrade. All BigInt values cross the page.evaluate
// boundary as strings; the hook converts them back to BigInt internally (BigInt cannot
// pass the structured-clone boundary used by Playwright evaluate).
//
// NOTE: this hook's shape is re-declared as MrPvp in client/e2e/pvp-full.spec.ts.
// Both must be kept in sync manually — page.evaluate() crosses a structured-clone
// boundary that the type system cannot check across. See that file if you change any
// method signature or return shape here.
//
// NOTE: like __game and __mrTrade, this hook is DEV-gated
// — the window assignment below only exists when import.meta.env.DEV is true, and
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

// D-17.5-E: DEV-only test hooks. Only the window ASSIGNMENTS are gated —
// the hook consts above stay top-level (still referenced here, so no unused-var lint).
if (import.meta.env.DEV) {
  (window as unknown as { __game: typeof snapshot }).__game = snapshot;
  (window as unknown as { __mrTrade: typeof mrTradeHook }).__mrTrade = mrTradeHook;
  (window as unknown as { __mrPvp: typeof mrPvpHook }).__mrPvp = mrPvpHook;
}

// the build stamp is UNGATED — present in the production playtest build,
// the deliberate contrast with the DEV-gated debug hooks above. The M-playtest-b F9
// bug-report bundle reads window.__mrBuild to pin which build a finding came from; it carries
// only non-secret build metadata (short sha + timestamp), so there is no leak/authz concern.
(window as unknown as { __mrBuild: typeof BUILD_INFO }).__mrBuild = BUILD_INFO;

// Client-only bug bundle — NO network (works when the connection is the bug).
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
  // one timestamp for both the bundle body and the filename (they must match).
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
  // serialize INSIDE the try so a (bigint-total, but defense-in-depth) serialize
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
    reportError(i18nT('chrome.status.bugBundleBlocked'));
  }
}

async function main(): Promise<void> {
  // surface the build stamp in the non-intrusive corner element (#build-stamp
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
    // render/world.ts appends app.canvas to this same mount and puts
    // role="application"/tabindex="0" on it. It is out of this slice's touches:, so a
    // querySelector on the mount main.ts already holds is the only in-touches route.
    worldCanvasEl = mount.querySelector('canvas');
    installResizeHandler(renderer, window); // fit the stage to the window + on resize
    boxView = new BoxViewClass(mount, {
      onSetNickname: (monsterId, nickname) =>
        dispatch({ kind: 'setNickname', monsterId, nickname }),
      onSetPartySlot: (monsterId, slot) => dispatch({ kind: 'setPartySlot', monsterId, slot }),
      onHealParty: () => dispatch({ kind: 'healParty' }),
      partySlotNone: PARTY_SLOT_NONE,
    });
    // The PvE callbacks RETURN the promise (view lock until settle; M-1 pin).
    battleView = new BattleViewClass(mount, {
      onAttack: (battleId, skillId) => dispatch({ kind: 'attack', battleId, skillId }),
      onFlee: (battleId) => dispatch({ kind: 'flee', battleId }),
      onSwap: (battleId, teamIndex) => dispatch({ kind: 'swap', battleId, teamIndex }),
      onRecruit: (battleId, baitItemId) => dispatch({ kind: 'recruit', battleId, baitItemId }),
      onUseItem: (battleId, itemId) => dispatch({ kind: 'useItem', battleId, itemId }),
      onPvpAttack: (battleId, skillId) => dispatch({ kind: 'pvpAttack', battleId, skillId }),
      onPvpSwap: (battleId, teamIndex) => dispatch({ kind: 'pvpSwap', battleId, teamIndex }),
    });
    raisingView = new RaisingViewClass(mount, {
      onTrain: (monsterId, foodItemId) => dispatch({ kind: 'train', monsterId, foodItemId }),
      // Returned (not `void`ed) so the view's #pending lock holds until the reducer settles.
      onCare: (monsterId) => dispatch({ kind: 'care', monsterId }),
    });
    evolutionView = new EvolutionViewClass(mount, {
      onEvolve: (monsterId, toSpecies) => dispatch({ kind: 'evolve', monsterId, toSpecies }),
    });
    // dialogue / quest log / heal DOM shells.
    dialogueView = new DialogueViewClass();
    questLogView = new QuestLogViewClass();
    healView = new HealViewClass();
    // shop and trade DOM shells: buy/sell, the trade responses, rename and trade-propose all run
    // through the performCare core (frozen gate, await of the SDK promise, exactly one feedback
    // line) inside `dispatch`.
    shopView = new ShopViewClass({
      onBuy: (shopId, itemId) => dispatch({ kind: 'buy', shopId, itemId }),
      onSell: (itemId) => dispatch({ kind: 'sell', itemId }),
    });
    tradeView = new TradeViewClass({
      onAccept: (tradeId) => dispatch({ kind: 'respondTrade', tradeId, accepted: true }),
      onReject: (tradeId) => dispatch({ kind: 'respondTrade', tradeId, accepted: false }),
      onConfirm: (tradeId) => dispatch({ kind: 'confirmTrade', tradeId }),
      onCancel: (tradeId) => dispatch({ kind: 'cancelTrade', tradeId }),
    });
    // PvP challenge overlay: the lifecycle callbacks RETURN the promise.
    pvpView = new PvpViewClass({
      onChallenge: (targetIdentity) => dispatch({ kind: 'challenge', targetIdentity }),
      onAccept: (challengeId) => dispatch({ kind: 'acceptChallenge', challengeId }),
      onDecline: (challengeId) => dispatch({ kind: 'declineChallenge', challengeId }),
      onCancel: (challengeId) => dispatch({ kind: 'cancelChallenge', challengeId }),
    });
    // Leaderboard DOM shell. ZERO-arg construction — RL-15: the
    // leaderboard is a pure subscription view; there is no client write path to profile.
    leaderboardView = new LeaderboardViewClass();
    // display-only help overlay — ZERO-arg construction (no callbacks,
    // leaderboardView precedent). Opened by Select (R or Slash); content is a static SSOT const.
    helpView = new HelpViewClass();
    // The menu view only paints and forwards clicks; keys reach the menu through the router.
    menuView = new MenuViewClass({ onInput: handleMenuPointer });
    // The guest-claim overlay. Its actions drive the pure claimModel;
    // the AUTHORITATIVE join veto lives in connection.ts's onApplied (G18), so these are UI-only.
    const claimHandlers: ClaimViewHandlers = {
      onSignIn: () => void dispatch({ kind: 'claimSignIn' }),
      onJoin: () => void dispatch({ kind: 'claimJoin' }),
      onDeclineRequested: () => applyClaim({ kind: 'decline-requested' }),
      onDeclineConfirmed: () => void dispatch({ kind: 'claimDecline' }),
      onDeclineCancelled: () => applyClaim({ kind: 'decline-cancelled' }),
      onPrivacy: () => openPrivacy(),
    };
    claimView = new ClaimViewClass(claimHandlers);
    const privacyHandlers: PrivacyViewHandlers = {
      onDeleteRequested: () => applyPrivacy({ kind: 'delete-requested' }),
      onDeleteConfirmed: () => void dispatch({ kind: 'deleteAccount' }),
      onConfirmCancelled: () => applyPrivacy({ kind: 'confirm-cancelled' }),
      onCancelDeletion: () => void dispatch({ kind: 'cancelAccountDeletion' }),
      onExportRequested: () => void dispatch({ kind: 'requestDataExport' }),
      onExportDownload: () => downloadExportBundle(),
      onDismissed: () => {
        applyPrivacy({ kind: 'confirm-cancelled' });
        // Flush a claim paint deferred while this overlay owned the screen.
        if (claimRenderPending) renderClaim();
      },
    };
    privacyView = new PrivacyViewClass(privacyHandlers);
    // The session-lifecycle overlay (registry-external). Its actions drive
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
    // Rename and trade-PROPOSE overlays: their own Enter (and submit click) commits through
    // `dispatch`; the view's #pending lock is reset by its own .finally().
    renameView = new RenameViewClass({
      onSubmit: (name) => dispatch({ kind: 'setProfileName', name }),
    });
    tradeProposeView = new TradeProposeViewClass({
      maxMonstersPerSide: MAX_TRADE_MONSTERS_PER_SIDE,
      onSubmit: (args: TradeProposeArgs) => dispatch({ kind: 'proposeTrade', args }),
    });
  }

  // create the status surface BEFORE `conn = connect(...)` is
  // assigned so no connection lifecycle callback can ever report into the void.
  const status = document.createElement('div');
  status.id = 'status';
  // ctl-7a: inside the game screen and out of the page flow (.mr-status), so a status line can
  // never add scroll height. The shell-less boot tests have no #game-screen: body is the fallback.
  const gameScreen = document.getElementById('game-screen') ?? document.body;
  // The frame layer hosts the runtime-built frames below (CTL7A.2); same body fallback.
  const frameLayer = document.getElementById('frame-layer') ?? document.body;
  status.className = 'mr-status';
  gameScreen.appendChild(status);
  statusEl = status;

  // ctl-7a: the hint bar's Start and Select chips name their verbs from the catalog (CTL7A.4).
  // Their clicks are delegated on [data-menu-launcher] / [data-help-launcher] below. The verbs
  // go through locals because the hardcoded-string scanner only exempts a bare `t(`, not the
  // `i18nT` alias main.ts must use.
  const chipVerbs = { start: i18nT('chrome.chip.menu'), select: i18nT('chrome.chip.help') };
  const startChip = document.getElementById('chip-start');
  if (startChip !== null) startChip.textContent = chipVerbs.start;
  const selectChip = document.getElementById('chip-select');
  if (selectChip !== null) selectChip.textContent = chipVerbs.select;

  // The on-world interact prompt — a small frame in the frame layer (.mr-frame--prompt:
  // pointer-events:none so it can NEVER shadow the document-level dialogue/shop click delegation;
  // z-index below the overlays; translate(-50%,-100%) hangs the label above the anchor, the
  // tile-top centre). The frame layer fills the viewport, so screenFor()'s viewport coordinates
  // are its coordinates. Positioned each frame via renderer.screenFor(...).
  const interactPromptEl = document.createElement('div');
  interactPromptEl.id = 'interact-prompt';
  interactPromptEl.className = 'mr-frame mr-frame--prompt';
  interactPromptEl.style.display = 'none';
  frameLayer.appendChild(interactPromptEl);
  // Memoized last-applied prompt state: style/text writes happen ONLY when the
  // (actionWord, screen position) key changes — never unconditionally per frame.
  let lastPromptKey = 'none';

  // The deletion-grace countdown banner — created at runtime beside
  // #interact-prompt, and deliberately NOT an overlay: it must be visible
  // WHENEVER the window is live, not only once the player opens something. It carries no
  // aria-live and no implicit-live role: a region that changes every second would interrupt an
  // assistive-technology user continuously; ui/liveRegion.ts stays the sole announcement owner.
  // A top-centred frame in the frame layer (.mr-frame--banner), styled by class (CTL7A.2/7A.3).
  const privacyCountdownEl = document.createElement('div');
  privacyCountdownEl.id = 'privacy-countdown';
  privacyCountdownEl.className = 'mr-frame mr-frame--banner';
  privacyCountdownEl.style.display = 'none';
  frameLayer.appendChild(privacyCountdownEl);
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

  // The post-evolve reveal banner — the same runtime-constructed,
  // non-overlay shape as the countdown above. OK acks exactly ONE entry (the head is the only
  // reveal on screen); the two benign stale-banner races are swallowed, everything else is
  // rethrown into sendGuarded's single status reporter.
  // the second constructor argument is the injected sink pair — `announce`
  // reaches the one live region through its existing singleton, `returnFocus` reaches the house
  // landing place. The banner itself decides WHEN each fires; this is only WHERE.
  evolutionNoticeBanner = new EvolutionNoticeBanner(
    () =>
      sendGuarded('ackEvolutionNotices', () =>
        conn
          ?.live()
          ?.reducers.ackEvolutionNotices({ count: 1 })
          .catch((err: unknown) => {
            if (!isBenignAckRejection(reduceErrorMessage(err, 'ackEvolutionNotices'))) throw err;
          }),
      ),
    {
      announce: (m) => liveRegion.announce(m, performance.now()),
      returnFocus: () => worldCanvasEl?.focus(),
    },
  );

  // mount the F9 error overlay (self-mounting, starts hidden,
  // non-blocking pointer-events:none). pushError renders into it on the first error.
  errorOverlayView = new ErrorOverlayView();

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

  conn = connect({
    uri: URI,
    db: DB,
    name: 'Player',
    store,
    // OIDC config from env. The `?? ''` fallback degrades gracefully
    // today (no issuer → the flow contacts no network, AUTH-44) and lights up once a real issuer is deployed.
    authIssuer: import.meta.env.VITE_MR_OIDC_ISSUER ?? '',
    authClientId: import.meta.env.VITE_MR_OIDC_CLIENT_ID ?? '',
    authRedirectUri: import.meta.env.VITE_MR_OIDC_REDIRECT_URI ?? '',
    // Undefined unless VITE_MR_DEVLOG is set — then the connection installs the
    // outbound-log Proxy. Bare identifier by design (no inline sink: the ring must stay
    // unreachable from the send path).
    onSend: sendLogger,
    onReady: (id) => {
      identity = id;
      // record the connect edge (identity-hex is the allowed field, U-3).
      eventRing.push(makeConnect(identity));
      resolveReady();
      // A successful connection clears any session terminal overlay.
      applySession({ kind: 'connected' });
    },
    // the store now holds the applied snapshot, so the reseed latch
    // may resolve on this flush. Set here, consumed by the battle emit listener.
    onHydrated: () => {
      hydratedSinceReconnect = true;
    },
    onReconnect: (id) => {
      // a rebuild can mint a NEW identity — refresh FIRST so every
      // identity-gated listener (and the connect event below) sees this connection's identity.
      identity = id;
      // the cached artifact is main.ts state, not store state, so store.reset()
      // cannot reach it — and a rebuild can mint a NEW identity. Dropped here so the previous
      // identity's personal-data export is never downloadable by the next one.
      exportAssembly = undefined;
      // Capture BEFORE resetPredictionState nulls activeBattleId; a 2nd drop while a
      // reseed is still pending must keep the FIRST capture (not overwrite it with null).
      if (!battleReseedPending) reseedPrevBattleId = activeBattleId;
      // Clean re-init: the store already dropped stale rows; rebuild prediction and
      // drop the own slide clock so the post-reconnect re-seed starts fresh.
      // Zone state is corrected by the reconcile listener's state-based check on
      // the first post-reconnect batch (12.5c-1 — no special zone logic needed here).
      resetPredictionState();
      // hide the rename overlay on reconnect — the store was reset (stale current-name),
      // and an in-flight submit will never settle on the dropped link. hide() also resets
      // the input value + feedback (stale-draft guard).
      renameView?.hide();
      // hide the trade-PROPOSE overlay on reconnect too. WITHOUT this, the view's #pending
      // lock survives the link drop (the SDK never settles the in-flight proposeTrade
      // promise) → dead submit button forever.
      tradeProposeView?.hide();
      // the same never-settling-promise class for the
      // dialogue dismiss lock. It used to self-heal through the server deleting the
      // player_conversation row on disconnect; that delete now runs only when the identity's
      // LAST live connection ends, so an overlapping reconnect re-delivers the row and the
      // lock would stay held forever (dead Escape-dismiss + dead greet-then-shop button).
      // The reset also drops a pending shop open, whose id the store reset invalidated.
      stepShopOpen({ kind: 'reconnect' });
      menuView?.hide(); // a menu child may read store state that the reset invalidated
      // A frame opened over a battle goes with the reset: a re-delivered row of that battle would
      // find it still stamped, keep it, and show the battle above it. Hidden, never dismissed: a
      // conversation is the server's to end.
      for (const f of contextStack) {
        if (f.kind === 'screen' && f.overBattle !== undefined && overlayProbes[f.id]()) {
          overlayHandles[f.id]?.();
        }
      }
      // re-baseline a surviving Ongoing battle on the next batch
      // instead of re-emitting a spurious battleStart for it. Armed until onHydrated —
      // reset UNCONDITIONALLY (unlike the guarded capture above) so a second drop re-arms
      // against ITS OWN hydration, never a stale one.
      battleReseedPending = true;
      hydratedSinceReconnect = false;
      // a buy/sell in flight at drop time never settles (SDK — no settle
      // on drop), so the shop's double-spend lock would stay held forever. hide()
      // resets it (shopView.ts is outside this slice's touch-set; the reset rides
      // the existing public hide()). Escape-only recovery during the gap (the
      // global shop hotkey is gone).
      shopView?.hide();
      // The same never-settling-promise class as the four hides above, for the privacy
      // surface's `inFlight` lock. Clearing the memo makes the next frame re-pump
      // `account-changed`, which clears `inFlight` — without it, a drop during an export requested
      // while the phase was already `unknown` (the ordinary guest state) leaves all three controls
      // disabled, with no notice, for the life of the page.
      lastPrivacyCountdown = undefined;
      // The store was reset, so a bound shop / heal id refers to rows that may no longer exist.
      boundShopId = null;
      boundHealLocationId = null;
      // trade's double-spend lock must also be reset on reconnect (same reason as shop).
      tradeView?.hide();
      // Hide the PvP overlay on reconnect — any pending challenge state is stale.
      pvpView?.hide();
      // Same never-settles class for the three settle-released locks (+ Care's);
      // a surviving battle re-shows (and refocuses) on the next batch.
      battleView?.hide();
      raisingView?.hide();
      evolutionView?.hide();
      // Hide the leaderboard on reconnect — the store was reset, so a stale/empty
      // board must not linger (no lock to reset; re-renders on the next open/batch).
      leaderboardView?.hide();
      // The "connection lost — reconnecting…" status line is now stale.
      clearStatus();
      // record the reconnect edge as a fresh connect (the refreshed identity).
      eventRing.push(makeConnect(identity));
      // A successful reconnect clears any session terminal overlay.
      applySession({ kind: 'connected' });
      // The same never-settles class, at the TAIL on purpose — store.reset()
      // runs on the drop edge and the post-rebuild flush is a later microtask, so a reset here can
      // never be re-disabled by a stale render.
      evolutionNoticeBanner?.reset();
    },
    // onOwnWarp delegates to switchZone (idempotent — no-op if rawMap
    // already matches). Fires on live-warp character onUpdate (lower latency path);
    // the reconcile listener's state-based check handles reconnect-strand (character
    // INSERTED at zone 0 with no onUpdate). Both paths are safe to call: switchZone
    // checks rawMap.zone_id before doing any work.
    onOwnWarp: (newZoneId) => {
      switchZone(newZoneId);
    },
    // Lifecycle failures become user-visible via the status
    // line (reportError also console.errors); pre-M13.5b this was console-only.
    onError: (where, message) => {
      reportError(`${where}: ${message}`);
      // emit disconnect ONLY on the link-level edge — not for other `where`
      // values (which fire for non-link failures too).
      if (where === 'link') eventRing.push(makeDisconnect());
    },
    // The session-lifecycle terminals drive the registry-external overlay.
    onSessionExpired: () => applySession({ kind: 'session-expired' }),
    onAuthServiceUnreachable: () => applySession({ kind: 'auth-service-unreachable' }),
    // AUTH-48: a failed FIRST sign-in routes to the claim UI (never the session overlay).
    onSignInFailed: (reason) => {
      applyClaim({ kind: 'sign-in-failed', reason });
      claimView?.show();
      renderClaim();
    },
    // The reconnect-triggered guest-claim lifecycle.
    onClaimPending: (code) => applyClaim({ kind: 'claim-pending', code }),
    onClaimAwaitingAccount: () => applyClaim({ kind: 'claim-awaiting-account' }),
    onClaimResult: (result) => {
      if (result.ok) {
        applyClaim({ kind: 'claim-succeeded' });
        return;
      }
      // AUTH-51 / D15: the ONLY authoritative "am I signed in" signal is store.ownAccount(identity),
      // the row the SERVER wrote — its claimedFrom disambiguates ERR_INVALID_CODE.
      applyClaim({
        kind: 'claim-rejected',
        message: result.message,
        claimedFrom: store.ownAccount(identity)?.claimedFrom,
      });
    },
  });

  // Frame loop is wrapped in try/catch so a wasm/predictor throw does not
  // kill the loop permanently. rAF re-arm is in `finally` so it always fires, even
  // on error. The reconcile call is inside the batch-listener's try-catch (above).
  const frame = (): void => {
    try {
      syncStack(); // mirror any overlay opened outside a keydown or batch (a click, a timer)
      // the session terminal also outranks the render/dispatch loop —
      // skip this frame's held-key re-issue so the predictor never ghost-walks into a dead link.
      // The rAF re-arm lives in this loop's finally, so an early return skips work, not the loop.
      if (sessionGateBlocks()) {
        // The session terminal means the store is no longer a live view of this account, and the
        // person at the keyboard may not be the one who scheduled the deletion — so the deadline
        // comes DOWN rather than freezing at its last value.
        renderPrivacyCountdown(null);
        return;
      }
      const now = performance.now();
      // Menu auto-repeat: the router synthesizes the held D-pad's repeat edges on this clock.
      for (const effect of inputRouter.tick(routeCtx())) applyRouterEffect(effect);
      // the ONE announcement edge and the ONE focus return, at the TOP
      // of the frame so a recurring throw further down cannot silence the region. The world
      // branch and announcementsFor are disjoint by construction (the reducer emits only when
      // next.topOverlay is non-null), so neither transition is ever uttered twice. The top is the
      // stack's top frame when there is one (a screen opened over the menu is announced).
      const top = upperIds().at(-1) ?? visibleIds(overlayProbes)[0] ?? null;
      const nextSnapshot: A11ySnapshot = { topOverlay: top, message: '' };
      for (const m of announcementsFor(lastA11ySnapshot, nextSnapshot)) liveRegion.announce(m, now);
      if (lastA11ySnapshot.topOverlay !== null && top === null) {
        liveRegion.announce(t('a11y.world.region'), now);
        if (worldHasFocus() || focusInsideHiddenSubtree()) worldCanvasEl?.focus();
      }
      lastA11ySnapshot = nextSnapshot;
      liveRegion.flush(now);
      // the ticking deletion countdown, ABOVE the render path on purpose — a
      // recurring throw below is swallowed by this frame's catch, and a frozen legal deadline is
      // worse than a blank one.
      const privacyAccount = store.ownAccount(identity);
      // ONE derivation per frame, reused by the banner AND the privacy surface — a second call site
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
      // The OVERLAY's status line formats `remainingMs` too, so it must be repainted from
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
      // CHANGE-DETECTED, never per frame. `account-changed` clears `inFlight`, and
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
      // drain BEFORE the continuation re-issue, so a step emitted below is
      // never drained by the frame that issued it. This is a RESIDUAL fix, not the primary one:
      // measured, the outstanding-work gate takes press-phase render teleports from 88% to ~2%
      // (6% at 30Hz), and this reordering takes that remainder to 0 — R1 WITHOUT the gate
      // removes essentially none of them, so the two must not be separated. The teleport is
      // RenderResolver's chebyshev>1 snap firing when `predicted` advances two tiles
      // between rendered frames. Do NOT move this back below the block.
      const { snapped } = predictor.drain(now);
      // Re-issue the held dir so a held key keeps walking — but only through the movement
      // gate, so it never walks under a frame or a battle + hold-commit tap/hold
      // discrimination. A frame's push clears the held set, so a hold does NOT resume when
      // the frame closes (ctl-2, deliberately reversing the old resume-after-overlay rule).
      // Only while the server owes nothing. sendIntent routes through the backpressured
      // predictor.enqueue + reducer send, and no-ops if declined. Pure NOT-EMIT: it never
      // cancels or writes predictor state, so reconcileFromStore stays the one repair path.
      if (predictor.outstandingSteps === 0 && movementGate()) {
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
      // Hold last camera position when own entity is unresolved (e.g. warp
      // gap) so the camera doesn't snap to origin. lastCamX/Y reset on zone switch.
      if (ownEntity !== undefined) {
        lastCamX = ownEntity.x;
        lastCamY = ownEntity.y;
      }
      renderer?.render(entities, lastCamX, lastCamY);
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
      // Recompute the on-world interact prompt EVERY frame
      // — the SAME resolver KeyT dispatches on, so the prompt can never
      // advertise a target KeyT refuses, and it self-heals on zone switch /
      // reconnect / overlay open. Positioned via renderer.screenFor — the
      // exact camera offset + stageScale the stage applied THIS frame.
      const ownChar = store.ownCharacter(identity);
      // Overlay-open frames skip the resolve entirely (the prompt is guaranteed
      // hidden), so the per-frame map/array allocations only happen in-world.
      const overlayUp = !movementGate();
      const promptTarget =
        !overlayUp && ownChar !== undefined
          ? nearestInteractable(
              ownChar.row,
              store.allNpcs(),
              characterTileMap(),
              store.healLocations(),
              TALK_RANGE,
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
      lastFrameErrorMessage = null;
    } catch (err) {
      console.error('[frame] uncaught error', err);
      // Surface it too — tagged, deduped, total.
      let frameErrorMessage: string;
      try {
        frameErrorMessage = `frame: ${normalizeError('uncaught', err).message}`;
      } catch {
        frameErrorMessage = 'frame: [unstringifiable error]';
      }
      if (frameErrorMessage !== lastFrameErrorMessage) {
        lastFrameErrorMessage = frameErrorMessage;
        pushError('uncaught', frameErrorMessage);
      }
    } finally {
      requestAnimationFrame(frame); // always re-arm
    }
  };
  requestAnimationFrame(frame);
}

void main();
