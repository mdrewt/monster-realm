// tactics/deployPanel.ts — the wild pack ≥ 2 confirm screen and the formation editor (bt-12: BT12.2,
// BT12.3). A constructed overlay root (the ui/battleView.ts header's a11y wiring: the root is
// `document.createElement`'d here, every ARIA attribute on it comes from `openOverlayA11y`, `wasVisible`
// is the FIRST statement of `show()`, `hide()` calls `closeOverlayA11y` unguarded, the open is the LAST
// statement of the open path). It shares the `battleView` overlay id with the 1v1 view, the tactical
// shell and the results panel; main.ts keeps them mutually exclusive (`hideOtherBattleViews`).
//
// Pure first: `resolveFormation` (the remembered-formation rule), `deployVM` (the conscious party and
// the resolved formation) and `picksOf` (the `deploy_units` picks). The shell keeps the mode, the
// cursor (by row KEY), the candidate (by monster id, never by index), the editor's assignment and the
// in-flight lock (a TOKEN: a settle after hide() or after a new battle compares its token and touches
// nothing). Every paint is compute-then-write; a structurally equal VM writes no DOM.
import type { DeployPick } from '../module_bindings/types';
import { structurallyEqual } from '../ui/battlePolicy';
import type { HintDeploy } from '../ui/hintBarModel';
import { closeOverlayA11y, openOverlayA11y } from '../ui/overlayA11y';
import type { BattleOp, BattleOpsView } from '../ui/screens/battleScreen';
import * as s from './strings';

/** One party monster as the panel shows it (the nickname, else the species name, else `#id`). */
export interface DeployMonster {
  readonly monsterId: bigint;
  readonly name: string;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
}
/** One party member in party order, with the 0-HP gate already judged (`conscious` ⇔ hp > 0). */
export interface PartyMember {
  readonly monsterId: bigint;
  readonly conscious: boolean;
}

/** Mirror of server-module/src/tactics.rs `resolve_formation` (R-bt-8-FORMATIONRULE stays open — a
 *  DISCLOSED deviation from "rules out" until the continuation exports it from client-wasm; the server
 *  validates every pick): the distinct remembered ids that are in the party AND conscious, in
 *  remembered order, then the conscious party members in party order not already chosen, up to `cap`.
 *  Ids compare as bigints (2^53 and 2^53 + 1 are two monsters). */
export function resolveFormation(
  remembered: readonly bigint[],
  partyInOrder: readonly PartyMember[],
  cap: number,
): bigint[] {
  const out: bigint[] = [];
  const conscious = (id: bigint): boolean =>
    partyInOrder.some((m) => m.monsterId === id && m.conscious);
  for (const id of remembered) {
    if (out.length >= cap) break;
    if (out.includes(id)) continue;
    if (conscious(id)) out.push(id);
  }
  for (const m of partyInOrder) {
    if (out.length >= cap) break;
    if (m.conscious && !out.includes(m.monsterId)) out.push(m.monsterId);
  }
  return out;
}

/** One wild of the pack as the confirm screen lists it (bt-12 B, BT12.2: the anchor's `sideB.team`). */
export interface DeployWild {
  readonly speciesId: number;
  readonly name: string;
  readonly level: number;
}
export interface DeployInput {
  readonly battleId: bigint;
  /** The anchor's `partyMonsterIds` order joined with the own monster rows (a member with no own
   *  row is dropped). */
  readonly party: readonly DeployMonster[];
  /** `store.ownFormation(identity)?.monsterIds ?? []`. */
  readonly remembered: readonly bigint[];
  /** `min(tuning.max_pack, rules.map(mapId).spawn_a.length)` — never a literal. */
  readonly slotCount: number;
  /** The pack in `wild_index` order — the anchor's `sideB.team` (the server seats every wild there). */
  readonly wilds: readonly DeployWild[];
}
export interface DeployVM {
  readonly battleId: bigint;
  /** hp > 0 only, party order — a fainted monster is NEVER listed. */
  readonly candidates: readonly DeployMonster[];
  /** Length `slotCount`; slot i holds `resolveFormation(...)[i]`'s monster, else null. */
  readonly formation: readonly (DeployMonster | null)[];
  /** The pack, in order (the composition list of the confirm screen). */
  readonly wilds: readonly DeployWild[];
}
export function deployVM(input: DeployInput): DeployVM {
  const candidates = input.party.filter((m) => m.hp > 0);
  const resolved = resolveFormation(
    input.remembered,
    input.party.map((m) => ({ monsterId: m.monsterId, conscious: m.hp > 0 })),
    input.slotCount,
  );
  const formation: (DeployMonster | null)[] = [];
  for (let i = 0; i < input.slotCount; i += 1) {
    const id = resolved[i];
    formation.push(id === undefined ? null : (candidates.find((m) => m.monsterId === id) ?? null));
  }
  // bt-12 API freeze: the composition list lands with the implementation.
  return { battleId: input.battleId, candidates, formation, wilds: [] };
}
/** The filled slots as `deploy_units` picks, ascending slot (a sparse assignment keeps its slot numbers). */
export function picksOf(slots: readonly (DeployMonster | null)[]): DeployPick[] {
  const picks: DeployPick[] = [];
  slots.forEach((m, slot) => {
    if (m !== null) picks.push({ monsterId: m.monsterId, slot });
  });
  return picks;
}

