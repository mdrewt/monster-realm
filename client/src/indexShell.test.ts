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

// ---------------------------------------------------------------------------
// m23-s2 CORRECTION (2026-08-24) — "there is no CSS file anywhere in this repo"
// is now FALSE IN LETTER and PRESERVED IN SUBSTANCE. Read this before trusting
// any of the five sites below.
//
// M23 slice S2 introduces the repo's FIRST stylesheet, `client/src/styles.css`,
// loaded by a `<link rel="stylesheet" href="/src/styles.css">` in <head> (tooth
// A8). So the literal premise is retired. What the premise was PROTECTING is
// not: criterion A11Y-12 (spec §2.7, `[A11Y-07]`) forbids `styles.css` from
// declaring ANY `#id` selector, so no rule in it can reach #help-overlay,
// #help-hint or #build-stamp. Their inline `style` attribute therefore remains
// their COMPLETE styling contract and stays legitimately assertable as text —
// exactly as H4b/H5/H6/H7 below assume.
//
// That is a mechanical guarantee, not a convention: tooth A6 (`findIdSelectors`
// over the real `client/src/styles.css`, plus its CONTROL probe) is what makes
// it so. If someone adds `#help-overlay{position:static}` to the stylesheet,
// A6b reds before H7 can be silently satisfied or defeated by it.
//
// ALL FIVE SITES CARRYING THE STALE CLAIM (enumerated so a later reader does
// not conclude from one message that the repo still has no CSS):
// CITED BY SYMBOL AND QUOTED TEXT, DELIBERATELY NOT BY LINE NUMBER. Inserting this block
// above the imports moved every line below it by 41, and a first draft of this very list
// cited the pre-insert numbering — the repo's own "citations drift on header insert" lesson,
// self-inflicted inside the commit that quotes it. A name and a quoted fragment do not drift,
// so `grep` for the quoted text to find each site:
//   1. this file, the WHY-THIS-READS-THE-REAL-FILE header — grep
//      "There is no CSS file anywhere in this repo; all".
//   2. this file, inside `BITES: H4b` — "there is no CSS file in this repo, so" (twice: the
//      "no inline style at all" message, and the static/in-flow WRONG-IMPL note).
//   3. this file, inside `BITES: H5` — "there is no CSS file in this".
//   4. this file, inside `BITES: H7` — "There is no CSS file anywhere in this repo".
//   5. client/src/main.wiring.test.ts, `bodyDivs()`'s doc comment — OUTSIDE this slice's
//      touches: set, so it is flagged, not edited. S5 also edits client/index.html and is
//      the natural place to correct it.
// NONE of them is edited. m23-s2 is APPEND-ONLY on this file (its `touches:`
// rule and the slice plan's named anti-pattern), and :4656 is in a file outside
// this slice's `touches:` set. NO ASSERTION BREAKS as a result: every one of
// those five is prose or an operator-facing message, never a predicate.
//
// ONE NARRATION DRIFT, recorded rather than fixed: `BITES: H2b`'s MEASURED note says
// "today the swallowed victim is <script type=module>". After
// m23-s2, `#a11y-live` is the last <body> element before that script, so an
// unclosed </div> on #help-hint now swallows `#a11y-live` instead. The tooth
// still bites — it asserts the hint has ZERO element children, which is
// victim-independent by construction, which is the whole point of that note —
// only the measured example drifted.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as rb12CssStripperOracle from '../../evals/a11y-static-shell.eval.mjs';
// ADR-0215: the SOLE owner of the CSS comment stripper. Deliberately a SECOND, dedicated,
// SINGLE-LINE named import rather than being folded into the namespace import above — RB12-G1
// requires exactly one line that starts with `import` and names the symbol, and a combined named
// import of all five corpus symbols would exceed the line width and be wrapped by Biome.
import { stripCssComments } from '../../evals/a11y-static-shell.eval.mjs';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './ui/overlayRegistry';

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
  it('BITES: H4b — #help-hint is fixed, deliberately clickable, and its pointer surface is BOUNDED', () => {
    // SLICE: uxd3-b   ADR: 0163 D4 (an AMENDMENT to ADR-0151 D2)   EARS criterion: AC-12
    //
    // REPLACES H4 ("position:fixed AND pointer-events:none") IN PLACE. AC-12 makes the badge
    // the click front door for the main menu, so the badge MUST receive pointer events and
    // H4's blanket `pointer-events:none` ban is no longer a satisfiable invariant.
    //
    // HONESTY — H4b IS NOT STRICTLY STRONGER THAN H4 on the click-eating axis, and this must
    // not be narrated as an upgrade. H4 forbade the badge from consuming ANY click; H4b
    // permits exactly that and instead BOUNDS the surface it can consume. What H4b buys back:
    // four assertions H4 never made (explicit pointer-events:auto, width:max-content, at most
    // one horizontal edge, and a property allow-list) plus the launcher-attribute pin. What is
    // genuinely given up: the guarantee that a bottom-left click always reaches whatever is
    // under the badge. Recorded as an amendment to ADR-0151 D2, NOT as a silent test edit.
    //
    // SCOPE OF THE RESIDUAL, stated precisely (an earlier draft said "latent, not live" and was
    // too narrow — code review caught it). Two distinct exposures:
    //   (a) bare CANVAS clicks — genuinely latent: nothing in the client handles one today (the
    //       document click listener matches only [data-shop-id] / [data-choice-idx] /
    //       [data-menu-launcher]). It goes live the day click-to-move ships.
    //   (b) OVERLAY BUTTONS — live in principle, not latent: nine overlay shells in index.html
    //       are unpositioned in-flow divs that render BELOW the viewport-tall canvas, so when one
    //       is shown the page scrolls and this fixed badge floats over whatever lands in the
    //       bottom-left ~250x15px band. Buttons there ([data-shop-id], the trade/pvp/box/rename
    //       controls) can be occluded, and the launcher branch's unconditional `return;` swallows
    //       the click even when its guard denies. MEASURED: the full Playwright suite is green
    //       against this markup (44 passed / 1 skipped), so no shipped flow hits it — but that is
    //       a measurement, not a proof. ADR-0163 D4 records it, with the two escape routes
    //       (move the badge to a corner no in-flow shell occupies, or give the shells the
    //       position:fixed treatment #help-overlay already has) reserved for uxd3-c.
    //
    // RED AT AUTHORING TIME: client/index.html:114-119 still ships `pointer-events:none`, no
    // `data-menu-launcher` attribute and no `width:max-content`, so assertions 2, 3 and 6 all
    // fail on the current markup. Assertion 1 (position:fixed) is green today and is carried
    // over from H4 verbatim as a regression guard.
    //
    // WRONG IMPL KILLED (1): a static/in-flow hint — H4's kill, carried over verbatim.
    // WRONG IMPL KILLED (2): flipping the branch to a click front door and FORGETTING the
    //   markup half. `pointer-events:none` left in place makes the badge un-clickable, so
    //   AC-12 ships as a dead feature that no unit test can otherwise see (happy-dom performs
    //   no hit-testing, and main.ts is coverage-excluded). Asserting `:auto` EXPLICITLY rather
    //   than "`:none` is absent" also kills deleting the declaration entirely — the property
    //   is inherited, and a future `pointer-events:none` on a wrapper would silently win.
    // WRONG IMPL KILLED (3): a badge that grows into a full-width click-eating strip. Each of
    //   these keeps `position:fixed` + one horizontal edge and still swallows the whole
    //   viewport bottom (or the whole viewport): `width:100%`, `left:6px;right:6px`,
    //   `padding:0 50vw`, `min-width:100vw`, `height:100vh`, `inset:auto 0 16px 0`,
    //   `transform:scale(40)`, `zoom:40`, `border:50vw solid transparent`, `scale:40`.
    //   `width:max-content` + at-most-one-horizontal-edge + a PROPERTY ALLOW-LIST is what closes
    //   all ten — a deny-list of growth knobs was measured unclosable (the last three survived it).
    // WRONG IMPL KILLED (4): binding the click by ELEMENT ID instead of the attribute. Without
    //   `data-menu-launcher` in the markup, main.ts's delegated branch matches nothing and the
    //   badge is decorative — while W-UXD3B-LAUNCHER-BRANCH-IS-READ-ONLY (which scans main.ts,
    //   not index.html) stays green. This is the markup half of that pair.
    // WRONG IMPL KILLED (5): a SECOND element carrying `data-menu-launcher` (the natural way to
    //   "add a real button" later). Two launchers is the always-on rail the spec rejects, and
    //   W-ONE-CORNER-AFFORDANCE only sees `position:fixed` divs — an inline <span> launcher
    //   inside #app is invisible to it and caught only here.
    //
    // DELIBERATELY NOT ASSERTED: `cursor:pointer`. No EARS criterion asks for it, and
    // discoverability is already carried by the hint TEXT, which H3 pins. It stays in the
    // markup as good practice; pinning it here would be inventing a requirement.
    const doc = parseIndexHtml();
    const hint = doc.querySelector('#help-hint');

    // ANTI-VACUITY, ASSERTED FIRST (this file's house rule): with #help-hint absent,
    // normalisedStyle() returns '' and declarations() returns [], so EVERY deny-list clause
    // and every "at most one" clause below passes vacuously. Deleting the element must never
    // be a way to satisfy H4b.
    expect(
      hint,
      'KILLS: a vacuously-green H4b — with #help-hint absent the style string is empty and ' +
        'every bounded-surface clause below passes. Deleting the element must not satisfy ' +
        'this test.',
    ).not.toBeNull();

    const style = normalisedStyle(hint);
    const decls = declarations(hint);
    expect(
      decls.length > 0,
      'KILLS: #help-hint with no inline style at all — there is no CSS file in this repo, so ' +
        'an unstyled hint is an unpositioned in-flow div AND an unbounded one. Every ' +
        'assertion below would be judging an empty string.',
    ).toBe(true);

    // (1) CARRIED OVER FROM H4, VERBATIM.
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

    // (2) The badge must be clickable AT ALL — the one thing a layout-free happy-dom test can
    // still say about AC-12's front door.
    expect(
      style.includes('pointer-events:auto'),
      'KILLS: AC-12 shipped as a DEAD BUTTON — #help-hint still carrying (or inheriting) ' +
        'pointer-events:none while main.ts binds a delegated click branch to it. Asserted as ' +
        'the EXPLICIT `pointer-events:auto` declaration, not as "`:none` is absent": the ' +
        'property inherits, so an omitted declaration is not the same as an opted-in one. ' +
        'style=' +
        JSON.stringify(style),
    ).toBe(true);

    // (3) The width bound: shrink-to-fit, never a strip.
    expect(
      style.includes('width:max-content'),
      'KILLS: a clickable #help-hint with an UNBOUNDED width. `width:100%` (or an author-set ' +
        'width in vw) turns a one-line badge into a full-width bar across the bottom of the ' +
        'PixiJS canvas that eats every click in that band. width:max-content is the explicit ' +
        "bound that replaces H4's retired blanket pointer-events:none ban. style=" +
        JSON.stringify(style),
    ).toBe(true);

    // (4) The horizontal bound: anchored to ONE edge, so it cannot be stretched between two.
    // Tested as DECLARATION STARTS (declarationValue matches `left:` only at index 0 of a
    // declaration) so `padding-left:` cannot false-positive as a horizontal anchor.
    expect(
      declarationValue(decls, 'bottom') !== null,
      'KILLS: #help-hint that lost its `bottom:` anchor — a fixed box with all offsets auto ' +
        'lays out at its STATIC position (the measured H7 failure mode) and, at bottom:2px, ' +
        'would also collide with #build-stamp. decls=' +
        JSON.stringify(decls),
    ).toBe(true);
    const horizontalEdges = ['left', 'right'].filter(
      (edge) => declarationValue(decls, edge) !== null,
    );
    expect(
      horizontalEdges.length,
      'KILLS: #help-hint anchored to BOTH horizontal edges (`left:6px;right:6px`) — that ' +
        'stretches the box across the full viewport width regardless of width:max-content, ' +
        'recreating the full-width click-eating strip. Exactly one horizontal anchor is ' +
        'allowed. Found: ' +
        JSON.stringify(horizontalEdges) +
        ' decls=' +
        JSON.stringify(decls),
    ).toBeLessThanOrEqual(1);

    // (5) BOUNDED SURFACE — a PROPERTY ALLOW-LIST, not a deny-list of growth knobs.
    // A deny-list here was MEASURED unclosable (red-team F8): `zoom:40`, `border:50vw solid
    // transparent` and `scale:40` (the modern individual transform property, which the
    // `transform` shorthand needle does not match) each kept `width:max-content` plus a single
    // horizontal edge and still grew the HIT BOX to viewport scale — all three green against a
    // six-entry deny-list. An allow-list is closed by construction: any property not named here
    // fails, including ones invented after this test was written. This mirrors the reasoning
    // W-UXD3B-LAUNCHER-BRANCH-IS-READ-ONLY uses for its method allow-list, applied consistently.
    // Widening it is a deliberate act that must re-argue the bounded-surface claim, which is the
    // whole justification for retiring H4's blanket pointer-events:none ban (ADR-0151 D2, amended
    // by ADR-0163 D4).
    // m23-s5 (ADR-0206 D5, amending ADR-0151 D2 / ADR-0163 D4): #help-hint becomes a native
    // <button>, which needs THREE more declarations to neutralise UA button chrome
    // (`background:none;border:0;padding:0`) — without them the badge ships as a grey OS
    // button with #9aa0b4 text on ButtonFace (~2:1 contrast), a regression in an
    // ACCESSIBILITY slice. `background` is allowed OUTRIGHT (it cannot change the hit box,
    // only its paint). `border` and `padding` are this test's OWN named growth knobs two
    // paragraphs up (`border:50vw solid transparent`, `padding:0 50vw`), so each gets a
    // VALUE CLAUSE below rather than a blanket allow — `border:50vw solid transparent` and
    // `padding:0 50vw` still fail after this re-pin. Strictly narrower than adding the bare
    // names would be.
    const BOUNDED_SURFACE_ALLOWED_PROPS = [
      'position',
      'bottom',
      'left',
      'width',
      'font',
      'color',
      'pointer-events',
      'cursor',
      'z-index',
      'background',
      'border',
      'padding',
    ];
    const declaredProps = style
      .split(';')
      .map((d) => d.slice(0, d.indexOf(':')).trim())
      .filter((name) => name.length > 0);
    // ANTI-VACUITY: a mangled style attribute that parses to zero properties would satisfy a
    // subset check trivially. The shipped badge declares twelve after the button conversion.
    expect(
      declaredProps.length,
      'ANTI-VACUITY: #help-hint must declare a real inline style — parsing yielded no ' +
        'properties, so the allow-list below would pass on garbage. style=' +
        JSON.stringify(style),
    ).toBeGreaterThanOrEqual(5);
    for (const banned of declaredProps.filter(
      (name) => !BOUNDED_SURFACE_ALLOWED_PROPS.includes(name),
    )) {
      expect(
        banned,
        'KILLS: #help-hint grown into a click-eater via the un-allow-listed property "' +
          banned +
          '". `padding:0 50vw`, `min-width:100vw`, `height:100vh`, `inset:auto 0 16px 0`, ' +
          '`transform:scale(40)`, `zoom:40`, `border:50vw solid transparent` and `scale:40` all ' +
          'keep `width:max-content` plus a single horizontal edge and still swallow most of the ' +
          "viewport. The BOUNDED surface is the whole justification for retiring H4's blanket " +
          'pointer-events:none ban, so the property set is allow-listed: ' +
          JSON.stringify(BOUNDED_SURFACE_ALLOWED_PROPS) +
          '. style=' +
          JSON.stringify(style),
      ).toBe('<not reached — property is not on the allow-list>');
    }

    // (5b) VALUE-CONSTRAINED allow-list entries (m23-s5, plan-lens adjudication A4). `border`
    // and `padding` are allow-listed by NAME above but bounded by VALUE here — a name-only
    // allow would let `border:50vw solid transparent` / `padding:0 50vw` back in unchanged.
    const borderValue = declarationValue(decls, 'border');
    if (borderValue !== null) {
      expect(
        borderValue === '0' || borderValue === 'none',
        "KILLS: 'border' declared with a value OTHER than '0' or 'none' — " +
          '`border:50vw solid transparent` keeps every allow-listed property NAME while ' +
          'growing the hit box to viewport scale. Got: ' +
          JSON.stringify(borderValue),
      ).toBe(true);
    }
    const paddingValue = declarationValue(decls, 'padding');
    if (paddingValue !== null) {
      expect(
        paddingValue === '0',
        "KILLS: 'padding' declared with a value other than '0' — `padding:0 50vw` keeps " +
          'every allow-listed property NAME while growing the hit box to viewport scale. ' +
          'Got: ' +
          JSON.stringify(paddingValue),
      ).toBe(true);
    }

    // (5c) A4 (red-team #2, HIGH): 'font' was ALREADY allow-listed with NO value constraint —
    // a PRE-EXISTING HOLE this slice's <button> conversion makes exploitable. Closed here,
    // not narrated as new: `font:900px/1 monospace` keeps `width:max-content`, one
    // horizontal edge, and every allow-listed property NAME, yet renders the badge as a
    // giant click-eating strip — exactly the regression H4/H4b exist to prevent. The value
    // pin is the space-STRIPPED form (see this patch file's header note).
    const fontValue = declarationValue(decls, 'font');
    expect(
      fontValue,
      "KILLS: #help-hint with no 'font' declaration at all — falls back to the UA default " +
        'font (unpredictable size/metrics, defeating the width:max-content bound)',
    ).not.toBeNull();
    expect(
      fontValue,
      "KILLS: 'font' declared with ANY value other than the shipped literal — " +
        '`font:900px/1 monospace` keeps every allow-listed property NAME while rendering the ' +
        'badge as a giant click-eating strip. Got: ' +
        JSON.stringify(fontValue),
    ).toBe('11px/1.3monospace');

    // (6) The markup half of the AC-12 front door.
    expect(
      hint === null ? false : hint.hasAttribute('data-menu-launcher'),
      'KILLS: AC-12 wired in main.ts but NOT in the markup — the delegated ' +
        '[data-menu-launcher] branch would match nothing and the badge would be decorative, ' +
        'while the main.ts-side tooth stays green. The attribute (not the id) is the binding ' +
        'contract: it is what lets main.ts stay a non-owner of #help-hint ' +
        '(W-UX1-HINT-NO-JS-OWNER, ADR-0151 D2).',
    ).toBe(true);
    expect(
      doc.querySelectorAll('[data-menu-launcher]').length,
      'KILLS: a SECOND element carrying data-menu-launcher — two competing always-on menu ' +
        'affordances is the rail AC-12 exists to forbid, and W-ONE-CORNER-AFFORDANCE only ' +
        'inspects position:fixed <body> divs, so an inline launcher elsewhere in the document ' +
        'is invisible to it and caught only here.',
    ).toBe(1);
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

/**
 * HERMETICITY GUARD — module scope on purpose, so it runs at import time, before ANY
 * test body in this file (including the pre-existing ux1 teeth above).
 *
 * m23-s2 adds `<link rel="stylesheet" href="/src/styles.css">` to the real
 * `client/index.html`. happy-dom honours that link on parse: it resolves the href against
 * the document URL and issues a REAL `fetch()` to `http://localhost:3000/src/styles.css`.
 * With nothing listening that is only stderr noise, but it makes a suite the repo
 * guarantees is "fast, hermetic and server-free" (spec §5.7) depend on what happens to be
 * bound to a port — and if something IS listening, every `parseIndexHtml()` above silently
 * loads a foreign stylesheet into the document under assertion.
 *
 * Disabling the fetch loses nothing: no assertion in this file, old or new, reads a
 * COMPUTED style. They read the inline `style` ATTRIBUTE as text (the file's own documented
 * premise) or read `styles.css` from disk via `readStylesCss()`. `A8` still sees the
 * `<link>` element itself, which is a parsed DOM node either way.
 */
const happyDomSettings = (
  window as unknown as {
    happyDOM?: {
      settings?: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean };
    };
  }
).happyDOM?.settings;
// OPTIONAL, not asserted: these are happy-dom INTERNALS, and an upgrade that moves them must
// produce a clear failure, not twenty tests reding at module scope with a message about
// `undefined`. If the settings object ever disappears the only consequence is the stderr
// noise below returning — which is visible, and which no assertion depends on.
if (happyDomSettings !== undefined) {
  happyDomSettings.disableCSSFileLoading = true;
  // ...and treat the disabled load as a SUCCESS rather than a NotSupportedError. Without this,
  // happy-dom emits a DOMException stack trace on every single parse of index.html — over twenty
  // of them per `just ci` run, in a suite that is otherwise silent. Noise that is normal is noise
  // nobody reads, which is how a real error hides.
  happyDomSettings.handleDisabledFileLoadingAsSuccess = true;
}

// ===========================================================================
// m23-s2 (M23 accessibility — slice S2). APPENDED BLOCK. Nothing above this
// line is edited: not an assertion, not a helper, not a comment. See the
// m23-s2 CORRECTION note in this file's header for the one premise that moved.
//
// SLICE: m23-s2   ADR: 0205 (from m23-s0; no new ADR)
// Spec: M23-accessibility.spec.md §2.4 / §2.7 / §2.8 / §5.2 / §6
// Criteria: A11Y-10 (D1), A11Y-13 static half (D2), ADR-0205 D1/D2 plus the
// A11Y-26 forward-guard (D3), A11Y-12 (D4), A11Y-11 (D5), the load path (D6).
//
// NO `new RegExp(...)` here either — this file's repo-wide rule at :33-:34
// holds. Every match below is String.indexOf/.includes/.split/.startsWith/
// .endsWith, a hand-written character walker, or the literal regex /^-?\d+$/.
//
// THIS BLOCK CONTAINS NO UNPAIRED CSS-COMMENT DELIMITER. The two-character
// sequences that open and close a CSS comment are ASSEMBLED (see SLASH_STAR /
// STAR_SLASH below) rather than written literally, so no current-or-future
// source scan that strips comments with a naive matcher can be derailed by a
// fixture in here. Prose below therefore says "the comment opener" where it
// means those two characters.
// ===========================================================================

// ---------------------------------------------------------------------------
// m23-s2 SHARED: reading the repo's first stylesheet
// ---------------------------------------------------------------------------

/** The repo's FIRST stylesheet (m23-s2, spec §2.7). Path resolved from import.meta.url
 *  exactly as `INDEX_HTML_PATH` above is, so it is cwd-independent. Cited by SYMBOL, not by
 *  line: this block was inserted above the imports, and every line citation written against
 *  the pre-insert numbering was wrong by 41. */
const STYLES_CSS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css');

/** Loud-throwing reader, mirroring `readIndexHtml()` above (cited by symbol, not line). Deliberately NOT a
 *  `?? ''` fallback: a missing stylesheet must be a RED, never a scanner that cheerfully
 *  reports "zero id selectors" and "no banned declaration" over an empty string. */
function readStylesCss(): string {
  try {
    return readFileSync(STYLES_CSS_PATH, 'utf8');
  } catch (err) {
    throw new Error(`styles.css could not be read at expected path: ${STYLES_CSS_PATH} — ${err}`);
  }
}

/** An element's id for a failure message — never for a lookup. */
function elementId(el: Element | null): string {
  if (el === null) return '(none)';
  return el.getAttribute('id') ?? '(no id)';
}

// ---------------------------------------------------------------------------
// m23-s2 SHARED: the CSS rule walker — ONE scanner, TWO consumers (plan D-f)
//
// findIdSelectors (A11Y-12) and srOnlyIsAccessible (A11Y-11) both layer on
// parseCssRules. Two independent notions of "what is a rule" would drift, and the
// drift would be invisible: each tooth would keep passing against its own idea of
// the file.
// ---------------------------------------------------------------------------

/** The two characters that OPEN a CSS comment, assembled (see the block header). */
const SLASH_STAR = ['/', '*'].join('');
/** The two characters that CLOSE a CSS comment, assembled (see the block header). */
const STAR_SLASH = ['*', '/'].join('');

// THE WHOLE CSS ORACLE — the comment strip, `parseCssRules`, `findIdSelectors` and
// `srOnlyIsAccessible` — is no longer defined here. ADR-0215 made
// `evals/a11y-static-shell.eval.mjs` the SOLE OWNER of the comment stripper; rb-15
// (R-m23-s10-X18) applied the same ruling to the rest, so THAT module is now the oracle's only
// home and this file reaches every symbol through the `rb12CssStripperOracle` namespace import.
// A `.mjs` eval cannot import a `.ts` vitest file, so this is the one direction that yields a
// single owner — and it is what finally lets the nightly `just a11y-e2e` tier RUN these checks
// instead of grepping this file for `const` + `function` + the symbol name. RB15-G1/RB15-G4
// below make a second copy, by any shape or any route, a hard RED.
//
// (Historically, on the stripper alone: this file imports it (see the import at the top) so there is no second copy left to drift. Its semantics are unchanged
// from the copy deleted here: a four-state lexer (normal/dq/sq/comment), backslash escapes inside
// strings, newlines preserved inside comments, and a THROW on an unterminated string or comment at
// EOF — a file we could not parse must never be reported as a clean file. The shared
// CSS_STRIPPER_CORPUS (RB12-G2) and ID_SELECTOR_FIXTURES / SR_ONLY_FIXTURES (RB15-G2) are what
// make that paragraph a test rather than a claim.)

/**
 * The ids whose INLINE styling is pinned BY TEXT elsewhere in this repo, and which a rule
 * in `styles.css` must therefore never reach: `#help-overlay`/`#help-hint`/`#build-stamp`
 * (this file's H4b/H5/H6/H7 and `main.wiring.test.ts`'s `W-ONE-CORNER-AFFORDANCE`),
 * `#menu-overlay` (the same viewport-anchoring contract, ADR-0163), and `#a11y-live` (whose
 * `.sr-only` hiding A11Y-11 gates).
 */
const CASCADE_PINNED_IDS: readonly string[] = [
  'help-overlay',
  'help-hint',
  'build-stamp',
  'menu-overlay',
  'a11y-live',
];

/** Selector constructs that reach an arbitrary element WITHOUT naming it. */
const POSITIONAL_SELECTOR_TOKENS: readonly string[] = [
  'nth-child',
  'nth-of-type',
  'nth-last-child',
  'nth-last-of-type',
];

/**
 * [A11Y-07], the REACHABILITY half — preludes that reach a pinned id without spelling `#`.
 *
 * WHY THIS EXISTS AS A SECOND FUNCTION. `findIdSelectors` implements criterion A11Y-12
 * LITERALLY: "zero `#id` selectors". Red-team measured that the literal reading is not the
 * PROPERTY. This stylesheet contains no `#`, is biome-clean, leaves `findIdSelectors`
 * returning `[]`, and made the whole 203-test suite pass:
 *
 *     [id="help-overlay"] { visibility: hidden; }
 *     [id="help-hint"]    { opacity: 0; }
 *     [id="a11y-live"]    { display: none; }
 *
 * In Chromium that hides the help overlay, blanks the persistent corner affordance ux1-1
 * ships, and removes the live region from the accessibility tree — every consequence
 * A11Y-12, ux1-1 and A11Y-11 exist to prevent, with every tooth green. Also measured green:
 * `[id^="help-"]`, `div[id*=help]`, `:where([id='help-hint'])`,
 * `body > div:nth-child(11) { position: static !important }` and `* { position: static
 * !important }` — the last three reproducing ADR-0151 D1's exact below-the-fold regression
 * (`rect.top` 0 → 720 at a 720px viewport) with H6 and H7 still passing.
 *
 * DECLARED RESIDUAL — this is a SHAPE oracle, not a CASCADE oracle. It bans naming a pinned
 * id in any form, plus the two constructs that reach an element without naming it (`*` and
 * the positional pseudos). A sufficiently indirect selector (`body > div:last-of-type ~ div`,
 * say) still escapes it. The airtight oracle is a real browser cascade check — load
 * `index.html`, apply the sheet, and read `getComputedStyle` — which needs Playwright (already
 * a devDependency) and belongs with S10's `evals/a11y-static-shell.eval.mjs`, not in the
 * hermetic vitest suite. Recorded as residual R-m23-s2-X3.
 */
function findCascadeReachingSelectors(src: string): string[] {
  const offenders: string[] = [];
  for (const rule of rb12CssStripperOracle.parseCssRules(src)) {
    const prelude = rule.prelude.toLowerCase();
    const namesPinnedId = CASCADE_PINNED_IDS.some((id) => prelude.includes(id));
    const isUniversal = prelude.split('(').join(' ').split(' ').includes('*');
    const isPositional = POSITIONAL_SELECTOR_TOKENS.some((t) => prelude.includes(t));
    if (namesPinnedId || isUniversal || isPositional) offenders.push(rule.prelude);
  }
  return offenders;
}

/**
 * [A11Y-07], the SURFACE half — `styles.css` is not the only place a rule can enter.
 *
 * Red-team measured that `@import url("/src/theme.css")` at the top of `styles.css` ships
 * LITERAL `#help-overlay{position:static!important}` rules from a file no tooth reads:
 * `parseCssRules` classifies the `@import` prelude as an at-rule and never inspects it, and
 * A8's "exactly one stylesheet link" counts `<link>` elements, not CSS-level imports.
 * Banning the construct is right on its own merits too — spec §2.7 decided on exactly ONE
 * css file, and `@import` is a second one with an extra round-trip.
 */
function importsAnotherStylesheet(src: string): boolean {
  return stripCssComments(src).toLowerCase().includes('@import');
}

// ---------------------------------------------------------------------------
// m23-s2 SHARED: the `.sr-only` semantic oracle (A11Y-11 / [A11Y-06])
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// m23-s2 SHARED: deriving the static overlay shells from OVERLAY_A11Y
// ---------------------------------------------------------------------------

/** Ancestor-or-self `<div>` whose parent is `<body>` — i.e. exactly what
 *  `closest('body > div')` means (plan D-e), written as an explicit walk so the
 *  derivation does not depend on the DOM engine's combinator support inside `closest()`,
 *  which nothing else in this repo exercises. */
function closestBodyDiv(el: Element | null): Element | null {
  let node: Element | null = el;
  while (node !== null) {
    const parent: Element | null = node.parentElement;
    if (node.tagName === 'DIV' && parent !== null && parent.tagName === 'BODY') return node;
    node = parent;
  }
  return null;
}

interface DerivedShell {
  readonly id: OverlayId;
  readonly anchor: Element;
  readonly root: Element | null;
}

/**
 * The STATIC shells, DERIVED and never mapped (plan D-e; ADR-0205 D1 forbids a second
 * SSOT). Resolve each of the seventeen `OVERLAY_A11Y[id].initialFocusSelector` against the
 * real client/index.html; the ids whose anchor RESOLVES are the static shells. The
 * irregular ids are exactly why nothing textual is used: no string rule maps `pvpView`
 * to `#pvp-challenge-overlay`.
 */
function deriveStaticShells(doc: Document): DerivedShell[] {
  const shells: DerivedShell[] = [];
  for (const id of OVERLAY_IDS) {
    const anchor = doc.querySelector(OVERLAY_A11Y[id].initialFocusSelector);
    if (anchor === null) continue;
    shells.push({ id, anchor, root: closestBodyDiv(anchor) });
  }
  return shells;
}

/** The five overlays whose shells are CONSTRUCTED at runtime (S4's), so their anchors
 *  cannot resolve against static markup. Hard-coded on purpose: a complement derived from
 *  the very resolution it is checking would simply shrink and stay green. */
const CONSTRUCTED_SHELL_IDS: readonly string[] = [
  'battleView',
  'boxView',
  'raisingView',
  'evolutionView',
  'claimView',
  // rb-52 (ADR-0231 A2-D2): the privacy overlay's shell is constructed too. A STATIC shell would
  // have to carry `aria-modal="true"`, and `evals/overlay-live-region-custody.eval.mjs` pins the
  // count of those in index.html at EXACTLY eleven — an eval outside rb-52's touches.
  'privacyView',
];

/** DERIVED, never hand-kept: every OverlayId is either a static shell or a constructed one.
 *  Writing `11` beside a five-entry constructed list is two encodings of one fact, and the
 *  two drift the moment a seventeenth overlay lands. A3's complement assertion pins the
 *  MEMBERSHIP; this pins the arithmetic. */
const STATIC_SHELL_COUNT = OVERLAY_IDS.length - CONSTRUCTED_SHELL_IDS.length;

/** Tags the HTML spec makes focusable with no `tabindex` at all. Native-ness is derived
 *  from the TAG, never from a literal id list — see A5's narration. */
const NATIVE_FOCUSABLE_TAGS: readonly string[] = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'];

// ===========================================================================
// D1 — the live region (criterion A11Y-10; spec §2.4 / [A11Y-05])
// ===========================================================================

describe('m23-s2 (A11Y-10): the single a11y live region is body-anchored and outside #app', () => {
  it('BITES: A1 — exactly ONE aria-live node in index.html: it is #a11y-live, polite and atomic', () => {
    const doc = parseIndexHtml();
    const liveNodes = Array.from(doc.querySelectorAll('[aria-live]'));

    // CARDINALITY IS ASSERTED BEFORE IDENTITY, so a second region added later cannot hide
    // behind the first one's correct attributes.
    // WRONG IMPL KILLED: zero live regions (the pre-slice state — `aria-` is 0 hits
    // repo-wide, spec §1 Fact 1), and TWO of them. Two polite regions is not belt and
    // braces: assistive technologies interleave their queues non-deterministically, and
    // spec §5.2's BAD fixture list names it first.
    expect(
      liveNodes.map((el) => elementId(el)),
      'KILLS: zero aria-live nodes (the pre-slice state) or a SECOND one. A11Y-10 says ' +
        'EXACTLY one; §2.4 puts it outside every view root precisely so that one suffices.',
    ).toHaveLength(1);

    const node = doc.querySelector('[aria-live]');
    expect(
      elementId(node),
      'KILLS: an aria-live node under some OTHER id — S1 liveRegion.ts writes ' +
        '#a11y-live.textContent and nothing else, so a differently-named node is a region ' +
        'no code will ever write to.',
    ).toBe('a11y-live');

    // EQUALITY, NOT PRESENCE. `aria-live="assertive"` passes any presence check and is
    // WRONG: it interrupts a battle announcement mid-utterance (§2.4, and M19-A1 states
    // the same rule for chat). `aria-live="off"` also passes a presence check and silences
    // the region completely.
    expect(
      node === null ? '(no aria-live node)' : node.getAttribute('aria-live'),
      'KILLS: aria-live="assertive" (interrupts a battle announcement mid-utterance, §2.4) ' +
        'and aria-live="off" (announces nothing at all). BOTH satisfy a presence check, ' +
        'which is exactly why this is an equality.',
    ).toBe('polite');

    // WRONG IMPL KILLED: omitting aria-atomic. Without it an AT may announce only the
    // CHANGED text node rather than the whole message, so consecutive messages sharing a
    // prefix are read as fragments.
    expect(
      node === null ? '(no aria-live node)' : node.getAttribute('aria-atomic'),
      'KILLS: a live region with no aria-atomic="true" — the AT announces only the changed ' +
        'portion, so consecutive messages sharing a prefix are read as fragments.',
    ).toBe('true');
  });

  it('BITES: A2 — #a11y-live is a DIRECT <body> child outside #app, carries the sr-only class and NO inline style, and is empty at boot', () => {
    const doc = parseIndexHtml();
    const node = doc.querySelector('#a11y-live');

    // B7 (red-team m23-s2) — A1 SELECTS BY `[aria-live]`, A2 SELECTS BY `#a11y-live`, and
    // nothing used to assert they are the SAME NODE. A duplicate id splits the two oracles:
    // a first `<div id="a11y-live" class="sr-only">` decoy plus a second, correctly-attributed
    // `<div id="a11y-live" aria-live="polite" ... style="color:red">Loading…</div>` passed all
    // 203 tests. A1 saw exactly one `[aria-live]` with the right values; every placement,
    // class, `style === null` and empty-at-boot clause below read the DECOY. And
    // `document.getElementById('a11y-live')` — exactly what S1's `ui/liveRegion.ts` calls —
    // returns the decoy, so every announcement in the game would be written to a node with no
    // `aria-live` and NEVER SPOKEN, while the real region shipped visible boot copy.
    expect(
      Array.from(doc.querySelectorAll('#a11y-live')).length,
      'KILLS: a DUPLICATE id="a11y-live". getElementById returns the FIRST match, so a decoy ' +
        'earlier in the document silently becomes the node liveRegion.ts writes to — and it ' +
        'is not the one carrying aria-live. Every announcement is then lost.',
    ).toBe(1);
    expect(
      node !== null && node === doc.querySelector('[aria-live]'),
      "KILLS: A1's node and A2's node being DIFFERENT elements. A1 pins the aria-live values " +
        'and A2 pins placement, class and emptiness; unless they are the same element, each ' +
        'oracle certifies a different node and the pair proves nothing.',
    ).toBe(true);

    // ANTI-VACUITY, ASSERTED FIRST (this file's house rule — see H1/H5's own anti-vacuity
    // clauses): with the node
    // absent, every attribute read below is a null guard that passes. Deleting the element
    // must never be a way to satisfy A2.
    expect(
      node,
      'KILLS: a vacuously-green A2 — with #a11y-live absent every placement and attribute ' +
        'clause below reads off a null guard and passes. Deletion must not satisfy this test.',
    ).not.toBeNull();

    // WRONG IMPL KILLED: the region parked inside a view root or any wrapper. §2.4's whole
    // argument is that the `replaceChildren` tension DISSOLVES only because the node lives
    // outside every rebuild subtree (menuView:105, helpView:64, pvpView:97,
    // errorOverlayView:80 all rebuild authoritatively).
    expect(
      node === null ? '(no #a11y-live)' : node.parentElement?.tagName,
      'KILLS: #a11y-live nested in a wrapper or a view root — an ancestor replaceChildren() ' +
        'destroys the live-region binding and every announcement is silently lost (§2.4). ' +
        'Direct <body> child is the invariant, not a preference.',
    ).toBe('BODY');

    const app = doc.querySelector('#app');
    // ANTI-VACUITY for the containment clause: with #app missing, `contains` has no subject
    // and the clause below would be judging nothing.
    expect(
      app,
      'ANTI-VACUITY: #app is missing from index.html, so the "outside #app" clause has no ' +
        'subject. That is a markup or parse failure, not a passing placement check.',
    ).not.toBeNull();
    expect(
      app === null || node === null ? '(unresolvable)' : app.contains(node),
      'KILLS: #a11y-live inside #app — spec §5.2 names this exact BAD fixture. #app is the ' +
        'PixiJS mount AND the parent of four constructed overlay roots (main.ts:2180, ' +
        ':2184, :2211, :2266, :2296), so a region in there sits inside a subtree other ' +
        'slices rebuild.',
    ).toBe(false);

    // B5 (red-team m23-s2) — `aria-hidden="true"` or the bare `hidden` attribute on this node
    // passed all 203 tests, and Chromium measured the announcement ABSENT from the
    // accessibility tree in both cases. That is a strictly cheaper way to deliver the exact
    // defect A11Y-11 is written against, living in a file where nothing was looking: A11Y-11
    // guards the CSS, and these are attributes.
    for (const attr of ['aria-hidden', 'hidden']) {
      expect(
        node === null ? true : node.hasAttribute(attr),
        `KILLS: ${attr} on #a11y-live. It removes the node from the accessibility tree just ` +
          'as surely as display:none in .sr-only does — measured — and it does it on the ' +
          'markup side, where the A11Y-11 stylesheet oracle cannot see it.',
      ).toBe(false);
    }

    // WRONG IMPL KILLED: shipping the node with no class — i.e. VISIBLE stray text at the
    // bottom of the page every time an announcement lands.
    expect(
      node === null ? false : node.classList.contains('sr-only'),
      'KILLS: #a11y-live without class="sr-only" — every announcement renders as visible ' +
        'stray text under the canvas. A11Y-11 governs what that class must DO; this clause ' +
        'is what makes the class reach this node at all.',
    ).toBe(true);

    // WRONG IMPL KILLED: "hiding" the region with an inline style instead of the class.
    // THIS IS NOT DECORATION. main.wiring.test.ts:4727's corner filter is
    // `style.includes('position:fixed') && !style.includes('inset:0')` over every
    // `body > div`; an inline position:fixed here joins the corner set and reds
    // W-ONE-CORNER-AFFORDANCE — in a file OUTSIDE this slice's touches: set, i.e. a
    // regression this slice may not legally fix. Asserting `=== null` (no style attribute
    // at all) rather than "does not contain position:fixed" also keeps the styling contract
    // single-sourced in styles.css, which is the thing A11Y-12 protects.
    expect(
      node === null ? '(no #a11y-live)' : node.getAttribute('style'),
      'KILLS: ANY inline style on #a11y-live. An inline position:fixed enters ' +
        "main.wiring.test.ts:4727's corner filter and reds W-ONE-CORNER-AFFORDANCE in a " +
        "file outside this slice's touches: set; anything else duplicates the .sr-only " +
        'contract that A11Y-12 exists to keep single-sourced.',
    ).toBeNull();

    // WRONG IMPL KILLED: seeding the region with placeholder copy. Whatever text is in
    // there at boot is announced on the AT's first pass, and a literal string in the markup
    // is also an accessible-name literal outside a11yCopy.ts (§2.8).
    expect(
      node === null ? '(no #a11y-live)' : (node.textContent ?? '').trim(),
      'KILLS: a live region seeded with placeholder copy — it is announced at boot, and a ' +
        'literal string here is exactly the M24-seam violation §2.8 bans. The node is a ' +
        'SINK: liveRegion.ts owns every write to it.',
    ).toBe('');
  });
});

// ===========================================================================
// D2 — the eleven static shells declare the ARIA OVERLAY_A11Y assigns them
//      (criterion A11Y-13, static half)
// ===========================================================================

describe('m23-s2 (S2 static shells): every static shell declares the ARIA that OVERLAY_A11Y assigns it', () => {
  it('BITES: A3 — the eleven static-shell roots derive from initialFocusSelector and each carries role === OVERLAY_A11Y[id].role plus aria-modal true', () => {
    const doc = parseIndexHtml();
    const shells = deriveStaticShells(doc);
    const derivedIds = shells.map((s) => s.id);

    // ANTI-VACUITY #1, ASSERTED FIRST — the DERIVATION itself. If a selector stops
    // resolving (someone renames #trade-status), the loop below simply gets shorter, and
    // every attribute assertion in it stays green while a whole shell goes unchecked.
    expect(
      derivedIds,
      'ANTI-VACUITY: resolving all seventeen OVERLAY_A11Y initialFocusSelectors against ' +
        'index.html must yield exactly eleven static shells. FEWER means an anchor id was ' +
        'renamed or removed — the attribute loop below would then silently skip that shell ' +
        'and stay green. MORE means a constructed overlay grew a static anchor. Got: ' +
        JSON.stringify(derivedIds),
    ).toHaveLength(STATIC_SHELL_COUNT);

    // ANTI-VACUITY #2 — the COMPLEMENT is exactly S4's five constructed shells. Size 11
    // alone would tolerate a SWAP (one static id dropping out while a constructed one drops
    // in); this pins membership.
    const complement = OVERLAY_IDS.filter((id) => !derivedIds.includes(id));
    expect(
      [...complement].sort(),
      'ANTI-VACUITY: the ids whose anchor does NOT resolve statically must be EXACTLY the ' +
        'five constructed shells S4 owns. A different complement means the derivation ' +
        'drifted, not that the markup is fine.',
    ).toEqual([...CONSTRUCTED_SHELL_IDS].sort());

    // ANTI-VACUITY #3 — eleven DISTINCT roots. Two anchors collapsing onto one root (or a
    // root-finder that returns #app for everything) would otherwise let a single correctly
    // attributed div satisfy several ids at once.
    const rootIds = shells.map((s) => elementId(s.root));
    expect(
      Array.from(new Set(rootIds)),
      'ANTI-VACUITY: the eleven anchors must derive ELEVEN DISTINCT shell roots. Got: ' +
        JSON.stringify(rootIds),
    ).toHaveLength(STATIC_SHELL_COUNT);

    for (const shell of shells) {
      const label = `${shell.id} (anchor ${OVERLAY_A11Y[shell.id].initialFocusSelector})`;

      expect(
        shell.root,
        `KILLS: ${label} — its anchor is not inside any direct <body> <div>, so there is ` +
          'no shell root to carry the dialog ARIA (plan D-e derives the root as the ' +
          'anchor-or-ancestor div whose parent is <body>).',
      ).not.toBeNull();

      // THE CONSUMER READ-BACK. Indexing OVERLAY_A11Y[id].role DYNAMICALLY — never
      // asserting the literal 'dialog' — is what de-theatres §5.1's declared vacuity attack
      // one slice early: flip any id to 'alertdialog' in the registry without touching the
      // markup and this reds. A hardcoded 'dialog' would stay green and the manifest would
      // be decoration.
      // WRONG IMPL KILLED: role="presentation" or role="group" on a shell (silently
      // un-labels the modal), and omitting role entirely.
      expect(
        shell.root === null ? '(no root)' : shell.root.getAttribute('role'),
        `KILLS: ${label} shipping without role, or with a role that CONTRADICTS the SSOT. ` +
          'This assertion reads OVERLAY_A11Y rather than a literal, so a later registry ' +
          'flip to alertdialog reds here until the markup follows.',
      ).toBe(OVERLAY_A11Y[shell.id].role);

      // WRONG IMPL KILLED: role without aria-modal. A dialog that does not claim modality
      // leaves the rest of the document reachable by the AT virtual cursor while it is
      // open — which is the entire user-visible point of the role.
      expect(
        shell.root === null ? '(no root)' : shell.root.getAttribute('aria-modal'),
        `KILLS: ${label} carrying role but no aria-modal="true" — the AT keeps the rest of ` +
          'the document reachable behind the open modal. A11Y-13 names both attributes.',
      ).toBe('true');

      // PLAN D-c2, GATED rather than left as prose. Two independent reasons:
      //  (1) §2.8's M24 seam bans accessible-name LITERALS outside a11yCopy.ts, and a
      //      static aria-label here is precisely such a literal.
      //  (2) aria-labelledby WINS over aria-label, so a static one would KILL S1/S3's
      //      runtime `aria-label = t(meta.labelKey)` — and eight of the nine non-native
      //      anchors are EMPTY in this markup, so it would resolve to '': no accessible
      //      name at all, which is a worse WCAG failure than shipping no role.
      expect(
        shell.root === null ? true : shell.root.hasAttribute('aria-label'),
        `KILLS: ${label} with a STATIC aria-label — an accessible-name literal outside ` +
          'a11yCopy.ts (§2.8, the M24 seam) and a value S1/S3 must own at runtime.',
      ).toBe(false);
      // B6 (red-team m23-s2) — `aria-hidden="true"` on a shell root passed all 203 tests, and
      // Chromium measured the opened dialog's content ABSENT from the accessibility tree.
      // `aria-hidden` OVERRIDES `role` and `aria-modal`, so the two attributes this tooth
      // exists to pin become decoration while the tooth stays green.
      expect(
        shell.root === null ? true : shell.root.hasAttribute('aria-hidden'),
        `KILLS: ${label} carrying aria-hidden — it overrides role AND aria-modal, so the ` +
          'shell ships as a correctly-attributed dialog that assistive technology cannot ' +
          'see at all. Measured absent from the Chromium AX tree.',
      ).toBe(false);

      expect(
        shell.root === null ? true : shell.root.hasAttribute('aria-labelledby'),
        `KILLS: ${label} with aria-labelledby — it WINS over aria-label, so it silently ` +
          "defeats S3's runtime `aria-label = t(meta.labelKey)`, and eight of the nine " +
          'non-native anchors are empty in this markup so it resolves to the empty string: ' +
          'no accessible name at all.',
      ).toBe(false);
    }
  });

  it('BITES: A4 — two-way ratchet: no overlay shell in index.html escapes the derived eleven', () => {
    const doc = parseIndexHtml();
    const shells = deriveStaticShells(doc);
    const roots = shells.map((s) => s.root).filter((root): root is Element => root !== null);
    const bodyDivs = Array.from(doc.querySelectorAll('body > div'));
    // B9 (red-team m23-s2) — BOTH ratchet directions used to enumerate `body > div`, and
    // both were escaped by two shapes measured green: a shell WRAPPED one level deep
    // (`<div id="wrap"><div id="ghost-overlay" role="dialog" aria-modal="true">…`), and a
    // NON-DIV direct child (`<section id="ghost-overlay" role="dialog" aria-modal="true">`).
    // The second one carried the `-overlay` suffix AND hand-written dialog ARIA and still
    // escaped direction 2 — which the comment below used to call "the compensating control".
    // It was not one. Both directions now scan every descendant of <body>, any tag, any depth.
    const bodyElements = Array.from(doc.querySelectorAll('body *'));

    // ANTI-VACUITY: both directions below are "no offenders" assertions, which an empty
    // parse satisfies trivially. Pin the parse AND the derivation first. This markup has 15
    // direct body divs after m23-s2 (#app + 11 shells + build-stamp + help-hint +
    // a11y-live); the floor mirrors main.wiring.test.ts:4724's.
    expect(
      bodyDivs.length,
      'ANTI-VACUITY: parsed ' +
        String(bodyDivs.length) +
        ' direct <body> > div children from index.html — expected at least 12. A near-empty ' +
        'parse makes BOTH ratchet directions vacuous (parser/path failure, not a markup ' +
        'regression).',
    ).toBeGreaterThanOrEqual(12);
    expect(
      roots,
      'ANTI-VACUITY: the derived root set must hold eleven elements before it can serve as ' +
        'the reference set for either ratchet direction.',
    ).toHaveLength(STATIC_SHELL_COUNT);

    // DIRECTION 1 — every `-overlay` shell is one of the derived eleven.
    // WRONG IMPL KILLED: a twelfth shell added to index.html with no ARIA and no
    // OVERLAY_A11Y entry; and an EXISTING shell whose anchor was renamed so it silently
    // dropped out of A3's loop (A3 would then check ten and pass; this direction reds).
    const suffixEscapees = bodyElements
      .filter((el) => elementId(el).endsWith('-overlay'))
      .filter((el) => !roots.includes(el))
      .map((el) => elementId(el));
    expect(
      suffixEscapees,
      'KILLS: an overlay shell in index.html that the OVERLAY_A11Y derivation does not ' +
        'reach — either a twelfth shell added without a registry entry, or an existing ' +
        "shell whose initialFocusSelector anchor was renamed (A3's loop would just get " +
        'shorter and stay green). Escapees: ' +
        JSON.stringify(suffixEscapees),
    ).toEqual([]);

    // DIRECTION 2 — every body-level div carrying a `role` is one of the derived eleven.
    // WRONG IMPL KILLED: hand-written dialog ARIA on an element the registry knows nothing
    // about — the "per-view ad-hoc ARIA" anti-pattern spec §2.0 rejects for having no
    // completeness oracle — at ANY tag and ANY depth under <body> (B9).
    const roleEscapees = bodyElements
      .filter((el) => el.hasAttribute('role'))
      .filter((el) => !roots.includes(el))
      .map((el) => `${elementId(el)}[role=${el.getAttribute('role')}]`);
    expect(
      roleEscapees,
      'KILLS: a body-level div carrying hand-written ARIA that no OVERLAY_A11Y entry ' +
        'governs — ad-hoc per-element ARIA is exactly the pattern §2.0 rejects for having ' +
        'no completeness oracle. Escapees: ' +
        JSON.stringify(roleEscapees),
    ).toEqual([]);

    // DECLARED RESIDUAL, restated honestly after B9. What still escapes is exactly one
    // shape: an element named WITHOUT the `-overlay` suffix AND carrying no `role` at all.
    // Naming is the only mechanical enumeration the markup alone offers, and a shell with
    // neither the suffix nor any ARIA is indistinguishable from ordinary chrome by text.
    // Direction 2 catches it the moment it grows any ARIA, and S10's
    // evals/a11y-static-shell.eval.mjs is the second control. What is NO LONGER claimed:
    // that direction 2 compensates for direction 1 in general — measured false before B9.
  });
});

// ===========================================================================
// D3 — focusability of every static anchor
//      (ADR-0205 D1/D2's derived obligation, plus the A11Y-26 forward-guard)
// ===========================================================================

describe('m23-s2 (ADR-0205 D1/D2): every initialFocusSelector anchor in index.html is focusable', () => {
  it('BITES: A5 — each static anchor is natively focusable or tabindex-focusable, #menu-rows is exactly 0, the eight passive anchors are exactly -1, and no tabindex in index.html exceeds 0', () => {
    // ADR-0205 D1 makes this obligation DERIVED, never listed: "S2's own gate ... resolves
    // EVERY OVERLAY_A11Y[id].initialFocusSelector and requires the target to be focusable.
    // If S2 forgets a tabindex, S2's own gate reds." This is that gate.
    //
    // NATIVE-NESS IS DERIVED FROM THE TAG, never from a literal id list. A hardcoded
    // {rename-input, tradepropose-target} exemption is the attractive wrong implementation:
    // it stays green when a future slice swaps an anchor from a <div> to a <button> (which
    // would then be wrongly required to carry a tabindex) or the reverse (an unfocusable
    // div wrongly exempted).
    const doc = parseIndexHtml();
    const shells = deriveStaticShells(doc);

    expect(
      shells,
      'ANTI-VACUITY: the per-anchor loop below must examine ELEVEN anchors. A shorter ' +
        'derivation silently skips whichever anchor was renamed, and every clause below ' +
        'stays green.',
    ).toHaveLength(STATIC_SHELL_COUNT);

    let nativeSeen = 0;
    let nonNativeSeen = 0;

    for (const shell of shells) {
      const selector = OVERLAY_A11Y[shell.id].initialFocusSelector;
      const tag = shell.anchor.tagName.toLowerCase();
      const label = `${shell.id} (anchor ${selector}, <${tag}>)`;
      const isNative = NATIVE_FOCUSABLE_TAGS.includes(shell.anchor.tagName);
      const raw = shell.anchor.getAttribute('tabindex');

      if (isNative) {
        nativeSeen += 1;
        // WRONG IMPL KILLED: "add tabindex to all the anchors", applied uniformly.
        // `tabindex="-1"` on #rename-input / #tradepropose-target REMOVES them from the tab
        // order — a regression of the rename and trade keyboard flows S3 must preserve
        // byte-for-byte (ADR-0205 D2: renameView.ts:102 and tradeProposeView.ts:124 focus
        // exactly these two today).
        expect(
          raw,
          `KILLS: ${label} — a NATIVELY focusable control must carry NO tabindex at all. A ` +
            '-1 here removes it from the tab order entirely (regressing the rename and ' +
            'trade-propose keyboard flows); a 0 is redundant noise that also reorders it.',
        ).toBeNull();
        continue;
      }

      nonNativeSeen += 1;
      // WRONG IMPL KILLED: shipping the ARIA (A3) and FORGETTING the focusability half.
      // openOverlayA11y's deferred `root.querySelector(sel)?.focus()` is a silent no-op on
      // an element with no tabindex, so the overlay opens with focus still on <body> and
      // A11Y-14 fails at S3/S10 time — one slice too late to be cheap.
      expect(
        raw,
        `KILLS: ${label} — a NON-native anchor with no tabindex is not focusable, so S1/S3's ` +
          'deferred .focus() is a silent no-op and the overlay opens with focus still on ' +
          '<body>. ADR-0205 D1 adopts the ARIA APG dialog fallback precisely here.',
      ).not.toBeNull();

      expect(
        raw !== null && /^-?\d+$/.test(raw),
        `KILLS: ${label} with a non-integer tabindex ("auto", "0.5", "1e0") — the browser ` +
          'drops the declaration and the element is not focusable at all, while a ' +
          'parseInt-based check would happily accept it. Got: ' +
          JSON.stringify(raw),
      ).toBe(true);
      expect(
        Number.parseInt(raw ?? '', 10) <= 0,
        `KILLS: ${label} with a POSITIVE tabindex — it hoists the element ahead of every ` +
          'document-order stop (criterion A11Y-26 / [A11Y-T5]).',
      ).toBe(true);

      if (shell.id === 'menuView') {
        // ADR-0205 D2's NAMED LANDMINE, keyed on the OverlayId (which comes from the
        // registry) rather than on the element id. S6 gives #menu-rows a delegated click
        // listener and puts aria-activedescendant on it, which requires the listbox ITSELF
        // to hold DOM focus; S10's [A11Y-T3] NEGATIVE_TABINDEX_INTERACTIVE then FAILS a
        // tabindex="-1" on a listener-bearing element. `0` satisfies both, and [A11Y-T5]
        // bans only values greater than 0.
        expect(
          raw,
          'KILLS: tabindex="-1" on #menu-rows — ADR-0205 D2 names this landmine. It is the ' +
            'aria-activedescendant listbox AND carries a delegated click listener ' +
            '(menuView.ts:51), so S10 [A11Y-T3] fails a -1 there. It must be exactly "0".',
        ).toBe('0');
        continue;
      }

      // WRONG IMPL KILLED: `tabindex="0"` on a PASSIVE anchor. No linter sees it —
      // [A11Y-T5] bans only values greater than 0 — but it inserts eight junk Tab stops on
      // headings and display-only <ul>s inside open modals, which is the noise the APG
      // fallback avoids by using -1.
      expect(
        raw,
        `KILLS: ${label} at tabindex="0" — the eight PASSIVE anchors are headings and ` +
          'display-only lists (spec §1 Fact 2: zero listeners). A 0 makes each of them a ' +
          'junk Tab stop inside an open modal, and [A11Y-T5] bans only values greater than ' +
          '0, so nothing else in this milestone catches it. It must be exactly "-1".',
      ).toBe('-1');
    }

    // ANTI-VACUITY: the loop must have exercised BOTH branches. A derivation that yielded
    // only natives (or only non-natives) would leave one branch above entirely unrun.
    expect(
      nativeSeen,
      'ANTI-VACUITY: at least one NATIVELY focusable anchor must have been examined ' +
        '(#rename-input and #tradepropose-target are the two). Zero means the tag ' +
        'derivation broke and the native branch never ran.',
    ).toBeGreaterThanOrEqual(1);
    expect(
      nonNativeSeen,
      'ANTI-VACUITY: at least one NON-native anchor must have been examined. Zero means the ' +
        'tag derivation broke and every tabindex clause above was skipped.',
    ).toBeGreaterThanOrEqual(1);

    // THE A11Y-26 FORWARD-GUARD, over the WHOLE document rather than the eleven anchors.
    // Two jobs: it lands criterion A11Y-26 ("no tabindex value greater than 0") early and
    // for free, and it protects the eight `-1`s from a copy-paste typo that puts
    // `tabindex="1"` on some entirely different element.
    const tabindexEls = Array.from(doc.querySelectorAll('[tabindex]'));
    expect(
      tabindexEls.length,
      'ANTI-VACUITY: index.html must carry at least one tabindex attribute per non-native ' +
        'anchor before the document-wide scan below can mean anything. Found ' +
        String(tabindexEls.length) +
        ' for ' +
        String(nonNativeSeen) +
        ' non-native anchors.',
    ).toBeGreaterThanOrEqual(nonNativeSeen);

    const badTabindex = tabindexEls
      .map((el) => ({ id: elementId(el), raw: el.getAttribute('tabindex') ?? '' }))
      .filter((e) => !/^-?\d+$/.test(e.raw) || Number.parseInt(e.raw, 10) > 0);
    expect(
      badTabindex,
      'KILLS: ANY tabindex greater than 0 (or a non-integer one) anywhere in index.html — ' +
        'criterion A11Y-26 / [A11Y-T5]. A positive value hoists an element ahead of the ' +
        'whole document order, and it is the classic copy-paste typo on a "-1". Offenders: ' +
        JSON.stringify(badTabindex),
    ).toEqual([]);
  });
});

// ===========================================================================
// D4 — styles.css declares ZERO `#id` selectors (criterion A11Y-12 / [A11Y-07])
// ===========================================================================

describe('m23-s2 (A11Y-12): styles.css declares ZERO #id selectors', () => {
  // A6a (the inline BAD/GOOD fixture table) MOVED with rb-15. Its 14 rows are now
  // `ID_SELECTOR_FIXTURES`, exported from evals/a11y-static-shell.eval.mjs and executed IN FULL
  // by BOTH tiers — RB15-G2 below runs them here, and the eval runs the same table as 14 teeth
  // in the nightly a11y-e2e tier, which never ran them before. This describe is not gutted —
  // see RB15-G2/RB15-G3.

  it('BITES: A6b — CONTROL probe, then: the REAL client/src/styles.css declares zero #id selectors', () => {
    // CONTROL PROBE FIRST. The real-file assertion below is "returns an empty array", which
    // a `() => []` stub satisfies perfectly — the declaration-pin / self-source-needle
    // lesson. These two probes make a stubbed or accidentally-disabled scanner a RED before
    // the real file is ever read.
    expect(
      rb12CssStripperOracle.findIdSelectors('#a{}'),
      'CONTROL: the scanner must FLAG a trivial id selector. If this is empty, the ' +
        'real-file assertion below proves nothing — a `() => []` stub would green it.',
    ).toHaveLength(1);
    expect(
      rb12CssStripperOracle.findIdSelectors('.a{}'),
      'CONTROL: the scanner must NOT flag a trivial class selector. If this is non-empty the ' +
        'scanner is a constant-true and the real-file assertion is unreachable.',
    ).toHaveLength(0);

    // The real artefact. RED until client/src/styles.css exists: readStylesCss() throws
    // loudly rather than substituting the empty string.
    const css = readStylesCss();
    expect(
      css.trim().length,
      'ANTI-VACUITY: client/src/styles.css is empty. An empty file trivially declares zero ' +
        'id selectors AND has no .sr-only rule — A7b is the other half of this pair.',
    ).toBeGreaterThan(0);

    const offenders = rb12CssStripperOracle.findIdSelectors(css);
    expect(
      offenders,
      'KILLS: any #id selector in client/src/styles.css (criterion A11Y-12, [A11Y-07]). ' +
        "This is what keeps THIS FILE's own inline pins meaningful: a rule reaching " +
        '#help-overlay, #help-hint or #build-stamp could silently satisfy or defeat ' +
        'H4b/H5/H6/H7, whose entire premise is that the inline style attribute is the ' +
        'COMPLETE styling contract (see the m23-s2 CORRECTION note in this file header). ' +
        'Offenders: ' +
        JSON.stringify(offenders),
    ).toEqual([]);

    // B1 (red-team m23-s2) — THE REACHABILITY HALF. Its own CONTROL PROBES first, for the
    // same reason as above: this assertion is also "returns an empty array".
    expect(
      findCascadeReachingSelectors('[id="help-overlay"]{visibility:hidden}'),
      'CONTROL: the reachability scanner must FLAG an attribute selector naming a pinned id. ' +
        'If it does not, the real-file assertion below is satisfied by a `() => []` stub.',
    ).toHaveLength(1);
    expect(
      findCascadeReachingSelectors('*{position:static}'),
      'CONTROL: the reachability scanner must FLAG the universal selector.',
    ).toHaveLength(1);
    expect(
      findCascadeReachingSelectors('body > div:nth-child(11){position:static}'),
      'CONTROL: the reachability scanner must FLAG a positional selector.',
    ).toHaveLength(1);
    expect(
      findCascadeReachingSelectors('.sr-only{position:absolute;clip-path:inset(50%)}'),
      'CONTROL: the reachability scanner must NOT flag an ordinary class rule. If it does, ' +
        'it is a constant-true and the real-file assertion is unreachable.',
    ).toHaveLength(0);

    const reaching = findCascadeReachingSelectors(css);
    expect(
      reaching,
      'KILLS: a rule that reaches a text-pinned id WITHOUT spelling `#` — measured as a live ' +
        'bypass of the clause above. `[id="help-overlay"]{visibility:hidden}` is `#`-free, ' +
        'biome-clean, leaves findIdSelectors empty, and in Chromium hides the help overlay, ' +
        'blanks #help-hint and drops #a11y-live out of the accessibility tree. Also killed: ' +
        '`*` and the positional pseudos, which reach an element without naming it. ' +
        'Offenders: ' +
        JSON.stringify(reaching),
    ).toEqual([]);

    // B2 (red-team m23-s2) — THE SURFACE HALF, stylesheet side. A6b reads exactly one file;
    // `@import` makes a second one, whose LITERAL id rules no tooth ever sees.
    expect(
      importsAnotherStylesheet('@import url("/src/theme.css");'),
      'CONTROL: the @import detector must FIRE on an @import.',
    ).toBe(true);
    expect(
      importsAnotherStylesheet(css),
      'KILLS: an @import in styles.css. parseCssRules classifies the @import prelude as an ' +
        'at-rule and never inspects it, and A8 counts <link> elements rather than CSS-level ' +
        'imports — so a second sheet full of literal #id rules ships completely unscanned. ' +
        'Spec §2.7 decided on exactly ONE css file.',
    ).toBe(false);
  });
});

// ===========================================================================
// D5 — `.sr-only` stays in the accessibility tree (criterion A11Y-11 / [A11Y-06])
// ===========================================================================

// SHIPPED_SR_ONLY_RULE MOVED to evals/a11y-static-shell.eval.mjs with rb-15 (exported): three
// SR_ONLY_FIXTURES rows consume it, and a second copy here would be a duplicated CSS blob that
// nothing compares — the same defect this slice removes one level up. Reached below as
// rb12CssStripperOracle.SHIPPED_SR_ONLY_RULE.

describe('m23-s2 (A11Y-11): .sr-only hides visually WITHOUT leaving the accessibility tree', () => {
  // A7a (the inline BAD/GOOD fixture table) MOVED with rb-15. Its 21 rows are now
  // `SR_ONLY_FIXTURES`, exported from evals/a11y-static-shell.eval.mjs and executed IN FULL by
  // BOTH tiers — RB15-G2 below runs them here, and the eval runs the same table as 21 teeth in
  // the nightly a11y-e2e tier, which never ran them before. The replacement is STRICTLY
  // STRONGER: A7a's BAD rows asserted `reasons.includes(fixture.reason)`, which red-team
  // MEASURED that a constant-fail oracle returning EVERY reason survives; RB15-G2 asserts the
  // EXACT reasons SET. This describe is not gutted — see RB15-G2/RB15-G3.

  it('BITES: A7b — CONTROL probe, then: the REAL .sr-only rule is position:absolute plus clip/clip-path with neither display:none nor visibility:hidden', () => {
    // CONTROL PROBE FIRST, BOTH POLARITIES — a `() => ({ ok: true, reasons: [] })` stub
    // would otherwise green the real-file assertion below.
    expect(
      rb12CssStripperOracle.srOnlyIsAccessible('.sr-only{display:none}').ok,
      'CONTROL: the oracle must REJECT display:none. If this is true the oracle is a ' +
        'constant-pass and the real-file assertion below proves nothing.',
    ).toBe(false);
    expect(
      rb12CssStripperOracle.srOnlyIsAccessible(rb12CssStripperOracle.SHIPPED_SR_ONLY_RULE).ok,
      'CONTROL: the oracle must ACCEPT a correct sr-only rule. If this is false the oracle ' +
        'is a constant-fail and the real-file assertion is unreachable.',
    ).toBe(true);

    // The real artefact. RED until client/src/styles.css exists AND holds a semantically
    // correct .sr-only rule — readStylesCss() throws loudly rather than substituting ''.
    const verdict = rb12CssStripperOracle.srOnlyIsAccessible(readStylesCss());
    expect(
      verdict.reasons,
      'KILLS: a shipped .sr-only that removes #a11y-live from the accessibility tree ' +
        '(display:none / visibility:hidden), or that fails to hide it at all (a clip with no ' +
        'position:absolute leaves the box painting in full). Criterion A11Y-11 / [A11Y-06]. ' +
        'Reasons: ' +
        JSON.stringify(verdict.reasons),
    ).toEqual([]);
    expect(verdict.ok, 'the real .sr-only rule must satisfy every A11Y-11 clause').toBe(true);
    expect(
      verdict.declCount,
      'ANTI-VACUITY: the real rule must carry at least ' +
        String(rb12CssStripperOracle.MIN_SR_ONLY_DECLARATIONS) +
        ' declarations — an empty .sr-only block satisfies both NEGATIVE clauses trivially.',
      // The LITERAL 2, never `rb12CssStripperOracle.MIN_SR_ONLY_DECLARATIONS`: once both sides
      // come from the owner module, lowering the constant moves them together and the
      // comparison is a tautology. (The eval's T-REAL4 pins the real file's declCount at the
      // literal 9 for the same reason.)
    ).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// D6 — the stylesheet is actually LOADED (no spec criterion, and that is the point)
// ===========================================================================

describe('m23-s2 (load path): index.html actually LOADS the stylesheet', () => {
  it('BITES: A8 — head holds exactly one stylesheet link and it points at /src/styles.css, which exists on disk', () => {
    // WHY THIS TOOTH EXISTS AT ALL. Nothing else in the repo catches "shipped a stylesheet
    // that nothing loads": `just ci` has no client BUILD step (justfile:491), vitest never
    // applies CSS, and there is no e2e console-error gate. Without the <link>, A6b and A7b
    // both stay GREEN — the file is on disk and semantically perfect — while .sr-only
    // applies to nothing, #a11y-live renders as visible stray text at the bottom of the
    // page, and criterion A11Y-11 becomes unobservable in the product. This is the cheapest
    // available proof that the artefact is WIRED, not merely present.
    //
    // WRONG IMPL KILLED (1): `import './styles.css'` from main.ts instead of a <link>.
    //   main.ts is S5's EXCLUSIVE touch (spec §4), so that edit is a hidden-dependency
    //   violation this slice may not make. It also leaves index.html unchanged and this
    //   assertion red, which is exactly the point.
    // WRONG IMPL KILLED (2): a relative `href="src/styles.css"` or `href="./styles.css"` —
    //   vite's root is client/, so only the absolute /src/styles.css resolves under both
    //   `vite dev` and `vite build`. This mirrors the module <script>'s own /src/main.ts
    //   form at index.html:154, already proven on both paths.
    // WRONG IMPL KILLED (3): the <link> placed in <body>. Parsers hoist it in practice, but
    //   a stylesheet discovered after first paint is a flash of unstyled content — here, a
    //   visible flash of the live region's text.
    const doc = parseIndexHtml();
    const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));

    // B2 (red-team m23-s2), the SURFACE half of A11Y-12. `styles.css` is the only file A6b
    // scans, so an inline `<style>` block in <head> ships LITERAL `#help-overlay{position:
    // static!important}` rules past every tooth: measured 18/18 green with Chromium
    // reporting `#help-overlay` at `rect.top = 720` in a 720px viewport — ADR-0151 D1's
    // below-the-fold regression, reproduced with H7 passing. The ban is also right on its
    // own terms: spec §2.7 decided on exactly ONE stylesheet, and an inline block is a
    // second, unscannable one.
    expect(
      Array.from(doc.querySelectorAll('style')).length,
      'KILLS: an inline <style> block in index.html. A6b scans client/src/styles.css and ' +
        'nothing else, so id rules parked here are invisible to A11Y-12 while still ' +
        'reaching #help-overlay / #help-hint / #build-stamp in the browser. All styling in ' +
        'this file is inline-on-the-element or in the one linked stylesheet.',
    ).toBe(0);

    expect(
      links.map((el) => el.getAttribute('href') ?? '(no href)'),
      'KILLS: no stylesheet <link> at all (styles.css shipped but never loaded — every other ' +
        'm23-s2 tooth stays green while .sr-only applies to nothing), and a SECOND ' +
        'stylesheet link (spec §2.7 decided on EXACTLY ONE css file; a second one is an ' +
        'ungated cascade this slice never reasoned about).',
    ).toHaveLength(1);

    const link = doc.querySelector('link[rel="stylesheet"]');
    expect(
      link === null ? '(no stylesheet link)' : link.getAttribute('href'),
      'KILLS: a relative href. vite serves index.html with root=client/, so only the ' +
        'absolute /src/styles.css resolves under both `vite dev` and `vite build` — the same ' +
        'form index.html:154 already uses for /src/main.ts.',
    ).toBe('/src/styles.css');

    expect(
      link === null ? '(no stylesheet link)' : link.parentElement?.tagName,
      'KILLS: the stylesheet <link> placed in <body> — the sheet is then discovered after ' +
        'first paint and the live region flashes as visible text before .sr-only applies.',
    ).toBe('HEAD');

    // AND THE PATH RESOLVES ON DISK. A <link> to a file that does not exist is a 404 in the
    // browser and a silently unstyled page. Without this clause a reviewer facing a red A6b
    // could "fix" the href instead of shipping the file.
    const css = readStylesCss();
    expect(
      css.trim().length,
      'KILLS: a <link href="/src/styles.css"> pointing at a missing or empty file — a 404 in ' +
        'the browser and an unstyled live region. Resolved path: ' +
        STYLES_CSS_PATH,
    ).toBeGreaterThan(0);
  });
});

describe('ux1-1 (m23-s5/ADR-0206 D5): #help-hint is a native <button>', () => {
  it('BITES: S5T-HINT-BUTTON — #help-hint is a <button type="button">, still a direct <body> child, still carries data-menu-launcher, still names the ? key, and still has zero element children', () => {
    // A11Y-23's markup half: the sole always-on menu affordance must be reachable by Tab and
    // activatable by Enter AND Space. A <div> (even with tabindex + a click handler) gets
    // neither for free — a native <button> does.
    // WRONG IMPL KILLED (1): #help-hint left as a <div> — Enter/Space activation is
    //   unreachable without hand-rolled key handling main.ts must never own
    //   (W-UX1-HINT-NO-JS-OWNER).
    // WRONG IMPL KILLED (2): the conversion drops data-menu-launcher, re-parents the badge
    //   out of <body>, or grows an element child (e.g. wrapping the text in a <span>) — H1/
    //   H2b's own invariants, restated here so this ONE test proves the whole markup
    //   contract for the button shape at once.
    // WRONG IMPL KILLED (3): shipping the button WITHOUT type="button" — the default
    //   <button> type is "submit", which would try to submit an enclosing <form> the moment
    //   one exists, and is never the intended semantics for a menu launcher regardless.
    const doc = parseIndexHtml();
    const hint = doc.querySelector('#help-hint');
    expect(hint, '#help-hint must exist').not.toBeNull();
    expect(hint!.tagName, '#help-hint must be a <button>').toBe('BUTTON');
    expect(hint!.getAttribute('type'), '#help-hint must declare type="button"').toBe('button');
    expect(hint!.parentElement?.tagName, '#help-hint must still be a direct child of <body>').toBe(
      'BODY',
    );
    expect(
      hint!.hasAttribute('data-menu-launcher'),
      '#help-hint must still carry data-menu-launcher — the delegated binding contract ' +
        '(W-UX1-HINT-NO-JS-OWNER, ADR-0151 D2) is unaffected by the tag change',
    ).toBe(true);
    const text = hint!.textContent ?? '';
    expect(text.includes('?'), 'the button must still name the ? key').toBe(true);
    expect(
      Array.from(hint!.children).map((c) => c.tagName),
      '#help-hint must still have ZERO element children (a leaf text button)',
    ).toEqual([]);
  });
});

// ===========================================================================
// RB12 (ADR-0215): stripCssComments becomes single-owned by
// evals/a11y-static-shell.eval.mjs — client/src/indexShell.test.ts's private copy is deleted and
// this file imports the owner instead. `parseCssRules` (above) keeps calling `stripCssComments`
// unchanged, so it is judged by the SAME gates as everything else in this block.
//
// TWO import forms from the one owner module, each load-bearing. The NAMESPACE binding
// (`rb12CssStripperOracle`) carries the corpus symbols; The separate single-line NAMED import of
// `stripCssComments` is what `parseCssRules` resolves to, and RB12-G1 requires it to stay on ONE
// line: a combined named import of all five symbols exceeds the line width, Biome wraps it, and
// the wrapped continuation line no longer starts with `import` — which would red G1's import half.
// ===========================================================================

/**
 * RB12-G1 and RB12-G7 support: a local, PRIVATE comment stripper — line-comment and block-comment aware
 * (the delimiter pairs are never typed as literal text in this comment, on purpose — see the
 * HAZARD note above the shared corpus in evals/a11y-static-shell.eval.mjs), with
 * string/template-literal awareness so a comment-lookalike inside a string literal is not
 * mistaken for a real comment. Deliberately NOT an import of a shared stripper: this one
 * self-referential gate must never depend on another module's correctness to report the truth
 * about THIS file's own source.
 */
function rb12StripJsComments(src: string): string {
  let out = '';
  let i = 0;
  const len = src.length;
  let state: 'normal' | 'line' | 'block' | 'sq' | 'dq' | 'tl' = 'normal';
  while (i < len) {
    const ch = src.charAt(i);
    const next = i + 1 < len ? src.charAt(i + 1) : '';
    if (state === 'normal') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'tl';
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        out += '\n';
        state = 'normal';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        i += 2;
        continue;
      }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }
    const closer = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (ch === '\\' && i + 1 < len) {
      out += ch + src.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === closer) {
      out += ch;
      state = 'normal';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe('RB12 (ADR-0215): stripCssComments single ownership + corpus totality', () => {
  it('RB12-G1: indexShell.test.ts defines ZERO local stripCssComments and imports it EXACTLY ONCE', () => {
    const selfPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'indexShell.test.ts');
    let selfSrc: string;
    try {
      selfSrc = readFileSync(selfPath, 'utf8');
    } catch (err) {
      throw new Error(`indexShell.test.ts could not read its own source at ${selfPath} — ${err}`);
    }
    const stripped = rb12StripJsComments(selfSrc);

    // Assembled from fragments so the assertion literal itself cannot satisfy the needle it hunts.
    const DEF_NEEDLE = ['function ', 'stripCss', 'Comments('].join('');
    const BARE_NAME = ['stripCss', 'Comments'].join('');

    const defCount = stripped.split(DEF_NEEDLE).length - 1;
    expect(
      defCount,
      'KILLS: a second local `function stripCss' +
        'Comments(` definition surviving in this file — ' +
        'ADR-0215 makes evals/a11y-static-shell.eval.mjs the SOLE owner. Local definitions found: ' +
        String(defCount),
    ).toBe(0);

    // Assumes a single-line import statement, matching this file's own import style above (every
    // existing import is one line) and the ADR's decision (only ONE symbol, `stripCssComments`,
    // moves — nothing here forces a multi-line, Biome-wrapped import).
    const importLines = stripped
      .split('\n')
      .filter((line) => line.trim().indexOf('import') === 0 && line.indexOf(BARE_NAME) !== -1);
    expect(
      importLines.length,
      'KILLS: zero imports (the owner symbol is unreachable from this file) or MORE than one ' +
        `import naming stripCssComments (a second, competing import path). Found: ${JSON.stringify(importLines)}`,
    ).toBe(1);
  });

  it('RB12-G2: stripCssComments (the imported oracle) matches every pinned outcome across the full shared corpus', () => {
    const corpus = rb12CssStripperOracle.CSS_STRIPPER_CORPUS as ReadonlyArray<{
      name: string;
      css: string;
      expect: { kind: 'value'; out: string } | { kind: 'throw'; needle: string };
    }>;
    expect(
      corpus.length,
      'ANTI-VACUITY: the shared corpus must not be empty or shrunk below its known 11 cells.',
    ).toBeGreaterThanOrEqual(11);

    for (const cell of corpus) {
      if (cell.expect.kind === 'value') {
        expect(
          rb12CssStripperOracle.stripCssComments(cell.css),
          `cell "${cell.name}" must byte-match its pinned VALUE outcome`,
        ).toBe(cell.expect.out);
      } else {
        let threw = false;
        let message = '';
        try {
          rb12CssStripperOracle.stripCssComments(cell.css);
        } catch (err) {
          threw = true;
          message = String(err);
        }
        expect(threw, `cell "${cell.name}" must throw`).toBe(true);
        expect(
          message.indexOf(cell.expect.needle) !== -1,
          `cell "${cell.name}" threw "${message}", expected it to contain "${cell.expect.needle}"`,
        ).toBe(true);
      }
    }
  });

  it('RB12-G3: the shared cell-name list and a LOCALLY re-declared copy agree, both directions, exact count', () => {
    // RE-DECLARED INDEPENDENTLY — deliberately NOT imported from the corpus module, so deleting a
    // cell from CSS_STRIPPER_CELLS cannot silently satisfy this gate at the same time as the
    // shared-module completeness gate (T10d): two independent sources must agree, or this gate
    // stays red even when the shared list alone looks fine.
    const RB12_LOCAL_CELL_NAMES: readonly string[] = Object.freeze([
      'normal/comment-open-close',
      'normal/no-line-comment',
      'normal/bare-slash-inert',
      'dq/comment-open-inert',
      'dq/close-then-real-comment',
      'sq/comment-close-inert',
      'dq/backslash-escape',
      'comment/newline-preserved',
      'EOF/in-comment',
      'EOF/in-string',
      'normal/empty',
    ]);

    expect(
      RB12_LOCAL_CELL_NAMES.length,
      'ANTI-VACUITY: the locally re-declared cell-name list must not be empty.',
    ).toBeGreaterThan(0);

    const sharedCells = rb12CssStripperOracle.CSS_STRIPPER_CELLS as readonly string[];
    const sharedCorpusNames = (
      rb12CssStripperOracle.CSS_STRIPPER_CORPUS as ReadonlyArray<{ name: string }>
    ).map((c) => c.name);

    const missingFromShared = RB12_LOCAL_CELL_NAMES.filter((n) => sharedCells.indexOf(n) === -1);
    const extraInShared = sharedCells.filter((n) => RB12_LOCAL_CELL_NAMES.indexOf(n) === -1);
    expect(
      missingFromShared,
      'KILLS: a cell deleted from CSS_STRIPPER_CELLS while this independently-typed list still ' +
        'names it — the shared module and this file must never silently drift apart.',
    ).toEqual([]);
    expect(
      extraInShared,
      'KILLS: a cell added to CSS_STRIPPER_CELLS with no counterpart here — this list is the ' +
        'SECOND SOURCE that editing the shared corpus alone cannot satisfy.',
    ).toEqual([]);

    expect(sharedCells.length, 'CSS_STRIPPER_CELLS must have exactly 11 entries').toBe(11);
    expect(
      sharedCorpusNames.length,
      'CSS_STRIPPER_CORPUS must carry exactly as many entries as CSS_STRIPPER_CELLS — a length ' +
        'floor alone would admit duplicate-name padding.',
    ).toBe(sharedCells.length);
  });

  it('RB12-G4: the real consumer parseCssRules fails LOUD on an unterminated comment (never silently drops content)', () => {
    expect(() =>
      rb12CssStripperOracle.parseCssRules('.a{color:red}' + SLASH_STAR + ' unterminated'),
    ).toThrow();
  });

  it('RB12-G5: the naive stripper (fixtureUnhardenedCssStripper) is pinned WRONG, exact output, on every NAIVE_KILLS cell', () => {
    const corpus = rb12CssStripperOracle.CSS_STRIPPER_CORPUS as ReadonlyArray<{
      name: string;
      css: string;
      expect: { kind: 'value'; out: string } | { kind: 'throw'; needle: string };
    }>;
    const naive = rb12CssStripperOracle.fixtureUnhardenedCssStripper as (src: string) => string;
    const kills = rb12CssStripperOracle.NAIVE_KILLS as readonly string[];
    // MEMBERSHIP, not merely non-emptiness — a one-entry NAIVE_KILLS previously passed here while
    // silently dropping three cells from the discrimination teeth in BOTH tiers.
    expect(
      [...kills].sort(),
      'KILLS: NAIVE_KILLS shrunk or drifted from its pinned roster',
    ).toEqual(['EOF/in-comment', 'EOF/in-string', 'dq/backslash-escape', 'dq/comment-open-inert']);

    const byName = (cellName: string) => {
      const cell = corpus.find((c) => c.name === cellName);
      expect(cell, `NAIVE_KILLS cell "${cellName}" must exist in the corpus`).toBeDefined();
      return cell!;
    };

    // The headline discriminator: EXACT wrong output, not merely "differs".
    const headline = byName('dq/comment-open-inert');
    const headlinePinned = ['.a{content:', '"'].join('');
    expect(
      naive(headline.css),
      'KILLS: a naive fixture hand-edited to no longer swallow the trailing display:none — the ' +
        'naive stripper is not quote-aware, so a comment-lookalike hiding inside a CSS string ' +
        'value opens a "comment" that consumes everything after it.',
    ).toBe(headlinePinned);

    const escapeCell = byName('dq/backslash-escape');
    const escapePinned = '.a{content:"x\\"';
    expect(
      naive(escapeCell.css),
      'KILLS: same underlying bug, reached through an escaped quote inside the string — the ' +
        'naive stripper truncates at the first slash-star lookalike regardless of the escape.',
    ).toBe(escapePinned);

    const eofCommentCell = byName('EOF/in-comment');
    const eofCommentPinned = '.a{color:red}';
    expect(
      naive(eofCommentCell.css),
      'KILLS: the naive stripper has NO error handling at all — on an unterminated comment it ' +
        'silently returns the prefix before the comment opener, hiding a parse failure as a ' +
        'clean result.',
    ).toBe(eofCommentPinned);
    expect(
      () => naive(eofCommentCell.css),
      'KILLS: the naive stripper must NOT throw here — if it does, this cell no longer proves ' +
        'the fail-open bug (the discrimination IS the throw/no-throw split).',
    ).not.toThrow();

    const eofStringCell = byName('EOF/in-string');
    const eofStringPinned = '.a{content:"oops}';
    expect(
      naive(eofStringCell.css),
      'KILLS: an unterminated string has no comment-opener to trip the naive scanner at all, so ' +
        'it echoes the whole input unchanged instead of throwing.',
    ).toBe(eofStringPinned);
    expect(() => naive(eofStringCell.css)).not.toThrow();
  });

  it('RB12-G6: CORPUS-CORRUPTION GUARD — independently hardcoded kill-cell expectations agree with the shared corpus', () => {
    // A SECOND, INDEPENDENT record of each NAIVE_KILLS cell's HARDENED outcome, typed here by
    // hand and NEVER derived from CSS_STRIPPER_CORPUS. If the shared table's expectation for one
    // of these cells is quietly weakened — so a wrong implementation slips through T10c/RB12-G2
    // AND the naive-discrimination teeth simultaneously, because all of them read from the SAME
    // corrupted table — this independent copy still disagrees and reds.
    // MEASURED BYPASS (rb-12 red-team, Finding 2): pinning only the four NAIVE_KILLS cells left the
    // other seven with no independent payload pin anywhere. SWAPPING two non-kill cells' css+expect
    // pairs while leaving their `name` fields in place kept T10c/T10d/T10e and RB12-G2/G3/G5/G6 all
    // green — the corpus then tested one transition TWICE under two names and `normal/bare-slash-inert`
    // not at all. A name-set pin is orthogonal to a payload pin. So this table covers ALL ELEVEN
    // cells: every cell's css AND expected outcome is re-declared here, literally, independent of
    // CSS_STRIPPER_CORPUS, so no edit to the shared table can go unobserved.
    const RB12_CORPUS_TRUTH: ReadonlyArray<{
      name: string;
      css: string;
      expect: { kind: 'value'; out: string } | { kind: 'throw'; needle: string };
    }> = Object.freeze([
      {
        name: 'dq/comment-open-inert',
        css: ['.a{content:"', SLASH_STAR, '"}.b{display:none}'].join(''),
        expect: { kind: 'value', out: ['.a{content:"', SLASH_STAR, '"}.b{display:none}'].join('') },
      },
      {
        name: 'dq/backslash-escape',
        css: ['.a{content:"x\\"', SLASH_STAR, '"}.b{display:none}'].join(''),
        expect: {
          kind: 'value',
          out: ['.a{content:"x\\"', SLASH_STAR, '"}.b{display:none}'].join(''),
        },
      },
      {
        name: 'EOF/in-comment',
        css: ['.a{color:red}', SLASH_STAR, ' unterminated'].join(''),
        expect: { kind: 'throw', needle: 'unterminated comment' },
      },
      {
        name: 'EOF/in-string',
        css: '.a{content:"oops}',
        expect: { kind: 'throw', needle: 'unterminated string literal' },
      },
      {
        name: 'normal/comment-open-close',
        css: [SLASH_STAR, ' x ', STAR_SLASH, ' .a{color:red}'].join(''),
        expect: { kind: 'value', out: ' .a{color:red}' },
      },
      {
        name: 'normal/no-line-comment',
        css: 'a{background:url(https://cdn/x.png);display:none}',
        expect: { kind: 'value', out: 'a{background:url(https://cdn/x.png);display:none}' },
      },
      {
        name: 'normal/bare-slash-inert',
        css: '@media (min-width:1px){.a{font:14px/1.6 monospace}}',
        expect: { kind: 'value', out: '@media (min-width:1px){.a{font:14px/1.6 monospace}}' },
      },
      {
        name: 'dq/close-then-real-comment',
        css: ['.a{content:"x"}', SLASH_STAR, ' gone ', STAR_SLASH, '.b{display:none}'].join(''),
        expect: { kind: 'value', out: '.a{content:"x"}.b{display:none}' },
      },
      {
        name: 'sq/comment-close-inert',
        css: [".a{content:'", STAR_SLASH, "'}.b{display:none}"].join(''),
        expect: { kind: 'value', out: [".a{content:'", STAR_SLASH, "'}.b{display:none}"].join('') },
      },
      {
        name: 'comment/newline-preserved',
        css: ['.a{}', SLASH_STAR, ' l1\nl2 ', STAR_SLASH, '\n.b{display:none}'].join(''),
        expect: { kind: 'value', out: '.a{}\n\n.b{display:none}' },
      },
      {
        name: 'normal/empty',
        css: '',
        expect: { kind: 'value', out: '' },
      },
    ]);

    const corpus = rb12CssStripperOracle.CSS_STRIPPER_CORPUS as ReadonlyArray<{
      name: string;
      css: string;
      expect: { kind: 'value'; out: string } | { kind: 'throw'; needle: string };
    }>;

    // TOTALITY both ways: the independent table must cover every shared cell and vice versa,
    // or a cell dropped from THIS table silently loses its second pin.
    expect(
      RB12_CORPUS_TRUTH.length,
      'the independent truth table must pin EVERY corpus cell — shrinking it re-opens the ' +
        'payload-swap bypass it exists to close',
    ).toBe(corpus.length);
    const truthNames = RB12_CORPUS_TRUTH.map((t) => t.name).sort();
    const corpusNames = corpus.map((c) => c.name).sort();
    expect(truthNames, 'independent truth-table names must equal the shared corpus names').toEqual(
      corpusNames,
    );

    for (const truth of RB12_CORPUS_TRUTH) {
      const cell = corpus.find((c) => c.name === truth.name);
      expect(cell, `kill-cell "${truth.name}" must exist in the shared corpus`).toBeDefined();
      expect(cell!.css, `kill-cell "${truth.name}"'s css must match the independent pin`).toBe(
        truth.css,
      );
      expect(
        cell!.expect.kind,
        `kill-cell "${truth.name}"'s expectation KIND must match the independent pin`,
      ).toBe(truth.expect.kind);
      if (truth.expect.kind === 'value' && cell!.expect.kind === 'value') {
        expect(
          cell!.expect.out,
          `kill-cell "${truth.name}"'s expected VALUE was corrupted relative to the ` +
            'independent pin',
        ).toBe(truth.expect.out);
      } else if (truth.expect.kind === 'throw' && cell!.expect.kind === 'throw') {
        expect(
          cell!.expect.needle,
          `kill-cell "${truth.name}"'s expected THROW NEEDLE was corrupted relative to the ` +
            'independent pin',
        ).toBe(truth.expect.needle);
      }
    }
  });

  // MEASURED BYPASS (rb-12 red-team, Finding 1): RB12-G1 text-scans for a local DEFINITION and
  // counts import lines, and RB12-G2/G3/G5/G6 exercise the oracle EXPORT directly. None of them
  // pinned that `parseCssRules` — the file's only real consumer, and the path the shipped
  // `styles.css` scan actually travels — still CALLS the imported symbol. A differently-named
  // local stripper plus a one-word repoint of `parseCssRules`'s call site kept ALL 25 tests green
  // while `findIdSelectors` silently swallowed a whole `#id` rule. Declaration, import and
  // invocation are three different facts; this gate pins the third.
  //
  // TWO independent halves on purpose. The source pin catches a repoint even when no fixture
  // happens to discriminate; the behavioural probe catches a stripper that is still NAMED
  // correctly but is wrong, and proves the path is live rather than merely spelled.
  it('RB12-G7: parseCssRules resolves to the imported owner — proven live', () => {
    // HALF 1 (the region pin on `parseCssRules`' own call site) MOVED to
    // evals/a11y-static-shell.eval.mjs (T-REGION1/2/3) with rb-15, because the function it pins
    // now lives there. It was NOT deleted: the bypass it closes — a differently-named local
    // stripper plus a one-word repoint — survives the move verbatim, one file over. Half 2 below
    // is unchanged and still works through the import.
    // --- half 2: the same path, proven live and correct end-to-end ---
    // Each probe embeds a discriminating cell BEFORE a pinned #id rule. Under the correct oracle
    // the string/comment is inert and the id stays visible; under a naive or escape-blind stripper
    // the embedded comment-opener swallows the rest of the stylesheet and the id VANISHES —
    // findIdSelectors would report a clean file, the only failure direction that matters.
    const PROBE_ID = '#rb12-callsite-probe';
    for (const cellName of ['dq/comment-open-inert', 'dq/backslash-escape']) {
      const cell = (
        rb12CssStripperOracle.CSS_STRIPPER_CORPUS as ReadonlyArray<{ name: string; css: string }>
      ).find((c) => c.name === cellName);
      expect(cell, `probe cell "${cellName}" must exist in the shared corpus`).toBeDefined();
      const offenders = rb12CssStripperOracle.findIdSelectors(`${cell!.css}${PROBE_ID}{color:red}`);
      expect(
        offenders,
        `KILLS: a stripper that loses the string boundary on "${cellName}" — the ${PROBE_ID} rule ` +
          'after it is swallowed and findIdSelectors reports a clean stylesheet',
      ).toEqual([PROBE_ID]);
    }
  });
});

// =============================================================================
// RB15 (R-m23-s10-X18 / [A11Y-CSSOWN2]) — CSS ORACLE SINGLE OWNERSHIP
//
// HARD CONSTRAINTS THIS BLOCK OBEYS — check them before editing anything here:
//   * NO new `import` line. The rb-15 symbols are reached through the EXISTING
//     namespace binding at `:89`. Pinned biome 2.5.1 MERGES same-specifier
//     imports, which takes RB12-G1's import-line count to 0 and REDs it
//     (MEASURED; recorded in ADR-0215's `Update (rb-15)` note).
//   * NO `new RegExp(...)`. This file's repo-wide rule permits only
//     String.indexOf/.includes/.split/.startsWith and hand-written character
//     walkers. Every scan below is one of those.
//   * NO literal `function findId` + `Selectors(` / `function srOnly` +
//     `IsAccessible(` anywhere in this file — not in code, not in a string, not
//     in a comment. Every needle below is ASSEMBLED from fragments, which is
//     also what stops an assertion literal from satisfying the needle it hunts.
//   * NO `.skipIf(`, `.runIf(`, `.each([])`, `.for([])` anywhere in this file —
//     the eval's extended-suspension clause bans them over this exact file.
//   * NO second `Number.parseInt(e.raw, 10) > 0` and no second
//     `const badTabindex = tabindexEls`: `keyboard-operable-rows.eval.mjs:3808`
//     occurrence-counts both at exactly 1.
// =============================================================================

// ===========================================================================
// RB15 (R-m23-s10-X18): evals/a11y-static-shell.eval.mjs becomes the SOLE OWNER
// of the CSS oracle — `parseCssRules`, `findIdSelectors`, `srOnlyIsAccessible`
// and their private helpers — exactly as ADR-0215 already made it the sole owner
// of `stripCssComments`. This file keeps ZERO local copies and reaches all of
// them through the EXISTING namespace import declared above.
//
// THREE CLAUSES, ALL REQUIRED (red-team MEASURED that no two suffice: seven
// shipping-plausible second oracles beat a shape ban alone AND all four retained
// delegation needles AND the eval's file walk, producing an end-to-end FALSE
// GREEN — 42 checks, 0 red — on a deliberately poisoned stylesheet that the
// honest oracle reports as carrying `#help-overlay` plus a `display:none`
// `.sr-only`):
//   (a) SHAPE BAN            — RB15-G1
//   (b) OCCURRENCE CENSUS    — RB15-G4
//   (c) NAMESPACE INTEGRITY  — RB15-G4
// RB15-G2 executes the shared fixture tables; RB15-G3 is the two-source roster
// pin that stops a table row being deleted from both tiers in one edit.
// ===========================================================================

/**
 * The nine symbols rb-15 moves out of this file. ASSEMBLED from fragments so
 * this list itself can never satisfy any needle built from it — the same device
 * RB12-G1 uses at `:2589`.
 *
 * The first three are the criterion's named oracles; the other six are the
 * private helpers they layer on. Banning only the public three is not an
 * ownership gate: a local `parseDeclarations` twin re-creates the `!important` /
 * case-folding / string-awareness defect class one call deeper, where no
 * exported name is involved at all.
 */
const RB15_MOVED_SYMBOLS: readonly string[] = Object.freeze([
  ['parseCss', 'Rules'].join(''),
  ['findId', 'Selectors'].join(''),
  ['srOnly', 'IsAccessible'].join(''),
  ['preludeHas', 'UnquotedHash'].join(''),
  ['selectorTargets', 'SrOnly'].join(''),
  ['parse', 'Declarations'].join(''),
  ['strip', 'Important'].join(''),
  ['firstTopLevel', 'Colon'].join(''),
  ['hasMeaningful', 'Clip'].join(''),
]);

/** The namespace binding declared at `:89` — the ONLY legal route to the symbols above. */
const RB15_OWNER_NS = ['rb12Css', 'StripperOracle'].join('');

/**
 * Symbols that DELIBERATELY STAY in this file (the parked `[A11Y-07]` cascade/surface halves,
 * `R-rb15-CASCADE`) plus the artefact reader they and A6b/A7b share.
 *
 * They cannot be on `RB15_MOVED_SYMBOLS` — that roster demands ZERO definitions — but they need
 * the mirror-image pin: EXACTLY ONE definition each. MEASURED (red-team, rb-15 artifact pass) that
 * without it, two lines shadow the whole `[A11Y-07]` surface with every gate green:
 * `const readStylesCss = (): string => '.sr-only{position:absolute;clip-path:inset(50%)}'`
 * declared inside the describe makes the real-file scan read a two-declaration stub, and a renamed
 * `cssSelectorScan` twin plus `void findCascadeReachingSelectors(css)` keeps every needle green
 * while the assertion reads the twin. The eval has NO counterpart for these two functions, so this
 * file is the only place that pin can live.
 */
const RB15_PARKED_SYMBOLS: readonly string[] = Object.freeze([
  ['findCascade', 'ReachingSelectors'].join(''),
  ['importsAnother', 'Stylesheet'].join(''),
  ['readStyles', 'Css'].join(''),
]);

/** The three symbols this file must still CALL, or "single ownership" is satisfied by
 *  deleting the call sites rather than by delegating them. */
const RB15_LIVE_CONSUMERS: readonly string[] = Object.freeze([
  ['parseCss', 'Rules'].join(''),
  ['findId', 'Selectors'].join(''),
  ['srOnly', 'IsAccessible'].join(''),
]);

/** JS identifier characters. `charAt` out of range returns '', which is correctly not one. */
function rb15IsWordChar(ch: string): boolean {
  if (ch === '') return false;
  if (ch >= 'a' && ch <= 'z') return true;
  if (ch >= 'A' && ch <= 'Z') return true;
  if (ch >= '0' && ch <= '9') return true;
  return ch === '_' || ch === '$';
}

/** Every WHOLE-WORD occurrence index of `name` in `src`. Whole-word matters in BOTH
 *  directions: without it `findIdSelectorsV2` would read as a legal occurrence of the
 *  moved symbol, and `myParseCssRules` as an illegal one. */
function rb15WordOccurrences(src: string, name: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(name, from);
    if (at === -1) return out;
    from = at + 1;
    const before = at === 0 ? '' : src.charAt(at - 1);
    const after = src.charAt(at + name.length);
    if (!rb15IsWordChar(before) && !rb15IsWordChar(after)) out.push(at);
  }
}

/** 1-based line number of `idx`, so a failure message names a line a reader can open. */
function rb15LineNo(src: string, idx: number): number {
  let line = 1;
  let at = src.indexOf('\n');
  while (at !== -1 && at < idx) {
    line += 1;
    at = src.indexOf('\n', at + 1);
  }
  return line;
}

/** True when `idx` sits on a line whose first non-space token is `import`. */
function rb15IsImportLine(src: string, idx: number): boolean {
  const lineStart = src.lastIndexOf('\n', idx - 1) + 1;
  const nl = src.indexOf('\n', idx);
  const lineEnd = nl === -1 ? src.length : nl;
  return src.slice(lineStart, lineEnd).trim().indexOf('import') === 0;
}

/** The next character after `from` that is neither a space nor a tab. */
function rb15NextSignificant(src: string, from: number): string {
  let i = from;
  while (i < src.length && (src.charAt(i) === ' ' || src.charAt(i) === '\t')) i += 1;
  return src.charAt(i);
}

/**
 * CLAUSE (a) — the SHAPE BAN. Local DEFINITIONS of a moved symbol, in the two
 * shapes a definition can take without becoming a member of some object:
 *   LOCAL-DEF    `function NAME(`
 *   LOCAL-ASSIGN `NAME =` (any binder, or a bare re-assignment) and `NAME:`
 *                (an object-literal or class-property definition)
 *
 * The `NAME =` / `NAME:` scan deliberately does NOT exclude a preceding `.`:
 * `rb12CssStripperOracle.findIdSelectors = bad` monkey-patches the namespace
 * itself, which the census in RB15-G4 reads as a perfectly legal member access.
 * (It also throws at runtime on a frozen ES module namespace — but a gate that
 * relies on the runtime to notice is not a gate.)
 *
 * `src` must be COMMENT-stripped with strings INTACT. A moved symbol's name
 * appearing inside a string literal is therefore a FALSE RED; that is the safe
 * direction and it is deliberate — ADR-0215 records the same call. What is never
 * tolerated is the reverse.
 *
 * DELIBERATE GAPS, closed by the census in RB15-G4 rather than by widening this
 * scan (a wider matcher is a looser matcher — measured, elsewhere in this repo):
 * `function  NAME (` with irregular spacing, and an `=` separated from the name
 * by a NEWLINE. Both leave a bare whole-word occurrence with no
 * `rb12CssStripperOracle.` in front of it, which clause (b) refuses.
 */
function rb15ShapeBanViolations(src: string, names: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of names) {
    const defNeedle = ['function ', name, '('].join('');
    const defCount = src.split(defNeedle).length - 1;
    if (defCount > 0) found.push(`LOCAL-DEF ${name} x${defCount}`);

    let assignCount = 0;
    for (const at of rb15WordOccurrences(src, name)) {
      const next = rb15NextSignificant(src, at + name.length);
      if (next === ':') {
        assignCount += 1;
        continue;
      }
      if (next !== '=') continue;
      // `==` / `===` are COMPARISONS, not definitions. `=>` is an arrow whose PARAMETER is
      // named after a moved symbol, which IS a shadowing definition, so it is counted.
      const eqAt = src.indexOf('=', at + name.length);
      if (src.charAt(eqAt + 1) === '=') continue;
      assignCount += 1;
    }
    if (assignCount > 0) found.push(`LOCAL-ASSIGN ${name} x${assignCount}`);
  }
  return found;
}

/**
 * CLAUSES (b) + (c) — the OCCURRENCE CENSUS and NAMESPACE INTEGRITY.
 *
 * (b) EVERY whole-word occurrence of a moved symbol must be immediately preceded
 *     by `rb12CssStripperOracle.`, or lie inside the import statement that
 *     declares that binding. This catches the five second-oracle shapes a
 *     definition-shape blacklist structurally cannot see, because none of them is
 *     a `function` declaration or a bare assignment: object-method shorthand, an
 *     object-literal arrow property, a class static method, a getter, and a
 *     complete twin in a sibling file (that last one is the eval's T-OWN walk,
 *     which applies this same predicate over `client/src` INCLUDING `*.test.ts`).
 * (c) The identifier `rb12CssStripperOracle` must ALWAYS be followed by `.`
 *     outside its own import line. `{...ns,`, `Object.assign(_, ns)` and
 *     `const o = ns` are each followed by `,`, `)` or whitespace, and each of them
 *     produces a MUTABLE copy of the namespace whose members clause (b) then
 *     happily certifies. MEASURED: `{...ns, findIdSelectors: bad}` passed every
 *     other clause in this slice.
 *
 * `src` must be comment-AND-string-stripped — see `rb15StripJsStrings`.
 */
function rb15CensusViolations(src: string, names: readonly string[], ns: string): string[] {
  const found: string[] = [];
  const dotted = `${ns}.`;
  for (const name of names) {
    for (const at of rb15WordOccurrences(src, name)) {
      if (at >= dotted.length && src.slice(at - dotted.length, at) === dotted) continue;
      if (rb15IsImportLine(src, at)) continue;
      found.push(`MEMBER-ACCESS-MISSING ${name} @${rb15LineNo(src, at)}`);
    }
  }
  for (const at of rb15WordOccurrences(src, ns)) {
    if (rb15IsImportLine(src, at)) continue;
    const after = src.charAt(at + ns.length);
    if (after === '.') continue;
    found.push(`NAMESPACE-ESCAPE @${rb15LineNo(src, at)} followed by ${JSON.stringify(after)}`);
  }
  return found;
}

/** How many times `name` appears as an honest `rb12CssStripperOracle.NAME` member access. */
function rb15MemberAccessCount(src: string, name: string, ns: string): number {
  const dotted = `${ns}.`;
  let n = 0;
  for (const at of rb15WordOccurrences(src, name)) {
    if (at >= dotted.length && src.slice(at - dotted.length, at) === dotted) n += 1;
  }
  return n;
}

/**
 * Blank the CONTENTS of every string and template literal, keeping the delimiters
 * (so `'x'` becomes `''`) and every newline (so line numbers in a failure detail
 * stay usable). Input MUST already be comment-stripped by `rb12StripJsComments`.
 *
 * WHY THIS IS FILE-LOCAL AND NOT AN IMPORT. `evals/overlay-a11y-manifest.eval.mjs`
 * exports `stripTsCommentsAndStrings`, which does very nearly this, and it is
 * deliberately NOT used: RB15-G1 and RB15-G4 are SELF-REFERENTIAL gates, and a
 * self-referential gate must never ask another module to tell the truth about
 * THIS file's own bytes. That is the identical reasoning that keeps
 * `rb12StripJsComments` local at `:2512`. The duplication is the point,
 * permanently, and this paragraph is the reason written inline so that a later
 * reader tidying up duplicate strippers does not "consolidate" it away.
 *
 * WHY STRINGS MUST GO AT ALL: a decoy inside a string literal must be a FALSE RED
 * for the shape ban (safe direction, kept) but must never be a FALSE GREEN for the
 * census. Blanking string bodies means the census sees only EXECUTABLE positions,
 * so `{ findIdSelectors: bad }` is judged as the definition it is while the same
 * name inside a failure message is judged as the prose it is.
 *
 * `${...}` SUBSTITUTIONS ARE BLANKED TOO, which is the one thing this loses
 * relative to a full template parser. Safe and deliberate: blanking can only ever
 * REMOVE occurrences from the census, and the shape ban (which runs on
 * strings-INTACT source) still sees anything parked in there. Writing a brace
 * matcher for nested template literals is a measured foot-gun in this repo and
 * buys nothing here.
 *
 * FAIL-LOUD AT EOF, the same rule as every other scanner in this file: an
 * unbalanced quote means the walk desynchronised, and a desynchronised walk that
 * returns a best-effort string reports "no violations" for entirely the wrong
 * reason. THIS SCANNER IS NOT REGEX-LITERAL AWARE, and the EOF throw alone is NOT
 * enough: MEASURED (red-team, rb-15 artifact pass) that the throw fires only on an
 * ODD quote count, so TWO regexes each carrying one quote RESYNCHRONISE and the
 * whole span between them is blanked with no error — restoring the object-method
 * shorthand twin this census exists to catch. `rb15AssertNoHazardousRegex` above is
 * what actually closes it, and RB15-G1/RB15-G4 call it BEFORE they scan. Do not
 * weaken either half: the EOF throw catches the odd case, the tripwire the even one.
 */
/** Characters that make a REGEX LITERAL hazardous to every comment/string scanner in this file. */
const RB15_REGEX_HAZARDS: readonly string[] = Object.freeze(['*', '/', "'", '"', '`']);

/**
 * Characters after which a `/` is DIVISION or markup, never the start of a regex literal.
 *
 * `<` and `>` are here for the ONE reason worth writing down: this file quotes HTML in failure
 * messages (`the unclosed-</div> tooth`), and the tripwire runs on strings-intact source, so
 * without them every closing tag reads as an unterminated regex and this gate REDs on its own
 * prose. A regex literal in a comparison position (`a > /re/.test(b)`) is not a shape any code
 * here writes, so the exclusion costs nothing.
 */
const RB15_NOT_REGEX_START = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$)]<>';

