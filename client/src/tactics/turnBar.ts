// tactics/turnBar.ts — the turn-order bar (BT10.3): the frozen order with the current unit
// highlighted and acted units dimmed, KO'd chips dropped, the next round ghosted, a lock on OWN
// READY chips only, the round counter and the "Surge in N" / "Retreat at N" badges.
//
// `turnBarVM` is pure and does no game-rule arithmetic: the next round's order arrives as an input
// (`nextInitiative`) and the badge thresholds are display constants, not rules. `renderTurnBar`
// takes NO selection, so selecting a unit can never recentre the bar: it writes chips into one
// host element that is the same node on every render and never touches scroll or focus.
import type { TacticalUnit } from './boardModel';
import * as s from './strings';

export const SURGE_BADGE_FROM_ROUND = 7;
export const RETREAT_BADGE_FROM_ROUND = 25;
export interface TurnChipVM {
  readonly unitId: number;
  readonly speciesName: string;
  readonly mine: boolean;
  readonly state: 'current' | 'acted' | 'pending' | 'ghost';
  readonly locked: boolean;
}
export type TurnBadge =
  | { readonly kind: 'surgeIn'; readonly n: number }
  | { readonly kind: 'surgeActive' }
  | { readonly kind: 'retreatAt'; readonly round: number }
  | null;
export interface TurnBarVM {
  readonly round: number;
  readonly chips: readonly TurnChipVM[];
  readonly ghosts: readonly TurnChipVM[];
  readonly badge: TurnBadge;
}
export interface TurnBarInput {
  readonly kind: 'wild' | 'pvp';
  readonly round: number;
  readonly initiative: readonly number[];
  readonly turnIdx: number;
  readonly nextInitiative: readonly number[];
  readonly units: readonly TacticalUnit[];
  readonly readyUnitIds: ReadonlySet<number>;
  readonly surgeStartRound: number;
  readonly wildRoundCap: number;
}

function badgeFor(input: TurnBarInput): TurnBadge {
  if (input.kind === 'pvp' && input.round >= SURGE_BADGE_FROM_ROUND) {
    return input.round < input.surgeStartRound
      ? { kind: 'surgeIn', n: input.surgeStartRound - input.round }
      : { kind: 'surgeActive' };
  }
  if (input.kind === 'wild' && input.round >= RETREAT_BADGE_FROM_ROUND) {
    return { kind: 'retreatAt', round: input.wildRoundCap };
  }
  return null;
}

export function turnBarVM(input: TurnBarInput): TurnBarVM {
  const byId = new Map<number, TacticalUnit>();
  for (const u of input.units) if (!byId.has(u.unitId)) byId.set(u.unitId, u);
  const active = (id: number): TacticalUnit | null => {
    const u = byId.get(id);
    return u !== undefined && u.state === 'Active' ? u : null;
  };

  // turnIdx indexes the RAW initiative: classify by position first, then drop the ids that are
  // KO'd, unknown or repeated (the first occurrence wins).
  const chips: TurnChipVM[] = [];
  const seen = new Set<number>();
  for (const [i, id] of input.initiative.entries()) {
    const u = active(id);
    if (u === null || seen.has(id)) continue;
    seen.add(id);
    const state = i < input.turnIdx ? 'acted' : i === input.turnIdx ? 'current' : 'pending';
    chips.push({
      unitId: id,
      speciesName: u.speciesName,
      mine: u.mine,
      state,
      locked: u.mine && input.readyUnitIds.has(id) && state !== 'acted',
    });
  }

  const ghosts: TurnChipVM[] = [];
  for (const id of input.nextInitiative) {
    const u = active(id);
    if (u === null) continue;
    ghosts.push({
      unitId: id,
      speciesName: u.speciesName,
      mine: u.mine,
      state: 'ghost',
      locked: false,
    });
  }
  return { round: input.round, chips, ghosts, badge: badgeFor(input) };
}

function badgeText(badge: NonNullable<TurnBadge>): string {
  switch (badge.kind) {
    case 'surgeIn':
      return s.turnbarSurgeIn(badge.n);
    case 'surgeActive':
      return s.turnbarSurgeActive();
    case 'retreatAt':
      return s.turnbarRetreatAt(badge.round);
    default:
      return badge satisfies never;
  }
}

function paintChip(vm: TurnChipVM): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `tactics-chip tactics-chip--${vm.state}`;
  if (vm.mine) chip.classList.add('tactics-chip--mine');
  chip.setAttribute('data-unit-id', String(vm.unitId));
  chip.textContent = vm.speciesName;
  if (vm.locked) {
    const lock = document.createElement('span');
    lock.className = 'tactics-chip-lock';
    lock.setAttribute('role', 'img');
    lock.setAttribute('aria-label', s.turnbarLocked());
    chip.appendChild(lock);
  }
  return chip;
}

/** The parts of the bar that survive between renders. */
interface BarParts {
  readonly round: HTMLElement;
  readonly badge: HTMLElement;
  readonly chips: HTMLElement;
}
const PARTS = new WeakMap<HTMLElement, BarParts>();

function partsOf(parent: HTMLElement): BarParts {
  const known = PARTS.get(parent);
  if (known !== undefined && known.chips.parentElement === parent) return known;
  const round = document.createElement('span');
  round.className = 'tactics-turnbar-round';
  const badge = document.createElement('span');
  badge.className = 'tactics-turnbar-badge';
  const chips = document.createElement('div');
  chips.className = 'tactics-turnbar-chips';
  parent.replaceChildren(round, badge, chips);
  const parts = { round, badge, chips };
  PARTS.set(parent, parts);
  return parts;
}

export function renderTurnBar(parent: HTMLElement, vm: TurnBarVM): void {
  const parts = partsOf(parent);
  parts.round.textContent = s.turnbarRound(vm.round);
  parts.badge.textContent = vm.badge === null ? '' : badgeText(vm.badge);
  parts.chips.replaceChildren(...vm.chips.map(paintChip), ...vm.ghosts.map(paintChip));
}
