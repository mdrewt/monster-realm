// G22 — the account/claim end-to-end gate (live flow only).
//
// G22 (AUTH-39..60, ADR-0182): the guest-to-account claim is the one flow in
// this repo where a silent regression costs a player their save. The native-host
// suite (accounts_tests.rs) executes the reducers against an in-memory host; it
// cannot observe what actually breaks in production: a real JWT, minted by a real
// issuer, verified by a real SpacetimeDB host, provisioning a real account row,
// a real re-key moving a real monster from one Identity to another, and the
// deletion cascade / export over live SQL — including transactional rollback,
// which the in-memory host does not model. This eval stands that stack up on
// ephemeral ports and asserts it.
//
//   hasCli            -> RUN, fail loud on any step
//   !hasCli && CI     -> FAIL LOUD (the CI toolchain install regressed)
//   !hasCli && !CI    -> note-skip, pass:true
//
// The live flow's decisions are PURE functions over data (checkMilestones over
// the driver's NDJSON, checkSqlTruth / checkCascadeTruth over parsed SQL rows);
// the rig moves bytes.
//
// SAFETY RULES OBSERVED IN THIS FILE:
//   - literal regexes only; matching prefers indexOf/split/includes (semgrep
//     detect-non-literal-regexp is remote-only).
//   - no scheme literal anywhere, INCLUDING in comments. Every URL is assembled
//     from parts, mirroring the `concat!()` idiom accounts.rs uses.
//   - any credential-shaped fixture value uses the INTERNAL_SECRET_ prefix
//     allowlisted in .gitleaks.toml.
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

// ---------------------------------------------------------------------------
// Contract constants — every one of these is a VALUE PIN against a committed
// source location, not a paraphrase.
// ---------------------------------------------------------------------------

// accounts.rs:61 — the shared reject reason for a malformed, never-existed OR
// already-consumed code. AUTH-35's no-oracle property IS this string being the
// same in both cases, which is exactly what N2/N3 assert.
export const ERR_INVALID_CODE = 'invalid or already-used code';
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

// THE 43-entry data-lifecycle transcription (schema.rs DATA_LIFECYCLE_MANIFEST
// + the S6 typespace walk's identity-column names), one biome-stable string:
// entries sorted by table, `table:Policy[(parent)]:col1+col2:1|0`, '|'-joined.
// Erase/Anonymize entries MUST carry >=1 column (red-team CRITICAL-1: a
// zero-column entry is an UNATTEMPTED table, invisible to the vacuity list).
export const M22S9_MANIFEST_TRANSCRIPTION =
  'account:Anonymize:claimed_from+identity:1|account_deletion_reaper_schedule:NotOwned::0|battle:Anonymize:opponent_identity+player_identity:1|battle_action:Erase:player_identity:1|battle_challenge:Erase:challenger+target:1|battle_challenge_reaper_schedule:ViaJoin(battle_challenge)::0|battle_wild:ViaJoin(battle)::0|character:ViaJoin(player)::1|config:NotOwned::0|encounter:NotOwned::0|evolution_path:NotOwned::0|export_bundle:Erase:owner_identity:0|export_bundle_reaper_schedule:NotOwned::0|guest_claim:NotOwned::0|guest_claim_reaper_schedule:NotOwned::0|heal_cooldown:Erase:owner_identity:1|heal_location_row:NotOwned::0|inventory:Erase:owner_identity:1|item_row:NotOwned::0|monster:Erase:owner_identity:1|monster_pub:Erase:owner_identity:1|movement_tick_schedule:NotOwned::0|mr_heartbeat_schedule:NotOwned::0|npc:NotOwned::0|pending_evolution_notice:Erase:owner_identity:0|player:Anonymize:identity:1|player_conversation:Erase:owner_identity:1|player_dialogue_state:Erase:owner_identity:1|player_quest:Erase:owner_identity:1|player_session:Erase:identity:0|player_wallet:Erase:owner_identity:1|playtest_event:Erase:identity:1|playtest_reaper_schedule:NotOwned::0|profile:Anonymize:identity:1|pvp_deadline_schedule:ViaJoin(battle)::0|shop_item_row:NotOwned::0|shop_row:NotOwned::0|skill_row:NotOwned::0|species_row:NotOwned::0|trade_offer:Erase:counterparty+initiator:1|trade_offer_reaper_schedule:ViaJoin(trade_offer)::0|type_relation_row:NotOwned::0|zone_def:NotOwned::0';

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
    'the turn-0 deadline row self-consumes at its 60s fire time (reaper no-ops on a terminal battle; the runtime deletes the fired one-shot), so a slow run may pre-snapshot AFTER it fired; on fast runs it is present and its cascade disarm is asserted via the post count',
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
  'S9-evolve-notice',
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
// PURE FUNCTIONS — the live flow's decisions, expressed over data.
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
// decision is a pure function over the parsed rows.
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
  if (!Array.isArray(entries) || entries.length !== 43) {
    return fail(
      '[s9/census] transcription entries: ' + (entries ? entries.length : 'none') + ', expected 43',
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
      '[s9/battle-anonymize-gone] the terminal PvP battle row is GONE — Anonymize must never delete',
    );
  }
  if (post.battle1.aSideTombstoned !== true) {
    return fail(
      '[s9/battle-anonymize-side-a] the deleted side of the terminal battle was not swapped to the tombstone identity',
    );
  }
  if (post.battle1.dSideIntact !== true) {
    return fail(
      '[s9/battle-anonymize-side-b] the SURVIVING side of the terminal battle changed — over-anonymization is a failure, not a pass',
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
    reason: 'cascade truth held over 43 classified entries',
    vacuous,
    detail: 'seeded=' + seededSum + ' vacuous=[' + vacuous.join(',') + ']',
  };
}

