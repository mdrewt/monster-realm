// Eval: reduced-motion purity (M23 §5.6, criterion A11Y-28, tag [A11Y-RM2]; slice m23-s10).
//
// THE RULE. `matchMedia` — the one browser global that reads the player's motion preference — may
// be referenced in exactly ONE non-test `client/src` module, `render/motionPreference.ts`, and
// `render/renderResolver.ts` may touch no browser global at all. The preference is INJECTED into
// the resolver as `ResolveInput.reduceMotion` (M23 §2.5); a resolver that reads it for itself is
// no longer a pure function of its inputs, which is the determinism property the four
// parity/convergence evals depend on.
//
// WHAT THIS ADDS OVER THE SHIPPED S7 SCAN, AND WHY THAT MATTERS.
// `client/src/render/motionPreference.test.ts:283` (`S7T-SCAN`) already runs a census of this shape
// and is STRONGER than §5.6 on the axis it covers: anti-vacuity floors, a disguised-test tripwire,
// a nine-token banned-globals list, an exact import allow-list. Restating it here would add nothing
// — `justfile:491` runs `eval` and `client-test` in the SAME `just ci`, so there is no CI surface
// where one runs without the other.
//
// What `S7T-SCAN` structurally CANNOT see is a SCOPE ESCAPE. It `readdir`s `client/src` and only
// `client/src`, so a preference read moved into `client/index.html`'s inline `<script>` or into
// `client/vite.config.ts` leaves its census clean while the client still reads the media query
// behind the resolver's back. Correction R-m23-s7-X11 assigned exactly that gap to this slice:
// S7 shipped the IN-SLICE scan covering its own seam files; §5.6 asks for the REPO-WIDE ratchet.
// `[A11Y-RM2c]` below is that half, and it is the reason this file exists rather than being a
// second copy of a better test.
//
// The `client/src` census (`[A11Y-RM2a]`/`[A11Y-RM2b]`) IS re-implemented here, unlike the CSS
// oracle in the sibling eval: it is a `readdir` plus a substring test that shares no algorithm with
// the TS side, so there is no hardened parser to keep in agreement and two independently-built
// oracles of different construction are worth their keep. `[A11Y-RM2d]` additionally pins that the
// stronger S7 test still exists and still runs.
//
// LIVE TRAP, MEASURED: `client/src/render/renderResolver.ts:112` names `window` in a COMMENT
// ("the tracked-through-the-window consequence"). A comment-blind global ban false-REDs the
// shipped, correct file. Conversely `motionPreference.ts` names `matchMedia` in its own header, so
// its OWNERSHIP claim must be checked against the COMMENT-STRIPPED source or a module that merely
// documents the rule would satisfy it.
//
// THE TWO m23-s10 RESIDUALS ABOVE ARE NOW CLOSED, BY SLICE rb-17. What they became:
//   * R-m23-s10-RMCSS → `[A11Y-RM2e]`. S9's `@media (prefers-reduced-motion: reduce)` block in
//     `client/src/styles.css` has landed and is stable, so the ban can finally be written without
//     having to be unwritten. It is deliberately NOT a ban on honouring the preference in CSS —
//     that is the legitimate, declarative way to do it, and `styles.css:95-99` does exactly that.
//     It bans ONE thing: a CSS CUSTOM PROPERTY declared inside a motion-scoped at-rule. A custom
//     property is not a rendering effect; it is a JS-readable channel
//     (`getComputedStyle(el).getPropertyValue('--mr-reduce')`) that re-creates the second
//     preference reader this whole file exists to forbid, while naming neither MOTION_TOKEN.
//     `[A11Y-RM2f]` closes the same escape at the READ end.
//   * R-m23-s10-RMEXT → `[A11Y-RM2g]` + the census predicates below. MEASURED at rb-17: the
//     divergence runs the OPPOSITE way from the way the residual recorded it. The five extensions
//     buy zero files (`client/src` holds zero `.tsx`/`.js`/`.mjs`/`.cjs`/`.d.ts`), while
//     `listClientSourceFiles` SKIPS `client/src/module_bindings` entirely
//     (`a11y-static-shell.eval.mjs:870`) and `motionPreference.test.ts`'s census does not — so the
//     EVAL was the weaker tier, by 65 generated-but-shipped, vite-bundled, main.ts-imported files.
//     Reconciling onto `listClientSourceFiles` would therefore have been a 65-file LOOSENING.
//     rb-17 reconciles UPWARD instead: this file owns the census scope, the `.ts` test IMPORTS the
//     predicates (the rb-15 single-owner direction — a `.ts` test can import a `.mjs` eval, never
//     the reverse), and `[A11Y-RM2g]` two-way-ratchets the difference against the un-owned walker
//     so a drift THERE is a loud red here.
//
// STILL OPEN, DECLARED, NOT SILENTLY DROPPED (rb-17 ledger DEFER lines):
//   * R-rb17-FOCUSHELPER — `[A11Y-15]` scans `client/src/ui/*View.ts` only, so a view delegating
//     focus to a non-`*View.ts` helper is invisible. Every moving part lives in
//     `overlay-a11y-manifest.eval.mjs`, outside rb-17's `touches:`, and ADR-0217 forbids a second
//     `[A11Y-15]` oracle. The residual's recorded blocker ("needs main.ts in touches") is WRONG:
//     the scan reads files, it never edits them, so `main.ts` only needs to be NAMED in an owner
//     allow-list inside that eval.
//   * R-rb17-GEOM — the geometric channel. A motion-scoped rule that changes a LAYOUT property
//     (`.probe{width:2px}`) is read back with `probe.offsetWidth`, naming no token either clause
//     bans. Banning `offsetWidth`/`getBoundingClientRect` would false-RED the first legitimate
//     layout feature, and a false-RED is how a clause gets deleted rather than fixed.
//   * R-rb17-WALKER3 — `reduced-motion-hp-bar.eval.mjs:1010` `listClientModules` is a THIRD walker,
//     behaviourally identical to `listClientSourceFiles`. Out of `touches:`, so unreconciled.
//
// NO `main` GUARD (see the manifest eval). `run.mjs` imports the default export.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import {
  listClientSourceFiles,
  stripCssComments,
  stripHtmlComments,
} from './a11y-static-shell.eval.mjs';
import {
  findInertDelegations,
  findInertPins,
  includeSelectsTests,
  stripTsComments,
} from './overlay-a11y-manifest.eval.mjs';
import {
  declarations,
  normaliseMediaPrelude,
  parseCssStyleRules,
  stripCssComments as stripCssCommentsHardened,
} from './reduced-motion-hp-bar.eval.mjs';

