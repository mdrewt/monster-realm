// ui/controlsView.ts — DOM shell for Options › Controls (design §9, CTL12B.1). Fully unit-covered
// via happy-dom (the privacyView precedent), so it is NOT in `vite.config.ts` coverage.exclude.
// Every decision is `ui/screens/optionsScreen.ts`'s (the cursor, the capture, the confirm) or
// `ui/controlsModel.ts`'s (rows, labels, prompts); this file paints, and hands the shell the
// requests the screen issues.
//
// The shell is constructed, not static markup (the claimView / privacyView route). `ensureElement`
// creates every node `display:none`, so the constructor un-hides the parts that always show.
//
// `#controls-rows` is the one nav container (navRender: the single tab stop, the active cell named
// by `aria-activedescendant`) and the dialog's focus anchor. It shows the active tab's grid, or the
// Reset all confirm's Yes / No list while that is up. Each cell names its row, because a screen
// reader hears one cell at a time.
//
// Keycaps are read from the LIVE table on every paint (`handlers.bindings`), so a remap shows in
// the paint that follows it. A request token is applied before the rows render, for the same
// reason, and applied once: the host repaints the same state on every later step.
//
// `capturing` is what the shell reads on a keydown to know a slot waits for a key. It is assigned
// first in `paint`, so a paint that throws later cannot leave the shell capturing keys for a
// capture the screen has left; `hide()` ends it on every close path.
//
// The feedback line is not a live region (ui/liveRegion.ts owns the only one): each line, the
// capture prompt and the confirm's question go to `handlers.announce`.
import type { Bindings } from '../input/bindings';
import type { Accel } from '../input/buttons';
import { glyph } from '../input/glyphs';
import { confirmLayout } from './actionSheetModel';
import { type ControlsTab, capturePrompt, rowLabel, type SlotTarget, slots } from './controlsModel';
import { t, tf } from './i18n/resolver';
import type { NavItem, NavTab } from './nav';
import { renderNav, renderTabs } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import {
  type ControlsPaint,
  type ControlsRequest,
  type ControlsScreenView,
  controlsItem,
} from './screens/optionsScreen';

export interface ControlsViewHandlers {
  /** The live binding table. */
  readonly bindings: () => Bindings;
  /** Unbind an accelerator; false when the new table could not be saved. */
  readonly onClear: (accel: Accel) => boolean;
  /** Restore the default table; false when it could not be saved. */
  readonly onReset: () => boolean;
  /** The Cancel chip was pressed while a slot waits for a key. */
  readonly onCancelCapture: () => void;
  /** Say `text` through the page's live region. */
  readonly announce: (text: string) => void;
}

/** The id prefix of the nav items and tabs (`controls-tab-buttons`, `controls-buttons-A_0`). */
const FRAME = 'controls';

// Each label is a thunk over a literal catalog id, read in the active locale.
const TAB_LABELS: Readonly<Record<ControlsTab, () => string>> = {
  buttons: () => t('controls.tab.buttons'),
  shortcuts: () => t('controls.tab.shortcuts'),
};

const tabLabel = (tab: NavTab): string =>
  Object.hasOwn(TAB_LABELS, tab.key) ? TAB_LABELS[tab.key as ControlsTab]() : '';

/** A Reset all confirm row's word (`confirmLayout`'s keys), each a literal catalog key. */
const confirmLabel = (key: string): string => (key === 'yes' ? t('prompt.yes') : t('prompt.no'));

const sameTarget = (a: SlotTarget | null, b: SlotTarget): boolean =>
  a !== null && a.slot === b.slot && a.row.kind === b.row.kind && a.row.id === b.row.id;

/** Find an existing element or create a hidden one appended to `parent`. */
function ensureElement(id: string, tag = 'div', parent: HTMLElement = document.body): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const el = document.createElement(tag);
  el.id = id;
  el.style.display = 'none';
  parent.appendChild(el);
  return el;
}

/** Where a constructed frame lives: the frame layer inside #game-screen, else the game screen,
 *  else <body> for a shell-less boot. */
function frameAnchor(): HTMLElement {
  return (
    document.getElementById('frame-layer') ??
    document.getElementById('game-screen') ??
    document.body
  );
}

export class ControlsView implements ControlsScreenView {
  readonly #handlers: ControlsViewHandlers;
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #tabs: HTMLElement;
  readonly #question: HTMLElement;
  readonly #rows: HTMLElement;
  readonly #capture: HTMLElement;
  readonly #cancelBtn: HTMLElement;
  readonly #feedback: HTMLElement;
  #capturing: SlotTarget | null = null;
  #confirming = false;
  // The last request token applied: a token is applied once.
  #applied: ControlsRequest | null = null;

