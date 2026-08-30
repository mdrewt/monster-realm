// Eval: the static-shell a11y gate (M23 §5.2, slice m23-s10).
//
// WHAT IS HERE FOR REAL, AND WHY THE REST IS DELEGATED.
//
// `[A11Y-05a]` and `[A11Y-05b]` are written out in full because both close MEASURED holes that no
// shipped tooth sees:
//
//   * `[A11Y-05a]` — §5.2 says "exactly one `aria-live` node". `role="status"`, `role="alert"`,
//     `role="log"`, `role="timer"` and `role="marquee"` are IMPLICIT live regions carrying NO
//     `aria-live` attribute, so a second announcement channel ships green past an `aria-live`
//     count — measured. This census counts the implicit roles too. §5.2's only nesting BAD fixture
//     is "`#a11y-live` inside `#app`", which lets a gate collapse to "not inside `#app`" and pass
//     both fixtures while the region sits inside a `display:none` overlay and never announces to
//     anyone; the ancestor check below is on `display:none` ANYWHERE up the chain, not on one id.
//
//   * `[A11Y-05b]` REPLACES §5.2's third clause ("no `replaceChildren` call in `client/src` targets
//     `document.body` or `#a11y-live`"). That clause is vacuously true today — all 24
//     `replaceChildren` call sites in `client/src` target private fields — AND receiver-text
//     matching was measured to miss every realistic spelling of the thing it bans:
//     `const b = document.body; b.replaceChildren()`, `document.getElementById('a11y-live').remove()`,
//     an `innerHTML` write targeting the document body, and two more. TWO clauses replace it, because
//     neither alone is enough — a correction recorded here because the first draft claimed
//     ownership subsumed the receiver clause and it does not:
//       * MODULE OWNERSHIP — `ui/liveRegion.ts` is the sole owner of the node (its own header says
//         so at `:56`), so no other non-test `client/src` module may NAME it. This catches every
//         spelling that reaches the node by id.
//       * ROOT RECEIVERS — `const b = document.body; b.replaceChildren()` never mentions the node
//         at all, and the live region is a direct `<body>` child, so a body-level rebuild destroys
//         it. `findLiveRegionDestroyers` bans the two document roots as receivers, and bans
//         reaching the node by ARIA selector from anywhere but the owner.
//
// `[A11Y-06]` and `[A11Y-07]` ARE EXECUTED HERE, FIRST-PARTY — rb-15 (`R-m23-s10-X18`).
//
// THIS FILE IS THE CSS ORACLE'S HOME. `stripCssComments`, `parseCssRules`, `findIdSelectors` and
// `srOnlyIsAccessible` (plus their private helpers) live here and nowhere else in the repo;
// `client/src/indexShell.test.ts` deleted its copies and reaches them through its existing
// `rb12CssStripperOracle` namespace import. ADR-0215 made that ruling for the comment stripper and
// its `Update (rb-15)` note extends it to the rest. Every symbol below is cited BY NAME, never by
// line: this header previously carried three line citations that a single earlier deletion had
// already made wrong, and nothing caught it.
//
// WHY THE OWNERSHIP RUNS THIS WAY. A `.mjs` eval cannot import a `.ts` vitest file (extensionless
// relative imports Node's ESM resolver rejects outside a bundler), while the `.ts` CAN import this
// module — so this is the ONE direction that yields a single owner. m23-s10's header recorded a
// different end state, a separate `evals/lib/a11yCssOracle.mjs` imported by both tiers; rb-15
// OVERRULES it. Splitting the oracle from `stripCssComments` — its own dependency, and ADR-0215's
// sole-owned primitive — would put one criterion back across two modules for no gain.
//
// WHAT THIS REPLACED, and why it mattered. `[A11Y-06]`/`[A11Y-07]` used to be DELEGATED: two
// `SHELL_DELEGATIONS` codeNeedles grepped `client/src/indexShell.test.ts` for
// `function findIdSelectors(` and `function srOnlyIsAccessible(`. A text pin proves a declaration
// EXISTS, never that its semantics are right — and `just a11y-e2e` (`justfile:348`) runs three
// evals plus eight named spec files, of which `indexShell.test.ts` is NOT one, so in the nightly
// a11y tier those two criteria were gated by that grep and nothing else. This file now RUNS the
// oracle: over two shared frozen tables (`ID_SELECTOR_FIXTURES`, `SR_ONLY_FIXTURES`, executed IN
// FULL by BOTH tiers), over the real `client/src/styles.css`, and against liveness probes that
// mutate that text in memory and require the mutation to be flagged.
//
// THE TWO NEEDLES THAT REMAIN are CONSUMER LIVENESS, not delegation: they pin that the vitest tier
// still CALLS the oracle on the real artefact and still READS the verdict. Semantics are gated
// here, by execution.
//
// SOLE OWNERSHIP IS MECHANICAL, in three clauses, because a shape ban alone is not enough:
// red-team MEASURED seven shipping-plausible second oracles (object-method shorthand, an
// object-literal arrow property, a class static method, `Object.assign` over the namespace, a
// poisoned namespace spread, a sibling `*.test.ts` twin, a getter) that beat a
// `function NAME(`/`NAME =` ban AND all four needles AND the file walk at once, on a deliberately
// poisoned stylesheet. `T-OWN-*` here and `RB15-G1`/`RB15-G4` there therefore carry the shape ban,
// an occurrence census, and a namespace-integrity clause; no two of the three suffice.
//
// DECLARED RESIDUAL `R-rb15-CASCADE`: the `[A11Y-07]` CASCADE and SURFACE halves
// (`findCascadeReachingSelectors`, `importsAnotherStylesheet`, `CASCADE_PINNED_IDS`) deliberately
// STAYED in `client/src/indexShell.test.ts`, which is why `parseCssRules` is exported. The eval
// has no counterpart for them, so their `SHELL_DELEGATIONS` needles — and the exactly-once pin in
// `RB15-G1` — are what keep that tier honest until a later slice moves them.
//
// NO `main` GUARD (see the manifest eval). `run.mjs` imports the default export.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import {
  findInertDelegations,
  findInertPins,
  includeSelectsTests,
  stripTsComments,
  stripTsCommentsAndStrings,
} from './overlay-a11y-manifest.eval.mjs';

const INDEX_HTML = 'client/index.html';
const CLIENT_SRC = 'client/src';
const VITE_CONFIG = 'client/vite.config.ts';
const LIVE_REGION_OWNER = 'ui/liveRegion.ts';
/** The real stylesheet `[A11Y-06]`/`[A11Y-07]` are judged against, repo-root-relative. */
const STYLES_CSS = 'client/src/styles.css';
/** The vitest-tier consumer whose liveness the two retained codeNeedles pin. */
const CSS_ORACLE_DELEGATE = 'client/src/indexShell.test.ts';

/** How the live-region node is named in source. Both spellings, because `liveRegion.ts:60` exports
 *  `LIVE_REGION_ID` and every other reference would have to go through one of these two. */
const LIVE_REGION_NAMES = Object.freeze(['a11y-live', 'LIVE_REGION_ID']);

/**
 * Strip CSS block comments — the SOLE OWNER of this primitive for BOTH CI tiers (ADR-0215).
 *
 * `client/src/indexShell.test.ts` no longer defines its own copy; it imports this one, so
 * `parseCssRules` / `findIdSelectors` / `srOnlyIsAccessible` over the real `client/styles.css`
 * and the `.mjs` teeth below are judged by ONE implementation. There is nothing left to drift.
 *
 * CSS HAS NO `//` LINE COMMENT, and that is not a pedantic distinction: feeding CSS to the JS/TS
 * scanner in the sibling eval silently truncates every line containing a protocol-relative or
 * `https://` URL, so `background:url(https://cdn/x.png);display:none` loses its `display:none`
 * and the ban it is meant to trip evaporates. Measured. The name collision with the JS stripper is
 * exactly the trap, so this one is named for its language.
 *
 * FOUR-STATE LEXER — normal / dq / sq / comment. A backslash inside a string escapes the next
 * character; the comment opener opens a comment ONLY in `normal`; newlines inside a comment are
 * preserved so line numbers survive.
 *
 * WHY STRING-AWARENESS IS LOAD-BEARING: a declaration whose VALUE contains the comment-opener
 * characters (a `content:` string, say) would otherwise open a comment that never closes, and the
 * stripper would swallow the entire rest of the file. Measured on the pre-ADR-0215 naive body:
 * `.a{content:"` + opener + `"}.b{display:none}` came back as `.a{content:"` — the `display:none`
 * it exists to find, gone. A scanner in that state reports ZERO findings on a stylesheet full of
 * them: a false GREEN, the only kind of failure that matters.
 *
 * WHY IT IS FAIL-LOUD: an unterminated string or comment at EOF THROWS rather than returning a
 * best-effort string. A file we could not parse must never be reported as a CLEAN file — silence
 * from a scanner that gave up is indistinguishable from silence from a scanner that found nothing,
 * and only one of those is the truth. A throw is a loud RED; a truncated return is a quiet lie.
 * (See ADR-0215 RK-2: `evals/reduced-motion-purity.eval.mjs` calls this without a try/catch, so a
 * future unparseable input reds THAT eval loudly — deliberately, never falsely green.)
 */
export function stripCssComments(src) {
  let out = '';
  /** @type {'normal' | 'dq' | 'sq' | 'comment'} */
  let state = 'normal';
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (state === 'comment') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        i += 2;
        continue;
      }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }
    if (state === 'dq' || state === 'sq') {
      out += ch;
      if (ch === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if ((state === 'dq' && ch === '"') || (state === 'sq' && ch === "'")) state = 'normal';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'comment';
      i += 2;
      continue;
    }
    if (ch === '"') state = 'dq';
    if (ch === "'") state = 'sq';
    out += ch;
    i += 1;
  }
  if (state === 'dq' || state === 'sq') {
    throw new Error('CSS parse failed: unterminated string literal at end of input');
  }
  if (state === 'comment') {
    throw new Error('CSS parse failed: unterminated comment at end of input');
  }
  return out;
}

// ---------------------------------------------------------------------------
// rb-15 (R-m23-s10-X18) — THE CSS ORACLE LIVES HERE, AND ONLY HERE.
//
// `parseCssRules` / `findIdSelectors` / `srOnlyIsAccessible` were module-local helpers in
// `client/src/indexShell.test.ts` until rb-15. They are here now for the reason ADR-0215 already
// gave for `stripCssComments` above: a `.mjs` eval cannot import a `.ts` vitest file (extensionless
// relative imports that Node's ESM resolver rejects outside a bundler), while the `.ts` CAN import
// this module — so the ONE direction that yields a single owner is this one. The `.ts` reaches
// every symbol below through its existing `rb12CssStripperOracle` namespace import.
//
// WHY IT MATTERS, MEASURED: before rb-15, `[A11Y-06]` and `[A11Y-07]` were proven by codeNeedles
// grepping `client/src/indexShell.test.ts` for `function findIdSelectors(` — a text pin that proves
// a declaration EXISTS, never that its semantics are right, and that the nightly `just a11y-e2e`
// tier could not check at all (that recipe runs three evals plus eight named spec files, and
// `indexShell.test.ts` is not one of them). This file now RUNS the oracle, over shared fixture
// tables and over the real `client/src/styles.css`.
//
// SEE ALSO the file header: the end state recorded by m23-s10 was a separate
// `evals/lib/a11yCssOracle.mjs`; rb-15 overrules it — splitting the oracle from `stripCssComments`,
// its own dependency and ADR-0215's sole-owned primitive, would put one criterion back across two
// modules for no gain. This file IS the oracle's home.
// ---------------------------------------------------------------------------

/** One STYLE rule (never an at-rule), at any brace depth. */
/**
 * @typedef {object} CssRule
 * @property {string} prelude Everything before the `{`, trimmed — for a style rule, the selector list.
 * @property {string} body Raw text between the braces.
 */

/**
 * PHASE 2 — one character pass emitting STYLE rules at EVERY brace depth.
 *
 * `pending` accumulates the current prelude; a stack of frames tracks nesting; `paren`
 * shields `url(...)` and media features (while `paren > 0`, `{`, `}` and `;` are INERT);
 * string state is honoured so a quoted brace cannot open or close a block.
 *
 * Emitting at every depth is what makes `@media (...){#build-stamp{...}}` visible to
 * findIdSelectors and a `@media`-nested `.sr-only{display:none}` visible to
 * srOnlyIsAccessible. A depth-0-only walk is the naive implementation both A6a and A7a
 * kill by fixture.
 *
 * A `}` with an EMPTY stack throws, and so does EOF with a non-empty stack or an open
 * string: the same fail-loud rule as phase 1.
 */
export function parseCssRules(src) {
  const clean = stripCssComments(src);
  /** @type {CssRule[]} */
  const rules = [];
  /** @type {Array<{ kind: 'at' | 'style', prelude: string, bodyStart: number }>} */
  const stack = [];
  let pending = '';
  let paren = 0;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean.charAt(i);
    if (quote !== null) {
      pending += ch;
      if (ch === '\\') {
        pending += clean.charAt(i + 1);
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      pending += ch;
      continue;
    }
    if (ch === '(') {
      paren += 1;
      pending += ch;
      continue;
    }
    if (ch === ')') {
      if (paren > 0) paren -= 1;
      pending += ch;
      continue;
    }
    if (paren > 0) {
      pending += ch;
      continue;
    }
    if (ch === '{') {
      const prelude = pending.trim();
      stack.push({ kind: prelude.startsWith('@') ? 'at' : 'style', prelude, bodyStart: i + 1 });
      pending = '';
      continue;
    }
    if (ch === '}') {
      const frame = stack.pop();
      if (frame === undefined) {
        throw new Error(`CSS parse failed: unbalanced closing brace at offset ${i}`);
      }
      if (frame.kind === 'style') {
        rules.push({
          prelude: frame.prelude,
          body: clean.slice(frame.bodyStart, i),
        });
      }
      pending = '';
      continue;
    }
    if (ch === ';') {
      pending = '';
      continue;
    }
    pending += ch;
  }
  if (quote !== null) {
    throw new Error('CSS parse failed: unterminated string literal at end of input');
  }
  if (stack.length > 0) {
    throw new Error(`CSS parse failed: ${stack.length} unclosed block(s) at end of input`);
  }
  return rules;
}

/** True if a `#` occurs in `prelude` OUTSIDE any quoted string. */
function preludeHasUnquotedHash(prelude) {
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < prelude.length; i += 1) {
    const ch = prelude.charAt(i);
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      // An ESCAPED character is a literal in an IDENTIFIER, never a combinator or an id
      // sigil: `.\\#notanid` is a CLASS whose name happens to contain a hash. Without this
      // branch that selector is wrongly reported as an id selector — a false RED, and false
      // REDs are what get a scanner "fixed" into uselessness.
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return true;
  }
  return false;
}

/**
 * [A11Y-07] / criterion A11Y-12 — the offending PRELUDES of every `#id` selector.
 *
 * STYLE rules only. At-rule preludes are NEVER inspected, which is exactly what lets
 * `@supports (color:#fff)` pass; declaration bodies are never inspected, which is what
 * lets `color:#fff` and `url(#grad)` pass; the prelude scan is string-aware, which is
 * what lets `[href="#top"]` pass. Those three GOOD shapes are the ones most likely to be
 * "fixed" by weakening this function, so A6a pins all three.
 */
export function findIdSelectors(src) {
  return parseCssRules(src)
    .filter((rule) => preludeHasUnquotedHash(rule.prelude))
    .map((rule) => rule.prelude);
}

const SR_ONLY_CLASS = '.sr-only';

/** A class token ENDS at one of these characters, or at end-of-selector.
 *  `.sr-only-focusable` continues with `-`, which is NOT here — that is the whole
 *  boundary rule, and the reason a `selector.includes('.sr-only')` oracle is wrong. */
const SR_ONLY_TOKEN_BOUNDARY = ',:.#[>+~ ';

