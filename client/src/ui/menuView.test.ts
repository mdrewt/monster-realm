// @vitest-environment happy-dom
// ui/menuView.test.ts — ctl-5 (CTL5.1, CTL5.4): the THIN main-menu DOM shell.
//
// The view now only paints a view model from `screens/mainMenuScreen.ts` through the ctl-4 kit
// (`createFrame` side panel, `renderNav`, `renderFeedback`) and forwards ONE input:
// `onInput({ kind: 'pick', key })` from a delegated click. It owns no key handling (the router
// drives the menu), no hover and no markup parsing. Contract pinned here:
//
//   new MenuView({ onInput })      resolves #menu-overlay, #menu-rows, #menu-heading and
//                                  #menu-back-hint (throws on a missing one); builds a `side`
//                                  frame inside #menu-overlay (right-hand panel, margin-left auto)
//                                  and moves #menu-rows into its body; hides the old heading and
//                                  back hint. Constructing again over the same markup REUSES the
//                                  frame (plan A9).
//   render(vm)                     title + breadcrumb, nav rows (ids `{frameId}-root-{key}`),
//                                  feedback line.
//   show() / hide()                edge-guarded openOverlayA11y('menuView') / unguarded close.
//   setCovered(b)                  visibility hidden while a child screen is above (plan A1).
//
// RETIRED TEST IDS -> reason -> survivor:
//   MV-RENDER-01/02/03/04/05      the old `{heading, rows, backHint}` view model with `data-menu-*`
//                                 rows and `${glyph} — ${title}` text is deleted; survivors:
//                                 CTL5-1-SIDE-PANEL, MV-RENDER-REPLACES, MV-A11Y-OPTION-01.
//   MV-RENDER-06                  survives as MV-RENDER-XSS (labels are literal text; A11).
//   MV-INPUT-01/02/03/04/05       `{kind:'click', index}` / `{kind:'hover'}` and the disabled-row
//                                 emission are deleted (no hover, no disabled entries, picks carry
//                                 the nav KEY); survivors: MV-INPUT-PICK (one delegated click,
//                                 survives re-render, ignores the list's own padding, no hover).
//   MV-OPENS-WITH-NO-LAUNCHER-IN-DOM  survives as MV-OPENS-WITH-NO-LAUNCHER (new view model).
//   MV-NO-INNERHTML (source scan) forbidden check shape; its property survives as the behaviour
//                                 test MV-RENDER-XSS (a label and a title containing markup render
//                                 as literal text, no elements injected).
//   MV-A11Y-LISTBOX-01            the role is now written by the kit on render, not by the
//                                 constructor; survivor: MV-A11Y-LISTBOX (role + IDREF to the
//                                 frame title after render).
//   MV-A11Y-OPTION-01             survives as MV-A11Y-OPTION-01 (roles, aria-selected, no tabindex
//                                 on a row); the non-bubbling per-row keydown probe moves to
//                                 MV-NO-KEYDOWN.
//   MV-A11Y-OPTIONID-01, MV-A11Y-ACTIVEDESC-01/02, MV-A11Y-ACTIVEDESC-LEVEL-01
//                                 the `menu-option-<level>-<index>` ids are replaced by the kit's
//                                 `{frame}-root-{key}` ids; survivor: MV-A11Y-ACTIVEDESC (tracks the
//                                 cursor, resolves to a live option, changes value when the level
//                                 changes: the P1 defect's property).
//   MV-A11Y-OPEN-ARIA-01, -OPEN-FOCUS-01, -CLOSE-FOCUS-01, -CLOSE-UNGUARDED-01,
//   MV-A11Y-VISIBLE-READS-DOM-01, -REOPEN-EDGE-01
//                                 unchanged contract (show/hide keep the edge-guarded open and the
//                                 unguarded close); kept under the same ids with the new view model.
//   MV-KEYNAV-OWNS-01 / MV-KEYNAV-BUBBLES-01 / MV-KEYNAV-HIDDEN-01 / MV-KEYNAV-EFFECT-INERT-01
//                                 none: the old keydown/hover/glyph contract is deleted by CTL5.2
//                                 (the router is the only key driver; `menuStep` is gone).
//                                 MV-KEYNAV-BUBBLES-01's "the view consumes nothing" half survives
//                                 as MV-NO-KEYDOWN.
//   MV-KEYDOWN-PAIRED-SOURCE, MV-SOURCE-SSOT-01, MV-NO-FOCUS-CALL
//                                 source-text scans (forbidden check shape) of a keydown listener,
//                                 `menuKeyInput(` and `.focus(` that no longer exist; the
//                                 behaviours survive as MV-NO-KEYDOWN, MV-A11Y-LISTBOX (IDREF read
//                                 off the live title) and MV-A11Y-OPEN-FOCUS-01 / -REOPEN-EDGE-01
//                                 (focus moves only through overlayA11y).
//   MV-VIS-01/02/03, MV-CTOR-01..05
//                                 survive unchanged in intent (MV-VIS-03 now also keeps the frame).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { MenuView } from './menuView';
import { EMPTY_NAV_MEMORY } from './nav';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import { mainMenuPick, mainMenuStep, menuViewModel, openMainMenu } from './screens/mainMenuScreen';

