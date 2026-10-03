// ui/tradeView.ts — thin DOM shell for the trade overlay.
// Pure rendering from TradeScreenViewModel. No logic — all logic is in tradeModel.ts.
// Coverage-excluded per vite.config.ts (DOM shell; behavior validated by e2e).
//
// Every player-facing string this view renders is resolved through the i18n
// resolver (`t()`/`tf()`, ui/i18n/resolver.ts) with a `trade.*` key from ui/i18n/catalog.en.ts —
// the `#renderSide` heading arguments and the `#actionLabel` returns included; the English bytes
// are unchanged (the catalog pins them). The item row `${item.name} ×${item.qty}` is deliberately
// NOT keyed — a glyph-only compound (tier (e)). `vm.statusLabel` and the
// `showFeedback` message are model data, rendered raw. Every `t(`/`tf(` first argument is a
// string LITERAL. No constructor-time strings: this view renders into the static index.html shell.
//
// THE SOCIAL FRAME'S PAINTER (ctl-8d, CTL8D.1-.2). The Social screen (ui/screens/socialScreen.ts)
// paints `SocialPaint` through `paintSocial(chrome, p)`. Its chrome half is the tab strip, the
// action sheet and the Yes / No prompt, written into the frame's shared chrome element (the first
// child of whichever panel shows) on every paint, whether or not this root shows. Its root half is
// the Players placeholder and the trade row's cursor on `#trade-status`: kept only while this root
// is visible, re-applied after every batch render and dropped by `hide()`. This root's own
// children stay exactly the shell's: every new part lives in the chrome.
import { t, tf } from './i18n/resolver';
import { list, tabs } from './nav';
import { navTabId, renderNav, renderTabs } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { SocialTab } from './screens/types';
import { SOCIAL_TABS, type SocialAction } from './socialModel';
import type { TradeAction, TradeScreenViewModel, TradeSideViewModel } from './tradeModel';

/** The Yes / No question a Social action asks before it is sent. */
export type SocialQuestion = 'declineTrade' | 'confirmTrade' | 'declineChallenge';

