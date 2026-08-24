// ui/helpView.ts — thin DOM shell for the in-client help overlay (pt-c2b, ADR-0135).
//
// Display-only: no text <input>, no submit, no #pending lock, no callbacks
// (zero-arg construction — leaderboardView precedent), no server reducer. Pure
// rendering from a HelpViewModel; all content lives in helpModel's typed SSOT.
//
// Fully unit-covered via happy-dom (leaderboardView / renameView precedent) — this
// file is therefore NOT in vite.config.ts coverage.exclude and NOT in the
// dom-shell-coverage-exclusion eval's DOM_SHELLS.
//
// XSS firewall (ADR-0135): render() paints via textContent / createTextNode ONLY,
// NEVER innerHTML — even though the content is a static const today, a future edit
// sourcing content from anywhere untrusted must not be able to inject a node. Each
// render() rebuilds authoritatively (replaceChildren) so no stale <li> survives.

import type { HelpViewModel } from './helpModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export class HelpView {
  readonly #overlay: HTMLElement;
  readonly #controlsEl: HTMLElement;
  readonly #goalsEl: HTMLElement;

  constructor() {
    const overlay = document.getElementById('help-overlay');
    if (!overlay) throw new Error('help-overlay element not found in DOM');
    this.#overlay = overlay;

    const controls = document.getElementById('help-controls');
    if (!controls) throw new Error('help-controls missing');
    this.#controlsEl = controls;

    const goals = document.getElementById('help-goals');
    if (!goals) throw new Error('help-goals missing');
    this.#goalsEl = goals;
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    // m23-s3 D1: read visibility BEFORE the display write. `show()` is called REPEATEDLY on an
    // already-open overlay (pvpView.ts is the extreme case, main.ts:1699-1701), and a re-open
    // re-schedules overlayA11y's deferred focus -- which would yank focus back to the initial
    // anchor on every store batch. Only the hidden->visible EDGE opens.
    const wasVisible = this.visible;
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('helpView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // m23-s3 D2: DELIBERATELY UNGUARDED (see pvpView.ts's header). closeOverlayA11y is a
    // documented no-op with no open record, and leaving it unguarded is what lets a record
    // that ever desynchronised from the DOM self-heal instead of leaking a live trap forever.
    closeOverlayA11y('helpView', null);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /**
   * Rebuild the overlay authoritatively: one <li> per control (key + action) into
   * #help-controls, one <li> per goal into #help-goals. textContent ONLY (XSS
   * firewall). replaceChildren clears prior <li>s so a smaller VM leaves no stale rows.
   */
  render(vm: HelpViewModel): void {
    const controlItems = vm.controls.map((c) => {
      const li = document.createElement('li');
      li.textContent = `${c.key} — ${c.action}`;
      return li;
    });
    this.#controlsEl.replaceChildren(...controlItems);

    const goalItems = vm.goals.map((goal) => {
      const li = document.createElement('li');
      li.textContent = goal;
      return li;
    });
    this.#goalsEl.replaceChildren(...goalItems);
  }
}
