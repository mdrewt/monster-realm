// tactics/results.ts — the Finished-phase results panel (bt-12: BT12.4): the per-monster XP and
// essence lines, the recruits, the player's gold total and the outcome, folded from the transcript's
// `Awards` / `RecruitResult` events; skippable (Continue) and auto-advanced by main.ts through
// `shouldAutoContinue` (ui/battlePolicy.ts) on the frame clock — this panel keeps no clock. A
// constructed overlay root on the shared `battleView` overlay id (the ui/battleView.ts header's a11y
// wiring; main.ts keeps the battle views mutually exclusive). Compute-then-write: an equal VM writes
// no DOM, so a focused Continue keeps its focus across a batch; the list and the button are built once.
import type { StoreBattleEvent, StoreBattleUnit } from '../net/store';
import { structurallyEqual } from '../ui/battlePolicy';
import { closeOverlayA11y, openOverlayA11y } from '../ui/overlayA11y';
import * as s from './strings';
import type { RuleSide } from './wasm';

export type ResultsOutcome = 'won' | 'lost' | 'fled';

export interface ResultsInput {
  readonly battleId: bigint;
  /** The RAW anchor's terminal outcome (`store.latestPlayerBattle(identity).outcome`). */
  readonly outcome: string;
  /** The RAW anchor's side for this player: `playerIdentity === identity ? 'A' : 'B'`. */
  readonly mySide: RuleSide;
  readonly units: readonly StoreBattleUnit[];
  readonly events: readonly StoreBattleEvent[];
  readonly monsterName: (monsterId: bigint) => string;
  readonly speciesName: (speciesId: number) => string;
}
export interface ResultsVM {
  readonly battleId: bigint;
  readonly outcome: ResultsOutcome;
  /** One line per own `Awards` event in event order (XP and essence; gold is per PLAYER). */
  readonly monsters: readonly {
    readonly unitId: number;
    readonly name: string;
    readonly xp: number;
    readonly essence: number;
  }[];
  /** One line per successful own `RecruitResult`, named by the TARGET's species. */
  readonly recruits: readonly { readonly unitId: number; readonly name: string }[];
  /** The bigint SUM of `currency` over every `Awards` event (never a unit-0 lookup). */
  readonly currency: bigint;
}

function outcomeFor(outcome: string, mySide: RuleSide): ResultsOutcome | null {
  switch (outcome) {
    case 'SideAWins':
      return mySide === 'A' ? 'won' : 'lost';
    case 'SideBWins':
      return mySide === 'B' ? 'won' : 'lost';
    case 'Fled':
      return 'fled';
    default:
      return null;
  }
}

/** null unless `outcome` is terminal (`SideAWins` / `SideBWins` / `Fled`). */
export function resultsVM(input: ResultsInput): ResultsVM | null {
  const outcome = outcomeFor(input.outcome, input.mySide);
  if (outcome === null) return null;
  const unitOf = (id: number): StoreBattleUnit | undefined =>
    input.units.find((u) => u.unitId === id);
  const mine = (id: number): StoreBattleUnit | undefined => {
    const u = unitOf(id);
    return u !== undefined && u.row.side === input.mySide ? u : undefined;
  };
  const monsters: ResultsVM['monsters'][number][] = [];
  const recruits: ResultsVM['recruits'][number][] = [];
  let currency = 0n;
  for (const ev of input.events) {
    const payload = ev.payload;
    switch (payload.tag) {
      case 'Awards': {
        currency += payload.value.currency;
        const u = mine(payload.value.unit);
        if (u !== undefined && u.monsterId !== null) {
          monsters.push({
            unitId: u.unitId,
            name: input.monsterName(u.monsterId),
            xp: payload.value.xp,
            essence: payload.value.essence,
          });
        }
        break;
      }
      case 'RecruitResult': {
        if (!payload.value.success || mine(payload.value.unit) === undefined) break;
        const target = unitOf(payload.value.target);
        if (target === undefined) break;
        recruits.push({ unitId: target.unitId, name: input.speciesName(target.row.species_id) });
        break;
      }
      case 'Executed':
      case 'Missed':
      case 'PlanHalted':
      case 'QueueVoided':
      case 'AutoPass':
      case 'StoodGround':
      case 'Status':
      case 'Surge':
      case 'Ko':
      case 'Moved':
      case 'ItemUsed':
      case 'TurnEnded':
      case 'RoundEnded':
      case 'BattleStarted':
      case 'BattleEnd':
        break;
      default:
        // An event kind this client does not know is not a results line (never a throw).
        payload satisfies never;
        break;
    }
  }
  return { battleId: input.battleId, outcome, monsters, recruits, currency };
}

export interface ResultsPanelDeps {
  /** The Continue control: main.ts pops the outcome frame (only while it is the top frame). */
  readonly onContinue: () => void;
}

function line(kind: 'monster' | 'recruit' | 'currency' | 'none', text: string): HTMLElement {
  const li = document.createElement('li');
  li.className = 'tactics-results-line';
  li.setAttribute('data-line', kind);
  li.textContent = text;
  return li;
}

export class ResultsPanel {
  readonly #root: HTMLElement;
  readonly #titleEl: HTMLElement;
  readonly #listEl: HTMLElement;
  readonly #continueEl: HTMLButtonElement;
  #visible = false;
  #vm: ResultsVM | null = null;

  constructor(parent: HTMLElement, deps: ResultsPanelDeps) {
    this.#root = document.createElement('div');
    this.#root.className = 'mr-frame mr-shell mr-shell--top mr-shell--battle tactics-results';
    this.#root.style.display = 'none';
    this.#titleEl = document.createElement('h2');
    this.#titleEl.className = 'tactics-title';
    this.#titleEl.setAttribute('data-testid', 'battle-title');
    this.#titleEl.setAttribute('tabindex', '-1');
    this.#listEl = document.createElement('ul');
    this.#listEl.className = 'tactics-results-list';
    this.#continueEl = document.createElement('button');
    this.#continueEl.type = 'button';
    this.#continueEl.className = 'tactics-results-continue';
    this.#continueEl.addEventListener('click', () => deps.onContinue());
    this.#root.append(this.#titleEl, this.#listEl, this.#continueEl);
    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** Compute-then-write; a structurally equal VM writes nothing (a focused Continue keeps focus). */
  render(vm: ResultsVM): void {
    if (this.#vm !== null && structurallyEqual(this.#vm, vm)) return;
    this.#vm = vm;
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
    closeOverlayA11y('battleView', null);
  }

  #paint(): void {
    const vm = this.#vm;
    if (vm === null) return;
    this.#titleEl.textContent = s.resultsTitle(vm.outcome);
    this.#listEl.setAttribute('aria-label', s.resultsLabel());
    const lines: HTMLElement[] = [
      ...vm.monsters.map((m) => line('monster', s.resultsMonster(m.name, m.xp, m.essence))),
      ...vm.recruits.map((r) => line('recruit', s.resultsRecruited(r.name))),
    ];
    if (vm.currency > 0n) lines.push(line('currency', s.resultsCurrency(vm.currency)));
    if (lines.length === 0) lines.push(line('none', s.resultsNone()));
    this.#listEl.replaceChildren(...lines);
    this.#continueEl.textContent = s.resultsContinue();
  }
}
