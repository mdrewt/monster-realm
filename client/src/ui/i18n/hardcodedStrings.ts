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
// SKELETON STATE (m24-s2 T1): the exported constants and types are final; the two functions throw
// until T3 ships the implementation. Do NOT relax the test to fit a partial implementation — a
// wrong test is revised from spec §2.2/§5.2 and ADR-0257 only.

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
export function isCleanSegment(_segment: string): boolean {
  throw new Error('m24-s2: not implemented');
}

/** Scan ALREADY-COMMENT-STRIPPED source for the four sink kinds and classify each per §2.2. */
export function scanSource(_stripped: string): ScanResult {
  throw new Error('m24-s2: not implemented');
}
