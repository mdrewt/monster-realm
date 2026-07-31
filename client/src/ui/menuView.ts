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
// XSS firewall (ADR-0135): `textContent` / `createElement` / `replaceChildren` ONLY — no
// markup-parsing DOM API of any kind. Pinned by MV-NO-INNERHTML, which scans this file's
// raw source for those APIs by name, so they must not appear even inside a comment.
//
// Fully happy-dom unit-covered, so this file is deliberately NOT in `vite.config.ts`
// `coverage.exclude` and NOT in the dom-shell-coverage-exclusion eval's DOM_SHELLS
// (`findUnsanctionedExclusions` would reject the addition, and `evals/` is out of scope).
import type { MenuInput, MenuViewModel } from './menuModel';

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
    this.#overlay.style.display = '';
  }

  hide(): void {
    this.#overlay.style.display = 'none';
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
      // Grey-not-hide: an unavailable leaf is always rendered, just dimmed and non-routing.
      li.style.opacity = row.disabled ? '0.4' : '1';
      li.style.fontWeight = row.selected ? 'bold' : 'normal';
      li.textContent = row.keyGlyph === null ? row.title : `${row.keyGlyph} — ${row.title}`;
      return li;
    });
    this.#rowsEl.replaceChildren(...items);
  }
}
