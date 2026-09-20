// ui/leaderboardView.ts — thin DOM shell for the ranked leaderboard overlay (m17b, ADR-0120).
// Pure rendering from LeaderboardViewModel. No logic — all logic is in leaderboardModel.ts.
// NOT coverage-excluded (unlike the sibling DOM shells): fully unit-covered via
// happy-dom tests — the vite.config.ts exclude list is exact-set-guarded by an
// m17c-owned eval, so every branch here must stay test-reachable.
// RL-15: ZERO-arg constructor — no callbacks, no write path (pure subscription view).
// displayName is player-controlled (profile.name): textContent + dataset only,
// NEVER innerHTML with data (XSS).
//
// m24-s5 (ADR-0261 D3) — the two strings this view owns are resolved through the i18n resolver
// (ui/i18n/resolver.ts): the empty-board row (`t('leaderboard.empty')`) and the numbers that
// follow a name on a row (`tf('leaderboard.row', { rating, wins, losses })`). The display name
// is NEVER a resolver argument (I18N-21): each row is `[<bdi>name</bdi>, textNode]` — the
// `<bdi>` (zero attributes, zero children, `textContent` only) isolates the player-chosen name's
// bidi run from the surrounding catalog text (M24 §2.7, I18N-20), and the catalog value carries
// the leading space, so `li.textContent` is byte-identical to the pre-migration string.

import { t, tf } from './i18n/resolver';
import type { LeaderboardViewModel } from './leaderboardModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

export class LeaderboardView {
  readonly #overlay: HTMLElement;
  readonly #listEl: HTMLElement;

  constructor() {
    const el = document.getElementById('leaderboard-overlay');
    if (!el) throw new Error('leaderboard-overlay element not found in DOM');
    this.#overlay = el;
    const list = el.querySelector<HTMLElement>('#leaderboard-list');
    if (!list) throw new Error('leaderboard-list missing');
    this.#listEl = list;
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    // m23-s3 D1: read visibility BEFORE the display write. `show()` is called REPEATEDLY on an
    // already-open overlay (pvpView.ts is the extreme case, main.ts:1699-1701), and a re-open
    // re-schedules overlayA11y's deferred focus -- which would yank focus back to the initial
    // anchor on every store batch. Only the hidden->visible EDGE opens.
    const wasVisible = this.visible;
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('leaderboardView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // m23-s3 D2: DELIBERATELY UNGUARDED (see pvpView.ts's header). closeOverlayA11y is a
    // documented no-op with no open record, and leaving it unguarded is what lets a record
    // that ever desynchronised from the DOM self-heal instead of leaking a live trap forever.
    closeOverlayA11y('leaderboardView', null);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Render or re-render the board. Rows render in VM order — never re-sort here
   *  (the comparator is the model's contract, ADR-0120). replaceChildren keeps
   *  re-renders replace-not-append. */
  render(vm: LeaderboardViewModel): void {
    if (vm.isEmpty) {
      // Empty board is a real state: profiles exist only after a decisive ranked battle.
      const li = document.createElement('li');
      li.textContent = t('leaderboard.empty');
      this.#listEl.replaceChildren(li);
      return;
    }
    const items = vm.rows.map((row) => {
      const li = document.createElement('li');
      li.dataset.identity = row.identityHex;
      // Own-row highlight hook: dataset.own set ONLY on the own row (CSS [data-own]).
      if (row.isOwn) li.dataset.own = 'true';
      // `<bdi>` + ONE text node from ONE key (header): the name never reaches the catalog.
      const name = document.createElement('bdi');
      name.textContent = row.displayName;
      li.replaceChildren(
        name,
        tf('leaderboard.row', { rating: row.rating, wins: row.wins, losses: row.losses }),
      );
      return li;
    });
    this.#listEl.replaceChildren(...items);
  }
}
