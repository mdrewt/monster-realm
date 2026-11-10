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
// bt-12: the tactics rules port is bound from the whole pkg namespace, LAZILY (`tacticsRules()`): the
// test mocks of this module carry only the names main.ts imports by name, and `bindTacticsRules`
// refuses a pkg missing a tactics export — so the bind happens on the first deploy render only.
import * as wasmPkg from '../../client-wasm/pkg/client_wasm.js';
// client-wasm (built `wasm-pack build client-wasm --target bundler`; resolved by
// vite-plugin-wasm, awaited at module top level — see vite.config.ts / server.fs.allow).
import {
  apply_move,
  deletion_grace_ms_default,
  interact_candidates_coded,
  max_trade_monsters_per_side,
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
import { browserStorage, loadBindings, saveBindings } from './input/bindingStore';
import { accelForCode, type Bindings, DEFAULT_BINDINGS } from './input/bindings';
import type { ButtonEdge, VButton } from './input/buttons';
import { glyph, learnKey } from './input/glyphs';
import { isChord, KeyboardSource } from './input/keyboardSource';
import { PointerSource, type PointerTop } from './input/pointerSource';
import {
  ACCEL_PATHS,
  type AccelPath,
  accelDecision,
  InputRouter,
  type MenuAccel,
  outsideGameScreen,
  ownership,
  type RouteContext,
  type RouterEffect,
  routerConsumes,
  typingKey,
} from './input/router';
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
import {
  AuthoritativeStore,
  ownPerspective,
  type StoreMonsterPub,
  type StoreTacticalBattle,
} from './net/store';
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
import { clockVM } from './tactics/clock';
import { DeployPanel, type DeployVM, deployVM } from './tactics/deployPanel';
import { isAlreadyActing } from './tactics/draft';
import { CAPS } from './tactics/presentation';
import { type ResultsInput, ResultsPanel, type ResultsVM, resultsVM } from './tactics/results';
import { queueTooLate, stillThere } from './tactics/strings';
import {
  TacticsBattle,
  type TacticsBattleDeps,
  type TacticsBattleVM,
} from './tactics/tacticsBattle';
import {
  activeUnitOf,
  bindTacticsRules,
  type RuleBattleKind,
  type RuleSide,
  type RulesBoard,
  shellKind,
  statusTagOf,
  type TacticsClientRules,
  type TacticsTuning,
} from './tactics/wasm';
import { t } from './ui/a11yCopy';
import { CLOSE_KEY, challengeLayout, sheetLayout, sizeOfRow } from './ui/actionSheetModel';
import { type A11ySnapshot, announcementsFor } from './ui/announcements';
import {
  armReseed,
  BATTLE_EMIT_INITIAL,
  type BattleEmitState,
  battleEmitStep,
  rankedStep,
  resetBattleEmit,
} from './ui/battleEmitModel';
import { buildBaitItems, decideBattleOverlay } from './ui/battleModel';
import {
  battleButton,
  battleRefused,
  battleRenderer,
  continuedBattleId,
  countdownDeadline,
  hideOtherBattleViews,
  isBareBattle,
  outcomeOnTop,
  popPlayerFramesOverBattle,
  ratingChange,
  renderableBattle,
  shouldAutoContinue,
  stillThereSeconds,
  structurallyEqual,
} from './ui/battlePolicy';
import {
  buildBoxViewModel,
  buildMonsterStats,
  buildPartyViewModel,
  resolvePartySlot,
} from './ui/boxModel';
import type { BoxView, OutcomeLine } from './ui/boxView';
// F9 bug-bundle observability — session event ring + error ring +
// pure bundle assembler + error overlay.
import {
  bugBundleFilename,
  buildBugBundle,
  type KeyStoreSnapshot,
  serializeBugBundle,
} from './ui/bugBundle';
import { type CareOutcome, performCare } from './ui/careAction';
import {
  buildClaimViewModel,
  CLAIM_INITIAL,
  type ClaimEvent,
  type ClaimModelState,
  claimStep,
} from './ui/claimModel';
import type { ClaimView, ClaimViewHandlers } from './ui/claimView';
import { closeContextSheet, createContextSheet, renderContextSheet } from './ui/contextSheet';
import {
  baseFor,
  blocksPlayerOpen,
  contextStep,
  type Edge,
  type FrameId,
  hiddenPops,
  isMirrored,
  MIRRORED_IDS,
  type MirroredId,
  mirrorServerEdges,
  movementEnabled,
  openEdge,
  popToBase,
  popTop,
  reconcile,
  reconnectSweep,
  SOCIAL_FRAME,
  SOCIAL_PANELS,
  type Stack,
  type Command as StackCommand,
  socialPanel,
  stackDiff,
  type UpperFrame,
  WORLD_STACK,
} from './ui/contextStack';
import { clearAccel, outcomeText, type SlotTarget } from './ui/controlsModel';
import type { ControlsView, ControlsViewHandlers } from './ui/controlsView';
import { DIALOGUE_TREES } from './ui/dialogueContent';
import { buildDialogueViewModel } from './ui/dialogueModel';
import type { DialogueView } from './ui/dialogueView';
import { applyTextStep, loadTextStep, saveTextStep } from './ui/displayPrefs';
import { buildErrorOverlayModel } from './ui/errorOverlayModel';
import { ErrorOverlayView } from './ui/errorOverlayView';
import { ErrorRing, type ErrorSource, normalizeError } from './ui/errorRing';
import { EventRing, makeConnect, makeDisconnect, makeZoneChange } from './ui/eventRing';
import {
  EvolutionNoticeBanner,
  evolutionNoticeKey,
  evolutionNoticeLabel,
  isBenignAckRejection,
  resolveEvolutionNoticeNames,
} from './ui/evolutionNotice';
import type { EvolutionView } from './ui/evolutionView';
import { assembleExportBundle, type ExportAssembly } from './ui/exportAssembly';
import { channelOf, type MessageKind, outranks, type SinkKind } from './ui/feedbackPolicy';
import { feedbackAnnouncement } from './ui/frame';
import { buildHealViewModel, buildHealViewModelForLocation } from './ui/healModel';
import type { HealView } from './ui/healView';
import { buildHelpViewModel } from './ui/helpModel';
import type { HelpView } from './ui/helpView';
import { HintBarView } from './ui/hintBar';
import { type HintBattle, type HintChip, type HintDeploy, hintBar } from './ui/hintBarModel';
import { isRtl, negotiateLocale } from './ui/i18n/locale';
import { CATALOGS, t as i18nT, setLocale, tf } from './ui/i18n/resolver';
import {
  type CandidatesFn,
  type InteractAction,
  type InteractCandidate,
  type InteractChip,
  interactChip,
  marshalInteract,
  pendingChallengeIdentities,
  resolveCandidates,
} from './ui/interactModel';
import { buildLeaderboardViewModel } from './ui/leaderboardModel';
import type { LeaderboardView } from './ui/leaderboardView';
import { COALESCE_WINDOW_MS, LiveRegion } from './ui/liveRegion';
import { type MenuTarget, withRequestBadge } from './ui/menuModel';
import type { MenuPointerInput, MenuView } from './ui/menuView';
import type { MonstersTab } from './ui/monstersModel';
import { EMPTY_NAV_MEMORY } from './ui/nav';
import {
  buildNotices,
  type Notice,
  type NoticeInput,
  pendingRequests,
  type RequestNotice,
  requestSheetLayout,
} from './ui/noticeModel';
import { type CanOpenVerdict, canOpen, type OverlayId } from './ui/overlayRegistry';
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
import type { ProfileView } from './ui/profileView';
import { buildPvpChallengeViewModel, challengeSizes, consciousPartyIds } from './ui/pvpModel';
import type { PvpView } from './ui/pvpView';
import { buildQuestLogViewModel } from './ui/questLogModel';
import type { QuestLogView } from './ui/questLogView';
import { buildRaisingViewModel } from './ui/raisingModel';
import type { RaisingView } from './ui/raisingView';
import { buildRenameViewModel } from './ui/renameModel';
import type { RenameView } from './ui/renameView';
import { SCREEN_ADAPTERS, ScreenHost, type WorldPort } from './ui/screens/index';
import {
  type MainMenuStep,
  mainMenuPick,
  mainMenuStep,
  menuViewModel,
  openMainMenu,
} from './ui/screens/mainMenuScreen';
import { captureStep } from './ui/screens/optionsScreen';
import type { ProfileSection } from './ui/screens/profileScreen';
import type {
  Command,
  ScreenContext,
  SocialFrameView,
  SocialPanelId,
  SocialTab,
} from './ui/screens/types';
import {
  buildSessionViewModel,
  SESSION_INITIAL,
  type SessionEvent,
  type SessionModelState,
  sessionStep,
} from './ui/sessionModel';
import type { SessionView, SessionViewHandlers } from './ui/sessionView';
import {
  buildShopViewModel,
  buildShopViewModelForShop,
  buyFeedback,
  sellFeedback,
  validShopQty,
} from './ui/shopModel';
import {
  type DismissPath,
  SHOP_OPEN_INITIAL,
  type ShopOpenEvent,
  shopOpenStep,
} from './ui/shopOpenModel';
import type { ShopView } from './ui/shopView';
import {
  type ConversationEndReason,
  conversationEndReason,
  type QuestAckSnapshot,
  questAckSnapshot,
  questCompletionAck,
  reduceErrorMessage,
  STATUS_NOTICE_INITIAL,
  type StatusNoticeState,
  statusNoticeStep,
} from './ui/statusModel';
import {
  createToast,
  NO_TOAST,
  renderToast,
  type ToastChrome,
  type ToastState,
  toastStep,
} from './ui/toast';
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

// The ONE binding table every input path and keycap reads: the player's saved table, else the
// defaults (CTL12.4). Read at boot; Controls replaces it live (`applyBindings`).
let bindings = loadBindings(browserStorage());
// The player's text size (uif-13, UIF13.4): read and written on the root here, at import, so the
// stored step is in place before the first frame; Controls › Display changes it live.
let textStep = loadTextStep(browserStorage());
applyTextStep(document.documentElement, textStep);
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
// event-emit latches (rules: ui/battleEmitModel.ts). `battleEmit` is the battleStart/battleEnd
// latch, `lastOwnRating` baselines the ranked-delta detector. Both re-baseline on
// reconnect/zone-switch (resetPredictionState) — the RINGS do NOT reset.
let battleEmit: BattleEmitState = BATTLE_EMIT_INITIAL;
let lastOwnRating: number | null = null;
// reset on EVERY reconnect and set by onHydrated: a pending battle reseed resolves only on a
// flush after it, so a partial hydration cannot burn it.
let hydratedSinceReconnect = false;
let conn: ReturnType<typeof connect> | undefined;
let boxView: BoxView | undefined;
// bt-12 (BT12.1-BT12.4): the deploy panel (a Deploying battle) and the results panel (a Finished one)
// share the `battleView` frame and overlay id. Both are constructed LAZILY, on the first batch that
// routes to them (the frame has ONE owner, so one `battle-title` root at a time), on the mount
// `main()` keeps in `battleMount`. bt-17: the 1v1 view is gone; no view is built at boot.
let deployPanel: DeployPanel | undefined;
let resultsPanel: ResultsPanel | undefined;
// bt-12 B (BT12.1): the tactical shell owns the frame of an Active tactical battle; built lazily too.
let tacticsBattle: TacticsBattle | undefined;
let battleMount: HTMLElement | undefined;
let tacticsRulesPort: TacticsClientRules | null = null;
/** The tactics rules port, bound on first use (see the `wasmPkg` import note). */
const tacticsRules = (): TacticsClientRules => (tacticsRulesPort ??= bindTacticsRules(wasmPkg));
/** The client-facing tuning (the Surge start, the wild round cap, the pack cap), read once. */
let tacticsTuning: TacticsTuning | null = null;
const tuningOf = (): TacticsTuning => (tacticsTuning ??= tacticsRules().tuning());
/** The tactical battle a battle view shows (the deploy panel or the shell), set BEFORE its render:
 *  the shell's names closure reads `mySide` inside its frame, and the countdown pump reads whose own
 *  clock to follow and whether the battle is a wild one. Null when no tactical view shows. */
let tacticsShown: {
  readonly battleId: bigint;
  readonly mySide: RuleSide;
  readonly kind: RuleBattleKind;
} | null = null;
/** The results panel's rating line (bt-15 increment B, BT15.3): `before` is this client's snapshot of
 *  the own profile rating at a Pvp battle's FIRST non-Finished sighting (null when no profile row stood
 *  yet — a first rated game; the server creates the row at the first settle); `result` is frozen at the
 *  first Finished build so a later profile write never moves the line. The settle writes the profile and
 *  the terminal anchor in ONE transaction, so `lastOwnRating` (re-baselined by its own listener in that
 *  same batch) can never be the "before". A battle first seen Finished (a reload) shows no line. */
let tacticsRating: {
  readonly battleId: bigint;
  readonly before: number | null;
  result: { readonly before: number | null; readonly after: number } | null;
} | null = null;
/** The last event seq the shell was fed, per battle (REV B2.4): null until a battle's first
 *  sighting, which feeds the whole transcript while the shell is hidden; later batches feed only the
 *  events past it. Keyed by the battle id as a bigint (ids differing only above 2^53 are two). */
let tacticsIngested: { readonly battleId: bigint; readonly seq: number } | null = null;
/** The last VM the shell rendered: an identical batch paints nothing (REV B2.2). */
let lastTacticsVM: TacticsBattleVM | null = null;
/** The deadline whose "Still there?" countdown the live region already announced (once per window). */
let stillThereAnnouncedFor: bigint | null = null;
/** The three views that can own the battle frame, in a fixed order (undefined until built). */
const battleViews = (): readonly (DeployPanel | ResultsPanel | TacticsBattle | undefined)[] => [
  deployPanel,
  resultsPanel,
  tacticsBattle,
];
/** Whether any battle view shows: the `battleView` mirror probe. */
const battleFrameShown = (): boolean => battleViews().some((v) => v?.visible === true);
/** The `battleView` force-hide handle: every built view's own hide (each is idempotent). */
const hideAllBattleViews = (): void => {
  for (const v of battleViews()) v?.hide();
  tacticsShown = null;
};
/** The view the screen host lends the battle adapter: the tactical shell while it shows, else the
 *  deploy panel while it shows, else nothing (the results panel takes no ops; its Continue is a click
 *  or the auto-advance — and bt-17 deleted the 1v1 view). */
const activeBattleView = (): DeployPanel | TacticsBattle | undefined =>
  tacticsBattle?.visible === true
    ? tacticsBattle
    : deployPanel?.visible === true
      ? deployPanel
      : undefined;
/** Whether Start is the battle adapter's (bt-11 BT11.6, bt-12 B): the tactical shell shows (End Turn
 *  / Guard / Submit) or the deploy panel's EDITOR is open (Submit). At the deploy CONFIRM screen Start
 *  opens the main menu as at any battle base, so Escape (Start's key) never deploys (REV 2 A6). */
const tacticalOwnsStart = (): boolean =>
  tacticsBattle?.visible === true || (deployPanel?.visible === true && deployPanel.mode === 'edit');
/** What the shown battle view tells the hint bar and Help: the shell's verbs, else the deploy panel's
 *  screen (both of them — R-bt-12-DEPLOYHINT), else nothing (no shown view, or the results panel). */
const battleHint = (): HintBattle | HintDeploy | undefined =>
  tacticsBattle?.visible === true
    ? tacticsBattle.hint()
    : deployPanel?.visible === true
      ? deployPanel.hint()
      : undefined;
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
// The Profile screen (uif-16b): ONE frame whose sections are the rename form, the guest-claim
// prompt and the privacy surface below. It is the registered overlay (GUARD_ONLY); the three
// section views are painted from their models here and shown only through it.
let profileView: ProfileView | undefined;
// The Name section: wires the set_profile_name reducer to the rename form.
let renameView: RenameView | undefined;
// trade-PROPOSE overlay — the wizard Trade on a faced player opens (ctl-10b); wires
// reducers.proposeTrade to let a human initiate a "sell my monster(s) + gold for your gold" trade.
let tradeProposeView: TradeProposeView | undefined;
// How to Play (Select; uif-14): catalog copy. No reducer; its one handler is the live-region
// announce. Its Report a problem row reaches `dispatch` as the `reportProblem` command (uif-14b).
let helpView: HelpView | undefined;
// The main menu (ctl-5): a nav-list screen that stays open beneath the overlay it opens.
let menuView: MenuView | undefined;
// The Account and Privacy sections of Profile, and the session-lifecycle overlay
// (registry-EXTERNAL, driven by conn.sessionState()), each backed by its pure model state carried
// at module scope.
let claimView: ClaimView | undefined;
let privacyView: PrivacyView | undefined;
// Controls (ctl-12b): the remapping screen. Its `capturing` is what the keydown handler
// reads to hand a key to the capture instead of the router.
let controlsView: ControlsView | undefined;
/** controlsView module's `savedLine`, bound with the view when it is built. */
let controlsSavedLine: ((text: string, saved: boolean) => string) | undefined;
let sessionView: SessionView | undefined;
// The post-evolve reveal banner — runtime-constructed in main(), NOT a
// registry overlay; read by the batch listener below and reset at the onReconnect tail.
let evolutionNoticeBanner: EvolutionNoticeBanner | undefined;
let claimModelState: ClaimModelState = CLAIM_INITIAL;
let sessionModelState: SessionModelState = SESSION_INITIAL;
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
// The Social tab the last `openSocial` asked for (null: a plain open). Like the two ids above it
// keeps its value after the frame closes and clears on reconnect.
let boundSocialTab: SocialTab | null = null;
// The Monsters tab the last Monsters open bound (uif-6): Party from the menu and V, Storage from B.
// Read by the screen's `init` at the seated open; clears on reconnect (null opens Storage).
let boundMonstersTab: MonstersTab | null = null;
// The player the trade wizard was last opened for (the face-to-face Trade, ctl-10b). Every open
// rebinds it, and the face-to-face Trade is the wizard's only open path.
let boundProposeTarget: string | null = null;

// The three tables of the overlays the visibility mirror still sees (so-2): the server-owned
// battle and dialogue (`MIRRORED_IDS`), which show themselves on server edges. A player frame's
// probe, hide and view travel with its open instead (`openFrame`'s `FrameOpen`). Three small
// tables, never merged into one registry: each dialogue row is intentionally the byte-identical
// thunk of its own key, because main.ts is coverage-excluded and a copy-pasted sibling thunk
// (`battleView: () => dialogueView?.visible ?? false`) type-checks perfectly while reading,
// hiding or lending the wrong overlay; the battle rows (bt-12) go through the ONE set of
// battle-frame helpers above, since three views can own that frame. Typed total over
// `MirroredId`, so a dropped row is a COMPILE error.

// the probe table: whether each mirrored overlay is shown.
const overlayProbes: Readonly<Record<MirroredId, () => boolean>> = {
  battleView: () => battleFrameShown(),
  dialogueView: () => dialogueView?.visible ?? false,
};

// the force-hide handle table, the WRITE mirror of `overlayProbes`. `dialogueView` is the SOLE
// `undefined` entry and must stay that way: hiding a live conversation client-side strands the
// server `player_conversation` row. Only the stack's `close` commands reach it, through `hideFrame`.
const overlayHandles: Readonly<Record<MirroredId, (() => void) | undefined>> = {
  battleView: () => hideAllBattleViews(),
  dialogueView: undefined,
};

// The resets of the views whose hide() is also their only reset of what a dropped link leaves
// behind (a lock an in-flight reducer promise never releases, a stale draft, challenge or board):
// `onReconnect` runs each one UNCONDITIONALLY, shown or not, on the stack or not (so-1). It overlaps
// the frames `reconnectSweep` closes by design (a shown one is hidden twice; every hide() here is
// idempotent): the sweep owns the close, this owns the reset. The menu holds no such state. Each
// row is the byte-identical `() => <view>?.hide()` of its view.
const RECONNECT_RESETS: readonly (() => void)[] = [
  () => profileView?.hide(),
  () => tradeProposeView?.hide(),
  () => shopView?.hide(),
  () => tradeView?.hide(),
  () => pvpView?.hide(),
  () => deployPanel?.hide(),
  () => resultsPanel?.hide(),
  () => tacticsBattle?.hide(),
  () => raisingView?.hide(),
  () => evolutionView?.hide(),
  () => leaderboardView?.hide(),
];

// the view-lending table: each mirrored overlay's view instance, which the screen host hands to
// that frame's adapter to paint after a step (CTL7C.2). Undefined until main() builds the views.
const screenViews: Readonly<Record<MirroredId, () => unknown>> = {
  battleView: () => activeBattleView(),
  dialogueView: () => dialogueView,
};

/** What a player frame's open registers (so-2): whether its view shows, the view's own hide path,
 *  and the view the screen host lends the frame's adapter. It travels with the open, never as a
 *  table row. */
interface FrameOpen {
  readonly probe: () => boolean;
  readonly hide: () => void;
  readonly view: () => unknown;
}

/** The registration of every player frame opened this session, by frame id (`openFrame`). */
const frameOpens = new Map<FrameId, FrameOpen>();

/** A view's registration: its own `visible` and `hide()`, read through the ONE binding `view`, so a
 *  call site names its view once. */
function frameOpenOf(
  view: () => { readonly visible: boolean; hide(): void } | undefined,
): FrameOpen {
  return { probe: () => view()?.visible ?? false, hide: () => view()?.hide(), view };
}

// A view's paint threw, or an adapter threw while observing a batch. Logged every time, and
// surfaced like an uncaught frame error (tagged, deduped on the message: a held D-pad repeats the
// same step every 100 ms, a failing observe repeats on every batch, and the error ring is small).
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
// step, and every state a batch changed, into the frame's view. A paint that throws is reported
// and never costs the key its result. A player frame is lent the view its open registered (the
// Social frame its three panels as one view).
const screenHost = new ScreenHost(
  SCREEN_ADAPTERS,
  (id) => (isMirrored(id) ? screenViews[id]() : frameOpens.get(id)?.view()),
  reportPaintError,
);

// the ONE gate binder. Returns the VERDICT, not a boolean: each call site spells
// `.kind === 'allow'` itself, deliberately, so no single `!` can invert every gate at once. Reads the stack on EVERY
// call (`shownOverlays`), never a cache.
//
// The main menu stays open beneath the screen it opens (ctl-5), so it never blocks another
// overlay: it is left out of the visible set for every target but itself.
function overlayVerdict(id: OverlayId): CanOpenVerdict {
  const visible = shownOverlays();
  return canOpen(id, id === 'menuView' ? visible : visible.filter((v) => v !== 'menuView'));
}

/** The overlays shown right now (so-2: read off the stack): each mirrored one by its probe, and
 *  each player frame on the stack whose view shows, the Social frame as its shown panels. */
function shownOverlays(): OverlayId[] {
  const shown: OverlayId[] = MIRRORED_IDS.filter((id) => overlayProbes[id]());
  for (const id of upperIds()) {
    if (id === SOCIAL_FRAME) shown.push(...SOCIAL_PANELS.filter(panelShown));
    else if (!isMirrored(id) && frameOpens.get(id)?.probe() === true) shown.push(id);
  }
  return shown;
}

// The context stack (ui/contextStack.ts) owns the player's frames (so-2): every player open
// pushes its frame FIRST and only then shows the view (`openFrame`). `syncStack()` derives the
// base from the store, mirrors the server-owned overlays (the battle and the dialogue, which show
// themselves on server edges) into it, and pops a player frame whose view closed itself, so every
// reader that syncs first sees the battle row and those overlays as they are right now. A push of
// a new frame (and a change of base kind) clears the held directions (B14). Synced at the top and
// tail of every keydown, before every keyup, at the top of every frame, after every player open
// and at the tail of every batch; a movementGate() read never syncs, and `__game().stack` only
// reads it. Server truth is reconciled into it on every batch (`reconcileStack`), which closes
// what a battle or a conversation drops. The sync also keeps two
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
        hideFrame(command.id);
        break;
      default:
        command satisfies never;
    }
  }
}
/** When the terminal outcome frame now on top was first mirrored (performance.now), else null:
 *  A continues it only after `OUTCOME_CONTINUE_GRACE_MS` (CTL6C.2). */