const CLIENT_SRC = 'client/src';
const VITE_CONFIG = 'client/vite.config.ts';
const MOTION_OWNER = 'render/motionPreference.ts';
const RESOLVER = 'render/renderResolver.ts';
/** The ONE directory the shared walker skips and this file's census does not. Trailing slash so a
 *  sibling named `module_bindings_backup` cannot satisfy the ratchet's prefix test. */
const GENERATED_DIR = 'module_bindings/';
/** The stylesheet the CSS clause is pinned to, and its byte floor. A truncated or mistyped read
 *  must fail LOUD: an empty file has no motion-scoped rules and no custom properties either. */
const STYLES = 'styles.css';
const STYLES_MIN_BYTES = 800;

/** The out-of-tree artefacts `S7T-SCAN` cannot reach. Both are real client entry points: the HTML
 *  shell runs an inline module script, and the Vite config runs at build time with full DOM-less
 *  Node access but can `define` anything into the bundle. */
const OUT_OF_TREE = Object.freeze(['client/index.html', 'client/vite.config.ts']);

/** Tokens that mean "this module read the motion preference itself". `prefers-reduced-motion` is
 *  listed alongside `matchMedia` because the media-query STRING is the tell even when the call is
 *  spelled some other way (`window['match'+'Media']`, a `<style>` block, a CSS `@media`). */
export const MOTION_TOKENS = Object.freeze(['matchMedia', 'prefers-reduced-motion']);

/**
 * Browser globals a PURE resolver must not name. Nine tokens, not one: banning `window` alone is
 * satisfied by `globalThis.matchMedia`, and banning both is satisfied by `self`/`top`/`parent`.
 */
export const BANNED_RESOLVER_GLOBALS = Object.freeze([
  'window',
  'globalThis',
  'document',
  'navigator',
  'matchMedia',
  'self',
  'top',
  'parent',
  'frames',
]);

/**
 * Which BANNED_RESOLVER_GLOBALS a source names, after comment-stripping.
 *
 * Comment-stripping is load-bearing on the live tree, not defensive: `renderResolver.ts:112` says
 * "the tracked-through-the-window consequence" in prose, so a raw scan reds the correct file.
 *
 * The `\b` boundaries keep `top` from matching `stopPropagation` and `parent` from matching
 * `parentElement` — without them this predicate is unusable and the natural "fix" is to delete the
 * two tokens, which is how a ban shrinks to nothing.
 */
export function bannedGlobalsIn(src) {
  const stripped = stripTsComments(src);
  return BANNED_RESOLVER_GLOBALS.filter((g) => {
    let i = stripped.indexOf(g);
    while (i !== -1) {
      const before = i === 0 ? '' : stripped[i - 1];
      const after = stripped[i + g.length] === undefined ? '' : stripped[i + g.length];
      const wordish = /[A-Za-z0-9_$]/;
      if (!wordish.test(before) && !wordish.test(after)) return true;
      i = stripped.indexOf(g, i + 1);
    }
    return false;
  });
}

/**
 * Non-test `client/src` modules that name a motion token, as a SET (not a count).
 *
 * RAW text on purpose, unlike `bannedGlobalsIn`: a comment mentioning `matchMedia` in a module
 * other than the owner is a second site an implementer grows into a call, and `S7T-SCAN` takes the
 * same position at `motionPreference.test.ts:298`. The owner's OWNERSHIP is checked separately
 * against stripped source, so "mentions it in a header" cannot masquerade as "implements it".
 */
export function findMotionReaders(sources) {
  return Object.keys(sources)
    .filter((p) => MOTION_TOKENS.some((t) => sources[p].indexOf(t) !== -1))
    .sort();
}

/**
 * Out-of-tree artefacts that read the motion preference — the escape `S7T-SCAN` cannot see.
 *
 * HTML and CSS comments are stripped so a `<!-- … prefers-reduced-motion … -->` note or a CSS block
 * comment in an inline `<style>` is not a violation; the `.ts` config goes through the TS stripper.
 * An `@media (prefers-reduced-motion: reduce)` rule in a stylesheet is a legitimate, non-JS way to
 * honour the preference — but not in these two files, which are the CLIENT ENTRY POINTS, and a
 * preference read here bypasses the injected `ResolveInput.reduceMotion` seam entirely.
 */
export function findOutOfTreeMotionReads(sources) {
  const hits = [];
  for (const [path, raw] of Object.entries(sources)) {
    let stripped = raw;
    if (path.endsWith('.ts')) stripped = stripTsComments(raw);
    else stripped = stripCssComments(stripHtmlComments(raw));
    if (MOTION_TOKENS.some((t) => stripped.indexOf(t) !== -1)) hits.push(path);
  }
  return hits.sort();
}

// ======================================================================================
// CENSUS SCOPE — the single owner (R-m23-s10-RMEXT). `client/src/render/motionPreference.test.ts`
// IMPORTS these predicates, so the two tiers cannot drift: there is one definition of "which
// client/src files does the motion census cover", and it is here.
// ======================================================================================

/**
 * The extensions Vite bundles out of `client/src`.
 *
 * Five, not one: a rule scoped to `.ts` alone is escaped by RENAMING a file, and Vite happily
 * bundles every one of these. All four non-`.ts` populations are EMPTY today — that is the point.
 * A ratchet written only for the shapes that already exist is not a ratchet.
 */
