// Eval: keyboard-operable rows (M23 §5.4, criteria A11Y-25 + A11Y-26;
// tags [A11Y-12], [A11Y-13], [A11Y-T3], [A11Y-T5]; slice rb-13, ADR-0216).
//
// WHY THIS FILE EXISTS AT ALL. M23 §4 row S10 declared five evals; PR #370 shipped three.
// `keyboard-operable-rows.eval.mjs` and `contrast-ratio.eval.mjs` did not land, so criteria
// A11Y-25 and A11Y-26 have had NO mechanical oracle since m23-s6 shipped the subject they were
// written to scan. That gap is residual R-m23-s6-A11Y-25; this file closes it.
//
// THE RULE. A click binding whose receiver is not a native <button>/<a> must have a keydown on
// the SAME receiver that INVOKES the same callback; no element may carry a negative tabindex
// while also carrying a listener; no tabindex may exceed 0 or be a non-integer.
//
// -------------------------------------------------------------------------------------------
// THE FOUR RULINGS A LATER READER WILL OTHERWISE RE-LITIGATE (full rationale in ADR-0216)
// -------------------------------------------------------------------------------------------
//
// D1 — IDENTITY MEANS INVOCATION, NOT TOKEN PRESENCE. §5.4 declares the vacuity attack ("an
//   empty no-op keydown satisfies a presence check") and answers it with "callback identity".
//   A red-team prototype MEASURED that identity-as-membership is barely stronger: eight inert
//   handlers passed it — a dead `if (false)` branch, a never-invoked nested arrow, a mouse-only
//   `e.button` guard (a KeyboardEvent has no `.button`), an unreachable `catch`, a statement
//   after an unconditional `return`, a LOCAL SHADOW binding a different object under the same
//   name, a wrong-event-type guard, and a contradictory `typeof` guard. Worse, the intersection
//   was satisfiable with NO callback at all, on the shared JS keyword `if`: the shipped menuView
//   pair itself intersects to `["callbacks.onInput","if"]`. So `invokedCallees` walks control
//   flow, and KEYWORD_DENY/GLOBAL_DENY are load-bearing, not belt-and-braces.
//
// D2 — THE RATCHET IS A MULTISET, NOT A SET AND NOT A CAP. A `<= 2` cap reports GREEN when an
//   accessible control is DELETED. A SET keyed on (file, receiver) was measured green on a
//   SECOND mouse-only click listener added to menuView's <ul> (27 -> 28 sites, key set still
//   size 2). Membership is not sufficiency either: each sanctioned entry RE-RUNS its own check.
//
// D3 — THE [A11Y-T5] HTML HALF IS DELEGATED, NOT RE-IMPLEMENTED. `client/src/indexShell.test.ts`
//   already ships a real happy-dom document-wide A11Y-26 forward-guard. A second hand-rolled
//   attribute scanner here would be a weaker oracle plus a drift surface — ADR-0215:22-24 records
//   m23-s10 making the same delegation choice, and ADR-0215:108-111 is the principle. But a
//   needle-only pin was MEASURED worthless against the real helpers (the entire guard replaced by
//   a self-satisfying stub, vitest green, both pins clean), so the delegation carries an
//   INVERTED-ASSERTION negative probe: neutering `toEqual([])` must make the pin RED.
//
// D4 — "RECEIVER", NOT "CHILD" — A DELIBERATE STRENGTHENING. §5.4's wording is "no native
//   <button>/<a> CHILD"; every arm here tests the RECEIVER. A click handler on an <li> that
//   merely WRAPS a button is still not keyboard-reachable at the <li>, and `ui/shopView.ts`
//   builds exactly that <li> -> <button> shape. Declared so it is not "fixed" back.
//
// -------------------------------------------------------------------------------------------
// SCOPE, AND WHAT IS DELIBERATELY NOT HERE
// -------------------------------------------------------------------------------------------
// * `evals/run.mjs` is NOT edited: it `readdir`s and filters `.eval.mjs` (`:11`), so this file is
//   auto-discovered. `REQUIRED_JUST_STEPS` is NOT edited either — `eval` is already required
//   (M23 §5.7). NOTE the consequence, declared as R-rb13-A11YE2E: `run.mjs`'s floor is at ZERO
//   files, and `ci-gate-wiring.eval.mjs`'s `A11Y_EVAL_FILES` (which would make a DELETION of this
//   file visible) is outside this slice's `touches:`. A future slice owning the justfile should
//   add the fourth entry.
// * `client/src/ui/menuView.ts` is in `touches:` as the SUBJECT and needs zero edits — it is
//   §5.4's GOOD hostile-but-correct fixture and it passes. Manufacturing a change to consume the
//   touch (e.g. planting a self-source needle) would be presence masquerading as reachability.
// * Helpers are IMPORTED, never copied (ADR-0215 single-owner). `stripTsComments` in particular
//   has three variants in this repo already; a fourth is a regression.
//
// DECLARED RESIDUALS: R-rb13-A11YE2E (above) · R-rb13-A1SCOPE (native evidence resolves to the
// nearest in-file binding, which is scope-approximate) · R-rb13-REGEXSTRIP (the imported
// `stripTsComments` is not regex-literal-aware — `evals/conversation-privacy.eval.mjs` ships a
// `startsRegexLiteral` fix this copy lacks; zero non-test `client/src` files contain a
// quote-bearing regex literal today, and a third stripper is forbidden by ADR-0215) ·
// R-rb13-T3XTIER (no cross-tier arm from an index.html `-1` id to a TS listener) ·
// R-rb13-TESTSUFFIX (`listClientSourceFiles` excludes `*.test.ts`, so a production module
// disguised with that suffix is bundled by Vite but never scanned).
//
// NO `main` GUARD (see the sibling evals). `run.mjs` imports the default export.
import { readFileSync } from 'node:fs';
import { listClientSourceFiles, stripHtmlComments } from './a11y-static-shell.eval.mjs';
import {
  findInertDelegations,
  findInertPins,
  includeSelectsTests,
  stripTsComments,
} from './overlay-a11y-manifest.eval.mjs';

export { stripTsComments };

// ---------------------------------------------------------------------------------------
// MATCHERS. Exported so a future `.ts` test can consume them without a second copy
// (ADR-0215's measured finding: `.ts` -> `.mjs` imports work under real vitest).
// ---------------------------------------------------------------------------------------

/** Tag names that are keyboard-operable with no author effort. */
const NATIVE_TAGS = Object.freeze(['button', 'a']);

/** Element interfaces whose DECLARED type is native evidence. */
const NATIVE_IFACES = Object.freeze(['HTMLButtonElement', 'HTMLAnchorElement']);

/**
 * Never a callback. `if`/`for` are here because a brace-naive callee extractor reads `if (` as a
 * call: red-team MEASURED `(e) => { if (e.repeat) return; }` — a functionally EMPTY handler —
 * passing `[A11Y-13]` on the shared token `if`, and the shipped menuView pair intersecting to
 * `["callbacks.onInput","if"]`. The builtins are here because red-team MEASURED `Boolean` and
 * `Math.max` doing the same job.
 */
const KEYWORD_DENY = Object.freeze([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'typeof',
  'function',
  'await',
  'super',
  'new',
  'delete',
  'void',
  'in',
  'of',
  'do',
  'else',
  'try',
  'throw',
  'yield',
  'instanceof',
]);
const GLOBAL_DENY = Object.freeze([
  'Boolean',
  'Number',
  'String',
  'Array',
  'Object',
  'Symbol',
  'Promise',
  'Set',
  'Map',
  'WeakMap',
  'Date',
  'RegExp',
  'JSON',
  'Math',
  'console',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'queueMicrotask',
  'requestAnimationFrame',
  'structuredClone',
  'Error',
  'globalThis',
]);

/**
 * Properties only a MouseEvent carries. A keydown guard that reads one is dead for keyboard
 * users, so nothing inside it counts as invoked — red-team's `if (e.button === 0)` cheat.
 */
