// @vitest-environment happy-dom
// ui/leaderboardView.test.ts — RED gating tests for m17b §RL-13 + §RL-15.
//
// Slice: m17b · Source-of-truth spec: M17-ranked-ladder.spec.md §RL-13 / §RL-15
//
// RED REASON: leaderboardView.ts does not exist yet.
// Every test below will fail with:
//   "Failed to resolve import './leaderboardView'" (module-not-found)
//
// WRONG-IMPL-KILLED list (one per criterion):
//   - "constructor accepts callback arg"       → zero-arity + RL15-arity test catches it
//   - "no throw when overlay missing"          → throw-on-missing-overlay test catches it
//   - "no throw when list missing"             → throw-on-missing-list test catches it
//   - "visible=true at construction"           → initial-hidden test catches it
//   - "show/hide/toggle not wired"             → visibility tests catch it
//   - "empty board shows nothing"             → empty-render test catches it
//   - "no <li> per row"                        → row-render count test catches it
//   - "identity not stored in dataset"         → dataset.identity test catches it
//   - "own-row dataset.own not set"            → own-row marker test catches it
//   - "re-render appends not replaces"         → re-render-replaces test catches it
//   - "innerHTML=data (XSS hole)"              → XSS tooth catches it
//   - "module_bindings imported"               → RL-15 source-scan catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.
// Corrections must be traced to the spec and must not weaken the bite.
//
// ---------------------------------------------------------------------------
// m23-s3 ADDITION (2026-08-24) — overlay a11y wiring. ADDITIVE ONLY: nothing above was weakened
// or deleted; the mount helper gained the `role`/`aria-modal`/`tabindex` attributes
// client/index.html:52-53 has always shipped, and a file-level a11y sweep was added.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/16);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F7, §1 D1/D2/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X6/X8; ADR-0205 D1-D4, A3.
//
// RED REASON (m23-s3): `client/src/ui/leaderboardView.ts` DOES NOT CALL
// openOverlayA11y/closeOverlayA11y at all today — show() is a single `style.display = ''`
// (ui/leaderboardView.ts:28-30). Every S3-* test below therefore fails now; every RL-13/RL-15 test
// above still passes. NOTE this view is NOT coverage-excluded (vite.config.ts), so the two new
// branches must be executed by tests — S3-leaderboardView-HELPER-CALLED runs both.
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['leaderboardView'].labelKey)`.
//     `role`/`aria-modal` are ALREADY static literals on the shell in client/index.html:52
//     (m23-s2), so asserting them ALONE is VACUOUS: a view that calls nothing passes. They are
//     asserted only alongside aria-label, and their ABSENCE after close is the partner (attack V1).
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through to the real implementation, so a cheat that hand-writes the three attributes with the
//     correct copied literal (no trap, no return-focus record, no timer) still reds.
//
// TEST-ISOLATION DEVICE (plan A8 / V7, copied from ui/overlayA11y.test.ts:97-105): overlayA11y.ts
// holds ONE module-private Map and exports no reset hook, so the file-level beforeEach/afterEach
// call the PRODUCTION closeOverlayA11y(id, null) for every OverlayId and flush ONE REAL MACROTASK
// — legal because close-without-open is a documented no-op (ui/overlayA11y.ts:41-45). It also
// cancels the deferred-focus timer every pre-existing `view.show()` above will schedule once the
// wiring lands (plan residual A12). `vi.clearAllMocks()` runs LAST so the sweep never pollutes a
// count.
//
// m23-s3 WRONG-IMPL-KILLED index:
//   - never opens / attribute-only cheat                 -> S3-leaderboardView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId                        -> S3-leaderboardView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - synchronous focus (no defer)                       -> S3-leaderboardView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / a wrapper, not the anchor         -> S3-leaderboardView-DEFER-FOCUS (identity)
//   - close never strips ARIA / never restores focus      -> S3-leaderboardView-CLOSE-RESTORE
//   - UNGUARDED show() / `this.visible` read AFTER the write -> S3-leaderboardView-REPEAT-NO-REOPEN
//   - `fallbackFocus` passed as undefined/an element       -> S3-leaderboardView-HELPER-CALLED (literal null)
//   - GUARDED close in hide() (plan anti-pattern #3 — kills S1's A13 self-heal)
//                                                        -> S3-leaderboardView-CLOSE-UNGUARDED

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import type { LeaderboardViewModel } from './leaderboardModel';
import { LeaderboardView, type SocialRankingsPaint } from './leaderboardView';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import type { SocialPlayerRow } from './socialModel';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });
// ctl-8g (named intentional change to this file's setup): the same spy on the i18n resolver, so the
// CTL8G view cases can read every key and argument the view resolves (I18N-21: a player-chosen
// name is never a resolver argument). It calls through, so every existing case reads real catalog
// text, and the file-level `vi.clearAllMocks()` below resets its counts per case.
vi.mock('./i18n/resolver', { spy: true });

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer (plan anti-pattern #10). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// NEW file-level isolation hooks. They run BEFORE the describe-level `mountLeaderboardOverlay`
// hooks below, so every test still gets the DOM it always got.
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

// ---------------------------------------------------------------------------
// DOM mount helper — mirrors the additions to client/index.html.
// Called in beforeEach so each test gets a fresh DOM.
// ---------------------------------------------------------------------------

function mountLeaderboardOverlay(): {
  overlay: HTMLElement;
  list: HTMLUListElement;
} {
  // Tear down any leftover from a previous test to keep happy-dom state clean.
  const existing = document.getElementById('leaderboard-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'leaderboard-overlay';
  overlay.style.display = 'none';
  // m23-s3 FIXTURE FIDELITY: the shell has shipped these two as STATIC LITERALS
  // since m23-s2. They are copied here NOT to be asserted on their own — that is vacuous, a view
  // calling nothing passes — but so that "all three attributes ABSENT after close" is a real
  // tooth: only closeOverlayA11y can remove them.
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const title = document.createElement('div');
  title.id = 'leaderboard-title';
  // m23-s3: the OVERLAY_A11Y initialFocusSelector anchor. Copied for fidelity
  // only — happy-dom focuses a bare <div> with no tabindex at all, so this buys ZERO test power
  // (plan A7) and a passing A11Y-14 here is NOT proof a real browser would honour the focus.
  title.setAttribute('tabindex', '-1');
  overlay.appendChild(title);

  const list = document.createElement('ul');
  list.id = 'leaderboard-list';
  overlay.appendChild(list);

  document.body.appendChild(overlay);
  return { overlay, list };
}

function teardown(): void {
  const el = document.getElementById('leaderboard-overlay');
  if (el) el.remove();
}

// ---------------------------------------------------------------------------
// ViewModel factories (pure data — no DOM, no SDK)
// ---------------------------------------------------------------------------

function makeRow(
  identityHex: string,
  displayName: string,
  rating: number,
  wins = 0,
  losses = 0,
  isOwn = false,
): import('./leaderboardModel').LeaderboardRowViewModel {
  return { identityHex, displayName, rating, wins, losses, isOwn };
}

function makeVm(
  rows: import('./leaderboardModel').LeaderboardRowViewModel[],
): LeaderboardViewModel {
  return { rows, isEmpty: rows.length === 0 };
}

// ---------------------------------------------------------------------------
// Constructor: throw paths
// ---------------------------------------------------------------------------

describe('RL13-view-constructor: LeaderboardView constructor validation', () => {
  it('RL13-ctor-01 BITES: constructor throws when #leaderboard-overlay is absent — kills no-guard impl', () => {
    // Kills: an impl that silently stores null from querySelector without guarding.
    // DOM has NO overlay element (never mounted in this test).
    teardown();
    expect(() => new LeaderboardView()).toThrow();
  });

  it('RL13-ctor-02 BITES: constructor throws when #leaderboard-list is absent — kills partial-DOM impl', () => {
    // Mount overlay WITHOUT the list to drive the second throw path.
    // Kills: an impl that only checks for #leaderboard-overlay, not #leaderboard-list.
    teardown();
    const overlay = document.createElement('div');
    overlay.id = 'leaderboard-overlay';
    overlay.style.display = 'none';
    // Deliberately no #leaderboard-list child
    document.body.appendChild(overlay);

    expect(() => new LeaderboardView()).toThrow();

    overlay.remove();
  });

  it('RL15-arity BITES: LeaderboardView.length === 0 — adding a callbacks param is a breaking RL-15 violation', () => {
    // RL-15: no client write path to profile; the view is pure subscription → zero-arg ctor.
    // Adding a callbacks param would be a breaking change to the RL-15 contract.
    // Kills: any impl that accepts a callbacks object (which could include a write-profile call).
    mountLeaderboardOverlay();
    expect(LeaderboardView.length).toBe(0);
    teardown();
  });
});

// ---------------------------------------------------------------------------
// Visibility: visible / show / hide / toggle
// ---------------------------------------------------------------------------

describe('RL13-view-visibility: show / hide / toggle / visible', () => {
  beforeEach(() => {
    mountLeaderboardOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('RL13-vis-01 BITES: visible is false initially (display:none) — kills visible=true-at-construction impl', () => {
    // Kills: an impl that sets display:block in the constructor or returns visible=true initially.
    const view = new LeaderboardView();
    expect(view.visible).toBe(false);
  });

  it('RL13-vis-02 BITES: show() makes visible=true — kills no-op show impl', () => {
    // Kills: an impl where show() does nothing / visible getter always returns false.
    const view = new LeaderboardView();
    view.show();
    expect(view.visible).toBe(true);
  });

  it('RL13-vis-03 BITES: hide() makes visible=false — kills no-op hide impl', () => {
    // Kills: an impl where hide() does nothing / visible getter always returns true after show.
    const view = new LeaderboardView();
    view.show();
    expect(view.visible).toBe(true);
    view.hide();
    expect(view.visible).toBe(false);
  });

  it('RL13-vis-04 BITES: toggle() flips from false to true — kills toggle that always hides', () => {
    // Kills: an impl that only ever calls hide() in toggle().
    const view = new LeaderboardView();
    expect(view.visible).toBe(false);
    view.toggle();
    expect(view.visible).toBe(true);
  });

  it('RL13-vis-05 BITES: toggle() flips from true to false — kills toggle that always shows', () => {
    // Kills: an impl that only ever calls show() in toggle().
    const view = new LeaderboardView();
    view.show();
    expect(view.visible).toBe(true);
    view.toggle();
    expect(view.visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Render: empty branch
// ---------------------------------------------------------------------------

describe('RL13-render-empty: isEmpty:true → "No ranked players yet" message', () => {
  beforeEach(() => {
    mountLeaderboardOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('RL13-empty-01 BITES: empty VM shows exactly one <li> with "No ranked players yet" — kills blank-render impl', () => {
    // Kills: an impl that renders nothing for isEmpty:true, or renders multiple items.
    const view = new LeaderboardView();
    view.show();
    view.render(makeVm([]));

    const list = document.getElementById('leaderboard-list')!;
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toBe('No ranked players yet');
  });
});

// ---------------------------------------------------------------------------
// Render: row branch
// ---------------------------------------------------------------------------

describe('RL13-render-rows: row render — identity/rating/W/L text/own-row marker', () => {
  beforeEach(() => {
    mountLeaderboardOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('RL13-rows-01 BITES: one <li> per VM row in VM order — kills row-count mismatch or re-sort impl', () => {
    // The VIEW must not re-sort; it renders in the order the VM provides.
    // Fixture rows are in NON-rating order (Bob/1000 first, then Alice/1200, then Carol/800)
    // so a view that re-sorts by rating descending would produce ['aaa','bbb','ccc'] instead
    // of the expected VM order ['bbb','aaa','ccc']. This kills a re-sort-in-render impl.
    // Kills: an impl that re-sorts in render(), skips rows, or reorders by rating.
    const rows = [
      makeRow('bbb', 'Bob', 1000, 5, 5, false), // index 0 in VM — NOT highest rating
      makeRow('aaa', 'Alice', 1200, 10, 2, true), // index 1 in VM — highest rating
      makeRow('ccc', 'Carol', 800, 3, 8, false), // index 2 in VM
    ];
    const view = new LeaderboardView();
    view.show();
    view.render(makeVm(rows));

    const list = document.getElementById('leaderboard-list')!;
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(3);

    // VM order (Bob→Alice→Carol) must be preserved exactly — NOT rating order.
    const identities = Array.from(items).map((li) => (li as HTMLElement).dataset.identity);
    expect(identities).toEqual(['bbb', 'aaa', 'ccc']);
  });

  it('RL13-rows-02 BITES: each li textContent contains displayName, rating, "W<wins>", "L<losses>" — kills missing field impl', () => {
    // RL-13 spec: "shows rating/W/L" per row (contractual per docs/specs/m17b-plan.md).
    // Kills: an impl that shows name but omits rating, or shows rating but omits W/L.
    const view = new LeaderboardView();
    view.show();
    view.render(makeVm([makeRow('aaa', 'Alice', 1200, 10, 2)]));

    const list = document.getElementById('leaderboard-list')!;
    const li = list.querySelector('li') as HTMLElement;
    const text = li.textContent ?? '';
    expect(text).toContain('Alice');
    expect(text).toContain('1200');
    expect(text).toContain('W10');
    expect(text).toContain('L2');
  });

  it('RL13-rows-03 BITES: own row has dataset.own === "true" — kills missing own-row marker impl', () => {
    // RL-13: "own row highlighted". The view marks the own row via dataset.own.
    // Kills: an impl that never sets dataset.own (highlight impossible in CSS).
    const rows = [
      makeRow('aaa', 'Alice', 1200, 10, 2, true),
      makeRow('bbb', 'Bob', 1000, 5, 5, false),
    ];
    const view = new LeaderboardView();
    view.show();
    view.render(makeVm(rows));

    const list = document.getElementById('leaderboard-list')!;
    const items = list.querySelectorAll('li');
    const aliceLi = items[0] as HTMLElement;
    const bobLi = items[1] as HTMLElement;

    // Own row must have dataset.own === 'true'.
    expect(aliceLi.dataset.own).toBe('true');
    // Non-own rows must NOT have dataset.own set (undefined, not 'false').
    // This avoids a CSS :not([data-own]) selector breaking.
    expect(bobLi.dataset.own).toBeUndefined();
  });

  it('RL13-rows-04 BITES: re-render replaces content — kills append-instead-of-replace impl', () => {
    // Kills: an impl that appends to #leaderboard-list on each render() call
    // instead of replacing the content (replaceChildren / innerHTML='').
    const view = new LeaderboardView();
    view.show();

    // First render: 2 rows
    view.render(makeVm([makeRow('aaa', 'Alice', 1200), makeRow('bbb', 'Bob', 1000)]));

    const list = document.getElementById('leaderboard-list')!;
    expect(list.querySelectorAll('li')).toHaveLength(2);

    // Second render: only 1 row
    view.render(makeVm([makeRow('ccc', 'Carol', 800)]));

    // Must have ONLY the second render's rows, not 3 total.
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(1);
    expect((items[0] as HTMLElement).dataset.identity).toBe('ccc');
  });
});

// ---------------------------------------------------------------------------
// XSS tooth: displayName with HTML must render as literal text, never as elements
// ---------------------------------------------------------------------------

describe('RL13-xss: XSS tooth — displayName injected as literal text, never innerHTML', () => {
  beforeEach(() => {
    mountLeaderboardOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('RL13-xss-01 BITES: <script> and <img onerror> in displayName do not inject elements — kills innerHTML-with-data impl', () => {
    // Kills: an impl that uses li.innerHTML = row.displayName (or any template
    // that includes player-controlled data in an HTML string).
    // displayName is player-controlled (comes from profile.name, set at join_game).
    const maliciousName = '<img src=x onerror=alert(1)><script>bad()</script>';
    const view = new LeaderboardView();
    view.show();
    view.render(makeVm([makeRow('aaa', maliciousName, 1337, 0, 0)]));

    const overlay = document.getElementById('leaderboard-overlay')!;

    // No <script> element must be present anywhere in the overlay.
    expect(overlay.querySelector('script')).toBeNull();
    // No <img> element must be present anywhere in the overlay.
    expect(overlay.querySelector('img')).toBeNull();

    // The raw string must be present as literal text (textContent, not innerHTML).
    const list = document.getElementById('leaderboard-list')!;
    const li = list.querySelector('li') as HTMLElement;
    // textContent returns the raw string — it does NOT include the injected element tags.
    // If innerHTML was used, textContent of the li would NOT equal the malicious name
    // because the img/script would be parsed as elements (textContent skips elements).
    // With textContent assignment, the string is literal and textContent reflects it.
    expect(li.textContent).toContain(maliciousName);
  });
});

// ---------------------------------------------------------------------------
// RL-15 structural tooth: leaderboardView.ts must NOT reference module_bindings,
// reducers, or any connection write path (ADR-0014 pure subscription view).
// ---------------------------------------------------------------------------

describe('RL15-structural: leaderboardView.ts source contains no server write paths', () => {
  it('RL15-view-scan BITES: source does not reference module_bindings, reducers, or conn — kills any write-path impl', () => {
    // Uses .includes() — no dynamic RegExp (eslint ReDoS ban).
    // fileURLToPath: robust against percent-encoding in import.meta.url.
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'leaderboardView.ts');
    let src: string;
    try {
      src = readFileSync(viewPath, 'utf8');
    } catch (err) {
      // File must exist post-impl. Throw so the test is RED (not vacuously-green)
      // until the implementer ships leaderboardView.ts (m16.5a vacuous-revival-gate
      // precedent: catch { return; } is a vacuous-pass hole).
      throw new Error(
        'leaderboard source could not be read — post-impl the file must exist: ' + String(err),
      );
    }
    const forbidden = [
      'module_bindings',
      '.reducers',
      'reducers.',
      'conn.conn',
      'DbConnection',
      // set_profile_name is the only profile-write reducer the spec acknowledges.
      // Transitive-import indirection is out of scope for this scan,
      // but a direct reference is a clear RL-15 violation.
      'set_profile_name',
    ];
    for (const needle of forbidden) {
      expect(
        src.includes(needle),
        `leaderboardView.ts must not contain "${needle}" (RL-15: pure subscription view, no write path)`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// RL-13 subscription wiring tooth: connection.ts must subscribe to 'profile'
// ---------------------------------------------------------------------------

describe('RL13-conn-subscription: connection.ts must wire the profile subscription', () => {
  it('RL13-conn-sub-01 BITES: connection.ts contains "SELECT * FROM profile" — kills missing-subscription impl', () => {
    // RL-13: the leaderboard overlay subscribes to `profile`. If connection.ts does
    // not include the subscription line, the store never receives profile rows and
    // the leaderboard is always empty even when profiles exist on the server.
    // Fails loudly (throw) if the file can't be read — no vacuous-pass.
    // Uses .includes() — no dynamic RegExp (eslint ReDoS ban).
    const connPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../net/connection.ts',
    );
    let src: string;
    try {
      src = readFileSync(connPath, 'utf8');
    } catch (err) {
      throw new Error(
        'connection.ts could not be read — the file must exist for the subscription tooth: ' +
          String(err),
      );
    }
    // The exact subscription line that connection.ts must contain.
    expect(
      src.includes("'SELECT * FROM profile'"),
      'connection.ts must contain "\'SELECT * FROM profile\'" — the profile subscription wires the leaderboard store (RL-13)',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Overlay a11y wiring on the show()/hide() edge (ADDITIVE; see the file header)
// ---------------------------------------------------------------------------

const S3_ID: OverlayId = 'leaderboardView';
const S3_META = OVERLAY_A11Y[S3_ID];

/** A focusable OUTSIDE the overlay: the "pre-overlay" element a close must restore focus to. */
function s3OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root — render() only rebuilds
 *  #leaderboard-list, so if this loses focus something RE-OPENED the overlay. */
function s3InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

describe('LeaderboardView — overlay a11y wiring on the show/hide edge (m23-s3)', () => {
  it('S3-leaderboardView-OPEN-ARIA BITES: the first show() from a display:none shell labels the root from OVERLAY_A11Y/t()', () => {
    const { overlay } = mountLeaderboardOverlay();
    const view = new LeaderboardView();

    // VACUITY ATTACK V4, closed here: without `display:none` the FIRST show() is a NO-EDGE and
    // every open assertion below is silently vacuous. This also pins WIK-3 — an impl that reads
    // `this.visible` AFTER writing `style.display` sees a constant `true` and never opens.
    expect(view.visible, 'V4: the shell must start hidden, so the first show() IS an edge').toBe(
      false,
    );

    view.show();

    // Every expectation is DERIVED from the table at assert time — never a literal (V5).
    expect(overlay.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S3_META.role);
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(
      overlay.getAttribute('aria-label'),
      'THE tooth: role/aria-modal are static literals in index.html:52 and pass a view that calls ' +
        'nothing; aria-label is absent from every shell, so only a real open can produce it — and ' +
        'because all 16 catalog values are distinct, this also kills the wrong-OverlayId impl',
    ).toBe(t(S3_META.labelKey));
  });

  it('S3-leaderboardView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y', async () => {
    const { overlay } = mountLeaderboardOverlay();
    const target = overlay.querySelector<HTMLElement>(S3_META.initialFocusSelector);
    expect(target, `the fixture must contain ${S3_META.initialFocusSelector}`).not.toBeNull();
    const view = new LeaderboardView();

    view.show();

    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );
    expect(
      vi.mocked(openOverlayA11y),
      'the deferred focus must be scheduled by openOverlayA11y, not by the view (A11Y-15)',
    ).toHaveBeenCalledTimes(1);

    await flushMacrotask();

    // IDENTITY, never `root.contains(activeElement)` — that passes on any decorative wrapper.
    expect(document.activeElement).toBe(target);
  });

  it('S3-leaderboardView-CLOSE-RESTORE BITES: hide() strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    const { overlay } = mountLeaderboardOverlay();
    const outside = s3OutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new LeaderboardView();
    view.show();
    await flushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).not.toBe(outside);

    view.hide();

    // VACUITY ATTACK V1: the two static literals can only be ABSENT if closeOverlayA11y really ran.
    expect(
      overlay.getAttribute('role'),
      'a display:none node must not keep claiming to be a dialog',
    ).toBeNull();
    expect(overlay.getAttribute('aria-modal')).toBeNull();
    expect(overlay.getAttribute('aria-label')).toBeNull();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-leaderboardView-REPEAT-NO-REOPEN BITES: show() on an ALREADY-visible overlay neither re-opens nor yanks focus back', async () => {
    // A re-open clears and re-schedules the deferred-focus timer.
    // INVISIBLE to every attribute assertion, so it is proven twice: by a call COUNT and by the
    // sentinel still holding focus.
    const { overlay } = mountLeaderboardOverlay();
    const view = new LeaderboardView();

    view.show();
    await flushMacrotask();

    const inside = s3InsideSentinel(overlay);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.show();
    await flushMacrotask();

    expect(document.activeElement, 'a repeat show() must NOT re-run the deferred focus').toBe(
      inside,
    );
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-leaderboardView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE (plan A3): a view that hand-writes the three attributes with the correct
    // copied literal passes every VALUE assertion here while shipping NO trap, NO return-focus
    // record and NO timer. The literal `null` pins ADR-0205 A3 / plan D8. This test also executes
    // BOTH new branches, which matters because this file is in the coverage denominator (R5).
    const { overlay } = mountLeaderboardOverlay();
    const view = new LeaderboardView();

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S3_ID, overlay);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);
  });

  it('S3-leaderboardView-CLOSE-UNGUARDED BITES: hide() calls the close UNCONDITIONALLY — on a never-opened view, and again on every repeat', () => {
    // Plan D2's deliberate asymmetry, and plan ANTI-PATTERN #3. Measured by red-team: wrapping
    // hide()'s close in `if (wasVisible)` ships with every other gate green. A guarded hide() reads
    // `visible === false` and SKIPS the close whenever a record ever desynchronised from the DOM
    // (S1's named A13 leak, ui/overlayA11y.ts:55-59) — making a live capture listener, a pending
    // timer and a stale return target PERMANENT. This view is in BATTLE_FORCE_HIDE,
    // so main.ts's force-hide path drives its close: exactly the
    // desync D2 cites. Unguarded, hide() HEALS it, and a close with no record is a documented pure
    // no-op, so nothing is risked.
    mountLeaderboardOverlay();
    const view = new LeaderboardView();
    expect(view.visible, 'precondition: never opened').toBe(false);

    expect(() => view.hide()).not.toThrow();
    expect(
      vi.mocked(closeOverlayA11y),
      'hide() on a never-opened view MUST still call the close — a guarded hide calls it zero times',
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);

    view.hide();
    expect(
      vi.mocked(closeOverlayA11y),
      'unguarded means unguarded: every hide() calls the close',
    ).toHaveBeenCalledTimes(2);

    // And the same holds after a real open/close cycle: the second hide() still calls it.
    vi.clearAllMocks();
    view.show();
    view.hide();
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// ctl-8s (CTL8S.3): the Social frame's chrome. main.ts builds ONE chrome element and moves it into
// whichever Social panel shows, through that panel's `hostChrome(el)`: `el` becomes the root's
// FIRST child, so a tab strip ctl-8d paints there sits above the board (ctl-8d may not touch this
// file), nothing else on the root changes, and a second call with `el` already first is a no-op.
//
// happy-dom limit (measured on ctl-4): re-inserting a node before itself records no mutation and
// keeps focus here, so an unconditional `prepend(el)` on an `el` already first is invisible at this
// tier. A remove-then-insert is not: it records two mutations.
// ---------------------------------------------------------------------------

describe('LeaderboardView.hostChrome (ctl-8s, CTL8S.3)', () => {
  it('CTL8S-3-HOST-CHROME-BOARD: hostChrome(el) moves el out of wherever it was to be the FIRST child of #leaderboard-overlay; the title and the list, their order and ids, the hidden shell and its dialog state are unchanged; a render keeps it first; a second call with el already first records no mutation and keeps focus inside el', async () => {
    // WRONG IMPL KILLED: an append (el lands under the list); a clone (the node main.ts paints is
    // not the node shown, and the original stays where it was); a host that also shows the board
    // (its `visible` getter reads the root's display, so main.ts would see Rankings open) or opens
    // its dialog; one that replaces the root's children (the title and the list are gone, and the
    // next render throws on a missing list); a host into the list instead of the root (the next
    // render's replaceChildren() would delete the chrome); and a re-host that removes el and
    // inserts it again when it is already first.
    const { overlay, list } = mountLeaderboardOverlay();
    const view = new LeaderboardView();
    const before = [...overlay.children];
    expect(
      before.map((c) => c.id),
      'precondition: the shell children',
    ).toEqual(['leaderboard-title', 'leaderboard-list']);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    const chrome = document.createElement('div');
    const tab = document.createElement('button');
    chrome.appendChild(tab);
    elsewhere.appendChild(chrome);

    view.hostChrome(chrome);

    expect(overlay.firstElementChild, 'el is the first child of the root').toBe(chrome);
    expect(chrome.parentElement, 'moved, not cloned').toBe(overlay);
    expect(elsewhere.childElementCount, 'and no longer where it was').toBe(0);
    expect(overlay.childElementCount, 'one child more, nothing replaced').toBe(before.length + 1);
    for (const [i, child] of before.entries()) {
      expect(overlay.children[i + 1], `#${child.id}: kept, in its order`).toBe(child);
    }
    expect(
      before.map((c) => c.id),
      'their ids are unchanged',
    ).toEqual(['leaderboard-title', 'leaderboard-list']);
    expect(overlay.id).toBe('leaderboard-overlay');
    expect(overlay.style.display, 'the shell stays hidden').toBe('none');
    expect(view.visible, 'the board stays hidden').toBe(false);
    expect(overlay.getAttribute('aria-label'), 'no dialog was opened').toBeNull();

    // The board renders as before, below the chrome.
    view.render(makeVm([makeRow('aaa', 'Alice', 1200)]));
    expect(list.querySelectorAll('li'), 'the list still renders').toHaveLength(1);
    expect(overlay.firstElementChild, 'a render keeps the chrome first').toBe(chrome);

    // On the shown board, a second host of the element already first moves nothing.
    view.show();
    await flushMacrotask();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => {
      records.push(...batch);
    });
    observer.observe(overlay, { childList: true });
    tab.focus();
    expect(document.activeElement, 'precondition: focus is on a tab inside the chrome').toBe(tab);
    view.hostChrome(chrome);
    await flushMacrotask();
    observer.disconnect();
    expect(records.length, 'no node was removed or inserted').toBe(0);
    expect(document.activeElement, 'focus inside the chrome survives').toBe(tab);
    expect(overlay.firstElementChild).toBe(chrome);
    expect(overlay.childElementCount).toBe(before.length + 1);
    expect(view.visible, 'the shown board stays shown').toBe(true);

    teardown();
  });
});

