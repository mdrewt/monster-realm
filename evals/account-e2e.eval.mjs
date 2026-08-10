// G22 + G23 — the account/claim end-to-end gate.
//
// G22 (AUTH-39..60, ADR-0182): the guest-to-account claim is the one flow in
// this repo where a silent regression costs a player their save. Unit tests
// cover the reducer guards; the module's own source-scan evals cover its shape.
// Neither can observe the thing that actually breaks: a real JWT, minted by a
// real issuer, verified by a real SpacetimeDB host, provisioning a real account
// row, and a real re-key moving a real monster from one Identity to another.
// This eval stands that whole stack up on ephemeral ports and asserts it.
//
// G23 (D20): the disaster-recovery runbook must carry a Better Auth section that
// is RUNNABLE — a tagged backup, a restore drill that mints a JWT for a known
// subject and proves SpacetimeDB derives the SAME Identity from it, and the
// signing-key custody item FIRST (a backup that also contains the signing key
// is not a backup, it is a second copy of the credential).
//
// THREE PHASES, ONLY THE THIRD IS CONDITIONAL
//   PHASE 0 (always)  proof-of-teeth on every exported pure function
//   PHASE 1 (always)  G23 structural doc-scan — fail loud, never skipped
//   PHASE 2           live flow:  hasCli            -> RUN, fail loud on any step
//                                 !hasCli && CI     -> FAIL LOUD (install regressed)
//                                 !hasCli && !CI    -> note-skip, pass:true
// Phase 1 runs BEFORE the CLI probe on purpose: a note-skipped live phase must
// never take the doc gate down with it.
//
// WHY THE PURE/IMPERATIVE SPLIT IS SO AGGRESSIVE HERE: phase 2 does not run on
// a laptop without the toolchain, and a gate whose teeth only exist inside the
// part that skips is not a gate. Every assertion the live flow makes is
// expressed as a PURE function over data (checkMilestones over the driver's
// NDJSON, checkSqlTruth over parsed SQL rows), and each of those is proven in
// phase 0 against inline BAD fixtures. The rig moves bytes; the pure functions
// decide, and their decisions are falsifiable everywhere, always.
//
// SAFETY RULES OBSERVED IN THIS FILE (plan section 4.8):
//   - literal regexes only; matching prefers indexOf/split/includes. A dynamic
//     `new RegExp(...)` trips semgrep detect-non-literal-regexp, which is
//     remote-only, so `just ci` cannot catch it locally.
//   - no scheme literal anywhere, INCLUDING in comments (semgrep matches them in
//     comment text). Every URL is assembled from parts, mirroring the
//     `concat!()` idiom accounts.rs itself uses for the same reason.
//   - any credential-shaped fixture value uses the INTERNAL_SECRET_ prefix
//     allowlisted in .gitleaks.toml.
//   - .github/workflows/ci.yml is READ, never written (outside touches).
import { execFileSync, spawn } from 'node:child_process';
import { webcrypto as wc } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// CHECKER-IMPORT REUSE (ADR-0121): the YAML job-block extractor already exists
// and is already teeth-tested by the eval that owns it.
import { extractJobBlock } from './e2e-desync-teeth.eval.mjs';

// ---------------------------------------------------------------------------
// Contract constants — every one of these is a VALUE PIN against a committed
// source location, not a paraphrase.
// ---------------------------------------------------------------------------

// accounts.rs:61 — the shared reject reason for a malformed, never-existed OR
// already-consumed code. AUTH-35's no-oracle property IS this string being the
// same in both cases, which is exactly what N2/N3 assert.
export const ERR_INVALID_CODE = 'invalid or already-used code';
// accounts.rs:414 — guard 9 (AUTH-18). The guest's presence row is deleted by
// on_disconnect, which can lag the socket close, so the claim retries on this.
export const ERR_OTHER_TAB = 'close your other tab, then retry';
// accounts.rs:48 — the exact committed token. Written split, as the source
// writes it, so this file carries no contiguous scheme token either.
export const ISSUER_NEEDLE = 'concat!("https:/", "/auth.monster-realm.invalid/")';
// accounts.rs:50.
export const AUDIENCE_NEEDLE = 'pub(crate) const ALLOWED_AUDIENCE: &[&str] = &["monster-realm"];';

const DB_NAME = 'mr-acct-e2e';
// Deliberately NOT the committed 'monster-realm' audience: patching it to a
// distinct value makes patchAllowedAudience LOAD-BEARING. If the patcher ever
// silently no-ops, the minted tokens carry an audience the module rejects, no
// account is provisioned, and A-applied fails loud. N4 (the throw) and this
// coupling are the anti-vacuity spine of the whole live phase.
const E2E_CLIENT_ID = 'mr-acct-e2e-client';
// A DISTINCT audience for the E control token — minted with the correct issuer
// but this `aud`, which is never what ALLOWED_AUDIENCE is patched to, so
// audience_allowed rejects it (D18/CRITICAL-2 single-client gate).
const WRONG_AUDIENCE = 'mr-acct-e2e-wrong-aud';
const RUNBOOK_PATH = 'docs/observability-dr-runbook.md';
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
// ops/auth/docker-compose.yml binds this loopback port (plan section 5).
const BETTER_AUTH_PORT = '8443';
// Cargo.toml:6 [workspace] members, copied wholesale so every `path = "../x"`
// dependency still resolves inside the temp workspace with zero manifest surgery.
const WORKSPACE_MEMBERS = [
  'game-core',
  'client-wasm',
  'server-module',
  'sim-harness',
  'evals/release-overflow-teeth',
];
const WORKSPACE_ROOT_FILES = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'];
const MARKER_FILE = path.join(os.tmpdir(), 'mr-acct-e2e.pid');

const HEX = '0123456789abcdef';

// ===========================================================================
// PURE FUNCTIONS — every one is proven against BAD + GOOD fixtures in phase 0.
// ===========================================================================

// --- module patching (N4) --------------------------------------------------

// Split a loopback origin into the two literals the `concat!()` form needs, so
// the patched Rust source carries no contiguous scheme token either (the same
// reason accounts.rs:41-47 gives for writing the committed value that way).
function splitForConcat(url) {
  const slash = url.indexOf('/');
  if (slash === -1 || slash === url.length - 1) {
    throw new Error(`patch: issuer url has no separable prefix: ${url}`);
  }
  return [url.slice(0, slash + 1), url.slice(slash + 1)];
}

/**
 * Replace the committed fail-closed issuer with the stub's, PRESERVING the
 * `concat!()` form. THROWS when the expected token is absent — a silent no-op
 * patch would publish an unpatched module, in which no JWT is ever accepted,
 * and every "no account was provisioned" assertion in the negative controls
 * would be vacuously true. This throw is N4.
 */
export function patchAllowedIssuers(src, issuerUrl) {
  if (typeof src !== 'string' || src.indexOf(ISSUER_NEEDLE) === -1) {
    throw new Error(
      'patchAllowedIssuers: the committed ALLOWED_ISSUERS token is absent from the source — ' +
        'refusing to publish an unpatched module (a no-op patch makes every negative control ' +
        'vacuously true). Expected token: ' +
        ISSUER_NEEDLE,
    );
  }
  if (!issuerUrl.endsWith('/')) {
    throw new Error('patchAllowedIssuers: issuer must end with a slash (issuer_allowed is exact)');
  }
  const [head, tail] = splitForConcat(issuerUrl);
  return src.replace(ISSUER_NEEDLE, 'concat!("' + head + '", "' + tail + '")');
}

/**
 * Replace the committed audience with the e2e client id. Same throw contract:
 * a no-op here would leave the module accepting the committed audience, and the
 * patch would stop being load-bearing.
 */
export function patchAllowedAudience(src, clientId) {
  if (typeof src !== 'string' || src.indexOf(AUDIENCE_NEEDLE) === -1) {
    throw new Error(
      'patchAllowedAudience: the committed ALLOWED_AUDIENCE line is absent from the source — ' +
        'refusing to publish an unpatched module. Expected line: ' +
        AUDIENCE_NEEDLE,
    );
  }
  const replacement = AUDIENCE_NEEDLE.replace('"monster-realm"', '"' + clientId + '"');
  return src.replace(AUDIENCE_NEEDLE, replacement);
}

// --- live-phase predicates (bindings-drift B/B2/B3 pattern) ----------------

/**
 * `env` = { ci, hasCli }. Run the live flow whenever the toolchain is present,
 * in CI or locally — `ci` is deliberately NOT consulted here: a developer with
 * the toolchain installed gets the real gate, not a weaker local variant.
 * `hasCli` means BOTH the spacetime CLI and cargo are available.
 */
export function shouldRunLive(env) {
  return !!env.hasCli;
}

/**
 * `env` = { ci, hasCli }. In CI the toolchain is installed by an explicit
 * workflow step. Its absence is not a reason to skip — it is evidence that the
 * install step regressed, and a skip would hide the whole G22 flow for as long
 * as nobody noticed.
 */
export function shouldFailLoudNoCli(env) {
  return !!env.ci && !env.hasCli;
}

// --- claim-code shape (AUTH-60 / accounts.rs is_valid_claim_code) ----------

export function isValidClaimCode(code) {
  if (typeof code !== 'string' || code.length !== 64) return false;
  for (const ch of code) if (HEX.indexOf(ch) === -1) return false;
  return true;
}

// --- identity comparison over SQL cells ------------------------------------

function normHex(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/^0x/, '');
}

export function identityMatches(cell, hex) {
  const a = normHex(cell);
  const b = normHex(hex);
  return a !== '' && a === b;
}

/**
 * True when a cell holds something identity-shaped. Used to decide "this
 * Option<Identity> column is NULL" without depending on how the CLI renders
 * null (which has been `(none)`, `null` and empty across versions).
 */
export function looksLikeIdentity(cell) {
  const v = normHex(cell);
  if (v.length < 32) return false;
  for (const ch of v) if (HEX.indexOf(ch) === -1) return false;
  return true;
}

