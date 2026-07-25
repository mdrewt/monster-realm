// @vitest-environment happy-dom
//
// indexShell.test.ts — static-markup invariants over the REAL client/index.html.
//
// SLICE: ux1   ADR: 0151   EARS criterion: ux1-1
//
// ux1-1: "THE game screen SHALL display a small, persistent, always-visible hint
//   (e.g. a corner badge) reading something like 'Press ? for controls & help',
//   visible during normal play (not just on first load)."
//
// WHY THIS READS THE REAL FILE (and NOT an inline fixture):
//   The repo's dominant view-test idiom hand-mirrors the shell as a fixture string
//   and mounts it. That idiom is VACUOUS for this criterion: the artifact under test
//   IS the shipped markup. A fixture would stay green after someone deletes
//   #help-hint from index.html, which is exactly the regression this file exists to
//   catch. So we readFileSync the real client/index.html (path resolved from
//   import.meta.url so it is cwd-independent — mirroring main.wiring.test.ts:44-60)
//   and parse it with DOMParser. There is no CSS file anywhere in this repo; all
//   styling is inline on the element, so the inline `style` attribute IS the
//   complete styling contract and is legitimately assertable as text.
//
// RED REASON (this suite MUST start red on the current tree, master bb87d74):
//   - client/index.html has NO #help-hint element at all → H1, H3, H4, H5, H6 fail.
//   - H2 passes today (regression guard: it bites only once the hint is added and
//     is left with an unclosed tag — see its comment).
//   - #help-overlay is `style="display:none"` with NO position and NO z-index
//     → H6 (needs the overlay's z-index as its ceiling) and H7 both fail.
//
// HONEST SCOPE LIMIT (see H5):
//   This file proves PRESENT, BODY-ANCHORED, and NOT-OBVIOUSLY-INVISIBLE.
//   It does NOT and CANNOT prove VISIBLE. happy-dom performs no layout, no
//   compositing and no viewport clipping, so a real visibility proof requires
//   client/e2e/** with Playwright's toBeInViewport() — out of this slice's
//   touch-set. H5 is a deny-list of the four cheapest invisibility regressions,
//   not a visibility check.
//
// NO `new RegExp(...)` anywhere — Semgrep detect-non-literal-regexp is banned
// repo-wide. All matching uses String.indexOf / .includes / .split / literal regex.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INDEX_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

function readIndexHtml(): string {
  try {
    return readFileSync(INDEX_HTML_PATH, 'utf8');
  } catch (err) {
    // Fail loud — every assertion below is vacuous if the file cannot be read.
    throw new Error(
      'index.html could not be read at expected path: ' + INDEX_HTML_PATH + ' — ' + String(err),
    );
  }
}

function parseIndexHtml(): Document {
  return new DOMParser().parseFromString(readIndexHtml(), 'text/html');
}

/** Raw inline style attribute, spaces stripped so `position: fixed` === `position:fixed`. */
function normalisedStyle(el: Element | null): string {
  if (el === null) return '';
  const raw = el.getAttribute('style');
  if (raw === null) return '';
  return raw.split(' ').join('').split('\n').join('').split('\t').join('');
}

/** Individual declarations of a normalised style string, empties dropped. */
function declarations(el: Element | null): string[] {
  return normalisedStyle(el)
    .split(';')
    .filter((d) => d.length > 0);
}

/**
 * True if any declaration is `banned` (or `banned` + a non-numeric suffix).
 * The suffix guard is what stops `opacity:0` from falsely matching `opacity:0.75`
 * while still catching `opacity:0!important` and `font-size:0px`.
 */
function hasBannedDeclaration(decls: string[], banned: string): boolean {
  return decls.some((decl) => {
    if (decl.indexOf(banned) !== 0) return false;
    const rest = decl.slice(banned.length);
    if (rest.length === 0) return true;
    return '0123456789.%'.indexOf(rest.charAt(0)) === -1;
  });
}

/** Raw (unparsed) value of the `z-index` declaration, or null when absent. */
function rawZIndex(el: Element | null): string | null {
  for (const decl of declarations(el)) {
    if (decl.indexOf('z-index:') === 0) return decl.slice('z-index:'.length);
  }
  return null;
}

// battleView's root z-index. The help overlay must sit BELOW it so a battle
// auto-show still supersedes an open help overlay (pt-c2b / ADR-0135 behaviour).
const BATTLE_VIEW_Z = 110;

