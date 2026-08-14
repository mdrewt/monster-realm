// scanner-migration-audit eval (14r-c, ADR-0181 residual — "the class is wider
// than this slice (disclosed, not closed)"):
//
// ADR-0181 introduced evals/rust-scan.mjs (a string-literal-aware, single-pass
// Rust comment+string stripper) and migrated THREE evals onto it
// (currency-integrity, ranking-security, conversation-privacy/wallet-privacy).
// It explicitly disclosed that the hazard class is wider: several more
// evals/*.eval.mjs files — several of them named `*-security.eval.mjs` /
// `*-privacy.eval.mjs`, i.e. SECURITY GATES — still strip Rust slash-slash
// line comments with a naive regex pair that has no notion of string literals. A Rust
// literal like an issuer URL truncates at its scheme slashes, orphans a quote,
// inverts string/code polarity, and blinds every downstream ban clause. The
// gate then reports PASS *because it went blind* — a false-GREEN on a
// security gate (ADR-0181 Context).
//
// THIS FILE does not migrate anything. It is a TRACKING GATE: it enumerates
// every eval file that is a security/privacy gate BY NAME, classifies each as
// migrated or not, and fails loud — by name — for every one that is neither
// migrated nor explicitly, cap-boundedly parked in KNOWN_UNMIGRATED. It is
// expected to be RED at 14r-c HEAD (most gated files are not yet migrated);
// closing it is the indicated follow-up across future slices.
//
// -----------------------------------------------------------------------
// THE CONTRACT — read this before touching either leg.
// -----------------------------------------------------------------------
//
// A gated file counts as MIGRATED only if it passes BOTH legs:
//
//   LEG 1 (structural wiring) — the file contains a REAL static `import`
//   of './rust-scan.mjs' (anchored to an actual `import` statement — a
//   decoy STRING containing that text does not count) AND at least one
//   REAL `assertStripperSound(` call site (in executable code, not inside a
//   string/comment).
//
//   LEG 2 (no naive stripper survives ANYWHERE in the file) — the file's
//   executable code contains no `replace(` call whose regex carries the
//   `[\s\S]*?` (block-comment) or `[^\n]*` (line-comment) naive-stripper
//   signature. This is the leg that catches the PoC'd bypass: an
//   implementer who adds a correct, exported, but NEVER-CALLED helper
//   (`export function stripCanaryOnly(...)`) while the file's real ban
//   clauses keep calling a PRIVATE, unexported naive helper. Leg 1 alone
//   cannot see that — the import and the assert call are both real, they
//   just aren't wired to the code that matters. Leg 2 inspects the WHOLE
//   file's code surface, so the dead private helper is still visible.
//
// HONESTY NOTE (required by review, do not delete): Leg 2 is evadable IN
// PRINCIPLE by respelling the naive regex (e.g. `[\0-￿]*?` instead of
// `[\s\S]*?`, or building the pattern from `String.fromCharCode` the way
// THIS file itself does for the opposite reason). It is NOT informational
// or "nice to have" despite that — it is LOAD-BEARING, because it is the
// only leg that can catch the exact dead-code bypass this gate exists to
// close, and it is measured to hold against every naive copy actually
// in-tree today (see T1/T7 below). Legs 1 AND 2 TOGETHER are the contract;
// neither is sufficient alone.
//
// -----------------------------------------------------------------------
// WHICH SCANNING PASS EACH LEG USES, AND WHY THEY DIFFER FROM `rust-scan.mjs`.
// -----------------------------------------------------------------------
//
// Both legs run over `blankJsLiterals(src)`, a LITERAL-BLANKING pass defined
// in THIS file for JS/TS source (comments AND string/template PAYLOADS are
// blanked to spaces; length, newlines, and quote characters are preserved,
// mirroring rust-scan.mjs's `stripRustSource` contract). ADR-0181 D4
// FORBIDS pointing `stripRustSource` itself at TypeScript/JS — it is tuned
// for Rust string forms (`r#"..."#`, byte strings, char-literal lifetimes)
// and blanking a JS template literal's `${...}` payload would corrupt real
// code. `evals/conversation-privacy.eval.mjs`'s `stripTsComments` is the
// existing JS/TS scanner, but it is deliberately LITERAL-PRESERVING (D4: the
// client privacy evals need to read INSIDE string payloads). For THIS gate
// that property is a LIABILITY: the decoy this gate must resist
// (T3b below) hides its `import`/`assertStripperSound(` text INSIDE a JS
// string, and a literal-preserving pass would leave that text intact and
// matchable. Blanking is what defeats it: the decoy's entire payload
// disappears, while a REAL import statement's structure (the `import` /
// `from` keywords) survives because those keywords are never themselves
// string payload for a real import. `blankJsLiterals` also records each
// string/template literal's raw payload SPAN, so Leg 1 can still read the
// module-specifier text (`./rust-scan.mjs`) out of the RAW source at the
// span's offset — blanking the SEARCH SURFACE does not mean losing the one
// payload we deliberately still need.
//
// -----------------------------------------------------------------------
// No `new RegExp()` anywhere (Semgrep detect-non-literal-regexp) — only
// literal /regex/ and String.indexOf/slice.
//
// Hazard characters (slash-slash, slash-star, star-slash, and the run of
// text that forms the naive stripper's own regex literal) are never written CONTIGUOUSLY in
// this file's own text — this file is itself scanned by other repo
// scanners (precedent: evals/rust-scan.mjs:47-50,
// evals/ranking-security.eval.mjs:81-83). Every such sequence below is
// built from `String.fromCharCode` constants and concatenation.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { containsIdent } from './rust-scan.mjs';

