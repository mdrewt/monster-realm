// @vitest-environment happy-dom
// ui/raisingView.test.ts — the raising/inventory screen's DOM shell.
//
// qf-9 (QF9.2): THE raising screen SHALL NOT render the Monsters/care section — its root is
// inventory-only (the Bag tabs bait/food/medicine/other + the legacy inventory grid). The monster
// cards (name, Trust/HP status line, ATK/DEF/SPD/SP.ATK/SP.DEF stats line), their Care and Train
// buttons, the per-monster in-flight locks, the `#raising-feedback` line and `showFeedback()` are
// DELETED (care lives on the Monsters sheet since ctl-8c / qf-2; the full stats moved to the
// Monsters Summary, QF9.1). The constructor takes the parent alone (`new RaisingView(parent)`);
// `refresh(vm)` renders only the inventory grid and ignores `vm.monsters`.
//
// NAMED INTENTIONAL CHANGES to the pre-existing cases of this file (each deleted suite tested
// behaviour that no longer exists; the intent that survives is re-pinned by the QF9-2 cases below):
//   DELETED  '★ RaisingView status line (EG4-4): Trust tier replaces the Bond readout' (2 its)
//   DELETED  'RaisingView showFeedback(): writes the message (C1, ADR-0159 D1)'
//   DELETED  '★ RaisingView showFeedback(): CONTAINMENT ... (C2)'
//   DELETED  '★ RaisingView showFeedback(): NO markup injection ... (C3)'
//   DELETED  '★ RaisingView Care button: re-entrancy guard (C4)'
//   DELETED  'RaisingView Care button: calls onCare with the correct monsterId (C5, regression)'
//   DELETED  '★★ RaisingView Care button: #pending must be tracked PER MONSTER (C6)' (2 its)
//   DELETED  '★ RaisingView 20r-a: in-flight guard on the Train buttons' (RV-1, RV-1b, RV-1c, RV-2,
//            RV-3a, RV-3b, RV-4, RV-5)
//   DELETED  '★ RaisingView rb-120: the Care lock carries the Train generation-token shape' (5 its)
//   DELETED  'rb-121 RaisingView: a settle-released Care/Train lock re-anchors focus' (11 its)
//   DELETED  'RaisingView ctl-7b: the in-flight locks survive a skipped refresh and a hide / show'
//            (CTL7B-RV-LOCK-HIDE-CARE, -HIDE-TRAIN, -LIVE-CARE, -LIVE-TRAIN)
//   DELETED  CTL7B-RV-KEY-BIGINT (it keyed monster ids; no monster id is rendered or forwarded now)
//   ADAPTED  CTL7B-1-RAISING-FRAME (non-vacuity threshold), CTL7B-1-NO-OPACITY-DIM-RAISING (only
//            the inventory empty line remains), the CTL7B-RV-* refresh-skip cases (inventory only),
//            m24s4 RV-01 / RV-02 (the retired raising.* ids leave the roster), CTL8F-1-VIEW-PAINT
//            (the button census is zero), the S4 a11y suite (one-arg constructor).
//   KEPT     every ctl-8f Bag case; the S4 a11y wiring suite.
//
// Pattern follows the sibling idiom (renameView.test.ts / shopView.test.ts): happy-dom environment,
// DOM fixture built in beforeEach, assertions on textContent / containment / node identity.
// RaisingView builds its ENTIRE DOM tree in its own constructor, so the fixture is just an empty
// mount-point `<div>` passed as `parent`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaisingViewModel } from './raisingModel';
import { RaisingView } from './raisingView';

// ---------------------------------------------------------------------------
// Overlay a11y wiring for RaisingView (constructed-shell, #app-mounted).
// Declared FIRST in the file, before any pre-existing describe AND
// before the file's own root-level `beforeEach`/`afterEach` (document.body reset /
// vi.restoreAllMocks()) — so this sweep runs first among the root-level hooks.
//
// COMPOSITION NOTE (plan §8 A7): DEFER-FOCUS and CLOSE-RESTORE are folded into
// S4-raisingView-ANCHOR-FOCUS and S4-raisingView-CLOSE-RESTORE-UNGUARDED — see
// battleView.test.ts's file header for the full rationale.
// ---------------------------------------------------------------------------

import { t } from './a11yCopy';
import { currentLocale, t as i18nT, tf as i18nTf, setLocale } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

vi.mock('./overlayA11y', { spy: true });
// m24s4 MECHANISM oracle, same shape as m24s3: records every t()/tf() call AND
// calls through to the real resolver, so RV-01's DOM byte-identity assertions still work.
vi.mock('./i18n/resolver', { spy: true });

/** ONE real macrotask boundary — never vi.useFakeTimers() (plan anti-pattern #10). */
async function s4FlushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s4FlushMacrotask();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s4FlushMacrotask();
});

const S4_ID: OverlayId = 'raisingView';
const S4_META = OVERLAY_A11Y[S4_ID];

/** A focusable OUTSIDE the overlay: the "pre-open" element a close must restore focus to. */
function s4OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's4-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root. */
function s4InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's4-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

/** See battleView.test.ts's file header for the full OPEN-LAST mechanism rationale
 *  (plan §8 A3): a post-hoc read of mock.calls[...][1].style.display is PROVABLY
 *  VACUOUS. This spies on the FIRST attribute write (`role`) and delegates to the
 *  real setAttribute. NEVER vi.importActual('./overlayA11y'). */
function s4CaptureDisplayAtOpen(root: HTMLElement): { display: () => string | undefined } {
  let captured: string | undefined;
  const real = root.setAttribute.bind(root);
  vi.spyOn(root, 'setAttribute').mockImplementation((name: string, value: string) => {
    if (name === 'role' && captured === undefined) captured = root.style.display;
    real(name, value);
  });
  return { display: () => captured };
}

// qf-9 (QF9.2, named intentional change): the constructor takes the parent alone.
function s4Mount(): { parent: HTMLElement; view: RaisingView } {
  const parent = mountParent();
  const view = new RaisingView(parent);
  return { parent, view };
}

describe('RaisingView — m23-s4 overlay a11y wiring on the show()/hide()/toggle() edge', () => {
  it('S4-raisingView-OPEN-ARIA BITES: the first show() from a hidden shell labels the root from OVERLAY_A11Y/t()', () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    expect(view.visible, 'the shell must start hidden, so show() IS an edge').toBe(false);

    view.show();

    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S4_META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBe(t(S4_META.labelKey));
  });

  it('S4-raisingView-ANCHOR-FOCUS BITES: the anchor resolves to an <h2 tabindex="-1"> reading "Inventory" (qf-10), and focus moves to it after ONE real macrotask (never synchronously)', async () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();

    const anchor = root.querySelector<HTMLElement>(S4_META.initialFocusSelector);
    expect(
      anchor,
      `the anchor selector ${S4_META.initialFocusSelector} must resolve`,
    ).not.toBeNull();
    expect(anchor!.tagName).toBe('H2');
    expect(anchor!.getAttribute('tabindex')).toBe('-1');
    // NAMED INTENTIONAL CHANGE (qf-10, QF10.4): the title reads "Inventory" (was "Raising &
    // Inventory"); the anchor is the `raising-title` testid heading, not the inventory section's.
    expect(anchor!.textContent, 'the overlay title text (raising.title)').toBe('Inventory');
    expect(anchor!.getAttribute('data-testid'), 'it is the overlay title, not a section').toBe(
      'raising-title',
    );

    expect(document.activeElement, 'not focused synchronously').not.toBe(anchor);
    await s4FlushMacrotask();
    expect(document.activeElement, 'focused by IDENTITY after one real macrotask').toBe(anchor);
  });

  it('the raising title reads "Inventory" in en (never the legacy "Raising & Inventory") and "Inventaire" in fr after a re-show [QF10-4-RAISING-TITLE-RENDERS]', () => {
    const { parent, view } = s4Mount();
    const titleOf = (): string | null =>
      parent.querySelector<HTMLElement>('[data-testid="raising-title"]')?.textContent ?? null;
    try {
      setLocale('en');
      view.show();
      expect(titleOf()).toBe('Inventory');
      expect(titleOf()).not.toBe('Raising & Inventory');

      setLocale('fr');
      view.hide();
      view.show();
      expect(titleOf()).toBe('Inventaire');
    } finally {
      setLocale('en');
    }
  });

  it('S4-raisingView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S4_ID, root);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);
  });

  it('S4-raisingView-CLOSE-RESTORE-UNGUARDED BITES: hide() strips all three attributes and restores focus to the pre-open element; hide() on a never-shown view still closes without throwing; show/hide/hide yields exactly two closes', async () => {
    const outside = s4OutsideSentinel();
    outside.focus();
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);

    view.show();
    await s4FlushMacrotask();
    expect(document.activeElement, 'precondition: the open moved focus into the overlay').not.toBe(
      outside,
    );

    view.hide();
    expect(
      root.getAttribute('role'),
      'a display:none root must not keep claiming to be a dialog',
    ).toBeNull();
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('aria-label')).toBeNull();
    expect(document.activeElement, 'focus must return to the pre-open element').toBe(outside);

    const fresh = s4Mount();
    expect(fresh.view.visible).toBe(false);
    expect(() => fresh.view.hide()).not.toThrow();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);

    vi.clearAllMocks();
    const cycle = s4Mount();
    cycle.view.show();
    cycle.view.hide();
    cycle.view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('S4-raisingView-REPEAT-NO-REOPEN BITES: show() on an already-visible overlay neither re-opens nor yanks focus off a sentinel parked inside the root', async () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    await s4FlushMacrotask();

    const inside = s4InsideSentinel(root);
    inside.focus();
    expect(document.activeElement).toBe(inside);

    view.show();
    await s4FlushMacrotask();

    expect(document.activeElement, 'a repeat open must NOT re-run the deferred focus').toBe(inside);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S4-raisingView-OPEN-LAST BITES: openOverlayA11y is invoked with root.style.display ALREADY painted (neither "none" nor "") — never open-before-paint', () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    const capture = s4CaptureDisplayAtOpen(root);

    view.show();

    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(capture.display()).not.toBe('none');
    expect(capture.display()).not.toBe('');
  });

  it('S4-raisingView-TOGGLE BITES: toggle() from hidden opens exactly once; toggle() again closes exactly once', () => {
    const { view } = s4Mount();
    expect(view.visible).toBe(false);

    view.toggle();
    expect(view.visible).toBe(true);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);

    view.toggle();
    expect(view.visible).toBe(false);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// DOM fixture — RaisingView builds its own tree; the fixture is just a mount point.
// happy-dom shares ONE document across the whole file; wipe the body each time so a
// failed test's leftover overlay never bleeds into the next test's lookups.
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mountParent(): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return parent;
}

// One monster, zero items. qf-9: the screen ignores `monsters`, but the view-model type still
// carries them (raisingModel is unchanged), so every fixture supplies them: a render that DID read
// them would show a nickname or a stat below, and the QF9-2 cases fail on that.
function oneMonsterVm(monsterId: bigint): RaisingViewModel {
  return {
    monsters: [
      {
        monsterId,
        nickname: 'Aria',
        level: 5,
        // EG4-4 (contract §E): RaisingMonsterViewModel.bond -> trustTier.
        trustTier: 'Neutral',
        currentHp: 20,
        statHp: 20,
        statAttack: 5,
        statDefense: 5,
        statSpeed: 5,
        statSpAttack: 5,
        statSpDefense: 5,
      },
    ],
    items: [],
  };
}

// Two monsters, zero items.
function twoMonsterVm(idA: bigint, idB: bigint): RaisingViewModel {
  const base = {
    level: 5,
    // EG4-4 (contract §E): RaisingMonsterViewModel.bond -> trustTier.
    trustTier: 'Neutral' as const,
    currentHp: 20,
    statHp: 20,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
  };
  return {
    monsters: [
      { monsterId: idA, nickname: 'Aria', ...base },
      { monsterId: idB, nickname: 'Bram', ...base },
    ],
    items: [],
  };
}

// The overlay root is the SOLE child RaisingView appends into `parent` at construction time.
function overlayRootOf(parent: HTMLElement): HTMLElement {
  const root = parent.firstElementChild;
  if (root === null) {
    throw new Error('RaisingView did not append an overlay root into parent');
  }
  return root as HTMLElement;
}

/** Two monsters (1n Aria, 2n Bram), TWO trainable items and one junk item: a full inventory to
 *  render next to monsters that must NOT render. */
