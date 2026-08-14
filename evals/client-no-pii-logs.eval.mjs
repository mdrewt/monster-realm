// G21 / AUTH-57 — no credential value may reach a log, error or telemetry sink.
//
// THE INVARIANT (ADR-0182 D11/D12, spec AUTH-57): the OIDC client path handles
// bearer tokens, refresh tokens, PKCE verifiers and claim codes. None of those
// values may be handed to `console.*`, to a host callback (`opts.on*`), to
// `telemetry.*` or to `reportError(` — not as an extra argument, not inside a
// template-literal interpolation, and not laundered through a one-hop local
// alias. A sign-in failure reaches the UI only as a CLASSIFIED reason (a static
// string literal or the output of `classifySignInReason(`), never as raw
// provider text, which routinely carries the token that was rejected.
//
// WHY AN EVAL AND NOT A UNIT TEST: `connection.ts` and `main.ts` cannot be
// imported under vitest (DOM + SDK side effects; both are coverage-excluded for
// exactly that reason, client/vite.config.ts). A source scan is the strongest
// mechanical form available, so it is written to bite rather than to look busy:
// every pure function below carries inline BAD fixtures it MUST flag and GOOD
// fixtures it MUST pass, and those fixtures run BEFORE the real files are read.
//
// CHECKER-IMPORT REUSE (ADR-0121 precedent): the quote-aware, escape-aware
// `stripComments` is imported from evals/dom-shell-coverage-exclusion.eval.mjs
// rather than re-implemented. The repo has already paid for one comment-stripper
// bug family (the regex strippers that misalign on an unpaired quote); a second
// hand-rolled stripper would re-open it. Comment stripping is load-bearing here:
// a leak written in a comment is not a leak, and a leak hidden from a raw-text
// scanner by a preceding comment IS one.
//
// SCAN-CALIBRATION (addendum C): this file never uses a dynamic RegExp
// (semgrep detect-non-literal-regexp is remote-only, so `just ci` cannot catch
// it), never writes a scheme literal, and re-derives string boundaries with a
// single stateful pass whose termination is asserted (`unterminated`), so a
// desynced mask fails LOUD instead of silently matching nothing.
//
// NAMED RESIDUALS (documented, not laundered):
//   R1 MULTI-HOP LAUNDERING. Taint propagation is exactly ONE hop: a local whose
//      initialiser names a banned identifier joins the banned set. `const a =
//      token; const b = a; console.warn(b);` is NOT caught. Fixpoint iteration
//      was rejected deliberately: it makes the gate's own behaviour depend on
//      declaration order and produces confusing false positives on long files.
//      One hop kills the shape a developer actually writes ("stash it in a
//      message variable first"); the rest is a code-review responsibility.
//   R2 OBJECT-PROPERTY LAUNDERING. `const bag = { t: token }; console.warn(bag);`
//      is NOT caught (the property write is not a `const NAME =` whose RHS names
//      a banned identifier... it is, actually, so THAT one IS caught; what is
//      not caught is `bag.t = token;` — an assignment to an existing object).
//   R3 REGEX-LITERAL AMBIGUITY. Neither `stripComments` nor the string mask is
//      regex-literal aware; a regex containing a quote or a slash-slash would
//      desync both. Verified absent from every scanned file at authoring time
//      (zero regex literals in main.ts / connection.ts), and `unterminated`
//      fails loud if the mask ever desyncs.
//   R4 INDIRECT SINKS. A sink reached through an alias (`const log =
//      console.warn; log(token);`) is not in the sink list.
//   R5 CLAIM-CODE TAINT. Taint is seeded from BANNED_ALWAYS only, never from the
//      file-scoped claim-code names, ON PURPOSE: connection.ts legitimately
//      writes `const codeUnconsumed = claimCode.hasUnconsumed(...)`, a boolean,
//      and seeding taint from `claimCode` would false-positive the moment that
//      boolean appeared in any log line. `const c = code; console.warn(c);` is
//      therefore not caught — a review item, not a gate item.
//   R6 FUNCTION-RETURN LAUNDERING. A helper that RETURNS a banned value and is
//      then logged — `function getMsg() { return credential.token }` … then
//      `opts.onError('x', getMsg())` — is NOT caught. This is one hop past the
//      accepted `const NAME = <banned>` taint class: the launder happens through
//      a return statement, not an initialiser, and following it would require
//      real intra-file dataflow (resolving call targets to their return
//      expressions). Documented, deliberately NOT closed — closing it needs the
//      dataflow analysis this deliberately-shallow scanner does not do.
import { existsSync, readFileSync } from 'node:fs';
// CHECKER-IMPORT REUSE: the quote-aware comment stripper is the one already
// exported by the DOM-shell eval; it is not re-implemented here.
import { stripComments } from './dom-shell-coverage-exclusion.eval.mjs';

