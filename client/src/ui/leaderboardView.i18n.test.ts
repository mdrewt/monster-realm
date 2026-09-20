// @vitest-environment happy-dom
// ui/leaderboardView.i18n.test.ts — m24-s5 (ADR-0261) RED gating tests: LB-01/02/03 (I18N-20).
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (Tests, Key roster
// leaderboard.*, D3 — the <bdi> shape), plan-revisions.md S1 (the XSS-name pin is CUT — the
// sibling leaderboardView.test.ts RL13-xss suite owns it), docs/adr/0261-i18n-migration-batch-c.md.
//
// RED REASON AT HEAD: leaderboardView.ts imports nothing from './i18n/resolver' today — the
// empty-board branch renders the bare literal 'No ranked players yet' (leaderboardView.ts:60) and
// every row is a SINGLE text node `${row.displayName} — ${row.rating} (W${row.wins}/L${row.losses})`
// (leaderboardView.ts:69), never a <bdi> + a second node. LB-01 fails on its very first assertion
// (the spied i18nT/i18nTf are never called at all, and `li.childNodes.length` is 1, not 2); LB-02
// fails because the roster words are never wrapped in a «sentinel»; LB-03 fails because
// scanSource(stripComments(...)) reports FAILING raw-English sinks, not `failing: []`.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan/ADR-0261
// only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { scanSource } from './i18n/hardcodedStrings';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import type { LeaderboardRowViewModel, LeaderboardViewModel } from './leaderboardModel';
import { LeaderboardView } from './leaderboardView';

// The m24s5 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the DOM byte-identity assertions below still work.
vi.mock('./i18n/resolver', { spy: true });

function mount(): { overlay: HTMLElement; list: HTMLUListElement } {
  document.body.innerHTML = `
    <div id="leaderboard-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="leaderboard-title" tabindex="-1"></div>
      <ul id="leaderboard-list"></ul>
    </div>
  `;
  return {
    overlay: document.getElementById('leaderboard-overlay') as HTMLElement,
    list: document.getElementById('leaderboard-list') as HTMLUListElement,
  };
}

// leaderboardView.test.ts's VM builders, reused verbatim (fixture names avoid uppercase W/L —
// tester-A brief).
function makeRow(
  identityHex: string,
  displayName: string,
  rating: number,
  wins = 0,
  losses = 0,
  isOwn = false,
): LeaderboardRowViewModel {
  return { identityHex, displayName, rating, wins, losses, isOwn };
}

function makeVm(rows: LeaderboardRowViewModel[]): LeaderboardViewModel {
  return { rows, isEmpty: rows.length === 0 };
}

// ---------------------------------------------------------------------------
// m24s5 SplitSentinels / WalkSubtree / AssertNoRosterWord trio.
// ---------------------------------------------------------------------------

const M24S5_LB_PLAIN_KEYS = new Set(['leaderboard.empty']);
const M24S5_LB_PARAM_KEYS = new Set(['leaderboard.row']);

function m24s5LbIsExpectedSentinelSpan(content: string): boolean {
  const bar = content.indexOf('|');
  if (bar === -1) return M24S5_LB_PLAIN_KEYS.has(content);
  const key = content.slice(0, bar);
  if (!M24S5_LB_PARAM_KEYS.has(key)) return false;
  const tail = content.slice(bar + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

function m24s5LbSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (m24s5LbIsExpectedSentinelSpan(content)) {
      // Elide — a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function m24s5LbWalkSubtree(root: HTMLElement): string[] {
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

const M24S5_LB_ROSTER = ['No ranked players yet', ' (W', '/L'];

function m24s5LbAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s5LbSplitSentinels(texts.join('\n'));
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel`,
  ).toEqual([]);
  for (const word of M24S5_LB_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s5 (ADR-0261, I18N-20): leaderboardView.ts routes its migrated sinks through t()/tf() and renders a <bdi> + tf() row', () => {
  it('m24s5 LB-01: leaderboard.empty/leaderboard.row resolve with the exact key + params in {rating,wins,losses} field order, the <bdi>+text-node shape holds, dataset.identity/own are preserved, and no tf() call argument leaks a fixture name', () => {
    const { list } = mount();
    const view = new LeaderboardView();

    // Empty board.
    view.render(makeVm([]));
    expect(i18nT).toHaveBeenCalledWith('leaderboard.empty');
    const emptyLi = list.querySelector('li')!;
    expect(emptyLi.textContent).toBe('No ranked players yet');

    vi.mocked(i18nT).mockClear();
    vi.mocked(i18nTf).mockClear();

    // Two rows, differing numbers, one own.
    const rows = [
      makeRow('aaa', 'Zed', 1200, 10, 2, true),
      makeRow('bbb', 'Vex', 950, 3, 9, false),
    ];
    view.render(makeVm(rows));

    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(2);

    const zedLi = items[0] as HTMLElement;
    expect(zedLi.childNodes.length, 'exactly ONE <bdi> + ONE text node').toBe(2);
    const bdi = zedLi.childNodes[0] as HTMLElement;
    expect(bdi.tagName).toBe('BDI');
    expect(bdi.attributes.length, 'zero attributes on the <bdi>').toBe(0);
    expect(bdi.children.length, 'zero element children on the <bdi>').toBe(0);
    expect(bdi.textContent).toBe('Zed');
    const zedTextNode = zedLi.childNodes[1] as ChildNode;
    expect(zedTextNode.nodeType, 'TEXT_NODE').toBe(3);
    expect(zedTextNode.textContent, 'leading space + em dash U+2014').toBe(' — 1200 (W10/L2)');
    expect(zedLi.textContent).toBe('Zed — 1200 (W10/L2)');
    expect(zedLi.dataset.identity).toBe('aaa');
    expect(zedLi.dataset.own).toBe('true');

    const vexLi = items[1] as HTMLElement;
    expect(vexLi.textContent).toBe('Vex — 950 (W3/L9)');
    expect(vexLi.dataset.identity).toBe('bbb');
    expect(vexLi.dataset.own, 'non-own row must not carry dataset.own').toBeUndefined();

    expect(i18nTf).toHaveBeenCalledWith('leaderboard.row', { rating: 1200, wins: 10, losses: 2 });
    expect(i18nTf).toHaveBeenCalledWith('leaderboard.row', { rating: 950, wins: 3, losses: 9 });

    let rowCallCount = 0;
    for (const call of vi.mocked(i18nTf).mock.calls) {
      if (call[0] !== 'leaderboard.row') continue;
      rowCallCount += 1;
      const params = call[1] as Record<string, unknown>;
      expect(Object.keys(params), 'field ORDER must be rating, wins, losses').toEqual([
        'rating',
        'wins',
        'losses',
      ]);
      const serialized = JSON.stringify(params);
      expect(serialized.includes('Zed'), 'no tf() call argument may leak a fixture name').toBe(
        false,
      );
      expect(serialized.includes('Vex'), 'no tf() call argument may leak a fixture name').toBe(
        false,
      );
    }
    expect(rowCallCount, 'ANTI-VACUITY: exactly two leaderboard.row calls').toBe(2);
  });

  it('m24s5 LB-02: under «key» sentinels every rendered surface shows resolver output and never an English roster word outside a sentinel', () => {
    const { list } = mount();
    // Constructed BEFORE the sentinel mockImplementation.
    const view = new LeaderboardView();

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );

      view.render(makeVm([]));
      let texts = m24s5LbWalkSubtree(list);
      m24s5LbAssertNoRosterWord(texts, 'empty board');
      expect(texts.join('\n')).toContain('«leaderboard.empty»');

      const rows = [makeRow('aaa', 'Zed', 1200, 10, 2, true)];
      view.render(makeVm(rows));
      texts = m24s5LbWalkSubtree(list);
      m24s5LbAssertNoRosterWord(texts, 'one row');
      const joined = texts.join('\n');
      expect(joined).toContain(
        `«leaderboard.row|${JSON.stringify({ rating: 1200, wins: 10, losses: 2 })}»`,
      );
      expect(joined, 'the name renders raw, never through a resolver').toContain('Zed');
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): leaderboardView.ts scan — zero failing sinks', () => {
  it('m24s5 LB-03: scanSource(stripComments(leaderboardView.ts)) has zero failing sinks, a >=4 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'leaderboardView.ts'),
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