function raTrainVm(): RaisingViewModel {
  return {
    ...twoMonsterVm(1n, 2n),
    items: [
      {
        invId: 100n,
        itemId: 10,
        name: 'Protein',
        description: 'Raises attack.',
        count: 2,
        trainStat: 'attack',
        canTrain: true,
      },
      {
        invId: 101n,
        itemId: 11,
        name: 'Iron',
        description: 'Raises defense.',
        count: 1,
        trainStat: 'defense',
        canTrain: true,
      },
      {
        invId: 102n,
        itemId: 12,
        name: 'Pebble',
        description: 'Not trainable.',
        count: 3,
        trainStat: null,
        canTrain: false,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// qf-9 (QF9.2): the raising root is inventory-only. The monster cards, their Care / Train buttons,
// the `#raising-feedback` line and `showFeedback()` are gone; `vm.monsters` is ignored; the Bag
// parts and the legacy inventory grid are untouched.
//
// The "retired strings" are the English the deleted section painted. Each is checked against the
// whole root's textContent (hidden descendants included: the e2e text scans read those too), after
// a populated refresh carrying monsters AND items, so a section left rendering — or merely hidden
// — shows up by its text.
// ---------------------------------------------------------------------------

const QF9_RETIRED_ENGLISH = [
  'Care',
  'Train: ',
  'Trust ',
  'HP ',
  'ATK ',
  'DEF ',
  'SPD ',
  'SP.ATK ',
  'SP.DEF ',
  'No monsters.',
  'Monsters',
  'Aria', // a monster nickname: the cards were the only place a nickname rendered
  'Bram',
] as const;

const QF9_BAG_PART_IDS = [
  'bag-tabs',
  'bag-list',
  'bag-empty',
  'bag-sheet',
  'bag-info',
  'bag-picker-title',
  'bag-picker',
  'bag-status',
] as const;

describe('RaisingView qf-9: the raising root is inventory-only (QF9.2)', () => {
  it('QF9-2-VIEW-NO-MONSTER-SECTION: after show() and a refresh carrying monsters AND items the root holds no <button>, no #raising-feedback, no monster heading and none of the retired English (Care, Train:, Trust, HP, the five stat labels, the empty-monsters line, a nickname), and exactly one section heading: the Inventory one', () => {
    // WRONG IMPL KILLED: the shipped screen (cards with Care / Train buttons, a status and a stats
    // line, a Monsters heading); a section hidden by display:none but still built (the root's text
    // still carries the nicknames and labels); the cards deleted but the `#raising-feedback` line
    // or the Monsters heading left behind; Care kept as a link / role=button div instead of a
    // <button> (the text scan still sees "Care"); a second h3 left in place.
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    view.refresh(raTrainVm());

    expect(
      root.querySelectorAll('button'),
      'no native button anywhere in the raising root',
    ).toHaveLength(0);
    expect(root.querySelectorAll('[role="button"]'), 'and no ARIA button either').toHaveLength(0);
    expect(document.getElementById('raising-feedback'), 'no #raising-feedback element').toBeNull();
    const text = root.textContent ?? '';
    for (const word of QF9_RETIRED_ENGLISH) {
      expect(text.includes(word), `the raising root must not contain "${word}"`).toBe(false);
    }
    // WRONG IMPL KILLED (red-team): a plain <div> listing only the monsters` names (no button, no
    // stats, no retired label): every seeded nickname, read off the very view-model, is absent.
    const seeded = raTrainVm().monsters.map((m) => m.nickname);
    expect(seeded.length, 'precondition: monsters are seeded').toBeGreaterThan(0);
    for (const nickname of seeded) {
      expect(text.includes(nickname), `no monster nickname "${nickname}" in the root`).toBe(false);
    }
    expect(
      [...root.querySelectorAll('h3')].map((h) => h.textContent),
      'the only section heading is the Inventory one',
    ).toEqual([i18nT('raising.inventory.heading')]);

    // The same holds with the Bag open (the status line is a div, not a control) and after a
    // reopen.
    view.paint(ctl8fPaint(ctl8fVm()));
    expect(root.querySelectorAll('button'), 'no button under a kept Bag paint').toHaveLength(0);
    view.hide();
    view.show();
    view.refresh(raTrainVm());
    expect(root.querySelectorAll('button'), 'no button after a reopen').toHaveLength(0);
    expect(document.getElementById('raising-feedback')).toBeNull();
  });

  it('QF9-2-VIEW-INVENTORY-REMAINS: the legacy grid still lists every item as "name (xN)" with its description, shown before any Bag paint, and all eight Bag parts still exist inside the root, hidden until a paint', () => {
    // WRONG IMPL KILLED: a rewrite that drops the inventory grid with the cards (the screen would
    // be empty); a grid that lost the description line; an inventory heading that left; Bag parts
    // removed or created lazily (the ctl-8f paint would throw on a missing node); a legacy grid
    // that starts hidden.
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    view.refresh(raTrainVm());

    const grid = document.getElementById('raising-inventory');
    expect(grid, 'the legacy inventory grid exists').not.toBeNull();
    expect(root.contains(grid), 'inside the root').toBe(true);
    expect((grid as HTMLElement).style.display, 'and is shown before any Bag paint').not.toBe(
      'none',
    );
    const gridText = (grid as HTMLElement).textContent ?? '';
    for (const [name, count, description] of [
      ['Protein', 2, 'Raises attack.'],
      ['Iron', 1, 'Raises defense.'],
      ['Pebble', 3, 'Not trainable.'],
    ] as const) {
      expect(gridText, `${name} line`).toContain(i18nTf('raising.inventory.item', { name, count }));
      expect(gridText, `${name} description`).toContain(description);
    }
    expect(gridText).toContain('Protein (x2)');
    expect(
      [...(grid as HTMLElement).children].map((c) => c.children.length),
      'one card per item: a name line and a description line each',
    ).toEqual([2, 2, 2]);
    expect(
      [...root.querySelectorAll('h3')].map((h) => h.textContent),
      'the Inventory heading is resolved by show()',
    ).toEqual([i18nT('raising.inventory.heading')]);

    for (const id of QF9_BAG_PART_IDS) {
      const part = document.getElementById(id);
      expect(part, `#${id} exists`).not.toBeNull();
      expect(root.contains(part), `#${id} is inside the raising root`).toBe(true);
      if (id !== 'bag-status') {
        expect((part as HTMLElement).style.display, `#${id} is hidden before a paint`).toBe('none');
      }
    }
    expect(parent.contains(root)).toBe(true);
  });

  it('QF9-2-VIEW-MONSTERS-IGNORED: a refresh renders the same root whether the view-model carries two monsters or none, and a refresh that changes only the monsters writes nothing to the DOM', () => {
    // WRONG IMPL KILLED: a view that still reads `vm.monsters` anywhere (a count, a heading shown
    // only when there are monsters, an "empty" line); a render key that includes the monsters (it
    // rebuilds the inventory grid on every monster change, i.e. on every store batch that heals or
    // trains a monster, detaching nodes under a focused player).
    // (Neither view is shown: the comparison is of the rendered lists, and only one overlay record
    // per id may be open at a time.)
    const withMonsters = s4Mount();
    withMonsters.view.refresh(raTrainVm());
    const without = s4Mount();
    without.view.refresh({ monsters: [], items: raTrainVm().items });
    expect(
      overlayRootOf(withMonsters.parent).innerHTML,
      'the root is identical with and without monsters',
    ).toBe(overlayRootOf(without.parent).innerHTML);

    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    view.refresh(raTrainVm());
    const cardsBefore = [...(document.getElementById('raising-inventory') as HTMLElement).children];
    expect(cardsBefore, 'precondition: three inventory cards').toHaveLength(3);

    const observer = new MutationObserver(() => {});
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    const changedMonsters = raTrainVm();
    view.refresh({
      ...changedMonsters,
      monsters: [
        { ...(changedMonsters.monsters[0] as RaisingViewModel['monsters'][number]), level: 9 },
      ],
    });
    view.refresh({ monsters: [], items: raTrainVm().items });
    const written = observer.takeRecords();
    observer.disconnect();
    expect(
      written.map((r) => `${r.type} on <${(r.target as Element).tagName.toLowerCase()}>`),
      'a monsters-only change must not touch the DOM',
    ).toEqual([]);
    const cardsAfter = [...(document.getElementById('raising-inventory') as HTMLElement).children];
    cardsAfter.forEach((el, i) => {
      expect(el, `inventory card ${i} is the same node`).toBe(cardsBefore[i]);
    });
  });

  it('QF9-2-VIEW-NO-FEEDBACK-SINK: RaisingView has no showFeedback (own or inherited), no #raising-feedback exists before or after show(), and the Bag status line is the only .mr-frame-feedback', () => {
    // WRONG IMPL KILLED: a showFeedback kept as a no-op (main.ts would still compile against it
    // and swallow a care answer silently, the defect qf-2 fixed); the feedback element kept but
    // unused; a second .mr-frame-feedback line added next to the Bag status.
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    expect('showFeedback' in view, 'showFeedback is not a member of the view').toBe(false);
    expect(
      (view as unknown as Record<string, unknown>).showFeedback,
      'and reads undefined',
    ).toBeUndefined();
    expect(document.getElementById('raising-feedback'), 'none at construction').toBeNull();
    view.show();
    view.refresh(raTrainVm());
    expect(
      document.getElementById('raising-feedback'),
      'none after show() and refresh()',
    ).toBeNull();
    expect(
      [...root.querySelectorAll('.mr-frame-feedback')].map((el) => el.id),
      'the Bag status line is the one feedback line',
    ).toEqual(['bag-status']);
  });

  it('QF9-2-VIEW-EMPTY: an empty view-model shows the inventory empty line and no monsters line', () => {
    // WRONG IMPL KILLED: an "empty monsters" line left behind (the shipped `No monsters.` for a
    // fresh player); an empty inventory that shows nothing.
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    view.refresh({ monsters: [], items: [] });
    const text = root.textContent ?? '';
    expect(text).toContain(i18nT('raising.inventory.empty'));
    expect(text).toContain('No items.');
    expect(text.includes('No monsters.'), 'no empty-monsters line').toBe(false);
    expect(root.querySelectorAll('button')).toHaveLength(0);
  });

  it('QF9-2-VIEW-ONE-ARG-CONSTRUCTOR: a view built with the parent alone shows, refreshes, paints and hides without a callbacks object ever being read', () => {
    // WRONG IMPL KILLED: a constructor that still dereferences `callbacks` (a TypeError on
    // `undefined.onCare` at the first render, or `this.#callbacks = callbacks` plus a read on any
    // path).
    const parent = mountParent();
    const view = new RaisingView(parent);
    expect(() => {
      view.show();
      view.refresh(raTrainVm());
      view.paint(ctl8fPaint(ctl8fVm()));
      view.hide();
      view.show();
      view.refresh(oneMonsterVm(1n));
    }).not.toThrow();
  });
});

// =============================================================================
// ctl-7b (CTL7B.1): the raising screen is a class-styled `.mr-frame` shell inside `#game-screen`
// instead of an inline `position:fixed;inset:0;z-index:100;background:rgba(...)` overlay.
//
// WHAT THESE CASES CAN AND CANNOT PROVE: happy-dom does no cascade, no layout and no paint, so the
// frame cases prove the INLINE half of the contract (which classes the root carries and which
// declarations it and its subtree still write); where the screen lands and how its text paints is
// proved in real Chromium by client/e2e/a11y.spec.ts (CTL7B-E2E-ROOTS / CTL7B-E2E-RAISING).
//
// The inline declarations are read from the style ATTRIBUTE and split by hand: happy-dom's
// CSSStyleDeclaration expands shorthands into longhands, so a name-set read through it would pin
// the happy-dom version, not the contract.
// =============================================================================

/** The inline declarations of `el` (lower-cased property name -> raw value), from its style attribute. */
function ctl7bInline(el: Element): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (prop !== '') out.set(prop, part.slice(colon + 1).trim());
  }
  return out;
}

/** Inline properties that place, layer, dim, hide or recolour an element outside the stylesheet. */
const CTL7B_BANNED_ON_DESCENDANTS: ReadonlySet<string> = new Set([
  'position',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'opacity',
  'filter',
  'transform',
  'visibility',
  'mix-blend-mode',
  '-webkit-text-fill-color',
]);

/** The element's OWN text nodes, concatenated. */
function ctl7bOwnText(el: Element): string {
  return [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent ?? '')
    .join('');
}

/** The one element under `root` whose own text is exactly `text`. */
function ctl7bByOwnText(root: HTMLElement, text: string): HTMLElement {
  const hits = [...root.querySelectorAll('*')].filter((el) => ctl7bOwnText(el) === text);
  expect(
    hits,
    `precondition: exactly one element under the root has the own text "${text}"`,
  ).toHaveLength(1);
  return hits[0] as HTMLElement;
}

/** `[r, g, b, a]` from a bare #rgb / #rrggbb / rgb() / rgba() literal; THROWS on anything else. */
function ctl7bRgba(raw: string): readonly [number, number, number, number] {
  const value = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex !== null) {
    const body = hex[1] as string;
    const wide = body.length === 6;
    const channel = (i: number): number =>
      Number.parseInt(wide ? body.slice(i * 2, i * 2 + 2) : (body[i] as string).repeat(2), 16);
    return [channel(0), channel(1), channel(2), 1];
  }
  const fn =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/.exec(value);
  if (fn !== null) {
    return [
      Number.parseInt(fn[1] as string, 10),
      Number.parseInt(fn[2] as string, 10),
      Number.parseInt(fn[3] as string, 10),
      fn[4] === undefined ? 1 : Number.parseFloat(fn[4]),
    ];
  }
  throw new Error(
    `CTL7B colour refused: ${JSON.stringify(raw)} is not a bare #rgb / #rrggbb / rgb() / rgba() ` +
      'literal. This reader never defaults an unreadable colour (a default would let the gate ' +
      'pass by deleting the declaration)',
  );
}

function ctl7bContrast(a: readonly number[], b: readonly number[]): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c: readonly number[]): number =>
    0.2126 * lin(c[0] as number) + 0.7152 * lin(c[1] as number) + 0.0722 * lin(c[2] as number);
  return (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
}