// ==========================================================================================
// ctl-8g (CTL8G.1, CTL8G.2): the Social frame's Players and Rankings tabs, painted over this root.
//
// The Social screen hands `view.rankings.paintSocial(p)` a `SocialRankingsPaint` (tab, the players,
// the cursor row's key, the walk-up player's name or null) on every paint of Players and Rankings.
// The view KEEPS the paint (like the trade root's), re-applies it after every `render(vm)` (main's
// batch listener re-renders the board each batch), and drops it on the hidden -> visible edge, in
// `render()` while hidden and in `hide()`; with no kept paint the root is exactly the legacy board.
//
//   Rankings  `#leaderboard-list` shown, its `<li>`s marked by hand with the nav kit's contract
//             (listbox / option, `mr-nav-item`, `is-active` + `aria-selected` on the cursor row, the
//             first row when the cursor is null or unknown, `aria-activedescendant`), ids
//             `social-rankings-<identityHex>`.
//   Players   `#leaderboard-list` hidden; `#leaderboard-players` holds the rows through the nav kit
//             (ids `social-players-<key>`): a `<bdi>` with the name and, when nearby, a badge with the
//             catalogued "Nearby"; nobody listed: one non-option line.
//   Walk-up   `#leaderboard-walkup`, shown only on Players with a walk-up name: the catalogued line
//             with the name once, in a `<bdi>`, as text (never a resolver argument: I18N-21).
//
// `#leaderboard-players` and `#leaderboard-walkup` are read through getElementById and an absent one
// counts as hidden and empty, so a case does not care whether the view builds them in its
// constructor or on the first paint; where they exist they follow `#leaderboard-list` and never
// become the root's first child.
// ==========================================================================================

