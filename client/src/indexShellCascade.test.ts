// indexShellCascade.test.ts — the COMPUTED-CASCADE DIFFERENTIAL oracle for criterion A11Y-12
// (`[A11Y-07]`), slice rb-9, residual R-m23-s2-X3. Design of record: ADR-0244.
//
// WHY THIS FILE EXISTS. A11Y-12 is written as "client/src/styles.css declares zero `#id`
// selectors" and was enforced by matching the literal `#` character. The criterion's TEXT is not
// the PROPERTY: red-team measured six `#`-free, biome-clean stylesheets that keep every gate green
// while, in Chromium, hiding the help overlay, blanking the corner affordance and dropping the
// live region out of the accessibility tree (ADR-0151 D1's regression, re-created undetected).
// This file states the property directly — "no rule in the shipped stylesheet may alter the
// reachability or the styling contract of a pinned shell id" — by RENDERING the real markup twice
// and diffing the computed cascade.
//
// ENVIRONMENT. Deliberately NOT `@vitest-environment happy-dom`. A file-scoped environment gives
// one AMBIENT window whose `happyDOM.settings` are shared with every other test in the run, and
// `indexShell.test.ts`'s module-scope hermeticity guard exists precisely because that ambient
// window fetches `/src/styles.css` over the network on parse. Every render below builds its own
// DETACHED `Window` (the idiom `main.wiring.test.ts` established) with its own settings, and
// closes it.
//
// NO REGEX LITERALS ANYWHERE IN THIS FILE, and no mention of the nine CSS-oracle symbols
// `evals/a11y-static-shell.eval.mjs` sole-owns (ADR-0215 / R-m23-s10-X18) — not in code, not in a
// string, not in a comment. `[A11Y-CSSOWN2]`'s tripwire downgrades a file carrying a regex literal
// that holds a quote or a comment delimiter to RAW scanning, and under raw scanning a prose
// mention of an owned symbol is itself a census violation. All matching here is
// String.indexOf/.includes/.split/.join. The retained SHAPE oracle in `indexShell.test.ts` is
// referred to by ADR NUMBER (ADR-0244's "shape blacklist"), never by symbol name in a string.
//
// ===========================================================================================
// IMPLEMENTER CONTRACT — `cascadeOffenders` IS NOT DEFINED IN THIS FILE YET.
//
// This file is the RED half of the slice. It ships the criterion and no implementation; the four
// tests below are written against this exact signature and must be satisfied by a real render.
//
//   async function cascadeOffenders(cssText: string): Promise<string[]>
//
// (Every call site `await`s it, so a synchronous implementation would also satisfy the tests —
// but closing a happy-dom Window is asynchronous, so async is the honest shape.)
//
// ALGORITHM, as measured and adjudicated in ADR-0244:
//
//  1. Read the REAL `client/index.html` from disk, path resolved from `import.meta.url` so it is
//     cwd-independent, through a LOUD-THROWING reader (mirror `readStylesCss()` below and
//     `readIndexHtml()` in `indexShell.test.ts`). A `?? ''` fallback would report a clean cascade
//     over an empty document.
//
//  2. For each STATE in ['shipped', 'shown'], perform TWO renders:
//       A. the markup with NO author sheet;
//       B. the markup with `cssText` appended to <head> as a `<style>` element.
//     The state is applied IDENTICALLY to both renders. 'shipped' is the markup as-is. 'shown'
//     sets `el.style.display = ''` on `#help-overlay` and `#menu-overlay` and NOTHING else —
//     never an explicit value like 'block'. `HelpView.show()` and `MenuView.show()` both write the
//     EMPTY STRING, which CLEARS the inline declaration; writing 'block' would restore an inline
//     declaration that beats every non-`!important` author rule and would blind this oracle to
//     exactly the regression class it exists to catch (ADR-0244, decision D5).
//
//  3. Each render uses a FRESH detached `Window` (`import { Window } from 'happy-dom'`) whose
//     `happyDOM.settings` set ALL FOUR of `disableCSSFileLoading`,
//     `handleDisabledFileLoadingAsSuccess`, `disableJavaScriptFileLoading` and
//     `disableJavaScriptEvaluation` — `client/index.html` ships both a stylesheet <link> and
//     `<script type="module" src="/src/main.ts">`, and without these the render fetches over the
//     network, which is the hermeticity defect `indexShell.test.ts`'s module-scope guard was
//     written against. Every Window is closed with `await win.happyDOM.close()` in a `finally`.
//
//  4. TARGETS, in this order: `html`, `body`, then the elements with ids
//     `help-overlay`, `menu-overlay`, `help-hint`, `build-stamp`, `a11y-live`, `help-title`,
//     `help-controls`, `help-goals`, `menu-heading`, `menu-rows`, `menu-back-hint`.
//     `html` and `body` are in the set because `display` is NOT inherited: an ancestor rule hides
//     the whole document while every descendant's own computed `display` is untouched (measured,
//     in happy-dom and in Chromium alike). The six CHILD-payload ids are in the set because
//     `[role="dialog"] > *{display:none}` leaves all five pinned shell ids untouched while the
//     overlay opens, takes focus, and is EMPTY. A target that does not resolve must THROW, never
//     be skipped.
//
//  5. Diff the FULLY ENUMERATED computed style of each target: iterate `for (let i = 0; i <
//     cs.length; i += 1) cs.item(i)` on BOTH sides, union the names, and compare
//     `getPropertyValue(name)`. There is no property roster — a roster is a blacklist with the
//     same convergence problem one level down. SKIP every property whose name starts with `--`:
//     measured, `:root{--x:1px}` otherwise registers as an offender and M23 §4 slice S9 lands
//     `:root` colour tokens in this exact file, so the gate would false-RED a planned sibling
//     slice. That costs nothing — a `var()`-consumer attack still moves the CONSUMER's own
//     longhand.
//
//  6. Every differing (state, target, property) becomes the string
//         <state> + '/' + <target> + '.' + <property> + ' ' + <without> + '->' + <with>
//     where <target> is `html`, `body` or the bare id (no sigil), and a property absent from one
//     side is spelled with the sentinel `(absent)`.
//
//  7. Subtract the FROZEN ALLOWED map — the `.sr-only` effect on `a11y-live`, and nothing else.
//     It is the ONE legitimate delta the shipped sheet produces: MEASURED at exactly 31 entries
//     per state, 62 in total, all on `a11y-live`, and STABLE across five consecutive runs. The
//     subtraction is by the FULL entry string including its VALUE, never by property name — that
//     is what makes `[id$="-live"]{position:static}` an offender (`(absent)->static` is not
//     `(absent)->absolute`) rather than a silently-absorbed overwrite.
//
//  8. Return the remaining entries SORTED (plain lexicographic `Array.prototype.sort`), or `[]`.
//
// A deliberate future change to `#a11y-live`'s hiding contract is therefore a two-place edit:
// `client/src/styles.css` and that ALLOWED map. That is the "the inline style attribute is the
// COMPLETE styling contract" claim being enforced, not friction.
// ===========================================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The repo's only stylesheet. Path resolved from `import.meta.url`, exactly as
 *  `indexShell.test.ts` resolves it, so it is cwd-independent. */
