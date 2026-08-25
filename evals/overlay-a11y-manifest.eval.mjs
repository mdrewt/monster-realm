// Eval: the overlay a11y MANIFEST gate (M23 §5.1, slice m23-s10).
//
// TWO HALVES, AND THEY ARE DELIBERATELY UNEQUAL.
//
// HALF ONE — `[A11Y-15]`, the only tag in §5.1 with no shipped oracle. The invariant: the single
// deferred focus lives in `client/src/ui/overlayA11y.ts` alone, so no `client/src/ui/*View.ts` may
// call focus itself (M23 §2.2, criterion A11Y-15). Today that invariant is gated by THREE
// HAND-KEPT FILE LISTS — `renameView.test.ts:501` (ten files), `renameView.test.ts:1300` (five),
// `menuView.test.ts:1755` (one). `client/src/ui/` holds EIGHTEEN `*View.ts` files, and
// `errorOverlayView.ts` and `sessionView.ts` are in NONE of them. That measured gap is what this
// eval exists to close: the roster is `readdir`-DERIVED, so a new view is scanned the day it
// lands, and two-way-ratcheted against KNOWN_VIEW_FILES so a rename or deletion is a loud red
// rather than a silent shrink.
//
// HALF TWO — `[A11Y-01]`–`[A11Y-04]` are DELEGATED, not re-implemented, and that is a deliberate
// reversal of §5.1's letter. Measured, twice, independently:
//   * `justfile:491` is `ci: lint typecheck test eval security wasm client-typecheck client-test
//     observability-validate`. There is NO CI surface that runs `just eval` but not
//     `just client-test`, so moving a check to this tier adds ZERO coverage — only a second
//     implementation to keep in agreement.
//   * All four already ship at an equal-or-STRONGER tier: `[A11Y-01]` is a real NEGATIVE TSC
//     COMPILE (`overlayRegistry.test.ts:1160`), which no textual union parse can beat.
//   * Every naive re-implementation measured WEAKER. Three of five plausible `OverlayId`-union
//     parsers are wrong on the real file: a comment-blind "scan to the first `;`" truncates the
//     union at fifteen and DROPS `claimView`, because the union body at `overlayRegistry.ts:51-53`
//     contains a comment reading `…breaks decide(); D17…`. And the natural fix for that
//     (`.endsWith('View')`) is green-and-wrong: a seventeenth member added to the union alone,
//     with no table entry, sails through.
//   * §5.1's own `[A11Y-02]` regex `/^a11y\.[a-z0-9.]+$/` REJECTS ALL SIXTEEN shipped keys — they
//     are `a11y.overlay.boxView.title`, capital V, mandated by `ui/a11yCopy.ts:14-17` and by
//     ADR-0205 D5, which instructs this slice BY NAME that "its [A11Y-02] regex must permit
//     uppercase … or it reds on sixteen valid keys". The dangerous fix is `/^a11y\..+$/`, which
//     then admits `a11y..`, `a11y.....` AND `a11y.count.{n}` — dissolving the ICU ban it was
//     written to enforce. `overlayRegistry.test.ts:1332` already ships the correct SHAPE_RE and
//     records that measurement in-source.
//
// So the delegation is not laziness, and it is not a silent omission: it is `findInertDelegations`,
// which every CI run proves is not theatre. See its doc comment for the four failure conditions.
//
// DECLARED RESIDUAL R-m23-s10-CSSDRIFT (recorded on the sibling eval too): a pin proves the
// delegate EXISTS, is INVOKED ON THE REAL ARTEFACT, and is REACHABLE BY CI. It does not prove the
// delegate's semantics; those are gated by that file's own inline BAD/GOOD proofs. Consolidating
// the two tiers into one imported module is deferred (X18 in the slice ledger) because it needs
// `client/src/indexShell.test.ts`, which is slice S2's file.
//
// NO `main` GUARD, ON PURPOSE: a `dirname`/`endsWith` guard on an eval file exits `evals/run.mjs`
// mid-loop at code 0 and swallows every later eval. `run.mjs` imports the default export.
import { readdirSync, readFileSync } from 'node:fs';

