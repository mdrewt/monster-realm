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

    // An UNKNOWN cursor key (not null) names the first row, exactly as Rankings does: one
    // aria-selected true, aria-activedescendant on that row's option id, one is-active row.
    // WRONG IMPL KILLED: a Players list whose unknown cursor selects nothing (the kit marks no row:
    // aria-activedescendant dangles or is absent while the list has options, so the AT user hears
    // no cursor) or two rows; a fallback written only for the null cursor.
    for (const cursor of ['nobody', 'zz'.repeat(32), null] as const) {
      view.paintSocial(playersPaint(rows, cursor));
      const shown = [...list.children] as HTMLElement[];
      expect(
        shown.map((o) => o.id),
        `cursor ${String(cursor)}: the rows`,
      ).toEqual(['social-players-bb', 'social-players-cc', 'social-players-dd']);
      expect(
        list.getAttribute('aria-activedescendant'),
        `cursor ${String(cursor)}: the first option names the list`,
      ).toBe(shown[0]?.id);
      expect(
        shown.filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.id),
        `cursor ${String(cursor)}: exactly one selected row, the first`,
      ).toEqual(['social-players-bb']);
      expect(
        shown.filter((o) => o.classList.contains('is-active')).map((o) => o.id),
        `cursor ${String(cursor)}: and one is-active row`,
      ).toEqual(['social-players-bb']);
    }
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
  it('CTL8G-2-VIEW-RANKINGS: paintSocial with the Rankings tab keeps the board list shown and hides the players list and the walk-up line; the list is a listbox named by the Rankings tab with aria-activedescendant on the cursor row; each ranked `<li>` is `social-rankings-<identityHex>`, a mr-nav-item option whose text, `<bdi>`, data-identity and data-own are the legacy row`s, with exactly one aria-selected true and one is-active (the cursor row, the first row when the cursor is null or unknown); the empty board`s line is no option; and Players to Rankings to Players flips the two lists each time; a paint that hides the list holding focus hands focus to `#leaderboard-title` (never body), one that hides nothing leaves it', async () => {
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
    // An empty listbox with no options fails axe's aria-required-children, so over the EMPTY board
    // the `<ul>` carries no listbox role, no tab stop and no label (the Players empty branch strips
    // them too): whether the empty board is rendered under a kept paint or painted after the render.
    // WRONG IMPL KILLED: the Rankings marks written to the list whatever the board holds (a listbox
    // whose only child is not an option).
    const expectBareList = (label: string): void => {
      expect(list.getAttribute('role'), `${label}: no listbox role`).toBeNull();
      expect(list.getAttribute('tabindex'), `${label}: no tab stop`).toBeNull();
      expect(list.getAttribute('aria-labelledby'), `${label}: no label`).toBeNull();
      expect(list.getAttribute('aria-activedescendant'), `${label}: nothing named`).toBeNull();
      expect(list.querySelectorAll('[role="option"]').length, `${label}: no option`).toBe(0);
    };
    expectBareList('a paint kept over the empty render');
    view.paintSocial(rankingsPaint('bb'));
    expectBareList('a Rankings paint over the empty board');
    view.paintSocial(rankingsPaint(null));
    expectBareList('a null cursor over the empty board');
    // Rows arriving put the marks back (the bare list is not stuck bare), and the board emptying
    // again strips them again.
    view.render(makeVm(BOARD));
    expect(list.getAttribute('role'), 'rows back: a listbox again').toBe('listbox');
    expect(list.getAttribute('tabindex'), 'rows back: the tab stop').toBe('0');
    expect(list.getAttribute('aria-labelledby'), 'rows back: the label').toBe(
      'social-tab-rankings',
    );
    view.render(makeVm([]));
    expectBareList('emptied again');

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

    // FOCUS HANDOFF (tradeView's rule: a part hidden under the focus would strand it on <body>, so
    // hand it to the hosting panel's anchor first). The title is the overlay's tabindex=-1 anchor.
    // WRONG IMPL KILLED: a tab flip that hides the focused list and leaves focus on the hidden node
    // or on <body> (the keyboard user's next key goes nowhere); a handoff to the wrong anchor (the
    // overlay root, the other list); a handoff on EVERY paint (the focused list loses focus to the
    // title on each cursor move: Rankings -> Rankings, Players -> Players).
    await flushMacrotask(); // the open's deferred focus lands first: it is not under test
    const title = byId('leaderboard-title') as HTMLElement;
    expect(title.getAttribute('tabindex'), 'fixture: the title is the tabindex=-1 anchor').toBe(
      '-1',
    );
    const playersList = byId('leaderboard-players') as HTMLElement;

    // Rankings -> Players: the board list holds focus and is hidden.
    view.paintSocial(rankingsPaint('bb'));
    list.focus();
    expect(document.activeElement, 'precondition: focus is on the board list').toBe(list);
    view.paintSocial(playersPaint(rows, 'bb'));
    expect(isShown(list), 'the board list is hidden now').toBe(false);
    expect(document.activeElement, 'Rankings -> Players: focus goes to the title').toBe(title);
    expect(document.activeElement, 'never body').not.toBe(document.body);

    // Players -> Rankings: the players list holds focus and is hidden.
    playersList.focus();
    expect(document.activeElement, 'precondition: focus is on the players list').toBe(playersList);
    view.paintSocial(rankingsPaint('bb'));
    expect(isShown(playersList), 'the players list is hidden now').toBe(false);
    expect(document.activeElement, 'Players -> Rankings: focus goes to the title').toBe(title);
    expect(document.activeElement, 'never body').not.toBe(document.body);

    // A paint that hides nothing under the focus leaves it where it is.
    list.focus();
    view.paintSocial(rankingsPaint('cc'));
    expect(document.activeElement, 'Rankings -> Rankings: focus stays on the list').toBe(list);
    view.paintSocial(playersPaint(rows, 'bb'));
    playersList.focus();
    view.paintSocial(playersPaint(rows, null));
    expect(document.activeElement, 'Players -> Players: focus stays on the list').toBe(playersList);
    // Focus on the title (not in the hidden part) stays there across a flip.
    title.focus();
    view.paintSocial(rankingsPaint('bb'));
    expect(document.activeElement, 'focus outside the hidden part is not moved').toBe(title);
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
    // A hidden root never carries marks: a paint made while it is HIDDEN is not kept, so with no
    // show() in between the root is still exactly the legacy shell (rows, so a mark would show).
    // WRONG IMPL KILLED: a paintSocial that keeps and applies its paint whatever the root's
    // visibility (a hidden board carrying listbox roles, ids and is-active marks, or a hidden
    // list on Players, until the next open drops them).
    view.render(makeVm(BOARD));
    view.paintSocial(rankingsPaint('bb'));
    expectLegacyShell('a Rankings paint while hidden, not yet shown', BOARD);
    view.paintSocial(playersPaint(rows, 'cc', 'Carol'));
    expectLegacyShell('a Players paint and walk-up while hidden, not yet shown', BOARD);
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

// ==========================================================================================
// qf-16 (QF16.1, QF16.2): the Rankings list is display-only and scrolls with its cursor.
//
// EARS. QF16.1: the ranking rows render as display-only: a read-only selected-row treatment
// visually distinct from the actionable nav rows' active style, implying no A-press affordance.
// QF16.2: when the ranking list overflows it shows a visible scroll affordance, and D-pad Up/Down
// still scroll it (the cursor-as-scroll mechanism stays).
//
// CONTRACT. A populated Rankings paint also writes `aria-readonly="true"` on `#leaderboard-list`
// (a LIST mark: removed whenever that paint is not applied; row classes are UNCHANGED). A cursor
// row whose id differs from the one last scrolled to is scrolled into view, once
// (`scrollIntoView({ block: 'nearest' })`); a re-render with the same cursor never re-scrolls.
// styles.css undoes the actionable treatment on the read-only cursor row, and makes the list its
// own scroll container with overflow-only scroll shadows.
//
// SELECTORS ARE NOT PINNED. styles.css bans every `#id` selector (its header, [A11Y-07]), so the
// stylesheet cannot say `#leaderboard-list[...]`. These tests therefore read what the sheet DOES to
// the real elements: getComputedStyle for the properties happy-dom computes, and a small cascade
// (executable `el.matches` + specificity + source order) for the two things it cannot compute:
// the `::before` content and a multi-layer `background-attachment`.
//
// RED REASONS (against the code before this slice):
//   QF16-1-READONLY-MARK     the list never gets aria-readonly.
//   QF16-1-COMPUTED-DISTINCT the Rankings cursor row computes exactly the actionable row's
//                            inverted fill, text colour, outline and ▶ (no read-only treatment).
//   QF16-2-SCROLL-ON-STEP    nothing scrolls the cursor row (scrollIntoView is never called).
//   QF16-2-OVERFLOW-AFFORDANCE  the list computes overflow-y visible, min-height auto and has no
//                            background layers at all.
//
// WRONG IMPLS KILLED: the row class swapped or dropped (READONLY-MARK pins the exact classes, the
// boot pin keeps is-active); the mark on the rows instead of the list; the mark left behind by
// hide, a Players paint, an empty board, a hidden render or the re-open edge; the mark on the
// legacy board; a CSS rule keyed on a selector that never matches the row; a rule that changes only
// the outline and keeps the inverted fill; the ▶ left on; scroll on every render (the board is
// re-rendered each store batch, so it would yank); scroll keyed on the row node instead of its id;
// scroll that is not reset after a hide or a Players tab; an unguarded scrollIntoView call (a
// detached list, or no such method); overflow set on the parent only; no min-height (a flex item
// never shrinks below its content, so never scrolls); an always-on shadow (no `local` layer).
//
// ROUND 2 (red-team survivors; the cascade scan now skips every rule inside an at-rule):
//   A  cue bar drawn in the frame bg token / transparent, or an inset shadow with no offset or
//      spread or a transparent colour                -> COMPUTED-DISTINCT (bar colour + shadow parse)
//   E  a near-identical inverted fill / text colour (#e0e0e1 on #1e1e2f) -> COMPUTED-DISTINCT (the
//      cursor fill must be clear, its text colour unset / inherit / the fg token)
//   F  the `content: none` (or any read-only) rule wrapped in @media print / @supports / a
//      never-matching media query                   -> COMPUTED-DISTINCT (nested rules do not apply)
//   H  the hover underline of `.mr-pointer-hover .mr-nav-item:hover` still reaching a Rankings row
//      (NEW behaviour, RED before round 2)           -> COMPUTED-DISTINCT (hover cascade)
//   N  a rule that fills every ranking row with the frame bg (hides the shadows) -> OVERFLOW
//   K  `display: contents` / none / inline on the list (no scroll box in a browser) -> OVERFLOW
//   B  shadow layers that are all transparent, or covers that are not the frame bg -> OVERFLOW
//   C/D covers of height 0 (shadows always on) or 100% (bottom shadow hidden at the top), or a
//      shadow taller than its cover                  -> OVERFLOW (layer size parse)
//   R  a re-sort that moves the cursor row to another index leaving it off-screen (NEW behaviour,
//      RED before round 2): scroll when the cursor row's id OR its index changes, never for the
//      same id at the same index                      -> SCROLL-ON-STEP
// ==========================================================================================

const QF16_STYLES_CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
  'utf8',
);
const QF16_ARROW = String.fromCodePoint(0x25b6);

interface Qf16Decl {
  readonly prop: string;
  readonly value: string;
  readonly important: boolean;
}
interface Qf16Rule {
  readonly selector: string;
  readonly specificity: readonly [number, number, number];
  readonly order: number;
  readonly decls: readonly Qf16Decl[];
  /** Inside an at-rule (@media, @supports, @layer, @container, @keyframes...): such a rule is not
   *  assumed to apply on screen, so the cascade below ignores it. A rule that must apply is
   *  top-level. */
  readonly nested: boolean;
}

function qf16Decls(body: string): Qf16Decl[] {
  const out: Qf16Decl[] = [];
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const raw = part.slice(colon + 1).trim();
    out.push({
      prop: part.slice(0, colon).trim().toLowerCase(),
      value: raw
        .replace(/!\s*important\s*$/i, '')
        .trim()
        .toLowerCase(),
      important: /!\s*important\s*$/i.test(raw),
    });
  }
  return out;
}

