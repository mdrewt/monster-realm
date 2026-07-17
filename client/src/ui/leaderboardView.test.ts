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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeaderboardViewModel } from './leaderboardModel';
import { LeaderboardView } from './leaderboardView';

// ---------------------------------------------------------------------------
// DOM mount helper — mirrors the additions to client/index.html that the
// implementer must deliver.  Called in beforeEach so each test gets a fresh DOM.
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

  const title = document.createElement('div');
  title.id = 'leaderboard-title';
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
    // This is the client-side RL-15 mirror for the VIEW layer; the server-side
    // teeth live in m17c's ranking-security eval.
    // Uses .includes() — no dynamic RegExp (eslint ReDoS ban).
    // fileURLToPath: robust against percent-encoding in import.meta.url (m17b req #5).
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
      // set_profile_name is the only profile-write reducer the spec acknowledges
      // (ADR-0119 D6). Transitive-import indirection is out of scope for this scan
      // (review-caught), but a direct reference is a clear RL-15 violation.
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
    // This test is RED now (connection.ts exists but the subscription is not yet wired)
    // and becomes GREEN when the implementer adds the profile subscription line.
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
