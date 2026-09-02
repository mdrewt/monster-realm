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
// CHECKER-IMPORT REUSE (ADR-0232 D6): the `spacetime sql --format json` envelope
// decoder already exists, is exported, main-guarded, and adversarially
// teeth-tested by evals/playtest-report.eval.mjs (DRIVER-1/2 + malformed-envelope
// cases) — S9 reuses it rather than reimplementing a second JSON-table parser.
import { decodeSqlJson } from '../scripts/playtest-report.mjs';
// Same reuse rule for G24's Rust-source primitives: `requireSoleDefinition`
// and `parseGraceConst` are already teeth-tested (and already red-teamed —
// see their own docstrings) by the eval that owns them.
import {
  parseGraceConst,
  requireSoleDefinition,
  stripRustComments,
} from './deletion-grace-wasm-ssot.eval.mjs';
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
// M22-S9 — post-integration verification constants (ADR-0232). Every expected
// VALUE below is tied byte-for-byte to its source-of-record by the Rust test
// m22s9_e2e_patch_needles_and_constants / m22s9_e2e_manifest_transcription_
// matches_manifest in server-module/src/accounts_tests.rs — never re-derive or
// "fix" one here without that test going red first.
// ===========================================================================

// game-core/src/accounts/deletion.rs — the FULL declaration lines, so the
// patchers can never hit the HONESTY-NOTE comment that repeats the bare value
// (red-team CRITICAL-4: a bare-literal needle patches the comment and leaves
// the real constant at 7 days, which reads as a 120 s terminal-poll hang).
export const GRACE_NEEDLE = 'pub const DELETION_GRACE_MS_DEFAULT: i64 = 604_800_000;';
export const CHUNK_NEEDLE = 'pub const EXPORT_CHUNK_ROWS: u32 = 500;';
// The e2e-compressed values (ADR-0232 D1). 15 s makes the real one-shot reaper
// fire inside CI (spike-measured +15.002 s); 2 (not 1) is the chunk boundary
// that distinguishes an honored chunks(K) from one-chunk-per-row.
export const E2E_GRACE_MS = 15_000;
export const E2E_CHUNK_ROWS = 2;

// accounts.rs REJECT_ALREADY_DELETED — the PRV1-4 distinct terminal error.
export const ERR_ALREADY_DELETED_E2E = 'this account has already been permanently deleted';
// privacy.rs — request_data_export's pending-deletion reject. Pinned EXACTLY
// (red-team HIGH-6): the same reducer has a cooldown reject 60 s wide that the
// S9 flow sits inside, so a loose "any Err" here would pass even if a reorder
// made the cooldown fire before the deletion gate.
export const ERR_EXPORT_PENDING_DELETION_E2E = 'export_reject_pending_deletion';
// game-core tombstone sentinels (S1), spelled once each.
export const TOMBSTONE_AUTH_ISSUER_E2E = 'account-deleted-tombstone';
export const TOMBSTONE_DISPLAY_NAME_E2E = '(deleted account)';
export const TOMBSTONE_IDENTITY_HEX_E2E =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// THE 40-entry data-lifecycle transcription (schema.rs DATA_LIFECYCLE_MANIFEST
// + the S6 typespace walk's identity-column names), one biome-stable string:
// entries sorted by table, `table:Policy[(parent)]:col1+col2:1|0`, '|'-joined.
// Erase/Anonymize entries MUST carry >=1 column (red-team CRITICAL-1: a
// zero-column entry is an UNATTEMPTED table, invisible to the vacuity list).
export const M22S9_MANIFEST_TRANSCRIPTION =
  'account:Anonymize:claimed_from+identity:1|account_deletion_reaper_schedule:NotOwned::0|battle:Anonymize:opponent_identity+player_identity:1|battle_action:Erase:player_identity:1|battle_challenge:Erase:challenger+target:1|battle_challenge_reaper_schedule:ViaJoin(battle_challenge)::0|battle_wild:ViaJoin(battle)::0|character:ViaJoin(player)::1|config:NotOwned::0|encounter:NotOwned::0|evolution_path:NotOwned::0|export_bundle:Erase:owner_identity:0|guest_claim:NotOwned::0|guest_claim_reaper_schedule:NotOwned::0|heal_cooldown:Erase:owner_identity:1|heal_location_row:NotOwned::0|inventory:Erase:owner_identity:1|item_row:NotOwned::0|monster:Erase:owner_identity:1|monster_pub:Erase:owner_identity:1|movement_tick_schedule:NotOwned::0|mr_heartbeat_schedule:NotOwned::0|npc:NotOwned::0|player:Anonymize:identity:1|player_conversation:Erase:owner_identity:1|player_dialogue_state:Erase:owner_identity:1|player_quest:Erase:owner_identity:1|player_wallet:Erase:owner_identity:1|playtest_event:Erase:identity:1|playtest_reaper_schedule:NotOwned::0|profile:Anonymize:identity:1|pvp_deadline_schedule:ViaJoin(battle)::0|shop_item_row:NotOwned::0|shop_row:NotOwned::0|skill_row:NotOwned::0|species_row:NotOwned::0|trade_offer:Erase:counterparty+initiator:1|trade_offer_reaper_schedule:ViaJoin(trade_offer)::0|type_relation_row:NotOwned::0|zone_def:NotOwned::0';

// Tables that may legitimately hold ZERO A-scoped rows at the pre-cascade
// snapshot, each with its measured reason. HARD-CAPPED — a fourth entry is a
// seeding regression, not an allowlist edit (red-team MEDIUM-8).
export const S9_VACUITY_ALLOWLIST = [
  [
    'battle_action',
    'enum column is not expressible in 2.8.1 SQL DML and the organic writer needs a live PvP turn with private skill knowledge; consumed at forfeit settle',
  ],
  [
    'pvp_deadline_schedule',
    'rows exist only for LIVE PvP battles and the cascade-time live battle of A is deliberately wild',
  ],
  [
    'player_dialogue_state',
    'Vec<String> columns are not expressible in 2.8.1 SQL DML (probed: 400) and no zone-0 organic writer fits the e2e budget',
  ],
];
export const S9_VACUITY_ALLOWLIST_CAP = 3;
// Independent seeded-rows floor: >500 playtest_event rows plus the rest of the
// loaded account. A run that seeded nothing cannot reach this sum.
export const S9_SEEDED_FLOOR = 520;

// The S9 driver milestone roster (strict: exact set, this order, all ok:true,
// no unknown S9- steps, no duplicates — red-team HIGH-5).
export const S9_MILESTONES = [
  'S9-D-join',
  'S9-A-join',
  'S9-challenge1',
  'S9-accept1',
  'S9-battle1-live',
  'S9-battle1-terminal',
  'S9-D-rejoin',
  'S9-presence-ready',
  'S9-trade-open',
  'S9-challenge2-pending',
  'S9-wild-live',
  'S9-seed-ready',
  'S9-export-chunks',
  'S9-delete',
  'S9-export-reject',
  'S9-cancel',
  'S9-cancel-done',
  'S9-redelete',
  'S9-redelete-done',
  'S9-terminal-seen',
  'S9-late-cancel',
  'S9-late-export',
  'S9-cascade-done',
  'S9-D-still-active',
  'S9-done',
];

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

/**
 * M22-S9 shared patcher core (ADR-0232 D1): replace `needle` with `replacement`
 * in `src`, throwing on ZERO occurrences (a silent no-op publishes a module
 * whose reaper fires in 7 days — the run reads as a 120 s terminal-poll hang)
 * AND on MORE THAN ONE (a decoy match could leave the real declaration
 * unpatched while the byte-diff guard stays satisfied — first-hit anchors are
 * forgeable). `label` names the failing patcher in the throw.
 */
export function patchSoleNeedle(src, needle, replacement, label) {
  if (typeof src !== 'string' || src.indexOf(needle) === -1) {
    throw new Error(
      label +
        ': the committed declaration is absent from the source — refusing to build an ' +
        'unpatched module (a no-op patch here waits out the real 7-day grace). Expected: ' +
        needle,
    );
  }
  if (src.indexOf(needle) !== src.lastIndexOf(needle)) {
    throw new Error(
      label +
        ': the declaration needle matches MORE THAN ONCE — a decoy occurrence could absorb ' +
        'the patch while the real constant stays live. Needle: ' +
        needle,
    );
  }
  return src.replace(needle, replacement);
}

/** Compress the deletion grace window in the tmpdir module copy (never the
 *  shipped tree) so the real one-shot reaper fires inside the e2e. */
export function patchDeletionGrace(src, graceMs) {
  if (!Number.isInteger(graceMs) || graceMs <= 0) {
    throw new Error('patchDeletionGrace: graceMs must be a positive integer, got ' + graceMs);
  }
  return patchSoleNeedle(
    src,
    GRACE_NEEDLE,
    'pub const DELETION_GRACE_MS_DEFAULT: i64 = ' + graceMs + ';',
    'patchDeletionGrace',
  );
}

/** Compress the export sub-chunk boundary in the tmpdir module copy so a
 *  3-row table forces a [2,1] multi-chunk split (chunks(K) vs one-per-row). */
export function patchExportChunkRows(src, rows) {
  if (!Number.isInteger(rows) || rows <= 0) {
    throw new Error('patchExportChunkRows: rows must be a positive integer, got ' + rows);
  }
  return patchSoleNeedle(
    src,
    CHUNK_NEEDLE,
    'pub const EXPORT_CHUNK_ROWS: u32 = ' + rows + ';',
    'patchExportChunkRows',
  );
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
  let v = String(s == null ? '' : s)
    .trim()
    .toLowerCase();
  // `spacetime sql` renders a present Option<Identity> as
  // "(some = (__identity__ = 0x<hex>))" and a bare Identity column as "0x<hex>".
  // Unwrap the wrapper to the inner hex so a stamped provenance value (the
  // `claimed_from` column) compares equal to a bare `toHexString()` identity.
  // Keyed on the wrapper marker so bare/short-hex cells are untouched. Literal
  // regex only (Semgrep detect-non-literal-regexp).
  if (v.indexOf('__identity__') !== -1) {
    const m = v.match(/0x[0-9a-f]+/);
    v = m ? m[0] : '';
  }
  return v.replace(/^0x/, '');
}

export function identityMatches(cell, hex) {
  const a = normHex(cell);
  const b = normHex(hex);
  return a !== '' && a === b;
}

// --- M22-S9 `sql --format json` cell decoders (loud on unknown shapes) ------

/** Identity cell from decodeSqlJson: ["0x.."], {"__identity__":..} or "0x..". */
export function identityCellHex(v) {
  if (typeof v === 'string') return normHex(v);
  if (Array.isArray(v) && v.length === 1) return normHex(String(v[0]));
  if (v !== null && typeof v === 'object' && v.__identity__ !== undefined) {
    return normHex(String(v.__identity__));
  }
  throw new Error('[s9/cell] unrecognized Identity cell: ' + JSON.stringify(v));
}

/** Option<i64> cell: number | {"some": n} | {"none": ..} | [0, n] | [1, ..]
 *  (the CLI renders a sum value positionally as [variantIndex, payload];
 *  Option declares `some` first, so index 0 IS some — observed live). */
export function optI64Cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
    if (v[0] === 0) return Number(v[1]);
    if (v[0] === 1) return null;
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (v.some !== undefined) return Number(v.some);
    if (v.none !== undefined) return null;
  }
  throw new Error('[s9/cell] unrecognized Option<i64> cell: ' + JSON.stringify(v));
}

/** Enum (unit-variant sum) cell: "tag" | {"tag": payload} | [idx, payload].
 *  The positional form carries no name, so the caller passes the declared
 *  variant-name order (from the table's own schema) to resolve it. */
export function enumTagCell(v, variants) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
    if (!Array.isArray(variants) || variants[v[0]] === undefined) {
      throw new Error(
        '[s9/cell] positional enum cell ' + JSON.stringify(v) + ' with no variant table',
      );
    }
    return variants[v[0]];
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const ks = Object.keys(v);
    if (ks.length === 1) return ks[0];
  }
  throw new Error('[s9/cell] unrecognized enum cell: ' + JSON.stringify(v));
}

/** Option<Identity> cell -> inner hex, or null when none/absent. */
export function optIdentityHex(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
    if (v[0] === 0) return identityCellHex(v[1]);
    if (v[0] === 1) return null;
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (v.none !== undefined) return null;
    if (v.some !== undefined) return identityCellHex(v.some);
  }
  return identityCellHex(v);
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
  let v = String(cell == null ? '' : cell).trim();
  // Option<i64> present renders as "(some = <digits>)"; unwrap to the digits so a
  // stamped `claimed_at_ms` reads as a timestamp. `(none)` has no `some` and stays
  // rejected. Literal regex only (Semgrep detect-non-literal-regexp).
  if (v.indexOf('some') !== -1) {
    const m = v.match(/[0-9]+/);
    v = m ? m[0] : '';
  }
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

  // E: a token minted with the CORRECT (patched) issuer but a WRONG audience
  // must be REFUSED at connect (AUTH-3). Unlike the wrong-ISSUER path (C), which
  // returns Ok and stays anonymous, the allowed-issuer + wrong-audience path
  // returns Err from client_connected, and the host drops the socket — a
  // stronger, more explicit signal. `E-rejected.ok === true` means the driver
  // observed `.onConnectError`/disconnect rather than `.onConnect`. This is the
  // D18/CRITICAL-2 single-client control: if audience_allowed were inert (or
  // later widened to a list), the connection would be ACCEPTED here instead.
  if (dataOf('E-rejected').rejected !== true) {
    return {
      ok: false,
      reason:
        'E connected with a CORRECT-issuer JWT but a WRONG audience and was NOT refused at ' +
        'connect — audience_allowed accepted a token minted for another application (AUTH-3). ' +
        'This is the D18/CRITICAL-2 single-client control: an issuer-valid token must never ' +
        'provision here regardless of who it was minted for',
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
 * `ids` = { a, b, c, d } hex identities.
 * Returns { ok, reason }.
 *
 * The "exactly 2 rows (A + D)" assertion subsumes the negative controls: C
 * (wrong issuer) connected anonymously and E (wrong audience) was refused at
 * connect, so neither may have an account row — any third row is a violation.
 * The explicit C check is kept as a clearer diagnostic; E has no identity
 * milestone to check against (it never connected), and the row-count bound
 * already forbids an E row.
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
        'issuer, anonymous) and E (wrong audience, refused at connect) must NEVER have ' +
        'provisioned one',
    };
  }
  if (account.some((r) => identityMatches(r[0], ids.c))) {
    return {
      ok: false,
      reason: 'an account row exists for C, whose JWT came from an issuer outside ALLOWED_ISSUERS',
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

// ===========================================================================
// M22-S9 pure deciders (ADR-0232). The rig moves bytes; these decide, and every
// decision is proven against BAD fixtures in phase 0 before being trusted.
// ===========================================================================

/**
 * Parse M22S9_MANIFEST_TRANSCRIPTION into entries. Format per entry:
 * `table:Policy[(parent)]:col1+col2:1|0`, '|'-joined, sorted by table. THROWS
 * on any malformation — a half-parsed manifest silently narrows the truth pass
 * (parse ambiguity is fatal, memory-card doctrine).
 */
export function parseManifestTranscription(s) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('[s9/transcription-parse] transcription is not a non-empty string');
  }
  const out = [];
  const seen = new Set();
  for (const raw of s.split('|')) {
    const parts = raw.split(':');
    if (parts.length !== 4) {
      throw new Error('[s9/transcription-parse] entry does not have exactly 4 `:` fields: ' + raw);
    }
    const [table, policyRaw, colsRaw, exportRaw] = parts;
    if (!/^[a-z0-9_]+$/.test(table)) {
      throw new Error('[s9/transcription-parse] bad table name: ' + raw);
    }
    if (seen.has(table)) {
      throw new Error('[s9/transcription-parse] duplicate table entry: ' + table);
    }
    seen.add(table);
    let policy = policyRaw;
    let parent = null;
    const paren = policyRaw.indexOf('(');
    if (paren !== -1) {
      if (!policyRaw.endsWith(')')) {
        throw new Error('[s9/transcription-parse] unclosed parent in: ' + raw);
      }
      policy = policyRaw.slice(0, paren);
      parent = policyRaw.slice(paren + 1, -1);
      if (!/^[a-z0-9_]+$/.test(parent)) {
        throw new Error('[s9/transcription-parse] bad ViaJoin parent in: ' + raw);
      }
    }
    if (['Erase', 'Anonymize', 'ViaJoin', 'NotOwned'].indexOf(policy) === -1) {
      throw new Error('[s9/transcription-parse] unknown policy in: ' + raw);
    }
    if (policy === 'ViaJoin' && parent === null) {
      throw new Error('[s9/transcription-parse] ViaJoin without a parent in: ' + raw);
    }
    if (policy !== 'ViaJoin' && parent !== null) {
      throw new Error('[s9/transcription-parse] parent on a non-ViaJoin policy in: ' + raw);
    }
    const cols = colsRaw === '' ? [] : colsRaw.split('+');
    for (const c of cols) {
      if (!/^[a-z0-9_]+$/.test(c)) {
        throw new Error('[s9/transcription-parse] bad column name in: ' + raw);
      }
    }
    if ((policy === 'Erase' || policy === 'Anonymize') && cols.length === 0) {
      // Red-team CRITICAL-1: a zero-column Erase/Anonymize entry is an
      // UNATTEMPTED table — no SQL count ever runs for it, and the vacuity
      // list (which sees only zero COUNTS) never hears about it.
      throw new Error('[s9/zero-owner-cols] Erase/Anonymize entry with no owner columns: ' + raw);
    }
    if (exportRaw !== '0' && exportRaw !== '1') {
      throw new Error('[s9/transcription-parse] exportable flag must be 0|1 in: ' + raw);
    }
    out.push({ table, policy, parent, cols, exportable: exportRaw === '1' });
  }
  return out;
}

