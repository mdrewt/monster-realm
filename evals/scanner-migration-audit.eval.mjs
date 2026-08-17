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
// migrated nor explicitly, cap-boundedly parked in KNOWN_UNMIGRATED. It was
// expected to be RED at 14r-c HEAD; it is GREEN once every remaining unmigrated
// file is named in KNOWN_UNMIGRATED. Closing the parks is the indicated follow-up.
//
// -----------------------------------------------------------------------
// THE CONTRACT — read this before touching either leg.
// -----------------------------------------------------------------------
//
// APPLICABILITY comes FIRST (14r-c). Legs 1+2 are a RUST-scanner migration
// requirement, so they only apply to a gated file that ACTUALLY READS RUST
// SOURCE. `evals/box-view-privacy.eval.mjs` scans exactly one file —
// `client/src/net/store.ts` — and reads no Rust at all; demanding that it import
// the Rust scanner is not merely noise, it directly contradicts ADR-0181 D4,
// which FORBIDS pointing `stripRustSource` at TypeScript (blanking a payload
// makes a ban on a needle that lives INSIDE a SQL string literal pass
// vacuously). Such a file is classified NOT_APPLICABLE_TS_ONLY and is REPORTED
// BY NAME WITH ITS REASON in `detail` — never silently dropped from the
// enumeration, because a silent exclusion is exactly the hole this gate exists
// to prevent. It does NOT count as migrated (tooth T8 pins that distinction).
//
// A gated file that DOES read Rust counts as MIGRATED only if it passes BOTH
// legs:
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
import { compactWs, containsIdent } from './rust-scan.mjs';

const AUDIT_FILE_NAME = 'scanner-migration-audit.eval.mjs';
const SECURITY_SUFFIX = '-security.eval.mjs';
const PRIVACY_SUFFIX = '-privacy.eval.mjs';

// Ratchets (14r-c, measured — see report for the measurement).
const GATED_FLOOR = 18; // the name-derived gated-set size must never drop below this
// 10 = the 4 migrated by ADR-0181 (account-privacy, conversation-privacy,
// wallet-privacy, ranking-security) + the 6 migrated by 14r-c (encounter-,
// inventory-, wild-individuality-, pvp-action-, playtest-event-, monster-privacy).
const MIGRATED_FLOOR = 10;
// UPPER BOUND (not an equality) on KNOWN_UNMIGRATED.length: an EIGHTH park needs
// this constant raised in the same diff, in the open. Under-cap is a NON-BLOCKING
// advisory instead — see capAdvisoryNote.
const KNOWN_UNMIGRATED_CAP = 7;