// ---------------------------------------------------------------------------
// Sink vocabulary (plan section 3 G21 row + addendum C F9/F10/F11)
// ---------------------------------------------------------------------------
// 'prefix' sinks match a member-access root and then require a call: `console.`
// matches `console.warn(`, `console.error(` and any future method, while
// `console.log` used as a VALUE (no call) is classified as a non-call and is
// reported separately rather than silently dropped.
export const SINKS = [
  { needle: 'console.', kind: 'prefix', family: 'console' },
  { needle: 'telemetry.', kind: 'prefix', family: 'telemetry' },
  { needle: 'opts.onError(', kind: 'call', family: 'opts' },
  { needle: 'opts.onSend(', kind: 'call', family: 'opts' },
  { needle: 'opts.onSignInFailed(', kind: 'call', family: 'opts' },
  { needle: 'opts.onSessionExpired(', kind: 'call', family: 'opts' },
  { needle: 'opts.onAuthServiceUnreachable(', kind: 'call', family: 'opts' },
  { needle: 'opts.onClaimPending(', kind: 'call', family: 'opts' },
  { needle: 'opts.onClaimAwaitingAccount(', kind: 'call', family: 'opts' },
  { needle: 'opts.onClaimResult(', kind: 'call', family: 'opts' },
  { needle: 'reportError(', kind: 'call', family: 'reportError' },
];

// Credential-shaped identifiers that may never appear in ANY sink argument.
export const BANNED_ALWAYS = [
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'codeVerifier',
  'code_verifier',
  'jwt',
  'credential.token',
];

// The live claim secret (AUTH-60): banned in console/telemetry arguments of the
// two modules that hold one. Reaching claimView's DOM is SANCTIONED (the player
// must be able to read their own code), so the ban is scoped to the log
// families, not to the whole sink list.
export const BANNED_CLAIM_CODE = ['code', 'claimCode'];
export const CLAIM_CODE_SINK_FAMILIES = ['console', 'telemetry'];

// The classifier that AUTH-48 requires between provider text and the UI.
const CLASSIFIER_CALL = 'classifySignInReason(';
const SIGN_IN_FAILED_SINK = 'opts.onSignInFailed(';

// Files scanned, with their per-file expectations.
//   requireSink: the file provably carries logging sinks today, so finding ZERO
//     is proof the scanner broke (or that every sink was renamed) — fail loud.
//     Calibrated at authoring time against HEAD: connection.ts carries 5
//     `opts.onError(` calls, main.ts carries 33 console/reportError sinks.
//   requireSink:false files are PURE modules. Mandating a sink in them would be
//     a gate distorting production code (the eval would force a console call
//     into an importless decision module), so their anti-vacuity comes from the
//     scanner-integrity assertions instead: every sink token that appears in
//     the text is classified (call / non-call), and an unbalanced argument list
//     or an unterminated string literal fails loud.
export const SCAN_TARGETS = [
  { file: 'client/src/net/oidc.ts', requireSink: false, claimCodeBan: true },
  { file: 'client/src/net/credentialDecision.ts', requireSink: false, claimCodeBan: false },
  // claimCode.ts holds the raw 64-hex claim secret in memory immediately after
  // minting it — the module most likely to log the secret while debugging. It is
  // a pure module (requireSink:false, extractor-completeness + the global floor,
  // no per-file floor), and the claim-code identifiers are banned in its
  // console./telemetry sink args (findTokenLeaks keys the ban on base ===
  // 'claimCode.ts'). Exists only after T2 lands — same missing-file-RED as oidc.
  { file: 'client/src/net/claimCode.ts', requireSink: false, claimCodeBan: true },
  { file: 'client/src/net/connection.ts', requireSink: true, claimCodeBan: true },
  { file: 'client/src/main.ts', requireSink: true, claimCodeBan: false },
];

// Aggregate anti-vacuity floor. Derivation: connection.ts 5 + main.ts 33 = 38 at
// HEAD. The floor is set at 6 (not 38) so ordinary refactors do not red the
// gate, while "the scanner suddenly finds almost nothing" still does.
export const TOTAL_SINK_FLOOR = 6;

const IDENT_CHAR = /[A-Za-z0-9_$]/;

function isIdentChar(ch) {
  return ch !== '' && ch !== undefined && IDENT_CHAR.test(ch);
}