const STYLES_CSS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css');

/** Loud-throwing reader. Deliberately NOT a `?? ''` fallback: a missing stylesheet must be a RED,
 *  never an oracle that cheerfully reports "zero offenders" over an empty string. */
function readStylesCss(): string {
  try {
    return readFileSync(STYLES_CSS_PATH, 'utf8');
  } catch (err) {
    throw new Error(`styles.css could not be read at expected path: ${STYLES_CSS_PATH} — ${err}`);
  }
}

/** A candidate sheet = the REAL shipped stylesheet plus one extra rule.
 *
 *  Fixtures are judged AS AN AMENDMENT TO THE SHIPPED FILE, never in isolation. That is what
 *  makes `[id$="-live"]{position:static}` bite at all: standing alone it changes nothing (the
 *  live region has no `.sr-only` rule to override and computes `static` on both sides), and a
 *  fixture table that never touches the real artefact is the "fixture-only teeth" pattern this
 *  repo has repeatedly measured as green-but-meaningless. */
function withShippedSheet(extra: string): string {
  return `${readStylesCss()}\n${extra}\n`;
}

interface CascadeFixture {
  readonly name: string;
  readonly kind: 'bad' | 'good';
  /** The rule under test, appended to the shipped stylesheet. */
  readonly css: string;
  /** The EXACT, SORTED offender set. Empty for a `good` row. */
  readonly offenders: readonly string[];
  /** For a `bad` row: the regression it re-creates. For a `good` row: the FALSE RED it kills. */
  readonly kills: string;
}

