// ui/evolutionView.ts — thin DOM shell for the evolution/fusion screen (M10c).
//
// Renders an EvolutionViewModel produced by evolutionModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes, no eligibility/recipe computation
// (those live server-side per ADR-0019) — one-way flow only. The loop calls
// refresh() on batch-applied; the user triggers reducer intents via callbacks passed
// at construction (never called directly by this module). Coverage-excluded shell.
import type {
  EvolutionMonsterViewModel,
  EvolutionViewModel,
  FusionRecipeViewModel,
} from './evolutionModel';

export interface EvolutionViewCallbacks {
  /** Called when the user clicks Evolve on an eligible monster. */
  readonly onEvolve: (monsterId: bigint) => void;
  /** Called when the user clicks Fuse after selecting exactly two monsters. */
  readonly onFuse: (aId: bigint, bId: bigint) => void;
}

export class EvolutionView {
  readonly #root: HTMLDivElement;
  readonly #listEl: HTMLDivElement;
  readonly #fuseEl: HTMLDivElement;
  readonly #fuseBtn: HTMLButtonElement;
  readonly #fuseLabel: HTMLSpanElement;
  readonly #recipesEl: HTMLDivElement;
  readonly #callbacks: EvolutionViewCallbacks;
  // Keyed by monsterId for immediate visual refresh on selection (no server-tick wait).
  readonly #cardEls = new Map<bigint, HTMLDivElement>();
  #visible = false;
  #selected: bigint[] = [];

