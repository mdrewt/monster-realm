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
// m23-s9 (M23 §2.7, ADR-0253) — COLOURS AND SIZES ARE A CONTRACT, NOT DECORATION. Every colour
// below is a `var(--mr-evo-*)` token declared in `client/src/styles.css`, never a literal: a
// literal is unreachable by the sheet's `@media (prefers-contrast: more)` override, so one stray
// hex would leave that string un-recoloured for a high-contrast user. Backgrounds use the
// `background-color` LONGHAND (the shorthand hides the value from the DOM oracle). Font sizes are
// `px` like every sibling view — the old `em` sizes mis-applied WCAG's large-text threshold and
// scaled differently from the rest of the UI. Only declarations on a fixed allow-list may appear
// (no `opacity`/`filter`/`text-shadow`/… — each is a way to dim text the contrast oracle cannot
// see), and no element may carry a `class` or `id` (a stylesheet rule is the other way around
// the inline colours). All of it is measured from the rendered DOM by `evolutionView.test.ts`
// (m23s9 X1–X4), with the four fixture states named there; a new element or colour here must
// be added to those censuses in the same change.
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
// NO CLOSE-BEFORE-OPEN. `ui/overlayA11y.ts`'s cross-slice contract (a) once claimed the four
// `#app`-mounted views "share ONE root" and prescribed close-before-open; 17r-e RETRACTED it
// in place (A12, ui/overlayA11y.ts:52-54); (a) now agrees with this code: each view creates its
// OWN root under the shared MOUNT — four roots, four `OverlayId`s, four records. Closing a sibling
// here would close an overlay the player still has open. Pinned by `S4-CROSS-VIEW-DISTINCT-ROOTS`.
import type {
  EvolutionGateViewModel,
  EvolutionMonsterViewModel,
  EvolutionPathViewModel,
  EvolutionViewModel,
} from './evolutionModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export interface EvolutionViewCallbacks {
  /** Called when the player picks one of 2+ eligible paths. The CHOSEN target species is
   *  forwarded — the client never resolves an ambiguous evolution on the player's behalf.
   *  May return a promise (20r-a): the monster's choice buttons stay disabled until it
   *  settles and are re-enabled in `.finally()` — on rejection too, without waiting for
   *  an unrelated batch. A `=> void` type would let a future implementation silently reduce
   *  that to a one-microtask debounce (see raisingView's onCare for the same argument). */
  readonly onEvolve: (monsterId: bigint, toSpecies: number) => void | Promise<void>;
}

export class EvolutionView {
  readonly #root: HTMLDivElement;
  readonly #listEl: HTMLDivElement;
  readonly #callbacks: EvolutionViewCallbacks;
  #visible = false;
  // 20r-a: per-monster in-flight lock (raisingView Care/Train shape). A click disables ALL
  // of that monster's choice buttons — a second, DIFFERENT choice while the first evolve
  // is in flight is the irreversible double-evolve. The value is the generation token:
  // `.finally()` releases only if the stored object is still its own, so a stale promise
  // (click → hide() cleared → reopen → click again → first settles) cannot release the
  // second click's lock.
  readonly #pending = new Map<bigint, object>();
  // The choice buttons currently on screen per monster: refresh() rebuilds every node, so
  // the release must re-enable the LIVE nodes, never the closure's detached ones.
  readonly #choiceButtons = new Map<bigint, HTMLButtonElement[]>();

  constructor(parent: HTMLElement, callbacks: EvolutionViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    this.#root.style.cssText =
      'position:fixed;inset:0;z-index:100;background-color:var(--mr-evo-backdrop);' +
      'display:none;flex-direction:column;align-items:center;padding:24px;' +
      'overflow-y:auto;font-family:monospace;color:var(--mr-evo-fg);';

    const title = document.createElement('h2');
    title.textContent = 'Evolution';
    // m23-s4: the OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'evolution-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0 0 8px;'; // colour inherits --mr-evo-fg from the root
    this.#root.appendChild(title);

    const hint = document.createElement('p');
    hint.textContent =
      'Each path lists what it needs and how close this monster is. When two or more ' +
      'paths are ready at once, you choose which one to take.';
    hint.style.cssText =
      'margin:0 0 16px;color:var(--mr-evo-muted);font-size:14px;max-width:700px;';
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
    // 20r-a: the SDK never settles an in-flight reducer promise after a link drop, so
    // `.finally()` may never run — onReconnect hides this view to release the lock here.
    // No node re-enable needed: the next refresh() re-derives from the (now empty) map.
    this.#pending.clear();
    closeOverlayA11y('evolutionView', null);
  }