const UI_DIR = 'client/src/ui';
const VITE_CONFIG = 'client/vite.config.ts';

/**
 * The sanctioned `client/src/ui/*View.ts` roster, paired with a declaration that MUST survive
 * stripping. The pairing is the anti-vacuity guard `renameView.test.ts:376` established: a
 * stripper that fell into an unterminated string or comment state would eat the rest of the file,
 * report zero focus calls and look green — so every file must still contain its own declaration
 * after stripping.
 *
 * `errorOverlayView.ts` and `sessionView.ts` are here because they are in NO shipped list. They
 * are not registry members (`errorOverlayView` is F8-dismissed and non-blocking;
 * `sessionView` is driven by `conn.sessionState()`, see `overlayRegistry.ts:44-49`) — but
 * A11Y-15 is a rule about FILES, not about `OverlayId` membership, so their exclusion was a gap
 * rather than a decision.
 */
export const KNOWN_VIEW_FILES = Object.freeze([
  ['battleView.ts', 'export class BattleView'],
  ['boxView.ts', 'export class BoxView'],
  ['claimView.ts', 'export class ClaimView'],
  ['dialogueView.ts', 'export class DialogueView'],
  ['errorOverlayView.ts', 'export class ErrorOverlayView'],
  ['evolutionView.ts', 'export class EvolutionView'],
  ['healView.ts', 'export class HealView'],
  ['helpView.ts', 'export class HelpView'],
  ['leaderboardView.ts', 'export class LeaderboardView'],
  ['menuView.ts', 'export class MenuView'],
  ['pvpView.ts', 'export class PvpView'],
  ['questLogView.ts', 'export class QuestLogView'],
  ['raisingView.ts', 'export class RaisingView'],
  ['renameView.ts', 'export class RenameView'],
  ['sessionView.ts', 'export class SessionView'],
  ['shopView.ts', 'export class ShopView'],
  ['tradeProposeView.ts', 'export class TradeProposeView'],
  ['tradeView.ts', 'export class TradeView'],
]);

/**
 * The focus-call spellings this scan recognises. §5.1 names only the literal `.focus(`; red-team
 * measured that SEVEN of nine realistic bypasses survive that literal even when comment- and
 * string-stripping are perfect. Each entry below is one of them, and each is a LITERAL RegExp —
 * never `new RegExp(...)`, which Semgrep's `detect-non-literal-regexp` flags in remote CI where
 * `just ci` runs no Semgrep at all.
 *
 * `\bfocus\b` is what keeps this from firing on the legitimate neighbours that ship today —
 * `initialFocusSelector`, `focusTrap`, `focusables`, `openOverlayA11y`'s `deferred focus` prose —
 * because a following word character defeats the trailing boundary.
 */
export const FOCUS_SPELLINGS = Object.freeze([
  // `el.focus()`, and `el . focus()` with any whitespace between. Also covers a BARE reference
  // (`const f = el.focus;`) because the call parens are not required.
  { tag: 'member', re: /\.\s*focus\b/ },
  // `el?.focus?.()` — optional chaining puts a `?` where the scan above expects `.`.
  { tag: 'optional-chain', re: /\?\.\s*focus\b/ },
  // `el['focus']()` / `el["focus"]()` — computed member access. Runs on the COMMENT-stripped
  // source (strings intact) because the key lives inside a string literal.
  { tag: 'computed-single', re: /\[\s*'focus'\s*\]/ },
  { tag: 'computed-double', re: /\[\s*"focus"\s*\]/ },
  // `HTMLElement.prototype.focus.call(el)` — caught by `member` too, but named separately so the
  // failure detail tells the reader WHICH bypass shipped.
  { tag: 'prototype', re: /prototype\s*\.\s*focus\b/ },
  // `el.setAttribute('autofocus', …)` / a rendered `autofocus` attribute: the browser moves focus
  // with no focus call at all, which is the same defect by a different mechanism.
  { tag: 'autofocus', re: /autofocus/ },
  // `const k = 'foc' + 'us'; el[k]()` — the computed-string bypass. Not decidable statically, so
  // the scan fails LOUD on the concatenation shape rather than passing it, per §5.4's declared
  // "fail loud on an un-parseable shape" default.
  { tag: 'computed-string', re: /'foc'\s*\+|"foc"\s*\+/ },
]);

