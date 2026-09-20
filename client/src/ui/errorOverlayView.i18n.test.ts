// @vitest-environment happy-dom
// ui/errorOverlayView.i18n.test.ts — m24s5 (ADR-0261) RED gating tests: errorOverlayView.ts
// routes its footer through t() from the i18n resolver instead of a raw English literal.
//
// SOURCE OF TRUTH: /tmp/m24-s5/plan.md (m24-s5 plan) §Files/`errorOverlayView.ts`, §Key roster
// `errorOverlay.*`, §Decisions D4; /tmp/m24-s5/plan-revisions.md Red-team MAJOR-2 (APPLIED) — the
// footer resolves in show(), NOT render() and NOT the constructor, because render()'s body is
// wrapped in a hostile-VM try/catch and a mis-keyed t() call inside it would be swallowed to
// console.error rather than surfacing as a test failure.
//
// PREDICTED RED REASON AT HEAD: errorOverlayView.ts imports nothing from './i18n/resolver' and
// writes the literal 'F8 dismiss · F9 bug report' twice (constructor :35, render :81). EO-01 fails
// on its first `i18nT` call assertion (never called); EO-02 fails because the roster words survive
// unbracketed; EO-03 fails because scanSource reports FAILING raw-English sinks.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan/revisions
// only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import type { ErrorOverlayViewModel } from './errorOverlayModel';
import { ErrorOverlayView } from './errorOverlayView';
import { scanSource } from './i18n/hardcodedStrings';
import { t as i18nT } from './i18n/resolver';

// MECHANISM oracle (m24s3/m24s4 precedent): records every t() call AND calls through to the real
// resolver, so EO-01's DOM byte-identity assertions still work under the real (call-through) path.
vi.mock('./i18n/resolver', { spy: true });

function resetDom(): void {
  document.body.replaceChildren();
}

function vm(
  rows: Array<{ message: string; tMs: number; source: string }>,
  hiddenCount = 0,
): ErrorOverlayViewModel {
  return { rows, hiddenCount, isEmpty: rows.length === 0, total: rows.length + hiddenCount };
}

beforeEach(() => {
  resetDom();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// EO-02 sentinel helpers — same shape as shopView.test.ts's m24s4 block, scoped to this file's
// ONE migrated key.
// ---------------------------------------------------------------------------

const EO_PLAIN_KEYS = new Set(['errorOverlay.footer']);

function eoIsExpectedSentinelSpan(content: string): boolean {
  return EO_PLAIN_KEYS.has(content);
}

function eoSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (eoIsExpectedSentinelSpan(content)) {
      // Elide — a correctly formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function eoWalkSubtree(root: HTMLElement): string[] {
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

// The catalog value's own words, so a forged bracket span around raw content is never exempted.
const EO_ROSTER = ['F8', 'dismiss', 'bug report', 'F9'];

function eoAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = eoSplitSentinels(texts.join('\n'));
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel`,
  ).toEqual([]);
  for (const word of EO_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s5 (ADR-0261): errorOverlayView.ts routes its footer through t()', () => {
  it('m24s5 EO-01: errorOverlay.footer resolves in show(), never the constructor or render(); rows stay raw model data; a hostile render() leaves the footer intact; repeat show() re-requests the key', () => {
    const view = new ErrorOverlayView();
    const footer = document.querySelector('.mr-error-overlay-footer') as HTMLElement;
    expect(footer).not.toBeNull();
    expect(footer.textContent, 'the constructor must no longer write the footer literal').toBe('');
    expect(i18nT, 'the constructor must not call the resolver at all').not.toHaveBeenCalled();

    view.show();
    expect(i18nT).toHaveBeenCalledWith('errorOverlay.footer');
    expect(footer.textContent).toBe('F8 dismiss · F9 bug report');

    vi.mocked(i18nT).mockClear();
    view.render(vm([{ message: 'reducer trouble', tMs: 10, source: 'reducer' }]));
    expect(
      footer.textContent,
      'render() must not blank or re-paint the footer — it resolves only in show()',
    ).toBe('F8 dismiss · F9 bug report');
    expect(
      i18nT,
      'render() must never call the resolver with the footer key',
    ).not.toHaveBeenCalledWith('errorOverlay.footer');
    const row = document.querySelector('.mr-error-row') as HTMLElement;
    expect(row.textContent, 'row text is raw model data, never a resolver key').toBe(
      '[reducer] reducer trouble',
    );
    expect(i18nT).not.toHaveBeenCalledWith(expect.stringContaining('reducer trouble'));

    // A hostile VM (rows getter throws) rendered AFTER show(): footer text stays intact, no throw.
    const hostile = {} as ErrorOverlayViewModel;
    Object.defineProperty(hostile, 'rows', {
      get() {
        throw new Error('boom rows getter');
      },
    });
    expect(() => view.render(hostile)).not.toThrow();
    expect(footer.textContent, 'a hostile render() must not clobber the footer').toBe(
      'F8 dismiss · F9 bug report',
    );

    vi.mocked(i18nT).mockClear();
    view.show();
    expect(i18nT, 'a repeat show() re-requests the footer key (RT2)').toHaveBeenCalledWith(
      'errorOverlay.footer',
    );
  });

  it('m24s5 EO-02: under a «key» sentinel, the footer shows resolver output and no English roster word survives outside a sentinel', () => {
    // Constructed BEFORE mockImplementation (m24s3/m24s4 hardening): a future regression that
    // hoists the t() call into the constructor resolves against the REAL resolver here and
    // surfaces as stale, unbracketed English in the very first eoAssertNoRosterWord below.
    const view = new ErrorOverlayView();

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.show();
      view.render(vm([{ message: 'connection trouble', tMs: 5, source: 'uncaught' }]));

      const root = document.getElementById('mr-error-overlay')!;
      const texts = eoWalkSubtree(root);
      eoAssertNoRosterWord(texts, 'error overlay footer');
      const joined = texts.join('\n');
      expect(joined).toContain('«errorOverlay.footer»');
      expect(joined, 'row text stays raw model data').toContain('[uncaught] connection trouble');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): errorOverlayView.ts scan — zero failing sinks', () => {
  it('m24s5 EO-03: scanSource(stripComments(errorOverlayView.ts)) has zero failing sinks, a >=3 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'errorOverlayView.ts'),
      'utf8',
    );
    const result = scanSource(stripComments(src));

    expect(
      result.failing.map((s) => `${s.kind}@L${s.line}: ${s.failingSegments.join(' | ')}`),
      'every sink must route through t() -- any surviving English segment is listed above',
    ).toEqual([]);
    expect(
      result.sinks.length,
      'SINK_FLOOR idiom: a floor, never an exact count -- the constructor twin is deleted so the ' +
        'floor drops from 4 to 3',
    ).toBeGreaterThanOrEqual(3);
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
