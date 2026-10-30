// ui/evolutionView.ts — thin DOM shell for the evolution screen.
//
// Renders an EvolutionViewModel produced by evolutionModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes, no eligibility computation of its own —
// one-way flow only, and the eligibility decision is the model's (it is the SAME
// predicate game-core runs, so the shell must never re-derive or second-guess it).
// The loop calls refresh() on batch-applied. Nothing here sends an intent: the view is
// informational (qf-8 deleted its choice buttons), and the constructor's callbacks are unread.
// Coverage-excluded shell.
//
// TWO RULES THIS FILE MUST NOT BREAK:
//   * It renders NO control. The 2+-eligible choice buttons were a mouse-only duplicate of the
//     Monsters sheet's Evolve list (boxView.ts, ctl-8c) and are deleted (qf-8, QF8.1); at
//     exactly one eligible path the server auto-applies the evolution, so no affordance exists.
//   * Nicknames and species names are PLAYER-CONTROLLED (`set_nickname`). Every string
//     reaches the DOM through `textContent` / `createElement` — NEVER `innerHTML`.
//
// COLOURS AND SIZES ARE A CONTRACT, NOT DECORATION. Every colour
// below is a `var(--mr-evo-*)` token declared in `client/src/styles.css`, never a literal: a
// literal is unreachable by the sheet's `@media (prefers-contrast: more)` override, so one stray
// hex would leave that string un-recoloured for a high-contrast user. Backgrounds use the
// `background-color` LONGHAND (the shorthand hides the value from the DOM oracle). Font sizes are
// `px` like every sibling view — the old `em` sizes mis-applied WCAG's large-text threshold and
// scaled differently from the rest of the UI. Only declarations on a fixed allow-list may appear
// (no `opacity`/`filter`/`text-shadow`/… — each is a way to dim text the contrast oracle cannot
// see), and no element but the root may carry a `class`, none an `id` (a stylesheet rule is the
// other way around the inline colours; the root's `mr-frame mr-shell` only places it, ctl-7b).
// All of it is measured from the rendered DOM by `evolutionView.test.ts` with the four fixture
// states named there; a new element or colour here must be added to those censuses in the same
// change.
//
// Every player-facing string this view renders is resolved through the i18n
// resolver (`t()`/`tf()`, ui/i18n/resolver.ts) with an `evolution.*` key from
// ui/i18n/catalog.en.ts; the English bytes are unchanged (the catalog pins them). The name row
// `${nick} (${species})` is deliberately NOT keyed — a glyph-only compound (tier
// (e)). Model data (species names, tiers, the model's `unmetReason`, gate label/current/required
// text) flow through as params or raw, never as catalog text. Every `t(`/`tf(` first argument is
// a string LITERAL — the gate row's ternary picks between two calls, never between two keys.
//
// Overlay a11y wiring. This view is a CONSTRUCTED shell:
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
// Each `#app`-mounted view creates its OWN root under the shared mount, so opening this view
// never closes a sibling (no close-before-open; boxView.test.ts S4-CROSS-VIEW-DISTINCT-ROOTS).
import type {
  EvolutionGateViewModel,
  EvolutionMonsterViewModel,
  EvolutionPathViewModel,
  EvolutionViewModel,
} from './evolutionModel';
import { t, tf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export interface EvolutionViewCallbacks {
  /** Unread: the choice buttons are deleted (qf-8, QF8.1); evolving is the Monsters sheet's
   *  Evolve list. Kept so main.ts's construction stays unchanged. */
  readonly onEvolve: (monsterId: bigint, toSpecies: number) => void | Promise<void>;
}

export class EvolutionView {
  readonly #root: HTMLDivElement;
  /** The "Evolution" heading; its text is resolved in show(), not here (see show()). */
  readonly #titleEl: HTMLHeadingElement;
  /** The static explainer under the heading; text resolved in show(). */
  readonly #hintEl: HTMLParagraphElement;
  readonly #listEl: HTMLDivElement;
  #visible = false;

  constructor(parent: HTMLElement, _callbacks: EvolutionViewCallbacks) {
    this.#root = document.createElement('div');
    // ctl-7b: a class-styled frame (`.mr-shell` places it inside `#game-screen`). The two colours
    // stay inline as tokens over `.mr-frame`'s: they are what `prefers-contrast: more` re-colours.
    this.#root.className = 'mr-frame mr-shell';
    this.#root.style.cssText =
      'display:none;align-items:center;' +
      'background-color:var(--mr-evo-backdrop);color:var(--mr-evo-fg);';

    // NO text here — `evolution.title` is resolved in show() (see there for why).
    const title = document.createElement('h2');
    // The OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'evolution-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0 0 8px;'; // colour inherits --mr-evo-fg from the root
    this.#titleEl = title;
    this.#root.appendChild(title);

    // Its text (`evolution.hint`) is resolved in show(), not here.
    const hint = document.createElement('p');
    hint.style.cssText =
      'margin:0 0 16px;color:var(--mr-evo-muted);font-size:14px;max-width:700px;';
    this.#hintEl = hint;
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
    // the two strings that are set ONCE and never rewritten by a render — the heading and the
    // explainer — are resolved HERE, on every show(), not in the constructor. A
    // constructor-time `t()` would freeze the English unless S6's `setLocale` ran before
    // main.ts constructs this view (deep inside the async connect path) — an unenforced
    // cross-file boot-order invariant. UNCONDITIONAL, not gated on `wasVisible`: a repeat
    // show() on an already-open overlay must re-resolve too, or a mid-session locale switch
    // would leave stale text. Idempotent by design. These writes sit AFTER the `wasVisible`
    // read (the header's "first statement" edge) and BEFORE the display write, so the open
    // stays the last statement of the open path.
    this.#titleEl.textContent = t('evolution.title');
    this.#hintEl.textContent = t('evolution.hint');
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
      empty.textContent = t('evolution.monsters.empty');
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

    // The three server-derived tiers, surfaced verbatim beside level and stage.
    const stats = document.createElement('div');
    stats.textContent = tf('evolution.card.stats', {
      level: mon.level,
      stage: mon.tier,
      trust: mon.trustTier,
      qualityTime: mon.qualityTimeTier,
      nutrition: mon.nutritionPct,
    });
    stats.style.cssText = 'font-size:13px;color:var(--mr-evo-muted);margin-bottom:6px;';
    card.appendChild(stats);

    if (mon.paths.length === 0) {
      const none = document.createElement('div');
      none.textContent = t('evolution.card.noPaths');
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
      ready.textContent = tf('evolution.card.ready', { species: mon.readyPathName });
      ready.style.cssText = 'margin-top:6px;font-size:14px;color:var(--mr-evo-ok);';
      card.appendChild(ready);
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
    heading.textContent = tf('evolution.path.heading', { species: path.toSpeciesName });
    heading.style.cssText = `font-size:14px;color:${path.met ? 'var(--mr-evo-ok)' : 'var(--mr-evo-fg)'};`;
    row.appendChild(heading);

    const status = document.createElement('div');
    // `unmetReason` is null exactly when the path is reachable, so this is total. The model's
    // reason text stays raw (model data); only the fallback is catalogued.
    status.textContent = path.unmetReason ?? t('evolution.path.allMet');
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
    // Two whole-row keys, the ternary OUTSIDE the call — every `tf(` first
    // argument stays a string literal. One text node in one element (the census is
    // unaffected).
    const p = { label: gate.label, current: gate.currentText, required: gate.requiredText };
    row.textContent = gate.met ? tf('evolution.gate.metRow', p) : tf('evolution.gate.unmetRow', p);
    row.style.cssText = `font-size:12px;color:${gate.met ? 'var(--mr-evo-ok)' : 'var(--mr-evo-muted)'};`;
    return row;
  }
}