describe('ux1-1 (H1/H2): the help hint exists and is anchored to <body>', () => {
  it('BITES: H1 — #help-hint exists and is a DIRECT child of <body>', () => {
    const doc = parseIndexHtml();
    const hint = doc.querySelector('#help-hint');

    // WRONG IMPL KILLED: the div was never added, or was deleted later.
    expect(
      hint,
      'KILLS: index.html with no #help-hint element — ux1-1 requires a persistent ' +
        'always-visible hint in the shipped markup, not just in a test fixture.',
    ).not.toBeNull();

    // WRONG IMPL KILLED: hint nested inside one of the ten `display:none` overlay
    // shells (#help-overlay, #shop-overlay, …). It would exist, have the right text
    // and the right inline style, and still be invisible during normal play because
    // the PARENT is display:none. A generic walk-up-the-ancestors visibility loop is
    // deliberately NOT used here: for a direct body child it can only ever inspect
    // <body>/<html> and is therefore vacuous. Pinning the parent is strictly stronger.
    expect(
      hint === null ? '(no #help-hint)' : hint.parentElement?.tagName,
      'KILLS: #help-hint nested inside a display:none overlay shell (or any wrapper) ' +
        'instead of being a direct child of <body> — it would be permanently hidden.',
    ).toBe('BODY');
  });

  it('BITES: H2 — #build-stamp is STILL a direct child of <body>', () => {
    const doc = parseIndexHtml();
    const stamp = doc.querySelector('#build-stamp');

    expect(
      stamp,
      'KILLS: #build-stamp removed from index.html — pt-a1/ADR-0128 build provenance ' +
        'pins which build a playtest finding came from.',
    ).not.toBeNull();

    // WRONG IMPL KILLED: an UNCLOSED </div> on the new #help-hint. Measured HTML
    // parser behaviour is that #build-stamp is then ADOPTED as a CHILD of #help-hint.
    // Every existence-only assertion (querySelector('#build-stamp') !== null) stays
    // green, while the build-provenance surface silently regresses: the stamp
    // inherits the hint's pointer-events:none and stacks its opacity/positioning
    // context. This parent assertion is the only thing in the suite that catches it.
    expect(
      stamp === null ? '(no #build-stamp)' : stamp.parentElement?.tagName,
      'KILLS: unclosed </div> on the new #help-hint — the parser re-parents ' +
        '#build-stamp INSIDE #help-hint, silently regressing pt-a1/ADR-0128 build ' +
        'provenance (inherited pointer-events:none + stacked opacity) while every ' +
        'existence-only assertion stays green.',
    ).toBe('BODY');
  });
});

describe('ux1-1 (H3): the hint actually advertises the ? key and help', () => {
  it('BITES: H3 — hint text contains "?" and (case-insensitively) "help"', () => {
    const doc = parseIndexHtml();
    const hint = doc.querySelector('#help-hint');
    // Note: DOMParser decodes `&amp;` to `&` in textContent — never assert on the entity.
    const text = hint === null ? '' : (hint.textContent ?? '');

    // WRONG IMPL KILLED: "Press F1 for help" (advertises the wrong key — pt-c2b bound
    // the help overlay to `?`), and an empty <div id="help-hint"></div>.
    expect(
      text.includes('?'),
      'KILLS: hint text that omits "?" (e.g. "Press F1 for help") or an empty ' +
        '#help-hint div — ux1-1 requires the hint to name the ? key. Got: ' +
        JSON.stringify(text),
    ).toBe(true);

    // Lowercased so a correct impl writing "Controls & Help" is not falsely failed.
    // WRONG IMPL KILLED: a bare "?" badge with no word explaining what it opens.
    expect(
      text.toLowerCase().includes('help'),
      'KILLS: a bare "?" badge with no explanatory word — ux1-1 requires the hint to ' +
        'read like "Press ? for controls & help". Got: ' + JSON.stringify(text),
    ).toBe(true);
  });
});