/**
 * The BAD/GOOD table. Every row was measured against a real render.
 *
 * The expectations are EXACT SORTED SETS, never `toContain` and never a length check. A length
 * check is the measured tautology this repo has killed twice: an oracle that reports every
 * (target, property) pair it looks at passes a membership test on all of the BAD rows, and an
 * oracle that reports a fixed count passes a count check. The GOOD rows are what refuse both.
 */
const CASCADE_FIXTURES: readonly CascadeFixture[] = [
  {
    name: 'bad/attr-eq-visibility',
    kind: 'bad',
    css: '[id="help-overlay"]{visibility:hidden}',
    offenders: [
      'shipped/help-controls.visibility (absent)->hidden',
      'shipped/help-goals.visibility (absent)->hidden',
      'shipped/help-overlay.visibility (absent)->hidden',
      'shipped/help-title.visibility (absent)->hidden',
      'shown/help-controls.visibility (absent)->hidden',
      'shown/help-goals.visibility (absent)->hidden',
      'shown/help-overlay.visibility (absent)->hidden',
      'shown/help-title.visibility (absent)->hidden',
    ],
    kills:
      'the headline measured bypass — an attribute selector naming a pinned id, with no `#` ' +
      'anywhere. In Chromium this hides the help overlay outright. `visibility` INHERITS, so ' +
      'the three child-payload nodes move with it; a per-shell-root oracle that never probes ' +
      'the payload reports four entries here instead of eight',
  },
  {
    name: 'bad/positional-important',
    kind: 'bad',
    css: 'body > div:nth-child(11){position:static!important}',
    offenders: [
      'shipped/help-overlay.position fixed->static',
      'shown/help-overlay.position fixed->static',
    ],
    kills:
      'ADR-0151 D1 re-created exactly: a positional selector that never names the id, plus ' +
      '`!important` to beat the inline `position:fixed`, turns the overlay back into a static ' +
      'in-flow div AFTER the viewport-tall canvas and paints it below the fold',
  },
  {
    name: 'good/positional-plain',
    kind: 'good',
    css: 'body > div:nth-child(11){position:static}',
    offenders: [],
    kills:
      'THE LOAD-BEARING GOOD ROW. It is byte-for-byte the BAD row above minus `!important`, so ' +
      'it is the only row in this table that a cheap "does any rule match a pinned element" ' +
      'SHAPE check cannot tell apart from a real regression. An inline declaration beats a ' +
      'non-`!important` author rule, so nothing moves — and that is a cascade fact, not a ' +
      'selector-text fact. This row is what forces a real render',
  },
  {
    name: 'bad/shown-display-plain',
    kind: 'bad',
    css: '[id="help-overlay"]{display:none}',
    offenders: ['shown/help-overlay.display block->none'],
    kills:
      'the SHOWN-state hole, in its cheapest spelling. As shipped the overlay already computes ' +
      '`display:none`, so this rule is invisible; it bites only once `show()` has cleared the ' +
      'inline declaration, after which pressing `?` is a silent no-op. Modelling the shown ' +
      "state as `style.display = 'block'` instead of `''` restores an inline declaration that " +
      'beats this rule and deletes this whole class from the gate',
  },
  {
    name: 'bad/shown-display-important',
    kind: 'bad',
    css: '[id="help-overlay"]{display:none!important}',
    offenders: ['shown/help-overlay.display block->none'],
    kills:
      'the same hole with `!important`, which is ALSO invisible as-shipped (both sides compute ' +
      '`none`). Pinning one entry rather than two is what proves the two states are rendered ' +
      'separately: an oracle that renders only the shown state, or that unions the states ' +
      'together without labelling them, cannot produce this set',
  },
  {
    name: 'bad/last-of-type',
    kind: 'bad',
    css: 'body > div:last-of-type{display:none}',
    offenders: ['shipped/a11y-live.display block->none', 'shown/a11y-live.display block->none'],
    kills:
      'an INDIRECT selector that names no pinned id, is not the universal selector, and is not ' +
      'one of the positional pseudos a shape blacklist enumerates — and the live region is the ' +
      "LAST <div> child of <body>, so it drops out of the accessibility tree. ADR-0244's " +
      'evidence that enumeration does not converge',
  },
  {
    name: 'bad/tag-button',
    kind: 'bad',
    css: 'body > button{visibility:hidden}',
    offenders: [
      'shipped/help-hint.visibility (absent)->hidden',
      'shown/help-hint.visibility (absent)->hidden',
    ],
    kills:
      'the cheapest possible escape from a name/universal/positional blacklist: a plain TAG ' +
      'selector. `#help-hint` is the only <button> child of <body>, so this blanks the ' +
      'persistent corner affordance ux1-1 ships',
  },
  {
    name: 'bad/sibling-button',
    kind: 'bad',
    css: 'div[role="dialog"] ~ button{opacity:0!important}',
    offenders: ['shipped/help-hint.opacity (absent)->0', 'shown/help-hint.opacity (absent)->0'],
    kills:
      'the general-sibling combinator reaching the affordance through the overlay shells, and ' +
      '`opacity:0` rather than a hiding property — an invisible-but-present element, which no ' +
      'markup pin and no shape blacklist looks at',
  },
  {
    name: 'bad/suffix-position',
    kind: 'bad',
    css: '[id$="-live"]{position:static}',
    offenders: [
      'shipped/a11y-live.position (absent)->static',
      'shown/a11y-live.position (absent)->static',
    ],
    kills:
      'THE VALUE-PINNING ROW. It overwrites a property the shipped `.sr-only` rule legitimately ' +
      'sets, so an ALLOWED map keyed by PROPERTY NAME absorbs it silently and reports zero. ' +
      'Only a map keyed by the full entry INCLUDING the value sees that `(absent)->static` is ' +
      'not `(absent)->absolute` — and without `position:absolute` the clip applies to nothing ' +
      'and the announcement text paints on screen',
  },
  {
    name: 'bad/content-visibility',
    kind: 'bad',
    css: '[id="a11y-live"]{content-visibility:hidden}',
    offenders: [
      'shipped/a11y-live.content-visibility (absent)->hidden',
      'shown/a11y-live.content-visibility (absent)->hidden',
    ],
    kills:
      'accessibility-tree removal through a property that is neither `display` nor ' +
      '`visibility`. A fixed property roster that lists the two obvious ones never looks here; ' +
      'full enumeration has no roster to be short',
  },
  {
    name: 'bad/ancestor-body',
    kind: 'bad',
    css: 'body{display:none}',
    offenders: ['shipped/body.display block->none', 'shown/body.display block->none'],
    kills:
      'THE ANCESTOR HOLE. `display` is NOT inherited, so hiding <body> leaves every descendant ' +
      'id computing its own unchanged `display` — measured, a roster of the five pinned ids ' +
      'alone reports NO OFFENDER AT ALL for this, in happy-dom and in a real browser equally, ' +
      'while the entire application is blank. `html` and `body` are in the target set for ' +
      'exactly this one reason',
  },
  {
    name: 'bad/ancestor-html',
    kind: 'bad',
    css: 'html{display:none}',
    offenders: ['shipped/html.display block->none', 'shown/html.display block->none'],
    kills:
      'the same ancestor hole one level up, and the row that proves `html` is probed ' +
      'independently of `body` rather than the pair being one entry in disguise',
  },
  {
    name: 'bad/child-payload',
    kind: 'bad',
    css: '[role="dialog"] > *{display:none}',
    offenders: [
      'shipped/help-controls.display block->none',
      'shipped/help-goals.display block->none',
      'shipped/help-title.display block->none',
      'shipped/menu-back-hint.display block->none',
      'shipped/menu-heading.display block->none',
      'shipped/menu-rows.display block->none',
      'shown/help-controls.display block->none',
      'shown/help-goals.display block->none',
      'shown/help-title.display block->none',
      'shown/menu-back-hint.display block->none',
      'shown/menu-heading.display block->none',
      'shown/menu-rows.display block->none',
    ],
    kills:
      'THE CHILD-PAYLOAD HOLE. All five pinned shell ids are untouched — the overlay still ' +
      'opens, still takes focus, still traps it — and it is EMPTY. `#help-title` is the ' +
      "overlay's initialFocusSelector, so this is a focus trap around nothing. An oracle " +
      'scoped to the shell roots reports zero for this',
  },
  {
    name: 'good/root-custom-property',
    kind: 'good',
    css: ':root{--rb9-shell-token:1px}',
    offenders: [],
    kills:
      'the FALSE RED that would have blocked a planned sibling slice. M23 §4 slice S9 lands ' +
      '`:root` colour tokens in this exact file; without the `--` skip this registers as ' +
      '`html.--rb9-shell-token` and reds a stylesheet that changed nothing about reachability',
  },
  {
    name: 'good/var-consumer-is-still-caught-elsewhere',
    kind: 'good',
    css: ':root{--rb9-unused-token:none}',
    offenders: [],
    kills:
      'the objection to the `--` skip. A custom property that NOTHING CONSUMES is inert, and ' +
      "the moment a consumer exists the consumer's own longhand moves and is caught by the " +
      'ordinary diff — so skipping custom properties costs no teeth. Measured: ' +
      '`[id="help-hint"]{display:var(--h)}` still reds through `help-hint.display`',
  },
  {
    name: 'good/no-matching-element',
    kind: 'good',
    css: '.rb9-matches-nothing{color:red}',
    offenders: [],
    kills:
      'a constant-true oracle. A rule whose selector matches no element in the document must ' +
      'produce no delta at all — if it does, every GOOD row above is passing for the wrong ' +
      'reason and every BAD row is unfalsifiable',
  },
  {
    name: 'good/at-rule-prelude-hex',
    kind: 'good',
    css: '@supports (color:#fff){.rb9-supports-probe{color:red}}',
    offenders: [],
    kills:
      'the false RED a naive `#`-matching scanner produces on an at-rule prelude. A hex colour ' +
      'in an `@supports` condition is not a selector, and this oracle never reads selector text ' +
      'at all — which is why it is indifferent to the spelling',
  },
  {
    name: 'good/sr-only-restated',
    kind: 'good',
    css:
      '.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
      'clip-path:inset(50%);white-space:nowrap;border:0}',
    offenders: [],
    kills:
      'an ALLOWED map that is a rubber stamp in the other direction. Re-stating the shipped ' +
      '`.sr-only` rule verbatim recomputes every one of its 31 per-state cells to the SAME ' +
      'values, so a correctly-keyed map absorbs them and reports nothing — while the ' +
      'value-pinned `bad/suffix-position` row above proves the same map still refuses a ' +
      'different value for one of those very cells',
  },
];

