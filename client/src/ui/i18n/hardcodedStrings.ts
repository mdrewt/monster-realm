// ui/i18n/hardcodedStrings.ts — the M24 S2 extraction-lint scanner (ADR-0257 D1-D6, spec §2.2/§5.2).
//
// A PURE, fs-free, typed scanner over ALREADY-COMMENT-STRIPPED TypeScript source. The co-located
// `hardcodedStrings.test.ts` owns the filesystem walk, the comment stripping (it imports the
// single-owner `stripComments` from `evals/dom-shell-coverage-exclusion.eval.mjs`) and the ceiling;
// this module owns the rule.
//
// LITERAL MASK ORIGIN. The string/template-literal cursor (which indices are literal TEXT, which
// are code, with template interpolations `${…}` left UNMASKED and an `unterminated` flag when the
// scan ends inside a literal) is a minimal TYPED PORT of `stringMask` at
// `evals/client-no-pii-logs.eval.mjs:166-249`. It is ported, not imported: this file is typechecked
// by `client-typecheck` (strict, no `allowJs`) and a `.mjs` import is TS7016 (ADR-0257 alt. 3).
//
// THE RULE (spec §2.2, default-fail character inversion; ADR-0257 D3 = plan R2/R3):
//   * A sink is `.textContent` / `.title` followed by optional whitespace (incl. newlines) and a
//     plain `=` (not `==`/`===`) or `+=`; `replaceChildren(`; or `setAttribute(` whose FIRST
//     argument is a bare single/double-quoted literal in SET_ATTRIBUTE_ALLOWLIST — checked BEFORE
//     any right-hand-side character is read (`'data-testid'` is excluded, never classified).
//     `??=` / `||=` / `.titleEl` / `.title(` / `vm.title;` are not sinks.
//   * The RHS span: for assignments, walk unmasked characters from after the operator tracking
//     `()[]{}` depth and stop at a depth-0 `;` `,` `)` `]` `}` or EOF (EOF at depth > 0 ⇒
//     `truncated`); for calls, the balanced-paren payload (after the first depth-0 `,` for
//     `setAttribute`).
//   * LITERALS AT ANY DEPTH: every string/template literal inside the RHS span — at any paren or
//     `${}` nesting depth — contributes its static segments: a bare literal is one segment, a
//     template contributes each run of text outside `${}` and its interpolation contents recurse.
//     The ONLY exemption is a `t(` / `tf(` CALL SPAN (identifier boundary before the name: no
//     identifier char, no `.` receiver, no whitespace between the name and `(`; balanced parens
//     skipped through the mask) — everything inside it is inert. `obj.t('Raw')`, `at('Raw')`,
//     `t ('Raw')` are NOT exempt. Zero segments ⇒ PASS (bare identifier, `String(n)`, `''`,
//     `replaceChildren()`).
//   * A segment is CLEAN iff every character is in NON_TRANSLATABLE_CHARS (33 members: 4 ASCII
//     whitespace ∪ 10 digits ∪ the 19 glyphs of §2.2). No length threshold of any kind — a lone
//     `W`, `L` or `v` fails. One failing segment fails the sink.
//   * FAIL-LOUD TRIPWIRES (D6 / plan R5): `unterminated` (mask ended inside a literal) and
//     `maskedSinkTokens` (an assignment sink shape whose token sits at an index the mask says is
//     literal text — the parity-flip signature of two regex literals each holding one quote,
//     which leaves `unterminated` FALSE). The real scan asserts both are zero/false for every file.
//
// VOCABULARY-LEAK WARNING (plan Q6/R6). Other source-scanning gates read every non-test file under
// `client/src/`, including THIS one. This file must therefore never contain — even inside a
// comment — the HTML-parsing sink tokens S0's gate bans, the overlay/a11y selector and event
// tokens the a11y evals census, or the DOM globals the render/motion evals pin. The exact
// forbidden-token list is asserted against this file's RAW source by hardcodedStrings.test.ts
// (I18N-17); keep new prose here free of DOM API names that are not part of the S2 vocabulary.
//
// NO REGULAR EXPRESSIONS, EVER — neither a regex literal (it blinds the imported comment stripper
// the test feeds this scanner with) nor the constructor form (banned by ADR-0055 / remote
// semgrep). Every matcher below is `indexOf` / char loops.
//
// LAYOUT (m24-s2 T3): `maskLiterals` (the ported cursor, plus a `text` array = literal PAYLOAD
// chars only, i.e. the mask minus the delimiters and the `${` / `}` of interpolations) →
// `scanSource` walks the source for the four tokens → `walkSpan` finds each RHS span through the
// mask → `collectSegments` takes every maximal run of `text` indices inside the span that is not
// inside a `t(` / `tf(` call span → `isCleanSegment` classifies. This scanner reads its own
// (comment-stripped) source in the real scan: the token table below holds bare tokens only, never
// a token adjacent to an assignment operator.

