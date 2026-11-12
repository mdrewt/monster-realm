// ui/tradeView.ts — the Social frame's Trades root: a thin DOM shell over the static
// `#trade-overlay`. Coverage-excluded per vite.config.ts (DOM shell; behavior validated by e2e).
//
// Every player-facing string this view renders is resolved through the i18n resolver (`t()`/`tf()`,
// ui/i18n/resolver.ts) with a key from ui/i18n/catalog.en.ts. Every `t(`/`tf(` first argument is a
// string LITERAL. The view owns no message line: a trade's outcome is a toast, routed by main.ts on
// its policy channel (uif-4b). No constructor-time strings: this view renders into the static
// index.html shell.
//
// THE SOCIAL FRAME'S PAINTER (ctl-8d, CTL8D.1-.2). The Social screen (ui/screens/socialScreen.ts)
// paints `SocialPaint` through `paintSocial(chrome, p)`. Its chrome half is the kit TabBar (uif-9,
// UIF9.1: LB chip, the `#social-tabs` strip, RB chip; the chrome's first child, so it tops whichever
// panel shows), the action sheet and the Yes / No prompt, written into the frame's shared chrome element (the first
// child of whichever panel shows) on every paint, whether or not this root shows. Its root half is
// the status line (`#trade-status`) and the trade session rows (one per session the viewer is in,
// in `#trade-sessions`): kept only while this root is visible and dropped by `hide()`. The session
// list is the one part this view adds to the root, created by the first paint that has a session
// row; a root that never had one keeps exactly the shell's children.
//
// NO CONTROL OF ITS OWN: a session row opens its editor (ui/tradeSessionView.ts), by D-pad and by
// pointer. The view reads `#trade-overlay` and `#trade-status` only; the shell's other children
// are never read or written.
import { t, tf } from './i18n/resolver';
import { list, tabs } from './nav';
import { navTabId, renderNav } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { SocialTab } from './screens/types';
import { SOCIAL_TABS, type SocialAction, type SocialSessionFacts } from './socialModel';
import { createTabBar, renderTabBar, type TabBar } from './tabBar';

/** The Yes / No question a Social action asks before it is sent. */
export type SocialQuestion = 'declineChallenge';

/** One trade session row as the Trades tab paints it: its nav key and its painted facts. */
export type SocialSessionRow = SocialSessionFacts & { readonly key: string };

/** What the Social screen paints. */
export interface SocialPaint {
  readonly tab: SocialTab;
  /** The trade session rows of the Trades tab, in order. */
  readonly sessions: readonly SocialSessionRow[];
  /** The session row key under the cursor, else null. */
  readonly sessionCursor: string | null;
  /** The action sheet: the row's legal actions and the cursor. It stays painted under its prompt. */
  readonly sheet: {
    readonly actions: readonly SocialAction[];
    readonly active: SocialAction;
  } | null;
  readonly confirm: { readonly question: SocialQuestion; readonly yes: boolean } | null;
}

/** The nav frame id of the tab strip: its tab ids (`social-tab-<tab>`) name the sheet. */
const SOCIAL_FRAME_ID = 'social';
/** The tab strip's layout: the four tabs, no rows (renderTabs reads only the keys). */
const SOCIAL_TAB_STRIP = tabs(SOCIAL_TABS.map((key) => ({ key, layout: list([]) })));
const NO_ROWS = list([]);
/** The Yes / No rows' nav keys (constants: the sheet's fill compares one, and a sink holds no
 *  string literal). */
const YES = 'yes';
const NO = 'no';
const YES_NO = list([
  { key: YES, enabled: true },
  { key: NO, enabled: true },
]);
/** The catalogued labels by nav key, as thunks (resolved per paint; ids stay literals). */
const SOCIAL_TAB_LABELS: Readonly<Record<SocialTab, () => string>> = {
  players: () => t('social.tab.players'),
  trades: () => t('social.tab.trades'),
  challenges: () => t('social.tab.challenges'),
  rankings: () => t('social.tab.rankings'),
};
const SOCIAL_ACTION_LABELS: Readonly<Record<SocialAction, () => string>> = {
  accept: () => t('social.action.accept'),
  decline: () => t('social.action.decline'),
  cancel: () => t('social.action.cancel'),
};
const SOCIAL_QUESTIONS: Readonly<Record<SocialQuestion, () => string>> = {
  declineChallenge: () => t('social.confirm.declineChallenge'),
};

