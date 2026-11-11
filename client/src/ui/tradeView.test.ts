// @vitest-environment happy-dom
// ui/tradeView.test.ts — the trade root (`#trade-overlay`) as the Social frame's painter.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-trade-sessions.spec.md §ts-3 (ts-3.5), §ts-4 (ts-4.6);
//   the ts-4 plan "Resume 2": `new TradeView()` takes no argument and has no `render`; the
//   constructor needs only `#trade-overlay` and `#trade-status`; it never reads or writes
//   `#trade-my-side`, `#trade-their-side`, `#trade-actions` or `#trade-feedback`. The status line is
//   a function of the kept Social paint alone: Players -> `social.players.placeholder`; Trades with
//   at least one session row -> `trade.status.open`; otherwise (no paint kept, or no session row)
//   -> `trade.status.none`. `#trade-status` never carries `mr-nav-item`, `is-active` or
//   `aria-current`. `show` / `hide` / `toggle` / `visible` / `hostChrome` / `paintSocial` and the
//   `#trade-sessions` list (created by the first paint that has a row) are as ctl-8d / ts-3 built
//   them.
//
// The overlay a11y wiring (m23-s3; M23-accessibility.spec.md §2.2, §6 A11Y-13/14/16; ADR-0205
// D1-D4, A3) is pinned by TWO oracles, both required:
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['tradeView'].labelKey)`. `role`/`aria-modal`
//     are static literals on the shell (client/index.html), so asserting them ALONE is vacuous.
//     They are asserted only alongside aria-label, and their ABSENCE after close is the
//     anti-vacuity partner.
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through, so a cheat that hand-writes the three attributes with the copied literal still reds.
//
// TEST-ISOLATION DEVICE: overlayA11y.ts holds ONE module-private Map and exports no reset hook, so
// the file-level beforeEach/afterEach call the PRODUCTION closeOverlayA11y(id, null) for every
// OverlayId and flush ONE REAL MACROTASK (close-without-open is a documented no-op).
// `vi.clearAllMocks()` runs LAST so the sweep's own calls never pollute a count.
//
// Expected copy is resolved through the real (spied) resolver from its literal catalog ids, never
// hand-typed English, except the byte-identity pins the i18n migration (m24s4) owns.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import type { SocialTab } from './screens/types';
import type { SocialAction } from './socialModel';
import type { SocialPaint, SocialQuestion, SocialSessionRow } from './tradeView';
import { TradeView } from './tradeView';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });
// m24s4 MECHANISM oracle, same shape: records every t()/tf() call AND calls through to the real
// resolver, so TV-01's DOM byte-identity assertions still work.
vi.mock('./i18n/resolver', { spy: true });

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer. */
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

/** The four static shell parts the view never touches (index.html keeps them as empty nodes). */
const STATIC_PARTS = ['trade-my-side', 'trade-their-side', 'trade-actions', 'trade-feedback'];
/** The five trade-shell parts, in shell order. */
const TRADE_PARTS = ['trade-status', ...STATIC_PARTS];

// ---------------------------------------------------------------------------
// DOM setup helper — mirrors the structure in client/index.html. `full: false` mounts only the
// two nodes the constructor requires: the root and its status line.
// ---------------------------------------------------------------------------
function mountTradeOverlay({ full = true }: { readonly full?: boolean } = {}): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = 'trade-overlay';
  overlay.style.display = 'none';
  // FIXTURE FIDELITY: the shell ships these two as STATIC LITERALS. They are copied here NOT to
  // be asserted on their own (vacuous), but so that "all three attributes ABSENT after close" is a
  // real tooth: only closeOverlayA11y can remove them.
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const statusEl = document.createElement('div');
  statusEl.id = 'trade-status';
  // The OVERLAY_A11Y initialFocusSelector anchor. happy-dom focuses a bare <div> with no tabindex
  // at all, so this buys no test power; it is copied for fidelity only.
  statusEl.setAttribute('tabindex', '-1');
  overlay.appendChild(statusEl);

  if (full) {
    for (const id of STATIC_PARTS) {
      const part = document.createElement('div');
      part.id = id;
      overlay.appendChild(part);
    }
  }

  document.body.appendChild(overlay);
  return overlay;
}

function removeOverlay(overlay: HTMLElement): void {
  if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
}

/** A focusable OUTSIDE the overlay: the "pre-overlay" element a close must restore focus to. */
function s3OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root: if this loses focus something
 *  RE-OPENED the overlay. */
function s3InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

/** The Social tabs in strip order (design §5: Players | Trades | Challenges | Rankings). */
const SOCIAL_TAB_ORDER: readonly SocialTab[] = ['players', 'trades', 'challenges', 'rankings'];

/** The catalogued label of each tab, each action and each question, as thunks (resolved when a
 *  case asserts, never at collection). */
const SOCIAL_TAB_LABEL: Readonly<Record<SocialTab, () => string>> = {
  players: () => i18nT('social.tab.players'),
  trades: () => i18nT('social.tab.trades'),
  challenges: () => i18nT('social.tab.challenges'),
  rankings: () => i18nT('social.tab.rankings'),
};
const SOCIAL_ACTION_LABEL: Readonly<Record<SocialAction, () => string>> = {
  accept: () => i18nT('social.action.accept'),
  decline: () => i18nT('social.action.decline'),
  cancel: () => i18nT('social.action.cancel'),
};
const SOCIAL_QUESTION_TEXT: Readonly<Record<SocialQuestion, () => string>> = {
  declineChallenge: () => i18nT('social.confirm.declineChallenge'),
};

/** Every id the chrome half may create: each at most once in the document, always in the chrome. */
const SOCIAL_PART_IDS = [
  'social-tabs',
  'social-tab-players',
  'social-tab-trades',
  'social-tab-challenges',
  'social-tab-rankings',
  'social-sheet',
  'social-prompt',
  'social-prompt-text',
  'social-confirm',
];

/** A SocialPaint with exactly its five keys. */
function socialPaint(overrides: Partial<SocialPaint> = {}): SocialPaint {
  return {
    tab: 'trades',
    sessions: [],
    sessionCursor: null,
    sheet: null,
    confirm: null,
    ...overrides,
  };
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} must be in the document`);
  return el;
}

const hiddenTradeParts = (): string[] => TRADE_PARTS.filter((id) => byId(id).hidden);

/** The status line's cursor mark: the nav-item class, the active class, aria-current. */
const UNMARKED = [false, false, null] as const;
function statusMark(): [boolean, boolean, string | null] {
  const status = byId('trade-status');
  return [
    status.classList.contains('mr-nav-item'),
    status.classList.contains('is-active'),
    status.getAttribute('aria-current'),
  ];
}

interface NavRows {
  readonly keys: readonly string[];
  readonly texts: readonly string[];
  readonly activeByClass: readonly string[];
  readonly activeByAria: readonly string[];
}

/** The `[data-nav-key]` rows of a nav container: keys and texts in order, and which carry the
 *  active class and which `aria-selected="true"`. */
function navRows(container: HTMLElement): NavRows {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-nav-key]')];
  const key = (r: HTMLElement): string => r.dataset.navKey ?? '';
  return {
    keys: rows.map(key),
    texts: rows.map((r) => r.textContent ?? ''),
    activeByClass: rows.filter((r) => r.classList.contains('is-active')).map(key),
    activeByAria: rows.filter((r) => r.getAttribute('aria-selected') === 'true').map(key),
  };
}

/** `root`'s element children are exactly `expected`, by identity and in order. */
function expectChildren(root: HTMLElement, expected: readonly Element[], label: string): void {
  expect(root.children.length, `${label}: the root's child count`).toBe(expected.length);
  expected.forEach((child, i) => {
    expect(root.children[i], `${label}: child ${i} is unchanged`).toBe(child);
  });
}

const BOB_ROW: SocialSessionRow = {
  key: 'session-101',
  partnerName: 'Bob',
  mineConfirmed: false,
  theirsConfirmed: true,
};
const CAROL_ROW: SocialSessionRow = {
  key: 'session-102',
  partnerName: 'Carol',
  mineConfirmed: true,
  theirsConfirmed: false,
};

