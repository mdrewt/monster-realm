// ui/helpView.ts — thin DOM shell for How to Play (uif-14, UIF14.1, UIF14.4-UIF14.6; uif-14b,
// UIF14B.1): the kit's TabBar, the Introduction's paragraphs and its Report a problem row, the
// Encyclopedia's list and one ContextSheet for an entry's detail.
//
// Display-only: no text <input>, no submit, no reducer (A on the Introduction's Report a problem row
// is `helpScreen`'s `reportProblem` command, which `main.ts` dispatches). `render()` binds
// `helpModel`'s view model when the frame opens; `paint()` (from `helpScreen`) draws the tabs, the
// active panel, the lists' cursors and the detail. The panels are the shell's `#help-intro` and
// `#help-encyclopedia` (static, ids kept); the inactive one carries `hidden`. The Introduction's row
// is a kit list built here, `#help-intro-rows`, kept as the panel's last child after the paragraphs.
// The detail is the sheet's detail variant mounted in the overlay, which CSS centers over the list it
// keeps behind it: a phase of this frame, not a frame.
//
// The live region (ui/liveRegion.ts owns the only one) hears a tab change (its title) and an opened
// entry (its term) through the optional `announce` handler, never the first paint after an open.
// The handler is optional so a zero-arg construction (the overlay a11y wiring suite's) keeps working.
//
// Fully unit-covered via happy-dom (leaderboardView / renameView precedent) — this file is
// therefore NOT in vite.config.ts coverage.exclude.
//
// XSS firewall: every text is written through textContent (here and in the kit), NEVER innerHTML —
// the content comes from the catalog, but a future source must not be able to inject a node.
//
// The heading `#help-title` is resolved through the i18n resolver (`t('chrome.help.title')`) in
// show(), on every show(); it keeps its static `tabindex="-1"` as the overlay's
// `initialFocusSelector` anchor.

import {
  type ContextSheet,
  closeContextSheet,
  createContextSheet,
  renderContextSheet,
} from './contextSheet';
import type { EntryKey, HelpEntry, HelpViewModel } from './helpModel';
import { t, tf } from './i18n/resolver';
import { navFocus, navInit } from './nav';
import { navTabId, renderNav } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { DETAIL_LAYOUT, type HelpPaint } from './screens/helpScreen';
import { createTabBar, renderTabBar, type TabBar } from './tabBar';

const FRAME = 'help';
const TAB_STRIP_ID = 'help-tabs';
const INTRO_ROWS_ID = 'help-intro-rows';

export interface HelpViewHandlers {
  /** Say `text` through the live region. */
  readonly announce?: (text: string) => void;
}

export class HelpView {
  readonly #overlay: HTMLElement;
  /** The heading; text resolved in show(). */
  readonly #titleEl: HTMLElement;
  readonly #intro: HTMLElement;
  /** The Introduction's one-row list (Report a problem), after its paragraphs. */
  readonly #introRows: HTMLElement;
  #reportLabel = '';
  readonly #encyclopedia: HTMLElement;
  readonly #tabBar: TabBar;
  readonly #sheet: ContextSheet;
  readonly #announce: (text: string) => void;
  #titles: ReadonlyMap<string, string> = new Map();
  #entries: ReadonlyMap<EntryKey, HelpEntry> = new Map();
  /** What the last paint since the open showed; null until the first one. */
  #painted: { readonly tab: string | null; readonly detail: EntryKey | null } | null = null;

