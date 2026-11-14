// ui/boxView.ts — thin DOM shell for the box/party screen.
//
// Renders MonsterCardViewModels produced by boxModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes — one-way flow only.
// The loop calls refresh() on batch-applied; the user triggers reducer intents
// via callbacks passed at construction (never called directly by this module).
//
// Every player-facing string this view renders is resolved through the i18n
// resolver (`t()`/`tf()`, ui/i18n/resolver.ts) with a `box.*` key from ui/i18n/catalog.en.ts (the
// Evolve list and its confirm reuse the `evolution.path.*` / `evolution.card.*` lines and the shared
// `prompt.yes` / `prompt.no`); the English bytes are unchanged (the catalog pins them).
// The name row `card.nickname || card.speciesName` is model data, rendered raw. Every `t(`/`tf(`
// first argument is a string LITERAL.
//
// Overlay a11y wiring. This view is a CONSTRUCTED shell:
// its root is `document.createElement`'d here and appended into the shared `#app` MOUNT, so unlike
// the ten static shells S3 wired it ships NO ARIA of its own from `client/index.html` — every
// attribute below comes from `openOverlayA11y`, never from a literal in this file.
//
// THE EDGE, AND WHY IT IS READ FIRST. `wasVisible` is read as the FIRST statement of `show()`,
// before any write. A re-open tears down and re-schedules `openOverlayA11y`'s deferred focus, which
// drags focus off whatever control the player had Tabbed to — invisible to every attribute
// assertion, since a re-open rewrites the same values.
//
// AND WHY THE CLOSE IS DELIBERATELY UNGUARDED. `hide()` calls `closeOverlayA11y` every time, even
// when already hidden. A guarded close reads correct and passes every other assertion while
// permanently leaking a live capture listener, a pending timer and an expiring return target
// whenever a record desynchronises from the DOM; `closeOverlayA11y` with no record is a documented
// pure no-op, so unguarded is the self-healing path. S3's red-team measured the guarded shape
// shipping 62/62 green.
//
// THE OPEN IS THE LAST STATEMENT of the open path, after the display write: in a real browser
// `.focus()` on a `display:none` node is a silent no-op, so an open-before-paint overlay announces
// itself and then never receives focus.
//
// Each `#app`-mounted view creates its OWN root under the shared mount, so opening this view
// never closes a sibling (no close-before-open; boxView.test.ts S4-CROSS-VIEW-DISTINCT-ROOTS).
//
// ctl-8b: this root is the Monsters frame. `paint(MonstersPaint)` (screens/monstersScreen.ts) is
// kept and re-applied after every `refresh`, and reset to the opening (Storage, first card) on
// the hidden→visible edge (the seated screen then paints the bound tab in the same open, uif-6).
// Both panels stay in the DOM (e2e reads the root's textContent); the inactive one is hidden by
// inline display. The nickname is typed in an in-frame field (no `window.prompt`), sent once per
// commit token the screen hands over.
//
// uif-6: the kit's TabBar sits under the title; the tab content area `#monsters-panel` grows to the
// frame (up to `--mr-content-max`) and clips, holding the Party (a 2-column grid of one cell per
// slot) and Storage (a 3-column grid the cursor scrolls, with the kit's `.mr-scroll` cue, or the
// EmptyState). Cells paint the tokens inline; the cursor cell takes the inverted row-cursor fill.
//
// ctl-8c: the sheet gains Care, Feed… and Evolve…; the food list, the Evolve list (every outgoing
// path, only the choices enabled, the status line raw from the model's reason) and the Yes / No
// confirm take the sheet's place (uif-7, below), and the "Fed {name}" line joins the feedback line.
// A hidden part is emptied as well as hidden (the e2e text scans read hidden descendants).
//
// uif-7: the sheet is the frame's one ContextSheet (ui/contextSheet.ts) inside the tab content area,
// placed by the kit in a bottom corner away from the cursor cell (wf-1's verdict), nothing dimmed.
// It holds one content at a time (UIF7.3): the sheet's rows (ending with Close), the food list or
// the Evolve list (each ending with Back), or the Evolve confirm (the confirm variant). Every row id
// is `monstersSheet-root-<key>`, and the heading keeps the id `monsters-sheet-name`. The Summary is a
// page in the panel in place of both grids (UIF7.4); the tabs stay. A click outside the sheet closes
// it and then lands on its target through the pointer source (uif-5).
//
// qf-2: a care answer or a train rejection for an action sent FROM this frame comes back to this
// frame's line (QF2.1), through a sink `feedbackLine()` hands out bound to the current open: a sink
// called while hidden, or once a later open has started, paints nothing and says so (an answer that
// settles after the frame was left never reaches the next session). The screen's own Move / Fed
// line wins while it shows; a batch repaint keeps the outcome (a care rewrites monster_pub, so its
// own batch repaints the sheet); the next button ends it (`clearOutcome`, main.ts) and so does
// hide().
import type { MonsterCardViewModel, MonsterStatsViewModel } from './boxModel';
import {
  type ContextSheet,
  type ContextSheetContent,
  closeContextSheet,
  createContextSheet,
  placeContextSheet,
  renderContextSheet,
} from './contextSheet';
import { createEmptyState } from './emptyState';
import { currentLocale, t, tf } from './i18n/resolver';
import {
  cardName,
  careCooldownParts,
  findPath,
  foodKey,
  foodLayoutOf,
  isBackKey,
  PARTY_COLS,
  pathLayout,
  type SheetAction,
  STORAGE_COLS,
  sheetLayout,
  slotKey,
} from './monstersModel';
import { list, type NavItem, type NavTab, tabs } from './nav';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { MonstersFeedback, MonstersPaint, NicknameCommit } from './screens/monstersScreen';
import { createTabBar, renderTabBar, type TabBar } from './tabBar';

