// @vitest-environment happy-dom
/**
 * frame.test.ts: the one frame chrome (ctl-4, CTL4.6).
 *
 * `createFrame(doc, {id, size})` builds the chrome parts once (title bar with title and
 * breadcrumb, a tab bar with LB/RB slots around the tablist, an internally scrolling body, ONE
 * feedback line, an empty hint-bar slot) in one of four sizes. The feedback line is driven by a
 * pure token-guarded machine, `feedbackStep`, then written by a thin `renderFeedback`.
 *
 * The contract proven here:
 *  - the parts are eight distinct nodes inside the root, shared with no other frame;
 *  - the sizes are exactly side, full, bottom and small; anything else (including names found
 *    on every object) throws instead of clamping;
 *  - the tab bar is hidden until a tabs layout with at least one tab is rendered, and holds the
 *    LB slot, the tablist and the RB slot as siblings, the tablist holding only tabs;
 *  - success appears only when the caller reports resolution of the CURRENT pending token;
 *  - the feedback line has no aria-live (the page's one live region speaks), and caller text is
 *    written as text.
 *
 * Every string below is arbitrary caller text: the kit owns no catalog strings.
 */
import * as fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createFrame,
  type FeedbackEvent,
  type FeedbackState,
  FRAME_SIZES,
  type FrameChrome,
  type FrameSize,
  feedbackAnnouncement,
  feedbackStep,
  NO_FEEDBACK,
  renderFeedback,
  renderFrameTabs,
  setFrameTitle,
} from './frame';
import type { NavLayout, NavState } from './nav';
import { navTabId } from './navRender';

// --- builders -----------------------------------------------------------------------------
const itm = (key: string) => ({ key, enabled: true });
const listL = (...keys: string[]): NavLayout => ({ kind: 'list', items: keys.map(itm) });
const tabsL = (...pairs: Array<readonly [string, string[]]>): NavLayout => ({
  kind: 'tabs',
  tabs: pairs.map(([key, ks]) => ({ key, layout: { kind: 'list', items: ks.map(itm) } })),
});
const state = (item: string | null, tab: string | null): NavState => ({ tab, item, perTab: {} });
const label = (t: { readonly key: string }): string => `Tab ${t.key}`;

const begin = (token: number, text = 'wait'): FeedbackEvent => ({ kind: 'begin', token, text });
const resolved = (token: number, text = 'done'): FeedbackEvent => ({
  kind: 'resolved',
  token,
  text,
});
const failed = (token: number, text = 'oops'): FeedbackEvent => ({ kind: 'failed', token, text });
const info = (text = 'fyi'): FeedbackEvent => ({ kind: 'info', text });
const CLEAR: FeedbackEvent = { kind: 'clear' };

const fold = (from: FeedbackState, events: readonly FeedbackEvent[]): FeedbackState =>
  events.reduce((s, e) => feedbackStep(s, e), from);

beforeEach(() => {
  document.body.replaceChildren();
});

