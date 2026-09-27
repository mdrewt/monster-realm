// rust-scan — the SINGLE source of truth for string-literal-aware Rust source
// scanning across evals/.
//
// WHY THIS MODULE EXISTS (13r-c, ADR-0181). Several evals used to strip Rust
// `//` line comments with a regex that has no notion of string literals. A real
// issuer URL written as an ordinary literal —
//     const ISSUER: &str = <a quote>https:<slash><slash>auth.example/<a quote>;
// — truncates at the scheme slashes, leaving ONE unmatched quote. Any later
// string pass then pairs that orphan with the next quote in the file (or, for
// the evals that concatenate the whole crate, in the next file), inverting
// string/code polarity and BLANKING real code from the scan. Every ban clause
// downstream then passes on a file it can no longer see: a FALSE GREEN on a
// security gate. `server-module/src/accounts.rs` documents the same hazard and
// still carries a `concat!()` workaround because of it.
//
// THE FIX, in one sentence: comments and string literals are lexed in the SAME
// PASS, so a slash-slash inside a literal is data and can never open a comment.
//
// CONTRACT — `stripRustSource` is LENGTH- and OFFSET-PRESERVING. It BLANKS
// literal payloads to spaces while keeping both quote characters and every
// newline. Callers therefore rely on being able to read the RAW source at
// offsets found in the STRIPPED text.
// Any "cleanup" that DELETES instead of blanking silently misaligns every one
// of those call sites. `assertStripperSound` mechanically enforces the property.
//
// DO NOT USE THIS ON TYPESCRIPT. Blanking payloads destroys the SQL subscription
// literals that the client-side privacy evals needle — and, worse, it makes a
// BAN on a string such as `FROM player_wallet` pass vacuously. TypeScript scans
// use `stripTsComments` (evals/conversation-privacy.eval.mjs), which preserves
// literal text verbatim.
//
// `independentAnchorCount` is deliberately naive and quote-BLIND, and is kept
// private here on purpose: it is the desync detector for the real stripper, and
// a shared implementation could not detect its own desync.
//
// Exports exactly what the surviving importers use (battle-schema-snapshot,
// conversation-privacy, inventory-privacy): `stripRustSource` and
// `assertStripperSound`. This file is NOT named
// `*.eval.mjs` on purpose: evals/run.mjs discovers `evals/*.eval.mjs` and would
// otherwise import it and call a non-existent default export.
//
// No `new RegExp()` anywhere (Semgrep detect-non-literal-regexp) — literal
// /regex/ and String.indexOf only.

// A bare double quote as data, so no scanner in this repo mistakes this file's
// own text for an unbalanced literal.
const DQ = String.fromCharCode(0x22);
// Block-comment delimiters as data (never written contiguously in a comment).
const SLASH_STAR = String.fromCharCode(0x2f, 0x2a);
const STAR_SLASH = String.fromCharCode(0x2a, 0x2f);

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

/**
 * Count non-overlapping occurrences of a literal needle.
 * @param {string} hay Text to search.
 * @param {string} needle Literal needle.
 * @returns {number} Occurrence count.
 */
