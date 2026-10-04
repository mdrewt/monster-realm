// ui/helpView.ts — thin DOM shell for Help (ctl-14, CTL14.1): a tab strip and three panels.
//
// Display-only: no text <input>, no submit, no callbacks (zero-arg construction), no reducer. All
// content is `helpModel`'s generated view model, bound by `render()` when Help opens; `paint()`
// (from `helpScreen`) only says which tab shows. The panels are `#help-screen` (built here),
// `#help-controls` and `#help-goals` (the shell's lists, ids kept); inactive ones carry `hidden`.
// The "key names vs button names" note shows on the All controls tab only.
//
// Fully unit-covered via happy-dom (leaderboardView / renameView precedent) — this file is
// therefore NOT in vite.config.ts coverage.exclude.
//
// XSS firewall: render() paints via textContent ONLY, NEVER innerHTML — every row is generated
// from the catalog and key names, but a future source must not be able to inject a node. Each
// render() rebuilds authoritatively (replaceChildren) so no stale <li> survives.
//
// The heading `#help-title` is resolved through the i18n resolver (`t('chrome.help.title')`) in
// show(), on every show(); it keeps its static `tabindex="-1"` as the overlay's
// `initialFocusSelector` anchor.

import type { HelpTab, HelpViewModel } from './helpModel';
import { t } from './i18n/resolver';
import { navTabId, renderTabs } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { HelpPaint } from './screens/helpScreen';

const FRAME = 'help';

export class HelpView {
  readonly #overlay: HTMLElement;
  /** The heading; text resolved in show(). */
  readonly #titleEl: HTMLElement;
  readonly #strip: HTMLElement;
  readonly #panels: Readonly<Record<HelpTab, HTMLElement>>;
  readonly #note: HTMLElement;
  #titles: ReadonlyMap<string, string> = new Map();

  constructor() {
    const overlay = document.getElementById('help-overlay');
    if (!overlay) throw new Error('help-overlay element not found in DOM');
    this.#overlay = overlay;

    const title = overlay.querySelector<HTMLElement>('#help-title');
    if (!title) throw new Error('help-title missing');
    this.#titleEl = title;

    const controls = document.getElementById('help-controls');
    if (!controls) throw new Error('help-controls missing');
    const goals = document.getElementById('help-goals');
    if (!goals) throw new Error('help-goals missing');

    // Built once: a second construction over the same shell reuses them by id.
    this.#strip = ensureChild('help-tabs', 'div', () => title);
    this.#strip.className = 'mr-frame-tabstrip';
    this.#strip.setAttribute('aria-labelledby', 'help-title');
    const screen = ensureChild('help-screen', 'ul', () => this.#strip);
    this.#note = ensureChild('help-note', 'p', () => controls);
    this.#panels = { screen, controls, goals };
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    // Read visibility BEFORE the display write. `show()` may be called on an
    // already-open overlay (pvpView.ts is the extreme case), and a re-open
    // re-schedules overlayA11y's deferred focus -- which would yank focus back to the initial
    // anchor on every store batch. Only the hidden->visible EDGE opens.
    const wasVisible = this.visible;
    // The heading is resolved HERE, on EVERY show() — unconditionally,
    // after the `wasVisible` read, before the display write (see
    // evolutionView.show() for the boot-order / locale-switch reasoning).
    this.#titleEl.textContent = t('chrome.help.title');
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('helpView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // DELIBERATELY UNGUARDED (see pvpView.ts's header). closeOverlayA11y is a
    // documented no-op with no open record, and leaving it unguarded is what lets a record
    // that ever desynchronised from the DOM self-heal instead of leaking a live trap forever.
    closeOverlayA11y('helpView', null);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Rebuild every panel from `vm`: one <li> per row, its keys (each a <kbd>) then its action.
   *  textContent ONLY (XSS firewall); the tab titles and the note are kept for `paint`. */
  render(vm: HelpViewModel): void {
    this.#titles = new Map(vm.tabs.map((tab) => [tab.tab, tab.title]));
    this.#note.textContent = vm.note;
    for (const tab of vm.tabs) {
      const items = tab.rows.map((row) => {
        const li = document.createElement('li');
        for (const key of row.keys) {
          const kbd = document.createElement('kbd');
          kbd.textContent = key;
          li.append(kbd, ' ');
        }
        const action = document.createElement('span');
        action.textContent = row.action;
        li.append(action);
        return li;
      });
      this.#panels[tab.tab].replaceChildren(...items);
    }
  }

  /** Show the active tab: the strip marks it, and only its panel (named by its tab) and, on All
   *  controls, the note are not `hidden`. */
  paint(p: HelpPaint): void {
    renderTabs(this.#strip, p.layout, p.nav, {
      frame: FRAME,
      label: (tab) => this.#titles.get(tab.key) ?? '',
    });
    for (const [tab, panel] of Object.entries(this.#panels)) {
      panel.hidden = tab !== p.nav.tab;
      panel.setAttribute('aria-labelledby', navTabId(FRAME, tab));
    }
    this.#note.hidden = p.nav.tab !== 'controls';
  }
}

/** The element `id` (a `tag`), created and placed right after `prev()` when the shell lacks it. */
function ensureChild<K extends keyof HTMLElementTagNameMap>(
  id: string,
  tag: K,
  prev: () => HTMLElement,
): HTMLElement {
  const found = document.getElementById(id);
  if (found !== null) return found;
  const el = document.createElement(tag);
  el.id = id;
  prev().after(el);
  return el;
}