/**
 * Build the owner-SQL seed statements for the subject (pure — the rig executes
 * them). >500 playtest_event rows (batched) + wallet + inventory + conversation
 * + quest + heal_cooldown, plus the two column bumps that make the subject's
 * starter monster evolvable. player_dialogue_state is NOT here (Vec<String>
 * columns are not DML-expressible — probed 400; declared on the vacuity
 * allowlist instead).
 *
 * `aMonsterId` (20r-d, ADR-0254): the subject's own starter monster id, as a
 * DECIMAL STRING — the driver emits it through the `S9-presence-ready` payload
 * because the SDK hands it over as a BigInt, and a Number round-trip would
 * silently lose precision on a large auto_inc id. It drives the two
 * monster-keyed UPDATEs that open content evolution edge 2, which is what lets
 * the driver's `S9-evolve-notice` step evolve species 1 -> 5 and so write a
 * REAL `pending_evolution_notice` row before the cascade. A `Vec<struct>`
 * column is not DML-insertable, so this organic write is the only way that
 * table can carry a pre-cascade row at all (the vacuity allowlist is
 * hard-capped at 3 and full).
 */
export function buildSeedStatements(aHex, playtestRows, baseMs, aMonsterId) {
  if (typeof aHex !== 'string' || !/^0x[0-9a-f]{64}$/.test(aHex)) {
    throw new Error('[s9/seed-build] subject identity is not 0x + 64 lowercase hex: ' + aHex);
  }
  if (typeof aMonsterId !== 'string' || !/^[1-9][0-9]*$/.test(aMonsterId)) {
    throw new Error(
      '[s9/seed-build] subject monster id must be a positive decimal string, got ' + aMonsterId,
    );
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
  // 20r-d (ADR-0254): the ONE organic pre-cascade writer for
  // `pending_evolution_notice`. `UPDATE <table> SET <col> = <literal> WHERE
  // <col> = <literal>` is measured-expressible on spacetime 2.8.1 (an INSERT
  // is not: the row's `entries` column is a Vec of a nested SpacetimeType).
  //
  // THE EDGE IS CONTENT EDGE 2 (species 1 -> 5 Embersworn), NOT the level-20
  // edge 1, and that choice is MEASURED, not stylistic: `roll_encounter`
  // filters the zone table by the PLAYER's own level, zone 0's three bands top
  // out at level 8, and a level-20 subject therefore makes zone 0 permanently
  // silent — the later `S9-wild-live` step then burns all 80 shuttle steps
  // without an encounter (measured twice). Edge 2 asks for `min_level: 1`,
  // 150 Fire essence and Trust >= Friendly, so it leaves the subject's LEVEL
  // untouched and the wild encounter reachable.
  //
  // Trust is smoothed: `(fav + 10) / (fav + unfav + 20)`, so 40 favorable and
  // 0 unfavorable events read as 83% = Devoted, comfortably past Friendly's
  // 60% floor. Two single-assignment UPDATEs rather than one two-assignment
  // statement: the single-column form is the one this rig has measured.
  stmts.push('UPDATE monster SET essence_fire = 150 WHERE monster_id = ' + aMonsterId);
  stmts.push('UPDATE monster SET trust_favorable_count = 40 WHERE monster_id = ' + aMonsterId);
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

// Spec §9 residual risk 1, required-exact language. Imported by
// client/src/ui/privacyBanner.test.ts, which pins the in-app wording to it. It
// must never acquire a `\\` escape (a formatter escaping an apostrophe has
// truncated a text pin in this repo before); the quote style is biome's.
export const PIN_PSEUDONYMIZATION =
  'Direct name/display fields are severed on deletion. The `Identity` key and its associated timestamps/behavioral history are not purged from multi-user or historical rows; this is a documented, accepted pseudonymization limitation, not erasure.';

// ===========================================================================
// LIVE RIG — imperative, isolated below every pure decision.
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
  '  await applied(a.conn, ["SELECT * FROM my_battle", "SELECT * FROM my_monster_pub", "SELECT * FROM my_export_bundle", "SELECT * FROM battle_challenge", "SELECT * FROM trade_offer", "SELECT * FROM player", "SELECT * FROM my_pending_evolution_notices"]);',
  '  const aJoin = await tryReducer(a.conn.reducers.joinGame({ name: "alice s9" }));',
  '  emit("S9-A-join", aJoin.ok, aJoin);',
  '  const aMon = iterRows(a.conn, "my_monster_pub").filter(function (r) { return stripHexS9(r.ownerIdentity.toHexString()) === stripHexS9(a.identity); });',
  '  if (aMon.length === 0) bail("S9-A-join", "A owns no monster after join (claim re-key + join both failed to grant)");',
  '  const aMonId = aMon[0].monsterId;',
  '  // Challenge DIRECTION is load-bearing (ADR-0232 F1): battle1 must carry',
  '  // player_identity = D so the cascade 6a wild write-back GC (ADR-0077',
  '  // keep-latest, keyed on the WILD battle PLAYER axis = A) cannot delete the',
  '  // terminal PvP battle the Anonymize assert needs; the opponent-axis GC',
  '  // skips WILD battles by construction.',
  '  const dMonPre = iterRows(d.conn, "my_monster_pub").filter(function (r) { return stripHexS9(r.ownerIdentity.toHexString()) === stripHexS9(d.identity); });',
  '  if (dMonPre.length === 0) bail("S9-challenge1", "D owns no monster after join");',
  '  const ch1 = await tryReducer(d.conn.reducers.challengePvp({ target: a.idObj, partyIds: [dMonPre[0].monsterId] }));',
  '  emit("S9-challenge1", ch1.ok, ch1);',
  '  const ch1Row = await pollFor("incoming challenge on A", 20000, "S9-accept1", function () {',
  '    const rows = iterRows(a.conn, "battle_challenge").filter(function (r) { return stripHexS9(r.target.toHexString()) === stripHexS9(a.identity); });',
  '    return rows.length > 0 ? rows[0] : null;',
  '  });',
  '  const acc1 = await tryReducer(a.conn.reducers.acceptChallenge({ challengeId: ch1Row.challengeId, partyIds: [aMonId] }));',
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
  '  emit("S9-presence-ready", true, { a: a.identity, d: d2.identity, battle1Id: String(b1.battleId), monsterId: String(aMonId) });',
  '  await waitGo(1, 90000);',
  '  // 20r-d (ADR-0254): the post-evolve reveal queue, proven ORGANICALLY. The',
  '  // go-1 seed gave this monster 150 Fire essence and a Devoted Trust ratio,',
  '  // so content edge 2 (species 1 -> 5 Embersworn, min_level 1) is now the',
  '  // ONLY satisfiable edge out of species 1 — the other two need level 20,',
  '  // which would silence zone 0 and starve the wild encounter below. Species',
  '  // 5 has no outgoing edge and the transform zeroes essence, so the chain',
  '  // applies EXACTLY one step, the queue holds exactly one entry, and no',
  '  // auto-evolution can fire later from the movement tail. It runs BEFORE the',
  '  // trade and the wild battle: evolve is battle- and trade-escrow guarded,',
  '  // and both of those open below. The view rides the ONE subscribe list',
  '  // above — a SECOND subscribe() call on the same connection is an',
  '  // additional subscription, not a wider one.',
  '  const evo = await tryReducer(a.conn.reducers.evolve({ monsterId: aMonId, toSpecies: 5 }));',
  '  if (!evo.ok) bail("S9-evolve-notice", "evolve rejected: " + evo.err);',
  '  const notice = await pollFor("pending evolution notice on A", 20000, "S9-evolve-notice", function () {',
  '    const rows = iterRows(a.conn, "my_pending_evolution_notices").filter(function (r) { return stripHexS9(r.ownerIdentity.toHexString()) === stripHexS9(a.identity); });',
  '    return rows.length > 0 && rows[0].entries.length >= 1 ? rows[0] : null;',
  '  });',
  '  emit("S9-evolve-notice", true, { entries: notice.entries.length });',
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
          aMonsterId: String(evPresence.data.monsterId),
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
        for (const stmt of buildSeedStatements(s9.refs.aHex, 501, Date.now(), s9.refs.aMonsterId))
          sqlDml(stmt);
        writeGo(1);
        const evSeed = await waitEvent('S9-seed-ready', 240_000);
        s9.refs.wildId = String(evSeed.data.wildBattleId);
        s9.pre = takeS9Snapshot(entries, 'pre');
        writeGo(2);
        await waitEvent('S9-cancel-done', 420_000);
        // export_bundle rows are created AFTER the go2 pre-snapshot (the export
        // is S9-11), so its honest pre-cascade count is sampled HERE — after the
        // export, before the cascade (the reaper fires 15 s after the REDELETE).
        s9.pre.aCounts.export_bundle = {
          owner_identity: cnt(
            'SELECT COUNT(*) AS n FROM export_bundle WHERE owner_identity = ' + s9.refs.aHex,
          ),
        };
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

    // --- host-side acceptance proof (F12) — pure fn ---
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
  const name = 'account-e2e (G22 live claim flow)';

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
        'Live phase note-skipped: no live toolchain locally ' +
        `(spacetime=${hasSpacetime}, cargo=${hasCargo}).`,
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
    detail: `G22 ${live.detail}`,
  };
}