/**
 * FAIL LOUD on a regex literal that would desynchronise the comment/string scanners.
 *
 * MEASURED (red-team, rb-15 artifact pass): `rb12StripJsComments` treats the `/` + `*` inside a
 * `/[/*]/` character class as a real block-comment opener and blanks everything to the next
 * `*` + `/` WITH NO THROW; `rb15StripJsStrings` treats a quote inside a `/['"]/` class as a string
 * opener and only throws at EOF, so TWO such regexes RESYNCHRONISE and the whole span between them
 * is blanked silently. Either one hides an arbitrary region from RB15-G1 and RB15-G4 at once — a
 * full FALSE GREEN, measured end-to-end with a poisoned stylesheet and a re-pasted oracle, and
 * biome-clean. The EOF throw catches the odd-quote case; this catches the even one and the
 * comment-opener one.
 *
 * LINE-LOCAL BY CONSTRUCTION, which is what keeps it from needing the very lexer it is guarding.
 * Each line is scanned independently: quoted spans are blanked using quote matching WITHIN THE
 * LINE (so this file's own `['/', '*'].join('')` hygiene constants are text, not regexes), then
 * any surviving `/` in a regex-start position must terminate on that same line and carry none of
 * the hazardous characters. A desynchronised scanner cannot propagate past one line here.
 *
 * It DELIBERATELY OVER-APPROXIMATES — a multi-line template literal is judged line by line, so an
 * unusual line inside one could red. Over-approximation is the safe direction: a scanner that gave
 * up must never be indistinguishable from a scanner that found nothing. If this throws on a
 * legitimate new regex, rewrite the regex (or use `indexOf`); do not delete the tripwire.
 */