const AUDIT_FILE_NAME = 'scanner-migration-audit.eval.mjs';
const SECURITY_SUFFIX = '-security.eval.mjs';
const PRIVACY_SUFFIX = '-privacy.eval.mjs';

// Ratchets (14r-c HEAD, measured — see report for the measurement).
const GATED_FLOOR = 18; // the name-derived gated-set size must never drop below this
const MIGRATED_FLOOR = 4; // account-privacy, conversation-privacy, wallet-privacy, ranking-security
const KNOWN_UNMIGRATED_CAP = 5;

// Self-retiring named debt. Seeded EMPTY at 14r-c: this slice only writes the
// audit; a future slice adds an entry ONLY for a file that genuinely needs to
// park (and removes it the moment migration lands — T5 makes that automatic).
export const KNOWN_UNMIGRATED = [
  // { file: 'example-security.eval.mjs', owner: '15x-y', reason: '...' },
];

// ---------------------------------------------------------------------------
// Hazard characters as data (never written contiguously as literal text).
// ---------------------------------------------------------------------------
const A_SLASH = String.fromCharCode(0x2f); // /
const A_BACKSLASH = String.fromCharCode(0x5c); // \
const A_STAR = String.fromCharCode(0x2a); // *
const A_DQ = String.fromCharCode(0x22); // "
const A_BACKTICK = String.fromCharCode(0x60); // `
const WHITESPACE_CHARS = ' \t\r\n';

// The naive stripper's own regex-literal TEXT, exactly as it appears in the
// in-tree copies (evals/battle-reducer-security.eval.mjs:21,
// evals/shop-reducer-security.eval.mjs:33, evals/trade-reducer-security.eval.mjs:36),
// built from character constants so THIS file never carries the hazard
// sequence contiguously. Used only to build realistic proof-of-teeth fixtures
// (T1/T7); the live DETECTOR below searches for the much smaller, slash-free
// `[\s\S]*?` / `[^\n]*` fragments directly (those contain no hazard chars).
const NAIVE_BLOCK_RE_LITERAL =
  A_SLASH +
  A_BACKSLASH +
  A_SLASH +
  A_BACKSLASH +
  A_STAR +
  '[' +
  A_BACKSLASH +
  's' +
  A_BACKSLASH +
  'S]*?' +
  A_BACKSLASH +
  A_STAR +
  A_BACKSLASH +
  A_SLASH +
  A_SLASH +
  'g';
const NAIVE_LINE_RE_LITERAL =
  A_SLASH +
  A_BACKSLASH +
  A_SLASH +
  A_BACKSLASH +
  A_SLASH +
  '[^' +
  A_BACKSLASH +
  'n]*' +
  A_SLASH +
  'g';

// ---------------------------------------------------------------------------
// isGatedName — the ENFORCED gated-set predicate. Derived, never hardcoded:
// any file matching this suffix rule is gated, whether or not it existed when
// this file was written (T6 proves this against a synthetic name).
// ---------------------------------------------------------------------------
export function isGatedName(f) {
  return f.endsWith(SECURITY_SUFFIX) || f.endsWith(PRIVACY_SUFFIX);
}