  constructor(handlers: ControlsViewHandlers) {
    this.#handlers = handlers;
    this.#overlay = ensureElement('controls-overlay', 'div', frameAnchor());
    this.#overlay.classList.add('mr-frame', 'mr-shell');
    this.#title = ensureElement('controls-title', 'h2');
    this.#tabs = ensureElement('controls-tabs');
    this.#question = ensureElement('controls-question', 'p');
    this.#rows = ensureElement('controls-rows');
    this.#capture = ensureElement('controls-capture', 'p');
    this.#cancelBtn = ensureElement('controls-cancel-btn', 'button');
    this.#feedback = ensureElement('controls-feedback', 'p');
    // DOM order is Tab order: the rows, then the Cancel chip while a slot waits for a key.
    for (const child of [
      this.#title,
      this.#tabs,
      this.#question,
      this.#rows,
      this.#capture,
      this.#cancelBtn,
      this.#feedback,
    ]) {
      if (child.parentElement !== this.#overlay) this.#overlay.appendChild(child);
    }
    for (const shown of [this.#title, this.#tabs, this.#rows, this.#feedback]) {
      shown.style.display = '';
    }
    // The focus anchor must be focusable before the first paint (overlayA11y focuses it on open).
    this.#rows.setAttribute('tabindex', '0');
    this.#cancelBtn.addEventListener('click', () => handlers.onCancelCapture());
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none' && this.#overlay.style.display !== '';
  }

  /** The slot waiting for a key, as last painted; null when none does or the frame is closed. */
  get capturing(): SlotTarget | null {
    return this.#capturing;
  }

  /** Whether `target` is the Cancel chip (its own Enter or Space presses it, even mid-capture). */
  isCancelChip(target: unknown): boolean {
    return target === this.#cancelBtn;
  }

  show(): void {
    // Only the hidden-to-shown edge opens: a repeat show() must not re-schedule the deferred focus.
    const wasVisible = this.visible;
    this.#title.textContent = t('controls.title');
    this.#overlay.style.display = 'block';
    if (!wasVisible) openOverlayA11y('controlsView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    this.#capturing = null;
    this.#confirming = false;
    this.#feedback.textContent = '';
    for (const part of [this.#capture, this.#cancelBtn, this.#question]) {
      part.style.display = 'none';
    }
    // Deliberately unguarded (the pvpView / privacyView rule): with no open record it is a no-op.
    closeOverlayA11y('controlsView', null);
  }

  /** Write the feedback line and announce it; an unsaved change says so. */
  showFeedback(text: string, saved = true): void {
    const line = saved ? text : `${text} ${t('controls.saveFailed')}`;
    this.#feedback.textContent = line;
    this.#handlers.announce(line);
  }

  paint(p: ControlsPaint): void {
    const was = this.#capturing;
    this.#capturing = p.capturing;
    if (p.capturing !== null && !sameTarget(was, p.capturing)) {
      this.#feedback.textContent = '';
      this.#handlers.announce(capturePrompt(p.capturing.row));
    }
    if (p.request !== null && p.request !== this.#applied) {
      this.#applied = p.request;
      this.#apply(p.request);
    }
    this.#render(p);
  }

  #apply(request: ControlsRequest): void {
    switch (request.kind) {
      case 'clear': {
        const saved = this.#handlers.onClear(request.accel);
        const label = rowLabel({ kind: 'accel', id: request.accel });
        this.showFeedback(tf('controls.cleared', { label }), saved);
        break;
      }
      case 'reset':
        this.showFeedback(t('controls.reset.done'), this.#handlers.onReset());
        break;
    }
  }

  #render(p: ControlsPaint): void {
    const bindings = this.#handlers.bindings();
    renderTabs(this.#tabs, p.layout, p.nav, { frame: FRAME, label: tabLabel });
    if (p.confirm !== null) {
      renderNav(this.#rows, confirmLayout, p.confirm, {
        frame: FRAME,
        labelledBy: this.#question.id,
        fill: (el, item) => {
          delete el.dataset.slot;
          el.textContent = confirmLabel(item.key);
        },
      });
    } else {
      renderNav(this.#rows, p.layout, p.nav, {
        frame: FRAME,
        fill: (el, item) => this.#fillCell(el, p.nav.tab, item, bindings),
      });
    }

    const waiting = p.capturing;
    this.#capture.textContent = waiting === null ? '' : capturePrompt(waiting.row);
    this.#capture.style.display = waiting === null ? 'none' : '';
    this.#cancelBtn.textContent = t('controls.cancel');
    // A chip hidden while it holds focus would drop focus to <body>, outside the dialog's trap.
    if (waiting === null && document.activeElement === this.#cancelBtn) this.#rows.focus();
    this.#cancelBtn.style.display = waiting === null ? 'none' : '';

    const confirming = p.confirm !== null;
    this.#question.textContent = t('controls.reset.question');
    this.#question.style.display = confirming ? '' : 'none';
    if (confirming && !this.#confirming) this.#handlers.announce(t('controls.reset.question'));
    this.#confirming = confirming;
  }

  #fillCell(el: HTMLElement, tab: string | null, item: NavItem, bindings: Bindings): void {
    const cell = controlsItem(tab, item.key);
    switch (cell?.kind) {
      case 'slot': {
        const { row, slot } = cell.target;
        const code = slots(bindings, row)[slot];
        const key = code === undefined ? t('controls.slot.none') : glyph(code);
        const label = rowLabel(row);
        el.dataset.slot = slot === 0 ? 'primary' : 'alt';
        el.textContent =
          slot === 0
            ? tf('controls.slot.primary', { label, key })
            : tf('controls.slot.alt', { label, key });
        break;
      }
      case 'clear':
        el.dataset.slot = 'clear';
        el.textContent = tf('controls.clear', {
          label: rowLabel({ kind: 'accel', id: cell.accel }),
        });
        break;
      case 'reset':
        delete el.dataset.slot;
        el.textContent = t('controls.resetAll');
        break;
      case undefined:
        delete el.dataset.slot;
        el.textContent = '';
    }
  }
}
