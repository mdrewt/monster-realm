// trade-cap-parity eval (14r-f EARS-3, ADR-0188): the client's trade-side monster
// cap must be a MIRROR of the server's cap, not a second source of truth.
//
// THE SSOT is `const MAX_TRADE_MONSTERS_PER_SIDE: usize = 64;` at
// server-module/src/trading.rs:37. The check at trading.rs:44 is `n_monsters > MAX`,
// so the cap is INCLUSIVE: 64 is legal, 65 rejects.
//
// WHAT THIS GATE PINS, and why each leg exists:
//
//   TCP1  the SERVER cap parses out of trading.rs, exactly once. If it cannot be
//         found the gate FAILS LOUD — "nothing to check" is the false-green shape
//         this repo has been bitten by before (memory: doc-vs-code SSOT gates).
//   TCP2  the CLIENT constant parses out of client/src/ui/tradeProposeModel.ts,
//         exactly once, and is `export`ed. A file-private const, a commented-out
//         declaration, a decoy inside a string literal, or an inlined bare `64`
//         must all FAIL: without a reachable exported name the vitest boundary
//         table cannot pin the value and this gate cannot prove the mirror.
//   TCP3  the two numbers are EQUAL, with BOTH rendered in the failure detail so
//         the direction of the drift is readable without opening either file.
//   TCP4  [plan finding R2 — the leg that makes TCP2 mean something]
//         `buildProposeSubmission`'s OWN body must contain the contiguous
//         compacted adjacency `selectedMonsterIds.length<=MAX_TRADE_MONSTERS_PER_SIDE`.
//
//         Without TCP4 this gate is satisfiable by shipping a bare literal
//         `draft.selectedMonsterIds.length <= 64` in the clause NEXT TO a
//         disconnected exported `MAX_TRADE_MONSTERS_PER_SIDE = 64`. That impl
//         passes the vitest boundary table (the behaviour is correct TODAY) and
//         passes TCP1-TCP3 (the const exists, is exported, and equals 64) while
//         the constant is decorative. The failure is silent future drift: bump
//         trading.rs to 128, a maintainer greps for the name and bumps the const,
//         and the literal that actually gates submission is never touched.
//         Nothing reds. TCP4 is the "adjacency, not presence" pattern
//         server-module/src/movement_tests.rs:306-314 already uses.
//
// SCANNING (ADR-0181/0186 house standard). The RUST side goes through
// evals/rust-scan.mjs `stripRustSource` + `assertStripperSound` — never a naive
// comment regex. The TYPESCRIPT side must NOT use stripRustSource (ADR-0181 D4
// FORBIDS it: blanking a payload makes a ban on a needle living inside a string
// literal pass vacuously, and the Rust lexer's char-literal/lifetime rules are
// wrong for TS). It uses `blankJsLiterals` from evals/scanner-migration-audit.eval.mjs
// — the repo's canonical JS/TS literal-BLANKING pass, which is exactly what is
// wanted here: a decoy declaration hidden inside a JS string must not satisfy
// TCP2. Cross-eval checker reuse is established practice in this tree
// (zone-warp-server-runtime <- battle-reducer-security; scanner-migration-audit
// <- rust-scan); importing an eval module executes only its definitions, never
// its default export.
//
// NAMING (deliberate, do not "fix"): this file is NOT named `*-security.eval.mjs`
// or `*-privacy.eval.mjs`. That suffix is the enumeration key of
// evals/scanner-migration-audit.eval.mjs:246, whose KNOWN_UNMIGRATED_CAP is
// exactly 7 (:124) and whose GATED_FLOOR/MIGRATED_FLOOR ratchets are measured
// against the current set — a `-security` name here would red that gate instantly.
// evals/run.mjs:11 globs `evals/*.eval.mjs`, so this file auto-discovers with no
// registration edit.
//
// No `new RegExp()` anywhere (Semgrep detect-non-literal-regexp is a hard remote
// gate that has bitten this project twice) — only String.indexOf/slice and
// literal /regex/.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertStripperSound, compactWs, countOccurrences, stripRustSource } from './rust-scan.mjs';
import { blankJsLiterals } from './scanner-migration-audit.eval.mjs';

const RUST_REL = 'server-module/src/trading.rs';
const TS_REL = 'client/src/ui/tradeProposeModel.ts';

