// @vitest-environment happy-dom
// ui/evolutionNotice.i18n.test.ts — m24s5 (ADR-0261) RED gating tests: evolutionNotice.ts routes
// the pure reveal copy AND the banner's OK label through t()/tf() from the i18n resolver instead
// of raw English literals / template composition.
//
// SOURCE OF TRUTH: /tmp/m24-s5/plan.md §Files/`evolutionNotice.ts`, §Key roster
// `evolutionNotice.*`, §Decisions D4; /tmp/m24-s5/plan-revisions.md Red-team MEDIUM (APPLIED,
// BINDING ON TESTER B) — nested-sentinel correctness is proved ONLY by exact string equality on
// evolutionNoticeLabel's return value, computed by hand from the fixture ids/names, NEVER by
// feeding a string that passed through evolutionNoticeLabel/speciesLabel into a
// SplitSentinels/WalkSubtree walk (the first-`»` matcher would truncate the nested span and
// report a false forged-span). The banner DOM sentinel walk is fed a SYNTHETIC non-nested label.
//
// PREDICTED RED REASON AT HEAD: evolutionNotice.ts imports nothing from './i18n/resolver';
// speciesLabel returns a raw template literal (:71), evolutionNoticeLabel returns raw template
// literals (:93, :95), and the banner writes `okBtn.textContent = 'OK'` in the CONSTRUCTOR (:209),
// never in render(). EN-01 fails on its first `i18nTf`/`i18nT` call assertion (never called, and
// the OK label is already 'OK' pre-render); EN-02 fails because the nested sentinel is never
// produced; EN-03 fails because scanSource reports FAILING raw-English sinks.
//
// NO regex literal and no `new RegExp(...)` anywhere in this file (the sibling's rule — Semgrep
// bans the latter repo-wide and the former blinds this repo's own comment strippers).
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan/revisions
// only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import type { StoreEvolutionReveal } from '../net/store';
import { EvolutionNoticeBanner, evolutionNoticeLabel } from './evolutionNotice';
import { scanSource } from './i18n/hardcodedStrings';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';

// MECHANISM oracle: records every t()/tf() call AND calls through to the real resolver.
vi.mock('./i18n/resolver', { spy: true });

/** One reveal entry. Every field DISTINCT so a field swap is visible (evolutionNotice.test.ts
 *  precedent). */
function reveal(
  monsterId: bigint,
  fromSpecies: number,
  toSpecies: number,
  evolvedAtMs: bigint,
): StoreEvolutionReveal {
  return { monsterId, fromSpecies, toSpecies, evolvedAtMs };
}

/** rb-125 (ADR-0272): every `new EvolutionNoticeBanner(` call in this file now needs a second
 *  `sinks` argument. This file's own assertions are about the i18n resolver call sites, never
 *  about WHICH sink fired — fresh vi.fn() defaults are enough. */
