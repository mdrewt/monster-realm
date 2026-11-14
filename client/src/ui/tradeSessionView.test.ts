// @vitest-environment happy-dom
// ui/tradeSessionView.test.ts — ts-3 (ts-3.2, ts-3.3, ts-3.4): the trade session editor's DOM shell.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-trade-sessions.spec.md §ts-3 and
//   memory/projects/monster-realm-ts-3-plan.md §Contracts › `ui/tradeSessionView.ts` + §i18n.
//
// RED REASON: client/src/ui/tradeSessionView.ts and ui/tradeSessionModel.ts do not exist yet
//   (module-not-found); the `tradeSession.*` catalog keys and the `tradeSessionView` overlay id are
//   added by this slice.
//
// The view paints what the adapter hands it (`TradeSessionPaint`): it owns no draft and no lock.
// Every paint here is built from the REAL model (`buildTradeSessionVm`, `editorRows`), and every
// expected string is resolved through the real resolver from its catalog id (the tradeView.test.ts
// idiom), never hand-typed English.
//
// The shell is index.html's `#tradepropose-overlay` (the smoke test pins its five static children;
// the view adopts the root, removes the four static wizard controls once at construction, builds
// the `tradesession-*` parts before the kept static `#tradepropose-submit` button, which becomes
// the always-enabled Close button and the registry's focus anchor).
//
// RED REASON (ts-3.4 Close-button revision): `TradeSessionViewDeps.onClose` does not exist yet
//   (a type error on every `new TradeSessionView({ announce, onClose })`), and the view still
//   empties the shell, so `#tradepropose-submit` is gone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreMonsterPub, StoreTradeSession } from '../net/store';
import { setLocale, t, tf } from './i18n/resolver';
import { navItemId } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_IDS } from './overlayRegistry';
import {
  buildTradeSessionVm,
  editorRows,
  type TradeOfferDraft,
  type TradeSessionInput,
  type TradeSessionVm,
} from './tradeSessionModel';
import { type TradeSessionPaint, TradeSessionView } from './tradeSessionView';

vi.mock('./overlayA11y', { spy: true });

async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
});

/** index.html's static shell, byte-for-byte in shape (ids, roles, hidden). */
function mountShell(): HTMLElement {
  document.body.innerHTML = `
    <div id="tradepropose-overlay" class="mr-frame mr-shell" role="dialog" aria-modal="true" style="display:none">
      <select id="tradepropose-target" data-testid="tradepropose-target"></select>
      <div id="tradepropose-monsters" data-testid="tradepropose-monsters"></div>
      <input id="tradepropose-offer-currency" data-testid="tradepropose-offer-currency" type="number" min="0" />
      <input id="tradepropose-request-currency" data-testid="tradepropose-request-currency" type="number" min="0" />
      <button id="tradepropose-submit" data-testid="tradepropose-submit" type="button"></button>
    </div>
  `;
  return document.getElementById('tradepropose-overlay') as HTMLElement;
}

const ME = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const REV = 9_007_199_254_740_993n;

function mon(monsterId: bigint, partySlot: number, nickname: string, currentHp = 20) {
  return {
    monsterId,
    ownerIdentity: ME,
    speciesId: 1,
    nickname,
    level: 5,
    currentHp,
    statHp: 20,
    partySlot,
  } as unknown as StoreMonsterPub;
}

/** ME opened session 101 with Bob. ME's side: monster 21, item 3 ×1, 50 coins (unconfirmed);
 *  Bob's side: monster 91, item 5 ×4, nothing else, CONFIRMED. */
function sess(over: Partial<StoreTradeSession> = {}): StoreTradeSession {
  return {
    sessionId: 101n,
    opener: ME,
    partner: BOB,
    openerOffer: {
      monsterIds: [21n],
      items: [{ itemId: 3, qty: 1 }],
      currency: 50n,
      cards: [
        { monsterId: 21n, speciesId: 1, nickname: 'Ash', level: 5, currentHp: 20, statHp: 20 },
      ],
    },
    partnerOffer: {
      monsterIds: [91n],
      items: [{ itemId: 5, qty: 4 }],
      currency: 0n,
      cards: [{ monsterId: 91n, speciesId: 2, nickname: 'Zed', level: 7, currentHp: 9, statHp: 9 }],
    },
    openerConfirmed: false,
    partnerConfirmed: true,
    revision: REV,
    createdAtMs: 1_000n,
    ...over,
  };
}

function itemDef(id: number, name: string) {
  return {
    id,
    name,
    description: '',
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    cureStatus: null,
  };
}

function vmOf(row: StoreTradeSession = sess(), over: Partial<TradeSessionInput> = {}) {
  const vm = buildTradeSessionVm({
    sessions: [row],
    identity: ME,
    sessionId: row.sessionId,
    players: [{ identity: BOB, entityId: 2n, name: 'Bob', online: true }],
    ownMonsters: [mon(21n, 0, 'Ash'), mon(22n, 1, 'Bry', 0), mon(23n, 2, 'Cyd')],
    speciesMap: new Map([
      [1, { name: 'Sprout' }],
      [2, { name: 'Flare' }],
    ]),
    itemDefs: new Map([
      [3, itemDef(3, 'Potion')],
      [5, itemDef(5, 'Ether')],
    ]),
    inventory: [{ invId: 1n, ownerIdentity: ME, itemId: 3, count: 4 }],
    balance: 900n,
    battleMonsterIds: new Set(),
    partySize: 3,
    maxMonstersPerSide: 1,
    ...over,
  });
  if (vm.kind !== 'session') throw new Error('fixture: a session vm');
  return vm;
}