/** Extract the single COUNT(*) AS n value from decodeSqlJson row objects. */
export function countFromRows(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0] !== 'object' ||
    rows[0] === null
  ) {
    throw new Error(
      '[s9/count-shape] COUNT query did not return exactly one row: ' + JSON.stringify(rows),
    );
  }
  const n = Number(rows[0].n);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      '[s9/count-shape] COUNT value is not a non-negative number: ' + JSON.stringify(rows[0]),
    );
  }
  return n;
}

/**
 * Find the FIRST milestone event with `step === name` in a (possibly partial)
 * NDJSON stream. Non-JSON noise and a truncated trailing line are skipped; a
 * malformed line never masks a later well-formed one.
 */
export function findS9Event(text, name) {
  for (const line of String(text == null ? '' : text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev !== null && typeof ev === 'object' && ev.step === name) return ev;
  }
  return null;
}

/**
 * STRICT S9 milestone verdict (red-team HIGH-5 shape): the S9-prefixed events
 * must be EXACTLY the roster — same set, same order, each ok:true, no
 * duplicates, no unknown S9 step — and NO event anywhere in the whole stream
 * (G22 legs included) may carry ok:false. `exitCode` must be exactly 0: a
 * driver that crashes after its last milestone is a broken run, not a green one.
 */
export function checkS9Milestones(events, exitCode) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: '[s9/milestones] driver emitted no milestones at all' };
  }
  for (const e of events) {
    if (e === null || typeof e !== 'object' || typeof e.step !== 'string') continue;
    if (e.ok !== true) {
      const err = e.data && e.data.err ? ' — ' + e.data.err : '';
      return { ok: false, reason: '[s9/milestones] event ' + e.step + ' reported failure' + err };
    }
  }
  const s9 = events.filter((e) => e && typeof e.step === 'string' && e.step.startsWith('S9-'));
  const names = s9.map((e) => e.step);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    return { ok: false, reason: '[s9/milestones] duplicate S9 milestone(s): ' + dupes.join(',') };
  }
  if (names.join('|') !== S9_MILESTONES.join('|')) {
    return {
      ok: false,
      reason:
        '[s9/milestones] S9 stream is not exactly the roster in order. got: ' +
        names.join(' -> ') +
        ' ; expected: ' +
        S9_MILESTONES.join(' -> '),
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      reason: '[s9/driver-exit] driver exited ' + String(exitCode) + ', expected 0',
    };
  }
  const dataOf = (step) => {
    const e = s9.find((x) => x.step === step);
    return e && e.data && typeof e.data === 'object' ? e.data : {};
  };
  return { ok: true, reason: 'all ' + S9_MILESTONES.length + ' S9 milestones asserted', dataOf };
}

/**
 * Export-assembly verdict (PRV1-11/12/13, ADR-0232). `chunks` = driver digests
 * [{t, i, n, req, rows, seedField}] where rows === -1 means payload_json failed
 * a STRICT JSON.parse (red-team MEDIUM-9: a malformed export must fail here
 * even when its row count would coincidentally reconcile). `expected` = {
 * exportableTables, chunkRows, sqlCounts } with sqlCounts = the SQL-observed
 * A-scoped row count per exportable table at export time.
 */
export function checkExportAssembly(chunks, expected) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { ok: false, reason: '[s9/export-empty] no export chunks observed' };
  }
  const reqs = new Set(chunks.map((c) => String(c.req)));
  if (reqs.size !== 1) {
    return {
      ok: false,
      reason: '[s9/export-request-id] expected one request_id, got ' + reqs.size,
    };
  }
  const n = chunks.length;
  const idx = chunks.map((c) => c.i).sort((a, b) => a - b);
  for (let k = 0; k < n; k++) {
    if (idx[k] !== k) {
      return {
        ok: false,
        reason:
          '[s9/export-contiguity] chunk_index multiset is not exactly 0..' +
          (n - 1) +
          ' (got ' +
          idx.join(',') +
          ')',
      };
    }
  }
  for (const c of chunks) {
    if (c.n !== n) {
      return {
        ok: false,
        reason: '[s9/export-total] chunk ' + c.i + ' says total_chunks=' + c.n + ', observed ' + n,
      };
    }
    if (c.rows === -1) {
      return {
        ok: false,
        reason:
          '[s9/export-parse] chunk ' + c.i + ' (' + c.t + ') payload_json failed strict JSON.parse',
      };
    }
    if (c.seedField === true) {
      return {
        ok: false,
        reason:
          '[s9/export-seed-leak] chunk ' +
          c.i +
          ' (' +
          c.t +
          ') carries a `seed` field — the battle_wild individuality seed must never be exportable',
      };
    }
  }
  const got = new Set(chunks.map((c) => c.t));
  const want = new Set(expected.exportableTables);
  for (const t of want) {
    if (!got.has(t))
      return { ok: false, reason: '[s9/export-missing-table] no chunk for exportable table ' + t };
  }
  for (const t of got) {
    if (!want.has(t))
      return {
        ok: false,
        reason: '[s9/export-extra-table] chunk exists for NON-exportable table ' + t,
      };
  }
  // Per-table: chunk_index order, non-final chunks exactly full, final 1..=K,
  // and the reassembled row count reconciles with the SQL-observed count.
  let sawMultiChunk = false;
  for (const t of want) {
    const mine = chunks.filter((c) => c.t === t).sort((a, b) => a.i - b.i);
    if (mine.length > 1) sawMultiChunk = true;
    for (let k = 0; k < mine.length; k++) {
      const isFinal = k === mine.length - 1;
      const r = mine[k].rows;
      if (!isFinal && r !== expected.chunkRows) {
        return {
          ok: false,
          reason:
            '[s9/export-chunk-fill] non-final chunk of ' +
            t +
            ' holds ' +
            r +
            ' row(s), expected exactly ' +
            expected.chunkRows +
            ' — a one-chunk-per-row split is not chunks(K)',
        };
      }
      if (isFinal && (r < 0 || r > expected.chunkRows || (mine.length > 1 && r === 0))) {
        return {
          ok: false,
          reason: '[s9/export-chunk-fill] final chunk of ' + t + ' holds ' + r + ' row(s)',
        };
      }
    }
    const total = mine.reduce((acc, c) => acc + c.rows, 0);
    const sqlN = expected.sqlCounts[t];
    if (typeof sqlN !== 'number') {
      return {
        ok: false,
        reason: '[s9/export-reconcile] no SQL-observed count for exportable table ' + t,
      };
    }
    if (total !== sqlN) {
      return {
        ok: false,
        reason:
          '[s9/export-reconcile] ' +
          t +
          ' reassembles to ' +
          total +
          ' row(s) but SQL observed ' +
          sqlN,
      };
    }
  }
  if (!sawMultiChunk) {
    return {
      ok: false,
      reason:
        '[s9/export-no-split] no table spanned >=2 chunks — the sub-chunk boundary was never exercised (PRV1-13 vacuous)',
    };
  }
  return {
    ok: true,
    reason:
      'export assembled: ' +
      n +
      ' chunks across ' +
      want.size +
      ' tables, one request, contiguous, reconciled',
  };
}

/**
 * The post-cascade truth verdict (M22 §7.3). Every input is plain data built
 * by the rig; this function only decides. See ADR-0232 D4/D5 for the derivation
 * and non-vacuity contract. Returns { ok, reason, vacuous, detail }.
 */
export function checkCascadeTruth(input) {
  const { entries, pre, post, allowlist, allowlistCap, seededFloor, graceMs } = input;
  const fail = (reason) => ({ ok: false, reason, vacuous: [], detail: '' });
  if (!Array.isArray(entries) || entries.length !== 40) {
    return fail(
      '[s9/census] transcription entries: ' + (entries ? entries.length : 'none') + ', expected 40',
    );
  }
  if (!Array.isArray(allowlist) || allowlist.length > allowlistCap) {
    return fail('[s9/allowlist-cap] vacuity allowlist exceeds its cap of ' + allowlistCap);
  }
  for (const [t, why] of allowlist) {
    if (typeof why !== 'string' || why.length < 10) {
      return fail('[s9/allowlist-reason] allowlist entry ' + t + ' has no substantive reason');
    }
  }
  const allowed = new Set(allowlist.map(([t]) => t));
  const vacuous = [];
  let seededSum = 0;
  const anonymizeHandled = new Set(['account', 'player', 'profile', 'battle']);

  for (const e of entries) {
    if (e.policy === 'Erase') {
      let preSum = 0;
      for (const c of e.cols) {
        const postN = post.aCounts[e.table] ? post.aCounts[e.table][c] : undefined;
        const preN = pre.aCounts[e.table] ? pre.aCounts[e.table][c] : undefined;
        if (typeof postN !== 'number' || typeof preN !== 'number') {
          return fail(
            '[s9/unattempted] no count was taken for ' +
              e.table +
              '.' +
              c +
              ' — an unattempted table is not a verified one',
          );
        }
        if (postN !== 0) {
          return fail(
            '[s9/erase-survivor] ' +
              e.table +
              '.' +
              c +
              ' still holds ' +
              postN +
              ' row(s) for the deleted identity',
          );
        }
        preSum += preN;
      }
      seededSum += preSum;
      if (preSum === 0) vacuous.push(e.table);
    } else if (e.policy === 'ViaJoin') {
      const postN = post.viaJoin[e.table];
      const preN = pre.viaJoin[e.table];
      if (typeof postN !== 'number' || typeof preN !== 'number') {
        return fail(
          '[s9/unattempted] no reachability count was taken for ViaJoin table ' + e.table,
        );
      }
      if (postN !== 0) {
        return fail(
          '[s9/viajoin-live] ' +
            e.table +
            ' still reachable via the deleted parent (' +
            postN +
            ' row(s))',
        );
      }
      seededSum += preN;
      if (preN === 0) vacuous.push(e.table);
    } else if (e.policy === 'Anonymize') {
      if (!anonymizeHandled.has(e.table)) {
        return fail(
          '[s9/anonymize-unhandled] a NEW Anonymize table (' +
            e.table +
            ') has no special-cased truth assert — write one before trusting this run',
        );
      }
    }
  }

  // Anonymize special cases — the row must SURVIVE and carry the tombstone.
  const acct = post.account;
  if (!acct || acct.present !== true)
    return fail('[s9/account-tombstone] the account row is GONE — Anonymize must never delete');
  if (acct.authIssuer !== TOMBSTONE_AUTH_ISSUER_E2E) {
    return fail(
      '[s9/account-tombstone] auth_issuer is ' +
        JSON.stringify(acct.authIssuer) +
        ', expected the tombstone sentinel',
    );
  }
  if (typeof acct.terminal !== 'number' || typeof acct.requested !== 'number') {
    return fail('[s9/account-tombstone] terminal_at_ms/deletion_requested_at_ms not both stamped');
  }
  if (acct.status !== 'pendingDeletion') {
    return fail(
      '[s9/account-tombstone] status is ' +
        JSON.stringify(acct.status) +
        ', expected pendingDeletion',
    );
  }
  if (acct.claimRetained !== true) {
    return fail(
      '[s9/account-provenance] claimed_from/claimed_at_ms were not retained through the cascade (AUTH-29)',
    );
  }
  if (acct.terminal - acct.requested < graceMs) {
    return fail(
      '[s9/grace-honored] terminal - requested = ' +
        (acct.terminal - acct.requested) +
        ' ms < the ' +
        graceMs +
        ' ms grace — the reaper fired before the (re-armed) request was due',
    );
  }
  if (
    !post.player ||
    post.player.present !== true ||
    post.player.name !== TOMBSTONE_DISPLAY_NAME_E2E
  ) {
    return fail(
      '[s9/player-tombstone] the player presence row (A is still connected) is missing or not tombstoned: ' +
        JSON.stringify(post.player),
    );
  }
  if (
    !post.profile ||
    post.profile.present !== true ||
    post.profile.name !== TOMBSTONE_DISPLAY_NAME_E2E
  ) {
    return fail(
      '[s9/profile-tombstone] the profile row is missing or not tombstoned: ' +
        JSON.stringify(post.profile),
    );
  }
  if (!post.battle1 || post.battle1.present !== true) {
    return fail(
      '[s9/battle-anonymize] the terminal PvP battle row is GONE — Anonymize must never delete',
    );
  }
  if (post.battle1.aSideTombstoned !== true) {
    return fail(
      '[s9/battle-anonymize] the deleted side of the terminal battle was not swapped to the tombstone identity',
    );
  }
  if (post.battle1.dSideIntact !== true) {
    return fail(
      '[s9/battle-anonymize] the SURVIVING side of the terminal battle changed — over-anonymization is a failure, not a pass',
    );
  }

  // NotOwned world content must SURVIVE (an erase-everything cascade would
  // otherwise pass every A-scoped zero-count above).
  if (
    !post.world ||
    !(post.world.species > 0) ||
    !(post.world.zones > 0) ||
    post.world.config !== 1
  ) {
    return fail(
      '[s9/world-nuked] seeded world content did not survive the cascade: ' +
        JSON.stringify(post.world),
    );
  }
  // Bystander: D's rows byte-count-identical across the snapshot window, and D
  // never entered the deletion state machine.
  const preD = JSON.stringify(pre.dCounts);
  const postD = JSON.stringify(post.dCounts);
  if (preD !== postD) {
    return fail(
      '[s9/bystander] the bystander account rows changed across the cascade: pre=' +
        preD +
        ' post=' +
        postD,
    );
  }
  if (post.dAccountActive !== true) {
    return fail(
      '[s9/bystander] the bystander account is not Active/terminal-free after the cascade',
    );
  }

  for (const t of vacuous) {
    if (!allowed.has(t)) {
      return fail(
        '[s9/vacuous] ' +
          t +
          ' had ZERO pre-cascade rows for the subject and is not on the declared allowlist — the run never actually tested its erasure. vacuous=' +
          JSON.stringify(vacuous),
      );
    }
  }
  if (seededSum < seededFloor) {
    return fail(
      '[s9/seed-floor] only ' +
        seededSum +
        ' subject-scoped rows existed pre-cascade (floor ' +
        seededFloor +
        ') — the loaded-account seed did not happen',
    );
  }
  return {
    ok: true,
    reason: 'cascade truth held over 40 classified entries',
    vacuous,
    detail: 'seeded=' + seededSum + ' vacuous=[' + vacuous.join(',') + ']',
  };
}

/**
 * Build the owner-SQL seed statements for the subject (pure — the rig executes
 * them). >500 playtest_event rows (batched) + wallet + inventory + conversation
 * + quest + heal_cooldown. player_dialogue_state is NOT here (Vec<String>
 * columns are not DML-expressible — probed 400; declared on the vacuity
 * allowlist instead).
 */
export function buildSeedStatements(aHex, playtestRows, baseMs) {
  if (typeof aHex !== 'string' || !/^0x[0-9a-f]{64}$/.test(aHex)) {
    throw new Error('[s9/seed-build] subject identity is not 0x + 64 lowercase hex: ' + aHex);
  }
  if (!Number.isInteger(playtestRows) || playtestRows <= 500) {
    throw new Error(
      '[s9/seed-build] playtestRows must exceed 500 (the loaded-account brief), got ' +
        playtestRows,
    );
  }
  // The stamp must be NEAR NOW (injected): an epoch-adjacent created_at_ms puts
  // every seeded row past the ADR-0131 playtest-event TTL, and the periodic
  // playtest reaper would then erase the seed MID-RUN — a count collapse that
  // reads as a cascade bug instead of a fixture bug.
  if (!Number.isInteger(baseMs) || baseMs < 1_000_000_000_000) {
    throw new Error('[s9/seed-build] baseMs must be a modern epoch-ms stamp, got ' + baseMs);
  }
  const stmts = [];
  // The three PK-on-owner tables are DELETE-then-INSERT: the subject may already
  // own a row (e.g. the wallet re-keyed onto A by the G22 guest claim), and SQL
  // DML has no upsert.
  stmts.push('DELETE FROM player_wallet WHERE owner_identity = ' + aHex);
  stmts.push('DELETE FROM heal_cooldown WHERE owner_identity = ' + aHex);
  stmts.push('DELETE FROM player_conversation WHERE owner_identity = ' + aHex);
  stmts.push('INSERT INTO player_wallet (owner_identity, balance) VALUES (' + aHex + ', 500)');
  stmts.push(
    'INSERT INTO inventory (inv_id, owner_identity, item_id, count) VALUES ' +
      '(0, ' +
      aHex +
      ', 1, 2), (0, ' +
      aHex +
      ', 2, 1), (0, ' +
      aHex +
      ', 3, 1)',
  );
  stmts.push(
    'INSERT INTO player_conversation (owner_identity, npc_entity_id, current_node_id) VALUES (' +
      aHex +
      ', 7, ' +
      "'s9_node'" +
      ')',
  );
  stmts.push(
    'INSERT INTO player_quest (pq_id, owner_identity, quest_id, step_index) VALUES (0, ' +
      aHex +
      ', ' +
      "'quest_001'" +
      ', 1)',
  );
  stmts.push(
    'INSERT INTO heal_cooldown (owner_identity, last_heal_at_ms) VALUES (' + aHex + ', 1)',
  );
  const batch = 50;
  let emitted = 0;
  while (emitted < playtestRows) {
    const rows = [];
    for (let i = 0; i < batch && emitted < playtestRows; i++, emitted++) {
      rows.push('(0, ' + aHex + ', 1, ' + (baseMs + emitted) + ', 0, 1, 500, 0, true)');
    }
    stmts.push(
      'INSERT INTO playtest_event (event_id, identity, kind, created_at_ms, battle_id, species_id, hp_permille, bait_item_id, success) VALUES ' +
        rows.join(', '),
    );
  }
  return stmts;
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
    { step: 'E-rejected', ok: true, data: { rejected: true } },
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

const GOOD_IDS = { a: GOOD_ID_A, b: GOOD_ID_B, c: GOOD_ID_C, d: GOOD_ID_D };

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
  return linesWithout(GOOD_RUNBOOK_LINES, pred);
}