  constructor(handlers: HelpViewHandlers = {}) {
    const overlay = document.getElementById('help-overlay');
    if (!overlay) throw new Error('help-overlay element not found in DOM');
    this.#overlay = overlay;
    this.#announce = handlers.announce ?? (() => {});

    const title = overlay.querySelector<HTMLElement>('#help-title');
    if (!title) throw new Error('help-title missing');
    this.#titleEl = title;
    const intro = document.getElementById('help-intro');
    if (!intro) throw new Error('help-intro missing');
    this.#intro = intro;
    // A tab's panel; the Encyclopedia's is its listbox, which renderNav labels by its tab.
    intro.setAttribute('role', 'tabpanel');
    intro.setAttribute('aria-labelledby', navTabId(FRAME, 'intro'));
    const encyclopedia = document.getElementById('help-encyclopedia');
    if (!encyclopedia) throw new Error('help-encyclopedia missing');
    this.#encyclopedia = encyclopedia;

    // A second construction over the same shell replaces the kit parts rather than adding more.
    document.getElementById(TAB_STRIP_ID)?.closest('.mr-tabbar')?.remove();
    for (const old of overlay.querySelectorAll('[data-context-sheet]')) old.remove();
    document.getElementById(INTRO_ROWS_ID)?.remove();
    const introRows = document.createElement('ul');
    introRows.id = INTRO_ROWS_ID;
    introRows.className = 'mr-nav-list';
    intro.append(introRows);
    this.#introRows = introRows;
    this.#tabBar = createTabBar(document, { id: TAB_STRIP_ID });
    this.#tabBar.strip.setAttribute('aria-labelledby', 'help-title');
    title.after(this.#tabBar.root);
    this.#sheet = createContextSheet(document, { frame: FRAME });
    overlay.append(this.#sheet.root);
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
    if (!wasVisible) {
      // A fresh open: its first paint is the open itself, which the overlay announces.
      this.#painted = null;
      openOverlayA11y('helpView', this.#overlay);
    }
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    this.#painted = null;
    if (!this.#sheet.root.hidden) closeContextSheet(this.#sheet);
    // DELIBERATELY UNGUARDED (see pvpView.ts's header). closeOverlayA11y is a
    // documented no-op with no open record, and leaving it unguarded is what lets a record
    // that ever desynchronised from the DOM self-heal instead of leaking a live trap forever.
    closeOverlayA11y('helpView', null);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Bind `vm`: the Introduction's paragraphs now (one <p> each, rebuilt authoritatively, then its
   *  row list), and the tab titles, entries and row label for `paint`. textContent ONLY (XSS firewall). */
  render(vm: HelpViewModel): void {
    this.#titles = new Map(vm.tabs.map((tab) => [tab.tab, tab.title]));
    this.#entries = new Map(vm.entries.map((entry) => [entry.key, entry]));
    this.#reportLabel = vm.intro.report;
    const paragraphs = vm.intro.paragraphs.map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    });
    this.#intro.replaceChildren(...paragraphs, this.#introRows);
  }

  /** Draw the tabs, the active panel (the other `hidden`), the Encyclopedia's cursor and the open
   *  entry's detail, then announce what changed since the last paint of this open. */
  paint(p: HelpPaint): void {
    const tab = p.nav.tab;
    renderTabBar(this.#tabBar, p.layout, p.nav, {
      frame: FRAME,
      label: (navTab) => this.#titles.get(navTab.key) ?? '',
    });
    this.#intro.hidden = tab !== 'intro';
    this.#encyclopedia.hidden = tab !== 'encyclopedia';
    // Each tab's list at its remembered cursor while another tab shows.
    const introNav = tab === 'intro' ? p.nav : navFocus(p.layout, p.nav, { tab: 'intro' });
    renderNav(this.#introRows, p.layout, introNav, {
      frame: FRAME,
      fill: (el) => {
        el.textContent = this.#reportLabel;
      },
    });
    const listNav =
      tab === 'encyclopedia' ? p.nav : navFocus(p.layout, p.nav, { tab: 'encyclopedia' });
    renderNav(this.#encyclopedia, p.layout, listNav, {
      frame: FRAME,
      fill: (el, item) => {
        el.textContent = this.#entries.get(item.key as EntryKey)?.term ?? '';
      },
    });

    const entry = p.detail === null ? undefined : this.#entries.get(p.detail);
    const hadFocus = this.#sheet.root.contains(document.activeElement);
    if (entry === undefined) {
      if (!this.#sheet.root.hidden) closeContextSheet(this.#sheet);
      this.#sheet.root.style.top = '';
      this.#sheet.root.style.bottom = '';
      // Focus inside a sheet that closed stays in the frame, on the list it returns to.
      if (hadFocus) this.#focusPanel();
    } else {
      renderContextSheet(this.#sheet, {
        variant: 'detail',
        title: entry.term,
        prose: this.#prose(entry),
        layout: DETAIL_LAYOUT,
        state: navInit(DETAIL_LAYOUT),
        fill: (el) => {
          el.textContent = t('kit.sheet.back');
        },
      });
      if (!hadFocus) this.#sheet.rows.focus();
      this.#placeDetail();
    }

    const last = this.#painted;
    this.#painted = { tab, detail: entry === undefined ? null : entry.key };
    if (last === null) return;
    if (tab !== last.tab) this.#announce(this.#titles.get(tab ?? '') ?? '');
    else if (entry !== undefined && entry.key !== last.detail) this.#announce(entry.term);
  }

  /** The detail's text: the definition, then the related entries by their terms. */
  #prose(entry: HelpEntry): string {
    const terms = entry.related
      .map((key) => this.#entries.get(key)?.term)
      .filter((term) => term !== undefined)
      .join(', ');
    return terms === ''
      ? entry.definition
      : `${entry.definition} ${tf('help.detail.related', { terms })}`;
  }

  /** The overlay is the scroller (a long list, a large text step), and the detail is absolute in it,
   *  so its centring box (CSS `inset: 0`) is moved onto the visible part: else it opens at the scroll
   *  origin, off-screen. After the focus move, which may scroll. */
  #placeDetail(): void {
    const scrolled = this.#overlay.scrollTop;
    this.#sheet.root.style.top = `${scrolled}px`;
    this.#sheet.root.style.bottom = `${-scrolled}px`;
  }

  /** Focus the visible panel's list, else the heading anchor. */
  #focusPanel(): void {
    if (!this.#encyclopedia.hidden) this.#encyclopedia.focus();
    else this.#titleEl.focus();
  }
}
