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
// PRE-IMPL RED (historical): #help-hint did not exist and #help-overlay carried only
// `display:none`, so H1/H3/H4/H5/H6 and H7 all failed. See ADR-0151 for the full log.
//
// HONEST SCOPE LIMIT (see H5):
//   This file proves PRESENT, BODY-ANCHORED, and NOT-OBVIOUSLY-INVISIBLE.
//   It does NOT and CANNOT prove VISIBLE. happy-dom performs no layout, no
//   compositing and no viewport clipping, so a real visibility proof requires
//   client/e2e/** with Playwright's toBeInViewport() — out of this slice's
//   touch-set. H5 (hint) and H7 (overlay) are deny-lists of the cheapest
//   invisibility regressions, not visibility checks.
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
    throw new Error(`index.html could not be read at expected path: ${INDEX_HTML_PATH} — ${err}`);
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
 * True if any declaration is `banned`, or is `banned` followed by a non-numeric
 * suffix. `declarations()` has already split on `;`, so a plain `includes` would
 * never have matched across declarations — the suffix guard's REAL value is
 * catching same-property variants: `font-size:0px`, `display:none!important`,
 * `opacity:0%`. It deliberately lets a genuinely different VALUE through, so
 * `opacity:0.75` and `font-size:0.9rem` do not false-positive.
 *
 * KNOWN RESIDUAL: `opacity:0.0` / `opacity:0e0` are fully transparent yet start
 * with a numeric suffix char, so they survive this deny-list. Closing them needs
 * per-property numeric parsing; the honest catch-all is the e2e visibility proof
 * named in the HONEST SCOPE LIMIT above, not more string machinery here.
 */
function hasBannedDeclaration(decls: string[], banned: string): boolean {
  return decls.some((decl) => {
    if (decl.indexOf(banned) !== 0) return false;
    const rest = decl.slice(banned.length);
    if (rest.length === 0) return true;
    // NOTE: `%` is deliberately NOT in this allow-list — `opacity:0%` is valid CSS
    // and fully transparent, so it must be BANNED, not waved through as numeric.
    return '0123456789.'.indexOf(rest.charAt(0)) === -1;
  });
}

/** A CSS length that means "flush to this edge". */
function isZeroLength(value: string): boolean {
  return value === '0' || value === '0px';
}

/** Value of the first declaration for `property`, or null when absent. */
function declarationValue(decls: string[], property: string): string | null {
  for (const decl of decls) {
    if (decl.indexOf(`${property}:`) === 0) return decl.slice(property.length + 1);
  }
  return null;
}

/**
 * True if the declarations anchor the box to all four viewport edges — either via
 * the `inset:0` shorthand or via all four of top/right/bottom/left explicitly.
 */
function hasFourEdgeAnchor(decls: string[]): boolean {
  const inset = declarationValue(decls, 'inset');
  if (inset !== null && isZeroLength(inset)) return true;

  return ['top', 'right', 'bottom', 'left'].every((edge) => {
    const value = declarationValue(decls, edge);
    return value !== null && isZeroLength(value);
  });
}

/** Raw (unparsed) value of the `z-index` declaration, or null when absent. */
function rawZIndex(el: Element | null): string | null {
  return declarationValue(declarations(el), 'z-index');
}

// battleView's root z-index. The help overlay must sit BELOW it so a battle
// auto-show still supersedes an open help overlay (pt-c2b / ADR-0135 behaviour).
const BATTLE_VIEW_Z = 110;

// Invisibility declarations that survive a HelpView show() (which writes ONLY
// style.display). Banned on BOTH the always-on hint and the toggled overlay shell.
const PERSISTENT_INVISIBILITY_DECLARATIONS = ['visibility:hidden', 'opacity:0', 'font-size:0'];