/** Locate-or-create `#id` inside `parent` (a repaint creates nothing). */
function socialPart(parent: HTMLElement, id: string, tag: 'div' | 'p'): HTMLElement {
  const found = parent.querySelector<HTMLElement>(`#${id}`);
  if (found !== null) return found;
  const el = document.createElement(tag);
  el.id = id;
  parent.appendChild(el);
  return el;
}

/** The chrome's TabBar: found again by its strip, else created as the chrome's first child (the
 *  first paint makes it before the sheet and the prompt, and nothing else writes the chrome). */
function socialTabBar(chrome: HTMLElement): TabBar {
  const strip = chrome.querySelector<HTMLElement>('#social-tabs');
  const root = strip?.parentElement;
  if (strip && root) return { root, strip };
  const bar = createTabBar(document, { id: 'social-tabs' });
  chrome.prepend(bar.root);
  return bar;
}

/** Paint the Social frame's chrome: the TabBar, the sheet and the prompt. A closed sheet or
 *  prompt is rendered EMPTY as well as hidden (the e2e helpers read a root's textContent). */
function paintSocialChrome(chrome: HTMLElement, p: SocialPaint): void {
  renderTabBar(
    socialTabBar(chrome),
    SOCIAL_TAB_STRIP,
    { tab: p.tab, item: null, perTab: {} },
    { frame: SOCIAL_FRAME_ID, label: (tab) => SOCIAL_TAB_LABELS[tab.key as SocialTab]() },
  );

  const sheet = socialPart(chrome, 'social-sheet', 'div');
  const prompt = socialPart(chrome, 'social-prompt', 'div');
  const question = socialPart(prompt, 'social-prompt-text', 'p');
  const answers = socialPart(prompt, 'social-confirm', 'div');
  // A part hidden under the focus would strand it on <body>, outside the dialog's focus trap: hand
  // it to the hosting panel's anchor first (boxView's rule).
  const focused = document.activeElement;
  if (
    (p.sheet === null && sheet.contains(focused)) ||
    (p.confirm === null && prompt.contains(focused))
  ) {
    chrome.parentElement?.querySelector<HTMLElement>('[tabindex="-1"]')?.focus();
  }

  sheet.hidden = p.sheet === null;
  renderNav(
    sheet,
    p.sheet === null ? NO_ROWS : list(p.sheet.actions.map((key) => ({ key, enabled: true }))),
    { tab: null, item: p.sheet?.active ?? null, perTab: {} },
    {
      frame: 'socialSheet',
      labelledBy: navTabId(SOCIAL_FRAME_ID, p.tab),
      fill: (el, item) => {
        el.textContent = SOCIAL_ACTION_LABELS[item.key as SocialAction]();
      },
    },
  );

  const confirm = p.confirm;
  prompt.hidden = confirm === null;
  question.textContent = confirm === null ? '' : SOCIAL_QUESTIONS[confirm.question]();
  renderNav(
    answers,
    confirm === null ? NO_ROWS : YES_NO,
    { tab: null, item: confirm === null ? null : confirm.yes ? YES : NO, perTab: {} },
    {
      frame: 'socialConfirm',
      labelledBy: question.id,
      fill: (el, item) => {
        el.textContent = item.key === YES ? t('prompt.yes') : t('prompt.no');
      },
    },
  );
}

export class TradeView {
  readonly #overlay: HTMLElement;
  readonly #statusEl: HTMLElement;
  // The Social frame's paint for this root, kept only while the root is visible.
  #social: SocialPaint | null = null;
  /** The session rows' listbox: created by the first paint that has a row. */
  #sessionsEl: HTMLElement | null = null;

