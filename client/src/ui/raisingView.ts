// ui/raisingView.ts — thin DOM shell for the raising/inventory screen (M9c).
//
// Renders a RaisingViewModel produced by raisingModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes, no joins/filters/classification
// (those live in the model) — one-way flow only. The loop calls refresh() on
// batch-applied; the user triggers reducer intents via callbacks passed at
// construction (never called directly by this module). Coverage-excluded shell.
import type { InventoryItemViewModel, RaisingViewModel } from './raisingModel';

export interface RaisingViewCallbacks {
  /** Called when the user feeds a training item to a monster. */
  readonly onTrain: (monsterId: bigint, foodItemId: number) => void;
  /** Called when the user clicks the Care button on a monster. */
  readonly onCare: (monsterId: bigint) => void;
}

export class RaisingView {
  readonly #root: HTMLDivElement;
  readonly #monsterEl: HTMLDivElement;
  readonly #inventoryEl: HTMLDivElement;
  readonly #callbacks: RaisingViewCallbacks;
  #items: readonly InventoryItemViewModel[] = [];
  #visible = false;

  constructor(parent: HTMLElement, callbacks: RaisingViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    this.#root.style.cssText =
      'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.75);' +
      'display:none;flex-direction:column;align-items:center;padding:24px;' +
      'overflow-y:auto;font-family:monospace;color:#e0e0e0;';

    const title = document.createElement('h2');
    title.textContent = 'Raising & Inventory';
    title.style.cssText = 'margin:0 0 16px;color:#fff;';
    this.#root.appendChild(title);

    const monsterLabel = document.createElement('h3');
    monsterLabel.textContent = 'Monsters';
    monsterLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#root.appendChild(monsterLabel);

    this.#monsterEl = document.createElement('div');
    this.#monsterEl.style.cssText =
      'display:grid;grid-template-columns:repeat(2,1fr);gap:8px;width:100%;max-width:700px;margin-bottom:16px;';
    this.#root.appendChild(this.#monsterEl);

    const inventoryLabel = document.createElement('h3');
    inventoryLabel.textContent = 'Inventory';
    inventoryLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#root.appendChild(inventoryLabel);

    this.#inventoryEl = document.createElement('div');
    this.#inventoryEl.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:700px;';
    this.#root.appendChild(this.#inventoryEl);

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

  refresh(vm: RaisingViewModel): void {
    this.#items = vm.items;
    this.#renderMonsters(vm.monsters);
    this.#renderInventory(vm.items);
  }

  #renderMonsters(monsters: RaisingViewModel['monsters']): void {
    this.#monsterEl.replaceChildren();
    if (monsters.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No monsters.';
      empty.style.opacity = '0.4';
      this.#monsterEl.appendChild(empty);
      return;
    }
    for (const mon of monsters) {
      const el = document.createElement('div');
      el.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;background:#1a1a2e;';

      const nameSpan = document.createElement('div');
      nameSpan.textContent = mon.nickname;
      nameSpan.style.fontWeight = 'bold';
      el.appendChild(nameSpan);

      const info = document.createElement('div');
      info.style.cssText = 'font-size:12px;margin-top:4px;color:#ccc;';
      info.textContent = `Lv${mon.level} · Bond ${mon.bond} · HP ${mon.currentHp}/${mon.statHp}`;
      el.appendChild(info);

      const stats = document.createElement('div');
      stats.style.cssText = 'font-size:11px;margin-top:4px;color:#9ab;';
      stats.textContent =
        `ATK ${mon.statAttack} · DEF ${mon.statDefense} · SPD ${mon.statSpeed} · ` +
        `SP.ATK ${mon.statSpAttack} · SP.DEF ${mon.statSpDefense}`;
      el.appendChild(stats);

      const actions = document.createElement('div');
      actions.style.cssText = 'margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;';

      const careBtn = document.createElement('button');
      careBtn.textContent = 'Care';
      careBtn.style.cssText = 'font-size:11px;cursor:pointer;';
      careBtn.addEventListener('click', () => this.#callbacks.onCare(mon.monsterId));
      actions.appendChild(careBtn);

      for (const item of this.#items) {
        if (item.count > 0 && item.canTrain) {
          const trainBtn = document.createElement('button');
          trainBtn.textContent = `Train: ${item.name} (x${item.count})`;
          trainBtn.style.cssText = 'font-size:11px;cursor:pointer;';
          trainBtn.addEventListener('click', () =>
            this.#callbacks.onTrain(mon.monsterId, item.itemId),
          );
          actions.appendChild(trainBtn);
        }
      }
      el.appendChild(actions);

      this.#monsterEl.appendChild(el);
    }
  }

  #renderInventory(items: readonly InventoryItemViewModel[]): void {
    this.#inventoryEl.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No items.';
      empty.style.opacity = '0.4';
      this.#inventoryEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const el = document.createElement('div');
      el.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;background:#1a1a2e;';

      const nameSpan = document.createElement('div');
      nameSpan.textContent = `${item.name} (x${item.count})`;
      nameSpan.style.fontWeight = 'bold';
      el.appendChild(nameSpan);

      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:11px;margin-top:4px;color:#ccc;';
      desc.textContent = item.description;
      el.appendChild(desc);

      this.#inventoryEl.appendChild(el);
    }
  }
}
