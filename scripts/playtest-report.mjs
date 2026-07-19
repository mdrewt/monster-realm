// playtest-report.mjs — pt-b2 server observability (ADR-0131)
//
// Aggregates the PRIVATE `playtest_event` table into the GDD §4 H1/H2 proxy
// report (weaken-first / success / bait / recatch rates). The raw per-identity
// rows never leave the server via a client subscription (the table is private);
// this offline read is the ONLY intended consumer, and it aggregates to RATES
// only — never relaying a raw identity (PII firewall).
//
// Functional-core / imperative-shell: `aggregateReport` is a pure exported fn
// (unit-gated by evals/playtest-report.eval.mjs); the live `spacetime sql` I/O
// runs only in the main-guarded driver at the bottom.
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

// ---------------------------------------------------------------------------
// Coerce a raw `spacetime sql --json` row (all-string values) into the typed
// shape aggregateReport expects. success -> bool; numeric columns -> Number.
// ---------------------------------------------------------------------------
export function coerceRow(raw) {
  const s = raw.success;
  const success = s === true || s === 'true' || s === 1 || s === '1';
  return {
    kind: Number(raw.kind),
    identity: String(raw.identity),
    species_id: Number(raw.species_id),
    hp_permille: Number(raw.hp_permille),
    bait_item_id: Number(raw.bait_item_id),
    success,
  };
}

// ---------------------------------------------------------------------------
// Parse `spacetime sql --json` stdout into an array of row objects. The CLI
// emits an array of statement results; each has a `rows` array. Tolerates the
// bare-array shape too. Returns [] for a valid-but-empty result.
// ---------------------------------------------------------------------------
export function parseSqlRows(sqlJson) {
  const parsed = JSON.parse(sqlJson);
  if (Array.isArray(parsed)) {
    // Either [{ rows: [...] }, ...] (statement results) or a bare row array.
    if (parsed.length > 0 && parsed[0] && Array.isArray(parsed[0].rows)) {
      const out = [];
      for (const stmt of parsed) {
        if (Array.isArray(stmt.rows)) out.push(...stmt.rows);
      }
      return out;
    }
    return parsed;
  }
  if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
  // Unrecognized shape (neither a row array nor a { rows: [...] } result) — fail loud
  // rather than silently returning [] which would print a bogus "0 events" report
  // (reviewer m-3). A legitimately-empty table is a valid `[]`, handled above.
  throw new Error('playtest-report: unrecognized `spacetime` SQL --json output shape');
}

// ---------------------------------------------------------------------------
// Main-guarded driver (live CLI I/O). Not run on import.
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = process.env.STDB_SERVER || 'http://127.0.0.1:3000';
  const db = process.env.MR_PLAYTEST_DB || 'monster-realm-playtest';

  // ORDER BY event_id ASC so rows arrive in encounter order — `aggregateReport`'s
  // per-group `group[0]` = the FIRST recruit attempt (the H1 weaken-first proxy). Without
  // this the DB row order is undefined and weakenFirstRate would be non-deterministic
  // (reviewer M-3 / red-team FINDING-1; gated by playtest-report.eval PT-B2-RT-01).
  const query =
    'SELECT kind, identity, species_id, hp_permille, bait_item_id, success FROM playtest_event ORDER BY event_id ASC';

  let out;
  try {
    // Array args (no shell): the DB name + query are never spliced into a shell
    // string, so a hostile DB name cannot inject. The `WARNING: UNSTABLE` line
    // goes to stderr; stdout carries only the JSON.
    out = execFileSync('spacetime', ['sql', '-s', server, db, query, '--json'], {
      encoding: 'utf8',
    });
  } catch (e) {
    console.error(
      `playtest-report: the \`spacetime\` SQL query against "${db}" (server ${server}) failed — is the instance running and the module published? (${e?.message ?? String(e)})`,
    );
    process.exit(1);
  }

  let rawRows;
  try {
    rawRows = parseSqlRows(out);
  } catch (e) {
    console.error(
      `playtest-report: could not parse the \`spacetime\` SQL --json output — ${e?.message ?? String(e)}`,
    );
    process.exit(1);
  }

  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    console.log('==============================================');
    console.log('  playtest-report: 0 events captured');
    console.log('==============================================');
    console.log(
      JSON.stringify({ weakenFirstRate: 0, successRate: 0, baitRate: 0, recatchRate: 0 }, null, 2),
    );
    process.exit(0);
  }

  const rows = rawRows.map(coerceRow);
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