const EM = String.fromCharCode(0x2014);

const byId = (id: string): HTMLElement | null => document.getElementById(id);
/** Neither `hidden` nor `display: none`. */
const isShown = (el: HTMLElement | null): boolean =>
  el !== null && !el.hidden && el.style.display !== 'none';
/** Absent, or hidden. */
const isHiddenOrAbsent = (el: HTMLElement | null): boolean => el === null || !isShown(el);
/** Absent, hidden, or empty (the legacy shell shows nothing of it either way). */
const isGone = (el: HTMLElement | null): boolean =>
  el === null || !isShown(el) || (el.textContent ?? '') === '';

const rankingsPaint = (cursor: string | null = null, walkUp: string | null = null) =>
  ({ tab: 'rankings', players: [], cursor, walkUp }) satisfies SocialRankingsPaint;
const playersPaint = (
  players: readonly SocialPlayerRow[],
  cursor: string | null = null,
  walkUp: string | null = null,
) => ({ tab: 'players', players, cursor, walkUp }) satisfies SocialRankingsPaint;

const BOARD = [
  makeRow('aa', 'Alice', 1200, 10, 2, true),
  makeRow('bb', 'Bob', 1000, 5, 5),
  makeRow('cc', 'Carol', 800, 3, 8),
];

/** The legacy board's `<ul>`, built by hand from the pre-ctl-8g contract: `<li data-identity>` per
 *  row (`data-own` on the own row) holding `<bdi>name</bdi>` and the text ` — R (WW/LL)`; the empty
 *  board one `<li>` of text. `style=""` is dropped (a shown element may keep an empty attribute). */