export const MOTION_CENSUS_EXTS = Object.freeze(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

/** `endsWith`, NEVER `includes`: `includes('.test.ts')` wrongly EXCLUDES the production module
 *  `ui/foo.test.ts.bak.ts`, and `includes('.ts')` wrongly INCLUDES `foo.test.ts.bak`. A name-suffix
 *  exemption that admits disguised production code is a measured shape in this repo. */
const hasBundledExt = (rel) => MOTION_CENSUS_EXTS.some((ext) => rel.endsWith(ext));
const hasSpecSuffix = (rel) => rel.endsWith('.test.ts') || rel.endsWith('.test.tsx');

/**
 * Is this path a NON-TEST module the motion census must police?
 *
 * A PURE PATH PREDICATE with no directory semantics of its own. In particular it says TRUE for
 * `module_bindings/…`: excluding generated code HERE would re-introduce, one layer down, exactly
 * the 65-file gap rb-17 exists to close. Whether a walker descends into a directory is the
 * walker's decision, and `listMotionCensusFiles` below deliberately descends into all of them.
 *
 * `.d.ts` is excluded: it is type-erased at build time so it can carry no shipped call, but it CAN
 * carry the raw media-query string and would false-RED the deliberately RAW reader census.
 */
export function isCensusSource(rel) {
  return hasBundledExt(rel) && !hasSpecSuffix(rel) && !rel.endsWith('.d.ts');
}

/** Is this path a SPEC file? The complement of `isCensusSource` within the bundled extensions,
 *  minus `.d.ts`. `.test.tsx` counts — a `.tsx` spec is a spec. */
export function isCensusSpec(rel) {
  return hasBundledExt(rel) && hasSpecSuffix(rel);
}

/**
 * Every non-test bundled module under `root`, relative to it, INCLUDING `module_bindings`.
 *
 * This is deliberately a SECOND walk implementation rather than a call into
 * `a11y-static-shell.eval.mjs`'s: that one skips `module_bindings` by design for its own clause,
 * and rb-17 must not change a walker three other evals share. `[A11Y-RM2g]` below then ratchets
 * the two against each other, so having two is a checked property rather than a silent divergence.
 */
export function listMotionCensusFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = `${root}/${entry}`;
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      out.push(...listMotionCensusFiles(full, rel));
    } else if (isCensusSource(rel)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Every stylesheet under `root`, relative to it. Vite bundles any `.css` `client/src` imports,
 *  and today there is exactly one — which is precisely why the walk needs a positive-find floor
 *  rather than a count floor: "no stylesheets found" and "no violations found" look identical. */
export function listCssFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = `${root}/${entry}`;
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...listCssFiles(full, rel));
    else if (rel.endsWith('.css')) out.push(rel);
  }
  return out.sort();
}

/** Members of `a` absent from `b`, sorted. A SET difference, never a symmetric one: the two
 *  directions of the `[A11Y-RM2g]` ratchet mean different things and must be asserted separately. */
export function censusDifference(a, b) {
  const inB = new Set(b);
  return a.filter((path) => !inB.has(path)).sort();
}

// ======================================================================================
// THE CSS CHANNEL (R-m23-s10-RMCSS) and its READ end.
// ======================================================================================

/**
 * Does this at-rule prelude scope its contents to the reduced-motion preference?
 *
 * SUBSTRING on the NORMALISED prelude, deliberately, and deliberately NOT
 * `guardPreludeIsEquivalent`. That predicate is an ALLOW-LIST of the three spellings that are a
 * CORRECT guard, and it rightly REJECTS `(prefers-reduced-motion: no-preference)` because for
 * `[A11Y-RM3]` an inversion is a broken guard. Here the polarity is opposite: an inversion is an
 * EQUALLY GOOD JS-readable channel, so the allow-list is the wrong tool and using it would ship
 * the `no-preference` bypass. `normaliseMediaPrelude` lowercases, so `@MEDIA (PREFERS-…)` — a
 * formatter-stable, Chromium-correct spelling — is caught, and a comma media-query list or a
 * `not (...)` wrapper cannot defeat a substring the way they defeat exact equality.
 */
export function preludeIsMotionScoped(prelude) {
  return normaliseMediaPrelude(prelude).indexOf('prefers-reduced-motion') !== -1;
}

/**
 * Does this text contain an `@` that is neither inside a string nor inside parentheses?
 *
 * Used on a STYLE rule's body, where such an `@` can only be CSS NESTING — and CSS Nesting is a
 * MEASURED blind spot of `parseCssStyleRules`, not a hypothetical one. For
 * `:root{@media (prefers-reduced-motion:reduce){--mr-reduce:1}}` the inner `@media` frame is
 * `kind: 'at'` and is DISCARDED, while `:root`'s body becomes the whole raw nested text; the
 * paren-shielded `firstTopLevelColon` then reports the property as
 * `@media (prefers-reduced-motion:reduce) { --mr-reduce`, so `custom` is FALSE and `atStack` is
 * EMPTY. The rule is invisible on BOTH axes. So the shape is REFUSED rather than parsed — the
 * repo's declared "fail loud on an un-parseable shape" default. THE REPAIR IS TO UN-NEST, NEVER
 * TO LOOSEN THIS.
 *
 * Quote- and paren-aware because both carriers ship in ordinary CSS: `content: "@media"` and
 * `url(logo@2x.png)`. A false RED here is not a safe default — it is how a clause gets deleted.
 */
export function hasUnscopedAt(text) {
  let quote = null;
  let paren = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')' && paren > 0) paren -= 1;
    else if (ch === '@' && paren === 0) return true;
  }
  return false;
}

/**
 * Motion-scoped CSS custom properties, plus the count of motion-scoped rules the scan actually saw.
 *
 * Returns `{ motionScopedRules, offenders }`. THROWS — never returns a verdict — on three
 * un-scannable shapes, because each one makes a green answer mean nothing:
 *   * CSS Nesting inside a style rule (see `hasUnscopedAt`);
 *   * a top-level `@import`, which pulls in a stylesheet this walker cannot follow, so the ban
 *     would be silently scoped to the wrong bytes. `parseCssStyleRules` treats a bare
 *     `@import url(...);` as an ordinary statement and records nothing at all, so this needs its
 *     own scan or the escape is completely invisible;
 *   * anything `parseCssStyleRules`/`stripCssComments` itself refuses (unbalanced braces, an
 *     unterminated string, comment delimiters inside an unquoted `url()`), which is NOT caught
 *     here on purpose — no try/catch, so the throw reaches the caller intact.
 *
 * The HARDENED stripper is used, not the one this file already imports from
 * `a11y-static-shell.eval.mjs`. Both are legitimate and BOTH stay: the shell one is the declared
 * sole owner for the `index.html` pair in `findOutOfTreeMotionReads` and tolerates shapes an HTML
 * shell may grow, while the hp-bar one refuses a measured false-GREEN carrier — a rule hidden from
 * view by comment delimiters planted inside attribute-selector STRINGS, with braces left balanced.
 * For a ban whose whole subject is stylesheet structure, the refusing stripper is the right one.
 */