/** `.mr-frame`'s `--mr-frame-fg` default: what text paints in when no inline colour is set. */
const CTL7B_FRAME_FG = '#e0e0e0';
/** The two surfaces an empty-state line sits on: the frame (`--mr-frame-bg`) and a card. */
const CTL7B_SURFACES = ['#1e1e2e', '#1a1a2e'] as const;

/** The inline colour in force for `el`: its own or the nearest ancestor's below `root`, else the frame fg. */
function ctl7bEffectiveColour(el: HTMLElement, root: HTMLElement): string {
  for (let n: HTMLElement | null = el; n !== null && n !== root; n = n.parentElement) {
    const colour = ctl7bInline(n).get('color');
    if (colour !== undefined) return colour;
  }
  return CTL7B_FRAME_FG;
}

/** Every empty-state element must be opaque and readable on both surfaces. */
function ctl7bExpectReadableEmpties(emptyEls: readonly Element[], root: HTMLElement): void {
  for (const el of emptyEls) {
    const raw = ctl7bEffectiveColour(el as HTMLElement, root);
    const rgba = ctl7bRgba(raw);
    const label = JSON.stringify(ctl7bOwnText(el));
    expect(
      rgba[3],
      `CTL7B ${label}: the empty-state colour ${raw} must be fully opaque (alpha 1) — a ` +
        'translucent colour is opacity by another name',
    ).toBe(1);
    for (const surface of CTL7B_SURFACES) {
      const ratio = ctl7bContrast(rgba, ctl7bRgba(surface));
      expect(
        ratio,
        `CTL7B ${label}: ${raw} on ${surface} measures ${ratio.toFixed(2)}:1, under the 4.5:1 AA ` +
          'minimum for small text',
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
}

describe('RaisingView ctl-7b: the raising root is a class-styled frame, inline only for visibility', () => {
  it('CTL7B-1-RAISING-FRAME BITES: the raising root is the one child of its parent, carries exactly .mr-frame and .mr-shell, writes only display and align-items inline in every state, and toggles display flex/none', async () => {
    // WRONG IMPLS KILLED:
    //  (1) the shipped root: `position:fixed;inset:0;z-index:100;background:rgba(...)` ... in its
    //      cssText (every state reds on the allow-list);
    //  (2) a root with the classes AND the old inline overlay still on it (the inline declaration
    //      beats the class rule at every specificity, so the shell would never apply);
    //  (3) `.mr-shell--top` borrowed for the raising screen (z 120 would sit above the battle);
    //  (4) the frame class on a WRAPPER around the root (identity is pinned through the title);
    //  (5) a fixed-position / dim / hide declaration smuggled onto a DESCENDANT after the root is
    //      clean (the subtree walk is run in every state, empty ones included);
    //  (6) a show() that no longer writes display:flex, or a hide() that no longer writes none.
    // qf-9 (named intentional change): the non-vacuity floor drops from 25 to 15 elements: the
    // monster cards and their buttons are gone, three inventory cards (three elements each) and the
    // fixed parts still make twenty.
    const { parent, view } = s4Mount();
    expect(parent.children, 'the view appends exactly ONE root into its parent').toHaveLength(1);
    const root = overlayRootOf(parent);
    const title = parent.querySelector('[data-testid="raising-title"]');
    expect(title, 'precondition: the title anchor exists').not.toBeNull();
    expect(title?.parentElement, "the classed node is the title's parent").toBe(root);
    expect(
      root.className
        .split(/\s+/)
        .filter((c) => c !== '')
        .sort(),
      'the root carries exactly the frame and the shell class — and not .mr-shell--top, which ' +
        'is the menu / help layer',
    ).toEqual(['mr-frame', 'mr-shell']);

    const allowed = ['display', 'align-items'];
    const sample = (when: string): number => {
      expect(
        [...ctl7bInline(root).keys()].filter((name) => !allowed.includes(name)),
        `CTL7B ${when}: the root may write only ${JSON.stringify(allowed)} inline. The shell ` +
          'class places it inside the screen and the frame class paints it, so any other inline ' +
          'property is the old overlay still being drawn by hand',
      ).toEqual([]);
      const all = [...root.querySelectorAll('*')];
      const offenders: string[] = [];
      for (const el of all) {
        for (const prop of ctl7bInline(el).keys()) {
          if (CTL7B_BANNED_ON_DESCENDANTS.has(prop)) {
            offenders.push(`<${el.tagName.toLowerCase()}> ${prop}`);
          }
        }
      }
      expect(
        offenders,
        `CTL7B ${when}: no element under the root may place, layer, dim, hide or recolour itself inline`,
      ).toEqual([]);
      return all.length;
    };

    sample('constructed');
    expect(root.style.display, 'hidden at construction').toBe('none');

    view.show();
    sample('shown');
    expect(root.style.display, 'show() writes display:flex').toBe('flex');
    expect(ctl7bInline(root).get('display')).toBe('flex');

    view.refresh(raTrainVm());
    expect(
      sample('populated refresh'),
      'non-vacuity: three inventory cards and the fixed parts render well over 15 elements',
    ).toBeGreaterThan(15);
    expect(root.style.display, 'a refresh does not touch visibility').toBe('flex');
    // A deferred write (a setTimeout that re-adds an inline position after show()) lands here.
    await s4FlushMacrotask();
    sample('populated refresh, one macrotask later');
    expect(root.style.display).toBe('flex');

    view.refresh({ monsters: [], items: [] });
    sample('empty refresh');

    view.hide();
    sample('hidden');
    expect(root.style.display, 'hide() writes display:none').toBe('none');
    expect(ctl7bInline(root).get('display')).toBe('none');
  });

  it('CTL7B-1-NO-OPACITY-DIM-RAISING BITES: the empty inventory line carries no inline opacity or filter and paints an opaque colour at 4.5:1 on both the frame and the card surface [QF9-2-VIEW-EMPTY-LINE-READABLE]', () => {
    // WRONG IMPLS KILLED: the shipped empties (`empty.style.opacity = '0.4'`): opacity composites
    // the text below 4.5:1 and is invisible to any check that reads only a colour; the same
    // dimming spelled as `filter`; a replacement colour that is translucent (alpha < 1) or too
    // dim (#666 on #1a1a2e is 2.9:1); an unreadable colour literal (named, hsl, 8-digit hex).
    // qf-9 (named intentional change): the empty-monsters line left with the cards; the inventory
    // line is the one empty state.
    const { parent, view } = s4Mount();
    view.refresh({ monsters: [], items: [] });
    view.show();
    const root = overlayRootOf(parent);

    const dimmers: string[] = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const prop of ['opacity', 'filter']) {
        if (ctl7bInline(el).has(prop)) dimmers.push(`<${el.tagName.toLowerCase()}> ${prop}`);
      }
    }
    expect(dimmers, 'no element in the empty raising screen may dim itself inline').toEqual([]);

    const empties = [ctl7bByOwnText(root, 'No items.')];
    ctl7bExpectReadableEmpties(empties, root);
  });
});

// -----------------------------------------------------------------------------
// R-ci-fix-20261002T0901Z-RAISINGVIEWREBUILD (inventory half, after qf-9): RaisingView.refresh
// rebuilt the inventory grid on every store batch. The fix is a value-keyed render, like
// pvpView.ts #renderIfChanged: a refresh with a view-model that serialises to the same key leaves
// the container's DOM untouched.
//
// The key is the JSON of [currentLocale(), items] for the inventory, with bigint written as its
// decimal string (never Number). It is deleted before a render and set after it (a render that
// throws leaves no key); a fresh view has no key (an empty first view-model still renders its empty
// text). qf-9: the monster list and its key are gone, and `monsters` is not part of the key.
// -----------------------------------------------------------------------------

type Ctl7bItem = RaisingViewModel['items'][number];

function ctl7bItem(
  vm: RaisingViewModel,
  index: number,
  patch: Partial<Ctl7bItem>,
): RaisingViewModel {
  return { ...vm, items: vm.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) };
}

function ctl7bSetup() {
  const parent = mountParent();
  const view = new RaisingView(parent);
  return { parent, view, root: overlayRootOf(parent) };
}

/** The inventory half of the oracle: every item's line and description is in the DOM. */
function ctl7bExpectInventory(root: HTMLElement, vm: RaisingViewModel, why: string): void {
  const text = root.textContent ?? '';
  for (const item of vm.items) {
    expect(
      text,
      `${why}: the inventory must show "${item.name}" with its count ${item.count}`,
    ).toContain(i18nTf('raising.inventory.item', { name: item.name, count: item.count }));
    expect(text, `${why}: the inventory must show the description of "${item.name}"`).toContain(
      item.description,
    );
  }
}

/** The inventory grid's card elements, in render order. */
const ctl7bCards = (root: HTMLElement): HTMLElement[] =>
  [...(root.querySelector('#raising-inventory') as HTMLElement).children] as HTMLElement[];

const CTL7B_FIELD_CASES: ReadonlyArray<
  readonly [string, (vm: RaisingViewModel) => RaisingViewModel]
> = [
  ['trainable item count', (vm) => ctl7bItem(vm, 0, { count: 3 })],
  ['trainable item name', (vm) => ctl7bItem(vm, 0, { name: 'Powder' })],
  ['item description', (vm) => ctl7bItem(vm, 0, { description: 'Raises it a lot.' })],
  ['second item count', (vm) => ctl7bItem(vm, 1, { count: 7 })],
  ['second item name', (vm) => ctl7bItem(vm, 1, { name: 'Steel' })],
  ['last item name', (vm) => ctl7bItem(vm, 2, { name: 'Boulder' })],
  ['item count to zero', (vm) => ctl7bItem(vm, 1, { count: 0 })],
  ['item order', (vm) => ({ ...vm, items: [...vm.items].reverse() })],
];