function rb15AssertNoHazardousRegex(src: string, label: string): void {
  const lines = src.split('\n');
  for (let ln = 0; ln < lines.length; ln += 1) {
    // --- 1. blank quoted spans, LINE-LOCALLY.
    const raw = lines[ln] ?? '';
    let code = '';
    let quote = '';
    for (let k = 0; k < raw.length; k += 1) {
      const c = raw.charAt(k);
      if (quote !== '') {
        if (c === '\\') {
          k += 1;
          continue;
        }
        if (c === quote) quote = '';
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c;
        continue;
      }
      code += c;
    }
    // --- 2. any surviving `/` in a regex-start position must close on this line, hazard-free.
    let prev = '';
    let i = 0;
    while (i < code.length) {
      const ch = code.charAt(i);
      if (ch !== '/' || RB15_NOT_REGEX_START.indexOf(prev) !== -1) {
        if (ch !== ' ' && ch !== '\t') prev = ch;
        i += 1;
        continue;
      }
      const after = code.charAt(i + 1);
      if (after === '' || after === ' ' || after === '\t' || after === '=') {
        prev = '/';
        i += 1;
        continue;
      }
      let j = i + 1;
      let inClass = false;
      let body = '';
      let closed = false;
      while (j < code.length) {
        const c = code.charAt(j);
        if (c === '\\') {
          body += c + code.charAt(j + 1);
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          break;
        }
        body += c;
        j += 1;
      }
      if (!closed) {
        throw new Error(
          `RB15 REGEX TRIPWIRE (${label}) line ${ln + 1}: an apparent regex literal does not ` +
            'terminate on its own line. The comment/string scanners would desynchronise and ' +
            `report zero violations for entirely the wrong reason. Line: ${JSON.stringify(raw)}`,
        );
      }
      const hazards = RB15_REGEX_HAZARDS.filter((h) => body.indexOf(h) !== -1);
      if (hazards.length > 0) {
        throw new Error(
          `RB15 REGEX TRIPWIRE (${label}) line ${ln + 1}: the regex literal carries ` +
            `${JSON.stringify(hazards)}, which desynchronises the comment/string scanners and ` +
            'blanks an arbitrary span from the ownership census. Rewrite it (or use indexOf). ' +
            `Line: ${JSON.stringify(raw)}`,
        );
      }
      i = j + 1;
      prev = '/';
    }
  }
}

