// Deletion-grace-window wasm SSOT eval (M22 / ADR-0031, rb-8).
//
// WHY THIS GATE EXISTS: `game_core::DELETION_GRACE_MS_DEFAULT`
// (`game-core/src/accounts/deletion.rs`) is the one legible number an
// operator will eventually replace (see the HONESTY NOTE beside the
// constant). client-wasm exports four precedent SSOT accessors already
// (`step_ms`, `move_queue_cap`, `party_size`, `party_slot_none` —
// `client-wasm/src/lib.rs:173-201`); this slice adds a fifth,
// `deletion_grace_ms_default()`, so TS never hand-types the grace window.
// A hand-typed TS duplicate, or a wrapper that LOOKS like it delegates but
// actually returns a hardcoded literal, silently desyncs the moment an
// operator retunes the real constant — the client would keep showing (or
// gating on) the old window while the server enforces the new one. This
// gate pins the *shape* of the delegation (not just its behavior on one
// input, which a hardcoded duplicate would also satisfy), that it is
// actually reachable from JS through the compiled wasm boundary, that the
// live value round-trips byte-for-byte as a bigint, and that nothing under
// `client/src` (or the wrapper itself) still carries a duplicate literal.
//
// KNOWN LIMITS (stated plainly, not implied away):
//   - G4 is a TEXT ORACLE over `game-core/src/accounts/deletion.rs`, cross-
//     checked against the COMPILED wasm's actual return value (G3) — it is
//     not a substitute for the native Rust test
//     `deletion_grace_matches_game_core_const` the implementer adds under
//     `client-wasm/src/lib.rs`'s `#[cfg(test)] mod tests` (:256); that native
//     test is the one true parity check inside the same process. This eval
//     proves the JS-reachable surface matches it from the *outside*.
//   - G5's `findNumericDuplicates` is a DETECTOR, not a proof of absence. It
//     recognises plain/underscored/hex/exponent/BigInt-suffixed literals and
//     maximal pure-numeric `*`/`+` chains, evaluated left-to-right against a
//     single target value. It CANNOT close `Number('60480' + '0000')`,
//     base-36 encodings, split-string concatenation, or a value buried in a
//     JSON/YAML fixture. Treat a clean G5 as "no naive duplicate today", not
//     "provably impossible to duplicate".
//   - `accessorBody`'s brace-balanced reader does not understand Rust string
//     or char literals — a body containing a `{`/`}` inside a string would
//     desync its depth counter. The accessors this gate inspects are single
//     expressions with no string literals, so this is out of scope here, but
//     it is not a general-purpose Rust body extractor.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const FN_NAME = 'deletion_grace_ms_default';
const DELEGATE_EXPR = 'game_core::DELETION_GRACE_MS_DEFAULT';

// ---------------------------------------------------------------------------
// G1 primitives (exported, pure, teeth-tested below)
// ---------------------------------------------------------------------------

// Strip Rust comments so prose that *mentions* the delegate path (a doc
// comment, or a decoy comment planted directly above a hardcoded literal)
// never fools a text-shape check — only real code is inspected.
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Extract the body of `pub fn <fnName>(...) -> ... { <body> }` with a REAL
// brace-balanced reader (depth counter), never a `\{([^}]*)\}` capture.
//
// Bites: the measured red-team bypass of a non-brace-matching regex —
//   pub fn deletion_grace_ms_default() -> i64 {
//       let _ = { game_core::DELETION_GRACE_MS_DEFAULT };
//       0x75BCA00i64            // an obfuscated hardcoded duplicate
//   }
// A `\{([^}]*)\}` capture stops at the FIRST nested `}` and never sees the
// hardcoded literal that actually gets returned. A depth counter walks past
// the nested block and returns the true full body, which is what lets the
// exact-string check downstream (in `checkG1`) reject it.
//
// Returns `null` if `fnName` is not found at all (never throws for "absent"
// — that is a legitimate not-yet-implemented state on the pre-fix tree).
// THROWS if the function is found but its braces never balance — never
// silently skips a malformed file.
export function accessorBody(strippedSrc, fnName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fnName)) {
    throw new Error(`accessorBody: refusing a non-identifier fnName ${JSON.stringify(fnName)}`);
  }
  const marker = `pub fn ${fnName}(`;
  const fnIdx = strippedSrc.indexOf(marker);
  if (fnIdx === -1) return null;
  const braceIdx = strippedSrc.indexOf('{', fnIdx);
  if (braceIdx === -1) {
    throw new Error(`accessorBody: found "${marker}" but no opening brace before EOF`);
  }
  let depth = 0;
  for (let i = braceIdx; i < strippedSrc.length; i++) {
    const ch = strippedSrc[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return strippedSrc.slice(braceIdx + 1, i);
      }
    }
  }
  throw new Error(`accessorBody: unbalanced braces walking the body of ${fnName} (never returned to depth 0)`);
}