// The hint is never toggled by any view, so display:none is fatal there too.
const HINT_BANNED_DECLARATIONS = ['display:none', ...PERSISTENT_INVISIBILITY_DECLARATIONS];

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

    // WRONG IMPL KILLED: a DUPLICATED #help-hint (two badges, duplicate id — invalid
    // HTML). querySelector returns only the FIRST match, so H1's parent check, H2b,
    // H3, H4, H5 and H6 would all inspect one of two elements and stay green while
    // the player sees a doubled badge and the second copy goes entirely unasserted.
    expect(
      doc.querySelectorAll('#help-hint').length,
      'KILLS: a duplicated #help-hint (duplicate id, invalid HTML) — every other ' +
        'assertion in this file uses querySelector and would silently inspect only ' +
        'the first of the two.',
    ).toBe(1);
  });

  it('BITES: H2 — #build-stamp is STILL a direct child of <body>', () => {
    const doc = parseIndexHtml();
    const stamp = doc.querySelector('#build-stamp');

    expect(
      stamp,
      'KILLS: #build-stamp removed from index.html — pt-a1/ADR-0128 build provenance ' +
        'pins which build a playtest finding came from.',
    ).not.toBeNull();

    // Independent anchor guard on the pt-a1/ADR-0128 provenance surface: kills a
    // future wrapper div that re-parents #build-stamp (it would inherit that
    // wrapper's display/opacity/pointer-events). The unclosed-tag kill is H2b's.
    expect(
      stamp === null ? '(no #build-stamp)' : stamp.parentElement?.tagName,
      'KILLS: #build-stamp re-parented into any wrapper instead of <body> — it would ' +
        'inherit that wrapper display/opacity/pointer-events and silently regress the ' +
        'pt-a1/ADR-0128 build-provenance surface while existence-only assertions stay ' +
        'green. (NOT the unclosed-</div> tooth — that is H2b.)',
    ).toBe('BODY');
  });

  it('BITES: H2b — #help-hint has NO element children (it is a leaf text badge)', () => {
    const doc = parseIndexHtml();
    const hint = doc.querySelector('#help-hint');

    // Precondition, NOT decoration: with the hint absent, children.length would read
    // as 0 off a null-guard and pass vacuously. Deleting the element must not satisfy
    // H2b. (H1 also covers existence; this keeps H2b self-contained.)
    expect(
      hint,
      'KILLS: a vacuously-green H2b — with #help-hint absent there are no children to ' +
        'count and the leaf assertion would pass. Deletion must not satisfy this test.',
    ).not.toBeNull();

    // WRONG IMPL KILLED: an UNCLOSED </div> on #help-hint. This is the PLACEMENT-
    // INDEPENDENT form of that tooth and is strictly stronger than any ordering-
    // dependent parent check (see the H2 scope correction above): an unclosed tag
    // swallows whatever element FOLLOWS it, so the correct invariant is stated on the
    // hint itself — "nothing may end up inside me" — rather than on one specific
    // presumed victim.
    //
    // Measured DOM shape under the mutant on the SHIPPED markup (hint is the last
    // body element, immediately before the module script):
    //   {"hintParent":"BODY","hintChildren":["SCRIPT"],"stampParent":"BODY"}
    // So today the swallowed victim is <script type="module" src="/src/main.ts">,
    // and H2's stampParent check reads BODY — green on genuinely broken markup.
    // hintChildren is ["SCRIPT"], so this assertion is RED under the mutant.
    //
    // It also bites for any FUTURE element inserted between the hint and the script:
    // that element would be swallowed AND inherit the hint's pointer-events:none plus
    // its 11px dim-grey styling — i.e. silently vanish from the UI while still being
    // found by querySelector. ux1-1 specifies a small leaf text badge; it has no
    // legitimate element children, so 0 is the correct and permanent expectation.
    const childTags = hint === null ? [] : Array.from(hint.children).map((child) => child.tagName);
    expect(
      childTags,
      'KILLS: unclosed </div> on #help-hint — the parser swallows the FOLLOWING ' +
        'element into the badge (today the module <script>; tomorrow whatever is ' +
        'inserted between them, which would also inherit pointer-events:none and the ' +
        '11px dim styling and silently vanish). ux1-1 specifies a leaf text badge, so ' +
        'it must have zero element children. Got: ' +
        JSON.stringify(childTags),
    ).toEqual([]);
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
        'read like "Press ? for controls & help". Got: ' +
        JSON.stringify(text),
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
        'style=' +
        JSON.stringify(style),
    ).toBe(true);

    // WRONG IMPL KILLED: a hint that swallows clicks in the bottom-left corner of the
    // PixiJS canvas — a fixed overlay without pointer-events:none is a click-eater.
    expect(
      style.includes('pointer-events:none'),
      'KILLS: a fixed #help-hint WITHOUT pointer-events:none — it eats canvas clicks ' +
        'in the bottom-left corner. style=' +
        JSON.stringify(style),
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

    for (const banned of HINT_BANNED_DECLARATIONS) {
      // `opacity:0` must NOT match `opacity:0.75` — hasBannedDeclaration requires the
      // declaration to end (or continue with a non-numeric suffix like !important).
      expect(
        hasBannedDeclaration(decls, banned),
        'KILLS: #help-hint styled with "' +
          banned +
          '" — the hint would ship but ' +
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
        'than the browser). Got raw z-index=' +
        JSON.stringify(hintZ),
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
        'the in-flow document. Got ' +
        String(hintValue),
    ).toBe(true);

    // WRONG IMPL KILLED: `z-index:9999` copy-pasted from #build-stamp. That floats the
    // hint OVER every modal overlay (shop, trade, help, PvP, battle) — a persistent
    // badge burned through open dialogs.
    expect(
      hintValue < overlayValue,
      'KILLS: a z-index copy-pasted from #build-stamp (9999) or otherwise >= the ' +
        '#help-overlay band — the persistent hint would float OVER every modal ' +
        'overlay. hint=' +
        String(hintValue) +
        ' overlay=' +
        String(overlayValue),
    ).toBe(true);
  });
});