/**
 * The at-rule and selector shapes happy-dom's CSS parser silently DROPS and Chromium honours.
 *
 * Each one names a pinned id DIRECTLY and each was measured live in Chromium — `display:none`,
 * and `AX=IGNORED` through `Accessibility.getPartialAXTree`. `@media (scripting: enabled)` is
 * TRUE for the default user with no emulation whatsoever, and `client/src/styles.css`'s own
 * header says slice S9 ships `@media (prefers-contrast: more)` into this very file, which makes
 * these the most plausible future carriers of a regression rather than exotica.
 */
const PARSER_GAP_SHAPES: ReadonlyArray<{ readonly name: string; readonly css: string }> = [
  { name: 'layer-anonymous', css: '@layer{[id="help-overlay"]{display:none!important}}' },
  { name: 'layer-named', css: '@layer rb9{[id="help-overlay"]{display:none!important}}' },
  { name: 'scope', css: '@scope (body){[id="help-overlay"]{display:none!important}}' },
  { name: 'nesting-ampersand', css: 'body{& [id="help-overlay"]{display:none!important}}' },
  { name: 'attr-case-insensitive', css: '[id="HELP-OVERLAY" i]{display:none!important}' },
  {
    name: 'container-query',
    css: '@container (min-width:0px){[id="help-overlay"]{display:none!important}}',
  },
  {
    name: 'media-prefers-contrast',
    css: '@media (prefers-contrast: more){[id="help-overlay"]{display:none!important}}',
  },
  {
    name: 'media-scripting-enabled',
    css: '@media (scripting: enabled){[id="help-overlay"]{display:none!important}}',
  },
];

