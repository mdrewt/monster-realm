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
// NO `main` GUARD (see the manifest eval). `run.mjs` imports the default export.
import { readFileSync } from 'node:fs';
import { listClientSourceFiles, stripCssComments } from './a11y-static-shell.eval.mjs';
import {
  findInertDelegations,
  includeSelectsTests,
  stripTsComments,
} from './overlay-a11y-manifest.eval.mjs';

const CLIENT_SRC = 'client/src';
const VITE_CONFIG = 'client/vite.config.ts';
const MOTION_OWNER = 'render/motionPreference.ts';
const RESOLVER = 'render/renderResolver.ts';

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
    else stripped = stripCssComments(stripHtml(raw));
    if (MOTION_TOKENS.some((t) => stripped.indexOf(t) !== -1)) hits.push(path);
  }
  return hits.sort();
}

/** Remove HTML comments (see the sibling eval's `stripHtmlComments` for the measured reason this
 *  is not optional on `client/index.html`). Kept local so this eval's out-of-tree scan does not
 *  depend on the shell eval's evaluation order. */
function stripHtml(html) {
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

/** The stronger S7 oracle this eval complements rather than replaces. Pinned so that deleting it
 *  is a loud red here — otherwise "we delegate the hard half" quietly becomes "nobody checks it". */
export const MOTION_DELEGATIONS = Object.freeze([
  {
    tag: '[A11Y-RM2d]',
    criterion:
      'A11Y-28 — the in-tree census, with import allow-lists and the disguised-test tripwire',
    file: 'client/src/render/motionPreference.test.ts',
    needles: ['S7T-SCAN'],
  },
]);

export default async function () {
  const name = 'reduced-motion-purity ([A11Y-RM2] matchMedia ownership + the out-of-tree escape)';
  let teeth = 0;
  const teethTotal = 10;
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

  // ==================================================================
  // REAL TREE
  // ==================================================================
  let files;
  try {
    files = listClientSourceFiles(CLIENT_SRC);
  } catch (e) {
    return bad(`could not walk ${CLIENT_SRC}: ${e.message}`);
  }
  // ANTI-VACUITY FLOOR — a mistyped root walks nothing and passes forever.
  if (files.length < 40) {
    return bad(
      `VACUITY FLOOR: found only ${files.length} non-test .ts files under ${CLIENT_SRC}, expected ` +
        'at least 40 — a zero-reader pass over a mistyped walk root looks exactly like a clean tree',
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

  return {
    name,
    pass: true,
    detail:
      `[A11Y-RM2] scanned=${files.length} owners=1 intruders=0 resolverGlobals=0 ` +
      `teeth=${teeth}/${teethTotal}; ` +
      `[A11Y-RM2c] outOfTreeScanned=${OUT_OF_TREE.length} outOfTreeHits=0; ` +
      `[A11Y-RM2d] pins=${MOTION_DELEGATIONS.length}/${MOTION_DELEGATIONS.length} ` +
      `nonInert=${MOTION_DELEGATIONS.length}/${MOTION_DELEGATIONS.length} reachable=Y`,
  };
}
