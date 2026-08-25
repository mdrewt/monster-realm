// ui/menuView.ts — thin DOM shell for the two-level main menu (uxd3, ADR-0162).
//
// `helpView.ts` precedent: the constructor resolves its elements once and throws loudly on
// a missing one; `visible` reads the live DOM; `show()`/`hide()` write ONLY `style.display`
// so the shell's `position:fixed;inset:0;z-index:100` survives a toggle; `render()` rebuilds
// authoritatively via `replaceChildren`.
//
// Deviation from helpView's zero-arg form: the menu is interactive, so it takes a callbacks
// object (`renameView`/`shopView` precedent). It still decides NOTHING — every input is
// forwarded verbatim to `menuModel.menuStep` (ADR-0014 functional core).
//
// XSS firewall (ADR-0135): `textContent` / `createElement` / `replaceChildren`, plus the
// attribute primitives `setAttribute` / `removeAttribute` that carry the ARIA semantics —
// ONLY. No markup-parsing DOM API of any kind: none of them ever parses a string as markup,
// which is the whole property the firewall protects. Pinned by MV-NO-INNERHTML, which scans
// this file's raw source for the banned APIs by name, so they must not appear even inside a
// comment.
//
// Fully happy-dom unit-covered, so this file is deliberately NOT in `vite.config.ts`
// `coverage.exclude` and NOT in the dom-shell-coverage-exclusion eval's DOM_SHELLS
// (`findUnsanctionedExclusions` would reject the addition, and `evals/` is out of scope).
import type { MenuInput, MenuViewModel } from './menuModel';
import { menuKeyInput } from './menuModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export interface MenuViewCallbacks {
  readonly onInput: (input: MenuInput) => void;
}

export class MenuView {
  readonly #overlay: HTMLElement;
  readonly #headingEl: HTMLElement;
  readonly #rowsEl: HTMLElement;
  readonly #backHintEl: HTMLElement;