describe('RaisingView ctl-7b: a refresh re-renders only when the inventory changed', () => {
  it('CTL7B-RV-NO-REBUILD BITES: refresh() with a fresh, deep-equal view-model keeps every inventory node and writes nothing to the DOM [QF9-2-INVENTORY-NO-REBUILD]', async () => {
    // WRONG IMPLS KILLED: the shipped refresh(), which replaceChildren()s the inventory on EVERY
    // store batch (every node below changes identity, the observer sees the removals) — the e2e
    // flake R-ci-fix-20261002T0901Z-RAISINGVIEWREBUILD; a skip keyed on view-model IDENTITY (the
    // view-model below is a fresh object, deep-equal to the last); a skip that still rewrites some
    // text or a class.
    const { view, root } = ctl7bSetup();
    view.show();
    view.refresh(raTrainVm());
    await s4FlushMacrotask();
    const before = [...root.querySelectorAll('#raising-inventory *')];
    expect(before.length, 'precondition: three cards of three elements each').toBe(9);

    const observer = new MutationObserver(() => {});
    observer.observe(root, { childList: true, subtree: true });
    view.refresh(raTrainVm());
    view.refresh(raTrainVm());
    const written = observer.takeRecords();
    observer.disconnect();

    expect(
      written.map(
        (r) =>
          `${r.type} on <${(r.target as Element).tagName.toLowerCase()}> +${r.addedNodes.length} -${r.removedNodes.length}`,
      ),
      'a refresh with a deep-equal view-model must not add or remove a single node',
    ).toEqual([]);
    const after = [...root.querySelectorAll('#raising-inventory *')];
    expect(after, 'the same nine elements').toHaveLength(9);
    after.forEach((el, i) => {
      expect(el, `element ${i} is the SAME node as before the refresh`).toBe(before[i]);
    });

    // CONTROL: the observer does see a real change, so the zero above is not an inert observer.
    const control = new MutationObserver(() => {});
    control.observe(root, { childList: true, subtree: true });
    view.refresh(ctl7bItem(raTrainVm(), 0, { count: 5 }));
    const real = control.takeRecords();
    control.disconnect();
    expect(
      real.length,
      'control: a CHANGED view-model re-renders, and the observer records it',
    ).toBeGreaterThan(0);
  });

  it.each(
    CTL7B_FIELD_CASES,
  )('CTL7B-RV-KEY-FIELD %s: a one-field change re-renders, and the inventory shows the new value and not the old [QF9-2-INVENTORY-KEY]', (label, change) => {
    // WRONG IMPLS KILLED: a key that leaves one rendered field out (a stale name / count /
    // description after exactly that change), a key that reads only the item ids or only their
    // count, an items key that ignores order. Every case checks the DOM against the new
    // view-model, not just identity.
    const { view, root } = ctl7bSetup();
    const original = raTrainVm();
    view.refresh(original);
    expect(ctl7bCards(root), 'precondition: three cards rendered').toHaveLength(3);

    const changed = change(raTrainVm());
    view.refresh(changed);
    ctl7bExpectInventory(root, changed, label);
    const oldLines = original.items
      .map((i) => i18nTf('raising.inventory.item', { name: i.name, count: i.count }))
      .filter(
        (line) =>
          !changed.items.some(
            (i) => i18nTf('raising.inventory.item', { name: i.name, count: i.count }) === line,
          ),
      );
    const text = root.textContent ?? '';
    for (const gone of oldLines) {
      expect(text.includes(gone), `${label}: the old line "${gone}" is gone`).toBe(false);
    }
    for (const old of original.items) {
      if (!changed.items.some((i) => i.description === old.description)) {
        expect(
          text.includes(old.description),
          `${label}: the old description "${old.description}" is gone`,
        ).toBe(false);
      }
    }
    expect(
      ctl7bCards(root).map((c) => c.firstElementChild?.textContent),
      `${label}: the cards follow the new order`,
    ).toEqual(
      changed.items.map((i) => i18nTf('raising.inventory.item', { name: i.name, count: i.count })),
    );
  });

  it('CTL7B-RV-KEY-INVENTORY BITES: a change that only the inventory shows (a description, a non-trainable item) still reaches the screen', () => {
    // WRONG IMPLS KILLED: an inventory key that ignores the description or the non-trainable
    // items (a key narrowed to what the old cards read would freeze the inventory).
    const { view, root } = ctl7bSetup();
    view.refresh(raTrainVm());

    const described = ctl7bItem(raTrainVm(), 0, { description: 'Raises attack a great deal.' });
    view.refresh(described);
    ctl7bExpectInventory(root, described, 'description-only change');
    expect(root.textContent ?? '', 'the old description is gone').not.toContain('Raises attack.');

    const pebble = ctl7bItem(described, 2, { count: 9, name: 'Boulder' });
    view.refresh(pebble);
    ctl7bExpectInventory(root, pebble, 'non-trainable item change');
    expect(root.textContent ?? '', 'the old item line is gone').not.toContain('Pebble');
  });

  it('CTL7B-RV-KEY-LOCALE BITES: switching locale re-renders an equal view-model — empty and populated — so the inventory keeps no old language [QF9-2-INVENTORY-LOCALE]', () => {
    // WRONG IMPLS KILLED: a key without the locale (the empty / item strings are resolved at
    // render time, so an equal view-model under a new locale would keep the old language until
    // the data changed).
    const original = currentLocale();
    try {
      const { view, root } = ctl7bSetup();
      view.refresh({ monsters: [], items: [] });
      const inventoryEmptyBefore = ctl7bByOwnText(root, i18nT('raising.inventory.empty'));
      setLocale('fr');
      view.refresh({ monsters: [], items: [] });
      const inventoryEmptyAfter = ctl7bByOwnText(root, i18nT('raising.inventory.empty'));
      expect(inventoryEmptyAfter, 'the empty inventory line was re-rendered').not.toBe(
        inventoryEmptyBefore,
      );
      expect(inventoryEmptyBefore.isConnected).toBe(false);

      setLocale('en');
      view.refresh(raTrainVm());
      // `raising.inventory.item` reads the same in en and fr, so the inventory half of this case
      // is only observable through NODE IDENTITY: capture an item line before the switch.
      const itemLine = i18nTf('raising.inventory.item', { name: 'Protein', count: 2 });
      const itemBefore = ctl7bByOwnText(root, itemLine);
      setLocale('fr');
      view.refresh(raTrainVm()); // deep-equal, but a different locale
      const itemAfter = ctl7bByOwnText(root, itemLine);
      expect(itemAfter, 'the inventory was re-rendered under the new locale').not.toBe(itemBefore);
      expect(itemBefore.isConnected, 'the old inventory line is gone').toBe(false);
      expect(root.textContent ?? '', 'the inventory reads the new locale').toContain(
        i18nTf('raising.inventory.item', { name: 'Protein', count: 2 }),
      );
    } finally {
      setLocale(original);
    }
  });

  it('CTL7B-RV-KEY-MUTATION BITES: mutating the previously rendered view-model in place and refreshing the same object re-renders', () => {
    // WRONG IMPLS KILLED: a skip keyed on object identity or on a shallow compare against the
    // PREVIOUS REFERENCE (the previous view-model is the object being mutated, so it always
    // "equals" itself). The key must be a serialisation taken at render time.
    const { view, root } = ctl7bSetup();
    const vm = raTrainVm();
    view.refresh(vm);
    const before = ctl7bCards(root);

    (vm.items[0] as unknown as { count: number }).count = 7;
    view.refresh(vm); // the SAME object, mutated in place

    const after = ctl7bCards(root);
    expect(after[0], 'the inventory re-rendered').not.toBe(before[0]);
    ctl7bExpectInventory(root, vm, 'in-place mutation');
    expect(root.textContent ?? '').toContain('Protein (x7)');
  });

  it('CTL7B-RV-KEY-EMPTY-FIRST BITES: the first refresh of a fresh view renders the empty text even for an empty view-model, and a repeat empty refresh leaves it alone', () => {
    // WRONG IMPLS KILLED: a key that starts as the key of the EMPTY view-model (or any non-null
    // initial value that an empty view-model equals), which would skip the first render and leave
    // the container blank; a skip that does not apply to empty view-models (the control).
    const { view, root } = ctl7bSetup();
    view.refresh({ monsters: [], items: [] });
    const inventoryEmpty = ctl7bByOwnText(root, i18nT('raising.inventory.empty'));
    expect(inventoryEmpty.isConnected).toBe(true);

    view.refresh({ monsters: [], items: [] });
    expect(
      ctl7bByOwnText(root, i18nT('raising.inventory.empty')),
      'an equal empty refresh keeps the empty inventory line',
    ).toBe(inventoryEmpty);
  });

  it('CTL7B-RV-KEY-THROW BITES: a render that throws leaves no key, so the next refresh of the same view-model renders — on a first render and after a changed one', () => {
    // WRONG IMPLS KILLED: a key written BEFORE the render runs (a throw midway leaves the key set
    // and the half-rendered list is then skipped for as long as the view-model stays the same);
    // a key never deleted before the render (the second phase: A's stale key survives B's throw).
    // The throw is injected through the resolver the render calls first (the item line).
    try {
      const { view, root } = ctl7bSetup();
      vi.mocked(i18nTf).mockImplementationOnce(() => {
        throw new Error('ctl7b: injected render failure');
      });
      expect(() => view.refresh(raTrainVm())).toThrow('ctl7b: injected render failure');

      const again = raTrainVm(); // deep-equal to the view-model whose render threw
      view.refresh(again);
      ctl7bExpectInventory(root, again, 'refresh after a throwing render');
      expect(ctl7bCards(root), 'and all three cards are there').toHaveLength(3);

      // CHANGED-render phase, on a fresh view: A renders; a CHANGED view-model B throws midway
      // (after replaceChildren() cleared the list); refreshing A again must fully re-render A. A
      // render that never deletes the stale key BEFORE rendering leaves A's key in place, so the
      // refresh of A is skipped and the list stays empty.
      const second = ctl7bSetup();
      second.view.refresh(raTrainVm());
      expect(ctl7bCards(second.root), 'precondition: A rendered').toHaveLength(3);
      vi.mocked(i18nTf).mockImplementationOnce(() => {
        throw new Error('ctl7b: injected render failure');
      });
      expect(() => second.view.refresh(ctl7bItem(raTrainVm(), 0, { count: 6 }))).toThrow(
        'ctl7b: injected render failure',
      );
      const backToA = raTrainVm();
      second.view.refresh(backToA);
      ctl7bExpectInventory(second.root, backToA, 'refresh of A after a changed render threw');
      expect(ctl7bCards(second.root), 'A is fully re-rendered').toHaveLength(3);
    } finally {
      vi.mocked(i18nTf).mockRestore();
    }
  });
});

// =============================================================================
// i18n migration batch B: raisingView.ts routes its migrated
// sinks through t()/tf() (ADR-0256/0257/0259/0260 resolver) instead of raw
// English literals.
//
// qf-9 (named intentional change): the roster loses `raising.monsters.heading`,
// `raising.monsters.empty`, `raising.card.care` (plain) and `raising.card.status`,
// `raising.card.stats`, `raising.card.train` (param) with the cards; `showFeedback()` text and the
// Train request count leave RV-01 / RV-02. The English roster words STAY: they are now words that
// must appear nowhere in the root (a leaked card string fails the scan whether or not it sits in a
// sentinel).
// =============================================================================

const M24S4_RV_PLAIN_KEYS = new Set([
  'raising.title',
  'raising.inventory.heading',
  'raising.inventory.empty',
]);

const M24S4_RV_PARAM_KEYS = new Set(['raising.inventory.item']);

/** True iff `content` (the text strictly between one `«`/`»` pair) is EXACTLY an
 *  expected sentinel: a bare roster key, or `key|<json>` where `key` is a roster
 *  PARAM key and the tail after the FIRST `|` parses to a plain (non-array,
 *  non-null) object. */
