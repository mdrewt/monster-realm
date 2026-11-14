// @vitest-environment happy-dom
// ui/claimView.i18n.test.ts — the claim section's labels route through t() from BOTH open doors:
// CV-01/02 for the five action buttons, and the Account frame title.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (Tests, Key roster claim.*,
// D2), plan-revisions.md MAJOR-1 (BOTH doors — show() AND render() — write the label).
//
// Do NOT edit these tests to match a buggy implementation — correct them from the
// plan/plan-revisions/ADR-0261 only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimViewModel } from './claimModel';
import { ClaimView, type ClaimViewHandlers } from './claimView';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
import { t as i18nT, setLocale } from './i18n/resolver';
import { closeOverlayA11y } from './overlayA11y';
import { OVERLAY_IDS } from './overlayRegistry';

// The m24s5 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the DOM byte-identity assertions below still work.
vi.mock('./i18n/resolver', { spy: true });

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0). */
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
});

// claimView.ts's `ensureElement` creates every node fresh whenever the DOM lacks it (it is never
// rendered by index.html), so no manual fixture is needed — a clean `document.body` per test
// (the file-level beforeEach above) is what makes each `new ClaimView(...)` build fresh nodes.

function makeHandlers(): ClaimViewHandlers {
  return {
    onSignIn: vi.fn(),
    onJoin: vi.fn(),
    onDeclineRequested: vi.fn(),
    onDeclineConfirmed: vi.fn(),
    onDeclineCancelled: vi.fn(),
    // The required dismissal, called from every hide().
    onDismissed: vi.fn(),
  };
}

/** uif-16b: `claimView` is no longer an OverlayId (the section opens no a11y of its own), so the
 *  per-id close this file used becomes the all-id sweep. */
function sweepA11y(): void {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
}

