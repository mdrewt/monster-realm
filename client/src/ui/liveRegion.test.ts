// @vitest-environment happy-dom
// ui/liveRegion.test.ts — m23-s1 RED gating tests for the 500ms-coalescing textContent-only sink.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.4, §6 A11Y-9;
//   memory/projects/monster-realm-m23-s1-plan.md (finding F5, adjudication A1);
//   memory/projects/gates/m23-s1.gates.md X7/X8/X9.
//
// RED REASON: `client/src/ui/liveRegion.ts` DOES NOT EXIST YET. Every test below fails with
// "Failed to resolve import './liveRegion'" (module-not-found) until the implementer lands it.
//
// ENVIRONMENT: happy-dom — this file exercises real DOM writes to a `#a11y-live` node and shadows
// its `textContent` setter, both of which need a DOM. The class takes `nowMs` as an argument (no
// Date.now/setTimeout inside liveRegion.ts, per the plan's F3 injected-clock rule) — every test
// below drives time purely through the numbers it passes to announce()/flush().
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.
//
// A NOTE ON THE "S1-LIVE-REANNOUNCE" NUMBERS (see the test itself): the plan's prose sequence
// (`announce('Box',0); flush(520); announce('Raising & Inventory',550); announce('Box',600);
// flush(1200)`) is transcribed here VERBATIM, and this file's assertion is derived independently
// from the module's own documented semantics (single #pending slot; a window opens only "if not
// already open"; #maybeEmit self-drains inside announce() first). Under those semantics the
// literal write SEQUENCE that follows from exactly two flush() calls is `['Box', 'Box']` — the
// SECOND write is what the FIX changes (from the wrong 'Raising & Inventory' to the correct
// 'Box'), not a third write of 'Raising & Inventory' materialising. That matches gate X8's own
// prose ("...THE SYSTEM SHALL still emit it once the pending one has been written" — singular).
// This is flagged explicitly in the test-writer's handoff report as something to double-check
// against the implementer's actual module-header derivation, in case the intended design differs
// from what the plan doc's prose describes.
//
// RED-TEAM ROUND 2: no measured hole was found against this file — the four holes closed in the
// sibling test files (focusTrap.test.ts x3, announcements.test.ts x1, overlayA11y.test.ts x1) did
// not implicate LiveRegion. Unchanged from the committed version other than this note.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { COALESCE_WINDOW_MS, LIVE_REGION_ID, LiveRegion } from './liveRegion';
import { adoptLiveRegion } from './liveRegion';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountLiveNode(): HTMLElement {
  document.body.innerHTML = `<div id="${LIVE_REGION_ID}"></div>`;
  return document.getElementById(LIVE_REGION_ID) as HTMLElement;
}

// ---------------------------------------------------------------------------
// 500ms coalescing burst behaviour (A11Y-9)
// ---------------------------------------------------------------------------

describe('LiveRegion — 500ms coalescing burst behaviour (A11Y-9)', () => {
  it('A11Y-9-BURST-LAST-WINS BITES: three announcements inside one 500ms window write only the most recent, and only once the window has elapsed', () => {
    const node = mountLiveNode();
    const region = new LiveRegion();

    region.announce('First', 0);
    region.announce('Second', 100);
    region.announce('Third', 400);

    // Still inside the window (300ms since it opened at t=0) — nothing written yet.
    region.flush(300);
    expect(node.textContent, 'no write before the coalesce window has elapsed').toBe('');

    // Past COALESCE_WINDOW_MS since t=0.
    region.flush(600);
    expect(COALESCE_WINDOW_MS).toBe(500);
    expect(node.textContent, 'only the LAST of the three burst messages is ever painted').toBe(
      'Third',
    );
  });

  it('A11Y-9-WRITE-COUNT-ONE BITES: the DOM write happens exactly ONCE for the whole burst, and the superseded messages are never even passed to the setter', () => {
    // WRONG IMPL KILLED: the write-through impl (no coalescing at all — every announce() writes
    // immediately). A test that only reads the FINAL textContent value cannot distinguish this
    // from a correctly-coalescing impl, because the final value is identical either way. This is
    // the decisive tooth: shadow the node's `textContent` setter and count calls.
    const node = mountLiveNode();
    const setSpy = vi.spyOn(node, 'textContent', 'set');
    const region = new LiveRegion();

    region.announce('First', 0);
    region.announce('Second', 100);
    region.announce('Third', 400);
    region.flush(600);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith('Third');
    const args = setSpy.mock.calls.map((call) => call[0]);
    expect(args, 'a superseded message must never even reach the setter').not.toContain('First');
    expect(args, 'a superseded message must never even reach the setter').not.toContain('Second');
  });
});

// ---------------------------------------------------------------------------
// Re-announce / consecutive dedup edge cases (S1-LIVE)
// ---------------------------------------------------------------------------

