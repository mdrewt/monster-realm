// @vitest-environment happy-dom
// ui/claimView.i18n.test.ts — m24-s5 (ADR-0261) RED gating tests: CV-01/02/03.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (Tests, Key roster claim.*,
// D2), plan-revisions.md MAJOR-1 (BOTH doors — show() AND render() — write the label),
// docs/adr/0261-i18n-migration-batch-c.md.
//
// RED REASON AT HEAD: claimView.ts's constructor still writes the bare literal
// 'Privacy & Account Data' into #claim-privacy-btn (claimView.ts:96) and neither show() nor
// render() calls t()/tf() at all. CV-01 fails on its very first assertion (the constructor DOES
// write the English text today, so `privacyBtn.textContent === ''` pre-construction-write is
// false); CV-02 fails because the label is never wrapped in a «sentinel»; CV-03 fails because
// scanSource(stripComments(...)) reports a FAILING raw-English sink, not `failing: []`.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the
// plan/plan-revisions/ADR-0261 only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import type { ClaimViewModel } from './claimModel';
import { ClaimView, type ClaimViewHandlers } from './claimView';
import { scanSource } from './i18n/hardcodedStrings';
import { t as i18nT } from './i18n/resolver';
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
    onPrivacy: vi.fn(),
  };
}

/** vm strings deliberately avoid the roster word "Privacy" (tester-A brief). */
function makeVm(overrides: Partial<ClaimViewModel> = {}): ClaimViewModel {
  return {
    visible: true,
    title: 'Keep your guest progress',
    body: 'Sign in to keep what you made as a guest.',
    confirmPrompt: undefined,
    nudge: undefined,
    feedback: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// m24s5 SplitSentinels / WalkSubtree / AssertNoRosterWord trio.
// ---------------------------------------------------------------------------

const M24S5_CV_PLAIN_KEYS = new Set(['claim.privacyButton']);

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

const M24S5_CV_ROSTER = ['Privacy & Account Data'];

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

describe('m24s5 (ADR-0261): claimView.ts routes claim.privacyButton through t() from BOTH open doors', () => {
  it('m24s5 CV-01: claim.privacyButton resolves in show() AND render(), is never written by the constructor, unconditional repeat-request from each door, and is never confused with the coincident-English privacy.title key', async () => {
    const view = new ClaimView(makeHandlers());
    const privacyBtn = document.getElementById('claim-privacy-btn') as HTMLButtonElement;

    expect(privacyBtn.textContent, 'the constructor must no longer write the label').toBe('');
    expect(privacyBtn.style.display, 'the anchor invariant stays in the constructor').toBe('');
    expect(i18nT).not.toHaveBeenCalledWith('claim.privacyButton');

    // Door 1: show() alone, no render().
    view.show();
    expect(i18nT).toHaveBeenCalledWith('claim.privacyButton');
    expect(privacyBtn.textContent).toBe('Privacy & Account Data');

    // RT2: a repeat show() on an already-open overlay re-resolves the key.
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s5 CV-01 RT2 (show door): repeat show() must re-resolve claim.privacyButton',
    ).toHaveBeenCalledWith('claim.privacyButton');

    // Clean DOM + overlay-a11y record before a second, FRESH view (claimView.test.ts idiom).
    closeOverlayA11y('claimView', null);
    await flushMacrotask();
    document.body.innerHTML = '';

    // Door 2: render(visible vm) alone, no show().
    const freshView = new ClaimView(makeHandlers());
    const freshBtn = document.getElementById('claim-privacy-btn') as HTMLButtonElement;
    expect(freshBtn.textContent).toBe('');
    vi.mocked(i18nT).mockClear();

    freshView.render(makeVm());
    expect(i18nT).toHaveBeenCalledWith('claim.privacyButton');
    expect(freshBtn.textContent).toBe('Privacy & Account Data');

    // RT2 (render door): a repeat render() re-resolves the key.
    vi.mocked(i18nT).mockClear();
    freshView.render(makeVm());
    expect(
      i18nT,
      'm24s5 CV-01 RT2 (render door): repeat render() must re-resolve claim.privacyButton',
    ).toHaveBeenCalledWith('claim.privacyButton');

    // NEGATIVE (D2 cross-alias tooth): the coincident English never routes through the
    // privacyView key from claimView.ts.
    expect(i18nT).not.toHaveBeenCalledWith('privacy.title');

    closeOverlayA11y('claimView', null);
    await flushMacrotask();
  });

  it('m24s5 CV-02: under «key» sentinel claim.privacyButton shows resolver output via BOTH doors, and never the raw English label outside a sentinel; vm strings avoid "Privacy"', () => {
    // Constructed BEFORE the sentinel mockImplementation.
    const view = new ClaimView(makeHandlers());
    const overlay = document.getElementById('claim-overlay') as HTMLElement;

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.show();
      let texts = m24s5CvWalkSubtree(overlay);
      m24s5CvAssertNoRosterWord(texts, 'show() door');
      expect(texts.join('\n')).toContain('«claim.privacyButton»');

      view.render(makeVm({ title: 'Keep your session', body: 'Sign in to keep it.' }));
      texts = m24s5CvWalkSubtree(overlay);
      m24s5CvAssertNoRosterWord(texts, 'render() door');
      const joined = texts.join('\n');
      expect(joined).toContain('«claim.privacyButton»');
      expect(joined, 'vm.title stays raw').toContain('Keep your session');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): claimView.ts scan — zero failing sinks', () => {
  it('m24s5 CV-03: scanSource(stripComments(claimView.ts)) has zero failing sinks, a >=6 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'claimView.ts'),
      'utf8',
    );
    const result = scanSource(stripComments(src));

    expect(
      result.failing.map((s) => `${s.kind}@L${s.line}: ${s.failingSegments.join(' | ')}`),
      'every sink must route through t()/tf() — any surviving English segment is listed above',
    ).toEqual([]);
    expect(
      result.sinks.length,
      'SINK_FLOOR idiom: a floor, never an exact count',
    ).toBeGreaterThanOrEqual(6);
    expect(
      result.unterminated,
      'the literal mask must not end inside an unterminated literal',
    ).toBe(false);
    expect(result.maskedSinkTokens, 'no parity-flip mask desync').toBe(0);
    for (const sink of result.sinks) {
      expect(sink.truncated, `${sink.kind}@L${sink.line} must not be truncated`).toBe(false);
    }
  });
});
