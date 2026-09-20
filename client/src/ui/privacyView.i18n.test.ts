// @vitest-environment happy-dom
// ui/privacyView.i18n.test.ts — m24s5 (ADR-0261) RED gating tests: privacyView.ts routes its
// title/close/confirm-row strings through t() from the i18n resolver instead of raw English
// literals.
//
// SOURCE OF TRUTH: /tmp/m24-s5/plan.md §Files/`privacyView.ts`, §Key roster `privacy.*`, §Decisions
// D4; /tmp/m24-s5/plan-revisions.md Red-team MAJOR-1 (APPLIED) — `privacy.title`/`privacy.close`
// resolve in show() (an INDEPENDENT open door), NOT render() (render never opens the overlay);
// `privacy.confirm.delete`/`.keep` stay in render(). The close-anchor's `display=''`/`disabled`
// invariants and `#title.style.display=''` stay in the constructor (RB52V-ANCHOR-NEVER-DISABLED
// must keep its meaning).
//
// PREDICTED RED REASON AT HEAD: privacyView.ts writes 'Privacy & Account Data' / 'Close' in the
// CONSTRUCTOR (:145, :151) and 'Confirm deletion' / 'Keep my account' as raw literals in render()
// (:187, :188); it imports nothing from './i18n/resolver'. PV-01 fails on its first `i18nT` call
// assertion (never called, and the pre-show text is NOT '' at HEAD); PV-02 fails because the
// roster words survive unbracketed; PV-03 fails because scanSource reports FAILING raw-English
// sinks.
//
// This view calls openOverlayA11y in show() (m22-s8/rb-52) — the file-level before/afterEach call
// the PRODUCTION closeOverlayA11y('privacyView', null) + flush one real macrotask, the sanctioned
// test-isolation device (ui/privacyView.test.ts precedent).
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan/revisions
// only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { scanSource } from './i18n/hardcodedStrings';
import { t as i18nT } from './i18n/resolver';
import { closeOverlayA11y } from './overlayA11y';
import { PRIVACY_PSEUDONYMIZATION_DISCLOSURE, type PrivacyViewModel } from './privacyBanner';
import { PrivacyView, type PrivacyViewHandlers } from './privacyView';

// MECHANISM oracle: records every t() call AND calls through to the real resolver, so PV-01's DOM
// byte-identity assertions still work under the real (call-through) path.
vi.mock('./i18n/resolver', { spy: true });

async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** SYNTHETIC values only — none of these strings contain a `privacy.*` catalog roster word
 *  (Privacy, Account, Close, Confirm deletion, Keep my account), so they double as PV-02's
 *  fixture without collision. */
function vmOf(overrides: Partial<PrivacyViewModel> = {}): PrivacyViewModel {
  return {
    statusLabel: 'SYNTHETIC STATUS',
    deleteLabel: 'SYNTHETIC DELETE',
    cancelLabel: 'SYNTHETIC CANCEL',
    exportLabel: 'SYNTHETIC EXPORT',
    deleteEnabled: true,
    cancelEnabled: true,
    exportEnabled: true,
    confirmPrompt: undefined,
    noticeKind: 'none',
    noticeLabel: undefined,
    exportStatusLabel: undefined,
    downloadLabel: 'SYNTHETIC DOWNLOAD',
    downloadEnabled: false,
    ...overrides,
  };
}

