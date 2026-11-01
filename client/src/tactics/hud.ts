// tactics/hud.ts — the per-side info boxes (BT10.2): one compact row per unit (name, level, HP,
// affinity), the hovered-or-targeted unit's row expanded with its status / Guard / First Stand /
// role / stance chips, and the ACTIVE unit's six action-point pips with drafted spend blinking.
//
// `infoBoxes` is pure (no DOM); `renderInfoBoxes` paints a view-model with createElement +
// textContent only. Every word comes from tactics/strings.ts.
import type { Stance, StatusTag, TacticalUnit } from './boardModel';
import * as s from './strings';

export const AP_PIPS = 6;
export type PipState = 'full' | 'drafted' | 'spent';
export interface InfoRowVM {
  readonly unitId: number;
  readonly name: string;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly affinity: string;
  readonly mine: boolean;
  readonly fainted: boolean;
  readonly expanded: null | {
    readonly status: StatusTag | null;
    readonly guard: boolean;
    readonly firstStand: boolean;
    readonly role: string | null;
    readonly stance: Stance | null;
  };
  readonly pips: null | readonly PipState[];
}
export interface InfoBoxesVM {
  readonly own: readonly InfoRowVM[];
  readonly foe: readonly InfoRowVM[];
}

/** pips[i]: i < ap-drafted -> full; i < ap -> drafted; else spent (drafted clamped to [0, ap]). */
function pipStates(ap: number, draftedAp: number): PipState[] {
  const have = Math.max(0, ap);
  const drafted = Math.min(Math.max(0, draftedAp), have);
  const pips: PipState[] = [];
  for (let i = 0; i < AP_PIPS; i++) {
    if (i < have - drafted) pips.push('full');
    else if (i < have) pips.push('drafted');
    else pips.push('spent');
  }
  return pips;
}

export function infoBoxes(
  units: readonly TacticalUnit[],
  o: {
    readonly activeUnitId: number | null;
    readonly focusUnitId: number | null;
    readonly draftedAp: number;
  },
): InfoBoxesVM {
  const own: InfoRowVM[] = [];
  const foe: InfoRowVM[] = [];
  for (const u of units) {
    const row: InfoRowVM = {
      unitId: u.unitId,
      name: u.speciesName,
      level: u.level,
      hp: u.curHp,
      maxHp: u.maxHp,
      affinity: u.affinity,
      mine: u.mine,
      fainted: u.state === 'Fainted',
      expanded:
        o.focusUnitId === u.unitId
          ? {
              status: u.status,
              guard: u.guard,
              firstStand: u.firstStand,
              role: u.role,
              stance: u.stance,
            }
          : null,
      pips:
        o.activeUnitId === u.unitId && u.state === 'Active' ? pipStates(u.ap, o.draftedAp) : null,
    };
    (u.mine ? own : foe).push(row);
  }
  return { own, foe };
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(kind: string, text: string): HTMLElement {
  return el('span', `tactics-chip tactics-chip--${kind}`, text);
}

const isLive = (p: PipState): boolean => p !== 'spent';

function paintRow(vm: InfoRowVM): HTMLElement {
  const row = el('li', 'tactics-info-row');
  row.setAttribute('data-unit-id', String(vm.unitId));
  if (vm.fainted) row.classList.add('tactics-info-row--fainted');
  if (vm.expanded !== null) row.classList.add('tactics-info-row--expanded');

  row.appendChild(el('span', 'tactics-info-name', vm.name));
  row.appendChild(el('span', 'tactics-info-level', s.hudLevel(vm.level)));
  row.appendChild(el('span', 'tactics-info-hp', s.hudHp(vm.hp, vm.maxHp)));
  row.appendChild(el('span', 'tactics-info-affinity', vm.affinity));

  const x = vm.expanded;
  if (x !== null) {
    const chips = el('span', 'tactics-info-chips');
    if (x.status !== null) chips.appendChild(chip('status', s.statusLabel(x.status)));
    if (x.guard) chips.appendChild(chip('guard', s.hudGuard()));
    if (x.firstStand) chips.appendChild(chip('first-stand', s.hudFirstStand()));
    if (x.role !== null) chips.appendChild(chip('role', s.hudRole(x.role)));
    if (x.stance !== null) chips.appendChild(chip('stance', s.stanceLabel(x.stance)));
    row.appendChild(chips);
  }

  const pips = vm.pips;
  if (pips !== null) {
    const bar = el('span', 'tactics-pips');
    bar.setAttribute('role', 'group');
    // The AP count is the pips that are not spent, out of AP_PIPS.
    const apLeft = pips.filter(isLive).length;
    bar.setAttribute('aria-label', s.hudAp(apLeft, AP_PIPS));
    for (const state of pips) {
      const pip = el('span', `tactics-pip tactics-pip--${state}`);
      if (state === 'drafted') pip.classList.add('tactics-blink');
      bar.appendChild(pip);
    }
    row.appendChild(bar);
  }
  return row;
}

const OWN_BOX = 'tactics-info tactics-info--own';
const FOE_BOX = 'tactics-info tactics-info--foe';

function paintBox(className: string, rows: readonly InfoRowVM[]): HTMLElement {
  const box = el('ul', className);
  for (const r of rows) box.appendChild(paintRow(r));
  return box;
}

/** Repaints the own and foe boxes into `parent` (replacing what a previous call painted). */
export function renderInfoBoxes(parent: HTMLElement, vm: InfoBoxesVM): void {
  const own = paintBox(OWN_BOX, vm.own);
  const foe = paintBox(FOE_BOX, vm.foe);
  parent.replaceChildren(own, foe);
}
