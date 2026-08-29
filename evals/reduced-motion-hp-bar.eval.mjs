// Eval: reduced-motion HP-bar guard (M23 §2.5, residual R-m23-s2-X4, tag [A11Y-RM3]; slice rb-10).
//
// THE RULE. The battle HP bar's width animation must live in `client/src/styles.css`, on a
// `.hp-fill` class rule, with a `@media (prefers-reduced-motion: reduce)` block AFTER it that
// neutralises it. Not one character of animation may be written inline from
// `client/src/ui/battleView.ts`: an inline `style` declaration wins over every stylesheet rule at
// every specificity, so a media query cannot reach it — which is exactly what `styles.css`'s own
// header said when it declared the guard DELIBERATELY ABSENT.
//
// WHY THIS FILE EXISTS RATHER THAN A GREP. red-team transcribed the draft of this gate and ran 17
// biome-formatted stylesheets and 4 hostile `battleView.ts` variants against a REAL Chromium under
// both motion preferences. NINE were gate-GREEN, `just ci`-clean, and MEASURED animating under
// `prefers-reduced-motion: reduce`. Each clause below names the one it closes; the fixture teeth
// replay every one of them, so a future edit that hollows a clause reds HERE rather than shipping.
//
// TWO ORACLES, DELIBERATELY (the split is recorded in ADR-0213 and in the slice's ledger):
//   * SOURCE TEXT — this file. It owns the stylesheet's shape and the `battleView.ts` inline
//     ratchet, and it has no DOM.
//   * RUNTIME REACHABILITY — the `RM3-HP-FILL` describe in `client/src/ui/battleView.test.ts`.
//     `[A11Y-RM3/delegate]` pins that it still exists, still runs, and still carries the two
//     load-bearing needles. Without that pin, a gutted DOM tooth rides a green ledger.
//
// DECLARED RESIDUAL R-rb-10-CASCADE: nothing in `just ci` evaluates the real CSS cascade. Six of
// the nine measured bypasses are cascade-resolution facts no source-text oracle can see, so the
// airtight oracle is a REAL browser (`rb-10.cascade-probe.mjs`, beside the ledger). It is
// ledger-time, not CI-time, because `client/e2e/` is outside this slice's `touches:`.
//
// AUTHORING CONSTRAINTS THAT ARE NOT PREFERENCES (all measured in this repo):
//   * Literal regexes and `indexOf` only — NEVER `new RegExp(<variable>)`. Semgrep's
//     `detect-non-literal-regexp` is remote-only and would red CI after this file merges.
//   * No CSS-comment glyph pair may appear in a COMMENT in this file. Every such fixture is built
//     from the `SLASH_STAR` / `STAR_SLASH` constants below (the `indexShell.test.ts:909` idiom):
//     this repo has concatenating source scanners that a stray opener blanks a later function in.
//   * ON FAILURE, PRINT ONLY THE FAILING TAG. The ledger's CHECKs pipe through `tail`, so the
//     pipeline exit status is `tail`'s and the EXPECT regex is the SOLE adjudicator. A failure
//     message that happened to contain `inline=0` would false-GREEN the row. `bad()` enforces that
//     mechanically rather than by discipline.
//
// NO `main` GUARD. `evals/run.mjs` imports the default export; a module-scope `process.exit()`
// ends the whole run where it stands (measured: 37 of 90 evals ran, 3 FAILs swallowed, CI green).
import { readdirSync, readFileSync, statSync } from 'node:fs';

const CLIENT_SRC = 'client/src';
const STYLES_CSS = `${CLIENT_SRC}/styles.css`;
const BATTLE_VIEW = `${CLIENT_SRC}/ui/battleView.ts`;
const BATTLE_VIEW_TEST = `${CLIENT_SRC}/ui/battleView.test.ts`;
// Measured population at authoring time: 92 non-test modules under client/src. The floor is
// set well below that so ordinary growth or pruning cannot red it, but far above zero so a
// broken walk cannot satisfy the repo-wide ban vacuously.
const CLIENT_MODULE_FLOOR = 60;
const VITE_CONFIG = 'client/vite.config.ts';

/** The class that is the ONLY handle a stylesheet has on the fill element. */
const HP_CLASS = 'hp-fill';
/** The method that builds the fill element — the anti-vacuity anchor in `battleView.ts`. */
const RENDER_FN = '#renderMonsterCard';
/** The local binding the fill element is held in. Its `.style` must be written exactly once. */
const FILL_BINDING = 'hpFill';

/** Byte floors. A mistyped path, a truncated read or an emptied file must fail LOUD, never clean. */
const STYLES_MIN_BYTES = 800;
const VIEW_MIN_BYTES = 10000;

const TAG = '[A11Y-RM3]';
const T_VACUITY = '[A11Y-RM3/vacuity]';
const T_INLINE = '[A11Y-RM3/inline]';
const T_SET = '[A11Y-RM3/set]';
const T_BASE = '[A11Y-RM3/base]';
const T_GUARD = '[A11Y-RM3/guard]';
const T_ORDER = '[A11Y-RM3/order]';
const T_BODY = '[A11Y-RM3/body]';
const T_DELEGATE = '[A11Y-RM3/delegate]';

/** The two characters that OPEN a CSS comment, assembled (see the header). */
const SLASH_STAR = ['/', '*'].join('');
/** The two characters that CLOSE a CSS comment, assembled (see the header). */
const STAR_SLASH = ['*', '/'].join('');

// ===========================================================================================
// ORACLES. All local to this file on purpose: the mutation probe copies ONLY the files these
// oracles read into a tmpdir, so an eval-to-eval import would break the probe's isolation. The
// CSS comment stripper additionally MUST NOT be the one in `a11y-static-shell.eval.mjs` — S7 is
// a MEASURED bypass of it.
// ===========================================================================================

/**
 * Strip CSS block comments, QUOTE-AWARE, and REFUSE a string literal carrying comment delimiters.
 *
 * S7, MEASURED: `stripCssComments` in `a11y-static-shell.eval.mjs:83` is not quote-aware. A
 * stylesheet carrying `[data-hp-marker="<opener>"] {...} div.hp-fill { transition: width 0.3s; }
 * [data-hp-end="<closer>"] {...}` deletes that middle rule from the gate's view — the opener inside
 * the first attribute value opens a comment that the closer in the last one ends — while the braces
 * stay balanced, so a fail-loud brace walker never throws. The rule is invisible to the gate and
 * fully live in the browser.
 *
 * Refusing the delimiters inside a string (rather than merely surviving them) is deliberate: it is
 * the carrier, and banning it also closes the false-RED direction, where a legitimate future
 * `content:` string containing an opener would otherwise be reported as an unterminated comment.
 *
 * THROWS on an unterminated string or comment at EOF: a file we could not parse must never be
 * reported as a clean file.
 */
export function stripCssComments(src) {
  let out = '';
  let state = 'normal';
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (state === 'comment') {
      if (ch === STAR_SLASH.charAt(0) && next === STAR_SLASH.charAt(1)) {
        state = 'normal';
        i += 2;
        continue;
      }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }
    if (state === 'dq' || state === 'sq') {
      if (ch === '\\') {
        out += ch + next;
        i += 2;
        continue;
      }
      if (
        (ch === SLASH_STAR.charAt(0) && next === SLASH_STAR.charAt(1)) ||
        (ch === STAR_SLASH.charAt(0) && next === STAR_SLASH.charAt(1))
      ) {
        throw new Error(
          `CSS parse REFUSED at offset ${i}: a string literal carries CSS comment delimiters. ` +
            'That is the measured carrier for deleting a whole rule from a comment stripper that ' +
            'is not quote-aware, and it keeps the braces balanced so nothing else notices.',
        );
      }
      out += ch;
      if ((state === 'dq' && ch === '"') || (state === 'sq' && ch === "'")) state = 'normal';
      i += 1;
      continue;
    }
    if (ch === SLASH_STAR.charAt(0) && next === SLASH_STAR.charAt(1)) {
      state = 'comment';
      i += 2;
      continue;
    }
    // R4 (red-team, MEASURED post-ship): `url(` consumes a <url-token> RAW to its `)`, so a `/*`
    // inside an UNQUOTED url() is not a comment opener in CSS. A stripper without url state opens
    // a comment at `url(/*` and closes it at the next ordinary `*/`, deleting every rule in
    // between while leaving braces AND parens balanced, so nothing downstream throws. Measured to
    // hide a whole `div.hp-fill { transition: width 0.3s }` rule from this gate while staying
    // biome-clean and indexShell-clean. Policy is the same as for string literals: refuse the
    // carrier rather than try to out-parse it.
    if (
      ch === 'u' &&
      src.slice(i, i + 4).toLowerCase() === 'url(' &&
      !isIdentChar(i === 0 ? '' : src.charAt(i - 1))
    ) {
      let j = i + 4;
      while (j < src.length && (src.charAt(j) === ' ' || src.charAt(j) === '\t')) j += 1;
      const quoted = src.charAt(j) === '"' || src.charAt(j) === "'";
      if (!quoted) {
        const close = src.indexOf(')', i + 4);
        if (close === -1) {
          throw new Error(`CSS parse failed: unterminated url() at offset ${i}`);
        }
        const body = src.slice(i + 4, close);
        if (body.indexOf(SLASH_STAR) !== -1 || body.indexOf(STAR_SLASH) !== -1) {
          throw new Error(
            `CSS parse REFUSED at offset ${i}: an unquoted url() carries CSS comment delimiters. ` +
              'That is the measured carrier for deleting a whole rule from a stripper that has no ' +
              'url state, and it keeps braces and parens balanced so nothing else notices.',
          );
        }
        out += src.slice(i, close + 1);
        i = close + 1;
        continue;
      }
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

/**
 * The non-quote-aware stripper, reproduced FOR THE S7 FIXTURE ONLY.
 *
 * It exists so the S7 tooth can demonstrate that the carrier actually works — that the smuggled
 * rule genuinely disappears from a naive stripper's view — instead of merely asserting that ours
 * throws. A tooth that only checks its own implementation proves nothing about the attack.
 * NOT exported, and nothing above this line calls it.
 */
function fixtureNaiveStripCssComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.charAt(i) === SLASH_STAR.charAt(0) && src.charAt(i + 1) === SLASH_STAR.charAt(1)) {
      i += 2;
      while (
        i < src.length &&
        !(src.charAt(i) === STAR_SLASH.charAt(0) && src.charAt(i + 1) === STAR_SLASH.charAt(1))
      ) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += src.charAt(i);
    i += 1;
  }
  return out;
}

