// @vitest-environment happy-dom
// ui/dialogueView.i18n.test.ts — m24-s5 (ADR-0261) RED gating tests: DV-01/02/03.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (Tests, Key roster dialogue.*),
// docs/adr/0261-i18n-migration-batch-c.md.
//
// RED REASON AT HEAD: dialogueView.ts imports nothing from './i18n/resolver' today — the Shop
// affordance button is painted with the bare literal 'Shop' (dialogueView.ts:72). DV-01 fails on
// its very first assertion (the spied i18nT is never called with 'dialogue.action.shop' at all);
// DV-02 fails because 'Shop' is never wrapped in a «sentinel»; DV-03 fails because
// scanSource(stripComments(...)) reports a FAILING raw-English sink, not `failing: []`.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan/ADR-0261
// only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import type { DialogueViewModel } from './dialogueModel';
import { DialogueView } from './dialogueView';
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

/** Byte-copy of client/index.html's dialogue-overlay shell. */
function mount(): HTMLElement {
  document.body.innerHTML = `
    <div id="dialogue-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="dialogue-npc-name" tabindex="-1"></div>
      <div id="dialogue-node-text"></div>
      <div id="dialogue-choices"></div>
    </div>
  `;
  return document.getElementById('dialogue-overlay') as HTMLElement;
}

/** Choice fixtures deliberately avoid the roster word "Shop" (tester-A brief). */
function dialogueVm(overrides: Partial<DialogueViewModel> = {}): DialogueViewModel {
  return {
    npcName: 'Elder Rowan',
    nodeText: 'Welcome, traveller.',
    choices: [
      { text: 'Tell me about the realm', idx: 0 },
      { text: 'Goodbye', idx: 1 },
    ],
    canDismiss: true,
    shopAction: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// m24s5 SplitSentinels / WalkSubtree / AssertNoRosterWord trio.
// ---------------------------------------------------------------------------

const M24S5_DV_PLAIN_KEYS = new Set(['dialogue.action.shop']);

function m24s5DvSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (M24S5_DV_PLAIN_KEYS.has(content)) {
      // Elide — a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function m24s5DvWalkSubtree(root: HTMLElement): string[] {
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

const M24S5_DV_ROSTER = ['Shop'];

function m24s5DvAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s5DvSplitSentinels(texts.join('\n'));
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel`,
  ).toEqual([]);
  for (const word of M24S5_DV_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s5 (ADR-0261): dialogueView.ts routes its migrated sink through t()', () => {
  it('m24s5 DV-01: dialogue.action.shop resolves only when vm.shopAction is set; npcName/nodeText/choice.text stay raw and are never passed to a resolver', () => {
    const overlay = mount();
    const view = new DialogueView();

    view.render(dialogueVm({ shopAction: null }));
    expect(i18nT).not.toHaveBeenCalledWith('dialogue.action.shop');
    expect(overlay.querySelector('[data-shop-id]')).toBeNull();
    expect(document.getElementById('dialogue-npc-name')!.textContent).toBe('Elder Rowan');
    expect(document.getElementById('dialogue-node-text')!.textContent).toBe('Welcome, traveller.');
    const choiceTexts = [
      ...document.getElementById('dialogue-choices')!.querySelectorAll('button'),
    ].map((b) => b.textContent);
    expect(choiceTexts).toEqual(['Tell me about the realm', 'Goodbye']);
    expect(i18nT, 'npcName must never be passed to a resolver').not.toHaveBeenCalledWith(
      'Elder Rowan',
    );
    expect(i18nT, 'nodeText must never be passed to a resolver').not.toHaveBeenCalledWith(
      'Welcome, traveller.',
    );
    expect(i18nT, 'choice.text must never be passed to a resolver').not.toHaveBeenCalledWith(
      'Tell me about the realm',
    );

    vi.mocked(i18nT).mockClear();
    view.render(dialogueVm({ shopAction: { shopId: 7 } }));
    expect(i18nT).toHaveBeenCalledWith('dialogue.action.shop');
    const shopBtn = overlay.querySelector('[data-shop-id]') as HTMLButtonElement;
    expect(shopBtn.textContent).toBe('Shop');
    expect(shopBtn.dataset.shopId).toBe('7');
    expect(shopBtn.dataset.choiceIdx, 'the Shop button must never carry data-choice-idx').toBe(
      undefined,
    );
  });

  it('m24s5 DV-02: under «key» sentinel dialogue.action.shop shows resolver output only when vm.shopAction is set, and never the raw English word outside a sentinel', () => {
    const overlay = mount();
    // Constructed BEFORE the sentinel mockImplementation.
    const view = new DialogueView();

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.render(dialogueVm({ shopAction: null }));
      let texts = m24s5DvWalkSubtree(overlay);
      m24s5DvAssertNoRosterWord(texts, 'no shopAction');
      expect(texts.join('\n')).not.toContain('«dialogue.action.shop»');

      view.render(dialogueVm({ shopAction: { shopId: 3 } }));
      texts = m24s5DvWalkSubtree(overlay);
      m24s5DvAssertNoRosterWord(texts, 'with shopAction');
      const joined = texts.join('\n');
      expect(joined).toContain('«dialogue.action.shop»');
      expect(joined, 'npcName stays raw').toContain('Elder Rowan');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): dialogueView.ts scan — zero failing sinks', () => {
  it('m24s5 DV-03: scanSource(stripComments(dialogueView.ts)) has zero failing sinks, a >=5 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'dialogueView.ts'),
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
    ).toBeGreaterThanOrEqual(5);
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
