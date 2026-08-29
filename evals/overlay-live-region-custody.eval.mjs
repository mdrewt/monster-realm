// Eval: overlay/live-region custody — the half a vitest DOM test structurally cannot do (rb-11,
// residual R-m23-s2-X5, tag [A11Y-LRC]).
//
// WHAT THIS FILE OWNS, AND WHY IT IS NOT A DOM TEST. `client/src/ui/overlayA11y.test.ts` and
// `client/src/ui/liveRegion.test.ts` prove the RUNTIME behaviour (the node moves, the node comes
// back, the churn guard holds, the announcement channel still works) against a happy-dom fixture.
// Neither can see SOURCE-LEVEL facts:
//   * whether `overlayA11y.ts` still respects `[A11Y-05b]`'s sole-owner rule (it must NAME the
//     live region zero times — the entire reason the custody seam had to live in `ui/liveRegion.ts`
//     instead of `overlayA11y.ts`; see the plan's blocker section);
//   * whether the custodian functions added to `liveRegion.ts` ever slip into writing the node's
//     CONTENT or ATTRIBUTES (W11) rather than only its PARENTAGE;
//   * whether `OpenRecord` actually CAPTURES the release closure (rather than a caller having to
//     re-supply the root at close, which is the rejected adopt/release-PAIR design) and whether
//     `closeOverlayA11y` actually calls it;
//   * whether A11Y-13's `aria-modal` writes and the eleven static shells survived this slice
//     unweakened (X6).
// Each of those is COUNTED here over the WHOLE comment-stripped file, never anchored with a single
// `indexOf` — a first-hit anchor is forgeable (a decoy earlier in the file would satisfy it and
// leave a second, real violation unseen).
//
// `stripTsComments` is REUSED from `./overlay-a11y-manifest.eval.mjs`, the way
// `a11y-static-shell.eval.mjs:60-66` does — a second hand-rolled TS comment stripper in this file
// would be one more implementation to drift from the real one.
//
// NOT AN INERTNESS ORACLE. happy-dom models no aria-modal AT inertness, and neither does this
// file: every clause below is a SOURCE-TEXT or STATIC-MARKUP count, never a claim about what an
// assistive technology would announce or ignore. The behavioural AX-ancestry proof is
// `rb-11.ax-ancestry-probe.mjs` (ledger-time, real Chromium, outside this file's scope — R7 in the
// plan).
//
// NO `main` GUARD — `evals/run.mjs` imports the default export; a module-scope `process.exit()`
// would end the whole run where it stands (measured elsewhere in this repo: 37 of 90 evals ran, 3
// FAILs swallowed, CI green).
import { readFileSync } from 'node:fs';
import { stripTsComments } from './overlay-a11y-manifest.eval.mjs';

const OVERLAY_A11Y_TS = 'client/src/ui/overlayA11y.ts';
const LIVE_REGION_TS = 'client/src/ui/liveRegion.ts';
const INDEX_HTML = 'client/index.html';

/** Both spellings the sole-owner scan at `a11y-static-shell.eval.mjs`'s `[A11Y-05b]` bans from
 *  every non-owner module — `liveRegion.ts:56-60`'s own header names the reason: `LIVE_REGION_ID`
 *  is the exported constant, `'a11y-live'` is the literal string it holds. Kept as a LOCAL copy
 *  rather than imported, so a future edit to the sole-owner scan's own list cannot silently widen
 *  or narrow what THIS file checks. */
const LIVE_REGION_NAMES = Object.freeze(['a11y-live', 'LIVE_REGION_ID']);

const EXPECTED_ARIA_MODAL_SHELLS = 11;
/** The exact shipped spelling, double-quoted, `true`-valued — `client/index.html`'s eleven static
 *  overlay shells and `overlayA11y.ts:107`'s runtime write both use this literal. */
const ARIA_MODAL_TRUE = 'aria-modal="true"';

/** The adopt CALL SITE in `overlayA11y.ts`, pinned verbatim. Counted, never `indexOf`-anchored:
 *  a first-hit anchor is steerable by a planted decoy earlier in the file. */
const ADOPT_CALL = 'releaseLive = adoptLiveRegion(root)';