function rb15StripJsStrings(src: string): string {
  let out = '';
  let i = 0;
  const len = src.length;
  let state: 'normal' | 'sq' | 'dq' | 'tl' = 'normal';
  while (i < len) {
    const ch = src.charAt(i);
    if (state === 'normal') {
      if (ch === "'") state = 'sq';
      else if (ch === '"') state = 'dq';
      else if (ch === '`') state = 'tl';
      out += ch;
      i += 1;
      continue;
    }
    const closer = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (ch === '\\' && i + 1 < len) {
      i += 2;
      continue;
    }
    if (ch === closer) {
      out += ch;
      state = 'normal';
      i += 1;
      continue;
    }
    if (ch === '\n') out += '\n';
    i += 1;
  }
  if (state !== 'normal') {
    throw new Error(
      `RB15 STRIPPER DESYNC: unterminated ${state} literal at end of input. The census would ` +
        'be scanning a truncated file and would report zero violations for the wrong reason. ' +
        'The usual cause is a newly-added regex literal containing a quote character.',
    );
  }
  return out;
}

/** This file's own source, read exactly the way RB12-G1 reads it (`:2579`). */
function rb15ReadSelfSource(): string {
  const selfPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'indexShell.test.ts');
  try {
    return readFileSync(selfPath, 'utf8');
  } catch (err) {
    throw new Error(`indexShell.test.ts could not read its own source at ${selfPath} — ${err}`);
  }
}