/** What the Social screen paints. */
export interface SocialPaint {
  readonly tab: SocialTab;
  /** The trade row holds the cursor (the Trades tab, with a trade listed). */
  readonly tradeCursor: boolean;
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
  confirm: () => t('social.action.confirm'),
  cancel: () => t('social.action.cancel'),
};
const SOCIAL_QUESTIONS: Readonly<Record<SocialQuestion, () => string>> = {
  declineTrade: () => t('social.confirm.declineTrade'),
  confirmTrade: () => t('social.confirm.confirmTrade'),
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

/** Paint the Social frame's chrome: the tab strip, the sheet and the prompt. A closed sheet or
 *  prompt is rendered EMPTY as well as hidden (the e2e helpers read a root's textContent). */
function paintSocialChrome(chrome: HTMLElement, p: SocialPaint): void {
  const strip = socialPart(chrome, 'social-tabs', 'div');
  strip.className = 'mr-frame-tabstrip';
  renderTabs(
    strip,
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

export interface TradeCallbacks {
  readonly onAccept: (tradeId: bigint) => Promise<void>;
  readonly onReject: (tradeId: bigint) => Promise<void>;
  readonly onConfirm: (tradeId: bigint) => Promise<void>;
  readonly onCancel: (tradeId: bigint) => Promise<void>;
}

export class TradeView {
  readonly #overlay: HTMLElement;
  readonly #statusEl: HTMLElement;
  readonly #mySideEl: HTMLElement;
  readonly #theirSideEl: HTMLElement;
  readonly #actionsEl: HTMLElement;
  readonly #feedbackEl: HTMLElement;
  readonly #cbs: TradeCallbacks;
  // In-flight lock: prevents double-send when a reducer Promise is pending.
  #pending = false;
  // Tracks the last rendered offer key (tradeId + statusLabel) to detect state
  // changes and clear stale feedback.
  #lastRenderKey: string | null = null;
  // The Social frame's paint for this root, kept only while the root is visible, and the status
  // text the last render wrote (the Players placeholder is written over it).
  #social: SocialPaint | null = null;
  #status = '';

  constructor(cbs: TradeCallbacks) {
    const el = document.getElementById('trade-overlay');
    if (!el) throw new Error('trade-overlay element not found in DOM');
    this.#overlay = el;
    this.#statusEl =
      el.querySelector('#trade-status') ??
      (() => {
        throw new Error('trade-status missing');
      })();
    this.#mySideEl =
      el.querySelector('#trade-my-side') ??
      (() => {
        throw new Error('trade-my-side missing');
      })();
    this.#theirSideEl =
      el.querySelector('#trade-their-side') ??
      (() => {
        throw new Error('trade-their-side missing');
      })();
    this.#actionsEl =
      el.querySelector('#trade-actions') ??
      (() => {
        throw new Error('trade-actions missing');
      })();
    this.#feedbackEl =
      el.querySelector('#trade-feedback') ??
      (() => {
        throw new Error('trade-feedback missing');
      })();
    this.#cbs = cbs;
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
    this.#feedbackEl.textContent = '';
    this.#pending = false;
    this.#lastRenderKey = null;
    // A hidden root holds no placeholder, no hidden part and no cursor mark.
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

  /** Render or re-render the trade view from the view model. */
  render(vm: TradeScreenViewModel): void {
    if (vm.kind === 'no-trade') {
      this.#status = t('trade.status.none');
      this.#mySideEl.replaceChildren();
      this.#theirSideEl.replaceChildren();
      this.#actionsEl.replaceChildren();
      this.#lastRenderKey = null;
      this.#applySocial();
      return;
    }

    // Clear stale feedback on offer-state change: a status
    // transition (Pending → ConfirmedByCounterparty, or a new tradeId) means the
    // prior "Trade accepted!" / "Trade rejected." is no longer meaningful.
    const renderKey = `${vm.tradeId}-${vm.statusLabel}`;
    if (renderKey !== this.#lastRenderKey) {
      this.#feedbackEl.textContent = '';
      this.#lastRenderKey = renderKey;
    }

    this.#status = vm.statusLabel;
    this.#renderSide(this.#mySideEl, vm.mySide, t('trade.side.offer'));
    this.#renderSide(this.#theirSideEl, vm.theirSide, t('trade.side.receive'));
    this.#renderActions(vm.tradeId, vm.actions);
    this.#applySocial();
  }

  /** The Social screen's paint (ctl-8d). The chrome is painted every time; this root keeps the
   *  paint only while it is visible, so the next batch render re-applies it. */
  paintSocial(chrome: HTMLElement, p: SocialPaint): void {
    paintSocialChrome(chrome, p);
    this.#social = this.visible ? p : null;
    this.#applySocial();
  }

  /** Write the status line and apply the kept Social paint to this root. On the Players tab the
   *  status reads the placeholder and the sides and actions are hidden; the status stays shown
   *  (it is the dialog's focus anchor) and so does the feedback line (a trade result must not
   *  vanish). The trade row's cursor is marked on the status by class AND aria-current, never
   *  colour alone. With no paint the root is exactly the legacy trade overlay. */
  #applySocial(): void {
    const p = this.#social;
    const players = p?.tab === 'players';
    this.#statusEl.textContent = players ? t('social.players.placeholder') : this.#status;
    for (const el of [this.#mySideEl, this.#theirSideEl, this.#actionsEl]) {
      // A part hidden under the focus (a Tab-focused legacy button) would strand it on <body>.
      if (players && el.contains(document.activeElement)) this.#statusEl.focus();
      el.hidden = players;
    }
    const cursor = p?.tab === 'trades' && p.tradeCursor;
    this.#statusEl.classList.toggle('mr-nav-item', cursor);
    this.#statusEl.classList.toggle('is-active', cursor);
    if (cursor) this.#statusEl.setAttribute('aria-current', 'true');
    else this.#statusEl.removeAttribute('aria-current');
  }

  /** Display a feedback message (reducer success/failure). */
  showFeedback(message: string): void {
    this.#feedbackEl.textContent = message;
  }

  #renderSide(el: HTMLElement, side: TradeSideViewModel, heading: string): void {
    el.replaceChildren();
    const h = document.createElement('h4');
    h.textContent = heading;
    el.appendChild(h);

    if (side.cards.length > 0) {
      const ul = document.createElement('ul');
      ul.dataset.section = 'monsters';
      for (const card of side.cards) {
        const li = document.createElement('li');
        li.dataset.monsterId = card.monsterId.toString();
        li.textContent = tf('trade.side.card', {
          nickname: card.nickname,
          species: card.speciesName,
          level: card.level,
          current: card.currentHp,
          max: card.statHp,
        });
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }

    if (side.items.length > 0) {
      const ul = document.createElement('ul');
      ul.dataset.section = 'items';
      for (const item of side.items) {
        const li = document.createElement('li');
        li.textContent = `${item.name} ×${item.qty}`;
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }

    if (side.currency > 0n) {
      const p = document.createElement('p');
      p.dataset.currency = side.currency.toString();
      p.textContent = tf('trade.side.currency', { amount: side.currency });
      el.appendChild(p);
    }

    if (side.cards.length === 0 && side.items.length === 0 && side.currency === 0n) {
      const p = document.createElement('p');
      p.textContent = t('trade.side.nothing');
      el.appendChild(p);
    }
  }

  #renderActions(tradeId: bigint, actions: readonly TradeAction[]): void {
    this.#actionsEl.replaceChildren();
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.dataset.action = action;
      btn.textContent = this.#actionLabel(action);
      // Render disabled when in-flight so a mid-flight batch re-render
      // doesn't re-enable buttons while a reducer Promise is still pending.
      btn.disabled = this.#pending;
      btn.addEventListener('click', () => {
        if (this.#pending) return;
        this.#pending = true;
        btn.disabled = true;
        void Promise.resolve(this.#dispatch(action, tradeId)).finally(() => {
          this.#pending = false;
          // Re-enable all live buttons — the captured `btn` closure reference may be
          // orphaned if render() was called mid-flight (replaceChildren() detaches it).
          for (const b of this.#actionsEl.querySelectorAll<HTMLButtonElement>('button')) {
            b.disabled = false;
          }
        });
      });
      this.#actionsEl.appendChild(btn);
    }
  }

  #actionLabel(action: TradeAction): string {
    switch (action) {
      case 'accept':
        return t('trade.action.accept');
      case 'reject':
        return t('trade.action.reject');
      case 'confirm':
        return t('trade.action.confirm');
      case 'cancel':
        return t('trade.action.cancel');
    }
  }

  #dispatch(action: TradeAction, tradeId: bigint): Promise<void> {
    switch (action) {
      case 'accept':
        return this.#cbs.onAccept(tradeId);
      case 'reject':
        return this.#cbs.onReject(tradeId);
      case 'confirm':
        return this.#cbs.onConfirm(tradeId);
      case 'cancel':
        return this.#cbs.onCancel(tradeId);
    }
  }
}