const SR_ONLY_REASON_MISSING = 'NO .sr-only RULE';
const SR_ONLY_REASON_POSITION = 'position IS NOT absolute';
const SR_ONLY_REASON_CLIP = 'NEITHER clip-path NOR clip is a MEANINGFUL clip';
const SR_ONLY_REASON_DISPLAY = 'display:none REMOVES THE NODE FROM THE ACCESSIBILITY TREE';
const SR_ONLY_REASON_VISIBILITY = 'visibility:hidden REMOVES THE NODE FROM THE ACCESSIBILITY TREE';
const SR_ONLY_REASON_CONTENT_VIS =
  'content-visibility:hidden REMOVES THE SUBTREE FROM THE ACCESSIBILITY TREE';
const SR_ONLY_REASON_DISPLAY_CONTENTS =
  'display:contents ERASES THE BOX, so the clip applies to nothing';

/**
 * Every declaration that takes the node OUT of the accessibility tree, as
 * `[property, bannedValue]`. A DENY-LIST, and deliberately a wide one: the criterion names
 * `display:none` and `visibility:hidden`, but red-team measured `content-visibility:hidden`
 * producing the identical outcome (Chromium: announcement absent from the AX tree) while
 * passing a two-property check. `display:contents` erases the box entirely, which silently
 * un-does the clip that is doing the hiding.
 */
const SR_ONLY_BANNED_DECLARATIONS = Object.freeze([
  ['display', 'none', SR_ONLY_REASON_DISPLAY],
  ['visibility', 'hidden', SR_ONLY_REASON_VISIBILITY],
  ['content-visibility', 'hidden', SR_ONLY_REASON_CONTENT_VIS],
  ['display', 'contents', SR_ONLY_REASON_DISPLAY_CONTENTS],
]);

/**
 * True when the rule declares a clip that ACTUALLY CLIPS.
 *
 * MEASURED, red-team m23-s2: a `union.has('clip-path') || union.has('clip')` presence check
 * passes `.sr-only{position:absolute;clip:auto;clip-path:none}`, whose properties are both
 * present and both INERT — Chromium rendered 1651 px² of announcement text on screen, which
 * is verbatim the "the live region renders as stray visible text" failure this criterion
 * exists to prevent. Presence is not the property; a non-default VALUE is.
 */
function hasMeaningfulClip(union) {
  const clipPath = union.get('clip-path');
  const clip = union.get('clip');
  if (clipPath !== undefined && clipPath !== 'none') return true;
  return clip !== undefined && clip !== 'auto';
}

/**
 * The minimum declaration count for a NON-VACUOUS `.sr-only` rule.
 *
 * DELIBERATELY 2, NOT 4. Spec §5.2's GOOD hostile-but-correct fixture is the LEGACY form
 * `.sr-only{position:absolute;clip:rect(0,0,0,0)}` and it MUST PASS — "proving the check
 * is on semantics and not on a copied literal". That rule carries exactly two
 * declarations, so any floor above 2 would red a form the spec requires to be green.
 * Two is also the floor the positive requirements already imply (a position plus a clip):
 * `.sr-only{}` is killed by those, and this clause is the belt-and-braces that keeps the
 * empty rule failing if a FUTURE edit ever loosens one of them.
 */
export const MIN_SR_ONLY_DECLARATIONS = 2;

/**
 * @typedef {object} SrOnlyVerdict
 * @property {boolean} ok
 * @property {readonly string[]} reasons
 * @property {number} declCount Size of the UNIONed declaration set across every matching rule.
 */

/** Index of the first `:` at paren depth 0 and outside any string, or -1. */
function firstTopLevelColon(text) {
  let paren = 0;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') paren += 1;
    if (ch === ')' && paren > 0) paren -= 1;
    if (ch === ':' && paren === 0) return i;
  }
  return -1;
}

/**
 * `[prop, value]` pairs, both lowercased and trimmed, split on `;` and then on the FIRST
 * `:` — both at `paren === 0` and outside strings. Lowercasing is what kills the
 * `DISPLAY:NONE` fixture; trimming is what kills `display : none`; the paren and string
 * guards are what keep `clip:rect(0,0,0,0)` and `content:"display:none"` honest.
 */
function parseDeclarations(body) {
  /** @type {string[]} */
  const chunks = [];
  let pending = '';
  let paren = 0;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (quote !== null) {
      pending += ch;
      if (ch === '\\') {
        pending += body.charAt(i + 1);
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      pending += ch;
      continue;
    }
    if (ch === '(') paren += 1;
    if (ch === ')' && paren > 0) paren -= 1;
    if (ch === ';' && paren === 0) {
      chunks.push(pending);
      pending = '';
      continue;
    }
    pending += ch;
  }
  chunks.push(pending);

  /** @type {Array<[string, string]>} */
  const out = [];
  for (const chunk of chunks) {
    const text = chunk.trim();
    if (text.length === 0) continue;
    const colon = firstTopLevelColon(text);
    if (colon === -1) continue;
    const prop = text.slice(0, colon).trim().toLowerCase();
    const value = stripImportant(
      text
        .slice(colon + 1)
        .trim()
        .toLowerCase(),
    );
    out.push([prop, value]);
  }
  return out;
}

/**
 * Drop a trailing `!important` (and the legal `! important` spacing) from a declaration
 * VALUE, so every check below compares the value itself.
 *
 * MEASURED, red-team m23-s2: without this, `srOnlyIsAccessible`'s equality comparisons are
 * wrong in BOTH directions at once, which is what makes it a defect rather than a taste
 * call. `display:none!important` parses as the value `'none !important'`, so
 * `value === 'none'` is FALSE and the banned declaration PASSES — Chromium confirmed the
 * node is then absent from the accessibility tree. And `position:absolute!important` — a
 * perfectly correct rule — parses as `'absolute !important'`, so `value === 'absolute'` is
 * FALSE and a CORRECT stylesheet is REJECTED. A false green and a false red from one bug.
 */
function stripImportant(value) {
  const bang = value.lastIndexOf('!');
  if (bang === -1) return value;
  if (value.slice(bang + 1).trim() !== 'important') return value;
  return value.slice(0, bang).trim();
}

/** True if any comma-separated compound selector in `prelude` targets the `.sr-only`
 *  CLASS TOKEN — not merely contains the substring. */
function selectorTargetsSrOnly(prelude) {
  for (const part of prelude.split(',')) {
    const sel = part.trim();
    let from = 0;
    for (;;) {
      const at = sel.indexOf(SR_ONLY_CLASS, from);
      if (at === -1) break;
      const after = sel.slice(at + SR_ONLY_CLASS.length);
      if (after.length === 0) return true;
      if (SR_ONLY_TOKEN_BOUNDARY.indexOf(after.charAt(0)) !== -1) return true;
      from = at + 1;
    }
  }
  return false;
}

/**
 * [A11Y-06] / criterion A11Y-11 — does `.sr-only` hide VISUALLY while staying IN the
 * accessibility tree?
 *
 * A MISSING `.sr-only` rule is a FAILURE with its own distinguishable reason, never a
 * vacuous pass: a stylesheet that simply forgot the rule satisfies "declares neither
 * display:none nor visibility:hidden" trivially, and that is precisely the shape this
 * oracle exists to refuse.
 *
 * Declarations are UNIONed across EVERY matching rule at EVERY depth (later rules win
 * per property, as the cascade does), so a correct top-level rule followed by a
 * `@media`-nested `.sr-only{display:none}` is still caught. The first-rule-only scan is a
 * real and attractive wrong implementation — it becomes likely the moment §2.7's
 * prefers-contrast block lands — and A7a's BAD fixture 8 is its killer.
 *
 * KNOWN RESIDUAL, stated rather than hidden: the selector list is split on `,` without
 * paren/string awareness, so `:is(.a, .b)` would be split mid-functional-selector. No
 * shipped or fixture selector in this slice uses that form; closing it needs the same
 * character walker firstTopLevelColon uses, and belongs with S10's reconciliation of this
 * scanner against evals/a11y-static-shell.eval.mjs (plan residual m4).
 */
export function srOnlyIsAccessible(src) {
  const matching = parseCssRules(src).filter((rule) => selectorTargetsSrOnly(rule.prelude));
  if (matching.length === 0) {
    return { ok: false, reasons: [SR_ONLY_REASON_MISSING], declCount: 0 };
  }

  /** @type {Map<string, string>} */
  const union = new Map();
  for (const rule of matching) {
    for (const [prop, value] of parseDeclarations(rule.body)) union.set(prop, value);
  }

  /** @type {string[]} */
  const reasons = [];
  if (union.get('position') !== 'absolute') reasons.push(SR_ONLY_REASON_POSITION);
  // KNOWN, DELIBERATE FALSE RED — do not "fix" it by narrowing the union.
  // `@media print{.sr-only{display:none}}` appended to an otherwise correct sheet is
  // standard, harmless CSS, and this oracle REJECTS it: the union is media-blind, so a
  // print-only banned declaration reads exactly like a screen one. That is the price of the
  // union, and the union is what catches the measured
  // `@media (prefers-contrast: more){.sr-only{display:none}}` bypass — a first-rule-only or
  // depth-0-only scan misses it. If a later slice genuinely needs print styles here, add
  // at-rule ANCESTRY tracking to `parseCssRules` and skip print-only ancestors. Never delete
  // the union: that trades a false red for a false green.
  if (!hasMeaningfulClip(union)) reasons.push(SR_ONLY_REASON_CLIP);
  for (const [prop, banned, reason] of SR_ONLY_BANNED_DECLARATIONS) {
    if (union.get(prop) === banned) reasons.push(reason);
  }
  if (union.size < MIN_SR_ONLY_DECLARATIONS) {
    reasons.push(`FEWER THAN ${MIN_SR_ONLY_DECLARATIONS} DECLARATIONS`);
  }
  return { ok: reasons.length === 0, reasons, declCount: union.size };
}

// ---------------------------------------------------------------------------
// RB12 (ADR-0215) — the SHARED stripCssComments corpus + naive reference fixture.
//
// A TRANSITION MATRIX, not a bag of examples: each cell below names one (state, event) pair of
// the four-state lexer {normal, dq, sq, comment}. The lexer's transition space is CLOSED (four
// states, a handful of triggering characters), so this corpus can be TRANSITION-TOTAL rather than
// merely sampled — the honest distinction from the `srOnlyIsAccessible` corpus ADR-0215 (and
// m23-s10 before it) rejected: that oracle ranges over an OPEN selector grammar, where a corpus
// can only ever sample.
//
// Both CI tiers run this corpus IN FULL: T10c/T10d/T10e below, and
// `client/src/indexShell.test.ts`'s RB12-G2/RB12-G3/RB12-G5/RB12-G6. Cell NAMES are load-bearing —
// both tiers' completeness gates pin them by exact string, in BOTH directions, so a deleted cell
// cannot silently shrink the corpus while a length floor alone stays green.
//
// HAZARD, repo-measured: never write a literal "/*" or "*/" in an evals/*.mjs source file (see
// MEMORY: server-module-source-scan-gotchas / recruit-eval-concatenates-test-files — an unpaired
// glob-slash blanks a LATER file under a naive regex stripper elsewhere in this repo's own eval
// tooling). Every comment delimiter in a fixture below is assembled from SLASH_STAR / STAR_SLASH,
// each built by joining two single-character literals — never typed as a two-character substring.
const SLASH_STAR = ['/', '*'].join('');
const STAR_SLASH = ['*', '/'].join('');

/**
 * The naive stripper's CURRENT body, VERBATIM — see `stripCssComments` above, which ADR-0215
 * hardens IN PLACE (same export name, new body) so it becomes the sole owner `parseCssRules` in
 * `client/src/indexShell.test.ts` imports. This copy is kept under a NEW name, forever,
 * independent of whatever `stripCssComments` becomes after that hardening — so the attack this
 * slice fixes stays provable after the fix lands, rather than disappearing along with the bug.
 *
 * NAMED FOR ITS ROLE, deliberately NOT `fixtureNaiveStripCssComments` — `evals/reduced-motion-hp-bar.eval.mjs:201`
 * already ships a function by THAT name with DIFFERENT semantics (it does not preserve newlines
 * inside comments). Re-using the name here would have recreated, one function over, exactly the
 * same-name/different-behaviour trap this slice exists to remove.
 *
 * Exists ONLY to prove NAIVE_KILLS bites (see T10e / RB12-G5 / RB12-G6). Never call it from
 * production code.
 */
