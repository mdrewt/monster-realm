// ui/boxView.ts — thin DOM shell for the box/party screen (M6c, ADR-0014).
//
// Renders MonsterCardViewModels produced by boxModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes — one-way flow only.
// The loop calls refresh() on batch-applied; the user triggers reducer intents
// via callbacks passed at construction (never called directly by this module).
import type { MonsterCardViewModel } from './boxModel';

export interface BoxViewCallbacks {
  /** Called when the user confirms a nickname edit. */
  readonly onSetNickname: (monsterId: bigint, nickname: string) => void;
  /** Called when the user moves a monster to a party slot (0–5) or to box (255). */
  readonly onSetPartySlot: (monsterId: bigint, slot: number) => void;
  /** Called when the user clicks the Heal Party button (M7c). */
  readonly onHealParty: () => void;
}

const BOX_SLOT = 255;

export class BoxView {
  readonly #root: HTMLDivElement;
  readonly #partyEl: HTMLDivElement;
  readonly #boxEl: HTMLDivElement;
  /** Static box-vs-party explainer (ux4, ADR-0155); never toggled — it states an invariant. */
  readonly #hintEl: HTMLDivElement;
  readonly #callbacks: BoxViewCallbacks;
  #visible = false;

  constructor(parent: HTMLElement, callbacks: BoxViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    this.#root.style.cssText =
      'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.75);' +
      'display:none;flex-direction:column;align-items:center;padding:24px;' +
      'overflow-y:auto;font-family:monospace;color:#e0e0e0;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:16px;margin-bottom:16px;';
    const title = document.createElement('h2');
    title.textContent = 'Party & Box';
    title.style.cssText = 'margin:0;color:#fff;';
    header.appendChild(title);
    const healBtn = document.createElement('button');
    healBtn.textContent = 'Heal Party';
    healBtn.style.cssText =
      'padding:4px 12px;cursor:pointer;font-family:monospace;background:#2a3a2a;color:#8f8;border:1px solid #4a4;border-radius:3px;';
    healBtn.addEventListener('click', () => this.#callbacks.onHealParty());
    header.appendChild(healBtn);
    this.#root.appendChild(header);

    // ux4 (ADR-0155): a direct #root child, so it cannot be wiped by #renderParty / #renderBox,
    // which only touch #partyEl / #boxEl. A SIBLING of `header`, never wrapping it:
    // three client/e2e/recruit.spec.ts sites resolve this root as
    // h2['Party & Box'].parentElement.parentElement, and a wrapper retargets that chain.
    // The copy DESCRIBES the "To Party" button (#renderCard) rather than commanding a click —
    // the empty-box short-circuit below renders no such button in the fresh-player state.
    this.#hintEl = document.createElement('div');
    this.#hintEl.setAttribute('data-testid', 'box-party-hint');
    this.#hintEl.textContent =
      'Only monsters in your Party can battle or be swapped in. New recruits arrive in your ' +
      'Box — each box monster has a "To Party" button that moves it into an open party slot.';
    this.#hintEl.style.cssText = 'max-width:600px;margin:0 0 12px;font-size:12px;color:#aaa;';
    this.#root.appendChild(this.#hintEl);

    const partyLabel = document.createElement('h3');
    partyLabel.textContent = 'Party';
    partyLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#root.appendChild(partyLabel);

    this.#partyEl = document.createElement('div');
    this.#partyEl.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:600px;margin-bottom:16px;';
    this.#root.appendChild(this.#partyEl);

    const boxLabel = document.createElement('h3');
    boxLabel.textContent = 'Box';
    boxLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#root.appendChild(boxLabel);

    this.#boxEl = document.createElement('div');
    this.#boxEl.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:600px;';
    this.#root.appendChild(this.#boxEl);

    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  toggle(): void {
    this.#visible ? this.hide() : this.show();
  }

  show(): void {
    this.#visible = true;
    this.#root.style.display = 'flex';
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
  }

  refresh(
    partySlots: readonly (MonsterCardViewModel | null)[],
    boxMonsters: readonly MonsterCardViewModel[],
  ): void {
    this.#renderParty(partySlots);
    this.#renderBox(boxMonsters);
  }

  #renderParty(slots: readonly (MonsterCardViewModel | null)[]): void {
    this.#partyEl.replaceChildren();
    for (let i = 0; i < slots.length; i++) {
      const card = slots[i];
      const el = document.createElement('div');
      el.style.cssText =
        'border:1px solid #444;border-radius:4px;padding:8px;min-height:80px;background:#1a1a2e;';
      if (card === null) {
        el.textContent = `Slot ${i}: (empty)`;
        el.style.opacity = '0.4';
      } else {
        el.appendChild(this.#renderCard(card, true));
      }
      this.#partyEl.appendChild(el);
    }
  }

  #renderBox(monsters: readonly MonsterCardViewModel[]): void {
    this.#boxEl.replaceChildren();
    if (monsters.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No monsters in box.';
      empty.style.opacity = '0.4';
      this.#boxEl.appendChild(empty);
      return;
    }
    for (const card of monsters) {
      const el = document.createElement('div');
      el.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;background:#1a1a2e;';
      el.appendChild(this.#renderCard(card, false));
      this.#boxEl.appendChild(el);
    }
  }

  #renderCard(card: MonsterCardViewModel, inParty: boolean): HTMLDivElement {
    const wrap = document.createElement('div');

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = card.nickname || card.speciesName;
    nameSpan.style.fontWeight = 'bold';
    nameRow.appendChild(nameSpan);

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Rename';
    editBtn.style.cssText = 'font-size:11px;cursor:pointer;';
    editBtn.addEventListener('click', () => this.#promptNickname(card.monsterId, card.nickname));
    nameRow.appendChild(editBtn);
    wrap.appendChild(nameRow);

    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;margin-top:4px;color:#ccc;';
    info.textContent = `${card.speciesName} · Lv${card.level} · HP ${card.currentHp}/${card.statHp} (${card.hpPercent}%)`;
    wrap.appendChild(info);

    // EG4-8: the evolution-choice badge. Built INSIDE the card (so it is per-monster and
    // is cleared by #renderParty/#renderBox's replaceChildren), never wrapping `header`
    // and never a #root child: five client/e2e/recruit.spec.ts sites resolve the box root
    // as h2['Party & Box'].parentElement.parentElement, and those helpers scan the root's
    // text for an `HP cur/max` shape — so this copy carries NO "HP " token.
    if (card.evolutionChoicePending) {
      const badge = document.createElement('div');
      badge.setAttribute('data-testid', 'evo-choice-badge');
      badge.textContent = '★ Ready to evolve — choose a path';
      badge.style.cssText =
        'margin-top:4px;font-size:11px;color:#fbbf24;border:1px solid #fbbf24;' +
        'border-radius:3px;padding:1px 4px;display:inline-block;';
      wrap.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:6px;';
    if (inParty) {
      const toBoxBtn = document.createElement('button');
      toBoxBtn.textContent = 'To Box';
      toBoxBtn.style.cssText = 'font-size:11px;cursor:pointer;';
      toBoxBtn.addEventListener('click', () =>
        this.#callbacks.onSetPartySlot(card.monsterId, BOX_SLOT),
      );
      actions.appendChild(toBoxBtn);
    } else {
      const toPartyBtn = document.createElement('button');
      toPartyBtn.textContent = 'To Party';
      toPartyBtn.style.cssText = 'font-size:11px;cursor:pointer;';
      toPartyBtn.addEventListener('click', () =>
        this.#callbacks.onSetPartySlot(card.monsterId, -1),
      );
      actions.appendChild(toPartyBtn);
    }
    wrap.appendChild(actions);

    return wrap;
  }

  #promptNickname(monsterId: bigint, currentName: string): void {
    const name = prompt('New nickname:', currentName);
    if (name !== null && name !== currentName) {
      this.#callbacks.onSetNickname(monsterId, name);
    }
  }
}