/** The shared identifier. Spelled ONCE so the two sides cannot drift in this file. */
const CAP_NAME = 'MAX_TRADE_MONSTERS_PER_SIDE';
/** The client function whose body must carry the gating clause (TCP4 region scope). */
const TS_FN_NAME = 'buildProposeSubmission';
/** The TCP4 adjacency needle, in COMPACTED (whitespace-free) form. */
const CLAUSE_NEEDLE = `selectedMonsterIds.length<=${CAP_NAME}`;

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/**
 * Occurrences of `needle` in `hay` that are NOT followed by an identifier
 * character — so `MAX_TRADE_MONSTERS_PER_SIDE` never matches a longer name such
 * as `MAX_TRADE_MONSTERS_PER_SIDE_ITEMS`.
 * @param {string} hay Text to search.
 * @param {string} needle Literal needle.
 * @returns {number[]} Match offsets, in order.
 */
export function wordBoundedIndices(hay, needle) {
  const out = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const after = hay[at + needle.length];
    if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) continue;
    out.push(at);
  }
  return out;
}

/**
 * Every offset of a literal needle, with NO word-boundary condition.
 *
 * Used for needles that already END in a delimiter (`...:usize=`), where a
 * word-boundary check would be actively WRONG: the character after `=` is the
 * first digit of the value, which IS an identifier character, so a bounded
 * search would reject every real declaration and the gate would fail-loud on a
 * perfectly good source tree.
 * @param {string} hay Text to search.
 * @param {string} needle Literal needle.
 * @returns {number[]} Match offsets, in order.
 */
export function allIndices(hay, needle) {
  const out = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    out.push(at);
  }
  return out;
}

/**
 * Scan an unsigned decimal run starting at `at`.
 * @param {string} s Compacted text.
 * @param {number} at Start offset.
 * @returns {number} Offset one past the last digit (== `at` when there are none).
 */
function endOfDigits(s, at) {
  let j = at;
  while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
  return j;
}

/** A short, readable excerpt for a failure message. */
function excerpt(s, at, len = 60) {
  return s.slice(Math.max(0, at), Math.min(s.length, at + len));
}

// ---------------------------------------------------------------------------
// TCP1 — the SERVER cap.
// ---------------------------------------------------------------------------

/**
 * Parse `const MAX_TRADE_MONSTERS_PER_SIDE: usize = <n>;` out of trading.rs.
 * Fails LOUD (never "nothing to check") when absent, ambiguous, or non-numeric.
 * @param {string} rustSrc Raw trading.rs text.
 * @returns {{value:number}|{error:string}}
 */
export function parseRustCap(rustSrc) {
  const desync = assertStripperSound(rustSrc, RUST_REL);
  if (desync) {
    return {
      error:
        `TCP1/stripper: the Rust scanner desynced on ${RUST_REL}, so any cap read out of it ` +
        `would be untrustworthy — ${desync}`,
    };
  }

  const flat = compactWs(stripRustSource(rustSrc));
  const declNeedle = `const${CAP_NAME}:usize=`;
  // Unbounded on purpose — see allIndices: the needle ends in `=`, and the next
  // character is the value's first DIGIT.
  const hits = allIndices(flat, declNeedle);

  if (hits.length === 0) {
    const nameSeen = wordBoundedIndices(flat, CAP_NAME).length > 0;
    return {
      error:
        `TCP1/absent: could not parse a \`const ${CAP_NAME}: usize = <n>;\` declaration out of ` +
        `${RUST_REL} (expected exactly one, at trading.rs:37). ` +
        (nameSeen
          ? `The identifier IS present in the file, so the DECLARATION SHAPE changed (a different ` +
            `type, a \`pub\` re-home, or a move to guards.rs/lib.rs). Re-derive this parser — do ` +
            `NOT delete the check: an unparseable SSOT is a gate that silently stops gating.`
          : `The identifier does not appear at all — the server cap was renamed or removed. ` +
            `The client mirror in ${TS_REL} is now unanchored.`),
    };
  }
  if (hits.length > 1) {
    return {
      error:
        `TCP1/ambiguous: found ${hits.length} \`const ${CAP_NAME}: usize =\` declarations in ` +
        `${RUST_REL} (expected exactly 1). Which one bounds check_trade_side_size is no longer ` +
        `decidable by text, so the parity verdict below would be a coin flip.`,
    };
  }

  const at = hits[0] + declNeedle.length;
  const end = endOfDigits(flat, at);
  if (end === at) {
    return {
      error:
        `TCP1/non-numeric: \`const ${CAP_NAME}: usize =\` in ${RUST_REL} is not followed by a ` +
        `decimal literal — got "${excerpt(flat, at)}". A computed or const-fn cap cannot be ` +
        `mirrored by a client literal; re-derive both sides deliberately.`,
    };
  }
  let term = end;
  if (flat.startsWith('usize', term)) term += 5;
  else if (flat.startsWith('_usize', term)) term += 6;
  if (flat[term] !== ';') {
    return {
      error:
        `TCP1/unterminated: the \`const ${CAP_NAME}: usize = ${flat.slice(at, end)}\` declaration ` +
        `in ${RUST_REL} does not end at the literal — got "${excerpt(flat, at)}". The value is ` +
        `an expression, not a plain literal, so this gate refuses to guess it.`,
    };
  }
  return { value: Number(flat.slice(at, end)) };
}