export function fixtureUnhardenedCssStripper(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

/** The eleven (state, event) cells this corpus is transition-total over. Names are load-bearing:
 *  both completeness teeth (T10d here, RB12-G3 in indexShell.test.ts) pin this exact list, and
 *  RB12-G3's copy is deliberately RE-DECLARED rather than imported — see that tooth's comment. */
export const CSS_STRIPPER_CELLS = Object.freeze([
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

// Fixture CSS, assembled by concatenation — see the HAZARD note above. Each constant is used as
// BOTH the corpus cell's `css` input and (where the expected outcome is "unchanged") its expected
// `out`, so the two can never accidentally diverge by a transcription slip.
const CELL_COMMENT_OPEN_CLOSE_CSS = [SLASH_STAR, ' x ', STAR_SLASH, ' .a{color:red}'].join('');
const CELL_DQ_COMMENT_OPEN_INERT_CSS = ['.a{content:"', SLASH_STAR, '"}.b{display:none}'].join('');
const CELL_DQ_CLOSE_THEN_REAL_COMMENT_CSS = [
  '.a{content:"x"}',
  SLASH_STAR,
  ' gone ',
  STAR_SLASH,
  '.b{display:none}',
].join('');
const CELL_SQ_COMMENT_CLOSE_INERT_CSS = [".a{content:'", STAR_SLASH, "'}.b{display:none}"].join('');
// ADR-0215's own measured adversarial fixture ("Considered alternatives", Option A red-team
// finding): an ESCAPED quote inside a string, immediately followed by a comment-lookalike that is
// still INSIDE the (still-open) string. This is deliberately stronger than a bare
// `content:"/*"` fixture: a stripper that is escape-BLIND — even if otherwise quote- and
// comment-aware — misreads the escaped quote as closing the string early, then misreads the
// following slash-star as a REAL comment opener, corrupting legitimate CSS. The fully naive
// stripper (no quote-tracking at all, see fixtureUnhardenedCssStripper above) is tripped by the
// embedded slash-star for the same underlying reason `dq/comment-open-inert` trips it, but THIS
// cell also catches the narrower "quote-aware but escape-blind" mutant that a bare
// `content:"/*"` fixture does not exercise (that mutant tracks quotes correctly right up until
// the escaped-quote boundary, which is exactly what this cell targets).
const CELL_DQ_BACKSLASH_ESCAPE_CSS = ['.a{content:"x\\"', SLASH_STAR, '"}.b{display:none}'].join(
  '',
);
const CELL_COMMENT_NEWLINE_PRESERVED_CSS = [
  '.a{}',
  SLASH_STAR,
  ' l1\nl2 ',
  STAR_SLASH,
  '\n.b{display:none}',
].join('');
const CELL_EOF_IN_COMMENT_CSS = ['.a{color:red}', SLASH_STAR, ' unterminated'].join('');
const CELL_EOF_IN_STRING_CSS = '.a{content:"oops}';

/**
 * The shared, frozen fixture corpus, run in full by BOTH CI tiers.
 * `expect.kind === 'value'` means byte-equal to `out`; `expect.kind === 'throw'` means the
 * hardened `stripCssComments` must throw, with `needle` a substring of the thrown message.
 */
export const CSS_STRIPPER_CORPUS = Object.freeze([
  {
    name: 'normal/comment-open-close',
    css: CELL_COMMENT_OPEN_CLOSE_CSS,
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
    name: 'dq/comment-open-inert',
    css: CELL_DQ_COMMENT_OPEN_INERT_CSS,
    expect: { kind: 'value', out: CELL_DQ_COMMENT_OPEN_INERT_CSS },
  },
  {
    name: 'dq/close-then-real-comment',
    css: CELL_DQ_CLOSE_THEN_REAL_COMMENT_CSS,
    expect: { kind: 'value', out: '.a{content:"x"}.b{display:none}' },
  },
  {
    name: 'sq/comment-close-inert',
    css: CELL_SQ_COMMENT_CLOSE_INERT_CSS,
    expect: { kind: 'value', out: CELL_SQ_COMMENT_CLOSE_INERT_CSS },
  },
  {
    name: 'dq/backslash-escape',
    css: CELL_DQ_BACKSLASH_ESCAPE_CSS,
    expect: { kind: 'value', out: CELL_DQ_BACKSLASH_ESCAPE_CSS },
  },
  {
    name: 'comment/newline-preserved',
    css: CELL_COMMENT_NEWLINE_PRESERVED_CSS,
    expect: { kind: 'value', out: '.a{}\n\n.b{display:none}' },
  },
  {
    name: 'EOF/in-comment',
    css: CELL_EOF_IN_COMMENT_CSS,
    expect: { kind: 'throw', needle: 'unterminated comment' },
  },
  {
    name: 'EOF/in-string',
    css: CELL_EOF_IN_STRING_CSS,
    expect: { kind: 'throw', needle: 'unterminated string literal' },
  },
  {
    name: 'normal/empty',
    css: '',
    expect: { kind: 'value', out: '' },
  },
]);

/** Cells the naive `fixtureUnhardenedCssStripper` gets WRONG — see T10e / RB12-G5 / RB12-G6. */
export const NAIVE_KILLS = Object.freeze([
  'dq/comment-open-inert',
  'dq/backslash-escape',
  'EOF/in-comment',
  'EOF/in-string',
]);

/**
 * Strip HTML comments. LOAD-BEARING, not hygiene: `client/index.html:145` documents the live
 * region with the prose "A direct <body> child on purpose", and a tag scanner that does not remove
 * comments reads that `<body>` as a SECOND opened body element — which made the ancestor walk
 * report `html > body > body` and false-RED the shipped, correct markup. Measured on the real file.
 */
export function stripHtmlComments(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const stop = end === -1 ? html.length : end + 3;
      for (let k = i; k < stop; k++) if (html[k] === '\n') out += '\n';
      i = stop;
      continue;
    }
    out += html[i];
    i++;
  }
  return out;
}

/**
 * Every live-region-bearing element in an HTML source, as `{ tag, attrs, index }`.
 *
 * Counts IMPLICIT roles, not just the `aria-live` attribute: `status`, `alert`, `log`, `timer` and
 * `marquee` are live regions by role alone. An `aria-live`-only census reports one region on a
 * document that announces from two, which is worse than no census — a second channel interrupting
 * a battle announcement is precisely the defect §2.4 exists to prevent.
 */
export function findLiveRegions(html) {
  const regions = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  let m = tagRe.exec(html);
  while (m !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    // `/i` on BOTH patterns: HTML attribute names are case-insensitive, so `<div ARIA-LIVE=…>` and
    // `<div ROLE="status">` are valid and a case-sensitive census is blind to them (measured).
    // The value quote is OPTIONAL for the same reason — `<div role=status>` is legal HTML.
    const hasAriaLive = /\baria-live\s*=/i.test(attrs);
    const implicitRole = /\brole\s*=\s*(["']?)(status|alert|log|timer|marquee)\1[\s>]?/i.exec(
      attrs,
    );
    // `<output>` carries the implicit ARIA role `status` with NO attribute at all, so it is
    // invisible to any attribute-keyed census. It is the most plausible accidental second channel.
    const implicitTag = tag === 'output';
    if (hasAriaLive || implicitRole !== null || implicitTag) {
      const via = hasAriaLive
        ? 'aria-live'
        : implicitRole !== null
          ? `role=${implicitRole[2].toLowerCase()}`
          : 'tag=output';
      regions.push({ tag, index: m.index, via });
    }
    m = tagRe.exec(html);
  }
  return regions;
}

/**
 * The chain of open element tags enclosing `index`, outermost first. A hand-rolled walk rather than
 * a DOM parse because `evals/` is dependency-free by construction and this is the only structural
 * question asked of the markup. Void elements never open a scope.
 */
export function ancestorChain(html, index) {
  const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base']);
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)(\/?)>/g;
  let m = tagRe.exec(html);
  while (m !== null && m.index < index) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosing = m[4] === '/';
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else if (!VOID.has(tag) && !selfClosing) {
      stack.push({ tag, attrs: m[3] });
    }
    m = tagRe.exec(html);
  }
  return stack;
}

function walkClientFiles(root, prefix, accept) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = `${root}/${entry}`;
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      if (entry === 'module_bindings') continue; // generated
      out.push(...walkClientFiles(full, rel, accept));
    } else if (accept(entry)) {
      out.push(rel);
    }
  }
  return out;
}

const CLIENT_BUNDLED_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

/** Non-test `client/src/**` sources, as paths RELATIVE to `client/src`. UNCHANGED
 *  behaviour — the body is now a thin wrapper, the predicate is verbatim. */
export function listClientSourceFiles(root, prefix = '') {
  return walkClientFiles(
    root,
    prefix,
    (entry) =>
      // `.js`/`.mjs`/`.cjs`/`.tsx` as well as `.ts`: Vite bundles every one of them, so a rule
      // scoped to `.ts` alone is escaped by renaming a file (measured, red-team m23-s10).
      CLIENT_BUNDLED_EXTS.some((ext) => entry.endsWith(ext)) &&
      // `.endsWith('.test.ts')`, never `.includes(...)`: `.includes` admits `foo.test.ts.bak` and
      // a `x.test.ts/` directory, and a name-suffix exemption that admits disguised production
      // code is a measured shape in this repo.
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.d.ts'),
  );
}

/**
 * EVERY bundled `client/src/**` file INCLUDING `*.test.ts` / `*.test.tsx`.
 *
 * `listClientSourceFiles` excludes the specs BY DESIGN — and that exclusion is
 * exactly the disguised-twin blind spot the sole-owner scan exists to close.
 * Red-team's C9 was a COMPLETE second CSS oracle in `client/src/cssOracle.test.ts`:
 * it passed the shape ban (that gate reads only `indexShell.test.ts`), it passed
 * all four retained delegation needles, and it passed the non-test file walk,
 * because no clause in the slice ever opened a `.test.ts` file other than the
 * delegate. A second implementation in a spec file is still a second
 * implementation, and vitest still runs it.
 */
function listClientSpecFiles(root) {
  return walkClientFiles(
    root,
    '',
    (entry) => CLIENT_BUNDLED_EXTS.some((ext) => entry.endsWith(ext)) && !entry.endsWith('.d.ts'),
  );
}

/**
 * The nine symbols this file now SOLE-OWNS, assembled from fragments so this list
 * cannot satisfy any needle built from it.
 */
const RB15_OWNED_SYMBOLS = Object.freeze([
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

/** The only legal route from `client/src` to those symbols. */
const RB15_OWNER_NS = ['rb12Css', 'StripperOracle'].join('');

/** Characters that make a REGEX LITERAL hazardous to any comment/string scanner. */
const RB15_REGEX_HAZARDS = Object.freeze(['*', '/', "'", '"', '`']);

/** Characters after which a `/` is DIVISION or markup, never the start of a regex literal.
 *  `<`/`>` are included because `client/src` test files quote HTML in failure messages. */
const RB15_NOT_REGEX_START = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$)]<>';

/**
 * FAIL LOUD on a regex literal that would desynchronise the scanners T-OWN reads every
 * `client/src` file through.
 *
 * MEASURED (red-team, rb-15 artifact pass): `stripTsComments` treats the `/` + `*` inside a
 * `/[/*]/` character class as a real block-comment opener and blanks to the next `*` + `/` WITH
 * NO THROW, and `stripTsCommentsAndStrings` desynchronises on a quote inside a class and returns
 * a best-effort string. Either hides an arbitrary span of a scanned file, and a file whose
 * scanner gave up then reports "no violations" for entirely the wrong reason. Those two
 * strippers live in a sibling eval that is outside this slice's `touches:`, so the guard lives
 * here, at the call site, where it can still refuse the input.
 *
 * LINE-LOCAL BY CONSTRUCTION so it needs none of the lexing it guards, and deliberately
 * OVER-APPROXIMATING: a false RED is loud and fixable, a false GREEN is not. Its twin in
 * `client/src/indexShell.test.ts` is deliberately a SEPARATE copy — a gate that reads its own
 * bytes must not ask another module (one the delegate could `vi.mock`) to tell it the truth
 * about them.
 */
function rb15AssertNoHazardousRegex(src, label) {
  const lines = src.split('\n');
  for (let ln = 0; ln < lines.length; ln += 1) {
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
        return (
          `${label} line ${ln + 1}: an apparent regex literal does not terminate on its own ` +
          `line, so the comment/string scan of this file desynchronises. Line: ${JSON.stringify(raw)}`
        );
      }
      const hazards = RB15_REGEX_HAZARDS.filter((h) => body.indexOf(h) !== -1);
      if (hazards.length > 0) {
        return (
          `${label} line ${ln + 1}: the regex literal carries ${JSON.stringify(hazards)}, which ` +
          `blanks an arbitrary span from the ownership scan. Line: ${JSON.stringify(raw)}`
        );
      }
      i = j + 1;
      prev = '/';
    }
  }
  return '';
}

/**
 * DELIBERATE TWIN of `rb15IsWordChar` / `rb15WordOccurrences` / `rb15ShapeBanViolations`
 * / `rb15CensusViolations` in `client/src/indexShell.test.ts`.
 *
 * This duplication is the POINT and must not be "consolidated" — the same ruling
 * ADR-0215 made for `SLASH_STAR`/`STAR_SLASH` and `rb12StripJsComments`. If both
 * tiers shared ONE detector, gutting that detector would green BOTH tiers in a
 * single edit, which is precisely the single-point-of-failure the two-source
 * pattern exists to prevent. Each copy ships its own RED controls (RB15-G1/G4 in
 * the `.ts`, T-OWN-FIX1/T-OWN-FIX2 below), so a gutted copy reds its own controls.
 */
function rb15IsWordChar(ch) {
  if (ch === '') return false;
  if (ch >= 'a' && ch <= 'z') return true;
  if (ch >= 'A' && ch <= 'Z') return true;
  if (ch >= '0' && ch <= '9') return true;
  return ch === '_' || ch === '$';
}

function rb15WordOccurrences(src, name) {
  const out = [];
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

function rb15LineNo(src, idx) {
  let line = 1;
  let at = src.indexOf('\n');
  while (at !== -1 && at < idx) {
    line += 1;
    at = src.indexOf('\n', at + 1);
  }
  return line;
}

function rb15IsImportLine(src, idx) {
  const lineStart = src.lastIndexOf('\n', idx - 1) + 1;
  const nl = src.indexOf('\n', idx);
  return (
    src
      .slice(lineStart, nl === -1 ? src.length : nl)
      .trim()
      .indexOf('import') === 0
  );
}

function rb15NextSignificant(src, from) {
  let i = from;
  while (i < src.length && (src.charAt(i) === ' ' || src.charAt(i) === '\t')) i += 1;
  return src.charAt(i);
}

/** LOCAL-DEF / LOCAL-ASSIGN definition shapes. `src` must be COMMENT-stripped, strings intact. */
function rb15ShapeBanViolations(src, names) {
  const found = [];
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
      const eqAt = src.indexOf('=', at + name.length);
      if (src.charAt(eqAt + 1) === '=') continue;
      assignCount += 1;
    }
    if (assignCount > 0) found.push(`LOCAL-ASSIGN ${name} x${assignCount}`);
  }
  return found;
}

/** Occurrence census + namespace integrity. `src` must be comment-AND-string-stripped. */
function rb15CensusViolations(src, names, ns) {
  const found = [];
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
    if (src.charAt(at + ns.length) === '.') continue;
    found.push(`NAMESPACE-ESCAPE @${rb15LineNo(src, at)}`);
  }
  return found;
}

/**
 * Which modules other than the declared owner NAME the live-region node.
 *
 * `sources` maps a relative path to its RAW source; comments are stripped here so a header
 * explaining the ownership rule is not itself a violation. Ownership is checked instead of
 * receiver text because a receiver-text ban was measured to miss all five realistic spellings of
 * "destroy the live region", every one of which must first NAME the node to reach it.
 */
export function findLiveRegionIntruders(sources) {
  const intruders = [];
  for (const [path, raw] of Object.entries(sources)) {
    if (path === LIVE_REGION_OWNER) continue;
    const stripped = stripTsComments(raw);
    if (LIVE_REGION_NAMES.some((n) => stripped.indexOf(n) !== -1)) intruders.push(path);
  }
  return intruders.sort();
}

/**
 * Modules that destroy the live region WITHOUT naming it — the half `findLiveRegionIntruders`
 * structurally cannot see, and the half §5.2's original `replaceChildren` clause was aimed at.
 *
 * CORRECTION, recorded because the first draft of this eval got it wrong: module ownership does NOT
 * subsume the receiver clause. `const b = document.body; b.replaceChildren();` and
 * `document.body.innerHTML` never mention `a11y-live`, so ownership is blind to them — and the live
 * region is a direct `<body>` child, so a body-level rebuild destroys it. This clause bans the two
 * roots as receivers, and bans reaching the node by ARIA SELECTOR (`[aria-live]`, `[role="status"]`)
 * from anywhere but the owner, which is the last spelling that needs no id.
 *
 * `.remove()` is deliberately absent from the receiver list: `document.body.remove()` is not a
 * realistic shape and adding it would only widen the false-positive surface.
 */
export function findLiveRegionDestroyers(sources) {
  // Destructive DOM rebuilds. `appendChild` is deliberately ABSENT: appending to `document.body` is
  // how `sessionView.ts:21`, `claimView.ts:57` and `main.ts:2191` legitimately mount, and banning
  // it would make this clause unusable and therefore deleted.
  const DESTRUCTIVE = ['replaceChildren', 'innerHTML', 'removeChild', 'remove()'];
  const ARIA_SELECTORS = ['[aria-live', "[role='status'", '[role="status"'];
  // A binding initialised from a document root, in any of `const x = document.body`,
  // `let x = …`, a bare re-assignment, or a DEFAULT PARAMETER. Measured: the aliased form
  // `const b = document.body; b.replaceChildren();` is invisible to a direct-receiver scan, and a
  // fixture that mixed it with the direct form passed for the wrong reason.
  const ALIAS_RE = /([A-Za-z_$][\w$]*)\s*(?::[^=;()]*)?=\s*document\.(?:body|documentElement)\b/g;
  const found = [];
  for (const [path, raw] of Object.entries(sources)) {
    const stripped = stripTsComments(raw);

    // 1. the direct receiver.
    for (const op of DESTRUCTIVE) {
      for (const root of ['document.body.', 'document.documentElement.']) {
        if (stripped.indexOf(root + op) !== -1) found.push(`${path} (${root}${op})`);
      }
    }

    // 2. the SAME operation through an alias. The default-parameter form (`mount: HTMLElement =
    //    document.body`, errorOverlayView.ts:22) is captured too, and correctly stays clean —
    //    that module only ever calls `mount.appendChild`, which is not a destructive op.
    ALIAS_RE.lastIndex = 0;
    let m = ALIAS_RE.exec(stripped);
    while (m !== null) {
      const alias = m[1];
      for (const op of DESTRUCTIVE) {
        if (stripped.indexOf(`${alias}.${op}`) !== -1) {
          found.push(`${path} (${alias} = document root, then ${alias}.${op})`);
        }
      }
      m = ALIAS_RE.exec(stripped);
    }

    // 3. reaching the node by ARIA SELECTOR — the last spelling that needs no id and no root.
    if (path === LIVE_REGION_OWNER) continue;
    const viaAria = ARIA_SELECTORS.find((r) => stripped.indexOf(r) !== -1);
    if (viaAria !== undefined) found.push(`${path} (${viaAria})`);
  }
  return found.sort();
}