describe('LiveRegion — re-announce and consecutive-dedup edge cases (S1-LIVE)', () => {
  it('S1-LIVE-REANNOUNCE BITES: a message equal to the LAST-WRITTEN one, arriving while a DIFFERENT message is pending, is NOT silently dropped', () => {
    // WRONG IMPL KILLED (plan adjudication A1, MEASURED against the original design): a dedup
    // rule that compares a new announce() call only against `#lastWritten` (what was last
    // PAINTED) — rather than against `#pending ?? #lastWritten` (what will actually be emitted
    // next) — sees this second 'Box' as "unchanged" (because #lastWritten is still 'Box' from
    // the FIRST flush) and drops it, permanently leaving 'Raising & Inventory' as the region's
    // final announcement. A real accessibility loss, not a test artefact.
    const node = mountLiveNode();
    const region = new LiveRegion();

    region.announce('Box', 0);
    region.flush(520);
    expect(node.textContent, 'the first Box announcement must have painted').toBe('Box');

    region.announce('Raising & Inventory', 550);
    // A message equal to the STALE #lastWritten ('Box'), arriving while 'Raising & Inventory'
    // is still pending — must overwrite the pending value, not be dropped as a no-op.
    region.announce('Box', 600);
    region.flush(1200);

    expect(
      node.textContent,
      "the second 'Box' announcement must win — a #lastWritten-only dedup leaves " +
        "'Raising & Inventory' painted instead",
    ).toBe('Box');
  });

  it('S1-LIVE-DEDUP-CONSECUTIVE BITES: the SAME message announced twice in a row with nothing else in between writes only ONCE', () => {
    const node = mountLiveNode();
    const setSpy = vi.spyOn(node, 'textContent', 'set');
    const region = new LiveRegion();

    region.announce('Party & Box', 0);
    region.flush(520);
    expect(setSpy).toHaveBeenCalledTimes(1);

    // Nothing else was announced in between — this is a legitimate repeat, not a burst.
    region.announce('Party & Box', 600);
    region.flush(1200);

    expect(
      setSpy,
      'a consecutive identical announce must not trigger a second write',
    ).toHaveBeenCalledTimes(1);
    expect(node.textContent).toBe('Party & Box');
  });
});

// ---------------------------------------------------------------------------
// textContent-only DOM sink; absent/stale node handling (S1-LIVE)
// ---------------------------------------------------------------------------