// MECHANISM oracle: records every call AND calls through to the real implementation.
vi.mock('./overlayA11y', { spy: true });

type Vm = ReturnType<typeof menuViewModel>;

const OVERLAY_ID = 'menu-overlay';
const OUTSIDE_SENTINEL_ID = 'ctl5-outside-sentinel';

const rootVm = (): Vm => menuViewModel(openMainMenu(EMPTY_NAV_MEMORY));
const socialState = () => mainMenuPick(openMainMenu(EMPTY_NAV_MEMORY), 'social').state;
const socialVm = (): Vm => menuViewModel(socialState());

const ROOT_KEYS = ['monsters', 'bag', 'journal', 'social', 'profile', 'options', 'close'];
const ROOT_LABELS = ['Monsters', 'Bag', 'Journal', 'Social', 'Profile', 'Options', 'Close'];

/** ONE REAL macrotask boundary (the deferred focus is a real `setTimeout(0)`). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function teardown(): void {
  // ctl-7a: `help-hint` is retired from index.html; the fixture sentinels are the hint-bar chips.
  for (const id of [
    OVERLAY_ID,
    'menu-launcher',
    'chip-start',
    'chip-select',
    OUTSIDE_SENTINEL_ID,
  ]) {
    document.getElementById(id)?.remove();
  }
}

/** Mount the shell the way client/index.html ships it. `omit` drops one child for the throw paths. */
function mountMenuOverlay(omit?: 'menu-heading' | 'menu-rows' | 'menu-back-hint'): HTMLElement {
  teardown();
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.display = 'none';
  // Sentinels: show()/hide()/setCovered() must not clobber unrelated inline styles.
  overlay.style.zIndex = '100';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  if (omit !== 'menu-heading') {
    const heading = document.createElement('div');
    heading.id = 'menu-heading';
    overlay.appendChild(heading);
  }
  if (omit !== 'menu-rows') {
    const rows = document.createElement('ul');
    rows.id = 'menu-rows';
    rows.setAttribute('tabindex', '0');
    overlay.appendChild(rows);
  }
  if (omit !== 'menu-back-hint') {
    const hint = document.createElement('div');
    hint.id = 'menu-back-hint';
    overlay.appendChild(hint);
  }
  document.body.appendChild(overlay);
  return overlay;
}

beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
});

const rowsEl = (): HTMLElement => document.getElementById('menu-rows') as HTMLElement;
const optionEls = (): HTMLElement[] =>
  Array.from(rowsEl().querySelectorAll<HTMLElement>('[role="option"]'));
const frameEl = (): HTMLElement => document.querySelector('.mr-frame') as HTMLElement;
const titleEl = (): HTMLElement => frameEl().querySelector('.mr-frame-title') as HTMLElement;
const crumbTexts = (): string[] =>
  Array.from(frameEl().querySelectorAll('.mr-frame-crumb')).map((c) => c.textContent ?? '');
const feedbackEl = (): HTMLElement => frameEl().querySelector('.mr-frame-feedback') as HTMLElement;

function newView(): { view: MenuView; onInput: ReturnType<typeof vi.fn> } {
  const onInput = vi.fn();
  return { view: new MenuView({ onInput }), onInput };
}

// ===========================================================================
// construction
// ===========================================================================

