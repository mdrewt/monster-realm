// tactics/strings.ts — the ONE resolver importer for client/src/tactics (PARITY-02 roster). Every
// player-facing or assistive-technology string the tactical client shows comes out of one of these
// functions; no other tactics module imports the resolver or writes a literal word to a text sink
// (tactics/strings.test.ts scans for both).
//
// Every `t(`/`tf(` first argument is a string LITERAL (a `switch` picks between calls, never
// between keys) so PARITY-02's dynamic-key scan stays quiet. Model data (species, skill and item
// names, affinity, role, a status or halt reason already resolved here) flows through as params,
// never as catalog text.
import { t, tf } from '../ui/i18n/resolver';
import type { IntentKind, Stance, StatusTag } from './boardModel';
import type { MenuRowId, ReasonCode } from './commandModel';
import type { Badge } from './queueStrip';
import type { ResultsOutcome } from './results';

// --- region labels --------------------------------------------------------------------------

export const boardLabel = (): string => t('tactics.board.label');
export const dockLabel = (): string => t('tactics.dock.label');
export const tickerLabel = (): string => t('tactics.ticker.label');
export const turnbarLabel = (): string => t('tactics.turnbar.label');

/** The frame heading (the overlay's initial-focus anchor); shared with the legacy battle view. */
export const battleTitle = (): string => t('battle.title');

// --- turn bar --------------------------------------------------------------------------------

export const turnbarLocked = (): string => t('tactics.turnbar.locked');
export const turnbarSurgeActive = (): string => t('tactics.turnbar.surgeActive');
export const turnbarRound = (round: number): string => tf('tactics.turnbar.round', { round });
export const turnbarSurgeIn = (n: number): string => tf('tactics.turnbar.surgeIn', { n });
export const turnbarRetreatAt = (round: number): string =>
  tf('tactics.turnbar.retreatAt', { round });

// --- HUD -------------------------------------------------------------------------------------

export const hudGuard = (): string => t('tactics.hud.guard');
export const hudFirstStand = (): string => t('tactics.hud.firstStand');
export const hudLevel = (level: number): string => tf('tactics.hud.level', { level });
export const hudHp = (hp: number, max: number): string => tf('tactics.hud.hp', { hp, max });
export const hudAp = (ap: number, max: number): string => tf('tactics.hud.ap', { ap, max });
export const hudRole = (role: string): string => tf('tactics.hud.role', { role });

export function stanceLabel(stance: Stance): string {
  switch (stance) {
    case 'Aggressive':
      return t('tactics.stance.aggressive');
    case 'Territorial':
      return t('tactics.stance.territorial');
    case 'Skittish':
      return t('tactics.stance.skittish');
    default:
      return stance satisfies never;
  }
}

export function statusLabel(status: StatusTag): string {
  switch (status) {
    case 'Poison':
      return t('tactics.status.poison');
    case 'Burn':
      return t('tactics.status.burn');
    case 'Paralysis':
      return t('tactics.status.paralysis');
    case 'Sleep':
      return t('tactics.status.sleep');
    case 'Freeze':
      return t('tactics.status.freeze');
    default:
      return status satisfies never;
  }
}

export function intentLabel(kind: IntentKind): string {
  switch (kind) {
    case 'attack':
      return t('tactics.intent.attack');
    case 'move':
      return t('tactics.intent.move');
    case 'hold':
      return t('tactics.intent.hold');
    default:
      return kind satisfies never;
  }
}

// --- halt reasons (inserted into the halted line) ---------------------------------------------

export const haltTargetGone = (): string => t('tactics.halt.targetGone');
export const haltOutOfReach = (): string => t('tactics.halt.outOfReach');
export const haltCannotAct = (): string => t('tactics.halt.cannotAct');
export const haltItemNotHeld = (): string => t('tactics.halt.itemNotHeld');
export const haltUnaffordable = (): string => t('tactics.halt.unaffordable');
export const haltPartyFull = (): string => t('tactics.halt.partyFull');
export const haltNotAllowed = (): string => t('tactics.halt.notAllowed');

// --- ticker ----------------------------------------------------------------------------------

export const tickerBattleStarted = (): string => t('tactics.ticker.battleStarted');
export const tickerWon = (): string => t('tactics.ticker.won');
export const tickerLost = (): string => t('tactics.ticker.lost');
export const tickerFled = (): string => t('tactics.ticker.fled');
export const tickerBattleEnded = (): string => t('tactics.ticker.battleEnded');

export const tickerExecuted = (unit: string, skill: string): string =>
  tf('tactics.ticker.executed', { unit, skill });
export const tickerHit = (target: string, damage: number): string =>
  tf('tactics.ticker.hit', { target, damage });
export const tickerMissed = (unit: string, target: string): string =>
  tf('tactics.ticker.missed', { unit, target });
export const tickerHalted = (unit: string, reason: string): string =>
  tf('tactics.ticker.halted', { unit, reason });
export const tickerVoided = (unit: string): string => tf('tactics.ticker.voided', { unit });
export const tickerAutoPass = (unit: string, strike: number): string =>
  tf('tactics.ticker.autoPass', { unit, strike });
