// playtest-report.mjs — pt-b2 server observability (ADR-0131)
//
// Aggregates the PRIVATE `playtest_event` table into the GDD §4 H1/H2 proxy
// report (weaken-first / success / bait / recatch rates). The raw per-identity
// rows never leave the server via a client subscription (the table is private);
// this offline read is the ONLY intended consumer, and it aggregates to RATES
// only — never relaying a raw identity (PII firewall).
//
// Functional-core / imperative-shell: `aggregateReport`, `sortByEventId`,
// `decodeSqlJson` and `coerceRow` are pure exported fns (unit-gated by
// evals/playtest-report.eval.mjs); the live `spacetime` SQL I/O runs only in
// the main-guarded driver at the bottom.
//
// NO `new RegExp(...)` anywhere (Semgrep detect-non-literal-regexp — 3x bites):
// literal patterns + String methods only. `execFileSync` (array args, no shell)
// is the safe child-process form — the DB name is never spliced into a shell
// string (precedent scripts/verify-release-reducers.mjs).

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Pure aggregation (exported). Mirrors the CONTRACT in playtest-report.eval.mjs.
//
// For a set of PlaytestEvent rows (only kind === 1 RecruitAttempt counts):
//   - successRate:     fraction of attempts where success === true.
//   - baitRate:        fraction of attempts where bait_item_id !== 0.
//   - weakenFirstRate: fraction of (identity, species_id) groups whose FIRST row
//                      (encounter order, ascending event_id) has hp_permille < 500.
//   - recatchRate:     fraction of (identity, species_id) groups that appear ≥ 2×.
//
// Empty input (or no kind===1 rows) → all-zero (never NaN/Infinity, never throws).
// Returns ONLY the four numeric rate fields — NO identity (PII firewall).
// ---------------------------------------------------------------------------
export function aggregateReport(rows, { weakenThresholdPermille = 500 } = {}) {
  const r1 = rows.filter((r) => r.kind === 1);
  if (r1.length === 0) {
    return { weakenFirstRate: 0, successRate: 0, baitRate: 0, recatchRate: 0 };
  }

  const successCount = r1.filter((r) => r.success).length;
  const successRate = successCount / r1.length;

  const baitCount = r1.filter((r) => r.bait_item_id !== 0).length;
  const baitRate = baitCount / r1.length;

  const groups = new Map();
  for (const row of r1) {
    const key = `${row.identity}:${row.species_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let weakenedFirstCount = 0;
  for (const group of groups.values()) {
    if (group[0].hp_permille < weakenThresholdPermille) weakenedFirstCount++;
  }
  const weakenFirstRate = weakenedFirstCount / groups.size;

  let recatchCount = 0;
  for (const group of groups.values()) {
    if (group.length >= 2) recatchCount++;
  }
  const recatchRate = recatchCount / groups.size;

  return { weakenFirstRate, successRate, baitRate, recatchRate };
}

const REQUIRED_ROW_KEYS = [
  'event_id',
  'kind',
  'identity',
  'species_id',
  'hp_permille',
  'bait_item_id',
  'success',
];

const NUMERIC_ROW_KEYS = ['event_id', 'kind', 'species_id', 'hp_permille', 'bait_item_id'];

// ---------------------------------------------------------------------------
// Coerce ONE decoded row (as produced by `decodeSqlJson`) into the typed shape
// aggregateReport/sortByEventId expect. FAIL-LOUD by design: every rejection
// below is a silently-wrong-metric bug if it is tolerated instead of thrown.
//
//   - A missing key → Number(undefined) === NaN, and aggregateReport counts
//     bait via `bait_item_id !== 0` where NaN !== 0 is TRUE, so one malformed
//     row would INFLATE the H2 bait rate with no error anywhere.
//   - `success` must be a real JSON boolean. Under the JSON output mode a bool
//     column is always a real boolean, so the text-era `'true' | 1 | '1'`
//     tolerance is deleted outright: keeping it would mask a CLI shape change.
//   - Identity arrives as a ONE-ELEMENT array holding the hex string, which is
//     unwrapped here. A two-element array through String(...) yields "a,b" and
//     would silently MERGE two distinct players into one aggregation group key.
//
// Accepted residual: u64 values above 2^53 lose precision inside JSON.parse
// before this fn ever sees them; `event_id` is `#[auto_inc]` from 1, so that is
// unreachable in practice (and the same precision was already lost the moment
// Number() hit a pipe-table digit string in the pre-JSON decoder).
// ---------------------------------------------------------------------------
export function coerceRow(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('playtest-report: expected a decoded row object, got a non-object value');
  }
  for (const key of REQUIRED_ROW_KEYS) {
    if (!(key in raw)) {
      throw new Error(
        `playtest-report: decoded row is missing the required column "${key}" — the query result shape changed`,
      );
    }
  }

  const out = {};
  for (const key of NUMERIC_ROW_KEYS) {
    const n = Number(raw[key]);
    if (!Number.isFinite(n)) {
      throw new Error(
        `playtest-report: column "${key}" is not a finite number (got ${JSON.stringify(raw[key])})`,
      );
    }
    out[key] = n;
  }

  const rawIdentity = raw.identity;
  let identity;
  if (typeof rawIdentity === 'string') {
    identity = rawIdentity;
  } else if (
    Array.isArray(rawIdentity) &&
    rawIdentity.length === 1 &&
    typeof rawIdentity[0] === 'string'
  ) {
    identity = rawIdentity[0];
  } else {
    throw new Error(
      `playtest-report: column "identity" must be a hex string or a ONE-element array holding one (got ${JSON.stringify(rawIdentity)}) — anything else would merge distinct players into one aggregation group`,
    );
  }
  out.identity = identity;

  if (typeof raw.success !== 'boolean') {
    throw new Error(
      `playtest-report: column "success" must be a real JSON boolean (got ${JSON.stringify(raw.success)}) — the CLI output shape changed`,
    );
  }
  out.success = raw.success;

  return out;
}

// ---------------------------------------------------------------------------
// Sort coerced rows ascending by event_id. `aggregateReport`'s per-group
// `group[0]` = the FIRST recruit attempt (the H1 weaken-first proxy), so this
// ordering must be applied before calling it — the pinned 2.8.1 CLI's SQL
// dialect STILL rejects `ORDER BY` (re-verified live 2026-08-22:
// "Error: Unsupported: SELECT ... ORDER BY ..." → 400 Bad Request; first
// confirmed at 2.6.0 on 2026-07-25), so the ordering guarantee (PT-B2-RT-01)
// is enforced client-side instead of in the query. Pure + exported so it has
// real proof-of-teeth (a string-scan of the SQL text, the previous gate, proved
// nothing — the server silently rejects that clause; this fn is what
// evals/playtest-report.eval.mjs exercises with an out-of-order fixture).
// ---------------------------------------------------------------------------
export function sortByEventId(rows) {
  return [...rows].sort((a, b) => a.event_id - b.event_id);
}

// ---------------------------------------------------------------------------
// Decode the JSON output mode of the `spacetime` SQL CLI into an array of row
// objects keyed by column name, in wire order (sorting is sortByEventId's job).
//
// The pinned 2.8.1 CLI (.github/workflows/{ci,nightly}.yml pin
// `spacetime version use 2.8.1`) has a `--format json` mode — verified live
// 2026-08-22 — which prints the RAW HTTP response body verbatim on stdout (the
// `WARNING: UNSTABLE` banner stays on stderr). The envelope, verified rather
// than assumed:
//
//   - top level is an ARRAY of statement results (one per statement);
//   - `rows` are POSITIONAL arrays aligned to `schema.elements` ORDER, NOT
//     name-keyed objects;
//   - column names live at `schema.elements[i].name.some` (Option-encoded — an
//     unnamed column is `{"none":{}}`);
//   - integers arrive as bare JSON numbers, `bool` as a real JSON boolean;
//   - an Identity value is a ONE-ELEMENT ARRAY holding the hex string.
//
// WHY JSON and not the default text output: the text form is a human DISPLAY
// format rendered through the CLI's PsqlWrapper with no stability contract.
// 2.8.1 silently changed sum-variant rendering from `Mild` to `mild`
// (ADR-0197), and a display-format change like that is invisible to every gate
// this repo has. The JSON body is the wire shape the server actually returns.
//
// Values are left in RAW JSON form here (numbers stay numbers, booleans stay
// booleans, an Identity stays its one-element array) — typing and unwrapping
// are coerceRow's job.
//
// FAIL-LOUD on every malformed shape. Deliberately NO optional chaining and no
// nullish-coalescing fallback in this path: an `envelope[0]` short-circuit to
// an empty array turns every malformed envelope into a silent "0 events
// captured" report, which is the exact regression this decoder exists to
// prevent (reviewer finding m-3). A valid ZERO-ROW result returns [].
// ---------------------------------------------------------------------------
export function decodeSqlJson(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    const received =
      typeof stdout === 'string' ? stdout.slice(0, 200) : String(stdout).slice(0, 200);
    throw new Error(
      `playtest-report: the \`spacetime\` SQL query did not return valid JSON — received: ${JSON.stringify(received)}`,
    );
  }

  if (!Array.isArray(envelope)) {
    throw new Error(
      'playtest-report: expected the JSON response body to be an ARRAY of statement results',
    );
  }
  if (envelope.length !== 1) {
    throw new Error(
      `playtest-report: expected exactly 1 statement result, got ${envelope.length} — the query returned nothing usable`,
    );
  }

  const statement = envelope[0];
  if (statement === null || typeof statement !== 'object' || Array.isArray(statement)) {
    throw new Error('playtest-report: the statement result is not an object');
  }

  const schema = statement.schema;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('playtest-report: the statement result has no `schema` object');
  }

  const elements = schema.elements;
  if (!Array.isArray(elements)) {
    throw new Error('playtest-report: `schema.elements` is missing or is not an array');
  }
  if (elements.length === 0) {
    throw new Error('playtest-report: `schema.elements` is empty — no columns to zip rows against');
  }

  const columns = [];
  const seen = new Set();
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element === null || typeof element !== 'object' || Array.isArray(element)) {
      throw new Error(`playtest-report: \`schema.elements[${i}]\` is not an object`);
    }
    const nameOption = element.name;
    if (nameOption === null || typeof nameOption !== 'object' || Array.isArray(nameOption)) {
      throw new Error(`playtest-report: column ${i} has no Option-encoded \`name\``);
    }
    const some = nameOption.some;
    if (typeof some !== 'string' || some.length === 0) {
      throw new Error(
        `playtest-report: column ${i} is unnamed (expected {"some":"<column>"}) — cannot key rows by name`,
      );
    }
    if (seen.has(some)) {
      throw new Error(
        `playtest-report: duplicate column name "${some}" in the result schema — row keys would collide`,
      );
    }
    seen.add(some);
    columns.push(some);
  }

  const rows = statement.rows;
  if (!Array.isArray(rows)) {
    throw new Error('playtest-report: `rows` is missing or is not an array');
  }

  const decoded = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) {
      throw new Error(
        `playtest-report: row ${r} is not a positional array — the response shape changed`,
      );
    }
    if (row.length !== columns.length) {
      throw new Error(
        `playtest-report: row ${r} has ${row.length} value(s) but the schema declares ${columns.length} column(s) — a positional zip over a short row would leave columns undefined and silently skew the report`,
      );
    }
    const obj = Object.create(null);
    for (let c = 0; c < columns.length; c++) {
      obj[columns[c]] = row[c];
    }
    decoded.push(obj);
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Main-guarded driver (live CLI I/O). Not run on import.
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = process.env.STDB_SERVER || 'http://127.0.0.1:3000';
  const db = process.env.MR_PLAYTEST_DB || 'monster-realm-playtest';

  // event_id is selected (not just used to order) because ordering is enforced
  // client-side by sortByEventId — the pinned 2.8.1 CLI's SQL dialect still
  // rejects ORDER BY (re-verified live 2026-08-22: "Unsupported: ...ORDER
  // BY..." 400 Bad Request).
  const query =
    'SELECT event_id, kind, identity, species_id, hp_permille, bait_item_id, success FROM playtest_event';

  let out;
  try {
    // Array args (no shell): the DB name + query are never spliced into a shell
    // string, so a hostile DB name cannot inject. `--format` and `json` are two
    // SEPARATE argv entries (a joined single token is not a flag the CLI
    // recognises), which preserves that no-shell guarantee. The
    // `WARNING: UNSTABLE` banner goes to stderr; stdout carries only the raw
    // JSON response body. maxBuffer is raised well above the 1 MB default — a
    // growing `playtest_event` table would otherwise trip ENOBUFS.
    out = execFileSync('spacetime', ['sql', '--format', 'json', '-s', server, db, query], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.error(
      `playtest-report: the \`spacetime\` SQL query against "${db}" (server ${server}) failed — is the instance running and the module published? (${e?.message ?? String(e)})`,
    );
    process.exit(1);
  }

  let rawRows;
  try {
    rawRows = decodeSqlJson(out);
  } catch (e) {
    console.error(
      `playtest-report: could not decode the \`spacetime\` SQL JSON output — ${e?.message ?? String(e)}`,
    );
    process.exit(1);
  }

  if (rawRows.length === 0) {
    console.log('==============================================');
    console.log('  playtest-report: 0 events captured');
    console.log('==============================================');
    console.log(
      JSON.stringify({ weakenFirstRate: 0, successRate: 0, baitRate: 0, recatchRate: 0 }, null, 2),
    );
    process.exit(0);
  }

  // coerceRow is fail-loud now, so the map lives INSIDE a try/catch: an
  // uncaught throw here would print a Node stack trace instead of the
  // operator-facing diagnostic.
  let rows;
  try {
    rows = sortByEventId(rawRows.map(coerceRow));
  } catch (e) {
    console.error(`playtest-report: a decoded row failed validation — ${e?.message ?? String(e)}`);
    process.exit(1);
  }

  const report = aggregateReport(rows);

  // Print RATES only — never a raw identity (PII firewall).
  console.log(
    `playtest-report: ${rows.filter((r) => r.kind === 1).length} recruit-attempt event(s)`,
  );
  console.log('  H1 weaken-first rate:', report.weakenFirstRate.toFixed(4));
  console.log('  H1 recatch rate:     ', report.recatchRate.toFixed(4));
  console.log('  H2 success rate:     ', report.successRate.toFixed(4));
  console.log('  H2 bait rate:        ', report.baitRate.toFixed(4));
  process.exit(0);
}