function countOccurrences(hay, needle) {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

/**
 * Is `ch` a Rust identifier character? (`undefined` — off the end of the
 * string — is deliberately NOT one, so a prefix at index 0 still matches.)
 * @param {string|undefined} ch Single character.
 * @returns {boolean} True for [A-Za-z0-9_].
 */
function isWordChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

// ---------------------------------------------------------------------------
// stripRustSource — the canonical, string-aware, offset-preserving stripper.
//
// Order matters: STRINGS ARE LEXED FIRST in the same pass as comments, so a
// slash-slash inside a literal (a real issuer URL — accounts.rs:41-48) is data,
// not a comment start. String DELIMITERS are preserved (the two quote
// characters survive, the payload is blanked) so a downstream clause can still
// tell "this argument is a bare string literal" from "this argument is an
// expression" without ever seeing the literal's contents. Newlines survive so
// line numbers and per-line reasoning stay intact.
// ---------------------------------------------------------------------------

/**
 * Match a (byte- / C-)raw string literal starting at `i`, if any.
 * Handles `r"..."`, `r#"..."#`, `r##"..."##` (ANY hash count), `br"..."`,
 * `br##"..."##`, and the C-string forms `cr"..."` / `cr##"..."##` (Rust 1.77+),
 * closing on a quote followed by exactly that many hashes.
 * The `c` prefix is NOT optional politeness: without it the `r` of `cr"C:\"` is
 * preceded by a word character, the raw branch is skipped, and the literal is
 * lexed as an ORDINARY string whose `\"` is eaten as an escape — the exact
 * quote-polarity inversion the r/br hardening was built to close, reintroduced
 * through a prefix the hardening never enumerated.
 * @param {string} src Raw source.
 * @param {number} i Index of the `r`, `b` or `c`.
 * @returns {{openQuote:number, closeQuote:number, end:number}|null} Span, or null.
 */
function matchRawString(src, i) {
  let j = i;
  if (src[j] === 'b' || src[j] === 'c') j++;
  if (src[j] !== 'r') return null;
  j++;
  let hashes = 0;
  while (src[j] === '#') {
    hashes++;
    j++;
  }
  if (src[j] !== DQ) return null;
  const openQuote = j;
  for (let k = j + 1; k < src.length; k++) {
    if (src[k] !== DQ) continue;
    let h = 0;
    while (h < hashes && src[k + 1 + h] === '#') h++;
    if (h === hashes) return { openQuote, closeQuote: k, end: k + 1 + hashes };
  }
  // Unterminated: consume to EOF (fail loud downstream via the anchor count).
  return { openQuote, closeQuote: -1, end: src.length };
}

/**
 * Blank every comment and every string / char literal payload in Rust source,
 * preserving LENGTH and every offset (and every newline).
 * @param {string} src Raw Rust source.
 * @returns {string} Same-length source with literals and comments blanked.
 */
export function stripRustSource(src) {
  const out = src.split('');
  const len = src.length;

  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < Math.min(to, len); k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < len) {
    const c = src[i];

    // Line comment, including the `///` and `//!` doc forms.
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < len && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }

    // Block comment, NESTED-aware (Rust allows nesting).
    if (c === '/' && src[i + 1] === '*') {
      let depth = 0;
      let j = i;
      while (j < len) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
          continue;
        }
        if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
          if (depth === 0) break;
          continue;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // Raw / byte-raw / C-raw string: NO escape processing at all inside it.
    // The `c` arm costs nothing on ordinary identifiers (`crate::`, `concat!`,
    // `config` all fail the `r` + hashes + quote shape and fall straight
    // through) and closes the `cr"..."` / `cr##"..."##` desync.
    if ((c === 'r' || c === 'b' || c === 'c') && !isWordChar(src[i - 1])) {
      const raw = matchRawString(src, i);
      if (raw) {
        blank(i, raw.end);
        out[raw.openQuote] = DQ;
        if (raw.closeQuote !== -1) out[raw.closeQuote] = DQ;
        i = raw.end;
        continue;
      }
    }

    // Byte-string / byte-char / C-string prefix: blank the prefix letter, then
    // fall through so the quote itself is lexed (with escapes) next iteration.
    // `c'x'` is not a Rust literal, so the `'` arm stays `b`-only.
    if (
      !isWordChar(src[i - 1]) &&
      ((c === 'b' && (src[i + 1] === DQ || src[i + 1] === "'")) || (c === 'c' && src[i + 1] === DQ))
    ) {
      blank(i, i + 1);
      i++;
      continue;
    }

    // Ordinary string literal (escape-aware).
    if (c === DQ) {
      let j = i + 1;
      let closeQuote = -1;
      while (j < len) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === DQ) {
          closeQuote = j;
          break;
        }
        j++;
      }
      const end = closeQuote === -1 ? len : closeQuote + 1;
      blank(i, end);
      out[i] = DQ;
      if (closeQuote !== -1) out[closeQuote] = DQ;
      i = end;
      continue;
    }

    // Char literal vs LIFETIME. `'a`, `<'de>` and `'static` are types, not
    // literals, and must be left alone; `'\''`, `'\u{1F600}'` and `'\n'` are
    // literals and must be blanked.
    if (c === "'") {
      let end = -1;
      if (src[i + 1] === '\\') {
        // The only escape that can contain a quote is `\'`, whose quote sits at
        // i+2 — so the terminator is always the first quote at or after i+3.
        for (let j = i + 3; j < len; j++) {
          if (src[j] === "'") {
            end = j;
            break;
          }
        }
      } else if (src[i + 2] === "'") {
        end = i + 2;
      } else if (src[i + 3] === "'" && /[\uD800-\uDBFF]/.test(src[i + 1] ?? '')) {
        // A non-BMP char literal occupies two UTF-16 code units.
        end = i + 3;
      }
      if (end !== -1) {
        blank(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    i++;
  }

  return out.join('');
}

// ---------------------------------------------------------------------------
// The desync self-check. This is the ONLY clause that can see a stripper
// desync, because a desync is invisible to the clauses it blinds: it GREENS
// every ban clause and reds only presence clauses.
// ---------------------------------------------------------------------------

const STRIP_ANCHORS = ['pub struct', '#[spacetimedb::'];

/**
 * Count structural anchors in RAW text WITHOUT any quote tracking — the
 * independence that makes this a desync detector. Deliberately over-strips:
 * lines that open a comment, that carry a quote, or that carry a backtick are
 * skipped entirely, and each line is truncated at its first slash-slash. Every
 * one of those exclusions can only LOWER this count, and the comparison is
 * `stripped >= independent`, so over-stripping can never false-RED.
 * @param {string} raw Raw source text.
 * @param {string} anchor Literal anchor.
 * @returns {number} Independently-derived anchor count.
 */
function independentAnchorCount(raw, anchor) {
  let n = 0;
  // Block-comment state. Without it a commented-out declaration —
  //   /*
  //   pub struct OldThing { pub identity: Identity }
  //   */
  // — is counted here (the inner line starts with neither `//` nor `*`) but is
  // correctly blanked by the stripper, so `got < want` and BOTH new evals go RED
  // claiming a stripper DESYNC that did not happen. Green today only because no
  // non-test source contains a block comment; an ordinary migration edit trips
  // it. Naive on purpose: this counter must stay INDEPENDENT of the real
  // stripper (a shared implementation could not detect that stripper's desync),
  // so it deliberately does not lex strings.
  let inBlock = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      const close = line.indexOf(STAR_SLASH);
      if (close === -1) continue;
      inBlock = false;
      n += countOccurrences(line.slice(close + 2), anchor);
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith(SLASH_STAR)) {
      if (trimmed.startsWith(SLASH_STAR) && line.indexOf(STAR_SLASH) === -1) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('!')) continue;
    if (line.indexOf(DQ) !== -1 || line.indexOf('`') !== -1) continue;
    const open = line.indexOf(SLASH_STAR);
    if (open !== -1 && line.indexOf(STAR_SLASH, open) === -1) {
      inBlock = true;
      n += countOccurrences(line.slice(0, open), anchor);
      continue;
    }
    const cut = line.indexOf('//');
    n += countOccurrences(cut === -1 ? line : line.slice(0, cut), anchor);
  }
  return n;
}