  constructor() {
    const el = document.getElementById('trade-overlay');
    if (!el) throw new Error('trade-overlay element not found in DOM');
    this.#overlay = el;
    this.#statusEl =
      el.querySelector('#trade-status') ??
      (() => {
        throw new Error('trade-status missing');
      })();
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    // Read visibility BEFORE the display write. `show()` is called REPEATEDLY on an
    // already-open overlay (pvpView.ts is the extreme case, main.ts:1699-1701), and a re-open
    // re-schedules overlayA11y's deferred focus -- which would yank focus back to the initial
    // anchor on every store batch. Only the hidden->visible EDGE opens.
    const wasVisible = this.visible;
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('tradeView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // A hidden root keeps no paint: no placeholder and no session row.
    this.#social = null;
    this.#applySocial();
    // DELIBERATELY UNGUARDED (see pvpView.ts's header). closeOverlayA11y is a
    // documented no-op with no open record, and leaving it unguarded is what lets a record
    // that ever desynchronised from the DOM self-heal instead of leaking a live trap forever.
    closeOverlayA11y('tradeView', null);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Host the Social frame's shared chrome (CTL8S.3): `el` becomes this root's first child. A
   *  no-op when it already is, so a repeat never detaches it (focus inside it would be lost). */
  hostChrome(el: HTMLElement): void {
    if (this.#overlay.firstElementChild !== el) this.#overlay.prepend(el);
  }

  /** The Social screen's paint (ctl-8d). The chrome is painted every time; this root keeps the
   *  paint only while it is visible. */
  paintSocial(chrome: HTMLElement, p: SocialPaint): void {
    paintSocialChrome(chrome, p);
    this.#social = this.visible ? p : null;
    this.#applySocial();
  }

  /** Write the status line and apply the kept Social paint to this root. The status reads the
   *  placeholder on the Players tab, names the session rows when the Trades tab lists any, and
   *  otherwise says there is no trade; it stays shown (it is the dialog's focus anchor). */
  #applySocial(): void {
    const p = this.#social;
    const players = p?.tab === 'players';
    const sessions = p?.tab === 'trades' ? p.sessions : [];
    this.#statusEl.textContent = players
      ? t('social.players.placeholder')
      : sessions.length > 0
        ? t('trade.status.open')
        : t('trade.status.none');
    this.#paintSessions(sessions, p?.sessionCursor ?? null);
  }

  /** The session rows, one per session, each its partner's title over both sides' marks. With no
   *  row the list is hidden (and never created). */
  #paintSessions(rows: readonly SocialSessionRow[], cursor: string | null): void {
    if (this.#sessionsEl === null) {
      if (rows.length === 0) return;
      this.#sessionsEl = document.createElement('div');
      this.#sessionsEl.id = 'trade-sessions';
      this.#sessionsEl.className = 'mr-nav-list';
      this.#overlay.appendChild(this.#sessionsEl);
    }
    const el = this.#sessionsEl;
    // A list hidden while it holds the focus would strand it on <body>.
    if (rows.length === 0 && el.contains(document.activeElement)) this.#statusEl.focus();
    el.hidden = rows.length === 0;
    const mark = (confirmed: boolean): string =>
      confirmed ? t('tradeSession.mark.confirmed') : t('tradeSession.mark.unconfirmed');
    renderNav(
      el,
      list(rows.map((row) => ({ key: row.key, enabled: true }))),
      { tab: null, item: cursor, perTab: {} },
      {
        frame: 'socialTrades',
        labelledBy: navTabId(SOCIAL_FRAME_ID, 'trades'),
        fill: (item, nav) => {
          const row = rows.find((r) => r.key === nav.key);
          if (row === undefined) return;
          const title = document.createElement('div');
          title.textContent = tf('trade.row.title', { name: row.partnerName });
          const marks = document.createElement('div');
          marks.textContent = tf('trade.row.marks', {
            mine: mark(row.mineConfirmed),
            theirs: mark(row.theirsConfirmed),
          });
          item.append(title, marks);
        },
      },
    );
  }
}