// ---------------------------------------------------------------------------
// TCP2 — the CLIENT mirror.
// ---------------------------------------------------------------------------

/**
 * Parse `export const MAX_TRADE_MONSTERS_PER_SIDE = <n>;` out of the model.
 * An un-exported const, a commented-out one, and one hidden in a string literal
 * all FAIL — each with a distinct, attributable message.
 * @param {string} tsSrc Raw tradeProposeModel.ts text.
 * @returns {{value:number}|{error:string}}
 */
export function parseTsCap(tsSrc) {
  const { blanked } = blankJsLiterals(tsSrc);
  const flat = compactWs(blanked);
  const exportNeedle = `exportconst${CAP_NAME}`;
  const bareNeedle = `const${CAP_NAME}`;

  const exportHits = wordBoundedIndices(flat, exportNeedle);
  if (exportHits.length === 0) {
    const bareHits = wordBoundedIndices(flat, bareNeedle);
    if (bareHits.length > 0) {
      return {
        error:
          `TCP2/not-exported: ${TS_REL} declares \`const ${CAP_NAME}\` WITHOUT \`export\`. A ` +
          `file-private cap cannot be asserted on by tradeProposeModel.test.ts and cannot be ` +
          `read by any other module, so the "this is a MIRROR of trading.rs:37, not a second ` +
          `SSOT" claim is unverifiable from outside this file. Add \`export\`.`,
      };
    }
    const inTextOnly = compactWs(tsSrc).indexOf(bareNeedle) !== -1;
    return {
      error:
        `TCP2/absent: ${TS_REL} exports no \`const ${CAP_NAME} = <n>;\`. ` +
        (inTextOnly
          ? `The declaration text DOES appear in the raw file but only inside a COMMENT or a ` +
            `STRING literal (both are blanked before matching, on purpose) — a commented-out or ` +
            `quoted declaration gates nothing.`
          : `The cap is either inlined as a bare magic number in the clause or missing entirely. ` +
            `EARS-3 requires a named, exported mirror so the parity of the two numbers is ` +
            `mechanically checkable (plan anti-pattern 7).`),
    };
  }
  if (exportHits.length > 1) {
    return {
      error:
        `TCP2/ambiguous: ${TS_REL} declares \`export const ${CAP_NAME}\` ${exportHits.length} ` +
        `times — which one the clause reads is not decidable by text.`,
    };
  }

  let p = exportHits[0] + exportNeedle.length;
  if (flat[p] === ':') {
    const eq = flat.indexOf('=', p);
    if (eq === -1) {
      return {
        error:
          `TCP2/no-initializer: \`export const ${CAP_NAME}\` in ${TS_REL} has a type annotation ` +
          `but no \`=\` initializer — got "${excerpt(flat, p)}".`,
      };
    }
    p = eq;
  }
  if (flat[p] !== '=') {
    return {
      error:
        `TCP2/no-initializer: \`export const ${CAP_NAME}\` in ${TS_REL} is not followed by an ` +
        `\`=\` initializer — got "${excerpt(flat, p)}".`,
    };
  }
  p++;
  const end = endOfDigits(flat, p);
  if (end === p) {
    return {
      error:
        `TCP2/non-numeric: \`export const ${CAP_NAME} =\` in ${TS_REL} is not initialized with a ` +
        `decimal literal — got "${excerpt(flat, p)}". The mirror must be a plain number so it can ` +
        `be compared to the server literal.`,
    };
  }
  if (flat[end] !== ';') {
    return {
      error:
        `TCP2/unterminated: \`export const ${CAP_NAME} = ${flat.slice(p, end)}\` in ${TS_REL} ` +
        `does not end at the literal — got "${excerpt(flat, p)}".`,
    };
  }
  return { value: Number(flat.slice(p, end)) };
}