/** Spec §2.2 E5 / ADR-0257 D2: fewer sinks than this across the whole non-test client tree means
 *  the scanner stopped seeing the tree — a scanner failure, never a clean tree (`>=`). */
export const SINK_FLOOR = 169;

/** The 19 spec-named target files (E6, plan R9), relative to `client/src`, sorted. Each must be
 *  present in the walk and non-empty after comment stripping (I18N-HC-05); a missing one is a
 *  hard fail, never a skip. The SCAN scope is the whole non-test tree — this roster is the
 *  presence proof, not the scope (ADR-0257 D2). */
export const SCAN_TARGETS: readonly string[] = [
  'main.ts',
  'ui/battleView.ts',
  'ui/boxView.ts',
  'ui/claimView.ts',
  'ui/dialogueView.ts',
  'ui/errorOverlayView.ts',
  'ui/evolutionView.ts',
  'ui/healView.ts',
  'ui/helpView.ts',
  'ui/leaderboardView.ts',
  'ui/menuView.ts',
  'ui/pvpView.ts',
  'ui/questLogView.ts',
  'ui/raisingView.ts',
  'ui/renameView.ts',
  'ui/sessionView.ts',
  'ui/shopView.ts',
  'ui/tradeProposeView.ts',
  'ui/tradeView.ts',
];

/** Spec §5.2 [I18N-HC-02]: `setAttribute(` is a sink only when its FIRST argument is a bare
 *  quoted literal in this set. Checked before any RHS character is examined. */
export const SET_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'aria-label',
  'aria-live',
  'aria-describedby',
  'title',
  'alt',
]);

/** Spec §2.2's closed set, verbatim: whitespace ∪ digits ∪ { · × ‰ % / : ( ) [ ] , . - — + # ° ' " }.
 *  Exactly 33 members (4 ASCII whitespace + 10 digits + 19 glyphs). Whitespace is ASCII-only:
 *  U+00A0, en dash U+2013, `…`, `→`, `’` and a backslash escape are NOT members and fail toward
 *  extraction (ADR-0257 Consequences). Grows only by a reviewed PR. */
export const NON_TRANSLATABLE_CHARS: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '·',
  '×',
  '‰',
  '%',
  '/',
  ':',
  '(',
  ')',
  '[',
  ']',
  ',',
  '.',
  '-',
  '—',
  '+',
  '#',
  '°',
  "'",
  '"',
]);

/** ADR-0257 D4: the four-token sink vocabulary. */
export type SinkKind = 'textContent' | 'title' | 'replaceChildren' | 'setAttribute';

export interface Sink {
  readonly kind: SinkKind;
  /** 1-based line of the sink token in the (stripped) source handed to `scanSource`. */
  readonly line: number;
  /** The raw RHS span: the assignment's right-hand side, or the call's payload arguments. */
  readonly rhs: string;
  /** Every static segment the RHS contributes (literals at any depth outside `t(`/`tf(` spans),
   *  in source order. Empty for a literal-free RHS. */
  readonly segments: readonly string[];
  /** The subset of `segments` holding at least one character outside NON_TRANSLATABLE_CHARS. */
  readonly failingSegments: readonly string[];
  /** The RHS walk hit EOF at bracket depth > 0 — the span is untrustworthy; the real scan fails. */
  readonly truncated: boolean;
}

