// shell/battleFrame — the battle frame: the three views that can own it (the deploy panel of
// a Deploying battle, the tactical shell of an Active one, the results panel of a Finished one),
// which one shows, the outcome latch, the tactics memos and the server-time estimate the
// countdowns read. `refreshBattle` decides the frame on each batch; the frame loop pumps the
// countdown and the PvP clock (`pumpStillThere`, `pumpClock`) on the estimate `feedServerClock`
// feeds.
//
// What the module reaches up into `main.ts` for comes through the battle port
// (`installBattlePort`): the context stack as it stands, and the outcome edge it clears while the
// results wait for the shell's playback. `main.ts` installs it once, at its own module scope,
// before it registers its first listener; until then each member throws. `main()` mounts the
// element the views are built in (`mountBattleFrame`), `resetPredictionState` resets the battle
// and tactics state (`resetBattleFrame`), and `closeFrame` continues the outcome
// (`continueOutcome`). The views' handlers run commands through the command port. The module
// registers no listener and writes nothing to the document until a view is built.

// bt-12: the tactics rules port is bound from the whole pkg namespace, LAZILY (`tacticsRules()`): the
// test mocks of this module carry only the names main.ts and shell/config.ts import by name, and `bindTacticsRules`
// refuses a pkg missing a tactics export — so the bind happens on the first deploy render only.
import * as wasmPkg from '../../../client-wasm/pkg/client_wasm.js';
import { ServerClock } from '../net/serverClock';
import { ownPerspective, type StoreMonsterPub, type StoreTacticalBattle } from '../net/store';
import { clockVM } from '../tactics/clock';
import { DeployPanel, type DeployVM, deployVM } from '../tactics/deployPanel';
import { type ResultsInput, ResultsPanel, type ResultsVM, resultsVM } from '../tactics/results';
import { stillThere } from '../tactics/strings';
import {
  TacticsBattle,
  type TacticsBattleDeps,
  type TacticsBattleVM,
} from '../tactics/tacticsBattle';
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
} from '../tactics/wasm';
import { buildBaitItems, decideBattleOverlay } from '../ui/battleModel';
import {
  battleRenderer,
  continuedBattleId,
  countdownDeadline,
  hideOtherBattleViews,
  outcomeOnTop,
  popPlayerFramesOverBattle,
  ratingChange,
  renderableBattle,
  stillThereSeconds,
  structurallyEqual,
} from '../ui/battlePolicy';
import type { Stack } from '../ui/contextStack';
import type { HintBattle, HintDeploy } from '../ui/hintBarModel';
import { lockedSessionMonsterIds } from '../ui/tradeSessionModel';
import { commandPort } from './commandPort';
import { queueNotice, reportPaintError, statusNotice } from './feedback';
import { keycap } from './inputState';
import { motionPreference } from './screenContext';
import { identity, store } from './session';

/** What the battle frame reaches up into `main.ts` for. */
export interface BattlePort {
  /** The context stack as it stands at the call. */
  readonly stack: () => Stack;
  /** Null the outcome edge, so A's grace and the auto-advance start when the results show. */
  readonly clearOutcomeEdge: () => void;
}

const battlePortMissing = (): never => {
  throw new Error('shell/battleFrame: the battle port is not installed');
};

/** The installed battle port. Until `installBattlePort` runs, each member throws. */
let battlePort: BattlePort = {
  stack: battlePortMissing,
  clearOutcomeEdge: battlePortMissing,
};

/** Install the battle port. `main.ts` calls this once, at its own module scope, before it registers
 *  its first listener. */
export function installBattlePort(next: BattlePort): void {
  battlePort = next;
}