/** Row shape of the shared id-selector table exported by the owner module. */
interface Rb15IdFixtureRow {
  readonly name: string;
  readonly kind: string;
  readonly css: string;
  readonly offenders: readonly string[];
  readonly kills: string;
}

/** Row shape of the shared `.sr-only` table exported by the owner module. */
interface Rb15SrFixtureRow {
  readonly name: string;
  readonly kind: string;
  readonly css: string;
  readonly reasons: readonly string[];
  readonly kills: string;
}

describe('RB15 (R-m23-s10-X18): CSS oracle single ownership', () => {
  it('RB15-G1: indexShell.test.ts defines ZERO local copies of the moved CSS oracle', () => {
    // --- RED CONTROLS FIRST, over inline fixtures, so BOTH halves of the detector are proven
    // to bite before it is ever pointed at the real file. This is not ceremony: the PRE-MOVE
    // tree yields ELEVEN LOCAL-DEF hits and ZERO LOCAL-ASSIGN hits, so without these fixtures
    // the whole assignment half would ship having never fired in EITHER state of the tree.
    // Every needle is assembled from fragments so the fixture strings cannot trip the scan
    // when it is later run over this file's own bytes (strings are intact there, on purpose).
    const CONTROL_DEF = ['function findId', 'Selectors(src) { return []; }'].join('');
    const CONTROL_ASSIGN = ['const srOnly', 'IsAccessible = (src) => ({ ok: true });'].join('');
    const CONTROL_COMMENT_DECOY = [
      '// the owner module defines function findId',
      'Selectors( — this line is PROSE, not a definition\n.a{}',
    ].join('');

    expect(
      rb15ShapeBanViolations(rb12StripJsComments(CONTROL_DEF), RB15_MOVED_SYMBOLS),
      'RED CONTROL (LOCAL-DEF): the shape ban must FLAG a re-pasted function declaration. If ' +
        'this is empty the ban is inert, the real-file assertion below is satisfied by a ' +
        'scanner that never matches anything, and bite-proof M1 (re-paste the oracle) passes.',
    ).toEqual([`LOCAL-DEF ${RB15_MOVED_SYMBOLS[1]} x1`]);

    expect(
      rb15ShapeBanViolations(rb12StripJsComments(CONTROL_ASSIGN), RB15_MOVED_SYMBOLS),
      'RED CONTROL (LOCAL-ASSIGN): the shape ban must FLAG a const/arrow re-definition. The ' +
        'pre-move tree contains ZERO of these, so this half of the detector has no natural ' +
        'exercise anywhere in the repo — bite-proof M3 is exactly what it exists for.',
    ).toEqual([`LOCAL-ASSIGN ${RB15_MOVED_SYMBOLS[2]} x1`]);

    expect(
      rb15ShapeBanViolations(rb12StripJsComments(CONTROL_COMMENT_DECOY), RB15_MOVED_SYMBOLS),
      'GREEN CONTROL (comment decoy): a moved symbol NAMED IN PROSE must NOT be a violation. ' +
        'Without comment stripping this gate reds on its own documentation, gets "fixed" by ' +
        'deleting the explanation, and the next reader re-creates the twin — bite-proof M2.',
    ).toEqual([]);

    // --- THE REAL FILE. Comment-stripped, strings INTACT.
    const stripped = rb12StripJsComments(rb15ReadSelfSource());
    // TRIPWIRE FIRST. A `/[/*]/`-shaped regex literal makes rb12StripJsComments blank an
    // arbitrary span WITH NO THROW, hiding a re-pasted oracle from the scan below. MEASURED
    // end-to-end (red-team, rb-15 artifact pass): biome-clean, 28/28 green, poisoned stylesheet.
    rb15AssertNoHazardousRegex(stripped, 'RB15-G1');
    const violations = rb15ShapeBanViolations(stripped, RB15_MOVED_SYMBOLS);
    expect(
      violations,
      'KILLS: a local re-definition of any moved CSS-oracle symbol surviving in this file. ' +
        `evals/a11y-static-shell.eval.mjs is the SOLE owner of ${RB15_MOVED_SYMBOLS.join(', ')} ` +
        '(R-m23-s10-X18, the same ruling ADR-0215 made for the comment stripper). A second ' +
        'copy here is the drift this slice exists to delete, and the drift is invisible by ' +
        'construction: each tier keeps passing against its own idea of what a CSS rule is, ' +
        'so a poisoned stylesheet ships green in both. Found: ' +
        JSON.stringify(violations),
    ).toEqual([]);

    // --- THE MIRROR-IMAGE PIN for the PARKED [A11Y-07] halves (R-rb15-CASCADE).
    // `RB15_MOVED_SYMBOLS` demands ZERO definitions; these demand EXACTLY ONE. MEASURED
    // (red-team, rb-15 artifact pass) that without it two lines shadow the whole [A11Y-07]
    // surface with every gate green: a `const readStylesCss = () => '<stub css>'` inside the
    // describe makes the real-file scan read a two-declaration stub, and a renamed twin plus a
    // `void`-discarded honest call keeps every delegation needle green. The eval has NO
    // counterpart for these two functions, so this file is the only place the pin can live.
    const parked = RB15_PARKED_SYMBOLS.map(
      (name) => `${name} x${rb15ShapeBanViolations(stripped, [name]).length}`,
    );
    expect(
      parked,
      'KILLS: a SHADOW or a SECOND definition of the parked [A11Y-07] halves, or of the ' +
        'artefact reader they share with A6b/A7b. Exactly one definition each: zero means the ' +
        'oracle left this file without a replacement, two means an inner scope is answering ' +
        'the assertions while the module-level original is never called. Found: ' +
        JSON.stringify(parked),
    ).toEqual(RB15_PARKED_SYMBOLS.map((name) => `${name} x1`));
  });

  it('RB15-G2: every shared CSS-oracle fixture row runs IN FULL in the vitest tier, exact outcomes', () => {
    const idRows = rb12CssStripperOracle.ID_SELECTOR_FIXTURES as ReadonlyArray<Rb15IdFixtureRow>;
    const srRows = rb12CssStripperOracle.SR_ONLY_FIXTURES as ReadonlyArray<Rb15SrFixtureRow>;

    // ANTI-VACUITY, ASSERTED FIRST (this file's house rule): an empty or unexported table
    // makes every loop below a no-op and this whole gate a green that proves nothing. The
    // Array.isArray pair comes first so a MISSING export reds with the name of the export
    // rather than with a TypeError about `undefined`.
    expect(
      Array.isArray(idRows),
      'the owner module must EXPORT ID_SELECTOR_FIXTURES — rb-15 makes ' +
        'evals/a11y-static-shell.eval.mjs the single source of both fixture tables, run in ' +
        'full by BOTH tiers.',
    ).toBe(true);
    expect(Array.isArray(srRows), 'the owner module must EXPORT SR_ONLY_FIXTURES.').toBe(true);
    expect(
      idRows.length,
      'ANTI-VACUITY: the shared id-selector table is empty or was not exported — every ' +
        'assertion below would be skipped and this gate would pass over a deleted oracle.',
    ).toBeGreaterThan(0);
    expect(
      srRows.length,
      'ANTI-VACUITY: the shared .sr-only table is empty or was not exported.',
    ).toBeGreaterThan(0);

    let idBad = 0;
    let idGood = 0;
    for (const row of idRows) {
      expect(
        row.kind === 'bad' || row.kind === 'good',
        `row "${row.name}" has an unrecognised kind ${JSON.stringify(row.kind)} — a typo here ` +
          'would route the row past both branches and leave it silently unexecuted.',
      ).toBe(true);

      const offenders = rb12CssStripperOracle.findIdSelectors(row.css);
      if (row.kind === 'good') {
        idGood += 1;
        expect(
          row.offenders,
          `table integrity: GOOD row "${row.name}" must pin an EMPTY offender list.`,
        ).toEqual([]);
        expect(
          offenders,
          `GOOD row "${row.name}" must be ACCEPTED. Kills: ${row.kills}. A false RED here is ` +
            'how the scanner gets weakened until the BAD half stops biting. css=' +
            JSON.stringify(row.css),
        ).toEqual([]);
        continue;
      }
      idBad += 1;
      expect(
        row.offenders.length,
        `table integrity: BAD row "${row.name}" pins an EMPTY offender list, so it asserts the ` +
          'same thing a GOOD row does and can never bite.',
      ).toBeGreaterThan(0);
      // THE EXACT ARRAY, order included. `toContain` would let a scanner that reports EVERY
      // prelude — the constant-true dual of the `() => []` stub — pass all eight BAD rows.
      expect(
        offenders,
        `BAD row "${row.name}" must be FLAGGED with its EXACT offender list. Kills: ` +
          `${row.kills}. css=${JSON.stringify(row.css)}`,
      ).toEqual([...row.offenders]);
    }

    let srBad = 0;
    let srGood = 0;
    for (const row of srRows) {
      expect(
        row.kind === 'bad' || row.kind === 'good',
        `row "${row.name}" has an unrecognised kind ${JSON.stringify(row.kind)}.`,
      ).toBe(true);

      const verdict = rb12CssStripperOracle.srOnlyIsAccessible(row.css);
      if (row.kind === 'good') {
        srGood += 1;
        expect(
          row.reasons,
          `table integrity: GOOD row "${row.name}" must pin an EMPTY reason set.`,
        ).toEqual([]);
        expect(
          verdict.reasons,
          `GOOD row "${row.name}" must be ACCEPTED with NO reasons. Kills: ${row.kills}. css=` +
            JSON.stringify(row.css),
        ).toEqual([]);
        expect(
          verdict.ok,
          `GOOD row "${row.name}" must report ok === true. Kills: ${row.kills}.`,
        ).toBe(true);
        continue;
      }
      srBad += 1;
      expect(
        row.reasons.length,
        `table integrity: BAD row "${row.name}" pins an EMPTY reason set — it would then be ` +
          'indistinguishable from a GOOD row and could never bite.',
      ).toBeGreaterThan(0);
      // THE EXACT REASON SET, sorted — NEVER `.includes(reason)`. MEASURED (red-team R3): a
      // constant-fail oracle returning EVERY reason for EVERY input survives all fifteen BAD
      // rows under `.includes`, so the entire kill came from the GOOD half; and
      // MIN_SR_ONLY_DECLARATIONS = 0 survived every tooth in the slice, because the floor only
      // ever appears as an EXTRA reason that no membership test can see.
      expect(
        [...verdict.reasons].sort(),
        `BAD row "${row.name}" must be rejected for EXACTLY the pinned reasons — a superset is ` +
          'a constant-fail oracle and a subset is a missing clause. Kills: ' +
          `${row.kills}. css=${JSON.stringify(row.css)}`,
      ).toEqual([...row.reasons].sort());
      expect(
        verdict.ok,
        `BAD row "${row.name}" must report ok === false. Kills: ${row.kills}.`,
      ).toBe(false);
    }

    // BOTH HALVES OF BOTH TABLES MUST HAVE RUN. A table trimmed to GOOD rows only passes a
    // constant-empty oracle; one trimmed to BAD rows only passes a constant-fail one.
    expect(
      [idBad > 0, idGood > 0, srBad > 0, srGood > 0],
      'ANTI-VACUITY: each shared table must contribute BOTH a BAD and a GOOD execution. ' +
        `Counted idBad=${idBad} idGood=${idGood} srBad=${srBad} srGood=${srGood}.`,
    ).toEqual([true, true, true, true]);
  });

  it('RB15-G3: the shared fixture rosters and a LOCALLY re-declared copy agree, both directions, exact counts', () => {
    // RE-DECLARED INDEPENDENTLY — deliberately NOT imported, the shipped RB12-G3 pattern
    // (`:2649`). Deleting or renaming a row in the owner module cannot satisfy this gate at
    // the same time as the owner's own table-integrity tooth: two independent sources must
    // agree. A length FLOOR alone is explicitly rejected — it admits duplicate-name padding,
    // and it admits swapping one row's payload for another's while the name set stays intact
    // (rb-12 red-team Finding 2, measured).
    const RB15_LOCAL_ID_FIXTURE_NAMES: readonly string[] = Object.freeze([
      'id/bad/baseline-pinned-id',
      'id/bad/selector-list-second-position',
      'id/bad/descendant-part',
      'id/bad/media-nested',
      'id/bad/glued-to-type-selector',
      'id/bad/hash-colour-before-id-rule',
      'id/bad/commented-decoy-plus-real',
      'id/bad/string-decoy-then-real',
      'id/good/hex-colour-in-nested-decl',
      'id/good/escaped-hash-in-class-name',
      'id/good/hash-in-quoted-value',
      'id/good/url-fragment-reference',
      'id/good/at-rule-prelude-hash',
      'id/good/quoted-hash-in-prelude',
    ]);
    const RB15_LOCAL_SR_FIXTURE_NAMES: readonly string[] = Object.freeze([
      'sr/bad/display-none',
      'sr/bad/display-none-important',
      'sr/bad/visibility-hidden-important-spaced',
      'sr/bad/inert-clip-pair',
      'sr/bad/content-visibility-hidden',
      'sr/bad/display-contents',
      'sr/bad/visibility-hidden-with-correct-pair',
      'sr/bad/clip-only-no-position',
      'sr/bad/position-only-no-clip',
      'sr/bad/space-around-colon',
      'sr/bad/uppercase-property-and-value',
      'sr/bad/media-nested-display-none',
      'sr/bad/correct-then-media-override',
      'sr/bad/rule-missing-entirely',
      'sr/bad/empty-rule',
      'sr/bad/min-declaration-floor',
      'sr/good/shipped-clip-path-form',
      'sr/good/legacy-clip-rect-form',
      'sr/good/focusable-token-boundary',
      'sr/good/banned-text-inside-string',
      'sr/good/position-absolute-important',
    ]);

    expect(
      RB15_LOCAL_ID_FIXTURE_NAMES.length,
      'ANTI-VACUITY: the locally re-declared id-fixture roster must not be empty.',
    ).toBeGreaterThan(0);
    expect(
      RB15_LOCAL_SR_FIXTURE_NAMES.length,
      'ANTI-VACUITY: the locally re-declared sr-only roster must not be empty.',
    ).toBeGreaterThan(0);

    const idRows = rb12CssStripperOracle.ID_SELECTOR_FIXTURES as ReadonlyArray<Rb15IdFixtureRow>;
    const srRows = rb12CssStripperOracle.SR_ONLY_FIXTURES as ReadonlyArray<Rb15SrFixtureRow>;
    expect(
      Array.isArray(idRows) && Array.isArray(srRows),
      'the owner module must EXPORT both ID_SELECTOR_FIXTURES and SR_ONLY_FIXTURES before ' +
        'this roster can be compared against anything.',
    ).toBe(true);
    const pairs = [
      {
        label: 'ID_SELECTOR_FIXTURES',
        local: RB15_LOCAL_ID_FIXTURE_NAMES,
        shared: idRows.map((r) => r.name),
      },
      {
        label: 'SR_ONLY_FIXTURES',
        local: RB15_LOCAL_SR_FIXTURE_NAMES,
        shared: srRows.map((r) => r.name),
      },
    ];
    for (const pair of pairs) {
      const missingFromShared = pair.local.filter((n) => pair.shared.indexOf(n) === -1);
      const extraInShared = pair.shared.filter((n) => pair.local.indexOf(n) === -1);
      expect(
        missingFromShared,
        `KILLS: a row deleted from ${pair.label} while this independently-typed roster still ` +
          'names it — bite-proof M14. The owner module and this file must never silently ' +
          'drift apart, and deleting a row in ONE place must never be enough.',
      ).toEqual([]);
      expect(
        extraInShared,
        `KILLS: a row added to ${pair.label} with no counterpart here — this roster is the ` +
          'SECOND SOURCE that editing the shared table alone cannot satisfy.',
      ).toEqual([]);
      expect(
        Array.from(new Set(pair.shared)).length,
        `KILLS: DUPLICATE row names in ${pair.label} — the set equality above is satisfied by ` +
          'padding one row twice while another is deleted; only the count catches that.',
      ).toBe(pair.shared.length);
      expect(
        pair.shared.length,
        `${pair.label} must carry EXACTLY as many rows as this roster names.`,
      ).toBe(pair.local.length);
    }

    // The counts pinned as LITERALS as well. Set equality plus a matching length is satisfied
    // by shrinking BOTH lists in one edit; a literal is a third fact that edit does not carry.
    expect(pairs[0].shared.length, 'ID_SELECTOR_FIXTURES must have exactly 14 rows').toBe(14);
    expect(pairs[1].shared.length, 'SR_ONLY_FIXTURES must have exactly 21 rows').toBe(21);

    // --- PAYLOAD FINGERPRINTS, the half a NAME roster cannot see.
    // MEASURED (red-team, rb-15 artifact pass): pinning names alone let a row be SWAPPED for a
    // weaker one under the SAME name. Hollowing `sr/bad/content-visibility-hidden` to a
    // `display:none` payload, narrowing the deny-list to the two properties the criterion
    // literally names, and shipping `content-visibility:hidden` in the real `.sr-only` rule
    // (adjusted to keep declCount at 9) passed BOTH tiers with 80/80 teeth and 28/28 tests —
    // while the live region was absent from the Chromium accessibility tree. Each entry below is
    // `name:cssChars:expectationCount:expectationChars`, re-declared HERE and compared against
    // values COMPUTED from the shared table, so a payload edit must be made in two places or
    // this reds.
    const RB15_LOCAL_ID_FINGERPRINTS: readonly string[] = Object.freeze([
      'id/bad/baseline-pinned-id:24:1:13',
      'id/bad/selector-list-second-position:38:1:19',
      'id/bad/descendant-part:30:1:18',
      'id/bad/media-nested:56:1:12',
      'id/bad/glued-to-type-selector:31:1:16',
      'id/bad/hash-colour-before-id-rule:28:1:2',
      'id/bad/commented-decoy-plus-real:55:1:13',
      'id/bad/string-decoy-then-real:41:1:13',
      'id/good/hex-colour-in-nested-decl:55:0:0',
      'id/good/escaped-hash-in-class-name:21:0:0',
      'id/good/hash-in-quoted-value:29:0:0',
      'id/good/url-fragment-reference:25:0:0',
      'id/good/at-rule-prelude-hash:38:0:0',
      'id/good/quoted-hash-in-prelude:24:0:0',
    ]);
    const RB15_LOCAL_SR_FINGERPRINTS: readonly string[] = Object.freeze([
      'sr/bad/display-none:22:4:153',
      'sr/bad/display-none-important:81:1:57',
      'sr/bad/visibility-hidden-important-spaced:77:1:62',
      'sr/bad/inert-clip-pair:52:1:47',
      'sr/bad/content-visibility-hidden:74:1:73',
      'sr/bad/display-contents:65:1:63',
      'sr/bad/visibility-hidden-with-correct-pair:66:1:62',
      'sr/bad/clip-only-no-position:30:2:49',
      'sr/bad/position-only-no-clip:64:1:47',
      'sr/bad/space-around-colon:24:4:153',
      'sr/bad/uppercase-property-and-value:22:4:153',
      'sr/bad/media-nested-display-none:55:4:153',
      'sr/bad/correct-then-media-override:230:1:57',
      'sr/bad/rule-missing-entirely:17:1:16',
      'sr/bad/empty-rule:10:3:96',
      'sr/bad/min-declaration-floor:27:2:72',
      'sr/good/shipped-clip-path-form:174:0:0',
      'sr/good/legacy-clip-rect-form:46:0:0',
      'sr/good/focusable-token-boundary:207:0:0',
      'sr/good/banned-text-inside-string:71:0:0',
      'sr/good/position-absolute-important:58:0:0',
    ]);
    const idFingerprints = idRows.map(
      (r) => `${r.name}:${r.css.length}:${r.offenders.length}:${r.offenders.join('').length}`,
    );
    const srFingerprints = srRows.map(
      (r) => `${r.name}:${r.css.length}:${r.reasons.length}:${r.reasons.join('').length}`,
    );
    expect(
      idFingerprints,
      'KILLS: an ID_SELECTOR_FIXTURES row whose PAYLOAD was swapped under an unchanged name — ' +
        'the exact shape the name roster above is blind to.',
    ).toEqual([...RB15_LOCAL_ID_FINGERPRINTS]);
    expect(
      srFingerprints,
      'KILLS: an SR_ONLY_FIXTURES row whose PAYLOAD was swapped under an unchanged name. ' +
        'Measured: hollowing one row plus narrowing the deny-list ships a stylesheet whose ' +
        '.sr-only rule is absent from the accessibility tree, with every other gate green.',
    ).toEqual([...RB15_LOCAL_SR_FINGERPRINTS]);
  });

  it('RB15-G4: every moved-symbol occurrence is a member access on the owner namespace, and the namespace never escapes', () => {
    // --- FIXTURE CONTROLS FIRST. Each row is one of red-team's MEASURED second oracles: all
    // seven are biome-clean, all seven leave every retained delegation needle green, and all
    // seven beat a definition-shape blacklist because NONE of them is a `function` declaration
    // or a bare assignment. Needles are assembled from fragments so these fixtures cannot
    // themselves trip the scan when it runs over this file's own bytes.
    const NS = RB15_OWNER_NS;
    const censusControls = [
      {
        label: 'HONEST member access (must be ACCEPTED)',
        src: [NS, '.findId', 'Selectors(css)'].join(''),
        want: [] as readonly string[],
      },
      {
        label: 'C1 object-method shorthand',
        src: ['const o = { findId', 'Selectors(s) { return []; } };'].join(''),
        want: ['MEMBER-ACCESS-MISSING'] as readonly string[],
      },
      {
        label: 'C2 object-literal arrow property',
        src: ['const o = { findId', 'Selectors: (s) => [] };'].join(''),
        want: ['MEMBER-ACCESS-MISSING'] as readonly string[],
      },
      {
        label: 'C3 class static method',
        src: ['class Twin { static findId', 'Selectors(s) { return []; } }'].join(''),
        want: ['MEMBER-ACCESS-MISSING'] as readonly string[],
      },
      {
        label: 'C12 getter property',
        src: ['const o = { get findId', 'Selectors() { return bad; } };'].join(''),
        want: ['MEMBER-ACCESS-MISSING'] as readonly string[],
      },
      {
        label: 'C4 Object.assign over the namespace',
        src: ['const o = Object.assign({}, ', NS, ');'].join(''),
        want: ['NAMESPACE-ESCAPE'] as readonly string[],
      },
      {
        label: 'C8 poisoned namespace spread',
        src: ['const o = { ...', NS, ', findId', 'Selectors: bad };'].join(''),
        want: ['MEMBER-ACCESS-MISSING', 'NAMESPACE-ESCAPE'] as readonly string[],
      },
    ];
    for (const control of censusControls) {
      const labels = rb15CensusViolations(
        rb15StripJsStrings(rb12StripJsComments(control.src)),
        RB15_MOVED_SYMBOLS,
        NS,
      )
        .map((v) => v.split(' ')[0])
        .sort();
      expect(
        labels,
        `CENSUS CONTROL "${control.label}": the detector must produce EXACTLY the pinned ` +
          'violation labels. Each cheat here was MEASURED end-to-end green against the shape ' +
          'ban, all four retained delegation needles and the file walk — 42 checks, 0 red, on ' +
          'a stylesheet the honest oracle reports as carrying #help-overlay plus a ' +
          'display:none .sr-only rule.',
      ).toEqual([...control.want].sort());
    }

    // --- THE REAL FILE.
    const selfSrc = rb15ReadSelfSource();
    // TRIPWIRE FIRST — see RB15-G1. The EOF throw in rb15StripJsStrings fires only on an ODD
    // quote count, so TWO regexes each carrying one quote RESYNCHRONISE and blank the span
    // between them silently, restoring the object-method-shorthand twin. MEASURED.
    rb15AssertNoHazardousRegex(rb12StripJsComments(selfSrc), 'RB15-G4');
    const stripped = rb15StripJsStrings(rb12StripJsComments(selfSrc));

    // MODULE SPECIFIER. MEASURED (red-team, rb-15 artifact pass): NOTHING pinned the path, so
    // repointing the namespace import at a shim that re-exports the owner with ONE poisoned
    // function passed every gate in both tiers on a poisoned stylesheet. `vi.mock` of the owner
    // does the same WITHOUT TOUCHING THE IMPORT LINE AT ALL, which a diff reviewer cannot see.
    const OWNER_SPECIFIER = ['../../evals/a11y-static-', 'shell.eval.mjs'].join('');
    // Comment-stripped, strings INTACT: a specifier NAMED IN PROSE is not a route to the
    // module, but one in a string literal is exactly the route being pinned.
    const specifierCount = rb12StripJsComments(selfSrc).split(OWNER_SPECIFIER).length - 1;
    expect(
      specifierCount,
      'KILLS: the owner module resolved through any path but its own. This file must name ' +
        `${OWNER_SPECIFIER} exactly twice (the namespace import and the stripCssComments ` +
        `import) and nothing else. Found ${specifierCount}.`,
    ).toBe(2);
    const MOCK_NEEDLES = [['vi.', 'mock('].join(''), ['vi.', 'doMock('].join('')];
    const mocked = MOCK_NEEDLES.filter((n) => stripped.indexOf(n) !== -1);
    expect(
      mocked,
      'KILLS: a module mock of the owner. It substitutes the whole oracle with zero change to ' +
        `the import line, so every source pin in this file stays green. Found: ${JSON.stringify(mocked)}`,
    ).toEqual([]);

    // STRIPPER SANITY, BEFORE anything is concluded from the stripped text. A walk that
    // desynchronised truncates the file and then reports zero violations for the wrong reason.
    expect(
      stripped.indexOf(`import * as ${NS}`) !== -1,
      'STRIPPER DESYNC: the namespace import statement is absent from the stripped source, so ' +
        'the two scans below are reading a mangled file rather than this one.',
    ).toBe(true);
    const dottedCount = stripped.split(`${NS}.`).length - 1;
    expect(
      dottedCount,
      'STRIPPER DESYNC, or OWNERSHIP EVAPORATED: fewer than ten member accesses on the owner ' +
        'namespace survive stripping. RB12-G2/G3/G5/G6/G7 alone reach the owner module more ' +
        `than ten times. Found ${dottedCount}.`,
    ).toBeGreaterThanOrEqual(10);

    const violations = rb15CensusViolations(stripped, RB15_MOVED_SYMBOLS, NS);
    expect(
      violations,
      'KILLS: a second CSS oracle reached by any route other than the owner namespace — ' +
        'object-method shorthand, an object-literal arrow property, a class static method, a ' +
        'getter, or a MUTABLE copy of the namespace made by Object.assign or a spread and then ' +
        'poisoned. None of those is a `function` declaration, so RB15-G1 cannot see any of ' +
        'them, and every one of them keeps all four delegation needles green. Found: ' +
        JSON.stringify(violations),
    ).toEqual([]);

    // LIVENESS. "Zero local copies" is ALSO satisfied by deleting every call site, which is
    // ownership without delegation — the failure mode that leaves [A11Y-06]/[A11Y-07] gated by
    // nothing in THIS tier while the eval still passes on its own fixtures.
    for (const name of RB15_LIVE_CONSUMERS) {
      expect(
        rb15MemberAccessCount(stripped, name, NS),
        `KILLS: ${name} no longer CALLED from this file at all. Single ownership is satisfied ` +
          'by deleting the consumer as surely as by delegating it, and a deleted consumer is ' +
          'exactly how the real-artefact scan of client/src/styles.css stops running here.',
      ).toBeGreaterThanOrEqual(1);
    }
  });
});