// =============================================================================
// rb-15 (R-m23-s10-X18) — THE TWO SHARED, FROZEN FIXTURE TABLES.
//
// One source, executed IN FULL by BOTH tiers: this eval's teeth and the vitest tier's RB15-G2.
// They read `SLASH_STAR` / `STAR_SLASH`, so they must stay below those two consts (TDZ).
//
// PROVENANCE — every row below is LIFTED, not re-typed from scratch:
//   * ID_SELECTOR_FIXTURES rows 1-8  <- client/src/indexShell.test.ts:1962-2010 (A6a `bad`)
//   * ID_SELECTOR_FIXTURES rows 9-14 <- client/src/indexShell.test.ts:2022-2049 (A6a `good`)
//   * SR_ONLY_FIXTURES     rows 1-15 <- client/src/indexShell.test.ts:2174-2284 (A7a `bad`)
//   * SR_ONLY_FIXTURES     rows 17-20<- client/src/indexShell.test.ts:2302-2325 (A7a `good`)
// Each row's `kills` prose is the ORIGINAL `kills:` / `why:` string, VERBATIM — it is
// the record of what the row kills and re-wording it destroys evidence. For GOOD rows
// the prose is the FALSE RED the row kills (an over-broad oracle that rejects it),
// which is why one field name serves both halves.
//
// TWO rows are NEW (marked `ADDED rb-15`), both required by REVISION 2:
//   * `sr/good/position-absolute-important` — the MIRROR-IMAGE of the `stripImportant`
//     bug. A7a pinned only the false-GREEN direction (`display:none!important`); the
//     false-RED direction (`position:absolute!important` on a CORRECT rule) shipped
//     unexercised, so bite-proof M11 had only half a kill.
//   * `sr/bad/min-declaration-floor` — the ONLY row where `FEWER THAN 2 DECLARATIONS`
//     is the discriminating reason with `position IS NOT absolute` NOT also firing.
//     Under `.includes(reason)` the floor was invisible (red-team R3: MIN=0 survived
//     every tooth); under EXACT-SET equality this row alone kills MIN=0 and MIN=1.
//
// EXPECTED OUTCOMES (`offenders` / `reasons`) are pinned per row. Reasons are compared
// as a SET (sorted equality), never with `.includes` — R3 MEASURED that a constant-fail
// oracle returning EVERY reason survives all 15 BAD rows under `.includes`.
//
// REASON STRINGS ARE WRITTEN AS LITERALS, not as references to the module-private
// `SR_ONLY_REASON_*` constants. That is deliberate and strictly stronger: the table is a
// SECOND, INDEPENDENT source, so mutating a constant now REDs instead of moving both
// sides of the comparison together (the tautology R3 names).
//
// HAZARD (repo-measured, see the note above CSS_STRIPPER_CELLS): never write a literal
// comment opener/closer in an `evals/*.mjs` source file. Rows `id/bad/commented-decoy-
// plus-real` and `id/bad/string-decoy-then-real` assemble theirs from SLASH_STAR /
// STAR_SLASH, exactly as the stripper corpus does.
// =============================================================================

/**
 * The `.sr-only` rule this repo SHIPS, as a fixture string.
 *
 * SINGLE-OWNED HERE, not duplicated in `client/src/indexShell.test.ts`. It was a `const`
 * in that file (`:2154`); leaving a copy there while this table carries another is the
 * exact drift rb-15 exists to delete, one blob lower. A7b's positive control probe reads
 * `rb12CssStripperOracle.SHIPPED_SR_ONLY_RULE`.
 *
 * NEVER an equality target against the real `styles.css`: spec §5.2 demands the check be
 * on SEMANTICS and not on a copied literal, so the real file is judged only by
 * `srOnlyIsAccessible`.
 */
export const SHIPPED_SR_ONLY_RULE = [
  '.sr-only {',
  '  position: absolute;',
  '  width: 1px;',
  '  height: 1px;',
  '  padding: 0;',
  '  margin: -1px;',
  '  overflow: hidden;',
  '  clip-path: inset(50%);',
  '  white-space: nowrap;',
  '  border: 0;',
  '}',
].join('\n');

/**
 * `[A11Y-07]` / criterion A11Y-12 — the id-selector corpus, run IN FULL by BOTH tiers
 * (the teeth below, and `RB15-G2` in `client/src/indexShell.test.ts`).
 *
 * Row shape: `{ name, kind: 'bad' | 'good', css, offenders, kills }`.
 * `offenders` is the EXACT array `findIdSelectors(css)` must return — order included,
 * because the walk emits in source order and a re-ordering scanner is a different scanner.
 * A `good` row's `offenders` is `[]`, and a `bad` row's is non-empty; both halves are
 * asserted, so a row cannot be trivialised into the wrong half without reddening.
 *
 * @type {ReadonlyArray<{ name: string, kind: 'bad' | 'good', css: string,
 *   offenders: readonly string[], kills: string }>}
 */
export const ID_SELECTOR_FIXTURES = Object.freeze([
  {
    name: 'id/bad/baseline-pinned-id',
    kind: 'bad',
    css: '#help-overlay{z-index:1}',
    offenders: Object.freeze(['#help-overlay']),
    kills: 'the baseline case — a rule reaching an id whose inline style THIS FILE pins (H7)',
  },
  {
    name: 'id/bad/selector-list-second-position',
    kind: 'bad',
    css: '.sr-only,#help-hint{position:absolute}',
    offenders: Object.freeze(['.sr-only,#help-hint']),
    kills: 'a /^#/m line-anchored matcher, and any first-token-only selector check',
  },
  {
    name: 'id/bad/descendant-part',
    kind: 'bad',
    css: 'body #help-overlay{color:#fff}',
    offenders: Object.freeze(['body #help-overlay']),
    kills: "prelude.startsWith('#') — the id is a DESCENDANT part of the selector",
  },
  {
    name: 'id/bad/media-nested',
    kind: 'bad',
    css: '@media (prefers-contrast: more){#build-stamp{opacity:1}}',
    offenders: Object.freeze(['#build-stamp']),
    kills: 'a depth-0-only walk — spec §2.7 puts prefers-contrast rules in this very file',
  },
  {
    name: 'id/bad/glued-to-type-selector',
    kind: 'bad',
    css: 'div#menu-overlay{display:block}',
    offenders: Object.freeze(['div#menu-overlay']),
    kills: 'a whitespace-then-hash matcher — the id is glued to a type selector',
  },
  {
    name: 'id/bad/hash-colour-before-id-rule',
    kind: 'bad',
    css: '.a{color:#fff}\n#x{color:red}',
    offenders: Object.freeze(['#x']),
    kills: 'bail-at-first-hash: the first hash in the file is a COLOUR, the id rule follows',
  },
  {
    name: 'id/bad/commented-decoy-plus-real',
    kind: 'bad',
    css: [SLASH_STAR, ' #help-overlay{z-index:9} ', STAR_SLASH, '\n#help-overlay{z-index:1}'].join(
      '',
    ),
    offenders: Object.freeze(['#help-overlay']),
    kills:
      'naive comment handling in BOTH directions — a scanner that ignores comments ' +
      'reports 2 (the commented-out decoy inflates the count and would let a reviewer ' +
      '"fix" the real rule by deleting the comment), and one that strips greedily ' +
      'reports 0',
  },
  {
    name: 'id/bad/string-decoy-then-real',
    kind: 'bad',
    css: ['.x{content:"', SLASH_STAR, '"}\n#help-overlay{z-index:1}'].join(''),
    offenders: Object.freeze(['#help-overlay']),
    kills:
      'a comment stripper that is NOT string-aware: it opens a comment inside the ' +
      'content value, never finds a closer, swallows the rest of the file and reports ' +
      'ZERO id selectors — the false GREEN, the only kind that matters',
  },

  // The GOOD half. A naive `css.includes('#')` wrongly REDS all six of these — the
  // plan's named anti-pattern. A false red matters because it is how a correct stylesheet
  // gets "fixed" by weakening the scanner until it also stops catching the BAD half.
  {
    name: 'id/good/hex-colour-in-nested-decl',
    kind: 'good',
    css: '@media (prefers-reduced-motion: reduce){.x{color:#fff}}',
    offenders: Object.freeze([]),
    kills: 'a hex COLOUR in a nested declaration is not a selector (§2.7 ships this shape)',
  },
  {
    // FR3, red-team m23-s2: MEASURED as a false RED before `preludeHasUnquotedHash`
    // handled backslash escapes. An escaped character is a literal in an IDENTIFIER.
    name: 'id/good/escaped-hash-in-class-name',
    kind: 'good',
    css: '.\\#notanid{color:red}',
    offenders: Object.freeze([]),
    kills: 'an ESCAPED hash inside a CLASS name — a class, not an id selector',
  },
  {
    name: 'id/good/hash-in-quoted-value',
    kind: 'good',
    css: '.x{content:"#not-a-selector"}',
    offenders: Object.freeze([]),
    kills: 'a hash inside a quoted VALUE',
  },
  {
    name: 'id/good/url-fragment-reference',
    kind: 'good',
    css: '.x{background:url(#grad)}',
    offenders: Object.freeze([]),
    kills: 'a fragment reference inside url() — real CSS for SVG paint servers',
  },
  {
    name: 'id/good/at-rule-prelude-hash',
    kind: 'good',
    css: '@supports (color:#fff){.x{color:#fff}}',
    offenders: Object.freeze([]),
    kills: 'a hash inside an AT-RULE PRELUDE, which is never a selector and never inspected',
  },
  {
    name: 'id/good/quoted-hash-in-prelude',
    kind: 'good',
    css: '[href="#top"]{color:red}',
    offenders: Object.freeze([]),
    kills: 'a hash inside a QUOTED STRING that really is inside a selector prelude',
  },
]);

/**
 * `[A11Y-06]` / criterion A11Y-11 — the `.sr-only` corpus, run IN FULL by BOTH tiers.
 *
 * Row shape: `{ name, kind: 'bad' | 'good', css, reasons, kills }`.
 * `reasons` is the EXACT reason SET `srOnlyIsAccessible(css).reasons` must produce,
 * compared order-insensitively by sorted equality. NOT `.includes` — red-team MEASURED
 * that a constant-fail oracle returning EVERY reason survives all 15 BAD rows under
 * `.includes`, so the entire kill came from the GOOD half.
 *
 * @type {ReadonlyArray<{ name: string, kind: 'bad' | 'good', css: string,
 *   reasons: readonly string[], kills: string }>}
 */
export const SR_ONLY_FIXTURES = Object.freeze([
  {
    name: 'sr/bad/display-none',
    kind: 'bad',
    css: '.sr-only{display:none}',
    reasons: Object.freeze([
      'position IS NOT absolute',
      'NEITHER clip-path NOR clip is a MEANINGFUL clip',
      'display:none REMOVES THE NODE FROM THE ACCESSIBILITY TREE',
      'FEWER THAN 2 DECLARATIONS',
    ]),
    kills: 'the headline defect — display:none removes the node from the a11y tree entirely',
  },
  {
    // B3, red-team m23-s2: MEASURED green before `stripImportant` existed, and Chromium
    // confirmed the announcement absent from the AX tree. The value parses as
    // `'none !important'`, so an equality check against `'none'` waves the banned
    // declaration straight through. The GOOD half carries the mirror-image false RED.
    name: 'sr/bad/display-none-important',
    kind: 'bad',
    css: '.sr-only{position:absolute;clip-path:inset(50%);width:1px;display:none!important}',
    reasons: Object.freeze(['display:none REMOVES THE NODE FROM THE ACCESSIBILITY TREE']),
    kills:
      'an equality check that forgets !important — the banned declaration parses as ' +
      '"none !important" and slips past every value comparison',
  },
  {
    name: 'sr/bad/visibility-hidden-important-spaced',
    kind: 'bad',
    css: '.sr-only{position:absolute;clip-path:inset(50%);visibility:hidden !important}',
    reasons: Object.freeze(['visibility:hidden REMOVES THE NODE FROM THE ACCESSIBILITY TREE']),
    kills: 'the same !important hole on the visibility clause, with the legal spacing',
  },
  {
    // B4, red-team m23-s2: MEASURED green under a `union.has()` presence check, with
    // Chromium painting 1651 px² of announcement text on screen — verbatim the "renders
    // as stray visible text" failure this criterion exists to prevent.
    name: 'sr/bad/inert-clip-pair',
    kind: 'bad',
    css: '.sr-only{position:absolute;clip:auto;clip-path:none}',
    reasons: Object.freeze(['NEITHER clip-path NOR clip is a MEANINGFUL clip']),
    kills:
      'a PRESENCE check on the clip: both properties are declared and both are INERT, ' +
      'so the rule looks complete and hides nothing at all',
  },
  {
    // B8, red-team m23-s2: MEASURED green, Chromium IN_A11Y_TREE = false. Same outcome
    // as display:none, on a property a two-name deny-list never mentions.
    name: 'sr/bad/content-visibility-hidden',
    kind: 'bad',
    css: '.sr-only{position:absolute;clip-path:inset(50%);content-visibility:hidden}',
    reasons: Object.freeze([
      'content-visibility:hidden REMOVES THE SUBTREE FROM THE ACCESSIBILITY TREE',
    ]),
    kills:
      'a deny-list that names only display and visibility — content-visibility:hidden ' +
      'removes the subtree from the accessibility tree just as completely',
  },
  {
    name: 'sr/bad/display-contents',
    kind: 'bad',
    css: '.sr-only{position:absolute;clip-path:inset(50%);display:contents}',
    reasons: Object.freeze(['display:contents ERASES THE BOX, so the clip applies to nothing']),
    kills:
      'display:contents — it erases the BOX, so the clip that is doing the hiding ' +
      'applies to nothing and the text lays out inline in the body',
  },
  {
    name: 'sr/bad/visibility-hidden-with-correct-pair',
    kind: 'bad',
    css: '.sr-only{visibility:hidden;clip-path:inset(50%);position:absolute}',
    reasons: Object.freeze(['visibility:hidden REMOVES THE NODE FROM THE ACCESSIBILITY TREE']),
    kills:
      'a PRESENCE-ONLY check: this rule HAS the required position + clip pair and is ' +
      'still silent to every AT, because visibility:hidden also leaves the tree',
  },
  {
    name: 'sr/bad/clip-only-no-position',
    kind: 'bad',
    css: '.sr-only{clip-path:inset(50%)}',
    reasons: Object.freeze(['position IS NOT absolute', 'FEWER THAN 2 DECLARATIONS']),
    kills:
      'a clip-only check. The reason is narrower than it looks: the LEGACY `clip` ' +
      'property applies only to absolutely-positioned boxes, so `clip` without ' +
      '`position:absolute` hides nothing at all. `clip-path` does apply either way, but ' +
      'an in-flow 1px box still occupies a line box and disturbs layout, and spec §5.2 ' +
      'requires the pair. Requiring both is what makes the legacy form (the GOOD fixture ' +
      'below, which the spec demands PASS) actually correct rather than accidentally so.',
  },
  {
    name: 'sr/bad/position-only-no-clip',
    kind: 'bad',
    css: '.sr-only{position:absolute;overflow:hidden;width:1px;height:1px}',
    reasons: Object.freeze(['NEITHER clip-path NOR clip is a MEANINGFUL clip']),
    kills: 'a position-only check — with no clip at all the 1px box still paints',
  },
  {
    name: 'sr/bad/space-around-colon',
    kind: 'bad',
    css: '.sr-only{display : none}',
    reasons: Object.freeze([
      'position IS NOT absolute',
      'NEITHER clip-path NOR clip is a MEANINGFUL clip',
      'display:none REMOVES THE NODE FROM THE ACCESSIBILITY TREE',
      'FEWER THAN 2 DECLARATIONS',
    ]),
    kills: "includes('display:none') — CSS permits whitespace around the colon",
  },
  {
    name: 'sr/bad/uppercase-property-and-value',
    kind: 'bad',
    css: '.sr-only{DISPLAY:NONE}',
    reasons: Object.freeze([
      'position IS NOT absolute',
      'NEITHER clip-path NOR clip is a MEANINGFUL clip',
      'display:none REMOVES THE NODE FROM THE ACCESSIBILITY TREE',
      'FEWER THAN 2 DECLARATIONS',
    ]),
    kills: 'a case-sensitive needle — CSS property names and keywords are case-insensitive',
  },
  {
    name: 'sr/bad/media-nested-display-none',
    kind: 'bad',
    css: '@media (prefers-contrast: more){.sr-only{display:none}}',
    reasons: Object.freeze([
      'position IS NOT absolute',
      'NEITHER clip-path NOR clip is a MEANINGFUL clip',
      'display:none REMOVES THE NODE FROM THE ACCESSIBILITY TREE',
      'FEWER THAN 2 DECLARATIONS',
    ]),
    kills: 'a depth-0-only walk — the banned declaration must be caught at ANY depth',
  },
  {
    name: 'sr/bad/correct-then-media-override',
    kind: 'bad',
    css: `${SHIPPED_SR_ONLY_RULE}\n@media (prefers-contrast: more){.sr-only{display:none}}`,
    reasons: Object.freeze(['display:none REMOVES THE NODE FROM THE ACCESSIBILITY TREE']),
    kills:
      'a FIRST-RULE-ONLY scan: the correct rule comes first and passes, and the @media ' +
      'override that actually ships display:none is never looked at. This is what the ' +
      'UNION across all matching rules exists for, and it becomes the likely shape the ' +
      'moment §2.7 adds its prefers-contrast block',
  },
  {
    name: 'sr/bad/rule-missing-entirely',
    kind: 'bad',
    css: '.other{color:red}',
    reasons: Object.freeze(['NO .sr-only RULE']),
    kills:
      'a VACUOUS PASS on a missing rule — "declares neither display:none nor ' +
      'visibility:hidden" is trivially true of a stylesheet with no .sr-only at all, ' +
      'and #a11y-live would then render as visible stray text',
  },
  {
    name: 'sr/bad/empty-rule',
    kind: 'bad',
    css: '.sr-only{}',
    reasons: Object.freeze([
      'position IS NOT absolute',
      'NEITHER clip-path NOR clip is a MEANINGFUL clip',
      'FEWER THAN 2 DECLARATIONS',
    ]),
    kills:
      'an empty rule satisfying the two NEGATIVES vacuously — the positives (and the ' +
      'minimum declaration count) are what refuse it',
  },
  {
    // ADDED rb-15 (REVISION 2, R3). The ONLY row on which `FEWER THAN 2 DECLARATIONS` is
    // a discriminating reason while `position IS NOT absolute` is SILENT, so the floor is
    // pinned in isolation rather than only ever riding along with three other reasons.
    // MIN_SR_ONLY_DECLARATIONS = 0 makes the reason list `[CLIP]`; MIN = 1 likewise; both
    // RED here and NOWHERE else. Under the old `.includes(reason)` assertion the floor was
    // invisible in every direction (red-team measured MIN = 0 surviving all 20 rows).
    name: 'sr/bad/min-declaration-floor',
    kind: 'bad',
    css: '.sr-only{position:absolute}',
    reasons: Object.freeze([
      'NEITHER clip-path NOR clip is a MEANINGFUL clip',
      'FEWER THAN 2 DECLARATIONS',
    ]),
    kills:
      'MIN_SR_ONLY_DECLARATIONS lowered to 0 or 1 — every other row that carries the ' +
      'floor reason also carries "position IS NOT absolute", so the floor could be ' +
      'deleted outright while all of them still failed for the other reason',
  },

  {
    name: 'sr/good/shipped-clip-path-form',
    kind: 'good',
    css: SHIPPED_SR_ONLY_RULE,
    reasons: Object.freeze([]),
    kills: 'the rule this slice ships — clip-path form, spec §5.2 GOOD fixture',
  },
  {
    name: 'sr/good/legacy-clip-rect-form',
    kind: 'good',
    css: '.sr-only{position:absolute;clip:rect(0,0,0,0)}',
    reasons: Object.freeze([]),
    kills:
      'the LEGACY clip:rect form. Spec §5.2 REQUIRES this to PASS, "proving the check ' +
      'is on semantics and not on a copied literal" — an oracle that compares against ' +
      'the shipped blob, or that demands clip-path specifically, reds here',
  },
  {
    name: 'sr/good/focusable-token-boundary',
    kind: 'good',
    css: `.sr-only-focusable{display:none}\n${SHIPPED_SR_ONLY_RULE}`,
    reasons: Object.freeze([]),
    kills:
      "the CLASS-TOKEN BOUNDARY: selector.includes('.sr-only') also matches " +
      '.sr-only-focusable and imports its display:none into the union, reddening a ' +
      'perfectly correct stylesheet',
  },
  {
    name: 'sr/good/banned-text-inside-string',
    kind: 'good',
    css: '.sr-only{content:"display:none";position:absolute;clip-path:inset(50%)}',
    reasons: Object.freeze([]),
    kills: 'STRING-AWARENESS: the banned text appears only inside a quoted value',
  },
  {
    // ADDED rb-15 (REVISION 2, R3 / bite-proof M11). The MIRROR IMAGE of
    // `sr/bad/display-none-important`. Without `stripImportant`, `position:absolute
    // !important` parses as the value `'absolute !important'`, `value === 'absolute'` is
    // FALSE, and a PERFECTLY CORRECT stylesheet is REJECTED. A7a pinned only the false-
    // GREEN direction, so bypassing stripImportant reddened one row instead of two and
    // the false-RED half of the bug shipped unexercised.
    name: 'sr/good/position-absolute-important',
    kind: 'good',
    css: '.sr-only{position:absolute!important;clip-path:inset(50%)}',
    reasons: Object.freeze([]),
    kills:
      'a stripImportant bypass in the FALSE-RED direction — the correct rule parses as ' +
      '"absolute !important", the equality against "absolute" fails, and a shipping-' +
      'correct stylesheet is rejected. Also the exact-2-declaration boundary row for ' +
      'MIN_SR_ONLY_DECLARATIONS: raising the floor to 3 reds here.',
  },
]);