// --- CTL4.6: chrome ------------------------------------------------------------------------
describe('frame chrome', () => {
  it('CTL4-6-CHROME-PARTS builds eight distinct parts inside the root, shared with no other frame', () => {
    const f = createFrame(document, { id: 'menu', size: 'side' });
    const parts = [
      f.root,
      f.titleEl,
      f.breadcrumb,
      f.tabBar,
      f.tabStrip,
      f.body,
      f.feedback,
      f.hintSlot,
    ];
    expect(new Set(parts).size).toBe(8);
    for (const part of parts.slice(1)) expect(f.root.contains(part)).toBe(true);
    expect(f.tabBar.contains(f.tabStrip)).toBe(true);
    expect(f.titleEl.contains(f.breadcrumb)).toBe(false);

    // a second frame shares no node with the first
    const g = createFrame(document, { id: 'bag', size: 'full' });
    const other = [
      g.root,
      g.titleEl,
      g.breadcrumb,
      g.tabBar,
      g.tabStrip,
      g.body,
      g.feedback,
      g.hintSlot,
    ];
    for (const p of other) expect(parts).not.toContain(p);
    expect(f.root.contains(g.root)).toBe(false);
    expect(g.root.contains(f.body)).toBe(false);

    // classes and ids
    expect(f.root.classList.contains('mr-frame')).toBe(true);
    expect(f.body.classList.contains('mr-frame-body')).toBe(true);
    expect(f.feedback.classList.contains('mr-frame-feedback')).toBe(true);
    expect(f.hintSlot.classList.contains('mr-frame-hints')).toBe(true);
    expect(f.titleEl.id).toBe('menu-title');
    expect(g.titleEl.id).toBe('bag-title');

    // the hint slot is empty (the hint bar fills it later); the body starts empty
    expect(f.hintSlot.childNodes.length).toBe(0);
    expect(f.hintSlot.textContent).toBe('');
    expect(f.body.childNodes.length).toBe(0);

    // the title and breadcrumb are written by setFrameTitle and replaced, never appended
    setFrameTitle(f, 'Main Menu', ['Home', 'Bag']);
    expect(f.titleEl.textContent).toBe('Main Menu');
    expect(Array.from(f.breadcrumb.children).map((c) => c.textContent)).toEqual(['Home', 'Bag']);
    setFrameTitle(f, 'Shop', ['Town']);
    expect(f.titleEl.textContent).toBe('Shop');
    expect(Array.from(f.breadcrumb.children).map((c) => c.textContent)).toEqual(['Town']);
    setFrameTitle(f, 'Solo', []);
    expect(f.titleEl.textContent).toBe('Solo');
    expect(f.breadcrumb.children.length).toBe(0);
    // the other frame is untouched
    expect(g.titleEl.textContent).toBe('');
    // caller text is text, never markup
    setFrameTitle(f, '<i>x</i>', ['<b>y</b>']);
    expect(f.titleEl.children.length).toBe(0);
    expect(f.titleEl.textContent).toBe('<i>x</i>');
    expect(f.breadcrumb.textContent).toBe('<b>y</b>');
  });

  it('CTL4-6-SIZES offers exactly side, full, bottom and small, and rejects anything else', () => {
    expect([...FRAME_SIZES].sort()).toEqual(['bottom', 'full', 'side', 'small']);
    expect(FRAME_SIZES.length).toBe(4);
    for (const size of FRAME_SIZES) {
      // frame ids carry no hyphen (they prefix hyphen-joined element ids)
      const f = createFrame(document, { id: `f${size}`, size });
      expect(f.root.classList.contains('mr-frame'), size).toBe(true);
      expect(f.root.classList.contains(`mr-frame--${size}`), size).toBe(true);
      for (const other of FRAME_SIZES) {
        if (other !== size) {
          expect(f.root.classList.contains(`mr-frame--${other}`), `${size} vs ${other}`).toBe(
            false,
          );
        }
      }
    }
    // unknown sizes throw rather than clamp, including names every object answers to
    for (const bad of [
      'huge',
      '',
      'Side',
      'side ',
      '__proto__',
      'toString',
      'constructor',
      'hasOwnProperty',
      'valueOf',
    ]) {
      expect(
        () => createFrame(document, { id: 'x', size: bad as unknown as FrameSize }),
        `size ${JSON.stringify(bad)}`,
      ).toThrow();
    }
  });

  it('CTL4-6-TABSTRIP-SLOTS keeps LB, the tablist and RB as siblings, hidden until a tabs layout shows', () => {
    const f = createFrame(document, { id: 'bag', size: 'full' });
    expect(f.tabBar.hasAttribute('hidden')).toBe(true);
    const kids = Array.from(f.tabBar.children);
    expect(kids.length).toBe(3);
    expect(kids[1]).toBe(f.tabStrip);
    expect(kids[0].getAttribute('data-button')).toBe('LB');
    expect(kids[2].getAttribute('data-button')).toBe('RB');
    expect(kids[0].getAttribute('aria-hidden')).toBe('true');
    expect(kids[2].getAttribute('aria-hidden')).toBe('true');
    expect(f.tabStrip.getAttribute('role')).toBe('tablist');
    expect(f.tabStrip.hasAttribute('data-button')).toBe(false);
    expect(f.tabStrip.children.length).toBe(0);
    expect(f.tabStrip.contains(kids[0])).toBe(false);
    expect(f.tabStrip.contains(kids[2])).toBe(false);

    // a tabs layout un-hides the bar; the tablist holds only tabs, the slots stay siblings
    const layout = tabsL(['x', ['x1']], ['y', ['y1', 'y2']]);
    renderFrameTabs(f, layout, state('x1', 'x'), label);
    expect(f.tabBar.hasAttribute('hidden')).toBe(false);
    expect(f.tabBar.hidden).toBe(false);
    expect(Array.from(f.tabStrip.children).map((e) => e.getAttribute('role'))).toEqual([
      'tab',
      'tab',
    ]);
    expect(Array.from(f.tabStrip.children).map((e) => e.textContent)).toEqual(['Tab x', 'Tab y']);
    const after = Array.from(f.tabBar.children);
    expect(after.length).toBe(3);
    expect(after[0].getAttribute('data-button')).toBe('LB');
    expect(after[1]).toBe(f.tabStrip);
    expect(after[2].getAttribute('data-button')).toBe('RB');

    // the active tab follows the state
    renderFrameTabs(f, layout, state('y1', 'y'), label);
    expect(Array.from(f.tabStrip.children).map((e) => e.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
    ]);

    // a list layout hides the bar again and empties the strip; the slots stay put
    renderFrameTabs(f, listL('a', 'b'), state('a', null), label);
    expect(f.tabBar.hasAttribute('hidden')).toBe(true);
    expect(f.tabStrip.children.length).toBe(0);
    expect(f.tabBar.children.length).toBe(3);

    // a tabs layout with zero tabs stays hidden
    renderFrameTabs(f, tabsL(), state(null, null), label);
    expect(f.tabBar.hasAttribute('hidden')).toBe(true);
    expect(f.tabStrip.children.length).toBe(0);

    // one tab is enough to show it; then a grid hides it
    renderFrameTabs(f, tabsL(['only', ['o1']]), state('o1', 'only'), label);
    expect(f.tabBar.hasAttribute('hidden')).toBe(false);
    expect(f.tabStrip.children.length).toBe(1);
    renderFrameTabs(f, { kind: 'grid', items: [itm('a')], cols: 2 }, state('a', null), label);
    expect(f.tabBar.hasAttribute('hidden')).toBe(true);

    // another frame's bar is untouched
    const g = createFrame(document, { id: 'other', size: 'small' });
    renderFrameTabs(f, layout, state('x1', 'x'), label);
    expect(g.tabBar.hasAttribute('hidden')).toBe(true);
    expect(g.tabStrip.children.length).toBe(0);
  });

  it('createFrame validates the frame id: non-empty, no whitespace, no hyphen', () => {
    for (const bad of ['', 'my frame', 'a-b', ' ', 'a\tb', 'x ', '-']) {
      expect(
        () => createFrame(document, { id: bad, size: 'full' }),
        `frame id ${JSON.stringify(bad)}`,
      ).toThrow();
    }
    for (const good of ['menuView', 'shop', 'f']) {
      const f = createFrame(document, { id: good, size: 'full' });
      expect(f.id).toBe(good);
      expect(f.titleEl.id).toBe(`${good}-title`);
    }
  });

  it('frame tab ids follow the frame id', () => {
    const f = createFrame(document, { id: 'shop', size: 'full' });
    renderFrameTabs(f, tabsL(['buy', ['b1']], ['sell', ['s1']]), state('b1', 'buy'), label);
    const ids = Array.from(f.tabStrip.children).map((e) => e.id);
    expect(ids).toEqual(['shop-tab-buy', 'shop-tab-sell']);
    expect(ids).toEqual([navTabId('shop', 'buy'), navTabId('shop', 'sell')]);
  });

  it('setFrameTitle renders every crumb, in order', () => {
    const f = createFrame(document, { id: 'menu', size: 'side' });
    setFrameTitle(f, 'Deep', ['One', 'Two', 'Three', 'Four', 'Five']);
    expect(Array.from(f.breadcrumb.children).map((c) => c.textContent)).toEqual([
      'One',
      'Two',
      'Three',
      'Four',
      'Five',
    ]);
  });

  it('CTL4-6-FEEDBACK-RESOLUTION reaches ok only when the CURRENT pending token resolves', () => {
    // begin then resolve with the same token
    const p1 = feedbackStep(NO_FEEDBACK, begin(1, 'Saving'));
    expect(p1).toEqual({ kind: 'pending', token: 1, text: 'Saving' });
    const ok = feedbackStep(p1, resolved(1, 'Saved'));
    expect(ok).toEqual({ kind: 'ok', text: 'Saved' });

    // resolved twice: the second is a no-op on the very same state object
    expect(feedbackStep(ok, resolved(1, 'Saved again'))).toBe(ok);

    // a newer begin makes the older resolution stale
    const p2 = fold(NO_FEEDBACK, [begin(1), begin(2, 'second')]);
    expect(p2).toEqual({ kind: 'pending', token: 2, text: 'second' });
    expect(feedbackStep(p2, resolved(1))).toBe(p2);
    expect(feedbackStep(p2, failed(1))).toBe(p2);
    expect(feedbackStep(p2, resolved(2, 'yes'))).toEqual({ kind: 'ok', text: 'yes' });
    expect(feedbackStep(p2, failed(2, 'no'))).toEqual({ kind: 'error', text: 'no' });
    // a foreign token never resolves anything
    expect(feedbackStep(p2, resolved(99))).toBe(p2);

    // token 0 is a real token
    const p0 = feedbackStep(NO_FEEDBACK, begin(0));
    expect(p0).toEqual({ kind: 'pending', token: 0, text: 'wait' });
    expect(feedbackStep(p0, resolved(0, 'zero'))).toEqual({ kind: 'ok', text: 'zero' });
    expect(feedbackStep(p0, failed(0, 'zero bad'))).toEqual({ kind: 'error', text: 'zero bad' });

    // clear, then a late resolution: still none
    const cleared = feedbackStep(p1, CLEAR);
    expect(cleared).toEqual({ kind: 'none' });
    expect(feedbackStep(cleared, resolved(1))).toBe(cleared);
    expect(feedbackStep(cleared, failed(1))).toBe(cleared);

    // info replaces a pending; the pending's later resolution is stale
    const shown = feedbackStep(p1, info('Not enough money'));
    expect(shown).toEqual({ kind: 'info', text: 'Not enough money' });
    expect(feedbackStep(shown, resolved(1))).toBe(shown);
    expect(feedbackStep(shown, failed(1))).toBe(shown);

    // a resolution with nothing pending changes nothing, from every resting state
    const error: FeedbackState = { kind: 'error', text: 'e' };
    for (const rest of [NO_FEEDBACK, ok, error, shown]) {
      expect(feedbackStep(rest, resolved(1)), rest.kind).toBe(rest);
      expect(feedbackStep(rest, failed(1)), rest.kind).toBe(rest);
      expect(feedbackStep(rest, resolved(0)), rest.kind).toBe(rest);
    }

    // begin replaces ok, error and info
    for (const rest of [ok, error, shown]) {
      expect(feedbackStep(rest, begin(7, 'again')), rest.kind).toEqual({
        kind: 'pending',
        token: 7,
        text: 'again',
      });
    }
    // clear from anywhere is none
    for (const any of [NO_FEEDBACK, p1, ok, error, shown]) {
      expect(feedbackStep(any, CLEAR), any.kind).toEqual({ kind: 'none' });
    }

    // property: over any event sequence, the machine matches the token-guard rule exactly
    const text = fc.constantFrom('t1', 't2', 't3');
    const token = fc.integer({ min: 0, max: 3 });
    const event: fc.Arbitrary<FeedbackEvent> = fc.oneof(
      fc.record({ kind: fc.constant('begin' as const), token, text }),
      fc.record({ kind: fc.constant('resolved' as const), token, text }),
      fc.record({ kind: fc.constant('failed' as const), token, text }),
      fc.record({ kind: fc.constant('info' as const), text }),
      fc.record({ kind: fc.constant('clear' as const) }),
    );
    fc.assert(
      fc.property(fc.array(event, { maxLength: 30 }), (events) => {
        let s: FeedbackState = NO_FEEDBACK;
        for (const e of events) {
          const before = s;
          s = feedbackStep(before, e);
          const current = before.kind === 'pending' && 'token' in e && before.token === e.token;
          if (e.kind === 'resolved') {
            if (current) expect(s).toEqual({ kind: 'ok', text: e.text });
            else expect(s).toBe(before);
          } else if (e.kind === 'failed') {
            if (current) expect(s).toEqual({ kind: 'error', text: e.text });
            else expect(s).toBe(before);
          } else if (e.kind === 'begin') {
            expect(s).toEqual({ kind: 'pending', token: e.token, text: e.text });
          } else if (e.kind === 'info') {
            expect(s).toEqual({ kind: 'info', text: e.text });
          } else {
            expect(s).toEqual({ kind: 'none' });
          }
          // ok is reachable only by resolving the current pending token
          if (s.kind === 'ok' && before.kind !== 'ok') {
            expect(e.kind).toBe('resolved');
            expect(current).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('CTL4-6-FEEDBACK-RENDER writes data-feedback and the text, clears both on none, and sets no aria-live', () => {
    const f: FrameChrome = createFrame(document, { id: 'shop', size: 'bottom' });
    const kind = (): string => f.feedback.getAttribute('data-feedback') ?? '';
    const noLive = (when: string): void => {
      expect(f.feedback.hasAttribute('aria-live'), `feedback aria-live ${when}`).toBe(false);
      expect(f.root.hasAttribute('aria-live'), `root aria-live ${when}`).toBe(false);
      expect(f.root.querySelector('[aria-live]'), `descendant aria-live ${when}`).toBeNull();
    };

    // a fresh frame has an empty feedback line
    expect(kind()).toBe('');
    expect(f.feedback.textContent).toBe('');
    noLive('fresh');

    renderFeedback(f, { kind: 'pending', token: 3, text: 'Saving the game' });
    expect(kind()).toBe('pending');
    expect(f.feedback.textContent).toBe('Saving the game');
    noLive('pending');

    renderFeedback(f, { kind: 'ok', text: 'Saved' });
    expect(kind()).toBe('ok');
    expect(f.feedback.textContent).toBe('Saved');
    noLive('ok');

    renderFeedback(f, { kind: 'error', text: 'It failed' });
    expect(kind()).toBe('error');
    expect(f.feedback.textContent).toBe('It failed');
    noLive('error');

    renderFeedback(f, { kind: 'info', text: 'Needs 3 coins' });
    expect(kind()).toBe('info');
    expect(f.feedback.textContent).toBe('Needs 3 coins');
    noLive('info');

    // none clears both the kind and the text
    renderFeedback(f, { kind: 'none' });
    expect(kind()).toBe('');
    expect(f.feedback.textContent).toBe('');
    noLive('none');

    // none straight after pending clears too
    renderFeedback(f, { kind: 'pending', token: 4, text: 'Working' });
    renderFeedback(f, { kind: 'none' });
    expect(kind()).toBe('');
    expect(f.feedback.textContent).toBe('');

    // the text is replaced, not appended, and is written as text
    renderFeedback(f, { kind: 'info', text: 'one' });
    renderFeedback(f, { kind: 'info', text: '<b>two</b>' });
    expect(f.feedback.textContent).toBe('<b>two</b>');
    expect(f.feedback.children.length).toBe(0);

    // another frame's line is untouched
    const g = createFrame(document, { id: 'bag', size: 'small' });
    expect(g.feedback.getAttribute('data-feedback') ?? '').toBe('');
    expect(g.feedback.textContent).toBe('');
  });
});

// --- polish-1 P5: the feedback line is announced through the live region, once per change ------
//
// EARS: WHEN a menu entry's Y description or ok/error/pending frame feedback is rendered, THE
// CLIENT SHALL announce it through the live region, once per change.
//
// `feedbackAnnouncement(prev, next)` is the pure decision main.ts's `applyMenuStep` asks for every
// menu step: the text to announce, or null. It returns `next.text` exactly when `next` shows
// something (kind is not 'none'), that something has text, and it is a CHANGE from `prev` (a
// different kind or different text). The same visible line again is null (a repeat Y, a repeat
// render, a pending line re-begun under a new token with the same words). The feedback line node
// itself stays a non-live node (CTL4-6-FEEDBACK-RENDER above pins no aria-live); `#a11y-live` is
// the page's one live region. RED REASON today: `feedbackAnnouncement` is not exported from
// ./frame, so every case below calls undefined.
describe('feedbackAnnouncement (polish-1 P5)', () => {
  const NONE: FeedbackState = { kind: 'none' };
  const pend = (token: number, text: string): FeedbackState => ({ kind: 'pending', token, text });
  const okS = (text: string): FeedbackState => ({ kind: 'ok', text });
  const errS = (text: string): FeedbackState => ({ kind: 'error', text });
  const infoS = (text: string): FeedbackState => ({ kind: 'info', text });

  const rows: Array<[string, FeedbackState, FeedbackState, string | null]> = [
    [
      'none -> info announces the description',
      NONE,
      infoS('Review your quests'),
      'Review your quests',
    ],
    ['none -> pending announces the pending text', NONE, pend(1, 'Saving'), 'Saving'],
    ['pending -> ok announces the resolved text', pend(1, 'Saving'), okS('Saved'), 'Saved'],
    [
      'pending -> error announces the failure text',
      pend(1, 'Saving'),
      errS('It failed'),
      'It failed',
    ],
    ['info -> the same info again is silent', infoS('fyi'), infoS('fyi'), null],
    ['info -> a different info announces the new text', infoS('fyi'), infoS('other'), 'other'],
    ['info -> none is silent', infoS('fyi'), NONE, null],
    ['ok -> none is silent', okS('Saved'), NONE, null],
    ['error -> none is silent', errS('It failed'), NONE, null],
    ['pending -> none is silent', pend(1, 'Saving'), NONE, null],
    ['none -> none is silent', NONE, NONE, null],
    ['none -> info with empty text is silent', NONE, infoS(''), null],
    ['info -> info with empty text is silent', infoS('fyi'), infoS(''), null],
    ['none -> pending with empty text is silent', NONE, pend(1, ''), null],
    [
      'pending -> pending, same words under a NEW token, is silent (the visible line is the same)',
      pend(1, 'Saving'),
      pend(2, 'Saving'),
      null,
    ],
    ['pending -> the identical pending is silent', pend(1, 'Saving'), pend(1, 'Saving'), null],
    [
      'pending -> pending with new words announces them',
      pend(1, 'Saving'),
      pend(2, 'Still saving'),
      'Still saving',
    ],
    [
      'pending -> ok with the SAME words is a change of kind: announced',
      pend(1, 'Done'),
      okS('Done'),
      'Done',
    ],
    ['info -> ok with the same words is a change of kind: announced', infoS('x'), okS('x'), 'x'],
    ['ok -> error with the same words is a change of kind: announced', okS('x'), errS('x'), 'x'],
    ['ok -> the same ok again is silent', okS('Saved'), okS('Saved'), null],
    [
      'ok -> a pending begin announces its text',
      okS('Saved'),
      pend(2, 'Saving again'),
      'Saving again',
    ],
  ];

  it.each(rows)('POLISH1-P5-ANNOUNCEMENT: %s', (_name, prev, next, expected) => {
    // WRONG IMPL KILLED: a missing export; an announcement on every step with feedback (a repeat
    // Y or a repeat render would re-announce); one that compares text only (ok after pending with
    // the same words would stay silent) or kind only (a new info text would stay silent); one that
    // announces a none state or empty text; one that announces the previous text; one that
    // compares the pending TOKEN (a re-begun identical line would be announced twice).
    expect(feedbackAnnouncement(prev, next)).toBe(expected);
  });

  it('POLISH1-P5-ANNOUNCEMENT-PROPERTY: the same state twice is always silent, and any other result is exactly the new text', () => {
    const text = fc.constantFrom('', 'a', 'b', 'Saving');
    const state: fc.Arbitrary<FeedbackState> = fc.oneof(
      fc.constant<FeedbackState>({ kind: 'none' }),
      fc.record({
        kind: fc.constant('pending' as const),
        token: fc.integer({ min: 0, max: 3 }),
        text,
      }),
      fc.record({ kind: fc.constantFrom('ok' as const, 'error' as const, 'info' as const), text }),
    );
    fc.assert(
      fc.property(state, state, (prev, next) => {
        expect(feedbackAnnouncement(prev, prev)).toBeNull();
        const got = feedbackAnnouncement(prev, next);
        if (got !== null) {
          expect(next.kind).not.toBe('none');
          expect(got).toBe((next as { text: string }).text);
          expect(got).not.toBe('');
        }
        if (next.kind === 'none') expect(got).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it('POLISH1-P5-ANNOUNCEMENT-NOT-LIVE: rendering the announced states still leaves the feedback line a non-live node', () => {
    // The announcement goes through #a11y-live, never through the line itself: no aria-live and no
    // live role on the line, whichever state is rendered (CTL4-6-FEEDBACK-RENDER pins the same).
    const f: FrameChrome = createFrame(document, { id: 'menu', size: 'side' });
    for (const s of [infoS('fyi'), pend(1, 'Saving'), okS('Saved'), errS('It failed')]) {
      renderFeedback(f, s);
      expect(f.feedback.hasAttribute('aria-live'), s.kind).toBe(false);
      expect(f.feedback.hasAttribute('role'), s.kind).toBe(false);
    }
  });
});