// ---------------------------------------------------------------------------
// stringMask — which characters are string-literal TEXT (inert) rather than code
// ---------------------------------------------------------------------------
// Returns { masked, unterminated }. `masked[i] === true` means index i is part
// of a string/template literal's own syntax or text. Template-literal
// INTERPOLATIONS are deliberately NOT masked: `${refreshToken}` is code that
// reaches the sink, and a mask that hid it would make the gate blind to the
// single most common leak shape (an interpolated token in a log message).
//
// `unterminated` is true when the scan ends inside a literal — the mask has
// desynced (an unpaired quote), and every downstream answer is untrustworthy.
// Callers MUST fail loud on it rather than treat "no leaks found" as green.
export function stringMask(src) {
  const n = src.length;
  const masked = new Array(n).fill(false);
  const stack = [];
  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    const top = stack.length > 0 ? stack[stack.length - 1] : null;

    // Code context: outside any literal, or inside a template interpolation.
    if (top === null || top.type === 'expr') {
      if (ch === "'") {
        masked[i] = true;
        stack.push({ type: 'sq', depth: 0 });
        i++;
        continue;
      }
      if (ch === '"') {
        masked[i] = true;
        stack.push({ type: 'dq', depth: 0 });
        i++;
        continue;
      }
      if (ch === '`') {
        masked[i] = true;
        stack.push({ type: 'tl', depth: 0 });
        i++;
        continue;
      }
      if (top !== null && ch === '{') {
        top.depth++;
        i++;
        continue;
      }
      if (top !== null && ch === '}') {
        if (top.depth === 0) {
          masked[i] = true;
          stack.pop();
          i++;
          continue;
        }
        top.depth--;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Inside a single/double-quoted literal.
    if (top.type === 'sq' || top.type === 'dq') {
      masked[i] = true;
      if (ch === '\\' && i + 1 < n) {
        masked[i + 1] = true;
        i += 2;
        continue;
      }
      if ((top.type === 'sq' && ch === "'") || (top.type === 'dq' && ch === '"')) {
        stack.pop();
      }
      i++;
      continue;
    }

    // Inside a template literal.
    masked[i] = true;
    if (ch === '\\' && i + 1 < n) {
      masked[i + 1] = true;
      i += 2;
      continue;
    }
    if (ch === '$' && next === '{') {
      masked[i + 1] = true;
      stack.push({ type: 'expr', depth: 0 });
      i += 2;
      continue;
    }
    if (ch === '`') {
      stack.pop();
    }
    i++;
  }
  return { masked, unterminated: stack.length > 0 };
}

// Replace every string-literal character with a space, preserving indices and
// line breaks. `console.warn('token refresh failed')` becomes argument text with
// NO identifier in it — which is why prose containing the word "token" is not a
// leak, while `${token}` (unmasked interpolation) still is.
export function stripStringLiterals(src) {
  const { masked } = stringMask(src);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    out += masked[i] ? (src[i] === '\n' ? '\n' : ' ') : src[i];
  }
  return out;
}