/**
 * Every STYLE rule in a stylesheet, at EVERY brace depth, as
 * `{ prelude, body, atStack, startIndex, endIndex }`.
 *
 * `atStack` is the FULL at-rule stack, outermost first — never "the outermost" and never "the
 * nearest". S8, MEASURED: a guard written as
 * `@media (prefers-reduced-motion: reduce){@media (min-width:99999px){ .hp-fill{transition:none} }}`
 * is GREEN against any gate that reads a single enclosing prelude, and is dead in every real
 * viewport. Only the stack's LENGTH can see it.
 *
 * `startIndex`/`endIndex` are the offsets of the rule's own braces in the COMMENT-STRIPPED source.
 * They exist for one clause: source ORDER. Media queries add no specificity, so a guard written
 * BEFORE the base rule loses to it — measured live at `dur=0.3s` with every other clause green.
 *
 * Paren-shielded (so `(prefers-reduced-motion: reduce)` and `url(...)` cannot open or close a
 * block), quote-aware, and backslash-aware (`.\#notanid` is a class, not an id). THROWS on an
 * unbalanced closing brace, an unterminated string, or a non-empty stack at EOF.
 */
export function parseCssStyleRules(css) {
  const clean = stripCssComments(css);
  const rules = [];
  const stack = [];
  let pending = '';
  let paren = 0;
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
    if (ch === '\\') {
      pending += ch + clean.charAt(i + 1);
      i += 1;
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
      stack.push({ kind: prelude.startsWith('@') ? 'at' : 'style', prelude, start: i });
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
          body: clean.slice(frame.start + 1, i),
          atStack: stack.filter((f) => f.kind === 'at').map((f) => f.prelude),
          startIndex: frame.start,
          endIndex: i,
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

/** CSS identifier continuation characters. Non-ASCII is an identifier character in CSS. */
function isIdentChar(ch) {
  if (ch === '') return false;
  if (ch >= 'a' && ch <= 'z') return true;
  if (ch >= 'A' && ch <= 'Z') return true;
  if (ch >= '0' && ch <= '9') return true;
  if (ch === '-' || ch === '_') return true;
  return ch.charCodeAt(0) > 127;
}

/**
 * Does a selector list target the CLASS TOKEN `cls` — not merely contain the substring?
 *
 * S3, MEASURED: `div.hp-fill`, `[class~="hp-fill"]`, `.hp-bar > .hp-fill` and a `@media screen`
 * copy were each appended AFTER the guard and each animated live under `reduce`. None is spelled
 * `.hp-fill`, so a `prelude === '.hp-fill'` comparison never sees them. The FALSE-RED direction is
 * equally load-bearing: `.hp-fill-x` and `.xhp-fill` are DIFFERENT classes and must not match, or
 * this predicate becomes unusable and the natural "fix" is to delete it.
 *
 * Two passes: the dotted-class token is looked for outside brackets and outside strings; attribute
 * selectors on `class` are then examined on their own, so `[class~="hp-fill"]` is seen while
 * `[data-x=".hp-fill"]` is not.
 */
export function selectorMatchesClass(prelude, cls) {
  const brackets = [];
  let masked = '';
  let depth = 0;
  let start = -1;
  let quote = null;
  for (let i = 0; i < prelude.length; i += 1) {
    const ch = prelude.charAt(i);
    if (quote !== null) {
      masked += ' ';
      if (ch === '\\') {
        masked += ' ';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      masked += ' ';
      continue;
    }
    if (ch === '[') {
      depth += 1;
      if (depth === 1) start = i;
      masked += ' ';
      continue;
    }
    if (ch === ']') {
      if (depth === 1 && start !== -1) {
        brackets.push(prelude.slice(start + 1, i));
        start = -1;
      }
      if (depth > 0) depth -= 1;
      masked += ' ';
      continue;
    }
    masked += depth > 0 ? ' ' : ch;
  }

  const dotted = `.${cls}`;
  let from = 0;
  for (;;) {
    const at = masked.indexOf(dotted, from);
    if (at === -1) break;
    const before = at === 0 ? '' : masked.charAt(at - 1);
    const after = masked.charAt(at + dotted.length);
    // `before` is only checked for a backslash: `div.hp-fill` and `.a.hp-fill` are both matches,
    // so an identifier character before the dot is normal. An ESCAPED dot is not a class sigil.
    if (before !== '\\' && !isIdentChar(after)) return true;
    from = at + 1;
  }

  for (const region of brackets) {
    const trimmed = region.trim();
    if (!trimmed.toLowerCase().startsWith('class')) continue;
    if (isIdentChar(trimmed.charAt('class'.length))) continue;
    let f = 0;
    for (;;) {
      const at = region.indexOf(cls, f);
      if (at === -1) break;
      const before = at === 0 ? '' : region.charAt(at - 1);
      const after = region.charAt(at + cls.length);
      if (!isIdentChar(before) && !isIdentChar(after)) return true;
      f = at + 1;
    }
  }
  return false;
}

/** The first `:` at paren depth zero and outside any string — so `content:"a:b"` splits once. */
function firstTopLevelColon(text) {
  let paren = 0;
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
    else if (ch === ')' && paren > 0) paren -= 1;
    else if (ch === ':' && paren === 0) return i;
  }
  return -1;
}

/**
 * A rule body's declarations, IN SOURCE ORDER, as `{ prop, value, important, custom }`.
 *
 * ORDER is load-bearing, not cosmetic: S6's inert guard body is
 * `transition:none; transition-property:width; transition-duration:0.3s` — every declaration is
 * individually innocent, and only their ORDER says the shorthand was undone afterwards.
 * `!important` is separated from the value in both directions: `none!important` must still read as
 * `none`, and a CORRECT `position:absolute!important` must not be rejected for carrying the word.
 * Custom properties keep their verbatim case; nothing else does.
 */
export function declarations(body) {
  const chunks = [];
  let pending = '';
  let paren = 0;
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

  const out = [];
  for (const chunk of chunks) {
    if (chunk.trim() === '') continue;
    const colon = firstTopLevelColon(chunk);
    if (colon === -1) continue;
    const rawProp = chunk.slice(0, colon).trim();
    if (rawProp === '') continue;
    let value = chunk.slice(colon + 1).trim();
    let important = false;
    const bang = value.lastIndexOf('!');
    if (
      bang !== -1 &&
      value
        .slice(bang + 1)
        .trim()
        .toLowerCase() === 'important'
    ) {
      important = true;
      value = value.slice(0, bang).trim();
    }
    const custom = rawProp.startsWith('--');
    out.push({
      prop: custom ? rawProp : rawProp.toLowerCase(),
      value: custom ? value : value.toLowerCase(),
      important,
      custom,
    });
  }
  return out;
}

const VENDOR_PREFIXES = Object.freeze(['-webkit-', '-moz-', '-ms-', '-o-']);

/** A property name with any vendor prefix removed — `-webkit-transition` is a transition. */
export function unprefix(prop) {
  for (const p of VENDOR_PREFIXES) {
    if (prop.startsWith(p)) return prop.slice(p.length);
  }
  return prop;
}

export function isTransitionProp(prop) {
  const base = unprefix(prop);
  return base === 'transition' || base.startsWith('transition-');
}

export function isAnimationProp(prop) {
  const base = unprefix(prop);
  return base === 'animation' || base.startsWith('animation-');
}

/** Any property that can move the element. Both families, both shorthand and longhand. */
export function isMotionProp(prop) {
  return isTransitionProp(prop) || isAnimationProp(prop);
}

/**
 * A media prelude lowercased, whitespace-collapsed, and freed of the spacing biome does NOT
 * normalise. Case matters: biome normalises prelude WHITESPACE but not CASE, so an UPPERCASE
 * prelude is a formatter-stable, Chromium-correct spelling that an exact-text pin false-REDs.
 */
export function normaliseMediaPrelude(prelude) {
  return prelude
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*([(),:])\s*/g, '$1');
}

/**
 * The EQUIVALENT-PRELUDE ALLOW-LIST. All three are Chromium-correct (measured at `dur=0s` under
 * `reduce`), and a gate that accepts only the first one false-REDs the other two — which is
 * precisely how the clause gets "fixed" into `includes('prefers-reduced-motion')`, and THAT form
 * accepts S9's perfect inversion below.
 */
export const GUARD_PRELUDES = Object.freeze([
  '@media (prefers-reduced-motion: reduce)',
  '@media (prefers-reduced-motion)',
  '@media not (prefers-reduced-motion: no-preference)',
]);
const NORMALISED_GUARDS = GUARD_PRELUDES.map(normaliseMediaPrelude);

/** Media TYPES that may appear as an extra branch: they can only ever WIDEN where the guard
 *  applies, and `transition:none` applied more widely is never an accessibility defect. `screen`
 *  and `all` are deliberately absent — as a branch they would make the guard unconditional. */
const NON_SCREEN_TYPES = Object.freeze(['print', 'speech']);

/** Split a media prelude on its TOP-LEVEL commas — media features can contain none, but a
 *  functional notation could, and a naive split there would silently mangle a valid query. */
function splitTopLevelCommas(text) {
  const parts = [];
  let pending = '';
  let paren = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '(') paren += 1;
    if (ch === ')' && paren > 0) paren -= 1;
    if (ch === ',' && paren === 0) {
      parts.push(pending.trim());
      pending = '';
      continue;
    }
    pending += ch;
  }
  parts.push(pending.trim());
  return parts.filter((p) => p !== '');
}

/**
 * Is this at-rule prelude a reduced-motion guard?
 *
 * S9, MEASURED, and the single most dangerous shape in the set: `(prefers-reduced-motion:
 * no-preference)` as a POSITIVE value is a PERFECT INVERSION — only the player who asked for
 * reduced motion gets the animation — and it satisfies every gate written as
 * `atContext.includes('prefers-reduced-motion')`. `not (...: no-preference)` is the OPPOSITE and
 * must be accepted. Exact normalised equality against the allow-list is what tells them apart.
 *
 * A comma list is accepted iff every branch is allow-listed or is a non-screen media type, AND at
 * least one branch is allow-listed (otherwise `@media print` alone would qualify as the guard).
 */