// Rewrite ONLY the lines above the appendix, so every BAD fixture leaves the
// decoy section intact. That is what makes each fixture a section-scoping test
// rather than a "does the word appear anywhere" test.
function runbookMapBeforeAppendix(fn) {
  return linesMapBefore(GOOD_RUNBOOK_LINES, APPENDIX_HEADING, fn);
}

// --- G24: the DR runbook's data-deletion & backup-retention section --------
//
// M22 PRV1-18: the runbook must carry a `## Data deletion & backup retention`
// section, and a reword of it must fail CI. Deliberately NOT a re-derivation
// of Rust semantics (ADR-0224 retired that class): every check below is
// either an exact-sentence pin, a value equality against the SSOT constant,
// or a "does the identifier this document cites still exist as a sole
// declaration" citation resolution. None of them decides what the code DOES.

// The heading phrase `extractSection` scopes on. Kept as one constant so the
// checker and any future caller cannot drift to different spellings.
export const DELETION_SECTION_HEADING_PHRASE = 'Data deletion & backup retention';

// Spec §9 residual risk 1, required-exact language.
//
// QUOTE STYLE IS NOT COSMETIC HERE. biome's `quoteStyle: "single"` applies a
// fewer-escapes heuristic, so it leaves PIN_BACKUP_LIMIT (which contains
// apostrophes) double-quoted and rewrites this one, which contains none, to
// single. Either way neither pin may acquire a `\\` escape: a formatter
// escaping an apostrophe has silently truncated a text pin in this repo
// before. That is what the no-backslash and exact-length teeth enforce —
// the quote character itself is left to the formatter.
export const PIN_PSEUDONYMIZATION =
  'Direct name/display fields are severed on deletion. The `Identity` key and its associated timestamps/behavioral history are not purged from multi-user or historical rows; this is a documented, accepted pseudonymization limitation, not erasure.';

// Spec §9 residual risk 2 — the PRV1-18 core, the sentence the spec calls
// "pinned and exact-body-checked in the DR runbook". It names
// `DELETION_GRACE_MS`, a symbol that does NOT exist (the real one is
// `DELETION_GRACE_MS_DEFAULT`). That is not a typo to fix: this is
// required-exact language quoted as such, and the runbook names the real
// spelling in the very next sentence. See ADR-0230.
export const PIN_BACKUP_LIMIT =
  "Deletion is guaranteed for the module's live queryable state within `DELETION_GRACE_MS` of the request. Host-level backups, snapshots, and WAL are outside the module's reach; point-in-time recovery can restore deleted data until the operator's backup-retention window elapses. This module makes no claim about backup or replica state.";

// The four real source files clause 2 and clause 5 read. Named once.
export const DELETION_SOURCE_ACCOUNTS = 'server-module/src/accounts.rs';
export const DELETION_SOURCE_SCHEMA = 'server-module/src/schema.rs';
export const DELETION_SOURCE_PRIVACY = 'server-module/src/privacy.rs';
export const DELETION_SOURCE_GRACE = 'game-core/src/accounts/deletion.rs';

// Citation roster: every code identifier the runbook section names, paired
// with the file it lives in and its DECLARATION-shaped marker.
//
// Declaration-shaped, never the bare identifier: measured on this tree, every
// bare name here occurs 2-3 times in its own file after comment stripping
// (attribute arguments, string literals, type positions), so a bare-name
// uniqueness check would red on day one — and the natural "fix" for that red
// is loosening exactly-one to at-least-one, which reopens the decoy-twin
// bypass the uniqueness check exists to close.
//
// `DELETION_GRACE_MS_DEFAULT` is deliberately ABSENT: clause 2 already binds
// it through `parseGraceConst`, which pins its VALUE and not merely its
// presence. Listing it here as well would re-verify, more weakly, something
// another clause already proves.
export const DELETION_CITATIONS = [
  {
    symbol: 'account_deletion_reaper',
    file: DELETION_SOURCE_ACCOUNTS,
    marker: 'pub fn account_deletion_reaper(',
  },
  {
    symbol: 'AccountDeletionReaperSchedule',
    file: DELETION_SOURCE_ACCOUNTS,
    marker: 'pub struct AccountDeletionReaperSchedule',
  },
  { symbol: 'export_bundle', file: DELETION_SOURCE_SCHEMA, marker: 'accessor = export_bundle)' },
  {
    symbol: 'DATA_LIFECYCLE_MANIFEST',
    file: DELETION_SOURCE_SCHEMA,
    marker: 'pub const DATA_LIFECYCLE_MANIFEST',
  },
  {
    symbol: 'my_export_bundle',
    file: DELETION_SOURCE_PRIVACY,
    marker: 'accessor = my_export_bundle,',
  },
];

/**
 * Normalize markdown prose for substring pinning: drop HTML comments, then
 * collapse every whitespace run to one space.
 *
 * COMPLEXITY CAVEAT: the comment strip is roughly O(n^2) on pathological
 * input (measured: ~6 s for 100k unclosed HTML-comment openers). The only
 * caller feeds it a committed file, so nothing untrusted reaches it — but
 * bound the input before reusing this on text you did not commit.
 *
 * ALL THREE replacements are load-bearing. Dropping comments first closes a measured
 * bypass class in this repo — a needle present ONLY inside `<!-- ... -->`
 * renders as nothing to a human but satisfies a raw `indexOf`, which lets an
 * editor comment out the real disclaimer with the gate still green. Collapsing
 * whitespace is what lets the two exact-sentence pins survive a markdown
 * re-wrap, so an editor reflowing a paragraph is not a false RED.
 */
export function squashDocText(text) {
  return String(text == null ? '' : text)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^ {0,3}```[\s\S]*?^ {0,3}```/gm, ' ')
    .split(/\s+/)
    .join(' ')
    .trim();
}

/**
 * Render a decimal digit string with Rust's `_` thousands grouping
 * (`604800000` -> `604_800_000`), so clause 2 can look for the value the way
 * the source declares it and the runbook writes it.
 *
 * DELIBERATE: only the grouped spelling is accepted. The ungrouped form is a
 * different string and would be a second, unpinned way to satisfy the clause;
 * one spelling, pinned, is the point.
 */
export function groupThousands(digits) {
  const s = String(digits);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '_';
    out += s[i];
  }
  return out;
}

// Own-property read: a `sources` object is caller-supplied, so an inherited
// `Object.prototype` key must never satisfy a citation lookup.
function ownSource(sources, file) {
  if (sources === null || typeof sources !== 'object') return undefined;
  if (!Object.hasOwn(sources, file)) return undefined;
  const text = sources[file];
  return typeof text === 'string' ? text : undefined;
}

/**
 * Resolve every roster entry to exactly ONE declaration in the file the
 * runbook cites it from. `sources` is a `{path: text}` map so the resolution
 * is pure and fixture-testable; `readDeletionCitationSources()` builds the
 * real one.
 *
 * This is a citation check, not semantic inference (ADR-0224): it answers only
 * "does the identifier this document names still exist, once, as a declaration,
 * in the file the document names" — the question a broken-link checker answers.
 * Its verdict is invariant under any behavioural change that preserves the
 * declarations.
 *
 * Fails LOUD in all three degenerate directions — an empty roster, a missing
 * or non-string source, and zero matches are each an explicit failure, never
 * a skip and never a default.
 */
export function resolveDeletionCitations(sources) {
  const total = Array.isArray(DELETION_CITATIONS) ? DELETION_CITATIONS.length : 0;
  if (total === 0) {
    return {
      ok: false,
      resolved: 0,
      total: 0,
      reason:
        'clause 5: FAIL-LOUD: the citation roster is empty — every citation check below would ' +
        'pass vacuously over zero entries',
    };
  }
  let resolved = 0;
  for (const { symbol, file, marker } of DELETION_CITATIONS) {
    const src = ownSource(sources, file);
    if (src === undefined || src.length === 0) {
      return {
        ok: false,
        resolved,
        total,
        reason:
          `clause 5: FAIL-LOUD: no source text for ${file} (cited for \`${symbol}\`) — an ` +
          'unreadable source must read exactly like a citation that resolves to zero hits, ' +
          'never like one that resolved',
      };
    }
    let at;
    try {
      at = requireSoleDefinition(stripRustComments(src), marker);
    } catch (err) {
      return {
        ok: false,
        resolved,
        total,
        reason:
          `clause 5: \`${symbol}\` is ambiguous in ${file} — ${err?.message ?? String(err)}. A ` +
          'decoy twin must never let a first-hit search bind the wrong declaration',
      };
    }
    if (at === -1) {
      return {
        ok: false,
        resolved,
        total,
        reason:
          `clause 5: FAIL-LOUD: the runbook cites \`${symbol}\` but ${file} carries no ` +
          `\`${marker}\` declaration — the document is citing a symbol that no longer exists`,
      };
    }
    resolved++;
  }
  return { ok: true, resolved, total, reason: `${resolved}/${total} citations resolved` };
}

/**
 * G24. Scope to the ONE `## ...Data deletion & backup retention...` section
 * (never a whole-document fallback — `extractSection` throws on absent or
 * duplicate headings) and evaluate six clauses against its squashed body.
 *
 * `clausesMet` is returned so the caller reports a DERIVED count rather than
 * claiming one.
 */
export function checkDrRunbookDeletionSection(text, sources) {
  let sec;
  try {
    sec = extractSection(text, DELETION_SECTION_HEADING_PHRASE, '## ');
  } catch (err) {
    return {
      ok: false,
      clausesMet: 0,
      resolved: 0,
      reason: `FAIL-LOUD: ${err?.message ?? String(err)}`,
    };
  }
  const body = squashDocText(sec.body);
  const miss = (clausesMet, reason) => ({ ok: false, clausesMet, resolved: 0, reason });

  // clause 1a — spec §9 residual 1, verbatim. The single most misleading
  // possible edit to this section is deleting the words "not erasure".
  if (body.indexOf(squashDocText(PIN_PSEUDONYMIZATION)) === -1) {
    return miss(
      0,
      'clause 1a: the pseudonymization sentence (spec §9 residual 1) is not present verbatim in ' +
        'the section — a player-facing promise of erasure this module does not deliver',
    );
  }
  // clause 1b — spec §9 residual 2, verbatim. This is PRV1-18's core.
  if (body.indexOf(squashDocText(PIN_BACKUP_LIMIT)) === -1) {
    return miss(
      1,
      'clause 1b: the backup-limitation sentence (spec §9 residual 2) is not present verbatim in ' +
        'the section — the one statement bounding what deletion means against host backups',
    );
  }

  // clause 2 — the grace window, tied to the SSOT constant rather than to a
  // literal typed here: name, value, and the derived whole-day figure.
  const graceSrc = ownSource(sources, DELETION_SOURCE_GRACE);
  if (graceSrc === undefined) {
    return miss(
      2,
      `clause 2: FAIL-LOUD: no source text for ${DELETION_SOURCE_GRACE} — the grace window ` +
        'cannot be checked against its declaration, so it must not be reported as checked',
    );
  }
  let graceMs;
  try {
    graceMs = parseGraceConst(graceSrc);
  } catch (err) {
    return miss(2, `clause 2: FAIL-LOUD: ${err?.message ?? String(err)}`);
  }
  if (body.indexOf('DELETION_GRACE_MS_DEFAULT') === -1) {
    return miss(
      2,
      'clause 2: the section never names `DELETION_GRACE_MS_DEFAULT` — an operator retuning the ' +
        'grace window cannot find the constant this section is describing',
    );
  }
  const grouped = groupThousands(graceMs.toString());
  if (body.indexOf(grouped) === -1) {
    return miss(
      2,
      `clause 2: the section does not state the grace window as \`${grouped}\` ms — the value ` +
        `must equal ${DELETION_SOURCE_GRACE}'s own declaration, not merely look like a number`,
    );
  }
  const MS_PER_DAY = 86400000n;
  if (graceMs % MS_PER_DAY !== 0n) {
    return miss(
      2,
      `clause 2: FAIL-LOUD: the grace window (${graceMs} ms) is not a whole number of days, so ` +
        'the day figure this clause pins cannot be derived — retune the check, do not guess',
    );
  }
  const dayNeedle = `${graceMs / MS_PER_DAY} days`;
  if (body.indexOf(dayNeedle) === -1) {
    return miss(
      2,
      `clause 2: the section does not state the grace window as \`${dayNeedle}\` — the human ` +
        'figure is derived from the constant, so a stale one contradicts the ms value beside it',
    );
  }

  // clause 3 — the reaper an operator has to find and reason about.
  for (const needle of [
    'account_deletion_reaper',
    'AccountDeletionReaperSchedule',
    'one-shot',
    're-arm',
  ]) {
    if (body.indexOf(needle) === -1) {
      return miss(
        3,
        `clause 3: the deletion reaper is under-documented — the section never says \`${needle}\`; ` +
          'the reducer name, its schedule table, and the one-shot/re-arm cadence are all things ' +
          'an operator needs before touching a pending deletion',
      );
    }
  }

  // clause 4 — export bundles as LANDED. `no independent TTL` and `S4b` are
  // the honest half: the PRV1-14 reaper is deferred, so a bundle outlives the
  // export request and lands in every subsequent backup.
  for (const needle of ['export_bundle', 'my_export_bundle', 'no independent TTL', 'S4b']) {
    if (body.indexOf(needle) === -1) {
      return miss(
        4,
        `clause 4: export-bundle retention is under-documented — the section never says ` +
          `\`${needle}\`; without it the doc implies an expiry that does not exist`,
      );
    }
  }

  // clause 5 — every cited identifier still resolves to a sole declaration.
  const cites = resolveDeletionCitations(sources);
  if (!cites.ok) {
    return { ok: false, clausesMet: 5, resolved: cites.resolved, reason: cites.reason };
  }

  return {
    ok: true,
    clausesMet: 6,
    resolved: cites.resolved,
    reason: `6/6 clauses, ${cites.resolved}/${cites.total} citations resolved`,
  };
}

/**
 * Read the four real source files clause 2 and clause 5 resolve against.
 * THROWS on any read failure — the imperative half is deliberately tiny and
 * kept out of the pure checker so every clause stays fixture-testable.
 */
export function readDeletionCitationSources() {
  const files = [
    DELETION_SOURCE_ACCOUNTS,
    DELETION_SOURCE_SCHEMA,
    DELETION_SOURCE_PRIVACY,
    DELETION_SOURCE_GRACE,
  ];
  const out = Object.create(null);
  for (const file of files) {
    if (!existsSync(file)) {
      throw new Error(`readDeletionCitationSources: ${file} is missing`);
    }
    out[file] = readFileSync(file, 'utf8');
  }
  return out;
}

// ===========================================================================
// G24 GATING TEETH (M22 PRV1-18, EARS: docs/observability-dr-runbook.md must
// carry a "## 9. Data deletion & backup retention" section). TESTER-AUTHORED
// — do not add checker functions or the doc section here; those are the
// implementer's half of this contract. This whole block is RED until:
//   export const PIN_PSEUDONYMIZATION
//   export const PIN_BACKUP_LIMIT
//   export const DELETION_CITATIONS
//   export function squashDocText(text)
//   export function resolveDeletionCitations(sources)
//   export function checkDrRunbookDeletionSection(text, sources)
//   export function readDeletionCitationSources()
// all exist in THIS file, ABOVE this block (same convention as the
// ERR_INVALID_CODE / ISSUER_NEEDLE "contract constants" and the G23 checker
// functions above) — this block references every one of those names as a
// bare identifier, never via import, because they live in this same module.
//

// ---------------------------------------------------------------------------
// A. Generalized fixture helpers (parameterized forms of G23's
// runbookWithout / runbookMapBeforeAppendix). G24 needs the SAME shape over
// a DIFFERENT synthetic document, so the logic is pulled out once here and
// both G23 and G24 call the generalized form — never two copies of the same
// filter/map that could quietly drift apart.
// ---------------------------------------------------------------------------

export function linesWithout(lines, pred) {
  return lines.filter((l) => !pred(l)).join('\n');
}

// Rewrites only the lines strictly BEFORE `marker` (the appendix heading),
// so every caller's decoy appendix survives untouched — see G23's own
// comment on why that is what makes a fixture a section-scoping proof.
export function linesMapBefore(lines, marker, fn) {
  const at = lines.indexOf(marker);
  return lines.map((l, i) => (i < at ? fn(l) : l)).join('\n');
}

// ---------------------------------------------------------------------------
// B. G24's own synthetic runbook, with its OWN decoy appendix.
// ---------------------------------------------------------------------------
//
// The decoy appendix duplicates EVERY needle every G24 clause tests: both
// pinned sentences verbatim, DELETION_GRACE_MS_DEFAULT, 604_800_000, "7
// days", account_deletion_reaper, AccountDeletionReaperSchedule, "one-shot",
// "re-arm", export_bundle, my_export_bundle, "no independent TTL", S4b. A
// checker that scans the whole document instead of the extracted section
// still finds every one of these; only a section-scoped checker rejects the
// BAD fixtures below. That is the scoping proof.
//
// NOTE ON PIN_PSEUDONYMIZATION / PIN_BACKUP_LIMIT: the fixture below embeds
// the live exported constants directly (never re-typed text), so a formatter
// or hand-edit that silently truncates the real pin also silently breaks
// this fixture's own "good" pass — that coupling is itself a tooth (see the
// GOOD-fixture check in g24Teeth()).

export const DELETION_APPENDIX_HEADING = '## 10. Appendix (deletion decoys, on purpose)';