/** vm strings deliberately avoid every roster word (the English action labels). */
function makeVm(overrides: Partial<ClaimViewModel> = {}): ClaimViewModel {
  return {
    visible: true,
    title: 'Keep your guest progress',
    body: 'Sign in to keep what you made as a guest.',
    confirmPrompt: undefined,
    nudge: undefined,
    feedback: undefined,
    actions: {
      signIn: true,
      join: false,
      decline: true,
      declineConfirm: false,
      declineCancel: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// m24s5 SplitSentinels / WalkSubtree / AssertNoRosterWord trio.
// ---------------------------------------------------------------------------

const M24S5_CV_PLAIN_KEYS = new Set([
  'claim.signInButton',
  'claim.joinButton',
  'claim.declineButton',
  'claim.declineConfirmButton',
  'claim.declineCancelButton',
  'menu.profile.account.title',
]);

function m24s5CvSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (M24S5_CV_PLAIN_KEYS.has(content)) {
      // Elide — a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function m24s5CvWalkSubtree(root: HTMLElement): string[] {
  const texts: string[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    const titleAttr = el.getAttribute('title');
    if (titleAttr) texts.push(titleAttr);
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) texts.push(node.textContent ?? '');
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return texts;
}

/** The English action labels (the vm strings above avoid all of them). */
const M24S5_CV_ROSTER = ['Continue playing', 'Yes, decline', 'Keep my code', 'Decline'];

/** Each action button's id and the plain catalog key its label resolves through. */
const ACTION_LABELS = [
  ['claim-signin-btn', 'claim.signInButton'],
  ['claim-join-btn', 'claim.joinButton'],
  ['claim-decline-btn', 'claim.declineButton'],
  ['claim-decline-confirm-btn', 'claim.declineConfirmButton'],
  ['claim-decline-cancel-btn', 'claim.declineCancelButton'],
] as const;

const enLabel = (key: (typeof ACTION_LABELS)[number][1]): string => {
  const entry = (CATALOG_EN as Record<string, unknown>)[key];
  if (typeof entry !== 'string') throw new Error(`${key} must be a plain message`);
  return entry;
};

function m24s5CvAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s5CvSplitSentinels(texts.join('\n'));
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel`,
  ).toEqual([]);
  for (const word of M24S5_CV_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s5 (ADR-0261): claimView.ts routes the action labels through t() from BOTH open doors', () => {
  it('m24s5 CV-01: each action label resolves in show() AND render(), is never written by the constructor, is requested again on every call from each door, and the retired privacy label is never requested', async () => {
    const view = new ClaimView(makeHandlers());
    const btn = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement;

    for (const [id, key] of ACTION_LABELS) {
      expect(btn(id).textContent, `${id}: the constructor writes no label`).toBe('');
      expect(i18nT).not.toHaveBeenCalledWith(key);
    }

    // Door 1: show() alone, no render().
    view.show();
    for (const [id, key] of ACTION_LABELS) {
      expect(i18nT, `show() resolves ${key}`).toHaveBeenCalledWith(key);
      expect(btn(id).textContent, `${id}: the English bytes`).toBe(enLabel(key));
    }

    // RT2: a repeat show() on an already-open overlay re-resolves the keys.
    vi.mocked(i18nT).mockClear();
    view.show();
    for (const [, key] of ACTION_LABELS) {
      expect(i18nT, `repeat show() must re-resolve ${key}`).toHaveBeenCalledWith(key);
    }

    // Clean DOM + overlay-a11y record before a second, FRESH view (claimView.test.ts idiom).
    sweepA11y();
    await flushMacrotask();
    document.body.innerHTML = '';

    // Door 2: render(visible vm) alone, no show().
    const freshView = new ClaimView(makeHandlers());
    for (const [id] of ACTION_LABELS) expect(btn(id).textContent).toBe('');
    vi.mocked(i18nT).mockClear();

    freshView.render(makeVm());
    for (const [id, key] of ACTION_LABELS) {
      expect(i18nT, `render() resolves ${key}`).toHaveBeenCalledWith(key);
      expect(btn(id).textContent, `${id}: the English bytes`).toBe(enLabel(key));
    }

    // RT2 (render door): a repeat render() re-resolves the keys.
    vi.mocked(i18nT).mockClear();
    freshView.render(makeVm());
    for (const [, key] of ACTION_LABELS) {
      expect(i18nT, `repeat render() must re-resolve ${key}`).toHaveBeenCalledWith(key);
    }

    // NEGATIVE: the retired privacy label is requested by no door, and the Privacy title never
    // routes through this view.
    expect(i18nT).not.toHaveBeenCalledWith('claim.privacyButton');
    expect(i18nT).not.toHaveBeenCalledWith('privacy.title');
    expect(document.getElementById('claim-privacy-btn'), 'no privacy door in the DOM').toBeNull();

    sweepA11y();
    await flushMacrotask();
  });

  it('m24s5 CV-02: under «key» sentinel every action label shows resolver output via BOTH doors, and never the raw English label outside a sentinel; vm strings avoid the roster words', () => {
    // Constructed BEFORE the sentinel mockImplementation.
    const view = new ClaimView(makeHandlers());
    const overlay = document.getElementById('claim-overlay') as HTMLElement;

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.show();
      let texts = m24s5CvWalkSubtree(overlay);
      m24s5CvAssertNoRosterWord(texts, 'show() door');
      for (const [, key] of ACTION_LABELS) {
        expect(texts.join('\n')).toContain(`«${key}»`);
      }

      view.render(makeVm({ title: 'Keep your session', body: 'Sign in to keep it.' }));
      texts = m24s5CvWalkSubtree(overlay);
      m24s5CvAssertNoRosterWord(texts, 'render() door');
      const joined = texts.join('\n');
      for (const [, key] of ACTION_LABELS) {
        expect(joined).toContain(`«${key}»`);
      }
      expect(joined, 'no retired privacy sentinel').not.toContain('«claim.privacyButton»');
      expect(joined, 'vm.title stays raw').toContain('Keep your session');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('How to Play');
  });
});

describe('qf-13 (QF13.1): the Account frame title routes menu.profile.account.title through t() from BOTH open doors', () => {
  const KEY = 'menu.profile.account.title' as const;
  const plain = (catalog: object): string => {
    const entry = (catalog as Record<string, unknown>)[KEY];
    if (typeof entry !== 'string') throw new Error(`${KEY} must be a plain message`);
    return entry;
  };
  const titleOf = (): HTMLElement => document.getElementById('claim-frame-title') as HTMLElement;

  it('the key is requested by render() AND by show(), on every call (repeats included) and never by the constructor, renders as the «key» sentinel through both doors, and shows the French catalogue value under the fr locale [QF13-1-ACCOUNT-TITLE-I18N]', async () => {
    // WRONG IMPL KILLED: a title written in the constructor (the locale may be negotiated after
    // the view is built); a write in only ONE door (main.ts's onSignInFailed calls show() BEFORE
    // renderClaim(), and a reconnect-driven render alone re-opens the frame); a write gated on the
    // hidden -> visible edge (a repeat call would not re-resolve after a locale switch);
    // hard-coded English (the sentinel and fr checks below never see a resolver result); a title
    // read from the English catalogue directly instead of t().
    const view = new ClaimView(makeHandlers());
    const overlay = document.getElementById('claim-overlay') as HTMLElement;
    expect(i18nT, 'the constructor must not resolve the title').not.toHaveBeenCalledWith(KEY);
    expect(titleOf(), 'ANTI-VACUITY: the bar title exists before any open').not.toBeNull();
    expect(titleOf().textContent, 'and is empty until an open door writes it').toBe('');

    // Door 1: show() alone.
    view.show();
    expect(i18nT, 'show() resolves the title').toHaveBeenCalledWith(KEY);
    expect(titleOf().textContent).toBe(plain(CATALOG_EN));
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(i18nT, 'a repeat show() re-resolves the title').toHaveBeenCalledWith(KEY);

    // fr, through show() on the already-open frame.
    try {
      setLocale('fr');
      view.show();
      expect(titleOf().textContent, 'show() under fr: the French catalogue value').toBe(
        plain(CATALOG_FR),
      );
    } finally {
      setLocale('en');
    }

    // Under the «key» sentinel, show() door.
    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      view.show();
      expect(titleOf().textContent, 'show() door: exactly the sentinel').toBe(`«${KEY}»`);
      m24s5CvAssertNoRosterWord(m24s5CvWalkSubtree(overlay), 'show() door');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Door 2: a FRESH view, render() alone, no show().
    sweepA11y();
    await flushMacrotask();
    document.body.innerHTML = '';
    vi.mocked(i18nT).mockClear();
    const fresh = new ClaimView(makeHandlers());
    const freshOverlay = document.getElementById('claim-overlay') as HTMLElement;
    expect(i18nT, 'the second constructor does not resolve it either').not.toHaveBeenCalledWith(
      KEY,
    );
    expect(titleOf().textContent, 'the fresh bar is empty before render()').toBe('');

    fresh.render(makeVm());
    expect(i18nT, 'render() resolves the title').toHaveBeenCalledWith(KEY);
    expect(titleOf().textContent).toBe(plain(CATALOG_EN));
    vi.mocked(i18nT).mockClear();
    fresh.render(makeVm());
    expect(i18nT, 'a repeat render() re-resolves the title').toHaveBeenCalledWith(KEY);

    try {
      setLocale('fr');
      fresh.render(makeVm());
      expect(titleOf().textContent, 'render() under fr: the French catalogue value').toBe(
        plain(CATALOG_FR),
      );
    } finally {
      setLocale('en');
    }

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      fresh.render(makeVm({ title: 'Keep your session', body: 'Sign in to keep it.' }));
      expect(titleOf().textContent, 'render() door: exactly the sentinel').toBe(`«${KEY}»`);
      m24s5CvAssertNoRosterWord(m24s5CvWalkSubtree(freshOverlay), 'render() door');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    sweepA11y();
    await flushMacrotask();
  });
});