// ---------------------------------------------------------------------------
// TCP4 — the clause actually READS the constant (plan finding R2).
// ---------------------------------------------------------------------------

/**
 * Extract a top-level function body from BLANKED JS/TS text.
 * The body `{` is the first `{` after the parameter list closes at paren depth 0
 * (so a return-type annotation cannot be mistaken for the body).
 * @param {string} blanked Literal/comment-blanked source.
 * @param {string} fnName Bare function name.
 * @returns {string|null} Body text between the outer braces, or null.
 */
export function extractTsFnBody(blanked, fnName) {
  const marker = `function ${fnName}(`;
  const at = blanked.indexOf(marker);
  if (at === -1) return null;

  let i = at + marker.length - 1; // sits on the opening paren
  let paren = 0;
  for (; i < blanked.length; i++) {
    if (blanked[i] === '(') paren++;
    else if (blanked[i] === ')') {
      paren--;
      if (paren === 0) {
        i++;
        break;
      }
    }
  }
  while (i < blanked.length && blanked[i] !== '{') i++;
  if (i >= blanked.length) return null;

  const start = i + 1;
  let depth = 1;
  i++;
  while (i < blanked.length && depth > 0) {
    if (blanked[i] === '{') depth++;
    else if (blanked[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return blanked.slice(start, i - 1);
}

/**
 * TCP4 — `buildProposeSubmission`'s own body must contain the contiguous
 * compacted needle `selectedMonsterIds.length<=MAX_TRADE_MONSTERS_PER_SIDE`.
 * @param {string} tsSrc Raw tradeProposeModel.ts text.
 * @returns {string|null} Failure detail, or null on pass.
 */
export function checkClauseReadsTheConstant(tsSrc) {
  const { blanked } = blankJsLiterals(tsSrc);

  const defs = countOccurrences(blanked, `function ${TS_FN_NAME}(`);
  if (defs !== 1) {
    return (
      `TCP4/extraction: found ${defs} definitions of \`function ${TS_FN_NAME}(\` in ${TS_REL} ` +
      `(expected exactly 1). 0 means the submission builder was renamed — the clause below can ` +
      `no longer be located, so this gate would silently stop gating; >1 means the body scanned ` +
      `is not decidably the one the view calls.`
    );
  }

  const body = extractTsFnBody(blanked, TS_FN_NAME);
  if (body === null) {
    return (
      `TCP4/extraction: could not brace-walk the body of \`${TS_FN_NAME}\` in ${TS_REL} — the ` +
      `braces are unbalanced in the blanked text, which usually means the JS literal blanker ` +
      `desynced. Refusing to report a clause verdict from a body it cannot see.`
    );
  }

  const compact = compactWs(body);
  if (compact.indexOf(CLAUSE_NEEDLE) !== -1) return null;

  // Attribute the failure as precisely as possible.
  const hasName = compact.indexOf(CAP_NAME) !== -1;
  const hasLengthCmp = compact.indexOf('selectedMonsterIds.length<=') !== -1;
  let diagnosis;
  if (hasLengthCmp && !hasName) {
    diagnosis =
      `the body compares \`selectedMonsterIds.length <=\` against something that is NOT ` +
      `${CAP_NAME} — almost certainly an inlined magic number. THIS IS THE EXACT DRIFT THIS LEG ` +
      `EXISTS FOR: a bare literal beside a correct-but-disconnected exported const passes every ` +
      `other leg of this gate AND the vitest boundary table, and then survives untouched the day ` +
      `trading.rs's cap moves.`;
  } else if (hasName && !hasLengthCmp) {
    diagnosis =
      `${CAP_NAME} is referenced in the body but not in a \`selectedMonsterIds.length <= ...\` ` +
      `comparison. A \`<\` (off-by-one — trading.rs:44 is \`n > MAX\`, so 64 is LEGAL and a \`<\` ` +
      `clause disables a valid 64-monster offer), a \`>\`-negation, or a reference that never ` +
      `reaches canSubmit all land here.`;
  } else if (hasName && hasLengthCmp) {
    diagnosis =
      `both fragments appear but NOT adjacently — the comparison and the constant are wired to ` +
      `different expressions. Presence is not adjacency (movement_tests.rs:306-314).`;
  } else {
    diagnosis =
      `neither the length comparison nor ${CAP_NAME} appears in the body at all — the cap is not ` +
      `enforced client-side. EARS-3: selecting more than the cap must DISABLE submission.`;
  }

  return (
    `TCP4/clause: \`${TS_FN_NAME}\`'s body in ${TS_REL} does not contain the contiguous clause ` +
    `\`${CLAUSE_NEEDLE}\` (whitespace-insensitive) — ${diagnosis}`
  );
}

// ---------------------------------------------------------------------------
// The composed check — one entry point so the teeth exercise the SAME code path
// the real scan uses.
// ---------------------------------------------------------------------------

/**
 * @param {string} rustSrc Raw trading.rs text.
 * @param {string} tsSrc Raw tradeProposeModel.ts text.
 * @returns {string[]} Failure details (empty === pass).
 */
export function runTradeCapChecks(rustSrc, tsSrc) {
  const failures = [];

  const rust = parseRustCap(rustSrc);
  if (rust.error) failures.push(rust.error);

  const ts = parseTsCap(tsSrc);
  if (ts.error) failures.push(ts.error);

  if (rust.error === undefined && ts.error === undefined && rust.value !== ts.value) {
    failures.push(
      `TCP3/mismatch: the client mirror has DRIFTED from the server SSOT. ` +
        `${RUST_REL} MAX_TRADE_MONSTERS_PER_SIDE = ${rust.value}; ` +
        `${TS_REL} MAX_TRADE_MONSTERS_PER_SIDE = ${ts.value}. ` +
        `trading.rs is the SSOT and the client is a MIRROR (ADR-0188): change the server value ` +
        `first, then re-point the client. A client cap ABOVE the server's lets the UI submit an ` +
        `offer the server rejects (a dead-end submit button); a client cap BELOW the server's ` +
        `disables offers the server would accept (silent feature loss).`,
    );
  }

  const clause = checkClauseReadsTheConstant(tsSrc);
  if (clause) failures.push(clause);

  return failures;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixtures. Synthetic strings only — the real files are opened
// READ-ONLY and are never mutated by this gate.
// ---------------------------------------------------------------------------

const GOOD_RUST = `
const MAX_TRADE_MONSTERS_PER_SIDE: usize = 64;
const MAX_TRADE_ITEMS_PER_SIDE: usize = 64;

fn check_trade_side_size(n_monsters: usize, n_items: usize) -> Result<(), String> {
    if n_monsters > MAX_TRADE_MONSTERS_PER_SIDE {
        return Err(format!(
            "too many monsters in one trade side: {n_monsters} (max {MAX_TRADE_MONSTERS_PER_SIDE})"
        ));
    }
    if n_items > MAX_TRADE_ITEMS_PER_SIDE {
        return Err("too many items".to_string());
    }
    Ok(())
}
`;

// Tooth (a): the server bumped its cap and the client did not follow.
const BUMPED_RUST_128 = GOOD_RUST.replace(
  'const MAX_TRADE_MONSTERS_PER_SIDE: usize = 64;',
  'const MAX_TRADE_MONSTERS_PER_SIDE: usize = 128;',
);

// Tooth (d), server half: the SSOT is gone. Must fail loud, never pass vacuously.
const RUST_CAP_ABSENT = `
fn check_trade_side_size(n_monsters: usize, n_items: usize) -> Result<(), String> {
    if n_monsters > 64 {
        return Err("too many monsters".to_string());
    }
    Ok(())
}
`;

// A comment that SPELLS the declaration must not satisfy TCP1 (comment blanking).
const RUST_CAP_ONLY_IN_COMMENT = `
// const MAX_TRADE_MONSTERS_PER_SIDE: usize = 64;  (moved to guards.rs)
fn check_trade_side_size(n_monsters: usize, _n_items: usize) -> Result<(), String> {
    if n_monsters > 64 {
        return Err("too many monsters".to_string());
    }
    Ok(())
}
`;

const TS_PREAMBLE = `import type { StoreMonsterPub } from '../net/store';

`;

const TS_TAIL = `
export function unrelatedHelper(n: number): boolean {
  return n > 0;
}
`;

/** Build a tradeProposeModel-shaped fixture from a declaration and a clause. */
function tsFixture(declLine, clauseLine) {
  return (
    TS_PREAMBLE +
    declLine +
    `
export function buildProposeSubmission(targets, draft) {
  const offerCurrency = parseCurrency(draft.offerCurrency);
  const targetValid =
    draft.targetIdentity !== '' && targets.some((t) => t.identity === draft.targetIdentity);
  const hasAsset = draft.selectedMonsterIds.length > 0 || offerCurrency > 0n;
  ` +
    clauseLine +
    `
  const canSubmit = targetValid && hasAsset && withinCap;
  const args = canSubmit ? { initiatorMonsterIds: [...draft.selectedMonsterIds] } : null;
  return { canSubmit, offerCurrency, args };
}
` +
    TS_TAIL
  );
}

const GOOD_TS = tsFixture(
  'export const MAX_TRADE_MONSTERS_PER_SIDE = 64;\n',
  'const withinCap = draft.selectedMonsterIds.length <= MAX_TRADE_MONSTERS_PER_SIDE;',
);

// Tooth (b): a bare literal in the clause and NO exported const anywhere.
const TS_BARE_LITERAL_NO_CONST = tsFixture(
  '',
  'const withinCap = draft.selectedMonsterIds.length <= 64;',
);

// Tooth (c) — THE R2 BITE. Exported const == 64 (so TCP1/TCP2/TCP3 are all
// happy) sitting beside a clause that reads a bare literal. Behaviour is
// correct today; the constant is decorative; a server bump to 128 would move the
// const and leave the real gate at 64 with nothing red.
const TS_CONST_BUT_LITERAL_CLAUSE = tsFixture(
  'export const MAX_TRADE_MONSTERS_PER_SIDE = 64;\n',
  'const withinCap = draft.selectedMonsterIds.length <= 64;',
);

// Tooth (d), client half: nothing at all.
const TS_CAP_ABSENT = tsFixture('', 'const withinCap = true;');

// File-private const: unassertable from the test file, so not a provable mirror.
const TS_PRIVATE_CONST = tsFixture(
  'const MAX_TRADE_MONSTERS_PER_SIDE = 64;\n',
  'const withinCap = draft.selectedMonsterIds.length <= MAX_TRADE_MONSTERS_PER_SIDE;',
);

// Commented-out declaration + bare literal clause: comments must be blanked.
const TS_COMMENTED_CONST = tsFixture(
  '// export const MAX_TRADE_MONSTERS_PER_SIDE = 64;\n',
  'const withinCap = draft.selectedMonsterIds.length <= 64;',
);

// Decoy declaration hidden inside a STRING literal: payloads must be blanked.
const TS_DECOY_IN_STRING = tsFixture(
  'const DOC = "export const MAX_TRADE_MONSTERS_PER_SIDE = 64;";\n',
  'const withinCap = draft.selectedMonsterIds.length <= 64;',
);

// Off-by-one: `<` disables a LEGAL 64-monster offer (trading.rs:44 is `n > MAX`).
const TS_OFF_BY_ONE_LT = tsFixture(
  'export const MAX_TRADE_MONSTERS_PER_SIDE = 64;\n',
  'const withinCap = draft.selectedMonsterIds.length < MAX_TRADE_MONSTERS_PER_SIDE;',
);

// The clause lives in a DIFFERENT function — region scoping must not accept it.
const TS_CLAUSE_OUTSIDE_FN =
  tsFixture('export const MAX_TRADE_MONSTERS_PER_SIDE = 64;\n', 'const withinCap = true;') +
  `
export function someOtherHelper(draft) {
  return draft.selectedMonsterIds.length <= MAX_TRADE_MONSTERS_PER_SIDE;
}
`;

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function tradeCapParityEval() {
  const name =
    'trade-cap-parity (14r-f EARS-3 / ADR-0188: the client MAX_TRADE_MONSTERS_PER_SIDE mirrors ' +
    'server-module/src/trading.rs:37, and buildProposeSubmission actually reads it)';

  // =========================================================================
  // PROOF-OF-TEETH — a broken checker must be caught before its verdict on the
  // real files is trusted (repo convention).
  // =========================================================================
  const teeth = [];

  const expectPass = (label, rustSrc, tsSrc) => {
    const f = runTradeCapChecks(rustSrc, tsSrc);
    if (f.length > 0) {
      teeth.push(`${label}: a CORRECT fixture was flagged — ${f.join(' || ')}`);
    }
  };
  const expectFail = (label, rustSrc, tsSrc, mustMention, kills) => {
    const f = runTradeCapChecks(rustSrc, tsSrc);
    if (f.length === 0) {
      teeth.push(`${label}: fixture was NOT flagged at all — kills: ${kills}`);
      return;
    }
    for (const frag of mustMention) {
      if (!f.some((x) => x.indexOf(frag) !== -1)) {
        teeth.push(
          `${label}: flagged, but no failure mentioned "${frag}" — the diagnosis is wrong or ` +
            `unreadable, so the gate cannot be acted on. Got: ${f.join(' || ')}`,
        );
      }
    }
  };

  // T0 — anti-vacuity: the sanctioned shape must PASS. Without this every tooth
  // below is satisfiable by an always-failing checker.
  expectPass('TEETH T0 (good/good)', GOOD_RUST, GOOD_TS);

  // T0b — the parsers read the numbers they claim to read.
  {
    const r = parseRustCap(GOOD_RUST);
    if (r.value !== 64) {
      teeth.push(`TEETH T0b: parseRustCap(GOOD_RUST) = ${JSON.stringify(r)} (expected value 64)`);
    }
    const r128 = parseRustCap(BUMPED_RUST_128);
    if (r128.value !== 128) {
      teeth.push(
        `TEETH T0b: parseRustCap(BUMPED_RUST_128) = ${JSON.stringify(r128)} (expected value 128) ` +
          `— a parser stuck on 64 would make the mismatch tooth vacuous`,
      );
    }
    const t = parseTsCap(GOOD_TS);
    if (t.value !== 64) {
      teeth.push(`TEETH T0b: parseTsCap(GOOD_TS) = ${JSON.stringify(t)} (expected value 64)`);
    }
  }

  // Tooth (a) — Rust 128 / TS 64: the mismatch must fire AND render both values.
  expectFail(
    'TEETH Ta (rust=128, ts=64)',
    BUMPED_RUST_128,
    GOOD_TS,
    ['TCP3/mismatch', '128', '64'],
    'a parity gate that compares nothing (or reports a mismatch without saying which side moved)',
  );

  // Tooth (b) — bare literal in the clause, no exported const anywhere.
  expectFail(
    'TEETH Tb (ts bare literal, no const)',
    GOOD_RUST,
    TS_BARE_LITERAL_NO_CONST,
    ['TCP2/absent'],
    'an ungated magic 64 in the client (plan anti-pattern 7) — nothing anchors it to trading.rs',
  );

  // Tooth (c) — THE R2 BITE: exported const == 64 next to a bare-literal clause.
  expectFail(
    'TEETH Tc (R2: exported const beside a bare-literal clause)',
    GOOD_RUST,
    TS_CONST_BUT_LITERAL_CLAUSE,
    ['TCP4/clause'],
    'the PoC-shaped false green: a decorative exported const satisfies TCP1-TCP3 and the vitest ' +
      'boundary table while the literal that actually gates submission is unanchored — a later ' +
      'server bump moves the const and nothing reds',
  );

  // Tooth (d) — either side missing must FAIL LOUD, never pass vacuously.
  expectFail(
    'TEETH Td1 (rust cap absent)',
    RUST_CAP_ABSENT,
    GOOD_TS,
    ['TCP1/absent'],
    'a gate that silently passes when its SSOT anchor disappears ("nothing to check" false green)',
  );
  expectFail(
    'TEETH Td2 (ts cap absent)',
    GOOD_RUST,
    TS_CAP_ABSENT,
    ['TCP2/absent', 'TCP4/clause'],
    'a client with no cap at all — EARS-3 unimplemented — reported as green',
  );
  expectFail(
    'TEETH Td3 (both sides absent)',
    RUST_CAP_ABSENT,
    TS_CAP_ABSENT,
    ['TCP1/absent', 'TCP2/absent'],
    'a gate whose two halves cancel out when both anchors vanish',
  );

  // Te — a file-private const is not a provable mirror.
  expectFail(
    'TEETH Te (ts const not exported)',
    GOOD_RUST,
    TS_PRIVATE_CONST,
    ['TCP2/not-exported'],
    'a cap nothing outside the module can assert on — tradeProposeModel.test.ts could not pin it',
  );

  // Tf — a commented-out declaration must not satisfy TCP2 (comment blanking).
  expectFail(
    'TEETH Tf (ts declaration only in a comment)',
    GOOD_RUST,
    TS_COMMENTED_CONST,
    ['TCP2/absent'],
    'a checker that does not blank JS comments before matching',
  );

  // Tg — a declaration hidden in a string literal must not satisfy TCP2.
  expectFail(
    'TEETH Tg (ts declaration only inside a string literal)',
    GOOD_RUST,
    TS_DECOY_IN_STRING,
    ['TCP2/absent'],
    'a checker that does not blank JS string payloads — the scanner-migration-audit T3b decoy shape',
  );

  // Th — the off-by-one. `< 64` disables a LEGAL 64-monster offer.
  expectFail(
    'TEETH Th (off-by-one `<` instead of `<=`)',
    GOOD_RUST,
    TS_OFF_BY_ONE_LT,
    ['TCP4/clause'],
    'plan anti-pattern 9: trading.rs:44 is `n > MAX`, so 64 is LEGAL — a `<` clause is a UX ' +
      'regression dressed as a fix, and the const/parity legs cannot see it',
  );

  // Ti — region scoping: the clause must be in buildProposeSubmission's OWN body.
  expectFail(
    'TEETH Ti (clause in a different function)',
    GOOD_RUST,
    TS_CLAUSE_OUTSIDE_FN,
    ['TCP4/clause'],
    'a whole-file needle search that accepts a correct-looking clause sitting in dead code while ' +
      'the real submission builder is uncapped',
  );

  // Tj — comment blanking on the RUST side too.
  expectFail(
    'TEETH Tj (rust declaration only in a comment)',
    RUST_CAP_ONLY_IN_COMMENT,
    GOOD_TS,
    ['TCP1/absent'],
    'a Rust scan that reads a commented-out SSOT as live',
  );

  if (teeth.length > 0) {
    return { name, pass: false, detail: `TEETH FAILED: ${teeth.join(' || ')}` };
  }

  // =========================================================================
  // REAL FILES — read-only.
  // =========================================================================
  let rustSrc;
  let tsSrc;
  try {
    rustSrc = readFileSync(path.resolve(RUST_REL), 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${RUST_REL}: ${e?.message ?? String(e)}` };
  }
  try {
    tsSrc = readFileSync(path.resolve(TS_REL), 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${TS_REL}: ${e?.message ?? String(e)}` };
  }

  const failures = runTradeCapChecks(rustSrc, tsSrc);
  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join(' || ') };
  }

  const cap = parseRustCap(rustSrc).value;
  return {
    name,
    pass: true,
    detail:
      `TCP1-TCP4 pass: ${RUST_REL} and ${TS_REL} both declare MAX_TRADE_MONSTERS_PER_SIDE = ` +
      `${cap} (server is the SSOT, client is the exported MIRROR), and ${TS_FN_NAME}'s own body ` +
      `contains the contiguous clause \`${CLAUSE_NEEDLE}\` so the constant is load-bearing rather ` +
      `than decorative. The cap is INCLUSIVE (trading.rs:44 is \`n > MAX\`): ${cap} is legal, ` +
      `${cap + 1} rejects. Teeth verified: rust/ts mismatch, bare-literal clause beside a live ` +
      `const (R2), either side absent, un-exported const, comment-only and string-only ` +
      `declarations on both sides, the \`<\` off-by-one, and a clause sited outside ` +
      `${TS_FN_NAME} are ALL flagged, while the sanctioned shape passes.`,
  };
}
