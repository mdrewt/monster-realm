// @vitest-environment happy-dom
// ui/renameView.i18n.test.ts — m24-s5 (ADR-0261) RED gating tests: RN-01/02/03.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (Tests, Files — renameView.ts
// show() writes chrome.rename.submit after the wasVisible read), plan-revisions.md D4
// (unconditional per-open-door resolve), docs/adr/0261-i18n-migration-batch-c.md.
//
// RED REASON AT HEAD: renameView.ts's show() never writes `#submitBtn.textContent` at all
// (index.html:60 still ships the literal 'Rename' there). RN-01 fails on its very first
// assertion (the mounted #rename-submit is never '' pre-show because the fixture mirrors the
// NEW, emptied index.html while the real button paints nothing, and i18nT is never called at
// all); RN-02 fails because 'Rename' is never wrapped in a «sentinel»; RN-03 fails because
// scanSource(stripComments(...)) reports a FAILING raw-English sink, not `failing: []`.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the
// plan/plan-revisions/ADR-0261 only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { scanSource } from './i18n/hardcodedStrings';
import { t as i18nT } from './i18n/resolver';
import { closeOverlayA11y } from './overlayA11y';
import { OVERLAY_IDS } from './overlayRegistry';
import { type RenameCallbacks, RenameView } from './renameView';

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

interface RenameViewModel {
  displayCurrentName: string;
  trimmedDraft: string;
  canSubmit: boolean;
}

// Mirrors the NEW index.html (D7): #rename-submit ships EMPTY, painted by show() instead of the
// literal 'Rename' text.
function mount(): {
  overlay: HTMLElement;
  currentEl: HTMLElement;
  submitBtn: HTMLButtonElement;
} {
  document.body.innerHTML = `
    <div id="rename-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="rename-current" data-testid="rename-current"></div>
      <input id="rename-input" data-testid="rename-input" type="text" maxlength="24" />
      <button id="rename-submit" data-testid="rename-submit" type="button"></button>
      <div id="rename-feedback" data-testid="rename-feedback"></div>
    </div>
  `;
  return {
    overlay: document.getElementById('rename-overlay') as HTMLElement,
    currentEl: document.getElementById('rename-current') as HTMLElement,
    submitBtn: document.getElementById('rename-submit') as HTMLButtonElement,
  };
}

function noop(): RenameCallbacks {
  return { onSubmit: async (_name: string) => {} };
}

// ---------------------------------------------------------------------------
// m24s5 SplitSentinels / WalkSubtree / AssertNoRosterWord trio.
// ---------------------------------------------------------------------------

const M24S5_RN_PLAIN_KEYS = new Set(['chrome.rename.submit']);

function m24s5RnSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (M24S5_RN_PLAIN_KEYS.has(content)) {
      // Elide — a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function m24s5RnWalkSubtree(root: HTMLElement): string[] {
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

const M24S5_RN_ROSTER = ['Rename'];

function m24s5RnAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s5RnSplitSentinels(texts.join('\n'));
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel`,
  ).toEqual([]);
  for (const word of M24S5_RN_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s5 (ADR-0261): renameView.ts routes chrome.rename.submit through t() in show()', () => {
  it('m24s5 RN-01: chrome.rename.submit resolves in show(), an unconditional repeat show() re-requests it, and displayCurrentName renders raw and is never passed to a resolver', () => {
    const { currentEl, submitBtn } = mount();
    const view = new RenameView(noop());

    expect(submitBtn.textContent, '#rename-submit ships empty pre-show (D7)').toBe('');
    expect(i18nT).not.toHaveBeenCalledWith('chrome.rename.submit');

    view.show();
    expect(i18nT).toHaveBeenCalledWith('chrome.rename.submit');
    expect(submitBtn.textContent).toBe('Rename');

    // RT2: a repeat show() on an already-open overlay re-resolves the label.
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s5 RN-01 RT2: repeat show() must re-resolve chrome.rename.submit (kills a ' +
        '!wasVisible-gated write)',
    ).toHaveBeenCalledWith('chrome.rename.submit');

    // vm.displayCurrentName fixture deliberately avoids the roster word "Rename".
    const vm: RenameViewModel = {
      displayCurrentName: 'Wanderer',
      trimmedDraft: '',
      canSubmit: false,
    };
    view.render(vm);
    expect(currentEl.textContent).toBe('Wanderer');
    expect(i18nT, 'displayCurrentName must never be passed to a resolver').not.toHaveBeenCalledWith(
      'Wanderer',
    );
  });

  it('m24s5 RN-02: under «key» sentinel chrome.rename.submit shows resolver output, and never the raw English label outside a sentinel', () => {
    const { overlay } = mount();
    // Constructed BEFORE the sentinel mockImplementation.
    const view = new RenameView(noop());

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.show();
      const vm: RenameViewModel = {
        displayCurrentName: 'Wanderer',
        trimmedDraft: '',
        canSubmit: false,
      };
      view.render(vm);

      const texts = m24s5RnWalkSubtree(overlay);
      m24s5RnAssertNoRosterWord(texts, 'after show+render');
      const joined = texts.join('\n');
      expect(joined).toContain('«chrome.rename.submit»');
      expect(joined, 'displayCurrentName stays raw').toContain('Wanderer');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): renameView.ts scan — zero failing sinks', () => {
  it('m24s5 RN-03: scanSource(stripComments(renameView.ts)) has zero failing sinks, a >=4 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'renameView.ts'),
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
