// @vitest-environment happy-dom
// ui/tradeProposeView.i18n.test.ts — m24-s5 (ADR-0261) RED gating tests: TP-01/02/03.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (Tests, Key roster
// tradePropose.*), plan-revisions.md (D4 rewrite), docs/adr/0261-i18n-migration-batch-c.md.
//
// RED REASON AT HEAD: tradeProposeView.ts imports nothing from './i18n/resolver' today —
// `#target`'s placeholder option is the bare literal 'Select a player…' (tradeProposeView.ts:168)
// and show() never writes `#submitBtn.textContent` at all (index.html:79-81 still ships the
// literal 'Offer' there). TP-01 fails on its very first assertion (the spied i18nT is never
// called at all, and the mounted #tradepropose-submit is never '' pre-show because the fixture
// mirrors the NEW, emptied index.html while the real button paints nothing); TP-02 fails because
// the roster words 'Select a player'/'Offer' are never wrapped in a «sentinel»; TP-03 fails
// because scanSource(stripComments(...)) reports FAILING raw-English sinks, not `failing: []`.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan/ADR-0261
// only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { scanSource } from './i18n/hardcodedStrings';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import { closeOverlayA11y } from './overlayA11y';
import { OVERLAY_IDS } from './overlayRegistry';
import type { TradeProposeArgs, TradeProposeLists } from './tradeProposeModel';
import { type TradeProposeCallbacks, TradeProposeView } from './tradeProposeView';

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

// ---------------------------------------------------------------------------
// DOM mount — mirrors the NEW index.html (D7): #tradepropose-submit ships EMPTY, painted by
// show() instead of the literal 'Offer' text.
// ---------------------------------------------------------------------------

function mount(): {
  overlay: HTMLElement;
  targetSelect: HTMLSelectElement;
  monstersEl: HTMLElement;
  submitBtn: HTMLButtonElement;
} {
  document.body.innerHTML = `
    <div id="tradepropose-overlay" role="dialog" aria-modal="true" style="display:none">
      <select id="tradepropose-target" data-testid="tradepropose-target"></select>
      <div id="tradepropose-monsters" data-testid="tradepropose-monsters"></div>
      <input id="tradepropose-offer-currency" data-testid="tradepropose-offer-currency" type="number" min="0" />
      <input id="tradepropose-request-currency" data-testid="tradepropose-request-currency" type="number" min="0" />
      <button id="tradepropose-submit" data-testid="tradepropose-submit" type="button"></button>
      <div id="tradepropose-feedback" data-testid="tradepropose-feedback"></div>
    </div>
  `;
  return {
    overlay: document.getElementById('tradepropose-overlay') as HTMLElement,
    targetSelect: document.getElementById('tradepropose-target') as HTMLSelectElement,
    monstersEl: document.getElementById('tradepropose-monsters') as HTMLElement,
    submitBtn: document.getElementById('tradepropose-submit') as HTMLButtonElement,
  };
}

function noop(): TradeProposeCallbacks {
  return { onSubmit: async (_args: TradeProposeArgs) => {} };
}

/** No roster word ('Select a player', 'Offer') anywhere in the fixture labels. */
function makeLists(
  targets: Array<{ identity: string; label: string }>,
  offerableMonsters: Array<{ monsterId: bigint; label: string }>,
): TradeProposeLists {
  return { targets, offerableMonsters };
}

// ---------------------------------------------------------------------------
// m24s5 SplitSentinels / WalkSubtree / AssertNoRosterWord trio (SV-02/BX-02 precedent).
// ---------------------------------------------------------------------------

const M24S5_TP_PLAIN_KEYS = new Set([
  'tradePropose.target.placeholder',
  'chrome.tradePropose.submit',
]);

function m24s5TpIsExpectedSentinelSpan(content: string): boolean {
  return M24S5_TP_PLAIN_KEYS.has(content);
}

function m24s5TpSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (m24s5TpIsExpectedSentinelSpan(content)) {
      // Elide — a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

/** Whole-subtree walk incl. every `<option>` text (TP-02's stated requirement). */
function m24s5TpWalkSubtree(root: HTMLElement): string[] {
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

const M24S5_TP_ROSTER = ['Select a player', 'Offer'];

function m24s5TpAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s5TpSplitSentinels(texts.join('\n'));
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel`,
  ).toEqual([]);
  for (const word of M24S5_TP_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s5 (ADR-0261): tradeProposeView.ts routes its migrated sinks through t()/tf()', () => {
  it('m24s5 TP-01: tradePropose.target.placeholder and chrome.tradePropose.submit resolve with the exact key, <option> text stays raw, and an unconditional repeat show() re-requests the submit label', () => {
    const { targetSelect, monstersEl, submitBtn } = mount();
    const view = new TradeProposeView(noop());

    expect(submitBtn.textContent, '#tradepropose-submit ships empty pre-show (D7)').toBe('');
    expect(i18nT).not.toHaveBeenCalledWith('chrome.tradePropose.submit');

    view.show();
    expect(i18nT).toHaveBeenCalledWith('chrome.tradePropose.submit');
    expect(submitBtn.textContent).toBe('Offer');

    view.render(makeLists([{ identity: 'p1', label: 'Zed' }], [{ monsterId: 1n, label: 'Kip' }]));
    expect(i18nT).toHaveBeenCalledWith('tradePropose.target.placeholder');
    const placeholderOpt = targetSelect.options[0] as HTMLOptionElement;
    expect(placeholderOpt.textContent).toBe('Select a player…');
    expect(targetSelect.options[1]!.textContent, 't.label is raw model data').toBe('Zed');
    expect(i18nT, 'target label must never be passed to a resolver').not.toHaveBeenCalledWith(
      'Zed',
    );
    const labelNode = monstersEl.querySelector('label')!;
    expect(labelNode.textContent, 'the checkbox label (space + m.label) is raw model data').toBe(
      ' Kip',
    );
    expect(i18nT, 'monster label must never be passed to a resolver').not.toHaveBeenCalledWith(
      ' Kip',
    );

    // RT2: a repeat show() on an already-open overlay re-resolves the submit label.
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s5 TP-01 RT2: repeat show() must re-resolve chrome.tradePropose.submit (kills a ' +
        '!wasVisible-gated write)',
    ).toHaveBeenCalledWith('chrome.tradePropose.submit');
  });

  it('m24s5 TP-02: under «key» sentinels every rendered surface, including <option> text, shows resolver output and never an English roster word outside a sentinel', () => {
    const { overlay } = mount();
    // Constructed BEFORE the sentinel mockImplementation: a hoisted t()/tf() call would
    // resolve against the REAL resolver and surface as stale, unbracketed English below.
    const view = new TradeProposeView(noop());

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );

      view.show();
      view.render(makeLists([{ identity: 'p1', label: 'Zed' }], [{ monsterId: 1n, label: 'Kip' }]));

      const texts = m24s5TpWalkSubtree(overlay);
      m24s5TpAssertNoRosterWord(texts, 'after show+render');
      const joined = texts.join('\n');
      expect(joined).toContain('«tradePropose.target.placeholder»');
      expect(joined).toContain('«chrome.tradePropose.submit»');
      expect(joined, 't.label stays raw').toContain('Zed');
      expect(joined, 'the checkbox label (m.label) stays raw').toContain('Kip');
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): tradeProposeView.ts scan — zero failing sinks', () => {
  it('m24s5 TP-03: scanSource(stripComments(tradeProposeView.ts)) has zero failing sinks, a >=7 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'tradeProposeView.ts'),
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
    ).toBeGreaterThanOrEqual(7);
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