/**
 * Strip JS/TS comments, leaving all string contents UNTOUCHED.
 *
 * A quote-aware CHARACTER SCANNER, not a regex — `evals/dom-shell-coverage-exclusion.eval.mjs:91`
 * records why (a regex block-comment stripper treats the `/*` inside a glob string as an opener
 * and mangles the string). There is a sharper reason here: a regex literal containing a quote
 * drives a naive stripper into string state and swallows the next line of REAL code. A red-team
 * shipped seven duplicate deferred focus calls at full green through exactly that hole; the
 * divergence tooth below is the countermeasure.
 *
 * States: normal | line | block | sq | dq | tl.
 */
export function stripTsComments(src) {
  return scan(src, false);
}

/**
 * Strip comments AND the CONTENTS of every string/template literal (the delimiters survive, so
 * `'focus'` becomes `''`). Used only for the divergence tooth: a focus call hiding in a string is
 * not a call, but a stripper that mis-tracks state produces DIFFERENT counts across the two modes,
 * and that disagreement is the signal.
 */
export function stripTsCommentsAndStrings(src) {
  return scan(src, true);
}

function scan(src, dropStringBodies) {
  let out = '';
  let i = 0;
  const len = src.length;
  let state = 'normal';

  while (i < len) {
    const ch = src[i];
    const next = i + 1 < len ? src[i + 1] : '';

    if (state === 'normal') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
      } else if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'tl';
        out += ch;
        i++;
      } else {
        out += ch;
        i++;
      }
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        out += '\n';
        state = 'normal';
      }
      i++;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        i += 2;
      } else {
        // Keep newlines so line numbers in a failure detail stay usable.
        if (ch === '\n') out += '\n';
        i++;
      }
      continue;
    }
    // In a string/template. Backslash escapes are honoured so `\'` cannot close it early.
    const closer = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (ch === '\\' && i + 1 < len) {
      if (!dropStringBodies) out += ch + src[i + 1];
      i += 2;
      continue;
    }
    if (ch === closer) {
      out += ch;
      state = 'normal';
      i++;
      continue;
    }
    if (!dropStringBodies) out += ch;
    else if (ch === '\n') out += '\n';
    i++;
  }
  return out;
}

/**
 * Which FOCUS_SPELLINGS appear in `src`, as `{ tag, line }` records. `src` must already be
 * stripped; passing raw source false-REDs on FIVE real files today (`battleView.ts:26`,
 * `boxView.ts:26`, `raisingView.ts:27`, `evolutionView.ts:37`, `claimView.ts:27` each name
 * `.focus()` in a header comment explaining why the call moved to `overlayA11y.ts`).
 */
export function findFocusCallSites(src) {
  const hits = [];
  const lines = src.split('\n');
  for (let n = 0; n < lines.length; n++) {
    for (const spelling of FOCUS_SPELLINGS) {
      if (spelling.re.test(lines[n])) hits.push({ tag: spelling.tag, line: n + 1 });
    }
  }
  return hits;
}

/**
 * The `client/src/ui/*View.ts` files actually on disk, sorted.
 *
 * `endsWith('View.ts')` already excludes `*View.test.ts` (`'battleView.test.ts'.endsWith('View.ts')`
 * is FALSE), so §5.1's second GOOD fixture — "a `*View.test.ts` that asserts on focus must PASS" —
 * passes because the file was never in scope, not because any exemption logic ran. The explicit
 * `.test.ts` rejection below is therefore REDUNDANT BY CONSTRUCTION and kept as defence in depth
 * against a future suffix change; `.endsWith`, never `.includes`, because `.includes('.test.ts')`
 * admits `foo.test.ts.bak` and a `x.test.ts/`-named directory.
 */
export function discoverViewFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('View.ts') && !f.endsWith('.test.ts'))
    .sort();
}

