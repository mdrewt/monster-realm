// ui/battleView.ts — thin DOM shell for the battle screen (M7c, ADR-0014).
//
// Renders BattleViewModels produced by battleModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes — one-way flow only.
// The loop calls refresh() on batch-applied; the user triggers reducer intents
// via callbacks passed at construction (never called directly by this module).
//
// m23-s4 (M23 §2.2, ADR-0205 D1/D2/A3) — overlay a11y wiring. This view is a CONSTRUCTED shell:
// its root is `document.createElement`'d here and appended into the shared `#app` MOUNT, so unlike
// the ten static shells S3 wired it ships NO ARIA of its own from `client/index.html` — every
// attribute below comes from `openOverlayA11y`, never from a literal in this file.
//
// THE EDGE, AND WHY IT IS READ FIRST. `wasVisible` is read as the FIRST statement of `show()`,
// before any write. A re-open tears down and re-schedules `openOverlayA11y`'s deferred focus, which
// drags focus off whatever control the player had Tabbed to — invisible to every attribute
// assertion, since a re-open rewrites the same values.
//
// AND WHY THE CLOSE IS DELIBERATELY UNGUARDED. `hide()` calls `closeOverlayA11y` every time, even
// when already hidden. A guarded close reads correct and passes every other assertion while
// permanently leaking a live capture listener, a pending timer and an expiring return target
// whenever a record desynchronises from the DOM; `closeOverlayA11y` with no record is a documented
// pure no-op, so unguarded is the self-healing path. S3's red-team measured the guarded shape
// shipping 62/62 green.
//
// THE OPEN IS THE LAST STATEMENT of the open path, after the display write: in a real browser
// `.focus()` on a `display:none` node is a silent no-op, so an open-before-paint overlay announces
// itself and then never receives focus.
//
// NO CLOSE-BEFORE-OPEN. `ui/overlayA11y.ts`'s cross-slice contract (a) says the four `#app`-mounted
// views "share ONE root" and that S4 must therefore close-before-open. That is a misstatement of
// this code: each view creates its OWN root and appends it into the shared MOUNT, so there are four
// distinct roots, four distinct `OverlayId`s and four distinct records. Closing a sibling here would
// close an overlay the player still has open. Pinned by `S4-CROSS-VIEW-DISTINCT-ROOTS`.
import type { BattleMonsterCardVM, BattleViewModel } from './battleModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export interface BattleViewCallbacks {
  /** Called when the player selects a skill to attack with (PvE). */
  readonly onAttack: (battleId: bigint, skillId: number) => void;
  /** Called when the player clicks the Flee button. */
  readonly onFlee: (battleId: bigint) => void;
  /** Called when the player selects a team member to swap to (PvE). */
  readonly onSwap: (battleId: bigint, teamIndex: number) => void;
  /**
   * Called when the player clicks Recruit (wild battles only). `baitItemId` is
   * the selected bait's id, or `undefined` for a bare attempt.
   */
  readonly onRecruit: (battleId: bigint, baitItemId: number | undefined) => void;
  /** Called when the player selects a cure item and clicks Use Item. */
  readonly onUseItem: (battleId: bigint, itemId: number) => void;
  /** Called when the player submits a skill attack in a PvP battle. */
  readonly onPvpAttack: (battleId: bigint, skillId: number) => void;
  /** Called when the player submits a swap in a PvP battle. */
  readonly onPvpSwap: (battleId: bigint, teamIndex: number) => void;
}

export class BattleView {
  readonly #root: HTMLDivElement;
  readonly #weatherEl: HTMLDivElement;
  readonly #playerCardEl: HTMLDivElement;
  readonly #opponentCardEl: HTMLDivElement;
  readonly #skillsEl: HTMLDivElement;
  readonly #actionsEl: HTMLDivElement;
  /** Empty-swap explainer; shown only on an ongoing battle with no swap (ux4, ADR-0155). */
  readonly #swapHintEl: HTMLDivElement;
  readonly #outcomeEl: HTMLDivElement;
  /** PvP status banner ("Waiting for opponent…" / ""); hidden when not in PvP (m16b). */
  readonly #pvpStatusEl: HTMLDivElement;
  /** "Press Esc to continue" hint; shown only on a terminal outcome (ux1, ADR-0151). */
  readonly #continueHintEl: HTMLDivElement;
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
    // m23-s4: the OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'battle-title');
    title.setAttribute('tabindex', '-1');
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