// Collapse whitespace runs to one space and trim, so formatting differences
// (trailing semicolons aside — Rust block-tail-expressions have none) never
// cause a false negative on an honestly-shaped delegate.
export function normalizeWhitespace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// A path-qualified `game_core::X` can only be redirected two ways: renaming
// the `game_core` path itself (`use ... as game_core;`), or shadowing the
// target name so a *different* `DELETION_GRACE_MS_DEFAULT` resolves first
// (`const`/`static`/`let DELETION_GRACE_MS_DEFAULT` or
// `use ... as DELETION_GRACE_MS_DEFAULT;`). Both leave the accessor body's
// TEXT byte-identical to the honest shape, so the exact-string pin in
// `checkG1` cannot see them — this is the second half of G1's teeth.
export function hasAliasOrRebinding(strippedSrc) {
  if (/\buse\b[^;]*\bas\s+game_core\b/.test(strippedSrc)) return true;
  if (/\b(?:const|static|let)\s+DELETION_GRACE_MS_DEFAULT\b/.test(strippedSrc)) return true;
  if (/\buse\b[^;]*\bas\s+DELETION_GRACE_MS_DEFAULT\b/.test(strippedSrc)) return true;
  return false;
}

// G1's real check: the accessor body is EXACTLY `game_core::DELETION_GRACE_MS_DEFAULT`
// (never a substring/contains check — see the header note on why) AND
// nothing in the file redirects that path.
export function checkG1(strippedSrc) {
  const body = accessorBody(strippedSrc, FN_NAME);
  if (body === null) return false;
  if (normalizeWhitespace(body) !== DELEGATE_EXPR) return false;
  if (hasAliasOrRebinding(strippedSrc)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// G2 primitive
// ---------------------------------------------------------------------------

// Does `#[wasm_bindgen]` appear in the contiguous attribute run immediately
// preceding `pub fn <fnName>`? Bites: deleting the attribute — the fn still
// compiles and its native test still passes, but wasm-bindgen never
// generates a JS export for it, so G3 would be the only thing to catch a
// silently-unexported accessor without this clause.
export function hasBindgenAttr(strippedSrc, fnName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fnName)) {
    throw new Error(`hasBindgenAttr: refusing a non-identifier fnName ${JSON.stringify(fnName)}`);
  }
  const marker = `pub fn ${fnName}(`;
  const fnIdx = strippedSrc.indexOf(marker);
  if (fnIdx === -1) return false;
  let i = fnIdx;
  while (i > 0 && /\s/.test(strippedSrc[i - 1])) i--;
  let sawWasmBindgen = false;
  for (;;) {
    if (strippedSrc[i - 1] !== ']') break;
    const closeIdx = i - 1;
    const openIdx = strippedSrc.lastIndexOf('[', closeIdx);
    const hashIdx = openIdx - 1;
    if (openIdx === -1 || hashIdx < 0 || strippedSrc[hashIdx] !== '#') break;
    const attrText = strippedSrc.slice(hashIdx, closeIdx + 1);
    if (/^#\[\s*wasm_bindgen\b/.test(attrText)) sawWasmBindgen = true;
    i = hashIdx;
    while (i > 0 && /\s/.test(strippedSrc[i - 1])) i--;
  }
  return sawWasmBindgen;
}

// ---------------------------------------------------------------------------
// G4 primitive
// ---------------------------------------------------------------------------

// Parse the `game-core` source for the ONE literal `i64` initializer of
// `DELETION_GRACE_MS_DEFAULT`. THROWS (never defaults to 0, never silently
// reads a decoy) if there are zero matches, more than one match, or the
// initializer is not a bare digit/underscore run (an expression like
// `7 * 24 * 60 * 60 * 1000` is refused, not evaluated).
export function parseGraceConst(rustSrc) {
  const stripped = stripRustComments(rustSrc);
  const declRe = /pub const DELETION_GRACE_MS_DEFAULT\s*:\s*i64\s*=\s*([^;]+);/g;
  const matches = [...stripped.matchAll(declRe)];
  if (matches.length === 0) {
    throw new Error('parseGraceConst: no `pub const DELETION_GRACE_MS_DEFAULT: i64 = ...;` declaration found');
  }
  if (matches.length > 1) {
    throw new Error(`parseGraceConst: ${matches.length} declarations found, expected exactly one`);
  }
  const rhs = matches[0][1].trim();
  if (!/^[0-9_]+$/.test(rhs)) {
    throw new Error(`parseGraceConst: initializer is not a bare integer literal (got \`${rhs}\`) — refusing to evaluate an expression`);
  }
  const digits = rhs.replace(/_/g, '');
  if (digits.length === 0) {
    throw new Error('parseGraceConst: empty numeric literal');
  }
  return BigInt(digits);
}

// ---------------------------------------------------------------------------
// G5 primitives
// ---------------------------------------------------------------------------
//
// SECURITY NOTE: every regex below is a small literal pattern with no nested
// quantifiers over an unbounded alternation (no `(a+)+` shape) and no
// runtime-constructed regex source, so there is no catastrophic-backtracking
// surface for remote Semgrep's `detect-non-literal-regexp` / ReDoS rules to
// flag. The `*`/`+` arithmetic-chain combination itself is a hand-written
// character scan, not a regex, per the same instruction.

const HEX_TOKEN_RE = /0[xX][0-9a-fA-F_]+n?/y;
const DEC_TOKEN_RE = /[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?n?/y;

function isIdentChar(ch) {
  return ch !== undefined && /[0-9A-Za-z_.]/.test(ch);
}

// Match a single numeric token (hex or decimal/float/exponent/BigInt-suffixed)
// starting EXACTLY at `pos`, refusing a match that starts or ends mid an
// identifier/number (so "CONST123456000" and "123456000ms" are never
// mistaken for a bare numeric literal).
function matchNumberTokenAt(text, pos) {
  if (isIdentChar(text[pos - 1])) return null;
  HEX_TOKEN_RE.lastIndex = pos;
  let m = HEX_TOKEN_RE.exec(text);
  if (m && m.index === pos) {
    if (isIdentChar(text[pos + m[0].length])) return null;
    return { raw: m[0], end: pos + m[0].length };
  }
  DEC_TOKEN_RE.lastIndex = pos;
  m = DEC_TOKEN_RE.exec(text);
  if (m && m.index === pos) {
    if (isIdentChar(text[pos + m[0].length])) return null;
    return { raw: m[0], end: pos + m[0].length };
  }
  return null;
}

function tokenValue(raw) {
  let s = raw.endsWith('n') ? raw.slice(0, -1) : raw;
  if (s[0] === '0' && (s[1] === 'x' || s[1] === 'X')) {
    const hex = s.slice(2).replace(/_/g, '');
    if (hex.length === 0) return null;
    return BigInt(`0x${hex}`);
  }
  const cleaned = s.replace(/_/g, '');
  if (cleaned.length === 0) return null;
  if (/[.eE]/.test(cleaned)) {
    const num = Number(cleaned);
    if (!Number.isFinite(num) || !Number.isInteger(num)) return null;
    return BigInt(num);
  }
  return BigInt(cleaned);
}

function skipInlineWhitespace(text, pos) {
  let i = pos;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

// Report every maximal numeric literal or pure-numeric `*`/`+` chain in
// `text` that evaluates to exactly `targetBigInt`. Returns an array of the
// matched raw text (empty means "no duplicate found"). See file header for
// what this detector cannot close.
export function findNumericDuplicates(text, targetBigInt) {
  const hits = [];
  for (let i = 0; i < text.length; i++) {
    const first = matchNumberTokenAt(text, i);
    if (!first) continue;
    let value = tokenValue(first.raw);
    if (value === null) continue;
    let end = first.end;
    let chainText = first.raw;
    for (;;) {
      const afterWs = skipInlineWhitespace(text, end);
      const op = text[afterWs];
      if (op !== '*' && op !== '+') break;
      const nextStart = skipInlineWhitespace(text, afterWs + 1);
      const next = matchNumberTokenAt(text, nextStart);
      if (!next) break;
      const nextValue = tokenValue(next.raw);
      if (nextValue === null) break;
      value = op === '*' ? value * nextValue : value + nextValue;
      chainText = `${chainText} ${op} ${next.raw}`;
      end = next.end;
    }
    if (value === targetBigInt) hits.push(chainText);
  }
  return hits;
}

// Recursively list every `.ts` file under `rootDir`, excluding any subtree
// rooted at a directory literally named `module_bindings` (the ONLY
// generated exclusion the spec allows — `*.test.ts` is deliberately NOT
// exempt: a red-team agent proved a `.test.ts` file exporting a duplicate
// literal and imported by ordinary `.ts` typechecks clean and bundles).
function listTsFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'module_bindings') continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture table (run BEFORE the real scan).
//
// A made-up target — 123_456_000 — stands in for the real grace-window
// value in every fixture below so the real digits never appear in this file
// (see G4's clause comment in the default export for why that matters).
// Hex/exponent spellings of that made-up target, computed once:
//   123_456_000 == 0x75BCA00 == 1.23456e8 == 1000 * 123456
// ---------------------------------------------------------------------------

const REAL_SHAPE_SRC = `
#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    game_core::DELETION_GRACE_MS_DEFAULT
}`;

const FIXTURES = [
  // --- G1: the accessor body must be exactly the delegate expression -----
  { id: 'GOOD_G1_REAL_SHAPE', kind: 'GOOD', clause: 'G1', input: REAL_SHAPE_SRC, expect: true },
  {
    id: 'BAD_NESTED_BLOCK_HEX',
    kind: 'BAD',
    clause: 'G1',
    // The measured red-team bypass: a discarded nested block hides the
    // delegate expression, then a hex literal (spelling the made-up
    // fixture target, NOT the real constant) is actually returned.
    input: `
#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    let _ = { game_core::DELETION_GRACE_MS_DEFAULT };
    0x75BCA00i64
}`,
    expect: false,
  },
  {
    id: 'BAD_LITERAL',
    kind: 'BAD',
    clause: 'G1',
    input: `
#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    123456000i64
}`,
    expect: false,
  },
  {
    id: 'BAD_ARITH',
    kind: 'BAD',
    clause: 'G1',
    input: `
#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    100 * 2 * 3
}`,
    expect: false,
  },
  {
    id: 'BAD_WRONG_CONST',
    kind: 'BAD',
    clause: 'G1',
    input: `
#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    game_core::EXPORT_CHUNK_ROWS as i64
}`,
    expect: false,
  },
  {
    id: 'BAD_DECOY_COMMENT',
    kind: 'BAD',
    clause: 'G1',
    input: `
// game_core::DELETION_GRACE_MS_DEFAULT (decoy — the real body is below)
#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    123456000i64
}`,
    expect: false,
  },
  {
    id: 'BAD_ALIAS',
    kind: 'BAD',
    clause: 'G1',
    // Body text is byte-identical to the honest shape; only the `use ...
    // as game_core;` redirect (caught by hasAliasOrRebinding) makes it BAD.
    input: `
use crate::other_mod as game_core;

#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    game_core::DELETION_GRACE_MS_DEFAULT
}`,
    expect: false,
  },
  {
    id: 'BAD_UNBALANCED_BRACES',
    kind: 'BAD',
    clause: 'G1-throw',
    input: `
#[wasm_bindgen]
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    game_core::DELETION_GRACE_MS_DEFAULT`,
    expect: 'THROW',
  },

  // --- G2: #[wasm_bindgen] must precede the fn --------------------------
  { id: 'GOOD_G2_REAL_SHAPE', kind: 'GOOD', clause: 'G2', input: REAL_SHAPE_SRC, expect: true },
  {
    id: 'BAD_NO_ATTR',
    kind: 'BAD',
    clause: 'G2',
    input: `
#[must_use]
pub fn deletion_grace_ms_default() -> i64 {
    game_core::DELETION_GRACE_MS_DEFAULT
}`,
    expect: false,
  },

  // --- G4: parseGraceConst is a strict single-literal oracle -------------
  {
    id: 'GOOD_G4_DECOY',
    kind: 'GOOD',
    clause: 'G4',
    input: `
/* decoy: an unrelated subsystem once used 999_999 ms, ignore it */
// a stale doc note mentioned 42 here too, also ignore
pub const DELETION_GRACE_MS_DEFAULT: i64 = 123_456_000;`,
    expect: 123456000n,
  },
  {
    id: 'BAD_G4_MISSING',
    kind: 'BAD',
    clause: 'G4',
    input: `pub const OTHER_THING: i64 = 42;`,
    expect: 'THROW',
  },
  {
    id: 'BAD_G4_TWO_DEFS',
    kind: 'BAD',
    clause: 'G4',
    input: `
pub const DELETION_GRACE_MS_DEFAULT: i64 = 111_000;
pub const DELETION_GRACE_MS_DEFAULT: i64 = 222_000;`,
    expect: 'THROW',
  },
  {
    id: 'BAD_G4_EXPR',
    kind: 'BAD',
    clause: 'G4',
    input: `pub const DELETION_GRACE_MS_DEFAULT: i64 = 2 * 3 * 4 * 5;`,
    expect: 'THROW',
  },

  // --- G5: findNumericDuplicates must catch every required spelling ------
  {
    id: 'GOOD_G5_NO_HIT',
    kind: 'GOOD',
    clause: 'G5',
    input: `export const STEP_MS = 100;\nexport const PARTY_SIZE = 6;\nexport const RETRY_MS = 3000;\n`,
    target: 123456000n,
    expect: false,
  },
  {
    id: 'BAD_G5_SEPARATOR',
    kind: 'BAD',
    clause: 'G5',
    input: `export const GRACE_MS = 123_456_000;\n`,
    target: 123456000n,
    expect: true,
  },
  {
    id: 'BAD_G5_HEX',
    kind: 'BAD',
    clause: 'G5',
    input: `export const GRACE_MS = 0x75BCA00;\n`,
    target: 123456000n,
    expect: true,
  },
  {
    id: 'BAD_G5_EXPONENT',
    kind: 'BAD',
    clause: 'G5',
    input: `export const GRACE_MS = 1.23456e8;\n`,
    target: 123456000n,
    expect: true,
  },
  {
    id: 'BAD_G5_ARITH_CHAIN',
    kind: 'BAD',
    clause: 'G5',
    input: `export const GRACE_MS = 1000 * 123456;\n`,
    target: 123456000n,
    expect: true,
  },
];

function runFixture(fx) {
  switch (fx.clause) {
    case 'G1':
      return checkG1(stripRustComments(fx.input));
    case 'G1-throw':
      accessorBody(stripRustComments(fx.input), FN_NAME);
      return true; // only reached if it did NOT throw
    case 'G2':
      return hasBindgenAttr(stripRustComments(fx.input), FN_NAME);
    case 'G4':
      return parseGraceConst(fx.input);
    case 'G5':
      return findNumericDuplicates(fx.input, fx.target).length > 0;
    default:
      throw new Error(`runFixture: unknown clause ${fx.clause}`);
  }
}

function describeExpect(expect) {
  if (expect === 'THROW') return 'THROW';
  if (typeof expect === 'bigint') return `${expect}n`;
  return JSON.stringify(expect);
}

function describeActual(threw, actual) {
  if (threw) return `THREW: ${actual && actual.message ? actual.message : String(actual)}`;
  if (typeof actual === 'bigint') return `${actual}n`;
  return JSON.stringify(actual);
}

export default async function () {
  const name = 'deletion-grace-wasm-ssot (client-wasm deletion_grace_ms_default delegates to game_core::DELETION_GRACE_MS_DEFAULT)';

  // -------------------------------------------------------------------
  // Teeth: every fixture must produce its declared verdict before the
  // real scan runs at all. `bit`/`FIXTURES.length` are both computed
  // from this loop, never hand-written literals.
  // -------------------------------------------------------------------
  let bit = 0;
  for (const fx of FIXTURES) {
    let actual;
    let threw = false;
    try {
      actual = runFixture(fx);
    } catch (e) {
      threw = true;
      actual = e;
    }
    const ok = fx.expect === 'THROW' ? threw : !threw && actual === fx.expect;
    if (ok) {
      bit++;
    } else {
      return {
        name,
        pass: false,
        detail: `FAIL [teeth]: ${fx.id} (clause ${fx.clause}) expected ${describeExpect(fx.expect)}, got ${describeActual(threw, actual)}`,
      };
    }
  }
  const total = FIXTURES.length;

  // -------------------------------------------------------------------
  // G1 + G2: static source checks on the real client-wasm/src/lib.rs.
  // Ordered BEFORE G3's wasm-pack build (expensive) since on the
  // pre-fix tree the function does not exist at all — a fast, correct
  // static-text reason to fail rather than an opaque build-adjacent one.
  // -------------------------------------------------------------------
  const libPath = path.resolve('client-wasm/src/lib.rs');
  let rawLib;
  try {
    rawLib = readFileSync(libPath, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `FAIL [G1/delegates]: cannot read ${libPath}: ${e.message}` };
  }
  const strippedLib = stripRustComments(rawLib);

  let body;
  try {
    body = accessorBody(strippedLib, FN_NAME);
  } catch (e) {
    return { name, pass: false, detail: `FAIL [G1/delegates]: ${e.message}` };
  }
  if (body === null) {
    return {
      name,
      pass: false,
      detail: `FAIL [G1/delegates]: \`pub fn ${FN_NAME}\` not found in client-wasm/src/lib.rs`,
    };
  }
  const normalized = normalizeWhitespace(body);
  if (normalized !== DELEGATE_EXPR) {
    return {
      name,
      pass: false,
      detail: `FAIL [G1/delegates]: body is not exactly \`${DELEGATE_EXPR}\` (got \`${normalized}\`)`,
    };
  }
  if (hasAliasOrRebinding(strippedLib)) {
    return {
      name,
      pass: false,
      detail: 'FAIL [G1/delegates]: an alias/rebinding of `game_core` or `DELETION_GRACE_MS_DEFAULT` was found in lib.rs',
    };
  }

  if (!hasBindgenAttr(strippedLib, FN_NAME)) {
    return {
      name,
      pass: false,
      detail: `FAIL [G2/bindgen]: #[wasm_bindgen] does not directly precede \`pub fn ${FN_NAME}\``,
    };
  }

  // -------------------------------------------------------------------
  // G3: build the wasm fresh (never trust a stale pkg/) and require it.
  // -------------------------------------------------------------------
  try {
    execSync('wasm-pack build client-wasm --dev --target nodejs --out-dir pkg', {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    const err = String(e.stderr || e.message).slice(0, 400);
    return { name, pass: false, detail: `FAIL [G3/js-reachable]: wasm-pack build failed: ${err}` };
  }
  const pkgPath = path.resolve('client-wasm/pkg/client_wasm.js');
  if (!existsSync(pkgPath)) {
    return { name, pass: false, detail: `FAIL [G3/js-reachable]: wasm pkg not found at ${pkgPath}` };
  }
  const nodeRequire = createRequire(import.meta.url);
  let wasm;
  try {
    wasm = nodeRequire(pkgPath);
  } catch (e) {
    return { name, pass: false, detail: `FAIL [G3/js-reachable]: require(${pkgPath}) threw: ${e.message}` };
  }
  if (typeof wasm[FN_NAME] !== 'function') {
    return {
      name,
      pass: false,
      detail: `FAIL [G3/js-reachable]: wasm.${FN_NAME} is not a function (got ${typeof wasm[FN_NAME]})`,
    };
  }
  let callResult;
  try {
    callResult = wasm[FN_NAME]();
  } catch (e) {
    return { name, pass: false, detail: `FAIL [G3/js-reachable]: calling wasm.${FN_NAME}() threw: ${e.message}` };
  }

  // -------------------------------------------------------------------
  // G4: value parity, cross-checked as a bigint (bites a `-> u32`/`-> f64`
  // signature change, which would arrive here as a `number`, not a bigint).
  // -------------------------------------------------------------------
  const deletionPath = path.resolve('game-core/src/accounts/deletion.rs');
  let deletionSrc;
  try {
    deletionSrc = readFileSync(deletionPath, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `FAIL [G4/value-parity]: cannot read ${deletionPath}: ${e.message}` };
  }
  let expectedBig;
  try {
    expectedBig = parseGraceConst(deletionSrc);
  } catch (e) {
    return { name, pass: false, detail: `FAIL [G4/value-parity]: ${e.message}` };
  }
  if (typeof callResult !== 'bigint') {
    return {
      name,
      pass: false,
      detail: `FAIL [G4/value-parity]: wasm.${FN_NAME}() returned a ${typeof callResult}, expected bigint`,
    };
  }
  if (callResult !== expectedBig) {
    return {
      name,
      pass: false,
      detail: `FAIL [G4/value-parity]: wasm returned ${callResult}n, game-core const is ${expectedBig}n`,
    };
  }

  // -------------------------------------------------------------------
  // G5: no hand-typed TS (or lib.rs) duplicate of the live value.
  // -------------------------------------------------------------------
  const clientSrcRoot = path.resolve('client/src');
  let scanFiles;
  try {
    scanFiles = listTsFiles(clientSrcRoot);
  } catch (e) {
    return { name, pass: false, detail: `FAIL [G5/no-ts-dup]: cannot walk ${clientSrcRoot}: ${e.message}` };
  }

  const dupHits = [];
  for (const file of scanFiles) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (e) {
      return { name, pass: false, detail: `FAIL [G5/no-ts-dup]: cannot read ${file}: ${e.message}` };
    }
    const hits = findNumericDuplicates(content, expectedBig);
    if (hits.length > 0) {
      dupHits.push(`${path.relative(process.cwd(), file)} (${hits.join(', ')})`);
    }
  }
  // Comment-stripped lib.rs is a scanned unit too — RAW would false-flag an
  // honest doc comment that mentions the value in prose.
  const libHits = findNumericDuplicates(strippedLib, expectedBig);
  if (libHits.length > 0) {
    dupHits.push(`client-wasm/src/lib.rs [comment-stripped] (${libHits.join(', ')})`);
  }
  const filesScanned = scanFiles.length + 1;

  if (filesScanned < 150) {
    return {
      name,
      pass: false,
      detail: `FAIL [G5/no-ts-dup]: only scanned ${filesScanned} files (<150) — scan root misconfigured or client/src moved`,
    };
  }
  if (dupHits.length > 0) {
    return {
      name,
      pass: false,
      detail: `FAIL [G5/no-ts-dup]: numeric duplicate of the live grace-window value (${expectedBig}ms) found in: ${dupHits.join('; ')}`,
    };
  }

  return {
    name,
    pass: true,
    detail: `ssot honoured — [G1/delegates] [G2/bindgen] [G3/js-reachable] [G4/value-parity=${expectedBig}ms bigint] [G5/no-ts-dup files=${filesScanned}] [teeth ${bit}/${total} fixtures bit]`,
  };
}
