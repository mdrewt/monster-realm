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
  /**
   * Called when the player clicks Recruit (wild battles only). `baitItemId` is
   * the selected bait's id, or `undefined` for a bare attempt.
   */
  readonly onRecruit: (battleId: bigint, baitItemId: number | undefined) => void;
  /** Called when the player selects a cure item and clicks Use Item. */
  readonly onUseItem: (battleId: bigint, itemId: number) => void;
}

export class BattleView {
  readonly #root: HTMLDivElement;
  readonly #weatherEl: HTMLDivElement;
  readonly #playerCardEl: HTMLDivElement;
  readonly #opponentCardEl: HTMLDivElement;
  readonly #skillsEl: HTMLDivElement;
  readonly #actionsEl: HTMLDivElement;
  readonly #outcomeEl: HTMLDivElement;
  readonly #callbacks: BattleViewCallbacks;
  /** The bait `<select>` for the current recruit render (null when not wild). */
  #baitSelectEl: HTMLSelectElement | null = null;
  /** The cure-item `<select>` for the current battle render (null when no cure items). */
  #cureSelectEl: HTMLSelectElement | null = null;
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

    // Weather banner (field-state banner; hidden by default — shown when weather is active)
    this.#weatherEl = document.createElement('div');
    this.#weatherEl.setAttribute('data-testid', 'weather-banner');
    this.#weatherEl.style.cssText =
      'width:100%;max-width:320px;text-align:center;padding:4px 8px;margin-bottom:8px;' +
      'border-radius:3px;background:#334;color:#aaf;font-size:12px;font-weight:bold;display:none;';
    this.#root.appendChild(this.#weatherEl);

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
    this.#outcomeEl.setAttribute('data-testid', 'outcome-text');
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
      this.#weatherEl.style.display = 'none';
      this.#weatherEl.textContent = '';
      this.hide();
      return;
    }
    if (!this.#visible) this.show();

    this.#renderWeather(vm);
    this.#renderMonsterCard(this.#opponentCardEl, vm.opponentCard, 'Opponent');
    this.#renderMonsterCard(this.#playerCardEl, vm.playerCard, 'You');
    this.#renderSkills(vm);
    this.#renderActions(vm);
    this.#renderOutcome(vm);
  }

  #renderWeather(vm: BattleViewModel): void {
    const w = vm.weather;
    if (w == null) {
      this.#weatherEl.style.display = 'none';
      this.#weatherEl.textContent = '';
      return;
    }
    this.#weatherEl.style.display = 'block';
    this.#weatherEl.textContent = `${w.label} (${w.turnsRemaining} turns)`;
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

    if (card.status) {
      const statusEl = document.createElement('div');
      statusEl.style.cssText =
        'display:inline-block;margin-top:4px;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:bold;background:#553;color:#ff9;';
      statusEl.textContent = card.status;
      el.appendChild(statusEl);
    }
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
    // Save user selections BEFORE tearing down the DOM (e-1: replaceChildren
    // destroys <select> elements, resetting their values on every server tick).
    // The restore runs only on VMs that differ (shouldSkipBattleRefresh suppresses equal-VM
    // refreshes) and remains essential for genuine data changes.
    const savedBait = this.#baitSelectEl?.value ?? '';
    const savedCure = this.#cureSelectEl?.value ?? '';
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
    // Recruit is wild-only (canRecruit). Render the bait selector first so the
    // Recruit button can read the current selection at click time.
    this.#baitSelectEl = null;
    if (vm.canRecruit) {
      this.#renderRecruit(vm);
      // Restore prior selection so unrelated batch ticks don't reset the user's choice.
      // Cast breaks TypeScript's narrowing chain (TS tracks #baitSelectEl=null from above
      // through the method call; the cast re-opens the full union type for the null guard).
      if (savedBait !== '') {
        const baitSel = this.#baitSelectEl as HTMLSelectElement | null;
        if (baitSel !== null) baitSel.value = savedBait;
      }
    }
    // Cure items: available in any ongoing battle (not gated on wild/recruit).
    // cureItems is [] when not ongoing, so length is the sole render condition.
    this.#cureSelectEl = null;
    if (vm.cureItems.length > 0) {
      this.#renderCureItems(vm);
      // Restore prior selection (same save/restore pattern as bait selector above).
      if (savedCure !== '') {
        const cureSel = this.#cureSelectEl as HTMLSelectElement | null;
        if (cureSel !== null) cureSel.value = savedCure;
      }
    }
  }

  #renderRecruit(vm: BattleViewModel): void {
    // Bait selector: classify-by-data — each option carries its recruit_bonus on
    // a data attribute; the first option is "No bait" (a bare attempt).
    const select = document.createElement('select');
    select.setAttribute('data-testid', 'bait-selector');
    select.style.cssText =
      'padding:6px 8px;font-family:monospace;font-size:12px;background:#222;' +
      'color:#e0e0e0;border:1px solid #686;border-radius:3px;';

    const noBait = document.createElement('option');
    noBait.value = '';
    noBait.textContent = 'No bait';
    select.appendChild(noBait);

    for (const bait of vm.baitOptions) {
      const opt = document.createElement('option');
      opt.value = String(bait.itemId);
      opt.textContent = `${bait.name} (+${bait.recruitBonus}‰) ×${bait.count}`;
      // data-recruit-bonus is the classify-by-data contract surface (ADR-0047).
      opt.setAttribute('data-recruit-bonus', String(bait.recruitBonus));
      select.appendChild(opt);
    }
    this.#baitSelectEl = select;
    this.#actionsEl.appendChild(select);

    const recruitBtn = document.createElement('button');
    recruitBtn.setAttribute('data-testid', 'recruit-action');
    recruitBtn.style.cssText =
      'padding:6px 12px;cursor:pointer;font-family:monospace;background:#2a3a2a;' +
      'color:#e0e0e0;border:1px solid #6a6;border-radius:3px;';
    recruitBtn.textContent = 'Recruit';
    recruitBtn.addEventListener('click', () => {
      const raw = this.#baitSelectEl?.value ?? '';
      const baitItemId = raw === '' ? undefined : Number(raw);
      this.#callbacks.onRecruit(vm.battleId, baitItemId);
    });
    this.#actionsEl.appendChild(recruitBtn);
  }

  #renderCureItems(vm: BattleViewModel): void {
    // Cure-item selector: classify-by-data — each option carries data-cure-status so
    // the DOM exposes the classification contract (ADR-0047). No "bare" option (unlike
    // bait's "No bait") — clicking Use Item with empty selection is a no-op.
    const select = document.createElement('select');
    select.setAttribute('data-testid', 'cure-item-selector');
    select.style.cssText =
      'padding:6px 8px;font-family:monospace;font-size:12px;background:#222;' +
      'color:#e0e0e0;border:1px solid #886;border-radius:3px;';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select item';
    select.appendChild(placeholder);

    for (const item of vm.cureItems) {
      const opt = document.createElement('option');
      opt.value = String(item.itemId);
      opt.textContent = `${item.name} (cures ${item.cureStatus}) ×${item.count}`;
      opt.setAttribute('data-cure-status', item.cureStatus);
      select.appendChild(opt);
    }
    this.#cureSelectEl = select;
    this.#actionsEl.appendChild(select);

    const useBtn = document.createElement('button');
    useBtn.setAttribute('data-testid', 'use-item-action');
    useBtn.style.cssText =
      'padding:6px 12px;cursor:pointer;font-family:monospace;background:#3a3a2a;' +
      'color:#e0e0e0;border:1px solid #886;border-radius:3px;';
    useBtn.textContent = 'Use Item';
    useBtn.addEventListener('click', () => {
      const raw = this.#cureSelectEl?.value ?? '';
      // No bare use — clicking with empty selection is a no-op (no undefined variant).
      if (raw !== '') {
        this.#callbacks.onUseItem(vm.battleId, Number(raw));
      }
    });
    this.#actionsEl.appendChild(useBtn);
  }

  #renderSwapButtons(vm: BattleViewModel): void {
    for (const member of vm.bench) {
      const btn = document.createElement('button');
      btn.style.cssText =
        'padding:6px 12px;cursor:pointer;font-family:monospace;background:#2a2a3a;' +
        'color:#e0e0e0;border:1px solid #448;border-radius:3px;';
      btn.textContent = `Swap: ${member.speciesName} (${member.currentHp}/${member.maxHp})`;
      btn.addEventListener('click', () => this.#callbacks.onSwap(vm.battleId, member.teamIndex));
      this.#actionsEl.appendChild(btn);
    }
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
      default: {
        // Exhaustiveness check: vm.outcome is BattleOutcomeTag, so the union is
        // fully covered above. This arm is genuinely unreachable — unknown outcomes
        // are rejected by buildBattleViewModel (null return) before reaching the view.
        const _exhaustive: never = vm.outcome;
        text = '';
        void _exhaustive;
      }
    }
    this.#outcomeEl.textContent = text;
  }
}
