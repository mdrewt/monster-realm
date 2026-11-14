// ui/controlsView.ts — DOM shell for Options › Controls (design §9, CTL12B.1). Fully unit-covered
// via happy-dom (the privacyView precedent), so it is NOT in `vite.config.ts` coverage.exclude.
// Every decision is `ui/screens/optionsScreen.ts`'s (the cursor, the capture, the confirm) or
// `ui/controlsModel.ts`'s (rows, labels, prompts); this file paints, and hands the shell the
// requests the screen issues.
//
// The shell is constructed, not static markup (the claimView / privacyView route). `ensureElement`
// creates every node `display:none`, so the constructor un-hides the parts that always show.
//
// `#controls-rows` is the frame's nav container (navRender: the single tab stop, the active cell
// named by `aria-activedescendant`) and the dialog's focus anchor. It always shows the active tab's
// grid or list. Each cell names its row, because a screen reader hears one cell at a time.
//
// THE KIT (uif-13, UIF13.1). The tabs are the kit TabBar under the title (its strip keeps the id
// `controls-tabs`). The Reset all confirm is the frame's one ContextSheet (confirm variant, rows
// `controls-yes` / `controls-no`), anchored in the frame away from the cursor row, which stays on
// Reset all underneath. Focus inside the frame moves into the sheet while it asks and back to
// `#controls-rows` when it closes. The Display tab (UIF13.2) lists the text-size steps, the live one
// marked `data-current`; a chosen step goes to `handlers.onTextStep` as a one-shot request.
//
// Keycaps are read from the LIVE table on every paint (`handlers.bindings`), so a remap shows in
// the paint that follows it. A request token is applied before the rows render, for the same
// reason, and applied once: the host repaints the same state on every later step.
//
// `capturing` is what the shell reads on a keydown to know a slot waits for a key. It is assigned
// first in `paint`, so a paint that throws later cannot leave the shell capturing keys for a
// capture the screen has left; `hide()` ends it on every close path.
//
// The strip (`#controls-feedback`, the shared `.mr-frame-feedback` overlay, hidden while empty) is
// this frame's hint line: main.ts's seam paints a refused key there (`showHint`) for as long as the
// capture waits. Every outcome (a bind, a swap, a cancel, Clear, Reset, a failed save) is a toast,
// routed by main.ts on its policy channel (uif-4b): the view hands Clear and Reset over through
// `handlers.onOutcome` and never picks a channel. The strip is not a live region
// (ui/liveRegion.ts owns the only one): a hint, the capture prompt and the confirm's question go to
// `handlers.announce`.
import type { Bindings } from '../input/bindings';
import type { Accel } from '../input/buttons';
import { glyph } from '../input/glyphs';
import { confirmLayout } from './actionSheetModel';
import {
  type ContextSheet,
  closeContextSheet,
  createContextSheet,
  placeContextSheet,
  renderContextSheet,
} from './contextSheet';
import { capturePrompt, rowLabel, type SlotTarget, slots } from './controlsModel';
import type { TextStep } from './displayPrefs';
import { t, tf } from './i18n/resolver';
import type { NavItem, NavTab } from './nav';
import { renderNav } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import {
  type ControlsPaint,
  type ControlsRequest,
  type ControlsScreenTab,
  type ControlsScreenView,
  controlsItem,
} from './screens/optionsScreen';
import { createTabBar, renderTabBar, type TabBar } from './tabBar';

export interface ControlsViewHandlers {
  /** The live binding table. */
  readonly bindings: () => Bindings;
  /** Unbind an accelerator; false when the new table could not be saved. */
  readonly onClear: (accel: Accel) => boolean;
  /** Restore the default table; false when it could not be saved. */
  readonly onReset: () => boolean;
  /** The live text-size step (uif-13); Normal when absent. Optional, like `onOutcome`, only for
   *  the shell rigs that never paint Display; main.ts always passes it. */
  readonly textStep?: () => TextStep;
  /** Apply and save a text-size step; false when it could not be saved. Optional as above: absent,
   *  a chosen step changes nothing and raises no outcome line. */
  readonly onTextStep?: (step: TextStep) => boolean;
  /** The Cancel chip was pressed while a slot waits for a key. */
  readonly onCancelCapture: () => void;
  /** Say `text` through the page's live region. */
  readonly announce: (text: string) => void;
  /** A Clear or Reset outcome line, and whether its table was saved: the seam routes it. Optional
   *  only for the shell rigs that never apply a request; main.ts always passes it. */
  readonly onOutcome?: (text: string, saved: boolean) => void;
}