/** No session list shows: absent, or hidden. */
function expectNoSessionRows(label: string): void {
  const ul = document.getElementById('trade-sessions');
  if (ul === null) return;
  expect(ul.hidden, `${label}: #trade-sessions is hidden`).toBe(true);
}

// ---------------------------------------------------------------------------
// uif-4b (UIF4B.5): the view owns no feedback line.
// ---------------------------------------------------------------------------
describe('TradeView: the view owns no feedback line (uif-4b)', () => {
  it('UIF4B.5 the view has no showFeedback, and paints on every tab leave the #trade-feedback text as it was', () => {
    // WRONG IMPL KILLED: a surviving showFeedback (a second channel beside the toast seam), and a
    // view that still writes the node that stays in index.html as an empty residual.
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    view.show();
    const chrome = document.createElement('div');
    view.hostChrome(chrome);
    const feedbackEl = byId('trade-feedback');
    feedbackEl.textContent = 'sentinel the view must leave alone';
    for (const tab of SOCIAL_TAB_ORDER) {
      view.paintSocial(chrome, socialPaint({ tab, sessions: [BOB_ROW] }));
    }
    view.hide();
    expect('showFeedback' in view, 'no showFeedback on the view').toBe(false);
    expect(feedbackEl.textContent, 'the view neither reads nor clears that node').toBe(
      'sentinel the view must leave alone',
    );
    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// Overlay a11y wiring on the show()/hide() edge (m23-s3)
// ---------------------------------------------------------------------------

const S3_ID: OverlayId = 'tradeView';
const S3_META = OVERLAY_A11Y[S3_ID];

describe('TradeView — overlay a11y wiring on the show/hide edge (m23-s3)', () => {
  it('S3-tradeView-OPEN-ARIA BITES: the first show() from a display:none shell labels the root from OVERLAY_A11Y/t()', () => {
    const overlay = mountTradeOverlay();
    const view = new TradeView();

    // VACUITY ATTACK V4, closed here: without `display:none` the FIRST show() is a NO-EDGE and
    // every open assertion below is silently vacuous. This also pins WIK-3 — an impl that reads
    // `this.visible` AFTER writing `style.display` sees a constant `true` and never opens.
    expect(view.visible, 'V4: the shell must start hidden, so the first show() IS an edge').toBe(
      false,
    );

    view.show();

    // Every expectation is DERIVED from the table at assert time — never a literal (V5).
    expect(overlay.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S3_META.role);
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(
      overlay.getAttribute('aria-label'),
      'THE tooth: role/aria-modal are static literals in index.html and pass a view that calls ' +
        'nothing; aria-label is absent from every shell, so only a real open can produce it — and ' +
        'because all catalog values are distinct, this also kills the wrong-OverlayId impl',
    ).toBe(t(S3_META.labelKey));
  });

  it('S3-tradeView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y', async () => {
    const overlay = mountTradeOverlay();
    const target = overlay.querySelector<HTMLElement>(S3_META.initialFocusSelector);
    expect(target, `the fixture must contain ${S3_META.initialFocusSelector}`).not.toBeNull();
    const view = new TradeView();

    view.show();

    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );
    expect(
      vi.mocked(openOverlayA11y),
      'the deferred focus must be scheduled by openOverlayA11y, not by the view (A11Y-15)',
    ).toHaveBeenCalledTimes(1);

    await flushMacrotask();

    // IDENTITY, never `root.contains(activeElement)` — that passes on any decorative wrapper.
    expect(document.activeElement).toBe(target);
  });

  it('S3-tradeView-CLOSE-RESTORE BITES: hide() strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    const overlay = mountTradeOverlay();
    const outside = s3OutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new TradeView();
    view.show();
    await flushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).not.toBe(outside);

    view.hide();

    // VACUITY ATTACK V1: the two static literals can only be ABSENT if closeOverlayA11y really ran.
    expect(
      overlay.getAttribute('role'),
      'a display:none node must not keep claiming to be a dialog',
    ).toBeNull();
    expect(overlay.getAttribute('aria-modal')).toBeNull();
    expect(overlay.getAttribute('aria-label')).toBeNull();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-tradeView-REPEAT-NO-REOPEN BITES: show() on an ALREADY-visible overlay neither re-opens nor yanks focus back', async () => {
    // A re-open clears and re-schedules the deferred-focus timer. INVISIBLE to every attribute
    // assertion, so it is proven twice: by a call COUNT and by the sentinel still holding focus.
    const overlay = mountTradeOverlay();
    const view = new TradeView();

    view.show();
    await flushMacrotask();

    const inside = s3InsideSentinel(overlay);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.show();
    await flushMacrotask();

    expect(document.activeElement, 'a repeat show() must NOT re-run the deferred focus').toBe(
      inside,
    );
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-tradeView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE: a view that hand-writes the three attributes with the correct copied
    // literal passes every VALUE assertion here while shipping NO trap, NO return-focus record and
    // NO timer. The literal `null` pins ADR-0205 A3.
    const overlay = mountTradeOverlay();
    const view = new TradeView();

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S3_ID, overlay);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);
  });

  it('S3-tradeView-CLOSE-UNGUARDED BITES: hide() calls the close UNCONDITIONALLY — on a never-opened view, and again on every repeat', () => {
    // A guarded hide() reads `visible === false` and SKIPS the close whenever a record ever
    // desynchronised from the DOM, making a live capture listener, a pending timer and a stale
    // return target PERMANENT. Unguarded, hide() HEALS it, and a close with no record is a
    // documented pure no-op.
    mountTradeOverlay();
    const view = new TradeView();
    expect(view.visible, 'precondition: never opened').toBe(false);

    expect(() => view.hide()).not.toThrow();
    expect(
      vi.mocked(closeOverlayA11y),
      'hide() on a never-opened view MUST still call the close — a guarded hide calls it zero times',
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);

    view.hide();
    expect(
      vi.mocked(closeOverlayA11y),
      'unguarded means unguarded: every hide() calls the close',
    ).toHaveBeenCalledTimes(2);

    // And the same holds after a real open/close cycle: the second hide() still calls it.
    vi.clearAllMocks();
    view.show();
    view.hide();
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// i18n (m24s4, ADR-0260): tradeView.ts routes its sinks through t()/tf().
// =============================================================================

/** `JSON.stringify` throws on a bare bigint; every sentinel `tf` mock uses this. Nested sentinels
 *  (a resolved mark handed to `trade.row.marks`) are re-bracketed with `<`/`>` so a span never
 *  holds another span. */
function m24s4Replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return value.replaceAll('«', '<').replaceAll('»', '>');
  return value;
}

/** The tradeView keys the sentinel matrix can legitimately produce. A bracket span whose content
 *  is not EXACTLY one of these is LEFT IN PLACE (never elided), so a decoy bracket pair around raw
 *  English is not laundered past the roster-word scan. */
const M24S4_TV_PLAIN_KEYS = new Set([
  'trade.status.none',
  'trade.status.open',
  'social.players.placeholder',
  'tradeSession.mark.confirmed',
  'tradeSession.mark.unconfirmed',
]);

const M24S4_TV_PARAM_KEYS = new Set(['trade.row.title', 'trade.row.marks']);

/** True iff `content` (the text strictly between one `«`/`»` pair) is EXACTLY an expected
 *  sentinel: a bare roster key, or `key|<json>` where `key` is a PARAM key and the tail after the
 *  FIRST `|` parses to a plain (non-array, non-null) object. */
function m24s4TvIsExpectedSentinelSpan(content: string): boolean {
  const bar = content.indexOf('|');
  if (bar === -1) {
    return M24S4_TV_PLAIN_KEYS.has(content) || M24S4_TV_PARAM_KEYS.has(content);
  }
  const key = content.slice(0, bar);
  if (!M24S4_TV_PARAM_KEYS.has(key)) return false;
  const tail = content.slice(bar + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/** Elides only the bracket spans that are EXACTLY an expected sentinel (a manual indexOf loop, no
 *  RegExp) and reports every OTHER `«...»` span verbatim in `unexpectedSpans`. */
function m24s4TvSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
      out += text.slice(open);
      break;
    }
    const span = text.slice(open, close + 1);
    const content = text.slice(open + 1, close);
    if (!m24s4TvIsExpectedSentinelSpan(content)) {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

/** Whole-subtree walk: every descendant's own text-node children, every element's `title`
 *  attribute, and every `<option>`'s text. */
function m24s4TvWalkSubtree(root: HTMLElement): string[] {
  const texts: string[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    const titleAttr = el.getAttribute('title');
    if (titleAttr) texts.push(titleAttr);
    if (el.tagName === 'OPTION') texts.push(el.textContent ?? '');
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) texts.push(node.textContent ?? '');
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return texts;
}

describe('m24s4 (ADR-0260): tradeView.ts routes its sinks through t()/tf()', () => {
  it('m24s4 TV-01: the status line and the session rows call t()/tf() with the exact key and params, and the no-session status stays byte-identical', () => {
    // WRONG IMPL KILLED: a status line written from a raw English literal; a session row title or
    // marks built by string concatenation instead of `trade.row.title` / `trade.row.marks`; marks
    // resolved from the wrong seat.
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    view.show();
    const chrome = document.createElement('div');
    view.hostChrome(chrome);
    const confirmed = i18nT('tradeSession.mark.confirmed');
    const unconfirmed = i18nT('tradeSession.mark.unconfirmed');
    vi.mocked(i18nT).mockClear();
    vi.mocked(i18nTf).mockClear();

    view.paintSocial(chrome, socialPaint({ tab: 'trades' }));
    expect(i18nT).toHaveBeenCalledWith('trade.status.none');
    expect(byId('trade-status').textContent).toBe('No active trade');

    vi.mocked(i18nT).mockClear();
    vi.mocked(i18nTf).mockClear();
    view.paintSocial(chrome, socialPaint({ tab: 'trades', sessions: [BOB_ROW] }));
    expect(i18nT).toHaveBeenCalledWith('trade.status.open');
    expect(byId('trade-status').textContent).toBe(i18nT('trade.status.open'));
    expect(i18nTf).toHaveBeenCalledWith('trade.row.title', { name: 'Bob' });
    expect(i18nTf).toHaveBeenCalledWith('trade.row.marks', {
      mine: unconfirmed,
      theirs: confirmed,
    });

    vi.mocked(i18nT).mockClear();
    view.paintSocial(chrome, socialPaint({ tab: 'players', sessions: [BOB_ROW] }));
    expect(i18nT).toHaveBeenCalledWith('social.players.placeholder');
    expect('showFeedback' in view, 'no showFeedback on the view').toBe(false);

    removeOverlay(overlay);
  });

  it('m24s4 TV-02: under «key» sentinels, the trade root shows resolver output and never an English roster word outside a sentinel, on every tab, with and without session rows', () => {
    const overlay = mountTradeOverlay();
    // The view is CONSTRUCTED before the sentinel mockImplementation is installed, so a
    // regression that hoists a t()/tf() call into the constructor resolves against the REAL
    // resolver and surfaces as unbracketed English in the first scan below.
    const view = new TradeView();
    const roster = [
      'No active trade',
      i18nT('trade.status.open'),
      i18nT('social.players.placeholder'),
      i18nT('tradeSession.mark.confirmed'),
      i18nT('tradeSession.mark.unconfirmed'),
      'You offer',
      'You receive',
      'Accept',
      'Reject',
      'Confirm Trade',
      'Cancel',
    ];
    const scan = (label: string): string => {
      const texts = m24s4TvWalkSubtree(overlay);
      const { stripped, unexpectedSpans } = m24s4TvSplitSentinels(texts.join('\n'));
      expect(unexpectedSpans, `${label}: only exact sentinels`).toEqual([]);
      for (const word of roster) {
        expect(stripped.includes(word), `${label}: no raw "${word}"`).toBe(false);
      }
      return texts.join('\n');
    };

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params, m24s4Replacer)}»`,
      );

      view.show();
      // The chrome is hosted elsewhere: this scan reads the trade root's own sinks.
      const chrome = document.createElement('div');
      document.body.appendChild(chrome);
      view.paintSocial(chrome, socialPaint({ tab: 'trades' }));
      expect(scan('Trades, no session')).toContain('«trade.status.none»');
      view.paintSocial(chrome, socialPaint({ tab: 'trades', sessions: [BOB_ROW, CAROL_ROW] }));
      const joined = scan('Trades, two sessions');
      expect(joined).toContain('«trade.status.open»');
      expect(joined).toContain('«trade.row.title|{"name":"Bob"}»');
      expect(joined).toContain('«trade.row.title|{"name":"Carol"}»');
      expect(joined).toContain(
        '«trade.row.marks|{"mine":"<tradeSession.mark.unconfirmed>","theirs":"<tradeSession.mark.confirmed>"}»',
      );
      view.paintSocial(chrome, socialPaint({ tab: 'players', sessions: [BOB_ROW] }));
      expect(scan('Players')).toContain('«social.players.placeholder»');
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }

    // Post-restore call-through control.
    expect(i18nT('chrome.help.title')).toBe('How to Play');

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// ctl-8s (CTL8S.3): the Social frame's chrome. main.ts builds ONE chrome element and moves it into
// whichever Social panel shows, through that panel's `hostChrome(el)`: `el` becomes the root's
// FIRST child, nothing else on the root changes, and a second call with `el` already first is a
// no-op (a re-insert would drop focus from a tab inside it on every panel switch).
//
// happy-dom limit (measured on ctl-4): re-inserting a node before itself records no mutation and
// keeps focus here, so that one churn mutant is invisible at this tier. A remove-then-insert is
// not: it records two mutations.
// ---------------------------------------------------------------------------

describe('TradeView.hostChrome (ctl-8s, CTL8S.3)', () => {
  it('CTL8S-3-HOST-CHROME-TRADE: hostChrome(el) moves el out of wherever it was to be the FIRST child of #trade-overlay; the other children, their order and ids, the hidden shell and its dialog state are unchanged; a second call with el already first records no mutation and keeps focus inside el', async () => {
    // WRONG IMPL KILLED: an append (el lands LAST); a clone (`prepend(el.cloneNode(true))`: the
    // node main.ts paints is not the node shown); a host that also shows the view or opens its
    // dialog; one that replaces the root's children; and a re-host that removes el and inserts it
    // again when it is already first (a focused tab drops focus on every panel switch).
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    const before = [...overlay.children];
    expect(
      before.map((c) => c.id),
      'precondition: the shell children',
    ).toEqual(TRADE_PARTS);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    const chrome = document.createElement('div');
    const tab = document.createElement('button');
    chrome.appendChild(tab);
    elsewhere.appendChild(chrome);

    view.hostChrome(chrome);

    expect(overlay.firstElementChild, 'el is the first child of the root').toBe(chrome);
    expect(chrome.parentElement, 'moved, not cloned').toBe(overlay);
    expect(elsewhere.childElementCount, 'and no longer where it was').toBe(0);
    expect(overlay.childElementCount, 'one child more, nothing replaced').toBe(before.length + 1);
    for (const [i, child] of before.entries()) {
      expect(overlay.children[i + 1], `#${child.id}: kept, in its order`).toBe(child);
    }
    expect(
      before.map((c) => c.id),
      'their ids are unchanged',
    ).toEqual(TRADE_PARTS);
    expect(overlay.id).toBe('trade-overlay');
    expect(overlay.style.display, 'the shell stays hidden').toBe('none');
    expect(view.visible, 'the view stays hidden').toBe(false);
    expect(overlay.getAttribute('aria-label'), 'no dialog was opened').toBeNull();

    // On the shown panel, a second host of the element already first moves nothing.
    view.show();
    await flushMacrotask();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => {
      records.push(...batch);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    tab.focus();
    expect(document.activeElement, 'precondition: focus is on a tab inside the chrome').toBe(tab);
    view.hostChrome(chrome);
    await flushMacrotask();
    observer.disconnect();
    expect(records.length, 'no node was removed or inserted').toBe(0);
    expect(document.activeElement, 'focus inside the chrome survives').toBe(tab);
    expect(overlay.firstElementChild).toBe(chrome);
    expect(overlay.childElementCount).toBe(before.length + 1);
    expect(view.visible, 'the shown panel stays shown').toBe(true);

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// ctl-8d (CTL8D.1, CTL8D.2): the Social frame's one painter. The Social adapter paints through
// `TradeView.paintSocial(chrome, p)`: its chrome half (the tab strip, the action sheet and the
// Yes / No prompt) is painted INSIDE the chrome element main.ts moves into whichever panel shows,
// on every paint, whether or not the trade root is the shown panel; its root half (the status
// line and the session rows) applies to the trade root and is kept while that root is visible,
// and dropped by `hide()`.
// ---------------------------------------------------------------------------

/** The tab strip inside `chrome`: one tablist with the frame's tab-strip class, held by the kit
 *  TabBar that is the first of the chrome's three parts (TabBar, sheet, prompt), the four tabs in
 *  order with their catalogued labels, exactly `active` selected (`is-selected`, never the row
 *  cursor's `is-active`); every chrome part at most once, and inside the chrome. */
function expectStrip(chrome: HTMLElement, active: SocialTab, label: string): void {
  expect(document.querySelectorAll('#social-tabs').length, `${label}: one #social-tabs`).toBe(1);
  const strip = byId('social-tabs');
  expect(strip !== chrome && chrome.contains(strip), `${label}: the strip is in the chrome`).toBe(
    true,
  );
  expect(strip.getAttribute('role'), `${label}: a tablist`).toBe('tablist');
  expect(
    strip.classList.contains('mr-frame-tabstrip'),
    `${label}: the strip carries the frame's tab-strip class`,
  ).toBe(true);
  expect(
    [...chrome.children].map((c) => c.id),
    `${label}: the chrome holds the TabBar (no id), then the sheet, then the prompt`,
  ).toEqual(['', 'social-sheet', 'social-prompt']);
  expect(
    chrome.firstElementChild?.classList.contains('mr-tabbar'),
    `${label}: the chrome's first child is the kit TabBar`,
  ).toBe(true);
  expect(
    strip.parentElement,
    `${label}: the strip is held by the TabBar root, the chrome's first child`,
  ).toBe(chrome.firstElementChild);
  const tabs = [...strip.children] as HTMLElement[];
  expect(
    tabs.map((tb) => tb.id),
    `${label}: the four tabs, in order`,
  ).toEqual(SOCIAL_TAB_ORDER.map((tb) => `social-tab-${tb}`));
  expect(
    tabs.map((tb) => tb.getAttribute('role')),
    `${label}: each a tab`,
  ).toEqual(SOCIAL_TAB_ORDER.map(() => 'tab'));
  expect(
    tabs.map((tb) => tb.textContent),
    `${label}: the catalogued labels`,
  ).toEqual(SOCIAL_TAB_ORDER.map((tb) => SOCIAL_TAB_LABEL[tb]()));
  expect(
    tabs.map((tb) => tb.getAttribute('aria-selected')),
    `${label}: only ${active} is aria-selected`,
  ).toEqual(SOCIAL_TAB_ORDER.map((tb) => (tb === active ? 'true' : 'false')));
  expect(
    tabs.map((tb) => tb.classList.contains('is-selected')),
    `${label}: only ${active} is-selected`,
  ).toEqual(SOCIAL_TAB_ORDER.map((tb) => tb === active));
  expect(
    tabs.map((tb) => tb.classList.contains('is-active')),
    `${label}: no tab is is-active (the row cursor's class)`,
  ).toEqual(SOCIAL_TAB_ORDER.map(() => false));
  for (const id of SOCIAL_PART_IDS) {
    const found = document.querySelectorAll(`#${id}`);
    expect(found.length, `${label}: #${id} at most once`).toBeLessThanOrEqual(1);
    const part = found[0];
    if (part !== undefined) {
      expect(chrome.contains(part), `${label}: #${id} is inside the chrome`).toBe(true);
    }
  }
}

interface SheetCase {
  readonly tab: SocialTab;
  readonly actions: readonly SocialAction[];
  readonly active: SocialAction;
}

interface PromptCase extends SheetCase {
  readonly question: SocialQuestion;
  readonly yes: boolean;
}

/** The action sheet shows `c.actions` in order, labelled from the catalog, the cursor on
 *  `c.active` alone. */
function expectSheet(chrome: HTMLElement, c: SheetCase, label: string): void {
  const sheet = byId('social-sheet');
  expect(chrome.contains(sheet), `${label}: #social-sheet is in the chrome`).toBe(true);
  expect(sheet.hidden, `${label}: the sheet shows`).toBe(false);
  expect(sheet.getAttribute('aria-labelledby'), `${label}: the sheet is named by its tab`).toBe(
    `social-tab-${c.tab}`,
  );
  const namingTab = document.getElementById(`social-tab-${c.tab}`);
  expect(
    namingTab !== null && chrome.contains(namingTab),
    `${label}: the tab naming the sheet is in the chrome`,
  ).toBe(true);
  expect(navRows(sheet), `${label}: one row per legal action, the cursor on ${c.active}`).toEqual({
    keys: [...c.actions],
    texts: c.actions.map((a) => SOCIAL_ACTION_LABEL[a]()),
    activeByClass: [c.active],
    activeByAria: [c.active],
  });
}

/** No prompt: `#social-prompt` hidden and empty, or not created yet (before any prompt). */
function expectNoPrompt(label: string): void {
  const prompt = document.getElementById('social-prompt');
  if (prompt === null) return;
  expect(prompt.hidden, `${label}: #social-prompt is hidden`).toBe(true);
  expect(prompt.textContent, `${label}: #social-prompt is empty`).toBe('');
  expect(
    prompt.querySelectorAll('[data-nav-key]').length,
    `${label}: no Yes / No row is left`,
  ).toBe(0);
}

describe('TradeView.paintSocial (ctl-8d, CTL8D.1, CTL8D.2)', () => {
  it('CTL8D-1-VIEW-TABS: paintSocial paints a tablist #social-tabs inside the chrome holding the four tabs Players, Trades, Challenges, Rankings in that order with their catalogued labels and exactly the painted tab selected; it paints on every call, with the trade root hidden too, reuses its parts (one strip, no duplicate id) and adds no child to #trade-overlay while no session row is painted', () => {
    // WRONG IMPL KILLED: a paintSocial that returns early while the trade root is hidden (on
    // Challenges and Rankings the strip would keep the last tab painted); a strip that keeps the
    // first tab selected, or marks a tab by class only or by aria only; tabs in another order or
    // with hand-typed labels; a strip created again on every paint; a part created in the trade
    // root, or in the document, instead of in the chrome element it is handed; a strip without
    // the frame's tab-strip class; and the prompt created before the sheet.
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    const shell = [...overlay.children];
    // While another panel shows, production keeps the chrome in that panel's root.
    const otherRoot = document.createElement('div');
    document.body.appendChild(otherRoot);
    const chrome = document.createElement('div');
    otherRoot.appendChild(chrome);

    // (a) The trade root hidden: the strip is painted all the same.
    expect(view.visible, 'precondition: the trade root is hidden').toBe(false);
    view.paintSocial(chrome, socialPaint({ tab: 'challenges' }));
    expectStrip(chrome, 'challenges', 'hidden root, Challenges');
    const strip = byId('social-tabs');
    view.paintSocial(chrome, socialPaint({ tab: 'rankings' }));
    expectStrip(chrome, 'rankings', 'hidden root, Rankings');
    expect(byId('social-tabs'), 'a repaint reuses the strip').toBe(strip);
    expectChildren(overlay, shell, 'hidden root');
    expect(hiddenTradeParts(), 'the hidden trade root hides nothing').toEqual([]);
    expect(statusMark(), 'and marks nothing').toEqual(UNMARKED);

    // (b) The trade root shown, hosting the chrome as its first child.
    view.show();
    view.hostChrome(chrome);
    for (const tab of ['players', 'trades'] as const) {
      view.paintSocial(chrome, socialPaint({ tab }));
      expectStrip(chrome, tab, `hosted, ${tab}`);
    }
    expect(byId('social-tabs'), 'still the same strip').toBe(strip);
    expectChildren(overlay, [chrome, ...shell], 'hosted');

    // (c) Hidden again, the chrome moved back to the other root: the strip follows the paint.
    view.hide();
    otherRoot.prepend(chrome);
    view.paintSocial(chrome, socialPaint({ tab: 'challenges' }));
    expectStrip(chrome, 'challenges', 'hidden again, Challenges');
    expect(byId('social-tabs'), 'still the same strip').toBe(strip);
    expectChildren(overlay, shell, 'hidden again');

    removeOverlay(overlay);
  });

  it('CTL8D-1-VIEW-PLACEHOLDER: on the Players tab the shown trade root reads the catalogued placeholder in #trade-status and hides no shell part; Players to Trades restores the session-driven status; a session list hidden while it holds the focus hands it to #trade-status, focus outside the root stays put; hide() drops the paint and a paint on the hidden root is not kept', () => {
    // WRONG IMPL KILLED: a placeholder that survives the switch to Trades (the status keeps
    // reading "not available" over open trades); one that survives hide() or a reopen; a Players
    // tab that hides the status (the dialog's focus anchor) or any static part; a hidden session
    // list that strands the focus on <body>, or a hand-off that pulls the focus from outside the
    // root; a paint kept on a hidden root (a stale placeholder at the next open).
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    const status = byId('trade-status');
    const none = i18nT('trade.status.none');
    const open = i18nT('trade.status.open');
    const placeholder = i18nT('social.players.placeholder');
    expect(new Set([none, open, placeholder]).size, 'fixture: three distinct status texts').toBe(3);

    view.show();
    const chrome = document.createElement('div');
    view.hostChrome(chrome);

    // A session row holds the focus; Players hides the list: the focus goes to the anchor.
    view.paintSocial(chrome, socialPaint({ sessions: [BOB_ROW], sessionCursor: BOB_ROW.key }));
    const row = byId('trade-sessions').querySelector<HTMLElement>('[data-nav-key]');
    expect(row, 'fixture: a session row').not.toBeNull();
    row?.setAttribute('tabindex', '-1');
    row?.focus();
    expect(document.activeElement, 'precondition: the session row holds the focus').toBe(row);
    view.paintSocial(chrome, socialPaint({ tab: 'players', sessions: [BOB_ROW] }));
    expect(document.activeElement, 'Players: the hidden list hands the focus to the anchor').toBe(
      status,
    );
    // Control: the same paint with the focus outside the root moves nothing.
    view.paintSocial(chrome, socialPaint({ sessions: [BOB_ROW] }));
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement, 'precondition: the focus is outside the root').toBe(outside);
    view.paintSocial(chrome, socialPaint({ tab: 'players', sessions: [BOB_ROW] }));
    expect(document.activeElement, 'Players with the focus outside the root moves nothing').toBe(
      outside,
    );

    // Players: the placeholder, no shell part hidden.
    expect(status.textContent, 'Players: the placeholder').toBe(placeholder);
    expect(hiddenTradeParts(), 'Players: no shell part hidden').toEqual([]);
    expectNoSessionRows('Players');

    // Players to Trades: the status follows the session rows.
    view.paintSocial(chrome, socialPaint({ sessions: [BOB_ROW] }));
    expect(status.textContent, 'Trades with a session').toBe(open);
    view.paintSocial(chrome, socialPaint({ tab: 'players' }));
    view.paintSocial(chrome, socialPaint());
    expect(status.textContent, 'Trades with no session').toBe(none);

    // hide() drops the paint: the hidden root holds no placeholder, and a reopen starts clean.
    view.paintSocial(chrome, socialPaint({ tab: 'players' }));
    expect(status.textContent, 'precondition: Players again').toBe(placeholder);
    view.hide();
    expect(status.textContent, 'hidden: no placeholder left').toBe(none);
    expect(hiddenTradeParts(), 'hidden: nothing hidden').toEqual([]);
    // A paint on the hidden root is not kept.
    view.paintSocial(chrome, socialPaint({ tab: 'players' }));
    expect(status.textContent, 'hidden root, Players: not kept').toBe(none);
    view.paintSocial(chrome, socialPaint({ sessions: [BOB_ROW] }));
    expect(status.textContent, 'hidden root, a session: not kept').toBe(none);
    view.show();
    expect(status.textContent, 'reopened: no paint kept').toBe(none);
    expect(statusMark(), 'reopened: no mark').toEqual(UNMARKED);

    removeOverlay(overlay);
  });

  it('CTL8D-2-VIEW-SHEET: a sheet paints #social-sheet in the chrome with one row per legal action in order, labelled from the catalog, exactly the active row marked; the Decline prompt paints its question and the Yes / No rows with the cursor row marked while the sheet stays painted beneath; no prompt leaves #social-prompt hidden and empty, no sheet leaves #social-sheet hidden and empty; a part hidden while it holds the focus hands it to the hosting root`s anchor and focus elsewhere stays put', async () => {
    // WRONG IMPL KILLED: a sheet with no cursor, two cursors, or the cursor on the first row
    // whatever `active` says; rows in a fixed order or with hand-typed labels; a prompt that hides
    // the sheet beneath it or marks Yes when `yes` is false (the default-No prompt would read as a
    // default Yes); a closed prompt or sheet that is only hidden and keeps its stale rows; a
    // hidden part that strands the focus inside itself; a handoff that pulls the focus to the
    // anchor on every paint; a handoff hard-coded to #trade-status (hidden on Challenges: the
    // focus is stranded); and a nameless sheet or Yes / No listbox (no aria-labelledby).
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    view.show();
    await flushMacrotask(); // the open's deferred focus lands now, so it cannot move focus later
    const chrome = document.createElement('div');
    view.hostChrome(chrome);
    const anchor = byId('trade-status');

    // Sheets: every action label, every cursor position.
    const sheets: readonly SheetCase[] = [
      { tab: 'challenges', actions: ['accept', 'decline'], active: 'accept' },
      { tab: 'challenges', actions: ['accept', 'decline'], active: 'decline' },
      { tab: 'challenges', actions: ['cancel'], active: 'cancel' },
      { tab: 'trades', actions: ['accept', 'decline'], active: 'decline' },
    ];
    for (const c of sheets) {
      const label = `sheet ${c.actions.join('/')} on ${c.active}`;
      view.paintSocial(
        chrome,
        socialPaint({ tab: c.tab, sheet: { actions: c.actions, active: c.active } }),
      );
      expectSheet(chrome, c, label);
      expectNoPrompt(label);
    }

    // The prompt: Yes and No; the sheet stays painted beneath.
    const prompts: readonly PromptCase[] = [
      {
        tab: 'challenges',
        actions: ['accept', 'decline'],
        active: 'decline',
        question: 'declineChallenge',
        yes: false,
      },
      {
        tab: 'challenges',
        actions: ['accept', 'decline'],
        active: 'decline',
        question: 'declineChallenge',
        yes: true,
      },
    ];
    for (const c of prompts) {
      const label = `prompt ${c.question}, ${c.yes ? 'Yes' : 'No'}`;
      view.paintSocial(
        chrome,
        socialPaint({
          tab: c.tab,
          sheet: { actions: c.actions, active: c.active },
          confirm: { question: c.question, yes: c.yes },
        }),
      );
      const prompt = byId('social-prompt');
      const text = byId('social-prompt-text');
      const confirm = byId('social-confirm');
      expect(chrome.contains(prompt), `${label}: #social-prompt is in the chrome`).toBe(true);
      expect(prompt.hidden, `${label}: the prompt shows`).toBe(false);
      expect(
        prompt.contains(text) && prompt.contains(confirm),
        `${label}: the question and the Yes / No rows are in #social-prompt`,
      ).toBe(true);
      expect(text.textContent, `${label}: the catalogued question`).toBe(
        SOCIAL_QUESTION_TEXT[c.question](),
      );
      expect(
        confirm.getAttribute('aria-labelledby'),
        `${label}: the Yes / No rows are named by the question`,
      ).toBe('social-prompt-text');
      const cursor = c.yes ? 'yes' : 'no';
      expect(navRows(confirm), `${label}: Yes then No, the cursor on ${cursor}`).toEqual({
        keys: ['yes', 'no'],
        texts: [i18nT('prompt.yes'), i18nT('prompt.no')],
        activeByClass: [cursor],
        activeByAria: [cursor],
      });
      expectSheet(chrome, c, `${label}: the sheet beneath`);
    }

    // The prompt closes; the sheet stays on its action.
    const decline: SheetCase = {
      tab: 'challenges',
      actions: ['accept', 'decline'],
      active: 'decline',
    };
    view.paintSocial(
      chrome,
      socialPaint({
        tab: decline.tab,
        sheet: { actions: decline.actions, active: decline.active },
      }),
    );
    expect(document.getElementById('social-prompt'), 'precondition: a prompt was painted').not.toBe(
      null,
    );
    expectNoPrompt('the prompt closed');
    expectSheet(chrome, decline, 'the sheet after the prompt closed');

    // No sheet: hidden and empty.
    view.paintSocial(chrome, socialPaint({ tab: 'challenges' }));
    const sheet = byId('social-sheet');
    expect(sheet.hidden, 'no sheet: #social-sheet is hidden').toBe(true);
    expect(sheet.childElementCount, 'no sheet: no row is left').toBe(0);
    expect(sheet.textContent, 'no sheet: no text is left').toBe('');
    expectNoPrompt('no sheet');

    // A part hidden while it holds the focus hands it to the trade root's [tabindex="-1"] anchor.
    view.paintSocial(
      chrome,
      socialPaint({ tab: 'trades', sheet: { actions: ['accept', 'decline'], active: 'accept' } }),
    );
    byId('social-sheet').focus();
    expect(document.activeElement, 'precondition: the sheet holds the focus').toBe(
      byId('social-sheet'),
    );
    view.paintSocial(chrome, socialPaint({ tab: 'trades' }));
    expect(document.activeElement, 'the closed sheet hands the focus to the anchor').toBe(anchor);

    view.paintSocial(
      chrome,
      socialPaint({
        tab: 'trades',
        sheet: { actions: ['accept', 'decline'], active: 'decline' },
        confirm: { question: 'declineChallenge', yes: false },
      }),
    );
    byId('social-confirm').focus();
    expect(document.activeElement, 'precondition: the Yes / No rows hold the focus').toBe(
      byId('social-confirm'),
    );
    view.paintSocial(
      chrome,
      socialPaint({ tab: 'trades', sheet: { actions: ['accept', 'decline'], active: 'decline' } }),
    );
    expect(document.activeElement, 'the closed prompt hands the focus to the anchor').toBe(anchor);

    // Control: a part hidden while the focus is elsewhere in the root moves nothing.
    const elsewhere = s3InsideSentinel(overlay);
    elsewhere.focus();
    expect(document.activeElement, 'precondition: an element in the root holds the focus').toBe(
      elsewhere,
    );
    view.paintSocial(chrome, socialPaint({ tab: 'trades' }));
    expect(document.activeElement, 'focus outside the hidden sheet stays put').toBe(elsewhere);

    // On another panel the chrome is that panel's root's first child (the pvp shell's shape), so
    // the hand-off goes to THAT root's anchor: focus sent to the hidden #trade-status would be
    // stranded.
    view.hide();
    const standInRoot = document.createElement('div');
    const standInAnchor = document.createElement('div');
    standInAnchor.setAttribute('tabindex', '-1');
    document.body.appendChild(standInRoot);
    standInRoot.append(chrome, standInAnchor);
    view.paintSocial(
      chrome,
      socialPaint({
        tab: 'challenges',
        sheet: { actions: ['accept', 'decline'], active: 'accept' },
      }),
    );
    byId('social-sheet').focus();
    expect(document.activeElement, 'precondition: the sheet holds the focus on Challenges').toBe(
      byId('social-sheet'),
    );
    view.paintSocial(chrome, socialPaint({ tab: 'challenges' }));
    expect(
      document.activeElement,
      'the closed sheet hands the focus to the hosting root`s anchor',
    ).toBe(standInAnchor);
    expect(document.activeElement, 'never to the hidden #trade-status').not.toBe(anchor);

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// uif-9 (UIF9.1): the Social tabs render through the ONE kit TabBar, held by the shared chrome.
// ---------------------------------------------------------------------------

describe('TradeView.paintSocial hosts the kit TabBar (uif-9, UIF9.1)', () => {
  it('UIF9.1 the chrome`s first child is the TabBar root (class mr-tabbar, not hidden) holding, in order, an LB chip, the #social-tabs tablist and an RB chip (chips aria-hidden, data-button, no text); the four tabs in order carry the catalogued labels with the painted one aria-selected and is-selected and never is-active; a repaint, on any tab and on a moved chrome, reuses the same bar and strip nodes; the chrome is [TabBar, #social-sheet, #social-prompt] and the trade root gains only the hosted chrome', () => {
    // WRONG IMPL KILLED: the bare strip left as the chrome's first child (no `.mr-tabbar` root, no
    // chips); a TabBar appended after the sheet or the prompt (not top-anchored); a second bar
    // created on every paint or per panel; chips that carry text or are not aria-hidden; the
    // selected tab marked `is-active` or by aria alone; a bar left `hidden` after a paint; a strip
    // without role=tablist; a bar created inside the trade root's own children.
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    const shell = [...overlay.children];
    const chrome = document.createElement('div');
    view.hostChrome(chrome);

    view.paintSocial(chrome, socialPaint({ tab: 'challenges' }));
    const bar = chrome.firstElementChild as HTMLElement;
    expect(bar, 'the chrome has a first child').not.toBeNull();
    expect(bar.classList.contains('mr-tabbar'), 'the first child is the TabBar root').toBe(true);
    expect(bar.hidden, 'a painted TabBar is not hidden').toBe(false);
    expect(
      [...bar.children].map((c) => c.getAttribute('data-button') ?? c.id),
      'the bar holds LB, the #social-tabs strip, then RB',
    ).toEqual(['LB', 'social-tabs', 'RB']);
    const [lb, strip, rb] = [...bar.children] as HTMLElement[];
    for (const chip of [lb, rb] as HTMLElement[]) {
      expect(chip.getAttribute('aria-hidden'), 'a chip is hidden from assistive technology').toBe(
        'true',
      );
      expect(chip.textContent, 'the kit writes no chip text (CSS draws the letters)').toBe('');
      expect(chip.children.length, 'a chip holds no element').toBe(0);
    }
    expect(strip?.getAttribute('role'), 'the strip is the tablist').toBe('tablist');
    expect(document.querySelectorAll('.mr-tabbar').length, 'one TabBar in the document').toBe(1);
    expect(document.querySelectorAll('#social-tabs').length, 'one strip in the document').toBe(1);
    expectStrip(chrome, 'challenges', 'first paint, Challenges');

    // Every tab selected in turn: the same nodes, the selection moves.
    for (const tab of SOCIAL_TAB_ORDER) {
      view.paintSocial(chrome, socialPaint({ tab }));
      expect(chrome.firstElementChild, `${tab}: the same bar`).toBe(bar);
      expect(byId('social-tabs'), `${tab}: the same strip`).toBe(strip);
      expect(bar.hidden, `${tab}: not hidden`).toBe(false);
      expectStrip(chrome, tab, `repaint, ${tab}`);
      expect(
        [...(strip as HTMLElement).children].map((el) => el.classList.contains('is-selected')),
        `${tab}: is-selected on the painted tab alone`,
      ).toEqual(SOCIAL_TAB_ORDER.map((tb) => tb === tab));
    }

    // The trade root: only the hosted chrome was added.
    expect(overlay.firstElementChild, 'the chrome is the trade root`s first child').toBe(chrome);
    expect(overlay.children.length, 'the root gained the chrome and nothing else').toBe(
      shell.length + 1,
    );
    for (const [i, child] of shell.entries()) {
      expect(overlay.children[i + 1], `shell child ${i} is unchanged`).toBe(child);
      expect(child.classList.contains('mr-tabbar'), `shell child ${i} is no TabBar`).toBe(false);
      expect(child.querySelector('.mr-tabbar'), `shell child ${i} holds no TabBar`).toBeNull();
    }

    // The chrome moved to another root and painted there: still the one bar, still first.
    const otherRoot = document.createElement('div');
    document.body.appendChild(otherRoot);
    otherRoot.prepend(chrome);
    view.paintSocial(chrome, socialPaint({ tab: 'rankings' }));
    expect(chrome.firstElementChild, 'moved chrome: the same bar, still first').toBe(bar);
    expect(document.querySelectorAll('.mr-tabbar').length, 'moved chrome: still one TabBar').toBe(
      1,
    );
    expectStrip(chrome, 'rankings', 'moved chrome, Rankings');

    removeOverlay(overlay);
  });

  it('UIF9.1 the TabBar is created in the chrome handed to the painter even when the trade root is hidden, and a chrome that already holds one bar is not given a second', () => {
    // WRONG IMPL KILLED: a painter that returns early while the trade root is hidden; a bar
    // created into the document or the trade root instead of the chrome; a locate-by-id that
    // misses the bar and builds a second one on the next paint.
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    const chrome = document.createElement('div');
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(chrome);

    expect(view.visible, 'precondition: the trade root is hidden').toBe(false);
    view.paintSocial(chrome, socialPaint({ tab: 'rankings' }));
    expect(chrome.querySelectorAll('.mr-tabbar').length, 'the hidden-root paint made one bar').toBe(
      1,
    );
    expect(overlay.querySelector('.mr-tabbar'), 'none in the trade root').toBeNull();
    const bar = chrome.firstElementChild;
    view.paintSocial(chrome, socialPaint({ tab: 'players' }));
    view.paintSocial(chrome, socialPaint({ tab: 'rankings' }));
    expect(chrome.querySelectorAll('.mr-tabbar').length, 'repaints made no second bar').toBe(1);
    expect(chrome.firstElementChild, 'and kept the first').toBe(bar);
    expect(chrome.querySelectorAll('[data-button]').length, 'two chips, no more').toBe(2);

    removeOverlay(overlay);
  });

  it('UIF9.4 the Trades panel holds no RowCard: session rows painted with the cursor on one, and an empty Trades tab, both leave the root with no .mr-card', () => {
    // WRONG IMPL KILLED: a card wrapped around the trade status or a session row; a card the trade
    // root keeps after the rows go.
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    const chrome = document.createElement('div');
    view.show();
    view.hostChrome(chrome);
    view.paintSocial(
      chrome,
      socialPaint({ sessions: [BOB_ROW, CAROL_ROW], sessionCursor: BOB_ROW.key }),
    );
    expect(navRows(byId('trade-sessions')).activeByAria, 'precondition: the rows are live').toEqual(
      [BOB_ROW.key],
    );
    expect(overlay.querySelectorAll('.mr-card').length, 'session rows: no card').toBe(0);
    view.paintSocial(chrome, socialPaint());
    expect(overlay.querySelectorAll('.mr-card').length, 'no session: no card').toBe(0);
    expect(overlay.querySelectorAll('.mr-card-title').length, 'and no card title').toBe(0);

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// ts-3 (ts-3.5): the session rows on the Trades panel. The rows are painted into a runtime
// `#trade-sessions` (renderNav, frame `socialTrades`) appended to the root, `hidden` while there
// are none or the tab is not Trades; each row reads `trade.row.title` and `trade.row.marks`.
// The list is created at RUNTIME (never by the constructor: CTL8S-3-HOST-CHROME-TRADE and
// CTL8D-1-VIEW-TABS pin the shell's children with no session painted).
// ---------------------------------------------------------------------------

describe('TradeView.paintSocial — the session rows (ts-3, ts-3.5)', () => {
  it('ts-3.5 on the Trades tab paintSocial paints one #trade-sessions row per session in order, each reading its partner`s title and its marks, the cursor on sessionCursor alone; the list is a child of the root and hidden off the Trades tab and with no session', () => {
    // WRONG IMPL KILLED: one row for all sessions (or only the first); rows out of order; a row
    // without the partner's name or with both marks read the same; no cursor, or a cursor mark on
    // the status line too; a list painted over the Challenges panel or left showing after the
    // last session closed; a list created by the constructor.
    const overlay = mountTradeOverlay();
    const view = new TradeView();
    view.show();
    const chrome = document.createElement('div');
    view.hostChrome(chrome);
    expectNoSessionRows('before any session');

    view.paintSocial(
      chrome,
      socialPaint({ sessions: [BOB_ROW, CAROL_ROW], sessionCursor: 'session-102' }),
    );
    const ul = byId('trade-sessions');
    expect(ul.parentElement, 'a child of the trade root').toBe(overlay);
    expect(ul.hidden).toBe(false);
    const rows = navRows(ul);
    expect(rows.keys).toEqual(['session-101', 'session-102']);
    expect(rows.activeByAria, 'the cursor on session 102 alone').toEqual(['session-102']);
    expect(rows.activeByClass).toEqual(['session-102']);
    expect(rows.texts[0]).toContain(i18nTf('trade.row.title', { name: 'Bob' }));
    expect(rows.texts[1]).toContain(i18nTf('trade.row.title', { name: 'Carol' }));
    expect(rows.texts[0], 'the marks differ, so the row texts differ past the name').not.toBe(
      rows.texts[1]?.replace('Carol', 'Bob'),
    );
    expect(statusMark(), 'the status line carries no cursor').toEqual(UNMARKED);

    // No cursor on a session: no row selected.
    view.paintSocial(chrome, socialPaint({ sessions: [BOB_ROW, CAROL_ROW], sessionCursor: null }));
    expect(navRows(ul).activeByAria).toEqual([]);

    // Off the Trades tab: hidden. Back, then the last session closes: hidden again.
    view.paintSocial(chrome, socialPaint({ tab: 'challenges', sessions: [BOB_ROW, CAROL_ROW] }));
    expect(ul.hidden, 'Challenges: hidden').toBe(true);
    view.paintSocial(chrome, socialPaint({ sessions: [BOB_ROW] }));
    expect(ul.hidden).toBe(false);
    expect(navRows(ul).keys).toEqual(['session-101']);
    view.paintSocial(chrome, socialPaint({ sessions: [] }));
    expect(ul.hidden, 'no session: hidden').toBe(true);
    expect(byId('trade-sessions'), 'one list, reused').toBe(ul);
    expect(document.querySelectorAll('#trade-sessions').length).toBe(1);

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// ts-4 (ts-4.6): the trade root lists only session rows; the legacy offer surface is gone.
// ---------------------------------------------------------------------------

/** Every paint shape the Social screen can hand the view: each tab, with no / one / two session
 *  rows, the session cursor on a row or none, a sheet and a prompt. */
function paintMatrix(): readonly SocialPaint[] {
  const out: SocialPaint[] = [];
  for (const tab of SOCIAL_TAB_ORDER) {
    for (const sessions of [[], [BOB_ROW], [BOB_ROW, CAROL_ROW]] as const) {
      out.push(socialPaint({ tab, sessions }));
      if (sessions.length > 0 && tab === 'trades') {
        out.push(socialPaint({ tab, sessions, sessionCursor: BOB_ROW.key }));
      }
      out.push(
        socialPaint({
          tab,
          sessions,
          sheet: { actions: ['accept', 'decline'], active: 'decline' },
          confirm: { question: 'declineChallenge', yes: false },
        }),
      );
    }
  }
  return out;
}

/** The status line the contract derives from a kept paint (null: no paint kept). */
function expectedStatus(p: SocialPaint | null): string {
  if (p === null) return i18nT('trade.status.none');
  if (p.tab === 'players') return i18nT('social.players.placeholder');
  return p.tab === 'trades' && p.sessions.length > 0
    ? i18nT('trade.status.open')
    : i18nT('trade.status.none');
}

describe('TradeView — only session rows on the trade root (ts-4, ts-4.6)', () => {
  it('ts-4.6 new TradeView() takes no argument and the view has no render member', () => {
    // WRONG IMPL KILLED: a constructor that still declares a callbacks parameter (TradeCallbacks
    // kept); a `render` method (the legacy-offer render path) left on the class or the instance.
    mountTradeOverlay();
    expect(TradeView.length, 'the constructor declares no parameter').toBe(0);
    const view = new TradeView();
    expect(Reflect.has(view, 'render'), 'no render member on the instance').toBe(false);
    expect(
      Reflect.has(TradeView.prototype as unknown as Record<string, unknown>, 'render'),
      'no render on the prototype',
    ).toBe(false);
  });

  it('ts-4.6 the constructor needs only #trade-overlay and #trade-status: over a shell without the four static parts it constructs, shows, paints every shape and hides without a throw', () => {
    // WRONG IMPL KILLED: a constructor that still looks up #trade-my-side, #trade-their-side,
    // #trade-actions or #trade-feedback (a throw on this shell); a paint that reaches for one of
    // them (a TypeError on null).
    const overlay = mountTradeOverlay({ full: false });
    expect(
      [...overlay.children].map((c) => c.id),
      'fixture: the status line alone',
    ).toEqual(['trade-status']);
    let view: TradeView | null = null;
    expect(() => {
      view = new TradeView();
    }, 'construct').not.toThrow();
    const v = view as unknown as TradeView;
    const chrome = document.createElement('div');
    expect(() => {
      v.show();
      v.hostChrome(chrome);
      for (const p of paintMatrix()) v.paintSocial(chrome, p);
      v.toggle();
      v.toggle();
      v.hide();
    }, 'show, paint, toggle and hide').not.toThrow();
    expect(byId('trade-status').textContent, 'and the status line is written').toBe(
      i18nT('trade.status.none'),
    );
    // Without #trade-status the constructor refuses (it is the dialog's focus anchor).
    document.body.innerHTML = '';
    const bare = document.createElement('div');
    bare.id = 'trade-overlay';
    document.body.appendChild(bare);
    expect(() => new TradeView(), 'no status line: a throw').toThrow();
  });

  it('ts-4.6 the status line is a function of the kept Social paint alone: Players reads the placeholder, Trades with a session row reads trade.status.open, Trades with none and every other tab read trade.status.none, and with no paint kept (never painted, after hide, a paint on the hidden root) it reads trade.status.none', () => {
    // WRONG IMPL KILLED: a status kept from an earlier paint or render (a stale "Open trades"
    // after the last session closed, or "No active trade" over open sessions); a status that is
    // '' or the shell's text before any paint is kept; the session count read on the Challenges or
    // Rankings tab; a hidden root that keeps its paint.
    mountTradeOverlay();
    const view = new TradeView();
    const status = byId('trade-status');
    const chrome = document.createElement('div');
    view.hide();
    expect(status.textContent, 'never painted, hidden: none').toBe(expectedStatus(null));
    view.show();
    view.hostChrome(chrome);
    // Every paint, in order and then reversed, so each follows a different predecessor.
    const matrix = paintMatrix();
    let checked = 0;
    for (const p of [...matrix, ...[...matrix].reverse()]) {
      view.paintSocial(chrome, p);
      expect(
        status.textContent,
        `${p.tab}, ${p.sessions.length} session(s), sheet ${p.sheet !== null}`,
      ).toBe(expectedStatus(p));
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every shape both ways').toBe(matrix.length * 2);
    view.paintSocial(chrome, socialPaint({ sessions: [BOB_ROW] }));
    expect(status.textContent, 'precondition: open').toBe(
      expectedStatus(socialPaint({ sessions: [BOB_ROW] })),
    );
    view.hide();
    expect(status.textContent, 'hidden: no paint kept').toBe(expectedStatus(null));
    view.paintSocial(chrome, socialPaint({ tab: 'players' }));
    expect(status.textContent, 'a paint on the hidden root is not kept').toBe(expectedStatus(null));
  });

  it('ts-4.6 #trade-status never carries mr-nav-item, is-active or aria-current, whatever the paint (every tab, session cursor or none, a sheet, a prompt, and a paint object that also carries a stray tradeCursor: true)', () => {
    // WRONG IMPL KILLED: the legacy trade row's cursor mark kept on the status line (it would
    // paint a second cursor beside the session row's); a mark switched on by a stray paint field.
    mountTradeOverlay();
    const view = new TradeView();
    view.show();
    const chrome = document.createElement('div');
    view.hostChrome(chrome);
    let checked = 0;
    for (const p of paintMatrix()) {
      for (const paint of [p, { ...p, tradeCursor: true } as unknown as SocialPaint]) {
        view.paintSocial(chrome, paint);
        expect(statusMark(), `${paint.tab}, ${paint.sessions.length} session(s)`).toEqual(UNMARKED);
        checked += 1;
      }
    }
    expect(checked, 'ANTI-VACUITY: every shape, with and without the stray field').toBe(
      paintMatrix().length * 2,
    );
    view.hide();
    expect(statusMark(), 'hidden').toEqual(UNMARKED);
  });

  it('ts-4.6 the view never writes #trade-my-side, #trade-their-side, #trade-actions or #trade-feedback: through show, every paint shape, toggle and hide each keeps its exact children, text, hidden flag and attributes, and no mutation is recorded on any of them', async () => {
    // WRONG IMPL KILLED: a Players tab that still hides the sides and the actions; a view that
    // clears (replaceChildren) or writes a side; any attribute or child written on one of the
    // four static nodes.
    mountTradeOverlay();
    const view = new TradeView();
    const parts = STATIC_PARTS.map(byId);
    for (const part of parts) {
      const sentinel = document.createElement('span');
      sentinel.textContent = `${part.id} sentinel`;
      part.appendChild(sentinel);
    }
    const snapshot = () =>
      parts.map((part) => ({
        id: part.id,
        html: part.outerHTML,
        hidden: part.hidden,
        children: [...part.childNodes],
      }));
    const before = snapshot();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => {
      records.push(...batch);
    });
    for (const part of parts) {
      observer.observe(part, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    const chrome = document.createElement('div');
    view.show();
    view.hostChrome(chrome);
    for (const p of paintMatrix()) view.paintSocial(chrome, p);
    view.toggle();
    view.toggle();
    view.paintSocial(chrome, socialPaint({ tab: 'players', sessions: [BOB_ROW] }));
    view.hide();
    await flushMacrotask();
    observer.disconnect();

    expect(snapshot(), 'each static part exactly as it was').toEqual(before);
    expect(
      records.map((r) => `${(r.target as Element).id || r.target.nodeName}:${r.type}`),
      'no mutation on the four static parts',
    ).toEqual([]);
  });

  it('ts-4.6 the sheet offers only Accept, Decline and Cancel, each read from its social.action id, and the only prompt question is the challenge Decline`s', () => {
    // WRONG IMPL KILLED: a sheet label resolved from another id (a legacy trade label); a prompt
    // question resolved from another id than social.confirm.declineChallenge.
    mountTradeOverlay();
    const view = new TradeView();
    view.show();
    const chrome = document.createElement('div');
    view.hostChrome(chrome);
    vi.mocked(i18nT).mockClear();
    view.paintSocial(
      chrome,
      socialPaint({
        tab: 'challenges',
        sheet: { actions: ['accept', 'decline', 'cancel'], active: 'cancel' },
        confirm: { question: 'declineChallenge', yes: true },
      }),
    );
    // Read off the spy before the assertions below resolve their expected labels through it.
    const ids = new Set(vi.mocked(i18nT).mock.calls.map(([id]) => String(id)));
    expect(
      [...ids]
        .filter((id) => id.startsWith('social.action.') || id.startsWith('social.confirm.'))
        .sort(),
      'the action and question ids the paint read',
    ).toEqual([
      'social.action.accept',
      'social.action.cancel',
      'social.action.decline',
      'social.confirm.declineChallenge',
    ]);
    expect(navRows(byId('social-sheet')).texts, 'the three labels, in order').toEqual([
      SOCIAL_ACTION_LABEL.accept(),
      SOCIAL_ACTION_LABEL.decline(),
      SOCIAL_ACTION_LABEL.cancel(),
    ]);
    expect(byId('social-prompt-text').textContent).toBe(SOCIAL_QUESTION_TEXT.declineChallenge());
  });
});
