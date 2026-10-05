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
// the hidden→visible edge, so a KeyB open shows Storage before any button. Both panels stay in the
// DOM (e2e reads the root's textContent); the inactive one and its heading are hidden by inline
// display. The nickname is typed in an in-frame field (no `window.prompt`), sent once per commit
// token the screen hands over.
//
// ctl-8c: the sheet gains Care, Feed… and Evolve…; the food list, the Evolve list (every outgoing
// path, only the choices enabled, the status line raw from the model's reason) and the Yes / No
// confirm are parts of this frame under the sheet, and the "Fed {name}" line joins the feedback
// line. A hidden part is emptied as well as hidden (the e2e text scans read hidden descendants).
import { type MonsterCardViewModel, NEXT_FREE_PARTY_SLOT } from './boxModel';
import { t, tf } from './i18n/resolver';
import {
  cardName,
  findPath,
  foodKey,
  foodLayoutOf,
  pathLayout,
  type SheetAction,
  sheetLayout,
} from './monstersModel';
import { list, type NavTab, tabs } from './nav';
import { navItemId, renderNav, renderTabs } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { MonstersFeedback, MonstersPaint, NicknameCommit } from './screens/monstersScreen';

const TAB_STRIP = tabs([
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
};

/** Why a disabled sheet row is disabled, shown after its label (ctl-8c). */
const SHEET_REASONS: Readonly<Partial<Record<SheetAction, () => string>>> = {
  feed: () => t('box.sheet.feedNone'),
  evolve: () => t('evolution.card.noPaths'),
};

/** The Evolve confirm's answers; No is the screen's default. */
const CONFIRM_YES = 'yes';
const CONFIRM_LAYOUT = list([
  { key: CONFIRM_YES, enabled: true },
  { key: 'no', enabled: true },
]);
/** What a hidden list renders: nothing, so its text is empty too (the e2e text scans read hidden
 *  descendants). */
const EMPTY_LIST = list([]);

/** The sheet-level parts' box: the sheet, the lists and the confirm share it. */
const PART_STYLE = 'width:100%;max-width:600px;margin-bottom:8px;';

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

export interface BoxViewCallbacks {
  /** Called with the nickname field's text when the Monsters screen commits it (CTL8B.3). */
  readonly onSetNickname: (monsterId: bigint, nickname: string) => void;
  /** Called when the user moves a monster to a party slot (0–5), to the next free slot
   *  (`NEXT_FREE_PARTY_SLOT`), or to box (`partySlotNone`). */
  readonly onSetPartySlot: (monsterId: bigint, slot: number) => void;
  /** Unread: the Box's Heal Party button is retired (ctl-10a, B13). */
  readonly onHealParty?: () => void;
  /** The "boxed" party-slot sentinel "To Box" emits: game-core's PARTY_SLOT_NONE, read once
   *  at boot from the `party_slot_none()` wasm export (main.ts) — never a TS literal. */
  readonly partySlotNone: number;
}

export class BoxView {
  readonly #root: HTMLDivElement;
  /** The "Party & Box" heading; its text is resolved in show(), not here (see show()). */
  readonly #titleEl: HTMLHeadingElement;
  readonly #partyEl: HTMLDivElement;
  readonly #boxEl: HTMLDivElement;
  /** Static box-vs-party explainer; never toggled — it states an invariant.
   *  Its text is resolved in show(). */
  readonly #hintEl: HTMLDivElement;
  /** The two section headings; text resolved in show(). */
  readonly #partyLabelEl: HTMLHeadingElement;
  readonly #boxLabelEl: HTMLHeadingElement;
  readonly #callbacks: BoxViewCallbacks;
  #visible = false;
  // ctl-8b: the Monsters frame's parts and the kept paint.
  readonly #tabStrip: HTMLDivElement;
  readonly #sheetEl: HTMLDivElement;
  readonly #sheetName: HTMLDivElement;
  readonly #sheetList: HTMLDivElement;
  // ctl-8c: the food list, the Evolve list and the Yes / No confirm under the sheet.
  readonly #feedList: HTMLDivElement;
  readonly #evolveList: HTMLDivElement;
  readonly #confirmEl: HTMLDivElement;
  readonly #confirmQuestion: HTMLDivElement;
  readonly #confirmList: HTMLDivElement;
  readonly #summaryEl: HTMLDivElement;
  readonly #summaryName: HTMLDivElement;
  readonly #summaryStats: HTMLDivElement;
  readonly #rowEl: HTMLDivElement;
  readonly #rowLabel: HTMLLabelElement;
  readonly #input: HTMLInputElement;
  readonly #feedbackEl: HTMLDivElement;
  #paint: MonstersPaint = OPENING;
  /** The live cards of the last `refresh`, by nav key: a kept paint names the monster, the batch
   *  that renamed or healed it since is what shows. */
  #cards = new Map<string, MonsterCardViewModel>();
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
    // display toggle and the centring.
    this.#root.className = 'mr-frame mr-shell';
    this.#root.style.cssText = 'display:none;align-items:center;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:16px;margin-bottom:16px;';
    // NO text here — `box.title` is resolved in show() (see there for why).
    const title = document.createElement('h2');
    // The OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'box-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0;color:#fff;';
    this.#titleEl = title;
    header.appendChild(title);
    this.#root.appendChild(header);

    // ctl-8b: the tabs, the sheet, its summary and typing row and the Move line, all BEFORE the
    // hint and the panels. Typing mode's Escape focuses the frame's first enabled non-text
    // control: the sheet's nav list (Enter there is the router's A), never a card's To Party /
    // To Box button.
    this.#tabStrip = document.createElement('div');
    this.#tabStrip.className = 'mr-frame-tabstrip';
    this.#root.appendChild(this.#tabStrip);

    this.#sheetEl = document.createElement('div');
    this.#sheetEl.style.cssText = PART_STYLE;
    this.#sheetName = document.createElement('div');
    this.#sheetName.id = 'monsters-sheet-name';
    this.#sheetName.style.fontWeight = 'bold';
    this.#sheetList = document.createElement('div');
    this.#summaryEl = document.createElement('div');
    this.#summaryName = document.createElement('div');
    this.#summaryStats = document.createElement('div');
    this.#summaryEl.append(this.#summaryName, this.#summaryStats);
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
    this.#sheetEl.append(this.#sheetName, this.#sheetList);
    // ctl-8c: the lists and the confirm sit right under the sheet, before the summary and the
    // typing row (and so before the hint and the panels, for the typing-mode Escape rule above).
    this.#feedList = document.createElement('div');
    this.#feedList.style.cssText = PART_STYLE;
    this.#evolveList = document.createElement('div');
    this.#evolveList.style.cssText = PART_STYLE;
    this.#confirmEl = document.createElement('div');
    this.#confirmEl.style.cssText = PART_STYLE;
    this.#confirmQuestion = document.createElement('div');
    this.#confirmQuestion.id = 'monsters-evolve-question';
    this.#confirmQuestion.style.fontWeight = 'bold';
    this.#confirmList = document.createElement('div');
    this.#confirmEl.append(this.#confirmQuestion, this.#confirmList);
    this.#root.append(
      this.#sheetEl,
      this.#feedList,
      this.#evolveList,
      this.#confirmEl,
      this.#summaryEl,
      this.#rowEl,
    );

    this.#feedbackEl = document.createElement('div');
    this.#feedbackEl.className = 'mr-frame-feedback';
    this.#root.appendChild(this.#feedbackEl);

    // A direct #root child, so it cannot be wiped by #renderParty / #renderBox,
    // which only touch #partyEl / #boxEl. A SIBLING of `header`, never wrapping it:
    // three client/e2e/recruit.spec.ts sites resolve this root as
    // h2['Party & Box'].parentElement.parentElement, and a wrapper retargets that chain.
    // The copy DESCRIBES the "To Party" button (#renderCard) rather than commanding a click —
    // the empty-box short-circuit below renders no such button in the fresh-player state.
    // Its text (`box.hint`) is resolved in show(), not here.
    this.#hintEl = document.createElement('div');
    this.#hintEl.setAttribute('data-testid', 'box-party-hint');
    this.#hintEl.style.cssText = 'max-width:600px;margin:0 0 12px;font-size:12px;color:#aaa;';
    this.#root.appendChild(this.#hintEl);

    // Its text (`box.section.party`) is resolved in show(), not here.
    const partyLabel = document.createElement('h3');
    partyLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#partyLabelEl = partyLabel;
    this.#root.appendChild(partyLabel);

    // ctl-8b: one column, because the Party is a list (Up / Down step one monster).
    this.#partyEl = document.createElement('div');
    this.#partyEl.style.cssText =
      'display:grid;grid-template-columns:1fr;gap:8px;width:100%;max-width:600px;margin-bottom:16px;';
    this.#root.appendChild(this.#partyEl);

    // Its text (`box.section.box`) is resolved in show(), not here.
    const boxLabel = document.createElement('h3');
    boxLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#boxLabelEl = boxLabel;
    this.#root.appendChild(boxLabel);

    this.#boxEl = document.createElement('div');
    this.#boxEl.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:600px;';
    this.#root.appendChild(this.#boxEl);

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
    this.#partyLabelEl.textContent = t('box.section.party');
    this.#boxLabelEl.textContent = t('box.section.box');
    this.#rowLabel.textContent = t('box.rename.prompt');
    this.#root.style.display = 'flex';
    if (wasVisible) return;
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
    this.#root.style.display = 'none';
    closeOverlayA11y('boxView', null);
  }

  refresh(
    partySlots: readonly (MonsterCardViewModel | null)[],
    boxMonsters: readonly MonsterCardViewModel[],
  ): void {
    this.#renderParty(partySlots);
    this.#renderBox(boxMonsters);
    this.#cards = new Map(
      [...partySlots, ...boxMonsters]
        .filter((card): card is MonsterCardViewModel => card !== null)
        .map((card) => [String(card.monsterId), card]),
    );
    this.#apply();
  }

  /** The Monsters screen's paint: kept, so the next `refresh` re-applies it. */
  paint(p: MonstersPaint): void {
    this.#paint = p;
    this.#apply();
  }

  /** Apply the kept paint: send a new commit token's text, then the tabs and the panel shown, the
   *  cursor card (class, aria-current and an outline: never colour alone), the sheet, its summary
   *  and typing row, and the Move line. Focus never stays in a part this hides. */
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

    renderTabs(
      this.#tabStrip,
      TAB_STRIP,
      { tab: p.tab, item: null, perTab: {} },
      {
        frame: 'monsters',
        label: tabLabel,
      },
    );
    const onParty = p.tab === 'party';
    setShown(this.#partyLabelEl, onParty, '');
    setShown(this.#partyEl, onParty, 'grid');
    setShown(this.#boxLabelEl, !onParty, '');
    setShown(this.#boxEl, !onParty, 'grid');

    const active = onParty ? this.#partyEl : this.#boxEl;
    const key =
      p.activeKey ?? active.querySelector<HTMLElement>('[data-nav-key]')?.dataset.navKey ?? null;
    for (const grid of [this.#partyEl, this.#boxEl]) {
      for (const el of Array.from(grid.querySelectorAll<HTMLElement>('[data-nav-key]'))) {
        const on = grid === active && el.dataset.navKey === key;
        el.classList.toggle('is-active', on);
        el.style.outline = on ? CURSOR_OUTLINE : '';
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

    const sheet = p.sheet;
    setShown(this.#sheetEl, sheet !== null, '');
    this.#sheetName.textContent = sheet === null ? '' : cardName(live(sheet.card));
    // Rendered empty when there is no sheet, so the hidden list holds no text either.
    renderNav(
      this.#sheetList,
      sheet === null ? EMPTY_LIST : sheetLayout(sheet.canFeed, sheet.canEvolve),
      { tab: null, item: sheet === null ? null : sheet.action, perTab: {} },
      {
        frame: 'monstersSheet',
        labelledBy: this.#sheetName.id,
        fill: (el, item) => {
          const key = item.key as SheetAction;
          el.textContent = SHEET_LABELS[key]();
          // A disabled row says why, after its label (the row itself carries aria-disabled). No
          // inline colour: the cursor row's background is light, and `.is-disabled` dims it.
          const reason = item.enabled ? undefined : SHEET_REASONS[key];
          if (reason !== undefined) {
            const why = document.createElement('span');
            why.textContent = ` ${reason()}`;
            el.appendChild(why);
          }
        },
      },
    );

    // ctl-8c: the food list, the Evolve list and the confirm. A hidden part is rendered EMPTY as
    // well as hidden: the e2e helpers read the root's textContent, hidden descendants included.
    const feed = p.feed;
    setShown(this.#feedList, feed !== null, '');
    renderNav(
      this.#feedList,
      feed === null ? EMPTY_LIST : foodLayoutOf(feed.foods),
      { tab: null, item: feed === null ? null : feed.activeKey, perTab: {} },
      {
        frame: 'monstersFeed',
        // Named by the sheet row that opened it (the sheet is painted under the list).
        labelledBy: navItemId('monstersSheet', null, 'feed'),
        fill: (el, item) => {
          const food = feed?.foods.find((f) => foodKey(f.itemId) === item.key);
          if (food !== undefined) {
            el.textContent = tf('box.feed.item', { name: food.name, count: food.count });
          }
        },
      },
    );

    const evolve = p.evolve;
    setShown(this.#evolveList, evolve !== null, '');
    renderNav(
      this.#evolveList,
      evolve === null ? EMPTY_LIST : pathLayout(evolve.mon),
      { tab: null, item: evolve === null ? null : evolve.activeKey, perTab: {} },
      {
        frame: 'monstersEvolve',
        labelledBy: navItemId('monstersSheet', null, 'evolve'),
        fill: (el, item) => {
          const path = evolve === null ? undefined : findPath(evolve.mon, item.key);
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
      },
    );

    const confirm = p.confirm;
    setShown(this.#confirmEl, confirm !== null, '');
    this.#confirmQuestion.textContent =
      confirm === null
        ? ''
        : tf('box.evolve.confirm', { name: confirm.name, species: confirm.species });
    renderNav(
      this.#confirmList,
      confirm === null ? EMPTY_LIST : CONFIRM_LAYOUT,
      { tab: null, item: confirm === null ? null : confirm.yes ? 'yes' : 'no', perTab: {} },
      {
        frame: 'monstersConfirm',
        labelledBy: this.#confirmQuestion.id,
        fill: (el, item) => {
          el.textContent = item.key === CONFIRM_YES ? t('prompt.yes') : t('prompt.no');
        },
      },
    );

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

    const feedback = p.feedback;
    setShown(this.#feedbackEl, feedback !== null, '');
    this.#feedbackEl.textContent = feedback === null ? '' : feedbackText(feedback);
    if (feedback === null) this.#feedbackEl.removeAttribute('data-feedback');
    else this.#feedbackEl.dataset.feedback = 'ok';

    // A part hidden under the focus would strand it (the next key would heal focus to the world,
    // out of the frame): hand it to the frame's anchor.
    const focused = document.activeElement;
    if (this.#visible && focused instanceof HTMLElement && this.#hiddenInFrame(focused)) {
      this.#titleEl.focus();
    }
  }

  /** Whether `el` sits in the frame below an inline-hidden part (the root itself excluded). */
  #hiddenInFrame(el: HTMLElement): boolean {
    if (!this.#root.contains(el)) return false;
    for (let n: HTMLElement | null = el; n !== null && n !== this.#root; n = n.parentElement) {
      if (n.style.display === 'none') return true;
    }
    return false;
  }

  /** Runs `render` for a grid unless `shown` — every card it draws — is what the grid already
   *  shows (the pvpView shape): `refresh` runs on every store batch, and a rebuild drops focus and
   *  the press in flight. JSON, never a delimiter join: nicknames are user-chosen. A render that
   *  throws leaves the grid with no key, so the next refresh renders it again. */
  #renderIfChanged(el: HTMLElement, shown: readonly unknown[], render: () => void): void {
    const key = JSON.stringify(shown, (_, v: unknown) => (typeof v === 'bigint' ? `${v}` : v));
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
    for (let i = 0; i < slots.length; i++) {
      const card = slots[i];
      const el = document.createElement('div');
      el.style.cssText =
        'border:1px solid #444;border-radius:4px;padding:8px;min-height:80px;background:#1a1a2e;';
      if (card === null) {
        el.textContent = tf('box.party.emptySlot', { slot: i });
        // Dimmed by colour, never opacity: #aaa keeps 7:1 on the card (opacity 0.4 fell below AA).
        el.style.color = '#aaa';
      } else {
        el.dataset.navKey = String(card.monsterId);
        el.appendChild(this.#renderCard(card, true));
      }
      this.#partyEl.appendChild(el);
    }
  }

  #renderBox(monsters: readonly MonsterCardViewModel[]): void {
    this.#renderIfChanged(this.#boxEl, monsters, () => this.#buildBox(monsters));
  }

  #buildBox(monsters: readonly MonsterCardViewModel[]): void {
    this.#boxEl.replaceChildren();
    if (monsters.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('box.box.empty');
      empty.style.color = '#aaa';
      this.#boxEl.appendChild(empty);
      return;
    }
    for (const card of monsters) {
      const el = document.createElement('div');
      el.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;background:#1a1a2e;';
      el.dataset.navKey = String(card.monsterId);
      el.appendChild(this.#renderCard(card, false));
      this.#boxEl.appendChild(el);
    }
  }

  #renderCard(card: MonsterCardViewModel, inParty: boolean): HTMLDivElement {
    const wrap = document.createElement('div');

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = card.nickname || card.speciesName;
    nameSpan.style.fontWeight = 'bold';
    nameRow.appendChild(nameSpan);
    wrap.appendChild(nameRow);

    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;margin-top:4px;color:#ccc;';
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
    // and never a #root child: five client/e2e/recruit.spec.ts sites resolve the box root
    // as h2['Party & Box'].parentElement.parentElement, and those helpers scan the root's
    // text for an `HP cur/max` shape — so this copy carries NO "HP " token.
    if (card.evolutionChoicePending) {
      const badge = document.createElement('div');
      badge.setAttribute('data-testid', 'evo-choice-badge');
      badge.textContent = t('box.card.evolveBadge');
      badge.style.cssText =
        'margin-top:4px;font-size:11px;color:#fbbf24;border:1px solid #fbbf24;' +
        'border-radius:3px;padding:1px 4px;display:inline-block;';
      wrap.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:6px;';
    if (inParty) {
      const toBoxBtn = document.createElement('button');
      toBoxBtn.textContent = t('box.card.toBox');
      toBoxBtn.style.cssText = 'font-size:11px;cursor:pointer;';
      toBoxBtn.addEventListener('click', () =>
        this.#callbacks.onSetPartySlot(card.monsterId, this.#callbacks.partySlotNone),
      );
      actions.appendChild(toBoxBtn);
    } else {
      const toPartyBtn = document.createElement('button');
      toPartyBtn.textContent = t('box.card.toParty');
      toPartyBtn.style.cssText = 'font-size:11px;cursor:pointer;';
      toPartyBtn.addEventListener('click', () =>
        this.#callbacks.onSetPartySlot(card.monsterId, NEXT_FREE_PARTY_SLOT),
      );
      actions.appendChild(toPartyBtn);
    }
    wrap.appendChild(actions);

    return wrap;
  }
}

/** Show or hide a frame part by inline display (the house idiom, which `[hidden]` cannot beat
 *  on a part that sets its own display). */
function setShown(el: HTMLElement, shown: boolean, display: string): void {
  el.style.display = shown ? display : 'none';
}
