// @vitest-environment happy-dom
// ui/questLogView.i18n.test.ts — m24s5 RED gating tests: questLogView.ts routes its
// one row sink through tf() from the i18n resolver instead of a raw English template literal.
//
// SOURCE OF TRUTH: /tmp/m24-s5/plan.md §Files/`questLogView.ts`, §Key roster `questLog.*`.
//
// PREDICTED RED REASON AT HEAD: questLogView.ts imports nothing from './i18n/resolver' and
// writes `${entry.displayName} (step ${entry.stepIndex})` as a raw template literal (:45).
// QL-01 fails on its first `i18nTf` call assertion (never called); QL-02 fails because the
// rendered row text is not wrapped in a «sentinel».
//
// This view calls openOverlayA11y/closeOverlayA11y (m23-s3) — the file-level before/afterEach
// call the PRODUCTION closeOverlayA11y('questLogView', null) + flush one real macrotask, the
// sanctioned test-isolation device (ui/overlayA11y.test.ts precedent), so a deferred-focus timer
// left dangling by one test can never leak into another.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
import { t as i18nT, tf as i18nTf, setLocale } from './i18n/resolver';
import { closeOverlayA11y } from './overlayA11y';
import type { QuestLogViewModel } from './questLogModel';
import { QuestLogView } from './questLogView';

// MECHANISM oracle: records every tf() call AND calls through to the real resolver.
vi.mock('./i18n/resolver', { spy: true });

/** Byte-copy of client/index.html:22-24 — the shell QuestLogView binds to. */
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

    // Post-restore call-through control.
    expect(i18nTf('chrome.status.disconnected', { where: 'shop' })).toBe(
      'shop: disconnected — try again',
    );
  });
});

// ---------------------------------------------------------------------------
// qf-4 (QF4.1, QF4.2): the Journal title and the empty-state line are CATALOGUED, not literals.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-pt3-quickfix.spec.md §qf-4;
// memory/projects/monster-realm-qf-4-plan.md (design + AMENDMENTS A4-A7).
//
// RED REASON AT HEAD: the keys `chrome.journal.title` / `journal.empty` are in neither catalog and the
// view builds neither element, so every getElementById below is null and every catalog read is
// undefined. The keys are not in the MessageId union yet, so the literals are cast with `as never`.
//
// The view is constructed BEFORE the resolver is swapped (setLocale runs before construction in
// main.ts, so production would pass either way): the title and the empty line must be read from the
// resolver at RENDER time, which a constructor-time write would miss.
// ---------------------------------------------------------------------------

