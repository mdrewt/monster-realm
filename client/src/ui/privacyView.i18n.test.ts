// @vitest-environment happy-dom
// ui/privacyView.i18n.test.ts — m24s5 RED gating tests: privacyView.ts routes its
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
// roster words survive unbracketed.
//
// This view calls openOverlayA11y in show() (m22-s8/rb-52) — the file-level before/afterEach call
// the PRODUCTION closeOverlayA11y('privacyView', null) + flush one real macrotask, the sanctioned
// test-isolation device (ui/privacyView.test.ts precedent).
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan/revisions
// only.
//
// uif-16b (named key move): `#privacy-close-btn` RETIRES with the privacy overlay's own dialog, so
// `privacy.close` is no longer this view's key: ProfileView paints it onto `#profile-close-btn`
// on every show() (the last describe below). `privacy.title` stays this view's (the section
// header). The per-id close `closeOverlayA11y('privacyView', …)` becomes the all-id sweep
// (`privacyView` is no longer an OverlayId).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimView } from './claimView';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
import { t as i18nT, setLocale } from './i18n/resolver';
import { closeOverlayA11y } from './overlayA11y';
import { OVERLAY_IDS } from './overlayRegistry';
import { PRIVACY_PSEUDONYMIZATION_DISCLOSURE, type PrivacyViewModel } from './privacyBanner';
import { PrivacyView, type PrivacyViewHandlers } from './privacyView';
import { ProfileView } from './profileView';
import { RenameView } from './renameView';

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
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
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
  it('m24s5 PV-01: privacy.title resolves ONLY in show() and privacy.close NOT AT ALL (uif-16b: the frame owns Close); privacy.confirm.delete/.keep resolve in render() unconditionally; render() alone is not a door; model strings and the disclosure stay raw; repeat calls re-request; no cross-alias to claim.privacyButton', () => {
    // uif-16b (named key move): the close-anchor half of this test retires with
    // #privacy-close-btn; `privacy.close` is asserted NEVER requested by this view (the frame's
    // describe below owns it). Was: the anchor's pre-show invariants and its 'Close' label.
    const view = new PrivacyView(freshHandlers());
    const title = document.getElementById('privacy-title')!;
    expect(document.getElementById('privacy-close-btn'), 'the close anchor retired').toBeNull();

    // Pre-show: the constructor still owns the title's un-hide (D4), not its text.
    expect(title.textContent, 'the constructor must no longer write the title literal').toBe('');
    expect(title.style.display, 'the title stays un-hidden pre-show').toBe('');
    expect(i18nT).not.toHaveBeenCalledWith('privacy.title');

    view.show();
    expect(i18nT).toHaveBeenCalledWith('privacy.title');
    expect(i18nT, 'the section no longer resolves the frame`s Close').not.toHaveBeenCalledWith(
      'privacy.close',
    );
    expect(title.textContent).toBe('Privacy & Account Data');

    // A FRESH view: render() ALONE is NOT a door for the title.
    document.body.replaceChildren();
    vi.mocked(i18nT).mockClear();
    const freshView = new PrivacyView(freshHandlers());
    const freshTitle = document.getElementById('privacy-title')!;
    freshView.render(vmOf());
    expect(freshTitle.textContent, 'render() alone must not open the title door').toBe('');
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

    // Repeat show() on the FIRST view re-requests the title (RT2), and still never Close.
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(i18nT).toHaveBeenCalledWith('privacy.title');
    expect(i18nT).not.toHaveBeenCalledWith('privacy.close');

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
      // uif-16b (named key move): Close is the frame's now, not in this section.
      expect(joined).not.toContain('«privacy.close»');
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
    expect(i18nT('chrome.help.title')).toBe('How to Play');
  });
});

describe('uif-16b: ProfileView paints privacy.close on #profile-close-btn and menu.profile.title on #profile-title', () => {
  const plain = (catalog: object, key: string): string => {
    const entry = (catalog as Record<string, unknown>)[key];
    if (typeof entry !== 'string') throw new Error(`${key} must be a plain message`);
    return entry;
  };

  function buildFrame(): ProfileView {
    document.body.innerHTML = `
      <div id="game-screen"><div id="app"></div><div id="frame-layer">
        <div id="rename-overlay" class="mr-button-rows" style="display:none">
          <div id="rename-current"></div>
          <input id="rename-input" type="text" maxlength="24" />
          <button id="rename-submit" type="button"></button>
        </div>
      </div></div>`;
    const rename = new RenameView({ onSubmit: async () => {} });
    const claim = new ClaimView({
      onSignIn: vi.fn(),
      onJoin: vi.fn(),
      onDeclineRequested: vi.fn(),
      onDeclineConfirmed: vi.fn(),
      onDeclineCancelled: vi.fn(),
      onPrivacy: vi.fn(),
      onDismissed: vi.fn(),
    });
    let frame: ProfileView | undefined;
    const privacy = new PrivacyView({ ...freshHandlers(), fallbackRow: () => frame?.closeRow });
    frame = new ProfileView({ name: rename, account: claim, privacy });
    return frame;
  }

  it('UIF16B.2 the frame`s Close label and title are requested on every show() (a repeat included), never by the constructor, render as the «key» sentinel, and follow the fr locale', () => {
    // WRONG IMPL KILLED: a Close label written once in the constructor (stale after a locale
    // switch, empty if the locale is negotiated after boot); a write gated on the open edge (a
    // repeat show() would not re-resolve); hard-coded English (the sentinel and fr checks never
    // see a resolver result); a Close labelled with the claim door's coincident key.
    const frame = buildFrame();
    expect(i18nT, 'the constructor does not resolve Close').not.toHaveBeenCalledWith(
      'privacy.close',
    );
    const close = document.getElementById('profile-close-btn') as HTMLButtonElement;
    const title = document.getElementById('profile-title') as HTMLElement;
    expect(close.textContent, 'empty until a show()').toBe('');

    frame.show('account');
    expect(i18nT).toHaveBeenCalledWith('privacy.close');
    expect(i18nT).toHaveBeenCalledWith('menu.profile.title');
    expect(close.textContent).toBe(plain(CATALOG_EN, 'privacy.close'));
    expect(title.textContent).toBe(plain(CATALOG_EN, 'menu.profile.title'));

    vi.mocked(i18nT).mockClear();
    frame.show('account');
    expect(i18nT, 'a repeat show() re-resolves Close').toHaveBeenCalledWith('privacy.close');
    expect(i18nT, 'and the title').toHaveBeenCalledWith('menu.profile.title');

    try {
      setLocale('fr');
      frame.show('account');
      expect(close.textContent, 'fr Close').toBe(plain(CATALOG_FR, 'privacy.close'));
      expect(title.textContent, 'fr title').toBe(plain(CATALOG_FR, 'menu.profile.title'));
    } finally {
      setLocale('en');
    }

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      frame.show('account');
      expect(close.textContent, 'exactly the sentinel').toBe('«privacy.close»');
      expect(title.textContent, 'exactly the sentinel').toBe('«menu.profile.title»');
    } finally {
      vi.mocked(i18nT).mockRestore();
    }
  });
});