function m24s4RvIsExpectedSentinelSpan(content: string): boolean {
  const bar = content.indexOf('|');
  if (bar === -1) {
    return M24S4_RV_PLAIN_KEYS.has(content) || M24S4_RV_PARAM_KEYS.has(content);
  }
  const key = content.slice(0, bar);
  if (!M24S4_RV_PARAM_KEYS.has(key)) return false;
  const tail = content.slice(bar + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/** Elides only the bracket spans that are EXACTLY an expected sentinel (manual
 *  indexOf loop — no RegExp) and reports every OTHER `«...»` span
 *  verbatim in `unexpectedSpans`, un-elided, so it stays in `stripped` for the
 *  roster-word scan too — see battleView.test.ts's m24s3SplitSentinels header. */
function m24s4RvSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
  let out = '';
  const unexpectedSpans: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('«', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = text.indexOf('»', open + 1);
    if (close === -1) {
      // Unterminated bracket: never a legitimate sentinel — leave it in place.
      out += text.slice(open);
      break;
    }
    const span = text.slice(open, close + 1);
    const content = text.slice(open + 1, close);
    if (m24s4RvIsExpectedSentinelSpan(content)) {
      // Elide — this is a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

/** Whole-subtree walk (plan R5): every descendant's own text-node children, every
 *  element's `title` attribute, and every `<option>`'s text — never a per-element
 *  spot check. */
function m24s4RvWalkSubtree(root: HTMLElement): string[] {
  const texts: string[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    const titleAttr = el.getAttribute('title');
    if (titleAttr) texts.push(titleAttr);
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) texts.push(node.textContent ?? ''); // TEXT_NODE
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return texts;
}

const M24S4_RV_ROSTER = [
  'Raising & Inventory',
  'Monsters',
  'Inventory',
  'No monsters.',
  'No items.',
  'Care',
  'Trust ',
  'HP ',
  'ATK ',
  'DEF ',
  'SPD ',
  'SP.ATK ',
  'SP.DEF ',
  'Train: ',
];

function m24s4RvAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s4RvSplitSentinels(texts.join('\n'));
  // A FORGED bracket span (raw English wrapped in `«...»` by something other than the
  // resolver) is never elided — it must not exist at all under a correct implementation.
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel (a forged ` +
      `bracket span around raw content is not exempted from the roster scan)`,
  ).toEqual([]);
  for (const word of M24S4_RV_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

/** The first argument of every recorded call of a spied resolver function, as plain strings. */
const calledKeys = (fn: { mock: { calls: unknown[][] } }): string[] =>
  fn.mock.calls.map((c) => String(c[0]));

describe('m24s4 (ADR-0260): raisingView.ts routes its migrated sinks through t()/tf()', () => {
  it('m24s4 RV-01: every remaining sink calls t()/tf() with the exact key and params, no retired raising.* id is ever requested, show() re-resolves on a repeat open, and every DOM string stays byte-identical [QF9-2-I18N-RV01]', () => {
    vi.mocked(i18nT).mockClear();
    vi.mocked(i18nTf).mockClear();
    const parent = mountParent();
    const view = new RaisingView(parent);
    const root = overlayRootOf(parent);

    // --- pre-show: constructor-time keys must NOT have been requested yet (plan D3) ---
    expect(
      i18nT,
      'm24s4 RV-01: raising.title must resolve in show(), not the constructor',
    ).not.toHaveBeenCalledWith('raising.title');
    expect(i18nT).not.toHaveBeenCalledWith('raising.inventory.heading');

    // --- empty monsters + empty inventory ---
    view.refresh({ monsters: [], items: [] });
    view.show();
    expect(i18nT).toHaveBeenCalledWith('raising.title');
    expect(i18nT).toHaveBeenCalledWith('raising.inventory.heading');
    expect(i18nT).toHaveBeenCalledWith('raising.inventory.empty');
    // NAMED INTENTIONAL CHANGE (qf-10, QF10.4): was 'Raising & Inventory'. Located by testid: the
    // section heading (raising.inventory.heading) also reads 'Inventory'.
    expect(root.querySelector('[data-testid="raising-title"]')?.textContent).toBe('Inventory');
    expect(root.textContent ?? '').toContain('No items.');
    expect(root.textContent ?? '', 'no empty-monsters line').not.toContain('No monsters.');

    // --- one monster, three items ---
    vi.mocked(i18nT).mockClear();
    vi.mocked(i18nTf).mockClear();
    const items = [
      {
        invId: 200n,
        itemId: 40,
        name: 'Meadowgrain',
        description: 'A field-grown ration.',
        count: 3,
        trainStat: 'speed',
        canTrain: true,
      },
      {
        invId: 201n,
        itemId: 41,
        name: 'Duskroot',
        description: 'An out-of-stock ration.',
        count: 0,
        trainStat: 'attack',
        canTrain: true,
      },
      {
        invId: 202n,
        itemId: 42,
        name: 'Glimmerpebble',
        description: 'Not a training item.',
        count: 5,
        trainStat: null,
        canTrain: false,
      },
    ];
    const monster = {
      monsterId: 55n,
      nickname: 'Kiri',
      level: 12,
      trustTier: 'Wary' as const,
      currentHp: 30,
      statHp: 50,
      statAttack: 22,
      statDefense: 18,
      statSpeed: 27,
      statSpAttack: 15,
      statSpDefense: 19,
    };
    view.refresh({ monsters: [monster], items });

    expect(i18nT).not.toHaveBeenCalledWith('raising.inventory.empty');
    expect(i18nTf).toHaveBeenCalledWith('raising.inventory.item', {
      name: 'Meadowgrain',
      count: 3,
    });
    expect(i18nTf).toHaveBeenCalledWith('raising.inventory.item', { name: 'Duskroot', count: 0 });
    expect(i18nTf).toHaveBeenCalledWith('raising.inventory.item', {
      name: 'Glimmerpebble',
      count: 5,
    });
    expect(
      calledKeys(vi.mocked(i18nTf)).filter((k) => k.startsWith('raising.card.')),
      'QF9.2: no raising.card.* id is requested any more (status, stats, train)',
    ).toEqual([]);
    expect(
      calledKeys(vi.mocked(i18nT)).filter(
        (k) => k.startsWith('raising.card.') || k.startsWith('raising.monsters.'),
      ),
      'QF9.2: no raising.card.* / raising.monsters.* id is requested any more (care, heading, empty)',
    ).toEqual([]);

    // model-supplied strings render RAW, never a key; the monster does not render at all
    expect(root.textContent ?? '').toContain('A field-grown ration.');
    expect(root.textContent ?? '').toContain('An out-of-stock ration.');
    expect(root.textContent ?? '').toContain('Not a training item.');
    expect(root.textContent ?? '', 'the monster`s nickname is not rendered').not.toContain('Kiri');
    expect(
      [...root.querySelectorAll('button')].map((b) => b.textContent),
      'and there is no Train (or any) button',
    ).toEqual([]);

    // --- RT2: a repeat show() re-resolves the constructor-time keys ---
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s4 RV-01 RT2: a repeat show() on an already-open overlay must re-resolve raising.title',
    ).toHaveBeenCalledWith('raising.title');
    expect(i18nT).toHaveBeenCalledWith('raising.inventory.heading');
    expect(i18nT).not.toHaveBeenCalledWith('raising.monsters.heading');
  });

  it('m24s4 RV-02: under «key» sentinels, every rendered surface shows resolver output and never an English roster word outside a sentinel, and no retired sentinel appears [QF9-2-I18N-RV02]', () => {
    const parent = mountParent();
    const view = new RaisingView(parent);
    const root = overlayRootOf(parent);

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );

      view.refresh({ monsters: [], items: [] });
      view.show();
      let texts = m24s4RvWalkSubtree(root);
      m24s4RvAssertNoRosterWord(texts, 'monsters+items empty');
      let joined = texts.join('\n');
      expect(joined).toContain('«raising.title»');
      expect(joined).toContain('«raising.inventory.heading»');
      expect(joined).toContain('«raising.inventory.empty»');
      expect(joined, 'no retired heading sentinel').not.toContain('«raising.monsters.heading»');
      expect(joined, 'no retired empty sentinel').not.toContain('«raising.monsters.empty»');

      const items = [
        {
          invId: 200n,
          itemId: 40,
          name: 'Meadowgrain',
          description: 'A field-grown ration.',
          count: 3,
          trainStat: 'speed',
          canTrain: true,
        },
        {
          invId: 201n,
          itemId: 41,
          name: 'Duskroot',
          description: 'An out-of-stock ration.',
          count: 0,
          trainStat: 'attack',
          canTrain: true,
        },
        {
          invId: 202n,
          itemId: 42,
          name: 'Glimmerpebble',
          description: 'Not a training item.',
          count: 5,
          trainStat: null,
          canTrain: false,
        },
      ];
      const monster = {
        monsterId: 55n,
        nickname: 'Kiri',
        level: 12,
        trustTier: 'Wary' as const,
        currentHp: 30,
        statHp: 50,
        statAttack: 22,
        statDefense: 18,
        statSpeed: 27,
        statSpAttack: 15,
        statSpDefense: 19,
      };
      view.refresh({ monsters: [monster], items });
      texts = m24s4RvWalkSubtree(root);
      m24s4RvAssertNoRosterWord(texts, 'one monster, three items');
      joined = texts.join('\n');
      for (const retired of [
        'raising.card.care',
        'raising.card.status',
        'raising.card.stats',
        'raising.card.train',
      ]) {
        expect(joined, `no «${retired}» sentinel`).not.toContain(`«${retired}`);
      }
      expect(joined).toContain(
        `«raising.inventory.item|${JSON.stringify({ name: 'Meadowgrain', count: 3 })}»`,
      );
      expect(joined).toContain(
        `«raising.inventory.item|${JSON.stringify({ name: 'Duskroot', count: 0 })}»`,
      );
      expect(joined).toContain(
        `«raising.inventory.item|${JSON.stringify({ name: 'Glimmerpebble', count: 5 })}»`,
      );
      // model-supplied strings must render RAW, never a sentinel
      expect(joined).toContain('A field-grown ration.');
      expect(joined, 'the monster`s nickname is not rendered').not.toContain('Kiri');
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

// =============================================================================
// ctl-8f (CTL8F.1, CTL8F.2): the Bag panel inside the raising root.
//
// `RaisingView.paint(p)` takes `{ vm, nav, phase, status }` (the adapter's paint) and renders, inside
// the raising root, the pocket tab strip (#bag-tabs), the active pocket's items (#bag-list), the item
// sheet (#bag-sheet), the description (#bag-info), the monster picker (#bag-picker with
// #bag-picker-title) and the status line (#bag-status). qf-9: the legacy monster section, Care and
// Train buttons and #raising-feedback are gone; refresh() renders the legacy inventory grid (id
// `raising-inventory`), which is hidden while a paint is kept and comes back at the next show().
//
// "Shown" / "hidden" is the part's own inline `style.display` (hidden = 'none'). The paints here are
// hand-built (no adapter), and the nav states come from the real nav kit over a layout written out
// in this file, so these cases pin the view against the CONTRACT's shapes alone; the WIRED case at
// the end drives the real adapter into the real view.
//
// The new modules are imported dynamically inside the WIRED case only, so a missing module reds
// that case alone and never the pre-existing cases of this file.
// =============================================================================

import type { VButton } from '../input/buttons';
import type { BagItemVm, BagVm } from './bagModel';
import { list as ctl8fList, tabs as ctl8fTabs, type NavState, navInit, navStep } from './nav';

type Ctl8fPaint = Parameters<RaisingView['paint']>[0];

function ctl8fItem(
  itemId: number,
  name: string,
  description: string,
  count: number,
  over: Partial<BagItemVm> = {},
): BagItemVm {
  return {
    key: String(itemId),
    itemId,
    name,
    description,
    count,
    canFeed: false,
    battleUse: false,
    ...over,
  };
}

/** bait [3]; food [9, 5] (inventory order); medicine [12] (or [] with `bareMedicine`); other [20]. */
function ctl8fVm(opts: { bareMedicine?: boolean; monsters?: boolean } = {}): BagVm {
  return {
    pockets: [
      {
        pocket: 'bait',
        items: [ctl8fItem(3, 'Lure Berry', 'Lures a wild monster.', 4, { battleUse: true })],
      },
      {
        pocket: 'food',
        items: [
          ctl8fItem(9, 'Glow Berry', 'Raises speed.', 2, { canFeed: true }),
          ctl8fItem(5, 'Power Root', 'Raises attack.', 3, { canFeed: true }),
        ],
      },
      {
        pocket: 'medicine',
        items:
          opts.bareMedicine === true
            ? []
            : [ctl8fItem(12, 'Antidote', 'Cures poison.', 1, { battleUse: true })],
      },
      { pocket: 'other', items: [ctl8fItem(20, 'Moon Shard', '', 6)] },
    ],
    monsters:
      opts.monsters === false
        ? []
        : [
            { key: '11', monsterId: 11n, name: 'Kip' },
            { key: '12', monsterId: 12n, name: 'Emberfang' },
            { key: '21', monsterId: 21n, name: 'Sproutle' },
          ],
  };
}

function ctl8fLayout(vm: BagVm) {
  return ctl8fTabs(
    vm.pockets.map((p) => ({
      key: p.pocket,
      layout: ctl8fList(p.items.map((i) => ({ key: i.key, enabled: true }))),
    })),
  );
}

/** The nav state after `steps` fresh presses from the opening. */
function ctl8fNav(vm: BagVm, steps: readonly VButton[] = []): NavState {
  const layout = ctl8fLayout(vm);
  let state = navInit(layout);
  for (const button of steps) state = navStep(layout, state, { button, repeat: false }).state;
  return state;
}

function ctl8fPaint(vm: BagVm, over: Partial<Ctl8fPaint> = {}): Ctl8fPaint {
  return { vm, nav: ctl8fNav(vm), phase: { kind: 'list' }, status: null, ...over };
}

const CTL8F_PARTS = ['bag-tabs', 'bag-list', 'bag-sheet', 'bag-info', 'bag-picker'] as const;

function ctl8fPart(id: string): HTMLElement {
  const el = document.getElementById(id);
  expect(el, `#${id} must exist in the raising root`).not.toBeNull();
  return el as HTMLElement;
}
/** Shown = the part's own inline display is not 'none'. */
const ctl8fShown = (id: string): boolean => ctl8fPart(id).style.display !== 'none';
const ctl8fRows = (id: string): HTMLElement[] => [
  ...ctl8fPart(id).querySelectorAll<HTMLElement>('.mr-nav-item'),
];
const ctl8fKeys = (id: string): Array<string | undefined> =>
  ctl8fRows(id).map((r) => r.dataset.navKey);
const ctl8fTabEls = (): HTMLElement[] => [
  ...ctl8fPart('bag-tabs').querySelectorAll<HTMLElement>('.mr-nav-tab'),
];
/** The cursor rows of a nav container: those marked is-active (and aria-selected). */
const ctl8fActive = (id: string): Array<string | undefined> =>
  ctl8fRows(id)
    .filter((r) => r.classList.contains('is-active'))
    .map((r) => r.dataset.navKey);
/** Own-text lines `text` under the root outside the legacy inventory grid. */
function ctl8fLinesOutsideGrid(root: HTMLElement, text: string): HTMLElement[] {
  const grid = document.getElementById('raising-inventory');
  return [...root.querySelectorAll<HTMLElement>('*')].filter(
    (el) => ctl7bOwnText(el) === text && (grid === null || !grid.contains(el)),
  );
}

describe('RaisingView ctl-8f: the Bag panel (CTL8F.1, CTL8F.2)', () => {
  it('CTL8F-1-VIEW-PAINT: before any paint the five bag parts exist and are hidden and the legacy grid shows; a paint shows the pocket tabs (the active one selected), the active pocket`s items as "name (xN)" rows with the cursor row marked, hides the legacy grid for as long as the paint is kept (a refresh keeps it hidden), shows the empty line for an empty pocket, and after hide() then show() the grid is back and the bag parts are hidden until the next paint', () => {
    // WRONG IMPL KILLED: parts created lazily or visible before the first paint (the player would
    // see an empty bag frame beside the legacy grid); a tab strip with the wrong labels, order or
    // selected tab; a list that shows every pocket or the wrong one; row text that is not the
    // resolver's "name (xN)"; a cursor row marked by colour alone (no is-active / aria-selected); a
    // list of <button>s (the raising screen's button census would change); a legacy grid that stays
    // visible under the bag, that a refresh() brings back, or that never comes back after a close
    // (the kept paint must be dropped by hide()); a close that leaves the bag parts showing the
    // dropped paint; an empty pocket that shows nothing; and markup injected from an item name.
    // qf-9 (named intentional change): the button census is ZERO (the cards' Care / Train buttons
    // are gone), so "no bag row is a button" is a count of zero before and after the paint.
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    view.refresh(raTrainVm());
    const buttonsBefore = root.querySelectorAll('button').length;
    expect(buttonsBefore, 'precondition: the raising root renders no button at all').toBe(0);
    const grid = ctl8fPart('raising-inventory');
    expect(grid.style.display, 'the legacy grid shows before any paint').not.toBe('none');
    for (const id of CTL8F_PARTS) {
      expect(ctl8fPart(id).style.display, `#${id} is hidden before any paint`).toBe('none');
      expect(root.contains(ctl8fPart(id)), `#${id} is inside the raising root`).toBe(true);
    }
    expect(ctl8fPart('bag-status').textContent, 'the status line starts empty').toBe('');

    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm));
    expect(ctl8fShown('bag-tabs')).toBe(true);
    expect(ctl8fShown('bag-list')).toBe(true);
    expect(
      ctl8fTabEls().map((t) => [t.dataset.navTab, t.textContent, t.getAttribute('aria-selected')]),
      'the four pockets in order, Bait selected',
    ).toEqual([
      ['bait', 'Bait', 'true'],
      ['food', 'Food', 'false'],
      ['medicine', 'Medicine', 'false'],
      ['other', 'Other', 'false'],
    ]);
    expect(ctl8fKeys('bag-list'), 'only the active pocket`s items').toEqual(['3']);
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual(['Lure Berry (x4)']);
    expect(ctl8fActive('bag-list')).toEqual(['3']);
    expect(ctl8fRows('bag-list')[0]?.getAttribute('aria-selected')).toBe('true');
    expect(grid.style.display, 'the legacy grid is hidden under a kept paint').toBe('none');
    expect(
      ctl8fLinesOutsideGrid(root, 'No items.'),
      'a pocket with items shows no empty line',
    ).toEqual([]);
    expect(root.querySelectorAll('button').length, 'no bag row is a button').toBe(buttonsBefore);

    // The food pocket, the cursor on its second item.
    view.paint(ctl8fPaint(vm, { nav: ctl8fNav(vm, ['RB', 'Down']) }));
    expect(
      ctl8fTabEls().map((t) => t.getAttribute('aria-selected')),
      'only Food is selected now',
    ).toEqual(['false', 'true', 'false', 'false']);
    expect(ctl8fKeys('bag-list'), 'Food in inventory order').toEqual(['9', '5']);
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual([
      'Glow Berry (x2)',
      'Power Root (x3)',
    ]);
    expect(
      ctl8fRows('bag-list').map((r) => r.textContent),
      'the rows are the resolver`s raising.inventory.item',
    ).toEqual([
      i18nTf('raising.inventory.item', { name: 'Glow Berry', count: 2 }),
      i18nTf('raising.inventory.item', { name: 'Power Root', count: 3 }),
    ]);
    expect(ctl8fActive('bag-list'), 'the cursor row only').toEqual(['5']);
    expect(ctl8fRows('bag-list').map((r) => r.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
    ]);

    // A refresh() under a kept paint does not bring the legacy grid back.
    view.refresh(ctl7bItem(raTrainVm(), 0, { count: 5 }));
    expect(grid.style.display, 'a refresh keeps the legacy grid hidden').toBe('none');
    expect(grid.textContent ?? '', 'and still rebuilds its content').toContain('Protein (x5)');

    // An empty pocket: no rows, the empty line somewhere in the bag panel.
    const bare = ctl8fVm({ bareMedicine: true });
    view.paint(ctl8fPaint(bare, { nav: ctl8fNav(bare, ['RB', 'RB']) }));
    expect(ctl8fKeys('bag-list'), 'no rows').toEqual([]);
    expect(
      ctl8fLinesOutsideGrid(root, i18nT('raising.inventory.empty')).length,
      'the empty line is inside the bag panel, not the legacy grid',
    ).toBeGreaterThan(0);
    expect(ctl8fTabEls().map((t) => t.dataset.navTab)).toEqual([
      'bait',
      'food',
      'medicine',
      'other',
    ]);

    // hide() then show(): the grid is back, the dropped paint is not shown.
    view.hide();
    view.show();
    expect(grid.style.display, 'the legacy grid is visible again after a reopen').not.toBe('none');
    expect(ctl8fShown('bag-tabs'), 'the bag tabs are hidden again').toBe(false);
    expect(ctl8fShown('bag-list'), 'the bag list is hidden again').toBe(false);
    view.paint(ctl8fPaint(vm));
    expect(grid.style.display, 'the next paint hides the grid again').toBe('none');
    expect(ctl8fShown('bag-tabs')).toBe(true);
    expect(ctl8fKeys('bag-list')).toEqual(['3']);

    // Item names are text, never markup.
    const hostile = ctl8fVm();
    const first = hostile.pockets[0]?.items[0];
    if (first === undefined) throw new Error('fixture: no first item');
    const injected: BagVm = {
      ...hostile,
      pockets: [
        { pocket: 'bait', items: [{ ...first, name: '<b>bold</b>' }] },
        ...hostile.pockets.slice(1),
      ],
    };
    view.paint(ctl8fPaint(injected));
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual(['<b>bold</b> (x4)']);
    expect(ctl8fPart('bag-list').querySelector('b'), 'no element was created').toBeNull();
  });

  it('CTL8F-2-VIEW-SHEET: the sheet, description and picker show only in their own phase (the title with the picker), the sheet lists Feed / Use / Info with the cursor on the phase`s action and disabled rows marked aria-disabled, the description shows the item`s description (the none-line when empty), the picker lists the monsters by name with the cursor on the phase`s monster, and the status line carries the three messages (data-feedback only for Fed) and clears', () => {
    // WRONG IMPL KILLED: a sheet / description / picker / title visible in the wrong phase or in
    // every phase; a sheet that never marks the phase's action; a disabled Use or Feed that is not
    // aria-disabled (or an enabled row that is); labels that are not the catalog's; a description
    // that is stale after the item changes or blank for an item with none; a picker cursor that
    // ignores the phase, rows that are not the monsters' names in order; a status line that never
    // clears, keeps data-feedback after Fed, sets it for the refusals, or builds markup from the
    // monster's name; and a status line that is not the frame's feedback line.
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    const vm = ctl8fVm();
    const food = ctl8fNav(vm, ['RB']);
    const root5 = ctl8fNav(vm, ['RB', 'Down']);
    const lure = ctl8fNav(vm);
    const shard = ctl8fNav(vm, ['RB', 'RB', 'RB']);

    const matrix: ReadonlyArray<
      readonly [string, Ctl8fPaint, { sheet: boolean; info: boolean; picker: boolean }]
    > = [
      ['list', ctl8fPaint(vm), { sheet: false, info: false, picker: false }],
      [
        'sheet',
        ctl8fPaint(vm, { nav: food, phase: { kind: 'sheet', itemId: 9, action: 'feed' } }),
        { sheet: true, info: false, picker: false },
      ],
      [
        'info',
        ctl8fPaint(vm, { nav: food, phase: { kind: 'info', itemId: 9 } }),
        { sheet: false, info: true, picker: false },
      ],
      [
        'picker',
        ctl8fPaint(vm, { nav: food, phase: { kind: 'picker', itemId: 9, monster: '11' } }),
        { sheet: false, info: false, picker: true },
      ],
      ['list again', ctl8fPaint(vm, { nav: food }), { sheet: false, info: false, picker: false }],
    ];
    for (const [name, p, want] of matrix) {
      view.paint(p);
      expect(ctl8fShown('bag-sheet'), `${name}: #bag-sheet`).toBe(want.sheet);
      expect(ctl8fShown('bag-info'), `${name}: #bag-info`).toBe(want.info);
      expect(ctl8fShown('bag-picker'), `${name}: #bag-picker`).toBe(want.picker);
      expect(ctl8fShown('bag-picker-title'), `${name}: #bag-picker-title`).toBe(want.picker);
    }

    // The sheet.
    const sheetOf = (nav: NavState, itemId: number, action: 'feed' | 'use' | 'info', v = vm) => {
      view.paint(ctl8fPaint(v, { nav, phase: { kind: 'sheet', itemId, action } }));
      return ctl8fRows('bag-sheet');
    };
    let rows = sheetOf(food, 9, 'feed');
    expect(rows.map((r) => [r.dataset.navKey, r.textContent])).toEqual([
      ['feed', 'Feed'],
      ['info', 'Info'],
    ]);
    expect(ctl8fActive('bag-sheet'), 'the cursor on Feed').toEqual(['feed']);
    expect(
      rows.map((r) => r.getAttribute('aria-disabled')),
      'with monsters Feed is enabled',
    ).toEqual([null, null]);
    rows = sheetOf(food, 9, 'info');
    expect(ctl8fActive('bag-sheet'), 'the cursor follows the action').toEqual(['info']);
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true']);

    rows = sheetOf(lure, 3, 'use');
    expect(rows.map((r) => [r.dataset.navKey, r.textContent])).toEqual([
      ['use', 'Use'],
      ['info', 'Info'],
    ]);
    expect(
      rows.map((r) => r.getAttribute('aria-disabled')),
      'Use is aria-disabled, Info is not',
    ).toEqual(['true', null]);
    expect(ctl8fActive('bag-sheet')).toEqual(['use']);
    rows = sheetOf(shard, 20, 'info');
    expect(
      rows.map((r) => r.dataset.navKey),
      'a shard offers Info alone',
    ).toEqual(['info']);

    const lonely = ctl8fVm({ monsters: false });
    rows = sheetOf(food, 9, 'feed', lonely);
    expect(
      rows.map((r) => [r.dataset.navKey, r.getAttribute('aria-disabled')]),
      'with no monster Feed is disabled',
    ).toEqual([
      ['feed', 'true'],
      ['info', null],
    ]);

    // The description: the item's own, the none-line when empty, never stale.
    view.paint(ctl8fPaint(vm, { nav: food, phase: { kind: 'info', itemId: 9 } }));
    expect(ctl8fPart('bag-info').textContent ?? '').toContain('Raises speed.');
    view.paint(ctl8fPaint(vm, { nav: root5, phase: { kind: 'info', itemId: 5 } }));
    expect(ctl8fPart('bag-info').textContent ?? '').toContain('Raises attack.');
    expect(ctl8fPart('bag-info').textContent ?? '', 'not the previous item`s').not.toContain(
      'Raises speed.',
    );
    view.paint(ctl8fPaint(vm, { nav: shard, phase: { kind: 'info', itemId: 20 } }));
    const none = i18nT('shop.description.none');
    expect(none, 'precondition: the none-line is not blank').not.toBe('');
    expect(ctl8fPart('bag-info').textContent ?? '', 'an empty description').toContain(none);
    expect(ctl8fPart('bag-info').textContent ?? '').not.toContain('Raises');

    // The picker.
    view.paint(ctl8fPaint(vm, { nav: food, phase: { kind: 'picker', itemId: 9, monster: '12' } }));
    expect(ctl8fPart('bag-picker-title').textContent, 'the picker title').toBe(
      'Feed which monster?',
    );
    expect(ctl8fRows('bag-picker').map((r) => [r.dataset.navKey, r.textContent])).toEqual([
      ['11', 'Kip'],
      ['12', 'Emberfang'],
      ['21', 'Sproutle'],
    ]);
    expect(ctl8fActive('bag-picker'), 'the cursor on the phase`s monster').toEqual(['12']);
    expect(ctl8fRows('bag-picker').map((r) => r.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    view.paint(ctl8fPaint(vm, { nav: food, phase: { kind: 'picker', itemId: 9, monster: '21' } }));
    expect(ctl8fActive('bag-picker')).toEqual(['21']);
    expect(() =>
      view.paint(
        ctl8fPaint(lonely, { nav: food, phase: { kind: 'picker', itemId: 9, monster: null } }),
      ),
    ).not.toThrow();
    expect(ctl8fRows('bag-picker'), 'an empty roster lists nobody').toEqual([]);

    // The status line.
    view.paint(ctl8fPaint(vm));
    const status = ctl8fPart('bag-status');
    expect(status.classList.contains('mr-frame-feedback'), 'the frame`s feedback line').toBe(true);
    expect(status.textContent, 'empty with no status').toBe('');
    expect(status.hasAttribute('data-feedback')).toBe(false);
    const withStatus = (s: Ctl8fPaint['status']) => view.paint(ctl8fPaint(vm, { status: s }));
    withStatus({ kind: 'battleOnly' });
    expect(status.textContent).toBe('Use items from the battle Bag command');
    expect(status.hasAttribute('data-feedback'), 'a refusal is not "ok"').toBe(false);
    withStatus({ kind: 'noMonsters' });
    expect(status.textContent).toBe('No monsters to feed');
    expect(status.hasAttribute('data-feedback')).toBe(false);
    withStatus({ kind: 'fed', name: 'Kip' });
    expect(status.textContent, 'Fed, resolved with the name').toBe(
      i18nTf('box.feedback.fed', { name: 'Kip' }),
    );
    expect(status.textContent ?? '').toContain('Kip');
    expect(status.getAttribute('data-feedback'), 'only Fed is ok').toBe('ok');
    withStatus({ kind: 'fed', name: '<i>x</i>' });
    expect(status.textContent).toBe(i18nTf('box.feedback.fed', { name: '<i>x</i>' }));
    expect(status.querySelector('i'), 'a name is text, never markup').toBeNull();
    withStatus(null);
    expect(status.textContent, 'cleared').toBe('');
    expect(status.hasAttribute('data-feedback'), 'and its mark is cleared with it').toBe(false);
    withStatus({ kind: 'fed', name: 'Kip' });
    withStatus({ kind: 'battleOnly' });
    expect(status.hasAttribute('data-feedback'), 'a refusal after Fed drops the ok mark').toBe(
      false,
    );
    expect(root.contains(status), 'inside the raising root').toBe(true);
  });

  it('CTL8F-1-VIEW-WIRED: the real adapter driving the real view: opening shows Bait; RB shows Food with its rows and cursor; A, Down, A reach the description and B returns; Feed, Down opens the picker on the second monster and A sends the train command and closes it; Use on a cure shows the battleOnly line', async () => {
    // WRONG IMPL KILLED: a view whose paint shape is not the adapter's (the hand-built cases above
    // would pass while the pair is unwired); a paint that the adapter never makes after a step; a
    // list that does not follow the adapter's pocket; a sheet / description / picker that is not
    // shown for the adapter's phase; a train command that does not carry the picker's monster; and
    // a status line the adapter's refusal never reaches.
    const { buildBagVm } = await import('./bagModel');
    const { bagScreen } = await import('./screens/bagScreen');
    const defs = new Map(
      [
        {
          id: 3,
          name: 'Lure Berry',
          description: 'Lures a wild monster.',
          recruitBonus: 10,
          trainStat: null,
          cureStatus: null,
        },
        {
          id: 5,
          name: 'Power Root',
          description: 'Raises attack.',
          recruitBonus: 0,
          trainStat: 'attack',
          cureStatus: null,
        },
        {
          id: 9,
          name: 'Glow Berry',
          description: 'Raises speed.',
          recruitBonus: 0,
          trainStat: 'speed',
          cureStatus: null,
        },
        {
          id: 12,
          name: 'Antidote',
          description: 'Cures poison.',
          recruitBonus: 0,
          trainStat: null,
          cureStatus: 'Poison',
        },
        // A shard-like definition with no effect fields: the `other` pocket the data holds.
        {
          id: 20,
          name: 'Moon Shard',
          description: '',
          recruitBonus: 0,
          trainStat: null,
          cureStatus: null,
        },
      ].map(
        (d) => [d.id, { ...d, trainAmount: d.trainStat === null ? 0 : 1, sellPrice: 0n }] as const,
      ),
    );
    const owner = 'ab'.repeat(32);
    const inventory = [
      { invId: 1n, ownerIdentity: owner, itemId: 9, count: 2 },
      { invId: 2n, ownerIdentity: owner, itemId: 3, count: 4 },
      { invId: 3n, ownerIdentity: owner, itemId: 5, count: 3 },
      { invId: 4n, ownerIdentity: owner, itemId: 12, count: 1 },
      { invId: 5n, ownerIdentity: owner, itemId: 20, count: 6 },
    ];
    const vm = buildBagVm(inventory, defs, [
      { key: '11', monsterId: 11n, name: 'Kip' },
      { key: '12', monsterId: 12n, name: 'Emberfang' },
    ]);

    const { parent, view } = s4Mount();
    view.show();
    let state = bagScreen.init(vm);
    const step = (button: VButton) => {
      const out = bagScreen.onButton(vm, state, { button, repeat: false });
      state = out.state;
      bagScreen.paint?.(view, vm, state);
      return out.result;
    };
    bagScreen.paint?.(view, vm, state);

    expect(ctl8fTabEls().map((t) => t.dataset.navTab)).toEqual([
      'bait',
      'food',
      'medicine',
      'other',
    ]);
    expect(ctl8fTabEls().map((t) => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual(['Lure Berry (x4)']);

    expect(step('RB')).toBe('consumed');
    expect(ctl8fTabEls().map((t) => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual([
      'Glow Berry (x2)',
      'Power Root (x3)',
    ]);
    expect(ctl8fActive('bag-list')).toEqual(['9']);

    expect(step('A')).toBe('consumed');
    expect(ctl8fShown('bag-sheet')).toBe(true);
    expect(ctl8fRows('bag-sheet').map((r) => r.textContent)).toEqual(['Feed', 'Info']);
    expect(ctl8fActive('bag-sheet')).toEqual(['feed']);

    expect(step('Down')).toBe('consumed');
    expect(ctl8fActive('bag-sheet')).toEqual(['info']);
    expect(step('A')).toBe('consumed');
    expect(ctl8fShown('bag-info')).toBe(true);
    expect(ctl8fShown('bag-sheet')).toBe(false);
    expect(ctl8fPart('bag-info').textContent ?? '').toContain('Raises speed.');
    expect(step('B')).toBe('consumed');
    expect(ctl8fShown('bag-info')).toBe(false);
    expect(ctl8fActive('bag-sheet'), 'back on the sheet, on Info').toEqual(['info']);

    expect(step('Up')).toBe('consumed');
    expect(step('A')).toBe('consumed');
    expect(ctl8fShown('bag-picker')).toBe(true);
    expect(ctl8fPart('bag-picker-title').textContent).toBe('Feed which monster?');
    expect(ctl8fActive('bag-picker')).toEqual(['11']);
    expect(step('Down')).toBe('consumed');
    expect(ctl8fActive('bag-picker')).toEqual(['12']);
    expect(step('A')).toEqual({ kind: 'train', monsterId: 12n, foodItemId: 9 });
    expect(ctl8fShown('bag-picker'), 'the picker closes on the send').toBe(false);
    expect(ctl8fShown('bag-sheet')).toBe(false);
    expect(ctl8fActive('bag-list'), 'the cursor is on the fed item').toEqual(['9']);

    // Use on a cure: the battleOnly line.
    expect(step('RB')).toBe('consumed');
    expect(ctl8fKeys('bag-list')).toEqual(['12']);
    expect(step('A')).toBe('consumed');
    expect(ctl8fActive('bag-sheet')).toEqual(['use']);
    expect(step('A')).toBe('consumed');
    expect(ctl8fPart('bag-status').textContent).toBe('Use items from the battle Bag command');
    expect(ctl8fShown('bag-sheet'), 'the sheet stays open').toBe(true);
    expect(parent.contains(ctl8fPart('bag-status'))).toBe(true);
    expect(step('B')).toBe('consumed');
    expect(ctl8fPart('bag-status').textContent, 'the next button clears the line').toBe('');
  });
});

// ---------------------------------------------------------------------------
// ctl-8f red-team teeth for the Bag panel: what a reopen, a stale phase, the empty line, the
// always-shown tab strip and list, the ARIA wiring and the focus guard must do. Untagged cases.
// ---------------------------------------------------------------------------
describe('RaisingView ctl-8f: the Bag panel teeth', () => {
  const root5 = (vm: BagVm) => ctl8fNav(vm, ['RB', 'Down']);

  it('a status painted before hide() is gone after show(): the line is empty and carries no data-feedback', () => {
    // WRONG IMPL KILLED: a hide() that forgets the status line (the next open greets the player
    // with the last visit's "Fed Kip" and its ok mark until the first paint).
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm, { status: { kind: 'fed', name: 'Kip' } }));
    expect(ctl8fPart('bag-status').textContent, 'precondition').not.toBe('');
    expect(ctl8fPart('bag-status').getAttribute('data-feedback'), 'precondition').toBe('ok');
    view.hide();
    view.show();
    expect(ctl8fPart('bag-status').textContent, 'cleared by the close').toBe('');
    expect(ctl8fPart('bag-status').hasAttribute('data-feedback')).toBe(false);
  });

  it('a sheet, description or picker phase for an item the view model does not list shows none of the three', () => {
    // WRONG IMPL KILLED: a view that shows the sheet / description / picker for the phase kind
    // alone, so a paint that outlives its item (an adapter one batch late) draws an empty sheet
    // or a picker for nothing.
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    const food = ctl8fNav(vm, ['RB']);
    const phases: ReadonlyArray<readonly [string, Ctl8fPaint['phase']]> = [
      ['sheet', { kind: 'sheet', itemId: 999, action: 'feed' }],
      ['info', { kind: 'info', itemId: 999 }],
      ['picker', { kind: 'picker', itemId: 999, monster: '11' }],
    ];
    for (const [name, phase] of phases) {
      view.paint(ctl8fPaint(vm, { nav: food, phase }));
      for (const id of ['bag-sheet', 'bag-info', 'bag-picker']) {
        expect(ctl8fShown(id), `${name} phase for an unlisted item: #${id}`).toBe(false);
      }
    }
    // Control: the same phases for a listed item do show their part.
    view.paint(ctl8fPaint(vm, { nav: food, phase: { kind: 'sheet', itemId: 9, action: 'feed' } }));
    expect(ctl8fShown('bag-sheet'), 'control: a listed item shows its sheet').toBe(true);
  });

  it('#bag-empty shows for an empty pocket and with no pockets at all, and is hidden for a pocket that has items', () => {
    // WRONG IMPL KILLED: an empty line that is created once and never toggled (it shows over a
    // full pocket, or never shows), one keyed on the active pocket only (a bag with no definitions
    // at all would show a blank frame), and an empty line with no text.
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm));
    expect(ctl8fShown('bag-empty'), 'a pocket with items: hidden').toBe(false);
    const bare = ctl8fVm({ bareMedicine: true });
    view.paint(ctl8fPaint(bare, { nav: ctl8fNav(bare, ['RB', 'RB']) }));
    expect(ctl8fShown('bag-empty'), 'an empty pocket: shown').toBe(true);
    expect(ctl8fPart('bag-empty').textContent ?? '').toContain(i18nT('raising.inventory.empty'));
    view.paint(ctl8fPaint(vm, { nav: ctl8fNav(vm, ['RB']) }));
    expect(ctl8fShown('bag-empty'), 'back on a full pocket: hidden again').toBe(false);
    const none: BagVm = { pockets: [], monsters: [] };
    view.paint(ctl8fPaint(none, { nav: ctl8fNav(none) }));
    expect(ctl8fShown('bag-empty'), 'no pockets at all: shown').toBe(true);
    expect(ctl8fPart('bag-empty').textContent ?? '').toContain(i18nT('raising.inventory.empty'));
  });

  it('the tab strip and the item list stay shown in the sheet, description and picker phases', () => {
    // WRONG IMPL KILLED: a paint that hides the pockets and the list while a sheet, a description
    // or a picker is up (the player loses the item they are acting on).
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    const food = ctl8fNav(vm, ['RB']);
    const phases: ReadonlyArray<readonly [string, Ctl8fPaint['phase']]> = [
      ['list', { kind: 'list' }],
      ['sheet', { kind: 'sheet', itemId: 9, action: 'feed' }],
      ['info', { kind: 'info', itemId: 9 }],
      ['picker', { kind: 'picker', itemId: 9, monster: '11' }],
    ];
    for (const [name, phase] of phases) {
      view.paint(ctl8fPaint(vm, { nav: food, phase }));
      expect(ctl8fShown('bag-tabs'), `${name}: #bag-tabs`).toBe(true);
      expect(ctl8fShown('bag-list'), `${name}: #bag-list`).toBe(true);
      expect(ctl8fKeys('bag-list'), `${name}: the pocket's rows`).toEqual(['9', '5']);
    }
  });

  it('the picker is labelled by its title and the sheet by the list row of its item', () => {
    // WRONG IMPL KILLED: a picker or sheet listbox with no accessible name; a picker named by the
    // wrong element; a sheet named by a fixed element or by another item's row; a name that points
    // at an id that does not exist.
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    view.paint(
      ctl8fPaint(vm, {
        nav: ctl8fNav(vm, ['RB']),
        phase: { kind: 'picker', itemId: 9, monster: '11' },
      }),
    );
    expect(ctl8fPart('bag-picker').getAttribute('aria-labelledby')).toBe('bag-picker-title');
    expect(ctl8fPart('bag-picker-title'), 'the title it names exists').toBeTruthy();

    const cases: ReadonlyArray<readonly [string, NavState, number]> = [
      ['the first food', ctl8fNav(vm, ['RB']), 9],
      ['the second food', root5(vm), 5],
      ['the bait', ctl8fNav(vm), 3],
    ];
    for (const [name, nav, itemId] of cases) {
      view.paint(ctl8fPaint(vm, { nav, phase: { kind: 'sheet', itemId, action: 'info' } }));
      const id = ctl8fPart('bag-sheet').getAttribute('aria-labelledby');
      expect(id, `${name}: the sheet names something`).toBeTruthy();
      const named = document.getElementById(id ?? '');
      expect(named, `${name}: the named element exists`).not.toBeNull();
      expect(named?.dataset.navKey, `${name}: it is that item's row`).toBe(String(itemId));
      expect(ctl8fPart('bag-list').contains(named), `${name}: inside #bag-list`).toBe(true);
    }
  });

  it('closing the sheet or the picker while it holds focus moves focus to the raising title, never to the body', () => {
    // WRONG IMPL KILLED: a paint that hides the focused sheet / picker container and leaves focus
    // stranded on <body> (the keyboard and the screen reader lose their place in the dialog).
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    const food = ctl8fNav(vm, ['RB']);
    const title = document.querySelector<HTMLElement>('[data-testid="raising-title"]');
    expect(title, 'precondition: the raising title').not.toBeNull();
    const phases: ReadonlyArray<readonly [string, Ctl8fPaint['phase'], string]> = [
      ['sheet', { kind: 'sheet', itemId: 9, action: 'feed' }, 'bag-sheet'],
      ['picker', { kind: 'picker', itemId: 9, monster: '11' }, 'bag-picker'],
    ];
    for (const [name, phase, id] of phases) {
      view.paint(ctl8fPaint(vm, { nav: food, phase }));
      ctl8fPart(id).focus();
      expect(document.activeElement, `${name}: precondition, the part holds focus`).toBe(
        ctl8fPart(id),
      );
      view.paint(ctl8fPaint(vm, { nav: food }));
      expect(document.activeElement, `${name} closed: focus is on the title`).toBe(title);
      expect(document.activeElement).not.toBe(document.body);
    }
  });

  it('a paint that arrives while the view is hidden is dropped at the next show(): the legacy grid is visible and the bag parts hidden', () => {
    // WRONG IMPL KILLED: a hide() that drops the kept paint but a paint() that re-keeps one while
    // hidden (the reopen shows a stale bag over the legacy grid, or hides the grid with the bag
    // parts hidden: the player sees no inventory at all).
    const { view } = s4Mount();
    view.show();
    view.refresh(raTrainVm());
    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm));
    view.hide();
    view.paint(ctl8fPaint(vm, { nav: ctl8fNav(vm, ['RB']) })); // a batch lands while hidden
    view.show();
    expect(ctl8fPart('raising-inventory').style.display, 'the legacy grid shows').not.toBe('none');
    for (const id of ['bag-tabs', 'bag-list', 'bag-sheet', 'bag-info', 'bag-picker']) {
      expect(ctl8fShown(id), `#${id} is hidden after the reopen`).toBe(false);
    }
  });
});