/** (ids, classes + attributes + pseudo-classes, types + pseudo-elements) of one simple selector. */
function qf16Specificity(selector: string): readonly [number, number, number] {
  let s = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, ' ');
  s = s.replace(/"[^"]*"|'[^']*'/g, '""');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  s = s.replace(/#[\w-]+/g, ' ');
  const pseudoElements = (s.match(/::[\w-]+/g) ?? []).length;
  s = s.replace(/::[\w-]+/g, ' ');
  const attrs = (s.match(/\[[^\]]*\]/g) ?? []).length;
  s = s.replace(/\[[^\]]*\]/g, ' ');
  const classes = (s.match(/\.[\w-]+/g) ?? []).length;
  s = s.replace(/\.[\w-]+/g, ' ');
  const pseudoClasses = (s.match(/:[\w-]+(?:\([^()]*\))?/g) ?? []).length;
  s = s.replace(/:[\w-]+(?:\([^()]*\))?/g, ' ');
  const types = (s.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes + attrs + pseudoClasses, types + pseudoElements];
}

/** Every innermost `selector { declarations }` block of the sheet, one entry per selector of a
 *  comma list, comments stripped, in source order, each marked with whether an at-rule encloses it. */
function qf16Rules(css: string): Qf16Rule[] {
  const rules: Qf16Rule[] = [];
  const stack: Array<{ head: string; leaf: boolean }> = [];
  let order = 0;
  let buf = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      const top = stack[stack.length - 1];
      if (top !== undefined) top.leaf = false;
      stack.push({ head: (buf.split(';').pop() ?? '').trim(), leaf: true });
      buf = '';
    } else if (ch === '}') {
      const block = stack.pop();
      if (block?.leaf === true) {
        const nested = stack.length > 0 || block.head.startsWith('@');
        const decls = qf16Decls(buf);
        for (const raw of block.head.split(',')) {
          const selector = raw.trim();
          if (selector === '' || selector.startsWith('@')) continue;
          rules.push({ selector, specificity: qf16Specificity(selector), order, decls, nested });
          order += 1;
        }
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return rules;
}

const QF16_RULES = qf16Rules(QF16_STYLES_CSS);

function qf16Matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function qf16Outranks(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Every declaration of one of `props` that applies to `el` (or its `::before`), lowest priority
 *  first: !important, then specificity, then source order, then position in the block. At-rule
 *  rules are skipped (see `nested`). `hover` evaluates the selectors as if the pointer were over
 *  `el` (`:hover` always matches); specificity still counts it. Inline style and the UA sheet are
 *  not modelled. */
function qf16Cascade(
  el: Element,
  props: readonly string[],
  pseudo: '' | '::before',
  hover = false,
): Qf16Decl[] {
  const hits: Array<{ decl: Qf16Decl; rank: readonly number[] }> = [];
  for (const rule of QF16_RULES) {
    if (rule.nested) continue;
    let base = hover ? rule.selector.replace(/:hover/g, '') : rule.selector;
    if (pseudo === '::before') {
      if (!base.endsWith('::before')) continue;
      base = base.slice(0, -'::before'.length) || '*';
    } else if (base.includes('::')) {
      continue;
    }
    if (!qf16Matches(el, base)) continue;
    rule.decls.forEach((decl, j) => {
      if (!props.includes(decl.prop)) return;
      hits.push({ decl, rank: [decl.important ? 1 : 0, ...rule.specificity, rule.order, j] });
    });
  }
  hits.sort((a, b) => (qf16Outranks(a.rank, b.rank) ? 1 : qf16Outranks(b.rank, a.rank) ? -1 : 0));
  return hits.map((h) => h.decl);
}

/** The declaration of one of `props` that wins the cascade for `el` (see `qf16Cascade`). */
function qf16Winner(
  el: Element,
  props: readonly string[],
  pseudo: '' | '::before',
  hover = false,
): Qf16Decl | undefined {
  return qf16Cascade(el, props, pseudo, hover).pop();
}

/** Split `text` at top-level occurrences of `sep` (not inside parentheses). */
function qf16SplitTop(text: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Top-level whitespace-separated tokens; a top-level `/` is a token of its own. */
function qf16Tokens(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  const flush = (): void => {
    if (current !== '') out.push(current);
    current = '';
  };
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && /\s/.test(ch)) flush();
    else if (depth === 0 && ch === '/') {
      flush();
      out.push('/');
    } else current += ch;
  }
  flush();
  return out;
}

/** The first token of a shorthand that is not one of `skip`, an image, or a number/length. */
function qf16FirstColour(shorthand: string, skip: ReadonlySet<string>): string | undefined {
  return qf16Tokens(shorthand).find(
    (t) => t !== '/' && !skip.has(t) && !/-gradient\(|^url\(/.test(t) && !/^[+-]?[\d.]/.test(t),
  );
}

const QF16_BG_WORDS: ReadonlySet<string> = new Set([
  'none',
  'repeat',
  'no-repeat',
  'repeat-x',
  'repeat-y',
  'space',
  'round',
  'scroll',
  'local',
  'fixed',
  'top',
  'bottom',
  'left',
  'right',
  'center',
  'auto',
  'cover',
  'contain',
  'border-box',
  'padding-box',
  'content-box',
]);
const QF16_BORDER_WORDS: ReadonlySet<string> = new Set([
  'none',
  'hidden',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
  'thin',
  'medium',
  'thick',
]);

/** The background COLOUR `el` ends up with, by the cascade (`transparent` when none is set). */
function qf16FillOf(el: Element): string {
  let fill = 'transparent';
  for (const d of qf16Cascade(el, ['background', 'background-color'], '')) {
    if (d.prop === 'background') {
      const last = qf16SplitTop(d.value).pop() ?? '';
      fill = qf16FirstColour(last, QF16_BG_WORDS) ?? 'transparent';
    } else {
      fill = d.value;
    }
  }
  return fill;
}

/** Paints nothing: transparent / none / unset, or a zero-alpha rgb. */
function qf16IsClear(fill: string): boolean {
  return (
    ['', 'transparent', 'none', 'initial', 'unset'].includes(fill) ||
    /^rgba?\(\s*0[\s,]+0[\s,]+0\s*[,/]\s*0(?:\.0+)?%?\s*\)$/.test(fill)
  );
}

/** The `color` the cascade gives `el`, or undefined when nothing sets it (it inherits). */
const qf16TextColourOf = (el: Element): string | undefined => qf16Winner(el, ['color'], '')?.value;

/** The colour of `el`'s left bar by the cascade: the `border` / `border-left` shorthand's colour
 *  token, then any `border-left-color` / `border-color`, in cascade order. */
function qf16BarColourOf(el: Element): string {
  let colour = 'currentcolor';
  for (const d of qf16Cascade(
    el,
    ['border', 'border-left', 'border-left-color', 'border-color'],
    '',
  )) {
    if (d.prop === 'border' || d.prop === 'border-left') {
      colour = qf16FirstColour(d.value, QF16_BORDER_WORDS) ?? 'currentcolor';
    } else if (d.prop === 'border-left-color') {
      colour = d.value;
    } else {
      const sides = qf16Tokens(d.value);
      colour = sides[3] ?? sides[1] ?? sides[0] ?? colour;
    }
  }
  return colour;
}

/** Colours a selected-row bar may be drawn in: the frame's foreground / border tokens (equal
 *  values) or the text colour. Never the frame background, transparent, or a literal. */
const QF16_BAR_COLOURS: readonly string[] = [
  'var(--mr-frame-fg)',
  'var(--mr-frame-border)',
  'currentcolor',
];

/** An inset box-shadow bar the cascade gives `el`: a visible offset or spread, and a colour from
 *  the allowed set. */
function qf16ShadowBarOn(el: Element): boolean {
  const win = qf16Winner(el, ['box-shadow'], '');
  if (win === undefined) return false;
  const first = qf16SplitTop(win.value)[0] ?? '';
  const tokens = qf16Tokens(first);
  if (!tokens.includes('inset')) return false;
  const lengths = tokens.filter((t) => /^[+-]?[\d.]/.test(t)).map((t) => Number.parseFloat(t));
  const offsetOrSpread = (lengths[0] ?? 0) !== 0 || (lengths[3] ?? 0) !== 0;
  const colour = tokens.find((t) => t !== 'inset' && !/^[+-]?[\d.]/.test(t));
  return (
    lengths.length >= 2 &&
    offsetOrSpread &&
    colour !== undefined &&
    QF16_BAR_COLOURS.includes(colour)
  );
}

interface Qf16Layer {
  readonly attachment: string;
  readonly image: string;
  readonly position: string;
  readonly width: string;
  readonly height: string;
}

/** The layers of the winning `background` shorthand (a longhand-only winner has no images). A layer
 *  that names none of local / scroll / fixed is `scroll`, the CSS initial value. */
function qf16Layers(win: Qf16Decl | undefined): Qf16Layer[] {
  if (win === undefined) return [];
  return qf16SplitTop(win.value).map((raw) => {
    const text = raw.trim();
    if (win.prop === 'background-attachment') {
      return { attachment: text, image: '', position: '', width: '', height: '' };
    }
    const tokens = qf16Tokens(text);
    const slash = tokens.indexOf('/');
    const head = slash === -1 ? tokens : tokens.slice(0, slash);
    const next = slash === -1 ? '' : (tokens[slash + 2] ?? '');
    return {
      attachment: tokens.find((t) => t === 'local' || t === 'scroll' || t === 'fixed') ?? 'scroll',
      image: tokens.find((t) => /-gradient\(|^url\(/.test(t)) ?? '',
      position: head.find((t) => ['top', 'bottom', 'left', 'right', 'center'].includes(t)) ?? '',
      width: slash === -1 ? '' : (tokens[slash + 1] ?? ''),
      height: slash === -1 ? '' : /^[\d.+-]/.test(next) ? next : 'auto',
    };
  });
}

const qf16Attachments = (win: Qf16Decl | undefined): string[] =>
  qf16Layers(win).map((l) => l.attachment);

/** A length as `{ px }` (rem and em at 16px) or `{ pct }`; undefined for `auto` and the rest. */
function qf16Len(len: string): { px: number } | { pct: number } | undefined {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|rem|em|%)?$/.exec(len);
  if (m === null) return undefined;
  const n = Number(m[1]);
  if (m[2] === '%') return { pct: n };
  if (m[2] === undefined) return n === 0 ? { px: 0 } : undefined;
  return { px: m[2] === 'px' ? n : n * 16 };
}

/** A cover layer's height hides the shadow only at an edge: a positive length, and a percentage
 *  only below 100%. */
function qf16CoverHeightOk(height: string): boolean {
  const len = qf16Len(height);
  if (len === undefined) return false;
  return 'px' in len ? len.px > 0 : len.pct > 0 && len.pct < 100;
}

/** `shadow` is positive and no taller than `cover` (same unit family only). */
function qf16ShadowFitsCover(shadow: string, cover: string): boolean {
  const s = qf16Len(shadow);
  const c = qf16Len(cover);
  if (s === undefined || c === undefined) return false;
  if ('px' in s && 'px' in c) return s.px > 0 && s.px <= c.px;
  if ('pct' in s && 'pct' in c) return s.pct > 0 && s.pct <= c.pct;
  return false;
}

/** A gradient with at least one stop that paints: the frame fg / border token, a hex, or an
 *  rgb/hsl with non-zero alpha. `transparent` and the frame bg token do not. */
function qf16GradientPaints(image: string): boolean {
  const inner = image.slice(image.indexOf('(') + 1, image.lastIndexOf(')'));
  return qf16SplitTop(inner).some((arg) => {
    if (/var\(--mr-frame-(?:fg|border)\)/.test(arg) || /#[0-9a-f]{3,8}\b/.test(arg)) return true;
    const fn = /(?:rgb|hsl)a?\(([^)]*)\)/.exec(arg);
    if (fn === null) return false;
    const parts = (fn[1] ?? '').split(/[\s,/]+/).filter((p) => p !== '');
    return parts.length < 4 || Number.parseFloat(parts[3] ?? '0') !== 0;
  });
}

const qf16Fill = (cs: CSSStyleDeclaration): string =>
  cs.backgroundColor !== '' ? cs.backgroundColor : cs.background;

/** Is a visible outline drawn? (style set and not none, width not zero) */
function qf16OutlineOn(cs: CSSStyleDeclaration): boolean {
  const style =
    cs.outlineStyle !== ''
      ? cs.outlineStyle
      : (/\b(solid|dashed|dotted|double|groove|ridge|inset|outset|auto)\b/.exec(cs.outline)?.[1] ??
        'none');
  return style !== 'none' && cs.outlineWidth !== '0' && cs.outlineWidth !== '0px';
}

/** The non-fill selected-row cue: a computed, non-zero left border drawn in the frame fg / border
 *  token (not the bg token, not transparent), or an inset box-shadow bar with a real offset or
 *  spread in such a colour. `el` is read by the cascade, `cs` is its computed style. */
function qf16HasCue(el: Element, cs: CSSStyleDeclaration): boolean {
  const border =
    cs.borderLeftStyle !== '' &&
    cs.borderLeftStyle !== 'none' &&
    cs.borderLeftWidth !== '0' &&
    cs.borderLeftWidth !== '0px' &&
    QF16_BAR_COLOURS.includes(qf16BarColourOf(el));
  return border || qf16ShadowBarOn(el);
}

function qf16OverflowY(cs: CSSStyleDeclaration): string {
  if (cs.overflowY !== '') return cs.overflowY;
  const tokens = cs.overflow.trim().split(/\s+/);
  return tokens[1] ?? tokens[0] ?? '';
}

interface Qf16Scroll {
  readonly el: HTMLElement;
  readonly arg: unknown;
  /** Called on a node inside `#leaderboard-list` (the Players list scrolls through the kit). */
  readonly inBoard: boolean;
}

/** Replace `scrollIntoView` (happy-dom may lack it) with a recorder, until `restore()`. */
function qf16StubScroll(): { calls: Qf16Scroll[]; restore: () => void } {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const own = Object.getOwnPropertyDescriptor(proto, 'scrollIntoView');
  const calls: Qf16Scroll[] = [];
  Object.defineProperty(proto, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, arg?: unknown): void {
      calls.push({ el: this, arg, inBoard: this.closest('#leaderboard-list') !== null });
    },
  });
  return {
    calls,
    restore: () => {
      if (own !== undefined) Object.defineProperty(proto, 'scrollIntoView', own);
      else Reflect.deleteProperty(proto, 'scrollIntoView');
    },
  };
}

describe('LeaderboardView — the Rankings rows are display-only (qf-16, QF16.1)', () => {
  it('a populated Rankings paint marks the board list aria-readonly=true while every ranked row keeps mr-nav-item and only the cursor row is-active + selected; the mark is gone on the legacy board and whenever the paint is not applied: hide, a Players paint, an empty board, a hidden render, the re-open edge [QF16-1-READONLY-MARK]', () => {
    // WRONG IMPL KILLED: no mark at all (RED today); the mark on the rows or the overlay instead of
    // the list; the mark written by render() with no paint (the legacy board would claim to be
    // read-only); the mark left behind by hide(), a Players paint, an empty board, a render while
    // hidden, a paint made while hidden, or a root closed behind the view's back and re-opened; a
    // mark that sticks after the board empties (never comes back with rows); the readonly
    // treatment bought by renaming or dropping the row classes (the exact class strings are pinned,
    // and the boot test pins is-active on the cursor row).
    const { overlay } = mountLeaderboardOverlay();
    const view = new LeaderboardView();
    const list = byId('leaderboard-list') as HTMLElement;
    const readonly = (): string | null => list.getAttribute('aria-readonly');

    view.render(makeVm(BOARD));
    expect(readonly(), 'a hidden legacy board').toBeNull();
    view.show();
    view.render(makeVm(BOARD));
    expect(readonly(), 'a shown legacy board with no paint').toBeNull();

    view.paintSocial(rankingsPaint('bb'));
    expect(readonly(), 'a Rankings paint over rows').toBe('true');
    expect(list.getAttribute('role'), 'still the listbox').toBe('listbox');
    const items = rowsOf();
    expect(
      items.map((li) => li.className),
      'row classes are unchanged: the cursor row is still is-active',
    ).toEqual(['mr-nav-item', 'mr-nav-item is-active', 'mr-nav-item']);
    expect(items.map((li) => li.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(
      items.some((li) => li.hasAttribute('aria-readonly')),
      'a list mark, not a row mark',
    ).toBe(false);
    expect(overlay.hasAttribute('aria-readonly'), 'and not on the dialog root').toBe(false);

    // The cursor moving keeps the mark (it is the list's, not the cursor row's).
    view.paintSocial(rankingsPaint('cc'));
    expect(readonly(), 'a repaint with a new cursor').toBe('true');

    // hide() drops it.
    view.hide();
    expect(readonly(), 'after hide()').toBeNull();

    // A render while hidden, and a paint made while hidden, carry none.
    view.render(makeVm(BOARD));
    expect(readonly(), 'a render while hidden').toBeNull();
    view.paintSocial(rankingsPaint('bb'));
    expect(readonly(), 'a paint made while hidden is not kept').toBeNull();

    // A Players paint drops it, and Rankings brings it back.
    view.show();
    view.render(makeVm(BOARD));
    view.paintSocial(rankingsPaint('bb'));
    expect(readonly(), 'Rankings again after the re-open').toBe('true');
    const rows: readonly SocialPlayerRow[] = [{ key: 'bb', name: 'Bob', nearby: false }];
    view.paintSocial(playersPaint(rows, 'bb'));
    expect(readonly(), 'a Players paint').toBeNull();
    view.paintSocial(rankingsPaint('bb'));
    expect(readonly(), 'back on Rankings').toBe('true');

    // The empty board is a plain list, painted or not, and the mark returns with the rows.
    view.render(makeVm([]));
    expect(readonly(), 'an empty board under a kept Rankings paint').toBeNull();
    view.paintSocial(rankingsPaint('bb'));
    expect(readonly(), 'a Rankings paint over the empty board').toBeNull();
    view.render(makeVm(BOARD));
    expect(readonly(), 'rows arrive again').toBe('true');
    view.render(makeVm([]));
    expect(readonly(), 'emptied again').toBeNull();

    // The hidden -> visible edge drops a paint the view never saw closing.
    view.render(makeVm(BOARD));
    view.paintSocial(rankingsPaint('bb'));
    expect(readonly(), 'fixture: marked').toBe('true');
    overlay.style.display = 'none';
    view.show();
    expect(readonly(), 'the re-open edge').toBeNull();
  });
});

describe('LeaderboardView — the Rankings cursor row scrolls into view (qf-16, QF16.2)', () => {
  it('a Rankings paint scrolls the cursor row into view once per change of cursor row (block nearest, called on that row), never on a re-render or repaint of the same cursor, again after a hide or a Players tab, never on a detached list, and tolerates a missing scrollIntoView [QF16-2-SCROLL-ON-STEP]', () => {
    // WRONG IMPL KILLED: no scroll at all (RED today: Rankings marks rows by hand, so the nav kit's
    // scroll rule never runs for it); a scroll on the legacy board or on every render/paint (main
    // re-renders the board each store batch: the list would be yanked back while the player reads);
    // a "last scrolled" kept as the row NODE instead of its id (a re-render replaces every <li>, so
    // the same cursor would re-scroll); one that tracks the paint's cursor key instead of the row
    // shown (an unknown cursor or a vanished row falls back to the first row: that is a new row);
    // the memory not reset by a hide() or a Players paint (the next visit would not scroll the
    // cursor into view); a scroll with other options (`center` would recentre the list on every
    // step); a call on the list or another node instead of the cursor <li>; an unguarded call on a
    // detached list or where scrollIntoView does not exist.
    const stub = qf16StubScroll();
    try {
      mountLeaderboardOverlay();
      const view = new LeaderboardView();
      const boardIds = (): string[] => stub.calls.filter((c) => c.inBoard).map((c) => c.el.id);
      const last = (): Qf16Scroll => stub.calls[stub.calls.length - 1] as Qf16Scroll;

      view.show();
      view.render(makeVm(BOARD));
      expect(stub.calls.length, 'the legacy board scrolls nothing').toBe(0);

      // First paint: the cursor row, once, on that <li>, with { block: 'nearest' }.
      view.paintSocial(rankingsPaint('bb'));
      expect(boardIds(), 'the first Rankings paint scrolls the cursor row').toEqual([
        'social-rankings-bb',
      ]);
      expect(last().arg, 'nearest, nothing else').toEqual({ block: 'nearest' });
      expect(last().el, 'called ON the cursor row').toBe(rowsOf()[1]);

      // The same cursor, however it arrives: nothing more.
      view.render(makeVm(BOARD));
      view.render(makeVm(BOARD));
      view.paintSocial(rankingsPaint('bb'));
      view.paintSocial(rankingsPaint('bb'));
      expect(boardIds(), 're-render / repaint of the same cursor: no new scroll').toEqual([
        'social-rankings-bb',
      ]);

      // The cursor steps: the NEW row, once each.
      view.paintSocial(rankingsPaint('cc'));
      expect(boardIds()).toEqual(['social-rankings-bb', 'social-rankings-cc']);
      expect(last().arg).toEqual({ block: 'nearest' });
      expect(last().el, 'called on the new cursor row').toBe(rowsOf()[2]);

      // An unknown cursor falls back to the first row: that is a change of row, scrolled once...
      view.paintSocial(rankingsPaint('nobody'));
      expect(boardIds().slice(2), 'unknown cursor: the fallback row').toEqual([
        'social-rankings-aa',
      ]);
      expect(last().el).toBe(rowsOf()[0]);
      // ...and a null or another unknown cursor naming the same fallback row is not.
      view.paintSocial(rankingsPaint(null));
      view.paintSocial(rankingsPaint('nobody'));
      expect(boardIds().length, 'the fallback row again: no scroll').toBe(3);

      // Back to cc, then the cursor row vanishes from the board: the first row, scrolled once.
      view.paintSocial(rankingsPaint('cc'));
      expect(boardIds().slice(3)).toEqual(['social-rankings-cc']);
      view.render(makeVm(BOARD.slice(0, 1)));
      expect(boardIds().slice(4), 'the cursor row left the board').toEqual(['social-rankings-aa']);
      view.render(makeVm(BOARD));
      expect(boardIds().slice(5), 'and came back').toEqual(['social-rankings-cc']);
      expect(boardIds().length, 'one scroll per change, no more').toBe(6);

      // A Players tab scrolls no board row; the next Rankings paint scrolls the cursor again, even
      // though its id is the one last scrolled to.
      const rows: readonly SocialPlayerRow[] = [{ key: 'bb', name: 'Bob', nearby: false }];
      view.paintSocial(playersPaint(rows, 'bb'));
      expect(boardIds().length, 'a Players paint scrolls no ranking row').toBe(6);
      view.paintSocial(rankingsPaint('cc'));
      expect(boardIds().slice(6), 'Rankings after Players: scrolled again').toEqual([
        'social-rankings-cc',
      ]);
      expect(last().el).toBe(rowsOf()[2]);

      // hide() then show(): the next Rankings paint scrolls again (same cursor id).
      view.hide();
      view.show();
      view.render(makeVm(BOARD));
      view.paintSocial(rankingsPaint('cc'));
      expect(boardIds().slice(7), 'after a hide and a re-open: scrolled again').toEqual([
        'social-rankings-cc',
      ]);
      expect(boardIds().length).toBe(8);

      // A re-sort that moves the cursor row to another index (ratings changed): the same id, but
      // the row is off-screen from where the scroll left it, so it is scrolled once at its new
      // place. Re-rendering that same order scrolls nothing; swapping only OTHER rows (the cursor
      // keeps its index) scrolls nothing.
      // WRONG IMPL KILLED: a dedupe keyed on the cursor id alone (the cursor row stays off-screen
      // after a re-sort); a scroll on every order change whatever the cursor's index.
      const [aa, bb, cc] = BOARD as [
        (typeof BOARD)[number],
        (typeof BOARD)[number],
        (typeof BOARD)[number],
      ];
      view.render(makeVm([cc, aa, bb]));
      expect(
        rowsOf().map((li) => li.id),
        'fixture: the cursor row moved to index 0',
      ).toEqual(['social-rankings-cc', 'social-rankings-aa', 'social-rankings-bb']);
      expect(boardIds().slice(8), 're-sorted: the cursor row, at its new index').toEqual([
        'social-rankings-cc',
      ]);
      expect(last().arg).toEqual({ block: 'nearest' });
      expect(last().el, 'called on the new <li> of the moved cursor row').toBe(rowsOf()[0]);
      view.render(makeVm([cc, aa, bb]));
      view.render(makeVm([cc, aa, bb]));
      expect(boardIds().length, 'the same order again: no scroll').toBe(9);
      view.render(makeVm([aa, bb, cc]));
      expect(boardIds().slice(9), 'sorted back: the cursor row moved again').toEqual([
        'social-rankings-cc',
      ]);
      expect(last().el).toBe(rowsOf()[2]);
      view.render(makeVm([bb, aa, cc]));
      expect(boardIds().length, 'other rows swapped, the cursor index kept: no scroll').toBe(10);

      // A detached list scrolls nothing (the view is built while attached, as its constructor needs).
      view.hide();
      const { overlay: detached } = mountLeaderboardOverlay();
      const orphan = new LeaderboardView();
      orphan.show();
      orphan.render(makeVm(BOARD));
      detached.remove();
      const before = stub.calls.length;
      orphan.paintSocial(rankingsPaint('bb'));
      expect(stub.calls.length, 'a detached list: no scroll').toBe(before);
      orphan.hide();

      // Where scrollIntoView does not exist the paint still lands.
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: undefined,
      });
      mountLeaderboardOverlay();
      const bare = new LeaderboardView();
      bare.show();
      bare.render(makeVm(BOARD));
      expect(() => bare.paintSocial(rankingsPaint('bb'))).not.toThrow();
      expect(
        rowsOf().map((li) => li.getAttribute('aria-selected')),
        'the marks still land',
      ).toEqual(['false', 'true', 'false']);
    } finally {
      stub.restore();
    }
  });
});

describe('LeaderboardView — the real stylesheet on the Rankings list (qf-16, QF16.1, QF16.2)', () => {
  let sheet: HTMLStyleElement | null = null;
  beforeEach(() => {
    sheet = document.createElement('style');
    // The REAL sheet, then two reference classes carrying the shipped actionable declarations
    // (`background: var(--mr-frame-fg)`, `color: var(--mr-frame-bg)`) through the same mechanism as
    // `.mr-nav-item.is-active`, so a comparison holds whether or not happy-dom resolves var().
    sheet.textContent = `${QF16_STYLES_CSS}\n.qf16-ref-fill { background: var(--mr-frame-fg); }\n.qf16-ref-text { color: var(--mr-frame-bg); }\n`;
    document.head.appendChild(sheet);
  });
  afterEach(() => {
    sheet?.remove();
    sheet = null;
    document.body.classList.remove('mr-pointer-hover');
  });

  /** The shell as client/index.html:58-60 ships it, painted on Rankings with the cursor on `bb`. */
  function qf16Shell(): { overlay: HTMLElement; list: HTMLElement } {
    const { overlay, list } = mountLeaderboardOverlay();
    overlay.className = 'mr-frame mr-shell';
    list.className = 'mr-nav-list';
    const view = new LeaderboardView();
    view.show();
    view.render(makeVm(BOARD));
    view.paintSocial(rankingsPaint('bb'));
    return { overlay, list };
  }

  const div = (parent: HTMLElement, className: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = className;
    parent.appendChild(el);
    return el;
  };

  it('the Rankings cursor row computes no inverted fill, no inverted text colour, no outline and no ▶, and carries a non-fill cue the other ranking rows lack, while an actionable nav row in the same sheet keeps all of them [QF16-1-COMPUTED-DISTINCT]', () => {
    // WRONG IMPL KILLED: today's code (the cursor row computes exactly the actionable row's fill,
    // text colour, outline and ▶); a rule keyed on a selector that never matches the row (an
    // `[aria-readonly]` test on the <li>, or on the wrong ancestor): the fill and ▶ stay; a rule
    // that changes only the outline and keeps the inverted fill (or only the fill); the ▶ left on;
    // a cue on every ranking row instead of the selected one; a treatment bought by changing the
    // actionable `.mr-nav-item.is-active` rule itself (the probe row below is that rule).
    qf16Shell();
    // The pointer drove last (styles.css: `.mr-pointer-hover` on the game screen); removed in afterEach.
    document.body.classList.add('mr-pointer-hover');
    const [other, cursor] = rowsOf() as [HTMLElement, HTMLElement, HTMLElement];

    const frame = div(document.body, 'mr-frame');
    const ul = document.createElement('ul');
    ul.className = 'mr-nav-list';
    const active = document.createElement('li');
    active.className = 'mr-nav-item is-active';
    const plain = document.createElement('li');
    plain.className = 'mr-nav-item';
    ul.append(active, plain);
    frame.appendChild(ul);
    const fillRef = div(frame, 'qf16-ref-fill');
    const textRef = div(frame, 'qf16-ref-text');

    // happy-dom caches computed style per element: every element is read once.
    const onCursor = getComputedStyle(cursor);
    const onOther = getComputedStyle(other);
    const onActive = getComputedStyle(active);
    const onPlain = getComputedStyle(plain);
    const fill = getComputedStyle(fillRef);
    const text = getComputedStyle(textRef);

    // ANTI-VACUITY: the sheet parsed, and the actionable probe really computes the treatment the
    // ranking row must not have.
    expect(QF16_RULES.length > 0, 'the cascade scan sees rules').toBe(true);
    expect(qf16Fill(onActive), 'probe: the actionable active row has a fill').not.toBe('');
    expect(qf16Fill(onActive), 'probe: its fill is the frame fg token').toBe(qf16Fill(fill));
    expect(qf16Fill(onPlain), 'probe: a plain row has a different fill').not.toBe(
      qf16Fill(onActive),
    );
    expect(onActive.color, 'probe: its text is the frame bg token').toBe(text.color);
    expect(onPlain.color, 'probe: a plain row has a different text colour').not.toBe(
      onActive.color,
    );
    expect(qf16OutlineOn(onActive), 'probe: the actionable row is outlined').toBe(true);
    expect(qf16OutlineOn(onPlain), 'probe: a plain row is not').toBe(false);
    expect(qf16HasCue(active, onActive), 'probe: the actionable row has no read-only cue').toBe(
      false,
    );
    expect(
      qf16Winner(active, ['content'], '::before')?.value.includes(QF16_ARROW),
      'probe: the actionable row has the ▶ (the ::before scan sees the shipped rule)',
    ).toBe(true);
    expect(cursor.className, 'fixture: the cursor row is still is-active').toBe(
      'mr-nav-item is-active',
    );

    // The read-only cursor row.
    expect(qf16Fill(onCursor), 'no inverted fill').not.toBe(qf16Fill(fill));
    expect(onCursor.color, 'no inverted text colour').not.toBe(text.color);
    expect(qf16OutlineOn(onCursor), 'no outline').toBe(false);
    expect(
      qf16Winner(cursor, ['content'], '::before')?.value.includes(QF16_ARROW) ?? false,
      'no ▶ marker',
    ).toBe(false);
    expect(
      qf16HasCue(cursor, onCursor),
      'a read-only cue in place of the fill (left border / inset bar in the frame fg token)',
    ).toBe(true);
    expect(qf16HasCue(other, onOther), 'and only the selected row carries it').toBe(false);

    // ROUND 2 (A): the bar's colour. ANTI-VACUITY: the colour fold reads a shipped border shorthand
    // (the frame's own `border: 2px solid var(--mr-frame-border)`), and the allowed set excludes the
    // frame bg token (a bar the colour of the page) and transparent.
    expect(qf16BarColourOf(frame), 'probe: the fold sees a shipped border colour').toBe(
      'var(--mr-frame-border)',
    );
    expect(QF16_BAR_COLOURS).not.toContain('var(--mr-frame-bg)');
    expect(QF16_BAR_COLOURS).not.toContain('transparent');
    expect(QF16_BAR_COLOURS, 'the bar colour of the cursor row').toContain(qf16BarColourOf(cursor));

    // ROUND 2 (E): no near-inverted fill and no near-inverted text. ANTI-VACUITY: the cascade reads
    // the actionable row's inverted fill and text and a plain row's clear fill.
    expect(qf16FillOf(active), 'probe: the actionable fill by the cascade').toBe(
      'var(--mr-frame-fg)',
    );
    expect(qf16TextColourOf(active), 'probe: the actionable text by the cascade').toBe(
      'var(--mr-frame-bg)',
    );
    expect(qf16IsClear(qf16FillOf(active)), 'probe: that fill is not clear').toBe(false);
    expect(qf16IsClear(qf16FillOf(plain)), 'probe: a plain row paints no fill').toBe(true);
    expect(qf16IsClear(qf16FillOf(cursor)), 'the cursor row paints no fill at all').toBe(true);
    expect(
      [undefined, 'inherit', 'currentcolor', 'var(--mr-frame-fg)'],
      'its text is the frame foreground, as on a plain row',
    ).toContain(qf16TextColourOf(cursor));
    expect(qf16TextColourOf(other), 'a plain ranking row sets none').toBeUndefined();

    // ROUND 2 (F): rules inside an at-rule (@media print, @supports, a never-matching media query)
    // do not count, so the `content: none` and the fill reset must be top-level. ANTI-VACUITY: the
    // parser marks the sheet's existing @media rule nested and its plain rules top-level.
    expect(
      QF16_RULES.some((r) => r.nested && r.selector === '.hp-fill'),
      'probe: the @media-wrapped .hp-fill guard is nested',
    ).toBe(true);
    expect(
      QF16_RULES.some((r) => !r.nested && r.selector === '.mr-frame'),
      'probe: .mr-frame is top-level',
    ).toBe(true);

    // ROUND 2 (H): no clickable hover cue. Under `.mr-pointer-hover` (body) with the pointer over the
    // row, an actionable nav row is underlined (`.mr-pointer-hover .mr-nav-item:hover`), and a
    // read-only ranking row, cursor or not, is not. ANTI-VACUITY: the probe rows win the underline
    // through the hover rule, and only with hover evaluated.
    const decoration = ['text-decoration', 'text-decoration-line'];
    expect(
      qf16Winner(active, decoration, '', true)?.value,
      'probe: hovering the actionable active row underlines it',
    ).toContain('underline');
    expect(
      qf16Winner(plain, decoration, '', true)?.value,
      'probe: hovering a plain actionable row underlines it',
    ).toContain('underline');
    expect(qf16Winner(active, decoration, ''), 'probe: no underline without the hover').toBe(
      undefined,
    );
    for (const [label, row] of [
      ['the cursor row', cursor],
      ['another ranking row', other],
    ] as const) {
      expect(
        qf16Winner(row, decoration, '', true)?.value ?? 'none',
        `${label}: no hover underline on a read-only row`,
      ).not.toContain('underline');
    }
  });

  it('the Rankings list is its own scroll container in the flex-column overlay: overflow-y auto, min-height 0, shrinkable, with background layers that are both local and scroll (overflow-only scroll shadows) [QF16-2-OVERFLOW-AFFORDANCE]', () => {
    // WRONG IMPL KILLED: today's code (the list computes overflow-y visible and min-height auto,
    // and has no background layers); overflow set on the overlay or `.mr-frame-body` only (the
    // list never becomes the scroller); no min-height: 0 (a flex item cannot shrink below its
    // content, so it grows with the rows and never scrolls); `flex: none` / shrink 0; overflow
    // `hidden` or `visible` (clipped or unbounded); an always-on shadow (only `scroll` layers: it
    // shows at both edges even with nothing to scroll to) or covers without shadows (only `local`);
    // a later rule that resets the overflow.
    const { overlay, list } = qf16Shell();
    const frame = div(document.body, 'mr-frame');
    const body = div(frame, 'mr-frame-body');
    const bare = div(frame, '');

    const shell = getComputedStyle(overlay);
    const onList = getComputedStyle(list);
    const bodyControl = getComputedStyle(body);
    const bareControl = getComputedStyle(bare);

    // ANTI-VACUITY: happy-dom computes overflow-y from this sheet at all (an existing rule), a
    // classless block is not a scroller, and the overlay is the flex column the min-height is for.
    expect(qf16OverflowY(bodyControl), 'control: .mr-frame-body scrolls').toBe('auto');
    expect(['auto', 'scroll'], 'control: a bare block is not a scroller').not.toContain(
      qf16OverflowY(bareControl),
    );
    expect(shell.display, 'the overlay is a flex container').toBe('flex');
    expect(shell.flexDirection, 'a column').toBe('column');

    expect(['auto', 'scroll'], 'the list scrolls its own overflow').toContain(
      qf16OverflowY(onList),
    );
    expect(['0', '0px'], 'min-height 0 lets the flex item shrink below its rows').toContain(
      onList.minHeight,
    );
    expect(
      onList.flexShrink === '' || Number(onList.flexShrink) > 0,
      `the list can shrink (flex-shrink ${onList.flexShrink})`,
    ).toBe(true);

    const layers = qf16Attachments(qf16Winner(list, ['background', 'background-attachment'], ''));
    expect(layers, 'the list paints background layers').not.toEqual([]);
    expect(layers, 'cover layers that move with the content (overflow-only shadows)').toContain(
      'local',
    );
    expect(layers, 'shadow layers fixed to the box edges').toContain('scroll');

    // ROUND 2 (K): a real scroll box. `display: contents` / none / inline give an overflow-y that
    // happy-dom computes and a browser ignores. ANTI-VACUITY: the cascade reads the overlay's
    // shipped `display: flex`.
    expect(qf16Winner(overlay, ['display'], '')?.value, 'probe: the cascade reads display').toBe(
      'flex',
    );
    expect(
      [undefined, 'block', 'flow-root', 'flex', 'grid'],
      'the list is a block-level box by the cascade',
    ).toContain(qf16Winner(list, ['display'], '')?.value);
    expect(['contents', 'none', 'inline'], 'and by its computed style').not.toContain(
      onList.display,
    );

    // ROUND 2 (B, C, D): the shadow layers. Each `local` cover is painted in the frame bg token (it
    // hides the shadow it sits on) with a positive height below 100%; each `scroll` shadow paints
    // (a stop that is not transparent or the bg token) and is no taller than its cover. ANTI-VACUITY:
    // every layer parsed to an image and a length, and covers and shadows pair up.
    const parsed = qf16Layers(qf16Winner(list, ['background', 'background-attachment'], ''));
    const covers = parsed.filter((l) => l.attachment === 'local');
    const shadows = parsed.filter((l) => l.attachment === 'scroll');
    expect(
      parsed.every((l) => l.image !== '' && qf16Len(l.height) !== undefined),
      'probe: every layer is an image with a parsed height',
    ).toBe(true);
    expect(covers.length, 'covers and shadows come in pairs').toBe(shadows.length);
    expect(covers.length > 0, 'and there is at least one pair').toBe(true);
    covers.forEach((cover, i) => {
      expect(cover.image, `cover ${i}: painted in the frame bg token`).toContain(
        'var(--mr-frame-bg)',
      );
      expect(
        qf16CoverHeightOk(cover.height),
        `cover ${i}: a positive height below 100% (${cover.height})`,
      ).toBe(true);
    });
    shadows.forEach((shadow, i) => {
      expect(qf16GradientPaints(shadow.image), `shadow ${i}: paints something`).toBe(true);
      expect(
        qf16ShadowFitsCover(shadow.height, covers[i]?.height ?? ''),
        `shadow ${i}: positive and no taller than its cover (${shadow.height})`,
      ).toBe(true);
    });

    // ROUND 2 (N): nothing paints over the shadows. Every ranking row paints no fill, so the
    // list's background shows through. ANTI-VACUITY: an actionable active row's fill is read as not
    // clear, and a ranking row sits in the list under test.
    const probeList = document.createElement('ul');
    probeList.className = 'mr-nav-list';
    const probeActive = document.createElement('li');
    probeActive.className = 'mr-nav-item is-active';
    probeList.appendChild(probeActive);
    frame.appendChild(probeList);
    expect(qf16IsClear(qf16FillOf(probeActive)), 'probe: an active nav row has a fill').toBe(false);
    const ranking = rowsOf();
    expect(ranking.length, 'probe: the ranking rows are in the list').toBe(BOARD.length);
    for (const row of ranking) {
      expect(qf16IsClear(qf16FillOf(row)), `${row.id}: paints no fill over the shadows`).toBe(true);
    }
  });
});