/**
 * The delegation table for `[A11Y-06]`/`[A11Y-07]`/`[A11Y-08]`. Each needle set names BOTH the
 * oracle's definition AND the call that runs it against the real artefact — a definition alone
 * would let the delegate keep a dead function nobody invokes.
 */
export const SHELL_DELEGATIONS = Object.freeze([
  {
    tag: '[A11Y-06]',
    criterion:
      'A11Y-11 — .sr-only stays in the accessibility tree (no display:none/visibility:hidden)',
    file: 'client/src/indexShell.test.ts',
    titleNeedles: [],
    // The DEFINITION, the call ON THE REAL ARTEFACT, and an `expect` that consumes its result.
    // The third is what stops a delegate keeping the call as a bare statement whose verdict nothing
    // reads — a measured way to satisfy a presence-only pin while gating nothing.
    codeNeedles: ['srOnlyIsAccessible(readStylesCss())', 'expect(verdict.ok'],
  },
  {
    tag: '[A11Y-07]',
    criterion:
      'A11Y-12 — styles.css contains zero #id selectors (the inline-style pins stay total)',
    file: 'client/src/indexShell.test.ts',
    titleNeedles: [],
    codeNeedles: ['findIdSelectors(css)', 'expect(\n      offenders,'],
  },
  {
    tag: '[A11Y-08]',
    criterion: 'A11Y-17 — the canvas is the world region; #app carries no role',
    file: 'client/src/render/world.test.ts',
    titleNeedles: ['S4-WORLD-CANVAS-REGION'],
    // `app.canvas.setAttribute('role'` is NOT usable as a needle here: it appears in this
    // delegate's own BAD/GOOD FIXTURE strings, so it would be satisfied by the fixtures alone.
    // These three are executable identifiers on the real-artefact path instead.
    codeNeedles: ['readWorldSource()', 'anchorNeedle', 'tCalls'],
  },
]);

