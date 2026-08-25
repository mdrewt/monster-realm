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
//     `document.body.innerHTML = ''`, and two more. MODULE OWNERSHIP is the property those
//     bypasses cannot dodge: `ui/liveRegion.ts` is the sole owner of the node (its own header says
//     so at `:56`), so no other non-test `client/src` module may name it at all. That is
//     non-vacuous on the shipped tree and it fails on all five spellings at once, because none of
//     them can reach the node without naming it.
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
 * Strip CSS block comments. CSS HAS NO `//` LINE COMMENT, and that is not a pedantic distinction:
 * feeding CSS to the JS/TS scanner in the sibling eval silently truncates every line containing a
 * protocol-relative or `https://` URL, so `background:url(https://cdn/x.png);display:none` loses
 * its `display:none` and the ban it is meant to trip evaporates. Measured. The name collision with
 * the JS stripper is exactly the trap, so this one is named for its language.
 */
export function stripCssComments(src) {
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
    const attrs = m[2];
    const hasAriaLive = /\baria-live\s*=/.test(attrs);
    const implicitRole = /\brole\s*=\s*["'](status|alert|log|timer|marquee)["']/.exec(attrs);
    if (hasAriaLive || implicitRole !== null) {
      regions.push({
        tag: m[1],
        attrs,
        index: m.index,
        via: hasAriaLive ? 'aria-live' : `role=${implicitRole[1]}`,
      });
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
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
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
    needles: ['function srOnlyIsAccessible(', 'srOnlyIsAccessible(readStylesCss())'],
  },
  {
    tag: '[A11Y-07]',
    criterion:
      'A11Y-12 — styles.css contains zero #id selectors (the inline-style pins stay total)',
    file: 'client/src/indexShell.test.ts',
    needles: ['function findIdSelectors(', 'findIdSelectors(css)'],
  },
  {
    tag: '[A11Y-08]',
    criterion: 'A11Y-17 — the canvas is the world region; #app carries no role',
    file: 'client/src/render/world.test.ts',
    needles: ['S4-WORLD-CANVAS-REGION', "app.canvas.setAttribute('role'"],
  },
]);

export default async function () {
  const name = 'a11y-static-shell ([A11Y-05a/05b] live region + [A11Y-06/07/08] delegation)';
  let teeth = 0;
  const teethTotal = 13;
  const bad = (detail) => ({ name, pass: false, detail });

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
  const found = findLiveRegionIntruders(sources);
  if (found.length > 0) {
    return bad(
      `[A11Y-05b] modules other than ${LIVE_REGION_OWNER} name the live region: ${found.join(', ')} ` +
        '— single-module ownership is what makes the node unreachable to a stray replaceChildren, ' +
        'an innerHTML write or a remove(), none of which can act without naming it first',
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
      `nonInert=${SHELL_DELEGATIONS.length}/${SHELL_DELEGATIONS.length} reachable=Y`,
  };
}
