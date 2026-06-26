// ui/battleView.ts — thin DOM shell for the battle screen (M7c, ADR-0014).
//
// Renders BattleViewModels produced by battleModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes — one-way flow only.
// The loop calls refresh() on batch-applied; the user triggers reducer intents
// via callbacks passed at construction (never called directly by this module).
import type { BattleMonsterCardVM, BattleViewModel } from './battleModel';

export interface BattleViewCallbacks {
  /** Called when the player selects a skill to attack with. */
  readonly onAttack: (battleId: bigint, skillId: number) => void;
  /** Called when the player clicks the Flee button. */
  readonly onFlee: (battleId: bigint) => void;
  /** Called when the player selects a team member to swap to. */
  readonly onSwap: (battleId: bigint, teamIndex: number) => void;
}

export class BattleView {
  readonly #root: HTMLDivElement;
  readonly #playerCardEl: HTMLDivElement;
  readonly #opponentCardEl: HTMLDivElement;
  readonly #skillsEl: HTMLDivElement;
  readonly #actionsEl: HTMLDivElement;
  readonly #outcomeEl: HTMLDivElement;
  readonly #callbacks: BattleViewCallbacks;
  #visible = false;

  constructor(parent: HTMLElement, callbacks: BattleViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    this.#root.style.cssText =
      'position:fixed;inset:0;z-index:110;background:rgba(0,0,0,0.85);' +
      'display:none;flex-direction:column;align-items:center;justify-content:center;' +
      'padding:24px;font-family:monospace;color:#e0e0e0;';

    const title = document.createElement('h2');
    title.textContent = 'Battle';
    title.style.cssText = 'margin:0 0 16px;color:#fff;';
    this.#root.appendChild(title);

    // Opponent card (top)
    this.#opponentCardEl = document.createElement('div');
    this.#opponentCardEl.style.cssText =
      'border:1px solid #844;border-radius:4px;padding:8px;width:100%;max-width:320px;' +
      'background:#2a1a1a;margin-bottom:12px;';
    this.#root.appendChild(this.#opponentCardEl);

    // Player card (bottom)
    this.#playerCardEl = document.createElement('div');
    this.#playerCardEl.style.cssText =
      'border:1px solid #484;border-radius:4px;padding:8px;width:100%;max-width:320px;' +
      'background:#1a2a1a;margin-bottom:12px;';
    this.#root.appendChild(this.#playerCardEl);

    // Skills grid
    this.#skillsEl = document.createElement('div');
    this.#skillsEl.style.cssText =
      'display:grid;grid-template-columns:1fr 1fr;gap:6px;width:100%;max-width:320px;margin-bottom:12px;';
    this.#root.appendChild(this.#skillsEl);

    // Action buttons (flee/swap)
    this.#actionsEl = document.createElement('div');
    this.#actionsEl.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    this.#root.appendChild(this.#actionsEl);

    // Outcome banner
    this.#outcomeEl = document.createElement('div');
    this.#outcomeEl.style.cssText = 'font-size:18px;font-weight:bold;color:#ffd700;display:none;';
    this.#root.appendChild(this.#outcomeEl);

    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(): void {
    this.#visible = true;
    this.#root.style.display = 'flex';
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
  }

  refresh(vm: BattleViewModel | null): void {
    if (!vm) {
      this.hide();
      return;
    }
    if (!this.#visible) this.show();

    this.#renderMonsterCard(this.#opponentCardEl, vm.opponentCard, 'Opponent');
    this.#renderMonsterCard(this.#playerCardEl, vm.playerCard, 'You');
    this.#renderSkills(vm);
    this.#renderActions(vm);
    this.#renderOutcome(vm);
  }

  #renderMonsterCard(el: HTMLDivElement, card: BattleMonsterCardVM, label: string): void {
    el.replaceChildren();
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;';
    const nameSpan = document.createElement('span');
    nameSpan.style.fontWeight = 'bold';
    nameSpan.textContent = `${label}: ${card.speciesName}`;
    header.appendChild(nameSpan);
    const lvSpan = document.createElement('span');
    lvSpan.textContent = `Lv${card.level}`;
    header.appendChild(lvSpan);
    el.appendChild(header);

    const hpBar = document.createElement('div');
    hpBar.style.cssText =
      'margin-top:4px;background:#333;border-radius:2px;height:12px;overflow:hidden;';
    const hpFill = document.createElement('div');
    const pct = card.hpPercent;
    const color = pct > 50 ? '#4a4' : pct > 20 ? '#aa4' : '#a44';
    hpFill.style.cssText = `width:${pct}%;height:100%;background:${color};transition:width 0.3s;`;
    hpBar.appendChild(hpFill);
    el.appendChild(hpBar);

    const hpText = document.createElement('div');
    hpText.style.cssText = 'font-size:11px;margin-top:2px;color:#aaa;';
    hpText.textContent = `HP ${card.currentHp}/${card.maxHp} · ${card.affinity}`;
    el.appendChild(hpText);
  }

  #renderSkills(vm: BattleViewModel): void {
    this.#skillsEl.replaceChildren();
    const ongoing = vm.outcome === 'Ongoing';
    if (!ongoing || vm.skills.length === 0) return;

    for (const skill of vm.skills) {
      const btn = document.createElement('button');
      btn.style.cssText =
        'padding:6px 8px;cursor:pointer;font-family:monospace;font-size:12px;' +
        'border:1px solid #666;border-radius:3px;background:#2a2a3e;color:#e0e0e0;';
      btn.textContent = `${skill.name} (${skill.power})`;
      btn.title = `${skill.affinity} · Acc ${skill.accuracy}%`;
      btn.addEventListener('click', () => this.#callbacks.onAttack(vm.battleId, skill.id));
      this.#skillsEl.appendChild(btn);
    }
  }

  #renderActions(vm: BattleViewModel): void {
    this.#actionsEl.replaceChildren();
    if (vm.canFlee) {
      const fleeBtn = document.createElement('button');
      fleeBtn.style.cssText =
        'padding:6px 12px;cursor:pointer;font-family:monospace;background:#3a2a2a;' +
        'color:#e0e0e0;border:1px solid #844;border-radius:3px;';
      fleeBtn.textContent = 'Flee';
      fleeBtn.addEventListener('click', () => this.#callbacks.onFlee(vm.battleId));
      this.#actionsEl.appendChild(fleeBtn);
    }
    if (vm.canSwap) {
      this.#renderSwapButtons(vm);
    }
  }

  #renderSwapButtons(vm: BattleViewModel): void {
    // Swap is handled outside skills — we don't have the full team in the VM,
    // but the BattleViewModel already computed canSwap. For swap, the player
    // needs to pick which team index to swap to. We'll show a "Swap" button
    // that prompts for the team index. In a full UI this would be a sub-menu,
    // but for the M7c MVP we use a simple prompt.
    const swapBtn = document.createElement('button');
    swapBtn.style.cssText =
      'padding:6px 12px;cursor:pointer;font-family:monospace;background:#2a2a3a;' +
      'color:#e0e0e0;border:1px solid #448;border-radius:3px;';
    swapBtn.textContent = 'Swap';
    swapBtn.addEventListener('click', () => {
      const input = prompt('Enter team index to swap to (0-based):');
      if (input !== null) {
        const idx = parseInt(input, 10);
        if (!Number.isNaN(idx) && idx >= 0) {
          this.#callbacks.onSwap(vm.battleId, idx);
        }
      }
    });
    this.#actionsEl.appendChild(swapBtn);
  }

  #renderOutcome(vm: BattleViewModel): void {
    if (vm.outcome === 'Ongoing') {
      this.#outcomeEl.style.display = 'none';
      return;
    }
    this.#outcomeEl.style.display = 'block';
    let text: string;
    switch (vm.outcome) {
      case 'SideAWins':
        text = 'Victory!';
        break;
      case 'SideBWins':
        text = 'Defeat...';
        break;
      case 'Fled':
        text = 'Got away safely!';
        break;
      default:
        text = `Battle ended: ${vm.outcome}`;
    }
    this.#outcomeEl.textContent = text;
  }
}
