// ui/pvpView.ts — thin DOM shell for the PvP challenge overlay (m16b, ADR-0110).
//
// Renders PvpChallengeViewModels produced by pvpModel.ts. No game logic, no SDK.
// Auto-shows when incoming/outgoing challenges are present; also KeyP-toggleable.
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { PvpChallengeViewModel, PvpIncomingChallenge, PvpOutgoingChallenge } from './pvpModel';

export interface PvpViewCallbacks {
  /** Accept an incoming challenge. */
  readonly onAccept: (challengeId: bigint) => void;
  /** Decline an incoming challenge. */
  readonly onDecline: (challengeId: bigint) => void;
  /** Cancel an outgoing challenge. */
  readonly onCancel: (challengeId: bigint) => void;
  /** Send a challenge to target player. */
  readonly onChallenge: (targetIdentity: string) => void;
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
    // m23-s3 D1 -- THE EDGE GUARD, AND WHY IT IS LOAD-BEARING (this is the canonical statement;
    // the other nine views point here). `refresh()` below calls `show()` UNCONDITIONALLY whenever
    // `forceVisible` is true, and main.ts:1697-1709 recomputes `forceVisible` on EVERY store batch
    // -- once this overlay is open, `pvpView.visible` keeps it true. Delegating to
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
    // m23-s3 D2 -- DELIBERATELY UNGUARDED, and the asymmetry with the guarded `render(null)` path
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

  /**
   * Re-render from the latest VM. The caller (main.ts batch listener or KeyP handler)
   * is fully responsible for the show/hide decision via `forceVisible` — this method
   * never auto-shows independently. This prevents pvpView from popping over an active
   * battle or other overlay when hasActive=true (ADR-0110 D6 mutual-exclusivity).
   */
  refresh(vm: PvpChallengeViewModel | null, forceVisible: boolean): void {
    const hasActive = vm !== null && (vm.incoming !== null || vm.outgoing !== null);

    if (!forceVisible) {
      if (this.#visible) this.hide();
      return;
    }

    this.show();

    if (vm === null) {
      this.#statusEl.textContent = 'PvP';
      this.#incomingEl.replaceChildren();
      this.#outgoingEl.replaceChildren();
      this.#playerListEl.replaceChildren();
      return;
    }

    this.#statusEl.textContent = 'PvP Challenge';
    this.#renderIncoming(vm.incoming);
    this.#renderOutgoing(vm.outgoing);
    this.#renderPlayerList(vm.challengeablePlayers, !hasActive);
  }

  #renderIncoming(incoming: PvpIncomingChallenge | null): void {
    this.#incomingEl.replaceChildren();
    if (!incoming) return;

    const label = document.createElement('div');
    label.setAttribute('data-testid', 'pvp-incoming-label');
    label.textContent = `${incoming.challengerName} has challenged you!`;
    this.#incomingEl.appendChild(label);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

    const acceptBtn = document.createElement('button');
    acceptBtn.setAttribute('data-testid', 'pvp-accept-btn');
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => this.#callbacks.onAccept(incoming.challengeId));
    btnRow.appendChild(acceptBtn);

    const declineBtn = document.createElement('button');
    declineBtn.setAttribute('data-testid', 'pvp-decline-btn');
    declineBtn.textContent = 'Decline';
    declineBtn.addEventListener('click', () => this.#callbacks.onDecline(incoming.challengeId));
    btnRow.appendChild(declineBtn);

    this.#incomingEl.appendChild(btnRow);
  }

  #renderOutgoing(outgoing: PvpOutgoingChallenge | null): void {
    this.#outgoingEl.replaceChildren();
    if (outgoing?.status !== 'Pending') return;

    const label = document.createElement('div');
    label.setAttribute('data-testid', 'pvp-outgoing-label');
    label.textContent = `Challenge sent to ${outgoing.targetName} — waiting…`;
    this.#outgoingEl.appendChild(label);

    const cancelBtn = document.createElement('button');
    cancelBtn.setAttribute('data-testid', 'pvp-cancel-btn');
    cancelBtn.textContent = 'Cancel Challenge';
    cancelBtn.addEventListener('click', () => this.#callbacks.onCancel(outgoing.challengeId));
    this.#outgoingEl.appendChild(cancelBtn);
  }

  #renderPlayerList(
    players: readonly { identity: string; name: string }[],
    showTitle: boolean,
  ): void {
    this.#playerListEl.replaceChildren();

    if (showTitle) {
      const title = document.createElement('div');
      title.textContent = players.length === 0 ? 'No players online to challenge' : 'Challenge:';
      this.#playerListEl.appendChild(title);
    }

    for (const p of players) {
      const li = document.createElement('li');
      li.style.cssText = 'list-style:none;margin:4px 0;';

      const btn = document.createElement('button');
      btn.setAttribute('data-testid', 'pvp-challenge-player-btn');
      btn.setAttribute('data-player-identity', p.identity);
      btn.textContent = p.name;
      btn.addEventListener('click', () => this.#callbacks.onChallenge(p.identity));
      li.appendChild(btn);
      this.#playerListEl.appendChild(li);
    }
  }
}
