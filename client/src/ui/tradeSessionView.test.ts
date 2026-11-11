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
// the view adopts the root, empties it once at construction and builds `tradesession-*` parts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreMonsterPub, StoreTradeSession } from '../net/store';
import { t, tf } from './i18n/resolver';
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
    players: [{ identity: BOB, entityId: 2n, name: 'Bob', online: true, lastInputSeq: 0n }],
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
    legacyOfferMonsterIds: new Set(),
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
} {
  const root = mountShell();
  const announce = vi.fn();
  const view = new TradeSessionView({ announce });
  return { root, view, announce };
}

describe('TradeSessionView — the shell (ts-3.2)', () => {
  it('ts-3.2 the constructor throws without #tradepropose-overlay, empties the static shell ONCE and builds the tradesession-* parts (each id also its data-testid); a node adopted into the root later survives every paint', () => {
    // WRONG IMPL KILLED: a view that keeps the wizard's static controls (a mouse-only select and
    // inputs inside the editor); parts without a data-testid (the e2e would not find them); a
    // paint that empties the root again (the toast live region adopted into an open dialog root
    // would be torn out on every batch); a silent no-op on a missing shell.
    expect(() => new TradeSessionView({ announce: () => {} }), 'no shell').toThrow();
    const { root, view } = makeView();
    expect(root.querySelector('#tradepropose-target'), 'the static shell is emptied').toBeNull();
    expect(root.querySelector('select, input, button')).toBeNull();
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
    }
    expect(byId('tradesession-title').tagName).toBe('H2');
    const adopted = document.createElement('div');
    adopted.id = 'adopted-live-region';
    root.appendChild(adopted);
    view.paint(paintOf(vmOf()));
    view.paint(paintOf(vmOf(sess({ revision: REV + 1n }))));
    expect(adopted.parentElement, 'the adopted node survives the paints').toBe(root);
  });

  it('ts-3.4 the editor holds no native control: every row is a listbox option the D-pad drives (no mouse-only element)', () => {
    // WRONG IMPL KILLED: a button or an input per row (a pointer-only path beside the D-pad); a
    // rows container that is not the listbox the router's focus names.
    const { root, view } = makeView();
    view.show();
    view.paint(paintOf(vmOf(), { prompt: { action: 'confirm', yes: false } }));
    expect(root.querySelectorAll('button, input, select, textarea, a[href]').length).toBe(0);
    expect(byId('tradesession-rows').getAttribute('role')).toBe('listbox');
    expect(byId('tradesession-confirm').getAttribute('role')).toBe('listbox');
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
    expect(rowEl('monster-21').textContent).toContain('Ash');
    const bry = vm.monsters.find((m) => m.monsterId === 22n);
    expect(bry?.blocked, 'fixture: 22 fainted').toBe('fainted');
    expect(rowEl('monster-22').textContent).toBe(
      tf('tradeSession.row.blocked', {
        label: bry?.label ?? '',
        reason: t('tradeSession.reason.fainted'),
      }),
    );
    const cyd = vm.monsters.find((m) => m.monsterId === 23n);
    expect(rowEl('monster-23').textContent, 'at the cap of 1').toBe(
      tf('tradeSession.row.blocked', {
        label: cyd?.label ?? '',
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
      ['confirm', false, 'tradeSession.prompt.confirm'],
      ['confirm', true, 'tradeSession.prompt.confirm'],
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