export const tickerStoodGround = (unit: string): string =>
  tf('tactics.ticker.stoodGround', { unit });
export const tickerStatusApplied = (unit: string, status: string): string =>
  tf('tactics.ticker.statusApplied', { unit, status });
export const tickerStatusTick = (unit: string, status: string, amount: number): string =>
  tf('tactics.ticker.statusTick', { unit, status, amount });
export const tickerStatusCured = (unit: string, status: string): string =>
  tf('tactics.ticker.statusCured', { unit, status });
export const tickerStatusBlocked = (unit: string, status: string): string =>
  tf('tactics.ticker.statusBlocked', { unit, status });
export const tickerSurge = (unit: string, amount: number): string =>
  tf('tactics.ticker.surge', { unit, amount });
export const tickerKo = (unit: string): string => tf('tactics.ticker.ko', { unit });
export const tickerRecruitOk = (target: string): string =>
  tf('tactics.ticker.recruitOk', { target });
export const tickerRecruitFail = (target: string, pct: number): string =>
  tf('tactics.ticker.recruitFail', { target, pct });
export const tickerAwards = (unit: string, xp: number, essence: number, currency: bigint): string =>
  tf('tactics.ticker.awards', { unit, xp, essence, currency });
export const tickerMoved = (unit: string, tiles: number): string =>
  tf('tactics.ticker.moved', { unit, tiles });
export const tickerItemUsed = (unit: string, item: string, target: string): string =>
  tf('tactics.ticker.itemUsed', { unit, item, target });
export const tickerTurnEnded = (unit: string): string => tf('tactics.ticker.turnEnded', { unit });
export const tickerGuarded = (unit: string): string => tf('tactics.ticker.guarded', { unit });
export const tickerRoundEnded = (round: number): string =>
  tf('tactics.ticker.roundEnded', { round });

// --- banner ----------------------------------------------------------------------------------

export const bannerTurn = (unit: string): string => tf('tactics.banner.turn', { unit });

// --- command menu (bt-11, BT11.1) -------------------------------------------------------------

export const menuLabel = (): string => t('tactics.menu.label');
export const menuMove = (): string => t('tactics.menu.move');
export const menuSkills = (): string => t('tactics.menu.skills');
export const menuItem = (): string => t('tactics.menu.item');
export const menuRecruit = (): string => t('tactics.menu.recruit');
export const menuFlee = (): string => t('tactics.menu.flee');
export const menuEndTurn = (): string => t('tactics.menu.endTurn');
export const menuGuard = (): string => t('tactics.menu.guard');
export const menuSubmit = (): string => t('tactics.menu.submit');
export const menuClearPlan = (): string => t('tactics.menu.clearPlan');
export const menuClearYes = (): string => t('tactics.menu.clearYes');
export const menuClearNo = (): string => t('tactics.menu.clearNo');
export const menuNoBait = (): string => t('tactics.menu.noBait');

/** The label of a root row; the End row reads Guard or End Turn per `endLabel`. */
export function menuRowLabel(id: MenuRowId, end: 'endTurn' | 'guard'): string {
  switch (id) {
    case 'move':
      return menuMove();
    case 'skills':
      return menuSkills();
    case 'item':
      return menuItem();
    case 'recruit':
      return menuRecruit();
    case 'flee':
      return menuFlee();
    case 'end':
      return end === 'guard' ? menuGuard() : menuEndTurn();
    case 'submit':
      return menuSubmit();
    case 'clear':
      return menuClearPlan();
    default:
      return id satisfies never;
  }
}

/** The one-line reason a row is greyed; `ap` is the rules' fresh budget (the two full-budget
 *  reasons print it). */
export function reasonLabel(code: ReasonCode, ap: number): string {
  switch (code) {
    case 'recruitFullAp':
      return tf('tactics.reason.recruitFullAp', { ap });
    case 'fleeFullAp':
      return tf('tactics.reason.fleeFullAp', { ap });
    case 'outOfRange':
      return t('tactics.reason.outOfRange');
    case 'partyFull':
      return t('tactics.reason.partyFull');
    case 'unaffordable':
      return t('tactics.reason.unaffordable');
    case 'strideCap':
      return t('tactics.reason.strideCap');
    case 'boxedIn':
      return t('tactics.reason.boxedIn');
    case 'notAvailable':
      return t('tactics.reason.notAvailable');
    case 'planComplete':
      return t('tactics.reason.planComplete');
    default:
      return code satisfies never;
  }
}

// --- plan strip, ghost, dock (bt-11, BT11.2 / BT11.3 / BT11.6) ------------------------------

export const queueLabel = (): string => t('tactics.queue.label');
/** The status notice for the cancel race (`cancel_queue` → `AlreadyActing`). */
export const queueTooLate = (): string => t('tactics.queue.tooLate');
export const ghostLabel = (): string => t('tactics.ghost.label');
export const dockDanger = (): string => t('tactics.dock.danger');
export const dockPrevUnit = (): string => t('tactics.dock.prevUnit');
export const dockNextUnit = (): string => t('tactics.dock.nextUnit');