// Byte floors. A mistyped path, a truncated read, or an emptied file must fail LOUD, never clean.
const OVERLAY_A11Y_MIN_BYTES = 3000;
const LIVE_REGION_MIN_BYTES = 1500;
const INDEX_HTML_MIN_BYTES = 3000;

const T_VACUITY = '[A11Y-LRC/vacuity]';
const T_OWNER = '[A11Y-LRC/owner]';
const T_WRITE = '[A11Y-LRC/custodian-write]';
const T_HANDLE = '[A11Y-LRC/record-handle]';
const T_MODAL = '[A11Y-LRC/aria-modal]';

/**
 * Strip HTML comments before counting anything in `client/index.html`.
 *
 * MEASURED, and it is why this exists: the first shipped draft of this eval counted the RAW file,
 * and rb-11's own explanatory comment on the live region mentions `aria-modal="true"` in prose —
 * so the shell count read 12, not 11, and the eval reported "A11Y-13's static markup was weakened"
 * about a comment. That is the benign direction. The malicious direction is worse and is the real
 * reason to strip: with comments counted, a shell could be DELETED from the markup and the count
 * held at eleven by a decoy mention in a comment. `stripTsComments` is NOT usable here — HTML has
 * no `//` line comment and its block delimiters are different.
 */
function stripHtmlComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('<!--', i);
    if (open === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, open);
    const close = src.indexOf('-->', open + 4);
    // An UNCLOSED comment swallows the rest of the file. Fail loud rather than silently counting
    // zero shells in the tail (the vacuous-green shape).
    if (close === -1) throw new Error('unterminated HTML comment in index.html');
    i = close + 3;
  }
  return out;
}

/** Every index of `needle` in `src`, non-overlapping. Never `indexOf` once — a first-hit anchor is
 *  forgeable (the house rule this repo has been bitten by; see a11y-static-shell.eval.mjs). */