let outcomeShownAtMs: number | null = null;
/** The shown edge (`outcomeShownAtMs`) the results auto-advance already popped for, so the pop runs
 *  once per edge (bt-12, BT12.4); null whenever the outcome is not on top, with the edge. */
let autoContinuedAtMs: number | null = null;
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
  const mirrored = MIRRORED_IDS.filter((id) => overlayProbes[id]());
  for (const edge of mirrorServerEdges(contextStack, mirrored, prevBase)) {
    apply(edge);
    // A reopened frame's adapter starts over (from what it remembers, when it opted in).
    if (edge.kind === 'push') screenHost.opened(edge.frame);
    inputRouter.resetRepeat(); // a held key never repeats into a pushed or popped frame
  }
  // A player view that closed itself (its own close button or Escape, a lifecycle hide) takes its
  // frame with it. Only pops: a player frame is pushed by its open alone.
  for (const edge of hiddenPops(contextStack, shownPlayerFrames())) {
    apply(edge);
    inputRouter.resetRepeat();
  }
  const outcomeUp = outcomeOnTop(contextStack);
  if (!outcomeUp) {
    outcomeShownAtMs = null;
    autoContinuedAtMs = null;
  } else outcomeShownAtMs ??= performance.now();
  menuView?.setCovered(menuPlace() === 'covered');
  // The world hint follows the top frame (WF1-A9): the menu's strip while it is on top.
  paintWorldHint();
  judgeCloseFocus();
}

/** The frame ids of the stack's upper frames, bottom first (the base excluded). */
function upperIds(): FrameId[] {
  const [, ...upper] = contextStack;
  return upper.map((f) => (f.kind === 'textEntry' ? f.owner : f.id));
}

/** The player frames on the stack whose view shows, by the probe their open registered. */
function shownPlayerFrames(): FrameId[] {
  return upperIds().filter((id) => !isMirrored(id) && frameOpens.get(id)?.probe() === true);
}

/** Whether a Social panel shows. */
function panelShown(panel: SocialPanelId): boolean {
  return socialPanelView(panel)?.visible ?? false;
}

/** Hide what a frame shows through the view's own hide path, so its close callbacks run (CTL3.3);
 *  never a hidden one. A mirrored frame's handle is its table row; a player frame's is the one its
 *  open registered (the Social frame's hides whichever of its panels shows). */
function hideFrame(id: FrameId): void {
  if (isMirrored(id)) {
    if (overlayProbes[id]()) overlayHandles[id]?.();
    return;
  }
  const open = frameOpens.get(id);
  if (open?.probe() === true) open.hide();
}

/** The overlay the announcer names as on top: the top frame's (the Social frame's is its shown
 *  panel), else the first shown mirrored overlay, else null. */
function topOverlay(): OverlayId | null {
  const top = upperIds().at(-1);
  if (top === undefined) return MIRRORED_IDS.find((id) => overlayProbes[id]()) ?? null;
  return top === SOCIAL_FRAME ? (SOCIAL_PANELS.find(panelShown) ?? null) : top;
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
  // bt-17: an anchor without its tactical row is not a battle the client can show (the 1v1 view is
  // gone) — `renderableBattle` is the predicate `refreshBattle` shares, so such a terminal anchor
  // never counts as a shown outcome here while that function dismisses it in the same batch.
  const latest = store.latestPlayerBattle(identity);
  const outcome =
    identity !== '' &&
    latest !== undefined &&
    latest.outcome !== 'Ongoing' &&
    renderableBattle(latest, store.tacticalBattle(latest.battleId))
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
 *  battle overlay hidden — B17), while the session terminal owns the screen and while the world
 *  picker or action sheet (ctl-10a) or a request sheet (ctl-13) is open. */
function movementGate(): boolean {
  return worldBaseLive() && !screenHost.sheetOpen;
}

/** The world base takes input: the movement gate before the world sheet (ctl-10a) is counted.
 *  Anything else (a frame, a battle base, the session terminal) closes that sheet. It reads the
 *  stack as it stands (so-2): a gate read pushes, pops, shows and hides no frame. */
function worldBaseLive(): boolean {
  const live = movementEnabled(contextStack, sessionGateBlocks());
  if (!live) screenHost.closeSheet();
  return live;
}

/** The export, read lazily: a test's wasm mock that lacks it gives no candidates, not a throw. */
function interactCandidatesFn(): CandidatesFn | undefined {
  try {
    return interact_candidates_coded;
  } catch {
    return undefined;
  }
}

// A real Err from the export (a malformed entity) is logged and surfaced once per message, never
// silent; the world then offers nothing.
let lastInteractErrorMessage: string | null = null;
function reportInteractError(err: unknown): void {
  let message: string;
  try {
    message = `interact: ${normalizeError('uncaught', err).message}`;
  } catch {
    message = 'interact: [unstringifiable error]';
  }
  if (message === lastInteractErrorMessage) return;
  lastInteractErrorMessage = message;
  console.error('[interact] candidates error', err);
  pushError('uncaught', message);
}

// What the character faces (ctl-10a): the wasm rule's candidates from the PREDICTED tile and
// facing (what is drawn; the authoritative row until there is one), in the authoritative zone.
// Memoised on (batch, identity, zone, tile, facing), so the chip asks once per change, never per
// frame, and A and Y reuse the chip's answer.
let interactBatch = 0;
store.onBatchApplied(() => {
  interactBatch++;
});
let interactMemo: { readonly key: string; readonly cands: readonly InteractCandidate[] } | null =
  null;
function worldCandidates(): readonly InteractCandidate[] {
  const own = store.ownCharacter(identity);
  if (own === undefined) return [];
  const pred = predictor.predicted;
  const origin = {
    x: pred?.pos.x ?? own.row.tileX,
    y: pred?.pos.y ?? own.row.tileY,
    facing: pred?.facing ?? own.row.facing,
    zone: own.row.zoneId,
  };
  const key = `${interactBatch}|${identity}|${origin.zone}|${origin.x}|${origin.y}|${origin.facing}`;
  if (interactMemo?.key !== key) {
    const input = marshalInteract(
      store.allNpcs(),
      Array.from(store.characters(), (c) => c.row),
      store.allPlayers(),
      store.healLocations(),
      store.ownEntityId(identity),
      pendingChallengeIdentities(store.allChallenges()),
    );
    interactMemo = {
      key,
      cands: resolveCandidates(interactCandidatesFn(), origin, input, reportInteractError),
    };
  }
  return interactMemo.cands;
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

/** Paint the Account section from the claim model. A claim phase that wants the screen, with
 *  Profile closed, is the auto-open: Profile opens on Account (the reconnect-driven claim flow has
 *  no other way to show itself). With Profile open it only paints: a claim event never pulls the
 *  player out of the section they are in. */
function renderClaim(): void {
  const vm = buildClaimViewModel(claimModelState);
  if (vm.visible && profileView?.visible === false) showProfile('account');
  else claimView?.render(vm);
}
/** Set by the connection's own claim callbacks (`onClaimPending`, `onClaimAwaitingAccount`), which
 *  it calls just BEFORE `onReady` / `onReconnect`. Their paint opens Profile on Account at once;
 *  a reconnect's sweep then closes Profile with every other frame it closes, so `onReconnect`
 *  shows the prompt its own cycle raised again at its tail. `onReady` sweeps nothing and only
 *  clears the mark. */
let claimRaised = false;

function applyClaim(event: ClaimEvent): void {
  const step = claimStep(claimModelState, event);
  claimModelState = step.next;
  // The AUTHORITATIVE claim-code veto lives in connection.ts's onApplied (G18); here we only mirror
  // the local storage effect so a declined / dead code stops vetoing the next connection's join.
  if (step.effect === 'delete-code-and-permit-join') claimCode.clear(globalThis, URI, DB);
  if (step.effect === 'join') conn?.join();
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
// closed must still be picked up — the Profile open renders from current state, so the offer is
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
    reportError('download-blocked', i18nT('chrome.status.exportBlocked'));
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
      reportError('world-send-rejected', message);
      applyPrivacy({ kind: 'request-failed', which, message });
    },
  );
}

// --- the Profile screen (uif-16b) ---------------------------
// ONE frame over the Name, Account and Privacy sections. `showProfile` is its single
// build-and-show body; `openProfile` is the player's open (the menu leaf, N, C).

/** The Profile frame's open registration. */
const profileOpen = frameOpenOf(() => profileView);

/** Show Profile on `section`, its frame pushed first (so-2). Each section is painted from its
 *  model before the frame shows; the claim section is painted directly, never through
 *  `renderClaim`, whose auto-open would re-enter this. On a frame already open only the claim and
 *  privacy sections repaint: the name field keeps the draft being typed. */
function showProfile(section: ProfileSection): void {
  openFrame('profileView', profileOpen, () => {
    if (profileView?.visible === false) {
      renameView?.render(buildRenameViewModel(store.player(identity)?.name ?? '', ''));
    }
    claimView?.render(buildClaimViewModel(claimModelState));
    renderPrivacy();
    profileView?.show(section);
  });
}

/** The player's open. An open on Account, or the first open of the session, puts the claim model
 *  on its prompt (as the Account entry always did) so the section offers its actions; an open on
 *  another section leaves a claim in progress as it is. The model is stepped WITHOUT a paint: a
 *  paint here would auto-open on Account before the section asked for.
 *  AUTH-51: "signed in" is store.ownAccount(identity) !== undefined — the row the SERVER wrote —
 *  never a storage marker or the credential kind. */
function openProfile(section: ProfileSection): void {
  if (section === 'account' || claimModelState.phase === 'hidden') {
    claimModelState = claimStep(claimModelState, {
      kind: 'claim-ui-opened',
      nudgeAlreadySeen: claimCode.hasSeenFirstRunNudge(globalThis, URI, DB),
    }).next;
    claimCode.markFirstRunNudgeSeen(globalThis, URI, DB);
  }
  showProfile(section);
}
// --- the main menu ------------------------------------------------
//
// ONE OPEN PATH PER OVERLAY: each openX() below is the single build-VM-and-show body for
// its overlay, called by the menu (an accelerator opens through the menu), and each shows through
// `openFrame`, which pushes the frame first (so-2). Trade, pvp and leaderboard share
// `openSocial` (and the world request sheet's View row, ctl-13), whose build-and-show bodies are
// `showSocialPanel`'s. The view contract is non-uniform (dialogue/questLog/heal expose render()
// with no show(); pvp takes refresh(vm, forceVisible)), so these are per-id thunks, never a
// generic view.show().

/** The main menu's screen state. Its nav memory outlives every close, so a reopened menu lands
 *  on the last entry used this session (CTL5.3). */
let menuState = openMainMenu(EMPTY_NAV_MEMORY);

function openQuestLog(): void {
  openFrame(
    'questLogView',
    frameOpenOf(() => questLogView),
    () => questLogView?.render(buildQuestLogViewModel(store.ownQuests(identity))),
  );
}

// The Social frame (CTL8S.3): ONE frame over the trade, pvp and leaderboard overlays, which are
// its panels, one shown at a time. `openSocial` is its single open path; the frame's adapter
// switches the shown panel through the view it is lent (`socialFrameView.show`).

/** The Social frame's shared chrome: empty until ctl-8d paints its tab strip. */
const socialChrome = document.createElement('div');

/** A Social panel's view (undefined until main() builds it). */
function socialPanelView(panel: SocialPanelId): TradeView | PvpView | LeaderboardView | undefined {
  switch (panel) {
    case 'tradeView':
      return tradeView;
    case 'pvpView':
      return pvpView;
    case 'leaderboardView':
      return leaderboardView;
  }
}

/** Show one Social panel alone, with the chrome in it; nothing for a panel already shown (its
 *  batch listener keeps it live). The panel is rendered and shown BEFORE the others hide, so the
 *  a11y layer closes the old one as a covered dialog and focus never bounces through the frame
 *  beneath. A render that throws before its panel shows leaves the old panel up; one that throws
 *  after (pvp shows first) still leaves that panel alone on screen. */
function showSocialPanel(panel: SocialPanelId): void {
  if (panelShown(panel)) return;
  try {
    switch (panel) {
      case 'tradeView':
        tradeView?.render(
          buildTradeViewModel(
            store.allTradeOffers(),
            identity,
            store.speciesMap(),
            store.itemDefs(),
          ),
        );
        tradeView?.show();
        break;
      case 'pvpView':
        // forceVisible=true: the player asked for it — stay up even with no live challenge.
        pvpView?.refresh(
          buildPvpChallengeViewModel(store.allChallenges(), identity, store.allPlayers()),
          true,
        );
        break;
      case 'leaderboardView':
        leaderboardView?.render(buildLeaderboardViewModel(store.allProfiles(), identity));
        leaderboardView?.show();
        break;
      default:
        panel satisfies never;
    }
  } finally {
    if (panelShown(panel)) {
      socialPanelView(panel)?.hostChrome(socialChrome);
      for (const other of SOCIAL_PANELS) if (other !== panel) hidePanel(other);
    }
  }
}

/** Hide a shown Social panel through its own hide path. */
function hidePanel(panel: SocialPanelId): void {
  if (panelShown(panel)) socialPanelView(panel)?.hide();
}

/** The Social frame's open registration: shown while any panel shows, closed by hiding the shown
 *  panels, lent the composite view. */
const socialOpen: FrameOpen = {
  probe: () => SOCIAL_PANELS.some(panelShown),
  hide: () => {
    for (const panel of SOCIAL_PANELS) hidePanel(panel);
  },
  view: () => socialFrameView,
};

/** What the Social frame's adapter paints: its three panel views and the panel switch. */
const socialFrameView: SocialFrameView = {
  get trades() {
    return tradeView;
  },
  get challenges() {
    return pvpView;
  },
  get rankings() {
    return leaderboardView;
  },
  chrome: socialChrome,
  show(panel) {
    // Only the top frame switches its panel: under a covering frame the switch would open a
    // dialog beneath it. The stack is fresh here: every paint follows a sync.
    if (topSocialFrame() !== undefined) showSocialPanel(panel);
  },
};

/** The ONE player open (so-2): the frame is pushed FIRST (over a battle, stamped with it; a frame
 *  already on the stack is not pushed again, `contextStep`'s dedup), and only then does `show` show
 *  its view, so no player view is shown off the stack. `open` registers the frame's probe, hide and
 *  view. The base it stamps from is the one the caller's last sync left (every keydown, pointer
 *  press and batch syncs first). The closing sync, which runs even when `show` throws, takes off a
 *  frame whose show did not take (and what the show hid).
 *  Returns the frame when it is the top frame, else undefined. */
function openFrame(id: FrameId, open: FrameOpen, show: () => void): UpperFrame | undefined {
  frameOpens.set(id, open);
  const next = contextStep(contextStack, openEdge(contextStack, id));
  if (next.stack !== contextStack) {
    contextStack = next.stack;
    runStackCommands(next.commands);
    // A reopened frame's adapter starts over (from what it remembers, when it opted in).
    screenHost.opened(contextStack[contextStack.length - 1] as UpperFrame);
    inputRouter.resetRepeat(); // a held key never repeats into a pushed frame
  }
  try {
    show();
  } finally {
    syncStack();
  }
  const top = contextStack[contextStack.length - 1];
  return top.kind === 'screen' && top.id === id ? top : undefined;
}

/** Open the screen `id` and seat its adapter, so its first paint is at the open. */
function openSeated(id: FrameId, open: FrameOpen, show: () => void): void {
  const frame = openFrame(id, open, show);
  if (frame !== undefined) screenHost.seat(frame, screenCtx);
}

/** The Social frame when it is the stack's top frame, else undefined. */
function topSocialFrame(): UpperFrame | undefined {
  const top = contextStack[contextStack.length - 1];
  return top.kind === 'screen' && top.id === SOCIAL_FRAME ? top : undefined;
}