// --- plan strip badges and pips (bt-11, BT11.3) ----------------------------------------------

/** The badge's word (its title and accessible name; the glyph is CSS). */
export function badgeLabel(badge: Badge): string {
  switch (badge) {
    case 'firm':
      return t('tactics.badge.firm');
    case 'provisional':
      return t('tactics.badge.provisional');
    case 'stale':
      return t('tactics.badge.stale');
    default:
      return badge satisfies never;
  }
}
export const badgeOnlyHeld = (n: number): string => tf('tactics.badge.onlyHeld', { n });
export const chipCost = (ap: number): string => tf('tactics.chip.cost', { ap });

// --- forecast panel (bt-11, BT11.4) ------------------------------------------------------------

export const forecastLabel = (): string => t('tactics.forecast.label');
export const forecastVs = (unit: string): string => tf('tactics.forecast.vs', { unit });
export const forecastHit = (pct: number): string => tf('tactics.forecast.hit', { pct });
export const forecastDamage = (min: number, max: number): string =>
  tf('tactics.forecast.damage', { min, max });
export const forecastMiss = (): string => t('tactics.forecast.miss');
/** The type-chart multiplier as the rules reduce it: a whole number prints ×N, else ×N/D. */
export const forecastType = (num: number, den: number): string =>
  den === 1
    ? tf('tactics.forecast.typeTimes', { num })
    : tf('tactics.forecast.typeOver', { num, den });
export const forecastTypeImmune = (): string => t('tactics.forecast.typeImmune');
export const forecastStab = (): string => t('tactics.forecast.stab');
export const forecastFlank = (num: number, den: number): string =>
  tf('tactics.forecast.flank', { num, den });
export const forecastGuard = (num: number, den: number): string =>
  tf('tactics.forecast.guard', { num, den });
export const forecastLethal = (): string => t('tactics.forecast.lethal');
export const forecastLethalMax = (): string => t('tactics.forecast.lethalMax');
export const forecastFirstStand = (): string => t('tactics.forecast.firstStand');
/** `status` is already resolved (`statusLabel`). */
export const forecastStatus = (status: string): string => tf('tactics.forecast.status', { status });
export const forecastRecruit = (pct: number): string => tf('tactics.forecast.recruit', { pct });
export const forecastRecruitLines = (
  base: number,
  bait: number,
  weakened: number,
  pct: number,
): string => tf('tactics.forecast.recruitLines', { base, bait, weakened, pct });
export const forecastBait = (item: string): string => tf('tactics.forecast.bait', { item });

// --- the Projected style (bt-11, BT11.5) -------------------------------------------------------

export const projectedLabel = (): string => t('tactics.projected.label');
/** `tile` is the A1 notation the shell formats (a letter and a 1-based row). */
export const projectedAssumes = (unit: string, tile: string): string =>
  tf('tactics.projected.assumes', { unit, tile });
export const projectedEnemiesHold = (): string => t('tactics.projected.enemiesHold');

// --- the deploy panel (bt-12, BT12.2 / BT12.3) ----------------------------------------------------

export const deployTitle = (): string => t('tactics.deploy.title');
export const deployLabel = (): string => t('tactics.deploy.label');
/** `n` is the 1-based slot number (the caller passes `i + 1`). */
export const deploySlot = (n: number): string => tf('tactics.deploy.slot', { n });
export const deployEmpty = (): string => t('tactics.deploy.empty');
export const deployDeploy = (): string => t('tactics.deploy.deploy');
export const deployEdit = (): string => t('tactics.deploy.edit');
export const deploySending = (): string => t('tactics.deploy.sending');
export const deployCandidateLabel = (): string => t('tactics.deploy.candidateLabel');
export const deployPrevMonster = (): string => t('tactics.deploy.prevMonster');
export const deployNextMonster = (): string => t('tactics.deploy.nextMonster');
export const deployConfirm = (): string => t('tactics.deploy.confirm');
export const deployBack = (): string => t('tactics.deploy.back');

// --- the results panel (bt-12, BT12.4) --------------------------------------------------------------

/** The panel's title: the shipped 1v1 outcome texts (never a fresh key). */
export function resultsTitle(outcome: ResultsOutcome): string {
  switch (outcome) {
    case 'won':
      return t('battle.outcome.victory');
    case 'lost':
      return t('battle.outcome.defeat');
    case 'fled':
      return t('battle.outcome.fled');
    default:
      return outcome satisfies never;
  }
}
export const resultsLabel = (): string => t('tactics.results.label');
export const resultsNone = (): string => t('tactics.results.none');
export const resultsContinue = (): string => t('tactics.results.continue');
export const resultsMonster = (name: string, xp: number, essence: number): string =>
  tf('tactics.results.monster', { name, xp, essence });
/** `amount` is the server's u64 (a bigint), printed digit for digit. */
export const resultsCurrency = (amount: bigint): string =>
  tf('tactics.results.currency', { amount });
export const resultsRecruited = (name: string): string => tf('tactics.results.recruited', { name });