// =============================================================================
// qf-11 (QF11.2, QF11.3): the Bag pocket tabs adopt the shared horizontal tab-strip class.
//
// EARS: THE bag (`#bag-tabs`) tab container SHALL adopt the shared horizontal tab-strip class, so
// its tab labels lay out horizontally; WHEN qf-11 lands THE tab semantics SHALL be unchanged
// (LB/RB switching, the active-tab indicator and the nav-tab roles stay as shipped: CSS-only
// reshaping plus class attachment, no new tab component).
//
// ORACLE. The REAL styles.css is injected into happy-dom and the strip is read through
// getComputedStyle. happy-dom caches computed style per element, so each read is a fresh shallow
// clone (same classes, same parent), taken after the state change under test. With the class the
// clone is a flex row; the sanity probe drops the class from a clone and must not be one, which
// proves the class (not a default) is the cause. Before this slice `#bag-tabs` was a plain div
// (computed display `block`), so every pocket label stacked on its own line.
// =============================================================================

const QF11_STYLES_CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
  'utf8',
);
const QF11_STRIP_CLASS = 'mr-frame-tabstrip';

interface Qf11Snapshot {
  readonly display: string;
  readonly flexDirection: string;
  readonly flexBasis: string;
  readonly maxWidth: string;
  /** flex-grow as a number; NaN (never 0) when happy-dom exposes neither the longhand nor the
   *  first token of the shorthand. */
  readonly grow: number;
}