function paintOf(
  vm: TradeSessionVm,
  over: Partial<Omit<TradeSessionPaint, 'vm'>> & { draft?: TradeOfferDraft } = {},
): TradeSessionPaint {
  const draft = over.draft ?? vm.offer;
  const rows = over.rows ?? editorRows(vm, draft);
  return {
    vm,
    rows,
    draft,
    cursor: over.cursor ?? rows[0]?.key ?? null,
    notice: over.notice ?? 0,
    prompt: over.prompt ?? null,
  };
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} must be in the document`);
  return el;
}

const rowEl = (key: string): HTMLElement => byId(navItemId('tradeSession', null, key));

function makeView(): {
  root: HTMLElement;
  view: TradeSessionView;
  announce: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const root = mountShell();
  const announce = vi.fn();
  const onClose = vi.fn();
  const view = new TradeSessionView({ announce, onClose });
  return { root, view, announce, onClose };
}

const NATIVE = 'button, input, select, textarea, a[href]';

function closeButton(): HTMLButtonElement {
  const el = byId('tradepropose-submit');
  if (!(el instanceof HTMLButtonElement)) throw new Error('#tradepropose-submit must be a button');
  return el;
}

const GONE_PAINT: TradeSessionPaint = {
  vm: { kind: 'gone' },
  rows: [],
  draft: { monsterIds: [], items: [], currency: 0n },
  cursor: null,
  notice: 0,
  prompt: null,
};

describe('TradeSessionView — the shell (ts-3.2)', () => {
  it('ts-3.2 ts-3.4 the constructor throws without #tradepropose-overlay or its #tradepropose-submit, removes the other four static controls ONCE, keeps the button as the root`s LAST child and builds the tradesession-* parts (each id also its data-testid); a node adopted into the root later survives every paint', () => {
    // WRONG IMPL KILLED: a view that keeps the wizard's static controls (a mouse-only select and
    // inputs inside the editor); one that empties the whole shell (the registry's static anchor
    // `#tradepropose-submit` is gone, the smoke test's focus contract breaks); parts appended
    // AFTER the button; parts without a data-testid (the e2e would not find them); a paint that
    // empties the root again (the toast live region adopted into an open dialog root would be
    // torn out on every batch); a silent no-op on a missing shell or a missing button.
    expect(
      () => new TradeSessionView({ announce: () => {}, onClose: () => {} }),
      'no shell',
    ).toThrow();
    mountShell().querySelector('#tradepropose-submit')?.remove();
    expect(
      () => new TradeSessionView({ announce: () => {}, onClose: () => {} }),
      'a shell without its #tradepropose-submit',
    ).toThrow();
    document.body.innerHTML = '';
    const { root, view } = makeView();
    for (const id of [
      'tradepropose-target',
      'tradepropose-monsters',
      'tradepropose-offer-currency',
      'tradepropose-request-currency',
    ]) {
      expect(document.getElementById(id), `#${id} is removed`).toBeNull();
    }
    expect(root.querySelectorAll('select, input').length, 'no wizard control left').toBe(0);
    const button = byId('tradepropose-submit');
    expect(root.contains(button), 'the Close button stays in the root').toBe(true);
    expect(button.tagName).toBe('BUTTON');
    expect(root.lastElementChild, 'the button is the root`s last element child').toBe(button);
    for (const id of [
      'tradesession-title',
      'tradesession-notice',
      'tradesession-mine',
      'tradesession-theirs',
      'tradesession-rows',
      'tradesession-prompt',
      'tradesession-prompt-text',
      'tradesession-confirm',
    ]) {
      const el = byId(id);
      expect(root.contains(el), `#${id} is in the root`).toBe(true);
      expect(el.dataset.testid, `#${id}'s data-testid`).toBe(id);
      expect(
        el.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
        `#${id} is built before the Close button`,
      ).not.toBe(0);
    }
    expect(byId('tradesession-title').tagName).toBe('H2');
    const adopted = document.createElement('div');
    adopted.id = 'adopted-live-region';
    root.appendChild(adopted);
    view.paint(paintOf(vmOf()));
    view.paint(paintOf(vmOf(sess({ revision: REV + 1n }))));
    expect(adopted.parentElement, 'the adopted node survives the paints').toBe(root);
  });

  it('ts-3.4 the ONLY native control in the editor is the Close button: every row and every answer is a listbox option the D-pad drives (no mouse-only element)', () => {
    // WRONG IMPL KILLED: a button or an input per row or per answer (a pointer-only path beside
    // the D-pad); a second static control left behind; a rows container that is not the listbox
    // the router's focus names.
    const { root, view } = makeView();
    view.show();
    view.paint(paintOf(vmOf(), { prompt: { action: 'confirm', yes: false } }));
    expect([...root.querySelectorAll(NATIVE)]).toEqual([closeButton()]);
    expect(byId('tradesession-rows').getAttribute('role')).toBe('listbox');
    expect(byId('tradesession-confirm').getAttribute('role')).toBe('listbox');
    const options = (id: string) =>
      [...byId(id).querySelectorAll<HTMLElement>('[data-nav-key]')].map((el) =>
        el.getAttribute('role'),
      );
    expect(options('tradesession-rows').length, 'fixture: rows painted').toBeGreaterThan(0);
    expect(new Set(options('tradesession-rows'))).toEqual(new Set(['option']));
    expect(options('tradesession-confirm')).toEqual(['option', 'option']);
  });
});

