// @vitest-environment happy-dom
// ui/helpView.i18n.test.ts — m24-s5 (ADR-0261) RED gating tests: HV-01/02/03.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (Tests, Files —
// helpView.ts constructor resolves #help-title into a readonly #titleEl and throws if missing;
// show() writes chrome.help.title after the wasVisible read), plan-revisions.md D4 (unconditional
// per-open-door resolve), docs/adr/0261-i18n-migration-batch-c.md.
//
// RED REASON AT HEAD: helpView.ts's constructor does not resolve #help-title at all today, and
// show() never writes its textContent (index.html:94 still ships the literal
// 'Controls & Goals' there). HV-01 fails on its very first assertion (the mounted #help-title is
// never '' pre-show because the fixture mirrors the NEW, emptied index.html while the real button
// paints nothing, and i18nT is never called at all); HV-02 fails because 'Controls & Goals' is
// never wrapped in a «sentinel»; HV-03 fails because scanSource(stripComments(...)) reports a
// FAILING raw-English sink, not `failing: []`.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the
// plan/plan-revisions/ADR-0261 only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { HelpView } from './helpView';
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

// Mirrors the NEW index.html (D7): #help-title ships EMPTY, painted by show() instead of the
// literal 'Controls &amp; Goals' text.
function mount(): { overlay: HTMLElement; controlsEl: HTMLElement; goalsEl: HTMLElement } {
  document.body.innerHTML = `
    <div id="help-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="help-title" tabindex="-1"></div>
      <ul id="help-controls"></ul>
      <ul id="help-goals"></ul>
    </div>
  `;
  return {
    overlay: document.getElementById('help-overlay') as HTMLElement,
    controlsEl: document.getElementById('help-controls') as HTMLElement,
    goalsEl: document.getElementById('help-goals') as HTMLElement,
  };
}

// ---------------------------------------------------------------------------
// m24s5 SplitSentinels / WalkSubtree / AssertNoRosterWord trio.
// ---------------------------------------------------------------------------

const M24S5_HV_PLAIN_KEYS = new Set(['chrome.help.title']);

function m24s5HvSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (M24S5_HV_PLAIN_KEYS.has(content)) {
      // Elide — a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function m24s5HvWalkSubtree(root: HTMLElement): string[] {
  const texts: string[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) texts.push(node.textContent ?? '');
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return texts;
}

const M24S5_HV_ROSTER = ['Controls & Goals'];

function m24s5HvAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s5HvSplitSentinels(texts.join('\n'));
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel`,
  ).toEqual([]);
  for (const word of M24S5_HV_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s5 (ADR-0261): helpView.ts routes chrome.help.title through t() in show()', () => {
  it('m24s5 HV-01: chrome.help.title resolves in show(), an unconditional repeat show() re-requests it, and control/goal copy stays raw and is never passed to a resolver', () => {
    const { overlay, controlsEl, goalsEl } = mount();
    const view = new HelpView();
    const titleEl = overlay.querySelector('#help-title') as HTMLElement;

    expect(titleEl.textContent, '#help-title ships empty pre-show (D7)').toBe('');
    expect(i18nT).not.toHaveBeenCalledWith('chrome.help.title');

    view.show();
    expect(i18nT).toHaveBeenCalledWith('chrome.help.title');
    expect(titleEl.textContent).toBe('Controls & Goals');

    // RT2: a repeat show() on an already-open overlay re-resolves the title.
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s5 HV-01 RT2: repeat show() must re-resolve chrome.help.title (kills a ' +
        '!wasVisible-gated write)',
    ).toHaveBeenCalledWith('chrome.help.title');

    // Fixture control/goal copy deliberately avoids "Controls"/"Goals" (tester-A brief).
    view.render({
      controls: [{ key: 'Z', action: 'Zoom the camera' }],
      goals: ['Finish the tutorial trail'],
    });
    const controlLi = controlsEl.querySelector('li')!;
    expect(controlLi.textContent).toBe('Z — Zoom the camera');
    expect(i18nT, 'control copy must never be passed to a resolver').not.toHaveBeenCalledWith(
      'Z — Zoom the camera',
    );
    const goalLi = goalsEl.querySelector('li')!;
    expect(goalLi.textContent).toBe('Finish the tutorial trail');
    expect(i18nT, 'goal copy must never be passed to a resolver').not.toHaveBeenCalledWith(
      'Finish the tutorial trail',
    );
  });

  it('m24s5 HV-02: under «key» sentinel chrome.help.title shows resolver output, and never the raw English title outside a sentinel', () => {
    const { overlay } = mount();
    // Constructed BEFORE the sentinel mockImplementation.
    const view = new HelpView();

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.show();
      view.render({
        controls: [{ key: 'Z', action: 'Zoom the camera' }],
        goals: ['Finish the tutorial trail'],
      });

      const texts = m24s5HvWalkSubtree(overlay);
      m24s5HvAssertNoRosterWord(texts, 'after show+render');
      const joined = texts.join('\n');
      expect(joined).toContain('«chrome.help.title»');
      expect(joined, 'control copy stays raw').toContain('Z — Zoom the camera');
      expect(joined, 'goal copy stays raw').toContain('Finish the tutorial trail');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): helpView.ts scan — zero failing sinks', () => {
  it('m24s5 HV-03: scanSource(stripComments(helpView.ts)) has zero failing sinks, a >=4 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpView.ts'),
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
    ).toBeGreaterThanOrEqual(4);
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