function looksLikeEpochMs(cell) {
  const v = String(cell == null ? '' : cell).trim();
  if (v.length < 10) return false;
  for (const ch of v) if ('0123456789'.indexOf(ch) === -1) return false;
  return true;
}

// --- SQL output parsing -----------------------------------------------------

/**
 * Parse the CLI's table output into { columns, rows }. Separator rules, blank
 * lines and a trailing "(N rows)" footer are dropped; everything else after the
 * header is a data row. Tolerates both pipe-separated and whitespace-separated
 * renderings. The CLI also prints an UNSTABLE banner on STDERR — callers pass
 * stdout only, so it never reaches here.
 *
 * RESIDUAL (accepted): the cell split is NOT quote-aware — a `|` or whitespace
 * INSIDE a quoted TEXT cell would be mis-split. This is only a false-RED risk,
 * never a false-GREEN one, and it cannot fire here: every column this eval
 * queries (identity, claimed_from, claimed_at_ms, owner_identity, code) is hex
 * or an integer epoch, never a quoted string with embedded separators. If a
 * future query selects a TEXT column (e.g. a player name), this must gain quote
 * awareness first.
 */
export function parseSqlOutput(stdout) {
  const kept = [];
  for (const raw of String(stdout == null ? '' : stdout).split('\n')) {
    const t = raw.trim();
    if (t === '') continue;
    if (/^[-+|\s]+$/.test(t)) continue;
    if (t.startsWith('(') && t.endsWith(')')) continue;
    kept.push(t);
  }
  if (kept.length === 0) return { columns: [], rows: [] };
  const split = (line) => {
    if (line.indexOf('|') === -1) return line.split(/\s+/).filter((c) => c !== '');
    const cells = line.split('|').map((c) => c.trim());
    while (cells.length > 0 && cells[0] === '') cells.shift();
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    return cells;
  };
  return { columns: split(kept[0]), rows: kept.slice(1).map(split) };
}

// --- driver milestone assertions -------------------------------------------

// The exact milestone sequence the driver must emit, in this order. Order is
// asserted, not just membership: N2 MUST precede A-complete because guard 4
// (AUTH-14, "one claim per account, ever") fires before guard 5/6 — replaying a
// code on an account that has already claimed returns "account already claimed"
// and would prove nothing about code consumption.
export const MILESTONES = [
  'A-connect',
  'A-applied',
  'B-connect',
  'B-join',
  'B-startClaim',
  'N2',
  'B-disconnect',
  'A-complete',
  'D-connect',
  'D-applied',
  'N3',
  'C-connect',
  'C-applied',
  'E-rejected',
  'done',
];

/**
 * Decide the whole live flow from the driver's NDJSON milestones.
 * `expected` = { issuer } — the stub issuer that must appear on A's account row.
 * Returns { ok, reason }.
 */
export function checkMilestones(events, expected) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: 'driver emitted no milestones at all' };
  }
  const seen = new Map();
  const order = [];
  for (const e of events) {
    if (e === null || typeof e !== 'object' || typeof e.step !== 'string') continue;
    if (!seen.has(e.step)) {
      seen.set(e.step, e);
      order.push(e.step);
    }
  }
  for (const step of MILESTONES) {
    const e = seen.get(step);
    if (e === undefined) return { ok: false, reason: `milestone '${step}' never arrived` };
    if (e.ok !== true) {
      const err = e.data && e.data.err ? ` — ${e.data.err}` : '';
      return { ok: false, reason: `milestone '${step}' reported failure${err}` };
    }
  }
  // Order: the observed index of each required milestone must be increasing.
  let prev = -1;
  for (const step of MILESTONES) {
    const at = order.indexOf(step);
    if (at < prev) {
      return {
        ok: false,
        reason: `milestone '${step}' arrived out of order (expected sequence: ${MILESTONES.join(' -> ')})`,
      };
    }
    prev = at;
  }

  // A milestone that arrived without its payload is a broken driver, not a
  // green run: dataOf never invents a value, it yields {} so every field check
  // below reports a concrete mismatch instead of throwing.
  const dataOf = (step) => {
    const e = seen.get(step);
    return e && e.data && typeof e.data === 'object' ? e.data : {};
  };
  // E has no identity milestone: an allowed-issuer + wrong-audience token is
  // refused at connect (AUTH-3 → client_connected Err → the host DISCONNECTS),
  // so `.onConnect` never fires and E never gets an Identity. E is asserted via
  // the E-rejected milestone below, not here.
  const aId = dataOf('A-connect').identity;
  const bId = dataOf('B-connect').identity;
  const cId = dataOf('C-connect').identity;
  const dId = dataOf('D-connect').identity;
  for (const [label, id] of [
    ['A', aId],
    ['B', bId],
    ['C', cId],
    ['D', dId],
  ]) {
    if (typeof id !== 'string' || normHex(id).length < 32) {
      return { ok: false, reason: `${label}-connect did not report an identity (${String(id)})` };
    }
  }
  if (identityMatches(aId, bId)) {
    return {
      ok: false,
      reason:
        'B connected as the SAME identity as A — the anonymous leg reused the account ' +
        'credential, so nothing about the claim was actually exercised',
    };
  }
  if (identityMatches(cId, aId) || identityMatches(cId, bId)) {
    return { ok: false, reason: 'C (wrong-issuer) reused an existing identity' };
  }
  if (identityMatches(dId, aId) || identityMatches(dId, bId) || identityMatches(dId, cId)) {
    return { ok: false, reason: 'D (second account) reused an existing identity' };
  }

  const aApplied = dataOf('A-applied');
  if (aApplied.rows !== 1) {
    return {
      ok: false,
      reason:
        `A's my_account holds ${aApplied.rows} row(s), expected exactly 1 — the JWT was ` +
        'accepted but no account was provisioned (or it was provisioned twice)',
    };
  }
  if (aApplied.issuer !== expected.issuer) {
    return {
      ok: false,
      reason: `A's account records issuer '${aApplied.issuer}', expected '${expected.issuer}'`,
    };
  }

  const dApplied = dataOf('D-applied');
  if (dApplied.rows !== 1) {
    return {
      ok: false,
      reason:
        `D's my_account holds ${dApplied.rows} row(s), expected exactly 1 — without an ` +
        'account row D cannot exercise the replay path and N3 would prove nothing',
    };
  }

  const cApplied = dataOf('C-applied');
  if (cApplied.rows !== 0) {
    return {
      ok: false,
      reason:
        `C connected with a JWT from the SECOND issuer and got ${cApplied.rows} ` +
        'my_account row(s) — the issuer allowlist is inert, which makes every positive result ' +
        'in this run meaningless (this is the N1 control)',
    };
  }

  const eApplied = dataOf('E-applied');
  if (eApplied.rows !== 0) {
    return {
      ok: false,
      reason:
        `E connected with a CORRECT-issuer JWT but a WRONG audience and got ${eApplied.rows} ` +
        'my_account row(s) — audience_allowed accepted a token minted for another application. ' +
        'This is the D18/CRITICAL-2 single-client control: if the audience check is inert (or ' +
        'later widened to a list), any issuer-valid token provisions here regardless of who it ' +
        'was minted for',
    };
  }

  const code = dataOf('B-startClaim').code;
  if (!isValidClaimCode(code)) {
    return { ok: false, reason: `claim code is not 64 lowercase hex (AUTH-60): '${code}'` };
  }

  const n2 = dataOf('N2').err;
  const n3 = dataOf('N3').err;
  if (typeof n2 !== 'string' || n2.indexOf(ERR_INVALID_CODE) === -1) {
    return {
      ok: false,
      reason: `N2 (well-formed, never-existed code) returned '${n2}', expected '${ERR_INVALID_CODE}'`,
    };
  }
  if (typeof n3 !== 'string' || n3.indexOf(ERR_INVALID_CODE) === -1) {
    return {
      ok: false,
      reason: `N3 (replay of the consumed code) returned '${n3}', expected '${ERR_INVALID_CODE}'`,
    };
  }
  if (n2 !== n3) {
    return {
      ok: false,
      reason:
        `N2 and N3 returned DIFFERENT strings ('${n2}' vs '${n3}') — a caller can now ` +
        'distinguish "never existed" from "already used", which is a claim-code oracle (AUTH-35)',
    };
  }
  return { ok: true, reason: `all ${MILESTONES.length} milestones asserted` };
}

// --- server-truth assertions over parsed SQL rows --------------------------

/**
 * `tables` = { account, guestClaim, monster } — each an array of cell arrays.
 *   account columns: identity, claimed_from, claimed_at_ms
 *   guest_claim: any columns (only the count matters)
 *   monster columns: owner_identity
 * `ids` = { a, b, c, d, e } hex identities.
 * Returns { ok, reason }.
 */
