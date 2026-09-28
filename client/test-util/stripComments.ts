// client/test-util/stripComments.ts — shared TEST helper (never production code).
//
// Lives OUTSIDE client/src on purpose: it is not product code, so it stays out of
// the vitest coverage denominator (coverage.include = src/**/*.ts) and out of the
// production tree. Moved here verbatim (typed) from
// evals/dom-shell-coverage-exclusion.eval.mjs when that eval was deleted (debloat
// Phase 2, EV-dom-shell-coverage-exclusion); client tests import it by relative path.

/**
 * Strip JS/TS line comments (// …) and block comments (/* … *\/) from source,
 * leaving all string contents UNTOUCHED so glob patterns like `src/**\/*.ts`
 * survive stripping intact.
 *
 * A regex (`replace(/\/\*[\s\S]*?\*\//g)`) treats the `/*` inside a glob string
 * literal as a block-comment opener and mangles the string — hence this
 * quote-aware single-pass character scanner.
 *
 * States: normal | line-comment | block-comment |
 *         in-single-quote | in-double-quote | in-template-literal
 * In string/template states characters pass through untouched (backslash
 * escapes are respected so `\'` inside a single-quoted string does not
 * prematurely close it).
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const len = src.length;
  let state: 'normal' | 'line' | 'block' | 'sq' | 'dq' | 'tl' = 'normal';

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
      } else if (ch === "'") {
        state = 'sq';
        out += ch;
        i++;
      } else if (ch === '"') {
        state = 'dq';
        out += ch;
        i++;
      } else if (ch === '`') {
        state = 'tl';
        out += ch;
        i++;
      } else {
        out += ch;
        i++;
      }
    } else if (state === 'line') {
      if (ch === '\n') {
        out += '\n';
        state = 'normal';
      }
      i++;
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        i += 2;
      } else {
        i++;
      }
    } else if (state === 'sq') {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        i++;
        out += src[i];
        i++;
      } else if (ch === "'") {
        state = 'normal';
        i++;
      } else {
        i++;
      }
    } else if (state === 'dq') {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        i++;
        out += src[i];
        i++;
      } else if (ch === '"') {
        state = 'normal';
        i++;
      } else {
        i++;
      }
    } else if (state === 'tl') {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        i++;
        out += src[i];
        i++;
      } else if (ch === '`') {
        state = 'normal';
        i++;
      } else {
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