/** An outcome line as shown: an unsaved change says so. */
export function savedLine(text: string, saved: boolean): string {
  return saved ? text : `${text} ${t('controls.saveFailed')}`;
}

/** The id prefix of the nav items and tabs (`controls-tab-buttons`, `controls-buttons-A_0`). */
const FRAME = 'controls';

// Each label is a thunk over a literal catalog id, read in the active locale.
const TAB_LABELS: Readonly<Record<ControlsScreenTab, () => string>> = {
  buttons: () => t('controls.tab.buttons'),
  shortcuts: () => t('controls.tab.shortcuts'),
  display: () => t('controls.tab.display'),
};

const tabLabel = (tab: NavTab): string =>
  Object.hasOwn(TAB_LABELS, tab.key) ? TAB_LABELS[tab.key as ControlsScreenTab]() : '';

const STEP_LABELS: Readonly<Record<TextStep, () => string>> = {
  normal: () => t('controls.text.normal'),
  large: () => t('controls.text.large'),
  xlarge: () => t('controls.text.xlarge'),
};

/** The confirm sheet's root id; its rows are `controls-yes` / `controls-no`. */
const SHEET_ID = 'controls-sheet';

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

/** The confirm sheet a previous view built, when its parts are all there. */
function locateSheet(): ContextSheet | null {
  const root = document.getElementById(SHEET_ID);
  const part = (cls: string): HTMLElement | null =>
    root?.querySelector<HTMLElement>(`:scope > .${cls}`) ?? null;
  const heading = part('mr-sheet-title');
  const prose = part('mr-sheet-prose');
  const rows = part('mr-sheet-rows');
  return root !== null && heading !== null && prose !== null && rows !== null
    ? { frame: FRAME, root, heading, prose, rows }
    : null;
}

function createSheet(): ContextSheet {
  const sheet = createContextSheet(document, { frame: FRAME });
  sheet.root.id = SHEET_ID;
  return sheet;
}

export class ControlsView implements ControlsScreenView {
  readonly #handlers: ControlsViewHandlers;
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #tabBar: TabBar;
  readonly #rows: HTMLElement;
  readonly #sheet: ContextSheet;
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
    this.#title.classList.add('mr-frame-title');
    this.#title.style.margin = '0';
    // Every kit part is located before it is created, so a second view duplicates nothing. The
    // title sits in the kit title bar (`ui/frame.ts`), first in the frame.
    const shownBar = this.#title.parentElement;
    const titleBar =
      shownBar?.classList.contains('mr-frame-titlebar') === true
        ? shownBar
        : document.createElement('div');
    titleBar.className = 'mr-frame-titlebar';
    if (this.#title.parentElement !== titleBar) titleBar.appendChild(this.#title);
    const strip = document.getElementById('controls-tabs');
    const stripRoot = strip?.parentElement;
    this.#tabBar =
      strip !== null && stripRoot?.classList.contains('mr-tabbar') === true
        ? { root: stripRoot, strip }
        : createTabBar(document, { id: 'controls-tabs' });
    this.#rows = ensureElement('controls-rows');
    this.#sheet = locateSheet() ?? createSheet();
    this.#capture = ensureElement('controls-capture', 'p');
    this.#cancelBtn = ensureElement('controls-cancel-btn', 'button');
    this.#feedback = ensureElement('controls-feedback', 'p');
    this.#feedback.classList.add('mr-frame-feedback');
    // DOM order is Tab order: the rows, then the Cancel chip while a slot waits for a key.
    for (const child of [
      titleBar,
      this.#tabBar.root,
      this.#rows,
      this.#capture,
      this.#cancelBtn,
      this.#sheet.root,
      this.#feedback,
    ]) {
      if (child.parentElement !== this.#overlay) this.#overlay.appendChild(child);
    }
    for (const shown of [this.#title, this.#rows, this.#feedback]) {
      shown.style.display = '';
    }
    this.#feedback.hidden = this.#feedback.textContent === '';
    // The focus anchor must be focusable before the first paint (overlayA11y focuses it on open).
    this.#rows.setAttribute('tabindex', '0');
    this.#cancelBtn.addEventListener('click', () => handlers.onCancelCapture());
    // Re-place the open sheet when the frame's size changes. Never disconnected: the view lives as
    // long as the page, and a hidden frame places nothing.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => this.#placeSheet()).observe(this.#overlay);
    }
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
    this.#clearHint();
    for (const part of [this.#capture, this.#cancelBtn]) {
      part.style.display = 'none';
    }
    if (!this.#sheet.root.hidden) closeContextSheet(this.#sheet);
    // Deliberately unguarded (the pvpView / privacyView rule): with no open record it is a no-op.
    closeOverlayA11y('controlsView', null);
  }

  /** Write a hint on the strip and announce it, once per call. */
  showHint(text: string): void {
    this.#feedback.textContent = text;
    this.#feedback.hidden = false;
    this.#handlers.announce(text);
  }

  #clearHint(): void {
    this.#feedback.textContent = '';
    this.#feedback.hidden = true;
  }

  paint(p: ControlsPaint): void {
    const was = this.#capturing;
    this.#capturing = p.capturing;
    if (p.capturing !== null && !sameTarget(was, p.capturing)) {
      this.#clearHint();
      this.#handlers.announce(capturePrompt(p.capturing.row));
    }
    // A hint belongs to the capture that refused the key: it ends with it.
    if (was !== null && p.capturing === null) this.#clearHint();
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
        this.#handlers.onOutcome?.(tf('controls.cleared', { label }), saved);
        break;
      }
      case 'reset':
        this.#handlers.onOutcome?.(t('controls.reset.done'), this.#handlers.onReset());
        break;
      case 'textStep': {
        const onTextStep = this.#handlers.onTextStep;
        if (onTextStep === undefined) break;
        const saved = onTextStep(request.step);
        const label = STEP_LABELS[request.step]();
        this.#handlers.onOutcome?.(tf('controls.text.set', { label }), saved);
        break;
      }
    }
  }