function freshHandlers(): PrivacyViewHandlers {
  return {
    onDeleteRequested: vi.fn(),
    onDeleteConfirmed: vi.fn(),
    onConfirmCancelled: vi.fn(),
    onCancelDeletion: vi.fn(),
    onExportRequested: vi.fn(),
    onExportDownload: vi.fn(),
    onDismissed: vi.fn(),
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

afterEach(async () => {
  closeOverlayA11y('privacyView', null);
  await flushMacrotask();
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// PV-02 sentinel helpers. Whole-phrase roster (never single words): the disclosure and the
// status/notice copy are RAW model text rendered alongside the migrated keys, and
// PRIVACY_PSEUDONYMIZATION_DISCLOSURE legitimately contains the bare word "deletion" — a
// single-word roster entry would false-positive on it. The real CONFIRM_PROMPT constant
// ('This cannot be undone. Confirm deletion?') itself contains the phrase "Confirm deletion",
// which is exactly why PV-02 never renders it (plan-revisions: SYNTHETIC vm labels only).
// ---------------------------------------------------------------------------

const PV_PLAIN_KEYS = new Set([
  'privacy.title',
  'privacy.close',
  'privacy.confirm.delete',
  'privacy.confirm.keep',
]);

function pvIsExpectedSentinelSpan(content: string): boolean {
  return PV_PLAIN_KEYS.has(content);
}

function pvSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (pvIsExpectedSentinelSpan(content)) {
      // Elide.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

function pvWalkSubtree(root: HTMLElement): string[] {
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

const PV_ROSTER = ['Privacy & Account Data', 'Close', 'Confirm deletion', 'Keep my account'];

function pvAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = pvSplitSentinels(texts.join('\n'));
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel`,
  ).toEqual([]);
  for (const word of PV_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster phrase "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s5 (ADR-0261): privacyView.ts routes title/close through show() and confirm-row through render()', () => {
  it('m24s5 PV-01: privacy.title/privacy.close resolve ONLY in show(); privacy.confirm.delete/.keep resolve in render() unconditionally; render() alone is not a door; model strings and the disclosure stay raw; repeat calls re-request; no cross-alias to claim.privacyButton', () => {
    const view = new PrivacyView(freshHandlers());
    const title = document.getElementById('privacy-title')!;
    const closeBtn = document.getElementById('privacy-close-btn') as HTMLButtonElement;

    // Pre-show anchor invariants: the constructor still owns these (D4), unchanged by the migration.
    expect(title.textContent, 'the constructor must no longer write the title literal').toBe('');
    expect(closeBtn.textContent, 'the constructor must no longer write the close literal').toBe('');
    expect(
      closeBtn.disabled,
      'the anchor stays enabled pre-show (RB52V-ANCHOR-NEVER-DISABLED)',
    ).toBe(false);
    expect(closeBtn.style.display, 'the anchor stays un-hidden pre-show').toBe('');
    expect(title.style.display, 'the title stays un-hidden pre-show').toBe('');
    expect(i18nT).not.toHaveBeenCalledWith('privacy.title');
    expect(i18nT).not.toHaveBeenCalledWith('privacy.close');

    view.show();
    expect(i18nT).toHaveBeenCalledWith('privacy.title');
    expect(i18nT).toHaveBeenCalledWith('privacy.close');
    expect(title.textContent).toBe('Privacy & Account Data');
    expect(closeBtn.textContent).toBe('Close');

    // A FRESH view: render() ALONE is NOT a door for the title/close pair.
    document.body.replaceChildren();
    vi.mocked(i18nT).mockClear();
    const freshView = new PrivacyView(freshHandlers());
    const freshTitle = document.getElementById('privacy-title')!;
    const freshClose = document.getElementById('privacy-close-btn') as HTMLButtonElement;
    freshView.render(vmOf());
    expect(freshTitle.textContent, 'render() alone must not open the title door').toBe('');
    expect(freshClose.textContent, 'render() alone must not open the close door').toBe('');
    expect(i18nT).not.toHaveBeenCalledWith('privacy.title');
    expect(i18nT).not.toHaveBeenCalledWith('privacy.close');

    // render() WITH a confirmPrompt: confirm.delete/.keep resolve; model strings + disclosure raw.
    vi.mocked(i18nT).mockClear();
    freshView.render(
      vmOf({
        statusLabel: 'SYNTHETIC STATUS A',
        confirmPrompt: 'SYNTHETIC PROMPT A',
        noticeLabel: 'SYNTHETIC NOTICE A',
      }),
    );
    expect(i18nT).toHaveBeenCalledWith('privacy.confirm.delete');
    expect(i18nT).toHaveBeenCalledWith('privacy.confirm.keep');
    const confirmBtn = document.getElementById('privacy-confirm-btn') as HTMLButtonElement;
    const confirmCancelBtn = document.getElementById(
      'privacy-confirm-cancel-btn',
    ) as HTMLButtonElement;
    expect(confirmBtn.textContent).toBe('Confirm deletion');
    expect(confirmCancelBtn.textContent).toBe('Keep my account');
    expect(
      document.getElementById('privacy-status')!.textContent,
      'statusLabel is raw model data',
    ).toBe('SYNTHETIC STATUS A');
    expect(
      document.getElementById('privacy-confirm')!.textContent,
      'confirmPrompt is raw model data',
    ).toBe('SYNTHETIC PROMPT A');
    expect(
      document.getElementById('privacy-notice')!.textContent,
      'noticeLabel is raw model data',
    ).toBe('SYNTHETIC NOTICE A');
    expect(document.getElementById('privacy-disclosure')!.textContent).toBe(
      PRIVACY_PSEUDONYMIZATION_DISCLOSURE,
    );
    expect(i18nT).not.toHaveBeenCalledWith('SYNTHETIC STATUS A');
    expect(i18nT).not.toHaveBeenCalledWith('SYNTHETIC PROMPT A');

    // render() WITHOUT a confirmPrompt: labels stay painted (D3), only the display toggles.
    vi.mocked(i18nT).mockClear();
    freshView.render(vmOf({ confirmPrompt: undefined }));
    expect(i18nT).toHaveBeenCalledWith('privacy.confirm.delete');
    expect(i18nT).toHaveBeenCalledWith('privacy.confirm.keep');
    expect(confirmBtn.textContent).toBe('Confirm deletion');
    expect(confirmCancelBtn.textContent).toBe('Keep my account');
    expect(confirmBtn.style.display).toBe('none');
    expect(confirmCancelBtn.style.display).toBe('none');

    // Repeat show() on the FIRST view re-requests title+close (RT2).
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(i18nT).toHaveBeenCalledWith('privacy.title');
    expect(i18nT).toHaveBeenCalledWith('privacy.close');

    // D2 cross-alias tooth: the coincident English 'Privacy & Account Data' must never satisfy
    // claim.privacyButton from this file's call sites.
    expect(i18nT).not.toHaveBeenCalledWith('claim.privacyButton');
  });

  it('m24s5 PV-02: under «key» sentinels, every migrated surface shows resolver output and no English roster phrase survives outside a sentinel', () => {
    // Constructed BEFORE mockImplementation.
    const view = new PrivacyView(freshHandlers());

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);

      view.show();
      view.render(vmOf({ confirmPrompt: 'SYNTHETIC PROMPT B', statusLabel: 'SYNTHETIC STATUS B' }));

      const overlay = document.getElementById('privacy-overlay')!;
      let texts = pvWalkSubtree(overlay);
      pvAssertNoRosterWord(texts, 'privacy overlay (armed)');
      let joined = texts.join('\n');
      expect(joined).toContain('«privacy.title»');
      expect(joined).toContain('«privacy.close»');
      expect(joined).toContain('«privacy.confirm.delete»');
      expect(joined).toContain('«privacy.confirm.keep»');
      expect(joined, 'PRIVACY_PSEUDONYMIZATION_DISCLOSURE stays raw').toContain(
        PRIVACY_PSEUDONYMIZATION_DISCLOSURE,
      );
      expect(joined, 'statusLabel stays raw').toContain('SYNTHETIC STATUS B');

      // The disarmed branch too: confirm labels are still painted (D3), just off screen.
      view.render(vmOf({ confirmPrompt: undefined, statusLabel: 'SYNTHETIC STATUS B' }));
      texts = pvWalkSubtree(overlay);
      pvAssertNoRosterWord(texts, 'privacy overlay (disarmed)');
      joined = texts.join('\n');
      expect(joined).toContain('«privacy.confirm.delete»');
      expect(joined).toContain('«privacy.confirm.keep»');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s5 (ADR-0261): privacyView.ts scan — zero failing sinks', () => {
  it('m24s5 PV-03: scanSource(stripComments(privacyView.ts)) has zero failing sinks, a >=7 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'privacyView.ts'),
      'utf8',
    );
    const result = scanSource(stripComments(src));

    expect(
      result.failing.map((s) => `${s.kind}@L${s.line}: ${s.failingSegments.join(' | ')}`),
    ).toEqual([]);
    expect(result.sinks.length).toBeGreaterThanOrEqual(7);
    expect(result.unterminated).toBe(false);
    expect(result.maskedSinkTokens).toBe(0);
    for (const sink of result.sinks) {
      expect(sink.truncated, `${sink.kind}@L${sink.line} must not be truncated`).toBe(false);
    }
  });
});