// Self-retiring named debt. Every entry is validated: it must exist on disk, be
// a member of the name-derived gated set, and STILL FAIL Legs 1+2 (the moment a
// later slice migrates one, this gate REDs demanding the entry be deleted —
// T5 pins that).
//
// All seven are budget-parked to slice 14r-c-2. Each reason below is MEASURED,
// not asserted: the canary column is what THIS gate's own bonus behavioral
// check reported for that file at 14r-c (an ADR-0181 canary — a URL-scheme
// literal followed by a needle — fed to every strip/scan/prepare/blank export).
export const KNOWN_UNMIGRATED = [
  {
    file: 'battle-reducer-security.eval.mjs',
    owner: '14r-c-2',
    reason:
      'naive block+line comment stripper with no string-literal awareness (stripRustComments); ' +
      'canary-measured NOT offset-preserving (61 vs 78) — it DELETES rather than blanks, so every ' +
      'offset it hands downstream is misaligned. Budget-parked by 14r-c.',
  },
  {
    file: 'evolution-reducer-security.eval.mjs',
    owner: '14r-c-2',
    reason:
      'LIVE, REPRODUCIBLE ADR-0181 hazard, not a theoretical one: this gate canary-measured ' +
      'evolution-reducer-security#prepareRustSource SWALLOWING the needle — the URL-scheme literal ' +
      'truncates the scan and blinds every ban clause downstream (plus not offset-preserving, ' +
      '61 vs 78). Highest-priority park. Budget-parked by 14r-c.',
  },
  {
    file: 'npc-dialogue-quest-security.eval.mjs',
    owner: '14r-c-2',
    reason:
      'naive block+line comment stripper with no string-literal awareness (stripRustComments); ' +
      'canary-measured NOT offset-preserving (61 vs 78). Budget-parked by 14r-c.',
  },
  {
    file: 'raising-reducer-security.eval.mjs',
    owner: '14r-c-2',
    reason:
      'LIVE, REPRODUCIBLE ADR-0181 hazard, not a theoretical one: this gate canary-measured ' +
      'raising-reducer-security#prepareRustSource SWALLOWING the needle — the URL-scheme literal ' +
      'truncates the scan and blinds every ban clause downstream (plus not offset-preserving, ' +
      '61 vs 78). Highest-priority park. Budget-parked by 14r-c.',
  },
  {
    file: 'recruit-reducer-security.eval.mjs',
    owner: '14r-c-2',
    reason:
      'naive block+line comment stripper with no string-literal awareness (stripRustComments); ' +
      'canary-measured NOT offset-preserving (61 vs 78). Budget-parked by 14r-c.',
  },
  {
    file: 'shop-reducer-security.eval.mjs',
    owner: '14r-c-2',
    reason:
      'naive block+line comment stripper PLUS a separate stripRustStrings second pass — the exact ' +
      'strip-comments-THEN-strip-strings ordering ADR-0181 names as the false-GREEN bug; both ' +
      'canary-measured NOT offset-preserving (61 and 57 vs 78). Budget-parked by 14r-c.',
  },
  {
    file: 'trade-reducer-security.eval.mjs',
    owner: '14r-c-2',
    reason:
      'naive block+line comment stripper with no string-literal awareness; sibling of the ' +
      'trade-escrow-guards whole-crate-blob scanner ADR-0181 flagged as the widest-blast-radius ' +
      'shape, so it must be migrated alongside it. Budget-parked by 14r-c.',
  },
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

// ---------------------------------------------------------------------------
// APPLICABILITY — does this gated file actually read RUST source?
//
// Legs 1+2 demand a RUST-scanner migration, so they are meaningless for a gated
// file that never opens a `.rs` file. `evals/box-view-privacy.eval.mjs` scans
// exactly one file, `client/src/net/store.ts`; requiring it to import
// `rust-scan.mjs` would be a demand to VIOLATE ADR-0181 D4, which forbids
// pointing `stripRustSource` at TypeScript.
//
// The probe is deliberately run over the RAW source, NOT `blankJsLiterals`
// output. Every path a JS eval opens is a STRING literal
// (`readFileSync('server-module/src/schema.rs')`, or a recursive glob of the
// same tree),
// so blanking the search surface would blank away the only evidence there is.
//
// The consequence of using raw text is that a mere MENTION of the path in a
// comment also counts as "reads Rust". That direction is chosen on purpose: it
// over-includes, and over-including only ever puts a file back UNDER the
// migration requirement. The unsafe direction — a file wrongly excused from
// Legs 1+2 — is unreachable through this predicate, because a file that really
// does read Rust cannot do so without naming the path somewhere in its text.
// ---------------------------------------------------------------------------
// (A single slash is not one of this file's hazard sequences — only slash-slash,
// slash-star, star-slash and colon-slash-slash are — so this path is safe to
// write literally, exactly as `detectContentOnlyCandidates` below already does.)
const SERVER_SRC_MARKER = 'server-module/src';

/**
 * Does this eval's source read Rust source under server-module/src?
 * @param {string} rawSrc Raw eval-file text.
 * @returns {boolean} True when the file references the Rust source tree.
 */
export function readsRustSource(rawSrc) {
  return rawSrc.indexOf(SERVER_SRC_MARKER) !== -1;
}

export const CLASS_MIGRATED = 'MIGRATED';
export const CLASS_UNMIGRATED = 'UNMIGRATED';
export const CLASS_NOT_APPLICABLE = 'NOT_APPLICABLE_TS_ONLY';

export function classifyGatedFile(f, rawSrc) {
  if (!readsRustSource(rawSrc)) {
    return {
      file: f,
      classification: CLASS_NOT_APPLICABLE,
      migrated: false,
      reasons: [
        `NOT_APPLICABLE_TS_ONLY: this gated file never reads Rust source (no ${SERVER_SRC_MARKER} ` +
          'reference anywhere in its text), so the Rust-scanner migration does not apply to it. ' +
          'ADR-0181 D4 FORBIDS pointing stripRustSource at TypeScript: blanking a literal payload ' +
          'makes a ban on a needle that lives INSIDE a string literal pass vacuously. Reported ' +
          'here rather than dropped from the enumeration, and NOT counted as migrated',
      ],
    };
  }
  const leg1 = checkLeg1(rawSrc);
  const leg2reason = checkLeg2(rawSrc);
  const reasons = [...leg1.problems];
  if (leg2reason !== null) reasons.push(leg2reason);
  const migrated = reasons.length === 0;
  return {
    file: f,
    classification: migrated ? CLASS_MIGRATED : CLASS_UNMIGRATED,
    migrated,
    reasons,
  };
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
    problems.push(
      `KNOWN_UNMIGRATED has ${entries.length} entries (cap ${cap}); entries - cap = ${entries.length - cap}`,
    );
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

// '' at or above cap = silence (the legal steady state); below cap = a NON-BLOCKING advisory.
// Deleted together with KNOWN_UNMIGRATED and its cap by slice 15r-sec-mig-d.
export function capAdvisoryNote(entryCount, cap) {
  if (entryCount >= cap) return '';
  return ` | cap-advisory (NON-BLOCKING): ${cap - entryCount} below the cap of ${cap}`;
}

// Assembles `detail`'s trailing fragments. The advisory is computed HERE, not passed
// in, so no call site can drop it or hardcode it away.
export function buildDetailTail({
  entryCount,
  cap,
  naNote,
  debtNote,
  corroborationNote,
  contentNote,
}) {
  const advisory = capAdvisoryNote(entryCount, cap);
  return `${naNote}${debtNote}${advisory}${corroborationNote}${contentNote}`;
}

// ---------------------------------------------------------------------------
// Bonus behavioral corroboration (NOT sole evidence — Leg 2 is what closes
// the dead-code bypass). For each gated file, import it and, for every export
// whose name starts with strip/scan/prepare/blank, feed an ADR-0181 canary
// (a URL-scheme literal — CANARY_SRC below — followed by a needle) and
// require the needle to SURVIVE and the output length to match the canary's.
// An import failure counts as that file's FAIL — never a silent skip.
//
// Returns {file, message} pairs rather than bare strings so the caller can
// attribute each result to its file — see the ENFORCED / CORROBORATING split at
// the call site.
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
      failures.push({
        file: f,
        message:
          `BONUS/import: evals/${f} threw on import — ${e?.message ?? String(e)} (an import failure ` +
          "counts as this file's FAIL, never a silent skip)",
      });
      continue;
    }
    for (const [exportName, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue;
      if (!STRIP_EXPORT_PREFIXES.some((p) => exportName.startsWith(p))) continue;
      let out;
      try {
        out = fn(CANARY_SRC);
      } catch (e) {
        failures.push({
          file: f,
          message: `BONUS/${f}#${exportName}: threw on ADR-0181 canary — ${e?.message ?? String(e)}`,
        });
        continue;
      }
      if (typeof out !== 'string') continue; // not a single-string source transform; not this check's business
      if (out.indexOf(CANARY_NEEDLE) === -1) {
        failures.push({
          file: f,
          message:
            `BONUS/${f}#${exportName}: canary needle was SWALLOWED — the canary's URL-scheme literal ` +
            'truncated the scan (the exact ADR-0181 hazard) or the function is otherwise unsound',
        });
      }
      if (out.length !== CANARY_SRC.length) {
        failures.push({
          file: f,
          message: `BONUS/${f}#${exportName}: output length ${out.length} != canary length ${CANARY_SRC.length} (not offset-preserving)`,
        });
      }
    }
  }
  return failures;
}