// True iff `name` occurs in `text` on identifier boundaries. Dotted entries such
// as `credential.token` are matched literally with boundaries on both ends.
// Kills a substring impl: `tokenBucketSize` must NOT match `token`.
export function containsIdentifier(text, name) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at === -1) return false;
    const before = at > 0 ? text[at - 1] : '';
    const after = at + name.length < text.length ? text[at + name.length] : '';
    if (!isIdentChar(before) && !isIdentChar(after)) return true;
    from = at + 1;
  }
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// ---------------------------------------------------------------------------
// findSinkCalls — balanced-paren argument extraction over comment-stripped source
// ---------------------------------------------------------------------------
// Returns { calls, nonCall, unbalanced, unterminated }.
//   calls[i] = { family, needle, index, line, argsRaw, argsCode }
//     argsRaw  — exact source text between the sink's parens (multi-line safe)
//     argsCode — same span with string-literal text blanked (identifiers only)
//   nonCall  — sink tokens that are not followed by a call (e.g. a bare
//              `console.log` reference); reported, never silently dropped.
//   unbalanced — a sink whose argument list has no matching close paren.
//
// Parens inside string literals do NOT move the depth counter, so
// `console.warn('unbalanced ( in a string', token)` is still extracted whole.
// A declaration site (`function reportError(text: string)`) is skipped: its
// "arguments" are parameters, and a parameter named `token` is not a leak.
export function findSinkCalls(strippedSrc) {
  const { masked, unterminated } = stringMask(strippedSrc);
  const calls = [];
  const nonCall = [];
  const unbalanced = [];
  const n = strippedSrc.length;

  for (let i = 0; i < n; i++) {
    if (masked[i]) continue;
    let sink = null;
    for (const s of SINKS) {
      if (strippedSrc.startsWith(s.needle, i)) {
        sink = s;
        break;
      }
    }
    if (sink === null) continue;
    // A member access (`foo.reportError(`) is still a call; a declaration is not.
    if (i >= 9 && strippedSrc.slice(i - 9, i) === 'function ') continue;

    let open = -1;
    if (sink.kind === 'call') {
      open = i + sink.needle.length - 1;
    } else {
      let j = i + sink.needle.length;
      while (j < n && (isIdentChar(strippedSrc[j]) || strippedSrc[j] === '.')) j++;
      while (
        j < n &&
        (strippedSrc[j] === ' ' || strippedSrc[j] === '\n' || strippedSrc[j] === '\t')
      )
        j++;
      if (j >= n || strippedSrc[j] !== '(') {
        nonCall.push({ family: sink.family, needle: sink.needle, line: lineOf(strippedSrc, i) });
        continue;
      }
      open = j;
    }

    let depth = 1;
    let close = -1;
    for (let k = open + 1; k < n; k++) {
      if (masked[k]) continue;
      if (strippedSrc[k] === '(') depth++;
      else if (strippedSrc[k] === ')') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close === -1) {
      unbalanced.push({ family: sink.family, needle: sink.needle, line: lineOf(strippedSrc, i) });
      continue;
    }

    const argsRaw = strippedSrc.slice(open + 1, close);
    let argsCode = '';
    for (let k = open + 1; k < close; k++) {
      argsCode += masked[k] ? (strippedSrc[k] === '\n' ? '\n' : ' ') : strippedSrc[k];
    }
    calls.push({
      family: sink.family,
      needle: sink.needle,
      index: i,
      line: lineOf(strippedSrc, i),
      argsRaw,
      argsCode,
    });
  }
  return { calls, nonCall, unbalanced, unterminated };
}

// Convenience wrapper used for the real-file anti-vacuity floors.
export function countSinkCalls(src) {
  const scan = findSinkCalls(stripComments(src));
  return {
    calls: scan.calls.length,
    nonCall: scan.nonCall.length,
    unbalanced: scan.unbalanced.length,
    unterminated: scan.unterminated,
  };
}

// ---------------------------------------------------------------------------
// collectTaintedNames — ONE-HOP taint (addendum C F9)
// ---------------------------------------------------------------------------
// Every `const NAME =` / `let NAME =` / `var NAME =` whose initialiser names a
// banned identifier contributes NAME to the banned set for that file. Exactly
// one hop: the initialiser is tested against the BASE banned set only, never
// against the accumulating set (residual R1). Destructuring patterns are skipped
// (`const { token } = credential` needs no taint rule — `token` is banned in its
// own right at the sink).
export function collectTaintedNames(codeText, banned) {
  const tainted = [];
  const keywords = ['const ', 'let ', 'var '];
  for (let i = 0; i < codeText.length; i++) {
    let kw = null;
    for (const k of keywords) {
      if (codeText.startsWith(k, i) && (i === 0 || !isIdentChar(codeText[i - 1]))) {
        kw = k;
        break;
      }
    }
    if (kw === null) continue;
    let j = i + kw.length;
    while (j < codeText.length && codeText[j] === ' ') j++;
    const nameStart = j;
    while (j < codeText.length && isIdentChar(codeText[j])) j++;
    const name = codeText.slice(nameStart, j);
    if (name.length === 0) continue;
    // Optional type annotation: skip to the `=` if the next non-space is ':'.
    let k = j;
    while (
      k < codeText.length &&
      codeText[k] !== '=' &&
      codeText[k] !== ';' &&
      codeText[k] !== '\n'
    )
      k++;
    if (k >= codeText.length || codeText[k] !== '=') continue;
    if (codeText[k + 1] === '=' || codeText[k + 1] === '>') continue;
    // Only a type annotation may sit between the name and the `=`. A paren in
    // that gap means this is not a plain initialiser (e.g. `for (const t of xs)
    // total = t.token;` would otherwise taint `t`).
    const gap = codeText.slice(j, k);
    if (gap.indexOf('(') !== -1 || gap.indexOf(')') !== -1) continue;

    // RHS runs to the first `;` at bracket depth 0 (or to end of input).
    let depth = 0;
    let end = codeText.length;
    for (let m = k + 1; m < codeText.length; m++) {
      const ch = codeText[m];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) {
          end = m;
          break;
        }
        depth--;
      } else if (ch === ';' && depth === 0) {
        end = m;
        break;
      }
    }
    const rhs = codeText.slice(k + 1, end);
    if (banned.some((b) => containsIdentifier(rhs, b))) tainted.push(name);
  }
  return tainted;
}

