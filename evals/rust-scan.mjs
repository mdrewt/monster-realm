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
// offsets found in the STRIPPED text (see account-privacy's `parseStrConsts`).
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
// Ported verbatim from evals/account-privacy.eval.mjs (which held the canonical
// copy) and evals/guest-claim-integrity.eval.mjs (whose `splitArgs` had
// diverged and was the stricter of the two). This file is NOT named
// `*.eval.mjs` on purpose: evals/run.mjs discovers `evals/*.eval.mjs` and would
// otherwise import it and call a non-existent default export.
//
// No `new RegExp()` anywhere (Semgrep detect-non-literal-regexp) — literal
// /regex/ and String.indexOf only.

// A bare double quote as data, so no scanner in this repo mistakes this file's
// own text for an unbalanced literal.
export const DQ = String.fromCharCode(0x22);
// Block-comment delimiters as data (never written contiguously in a comment).
export const SLASH_STAR = String.fromCharCode(0x2f, 0x2a);
export const STAR_SLASH = String.fromCharCode(0x2a, 0x2f);

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

/**
 * Remove ALL whitespace so needles survive rustfmt line-wrapping and stray
 * spaces (`account ()` compiles; so does a chain broken across four lines).
 * @param {string} s Source text.
 * @returns {string} Whitespace-free text.
 */
export function compactWs(s) {
  return s.replace(/\s+/g, '');
}

/**
 * Count non-overlapping occurrences of a literal needle.
 * @param {string} hay Text to search.
 * @param {string} needle Literal needle.
 * @returns {number} Occurrence count.
 */
export function countOccurrences(hay, needle) {
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
export function isWordChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Does `hay` contain `name` as a WHOLE identifier (case-sensitive)?
 * `UNRECOGNIZED_ISSUER_LOG_WINDOW_MS` must not match the binding `issuer`.
 * @param {string} hay Text to search.
 * @param {string} name Identifier.
 * @returns {boolean} True on a whole-identifier match.
 */
export function containsIdent(hay, name) {
  for (let at = hay.indexOf(name); at !== -1; at = hay.indexOf(name, at + 1)) {
    if (isWordChar(hay[at - 1])) continue;
    if (isWordChar(hay[at + name.length])) continue;
    return true;
  }
  return false;
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
export function matchRawString(src, i) {
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

/**
 * Locate a fn body by name in already-stripped source. The body `{` is the
 * first `{` at ZERO angle/paren depth after the `fn` keyword (`->` is skipped so
 * the arrow's `>` never underflows the angle depth), then brace-walked.
 * @param {string} stripped Stripped Rust source.
 * @param {string} name Exact fn identifier.
 * @returns {{start:number, end:number}|null} Body span (exclusive of braces).
 */
export function findFnBody(stripped, name) {
  const marker = `fn ${name}`;
  for (let at = stripped.indexOf(marker); at !== -1; at = stripped.indexOf(marker, at + 1)) {
    if (isWordChar(stripped[at - 1])) continue;
    if (isWordChar(stripped[at + marker.length])) continue;

    let bodyOpen = -1;
    for (let k = at, angle = 0, paren = 0; k < stripped.length; k++) {
      const ch = stripped[k];
      if (ch === '<') angle++;
      else if (ch === '>') {
        if (stripped[k - 1] !== '-') angle = Math.max(0, angle - 1);
      } else if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (ch === '{' && angle === 0 && paren === 0) {
        bodyOpen = k;
        break;
      } else if (ch === ';' && angle === 0 && paren === 0) break;
    }
    if (bodyOpen === -1) continue;

    let depth = 0;
    let j = bodyOpen;
    while (j < stripped.length) {
      if (stripped[j] === '{') depth++;
      else if (stripped[j] === '}') {
        depth--;
        if (depth === 0) return { start: bodyOpen + 1, end: j };
      }
      j++;
    }
  }
  return null;
}

/**
 * Split a call's argument text at depth-0 commas, keeping both the stripped
 * (compacted) and the RAW spelling of each argument — the raw text is how a
 * bare literal's VALUE survives blanking, and it is deliberately NOT compacted
 * (`"unrecognized issuer"` must not become `"unrecognizedissuer"`).
 * @param {string} strippedInner Stripped argument text between the parens.
 * @param {string} rawInner Raw argument text between the same parens.
 * Generic arguments are tracked (`<`/`>` at depth 0, with a `->` guard so a return
 * arrow never underflows), so `foo(Vec<A, B>, c)` splits into TWO arguments, not
 * three. This is guest-claim-integrity's copy of the two that had DIVERGED
 * (ADR-0179 §9); account-privacy's lacked the angle tracking. The stricter body
 * wins because the looser one silently mis-splits a generic argument list, and it
 * was measured to change NO current result in either consuming eval.
 * @returns {Array<{stripped:string, raw:string}>} Arguments in order.
 */
export function splitArgs(strippedInner, rawInner) {
  const bounds = [];
  let depth = 0;
  let angle = 0;
  let last = 0;
  for (let i = 0; i < strippedInner.length; i++) {
    const ch = strippedInner[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '<') angle++;
    else if (ch === '>' && strippedInner[i - 1] !== '-') angle = Math.max(0, angle - 1);
    else if (ch === ',' && depth === 0 && angle === 0) {
      bounds.push([last, i]);
      last = i + 1;
    }
  }
  bounds.push([last, strippedInner.length]);

  const args = [];
  for (const [a, b] of bounds) {
    const s = compactWs(strippedInner.slice(a, b));
    const r = rawInner.slice(a, b).trim();
    if (s === '' && r === '') continue;
    args.push({ stripped: s, raw: r });
  }
  return args;
}

/**
 * Every call site inside a span, with its callee path and split arguments.
 * @param {string} stripped Stripped whole-file source.
 * @param {string} raw Raw whole-file source (same offsets).
 * @param {number} start Span start offset.
 * @param {number} end Span end offset.
 * @returns {Array<{callee:string, args:Array<{stripped:string, raw:string}>}>} Calls.
 */
export function findCalls(stripped, raw, start, end) {
  const calls = [];
  for (let i = start; i < end; i++) {
    if (stripped[i] !== '(') continue;
    let s = i;
    while (s > start && /[A-Za-z0-9_:.!]/.test(stripped[s - 1])) s--;
    const callee = stripped.slice(s, i);
    if (callee === '') continue;

    let depth = 0;
    let close = -1;
    for (let k = i; k < end; k++) {
      if (stripped[k] === '(') depth++;
      else if (stripped[k] === ')') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close === -1) continue;
    calls.push({
      callee,
      args: splitArgs(stripped.slice(i + 1, close), raw.slice(i + 1, close)),
    });
  }
  return calls;
}
