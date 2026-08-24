// ui/evolutionView.ts — thin DOM shell for the evolution screen (EG4, ADR-0174).
//
// Renders an EvolutionViewModel produced by evolutionModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes, no eligibility computation of its own —
// one-way flow only, and the eligibility decision is the model's (it is the SAME
// predicate game-core runs, so the shell must never re-derive or second-guess it).
// The loop calls refresh() on batch-applied; the user triggers reducer intents via
// callbacks passed at construction (never called directly by this module).
// Coverage-excluded shell.
//
// TWO RULES THIS FILE MUST NOT BREAK:
//   * `choices` is non-empty ONLY at 2+ eligible paths, so a choice control is rendered
//     from `choices` and NEVER re-derived from `paths.filter(met)`. At exactly one
//     eligible path the server auto-applies the evolution — an Evolve affordance there
//     offers the player an action that does not exist (EG4-2).
//   * Nicknames and species names are PLAYER-CONTROLLED (`set_nickname`). Every string
//     reaches the DOM through `textContent` / `createElement` — NEVER `innerHTML`.
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
import type {
  EvolutionGateViewModel,
  EvolutionMonsterViewModel,
  EvolutionPathViewModel,
  EvolutionViewModel,
} from './evolutionModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export interface EvolutionViewCallbacks {
  /** Called when the player picks one of 2+ eligible paths. The CHOSEN target species is
   *  forwarded — the client never resolves an ambiguous evolution on the player's behalf. */
  readonly onEvolve: (monsterId: bigint, toSpecies: number) => void;
}

export class EvolutionView {
  readonly #root: HTMLDivElement;
  readonly #listEl: HTMLDivElement;
  readonly #callbacks: EvolutionViewCallbacks;
  #visible = false;

