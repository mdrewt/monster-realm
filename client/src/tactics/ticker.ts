// tactics/ticker.ts — the battle-event ticker (BT10.5): `tickerLine` turns ONE `EventPayload` into
// ONE catalog line (exhaustive over every variant), and `Ticker` keeps the newest TICKER_CAP lines
// in a plain visible list.
//
// NO live region: `[A11Y-05b]` keeps `aria-live` and `role=status|log` in ui/liveRegion.ts, so the
// list below carries neither (REV 2 A12: announcing a line to assistive technology is a later,
// separately wired concern). Every word comes from tactics/strings.ts; ids go through the injected
// `TickerNames`, so a unit's name is never read from anywhere but the caller's own lookup.
import type { EventPayload, HaltKind, TargetHit } from '../module_bindings/types';
import type { Side, StatusTag } from './boardModel';
import * as s from './strings';

export interface TickerNames {
  unit(unitId: number): string;
  skill(skillId: number): string;
  item(itemId: number): string;
  readonly mySide: Side;
}

/** Joins the clauses of one batch line (space, U+2014, space), built by code point. */
const SEPARATOR = ` ${String.fromCharCode(0x2014)} `;

function haltReason(kind: HaltKind['tag']): string {
  switch (kind) {
    case 'TargetGone':
      return s.haltTargetGone();
    case 'Unreachable':
    case 'TooFar':
    case 'Geometry':
    case 'NotAdjacent':
      return s.haltOutOfReach();
    case 'CannotAct':
    case 'BadState':
      return s.haltCannotAct();
    case 'ItemNotHeld':
      return s.haltItemNotHeld();
    case 'Unaffordable':
      return s.haltUnaffordable();
    case 'NoHeadroom':
      return s.haltPartyFull();
    case 'NotWild':
    case 'NotAllowed':
    case 'BadShape':
    case 'UnknownSkill':
      return s.haltNotAllowed();
    default:
      return kind satisfies never;
  }
}

/** A target's clause: only a HIT is narrated here. A miss and a knock-out each arrive as their own
 *  event (`Missed`, `Ko`), so rendering them in the Executed line would log them twice. */
function targetClauses(hit: TargetHit, names: TickerNames): string[] {
  return hit.hit ? [s.tickerHit(names.unit(hit.unit), hit.damage)] : [];
}

export function tickerLine(ev: EventPayload, names: TickerNames): string {
  switch (ev.tag) {
    case 'Executed': {
      const attacker = names.unit(ev.value.attacker);
      const clauses = [s.tickerExecuted(attacker, names.skill(ev.value.skillId))];
      for (const result of ev.value.results) clauses.push(...targetClauses(result, names));
      return clauses.join(SEPARATOR);
    }
    case 'Missed':
      return s.tickerMissed(names.unit(ev.value.attacker), names.unit(ev.value.target));
    case 'PlanHalted':
      return s.tickerHalted(names.unit(ev.value.unit), haltReason(ev.value.reasonKind.tag));
    case 'QueueVoided':
      return s.tickerVoided(names.unit(ev.value.unit));
    case 'AutoPass':
      return s.tickerAutoPass(names.unit(ev.value.unit), ev.value.strike);
    case 'StoodGround':
      return s.tickerStoodGround(names.unit(ev.value.unit));
    case 'Status': {
      const unit = names.unit(ev.value.unit);
      const status = s.statusLabel(ev.value.status.tag satisfies StatusTag);
      switch (ev.value.change.tag) {
        case 'Applied':
          return s.tickerStatusApplied(unit, status);
        case 'Tick':
          return s.tickerStatusTick(unit, status, ev.value.amount);
        case 'Cured':
          return s.tickerStatusCured(unit, status);
        case 'Blocked':
          return s.tickerStatusBlocked(unit, status);
        default:
          return ev.value.change satisfies never;
      }
    }
    case 'Surge':
      return s.tickerSurge(names.unit(ev.value.unit), ev.value.amount);
    case 'Ko':
      return s.tickerKo(names.unit(ev.value.unit));
    case 'RecruitResult':
      return ev.value.success
        ? s.tickerRecruitOk(names.unit(ev.value.target))
        : s.tickerRecruitFail(names.unit(ev.value.target), ev.value.pct);
    case 'Awards':
      return s.tickerAwards(
        names.unit(ev.value.unit),
        ev.value.xp,
        ev.value.essence,
        ev.value.currency,
      );
    case 'Moved':
      return s.tickerMoved(names.unit(ev.value.unit), ev.value.tiles);
    case 'ItemUsed':
      return s.tickerItemUsed(
        names.unit(ev.value.unit),
        names.item(ev.value.itemId),
        names.unit(ev.value.target),
      );
    case 'TurnEnded':
      return ev.value.guard
        ? s.tickerGuarded(names.unit(ev.value.unit))
        : s.tickerTurnEnded(names.unit(ev.value.unit));
    case 'RoundEnded':
      return s.tickerRoundEnded(ev.value.round);
    case 'BattleStarted':
      return s.tickerBattleStarted();
    case 'BattleEnd': {
      switch (ev.value.outcome.tag) {
        case 'SideAWins':
          return names.mySide === 'A' ? s.tickerWon() : s.tickerLost();
        case 'SideBWins':
          return names.mySide === 'B' ? s.tickerWon() : s.tickerLost();
        case 'Fled':
          return s.tickerFled();
        case 'Ongoing':
          return s.tickerBattleEnded();
        default:
          return ev.value.outcome satisfies never;
      }
    }
    default:
      ev satisfies never;
      throw new Error(`tactics ticker: unknown event ${String((ev as { tag?: unknown }).tag)}`);
  }
}

/** The most lines the ticker keeps (the oldest are dropped first). */
export const TICKER_CAP = 50;

export class Ticker {
  readonly #list: HTMLElement;
  #lines: string[] = [];

  constructor(parent: HTMLElement) {
    this.#list = document.createElement('ul');
    this.#list.className = 'tactics-ticker';
    this.#list.setAttribute('aria-label', s.tickerLabel());
    // A scrollable region a keyboard user can reach (no role: not a live region).
    this.#list.setAttribute('tabindex', '0');
    parent.appendChild(this.#list);
  }

  /** Append one line (newest last); past TICKER_CAP the oldest line leaves the list and the DOM. */
  push(line: string): void {
    // Re-resolved here so a locale switched after construction is picked up.
    this.#list.setAttribute('aria-label', s.tickerLabel());
    const item = document.createElement('li');
    item.textContent = line;
    this.#list.appendChild(item);
    this.#lines.push(line);
    while (this.#lines.length > TICKER_CAP) {
      this.#lines.shift();
      this.#list.firstElementChild?.remove();
    }
    // Follow the newest line; only the ticker scrolls (the turn bar never does).
    this.#list.scrollTop = this.#list.scrollHeight;
  }

  /** Drop every line (a new battle starts with an empty log). */
  clear(): void {
    this.#lines = [];
    this.#list.replaceChildren();
  }

  lines(): readonly string[] {
    return [...this.#lines];
  }
}