  toggle(): void {
    if (this.#visible) this.hide();
    else this.show();
  }

  refresh(vm: EvolutionViewModel): void {
    // replaceChildren, not append: refresh() fires on EVERY batch-applied.
    this.#listEl.replaceChildren();
    this.#choiceButtons.clear();
    if (vm.monsters.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No monsters yet.';
      empty.style.cssText = 'color:var(--mr-evo-muted);';
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
    card.style.cssText =
      'background-color:var(--mr-evo-card);border-radius:6px;padding:10px;' +
      'border:1px solid var(--mr-evo-border);';

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
    stats.style.cssText = 'font-size:13px;color:var(--mr-evo-muted);margin-bottom:6px;';
    card.appendChild(stats);

    if (mon.paths.length === 0) {
      const none = document.createElement('div');
      none.textContent = 'No evolution paths.';
      none.style.cssText = 'font-size:13px;color:var(--mr-evo-muted);';
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
      ready.style.cssText = 'margin-top:6px;font-size:14px;color:var(--mr-evo-ok);';
      card.appendChild(ready);
    }

    // EG4-2: rendered from `choices`, which the model keeps empty below 2 eligible.
    if (mon.choices.length > 0) {
      const prompt = document.createElement('div');
      prompt.textContent = 'Two or more paths are ready — pick one:';
      prompt.style.cssText = 'margin-top:6px;font-size:14px;'; // inherits --mr-evo-fg
      card.appendChild(prompt);

      const picker = document.createElement('div');
      picker.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;';
      const btns: HTMLButtonElement[] = [];
      for (const choice of mon.choices) {
        const btn = this.#renderChoice(mon.monsterId, choice);
        btns.push(btn);
        picker.appendChild(btn);
      }
      this.#choiceButtons.set(mon.monsterId, btns);
      card.appendChild(picker);
    }

    return card;
  }

  #renderPathRow(path: EvolutionPathViewModel): HTMLDivElement {
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'evo-path-row');
    row.style.cssText =
      'margin-top:6px;padding:6px;border-radius:4px;background-color:var(--mr-evo-row);' +
      `border-left:3px solid ${path.met ? 'var(--mr-evo-ok)' : 'var(--mr-evo-border)'};`;

    const heading = document.createElement('div');
    heading.textContent = `→ ${path.toSpeciesName}`;
    heading.style.cssText = `font-size:14px;color:${path.met ? 'var(--mr-evo-ok)' : 'var(--mr-evo-fg)'};`;
    row.appendChild(heading);

    const status = document.createElement('div');
    // `unmetReason` is null exactly when the path is reachable, so this is total.
    status.textContent = path.unmetReason ?? 'All requirements met.';
    status.style.cssText = `font-size:12px;margin-bottom:4px;color:${path.met ? 'var(--mr-evo-ok)' : 'var(--mr-evo-warn)'};`;
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
    row.style.cssText = `font-size:12px;color:${gate.met ? 'var(--mr-evo-ok)' : 'var(--mr-evo-muted)'};`;
    return row;
  }

  #renderChoice(monsterId: bigint, choice: EvolutionPathViewModel): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.setAttribute('data-testid', 'evo-choice');
    btn.textContent = `Evolve into ${choice.toSpeciesName}`;
    btn.style.cssText =
      'padding:4px 12px;background-color:var(--mr-evo-button);border:none;border-radius:4px;' +
      'color:var(--mr-evo-fg);cursor:pointer;font-size:14px;';
    // 20r-a: re-derive from the lock, not default-enabled — a batch can rebuild this card
    // while the monster's evolve is still in flight.
    btn.disabled = this.#pending.has(monsterId);
    btn.addEventListener('click', () => {
      if (this.#pending.has(monsterId)) return;
      const lock = {};
      this.#pending.set(monsterId, lock);
      for (const b of this.#choiceButtons.get(monsterId) ?? [btn]) b.disabled = true;
      // Re-enabled in .finally() on BOTH arms — a rejected or frozen-link evolve used to
      // wedge this button until an unrelated batch happened to refresh the panel.
      // `new Promise((resolve) => resolve(...))` calls the callback synchronously and turns
      // a synchronous throw into a rejection; `.catch` after `.finally` keeps a rejecting
      // callback from surfacing as an unhandled rejection (main.ts reported it already).
      void new Promise<void>((resolve) =>
        resolve(this.#callbacks.onEvolve(monsterId, choice.toSpecies)),
      )
        .finally(() => {
          if (this.#pending.get(monsterId) !== lock) return;
          this.#pending.delete(monsterId);
          for (const b of this.#choiceButtons.get(monsterId) ?? [btn]) b.disabled = false;
        })
        .catch((err: unknown) => {
          console.error('evolve click handler error', err);
        });
    });
    return btn;
  }
}