// bt-12 (BT12.1-BT12.4): the deploy panel (a Deploying battle) and the results panel (a Finished one)
// share the `battleView` frame and overlay id. Both are constructed LAZILY, on the first batch that
// routes to them (the frame has ONE owner, so one `battle-title` root at a time), on the mount
// `main()` hands `mountBattleFrame` (`battleMount`). bt-17: the 1v1 view is gone; no view is built
// at boot.
export let deployPanel: DeployPanel | undefined;
export let resultsPanel: ResultsPanel | undefined;
// bt-12 B (BT12.1): the tactical shell owns the frame of an Active tactical battle; built lazily too.
export let tacticsBattle: TacticsBattle | undefined;
let battleMount: HTMLElement | undefined;
let tacticsRulesPort: TacticsClientRules | null = null;
/** The tactics rules port, bound on first use (see the `wasmPkg` import note). */
const tacticsRules = (): TacticsClientRules => (tacticsRulesPort ??= bindTacticsRules(wasmPkg));
/** The client-facing tuning (the Surge start, the wild round cap, the strikes that forfeit), read once. */
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
/** ts-6b-7.3: the battle whose results wait for the shell's playback to drain (null: none waits). */
export let resultsAwaitDrain: bigint | null = null;
/** ts-6b-7.2: the server-time estimate the battle countdowns read (fed by live clock windows). */
export const serverClock = new ServerClock();
/** The three views that can own the battle frame, in a fixed order (undefined until built). */
const battleViews = (): readonly (DeployPanel | ResultsPanel | TacticsBattle | undefined)[] => [
  deployPanel,
  resultsPanel,
  tacticsBattle,
];
/** Whether any battle view shows: the `battleView` mirror probe. */
export const battleFrameShown = (): boolean => battleViews().some((v) => v?.visible === true);
/** The `battleView` force-hide handle: every built view's own hide (each is idempotent). */
export const hideAllBattleViews = (): void => {
  for (const v of battleViews()) v?.hide();
  tacticsShown = null;
  resultsAwaitDrain = null;
};
/** The view the screen host lends the battle adapter: the tactical shell while it shows, else the
 *  deploy panel while it shows, else nothing (the results panel takes no ops; its Continue is a click
 *  or the auto-advance — and bt-17 deleted the 1v1 view). */
export const activeBattleView = (): DeployPanel | TacticsBattle | undefined =>
  tacticsBattle?.visible === true
    ? tacticsBattle
    : deployPanel?.visible === true
      ? deployPanel
      : undefined;
/** Whether Start is the battle adapter's (bt-11 BT11.6, bt-12 B): the tactical shell shows (End Turn
 *  / Guard / Submit) or the deploy panel's EDITOR is open (Submit). At the deploy CONFIRM screen Start
 *  opens the main menu as at any battle base, so Escape (Start's key) never deploys (REV 2 A6). */
export const tacticalOwnsStart = (): boolean =>
  tacticsBattle?.visible === true || (deployPanel?.visible === true && deployPanel.mode === 'edit');
/** What the shown battle view tells the hint bar and Help: the shell's verbs, else the deploy panel's
 *  screen (both of them — R-bt-12-DEPLOYHINT), else nothing (no shown view, or the results panel). */
export const battleHint = (): HintBattle | HintDeploy | undefined =>
  tacticsBattle?.visible === true
    ? tacticsBattle.hint()
    : deployPanel?.visible === true
      ? deployPanel.hint()
      : undefined;

/** The own monsters a trade locks: the player's confirmed sides of trade sessions. Neither offered
 *  to a deploy nor committed to a challenge (the server refuses a locked monster at both). */
export function tradedIds(): ReadonlySet<bigint> {
  return lockedSessionMonsterIds(store.allTradeSessions(), identity);
}
/** bt-15 (BT15.1): the own `battle_deploy` row(s) of `battleId` are all locked — this side has
 *  deployed and waits for the other side's lock (a Practice battle stages two own rows in turn). */
function ownDeployLocked(battleId: bigint): boolean {
  const mine = store.battleDeploys(battleId).filter((d) => d.owner === identity);
  return mine.length > 0 && mine.every((d) => d.locked);
}

// Outcome-frame lifecycle (M8.7e): the dismissed battle id (so a resolved outcome
// renders once but never re-pops) + whether any battle has been observed this
// session (first-sight pre-dismiss of a historical/stale-on-login resolved battle).
export let dismissedBattleId: bigint | null = null;
export let battleSynced = false;
/** bt-17: the row-less anchor already reported (once per battle id) — see `refreshBattle`. */
let unrenderableReported: bigint | null = null;

