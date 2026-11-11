// ui/tradeSessionView.ts — the trade session editor's DOM shell (M-trade-sessions ts-3).
// It paints what `screens/tradeSessionScreen.ts` hands it and holds nothing of its own: no draft, no
// lock, no reducer. Every control is a nav-kit listbox row, so the D-pad and A / B drive all of it
// and the pointer reaches the same rows through the kit.
//
// The dialog root is the static `#tradepropose-overlay` shell of index.html. ONCE, at construction,
// the shell's other static children are removed and the editor's parts are built before its static
// button, which stays as the Close control; nothing empties the root again, because the a11y layer
// adopts the live region into an open dialog's root.
//
// The Close button is the dialog's registered focus anchor (ui/overlayRegistry.ts): a native
// control that is enabled and shown in every state, so the focus trap always has a target. The
// player does not start on it: the first paint after an open puts focus on the picker listbox, and
// the a11y layer's deferred anchor focus, finding focus already inside the dialog, leaves it there.
//
// Player-controlled text (names, nicknames) is written with textContent only, never innerHTML. Every
// string this view owns is resolved through the i18n resolver with a literal key.
import { t, tf } from './i18n/resolver';
import { list, type NavItem } from './nav';
import { renderNav } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { TradeSessionPrompt } from './screens/tradeSessionScreen';
import type {
  SessionSideVm,
  TradeOfferDraft,
  TradeSessionScreenVm,
  TradeSessionVm,
} from './tradeSessionModel';

export interface TradeSessionViewDeps {
  /** Speak a line through the page's live region (the "offer changed" notice). */
  readonly announce: (text: string) => void;
  /** The Close button was activated: close the editor (the session stays open). */
  readonly onClose: () => void;
}

/** What the editor screen paints. */
export interface TradeSessionPaint {
  readonly vm: TradeSessionScreenVm;
  /** The picker and action rows, in order (`editorRows`). */
  readonly rows: readonly NavItem[];
  /** The viewer's unsent side: what the picker rows show as offered. */
  readonly draft: TradeOfferDraft;
  /** The row key under the cursor. */
  readonly cursor: string | null;
  /** 0: no notice; a greater number than the last one announced is announced once. */
  readonly notice: number;
  readonly prompt: TradeSessionPrompt | null;
}

const NO_ROWS = list([]);
const YES = 'yes';
const NO = 'no';
const YES_NO = list([
  { key: YES, enabled: true },
  { key: NO, enabled: true },
]);
const MONSTER = 'monster-';
const ITEM = 'item-';

function part<K extends keyof HTMLElementTagNameMap>(tag: K, id: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.id = id;
  el.dataset.testid = id;
  return el;
}

/** The catalogued phrase for a disabled row's reason; '' for one this view does not know. */
function reasonText(reason: string | undefined): string {
  switch (reason) {
    case 'fainted':
      return t('tradeSession.reason.fainted');
    case 'inAnotherTrade':
      return t('tradeSession.reason.inAnotherTrade');
    case 'inBattle':
      return t('tradeSession.reason.inBattle');
    case 'limit':
      return t('tradeSession.reason.limit');
    case 'unsent':
      return t('tradeSession.reason.unsent');
    case 'nothingToSend':
      return t('tradeSession.reason.nothingToSend');
    default:
      return '';
  }
}

/** The Yes / No question a prompt asks; '' with no prompt. */
function promptQuestion(prompt: TradeSessionPrompt | null): string {
  if (prompt === null) return '';
  return prompt.action === 'cancel'
    ? t('tradeSession.prompt.cancel')
    : t('tradeSession.prompt.confirm');
}

export class TradeSessionView {
  readonly #root: HTMLElement;
  readonly #deps: TradeSessionViewDeps;
  readonly #title: HTMLElement;
  readonly #notice: HTMLElement;
  readonly #mine: HTMLElement;
  readonly #theirs: HTMLElement;
  readonly #rows: HTMLElement;
  readonly #prompt: HTMLElement;
  readonly #promptText: HTMLElement;
  readonly #answers: HTMLElement;
  readonly #close: HTMLButtonElement;
  /** The notice count last announced; a paint of 0 and hide() forget it. */
  #announced = 0;
  /** Armed by an open: the next paint of a session focuses the picker listbox, once. */
  #focusRows = false;