describe('TradeSessionView — the Close button (ts-3.4)', () => {
  it('ts-3.4 the Close button reads kit.sheet.close after show(); a click calls onClose exactly once and nothing else', () => {
    // WRONG IMPL KILLED: a dead button (no listener); a button that announces or double-fires
    // onClose (a stacked listener per show()); an unlabelled or hand-typed-English button.
    const { view, announce, onClose } = makeView();
    view.show();
    view.show();
    view.paint(paintOf(vmOf()));
    const button = closeButton();
    expect(button.textContent).toBe(t('kit.sheet.close'));
    expect(onClose).not.toHaveBeenCalled();
    button.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
    view.hide();
    view.show();
    expect(button.textContent, 'written again at the next show()').toBe(t('kit.sheet.close'));
    button.click();
    expect(onClose, 'one call per click across a re-open').toHaveBeenCalledTimes(2);
  });

  it('ts-3.4 a keydown on the Close button keeps only ITS keys (Enter, NumpadEnter, Space never reach window); arrows, letters and Escape DO reach window', () => {
    // REVISED (contract D, from the spec): the button owns only its activation keys; the D-pad, B
    // and Start must keep working while it has focus. Was: arrows and letters were asserted
    // swallowed too, which is the defect (a player Tabbed onto Close had no D-pad, no B).
    // RED REASON: today every key but Escape is stopped at the button.
    // WRONG IMPL KILLED: a button whose Enter / NumpadEnter / Space also reaches the router's
    // window keydown (one press would both close and press A on the editor); a stopPropagation
    // that eats every other key (arrows, B, Start dead on the button); one that eats Escape.
    const { view } = makeView();
    view.show();
    view.paint(paintOf(vmOf()));
    const button = closeButton();
    const seen: string[] = [];
    const listener = (e: KeyboardEvent) => {
      seen.push(e.code);
    };
    window.addEventListener('keydown', listener);
    const down = (key: string, code: string) => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
    };
    try {
      down('Enter', 'Enter');
      down('Enter', 'NumpadEnter');
      down(' ', 'Space');
      expect(seen, 'the button`s own keys stay on the button').toEqual([]);
      const through: ReadonlyArray<readonly [string, string]> = [
        ['ArrowDown', 'ArrowDown'],
        ['ArrowUp', 'ArrowUp'],
        ['ArrowLeft', 'ArrowLeft'],
        ['ArrowRight', 'ArrowRight'],
        ['a', 'KeyA'],
        ['b', 'KeyB'],
        ['Backspace', 'Backspace'],
        ['Escape', 'Escape'],
      ];
      for (const [key, code] of through) down(key, code);
      expect(seen, 'every other key reaches window').toEqual(through.map(([, code]) => code));
    } finally {
      window.removeEventListener('keydown', listener);
    }
  });

  it('ts-3.4 the Close button is live in every painted state: never disabled, never hidden, never display:none, always in the root', () => {
    // WRONG IMPL KILLED: a Close button disabled while a prompt is open or a side is confirmed
    // (the registry anchor would be inert, Tab escapes the trap); a button hidden on a gone
    // paint; a paint that removes or re-parents it; a root painted display:none while shown.
    const { root, view } = makeView();
    view.show();
    const button = closeButton();
    const states: readonly [string, TradeSessionPaint][] = [
      ['a normal session', paintOf(vmOf())],
      ['a confirmed side', paintOf(vmOf(sess({ openerConfirmed: true })))],
      ['a prompt open', paintOf(vmOf(), { prompt: { action: 'cancel', yes: false } })],
      ['a raised notice', paintOf(vmOf(sess({ revision: REV + 1n })), { notice: 1 })],
      ['a gone vm', GONE_PAINT],
    ];
    for (const [name, p] of states) {
      view.paint(p);
      expect(button.disabled, `${name}: not disabled`).toBe(false);
      expect(button.hasAttribute('disabled'), `${name}: no disabled attribute`).toBe(false);
      expect(button.hidden, `${name}: not hidden`).toBe(false);
      expect(button.style.display, `${name}: the button's display`).not.toBe('none');
      expect(root.style.display, `${name}: the root's display`).not.toBe('none');
      expect(root.contains(button), `${name}: in the root`).toBe(true);
      expect(byId('tradepropose-submit'), `${name}: the same node`).toBe(button);
    }
  });

  it('ts-3.4 focus at open: the first session paint after show() focuses #tradesession-rows; later paints never move focus; a gone paint does not consume the one-shot', () => {
    // WRONG IMPL KILLED: no focus at open (the D-pad player starts outside the list); a focus on
    // every paint (a batch would yank focus off the Close button); a one-shot never re-armed by
    // show(); a gone paint that spends the one-shot (the next real session paint would leave
    // focus wherever it was).
    const { root, view } = makeView();
    expect(root.parentElement, 'fixture: attached').toBe(document.body);
    view.show();
    expect(root.style.display, 'fixture: displayed after show()').not.toBe('none');
    const rows = byId('tradesession-rows');
    const button = closeButton();
    view.paint(paintOf(vmOf()));
    expect(document.activeElement, 'the first paint focuses the rows').toBe(rows);

    // REVISED (contract D, from the spec): after a paint a programmatic focus of the button is
    // handed on to the rows; the player reaches it by Tab. Was: a bare `button.focus()`.
    rows.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }));
    button.focus();
    expect(document.activeElement, 'fixture: the button takes focus after a Tab').toBe(button);
    view.paint(paintOf(vmOf(sess({ revision: REV + 1n }))));
    expect(document.activeElement, 'a later paint keeps focus on the button').toBe(button);

    view.hide();
    view.show();
    button.focus();
    expect(document.activeElement, 'fixture: the button takes focus again').toBe(button);
    view.paint(GONE_PAINT);
    expect(document.activeElement, 'a gone paint does not move focus').toBe(button);
    view.paint(paintOf(vmOf()));
    expect(document.activeElement, 'the one-shot survived the gone paint').toBe(rows);
  });

  it('ts-3.4 (contract D) once a session is painted, a PROGRAMMATIC focus of the Close button (no Tab, no pointerdown before it) is handed on to #tradesession-rows, from the rows and from outside the dialog', () => {
    // RED REASON: today nothing watches the button's focus: a stray focus() (a frame beneath
    // resuming, the a11y layer's anchor) strands the player on Close, where A closes the editor.
    // WRONG IMPL KILLED: no hand-on; a hand-on to <body> or to the prompt instead of the rows; a
    // hand-on only when focus came from inside the dialog.
    const { root, view } = makeView();
    expect(root.parentElement, 'fixture: attached').toBe(document.body);
    view.show();
    view.paint(paintOf(vmOf()));
    const rows = byId('tradesession-rows');
    const button = closeButton();
    expect(document.activeElement, 'fixture: the rows have focus').toBe(rows);
    button.focus();
    expect(document.activeElement, 'a programmatic focus is handed on to the rows').toBe(rows);

    const outside = document.createElement('button');
    outside.id = 'outside-control';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement, 'fixture: focus left the dialog').toBe(outside);
    button.focus();
    expect(document.activeElement, 'from outside too: handed on to the rows').toBe(rows);
    view.paint(paintOf(vmOf(sess({ revision: REV + 1n }))));
    button.focus();
    expect(document.activeElement, 'and after a later paint').toBe(rows);
  });

  it.each([
    ['a Tab keydown on the rows (inside the dialog root)', 'tab'],
    ['a pointerdown on the button', 'pointer'],
  ] as const)('ts-3.4 (contract D) after %s, the next focus of the Close button stays on it', (_label, how) => {
    // RED REASON: none today (the button keeps any focus); paired with the hand-on case above, it
    // kills a hand-on that also fires for the player's own Tab or click.
    // WRONG IMPL KILLED: a hand-on that ignores how focus arrived (the player could never Tab or
    // click onto Close); a Tab honoured only when dispatched on the button itself.
    const { view } = makeView();
    view.show();
    view.paint(paintOf(vmOf()));
    const rows = byId('tradesession-rows');
    const button = closeButton();
    expect(document.activeElement, 'fixture: the rows have focus').toBe(rows);
    if (how === 'tab') {
      rows.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }));
    } else {
      button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    }
    button.focus();
    expect(document.activeElement, 'the player`s own move: on the button').toBe(button);
  });

  it('ts-3.4 (contract D) before any session paint, a programmatic focus of the Close button stays on it, and the a11y layer`s deferred anchor focus lands on it', async () => {
    // RED REASON: guards the hand-on above against over-reach (green today; red for an impl that
    // hands on before the editor has anything painted).
    // WRONG IMPL KILLED: a hand-on armed by show() instead of by a paint (the registry's anchor
    // focus would be pushed onto an empty listbox, and the focus trap's one target lost); a gone
    // paint counted as a session paint.
    const { view } = makeView();
    view.show();
    const button = closeButton();
    await flushMacrotask();
    expect(document.activeElement, 'the deferred anchor focus lands on the button').toBe(button);
    byId('tradesession-rows').focus();
    button.focus();
    expect(document.activeElement, 'shown, never painted: the focus stays').toBe(button);
    view.paint(GONE_PAINT);
    byId('tradesession-rows').focus();
    button.focus();
    expect(document.activeElement, 'a gone paint is not a session paint').toBe(button);
  });
});