export function checkSqlTruth(tables, ids) {
  const account = tables.account || [];
  const guestClaim = tables.guestClaim || [];
  const monster = tables.monster || [];

  if (account.length !== 2) {
    return {
      ok: false,
      reason:
        `account holds ${account.length} row(s), expected exactly 2 (A + D). C (unrecognized ` +
        'issuer) and E (wrong audience) both connected and must NEVER have provisioned one',
    };
  }
  if (account.some((r) => identityMatches(r[0], ids.c))) {
    return {
      ok: false,
      reason: 'an account row exists for C, whose JWT came from an issuer outside ALLOWED_ISSUERS',
    };
  }
  if (ids.e && account.some((r) => identityMatches(r[0], ids.e))) {
    return {
      ok: false,
      reason:
        'an account row exists for E, whose JWT carried an audience outside ALLOWED_AUDIENCE ' +
        '(D18/CRITICAL-2: the single-client audience gate did not hold)',
    };
  }
  const aRow = account.find((r) => identityMatches(r[0], ids.a));
  const dRow = account.find((r) => identityMatches(r[0], ids.d));
  if (!aRow) return { ok: false, reason: "no account row for A (the claim's destination)" };
  if (!dRow) return { ok: false, reason: 'no account row for D (the second account holder)' };
  if (!identityMatches(aRow[1], ids.b)) {
    return {
      ok: false,
      reason:
        `A's claimed_from is '${aRow[1]}', expected B's identity '${ids.b}' — provenance ` +
        'was not stamped from the guest session that was claimed (AUTH-21)',
    };
  }
  if (!looksLikeEpochMs(aRow[2])) {
    return { ok: false, reason: `A's claimed_at_ms is not a timestamp: '${aRow[2]}'` };
  }
  if (looksLikeIdentity(dRow[1])) {
    return {
      ok: false,
      reason: `D's claimed_from is populated ('${dRow[1]}') — D never claimed anything`,
    };
  }
  if (guestClaim.length !== 0) {
    return {
      ok: false,
      reason:
        `guest_claim still holds ${guestClaim.length} row(s) after a successful claim — ` +
        'the code was not consumed, so it can be replayed (AUTH-34 single-use)',
    };
  }
  if (monster.length === 0) {
    return {
      ok: false,
      reason:
        'zero monster rows — the guest never received a starter, so the re-key assertion ' +
        'below would be vacuous',
    };
  }
  if (monster.some((r) => identityMatches(r[0], ids.b))) {
    return {
      ok: false,
      reason:
        "a monster row is still owned by B — rekey_all did not move the guest's game data " +
        'onto the account identity (AUTH-21/22)',
    };
  }
  if (!monster.some((r) => identityMatches(r[0], ids.a))) {
    return {
      ok: false,
      reason: 'no monster row is owned by A — the re-key lost the data entirely',
    };
  }
  return { ok: true, reason: 'account/guest_claim/monster server truth matches the claimed flow' };
}

// --- host-side acceptance of the second issuer (N1 disambiguation) ----------

/**
 * `reqLog` = the issuer stub's ordered list of request paths (already
 * slash-collapsed). The N1 control is only meaningful if the HOST actually
 * fetched and evaluated the second issuer's key material: "C got no account"
 * proves the module allowlist did the work ONLY if the host reached
 * verification and then rejected on the issuer — not if the token was dropped
 * before the host ever looked. This asserts the host fetched BOTH the primary
 * discovery (A/D/E were verified at all) AND the second issuer's discovery +
 * jwks (C reached verification). Returns { ok, reason }.
 */
export function checkHostSideAcceptance(reqLog) {
  const log = Array.isArray(reqLog) ? reqLog : [];
  const sawPrimaryDiscovery = log.some(
    (u) => u.indexOf('other') === -1 && u.indexOf('openid-configuration') !== -1,
  );
  const sawOtherDiscovery = log.some(
    (u) => u.indexOf('other') !== -1 && u.indexOf('openid-configuration') !== -1,
  );
  const sawOtherJwks = log.some((u) => u.indexOf('other') !== -1 && u.indexOf('jwks') !== -1);
  if (!sawPrimaryDiscovery) {
    return {
      ok: false,
      reason:
        'the host never fetched the primary discovery document — A/D/E were not verified against ' +
        `the stub at all (request log: ${JSON.stringify(log)})`,
    };
  }
  if (!sawOtherDiscovery || !sawOtherJwks) {
    return {
      ok: false,
      reason:
        "the host never fetched the SECOND issuer's discovery+jwks, so C's token was rejected " +
        'before verification. C proving "no account" is then meaningless: it would hold even if ' +
        'the module allowlist were inert. Request log: ' +
        JSON.stringify(log),
    };
  }
  return { ok: true, reason: "host fetched both issuers' discovery + the second issuer's jwks" };
}

// --- ci.yml step ordering (read-only) --------------------------------------

/**
 * The ci job must install the SpacetimeDB CLI BEFORE `just eval` runs, or this
 * eval's live phase silently degrades to the note-skip path in CI. Reading the
 * workflow is allowed; editing it is outside this slice's touches.
 */
export function ciInstallsCliBeforeEval(yaml) {
  const block = extractJobBlock(yaml, 'ci');
  if (block === '') return { ok: false, reason: 'no `ci:` job in the workflow' };
  const lines = block.split('\n');
  let installIdx = -1;
  let evalIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (installIdx === -1 && t.startsWith('- name: Install SpacetimeDB CLI')) installIdx = i;
    if (evalIdx === -1 && t === '- run: just eval') evalIdx = i;
  }
  if (installIdx === -1) {
    return {
      ok: false,
      reason:
        'the ci job has no `Install SpacetimeDB CLI` step — account-e2e and bindings-drift ' +
        'would both silently skip in CI',
    };
  }
  if (evalIdx === -1) {
    return { ok: false, reason: 'the ci job has no bare `- run: just eval` step' };
  }
  if (installIdx > evalIdx) {
    return {
      ok: false,
      reason:
        `the CLI install step (line ${installIdx + 1} of the ci job) runs AFTER ` +
        `\`just eval\` (line ${evalIdx + 1}) — the live phase would never see a CLI`,
    };
  }
  return {
    ok: true,
    reason: `CLI install at ci-job line ${installIdx + 1}, eval at ${evalIdx + 1}`,
  };
}

// --- G23: the DR runbook's Better Auth section -----------------------------

/**
 * Return the ONE section whose heading starts with `levelPrefix` and contains
 * `headingContains`, up to the next heading at the same level.
 *
 * THROWS when the heading is absent or appears more than once. There is
 * deliberately NO whole-document fallback: a checker that silently widens its
 * search to the whole file passes as soon as the required words appear ANYWHERE,
 * which is exactly the false-green shape this gate exists to prevent.
 */
export function extractSection(text, headingContains, levelPrefix) {
  const lines = String(text == null ? '' : text).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(levelPrefix) && lines[i].indexOf(headingContains) !== -1) hits.push(i);
  }
  if (hits.length === 0) {
    throw new Error(
      `no '${levelPrefix}' heading containing '${headingContains}' — the section does not exist`,
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `${hits.length} '${levelPrefix}' headings contain '${headingContains}' (lines ` +
        `${hits.map((h) => h + 1).join(', ')}) — ambiguous; a section scan must not guess`,
    );
  }
  const start = hits[0];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith(levelPrefix)) {
      end = i;
      break;
    }
  }
  return { heading: lines[start], body: lines.slice(start, end).join('\n'), startLine: start + 1 };
}

/**
 * Fenced blocks as arrays of LIVE lines (shell-comment lines dropped), mirroring
 * checkRunbookHasRunnableSteps' discipline: a commented-out step still contains
 * the substring, so a disabled step must not count as a procedure.
 */
export function fencedBlocksIn(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text == null ? '' : text).split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (cur === null) cur = [];
      else {
        blocks.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur !== null && !line.trimStart().startsWith('#')) cur.push(line);
  }
  return blocks;
}

function hasMintMarker(line) {
  const l = line.toLowerCase();
  return (
    l.indexOf('jwt') !== -1 ||
    l.indexOf('/token') !== -1 ||
    l.indexOf('id_token') !== -1 ||
    l.indexOf('access_token') !== -1
  );
}

// Deliberately tolerant about HOW the subject is expressed (JSON claim, flag,
// env var) and intolerant about it being absent: the drill has to mint for a
// KNOWN subject, or it cannot prove the derived Identity is the same one.
function hasSubClaim(line) {
  return (
    line.indexOf('"sub"') !== -1 ||
    line.indexOf("'sub'") !== -1 ||
    line.indexOf('sub=') !== -1 ||
    line.indexOf('sub:') !== -1 ||
    line.indexOf('--sub') !== -1 ||
    line.indexOf('sub ') !== -1 ||
    line.indexOf('subject') !== -1
  );
}

function isCustodyLine(line) {
  const l = line.toLowerCase();
  const namesKey =
    l.indexOf('signing key') !== -1 || l.indexOf('signing-key') !== -1 || l.indexOf('jwks') !== -1;
  const namesCustody =
    l.indexOf('custody') !== -1 ||
    l.indexOf('rotat') !== -1 ||
    l.indexOf('exclude') !== -1 ||
    l.indexOf('secret store') !== -1;
  return namesKey && namesCustody;
}

/**
 * G23. All five clauses are evaluated against the EXTRACTED SECTION ONLY (the
 * one exception is clause 5, which may also be satisfied by the pre-existing
 * port-audit line in the network-posture section, since that line is where an
 * operator actually looks). Returns { ok, reason }.
 */