describe('MenuView — construction', () => {
  afterEach(() => {
    teardown();
  });

  it('MV-CTOR-01: throws when #menu-overlay is absent', () => {
    // WRONG IMPL KILLED: a shell that stores a null overlay and fails later from a window listener.
    teardown();
    expect(() => new MenuView({ onInput: vi.fn() })).toThrow();
  });

  it('MV-CTOR-02: throws when #menu-heading is absent', () => {
    mountMenuOverlay('menu-heading');
    expect(() => new MenuView({ onInput: vi.fn() })).toThrow();
  });

  it('MV-CTOR-03: throws when #menu-rows is absent', () => {
    mountMenuOverlay('menu-rows');
    expect(() => new MenuView({ onInput: vi.fn() })).toThrow();
  });

  it('MV-CTOR-04: throws when #menu-back-hint is absent', () => {
    mountMenuOverlay('menu-back-hint');
    expect(() => new MenuView({ onInput: vi.fn() })).toThrow();
  });

  it('MV-CTOR-05: MenuView takes exactly one (callbacks) parameter', () => {
    // WRONG IMPL KILLED: a shell that wires its own store or main.ts imports for input handling.
    expect(MenuView.length).toBe(1);
  });

  it('CTL5-1-SIDE-PANEL: the menu is one `side` frame in the overlay holding the nav list, titled Menu with no breadcrumb, listing the seven entries; a sub-list renders under a Menu breadcrumb with its own ids; the old heading and back hint are hidden', () => {
    // WRONG IMPL KILLED: a menu still painted as the full-screen bare list (no frame, no title
    // bar), a frame of another size, a frame that is not pushed to the right-hand side, the nav
    // container left outside the frame body (the registry anchor must stay the single tab stop),
    // the English back-hint and heading elements still visible (B11), a root list that misses
    // Close or is out of order, a sub-list without the Menu breadcrumb, nav ids shared across
    // levels, and a title that does not follow the level.
    const overlay = mountMenuOverlay();
    const heading = document.getElementById('menu-heading') as HTMLElement;
    const hint = document.getElementById('menu-back-hint') as HTMLElement;
    const { view } = newView();

    const frames = overlay.querySelectorAll('.mr-frame');
    expect(frames.length, 'exactly one frame').toBe(1);
    const frame = frames[0] as HTMLElement;
    expect(frame.parentElement, 'inside the overlay').toBe(overlay);
    expect(frame.classList.contains('mr-frame--side'), 'the side-panel size').toBe(true);
    expect(frame.dataset.size).toBe('side');
    expect(frame.style.marginLeft, 'pushed to the right-hand side').toBe('auto');
    expect(frame.querySelector('.mr-frame-body'), 'the frame has a body').not.toBeNull();
    expect(rowsEl().parentElement, 'the nav container lives in the frame body').toBe(
      frame.querySelector('.mr-frame-body'),
    );
    expect(heading.hasAttribute('hidden'), 'the old heading is hidden').toBe(true);
    expect(hint.hasAttribute('hidden'), 'the old back hint is hidden').toBe(true);

    view.render(rootVm());
    expect(titleEl().textContent).toBe('Menu');
    expect(titleEl().id).toBe('menu-title');
    expect(crumbTexts(), 'no breadcrumb at the root').toEqual([]);
    expect(optionEls().map((o) => o.id)).toEqual(ROOT_KEYS.map((k) => `menu-root-${k}`));
    expect(optionEls().map((o) => o.textContent)).toEqual(ROOT_LABELS);
    expect(rowsEl().getAttribute('aria-activedescendant')).toBe('menu-root-monsters');

    view.render(socialVm());
    expect(titleEl().textContent, 'the title follows the level').toBe('Social');
    expect(crumbTexts(), 'breadcrumb Menu then the group title').toEqual(['Menu']);
    expect(optionEls().map((o) => o.id)).toEqual([
      'menuSocial-root-trades',
      'menuSocial-root-challenges',
      'menuSocial-root-rankings',
    ]);
    expect(optionEls().map((o) => o.textContent)).toEqual(['Trades', 'Challenges', 'Rankings']);
    expect(overlay.querySelectorAll('.mr-frame').length, 'still one frame').toBe(1);
  });

  it('constructing a second view over the same shared markup reuses the frame instead of building another (plan A9)', () => {
    // WRONG IMPL KILLED: a constructor that always builds a frame (the wiring tests construct the
    // view repeatedly over one shared shell, so a second frame would appear and #menu-rows would
    // be moved into it, leaving the first frame empty).
    const overlay = mountMenuOverlay();
    newView();
    const second = newView();
    expect(overlay.querySelectorAll('.mr-frame').length, 'one frame after two constructions').toBe(
      1,
    );
    second.view.render(rootVm());
    expect(rowsEl().closest('.mr-frame')).toBe(frameEl());
    expect(titleEl().textContent).toBe('Menu');
    expect(optionEls().length).toBe(7);
  });
});

// ===========================================================================
// visibility and the covered state
// ===========================================================================

