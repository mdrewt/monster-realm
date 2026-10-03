// ui/leaderboardView.ts — thin DOM shell for the ranked leaderboard overlay.
// Pure rendering from LeaderboardViewModel. No logic — all logic is in leaderboardModel.ts.
// NOT coverage-excluded (unlike the sibling DOM shells): fully unit-covered via
// happy-dom tests, so every branch here must stay test-reachable.
// RL-15: ZERO-arg constructor — no callbacks, no write path (pure subscription view).
// displayName is player-controlled (profile.name): textContent + dataset only,
// NEVER innerHTML with data (XSS).
//
// The two strings this view owns are resolved through the i18n resolver
// (ui/i18n/resolver.ts): the empty-board row (`t('leaderboard.empty')`) and the numbers that
// follow a name on a row (`tf('leaderboard.row', { rating, wins, losses })`). The display name
// is NEVER a resolver argument (I18N-21): each row is `[<bdi>name</bdi>, textNode]` — the
// `<bdi>` (zero attributes, zero children, `textContent` only) isolates the player-chosen name's
// bidi run from the surrounding catalog text (M24 §2.7, I18N-20), and the catalog value carries
// the leading space, so `li.textContent` is byte-identical to the pre-migration string.
//
// ctl-8g: this root also hosts the Social frame's Players and Rankings tabs (CTL8G.1-.2).
// `paintSocial(p)` is kept and re-applied after every `render(vm)` (main.ts re-renders the board
// each batch); the hidden-to-visible edge (in `show()`, and in `render()` while hidden) and `hide()`
// drop it, so with no kept paint the root is exactly the legacy board. Rankings marks the board's
// `<li>`s by hand with the nav kit's contract (`renderNav` would own the list's children); Players
// hides the board and renders `#leaderboard-players` through the kit, with `#leaderboard-walkup`
// after it. Both are built on the first paint, after the board list. Player names stay out of the
// resolver here too: the walk-up line is resolved around a sentinel and the name goes in a `<bdi>`.

import { t, tf } from './i18n/resolver';
import type { LeaderboardViewModel } from './leaderboardModel';
import { list, tabs } from './nav';
import { navTabId, renderNav } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { SocialPlayerRow } from './socialModel';

/** What the Social screen paints over this root on its Players and Rankings tabs. */
export interface SocialRankingsPaint {
  readonly tab: 'players' | 'rankings';
  readonly players: readonly SocialPlayerRow[];
  /** The cursor row's nav key (an identity hex), else null. */
  readonly cursor: string | null;
  /** The walk-up player's name (Players), else null. */
  readonly walkUp: string | null;
}

/** The Social frame's nav id prefix (tradeView's tab strip names the tabs `social-tab-<tab>`). */
const SOCIAL_FRAME_ID = 'social';
/** Stands in for the name while the walk-up line is resolved; no catalog text holds a NUL. */
const NAME_SLOT = String.fromCharCode(0);
/** The list attributes a Rankings paint writes, removed when the paint is dropped. */
const LIST_MARKS = ['role', 'tabindex', 'aria-labelledby', 'aria-activedescendant'] as const;
const ROW_MARKS = ['id', 'class', 'role', 'aria-selected'] as const;

export class LeaderboardView {
  readonly #overlay: HTMLElement;
  readonly #listEl: HTMLElement;
  #kept: SocialRankingsPaint | null = null;
  /** `#leaderboard-players` and `#leaderboard-walkup`, built by the first paint. */
  #social: { readonly players: HTMLElement; readonly walkUp: HTMLElement } | null = null;

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
    // Read visibility BEFORE the display write. `show()` is called REPEATEDLY on an
    // already-open overlay (pvpView.ts is the extreme case, main.ts:1699-1701), and a re-open
    // re-schedules overlayA11y's deferred focus -- which would yank focus back to the initial
    // anchor on every store batch. Only the hidden->visible EDGE opens.
    const wasVisible = this.visible;
    if (!wasVisible) this.#drop();
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('leaderboardView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    this.#drop();
    // DELIBERATELY UNGUARDED (see pvpView.ts's header). closeOverlayA11y is a
    // documented no-op with no open record, and leaving it unguarded is what lets a record
    // that ever desynchronised from the DOM self-heal instead of leaking a live trap forever.
    closeOverlayA11y('leaderboardView', null);
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

  /** Render or re-render the board. Rows render in VM order — never re-sort here
   *  (the comparator is the model's contract). replaceChildren keeps
   *  re-renders replace-not-append. */
  render(vm: LeaderboardViewModel): void {
    // A hidden root keeps no paint: the next open starts from the legacy board.
    if (!this.visible) this.#drop();
    this.#renderBoard(vm);
    this.#apply();
  }

  /** The Social screen's paint: kept, so the next `render` re-applies it. */
  paintSocial(p: SocialRankingsPaint): void {
    this.#kept = p;
    this.#apply();
  }

  #drop(): void {
    this.#kept = null;
    this.#apply();
  }