export function checkDrRunbookBetterAuthSection(text, port) {
  let sec;
  try {
    sec = extractSection(text, 'Better Auth', '## ');
  } catch (err) {
    return { ok: false, reason: `FAIL-LOUD: ${err.message}` };
  }
  const body = sec.body;
  const blocks = fencedBlocksIn(body);
  const live = [];
  for (const b of blocks) for (const l of b) live.push(l);

  // (1) a fenced, runnable restic command carrying the better-auth tag.
  const tagged = blocks.some(
    (b) =>
      b.some((l) => l.trimStart().startsWith('restic ')) &&
      b.join('\n').indexOf('--tag better-auth') !== -1,
  );
  if (!tagged) {
    return {
      ok: false,
      reason:
        'clause 1: no fenced `restic` command carrying `--tag better-auth` INSIDE the ' +
        'Better Auth section (a better-auth tag elsewhere in the document does not back up ' +
        'this database, and an untagged sweep cannot be restored selectively)',
    };
  }

  // (2) a runnable command that mints a JWT for a known subject.
  if (!live.some(hasMintMarker) || !live.some(hasSubClaim)) {
    return {
      ok: false,
      reason:
        'clause 2: the section has no runnable command that mints a token for a known ' +
        '`sub` from the restored instance — a restore drill that only proves the file came back ' +
        'has not proven the players can sign in',
    };
  }

  // (3) the identity-equality claim is stated where the drill is.
  for (const needle of ['BLAKE3', 'Identity', 'from_claims']) {
    if (body.indexOf(needle) === -1) {
      return {
        ok: false,
        reason:
          `clause 3: the Better Auth section never names '${needle}' — the drill must state ` +
          'that the restored issuer derives the SAME Identity (BLAKE3 over the issuer+subject, ' +
          'via from_claims), not merely that the service starts',
      };
    }
  }

  // (4) signing-key custody FIRST (D20).
  const bodyLines = body.split('\n');
  let custodyAt = -1;
  let resticAt = -1;
  let cursor = 0;
  for (const line of bodyLines) {
    if (custodyAt === -1 && isCustodyLine(line)) custodyAt = cursor;
    if (resticAt === -1 && line.trimStart().startsWith('restic ')) resticAt = cursor;
    cursor += line.length + 1;
  }
  if (custodyAt === -1) {
    return {
      ok: false,
      reason:
        'clause 4: no signing-key custody line item in the section (D20 makes it the FIRST ' +
        'item: a backup set that also contains the JWKS private key is a second copy of the ' +
        'credential, not a backup)',
    };
  }
  if (resticAt !== -1 && custodyAt > resticAt) {
    return {
      ok: false,
      reason:
        'clause 4: the signing-key custody item appears AFTER the first restic command — ' +
        'an operator following the section top-to-bottom backs the key up before reading that ' +
        'they must not',
    };
  }

  // (5) the loopback port is auditable.
  const portInSection = body.indexOf(port) !== -1;
  const portInAudit = text
    .split('\n')
    .some((l) => l.indexOf('ss -tlnp') !== -1 && l.indexOf(port) !== -1);
  if (!portInSection && !portInAudit) {
    return {
      ok: false,
      reason:
        `clause 5: port ${port} appears neither in the Better Auth section nor in the ` +
        '`ss -tlnp` port-audit line — a loopback-bound service nobody audits drifts silently',
    };
  }

  return {
    ok: true,
    reason:
      `section at line ${sec.startLine}: tagged restic backup, JWT-mint drill naming ` +
      `BLAKE3/Identity/from_claims, custody first, port ${port} auditable`,
  };
}

// --- orphan marker ----------------------------------------------------------

export function formatMarker(m) {
  return JSON.stringify({ pid: m.pid, stdb: m.stdb, issuer: m.issuer, tmp: m.tmp });
}

export function parseMarker(text) {
  try {
    const m = JSON.parse(text);
    if (typeof m.pid !== 'number' || !Number.isFinite(m.pid)) return null;
    return { pid: m.pid, stdb: m.stdb, issuer: m.issuer, tmp: m.tmp };
  } catch {
    return null;
  }
}

// ===========================================================================
// PHASE 0 FIXTURES
// ===========================================================================

const RUST_FIXTURE = [
  '/// Deployment config.',
  'pub(crate) const ALLOWED_ISSUERS: &[&str] = &[' + ISSUER_NEEDLE + '];',
  AUDIENCE_NEEDLE,
  'pub(crate) const CLAIM_CODE_LEN: usize = 64;',
].join('\n');

const GOOD_ID_A = 'a'.repeat(64);
const GOOD_ID_B = 'b'.repeat(64);
const GOOD_ID_C = 'c'.repeat(64);
const GOOD_ID_D = 'd'.repeat(64);
const GOOD_ID_E = 'e'.repeat(64);
const GOOD_CODE = '0123456789abcdef'.repeat(4);
const GOOD_ISSUER = 'INTERNAL_SECRET_PLACEHOLDER_ISSUER';

function goodEvents() {
  return [
    { step: 'A-connect', ok: true, data: { identity: GOOD_ID_A } },
    { step: 'A-applied', ok: true, data: { rows: 1, issuer: GOOD_ISSUER } },
    { step: 'B-connect', ok: true, data: { identity: GOOD_ID_B } },
    { step: 'B-join', ok: true, data: {} },
    { step: 'B-startClaim', ok: true, data: { code: GOOD_CODE } },
    { step: 'N2', ok: true, data: { err: ERR_INVALID_CODE } },
    { step: 'B-disconnect', ok: true, data: {} },
    { step: 'A-complete', ok: true, data: { attempts: 2 } },
    { step: 'D-connect', ok: true, data: { identity: GOOD_ID_D } },
    { step: 'D-applied', ok: true, data: { rows: 1 } },
    { step: 'N3', ok: true, data: { err: ERR_INVALID_CODE } },
    { step: 'C-connect', ok: true, data: { identity: GOOD_ID_C } },
    { step: 'C-applied', ok: true, data: { rows: 0 } },
    { step: 'E-connect', ok: true, data: { identity: GOOD_ID_E } },
    { step: 'E-applied', ok: true, data: { rows: 0 } },
    { step: 'done', ok: true, data: {} },
  ];
}

function mutateEvent(step, patch) {
  const ev = goodEvents();
  const i = ev.findIndex((e) => e.step === step);
  ev[i] = { ...ev[i], ...patch, data: { ...ev[i].data, ...(patch.data || {}) } };
  return ev;
}

function goodSqlTables() {
  return {
    account: [
      [GOOD_ID_A, GOOD_ID_B, '1770000000000'],
      [GOOD_ID_D, '(none)', '(none)'],
    ],
    guestClaim: [],
    monster: [[GOOD_ID_A], [GOOD_ID_A]],
  };
}

const GOOD_IDS = { a: GOOD_ID_A, b: GOOD_ID_B, c: GOOD_ID_C, d: GOOD_ID_D, e: GOOD_ID_E };

// --- the synthetic runbook -------------------------------------------------
// The document deliberately carries DECOYS in the section AFTER the Better Auth
// one: a `--tag better-auth` line and the BLAKE3/Identity/from_claims words.
// Every "wrong section" BAD fixture below is produced by deleting content from
// the Better Auth section only — so a checker that scans the whole document
// keeps passing and is caught.
const GOOD_RUNBOOK_LINES = [
  '# Observability and disaster-recovery runbook',
  '',
  '## 7. Known drift risk',
  '',
  'Everything is loopback-bound. Audit it:',
  '',
  '```sh',
  "ss -tlnp | grep -E '3000|3001|8443|9090'",
  '```',
  '',
  '## 8. Better Auth (accounts)',
  '',
  '- **Signing-key custody (FIRST line item, D20):** the JWKS private key is held in a',
  '  separate narrowly-scoped secret store and is excluded from the nightly sweep; if',
  '  exclusion proves infeasible, rotation on suspected exposure is the compensating control.',
  '- The service is loopback-bound on port 8443.',
  '',
  'Nightly backup (online snapshot, no stop-the-world):',
  '',
  '```sh',
  'sqlite3 /var/lib/better-auth/auth.sqlite "VACUUM INTO \'/var/backups/auth.sqlite\'"',
  'restic backup --tag better-auth /var/backups/auth.sqlite',
  '```',
  '',
  'Restore drill. Restore, then mint a token for a known subject and confirm the host',
  'still derives the SAME Identity from it — the derivation is BLAKE3 over the issuer',
  'and subject, applied by from_claims, so an issuer URL change re-keys every player:',
  '',
  '```sh',
  'restic restore latest --target /var/restore --tag better-auth',
  'curl -s -X POST "$AUTH_BASE/api/auth/token" -d \'{"sub":"dr-drill-user"}\' | jq -r .token',
  'spacetime logs monster-realm | tail -n 20',
  '```',
  '',
  '## 9. Appendix (DECOYS live here on purpose)',
  '',
  'Historical, superseded, and deliberately NOT part of the Better Auth section. A',
  'whole-document scanner is satisfied by everything below; a section-scoped one is not.',
  'The Identity derivation (BLAKE3, from_claims) is also described in ADR-0179.',
  '',
  '```sh',
  'restic backup --tag better-auth /srv/legacy-auth.sqlite',
  'curl -s -X POST "$LEGACY_BASE/api/auth/token" -d \'{"sub":"legacy-user"}\' | jq -r .token',
  '```',
  '',
];

const APPENDIX_HEADING = '## 9. Appendix (DECOYS live here on purpose)';

function runbookWithout(pred) {
  return GOOD_RUNBOOK_LINES.filter((l) => !pred(l)).join('\n');
}

// Rewrite ONLY the lines above the appendix, so every BAD fixture leaves the
// decoy section intact. That is what makes each fixture a section-scoping test
// rather than a "does the word appear anywhere" test.
function runbookMapBeforeAppendix(fn) {
  const at = GOOD_RUNBOOK_LINES.indexOf(APPENDIX_HEADING);
  return GOOD_RUNBOOK_LINES.map((l, i) => (i < at ? fn(l) : l)).join('\n');
}

// ===========================================================================
// LIVE RIG (phase 2) — imperative, isolated below every pure decision.
// ===========================================================================

const httpOrigin = (port) => 'http:/' + '/127.0.0.1:' + port;
const wsOrigin = (port) => 'ws:/' + '/127.0.0.1:' + port;
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function run(cmd, args, opts) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { ok: true, stdout: String(stdout), stderr: '' };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || e.message || '').slice(-1500),
    };
  }
}

function toolPresent(cmd, args) {
  return run(cmd, args).ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function genKeyPair() {
  return wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

async function publicJwk(pub, kid) {
  const jwk = await wc.subtle.exportKey('jwk', pub);
  return { ...jwk, kid, use: 'sig', alg: 'ES256' };
}

// ES256: webcrypto's ECDSA signature is already raw r||s, which is the JWS wire
// format — no DER conversion and no dependency (spike S5).
async function mintJwt(keyPair, kid, iss, sub, aud) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
  const payload = b64u(JSON.stringify({ iss, sub, aud, iat: now, exp: now + 3600 }));
  const data = new TextEncoder().encode(header + '.' + payload);
  const sig = await wc.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, data);
  return header + '.' + payload + '.' + b64u(sig);
}