    // ux4 (ADR-0155): explains the ABSENCE of a swap control. A SIBLING of #actionsEl — never
    // its child, since #renderActions calls #actionsEl.replaceChildren() before rendering (which
    // would detach it on the next refresh) — and never appended to the caller-supplied `parent`.
    // Copy is honesty-constrained (dead KeyB, persistent terminal overlay, zone-gated heal,
    // mutable party_slot) — ADR-0155 §3; teeth in battleView.test.ts H1. The claim is scoped
    // "in this battle" deliberately: party_slot is mutable mid-battle while sideA.team is a
    // snapshot, so an unscoped "no healthy party monster" is falsifiable — keep the scope.
    this.#swapHintEl = document.createElement('div');
    this.#swapHintEl.setAttribute('data-testid', 'battle-swap-hint');
    this.#swapHintEl.textContent =
      'No healthy party monster in this battle to swap in. ' +
      'When this battle ends, press Esc, then B for Party & Box.';
    this.#swapHintEl.style.cssText =
      'width:100%;max-width:320px;text-align:center;margin-bottom:8px;' +
      'font-size:12px;color:#aab;display:none;';
    this.#root.appendChild(this.#swapHintEl);

    // PvP status banner: "Waiting for opponent…" when pvpPendingSubmit; hidden otherwise.
    this.#pvpStatusEl = document.createElement('div');
    this.#pvpStatusEl.setAttribute('data-testid', 'pvp-status');
    this.#pvpStatusEl.style.cssText =
      'width:100%;max-width:320px;text-align:center;padding:4px 8px;margin-bottom:8px;' +
      'border-radius:3px;background:#224;color:#aaf;font-size:13px;display:none;';
    this.#root.appendChild(this.#pvpStatusEl);

    // Outcome banner
    this.#outcomeEl = document.createElement('div');
    this.#outcomeEl.setAttribute('data-testid', 'outcome-text');
    this.#outcomeEl.style.cssText = 'font-size:18px;font-weight:bold;color:#ffd700;display:none;';
    this.#root.appendChild(this.#outcomeEl);