/** Inline properties that could stretch, stack or freeze a strip. */
const QF11_BANNED_INLINE: readonly string[] = [
  'flex',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'flex-direction',
  'flex-flow',
  'height',
  'block-size',
  'min-height',
  'max-height',
  'width',
  'min-width',
  'max-width',
];

/** The banned layout properties `el` sets inline, read from the style attribute and from the style
 *  object (so `style.flexGrow = '1'`, `style.flex = ...` and cssText are all seen). */
function qf11InlineLayout(el: Element): string[] {
  const found = new Set<string>();
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (QF11_BANNED_INLINE.includes(prop)) found.add(prop);
  }
  const style = (el as HTMLElement).style;
  for (const prop of QF11_BANNED_INLINE) {
    if (style.getPropertyValue(prop) !== '') found.add(prop);
  }
  return [...found];
}

/** The computed layout of a fresh shallow clone of `el` (optionally without the strip class). The
 *  clone KEEPS the id, so an id-keyed rule (C4) would still match it. */
function qf11Probe(el: HTMLElement, dropClass = false): Qf11Snapshot {
  const probe = el.cloneNode(false) as HTMLElement;
  if (dropClass) probe.classList.remove(QF11_STRIP_CLASS);
  (el.parentElement ?? document.body).appendChild(probe);
  const style = getComputedStyle(probe);
  const first = style.flex.trim().split(/\s+/)[0] ?? '';
  let grow = Number.NaN;
  if (style.flexGrow !== '') grow = Number(style.flexGrow);
  else if (first === 'none') grow = 0;
  else if (first !== '') grow = Number(first);
  const snapshot = {
    display: style.display,
    flexDirection: style.flexDirection,
    flexBasis: style.flexBasis,
    maxWidth: style.maxWidth,
    grow,
  };
  probe.remove();
  return snapshot;
}