function countOccurrences(src, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** How many times either live-region spelling appears in a (comment-stripped) source string. */
function countLiveRegionNames(stripped) {
  return LIVE_REGION_NAMES.reduce((n, needle) => n + countOccurrences(stripped, needle), 0);
}

function readOrThrow(path, minBytes) {
  const raw = readFileSync(path, 'utf8');
  if (raw.length < minBytes) {
    throw new Error(`${path} is only ${raw.length} bytes (floor ${minBytes}) — truncated read?`);
  }
  return raw;
}

export default async function () {
  const name = 'overlay-live-region-custody ([A11Y-LRC] rb-11 source-level custody pins)';
  const bad = (tag, detail) => ({ name, pass: false, detail: `${tag} ${detail}` });
  let teeth = 0;
  const teethTotal = 17;

  // ==================================================================
  // PROOF-OF-TEETH — the counting utilities, against synthetic fixtures, BEFORE the real files.
  // ==================================================================

  // T1: countOccurrences finds every non-overlapping hit, not just the first.
  if (countOccurrences('aaa', 'a') !== 3) {
    return bad(T_VACUITY, 'TEETH T1: countOccurrences miscounted a trivial repeated needle');
  }
  teeth++;

  // T2: countLiveRegionNames sums BOTH spellings, not just one.
  if (countLiveRegionNames("const x = 'a11y-live'; const y = LIVE_REGION_ID;") !== 2) {
    return bad(T_VACUITY, 'TEETH T2: countLiveRegionNames did not count both spellings');
  }
  teeth++;

  // T3: a decoy naming the live region INSIDE A COMMENT must be stripped before counting —
  // otherwise this file's OWN doc comments above (which name both spellings in prose) would trip
  // the sole-owner scan on themselves.
  const commentDecoy = '// this module must never name a11y-live or LIVE_REGION_ID\nconst z = 1;';
  if (countLiveRegionNames(stripTsComments(commentDecoy)) !== 0) {
    return bad(
      T_VACUITY,
      'TEETH T3: a live-region name inside a COMMENT was counted after stripping — the stripper ' +
        'or the counter is not comment-aware',
    );
  }
  teeth++;

  // T4: a decoy naming the live region in LIVE CODE (not a comment) must still be counted — T3's
  // stripper cannot have been made so aggressive it also eats real code.
  const codeDecoy = "const rogue = document.getElementById('a11y-live');";
  if (countLiveRegionNames(stripTsComments(codeDecoy)) !== 1) {
    return bad(
      T_VACUITY,
      'TEETH T4: a live-region name in EXECUTABLE code was not counted — the owner scan would be ' +
        'vacuously green against a real intruder',
    );
  }
  teeth++;

  // T5: the aria-modal counter counts the EXACT shipped spelling and does not count a near-miss
  // (single-quoted, or a different attribute value).
  const ariaFixture =
    '<div aria-modal="true"></div><div aria-modal=\'true\'></div><div aria-modal="false"></div>' +
    '<div aria-modal="true"></div>';
  if (countOccurrences(ariaFixture, ARIA_MODAL_TRUE) !== 2) {
    return bad(
      T_VACUITY,
      'TEETH T5: the aria-modal="true" counter did not count exactly the two double-quoted, ' +
        'true-valued shells in the fixture',
    );
  }

  // T5b/T5c: the HTML-comment stripper. T5b is the shape that actually bit this eval in CI (a
  // prose mention inflating the count); T5c is the dangerous inverse — a DELETED shell whose
  // count is propped up by a decoy comment, which a raw count would pass.
  teeth += 1;
  const commentedShells =
    '<div aria-modal="true"></div>\n' +
    '<!-- prose: A11Y-13 sets aria-modal="true" on every shell root -->\n' +
    '<div aria-modal="true"></div>';
  if (countOccurrences(stripHtmlComments(commentedShells), ARIA_MODAL_TRUE) !== 2) {
    return fail(
      T_MODAL,
      'TEETH T5b: a prose mention of aria-modal="true" inside an HTML comment was counted as a shell',
      teeth,
    );
  }
  teeth += 1;
  const decoyProp = '<div aria-modal="true"></div>\n' + '<!-- <div aria-modal="true"></div> -->';
  if (countOccurrences(stripHtmlComments(decoyProp), ARIA_MODAL_TRUE) !== 1) {
    return fail(
      T_MODAL,
      'TEETH T5c: a commented-out shell propped up the count — a deleted shell could hide behind it',
      teeth,
    );
  }
  teeth += 1;
  let unterminatedCaught = false;
  try {
    stripHtmlComments('<div aria-modal="true"></div><!-- never closed');
  } catch {
    unterminatedCaught = true;
  }
  if (!unterminatedCaught) {
    return fail(
      T_MODAL,
      'TEETH T5d: an unterminated HTML comment did not throw — it would swallow the file tail',
      teeth,
    );
  }
  teeth++;

  // T6: setAttribute/removeAttribute pins on a synthetic overlayA11y-shaped fixture.
  const ariaWriteFixture =
    "root.setAttribute('role', meta.role);\n" +
    "root.setAttribute('aria-modal', 'true');\n" +
    "root.setAttribute('aria-label', t(meta.labelKey));\n" +
    "record.root.removeAttribute('aria-modal');\n";
  if (
    countOccurrences(ariaWriteFixture, "setAttribute('aria-modal', 'true')") !== 1 ||
    countOccurrences(ariaWriteFixture, "removeAttribute('aria-modal')") !== 1
  ) {
    return bad(
      T_VACUITY,
      'TEETH T6: the aria-modal set/remove pin counters misread a known-good fixture',
    );
  }
  teeth++;

  // T7: the releaseLive-handle pin on a synthetic OpenRecord-shaped fixture — proves the counter
  // can tell "declared + captured + invoked" (>=3 hits) from "declared but never wired" (0 hits
  // on the invocation needle specifically).
  const wiredFixture =
    'interface OpenRecord { readonly releaseLive: () => void; }\n' +
    'const releaseLive = adoptLiveRegion(root);\n' +
    'OPEN_OVERLAYS.set(id, { root, releaseLive });\n' +
    'record.releaseLive();\n';
  const unwiredFixture = 'interface OpenRecord { readonly releaseLive: () => void; }\n';
  if (countOccurrences(wiredFixture, 'releaseLive') < 3) {
    return bad(T_VACUITY, 'TEETH T7a: the releaseLive counter under-counted a fully-wired fixture');
  }
  if (countOccurrences(unwiredFixture, 'record.releaseLive()') !== 0) {
    return bad(
      T_VACUITY,
      'TEETH T7b: the invocation pin matched a fixture that declares but never CALLS releaseLive',
    );
  }
  teeth++;

  // T7c/T7d: the adopt-call-site pin. T7d is the red-team's measured bypass verbatim — a fully
  // handle-shaped module whose open binds a no-op instead of adopting.
  teeth++;
  if (countOccurrences(wiredFixture, ADOPT_CALL) !== 1) {
    return bad(T_VACUITY, 'TEETH T7c: the adopt-call-site pin missed a correctly-wired fixture');
  }
  teeth++;
  const hollowedFixture =
    'interface OpenRecord { readonly releaseLive: () => void; }\n' +
    'const releaseLive = () => {};\n' +
    'OPEN_OVERLAYS.set(id, { root, releaseLive });\n' +
    'record.releaseLive();\n';
  if (countOccurrences(hollowedFixture, ADOPT_CALL) !== 0) {
    return bad(
      T_VACUITY,
      'TEETH T7d: the adopt-call-site pin matched a HOLLOWED open that binds a no-op closure',
    );
  }

  // T8: the custodian-write ban rejects a fixture that writes textContent a SECOND time (the W11
  // shape — a custodian that starts writing content), and accepts the ONE legitimate write.
  const oneWrite = 'node.textContent = pending;';
  const twoWrites =
    'node.textContent = pending;\nfunction adoptLiveRegion(root){ node.textContent = ""; }';
  if (countOccurrences(oneWrite, 'textContent') !== 1) {
    return bad(T_VACUITY, 'TEETH T8a: the textContent counter misread a single legitimate write');
  }
  if (countOccurrences(twoWrites, 'textContent') === 1) {
    return bad(
      T_VACUITY,
      'TEETH T8b: the textContent counter did not distinguish a SECOND write (W11: the ' +
        'custodian starts writing content) from the one legitimate #maybeEmit sink',
    );
  }
  teeth++;

  // ==================================================================
  // THE REAL FILES.
  // ==================================================================

  let overlayA11ySrc;
  let liveRegionSrc;
  let indexHtmlSrc;
  try {
    overlayA11ySrc = readOrThrow(OVERLAY_A11Y_TS, OVERLAY_A11Y_MIN_BYTES);
    liveRegionSrc = readOrThrow(LIVE_REGION_TS, LIVE_REGION_MIN_BYTES);
    indexHtmlSrc = readOrThrow(INDEX_HTML, INDEX_HTML_MIN_BYTES);
  } catch (e) {
    return bad(T_VACUITY, `could not read a required file: ${e.message}`);
  }

  // (a) [A11Y-05b]'s bounded claim (X8): overlayA11y.ts must NAME the live region ZERO times —
  // COUNTED over the whole file, not indexOf'd once. This is the entire reason the custody seam
  // had to live in liveRegion.ts (the declared sole owner) instead of overlayA11y.ts.
  const overlayA11yStripped = stripTsComments(overlayA11ySrc);
  const intrusionCount = countLiveRegionNames(overlayA11yStripped);
  if (intrusionCount !== 0) {
    return bad(
      T_OWNER,
      `overlayA11y.ts's comment-stripped source names the live region ${intrusionCount} time(s) ` +
        `(spellings checked: ${LIVE_REGION_NAMES.join(', ')}) — [A11Y-05b]'s sole-owner rule is ` +
        'violated the moment overlayA11y.ts knows the node by id or by LIVE_REGION_ID',
    );
  }
  teeth++;

  // (b) liveRegion.ts: adoptLiveRegion exists, and the custody functions never write the node's
  // content or attributes — no innerHTML, no .setAttribute(, and EXACTLY ONE `textContent`
  // occurrence (the pre-existing #maybeEmit sink; a custodian that writes content is a SECOND
  // occurrence appearing anywhere else in the file — W11).
  const liveRegionStripped = stripTsComments(liveRegionSrc);
  if (countOccurrences(liveRegionStripped, 'adoptLiveRegion') < 1) {
    return bad(T_WRITE, 'liveRegion.ts does not declare adoptLiveRegion anywhere');
  }
  const innerHtmlCount = countOccurrences(liveRegionStripped, '.innerHTML');
  const setAttributeCount = countOccurrences(liveRegionStripped, '.setAttribute(');
  const textContentCount = countOccurrences(liveRegionStripped, 'textContent');
  if (innerHtmlCount !== 0) {
    return bad(T_WRITE, `liveRegion.ts contains ${innerHtmlCount} .innerHTML write(s) — KILLS W11`);
  }
  if (setAttributeCount !== 0) {
    return bad(
      T_WRITE,
      `liveRegion.ts contains ${setAttributeCount} .setAttribute( call(s) — the custody move ` +
        'must never touch attributes, only parentage — KILLS W11',
    );
  }
  if (textContentCount !== 1) {
    return bad(
      T_WRITE,
      `liveRegion.ts's comment-stripped source contains ${textContentCount} occurrence(s) of ` +
        "'textContent', not the ONE legitimate #maybeEmit sink — a custodian that writes " +
        'content is W11',
    );
  }
  teeth++;

  // (c) overlayA11y.ts's OpenRecord declares the release handle (proving the closure is CAPTURED
  // at open time, not re-resolved at close), and closeOverlayA11y actually INVOKES it.
  const releaseLiveCount = countOccurrences(overlayA11yStripped, 'releaseLive');
  if (releaseLiveCount < 3) {
    return bad(
      T_HANDLE,
      `overlayA11y.ts's comment-stripped source mentions 'releaseLive' only ${releaseLiveCount} ` +
        'time(s) — the OpenRecord field, the open-time capture, and the close-time invocation ' +
        'are each a distinct occurrence; fewer than three means one of them is missing',
    );
  }
  if (countOccurrences(overlayA11yStripped, 'record.releaseLive()') !== 1) {
    return bad(
      T_HANDLE,
      "overlayA11y.ts's closeOverlayA11y does not call 'record.releaseLive()' — a declared-but-" +
        "unwired handle leaves the live region stranded in every closed overlay's root forever",
    );
  }
  // RED-TEAM MEASURED BYPASS, and this clause is the fix. The three checks above are all about the
  // HANDLE, and a hollowed `openOverlayA11y` that drops the import and writes
  // `const releaseLive = () => {};` keeps every one of them green: the field is still declared, the
  // capture still reads as a capture, and the close still invokes it — while the live region is
  // never adopted at all. Only the ADOPT CALL SITE distinguishes the two, so pin it directly.
  if (countOccurrences(overlayA11yStripped, ADOPT_CALL) !== 1) {
    return bad(
      T_HANDLE,
      `overlayA11y.ts does not contain exactly one '${ADOPT_CALL}' — a hollowed open that binds a ` +
        'no-op closure satisfies every other handle pin while the region is never moved',
    );
  }
  teeth++;

  // (d) X6 — A11Y-13 not weakened: the eleven static shells keep aria-modal="true" in markup, and
  // overlayA11y.ts still SETS it at open and REMOVES it at close.
  const ariaModalShellCount = countOccurrences(stripHtmlComments(indexHtmlSrc), ARIA_MODAL_TRUE);
  if (ariaModalShellCount !== EXPECTED_ARIA_MODAL_SHELLS) {
    return bad(
      T_MODAL,
      `client/index.html contains ${ariaModalShellCount} '${ARIA_MODAL_TRUE}' shell(s), not the ` +
        `expected ${EXPECTED_ARIA_MODAL_SHELLS} — A11Y-13's static markup was weakened by this slice`,
    );
  }
  const setsAriaModal =
    countOccurrences(overlayA11yStripped, "setAttribute('aria-modal', 'true')") === 1;
  const removesAriaModal =
    countOccurrences(overlayA11yStripped, "removeAttribute('aria-modal')") === 1;
  if (!setsAriaModal || !removesAriaModal) {
    return bad(
      T_MODAL,
      `overlayA11y.ts no longer both sets (${setsAriaModal}) and removes (${removesAriaModal}) ` +
        "aria-modal exactly once each — A11Y-13's runtime writes were weakened by this slice",
    );
  }
  teeth++;

  return {
    name,
    pass: true,
    detail:
      `ariaModalShells=${ariaModalShellCount} ariaModalUnmodified=OK teeth=${teeth}/${teethTotal} ` +
      `liveRegionIntrusions=${intrusionCount} releaseLiveOccurrences=${releaseLiveCount} ` +
      `textContentOccurrencesInLiveRegion=${textContentCount}`,
  };
}