describe('QuestLogView qf-4: the title and empty state go through the i18n resolver', () => {
  it('QF4-1-TITLE-I18N-SENTINEL: under a «key» sentinel the title text is exactly the resolver output for chrome.journal.title, as plain text, written at render time', () => {
    // WRONG IMPL KILLED: a literal `Journal` in the view (the sentinel never appears); a title
    // resolved once in the constructor (this view is built BEFORE the swap, so a stale write shows
    // the real text); a title assembled by concatenation or markup around the resolver output.
    mountQuestLogOverlay();
    const view = new QuestLogView();

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.render(questVm([{ questId: 'quest_lark', stepIndex: 1, displayName: 'quest_lark' }]));
      const title = document.getElementById('quest-log-title');
      expect(title, 'the title exists').not.toBeNull();
      expect(title?.textContent, 'exactly the resolver output').toBe('«chrome.journal.title»');
      expect(title?.children.length, 'plain text, no child elements').toBe(0);
      expect(i18nT).toHaveBeenCalledWith('chrome.journal.title');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control.
    expect(i18nT('chrome.journal.title' as never)).toBe('Journal');
  });

  it('QF4-1-TITLE-I18N-LOCALE: after the locale switches to fr the next render writes the fr catalog`s chrome.journal.title', () => {
    // WRONG IMPL KILLED: a title written once and never refreshed (a locale change between
    // construction and render is not picked up); a title read from the en catalog directly.
    mountQuestLogOverlay();
    const view = new QuestLogView();

    try {
      setLocale('fr');
      view.render(questVm([{ questId: 'quest_lark', stepIndex: 1, displayName: 'quest_lark' }]));
      const expected = (CATALOG_FR as Record<string, unknown>)['chrome.journal.title'];
      expect(typeof expected, 'the fr catalog carries the key').toBe('string');
      expect(document.getElementById('quest-log-title')?.textContent).toBe(expected);
    } finally {
      setLocale('en');
    }
  });

  it('QF4-1-TITLE-CATALOG: both catalogs carry chrome.journal.title as a non-empty plain string, and the English one is Journal', () => {
    // WRONG IMPL KILLED: a key added to en only (t() throws in a French boot and the Journal frame
    // opens blank); an empty or function-valued entry; an English title that is not the menu`s own
    // `Journal` wording (the menu entry and the frame it opens must agree).
    const en = (CATALOG_EN as Record<string, unknown>)['chrome.journal.title'];
    const fr = (CATALOG_FR as Record<string, unknown>)['chrome.journal.title'];
    expect(en, 'en').toBe('Journal');
    expect(en, 'the menu entry and the frame title agree').toBe(
      (CATALOG_EN as Record<string, unknown>)['menu.journal.title'],
    );
    expect(typeof fr, 'fr is a plain string').toBe('string');
    expect((fr as string).length > 0, 'fr is not blank').toBe(true);
  });

  it('QF4-2-EMPTY-I18N-SENTINEL: under a «key» sentinel the empty line is exactly the resolver output for journal.empty while the list is empty, and is cleared once quests exist', () => {
    // WRONG IMPL KILLED: a literal English sentence in the view (the sentinel never appears); an
    // empty line resolved in the constructor (this view is built BEFORE the swap); the resolved text
    // left in the hidden element once a quest exists.
    mountQuestLogOverlay();
    const view = new QuestLogView();

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.render(questVm([]));
      const empty = document.getElementById('quest-log-empty');
      expect(empty, 'the empty element exists').not.toBeNull();
      expect(empty?.textContent, 'exactly the resolver output').toBe('«journal.empty»');
      expect(empty?.children.length, 'plain text, no child elements').toBe(0);
      expect(i18nT).toHaveBeenCalledWith('journal.empty');

      view.render(questVm([{ questId: 'quest_lark', stepIndex: 1, displayName: 'quest_lark' }]));
      expect(empty?.textContent, 'cleared once a quest exists').toBe('');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control.
    expect(i18nT('journal.empty' as never)).toBe(
      'No active quests yet. Talk to villagers to find out who needs help.',
    );
  });

  it('QF4-2-EMPTY-I18N-LOCALE: after the locale switches to fr the next empty render writes the fr catalog`s journal.empty, which is not the English line', () => {
    // WRONG IMPL KILLED: an empty line that ignores the locale; a key added to en only; a French
    // entry left as the English copy.
    mountQuestLogOverlay();
    const view = new QuestLogView();

    try {
      setLocale('fr');
      view.render(questVm([]));
      const fr = (CATALOG_FR as Record<string, unknown>)['journal.empty'];
      const en = (CATALOG_EN as Record<string, unknown>)['journal.empty'];
      expect(typeof fr, 'the fr catalog carries the key').toBe('string');
      expect(document.getElementById('quest-log-empty')?.textContent).toBe(fr);
      expect(fr, 'a translation, not the English copy').not.toBe(en);
    } finally {
      setLocale('en');
    }
  });

  it('QF4-2-EMPTY-CATALOG: journal.empty is the exact English line in en (reason, cue and next step, naming no key), and a non-empty plain string in fr', () => {
    // WRONG IMPL KILLED: a key added to en only; a line that is just "No quests" (no next step), or
    // one that tells the player to press a named key (bindings are remappable, so the copy names
    // none); an empty fr entry.
    const en = (CATALOG_EN as Record<string, unknown>)['journal.empty'];
    const fr = (CATALOG_FR as Record<string, unknown>)['journal.empty'];
    expect(en, 'en: the exact line').toBe(
      'No active quests yet. Talk to villagers to find out who needs help.',
    );
    expect(en as string, 'the reason').toMatch(/no active quests/i);
    expect(en as string, 'the next step').toMatch(/talk/i);
    expect(en as string, 'no key name (bindings are remappable)').not.toMatch(
      /\b(press|enter|keys?)\b/i,
    );
    expect(typeof fr, 'fr is a plain string').toBe('string');
    expect((fr as string).length > 0, 'fr is not blank').toBe(true);
    expect(fr, 'fr is a translation, not the English copy').not.toBe(en);
  });
});