const MONSTERS_TABS = tabs([
  { key: 'party', layout: list([]) },
  { key: 'storage', layout: list([]) },
]);
const tabLabel = (tab: NavTab): string =>
  tab.key === 'party' ? t('box.tab.party') : t('box.tab.storage');

const SHEET_LABELS: Readonly<Record<SheetAction, () => string>> = {
  summary: () => t('box.sheet.summary'),
  care: () => t('box.sheet.care'),
  feed: () => t('box.sheet.feed'),
  evolve: () => t('box.sheet.evolve'),
  nickname: () => t('box.sheet.nickname'),
  move: () => t('box.sheet.move'),
  close: () => t('kit.sheet.close'),
};

/** Why a disabled sheet row is disabled, shown after its label (ctl-8c). */
const SHEET_REASONS: Readonly<Partial<Record<SheetAction, () => string>>> = {
  feed: () => t('box.sheet.feedNone'),
  evolve: () => t('evolution.card.noPaths'),
};

/** A disabled row's reason: Care's carries the remaining cooldown rounded up to the minute (qf-3,
 *  the hours and minutes are the model's), the others are the fixed lines above. */
function sheetReason(
  key: SheetAction,
  sheet: NonNullable<MonstersPaint['sheet']>,
): string | undefined {
  if (key === 'care') return tf('box.sheet.careCooldown', careCooldownParts(sheet.careRemainingMs));
  return SHEET_REASONS[key]?.();
}

/** The Evolve confirm's answers; No is the screen's default. */
const CONFIRM_YES = 'yes';
const CONFIRM_LAYOUT = list([
  { key: CONFIRM_YES, enabled: true },
  { key: 'no', enabled: true },
]);

/** The frame id of every row the one sheet shows (its actions, foods, paths, Yes / No, Back). */
const SHEET_FRAME = 'monstersSheet';

/** Fill a Back row (the food and Evolve lists' last row); false for any other row. */
function fillBack(el: HTMLElement, item: NavItem): boolean {
  if (!isBackKey(item.key)) return false;
  el.textContent = t('kit.sheet.back');
  return true;
}

const OPENING: MonstersPaint = {
  tab: 'storage',
  activeKey: null,
  sheet: null,
  feed: null,
  evolve: null,
  confirm: null,
  summary: null,
  nickname: null,
  commit: null,
  feedback: null,
};

// The cursor card's non-colour mark. Not `.mr-nav-item`: its active rule repaints the card's
// colours, and the cards keep their own inline ones.
const CURSOR_OUTLINE = '3px solid #fff';

// uif-6: the cells' token colours (styles.css is the kit's; these are the same tokens inline). A
// cell reads as the panel's darker fill; the cursor cell takes the kit's row-cursor INVERTED fill,
// so it never looks like the selected tab (`.mr-nav-tab.is-selected`: the panel fill, bold, an
// outline; feedback 060, 169). An empty slot's text is muted except under the cursor.
const CELL_FILL = 'var(--mr-panel-bg)';
const CELL_TEXT = 'var(--mr-frame-fg)';
const CELL_EMPTY_TEXT = 'var(--mr-text-muted)';
const CURSOR_FILL = 'var(--mr-frame-fg)';
const CURSOR_TEXT = 'var(--mr-frame-bg)';
const CELL_STYLE =
  'box-sizing:border-box;min-width:0;overflow:hidden;' +
  'border:var(--mr-border-thin) solid var(--mr-separator);padding:var(--mr-space-2);' +
  `background:${CELL_FILL};color:${CELL_TEXT};`;
