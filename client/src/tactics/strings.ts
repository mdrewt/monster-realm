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