export function guardPreludeIsEquivalent(prelude) {
  const norm = normaliseMediaPrelude(prelude);
  if (!norm.startsWith('@media')) return false;
  const branches = splitTopLevelCommas(norm.slice('@media'.length).trim());
  if (branches.length === 0) return false;
  let allowed = 0;
  for (const branch of branches) {
    if (NORMALISED_GUARDS.indexOf(normaliseMediaPrelude(`@media ${branch}`)) !== -1) {
      allowed += 1;
      continue;
    }
    if (NON_SCREEN_TYPES.indexOf(branch) !== -1) continue;
    return false;
  }
  return allowed >= 1;
}

/** Strip JS/TS comments, leaving string CONTENTS untouched. A quote-aware character scanner, not
 *  a regex: a regex literal containing a quote drives a naive stripper into string state and
 *  swallows the next line of real code. */
export function stripTsComments(src) {
  return scanTs(src, false);
}

/** Strip comments AND every string/template BODY (delimiters survive). Code needles are matched
 *  against this, so a planted `const decoy = 'RM3-HP-FILL';` cannot satisfy an executable pin. */
export function stripTsCommentsAndStrings(src) {
  return scanTs(src, true);
}

function scanTs(src, dropStringBodies) {
  let out = '';
  let i = 0;
  let state = 'normal';
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (state === 'normal') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (ch === SLASH_STAR.charAt(0) && next === SLASH_STAR.charAt(1)) {
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
      if (ch === STAR_SLASH.charAt(0) && next === STAR_SLASH.charAt(1)) {
        state = 'normal';
        i += 2;
        continue;
      }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }
    const closer = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (ch === '\\') {
      if (!dropStringBodies) out += ch + next;
      i += 2;
      continue;
    }
    if (ch === closer) {
      out += ch;
      state = 'normal';
      i += 1;
      continue;
    }
    if (!dropStringBodies) out += ch;
    else if (ch === '\n') out += '\n';
    i += 1;
  }
  return out;
}

const SPACE_CHARS = Object.freeze([' ', '\n', '\t', '\r']);

/** The next non-whitespace character at or after `at`, with its index. */
function nextNonSpace(src, at) {
  let i = at;
  while (i < src.length && SPACE_CHARS.indexOf(src.charAt(i)) !== -1) {
    i += 1;
  }
  return { ch: src.charAt(i), index: i };
}

/** Every index of `needle` in `src`. Never `indexOf` once: a first-hit anchor is forgeable. */
function allIndexesOf(src, needle) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + 1;
  }
}

/** Property-assignment receivers that write an animation onto an element's inline style. */
const INLINE_ASSIGN_TARGETS = Object.freeze([
  '.transition',
  '.transitionProperty',
  '.transitionDuration',
  '.transitionTimingFunction',
  '.transitionDelay',
  '.webkitTransition',
  '.animation',
  '.animationName',
  '.animationDuration',
  '.webkitAnimation',
]);

/**
 * Every INLINE animation declaration in a TypeScript source, as `{ tag, index }`.
 *
 * Runs on the COMMENT-STRIPPED, STRINGS-INTACT source. Both halves are measured requirements:
 *  * comments must go, or the shipped post-fix `battleView.ts` comment — which names the animation
 *    in prose because it explains where it MOVED to — false-REDs the correct file;
 *  * string bodies must stay, because the declaration this eval exists to ban lives inside a
 *    `cssText` template literal and nowhere else.
 *
 * The WAAPI family is banned by TEXT (S4): `hpFill.animate([{width:…}],300)` ignores
 * `prefers-reduced-motion` entirely, is not stopped by `transition:none !important`, is invisible
 * to a transition/animation text ratchet — and happy-dom does not implement `Element.animate`, so
 * the DOM tooth cannot see it either. `cssText +=` is banned for the second-render class (S5): the
 * first render is byte-clean and a transition can only ever fire on a LATER render.
 */
export function findInlineAnimationDecls(tsSrc) {
  const stripped = stripTsComments(tsSrc);
  const lower = stripped.toLowerCase();
  const hits = [];

  for (const needle of ['transition:', 'transition-', 'animation:', 'animation-']) {
    for (const at of allIndexesOf(lower, needle)) {
      hits.push({ tag: `css-decl ${needle}`, index: at });
    }
  }
  for (const target of INLINE_ASSIGN_TARGETS) {
    for (const at of allIndexesOf(stripped, target)) {
      const after = nextNonSpace(stripped, at + target.length);
      if (after.ch !== '=') continue;
      if (stripped.charAt(after.index + 1) === '=') continue;
      hits.push({ tag: `assign ${target}`, index: at });
    }
  }
  for (const at of allIndexesOf(stripped, 'setProperty(')) {
    const near = lower.slice(at, at + 60);
    if (near.indexOf('transition') !== -1 || near.indexOf('animation') !== -1) {
      hits.push({ tag: 'setProperty', index: at });
    }
  }
  for (const needle of ['.animate(', 'new Animation(', 'KeyframeEffect']) {
    for (const at of allIndexesOf(stripped, needle)) {
      hits.push({ tag: `waapi ${needle}`, index: at });
    }
  }
  for (const at of allIndexesOf(stripped, '.cssText')) {
    const after = nextNonSpace(stripped, at + '.cssText'.length);
    if (after.ch === '+') hits.push({ tag: 'cssText append', index: at });
  }
  return hits;
}

/** Every `<FILL_BINDING>.style` write site, with the 40 characters that follow it. */
export function fillStyleWriteSites(tsSrc) {
  const stripped = stripTsComments(tsSrc);
  const needle = `${FILL_BINDING}.style`;
  return allIndexesOf(stripped, needle).map((at) => ({
    index: at,
    rest: stripped.slice(at + needle.length, at + needle.length + 40),
  }));
}

/** Is the single write site a total `cssText =` assignment (never `+=`, never a longhand)? */
export function fillStyleWriteIsTotalAssign(sites) {
  if (sites.length !== 1) return false;
  const rest = sites[0].rest;
  if (!rest.startsWith('.cssText')) return false;
  const after = rest.slice('.cssText'.length).trimStart();
  return after.startsWith('=') && !after.startsWith('==');
}

// ===========================================================================================
// DELEGATION — the RUNTIME half of the criterion lives in a vitest spec, and this pins that it
// still exists, still runs, and still asserts on the two load-bearing values.
// ===========================================================================================

/** Spellings that keep `vitest run` GREEN while the delegate stops asserting anything. `.only` is
 *  already gated by `vite.config.ts`'s `allowOnly: false`; these are not. */
const SUSPENSION_SPELLINGS = Object.freeze([
  'it.skip(',
  'test.skip(',
  'describe.skip(',
  'it.todo(',
  'test.todo(',
  'describe.todo(',
  'xit(',
  'xdescribe(',
  // R5 (red-team, MEASURED post-ship): the conditional forms suspend just as completely, and
  // `it.skipIf(TRUE_CONST)(...)` reads as an ordinary environment guard. Measured: the delegate
  // reported `50 passed | 1 skipped` with the PRE-FIX defect restored, and this clause stayed
  // green because it did not know the spelling.
  'it.skipIf(',
  'test.skipIf(',
  'describe.skipIf(',
  'it.runIf(',
  'test.runIf(',
  'describe.runIf(',
]);

/**
 * Which suspension spellings a (comment-stripped) delegate contains, as whole tokens.
 *
 * The identifier-boundary check is not pedantry: `exit(` CONTAINS `xit(`, and `unit.skip(`
 * contains `it.skip(`. A substring scan would false-RED a delegate for a call with an unrelated
 * name, and a false RED on a clause like this one is repaired by deleting the clause.
 */
export function findSuspensions(stripped) {
  const found = [];
  for (const spelling of SUSPENSION_SPELLINGS) {
    for (const at of allIndexesOf(stripped, spelling)) {
      const before = at === 0 ? '' : stripped.charAt(at - 1);
      if (isIdentChar(before) || before === '$' || before === '.') continue;
      found.push(spelling);
      break;
    }
  }
  return found;
}

export const RM3_DELEGATIONS = Object.freeze([
  {
    tag: T_DELEGATE,
    criterion:
      'R-m23-s2-X4 — the RENDERED fill carries the class and no inline animation, across TWO renders',
    file: BATTLE_VIEW_TEST,
    // Checked against the COMMENT-stripped (strings intact) delegate: these live in string
    // literals — a test title and an argument.
    titleNeedles: ['RM3-HP-FILL', "getAttribute('style')"],
    // Checked against the COMMENT-AND-STRING-stripped delegate, so a planted decoy string
    // literal cannot satisfy them. `fill.className` is the class oracle; `fill.getAttribute(`
    // is the PRIMARY inline-style oracle (measured to bite in happy-dom).
    codeNeedles: ['fill.className', 'fill.getAttribute('],
  },
]);

/** Delegates that are gone, gutted, suspended, or missing a needle. */
export function findInertDelegations(readFile, delegations) {
  const failures = [];
  for (const d of delegations) {
    let raw;
    try {
      raw = readFile(d.file);
    } catch (e) {
      failures.push(`${d.tag} UNREADABLE ${d.file}: ${e.message}`);
      continue;
    }
    if (typeof raw !== 'string') {
      failures.push(`${d.tag} UNREADABLE ${d.file}: not a string`);
      continue;
    }
    const stripped = stripTsComments(raw);
    if (stripped.indexOf('describe(') === -1) {
      failures.push(`${d.tag} EMPTY ${d.file}: no describe() survives comment-stripping`);
      continue;
    }
    for (const spelling of findSuspensions(stripped)) {
      failures.push(`${d.tag} SUSPENDED ${d.file}: contains '${spelling}'`);
    }
    for (const needle of d.titleNeedles) {
      if (stripped.indexOf(needle) === -1) {
        failures.push(`${d.tag} TITLE-ABSENT ${d.file}: '${needle}'`);
      }
    }
    const codeOnly = stripTsCommentsAndStrings(raw);
    for (const needle of d.codeNeedles) {
      if (codeOnly.indexOf(needle) === -1) {
        failures.push(`${d.tag} CODE-ABSENT ${d.file}: '${needle}' is not in executable source`);
      }
    }
  }
  return failures;
}

/** Pins that do NOT bite — deleting the needle from the real delegate still passes. */
export function findInertPins(readFile, delegations) {
  const inert = [];
  for (const d of delegations) {
    let raw;
    try {
      raw = readFile(d.file);
    } catch {
      continue;
    }
    for (const needle of [...d.titleNeedles, ...d.codeNeedles]) {
      const mutated = raw.split(needle).join('');
      if (findInertDelegations(() => mutated, [d]).length === 0) {
        inert.push(`${d.tag} INERT ${d.file}: deleting '${needle}' does not fail the pin`);
      }
    }
  }
  return inert;
}

