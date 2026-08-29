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
// `[A11Y-06]`, `[A11Y-07]` and `[A11Y-08]` are DELEGATED to the shipped oracles, which are
// strictly stronger, and the delegation is proven live by `findInertDelegations` (see the manifest
// eval's doc comment for its four failure conditions). Two measurements drove that call:
//
//   * `client/src/indexShell.test.ts` already implements the CSS oracle — `parseCssRules:1001`,
//     `findIdSelectors:1113`, `srOnlyIsAccessible:1408` — hardened over at-rule nesting,
//     `!important`, media-query unions and a `.sr-only-focusable` boundary, PLUS two halves §5.2
//     never asked for (`findCascadeReachingSelectors`, `importsAnotherStylesheet`). It is S2's file
//     and outside this slice's `touches:`, so a `.mjs` twin could not be kept in agreement by any
//     in-slice mechanism.
//   * The mechanism the S10 brief proposed for that — a shared fixture corpus both sides run — was
//     MEASURED not to work. A deliberately weak `.mjs` `srOnlyIsAccessible` agreed with the TS
//     oracle on 18 of 18 fixtures in that file's own corpus while shipping FOUR real regressions
//     green: grouped (`.a, .sr-only{display:none}`), compound (`div.sr-only{…}`), descendant
//     (`body .sr-only{…}`) and CSS-nested selectors. A corpus certifies agreement ON THE CORPUS and
//     nothing else. Pinning a source hash is defeated by a `biome` reformat plus a regenerate;
//     comparing normalised source text is defeated by a one-character string-literal edit.
//     Deleting the second implementation is the only mechanism with no bypass — there is nothing
//     left to drift.
//
// DECLARED RESIDUAL R-m23-s10-CSSDRIFT: the pins prove the oracle EXISTS, is INVOKED ON THE REAL
// ARTEFACT and is REACHABLE BY CI. They do not prove its semantics; those are gated by
// `indexShell.test.ts`'s own inline BAD/GOOD proofs at `:2003` (A6a) and `:2219` (A7a). The end
// state is one `evals/lib/a11yCssOracle.mjs` imported by BOTH tiers — deferred as X18 because it
// needs `indexShell.test.ts`.
//
// NO `main` GUARD (see the manifest eval). `run.mjs` imports the default export.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import {
  findInertDelegations,
  findInertPins,
  includeSelectsTests,
  stripTsComments,
} from './overlay-a11y-manifest.eval.mjs';

const INDEX_HTML = 'client/index.html';
const CLIENT_SRC = 'client/src';
const VITE_CONFIG = 'client/vite.config.ts';
const LIVE_REGION_OWNER = 'ui/liveRegion.ts';

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

/** Non-test `client/src/**\/*.ts` files, as paths RELATIVE to `client/src`. `.endsWith('.test.ts')`,
 *  never `.includes(...)`: `.includes` admits `foo.test.ts.bak` and a `x.test.ts/` directory, and a
 *  name-suffix exemption that admits disguised production code is a measured shape in this repo. */
export function listClientSourceFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = `${root}/${entry}`;
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      if (entry === 'module_bindings') continue; // generated
      out.push(...listClientSourceFiles(full, rel));
    } else if (
      // `.js`/`.mjs`/`.cjs`/`.tsx` as well as `.ts`: Vite bundles every one of them, so a rule
      // scoped to `.ts` alone is escaped by renaming a file (measured, red-team m23-s10).
      ['.ts', '.tsx', '.js', '.mjs', '.cjs'].some((ext) => entry.endsWith(ext)) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(rel);
    }
  }
  return out;
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
    codeNeedles: [
      'function srOnlyIsAccessible(',
      'srOnlyIsAccessible(readStylesCss())',
      'expect(verdict.ok',
    ],
  },
  {
    tag: '[A11Y-07]',
    criterion:
      'A11Y-12 — styles.css contains zero #id selectors (the inline-style pins stay total)',
    file: 'client/src/indexShell.test.ts',
    titleNeedles: [],
    codeNeedles: ['function findIdSelectors(', 'findIdSelectors(css)', 'expect(\n      offenders,'],
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
  const teethTotal = 24;
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

  return {
    name,
    pass: true,
    detail:
      `[A11Y-05a] regions=${regions.length} directBodyChild=Y hiddenAncestor=N ` +
      `teeth=${teeth}/${teethTotal}; ` +
      `[A11Y-05b] owners=1 intruders=0 scanned=${sourceFiles.length}; ` +
      `[A11Y-06/07/08] pins=${SHELL_DELEGATIONS.length}/${SHELL_DELEGATIONS.length} ` +
      `nonInert=${shellNeedles}/${shellNeedles} reachable=Y`,
  };
}