function legacyHtml(rows: ReadonlyArray<ReturnType<typeof makeRow>>): string {
  const ul = document.createElement('ul');
  ul.id = 'leaderboard-list';
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No ranked players yet';
    ul.append(li);
  }
  for (const row of rows) {
    const li = document.createElement('li');
    li.dataset.identity = row.identityHex;
    if (row.isOwn) li.dataset.own = 'true';
    const name = document.createElement('bdi');
    name.textContent = row.displayName;
    li.append(name, ` ${EM} ${row.rating} (W${row.wins}/L${row.losses})`);
    ul.append(li);
  }
  return ul.outerHTML.split(' style=""').join('');
}

/** The root exactly as the legacy shell leaves it for `rows`: the list shown with the legacy
 *  markup, no players list and no walk-up line showing or holding text. */
function expectLegacyShell(label: string, rows: ReadonlyArray<ReturnType<typeof makeRow>>): void {
  const list = byId('leaderboard-list');
  expect(list, `${label}: the list exists`).not.toBeNull();
  expect(isShown(list), `${label}: the list is shown`).toBe(true);
  expect(
    (list as HTMLElement).outerHTML.split(' style=""').join(''),
    `${label}: the list is byte-identical to the legacy board`,
  ).toBe(legacyHtml(rows));
  expect(isGone(byId('leaderboard-players')), `${label}: no players list`).toBe(true);
  expect(isGone(byId('leaderboard-walkup')), `${label}: no walk-up line`).toBe(true);
}