const MOUSE_ONLY_PROPS = Object.freeze([
  '.button',
  '.buttons',
  '.clientX',
  '.clientY',
  '.pageX',
  '.pageY',
  '.screenX',
  '.screenY',
  '.offsetX',
  '.offsetY',
  '.detail',
  '.relatedTarget',
  '.pointerId',
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

function isIdentStart(c) {
  return c !== undefined && IDENT_START.test(c);
}
function isIdentChar(c) {
  return c !== undefined && IDENT_CHAR.test(c);
}

/** 1-based line number of an offset. Cheap and exact; no offset->line table needed at this size. */
function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

/**
 * Walk back from `end` (exclusive) over a member/call expression and return its text.
 * Handles `this.#rowsEl`, `document`, `el`, `a.b.c`, and bails (returns null) on a call
 * expression receiver like `getEl().addEventListener`, which is undecidable by design.
 */
function receiverTextBefore(src, end) {
  let i = end - 1;
  while (i >= 0 && (src[i] === ' ' || src[i] === '\n' || src[i] === '\t' || src[i] === '\r')) i--;
  if (i < 0) return null;
  if (src[i] === ')' || src[i] === ']') return null; // call/index receiver -> undecidable
  const stop = i;
  while (i >= 0 && (isIdentChar(src[i]) || src[i] === '.' || src[i] === '#')) i--;
  const text = src.slice(i + 1, stop + 1);
  if (text.length === 0) return null;
  if (!isIdentStart(text[0])) return null;
  return text;
}

/** Index of the matching closer for the opener at `open`. -1 when unbalanced. */
function matchDelim(src, open) {
  const o = src[open];
  const c = o === '(' ? ')' : o === '{' ? '}' : o === '[' ? ']' : null;
  if (c === null) return -1;
  let depth = 0;
  let i = open;
  let str = '';
  while (i < src.length) {
    const ch = src[i];
    if (str !== '') {
      if (ch === '\\') i += 2;
      else {
        if (ch === str) str = '';
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      i++;
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Split an argument-list body on top-level commas. */
function splitArgs(body) {
  const out = [];
  let depth = 0;
  let str = '';
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (str !== '') {
      cur += ch;
      if (ch === '\\') {
        if (i + 1 < body.length) cur += body[i + 1];
        i++;
      } else if (ch === str) str = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

/** The literal text of a simple quoted string, or null if `t` is not exactly one. */
function stringLiteralValue(t) {
  const s = t.trim();
  if (s.length < 2) return null;
  const q = s[0];
  if (q !== "'" && q !== '"') return null;
  if (s[s.length - 1] !== q) return null;
  const inner = s.slice(1, -1);
  if (inner.indexOf(q) !== -1 || inner.indexOf('\\') !== -1) return null;
  return inner;
}

/** Enclosing `class X` name for an offset, or null. Brace-tracked, not regex-guessed. */
function enclosingClass(src, idx) {
  const stack = [];
  let depth = 0;
  let i = 0;
  let str = '';
  let pendingClass = null;
  while (i < idx && i < src.length) {
    const ch = src[i];
    if (str !== '') {
      if (ch === '\\') i += 2;
      else {
        if (ch === str) str = '';
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      i++;
      continue;
    }
    if (ch === 'c' && src.startsWith('class ', i) && (i === 0 || !isIdentChar(src[i - 1]))) {
      let j = i + 6;
      while (j < src.length && src[j] === ' ') j++;
      let name = '';
      while (j < src.length && isIdentChar(src[j])) name += src[j++];
      pendingClass = name;
      i = j;
      continue;
    }
    if (ch === '{') {
      stack.push(pendingClass === null ? null : { name: pendingClass, depth });
      pendingClass = null;
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      depth--;
      i++;
      continue;
    }
    i++;
  }
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k] !== null) return stack[k].name;
  return null;
}

/**
 * Offset of the binding-or-assignment of `name` that is live at `useIdx`: the LAST
 * `const/let/var name =` or bare `name =` before it. A rebound `let` therefore yields a
 * DIFFERENT offset for two registrations straddling the reassignment — which is exactly how
 * `receiver` stays a scope key and not a text key (red-team S7).
 */
function bindingOffset(src, name, useIdx) {
  let best = -1;
  let i = 0;
  while (i < useIdx) {
    const at = src.indexOf(name, i);
    if (at === -1 || at >= useIdx) break;
    i = at + 1;
    if (at > 0 && isIdentChar(src[at - 1])) continue;
    const after = at + name.length;
    if (isIdentChar(src[after])) continue;
    let j = after;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
    // A type annotation may sit between the name and the `=`.
    if (src[j] === ':') {
      const eq = src.indexOf('=', j);
      const nl = src.indexOf('\n', j);
      if (eq === -1 || (nl !== -1 && eq > nl)) continue;
      j = eq;
    }
    if (src[j] !== '=' || src[j + 1] === '=' || src[j + 1] === '>') continue;
    best = at;
  }
  return best;
}

/** RHS text of the binding at `bindIdx` (to the end of the statement). */
function bindingRhs(src, bindIdx) {
  if (bindIdx < 0) return '';
  const eq = src.indexOf('=', bindIdx);
  if (eq === -1) return '';
  let i = eq + 1;
  let depth = 0;
  let str = '';
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (str !== '') {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < src.length) out += src[i + 1];
        i++;
      } else if (ch === str) str = '';
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
    }
    if (depth === 0 && (ch === ';' || ch === '\n')) break;
    out += ch;
    i++;
  }
  return out.trim();
}

/**
 * Scope-qualified receiver key. Two registrations whose receiver TEXT is identical but whose
 * BINDING is not the same binding must not compare equal (red-team S7 measured a click-only
 * `this.#el` in one class being "paired" by a different class's keydown).
 */
function receiverKey(src, text, useIdx) {
  if (text.indexOf('this.') === 0) {
    const cls = enclosingClass(src, useIdx);
    return 'class:' + String(cls) + '|' + text;
  }
  const root = text.split('.')[0];
  if (root === 'document' || root === 'window' || root === 'globalThis' || root === 'self') {
    return 'global|' + text;
  }
  const b = bindingOffset(src, root, useIdx);
  return 'bind:' + String(b) + '|' + text;
}

/** The arrow/function parameter name of a handler expression, or '' when there is none. */
function handlerParam(text) {
  const t = text.trim();
  if (t.indexOf('function') === 0) {
    const o = t.indexOf('(');
    if (o === -1) return '';
    const c = matchDelim(t, o);
    if (c === -1) return '';
    return firstParamName(t.slice(o + 1, c));
  }
  if (t[0] === '(') {
    const c = matchDelim(t, 0);
    if (c === -1) return '';
    return firstParamName(t.slice(1, c));
  }
  const arrow = t.indexOf('=>');
  if (arrow > 0) return firstParamName(t.slice(0, arrow));
  return '';
}

function firstParamName(list) {
  const first = splitArgs(list)[0];
  if (first === undefined) return '';
  let name = '';
  for (const ch of first.trim()) {
    if (!isIdentChar(ch)) break;
    name += ch;
  }
  return name;
}

/** The executable body of a handler expression: the brace block, or the expression itself. */
function handlerBody(text) {
  const t = text.trim();
  const arrow = t.indexOf('=>');
  if (arrow !== -1) {
    let i = arrow + 2;
    while (i < t.length && (t[i] === ' ' || t[i] === '\n')) i++;
    if (t[i] === '{') {
      const c = matchDelim(t, i);
      return c === -1 ? '' : t.slice(i + 1, c);
    }
    return t.slice(i); // expression-bodied arrow: `() => handler()`
  }
  const o = t.indexOf('{');
  if (o === -1) return '';
  const c = matchDelim(t, o);
  return c === -1 ? '' : t.slice(o + 1, c);
}

/** Is `cond` a guard that can never be true during a keydown? */
function deadGuard(cond, param, blockText) {
  const c = cond.trim();
  if (c === 'false' || c === '0' || c === 'null' || c === 'undefined') return true;
  for (const p of MOUSE_ONLY_PROPS) if (c.indexOf(p) !== -1) return true;
  // `e.type === 'click'` / `e.type !== 'keydown'` — a keydown handler cannot satisfy either.
  if (param !== '' && c.indexOf(param + '.type') !== -1) {
    if (c.indexOf("'keydown'") === -1 && c.indexOf('"keydown"') === -1) return true;
  }
  // A CONTRADICTORY typeof guard. `if (typeof callbacks.onInput === 'string')` cannot hold
  // for a value the block then CALLS — anything callable is typeof 'function'. Reading the
  // literal without relating it to the block is what red-team's cheat 1h exploits.
  const ti = c.indexOf('typeof ');
  if (ti !== -1) {
    let j = ti + 7;
    while (j < c.length && c[j] === ' ') j++;
    let path = '';
    while (j < c.length && (isIdentChar(c[j]) || c[j] === '.' || c[j] === '#')) path += c[j++];
    const TYPEOFS = [
      'undefined',
      'object',
      'boolean',
      'number',
      'bigint',
      'string',
      'symbol',
      'function',
    ];
    let named = null;
    for (const t of TYPEOFS) {
      if (c.indexOf("'" + t + "'") !== -1 || c.indexOf('"' + t + '"') !== -1) named = t;
    }
    if (named === null) return true; // not a real typeof result: never true
    if (named !== 'function' && path !== '' && String(blockText).indexOf(path + '(') !== -1) {
      return true; // the block calls what the guard asserts is not callable
    }
  }
  return false;
}

/**
 * Callees a body actually INVOKES on a reachable path. Token presence is not invocation:
 * red-team MEASURED eight inert handlers passing a presence test. Skipped here are dead
 * guards, everything after an unconditional top-level `return`, `catch` blocks whose `try`
 * cannot throw, and the bodies of nested function expressions (a never-called arrow).
 * Locally shadowed roots are dropped too — `const callbacks = {...}` inside the handler means
 * `callbacks.onInput` is a DIFFERENT object.
 */
function invokedCallees(body, param) {
  const shadowed = localBindings(body);
  const out = [];
  walk(body, false);
  return out;

  function walk(text, dead) {
    let i = 0;
    let str = '';
    while (i < text.length) {
      const ch = text[i];
      if (str !== '') {
        if (ch === '\\') i += 2;
        else {
          if (ch === str) str = '';
          i++;
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        str = ch;
        i++;
        continue;
      }
      // A nested arrow is DEFINED here, not called (red-team cheat 1b: `const dead = () =>
      // callbacks.onInput(...)`). Its head may be `()`, so this cannot wait until an
      // identifier path has been parsed.
      if (text.startsWith('=>', i)) {
        let b = i + 2;
        while (b < text.length && (text[b] === ' ' || text[b] === '\n')) b++;
        if (text[b] === '{') {
          const bEnd = matchDelim(text, b);
          i = bEnd === -1 ? i + 2 : bEnd + 1;
        } else {
          const semi = text.indexOf(';', b);
          i = semi === -1 ? text.length : semi;
        }
        continue;
      }
      // `return;` with no value, at this level, kills everything after it.
      if (text.startsWith('return', i) && !isIdentChar(text[i - 1]) && !isIdentChar(text[i + 6])) {
        let j = i + 6;
        while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
        if (text[j] === ';' || text[j] === '\n' || text[j] === '}') dead = true;
        i += 6;
        continue;
      }
      if (
        !isIdentStart(ch) ||
        isIdentChar(text[i - 1]) ||
        text[i - 1] === '.' ||
        text[i - 1] === '#'
      ) {
        i++;
        continue;
      }
      let j = i;
      let word = '';
      while (j < text.length && isIdentChar(text[j])) word += text[j++];

      if (word === 'if' || word === 'while' || word === 'for' || word === 'switch') {
        let k = j;
        while (k < text.length && text[k] === ' ') k++;
        if (text[k] !== '(') {
          i = j;
          continue;
        }
        const cEnd = matchDelim(text, k);
        if (cEnd === -1) {
          i = j;
          continue;
        }
        const cond = text.slice(k + 1, cEnd);
        let b = cEnd + 1;
        while (b < text.length && (text[b] === ' ' || text[b] === '\n')) b++;
        let blockText = '';
        let blockStart = -1;
        let blockEnd = -1;
        if (text[b] === '{') {
          blockEnd = matchDelim(text, b);
          if (blockEnd !== -1) {
            blockStart = b + 1;
            blockText = text.slice(blockStart, blockEnd);
          }
        } else {
          const semi = text.indexOf(';', b);
          blockStart = b;
          blockEnd = semi === -1 ? text.length : semi;
          blockText = text.slice(blockStart, blockEnd);
        }
        const blockDead = dead || (word === 'if' && deadGuard(cond, param, blockText));
        if (!blockDead) walk(cond, dead);
        if (blockStart !== -1 && blockEnd !== -1) {
          walk(blockText, blockDead);
          i = text[b] === '{' ? blockEnd + 1 : blockEnd;
          continue;
        }
        i = j;
        continue;
      }

      if (word === 'try') {
        let b = j;
        while (b < text.length && (text[b] === ' ' || text[b] === '\n')) b++;
        if (text[b] !== '{') {
          i = j;
          continue;
        }
        const bEnd = matchDelim(text, b);
        if (bEnd === -1) {
          i = j;
          continue;
        }
        const tryBody = text.slice(b + 1, bEnd);
        walk(tryBody, dead);
        const canThrow = tryBody.indexOf('throw') !== -1;
        const k = text.indexOf('catch', bEnd);
        if (k !== -1) {
          const cb = text.indexOf('{', k);
          const cbEnd = cb === -1 ? -1 : matchDelim(text, cb);
          if (cbEnd !== -1) {
            // An unreachable catch contributes nothing (red-team cheat 1d).
            walk(text.slice(cb + 1, cbEnd), dead || !canThrow);
            i = cbEnd + 1;
            continue;
          }
        }
        i = bEnd + 1;
        continue;
      }

      // A nested function expression is DEFINED here, not called (red-team cheat 1b).
      if (word === 'function') {
        const o = text.indexOf('{', j);
        const oEnd = o === -1 ? -1 : matchDelim(text, o);
        i = oEnd === -1 ? j : oEnd + 1;
        continue;
      }

      // Full dotted / private path.
      let path = word;
      let k = j;
      while (k < text.length && (text[k] === '.' || text[k] === '#')) {
        let m = k;
        let seg = '';
        while (m < text.length && (text[m] === '.' || text[m] === '#')) seg += text[m++];
        let w2 = '';
        while (m < text.length && isIdentChar(text[m])) w2 += text[m++];
        if (w2 === '') break;
        path += seg + w2;
        k = m;
      }
      let n = k;
      while (n < text.length && (text[n] === ' ' || text[n] === '\n')) n++;

      // An arrow whose params are these identifiers: skip its body, it is a definition.
      if (text.startsWith('=>', n)) {
        let b = n + 2;
        while (b < text.length && (text[b] === ' ' || text[b] === '\n')) b++;
        if (text[b] === '{') {
          const bEnd = matchDelim(text, b);
          i = bEnd === -1 ? k : bEnd + 1;
        } else {
          const semi = text.indexOf(';', b);
          i = semi === -1 ? text.length : semi;
        }
        continue;
      }
      if (text[n] === '(' && !dead) {
        const root = path.split('.')[0];
        const isDotted = path.indexOf('.') !== -1;
        if (
          isDotted &&
          KEYWORD_DENY.indexOf(word) === -1 &&
          GLOBAL_DENY.indexOf(root) === -1 &&
          shadowed.indexOf(root) === -1 &&
          !isEventNoise(path, param) &&
          out.indexOf(path) === -1
        ) {
          out.push(path);
        }
        const argEnd = matchDelim(text, n);
        if (argEnd !== -1) {
          walk(text.slice(n + 1, argEnd), dead);
          i = argEnd + 1;
          continue;
        }
      }
      i = k;
    }
  }
}

/**
 * BOUNDARY-ANCHORED (reviewer M3). A bare `callee.startsWith(param)` with the universal param
 * name `e` deletes every callee beginning with `e` — including the real module
 * `client/src/ui/eventRing.ts`'s `eventRing.push`, a false RED on correct code.
 */
function isEventNoise(path, param) {
  if (param === '') return false;
  return path === param || path.indexOf(param + '.') === 0 || path.indexOf(param + '[') === 0;
}

/** Names bound by `const`/`let`/`var` inside a handler body — these SHADOW an outer object. */
function localBindings(body) {
  const names = [];
  for (const kw of ['const ', 'let ', 'var ']) {
    let i = 0;
    while (true) {
      const at = body.indexOf(kw, i);
      if (at === -1) break;
      i = at + kw.length;
      if (at > 0 && isIdentChar(body[at - 1])) continue;
      let j = i;
      while (j < body.length && body[j] === ' ') j++;
      let n = '';
      while (j < body.length && isIdentChar(body[j])) n += body[j++];
      if (n !== '' && names.indexOf(n) === -1) names.push(n);
    }
  }
  return names;
}

const PROP_CLICK = Object.freeze(['onclick', 'ondblclick', 'onmousedown', 'onpointerdown']);
const PROP_KEY = Object.freeze(['onkeydown', 'onkeypress']);

/** Resolve a bare identifier handler to its in-file definition body; '' when not in-file. */
function resolveNamedHandler(src, name) {
  for (const kw of ['const ', 'let ', 'var ']) {
    let i = 0;
    while (true) {
      const at = src.indexOf(kw + name, i);
      if (at === -1) break;
      i = at + 1;
      if (at > 0 && isIdentChar(src[at - 1])) continue;
      if (isIdentChar(src[at + kw.length + name.length])) continue;
      const rhs = arrowRhs(src, at);
      if (rhs.indexOf('=>') !== -1 || rhs.indexOf('function') === 0) return rhs;
    }
  }
  const fi = src.indexOf('function ' + name);
  if (fi !== -1 && !isIdentChar(src[fi + 9 + name.length])) {
    const o = src.indexOf('{', fi);
    const c = o === -1 ? -1 : matchDelim(src, o);
    if (c !== -1) return src.slice(fi, c + 1);
  }
  return '';
}

/**
 * The full arrow/function initialiser of a binding, spanning the return-type annotation and a
 * multi-line body: `const onKeydown = (e: KeyboardEvent): void => { ... };`. `bindingRhsFull`
 * stops at the first balanced close-paren, which truncates that to the parameter list — the
 * reason two SHIPPED named-reference handlers (ui/focusTrap.ts:150, render/resizeWiring.ts:33)
 * first read as unresolvable.
 */
function arrowRhs(src, bindIdx) {
  const eq = src.indexOf('=', bindIdx);
  if (eq === -1) return '';
  let i = eq + 1;
  while (i < src.length && (src[i] === ' ' || src[i] === '\n')) i++;
  const start = i;
  const depth = 0;
  let str = '';
  let sawArrow = false;
  while (i < src.length) {
    const ch = src[i];
    if (str !== '') {
      if (ch === '\\') i += 2;
      else {
        if (ch === str) str = '';
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      i++;
      continue;
    }
    if (!sawArrow && src.startsWith('=>', i)) {
      sawArrow = true;
      i += 2;
      while (i < src.length && (src[i] === ' ' || src[i] === '\n')) i++;
      if (src[i] === '{') {
        const c = matchDelim(src, i);
        return c === -1 ? '' : src.slice(start, c + 1);
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      const c = matchDelim(src, i);
      if (c === -1) return '';
      i = c + 1;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      if (sawArrow) return src.slice(start, i).trim();
      if (depth === 0 && ch === ';') return src.slice(start, i).trim();
    }
    i++;
  }
  return src.slice(start).trim();
}

/** Like bindingRhs but balanced across newlines — an arrow body spans lines. */
function bindingRhsFull(src, bindIdx) {
  const eq = src.indexOf('=', bindIdx);
  if (eq === -1) return '';
  let i = eq + 1;
  while (i < src.length && (src[i] === ' ' || src[i] === '\n')) i++;
  let depth = 0;
  let str = '';
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (str !== '') {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < src.length) out += src[i + 1];
        i++;
      } else if (ch === str) str = '';
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
      out += ch;
      i++;
      if (depth === 0) break;
      continue;
    }
    if (depth === 0 && ch === ';') break;
    out += ch;
    i++;
  }
  return out.trim();
}

/** Every `X.addEventListener('<type>', ...)` and `X.on<type> = ...` site for one event family. */
function findSites(stripped, types, propNames) {
  const sites = [];
  const NEEDLE = '.addEventListener(';
  let i = 0;
  while (true) {
    const at = stripped.indexOf(NEEDLE, i);
    if (at === -1) break;
    i = at + NEEDLE.length;
    const open = at + NEEDLE.length - 1;
    const close = matchDelim(stripped, open);
    if (close === -1) continue;
    const args = splitArgs(stripped.slice(open + 1, close));
    const type = args.length > 0 ? stringLiteralValue(args[0]) : null;
    if (type === null || types.indexOf(type) === -1) continue;
    const receiver = receiverTextBefore(stripped, at);
    if (receiver === null) continue;
    const raw = args.length > 1 ? args[1] : '';
    let handlerText = raw;
    if (raw !== '' && raw.indexOf('=>') === -1 && raw.indexOf('function') !== 0) {
      const resolved = resolveNamedHandler(stripped, raw.trim());
      if (resolved !== '') handlerText = resolved;
    }
    sites.push({
      line: lineOf(stripped, at),
      receiver: receiverKey(stripped, receiver, at),
      receiverText: receiver,
      handlerText,
      spelling: 'addEventListener',
    });
  }
  for (const prop of propNames) {
    let k = 0;
    const needle = '.' + prop;
    while (true) {
      const at = stripped.indexOf(needle, k);
      if (at === -1) break;
      k = at + needle.length;
      if (isIdentChar(stripped[at + needle.length])) continue;
      let j = at + needle.length;
      while (j < stripped.length && (stripped[j] === ' ' || stripped[j] === '\t')) j++;
      if (stripped[j] !== '=' || stripped[j + 1] === '=' || stripped[j + 1] === '>') continue;
      const receiver = receiverTextBefore(stripped, at);
      if (receiver === null) continue;
      const raw = bindingRhsFull(stripped, at);
      let handlerText = raw;
      if (raw !== '' && raw.indexOf('=>') === -1 && raw.indexOf('function') !== 0) {
        const resolved = resolveNamedHandler(stripped, raw.trim());
        if (resolved !== '') handlerText = resolved;
      }
      sites.push({
        line: lineOf(stripped, at),
        receiver: receiverKey(stripped, receiver, at),
        receiverText: receiver,
        handlerText,
        spelling: 'property',
      });
    }
  }
  sites.sort((a, b) => a.line - b.line);
  return sites;
}

export function findClickSites(stripped) {
  return findSites(stripped, ['click'], PROP_CLICK);
}

export function findKeydownSites(stripped) {
  return findSites(stripped, ['keydown', 'keypress'], PROP_KEY);
}

/**
 * ARM PRECEDENCE IS LOAD-BEARING (reviewer blocker B1): `native` is resolved FIRST and
 * short-circuits. `renameView.ts:84-90` pairs `{e.stopPropagation();}` against
 * `{this.#submit();}` — an EMPTY identity intersection that must still PASS, because the
 * receiver is a real `<button>`.
 */
export function classify(stripped, site) {
  const text = site.receiverText === undefined ? '' : site.receiverText;
  if (text.indexOf('this.') === 0) {
    const field = text.slice(5);
    for (const iface of NATIVE_IFACES) {
      const decl = field + ': ' + iface;
      if (stripped.indexOf(decl) !== -1) {
        return { arm: 'native', reason: 'field declared ' + iface };
      }
    }
    return { arm: 'delegated', reason: 'this-field with no native interface declaration' };
  }
  const root = text.split('.')[0];
  if (root === 'document' || root === 'window' || root === 'globalThis' || root === 'self') {
    return { arm: 'delegated', reason: 'document/window delegation' };
  }
  const b = bindingOffset(stripped, root, indexOfSite(stripped, site));
  if (b < 0) return { arm: 'delegated', reason: 'no in-file binding for ' + root };
  const rhs = bindingRhs(stripped, b);
  const open = rhs.indexOf('(');
  if (open === -1) return { arm: 'delegated', reason: 'binding RHS is not a call: ' + rhs };
  const close = matchDelim(rhs, open);
  if (close === -1) return { arm: 'delegated', reason: 'unbalanced binding RHS' };
  const args = splitArgs(rhs.slice(open + 1, close));
  let native = null;
  for (const a of args) {
    const lit = stringLiteralValue(a);
    if (lit !== null && NATIVE_TAGS.indexOf(lit) !== -1) native = lit;
  }
  if (native === null) return { arm: 'delegated', reason: 'no native tag literal in ' + rhs };
  // FORGED EVIDENCE GUARD: every argument must be a bare identifier or a plain string
  // literal. `createElement('button' === tag ? 'button' : 'li')` and
  // `createElement('button'.replace('button','li'))` both name the literal and both build
  // an <li>; red-team measured a naive matcher arming `native` on each.
  for (const a of args) {
    if (stringLiteralValue(a) !== null) continue;
    let bare = true;
    for (const ch of a) if (!isIdentChar(ch)) bare = false;
    if (!bare || a.length === 0) {
      return { arm: 'delegated', reason: 'forged native evidence, complex argument: ' + a };
    }
  }
  return { arm: 'native', reason: 'binding RHS creates a <' + native + '>' };
}

/**
 * The `index.html` id a `this.#field` is resolved from, or null. Used ONLY by the real-tree
 * corroboration below — never by `classify`, which must stay a pure function of one source
 * string so the inline teeth can drive it over self-contained fixtures.
 */
export function fieldLookupId(stripped, field) {
  const assign = 'this.' + field + ' =';
  const at = stripped.indexOf(assign);
  if (at === -1) return null;
  // The shipped shape is INDIRECT: `const submitBtn = document.getElementById('rename-submit');`
  // then `this.#submitBtn = submitBtn as HTMLButtonElement;`. Follow one hop through the local.
  let rhs = bindingRhs(stripped, at);
  if (rhs.indexOf('getElementById(') === -1 && rhs.indexOf('querySelector(') === -1) {
    let root = '';
    for (const ch of rhs.trim()) {
      if (!isIdentChar(ch)) break;
      root += ch;
    }
    if (root === '') return null;
    const b = bindingOffset(stripped, root, at);
    if (b < 0) return null;
    rhs = bindingRhs(stripped, b);
  }
  for (const fn of ['getElementById(', 'querySelector(']) {
    const ci = rhs.indexOf(fn);
    if (ci === -1) continue;
    const open = ci + fn.length - 1;
    const close = matchDelim(rhs, open);
    if (close === -1) continue;
    const lit = stringLiteralValue(rhs.slice(open + 1, close).trim());
    if (lit === null) return null;
    return lit.indexOf('#') === 0 ? lit.slice(1) : lit;
  }
  return null;
}

function indexOfSite(stripped, site) {
  let n = 1;
  for (let i = 0; i < stripped.length; i++) {
    if (n === site.line) return i;
    if (stripped[i] === '\n') n++;
  }
  return stripped.length;
}

export function identityOk(stripped, clickSite, keydownSite) {
  const cParam = handlerParam(clickSite.handlerText);
  const kParam = handlerParam(keydownSite.handlerText);
  const cCallees = invokedCallees(handlerBody(clickSite.handlerText), cParam);
  const kCallees = invokedCallees(handlerBody(keydownSite.handlerText), kParam);
  const shared = cCallees.filter((c) => kCallees.indexOf(c) !== -1);
  if (shared.length === 0) {
    return {
      ok: false,
      shared: [],
      reason:
        'no callback is INVOKED on a reachable path by both handlers (click=' +
        JSON.stringify(cCallees) +
        ' keydown=' +
        JSON.stringify(kCallees) +
        ')',
    };
  }
  return { ok: true, shared, reason: 'both handlers invoke ' + shared.join(', ') };
}

const TAB_LOWER = 'tabindex';

/** Case-insensitive `tabindex` at `idx`? Red-team measured a mixed-case name evading the scan. */
function isTabToken(s, idx, len) {
  return s.slice(idx, idx + len).toLowerCase() === TAB_LOWER;
}

/**
 * Every tabindex WRITE, across five spellings. Red-team MEASURED 11 of 13 evasions invisible to
 * an attribute-only scan — including the canonical `el.tabIndex = -1` property write, which is
 * the literal NEGATIVE_TABINDEX_INTERACTIVE shape `[A11Y-T3]` exists to catch.
 */
export function findTabindexWrites(stripped) {
  const out = [];

  // 1. `.tabIndex = <v>` property write.
  let i = 0;
  while (true) {
    const at = stripped.indexOf('.tabIndex', i);
    if (at === -1) break;
    i = at + 9;
    if (isIdentChar(stripped[at + 9])) continue;
    let j = at + 9;
    while (j < stripped.length && (stripped[j] === ' ' || stripped[j] === '\t')) j++;
    if (stripped[j] !== '=' || stripped[j + 1] === '=' || stripped[j + 1] === '>') continue;
    const receiver = receiverTextBefore(stripped, at);
    out.push({
      line: lineOf(stripped, at),
      receiver: receiver === null ? '?' : receiverKey(stripped, receiver, at),
      receiverText: receiver === null ? '?' : receiver,
      value: bindingRhsFull(stripped, at).trim(),
      spelling: 'property',
    });
  }

  // 2/3. setAttribute / setAttributeNS, case-insensitive attribute name.
  for (const fn of ['setAttribute', 'setAttributeNS']) {
    let k = 0;
    const needle = '.' + fn + '(';
    while (true) {
      const at = stripped.indexOf(needle, k);
      if (at === -1) break;
      k = at + needle.length;
      const open = at + needle.length - 1;
      const close = matchDelim(stripped, open);
      if (close === -1) continue;
      const args = splitArgs(stripped.slice(open + 1, close));
      const nameArg = fn === 'setAttributeNS' ? args[1] : args[0];
      const valArg = fn === 'setAttributeNS' ? args[2] : args[1];
      const nameLit = nameArg === undefined ? null : stringLiteralValue(nameArg);
      if (nameLit === null || nameLit.toLowerCase() !== TAB_LOWER) continue;
      const valLit = valArg === undefined ? null : stringLiteralValue(valArg);
      const receiver = receiverTextBefore(stripped, at);
      out.push({
        line: lineOf(stripped, at),
        receiver: receiver === null ? '?' : receiverKey(stripped, receiver, at),
        receiverText: receiver === null ? '?' : receiver,
        value: valLit === null ? String(valArg) : valLit,
        spelling: fn === 'setAttributeNS' ? 'setAttributeNS' : 'setAttribute',
      });
    }
  }

  // 4. `Object.assign(el, { tabIndex: n })`.
  let a = 0;
  while (true) {
    const at = stripped.indexOf('Object.assign(', a);
    if (at === -1) break;
    a = at + 14;
    const open = at + 13;
    const close = matchDelim(stripped, open);
    if (close === -1) continue;
    const args = splitArgs(stripped.slice(open + 1, close));
    for (let n = 1; n < args.length; n++) {
      const obj = args[n];
      const ti = indexOfTabKey(obj);
      if (ti === -1) continue;
      const colon = obj.indexOf(':', ti);
      if (colon === -1) continue;
      let end = obj.indexOf(',', colon);
      if (end === -1) end = obj.indexOf('}', colon);
      if (end === -1) end = obj.length;
      const lit = stringLiteralValue(obj.slice(colon + 1, end).trim());
      out.push({
        line: lineOf(stripped, at),
        receiver: 'objassign:' + args[0],
        receiverText: args[0],
        value: lit === null ? obj.slice(colon + 1, end).trim() : lit,
        spelling: 'objectAssign',
      });
    }
  }

  // 5. Markup smuggling: an innerHTML/outerHTML/insertAdjacentHTML literal naming the attribute.
  for (const sink of ['.innerHTML', '.outerHTML', '.insertAdjacentHTML']) {
    let m = 0;
    while (true) {
      const at = stripped.indexOf(sink, m);
      if (at === -1) break;
      m = at + sink.length;
      const stmt = bindingRhsFull(stripped, at);
      const seg = stmt === '' ? stripped.slice(at, stripped.indexOf('\n', at) + 1) : stmt;
      const ti = indexOfTabKey(seg);
      if (ti === -1) continue;
      let v = '';
      const eq = seg.indexOf('=', ti);
      if (eq !== -1) {
        let p = eq + 1;
        while (p < seg.length && (seg[p] === '"' || seg[p] === "'" || seg[p] === ' ')) p++;
        while (
          p < seg.length &&
          seg[p] !== '"' &&
          seg[p] !== "'" &&
          seg[p] !== ' ' &&
          seg[p] !== '>'
        ) {
          v += seg[p++];
        }
      }
      const receiver = receiverTextBefore(stripped, at);
      out.push({
        line: lineOf(stripped, at),
        receiver: receiver === null ? '?' : receiverKey(stripped, receiver, at),
        receiverText: receiver === null ? '?' : receiver,
        value: v,
        spelling: 'innerHTML',
      });
    }
  }

  out.sort((x, y) => x.line - y.line);
  return out;
}

/** Case-insensitive index of a `tabindex`/`tabIndex` token in a fragment. */
function indexOfTabKey(text) {
  const lower = text.toLowerCase();
  return lower.indexOf(TAB_LOWER);
}

/** Does this receiver key carry a click/keydown binding anywhere in the file? */
function receiverIsInteractive(stripped, write) {
  const all = findClickSites(stripped).concat(findKeydownSites(stripped));
  for (const s of all) {
    if (s.receiver === write.receiver) return true;
    if (write.receiverText !== '?' && s.receiverText === write.receiverText) return true;
  }
  return false;
}

export function tabindexVerdict(stripped, write) {
  const raw = String(write.value).trim();
  const n = Number(raw);
  const isInt = raw.length > 0 && Number.isInteger(n) && String(n) === raw.replace(/^\+/, '');
  if (!isInt) {
    return {
      tag: '[A11Y-T5]',
      reason:
        'non-integer tabindex ' +
        JSON.stringify(raw) +
        ' — the browser drops the declaration entirely and a parseInt-only check accepts it',
    };
  }
  if (n > 0) {
    return {
      tag: '[A11Y-T5]',
      reason: 'tabindex ' + raw + ' > 0 hoists this element ahead of document order',
    };
  }
  if (n < 0 && receiverIsInteractive(stripped, write)) {
    return {
      tag: '[A11Y-T3]',
      reason:
        'NEGATIVE_TABINDEX_INTERACTIVE: ' +
        write.receiverText +
        ' carries a click/keydown binding, so a negative tabindex makes it mouse-focusable but ' +
        'removes it from the tab ring',
    };
  }
  return { tag: null, reason: 'tabindex ' + raw + ' on a receiver with no listener' };
}

/**
 * Every construct this string scan cannot DECIDE. M23 §5.4's declared residual makes this the
 * specified behaviour: identity extraction is string-scanning, not AST parsing, and a new shape
 * is a gate failure demanding a gate update — never a silent pass. Each reason names the
 * receiver or binding it could not decide, so a tooth can assert WHICH construct defeated it.
 */
export function scanFailLoud(stripped) {
  const reasons = [];
  const add = (r) => {
    if (reasons.indexOf(r) === -1) reasons.push(r);
  };

  // A registration reached through a computed member, or a receiver that is a call.
  for (const spelled of ["['addEventListener']", '["addEventListener"]']) {
    let c = 0;
    while (true) {
      const at = stripped.indexOf(spelled, c);
      if (at === -1) break;
      c = at + spelled.length;
      const recv = receiverTextBefore(stripped, at);
      add(
        'computed-member registration ' +
          spelled +
          ' on receiver ' +
          String(recv) +
          ' — a real listener the census cannot see',
      );
    }
  }

  const NEEDLE = '.addEventListener(';
  let i = 0;
  let parsed = 0;
  while (true) {
    const at = stripped.indexOf(NEEDLE, i);
    if (at === -1) break;
    i = at + NEEDLE.length;
    const open = at + NEEDLE.length - 1;
    const close = matchDelim(stripped, open);
    if (close === -1) {
      add('unbalanced addEventListener argument list at line ' + lineOf(stripped, at));
      continue;
    }
    parsed++;
    const args = splitArgs(stripped.slice(open + 1, close));
    const recv = receiverTextBefore(stripped, at);
    const where = recv === null ? 'line ' + lineOf(stripped, at) : recv;
    if (recv === null) {
      add('call-expression receiver at ' + where + ' — the receiver cannot be keyed');
      continue;
    }
    if (args.length === 0 || stringLiteralValue(args[0]) === null) {
      add(
        'non-literal event name for receiver ' +
          where +
          ' — the event type is computed, so the site cannot be classified',
      );
    }
    const h = args.length > 1 ? args[1] : '';
    if (h.indexOf('.bind(') !== -1) {
      add(
        'bound handler reference for receiver ' +
          where +
          ' — .bind() hides the body from the string scan',
      );
    } else if (h.indexOf('?') !== -1 && h.indexOf('=>') === -1) {
      add('ternary handler expression for receiver ' + where);
    } else if (h.indexOf('...') === 0) {
      add('spread handler argument for receiver ' + where);
    } else if (h !== '' && h.indexOf('=>') === -1 && h.indexOf('function') !== 0) {
      if (resolveNamedHandler(stripped, h.trim()) === '') {
        add(
          'named handler reference ' +
            h +
            ' for receiver ' +
            where +
            ' has no in-file definition, so its body cannot be analysed',
        );
      }
    }
    // A computed SELECTOR makes the element type unknowable. Guessing 'delegated' would
    // false-RED a real <button>; guessing 'native' would false-GREEN an <li>. (A computed
    // createElement TAG is different — it is forged native evidence, decidably delegated.)
    const LOOKUPS = ['querySelector', 'querySelectorAll', 'getElementById', 'closest'];
    const rootId = recv.split('.')[0];
    if (recv.indexOf('this.') !== 0) {
      const bo = bindingOffset(stripped, rootId, at);
      if (bo >= 0) {
        const r = bindingRhs(stripped, bo);
        for (const fn of LOOKUPS) {
          const call = fn + '(';
          const ci = r.indexOf(call);
          if (ci === -1) continue;
          const co = ci + call.length - 1;
          const cc = matchDelim(r, co);
          if (cc === -1) continue;
          for (const arg of splitArgs(r.slice(co + 1, cc))) {
            if (stringLiteralValue(arg) === null) {
              add(
                'computed selector ' +
                  arg +
                  ' for receiver ' +
                  recv +
                  ' — the element type is unknowable, so the arm cannot be decided',
              );
            }
          }
        }
      }
    }

    // A receiver whose ALIAS points at another binding is a legitimate shape this scan MISSES
    // rather than mis-decides (red-team S7's false-RED direction) — so it fails loud.
    const root = recv.split('.')[0];
    if (root !== 'document' && root !== 'window' && recv.indexOf('this.') !== 0) {
      const b = bindingOffset(stripped, root, at);
      if (b >= 0) {
        const rhs = bindingRhs(stripped, b);
        if (rhs.indexOf('(') === -1 && rhs.indexOf('.') !== -1 && rhs.indexOf('=>') === -1) {
          add(
            'aliased receiver ' +
              recv +
              ' = ' +
              rhs +
              ' — the alias target cannot be keyed, so a real pairing would be MISSED',
          );
        }
      }
    }
  }

  // DIVERGENCE FLOOR: every textual `addEventListener` must have been parsed as a site. This is
  // what catches `.bind`, aliasing and a const event name in one clause — red-team MEASURED an
  // inaccessible row list landing at a byte-identical census through exactly this gap.
  let raw = 0;
  let k = 0;
  while (true) {
    const at = stripped.indexOf('addEventListener', k);
    if (at === -1) break;
    k = at + 16;
    if (at > 0 && stripped[at - 1] === '.') raw++;
  }
  if (raw !== parsed) {
    add(
      'DIVERGENCE: ' +
        raw +
        ' textual addEventListener occurrence(s) but ' +
        parsed +
        ' parsed site(s) — a registration is reached by a spelling the census cannot see',
    );
  }

  // A tabindex written through a computed name or a non-literal value cannot be judged.
  for (const fn of ['setAttribute', 'setAttributeNS']) {
    let m = 0;
    const needle = '.' + fn + '(';
    while (true) {
      const at = stripped.indexOf(needle, m);
      if (at === -1) break;
      m = at + needle.length;
      const open = at + needle.length - 1;
      const close = matchDelim(stripped, open);
      if (close === -1) continue;
      const args = splitArgs(stripped.slice(open + 1, close));
      const nameArg = fn === 'setAttributeNS' ? args[1] : args[0];
      const valArg = fn === 'setAttributeNS' ? args[2] : args[1];
      if (nameArg === undefined) continue;
      const nameLit = stringLiteralValue(nameArg);
      const recv = receiverTextBefore(stripped, at);
      const where = recv === null ? 'line ' + lineOf(stripped, at) : recv;
      if (nameLit === null) {
        // Only fail loud when the computed name could BE tabindex.
        if (
          indexOfTabKey(nameArg) !== -1 ||
          nameArg.indexOf('+') !== -1 ||
          isIdentifierText(nameArg)
        ) {
          add(
            'computed attribute name ' +
              nameArg +
              ' on ' +
              where +
              ' — a tabindex write cannot be ruled out',
          );
        }
        continue;
      }
      if (nameLit.toLowerCase() !== TAB_LOWER) continue;
      if (valArg === undefined || stringLiteralValue(valArg) === null) {
        add(
          'non-literal tabindex value ' +
            String(valArg) +
            ' on ' +
            where +
            ' — the written value cannot be judged',
        );
      }
    }
  }
  let p = 0;
  while (true) {
    const at = stripped.indexOf('.tabIndex', p);
    if (at === -1) break;
    p = at + 9;
    if (isIdentChar(stripped[at + 9])) continue;
    let j = at + 9;
    while (j < stripped.length && stripped[j] === ' ') j++;
    if (stripped[j] !== '=' || stripped[j + 1] === '=') continue;
    const v = bindingRhsFull(stripped, at).trim();
    if (v !== '' && !isNumericLiteral(v)) {
      const recv = receiverTextBefore(stripped, at);
      add(
        'non-literal tabindex property value ' +
          v +
          ' on ' +
          String(recv) +
          ' — the written value cannot be judged',
      );
    }
  }
  return reasons;
}

function isIdentifierText(t) {
  const s = t.trim();
  if (s.length === 0) return false;
  if (!isIdentStart(s[0])) return false;
  for (const ch of s) if (!isIdentChar(ch)) return false;
  return true;
}

function isNumericLiteral(t) {
  const s = t.trim();
  if (s.length === 0) return false;
  const body = s[0] === '-' || s[0] === '+' ? s.slice(1) : s;
  if (body.length === 0) return false;
  for (const ch of body) if (ch < '0' || ch > '9') return false;
  return true;
}

// ======================================================================================
// GATING TEETH — written by the `tester` agent from M23 §5.4 and the MEASURED red-team cheat
// corpus. The implementer does not edit this section; a wrong tooth is revised from the spec.
// ======================================================================================
// rb-13 gating teeth for evals/keyboard-operable-rows.eval.mjs (M23 spec 5.4).
//
// WRITTEN BY THE TESTER. The implementer supplies the matcher namespace `M`; this file
// defines the CONTRACT and must not be edited to fit a buggy implementation.
//
// ---------------------------------------------------------------------------------------
// MATCHER CONTRACT (exactly these entry points, no others)
// ---------------------------------------------------------------------------------------
//   M.stripTsComments(src) -> string
//       Removes line and block comments. Must NOT remove code, and must NOT strip inside
//       string literals (the innerHTML teeth depend on literal text surviving).
//
//   M.findClickSites(stripped)   -> [{ line, receiver, handlerText, spelling }]
//   M.findKeydownSites(stripped) -> [{ line, receiver, handlerText, spelling }]
//       `spelling` is 'addEventListener' or 'property' (for `el.onclick = fn`).
//       `receiver` is a SCOPE-QUALIFIED key: two registrations whose receiver text is
//       identical but whose binding is not the same binding (different class, rebound
//       `let`) MUST NOT produce equal `receiver` values.
//       `handlerText` is the RESOLVED handler body. A named function reference
//       (`root.addEventListener('keydown', onKeydown, true)`) must be resolved to its
//       in-file definition's body, not reported as unparseable.
//
//   M.classify(stripped, site) -> { arm, reason }
//       arm 'native'    -> receiver is provably a native <button>/<a>. PASSES outright.
//       arm 'delegated' -> receiver is provably NOT native. Identity rules then apply.
//       arm null        -> undecidable (must then be reported by M.scanFailLoud).
//       `reason` must be a non-empty string.
//       ARM PRECEDENCE IS LOAD-BEARING (reviewer blocker B1): 'native' is resolved FIRST
//       and short-circuits; identity is consulted ONLY for the 'delegated' arm.
//       Native evidence requires an argument list that is EXACTLY ONE string literal
//       (a ternary or a `.replace()` is forged evidence, not native), and it is
//       RECEIVER-scoped: a `createElement('button')` elsewhere in the file is not
//       evidence about THIS receiver.
//
//   M.identityOk(stripped, clickSite, keydownSite) -> { ok, shared, reason }
//       `shared` MUST list only callees the keydown handler actually INVOKES on a
//       REACHABLE path, intersected with the callees the click body invokes. Token
//       presence is explicitly NOT invocation: a dead branch, a never-called nested
//       arrow, an unreachable catch, a locally shadowed object, or a statement after an
//       unconditional `return` contributes NOTHING to `shared`. JS keywords and builtins
//       (`if`, `for`, `Boolean`, `Math.max`) are never callbacks and never make ok true.
//
//   M.findTabindexWrites(stripped) -> [{ line, receiver, value, spelling }]
//       spelling is one of 'property' | 'setAttribute' | 'setAttributeNS' |
//       'objectAssign' | 'innerHTML'. `value` is the literal text written ('-1', '5',
//       'auto', '0.5'). Attribute names are matched case-INSENSITIVELY.
//
//   M.tabindexVerdict(stripped, write) -> { tag, reason }   tag is the tag it VIOLATES.
//       '[A11Y-T3]' negative tabindex on a receiver that itself carries a click/keydown
//                   binding; '[A11Y-T5]' value > 0 or non-integer; null when fine.
//
//   M.scanFailLoud(stripped) -> string[]
//       Reasons the source cannot be decided; [] when fully decidable. Each reason MUST
//       name the receiver / binding it could not decide, so a fail-loud tooth can assert
//       WHICH construct defeated the scanner rather than that "something" did.
//
// ---------------------------------------------------------------------------------------
// THE VERDICT COMPOSITION runTeeth() DRIVES (this is the decision procedure under test)
// ---------------------------------------------------------------------------------------
//   classify(click).arm === 'native'    -> PASS (null verdict), keydown irrelevant.
//   classify(click).arm === 'delegated' -> keydown sites whose `receiver` equals the
//       click's `receiver` are the candidate pairs.
//         no candidate            -> '[A11Y-12]'
//         candidate, none with identityOk().ok === true -> '[A11Y-13]'
//         some candidate ok       -> PASS (null verdict)
//
// ---------------------------------------------------------------------------------------
// AUTHORING RULES OBEYED HERE (mechanically re-checked at run time)
// ---------------------------------------------------------------------------------------
//   * No `main` guard, no process.exit: evals/run.mjs imports this beside the eval.
//   * No dynamic `new RegExp` anywhere (Semgrep detect-non-literal-regexp is remote-only).
//   * No raw backtick and no block-comment opener inside any fixture string; the two
//     forbidden characters are composed via String.fromCharCode so this file cannot
//     corrupt itself, and EVERY fixture is asserted clean before it is used. A GOOD
//     fixture that accidentally contained a block-comment opener was MEASURED to pass
//     vacuously at zero matched sites -- hence the structural-before-behavioural rule.

const BACKTICK = String.fromCharCode(96);
const SLASHSTAR = String.fromCharCode(47, 42);
const Q = String.fromCharCode(39);
const DQ = String.fromCharCode(34);

/** Wrap `s` in single quotes, so fixtures never need an escaped quote. */
function q(s) {
  return Q + s + Q;
}

function L(lines) {
  return lines.join('\n');
}

function ael(recv, ev) {
  return recv + '.addEventListener(' + q(ev) + ', ';
}

// ---------------------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------------------

const CLICK_BODY = ['callbacks.onInput({ kind: ' + q('click') + ' });'];
const CB_CALL_KEY = 'callbacks.onInput({ kind: ' + q('key') + ' });';

/** The shipped menuView shape: a delegated, non-native #rowsEl carrying click + keydown. */
function rowsFixture(clickLines, keyLines) {
  const out = [
    'export class V {',
    '  readonly #rowsEl: HTMLElement;',
    '  constructor(callbacks: MenuViewCallbacks) {',
    '    this.#rowsEl = document.getElementById(' + q('menu-rows') + ') as HTMLElement;',
    '    ' + ael('this.#rowsEl', 'click') + '(e) => {',
  ];
  for (const line of clickLines) out.push('      ' + line);
  out.push('    });');
  out.push('    ' + ael('this.#rowsEl', 'keydown') + '(e) => {');
  for (const line of keyLines) out.push('      ' + line);
  out.push('    });');
  out.push('  }');
  out.push('}');
  return L(out);
}

/** A BAD [A11Y-13] record whose keydown MENTIONS the callback but never invokes it. */
function inert13(id, keyLines, why) {
  return {
    id,
    tag: '[A11Y-13]',
    polarity: 'BAD',
    src: rowsFixture(CLICK_BODY, keyLines),
    expect: {
      needles: ['callbacks.onInput', 'keydown'],
      clicks: 1,
      keydowns: 1,
      clickSpelling: 'addEventListener',
      keydownSpelling: 'addEventListener',
      arm: 'delegated',
      verdict: '[A11Y-13]',
      sharedExcludes: ['callbacks.onInput'],
    },
    why,
  };
}

/** A BAD [A11Y-13] record whose keydown shares only a keyword/builtin with the click. */
function sharedToken13(id, clickLines, keyLines, token, why) {
  return {
    id,
    tag: '[A11Y-13]',
    polarity: 'BAD',
    src: rowsFixture(clickLines, keyLines),
    expect: {
      needles: ['callbacks.onInput', token],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: '[A11Y-13]',
      sharedExcludes: ['callbacks.onInput'],
    },
    why,
  };
}

/** A single tabindex write in a file with no listeners at all. */
function bareTabindexFixture(writeLine) {
  return L(['export function decorate(panel: HTMLElement): void {', '  ' + writeLine, '}']);
}

/** A tabindex write on a native button that DOES carry a click listener. */
function interactiveTabindexFixture(writeLine) {
  return L([
    'export function mount(root: HTMLElement): void {',
    '  const btn = document.createElement(' + q('button') + ');',
    '  ' + ael('btn', 'click') + '() => {',
    '    doIt();',
    '  });',
    '  ' + writeLine,
    '  root.appendChild(btn);',
    '}',
  ]);
}

function tabindexTooth(id, tag, polarity, src, spelling, value, verdictTag, needles, why, extra) {
  const expect = {
    needles,
    tabindexWrites: 1,
    tabindexSpelling: spelling,
    tabindexValue: value,
    tabindexTag: verdictTag,
  };
  if (extra) {
    for (const k of Object.keys(extra)) expect[k] = extra[k];
  }
  return { id, tag, polarity, src, expect, why };
}

function failLoudTooth(id, src, mentions, needles, why) {
  return {
    id,
    tag: '[FAIL-LOUD]',
    polarity: 'FAILLOUD',
    src,
    expect: { needles, loudAtLeast: 1, loudMentions: mentions },
    why,
  };
}

// ---------------------------------------------------------------------------------------
// TEETH
// ---------------------------------------------------------------------------------------

export const TEETH = [
  // ---- [A11Y-13] inert keydown handlers that a token-presence check passes ----------
  inert13(
    'A13-INERT-DEAD-BRANCH',
    ['if (false) {', '  ' + CB_CALL_KEY, '}'],
    'Kills a presence-check: the callback token is in the keydown body but sits behind a ' +
      'statically false branch, so no key press ever reaches it.',
  ),
  inert13(
    'A13-INERT-NESTED-ARROW',
    ['const dead = () => ' + CB_CALL_KEY.slice(0, -1) + ';'],
    'Kills a presence-check AND a naive "callee appears at any depth" walker: the arrow ' +
      'that would invoke the callback is defined and never called.',
  ),
  inert13(
    'A13-INERT-MOUSE-ONLY-GUARD',
    ['if (e.button === 0) {', '  ' + CB_CALL_KEY, '}'],
    'A KeyboardEvent has no .button, so the guard is never true for a keydown. Kills an ' +
      'impl that accepts any conditional invocation without reading the condition.',
  ),
  inert13(
    'A13-INERT-UNREACHABLE-CATCH',
    ['try {', '  const n = 1;', '} catch (err) {', '  ' + CB_CALL_KEY, '}'],
    'The try body cannot throw, so the catch is dead. Kills an impl that treats every ' +
      'block in the handler as reachable.',
  ),
  inert13(
    'A13-INERT-EARLY-RETURN',
    ['return;', CB_CALL_KEY],
    'An unconditional return precedes the call. Kills an impl that scans the whole body ' +
      'without tracking control flow.',
  ),
  inert13(
    'A13-INERT-LOCAL-SHADOW',
    ['const callbacks = { onInput(x: MenuInput) {} };', CB_CALL_KEY],
    'The call really executes -- on a locally shadowed no-op object, not the constructor ' +
      'parameter. Kills every text-keyed identity check: the callee spelling is identical.',
  ),
  inert13(
    'A13-INERT-WRONG-EVENT-TYPE',
    ['if (e.type === ' + q('click') + ') {', '  ' + CB_CALL_KEY, '}'],
    'A keydown listener can never see e.type === click. Kills an impl that reads the ' +
      'condition syntactically but not its relation to the registered event type.',
  ),
  inert13(
    'A13-INERT-TYPEOF-GUARD',
    ['if (typeof callbacks.onInput === ' + q('string') + ') {', '  ' + CB_CALL_KEY, '}'],
    'A function is never typeof "string". Kills an impl that whitelists typeof guards as ' +
      '"probably fine".',
  ),

  // ---- [A11Y-13] shared token but no shared CALLBACK --------------------------------
  sharedToken13(
    'A13-SHARED-KEYWORD-IF',
    ['if (e.target !== null) {', '  ' + CLICK_BODY[0], '}'],
    ['if (e.repeat) {', '  return;', '}'],
    'if',
    'The shipped menuView pair intersects to ["callbacks.onInput","if"]; a non-empty ' +
      'intersection therefore proves nothing. This fixture leaves ONLY "if" shared, so an ' +
      'impl that accepts a non-empty intersection goes green on a keydown that calls nothing.',
  ),
  sharedToken13(
    'A13-SHARED-KEYWORD-FOR',
    ['for (const r of rows) {', '  ' + CLICK_BODY[0], '}'],
    ['for (const r of rows) {', '  total += 1;', '}'],
    'for',
    'Same defect as the "if" tooth via a second keyword, so a one-off keyword blacklist ' +
      'containing only "if" does not survive.',
  ),
  sharedToken13(
    'A13-SHARED-BUILTIN-BOOLEAN',
    ['if (Boolean(e.target)) {', '  ' + CLICK_BODY[0], '}'],
    ['const b = Boolean(e.repeat);'],
    'Boolean',
    'Boolean is a real CALL, not a keyword, so a keyword-only blacklist accepts it as a ' +
      'shared callee. Kills that: a global builtin is never the view callback.',
  ),
  sharedToken13(
    'A13-SHARED-BUILTIN-MATH-MAX',
    ['callbacks.onInput({ kind: ' + q('click') + ', i: Math.max(0, idx) });'],
    ['const m = Math.max(2, 3);'],
    'Math.max',
    'A shared MEMBER-expression builtin. Kills a blacklist that only rejects bare ' +
      'identifiers and lets any dotted callee through as "a callback".',
  ),

  // ---- [A11Y-13] GOOD: must PASS ----------------------------------------------------
  {
    id: 'A13-GOOD-MENUVIEW-REAL-SHAPE',
    tag: '[A11Y-13]',
    polarity: 'GOOD',
    src: L([
      'export class MenuView {',
      '  readonly #rowsEl: HTMLElement;',
      '  constructor(callbacks: MenuViewCallbacks) {',
      '    this.#rowsEl = document.getElementById(' + q('menu-rows') + ') as HTMLElement;',
      '    ' + ael('this.#rowsEl', 'click') + '(e) => {',
      '      const index = this.#indexOfEventTarget(e.target);',
      '      if (index !== undefined) callbacks.onInput({ kind: ' + q('click') + ', index });',
      '    });',
      '    ' + ael('this.#rowsEl', 'mouseover') + '(e) => {',
      '      const index = this.#indexOfEventTarget(e.target);',
      '      if (index !== undefined) callbacks.onInput({ kind: ' + q('hover') + ', index });',
      '    });',
      '    ' + ael('this.#rowsEl', 'keydown') + '(e) => {',
      '      if (!this.visible) return;',
      '      if (e.repeat) return;',
      '      const input = menuKeyInput(e.code);',
      '      if (input === undefined) return;',
      '      e.preventDefault();',
      '      e.stopPropagation();',
      '      callbacks.onInput(input);',
      '    });',
      '  }',
      '}',
    ]),
    expect: {
      needles: ['callbacks.onInput(input)', 'mouseover'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: null,
      sharedIncludes: ['callbacks.onInput'],
    },
    why:
      'The LIVE menuView.ts shape. Three defects die here at once: (a) counting the ' +
      'mouseover listener as a click site (clicks must be exactly 1); (b) keying identity ' +
      'on a BARE identifier -- the spec text guessed `handleMenuInput`, but the shipped ' +
      'callee is the member expression `callbacks.onInput`, so a bare-identifier design ' +
      "false-REDs the spec's own GOOD fixture; (c) returning ok on an empty intersection -- " +
      'sharedIncludes pins the actual callee, so an empty-shared pass cannot fake it.',
  },
  {
    id: 'A13-GOOD-CALLEE-STARTSWITH-PARAM',
    tag: '[A11Y-13]',
    polarity: 'GOOD',
    src: L([
      'import { eventRing } from ' + q('./eventRing') + ';',
      'export function wireRow(row: HTMLLIElement): void {',
      '  ' + ael('row', 'click') + '(e) => {',
      '    eventRing.push({ kind: ' + q('boxOpen') + ' });',
      '  });',
      '  ' + ael('row', 'keydown') + '(e) => {',
      '    if (e.code === ' + q('Enter') + ') eventRing.push({ kind: ' + q('boxOpen') + ' });',
      '  });',
      '}',
    ]),
    expect: {
      needles: ['eventRing.push'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: null,
      sharedIncludes: ['eventRing.push'],
    },
    why:
      'client/src/ui/eventRing.ts is a real module. The handler parameter is `e` and the ' +
      'shared callee `eventRing.push` merely STARTS WITH `e`. A noise filter written as ' +
      'callee.startsWith(param) deletes the only shared callee and false-REDs a correct ' +
      'pair. This tooth kills that filter.',
  },

  // ---- [A11Y-12] BAD ----------------------------------------------------------------
  {
    id: 'A12-BAD-BARE-LI-CLICK',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(list: HTMLElement): void {',
      '  const li = document.createElement(' + q('li') + ');',
      '  ' + ael('li', 'click') + '() => {',
      '    pick(1);',
      '  });',
      '  list.appendChild(li);',
      '}',
    ]),
    expect: {
      needles: ['createElement(' + q('li') + ')'],
      clicks: 1,
      keydowns: 0,
      clickSpelling: 'addEventListener',
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why: 'The baseline violation: a non-native receiver with a click and no keydown at all.',
  },
  {
    id: 'A12-BAD-EMPTY-PAIRED-KEYDOWN',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(list: HTMLElement): void {',
      '  const li = document.createElement(' + q('li') + ');',
      '  ' + ael('li', 'click') + '() => {',
      '    pick(1);',
      '  });',
      '  ' + ael('li', 'keydown') + '() => {});',
      '  list.appendChild(li);',
      '}',
    ]),
    expect: {
      needles: ['keydown'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdictAnyOf: ['[A11Y-12]', '[A11Y-13]'],
      sharedExcludes: ['pick'],
    },
    why:
      "The spec's fixture 13: an empty keydown bought purely to satisfy a pairing check. " +
      'SPEC AMBIGUITY, DELIBERATELY NOT GUESSED: the handoff files this under [A11Y-12] ' +
      '("no VALID paired keydown") while the composition that the eight inert teeth pin ' +
      'yields [A11Y-13] (a pair exists, identity fails). Both readings agree it must FAIL, ' +
      'so this record pins the failing SET and excludes PASS / T3 / T5. Whoever settles the ' +
      'tag must edit the SPEC and then this record -- never the record alone.',
  },
  {
    id: 'A12-BAD-FILE-MENTION-ANTI-ARM',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(panel: HTMLElement): void {',
      '  const closeBtn = document.createElement(' + q('button') + ');',
      '  closeBtn.textContent = ' + q('Close') + ';',
      '  panel.appendChild(closeBtn);',
      '  const li = document.createElement(' + q('li') + ');',
      '  ' + ael('li', 'click') + '() => {',
      '    pick(2);',
      '  });',
      '}',
    ]),
    expect: {
      needles: ['createElement(' + q('button') + ')', 'createElement(' + q('li') + ')'],
      clicks: 1,
      keydowns: 0,
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why:
      'The file-mention anti-arm. An impl that arms "native" from a FILE-level ' +
      'src.includes("createElement(\'button\')") goes green here, because the button exists ' +
      'but belongs to a different element that carries no listener. Native evidence must be ' +
      'RECEIVER-scoped.',
  },
  {
    id: 'A12-BAD-ONCLICK-PROPERTY-SPELLING',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(list: HTMLElement): void {',
      '  const li = document.createElement(' + q('li') + ');',
      '  li.onclick = () => {',
      '    pick(3);',
      '  };',
      '  list.appendChild(li);',
      '}',
    ]),
    expect: {
      needles: ['li.onclick ='],
      clicks: 1,
      keydowns: 0,
      clickSpelling: 'property',
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why:
      'Red-team measured this ENTIRE class invisible: an addEventListener-only scanner ' +
      'reports zero sites here and the eval is green on a keyboard-dead row. Pinning ' +
      "clickSpelling === 'property' means the site cannot be found by accident.",
  },
  {
    id: 'A12-BAD-FORGED-NATIVE-TERNARY',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(tag: string): void {',
      '  const el = document.createElement(' +
        q('button') +
        ' === tag ? ' +
        q('button') +
        ' : ' +
        q('li') +
        ');',
      '  ' + ael('el', 'click') + '() => {',
      '    pick(4);',
      '  });',
      '}',
    ]),
    expect: {
      needles: ['? ' + q('button') + ' : ' + q('li')],
      clicks: 1,
      keydowns: 0,
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why:
      'Forged native evidence. A regex that finds createElement( followed by a button ' +
      'literal anywhere in the argument list arms "native" and passes an <li>. Native ' +
      'evidence requires an argument list of EXACTLY ONE string literal.',
  },
  {
    id: 'A12-BAD-FORGED-NATIVE-REPLACE',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(): void {',
      '  const el = document.createElement(' +
        q('button') +
        '.replace(' +
        q('button') +
        ', ' +
        q('li') +
        '));',
      '  ' + ael('el', 'click') + '() => {',
      '    pick(5);',
      '  });',
      '}',
    ]),
    expect: {
      needles: ['.replace('],
      clicks: 1,
      keydowns: 0,
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why:
      'A second forgery whose first argument STARTS with the button literal, so a ' +
      '"first argument begins with a native literal" relaxation of the ternary fix still ' +
      'dies here.',
  },

  // ---- [A11Y-12] GOOD: LIVE shapes that must PASS ------------------------------------
  {
    id: 'A12-GOOD-NATIVE-CREATEELEMENT-NO-KEYDOWN',
    tag: '[A11Y-12]',
    polarity: 'GOOD',
    src: L([
      'export function wire(root: HTMLElement): void {',
      '  const btn = document.createElement(' + q('button') + ');',
      '  btn.textContent = ' + q('Buy') + ';',
      '  ' + ael('btn', 'click') + '() => {',
      '    doBuy();',
      '  });',
      '  root.appendChild(btn);',
      '}',
    ]),
    expect: {
      needles: ['createElement(' + q('button') + ')'],
      clicks: 1,
      keydowns: 0,
      arm: 'native',
      verdict: null,
    },
    why:
      '21 shipped sites have exactly this shape. A design that demands a paired keydown ' +
      'for every click site false-REDs the whole tree; a native <button> is keyboard ' +
      'operable by the platform.',
  },
  {
    id: 'A12-GOOD-NATIVE-ENSUREELEMENT-ZERO-ARG-ARROW',
    tag: '[A11Y-12]',
    polarity: 'GOOD',
    src: L([
      'export function wire(): void {',
      '  const btn = ensureElement(' + q('save-btn') + ', ' + q('button') + ');',
      '  ' + ael('btn', 'click') + '() => handler());',
      '}',
    ]),
    expect: {
      needles: ['ensureElement('],
      clicks: 1,
      keydowns: 0,
      arm: 'native',
      verdict: null,
    },
    why:
      'Two shipped sites. Second evidence SPELLING (a helper, not document.createElement) ' +
      'plus an EXPRESSION-body zero-arg arrow, which a handler parser expecting a brace ' +
      'block truncates to the empty string.',
  },
  {
    id: 'A12-GOOD-NATIVE-TYPED-FIELD-EMPTY-INTERSECTION',
    tag: '[A11Y-12]',
    polarity: 'GOOD',
    src: L([
      'export class RenameView {',
      '  readonly #submitBtn: HTMLButtonElement;',
      '  constructor(cbs: RenameCallbacks) {',
      '    this.#submitBtn = document.getElementById(' +
        q('rename-submit') +
        ') as HTMLButtonElement;',
      '    ' + ael('this.#submitBtn', 'keydown') + '(e) => {',
      '      e.stopPropagation();',
      '    });',
      '    ' + ael('this.#submitBtn', 'click') + '() => {',
      '      this.#submit();',
      '    });',
      '  }',
      '}',
    ]),
    expect: {
      needles: ['HTMLButtonElement', 'this.#submit()'],
      clicks: 1,
      keydowns: 1,
      arm: 'native',
      verdict: null,
      identityWouldFail: true,
    },
    why:
      'REVIEWER BLOCKER B1, pinned. Shipped at renameView.ts:84-90 and ' +
      'tradeProposeView.ts:112-117. The click body invokes this.#submit(); the keydown body ' +
      'invokes only e.stopPropagation() -- the identity intersection is EMPTY. It must ' +
      'still PASS, because the receiver is native. identityWouldFail additionally asserts ' +
      'that identityOk() really does return ok:false with an empty shared set here, so the ' +
      'PASS is proven to come from ARM PRECEDENCE (native resolved first, identity consulted ' +
      'only for delegated) and not from an identity check that accidentally passes.',
  },
  {
    id: 'A12-GOOD-LISTENER-FREE-NEGATIVE-TABINDEX',
    tag: '[A11Y-T3]',
    polarity: 'GOOD',
    src: L([
      'export function wire(root: HTMLElement): void {',
      '  const btn = document.createElement(' + q('button') + ');',
      '  ' + ael('btn', 'click') + '() => {',
      '    doIt();',
      '  });',
      '  const label = document.createElement(' + q('span') + ');',
      '  label.setAttribute(' + q('tabindex') + ', ' + q('-1') + ');',
      '  root.append(btn, label);',
      '}',
    ]),
    expect: {
      needles: ['setAttribute(' + q('tabindex') + ', ' + q('-1') + ')'],
      clicks: 1,
      keydowns: 0,
      arm: 'native',
      verdict: null,
      tabindexWrites: 1,
      tabindexSpelling: 'setAttribute',
      tabindexValue: '-1',
      tabindexTag: null,
    },
    why:
      'Four shipped sites: a programmatically focusable, NON-interactive element in a file ' +
      'that does have listeners on a sibling. T3 is about a negative tabindex on a receiver ' +
      'that ITSELF carries a binding; a file-level "has listeners + has tabindex -1" check ' +
      'false-REDs this shipped shape.',
  },

  // ---- [A11Y-T3] / [A11Y-T5] BAD ----------------------------------------------------
  tabindexTooth(
    'T3-BAD-PROPERTY-NEGATIVE-INTERACTIVE',
    '[A11Y-T3]',
    'BAD',
    interactiveTabindexFixture('btn.tabIndex = -1;'),
    'property',
    '-1',
    '[A11Y-T3]',
    ['btn.tabIndex = -1'],
    'The canonical NEGATIVE_TABINDEX_INTERACTIVE shape: an element that handles clicks is ' +
      'removed from the tab order, so it is mouse-only. Property spelling, which an ' +
      'attribute-only scanner never sees.',
    { clicks: 1, arm: 'native', verdict: null },
  ),
  tabindexTooth(
    'T3-BAD-SETATTR-NEGATIVE-INTERACTIVE',
    '[A11Y-T3]',
    'BAD',
    interactiveTabindexFixture('btn.setAttribute(' + q('tabindex') + ', ' + q('-1') + ');'),
    'setAttribute',
    '-1',
    '[A11Y-T3]',
    ['setAttribute(' + q('tabindex') + ', ' + q('-1') + ')'],
    'The same T3 defect through the attribute spelling. Kills a T3 rule implemented only ' +
      'over the .tabIndex property, and together with the listener-free GOOD tooth it pins ' +
      'that T3 turns on the RECEIVER carrying a binding, not on the spelling.',
    { clicks: 1, arm: 'native', verdict: null },
  ),
  tabindexTooth(
    'T5-BAD-PROPERTY-POSITIVE',
    '[A11Y-T5]',
    'BAD',
    interactiveTabindexFixture('btn.tabIndex = 5;'),
    'property',
    '5',
    '[A11Y-T5]',
    ['btn.tabIndex = 5'],
    'A positive tabindex hijacks document tab order globally. Property spelling again, and ' +
      'the value is an unquoted NUMBER, which a string-literal-only value parser misses.',
    { clicks: 1, arm: 'native', verdict: null },
  ),
  tabindexTooth(
    'T5-BAD-OBJECT-ASSIGN',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('Object.assign(panel, { tabIndex: 3 });'),
    'objectAssign',
    '3',
    '[A11Y-T5]',
    ['Object.assign(panel, { tabIndex: 3 })'],
    'A third write spelling with no assignment operator and no setAttribute call at all. ' +
      'Also proves T5 does not require the file to contain any listener.',
  ),
  tabindexTooth(
    'T5-BAD-SETATTR-POSITIVE',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttribute(' + q('tabindex') + ', ' + q('1') + ');'),
    'setAttribute',
    '1',
    '[A11Y-T5]',
    ['setAttribute(' + q('tabindex') + ', ' + q('1') + ')'],
    'The plain positive attribute write -- the control for the exotic spellings below.',
  ),
  tabindexTooth(
    'T5-BAD-NON-INTEGER-AUTO',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttribute(' + q('tabindex') + ', ' + q('auto') + ');'),
    'setAttribute',
    'auto',
    '[A11Y-T5]',
    ['setAttribute(' + q('tabindex') + ', ' + q('auto') + ')'],
    'parseInt("auto") is NaN, and `NaN > 0` is false -- so a parseInt-only check silently ' +
      'accepts a value that is not a valid tabindex at all.',
  ),
  tabindexTooth(
    'T5-BAD-NON-INTEGER-FRACTION',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttribute(' + q('tabindex') + ', ' + q('0.5') + ');'),
    'setAttribute',
    '0.5',
    '[A11Y-T5]',
    ['setAttribute(' + q('tabindex') + ', ' + q('0.5') + ')'],
    'The nastier parseInt hole: parseInt("0.5") is 0, which passes a `> 0` test outright. ' +
      'Only an integer-shape check catches it.',
  ),
  tabindexTooth(
    'T5-BAD-MIXED-CASE-ATTR-NAME',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttribute(' + q('TabIndex') + ', ' + q('2') + ');'),
    'setAttribute',
    '2',
    '[A11Y-T5]',
    ['setAttribute(' + q('TabIndex') + ', ' + q('2') + ')'],
    'HTML attribute names are case-insensitive, so this really does set tabindex. A ' +
      'case-sensitive literal match reports zero writes.',
  ),
  tabindexTooth(
    'T5-BAD-SETATTRIBUTENS',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttributeNS(null, ' + q('tabindex') + ', ' + q('4') + ');'),
    'setAttributeNS',
    '4',
    '[A11Y-T5]',
    ['setAttributeNS(null'],
    'The namespaced sibling API, whose value is the THIRD argument. A scanner keyed on ' +
      'setAttribute( with the value in argument two mis-reads or skips it.',
  ),
  tabindexTooth(
    'T5-BAD-INNERHTML-LITERAL',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture(
      'panel.innerHTML = ' + q('<li tabindex=' + DQ + '1' + DQ + '>row</li>') + ';',
    ),
    'innerHTML',
    '1',
    '[A11Y-T5]',
    ['tabindex=' + DQ + '1' + DQ],
    'A positive tabindex smuggled through markup in a string literal. Kills a scanner that ' +
      'only ever inspects DOM API call arguments, and simultaneously pins that ' +
      'stripTsComments does NOT reach inside string literals.',
  ),

  // ---- comment stripping ------------------------------------------------------------
  {
    id: 'STRIP-LINE-COMMENT-DECOY',
    tag: '[A11Y-T5]',
    polarity: 'GOOD',
    src: L([
      'export function wire(root: HTMLElement): void {',
      '  const btn = document.createElement(' + q('button') + ');',
      '  // legacy shape, deleted in m20: btn.tabIndex = 5; and li.onclick = bad;',
      '  ' + ael('btn', 'click') + '() => {',
      '    doIt();',
      '  });',
      '  root.appendChild(btn);',
      '}',
    ]),
    expect: {
      needles: ['createElement(' + q('button') + ')'],
      absentNeedles: ['legacy shape', 'btn.tabIndex = 5', 'li.onclick'],
      clicks: 1,
      keydowns: 0,
      tabindexWrites: 0,
      arm: 'native',
      verdict: null,
    },
    why:
      'A raw-text scanner reports a phantom [A11Y-T5] and a phantom property click site ' +
      'from a comment describing code that no longer exists. absentNeedles proves the ' +
      'stripper really removed the text rather than the counters happening to be zero.',
  },

  // ---- FAIL-LOUD: undecidable constructs must be REPORTED ----------------------------
  failLoudTooth(
    'FL-BOUND-HANDLER-REFERENCE',
    L([
      'export function wire(list: HTMLElement): void {',
      '  const bindEl = document.createElement(' + q('li') + ');',
      '  ' + ael('bindEl', 'click') + 'handler.bind(this));',
      '  list.appendChild(bindEl);',
      '}',
    ]),
    ['bindEl'],
    ['.bind(this)'],
    'A .bind() expression has no in-file body to resolve, so identity is undecidable. ' +
      'Silently skipping it is a hole an author can drive every violation through.',
  ),
  failLoudTooth(
    'FL-SPLIT-ATTRIBUTE-NAME',
    bareTabindexFixture(
      'splitEl.setAttribute(' + q('tab') + ' + ' + q('index') + ', ' + q('1') + ');',
    ),
    ['splitEl'],
    [q('tab') + ' + ' + q('index')],
    'A concatenated attribute name defeats every literal name match. The scanner must say ' +
      'so, not report zero tabindex writes.',
  ),
  failLoudTooth(
    'FL-ATTRIBUTE-NAME-FROM-CONST',
    L([
      'const ATTR_NAME = ' + q('tabindex') + ';',
      'export function decorate(constNameEl: HTMLElement): void {',
      '  constNameEl.setAttribute(ATTR_NAME, ' + q('1') + ');',
      '}',
    ]),
    ['constNameEl'],
    ['ATTR_NAME'],
    'An indirected attribute name. Distinct from the split-name tooth: there IS a single ' +
      'token in argument one, it just is not a literal.',
  ),
  failLoudTooth(
    'FL-TABINDEX-VALUE-FROM-VARIABLE',
    L([
      'export function decorate(varValEl: HTMLElement, depth: number): void {',
      '  varValEl.setAttribute(' + q('tabindex') + ', String(depth));',
      '}',
    ]),
    ['varValEl'],
    ['String(depth)'],
    'The name is decidable but the VALUE is not, so neither T3 nor T5 can be evaluated. ' +
      'An impl that only fails loud on unknown NAMES reports a clean pass here.',
  ),
  failLoudTooth(
    'FL-COMPUTED-MEMBER-REGISTRATION',
    L([
      'export function wire(list: HTMLElement): void {',
      '  const computedEl = document.createElement(' + q('li') + ');',
      '  computedEl[' + q('addEventListener') + '](' + q('click') + ', () => {',
      '    pick(9);',
      '  });',
      '}',
    ]),
    ['computedEl'],
    ['[' + q('addEventListener') + ']'],
    'Computed member access registers a real listener that a `.addEventListener(` text ' +
      'match never sees. Fail-loud is the only honest answer.',
  ),
  failLoudTooth(
    'FL-CONCATENATED-SELECTOR-RECEIVER',
    L([
      'export function wire(id: number): void {',
      '  const concatEl = document.querySelector(' + q('#row-') + ' + id);',
      '  ' + ael('concatEl', 'click') + '() => {',
      '    pick(10);',
      '  });',
      '}',
    ]),
    ['concatEl'],
    [q('#row-') + ' + id'],
    'The receiver element type cannot be established from a computed selector, so the ' +
      'native/delegated arm is unknowable. Guessing "delegated" would false-RED and ' +
      'guessing "native" would false-GREEN; the scanner must say it cannot tell.',
  ),

  // ---- MUST NOT fail loud: named references that DO resolve --------------------------
  {
    id: 'NL-FOCUSTRAP-NAMED-KEYDOWN-CAPTURE',
    tag: '[FAIL-LOUD]',
    polarity: 'GOOD',
    src: L([
      'export function installTrap(root: HTMLElement): () => void {',
      '  const onKeydown = (e: KeyboardEvent): void => {',
      '    if (e.key !== ' + q('Tab') + ') return;',
      '    if (e.ctrlKey || e.altKey || e.metaKey) return;',
      '    e.preventDefault();',
      '    target.focus();',
      '  };',
      '  ' + ael('root', 'keydown') + 'onKeydown, true);',
      '  return () => {',
      '    root.removeEventListener(' + q('keydown') + ', onKeydown, true);',
      '  };',
      '}',
    ]),
    expect: {
      needles: ['onKeydown, true'],
      clicks: 0,
      keydowns: 1,
      loud: 0,
      keydownHandlerIncludes: ['e.preventDefault()'],
      keydownSpelling: 'addEventListener',
    },
    why:
      'Ships today at ui/focusTrap.ts:150, with a third capture-phase argument. A named ' +
      'function reference must be RESOLVED to its in-file definition, not declared ' +
      'unparseable: keydownHandlerIncludes asserts the resolved body really is the arrow, ' +
      'so an impl returning an empty handlerText and a clean loud list cannot pass.',
  },
  {
    id: 'NL-RESIZE-NON-INTERACTIVE-LISTENER',
    tag: '[FAIL-LOUD]',
    polarity: 'GOOD',
    src: L([
      'export function installResizeHandler(renderer: Resizable, win: ResizeWindow): void {',
      '  const syncSize = () => renderer.resize(win.innerWidth, win.innerHeight, win.devicePixelRatio);',
      '  syncSize();',
      '  ' + ael('win', 'resize') + 'syncSize);',
      '}',
    ]),
    expect: {
      needles: ['addEventListener(' + q('resize') + ', syncSize)'],
      clicks: 0,
      keydowns: 0,
      tabindexWrites: 0,
      loud: 0,
    },
    why:
      'Ships today at render/resizeWiring.ts:33. An event this eval does not govern, bound ' +
      'by a named reference. An impl that fails loud on every non-arrow handler reds the ' +
      'shipped tree from a file that has no click, no keydown and no tabindex.',
  },

  // ---- named-reference resolution decides the verdict --------------------------------
  {
    id: 'NAMEDREF-GOOD-RESOLVES-TO-INVOCATION',
    tag: '[A11Y-13]',
    polarity: 'GOOD',
    src: L([
      'export function wireRow(row: HTMLLIElement, callbacks: MenuViewCallbacks): void {',
      '  const onKey = (e: KeyboardEvent): void => {',
      '    if (e.code === ' + q('Enter') + ') callbacks.onInput({ kind: ' + q('enter') + ' });',
      '  };',
      '  ' + ael('row', 'click') + '() => {',
      '    callbacks.onInput({ kind: ' + q('click') + ' });',
      '  });',
      '  ' + ael('row', 'keydown') + 'onKey);',
      '}',
    ]),
    expect: {
      needles: ['const onKey ='],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: null,
      sharedIncludes: ['callbacks.onInput'],
      keydownHandlerIncludes: ['callbacks.onInput'],
    },
    why:
      'The PASS half of named-reference resolution: the resolved body does invoke the ' +
      'shared callback. An impl that only inspects inline arrows finds an empty handler ' +
      'body and false-REDs a correct pair.',
  },
  {
    id: 'NAMEDREF-BAD-RESOLVES-TO-NOOP',
    tag: '[A11Y-13]',
    polarity: 'BAD',
    src: L([
      'export function wireRow(row: HTMLLIElement, callbacks: MenuViewCallbacks): void {',
      '  const onKey = (e: KeyboardEvent): void => {',
      '    e.stopPropagation();',
      '  };',
      '  ' + ael('row', 'click') + '() => {',
      '    callbacks.onInput({ kind: ' + q('click') + ' });',
      '  });',
      '  ' + ael('row', 'keydown') + 'onKey);',
      '}',
    ]),
    expect: {
      needles: ['const onKey ='],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: '[A11Y-13]',
      sharedExcludes: ['callbacks.onInput'],
    },
    why:
      'The FAIL half, byte-identical in shape to the tooth above except for the resolved ' +
      'body. Together they prove the resolution is REAL: an impl that "resolves" by ' +
      'assuming any named reference is fine passes the GOOD tooth and dies here; one that ' +
      'refuses to resolve dies on the GOOD tooth.',
  },

  // ---- receiver keying ---------------------------------------------------------------
  {
    id: 'RK-BAD-CROSS-CLASS-SAME-RECEIVER-TEXT',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export class RowsView {',
      '  readonly #el: HTMLElement;',
      '  constructor(callbacks: MenuViewCallbacks) {',
      '    this.#el = document.getElementById(' + q('rows') + ') as HTMLElement;',
      '    ' + ael('this.#el', 'click') + '() => {',
      '      callbacks.onInput({ kind: ' + q('click') + ' });',
      '    });',
      '  }',
      '}',
      'export class HintView {',
      '  readonly #el: HTMLElement;',
      '  constructor(callbacks: MenuViewCallbacks) {',
      '    this.#el = document.getElementById(' + q('hint') + ') as HTMLElement;',
      '    ' + ael('this.#el', 'keydown') + '(e) => {',
      '      callbacks.onInput({ kind: ' + q('key') + ' });',
      '    });',
      '  }',
      '}',
    ]),
    expect: {
      needles: ['class RowsView', 'class HintView'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: '[A11Y-12]',
      receiversDiffer: true,
    },
    why:
      'Two DIFFERENT elements spelled `this.#el` in one file. A text-keyed pairing marries ' +
      "RowsView's click to HintView's keydown and passes a keyboard-dead row. " +
      'receiversDiffer asserts the scope qualification directly, so the [A11Y-12] verdict ' +
      'cannot come from some unrelated accident.',
  },
  {
    id: 'RK-BAD-LET-REBOUND-BETWEEN-REGISTRATIONS',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(list: HTMLElement, callbacks: MenuViewCallbacks): void {',
      '  let el = document.createElement(' + q('li') + ');',
      '  ' + ael('el', 'click') + '() => {',
      '    callbacks.onInput({ kind: ' + q('click') + ' });',
      '  });',
      '  list.appendChild(el);',
      '  el = document.createElement(' + q('li') + ');',
      '  ' + ael('el', 'keydown') + '(e) => {',
      '    callbacks.onInput({ kind: ' + q('key') + ' });',
      '  });',
      '  list.appendChild(el);',
      '}',
    ]),
    expect: {
      needles: ['let el =', 'el = document.createElement'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: '[A11Y-12]',
      receiversDiffer: true,
    },
    why:
      'One NAME, two elements: the first <li> takes the click and is never given a keydown. ' +
      'Same false pairing as the cross-class tooth but within a single function, so a fix ' +
      'that only qualifies by enclosing class does not survive.',
  },
  failLoudTooth(
    'RK-ALIAS-MUST-FAIL-LOUD-NOT-BE-MISSED',
    L([
      'export class MenuView {',
      '  readonly #rowsEl: HTMLElement;',
      '  constructor(callbacks: MenuViewCallbacks) {',
      '    this.#rowsEl = document.getElementById(' + q('menu-rows') + ') as HTMLElement;',
      '    ' + ael('this.#rowsEl', 'click') + '() => {',
      '      callbacks.onInput({ kind: ' + q('click') + ' });',
      '    });',
      '    const rowsAlias = this.#rowsEl;',
      '    ' + ael('rowsAlias', 'keydown') + '(e) => {',
      '      callbacks.onInput({ kind: ' + q('key') + ' });',
      '    });',
      '  }',
      '}',
    ]),
    ['rowsAlias'],
    ['const rowsAlias = this.#rowsEl'],
    'The inverse of the two teeth above: a LEGITIMATE alias of one element under two ' +
      'names. A purely text-keyed receiver design finds no pair and emits a FALSE RED on ' +
      'correct code. Fail-loud is the required answer -- an alias the scanner cannot follow ' +
      'must be reported, never silently tagged and never silently passed.',
  ),
];

// ---------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------

function callMatcher(M, name, args) {
  const fn = M === null || M === undefined ? undefined : M[name];
  if (typeof fn !== 'function') throw new Error('matcher M.' + name + ' is missing');
  return fn.apply(M, args);
}

function isSiteArray(v) {
  if (!Array.isArray(v)) return false;
  for (const s of v) {
    if (s === null || typeof s !== 'object') return false;
    if (typeof s.receiver !== 'string' || s.receiver.length === 0) return false;
    if (typeof s.handlerText !== 'string') return false;
    if (s.spelling !== 'addEventListener' && s.spelling !== 'property') return false;
    if (typeof s.line !== 'number') return false;
  }
  return true;
}

function isTabWriteArray(v) {
  if (!Array.isArray(v)) return false;
  for (const w of v) {
    if (w === null || typeof w !== 'object') return false;
    if (typeof w.receiver !== 'string') return false;
    if (typeof w.value !== 'string') return false;
    if (typeof w.spelling !== 'string' || w.spelling.length === 0) return false;
    if (typeof w.line !== 'number') return false;
  }
  return true;
}

function checkIdentityShape(res) {
  if (res === null || typeof res !== 'object')
    throw new Error('identityOk did not return an object');
  if (typeof res.ok !== 'boolean') throw new Error('identityOk.ok is not a boolean');
  if (!Array.isArray(res.shared)) throw new Error('identityOk.shared is not an array');
  if (typeof res.reason !== 'string' || res.reason.length === 0) {
    throw new Error('identityOk.reason is not a non-empty string');
  }
  return res;
}

function checkClassifyShape(res) {
  if (res === null || typeof res !== 'object') throw new Error('classify did not return an object');
  if (res.arm !== 'native' && res.arm !== 'delegated' && res.arm !== null) {
    throw new Error('classify.arm is not one of native | delegated | null');
  }
  if (typeof res.reason !== 'string' || res.reason.length === 0) {
    throw new Error('classify.reason is not a non-empty string');
  }
  return res;
}

/** The composed decision procedure the eval must implement. */
function computeVerdict(M, stripped, click, keydowns) {
  const cls = checkClassifyShape(callMatcher(M, 'classify', [stripped, click]));
  if (cls.arm === 'native') return { tag: null, arm: 'native', identity: null };
  if (cls.arm === null) return { tag: null, arm: null, identity: null };
  const pairs = keydowns.filter((k) => k.receiver === click.receiver);
  if (pairs.length === 0) return { tag: '[A11Y-12]', arm: 'delegated', identity: null };
  let first = null;
  for (const k of pairs) {
    const res = checkIdentityShape(callMatcher(M, 'identityOk', [stripped, click, k]));
    if (first === null) first = res;
    if (res.ok === true) return { tag: null, arm: 'delegated', identity: res };
  }
  return { tag: '[A11Y-13]', arm: 'delegated', identity: first };
}

function runOne(M, rec) {
  const fails = [];
  const add = (msg) => {
    fails.push(rec.id + ' ' + rec.tag + ' [' + rec.polarity + ']: ' + msg);
  };
  const e = rec.expect || {};

  try {
    // ---- 0. record self-consistency -------------------------------------------------
    if (typeof rec.src !== 'string' || rec.src.length === 0) {
      add('fixture src is not a non-empty string');
      return fails;
    }
    if (rec.src.indexOf(BACKTICK) !== -1) {
      add('fixture contains a backtick (forbidden: corrupts template-literal authoring)');
      return fails;
    }
    if (rec.src.indexOf(SLASHSTAR) !== -1) {
      add('fixture contains a block-comment opener (forbidden: measured vacuous-green cause)');
      return fails;
    }
    if (!Array.isArray(e.needles) || e.needles.length === 0) {
      add('record declares no structural needles');
      return fails;
    }

    // ---- 1. STRUCTURAL, before any behaviour ----------------------------------------
    const stripped = callMatcher(M, 'stripTsComments', [rec.src]);
    if (typeof stripped !== 'string' || stripped.length === 0) {
      add('stripTsComments did not return a non-empty string');
      return fails;
    }
    for (const n of e.needles) {
      if (stripped.indexOf(n) === -1) {
        add('stripper destroyed load-bearing text ' + JSON.stringify(n) + ' (fixture is vacuous)');
      }
    }
    if (Array.isArray(e.absentNeedles)) {
      for (const n of e.absentNeedles) {
        if (stripped.indexOf(n) !== -1) {
          add('stripper left comment text ' + JSON.stringify(n) + ' in the source');
        }
      }
    }
    if (fails.length > 0) return fails;

    const clicks = callMatcher(M, 'findClickSites', [stripped]);
    const keydowns = callMatcher(M, 'findKeydownSites', [stripped]);
    const tabs = callMatcher(M, 'findTabindexWrites', [stripped]);
    const loud = callMatcher(M, 'scanFailLoud', [stripped]);

    if (!isSiteArray(clicks)) {
      add('findClickSites did not return well-formed {line,receiver,handlerText,spelling} records');
      return fails;
    }
    if (!isSiteArray(keydowns)) {
      add(
        'findKeydownSites did not return well-formed {line,receiver,handlerText,spelling} records',
      );
      return fails;
    }
    if (!isTabWriteArray(tabs)) {
      add('findTabindexWrites did not return well-formed {line,receiver,value,spelling} records');
      return fails;
    }
    if (!Array.isArray(loud)) {
      add('scanFailLoud did not return an array');
      return fails;
    }
    for (const r of loud) {
      if (typeof r !== 'string' || r.length === 0) {
        add('scanFailLoud returned a non-string / empty reason');
        return fails;
      }
    }

    if (typeof e.clicks === 'number' && clicks.length !== e.clicks) {
      add('expected ' + e.clicks + ' click site(s), found ' + clicks.length);
    }
    if (typeof e.keydowns === 'number' && keydowns.length !== e.keydowns) {
      add('expected ' + e.keydowns + ' keydown site(s), found ' + keydowns.length);
    }
    if (typeof e.tabindexWrites === 'number' && tabs.length !== e.tabindexWrites) {
      add('expected ' + e.tabindexWrites + ' tabindex write(s), found ' + tabs.length);
    }
    if (fails.length > 0) return fails;

    // ---- 2. fail-loud posture --------------------------------------------------------
    if (rec.polarity === 'FAILLOUD') {
      const min = typeof e.loudAtLeast === 'number' ? e.loudAtLeast : 1;
      if (loud.length < min) {
        add(
          'expected at least ' +
            min +
            ' fail-loud reason(s), found ' +
            loud.length +
            ' -- an undecidable construct was silently skipped',
        );
        return fails;
      }
      for (const mention of e.loudMentions || []) {
        let hit = false;
        for (const r of loud) {
          if (r.indexOf(mention) !== -1) hit = true;
        }
        if (!hit) {
          add(
            'no fail-loud reason names ' +
              JSON.stringify(mention) +
              ' (got: ' +
              JSON.stringify(loud) +
              ') -- the scanner failed loud for some OTHER reason',
          );
        }
      }
      return fails;
    }

    const expectedLoud = typeof e.loud === 'number' ? e.loud : 0;
    if (loud.length !== expectedLoud) {
      add(
        'expected ' +
          expectedLoud +
          ' fail-loud reason(s), found ' +
          loud.length +
          ' (' +
          JSON.stringify(loud) +
          ') -- a decidable fixture must be decided',
      );
      return fails;
    }

    // ---- 3. BEHAVIOURAL --------------------------------------------------------------
    if (typeof e.clickSpelling === 'string') {
      if (clicks.length !== 1) add('clickSpelling assertion needs exactly 1 click site');
      else if (clicks[0].spelling !== e.clickSpelling) {
        add(
          'click spelling was ' +
            JSON.stringify(clicks[0].spelling) +
            ', expected ' +
            JSON.stringify(e.clickSpelling),
        );
      }
    }
    if (typeof e.keydownSpelling === 'string') {
      if (keydowns.length !== 1) add('keydownSpelling assertion needs exactly 1 keydown site');
      else if (keydowns[0].spelling !== e.keydownSpelling) {
        add(
          'keydown spelling was ' +
            JSON.stringify(keydowns[0].spelling) +
            ', expected ' +
            JSON.stringify(e.keydownSpelling),
        );
      }
    }
    if (Array.isArray(e.keydownHandlerIncludes)) {
      if (keydowns.length !== 1) add('keydownHandlerIncludes needs exactly 1 keydown site');
      else {
        for (const n of e.keydownHandlerIncludes) {
          if (keydowns[0].handlerText.indexOf(n) === -1) {
            add(
              'resolved keydown handler text is missing ' +
                JSON.stringify(n) +
                ' -- the named reference was not resolved to its in-file definition',
            );
          }
        }
      }
    }
    if (e.receiversDiffer === true) {
      if (clicks.length !== 1 || keydowns.length !== 1) {
        add('receiversDiffer needs exactly 1 click and 1 keydown site');
      } else if (clicks[0].receiver === keydowns[0].receiver) {
        add(
          'click and keydown receivers are the SAME key (' +
            JSON.stringify(clicks[0].receiver) +
            ') -- two distinct bindings were merged by receiver TEXT',
        );
      }
    }

    let verdict = null;
    const wantsVerdict =
      Object.hasOwn(e, 'verdict') ||
      Array.isArray(e.verdictAnyOf) ||
      typeof e.arm === 'string' ||
      Array.isArray(e.sharedIncludes) ||
      Array.isArray(e.sharedExcludes);
    if (wantsVerdict) {
      if (clicks.length !== 1) {
        add('verdict/arm assertions need exactly 1 click site, found ' + clicks.length);
        return fails;
      }
      verdict = computeVerdict(M, stripped, clicks[0], keydowns);
    }

    if (typeof e.arm === 'string' && verdict !== null && verdict.arm !== e.arm) {
      add(
        'classify arm was ' + JSON.stringify(verdict.arm) + ', expected ' + JSON.stringify(e.arm),
      );
    }
    if (Object.hasOwn(e, 'verdict') && verdict !== null) {
      if (verdict.tag !== e.verdict) {
        add(
          'verdict was ' + JSON.stringify(verdict.tag) + ', expected ' + JSON.stringify(e.verdict),
        );
      }
    }
    if (Array.isArray(e.verdictAnyOf) && verdict !== null) {
      if (e.verdictAnyOf.indexOf(verdict.tag) === -1) {
        add(
          'verdict was ' +
            JSON.stringify(verdict.tag) +
            ', expected one of ' +
            JSON.stringify(e.verdictAnyOf),
        );
      }
    }
    if ((Array.isArray(e.sharedIncludes) || Array.isArray(e.sharedExcludes)) && verdict !== null) {
      let idres = verdict.identity;
      if (idres === null && keydowns.length === 1) {
        idres = checkIdentityShape(
          callMatcher(M, 'identityOk', [stripped, clicks[0], keydowns[0]]),
        );
      }
      if (idres === null) {
        add('shared-set assertion has no identityOk result to inspect');
      } else {
        for (const n of e.sharedIncludes || []) {
          if (idres.shared.indexOf(n) === -1) {
            add(
              'identityOk.shared is missing ' +
                JSON.stringify(n) +
                ' (got ' +
                JSON.stringify(idres.shared) +
                ') -- a PASS here would rest on an empty intersection',
            );
          }
        }
        for (const n of e.sharedExcludes || []) {
          if (idres.shared.indexOf(n) !== -1) {
            add(
              'identityOk.shared wrongly contains ' +
                JSON.stringify(n) +
                ' (got ' +
                JSON.stringify(idres.shared) +
                ') -- token PRESENCE was counted as INVOCATION',
            );
          }
        }
      }
    }
    if (e.identityWouldFail === true) {
      if (clicks.length !== 1 || keydowns.length !== 1) {
        add('identityWouldFail needs exactly 1 click and 1 keydown site');
      } else {
        const idres = checkIdentityShape(
          callMatcher(M, 'identityOk', [stripped, clicks[0], keydowns[0]]),
        );
        if (idres.ok !== false) {
          add(
            'identityOk returned ok:true on an EMPTY intersection -- the native PASS is not ' +
              'proven to come from arm precedence',
          );
        }
        if (idres.shared.length !== 0) {
          add('identityOk.shared should be empty here, got ' + JSON.stringify(idres.shared));
        }
      }
    }

    // ---- 4. tabindex -----------------------------------------------------------------
    const wantsTab =
      Object.hasOwn(e, 'tabindexTag') ||
      typeof e.tabindexSpelling === 'string' ||
      typeof e.tabindexValue === 'string';
    if (wantsTab) {
      if (tabs.length !== 1) {
        add('tabindex assertions need exactly 1 tabindex write, found ' + tabs.length);
        return fails;
      }
      const w = tabs[0];
      if (typeof e.tabindexSpelling === 'string' && w.spelling !== e.tabindexSpelling) {
        add(
          'tabindex write spelling was ' +
            JSON.stringify(w.spelling) +
            ', expected ' +
            JSON.stringify(e.tabindexSpelling),
        );
      }
      if (typeof e.tabindexValue === 'string' && w.value !== e.tabindexValue) {
        add(
          'tabindex write value was ' +
            JSON.stringify(w.value) +
            ', expected ' +
            JSON.stringify(e.tabindexValue),
        );
      }
      const v = callMatcher(M, 'tabindexVerdict', [stripped, w]);
      if (v === null || typeof v !== 'object') {
        add('tabindexVerdict did not return an object');
      } else {
        if (v.tag !== '[A11Y-T3]' && v.tag !== '[A11Y-T5]' && v.tag !== null) {
          add('tabindexVerdict.tag is not one of [A11Y-T3] | [A11Y-T5] | null');
        }
        if (typeof v.reason !== 'string' || v.reason.length === 0) {
          add('tabindexVerdict.reason is not a non-empty string');
        }
        if (v.tag !== e.tabindexTag) {
          add(
            'tabindex verdict was ' +
              JSON.stringify(v.tag) +
              ', expected ' +
              JSON.stringify(e.tabindexTag),
          );
        }
      }
    }
  } catch (err) {
    add('threw: ' + (err && err.message ? err.message : String(err)));
  }
  return fails;
}

/**
 * Run every tooth against the matcher namespace `M`.
 * @returns {{teeth:number, teethTotal:number, failures:string[]}}
 */
export function runTeeth(M) {
  const failures = [];

  // Corpus self-checks (do not count toward teeth).
  const seen = Object.create(null);
  for (const rec of TEETH) {
    if (seen[rec.id] === true) failures.push('__corpus__: duplicate tooth id ' + rec.id);
    seen[rec.id] = true;
    if (rec.polarity !== 'BAD' && rec.polarity !== 'GOOD' && rec.polarity !== 'FAILLOUD') {
      failures.push('__corpus__: ' + rec.id + ' has an unknown polarity ' + String(rec.polarity));
    }
    if (typeof rec.why !== 'string' || rec.why.length < 40) {
      failures.push('__corpus__: ' + rec.id + ' does not state which wrong impl it kills');
    }
  }
  if (TEETH.length < 24) {
    failures.push('__corpus__: ' + TEETH.length + ' teeth is below the ledger floor of 24');
  }

  let teeth = 0;
  for (const rec of TEETH) {
    const fails = runOne(M, rec);
    if (fails.length === 0) teeth += 1;
    else for (const f of fails) failures.push(f);
  }

  return { teeth, teethTotal: TEETH.length, failures };
}

// ---------------------------------------------------------------------------------------
// THE REAL-TREE SCAN
// ---------------------------------------------------------------------------------------

/**
 * The two shipped delegations that are legitimately NOT native, frozen as a MULTISET.
 *
 * A `<= 2` CAP was rejected: red-team MEASURED that it reports GREEN when an accessible control
 * is DELETED, and that swapping one sanctioned site for a bad one keeps the count at 2. A SET
 * keyed on (file, receiver) was rejected too: a SECOND mouse-only click listener added to
 * menuView's `this.#rowsEl` took `clickSites` 27 -> 28 while the key set stayed size 2 and
 * `setEqual` stayed true. `count` is what closes that.
 *
 * Membership is NOT sufficiency: each entry re-runs its own check below every time.
 */
const SANCTIONED_DELEGATIONS = Object.freeze([
  Object.freeze({
    file: 'ui/menuView.ts',
    receiverText: 'this.#rowsEl',
    count: 1,
    kind: 'paired-keydown',
    why:
      'M23 §5.4 GOOD hostile-but-correct fixture: the aria-activedescendant listbox. Delegated ' +
      'click and delegated keydown on the same <ul>, both invoking callbacks.onInput.',
  }),
  Object.freeze({
    file: 'main.ts',
    receiverText: 'document',
    count: 1,
    kind: 'narrowed-delegation',
    why:
      'The dialogue/shop delegation. Every branch narrows to a selector whose producer is ' +
      're-derived from source below — never a standing exemption for main.ts.',
  }),
]);

/**
 * `main.ts`'s delegation branches, each re-proven from source on every run. Red-team MEASURED
 * that FREEZING the producer list lets a one-token downgrade of `dialogueView.ts`'s
 * `createElement('button')` to `createElement('div')` — every dialogue choice made
 * non-focusable — pass at full green, because the selector literal never changed.
 */
const NARROWED_SELECTORS = Object.freeze([
  Object.freeze({ selector: '[data-shop-id]', dataset: 'shopId', producer: 'ui/dialogueView.ts' }),
  Object.freeze({
    selector: '[data-choice-idx]',
    dataset: 'choiceIdx',
    producer: 'ui/dialogueView.ts',
  }),
  Object.freeze({
    selector: '[data-menu-launcher]',
    html: 'data-menu-launcher',
    producer: 'client/index.html',
  }),
]);

/** Narrowing idioms a delegation may use. An UNRECOGNISED one is a hard failure, not a skip. */
const NARROWING_IDIOMS = Object.freeze([
  '.closest(',
  '.matches(',
  '.dataset.',
  '.getAttribute(',
  '.hasAttribute(',
]);

/** Load-bearing files whose absence means the walker collapsed, not that the tree is clean. */
const REQUIRED_FILES = Object.freeze([
  'ui/menuView.ts',
  'main.ts',
  'ui/dialogueView.ts',
  'ui/renameView.ts',
  'ui/tradeProposeView.ts',
  'ui/claimView.ts',
  'render/world.ts',
  'ui/focusTrap.ts',
]);

const CLIENT_SRC = 'client/src';
const INDEX_HTML = 'client/index.html';
const DELEGATE_SPEC = 'client/src/indexShell.test.ts';
const VITE_CONFIG = 'client/vite.config.ts';

/**
 * The `[A11Y-T5]` HTML half is DELEGATED to the shipped real-DOM forward-guard, not
 * re-implemented (ADR-0215:22-24 records m23-s10's delegation choice approvingly; ADR-0215:108-111
 * is the principle — one oracle removed beats two oracles gated for agreement).
 *
 * `codeNeedles` pin the load-bearing ASSERTION EXPRESSION, not identifiers: red-team MEASURED,
 * against the REAL shipped `findInertDelegations`/`findInertPins`, that replacing the entire guard
 * with `const badTabindex = []; if (badTabindex.length < 0) doc.querySelectorAll("[tabindex]");`
 * left vitest green and BOTH pins reporting clean. The inverted-assertion probe below is the
 * countermeasure a needle can never be.
 */
const TABINDEX_DELEGATIONS = Object.freeze([
  Object.freeze({
    file: DELEGATE_SPEC,
    titleNeedles: ['A11Y-26'],
    codeNeedles: ['Number.parseInt(e.raw, 10) > 0', 'const badTabindex = tabindexEls'],
    why: 'the document-wide A11Y-26 / [A11Y-T5] forward-guard over client/index.html',
  }),
]);

/** `listClientSourceFiles` already returns paths RELATIVE to its root, so the disk path needs
 *  the root back on the front. Getting this backwards reads as "the walker lost the tree". */
function diskPath(rel) {
  return CLIENT_SRC + '/' + rel;
}

/** Occurrence-counted needle pin. First-hit anchoring is forgeable; >1 is ambiguous. */
function countOccurrences(hay, needle) {
  let n = 0;
  let i = 0;
  while (true) {
    const at = hay.indexOf(needle, i);
    if (at === -1) return n;
    n++;
    i = at + needle.length;
  }
}

// NO `main` GUARD. `evals/run.mjs:76` imports the default export; a module-scope `process.exit`
// truncates the suite mid-loop (measured elsewhere: 37/90 ran, 3 FAILs swallowed, CI green).
export default async function () {
  const name = 'keyboard-operable-rows ([A11Y-12]/[A11Y-13]/[A11Y-T3]/[A11Y-T5])';
  const bad = (detail) => ({ name, pass: false, detail });

  // ---- 1. TEETH FIRST, over the eval's OWN matchers, before the tree is read ----------
  let teethRes;
  try {
    teethRes = runTeeth({
      stripTsComments,
      findClickSites,
      findKeydownSites,
      classify,
      identityOk,
      findTabindexWrites,
      tabindexVerdict,
      scanFailLoud,
    });
  } catch (e) {
    return bad('TEETH HARNESS THREW: ' + (e && e.message ? e.message : String(e)));
  }
  if (teethRes.teethTotal < 24) {
    return bad('TEETH FLOOR: only ' + teethRes.teethTotal + ' teeth, the ledger floor is 24');
  }
  if (teethRes.teeth !== teethRes.teethTotal) {
    return bad(
      'TEETH DO NOT BITE (' +
        teethRes.teeth +
        '/' +
        teethRes.teethTotal +
        '): ' +
        teethRes.failures.slice(0, 6).join(' | '),
    );
  }

  // ---- 2. Collect the tree -----------------------------------------------------------
  let files;
  try {
    files = listClientSourceFiles(CLIENT_SRC);
  } catch (e) {
    return bad('could not walk ' + CLIENT_SRC + ': ' + (e && e.message ? e.message : String(e)));
  }
  if (files.length < 40) {
    return bad('SCOPE COLLAPSE: only ' + files.length + ' client source files (expected 40+)');
  }
  const rel = files;
  for (const req of REQUIRED_FILES) {
    if (rel.indexOf(req) === -1) {
      return bad('SCOPE COLLAPSE: ' + req + ' is not in the walked set — the walker lost the tree');
    }
  }

  const sources = new Map();
  for (let i = 0; i < files.length; i++) {
    let raw;
    try {
      raw = readFileSync(diskPath(rel[i]), 'utf8');
    } catch (e) {
      return bad('could not read ' + rel[i] + ': ' + (e && e.message ? e.message : String(e)));
    }
    let stripped;
    try {
      stripped = stripTsComments(raw);
    } catch (e) {
      // ADR-0215 RK-2: a fail-loud stripper called BARE is a thrown eval, not a reported one.
      return bad(
        'stripTsComments threw on ' + rel[i] + ': ' + (e && e.message ? e.message : String(e)),
      );
    }
    sources.set(rel[i], stripped);
  }

  // ---- 3. Fail loud before deciding anything -----------------------------------------
  const loud = [];
  for (const [f, src] of sources) {
    let rs;
    try {
      rs = scanFailLoud(src);
    } catch (e) {
      return bad('scanFailLoud threw on ' + f + ': ' + (e && e.message ? e.message : String(e)));
    }
    for (const r of rs) loud.push(f + ': ' + r);
  }
  if (loud.length > 0) {
    return bad(
      'UNDECIDABLE CONSTRUCT(S) — M23 §5.4 specifies this scan to fail loud on a shape it ' +
        'cannot decide rather than pass it; a new shape is a gate failure demanding a gate ' +
        'update: ' +
        loud.join(' | '),
    );
  }

  // ---- 4. [A11Y-12] census + classification ------------------------------------------
  const clickSites = [];
  const keydownSites = [];
  for (const [f, src] of sources) {
    for (const s of findClickSites(src)) clickSites.push({ file: f, src, site: s });
    for (const s of findKeydownSites(src)) keydownSites.push({ file: f, src, site: s });
  }
  if (clickSites.length < 25) {
    return bad('SCOPE COLLAPSE: ' + clickSites.length + ' click sites found (expected 25+)');
  }
  if (keydownSites.length < 8) {
    return bad('SCOPE COLLAPSE: ' + keydownSites.length + ' keydown sites found (expected 8+)');
  }

  let native = 0;
  const nonNative = [];
  const unclassified = [];
  for (const rec of clickSites) {
    const cls = classify(rec.src, rec.site);
    if (cls.arm === 'native') {
      native++;
      continue;
    }
    if (cls.arm === null) {
      unclassified.push(rec.file + ':' + rec.site.line + ' ' + cls.reason);
      continue;
    }
    nonNative.push(rec);
  }
  if (unclassified.length > 0) {
    return bad('UNCLASSIFIED click site(s): ' + unclassified.join(' | '));
  }

  // ARM-B CORROBORATION. A `readonly #x: HTMLButtonElement` declaration is one `as` cast away
  // from a lie, and BOTH shipped sites (ui/renameView.ts:55, ui/tradeProposeView.ts:80) reach the
  // field through exactly such a cast. The declared type alone is therefore not native evidence
  // on the real tree: the id it resolves from must ALSO ship as a <button>/<a> in index.html.
  // This lives HERE, not in `classify`, because `classify` must stay a pure function of one
  // source string so the inline teeth can drive it over self-contained fixtures.
  let htmlForFields;
  try {
    htmlForFields = stripHtmlComments(readFileSync(INDEX_HTML, 'utf8'));
  } catch (e) {
    return bad('could not read ' + INDEX_HTML + ': ' + (e && e.message ? e.message : String(e)));
  }
  let corroborated = 0;
  for (const rec of clickSites) {
    const t = rec.site.receiverText;
    if (t.indexOf('this.') !== 0) continue;
    if (classify(rec.src, rec.site).arm !== 'native') continue;
    const id = fieldLookupId(rec.src, t.slice(5));
    if (id === null) {
      return bad(
        '[A11Y-12] ARM-B UNCORROBORATED: ' +
          rec.file +
          ':' +
          rec.site.line +
          ' claims ' +
          t +
          ' is a native button by DECLARATION, but the id it is resolved from cannot be read — ' +
          'a declared type is one `as` cast away from a lie',
      );
    }
    const marker = 'id="' + id + '"';
    const at = htmlForFields.indexOf(marker);
    if (at === -1) {
      return bad(
        '[A11Y-12] ARM-B UNCORROBORATED: ' +
          rec.file +
          ':' +
          rec.site.line +
          ' resolves ' +
          t +
          ' from id="' +
          id +
          '", which is not in ' +
          INDEX_HTML,
      );
    }
    const open = htmlForFields.lastIndexOf('<', at);
    const tag = htmlForFields.slice(open, at);
    if (tag.indexOf('<button') !== 0 && tag.indexOf('<a ') !== 0) {
      return bad(
        '[A11Y-12] ARM-B CAST IS A LIE: ' +
          rec.file +
          ':' +
          rec.site.line +
          ' declares ' +
          t +
          ' HTMLButtonElement, but id="' +
          id +
          '" ships as ' +
          tag.trim() +
          ' in ' +
          INDEX_HTML +
          ' — the element is not keyboard-operable and the declaration is a cast, not a fact',
      );
    }
    corroborated++;
  }
  if (corroborated < 2) {
    return bad(
      'SCOPE COLLAPSE: ' +
        corroborated +
        ' declared-HTMLButtonElement click site(s) corroborated ' +
        'against ' +
        INDEX_HTML +
        ' (expected 2+) — with none, the corroboration is vacuous',
    );
  }

  // ---- 5. The ratchet: MULTISET equality against the frozen table ---------------------
  const ratchet = checkRatchet(nonNative, sources);
  if (ratchet !== null) return bad(ratchet);

  // ---- 6. [A11Y-13] identity on the sanctioned paired delegation ----------------------
  const pairedReceivers = [];
  for (const c of clickSites) {
    for (const k of keydownSites) {
      if (k.file === c.file && k.site.receiver === c.site.receiver) {
        if (pairedReceivers.indexOf(c.file + '|' + c.site.receiver) === -1) {
          pairedReceivers.push(c.file + '|' + c.site.receiver);
        }
      }
    }
  }
  const sharedIds = [];
  let identityChecked = 0;
  for (const rec of nonNative) {
    const entry = matchEntry(rec);
    if (entry === null || entry.kind !== 'paired-keydown') continue;
    const partners = keydownSites.filter(
      (k) => k.file === rec.file && k.site.receiver === rec.site.receiver,
    );
    if (partners.length === 0) {
      return bad(
        '[A11Y-12] ' +
          rec.file +
          ':' +
          rec.site.line +
          ' (' +
          rec.site.receiverText +
          ') lost its paired keydown — a delegated click with no keyboard equivalent',
      );
    }
    identityChecked++;
    let ok = null;
    for (const p of partners) {
      const r = identityOk(rec.src, rec.site, p.site);
      if (ok === null) ok = r;
      if (r.ok === true) {
        ok = r;
        break;
      }
    }
    if (ok === null || ok.ok !== true) {
      return bad(
        '[A11Y-13] ' +
          rec.file +
          ':' +
          rec.site.line +
          ' — ' +
          (ok === null ? 'no partner' : ok.reason),
      );
    }
    for (const id of ok.shared) if (sharedIds.indexOf(id) === -1) sharedIds.push(id);
  }
  if (identityChecked === 0) {
    return bad('[A11Y-13] VACUOUS: no sanctioned paired delegation was identity-checked');
  }

  // ---- 7. Arm D re-proof: selectors AND producers, re-derived every run ---------------
  const armD = checkNarrowedDelegation(sources);
  if (armD !== null) return bad(armD);

  // ---- 8. [A11Y-T3] / [A11Y-T5] over every write spelling ----------------------------
  let tabWrites = 0;
  let listenerCandidates = 0;
  const t3 = [];
  const t5 = [];
  for (const [f, src] of sources) {
    const writes = findTabindexWrites(src);
    tabWrites += writes.length;
    const listeners = findClickSites(src).concat(findKeydownSites(src));
    listenerCandidates += listeners.length;
    for (const w of writes) {
      const v = tabindexVerdict(src, w);
      if (v.tag === '[A11Y-T3]') t3.push(f + ':' + w.line + ' ' + v.reason);
      if (v.tag === '[A11Y-T5]') t5.push(f + ':' + w.line + ' ' + v.reason);
    }
  }
  if (tabWrites < 5) {
    return bad('SCOPE COLLAPSE: ' + tabWrites + ' tabindex writes found (expected 5+)');
  }
  if (listenerCandidates < 25) {
    return bad(
      'SCOPE COLLAPSE: ' +
        listenerCandidates +
        ' listener-bearing candidates — with none, ' +
        'a zero [A11Y-T3] count would be vacuously true',
    );
  }
  if (t3.length > 0) return bad('[A11Y-T3] ' + t3.join(' | '));
  if (t5.length > 0) return bad('[A11Y-T5] ' + t5.join(' | '));

  // ---- 9. index.html half ------------------------------------------------------------
  let html;
  try {
    html = stripHtmlComments(readFileSync(INDEX_HTML, 'utf8'));
  } catch (e) {
    return bad('could not read ' + INDEX_HTML + ': ' + (e && e.message ? e.message : String(e)));
  }
  if (html.indexOf('id="menu-rows"') === -1) {
    return bad('SCOPE COLLAPSE: ' + INDEX_HTML + ' no longer carries id="menu-rows"');
  }
  const htmlNegIds = countOccurrences(html, 'tabindex="-1"');
  if (htmlNegIds < 8) {
    return bad(
      'SCOPE COLLAPSE: ' +
        htmlNegIds +
        ' tabindex="-1" in the COMMENT-STRIPPED index.html ' +
        '(expected 8+) — the shell lost its focus anchors, or the count was propped up by a comment',
    );
  }

  // ---- 10. The delegated [A11Y-T5] HTML oracle: pinned, non-inert, reachable ---------
  const readFile = (f) => readFileSync(f, 'utf8');
  const inertPins = findInertPins(readFile, TABINDEX_DELEGATIONS);
  if (inertPins.length > 0) return bad('[A11Y-T5] DELEGATION PIN INERT: ' + inertPins.join(' | '));
  const inert = findInertDelegations(readFile, TABINDEX_DELEGATIONS);
  if (inert.length > 0) return bad('[A11Y-T5] delegation failures: ' + inert.join(' | '));

  let delegateSrc;
  try {
    delegateSrc = readFileSync(DELEGATE_SPEC, 'utf8');
  } catch (e) {
    return bad('could not read ' + DELEGATE_SPEC + ': ' + (e && e.message ? e.message : String(e)));
  }
  // OCCURRENCE-COUNTED, not first-hit: a decoy copy of the needle steers an indexOf anchor.
  for (const needle of TABINDEX_DELEGATIONS[0].codeNeedles) {
    const n = countOccurrences(stripTsComments(delegateSrc), needle);
    if (n !== 1) {
      return bad(
        '[A11Y-T5] ASSERTION PIN AMBIGUOUS: ' +
          JSON.stringify(needle) +
          ' occurs ' +
          n +
          ' time(s) in ' +
          DELEGATE_SPEC +
          ' (want exactly 1) — the pin cannot say WHICH ' +
          'occurrence is the load-bearing assertion',
      );
    }
  }
  // THE INVERTED-ASSERTION NEGATIVE PROBE. A needle proves text is present; it cannot prove the
  // assertion still asserts. Rewriting `.toEqual([])` to a self-comparison must make the pin RED.
  // Target the LOAD-BEARING predicate, not a bare `toEqual([])` — that string occurs twelve
  // times in this spec and a blind replace neuters an unrelated assertion, which would make the
  // probe pass for the wrong reason. A function replacer is used deliberately: a `$'`/`$&`
  // sequence in a replacement STRING duplicates the tail (measured in a prior slice).
  const PROBE_ANCHOR = 'Number.parseInt(e.raw, 10) > 0';
  if (countOccurrences(delegateSrc, PROBE_ANCHOR) !== 1) {
    return bad(
      '[A11Y-T5] NEGATIVE PROBE INAPPLICABLE: ' +
        JSON.stringify(PROBE_ANCHOR) +
        ' is not uniquely present in ' +
        DELEGATE_SPEC,
    );
  }
  const inverted = delegateSrc.replace(PROBE_ANCHOR, () => 'false');
  if (inverted === delegateSrc) {
    return bad('[A11Y-T5] NEGATIVE PROBE INAPPLICABLE: the anchor did not rewrite');
  }
  const probeRed = findInertDelegations(
    (f) => (f === DELEGATE_SPEC ? inverted : readFileSync(f, 'utf8')),
    TABINDEX_DELEGATIONS,
  );
  if (probeRed.length === 0) {
    return bad(
      '[A11Y-T5] NEGATIVE PROBE PASSED: neutering the delegate predicate to ' +
        'a constant `false` left the pin GREEN, so this pin proves nothing about A11Y-26',
    );
  }
  let viteSrc;
  try {
    viteSrc = readFileSync(VITE_CONFIG, 'utf8');
  } catch (e) {
    return bad('could not read ' + VITE_CONFIG + ': ' + (e && e.message ? e.message : String(e)));
  }
  if (!includeSelectsTests(viteSrc)) {
    return bad(
      '[A11Y-T5] REACHABILITY: ' +
        VITE_CONFIG +
        " no longer selects 'src/**/*.test.ts', so the " +
        'delegated A11Y-26 guard is UN-RUN while its pin stays green',
    );
  }

  return {
    name,
    pass: true,
    detail:
      '[A11Y-12] scanned=' +
      files.length +
      ' clickSites=' +
      clickSites.length +
      ' native=' +
      native +
      ' armBCorroborated=' +
      corroborated +
      ' nonNative=' +
      nonNative.length +
      ' unclassified=0 sanctioned=' +
      SANCTIONED_DELEGATIONS.length +
      '/' +
      SANCTIONED_DELEGATIONS.length +
      ' siteCounts=OK; ' +
      '[A11Y-13] pairedReceivers=' +
      pairedReceivers.length +
      ' identityChecked=' +
      identityChecked +
      ' sharedIds=[' +
      sharedIds.join(',') +
      '] resolvedNamedRefs=' +
      countResolvedNamedRefs(sources) +
      ' unparseable=0; ' +
      '[A11Y-T3] tabWrites=' +
      tabWrites +
      ' negOnListener=0 listenerCandidates=' +
      listenerCandidates +
      ' htmlNegIds=' +
      htmlNegIds +
      '; ' +
      '[A11Y-T5] tsPositive=0 nonInteger=0; pins=' +
      TABINDEX_DELEGATIONS.length +
      '/' +
      TABINDEX_DELEGATIONS.length +
      ' nonInert=' +
      TABINDEX_DELEGATIONS.length +
      '/' +
      TABINDEX_DELEGATIONS.length +
      ' reachable=Y; teeth=' +
      teethRes.teeth +
      '/' +
      teethRes.teethTotal,
  };
}

function matchEntry(rec) {
  for (const e of SANCTIONED_DELEGATIONS) {
    if (e.file === rec.file && e.receiverText === rec.site.receiverText) return e;
  }
  return null;
}

/** MULTISET equality, both directions, plus the global site-count sum. */
function checkRatchet(nonNative) {
  const counts = new Map();
  for (const rec of nonNative) {
    const key = rec.file + '|' + rec.site.receiverText;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let expectedTotal = 0;
  for (const e of SANCTIONED_DELEGATIONS) {
    const key = e.file + '|' + e.receiverText;
    expectedTotal += e.count;
    const got = counts.get(key) || 0;
    if (got !== e.count) {
      return (
        '[A11Y-12] RATCHET: sanctioned delegation ' +
        key +
        ' has ' +
        got +
        ' click site(s), the frozen table declares ' +
        e.count +
        (got === 0
          ? ' — an accessible control was DELETED, which a cap-based check reports as GREEN'
          : ' — a new non-native site was absorbed by an existing key')
      );
    }
    counts.delete(key);
  }
  if (counts.size > 0) {
    const extra = [];
    for (const [k, v] of counts) extra.push(k + ' x' + v);
    return (
      '[A11Y-12] UNSANCTIONED non-native click site(s): ' +
      extra.join(', ') +
      ' — a click listener on an element that is not a native button/anchor and is not one of ' +
      'the two declared delegations. Add a keyboard equivalent, or make the element a <button>.'
    );
  }
  if (nonNative.length !== expectedTotal) {
    return (
      '[A11Y-12] RATCHET: ' +
      nonNative.length +
      ' non-native sites vs ' +
      expectedTotal +
      ' declared'
    );
  }
  return null;
}

/**
 * Re-derive `main.ts`'s delegation from source. Freezing the selector list alone was MEASURED
 * insufficient: a one-token downgrade of the PRODUCER passes it while breaking the a11y property.
 */
function checkNarrowedDelegation(sources) {
  const main = sources.get('main.ts');
  if (main === undefined) return '[A11Y-12] main.ts is missing from the walked set';
  const clicks = findClickSites(main).filter((s) => s.receiverText === 'document');
  if (clicks.length !== 1) {
    return (
      '[A11Y-12] expected exactly 1 document-delegated click in main.ts, found ' + clicks.length
    );
  }
  const body = clicks[0].handlerText;

  // Every narrowing idiom used must be one we recognise AND carry a literal selector.
  const seen = [];
  for (const idiom of NARROWING_IDIOMS) {
    let i = 0;
    while (true) {
      const at = body.indexOf(idiom, i);
      if (at === -1) break;
      i = at + idiom.length;
      if (idiom === '.dataset.' || idiom.indexOf('(') === -1) {
        seen.push(idiom);
        continue;
      }
      const open = at + idiom.length - 1;
      const close = matchDelim(body, open);
      if (close === -1) return '[A11Y-12] unbalanced ' + idiom + ' in the main.ts delegation';
      const arg = body.slice(open + 1, close).trim();
      const lit = stringLiteralValue(arg);
      if (lit === null) {
        return (
          '[A11Y-12] NON-LITERAL narrowing selector ' +
          arg +
          ' in the main.ts delegation — the ' +
          'target element type cannot be proven, so the delegation cannot be sanctioned'
        );
      }
      seen.push(lit);
    }
  }
  const declared = NARROWED_SELECTORS.map((s) => s.selector);
  for (const lit of seen) {
    if (lit.indexOf('[') !== 0) continue;
    if (declared.indexOf(lit) === -1) {
      return (
        '[A11Y-12] UNDECLARED narrowing selector ' +
        lit +
        ' in the main.ts delegation — add it ' +
        'to NARROWED_SELECTORS together with a proof that its producer is a native button'
      );
    }
  }
  for (const s of NARROWED_SELECTORS) {
    if (body.indexOf(s.selector) === -1) {
      return (
        '[A11Y-12] declared narrowing selector ' +
        s.selector +
        ' is GONE from the main.ts ' +
        'delegation — the frozen table no longer describes the shipped code'
      );
    }
    const verdict = producerIsNative(sources, s);
    if (verdict !== null) return verdict;
  }
  return null;
}

/** Prove, from source, that whatever produces a narrowed selector's target is a native button. */
function producerIsNative(sources, s) {
  if (s.html !== undefined) {
    let html;
    try {
      html = stripHtmlComments(readFileSync(INDEX_HTML, 'utf8'));
    } catch (e) {
      return (
        '[A11Y-12] could not read ' + INDEX_HTML + ': ' + (e && e.message ? e.message : String(e))
      );
    }
    const at = html.indexOf(s.html);
    if (at === -1) {
      return '[A11Y-12] producer for ' + s.selector + ' is gone from ' + INDEX_HTML;
    }
    const open = html.lastIndexOf('<', at);
    const tag = html.slice(open, at);
    if (tag.indexOf('<button') !== 0 && tag.indexOf('<a ') !== 0) {
      return (
        '[A11Y-12] PRODUCER DOWNGRADED: ' +
        s.selector +
        ' is produced by ' +
        tag.trim() +
        ' in ' +
        INDEX_HTML +
        ', not a native <button>/<a> — the delegated click is no longer ' +
        'keyboard-reachable'
      );
    }
    return null;
  }
  const src = sources.get(s.producer);
  if (src === undefined) return '[A11Y-12] producer file ' + s.producer + ' is missing';
  const write = '.dataset.' + s.dataset;
  const at = src.indexOf(write);
  if (at === -1) {
    return (
      '[A11Y-12] nothing in ' +
      s.producer +
      ' writes ' +
      write +
      ', so nothing produces ' +
      s.selector +
      ' — the frozen table no longer describes the shipped code'
    );
  }
  if (countOccurrences(src, write) !== 1) {
    return (
      '[A11Y-12] ' + write + ' is written more than once in ' + s.producer + ' — ambiguous producer'
    );
  }
  const recv = receiverTextBefore(src, at);
  if (recv === null) return '[A11Y-12] could not key the producer receiver for ' + s.selector;
  const cls = classify(src, { receiverText: recv, line: lineOf(src, at) });
  if (cls.arm !== 'native') {
    return (
      '[A11Y-12] PRODUCER DOWNGRADED: ' +
      s.producer +
      "'s " +
      recv +
      ' (which carries ' +
      s.selector +
      ') is ' +
      cls.reason +
      ' — a one-token change here makes every delegated ' +
      'target non-focusable while the selector table stays byte-identical'
    );
  }
  return null;
}

/** How many handlers were reached through a NAMED reference rather than an inline literal. */
function countResolvedNamedRefs(sources) {
  let n = 0;
  for (const [, src] of sources) {
    for (const s of findClickSites(src).concat(findKeydownSites(src))) {
      if (s.spelling !== 'addEventListener') continue;
      if (s.handlerText.indexOf('=>') === -1 && s.handlerText.indexOf('function') !== 0) continue;
      const at = indexOfSite(src, s);
      const open = src.indexOf('(', at);
      if (open === -1) continue;
      const close = matchDelim(src, open);
      if (close === -1) continue;
      const args = splitArgs(src.slice(open + 1, close));
      if (args.length > 1 && args[1].indexOf('=>') === -1 && args[1].indexOf('function') !== 0) n++;
    }
  }
  return n;
}
