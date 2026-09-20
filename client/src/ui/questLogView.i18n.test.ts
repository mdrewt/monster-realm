// @vitest-environment happy-dom
// ui/questLogView.i18n.test.ts — m24s5 (ADR-0261) RED gating tests: questLogView.ts routes its
// one row sink through tf() from the i18n resolver instead of a raw English template literal.
//
// SOURCE OF TRUTH: /tmp/m24-s5/plan.md §Files/`questLogView.ts`, §Key roster `questLog.*`.
//
// PREDICTED RED REASON AT HEAD: questLogView.ts imports nothing from './i18n/resolver' and
// writes `${entry.displayName} (step ${entry.stepIndex})` as a raw template literal (:45).
// QL-01 fails on its first `i18nTf` call assertion (never called); QL-02 fails because the
// rendered row text is not wrapped in a «sentinel»; QL-03 fails because scanSource reports a
// FAILING raw-English sink.
//
// This view calls openOverlayA11y/closeOverlayA11y (m23-s3) — the file-level before/afterEach
// call the PRODUCTION closeOverlayA11y('questLogView', null) + flush one real macrotask, the
// sanctioned test-isolation device (ui/overlayA11y.test.ts precedent), so a deferred-focus timer
// left dangling by one test can never leak into another.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { scanSource } from './i18n/hardcodedStrings';
import { tf as i18nTf } from './i18n/resolver';
import { closeOverlayA11y } from './overlayA11y';
import type { QuestLogViewModel } from './questLogModel';
import { QuestLogView } from './questLogView';

// MECHANISM oracle: records every tf() call AND calls through to the real resolver.
vi.mock('./i18n/resolver', { spy: true });

/** Byte-copy of client/index.html:22-24 — the shell QuestLogView binds to (unchanged by m24-s5). */
function mountQuestLogOverlay(): HTMLElement {
  document.body.innerHTML = `
    <div id="quest-log-overlay" role="dialog" aria-modal="true" style="display:none">
      <ul id="quest-log-list" tabindex="-1"></ul>
    </div>
  `;
  return document.getElementById('quest-log-overlay') as HTMLElement;
}

async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function questVm(
  entries: ReadonlyArray<{ questId: string; stepIndex: number; displayName: string }>,
): QuestLogViewModel {
  return { active: entries.slice() };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  closeOverlayA11y('questLogView', null);
  await flushMacrotask();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// QL-02 sentinel helpers — the shopView m24s4 shape, scoped to this file's ONE ★ key.
// ---------------------------------------------------------------------------

const QL_PARAM_KEYS = new Set(['questLog.entry']);

function qlIsExpectedSentinelSpan(content: string): boolean {
  const bar = content.indexOf('|');
  if (bar === -1) return false;
  const key = content.slice(0, bar);
  if (!QL_PARAM_KEYS.has(key)) return false;
  const tail = content.slice(bar + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

function qlSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (qlIsExpectedSentinelSpan(content)) {
      // Elide.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function qlWalkSubtree(root: HTMLElement): string[] {
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

describe('m24s5 (ADR-0261): questLogView.ts routes its row through tf()', () => {
  it("m24s5 QL-01: every row calls tf('questLog.entry', { name, step }) with the exact params, displayName stays raw INSIDE the param only, and the rendered text is byte-identical", () => {
    mountQuestLogOverlay();
    const view = new QuestLogView();

    view.render(questVm([{ questId: 'quest_001', stepIndex: 0, displayName: 'quest_001' }]));
    expect(i18nTf).toHaveBeenCalledWith('questLog.entry', { name: 'quest_001', step: 0 });
    const li = document.querySelector('#quest-log-list li') as HTMLElement;
    expect(li.textContent).toBe('quest_001 (step 0)');

    vi.mocked(i18nTf).mockClear();
    view.render(questVm([{ questId: 'quest_kelp', stepIndex: 3, displayName: 'quest_kelp' }]));
    expect(
      i18nTf,
      'a repeat render() re-requests the key -- questLog.entry has no !wasVisible gate',
    ).toHaveBeenCalledWith('questLog.entry', { name: 'quest_kelp', step: 3 });
    expect(document.querySelector('#quest-log-list li')!.textContent).toBe('quest_kelp (step 3)');
  });

  it('m24s5 QL-02: under a «key|json» sentinel, the row shows resolver output and no forged bracket span survives', () => {
    // Constructed BEFORE mockImplementation.
    mountQuestLogOverlay();
    const view = new QuestLogView();

    try {
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );

      view.render(questVm([{ questId: 'quest_lark', stepIndex: 1, displayName: 'quest_lark' }]));
      const root = document.getElementById('quest-log-list')!;
      const texts = qlWalkSubtree(root);
      const { stripped, unexpectedSpans } = qlSplitSentinels(texts.join('\n'));
      expect(
        unexpectedSpans,
        'a forged «...» span (raw content wrapped by something other than the resolver) must not exist',
      ).toEqual([]);
      expect(stripped, 'once the ONE expected sentinel is elided, nothing else remains').toBe('');
      expect(texts.join('\n')).toContain('«questLog.entry|{"name":"quest_lark","step":1}»');
    } finally {
      vi.mocked(i18nTf).mockRestore();
    }

    // Post-restore call-through control (an existing S3 ★ key, unaffected by this slice).
    expect(i18nTf('chrome.status.disconnected', { where: 'shop' })).toBe(
      'shop: disconnected — try again',
    );
  });
});

describe('m24s5 (ADR-0261): questLogView.ts scan — zero failing sinks', () => {
  it('m24s5 QL-03: scanSource(stripComments(questLogView.ts)) has zero failing sinks, a >=2 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'questLogView.ts'),
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