  constructor(callbacks: MenuViewCallbacks) {
    const overlay = document.getElementById('menu-overlay');
    if (!overlay) throw new Error('menu-overlay element not found in DOM');
    this.#overlay = overlay;

    const heading = document.getElementById('menu-heading');
    if (!heading) throw new Error('menu-heading missing');
    this.#headingEl = heading;

    const rows = document.getElementById('menu-rows');
    if (!rows) throw new Error('menu-rows missing');
    this.#rowsEl = rows;

    const backHint = document.getElementById('menu-back-hint');
    if (!backHint) throw new Error('menu-back-hint missing');
    this.#backHintEl = backHint;

    // m23-s6 (ADR-0205 D1/D2, A11Y-24): the listbox anchor is a CONSTRUCTOR-TIME contract, not
    // a render-time one — replaceChildren rebuilds the CHILDREN, never the <ul> itself, so the
    // role and the name must already be in place before the first render(). The name is an
    // IDREF derived from the ALREADY-RESOLVED heading element (never a second lookup and never
    // a literal): the heading IS the breadcrumb and its TEXT changes per level, so a frozen
    // aria-label would announce "Menu" from inside the Party submenu.
    // `tabindex` on the <ul> belongs to index.html (it ships exactly "0") — never written here.
    this.#rowsEl.setAttribute('role', 'listbox');
    this.#rowsEl.setAttribute('aria-labelledby', this.#headingEl.id);

    // DELEGATED listeners, bound ONCE on the <ul> — not per-<li> in render(). Per-row
    // listeners leak on every re-render, and re-binding the <ul> per render makes one click
    // emit N times. Delegation also survives replaceChildren for free.
    this.#rowsEl.addEventListener('click', (e) => {
      const index = this.#indexOfEventTarget(e.target);
      if (index !== undefined) callbacks.onInput({ kind: 'click', index });
    });
    this.#rowsEl.addEventListener('mouseover', (e) => {
      const index = this.#indexOfEventTarget(e.target);
      if (index !== undefined) callbacks.onInput({ kind: 'hover', index });
    });
    // m23-s6 SPLIT OWNERSHIP (A11Y-25). Same <ul>, same delegation, same DEFAULT (bubble)
    // phase as the two above. This listener owns ONLY the selection-movement inputs — up,
    // down, left — and consumes them with preventDefault + stopPropagation so main.ts's window
    // listener does not step the menu a SECOND time for one press.
    //
    // WHY only that subset: `enter` and `escape` are the only inputs that can activate a leaf
    // or dismiss the menu, so they are deliberately left to bubble to main.ts, which owns them
    // behind its ordered guard chain — sessionGateBlocks() FIRST (ADR-0182 D17 /
    // W-M21B2-SESSION-GATE-FIRST), then the key-repeat gate, then the Escape ladder. Swallowing
    // them here would route a guarded action around that chain. The three inputs kept are
    // provably inert instead: `menuStep` can only ever return effect {kind:'none'} for up, down
    // and left, so they cannot close the menu, activate a leaf, or reach a reducer — consuming
    // them costs main.ts nothing. Anything menuKeyInput does not recognise (KeyM, the menu's
    // own toggle key, above all) falls through completely untouched, so the menu stays
    // closeable from the keyboard while the listbox holds focus.
    this.#rowsEl.addEventListener('keydown', (e) => {
      if (!this.visible) return;
      if (e.repeat) return;
      const input = menuKeyInput(e.code);
      if (input === undefined) return;
      if (input.kind !== 'up' && input.kind !== 'down' && input.kind !== 'left') return;
      e.preventDefault();
      // stopPropagation, NEVER stopImmediatePropagation: a sibling listener registered on this
      // same <ul> must still run.
      e.stopPropagation();
      callbacks.onInput(input);
    });
  }

  /** Resolve the row index of an event target, or undefined for a hit on the bare <ul>.
   *  Returning undefined (rather than NaN) keeps the shell from manufacturing junk inputs;
   *  `menuStep` validates the index again anyway, since a click can race a re-render. */
  #indexOfEventTarget(target: EventTarget | null): number | undefined {
    if (!(target instanceof HTMLElement)) return undefined;
    const li = target.closest('li');
    if (!li) return undefined;
    const raw = li.dataset.menuIndex;
    if (raw === undefined) return undefined;
    const index = Number(raw);
    return Number.isInteger(index) ? index : undefined;
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    // m23-s6 (helpView.ts precedent): read visibility BEFORE the display write. Only the
    // hidden->visible EDGE opens — a repeat show() on an already-open overlay would otherwise
    // re-schedule overlayA11y's deferred initial-focus timer and yank the player back to the
    // listbox out of nowhere.
    const wasVisible = this.visible;
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('menuView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // DELIBERATELY UNGUARDED, unlike show() (helpView.ts precedent). A close with no open
    // record is a documented no-op, so nothing is risked; and every hide() closing is what
    // heals a record that ever desynchronised from the DOM, instead of leaking a live capture
    // trap, a pending deferred-focus timer and a stale return target for the whole session.
    closeOverlayA11y('menuView', null);
  }

  /**
   * Rebuild authoritatively: heading, one <li> per row, back hint. `replaceChildren` on the
   * <ul> only — never on the overlay, whose children were resolved once in the constructor.
   */
  render(vm: MenuViewModel): void {
    this.#headingEl.textContent = vm.heading;
    this.#backHintEl.textContent = vm.backHint;

    const items = vm.rows.map((row) => {
      const li = document.createElement('li');
      li.dataset.menuIndex = String(row.index);
      li.dataset.selected = row.selected ? 'true' : 'false';
      li.dataset.disabled = row.disabled ? 'true' : 'false';
      // m23-s6: the option id comes from `row.index` — the VM's own field, which is what the
      // delegated listeners feed back into menuStep — NEVER the array position.
      li.id = `menu-option-${row.index}`;
      li.setAttribute('role', 'option');
      // Every option in a single-select listbox carries an EXPLICIT aria-selected; an absent
      // 'false' would leave the selection ambiguous to an AT.
      li.setAttribute('aria-selected', row.selected ? 'true' : 'false');
      // aria-disabled only when it is true: aria-disabled="false" is semantically identical to
      // the attribute being absent, so writing it is pure noise.
      if (row.disabled) li.setAttribute('aria-disabled', 'true');
      // NEVER a tabindex on a row (APG puts it on the CONTAINER only, and index.html already
      // ships it there). A negative tabindex makes an <li> MOUSE-focusable: one click focuses
      // the row, the next replaceChildren destroys that node, the active element falls back to
      // <body>, and aria-activedescendant — which only speaks while the listbox itself is the
      // active element — goes permanently silent. Measured, not theoretical.
      // Grey-not-hide: an unavailable leaf is always rendered, just dimmed and non-routing.
      li.style.opacity = row.disabled ? '0.4' : '1';
      li.style.fontWeight = row.selected ? 'bold' : 'normal';
      li.textContent = row.keyGlyph === null ? row.title : `${row.keyGlyph} — ${row.title}`;
      return li;
    });
    this.#rowsEl.replaceChildren(...items);

    // AFTER the rebuild, never before: the IDREF must name a LIVE node, not one the
    // replaceChildren just detached. `removeAttribute` is the clear — an empty string is a
    // DANGLING IDREF, i.e. a listbox still claiming an active descendant that does not exist.
    const active = vm.rows.find((r) => r.selected);
    if (active === undefined) this.#rowsEl.removeAttribute('aria-activedescendant');
    else this.#rowsEl.setAttribute('aria-activedescendant', `menu-option-${active.index}`);
  }
}