const rowsOf = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('#leaderboard-list > li'),
];

describe('LeaderboardView — the Players list and the walk-up line (ctl-8g, CTL8G.1)', () => {
  it('CTL8G-1-VIEW-PLAYERS: paintSocial with the Players tab hides the board list and shows `#leaderboard-players`, a listbox named by the Players tab, one `social-players-<key>` option per player in order, each a `<bdi>` with the name (as text only, an XSS name stays text) and, only when nearby, a badge reading the catalogued Nearby (absent, not hidden, on the others); the cursor row alone is selected and active and named by aria-activedescendant; nobody listed is one non-option line; the new elements follow the list and are never the root`s first child; no player name reaches the resolver', () => {
    // WRONG IMPL KILLED: the board still showing under the Players list; a players list drawn into
    // `#leaderboard-list` (the board's `<li>`s are the Rankings rows); no listbox / option roles or a
    // second selected row (an AT user cannot tell the cursor); a name set through innerHTML (the
    // XSS name would become an element) or put in the resolver (I18N-21); a name outside a
    // `<bdi>`; a Nearby badge on every row, or on none, or an English literal instead of the
    // catalog's; a badge that is present but hidden on a far player (the AT would still read it); a
    // cursor mark on the wrong row or two rows; an empty list that is blank (nobody knows it is
    // empty) or whose line is an option; and the new elements put before the title (main's
    // dispatch tests pin the first-child chrome) or before the list.
    const { overlay } = mountLeaderboardOverlay();
    const view = new LeaderboardView();
    view.show();
    view.render(makeVm(BOARD));
    const XSS = '<img src=x onerror=alert(1)>';
    const rows: readonly SocialPlayerRow[] = [
      { key: 'bb', name: 'Bob', nearby: true },
      { key: 'cc', name: 'Carol', nearby: false },
      { key: 'dd', name: XSS, nearby: true },
    ];
    vi.clearAllMocks();
    view.paintSocial(playersPaint(rows, 'cc'));

    expect(isShown(byId('leaderboard-list')), 'the board list is hidden on Players').toBe(false);
    const players = byId('leaderboard-players');
    expect(players, 'the players list exists').not.toBeNull();
    const list = players as HTMLElement;
    expect(isShown(list), 'and is shown').toBe(true);
    expect(list.tagName, 'a div').toBe('DIV');
    expect(list.getAttribute('role'), 'a listbox').toBe('listbox');
    expect(list.getAttribute('tabindex'), 'the one tab stop').toBe('0');
    expect(list.getAttribute('aria-labelledby'), 'named by the Players tab').toBe(
      'social-tab-players',
    );
    expect(list.getAttribute('aria-activedescendant'), 'the cursor row').toBe('social-players-cc');

    const options = [...list.children] as HTMLElement[];
    expect(
      options.map((o) => o.id),
      'one option per player, in the order given',
    ).toEqual(['social-players-bb', 'social-players-cc', 'social-players-dd']);
    expect(options.map((o) => o.getAttribute('role'))).toEqual(['option', 'option', 'option']);
    expect(
      options.filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.id),
      'the cursor row alone is selected',
    ).toEqual(['social-players-cc']);
    expect(
      options.filter((o) => o.classList.contains('is-active')).map((o) => o.id),
      'and alone is-active',
    ).toEqual(['social-players-cc']);
    for (const option of options) {
      expect(option.classList.contains('mr-nav-item'), `${option.id}: a nav item`).toBe(true);
    }

    const NEARBY = 'Nearby';
    options.forEach((option, i) => {
      const row = rows[i] as SocialPlayerRow;
      const names = option.querySelectorAll('bdi');
      expect(names.length, `${row.key}: exactly one <bdi>`).toBe(1);
      const bdi = names[0] as HTMLElement;
      expect(bdi.textContent, `${row.key}: the name`).toBe(row.name);
      expect(bdi.children.length, `${row.key}: the name is text only`).toBe(0);
      const badges = [...option.children].filter((c) => c.tagName !== 'BDI');
      if (row.nearby) {
        expect(badges.length, `${row.key}: one badge`).toBe(1);
        expect(badges[0]?.textContent, `${row.key}: the catalogued Nearby`).toBe(NEARBY);
        expect((badges[0] as HTMLElement).hidden, `${row.key}: a shown badge`).toBe(false);
      } else {
        expect(badges.length, `${row.key}: no badge element at all`).toBe(0);
        expect(option.textContent, `${row.key}: no Nearby text`).not.toContain(NEARBY);
      }
    });
    expect(overlay.querySelector('img'), 'an XSS name stays text').toBeNull();
    expect(i18nT, 'the badge comes from the catalog').toHaveBeenCalledWith('social.players.nearby');
    for (const call of [...vi.mocked(i18nT).mock.calls, ...vi.mocked(i18nTf).mock.calls]) {
      expect(JSON.stringify(call).includes('Bob'), 'no name reaches the resolver').toBe(false);
      expect(JSON.stringify(call).includes('Carol'), 'no name reaches the resolver').toBe(false);
      expect(JSON.stringify(call).includes('onerror'), 'no name reaches the resolver').toBe(false);
    }

    // The root's children: the title still first, the board list second, the new elements after.
    expect(overlay.firstElementChild?.id, 'the title is still the first child').toBe(
      'leaderboard-title',
    );
    const ids = [...overlay.children].map((c) => c.id);
    expect(ids.slice(0, 2), 'the title, then the board list').toEqual([
      'leaderboard-title',
      'leaderboard-list',
    ]);
    expect(ids.indexOf('leaderboard-players'), 'the players list follows the list').toBeGreaterThan(
      1,
    );

    // A repaint moves the cursor in place.
    view.paintSocial(playersPaint(rows, 'dd'));
    expect(list.getAttribute('aria-activedescendant')).toBe('social-players-dd');
    expect(
      [...list.children].filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.id),
    ).toEqual(['social-players-dd']);

    // Nobody listed: one line, not an option, nothing named; the board list stays hidden.
    view.paintSocial(playersPaint([], null));
    const NONE = 'No other players online';
    expect(list.textContent, 'the empty line').toBe(NONE);
    expect(list.querySelectorAll('[role="option"]').length, 'not an option').toBe(0);
    expect(list.getAttribute('aria-activedescendant')).toBeNull();
    expect(isShown(list), 'the empty list is still shown').toBe(true);
    expect(isShown(byId('leaderboard-list')), 'and the board list still hidden').toBe(false);
  });

  it('CTL8G-1-VIEW-WALKUP: `#leaderboard-walkup` is shown only on Players with a walk-up name and reads the catalogued line with the name exactly once, in a `<bdi>`, as text (an XSS name, `$&`, `{name}`, a guillemet-quoted name and the words of the line itself included); null on Players, any walk-up on Rankings, and a hidden root show nothing; the name is never a resolver argument', () => {
    // WRONG IMPL KILLED: a walk-up line always visible, or left up after the walk-up ended (null
    // must hide it: a stale "Walk up to Bob" under the next row); one shown on Rankings;
    // the name concatenated into the English text by the view (a literal, not the catalog's); the
    // name passed to `tf()` (I18N-21: a name like `$&` or `{name}` would be reinterpreted, and the
    // name would reach the resolver); a name in the line twice, or twice because the split anchors
    // on the name's first occurrence in the template (a name like `a` or `up`); a name that is
    // not inside a `<bdi>` (its bidi run would leak into the sentence); an innerHTML write (the XSS
    // name becomes an element); and a line placed before the list or the title.
    const { overlay } = mountLeaderboardOverlay();
    const view = new LeaderboardView();
    view.show();
    view.render(makeVm(BOARD));
    const rows: readonly SocialPlayerRow[] = [{ key: 'bb', name: 'Bob', nearby: false }];

    // Nothing to walk up to: hidden (or absent) on Players with null, on Rankings with a (never
    // produced) name.
    view.paintSocial(playersPaint(rows, 'bb', null));
    expect(isHiddenOrAbsent(byId('leaderboard-walkup')), 'Players, no walk-up').toBe(true);
    view.paintSocial(rankingsPaint('aa', 'Bob'));
    expect(isHiddenOrAbsent(byId('leaderboard-walkup')), 'Rankings never shows it').toBe(true);

    // The line itself, for names that would break a naive template or replace.
    const ZED_XSS = 'Zed<img src=x onerror=alert(1)>';
    const NASTY: readonly string[] = [
      'Bob',
      ZED_XSS,
      'a',
      'up',
      'A',
      'and',
      'Walk up to',
      '{name}',
      '$&',
      "$'",
      '$`',
      '$1',
      '«walkUp»',
      'x'.repeat(40),
      `${String.fromCharCode(0xfffc)}${String.fromCharCode(0)}|`,
    ];
    let checked = 0;
    for (const name of NASTY) {
      view.paintSocial(playersPaint(rows, 'bb', name));
      const line = byId('leaderboard-walkup');
      expect(isShown(line), `${JSON.stringify(name)}: shown`).toBe(true);
      const el = line as HTMLElement;
      expect(el.textContent, `${JSON.stringify(name)}: the catalogued line`).toBe(
        `Walk up to ${name} and press A`,
      );
      const names = el.querySelectorAll('bdi');
      expect(names.length, `${JSON.stringify(name)}: exactly one <bdi>`).toBe(1);
      expect(names[0]?.textContent, `${JSON.stringify(name)}: it holds the name`).toBe(name);
      expect(names[0]?.children.length, `${JSON.stringify(name)}: as text only`).toBe(0);
      expect(el.children.length, `${JSON.stringify(name)}: nothing else inside`).toBe(1);
      const outside = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent ?? '')
        .join('');
      expect(outside, `${JSON.stringify(name)}: the rest of the line, once`).toBe(
        'Walk up to  and press A',
      );
      checked += 1;
    }
    expect(overlay.querySelector('img'), 'an XSS name stays text').toBeNull();
    expect(checked, 'ANTI-VACUITY: every name checked').toBe(NASTY.length);

    // I18N-21: the catalogued line is resolved with `tf`, and the name is not among its arguments.
    vi.clearAllMocks();
    view.paintSocial(playersPaint(rows, 'bb', ZED_XSS));
    const tfCalls = vi.mocked(i18nTf).mock.calls;
    expect(
      tfCalls.some((c) => c[0] === 'social.players.walkUp'),
      'the line comes from social.players.walkUp',
    ).toBe(true);
    for (const call of [...vi.mocked(i18nT).mock.calls, ...tfCalls]) {
      expect(JSON.stringify(call).includes('Zed'), 'the name never reaches t() / tf()').toBe(false);
      expect(JSON.stringify(call).includes('onerror'), 'nor any part of it').toBe(false);
    }

    // The walk-up ended: hidden again.
    view.paintSocial(playersPaint(rows, 'bb', null));
    expect(isHiddenOrAbsent(byId('leaderboard-walkup')), 'the line goes with the walk-up').toBe(
      true,
    );

    // The line follows the players list, never the root's first child.
    view.paintSocial(playersPaint(rows, 'bb', 'Bob'));
    expect(overlay.firstElementChild?.id, 'the title stays first').toBe('leaderboard-title');
    expect([...overlay.children].map((c) => c.id)).toEqual([
      'leaderboard-title',
      'leaderboard-list',
      'leaderboard-players',
      'leaderboard-walkup',
    ]);

    // A hidden root shows no line: hide() drops the paint.
    view.hide();
    expect(isGone(byId('leaderboard-walkup')), 'a hidden root holds no walk-up line').toBe(true);
  });
});