export interface ScanResult {
  /** Every sink found, in source order. */
  readonly sinks: readonly Sink[];
  /** Exactly the members of `sinks` whose `failingSegments` is non-empty (same order). */
  readonly failing: readonly Sink[];
  /** The literal mask ended inside a literal (unpaired quote); every answer above is untrustworthy. */
  readonly unterminated: boolean;
  /** Plan R5 tripwire: the number of ASSIGNMENT sink shapes (`.textContent` / `.title`, optional
   *  whitespace, then `=` not followed by `=`, or `+=`) whose token sits at a MASKED index — i.e.
   *  the mask thinks the sink is literal text. Non-zero means the mask has desynced without
   *  tripping `unterminated` (parity flip). Such occurrences are NOT members of `sinks`. Assignment
   *  shapes only, deliberately: this scanner scans its own source, whose token table holds the
   *  call tokens as string literals — a bare masked token is legitimate there; a masked token
   *  FOLLOWED BY AN ASSIGNMENT OPERATOR is not. */
  readonly maskedSinkTokens: number;
}

/** True iff every character of `segment` is a member of NON_TRANSLATABLE_CHARS. The empty segment
 *  is clean (vacuous truth — it carries no text). No length threshold. */
export function isCleanSegment(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    if (!NON_TRANSLATABLE_CHARS.has(segment.charAt(i))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Token table — bare tokens only (see LAYOUT above).
// ---------------------------------------------------------------------------

const TOKEN_TEXT_CONTENT = '.textContent';
const TOKEN_TITLE = '.title';
const TOKEN_REPLACE_CHILDREN = 'replaceChildren(';
const TOKEN_SET_ATTRIBUTE = 'setAttribute(';
const BACKSLASH = '\\';
const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const BACKTICK = '`';

// ---------------------------------------------------------------------------
// Literal mask — typed port of `stringMask` (evals/client-no-pii-logs.eval.mjs:166-249).
// ---------------------------------------------------------------------------

type FrameKind = 'sq' | 'dq' | 'tl' | 'expr';

interface Frame {
  readonly kind: FrameKind;
  /** Brace depth inside an `expr` frame (so an object literal's `}` does not close the `${`). */
  depth: number;
}

interface LiteralMask {
  /** `masked[i]`: index i is literal syntax OR literal text (the origin's `masked`). */
  readonly masked: readonly boolean[];
  /** `text[i]`: index i is literal PAYLOAD — excludes the delimiters and the `${` / `}` of an
   *  interpolation, so a static segment is exactly a maximal run of `text` indices. */
  readonly text: readonly boolean[];
  /** The scan ended inside a literal (or an interpolation): the mask is untrustworthy. */
  readonly unterminated: boolean;
}

function frameFor(quote: string): FrameKind {
  if (quote === SINGLE_QUOTE) return 'sq';
  if (quote === DOUBLE_QUOTE) return 'dq';
  return 'tl';
}

function maskLiterals(src: string): LiteralMask {
  const n = src.length;
  const masked: boolean[] = new Array<boolean>(n).fill(false);
  const text: boolean[] = new Array<boolean>(n).fill(false);
  const stack: Frame[] = [];
  let i = 0;
  while (i < n) {
    const ch = src.charAt(i);
    const top = stack.length > 0 ? stack[stack.length - 1] : undefined;

    // Code context: outside any literal, or inside a template interpolation.
    if (top === undefined || top.kind === 'expr') {
      if (ch === SINGLE_QUOTE || ch === DOUBLE_QUOTE || ch === BACKTICK) {
        masked[i] = true;
        stack.push({ kind: frameFor(ch), depth: 0 });
      } else if (top !== undefined && ch === '{') {
        top.depth++;
      } else if (top !== undefined && ch === '}') {
        if (top.depth === 0) {
          masked[i] = true;
          stack.pop();
        } else {
          top.depth--;
        }
      }
      i++;
      continue;
    }

    // Inside a literal: every index is masked; delimiters are not text.
    masked[i] = true;
    if (ch === BACKSLASH && i + 1 < n) {
      // An escape sequence is payload (both characters) — a backslash fails toward extraction.
      text[i] = true;
      masked[i + 1] = true;
      text[i + 1] = true;
      i += 2;
      continue;
    }
    if (top.kind === 'tl') {
      if (ch === '$' && src.charAt(i + 1) === '{') {
        masked[i + 1] = true;
        stack.push({ kind: 'expr', depth: 0 });
        i += 2;
        continue;
      }
      if (ch === BACKTICK) {
        stack.pop();
        i++;
        continue;
      }
    } else if (
      (top.kind === 'sq' && ch === SINGLE_QUOTE) ||
      (top.kind === 'dq' && ch === DOUBLE_QUOTE)
    ) {
      stack.pop();
      i++;
      continue;
    }
    text[i] = true;
    i++;
  }
  return { masked, text, unterminated: stack.length > 0 };
}

// ---------------------------------------------------------------------------
// Character classes and small cursors.
// ---------------------------------------------------------------------------

function isIdentifierChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 || // _
    c === 36 // $
  );
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipWhitespace(src: string, from: number): number {
  let i = from;
  while (i < src.length && isWhitespace(src.charAt(i))) i++;
  return i;
}

/** Plan Q3: from `at`, skip whitespace (incl. newlines); an assignment operator is a `=` NOT
 *  followed by `=`, or `+=`. Returns the index just after the operator, or -1. `??=`, `||=`,
 *  `==`, `===` and any other continuation are not assignments. Reads RAW characters — the
 *  parity-flip tripwire needs the shape even when the mask says it is text. */
function assignmentOperatorEnd(src: string, at: number): number {
  const i = skipWhitespace(src, at);
  const ch = src.charAt(i);
  if (ch === '=') return src.charAt(i + 1) === '=' ? -1 : i + 1;
  if (ch === '+' && src.charAt(i + 1) === '=') return i + 2;
  return -1;
}

// ---------------------------------------------------------------------------
// RHS spans.
// ---------------------------------------------------------------------------

interface Span {
  readonly start: number;
  /** Exclusive end: the index of the terminating delimiter, or `src.length`. */
  readonly end: number;
  readonly truncated: boolean;
}

/** Walk UNMASKED characters from `start` tracking `()[]{}` depth. A depth-0 closing bracket ends
 *  the span in both modes; a depth-0 `;` or `,` ends it only in 'assignment' mode (a call's
 *  argument list is one payload). EOF: 'assignment' is truncated at depth > 0; 'call' is always
 *  truncated (its own `(` was never balanced). */
function walkSpan(
  src: string,
  mask: LiteralMask,
  start: number,
  mode: 'assignment' | 'call',
): Span {
  const n = src.length;
  let depth = 0;
  let i = start;
  while (i < n) {
    if (mask.masked[i]) {
      i++;
      continue;
    }
    const ch = src.charAt(i);
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return { start, end: i, truncated: false };
      depth--;
    } else if (mode === 'assignment' && depth === 0 && (ch === ';' || ch === ',')) {
      return { start, end: i, truncated: false };
    }
    i++;
  }
  return { start, end: n, truncated: mode === 'call' || depth > 0 };
}