describe('LiveRegion — textContent-only DOM sink, and correct behaviour when the node is absent/stale (S1-LIVE)', () => {
  it('S1-LIVE-TEXTCONTENT-ONLY BITES: the write leaves attributes unchanged and adds no element children — textContent is the ONLY DOM mutation', () => {
    // A `setAttribute` write is INVISIBLE to a textContent setter spy, so the write-count
    // assertion above does not by itself prove textContent is the ONLY thing touched.
    const node = mountLiveNode();
    const attrsBefore = node.attributes.length;
    const region = new LiveRegion();

    region.announce('Hello', 0);
    region.flush(600);

    expect(node.textContent).toBe('Hello');
    expect(node.attributes.length, 'no attribute may be added or removed by the write').toBe(
      attrsBefore,
    );
    expect(node.children.length, 'a textContent write can never add element children').toBe(0);
  });

  it('S1-LIVE-NO-MARKUP BITES: an announced payload that looks like markup is written as a literal string, never parsed as HTML', () => {
    // WRONG IMPL KILLED: `node.innerHTML = msg` (or any HTML-parsing sink) instead of
    // `node.textContent = msg` would parse this payload and execute the onerror handler in a
    // real browser.
    const node = mountLiveNode();
    const region = new LiveRegion();
    const payload = '<img src="x" onerror="window.__pwned = true">';

    region.announce(payload, 0);
    region.flush(600);

    expect(node.children.length).toBe(0);
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toBe(payload);
  });

  it('S1-LIVE-ABSENT-NODE BITES: announce+flush neither throws nor caches a null lookup when #a11y-live is absent — the message lands once the node appears', () => {
    // WRONG IMPL KILLED: a getElementById lookup memoised ONCE (e.g. at construction) would
    // stay null forever, even after S2 mounts the real node — the message would never land.
    document.body.innerHTML = ''; // no #a11y-live node in the document at all
    const region = new LiveRegion();

    expect(() => {
      region.announce('Hello', 0);
      region.flush(600);
    }, 'must not throw when the live region node is absent (S2 ships it later than S1)').not.toThrow();

    // Now the node appears (S2's shell mounts it) — a cached-null impl reds only here.
    document.body.innerHTML = `<div id="${LIVE_REGION_ID}"></div>`;
    const node = document.getElementById(LIVE_REGION_ID) as HTMLElement;
    region.announce('Hello', 1200);
    region.flush(1200);

    expect(node.textContent, 'the kept-pending message must land once the node exists').toBe(
      'Hello',
    );
  });

  it('S1-LIVE-STALE-NODE BITES: a node that gets detached and replaced by a fresh one with the same id is re-resolved on every write, never cached', () => {
    // WRONG IMPL KILLED: caching the Element reference (rather than re-resolving via
    // getElementById on every write) would keep writing to the DETACHED node forever, and the
    // fresh replacement node would stay empty.
    document.body.innerHTML = `<div id="${LIVE_REGION_ID}"></div>`;
    const staleNode = document.getElementById(LIVE_REGION_ID) as HTMLElement;
    const region = new LiveRegion();

    document.body.innerHTML = ''; // staleNode is now detached from the document
    expect(() => {
      region.announce('Hello', 0);
      region.flush(600);
    }).not.toThrow();
    expect(
      staleNode.textContent,
      'a caching impl would write to the DETACHED node instead',
    ).not.toBe('Hello');

    // A fresh node with the same id appears — the write must land on THIS node.
    document.body.innerHTML = `<div id="${LIVE_REGION_ID}"></div>`;
    const freshNode = document.getElementById(LIVE_REGION_ID) as HTMLElement;
    region.announce('Hello', 1200);
    region.flush(1200);

    expect(
      freshNode.textContent,
      'a stale cached node reference would silently write to the detached element and this ' +
        'fresh node would stay empty',
    ).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// Live-region custody — adoptLiveRegion unit edges + the channel still works
// (LRC-EDGE / LRC-CHANNEL, rb-11, residual R-m23-s2-X5)
// ---------------------------------------------------------------------------
//
// SOURCE OF TRUTH: memory/projects/monster-realm-rb-11-plan.md (reviewer-lens amendments — the
// seam is `adoptLiveRegion(root): () => void`, a release CLOSURE mirroring `focusTrap.ts:136`'s
// `installTrap(root): () => void`, NEVER an adopt/release PAIR); memory/projects/gates/
// rb-11.gates.md X3/X4.
//
// RED REASON: `adoptLiveRegion` does not exist in `./liveRegion` yet. Every test below fails to
// import it (or fails on a runtime assertion once a first cut lands something wrong) until the
// implementer lands the seam described in the plan.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.

/** The shipped-shape live-region fixture — `aria-live`/`aria-atomic` present, exactly as
 *  `client/index.html:154` ships it — needed by LRC-CHANNEL, which asserts those survive a move. */
function mountLiveNodeWithAria(): HTMLElement {
  const node = document.createElement('div');
  node.id = LIVE_REGION_ID;
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  document.body.appendChild(node);
  return node;
}

describe('adoptLiveRegion — no-op / no-churn edges (LRC-EDGE, X3)', () => {
  it('LRC-EDGE-NO-NODE-NOOP-CLOSURE BITES: with no live-region node in the document at all, adoptLiveRegion returns a callable NO-OP closure — the caller has no null branch to handle', () => {
    document.body.innerHTML = ''; // guaranteed: zero #a11y-live nodes anywhere
    const root = document.createElement('div');
    document.body.appendChild(root);

    const release = adoptLiveRegion(root);

    expect(typeof release, 'a callable closure, never null/undefined').toBe('function');
    expect(() => release()).not.toThrow();
    expect(
      document.querySelectorAll(`#${LIVE_REGION_ID}`).length,
      'no node may be conjured up out of thin air',
    ).toBe(0);
  });

  it('LRC-EDGE-CHURN-GUARD BITES: adopting the same root twice in a row does not remove+re-insert the node (W10, sentinel-order proxy)', () => {
    const node = mountLiveNodeWithAria();
    const root = document.createElement('div');
    document.body.appendChild(root);

    adoptLiveRegion(root);
    expect(root.lastElementChild, 'sanity: adopted as the last child').toBe(node);

    const sentinel = document.createElement('span');
    root.appendChild(sentinel);

    adoptLiveRegion(root); // the SAME root again — must be a churn no-op

    expect(
      root.lastElementChild,
      'KILLS W10 (the churn guard dropped): a needless remove+re-append would displace the ' +
        'sentinel that was appended after the first adopt',
    ).toBe(sentinel);
  });
});

describe('LiveRegion + adoptLiveRegion — the announcement channel still works while custody has moved (LRC-CHANNEL, X4)', () => {
  it('LRC-CHANNEL BITES: an announcement written through LiveRegion after custody has moved the node into an overlay root still lands on that SAME node, with aria-live/aria-atomic intact and exactly ONE [aria-live] node in the document', () => {
    const node = mountLiveNodeWithAria();
    expect(node, 'sanity: the live-region fixture must exist').not.toBeNull();
    const root = document.createElement('div');
    document.body.appendChild(root);

    adoptLiveRegion(root); // simulate an overlay having taken custody of the region

    const region = new LiveRegion();
    region.announce('Party & Box', 0);
    region.flush(600);

    expect(node.parentElement, 'sanity: custody moved the node into root').toBe(root);
    expect(
      node.textContent,
      'the announcement must land on the SAME node LiveRegion has always resolved fresh by id, ' +
        'wherever custody has since moved it',
    ).toBe('Party & Box');
    expect(node.getAttribute('aria-live'), 'aria-live must survive the re-parent untouched').toBe(
      'polite',
    );
    expect(
      node.getAttribute('aria-atomic'),
      'aria-atomic must survive the re-parent untouched',
    ).toBe('true');
    expect(
      document.querySelectorAll('[aria-live]').length,
      'EXACTLY one aria-live node must exist in the document — KILLS W7 (clone) and W8 (mirror)',
    ).toBe(1);
  });
});
