// ui/leaderboardView.ts — thin DOM shell for the ranked leaderboard overlay (m17b, ADR-0120).
// Pure rendering from LeaderboardViewModel. No logic — all logic is in leaderboardModel.ts.
// NOT coverage-excluded (unlike the sibling DOM shells): fully unit-covered via
// happy-dom tests — the vite.config.ts exclude list is exact-set-guarded by an
// m17c-owned eval, so every branch here must stay test-reachable.
// RL-15: ZERO-arg constructor — no callbacks, no write path (pure subscription view).
// displayName is player-controlled (profile.name): textContent + dataset only,
// NEVER innerHTML with data (XSS).
import type { LeaderboardViewModel } from './leaderboardModel';

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
    this.#overlay.style.display = '';
  }

  hide(): void {
    this.#overlay.style.display = 'none';
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
      li.textContent = 'No ranked players yet';
      this.#listEl.replaceChildren(li);
      return;
    }
    const items = vm.rows.map((row) => {
      const li = document.createElement('li');
      li.dataset.identity = row.identityHex;
      // Own-row highlight hook: dataset.own set ONLY on the own row (CSS [data-own]).
      if (row.isOwn) li.dataset.own = 'true';
      li.textContent = `${row.displayName} — ${row.rating} (W${row.wins}/L${row.losses})`;
      return li;
    });
    this.#listEl.replaceChildren(...items);
  }
}