/** If a bare single/double-quoted literal OPENS at `at` (an unmasked-code position holding the
 *  quote), returns its payload and the index after its closing quote; otherwise undefined. */
function bareLiteralAt(
  src: string,
  mask: LiteralMask,
  at: number,
): { readonly payload: string; readonly end: number } | undefined {
  const quote = src.charAt(at);
  if (quote !== SINGLE_QUOTE && quote !== DOUBLE_QUOTE) return undefined;
  if (!mask.masked[at] || mask.text[at]) return undefined;
  let i = at + 1;
  while (i < src.length && mask.text[i]) i++;
  if (src.charAt(i) !== quote) return undefined;
  return { payload: src.slice(at + 1, i), end: i + 1 };
}

/** Spec [I18N-HC-02]: decided BEFORE any value character is read. Returns the value-argument span
 *  (after the first depth-0 `,`) when the first argument is a bare literal in the allowlist;
 *  undefined (not a sink at all) otherwise. */
function setAttributeValueSpan(
  src: string,
  mask: LiteralMask,
  afterParen: number,
): Span | undefined {
  const first = bareLiteralAt(src, mask, skipWhitespace(src, afterParen));
  if (first === undefined || !SET_ATTRIBUTE_ALLOWLIST.has(first.payload)) return undefined;
  const next = skipWhitespace(src, first.end);
  const ch = src.charAt(next);
  if (ch === ',') return walkSpan(src, mask, next + 1, 'call');
  // `setAttribute('alt')` — a bare literal with no value argument: a sink with an empty payload.
  if (ch === ')') return { start: next, end: next, truncated: false };
  // `'title' + x`, `'alt' as const`, EOF … — not a BARE literal first argument.
  return undefined;
}

// ---------------------------------------------------------------------------
// Segments.
// ---------------------------------------------------------------------------