// ---------------------------------------------------------------------------
// blankJsLiterals — the literal-BLANKING JS/TS pass both legs run over.
//
// Mirrors evals/rust-scan.mjs's `stripRustSource` contract (length- and
// newline-preserving; comment/string PAYLOADS blanked to spaces; quote
// characters kept) but for JS/TS lexical shape: slash-slash line and
// slash-star block comments, `'...'`/`"..."`/`` `...` `` strings (backslash-escape aware), and — sound,
// not heuristic, cloned from evals/conversation-privacy.eval.mjs's
// `startsRegexLiteral` (ADR-0181 D8) — regex literals, which must be treated
// as CODE (left untouched) rather than blanked as a string, or a real
// naive-stripper regex literal (the exact shape NAIVE_BLOCK_RE_LITERAL below
// builds) would itself be blanked away and Leg 2 could never see it.
//
// KNOWN LIMIT (documented, not hidden — same class as
// evals/conversation-privacy.eval.mjs's stated `${...}` limit): a template
// literal is treated as ONE monolithic span from backtick to backtick, with
// no separate handling of `${...}` interpolation. Under-detection here is
// safe (it just treats interpolated code as blanked-string payload, the same
// direction as the existing TS scanner), and no gated file's naive-stripper
// call site lives inside a template literal today (verified by inspection).
//
// Returns { blanked, spans }: `blanked` is the same-length output; `spans` is
// every string/template literal's PAYLOAD span `{start, end}` (raw-source
// offsets, exclusive of the quote characters) — Leg 1 needs to read a real
// import's module-specifier text back out of the RAW source at these offsets,
// since blanking the search surface does not mean losing that one payload.
export function blankJsLiterals(rawSrc) {
  const out = rawSrc.split('');
  const len = rawSrc.length;
  const spans = [];
  const blank = (from, to) => {
    for (let k = from; k < Math.min(to, len); k++) if (out[k] !== '\n') out[k] = ' ';
  };

  let i = 0;
  while (i < len) {
    const c = rawSrc[i];

    // Regex literal — sound detection (ADR-0181 D8): a `/` can only open a
    // regex where a binary `/` (division) is impossible, i.e. immediately
    // after an operator/opening-bracket/separator or at start of source.
    if (c === A_SLASH && startsRegexLiteralJs(rawSrc, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < len) {
        const ch = rawSrc[j];
        if (ch === A_BACKSLASH) {
          j += 2;
          continue;
        }
        if (ch === '\n') break; // unterminated: bail, never run away
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === A_SLASH && !inClass) {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }

    // Line comment.
    if (c === A_SLASH && rawSrc[i + 1] === A_SLASH) {
      let j = i;
      while (j < len && rawSrc[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }

    // Block comment.
    if (c === A_SLASH && rawSrc[i + 1] === A_STAR) {
      let j = i + 2;
      while (j < len && !(rawSrc[j] === A_STAR && rawSrc[j + 1] === A_SLASH)) j++;
      j = Math.min(j + 2, len);
      blank(i, j);
      i = j;
      continue;
    }

    // String / char / template literal — PAYLOAD blanked (unlike
    // stripTsComments), quote characters preserved, span recorded.
    if (c === "'" || c === A_DQ || c === A_BACKTICK) {
      let j = i + 1;
      let closeAt = -1;
      while (j < len) {
        if (rawSrc[j] === A_BACKSLASH) {
          j += 2;
          continue;
        }
        if (rawSrc[j] === c) {
          closeAt = j;
          break;
        }
        if (rawSrc[j] === '\n' && c !== A_BACKTICK) break; // unterminated '/" literal
        j++;
      }
      const payloadEnd = closeAt === -1 ? j : closeAt;
      const spanEnd = closeAt === -1 ? j : closeAt + 1;
      spans.push({ start: i + 1, end: payloadEnd });
      blank(i, spanEnd);
      out[i] = c;
      if (closeAt !== -1) out[closeAt] = c;
      i = spanEnd;
      continue;
    }

    i++;
  }

  return { blanked: out.join(''), spans };
}

const REGEX_START_OPERATOR_CHARS = '=(,[{:;!?&|+-*%<>^~}';

function startsRegexLiteralJs(src, i) {
  const next = src[i + 1];
  if (next === A_SLASH || next === A_STAR || next === undefined) return false;
  let k = i - 1;
  while (k >= 0 && WHITESPACE_CHARS.indexOf(src[k]) !== -1) k--;
  if (k < 0) return true;
  return REGEX_START_OPERATOR_CHARS.indexOf(src[k]) !== -1;
}

function isWordCharAudit(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

// ---------------------------------------------------------------------------
// LEG 1 — real static import + real assertStripperSound( call site.
// ---------------------------------------------------------------------------

/**
 * True iff there is a REAL `import ... from './rust-scan.mjs'` statement,
 * proven by: (a) a string/template SPAN whose raw payload is exactly
 * './rust-scan.mjs' or 'rust-scan.mjs'-suffixed relative path text, (b) the
 * word immediately preceding that string's opening quote, in the BLANKED
 * text (so it is guaranteed to be code, never string/comment content), is
 * `from`, and (c) the word `import` occurs before that `from` without an
 * intervening `;` (statement boundary).
 */
export function hasRealImportFromRustScan(rawSrc, blanked, spans) {
  for (const { start, end } of spans) {
    const payload = rawSrc.slice(start, end);
    if (payload !== './rust-scan.mjs') continue;

    let p = start - 2; // char just before the opening quote (start-1)
    while (p >= 0 && WHITESPACE_CHARS.indexOf(blanked[p]) !== -1) p--;
    if (p < 3) continue;
    const fromStart = p - 3;
    if (blanked.slice(fromStart, p + 1) !== 'from') continue;
    if (fromStart > 0 && isWordCharAudit(blanked[fromStart - 1])) continue;

    const windowStart = Math.max(0, fromStart - 400);
    const window = blanked.slice(windowStart, fromStart);
    const semiIdx = window.lastIndexOf(';');
    const zone = semiIdx === -1 ? window : window.slice(semiIdx + 1);
    if (containsIdent(zone, 'import')) return true;
  }
  return false;
}

export function checkLeg1(rawSrc) {
  const { blanked, spans } = blankJsLiterals(rawSrc);
  const hasImport = hasRealImportFromRustScan(rawSrc, blanked, spans);
  const hasAssert = blanked.indexOf('assertStripperSound(') !== -1;
  const problems = [];
  if (!hasImport) {
    problems.push(
      "LEG1: no REAL static `import ... from './rust-scan.mjs'` found, anchored to an " +
        'actual import statement — a decoy string/comment containing that text does not count',
    );
  }
  if (!hasAssert) {
    problems.push(
      'LEG1: no real assertStripperSound( call site found in executable code (a call site ' +
        'inside a string/comment does not count)',
    );
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// LEG 2 — no naive stripper survives anywhere in the file's executable code.
// ---------------------------------------------------------------------------

/**
 * Returns a diagnostic string if a `replace(` call in EXECUTABLE code (per
 * blankJsLiterals — string/template/comment occurrences are exempt) carries
 * the block-comment (`[\s\S]*?`) or line-comment (`[^\n]*`) naive-stripper
 * signature fragment nearby; null if the file's code is clean.
 */
export function checkLeg2(rawSrc) {
  const { blanked } = blankJsLiterals(rawSrc);
  let idx = blanked.indexOf('replace(');
  while (idx !== -1) {
    const window = blanked.slice(idx, idx + 200);
    if (window.indexOf('[\\s\\S]*?') !== -1) {
      return (
        `LEG2: naive block-comment stripper (a replace( call whose regex carries the ` +
        `[\\s\\S]*? fragment) found in executable code near offset ${idx} — this is the ` +
        'ADR-0181 hazard shape; it is exempt only when it occurs inside a string/comment'
      );
    }
    if (window.indexOf('[^\\n]*') !== -1) {
      return (
        `LEG2: naive line-comment stripper (a replace( call whose regex carries the ` +
        `[^\\n]* fragment) found in executable code near offset ${idx} — this is the ` +
        'ADR-0181 hazard shape; it is exempt only when it occurs inside a string/comment'
      );
    }
    idx = blanked.indexOf('replace(', idx + 1);
  }
  return null;
}

export function classifyGatedFile(f, rawSrc) {
  const leg1 = checkLeg1(rawSrc);
  const leg2reason = checkLeg2(rawSrc);
  const reasons = [...leg1.problems];
  if (leg2reason !== null) reasons.push(leg2reason);
  return { file: f, migrated: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// KNOWN_UNMIGRATED validation (self-retiring, membership-guarded, capped).
// ---------------------------------------------------------------------------
export function validateKnownUnmigratedEntries(
  entries,
  gatedFileSet,
  migratedFileSet,
  existsFn,
  cap,
) {
  const problems = [];
  if (entries.length > cap) {
    problems.push(`KNOWN_UNMIGRATED has ${entries.length} entries, exceeding the cap of ${cap}`);
  }
  for (const entry of entries) {
    if (!existsFn(entry.file)) {
      problems.push(
        `KNOWN_UNMIGRATED entry '${entry.file}' does not exist on disk at evals/${entry.file} — fix or remove the entry`,
      );
      continue;
    }
    if (!gatedFileSet.has(entry.file)) {
      problems.push(
        `KNOWN_UNMIGRATED entry '${entry.file}' is not a member of the name-derived gated set ` +
          '(*-security.eval.mjs / *-privacy.eval.mjs) — a debt entry for a differently-named file ' +
          "(e.g. a '*-guards.eval.mjs' owned by a different slice) would create a cross-slice merge deadlock and is not allowed here",
      );
      continue;
    }
    if (migratedFileSet.has(entry.file)) {
      problems.push(
        `KNOWN_UNMIGRATED entry '${entry.file}' has ALREADY been migrated (now passes Legs 1+2) — delete this entry (debt is self-retiring)`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Bonus behavioral corroboration (NOT sole evidence — Leg 2 is what closes
// the dead-code bypass). For each gated file, import it and, for every export
// whose name starts with strip/scan/prepare/blank, feed an ADR-0181 canary
// (a URL-scheme literal — CANARY_SRC below — followed by a needle) and
// require the needle to SURVIVE and the output length to match the canary's.
// An import failure counts as that file's FAIL — never a silent skip.
// ---------------------------------------------------------------------------
const CANARY_NEEDLE = 'NEEDLE_MARKER_9F3C1A_STILL_HERE';
const CANARY_SRC =
  'const ISSUER: &str = ' +
  A_DQ +
  'https:' +
  A_SLASH +
  A_SLASH +
  'auth.example' +
  A_SLASH +
  A_DQ +
  ';\n' +
  CANARY_NEEDLE +
  '\n';
const STRIP_EXPORT_PREFIXES = ['strip', 'scan', 'prepare', 'blank'];

async function runBonusBehavioralCheck(gatedFiles) {
  const failures = [];
  for (const f of gatedFiles) {
    let mod;
    try {
      mod = await import(pathToFileURL(path.resolve('evals', f)).href);
    } catch (e) {
      failures.push(
        `BONUS/import: evals/${f} threw on import — ${e?.message ?? String(e)} (an import failure ` +
          "counts as this file's FAIL, never a silent skip)",
      );
      continue;
    }
    for (const [exportName, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue;
      if (!STRIP_EXPORT_PREFIXES.some((p) => exportName.startsWith(p))) continue;
      let out;
      try {
        out = fn(CANARY_SRC);
      } catch (e) {
        failures.push(
          `BONUS/${f}#${exportName}: threw on ADR-0181 canary — ${e?.message ?? String(e)}`,
        );
        continue;
      }
      if (typeof out !== 'string') continue; // not a single-string source transform; not this check's business
      if (out.indexOf(CANARY_NEEDLE) === -1) {
        failures.push(
          `BONUS/${f}#${exportName}: canary needle was SWALLOWED — the canary's URL-scheme literal ` +
            'truncated the scan (the exact ADR-0181 hazard) or the function is otherwise unsound',
        );
      }
      if (out.length !== CANARY_SRC.length) {
        failures.push(
          `BONUS/${f}#${exportName}: output length ${out.length} != canary length ${CANARY_SRC.length} (not offset-preserving)`,
        );
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Content-detected set — REPORTED, NOT enforced. Evals that read
// server-module/src and define their OWN naive strip helper but escape the
// name predicate (disclosed gap, ADR-0181 residual). Best-effort: reuses
// checkLeg2's naive-signature detector rather than a hardcoded list, so it
// self-updates as files are migrated or added — it is not asserted against
// any fixed count because it is explicitly out of this gate's enforcement.
// ---------------------------------------------------------------------------
function detectContentOnlyCandidates(allEvalFiles, gatedFileSet) {
  const found = [];
  for (const f of allEvalFiles) {
    if (gatedFileSet.has(f) || f === AUDIT_FILE_NAME) continue;
    let src;
    try {
      src = readFileSync(`evals/${f}`, 'utf8');
    } catch {
      continue;
    }
    if (src.indexOf('server-module/src') === -1) continue;
    if (checkLeg2(src) !== null) found.push(f);
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// PROOF-OF-TEETH — run BEFORE the live scan (repo convention: a broken
// checker must be caught before its verdict on the real corpus is trusted).
// ---------------------------------------------------------------------------
function runProofOfTeeth() {
  const teeth = [];

  // T1 — injected naive stripper must be FLAGGED by Leg 2.
  {
    const src =
      'function stripRustComments(src) {\n' +
      '  return src.replace(' +
      NAIVE_BLOCK_RE_LITERAL +
      ", '').replace(" +
      NAIVE_LINE_RE_LITERAL +
      ", '');\n" +
      '}\n';
    if (checkLeg2(src) === null) {
      teeth.push(
        'T1 FAILED: an injected naive stripper (real .replace(/.../[\\s\\S]*?.../g,...).replace(/.../[^\\n]*.../g,...) ' +
          'code) was NOT flagged by checkLeg2 — kills: a Leg2 detector blind to the real in-tree naive-stripper shape',
      );
    }
  }

  // T2 — vacuity floor: gated set >= GATED_FLOOR; an empty/short set must FAIL.
  {
    const short = ['a-security.eval.mjs'];
    if (checkGatedFloorProblem(short, GATED_FLOOR) === null) {
      teeth.push(
        'T2 FAILED: a short (1-file) gated set was NOT flagged as below the vacuity floor — kills: ' +
          'a broken cwd/checkout silently passing on an empty/short enumeration',
      );
    }
    const full = [];
    for (let n = 0; n < GATED_FLOOR; n++) full.push(`synthetic-${n}-security.eval.mjs`);
    if (checkGatedFloorProblem(full, GATED_FLOOR) !== null) {
      teeth.push(
        `T2 FAILED: a ${GATED_FLOOR}-file gated set was incorrectly flagged as below the floor`,
      );
    }
  }

  // T3 — commented-out import decoy must NOT satisfy Leg 1.
  {
    const src =
      A_SLASH +
      A_SLASH +
      " import { stripRustSource } from './rust-scan.mjs';\n" +
      A_SLASH +
      A_SLASH +
      " assertStripperSound(x, 'y');\n" +
      'export function noop() {\n  return 1;\n}\n';
    if (checkLeg1(src).ok) {
      teeth.push(
        'T3 FAILED: a commented-out import + assertStripperSound( decoy satisfied Leg1 — kills: a Leg1 ' +
          'check that does not blank comments before searching',
      );
    }
  }

  // T3b — string-literal import decoy (the PoC) must NOT satisfy Leg 1.
  {
    const src =
      'const _decoy = ' +
      A_DQ +
      "import { stripRustSource } from './rust-scan.mjs'; assertStripperSound(x, 'y')" +
      A_DQ +
      ';\n' +
      'export function noop() {\n  return 1;\n}\n';
    if (checkLeg1(src).ok) {
      teeth.push(
        'T3b FAILED: a string-literal decoy (a JS string whose CONTENT is real-looking import + ' +
          'assertStripperSound( text) satisfied Leg1 — kills: a Leg1 check that does not blank string payloads',
      );
    }
  }

  // T4 — fixture-literal decoy: naive regex text inside a STRING must NOT trip Leg 2.
  {
    const src =
      'const HISTORY_NOTE = ' +
      A_DQ +
      'the old code used to do src.replace([\\s\\S]*?) and then replace([^\\n]*) which truncated URLs' +
      A_DQ +
      ';\n';
    if (checkLeg2(src) !== null) {
      teeth.push(
        'T4 FAILED: naive-stripper fragment text living INSIDE a string literal was flagged by Leg2 — ' +
          'kills: a Leg2 detector that does not exempt string/comment occurrences (fixtures and doc ' +
          'quotes legitimately contain this text)',
      );
    }
  }

  // T5 — debt self-retirement: an entry pointing at an already-migrated file must RED.
  {
    const problems = validateKnownUnmigratedEntries(
      [
        {
          file: 'ranking-security.eval.mjs',
          owner: 'tester',
          reason: 'T5 synthetic — proves self-retirement',
        },
      ],
      new Set(['ranking-security.eval.mjs']),
      new Set(['ranking-security.eval.mjs']), // pretend already migrated
      (f) => existsSync(`evals/${f}`),
      KNOWN_UNMIGRATED_CAP,
    );
    if (!problems.some((p) => p.indexOf('delete this entry') !== -1)) {
      teeth.push(
        'T5 FAILED: a KNOWN_UNMIGRATED entry pointing at an already-migrated file did not RED with ' +
          '"delete this entry" — kills: debt that is not self-retiring',
      );
    }
  }

  // T5b — debt membership: an entry outside the name-derived gated set must RED.
  {
    const problems = validateKnownUnmigratedEntries(
      [
        {
          file: 'trade-escrow-guards.eval.mjs',
          owner: 'tester',
          reason: 'T5b synthetic — proves membership guard',
        },
      ],
      new Set(['ranking-security.eval.mjs']), // does NOT contain trade-escrow-guards.eval.mjs
      new Set(),
      (f) => existsSync(`evals/${f}`),
      KNOWN_UNMIGRATED_CAP,
    );
    if (!problems.some((p) => p.indexOf('not a member') !== -1)) {
      teeth.push(
        'T5b FAILED: a KNOWN_UNMIGRATED entry for a file OUTSIDE the name-derived gated set ' +
          '(trade-escrow-guards.eval.mjs) did not RED — kills: a cross-slice merge deadlock where an ' +
          'entry for a differently-named, differently-owned file is silently accepted',
      );
    }
  }
  // T6 — predicate coverage: a synthetic name must classify as gated (not a hardcoded list).
  if (!isGatedName('zzz-security.eval.mjs') || !isGatedName('zzz-privacy.eval.mjs')) {
    teeth.push(
      'T6 FAILED: a synthetic zzz-security.eval.mjs / zzz-privacy.eval.mjs name did not classify as ' +
        'gated — kills: a hardcoded gated-file list masquerading as a predicate',
    );
  }
  if (isGatedName('zzz-guards.eval.mjs')) {
    teeth.push('T6 FAILED: a zzz-guards.eval.mjs name incorrectly classified as gated');
  }

  // T7 — the dead-code bypass itself: real import + real assertStripperSound(
  // call on throwaway input + correct-but-unused export + a PRIVATE naive
  // helper that the real ban clause actually calls. Must be flagged.
  {
    const src =
      'import { assertStripperSound, stripRustSource } from ' +
      A_DQ +
      './rust-scan.mjs' +
      A_DQ +
      ';\n' +
      '\n' +
      'function stripNaive(src) {\n' +
      '  return src.replace(' +
      NAIVE_BLOCK_RE_LITERAL +
      ", '').replace(" +
      NAIVE_LINE_RE_LITERAL +
      ", '');\n" +
      '}\n' +
      '\n' +
      'export function stripCanaryOnly(src) {\n' +
      '  return stripRustSource(src);\n' +
      '}\n' +
      '\n' +
      "const _throwaway = assertStripperSound('const x = 1;', 'throwaway');\n" +
      '\n' +
      'export function realBanClause(src) {\n' +
      '  return stripNaive(src).indexOf(' +
      A_DQ +
      'BANNED' +
      A_DQ +
      ') !== -1;\n' +
      '}\n';
    const leg1 = checkLeg1(src);
    const leg2 = checkLeg2(src);
    if (!leg1.ok) {
      teeth.push(
        `T7 FAILED (setup): the dead-code-bypass fixture's real import + real assertStripperSound( call ` +
          `did not satisfy Leg1 (${leg1.problems.join('; ')}) — the fixture must pass Leg1 so the failure is attributable to Leg2`,
      );
    }
    if (leg2 === null) {
      teeth.push(
        'T7 FAILED: the dead-code bypass (real import + real assertStripperSound( call on throwaway input ' +
          '+ a correct-but-UNUSED exported stripCanaryOnly + a PRIVATE naive stripNaive that the real ban ' +
          'clause actually calls) was NOT flagged — kills: a gate that trusts Leg1 evidence alone (the ' +
          'PoC-confirmed CRITICAL bypass this gate exists to close)',
      );
    }
  }

  return teeth;
}

function checkGatedFloorProblem(list, floor) {
  if (list.length < floor) {
    return (
      `gated set has only ${list.length} file(s), below the vacuity floor of ${floor} — likely a ` +
      'broken cwd/checkout; refusing to silently pass on an empty/short set'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default export.
// ---------------------------------------------------------------------------
export default async function scannerMigrationAuditEval() {
  const name = 'scanner-migration-audit (14r-c, ADR-0181 gated-set migration tracking)';
  const failures = [];

  const teethFailures = runProofOfTeeth();
  for (const t of teethFailures) failures.push(`TEETH: ${t}`);

  let allEvalFiles;
  try {
    allEvalFiles = readdirSync('evals').filter((f) => f.endsWith('.eval.mjs'));
  } catch (e) {
    return { name, pass: false, detail: `cannot enumerate evals/: ${e?.message ?? String(e)}` };
  }

  const gatedFiles = allEvalFiles.filter((f) => isGatedName(f) && f !== AUDIT_FILE_NAME).sort();

  const floorProblem = checkGatedFloorProblem(gatedFiles, GATED_FLOOR);
  if (floorProblem !== null) failures.push(`GATED_SET: ${floorProblem}`);

  const results = [];
  for (const f of gatedFiles) {
    let src;
    try {
      src = readFileSync(`evals/${f}`, 'utf8');
    } catch (e) {
      failures.push(`CLASSIFY: cannot read evals/${f}: ${e?.message ?? String(e)}`);
      results.push({
        file: f,
        migrated: false,
        reasons: [`unreadable: ${e?.message ?? String(e)}`],
      });
      continue;
    }
    results.push(classifyGatedFile(f, src));
  }

  const migratedFileSet = new Set(results.filter((r) => r.migrated).map((r) => r.file));
  const migratedCount = migratedFileSet.size;
  const gatedFileSet = new Set(gatedFiles);

  const debtProblems = validateKnownUnmigratedEntries(
    KNOWN_UNMIGRATED,
    gatedFileSet,
    migratedFileSet,
    (f) => existsSync(`evals/${f}`),
    KNOWN_UNMIGRATED_CAP,
  );
  for (const p of debtProblems) failures.push(`DEBT: ${p}`);

  const debtFileSet = new Set(KNOWN_UNMIGRATED.map((e) => e.file));
  const uncovered = results.filter((r) => !r.migrated && !debtFileSet.has(r.file));
  if (uncovered.length > 0) {
    failures.push(
      `MIGRATION: ${uncovered.length} gated file(s) are neither migrated (Legs 1+2) nor listed in ` +
        `KNOWN_UNMIGRATED: ${uncovered.map((r) => `${r.file} [${r.reasons.join('; ')}]`).join(' | ')}`,
    );
  }

  if (migratedCount < MIGRATED_FLOOR) {
    failures.push(
      `RATCHET: MIGRATED_FLOOR violated — only ${migratedCount} gated file(s) pass Legs 1+2, below the ` +
        `floor of ${MIGRATED_FLOOR} (a previously-migrated file appears to have regressed)`,
    );
  }
  if (gatedFiles.length < GATED_FLOOR) {
    failures.push(
      `RATCHET: gated-set size ${gatedFiles.length} dropped below GATED_FLOOR ${GATED_FLOOR} — a rename ` +
        'away from the *-security.eval.mjs / *-privacy.eval.mjs predicate is a known evasion',
    );
  }

  let bonusFailures = [];
  try {
    bonusFailures = await runBonusBehavioralCheck(gatedFiles);
  } catch (e) {
    failures.push(`BONUS: bonus behavioral check threw unexpectedly — ${e?.message ?? String(e)}`);
  }
  for (const b of bonusFailures) failures.push(b);

  const contentDetected = detectContentOnlyCandidates(allEvalFiles, gatedFileSet);

  const summary = `${gatedFiles.length} gated / ${migratedCount} migrated / ${KNOWN_UNMIGRATED.length} debt`;
  const contentNote =
    contentDetected.length > 0
      ? ` | content-detected (report-only, ungated by name, ADR-0181 disclosed gap): ${contentDetected.join(', ')}`
      : ' | content-detected (report-only): none found';
  const detail =
    failures.length > 0
      ? `${summary} — FAILURES: ${failures.join(' || ')}${contentNote}`
      : `${summary}${contentNote}`;

  return { name, pass: failures.length === 0, detail };
}