describe('rb-9 (ADR-0244): the computed-cascade differential over the real index.html', () => {
  it('★ RB9-G1 CONTROL: the cascade is LIVE through cascadeOffenders — an empty sheet is clean, an !important author rule beats an inline declaration, and the SHOWN state clears rather than sets display', async () => {
    // CONTROL 1 — the oracle is not a constant-fail. Every BAD expectation below is "this exact
    // non-empty set", which an oracle that reports every (target, property) pair it inspects
    // would fail, but an oracle that reports a FIXED set would pass by luck. An empty sheet
    // changes nothing, so it must produce nothing.
    expect(
      await cascadeOffenders(''),
      'CONTROL: an EMPTY author sheet produced offenders. The oracle is reporting a delta ' +
        'between two renders that were handed the same content — either the two renders differ ' +
        'in something other than the sheet (a stray state mutation applied to only one of them), ' +
        'or the enumeration is not deterministic. Every "exact set" assertion below is ' +
        'meaningless until this is empty',
    ).toEqual([]);

    // CONTROL 2 — THE APPEND PROOF, routed THROUGH the oracle rather than through a parallel
    // render written beside it. An implementation that builds two Windows and forgets to attach
    // the <style> element (or attaches it to a detached node, or after the computed style has
    // been read) returns [] for EVERYTHING and greens a stylesheet that hides the whole shell.
    // MEASURED as the single cheapest way to gut this file. `#build-stamp` carries an inline
    // `opacity:0.55`, so this also re-proves the `!important`-beats-inline fact that makes the
    // `good/positional-plain` row above discriminating rather than arbitrary.
    expect(
      await cascadeOffenders('[id="build-stamp"]{opacity:0.125!important}'),
      'CONTROL: an `!important` author rule over an inline declaration produced no delta. The ' +
        '<style> element is not reaching the document under assertion, or `!important` is not ' +
        'winning — in either case a REAL id rule would also produce no delta and this entire ' +
        'file is a rubber stamp',
    ).toEqual(['shipped/build-stamp.opacity 0.55->0.125', 'shown/build-stamp.opacity 0.55->0.125']);

    // CONTROL 3 — BOTH STATES EXIST, and SHOWN is `style.display = ''`. A non-`!important`
    // `display:none` is beaten by the inline declaration in the shipped state and wins in the
    // shown state, so exactly ONE entry is the only outcome consistent with rendering two
    // separately-labelled states AND modelling show() as CLEARING the inline value. An oracle
    // that renders one state reports zero or two; one that writes `display = 'block'` reports
    // zero, because it has re-created an inline declaration for the rule to lose to.
    expect(
      await cascadeOffenders('[id="menu-overlay"]{display:none}'),
      "CONTROL: the SHOWN state is not `el.style.display = ''`. MenuView.show() writes the " +
        'EMPTY STRING, which CLEARS the inline declaration and exposes the element to author ' +
        'rules; any other modelling of "shown" either hides this rule behind an inline value ' +
        'or never renders the state at all',
    ).toEqual(['shown/menu-overlay.display block->none']);
  }, 60000);

  it('★ RB9-G2 BITES: every measured bypass appended to the SHIPPED stylesheet yields its EXACT sorted offender set, and every legitimate rule yields none', async () => {
    // A plain `for..of`, never `it.each` / `it.skipIf` / `it.runIf`: MEASURED against real
    // vitest, `it.skipIf(true)` and `it.runIf(false)` exit 0 with the tests reported PENDING and
    // `it.each([])` registers NOTHING AT ALL, so a suspended table is a green run over zero
    // assertions. A loop inside one test body cannot be emptied without emptying the array in
    // plain sight, and the ledger's X1 pins the passing test COUNT besides.
    expect(
      CASCADE_FIXTURES.length,
      'ANTI-VACUITY: the fixture table has been shrunk. A `for..of` over an empty array is a ' +
        'passing test that asserts nothing',
    ).toBe(18);
    expect(
      CASCADE_FIXTURES.filter((r) => r.kind === 'bad').length,
      'ANTI-VACUITY: the BAD half of the table has been shrunk. GOOD rows alone are satisfied ' +
        'by a `() => []` stub',
    ).toBe(12);
    expect(
      CASCADE_FIXTURES.filter((r) => r.kind === 'good').length,
      'ANTI-VACUITY: the GOOD half of the table has been shrunk. BAD rows alone are satisfied ' +
        'by an oracle that reports everything it looks at',
    ).toBe(6);

    for (const row of CASCADE_FIXTURES) {
      // Table integrity, per row and BEFORE the verdict: a BAD row with an empty expectation
      // asserts exactly what a GOOD row asserts and can never bite, and a GOOD row with a
      // non-empty one is a mislabelled BAD row nobody would review.
      expect(
        row.offenders.length > 0,
        `TABLE INTEGRITY: row "${row.name}" is kind=${row.kind} but its expectation is ` +
          `${JSON.stringify(row.offenders)} — a BAD row must pin a non-empty set and a GOOD row ` +
          'must pin the empty one',
      ).toBe(row.kind === 'bad');
      expect(
        row.kills.trim().length > 0,
        `TABLE INTEGRITY: row "${row.name}" carries no \`kills\` prose — a row nobody can review`,
      ).toBe(true);

      const got = await cascadeOffenders(withShippedSheet(row.css));
      expect(
        got,
        `${row.kind === 'bad' ? 'KILLS' : 'FALSE RED'} "${row.name}" — ${row.kills}. Sheet ` +
          `appended to the shipped stylesheet: ${JSON.stringify(row.css)}`,
      ).toEqual([...row.offenders]);
    }
  }, 180000);

  it('★ RB9-G3 REAL ARTEFACT: the shipped stylesheet yields ZERO offenders, declares no @import, and answers a RUNTIME-DERIVED probe it cannot have memorised', async () => {
    const css = readStylesCss();

    // ANTI-VACUITY. An empty (or comment-only) stylesheet trivially alters nothing, and "zero
    // offenders" over it is a fact about the file being absent rather than about it being clean.
    expect(
      css.trim().length,
      'ANTI-VACUITY: client/src/styles.css is empty. Every clause below passes vacuously on it',
    ).toBeGreaterThan(0);
    expect(
      css.indexOf('.sr-only'),
      'ANTI-VACUITY: the shipped stylesheet no longer carries a `.sr-only` rule, so the ONE ' +
        'legitimate delta this oracle allows is not being produced at all — the zero-offender ' +
        'verdict below would then be an artefact of an inert sheet rather than a clean one',
    ).toBeGreaterThan(-1);

    // THE SOUNDNESS PRECONDITION OF THE DIFFERENTIAL, not a nicety. Under
    // `disableCSSFileLoading` a sheet consisting only of `@import url(...)` yields a COMPLETELY
    // EMPTY diff — the oracle's own hermeticity settings create the hole — so an imported second
    // sheet full of literal id rules would ship entirely unjudged. Measured: the same construct
    // works in Chromium, so this oracle only refuses it by accident of an engine bug. The check
    // is on RAW text, deliberately: an `@import` mentioned inside a comment is a false RED,
    // which is the safe direction.
    expect(
      css.toLowerCase().includes('@import'),
      'KILLS: an `@import` in client/src/styles.css. This oracle renders with CSS file loading ' +
        'DISABLED, so an imported sheet contributes NOTHING to either side of the diff and its ' +
        'rules are invisible here — while a browser applies them in full. Spec §2.7 decided on ' +
        'exactly ONE css file',
    ).toBe(false);

    // THE CRITERION.
    expect(
      await cascadeOffenders(css),
      'KILLS: a rule in the shipped client/src/styles.css that alters the computed styling of ' +
        'the shell — its ancestors, the five pinned ids, or their child payload — in either the ' +
        'as-shipped or the shown state. This is criterion A11Y-12 stated as the PROPERTY rather ' +
        'than as "the file contains no `#` character", and it is what keeps the inline `style` ' +
        "attribute the COMPLETE styling contract that indexShell.test.ts's and " +
        "main.wiring.test.ts's text pins assume. The ONE tolerated delta is `.sr-only`'s effect " +
        'on #a11y-live; anything else is a reachability regression',
    ).toEqual([]);

    // THE UN-TRANSCRIBABLE ARM. MEASURED: a lookup table keyed by the fixture string, which
    // never constructs a Window at all, passes every other clause in this file — because every
    // other input is a literal that is present in this source. The probe VALUE is derived from
    // the shipped stylesheet's own length at run time, so it appears nowhere in this file and
    // changes with any edit to styles.css; and the probe is PREPENDED, which defeats an
    // `endsWith`-keyed short-circuit. This is the shape the `T-LIVE1` liveness probe in
    // `evals/a11y-static-shell.eval.mjs` already uses one file away.
    const probeZ = 100000 + css.length;
    const probed = await cascadeOffenders(
      `[id="build-stamp"]{z-index:${probeZ}!important}\n${css}`,
    );
    expect(
      probed,
      `LIVENESS: a z-index probe derived at run time from the stylesheet's own length ` +
        `(${probeZ}) was not reported against #build-stamp's inline z-index of 9999. Either the ` +
        'oracle is answering from a table rather than from a render, or it never applied the ' +
        'PREPENDED rule — in which case the zero-offender verdict above is an artefact of the ' +
        'sheet never being read',
    ).toEqual([
      `shipped/build-stamp.z-index 9999->${probeZ}`,
      `shown/build-stamp.z-index 9999->${probeZ}`,
    ]);
  }, 60000);

  it("★ RB9-G4 PARSER COVERAGE: the eight at-rule and selector shapes happy-dom DROPS report ZERO offenders — this oracle's declared blind spot, stated rather than papered over", async () => {
    // WHAT THIS TEST IS. It is NOT a pass mark. Every shape below names a pinned id DIRECTLY and
    // every one is live in Chromium (`display:none`, AX=IGNORED), and this oracle reports
    // nothing for all eight because happy-dom's CSS parser never applies the rule. Asserting the
    // empty result is how that blind spot stops being folklore: the claim "technique-independent"
    // is STRUCK from this design (ADR-0244), and the retained selector-SHAPE oracle in
    // `client/src/indexShell.test.ts` is what covers this class — it reads the lowercased prelude
    // text, so an engine that cannot apply the rule is irrelevant to it. That half's proof lives
    // WITH that oracle, as added control probes on its own tooth; duplicating it here would be a
    // second implementation of a detector, which is the drift this repo's sole-owner ruling
    // exists to prevent.
    //
    // WHEN THIS TEST REDS, IT IS WORKING. A happy-dom upgrade that learns to parse `@layer` will
    // start producing offenders here. That is a TRIPWIRE ON THE ENGINE, not a failure of the
    // stylesheet: the division of labour between the two oracles has moved, ADR-0244's parse
    // table is stale, and the honest response is to re-derive this row from a fresh measurement —
    // never to relax the assertion.
    expect(
      PARSER_GAP_SHAPES.length,
      'ANTI-VACUITY: the parser-gap table has been shrunk. A loop over a short array documents ' +
        'a smaller blind spot than the one that was measured',
    ).toBe(8);

    const css = readStylesCss();
    for (const shape of PARSER_GAP_SHAPES) {
      expect(
        await cascadeOffenders(`${css}\n${shape.css}\n`),
        `ENGINE TRIPWIRE "${shape.name}": happy-dom has started applying ` +
          `${JSON.stringify(shape.css)}, which it was MEASURED to drop. That is a change in what ` +
          "this oracle can see, so ADR-0244's parse-coverage table and the division of labour " +
          'with the retained shape oracle are now stale. Re-measure and re-derive this row ' +
          '(a shape that BOTH oracles now catch belongs in RB9-G2, not here) — do NOT relax ' +
          'this assertion',
      ).toEqual([]);
    }
  }, 120000);
});