describe('ux1-1 (H4/H5): the hint is persistent and not obviously invisible', () => {
  it('BITES: H4 — hint inline style has position:fixed and pointer-events:none', () => {
    const doc = parseIndexHtml();
    const hint = doc.querySelector('#help-hint');
    const style = normalisedStyle(hint);

    // WRONG IMPL KILLED: a static/in-flow hint. There is no CSS file in this repo, so
    // without an inline position it scrolls/flows away with the document and is NOT
    // "persistent, always-visible" as ux1-1 demands — the same below-the-fold failure
    // mode #help-overlay has today (see H7).
    expect(
      style.includes('position:fixed'),
      'KILLS: a static (in-flow) #help-hint that scrolls out of the viewport with the ' +
        'document instead of being pinned — ux1-1 requires a PERSISTENT hint. ' +
        'style=' + JSON.stringify(style),
    ).toBe(true);

    // WRONG IMPL KILLED: a hint that swallows clicks in the bottom-left corner of the
    // PixiJS canvas — a fixed overlay without pointer-events:none is a click-eater.
    expect(
      style.includes('pointer-events:none'),
      'KILLS: a fixed #help-hint WITHOUT pointer-events:none — it eats canvas clicks ' +
        'in the bottom-left corner. style=' + JSON.stringify(style),
    ).toBe(true);
  });

  it('BITES: H5 — hint style contains no obvious-invisibility declaration (deny-list, NOT a visibility check)', () => {
    // HONEST SCOPE: happy-dom performs NO layout. This is a deny-list for the four
    // cheapest invisibility regressions — it is NOT and cannot be a visibility check.
    // At least a dozen other invisibility bugs provably pass ANY static-markup test:
    //   left:-9999px / top:-9999px, transform:scale(0), transform:translate(-200%,0),
    //   clip-path:inset(100%), clip:rect(0,0,0,0), content-visibility:hidden,
    //   the bare `hidden` attribute, width:0/height:0, overflow:hidden on a
    //   zero-size ancestor, color matching the background, a later element with a
    //   higher z-index painted over it, and off-viewport bottom/left offsets.
    // Catching those requires client/e2e/** + Playwright toBeInViewport(), which is
    // OUT of this slice's touch-set. Do not oversell this assertion.
    const doc = parseIndexHtml();
    const hint = doc.querySelector('#help-hint');

    // Precondition, NOT decoration: with no #help-hint, declarations() returns [] and
    // every deny-list check below passes vacuously. Deleting the element must never
    // be a way to satisfy H5.
    expect(
      hint,
      'KILLS: a vacuously-green H5 — with #help-hint absent the deny-list has nothing ' +
        'to scan and would pass. Deleting the element must not satisfy this test.',
    ).not.toBeNull();

    const decls = declarations(hint);
    expect(
      decls.length > 0,
      'KILLS: #help-hint with no inline style at all — there is no CSS file in this ' +
        'repo, so an unstyled hint is an unpositioned in-flow div (also caught by H4).',
    ).toBe(true);

    for (const banned of ['display:none', 'visibility:hidden', 'opacity:0', 'font-size:0']) {
      // `opacity:0` must NOT match `opacity:0.75` — hasBannedDeclaration requires the
      // declaration to end (or continue with a non-numeric suffix like !important).
      expect(
        hasBannedDeclaration(decls, banned),
        'KILLS: #help-hint styled with "' + banned + '" — the hint would ship but ' +
          'never be seen, defeating ux1-1. NOTE: this is a deny-list for OBVIOUS ' +
          'invisibility only, not a layout/visibility proof. decls=' +
          JSON.stringify(decls),
      ).toBe(false);
    }
  });
});

