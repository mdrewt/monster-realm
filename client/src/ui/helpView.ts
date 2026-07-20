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
    this.#overlay.style.display = '';
  }

  hide(): void {
    this.#overlay.style.display = 'none';
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