// The grids' shared box: the padding keeps the 3px cursor outline inside the clip of an
// overflow-hidden grid, and the scroll padding keeps it there when the cursor scrolls a cell in.
const GRID_STYLE =
  'display:grid;gap:var(--mr-space-2);padding:var(--mr-space-1);box-sizing:border-box;' +
  'scroll-padding:var(--mr-space-1);' +
  'flex:1 1 auto;min-height:0;width:100%;';

// Typing in the nickname field: these keys stop or commit it and must reach the page (Escape is
// routed in the capture phase anyway; Enter becomes A). Every other key stays in the field, out
// of the page's hotkey ladder.
const FIELD_RELEASED = new Set(['Escape', 'Enter', 'NumpadEnter']);

/** The feedback line's text; the check mark is CSS, never in the text. */
function feedbackText(feedback: MonstersFeedback): string {
  switch (feedback.kind) {
    case 'movedToParty':
      return t('box.feedback.movedToParty');
    case 'movedToBox':
      return t('box.feedback.movedToBox');
    case 'fed':
      return tf('box.feedback.fed', { name: feedback.name });
  }
}

/** A sink for one action's outcome on this frame's line: its text (textContent only: a rejection
 *  carries the server's reason) and the line's `data-feedback` mark. True iff it painted. */
export type OutcomeLine = (message: string, kind: 'ok' | 'error') => boolean;

export interface BoxViewCallbacks {
  /** Called with the nickname field's text when the Monsters screen commits it (CTL8B.3). */
  readonly onSetNickname: (monsterId: bigint, nickname: string) => void;
  /** Unread since qf-8 (QF8.1): the cards' To Box / To Party buttons that called it were a
   *  mouse-only duplicate of the Monsters sheet's Move row (ui/screens/monstersScreen.ts, the
   *  `move` arm, by D-pad and by pointer) and are deleted. main.ts still passes it. */
  readonly onSetPartySlot: (monsterId: bigint, slot: number) => void;
  /** Unread: the Box's Heal Party button is retired (ctl-10a, B13). */
  readonly onHealParty?: () => void;
  /** Unread since qf-8: the deleted To Box button emitted it (game-core's PARTY_SLOT_NONE, read
   *  once at boot from the `party_slot_none()` wasm export); main.ts still passes it, and the
   *  Monsters screen's view model carries its own copy for the Move row. */
  readonly partySlotNone: number;
}

export class BoxView {
  readonly #root: HTMLDivElement;
  /** The "Monsters" heading; its text is resolved in show(), not here (see show()). */
  readonly #titleEl: HTMLHeadingElement;
  readonly #partyEl: HTMLDivElement;
  readonly #boxEl: HTMLDivElement;
  /** Static box-vs-party explainer; never toggled — it states an invariant.
   *  Its text is resolved in show(). */
  readonly #hintEl: HTMLDivElement;
  readonly #callbacks: BoxViewCallbacks;
  #visible = false;
  /** Bumped on each hidden→visible edge: an outcome sink paints only in the open it was taken in. */
  #opens = 0;
  /** The last action's outcome (qf-2), shown while the screen paints no feedback of its own. */
  #outcome: { readonly text: string; readonly kind: 'ok' | 'error' } | null = null;
  // ctl-8b: the Monsters frame's parts and the kept paint.
  /** uif-6: the kit's TabBar (LB chip, `#monsters-tabs`, RB chip) under the title. */
  readonly #tabBar: TabBar;
  /** uif-7: the frame's one ContextSheet, in the panel (its containing block). */
  readonly #sheet: ContextSheet;
  /** uif-6: the tab content area `#monsters-panel`. */
  readonly #panel: HTMLDivElement;
  /** uif-7: the Summary page, in the panel in place of the grids. */
  readonly #summaryEl: HTMLDivElement;
  readonly #summaryName: HTMLDivElement;
  readonly #summaryStats: HTMLDivElement;
  /** qf-9: the full stats line (attack … spDefense and trust), the game's only stats display. */
  readonly #summaryDetail: HTMLDivElement;
  readonly #rowEl: HTMLDivElement;
  readonly #rowLabel: HTMLLabelElement;
  readonly #input: HTMLInputElement;
  readonly #feedbackEl: HTMLDivElement;
  #paint: MonstersPaint = OPENING;
  /** The live cards of the last `refresh`, by nav key: a kept paint names the monster, the batch
   *  that renamed or healed it since is what shows. */
  #cards = new Map<string, MonsterCardViewModel>();
  /** The stats of the last `refresh`, by the same key. */
  #stats: ReadonlyMap<string, MonsterStatsViewModel> = new Map();
  /** The last commit token sent (never reset: a token is sent at most once). */
  #lastCommit: NicknameCommit | null = null;
  /** The typing row's open last prefilled and focused; reset on each open of the frame. */
  #lastEdit: number | null = null;
  /** What that open prefilled: an untouched field is never sent (a batch may have renamed the
   *  monster since, and sending the stale prefill would revert it). */
  #prefilled = '';
  #scrolledKey: string | null = null;
  /** What each grid shows, by grid (`#renderIfChanged`). */
  readonly #rendered = new Map<HTMLElement, string>();