/**
 * Split canary failures into the ENFORCED set (hard failures) and the
 * CORROBORATING set (canary failures on files already parked in
 * KNOWN_UNMIGRATED, which ARE the measured evidence for those entries and are
 * reported rather than double-counted as failures).
 *
 * The exemption is narrow by construction and cannot be used to silence a
 * healthy file: `validateKnownUnmigratedEntries` REDs for any entry whose file
 * already passes Legs 1+2, so a park is only ever accepted for a file that is
 * genuinely unmigrated. Tooth T9 pins that a NON-parked file's canary failure is
 * still enforced.
 * @param {Array<{file:string, message:string}>} bonusFailures Canary results.
 * @param {Set<string>} debtFileSet Files listed in KNOWN_UNMIGRATED.
 * @returns {{enforced:string[], corroborating:string[]}} The split.
 */
export function partitionBonusFailures(bonusFailures, debtFileSet) {
  const enforced = [];
  const corroborating = [];
  for (const b of bonusFailures) {
    if (debtFileSet.has(b.file)) corroborating.push(b.message);
    else enforced.push(b.message);
  }
  return { enforced, corroborating };
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
    if (!readsRustSource(src)) continue; // same "does it read Rust?" probe as classifyGatedFile
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

  // T8 — APPLICABILITY (14r-c). A gated file that reads NO Rust must classify as
  // NOT_APPLICABLE_TS_ONLY — never as MIGRATED (which would silently inflate the
  // migrated count and let a real regression hide behind the ratchet), and never
  // as UNMIGRATED (which would demand it violate ADR-0181 D4). The three
  // sub-checks together pin BOTH directions, so the exemption cannot widen into
  // a blanket excuse.
  {
    // T8a — a TS-only gated file: no Rust reference, no import, no assert.
    const tsOnly =
      "import { readFileSync } from 'node:fs';\n" +
      'export default async function () {\n' +
      "  const src = readFileSync('client/src/net/store.ts', 'utf8');\n" +
      "  return { pass: src.indexOf('iv_hp') === -1 };\n" +
      '}\n';
    const r8a = classifyGatedFile('zzz-ts-only-privacy.eval.mjs', tsOnly);
    if (r8a.classification !== CLASS_NOT_APPLICABLE) {
      teeth.push(
        `T8a FAILED: a TS-only gated file (scans client/src only, reads no Rust) classified as ` +
          `${r8a.classification} instead of ${CLASS_NOT_APPLICABLE} — kills: a gate that demands a ` +
          'TypeScript-only eval import the Rust scanner, which ADR-0181 D4 explicitly FORBIDS',
      );
    }
    if (r8a.migrated) {
      teeth.push(
        'T8a FAILED: a NOT_APPLICABLE_TS_ONLY file was counted as MIGRATED — kills: an ' +
          'applicability exemption that inflates the migrated count and lets a real regression ' +
          'hide behind MIGRATED_FLOOR',
      );
    }
    if (r8a.reasons.length === 0) {
      teeth.push(
        'T8a FAILED: the NOT_APPLICABLE_TS_ONLY classification carried NO reason — kills: a ' +
          'silent exclusion, which is the exact hole this gate exists to prevent',
      );
    }

    // T8b — the SAME file, but now it reads Rust. It must fall straight back
    // under the migration requirement. This is what stops T8a's exemption from
    // being a blanket "any gated file may opt out".
    const readsRust = tsOnly.replace('client/src/net/store.ts', `${SERVER_SRC_MARKER}/schema.rs`);
    const r8b = classifyGatedFile('zzz-reads-rust-privacy.eval.mjs', readsRust);
    if (r8b.classification !== CLASS_UNMIGRATED) {
      teeth.push(
        `T8b FAILED: an UNMIGRATED gated file that DOES read ${SERVER_SRC_MARKER} classified as ` +
          `${r8b.classification} — kills: an applicability predicate that excuses every gated file, ` +
          'turning the whole migration requirement off',
      );
    }

    // T8c — the live tree: the applicability predicate must be answering from
    // the file's real content, not from a name list. box-view-privacy.eval.mjs
    // scans only client/src/net/store.ts.
    let boxSrc = null;
    try {
      boxSrc = readFileSync('evals/box-view-privacy.eval.mjs', 'utf8');
    } catch {
      boxSrc = null;
    }
    if (boxSrc === null) {
      teeth.push(
        'T8c FAILED: evals/box-view-privacy.eval.mjs could not be read — the applicability tooth ' +
          'cannot be evaluated against the live tree (a missing fixture is a FAIL, never a skip)',
      );
    } else if (
      classifyGatedFile('box-view-privacy.eval.mjs', boxSrc).classification !== CLASS_NOT_APPLICABLE
    ) {
      teeth.push(
        'T8c FAILED: the live evals/box-view-privacy.eval.mjs (a gated file that scans only ' +
          'client/src/net/store.ts) did not classify as NOT_APPLICABLE_TS_ONLY',
      );
    }
  }

  // T9 — the debt canary exemption must stay NARROW. A canary failure on a file
  // that is NOT parked in KNOWN_UNMIGRATED must still be ENFORCED; only a
  // parked file's failure may be demoted to corroborating evidence. Kills: an
  // exemption path that swallows every canary failure and greens the gate.
  {
    const split = partitionBonusFailures(
      [
        { file: 'parked-security.eval.mjs', message: 'PARKED canary failure' },
        { file: 'live-security.eval.mjs', message: 'LIVE canary failure' },
      ],
      new Set(['parked-security.eval.mjs']),
    );
    if (split.enforced.length !== 1 || split.enforced[0] !== 'LIVE canary failure') {
      teeth.push(
        'T9 FAILED: a canary failure on a file that is NOT in KNOWN_UNMIGRATED was not ENFORCED ' +
          `(enforced=${JSON.stringify(split.enforced)}) — kills: a debt exemption that swallows ` +
          'every canary failure, greening the gate on a live ADR-0181 hazard',
      );
    }
    if (split.corroborating.length !== 1 || split.corroborating[0] !== 'PARKED canary failure') {
      teeth.push(
        'T9 FAILED: a canary failure on a KNOWN_UNMIGRATED file was not recorded as ' +
          `corroborating evidence (corroborating=${JSON.stringify(split.corroborating)}) — kills: ` +
          'a split that DROPS the measured evidence for a debt entry instead of reporting it',
      );
    }
  }

  // T10 — cap advisory (15r-a2). `KNOWN_UNMIGRATED_CAP` must stay an upper
  // bound with an advisory NOTE below it (E1), never an exact-equality trap
  // that REDs the moment a queued migration slice deletes an entry — and the
  // advisory itself must fall SILENT the instant the debt list is legally at
  // cap (E2), because a printed note at the steady state is permanent noise.
  //
  // FIXTURE RULE (do not "fix" this): 4, 6, 7, 8 and the cap 7 below are
  // LITERALS on purpose, never `KNOWN_UNMIGRATED.length` / `KNOWN_UNMIGRATED_CAP`.
  // Four queued migration slices each delete one KNOWN_UNMIGRATED entry; a
  // tooth coupled to the live count passes today at 7/7 and REDs the moment
  // one lands — verbatim the cross-slice race this slice exists to remove
  // (reproduced and measured by red-team, not hypothesized).
  const capProblems = (n, cap) => {
    const entries = [];
    for (let k = 0; k < n; k++) {
      entries.push({
        file: `synthetic-cap-${k}-security.eval.mjs`,
        owner: '15r-a2',
        reason: 'T10 fixture',
      });
    }
    // existsFn always true; every entry is a member of the gated set; none is
    // in the migrated set — so the three per-entry checks (existence,
    // membership, already-migrated) all pass, isolating the cap check alone.
    return validateKnownUnmigratedEntries(
      entries,
      new Set(entries.map((e) => e.file)),
      new Set(),
      () => true,
      cap,
    );
  };

  // T10a — under cap (6/7): advisory fires, nothing fails. Two data points
  // (6/7 and 4/7) pin the linear relation, not just one fixture's text.
  {
    const problems = capProblems(6, 7);
    if (problems.length !== 0) {
      teeth.push(
        `T10a FAILED: an under-cap (6/7) KNOWN_UNMIGRATED fixture produced ${problems.length} cap ` +
          "problem(s) — kills: a cap check widened from '>' to '!==' or '<', which would RED master " +
          'FOR DOING MORE MIGRATION the moment a queued migration slice deletes an entry',
      );
    }
    const note6 = capAdvisoryNote(6, 7);
    // The leading space before '1' AND the explicit '-1' ban together defeat a
    // sign-flipped difference (entryCount - cap instead of cap - entryCount):
    // '-1 below the cap of 7' CONTAINS the unanchored substring '1 below the
    // cap of 7', but not ' 1 below the cap of 7' (space, then '1', never '-1').
    if (
      note6.indexOf('NON-BLOCKING') === -1 ||
      note6.indexOf(' 1 below the cap of 7') === -1 ||
      note6.indexOf('-1') !== -1
    ) {
      teeth.push(
        `T10a FAILED: capAdvisoryNote(6, 7) was '${note6}', missing 'NON-BLOCKING' and/or ` +
          "' 1 below the cap of 7', or contained a sign-flipped '-1' — kills: an advisory that is " +
          'silent when it should speak, and a difference computed as entryCount - cap instead of ' +
          'cap - entryCount',
      );
    }
    // A second under-cap point (4/7): kills an advisory hardcoded to the
    // single tested fixture's text, which would keep shipping '1 below the
    // cap of 7' once the debt list actually reaches 4 or 5 entries.
    const note4 = capAdvisoryNote(4, 7);
    if (note4.indexOf('NON-BLOCKING') === -1 || note4.indexOf(' 3 below the cap of 7') === -1) {
      teeth.push(
        `T10a FAILED: capAdvisoryNote(4, 7) was '${note4}', missing 'NON-BLOCKING' and/or ` +
          "' 3 below the cap of 7' — kills: an advisory hardcoded to a single tested fixture's text " +
          "instead of computing cap - entryCount, which would ship a stale '1 below the cap of 7' " +
          'once the debt list actually shrinks further',
      );
    }
  }

  // T10b — exactly at cap (7/7): silent, nothing fails. THE LOAD-BEARING
  // FIXTURE: the ONLY tooth that catches a `>` -> `>=` widening of the cap
  // predicate (T10a at 6/7 and T10c at 8/7 both SURVIVE that mutation), and it
  // also catches an advisory predicate widened from `<` to `<=`, which would
  // turn the legal steady state into permanent noise. Do NOT assert the live
  // run's overall `pass` here — that would couple the tooth to live state.
  {
    const problems = capProblems(7, 7);
    if (problems.length !== 0) {
      teeth.push(
        `T10b FAILED: an at-cap (7/7) KNOWN_UNMIGRATED fixture produced ${problems.length} cap ` +
          "problem(s) — kills: a cap check widened from '>' to '>=', which would RED the legal " +
          'steady state (entries === cap)',
      );
    }
    const note = capAdvisoryNote(7, 7);
    if (note !== '') {
      teeth.push(
        `T10b FAILED: capAdvisoryNote(7, 7) was '${note}', not the empty string — kills: an advisory ` +
          "predicate widened from '<' to '<=', which would turn the legal at-cap steady state into " +
          'permanent noise',
      );
    }
  }

  // T10c — over cap (8/7): fails, with a message true of the observed state,
  // and NO advisory (merged from the cut T10d). The anchors ('8 entries',
  // 'cap 7', 'entries - cap = 1', and the ABSENCE of 'exceeding the cap of')
  // are all required together: red-team MEASURED that anchoring on
  // 'entries - cap = 1' alone is satisfiable by a message naming neither
  // number, and that keeping the old prose ALONGSIDE the new anchors would
  // otherwise pass unnoticed without the negative check.
  {
    const problems = capProblems(8, 7);
    const hit = problems.find(
      (p) =>
        p.indexOf('8 entries') !== -1 &&
        p.indexOf('cap 7') !== -1 &&
        p.indexOf('entries - cap = 1') !== -1 &&
        p.indexOf('exceeding the cap of') === -1,
    );
    if (hit === undefined) {
      teeth.push(
        'T10c FAILED: an over-cap (8/7) KNOWN_UNMIGRATED fixture did not produce a problem ' +
          "containing ALL of '8 entries', 'cap 7', 'entries - cap = 1' and NONE of 'exceeding the " +
          `cap of' (problems=${JSON.stringify(problems)}) — kills: a cap check deleted or weakened ` +
          'so debt accumulates silently, and a message that asserts a relation as prose instead of ' +
          '(or alongside) reporting the measured numbers',
      );
    }
    const note = capAdvisoryNote(8, 7);
    if (note !== '') {
      teeth.push(
        `T10c FAILED: capAdvisoryNote(8, 7) was '${note}', not the empty string — kills: an ` +
          "advisory predicate written '!==' instead of '<', which would print '1 below the cap of " +
          "7' in the SAME detail line as an over-cap FAILURE, a false statement emitted by the gate " +
          'itself',
      );
    }
  }

  // T10-WIRED — the advisory must actually be WIRED into `detail`, proved
  // BEHAVIORALLY rather than textually. Red-team MEASURED four working cheats
  // against a textual-needle version of this tooth (a never-called
  // declaration matching a parameter-name needle; a local shadowing
  // buildDetailTail dropping capNote while satisfying the needle; dead code
  // behind `if (false)`; a hardcoded '' capNote fed into an otherwise-real
  // call) — all reported pass=true with the advisory absent from `detail`.
  // Sub-checks (a)-(c) close all four by calling the REAL exported function
  // and asserting its RETURN VALUE; (d) is corroborating structural evidence
  // only (see its own comment below).
  {
    // (a) BEHAVIORAL, under cap. Asserts the advisory's content is present
    // AND that it sits strictly between debtNote and corroborationNote —
    // kills a tail assembler that computes the advisory and then drops it, or
    // that reorders the fragments (the exact computed-but-unwired hole).
    const under = buildDetailTail({
      entryCount: 6,
      cap: 7,
      naNote: 'ZA',
      debtNote: 'ZB',
      corroborationNote: 'ZC',
      contentNote: 'ZD',
    });
    if (
      under.indexOf('NON-BLOCKING') === -1 ||
      under.indexOf(' 1 below the cap of 7') === -1 ||
      under.indexOf('ZAZB') !== 0 ||
      under.slice(-4) !== 'ZCZD'
    ) {
      teeth.push(
        'T10-WIRED FAILED (a): buildDetailTail({entryCount: 6, cap: 7, ...}) returned ' +
          `'${under}' — kills: a tail assembler that computes the advisory and then drops it, or ` +
          'reorders the fragments (the exact computed-but-unwired hole)',
      );
    }

    // (b) BEHAVIORAL, at cap. Strict equality — kills any advisory leaking
    // into the legal steady state, and confirms silence is real rather than
    // merely ''-shaped.
    const atCap = buildDetailTail({
      entryCount: 7,
      cap: 7,
      naNote: 'ZA',
      debtNote: 'ZB',
      corroborationNote: 'ZC',
      contentNote: 'ZD',
    });
    if (atCap !== 'ZAZBZCZD') {
      teeth.push(
        'T10-WIRED FAILED (b): buildDetailTail({entryCount: 7, cap: 7, ...}) returned ' +
          `'${atCap}', not the exact string 'ZAZBZCZD' — kills: any advisory leaking into the ` +
          "legal steady state, and confirms silence is real rather than merely ''-shaped",
      );
    }

    // (c) BEHAVIORAL, over cap. Strict equality — kills an advisory printed
    // alongside an over-cap FAILURE.
    const overCap = buildDetailTail({
      entryCount: 8,
      cap: 7,
      naNote: 'ZA',
      debtNote: 'ZB',
      corroborationNote: 'ZC',
      contentNote: 'ZD',
    });
    if (overCap !== 'ZAZBZCZD') {
      teeth.push(
        'T10-WIRED FAILED (c): buildDetailTail({entryCount: 8, cap: 7, ...}) returned ' +
          `'${overCap}', not the exact string 'ZAZBZCZD' — kills: an advisory printed alongside an ` +
          'over-cap FAILURE',
      );
    }

    // (d) SELF-SOURCE, narrowed and hardened (this file's own T8c idiom: a
    // read failure is a tooth FAILURE, never a skip). Blanking is what makes
    // this sound rather than self-satisfying: the needle's own string
    // literals inside THIS file are blanked to spaces, so this check cannot
    // match itself, and a decoy occurrence in a comment or string cannot
    // satisfy it either — only a real call site in executable code can.
    let selfSrc = null;
    try {
      selfSrc = readFileSync('evals/scanner-migration-audit.eval.mjs', 'utf8');
    } catch (e) {
      teeth.push(
        'T10-WIRED FAILED (d): could not read evals/scanner-migration-audit.eval.mjs — ' +
          `${e?.message ?? String(e)} (a missing fixture is a FAIL, never a skip)`,
      );
    }
    if (selfSrc !== null) {
      // Biome (lineWidth 100, trailingComma "all") may insert a trailing
      // comma before a closing paren when it reflows a call across lines;
      // compactWs strips only whitespace, so a correctly-formatted
      // implementation would otherwise FALSE-RED here without this
      // normalization (cheap insurance; the exact reflow is not triggered by
      // today's call length, but the hazard is real).
      const compacted = compactWs(blankJsLiterals(selfSrc).blanked).split(',)').join(')');
      // An OBJECT-LITERAL ARGUMENT pattern (`{entryCount:...,cap:...,`), not a
      // parameter-name pattern: a `function buildDetailTail({entryCount, cap,
      // ...})` DECLARATION destructures with no `:` value bindings, so a
      // declaration line can never satisfy this needle — the fix for the
      // measured defeat where a never-called declaration matched a
      // parameter-name needle. It also pins that the LIVE constants, not
      // hardcoded numbers, are what get passed at the call site.
      if (
        compacted.indexOf(
          'buildDetailTail({entryCount:KNOWN_UNMIGRATED.length,cap:KNOWN_UNMIGRATED_CAP,',
        ) === -1
      ) {
        teeth.push(
          'T10-WIRED FAILED (d): no live call site buildDetailTail({entryCount: ' +
            'KNOWN_UNMIGRATED.length, cap: KNOWN_UNMIGRATED_CAP, ...}) found in executable code — ' +
            'kills: a call built from hardcoded numbers instead of the live ' +
            'KNOWN_UNMIGRATED.length / KNOWN_UNMIGRATED_CAP',
        );
      }
      // HONESTY NOTE (precedent: this file's own HONESTY NOTE, lines 59-67):
      // this needle proves the call SITE exists with the live constants, but
      // it cannot prove reachability — a deliberately SHADOWED local
      // buildDetailTail remains a known theoretical bypass. Sub-checks
      // (a)-(c) above are what carry the actual behavioral guarantee; this
      // one is corroborating structural evidence, not sole proof.
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
        classification: CLASS_UNMIGRATED,
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
  const notApplicable = results.filter((r) => r.classification === CLASS_NOT_APPLICABLE);
  const notApplicableSet = new Set(notApplicable.map((r) => r.file));
  // Only files that are genuinely UNMIGRATED (i.e. they DO read Rust and still
  // fail Legs 1+2) need debt cover. NOT_APPLICABLE files are excluded here and
  // named in `detail` below instead — reported, never dropped.
  const uncovered = results.filter(
    (r) => r.classification === CLASS_UNMIGRATED && !debtFileSet.has(r.file),
  );
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

  // The ADR-0181 canary is RUST source, so it is fed only to gated files that
  // actually scan Rust. Pointing it at a NOT_APPLICABLE_TS_ONLY file would be
  // the mirror image of the D4 violation this gate just stopped demanding: that
  // file's helpers are TypeScript scanners, deliberately literal-PRESERVING, and
  // would false-RED on a Rust fixture. Measured at 14r-c: the single such file
  // (box-view-privacy.eval.mjs) exports no strip/scan/prepare/blank function at
  // all, so this exclusion is a no-op today — it is named in `detail` regardless.
  const canaryFiles = gatedFiles.filter((f) => !notApplicableSet.has(f));
  let bonusFailures = [];
  try {
    bonusFailures = await runBonusBehavioralCheck(canaryFiles);
  } catch (e) {
    failures.push(`BONUS: bonus behavioral check threw unexpectedly — ${e?.message ?? String(e)}`);
  }

  // ENFORCED vs CORROBORATING split. A canary failure on a file that is NOT
  // parked is a hard failure. A canary failure on a KNOWN_UNMIGRATED file is the
  // EVIDENCE FOR that entry, not news: the entry is an explicit, capped,
  // membership-guarded, self-retiring admission that this file's scanner is
  // unsound, and `validateKnownUnmigratedEntries` REDs the moment the file
  // actually passes Legs 1+2 ("delete this entry"). So the exemption cannot be
  // used to silence a canary on a file that is fine — parking a healthy file is
  // itself a failure. Enforcing these would make a debt list impossible to hold
  // at all; instead every one is printed under `debt-corroboration` below, so
  // nothing is hidden.
  const { enforced: enforcedBonus, corroborating: corroboratingBonus } = partitionBonusFailures(
    bonusFailures,
    debtFileSet,
  );
  for (const m of enforcedBonus) failures.push(m);

  const contentDetected = detectContentOnlyCandidates(allEvalFiles, gatedFileSet);

  const summary =
    `${gatedFiles.length} gated / ${migratedCount} migrated / ${KNOWN_UNMIGRATED.length} debt / ` +
    `${notApplicable.length} not-applicable`;
  const naNote =
    notApplicable.length > 0
      ? ` | not-applicable (${CLASS_NOT_APPLICABLE}, Legs 1+2 and the Rust canary do not apply — ` +
        `ADR-0181 D4): ${notApplicable.map((r) => `${r.file} [${r.reasons.join('; ')}]`).join(' | ')}`
      : ' | not-applicable: none';
  const debtNote =
    KNOWN_UNMIGRATED.length > 0
      ? ` | debt (cap ${KNOWN_UNMIGRATED_CAP}, self-retiring): ${KNOWN_UNMIGRATED.map((e) => `${e.file} -> ${e.owner}`).join(', ')}`
      : ' | debt: none';
  const corroborationNote =
    corroboratingBonus.length > 0
      ? ` | debt-corroboration (canary failures on KNOWN_UNMIGRATED files — reported, not enforced, ` +
        `because they ARE the evidence for the entry): ${corroboratingBonus.join(' ; ')}`
      : ' | debt-corroboration: none';
  const contentNote =
    contentDetected.length > 0
      ? ` | content-detected (report-only, ungated by name, ADR-0181 disclosed gap): ${contentDetected.join(', ')}`
      : ' | content-detected (report-only): none found';
  // Unlike the sibling `| X: none` notes, the cap advisory is deliberately SILENT at
  // (and above) the cap — do not "fix" that into an always-present fragment.
  const tail = buildDetailTail({
    entryCount: KNOWN_UNMIGRATED.length,
    cap: KNOWN_UNMIGRATED_CAP,
    naNote,
    debtNote,
    corroborationNote,
    contentNote,
  });
  const detail =
    failures.length > 0
      ? `${summary} — FAILURES: ${failures.join(' || ')}${tail}`
      : `${summary}${tail}`;

  return { name, pass: failures.length === 0, detail };
}