    // ux1 (ADR-0151 D3): the battle-result exit affordance. A SIBLING of #outcomeEl — never its
    // child (#renderOutcome writes #outcomeEl.textContent, which would wipe a child every render)
    // and never merged into its text (three e2e specs use getByText('Victory!', {exact:true})).
    this.#continueHintEl = document.createElement('div');
    this.#continueHintEl.setAttribute('data-testid', 'battle-continue-hint');
    this.#continueHintEl.textContent = 'Press Esc to continue';
    this.#continueHintEl.style.cssText = 'margin-top:8px;font-size:12px;color:#aab;display:none;';
    this.#root.appendChild(this.#continueHintEl);

    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(): void {
    const wasVisible = this.#visible;
    this.#visible = true;
    this.#root.style.display = 'flex';
    if (!wasVisible) openOverlayA11y('battleView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
    closeOverlayA11y('battleView', null);
  }

  refresh(vm: BattleViewModel | null): void {
    if (!vm) {
      this.#weatherEl.style.display = 'none';
      this.#weatherEl.textContent = '';
      this.#pvpStatusEl.style.display = 'none';
      // ux1 (ADR-0151 D3): reset the hint too, per this branch's weather/pvpStatus precedent.
      this.#continueHintEl.style.display = 'none';
      // ux4 (ADR-0155): same precedent; defense-only — LIVE reset is #renderActions' 'none' arm.
      this.#swapHintEl.style.display = 'none';
      this.hide();
      return;
    }
    if (!this.#visible) this.show();

    this.#renderWeather(vm);
    // Show opponent name for PvP battles so the player knows who they are fighting.
    const opponentLabel = vm.isPvp && vm.pvpOpponentName ? `${vm.pvpOpponentName}` : 'Opponent';
    this.#renderMonsterCard(this.#opponentCardEl, vm.opponentCard, opponentLabel);
    this.#renderMonsterCard(this.#playerCardEl, vm.playerCard, 'You');
    this.#renderPvpStatus(vm);
    this.#renderSkills(vm);
    this.#renderActions(vm);
    this.#renderOutcome(vm);
  }

  #renderPvpStatus(vm: BattleViewModel): void {
    if (!vm.isPvp || vm.outcome !== 'Ongoing') {
      this.#pvpStatusEl.style.display = 'none';
      return;
    }
    if (vm.pvpPendingSubmit) {
      this.#pvpStatusEl.style.display = 'block';
      this.#pvpStatusEl.textContent = 'Waiting for opponent’s action…';
    } else {
      this.#pvpStatusEl.style.display = 'none';
    }
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
    // Hide skill buttons when pending a PvP submission (waiting for opponent — no double-send).
    if (!ongoing || vm.skills.length === 0 || vm.pvpPendingSubmit) return;

    for (const skill of vm.skills) {
      const btn = document.createElement('button');
      btn.style.cssText =
        'padding:6px 8px;cursor:pointer;font-family:monospace;font-size:12px;' +
        'border:1px solid #666;border-radius:3px;background:#2a2a3e;color:#e0e0e0;';
      // PvP: label "Submit: <name>" to distinguish from PvE "use now" semantics.
      btn.textContent = vm.isPvp ? `Submit: ${skill.name}` : `${skill.name} (${skill.power})`;
      btn.title = `${skill.affinity} · Acc ${skill.accuracy}%`;
      if (vm.isPvp) {
        btn.addEventListener('click', () => this.#callbacks.onPvpAttack(vm.battleId, skill.id));
      } else {
        btn.addEventListener('click', () => this.#callbacks.onAttack(vm.battleId, skill.id));
      }
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
    // ux4 (ADR-0155): toggled inline so the hint and the swap buttons read the SAME `vm.canSwap`
    // in the SAME method. The `Ongoing` conjunct is required — canSwap is false on EVERY terminal
    // outcome, so without it the hint would sit beside "Victory!". No isPvp branch (ADR-0151 D3).
    this.#swapHintEl.style.display = vm.outcome === 'Ongoing' && !vm.canSwap ? 'block' : 'none';
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
      // Cast breaks TypeScript's narrowing chain: TS tracks #cureSelectEl=null (line above)
      // through the method call and narrows the type to null; the cast re-opens the union.
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
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed)) {
        this.#callbacks.onUseItem(vm.battleId, parsed);
      }
    });
    this.#actionsEl.appendChild(useBtn);
  }

  #renderSwapButtons(vm: BattleViewModel): void {
    // PvP swap: skip when pvpPendingSubmit (waiting for opponent — no double-send).
    if (vm.isPvp && vm.pvpPendingSubmit) return;
    for (const member of vm.bench) {
      const btn = document.createElement('button');
      btn.style.cssText =
        'padding:6px 12px;cursor:pointer;font-family:monospace;background:#2a2a3a;' +
        'color:#e0e0e0;border:1px solid #448;border-radius:3px;';
      btn.textContent = vm.isPvp
        ? `Submit Swap: ${member.speciesName}`
        : `Swap: ${member.speciesName} (${member.currentHp}/${member.maxHp})`;
      if (vm.isPvp) {
        btn.addEventListener('click', () =>
          this.#callbacks.onPvpSwap(vm.battleId, member.teamIndex),
        );
      } else {
        btn.addEventListener('click', () => this.#callbacks.onSwap(vm.battleId, member.teamIndex));
      }
      this.#actionsEl.appendChild(btn);
    }
  }

  #renderOutcome(vm: BattleViewModel): void {
    if (vm.outcome === 'Ongoing') {
      this.#outcomeEl.style.display = 'none';
      this.#continueHintEl.style.display = 'none';
      return;
    }
    this.#outcomeEl.style.display = 'block';
    // ux1 (ADR-0151 D3): rides this existing predicate; no isPvp branch — the Escape-dismiss
    // branch (main.ts, gated only on battleView?.visible) is battle-kind-agnostic.
    this.#continueHintEl.style.display = 'block';
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