export function findMotionCustomProps(css) {
  const clean = stripCssCommentsHardened(css);
  if (hasTopLevelImport(clean)) {
    throw new Error(
      'CSS scan REFUSED: a top-level at-import pulls in a stylesheet outside the walked set, so a ' +
        'clean verdict here would be a statement about the wrong bytes. Inline the rules instead.',
    );
  }
  const rules = parseCssStyleRules(css);
  let motionScopedRules = 0;
  const offenders = [];
  for (const rule of rules) {
    if (hasUnscopedAt(rule.body)) {
      throw new Error(
        `CSS scan REFUSED: style rule '${rule.prelude}' nests an at-rule in its body. The parser ` +
          'discards that frame and reports the declaration as neither scoped nor custom, so both ' +
          'axes of this ban read clean on it. Un-nest the rule; do not relax the ban.',
      );
    }
    if (!rule.atStack.some(preludeIsMotionScoped)) continue;
    motionScopedRules += 1;
    for (const decl of declarations(rule.body)) {
      if (decl.custom) {
        offenders.push({ prelude: rule.prelude, atStack: rule.atStack.slice(), prop: decl.prop });
      }
    }
  }
  return { motionScopedRules, offenders };
}

/** A top-level `@import` in already-comment-stripped CSS: outside any block, string or paren. */
function hasTopLevelImport(clean) {
  let quote = null;
  let paren = 0;
  let depth = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean.charAt(i);
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')' && paren > 0) paren -= 1;
    else if (paren === 0 && ch === '{') depth += 1;
    else if (paren === 0 && ch === '}' && depth > 0) depth -= 1;
    else if (paren === 0 && depth === 0 && ch === '@' && clean.startsWith('@import', i)) return true;
  }
  return false;
}

/**
 * CSS read-back / motion-event APIs a `client/src` module must not name.
 *
 * FIFTEEN tokens, not the obvious one. `getComputedStyle` alone is escaped by
 * `document.styleSheets[0].cssRules` and by `el.computedStyleMap()`; and banning the whole CSSOM
 * read surface is STILL escaped by the EVENT channel, which needs no read API at all:
 * `@media (prefers-reduced-motion: reduce){.probe{transition:opacity 1ms}}` plus a
 * `transitionrun` listener reports the OS preference in every real browser while naming none of
 * the first seven tokens. That bypass was measured against this clause's own first draft.
 *
 * Banning the event names costs nothing today and is not a new position: `client/src/styles.css`
 * already records that the guard uses `transition: none` rather than the `0.01ms` idiom precisely
 * BECAUSE nothing in this client listens for `transitionend`/`animationend` — zero hits repo-wide,
 * re-measured at rb-17 for all fifteen. If a module ever legitimately needs one, the fix is a
 * deliberate allow-list entry plus an ADR, never quietly shortening this list.
 */
export const READ_BACK_TOKENS = Object.freeze([
  'getComputedStyle',
  'getPropertyValue',
  'computedStyleMap',
  'currentStyle',
  'styleSheets',
  'cssRules',
  'getAnimations',
  'animationstart',
  'animationend',
  'animationcancel',
  'animationiteration',
  'transitionrun',
  'transitionstart',
  'transitionend',
  'transitioncancel',
]);

/**
 * Which READ_BACK_TOKENS a source names, word-boundary-matched on RAW text.
 *
 * RAW, like `findMotionReaders` and for the same reason: a mention in a comment is a site an
 * implementer grows into a call. What keeps that honest is SCOPE, not text-blindness — this clause
 * runs over the SOURCE census only, and `client/src/indexShell.test.ts` legitimately names
 * `getComputedStyle` in a comment. Feed it the spec census and it reds on merge.
 *
 * The `\b`-equivalent boundary check is load-bearing exactly as it is in `bannedGlobalsIn`: a
 * `getComputedStyleCache` identifier must not fire, or the clause becomes unusable and the natural
 * "fix" is to shorten the list.
 */
export function findReadBackApis(src) {
  const wordish = /[A-Za-z0-9_$]/;
  return READ_BACK_TOKENS.filter((token) => {
    let i = src.indexOf(token);
    while (i !== -1) {
      const before = i === 0 ? '' : src[i - 1];
      const after = src[i + token.length] === undefined ? '' : src[i + token.length];
      if (!wordish.test(before) && !wordish.test(after)) return true;
      i = src.indexOf(token, i + 1);
    }
    return false;
  });
}

/** The stronger S7 oracle this eval complements rather than replaces. Pinned so that deleting it
 *  is a loud red here — otherwise "we delegate the hard half" quietly becomes "nobody checks it". */
export const MOTION_DELEGATIONS = Object.freeze([
  {
    tag: '[A11Y-RM2d]',
    criterion:
      'A11Y-28 — the in-tree census, with import allow-lists and the disguised-test tripwire',
    file: 'client/src/render/motionPreference.test.ts',
    titleNeedles: ['S7T-SCAN'],
    codeNeedles: ['mentionsMatchMedia'],
  },
]);