  constructor(parent: HTMLElement, callbacks: BoxViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    // ctl-7b: a class-styled frame. `.mr-shell` places it inside `#game-screen` (the `#app` mount
    // main.ts passes is inside it) and `.mr-frame` paints the frame tokens; inline is only the
    // display toggle.
    this.#root.className = 'mr-frame mr-shell';
    this.#root.style.cssText = 'display:none;';

    // The kit title bar (`ui/frame.ts`), first in the frame. NO text here — `box.title` is resolved
    // in show() (see there for why).
    const header = document.createElement('div');
    header.className = 'mr-frame-titlebar';
    const title = document.createElement('h2');
    title.className = 'mr-frame-title';
    // The OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'box-title');
    title.setAttribute('tabindex', '-1');
    title.style.margin = '0';
    this.#titleEl = title;
    header.appendChild(title);
    this.#root.appendChild(header);

    // ctl-8b: the tabs, the typing row and the Move line sit BEFORE the panel and the hint; the
    // sheet and the Summary page are in the panel (uif-7). Typing mode's Escape focuses the frame's
    // first enabled non-text control; the cards carry no control of their own (qf-8).
    this.#tabBar = createTabBar(document, { id: 'monsters-tabs' });
    this.#root.appendChild(this.#tabBar.root);

    this.#sheet = createContextSheet(document, { frame: SHEET_FRAME });
    // The heading names the monster (or asks the confirm): the id its consumers read.
    this.#sheet.heading.id = 'monsters-sheet-name';
    this.#summaryEl = document.createElement('div');
    this.#summaryEl.id = 'monsters-summary';
    this.#summaryEl.style.cssText = 'flex:1 1 auto;min-height:0;overflow-y:auto;';
    this.#summaryName = document.createElement('div');
    this.#summaryStats = document.createElement('div');
    this.#summaryDetail = document.createElement('div');
    this.#summaryDetail.id = 'monsters-summary-stats';
    this.#summaryEl.append(this.#summaryName, this.#summaryStats, this.#summaryDetail);
    this.#rowEl = document.createElement('div');
    this.#rowLabel = document.createElement('label');
    this.#rowLabel.htmlFor = 'monsters-nickname-input';
    this.#input = document.createElement('input');
    this.#input.type = 'text';
    this.#input.id = 'monsters-nickname-input';
    this.#input.addEventListener('keydown', (e) => {
      if (!FIELD_RELEASED.has(e.code)) e.stopPropagation();
    });
    this.#rowEl.append(this.#rowLabel, this.#input);
    this.#root.appendChild(this.#rowEl);

    this.#feedbackEl = document.createElement('div');
    this.#feedbackEl.className = 'mr-frame-feedback';
    this.#root.appendChild(this.#feedbackEl);

    // uif-6: the tab content area. It grows to the free height of the frame and to
    // `--mr-content-max` wide even when empty (038, 045), and clips: a grid that outgrows it scrolls
    // inside it by the cursor (039). The tab names the panel, so it has no heading (QF10.2).
    // uif-7: it is also the sheet's containing block (`position:relative`).
    const panel = document.createElement('div');
    panel.id = 'monsters-panel';
    panel.style.cssText =
      'flex:1 1 auto;min-height:0;width:100%;max-width:var(--mr-content-max);align-self:center;' +
      'box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;' +
      'padding:var(--mr-space-2);position:relative;';
    this.#panel = panel;
    this.#root.appendChild(panel);

    // The Party: one cell per slot in a grid of PARTY_COLS (WF1-A3), rows sharing the height, so
    // all six fit; the D-pad moves in the same grid (monstersModel). The rows are set per render.
    this.#partyEl = document.createElement('div');
    this.#partyEl.style.cssText = `${GRID_STYLE}grid-template-columns:repeat(${PARTY_COLS},minmax(0,1fr));`;
    panel.appendChild(this.#partyEl);

    // Storage: a grid that never shows a scrollbar: the cursor scrolls it (`scrollIntoView` in
    // #apply) and so does the wheel, which presses Up / Down over its cells (uif-5). While it holds
    // cards it wears the kit's position cue (`.mr-scroll`, a shadow where more rows hide; #buildBox).
    this.#boxEl = document.createElement('div');
    this.#boxEl.style.cssText =
      `${GRID_STYLE}grid-template-columns:repeat(${STORAGE_COLS},minmax(0,1fr));` +
      'align-content:start;overflow-y:hidden;';
    panel.appendChild(this.#boxEl);

    // uif-7: the Summary page (in place of both grids) and the one sheet, over the grid.
    panel.append(this.#summaryEl, this.#sheet.root);
    // Re-place the open sheet when the panel's size changes (a window resize, a text step). Never
    // disconnected: the view lives as long as the page, and a hidden frame places nothing.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (this.#visible) this.#placeSheet();
      }).observe(panel);
    }

    // qf-10 (QF10.3): the hint sits BELOW the panels, the root's last child — never on the seam
    // between the tab strip and the tab contents. A direct #root child, so it cannot be wiped by
    // #renderParty / #renderBox, which only touch #partyEl / #boxEl; a sibling of `header`, never
    // wrapping it (the frame root is the title's grandparent). The copy names the Monsters
    // sheet's Move row (`box.sheet.move`, quoted verbatim) and commands no click: the cards carry
    // no control (qf-8, QF8.1). Its text (`box.hint`) is resolved in show(), not here.
    this.#hintEl = document.createElement('div');
    this.#hintEl.setAttribute('data-testid', 'box-party-hint');
    this.#hintEl.style.cssText = 'max-width:600px;margin:12px 0 0;font-size:12px;color:#aaa;';
    this.#root.appendChild(this.#hintEl);

    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  toggle(): void {
    this.#visible ? this.hide() : this.show();
  }

  show(): void {
    const wasVisible = this.#visible;
    this.#visible = true;
    // The strings set ONCE and never rewritten by a render are resolved
    // HERE, on EVERY show() — unconditionally, after the `wasVisible` read, before the display
    // write. See evolutionView.show() for the boot-order / locale-switch reasoning.
    this.#titleEl.textContent = t('box.title');
    this.#hintEl.textContent = t('box.hint');
    this.#rowLabel.textContent = t('box.rename.prompt');
    this.#root.style.display = 'flex';
    if (wasVisible) return;
    this.#opens++;
    // A reopened frame starts over: Storage, its first card, no sheet (the screen's `init`). After
    // the display write, so the opening card's scroll lands.
    this.#paint = OPENING;
    this.#lastEdit = null;
    this.#scrolledKey = null;
    this.#apply();
    openOverlayA11y('boxView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#outcome = null;
    this.#root.style.display = 'none';
    closeOverlayA11y('boxView', null);
  }

  refresh(
    partySlots: readonly (MonsterCardViewModel | null)[],
    boxMonsters: readonly MonsterCardViewModel[],
    stats: ReadonlyMap<string, MonsterStatsViewModel> = new Map(),
  ): void {
    this.#stats = stats;
    this.#renderParty(partySlots);
    this.#renderBox(boxMonsters);
    this.#cards = new Map(
      [...partySlots, ...boxMonsters]
        .filter((card): card is MonsterCardViewModel => card !== null)
        .map((card) => [String(card.monsterId), card]),
    );
    this.#apply();
  }

  /** A sink for an action sent from this open of the frame (see the header). */
  feedbackLine(): OutcomeLine {
    const open = this.#opens;
    return (message, kind) => {
      if (!this.#visible || this.#opens !== open) return false;
      this.#outcome = { text: message, kind };
      this.#apply();
      return true;
    };
  }

  /** End the outcome line: the next button acts on the frame (main.ts routes it). */
  clearOutcome(): void {
    if (this.#outcome === null) return;
    this.#outcome = null;
    this.#apply();
  }

  /** The Monsters screen's paint: kept, so the next `refresh` re-applies it. */
  paint(p: MonstersPaint): void {
    this.#paint = p;
    this.#apply();
  }

  /** Apply the kept paint: send a new commit token's text, then the tabs and the panel shown, the
   *  cursor card (class, aria-current and an outline: never colour alone), the sheet, its summary
   *  and typing row, and the feedback line (the screen's Move / Fed line, else the outcome). Focus
   *  never stays in a part this hides. */
  #apply(): void {
    const p = this.#paint;
    // First, while the field still holds the text. Recorded BEFORE the callback, which may
    // repaint: a token is sent once.
    if (p.commit !== null && p.commit !== this.#lastCommit) {
      this.#lastCommit = p.commit;
      const text = this.#input.value;
      if (text !== p.commit.current && text !== this.#prefilled) {
        this.#callbacks.onSetNickname(p.commit.monsterId, text);
      }
      if (this.#paint !== p) return; // the callback painted again, and that paint is applied
    }
    const live = (card: MonsterCardViewModel): MonsterCardViewModel =>
      this.#cards.get(String(card.monsterId)) ?? card;

    renderTabBar(
      this.#tabBar,
      MONSTERS_TABS,
      { tab: p.tab, item: null, perTab: {} },
      { frame: 'monsters', label: tabLabel },
    );
    const onParty = p.tab === 'party';
    // uif-7 (UIF7.4): the Summary page replaces both grids; the tabs stay.
    const onPage = p.summary !== null;
    setShown(this.#partyEl, onParty && !onPage, 'grid');
    setShown(this.#boxEl, !onParty && !onPage, 'grid');

    const active = onParty ? this.#partyEl : this.#boxEl;
    const key =
      p.activeKey ?? active.querySelector<HTMLElement>('[data-nav-key]')?.dataset.navKey ?? null;
    for (const grid of [this.#partyEl, this.#boxEl]) {
      for (const el of Array.from(grid.querySelectorAll<HTMLElement>('[data-nav-key]'))) {
        const on = grid === active && el.dataset.navKey === key;
        el.classList.toggle('is-active', on);
        el.style.outline = on ? CURSOR_OUTLINE : '';
        el.style.background = on ? CURSOR_FILL : CELL_FILL;
        el.style.color = on
          ? CURSOR_TEXT
          : el.dataset.empty === undefined
            ? CELL_TEXT
            : CELL_EMPTY_TEXT;
        if (!on) {
          el.removeAttribute('aria-current');
          continue;
        }
        el.setAttribute('aria-current', 'true');
        if (this.#scrolledKey !== `${p.tab}:${key}`) {
          if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
          this.#scrolledKey = `${p.tab}:${key}`;
        }
      }
    }

    // uif-7: the one sheet, with this paint's one content; closed (and emptied) when there is none.
    // Focus inside it when its rows change or it closes (the kit drops the rows) stays in the frame.
    const hadFocus = this.#sheet.root.contains(document.activeElement);
    const cursorCard = key === null ? undefined : this.#cards.get(key);
    const content = this.#sheetContent(
      p,
      cursorCard === undefined ? '' : cardName(cursorCard),
      live,
    );
    if (content === null) closeContextSheet(this.#sheet);
    else renderContextSheet(this.#sheet, content);
    this.#placeSheet();
    if (hadFocus && !this.#sheet.root.contains(document.activeElement)) {
      (this.#sheet.root.hidden ? this.#titleEl : this.#sheet.rows).focus();
    }

    const summary = p.summary === null ? null : live(p.summary);
    setShown(this.#summaryEl, summary !== null, '');
    this.#summaryName.textContent = summary === null ? '' : cardName(summary);
    this.#summaryStats.textContent =
      summary === null
        ? ''
        : tf('box.card.stats', {
            species: summary.speciesName,
            level: summary.level,
            current: summary.currentHp,
            max: summary.statHp,
            percent: summary.hpPercent,
          });
    const detail = summary === null ? undefined : this.#stats.get(String(summary.monsterId));
    setShown(this.#summaryDetail, detail !== undefined, '');
    this.#summaryDetail.textContent =
      detail === undefined
        ? ''
        : tf('box.summary.stats', {
            trust: detail.trustTier,
            attack: detail.statAttack,
            defense: detail.statDefense,
            speed: detail.statSpeed,
            spAttack: detail.statSpAttack,
            spDefense: detail.statSpDefense,
          });

    const row = p.nickname;
    setShown(this.#rowEl, row !== null, '');
    if (row !== null && row.edit !== this.#lastEdit) {
      // A new open only: a repaint of the same open keeps the typed text and never takes focus
      // back from an Escape.
      this.#lastEdit = row.edit;
      this.#prefilled = row.card.nickname;
      this.#input.value = row.card.nickname;
      this.#input.focus();
    }

    const line =
      p.feedback !== null ? { text: feedbackText(p.feedback), kind: 'ok' } : this.#outcome;
    setShown(this.#feedbackEl, line !== null, '');
    this.#feedbackEl.textContent = line === null ? '' : line.text;
    if (line === null) this.#feedbackEl.removeAttribute('data-feedback');
    else this.#feedbackEl.dataset.feedback = line.kind;

    // A part hidden under the focus would strand it (the next key would heal focus to the world,
    // out of the frame): hand it to the frame's anchor.
    const focused = document.activeElement;
    if (this.#visible && focused instanceof HTMLElement && this.#hiddenInFrame(focused)) {
      this.#titleEl.focus();
    }
  }

  /** The one sheet's content for this paint, or null: the sheet's rows (titled by the monster),
   *  the food list or the Evolve list (titled by the cursor monster, `name`), or the confirm. */
  #sheetContent(
    p: MonstersPaint,
    name: string,
    live: (card: MonsterCardViewModel) => MonsterCardViewModel,
  ): ContextSheetContent | null {
    const sheet = p.sheet;
    if (sheet !== null) {
      return {
        variant: 'list',
        title: cardName(live(sheet.card)),
        layout: sheetLayout(sheet.canFeed, sheet.canEvolve, sheet.careRemainingMs === 0n),
        state: { tab: null, item: sheet.action, perTab: {} },
        fill: (el, item) => {
          const key = item.key as SheetAction;
          el.textContent = SHEET_LABELS[key]();
          // A disabled row says why, after its label (the row itself carries aria-disabled). No
          // inline colour: the cursor row's background is light, and `.is-disabled` dims it.
          const reason = item.enabled ? undefined : sheetReason(key, sheet);
          if (reason !== undefined) {
            const why = document.createElement('span');
            why.textContent = ` ${reason}`;
            el.appendChild(why);
          }
        },
      };
    }
    const feed = p.feed;
    if (feed !== null) {
      return {
        variant: 'list',
        title: name,
        layout: foodLayoutOf(feed.foods),
        state: { tab: null, item: feed.activeKey, perTab: {} },
        fill: (el, item) => {
          if (fillBack(el, item)) return;
          const food = feed.foods.find((f) => foodKey(f.itemId) === item.key);
          if (food !== undefined) {
            el.textContent = tf('box.feed.item', { name: food.name, count: food.count });
          }
        },
      };
    }
    const evolve = p.evolve;
    if (evolve !== null) {
      return {
        variant: 'list',
        title: name,
        layout: pathLayout(evolve.mon),
        state: { tab: null, item: evolve.activeKey, perTab: {} },
        fill: (el, item) => {
          if (fillBack(el, item)) return;
          const path = findPath(evolve.mon, item.key);
          if (path === undefined) return;
          const heading = document.createElement('div');
          heading.textContent = tf('evolution.path.heading', { species: path.toSpeciesName });
          // The model's reason stays raw (it is the server's reject wording). A met path that is
          // no choice is the one the server applies itself: it reads as ready, never as offered.
          const status = document.createElement('div');
          status.style.fontSize = '12px'; // colour inherits: the cursor row's background is light
          status.textContent =
            path.unmetReason ??
            (item.enabled
              ? t('evolution.path.allMet')
              : tf('evolution.card.ready', { species: path.toSpeciesName }));
          el.append(heading, status);
        },
      };
    }
    const confirm = p.confirm;
    if (confirm !== null) {
      return {
        variant: 'confirm',
        question: tf('box.evolve.confirm', { name: confirm.name, species: confirm.species }),
        layout: CONFIRM_LAYOUT,
        state: { tab: null, item: confirm.yes ? CONFIRM_YES : 'no', perTab: {} },
        fill: (el, item) => {
          el.textContent = item.key === CONFIRM_YES ? t('prompt.yes') : t('prompt.no');
        },
      };
    }
    return null;
  }

  /** Anchor the shown sheet away from the cursor cell (wf-1's verdict, the kit's rule), once the
   *  grid is rendered and the cell scrolled in. Nothing to place while the sheet is hidden, the
   *  panel has no box (hidden, or no layout engine) or no cell is under the cursor. */
  #placeSheet(): void {
    if (this.#sheet.root.hidden || this.#panel.getBoundingClientRect().width <= 0) return;
    const active = this.#paint.tab === 'party' ? this.#partyEl : this.#boxEl;
    const cell = active.querySelector<HTMLElement>('[data-nav-key].is-active');
    if (cell !== null) placeContextSheet(this.#sheet, this.#panel, cell);
  }

  /** Whether `el` sits in the frame below an inline-hidden part (the root itself excluded). */
  #hiddenInFrame(el: HTMLElement): boolean {
    if (!this.#root.contains(el)) return false;
    for (let n: HTMLElement | null = el; n !== null && n !== this.#root; n = n.parentElement) {
      if (n.style.display === 'none' || n.hidden) return true;
    }
    return false;
  }

  /** Runs `render` for a grid unless `shown` — every card it draws — is what the grid already
   *  shows (a keyed render): `refresh` runs on every store batch, and a rebuild drops focus and
   *  the press in flight. The locale is in the key: the cards' copy is resolved at render. JSON,
   *  never a delimiter join: nicknames are user-chosen. A render that throws leaves the grid with
   *  no key, so the next refresh renders it again. */
  #renderIfChanged(el: HTMLElement, shown: readonly unknown[], render: () => void): void {
    const key = JSON.stringify([currentLocale(), shown], (_, v: unknown) =>
      typeof v === 'bigint' ? `${v}` : v,
    );
    if (this.#rendered.get(el) === key) return;
    this.#rendered.delete(el);
    render();
    this.#rendered.set(el, key);
  }

  #renderParty(slots: readonly (MonsterCardViewModel | null)[]): void {
    this.#renderIfChanged(this.#partyEl, slots, () => this.#buildParty(slots));
  }

  #buildParty(slots: readonly (MonsterCardViewModel | null)[]): void {
    this.#partyEl.replaceChildren();
    this.#partyEl.style.gridTemplateRows = `repeat(${Math.ceil(slots.length / PARTY_COLS)},minmax(0,1fr))`;
    for (let i = 0; i < slots.length; i++) {
      const card = slots[i];
      const el = document.createElement('div');
      el.style.cssText = CELL_STYLE;
      if (card === null) {
        // A cell the D-pad reaches like any other (the model's disabled `slot-<i>` item, uif-6).
        // Dimmed by colour, never opacity (opacity 0.4 fell below AA).
        el.dataset.navKey = slotKey(i);
        el.dataset.empty = '';
        el.setAttribute('aria-disabled', 'true');
        el.textContent = tf('box.party.emptySlot', { slot: i });
        el.style.color = CELL_EMPTY_TEXT;
      } else {
        el.dataset.navKey = String(card.monsterId);
        el.appendChild(this.#renderCard(card));
      }
      this.#partyEl.appendChild(el);
    }
  }

  #renderBox(monsters: readonly MonsterCardViewModel[]): void {
    this.#renderIfChanged(this.#boxEl, monsters, () => this.#buildBox(monsters));
  }

  #buildBox(monsters: readonly MonsterCardViewModel[]): void {
    this.#boxEl.replaceChildren();
    // The cue only over cards: an empty Storage has nothing to scroll, and its EmptyState text then
    // sits on a plain fill (a11y.spec's contrast walk refuses a background-image ancestor).
    this.#boxEl.classList.toggle('mr-scroll', monsters.length > 0);
    if (monsters.length === 0) {
      // uif-6 (UIF6.6): why it is empty, where its monsters come from and what to do next; it
      // spans the grid, and the frame and its tabs stay.
      const empty = createEmptyState(document, {
        reason: t('box.box.empty'),
        cue: t('box.storage.emptyCue'),
        nextStep: t('box.storage.emptyNext'),
      });
      empty.style.gridColumn = '1 / -1';
      this.#boxEl.appendChild(empty);
      return;
    }
    for (const card of monsters) {
      const el = document.createElement('div');
      el.style.cssText = CELL_STYLE;
      el.dataset.navKey = String(card.monsterId);
      el.appendChild(this.#renderCard(card));
      this.#boxEl.appendChild(el);
    }
  }

  #renderCard(card: MonsterCardViewModel): HTMLDivElement {
    const wrap = document.createElement('div');

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = card.nickname || card.speciesName;
    nameSpan.style.fontWeight = 'bold';
    nameRow.appendChild(nameSpan);
    wrap.appendChild(nameRow);

    // Colour inherits from the cell, so the line follows the cursor's inverted fill.
    const info = document.createElement('div');
    info.style.cssText = 'font-size:var(--mr-font-small);margin-top:var(--mr-space-1);';
    info.textContent = tf('box.card.stats', {
      species: card.speciesName,
      level: card.level,
      current: card.currentHp,
      max: card.statHp,
      percent: card.hpPercent,
    });
    wrap.appendChild(info);

    // The evolution-choice badge. Built INSIDE the card (so it is per-monster and
    // is cleared by #buildParty/#buildBox's replaceChildren), never wrapping `header`
    // and never a #root child: the client/e2e/recruit.spec.ts helpers find the box title by
    // its data-testid, take its frame root, and scan the root's text for an `HP cur/max`
    // shape — so this copy carries NO "HP " token.
    if (card.evolutionChoicePending) {
      const badge = document.createElement('div');
      badge.setAttribute('data-testid', 'evo-choice-badge');
      badge.textContent = t('box.card.evolveBadge');
      badge.style.cssText =
        'margin-top:var(--mr-space-1);font-size:var(--mr-font-small);' +
        'border:var(--mr-border-thin) solid currentColor;padding:1px 4px;display:inline-block;';
      wrap.appendChild(badge);
    }

    return wrap;
  }
}

/** Show or hide a frame part by inline display (the house idiom, which `[hidden]` cannot beat
 *  on a part that sets its own display). */
function setShown(el: HTMLElement, shown: boolean, display: string): void {
  el.style.display = shown ? display : 'none';
}