  constructor(parent: HTMLElement, callbacks: EvolutionViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    this.#root.style.cssText =
      'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.8);' +
      'display:none;flex-direction:column;align-items:center;padding:24px;' +
      'overflow-y:auto;font-family:monospace;color:#e0e0e0;';

    const title = document.createElement('h2');
    title.textContent = 'Evolution';
    // m23-s4: the OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'evolution-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0 0 8px;color:#fff;';
    this.#root.appendChild(title);

    const hint = document.createElement('p');
    hint.textContent =
      'Each path lists what it needs and how close this monster is. When two or more ' +
      'paths are ready at once, you choose which one to take.';
    hint.style.cssText = 'margin:0 0 16px;color:#aaa;font-size:0.85em;max-width:700px;';
    this.#root.appendChild(hint);

    this.#listEl = document.createElement('div');
    this.#listEl.style.cssText =
      'display:grid;grid-template-columns:repeat(2,1fr);gap:8px;width:100%;max-width:700px;';
    this.#root.appendChild(this.#listEl);

    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(): void {
    // The read is hoisted above BOTH writes: this view writes `display` before `#visible`,
    // and "read the visibility source first" must hold uniformly across all five S4 files.
    const wasVisible = this.#visible;
    this.#root.style.display = 'flex';
    this.#visible = true;
    if (!wasVisible) openOverlayA11y('evolutionView', this.#root);
  }

  hide(): void {
    this.#root.style.display = 'none';
    this.#visible = false;
    closeOverlayA11y('evolutionView', null);
  }

  toggle(): void {
    if (this.#visible) this.hide();
    else this.show();
  }

  refresh(vm: EvolutionViewModel): void {
    // replaceChildren, not append: refresh() fires on EVERY batch-applied.
    this.#listEl.replaceChildren();
    if (vm.monsters.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No monsters yet.';
      empty.style.color = '#666';
      this.#listEl.appendChild(empty);
      return;
    }
    for (const mon of vm.monsters) {
      this.#listEl.appendChild(this.#renderCard(mon));
    }
  }

  #renderCard(mon: EvolutionMonsterViewModel): HTMLDivElement {
    const card = document.createElement('div');
    card.setAttribute('data-testid', 'evo-monster-card');
    card.style.cssText = 'background:#1e1e2e;border-radius:6px;padding:10px;border:1px solid #333;';

    const name = document.createElement('div');
    // Explicit check avoids falsy-coercion: an empty nickname ("") shows the species name.
    name.textContent = `${mon.nickname !== '' ? mon.nickname : mon.speciesName} (${mon.speciesName})`;
    name.style.cssText = 'font-weight:bold;margin-bottom:4px;';
    card.appendChild(name);

    // The three server-derived tiers, surfaced verbatim beside level and stage (EG4-6).
    const stats = document.createElement('div');
    stats.textContent =
      `Lv.${mon.level} · Stage ${mon.tier} · Trust ${mon.trustTier} · ` +
      `Quality time ${mon.qualityTimeTier} · Nutrition ${mon.nutritionPct}%`;
    stats.style.cssText = 'font-size:0.8em;color:#aaa;margin-bottom:6px;';
    card.appendChild(stats);

    if (mon.paths.length === 0) {
      const none = document.createElement('div');
      none.textContent = 'No evolution paths.';
      none.style.cssText = 'font-size:0.8em;color:#666;';
      card.appendChild(none);
    }
    for (const path of mon.paths) {
      card.appendChild(this.#renderPathRow(path));
    }

    // A3: informational ONLY — never a button, never clickable, never a choice control.
    if (mon.readyPathName !== null) {
      const ready = document.createElement('div');
      ready.setAttribute('data-testid', 'evo-ready-note');
      ready.textContent = `Ready — evolves into ${mon.readyPathName} on your next action.`;
      ready.style.cssText = 'margin-top:6px;font-size:0.85em;color:#34d399;';
      card.appendChild(ready);
    }

    // EG4-2: rendered from `choices`, which the model keeps empty below 2 eligible.
    if (mon.choices.length > 0) {
      const prompt = document.createElement('div');
      prompt.textContent = 'Two or more paths are ready — pick one:';
      prompt.style.cssText = 'margin-top:6px;font-size:0.85em;color:#e0e0e0;';
      card.appendChild(prompt);

      const picker = document.createElement('div');
      picker.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;';
      for (const choice of mon.choices) {
        picker.appendChild(this.#renderChoice(mon.monsterId, choice));
      }
      card.appendChild(picker);
    }

    return card;
  }

  #renderPathRow(path: EvolutionPathViewModel): HTMLDivElement {
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'evo-path-row');
    row.style.cssText =
      'margin-top:6px;padding:6px;border-radius:4px;background:#181826;' +
      `border-left:3px solid ${path.met ? '#34d399' : '#555'};`;

    const heading = document.createElement('div');
    heading.textContent = `→ ${path.toSpeciesName}`;
    heading.style.cssText = `font-size:0.85em;color:${path.met ? '#34d399' : '#ccc'};`;
    row.appendChild(heading);

    const status = document.createElement('div');
    // `unmetReason` is null exactly when the path is reachable, so this is total.
    status.textContent = path.unmetReason ?? 'All requirements met.';
    status.style.cssText = `font-size:0.75em;margin-bottom:4px;color:${path.met ? '#34d399' : '#f59e0b'};`;
    row.appendChild(status);

    for (const gate of path.gates) {
      row.appendChild(EvolutionView.#renderGateRow(gate));
    }

    return row;
  }

  /** One gate: label, the monster's CURRENT value, and the REQUIRED value. Rendering only
   *  the requirement would be the requirements panel with the progress half missing. */
  static #renderGateRow(gate: EvolutionGateViewModel): HTMLDivElement {
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'evo-gate-row');
    row.textContent = `${gate.met ? '✓' : '•'} ${gate.label}: ${gate.currentText} / ${gate.requiredText}`;
    row.style.cssText = `font-size:0.75em;color:${gate.met ? '#8fbc8f' : '#999'};`;
    return row;
  }

  #renderChoice(monsterId: bigint, choice: EvolutionPathViewModel): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.setAttribute('data-testid', 'evo-choice');
    btn.textContent = `Evolve into ${choice.toSpeciesName}`;
    btn.style.cssText =
      'padding:4px 12px;background:#059669;border:none;border-radius:4px;color:#fff;' +
      'cursor:pointer;font-size:0.85em;';
    btn.addEventListener('click', () => {
      btn.disabled = true; // debounce: re-enabled on the next server-tick refresh
      this.#callbacks.onEvolve(monsterId, choice.toSpecies);
    });
    return btn;
  }
}