export default async function () {
  const name = 'reduced-motion-purity ([A11Y-RM2] matchMedia ownership + the out-of-tree escape)';
  let teeth = 0;
  const teethTotal = 42;
  const bad = (detail) => ({ name, pass: false, detail });

  // ==================================================================
  // PROOF-OF-TEETH — fixtures first.
  // ==================================================================

  // T1 BAD (the spec's named case): a resolver reading the preference itself.
  if (
    bannedGlobalsIn("export const r = window.matchMedia('(prefers-reduced-motion: reduce)');")
      .length < 2
  ) {
    return bad('TEETH T1: a resolver calling window.matchMedia was not flagged — the control');
  }
  teeth++;

  // T2 GOOD (HOSTILE-BUT-CORRECT, and LIVE today): `renderResolver.ts:112` names `window` in a
  // COMMENT. A raw-text ban reds the shipped, correct file.
  if (
    bannedGlobalsIn('// the tracked-through-the-window consequence\nexport const a = 1;').length !==
    0
  ) {
    return bad(
      'TEETH T2: `window` inside a COMMENT was flagged — this false-REDs the shipped ' +
        'client/src/render/renderResolver.ts:112 on merge',
    );
  }
  teeth++;

  // T3 BAD: banning `window` alone is satisfied by `globalThis`. Two spellings, so the ban cannot
  // collapse to one token and stay green across a monoculture corpus.
  if (!bannedGlobalsIn('export const q = globalThis.matchMedia(s);').includes('globalThis')) {
    return bad('TEETH T3: the `globalThis` escape from a window-only ban was not flagged');
  }
  teeth++;

  // T4 GOOD (monoculture-breaker): the word-boundary cases. `stopPropagation` contains `top` and
  // `parentElement` contains `parent`; without boundaries this predicate is unusable and the
  // natural "fix" is to delete both tokens, shrinking the ban.
  if (
    bannedGlobalsIn('e.stopPropagation();\nconst p = li.parentElement;\nconst t = topOf(x);')
      .length !== 0
  ) {
    return bad(
      'TEETH T4: `stopPropagation`/`parentElement`/`topOf` matched the `top`/`parent` tokens — ' +
        'without word boundaries the ban is unusable and gets deleted rather than fixed',
    );
  }
  teeth++;

  // T5 BAD: the census is a SET, not a count. A second reader must be named, not merely tallied.
  const t5readers = findMotionReaders({
    'render/motionPreference.ts': "host.matchMedia('(prefers-reduced-motion: reduce)')",
    'render/renderResolver.ts': 'export const a = 1;',
    'ui/rogue.ts': "window.matchMedia('(prefers-reduced-motion: reduce)')",
  });
  if (t5readers.length !== 2 || !t5readers.includes('ui/rogue.ts')) {
    return bad(
      `TEETH T5: the reader census returned [${t5readers.join(', ')}] — an "at least one caller" ` +
        'presence check passes a tree with two readers; set equality is the property',
    );
  }
  teeth++;

  // T6 BAD: the media-query STRING is a reader even without the call. Kills a `matchMedia`-only
  // token ban, which a computed-string call sails through.
  if (
    !findMotionReaders({ 'ui/x.ts': "const Q = '(prefers-reduced-motion: reduce)';" }).includes(
      'ui/x.ts',
    )
  ) {
    return bad('TEETH T6: a module naming the media-query string was not counted as a reader');
  }
  teeth++;

  // T7 BAD (the SCOPE ESCAPE — the reason this eval exists): the read moved into index.html's
  // inline script. `S7T-SCAN` readdirs client/src and structurally cannot see this.
  const escaped = findOutOfTreeMotionReads({
    'client/index.html': '<script>window.matchMedia("(prefers-reduced-motion: reduce)")</script>',
    'client/vite.config.ts': 'export default {};',
  });
  if (escaped.length !== 1 || escaped[0] !== 'client/index.html') {
    return bad(
      `TEETH T7: the out-of-tree scan returned [${escaped.join(', ')}] — a preference read in ` +
        "index.html's inline script escapes the in-tree census by SCOPE, not by text",
    );
  }
  teeth++;

  // T8 BAD: the same escape via the build config.
  if (
    !findOutOfTreeMotionReads({
      'client/vite.config.ts': "define: { __RM__: matchMedia('x') }",
    }).includes('client/vite.config.ts')
  ) {
    return bad('TEETH T8: a motion read in vite.config.ts was not flagged');
  }
  teeth++;

  // T9 GOOD (hostile-but-correct): an HTML COMMENT documenting the rule is not a read. The shipped
  // index.html is comment-heavy, so this polarity is what keeps the out-of-tree scan usable.
  if (
    findOutOfTreeMotionReads({
      'client/index.html': '<!-- no prefers-reduced-motion read here -->',
    }).length !== 0
  ) {
    return bad('TEETH T9: an HTML comment naming the media query was treated as a read');
  }
  teeth++;

  // T10 BAD: the delegation pin must fail-loud on a gutted delegate.
  if (findInertDelegations(() => 'nothing here at all', MOTION_DELEGATIONS).length < 1) {
    return bad('TEETH T10: findInertDelegations accepted a delegate missing its needle');
  }
  teeth++;

  // ---- rb-17 [A11Y-RM2e] CSS teeth ------------------------------------------------------
  // CSS comment delimiters are assembled from char codes: a literal pair anywhere in this file
  // desynchronises the very strippers under test, with no throw.
  const SLASH = String.fromCharCode(47);
  const STAR = String.fromCharCode(42);
  const CSS_OPEN = SLASH + STAR;
  const CSS_CLOSE = STAR + SLASH;

  // `scoped` = motion-scoped rules the scan must SEE; `props` = the custom properties it must NAME.
  // Every GOOD row is drawn from the live tree or a documented future-legitimate shape, never a
  // strawman: a clause that only survives strawmen gets deleted the first time it false-REDs.
  const cssTeeth = [
    // BAD — the control.
    { id: 'e1', css: '@media (prefers-reduced-motion: reduce){:root{--mr-reduce:1}}', scoped: 1, props: ['--mr-reduce'] },
    // BAD — the `no-preference` INVERSION. `guardPreludeIsEquivalent` returns false here, so an
    // impl reusing that allow-list ships this channel.
    { id: 'e2', css: '@media (prefers-reduced-motion: no-preference){:root{--mr-inv:0}}', scoped: 1, props: ['--mr-inv'] },
    // BAD — motion is atStack[1], not atStack[0]. Kills any fixed-stack-position check.
    { id: 'e3', css: '@supports (display: grid){@media (prefers-reduced-motion: reduce){:root{--mr-deep:1}}}', scoped: 1, props: ['--mr-deep'], stack: 2 },
    // BAD — a comma media-query list. Kills exact-prelude equality against GUARD_PRELUDES.
    { id: 'e4', css: '@media screen, (prefers-reduced-motion: reduce){:root{--mr-comma:1}}', scoped: 1, props: ['--mr-comma'] },
    // BAD — uppercase. Formatter-stable and Chromium-correct; kills a case-sensitive indexOf.
    { id: 'e6', css: '@MEDIA (PREFERS-REDUCED-MOTION: REDUCE){:root{--MR-UP:1}}', scoped: 1, props: ['--MR-UP'] },
    // GOOD — S9's own declared future edit. Kills a blanket ban on custom properties in the sheet,
    // which would false-RED the shipped `:root` colour tokens.
    { id: 'e8', css: ':root{--mr-fg:#fff}@media (prefers-contrast: more){:root{--mr-fg:#000}}', scoped: 0, props: [] },
    // GOOD — the LIVE guard shape. Honouring the preference declaratively is the point, not the crime.
    { id: 'e10', css: '@media (prefers-reduced-motion: reduce){.hp-fill{transition:none}}', scoped: 1, props: [] },
    // GOOD — two ordinary `@` carriers. A quote-blind or paren-blind nesting refusal false-REDs both.
    { id: 'e11', css: '.icon{content:"@media";background:url(logo@2x.png);}', scoped: 0, props: [] },
    // BAD — the boolean-context guard form, no colon at all. Kills an `indexOf` anchored on the colon.
    { id: 'e13', css: '@media (prefers-reduced-motion){:root{--mr-bool:1}}', scoped: 1, props: ['--mr-bool'] },
    // BAD — a CORRECT guard spelling still carrying a channel. The ban is orthogonal to guard quality.
    { id: 'e14', css: '@media not (prefers-reduced-motion: no-preference){:root{--mr-not:1}}', scoped: 1, props: ['--mr-not'] },
    // GOOD — a custom property inside a real at-rule that is NOT reduced-motion.
    { id: 'e16', css: '@supports (display: grid){:root{--not-motion:1}}', scoped: 0, props: [] },
  ];
  for (const row of cssTeeth) {
    let got;
    try {
      got = findMotionCustomProps(row.css);
    } catch (e) {
      return bad(`TEETH ${row.id}: findMotionCustomProps threw on a scannable fixture: ${e.message}`);
    }
    if (got.motionScopedRules !== row.scoped) {
      return bad(
        `TEETH ${row.id}: saw ${got.motionScopedRules} motion-scoped rule(s), the fixture has ` +
          `${row.scoped} — the scope predicate is wrong, so every verdict over it is meaningless`,
      );
    }
    const names = got.offenders.map((o) => o.prop).sort();
    if (names.join('|') !== row.props.slice().sort().join('|')) {
      return bad(
        `TEETH ${row.id}: named [${names.join(', ')}], the fixture requires ` +
          `[${row.props.join(', ')}] — a count is not a name, and a name is what a fix needs`,
      );
    }
    if (row.stack !== undefined && got.offenders[0].atStack.length !== row.stack) {
      return bad(
        `TEETH ${row.id}: at-stack depth ${got.offenders[0].atStack.length}, expected ${row.stack} ` +
          '— the offending at-rule is deliberately NOT the outermost one',
      );
    }
    teeth++;
  }

  // e9 GOOD: a CSS COMMENT naming the property inside the guard is not a declaration.
  const e9 = findMotionCustomProps(
    '@media (prefers-reduced-motion: reduce){' +
      CSS_OPEN +
      ' --mr-reduce documented here ' +
      CSS_CLOSE +
      '.hp-fill{transition:none}}',
  );
  if (e9.motionScopedRules !== 1 || e9.offenders.length !== 0) {
    return bad(
      'TEETH e9: a CSS comment naming a custom property inside the guard was read as a ' +
        'declaration — the scan is not comment-stripping before it parses',
    );
  }
  teeth++;

  // The three shapes that must be REFUSED rather than answered. A green verdict over an
  // un-parseable input is the worst outcome available, so each is pinned to its own message.
  const cssThrowTeeth = [
    { id: 'e5', css: ':root{@media (prefers-reduced-motion:reduce){--mr-reduce:1}}', needle: 'nests an at-rule' },
    { id: 'e12', css: '@import url("x.css");.a{color:red}', needle: 'at-import' },
    { id: 'e15', css: '.icon{background:url(' + CSS_OPEN + ')}', needle: 'url()' },
  ];
  for (const row of cssThrowTeeth) {
    let threw = '';
    try {
      findMotionCustomProps(row.css);
    } catch (e) {
      threw = e.message;
    }
    if (threw === '') {
      return bad(
        `TEETH ${row.id}: an un-scannable shape returned a verdict instead of throwing — this ` +
          'fixture is the one that separates a correct scan from the naive custom-property ban',
      );
    }
    if (threw.indexOf(row.needle) === -1) {
      return bad(
        `TEETH ${row.id}: threw, but not for the pinned reason (wanted '${row.needle}', got: ` +
          `${threw}) — a throw for an unrelated reason is not proof this axis is covered`,
      );
    }
    teeth++;
  }

  // ---- rb-17 [A11Y-RM2f] read-back teeth ------------------------------------------------
  const readBackTeeth = [
    { id: 'f1', src: "const v = getComputedStyle(el).getPropertyValue('--mr-reduce');", want: ['getComputedStyle', 'getPropertyValue'] },
    { id: 'f2', src: 'const r = document.styleSheets[0].cssRules;', want: ['styleSheets', 'cssRules'] },
    { id: 'f3', src: 'const m = el.computedStyleMap();', want: ['computedStyleMap'] },
    { id: 'f4', src: "el.style.transition = 'none';", want: [] },
    { id: 'f5', src: 'const getComputedStyleCache = new Map();', want: [] },
    { id: 'f6a', src: 'read getComputedStyle which needs Playwright', want: ['getComputedStyle'] },
    { id: 'f7', src: "el.addEventListener('transitionrun', () => {});", want: ['transitionrun'] },
    { id: 'f8', src: 'document.getAnimations();', want: ['getAnimations'] },
  ];
  for (const row of readBackTeeth) {
    const got = findReadBackApis(row.src).slice().sort();
    if (got.join('|') !== row.want.slice().sort().join('|')) {
      return bad(
        `TEETH ${row.id}: found [${got.join(', ')}], expected [${row.want.join(', ')}] — f2/f3 ` +
          'kill a getComputedStyle-only ban, f7/f8 kill a CSSOM-only ban (the event channel needs ' +
          'no read API at all), and f4/f5 are the false-RED shapes that would get the clause deleted',
      );
    }
    teeth++;
  }

  // f9: the token roster is frozen and complete. A future edit that quietly drops one EVENT token
  // leaves f1-f5 green, so the roster gets its own tooth.
  if (!Object.isFrozen(READ_BACK_TOKENS) || READ_BACK_TOKENS.length !== 15) {
    return bad(
      `TEETH f9: the read-back roster is ${READ_BACK_TOKENS.length} token(s) and frozen=` +
        `${Object.isFrozen(READ_BACK_TOKENS)} — it must be fifteen and frozen; shortening it is ` +
        'the cheapest way to make this clause pass',
    );
  }
  teeth++;

  // ---- rb-17 census-predicate teeth ------------------------------------------------------
  if (!Object.isFrozen(MOTION_CENSUS_EXTS) || MOTION_CENSUS_EXTS.join('|') !== '.ts|.tsx|.js|.mjs|.cjs') {
    return bad('TEETH g0: MOTION_CENSUS_EXTS is not the frozen five-extension roster');
  }
  teeth++;
  if (!isCensusSource('ui/x.js')) {
    return bad('TEETH g1: a .js module was not census source — the extension roster is not consulted');
  }
  teeth++;
  if (!isCensusSource('module_bindings/index.ts')) {
    return bad(
      'TEETH g2: a module_bindings path was excluded by the PATH predicate — that re-introduces ' +
        'the 65-file gap rb-17 exists to close, one layer below the walker',
    );
  }
  teeth++;
  if (isCensusSource('foo.test.ts.bak') || isCensusSpec('foo.test.ts.bak')) {
    return bad('TEETH g3: a .bak file cleared the extension gate — the ext test is not endsWith');
  }
  teeth++;
  if (!isCensusSource('ui/foo.test.ts.bak.ts')) {
    return bad(
      'TEETH g3b: a production module whose NAME contains .test.ts was excluded — an includes-based ' +
        'suffix exemption is how disguised production code ships past a source scan',
    );
  }
  teeth++;
  if (!isCensusSpec('ui/x.test.tsx') || isCensusSource('ui/x.test.tsx')) {
    return bad('TEETH g4: a .test.tsx file was not classified as a spec (and only a spec)');
  }
  teeth++;
  if (isCensusSource('indexShell.test.ts') || !isCensusSpec('indexShell.test.ts')) {
    return bad(
      'TEETH g7: indexShell.test.ts was not classified as a spec — it names getComputedStyle in a ' +
        'comment, so running the read-back clause over the spec census reds on merge',
    );
  }
  teeth++;
  const g5fwd = censusDifference(['z.ts', 'module_bindings/m.ts', 'module_bindings/a.ts'], ['z.ts']);
  const g5rev = censusDifference(['a.ts'], ['a.ts', 'module_bindings/x.ts']);
  if (g5fwd.join('|') !== 'module_bindings/a.ts|module_bindings/m.ts' || g5rev.length !== 0) {
    return bad(
      `TEETH g5: censusDifference returned [${g5fwd.join(', ')}] / [${g5rev.join(', ')}] — it must ` +
        'be a SORTED one-way set difference; a symmetric difference reports the same paths in both ' +
        'directions and makes the two-way ratchet unable to tell the tiers apart',
    );
  }
  teeth++;

  // ==================================================================
  // REAL TREE
  // ==================================================================
  let files;
  try {
    files = listMotionCensusFiles(CLIENT_SRC);
  } catch (e) {
    return bad(`could not walk ${CLIENT_SRC}: ${e.message}`);
  }
  // ANTI-VACUITY FLOOR — a mistyped root walks nothing and passes forever. Raised 40 -> 120 with
  // the rb-17 widening: the census now includes `module_bindings`, so 157 files is the live number
  // and a floor still calibrated to the old 92-file roster would absorb the whole regression.
  if (files.length < 120) {
    return bad(
      `VACUITY FLOOR: found only ${files.length} non-test bundled modules under ${CLIENT_SRC}, ` +
        'expected at least 120 — a zero-reader pass over a mistyped walk root looks exactly like ' +
        'a clean tree',
    );
  }
  for (const required of [MOTION_OWNER, RESOLVER]) {
    if (!files.includes(required)) {
      return bad(
        `VACUITY FLOOR: ${required} is not among the walked files — the ownership rule is pinned ` +
          'to a module that no longer exists',
      );
    }
  }

  const sources = {};
  for (const rel of files) {
    try {
      sources[rel] = readFileSync(`${CLIENT_SRC}/${rel}`, 'utf8');
    } catch (e) {
      return bad(`could not read ${CLIENT_SRC}/${rel}: ${e.message}`);
    }
  }

  const readers = findMotionReaders(sources);
  const intruders = readers.filter((p) => p !== MOTION_OWNER);
  if (intruders.length > 0) {
    return bad(
      `[A11Y-RM2a] non-test client/src modules other than ${MOTION_OWNER} reference the motion ` +
        `preference: ${intruders.join(', ')} — the preference is INJECTED as ` +
        'ResolveInput.reduceMotion (M23 §2.5); a second reader makes the render path impure',
    );
  }
  // [A11Y-RM2b]: the owner must reference it in CODE, not merely document it — otherwise "sole
  // owner" is a claim about a module that owns nothing while the real call hides elsewhere.
  if (!MOTION_TOKENS.some((t) => stripTsComments(sources[MOTION_OWNER]).indexOf(t) !== -1)) {
    return bad(
      `[A11Y-RM2b] ${MOTION_OWNER} names the motion preference only in comments — the sole-owner ` +
        'claim must be backed by a real reference in code',
    );
  }

  const resolverGlobals = bannedGlobalsIn(sources[RESOLVER]);
  if (resolverGlobals.length > 0) {
    return bad(
      `[A11Y-RM2] ${RESOLVER} references browser global(s): ${resolverGlobals.join(', ')} — the ` +
        'resolver must be a pure function of ResolveInput, which is what the prediction-parity, ' +
        'movement-parity, netcode-determinism and netcode-convergence evals rely on',
    );
  }

  const outOfTree = {};
  for (const path of OUT_OF_TREE) {
    try {
      outOfTree[path] = readFileSync(path, 'utf8');
    } catch (e) {
      return bad(`[A11Y-RM2c] could not read ${path}: ${e.message}`);
    }
  }
  const escapes = findOutOfTreeMotionReads(outOfTree);
  if (escapes.length > 0) {
    return bad(
      `[A11Y-RM2c] out-of-tree motion read(s) in ${escapes.join(', ')} — these files are client ` +
        'entry points OUTSIDE client/src, so the in-tree census (motionPreference.test.ts:283) ' +
        'structurally cannot see them; a read here bypasses the injected reduceMotion seam',
    );
  }

  const inertPins = findInertPins((f) => readFileSync(f, 'utf8'), MOTION_DELEGATIONS);
  if (inertPins.length > 0) {
    return bad(`[A11Y-RM2d] DELEGATION PIN INERT: ${inertPins.join(' | ')}`);
  }
  const inert = findInertDelegations((f) => readFileSync(f, 'utf8'), MOTION_DELEGATIONS);
  if (inert.length > 0) {
    return bad(`[A11Y-RM2d] delegation pin failures: ${inert.join(' | ')}`);
  }
  let viteSrc;
  try {
    viteSrc = readFileSync(VITE_CONFIG, 'utf8');
  } catch (e) {
    return bad(`[A11Y-RM2d] could not read ${VITE_CONFIG}: ${e.message}`);
  }
  if (!includeSelectsTests(viteSrc)) {
    return bad(
      `[A11Y-RM2d] REACHABILITY: ${VITE_CONFIG}'s test.include no longer selects ` +
        "'src/**/*.test.ts', so the delegated S7T-SCAN is un-run while its pin stays green",
    );
  }

  // ==================================================================
  // [A11Y-RM2g] — the two-way census ratchet (R-m23-s10-RMEXT).
  //
  // Two walkers cover `client/src` and they are DELIBERATELY unequal: the shared one skips
  // generated bindings for its own clause's reasons, this file's does not. Unequal is fine;
  // unequal-and-unchecked is how a tier silently shrinks. So the difference is pinned by NAME in
  // both directions, and pinned to be NON-EMPTY — deleting `module_bindings` is an event that
  // deserves a decision, not a quietly smaller scan.
  // ==================================================================
  let sharedFiles;
  try {
    sharedFiles = listClientSourceFiles(CLIENT_SRC);
  } catch (e) {
    return bad(`[A11Y-RM2g] could not walk ${CLIENT_SRC} with the shared walker: ${e.message}`);
  }
  const censusOnly = censusDifference(files, sharedFiles);
  const sharedOnly = censusDifference(sharedFiles, files);
  if (sharedOnly.length > 0) {
    return bad(
      `[A11Y-RM2g] the shared walker selects file(s) this census does not: ${sharedOnly.join(', ')}` +
        ' — the motion census must be a strict SUPERSET of it, or rb-17 silently reopened the gap',
    );
  }
  const strays = censusOnly.filter((rel) => !rel.startsWith(GENERATED_DIR));
  if (strays.length > 0) {
    return bad(
      `[A11Y-RM2g] this census selects file(s) outside ${GENERATED_DIR} that the shared walker ` +
        `does not: ${strays.join(', ')} — the ONLY sanctioned difference between the two tiers is ` +
        'the generated bindings directory; any other drift means one of the walkers changed',
    );
  }
  if (censusOnly.length < 20) {
    return bad(
      `[A11Y-RM2g] only ${censusOnly.length} generated module(s) separate the two walkers — the ` +
        'difference is the whole reason this census exists, so an empty or near-empty one means ' +
        'either the bindings are gone or this walker stopped descending into them',
    );
  }

  // ==================================================================
  // [A11Y-RM2f] — the READ end of the CSS channel, over the SOURCE census only.
  // ==================================================================
  const readBacks = [];
  for (const rel of files) {
    const found = findReadBackApis(sources[rel]);
    if (found.length > 0) readBacks.push(`${rel} (${found.join(', ')})`);
  }
  if (readBacks.length > 0) {
    return bad(
      `[A11Y-RM2f] client/src module(s) name a CSS read-back or motion-event API: ` +
        `${readBacks.join(' | ')} — these are the ways a module learns the motion preference from ` +
        'the stylesheet instead of from the injected ResolveInput.reduceMotion seam, and none of ' +
        'them names a motion token, so the reader census above cannot see them',
    );
  }

  // ==================================================================
  // [A11Y-RM2e] — the WRITE end: no custom property inside a motion-scoped at-rule.
  // ==================================================================
  let cssFiles;
  try {
    cssFiles = listCssFiles(CLIENT_SRC);
  } catch (e) {
    return bad(`[A11Y-RM2e] could not walk ${CLIENT_SRC} for stylesheets: ${e.message}`);
  }
  if (!cssFiles.includes(STYLES)) {
    return bad(
      `[A11Y-RM2e] ${STYLES} is not among the walked stylesheets (found: ${cssFiles.join(', ')}) ` +
        '— the ban is pinned to a file that no longer exists, so it can never fire again',
    );
  }
  let motionScoped = 0;
  const cssOffenders = [];
  for (const rel of cssFiles) {
    let cssSrc;
    try {
      cssSrc = readFileSync(`${CLIENT_SRC}/${rel}`, 'utf8');
    } catch (e) {
      return bad(`[A11Y-RM2e] could not read ${CLIENT_SRC}/${rel}: ${e.message}`);
    }
    if (rel === STYLES && cssSrc.length < STYLES_MIN_BYTES) {
      return bad(
        `[A11Y-RM2e] ${STYLES} is only ${cssSrc.length} bytes, below the ${STYLES_MIN_BYTES}-byte ` +
          'floor — a truncated stylesheet declares no custom properties either, so a clean verdict ' +
          'over it is indistinguishable from a clean stylesheet',
      );
    }
    // NO try/catch: `findMotionCustomProps` REFUSES un-scannable input, and swallowing that
    // refusal to keep the run green is the single most valuable thing an attacker could do here.
    const verdict = findMotionCustomProps(cssSrc);
    motionScoped += verdict.motionScopedRules;
    for (const off of verdict.offenders) {
      cssOffenders.push(`${rel}: ${off.prop} under ${off.atStack.join(' > ')} in '${off.prelude}'`);
    }
  }
  if (cssOffenders.length > 0) {
    return bad(
      `[A11Y-RM2e] a CSS custom property is declared inside a motion-scoped at-rule: ` +
        `${cssOffenders.join(' | ')} — honouring the preference declaratively is legitimate and ` +
        'intended, but a custom property is not a rendering effect: it is a value JS reads back ' +
        'with getComputedStyle().getPropertyValue(), which re-creates the second preference reader ' +
        'this eval exists to forbid while naming neither motion token',
    );
  }
  // POSITIVE-FIND FLOOR, and the strongest one here. Without it, "no motion at-rules anywhere" and
  // "no violations anywhere" are the same green. If the guard is ever legitimately removed, this
  // floor and the [A11Y-RM3] hp-bar guard clauses retire TOGETHER, in one deliberate decision.
  if (motionScoped < 1) {
    return bad(
      '[A11Y-RM2e] the stylesheet walk found no motion-scoped rule at all — the S9 reduced-motion ' +
        'block is the subject this ban is written against, so its absence makes every verdict ' +
        'above vacuous rather than clean',
    );
  }

  return {
    name,
    pass: true,
    detail:
      `[A11Y-RM2] scanned=${files.length} owners=1 intruders=0 resolverGlobals=0 ` +
      `teeth=${teeth}/${teethTotal}; ` +
      `[A11Y-RM2c] outOfTreeScanned=${OUT_OF_TREE.length} outOfTreeHits=0; ` +
      `[A11Y-RM2d] pins=${MOTION_DELEGATIONS.length}/${MOTION_DELEGATIONS.length} ` +
      `nonInert=${MOTION_DELEGATIONS.length}/${MOTION_DELEGATIONS.length} reachable=Y; ` +
      `[A11Y-RM2e] cssFiles=${cssFiles.length} motionScoped=${motionScoped} customProps=0; ` +
      `[A11Y-RM2f] tokens=${READ_BACK_TOKENS.length} readBacks=0; ` +
      `[A11Y-RM2g] censusOnly=${censusOnly.length} sharedOnly=0`,
  };
}