  #render(p: ControlsPaint): void {
    const bindings = this.#handlers.bindings();
    const step = this.#handlers.textStep?.() ?? 'normal';
    renderTabBar(this.#tabBar, p.layout, p.nav, { frame: FRAME, label: tabLabel });
    renderNav(this.#rows, p.layout, p.nav, {
      frame: FRAME,
      fill: (el, item) => this.#fillCell(el, p.nav.tab, item, bindings, step),
    });

    const waiting = p.capturing;
    this.#capture.textContent = waiting === null ? '' : capturePrompt(waiting.row);
    this.#capture.style.display = waiting === null ? 'none' : '';
    this.#cancelBtn.textContent = t('controls.cancel');
    // A chip hidden while it holds focus would drop focus to <body>, outside the dialog's trap.
    if (waiting === null && document.activeElement === this.#cancelBtn) this.#rows.focus();
    this.#cancelBtn.style.display = waiting === null ? 'none' : '';

    this.#renderConfirm(p.confirm);
  }

  /** The Reset all confirm: the frame's one sheet, shown while the screen asks. */
  #renderConfirm(confirm: ControlsPaint['confirm']): void {
    const focusInFrame = this.#overlay.contains(document.activeElement);
    const focusInSheet = this.#sheet.root.contains(document.activeElement);
    if (confirm !== null) {
      const question = t('controls.reset.question');
      renderContextSheet(this.#sheet, {
        variant: 'confirm',
        question,
        layout: confirmLayout,
        state: confirm,
        fill: (el, item) => {
          el.textContent = confirmLabel(item.key);
        },
      });
      this.#placeSheet();
      if (!this.#confirming) {
        this.#handlers.announce(question);
        if (focusInFrame) this.#sheet.rows.focus();
      }
    } else if (!this.#sheet.root.hidden) {
      // Only a shown sheet is closed: closing renders an empty nav, which marks a tab stop.
      closeContextSheet(this.#sheet);
      if (focusInSheet) this.#rows.focus();
    }
    this.#confirming = confirm !== null;
  }

  /** Anchors the shown sheet away from the cursor cell; a hidden frame (no width) places nothing. */
  #placeSheet(): void {
    if (this.#sheet.root.hidden || this.#overlay.getBoundingClientRect().width === 0) return;
    const slot = this.#rows.querySelector('.is-active') ?? this.#rows;
    placeContextSheet(this.#sheet, this.#overlay, slot);
  }

  #fillCell(
    el: HTMLElement,
    tab: string | null,
    item: NavItem,
    bindings: Bindings,
    step: TextStep,
  ): void {
    const cell = controlsItem(tab, item.key);
    delete el.dataset.current;
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
      case 'textStep': {
        delete el.dataset.slot;
        const label = STEP_LABELS[cell.step]();
        if (cell.step === step) {
          el.dataset.current = 'true';
          el.textContent = tf('controls.text.current', { label });
        } else {
          el.textContent = tf('controls.text.row', { label });
        }
        break;
      }
      case undefined:
        delete el.dataset.slot;
        el.textContent = '';
    }
  }
}