export interface DeployPanelDeps {
  /** `dispatch({ kind: 'deployUnits', … })`; the lock holds until it SETTLES (resolve or reject). */
  readonly onDeploy: (battleId: bigint, picks: readonly DeployPick[]) => Promise<void>;
}
/** `confirm`: the initial screen (rows `deploy`, `edit`); `edit`: the formation editor. */
export type DeployMode = 'confirm' | 'edit';

const CONFIRM_ROWS: readonly string[] = ['deploy', 'edit'];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The name, level and HP spans of a slot's or the candidate's monster. */
function monsterSpans(m: DeployMonster): HTMLElement[] {
  return [
    el('span', 'tactics-deploy-name', m.name),
    el('span', 'tactics-deploy-level', s.hudLevel(m.level)),
    el('span', 'tactics-deploy-hp', s.hudHp(m.hp, m.maxHp)),
  ];
}

export class DeployPanel implements BattleOpsView {
  readonly #deps: DeployPanelDeps;
  readonly #root: HTMLElement;
  readonly #titleEl: HTMLElement;

  #visible = false;
  #vm: DeployVM | null = null;
  #mode: DeployMode = 'confirm';
  /** The cursor row's KEY (`deploy` / `edit`, or `slot-<i>` / `confirm` / `back`). */
  #cursor = 'deploy';
  /** The editor's candidate, by monster id. */
  #candidate: bigint | null = null;
  /** The editor's assignment, copied from the formation when the editor opens. */
  #assignment: (DeployMonster | null)[] = [];
  /** The in-flight send's token; null when unlocked. */
  #lock: symbol | null = null;