/** Roster entries absent from disk — a renamed or deleted view. */
export function findMissingViewFiles(discovered, known) {
  const seen = new Set(discovered);
  return known.filter(([f]) => !seen.has(f)).map(([f]) => f);
}

/** Files on disk absent from the roster — a NEW view. Not fatal for the scan (it is readdir-driven,
 *  so the new file IS scanned), but fatal for the roster, whose declaration pairs are what keep the
 *  stripper honest. */
export function findUnsanctionedViewFiles(discovered, known) {
  const sanctioned = new Set(known.map(([f]) => f));
  return discovered.filter((f) => !sanctioned.has(f));
}

/**
 * The delegation table for `[A11Y-01]`–`[A11Y-04]`. Each entry names the criterion, the shipped
 * delegate, and the needles whose presence proves the delegate both EXISTS and RUNS AGAINST THE
 * REAL ARTEFACT rather than a fixture.
 */
export const MANIFEST_DELEGATIONS = Object.freeze([
  {
    tag: '[A11Y-01]',
    criterion: 'A11Y-1 — OverlayId <-> OVERLAY_A11Y totality, both directions',
    file: 'client/src/ui/overlayRegistry.test.ts',
    needles: ['OR-A11Y-TOTALITY-COMPILE', 'stowawayInA11y', 'missingFromA11y'],
  },
  {
    tag: '[A11Y-02]',
    criterion: 'A11Y-3 — labelKey non-empty, unique, brace-free, segment-shaped (ICU ban)',
    file: 'client/src/ui/overlayRegistry.test.ts',
    needles: ['OR-A11Y-LABELKEY-SHAPE'],
  },
  {
    tag: '[A11Y-03]',
    criterion: 'A11Y-5 — dismissible read from OVERLAY_TIERS, never a hand-kept id list',
    file: 'client/src/ui/overlayRegistry.test.ts',
    needles: ['OR-A11Y-DISMISSIBLE-VS-TIER', 'OVERLAY_TIERS[id]'],
  },
  {
    tag: '[A11Y-04]',
    criterion: 'A11Y-4 — labelKey <-> a11yCopy both directions, prefix-scoped to a11y.overlay.*',
    file: 'client/src/ui/a11yCopy.test.ts',
    needles: ['A11YCOPY-OVERLAY-NAMESPACE-EXACT'],
  },
]);

/**
 * Evaluate a delegation table. A pin FAILS, with a distinguishable reason, when any of:
 *
 *  1. ABSENT — a needle is missing from the COMMENT-STRIPPED delegate. Stripping is the point: a
 *     decoy comment naming the test would satisfy a raw scan, and "declaration pins are forgeable
 *     by a planted string" is a measured finding in this repo.
 *  2. INERT — deleting the needle from an in-memory copy of the REAL delegate does not make this
 *     same predicate fail. A pin that cannot fail is a gate that prints PASS while proving
 *     nothing, which is the exact shape behind "every gate PASSes yet the ledger reports 0/N met".
 *     This is a proof-of-teeth executed against the live artefact on every CI run, not a fixture
 *     that can rot out of date.
 *  3. UNREADABLE — the delegate file is gone. Never swallowed: a `catch { continue }` here would
 *     make deleting the delegate the easiest way to go green.
 *  4. EMPTY — the delegate has no `describe(` after stripping, i.e. it was gutted to a shell.
 *
 * REACHABILITY is checked once, separately, by `includeSelectsTests` — none of the four conditions
 * above notices that `vite.config.ts` stopped selecting the delegate for execution.
 */
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
    for (const needle of d.needles) {
      if (stripped.indexOf(needle) === -1) {
        failures.push(`${d.tag} ABSENT ${d.file}: '${needle}' is not in the stripped source`);
        continue;
      }
      const mutated = stripTsComments(raw.split(needle).join(''));
      if (mutated.indexOf(needle) !== -1) {
        failures.push(`${d.tag} INERT ${d.file}: deleting '${needle}' did not remove it`);
      }
    }
  }
  return failures;
}

