// ui/pvpView.ts — thin DOM shell for the PvP challenge overlay.
//
// Renders PvpChallengeViewModels produced by pvpModel.ts. No game logic, no SDK.
// Its caller decides when it shows (`refresh`'s `forceVisible`); the view never shows itself.
//
// Every player-facing string this view renders is resolved through the i18n
// resolver (`t()`/`tf()`, ui/i18n/resolver.ts) with a `pvp.*` key from ui/i18n/catalog.en.ts;
// the English bytes are unchanged. Two sinks stay raw on purpose: the per-player challenge
// button shows `p.name` (model data) and `showFeedback(msg)` renders text that
// main.ts owns (S6 migrates it there). Every `t(`/`tf(` first argument is a string LITERAL — the
// player-list heading is a ternary between two CALLS, never between two keys.
import { t, tf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { PvpChallengeViewModel, PvpIncomingChallenge, PvpOutgoingChallenge } from './pvpModel';

/**
 * All four may return a promise: the view-wide lifecycle lock is held until it
 * settles, so the return type must express it — a `=> void` type would let a future
 * implementation silently reduce the lock to a one-microtask no-op (raisingView's onCare
 * makes the same argument). The four reducers are duplicate-safe server-side; this is
 * defensive polish so one intent never becomes two calls or a contradictory pair.
 */
export interface PvpViewCallbacks {
  /** Accept an incoming challenge. */
  readonly onAccept: (challengeId: bigint) => void | Promise<void>;
  /** Decline an incoming challenge. */
  readonly onDecline: (challengeId: bigint) => void | Promise<void>;
  /** Cancel an outgoing challenge. */
  readonly onCancel: (challengeId: bigint) => void | Promise<void>;
  /** Send a challenge to target player. */
  readonly onChallenge: (targetIdentity: string) => void | Promise<void>;
}

export class PvpView {
  readonly #statusEl: HTMLElement;
  readonly #incomingEl: HTMLElement;
  readonly #outgoingEl: HTMLElement;
  readonly #playerListEl: HTMLElement;
  readonly #feedbackEl: HTMLElement;
  readonly #callbacks: PvpViewCallbacks;
  readonly #root: HTMLElement;
  #visible = false;
  // ONE view-wide lock for the four lifecycle actions, deliberately not keyed by
  // challengeId — accept/decline/cancel/challenge all mutate the same single challenge
  // state, and a per-button lock would still admit accept-then-decline on one challenge
  // (the contradictory-outcome pair). The object is the generation token: `.finally()`
  // releases only if the stored lock is still its own, so a stale promise (click →
  // force-hide cleared → re-show → click again → first settles) cannot release the second.
  #pending: object | null = null;
  // What each dynamic container shows now, as a render key; no entry = nothing current (hidden,
  // or the bare shell). main.ts refreshes on every store batch: a container whose key is unchanged
  // keeps its nodes, so a batch neither drops focus from a control nor loses a click in progress.
  readonly #rendered = new Map<HTMLElement, string>();

  constructor(callbacks: PvpViewCallbacks) {
    this.#callbacks = callbacks;

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

    const playerListEl = document.getElementById('pvp-player-list');
    if (!playerListEl) throw new Error('pvpView: #pvp-player-list element missing from index.html');
    this.#playerListEl = playerListEl;

    const feedbackEl = document.getElementById('pvp-challenge-feedback');
    if (!feedbackEl)
      throw new Error('pvpView: #pvp-challenge-feedback element missing from index.html');
    this.#feedbackEl = feedbackEl;
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
    this.#feedbackEl.textContent = '';
    // Release the lifecycle lock (tradeProposeView hide()-time precedent): onReconnect
    // and the battle auto-show force-hide this overlay, and the SDK never settles an in-flight
    // reducer promise after a link drop — so `.finally()` may never run. No node re-enable:
    // `show()` is only reached through refresh(), which rebuilds every lifecycle control once
    // what was rendered is forgotten.
    this.#pending = null;
    this.#rendered.clear();
    this.paintCursor(null);
    // DELIBERATELY UNGUARDED, and the asymmetry with the guarded `render(null)` path
    // in the three render-driven views is a decision, not an oversight. `closeOverlayA11y` is a
    // documented no-op when there is no open record (ui/overlayA11y.ts:136-137), so an unguarded
    // close costs one Map lookup. What it BUYS is self-healing: if a record ever desynchronises
    // from the DOM (the force-hide leak overlayA11y.ts:55-59 names), a guarded close would read
    // `visible === false`, skip, and leave a live capture listener plus a pending timer stranded
    // FOREVER. Unguarded, the next hide() clears it.
    closeOverlayA11y('pvpView', null);
  }

  showFeedback(msg: string): void {
    this.#feedbackEl.textContent = msg;
  }

  /** Host the Social frame's shared chrome (CTL8S.3): `el` becomes this root's first child. A
   *  no-op when it already is, so a repeat never detaches it (focus inside it would be lost). */
  hostChrome(el: HTMLElement): void {
    if (this.#root.firstElementChild !== el) this.#root.prepend(el);
  }

  /** The Social screen's cursor on a challenge row (ctl-8d): marks the container the row shows
   *  in, by class AND aria-current, never colour alone. The containers outlive every refresh
   *  (only their children are rebuilt), so the mark does too; `hide()` clears it. */
  paintCursor(row: 'incoming' | 'outgoing' | null): void {
    const rows = [
      ['incoming', this.#incomingEl],
      ['outgoing', this.#outgoingEl],
    ] as const;
    for (const [name, el] of rows) {
      const on = name === row;
      el.classList.toggle('mr-nav-item', on);
      el.classList.toggle('is-active', on);
      if (on) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    }
  }

  /**
   * Re-render from the latest VM. The caller (main.ts's batch listener or its Social open path)
   * is fully responsible for the show/hide decision via `forceVisible` — this method
   * never auto-shows independently. This prevents pvpView from popping over an active
   * battle or other overlay when hasActive=true (mutual exclusivity). main.ts only ever passes
   * true today: what closes the panel is its `hide()`, run by the context stack.
   *
   * Each container is rebuilt only when what it shows changed (`#renderIfChanged`).
   */
  refresh(vm: PvpChallengeViewModel | null, forceVisible: boolean): void {
    const hasActive = vm !== null && (vm.incoming !== null || vm.outgoing !== null);

    if (!forceVisible) {
      if (this.#visible) this.hide();
      return;
    }

    this.show();

    if (vm === null) {
      this.#statusEl.textContent = t('pvp.title.idle');
      this.#incomingEl.replaceChildren();
      this.#outgoingEl.replaceChildren();
      this.#playerListEl.replaceChildren();
      this.#rendered.clear();
      return;
    }

    this.#statusEl.textContent = t('pvp.title.challenge');
    const { incoming, outgoing, challengeablePlayers: players } = vm;
    this.#renderIfChanged(
      this.#incomingEl,
      incoming && [incoming.challengeId, incoming.challengerName],
      () => this.#renderIncoming(incoming),
    );
    this.#renderIfChanged(
      this.#outgoingEl,
      outgoing && [outgoing.challengeId, outgoing.targetName, outgoing.status],
      () => this.#renderOutgoing(outgoing),
    );
    this.#renderIfChanged(
      this.#playerListEl,
      [!hasActive, players.map((p) => [p.identity, p.name])],
      () => this.#renderPlayerList(players, !hasActive),
    );
    // re-derive the lock on the live controls — a batch can re-render while a
    // lifecycle call is still in flight.
    if (this.#pending !== null) this.#setLifecycleDisabled(true);
  }

  /** Runs `render` for `el` unless `shown` — everything that render reads — is what `el` already
   *  shows. The key is JSON, never a delimiter join: player names are user-chosen. A render that
   *  throws leaves `el` with no key, so the next refresh renders it again. */
  #renderIfChanged(el: HTMLElement, shown: readonly unknown[] | null, render: () => void): void {
    const key = JSON.stringify(shown, (_, v: unknown) => (typeof v === 'bigint' ? `${v}` : v));
    if (this.#rendered.get(el) === key) return;
    this.#rendered.delete(el);
    render();
    this.#rendered.set(el, key);
  }

  /**
   * Every lifecycle click routes through here — no-op while a call is in flight;
   * otherwise take the lock, disable the lifecycle controls, and release in `.finally()`
   * on BOTH arms (a rejected or short-circuited call must never leave a dead control).
   * `new Promise((resolve) => resolve(run()))` calls `run` synchronously and turns a
   * synchronous throw into a rejection; `.catch` after `.finally` keeps a rejecting
   * callback from surfacing as an unhandled rejection (main.ts already reported it).
   */
  #dispatch(run: () => void | Promise<void>): void {
    if (this.#pending !== null) return;
    const lock = {};
    this.#pending = lock;
    this.#setLifecycleDisabled(true);
    void new Promise<void>((resolve) => resolve(run()))
      .finally(() => {
        if (this.#pending !== lock) return;
        this.#pending = null;
        // The LIVE nodes: a refresh() mid-flight may have replaced the clicked one.
        this.#setLifecycleDisabled(false);
        this.#reanchorStrandedFocus();
      })
      .catch((err: unknown) => {
        console.error('pvp lifecycle handler error', err);
      });
  }

  /** A lock-owning release that finds focus stranded on `<body>` re-asserts the
   *  dialog; the idempotent re-open re-installs the trap and defers focus to the registry anchor.
   *  `#visible` is load-bearing: re-opening a hidden view would CREATE an open record. */
  #reanchorStrandedFocus(): void {
    if (this.#visible && document.activeElement === document.body) {
      openOverlayA11y('pvpView', this.#root);
    }
  }

  /** The three dynamic containers ARE the live-button registry — never `#root`, which
   *  also holds the static index.html controls (the close button) this lock must not touch. */
  #setLifecycleDisabled(disabled: boolean): void {
    for (const el of [this.#incomingEl, this.#outgoingEl, this.#playerListEl]) {
      for (const btn of el.querySelectorAll('button')) btn.disabled = disabled;
    }
  }

  #renderIncoming(incoming: PvpIncomingChallenge | null): void {
    this.#incomingEl.replaceChildren();
    if (!incoming) return;

    const label = document.createElement('div');
    label.setAttribute('data-testid', 'pvp-incoming-label');
    label.textContent = tf('pvp.incoming.label', { challenger: incoming.challengerName });
    this.#incomingEl.appendChild(label);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

    const acceptBtn = document.createElement('button');
    acceptBtn.setAttribute('data-testid', 'pvp-accept-btn');
    acceptBtn.textContent = t('pvp.incoming.accept');
    acceptBtn.addEventListener('click', () =>
      this.#dispatch(() => this.#callbacks.onAccept(incoming.challengeId)),
    );
    btnRow.appendChild(acceptBtn);

    const declineBtn = document.createElement('button');
    declineBtn.setAttribute('data-testid', 'pvp-decline-btn');
    declineBtn.textContent = t('pvp.incoming.decline');
    declineBtn.addEventListener('click', () =>
      this.#dispatch(() => this.#callbacks.onDecline(incoming.challengeId)),
    );
    btnRow.appendChild(declineBtn);

    this.#incomingEl.appendChild(btnRow);
  }

  #renderOutgoing(outgoing: PvpOutgoingChallenge | null): void {
    this.#outgoingEl.replaceChildren();
    if (outgoing?.status !== 'Pending') return;

    const label = document.createElement('div');
    label.setAttribute('data-testid', 'pvp-outgoing-label');
    label.textContent = tf('pvp.outgoing.label', { target: outgoing.targetName });
    this.#outgoingEl.appendChild(label);

    const cancelBtn = document.createElement('button');
    cancelBtn.setAttribute('data-testid', 'pvp-cancel-btn');
    cancelBtn.textContent = t('pvp.outgoing.cancel');
    cancelBtn.addEventListener('click', () =>
      this.#dispatch(() => this.#callbacks.onCancel(outgoing.challengeId)),
    );
    this.#outgoingEl.appendChild(cancelBtn);
  }

  #renderPlayerList(
    players: readonly { identity: string; name: string }[],
    showTitle: boolean,
  ): void {
    this.#playerListEl.replaceChildren();

    if (showTitle) {
      const title = document.createElement('div');
      title.textContent = players.length === 0 ? t('pvp.players.none') : t('pvp.players.heading');
      this.#playerListEl.appendChild(title);
    }

    for (const p of players) {
      const li = document.createElement('li');
      li.style.cssText = 'list-style:none;margin:4px 0;';

      const btn = document.createElement('button');
      btn.setAttribute('data-testid', 'pvp-challenge-player-btn');
      btn.setAttribute('data-player-identity', p.identity);
      btn.textContent = p.name;
      btn.addEventListener('click', () =>
        this.#dispatch(() => this.#callbacks.onChallenge(p.identity)),
      );
      li.appendChild(btn);
      this.#playerListEl.appendChild(li);
    }
  }
}