describe('MenuView — visibility', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('MV-VIS-01: visible is false at construction', () => {
    // WRONG IMPL KILLED: a shell that shows itself in the constructor (it would occlude the
    // world from the first frame, before the player has even joined).
    expect(newView().view.visible).toBe(false);
  });

  it('MV-VIS-02: show() then hide() flips `visible` and writes ONLY style.display', () => {
    // WRONG IMPL KILLED: a no-op show/hide, a `visible` getter that does not read the DOM, and a
    // write of the whole style attribute (which would drop the overlay's inline z-index).
    const { view } = newView();
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    view.show();
    expect(view.visible).toBe(true);
    expect(overlay.style.display).not.toBe('none');
    expect(overlay.style.zIndex, 'show() must not clobber the other inline styles').toBe('100');
    view.hide();
    expect(view.visible).toBe(false);
    expect(overlay.style.display).toBe('none');
    expect(overlay.style.zIndex, 'hide() must not clobber the other inline styles').toBe('100');
  });

  it('MV-VIS-03: hide() keeps the frame, the nav list and its rows — a later render still paints', () => {
    // WRONG IMPL KILLED: a hide() that empties or rebuilds the overlay, so a later render() would
    // write into detached nodes and paint nothing, forever.
    const { view } = newView();
    view.show();
    view.render(rootVm());
    view.hide();
    expect(document.querySelectorAll('.mr-frame').length).toBe(1);
    expect(rowsEl().closest('.mr-frame')).toBe(frameEl());
    expect(optionEls().length).toBe(7);
    view.render(socialVm());
    expect(optionEls().length, 'a render after hide still paints').toBe(3);
  });

  it('setCovered hides the overlay without un-showing it: visibility hidden while a child screen is above, restored after, and no other inline style is touched (plan A1)', () => {
    // WRONG IMPL KILLED: a z-index based cover (an in-flow child shell would still paint under the
    // fixed menu), a cover that flips display (the menu would read as closed and the stack mirror
    // would pop it), a cover that is not undone, and one that overwrites the z-index sentinel.
    const { view } = newView();
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    view.show();
    view.render(rootVm());

    view.setCovered(true);
    expect(overlay.style.visibility).toBe('hidden');
    expect(view.visible, 'covered is not closed').toBe(true);
    expect(overlay.style.display).not.toBe('none');
    expect(overlay.style.zIndex).toBe('100');
    view.setCovered(true);
    expect(overlay.style.visibility, 'covering twice stays covered').toBe('hidden');

    view.setCovered(false);
    expect(overlay.style.visibility, 'uncovering restores it').toBe('');
    expect(view.visible).toBe(true);
    expect(overlay.style.zIndex).toBe('100');
  });
});

// ===========================================================================
// render
// ===========================================================================