describe('TradeSessionView — both sides and the marks (ts-3.2)', () => {
  it('ts-3.2 paints the title, both sides (heading, mark word and data-confirmed, monster cards, item lines, coins or the one "nothing" line) and the root`s data-session-id and decimal data-revision', () => {
    // WRONG IMPL KILLED: the sides swapped; a mark painted from the wrong side or only by colour
    // (no data-confirmed, no word); the revision written through Number (…993 reads …992);
    // an empty side painted blank; hand-typed English.
    const { root, view } = makeView();
    view.paint(paintOf(vmOf()));
    expect(byId('tradesession-title').textContent).toBe(tf('tradeSession.title', { name: 'Bob' }));
    expect(root.dataset.sessionId).toBe('101');
    expect(root.dataset.revision, 'decimal, exact past 2^53').toBe('9007199254740993');

    const mine = byId('tradesession-mine');
    const theirs = byId('tradesession-theirs');
    expect(mine.querySelector('h3')?.textContent).toBe(t('tradeSession.side.mine'));
    expect(theirs.querySelector('h3')?.textContent).toBe(t('tradeSession.side.theirs'));
    const mark = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-part="mark"]');
    expect(mark(mine)?.dataset.confirmed).toBe('false');
    expect(mark(mine)?.textContent).toBe(t('tradeSession.mark.unconfirmed'));
    expect(mark(theirs)?.dataset.confirmed).toBe('true');
    expect(mark(theirs)?.textContent).toBe(t('tradeSession.mark.confirmed'));

    const ids = (el: HTMLElement, sel: string, attr: string) =>
      [...el.querySelectorAll<HTMLElement>(sel)].map((n) => n.getAttribute(attr));
    expect(
      ids(mine, 'ul[data-section="monsters"] > li[data-monster-id]', 'data-monster-id'),
    ).toEqual(['21']);
    expect(mine.querySelector('li[data-monster-id="21"]')?.textContent).toContain('Ash');
    expect(ids(mine, 'ul[data-section="items"] > li[data-item-id]', 'data-item-id')).toEqual(['3']);
    expect(mine.querySelector('li[data-item-id="3"]')?.textContent).toContain('Potion');
    expect(mine.querySelector('p[data-currency]')?.getAttribute('data-currency')).toBe('50');
    expect(ids(theirs, 'li[data-monster-id]', 'data-monster-id')).toEqual(['91']);
    expect(theirs.querySelector('li[data-item-id="5"]')?.textContent).toContain('Ether');

    // A repaint with the marks flipped and Bob's side emptied.
    view.paint(
      paintOf(
        vmOf(
          sess({
            openerConfirmed: true,
            partnerConfirmed: false,
            partnerOffer: { monsterIds: [], items: [], currency: 0n, cards: [] },
          }),
        ),
      ),
    );
    expect(mark(mine)?.dataset.confirmed).toBe('true');
    expect(mark(theirs)?.dataset.confirmed).toBe('false');
    expect(theirs.querySelectorAll('li').length, 'no stale card or item').toBe(0);
    expect(theirs.textContent, 'one nothing line').toContain(t('trade.side.nothing'));
    expect(theirs.textContent?.split(t('trade.side.nothing')).length).toBe(2);
  });

  it('ts-3.2 paints the picker rows in order with their text: aria-checked="true" on an offered monster and REMOVED otherwise across paints, a blocked or capped monster`s reason, the item and coin lines, a disabled action`s reason; the cursor row is selected', () => {
    // WRONG IMPL KILLED: aria-checked written "false" or left stale after the monster is taken out
    // (a screen reader would still read it as offered); a disabled row with no reason in its
    // text (the player cannot learn why); the item line showing the stored quantity instead of
    // the draft's; rows in another order; no cursor mark.
    const { view } = makeView();
    const vm = vmOf();
    view.paint(paintOf(vm, { cursor: 'monster-23' }));
    const keys = [...byId('tradesession-rows').querySelectorAll<HTMLElement>('[data-nav-key]')].map(
      (el) => el.dataset.navKey,
    );
    expect(keys).toEqual(editorRows(vm, vm.offer).map((r) => r.key));
    expect(rowEl('monster-21').getAttribute('aria-checked'), 'offered').toBe('true');
    expect(rowEl('monster-23').hasAttribute('aria-checked'), 'not offered').toBe(false);
    // REVISED (contract A, from the spec): a monster row's own words are the model's bare label and
    // the catalog's level text (`tactics.hud.level`), and a disabled row wraps THAT composed text.
    // Was: the model's label alone, which carried a hard-coded English ` Lv.<n>`.
    const words = (id: bigint): string => {
      const m = vm.monsters.find((x) => x.monsterId === id);
      if (m === undefined) throw new Error(`fixture: monster ${id} is in the picker`);
      return `${m.label} ${tf('tactics.hud.level', { level: m.level })}`;
    };
    expect(rowEl('monster-21').textContent, 'an offered row: its composed words').toBe(words(21n));
    expect(words(21n), 'fixture: the composed words name the monster').toContain('Ash');
    const bry = vm.monsters.find((m) => m.monsterId === 22n);
    expect(bry?.blocked, 'fixture: 22 fainted').toBe('fainted');
    expect(rowEl('monster-22').textContent).toBe(
      tf('tradeSession.row.blocked', {
        label: words(22n),
        reason: t('tradeSession.reason.fainted'),
      }),
    );
    expect(rowEl('monster-23').textContent, 'at the cap of 1').toBe(
      tf('tradeSession.row.blocked', {
        label: words(23n),
        reason: t('tradeSession.reason.limit'),
      }),
    );
    expect(rowEl('item-3').textContent).toBe(
      tf('tradeSession.row.item', { name: 'Potion', qty: 1, held: 4 }),
    );
    expect(rowEl('coins').textContent).toBe(
      tf('tradeSession.row.coins', { amount: 50n, balance: 900n }),
    );
    expect(rowEl('apply').textContent).toContain(t('tradeSession.reason.nothingToSend'));
    expect(rowEl('confirm').textContent).toContain(t('tradeSession.row.confirm'));
    expect(rowEl('cancel').textContent).toBe(t('tradeSession.row.cancel'));
    expect(rowEl('monster-23').getAttribute('aria-selected'), 'the cursor').toBe('true');
    expect(rowEl('monster-21').getAttribute('aria-selected')).toBe('false');

    // The draft takes 21 out and adds 23, two items and 75 coins: the marks and lines follow.
    const draft: TradeOfferDraft = {
      monsterIds: [23n],
      items: [{ itemId: 3, qty: 2 }],
      currency: 75n,
    };
    view.paint(paintOf(vm, { draft }));
    expect(rowEl('monster-21').hasAttribute('aria-checked'), 'taken out: removed').toBe(false);
    expect(rowEl('monster-23').getAttribute('aria-checked')).toBe('true');
    expect(rowEl('item-3').textContent).toBe(
      tf('tradeSession.row.item', { name: 'Potion', qty: 2, held: 4 }),
    );
    expect(rowEl('coins').textContent).toBe(
      tf('tradeSession.row.coins', { amount: 75n, balance: 900n }),
    );
    expect(rowEl('apply').textContent).toBe(t('tradeSession.row.apply'));
    expect(rowEl('confirm').textContent).toContain(t('tradeSession.reason.unsent'));
  });

  it('ts-3.2 (contract A) in another locale a monster row`s level reads the catalog`s words (fr), never the English "Lv.", in an offered and in a blocked row', () => {
    // RED REASON: today the level is the model's hard-coded English ` Lv.<n>` inside the label.
    // WRONG IMPL KILLED: a view that composes `${label} Lv.${level}` itself (it passes in en and
    // ships English to every other locale); a blocked row that wraps the bare label (no level).
    const vm = vmOf();
    setLocale('fr');
    try {
      const { view } = makeView();
      view.paint(paintOf(vm));
      const ash = vm.monsters.find((m) => m.monsterId === 21n);
      const bry = vm.monsters.find((m) => m.monsterId === 22n);
      if (ash === undefined || bry === undefined) throw new Error('fixture: 21 and 22');
      const frLevel = tf('tactics.hud.level', { level: ash.level });
      expect(frLevel, 'fixture: fr has its own level words').not.toContain('Lv.');
      expect(rowEl('monster-21').textContent).toBe(`${ash.label} ${frLevel}`);
      expect(rowEl('monster-22').textContent).toBe(
        tf('tradeSession.row.blocked', {
          label: `${bry.label} ${tf('tactics.hud.level', { level: bry.level })}`,
          reason: t('tradeSession.reason.fainted'),
        }),
      );
      expect(byId('tradesession-rows').textContent, 'no English level anywhere').not.toContain(
        'Lv.',
      );
    } finally {
      setLocale('en');
    }
  });

  it('ts-3.2 a confirmed side paints Cancel as the only row; a gone paint leaves the last session shown', () => {
    // WRONG IMPL KILLED: stale edit rows left under a confirmed side; a gone paint that blanks the
    // editor (the frame is closed through the stack; a blank flash would read as a lost trade).
    const { root, view } = makeView();
    const confirmed = vmOf(sess({ openerConfirmed: true }));
    view.paint(paintOf(confirmed));
    expect(
      [...byId('tradesession-rows').querySelectorAll<HTMLElement>('[data-nav-key]')].map(
        (el) => el.dataset.navKey,
      ),
    ).toEqual(['cancel']);
    const title = byId('tradesession-title').textContent;
    view.paint({
      vm: { kind: 'gone' },
      rows: [],
      draft: { monsterIds: [], items: [], currency: 0n },
      cursor: null,
      notice: 0,
      prompt: null,
    });
    expect(root.dataset.sessionId, 'gone: the last session stays').toBe('101');
    expect(byId('tradesession-title').textContent).toBe(title);
  });
});