  constructor(parent: HTMLElement, callbacks: EvolutionViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    this.#root.style.cssText =
      'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.8);' +
      'display:none;flex-direction:column;align-items:center;padding:24px;' +
      'overflow-y:auto;font-family:monospace;color:#e0e0e0;';

    const title = document.createElement('h2');
    title.textContent = 'Evolution & Fusion';
    title.style.cssText = 'margin:0 0 8px;color:#fff;';
    this.#root.appendChild(title);

    const hint = document.createElement('p');
    hint.textContent = 'Click Evolve on eligible monsters, or select two monsters and click Fuse.';
    hint.style.cssText = 'margin:0 0 16px;color:#aaa;font-size:0.85em;';
    this.#root.appendChild(hint);

    this.#listEl = document.createElement('div');
    this.#listEl.style.cssText =
      'display:grid;grid-template-columns:repeat(2,1fr);gap:8px;width:100%;max-width:700px;margin-bottom:16px;';
    this.#root.appendChild(this.#listEl);

    this.#fuseEl = document.createElement('div');
    this.#fuseEl.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:8px;';
    this.#fuseLabel = document.createElement('span');
    this.#fuseLabel.textContent = 'Select two monsters to fuse (0/2):';
    this.#fuseLabel.style.color = '#aaa';
    this.#fuseBtn = document.createElement('button');
    this.#fuseBtn.textContent = 'Fuse';
    this.#fuseBtn.style.cssText =
      'padding:8px 20px;background:#7c3aed;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:1em;';
    this.#fuseBtn.disabled = true;
    this.#fuseBtn.addEventListener('click', () => {
      if (this.#selected.length === 2) {
        this.#callbacks.onFuse(this.#selected[0]!, this.#selected[1]!);
        this.#selected = [];
        this.#updateFuseStatus();
      }
    });
    this.#fuseEl.appendChild(this.#fuseLabel);
    this.#fuseEl.appendChild(this.#fuseBtn);
    this.#root.appendChild(this.#fuseEl);

    this.#recipesEl = document.createElement('div');
    this.#recipesEl.style.cssText = 'width:100%;max-width:700px;margin-top:8px;';
    this.#root.appendChild(this.#recipesEl);

    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(): void {
    this.#root.style.display = 'flex';
    this.#visible = true;
  }

  hide(): void {
    this.#root.style.display = 'none';
    this.#visible = false;
    this.#selected = [];
  }

  toggle(): void {
    if (this.#visible) this.hide();
    else this.show();
  }

  refresh(vm: EvolutionViewModel): void {
    this.#listEl.textContent = '';
    this.#cardEls.clear();
    if (vm.monsters.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No monsters yet.';
      empty.style.color = '#666';
      this.#listEl.appendChild(empty);
      this.#selected = [];
      this.#updateFuseStatus();
    } else {
      for (const mon of vm.monsters) {
        const card = this.#renderCard(mon);
        this.#cardEls.set(mon.monsterId, card);
        this.#listEl.appendChild(card);
      }
      // Prune stale selection entries for monsters no longer in vm.
      const ids = new Set(vm.monsters.map((m) => m.monsterId));
      this.#selected = this.#selected.filter((id) => ids.has(id));
      this.#updateFuseStatus();
    }
    this.#renderRecipes(vm.fusionRecipes);
  }

  #renderCard(mon: EvolutionMonsterViewModel): HTMLDivElement {
    const isSelected = this.#selected.includes(mon.monsterId);
    const card = document.createElement('div');
    card.style.cssText =
      `background:${isSelected ? '#1e3a5f' : '#1e1e2e'};border-radius:6px;padding:10px;` +
      `border:${isSelected ? '2px solid #7c3aed' : '1px solid #333'};cursor:pointer;`;

    const name = document.createElement('div');
    // Explicit check avoids falsy-coercion: empty nickname ("") shows species name.
    name.textContent = `${mon.nickname !== '' ? mon.nickname : mon.speciesName} (${mon.speciesName})`;
    name.style.cssText = 'font-weight:bold;margin-bottom:4px;';

    const stats = document.createElement('div');
    stats.textContent = `Lv.${mon.level}  Bond:${mon.bond}`;
    stats.style.cssText = 'font-size:0.8em;color:#aaa;margin-bottom:6px;';

    card.appendChild(name);
    card.appendChild(stats);

    if (mon.canEvolve && mon.evolvesToSpeciesName !== null) {
      const evoLine = document.createElement('div');
      evoLine.textContent = `→ ${mon.evolvesToSpeciesName}`;
      evoLine.style.cssText = 'color:#34d399;font-size:0.85em;margin-bottom:6px;';
      card.appendChild(evoLine);

      const evolveBtn = document.createElement('button');
      evolveBtn.textContent = 'Evolve';
      evolveBtn.style.cssText =
        'padding:4px 12px;background:#059669;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:0.85em;margin-right:6px;';
      evolveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        evolveBtn.disabled = true; // debounce: re-enabled on next server-tick refresh
        this.#selected = [];
        this.#updateFuseStatus();
        this.#callbacks.onEvolve(mon.monsterId);
      });
      card.appendChild(evolveBtn);
    }

    card.addEventListener('click', () => {
      this.#toggleSelect(mon.monsterId);
    });

    return card;
  }

  #renderRecipes(recipes: readonly FusionRecipeViewModel[]): void {
    this.#recipesEl.textContent = '';
    if (recipes.length === 0) return;
    const title = document.createElement('p');
    title.textContent = 'Fusion Recipes:';
    title.style.cssText = 'margin:0 0 6px;color:#aaa;font-size:0.85em;font-weight:bold;';
    this.#recipesEl.appendChild(title);
    for (const r of recipes) {
      const line = document.createElement('p');
      line.textContent = `${r.aSpeciesName} + ${r.bSpeciesName} → ${r.toSpeciesName}`;
      line.style.cssText = 'margin:0 0 4px;font-size:0.8em;color:#888;';
      this.#recipesEl.appendChild(line);
    }
  }

  #toggleSelect(monsterId: bigint): void {
    const idx = this.#selected.indexOf(monsterId);
    if (idx !== -1) {
      this.#selected.splice(idx, 1);
    } else if (this.#selected.length < 2) {
      this.#selected.push(monsterId);
    } else {
      this.#selected = [monsterId];
    }
    // Immediately refresh card visuals — don't wait for next server batch.
    for (const [id, el] of this.#cardEls) {
      const sel = this.#selected.includes(id);
      el.style.background = sel ? '#1e3a5f' : '#1e1e2e';
      el.style.border = sel ? '2px solid #7c3aed' : '1px solid #333';
    }
    this.#updateFuseStatus();
  }

  #updateFuseStatus(): void {
    this.#fuseBtn.disabled = this.#selected.length !== 2;
    this.#fuseLabel.textContent =
      this.#selected.length === 2
        ? 'Fuse selected monsters:'
        : `Select two monsters to fuse (${this.#selected.length}/2):`;
  }
}