describe('MenuView — render', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('MV-RENDER-REPLACES: a re-render replaces the rows of the previous level — no stale rows, no growth', () => {
    // WRONG IMPL KILLED: an append-instead-of-replace list (every cursor move would grow it), and
    // a sub-list that leaves the root's rows behind.
    const { view } = newView();
    view.render(rootVm());
    expect(optionEls().length, 'ANTI-VACUITY: the root paints 7 rows').toBe(7);
    view.render(socialVm());
    expect(optionEls().map((o) => o.dataset.navKey)).toEqual(['trades', 'challenges', 'rankings']);
    expect(rowsEl().children.length, 'no stale node survives').toBe(3);
    view.render(rootVm());
    expect(rowsEl().children.length).toBe(7);
    view.render(rootVm());
    expect(rowsEl().children.length, 'the same render twice does not grow it').toBe(7);
  });

  it('MV-RENDER-XSS: a label or a title containing markup renders as literal text — no element is injected (ADR-0135)', () => {
    // WRONG IMPL KILLED: `innerHTML` (or any markup-parsing sink) for a label or the title; the
    // old source scan's property, as a behaviour. Catalog text is static today, but a later
    // entry may interpolate a player-controlled name.
    const { view } = newView();
    const malicious = '<b>bold</b><img src=x onerror=alert(1)><script>bad()</script>';
    const vm = rootVm();
    view.render({
      ...vm,
      title: '<i>title</i>',
      labels: { ...vm.labels, monsters: malicious },
    });
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    for (const tag of ['b', 'i', 'img', 'script']) {
      expect(overlay.querySelector(tag), `no <${tag}> was injected`).toBeNull();
    }
    expect((document.getElementById('menu-root-monsters') as HTMLElement).textContent).toBe(
      malicious,
    );
    expect(titleEl().textContent).toBe('<i>title</i>');
  });

  it('MV-A11Y-LISTBOX: after a render #menu-rows is a listbox named by the frame title element (IDREF read off the live title), and the name follows the level', () => {
    // WRONG IMPL KILLED: a list with no role, an aria-label with a frozen literal (the name would
    // say Menu inside Social), an IDREF that dangles (a hard-coded id for an element that is not
    // the title), and a container that is not the single tab stop.
    const { view } = newView();
    view.render(rootVm());
    const rows = rowsEl();
    expect(rows.getAttribute('role')).toBe('listbox');
    expect(rows.getAttribute('tabindex'), 'the container is the one tab stop').toBe('0');
    const labelledBy = rows.getAttribute('aria-labelledby');
    expect(labelledBy, 'named by IDREF').not.toBeNull();
    expect(document.getElementById(labelledBy ?? ''), 'resolves to the live title').toBe(titleEl());
    expect(titleEl().textContent).toBe('Menu');

    view.render(socialVm());
    expect(
      document.getElementById(rows.getAttribute('aria-labelledby') ?? ''),
      'still the live title, now naming the sub-list',
    ).toBe(titleEl());
    expect(titleEl().textContent).toBe('Social');
  });

  it('MV-A11Y-OPTION-01: every row is role="option" with an explicit aria-selected (exactly one true), no aria-disabled, and never a tabindex', () => {
    // WRONG IMPL KILLED: rows left as bare nodes inside a listbox (no options exposed), an absent
    // aria-selected on unselected rows, aria-disabled="false" noise, and a tabindex on a row (a
    // mouse-focusable row is destroyed by the next render and orphans focus to <body>).
    const { view } = newView();
    view.render(rootVm());
    const options = optionEls();
    expect(options.length).toBe(7);
    for (const option of options) {
      expect(option.hasAttribute('tabindex'), `${option.id}: no tabindex`).toBe(false);
      expect(option.hasAttribute('aria-disabled'), `${option.id}: nothing is disabled`).toBe(false);
      expect(['true', 'false']).toContain(option.getAttribute('aria-selected'));
    }
    expect(
      options.filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.id),
    ).toEqual(['menu-root-monsters']);
  });

  it('MV-A11Y-ACTIVEDESC: aria-activedescendant tracks the cursor across renders, resolves to a live selected option inside the list, and changes value when the level changes', () => {
    // WRONG IMPL KILLED: a set-once pointer (the cursor moves, the announcement does not), a
    // pointer that names a node the render replaced, and the P1 defect: the same value at two
    // levels (a descent that announces nothing).
    const { view } = newView();
    const start = openMainMenu(EMPTY_NAV_MEMORY);
    view.render(menuViewModel(start));
    const first = rowsEl().getAttribute('aria-activedescendant');
    expect(first).toBe('menu-root-monsters');

    const moved = mainMenuStep(start, { button: 'Down', repeat: false }).state;
    view.render(menuViewModel(moved));
    const second = rowsEl().getAttribute('aria-activedescendant');
    expect(second, 'the pointer follows the cursor').toBe('menu-root-bag');
    const el = document.getElementById(second ?? '');
    expect(el, 'resolves to a live element').not.toBeNull();
    expect(rowsEl().contains(el), 'inside the list').toBe(true);
    expect(el?.getAttribute('aria-selected')).toBe('true');
    expect(el?.textContent).toBe('Bag');

    view.render(socialVm());
    const inGroup = rowsEl().getAttribute('aria-activedescendant');
    expect(inGroup, 'descending changes the pointer value').toBe('menuSocial-root-trades');
    expect(inGroup).not.toBe(second);
    expect(document.getElementById(inGroup ?? '')?.getAttribute('aria-selected')).toBe('true');

    const back = mainMenuStep(socialState(), { button: 'B', repeat: false }).state;
    view.render(menuViewModel(back));
    expect(rowsEl().getAttribute('aria-activedescendant'), 'B lands on the group entry').toBe(
      'menu-root-social',
    );
  });

  it("CTL5-4-FEEDBACK-LINE: the feedback line shows the view model's feedback text with its kind, is replaced by the next one, empties when there is none, and is not a live region", () => {
    // WRONG IMPL KILLED: a frame whose feedback line is never painted (Y would do nothing
    // visible), text appended instead of replaced, a stale line after a move (the view model says
    // none), a feedback line that is an aria-live region (it would double-announce with
    // #a11y-live), and text painted as markup.
    const { view } = newView();
    const vm = rootVm();
    expect(feedbackEl().textContent, 'nothing before any feedback').toBe('');

    view.render({
      ...vm,
      feedback: { kind: 'info', text: 'Review your quests and their progress.' },
    });
    expect(feedbackEl().textContent).toBe('Review your quests and their progress.');
    expect(feedbackEl().dataset.feedback).toBe('info');
    expect(feedbackEl().hasAttribute('aria-live'), 'not a live region').toBe(false);

    view.render({
      ...vm,
      feedback: { kind: 'info', text: 'Close the menu and return to the world.' },
    });
    expect(feedbackEl().textContent, 'replaced, not appended').toBe(
      'Close the menu and return to the world.',
    );

    view.render({ ...vm, feedback: { kind: 'info', text: '<b>x</b>' } });
    expect(feedbackEl().querySelector('b'), 'literal text').toBeNull();
    expect(feedbackEl().textContent).toBe('<b>x</b>');

    view.render(vm);
    expect(feedbackEl().textContent, 'cleared when the view model has none').toBe('');
    expect(feedbackEl().hasAttribute('data-feedback')).toBe(false);

    // End to end through the reducer: Y on Journal paints its catalog description.
    const onJournal = mainMenuStep(
      mainMenuStep(openMainMenu(EMPTY_NAV_MEMORY), { button: 'Down', repeat: false }).state,
      { button: 'Down', repeat: false },
    ).state;
    const asked = mainMenuStep(onJournal, { button: 'Y', repeat: false }).state;
    view.render(menuViewModel(asked));
    expect(feedbackEl().textContent).toBe('Review your quests and their progress.');
    view.render(menuViewModel(mainMenuStep(asked, { button: 'Down', repeat: false }).state));
    expect(feedbackEl().textContent, 'a move clears it').toBe('');
  });
});