// ---------------------------------------------------------------------------
// findTokenLeaks — THE GATE (per file)
// ---------------------------------------------------------------------------
// `fileName` selects the claim-code ban (connection.ts / oidc.ts / claimCode.ts).
// Returns an array of findings; an empty array means clean. Scanner-integrity
// problems are returned as findings too, so a caller that only checks
// `length === 0` cannot mistake a broken scan for a clean file.
export function findTokenLeaks(fileName, src) {
  const findings = [];
  const stripped = stripComments(src);
  const scan = findSinkCalls(stripped);
  const base = fileName.split('/').pop() ?? fileName;
  const claimCodeBanned = base === 'connection.ts' || base === 'oidc.ts' || base === 'claimCode.ts';

  if (scan.unterminated) {
    findings.push({
      file: fileName,
      line: 0,
      sink: '(scanner)',
      reason: 'UNTERMINATED-STRING',
      excerpt:
        'the string mask ended inside a literal — an unpaired quote (or a regex ' +
        'literal, residual R3) desynced the scan; every "no leak" answer below is untrustworthy',
    });
  }
  for (const u of scan.unbalanced) {
    findings.push({
      file: fileName,
      line: u.line,
      sink: u.needle,
      reason: 'UNBALANCED-SINK-ARGS',
      excerpt: 'no matching close paren for this sink call — arguments were never scanned',
    });
  }

  const codeOnly = stripStringLiterals(stripped);
  const tainted = collectTaintedNames(codeOnly, BANNED_ALWAYS);
  const bannedHere = BANNED_ALWAYS.concat(tainted);

  for (const call of scan.calls) {
    const applicable = bannedHere.slice();
    if (claimCodeBanned && CLAIM_CODE_SINK_FAMILIES.includes(call.family)) {
      for (const c of BANNED_CLAIM_CODE) applicable.push(c);
    }
    for (const name of applicable) {
      if (containsIdentifier(call.argsCode, name)) {
        findings.push({
          file: fileName,
          line: call.line,
          sink: call.needle,
          reason: tainted.includes(name) ? `TAINTED-ALIAS:${name}` : `BANNED:${name}`,
          excerpt: call.argsRaw.replace(/\s+/g, ' ').slice(0, 90),
        });
        break;
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// findUnclassifiedReason — AUTH-48: only classified reasons reach the UI
// ---------------------------------------------------------------------------
// Every `opts.onSignInFailed(` argument must be a STATIC string literal (the
// trimmed argument starts with a single or double quote) or must route through
// `classifySignInReason(`. A raw provider error string, or a template literal
// with an interpolation, is flagged. A backtick literal is treated as
// non-static even without an interpolation — deliberately strict: the classifier
// is the only sanctioned path for anything dynamic-looking.
export function findUnclassifiedReason(src) {
  const findings = [];
  const stripped = stripComments(src);
  const scan = findSinkCalls(stripped);
  for (const call of scan.calls) {
    if (call.needle !== SIGN_IN_FAILED_SINK) continue;
    const trimmed = call.argsRaw.trim();
    const isStatic = trimmed.startsWith("'") || trimmed.startsWith('"');
    const isClassified = call.argsRaw.indexOf(CLASSIFIER_CALL) !== -1;
    if (!isStatic && !isClassified) {
      findings.push({
        line: call.line,
        sink: call.needle,
        reason: 'UNCLASSIFIED-REASON',
        excerpt: trimmed.replace(/\s+/g, ' ').slice(0, 90),
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// PROOF OF TEETH — fixtures run BEFORE any real file is read.
// Each entry names the wrong implementation it kills.
// ---------------------------------------------------------------------------
const LEAK_FIXTURES = [
  {
    id: 'B1-extra-arg',
    file: 'client/src/net/oidc.ts',
    src: "console.warn('renew failed', token);",
    expectLeak: true,
    kills: 'an impl that only looks at the FIRST sink argument',
  },
  {
    id: 'B2-template-interpolation',
    file: 'client/src/net/oidc.ts',
    src: 'opts.onError(' + "'auth', `renew ${refreshToken} failed`);",
    expectLeak: true,
    kills: 'an impl that masks whole template literals and never sees the interpolation',
  },
  {
    id: 'B3-multiline-call',
    file: 'client/src/net/connection.ts',
    src: ['opts.onSend(', "  'renew',", '  { accessToken },', ');'].join('\n'),
    expectLeak: true,
    kills: 'a line-oriented impl that cannot follow a call across newlines',
  },
  {
    id: 'B4-one-hop-taint',
    file: 'client/src/net/oidc.ts',
    src: ['const msg = token;', "console.warn('x', msg);"].join('\n'),
    expectLeak: true,
    kills:
      'an impl that only bans literal identifier names at the sink (stash-then-log laundering)',
  },
  {
    id: 'B5-telemetry-object',
    file: 'client/src/net/oidc.ts',
    src: "telemetry.track('sign-in', { jwt: idToken });",
    expectLeak: true,
    kills: 'an impl whose sink list omits telemetry, or that ignores object-literal arguments',
  },
  {
    id: 'B6-claim-code-connection',
    file: 'client/src/net/connection.ts',
    src: "console.info('claim', code);",
    expectLeak: true,
    kills:
      'an impl that bans only token-shaped names and lets the live claim secret hit the console',
  },
  {
    id: 'B7-credential-dot-token',
    file: 'client/src/net/connection.ts',
    src: 'opts.onClaimPending(credential.token);',
    expectLeak: true,
    kills: 'an impl whose sink list stops at onError/onSend and misses the M21b-2 claim callbacks',
  },
  {
    id: 'B8-report-error',
    file: 'client/src/main.ts',
    src: 'reportError(id_token);',
    expectLeak: true,
    kills: "an impl that does not scan main.ts's own reportError sink",
  },
  {
    // The leak sits AFTER a nested call: an impl that stops at the first `)`
    // never reaches it. (A leak INSIDE the nested call would be caught even by
    // the broken impl, which is why the fixture is shaped this way.)
    id: 'B9-nested-parens',
    file: 'client/src/net/oidc.ts',
    src: "console.error('x', String(fmt(a)), accessToken);",
    expectLeak: true,
    expectReasonPrefix: 'BANNED:',
    kills: 'an impl that stops at the FIRST close paren instead of the balanced one',
  },
  {
    id: 'B10-paren-inside-string',
    file: 'client/src/net/oidc.ts',
    src: "console.warn('unbalanced ( inside a string', token);",
    expectLeak: true,
    // The reason must be a real BANNED hit, not UNBALANCED-SINK-ARGS: an impl
    // that counts the paren inside the string would report the call as
    // unbalanced, which is still a finding — pinning the reason is what makes
    // this fixture bite that impl instead of accidentally accepting it.
    expectReasonPrefix: 'BANNED:',
    kills: 'an impl that counts parens inside string literals and so mis-bounds the argument span',
  },
  {
    id: 'G1-static-message',
    file: 'client/src/net/oidc.ts',
    src: "console.warn('renew failed');",
    expectLeak: false,
    kills: 'an impl that flags every sink call (false positive floor)',
  },
  {
    id: 'G2-classified',
    file: 'client/src/net/connection.ts',
    src: 'opts.onSignInFailed(classifySignInReason(err));',
    expectLeak: false,
    kills: 'an impl that bans the classifier call itself',
  },
  {
    id: 'G3-word-in-string',
    file: 'client/src/net/oidc.ts',
    src: "console.warn('token refresh failed');",
    expectLeak: false,
    kills: 'a raw-substring impl that flags prose containing the word token',
  },
  {
    id: 'G4-comment-only',
    file: 'client/src/net/oidc.ts',
    src: "// console.warn('leak', token);\nconsole.warn('ok');",
    expectLeak: false,
    kills: 'an impl that scans raw source without stripping comments',
  },
  {
    id: 'G5-identifier-boundary',
    file: 'client/src/net/oidc.ts',
    src: "console.warn('x', tokenBucketSize);",
    expectLeak: false,
    kills: 'a substring impl with no identifier-boundary check (tokenBucketSize is not token)',
  },
  {
    id: 'G6-head-shape-connection',
    file: 'client/src/net/connection.ts',
    src: "opts.onError('join', msg || 'join failed');",
    expectLeak: false,
    kills: 'an impl that would red connection.ts as it stands at HEAD (false-positive floor)',
  },
  {
    id: 'G7-claim-code-scoped-to-two-files',
    file: 'client/src/main.ts',
    src: "console.info('claim', code);",
    expectLeak: false,
    kills:
      "an impl that applies the claim-code ban globally (main.ts's `code` is a KeyboardEvent code)",
  },
  {
    id: 'G8-claim-code-non-log-sink',
    file: 'client/src/net/connection.ts',
    src: 'opts.onClaimPending(code);',
    expectLeak: false,
    kills: 'an impl that bans the claim code from the UI callback that MUST receive it (AUTH-54)',
  },
];

const REASON_FIXTURES = [
  {
    id: 'U1-raw-provider-text',
    src: 'opts.onSignInFailed(rawProviderErrorText);',
    expectFlag: true,
    kills: 'an impl that accepts any argument at all',
  },
  {
    id: 'U2-template-reason',
    src: 'opts.onSignInFailed(`${err}`);',
    expectFlag: true,
    kills: 'an impl that accepts a backtick literal as static',
  },
  {
    id: 'U3-static-literal',
    src: "opts.onSignInFailed('auth-service-unreachable');",
    expectFlag: false,
    kills: 'an impl that rejects the sanctioned static-string form',
  },
  {
    id: 'U4-classifier',
    src: 'opts.onSignInFailed(classifySignInReason(err));',
    expectFlag: false,
    kills: 'an impl that rejects the sanctioned classifier form',
  },
];

export default async function () {
  const name =
    'client-no-pii-logs (G21/AUTH-57: no credential value reaches a log or telemetry sink)';

  // -------------------------------------------------------------------------
  // PHASE 0 — teeth. Fixtures first: a scanner that cannot flag a known leak
  // must never be pointed at the real tree and reported green.
  // -------------------------------------------------------------------------
  for (const f of LEAK_FIXTURES) {
    let got;
    try {
      got = findTokenLeaks(f.file, f.src);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `TEETH ${f.id}: findTokenLeaks threw — ${err?.message ?? err}`,
      };
    }
    if (!Array.isArray(got)) {
      return { name, pass: false, detail: `TEETH ${f.id}: findTokenLeaks must return an array` };
    }
    if (f.expectLeak && got.length === 0) {
      return {
        name,
        pass: false,
        detail: `TEETH ${f.id}: findTokenLeaks failed to flag a known leak — kills ${f.kills}`,
      };
    }
    if (!f.expectLeak && got.length > 0) {
      return {
        name,
        pass: false,
        detail:
          `TEETH ${f.id}: findTokenLeaks false-positived on a clean fixture ` +
          `(${got.map((g) => g.reason).join(', ')}) — kills ${f.kills}`,
      };
    }
    if (f.expectReasonPrefix && !got.some((g) => g.reason.startsWith(f.expectReasonPrefix))) {
      return {
        name,
        pass: false,
        detail:
          `TEETH ${f.id}: expected a finding whose reason starts with ` +
          `'${f.expectReasonPrefix}' but got '${got.map((g) => g.reason).join(', ')}' — ` +
          `a scanner-integrity finding must not stand in for a real detection. Kills ${f.kills}`,
      };
    }
  }

  for (const f of REASON_FIXTURES) {
    let got;
    try {
      got = findUnclassifiedReason(f.src);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `TEETH ${f.id}: findUnclassifiedReason threw — ${err?.message ?? err}`,
      };
    }
    if (f.expectFlag && got.length === 0) {
      return {
        name,
        pass: false,
        detail: `TEETH ${f.id}: findUnclassifiedReason failed to flag it — kills ${f.kills}`,
      };
    }
    if (!f.expectFlag && got.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH ${f.id}: findUnclassifiedReason false-positived — kills ${f.kills}`,
      };
    }
  }

  // Scanner-integrity teeth: an unbalanced sink call and an unterminated string
  // must both be REPORTED, not silently swallowed as "no leaks".
  {
    const un = findTokenLeaks('client/src/net/oidc.ts', "console.warn('x', token");
    if (!un.some((f) => f.reason === 'UNBALANCED-SINK-ARGS')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH S1: an unbalanced sink call was not reported — a truncated/edited file would ' +
          'scan as clean (kills an impl that drops sinks it cannot parse)',
      };
    }
    const mask = stringMask("const a = 'oops;");
    if (!mask.unterminated) {
      return {
        name,
        pass: false,
        detail:
          'TEETH S2: stringMask did not report an unterminated literal — a desynced mask would ' +
          'silently mask the rest of the file and every sink after it',
      };
    }
    const ok = stringMask("const a = 'fine'; console.warn(`x ${y}`);");
    if (ok.unterminated) {
      return {
        name,
        pass: false,
        detail: 'TEETH S3: stringMask reported a false unterminated literal on well-formed source',
      };
    }
    const stripped = stripStringLiterals("console.warn('a(b', token);");
    if (stripped.indexOf('token') === -1 || stripped.indexOf('a(b') !== -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH S4: stripStringLiterals must blank literal TEXT while keeping identifiers ' +
          '(kills an impl that drops the whole argument list or keeps string contents)',
      };
    }
    const taint = collectTaintedNames('const msg = token;', BANNED_ALWAYS);
    if (!taint.includes('msg')) {
      return { name, pass: false, detail: 'TEETH S5: collectTaintedNames missed a one-hop alias' };
    }
    const noTaint = collectTaintedNames("const msg = 'hello';", BANNED_ALWAYS);
    if (noTaint.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH S6: collectTaintedNames tainted a clean local (${noTaint.join(', ')})`,
      };
    }
    if (containsIdentifier('tokenBucketSize', 'token')) {
      return { name, pass: false, detail: 'TEETH S7: containsIdentifier ignored word boundaries' };
    }
    if (!containsIdentifier('{ jwt: idToken }', 'idToken')) {
      return { name, pass: false, detail: 'TEETH S8: containsIdentifier missed a real identifier' };
    }
  }

  // -------------------------------------------------------------------------
  // PHASE 1 — the real tree. A missing file is a HARD failure: the whole point
  // of the gate is that these modules are scanned, and "the file is not there
  // yet" is exactly the state in which a leak would be introduced unobserved.
  // -------------------------------------------------------------------------
  const missing = SCAN_TARGETS.filter((t) => !existsSync(t.file)).map((t) => t.file);
  if (missing.length > 0) {
    return {
      name,
      pass: false,
      detail:
        `MISSING SCAN TARGET(S): ${missing.join(', ')} — G21 scans the whole M21b-2 auth path; ` +
        'until these modules exist the gate cannot observe the invariant it exists to enforce ' +
        '(expected RED at HEAD; goes green when T3/T7 land the modules leak-free)',
    };
  }

  let totalSinks = 0;
  const perFile = [];
  const allFindings = [];
  for (const target of SCAN_TARGETS) {
    let src;
    try {
      src = readFileSync(target.file, 'utf8');
    } catch (e) {
      return { name, pass: false, detail: `could not read ${target.file}: ${e.message}` };
    }
    const counts = countSinkCalls(src);
    if (counts.unterminated) {
      return {
        name,
        pass: false,
        detail:
          `SCANNER INTEGRITY: the string mask desynced on ${target.file} (unpaired quote or a ` +
          'regex literal, residual R3) — refusing to report a scan whose bounds are wrong',
      };
    }
    if (counts.unbalanced > 0) {
      return {
        name,
        pass: false,
        detail:
          `SCANNER INTEGRITY: ${counts.unbalanced} sink call(s) in ${target.file} have no ` +
          'matching close paren — their arguments were never scanned',
      };
    }
    if (target.requireSink && counts.calls === 0) {
      return {
        name,
        pass: false,
        detail:
          `ANTI-VACUITY: zero sink calls found in ${target.file}, which carried several at ` +
          'HEAD — either every sink was renamed (extend SINKS) or the scanner broke; a scan ' +
          'that finds nothing must never read as green',
      };
    }
    totalSinks += counts.calls;
    perFile.push(`${target.file.split('/').pop()}:${counts.calls}`);
    allFindings.push(...findTokenLeaks(target.file, src));
    for (const f of findUnclassifiedReason(src)) allFindings.push({ ...f, file: target.file });
  }

  if (totalSinks < TOTAL_SINK_FLOOR) {
    return {
      name,
      pass: false,
      detail:
        `ANTI-VACUITY: only ${totalSinks} sink call(s) found across all scanned files ` +
        `(floor ${TOTAL_SINK_FLOOR}) — the scanner is not seeing the code it is meant to police`,
    };
  }

  if (allFindings.length > 0) {
    const shown = allFindings
      .slice(0, 6)
      .map((f) => `${f.file}~${f.line} ${f.sink} ${f.reason}: ${f.excerpt}`)
      .join(' | ');
    return {
      name,
      pass: false,
      detail:
        `${allFindings.length} PII/credential sink violation(s) — ${shown}` +
        ' :: AUTH-57 — a credential value (or a one-hop alias of one) reaches a log/telemetry ' +
        'sink, or an unclassified sign-in reason reaches the UI. Log a static message, or route ' +
        'the reason through classifySignInReason(). Line numbers are comment-stripped offsets.',
    };
  }

  return {
    name,
    pass: true,
    detail:
      `${totalSinks} sink call(s) scanned clean (${perFile.join(', ')}); ` +
      `${LEAK_FIXTURES.length} leak fixtures + ${REASON_FIXTURES.length} reason fixtures + 8 ` +
      'scanner-integrity teeth all bite; one-hop alias taint active (residual R1: multi-hop)',
  };
}