/** Plan R3: an exempt call starts at unmasked `i` iff the name is exactly `t` or `tf`, the char
 *  before it is neither an identifier char nor `.`, and `(` follows with no whitespace. Returns
 *  the index just after that `(`, or -1. */
function exemptCallOpenAt(src: string, mask: LiteralMask, i: number): number {
  if (mask.masked[i] || src.charAt(i) !== 't') return -1;
  let open = i + 1;
  if (src.charAt(open) === 'f') open++;
  if (src.charAt(open) !== '(') return -1;
  if (i > 0) {
    const before = src.charAt(i - 1);
    if (before === '.' || isIdentifierChar(before)) return -1;
  }
  return open + 1;
}

/** Every maximal run of `text` indices inside `span` that is not inside a `t(` / `tf(` call span,
 *  in source order. Literals at any paren / interpolation depth contribute (ADR-0257 D3). */
function collectSegments(src: string, mask: LiteralMask, span: Span): string[] {
  const out: string[] = [];
  let i = span.start;
  while (i < span.end) {
    const afterOpen = exemptCallOpenAt(src, mask, i);
    if (afterOpen !== -1) {
      // Skip to the balanced `)` through the mask; everything inside is inert.
      i = walkSpan(src, mask, afterOpen, 'call').end + 1;
      continue;
    }
    if (mask.text[i]) {
      const from = i;
      while (i < span.end && mask.text[i]) i++;
      out.push(src.slice(from, i));
      continue;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

/** Scan ALREADY-COMMENT-STRIPPED source for the four sink kinds and classify each per §2.2. */
export function scanSource(stripped: string): ScanResult {
  const src = stripped;
  const n = src.length;
  const mask = maskLiterals(src);
  const sinks: Sink[] = [];
  let maskedSinkTokens = 0;

  // Incremental 1-based line lookup: sink tokens are visited in ascending index order.
  let line = 1;
  let lineCursor = 0;
  const lineAt = (idx: number): number => {
    while (lineCursor < idx) {
      if (src.charAt(lineCursor) === '\n') line++;
      lineCursor++;
    }
    return line;
  };

  const emit = (kind: SinkKind, tokenAt: number, span: Span): void => {
    const segments = collectSegments(src, mask, span);
    const failingSegments = segments.filter((s) => !isCleanSegment(s));
    sinks.push({
      kind,
      line: lineAt(tokenAt),
      rhs: src.slice(span.start, span.end),
      segments,
      failingSegments,
      truncated: span.truncated,
    });
  };

  let i = 0;
  while (i < n) {
    const ch = src.charAt(i);
    if (ch === '.') {
      let kind: SinkKind | undefined;
      let token = '';
      if (src.startsWith(TOKEN_TEXT_CONTENT, i)) {
        kind = 'textContent';
        token = TOKEN_TEXT_CONTENT;
      } else if (src.startsWith(TOKEN_TITLE, i)) {
        kind = 'title';
        token = TOKEN_TITLE;
      }
      if (kind !== undefined) {
        const rhsStart = assignmentOperatorEnd(src, i + token.length);
        if (rhsStart !== -1) {
          if (mask.masked[i]) {
            maskedSinkTokens++;
          } else {
            emit(kind, i, walkSpan(src, mask, rhsStart, 'assignment'));
          }
        }
        i += token.length;
        continue;
      }
    } else if (ch === 'r' && src.startsWith(TOKEN_REPLACE_CHILDREN, i)) {
      if (!mask.masked[i]) {
        emit('replaceChildren', i, walkSpan(src, mask, i + TOKEN_REPLACE_CHILDREN.length, 'call'));
      }
      i += TOKEN_REPLACE_CHILDREN.length;
      continue;
    } else if (ch === 's' && src.startsWith(TOKEN_SET_ATTRIBUTE, i)) {
      if (!mask.masked[i]) {
        const span = setAttributeValueSpan(src, mask, i + TOKEN_SET_ATTRIBUTE.length);
        if (span !== undefined) emit('setAttribute', i, span);
      }
      i += TOKEN_SET_ATTRIBUTE.length;
      continue;
    }
    i++;
  }

  return {
    sinks,
    failing: sinks.filter((s) => s.failingSegments.length > 0),
    unterminated: mask.unterminated,
    maskedSinkTokens,
  };
}
