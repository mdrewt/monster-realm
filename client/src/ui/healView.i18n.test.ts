// @vitest-environment happy-dom
// ui/healView.i18n.test.ts — m24s5 (ADR-0261) RED gating tests: healView.ts routes its one row
// sink through tf() from the i18n resolver instead of a raw English template literal.
//
// SOURCE OF TRUTH: /tmp/m24-s5/plan.md §Files/`healView.ts`, §Key roster `heal.*`.
//
// PREDICTED RED REASON AT HEAD: healView.ts imports nothing from './i18n/resolver' and writes
// `Heal here (${cost})` as a raw template literal (:47). HL-01 fails on its first `i18nTf` call
// assertion (never called); HL-02 fails because the rendered row text is not wrapped in a
// «sentinel»; HL-03 fails because scanSource reports a FAILING raw-English sink.
//
// This view calls openOverlayA11y/closeOverlayA11y (m23-s3) — the file-level before/afterEach
// call the PRODUCTION closeOverlayA11y('healView', null) + flush one real macrotask, the
// sanctioned test-isolation device (ui/overlayA11y.test.ts precedent).
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { formatHealCostLine, type HealLocationViewModel, type HealViewModel } from './healModel';
import { HealView } from './healView';
import { scanSource } from './i18n/hardcodedStrings';
import { tf as i18nTf } from './i18n/resolver';
import { closeOverlayA11y } from './overlayA11y';

// MECHANISM oracle: records every tf() call AND calls through to the real resolver.
vi.mock('./i18n/resolver', { spy: true });

/** Byte-copy of client/index.html:25-27 — the shell HealView binds to (unchanged by m24-s5). */
function mountHealOverlay(): HTMLElement {
  document.body.innerHTML = `
    <div id="heal-overlay" role="dialog" aria-modal="true" style="display:none">
      <ul id="heal-list" tabindex="-1"></ul>
    </div>
  `;
  return document.getElementById('heal-overlay') as HTMLElement;
}

async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function healLocation(overrides: Partial<HealLocationViewModel> = {}): HealLocationViewModel {
  return {
    locationId: 1,
    zoneId: 0,
    tileX: 4,
    tileY: 9,
    costItemName: null,
    costQty: 0,
    costCurrency: 0n,
    cooldownMs: 0,
    isFree: true,
    ...overrides,
  };
}

function healVm(locations: HealLocationViewModel[]): HealViewModel {
  return { locations };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  closeOverlayA11y('healView', null);
  await flushMacrotask();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// HL-02 sentinel helpers.
// ---------------------------------------------------------------------------

const HL_PARAM_KEYS = new Set(['heal.location']);

function hlIsExpectedSentinelSpan(content: string): boolean {
  const bar = content.indexOf('|');
  if (bar === -1) return false;
  const key = content.slice(0, bar);
  if (!HL_PARAM_KEYS.has(key)) return false;
  const tail = content.slice(bar + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

function hlSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (hlIsExpectedSentinelSpan(content)) {
      // Elide.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function hlWalkSubtree(root: HTMLElement): string[] {
  const texts: string[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) texts.push(node.textContent ?? '');
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return texts;
}

describe('m24s5 (ADR-0261): healView.ts routes its row through tf()', () => {
  it("m24s5 HL-01: every row calls tf('heal.location', { cost }) where cost === formatHealCostLine(loc), and the rendered text is byte-identical", () => {
    mountHealOverlay();
    const view = new HealView();
    const free = healLocation({ locationId: 1 });
    const costed = healLocation({
      locationId: 2,
      isFree: false,
      costItemName: 'Herb',
      costQty: 3,
      costCurrency: 5n,
    });

    // ONE pinned example (anti-vacuity for the SSOT delegation below), never re-derived by hand.
    expect(formatHealCostLine(free)).toBe('Free');

    view.render(healVm([free, costed]));
    expect(i18nTf).toHaveBeenCalledWith('heal.location', { cost: formatHealCostLine(free) });
    expect(i18nTf).toHaveBeenCalledWith('heal.location', { cost: formatHealCostLine(costed) });
    const items = document.querySelectorAll('#heal-list li');
    expect(items[0].textContent).toBe(`Heal here (${formatHealCostLine(free)})`);
    expect(items[1].textContent).toBe(`Heal here (${formatHealCostLine(costed)})`);

    vi.mocked(i18nTf).mockClear();
    view.render(healVm([free]));
    expect(
      i18nTf,
      'a repeat render() re-requests the key -- heal.location has no !wasVisible gate',
    ).toHaveBeenCalledWith('heal.location', { cost: formatHealCostLine(free) });
  });

  it('m24s5 HL-02: under a «key|json» sentinel, the row shows resolver output and no forged bracket span survives', () => {
    mountHealOverlay();
    const view = new HealView();

    try {
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );

      const costed = healLocation({
        locationId: 9,
        isFree: false,
        costItemName: 'Tonic',
        costQty: 1,
        costCurrency: 12n,
      });
      view.render(healVm([costed]));
      const root = document.getElementById('heal-list')!;
      const texts = hlWalkSubtree(root);
      const { stripped, unexpectedSpans } = hlSplitSentinels(texts.join('\n'));
      expect(
        unexpectedSpans,
        'a forged «...» span (raw content wrapped by something other than the resolver) must not exist',
      ).toEqual([]);
      expect(stripped, 'once the ONE expected sentinel is elided, nothing else remains').toBe('');
      const expectedCost = formatHealCostLine(costed);
      expect(texts.join('\n')).toContain(
        `«heal.location|${JSON.stringify({ cost: expectedCost })}»`,
      );
    } finally {
      vi.mocked(i18nTf).mockRestore();
    }

    // Post-restore call-through control (an existing S3 ★ key, unaffected by this slice).
    expect(i18nTf('chrome.status.disconnected', { where: 'trade' })).toBe(
      'trade: disconnected — try again',
    );
  });
});

describe('m24s5 (ADR-0261): healView.ts scan — zero failing sinks', () => {
  it('m24s5 HL-03: scanSource(stripComments(healView.ts)) has zero failing sinks, a >=2 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'healView.ts'),
      'utf8',
    );
    const result = scanSource(stripComments(src));

    expect(
      result.failing.map((s) => `${s.kind}@L${s.line}: ${s.failingSegments.join(' | ')}`),
    ).toEqual([]);
    expect(result.sinks.length).toBeGreaterThanOrEqual(2);
    expect(result.unterminated).toBe(false);
    expect(result.maskedSinkTokens).toBe(0);
    for (const sink of result.sinks) {
      expect(sink.truncated, `${sink.kind}@L${sink.line} must not be truncated`).toBe(false);
    }
  });
});
