// ui/pvpView.ts — thin DOM shell for the PvP challenge overlay.
//
// Renders PvpChallengeViewModels produced by pvpModel.ts. No game logic, no SDK.
// Its caller decides when it shows (`refresh`'s `forceVisible`); the view never shows itself.
//
// Every player-facing string this view renders is resolved through the i18n
// resolver (`t()`/`tf()`, ui/i18n/resolver.ts) with a `pvp.*` key from ui/i18n/catalog.en.ts;
// the English bytes are unchanged. Every `t(`/`tf(` first argument is a string LITERAL. The view
// owns no message line: its dead `showFeedback` and `#pvp-challenge-feedback` retired in uif-4b
// (WF1-A5), and a challenge's outcome is main.ts's, on its policy channel.
//
// The panel only RESPONDS (ctl-10b, CTL10B.2): a challenge is started face to face from the world
// (A on the player you face), never from a list here, so `#pvp-player-list` stays empty.
//
// NO CONTROL OF ITS OWN (qf-8, QF8.1): the incoming row's Accept / Decline and the outgoing row's
// Cancel Challenge buttons were a mouse-only duplicate of the Social sheet's rows and are deleted.
// The panel renders the two request labels; the Social frame (ui/screens/socialScreen.ts) hosts
// its chrome in this root (`hostChrome`), marks the request's container with its cursor
// (`paintCursor`) and answers the request from its sheet, by D-pad and by pointer.
//
// ROWS ON THE KIT (uif-9, UIF9.3-UIF9.4): each request renders as one RowCard (`ui/rowCard.ts`),
// the only child of its container, carrying the `pvp-*-label` testid e2e keys on. While the panel
// shows, a container holding a card is a nav row (`mr-nav-item`, the padding every Social row has)
// and the cursor adds `is-active` + aria-current; an empty container is no row. `hide()` clears it all.
import { t, tf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { PvpChallengeViewModel, PvpIncomingChallenge, PvpOutgoingChallenge } from './pvpModel';
import { createRowCard } from './rowCard';

/**
 * UNREAD since qf-8 (QF8.1): the lifecycle buttons these fed are deleted (see the header), and
 * with them the view-wide in-flight lock that guarded them. Kept, with its shape, so main.ts's
 * construction stays unchanged; nothing in this view calls any member.
 */
export interface PvpViewCallbacks {
  /** Unread (qf-8): accepting is the Social sheet's Accept row. */
  readonly onAccept: (challengeId: bigint) => void | Promise<void>;
  /** Unread (qf-8): declining is the Social sheet's Decline row. */
  readonly onDecline: (challengeId: bigint) => void | Promise<void>;
  /** Unread (qf-8): withdrawing is the Social sheet's Cancel row. */
  readonly onCancel: (challengeId: bigint) => void | Promise<void>;
  /** UNREAD since ctl-10b (a challenge starts face to face). Optional only because a test
   *  outside the slice's touches still passes it (residual R-ctl-10b-PVPCB). */
  readonly onChallenge?: (targetIdentity: string) => void | Promise<void>;
}

export class PvpView {
  readonly #statusEl: HTMLElement;
  readonly #incomingEl: HTMLElement;
  readonly #outgoingEl: HTMLElement;
  readonly #root: HTMLElement;
  #visible = false;
  /** The Social cursor's row, re-applied after every refresh; `hide()` drops it. */
  #cursor: 'incoming' | 'outgoing' | null = null;

  constructor(_callbacks: PvpViewCallbacks) {
    const root = document.getElementById('pvp-challenge-overlay');
    if (!root) throw new Error('pvpView: #pvp-challenge-overlay element missing from index.html');
    this.#root = root;

    const statusEl = document.getElementById('pvp-challenge-status');
    if (!statusEl)
      throw new Error('pvpView: #pvp-challenge-status element missing from index.html');
    this.#statusEl = statusEl;

    const incomingEl = document.getElementById('pvp-challenge-incoming');
    if (!incomingEl)
      throw new Error('pvpView: #pvp-challenge-incoming element missing from index.html');
    this.#incomingEl = incomingEl;

    const outgoingEl = document.getElementById('pvp-challenge-outgoing');
    if (!outgoingEl)
      throw new Error('pvpView: #pvp-challenge-outgoing element missing from index.html');
    this.#outgoingEl = outgoingEl;
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(): void {
    // THE EDGE GUARD, AND WHY IT IS LOAD-BEARING (this is the canonical statement;
    // the other nine views point here). `refresh()` below calls `show()` UNCONDITIONALLY whenever
    // `forceVisible` is true, and main.ts's PvP batch listener refreshes with it true on EVERY
    // store batch while this overlay is open. Delegating to
    // `openOverlayA11y` without the guard would therefore re-open on every batch, and a re-open
    // CLEARS AND RE-SCHEDULES the deferred initial focus (ui/overlayA11y.ts:88-89, :100-113) --
    // yanking focus back to `initialFocusSelector` several times a second and making the overlay
    // impossible to Tab through. Reading visibility BEFORE the write is the whole fix; reading it
    // after would make the guard a constant and nothing would ever open.
    const wasVisible = this.#visible;
    this.#visible = true;
    this.#root.style.display = 'block';
    if (!wasVisible) openOverlayA11y('pvpView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
    this.#cursor = null;
    this.#markRows();
    // DELIBERATELY UNGUARDED, and the asymmetry with the guarded `render(null)` path
    // in the three render-driven views is a decision, not an oversight. `closeOverlayA11y` is a
    // documented no-op when there is no open record (ui/overlayA11y.ts:136-137), so an unguarded
    // close costs one Map lookup. What it BUYS is self-healing: if a record ever desynchronises
    // from the DOM (the force-hide leak overlayA11y.ts:55-59 names), a guarded close would read
    // `visible === false`, skip, and leave a live capture listener plus a pending timer stranded
    // FOREVER. Unguarded, the next hide() clears it.
    closeOverlayA11y('pvpView', null);
  }

  /** Host the Social frame's shared chrome (CTL8S.3): `el` becomes this root's first child. A
   *  no-op when it already is, so a repeat never detaches it (focus inside it would be lost). */
  hostChrome(el: HTMLElement): void {
    if (this.#root.firstElementChild !== el) this.#root.prepend(el);
  }

  /** The Social screen's cursor on a challenge row (ctl-8d): marks the container the row shows
   *  in, by class AND aria-current, never colour alone. The containers outlive every refresh
   *  (only their children are rebuilt), and the cursor is re-applied after each; `hide()` clears it. */
  paintCursor(row: 'incoming' | 'outgoing' | null): void {
    this.#cursor = row;
    this.#markRows();
  }

  /** Mark the containers: a shown one holding a card is a row; the cursor's row is also active. */
  #markRows(): void {
    const rows = [
      ['incoming', this.#incomingEl],
      ['outgoing', this.#outgoingEl],
    ] as const;
    for (const [name, el] of rows) {
      const isRow = this.#visible && el.childElementCount > 0;
      const on = isRow && name === this.#cursor;
      el.classList.toggle('mr-nav-item', isRow);
      el.classList.toggle('is-active', on);
      if (on) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    }
  }

  /**
   * Re-render from the latest VM. The caller (main.ts's batch listener or its Social open path)
   * is fully responsible for the show/hide decision via `forceVisible` — this method
   * never auto-shows independently. This prevents pvpView from popping over an active
   * battle or other overlay (mutual exclusivity). main.ts only ever passes
   * true today: what closes the panel is its `hide()`, run by the context stack.
   *
   * Both containers are rebuilt on every refresh: they hold one RowCard each (the buttons they
   * carried are deleted, qf-8), and the Social cursor marks the containers themselves
   * (`paintCursor`), which outlive the rebuild.
   */
  refresh(vm: PvpChallengeViewModel | null, forceVisible: boolean): void {
    if (!forceVisible) {
      if (this.#visible) this.hide();
      return;
    }

    this.show();

    if (vm === null) {
      this.#statusEl.textContent = t('pvp.title.idle');
      this.#renderIncoming(null);
      this.#renderOutgoing(null);
      this.#markRows();
      return;
    }

    this.#statusEl.textContent = t('pvp.title.challenge');
    this.#renderIncoming(vm.incoming);
    this.#renderOutgoing(vm.outgoing);
    this.#markRows();
  }

  #renderIncoming(incoming: PvpIncomingChallenge | null): void {
    this.#incomingEl.replaceChildren();
    if (!incoming) return;

    const card = createRowCard(document, {
      title: tf('pvp.incoming.label', { challenger: incoming.challengerName }),
    });
    card.setAttribute('data-testid', 'pvp-incoming-label');
    this.#incomingEl.appendChild(card);
  }

  #renderOutgoing(outgoing: PvpOutgoingChallenge | null): void {
    this.#outgoingEl.replaceChildren();
    if (outgoing?.status !== 'Pending') return;

    const card = createRowCard(document, {
      title: tf('pvp.outgoing.label', { target: outgoing.targetName }),
    });
    card.setAttribute('data-testid', 'pvp-outgoing-label');
    this.#outgoingEl.appendChild(card);
  }
}