/** Does `vite.config.ts` still select the delegate spec for execution? Scoped to `test.include`,
 *  and rejects a `test.exclude` naming a `.test.ts` path — narrowing the include is not the only
 *  way to un-run a delegate. `coverage.exclude` sits after `coverage: {` and is not a test scope. */
export function includeSelectsTests(configSrc) {
  const stripped = stripTsComments(configSrc);
  const testBlock = stripped.indexOf('test: {');
  if (testBlock === -1) return false;
  const open = stripped.indexOf('include: [', testBlock);
  if (open === -1) return false;
  const start = open + 'include: ['.length;
  const end = stripped.indexOf(']', start);
  const slice = end === -1 ? stripped.slice(start) : stripped.slice(start, end);
  if (slice.indexOf('src/**/*.test.ts') === -1) return false;

  const excludeOpen = stripped.indexOf('exclude: [', testBlock);
  if (excludeOpen !== -1) {
    const exStart = excludeOpen + 'exclude: ['.length;
    const exEnd = stripped.indexOf(']', exStart);
    const exSlice = exEnd === -1 ? stripped.slice(exStart) : stripped.slice(exStart, exEnd);
    const coverageBlock = stripped.indexOf('coverage: {', testBlock);
    const excludeIsTestScoped = coverageBlock === -1 || excludeOpen < coverageBlock;
    if (excludeIsTestScoped && exSlice.indexOf('.test.ts') !== -1) return false;
  }
  return true;
}

// ===========================================================================================
// THE CLAUSES. Both evaluators are pure functions of a source string, so the SAME code runs
// against the fixtures and against the real tree — a fixture cannot pass through a different
// path from the one the shipped file takes.
// ===========================================================================================

function verdict(tag, code, message) {
  return { ok: false, tag, code, message: `${tag} ${code}: ${message}` };
}

/**
 * C2/C3/C4/C5/C6 over a stylesheet. Returns `{ ok: true, ... }` or a tagged verdict.
 *
 * CLAUSE ORDER NOTE (a deliberate deviation from the gate design's numbering, recorded because it
 * is a real decision): C3/C4 run BEFORE C2's total count. The clauses are identical either way,
 * but with C2 first, "the base rule was deleted" and "the guard block was deleted" both report
 * `set`, and the acceptance ledger's proof-of-teeth requires one DISTINGUISHABLE tag per mutant.
 * Each failure additionally carries a stable UPPERCASE reason code for that pinning.
 *
 * THROWS (never returns) on a stylesheet it could not parse — a parse ambiguity is a FAIL.
 */
/**
 * Is a motion rule's selector ADMISSIBLE in this stylesheet?
 *
 * R3 (red-team, MEASURED post-ship) killed the previous fail-OPEN shape. `selectorMatchesClass`
 * asks "does this selector name the class token?", and a predicate that must return `false` for
 * every selector that could reach an element is not implementable. Five carriers were measured
 * CI-green, biome-clean, indexShell-clean, and animating in Chromium under `reduce`:
 *   `[class^="hp-"]`  ·  `[class*="hp-fil"]`  ·  `[class~="HP-FILL" i]`  ·  `.hp\-fill` (a CSS
 *   escape of the hyphen)  ·  `[style*="height:100%"]` (the fill's INLINE style is a stable handle
 *   — `height:100%` is a literal in battleView.ts).
 * Reviewer M1 added a sixth from the other direction: `div.hp-fill` as the BASE rule is
 * specificity (0,1,1) against the guard's (0,1,0), so it wins regardless of source order.
 *
 * So the policy is inverted to fail-CLOSED: a rule that declares motion is admissible only if it
 * is EXACTLY `.hp-fill`, or if it is a plain selector that provably cannot be an alias for one —
 * no attribute selector, no universal selector, no escape, and not naming the class token. An
 * unrelated future rule (`.tooltip { transition: opacity 0.2s }`) is still accepted, so this is
 * not a blanket ban on motion in this stylesheet.
 */
export function motionPreludeIsAdmissible(prelude) {
  const p = prelude.toLowerCase().replace(/\s+/g, ' ').trim();
  if (p === `.${HP_CLASS}`) return true;
  if (p.indexOf('[') !== -1) return false;
  if (p.indexOf('*') !== -1) return false;
  if (p.indexOf('\\') !== -1) return false;
  if (selectorMatchesClass(prelude, HP_CLASS)) return false;
  return true;
}

/**
 * Every non-test module Vite bundles out of `client/src`.
 *
 * `.js`/`.mjs`/`.cjs`/`.tsx` as well as `.ts`: a rule scoped to `.ts` alone is escaped by renaming
 * the file. `module_bindings` is generated. `*.test.ts` is excluded because a test file naming a
 * spelling in a fixture is not a production animation.
 */