  /** Write the kept paint, or with none undo every mark it left. */
  #apply(): void {
    const p = this.#kept;
    const rows = [...this.#listEl.children] as HTMLElement[];
    const ranked = rows.filter((li) => li.dataset.identity !== undefined);
    const onRankings = p?.tab === 'rankings';
    this.#listEl.hidden = p?.tab === 'players';
    if (onRankings) {
      const cursor = ranked.find((li) => li.dataset.identity === p.cursor) ?? ranked[0];
      this.#listEl.setAttribute('role', 'listbox');
      this.#listEl.setAttribute('tabindex', '0');
      this.#listEl.setAttribute('aria-labelledby', navTabId(SOCIAL_FRAME_ID, 'rankings'));
      for (const li of ranked) {
        const selected = li === cursor;
        li.id = `${SOCIAL_FRAME_ID}-rankings-${li.dataset.identity}`;
        li.className = selected ? 'mr-nav-item is-active' : 'mr-nav-item';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', selected ? 'true' : 'false');
      }
      if (cursor === undefined) this.#listEl.removeAttribute('aria-activedescendant');
      else this.#listEl.setAttribute('aria-activedescendant', cursor.id);
    } else {
      for (const name of LIST_MARKS) this.#listEl.removeAttribute(name);
      for (const li of rows) for (const name of ROW_MARKS) li.removeAttribute(name);
    }
    if (p?.tab === 'players') this.#paintPlayers(p);
    else if (this.#social !== null) {
      this.#social.players.hidden = true;
      this.#social.players.replaceChildren();
      this.#social.walkUp.hidden = true;
      this.#social.walkUp.replaceChildren();
    }
  }

  #paintPlayers(p: SocialRankingsPaint): void {
    if (this.#social === null) {
      const players = document.createElement('div');
      players.id = 'leaderboard-players';
      const walkUp = document.createElement('p');
      walkUp.id = 'leaderboard-walkup';
      this.#listEl.after(players, walkUp);
      this.#social = { players, walkUp };
    }
    const { players, walkUp } = this.#social;
    players.hidden = false;
    if (p.players.length === 0) {
      for (const name of LIST_MARKS) players.removeAttribute(name);
      const none = document.createElement('div');
      none.textContent = t('social.players.none');
      players.replaceChildren(none);
    } else {
      // The kit drops the empty line: it keeps only its own items.
      const names = new Map(p.players.map((row) => [row.key, row]));
      renderNav(
        players,
        tabs([
          {
            key: 'players',
            layout: list(p.players.map((row) => ({ key: row.key, enabled: true }))),
          },
        ]),
        { tab: 'players', item: p.cursor ?? p.players[0]?.key ?? null, perTab: {} },
        {
          frame: SOCIAL_FRAME_ID,
          fill: (el, item) => {
            const row = names.get(item.key);
            const name = document.createElement('bdi');
            name.textContent = row?.name ?? '';
            el.append(name);
            if (row?.nearby === true) {
              const badge = document.createElement('span');
              badge.textContent = t('social.players.nearby');
              el.append(' ', badge);
            }
          },
        },
      );
    }
    walkUp.hidden = p.walkUp === null;
    walkUp.replaceChildren();
    if (p.walkUp !== null) {
      // The name never reaches the resolver (I18N-21): resolve around a slot, then put the name
      // there in a `<bdi>`. A line with no slot still shows the name once, at its end.
      const [before = '', ...rest] = tf('social.players.walkUp', { name: NAME_SLOT }).split(
        NAME_SLOT,
      );
      const name = document.createElement('bdi');
      name.textContent = p.walkUp;
      walkUp.append(before, name, rest.join(''));
    }
  }

  #renderBoard(vm: LeaderboardViewModel): void {
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
