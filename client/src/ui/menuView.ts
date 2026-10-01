// ui/menuView.ts — thin DOM shell for the main menu (design §5, CTL5.1). It paints
// `menuViewModel(state)` from `screens/mainMenuScreen.ts` into one `side` frame of the ctl-4 kit
// (`frame.ts` chrome, `navRender.ts` list) inside the legacy `#menu-overlay` root, and decides
// nothing: keys reach the menu only through the input router, and a click on an entry is
// forwarded as `{kind: 'pick', key}`.
//
// `#menu-overlay` stays the overlay root (its id, inline style and `display:none` contract are
// frozen), and `#menu-rows` stays its `initialFocusSelector` and the single tab stop: it moves
// into the frame body and becomes the nav container. `#menu-heading` and `#menu-back-hint` are
// hidden — the frame title replaces the heading, and the English back hints are gone (B11).
//
// The only inline style writes are `display` (show/hide), `visibility` (covered by a child) and
// the frame's `margin-left` (the right-hand panel); every ARIA, initial-focus and trap write on
// the open/close edge belongs to `overlayA11y`. Text reaches the DOM through `textContent` only.
import { createFrame, type FrameChrome, renderFeedback, setFrameTitle } from './frame';
import { renderNav } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { MenuViewModel } from './screens/mainMenuScreen';

export type MenuPointerInput = { readonly kind: 'pick'; readonly key: string };

export interface MenuViewCallbacks {
  readonly onInput: (input: MenuPointerInput) => void;
}

function required(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`${id} element not found in DOM`);
  return el;
}

/** The frame around `#menu-rows`, built once per document: a second view over the same markup
 *  (tests construct several) re-finds the chrome instead of nesting another frame. */
function menuFrame(overlay: HTMLElement, rows: HTMLElement): FrameChrome {
  const root = rows.closest<HTMLElement>('.mr-frame');
  if (root !== null && overlay.contains(root)) {
    const part = (className: string): HTMLElement =>
      root.querySelector(`.${className}`) as HTMLElement;
    return {
      id: 'menu',
      root,
      titleEl: part('mr-frame-title'),
      breadcrumb: part('mr-frame-breadcrumb'),
      tabBar: part('mr-frame-tabs'),
      tabStrip: part('mr-frame-tabstrip'),
      body: part('mr-frame-body'),
      feedback: part('mr-frame-feedback'),
      hintSlot: part('mr-frame-hints'),
    };
  }
  const frame = createFrame(document, { id: 'menu', size: 'side' });
  frame.root.style.marginLeft = 'auto';
  frame.body.appendChild(rows);
  overlay.appendChild(frame.root);
  return frame;
}

export class MenuView {
  readonly #overlay: HTMLElement;
  readonly #rows: HTMLElement;
  readonly #frame: FrameChrome;

  constructor(callbacks: MenuViewCallbacks) {
    this.#overlay = required('menu-overlay');
    const heading = required('menu-heading');
    this.#rows = required('menu-rows');
    const backHint = required('menu-back-hint');
    heading.hidden = true;
    backHint.hidden = true;
    this.#frame = menuFrame(this.#overlay, this.#rows);

    // ONE delegated listener on the persistent container: rows are diffed by key, so per-row
    // listeners would leak or double up across renders.
    this.#rows.addEventListener('click', (e) => {
      const item =
        e.target instanceof Element ? e.target.closest<HTMLElement>('[data-nav-key]') : null;
      const key = item?.dataset.navKey;
      if (key !== undefined && this.#rows.contains(item)) callbacks.onInput({ kind: 'pick', key });
    });
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    // Only the hidden->visible EDGE opens: a repeat open would re-schedule the deferred focus.
    const wasVisible = this.visible;
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('menuView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // Unguarded: a close with no open record is a no-op, and closing on every hide heals a record
    // that ever drifted from the DOM.
    closeOverlayA11y('menuView', null);
  }

  /** A child screen sits above the menu: stop painting the menu (most child shells are in-flow,
   *  so a fixed full-screen menu would cover them) while it stays open beneath. */
  setCovered(covered: boolean): void {
    this.#overlay.style.visibility = covered ? 'hidden' : '';
  }

  render(vm: MenuViewModel): void {
    setFrameTitle(this.#frame, vm.title, vm.crumbs);
    renderNav(this.#rows, vm.layout, vm.nav, {
      frame: vm.frameId,
      fill: (el, item) => {
        el.textContent = vm.labels[item.key] ?? '';
      },
      labelledBy: this.#frame.titleEl.id,
    });
    renderFeedback(this.#frame, vm.feedback);
  }
}