/** The element the battle views are built in: `main()` mounts it at boot. Until then `battleMount` is
 *  `undefined` and nothing builds. */
export function mountBattleFrame(mount: HTMLElement): void {
  battleMount = mount;
}

/** The battle and tactics state a reconnect or a zone switch drops (`resetPredictionState`). */
export function resetBattleFrame(): void {
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
  resultsAwaitDrain = null;
  // The rows after a reconnect are a snapshot: their windows may have opened long ago.
  serverClock.forgetWindows();
}

/** The terminal outcome continues (`closeFrame`'s battle arm): the latch, then every battle view
 *  hides. */
export function continueOutcome(): void {
  dismissedBattleId = continuedBattleId(store.latestPlayerBattle(identity), dismissedBattleId);
  hideAllBattleViews();
}

export function refreshBattle(): void {
  // ts-6b-7.3: only the results hold below keeps a wait alive, so a battle that moved on ends it.
  resultsAwaitDrain = null;
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
    if (renderer === 'results' && holdResultsForPlayback(battle.battleId)) return;
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
  if (switching)
    commandPort.applyStack(battlePort.stack(), popPlayerFramesOverBattle(battlePort.stack()));
}

/** The one name rule for an own monster: the nickname, else the species name, else `#id`. */
function ownMonsterName(m: StoreMonsterPub): string {
  // `||`, not `??`: an EMPTY species name (a content row with no name) falls through to the id too
  // (bt-17 T7 — the qf-17 payout line's rule, carried to the deploy and results panels).
  return m.nickname || store.species(m.speciesId)?.name || `#${m.monsterId}`;
}

/** What the client keeps of a battle map — its size — read once per mapId through the rules port (a
 *  whole map definition crosses the wasm boundary for two numbers). */