describe('RaisingView qf-11: the Bag tab strip (QF11.2, QF11.3)', () => {
  let sheet: HTMLStyleElement | null = null;
  beforeEach(() => {
    sheet = document.createElement('style');
    sheet.textContent = QF11_STYLES_CSS;
    document.head.appendChild(sheet);
  });
  afterEach(() => {
    sheet?.remove();
    sheet = null;
  });

  it('#bag-tabs carries mr-frame-tabstrip from construction on and through every show, paint, re-paint, hide and re-show, and it is the only strip in the raising root [QF11-2-BAG-CLASS]', () => {
    // WRONG IMPL KILLED: the shipped plain `part()` div (no class); the class added only in show()
    // or only in the first paint (missing at construction, or lost on the next state); a
    // renderTabs-style className assignment that wipes the class on every paint; a hide() that
    // resets the class; the class put on the root or on every bag part (the item list would lay out
    // as a row) instead of on the tab container alone.
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    const strip = ctl8fPart('bag-tabs');
    const expectAdopted = (when: string): void => {
      expect(ctl8fPart('bag-tabs'), `${when}: still the same node`).toBe(strip);
      expect(strip.classList.contains(QF11_STRIP_CLASS), `${when}: carries the strip class`).toBe(
        true,
      );
      expect(
        [...root.querySelectorAll(`.${QF11_STRIP_CLASS}`)].map((e) => e.id),
        `${when}: #bag-tabs is the only tab strip in the root`,
      ).toEqual(['bag-tabs']);
      expect(root.classList.contains(QF11_STRIP_CLASS), `${when}: not the root`).toBe(false);
    };

    expectAdopted('constructed');
    view.show();
    expectAdopted('shown');
    view.refresh(raTrainVm());
    expectAdopted('refreshed');
    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm));
    expect(strip.style.display, 'precondition: the strip is shown by the paint').not.toBe('none');
    expect(strip.children.length, 'precondition: four pocket tabs rendered').toBe(4);
    expectAdopted('painted');
    view.paint(ctl8fPaint(vm, { nav: ctl8fNav(vm, ['RB']) }));
    expectAdopted('re-painted on Food');
    view.paint(
      ctl8fPaint(vm, {
        nav: ctl8fNav(vm, ['RB']),
        phase: { kind: 'sheet', itemId: 9, action: 'feed' },
      }),
    );
    expectAdopted('painted in the sheet phase');
    view.hide();
    expect(strip.style.display, 'precondition: hide() hides the strip').toBe('none');
    expectAdopted('hidden');
    view.show();
    expectAdopted('re-shown');
    view.paint(ctl8fPaint(vm));
    expectAdopted('painted after the re-show');
  });

  it('#bag-tabs computes as a horizontal flex row that does not grow in the frame column after every state change, and loses that without the class [QF11-2-BAG-HORIZONTAL]', () => {
    // WRONG IMPL KILLED: the shipped plain div (computed display block: the pocket labels stack
    // vertically); a class added to the element but a sheet that gives it no flex layout; a
    // flex-direction: column strip; a strip that still grows vertically in the `.mr-frame` column
    // (grow 1); a layout that holds only on the first paint (the probes run after a tab switch and
    // after a hide / show / paint); a harness whose sheet install is a no-op (the class-less probe
    // must differ).
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm));
    const strip = ctl8fPart('bag-tabs');
    expect(strip.children.length, 'ANTI-VACUITY: four pocket tabs rendered').toBe(4);
    expect(root.style.display, 'ANTI-VACUITY: the frame root is shown').toBe('flex');

    const expectRow = (when: string): void => {
      const now = qf11Probe(strip);
      expect(now.display, `${when}: a flex container`).toBe('flex');
      expect(now.flexDirection, `${when}: not a column`).not.toBe('column');
      expect(now.grow, `${when}: flex-grow`).toBe(0);
      // WRONG IMPL KILLED: C1 `flex: 0 1 100%` (a basis that fills the column; the probe keeps the
      // id so an id-keyed rule, C4, would also be seen); C9 an inline flex-grow / flex / height /
      // flex-direction written by the view (the probe is a clone, so the live strip is checked too).
      expect(now.flexBasis, `${when}: no length or percentage basis`).not.toMatch(/[\d%]/);
      expect(qf11InlineLayout(strip), `${when}: no inline layout style on the strip`).toEqual([]);
      expect(strip.style.flexGrow, `${when}: no inline flex-grow`).toBe('');
    };
    expectRow('painted');
    view.paint(ctl8fPaint(vm, { nav: ctl8fNav(vm, ['RB', 'RB']) }));
    expectRow('after switching pocket');
    view.hide();
    view.show();
    view.paint(ctl8fPaint(vm));
    expectRow('after hide, show and paint');

    expect(
      qf11Probe(strip, true).display,
      'SANITY: without the class it is not a flex row',
    ).not.toBe('flex');
  });

  it('#bag-tabs computes max-width 100% inside the align-items:center column root, so a nowrap strip scrolls inside the frame instead of overflowing it [QF11-2-BAG-MAXWIDTH]', () => {
    // WRONG IMPL KILLED: the reviewer finding (RED until the strip rule gains `max-width: 100%`):
    // the Bag root is `align-items: center` column, so a flex item with `white-space: nowrap` tabs is
    // fit-content wide and, with four pockets in a narrow frame, wider than the frame (the
    // `overflow-x: auto` never engages because the strip itself grows to its content); a max-width
    // set on another selector or only inline; a max-width in px / vw (it must follow the frame).
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    view.paint(ctl8fPaint(ctl8fVm()));
    expect(root.style.alignItems, 'ANTI-VACUITY: the root centres its items').toBe('center');
    const strip = ctl8fPart('bag-tabs');
    expect(strip.children.length, 'ANTI-VACUITY: four pocket tabs rendered').toBe(4);
    expect(qf11Probe(strip).maxWidth, 'computed max-width').toBe('100%');
    expect(qf11Probe(strip, true).maxWidth, 'SANITY: not from a default').not.toBe('100%');
  });

  it('with the strip class adopted, the Bag tab semantics are as shipped: tablist, four role=tab children with the nav ids, exactly one aria-selected tab that is also the is-active one, following LB / RB [QF11-3-BAG-SEMANTICS]', () => {
    // WRONG IMPL KILLED: a new tab component or wrapper (the strip would hold something other than
    // the four tabs, or lose the tablist role); the roles or `aria-selected` dropped while
    // reshaping; an active mark that is colour-only (`is-active` without aria-selected, or the
    // reverse); two selected tabs; the selection not following LB / RB; tabs turned into tab stops
    // (the nav container stays the only one); the class adopted by replacing the tab container, which
    // loses these; and the class absent (the QF11.2 half this block ties the semantics to).
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    const keys = ['bait', 'food', 'medicine', 'other'];
    const walk: ReadonlyArray<readonly [string, readonly VButton[]]> = [
      ['bait', []],
      ['food', ['RB']],
      ['medicine', ['RB', 'RB']],
      ['other', ['RB', 'RB', 'RB']],
      ['medicine', ['RB', 'RB', 'RB', 'LB']],
      ['food', ['RB', 'RB', 'RB', 'LB', 'LB']],
      ['bait', ['RB', 'LB']],
    ];
    for (const [expected, steps] of walk) {
      const when = `${expected} after ${steps.join(',') || 'opening'}`;
      view.paint(ctl8fPaint(vm, { nav: ctl8fNav(vm, steps) }));
      const strip = ctl8fPart('bag-tabs');
      const tabs = ctl8fTabEls();
      expect(strip.classList.contains(QF11_STRIP_CLASS), `${when}: strip class`).toBe(true);
      expect(strip.getAttribute('role'), `${when}: tablist`).toBe('tablist');
      expect([...strip.children], `${when}: the strip holds only the tabs`).toEqual(tabs);
      expect(
        tabs.map((tab) => tab.dataset.navTab),
        `${when}: the four pockets in order`,
      ).toEqual(keys);
      expect(
        tabs.map((tab) => [tab.getAttribute('role'), tab.id, tab.hasAttribute('tabindex')]),
        `${when}: role=tab, nav ids, never a tab stop`,
      ).toEqual(keys.map((key) => ['tab', `bag-tab-${key}`, false]));
      expect(
        tabs
          .filter((tab) => tab.getAttribute('aria-selected') === 'true')
          .map((x) => x.dataset.navTab),
        `${when}: exactly one aria-selected tab`,
      ).toEqual([expected]);
      expect(
        tabs.filter((tab) => tab.classList.contains('is-active')).map((x) => x.dataset.navTab),
        `${when}: the is-active tab is the selected one`,
      ).toEqual([expected]);
    }
  });
});