  constructor(deps: TradeSessionViewDeps) {
    const root = document.getElementById('tradepropose-overlay');
    if (!root) throw new Error('tradepropose-overlay element not found in DOM');
    const close = root.querySelector<HTMLButtonElement>('#tradepropose-submit');
    if (!close) throw new Error('tradepropose-submit missing');
    this.#root = root;
    this.#deps = deps;
    this.#close = close;
    // A 24px target at the default root size (WCAG 2.2 target-size), no wider than its label.
    close.style.minHeight = '1.5rem';
    close.style.alignSelf = 'flex-start';
    // The button keeps its own keys (Enter and Space are its click, never the router's A); Escape
    // is routed in the capture phase anyway and is let through.
    close.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') e.stopPropagation();
    });
    close.addEventListener('click', () => {
      this.#deps.onClose();
    });

    this.#title = part('h2', 'tradesession-title');
    this.#notice = part('p', 'tradesession-notice');
    this.#notice.hidden = true;
    this.#mine = part('div', 'tradesession-mine');
    this.#theirs = part('div', 'tradesession-theirs');
    // The picker grows and scrolls inside the frame with the kit's cue; the sides sit above it.
    this.#rows = part('div', 'tradesession-rows');
    this.#rows.className = 'mr-nav-list mr-scroll';
    this.#prompt = part('div', 'tradesession-prompt');
    this.#prompt.hidden = true;
    this.#promptText = part('p', 'tradesession-prompt-text');
    this.#answers = part('div', 'tradesession-confirm');
    this.#answers.className = 'mr-nav-list';
    this.#prompt.append(this.#promptText, this.#answers);
    // The shell's other static children go; the Close button stays, last.
    root.replaceChildren(
      this.#title,
      this.#notice,
      this.#mine,
      this.#theirs,
      this.#rows,
      this.#prompt,
      close,
    );
    // The listbox takes its role and tab stop before the first paint.
    this.#paintRows([], null, null, { monsterIds: [], items: [], currency: 0n });
  }

  get visible(): boolean {
    return this.#root.style.display !== 'none';
  }

  show(): void {
    // Only the hidden->visible edge opens: a repeat would re-schedule the a11y layer's initial
    // focus and pull it back to the anchor.
    const wasVisible = this.visible;
    // Resolved at every show, so a locale switch between opens is picked up.
    this.#close.textContent = t('kit.sheet.close');
    this.#root.style.display = '';
    if (!wasVisible) {
      openOverlayA11y('tradeSessionView', this.#root);
      this.#focusRows = true;
    }
  }

  hide(): void {
    this.#root.style.display = 'none';
    this.#announced = 0;
    this.#focusRows = false;
    // Unguarded on purpose: with no open record this is a no-op, and a record that ever drifted
    // from the DOM heals here instead of leaving a live focus trap.
    closeOverlayA11y('tradeSessionView', null);
  }

  /** Paint the editor. A `gone` vm leaves the last session on screen (main.ts closes the frame on
   *  the batch that removed the row). */
  paint(p: TradeSessionPaint): void {
    const { vm } = p;
    if (vm.kind === 'gone') return;
    this.#root.dataset.sessionId = vm.sessionId.toString();
    this.#root.dataset.revision = vm.revision.toString();
    this.#title.textContent = tf('tradeSession.title', { name: vm.partnerName });

    const raised = p.notice > 0;
    this.#notice.hidden = !raised;
    this.#notice.textContent = raised ? t('tradeSession.notice.changed') : '';
    if (!raised) this.#announced = 0;
    else if (p.notice > this.#announced) {
      this.#announced = p.notice;
      this.#deps.announce(t('tradeSession.notice.changed'));
    }

    this.#paintSide(this.#mine, vm.mine, t('tradeSession.side.mine'));
    this.#paintSide(this.#theirs, vm.theirs, t('tradeSession.side.theirs'));
    this.#paintRows(p.rows, p.cursor, vm, p.draft);
    this.#paintPrompt(p.prompt);
    if (this.#focusRows) {
      this.#focusRows = false;
      this.#rows.focus();
    }
  }

  #paintSide(el: HTMLElement, side: SessionSideVm, heading: string): void {
    const h = document.createElement('h3');
    h.textContent = heading;
    const mark = document.createElement('p');
    mark.dataset.part = 'mark';
    mark.dataset.confirmed = side.confirmed ? 'true' : 'false';
    mark.textContent = side.confirmed
      ? t('tradeSession.mark.confirmed')
      : t('tradeSession.mark.unconfirmed');
    const parts: HTMLElement[] = [h, mark];

    if (side.cards.length > 0) {
      const ul = document.createElement('ul');
      ul.dataset.section = 'monsters';
      ul.className = 'mr-nav-list';
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
      parts.push(ul);
    }
    if (side.items.length > 0) {
      const ul = document.createElement('ul');
      ul.dataset.section = 'items';
      ul.className = 'mr-nav-list';
      for (const item of side.items) {
        const li = document.createElement('li');
        li.dataset.itemId = item.itemId.toString();
        li.textContent = `${item.name} ×${item.qty}`;
        ul.appendChild(li);
      }
      parts.push(ul);
    }
    if (side.currency > 0n) {
      const coins = document.createElement('p');
      coins.dataset.currency = side.currency.toString();
      coins.textContent = tf('trade.side.currency', { amount: side.currency });
      parts.push(coins);
    }
    if (side.cards.length === 0 && side.items.length === 0 && side.currency === 0n) {
      const nothing = document.createElement('p');
      nothing.textContent = t('trade.side.nothing');
      parts.push(nothing);
    }
    el.replaceChildren(...parts);
  }

  #paintRows(
    rows: readonly NavItem[],
    cursor: string | null,
    vm: TradeSessionVm | null,
    draft: TradeOfferDraft,
  ): void {
    renderNav(
      this.#rows,
      list(rows),
      { tab: null, item: cursor, perTab: {} },
      {
        frame: 'tradeSession',
        labelledBy: this.#title.id,
        fill: (el, item) => {
          const offered = vm !== null && this.#isOffered(item.key, draft);
          if (offered) el.setAttribute('aria-checked', 'true');
          else el.removeAttribute('aria-checked');
          const label = vm === null ? '' : this.#rowLabel(item.key, vm, draft);
          el.textContent = item.enabled
            ? label
            : tf('tradeSession.row.blocked', { label, reason: reasonText(item.reason) });
        },
      },
    );
  }

  #isOffered(key: string, draft: TradeOfferDraft): boolean {
    return (
      key.startsWith(MONSTER) &&
      draft.monsterIds.some((id) => id.toString() === key.slice(MONSTER.length))
    );
  }

  /** A row's own words: the monster's label, the item or coin line, or the action. */
  #rowLabel(key: string, vm: TradeSessionVm, draft: TradeOfferDraft): string {
    if (key.startsWith(MONSTER)) {
      const id = key.slice(MONSTER.length);
      return vm.monsters.find((m) => m.monsterId.toString() === id)?.label ?? '';
    }
    if (key.startsWith(ITEM)) {
      const id = key.slice(ITEM.length);
      const item = vm.items.find((i) => i.itemId.toString() === id);
      if (item === undefined) return '';
      const qty = draft.items.find((line) => line.itemId === item.itemId)?.qty ?? 0;
      return tf('tradeSession.row.item', { name: item.name, qty, held: item.held });
    }
    switch (key) {
      case 'coins':
        return tf('tradeSession.row.coins', { amount: draft.currency, balance: vm.balance });
      case 'apply':
        return t('tradeSession.row.apply');
      case 'confirm':
        return t('tradeSession.row.confirm');
      case 'cancel':
        return t('tradeSession.row.cancel');
      default:
        return '';
    }
  }

  #paintPrompt(prompt: TradeSessionPrompt | null): void {
    // A part hidden under the focus would strand it on <body>, outside the dialog's focus trap.
    if (prompt === null && this.#prompt.contains(document.activeElement)) this.#rows.focus();
    this.#prompt.hidden = prompt === null;
    this.#promptText.textContent = promptQuestion(prompt);
    renderNav(
      this.#answers,
      prompt === null ? NO_ROWS : YES_NO,
      { tab: null, item: prompt === null ? null : prompt.yes ? YES : NO, perTab: {} },
      {
        frame: 'tradeSessionConfirm',
        labelledBy: this.#promptText.id,
        fill: (el, item) => {
          el.textContent = item.key === YES ? t('prompt.yes') : t('prompt.no');
        },
      },
    );
  }
}