const tacticsMapFacts = new Map<number, { readonly width: number; readonly height: number }>();
function mapFactsOf(mapId: number): { width: number; height: number } {
  let facts = tacticsMapFacts.get(mapId);
  if (facts === undefined) {
    const map = tacticsRules().map(mapId);
    facts = { width: map.width, height: map.height };
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
 *  it), the remembered formation, the pack from the anchor's side B and the slot count the rules
 *  answer for the battle's map (game-core's `deploy_slots`, the server's own cap). Builds the panel on
 *  first use. null (reported once) when the rules port or the map cannot be read — the frame keeps its
 *  current owner (B17). */
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
    // list and follows its own `battle_deploy.locked`; the anchor's side B is read only as a wild
    // pack (a Deploying PvP anchor arrives with the opponent's side empty: schema.rs `my_battle`).
    const vm = deployVM(
      shellKind(row.kind) === 'pvp'
        ? { mode: 'pvp', ...base, format: row.format, locked: ownDeployLocked(row.battleId) }
        : {
            mode: 'wild',
            ...base,
            slotCount: tacticsRules().deploySlots(row.mapId),
            // The pack (bt-12 B): the server seats every wild in the anchor's side B at the start.
            wilds: battle.sideB.team.map((w) => ({
              speciesId: w.speciesId,
              name: store.species(w.speciesId)?.name ?? `#${w.speciesId}`,
              level: w.level,
            })),
          },
    );
    deployPanel ??= new DeployPanel(battleMount, {
      onDeploy: (battleId, picks) => commandPort.dispatch({ kind: 'deployUnits', battleId, picks }),
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
      if (outcomeOnTop(battlePort.stack())) void commandPort.dispatch({ kind: 'pop' });
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
  const first = tacticsIngested?.battleId !== row.battleId;
  if (!(view.visible && lastTacticsVM !== null && tacticsVMEqual(lastTacticsVM, vm))) {
    try {
      view.render(vm);
    } catch (err) {
      reportPaintError(err);
      return false;
    }
    lastTacticsVM = vm;
  }
  // A first sighting feeds the history while HIDDEN (the render of a new battle cleared the ticker;
  // a hidden view plays no beats) and then shows; a later batch shows first, so only live events play.
  if (first) feedTacticsShell(view, row.battleId);
  popOverBattleBeforeSwitch(view);
  hideOtherBattleViews(battleViews(), view);
  if (!view.visible) view.show();
  if (!first) feedTacticsShell(view, row.battleId);
  return true;
}

/** The battle's transcript past the shell's per-battle watermark (REV B2.4) → `ingest`; the mark
 *  then moves past it. */
function feedTacticsShell(view: TacticsBattle, battleId: bigint): void {
  const mark = tacticsIngested;
  const since = mark === null || mark.battleId !== battleId ? -1 : mark.seq;
  const fresh = store.battleEvents(battleId).filter((e) => e.seq > since);
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
  tacticsIngested = { battleId, seq: fresh.at(-1)?.seq ?? since };
}

/** ts-6b-7.3: the Finished batch of the battle the VISIBLE shell already plays (fed before — never a
 *  first sighting, so a reconnect replays nothing live) feeds the shell its last events, and while
 *  their beats play the shell keeps the frame, its only owner: the frame pump re-runs `refreshBattle`
 *  once the playback drains (each beat is capped, so the wait is bounded) and the results panel takes
 *  the frame then. True while the results wait. */
function holdResultsForPlayback(battleId: bigint): boolean {
  const view = tacticsBattle;
  if (view === undefined || !view.visible || tacticsIngested?.battleId !== battleId) return false;
  feedTacticsShell(view, battleId);
  if (!view.playing) return false;
  resultsAwaitDrain = battleId;
  // The outcome is not shown until the results are: A's grace and the auto-advance wait for them
  // (this batch's `syncStack` may already have started the edge — it runs before `refreshBattle`).
  battlePort.clearOutcomeEdge();
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
      void commandPort.dispatch({ kind: 'submitQueue', battleId, unitId, entries }),
    onCancelQueue: (battleId, unitId) =>
      void commandPort.dispatch({ kind: 'cancelQueue', battleId, unitId }),
    onForfeit: (battleId) => void commandPort.dispatch({ kind: 'forfeit', battleId }),
    keycap,
    // Joined onto a notice still queued, never replacing it (the queue holds one).
    announce: (text) =>
      queueNotice(
        statusNotice.queued === null ? text : `${statusNotice.queued.text} ${text}`,
        performance.now(),
      ),
  };
}

/** The "Still there?" countdown (BT12.2), pumped on the server-time estimate `serverNowMs` (ts-6b-7.2):
 *  the shown tactical view's own clock deadline — a WILD battle's only — through `stillThereSeconds`;
 *  the view memoises the second, so an unchanged value writes nothing. Returns the line to announce the
 *  first time a window's countdown shows, else null. */
export function pumpStillThere(serverNowMs: number): string | null {
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
  const seconds = stillThereSeconds(deadline, serverNowMs);
  view.setCountdown(seconds);
  // The live-region announcement stays the WILD "Still there?" nudge: a PvP deploy window paints
  // its countdown and announces nothing (bt-15 interim; the continuation words it as a deploy one).
  if (shown.kind !== 'Wild' || seconds === null || deadline === null) return null;
  if (stillThereAnnouncedFor === deadline) return null;
  stillThereAnnouncedFor = deadline;
  return stillThere(seconds);
}

/** The PvP clock ring and strike pips (bt-15 increment B, BT15.2), pumped on the server-time estimate
 *  like the countdown: the shown tactical shell's battle rows → `clockVM` → `setClock` (the shell memoises an
 *  equal VM). A frame the VM cannot be built on (no shown battle, no tactical row) clears it, so a
 *  stale ring never outlives its window. Both players see both rings and strike counts: the clock rows
 *  are public match state (design §6.2). */
export function pumpClock(serverNowMs: number): void {
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
      nowMs: serverNowMs,
      strikesMax: tuningOf().autopass_forfeit,
    }),
  );
}

/** The shown battle's clock rows feed the server-time estimate. `main.ts` registers this as a batch
 *  listener after `refreshBattle`, which sets the shown battle, so a battle's first batch is already
 *  remembered. */
export function feedServerClock(): void {
  const shown = tacticsShown;
  if (shown !== null) serverClock.observeWindows(store.battleClocks(shown.battleId), Date.now());
}