describe('ux1-1 (H7): the advertised #help-overlay is actually on-screen', () => {
  it('BITES: H7 — #help-overlay is viewport-anchored (position:fixed + four edges), default-hidden, integer z-index in [1, 110), and not persistently invisible', () => {
    // THE HEADLINE REGRESSION THIS KILLS.
    // Pre-slice, #help-overlay was `style="display:none"` and nothing else: a STATIC,
    // IN-FLOW <div> sitting in document order AFTER #app, which PixiJS fills with a
    // canvas sized to window.innerHeight. There is no CSS file anywhere in this repo,
    // and HelpView only ever reads/writes `style.display` — it never sets position,
    // inset or z-index. So pressing `?` un-hid the overlay at document offset top=724
    // with innerHeight=720: BELOW THE FOLD, apparently broken. ux1-1 adds a badge
    // ADVERTISING that affordance, so advertising an off-screen overlay would be a
    // net-negative change — repositioning it is part of this slice, and every
    // declaration that makes it reachable is therefore load-bearing here.
    //
    // POSITION AND ANCHORING ARE TWO SEPARATE TEETH (measured, red-team):
    // `position:fixed` ALONE is not enough. With all four offsets `auto`, a fixed box
    // lays out at its STATIC position — real-Chromium {top: 720, inViewport: false} at
    // innerHeight=720 — and because it is now FIXED it no longer contributes to
    // docScrollHeight (stays 720), so the page is not even scrollable. The overlay
    // becomes PERMANENTLY UNREACHABLE: strictly worse than the pre-slice bug, which
    // at least let you scroll down to it. Hence the four-edge anchor assertion below.
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
        'new hint just invited. style=' +
        JSON.stringify(style),
    ).toBe(true);

    const overlayDecls = declarations(overlay);

    // WRONG IMPL KILLED: `inset:0` deleted while position:fixed;z-index:100 stay — the
    // mutant that survived the first eight assertions. See the measured layout note in
    // this test's header comment.
    expect(
      hasFourEdgeAnchor(overlayDecls),
      'KILLS: #help-overlay with position:fixed but NO edge anchoring (inset:0 deleted, ' +
        'or fewer than all four of top/right/bottom/left:0) — with all offsets auto the ' +
        'fixed box lays out at its STATIC position: measured real-Chromium top=720 at ' +
        'innerHeight=720, inViewport=false, and docScrollHeight stays 720 so the page ' +
        'cannot even be scrolled to it. PERMANENTLY UNREACHABLE — strictly worse than ' +
        'the pre-slice below-the-fold bug. decls=' +
        JSON.stringify(overlayDecls),
    ).toBe(true);

    // WRONG IMPL KILLED: `display:none` deleted from the shell. Nothing else in the
    // repo pins this — helpView.test.ts uses a hand-written fixture, no eval reads
    // index.html, and this file is its only vitest reader. The slice itself RAISED the
    // severity of that untested invariant (the shell is now a full-viewport opaque
    // z-index:100 panel), so pinning it belongs here.
    expect(
      overlayDecls.includes('display:none'),
      'KILLS: #help-overlay shipping WITHOUT display:none — post-slice the client boots ' +
        'straight into a full-viewport opaque z-index:100 panel. Worse, HelpView.visible ' +
        'is `style.display !== "none"`, so it reads TRUE at boot and main.ts suppresses ' +
        'ALL movement and ALL 13 overlay hotkeys: an unrecoverable boot-time soft-lock. ' +
        'decls=' +
        JSON.stringify(overlayDecls),
    ).toBe(true);

    // WRONG IMPL KILLED: a PERSISTENT invisibility declaration on the shell. HelpView
    // toggles ONLY `style.display`, so anything in this list survives show() and makes
    // it a silent no-op — the badge advertises a key that visibly does nothing.
    // NOTE: `display:none` is deliberately NOT in this list (it is the REQUIRED default
    // asserted just above); the coordinator's "reuse the same four" would have
    // contradicted that. These three are exactly the ones show() cannot clear.
    for (const banned of PERSISTENT_INVISIBILITY_DECLARATIONS) {
      expect(
        hasBannedDeclaration(overlayDecls, banned),
        'KILLS: #help-overlay carrying "' +
          banned +
          '" — HelpView.show() only clears style.display, so this survives the toggle ' +
          'and makes pressing `?` a visible no-op. decls=' +
          JSON.stringify(overlayDecls),
      ).toBe(false);
    }

    const raw = rawZIndex(overlay);
    expect(
      raw !== null && /^\d+$/.test(raw),
      'KILLS: #help-overlay with a missing, negative, or CSS-invalid exponential ' +
        '(5e1 / 1e2) z-index — a fixed element with auto stacking can still be ' +
        'painted under the canvas. Got raw z-index=' +
        JSON.stringify(raw),
    ).toBe(true);

    const value = Number.parseInt(raw ?? '', 10);
    expect(
      value >= 1,
      'KILLS: #help-overlay stacked at 0 or below — it must paint above the in-flow ' +
        'document and the canvas. Got ' +
        String(value),
    ).toBe(true);
    expect(
      value < BATTLE_VIEW_Z,
      'KILLS: #help-overlay stacked at or above battleView root z-index ' +
        String(BATTLE_VIEW_Z) +
        ' — a battle auto-show must still supersede an open ' +
        'help overlay. Got ' +
        String(value),
    ).toBe(true);
  });
});