// ===========================================================================
// input: one delegated click, no keys, no hover
// ===========================================================================

describe('MenuView — input', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('MV-INPUT-PICK: a click on an entry emits {kind:"pick", key} for THAT entry once, also from a node inside it, survives re-renders without extra emissions, and a click on the list itself or a hover emits nothing', () => {
    // WRONG IMPL KILLED: a click that emits the cursor entry instead of the clicked one, an
    // emission carrying an index or the DOM id instead of the nav key, per-row listeners attached
    // in render() (N emissions per click after N renders), a handler that reads only the event
    // target (a click on an inner node is lost), a hover that picks (a mouse sweep would open
    // every screen it crosses), and a bogus pick for a click on the padding.
    const { view, onInput } = newView();
    view.render(rootVm());
    view.render(socialVm());
    view.render(rootVm());

    (document.getElementById('menu-root-journal') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(onInput, 'exactly one emission after three renders').toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith({ kind: 'pick', key: 'journal' });

    onInput.mockClear();
    const option = document.getElementById('menu-root-close') as HTMLElement;
    const inner = document.createElement('span');
    option.appendChild(inner);
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onInput, 'a click inside an entry picks the entry').toHaveBeenCalledWith({
      kind: 'pick',
      key: 'close',
    });
    expect(onInput).toHaveBeenCalledTimes(1);

    onInput.mockClear();
    rowsEl().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (document.getElementById('menu-root-bag') as HTMLElement).dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    );
    expect(onInput, 'padding clicks and hovers emit nothing').not.toHaveBeenCalled();

    view.render(socialVm());
    (document.getElementById('menuSocial-root-rankings') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(onInput).toHaveBeenCalledWith({ kind: 'pick', key: 'rankings' });
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('MV-NO-KEYDOWN: the view owns no keys — a keydown on the list emits nothing, is not prevented, and still reaches window', () => {
    // WRONG IMPL KILLED: a second key path in the view (the router is the only driver; a view
    // listener would double-step every press), and one that swallows Escape, Enter or Backspace
    // before main.ts's ladder sees them.
    const { view, onInput } = newView();
    view.show();
    view.render(rootVm());
    const winSpy = vi.fn();
    window.addEventListener('keydown', winSpy);
    try {
      for (const code of ['ArrowDown', 'ArrowUp', 'KeyS', 'Enter', 'Escape', 'Backspace']) {
        winSpy.mockClear();
        const e = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
        rowsEl().dispatchEvent(e);
        expect(e.defaultPrevented, `${code} is not prevented by the view`).toBe(false);
        expect(winSpy, `${code} reaches window`).toHaveBeenCalledTimes(1);
      }
      expect(onInput, 'no key becomes an input').not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', winSpy);
    }
  });

  it('MV-OPENS-WITH-NO-LAUNCHER: show() and render() paint with no launcher and no help hint in the document', () => {
    // WRONG IMPL KILLED: a shell that resolves or requires #menu-launcher / #chip-start (KeyM is
    // the zero-DOM front door). ctl-7a: the chip replaced #help-hint as the sentinel id.
    expect(document.getElementById('menu-launcher'), 'fixture has no launcher').toBeNull();
    expect(document.getElementById('chip-start'), 'fixture has no Start chip').toBeNull();
    const { view } = newView();
    view.show();
    view.render(rootVm());
    expect(view.visible).toBe(true);
    expect(optionEls().map((o) => o.textContent)).toEqual(ROOT_LABELS);
  });
});

// ===========================================================================
// overlayA11y wiring on the show/hide edge (unchanged contract)
// ===========================================================================

const META = OVERLAY_A11Y.menuView;
const MENU_ID: OverlayId = 'menuView';

describe('MenuView — overlay a11y wiring on the show/hide edge', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  function outsideSentinel(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id = OUTSIDE_SENTINEL_ID;
    btn.textContent = 'outside';
    document.body.appendChild(btn);
    return btn;
  }

  it('MV-A11Y-OPEN-ARIA-01: the first show() from a display:none shell labels the root from OVERLAY_A11Y / t() and delegates to openOverlayA11y', () => {
    // WRONG IMPL KILLED: a bare `display = ""` show(), a copy-pasted wrong OverlayId, and an
    // attribute-only cheat with no trap, return target or timer (the spy is the mechanism oracle).
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    expect(overlay.hasAttribute('aria-label'), 'no shell ships an aria-label').toBe(false);
    const { view } = newView();
    expect(overlay.hasAttribute('aria-label'), 'the constructor opens nothing').toBe(false);
    view.show();
    expect(overlay.getAttribute('role')).toBe(META.role);
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('aria-label')).toBe(t(META.labelKey));
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(MENU_ID, overlay);
  });

  it('MV-A11Y-OPEN-FOCUS-01: focus is NOT moved synchronously by show() and IS on the registry anchor one macrotask later', async () => {
    // WRONG IMPL KILLED: a synchronous focus (the KeyM that opened the menu lands in it), focus on
    // the frame or the first row instead of the anchor (#menu-rows, now inside the frame body).
    const target = document.querySelector<HTMLElement>(META.initialFocusSelector);
    expect(target, 'the registry anchor is in the document').not.toBeNull();
    const { view } = newView();
    view.show();
    expect(document.activeElement).not.toBe(target);
    await flushMacrotask();
    expect(document.activeElement).toBe(target);
    expect(target, 'the anchor is the nav container').toBe(rowsEl());
  });

  it('MV-A11Y-CLOSE-FOCUS-01: hide() strips the ARIA modal claim and hands focus back to the pre-overlay element', async () => {
    // WRONG IMPL KILLED: a bare `display = "none"` hide() (the overlay keeps announcing itself as
    // a dialog while invisible and focus is stranded).
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    const outside = outsideSentinel();
    outside.focus();
    const { view } = newView();
    view.show();
    await flushMacrotask();
    expect(document.activeElement).toBe(rowsEl());
    view.hide();
    expect(document.activeElement).toBe(outside);
    expect(overlay.hasAttribute('aria-modal')).toBe(false);
    expect(overlay.hasAttribute('role')).toBe(false);
    expect(overlay.hasAttribute('aria-label')).toBe(false);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(MENU_ID, null);
  });

  it('MV-A11Y-CLOSE-UNGUARDED-01: hide() calls the close unconditionally — on a never-shown view, on a repeat hide, and after a real open/close cycle', () => {
    // WRONG IMPL KILLED: an edge-guarded hide() (a desynced record would never heal) and a
    // close-once latch.
    const { view } = newView();
    expect(vi.isMockFunction(closeOverlayA11y), 'the overlayA11y spy is installed').toBe(true);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(0);
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
    view.show();
    view.hide();
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenLastCalledWith(MENU_ID, null);
  });

  it('MV-A11Y-VISIBLE-READS-DOM-01: `visible` reads the live DOM, not a private boolean', () => {
    // WRONG IMPL KILLED: a flag-backed getter (main.ts reads `menuView?.visible` in its guards,
    // and a force-hide can write style.display directly).
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    const { view } = newView();
    view.show();
    expect(view.visible).toBe(true);
    overlay.style.display = 'none';
    expect(view.visible).toBe(false);
    overlay.style.display = '';
    expect(view.visible).toBe(true);
  });

  it('MV-A11Y-REOPEN-EDGE-01: show() on an already-visible overlay does not re-open, and neither does render() or setCovered() — no re-opened record, no yanked focus', async () => {
    // WRONG IMPL KILLED: an unguarded show(), an open parked inside render() (it runs on every
    // cursor move), and a setCovered() that opens or closes the record.
    const outside = outsideSentinel();
    const { view } = newView();
    view.show();
    await flushMacrotask();
    expect(document.activeElement).toBe(rowsEl());
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    outside.focus();

    view.show();
    await flushMacrotask();
    expect(document.activeElement, 'a repeat show() does not re-run the deferred focus').toBe(
      outside,
    );
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);

    view.render(rootVm());
    view.render(socialVm());
    view.setCovered(true);
    view.setCovered(false);
    await flushMacrotask();
    expect(vi.mocked(openOverlayA11y), 'render and setCovered never open').toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y), 'nor close').not.toHaveBeenCalled();
    // CHANGED (ctl-5 review): uncovering used to leave focus alone. In a real browser the pop's own
    // focus move runs while the menu is still `visibility:hidden` and is refused, so focus sits on
    // <body> or in the closed child; uncovering therefore returns it to the nav container (the
    // focus is outside the overlay here, so it moves to #menu-rows). It is still a plain focus
    // call: no open/close record, and a repeat show() above did not re-run the deferred focus.
    expect(document.activeElement, 'uncovering returns focus to the list').toBe(rowsEl());
  });

  it('MV-A11Y-UNCOVER-FOCUS-01: uncovering moves focus to #menu-rows when focus is on <body> or on an element outside the overlay', async () => {
    // WRONG IMPL KILLED: a setCovered(false) that only clears the visibility (focus stranded on
    // <body> / the closed child after a child screen pops), and one that focuses on every call.
    const outside = outsideSentinel();
    const { view } = newView();
    view.show();
    await flushMacrotask();

    outside.focus();
    expect(document.activeElement).toBe(outside);
    view.setCovered(true);
    view.setCovered(false);
    expect(document.activeElement, 'from an element outside the overlay').toBe(rowsEl());

    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement, 'focus is parked on <body>').toBe(document.body);
    view.setCovered(true);
    view.setCovered(false);
    expect(document.activeElement, 'from <body>').toBe(rowsEl());
  });

  it('MV-A11Y-UNCOVER-INSIDE-01: uncovering leaves focus where it is when it is already inside the overlay', async () => {
    // WRONG IMPL KILLED: an unconditional `rows.focus()` on uncover (it would yank focus off a
    // control the user is already on inside the menu).
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    const inner = document.createElement('button');
    inner.textContent = 'inside';
    overlay.appendChild(inner);
    const { view } = newView();
    view.show();
    await flushMacrotask();
    inner.focus();
    expect(document.activeElement).toBe(inner);
    view.setCovered(true);
    view.setCovered(false);
    expect(document.activeElement).toBe(inner);
  });

  it('MV-A11Y-UNCOVER-NOT-COVERED-01: setCovered(false) when the menu was not covered never moves focus', async () => {
    // WRONG IMPL KILLED: a setCovered(false) that focuses the list on every call rather than only
    // on the covered -> uncovered edge (it would run on every uncovered syncStack).
    const outside = outsideSentinel();
    const { view } = newView();
    view.show();
    await flushMacrotask();
    outside.focus();
    view.setCovered(false);
    expect(document.activeElement, 'never covered').toBe(outside);
    view.setCovered(false);
    expect(document.activeElement, 'still never covered').toBe(outside);
    // Covering itself does not move focus either.
    view.setCovered(true);
    expect(document.activeElement, 'covering moves nothing').toBe(outside);
  });

  it('CTL11A-MENU-UNCOVER-HIDDEN: setCovered(false) on a menu that was covered and then hidden moves no focus into it (its list is never focused) and still clears the covered state, so the next show() paints an ordinary uncovered menu; uncovering a SHOWN menu still puts focus on the list', async () => {
    // WRONG IMPL KILLED: today's `setCovered`, which has no visibility guard: it focuses `#menu-rows`
    // when a covered menu is uncovered while hidden (focus would land inside a `display: none`
    // subtree: a browser refuses it, and focus sits on <body> or in the frame just closed, so every
    // key is dead until the player clicks the page); a guard that returns BEFORE the visibility
    // write (the menu stays `visibility: hidden`, so the next show() opens an invisible menu); a
    // guard that is "never focus on uncover" (the shown case below: focus stranded on <body> after
    // a child screen pops, MV-A11Y-UNCOVER-FOCUS-01); and a guard keyed to the covered flag rather
    // than the display (the shown, covered menu would not be focused either). The `focus` spy is the
    // mechanism oracle, so the cases hold in an engine that does focus a hidden node and in one that
    // refuses.
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    const outside = outsideSentinel();
    const { view } = newView();
    view.show();
    await flushMacrotask();
    const focusSpy = vi.spyOn(rowsEl(), 'focus');

    // Control: a SHOWN menu uncovered puts focus on the list (and the spy sees the call).
    outside.focus();
    view.setCovered(true);
    expect(overlay.style.visibility, 'control: covered').toBe('hidden');
    view.setCovered(false);
    expect(focusSpy, 'control: the shown menu focuses its list once').toHaveBeenCalledTimes(1);
    expect(document.activeElement, 'control: focus is on the list').toBe(rowsEl());

    // The case: covered, then hidden, then uncovered while hidden.
    focusSpy.mockClear();
    outside.focus();
    view.setCovered(true);
    view.hide();
    expect(view.visible, 'precondition: the menu is hidden').toBe(false);
    expect(overlay.style.visibility, 'precondition: it is still marked covered').toBe('hidden');
    const parked = document.activeElement;
    expect(overlay.contains(parked), 'precondition: focus is outside the hidden menu').toBe(false);

    view.setCovered(false);
    expect(focusSpy, 'a hidden menu`s list is never focused').not.toHaveBeenCalled();
    expect(document.activeElement, 'focus stays where it was').toBe(parked);
    expect(overlay.contains(document.activeElement), 'and is not inside the menu').toBe(false);
    expect(overlay.style.visibility, 'the covered state is cleared').toBe('');
    expect(view.visible, 'uncovering does not show it').toBe(false);

    // The next show() is an ordinary open: visible, uncovered, focus on its list a macrotask later.
    view.show();
    expect(view.visible).toBe(true);
    expect(overlay.style.visibility, 'the reopened menu is not left covered').toBe('');
    await flushMacrotask();
    expect(document.activeElement, 'the ordinary open focus lands on the list').toBe(rowsEl());

    // And it is no longer covered: uncovering it again is the "never covered" no-op.
    focusSpy.mockClear();
    outside.focus();
    view.setCovered(false);
    expect(focusSpy, 'an uncovered menu is not refocused').not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
  });
});