/** The ONE open path of the Social frame: bind the requested tab, push the frame, show its panel
 *  and seat its adapter, so a screen that picks its own tab paints it at the open. */
function openSocial(tab: SocialTab | null): void {
  boundSocialTab = tab;
  openSeated(SOCIAL_FRAME, socialOpen, () => showSocialPanel(socialPanel(tab)));
}

/** Open the trade wizard for the faced player `target` (ctl-10b): the target is pre-selected and
 *  locked, so it opens on Offer. A target that is not a listed trade partner opens nothing. The
 *  frame is seated at the open, so its first paint puts focus on the Offer list before the
 *  overlay's deferred initial focus would land on the (locked) target select. */
function openPropose(target: string): void {
  const lists = buildProposeLists(
    store.allPlayers(),
    store.ownMonsters(identity),
    store.speciesMap(),
    identity,
  );
  if (!lists.targets.some((t) => t.identity === target)) return;
  boundProposeTarget = target;
  openSeated(
    'tradeProposeView',
    frameOpenOf(() => tradeProposeView),
    () => {
      tradeProposeView?.render(lists, target);
      tradeProposeView?.show();
    },
  );
}

/** How to Play (uif-14): catalog copy bound in the active locale at each open; seated at the open,
 *  so its tab bar paints then. Its push closes a world sheet, so the sheet is closed first. */
function openHelp(): void {
  screenHost.closeSheet();
  openSeated(
    'helpView',
    frameOpenOf(() => helpView),
    () => {
      helpView?.render(buildHelpViewModel());
      helpView?.show();
    },
  );
}

/** What the character faces at the live world base with no world sheet open, else null. */
function facedChip(live: boolean): InteractChip | null {
  return live && !screenHost.sheetOpen ? interactChip(worldCandidates()) : null;
}

/** The hint bar's chips for `stack` with the world's live state, which the frame loop paints
 *  (ctl-13). `chip` is what the character faces, else null. */
function hintChips(
  stack: Stack,
  chip: InteractChip | null,
  notices: readonly Notice[],
  pending: readonly RequestNotice[],
): readonly HintChip[] {
  return hintBar(
    stack,
    bindings,
    notices,
    {
      target:
        chip === null
          ? null
          : chip.kind === 'single'
            ? interactVerb(chip.action)
            : i18nT('chrome.chip.ok'),
      sheetOpen: screenHost.sheetOpen,
      // uif-12 (UIF12.3): A chooses a row of a multi-row picker (not its Challenge confirm).
      picker:
        screenHost.sheet !== null &&
        screenHost.sheet.confirm === null &&
        screenHost.sheet.entries.length > 1,
      requestWaiting: pending.length > 0,
    },
    // bt-12: the shown tactical view's verbs — the shell's, else the deploy panel's (both screens).
    battleHint(),
  );
}

/** Controls: seated at the open, so its rows paint then and not at the first button. */
function openControls(): void {
  openSeated(
    'controlsView',
    frameOpenOf(() => controlsView),
    () => controlsView?.show(),
  );
}

/** Run what A or a sheet row chose at the world (ctl-10a). Exhaustive, no default arm. Only the
 *  world base asks (`ScreenHost.button`), which keeps it out of a battle and from under a frame
 *  (CTL6C.3). Talk and shop share the talk reducer (greet-then-shop); heal binds the heal frame to
 *  that location and transacts nothing. Trade opens the wizard for the faced player; a challenge
 *  arrives here only after its Yes-default confirm (ctl-10b). The server re-validates on every send. */
function runInteract(action: InteractAction): void {
  switch (action.kind) {
    case 'talk':
    case 'shop':
      sendGuarded('talk', () => conn?.live()?.reducers.talk({ npcEntityId: action.npcEntityId }));
      break;
    case 'heal':
      boundHealLocationId = action.locationId;
      openFrame(
        'healView',
        frameOpenOf(() => healView),
        () =>
          healView?.render(
            buildHealViewModelForLocation(
              action.locationId,
              store.healLocations(),
              store.itemDefs(),
            ),
          ),
      );
      break;
    case 'trade':
      if (overlayVerdict('tradeProposeView').kind === 'allow') {
        held.clear(); // the opening keypress must not leave a held movement key latched
        openPropose(action.playerIdentity);
      }
      break;
    case 'challenge':
      // bt-15 (BT15.1): a challenge reaches `dispatch` only as a SIZED Command from the confirm's
      // size row (worldScreen.ts); the bare action runs nothing, so no path sends an unsized one.
      break;
  }
}

/** The request keys the player dismissed with B (ctl-13), and those already announced. A new
 *  session forgets both: a request still waiting after a reconnect shows and is announced again. */
const dismissedRequests = new Set<string>();
const announcedRequests = new Set<string>();
/** The requests this client has answered (from the world sheet or Social): out of `pending` and
 *  the banner until the server row changes, so a second Y then Enter never answers twice. */
const answeredRequests = new Set<string>();

function noticeInput(): NoticeInput {
  return {
    offers: store.allTradeOffers(),
    challenges: store.allChallenges(),
    players: store.allPlayers(),
    identity,
    errorPending: errorOverlayView?.visible ?? false,
    dismissed:
      answeredRequests.size === 0
        ? dismissedRequests
        : new Set([...dismissedRequests, ...answeredRequests]),
  };
}

/** The requests still waiting on an answer from this client. */
function livePending(): readonly RequestNotice[] {
  return pendingRequests(noticeInput()).filter((n) => !answeredRequests.has(n.key));
}

/** The banner's and the announcement's line for a request; it names no key (a remap keeps it true). */
const requestLine = (n: RequestNotice): string =>
  n.request === 'trade'
    ? tf('notice.request.trade', { name: n.fromName })
    : tf('notice.request.challenge', { name: n.fromName });

const worldPort: WorldPort = {
  candidates: worldCandidates,
  run: runInteract,
  // bt-15 (BT15.1): the party sizes a Challenge confirm offers, largest first — over the eligible
  // party (conscious, untraded, slot order), read live at every press.
  challengeSizes: () => challengeSizes(eligibleChallengeIds().length),
  notices: {
    notices: () => buildNotices(noticeInput()),
    pending: livePending,
    dismiss: (key) => {
      if (key === 'error') dismissErrorToast();
      else dismissedRequests.add(key);
    },
    // View opens Social on the request's tab, through the same verdict as its own hotkey.
    view: (n) => {
      if (overlayVerdict(n.request === 'trade' ? 'tradeView' : 'pvpView').kind !== 'allow') return;
      held.clear();
      openSocial(n.request === 'trade' ? 'trades' : 'challenges');
    },
  },
};

/** The chip's and the sheet's words, each a literal catalog key (the catalog parity scan). */
function interactVerb(action: InteractAction): string {
  switch (action.kind) {
    case 'talk':
      return i18nT('interact.verb.talk');
    case 'shop':
      return i18nT('interact.verb.shop');
    case 'heal':
      return i18nT('interact.verb.heal');
    case 'trade':
      return i18nT('interact.verb.trade');
    case 'challenge':
      return i18nT('interact.verb.challenge');
  }
}

/** A Challenge confirm row's word (bt-15, BT15.1): a size row is `N vs N`, the last row is No —
 *  each a literal catalog key (the catalog parity scan). */
function sizeRowLabel(key: string): string {
  const n = sizeOfRow(key);
  return n === null ? i18nT('prompt.no') : tf('interact.challenge.size', { n });
}

/** The Close row's word (uif-12, UIF12.2): the kit's, for the layout key that names no entry. */
function closeRowLabel(): string {
  return i18nT('kit.sheet.close');
}

/** A request sheet row's word (ctl-13), each a literal catalog key (the catalog parity scan). */
function requestRowLabel(key: string): string {
  if (key === CLOSE_KEY) return closeRowLabel();
  if (key === 'accept') return i18nT('notice.sheet.accept');
  return key === 'decline' ? i18nT('notice.sheet.decline') : i18nT('notice.sheet.view');
}

function interactName(c: InteractCandidate): string {
  return c.kind === 'heal' ? i18nT('interact.healer') : c.name;
}

/** The A button's keycap, from the live binding (A is protected, so it always has a key). */
function interactKeycap(): string {
  return glyph(bindings.buttons.A[0] ?? '');
}

function interactChipText(chip: InteractChip): string {
  const key = interactKeycap();
  return chip.kind === 'single'
    ? tf('interact.chip', {
        key,
        verb: interactVerb(chip.action),
        name: interactName(chip.candidate),
      })
    : tf('interact.choose', { key });
}

function renderMenu(): void {
  const vm = menuViewModel(menuState);
  // A standing world hint outranks the menu's own line (a persistent state over a disabled reason
  // or a Y-description, WF1-A9). Painted here only, never into `menuState`, so applyMenuStep's
  // once-per-change announcement never says it again (setWorldHint already did).
  const hint = hintOnMenu();
  menuView?.render({
    ...vm,
    feedback: hint === null ? vm.feedback : { kind: 'error', text: hint },
    labels: withRequestBadge(vm.labels, livePending().length > 0),
  });
}

/** Whether a request waited at the last batch: a batch that flips it repaints an open menu. */
let menuBadged = false;

/** The SINGLE entry point: the root list, on the last entry used. */
function openMenu(): void {
  // Over a battle the menu is read-only: what is not battle-safe is disabled (CTL6C.3).
  menuState = openMainMenu(menuState.memory, contextStack[0].kind === 'battle');
  openFrame(
    'menuView',
    frameOpenOf(() => menuView),
    () => {
      renderMenu();
      menuView?.show();
    },
  );
}

/** The Profile section a path's tab names, if it names one. */
function profileSectionOf(tab: AccelPath['tab']): ProfileSection | undefined {
  return tab === 'name' || tab === 'account' || tab === 'privacy' ? tab : undefined;
}

/** The Social tab a path's tab names, else null (a plain open: the screen picks). */
function socialTabOf(tab: AccelPath['tab']): SocialTab | null {
  switch (tab) {
    case 'trades':
    case 'challenges':
    case 'rankings':
    case 'players':
      return tab;
    default:
      return null;
  }
}

/** Open a menu entry's frame ABOVE the menu, through that frame's single open path. The menu
 *  stays open beneath it, so whichever way the child closes, the menu is back with its cursor on
 *  the entry. `tab` is the tab an accelerator's path names, read by the frame it belongs to:
 *  Monsters opens on Party without one, Social on the tab its screen picks (uif-15b), Profile on
 *  Name (uif-16b). */
function openMenuTarget(target: MenuTarget, tab?: AccelPath['tab']): void {
  // A second route to store reads keyed by identity, which is '' until the first onReady.
  if (identity === '') return;
  // Exhaustive switch, no default arm: a new target compiler-flags this site.
  switch (target) {
    case 'boxView':
      // uif-6 (UIF6.2): the tab is bound before the open and the open is seated, so the screen's
      // `init` opens on it and paints it at once: no synthesized button.
      boundMonstersTab = tab === 'storage' ? 'storage' : 'party';
      openSeated(
        'boxView',
        frameOpenOf(() => boxView),
        () => {
          boxView?.show();
          refreshBox();
        },
      );
      break;
    case 'raisingView':
      // Seated at the open, so the Bag paints then and not at the next batch or button.
      openSeated(
        'raisingView',
        frameOpenOf(() => raisingView),
        () => {
          raisingView?.show();
          refreshRaising();
        },
      );
      break;
    case 'questLogView':
      openQuestLog();
      break;
    case 'social':
      openSocial(socialTabOf(tab));
      break;
    case 'profileView':
      openProfile(profileSectionOf(tab) ?? 'name');
      break;
    case 'helpView':
      openHelp();
      break;
    case 'controlsView':
      openControls();
      break;
  }
}

/** Apply one menu step: the effect, then a repaint.
 *  `tab` is the tab an accelerator's path names (none from the menu: Monsters opens on Party,
 *  design §5, and Social on the tab its screen picks). */
function applyMenuStep(step: MainMenuStep, tab?: AccelPath['tab']): void {
  // The feedback line is not a live region: a Y description or a disabled entry's reason is said
  // here, once per change of the line.
  const said = feedbackAnnouncement(menuState.feedback, step.state.feedback);
  if (said !== null) announceNow(said);
  menuState = step.state;
  switch (step.effect.kind) {
    case 'none':
      break;
    case 'open':
      openMenuTarget(step.effect.target, tab);
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
// the next stack and `applyStack` closes what it drops through each view's own hide path.

/** The read-only context adapters build their view models from. The getters read live state: the
 *  bound ids and the one `motionPreference` (never a second `matchMedia` read, A11Y-28). */
const screenCtx: ScreenContext = {
  store,
  get identity() {
    return identity;
  },
  get bindings() {
    return bindings;
  },
  now: () => performance.now(),
  // qf-3: the wall clock, for the Monsters sheet's care readiness against the server-epoch
  // anchor (`performance.now()` is ms since navigation and would read every care as cooling).
  wallNowMs: () => Date.now(),
  get shopId() {
    return boundShopId;
  },
  get healLocationId() {
    return boundHealLocationId;
  },
  get socialTab() {
    return boundSocialTab;
  },
  get proposeTarget() {
    return boundProposeTarget;
  },
  get monstersTab() {
    return boundMonstersTab;
  },
  get reduceMotion() {
    return motionPreference.reduceMotion;
  },
};

/** A settled promise for the arms that have no reducer promise to hand back. */
const DONE: Promise<void> = Promise.resolve();
/** The care in flight per monster (its token), set by the `care` arm of `dispatch`. */
const careInFlight = new Map<bigint, object>();

/** The kinds one feedback action's outcome takes: its own success kind, its own rejection, and the
 *  shared link-down kind when no call was made (uif-4b). */
interface ActionKinds {
  readonly ok: SinkKind;
  readonly rejected: SinkKind;
}

/** A feedback action's sink: the outcome goes to its kind's policy channel (the toast for every
 *  action here). No overlay owns a message line, so a late settle after its overlay closed paints
 *  nothing into it (UIF4B.3); the timed toast carries the outcome instead, as `reportError` does
 *  for a frame that was left. */
const actionFeedback =
  (kinds: ActionKinds) =>
  (message: string, outcome: CareOutcome): void => {
    route(outcome === 'disconnected' ? 'link-down-send' : kinds[outcome], message);
  };
const SHOP_BUY = actionFeedback({ ok: 'shop-buy-ok', rejected: 'shop-rejected' });
const SHOP_SELL = actionFeedback({ ok: 'shop-sell-ok', rejected: 'shop-rejected' });
const TRADE_ANSWER = actionFeedback({ ok: 'trade-answered', rejected: 'trade-rejected' });
const TRADE_SETTLE = actionFeedback({ ok: 'trade-settled', rejected: 'trade-rejected' });
const TRADE_CANCEL = actionFeedback({ ok: 'trade-cancelled', rejected: 'trade-rejected' });
const TRADE_PROPOSE = actionFeedback({
  ok: 'trade-offer-sent',
  rejected: 'trade-propose-rejected',
});
const RENAME = actionFeedback({ ok: 'rename-saved', rejected: 'rename-rejected' });
const ownPartyIds = (): bigint[] =>
  store
    .ownMonsters(identity)
    .filter((m) => m.partySlot !== PARTY_SLOT_NONE)
    .map((m) => m.monsterId);

/** The own monsters in the player's open trade, either side of it: neither offered to a deploy nor
 *  committed to a challenge (the server refuses a traded monster at both). */
function tradedIds(): ReadonlySet<bigint> {
  const offer = store.ownTradeOffer(identity);
  return new Set<bigint>([
    ...(offer?.initiatorMonsterIds ?? []),
    ...(offer?.counterpartyMonsterIds ?? []),
  ]);
}
/** bt-15 (BT15.1): the monsters a challenge may commit — party-slotted, conscious and untraded, in
 *  slot order (`consciousPartyIds`); the pick sends the first N of them. */
const eligibleChallengeIds = (): bigint[] =>
  consciousPartyIds(store.ownMonsters(identity), tradedIds(), PARTY_SLOT_NONE);
/** bt-15 (BT15.1): the own `battle_deploy` row(s) of `battleId` are all locked — this side has
 *  deployed and waits for the other side's lock (a Practice battle stages two own rows in turn). */
function ownDeployLocked(battleId: bigint): boolean {
  const mine = store.battleDeploys(battleId).filter((d) => d.owner === identity);
  return mine.length > 0 && mine.every((d) => d.locked);
}

/** C5: a REJECTED answer changed no server row — the request is still Pending, so the optimistic
 *  `answeredRequests` key is released and the banner, badges and Y answer it again. Handed to the
 *  answer arms' helpers (`performCare`'s `onRejected`, `sendGuarded`'s third argument), which is
 *  the only place the rejection is observable: both report it and resolve. */
const releaseAnswered = (key: string) => (): void => {
  answeredRequests.delete(key);
};

/** Run one command. Not async: each arm hands back its own reducer promise (a view's lock holds
 *  until it settles), and a synchronous throw stays synchronous. No default arm, so a new
 *  `Command` fails client-typecheck here. `line` is the outcome line of the frame that sent it
 *  (qf-2: the Monsters sheet's care and train answer there); a view callback passes none. */
function dispatch(command: Command, line?: OutcomeLine): Promise<void> {
  if (refusedInBattle(command)) return DONE;
  // An answer leaves the request out of the world's notices until the server row changes (ctl-13).
  // The add stays optimistic — on answer, not settle, so the banner never flashes while the answer
  // is in flight; the arm's reject path releases it again (`releaseAnswered`, C5).
  if (command.kind === 'respondTrade') answeredRequests.add(`trade-${command.tradeId}`);
  if (command.kind === 'acceptChallenge' || command.kind === 'declineChallenge')
    answeredRequests.add(`challenge-${command.challengeId}`);
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
        (isBareBattle(contextStack) || overlayVerdict('menuView').kind === 'allow')
      ) {
        openMenu();
      }
      return DONE;
    }
    case 'toggleHelp':
      if (helpView?.visible) {
        applyStack(contextStack, contextStep(contextStack, { kind: 'pop', id: 'helpView' }).stack);
      } else if (
        // At the bare battle base Select opens it over the battle, as Start opens the menu there.
        isBareBattle(contextStack) ||
        overlayVerdict('helpView').kind === 'allow'
      ) {
        openHelp();
      }
      return DONE;
    case 'reportProblem':
      // How to Play's Report a problem row (uif-14b): the same bundle F9 saves, through the same path.
      downloadBugBundle();
      return DONE;
    case 'care': {
      // The whole decision (frozen gate / await / exactly-one message) lives in the tested
      // performCare core. The answer goes to the line of the frame that sent it (the Monsters
      // sheet's, qf-2; a frame left since paints nothing), or with no such line to the toast (uif-4).
      // qf-9: one care in flight per monster: a second A before the answer would flash "Cared!"
      // then the cooldown.
      const { monsterId } = command;
      if (careInFlight.has(monsterId)) return DONE;
      const cared = i18nT('raising.feedback.cared');
      const token = {};
      careInFlight.set(monsterId, token);
      return performCare({
        call: () => liveReducers()?.care({ monsterId }),
        successMessage: cared,
        where: 'care',
        showFeedback: (message, outcome) => {
          if (line !== undefined) line(message, outcome === 'ok' ? 'ok' : 'error');
          else
            route(
              outcome === 'ok'
                ? 'care-success'
                : outcome === 'disconnected'
                  ? 'link-down-send'
                  : 'care-rejected',
              message,
            );
        },
      }).finally(() => {
        // Only this care's own token releases: a reconnect may have cleared it and a newer care
        // taken the slot.
        if (careInFlight.get(monsterId) === token) careInFlight.delete(monsterId);
      });
    }
    case 'train': {
      // Success is the sheet's own "Fed" line once the batch lands; a failure goes to `line`.
      const { monsterId, foodItemId } = command;
      return sendGuarded(
        'train',
        () => conn?.live()?.reducers.train({ monsterId, foodItemId }),
        undefined,
        line,
      );
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
      const move = resolvePartySlot(command.slot, store.ownMonsters(identity), PARTY_SIZE);
      if (move.kind === 'partyFull') {
        reportError('party-full', i18nT('chrome.status.partyFull'));
        return DONE;
      }
      const { slot } = move;
      return sendGuarded('party', () => conn?.live()?.reducers.setPartySlot({ monsterId, slot }));
    }
    case 'healParty': {
      // The location a bound heal frame names: healing happens only at a healer (B13; ctl-10a
      // retired the Box button and its first-location guess). With none bound the send is
      // skipped, surfaced, never silent; the server still validates zone and cooldown.
      const locationId = command.locationId;
      if (locationId === undefined) {
        reportError('heal-unavailable', i18nT('chrome.status.healUnavailable'));
        return DONE;
      }
      return sendGuarded('heal', () => conn?.live()?.reducers.healParty({ locationId }));
    }
    case 'buy': {
      const { shopId, itemId, qty } = command;
      if (refusedShopQty('buy', qty)) return DONE;
      // The line is resolved now, from the rows as they are at the send.
      const moved = buyFeedback(shopId, itemId, qty, store.allShopItems(), store.itemDefs());
      return performCare({
        call: () => liveReducers()?.buy({ shopId, itemId, qty }),
        successMessage:
          moved.kind === 'item'
            ? tf('shop.feedback.buy.item', { qty, name: moved.name, gold: moved.gold })
            : tf('shop.feedback.buy.count', { qty }),
        where: 'buy',
        showFeedback: SHOP_BUY,
      });
    }
    case 'sell': {
      const { itemId, qty } = command;
      if (refusedShopQty('sell', qty)) return DONE;
      // Resolved now as well: a sell-all removes the inventory row before the line shows.
      const moved = sellFeedback(itemId, qty, store.itemDefs());
      return performCare({
        call: () => liveReducers()?.sell({ itemId, qty }),
        successMessage:
          moved.kind === 'item'
            ? tf('shop.feedback.sell.item', { qty, name: moved.name, gold: moved.gold })
            : tf('shop.feedback.sell.count', { qty }),
        where: 'sell',
        showFeedback: SHOP_SELL,
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
        showFeedback: TRADE_ANSWER,
        onRejected: releaseAnswered(`trade-${tradeId}`),
      });
    }
    case 'confirmTrade': {
      const { tradeId } = command;
      return performCare({
        call: () => liveReducers()?.confirmTrade({ tradeId }),
        successMessage: i18nT('trade.feedback.completed'),
        where: 'confirm-trade',
        showFeedback: TRADE_SETTLE,
      });
    }
    case 'cancelTrade': {
      const { tradeId } = command;
      return performCare({
        call: () => liveReducers()?.cancelTrade({ tradeId }),
        successMessage: i18nT('trade.feedback.cancelled'),
        where: 'cancel-trade',
        showFeedback: TRADE_CANCEL,
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
        showFeedback: TRADE_PROPOSE,
      });
    }
    case 'challenge': {
      // bt-15 (BT15.1): the committed list is the first `partySize` ELIGIBLE monsters (party-slotted,
      // conscious, untraded, slot order), read inside the closure AT SEND TIME; the server derives
      // `format` from its length. The sheet already re-validated the size at A (actionSheetModel.ts);
      // this re-check is belt and braces for the closure: fewer eligible than picked sends nothing —
      // never a shorter list than the pick the player confirmed.
      const { targetIdentity: target, partySize } = command;
      return sendGuarded('pvp-challenge', () => {
        const partyIds = eligibleChallengeIds().slice(0, partySize);
        if (partyIds.length < partySize) return undefined;
        return conn?.live()?.reducers.challengePvp({ target: new Identity(target), partyIds });
      });
    }
    case 'acceptChallenge': {
      const { challengeId } = command;
      return sendGuarded(
        'pvp-accept',
        () => conn?.live()?.reducers.acceptChallenge({ challengeId, partyIds: ownPartyIds() }),
        releaseAnswered(`challenge-${challengeId}`),
      );
    }
    case 'declineChallenge': {
      const { challengeId } = command;
      return sendGuarded(
        'pvp-decline',
        () => conn?.live()?.reducers.declineChallenge({ challengeId }),
        releaseAnswered(`challenge-${challengeId}`),
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
        showFeedback: RENAME,
      });
    }
    case 'submitQueue': {
      // bt-11: a unit's plan (a live commit or a pre-queue) to `submit_queue`; the server costs it
      // on its board and refuses with a typed reason, reported like every other rejection.
      const { battleId, unitId, entries } = command;
      return sendGuarded(
        'submit-queue',
        () => conn?.live()?.reducers.submitQueue({ battleId, unitId, entries: [...entries] }),
        // A refusal (a stale turn, a race) releases the unit's in-flight key so the next commit for
        // the same turn goes out (REV B2.3); a success keeps it until the READY row, the landed
        // budget or a new turn. The repaint runs inside a promise handler: a throw is reported, not
        // left as an unhandled rejection.
        () => {
          try {
            tacticsBattle?.release(unitId);
          } catch (err) {
            reportPaintError(err);
          }
        },
      );
    }
    case 'cancelQueue': {
      // The cancel race (design §2.3): a row consumed at TurnStart answers `AlreadyActing`, which
      // is a notice ("Too late — already acting"), not an error; every other refusal is reported.
      const { battleId, unitId } = command;
      return sendGuarded('cancel-queue', () =>
        conn
          ?.live()
          ?.reducers.cancelQueue({ battleId, unitId })
          ?.catch((err: unknown) => {
            if (!isAlreadyActing(err)) throw err;
            route('queue-too-late', queueTooLate());
          }),
      );
    }
    case 'forfeit': {
      // bt-15 (BT15.3): the shell's confirmed Forfeit row. Active + PvP ruleset only on the server
      // (a Deploying battle is "not active"; a second press on a finished battle is refused) —
      // every refusal is reported like any other rejection.
      const { battleId } = command;
      return sendGuarded('forfeit', () => conn?.live()?.reducers.forfeit({ battleId }));
    }
    case 'deployUnits': {
      // bt-12 (BT12.2): the confirmed deploy of a Deploying wild battle. The server validates every
      // pick (owned, in the party, conscious, distinct, slot in range) and refuses with a reason,
      // reported like every other rejection; empty picks are never sent.
      const { battleId, picks } = command;
      if (picks.length === 0) return Promise.resolve();
      return sendGuarded('deploy-units', () =>
        conn?.live()?.reducers.deployUnits({ battleId, picks: [...picks] }),
      );
    }
    case 'advanceDialogue': {
      const { choiceIdx } = command;
      // qf-6: the server refuses a reply chosen too far from the NPC, in another zone, or with the
      // NPC gone — and writes nothing (an Err aborts the transaction). The client ends such a
      // conversation itself: catalogued copy on the toast (QF6.2; uif-4), then the ONE dismiss path,
      // whose server-side delete closes the overlay (never hidden locally; QF6.1). Only for the
      // conversation the reply was sent for (a later talk or another tab is left alone); a dismiss
      // already in flight closes it and keeps a picked shop. Every other rejection keeps
      // sendGuarded's report, so a battle-suspended or deletion-gated dialogue is never ended.
      const sent = store.ownConversation(identity);
      return sendGuarded('advance', () =>
        conn
          ?.live()
          ?.reducers.advanceDialogue({ choiceIdx })
          ?.catch((err: unknown) => {
            const reason = conversationEndReason(err);
            if (reason === undefined) throw err;
            const cur = store.ownConversation(identity);
            if (
              sent === undefined ||
              cur === undefined ||
              cur.npcEntityId !== sent.npcEntityId ||
              cur.currentNodeId !== sent.currentNodeId
            ) {
              return;
            }
            route('dialogue-ended', endedLine(reason));
            if (!shopOpen.dismissPending) void dispatch({ kind: 'dismissDialogue' });
          }),
      );
    }
    case 'dismissDialogue':
      // Ends the conversation and cancels a pending shop open (last intent wins). The client
      // never hides the dialogue itself: the server's row deletion does.
      stepShopOpen({ kind: 'dismissRequested' });
      return DONE;
    case 'pickShop':
      // The greet-then-shop choice (last pick wins): it ends the conversation, and the shop opens
      // on the first batch with no conversation.
      stepShopOpen({ kind: 'shopPicked', shopId: command.shopId });
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