async function startIssuerStub(port) {
  const origin = httpOrigin(port);
  const iss1 = origin + '/';
  const iss2 = origin + '/other/';
  const k1 = await genKeyPair();
  const k2 = await genKeyPair();
  const jwks1 = { keys: [await publicJwk(k1.publicKey, 'e2e-k1')] };
  const jwks2 = { keys: [await publicJwk(k2.publicKey, 'e2e-k2')] };
  const reqLog = [];
  const config = (issuer, other) =>
    JSON.stringify({
      issuer,
      jwks_uri: origin + (other ? '/other' : '') + '/jwks',
      authorization_endpoint: origin + '/authorize',
      token_endpoint: origin + '/token',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
    });
  const server = createServer((req, res) => {
    const url = String(req.url || '').replace(/\/{2,}/g, '/');
    reqLog.push(url);
    res.setHeader('content-type', 'application/json');
    const other = url.indexOf('other') !== -1;
    if (url.indexOf('openid-configuration') !== -1) res.end(config(other ? iss2 : iss1, other));
    else if (url.indexOf('jwks') !== -1) res.end(JSON.stringify(other ? jwks2 : jwks1));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, reqLog, iss1, iss2, k1, k2 };
}

// The loader hook + driver are GENERATED into the temp dir at runtime: nothing
// outside the repo is referenced, and the driver is versioned with this eval.
const TSRESOLVE_SRC = [
  '// Resolve extensionless relative TS specifiers (generated bindings style).',
  'export async function resolve(specifier, context, next) {',
  '  try {',
  '    return await next(specifier, context);',
  '  } catch (err) {',
  '    const rel = specifier.startsWith("./") || specifier.startsWith("../");',
  '    const bare =',
  '      !specifier.endsWith(".ts") && !specifier.endsWith(".js") && !specifier.endsWith(".mjs");',
  '    if (rel && bare) return next(specifier + ".ts", context);',
  '    throw err;',
  '  }',
  '}',
  '',
].join('\n');

function registerSrc(tsresolvePath) {
  return [
    "import { register } from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    'register(' + JSON.stringify(tsresolvePath) + ", pathToFileURL('./'));",
    '',
  ].join('\n');
}

// No backticks and no interpolation in this source: it is emitted verbatim.
const DRIVER_SRC = [
  "import { pathToFileURL } from 'node:url';",
  "import { webcrypto as wc } from 'node:crypto';",
  '',
  'const CLIENT = process.env.MR_CLIENT_DIR;',
  'const uri = process.env.MR_STDB_WS;',
  'const db = process.env.MR_DB;',
  'const jwtA = process.env.MR_JWT_A;',
  'const jwtC = process.env.MR_JWT_C;',
  'const jwtD = process.env.MR_JWT_D;',
  'const jwtE = process.env.MR_JWT_E;',
  '',
  'const mod = await import(pathToFileURL(CLIENT + "/src/module_bindings/index.ts").href);',
  'const DbConnection = mod.DbConnection;',
  '',
  'function emit(step, ok, data) {',
  '  process.stdout.write(JSON.stringify({ step: step, ok: ok, data: data }) + "\\n");',
  '}',
  'function bail(step, err) {',
  '  emit(step, false, { err: String((err && err.message) || err) });',
  '  process.exit(1);',
  '}',
  'const killer = setTimeout(function () { bail("timeout", "driver 150s timeout"); }, 150000);',
  'const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };',
  '',
  'function connectOnce(token) {',
  '  return new Promise(function (resolve, reject) {',
  '    let b = DbConnection.builder().withUri(uri).withDatabaseName(db);',
  '    if (token) b = b.withToken(token);',
  '    b.onConnect(function (c, identity) {',
  '      resolve({ conn: c, identity: identity.toHexString() });',
  '    })',
  '      .onConnectError(function (_ctx, err) { reject(err); })',
  '      .build();',
  '  });',
  '}',
  '',
  'function applied(conn, queries) {',
  '  return new Promise(function (resolve, reject) {',
  '    conn',
  '      .subscriptionBuilder()',
  '      .onApplied(function () { resolve(); })',
  '      .onError(function (_ctx, err) { reject(err); })',
  '      .subscribe(queries);',
  '  });',
  '}',
  '',
  'function accountRows(conn) {',
  '  const h = conn.db.my_account;',
  '  if (!h) throw new Error("no my_account table handle on the connection");',
  '  const out = [];',
  '  for (const r of h.iter()) out.push(r);',
  '  return out;',
  '}',
  '',
  'function hex32() {',
  '  const bytes = new Uint8Array(32);',
  '  wc.getRandomValues(bytes);',
  '  let s = "";',
  '  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");',
  '  return s;',
  '}',
  '',
  'async function tryReducer(promise) {',
  '  try {',
  '    await promise;',
  '    return { ok: true, err: null };',
  '  } catch (e) {',
  '    return { ok: false, err: String((e && e.message) || e) };',
  '  }',
  '}',
  '',
  'try {',
  '  const a = await connectOnce(jwtA);',
  '  emit("A-connect", true, { identity: a.identity });',
  '  await applied(a.conn, ["SELECT * FROM my_account"]);',
  '  const aRows = accountRows(a.conn);',
  '  emit("A-applied", true, {',
  '    rows: aRows.length,',
  '    issuer: aRows.length > 0 ? aRows[0].authIssuer : null,',
  '  });',
  '',
  '  const b = await connectOnce(null);',
  '  emit("B-connect", true, { identity: b.identity });',
  '  await applied(b.conn, ["SELECT * FROM player"]);',
  '  const joined = await tryReducer(b.conn.reducers.joinGame({ name: "guest e2e" }));',
  '  emit("B-join", joined.ok, { err: joined.err });',
  '',
  '  const code = hex32();',
  '  const started = await tryReducer(b.conn.reducers.startGuestClaim({ code: code }));',
  '  emit("B-startClaim", started.ok, { code: code, err: started.err });',
  '',
  '  const never = hex32();',
  '  const n2 = await tryReducer(a.conn.reducers.completeGuestClaim({ code: never }));',
  '  emit("N2", !n2.ok, { err: n2.err });',
  '',
  '  b.conn.disconnect();',
  '  await sleep(500);',
  '  emit("B-disconnect", true, {});',
  '',
  '  let attempts = 0;',
  '  let last = { ok: false, err: "never attempted" };',
  '  for (let i = 0; i < 20; i++) {',
  '    attempts++;',
  '    last = await tryReducer(a.conn.reducers.completeGuestClaim({ code: code }));',
  '    if (last.ok) break;',
  '    if (String(last.err).indexOf("close your other tab") === -1) break;',
  '    await sleep(500);',
  '  }',
  '  emit("A-complete", last.ok, { attempts: attempts, err: last.err });',
  '',
  '  const d = await connectOnce(jwtD);',
  '  emit("D-connect", true, { identity: d.identity });',
  '  await applied(d.conn, ["SELECT * FROM my_account"]);',
  '  emit("D-applied", true, { rows: accountRows(d.conn).length });',
  '',
  '  const n3 = await tryReducer(d.conn.reducers.completeGuestClaim({ code: code }));',
  '  emit("N3", !n3.ok, { err: n3.err });',
  '',
  '  const c = await connectOnce(jwtC);',
  '  emit("C-connect", true, { identity: c.identity });',
  '  await applied(c.conn, ["SELECT * FROM my_account"]);',
  '  emit("C-applied", true, { rows: accountRows(c.conn).length });',
  '',
  '  const e = await connectOnce(jwtE);',
  '  emit("E-connect", true, { identity: e.identity });',
  '  await applied(e.conn, ["SELECT * FROM my_account"]);',
  '  emit("E-applied", true, { rows: accountRows(e.conn).length });',
  '',
  '  clearTimeout(killer);',
  '  emit("done", true, {});',
  '  a.conn.disconnect();',
  '  c.conn.disconnect();',
  '  d.conn.disconnect();',
  '  e.conn.disconnect();',
  '  process.exit(0);',
  '} catch (e) {',
  '  bail("flow", e);',
  '}',
  '',
].join('\n');

// A previous run that was hard-killed (CI cancellation, SIGKILL) leaves its
// spacetime child holding a port and its temp dir on disk. The marker is
// removed in this eval's `finally`, so a marker found at startup means exactly
// that. Accepted risk: PIDs are recycled, so an unrelated process could in
// principle inherit the recorded pid between the crash and the next run.
function killOrphan() {
  if (!existsSync(MARKER_FILE)) return 'no marker';
  let note = 'stale marker removed';
  const marker = parseMarker(readFileSync(MARKER_FILE, 'utf8'));
  if (marker && marker.pid !== process.pid) {
    try {
      process.kill(marker.pid, 0);
      process.kill(marker.pid, 'SIGKILL');
      note = `killed orphan pid ${marker.pid}`;
    } catch {
      note = `orphan pid ${marker.pid} already gone`;
    }
  }
  try {
    unlinkSync(MARKER_FILE);
  } catch {
    /* already gone */
  }
  return note;
}

async function waitForHost(url, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url + '/');
      return true;
    } catch {
      await sleep(intervalMs);
    }
  }
  return false;
}

// The CLI prints an UNSTABLE banner on stderr; only stdout is parsed. Every
// query's raw output is recorded into `rawSink` so a server-truth failure can be
// told apart from a table-format surprise without re-running the whole rig.
function sqlTable(dbUrl, query, rawSink) {
  const res = run('spacetime', ['sql', '-s', dbUrl, DB_NAME, query], { timeout: 60_000 });
  if (!res.ok) throw new Error(`sql failed (${query}): ${res.stderr}`);
  rawSink.push(`${query} => ${res.stdout.trim().replace(/\s+/g, ' ').slice(0, 240)}`);
  return parseSqlOutput(res.stdout).rows;
}