/**
 * Prove the stripper did not desync on this source.
 * @param {string} src Raw source text.
 * @param {string} label Human label for the failure message (a path).
 * @param {(s: string) => string} stripFn Injected stripper (defaults to the real
 *   one; the teeth inject deliberately broken ones so this check is provably
 *   not always-green).
 * @returns {string|null} Error string, or null on pass.
 */
export function assertStripperSound(src, label = 'source', stripFn = stripRustSource) {
  const stripped = stripFn(src);

  if (stripped.length !== src.length) {
    return (
      `[STRIP/length] the stripper changed the length of ${label} ` +
      `(${src.length} -> ${stripped.length}) — every offset downstream, and every ` +
      'parser that consumes the stripped text, is now misaligned with the raw source'
    );
  }

  if (stripFn(stripped) !== stripped) {
    return (
      `[STRIP/idempotent] stripping ${label} twice differs from stripping it once — ` +
      'the lexer is leaving a quote or comment delimiter in a state that re-triggers ' +
      'on a second pass, which is the signature of unbalanced quote pairing'
    );
  }

  for (const anchor of STRIP_ANCHORS) {
    const got = countOccurrences(stripped, anchor);
    const want = independentAnchorCount(src, anchor);
    if (got < want) {
      return (
        `[STRIP/anchors] ${label}: the stripped source contains ${got} occurrence(s) of ` +
        `\`${anchor}\` but a quote-blind line scan of the RAW source finds ${want} — the ` +
        'stripper has blanked real code. This is a DESYNC: a raw string form it does not ' +
        'recognise (a zero-hash `r"..."` whose trailing backslash is wrongly eaten as an ' +
        'escape, an n-hash `r##"..."##`, or a byte raw `br##"..."##`) inverted quote ' +
        'polarity for the rest of the file. A desync GREENS every ban clause in this ' +
        'eval, so it is caught HERE or not at all'
      );
    }
  }

  return null;
}