export default async function () {
  const name = 'a11y-static-shell ([A11Y-05a/05b] live region + [A11Y-06/07/08] delegation)';
  let teeth = 0;
  const teethTotal = 81;
  const bad = (detail) => ({ name, pass: false, detail });
  const shellNeedles = SHELL_DELEGATIONS.reduce(
    (n, d) => n + d.titleNeedles.length + d.codeNeedles.length,
    0,
  );

  // ==================================================================
  // PROOF-OF-TEETH — fixtures first, real files after.
  // ==================================================================

  // T1 BAD (the control): two explicit aria-live nodes.
  if (
    findLiveRegions('<body><p aria-live="polite"></p><p aria-live="polite"></p></body>').length !==
    2
  ) {
    return bad('TEETH T1: findLiveRegions did not count two explicit aria-live nodes');
  }
  teeth++;

  // T2 BAD (the measured hole): a SECOND region declared only by an implicit role. An aria-live
  // count reports one and ships a document that announces from two.
  const implicitHtml = '<body><p id="a" aria-live="polite"></p><div role="status"></div></body>';
  if (findLiveRegions(implicitHtml).length !== 2) {
    return bad(
      'TEETH T2: a second live region declared as role="status" was NOT counted — implicit ' +
        'live-region roles (status/alert/log/timer/marquee) carry no aria-live attribute, so an ' +
        'aria-live census reports one region on a document that announces from two',
    );
  }
  teeth++;

  // T3 BAD: `role="alert"` likewise — a second implicit spelling, so the check cannot collapse to
  // the single role name T2 uses.
  if (findLiveRegions('<body><div role="alert"></div></body>').length !== 1) {
    return bad('TEETH T3: role="alert" was not recognised as an implicit live region');
  }
  teeth++;

  // T4 GOOD (hostile-but-correct): `role="dialog"` and `role="application"` are NOT live regions.
  // A census matching any `role=` at all would count eleven shells plus the canvas.
  if (
    findLiveRegions('<div role="dialog"></div><canvas role="application"></canvas>').length !== 0
  ) {
    return bad('TEETH T4: a non-live role was counted as a live region (over-broad role matching)');
  }
  teeth++;

  // T5 BAD (the nesting monoculture-breaker): §5.2's only nesting fixture is "inside #app", so a
  // gate collapsing to that one id passes both its fixtures while the region hides inside a
  // display:none overlay and never announces.
  const hiddenHtml =
    '<body><div id="help-overlay" style="display:none"><div id="a11y-live" aria-live="polite"></div></div></body>';
  const hiddenRegion = findLiveRegions(hiddenHtml)[0];
  const hiddenChain = ancestorChain(hiddenHtml, hiddenRegion.index);
  if (!hiddenChain.some((a) => /display\s*:\s*none/.test(a.attrs))) {
    return bad(
      'TEETH T5: a live region nested inside a display:none ancestor was not detected — a check ' +
        'scoped to "#app" alone passes this while the region announces to nobody',
    );
  }
  teeth++;

  // T6 GOOD: the shipped shape — a direct <body> child with no hidden ancestor.
  const goodHtml = '<body><div id="app"></div><div id="a11y-live" aria-live="polite"></div></body>';
  const goodRegion = findLiveRegions(goodHtml)[0];
  const goodChain = ancestorChain(goodHtml, goodRegion.index);
  if (goodChain.length !== 1 || goodChain[0].tag !== 'body') {
    return bad(
      `TEETH T6: the ancestor walk misread a direct <body> child (chain=${goodChain.map((a) => a.tag).join('>')})`,
    );
  }
  teeth++;

  // T7 BAD: the ancestor walk must SEE the #app nesting §5.2 names, not just the display:none case.
  const nestedHtml =
    '<body><div id="app"><div id="a11y-live" aria-live="polite"></div></div></body>';
  const nestedRegion = findLiveRegions(nestedHtml)[0];
  if (!ancestorChain(nestedHtml, nestedRegion.index).some((a) => /id\s*=\s*"app"/.test(a.attrs))) {
    return bad('TEETH T7: a live region nested inside #app was not detected by the ancestor walk');
  }
  teeth++;

  // T8 BAD: ownership — an intruder module naming the node, in a spelling receiver-text matching
  // misses entirely.
  const intruders = findLiveRegionIntruders({
    'ui/liveRegion.ts': "export const LIVE_REGION_ID = 'a11y-live';",
    'main.ts': 'const b = document.body; b.replaceChildren();',
    'ui/rogue.ts': "document.getElementById('a11y-live').remove();",
  });
  if (intruders.length !== 1 || intruders[0] !== 'ui/rogue.ts') {
    return bad(
      `TEETH T8: the ownership scan reported [${intruders.join(', ')}] — it must flag exactly the ` +
        'module that NAMES the live region, and must not flag the declared owner',
    );
  }
  teeth++;

  // T9 GOOD (hostile-but-correct): a module whose COMMENT explains the ownership rule is not an
  // intruder. Kills a raw-text ownership scan, which would red on documentation.
  if (
    findLiveRegionIntruders({
      'ui/x.ts': "// only ui/liveRegion.ts may touch 'a11y-live'\nexport const a = 1;",
    }).length !== 0
  ) {
    return bad('TEETH T9: a comment naming the live region was treated as an ownership violation');
  }
  teeth++;

  // T10 BAD: the CSS stripper must not be the JS one. A URL in a declaration truncates the line
  // under a `//`-aware scanner and the ban silently disappears.
  const cssWithUrl = 'a{background:url(https://cdn/x.png);display:none}';
  if (stripCssComments(cssWithUrl).indexOf('display:none') === -1) {
    return bad(
      'TEETH T10: stripCssComments deleted a declaration following a `https://` URL — CSS has no ' +
        '`//` line comment, so reusing the JS/TS scanner here silently removes the banned text',
    );
  }
  if (stripCssComments('/* display:none */ .a{color:red}').indexOf('display:none') !== -1) {
    return bad('TEETH T10b: stripCssComments left a CSS block comment in place');
  }
  teeth++;

  // T10c TOTALITY (ADR-0215, RB12): every CSS_STRIPPER_CORPUS cell, no filter, no early exit —
  // either byte-equal on its pinned VALUE, or throws with its pinned NEEDLE. This is the
  // transition-total claim: the corpus names every (state, event) pair of the four-state lexer,
  // so passing here means covering the closed transition space, not sampling it. Runs against the
  // LIVE `stripCssComments` export, so this tooth is RED while that export is still the naive body
  // and GREEN once it is hardened in place.
  for (const cell of CSS_STRIPPER_CORPUS) {
    if (cell.expect.kind === 'value') {
      // A 'value' cell that THROWS must be reported as this tooth's clean failure, naming the
      // cell — never allowed to escape and reject the whole eval. Measured (rb-12 mutation loop,
      // M1/M2): a quote-blind stripper does not merely return the wrong bytes on
      // `dq/comment-open-inert`, it runs off the end of the input and throws `unterminated
      // comment`. An escaping throw still REDs CI, but it REDs it as an eval crash with no cell
      // name, which is indistinguishable from a harness bug and hides WHICH cell regressed.
      let out;
      try {
        out = stripCssComments(cell.css);
      } catch (e) {
        return bad(
          `TEETH T10c: cell "${cell.name}" THREW "${String(e && e.message ? e.message : e)}" but ` +
            `a value was expected — the stripper lost track of a string or comment boundary`,
        );
      }
      if (out !== cell.expect.out) {
        return bad(
          `TEETH T10c: cell "${cell.name}" produced ${JSON.stringify(out)}, expected ` +
            `${JSON.stringify(cell.expect.out)}`,
        );
      }
    } else {
      let threw = false;
      let message = '';
      try {
        stripCssComments(cell.css);
      } catch (e) {
        threw = true;
        message = String(e && e.message ? e.message : e);
      }
      if (!threw) {
        return bad(`TEETH T10c: cell "${cell.name}" was expected to throw and did not`);
      }
      if (message.indexOf(cell.expect.needle) === -1) {
        return bad(
          `TEETH T10c: cell "${cell.name}" threw "${message}", expected it to contain ` +
            `"${cell.expect.needle}"`,
        );
      }
    }
  }
  teeth++;

  // T10d COMPLETENESS (ADR-0215, RB12): the corpus's cell NAMES equal CSS_STRIPPER_CELLS in BOTH
  // directions, and the two collections are the SAME SIZE — a length floor alone would admit
  // duplicate padding (two cells sharing a name while a THIRD real transition is silently
  // missing). This tooth is independent of whether `stripCssComments` itself is fixed yet; it
  // guards the corpus data, not the implementation under test.
  {
    const corpusNames = CSS_STRIPPER_CORPUS.map((c) => c.name);
    const missingFromCorpus = CSS_STRIPPER_CELLS.filter((n) => corpusNames.indexOf(n) === -1);
    const extraInCorpus = corpusNames.filter((n) => CSS_STRIPPER_CELLS.indexOf(n) === -1);
    if (missingFromCorpus.length > 0) {
      return bad(
        `TEETH T10d: CSS_STRIPPER_CELLS names not present in the corpus: ${missingFromCorpus.join(', ')}`,
      );
    }
    if (extraInCorpus.length > 0) {
      return bad(
        `TEETH T10d: corpus names not present in CSS_STRIPPER_CELLS: ${extraInCorpus.join(', ')}`,
      );
    }
    if (CSS_STRIPPER_CORPUS.length !== CSS_STRIPPER_CELLS.length) {
      return bad(
        `TEETH T10d: corpus.length=${CSS_STRIPPER_CORPUS.length} !== ` +
          `CELLS.length=${CSS_STRIPPER_CELLS.length} — duplicate names can pass set equality ` +
          'while the corpus is short a real cell',
      );
    }
  }
  teeth++;

  // T10e DISCRIMINATION (ADR-0215, RB12): the naive stripper must get every NAIVE_KILLS cell
  // WRONG, and the headline cell's wrong output is pinned EXACTLY — "differs" alone would pass a
  // naive fixture hand-edited to differ trivially (e.g. a stray trailing space) while still
  // missing the real bug this slice exists to fix. Runs against `fixtureUnhardenedCssStripper`,
  // the FROZEN naive reference, so this tooth's verdict never depends on whether the LIVE
  // `stripCssComments` export has been hardened yet.
  {
    // MEMBERSHIP, not merely non-emptiness: a NAIVE_KILLS shrunk to a single entry passed the old
    // non-empty check while silently dropping three cells from this tooth — and T10e is the tooth
    // that runs ALONE in `just a11y-e2e`, where the vitest tier is not scheduled.
    const KILL_ROSTER = [
      'dq/comment-open-inert',
      'dq/backslash-escape',
      'EOF/in-comment',
      'EOF/in-string',
    ];
    const kills = [...NAIVE_KILLS].sort().join(',');
    if (kills !== [...KILL_ROSTER].sort().join(',')) {
      return bad(`TEETH T10e: NAIVE_KILLS drifted from its pinned roster — got "${kills}"`);
    }
    for (const name of NAIVE_KILLS) {
      const cell = CSS_STRIPPER_CORPUS.find((c) => c.name === name);
      if (cell === undefined) {
        return bad(`TEETH T10e: NAIVE_KILLS cell "${name}" is not in the corpus`);
      }
      if (cell.expect.kind === 'value') {
        const naiveOut = fixtureUnhardenedCssStripper(cell.css);
        if (naiveOut === cell.expect.out) {
          return bad(
            `TEETH T10e: the naive stripper agreed with the hardened oracle on kill-cell ` +
              `"${name}" — it no longer discriminates`,
          );
        }
      } else {
        let naiveThrew = false;
        try {
          fixtureUnhardenedCssStripper(cell.css);
        } catch (e) {
          naiveThrew = true;
        }
        if (naiveThrew) {
          return bad(
            `TEETH T10e: the naive stripper THREW on kill-cell "${name}" — the naive body has ` +
              'no error handling at all, so this cell no longer discriminates a throw/no-throw split',
          );
        }
      }
    }
    const HEADLINE_CELL = 'dq/comment-open-inert';
    const headline = CSS_STRIPPER_CORPUS.find((c) => c.name === HEADLINE_CELL);
    if (headline === undefined) {
      return bad(`TEETH T10e: headline cell "${HEADLINE_CELL}" is missing from the corpus`);
    }
    const headlineNaiveOut = fixtureUnhardenedCssStripper(headline.css);
    const headlinePinned = ['.a{content:', '"'].join('');
    if (headlineNaiveOut !== headlinePinned) {
      return bad(
        `TEETH T10e: the naive stripper's output on "${HEADLINE_CELL}" was ` +
          `${JSON.stringify(headlineNaiveOut)}, expected the EXACT pinned wrong output ` +
          `${JSON.stringify(headlinePinned)}`,
      );
    }
  }
  teeth++;

  // T11 BAD: an empty delegate must fail every pin (fail-loud, never fail-open).
  if (findInertDelegations(() => 'nothing here at all', SHELL_DELEGATIONS).length < 3) {
    return bad(
      'TEETH T11: findInertDelegations accepted a delegate containing none of its needles',
    );
  }
  teeth++;

  // T12 BAD: reachability — a narrowed test.include un-runs every delegate while the pins stay green.
  if (includeSelectsTests("test: { include: ['src/ui/**/*.test.ts'] }")) {
    return bad('TEETH T12: includeSelectsTests accepted a narrowed test.include');
  }
  teeth++;

  // T14 BAD: an implicit live region declared by TAG alone. `<output>` has role="status" with no
  // attribute whatsoever, so an attribute-keyed census is structurally blind to it.
  if (findLiveRegions('<body><output id="x"></output></body>').length !== 1) {
    return bad('TEETH T14: <output> was not counted — it carries the implicit ARIA role "status"');
  }
  teeth++;

  // T15 BAD: an UNQUOTED attribute value, which HTML permits.
  if (findLiveRegions('<body><div role=status></div></body>').length !== 1) {
    return bad('TEETH T15: `role=status` without quotes was not counted — HTML permits it');
  }
  teeth++;

  // T16 BAD: UPPERCASE attribute names, which HTML also permits.
  if (
    findLiveRegions('<body><div ARIA-LIVE="polite"></div><div ROLE="ALERT"></div></body>')
      .length !== 2
  ) {
    return bad(
      'TEETH T16: uppercase aria-live/role attributes were not counted — HTML attribute names ' +
        'are case-insensitive',
    );
  }
  teeth++;

  // T17 BAD (the clause module ownership does NOT subsume): a DIRECT body-level rebuild that never
  // names the live region. This is §5.2's original receiver target, restored.
  if (
    !findLiveRegionDestroyers({ 'main.ts': 'document.body.innerHTML = "";' }).some(
      (d) => d.indexOf('main.ts') === 0,
    )
  ) {
    return bad('TEETH T17: a direct `document.body.innerHTML` write was not flagged');
  }
  teeth++;

  // T17b BAD (a MEASURED survivor of the first draft): the SAME destruction through an ALIAS. The
  // original fixture mixed this with the direct form above, so it passed on the direct half while
  // the aliased half shipped green — fixture monoculture, caught by a mutation bite-proof.
  if (
    !findLiveRegionDestroyers({
      'ui/rogue.ts': 'const b = document.body;\nb.replaceChildren();',
    }).some((d) => d.indexOf('ui/rogue.ts') === 0)
  ) {
    return bad(
      'TEETH T17b: `const b = document.body; b.replaceChildren();` was not flagged — a ' +
        'direct-receiver scan is blind to the aliased form, and it never NAMES the live region ' +
        'so module ownership is blind to it too',
    );
  }
  teeth++;

  // T17c GOOD (hostile-but-correct): appending to the body is how three shipped modules mount, and
  // a DEFAULT PARAMETER aliasing the body then only appending is `errorOverlayView.ts:22`'s real
  // shape. Both must stay clean, or this clause is unusable and gets deleted rather than fixed.
  if (
    findLiveRegionDestroyers({
      'ui/sessionView.ts': 'document.body.appendChild(el);',
      'ui/errorOverlayView.ts':
        'constructor(mount: HTMLElement = document.body) {}\nmount.appendChild(root);',
    }).length !== 0
  ) {
    return bad(
      'TEETH T17c: a legitimate document.body.appendChild mount, or a default-parameter alias ' +
        'that only appends, was flagged as a destroyer',
    );
  }
  teeth++;

  // T18 BAD: reaching the node by ARIA SELECTOR from a non-owner — the last spelling needing no id.
  if (
    findLiveRegionDestroyers({
      'ui/rogue.ts': "document.querySelector('[aria-live]').textContent = 'x';",
    }).length !== 1
  ) {
    return bad('TEETH T18: a non-owner reaching the region via [aria-live] was not flagged');
  }
  teeth++;

  // T19 GOOD (hostile-but-correct): the OWNER may of course use an ARIA selector, and an ordinary
  // view calling replaceChildren on its own private field is not a destroyer.
  if (
    findLiveRegionDestroyers({
      'ui/liveRegion.ts': "document.querySelector('[aria-live]');",
      'ui/pvpView.ts': 'this.#incomingEl.replaceChildren();',
    }).length !== 0
  ) {
    return bad(
      'TEETH T19: the owner, or a view rebuilding its own child list, was flagged as a destroyer',
    );
  }
  teeth++;

  // T13 BAD (a LIVE trap, found by this eval reding the shipped markup): `client/index.html`
  // documents the live region with the prose "A direct <body> child on purpose" INSIDE AN HTML
  // COMMENT. A tag scanner that does not strip comments reads that as a second opened <body> and
  // reports the ancestor chain as `html > body > body`, false-REDing correct markup. The GOOD half
  // is that the shipped file passes once comments are stripped; the BAD half is here.
  const commentedBody =
    '<body><!-- a direct <body> child on purpose --><p aria-live="polite"></p></body>';
  const commentedChain = ancestorChain(
    stripHtmlComments(commentedBody),
    stripHtmlComments(commentedBody).indexOf('<p'),
  );
  if (commentedChain.length !== 1 || commentedChain[0].tag !== 'body') {
    return bad(
      'TEETH T13: a `<body>` mentioned inside an HTML COMMENT was counted as an opened element ' +
        `(chain=${commentedChain.map((a) => a.tag).join('>')}) — this false-REDs the shipped ` +
        'client/index.html, whose live-region comment contains exactly that prose',
    );
  }
  // ...and the comment-blind reading must genuinely differ, or T13 proves nothing.
  const blindChain = ancestorChain(commentedBody, commentedBody.indexOf('<p'));
  if (blindChain.length === commentedChain.length) {
    return bad(
      'TEETH T13b: stripping HTML comments made no difference to the ancestor walk — the fixture ' +
        'no longer reproduces the trap it was written for',
    );
  }
  teeth++;

  // ==================================================================
  // REAL TREE
  // ==================================================================
  let html;
  try {
    html = readFileSync(INDEX_HTML, 'utf8');
  } catch (e) {
    return bad(`could not read ${INDEX_HTML}: ${e.message}`);
  }

  // Comments are removed BEFORE any structural read — see stripHtmlComments for the measured
  // false-RED this prevents on the shipped markup.
  const doc = stripHtmlComments(html);

  const regions = findLiveRegions(doc);
  if (regions.length !== 1) {
    const via = regions.map((r) => `<${r.tag} ${r.via}>`).join(', ');
    return bad(
      `[A11Y-05a] ${INDEX_HTML} declares ${regions.length} live region(s) [${via}], expected ` +
        'exactly one — a second announcement channel interrupts the first mid-utterance (M23 §2.4)',
    );
  }

  const chain = ancestorChain(doc, regions[0].index);
  // The IMMEDIATE parent must be <body>; only <html> may sit above it. Expressed this way rather
  // than as `chain.length === 1` so the same predicate serves the bare-<body> fixtures and the real
  // document, which of course also has an <html> element.
  const parent = chain.length === 0 ? undefined : chain[chain.length - 1];
  const strays = chain.slice(0, -1).filter((a) => a.tag !== 'html');
  if (parent === undefined || parent.tag !== 'body' || strays.length > 0) {
    return bad(
      '[A11Y-05a] the live region is not a DIRECT <body> child (ancestors: ' +
        `${chain.map((a) => a.tag).join(' > ')}) — nesting it inside a view root lets an ` +
        'authoritative replaceChildren() rebuild destroy the announcement binding',
    );
  }
  const hiddenAncestor = chain.find((a) => /display\s*:\s*none/.test(a.attrs));
  if (hiddenAncestor !== undefined) {
    return bad(
      `[A11Y-05a] the live region sits inside a display:none <${hiddenAncestor.tag}> — it is ` +
        'removed from the accessibility tree entirely, so nothing written into it is announced',
    );
  }

  let sourceFiles;
  try {
    sourceFiles = listClientSourceFiles(CLIENT_SRC);
  } catch (e) {
    return bad(`[A11Y-05b] could not walk ${CLIENT_SRC}: ${e.message}`);
  }
  // ANTI-VACUITY FLOOR: a mistyped root walks nothing, finds no intruder, and passes forever.
  if (sourceFiles.length < 40) {
    return bad(
      `[A11Y-05b] VACUITY FLOOR: found only ${sourceFiles.length} non-test .ts files under ` +
        `${CLIENT_SRC}, expected at least 40 — a zero-intruder pass over a mistyped walk root is ` +
        'indistinguishable from a clean tree',
    );
  }
  if (!sourceFiles.includes(LIVE_REGION_OWNER)) {
    return bad(
      `[A11Y-05b] the declared owner ${LIVE_REGION_OWNER} is not among the walked files — the ` +
        'ownership rule is pinned to a module that no longer exists',
    );
  }

  const sources = {};
  for (const rel of sourceFiles) {
    try {
      sources[rel] = readFileSync(`${CLIENT_SRC}/${rel}`, 'utf8');
    } catch (e) {
      return bad(`[A11Y-05b] could not read ${CLIENT_SRC}/${rel}: ${e.message}`);
    }
  }
  // The owner must actually NAME the node, or "sole owner" is a claim about nothing.
  if (
    !LIVE_REGION_NAMES.some((n) => stripTsComments(sources[LIVE_REGION_OWNER]).indexOf(n) !== -1)
  ) {
    return bad(
      `[A11Y-05b] ${LIVE_REGION_OWNER} no longer names the live region — the sole-owner claim is ` +
        'vacuous if the owner does not own anything',
    );
  }
  const destroyers = findLiveRegionDestroyers(sources);
  if (destroyers.length > 0) {
    return bad(
      `[A11Y-05b] module(s) destroy or rewrite the live region without naming it: ${destroyers.join(', ')} ` +
        '— a body-level rebuild reaches a direct <body> child, and an ARIA selector reaches the ' +
        'node with no id at all; module ownership alone is blind to both',
    );
  }
  const found = findLiveRegionIntruders(sources);
  if (found.length > 0) {
    return bad(
      `[A11Y-05b] modules other than ${LIVE_REGION_OWNER} name the live region: ${found.join(', ')} ` +
        '— single-module ownership is what makes the node unreachable to a stray replaceChildren, ' +
        'an innerHTML write or a remove(), none of which can act without naming it first',
    );
  }

  const inertPins = findInertPins((f) => readFileSync(f, 'utf8'), SHELL_DELEGATIONS);
  if (inertPins.length > 0) {
    return bad(
      `[A11Y-06/07/08] DELEGATION PIN INERT: ${inertPins.join(' | ')} — deleting these needles ` +
        'from the real delegate does not make the pin fail, so the pin is theatre',
    );
  }
  const inert = findInertDelegations((f) => readFileSync(f, 'utf8'), SHELL_DELEGATIONS);
  if (inert.length > 0) {
    return bad(
      `[A11Y-06/07/08] delegation pin failures: ${inert.join(' | ')} — these criteria are gated by ` +
        'the shipped stronger oracles rather than re-implemented here (see the header)',
    );
  }

  let viteSrc;
  try {
    viteSrc = readFileSync(VITE_CONFIG, 'utf8');
  } catch (e) {
    return bad(`[A11Y-06/07/08] could not read ${VITE_CONFIG}: ${e.message}`);
  }
  if (!includeSelectsTests(viteSrc)) {
    return bad(
      `[A11Y-06/07/08] REACHABILITY: ${VITE_CONFIG}'s test.include no longer selects ` +
        "'src/**/*.test.ts', so every delegated oracle is un-run while all three pins stay green",
    );
  }

  // ==================================================================
  // [A11Y-CSSOWN2] rb-15 — this eval now OWNS the CSS oracle and executes it.
  //
  // Before this slice, `[A11Y-06]` and `[A11Y-07]` were gated in the nightly
  // `just a11y-e2e` tier (justfile:348) by a grep for `function findIdSelectors(`
  // and NOTHING ELSE: that recipe runs three evals plus eight named spec files,
  // and `indexShell.test.ts` is not one of them. Everything below is what makes
  // that tier actually run the check.
  // ==================================================================

  // --- CONTROL PROBES, BEFORE ANY REAL FILE IS READ ------------------
  // Every real-artefact assertion below is of the form "returns an empty list" or
  // "reports ok", each of which a `() => []` / `() => ({ok:true})` stub satisfies
  // perfectly. These four are what make those assertions mean anything at all.

  // T-CTRL1 BAD: the id scanner must FLAG a trivial id selector.
  const ctrlIdBad = findIdSelectors('#a{}');
  if (ctrlIdBad.length !== 1 || ctrlIdBad[0] !== '#a') {
    return bad(
      '[A11Y-07] CONTROL: findIdSelectors did not flag the trivial `#a{}` rule (got ' +
        `${JSON.stringify(ctrlIdBad)}) — a stub returning [] would green every real-file ` +
        'assertion below',
    );
  }
  teeth++;

  // T-CTRL2 GOOD: ...and must NOT flag a class selector, or it is a constant-true and the
  // real-file assertion is unreachable in the other direction.
  if (findIdSelectors('.a{}').length !== 0) {
    return bad('[A11Y-07] CONTROL: findIdSelectors flagged a plain class rule (constant-true)');
  }
  teeth++;

  // T-CTRL3 BAD: the sr-only oracle must REJECT display:none.
  if (srOnlyIsAccessible('.sr-only{display:none}').ok !== false) {
    return bad(
      '[A11Y-06] CONTROL: srOnlyIsAccessible ACCEPTED `.sr-only{display:none}` — it is a ' +
        'constant-pass and the real-file verdict below proves nothing',
    );
  }
  teeth++;

  // T-CTRL4 GOOD: ...and must ACCEPT the shipped shape, or it is a constant-fail.
  const ctrlShipped = srOnlyIsAccessible(SHIPPED_SR_ONLY_RULE);
  if (ctrlShipped.ok !== true) {
    return bad(
      '[A11Y-06] CONTROL: srOnlyIsAccessible REJECTED the shipped .sr-only shape (reasons ' +
        `${JSON.stringify(ctrlShipped.reasons)}) — a constant-fail oracle makes every BAD row ` +
        'below pass for the wrong reason',
    );
  }
  teeth++;

  // --- SHARED FIXTURE TABLES, executed IN FULL -----------------------
  // The SAME tables `client/src/indexShell.test.ts`'s RB15-G2 runs. One source, two tiers —
  // and this is the first time these fixtures run in the nightly a11y tier at all.

  // T-TAB1: exact row counts. Pinned as LITERALS here and independently re-declared in the
  // `.ts` (RB15-G3), so deleting a row cannot satisfy both tiers in one edit — bite-proof M14.
  if (ID_SELECTOR_FIXTURES.length !== 14 || SR_ONLY_FIXTURES.length !== 21) {
    return bad(
      `[A11Y-CSSOWN2] TABLE INTEGRITY: expected 14 id rows and 21 sr-only rows, found ` +
        `${ID_SELECTOR_FIXTURES.length} and ${SR_ONLY_FIXTURES.length} — a shrunken table is a ` +
        'silently narrowed oracle in BOTH tiers at once',
    );
  }
  teeth++;

  // T-TAB2: every row carries a NON-EMPTY `kills` and a recognised `kind`, and each half pins
  // the right shape of expectation. A row whose `kills` is blank is a row nobody can review;
  // a BAD row with an empty expectation asserts exactly what a GOOD row asserts and can never
  // bite; a typo'd `kind` routes the row past both branches unexecuted.
  const tableFaults = [];
  for (const row of ID_SELECTOR_FIXTURES) {
    if (typeof row.kills !== 'string' || row.kills.trim().length === 0) {
      tableFaults.push(`${row.name}: empty kills`);
    }
    if (row.kind !== 'bad' && row.kind !== 'good') tableFaults.push(`${row.name}: bad kind`);
    if (row.kind === 'bad' && row.offenders.length === 0) {
      tableFaults.push(`${row.name}: BAD row with an empty offender pin`);
    }
    if (row.kind === 'good' && row.offenders.length !== 0) {
      tableFaults.push(`${row.name}: GOOD row with a non-empty offender pin`);
    }
  }
  for (const row of SR_ONLY_FIXTURES) {
    if (typeof row.kills !== 'string' || row.kills.trim().length === 0) {
      tableFaults.push(`${row.name}: empty kills`);
    }
    if (row.kind !== 'bad' && row.kind !== 'good') tableFaults.push(`${row.name}: bad kind`);
    if (row.kind === 'bad' && row.reasons.length === 0) {
      tableFaults.push(`${row.name}: BAD row with an empty reason pin`);
    }
    if (row.kind === 'good' && row.reasons.length !== 0) {
      tableFaults.push(`${row.name}: GOOD row with a non-empty reason pin`);
    }
  }
  if (tableFaults.length > 0) {
    return bad(`[A11Y-CSSOWN2] TABLE INTEGRITY: ${tableFaults.join(' | ')}`);
  }
  teeth++;

  // T-ID-<name>, one tooth per row (14). EXACT offender array, order included — `includes`
  // would let a scanner reporting EVERY prelude pass all eight BAD rows.
  for (const row of ID_SELECTOR_FIXTURES) {
    let got;
    try {
      got = findIdSelectors(row.css);
    } catch (e) {
      return bad(`[A11Y-07] fixture "${row.name}" threw: ${e.message}. Kills: ${row.kills}`);
    }
    const want = [...row.offenders];
    if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
      return bad(
        `[A11Y-07] fixture "${row.name}" (${row.kind}) expected ${JSON.stringify(want)}, got ` +
          `${JSON.stringify(got)}. Kills: ${row.kills}`,
      );
    }
    teeth++;
  }

  // T-SR-<name>, one tooth per row (21). The EXACT reason SET, sorted — NEVER `.includes`.
  // MEASURED: a constant-fail oracle returning EVERY reason survives all fifteen BAD rows
  // under a membership test, and `MIN_SR_ONLY_DECLARATIONS = 0` survives every tooth, because
  // the floor only ever appears as an EXTRA reason a membership test cannot see.
  for (const row of SR_ONLY_FIXTURES) {
    let verdict;
    try {
      verdict = srOnlyIsAccessible(row.css);
    } catch (e) {
      return bad(`[A11Y-06] fixture "${row.name}" threw: ${e.message}. Kills: ${row.kills}`);
    }
    const got = [...verdict.reasons].sort();
    const want = [...row.reasons].sort();
    if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
      return bad(
        `[A11Y-06] fixture "${row.name}" (${row.kind}) expected reason set ` +
          `${JSON.stringify(want)}, got ${JSON.stringify(got)}. Kills: ${row.kills}`,
      );
    }
    if (verdict.ok !== (row.reasons.length === 0)) {
      return bad(
        `[A11Y-06] fixture "${row.name}" reported ok=${verdict.ok} while its reason set says ` +
          `otherwise — the verdict flag and the reason list disagree. Kills: ${row.kills}`,
      );
    }
    teeth++;
  }

  // --- THE REAL ARTEFACT ---------------------------------------------
  // EVERY oracle call on the real file is wrapped: `stripCssComments` throws at EOF on an
  // unterminated string or comment and `parseCssRules` throws on an unbalanced brace, BY
  // DESIGN. Unguarded, an unparseable stylesheet is an eval CRASH with no criterion name in
  // it — indistinguishable from a harness bug. This file's own T10c note already sets that
  // house rule; these clauses honour it.

  let cssText;
  try {
    cssText = readFileSync(STYLES_CSS, 'utf8');
  } catch (e) {
    return bad(`[A11Y-06/07] could not read ${STYLES_CSS}: ${e.message}`);
  }

  // T-REAL1: parse + the VACUITY FLOOR, expressed on the RULE COUNT.
  // MEASURED: a stylesheet gutted to its header comment passes `trim().length > 0` while
  // findIdSelectors, the cascade scan and the @import scan all go vacuously green — the file
  // is non-empty and contains no rules at all. A character-count floor cannot see that; a
  // rule count can. The shipped file carries three style rules (.sr-only, .hp-fill, and the
  // reduced-motion .hp-fill inside @media).
  let cssRules;
  try {
    cssRules = parseCssRules(cssText);
  } catch (e) {
    return bad(`[A11Y-06/07] ${STYLES_CSS} failed to parse: ${e.message}`);
  }
  if (cssRules.length < 3) {
    return bad(
      `[A11Y-06/07] VACUITY FLOOR: ${STYLES_CSS} parsed to ${cssRules.length} style rule(s), ` +
        'expected at least 3. A stylesheet gutted to its header comment is non-empty, parses ' +
        'clean, declares zero id selectors and has no .sr-only rule — every assertion below ' +
        'would pass on it',
    );
  }
  teeth++;

  // T-REAL2: zero `#id` selectors in the shipped stylesheet.
  let realOffenders;
  try {
    realOffenders = findIdSelectors(cssText);
  } catch (e) {
    return bad(`[A11Y-07] ${STYLES_CSS} failed to parse: ${e.message}`);
  }
  if (realOffenders.length > 0) {
    return bad(
      `[A11Y-07] ${STYLES_CSS} declares ${realOffenders.length} #id selector(s): ` +
        `${JSON.stringify(realOffenders)} — criterion A11Y-12. A rule reaching #help-overlay, ` +
        '#help-hint or #build-stamp silently satisfies or defeats the inline-style pins in ' +
        'indexShell.test.ts and main.wiring.test.ts, whose entire premise is that the inline ' +
        'style attribute is the COMPLETE styling contract',
    );
  }
  teeth++;

  // T-REAL3: the shipped `.sr-only` rule hides visually and stays in the accessibility tree.
  let realVerdict;
  try {
    realVerdict = srOnlyIsAccessible(cssText);
  } catch (e) {
    return bad(`[A11Y-06] ${STYLES_CSS} failed to parse: ${e.message}`);
  }
  if (realVerdict.ok !== true || realVerdict.reasons.length > 0) {
    return bad(
      `[A11Y-06] ${STYLES_CSS}'s .sr-only rule is rejected: ` +
        `${JSON.stringify(realVerdict.reasons)} — criterion A11Y-11. Either it removes ` +
        '#a11y-live from the accessibility tree (display:none / visibility:hidden / ' +
        'content-visibility:hidden / display:contents) or it fails to hide it at all (a clip ' +
        'with no position:absolute leaves the box painting in full)',
    );
  }
  teeth++;

  // T-REAL4: the declaration count, pinned against the LITERAL 9.
  // NOT against MIN_SR_ONLY_DECLARATIONS: comparing the verdict to the imported constant is a
  // TAUTOLOGY the moment both sides come from this module — lowering the constant moves both
  // sides together and the assertion stays green. The shipped rule declares exactly nine
  // (position, width, height, padding, margin, overflow, clip-path, white-space, border).
  if (realVerdict.declCount !== 9) {
    return bad(
      `[A11Y-06] ${STYLES_CSS}'s .sr-only rule unions to ${realVerdict.declCount} declarations, ` +
        'expected exactly 9. Fewer means declarations were dropped (an empty block satisfies ' +
        'both NEGATIVE clauses trivially); more means a second .sr-only rule joined the union ' +
        'and this pin is the only place that would notice',
    );
  }
  teeth++;

  // --- LIVENESS ON THE REAL ARTEFACT ---------------------------------
  // The two assertions above are "no offenders" and "no reasons", which a read of the WRONG
  // FILE — or of an empty string — satisfies just as well as a clean one. These two probes
  // mutate the real file's TEXT in memory and require the mutation to be FLAGGED.

  // T-LIVE1: the id probe is `@media`-NESTED, on purpose. A depth-0 probe is green under the
  // depth-0-only walk it exists to catch (MEASURED), so it would prove the read is live while
  // proving nothing about the walk. §2.7 puts prefers-contrast rules in this very file, so
  // the nested form is also the realistic one.
  //
  // THE PROBE ID IS DERIVED AT RUNTIME, and the probe is PREPENDED rather than appended.
  // MEASURED (red-team, rb-15 artifact pass): every shared fixture is two orders of magnitude
  // shorter than the real stylesheet (id<=56, sr<=230 chars vs 5467), so a `src.length > 400`
  // short-circuit survives all 35 rows; it was then killed only because the probes were fixed
  // LITERALS an implementation could answer by `indexOf('rb15-probe')` and `endsWith(...)`.
  // A runtime-derived id is not present in this file's source, and prepending defeats the
  // suffix test — so a size-keyed oracle now has to answer a long string honestly.
  const ID_PROBE = `#rb15-p${cssRules.length}x${cssText.length}`;
  let probedOffenders;
  try {
    probedOffenders = findIdSelectors(
      `@media (prefers-contrast: more){${ID_PROBE}{color:red}}\n${cssText}`,
    );
  } catch (e) {
    return bad(`[A11Y-07] LIVENESS: the id probe failed to parse: ${e.message}`);
  }
  if (probedOffenders.length !== 1 || probedOffenders[0] !== ID_PROBE) {
    return bad(
      `[A11Y-07] LIVENESS: a ${ID_PROBE} rule nested inside @media was NOT flagged (got ` +
        `${JSON.stringify(probedOffenders)}). Either the scan is not reading the text it was ` +
        'given, or it only walks brace depth 0 — in which case the clean verdict above is an ' +
        'artefact of the walk rather than of the stylesheet',
    );
  }
  teeth++;

  // T-LIVE2: the sr-only probe. Without it `srOnlyIsAccessible` has NO liveness probe on the
  // real artefact at all — measured gap. The expected reason SET is pinned exactly: appending
  // one banned declaration to a correct sheet must produce exactly ONE reason, and the reason
  // literal here is a SECOND, INDEPENDENT copy of the constant, so mutating the constant reds.
  let probedVerdict;
  try {
    // PREPENDED, for the same reason as T-LIVE1: an `endsWith('.sr-only{display:none}')`
    // short-circuit on a size-keyed oracle answered the appended form by constant. MEASURED.
    probedVerdict = srOnlyIsAccessible(`.sr-only{display:none}\n${cssText}`);
  } catch (e) {
    return bad(`[A11Y-06] LIVENESS: the sr-only probe failed to parse: ${e.message}`);
  }
  const probedReasons = [...probedVerdict.reasons];
  if (
    probedVerdict.ok !== false ||
    probedReasons.length !== 1 ||
    probedReasons[0] !== 'display:none REMOVES THE NODE FROM THE ACCESSIBILITY TREE'
  ) {
    return bad(
      '[A11Y-06] LIVENESS: prepending `.sr-only{display:none}` to the real stylesheet did NOT ' +
        `produce exactly the display reason (ok=${probedVerdict.ok}, reasons=` +
        `${JSON.stringify(probedReasons)}). Either the union across matching rules is not ` +
        'happening, or the deny-list no longer names display:none, or the verdict above was ' +
        'computed over something other than the text it was handed',
    );
  }
  teeth++;

  // --- T-OWN: THE REPO-WIDE SOLE-OWNER SCAN --------------------------

  // T-OWN-FIX1: the shape ban BITES, and does not bite on prose. Without these two fixtures a
  // detector that silently matches nothing certifies the whole tree as clean.
  const OWN_TWIN_FIXTURE = ['function findId', 'Selectors(src) { return []; }'].join('');
  const OWN_PROSE_FIXTURE = ['// the eval owns function findId', 'Selectors( — prose\n'].join('');
  if (rb15ShapeBanViolations(stripTsComments(OWN_TWIN_FIXTURE), RB15_OWNED_SYMBOLS).length !== 1) {
    return bad(
      '[A11Y-CSSOWN2] T-OWN CONTROL: the shape ban did not flag a re-pasted function ' +
        'declaration — the tree scan below would certify anything',
    );
  }
  if (rb15ShapeBanViolations(stripTsComments(OWN_PROSE_FIXTURE), RB15_OWNED_SYMBOLS).length !== 0) {
    return bad(
      '[A11Y-CSSOWN2] T-OWN CONTROL: the shape ban flagged a symbol NAMED IN A COMMENT. That ' +
        'reds this eval on its own documentation, gets "fixed" by deleting the explanation, ' +
        'and the next reader re-creates the twin',
    );
  }
  teeth++;

  // T-OWN-FIX2: the census BITES on the shape a definition-blacklist cannot see, and ACCEPTS
  // the honest member access. Red-team MEASURED object-method shorthand passing the shape ban,
  // all four delegation needles and the file walk.
  const OWN_SHORTHAND_FIXTURE = ['const o = { findId', 'Selectors(s) { return []; } };'].join('');
  const OWN_HONEST_FIXTURE = [RB15_OWNER_NS, '.findId', 'Selectors(css)'].join('');
  if (
    rb15CensusViolations(
      stripTsCommentsAndStrings(OWN_SHORTHAND_FIXTURE),
      RB15_OWNED_SYMBOLS,
      RB15_OWNER_NS,
    ).length !== 1
  ) {
    return bad(
      '[A11Y-CSSOWN2] T-OWN CONTROL: the occurrence census did not flag an object-method ' +
        'shorthand twin — the clause that exists specifically for the shapes the shape ban ' +
        'cannot see is inert',
    );
  }
  if (
    rb15CensusViolations(
      stripTsCommentsAndStrings(OWN_HONEST_FIXTURE),
      RB15_OWNED_SYMBOLS,
      RB15_OWNER_NS,
    ).length !== 0
  ) {
    return bad(
      '[A11Y-CSSOWN2] T-OWN CONTROL: the occurrence census flagged the HONEST member access. ' +
        'A census that rejects the only legal shape is a census nobody can satisfy, and it ' +
        'gets deleted rather than fixed',
    );
  }
  teeth++;

  // T-OWN-WALK: the walk itself, with its anti-vacuity controls asserted BEFORE any verdict
  // is drawn from it.
  let specFiles;
  try {
    specFiles = listClientSpecFiles(CLIENT_SRC);
  } catch (e) {
    return bad(`[A11Y-CSSOWN2] could not walk ${CLIENT_SRC} for the sole-owner scan: ${e.message}`);
  }
  if (specFiles.length < 40) {
    return bad(
      `[A11Y-CSSOWN2] VACUITY FLOOR: the sole-owner walk found only ${specFiles.length} files ` +
        `under ${CLIENT_SRC}, expected at least 40 — a zero-twin pass over a mistyped root is ` +
        'indistinguishable from a clean tree',
    );
  }
  if (specFiles.length <= sourceFiles.length) {
    return bad(
      `[A11Y-CSSOWN2] the sole-owner walk (${specFiles.length} files) is not STRICTLY larger ` +
        `than the non-test walk (${sourceFiles.length}) — it is therefore not including ` +
        '*.test.ts, which is the entire blind spot it exists to close (red-team C9 was a ' +
        'complete second oracle in a sibling .test.ts that every other clause passed)',
    );
  }
  if (!specFiles.includes(CSS_ORACLE_DELEGATE.slice(`${CLIENT_SRC}/`.length))) {
    return bad(
      `[A11Y-CSSOWN2] ${CSS_ORACLE_DELEGATE} is not among the walked files — the sole-owner ` +
        'scan is pinned to a tree that does not contain the one file it exists to police',
    );
  }
  teeth++;

  // Read every walked file once; both scans below share the text.
  const specSources = {};
  for (const rel of specFiles) {
    try {
      specSources[rel] = readFileSync(`${CLIENT_SRC}/${rel}`, 'utf8');
    } catch (e) {
      return bad(`[A11Y-CSSOWN2] could not read ${CLIENT_SRC}/${rel}: ${e.message}`);
    }
  }
  // ...and the delegate must actually REACH the owner, or "sole ownership" is satisfied by a
  // tree in which nobody calls the oracle at all.
  const delegateRel = CSS_ORACLE_DELEGATE.slice(`${CLIENT_SRC}/`.length);
  if (stripTsComments(specSources[delegateRel]).indexOf(`${RB15_OWNER_NS}.`) === -1) {
    return bad(
      `[A11Y-CSSOWN2] ${CSS_ORACLE_DELEGATE} no longer reaches the owner namespace at all — ` +
        'zero local copies is also what you get by deleting every call site, and that leaves ' +
        '[A11Y-06]/[A11Y-07] gated by nothing in the vitest tier',
    );
  }

  // T-OWN-TRIPWIRE: decide, PER FILE, whether the stripped text can be trusted at all.
  //
  // MEASURED (red-team, rb-15 artifact pass): a regex literal carrying a comment opener or a
  // quote — `/[/*]/`, `/from '([^']*)'/g` — makes `stripTsComments` blank to the next `*` + `/`
  // and `stripTsCommentsAndStrings` run to EOF in a string state, both WITH NO THROW. The two
  // scans below would then certify that file as clean for entirely the wrong reason.
  //
  // Reddening on any such literal is NOT an option: `client/src` already ships them in files
  // this slice does not own (and must not edit). So the tripwire selects the SCAN INPUT rather
  // than the verdict: a trustworthy file is scanned stripped, an untrustworthy one is scanned
  // RAW. Raw scanning can only ever report MORE violations (prose and string mentions count),
  // which is the safe direction — an untrusted file whose raw text never names a moved symbol
  // is genuinely clean, and one that does is reported for manual disambiguation rather than
  // waved through. `hazardous` is surfaced in the detail so the count cannot drift unnoticed.
  const hazardous = [];
  const scanText = {};
  for (const [rel, raw] of Object.entries(specSources)) {
    const stripped = stripTsComments(raw);
    if (rb15AssertNoHazardousRegex(stripped, rel) === '') {
      scanText[rel] = { shape: stripped, census: stripTsCommentsAndStrings(raw) };
    } else {
      hazardous.push(rel);
      scanText[rel] = { shape: raw, census: raw };
    }
  }
  // ANTI-VACUITY: if EVERY file were declared hazardous the scans would still run, but on raw
  // text, and the comment-decoy control below would no longer describe what happens in practice.
  if (hazardous.length > specFiles.length / 2) {
    return bad(
      `[A11Y-CSSOWN2] SCANNER DESYNC: ${hazardous.length} of ${specFiles.length} client/src ` +
        'files carry a regex literal that desynchronises the comment/string scanners. Past half ' +
        'the tree this gate is scanning raw text almost everywhere and its comment-stripping ' +
        `controls no longer describe it. Files: ${hazardous.slice(0, 5).join(', ')}`,
    );
  }
  teeth++;

  // T-OWN-SHAPE: no file in client/src DEFINES a moved symbol.
  const shapeTwins = [];
  for (const [rel, raw] of Object.entries(specSources)) {
    for (const v of rb15ShapeBanViolations(scanText[rel].shape, RB15_OWNED_SYMBOLS)) {
      shapeTwins.push(`${rel}: ${v}`);
    }
  }
  if (shapeTwins.length > 0) {
    return bad(
      `[A11Y-CSSOWN2] SECOND CSS ORACLE DEFINED in client/src: ${shapeTwins.join(' | ')} — ` +
        'this eval is the SOLE owner (R-m23-s10-X18, the ruling ADR-0215 already made for ' +
        'stripCssComments). Two implementations drift, and the drift is invisible: each tier ' +
        'keeps passing against its own idea of what a CSS rule is',
    );
  }
  teeth++;

  // T-OWN-CENSUS: and no file REACHES one by any route other than the owner namespace. This
  // is the clause that sees the five shapes the shape ban structurally cannot: object-method
  // shorthand, object-literal arrow property, class static method, getter, and a namespace
  // COPY made by Object.assign or a spread and then poisoned.
  const censusTwins = [];
  for (const [rel, raw] of Object.entries(specSources)) {
    for (const v of rb15CensusViolations(scanText[rel].census, RB15_OWNED_SYMBOLS, RB15_OWNER_NS)) {
      censusTwins.push(`${rel}: ${v}`);
    }
  }
  if (censusTwins.length > 0) {
    return bad(
      `[A11Y-CSSOWN2] CSS-oracle symbol reached outside the owner namespace: ` +
        `${censusTwins.join(' | ')} — none of these shapes is a \`function\` declaration, so ` +
        'the shape ban above is blind to every one of them, and all of them keep the retained ' +
        'delegation needles green',
    );
  }
  teeth++;

  // --- EXTENDED SUSPENSION CLAUSE ------------------------------------
  // T-SUSPEND: the retained delegation needles are LIVENESS THEATRE on their own. MEASURED
  // against real vitest: `it.skipIf(true)` and `it.runIf(false)` exit 0 with the tests reported
  // PENDING, and `it.each([])` registers NOTHING AT ALL — and every retained needle stays
  // green in all three cases, because they are text pins on a file, not on an execution.
  // `SUSPENSION_SPELLINGS` lives in `overlay-a11y-manifest.eval.mjs`, which is OUT OF SCOPE
  // for this slice; widening the shared list is recorded as a follow-up, and this LOCAL clause
  // covers the delegate this eval already owns a pin on.
  const SUSPENSION_NEEDLES = [
    ['.skip', 'If('].join(''),
    ['.run', 'If('].join(''),
    ['.each', '([])'].join(''),
    ['.for', '([])'].join(''),
  ];
  // Whitespace is collapsed so `.each([\n])` cannot escape by formatting alone.
  // EVERY delegate file, not just the CSS one: the [A11Y-08] entry (client/src/render/world.test.ts)
  // keeps all three of its needles green under `it.skipIf(true)` too.
  const suspended = [];
  for (const d of SHELL_DELEGATIONS) {
    let dsrc;
    try {
      dsrc = readFileSync(d.file, 'utf8');
    } catch (e) {
      return bad(`[A11Y-06/07/08] SUSPENSION SCAN: could not read ${d.file}: ${e.message}`);
    }
    const compact = stripTsComments(dsrc).replace(/\s+/g, '');
    for (const n of SUSPENSION_NEEDLES) {
      if (compact.indexOf(n) !== -1) suspended.push(`${d.file}: ${n}`);
    }
    // SHAPE-BASED, not the literal `.each([])`: MEASURED that one token of indirection
    // (`const M = []; it.each(M)(...)`) registers ZERO tests, exits 0, and keeps every retained
    // needle green. A `.each(`/`.for(` argument must be a NON-EMPTY array literal, spelled out.
    for (const table of ['.each(', '.for(']) {
      let at = compact.indexOf(table);
      while (at !== -1) {
        const arg = compact.charAt(at + table.length);
        if (arg !== '[' || compact.charAt(at + table.length + 1) === ']') {
          suspended.push(`${d.file}: ${table}<non-literal-or-empty>`);
        }
        at = compact.indexOf(table, at + 1);
      }
    }
    // A module mock substitutes the whole oracle with ZERO change to the import line.
    for (const n of ['vi.mock(', 'vi.doMock(']) {
      if (compact.indexOf(n) !== -1) suspended.push(`${d.file}: ${n}`);
    }
  }
  if (suspended.length > 0) {
    return bad(
      `[A11Y-06/07/08] SUSPENDED DELEGATE: ${suspended.join(' | ')} — ` +
        'a conditionally-skipped or empty-table test satisfies every code needle in ' +
        'SHELL_DELEGATIONS while executing nothing. Measured: exit 0, tests PENDING, and ' +
        '`each([])` registers no test at all',
    );
  }
  teeth++;

  // --- REGION PIN: RB12-G7 half 1, RE-CREATED HERE --------------------
  // `indexShell.test.ts:2905-2922` pinned that `parseCssRules` calls the imported stripper and
  // nothing else. That pin hard-FAILS after the move (its `headIdx` becomes -1) and must be
  // deleted — but the bypass it closes survives the move VERBATIM, one file over: a
  // differently-named local stripper plus a one-word repoint of `parseCssRules`' call site
  // kept ALL 25 tests green while `findIdSelectors` silently swallowed a whole `#id` rule
  // (rb-12 red-team, Finding 1, measured). Declaration, import and INVOCATION are three
  // different facts; this pins the third. Deleting it with no replacement is exactly the
  // RED->green weakening a verifier exists to catch.
  let selfSrc;
  try {
    selfSrc = readFileSync(new URL(import.meta.url), 'utf8');
  } catch (e) {
    return bad(`[A11Y-06/07] this eval could not read its own source: ${e.message}`);
  }
  const FN_HEAD = ['function ', 'parseCss', 'Rules('].join('');

  // T-REGION1: EXACTLY ONE definition, counted on the RAW source — never anchored on the
  // first hit. A second definition (or a decoy in a comment) makes the region below ambiguous,
  // and an indexOf-anchored pin is steerable by planting a decoy earlier in the file.
  const rawHeadCount = selfSrc.split(FN_HEAD).length - 1;
  if (rawHeadCount !== 1) {
    return bad(
      `[A11Y-06/07] REGION PIN: "${FN_HEAD}" occurs ${rawHeadCount} time(s) in this eval's own ` +
        'source, expected exactly 1. Zero means the oracle is gone; more than one means the ' +
        'region scanned below is ambiguous and a decoy can steer it',
    );
  }
  teeth++;

  // T-REGION2: delimit the body on the COMMENT-STRIPPED source and prove the region is real.
  // A region pin over a three-character slice proves nothing, and an over-stripped source
  // yields exactly that.
  const selfStripped = stripTsComments(selfSrc);
  const headIdx = selfStripped.indexOf(FN_HEAD);
  const bodyEnd = selfStripped.indexOf('\n}', headIdx);
  if (headIdx === -1 || bodyEnd <= headIdx || bodyEnd - headIdx < 200) {
    return bad(
      `[A11Y-06/07] REGION PIN: could not delimit a plausible ${FN_HEAD} body (headIdx=` +
        `${headIdx}, bodyEnd=${bodyEnd}). Either the function was renamed, or the comment ` +
        'strip desynchronised and the region below would be scanned over the wrong bytes',
    );
  }
  teeth++;

  // T-REGION3: inside that body, the sole-owned stripper is called EXACTLY ONCE. Comment
  // stripping is load-bearing here in the other direction: a decoy `// stripCssComments(src)`
  // left in the body would satisfy a raw-text count while the real call was repointed.
  const region = selfStripped.slice(headIdx, bodyEnd);
  // `(src)` INCLUDED, matching the RB12-G7 half 1 this re-creates: without the argument,
  // `stripCssComments(preNormalise(src))` keeps the count at 1 while the walker no longer sees
  // the raw text. Dropping it was a real weakening of the pin being replaced.
  const CALL_NEEDLE = ['stripCss', 'Comments(src)'].join('');
  const callCount = region.split(CALL_NEEDLE).length - 1;
  if (callCount !== 1) {
    return bad(
      `[A11Y-06/07] REGION PIN: ${FN_HEAD}'s body calls ${CALL_NEEDLE} ${callCount} time(s), ` +
        'expected exactly 1 — the rule walker has been repointed away from the sole-owned ' +
        'comment stripper. A differently-named local stripper plus a one-word repoint kept ' +
        'all 25 vitest tests green while a whole #id rule was swallowed (measured)',
    );
  }
  teeth++;

  // --- FAIL LOUD ON A DROPPED TOOTH ----------------------------------
  // Today this evenness check exists ONLY in `justfile:365`, which runs NIGHTLY. Without it
  // here, deleting a tooth is invisible to `just ci` — the tier that actually gates the PR.
  if (teeth !== teethTotal) {
    return bad(
      `[A11Y-CSSOWN2] TOOTH COUNT: ran ${teeth} of ${teethTotal} declared teeth. A tooth was ` +
        'deleted, short-circuited, or added without updating teethTotal. Every early return ' +
        'above is a named failure, so an uneven count here means a tooth stopped RUNNING ' +
        'rather than stopped passing',
    );
  }

  return {
    name,
    pass: true,
    detail:
      `[A11Y-05a] regions=${regions.length} directBodyChild=Y hiddenAncestor=N ` +
      `teeth=${teeth}/${teethTotal}; ` +
      `[A11Y-05b] owners=1 intruders=0 scanned=${sourceFiles.length}; ` +
      `[A11Y-06/07/08] pins=${SHELL_DELEGATIONS.length}/${SHELL_DELEGATIONS.length} ` +
      `nonInert=${shellNeedles}/${shellNeedles} reachable=Y; ` +
      `[A11Y-CSSOWN2] firstParty=Y rules=${cssRules.length} declCount=${realVerdict.declCount} ` +
      `liveness=2/2 soleOwner=1 twins=0 hazardousRegex=${hazardous.length} suspension=clean ` +
      `fixtures=${ID_SELECTOR_FIXTURES.length}+${SR_ONLY_FIXTURES.length} ` +
      `specFiles=${specFiles.length}`,
  };
}