describe('LeaderboardView — the Rankings list and the kept paint (ctl-8g, CTL8G.2)', () => {
  it('CTL8G-2-VIEW-RANKINGS: paintSocial with the Rankings tab keeps the board list shown and hides the players list and the walk-up line; the list is a listbox named by the Rankings tab with aria-activedescendant on the cursor row; each ranked `<li>` is `social-rankings-<identityHex>`, a mr-nav-item option whose text, `<bdi>`, data-identity and data-own are the legacy row`s, with exactly one aria-selected true and one is-active (the cursor row, the first row when the cursor is null or unknown); the empty board`s line is no option; and Players to Rankings to Players flips the two lists each time', () => {
    // WRONG IMPL KILLED: the board hidden on Rankings, or the players list left showing over it; a
    // list without its listbox role, tab stop or label (the cursor is invisible to AT); li ids that
    // are not `social-rankings-<hex>` (aria-activedescendant dangles); roles on the wrong
    // nodes; two selected rows, or none (a null cursor must still name the first row); a
    // cursor mark on the wrong row; an `aria-selected` written only on the cursor row (the kit
    // writes 'false' on the rest, but 'true' on two is the bug); the legacy row content lost to
    // the marks (name, numbers, `<bdi>`, data-identity, data-own); an empty board whose line is an
    // option or whose list names a row that is not there; and a Players -> Rankings -> Players walk
    // that leaves the wrong list shown, or the Rankings marks gone after the walk back.
    mountLeaderboardOverlay();
    const view = new LeaderboardView();
    view.show();
    view.render(makeVm(BOARD));
    view.paintSocial(rankingsPaint('bb'));

    const list = byId('leaderboard-list') as HTMLElement;
    expect(isShown(list), 'the board is shown').toBe(true);
    expect(isShown(byId('leaderboard-players')), 'the players list is hidden').toBe(false);
    expect(isShown(byId('leaderboard-walkup')), 'and the walk-up line').toBe(false);
    expect(list.getAttribute('role'), 'a listbox').toBe('listbox');
    expect(list.getAttribute('tabindex'), 'the one tab stop').toBe('0');
    expect(list.getAttribute('aria-labelledby'), 'named by the Rankings tab').toBe(
      'social-tab-rankings',
    );
    expect(list.getAttribute('aria-activedescendant'), 'the cursor row').toBe('social-rankings-bb');

    const items = rowsOf();
    expect(
      items.map((li) => li.id),
      'ids by identity, in board order',
    ).toEqual(['social-rankings-aa', 'social-rankings-bb', 'social-rankings-cc']);
    expect(items.map((li) => li.getAttribute('role'))).toEqual(['option', 'option', 'option']);
    for (const li of items) {
      expect(li.classList.contains('mr-nav-item'), `${li.id}: a nav item`).toBe(true);
    }
    expect(
      items.filter((li) => li.getAttribute('aria-selected') === 'true').map((li) => li.id),
      'exactly one selected row: the cursor',
    ).toEqual(['social-rankings-bb']);
    expect(
      items.filter((li) => li.classList.contains('is-active')).map((li) => li.id),
      'exactly one is-active row',
    ).toEqual(['social-rankings-bb']);
    // The legacy row content survives the marks.
    expect(
      items.map((li) => li.textContent),
      'the legacy text of every row',
    ).toEqual([`Alice ${EM} 1200 (W10/L2)`, `Bob ${EM} 1000 (W5/L5)`, `Carol ${EM} 800 (W3/L8)`]);
    expect(items.map((li) => li.querySelector('bdi')?.textContent)).toEqual([
      'Alice',
      'Bob',
      'Carol',
    ]);
    expect(items.map((li) => li.dataset.identity)).toEqual(['aa', 'bb', 'cc']);
    expect(items.map((li) => li.dataset.own)).toEqual(['true', undefined, undefined]);

    // The cursor moves in place; null and an unknown key both fall back to the first row.
    const selectedAfter = (cursor: string | null): string[] => {
      view.paintSocial(rankingsPaint(cursor));
      return rowsOf()
        .filter((li) => li.getAttribute('aria-selected') === 'true')
        .map((li) => li.id);
    };
    expect(selectedAfter('cc'), 'cursor cc').toEqual(['social-rankings-cc']);
    expect(list.getAttribute('aria-activedescendant')).toBe('social-rankings-cc');
    expect(selectedAfter(null), 'a null cursor: the first row').toEqual(['social-rankings-aa']);
    expect(list.getAttribute('aria-activedescendant')).toBe('social-rankings-aa');
    expect(selectedAfter('nobody'), 'an unknown cursor: the first row').toEqual([
      'social-rankings-aa',
    ]);
    expect(
      rowsOf()
        .filter((li) => li.classList.contains('is-active'))
        .map((li) => li.id),
      'and is-active follows it',
    ).toEqual(['social-rankings-aa']);

    // The empty board: its line is not an option and nothing is named.
    view.render(makeVm([]));
    const lines = rowsOf();
    expect(lines.length, 'one line').toBe(1);
    expect(lines[0]?.textContent).toBe('No ranked players yet');
    expect(lines[0]?.getAttribute('role'), 'the empty line is not an option').not.toBe('option');
    expect(lines[0]?.getAttribute('aria-selected'), 'and not selected').not.toBe('true');
    expect(list.getAttribute('aria-activedescendant'), 'nothing is named').toBeNull();
    expect(isShown(list), 'the empty board is shown').toBe(true);

    // Players, then Rankings, then Players again: each flips the two lists.
    view.render(makeVm(BOARD));
    const rows: readonly SocialPlayerRow[] = [{ key: 'bb', name: 'Bob', nearby: true }];
    view.paintSocial(playersPaint(rows, 'bb'));
    expect(isShown(list), 'Players: the board list hidden').toBe(false);
    expect(isShown(byId('leaderboard-players')), 'Players: the players list shown').toBe(true);
    view.paintSocial(rankingsPaint('bb'));
    expect(isShown(list), 'Rankings: the board list shown').toBe(true);
    expect(isShown(byId('leaderboard-players')), 'Rankings: the players list hidden').toBe(false);
    expect(
      rowsOf()
        .filter((li) => li.getAttribute('aria-selected') === 'true')
        .map((li) => li.id),
      'Rankings again: the marks are back on the cursor row',
    ).toEqual(['social-rankings-bb']);
    expect(list.getAttribute('aria-activedescendant')).toBe('social-rankings-bb');
    view.paintSocial(playersPaint(rows, 'bb'));
    expect(isShown(list), 'Players again: the board list hidden').toBe(false);
    expect(isShown(byId('leaderboard-players')), 'Players again: the players list shown').toBe(
      true,
    );
  });

  it('CTL8G-2-VIEW-LIFECYCLE: with no paint the board is byte-identical to the legacy markup (rows and the empty board); a kept paint is re-applied after every render(vm), the empty-board render included, on both tabs; show() on an already shown root keeps it; hide() leaves exactly the legacy shell; a paint made while hidden, or left over a hidden render, never decorates the next open; and a new paint works after the walk', () => {
    // WRONG IMPL KILLED: marks that are written by the constructor or by render() itself with no
    // paint (the legacy board changes under every other root's tests); a paint lost at the next
    // batch (main re-renders the board every batch: the Rankings cursor mark would vanish after
    // one store batch, and a Players list would reappear as the board); an empty-board render that
    // forgets the paint (the board comes back over the Players list); a re-render that applies a
    // stale cursor; a show() that drops the paint on every call (main calls show on an open root at
    // every paint); a hide() that leaves the roles, ids, is-active marks or the hidden list behind
    // (the board's next legacy open would be a decorated listbox, or hidden); a paint that
    // survives a hidden render or a re-open (stale marks over a fresh Social visit); and a view
    // that can no longer be painted after hide().
    mountLeaderboardOverlay();
    const view = new LeaderboardView();

    // No paint: the legacy board, byte for byte, shown or hidden.
    view.render(makeVm(BOARD));
    expectLegacyShell('hidden, rows', BOARD);
    view.show();
    view.render(makeVm(BOARD));
    expectLegacyShell('shown, rows', BOARD);
    view.render(makeVm([]));
    expectLegacyShell('shown, empty board', []);

    // A Rankings paint survives a re-render with other rows and the empty board.
    view.render(makeVm(BOARD));
    view.paintSocial(rankingsPaint('cc'));
    const markedIds = (): string[] =>
      rowsOf()
        .filter((li) => li.getAttribute('aria-selected') === 'true')
        .map((li) => li.id);
    expect(markedIds(), 'fixture: painted').toEqual(['social-rankings-cc']);
    view.render(makeVm(BOARD));
    expect(markedIds(), 'a re-render with the same rows keeps the paint').toEqual([
      'social-rankings-cc',
    ]);
    view.render(makeVm([BOARD[2] as (typeof BOARD)[number], BOARD[0] as (typeof BOARD)[number]]));
    expect(
      rowsOf().map((li) => li.id),
      'the new rows are marked too',
    ).toEqual(['social-rankings-cc', 'social-rankings-aa']);
    expect(markedIds(), 'the cursor row, in its new place').toEqual(['social-rankings-cc']);
    view.render(makeVm([BOARD[0] as (typeof BOARD)[number]]));
    expect(markedIds(), 'the cursor row gone: the first row').toEqual(['social-rankings-aa']);
    view.render(makeVm([]));
    const emptyLine = rowsOf()[0] as HTMLElement;
    expect(emptyLine.getAttribute('role'), 'the empty line is not an option').not.toBe('option');
    expect(
      (byId('leaderboard-list') as HTMLElement).getAttribute('aria-activedescendant'),
      'and names no row',
    ).toBeNull();
    expect(isShown(byId('leaderboard-players')), 'the players list stays hidden').toBe(false);

    // A Players paint survives a render too, the empty board included: the board stays hidden.
    const rows: readonly SocialPlayerRow[] = [
      { key: 'bb', name: 'Bob', nearby: true },
      { key: 'cc', name: 'Carol', nearby: false },
    ];
    view.paintSocial(playersPaint(rows, 'cc', 'Carol'));
    for (const vm of [makeVm(BOARD), makeVm([])]) {
      view.render(vm);
      expect(isShown(byId('leaderboard-list')), 'a render: the board stays hidden').toBe(false);
      expect(isShown(byId('leaderboard-players')), 'a render: the players list stays').toBe(true);
      expect(
        [...(byId('leaderboard-players') as HTMLElement).children].map((o) => o.id),
        'the rows stay',
      ).toEqual(['social-players-bb', 'social-players-cc']);
      expect(byId('leaderboard-walkup')?.textContent, 'the walk-up line stays').toBe(
        'Walk up to Carol and press A',
      );
    }

    // show() on a root that is already shown is not the hidden -> visible edge.
    view.show();
    expect(isShown(byId('leaderboard-players')), 'a repeat show keeps the Players paint').toBe(
      true,
    );
    expect(byId('leaderboard-walkup')?.textContent, 'and the walk-up line').toBe(
      'Walk up to Carol and press A',
    );
    view.paintSocial(rankingsPaint('bb'));
    view.render(makeVm(BOARD));
    view.show();
    expect(markedIds(), 'a repeat show keeps the Rankings paint').toEqual(['social-rankings-bb']);

    // hide(): exactly the legacy shell.
    view.hide();
    expectLegacyShell('after hide, rankings paint', BOARD);
    view.show();
    view.render(makeVm(BOARD));
    expectLegacyShell('reopened, no new paint', BOARD);
    view.paintSocial(playersPaint(rows, 'bb', 'Bob'));
    view.hide();
    expectLegacyShell('after hide, players paint and walk-up', BOARD);
    view.show();
    view.render(makeVm([]));
    expectLegacyShell('reopened over the empty board', []);

    // A paint made while hidden, or left over a hidden render: dropped at the next open.
    view.hide();
    view.paintSocial(rankingsPaint('bb'));
    view.show();
    view.render(makeVm(BOARD));
    expectLegacyShell('painted while hidden, then opened', BOARD);
    view.hide();
    view.paintSocial(playersPaint(rows, 'cc', 'Carol'));
    view.render(makeVm(BOARD));
    view.show();
    view.render(makeVm(BOARD));
    expectLegacyShell('painted and rendered while hidden, then opened', BOARD);

    // After the walk a new paint works (the view is not stuck legacy).
    view.paintSocial(rankingsPaint('cc'));
    expect(markedIds(), 'a paint after the walk').toEqual(['social-rankings-cc']);
    view.paintSocial(playersPaint(rows, 'cc', 'Carol'));
    expect(isShown(byId('leaderboard-players')), 'and the Players list').toBe(true);
    expect(byId('leaderboard-walkup')?.textContent).toBe('Walk up to Carol and press A');
  });
});