export const GOOD_DELETION_RUNBOOK_LINES = [
  '# Observability and disaster-recovery runbook',
  '',
  '## 8. Better Auth (accounts)',
  '',
  'Unrelated section — kept short so G24 never accidentally reads into it.',
  '',
  '## 9. Data deletion & backup retention',
  '',
  'Scope: what a deletion request actually guarantees, and what it explicitly does not (M22).',
  '',
  PIN_PSEUDONYMIZATION,
  '',
  PIN_BACKUP_LIMIT,
  '',
  'The grace window is the SSOT symbol DELETION_GRACE_MS_DEFAULT, currently 604_800_000 ms, which is 7 days.',
  '',
  'A scheduled reducer, account_deletion_reaper, is driven by the AccountDeletionReaperSchedule row.',
  'It is one-shot: cancelling and re-requesting deletion always performs a fresh re-arm of that row rather than reusing a stale one.',
  '',
  'Export via export_bundle and the my_export_bundle view carries no independent TTL of its own (see S4b); its lifetime is bounded by the account it was exported from, never a separate expiry.',
  '',
  DELETION_APPENDIX_HEADING,
  '',
  'Historical, superseded, and NOT part of section 9. Every needle any clause of G24 tests is',
  'duplicated below on purpose, so a whole-document scanner is satisfied by everything here and a',
  'section-scoped one is not:',
  '',
  PIN_PSEUDONYMIZATION,
  PIN_BACKUP_LIMIT,
  'DELETION_GRACE_MS_DEFAULT 604_800_000 7 days',
  'account_deletion_reaper AccountDeletionReaperSchedule one-shot re-arm',
  'export_bundle my_export_bundle no independent TTL S4b',
  '',
];

// ---------------------------------------------------------------------------
// C. `sources` fixtures — small, realistic stand-ins for the 4 real source
// files `readDeletionCitationSources()` reads. Each roster marker occurs
// EXACTLY ONCE in its GOOD text, mirroring the orchestrator-verified real
// files, so `requireSoleDefinition` neither returns -1 nor throws on them.
// ---------------------------------------------------------------------------

// DELETION_FILE_* fixture aliases removed (M22 S7 addendum) — every fixture
// below now reads the exported DELETION_SOURCE_ACCOUNTS/SCHEMA/PRIVACY/GRACE
// constants directly, so a path change to one cannot update the export and
// miss this private duplicate.

const FIXTURE_ACCOUNTS_RS_LINES = [
  '// accounts.rs (fixture) — the deletion reaper.',
  'pub struct AccountDeletionReaperSchedule {',
  '    pub scheduled_id: u64,',
  '    pub scheduled_at: spacetimedb::ScheduleAt,',
  '}',
  '',
  '#[spacetimedb::reducer]',
  'pub fn account_deletion_reaper(ctx: &ReducerContext, args: AccountDeletionReaperSchedule) -> Result<(), String> {',
  '    Ok(())',
  '}',
];
const FIXTURE_ACCOUNTS_RS = FIXTURE_ACCOUNTS_RS_LINES.join('\n');

// The "second occurrence" is a #[cfg(test)] twin, not a bare repeated line —
// the realistic shape called out in the brief and already precedented by
// stripRustComments' own docstring risk note in deletion-grace-wasm-ssot.
const FIXTURE_ACCOUNTS_RS_DUPLICATE = FIXTURE_ACCOUNTS_RS_LINES.concat([
  '',
  '#[cfg(test)]',
  'mod tests {',
  '    use super::*;',
  '',
  '    pub fn account_deletion_reaper(ctx: &ReducerContext, args: AccountDeletionReaperSchedule) -> Result<(), String> {',
  '        Ok(())',
  '    }',
  '}',
]).join('\n');

const FIXTURE_SCHEMA_RS = [
  '// schema.rs (fixture) — export table + lifecycle manifest.',
  'pub const DATA_LIFECYCLE_MANIFEST: &[TableLifecycle] = &[];',
  '',
  '#[spacetimedb::table(name = export_bundle, accessor = export_bundle)]',
  'pub struct ExportBundle {',
  '    pub id: u64,',
  '}',
].join('\n');

const FIXTURE_PRIVACY_RS = [
  '// privacy.rs (fixture) — the my_export_bundle view.',
  '#[spacetimedb::view(accessor = my_export_bundle, sql = "SELECT * FROM export_bundle")]',
  'pub struct MyExportBundle {',
  '    pub id: u64,',
  '}',
].join('\n');

// Structurally identical to the real deletion.rs' declaration line (:40) —
// a bare underscored integer literal, so parseGraceConst never has to
// refuse an expression here.
const FIXTURE_DELETION_RS = [
  '// deletion.rs (fixture)',
  'pub const DELETION_GRACE_MS_DEFAULT: i64 = 604_800_000;',
].join('\n');

const GOOD_DELETION_SOURCES = {
  [DELETION_SOURCE_ACCOUNTS]: FIXTURE_ACCOUNTS_RS,
  [DELETION_SOURCE_SCHEMA]: FIXTURE_SCHEMA_RS,
  [DELETION_SOURCE_PRIVACY]: FIXTURE_PRIVACY_RS,
  [DELETION_SOURCE_GRACE]: FIXTURE_DELETION_RS,
};

function sourcesWithout(key) {
  const copy = {};
  for (const k of Object.keys(GOOD_DELETION_SOURCES)) {
    if (k !== key) copy[k] = GOOD_DELETION_SOURCES[k];
  }
  return copy;
}

function sourcesWith(key, text) {
  return { ...GOOD_DELETION_SOURCES, [key]: text };
}

// ---------------------------------------------------------------------------
// C (continued). The BAD-fixture table — one entry per ANDed TERM, not per
// clause, so an implementation that drops ONE of a multi-term clause's
// checks (e.g. ships clause 3 as a 3-of-4 AND) is still caught: with a
// per-CLAUSE fixture, dropping any one of the other three terms is invisible.
//
// Each entry: [id, doc, sources, tag, why, expectedClausesMet]. `tag` is
// either a string or an array of required substrings — every one of them
// must appear in the rejection `reason`, or the fixture earns no credit
// (rejected for the WRONG reason is treated the same as not rejected at
// all). `expectedClausesMet` pins checkDrRunbookDeletionSection's returned
// `clausesMet` for this fixture: MEASURED, mutating any `miss(N, ...)` call
// site's first argument (e.g. `miss(0, ...)` to `miss(999, ...)`) left every
// existing G24 tooth bit, because nothing asserted the returned count even
// though its own docstring says it exists so the caller reports a DERIVED
// count. See g24Teeth()'s BAD-fixture loop for the pin.
// ---------------------------------------------------------------------------

const GOOD_DOC = GOOD_DELETION_RUNBOOK_LINES.join('\n');

// clause 1a / 1b — mutate ONE phrase inside the live pinned sentence, so a
// checker doing substring `contains` (not exact-sentence match) still fails,
// and so this fixture rots correctly if the implementer ever edits the pin.
const DOC_1A_WEAKENED = linesMapBefore(
  GOOD_DELETION_RUNBOOK_LINES,
  DELETION_APPENDIX_HEADING,
  (l) => (l === PIN_PSEUDONYMIZATION ? l.split('not erasure').join('complete erasure') : l),
);
const DOC_1B_WEAKENED = linesMapBefore(
  GOOD_DELETION_RUNBOOK_LINES,
  DELETION_APPENDIX_HEADING,
  (l) => (l === PIN_BACKUP_LIMIT ? l.split('makes no claim').join('makes no strong claim') : l),
);

// clause 2 — three fixtures, each mutating exactly one of the three ANDed
// terms (symbol name / ms value / day phrase) and leaving the other two
// intact on the same line.
const DOC_2_NAME = linesMapBefore(GOOD_DELETION_RUNBOOK_LINES, DELETION_APPENDIX_HEADING, (l) =>
  l.split('DELETION_GRACE_MS_DEFAULT').join('DELETION_GRACE_WINDOW_MS'),
);
const DOC_2_MS = linesMapBefore(GOOD_DELETION_RUNBOOK_LINES, DELETION_APPENDIX_HEADING, (l) =>
  l.split('604_800_000').join('604_800_001'),
);
const DOC_2_DAYS = linesMapBefore(GOOD_DELETION_RUNBOOK_LINES, DELETION_APPENDIX_HEADING, (l) =>
  l.split('7 days').join('5 days'),
);

// clause 3 — four fixtures, one per ANDed term.
const DOC_3_REAPER_FN = linesMapBefore(
  GOOD_DELETION_RUNBOOK_LINES,
  DELETION_APPENDIX_HEADING,
  (l) => l.split('account_deletion_reaper').join('the_deletion_job'),
);
const DOC_3_SCHEDULE = linesMapBefore(GOOD_DELETION_RUNBOOK_LINES, DELETION_APPENDIX_HEADING, (l) =>
  l.split('AccountDeletionReaperSchedule').join('DeletionScheduleRow'),
);
const DOC_3_ONE_SHOT = linesMapBefore(GOOD_DELETION_RUNBOOK_LINES, DELETION_APPENDIX_HEADING, (l) =>
  l.split('one-shot').join('recurring'),
);
const DOC_3_REARM = linesMapBefore(GOOD_DELETION_RUNBOOK_LINES, DELETION_APPENDIX_HEADING, (l) =>
  l.split('re-arm').join('re-use'),
);

// clause 4 — four fixtures. `my_export_bundle` and `export_bundle` are NOT
// independently isolable: `my_export_bundle` textually CONTAINS the
// substring `export_bundle`, so any document carrying `my_export_bundle`
// also satisfies a plain `indexOf('export_bundle')` check. Removing
// `my_export_bundle` alone (leaving the bare mention) IS isolable and is
// its own fixture below; the reverse is not, so the 4th fixture removes
// BOTH names together and is flagged as jointly covering that ANDed pair —
// see the report note in the handoff reply, this is not a silent workaround.
const DOC_4_MY_EXPORT = linesMapBefore(
  GOOD_DELETION_RUNBOOK_LINES,
  DELETION_APPENDIX_HEADING,
  (l) => l.split('my_export_bundle').join('my-export-view'),
);
const DOC_4_NO_TTL = linesMapBefore(GOOD_DELETION_RUNBOOK_LINES, DELETION_APPENDIX_HEADING, (l) =>
  l.split('no independent TTL').join('a bounded TTL'),
);
const DOC_4_S4B = linesMapBefore(GOOD_DELETION_RUNBOOK_LINES, DELETION_APPENDIX_HEADING, (l) =>
  l.split('S4b').join('S9'),
);

// fence-hidden — S4b removed from every prose occurrence before the appendix
// and re-added ONLY inside a fenced code block placed just before the
// appendix heading (still inside section 9's extracted body). See the
// EDIT 8 banner above for the measured bypass this closes.
const TRIPLE_BACKTICK = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
const DELETION_APPENDIX_AT = GOOD_DELETION_RUNBOOK_LINES.indexOf(DELETION_APPENDIX_HEADING);
const DOC_4_S4B_FENCE_BEFORE = GOOD_DELETION_RUNBOOK_LINES.slice(0, DELETION_APPENDIX_AT).map((l) =>
  l.split(' (see S4b)').join(''),
);
const DOC_4_S4B_FENCE_AFTER = GOOD_DELETION_RUNBOOK_LINES.slice(DELETION_APPENDIX_AT);
const DOC_4_S4B_FENCE_HIDDEN = DOC_4_S4B_FENCE_BEFORE.concat([
  TRIPLE_BACKTICK,
  'decoy reference: S4b',
  TRIPLE_BACKTICK,
  '',
])
  .concat(DOC_4_S4B_FENCE_AFTER)
  .join('\n');
const DOC_4_BOTH_NAMES = linesMapBefore(
  GOOD_DELETION_RUNBOOK_LINES,
  DELETION_APPENDIX_HEADING,
  (l) =>
    l
      .split('export_bundle and the my_export_bundle view')
      .join('the account-export mechanism and its privacy-scoped view'),
);

// html-comment-hidden — the pseudonymization sentence is present ONLY
// inside an HTML comment. Measured bypass class in this repo (see
// html-comment-stripping-in-gates in project memory): a squashDocText that
// forgets to strip comments before matching would accept this.
const DOC_1A_HTML_HIDDEN = linesMapBefore(
  GOOD_DELETION_RUNBOOK_LINES,
  DELETION_APPENDIX_HEADING,
  (l) => (l === PIN_PSEUDONYMIZATION ? '<!-- ' + l + ' -->' : l),
);

// FAIL-LOUD — no heading at all.
const DOC_HEADING_ABSENT = linesWithout(
  GOOD_DELETION_RUNBOOK_LINES,
  (l) => l === '## 9. Data deletion & backup retention',
);

// FAIL-LOUD — two headings both containing the phrase; must never guess.
const DOC_DUPLICATE_HEADING = GOOD_DELETION_RUNBOOK_LINES.concat([
  '## 9b. Data deletion & backup retention (draft)',
  '',
  'A second section with the same subject.',
]).join('\n');

// clause 5 — a `sources` map missing one roster file.
const SOURCES_MISSING_PRIVACY = sourcesWithout(DELETION_SOURCE_PRIVACY);

// clause 5 — a duplicated declaration (ambiguous, never a silent first-hit).
const SOURCES_DUPLICATE_ACCOUNTS = sourcesWith(
  DELETION_SOURCE_ACCOUNTS,
  FIXTURE_ACCOUNTS_RS_DUPLICATE,
);

// clause 5 — the source file is present and unambiguous, but the cited
// symbol has been RENAMED out from under the runbook. This is the case
// clause 5 primarily exists for (a doc citing a symbol that no longer
// exists), and it was the one `resolveDeletionCitations` branch with no
// fixture: the verifier MEASURED that changing its `at === -1` sentinel to
// `at === -2` survived the whole suite at 55/55. Distinct from the two
// neighbours: `clause5-missing-source` removes the FILE, and
// `clause5-ambiguous-duplicate` supplies TWO declarations.
const FIXTURE_ACCOUNTS_RS_RENAMED = FIXTURE_ACCOUNTS_RS.split(
  'pub fn account_deletion_reaper(',
).join('pub fn run_account_deletion_cascade(');
const SOURCES_RENAMED_ACCOUNTS = sourcesWith(DELETION_SOURCE_ACCOUNTS, FIXTURE_ACCOUNTS_RS_RENAMED);

export const G24_BAD_FIXTURES = [
  [
    'clause1a-weakened',
    DOC_1A_WEAKENED,
    GOOD_DELETION_SOURCES,
    'clause 1a:',
    'the pseudonymization sentence was accepted after "not erasure" was flipped to "complete ' +
      'erasure" — a substring-contains check (rather than the exact pin) would miss this, and the ' +
      'decoy appendix keeps the ORIGINAL sentence intact so a whole-document scan also passes',
    0,
  ],
  [
    'clause1b-weakened',
    DOC_1B_WEAKENED,
    GOOD_DELETION_SOURCES,
    'clause 1b:',
    'the backup-limit sentence was accepted after "makes no claim" was softened to "makes no ' +
      'strong claim" — the exact backup-retention disclaimer is the load-bearing part of PRV1-18',
    1,
  ],
  [
    'clause2-symbol-name',
    DOC_2_NAME,
    GOOD_DELETION_SOURCES,
    'clause 2:',
    'the section was accepted with no mention of DELETION_GRACE_MS_DEFAULT by name, even though ' +
      'the correct ms value and "7 days" both survived — an operator reading this section could ' +
      'not find the constant to retune it',
    2,
  ],
  [
    'clause2-ms-value',
    DOC_2_MS,
    GOOD_DELETION_SOURCES,
    'clause 2:',
    'a WRONG grace-window ms value (604_800_001 instead of 604_800_000) was accepted — the value ' +
      'must equal parseGraceConst on the real deletion.rs, not merely look like a number',
    2,
  ],
  [
    'clause2-day-figure',
    DOC_2_DAYS,
    GOOD_DELETION_SOURCES,
    'clause 2:',
    'the section was accepted stating "5 days" while the ms value and symbol name were correct — ' +
      'a wrong day figure directly contradicts the number two lines away',
    2,
  ],
  [
    'clause3-reaper-fn-name',
    DOC_3_REAPER_FN,
    GOOD_DELETION_SOURCES,
    'clause 3:',
    'the section was accepted with no mention of the reducer name account_deletion_reaper — an ' +
      'operator cannot find the reaper in the source without it',
    3,
  ],
  [
    'clause3-schedule-name',
    DOC_3_SCHEDULE,
    GOOD_DELETION_SOURCES,
    'clause 3:',
    'the section was accepted with no mention of AccountDeletionReaperSchedule',
    3,
  ],
  [
    'clause3-one-shot',
    DOC_3_ONE_SHOT,
    GOOD_DELETION_SOURCES,
    'clause 3:',
    '"one-shot" was replaced with "recurring" and still accepted — this is the exact word that ' +
      'tells an operator cancel+re-request re-arms rather than double-schedules',
    3,
  ],
  [
    'clause3-rearm',
    DOC_3_REARM,
    GOOD_DELETION_SOURCES,
    'clause 3:',
    '"re-arm" was replaced with "re-use" and still accepted',
    3,
  ],
  [
    'clause4-my-export-bundle',
    DOC_4_MY_EXPORT,
    GOOD_DELETION_SOURCES,
    'clause 4:',
    'the section was accepted with no mention of my_export_bundle even though the bare ' +
      'export_bundle mention (and everything else) survived — the privacy-scoped view is the ' +
      'thing S4b actually names',
    4,
  ],
  [
    'clause4-no-independent-ttl',
    DOC_4_NO_TTL,
    GOOD_DELETION_SOURCES,
    'clause 4:',
    '"no independent TTL" was softened to "a bounded TTL" and still accepted — this phrase is the ' +
      'one place the doc states export bundles do NOT get their own expiry',
    4,
  ],
  [
    'clause4-s4b',
    DOC_4_S4B,
    GOOD_DELETION_SOURCES,
    'clause 4:',
    'the S4b cross-reference was renamed to S9 and still accepted',
    4,
  ],
  [
    'clause4-s4b-fence-hidden',
    DOC_4_S4B_FENCE_HIDDEN,
    GOOD_DELETION_SOURCES,
    'clause 4:',
    'S4b was removed from every prose occurrence of the export-bundle sentence and re-added ONLY ' +
      'inside a fenced code block placed before the appendix heading, and was still accepted — ' +
      'squashDocText strips fenced code blocks as its second pass; deleting that one replacement ' +
      'is a MEASURED bypass in this repo (doing the same thing to the REAL runbook section 9 made ' +
      'this gate report 6/6 green), because a fence hides text from the substring scan exactly ' +
      'like an HTML comment does',
    4,
  ],
  [
    'clause4-export-bundle-pair',
    DOC_4_BOTH_NAMES,
    GOOD_DELETION_SOURCES,
    'clause 4:',
    'BOTH export_bundle and my_export_bundle were removed and still accepted. (These two terms ' +
      'are not independently isolable: my_export_bundle textually contains export_bundle as a ' +
      'substring, so no fixture can remove the bare name alone while my_export_bundle survives — ' +
      'see the handoff reply for the full note.)',
    4,
  ],
  [
    'clause5-missing-source',
    GOOD_DOC,
    SOURCES_MISSING_PRIVACY,
    'clause 5: FAIL-LOUD',
    'privacy.rs was missing from `sources` and the citation for my_export_bundle was silently ' +
      'treated as resolved (or silently skipped) instead of failing loud — a missing source file ' +
      'must read exactly the same as a citation that resolves to zero hits',
    5,
  ],
  [
    'clause5-ambiguous-duplicate',
    GOOD_DOC,
    SOURCES_DUPLICATE_ACCOUNTS,
    ['clause 5:', 'ambiguous'],
    'accounts.rs carried TWO definitions of account_deletion_reaper (a #[cfg(test)] twin) and the ' +
      'citation was accepted anyway — requireSoleDefinition throws on >1 occurrence for exactly ' +
      'this reason, and clause 5 must surface that as an explicit ambiguity, never pick the first',
    5,
  ],
  [
    'clause5-marker-absent',
    GOOD_DOC,
    SOURCES_RENAMED_ACCOUNTS,
    ['clause 5: FAIL-LOUD', 'carries no'],
    'accounts.rs was present and unambiguous but no longer declared account_deletion_reaper ' +
      '(renamed), and the citation resolved anyway — this is the whole point of clause 5: a ' +
      'runbook naming a symbol the code no longer has is a broken citation. It must also read ' +
      'DIFFERENTLY from clause5-missing-source (no file at all), so the two cannot shadow ' +
      'each other',
    5,
  ],
  [
    'heading-absent',
    DOC_HEADING_ABSENT,
    GOOD_DELETION_SOURCES,
    'FAIL-LOUD',
    'a document with no "Data deletion & backup retention" heading passed — the extractor fell ' +
      'back to the whole document instead of failing loud',
    0,
  ],
  [
    'duplicate-heading',
    DOC_DUPLICATE_HEADING,
    GOOD_DELETION_SOURCES,
    'FAIL-LOUD',
    'two headings both containing the phrase were accepted — the extractor guessed which one to ' +
      'scan instead of failing loud',
    0,
  ],
  [
    'html-comment-hidden',
    DOC_1A_HTML_HIDDEN,
    GOOD_DELETION_SOURCES,
    'clause 1a:',
    'the pseudonymization sentence was present ONLY inside an HTML comment and was still accepted ' +
      '— a squashDocText that does not strip HTML comments before matching lets a doc comment out ' +
      'the actual disclaimer while still satisfying every clause textually (measured bypass class ' +
      'in this repo)',
    0,
  ],
];