/** Refuse a buy or sell whose quantity the reducer's u32 cannot carry: nothing is sent and no
 *  shop line is shown. Reject, never clamp. It is an adapter bug, not player input, so it is
 *  logged and the player is told nothing. `qty` is its own argument: it may not be printable. */
function refusedShopQty(kind: 'buy' | 'sell', qty: number): boolean {
  if (validShopQty(qty)) return false;
  console.error(`[dispatch] ${kind}: qty is not a quantity the reducer can carry`, qty);
  return true;
}

/** A command the battle refuses (CTL6C.3): the stack holds a battle base and the command is not
 *  battle-safe. Its reason is a timed toast (uif-4: no longer held until the battle is over), spoken
 *  through the live region; a refusal is not an error, so nothing reaches the error ring. No sync here: every
 *  batch re-derives the base (`reconcileStack`) before any listener that dispatches. A link drop
 *  can leave it a frame stale, where a refusal on the frozen link changes nothing. */
function refusedInBattle(command: Command): boolean {
  if (!battleRefused(contextStack, command)) return false;
  // A toast kind, painted on the toast; spoken at once, not through the notice pump, so the reason
  // is said in the refusal's own coalescing window (CTL6C-3-ANNOUNCE-REFUSAL).
  const reason = i18nT('menu.disabled.inBattle');
  paintToast(reason);
  announceNow(reason);
  return true;
}

/** Apply a stack move: close every frame `next` drops, top first (the order the retired Escape
 *  ladder closed them in, so privacy's dismiss flush still finds the claim shown), each through
 *  its own path; then sync, so the stack again lists exactly what is shown. */
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
      hideAllBattleViews();
      break;
    default:
      hideFrame(frame.id);
  }
}

// Where focus goes when typing stops: the first control in the field's frame that is shown,
// enabled and not itself a text field, so the frame's focus trap keeps it and the next Escape
// routes as Start. In Profile with a two-step confirm armed it is that confirm's No instead: the
// first control after the name field may be the confirm's Yes, and a confirm defaults to No.
const STOP_TYPING_TARGETS = 'button, select, input, textarea, [tabindex]:not([tabindex="-1"])';
function stopTyping(field: HTMLElement): void {
  const root = field.closest('[aria-modal="true"]');
  const armedNo =
    profileView !== undefined && root === profileView.sectionRoot && profileView.armed
      ? profileView.defaultRow()
      : undefined;
  const next =
    armedNo ??
    [...(root?.querySelectorAll<HTMLElement>(STOP_TYPING_TARGETS) ?? [])].find(
      (el) =>
        typingKey(el, { code: 'Escape' }) === undefined &&
        !el.hasAttribute('disabled') &&
        !inHiddenSubtree(el),
    );
  field.blur();
  next?.focus();
}

// Outcome-frame lifecycle (M8.7e): the dismissed battle id (so a resolved outcome
// renders once but never re-pops) + whether any battle has been observed this
// session (first-sight pre-dismiss of a historical/stale-on-login resolved battle).
let dismissedBattleId: bigint | null = null;
let battleSynced = false;
/** bt-17: the row-less anchor already reported (once per battle id) — see `refreshBattle`. */
let unrenderableReported: bigint | null = null;

// --- the message sinks (M13.5b status surface; uif-4 channels) -------------------
// Every message a main.ts sink shows names its `MessageKind`, and `feedbackPolicy` picks the
// channel (UIF4.1): an outcome is a timed toast (`#toast`, above every frame), a persistent state
// is the world hint (`#status`, the world line, or the main menu's strip while the menu is on
// top, WF1-A9). `statusEl` and the toast are created in main() BEFORE `conn = connect(...)` is
// assigned (C8: no lifecycle callback can ever report into the void) but held at module scope
// because send sites OUTSIDE main() (the Escape-dismiss keydown handler and the dialogue-choice
// click handler) report through them too. textContent ONLY: server-supplied SenderError text must
// never become markup.
let statusEl: HTMLElement | undefined;
let toastChrome: ToastChrome | undefined;
let toastState: ToastState = NO_TOAST;
/** The standing world hints, one per kind, newest last; the shown one is the top of WF1-A9's
 *  precedence (`topHint`). `saidHint` is the last hint text given to the live region, so a repaint
 *  on another host never says it again; `menuHint` is the hint the menu's strip last painted. */
let worldHints: ReadonlyArray<{ readonly kind: MessageKind; readonly text: string }> = [];
let saidHint: string | null = null;
let menuHint: string | null = null;

/** Show `text` on its policy channel: THE one seam every main.ts message goes through, so no view
 *  picks a channel (UIF4B.1). A hint kind paints on `hintHost`, the open frame's own strip, when
 *  the caller has one (Controls' refused key, uif-4b), else it is a world hint. */
function route(kind: SinkKind, text: string, hintHost?: (text: string) => void): void {
  if (channelOf(kind) !== 'hint') showToast(text);
  else if (hintHost !== undefined) hintHost(text);
  else setWorldHint(kind, text);
}

/** Surface a user-visible failure on `line` (the sending frame's outcome line, qf-2) or, when there
 *  is none or it no longer paints (the frame was left: the per-sink guard), on its policy channel;
 *  plus console.error for logs and the error ring either way. */
function reportError(kind: SinkKind, text: string, line?: OutcomeLine): void {
  if (line?.(text, 'error') !== true) route(kind, text);
  console.error('[status]', text);
  // unify UI/reducer failures into the error ring so the F9 bundle captures them.
  pushError('reducer', text);
}

/** Paint a toast and queue it for the live region: spoken once by the frame pump, clear of the
 *  announcements that land beside it (qf-6, ui/statusModel.ts statusNoticeStep). */
function showToast(text: string): void {
  const nowMs = paintToast(text);
  statusNotice = statusNoticeStep(
    statusNotice,
    { kind: 'queue', text, nowMs },
    COALESCE_WINDOW_MS,
  ).state;
}

/** Paint `text` on the toast, timed from now; returns that now. */
function paintToast(text: string): number {
  const nowMs = performance.now();
  toastState = toastStep(toastState, { kind: 'show', text, nowMs });
  if (toastChrome !== undefined) renderToast(toastChrome, toastState);
  return nowMs;
}

/** The frame pump's toast expiry (UIF4.2: through the injected frame clock). */
function tickToast(nowMs: number): void {
  const next = toastStep(toastState, { kind: 'tick', nowMs });
  if (next === toastState) return;
  toastState = next;
  if (toastChrome !== undefined) renderToast(toastChrome, toastState);
}

/** A persistent hint stands until its state ends; a new one of its kind replaces it, and any new
 *  hint overwrites a `download-blocked` ("until overwritten"). The shown hint is said once per new
 *  text and painted on the host the stack picks. */
function setWorldHint(kind: MessageKind, text: string): void {
  worldHints = [
    ...worldHints.filter((h) => h.kind !== kind && h.kind !== 'download-blocked'),
    { kind, text },
  ];
  paintWorldHint();
}

/** The shown world hint: the highest WF1-A9 rank, the newer of two equals; null when none stands. */
function topHint(): string | null {
  let top: { readonly kind: MessageKind; readonly text: string } | null = null;
  for (const h of worldHints) if (top === null || outranks(h.kind, top.kind)) top = h;
  return top?.text ?? null;
}

/** The world hint's text when the main menu, on top, hosts it on its strip; else null. */
function hintOnMenu(): string | null {
  return menuPlace() === 'top' ? topHint() : null;
}

/** Paint the world hint on its host: the menu's strip while the menu is on top, else `#status`
 *  (above every shell, so it stays readable while a frame without a seam strip is open). Runs on
 *  every stack sync, so it writes only on a change. */
function paintWorldHint(): void {
  const shown = topHint();
  if (shown !== saidHint) {
    saidHint = shown;
    if (shown !== null) announceNow(shown);
  }
  const onMenu = hintOnMenu();
  const text = shown === null || onMenu !== null ? '' : shown;
  if (statusEl !== undefined && statusEl.textContent !== text) statusEl.textContent = text;
  if (onMenu !== menuHint) {
    menuHint = onMenu;
    renderMenu();
  }
}

/** On reconnect: the link states and the toast are stale (A8); `content-stale` stands until reload. */
function resetFeedbackSinks(): void {
  worldHints = worldHints.filter((h) => h.kind === 'content-stale');
  toastState = NO_TOAST;
  if (toastChrome !== undefined) renderToast(toastChrome, toastState);
  paintWorldHint();
}

// qf-6: a status NOTICE is an outcome that is not an error — a conversation the server ended for
// a reason, a quest completed. It goes to the toast (uif-4; textContent only, never markup) and is
// queued for the live region, spoken by the frame pump clear of the announcements that land beside
// it (ui/statusModel.ts statusNoticeStep: why and when).
let statusNotice: StatusNoticeState = STATUS_NOTICE_INITIAL;
/** An announcement made outside the frame pump since its last frame: the pump treats it as a
 *  transition, so a queued notice is held clear of it and a notice it clobbered is said again. */
let announcedSinceFrame = false;

/** Announce through the live region from outside the frame pump (a refusal, a request line, a
 *  view's own announcement) and let the pump know. */
function announceNow(text: string): void {
  liveRegion.announce(text, performance.now());
  announcedSinceFrame = true;
}

/** The catalogued line for a conversation the server ended on a refused advance (QF6.2): it says
 *  the conversation ended and why. A literal switch — catalog keys are never built dynamically. */
function endedLine(reason: ConversationEndReason): string {
  switch (reason) {
    case 'walkedAway':
      return i18nT('dialogue.ended.walkedAway');
    case 'leftZone':
      return i18nT('dialogue.ended.leftZone');
    case 'npcGone':
      return i18nT('dialogue.ended.npcGone');
    default:
      return reason satisfies never;
  }
}

// --- F9 bug-bundle observability rings + error overlay -----------
// The rings are the SESSION buffer (survive reconnect/zone-switch — only the emit
// latches re-baseline). tMs comes from Date.now() in production; the rings inject the
// clock so their unit tests stay deterministic. The overlay is mounted in main().
const eventRing = new EventRing(() => Date.now());
const errorRing = new ErrorRing(() => Date.now());
let errorOverlayView: ErrorOverlayView | undefined;
let hintBarView: HintBarView | undefined;
/** The newest ring sequence the error toast showed when it was last dismissed (ctl-13). */
let toastDismissedSeq = -1;