async function runLivePhase() {
  const repoRoot = process.cwd();
  const notes = [];
  notes.push(killOrphan());

  const issuerPort = await reservePort();
  const stdbPort = await reservePort();
  if (issuerPort === stdbPort) throw new Error(`port reservation collided on ${issuerPort}`);
  const dbUrl = httpOrigin(stdbPort);

  let tmp = null;
  let stub = null;
  let stdb = null;
  let driver = null;
  let stdbLog = '';

  try {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'mr-acct-e2e-'));
    writeFileSync(
      MARKER_FILE,
      formatMarker({ pid: process.pid, stdb: stdbPort, issuer: issuerPort, tmp }),
    );

    stub = await startIssuerStub(issuerPort);

    // --- patched workspace copy (spike S4) ---
    for (const member of WORKSPACE_MEMBERS) {
      cpSync(path.join(repoRoot, member), path.join(tmp, member), {
        recursive: true,
        filter: (src) =>
          !src.includes(path.sep + 'target') && !src.includes(path.sep + 'node_modules'),
      });
    }
    for (const f of WORKSPACE_ROOT_FILES) {
      cpSync(path.join(repoRoot, f), path.join(tmp, f));
    }
    const accountsPath = path.join(tmp, 'server-module', 'src', 'accounts.rs');
    const original = readFileSync(accountsPath, 'utf8');
    // Both patchers THROW when their needle is absent (N4).
    const patched = patchAllowedAudience(patchAllowedIssuers(original, stub.iss1), E2E_CLIENT_ID);
    if (patched === original) throw new Error('patch was a no-op — refusing to publish (N4)');
    writeFileSync(accountsPath, patched);

    // --- build + publish ---
    const targetDir = process.env.MR_ACCT_E2E_TARGET_DIR || path.join(repoRoot, 'target');
    const build = run(
      'cargo',
      ['build', '-p', 'monster-realm-module', '--release', '--target', 'wasm32-unknown-unknown'],
      { cwd: tmp, env: { ...process.env, CARGO_TARGET_DIR: targetDir }, timeout: 900_000 },
    );
    if (!build.ok) throw new Error(`cargo build of the patched module failed: ${build.stderr}`);
    const wasm = path.join(
      targetDir,
      'wasm32-unknown-unknown',
      'release',
      'monster_realm_module.wasm',
    );
    if (!existsSync(wasm)) throw new Error(`built wasm not found at ${wasm}`);

    stdb = spawn('spacetime', ['start', '--in-memory', '--listen-addr', '127.0.0.1:' + stdbPort], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    stdb.stdout.on('data', (d) => {
      stdbLog = (stdbLog + d).slice(-4000);
    });
    stdb.stderr.on('data', (d) => {
      stdbLog = (stdbLog + d).slice(-4000);
    });
    if (!(await waitForHost(dbUrl, 120, 500))) {
      throw new Error(`spacetime did not become ready on ${stdbPort}; log tail: ${stdbLog}`);
    }
    const published = run(
      'spacetime',
      ['publish', '-s', dbUrl, '--bin-path', wasm, '-y', DB_NAME],
      { timeout: 300_000 },
    );
    if (!published.ok) throw new Error(`publish failed: ${published.stderr}`);

    // --- driver ---
    const tsresolvePath = path.join(tmp, 'tsresolve.mjs');
    const registerPath = path.join(tmp, 'register.mjs');
    const driverPath = path.join(tmp, 'driver.mjs');
    writeFileSync(tsresolvePath, TSRESOLVE_SRC);
    writeFileSync(registerPath, registerSrc(tsresolvePath));
    writeFileSync(driverPath, DRIVER_SRC);

    const jwtA = await mintJwt(stub.k1, 'e2e-k1', stub.iss1, 'alice-e2e', [E2E_CLIENT_ID]);
    const jwtD = await mintJwt(stub.k1, 'e2e-k1', stub.iss1, 'dave-e2e', [E2E_CLIENT_ID]);
    const jwtC = await mintJwt(stub.k2, 'e2e-k2', stub.iss2, 'mallory-e2e', [E2E_CLIENT_ID]);
    // E: the CORRECT (patched) issuer + key, but an audience that is NOT the
    // patched ALLOWED_AUDIENCE. This exercises audience_allowed directly: today's
    // `.any()` membership check against the single patched entry already rejects
    // it (the deployment-time exact-equality tightening is 13r-c-2-gated and out
    // of this slice), so E provisions no account and E-applied.rows === 0.
    const jwtE = await mintJwt(stub.k1, 'e2e-k1', stub.iss1, 'erin-e2e', [WRONG_AUDIENCE]);

    const clientDir = path.join(repoRoot, 'client');
    driver = spawn(process.execPath, ['--import', registerPath, driverPath], {
      cwd: clientDir,
      env: {
        ...process.env,
        MR_CLIENT_DIR: clientDir,
        MR_STDB_WS: wsOrigin(stdbPort),
        MR_DB: DB_NAME,
        MR_JWT_A: jwtA,
        MR_JWT_C: jwtC,
        MR_JWT_D: jwtD,
        MR_JWT_E: jwtE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    driver.stdout.on('data', (d) => {
      out += d;
    });
    driver.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    const exitCode = await new Promise((resolve) => {
      const watchdog = setTimeout(() => {
        try {
          driver.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve('watchdog-timeout');
      }, 240_000);
      driver.on('exit', (c) => {
        clearTimeout(watchdog);
        resolve(c);
      });
    });

    const events = [];
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const ev = JSON.parse(t);
        if (ev && typeof ev.step === 'string') events.push(ev);
      } catch {
        /* not a milestone line */
      }
    }
    const milestones = checkMilestones(events, { issuer: stub.iss1 });
    if (!milestones.ok) {
      throw new Error(
        `driver milestones: ${milestones.reason} (exit ${exitCode}; stderr tail: ${err.slice(-400)})`,
      );
    }

    // --- host-side acceptance proof (F12) — pure fn, teeth-tested in phase 0 ---
    const acceptance = checkHostSideAcceptance(stub.reqLog);
    if (!acceptance.ok) throw new Error(acceptance.reason);

    // --- server truth ---
    const rawSql = [];
    const truth = checkSqlTruth(
      {
        account: sqlTable(
          dbUrl,
          'SELECT identity, claimed_from, claimed_at_ms FROM account',
          rawSql,
        ),
        guestClaim: sqlTable(dbUrl, 'SELECT guest_identity, code FROM guest_claim', rawSql),
        monster: sqlTable(dbUrl, 'SELECT owner_identity FROM monster', rawSql),
      },
      {
        a: events.find((e) => e.step === 'A-connect').data.identity,
        b: events.find((e) => e.step === 'B-connect').data.identity,
        c: events.find((e) => e.step === 'C-connect').data.identity,
        d: events.find((e) => e.step === 'D-connect').data.identity,
        e: events.find((e) => e.step === 'E-connect').data.identity,
      },
    );
    if (!truth.ok) throw new Error(`server truth: ${truth.reason} :: raw ${rawSql.join(' | ')}`);

    return {
      ok: true,
      detail:
        `live flow green on issuer port ${issuerPort} / host port ${stdbPort} (tmp ${tmp}): ` +
        `${milestones.reason}; ${truth.reason}; ${notes.join('; ')}`,
      ports: { issuerPort, stdbPort },
      tmp,
    };
  } catch (err) {
    // Every failure detail names both ports and the temp dir: a CI flake that
    // cannot be located is a flake that gets muted instead of fixed (R10).
    throw new Error(
      `${err?.message ?? String(err)} [issuer port ${issuerPort}, host port ${stdbPort}, ` +
        `tmp ${tmp}, host log tail: ${stdbLog.slice(-300)}]`,
    );
  } finally {
    // Teardown is best-effort and individually guarded: a teardown failure must
    // never mask (or manufacture) a result.
    try {
      if (driver) driver.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    if (stdb) {
      try {
        stdb.kill('SIGTERM');
        const deadline = Date.now() + 5000;
        while (stdb.exitCode === null && Date.now() < deadline) await sleep(200);
        if (stdb.exitCode === null) stdb.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      if (stub) {
        stub.server.close();
        stub.server.unref();
      }
    } catch {
      /* already closed */
    }
    try {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      if (existsSync(MARKER_FILE)) unlinkSync(MARKER_FILE);
    } catch {
      /* best effort */
    }
  }
}

// ===========================================================================
// THE EVAL
// ===========================================================================

export default async function () {
  const name = 'account-e2e (G22 live claim flow + G23 DR runbook Better Auth section)';
  const teeth = (id, why) => ({ name, pass: false, detail: `TEETH ${id}: ${why}` });

  // =========================================================================
  // PHASE 0 — proof of teeth. Nothing below this block is trusted until every
  // pure decision function has been shown to reject a known-bad input.
  // =========================================================================

  // --- N4: the patchers must throw rather than silently no-op ---
  {
    let threw = false;
    try {
      patchAllowedIssuers('fn main() {}', httpOrigin(1234) + '/');
    } catch {
      threw = true;
    }
    if (!threw) {
      return teeth(
        'N4-issuer',
        'patchAllowedIssuers did NOT throw on a source lacking the committed token — a silent ' +
          'no-op publishes an unpatched module, in which no JWT is ever accepted and every ' +
          '"no account was provisioned" assertion becomes vacuously true',
      );
    }
    threw = false;
    try {
      patchAllowedAudience('fn main() {}', E2E_CLIENT_ID);
    } catch {
      threw = true;
    }
    if (!threw) {
      return teeth(
        'N4-audience',
        'patchAllowedAudience did NOT throw on a source lacking its line',
      );
    }
    threw = false;
    try {
      patchAllowedIssuers(RUST_FIXTURE, httpOrigin(1234));
    } catch {
      threw = true;
    }
    if (!threw) {
      return teeth(
        'N4-slash',
        'patchAllowedIssuers accepted an issuer with no trailing slash — issuer_allowed is an ' +
          'EXACT match, so a missing slash silently produces an allowlist that matches nothing',
      );
    }

    const issuer = httpOrigin(45999) + '/';
    const patchedIss = patchAllowedIssuers(RUST_FIXTURE, issuer);
    if (patchedIss === RUST_FIXTURE) return teeth('N4-good-issuer', 'patch was a no-op');
    if (patchedIss.indexOf(ISSUER_NEEDLE) !== -1) {
      return teeth('N4-good-issuer', 'the committed fail-closed issuer survived the patch');
    }
    if (patchedIss.indexOf('concat!(') === -1 || patchedIss.indexOf('127.0.0.1:45999') === -1) {
      return teeth(
        'N4-good-issuer',
        'the patched line must keep the concat!() form AND carry the stub origin ' +
          `(got: ${patchedIss.split('\n')[1]})`,
      );
    }
    const patchedAud = patchAllowedAudience(RUST_FIXTURE, E2E_CLIENT_ID);
    if (
      patchedAud.indexOf('"' + E2E_CLIENT_ID + '"') === -1 ||
      patchedAud.indexOf('"monster-realm"') !== -1
    ) {
      return teeth('N4-good-audience', 'the audience was not replaced with the e2e client id');
    }
  }

  // --- live-phase predicates (bindings-drift B/B2/B3 truth table) ---
  {
    const cases = [
      ['run/ci+cli', shouldRunLive({ ci: true, hasCli: true }), true],
      ['run/local+cli', shouldRunLive({ ci: false, hasCli: true }), true],
      ['run/ci-no-cli', shouldRunLive({ ci: true, hasCli: false }), false],
      ['run/local-no-cli', shouldRunLive({ ci: false, hasCli: false }), false],
      ['loud/ci-no-cli', shouldFailLoudNoCli({ ci: true, hasCli: false }), true],
      ['loud/local-no-cli', shouldFailLoudNoCli({ ci: false, hasCli: false }), false],
      ['loud/ci+cli', shouldFailLoudNoCli({ ci: true, hasCli: true }), false],
      ['loud/local+cli', shouldFailLoudNoCli({ ci: false, hasCli: true }), false],
    ];
    for (const [label, got, want] of cases) {
      if (got !== want) {
        return teeth(
          `predicate ${label}`,
          `expected ${want}, got ${got} — the CI/local skip logic decides whether G22 runs at ` +
            'all, so its truth table is proven before it is trusted',
        );
      }
    }
  }

  // --- ci.yml step order ---
  {
    const goodYaml = [
      'name: CI',
      'on:',
      '  pull_request:',
      'jobs:',
      '  ci:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Install SpacetimeDB CLI',
      '        run: sh /tmp/install.sh --yes',
      '      - run: just eval',
      '  e2e:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: just e2e',
    ].join('\n');
    const invertedYaml = [
      'name: CI',
      'on:',
      '  pull_request:',
      'jobs:',
      '  ci:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: just eval',
      '      - name: Install SpacetimeDB CLI',
      '        run: sh /tmp/install.sh --yes',
    ].join('\n');
    const noInstallYaml = [
      'name: CI',
      'on:',
      '  pull_request:',
      'jobs:',
      '  ci:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: just eval',
    ].join('\n');
    if (!ciInstallsCliBeforeEval(goodYaml).ok) {
      return teeth('ci-order-good', 'a correctly ordered workflow was rejected (false positive)');
    }
    if (ciInstallsCliBeforeEval(invertedYaml).ok) {
      return teeth(
        'ci-order-inverted',
        'a workflow that installs the CLI AFTER `just eval` was accepted — in that workflow the ' +
          'live phase silently note-skips forever',
      );
    }
    if (ciInstallsCliBeforeEval(noInstallYaml).ok) {
      return teeth('ci-order-missing', 'a workflow with no CLI install step was accepted');
    }
  }

  // --- checkMilestones ---
  {
    const good = checkMilestones(goodEvents(), { issuer: GOOD_ISSUER });
    if (!good.ok)
      return teeth('milestones-good', `a complete good run was rejected: ${good.reason}`);

    const bad = [
      [
        'C-provisioned',
        mutateEvent('C-applied', { data: { rows: 1 } }),
        'a wrong-issuer connection that DID provision an account was accepted — this is the ' +
          'single assertion that makes the positive result meaningful (N1)',
      ],
      [
        'E-provisioned',
        mutateEvent('E-applied', { data: { rows: 1 } }),
        'a CORRECT-issuer but WRONG-audience connection that provisioned an account was accepted ' +
          '— audience_allowed accepted a token minted for another application (D18/CRITICAL-2)',
      ],
      [
        'A-not-provisioned',
        mutateEvent('A-applied', { data: { rows: 0 } }),
        'a run where the account JWT provisioned nothing was accepted',
      ],
      [
        'A-wrong-issuer',
        mutateEvent('A-applied', { data: { issuer: 'somewhere-else' } }),
        "an account row stamped with an issuer other than the stub's was accepted",
      ],
      [
        'N3-oracle',
        mutateEvent('N3', { data: { err: 'code expired' } }),
        'a run where the replay and the never-existed code returned DIFFERENT strings was ' +
          'accepted — that difference is a claim-code oracle (AUTH-35)',
      ],
      [
        'B-same-identity',
        mutateEvent('B-connect', { data: { identity: GOOD_ID_A } }),
        'a run where the anonymous leg reused the account identity was accepted',
      ],
      [
        'A-complete-failed',
        mutateEvent('A-complete', { ok: false, data: { err: ERR_OTHER_TAB } }),
        'a run whose claim never completed was accepted',
      ],
      [
        'bad-code-shape',
        mutateEvent('B-startClaim', { data: { code: 'ABC' } }),
        'a claim code that is not 64 lowercase hex was accepted (AUTH-60)',
      ],
      [
        'missing-milestone',
        goodEvents().filter((e) => e.step !== 'A-complete'),
        'a run missing a milestone entirely was accepted',
      ],
      [
        'out-of-order',
        (() => {
          const ev = goodEvents();
          const n2 = ev.findIndex((e) => e.step === 'N2');
          const complete = ev.findIndex((e) => e.step === 'A-complete');
          const copy = ev.slice();
          copy[n2] = ev[complete];
          copy[complete] = ev[n2];
          return copy;
        })(),
        'a run where the never-existed-code control ran AFTER the claim completed was accepted — ' +
          'guard 4 (account already claimed) fires first there, so N2 would prove nothing',
      ],
      ['empty', [], 'an empty milestone stream was accepted'],
    ];
    for (const [id, events, why] of bad) {
      const got = checkMilestones(events, { issuer: GOOD_ISSUER });
      if (got.ok) return teeth(`milestones-${id}`, why);
    }
  }

  // --- checkSqlTruth ---
  {
    const good = checkSqlTruth(goodSqlTables(), GOOD_IDS);
    if (!good.ok) return teeth('sql-good', `a correct server state was rejected: ${good.reason}`);

    const variants = [
      [
        'claim-not-consumed',
        (t) => {
          t.guestClaim = [[GOOD_ID_B, GOOD_CODE]];
        },
        'a guest_claim row surviving a successful claim was accepted — the code is replayable ' +
          '(AUTH-34)',
      ],
      [
        'monster-not-rekeyed',
        (t) => {
          t.monster = [[GOOD_ID_B]];
        },
        'a monster still owned by the guest identity was accepted — the re-key is the entire ' +
          'point of the claim (AUTH-21/22)',
      ],
      [
        'no-monsters',
        (t) => {
          t.monster = [];
        },
        'zero monster rows was accepted, which makes the re-key assertion vacuous',
      ],
      [
        'wrong-provenance',
        (t) => {
          t.account[0] = [GOOD_ID_A, GOOD_ID_C, '1770000000000'];
        },
        'claimed_from pointing at the wrong identity was accepted',
      ],
      [
        'null-claimed-at',
        (t) => {
          t.account[0] = [GOOD_ID_A, GOOD_ID_B, '(none)'];
        },
        'a claimed account with no claimed_at_ms was accepted',
      ],
      [
        'c-provisioned',
        (t) => {
          t.account.push([GOOD_ID_C, '(none)', '(none)']);
        },
        'an account row for the wrong-issuer identity was accepted',
      ],
      [
        'account-missing',
        (t) => {
          t.account = [[GOOD_ID_D, '(none)', '(none)']];
        },
        "the destination account row's absence was accepted",
      ],
    ];
    for (const [id, mutate, why] of variants) {
      const tables = goodSqlTables();
      mutate(tables);
      if (checkSqlTruth(tables, GOOD_IDS).ok) return teeth(`sql-${id}`, why);
    }
  }

  // --- checkHostSideAcceptance (N1 host-side proof) ---
  {
    const goodLog = [
      '/.well-known/openid-configuration',
      '/jwks',
      '/other/.well-known/openid-configuration',
      '/other/jwks',
    ];
    const goodHost = checkHostSideAcceptance(goodLog);
    if (!goodHost.ok) {
      return teeth('host-good', `a complete request log was rejected: ${goodHost.reason}`);
    }
    const noOtherDiscovery = ['/.well-known/openid-configuration', '/jwks', '/other/jwks'];
    if (checkHostSideAcceptance(noOtherDiscovery).ok) {
      return teeth(
        'host-no-other-discovery',
        "a log missing the SECOND issuer's discovery fetch was accepted — C may have been " +
          'dropped before verification, making its "no account" result vacuous',
      );
    }
    const noOtherJwks = [
      '/.well-known/openid-configuration',
      '/jwks',
      '/other/.well-known/openid-configuration',
    ];
    if (checkHostSideAcceptance(noOtherJwks).ok) {
      return teeth(
        'host-no-other-jwks',
        "a log missing the SECOND issuer's jwks fetch was accepted — the host never obtained the " +
          "key it would have rejected C's signature against",
      );
    }
    const noPrimary = ['/other/.well-known/openid-configuration', '/other/jwks'];
    if (checkHostSideAcceptance(noPrimary).ok) {
      return teeth(
        'host-no-primary',
        'a log with no primary discovery fetch was accepted — A/D/E were never verified at all',
      );
    }
    if (checkHostSideAcceptance([]).ok)
      return teeth('host-empty', 'an empty request log was accepted');
  }

  // --- parseSqlOutput ---
  {
    const twoRows = [
      ' identity | auth_issuer ',
      '----------+-------------',
      ' 0xaaaa   | stub        ',
      ' 0xbbbb   | stub        ',
      '(2 rows)',
    ].join('\n');
    const parsed = parseSqlOutput(twoRows);
    if (parsed.rows.length !== 2 || parsed.columns.length !== 2) {
      return teeth(
        'sql-parse-rows',
        `expected 2 columns and 2 rows, got ${parsed.columns.length}/${parsed.rows.length} — ` +
          'the separator rule or the "(N rows)" footer is being counted as data',
      );
    }
    if (!identityMatches(parsed.rows[0][0], 'AAAA')) {
      return teeth('sql-parse-cell', 'cells are not being split/trimmed as expected');
    }
    const empty = parseSqlOutput([' guest_identity | code ', '----------------+------'].join('\n'));
    if (empty.rows.length !== 0) {
      return teeth(
        'sql-parse-empty',
        `a header-only result parsed as ${empty.rows.length} row(s) — "guest_claim is empty" is ` +
          'THE single-use assertion, and it must not be satisfiable by a mis-parse',
      );
    }
    if (parseSqlOutput('').rows.length !== 0) return teeth('sql-parse-blank', 'blank output');
    if (looksLikeIdentity('(none)')) return teeth('sql-null', 'a null cell parsed as an identity');
    if (!looksLikeIdentity('0x' + GOOD_ID_A))
      return teeth('sql-id', 'a real identity was rejected');
    if (identityMatches('', GOOD_ID_A)) return teeth('sql-id-empty', 'an empty cell matched');
  }

  // --- claim-code shape + marker round trip ---
  {
    if (!isValidClaimCode(GOOD_CODE)) return teeth('code-good', 'a valid 64-hex code was rejected');
    for (const badCode of ['', 'ff', GOOD_CODE.toUpperCase(), GOOD_CODE + '0', 'g'.repeat(64)]) {
      if (isValidClaimCode(badCode)) return teeth('code-bad', `accepted '${badCode.slice(0, 12)}'`);
    }
    const round = parseMarker(formatMarker({ pid: 42, stdb: 1, issuer: 2, tmp: '/tmp/x' }));
    if (!round || round.pid !== 42) return teeth('marker', 'marker round trip lost the pid');
    if (parseMarker('not json') !== null) return teeth('marker-bad', 'garbage parsed as a marker');
  }

  // --- G23 checker fixtures (section-scoped, decoys outside the section) ---
  {
    const goodDoc = GOOD_RUNBOOK_LINES.join('\n');
    const goodResult = checkDrRunbookBetterAuthSection(goodDoc, BETTER_AUTH_PORT);
    if (!goodResult.ok) {
      return teeth('g23-good', `a complete Better Auth section was rejected: ${goodResult.reason}`);
    }

    // Every BAD document below keeps the decoy appendix INTACT: a checker that
    // scans the whole file still finds the tag, the mint command and the
    // BLAKE3/Identity/from_claims vocabulary, and therefore still passes. Each
    // fixture also pins WHICH clause must fire, so a checker that reds for an
    // unrelated reason does not get credit for catching it.
    const custodyMovedLast = (() => {
      const kept = GOOD_RUNBOOK_LINES.filter(
        (l) =>
          l.indexOf('Signing-key custody') === -1 &&
          l.indexOf('separate narrowly-scoped') === -1 &&
          l.indexOf('exclusion proves infeasible') === -1,
      );
      const at = kept.indexOf(APPENDIX_HEADING);
      kept.splice(
        at,
        0,
        '- **Signing-key custody:** the JWKS private key is excluded from the sweep.',
        '',
      );
      return kept.join('\n');
    })();

    const badDocs = [
      [
        'tag-in-wrong-section',
        runbookMapBeforeAppendix((l) => l.split('--tag better-auth').join('--tag monster-realm')),
        'clause 1',
        'the section kept only an untagged/other-tagged backup while a `--tag better-auth` line ' +
          'sat in a LATER section, and the checker passed — this is exactly the whole-document ' +
          'scan failure mode G23 exists to avoid',
      ],
      [
        'no-jwt-mint',
        runbookMapBeforeAppendix((l) =>
          l.indexOf('/api/auth/token') !== -1 || l.indexOf('spacetime logs') !== -1
            ? 'ls -l /var/restore'
            : l,
        ),
        'clause 2',
        'a restore drill with no token-minting step was accepted — restoring the file proves ' +
          'nothing about players being able to sign in again',
      ],
      [
        'identity-terms-outside-section',
        runbookMapBeforeAppendix((l) =>
          l.indexOf('BLAKE3') !== -1 || l.indexOf('from_claims') !== -1 ? 'the same way.' : l,
        ),
        'clause 3',
        'BLAKE3/from_claims present only in the LATER appendix satisfied clause 3',
      ],
      [
        'custody-after-restic',
        custodyMovedLast,
        'clause 4',
        'a section whose custody item sits AFTER the backup command was accepted — an operator ' +
          'reading top-to-bottom backs the signing key up before learning they must not (D20)',
      ],
      [
        'port-nowhere',
        runbookWithout((l) => l.indexOf('8443') !== -1),
        'clause 5',
        'the Better Auth port appearing in neither the section nor the port-audit line was accepted',
      ],
      [
        'heading-absent',
        runbookWithout((l) => l === '## 8. Better Auth (accounts)'),
        'FAIL-LOUD',
        'a document with NO Better Auth section passed — the extractor fell back to the whole ' +
          'document instead of failing loud',
      ],
    ];
    for (const [id, doc, clause, why] of badDocs) {
      const got = checkDrRunbookBetterAuthSection(doc, BETTER_AUTH_PORT);
      if (got.ok) return teeth(`g23-${id}`, why);
      if (got.reason.indexOf(clause) === -1) {
        return teeth(
          `g23-${id}`,
          `rejected for the WRONG reason — expected '${clause}', got: ${got.reason}`,
        );
      }
    }

    // duplicated heading — ambiguity must fail loud, never pick one.
    const dupHeading = GOOD_RUNBOOK_LINES.concat([
      '## 8b. Better Auth (draft)',
      '',
      'A second section with the same subject.',
    ]).join('\n');
    if (checkDrRunbookBetterAuthSection(dupHeading, BETTER_AUTH_PORT).ok) {
      return teeth(
        'g23-duplicate-heading',
        'two Better Auth sections were accepted — the extractor guessed which one to scan ' +
          'instead of failing loud',
      );
    }
    let threw = false;
    try {
      extractSection('# doc\n\nno sections here', 'Better Auth', '## ');
    } catch {
      threw = true;
    }
    if (!threw)
      return teeth('g23-extract-throw', 'extractSection did not throw on a missing heading');
    const sec = extractSection(goodDoc, 'Better Auth', '## ');
    if (sec.body.indexOf('ADR-0179') !== -1) {
      return teeth(
        'g23-section-bounds',
        'the extracted section leaked into the FOLLOWING section — every clause would then be ' +
          'satisfiable by text the section does not contain',
      );
    }
    if (sec.body.indexOf('VACUUM INTO') === -1) {
      return teeth('g23-section-bounds', 'the extracted section is missing its own content');
    }
  }

  // =========================================================================
  // PHASE 1 — G23 against the REAL runbook. Unconditional, before the CLI
  // probe: a note-skipped live phase must never take the doc gate with it.
  // =========================================================================
  if (!existsSync(RUNBOOK_PATH)) {
    return { name, pass: false, detail: `G23: ${RUNBOOK_PATH} is missing` };
  }
  const runbook = readFileSync(RUNBOOK_PATH, 'utf8');
  const g23 = checkDrRunbookBetterAuthSection(runbook, BETTER_AUTH_PORT);
  if (!g23.ok) {
    return {
      name,
      pass: false,
      detail:
        `G23 (${RUNBOOK_PATH}): ${g23.reason} — the Better Auth deployment ships with a DR ` +
        'posture or it does not ship (ADR-0182 D20). Expected RED at HEAD until T16 lands the ' +
        'section.',
    };
  }

  if (!existsSync(CI_WORKFLOW_PATH)) {
    return { name, pass: false, detail: `cannot read ${CI_WORKFLOW_PATH}` };
  }
  const ciOrder = ciInstallsCliBeforeEval(readFileSync(CI_WORKFLOW_PATH, 'utf8'));
  if (!ciOrder.ok) {
    return { name, pass: false, detail: `ci.yml step order: ${ciOrder.reason}` };
  }

  // =========================================================================
  // PHASE 2 — the live flow.
  // =========================================================================
  const ci = !!process.env.CI;
  const hasSpacetime = toolPresent('spacetime', ['--version']);
  const hasCargo = toolPresent('cargo', ['--version']);
  const hasCli = hasSpacetime && hasCargo;

  if (!shouldRunLive({ ci, hasCli })) {
    if (shouldFailLoudNoCli({ ci, hasCli })) {
      return {
        name,
        pass: false,
        detail:
          'CI: the live toolchain is absent (' +
          `spacetime=${hasSpacetime}, cargo=${hasCargo}) — the CLI install step in the ci job ` +
          'appears to have regressed. G22 must never silently skip in CI: without it the entire ' +
          'guest-to-account claim flow ships unexercised.',
      };
    }
    return {
      name,
      pass: true,
      detail:
        `G23 green (${g23.reason}); ${ciOrder.reason}; all phase-0 teeth bite. Live phase ` +
        `note-skipped: no live toolchain locally (spacetime=${hasSpacetime}, cargo=${hasCargo}).`,
    };
  }

  let live;
  try {
    live = await runLivePhase();
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `G22 live flow FAILED: ${err?.message ?? String(err)}`,
    };
  }
  return {
    name,
    pass: true,
    detail: `G23 green (${g23.reason}); ${ciOrder.reason}; G22 ${live.detail}`,
  };
}