describe('ux1-1 (H6): the hint sits in a sane stacking band, below the modal band', () => {
  it('BITES: H6 — hint z-index is a plain integer, >= 1, and BELOW #help-overlay z-index', () => {
    const doc = parseIndexHtml();
    const hintZ = rawZIndex(doc.querySelector('#help-hint'));
    const overlayZ = rawZIndex(doc.querySelector('#help-overlay'));

    // Fail loudly when a declaration is missing — a null here would otherwise make
    // the numeric comparisons below vacuous.
    expect(
      hintZ,
      'KILLS: #help-hint with NO z-index declaration — a fixed element with auto ' +
        'stacking is painted per document order and can be covered by the canvas or ' +
        'by any later in-flow box.',
    ).not.toBeNull();
    expect(
      overlayZ,
      'KILLS: #help-overlay with NO z-index declaration — the ceiling for the hint is ' +
        'derived from the SAME document on purpose (avoids hardcoding a 5th copy of ' +
        'the modal-band constant). Absent overlay z-index also fails H7.',
    ).not.toBeNull();

    // RAW-form check FIRST: parseInt would happily accept the CSS-INVALID `5e1`/`1e2`
    // (a real browser drops the whole declaration, leaving auto stacking) and would
    // also accept `-1`. /^\d+$/ is a literal regex — no `new RegExp`.
    expect(
      hintZ !== null && /^\d+$/.test(hintZ),
      'KILLS: z-index:-1 (paints the fixed hint BEHIND in-flow boxes) and the ' +
        'CSS-invalid z-index:5e1 / z-index:1e2 (browsers drop the declaration ' +
        'entirely, but parseInt would accept it — making the test more permissive ' +
        'than the browser). Got raw z-index=' + JSON.stringify(hintZ),
    ).toBe(true);
    expect(
      overlayZ !== null && /^\d+$/.test(overlayZ),
      'KILLS: a non-integer / exponential-notation z-index on #help-overlay, which ' +
        'would make the derived ceiling meaningless. Got raw z-index=' +
        JSON.stringify(overlayZ),
    ).toBe(true);

    const hintValue = Number.parseInt(hintZ ?? '', 10);
    const overlayValue = Number.parseInt(overlayZ ?? '', 10);

    expect(
      hintValue >= 1,
      'KILLS: z-index:0 / negative stacking on #help-hint — it must be painted above ' +
        'the in-flow document. Got ' + String(hintValue),
    ).toBe(true);

    // WRONG IMPL KILLED: `z-index:9999` copy-pasted from #build-stamp. That floats the
    // hint OVER every modal overlay (shop, trade, help, PvP, battle) — a persistent
    // badge burned through open dialogs.
    expect(
      hintValue < overlayValue,
      'KILLS: a z-index copy-pasted from #build-stamp (9999) or otherwise >= the ' +
        '#help-overlay band — the persistent hint would float OVER every modal ' +
        'overlay. hint=' + String(hintValue) + ' overlay=' + String(overlayValue),
    ).toBe(true);
  });
});

describe('ux1-1 (H7): the advertised #help-overlay is actually on-screen', () => {
  it('BITES: H7 — #help-overlay has position:fixed and an integer z-index in [1, 110)', () => {
    // THE HEADLINE REGRESSION THIS KILLS.
    // Today #help-overlay is `style="display:none"` and nothing else: a STATIC,
    // IN-FLOW <div> that sits in document order AFTER #app, which PixiJS fills with a
    // canvas sized to window.innerHeight. There is no CSS file anywhere in this repo,
    // and HelpView only ever writes `style.display` — it never sets position, inset or
    // z-index. So when the user presses `?`, the overlay un-hides at document offset
    // top=724 with innerHeight=720: BELOW THE FOLD, off-screen, apparently broken.
    // ux1-1 adds a badge ADVERTISING that affordance; advertising an off-screen
    // overlay is a net-negative change, so repositioning it is part of this slice.
    // If a future edit reverts the overlay to a static in-flow div, this assertion —
    // and only this assertion — catches it.
    const doc = parseIndexHtml();
    const overlay = doc.querySelector('#help-overlay');

    expect(
      overlay,
      'KILLS: #help-overlay deleted — the `?` affordance the new hint advertises ' +
        'would have no target at all.',
    ).not.toBeNull();

    const style = normalisedStyle(overlay);
    expect(
      style.includes('position:fixed'),
      'KILLS: THE HEADLINE REGRESSION — #help-overlay left as a static in-flow div ' +
        'placed after a viewport-tall PixiJS canvas, so it un-hides BELOW THE FOLD ' +
        '(measured top=724 at innerHeight=720) and looks broken to the player the ' +
        'new hint just invited. style=' + JSON.stringify(style),
    ).toBe(true);

    const raw = rawZIndex(overlay);
    expect(
      raw !== null && /^\d+$/.test(raw),
      'KILLS: #help-overlay with a missing, negative, or CSS-invalid exponential ' +
        '(5e1 / 1e2) z-index — a fixed element with auto stacking can still be ' +
        'painted under the canvas. Got raw z-index=' + JSON.stringify(raw),
    ).toBe(true);

    const value = Number.parseInt(raw ?? '', 10);
    expect(
      value >= 1,
      'KILLS: #help-overlay stacked at 0 or below — it must paint above the in-flow ' +
        'document and the canvas. Got ' + String(value),
    ).toBe(true);
    expect(
      value < BATTLE_VIEW_Z,
      'KILLS: #help-overlay stacked at or above battleView root z-index ' +
        String(BATTLE_VIEW_Z) + ' — a battle auto-show must still supersede an open ' +
        'help overlay. Got ' + String(value),
    ).toBe(true);
  });
});