describe('TradeSessionView — the notice and the prompt (ts-3.3, ts-3.4)', () => {
  it('ts-3.3 #tradesession-notice is hidden and empty at 0, shows the catalogued "offer changed" text when raised, announces ONCE per raise (a repaint of the same count is silent, a second raise announces again), and hide() forgets the count; data-revision follows the vm', () => {
    // WRONG IMPL KILLED: an announce on every paint (a screen reader repeating the line at batch
    // rate); a notice that announces only the first raise; a notice left visible at 0; a view
    // that never forgets, so a reopened editor never announces; a data-revision painted once.
    const { root, view, announce } = makeView();
    view.show();
    const vm = vmOf();
    view.paint(paintOf(vm));
    const notice = byId('tradesession-notice');
    expect(notice.hidden).toBe(true);
    expect(notice.textContent).toBe('');
    expect(announce).not.toHaveBeenCalled();

    const vm1 = vmOf(sess({ revision: REV + 1n, partnerConfirmed: false }));
    view.paint(paintOf(vm1, { notice: 1 }));
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe(t('tradeSession.notice.changed'));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(t('tradeSession.notice.changed'));
    expect(root.dataset.revision).toBe('9007199254740994');
    view.paint(paintOf(vm1, { notice: 1 }));
    expect(announce, 'the same count: silent').toHaveBeenCalledTimes(1);
    view.paint(paintOf(vm1, { notice: 2 }));
    expect(announce, 'a second raise').toHaveBeenCalledTimes(2);
    view.paint(paintOf(vm1, { notice: 0 }));
    expect(notice.hidden).toBe(true);
    expect(notice.textContent).toBe('');

    view.hide();
    view.show();
    view.paint(paintOf(vm1, { notice: 1 }));
    expect(announce, 'hide() forgot the count: announced again').toHaveBeenCalledTimes(3);
  });

  it('ts-3.4 #tradesession-prompt is hidden with no prompt and shows the confirm or cancel question over Yes / No rows with the cursor on the painted answer', () => {
    // WRONG IMPL KILLED: a prompt that opens with Yes marked when `yes` is false (a default Yes
    // over an irreversible trade); the two questions swapped; a stale Yes / No list left under a
    // closed prompt.
    const { view } = makeView();
    const vm = vmOf();
    view.paint(paintOf(vm));
    expect(byId('tradesession-prompt').hidden).toBe(true);
    const answer = (key: 'yes' | 'no') => byId(navItemId('tradeSessionConfirm', null, key));
    for (const [action, yes, text] of [
      // ts-6b-10 (named intentional change): the fixture's own side offers monster 21, so the
      // confirm question is the monsters wording. Was: 'tradeSession.prompt.confirm'.
      ['confirm', false, 'tradeSession.prompt.confirmMonsters'],
      ['confirm', true, 'tradeSession.prompt.confirmMonsters'],
      ['cancel', false, 'tradeSession.prompt.cancel'],
    ] as const) {
      view.paint(paintOf(vm, { prompt: { action, yes } }));
      expect(byId('tradesession-prompt').hidden, `${action}: shown`).toBe(false);
      expect(byId('tradesession-prompt-text').textContent).toBe(t(text));
      expect(answer('yes').getAttribute('aria-selected')).toBe(yes ? 'true' : 'false');
      expect(answer('no').getAttribute('aria-selected')).toBe(yes ? 'false' : 'true');
    }
    view.paint(paintOf(vm));
    expect(byId('tradesession-prompt').hidden).toBe(true);
    expect(byId('tradesession-confirm').querySelectorAll('[data-nav-key]').length).toBe(0);
  });

  it('ts-3.4 (contract B) a prompt that OPENS or changes action announces its question exactly once and moves focus from inside the dialog to #tradesession-confirm; a repaint of the same prompt (the Yes / No flip) does neither', () => {
    // RED REASON: today the prompt is painted silently and focus stays on the rows, so a screen
    // reader user never hears the irreversible question and the answers are not focused.
    // WRONG IMPL KILLED: no announce; an announce on every paint of an open prompt (the question
    // repeated on each Yes / No flip and each batch); an announce of the other action's question;
    // no focus move; a focus move on every repaint (focus yanked back each flip); a change of
    // action (confirm -> cancel) treated as the same prompt.
    const { root, view, announce } = makeView();
    expect(root.parentElement, 'fixture: attached').toBe(document.body);
    view.show();
    const vm = vmOf();
    view.paint(paintOf(vm));
    const rows = byId('tradesession-rows');
    const confirm = byId('tradesession-confirm');
    expect(document.activeElement, 'fixture: the rows have focus').toBe(rows);
    expect(announce, 'fixture: nothing announced yet').not.toHaveBeenCalled();

    view.paint(paintOf(vm, { prompt: { action: 'confirm', yes: false } }));
    // ts-6b-10 (named intentional change): own side offers a monster. Was: prompt.confirm.
    expect(announce.mock.calls, 'the question, once').toEqual([
      [t('tradeSession.prompt.confirmMonsters')],
    ]);
    expect(document.activeElement, 'focus moves to the answers').toBe(confirm);

    rows.focus();
    expect(document.activeElement, 'fixture: focus moved back by hand').toBe(rows);
    view.paint(paintOf(vm, { prompt: { action: 'confirm', yes: true } }));
    view.paint(paintOf(vm, { prompt: { action: 'confirm', yes: true } }));
    expect(announce, 'the flip and a repaint: silent').toHaveBeenCalledTimes(1);
    expect(document.activeElement, 'the flip and a repaint: focus stays').toBe(rows);

    view.paint(paintOf(vm, { prompt: { action: 'cancel', yes: false } }));
    expect(announce.mock.calls, 'a new action: its own question, once').toEqual([
      // ts-6b-10 (named intentional change): own side offers a monster. Was: prompt.confirm.
      [t('tradeSession.prompt.confirmMonsters')],
      [t('tradeSession.prompt.cancel')],
    ]);
    expect(document.activeElement, 'a new action: focus to the answers').toBe(confirm);

    view.paint(paintOf(vm));
    view.paint(paintOf(vm, { prompt: { action: 'cancel', yes: false } }));
    expect(announce, 'closed then opened again: announced again').toHaveBeenCalledTimes(3);
    expect(announce).toHaveBeenLastCalledWith(t('tradeSession.prompt.cancel'));
  });

  it('ts-3.4 (contract B) a prompt opening while focus is OUTSIDE the dialog root is announced but takes no focus', () => {
    // RED REASON: no announce today.
    // WRONG IMPL KILLED: a focus move that pulls focus into the dialog from outside it (from a
    // frame stacked above, or the page); an announce tied to the focus move.
    const { view, announce } = makeView();
    view.show();
    const vm = vmOf();
    view.paint(paintOf(vm));
    const outside = document.createElement('button');
    outside.id = 'outside-control';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement, 'fixture: focus is outside the dialog').toBe(outside);
    view.paint(paintOf(vm, { prompt: { action: 'confirm', yes: false } }));
    // ts-6b-10 (named intentional change): own side offers a monster. Was: prompt.confirm.
    expect(announce.mock.calls).toEqual([[t('tradeSession.prompt.confirmMonsters')]]);
    expect(document.activeElement, 'focus stays where it was').toBe(outside);
  });

  it('the confirm prompt warns of the bond reset only when your offer includes a monster', () => {
    // WRONG IMPL KILLED: today's single confirm wording (no warning at all); a warning keyed on
    // the PARTNER's monsters (Bob offers monster 91 in both cases); a warning on every confirm
    // (a coins-only offer is told its monsters reset); a painted question that disagrees with
    // the announced line; the cancel question changed.
    const noMonsterOffer = {
      monsterIds: [],
      items: [{ itemId: 3, qty: 1 }],
      currency: 50n,
      cards: [],
    };
    const cases = [
      ['own monster', sess(), 'tradeSession.prompt.confirmMonsters'],
      [
        'no own monster, partner offers one',
        sess({ openerOffer: noMonsterOffer }),
        'tradeSession.prompt.confirm',
      ],
    ] as const;
    for (const [label, row, key] of cases) {
      const { view, announce } = makeView();
      const vm = vmOf(row);
      expect(vm.theirs.cards.length, `${label}: fixture: the partner offers a monster`).toBe(1);
      view.show();
      view.paint(paintOf(vm, { prompt: { action: 'confirm', yes: false } }));
      expect(byId('tradesession-prompt-text').textContent, `${label}: painted`).toBe(t(key));
      expect(announce.mock.calls, `${label}: announced`).toEqual([[t(key)]]);
      view.paint(paintOf(vm, { prompt: { action: 'cancel', yes: false } }));
      expect(byId('tradesession-prompt-text').textContent, `${label}: cancel unchanged`).toBe(
        t('tradeSession.prompt.cancel'),
      );
      document.body.innerHTML = '';
    }
    // The warning text itself names the reset and that trading back does not restore it.
    setLocale('en');
    expect(t('tradeSession.prompt.confirmMonsters')).toContain('trust and quality time');
    expect(t('tradeSession.prompt.confirmMonsters')).toContain('even if traded back');
    expect(t('tradeSession.prompt.confirm')).not.toContain('trust');
  });

  it('ts-3.4 (contract B) when the prompt closes with focus inside #tradesession-prompt, focus returns to #tradesession-rows; with focus elsewhere in the dialog it is not moved', () => {
    // RED REASON: none today (the rescue exists); no test pinned it and a mutant deleting it
    // survived the suite.
    // WRONG IMPL KILLED: the rescue deleted (focus is stranded on a hidden node, i.e. <body>,
    // outside the focus trap); a rescue that moves focus on every close wherever it was.
    const { view } = makeView();
    view.show();
    const vm = vmOf();
    view.paint(paintOf(vm, { prompt: { action: 'cancel', yes: false } }));
    const rows = byId('tradesession-rows');
    const confirm = byId('tradesession-confirm');
    confirm.focus();
    expect(document.activeElement, 'fixture: focus is on the answers').toBe(confirm);
    view.paint(paintOf(vm));
    expect(byId('tradesession-prompt').hidden, 'fixture: the prompt closed').toBe(true);
    expect(document.activeElement, 'focus returns to the rows').toBe(rows);

    view.paint(paintOf(vm, { prompt: { action: 'cancel', yes: false } }));
    const button = closeButton();
    rows.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }));
    button.focus();
    expect(document.activeElement, 'fixture: focus on the Close button').toBe(button);
    view.paint(paintOf(vm));
    expect(document.activeElement, 'not inside the prompt: not moved').toBe(button);
  });

  it('ts-3.4 show() opens the dialog on the hidden-to-visible edge only and hide() closes it unguarded', () => {
    // WRONG IMPL KILLED: a show that re-opens on every call (the deferred focus would yank the
    // cursor back each batch); a guarded hide (a desynchronised trap could never heal).
    const { root, view } = makeView();
    expect(view.visible).toBe(false);
    view.show();
    view.show();
    expect(view.visible).toBe(true);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith('tradeSessionView', root);
    view.hide();
    view.hide();
    expect(view.visible).toBe(false);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('ts-3.2 writes model text as text: a nickname carrying markup creates no element', () => {
    // WRONG IMPL KILLED: innerHTML anywhere in the paint (a partner-chosen nickname is markup).
    const { root, view } = makeView();
    const evil = '<img src=x onerror=alert(1)>';
    view.paint(
      paintOf(
        vmOf(
          sess({
            partnerOffer: {
              monsterIds: [91n],
              items: [],
              currency: 0n,
              cards: [
                { monsterId: 91n, speciesId: 2, nickname: evil, level: 7, currentHp: 9, statHp: 9 },
              ],
            },
          }),
          { ownMonsters: [mon(21n, 0, evil)] },
        ),
      ),
    );
    expect(root.querySelector('img')).toBeNull();
    expect(byId('tradesession-theirs').textContent).toContain(evil);
  });
});