  constructor(parent: HTMLElement, deps: DeployPanelDeps) {
    this.#deps = deps;
    this.#root = el('div', 'mr-frame mr-shell mr-shell--top mr-shell--battle tactics-deploy');
    this.#root.style.display = 'none';
    // The OVERLAY_A11Y initialFocusSelector anchor; tabindex -1 makes it programmatically focusable
    // without a permanent tab stop. Its text is resolved on every paint (the locale may switch).
    this.#titleEl = el('h2', 'tactics-title');
    this.#titleEl.setAttribute('data-testid', 'battle-title');
    this.#titleEl.setAttribute('tabindex', '-1');
    this.#root.appendChild(this.#titleEl);
    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  get mode(): DeployMode {
    return this.#mode;
  }

  /** Compute-then-write; a structurally equal VM (bigint-safe compare) writes nothing; a NEW
   *  battleId resets the mode, the cursor, the assignment and the lock. */
  render(vm: DeployVM): void {
    const prev = this.#vm;
    if (prev !== null && structurallyEqual(prev, vm)) return;
    if (prev === null || prev.battleId !== vm.battleId) {
      this.#mode = 'confirm';
      this.#cursor = 'deploy';
      this.#candidate = null;
      this.#assignment = [];
      this.#lock = null;
    } else if (this.#mode === 'edit') {
      // The edits survive a re-render with the monsters' FRESH rows; one no longer offered leaves
      // its slot.
      this.#assignment = this.#assignment.map((m) =>
        m === null ? null : (vm.candidates.find((c) => c.monsterId === m.monsterId) ?? null),
      );
      while (this.#assignment.length < vm.formation.length) this.#assignment.push(null);
      this.#assignment.length = vm.formation.length;
    }
    this.#vm = vm;
    this.#settleCursor();
    this.#paint();
  }

  show(): void {
    const wasVisible = this.#visible;
    this.#visible = true;
    this.#paint();
    this.#root.style.display = 'flex';
    if (!wasVisible) openOverlayA11y('battleView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
    // Release the in-flight lock (the tradeProposeView hide()-time precedent): a dropped link's
    // promise may never settle; a late settle compares its token and touches nothing.
    this.#lock = null;
    this.#mode = 'confirm';
    this.#cursor = 'deploy';
    this.#candidate = null;
    this.#assignment = [];
    this.#root.replaceChildren(this.#titleEl);
    closeOverlayA11y('battleView', null);
  }

  /** Which screen the hint bar describes (bt-12 B): the confirm screen or the editor. */
  hint(): HintDeploy {
    // bt-12 API freeze: the mode-aware answer lands with the implementation.
    return { deploy: 'confirm' };
  }

  /** The "Still there?" countdown (BT12.2): `n` seconds paints one `.tactics-countdown` line as the root's
   *  last child, the same value writes nothing, null removes it. Driven by main.ts's frame pump. */
  setCountdown(seconds: number | null): void {
    void seconds;
  }

  applyBattleOp(op: BattleOp): void {
    const vm = this.#vm;
    if (vm === null) return;
    if (op.kind === 'move') {
      if (op.dir === 'Up' || op.dir === 'Down') this.#moveCursor(op.dir === 'Down' ? 1 : -1);
      return;
    }
    // While a send is in flight only a move acts: nothing is sent twice, no editor opens.
    if (this.#lock !== null) return;
    if (this.#mode === 'confirm') {
      switch (op.kind) {
        case 'activate':
          if (this.#cursor === 'deploy') this.#sendPicks(picksOf(vm.formation));
          else if (this.#cursor === 'edit') this.#enterEdit();
          return;
        case 'danger':
          this.#enterEdit();
          return;
        case 'start':
        case 'cycle':
        case 'back':
          return;
        default:
          op satisfies never;
          return;
      }
    }
    switch (op.kind) {
      case 'activate':
        this.#activateEditRow();
        return;
      case 'start':
        this.#sendAssignment();
        return;
      case 'cycle':
        this.#cycle(op.dir);
        return;
      case 'back':
        this.#leaveEdit();
        return;
      case 'danger':
        return;
      default:
        op satisfies never;
        return;
    }
  }

  // --- the input model -------------------------------------------------------------------------

  #rows(): readonly string[] {
    if (this.#mode === 'confirm') return CONFIRM_ROWS;
    const slots = this.#assignment.map((_, i) => `slot-${i}`);
    return [...slots, 'confirm', 'back'];
  }

  /** The cursor and the candidate follow identity: a row or a monster no longer there falls back. */
  #settleCursor(): void {
    const rows = this.#rows();
    if (!rows.includes(this.#cursor)) this.#cursor = rows[0] ?? 'deploy';
    if (this.#mode === 'edit') {
      const vm = this.#vm;
      const offered = vm?.candidates ?? [];
      if (this.#candidate === null || !offered.some((c) => c.monsterId === this.#candidate)) {
        this.#candidate = offered[0]?.monsterId ?? null;
      }
    }
  }

  #moveCursor(step: 1 | -1): void {
    const rows = this.#rows();
    if (rows.length === 0) return;
    const at = rows.indexOf(this.#cursor);
    const next = at === -1 ? 0 : (at + step + rows.length) % rows.length;
    this.#cursor = rows[next] ?? this.#cursor;
    this.#paint();
  }

  #enterEdit(): void {
    const vm = this.#vm;
    if (vm === null) return;
    this.#mode = 'edit';
    this.#assignment = [...vm.formation];
    this.#cursor = 'slot-0';
    this.#candidate = this.#assignment[0]?.monsterId ?? vm.candidates[0]?.monsterId ?? null;
    this.#settleCursor();
    this.#paint();
  }

  #leaveEdit(): void {
    this.#mode = 'confirm';
    this.#assignment = [];
    this.#candidate = null;
    this.#cursor = 'edit';
    this.#paint();
  }

  #cycle(dir: -1 | 1): void {
    const offered = this.#vm?.candidates ?? [];
    if (offered.length === 0) return;
    const at = offered.findIndex((c) => c.monsterId === this.#candidate);
    const next = at === -1 ? 0 : (at + dir + offered.length) % offered.length;
    this.#candidate = offered[next]?.monsterId ?? null;
    this.#paint();
  }

  #activateEditRow(): void {
    const key = this.#cursor;
    if (key === 'confirm') {
      this.#sendAssignment();
      return;
    }
    if (key === 'back') {
      this.#leaveEdit();
      return;
    }
    const slot = Number(key.slice('slot-'.length));
    const candidate = this.#vm?.candidates.find((c) => c.monsterId === this.#candidate) ?? null;
    if (
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= this.#assignment.length ||
      candidate === null
    ) {
      return;
    }
    // A monster already placed swaps places with the slot's occupant, so ids stay distinct.
    const from = this.#assignment.findIndex((m) => m?.monsterId === candidate.monsterId);
    const previous = this.#assignment[slot] ?? null;
    this.#assignment[slot] = candidate;
    if (from !== -1 && from !== slot) this.#assignment[from] = previous;
    this.#paint();
  }

  #sendAssignment(): void {
    this.#sendPicks(picksOf(this.#assignment));
  }

  /** Send `picks` unless empty (nothing to deploy: no lock, no status line) or already in flight. */
  #sendPicks(picks: readonly DeployPick[]): void {
    const vm = this.#vm;
    if (vm === null || picks.length === 0 || this.#lock !== null) return;
    const lock = Symbol('deploy');
    this.#lock = lock;
    this.#paint();
    const settled = (): void => {
      // A settle after hide(), after a new battle or after a release is not this send's to act on.
      if (this.#lock !== lock) return;
      this.#lock = null;
      if (this.#visible) this.#paint();
    };
    let sent: Promise<void>;
    try {
      sent = this.#deps.onDeploy(vm.battleId, picks);
    } catch (err) {
      // A synchronous throw must not strand the lock (the panel would read "Deploying…" forever).
      settled();
      throw err;
    }
    sent.then(settled, settled);
  }

  // --- the paint --------------------------------------------------------------------------------

  #paint(): void {
    const vm = this.#vm;
    if (vm === null) return;
    const edit = this.#mode === 'edit';
    const locked = this.#lock !== null;
    const parts: HTMLElement[] = [];
    if (!edit) {
      const list = el('ul', 'tactics-deploy-formation');
      list.setAttribute('aria-label', s.deployLabel());
      vm.formation.forEach((m, i) => {
        const li = el('li', 'tactics-deploy-slot');
        li.setAttribute('data-slot', String(i));
        li.appendChild(el('span', 'tactics-deploy-slot-label', s.deploySlot(i + 1)));
        if (m === null) li.appendChild(el('span', 'tactics-deploy-empty', s.deployEmpty()));
        else li.append(...monsterSpans(m));
        list.appendChild(li);
      });
      parts.push(list);
    } else {
      const group = el('div', 'tactics-deploy-candidate');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', s.deployCandidateLabel());
      const prev = el('button', 'tactics-deploy-prev');
      prev.type = 'button';
      prev.setAttribute('aria-label', s.deployPrevMonster());
      prev.addEventListener('click', () => this.applyBattleOp({ kind: 'cycle', dir: -1 }));
      const next = el('button', 'tactics-deploy-next');
      next.type = 'button';
      next.setAttribute('aria-label', s.deployNextMonster());
      next.addEventListener('click', () => this.applyBattleOp({ kind: 'cycle', dir: 1 }));
      const candidate = vm.candidates.find((c) => c.monsterId === this.#candidate);
      group.appendChild(prev);
      if (candidate !== undefined) group.append(...monsterSpans(candidate));
      group.appendChild(next);
      parts.push(group);
    }
    const menu = el('div', 'tactics-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('tabindex', '0');
    menu.setAttribute('aria-label', s.menuLabel());
    for (const key of this.#rows()) {
      const row = el('button', 'tactics-menu-row');
      row.type = 'button';
      row.id = `tactics-deploy-row-${key}`;
      row.setAttribute('role', 'option');
      row.setAttribute('data-row', key);
      row.setAttribute('aria-selected', key === this.#cursor ? 'true' : 'false');
      if (locked) row.setAttribute('aria-disabled', 'true');
      row.appendChild(el('span', 'tactics-menu-label', this.#rowLabel(key)));
      if (key.startsWith('slot-')) {
        const m = this.#assignment[Number(key.slice('slot-'.length))] ?? null;
        if (m === null) row.appendChild(el('span', 'tactics-deploy-empty', s.deployEmpty()));
        else row.append(...monsterSpans(m));
      }
      row.addEventListener('click', () => {
        // A click moves the cursor there and presses it (the same path as the D-pad and A).
        this.#cursor = key;
        if (this.#lock !== null) {
          this.#paint();
          return;
        }
        this.applyBattleOp({ kind: 'activate' });
      });
      if (key === this.#cursor) menu.setAttribute('aria-activedescendant', row.id);
      menu.appendChild(row);
    }
    parts.push(menu);
    if (locked) parts.push(el('p', 'tactics-deploy-status', s.deploySending()));
    this.#titleEl.textContent = edit ? s.deployEdit() : s.deployTitle();
    // Where focus was before the rebuild: inside the root (the title the dialog opened on, a row or
    // a button the pointer pressed) or stranded on <body>. The rebuild destroyed any focused row.
    const active = document.activeElement;
    const focusWasOurs = active === null || active === document.body || this.#root.contains(active);
    this.#root.replaceChildren(this.#titleEl, ...parts);
    // The cursor must be heard and a click must not strand focus (the tacticsBattle.ts rule): while
    // shown, focus the listbox so its aria-activedescendant announces the cursor row.
    if (this.#visible && focusWasOurs) menu.focus({ preventScroll: true });
  }

  #rowLabel(key: string): string {
    switch (key) {
      case 'deploy':
        return s.deployDeploy();
      case 'edit':
        return s.deployEdit();
      case 'confirm':
        return s.deployConfirm();
      case 'back':
        return s.deployBack();
      default:
        return s.deploySlot(Number(key.slice('slot-'.length)) + 1);
    }
  }
}