/**
 * Does `vite.config.ts` still select the delegate specs for execution?
 *
 * Scoped to the `test.include` ARRAY, never a whole-file search: `coverage.include` also exists in
 * that file (`vite.config.ts:68`), so a whole-file `indexOf` would report the pattern present even
 * after `test.include` was narrowed — a fail-open the sibling eval records at
 * `dom-shell-coverage-exclusion.eval.mjs:266`. A narrowed include silently un-runs every delegate
 * while all four pins stay green, which is the one hole the pins structurally cannot see.
 */
export function includeSelectsTests(configSrc) {
  const stripped = stripTsComments(configSrc);
  const open = stripped.indexOf('include: [');
  if (open === -1) return false;
  const start = open + 'include: ['.length;
  const end = stripped.indexOf(']', start);
  const slice = end === -1 ? stripped.slice(start) : stripped.slice(start, end);
  return slice.indexOf('src/**/*.test.ts') !== -1;
}

export default async function () {
  const name = 'overlay-a11y-manifest ([A11Y-15] view-local focus ban + [A11Y-01..04] delegation)';
  let teeth = 0;
  const teethTotal = 15;
  const bad = (detail) => ({ name, pass: false, detail });

  // ==================================================================
  // PROOF-OF-TEETH — every fixture runs BEFORE any real file is read.
  // ==================================================================

  // T1 BAD: the plain call. The control — if this does not bite, nothing below means anything.
  if (findFocusCallSites(stripTsComments('class X { s(){ this.#i.focus(); } }')).length === 0) {
    return bad('TEETH T1: findFocusCallSites missed a plain `this.#i.focus()` — the control');
  }
  teeth++;

  // T2 GOOD (HOSTILE-BUT-CORRECT, and LIVE on five files today): a header comment that NAMES the
  // banned call. Kills a raw-text grep, which false-REDs `battleView.ts:26` on the shipped tree.
  const commentOnly = '// `.focus()` on a display:none node is a silent no-op\nexport class X {}';
  if (findFocusCallSites(stripTsComments(commentOnly)).length !== 0) {
    return bad('TEETH T2: a `.focus(` inside a COMMENT was reported as a call — strip first');
  }
  teeth++;

  // T3 GOOD (monoculture-breaker): the legitimate neighbours that ship today. A gate matching a
  // bare `focus` token would red every view file.
  const neighbours =
    'const s = meta.initialFocusSelector; import { installTrap } from "./focusTrap"; const f = focusables(root);';
  if (findFocusCallSites(stripTsComments(neighbours)).length !== 0) {
    return bad(
      'TEETH T3: `initialFocusSelector`/`focusTrap`/`focusables` were flagged — the word ' +
        'boundary is what makes this scan usable on the real tree',
    );
  }
  teeth++;

  // T4-T9 BAD (monoculture-breaker, six DIFFERENT shapes): §5.1's corpus has exactly ONE BAD
  // shape, so a gate can collapse to `src.includes('#input.focus(')` and stay green while any
  // OTHER view grows a focus call. Each of these was measured to SURVIVE the literal `.focus(`
  // scan that ships today.
  const bypasses = [
    ['optional chain', 'el?.focus?.();'],
    ['computed single-quote', "el['focus']();"],
    ['computed double-quote', 'el["focus"]();'],
    ['whitespace member', 'el . focus();'],
    ['prototype route', 'HTMLElement.prototype.focus.call(el);'],
    ['autofocus attribute', "el.setAttribute('autofocus', '');"],
  ];
  for (const [label, src] of bypasses) {
    if (findFocusCallSites(stripTsComments(src)).length === 0) {
      return bad(
        `TEETH T4-T9: the ${label} bypass (\`${src}\`) was NOT flagged — it survives the ` +
          'literal `.focus(` matcher the three shipped hand-kept lists use',
      );
    }
    teeth++;
  }

  // T10 BAD: the DIVERGENCE ALARM. NEITHER scanner parses regex literals, so the apostrophe in
  // /it's/ opens an unterminated string state. In comment-only mode string bodies pass through and
  // the real `.focus()` on the next line is still seen; in string-stripping mode it is SWALLOWED.
  // The two modes DISAGREEING is the only signal that a call has been eaten — a red-team shipped
  // seven duplicate deferred focus calls at full green through exactly this hole.
  const quoteInRegex = "const re = /it's/;\nthis.#input.focus();\n";
  const cCount = findFocusCallSites(stripTsComments(quoteInRegex)).length;
  const csCount = findFocusCallSites(stripTsCommentsAndStrings(quoteInRegex)).length;
  if (cCount === csCount) {
    return bad(
      `TEETH T10: the divergence ALARM did not fire — comment-stripped=${cCount}, ` +
        `comment+string-stripped=${csCount}. A hidden call after a quote-bearing regex literal ` +
        'would ship green.',
    );
  }
  teeth++;

  // T11 GOOD — the OTHER polarity, without which T10 is satisfied by a scanner that ALWAYS
  // disagrees: ordinary quote-free code must produce IDENTICAL counts in both modes, so the alarm
  // is a real discriminator and not a permanent siren.
  const cleanRegex = 'const re = /a-z/;\nexport class X {}\nconst sel = "#title";\n';
  if (
    findFocusCallSites(stripTsComments(cleanRegex)).length !==
    findFocusCallSites(stripTsCommentsAndStrings(cleanRegex)).length
  ) {
    return bad(
      'TEETH T11: the divergence alarm fired on ordinary, quote-free code — an ' +
        'always-disagreeing scanner would satisfy T10 while discriminating nothing',
    );
  }
  teeth++;

  // T12 BAD: the roster ratchet bites on a deleted/renamed view.
  if (!findMissingViewFiles(['battleView.ts'], KNOWN_VIEW_FILES).includes('sessionView.ts')) {
    return bad('TEETH T12: findMissingViewFiles did not flag a roster entry absent from disk');
  }
  teeth++;

  // T13 BAD: the roster ratchet bites on an unsanctioned NEW view.
  if (!findUnsanctionedViewFiles(['ghostView.ts'], KNOWN_VIEW_FILES).includes('ghostView.ts')) {
    return bad('TEETH T13: findUnsanctionedViewFiles did not flag a view absent from the roster');
  }
  teeth++;

  // T14 BAD: an EMPTY delegate must fail every pin. Kills a `findInertDelegations` that returns []
  // whenever it cannot find what it is looking for — the fail-open shape.
  if (findInertDelegations(() => 'nothing here at all', MANIFEST_DELEGATIONS).length < 4) {
    return bad(
      'TEETH T14: findInertDelegations accepted a delegate containing none of its needles and ' +
        'no describe() — it must fail open-loud, never open-silent',
    );
  }
  teeth++;

  // T15 GOOD: a config whose `test.include` still selects the specs. And T16 BAD: one narrowed.
  if (!includeSelectsTests("test: { include: ['src/**/*.test.ts'] }")) {
    return bad('TEETH T15: includeSelectsTests rejected a correct test.include (false negative)');
  }
  if (
    includeSelectsTests(
      "test: { include: ['src/models/**/*.test.ts'] }, coverage: { include: ['src/**/*.test.ts'] }",
    )
  ) {
    return bad(
      'TEETH T16: includeSelectsTests accepted a NARROWED test.include because the pattern also ' +
        'appears in coverage.include — the search must be scoped to the test.include array slice',
    );
  }
  teeth++;

  // ==================================================================
  // REAL TREE
  // ==================================================================
  let discovered;
  try {
    discovered = discoverViewFiles(UI_DIR);
  } catch (e) {
    return bad(`could not readdir ${UI_DIR}: ${e.message}`);
  }

  // ANTI-VACUITY FLOOR. A mistyped root or suffix yields zero files, zero offenders and a
  // permanent pass; `evals/run.mjs` cannot tell that apart from a clean tree.
  if (discovered.length < KNOWN_VIEW_FILES.length) {
    return bad(
      `VACUITY FLOOR: discovered only ${discovered.length} *View.ts files under ${UI_DIR}, ` +
        `expected at least ${KNOWN_VIEW_FILES.length} — a zero-offender pass over a mistyped ` +
        'scan root is indistinguishable from a clean tree',
    );
  }

  const missing = findMissingViewFiles(discovered, KNOWN_VIEW_FILES);
  if (missing.length > 0) {
    return bad(
      `[A11Y-15] roster entries missing from ${UI_DIR}: ${missing.join(', ')} — a renamed or ` +
        'deleted view must be a loud red, never a silently smaller scan',
    );
  }
  const unsanctioned = findUnsanctionedViewFiles(discovered, KNOWN_VIEW_FILES);
  if (unsanctioned.length > 0) {
    return bad(
      `[A11Y-15] new view file(s) not in KNOWN_VIEW_FILES: ${unsanctioned.join(', ')} — the scan ` +
        'already covers them (it is readdir-driven); add them with their class declaration so the ' +
        'stripper anti-vacuity pairing stays complete',
    );
  }

  const declarations = new Map(KNOWN_VIEW_FILES);
  let divergences = 0;
  for (const file of discovered) {
    const path = `${UI_DIR}/${file}`;
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      return bad(`[A11Y-15] could not read ${path}: ${e.message}`);
    }

    const strippedComments = stripTsComments(raw);
    const strippedBoth = stripTsCommentsAndStrings(raw);

    const declaration = declarations.get(file);
    if (strippedComments.indexOf(declaration) === -1) {
      return bad(
        `[A11Y-15] ANTI-VACUITY: '${declaration}' did not survive comment-stripping of ${path} — ` +
          'the stripper fell into an unterminated string or comment state and ate the file, so a ' +
          'zero-offender result there means nothing',
      );
    }

    const hits = findFocusCallSites(strippedComments);
    if (hits.length > 0) {
      const where = hits.map((h) => `${h.tag}@${h.line}`).join(', ');
      return bad(
        `[A11Y-15] ${path} contains a view-local focus call (${where}) — the single deferred ` +
          'focus lives ONLY in client/src/ui/overlayA11y.ts (M23 §2.2, criterion A11Y-15)',
      );
    }

    // The divergence tooth, on the REAL file: both stripper modes must agree.
    if (findFocusCallSites(strippedBoth).length !== hits.length) {
      divergences++;
      return bad(
        `[A11Y-15] DIVERGENCE in ${path}: the comment-stripped and comment+string-stripped focus ` +
          'counts disagree, so the stripper is mis-tracking state — a real call after a regex ' +
          'literal containing a quote is exactly how seven duplicate focus calls once shipped green',
      );
    }
  }

  // Delegations.
  const inert = findInertDelegations((f) => readFileSync(f, 'utf8'), MANIFEST_DELEGATIONS);
  if (inert.length > 0) {
    return bad(
      `[A11Y-01..04] delegation pin failures: ${inert.join(' | ')} — these criteria are gated by ` +
        'the shipped stronger oracles rather than re-implemented here (see the header); a broken ' +
        'pin means that delegation is no longer real',
    );
  }

  let viteSrc;
  try {
    viteSrc = readFileSync(VITE_CONFIG, 'utf8');
  } catch (e) {
    return bad(`[A11Y-01..04] could not read ${VITE_CONFIG}: ${e.message}`);
  }
  if (!includeSelectsTests(viteSrc)) {
    return bad(
      `[A11Y-01..04] REACHABILITY: ${VITE_CONFIG}'s test.include no longer selects ` +
        "'src/**/*.test.ts', so every delegated oracle is un-run while all four pins stay green",
    );
  }

  return {
    name,
    pass: true,
    detail:
      `[A11Y-15] views=${discovered.length} hits=0 diverge=${divergences} ` +
      `spellings=${FOCUS_SPELLINGS.length}; ` +
      `[A11Y-01..04] pins=${MANIFEST_DELEGATIONS.length}/${MANIFEST_DELEGATIONS.length} ` +
      `nonInert=${MANIFEST_DELEGATIONS.length}/${MANIFEST_DELEGATIONS.length} reachable=Y; ` +
      `teeth=${teeth}/${teethTotal}`,
  };
}
