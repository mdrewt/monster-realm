// ui/errorOverlayView.ts — self-mounting DOM shell for the F9 error overlay (pt-b1).
//
// Source-of-truth: M-playtest-b error overlay DOM shell (EARS U-4 XSS, S-3, M-2 total render).
//
// Unlike leaderboardView (which getElementById's a pre-existing element), this view SELF-MOUNTS:
// it creates its own `#mr-error-overlay` root and appends it to the mount (default document.body).
// The overlay starts hidden and sets `pointer-events: none` so it can never block gameplay input.
//
// render() is TOTAL (M-2): the whole body is wrapped in try/catch → console.error, so a hostile
// or malformed VM (e.g. a rows getter that throws) can never propagate out of the render call and
// crash the animation frame that drives it. Data reaches the DOM via textContent only (never
// innerHTML) — error messages can echo server strings, so this is the XSS firewall (U-4).

import type { ErrorOverlayViewModel } from './errorOverlayModel';

export class ErrorOverlayView {
  readonly rootId = 'mr-error-overlay';
  readonly #root: HTMLElement;
  readonly #list: HTMLElement;
  readonly #footer: HTMLElement;

  constructor(mount: HTMLElement = document.body) {
    const root = document.createElement('div');
    root.id = this.rootId;
    root.style.display = 'none';
    // Non-blocking: the diagnostic overlay must never capture pointer events over the canvas.
    root.style.pointerEvents = 'none';

    const list = document.createElement('div');
    list.className = 'mr-error-overlay-list';
    root.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'mr-error-overlay-footer';
    footer.textContent = 'F8 dismiss · F9 bug report';
    root.appendChild(footer);

    mount.appendChild(root);
    this.#root = root;
    this.#list = list;
    this.#footer = footer;
  }

  get visible(): boolean {
    return this.#root.style.display !== 'none';
  }

  show(): void {
    this.#root.style.display = '';
  }

  hide(): void {
    this.#root.style.display = 'none';
  }

  dismiss(): void {
    this.hide();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** TOTAL render: a malformed VM (throwing getter, etc.) is swallowed to console.error, never
   *  propagated. Rows render via replaceChildren + textContent (replace-not-append, XSS-safe). */
  render(vm: ErrorOverlayViewModel): void {
    try {
      const rows = vm.rows;
      // Render one row per VM row (newest-first, per the model). No conditional branch here
      // (keeps the shell fully unit-covered): `hiddenCount`/`total` live in the VM and are
      // surfaced in the F9 bundle, so the overlay itself renders a single unconditional path.
      const items = rows.map((row) => {
        const el = document.createElement('div');
        el.className = 'mr-error-row';
        el.dataset.source = row.source;
        el.textContent = `[${row.source}] ${row.message}`;
        return el;
      });
      this.#list.replaceChildren(...items);
      this.#footer.textContent = 'F8 dismiss · F9 bug report';
    } catch (err) {
      console.error('[obs] error-overlay render', err);
    }
  }
}