export function listClientModules(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = `${root}/${entry}`;
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      if (entry === 'module_bindings') continue;
      out.push(...listClientModules(full, rel));
      continue;
    }
    if (
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

export function evaluateStylesheet(css) {
  const rules = parseCssStyleRules(css);

  // ---- C2a: FAIL-CLOSED selector policy (R3 + reviewer M1) --------------------------------
  // Checked FIRST, over EVERY motion rule in the file rather than only the class-token matches,
  // because every carrier below is invisible to a token matcher by construction.
  const anyMotion = rules.filter((r) => declarations(r.body).some((d) => isMotionProp(d.prop)));
  const inadmissible = anyMotion.filter((r) => !motionPreludeIsAdmissible(r.prelude));
  if (inadmissible.length > 0) {
    return verdict(
      T_SET,
      'SELECTOR',
      `${inadmissible.length} rule(s) declare a transition/animation behind a selector that can ` +
        `reach the .${HP_CLASS} element without being spelled \`.${HP_CLASS}\` ` +
        `(${inadmissible.map((r) => r.prelude).join(' | ')}). MEASURED carriers, each CI-green ` +
        'and each animating live in Chromium under `reduce`: an attribute prefix/substring match ' +
        'on `class`, the ASCII-case-insensitive `i` flag, a CSS escape of the hyphen, a match on ' +
        "the fill's INLINE `style` attribute, and `div.hp-fill` as the base rule — which at " +
        "specificity (0,1,1) beats the guard's (0,1,0) no matter what order they are written in",
    );
  }

  const motion = rules.filter(
    (r) =>
      selectorMatchesClass(r.prelude, HP_CLASS) &&
      declarations(r.body).some((d) => isMotionProp(d.prop)),
  );

  // ---- C3: the base rule -----------------------------------------------------------------
  const tops = motion.filter((r) => r.atStack.length === 0);
  if (tops.length === 0) {
    return verdict(
      T_BASE,
      'MISSING',
      `no TOP-LEVEL rule matching the .${HP_CLASS} class token declares a transition. The ` +
        'animation cannot live inline (an inline declaration beats every stylesheet rule at ' +
        'every specificity, which is why the guard was impossible before this slice), an empty ' +
        `.${HP_CLASS}{} rule is the failure styles.css's own header warned a later grep would ` +
        'mistake for the guard having landed, and a base rule nested under an at-rule is not the ' +
        'unconditional animation the guard is written against',
    );
  }
  if (tops.length > 1) {
    return verdict(
      T_BASE,
      'DUPLICATE',
      `${tops.length} top-level rules matching the .${HP_CLASS} class token declare a ` +
        `transition (${tops.map((r) => r.prelude).join(' | ')}). Taking the first would be a ` +
        'forgeable anchor: a SECOND base rule written after the guard wins the cascade at equal ' +
        'specificity and animates live under `reduce`',
    );
  }
  const base = tops[0];
  const baseDecls = declarations(base.body);
  if (!baseDecls.some((d) => d.prop === 'transition')) {
    return verdict(
      T_BASE,
      'NO-TRANSITION',
      `the base rule '${base.prelude}' declares no \`transition\` shorthand. The guard is ` +
        'written as `transition: none`, which resets the shorthand; a base built from longhands ' +
        'alone leaves the reader unable to tell what the guard is neutralising',
    );
  }
  const baseImportant = baseDecls.filter((d) => d.important);
  if (baseImportant.length > 0) {
    return verdict(
      T_BASE,
      'IMPORTANT',
      `the base rule '${base.prelude}' carries !important on ` +
        `${baseImportant.map((d) => d.prop).join(', ')}. MEASURED: an !important base beats the ` +
        'media-query guard, animates live under `reduce`, and `biome check` reports ' +
        '`noImportantStyles` as a WARNING and exits 0 — so CI will not catch it for you',
    );
  }

  // ---- C4: the guard rule ----------------------------------------------------------------
  const deep = motion.filter((r) => r.atStack.length >= 2);
  if (deep.length > 0) {
    return verdict(
      T_GUARD,
      'DEPTH',
      `a .${HP_CLASS} motion rule sits ${deep[0].atStack.length} at-rule levels deep ` +
        `(${deep[0].atStack.join(' > ')}). MEASURED: nesting a second @media inside the ` +
        'reduced-motion block is GREEN against any gate that reads one enclosing prelude, and is ' +
        'dead in every real viewport. The guard must be EXACTLY one media level deep',
    );
  }
  const level1 = motion.filter((r) => r.atStack.length === 1);
  if (level1.length === 0) {
    return verdict(
      T_GUARD,
      'MISSING',
      `no .${HP_CLASS} motion rule sits inside an at-rule. NOTE (R7, red-team): this parser does ` +
        'not model CSS NESTING, so a guard written as a nested `@media` INSIDE the base rule ' +
        'reads as absent here even though Chromium honours it. That spelling is correct CSS and ' +
        'the right repair is to un-nest it (or to teach parseCssStyleRules nesting), NEVER to ' +
        'loosen this clause. Otherwise the base animation is ' +
        'unconditional: a player who asked their operating system for reduced motion still gets ' +
        'the HP bar sliding on every hit',
    );
  }
  const guards = level1.filter((r) => guardPreludeIsEquivalent(r.atStack[0]));
  if (guards.length === 0) {
    return verdict(
      T_GUARD,
      'PRELUDE',
      `the enclosing at-rule '${level1[0].atStack[0]}' is not an equivalent reduced-motion ` +
        `guard. Accepted (lowercased, whitespace-collapsed): ${GUARD_PRELUDES.join(' | ')}, ` +
        'optionally with extra non-screen media branches. `(prefers-reduced-motion: ' +
        'no-preference)` as a POSITIVE value is refused on purpose — it is a perfect inversion, ' +
        'giving the animation to exactly the player who asked not to have it',
    );
  }
  if (guards.length > 1) {
    return verdict(
      T_GUARD,
      'DUPLICATE',
      `${guards.length} reduced-motion guard rules match the .${HP_CLASS} class token. Which one ` +
        'wins is a cascade question no source-text oracle can answer, so two is a refusal',
    );
  }
  const guard = guards[0];

  // ---- C2: the exact SET ------------------------------------------------------------------
  if (motion.length !== 2) {
    return verdict(
      T_SET,
      'COUNT',
      `${motion.length} rules match the .${HP_CLASS} class token AND declare a transition/` +
        `animation property (${motion.map((r) => r.prelude).join(' | ')}); exactly 2 are ` +
        'admissible, the base and the guard. MEASURED carriers for a third: `div.hp-fill`, ' +
        '`[class~="hp-fill"]`, `.hp-bar > .hp-fill` and `@media screen{.hp-fill{…}}` — each ' +
        'appended after the guard, each animating live under `reduce`, none of them spelled ' +
        '`.hp-fill`',
    );
  }

  // ---- C5: SOURCE ORDER — the single highest-value clause ---------------------------------
  if (!(guard.startIndex > base.endIndex)) {
    return verdict(
      T_ORDER,
      'PRECEDES',
      'the reduced-motion guard is written BEFORE the base rule it is supposed to neutralise ' +
        `(guard opens at offset ${guard.startIndex}, base closes at ${base.endIndex}). A media ` +
        'query adds NO specificity, so the later of two equal-specificity rules wins: in that ' +
        'order the guard is completely inert. MEASURED live at dur=0.3s under `reduce` with ' +
        'every other clause of this gate green',
    );
  }

  // ---- C6: the guard body, as a WHOLE, and custom properties ------------------------------
  const guardDecls = declarations(guard.body);
  const shorthandAt = guardDecls.map((d) => d.prop).lastIndexOf('transition');
  if (shorthandAt === -1 || guardDecls[shorthandAt].value !== 'none') {
    const seen = shorthandAt === -1 ? '(absent)' : guardDecls[shorthandAt].value;
    return verdict(
      T_BODY,
      'GUARD-VALUE',
      `the guard's \`transition\` is ${seen}, not \`none\`. \`none\` is total — it kills every ` +
        'transitioned property, present and future. `transition: width 0s` is still a transition ' +
        'in computed style and is scoped to one property; `transition-duration: 0.01ms` exists ' +
        'to keep `transitionend` firing, and this repo has zero `transitionend` listeners',
    );
  }
  const longhandAfter = guardDecls
    .slice(shorthandAt + 1)
    .filter((d) => isTransitionProp(d.prop) && unprefix(d.prop) !== 'transition');
  if (longhandAfter.length > 0) {
    return verdict(
      T_BODY,
      'LONGHAND-AFTER',
      'the guard re-arms the transition AFTER resetting it: ' +
        `${longhandAfter.map((d) => `${d.prop}:${d.value}`).join('; ')}. MEASURED: ` +
        '`transition:none; transition-property:width; transition-duration:0.3s` animates live ' +
        'under `reduce` and satisfies any clause that reads ONE declaration out of the body',
    );
  }
  const animationInGuard = guardDecls.filter((d) => isAnimationProp(d.prop));
  if (animationInGuard.length > 0) {
    return verdict(
      T_BODY,
      'ANIMATION',
      `the guard declares ${animationInGuard.map((d) => d.prop).join(', ')}. MEASURED: ` +
        '`transition:none; animation:hp-pulse 1s infinite` inside the reduced-motion block moves ' +
        'the element under exactly the preference that asked it not to — `transition:none` does ' +
        'not stop a keyframe animation',
    );
  }
  const customSites = [];
  for (const r of rules) {
    const underGuard = r.atStack.some(
      (a) => normaliseMediaPrelude(a).indexOf('prefers-reduced-motion') !== -1,
    );
    if (r !== base && r !== guard && !underGuard) continue;
    for (const d of declarations(r.body)) {
      if (d.custom) customSites.push(`${r.prelude} { ${d.prop} }`);
    }
  }
  if (customSites.length > 0) {
    return verdict(
      T_BODY,
      'CUSTOM-PROP',
      `a custom property is declared at ${customSites.join(' | ')}. That is the R-m23-s10-RMCSS ` +
        'purity escape: any module can read it back with `getComputedStyle(...).' +
        'getPropertyValue(...)`, which turns this CSS-only guard into a second, unowned reader ' +
        'of the motion preference behind the injected `ResolveInput.reduceMotion` seam. The ban ' +
        'covers BOTH rules and anything nested under the guard, because a `:root` block inside ' +
        'the media query is the same escape from the other side',
    );
  }

  return {
    ok: true,
    base,
    guard,
    rules,
    motionCount: motion.length,
    guardValue: guardDecls[shorthandAt].value,
    baseImportantCount: baseImportant.length,
    customPropCount: customSites.length,
  };
}

/** C1 over `battleView.ts`. */
export function evaluateView(tsSrc) {
  const hits = findInlineAnimationDecls(tsSrc);
  if (hits.length > 0) {
    return verdict(
      T_INLINE,
      'DECL',
      `${hits.length} inline animation site(s) in ${BATTLE_VIEW}: ` +
        `${hits.map((h) => `${h.tag}@${h.index}`).join(', ')}. An inline style declaration wins ` +
        'over every stylesheet rule at every specificity, so no media query can neutralise it; ' +
        'the WAAPI spellings (`.animate(`, `new Animation(`, `KeyframeEffect`) ignore the motion ' +
        'preference outright and are invisible to happy-dom, and `cssText +=` is the ' +
        'second-render-only shape whose first render is byte-clean',
    );
  }
  const sites = fillStyleWriteSites(tsSrc);
  if (!fillStyleWriteIsTotalAssign(sites)) {
    return verdict(
      T_INLINE,
      'STYLE-WRITE-SHAPE',
      `${FILL_BINDING}.style is written ${sites.length} time(s), and not as a single total ` +
        '`cssText =` assignment. ONE total assignment per render is what makes the exact-equality ' +
        'assertions in the DOM tooth meaningful; an append, or a second write elsewhere, is how a ' +
        'declaration arrives on a later render only',
    );
  }
  return { ok: true, inlineCount: hits.length, writeSites: sites.length };
}

// ===========================================================================================
// FIXTURES. Every BAD one is a MEASURED bypass or a measured decoy; every GOOD one is a
// measured FALSE-RED direction. A false RED is not a lesser evil here: it is how a clause gets
// "fixed" into the hollow form that accepts the inversion.
// ===========================================================================================

const FX_BASE = `.${HP_CLASS} { transition: width 0.3s; }`;
const FX_GUARD = `@media (prefers-reduced-motion: reduce) { .${HP_CLASS} { transition: none; } }`;
const FX_OK = `${FX_BASE}\n${FX_GUARD}\n`;

/** The post-fix `battleView.ts` shape: the class, ONE total cssText assignment, and a comment
 *  that names the animation in prose because it explains where it moved to. */
const FX_VIEW_OK =
  '// rb-10 (R-m23-s2-X4): the class is the ONLY handle a stylesheet has on this element.\n' +
  `// The width animation moved to .${HP_CLASS} in ${STYLES_CSS} so the reduced-motion media\n` +
  '// query there can neutralise it. Do NOT re-add an inline transition declaration here.\n' +
  `${FILL_BINDING}.className = '${HP_CLASS}';\n` +
  `${FILL_BINDING}.style.cssText = \`width:\${pct}%;height:100%;background:\${color};\`;\n`;

function guardWith(prelude, body) {
  return `${FX_BASE}\n${prelude} { .${HP_CLASS} { ${body} } }\n`;
}

export default async function () {
  const name = 'reduced-motion-hp-bar ([A11Y-RM3] the HP-bar animation is CSS-owned and guarded)';
  let teeth = 0;
  const teethTotal = 48;

  /**
   * A FAILURE detail. The success line's substrings are SCRUBBED from it: the ledger's CHECKs pipe
   * through `tail`, so the pipeline's exit status is `tail`'s and the EXPECT regex is the sole
   * adjudicator — a failure message that merely mentioned `inline=0` would report the row GREEN.
   */
  const bad = (detail) => {
    let safe = detail;
    for (const needle of [
      `${TAG} `,
      'inline=0',
      'matchingRules=2',
      'base@0',
      'guard@1',
      'order=OK',
      'guardValue=none',
      'important=0',
      'customProps=0',
      'delegate=OK',
      'teeth=',
    ]) {
      safe = safe.split(needle).join('<redacted-success-token>');
    }
    return { name, pass: false, detail: safe };
  };

  /** Run the stylesheet clauses over a fixture, turning a THROW into a reportable verdict. */
  const evalCss = (css) => {
    try {
      return evaluateStylesheet(css);
    } catch (e) {
      return { ok: false, tag: T_VACUITY, code: 'PARSE-FAILED', message: e.message, threw: true };
    }
  };

  // ==========================================================================================
  // PROOF OF TEETH — every fixture runs BEFORE any real file is read, so a broken checkout
  // cannot make the fixtures the thing that "passed".
  // ==========================================================================================

  // F01 GOOD / CONTROL. The shipped shape must be ACCEPTED. Kills the always-red gate: a clause
  // that can never pass is deleted rather than fixed, and every BAD tooth below would be
  // satisfied by an oracle that rejects everything.
  const f01 = evalCss(FX_OK);
  if (!f01.ok) {
    return bad(`TEETH F01: the correct base+guard stylesheet was REJECTED (${f01.message})`);
  }
  teeth += 1;

  // F02 GOOD / CONTROL, and the raw-text-ratchet polarity: the shipped post-fix view comment
  // names the animation in PROSE. A comment-blind scan false-REDs the correct file.
  const f02 = evaluateView(FX_VIEW_OK);
  if (!f02.ok) {
    return bad(`TEETH F02: the correct post-fix battleView shape was REJECTED (${f02.message})`);
  }
  teeth += 1;

  // F03 GOOD: the positive control for source ORDER — in the correct file the guard really does
  // follow the base rule, so F04's rejection is about order and not about an unsatisfiable clause.
  if (!(f01.guard.startIndex > f01.base.endIndex)) {
    return bad('TEETH F03: the shipped order was not recognised as guard-after-base');
  }
  teeth += 1;

  // F04 BAD (S1, MEASURED, the single highest-value clause): guard written BEFORE the base rule.
  // Media queries add no specificity, so the later equal-specificity rule wins — live at dur=0.3s
  // with ALL of the draft gate's teeth green. KILLS: any gate with no order clause at all.
  const f04 = evalCss(`${FX_GUARD}\n${FX_BASE}\n`);
  if (f04.ok || f04.tag !== T_ORDER) {
    return bad('TEETH F04: a guard written BEFORE the base rule was not rejected for ORDER');
  }
  teeth += 1;

  // F05 BAD (S2, MEASURED): `!important` on the base. KILLS: a gate that trusts `biome check` to
  // catch it — `noImportantStyles` is a WARNING there and the run exits 0.
  const f05 = evalCss(`.${HP_CLASS} { transition: width 0.3s !important; }\n${FX_GUARD}\n`);
  if (f05.ok || f05.code !== 'IMPORTANT') {
    return bad('TEETH F05: an !important base rule, which beats the guard, was not rejected');
  }
  teeth += 1;

  // F06-F09 BAD (S3, MEASURED): four carriers for a THIRD matching rule, each appended AFTER the
  // guard, none spelled `.hp-fill`. KILLS: a `prelude === '.hp-fill'` comparison, which sees none
  // of them and reports a clean two-rule stylesheet.
  // POST-R3 NOTE: the expected CODES moved from DUPLICATE/COUNT to SELECTOR for every carrier that
  // is not spelled `.hp-fill`, because the fail-CLOSED clause C2a now runs FIRST and owns them.
  // The tooth that catches these carriers changed by DESIGN — this is not a pin re-pointed to
  // whatever happened to fire. `@media screen{.hp-fill{...}}` keeps COUNT: its prelude IS exactly
  // `.hp-fill`, so C2a admits it and the whole-set count is what refuses it.
  const s3Carriers = [
    { css: `div.${HP_CLASS} { transition: width 0.3s; }`, code: 'SELECTOR' },
    { css: `[class~="${HP_CLASS}"] { transition: width 0.3s; }`, code: 'SELECTOR' },
    { css: `.hp-bar > .${HP_CLASS} { transition: width 0.3s; }`, code: 'SELECTOR' },
    { css: `@media screen { .${HP_CLASS} { transition: width 0.3s; } }`, code: 'COUNT' },
    // R3 (red-team, MEASURED post-ship): five more carriers, each CI-green and each animating
    // live in Chromium under `reduce`. None names the class token, so none was visible to the
    // previous fail-OPEN shape.
    { css: `[class^="hp-"] { transition: width 0.3s; }`, code: 'SELECTOR' },
    { css: `[class*="hp-fil"] { transition: width 0.3s; }`, code: 'SELECTOR' },
    { css: `[class~="HP-FILL" i] { transition: width 0.3s; }`, code: 'SELECTOR' },
    { css: `[style*="height:100%"] { transition: width 0.3s; }`, code: 'SELECTOR' },
    { css: `.hp\\-fill { transition: width 0.3s; }`, code: 'SELECTOR' },
  ];
  for (const carrier of s3Carriers) {
    const got = evalCss(`${FX_OK}${carrier.css}\n`);
    if (got.ok || got.code !== carrier.code) {
      return bad(
        `TEETH F06-F09: the third-rule carrier '${carrier.css}' was not rejected as ` +
          `${carrier.code} (got ${got.ok ? 'ACCEPTED' : got.code})`,
      );
    }
    teeth += 1;
  }

  // F09b GOOD (the false-RED direction of C2a): an UNRELATED plain-class motion rule is still
  // accepted. Without this, the fail-closed policy reads as "no motion may ever be declared in
  // this stylesheet", which is false, and slice S9 (which grows this file) would repair it by
  // deleting the clause.
  {
    const got = evalCss(`${FX_OK}.tooltip { transition: opacity 0.2s; }\n`);
    if (!got.ok) {
      return bad(
        'TEETH F09b: an unrelated `.tooltip { transition: opacity 0.2s }` rule was REJECTED ' +
          `(${got.code}). C2a must refuse only selectors that can alias the fill`,
      );
    }
    teeth += 1;
  }

  // F09c BAD (R4, red-team, MEASURED post-ship): the unquoted-url() comment carrier. `url(` takes
  // a <url-token> RAW to its `)`, so `/*` inside it is not a comment opener in CSS. A stripper
  // without url state opened a comment there and closed it at the next ordinary `*/`, deleting a
  // whole `div.hp-fill{transition:...}` rule from this gate's view with braces AND parens still
  // balanced. Measured biome-clean and indexShell-clean. Built from char codes so this source can
  // never contain a literal delimiter pair.
  {
    const open = String.fromCharCode(47, 42);
    const close = String.fromCharCode(42, 47);
    const carrier =
      `.hp-bar-sprite { background-image: url(${open}); }\n` +
      `div.${HP_CLASS} { transition: width 0.3s; }\n` +
      `.hp-bar-note { width: calc(${open} inset ${close} 100% - 4px); }\n`;
    const got = evalCss(`${FX_OK}${carrier}`);
    const threw =
      got.ok !== true && got.threw === true && String(got.message).indexOf('url()') !== -1;
    if (!threw) {
      return bad(
        'TEETH F09c: the unquoted-url() comment carrier did not make the stripper REFUSE. It is ' +
          'the measured way to delete an entire motion rule from this gate while every brace and ' +
          'paren stays balanced',
      );
    }
    teeth += 1;
  }

  // F09d BAD (R5, red-team, MEASURED post-ship): the CONDITIONAL suspension spellings. Measured:
  // `it.skipIf(TRUE_CONST)(...)` left the delegate reporting `50 passed | 1 skipped` WITH THE
  // PRE-FIX DEFECT RESTORED, while the delegation clause stayed green because it did not know
  // the spelling. Reads as an ordinary environment guard, which is what makes it dangerous.
  for (const spelling of ['it.skipIf(', 'test.runIf(', 'describe.skipIf(']) {
    const found = findSuspensions(`${spelling}COND)('BITES: RM3-HP-FILL', () => {});`);
    if (found.length === 0) {
      return bad(`TEETH F09d: the conditional suspension '${spelling}' was not detected`);
    }
    teeth += 1;
  }

  // F10 GOOD: `.hp-fill-x` and `.xhp-fill` are DIFFERENT classes. Without this the token matcher
  // could be a substring test — which drags unrelated rules into the count and makes the clause
  // unusable, and an unusable clause gets deleted rather than repaired.
  for (const other of [`.${HP_CLASS}-x`, `.x${HP_CLASS}`, `.${HP_CLASS}x`]) {
    if (selectorMatchesClass(other, HP_CLASS)) {
      return bad(`TEETH F10: '${other}' was matched as the .${HP_CLASS} class token`);
    }
  }
  if (!selectorMatchesClass(`.a, div.${HP_CLASS}:not(.x)`, HP_CLASS)) {
    return bad('TEETH F10: a comma list containing a compound .hp-fill selector was not matched');
  }
  teeth += 1;

  // F11-F13 BAD (S4, MEASURED): the WAAPI family. `hpFill.animate([{width:…}],300)` ignores
  // `prefers-reduced-motion` ENTIRELY, is not stopped by `transition:none !important`, and scored
  // 49/49 on the real battleView.test.ts — happy-dom does not implement `Element.animate`, so the
  // DOM tooth structurally cannot see it. Only a TEXT ban reaches this class.
  const waapi = [
    `${FILL_BINDING}.animate([{ width: '0%' }], 300);`,
    `const a = new Animation(effect, document.timeline);`,
    `const e = new KeyframeEffect(el, frames, 300);`,
  ];
  for (const src of waapi) {
    if (findInlineAnimationDecls(src).length === 0) {
      return bad(`TEETH F11-F13: the WAAPI spelling '${src}' was not flagged`);
    }
    teeth += 1;
  }

  // F14 BAD (S5, MEASURED): `style.cssText +=` with the easing in a SIBLING module. The first
  // render is byte-clean, so a single-render DOM tooth passes; a transition can only ever fire on
  // a LATER render. Flagged twice over — as an append, and as a non-total write shape.
  const f14src = `${FILL_BINDING}.style.cssText += HP_EASE;`;
  if (findInlineAnimationDecls(f14src).length === 0) {
    return bad('TEETH F14: a cssText append was not flagged');
  }
  if (fillStyleWriteIsTotalAssign(fillStyleWriteSites(f14src))) {
    return bad('TEETH F14: a cssText append was accepted as a total assignment');
  }
  teeth += 1;

  // F15 BAD: the four spelling escapes from a `transition:`-only text ratchet.
  const spellings = [
    `${FILL_BINDING}.style.transition = 'width 0.3s';`,
    `${FILL_BINDING}.style.webkitTransition = 'width 0.3s';`,
    `${FILL_BINDING}.style.setProperty('transition', 'width 0.3s');`,
    `${FILL_BINDING}.style.cssText = 'transition-duration:0.3s';`,
  ];
  for (const src of spellings) {
    if (findInlineAnimationDecls(src).length === 0) {
      return bad(`TEETH F15: the spelling escape '${src}' was not flagged`);
    }
  }
  teeth += 1;

  // F16 BAD: a declaration hidden in a STRING literal is still a declaration — which is why F02's
  // comment polarity cannot be bought by stripping strings as well as comments.
  if (findInlineAnimationDecls("const s = 'transition:width 0.3s';").length === 0) {
    return bad('TEETH F16: a declaration inside a string literal was not flagged');
  }
  teeth += 1;

  // F17 BAD: two `hpFill.style` writes. A total single assignment is what makes the DOM tooth's
  // exact-equality assertion meaningful; a second write elsewhere is where a later render diverges.
  const f17 = evaluateView(
    `${FILL_BINDING}.style.cssText = 'width:1%';\n${FILL_BINDING}.style.width = '2%';\n`,
  );
  if (f17.ok || f17.code !== 'STYLE-WRITE-SHAPE') {
    return bad('TEETH F17: a second inline style write was not rejected');
  }
  teeth += 1;

  // F18 BAD (S6a, MEASURED): the guard resets the shorthand and then re-arms it with longhands.
  // Every declaration is individually innocent; only their ORDER says what happened. KILLS: a
  // clause that reads ONE declaration out of the guard body.
  const f18 = evalCss(
    guardWith(
      '@media (prefers-reduced-motion: reduce)',
      'transition: none; transition-property: width; transition-duration: 0.3s;',
    ),
  );
  if (f18.ok || f18.code !== 'LONGHAND-AFTER') {
    return bad('TEETH F18: a guard that re-arms the transition with longhands was not rejected');
  }
  teeth += 1;

  // F19 BAD (S6b, MEASURED): a keyframe animation INSIDE the reduced-motion block. `transition:
  // none` does not stop it, so the element moves under exactly the preference that asked it not to.
  const f19 = evalCss(
    guardWith(
      '@media (prefers-reduced-motion: reduce)',
      'transition: none; animation: hp-pulse 1s infinite;',
    ),
  );
  if (f19.ok || f19.code !== 'ANIMATION') {
    return bad('TEETH F19: an animation declared inside the guard body was not rejected');
  }
  teeth += 1;

  // F20 BAD (S7, MEASURED): the comment-delimiter-in-a-string carrier. The tooth asserts BOTH
  // halves — that the carrier really does delete the smuggled rule from a naive stripper's view
  // (otherwise this fixture proves nothing about the attack), and that ours refuses it outright.
  const f20src =
    `${FX_OK}[data-hp-marker="${SLASH_STAR}"] { color: #111; }\n` +
    `div.${HP_CLASS} { transition: width 0.3s; }\n` +
    `[data-hp-end="${STAR_SLASH}"] { color: #222; }\n`;
  if (fixtureNaiveStripCssComments(f20src).indexOf(`div.${HP_CLASS}`) !== -1) {
    return bad(
      'TEETH F20: the smuggled rule survived the NAIVE stripper, so this fixture is not the ' +
        'measured carrier and proves nothing about quote-awareness',
    );
  }
  const f20 = evalCss(f20src);
  if (f20.ok || f20.threw !== true) {
    return bad(
      'TEETH F20: a stylesheet smuggling comment delimiters through a string was accepted',
    );
  }
  teeth += 1;

  // F21 BAD (S8, MEASURED): a second @media nested inside the guard. GREEN against any gate that
  // reads a single enclosing prelude; dead in every real viewport.
  const f21 = evalCss(
    `${FX_BASE}\n@media (prefers-reduced-motion: reduce) { @media (min-width: 99999px) { ` +
      `.${HP_CLASS} { transition: none; } } }\n`,
  );
  if (f21.ok || f21.code !== 'DEPTH') {
    return bad('TEETH F21: a guard nested two at-rule levels deep was not rejected');
  }
  teeth += 1;

  // F22 BAD (S9, MEASURED — the PERFECT INVERSION): `no-preference` as a positive value. Only the
  // player who asked for reduced motion gets the animation. KILLS a clause hollowed into
  // `atContext.includes('prefers-reduced-motion')`, which this fixture sails through.
  const f22 = evalCss(
    guardWith('@media (prefers-reduced-motion: no-preference)', 'transition: none;'),
  );
  if (f22.ok || f22.code !== 'PRELUDE') {
    return bad('TEETH F22: the no-preference inversion was accepted as a reduced-motion guard');
  }
  teeth += 1;

  // F23 BAD: the wrong media FEATURE entirely.
  const f23 = evalCss(guardWith('@media (prefers-contrast: more)', 'transition: none;'));
  if (f23.ok || f23.code !== 'PRELUDE') {
    return bad('TEETH F23: a prefers-contrast block was accepted as the reduced-motion guard');
  }
  teeth += 1;

  // F24 BAD: the guard is present but INERT — it re-declares the animation instead of killing it.
  const f24 = evalCss(
    guardWith('@media (prefers-reduced-motion: reduce)', 'transition: width 0.3s;'),
  );
  if (f24.ok || f24.code !== 'GUARD-VALUE') {
    return bad('TEETH F24: a guard whose transition value is not `none` was accepted');
  }
  teeth += 1;

  // F25 BAD: an EMPTY `.hp-fill{}` base — the exact failure styles.css's header warns about
  // ("shipping an empty .hp-fill rule now would make a later grep believe the guard had landed").
  const f25 = evalCss(`.${HP_CLASS} { }\n${FX_GUARD}\n`);
  if (f25.ok || f25.code !== 'MISSING') {
    return bad('TEETH F25: an empty .hp-fill base rule was accepted');
  }
  teeth += 1;

  // F26 BAD: the COMMENT-ONLY decoy. `.hp-fill` already appears in prose in styles.css's header
  // TODAY (a LIVE decoy), so a presence-only gate is green on the pre-fix tree.
  const f26src =
    `${SLASH_STAR} .${HP_CLASS} { transition: none; } — deliberately absent, see the header ` +
    `${STAR_SLASH}\n.sr-only { position: absolute; }\n`;
  if (parseCssStyleRules(f26src).some((r) => selectorMatchesClass(r.prelude, HP_CLASS))) {
    return bad('TEETH F26: a .hp-fill rule mentioned only inside a CSS comment was parsed as real');
  }
  const f26 = evalCss(f26src);
  if (f26.ok || f26.code !== 'MISSING') {
    return bad('TEETH F26: a stylesheet whose only .hp-fill mention is a comment was accepted');
  }
  teeth += 1;

  // F27 BAD: the base rule itself nested under `@media print`. The unconditional animation the
  // guard is written against then does not exist; on screen nothing animates and the guard is
  // decorative, which a rule-count-only gate reports as a clean two-rule stylesheet.
  const f27 = evalCss(`@media print { ${FX_BASE} }\n${FX_GUARD}\n`);
  if (f27.ok || f27.code !== 'MISSING') {
    return bad('TEETH F27: a base rule nested under @media print was accepted as the base');
  }
  teeth += 1;

  // F28 BAD: the R-m23-s10-RMCSS escape in the BASE rule — the site a guard-body-only custom
  // property check misses entirely.
  const f28 = evalCss(`.${HP_CLASS} { transition: width 0.3s; --mr-reduce: 0; }\n${FX_GUARD}\n`);
  if (f28.ok || f28.code !== 'CUSTOM-PROP') {
    return bad('TEETH F28: a custom property in the BASE rule was accepted');
  }
  teeth += 1;

  // F29 BAD: the same escape from the other side — a `:root` block nested INSIDE the guard, which
  // is neither of the two `.hp-fill` rules and is invisible to a two-rule-only check.
  const f29 = evalCss(
    `${FX_BASE}\n@media (prefers-reduced-motion: reduce) { .${HP_CLASS} { transition: none; } ` +
      ':root { --mr-reduce: 1; } }\n',
  );
  if (f29.ok || f29.code !== 'CUSTOM-PROP') {
    return bad('TEETH F29: a :root custom property nested under the guard was accepted');
  }
  teeth += 1;

  // F30-F33 GOOD: the four equivalent preludes. All are Chromium-correct at dur=0s under
  // `reduce`; rejecting any one of them is a FALSE RED on a correct stylesheet, and the natural
  // "fix" for a false RED is to loosen the clause into the substring test F22 defeats.
  const equivalentPreludes = [
    '@media not (prefers-reduced-motion: no-preference)',
    '@media (prefers-reduced-motion)',
    '@media (prefers-reduced-motion: reduce), print',
    '@MEDIA (PREFERS-REDUCED-MOTION: REDUCE)',
  ];
  for (const prelude of equivalentPreludes) {
    const got = evalCss(guardWith(prelude, 'transition: none;'));
    if (!got.ok) {
      return bad(
        `TEETH F30-F33: the Chromium-correct prelude '${prelude}' was REJECTED (${got.message})`,
      );
    }
    teeth += 1;
  }

  // F34 GOOD: the character walker survives the shapes that break naive scanners — an escaped
  // hash in a class name, a hash inside a `content` string, a fragment URL inside parens, and a
  // hex colour in a nested declaration. None of them may be read as a `.hp-fill` rule either.
  const f34 = evalCss(
    `${FX_BASE}\n${FX_GUARD}\n.\\#notanid { color: #4a4; }\n` +
      '.badge::after { content: "#x"; background: url(#grad); }\n',
  );
  if (!f34.ok) {
    return bad(
      'TEETH F34: a stylesheet with escaped/quoted/parenthesised hashes was REJECTED ' +
        `(${f34.message})`,
    );
  }
  teeth += 1;

  // F35 BAD: parse ambiguity must FAIL LOUD, in both directions. A stylesheet we could not parse
  // must never be reported as a clean stylesheet.
  let threwUnbalanced = false;
  try {
    parseCssStyleRules('.a { color: red; } }\n');
  } catch {
    threwUnbalanced = true;
  }
  let threwUnterminated = false;
  try {
    parseCssStyleRules('.a::after { content: "unterminated; }\n');
  } catch {
    threwUnterminated = true;
  }
  if (!threwUnbalanced || !threwUnterminated) {
    return bad('TEETH F35: an unparseable stylesheet did not throw');
  }
  teeth += 1;

  // F36 BAD: `atStack` must be the FULL stack. A "nearest enclosing" or "outermost" reading is
  // what makes S8 invisible, and neither is distinguishable from the correct one at depth 1.
  const f36 = parseCssStyleRules(
    '@media print { @supports (display: grid) { .a { color: red; } } }',
  );
  if (
    f36.length !== 1 ||
    f36[0].atStack.length !== 2 ||
    f36[0].atStack[0].indexOf('print') === -1 ||
    f36[0].atStack[1].indexOf('supports') === -1
  ) {
    return bad('TEETH F36: the at-rule stack is not the full outermost-first chain');
  }
  teeth += 1;

  // F37 BAD: the delegation pin must fail loud on a gutted, suspended or needle-less delegate.
  if (findInertDelegations(() => 'nothing here at all', RM3_DELEGATIONS).length < 1) {
    return bad('TEETH F37: findInertDelegations accepted a delegate with no describe() at all');
  }
  // The suspended fixture keeps a real `describe(` and BOTH needles, so the only thing wrong with
  // it is the `.skip` — which keeps `vitest run` green and a naive presence pin green too.
  const f37suspended =
    "describe('other', () => {});\n" +
    "describe.skip('RM3-HP-FILL', () => { fill.className; fill.getAttribute('style'); });\n";
  if (findInertDelegations(() => f37suspended, RM3_DELEGATIONS).length < 1) {
    return bad('TEETH F37: a describe.skip delegate — green under `vitest run` — was accepted');
  }
  // ...and the FALSE-RED direction of the same clause: `exit(` contains `xit(` and `unit.skip(`
  // contains `it.skip(`. A substring scan reds a delegate for a call with an unrelated name, and
  // a false RED on a suspension check is repaired by deleting the check.
  if (findSuspensions('process.exit(1); unit.skip(x); const mixit = 1;').length !== 0) {
    return bad('TEETH F37: `exit(` / `unit.skip(` were matched as suspension spellings');
  }
  teeth += 1;

  // F38 BAD: REACHABILITY. Neither a gutted-delegate check nor a needle pin notices a vite config
  // that stops selecting the spec at all, or one that excludes it while the include stays intact.
  if (includeSelectsTests('export default { test: { include: [ "src/main.test.ts" ] } };')) {
    return bad('TEETH F38: a narrowed test.include was accepted as still selecting the delegate');
  }
  if (
    includeSelectsTests(
      'export default { test: { include: [ "src/**/*.test.ts" ], ' +
        'exclude: [ "src/ui/battleView.test.ts" ] } };',
    )
  ) {
    return bad('TEETH F38: a test.exclude naming a .test.ts path was accepted');
  }
  if (
    !includeSelectsTests(
      'export default { test: { include: [ "src/**/*.test.ts" ], ' +
        'coverage: { exclude: [ "src/**/*.test.ts" ] } } };',
    )
  ) {
    return bad('TEETH F38: a coverage.exclude was mistaken for a test.exclude (false RED)');
  }
  teeth += 1;

  if (teeth !== teethTotal) {
    return bad(
      `TEETH ACCOUNTING: ${teeth} fixture teeth ran but the declared total is ${teethTotal} — ` +
        'the denominator must be the number actually executed, or the ratio is decoration',
    );
  }

  // ==========================================================================================
  // C0 — ANTI-VACUITY, then the real tree.
  //
  // C0 is run in TWO halves, each immediately before the clauses it protects: the `battleView.ts`
  // floors before C1, the `styles.css` floors before C2..C6. That is deliberate and it is the one
  // place this file departs from the gate design's clause NUMBERING (the clauses themselves are
  // unchanged). Running the whole of C0 first would mean that on a tree where the stylesheet half
  // has not landed yet, the reported failure is `NO-RULES` — a floor about the file that has not
  // been touched — while the actual defect, a live inline `transition` in `battleView.ts`, goes
  // unnamed. A gate whose failure message points at the wrong file is a gate people learn to
  // ignore. Nothing is weakened: both halves still run before anything they guard.
  // ==========================================================================================
  let viewRaw;
  try {
    viewRaw = readFileSync(BATTLE_VIEW, 'utf8');
  } catch (e) {
    return bad(`${T_VACUITY} UNREADABLE: could not read ${BATTLE_VIEW}: ${e.message}`);
  }
  if (viewRaw.length < VIEW_MIN_BYTES) {
    return bad(
      `${T_VACUITY} TOO-SMALL: ${BATTLE_VIEW} is ${viewRaw.length} bytes, floor ` +
        `${VIEW_MIN_BYTES} — a truncated or emptied view satisfies every "declares no X" clause ` +
        'trivially, which is the shape this floor exists to refuse',
    );
  }
  const viewStripped = stripTsComments(viewRaw);
  if (viewStripped.indexOf(RENDER_FN) === -1) {
    return bad(
      `${T_VACUITY} NO-RENDER-FN: ${RENDER_FN} is not in the executable source of ${BATTLE_VIEW} ` +
        '— the method that builds the fill element has moved or been renamed, so every ban this ' +
        'eval enforces over that file is being enforced over the wrong text',
    );
  }
  if (viewStripped.indexOf(`${FILL_BINDING}.style`) === -1) {
    return bad(
      `${T_VACUITY} NO-STYLE-WRITE: ${BATTLE_VIEW} contains no \`${FILL_BINDING}.style\` write. ` +
        'The inline-write clauses below would then pass over a binding that no longer exists',
    );
  }

  // ==========================================================================================
  // C1 — no inline animation declaration reaches the fill element.
  // ==========================================================================================
  const viewVerdict = evaluateView(viewRaw);
  if (!viewVerdict.ok) return bad(viewVerdict.message);

  // ---- C1b: the ban is REPO-WIDE, not file-local (R1, red-team, MEASURED post-ship) --------
  // Scoping the inline ban to battleView.ts left the cheapest possible escape open: put the
  // animation in a sibling module and call it from the view. MEASURED — a `client/src/ui/
  // hpFillMotion.ts` exporting a feature-detected `target.animate([...], 300)`, called once from
  // #renderMonsterCard, was GREEN on this eval, 51/51 on battleView.test.ts (happy-dom implements
  // no Element.animate, so the feature detect returns early and the DOM tooth sees a byte-clean
  // element), clean on tsc and the pinned biome, PASSING on the ledger's Chromium probe (which
  // renders a static page and runs none of the app's JS) — and visibly animating in a real
  // browser under `reduce`, 204px into a 90->10% drop that should have snapped.
  // That escape is not adversarial, it is the LIKELY next commit: see the R2 note in ADR-0213 —
  // the guarded transition cannot currently fire at all, so the first person who wants a smooth
  // HP bar reaches for exactly this.
  let clientModules;
  try {
    clientModules = listClientModules(CLIENT_SRC);
  } catch (e) {
    return bad(`${T_VACUITY} UNWALKABLE: could not walk ${CLIENT_SRC}: ${e.message}`);
  }
  if (clientModules.length < CLIENT_MODULE_FLOOR) {
    return bad(
      `${T_VACUITY} THIN-TREE: the walk found ${clientModules.length} non-test modules under ` +
        `${CLIENT_SRC}, floor ${CLIENT_MODULE_FLOOR} (measured population at authoring time: 92). ` +
        'A walk that silently collects almost nothing satisfies a repo-wide ban vacuously',
    );
  }
  if (clientModules.indexOf('ui/battleView.ts') === -1) {
    return bad(
      `${T_VACUITY} WALK-MISSES-VIEW: ${CLIENT_SRC}/ui/battleView.ts is not among the walked ` +
        'modules, so the repo-wide scan is not even covering the file this criterion is about',
    );
  }
  const foreignMotion = [];
  for (const rel of clientModules) {
    let src;
    try {
      src = readFileSync(`${CLIENT_SRC}/${rel}`, 'utf8');
    } catch (e) {
      return bad(`${T_VACUITY} UNREADABLE: could not read ${CLIENT_SRC}/${rel}: ${e.message}`);
    }
    const hits = findInlineAnimationDecls(src);
    if (hits.length > 0) {
      foreignMotion.push(`${rel} (${hits.map((h) => h.kind).join(', ')})`);
    }
  }
  if (foreignMotion.length > 0) {
    return bad(
      `${T_INLINE} FOREIGN-MODULE: ${foreignMotion.length} non-test client module(s) declare or ` +
        `start an animation: ${foreignMotion.join(' | ')}. The HP bar's motion is owned by ` +
        `\`.${HP_CLASS}\` in ${STYLES_CSS}, where the reduced-motion media query can neutralise ` +
        'it. A JS-started animation (notably the WAAPI family) ignores that preference outright ' +
        'and is invisible to happy-dom, so neither the DOM tooth nor a static browser probe can ' +
        'see it. If a module here has a legitimate, non-HP-bar reason to animate, this clause is ' +
        'the place to record that exemption explicitly — do not delete it',
    );
  }

  // ==========================================================================================
  // C0 (second half) — the stylesheet's own floors.
  // ==========================================================================================
  let cssRaw;
  try {
    cssRaw = readFileSync(STYLES_CSS, 'utf8');
  } catch (e) {
    return bad(`${T_VACUITY} UNREADABLE: could not read ${STYLES_CSS}: ${e.message}`);
  }
  if (cssRaw.length < STYLES_MIN_BYTES) {
    return bad(
      `${T_VACUITY} TOO-SMALL: ${STYLES_CSS} is ${cssRaw.length} bytes, floor ` +
        `${STYLES_MIN_BYTES} — a truncated or emptied stylesheet satisfies every "declares no X" ` +
        'clause trivially, which is the shape this floor exists to refuse',
    );
  }
  let cssRules;
  try {
    cssRules = parseCssStyleRules(cssRaw);
  } catch (e) {
    return bad(`${T_VACUITY} PARSE-FAILED: ${STYLES_CSS} could not be parsed: ${e.message}`);
  }
  if (cssRules.length < 2) {
    return bad(
      `${T_VACUITY} NO-RULES: ${STYLES_CSS} holds ${cssRules.length} style rule(s); at least 2 ` +
        'are expected once the HP-bar rule lands beside .sr-only. A stylesheet with nothing in ' +
        'it satisfies every ban in this eval without containing the guard at all',
    );
  }

  // ==========================================================================================
  // C2..C6 — the stylesheet.
  // ==========================================================================================
  let cssVerdict;
  try {
    cssVerdict = evaluateStylesheet(cssRaw);
  } catch (e) {
    return bad(`${T_VACUITY} PARSE-FAILED: ${STYLES_CSS} could not be parsed: ${e.message}`);
  }
  if (!cssVerdict.ok) return bad(cssVerdict.message);

  // ==========================================================================================
  // C7 — the delegation pin. Without it, C1's text ratchet is the ONLY thing standing between a
  // gutted DOM tooth and a green ledger.
  // ==========================================================================================
  const inertPins = findInertPins((f) => readFileSync(f, 'utf8'), RM3_DELEGATIONS);
  if (inertPins.length > 0) {
    return bad(`${T_DELEGATE} INERT: ${inertPins.join(' | ')}`);
  }
  const inert = findInertDelegations((f) => readFileSync(f, 'utf8'), RM3_DELEGATIONS);
  if (inert.length > 0) {
    return bad(`${T_DELEGATE} PIN: ${inert.join(' | ')}`);
  }
  let viteRaw;
  try {
    viteRaw = readFileSync(VITE_CONFIG, 'utf8');
  } catch (e) {
    return bad(`${T_DELEGATE} PIN: could not read ${VITE_CONFIG}: ${e.message}`);
  }
  if (!includeSelectsTests(viteRaw)) {
    return bad(
      `${T_DELEGATE} REACHABILITY: ${VITE_CONFIG}'s test scope no longer selects ` +
        `'src/**/*.test.ts', so the delegated RM3-HP-FILL cases are un-run while their pin stays ` +
        'green — the runtime half of this criterion would then be enforced by nothing',
    );
  }

  return {
    name,
    pass: true,
    detail:
      `${TAG} inline=${viewVerdict.inlineCount} matchingRules=${cssVerdict.motionCount} ` +
      `base@${cssVerdict.base.atStack.length} guard@${cssVerdict.guard.atStack.length} ` +
      `order=OK guardValue=${cssVerdict.guardValue} ` +
      `important=${cssVerdict.baseImportantCount} customProps=${cssVerdict.customPropCount} ` +
      `delegate=OK teeth=${teeth}/${teethTotal}`,
  };
}