function bannerSinks(): { announce: (message: string) => void; returnFocus: () => void } {
  return { announce: vi.fn(), returnFocus: vi.fn() };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('m24s5 (ADR-0261): evolutionNotice.ts routes its reveal copy and OK label through t()/tf()', () => {
  it('m24s5 EN-01: evolutionNoticeLabel routes the species fallback and the reveal sentence through tf() with exact params and byte-identical output; the banner OK label resolves in render(), never the constructor, and is re-requested on every render', () => {
    // Nicknamed.
    expect(
      evolutionNoticeLabel(reveal(7n, 1, 2, 100n), {
        nickname: 'Sparky',
        fromName: 'Flameling',
        toName: 'Flamewing',
      }),
    ).toBe('Sparky evolved from Flameling into Flamewing!');
    expect(i18nTf).toHaveBeenCalledWith('evolutionNotice.reveal.nicknamed', {
      nickname: 'Sparky',
      from: 'Flameling',
      to: 'Flamewing',
    });

    // Absent nickname (undefined) -> anonymous branch.
    vi.mocked(i18nTf).mockClear();
    expect(
      evolutionNoticeLabel(reveal(7n, 1, 2, 100n), {
        nickname: undefined,
        fromName: 'Flameling',
        toName: 'Flamewing',
      }),
    ).toBe('Your Flameling evolved into Flamewing!');
    expect(i18nTf).toHaveBeenCalledWith('evolutionNotice.reveal.anonymous', {
      from: 'Flameling',
      to: 'Flamewing',
    });

    // EMPTY-STRING nickname -> also the anonymous branch (the store's un-nicknamed convention).
    vi.mocked(i18nTf).mockClear();
    expect(
      evolutionNoticeLabel(reveal(7n, 1, 2, 100n), {
        nickname: '',
        fromName: 'Flameling',
        toName: 'Flamewing',
      }),
    ).toBe('Your Flameling evolved into Flamewing!');
    expect(i18nTf).toHaveBeenCalledWith('evolutionNotice.reveal.anonymous', {
      from: 'Flameling',
      to: 'Flamewing',
    });

    // A missing (undefined) species name falls back to Species #<id>, proved through the sentence.
    vi.mocked(i18nTf).mockClear();
    expect(
      evolutionNoticeLabel(reveal(7n, 31, 2, 100n), {
        nickname: undefined,
        fromName: undefined,
        toName: 'Flamewing',
      }),
    ).toBe('Your Species #31 evolved into Flamewing!');
    expect(i18nTf).toHaveBeenCalledWith('evolutionNotice.species.fallback', { id: 31 });
    expect(i18nTf).toHaveBeenCalledWith('evolutionNotice.reveal.anonymous', {
      from: 'Species #31',
      to: 'Flamewing',
    });

    // An EMPTY species name also falls back.
    vi.mocked(i18nTf).mockClear();
    expect(
      evolutionNoticeLabel(reveal(7n, 31, 2, 100n), {
        nickname: undefined,
        fromName: '',
        toName: 'Flamewing',
      }),
    ).toBe('Your Species #31 evolved into Flamewing!');
    expect(i18nTf).toHaveBeenCalledWith('evolutionNotice.species.fallback', { id: 31 });

    // The banner: the OK label resolves in render(), never the constructor (D4).
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), bannerSinks());
    const ok = document.getElementById('evolution-notice-ok') as HTMLButtonElement;
    expect(
      ok.textContent,
      'the constructor must no longer write the OK label -- render() does',
    ).toBe('');
    expect(
      i18nT,
      'the constructor must not call the resolver for the OK label',
    ).not.toHaveBeenCalledWith('evolutionNotice.ok');

    banner.render({ key: 'synthetic-1', label: 'a synthetic label' });
    expect(i18nT).toHaveBeenCalledWith('evolutionNotice.ok');
    expect(ok.textContent).toBe('OK');

    vi.mocked(i18nT).mockClear();
    banner.render({ key: 'synthetic-2', label: 'another synthetic label' });
    expect(
      i18nT,
      'a second render() re-requests the OK key -- it runs every store batch, unconditionally',
    ).toHaveBeenCalledWith('evolutionNotice.ok');
    expect(ok.textContent).toBe('OK');
  });

  it("m24s5 EN-02: BINDING nested-sentinel rule -- under «key» sentinels, evolutionNoticeLabel's nested species-fallback composition is proved by EXACT string equality on the return value, never by walking the DOM; the banner walk uses a SYNTHETIC non-nested label", () => {
    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );

      // Anonymous + nested species fallback on the FROM side. The expected string is assembled
      // independently, using the SAME formula configured above, never by calling the SUT.
      const nestedFallback31 = `«evolutionNotice.species.fallback|${JSON.stringify({ id: 31 })}»`;
      const expectedAnon = `«evolutionNotice.reveal.anonymous|${JSON.stringify({
        from: nestedFallback31,
        to: 'Flamewing',
      })}»`;
      const anon = evolutionNoticeLabel(reveal(7n, 31, 2, 100n), {
        nickname: undefined,
        fromName: undefined,
        toName: 'Flamewing',
      });
      expect(anon).toBe(expectedAnon);

      // Nicknamed + nested species fallback on the FROM side, a DIFFERENT species id.
      const nestedFallback44 = `«evolutionNotice.species.fallback|${JSON.stringify({ id: 44 })}»`;
      const expectedNicknamed = `«evolutionNotice.reveal.nicknamed|${JSON.stringify({
        nickname: 'Sparky',
        from: nestedFallback44,
        to: 'Cindermaw',
      })}»`;
      const nicknamed = evolutionNoticeLabel(reveal(7n, 44, 88, 100n), {
        nickname: 'Sparky',
        fromName: undefined,
        toName: 'Cindermaw',
      });
      expect(nicknamed).toBe(expectedNicknamed);
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }

    // The banner DOM walk: a SYNTHETIC, non-nested label -- never a string that passed through
    // evolutionNoticeLabel/speciesLabel under the mock.
    document.body.innerHTML = '';
    const banner = new EvolutionNoticeBanner(() => Promise.resolve(), bannerSinks());
    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      banner.render({ key: 'zzz-entry', label: 'zzz' });
      const ok = document.getElementById('evolution-notice-ok')!;
      expect(ok.textContent).toBe('«evolutionNotice.ok»');
      expect(
        ok.textContent?.includes('OK'),
        'no bare English roster word "OK" must survive outside the sentinel',
      ).toBe(false);
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): evolutionNotice.ts scan — zero failing sinks', () => {
  it('m24s5 EN-03: scanSource(stripComments(evolutionNotice.ts)) has zero failing sinks, a >=2 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'evolutionNotice.ts'),
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