/** Dismiss the error toast (world B or F8): what it showed is not listed again. */
function dismissErrorToast(): void {
  toastDismissedSeq = errorRing
    .snapshot()
    .reduce((max, r) => Math.max(max, r.tSeq), toastDismissedSeq);
  errorOverlayView?.dismiss();
}
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
      // The toast lists the errors since its last dismissal (ctl-13): a dismissed one stays gone.
      errorOverlayView.render(
        buildErrorOverlayModel(
          errorRing
            .snapshot()
            .filter((r) => r.tSeq > toastDismissedSeq && !r.message.startsWith(MOVE_REJECT_PREFIX)),
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
 * (movement — silent prediction repair in sendIntent, M2 §3), the join (conn.join() — its
 * failures surface from connection.ts, A4), and the overlay-feedback actions (care, shop buy/sell, trade,
 * rename, trade-propose — routed through performCare in main(), A6).
 * ALWAYS resolves (frozen, dead handle, reported rejection) — views holding an
 * in-flight lock `return` it so the lock lives exactly until the call settles.
 * `onRejected` threads a settled rejection out to the caller (C5: a rejected challenge
 * answer releases its answeredRequests key); the frozen and dead-handle arms never
 * call it — no reducer ran, nothing settled. `line` is the sending frame's outcome line, where
 * both failure arms report instead of the policy channel while it still paints (qf-2).
 */
function sendGuarded(
  where: SendWhere,
  call: () => Promise<void> | undefined,
  onRejected?: () => void,
  line?: OutcomeLine,
): Promise<void> {
  if (conn === undefined || conn.linkFrozen()) {
    reportError('link-down-send', tf('chrome.status.disconnected', { where }), line);
    return Promise.resolve();
  }
  const p = call();
  if (p === undefined) return Promise.resolve();
  return p.catch((err: unknown) => {
    reportError(SEND_REJECT_KIND[where], reduceErrorMessage(err, where), line);
    onRejected?.();
  });
}

/** Every `sendGuarded` site, and the message kind its rejection is (the channel table). */
const SEND_REJECT_KIND = {
  talk: 'world-send-rejected',
  dismiss: 'world-send-rejected',
  advance: 'world-send-rejected',
  ackEvolutionNotices: 'world-send-rejected',
  train: 'feed-rejected',
  evolve: 'evolve-rejected',
  nickname: 'nickname-rejected',
  party: 'party-move-rejected',
  heal: 'heal-rejected',
  'pvp-challenge': 'pvp-rejected',
  'pvp-accept': 'pvp-rejected',
  'pvp-decline': 'pvp-rejected',
  'pvp-cancel': 'pvp-rejected',
  'submit-queue': 'pvp-rejected',
  'cancel-queue': 'battle-command-rejected',
  forfeit: 'battle-command-rejected',
  'deploy-units': 'battle-command-rejected',
} as const satisfies Record<string, SinkKind>;
type SendWhere = keyof typeof SEND_REJECT_KIND;

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
  // bt-12 B: the shell forgets its battle (a submit the dropped link lost must not keep a unit's
  // turn locked) and hides, so the next sighting feeds the transcript from seq 0 while hidden (a
  // visible shell would replay the history as live beats); the memos reset.
  tacticsBattle?.reset();
  tacticsBattle?.hide();
  tacticsIngested = null;
  tacticsShown = null;
  lastTacticsVM = null;
  stillThereAnnouncedFor = null;
  // Reset camera hold so a fresh zone/reconnect starts at origin rather than
  // holding a position from a prior zone.
  lastCamX = 0;
  lastCamY = 0;
  // re-baseline the event-emit latches (NOT the rings — those are the
  // session buffer). After a reconnect/zone-switch the old battle is GC'd and the rating
  // baseline must be re-seeded from the first fresh batch, not carried across.
  battleEmit = resetBattleEmit(battleEmit);
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
  let switched = false;
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
    switched = true;
  } catch (err) {
    console.error('[zone-sync] zone switch to %s failed — keeping current zone', newZoneId, err);
    zoneSyncFailureCount++;
    if (shouldReportZoneSyncFailure(zoneSyncFailureCount)) {
      reportError('content-stale', i18nT('chrome.status.contentStale'));
    }
  }
  // qf-15 (QF15.1): name the zone the SERVER put the character in — toast + live region
  // (route) — only after a committed switch. Its own try keeps switchZone total (onOwnWarp calls
  // it unguarded, before the warped row is ingested) and keeps a cue failure out of the zone-sync
  // failure streak. Both warp paths (onOwnWarp, the reconcile listener) converge here and the guard
  // above makes one real zone change exactly one cue. The name is content (zone_def rows in the
  // store); an unknown zone announces nothing. A rejoin whose character is in a zone other than the
  // map the client shows announces too.
  if (!switched) return;
  try {
    const name = store.zoneName(newZoneId);
    if (name !== undefined) route('zone-cue', tf('chrome.status.zoneEntered', { name }));
  } catch (err) {
    console.error('[zone-cue] announcing zone %s failed', newZoneId, err);
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
// button (and a nav-capable screen's D-pad) to the top frame's adapter. It also decides each
// accelerator (`accelDecision`).
let keyboard = new KeyboardSource(bindings);
const inputRouter = new InputRouter();

// What the router needs to know: whether the world takes input, the nav frame (a nav-capable
// screen on top, else the main menu, on top or covered by a legacy frame) plus the clock its
// auto-repeat runs on, and the top frame's adapter.
const routeCtx = (): RouteContext => {
  const worldActive = movementGate(); // the stack as the keydown's opening sync left it
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
    screen: (btn) => {
      // Every button ends the Monsters frame's last outcome line (qf-2), as it ends the screen's.
      boxView?.clearOutcome();
      const sheetWas = screenHost.sheetOpen;
      const result =
        battleButton(
          contextStack,
          btn,
          outcomeShownAtMs === null ? undefined : performance.now() - outcomeShownAtMs,
          tacticalOwnsStart(),
        ) ??
        screenHost.button(contextStack, btn, screenCtx, identity === '' ? undefined : worldPort);
      // The world sheet opening or closing is a frame edge for held input (B14): no walk or
      // D-pad repeat straddles it.
      if (screenHost.sheetOpen !== sheetWas) {
        held.clear();
        inputRouter.resetRepeat();
      }
      return result;
    },
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
      // A screen's command answers on its frame's line: the Monsters sheet's (qf-2).
      void dispatch(
        effect.command,
        upperIds().at(-1) === 'boxView' ? boxView?.feedbackLine() : undefined,
      );
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

// An accelerator press (CTL11A.1, CTL11A.2): refused, Start on its own screen, or its canonical
// menu path opened from the base.
const runAccel = (accel: MenuAccel): void => {
  const decision = accelDecision(accel, contextStack);
  switch (decision.kind) {
    case 'denied':
      break;
    case 'start': {
      // Profile's two accelerators share its frame (uif-16b): the one whose section does not hold
      // the cursor moves it there (from the other section, the Close row or the page); pressed
      // with the cursor already in its own section it is Start, like every other.
      const section = profileSectionOf(ACCEL_PATHS[accel].tab);
      if (section !== undefined && profileView?.sectionOf(document.activeElement) !== section) {
        profileView?.focusSection(section);
      } else {
        routeEdge({ button: 'Start', down: true });
      }
      break;
    }
    case 'open':
      openAccelPath(decision.path);
      break;
    default:
      decision satisfies never;
  }
};

// Pop to the base, open the menu and pick each entry of `path`, so the menu stays beneath the leaf
// with its cursor on it. Over a battle the menu opens read-only and a disabled entry only shows its
// reason (CTL6C.3).
const openAccelPath = (path: AccelPath): void => {
  // The menu's screens read store state keyed by identity, which is '' before join. Profile's
  // sections read none that matters there (`ownAccount('')` and `player('')` are undefined, and
  // every command is refused without a live link) and a failed first sign-in shows it before
  // join, so C alone opens it there, on Account, with no menu beneath.
  if (identity === '') {
    if (path.frame === 'profileView' && profileSectionOf(path.tab) === 'account') {
      openProfile('account');
    }
    return;
  }
  applyStack(contextStack, popToBase(contextStack));
  // A frame the pop could not take (a server-owned one) stays on top: the menu never opens over it.
  if (contextStack.length > 1) return;
  openMenu(); // pushes the menu before the leaf it opens
  for (const key of path.menu) applyMenuStep(mainMenuPick(menuState, key), path.tab);
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

// A remap applies at once (CTL12B.2): saved, then every input path reads the new table. The
// keyboard source takes its table at construction, so it is replaced; whatever was held is
// released first, or its keyup (unknown to the new source) would leave a button stuck. False when
// the table could not be saved: it still applies, until the page reloads.
const applyBindings = (next: Bindings): boolean => {
  const saved = saveBindings(browserStorage(), next);
  releaseAllInput();
  bindings = next;
  keyboard = new KeyboardSource(next);
  return saved;
};

// The slot of Controls waiting for a key, while that frame is the top one; else null.
const controlsCapture = (): SlotTarget | null => {
  const top = contextStack[contextStack.length - 1];
  if (top.kind !== 'screen' || top.id !== 'controlsView') return null;
  return controlsView?.capturing ?? null;
};

// End the capture in the screen: its B while a slot waits (real keys never reach it then). The
// host repaints, so the rows show the table as it is now.
const endControlsCapture = (): void => {
  screenHost.button(contextStack, { button: 'B', repeat: false }, screenCtx);
};

// A key pressed while `target` waits for one (CTL12.2): any key is taken, Escape, Enter and
// Backspace included, before any other path can read it. A refused key keeps the slot waiting.
const captureControlsKey = (target: SlotTarget, e: KeyboardEvent): void => {
  const step = captureStep(bindings, target, e);
  if (step.prevent) e.preventDefault();
  if (!step.done) {
    // A refused key: the capture still waits, so its reason is a hint on the frame's strip.
    route('controls-refused', step.text, (hint) => controlsView?.showHint(hint));
    return;
  }
  if (step.bindings === undefined) toastControls('controls-cancelled', step.text);
  else if (applyBindings(step.bindings)) toastControls('controls-saved', step.text);
  else toastControls('controls-save-failed', step.text, false);
  // The captured key's OS repeats are not presses of its new button.
  navHeldCodes.add(e.code);
  endControlsCapture();
};

// The Cancel chip: a capture ends unchanged. Nothing happens unless a slot is waiting.
const cancelControlsCapture = (): void => {
  syncStack();
  if (controlsCapture() === null) return;
  toastControls('controls-cancelled', outcomeText({ kind: 'cancelled' }));
  endControlsCapture();
};

// A Controls outcome on its policy channel (the toast); an unsaved change says so, through the
// view module's `savedLine` (taken with the lazily loaded view at boot).
const toastControls = (kind: SinkKind, text: string, saved = true): void => {
  route(kind, controlsSavedLine?.(text, saved) ?? text);
};

// The pointer source (ctl-15): built at boot on #game-screen, it only presses virtual buttons.
let pointerSource: PointerSource | null = null;
// The world prompt's paint (uif-12), set at boot: a pointer press repaints the world sheet at once,
// because the pointer source's seek reads the row cursor from the DOM right after each press.
let paintWorldPrompt: (() => void) | null = null;

// One pointer press: the button's down and up edges through the router, the stack synced on both
// sides as a keydown does. Like every input path it is dead while the session terminal shows.
const pointerPress = (button: VButton): void => {
  if (sessionGateBlocks()) return;
  syncStack();
  try {
    routeEdge({ button, down: true });
    routeEdge({ button, down: false });
  } finally {
    syncStack();
  }
  // After the press, not in the finally: a paint error must never mask the router's own.
  paintWorldPrompt?.();
};

// What a click can reach: the canvas only at the bare world base (an open world sheet would take A
// as Accept or a pick), a row only in a screen or prompt frame.
const pointerTop = (): PointerTop => {
  const top = contextStack[contextStack.length - 1];
  if (contextStack.length === 1 && top.kind === 'world') {
    return screenHost.sheetOpen ? 'other' : 'world';
  }
  return top.kind === 'screen' || top.kind === 'prompt' ? 'frame' : 'other';
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
    ownership(e.target, e, gameScreenEl()) === 'router'
  )
    e.preventDefault();
};

let worldCanvasEl: HTMLElement | null = null;
// The game screen, read per key so a page that gains or lacks the shell is read as it is now.
const gameScreenEl = (): HTMLElement | null => document.getElementById('game-screen');
// The ONE announcer (S1 ships the machine; S5 owns the singleton and pumps it — a live region
// nothing flushes is permanently silent and nothing else reds).
const liveRegion = new LiveRegion();
let lastA11ySnapshot: A11ySnapshot = { topOverlay: null, message: '' };

// the stale-focus discriminator.
// After a close, real Chromium leaves document.activeElement on a node INSIDE the hidden
// overlay for up to ~200 ms (its blur fixup is async, and closeOverlayA11y's explicit
// restore to <body> is a no-op there because <body> carries no tabindex) — so the close
// edge reads a stale anchor and focus never returns to the world.
// Inline `style.display = 'none'` is this repo's ONE hiding idiom — every overlay in both
// shell families hides that way — so the ancestor walk is the exact discriminator, and it
// is engine-independent. `checkVisibility()` was rejected: this happy-dom version does not
// implement it, which would make the unit-tier proof vacuous. The walk cannot match the
// always-on hint-bar chips (they and every ancestor are display-visible), so the D4
// no-steal guarantee survives — pinned by S5T-FOCUS-NO-STEAL.
function inHiddenSubtree(start: Element | null): boolean {
  for (let el = start; el instanceof HTMLElement; el = el.parentElement) {
    if (el.style.display === 'none') return true;
  }
  return false;
}
const focusInsideHiddenSubtree = (): boolean => inHiddenSubtree(document.activeElement);
/** Focus nowhere a player can use it: on <body> (or nothing), or stranded in a hidden subtree. */
const focusAdrift = (): boolean => {
  const a = document.activeElement;
  return a === null || a === document.body || focusInsideHiddenSubtree();
};

// A close is judged by the first sync that sees it (the closing task on every keydown, dispatch and
// batch path), not by the frame edge a rAF later, where a move made since (the chip blurred, rb-19)
// would read as a close that left focus adrift. Not while the session terminal holds the screen: the
// terminal's own focus is not the close's, so the first sync after it lifts judges.
let syncedTop: OverlayId | null = null;
let closeLeftFocusAdrift = false;
function judgeCloseFocus(): void {
  if (sessionGateBlocks()) return;
  const top = topOverlay();
  if (syncedTop !== null && top === null) closeLeftFocusAdrift = focusAdrift();
  syncedTop = top;
}

const onKeyDown = (e: KeyboardEvent): void => {
  // Every press teaches the keycap what this layout types on that key (CTL12.5).
  learnKey(e.code, e.key, e);
  // Focus outside the game screen (and not on <body>) leaves every key to the browser (CTL11B.1).
  if (outsideGameScreen(e.target, gameScreenEl())) return;
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
  // Controls is waiting for a key (CTL12B.1): this press is the capture's, ahead of
  // every path below, so Escape, Enter and Backspace can be bound like any key. The one exception
  // is the Cancel chip's own activation key (Enter or Space with the chip focused): it presses
  // the chip, so a capture can always be left from the keyboard.
  const capture = controlsCapture();
  if (capture !== null) {
    const pressesChip =
      controlsView?.isCancelChip(e.target) === true &&
      ownership(e.target, e, gameScreenEl()) === 'target';
    if (!pressesChip) captureControlsKey(capture, e);
    return;
  }
  // a press can arrive INSIDE the stale-focus window, before the frame edge has run — heal
  // first, so the typing branch and every screen opened below see the healed focus.
  if (focusInsideHiddenSubtree()) worldCanvasEl?.focus();
  // An Escape that cancels an IME composition is the IME's: not prevented and not routed, and kept
  // from the field's own Escape listener, which would close the frame and drop the draft. Before
  // the accelerators: a remap can bind Escape to one.
  if (e.code === 'Escape' && (e.isComposing || e.keyCode === 229)) {
    e.stopPropagation();
    return;
  }
  // The two keys a focused field releases keep their typing meaning whatever the table binds
  // them to (design §3): Escape stops typing, Enter commits.
  const typing = typingKey(e.target, e);
  // An accelerator is decided through the live table (a cleared one does nothing). A key the
  // focused element owns is never one: a remap can put an accelerator on a letter, Space or Enter,
  // and that key must still type into a field and press a focused button. Nor is a typing key
  // (CTL6B.5).
  const accel =
    typing === undefined && ownership(e.target, e, gameScreenEl()) === 'router'
      ? accelForCode(bindings, e.code)
      : undefined;
  // The F9 accelerator downloads the local bug bundle; F8 dismisses the error overlay: EARLY
  // (before the menu and the router) so they work under any overlay.
  if (accel === 'F9') {
    downloadBugBundle();
    e.preventDefault();
    return;
  }
  if (accel === 'F8') {
    // Only preventDefault when the overlay is actually visible (non-blocking otherwise).
    if (errorOverlayView?.visible) {
      dismissErrorToast();
      e.preventDefault();
    }
    return;
  }
  // Typing mode (CTL6B.5): Escape in the focused text field stops typing. Focus leaves the field,
  // its text stays, and the view's own Escape (a close) never runs; the next Escape is Start. A
  // stale target (focus already healed away from a closed frame's field) is not typing.
  if (
    typing === 'stopTyping' &&
    e.target instanceof HTMLElement &&
    e.target === document.activeElement
  ) {
    stopTyping(e.target);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // Enter in a field commits: it presses A there, never the button or accelerator a remap put on
  // Enter (after A := K the field types K, so Enter is the only key left to commit with).
  if (typing === 'commit') {
    if (routeEdge({ button: 'A', down: true })) {
      navHeldCodes.add(e.code);
      e.preventDefault();
    }
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
  // accelerator path below. Unconsumed keys (accelerators) fall through, unrouted a second time.
  if (menuPlace() === 'top' || screenHost.takesNav(contextStack)) {
    let consumed = false;
    for (const edge of keyEdges()) consumed = routeEdge(edge) || consumed;
    if (consumed) {
      navHeldCodes.add(e.code);
      e.preventDefault();
      return;
    }
  }
  // An accelerator (ctl-11a): the router decides it over the stack.
  if (accel !== undefined) {
    e.preventDefault();
    runAccel(accel);
    return;
  }
  // The router owns the D-pad and Space from here: it swallows them while an overlay is open
  // (the page-scroll fix), walks or jumps at the world, and skips keys the target owns.
  if (edges !== undefined) return; // already routed at the menu intercept
  let consumed = false;
  for (const edge of keyEdges()) consumed = routeEdge(edge) || consumed;
  if (consumed) {
    // A press the world consumed (A opening the heal frame) cancels its OS repeats too.
    navHeldCodes.add(e.code);
    e.preventDefault();
  }
};
// Sync the context stack on both sides of every keydown: before, so a server overlay shown since
// the last frame (a battle, a dialogue) is pushed (clearing held) and a player view that closed
// itself is popped before this key routes; after, so whatever this key closed is off it at once.
const handleKeyDown = (e: KeyboardEvent): void => {
  pointerSource?.keyPressed(); // the keyboard drives now: the mouse's hover mark goes (CTL15.4)
  try {
    syncStack();
    onKeyDown(e);
  } finally {
    syncStack();
  }
};
// Escape is routed in the CAPTURE phase, so a view's own stopPropagation can no longer trap it
// (B5: Escape was dead inside rename and trade-propose). Every other key keeps the bubble phase,
// where those views' stopPropagation still shields their fields from the accelerator keys.
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

// A release ends a hold only when the last key or source holding that direction lets go. Synced
// first, as a keydown is: a gate read does not sync (so-2).
window.addEventListener('keyup', (e) => {
  navHeldCodes.delete(e.code);
  syncStack();
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
    buildMonsterStats(monsters),
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

// --- battle view: refresh on batch, auto-show/hide --------
function refreshBattle(): void {
  if (battleMount === undefined || identity === '') return;
  // The ONE view-perspective projection in the client — it re-seats
  // the local player as sideA so a PvP accepter (stored in opponentIdentity) gets their
  // OWN side from a layer that hardcodes sideA = the local player (the deploy panel reads the
  // projected `partyMonsterIds`). Every OTHER read of these accessors (diagnostics, observability)
  // stays RAW by design.
  const latest = ownPerspective(store.latestPlayerBattle(identity), identity);
  const r = decideBattleOverlay(latest, { dismissedBattleId, synced: battleSynced });
  dismissedBattleId = r.dismissedBattleId;
  battleSynced = r.synced;
  if (r.action.kind === 'show') {
    // bt-12 (BT12.1): which view owns the frame follows the tactical row's phase. A Deploying battle
    // shows the deploy panel, an Active one the tactical shell (bt-12 B), a Finished one the results
    // panel. bt-17 (BT17.1): no tactical row builds NOTHING — the 1v1 view is deleted. A switch under
    // a frame that sits over the battle base (Help, a conversation) first pops to the base: the three
    // roots share one overlay a11y record, and closing a covered record then opening a fresh one
    // would leave that frame inert (REV 2 A2). The open is the LAST statement of each arm.
    const battle = r.action.battle;
    const tacticalRow = store.tacticalBattle(battle.battleId);
    // bt-15 (BT15.3): the own rating BEFORE a Pvp battle settles is read here, at its first
    // non-Finished sighting — the settle batch carries the after.
    if (tacticalRow !== undefined) noteRatingBaseline(tacticalRow);
    const renderer = battleRenderer(tacticalRow?.phase);
    if (renderer === 'tactical' && tacticalRow !== undefined) {
      if (refreshTacticsShell(tacticalRow)) return;
      // The shell could not be built or rendered (reported once): a visible shell keeps the frame
      // (B17); otherwise nothing below shows it either.
      if (tacticsBattle?.visible === true) return;
    }
    const panel =
      renderer === 'deploy' && tacticalRow !== undefined
        ? buildDeployPanel(battle, tacticalRow) // sets `tacticsShown`
        : renderer === 'results'
          ? buildResultsPanel(battle.battleId)
          : null;
    if (panel !== null) {
      if (panel.kind === 'results') tacticsShown = null;
      // The HIDDEN target is rendered first (no a11y state moves), so a render throw leaves the
      // frame's current owner shown (B17); only then the switch: pop, hide the others, show.
      if (panel.kind === 'deploy') panel.view.render(panel.vm);
      else panel.view.render(panel.vm);
      popOverBattleBeforeSwitch(panel.view);
      hideOtherBattleViews(battleViews(), panel.view);
      if (!panel.view.visible) panel.view.show();
      return;
    }
    // Nothing was built. A RENDERABLE battle (its tactical row is present — the predicate
    // `reconcileStack` shares) whose shell or panel failed keeps the frame's current owner, shown
    // state and all (B17); its builder reported the failure. An anchor WITHOUT its tactical row is
    // not a battle this client can show (bt-17: the 1v1 view is deleted): a TERMINAL one is dismissed
    // here — in the same batch `reconcileStack` counted no outcome for it — and every battle view
    // hides, so no stale owner (a shell whose row the deletion cascade erased) lingers over the
    // world; an ONGOING one keeps whatever owner is shown and otherwise shows nothing (the stack
    // still holds the battle base and Start opens the menu there), reported once per battle id.
    if (renderableBattle(battle, tacticalRow)) return;
    if (battle.outcome !== 'Ongoing') {
      dismissedBattleId = battle.battleId;
      if (battleFrameShown()) hideAllBattleViews();
      return;
    }
    if (unrenderableReported !== battle.battleId) {
      unrenderableReported = battle.battleId;
      console.warn(
        `[battle] anchor ${battle.battleId} has no tactical row; nothing to show (bt-17)`,
      );
    }
  } else if (battleFrameShown()) {
    hideAllBattleViews();
  }
}

/** A renderer SWITCH (another battle view is visible and `target` is not) under frames that sit over
 *  a battle base first pops every PLAYER frame through its own close path (REV 2 A2): the roots share
 *  one overlay record. A suspended server conversation stays (the client never ends a dialogue), and
 *  a battle's first show, with nothing visible yet, pops nothing. */
function popOverBattleBeforeSwitch(target: { readonly visible: boolean }): void {
  if (target.visible) return;
  const switching = battleViews().some((v) => v !== undefined && v !== target && v.visible);
  if (switching) applyStack(contextStack, popPlayerFramesOverBattle(contextStack));
}

/** The one name rule for an own monster: the nickname, else the species name, else `#id`. */
function ownMonsterName(m: StoreMonsterPub): string {
  // `||`, not `??`: an EMPTY species name (a content row with no name) falls through to the id too
  // (bt-17 T7 — the qf-17 payout line's rule, carried to the deploy and results panels).
  return m.nickname || store.species(m.speciesId)?.name || `#${m.monsterId}`;
}

/** What the client keeps of a battle map — its size and its side-A spawn count — read once per
 *  mapId through the rules port (a whole map definition crosses the wasm boundary for three numbers). */
const tacticsMapFacts = new Map<
  number,
  { readonly width: number; readonly height: number; readonly spawns: number }
>();
function mapFactsOf(mapId: number): { width: number; height: number; spawns: number } {
  let facts = tacticsMapFacts.get(mapId);
  if (facts === undefined) {
    const map = tacticsRules().map(mapId);
    facts = { width: map.width, height: map.height, spawns: map.spawn_a.length };
    tacticsMapFacts.set(mapId, facts);
  }
  return facts;
}

/** The local player's side of `battleId` from the RAW anchor (a PvP accepter is side B). */
function mySideOf(battleId: bigint): RuleSide {
  const raw = store.latestPlayerBattle(identity);
  return raw !== undefined && raw.battleId === battleId && raw.playerIdentity !== identity
    ? 'B'
    : 'A';
}

/** The deploy panel and its view model for the own-perspective anchor `battle` (bt-12, BT12.2 /
 *  BT12.3): the anchor's party order joined with the own monster rows (a member with no own row is
 *  dropped; one in the player's open trade is neither offered nor defaulted — `deploy_units` refuses
 *  it), the remembered formation, the pack from the anchor's side B and the slot count
 *  `min(max_pack, spawn_a.length)` (the server's own cap). Builds the panel on first use. null
 *  (reported once) when the rules port or the map cannot be read — the frame keeps its current owner (B17). */
function buildDeployPanel(
  battle: {
    readonly battleId: bigint;
    readonly playerIdentity: string;
    readonly opponentIdentity: string;
    readonly partyMonsterIds: readonly bigint[];
    readonly opponentMonsterIds: readonly bigint[];
    readonly sideB: {
      readonly team: readonly { readonly speciesId: number; readonly level: number }[];
    };
  },
  row: StoreTacticalBattle,
): { readonly kind: 'deploy'; readonly view: DeployPanel; readonly vm: DeployVM } | null {
  if (battleMount === undefined) return null;
  try {
    const traded = tradedIds();
    const own = new Map(store.ownMonsters(identity).map((m) => [m.monsterId, m] as const));
    // bt-15 (BT15.1): the list this panel stages. The own-perspective anchor's `partyMonsterIds` is
    // the player's side — except in PRACTICE (one owner, both sides, the raw row), where the server
    // stages the first UNLOCKED own `battle_deploy` row (tactics.rs `stage_pvp`): side B's list is
    // the raw row's `opponentMonsterIds` once side A has locked.
    const practice = battle.playerIdentity === battle.opponentIdentity;
    const staging = practice
      ? (store.battleDeploys(row.battleId).find((d) => d.owner === identity && !d.locked)?.side ??
        'A')
      : 'A';
    const list = staging === 'B' ? battle.opponentMonsterIds : battle.partyMonsterIds;
    const party = list.flatMap((id) => {
      const m = own.get(id);
      if (m === undefined || traded.has(id)) return [];
      const row = {
        monsterId: m.monsterId,
        name: ownMonsterName(m),
        level: m.level,
        hp: m.currentHp,
        maxHp: m.statHp,
      };
      return [row];
    });
    const base = {
      battleId: battle.battleId,
      party,
      remembered: store.ownFormation(identity)?.monsterIds ?? [],
    };
    // bt-15 (BT15.1): a PvP / Practice side deploys `pvpDeployCount(format, conscious)` of its OWN
    // list and follows its own `battle_deploy.locked`; the anchor's side B is the OPPONENT's roster
    // there (R-bt-14-ROSTERREVEAL) and is read only as a wild pack.
    const vm = deployVM(
      shellKind(row.kind) === 'pvp'
        ? { mode: 'pvp', ...base, format: row.format, locked: ownDeployLocked(row.battleId) }
        : {
            mode: 'wild',
            ...base,
            slotCount: Math.min(tuningOf().max_pack, mapFactsOf(row.mapId).spawns),
            // The pack (bt-12 B): the server seats every wild in the anchor's side B at the start.
            wilds: battle.sideB.team.map((w) => ({
              speciesId: w.speciesId,
              name: store.species(w.speciesId)?.name ?? `#${w.speciesId}`,
              level: w.level,
            })),
          },
    );
    deployPanel ??= new DeployPanel(battleMount, {
      onDeploy: (battleId, picks) => dispatch({ kind: 'deployUnits', battleId, picks }),
    });
    tacticsShown = { battleId: row.battleId, mySide: mySideOf(row.battleId), kind: row.kind };
    return { kind: 'deploy', view: deployPanel, vm };
  } catch (err) {
    reportPaintError(err);
    return null;
  }
}

function noteRatingBaseline(row: StoreTacticalBattle): void {
  if (row.kind !== 'Pvp' || row.phase === 'Finished') return;
  if (tacticsRating !== null && tacticsRating.battleId === row.battleId) return;
  tacticsRating = {
    battleId: row.battleId,
    before: store.profile(identity)?.rating ?? null,
    result: null,
  };
}

function ratingLineFor(battleId: bigint, outcome: string): ResultsInput['rating'] {
  const held = tacticsRating;
  if (held === null || held.battleId !== battleId) return null;
  if (held.result !== null) return held.result;
  const change = ratingChange({
    kind: store.tacticalBattle(battleId)?.kind,
    outcome,
    battleId,
    baseline: { battleId: held.battleId, rating: held.before },
    after: store.profile(identity)?.rating,
  });
  held.result = change;
  return change;
}

/** The results panel and its view model from the RAW anchor (bt-12, BT12.4): the raw side decides
 *  won / lost, the transcript's Awards and RecruitResult lines are folded per unit. Builds the panel on
 *  first use. null when the anchor is not terminal — the frame then keeps its current owner. */
function buildResultsPanel(
  battleId: bigint,
): { readonly kind: 'results'; readonly view: ResultsPanel; readonly vm: ResultsVM } | null {
  if (battleMount === undefined) return null;
  const raw = store.latestPlayerBattle(identity);
  if (raw === undefined || raw.battleId !== battleId) return null;
  const vm = resultsVM({
    battleId,
    outcome: raw.outcome,
    mySide: raw.playerIdentity === identity ? 'A' : 'B',
    units: store.battleUnits(battleId),
    events: store.battleEvents(battleId),
    monsterName: (monsterId) => {
      const m = store.ownMonsters(identity).find((row) => row.monsterId === monsterId);
      return m === undefined ? `#${monsterId}` : ownMonsterName(m);
    },
    speciesName: (speciesId) => store.species(speciesId)?.name ?? `#${speciesId}`,
    rating: ratingLineFor(battleId, raw.outcome),
  });
  if (vm === null) return null;
  resultsPanel ??= new ResultsPanel(battleMount, {
    // Continue: pop the outcome frame, only while it is the top frame over the world (the same
    // predicate as A's continue); the pop latches the dismissed battle.
    onContinue: () => {
      if (outcomeOnTop(contextStack)) void dispatch({ kind: 'pop' });
    },
  });
  return { kind: 'results', view: resultsPanel, vm };
}
// --- bt-12 B (BT12.1 / BT12.2): the tactical shell owns the Active phase --------------------------

/** The tactical shell for the Active battle `row`: the VM from the store rows, the render skipped
 *  on an identical batch (REV B2.2), the transcript fed past the per-battle watermark (REV B2.4),
 *  then the switch. False when the VM or the render fails (reported once): the caller keeps the
 *  frame's current owner, and the watermark never moves on a render failure, so the next good batch
 *  feeds the whole log. */
function refreshTacticsShell(row: StoreTacticalBattle): boolean {
  if (battleMount === undefined) return false;
  tacticsShown = { battleId: row.battleId, mySide: mySideOf(row.battleId), kind: row.kind };
  let vm: TacticsBattleVM;
  try {
    vm = buildTacticsVM(row);
  } catch (err) {
    reportPaintError(err);
    return false;
  }
  if (tacticsBattle === undefined) {
    tacticsBattle = new TacticsBattle(battleMount, tacticsShellDeps());
  }
  const view = tacticsBattle;
  const mark = tacticsIngested;
  const first = mark === null || mark.battleId !== row.battleId;
  const since = first ? -1 : mark.seq;
  const fresh = store.battleEvents(row.battleId).filter((e) => e.seq > since);
  const last = fresh.at(-1)?.seq ?? since;
  if (!(view.visible && lastTacticsVM !== null && tacticsVMEqual(lastTacticsVM, vm))) {
    try {
      view.render(vm);
    } catch (err) {
      reportPaintError(err);
      return false;
    }
    lastTacticsVM = vm;
  }
  const feed = (): void => {
    if (fresh.length > 0) {
      try {
        view.ingest(fresh.map((e) => e.payload));
      } catch (err) {
        // `ingest` is atomic, so the batch left no line: feed the events one by one, and only the
        // unrenderable one drops (reported once); the mark still moves past the whole batch.
        reportPaintError(err);
        for (const e of fresh) {
          try {
            view.ingest([e.payload]);
          } catch (bad) {
            console.warn('[tactics] event dropped from the log', e.seq, bad);
          }
        }
      }
    }
    tacticsIngested = { battleId: row.battleId, seq: last };
  };
  // A first sighting feeds the history while HIDDEN (the render of a new battle cleared the ticker;
  // a hidden view plays no beats) and then shows; a later batch shows first, so only live events play.
  if (first) feed();
  popOverBattleBeforeSwitch(view);
  hideOtherBattleViews(battleViews(), view);
  if (!view.visible) view.show();
  if (!first) feed();
  return true;
}

/** Structural equality of two shell VMs (`readyPlans` as entries: a Map compares as `{}`). */
const tacticsVMEqual = (a: TacticsBattleVM, b: TacticsBattleVM): boolean =>
  structurallyEqual(
    { ...a, readyPlans: [...a.readyPlans] },
    { ...b, readyPlans: [...b.readyPlans] },
  );

/** The shell's VM from the store rows of `row`'s battle: the units (`mine` by owner, `ai` when
 *  ownerless), the map's size, the active unit (`Waiting(U)` whatever `turnIdx` says), the tuning's
 *  Surge start and round cap, the NEXT round's initiative from the rules under this round's tie side
 *  (never a flip restated here), the own READY plans and the baits held. Throws on a malformed board
 *  (the rules refuse it) — the caller reports and keeps the frame's owner. */
function buildTacticsVM(row: StoreTacticalBattle): TacticsBattleVM {
  const rules = tacticsRules();
  const tuning = tuningOf();
  const map = mapFactsOf(row.mapId);
  const rows = store.battleUnits(row.battleId);
  const board: RulesBoard = { kind: row.kind, map_id: row.mapId, units: rows.map((u) => u.row) };
  return {
    battleId: row.battleId,
    kind: shellKind(row.kind),
    width: map.width,
    height: map.height,
    units: rows.map((u) => ({
      unitId: u.unitId,
      side: u.row.side,
      mine: u.owner === identity,
      ai: u.owner === null,
      speciesId: u.row.species_id,
      speciesName: store.species(u.row.species_id)?.name ?? `#${u.row.species_id}`,
      level: u.row.level,
      affinity: u.affinity,
      x: u.row.pos.x,
      y: u.row.pos.y,
      curHp: u.row.cur_hp,
      maxHp: u.row.stats.hp,
      status: statusTagOf(u.row.status),
      ap: u.row.budget.ap,
      guard: u.row.guard,
      firstStand: u.row.first_stand,
      role: null, // no role reaches the client; the HUD's role chip stays off
      stance: u.row.stance,
      state: u.row.state,
    })),
    activeUnitId: activeUnitOf(row.turnState, row.initiative, row.turnIdx),
    round: row.round,
    initiative: row.initiative,
    turnIdx: row.turnIdx,
    nextInitiative: rules.nextInitiative(board, row.tiePrioritySide),
    surgeStartRound: tuning.surge_start_round,
    wildRoundCap: tuning.wild_round_cap,
    targetUnitId: null,
    board,
    readyPlans: new Map(
      store.ownQueue(row.battleId, identity).map((q) => [q.unitId, q.entries] as const),
    ),
    baits: buildBaitItems(store.ownInventory(identity), store.itemDefs())
      .filter((b) => b.recruitBonus > 0)
      .map((b) => ({ itemId: b.itemId, name: b.name, count: b.count, bonus: b.recruitBonus })),
    // A tactical recruit lands in the box (taming::insert_recruited): the server never refuses one
    // for a full party, so there is no headroom predicate to mirror (R-bt-11-PARTYFULL).
    partyFull: false,
  };
}

/** The shell's deps: the clocks, live name closures over the store (the shown battle's units; an
 *  own unit by its monster's name, else its species, else `#id`; `mySide` from the shown anchor),
 *  the rules port and the two queue reducers through `dispatch`. */
function tacticsShellDeps(): TacticsBattleDeps {
  return {
    now: () => performance.now(),
    reduceMotion: () => motionPreference.reduceMotion,
    names: {
      unit: (unitId) => {
        const shown = tacticsShown;
        const u =
          shown === null
            ? undefined
            : store.battleUnits(shown.battleId).find((x) => x.unitId === unitId);
        if (u === undefined) return `#${unitId}`;
        const own =
          u.owner === identity && u.monsterId !== null
            ? store.ownMonsters(identity).find((m) => m.monsterId === u.monsterId)
            : undefined;
        return own !== undefined
          ? ownMonsterName(own)
          : (store.species(u.row.species_id)?.name ?? `#${unitId}`);
      },
      skill: (skillId) => store.skill(skillId)?.name ?? `#${skillId}`,
      item: (itemId) => store.itemDef(itemId)?.name ?? `#${itemId}`,
      get mySide() {
        return tacticsShown?.mySide ?? 'A';
      },
    },
    rules: tacticsRules,
    onSubmitQueue: (battleId, unitId, entries) =>
      void dispatch({ kind: 'submitQueue', battleId, unitId, entries }),
    onCancelQueue: (battleId, unitId) => void dispatch({ kind: 'cancelQueue', battleId, unitId }),
    onForfeit: (battleId) => void dispatch({ kind: 'forfeit', battleId }),
  };
}

/** The "Still there?" countdown (BT12.2), pumped on the WALL clock: the shown tactical view's own
 *  clock deadline — a WILD battle's only — through `stillThereSeconds`; the view memoises the second,
 *  so an unchanged value writes nothing. Returns the line to announce the first time a window's
 *  countdown shows, else null. */
function pumpStillThere(wallNowMs: number): string | null {
  const shown = tacticsShown;
  const view =
    tacticsBattle?.visible === true
      ? tacticsBattle
      : deployPanel?.visible === true
        ? deployPanel
        : undefined;
  if (shown === null || view === undefined) return null;
  const own =
    store.battleClocks(shown.battleId).find((c) => c.player === identity)?.deadlineMs ?? null;
  // bt-15 (BT15.1): a wild battle's own deadline always; a PvP / Practice battle's only while the
  // deploy panel shows (the 45 s deploy window), never an Active turn's.
  const deadline = countdownDeadline(shown.kind, view === deployPanel, own);
  const seconds = stillThereSeconds(deadline, wallNowMs);
  view.setCountdown(seconds);
  // The live-region announcement stays the WILD "Still there?" nudge: a PvP deploy window paints
  // its countdown and announces nothing (bt-15 interim; the continuation words it as a deploy one).
  if (shown.kind !== 'Wild' || seconds === null || deadline === null) return null;
  if (stillThereAnnouncedFor === deadline) return null;
  stillThereAnnouncedFor = deadline;
  return stillThere(seconds);
}

/** The PvP clock ring and strike pips (bt-15 increment B, BT15.2), pumped on the WALL clock like the
 *  countdown: the shown tactical shell's battle rows → `clockVM` → `setClock` (the shell memoises an
 *  equal VM). A frame the VM cannot be built on (no shown battle, no tactical row) clears it, so a
 *  stale ring never outlives its window. Both players see both rings and strike counts: the clock rows
 *  are public match state (design §6.2). */
function pumpClock(wallNowMs: number): void {
  const view = tacticsBattle;
  if (view === undefined || !view.visible) return;
  const shown = tacticsShown;
  const row = shown === null ? undefined : store.tacticalBattle(shown.battleId);
  if (shown === null || row === undefined) {
    view.setClock(null);
    return;
  }
  view.setClock(
    clockVM({
      kind: shellKind(row.kind),
      clocks: store.battleClocks(row.battleId),
      // WHILE the battle waits on a unit (BT15.2): `Waiting(U)` only — never the `Advancing` gap
      // between chained transactions (its window is closed; `activeUnitOf` maps it to initiative[turnIdx]).
      activeUnitId: row.turnState.kind === 'Waiting' ? row.turnState.unitId : null,
      units: store.battleUnits(row.battleId).map((u) => ({ unitId: u.unitId, side: u.row.side })),
      mySide: shown.mySide,
      playerName: (id) => store.player(id)?.name ?? store.profile(id)?.name ?? '',
      nowMs: wallNowMs,
    }),
  );
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
  openFrame(
    'shopView',
    frameOpenOf(() => shopView),
    () => {
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
    },
  );
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
  // The quest log opens only when the player opens it; only refresh when already open.
  if (!questLogView?.visible) return;
  try {
    const quests = store.ownQuests(identity);
    questLogView.render(buildQuestLogViewModel(quests));
  } catch (err) {
    console.error('[M12d] questLog batch listener error', err);
  }
});

// qf-6 (QF6.4): the quest-completion acknowledgement — two consecutive batch snapshots compared
// by statusModel questCompletionAck (what counts as a completion, and why, is documented there).
// The baseline is taken only once hydrated and is dropped on reconnect.
let questAckBaseline: QuestAckSnapshot | undefined;
store.onBatchApplied(() => {
  try {
    const now = questAckSnapshot({
      ready: hydratedSinceReconnect && identity !== '',
      identity,
      quests: store.ownQuests(identity),
      wallet: store.ownWallet(identity),
      conversationOpen: store.ownConversation(identity) !== undefined,
    });
    const ack = questCompletionAck(questAckBaseline, now);
    questAckBaseline = now;
    if (ack === undefined) return;
    route(
      'quest-complete',
      ack.reward === null
        ? tf('quest.complete.done', { name: ack.name })
        : tf('quest.complete.reward', { name: ack.name, amount: ack.reward }),
    );
  } catch (err) {
    console.error('[qf-6] quest acknowledgement listener error', err);
  }
});

store.onBatchApplied(() => {
  // Heal overlay is user-opened (A at a healer); only refresh when
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

// --- PvP challenge panel batch listener -----------------------
// Refreshes the Challenges panel while it shows (status/list changes). An incoming challenge opens
// nothing (ctl-13): it is a notice — the banner, the badges and Y. MUST be total (never throw).
store.onBatchApplied(() => {
  if (identity === '') return;
  try {
    const vm = buildPvpChallengeViewModel(store.allChallenges(), identity, store.allPlayers());
    if (pvpView?.visible) {
      // A shown panel only re-renders. What closes it is the stack's (a battle, a conversation),
      // never "another overlay is showing": the menu it was opened from is one.
      pvpView.refresh(vm, true);
    }
  } catch (err) {
    console.error('[pvpView] batch listener error', err);
  }
});

// --- incoming requests (ctl-13) --------------------------------------
// A request that newly waits is announced once, with its banner line, and the open menu's Social
// badge follows the requests on the batch. Nothing opens and no focus moves. MUST be total.
store.onBatchApplied(() => {
  if (identity === '') return;
  try {
    const pending = pendingRequests(noticeInput());
    for (const n of pending) {
      if (announcedRequests.has(n.key)) continue;
      announcedRequests.add(n.key);
      announceNow(requestLine(n));
    }
    const badged = pending.some((n) => !answeredRequests.has(n.key));
    if (badged !== menuBadged) {
      menuBadged = badged;
      if (menuView?.visible) renderMenu();
    }
  } catch (err) {
    console.error('[notices] batch listener error', err);
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

// --- battleStart / battleEnd emit listener (ui/battleEmitModel.ts) -----------------------
// Dedicated batch listener (UNCONDITIONAL — not visibility-gated).
store.onBatchApplied(() => {
  if (identity === '') return;
  try {
    const next = battleEmitStep(battleEmit, {
      hydrated: hydratedSinceReconnect,
      latest: store.latestPlayerBattle(identity),
    });
    battleEmit = next.state;
    if (next.emit) eventRing.push(next.emit);
  } catch (err) {
    console.error('[obs] battle', err);
  }
});

// --- rankedMatch emit listener (ui/battleEmitModel.ts) -----------------------------------
// Dedicated batch listener (its OWN, not folded into the visibility-gated leaderboard
// listener above).
store.onBatchApplied(() => {
  if (identity === '') return;
  try {
    const prof = store.profile(identity);
    if (!prof) return;
    const next = rankedStep({
      lastRating: lastOwnRating,
      rating: prof.rating,
      latest: store.latestPlayerBattle(identity),
    });
    lastOwnRating = next.lastRating;
    if (next.emit) eventRing.push(next.emit);
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

// The LAST batch listener: mirror every server overlay this batch's listeners showed or hid (a
// server-opened dialogue, a battle auto-show) so its push clears held before the next frame.
// Then every open frame's adapter observes the batch. It must stay last: a frame this batch
// pushed starts from its `init` (the Social frame's ran at its open), and every view render of
// the batch has already run.
store.onBatchApplied(() => {
  syncStack();
  screenHost.observe(contextStack, screenCtx);
});

// qf-3: the Monsters sheet's Care readiness follows the WALL clock, which no batch or button moves,
// so while the box frame is open the frame loop re-observes the stack about once a second (the
// host's same-object contract keeps a still readiness paint-free; a cooldown that just elapsed
// repaints the row enabled with nobody pressing anything). The per-batch observe above stays the
// main path; this tick only closes the idle gap.
const CARE_READINESS_TICK_MS = 1000;
let lastCareTickAtMs = 0;

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
    // The source-to-CSS scale the renderer holds, measured through its own transform (uif-2).
    stageScale:
      renderer === undefined
        ? null
        : renderer.screenFor({ x: 1, y: 0 }).x - renderer.screenFor({ x: 0, y: 0 }).x,
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
  // bt-16: `submitPvpAction` left the hook with the cutover — every live battle is tactical and
  // `submit_pvp_action` is no longer a reducer (bt-17); the e2e drives turns by virtual buttons.
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
  // bt-15 (BT15.4): every `battle_challenge` row as the SDK cache holds it, with the format the
  // server derived from the committed party's length — the e2e's oracle for the party-size pick.
  challengeFormats(): Array<{
    challengeId: string;
    challenger: string;
    target: string;
    format: number;
  }> {
    const live = conn?.live();
    if (live === undefined) return [];
    return [...live.db.battleChallenge.iter()].map((c) => ({
      challengeId: c.challengeId.toString(),
      challenger: c.challenger.toHexString(),
      target: c.target.toHexString(),
      format: c.format,
    }));
  },
  // BOTH-SIDES battle read: store.battle(id) hits the by-id map directly and exposes BOTH
  // sides' internals to a test driver — which the production path deliberately never does
  // (it reads only the local player's own row, via the either-role accessors, and sees the
  // opponent only through the view model). Returns null when the battle is absent (not yet
  // arrived or GC'd). activeSkillIds are the ACTIVE monster's known skill ids for each
  // side, so either page can pick a legal skill for its role.
  // An EMPTY activeSkillIds array means the side's active index was out of bounds —
  // an abnormal server state; callers must not submit an action built from it.
  // bt-16: `hp` is the active monster's HP as the ANCHOR mirrors it (tactics.rs `mirror_hp`),
  // -1 without an active monster — the e2e's oracle that a mid-battle anchor update (a
  // delete + insert pair on the view) reached this client and kept the row.
  battleById(battleId: string): {
    battleId: string;
    outcome: string;
    turnNumber: number;
    sideA: { active: number; activeSkillIds: number[]; hp: number };
    sideB: { active: number; activeSkillIds: number[]; hp: number };
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
        hp: b.sideA.team[b.sideA.active]?.currentHp ?? -1,
      },
      sideB: {
        active: b.sideB.active,
        activeSkillIds: [...(b.sideB.team[b.sideB.active]?.knownSkillIds ?? [])],
        hp: b.sideB.team[b.sideB.active]?.currentHp ?? -1,
      },
    };
  },
};

// bt-12 (BT12.5): the tactical e2e's READ-ONLY hook — the local player's tactical battle as the store
// holds it (the rows the player's own views carry: never a seed, never the opponent's plan) and the
// own monsters' HP. No reducer reaches through it; every battle action in the e2e is a virtual
// button. bt-15 (BT15.4) adds the secrecy oracles: the raw SDK-cache rows of the two owner-only
// views, a row-callback probe over them, the transcript's tags and an ad-hoc subscription probe
// (the server's refusal of a private table) — reads and observers only. Fingerprinted by
// scripts/verify-build-hooks.mjs beside the other three.
/** bt-15 (BT15.4): the e2e's row probe — every myBattleDeploy / myBattleQueue callback since arming. */
let rowProbeState: {
  readonly counts: { deploy: number; queue: number };
  readonly off: () => void;
} | null = null;
const mrTacticsHook = {
  battle(): null | {
    battleId: string;
    phase: string;
    kind: string;
    format: number;
    strikes: { A: number; B: number };
    round: number;
    turnIdx: number;
    initiative: number[];
    activeUnitId: number | null;
    turnState: 'NotActive' | 'Waiting' | 'Advancing';
    owner: 'deploy' | 'tactical' | 'results' | null;
    events: number;
    deadlineMs: string | null;
    units: {
      unitId: number;
      side: 'A' | 'B';
      mine: boolean;
      x: number;
      y: number;
      curHp: number;
      maxHp: number;
      state: string;
    }[];
  } {
    const raw = store.latestPlayerBattle(identity);
    const row = raw === undefined ? undefined : store.tacticalBattle(raw.battleId);
    if (row === undefined) return null;
    const clocks = store.battleClocks(row.battleId);
    const clock = clocks.find((c) => c.player === identity);
    const strikesOf = (side: 'A' | 'B'): number =>
      clocks.find((c) => c.side === side)?.autopassCount ?? 0;
    return {
      battleId: String(row.battleId),
      phase: row.phase,
      kind: row.kind,
      format: row.format,
      strikes: { A: strikesOf('A'), B: strikesOf('B') },
      round: row.round,
      turnIdx: row.turnIdx,
      initiative: [...row.initiative],
      activeUnitId: activeUnitOf(row.turnState, row.initiative, row.turnIdx),
      turnState: row.turnState.kind,
      owner:
        tacticsBattle?.visible === true
          ? 'tactical'
          : deployPanel?.visible === true
            ? 'deploy'
            : resultsPanel?.visible === true
              ? 'results'
              : null,
      events: store.battleEvents(row.battleId).length,
      deadlineMs: clock?.deadlineMs == null ? null : String(clock.deadlineMs),
      units: store.battleUnits(row.battleId).map((u) => ({
        unitId: u.unitId,
        side: u.row.side,
        mine: u.owner === identity,
        x: u.row.pos.x,
        y: u.row.pos.y,
        curHp: u.row.cur_hp,
        maxHp: u.row.stats.hp,
        state: u.row.state,
      })),
    };
  },
  /** The raw SDK-cache rows of the two owner-only views (what the subscription delivered). */
  secrecy(): {
    me: string;
    deploys: { owner: string; locked: boolean; picks: number }[];
    queues: { owner: string; unitId: number }[];
  } {
    const live = conn?.live();
    if (live === undefined) throw new Error('secrecy: no live connection');
    return {
      me: identity,
      deploys: [...live.db.myBattleDeploy.iter()].map((d) => ({
        owner: d.owner.toHexString(),
        locked: d.locked,
        picks: d.picks.length,
      })),
      queues: [...live.db.myBattleQueue.iter()].map((q) => ({
        owner: q.owner.toHexString(),
        unitId: q.unitId,
      })),
    };
  },
  /** Starts (or restarts) counting every insert / delete callback on the two owner-only views. */
  armRowProbe(): void {
    const live = conn?.live();
    if (live === undefined) throw new Error('armRowProbe: no live connection');
    rowProbeState?.off();
    const counts = { deploy: 0, queue: 0 };
    const deploy = (): void => {
      counts.deploy += 1;
    };
    const queue = (): void => {
      counts.queue += 1;
    };
    live.db.myBattleDeploy.onInsert(deploy);
    live.db.myBattleDeploy.onDelete(deploy);
    live.db.myBattleQueue.onInsert(queue);
    live.db.myBattleQueue.onDelete(queue);
    rowProbeState = {
      counts,
      off: () => {
        live.db.myBattleDeploy.removeOnInsert(deploy);
        live.db.myBattleDeploy.removeOnDelete(deploy);
        live.db.myBattleQueue.removeOnInsert(queue);
        live.db.myBattleQueue.removeOnDelete(queue);
      },
    };
  },
  rowProbe(): { deploy: number; queue: number } {
    if (rowProbeState === null) throw new Error('rowProbe: not armed');
    return { ...rowProbeState.counts };
  },
  /** The transcript's tags in order: each event's unit (when it names one) and, for BattleEnd, how. */
  eventTags(): { tag: string; unit: number | null; how: string | null }[] {
    const raw = store.latestPlayerBattle(identity);
    if (raw === undefined) return [];
    return store.battleEvents(raw.battleId).map((e) => {
      const p = e.payload as { tag: string; value?: unknown };
      const v = (typeof p.value === 'object' && p.value !== null ? p.value : {}) as {
        unit?: unknown;
        how?: { tag?: unknown };
      };
      return {
        tag: p.tag,
        unit: typeof v.unit === 'number' ? v.unit : null,
        how: p.tag === 'BattleEnd' && typeof v.how?.tag === 'string' ? v.how.tag : null,
      };
    });
  },
  /** An ad-hoc subscription: 'applied' when the server accepts `sql`, 'error' when it refuses it
   *  (a private table). Settles on whichever fires first; nothing answers in 10 s → rejects. */
  probeSubscribe(sql: string): Promise<'applied' | 'error'> {
    const live = conn?.live();
    if (live === undefined) return Promise.reject(new Error('probeSubscribe: no live connection'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('probeSubscribe: no answer in 10 s')),
        10_000,
      );
      try {
        const handle = live
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            // An applied probe (the positive control) is dropped again: the probe page keeps no
            // standing subscription of its own.
            handle.unsubscribe();
            resolve('applied');
          })
          .onError(() => {
            clearTimeout(timer);
            resolve('error');
          })
          .subscribe([sql]);
      } catch {
        clearTimeout(timer);
        resolve('error');
      }
    });
  },
  ownMonsters(): { monsterId: string; currentHp: number; maxHp: number; partySlot: number }[] {
    return store.ownMonsters(identity).map((m) => ({
      monsterId: String(m.monsterId),
      currentHp: m.currentHp,
      maxHp: m.statHp,
      partySlot: m.partySlot,
    }));
  },
};

// D-17.5-E: DEV-only test hooks. Only the window ASSIGNMENTS are gated —
// the hook consts above stay top-level (still referenced here, so no unused-var lint).
if (import.meta.env.DEV) {
  (window as unknown as { __game: typeof snapshot }).__game = snapshot;
  (window as unknown as { __mrTrade: typeof mrTradeHook }).__mrTrade = mrTradeHook;
  (window as unknown as { __mrPvp: typeof mrPvpHook }).__mrPvp = mrPvpHook;
  (window as unknown as { __mrTactics: typeof mrTacticsHook }).__mrTactics = mrTacticsHook;
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
    reportError('download-blocked', i18nT('chrome.status.bugBundleBlocked'));
  }
}

async function main(): Promise<void> {
  // surface the build stamp in the non-intrusive corner element (#build-stamp
  // in index.html). BUILD_INFO is ungated, so this shows in the production playtest build too.
  const buildStampEl = document.getElementById('build-stamp');
  if (buildStampEl !== null) buildStampEl.textContent = formatBuildStamp(BUILD_INFO);

  const [
    { BoxView: BoxViewClass },
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
    { ControlsView: ControlsViewClass, savedLine },
    { ProfileView: ProfileViewClass },
  ] = await Promise.all([
    import('./ui/boxView'),
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
    import('./ui/controlsView'),
    import('./ui/profileView'),
  ]);
  renderer = new WorldRenderer();
  const mount = document.getElementById('app');
  if (mount !== null) {
    battleMount = mount; // bt-12: the lazily built deploy / results panels mount here
    await renderer.init(mount, rawMap);
    // render/world.ts appends app.canvas to this same mount and puts
    // role="application"/tabindex="0" on it. It is out of this slice's touches:, so a
    // querySelector on the mount main.ts already holds is the only in-touches route.
    worldCanvasEl = mount.querySelector('canvas');
    // Touch on the canvas is the game's (styles.css: touch-action none), never a browser pan.
    worldCanvasEl?.classList.add('mr-world-canvas');
    installResizeHandler(renderer, window); // fit the stage to the window + on resize
    boxView = new BoxViewClass(mount, {
      onSetNickname: (monsterId, nickname) =>
        dispatch({ kind: 'setNickname', monsterId, nickname }),
      onSetPartySlot: (monsterId, slot) => dispatch({ kind: 'setPartySlot', monsterId, slot }),
      partySlotNone: PARTY_SLOT_NONE,
    });
    raisingView = new RaisingViewClass(mount);
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
      onBuy: (shopId, itemId) => dispatch({ kind: 'buy', shopId, itemId, qty: 1 }),
      onSell: (itemId) => dispatch({ kind: 'sell', itemId, qty: 1 }),
    });
    tradeView = new TradeViewClass({
      onAccept: (tradeId) => dispatch({ kind: 'respondTrade', tradeId, accepted: true }),
      onReject: (tradeId) => dispatch({ kind: 'respondTrade', tradeId, accepted: false }),
      onConfirm: (tradeId) => dispatch({ kind: 'confirmTrade', tradeId }),
      onCancel: (tradeId) => dispatch({ kind: 'cancelTrade', tradeId }),
    });
    // PvP challenge overlay: the lifecycle callbacks RETURN the promise.
    pvpView = new PvpViewClass({
      onAccept: (challengeId) => dispatch({ kind: 'acceptChallenge', challengeId }),
      onDecline: (challengeId) => dispatch({ kind: 'declineChallenge', challengeId }),
      onCancel: (challengeId) => dispatch({ kind: 'cancelChallenge', challengeId }),
    });
    // Leaderboard DOM shell. ZERO-arg construction — RL-15: the
    // leaderboard is a pure subscription view; there is no client write path to profile.
    leaderboardView = new LeaderboardViewClass();
    // How to Play — no reducer callback: its one handler speaks a tab change or an opened entry
    // through the live region (the Report a problem row is a screen command, uif-14b). Opened by Select (R or Slash); `openHelp` binds its content.
    helpView = new HelpViewClass({ announce: announceNow });
    // The menu view only paints and forwards clicks; keys reach the menu through the router.
    menuView = new MenuViewClass({ onInput: handleMenuPointer });
    // The guest-claim prompt (Profile's Account section). Its actions drive the pure claimModel;
    // the AUTHORITATIVE join veto lives in connection.ts's onApplied (G18), so these are UI-only.
    const claimHandlers: ClaimViewHandlers = {
      onSignIn: () => void dispatch({ kind: 'claimSignIn' }),
      onJoin: () => void dispatch({ kind: 'claimJoin' }),
      onDeclineRequested: () => applyClaim({ kind: 'decline-requested' }),
      onDeclineConfirmed: () => void dispatch({ kind: 'claimDecline' }),
      onDeclineCancelled: () => applyClaim({ kind: 'decline-cancelled' }),
      // The Privacy section is on the same screen: the door moves the cursor there.
      onPrivacy: () => profileView?.focusSection('privacy'),
      // Every close cancels an armed decline (the privacy rule). Stepped and painted directly:
      // `applyClaim`'s paint would re-open the screen that is closing.
      onDismissed: () => {
        if (!claimModelState.confirmPending) return;
        claimModelState = claimStep(claimModelState, { kind: 'decline-cancelled' }).next;
        claimView?.render(buildClaimViewModel(claimModelState));
      },
    };
    claimView = new ClaimViewClass(claimHandlers);
    const privacyHandlers: PrivacyViewHandlers = {
      onDeleteRequested: () => applyPrivacy({ kind: 'delete-requested' }),
      onDeleteConfirmed: () => void dispatch({ kind: 'deleteAccount' }),
      onConfirmCancelled: () => applyPrivacy({ kind: 'confirm-cancelled' }),
      onCancelDeletion: () => void dispatch({ kind: 'cancelAccountDeletion' }),
      onExportRequested: () => void dispatch({ kind: 'requestDataExport' }),
      onExportDownload: () => downloadExportBundle(),
      onDismissed: () => applyPrivacy({ kind: 'confirm-cancelled' }),
      // Where focus goes when a render refuses the focused control: the frame's Close.
      fallbackRow: () => profileView?.closeRow,
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
    // The rename form (Profile's Name section) and the trade-PROPOSE overlay: their own Enter
    // (and submit click) commits through `dispatch`; the view's #pending lock is reset by its own
    // .finally().
    renameView = new RenameViewClass({
      onSubmit: (name) => dispatch({ kind: 'setProfileName', name }),
      bindings: () => bindings,
    });
    // The Profile frame takes the three sections built above, in column order.
    profileView = new ProfileViewClass({
      name: renameView,
      account: claimView,
      privacy: privacyView,
    });
    // Controls: the view reads the live table, and its requests replace it at once.
    const controlsHandlers: ControlsViewHandlers = {
      bindings: () => bindings,
      onClear: (accel) => applyBindings(clearAccel(bindings, accel)),
      onReset: () => applyBindings(DEFAULT_BINDINGS),
      textStep: () => textStep,
      // Only `--mr-text-step` moves: the UI scale, the renderer and the world are untouched.
      onTextStep: (step) => {
        textStep = step;
        applyTextStep(document.documentElement, step);
        return saveTextStep(browserStorage(), step);
      },
      onCancelCapture: cancelControlsCapture,
      announce: (text) => announceNow(text),
      onOutcome: (text, saved) =>
        toastControls(saved ? 'controls-saved' : 'controls-save-failed', text, saved),
    };
    controlsSavedLine = savedLine;
    controlsView = new ControlsViewClass(controlsHandlers);
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
  // uif-4: the toast region, beside it and out of the flow (.mr-toast), above every frame.
  toastChrome = createToast(document, gameScreen);

  // ONE pointer dispatcher on the game screen (ctl-15): clicks, right-clicks, long-presses and
  // hover become button presses; the dialogue's choice and shop buttons keep their commands. Not
  // attached to the shell-less boot's body fallback, which would make it a page-wide listener.
  const pointerScreen = document.getElementById('game-screen');
  if (pointerScreen !== null) {
    pointerSource = new PointerSource(pointerScreen, () => worldCanvasEl, {
      top: pointerTop,
      press: pointerPress,
      capturing: () => controlsCapture() !== null,
      cancelCapture: cancelControlsCapture,
      // The greet-then-shop button dispatches `pickShop`, so a battle base refuses it like any
      // other command.
      choice: (choiceIdx) => void dispatch({ kind: 'advanceDialogue', choiceIdx }),
      shop: (shopId) => void dispatch({ kind: 'pickShop', shopId }),
    });
  }

  // The hint bar (ctl-13): painted every frame from `hintBar(...)`; a click on any chip is a press
  // of its button through the pointer source.
  const hintBarEl = document.getElementById('hint-bar');
  if (hintBarEl !== null) hintBarView = new HintBarView(hintBarEl);
  // Painted once now, so the bar is never blank before the first frame.
  hintBarView?.render(hintBar(contextStack, bindings, []), null);

  // The on-world interact prompt — a small frame in the frame layer (.mr-frame--prompt:
  // pointer-events:none so it can NEVER shadow a click meant for the canvas or a frame beneath;
  // z-index below the overlays; translate(-50%,-100%) hangs the label above the anchor, the
  // tile-top centre). The frame layer fills the viewport, so screenFor()'s viewport coordinates
  // are its coordinates. Positioned each frame via renderer.screenFor(...).
  const interactPromptEl = document.createElement('div');
  interactPromptEl.id = 'interact-prompt';
  interactPromptEl.className = 'mr-frame mr-frame--prompt';
  interactPromptEl.style.display = 'none';
  frameLayer.appendChild(interactPromptEl);
  // ctl-10a: it holds either the chip text or, while a world sheet is open, that sheet: the kit's
  // ContextSheet (uif-12, UIF12.1), hung where the prompt hangs and never placed by the kit. The
  // `[data-context-sheet]` root is what lets the pointer source click its rows and close it from a
  // click elsewhere. Memoized last-applied state: DOM writes happen ONLY when the (text or rows,
  // screen position) key changes — never unconditionally per frame.
  const interactChipTextEl = document.createElement('span');
  const interactSheet = createContextSheet(document, { frame: 'interact' });
  interactPromptEl.append(interactChipTextEl, interactSheet.root);
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
  // Its mount is made inside #game-screen first (the banner adopts it by id), so a focused OK button
  // is focus inside the game screen and keeps the keys (CTL11B.1).
  const noticeMount = document.createElement('div');
  noticeMount.id = 'evolution-notice';
  gameScreen.appendChild(noticeMount);
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
      announce: (m) => announceNow(m),
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
      // A screen opened before the join must not be remembered into this identity's session.
      screenHost.forget();
      dismissedRequests.clear();
      announcedRequests.clear();
      answeredRequests.clear();
      // record the connect edge (identity-hex is the allowed field, U-3).
      eventRing.push(makeConnect(identity));
      resolveReady();
      // A successful connection clears any session terminal overlay.
      applySession({ kind: 'connected' });
      // The claim prompt this connect raised, if any, is up and stays: nothing swept it.
      claimRaised = false;
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
      // Arm the battle reseed BEFORE resetPredictionState clears the active battle: a surviving
      // Ongoing battle is re-baselined on the first post-hydration batch instead of re-emitting
      // battleStart. A 2nd drop while a reseed is pending keeps the FIRST capture, and the
      // hydration flag is cleared UNCONDITIONALLY so the reseed waits for THIS connection's.
      battleEmit = armReseed(battleEmit);
      hydratedSinceReconnect = false;
      // qf-6: a notice queued for the old link and the quest-acknowledgement baseline are stale;
      // the next baseline is the first hydrated batch of this connection.
      statusNotice = STATUS_NOTICE_INITIAL;
      questAckBaseline = undefined;
      // Clean re-init: the store already dropped stale rows; rebuild prediction and
      // drop the own slide clock so the post-reconnect re-seed starts fresh.
      // Zone state is corrected by the reconcile listener's state-based check on
      // the first post-reconnect batch (12.5c-1 — no special zone logic needed here).
      resetPredictionState();
      // The stack closes what the reset drops (so-1): synced first, so an overlay shown since the
      // last sync is a frame too, then every frame `reconnectSweep` names is popped and closed
      // through its view's own hide path (`hideFrame`) — the menu and what it opened (a child may
      // read store state the reset invalidated), and a frame opened over a battle, which a
      // re-delivered row of that battle would find still stamped, keep, and show the battle above.
      // Never the dialogue: a conversation is the server's to end.
      syncStack();
      const swept = reconnectSweep(contextStack);
      // A drop here raises no mirror edge: a held key must not repeat into the frame it uncovers.
      if (swept.stack.length !== contextStack.length) inputRouter.resetRepeat();
      contextStack = swept.stack;
      runStackCommands(swept.commands);
      // ...and every view whose hide() also clears what a dropped link leaves behind is reset
      // UNCONDITIONALLY, shown or not, on the stack or not: the SDK never settles an in-flight
      // reducer promise after a link drop, so .finally() may never run and its lock (a dead submit
      // button forever) is released only here; the rest drop a stale draft, challenge or board.
      for (const reset of RECONNECT_RESETS) reset();
      // the same never-settling-promise class for the
      // dialogue dismiss lock. It used to self-heal through the server deleting the
      // player_conversation row on disconnect; that delete now runs only when the identity's
      // LAST live connection ends, so an overlapping reconnect re-delivers the row and the
      // lock would stay held forever (dead Escape-dismiss + dead greet-then-shop button).
      // The reset also drops a pending shop open, whose id the store reset invalidated.
      stepShopOpen({ kind: 'reconnect' });
      // The same never-settling-promise class as the view resets above, for the privacy
      // surface's `inFlight` lock. Clearing the memo makes the next frame re-pump
      // `account-changed`, which clears `inFlight` — without it, a drop during an export requested
      // while the phase was already `unknown` (the ordinary guest state) leaves all three controls
      // disabled, with no notice, for the life of the page.
      lastPrivacyCountdown = undefined;
      // The store was reset, so a bound shop / heal id refers to rows that may no longer exist.
      boundShopId = null;
      boundHealLocationId = null;
      // The requested Social tab and what the screens remember go with the session too.
      boundSocialTab = null;
      boundMonstersTab = null;
      boundProposeTarget = null;
      screenHost.forget();
      dismissedRequests.clear();
      announcedRequests.clear();
      answeredRequests.clear();
      // The SDK never settles a reducer promise after a drop: a care sent before it would hold its
      // monster's in-flight slot for the life of the page.
      careInFlight.clear();
      // The "connection lost — reconnecting…" hint and any toast are now stale.
      resetFeedbackSinks();
      // record the reconnect edge as a fresh connect (the refreshed identity).
      eventRing.push(makeConnect(identity));
      // A successful reconnect clears any session terminal overlay.
      applySession({ kind: 'connected' });
      // The same never-settles class, at the TAIL on purpose — store.reset()
      // runs on the drop edge and the post-rebuild flush is a later microtask, so a reset here can
      // never be re-disabled by a stale render.
      evolutionNoticeBanner?.reset();
      // The claim prompt this reconnect raised, if any: the sweep above closed Profile with every
      // other frame it closes, so the prompt is shown again and is what is left on screen. A
      // reconnect that raised none re-opens nothing.
      if (claimRaised) {
        claimRaised = false;
        renderClaim();
      }
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
      reportError(
        where === 'link' ? 'world-disconnect' : 'connect-failure',
        `${where}: ${message}`,
      );
      // emit disconnect ONLY on the link-level edge — not for other `where`
      // values (which fire for non-link failures too).
      if (where === 'link') eventRing.push(makeDisconnect());
    },
    // The session-lifecycle terminals drive the registry-external overlay.
    onSessionExpired: () => applySession({ kind: 'session-expired' }),
    onAuthServiceUnreachable: () => applySession({ kind: 'auth-service-unreachable' }),
    // AUTH-48: a failed FIRST sign-in routes to the claim UI (never the session overlay): the
    // paint opens Profile on Account, and a Profile already open moves its cursor there.
    onSignInFailed: (reason) => {
      const wasOpen = profileView?.visible === true;
      applyClaim({ kind: 'sign-in-failed', reason });
      if (wasOpen) profileView?.focusSection('account');
    },
    // The reconnect-triggered guest-claim lifecycle. The connection calls these two just before
    // `onReady` / `onReconnect` (`claimRaised`).
    onClaimPending: (code) => {
      claimRaised = true;
      applyClaim({ kind: 'claim-pending', code });
    },
    onClaimAwaitingAccount: () => {
      claimRaised = true;
      applyClaim({ kind: 'claim-awaiting-account' });
    },
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
  // The world interaction chip (ctl-10a) and the world sheets (uif-12): what A does with what the
  // character faces, or the open sheet. Hidden under any frame, on a battle base and under the
  // session terminal. Painted by the frame tick and, so a pointer seek sees its row cursor move,
  // after every pointer press. Answers what the hint bar needs from the same reads.
  const paintPrompt = (): { chip: InteractChip | null; pending: readonly RequestNotice[] } => {
    const live = worldBaseLive(); // first: it closes a sheet the world no longer owns
    const pending = livePending();
    screenHost.settleRequest(pending); // a withdrawn or answered request's sheet closes
    const sheet = screenHost.sheet;
    const request = screenHost.request;
    const chip = facedChip(live);
    const anchor =
      sheet !== null
        ? sheet.entries[0]?.candidate
        : chip?.kind === 'single'
          ? chip.candidate
          : (chip ?? undefined);
    // The request sheet (ctl-13) has no faced thing to hang from: it sits low and centred.
    const promptPos =
      request !== null
        ? { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight * 0.7) }
        : anchor !== undefined
          ? renderer?.screenFor({ x: anchor.anchorWorldX, y: anchor.anchorWorldY })
          : undefined;
    // The confirm's row and cursor are in the signature: a Yes / No move must repaint.
    const promptSig =
      request !== null
        ? `request|${request.notice.key}|${request.nav.item}|${requestLine(request.notice)}`
        : sheet !== null
          ? `sheet|${sheet.nav.item}|${sheet.entries.map((e) => e.key).join(',')}|${sheet.confirm?.key ?? ''}|${sheet.confirm?.nav.item ?? ''}|${sheet.confirm?.sizes.join(',') ?? ''}`
          : chip !== null
            ? interactChipText(chip)
            : null;
    const promptKey =
      promptSig !== null && promptPos !== undefined
        ? `${promptSig}|${promptPos.x}|${promptPos.y}`
        : 'none';
    if (promptKey === lastPromptKey) return { chip, pending };
    lastPromptKey = promptKey;
    const rows = interactSheet.rows;
    let sheetShown = false;
    if (promptSig !== null && promptPos !== undefined) {
      const asked =
        sheet?.confirm == null
          ? undefined
          : sheet.entries.find((e) => e.key === sheet.confirm?.key);
      interactChipTextEl.textContent = '';
      if (request !== null) {
        // The request sheet (ctl-13): who asks what, then Accept / Decline / View.
        const heading = requestLine(request.notice);
        renderContextSheet(interactSheet, {
          variant: 'list',
          title: heading,
          layout: requestSheetLayout,
          state: request.nav,
          fill: (el, item) => {
            el.textContent = requestRowLabel(item.key);
          },
        });
        // The listbox's own name, the heading's words (CTL13: read without the title's id).
        rows.setAttribute('aria-label', heading);
        sheetShown = true;
      } else if (sheet !== null && sheet.confirm !== null && asked !== undefined) {
        // The Challenge confirm (ctl-10b; bt-15 BT15.1): the question, then the party-size rows
        // (largest first) and No, each word a literal catalog key.
        const question = tf('interact.confirm.challenge', { name: interactName(asked.candidate) });
        renderContextSheet(interactSheet, {
          variant: 'confirm',
          question,
          layout: challengeLayout(sheet.confirm.sizes),
          state: sheet.confirm.nav,
          fill: (el, item) => {
            el.textContent = sizeRowLabel(item.key);
          },
        });
        rows.setAttribute('aria-label', question);
        sheetShown = true;
      } else if (sheet !== null) {
        const byKey = new Map(sheet.entries.map((e) => [e.key, e]));
        renderContextSheet(interactSheet, {
          variant: 'list',
          layout: sheetLayout(sheet.entries),
          state: sheet.nav,
          fill: (el, item) => {
            // The one row that names no entry is Close (uif-12, UIF12.2): the kit's word.
            const row = byKey.get(item.key);
            el.textContent =
              row === undefined
                ? closeRowLabel()
                : tf('interact.entry', {
                    verb: interactVerb(row.action),
                    name: interactName(row.candidate),
                  });
          },
        });
        // The listbox's accessible name: this variant has no visible title.
        rows.setAttribute('aria-label', tf('interact.choose', { key: interactKeycap() }));
        sheetShown = true;
      } else {
        interactChipTextEl.textContent = promptSig;
      }
      interactPromptEl.style.left = `${promptPos.x}px`;
      interactPromptEl.style.top = `${promptPos.y}px`;
      interactPromptEl.style.display = 'block';
    } else {
      interactPromptEl.style.display = 'none';
    }
    // Rows never outlive their sheet, shown or not.
    if (!sheetShown) {
      closeContextSheet(interactSheet);
      rows.removeAttribute('aria-label');
    }
    // One border: the prompt's own chrome steps aside while it holds a sheet (styles.css).
    interactPromptEl.classList.toggle('mr-prompt--sheet', sheetShown);
    return { chip, pending };
  };
  // pointerPress is dead under the session terminal, so this paint never runs there.
  paintWorldPrompt = paintPrompt;

  const frame = (): void => {
    try {
      syncStack(); // a server overlay shown, or a player view closed, outside a keydown or batch
      // A toast expires on the frame clock even while the session terminal owns the screen.
      tickToast(performance.now());
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
      // bt-12 (BT12.4): the results auto-advance — the outcome frame has been on top for the
      // presentation results cap and the results panel is what it shows: continue it, once per shown
      // edge (a frame over it nulls the edge, so the countdown pauses and restarts when it resurfaces).
      if (
        shouldAutoContinue(outcomeShownAtMs, now, resultsPanel?.visible === true, CAPS.resultsMs) &&
        autoContinuedAtMs !== outcomeShownAtMs
      ) {
        autoContinuedAtMs = outcomeShownAtMs;
        void dispatch({ kind: 'pop' });
      }
      // Menu auto-repeat: the router synthesizes the held D-pad's repeat edges on this clock.
      for (const effect of inputRouter.tick(routeCtx())) applyRouterEffect(effect);
      // bt-12 B: the tactical shell's playback on the frame clock; the "Still there?" countdown on
      // the WALL clock (the deadline is a server epoch instant; a batch-driven countdown would
      // freeze between batches, R5). Its first second is announced below, after the transitions.
      tacticsBattle?.tick();
      const wallNow = Date.now();
      const countdownSaid = pumpStillThere(wallNow);
      pumpClock(wallNow);
      if (now - lastCareTickAtMs >= CARE_READINESS_TICK_MS && upperIds().includes('boxView')) {
        lastCareTickAtMs = now;
        screenHost.observe(contextStack, screenCtx);
      }
      // the ONE announcement edge and the ONE focus return, at the TOP
      // of the frame so a recurring throw further down cannot silence the region. The world
      // branch and announcementsFor are disjoint by construction (the reducer emits only when
      // next.topOverlay is non-null), so neither transition is ever uttered twice. The top is the
      // stack's top frame when there is one (a screen opened over the menu is announced).
      const top = topOverlay();
      const nextSnapshot: A11ySnapshot = { topOverlay: top, message: '' };
      const edges = announcementsFor(lastA11ySnapshot, nextSnapshot);
      for (const m of edges) liveRegion.announce(m, now);
      const worldEdge = lastA11ySnapshot.topOverlay !== null && top === null;
      if (worldEdge) {
        liveRegion.announce(t('a11y.world.region'), now);
        // Only a close that itself left focus adrift (judged at its sync), still adrift: never a chip.
        if (closeLeftFocusAdrift && focusAdrift()) worldCanvasEl?.focus();
      }
      lastA11ySnapshot = nextSnapshot;
      if (countdownSaid !== null) liveRegion.announce(countdownSaid, now);
      // qf-6: a queued status notice is spoken clear of the transitions above and of anything
      // announced outside the pump since the last frame (statusNoticeStep holds it a full
      // coalescing window past them, and re-queues one they clobbered).
      const notice = statusNoticeStep(
        statusNotice,
        {
          kind: 'frame',
          nowMs: now,
          transitionAnnounced:
            edges.length > 0 || worldEdge || announcedSinceFrame || countdownSaid !== null,
        },
        COALESCE_WINDOW_MS,
      );
      announcedSinceFrame = false;
      statusNotice = notice.state;
      if (notice.speak !== null) liveRegion.announce(notice.speak, now);
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
      // wap-4: the terrain layer's water frame is a pure function of this frame's clock,
      // held at frame 0 WHILE reduced motion is set (the one MotionPreference, A11Y-28).
      renderer?.render(entities, lastCamX, lastCamY, {
        nowMs: now,
        reduceMotion: motionPreference.reduceMotion,
      });
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
      // Positioned via renderer.screenFor — the exact camera offset + stageScale the stage
      // applied THIS frame.
      const { chip, pending } = paintPrompt();
      // The live hint bar (ctl-13): the top context's buttons with their live keycaps, and the
      // request banner while the bare world shows. The view writes only what changed.
      const notices = buildNotices(noticeInput());
      const atWorld = contextStack.length === 1 && contextStack[0].kind === 'world';
      const bannerRequest = atWorld ? notices.find((n) => n.kind === 'request') : undefined;
      hintBarView?.render(
        hintChips(contextStack, chip, notices, pending),
        bannerRequest?.kind === 'request' ? requestLine(bannerRequest) : null,
      );
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