// ---------------------------------------------------------------------------
// D. g24Teeth() — proof of teeth for G24. Every count below is DERIVED: never
// a hardcoded literal for `total`.
// ---------------------------------------------------------------------------

// Length + no-backslash pins on the two live pins, computed from the exact
// sentences quoted in the handoff brief (not re-derived from the pin itself
// — that would prove nothing about truncation). A formatter's quote-rewrite
// silently truncating a text pin is a MEASURED incident in this repo.
const PIN_PSEUDONYMIZATION_EXPECTED_LENGTH = 243;
const PIN_BACKUP_LIMIT_EXPECTED_LENGTH = 334;

// Today's measured tooth count, used as a ratchet: the suite may grow, never
// shrink. Kept beside `g24Teeth` so the two are edited together.
export const G24_TEETH_FLOOR = 57;

export function g24Teeth() {
  // `total` is incremented by `record` ITSELF, once per call, regardless of
  // outcome — so it is structurally impossible for `total` to drift from
  // the actual number of checks that ran (the earlier draft of this
  // function hand-counted "+ 11" for the extra checks; the real count was
  // 13. That class of mistake is exactly what a self-counting `record`
  // closes, for the checker AND for whoever edits this suite next).
  let bit = 0;
  let total = 0;
  let firstMiss = null;
  const record = (ok, id, why) => {
    total++;
    if (ok) {
      bit++;
      return;
    }
    if (firstMiss === null) firstMiss = `${id}: ${why}`;
  };

  // --- the fixture table itself must be non-empty, or every loop below it
  // is vacuously "all bit" over zero iterations ---
  record(
    G24_BAD_FIXTURES.length > 0,
    'g24-fixtures-nonempty',
    'G24_BAD_FIXTURES is empty — the BAD-fixture loop below would vacuously report every tooth ' +
      'as bit',
  );

  // --- non-vacuity: the GOOD fixture must pass whole ---
  const goodResult = checkDrRunbookDeletionSection(GOOD_DOC, GOOD_DELETION_SOURCES);
  record(
    goodResult.ok,
    'g24-good',
    `a complete deletion & backup retention section was rejected: ${goodResult.reason}`,
  );
  record(
    goodResult.clausesMet === 6,
    'g24-good-clauses-met',
    `a complete deletion & backup retention section reported clausesMet=${goodResult.clausesMet}, ` +
      'expected 6 on the success path — the docstring on checkDrRunbookDeletionSection claims ' +
      'this count is derived, not a fixed literal on the ok:true branch',
  );

  // --- the BAD-fixture table ---
  for (const [id, doc, sources, tag, why, expectedClausesMet] of G24_BAD_FIXTURES) {
    const got = checkDrRunbookDeletionSection(doc, sources);
    if (got.ok) {
      record(false, `g24-${id}`, why);
      record(false, `g24-${id}-clauses-met`, why);
      continue;
    }
    const tags = Array.isArray(tag) ? tag : [tag];
    const allFound = tags.every((t) => got.reason.indexOf(t) !== -1);
    record(
      allFound,
      `g24-${id}`,
      `rejected for the WRONG reason — expected ${JSON.stringify(tags)}, got: ${got.reason}`,
    );
    // NEW TOOTH 2. MEASURED: mutating any `miss(N, ...)` call site inside
    // checkDrRunbookDeletionSection (e.g. `miss(0, ...)` to `miss(999, ...)`)
    // left every existing G24 tooth bit — nothing asserted the returned
    // `clausesMet`, even though its own docstring says it exists so the
    // caller reports a DERIVED count. This pin uses the SAME fixture the
    // tag-check above already uses, so it can never be satisfied by a
    // neighbouring fixture's expected value.
    record(
      got.clausesMet === expectedClausesMet,
      `g24-${id}-clauses-met`,
      `checkDrRunbookDeletionSection returned clausesMet=${got.clausesMet} for this rejection, ` +
        `expected ${expectedClausesMet} — an operator reading the phase-1 detail string would be ` +
        'told the wrong clause failed',
    );
  }

  // --- state the extra checks below close over (computed once, up front,
  // so the checks themselves stay simple boolean predicates) ---
  let sec = null;
  let extractThrew = false;
  try {
    sec = extractSection(GOOD_DOC, DELETION_SECTION_HEADING_PHRASE, '## ');
  } catch {
    extractThrew = true;
  }
  let missingHeadingThrew = false;
  try {
    extractSection('# doc\n\nno sections here', DELETION_SECTION_HEADING_PHRASE, '## ');
  } catch {
    missingHeadingThrew = true;
  }
  let dupThrew = false;
  try {
    requireSoleDefinition(
      stripRustComments(FIXTURE_ACCOUNTS_RS_DUPLICATE),
      'pub fn account_deletion_reaper(',
    );
  } catch {
    dupThrew = true;
  }
  const expectedCitations = [
    {
      symbol: 'account_deletion_reaper',
      file: DELETION_SOURCE_ACCOUNTS,
      marker: 'pub fn account_deletion_reaper(',
    },
    {
      symbol: 'AccountDeletionReaperSchedule',
      file: DELETION_SOURCE_ACCOUNTS,
      marker: 'pub struct AccountDeletionReaperSchedule',
    },
    { symbol: 'export_bundle', file: DELETION_SOURCE_SCHEMA, marker: 'accessor = export_bundle)' },
    {
      symbol: 'DATA_LIFECYCLE_MANIFEST',
      file: DELETION_SOURCE_SCHEMA,
      marker: 'pub const DATA_LIFECYCLE_MANIFEST',
    },
    {
      symbol: 'my_export_bundle',
      file: DELETION_SOURCE_PRIVACY,
      marker: 'accessor = my_export_bundle,',
    },
  ];
  const citationsIsArray = Array.isArray(DELETION_CITATIONS);
  const citationsLengthOk =
    citationsIsArray && DELETION_CITATIONS.length === expectedCitations.length;
  const rosterMatches =
    citationsIsArray &&
    expectedCitations.every((exp) =>
      DELETION_CITATIONS.some(
        (got) => got.symbol === exp.symbol && got.file === exp.file && got.marker === exp.marker,
      ),
    );

  // --- extra (non-fixture-table) teeth: section-bounds, extract-throw,
  // pin length/no-backslash sanity, the DELETION_CITATIONS roster pin, and
  // self-checks on this eval's OWN fixtures using the real imported
  // primitives (never a reimplementation) — catches fixture rot before it
  // ever reaches the checker under test. Array-driven so `total` below is
  // structurally derived from `.length`, never hand-counted (a hand-counted
  // literal here is exactly the "printed 118, ran 0" failure mode this repo
  // has already shipped once).
  const EXTRA_CHECKS = [
    [
      'g24-extract-good',
      () => !extractThrew && !!sec,
      'extractSection threw (or returned nothing) on a valid GOOD doc',
    ],
    [
      'g24-section-bounds-leak',
      () => !!sec && sec.body.indexOf(DELETION_APPENDIX_HEADING) === -1,
      'the extracted section leaked into the FOLLOWING appendix — every clause would then be ' +
        'satisfiable by text the section does not contain',
    ],
    [
      'g24-section-bounds-content',
      () => !!sec && sec.body.indexOf('account_deletion_reaper') !== -1,
      'the extracted section is missing its own content',
    ],
    [
      'g24-extract-throw',
      () => missingHeadingThrew,
      'extractSection did not throw on a doc with no matching heading',
    ],
    [
      'g24-pin-1a-length',
      () => PIN_PSEUDONYMIZATION.length === PIN_PSEUDONYMIZATION_EXPECTED_LENGTH,
      `PIN_PSEUDONYMIZATION.length is ${PIN_PSEUDONYMIZATION.length}, expected ` +
        `${PIN_PSEUDONYMIZATION_EXPECTED_LENGTH} — a quote-rewrite or hand-edit silently changed it`,
    ],
    [
      'g24-pin-1b-length',
      () => PIN_BACKUP_LIMIT.length === PIN_BACKUP_LIMIT_EXPECTED_LENGTH,
      `PIN_BACKUP_LIMIT.length is ${PIN_BACKUP_LIMIT.length}, expected ` +
        `${PIN_BACKUP_LIMIT_EXPECTED_LENGTH} — a quote-rewrite or hand-edit silently changed it`,
    ],
    [
      'g24-pin-1a-no-backslash',
      () => PIN_PSEUDONYMIZATION.indexOf('\\') === -1,
      'PIN_PSEUDONYMIZATION contains a backslash — a formatter escaped an apostrophe instead of ' +
        'leaving the sentence double-quoted, which changes its printed text',
    ],
    [
      'g24-pin-1b-no-backslash',
      () => PIN_BACKUP_LIMIT.indexOf('\\') === -1,
      'PIN_BACKUP_LIMIT contains a backslash',
    ],
    [
      'g24-citations-length',
      () => citationsLengthOk,
      `DELETION_CITATIONS has ${citationsIsArray ? DELETION_CITATIONS.length : 'a non-array'} ` +
        `entries, expected ${expectedCitations.length}`,
    ],
    [
      'g24-citations-content',
      () => rosterMatches,
      'DELETION_CITATIONS does not contain every {symbol, file, marker} triple from the roster ' +
        'the spec pins — a hollowed or misspelled entry would make clause 5 unresolvable for the ' +
        'real doc',
    ],
    [
      'g24-fixture-grace-const',
      () => parseGraceConst(FIXTURE_DELETION_RS) === 604800000n,
      'FIXTURE_DELETION_RS does not parse to 604800000n via the real parseGraceConst — this ' +
        "fixture's own text has drifted from the shape clause 2 is supposed to be checked against",
    ],
    [
      'g24-fixture-duplicate-real',
      () => dupThrew,
      'FIXTURE_ACCOUNTS_RS_DUPLICATE does not actually trip requireSoleDefinition — the ' +
        'clause5-ambiguous-duplicate fixture would not be a real ambiguity',
    ],
    [
      'g24-fixture-good-real',
      () =>
        requireSoleDefinition(
          stripRustComments(FIXTURE_ACCOUNTS_RS),
          'pub fn account_deletion_reaper(',
        ) !== -1,
      'FIXTURE_ACCOUNTS_RS does not carry a findable account_deletion_reaper definition',
    ],
    [
      // NEW TOOTH 3. MEASURED: replacing ownSource's own-property guard
      // (`if (!Object.hasOwn(sources, file)) return undefined;`) with
      // `file in sources` left every existing G24 tooth bit, because no
      // fixture exercised an inherited property. This tooth performs the
      // REAL prototype write (not a stand-in object), refuses to run if the
      // key already exists on Object.prototype (pre-existence check), and
      // always cleans up via try/finally. The post-assert is non-tautological:
      // it pins the specific "clause 5: FAIL-LOUD" / "no source text for"
      // reason substrings, not merely `!ok`.
      'g24-prototype-pollution',
      () => {
        const file = DELETION_SOURCE_PRIVACY;
        if (Object.hasOwn(Object.prototype, file)) {
          return false;
        }
        let result;
        try {
          Object.prototype[file] = FIXTURE_PRIVACY_RS;
          result = resolveDeletionCitations(sourcesWithout(file));
        } finally {
          delete Object.prototype[file];
        }
        return (
          !result.ok &&
          result.reason.indexOf('clause 5: FAIL-LOUD') !== -1 &&
          result.reason.indexOf('no source text for') !== -1 &&
          result.reason.indexOf(file) !== -1
        );
      },
      'a value forged onto Object.prototype for the one source file missing from `sources` was ' +
        'accepted by resolveDeletionCitations as if the caller had supplied it — an inherited ' +
        'property must never satisfy a citation lookup; ownSource must reject it via an ' +
        'own-property guard',
    ],
  ];
  for (const [id, check, why] of EXTRA_CHECKS) {
    record(check(), id, why);
  }

  // `total` was incremented once per `record()` call above (fixtures-nonempty
  // + good + one per G24_BAD_FIXTURES entry + one per EXTRA_CHECKS entry) —
  // it is read here, never recomputed, so there is no second place for the
  // count to drift from what actually ran.
  return { bit, total, firstMiss };
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
  "import { existsSync } from 'node:fs';",
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
  'const killer = setTimeout(function () { bail("timeout", "driver 420s timeout"); }, 420000);',
  'const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };',
  '',
  'function connectOnce(token) {',
  '  return new Promise(function (resolve, reject) {',
  '    let b = DbConnection.builder().withUri(uri).withDatabaseName(db);',
  '    if (token) b = b.withToken(token);',
  '    b.onConnect(function (c, identity) {',
  '      resolve({ conn: c, identity: identity.toHexString(), idObj: identity });',
  '    })',
  '      .onConnectError(function (_ctx, err) { reject(err); })',
  '      .build();',
  '  });',
  '}',
  '',
  '// AUTH-3 path: an allowed-issuer + wrong-audience token makes client_connected',
  '// return Err, so the host DROPS the socket -> .onConnectError (or a disconnect)',
  '// fires and .onConnect never does. Resolves { rejected:true } on refusal,',
  '// { rejected:false, conn } if it unexpectedly connects. A 15s silence is treated',
  '// as rejected:false so a hang is a LOUD failure (E-rejected.ok===false), never a',
  '// false pass.',
  'function connectExpectReject(token) {',
  '  return new Promise(function (resolve) {',
  '    let settled = false;',
  '    const done = function (v) { if (!settled) { settled = true; resolve(v); } };',
  '    const t = setTimeout(function () { done({ rejected: false, conn: null }); }, 15000);',
  '    let b = DbConnection.builder().withUri(uri).withDatabaseName(db);',
  '    if (token) b = b.withToken(token);',
  '    b.onConnect(function (c) { clearTimeout(t); done({ rejected: false, conn: c }); })',
  '      .onConnectError(function () { clearTimeout(t); done({ rejected: true }); })',
  '      .onDisconnect(function () { clearTimeout(t); done({ rejected: true }); })',
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
  '  const eRej = await connectExpectReject(jwtE);',
  '  emit("E-rejected", eRej.rejected === true, { rejected: eRej.rejected });',
  '  if (eRej.conn) { try { eRej.conn.disconnect(); } catch (ignored) {} }',
  '',
  '',
  '  // ---- M22-S9 flow (ADR-0232): loaded account -> delete -> real cascade ----',
  '  const GO = process.env.MR_S9_GO;',
  '  const ERR_EXPORT = process.env.MR_S9_ERR_EXPORT;',
  '  const ERR_TERMINAL = process.env.MR_S9_ERR_TERMINAL;',
  '  function iterRows(conn, handle) {',
  '    const h = conn.db[handle];',
  '    if (!h) throw new Error("no table handle " + handle);',
  '    const out = [];',
  '    for (const r of h.iter()) out.push(r);',
  '    return out;',
  '  }',
  '  function stripHexS9(x) {',
  '    const v = String(x).toLowerCase();',
  '    return v.startsWith("0x") ? v.slice(2) : v;',
  '  }',
  '  async function waitGo(n, ms) {',
  '    const f = GO + n;',
  '    const t0 = Date.now();',
  '    while (!existsSync(f)) {',
  '      if (Date.now() - t0 > ms) bail("S9-go-wait", "go-file " + n + " never arrived within " + ms + "ms");',
  '      await sleep(400);',
  '    }',
  '  }',
  '  async function pollFor(label, ms, step, fn) {',
  '    const t0 = Date.now();',
  '    for (;;) {',
  '      const v = fn();',
  '      if (v !== undefined && v !== null && v !== false) return v;',
  '      if (Date.now() - t0 > ms) bail(step, label + " not observed within " + ms + "ms");',
  '      await sleep(600);',
  '    }',
  '  }',
  '  await applied(d.conn, ["SELECT * FROM my_battle", "SELECT * FROM my_monster_pub", "SELECT * FROM battle_challenge"]);',
  '  const dJoin = await tryReducer(d.conn.reducers.joinGame({ name: "dave s9" }));',
  '  emit("S9-D-join", dJoin.ok, dJoin);',
  '  await applied(a.conn, ["SELECT * FROM my_battle", "SELECT * FROM my_monster_pub", "SELECT * FROM my_export_bundle", "SELECT * FROM battle_challenge", "SELECT * FROM trade_offer", "SELECT * FROM player"]);',
  '  const aJoin = await tryReducer(a.conn.reducers.joinGame({ name: "alice s9" }));',
  '  emit("S9-A-join", aJoin.ok, aJoin);',
  '  const aMon = iterRows(a.conn, "my_monster_pub").filter(function (r) { return stripHexS9(r.ownerIdentity.toHexString()) === stripHexS9(a.identity); });',
  '  if (aMon.length === 0) bail("S9-A-join", "A owns no monster after join (claim re-key + join both failed to grant)");',
  '  const aMonId = aMon[0].monsterId;',
  '  const ch1 = await tryReducer(a.conn.reducers.challengePvp({ target: d.idObj, partyIds: [aMonId] }));',
  '  emit("S9-challenge1", ch1.ok, ch1);',
  '  const ch1Row = await pollFor("incoming challenge on D", 20000, "S9-accept1", function () {',
  '    const rows = iterRows(d.conn, "battle_challenge").filter(function (r) { return stripHexS9(r.target.toHexString()) === stripHexS9(d.identity); });',
  '    return rows.length > 0 ? rows[0] : null;',
  '  });',
  '  const dMon = iterRows(d.conn, "my_monster_pub").filter(function (r) { return stripHexS9(r.ownerIdentity.toHexString()) === stripHexS9(d.identity); });',
  '  if (dMon.length === 0) bail("S9-accept1", "D owns no monster after join");',
  '  const acc1 = await tryReducer(d.conn.reducers.acceptChallenge({ challengeId: ch1Row.challengeId, partyIds: [dMon[0].monsterId] }));',
  '  emit("S9-accept1", acc1.ok, acc1);',
  '  const b1 = await pollFor("live pvp battle on A", 20000, "S9-battle1-live", function () {',
  '    const rows = iterRows(a.conn, "my_battle").filter(function (r) { return r.state.outcome.tag === "Ongoing"; });',
  '    return rows.length > 0 ? rows[0] : null;',
  '  });',
  '  emit("S9-battle1-live", true, { battleId: String(b1.battleId) });',
  '  d.conn.disconnect();',
  '  const b1t = await pollFor("battle1 terminal after D forfeit", 30000, "S9-battle1-terminal", function () {',
  '    const rows = iterRows(a.conn, "my_battle").filter(function (r) { return String(r.battleId) === String(b1.battleId); });',
  '    return rows.length > 0 && rows[0].state.outcome.tag !== "Ongoing" ? rows[0] : null;',
  '  });',
  '  emit("S9-battle1-terminal", true, { outcome: b1t.state.outcome.tag });',
  '  const d2 = await connectOnce(jwtD);',
  '  await applied(d2.conn, ["SELECT * FROM my_account", "SELECT * FROM my_battle", "SELECT * FROM my_monster_pub", "SELECT * FROM battle_challenge"]);',
  '  const dRejoin = await tryReducer(d2.conn.reducers.joinGame({ name: "dave s9" }));',
  '  emit("S9-D-rejoin", dRejoin.ok, dRejoin);',
  '  emit("S9-presence-ready", true, { a: a.identity, d: d2.identity, battle1Id: String(b1.battleId) });',
  '  await waitGo(1, 90000);',
  '  const tr = await tryReducer(a.conn.reducers.proposeTrade({ counterparty: d2.idObj, initiatorMonsterIds: [], initiatorItems: [], initiatorCurrency: 5n, counterpartyMonsterIds: [], counterpartyItems: [], counterpartyCurrency: 0n }));',
  '  emit("S9-trade-open", tr.ok, tr);',
  '  const ch2 = await tryReducer(a.conn.reducers.challengePvp({ target: d2.idObj, partyIds: [aMonId] }));',
  '  emit("S9-challenge2-pending", ch2.ok, ch2);',
  '  let seq = 1;',
  '  async function stepDir(dir) {',
  '    const r = await tryReducer(a.conn.reducers.enqueueMove({ input: { tag: "Step", value: { tag: dir } }, seq: BigInt(seq) }));',
  '    seq = seq + 1;',
  '    return r;',
  '  }',
  '  await stepDir("South");',
  '  await sleep(260);',
  '  let wild = null;',
  '  for (let i = 0; i < 80 && wild === null; i++) {',
  '    await stepDir(i % 2 === 0 ? "East" : "West");',
  '    await sleep(240);',
  '    const rows = iterRows(a.conn, "my_battle").filter(function (r) { return r.state.outcome.tag === "Ongoing" && stripHexS9(r.opponentIdentity.toHexString()) === "0".repeat(64); });',
  '    if (rows.length > 0) wild = rows[0];',
  '  }',
  '  if (wild === null) bail("S9-wild-live", "no wild encounter within 80 shuttle steps over zone-0 grass (rate 200/1000 per grass step)");',
  '  emit("S9-wild-live", true, { battleId: String(wild.battleId) });',
  '  emit("S9-seed-ready", true, { wildBattleId: String(wild.battleId) });',
  '  await waitGo(2, 120000);',
  '  const exq = await tryReducer(a.conn.reducers.requestDataExport());',
  '  if (!exq.ok) bail("S9-export-chunks", "requestDataExport rejected: " + exq.err);',
  '  let chunkRowsS9 = [];',
  '  {',
  '    let prevCount = -1;',
  '    let stable = 0;',
  '    const t0e = Date.now();',
  '    for (;;) {',
  '      const rs = iterRows(a.conn, "my_export_bundle");',
  '      if (rs.length > 0 && rs.length === prevCount) {',
  '        stable = stable + 1;',
  '        if (stable >= 2) { chunkRowsS9 = rs; break; }',
  '      } else {',
  '        stable = 0;',
  '      }',
  '      prevCount = rs.length;',
  '      if (Date.now() - t0e > 45000) bail("S9-export-chunks", "export chunks never stabilized (last count " + rs.length + ")");',
  '      await sleep(700);',
  '    }',
  '  }',
  '  function chunkDigest(r) {',
  '    let rows = -1;',
  '    let seedField = false;',
  '    try {',
  '      const parsed = JSON.parse(r.payloadJson);',
  '      // ADR-0226 payload shape: {"table": <name>, "rows": [...]} — a table',
  '      // field that disagrees with the table_name column is a malformed export.',
  '      if (parsed !== null && typeof parsed === "object" && parsed.table === r.tableName && Array.isArray(parsed.rows)) {',
  '        rows = parsed.rows.length;',
  '        for (const row of parsed.rows) {',
  '          if (row !== null && typeof row === "object" && Object.prototype.hasOwnProperty.call(row, "seed")) seedField = true;',
  '        }',
  '      }',
  '    } catch (ignored) {',
  '      rows = -1;',
  '    }',
  '    return { t: r.tableName, i: r.chunkIndex, n: r.totalChunks, req: String(r.requestId), rows: rows, seedField: seedField };',
  '  }',
  '  emit("S9-export-chunks", true, { chunks: chunkRowsS9.map(chunkDigest) });',
  '  const t0d = Date.now();',
  '  const del1 = await tryReducer(a.conn.reducers.deleteAccount());',
  '  await pollFor("PendingDeletion after delete", 15000, "S9-delete", function () {',
  '    const rs = accountRows(a.conn);',
  '    return rs.length > 0 && rs[0].status.tag === "PendingDeletion" ? rs[0] : null;',
  '  });',
  '  emit("S9-delete", del1.ok, { err: del1.err });',
  '  const exr = await tryReducer(a.conn.reducers.requestDataExport());',
  '  emit("S9-export-reject", exr.ok === false && String(exr.err).indexOf(ERR_EXPORT) !== -1, { err: exr.err });',
  '  const can = await tryReducer(a.conn.reducers.cancelAccountDeletion());',
  '  const cancelElapsed = Date.now() - t0d;',
  '  if (cancelElapsed >= 10000) bail("S9-cancel", "grace-margin: delete->cancel took " + cancelElapsed + "ms (>= 10s of the 15s window) — first-window race; the box is too slow for this leg");',
  '  await pollFor("Active after cancel", 15000, "S9-cancel", function () {',
  '    const rs = accountRows(a.conn);',
  '    const r = rs.length > 0 ? rs[0] : null;',
  '    return r !== null && r.status.tag === "Active" && (r.terminalAtMs === null || r.terminalAtMs === undefined) && (r.deletionRequestedAtMs === null || r.deletionRequestedAtMs === undefined) ? r : null;',
  '  });',
  '  emit("S9-cancel", can.ok === true, { err: can.err, elapsedMs: cancelElapsed });',
  '  emit("S9-cancel-done", true, {});',
  '  await waitGo(3, 90000);',
  '  const del2 = await tryReducer(a.conn.reducers.deleteAccount());',
  '  await pollFor("PendingDeletion after redelete", 15000, "S9-redelete", function () {',
  '    const rs = accountRows(a.conn);',
  '    return rs.length > 0 && rs[0].status.tag === "PendingDeletion" ? rs[0] : null;',
  '  });',
  '  emit("S9-redelete", del2.ok, { err: del2.err });',
  '  emit("S9-redelete-done", true, {});',
  '  await waitGo(4, 90000);',
  '  const term = await pollFor("terminal marker via my_account", 120000, "S9-terminal-seen", function () {',
  '    const rs = accountRows(a.conn);',
  '    return rs.length > 0 && rs[0].terminalAtMs !== null && rs[0].terminalAtMs !== undefined ? rs[0] : null;',
  '  });',
  '  emit("S9-terminal-seen", true, { terminal: String(term.terminalAtMs), requested: String(term.deletionRequestedAtMs) });',
  '  const lc = await tryReducer(a.conn.reducers.cancelAccountDeletion());',
  '  emit("S9-late-cancel", lc.ok === false && lc.err === ERR_TERMINAL, { err: lc.err });',
  '  const lx = await tryReducer(a.conn.reducers.requestDataExport());',
  '  emit("S9-late-export", lx.ok === false && String(lx.err).indexOf(ERR_EXPORT) !== -1, { err: lx.err });',
  '  emit("S9-cascade-done", true, {});',
  '  await waitGo(5, 150000);',
  '  const dAcct = accountRows(d2.conn);',
  '  emit("S9-D-still-active", dAcct.length === 1 && dAcct[0].status.tag === "Active" && (dAcct[0].terminalAtMs === null || dAcct[0].terminalAtMs === undefined), { rows: dAcct.length });',
  '  emit("S9-done", true, {});',
  '',
  '  clearTimeout(killer);',
  '  emit("done", true, {});',
  '  try { a.conn.disconnect(); } catch (ignored) {}',
  '  try { c.conn.disconnect(); } catch (ignored) {}',
  '  try { d2.conn.disconnect(); } catch (ignored) {}',
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

    // M22-S9 (ADR-0232 D1): compress the grace window + export chunk boundary
    // in the COPY so the real one-shot reaper and a real multi-chunk split run
    // inside the e2e. Both patchers throw on a missing/ambiguous needle.
    const deletionPath = path.join(tmp, 'game-core', 'src', 'accounts', 'deletion.rs');
    const deletionOrig = readFileSync(deletionPath, 'utf8');
    const deletionPatched = patchExportChunkRows(
      patchDeletionGrace(deletionOrig, E2E_GRACE_MS),
      E2E_CHUNK_ROWS,
    );
    if (deletionPatched === deletionOrig) {
      throw new Error('S9 grace/chunk patch was a no-op — refusing to publish (N4)');
    }
    writeFileSync(deletionPath, deletionPatched);

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
    // `.any()` membership check against the single patched entry has no match, so
    // client_connected returns Err (AUTH-3) and the host REFUSES the connection —
    // .onConnect never fires. The E-rejected milestone asserts that refusal. (The
    // deployment-time exact-equality tightening is 13r-c-2-gated and out of this
    // slice; the `.any()` check against a single entry already rejects a mismatch.)
    const jwtE = await mintJwt(stub.k1, 'e2e-k1', stub.iss1, 'erin-e2e', [WRONG_AUDIENCE]);

    const s9GoPrefix = path.join(tmp, 's9-go-');
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
        MR_S9_GO: s9GoPrefix,
        MR_S9_ERR_EXPORT: ERR_EXPORT_PENDING_DELETION_E2E,
        MR_S9_ERR_TERMINAL: ERR_ALREADY_DELETED_E2E,
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

    // ---- M22-S9 orchestration (ADR-0232) — runs CONCURRENTLY with the driver.
    // The driver blocks on go-files at each sync point; this side watches the
    // milestone stream, executes the owner-SQL seeding/snapshots, and releases
    // it. All failures are captured into s9.error and re-thrown after exit so
    // teardown and milestone forensics still happen.
    let driverGone = false;
    driver.on('exit', () => {
      driverGone = true;
    });
    const s9Sql = [];
    const s9G22Raw = [];
    const sqlJsonRows = (query) => {
      const res = run('spacetime', ['sql', '--format', 'json', '-s', dbUrl, DB_NAME, query], {
        timeout: 60_000,
      });
      if (!res.ok) throw new Error('sql-json failed (' + query + '): ' + res.stderr);
      s9Sql.push(query + ' => ' + res.stdout.trim().replace(/\s+/g, ' ').slice(0, 500));
      return decodeSqlJson(res.stdout);
    };
    const sqlDml = (stmt) => {
      const res = run('spacetime', ['sql', '-s', dbUrl, DB_NAME, stmt], { timeout: 60_000 });
      if (!res.ok) throw new Error('sql-dml failed (' + stmt.slice(0, 120) + '): ' + res.stderr);
    };
    const cnt = (q) => countFromRows(sqlJsonRows(q));
    const writeGo = (n) => writeFileSync(s9GoPrefix + n, '1');
    const waitEvent = async (name, ms) => {
      const t0 = Date.now();
      for (;;) {
        const ev = findS9Event(out, name);
        if (ev) {
          if (ev.ok !== true) {
            throw new Error(
              '[s9/orchestration] milestone ' +
                name +
                ' arrived ok:false: ' +
                JSON.stringify(ev.data),
            );
          }
          return ev;
        }
        if (driverGone) {
          throw new Error(
            '[s9/orchestration] driver exited before emitting ' +
              name +
              ' (stderr tail: ' +
              err.slice(-300) +
              ')',
          );
        }
        if (Date.now() - t0 > ms) {
          throw new Error('[s9/orchestration] ' + name + ' not observed within ' + ms + 'ms');
        }
        await sleep(500);
      }
    };
    const s9 = {
      pre: null,
      post: null,
      censusCancel: null,
      censusRedelete: null,
      error: null,
      refs: null,
      g22Tables: null,
    };
    const takeS9Snapshot = (entries, phase) => {
      const refs = s9.refs;
      const aCounts = {};
      const viaJoin = {};
      for (const e of entries) {
        if (e.policy !== 'Erase') continue;
        aCounts[e.table] = {};
        for (const c of e.cols) {
          aCounts[e.table][c] = cnt(
            'SELECT COUNT(*) AS n FROM ' + e.table + ' WHERE ' + c + ' = ' + refs.aHex,
          );
        }
      }
      if (phase === 'pre') {
        // Pin every ViaJoin parent key NOW: the post pass must ask about the
        // SAME rows the pre pass saw, never re-derive from post-cascade state.
        const players = sqlJsonRows('SELECT identity, entity_id FROM player').filter(
          (r) => identityCellHex(r.identity) === normHex(refs.aHex),
        );
        refs.entityId = players.length > 0 ? String(players[0].entity_id) : null;
        refs.tradeIds = sqlJsonRows(
          'SELECT trade_id FROM trade_offer WHERE initiator = ' + refs.aHex,
        ).map((r) => String(r.trade_id));
        refs.challengeIds = sqlJsonRows(
          'SELECT challenge_id FROM battle_challenge WHERE challenger = ' + refs.aHex,
        ).map((r) => String(r.challenge_id));
        const b1 = sqlJsonRows(
          'SELECT player_identity, opponent_identity FROM battle WHERE battle_id = ' +
            refs.battle1Id,
        );
        if (b1.length !== 1) throw new Error('[s9/snapshot] battle1 row not found at pre-snapshot');
        refs.b1Sides = {
          p: identityCellHex(b1[0].player_identity),
          o: identityCellHex(b1[0].opponent_identity),
        };
      }
      // Diagnostic dump both phases: the deadline table is tiny and its
      // scheduled_id/turn_number decide any [s9/viajoin-live] forensics.
      sqlJsonRows('SELECT scheduled_id, battle_id, turn_number FROM pvp_deadline_schedule');
      viaJoin.character =
        refs.entityId === null
          ? 0
          : cnt('SELECT COUNT(*) AS n FROM character WHERE entity_id = ' + refs.entityId);
      viaJoin.battle_wild = cnt(
        'SELECT COUNT(*) AS n FROM battle_wild WHERE battle_id = ' + refs.wildId,
      );
      viaJoin.pvp_deadline_schedule =
        cnt('SELECT COUNT(*) AS n FROM pvp_deadline_schedule WHERE battle_id = ' + refs.wildId) +
        cnt('SELECT COUNT(*) AS n FROM pvp_deadline_schedule WHERE battle_id = ' + refs.battle1Id);
      let chalSched = 0;
      for (const id of refs.challengeIds) {
        chalSched += cnt(
          'SELECT COUNT(*) AS n FROM battle_challenge_reaper_schedule WHERE challenge_id = ' + id,
        );
      }
      viaJoin.battle_challenge_reaper_schedule = chalSched;
      let tradeSched = 0;
      for (const id of refs.tradeIds) {
        tradeSched += cnt(
          'SELECT COUNT(*) AS n FROM trade_offer_reaper_schedule WHERE trade_id = ' + id,
        );
      }
      viaJoin.trade_offer_reaper_schedule = tradeSched;
      const dCounts = {
        monster: cnt('SELECT COUNT(*) AS n FROM monster WHERE owner_identity = ' + refs.dHex),
        monster_pub: cnt(
          'SELECT COUNT(*) AS n FROM monster_pub WHERE owner_identity = ' + refs.dHex,
        ),
        inventory: cnt('SELECT COUNT(*) AS n FROM inventory WHERE owner_identity = ' + refs.dHex),
        wallet: cnt('SELECT COUNT(*) AS n FROM player_wallet WHERE owner_identity = ' + refs.dHex),
        playtest: cnt('SELECT COUNT(*) AS n FROM playtest_event WHERE identity = ' + refs.dHex),
        player: cnt('SELECT COUNT(*) AS n FROM player WHERE identity = ' + refs.dHex),
        profile: cnt('SELECT COUNT(*) AS n FROM profile WHERE identity = ' + refs.dHex),
      };
      const world = {
        species: cnt('SELECT COUNT(*) AS n FROM species_row'),
        zones: cnt('SELECT COUNT(*) AS n FROM zone_def'),
        config: cnt('SELECT COUNT(*) AS n FROM config'),
      };
      const snap = { aCounts, viaJoin, dCounts, world };
      if (phase === 'pre') {
        const sqlCounts = {};
        for (const e of entries) {
          if (!e.exportable) continue;
          if (e.cols.length > 0) {
            let n = 0;
            for (const c of e.cols) {
              // `claimed_from` is the manifest's one Option<Identity> column;
              // 2.8.1 SQL cannot WHERE-match a sum-typed literal (probed 400).
              // A's own account row is counted via its plain `identity` column.
              if (e.table === 'account' && c === 'claimed_from') continue;
              n += cnt('SELECT COUNT(*) AS n FROM ' + e.table + ' WHERE ' + c + ' = ' + refs.aHex);
            }
            // Per-column sums equal the row count only because this seed never
            // places A on both identity columns of one row (documented).
            sqlCounts[e.table] = n;
          } else {
            sqlCounts[e.table] = viaJoin[e.table] === undefined ? 0 : viaJoin[e.table];
          }
        }
        snap.sqlCounts = sqlCounts;
      }
      if (phase === 'post') {
        const acct = sqlJsonRows(
          'SELECT auth_issuer, status, deletion_requested_at_ms, terminal_at_ms, claimed_from FROM account WHERE identity = ' +
            refs.aHex,
        );
        if (acct.length === 1) {
          const claimHex = optIdentityHex(acct[0].claimed_from);
          snap.account = {
            present: true,
            authIssuer: String(acct[0].auth_issuer),
            status: enumTagCell(acct[0].status, ['active', 'pendingDeletion']),
            requested: optI64Cell(acct[0].deletion_requested_at_ms),
            terminal: optI64Cell(acct[0].terminal_at_ms),
            claimRetained: claimHex !== null && claimHex === refs.bHex,
          };
        } else {
          snap.account = { present: false };
        }
        const pl = sqlJsonRows('SELECT name FROM player WHERE identity = ' + refs.aHex);
        snap.player =
          pl.length === 1 ? { present: true, name: String(pl[0].name) } : { present: false };
        const pr = sqlJsonRows('SELECT name FROM profile WHERE identity = ' + refs.aHex);
        snap.profile =
          pr.length === 1 ? { present: true, name: String(pr[0].name) } : { present: false };
        const b1 = sqlJsonRows(
          'SELECT player_identity, opponent_identity FROM battle WHERE battle_id = ' +
            refs.battle1Id,
        );
        if (b1.length === 1) {
          const now = {
            p: identityCellHex(b1[0].player_identity),
            o: identityCellHex(b1[0].opponent_identity),
          };
          const was = refs.b1Sides;
          const aHexBare = normHex(refs.aHex);
          const aSideKey = was.p === aHexBare ? 'p' : was.o === aHexBare ? 'o' : null;
          const dSideKey = aSideKey === 'p' ? 'o' : 'p';
          const tomb = normHex(TOMBSTONE_IDENTITY_HEX_E2E);
          snap.battle1 = {
            present: true,
            aSideTombstoned: aSideKey !== null && now[aSideKey] === tomb,
            dSideIntact: aSideKey !== null && now[dSideKey] === was[dSideKey],
          };
        } else {
          snap.battle1 = { present: false };
        }
        // Diagnostic dumps (cheap; land in s9Sql for failure forensics).
        sqlJsonRows('SELECT scheduled_id, battle_id, turn_number FROM pvp_deadline_schedule');
        sqlJsonRows('SELECT battle_id, player_identity, opponent_identity FROM battle');
        const dAcct = sqlJsonRows(
          'SELECT status, terminal_at_ms FROM account WHERE identity = ' + refs.dHex,
        );
        snap.dAccountActive =
          dAcct.length === 1 &&
          enumTagCell(dAcct[0].status, ['active', 'pendingDeletion']) === 'active' &&
          optI64Cell(dAcct[0].terminal_at_ms) === null;
      }
      return snap;
    };
    const s9Orchestration = (async () => {
      try {
        const entries = parseManifestTranscription(M22S9_MANIFEST_TRANSCRIPTION);
        const evPresence = await waitEvent('S9-presence-ready', 300_000);
        const evB = findS9Event(out, 'B-connect');
        if (!evB)
          throw new Error(
            '[s9/orchestration] B-connect never observed (needed for the claim-provenance assert)',
          );
        s9.refs = {
          aHex: '0x' + normHex(evPresence.data.a),
          dHex: '0x' + normHex(evPresence.data.d),
          bHex: normHex(evB.data.identity),
          battle1Id: String(evPresence.data.battle1Id),
          wildId: null,
          tradeIds: [],
          challengeIds: [],
          entityId: null,
          b1Sides: null,
        };
        // The G22 claim-flow truth must be read NOW (post-claim, pre-cascade):
        // after the S9 cascade the re-keyed monster is correctly ERASED, so a
        // post-exit read would fail the shipped G22 assertions for the wrong
        // reason. Captured with the same text-table reader G22 always used.
        s9.g22Tables = {
          account: sqlTable(
            dbUrl,
            'SELECT identity, claimed_from, claimed_at_ms FROM account',
            s9G22Raw,
          ),
          guestClaim: sqlTable(dbUrl, 'SELECT guest_identity, code FROM guest_claim', s9G22Raw),
          monster: sqlTable(dbUrl, 'SELECT owner_identity FROM monster', s9G22Raw),
        };
        for (const stmt of buildSeedStatements(s9.refs.aHex, 501, Date.now())) sqlDml(stmt);
        writeGo(1);
        const evSeed = await waitEvent('S9-seed-ready', 240_000);
        s9.refs.wildId = String(evSeed.data.wildBattleId);
        s9.pre = takeS9Snapshot(entries, 'pre');
        writeGo(2);
        await waitEvent('S9-cancel-done', 420_000);
        s9.censusCancel = cnt(
          'SELECT COUNT(*) AS n FROM account_deletion_reaper_schedule WHERE account_identity = ' +
            s9.refs.aHex,
        );
        writeGo(3);
        await waitEvent('S9-redelete-done', 120_000);
        s9.censusRedelete = cnt(
          'SELECT COUNT(*) AS n FROM account_deletion_reaper_schedule WHERE account_identity = ' +
            s9.refs.aHex,
        );
        writeGo(4);
        await waitEvent('S9-cascade-done', 300_000);
        s9.post = takeS9Snapshot(entries, 'post');
        writeGo(5);
      } catch (e) {
        s9.error = e;
        try {
          driver.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    })();
    const exitCode = await new Promise((resolve) => {
      const watchdog = setTimeout(() => {
        try {
          driver.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve('watchdog-timeout');
      }, 480_000);
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
    // The S9 orchestration's own failure is the ROOT CAUSE when the driver
    // stalls on a go-file — surface it before any milestone verdict can mask it.
    await s9Orchestration;
    if (s9.error) {
      throw new Error(
        'S9 orchestration failed: ' +
          (s9.error.message || String(s9.error)) +
          ' :: sql tail ' +
          s9Sql.slice(-6).join(' | '),
      );
    }
    const milestones = checkMilestones(events, { issuer: stub.iss1 });
    if (!milestones.ok) {
      const lastEvents = out
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .slice(-4)
        .join(' ~ ');
      throw new Error(
        `driver milestones: ${milestones.reason} (exit ${exitCode}; stderr tail: ${err.slice(-400)}; ` +
          `last events: ${lastEvents.slice(-900)})`,
      );
    }

    // --- host-side acceptance proof (F12) — pure fn, teeth-tested in phase 0 ---
    const acceptance = checkHostSideAcceptance(stub.reqLog);
    if (!acceptance.ok) throw new Error(acceptance.reason);

    // --- server truth ---
    const rawSql = s9G22Raw;
    const truth = checkSqlTruth(
      // Captured by the S9 orchestration at the presence-ready sync point —
      // post-claim, pre-cascade — which is the moment G22's assertions are
      // ABOUT. (The cascade later erases the re-keyed monster by design.)
      s9.g22Tables,
      {
        a: events.find((e) => e.step === 'A-connect').data.identity,
        b: events.find((e) => e.step === 'B-connect').data.identity,
        c: events.find((e) => e.step === 'C-connect').data.identity,
        d: events.find((e) => e.step === 'D-connect').data.identity,
      },
    );
    if (!truth.ok) throw new Error(`server truth: ${truth.reason} :: raw ${rawSql.join(' | ')}`);

    // ---- M22-S9 verdicts (ADR-0232) ----
    const s9m = checkS9Milestones(events, exitCode);
    if (!s9m.ok) throw new Error(s9m.reason + ' (stderr tail: ' + err.slice(-400) + ')');
    if (s9.censusCancel !== 0) {
      throw new Error(
        '[s9/disarm] ' +
          s9.censusCancel +
          ' deletion schedule row(s) survived the cancel — disarm is a no-op (PRV1-3)',
      );
    }
    if (s9.censusRedelete !== 1) {
      throw new Error(
        '[s9/rearm] expected exactly 1 deletion schedule row after redelete, found ' +
          s9.censusRedelete,
      );
    }
    const s9Entries = parseManifestTranscription(M22S9_MANIFEST_TRANSCRIPTION);
    const exportAssembly = checkExportAssembly(s9m.dataOf('S9-export-chunks').chunks, {
      exportableTables: s9Entries.filter((e) => e.exportable).map((e) => e.table),
      chunkRows: E2E_CHUNK_ROWS,
      sqlCounts: s9.pre.sqlCounts,
    });
    if (!exportAssembly.ok) throw new Error(exportAssembly.reason);
    const cascadeTruth = checkCascadeTruth({
      entries: s9Entries,
      pre: s9.pre,
      post: s9.post,
      allowlist: S9_VACUITY_ALLOWLIST,
      allowlistCap: S9_VACUITY_ALLOWLIST_CAP,
      seededFloor: S9_SEEDED_FLOOR,
      graceMs: E2E_GRACE_MS,
    });
    if (!cascadeTruth.ok) {
      const joinForensics = s9Sql
        .filter((l) => l.indexOf('deadline') !== -1 || l.indexOf('reaper_schedule') !== -1)
        .join(' | ');
      throw new Error(
        cascadeTruth.reason +
          ' :: join-forensics ' +
          joinForensics.slice(-1200) +
          ' :: sql tail ' +
          s9Sql.slice(-4).join(' | '),
      );
    }
    const s9Classified = s9Entries.filter((e) => e.policy !== 'NotOwned').length;

    return {
      ok: true,
      detail:
        `live flow green on issuer port ${issuerPort} / host port ${stdbPort} (tmp ${tmp}): ` +
        `${milestones.reason}; ${truth.reason}; ${s9m.reason}; ${exportAssembly.reason}; ` +
        'S9-CASCADE-VERIFIED(classified=' +
        s9Classified +
        ' ' +
        cascadeTruth.detail +
        `); ${notes.join('; ')}`,
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

  // --- M22-S9 teeth: every new pure decider must reject its known-bad input,
  // --- by the RIGHT clause tag (coarse fixtures prove only the first assert).
  {
    const mustThrow = (id, fn, tag) => {
      try {
        fn();
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (tag && msg.indexOf(tag) === -1) {
          return (
            'S9 ' +
            id +
            ': threw the WRONG failure (' +
            msg.slice(0, 140) +
            '), expected tag ' +
            tag
          );
        }
        return null;
      }
      return 'S9 ' + id + ': did not throw on a known-bad input';
    };
    const mustFail = (id, res, tag) => {
      if (res.ok !== false) return 'S9 ' + id + ': verdict was ok:true on a known-bad input';
      if (String(res.reason).indexOf(tag) === -1) {
        return (
          'S9 ' +
          id +
          ': failed with the WRONG clause (' +
          String(res.reason).slice(0, 160) +
          '), expected ' +
          tag
        );
      }
      return null;
    };
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const bad = [];

    // patchers
    bad.push(
      mustThrow(
        'patch-missing-grace',
        () => patchDeletionGrace('fn main() {}', 15000),
        'patchDeletionGrace',
      ),
    );
    bad.push(
      mustThrow(
        'patch-missing-chunk',
        () => patchExportChunkRows('fn main() {}', 2),
        'patchExportChunkRows',
      ),
    );
    bad.push(
      mustThrow(
        'patch-decoy-dup',
        () => patchDeletionGrace(GRACE_NEEDLE + '\n' + GRACE_NEEDLE, 15000),
        'MORE THAN ONCE',
      ),
    );
    bad.push(
      mustThrow('patch-bad-ms', () => patchDeletionGrace(GRACE_NEEDLE, 0), 'positive integer'),
    );
    {
      const patched = patchDeletionGrace('x\n' + GRACE_NEEDLE + '\ny', 15000);
      if (patched.indexOf(GRACE_NEEDLE) !== -1 || patched.indexOf('= 15000;') === -1) {
        bad.push('S9 patch-good: the grace patch did not swap the declaration value');
      }
      const patched2 = patchExportChunkRows('x\n' + CHUNK_NEEDLE + '\ny', 2);
      if (patched2.indexOf(CHUNK_NEEDLE) !== -1 || patched2.indexOf('u32 = 2;') === -1) {
        bad.push('S9 patch-good-chunk: the chunk patch did not swap the declaration value');
      }
    }

    // transcription parser
    {
      const mini = 'aaa:Erase:owner:1|bbb:NotOwned::0|ccc:ViaJoin(aaa)::0';
      const parsed = parseManifestTranscription(mini);
      if (parsed.length !== 3 || parsed[0].cols[0] !== 'owner' || parsed[2].parent !== 'aaa') {
        bad.push('S9 transcription-good: a well-formed mini transcription did not round-trip');
      }
      bad.push(
        mustThrow(
          'transcription-zero-cols',
          () => parseManifestTranscription('aaa:Erase::1'),
          '[s9/zero-owner-cols]',
        ),
      );
      bad.push(
        mustThrow(
          'transcription-dup',
          () => parseManifestTranscription('aaa:NotOwned::0|aaa:NotOwned::0'),
          'duplicate',
        ),
      );
      bad.push(
        mustThrow(
          'transcription-fields',
          () => parseManifestTranscription('aaa:Erase:owner'),
          '4 `:` fields',
        ),
      );
      bad.push(
        mustThrow(
          'transcription-policy',
          () => parseManifestTranscription('aaa:Nuke:owner:1'),
          'unknown policy',
        ),
      );
      bad.push(
        mustThrow(
          'transcription-orphan-parent',
          () => parseManifestTranscription('aaa:Erase(bbb):owner:1'),
          'non-ViaJoin',
        ),
      );
    }
    if (identityCellHex(['0xABCD']) !== 'abcd')
      bad.push('S9 cell-identity: array cell did not decode');
    if (
      optI64Cell({ some: 3 }) !== 3 ||
      optI64Cell({ none: [] }) !== null ||
      optI64Cell([0, 9]) !== 9 ||
      optI64Cell([1, []]) !== null
    )
      bad.push('S9 cell-opt: Option<i64> cells did not decode');
    if (
      enumTagCell({ pendingDeletion: [] }) !== 'pendingDeletion' ||
      enumTagCell([1, []], ['active', 'pendingDeletion']) !== 'pendingDeletion'
    )
      bad.push('S9 cell-enum: sum cell did not decode');
    if (
      optIdentityHex({ none: [] }) !== null ||
      optIdentityHex([0, ['0xAB']]) !== 'ab' ||
      optIdentityHex([1, []]) !== null
    )
      bad.push('S9 cell-opt-identity: none did not decode to null');
    bad.push(mustThrow('cell-enum-bad', () => enumTagCell({ a: 1, b: 2 }), '[s9/cell]'));
    bad.push(mustThrow('count-empty', () => countFromRows([]), '[s9/count-shape]'));
    bad.push(mustThrow('count-nan', () => countFromRows([{ n: 'x' }]), '[s9/count-shape]'));
    if (countFromRows([{ n: 7 }]) !== 7) bad.push('S9 count-good: COUNT row did not decode');

    // findS9Event
    {
      const stream =
        'noise\n{"broken json\n{"step":"S9-x","ok":true,"data":{"v":1}}\n{"step":"S9-x","ok":false,"data":{}}\n{"trunc';
      const ev = findS9Event(stream, 'S9-x');
      if (!ev || ev.ok !== true || ev.data.v !== 1)
        bad.push('S9 find-event: first well-formed match not returned');
      if (findS9Event(stream, 'S9-absent') !== null)
        bad.push('S9 find-event-absent: invented an event');
    }

    // buildSeedStatements
    {
      const hex = '0x' + 'ab'.repeat(32);
      const stmts = buildSeedStatements(hex, 501, 1_700_000_000_000);
      if (stmts.length !== 19)
        bad.push('S9 seed-count: expected 19 statements, got ' + stmts.length);
      if (stmts.some((st) => st.indexOf(hex) === -1))
        bad.push('S9 seed-identity: a seed statement lacks the subject identity');
      const playtestRows =
        stmts
          .slice(8)
          .join(' ')
          .split('(0, ' + hex).length - 1;
      if (playtestRows !== 501)
        bad.push('S9 seed-rows: expected 501 playtest rows, counted ' + playtestRows);
      bad.push(
        mustThrow(
          'seed-too-few',
          () => buildSeedStatements(hex, 500, 1_700_000_000_000),
          'exceed 500',
        ),
      );
      bad.push(
        mustThrow(
          'seed-bad-hex',
          () => buildSeedStatements('0xzz', 501, 1_700_000_000_000),
          'lowercase hex',
        ),
      );
      bad.push(mustThrow('seed-epoch-base', () => buildSeedStatements(hex, 501, 1000), 'epoch-ms'));
    }

    // checkS9Milestones
    {
      const good = [{ step: 'A-connect', ok: true, data: {} }].concat(
        S9_MILESTONES.map((step) => ({ step, ok: true, data: {} })),
      );
      const g = checkS9Milestones(good, 0);
      if (g.ok !== true)
        bad.push('S9 milestones-good: a complete roster was rejected: ' + g.reason);
      bad.push(
        mustFail(
          'milestones-okfalse',
          checkS9Milestones(
            good.map((e, i) => (i === 3 ? { ...e, ok: false } : e)),
            0,
          ),
          '[s9/milestones]',
        ),
      );
      bad.push(
        mustFail('milestones-missing', checkS9Milestones(good.slice(0, -1), 0), '[s9/milestones]'),
      );
      {
        const swapped = clone(good);
        const t = swapped[4];
        swapped[4] = swapped[5];
        swapped[5] = t;
        bad.push(mustFail('milestones-order', checkS9Milestones(swapped, 0), '[s9/milestones]'));
      }
      bad.push(
        mustFail(
          'milestones-dup',
          checkS9Milestones(good.concat([{ step: 'S9-done', ok: true, data: {} }]), 0),
          'duplicate',
        ),
      );
      bad.push(
        mustFail(
          'milestones-unknown',
          checkS9Milestones(good.concat([{ step: 'S9-extra', ok: true, data: {} }]), 0),
          '[s9/milestones]',
        ),
      );
      bad.push(mustFail('milestones-exit', checkS9Milestones(good, 1), '[s9/driver-exit]'));
    }

    // checkExportAssembly
    {
      const goodChunks = [
        { t: 'ta', i: 0, n: 3, req: '9', rows: 2, seedField: false },
        { t: 'ta', i: 1, n: 3, req: '9', rows: 1, seedField: false },
        { t: 'tb', i: 2, n: 3, req: '9', rows: 1, seedField: false },
      ];
      const exp = { exportableTables: ['ta', 'tb'], chunkRows: 2, sqlCounts: { ta: 3, tb: 1 } };
      const g = checkExportAssembly(goodChunks, exp);
      if (g.ok !== true) bad.push('S9 export-good: a correct assembly was rejected: ' + g.reason);
      const mut = (fn) => {
        const c = clone(goodChunks);
        fn(c);
        return c;
      };
      bad.push(
        mustFail(
          'export-two-reqs',
          checkExportAssembly(
            mut((c) => (c[1].req = '8')),
            exp,
          ),
          '[s9/export-request-id]',
        ),
      );
      bad.push(
        mustFail(
          'export-gap',
          checkExportAssembly(
            mut((c) => (c[1].i = 5)),
            exp,
          ),
          '[s9/export-contiguity]',
        ),
      );
      bad.push(
        mustFail(
          'export-total',
          checkExportAssembly(
            mut((c) => (c[1].n = 4)),
            exp,
          ),
          '[s9/export-total]',
        ),
      );
      bad.push(
        mustFail(
          'export-parse',
          checkExportAssembly(
            mut((c) => (c[1].rows = -1)),
            exp,
          ),
          '[s9/export-parse]',
        ),
      );
      bad.push(
        mustFail(
          'export-seed',
          checkExportAssembly(
            mut((c) => (c[2].seedField = true)),
            exp,
          ),
          '[s9/export-seed-leak]',
        ),
      );
      bad.push(
        mustFail(
          'export-missing-table',
          checkExportAssembly(
            [
              { t: 'ta', i: 0, n: 2, req: '9', rows: 2, seedField: false },
              { t: 'ta', i: 1, n: 2, req: '9', rows: 1, seedField: false },
            ],
            exp,
          ),
          '[s9/export-missing-table]',
        ),
      );
      bad.push(
        mustFail(
          'export-extra-table',
          checkExportAssembly(
            mut((c) => (c[2].t = 'tc')),
            exp,
          ),
          '[s9/export-',
        ),
      );
      bad.push(
        mustFail(
          'export-underfull',
          checkExportAssembly(
            mut((c) => {
              c[0].rows = 1;
              c[1].rows = 2;
            }),
            exp,
          ),
          '[s9/export-chunk-fill]',
        ),
      );
      bad.push(
        mustFail(
          'export-reconcile',
          checkExportAssembly(goodChunks, { ...exp, sqlCounts: { ta: 4, tb: 1 } }),
          '[s9/export-reconcile]',
        ),
      );
      bad.push(
        mustFail(
          'export-no-split',
          checkExportAssembly(
            [
              { t: 'ta', i: 0, n: 2, req: '9', rows: 1, seedField: false },
              { t: 'tb', i: 1, n: 2, req: '9', rows: 1, seedField: false },
            ],
            { exportableTables: ['ta', 'tb'], chunkRows: 2, sqlCounts: { ta: 1, tb: 1 } },
          ),
          '[s9/export-no-split]',
        ),
      );
    }

    // checkCascadeTruth — the 8 registered cheat shapes plus its own clauses
    {
      const mkFix = () => {
        const entries = [];
        for (let i = 1; i <= 13; i++)
          entries.push({
            table: 'e' + i,
            policy: 'Erase',
            parent: null,
            cols: ['owner'],
            exportable: true,
          });
        for (const t of ['account', 'player', 'profile', 'battle'])
          entries.push({
            table: t,
            policy: 'Anonymize',
            parent: null,
            cols: ['identity'],
            exportable: true,
          });
        for (const t of ['v1', 'v2', 'v3', 'v4', 'v5'])
          entries.push({ table: t, policy: 'ViaJoin', parent: 'e1', cols: [], exportable: false });
        for (let i = 1; i <= 18; i++)
          entries.push({
            table: 'n' + i,
            policy: 'NotOwned',
            parent: null,
            cols: [],
            exportable: false,
          });
        const aPre = {};
        const aPost = {};
        for (let i = 1; i <= 13; i++) {
          aPre['e' + i] = { owner: 40 };
          aPost['e' + i] = { owner: 0 };
        }
        return {
          entries,
          pre: {
            aCounts: aPre,
            viaJoin: { v1: 1, v2: 1, v3: 0, v4: 1, v5: 1 },
            dCounts: { monster: 2, player: 1 },
            world: { species: 5, zones: 2, config: 1 },
          },
          post: {
            aCounts: aPost,
            viaJoin: { v1: 0, v2: 0, v3: 0, v4: 0, v5: 0 },
            dCounts: { monster: 2, player: 1 },
            world: { species: 5, zones: 2, config: 1 },
            account: {
              present: true,
              authIssuer: TOMBSTONE_AUTH_ISSUER_E2E,
              status: 'pendingDeletion',
              requested: 1_700_000_000_000,
              terminal: 1_700_000_000_000 + E2E_GRACE_MS,
              claimRetained: true,
            },
            player: { present: true, name: TOMBSTONE_DISPLAY_NAME_E2E },
            profile: { present: true, name: TOMBSTONE_DISPLAY_NAME_E2E },
            battle1: { present: true, aSideTombstoned: true, dSideIntact: true },
            dAccountActive: true,
          },
          allowlist: [
            ['v3', 'fixture: this join-only table is legitimately empty in the synthetic run'],
          ],
          allowlistCap: 3,
          seededFloor: 520,
          graceMs: E2E_GRACE_MS,
        };
      };
      const g = checkCascadeTruth(mkFix());
      if (g.ok !== true) bad.push('S9 truth-good: a correct cascade was rejected: ' + g.reason);
      else if (g.vacuous.join(',') !== 'v3')
        bad.push('S9 truth-good: vacuous list wrong: ' + g.vacuous.join(','));
      const mutT = (fn) => {
        const f = mkFix();
        fn(f);
        return checkCascadeTruth(f);
      };
      bad.push(
        mustFail(
          'truth-census',
          mutT((f) => f.entries.pop()),
          '[s9/census]',
        ),
      );
      bad.push(
        mustFail(
          'truth-survivor',
          mutT((f) => (f.post.aCounts.e1.owner = 3)),
          '[s9/erase-survivor]',
        ),
      );
      bad.push(
        mustFail(
          'truth-erase-nothing-stamp-terminal',
          mutT((f) => {
            f.post.aCounts = clone(f.pre.aCounts);
          }),
          '[s9/erase-survivor]',
        ),
      );
      bad.push(
        mustFail(
          'truth-unattempted',
          mutT((f) => delete f.post.aCounts.e2),
          '[s9/unattempted]',
        ),
      );
      bad.push(
        mustFail(
          'truth-viajoin',
          mutT((f) => (f.post.viaJoin.v1 = 1)),
          '[s9/viajoin-live]',
        ),
      );
      bad.push(
        mustFail(
          'truth-account-gone',
          mutT((f) => (f.post.account = { present: false })),
          '[s9/account-tombstone]',
        ),
      );
      bad.push(
        mustFail(
          'truth-issuer',
          mutT((f) => (f.post.account.authIssuer = 'x')),
          '[s9/account-tombstone]',
        ),
      );
      bad.push(
        mustFail(
          'truth-provenance',
          mutT((f) => (f.post.account.claimRetained = false)),
          '[s9/account-provenance]',
        ),
      );
      bad.push(
        mustFail(
          'truth-grace',
          mutT((f) => (f.post.account.terminal = f.post.account.requested + E2E_GRACE_MS - 1)),
          '[s9/grace-honored]',
        ),
      );
      bad.push(
        mustFail(
          'truth-player',
          mutT((f) => (f.post.player = { present: false })),
          '[s9/player-tombstone]',
        ),
      );
      bad.push(
        mustFail(
          'truth-battle-over-anon',
          mutT((f) => (f.post.battle1.dSideIntact = false)),
          '[s9/battle-anonymize]',
        ),
      );
      bad.push(
        mustFail(
          'truth-erase-everything',
          mutT((f) => (f.post.world.species = 0)),
          '[s9/world-nuked]',
        ),
      );
      bad.push(
        mustFail(
          'truth-bystander',
          mutT((f) => (f.post.dCounts.monster = 0)),
          '[s9/bystander]',
        ),
      );
      bad.push(
        mustFail(
          'truth-vacuous-unlisted',
          mutT((f) => {
            f.pre.aCounts.e5.owner = 0;
            f.pre.aCounts.e6.owner = 80;
          }),
          '[s9/vacuous]',
        ),
      );
      bad.push(
        mustFail(
          'truth-floor',
          mutT((f) => {
            for (let i = 1; i <= 13; i++) f.pre.aCounts['e' + i].owner = 20;
          }),
          '[s9/seed-floor]',
        ),
      );
      bad.push(
        mustFail(
          'truth-allowlist-cap',
          mutT((f) => {
            f.allowlist = [
              ['v3', 'reason long enough one'],
              ['x1', 'reason long enough two'],
              ['x2', 'reason long enough three'],
              ['x3', 'reason long enough four'],
            ];
          }),
          '[s9/allowlist-cap]',
        ),
      );
      bad.push(
        mustFail(
          'truth-anonymize-unhandled',
          mutT((f) => {
            f.entries[39] = {
              table: 'n18',
              policy: 'Anonymize',
              parent: null,
              cols: ['x'],
              exportable: false,
            };
          }),
          '[s9/anonymize-unhandled]',
        ),
      );
    }

    // The shipped allowlist itself must clear the cap + reason floor, and the
    // roster must stay count-pinned so a dropped driver step cannot vanish.
    if (S9_VACUITY_ALLOWLIST.length > S9_VACUITY_ALLOWLIST_CAP) {
      bad.push('S9 allowlist: the SHIPPED allowlist exceeds its own cap');
    }
    if (S9_MILESTONES.length !== 25) {
      bad.push(
        'S9 roster: expected 25 S9 milestones, found ' +
          S9_MILESTONES.length +
          ' — a dropped step silently unrequires itself',
      );
    }

    const firstBad = bad.find((x) => x !== null && x !== undefined);
    if (firstBad) return teeth('S9', firstBad);
  }

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
        'E-accepted',
        mutateEvent('E-rejected', { ok: false, data: { rejected: false } }),
        'a CORRECT-issuer but WRONG-audience token that was ACCEPTED at connect (not refused) ' +
          'was passed — audience_allowed let a token minted for another application connect ' +
          '(AUTH-3 / D18/CRITICAL-2)',
      ],
      [
        'E-rejected-inconsistent',
        // ok:true (passes the generic per-milestone ok-check) but rejected:false —
        // exercises the DEDICATED E clause, which must catch a driver that reports
        // success while actually having connected the wrong-audience token.
        mutateEvent('E-rejected', { ok: true, data: { rejected: false } }),
        'an E-rejected milestone claiming success but carrying rejected:false was accepted — the ' +
          'dedicated audience clause must not trust the ok flag alone',
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
    // A present Option<Identity> (`claimed_from`) renders wrapped; it must unwrap
    // to its bare hex, else the AUTH-21 provenance check false-reds on a real claim.
    if (!identityMatches('(some = (__identity__ = 0x' + GOOD_ID_A + '))', GOOD_ID_A))
      return teeth(
        'sql-id-option-wrap',
        'a present Option<Identity> did not unwrap to its bare hex',
      );
    if (looksLikeIdentity('(some = (__identity__ = 0x' + GOOD_ID_A + '))') !== true)
      return teeth(
        'sql-id-option-shape',
        'a wrapped present Option<Identity> was not recognized as identity-shaped',
      );
    // Option<i64> present (`claimed_at_ms`) renders "(some = <digits>)" — it must
    // unwrap to a timestamp, while (none) stays rejected.
    if (!looksLikeEpochMs('(some = 1786365710766)'))
      return teeth(
        'sql-epoch-option-wrap',
        'a present Option<i64> claimed_at_ms did not unwrap to a timestamp',
      );
    if (looksLikeEpochMs('(none)'))
      return teeth('sql-epoch-null', 'a (none) claimed_at_ms parsed as a timestamp');
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

  // --- G24 checker fixtures (M22 PRV1-18: deletion & backup retention) ---
  {
    const g24 = g24Teeth();
    // TWO floors, because the aggregate one alone is satisfiable by a gutted
    // suite: the artifact red-team MEASURED that deleting 17 of the 18
    // negative fixtures still reports 16/16 ALL-BIT, since the 13 EXTRA_CHECKS
    // plus the two guards clear the aggregate on their own. The per-term
    // negative fixtures are the coverage that actually proves each ANDed
    // clause term bites, so they get a floor of their own.
    if (G24_BAD_FIXTURES.length < 20) {
      return teeth(
        'g24-fixture-floor',
        `G24_BAD_FIXTURES holds only ${G24_BAD_FIXTURES.length} negative fixtures — the ` +
          'floor is 20, one per ANDed clause term plus the fail-loud cases and the ' +
          'fenced-block bypass. Removing one ' +
          "term's fixture is how a multi-term clause silently degrades to a partial AND",
      );
    }
    if (g24.total < G24_TEETH_FLOOR) {
      return teeth(
        'g24-floor',
        `g24Teeth() reports only ${g24.total} teeth, below the floor of ${G24_TEETH_FLOOR} — ` +
          'a future edit shrank the suite. The fixture-count floor above does not cover the ' +
          'EXTRA_CHECKS half, so this one guards it; that shrinkage is itself the failure, ' +
          'not a silent no-op',
      );
    }
    if (g24.bit !== g24.total) {
      return teeth('g24', g24.firstMiss || `${g24.bit}/${g24.total} g24 teeth bit`);
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

  // G24 against the REAL runbook, same unconditional placement as G23.
  let deletionSources;
  try {
    deletionSources = readDeletionCitationSources();
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `G24: readDeletionCitationSources failed: ${err?.message ?? String(err)}`,
    };
  }
  const g24Real = checkDrRunbookDeletionSection(runbook, deletionSources);
  if (!g24Real.ok) {
    return {
      name,
      pass: false,
      detail:
        `G24 (${RUNBOOK_PATH}): ${g24Real.reason} — account deletion does not ship ` +
        'without a stated backup/pseudonymization limitation, a cited grace window, and a cited ' +
        'reaper/export chain (M22 PRV1-18, ADR-0230).',
    };
  }
  const g24Detail = `G24 green (${g24Real.clausesMet}/6 clauses, ${g24Real.resolved}/${DELETION_CITATIONS.length} citations)`;

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
        `G23 green (${g23.reason}); ${g24Detail}; ${ciOrder.reason}; all phase-0 teeth bite. Live phase ` +
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
    detail: `G23 green (${g23.reason}); ${g24Detail}; ${ciOrder.reason}; G22 ${live.detail}`,
  };
}
