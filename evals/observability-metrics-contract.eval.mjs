// observability-metrics-contract.eval.mjs — m20a gates G3 (OBS-9) + G4 (OBS-10).
//
// TODO(m20e): G5 — Alloy self-metrics assertion (OBS-12/OBS-13) deferred; needs
// ops/observability/** (m20b touches).
//
// WHAT THIS PROVES, AND WHERE
//   B1 (OBS-9/G3)  — `/v1/metrics` exposes >= 80 metric families including the 4
//                    named ones.
//   B2 (OBS-9)     — the label keys `reducer`, `committed`, `txn_type`,
//                    `table_name`, `le` are all present.
//   B3 (OBS-10/G4) — a `spacetime logs --format json` line for a REJECTED call
//                    attributes the log to the INVOKING REDUCER
//                    (`set_profile_name`), not to the helper that emitted it
//                    (`guards.rs`'s `log_reject`). This is the cross-file
//                    attribution ADR-0180's verification reproduced byte-for-byte.
//   B4 (always)    — PIN TRIPWIRE. `.github/workflows/ci.yml` must pin the
//                    `spacetime` CLI on >= 2 agreeing non-comment lines, and when
//                    the CLI is on PATH its `--version` must match that pin.
//   B5 (live only) — preflight matches `spacetime server ping` OUTPUT
//                    ("Server is online"), never the exit code alone: `ping`
//                    exits 0 for a 404 and for an unrelated service on the port
//                    (justfile:229 records the measured lesson).
//
// THESE ARE PROPERTIES OF THE PINNED HOST BINARY, not of this repository's
// source, so they cannot regress from a code change here — which is exactly why
// the live half is opt-in rather than a `just ci` step (publishing a scratch
// module means a full release wasm build on every local `just ci`, and this repo
// keeps live gates outside `just ci`: e2e, smoke-republish, playtest-*).
//
// "PERMANENTLY-SKIPPED-GREEN" IS CLOSED THREE WAYS (anti-pattern 2):
//   1. the pure half — family counting, label-key extraction, attribution-field
//      extraction, pin agreement — ALWAYS runs, with proof-of-teeth over inline
//      fixtures (a 32-family fixture and a bucket-heavy fixture must FAIL B1);
//   2. B4's pin tripwire fails LOUD the moment the pinned CLI version moves, so
//      the recorded live evidence can never silently age out against a new host;
//   3. `MR_OBS_LIVE=1` runs the real thing, and one recorded live run is part of
//      this slice's DoD (output pasted into the handoff = the OBS-9/OBS-10
//      evidence of record).
//
// LIVE-MODE CONTRACT (MR_OBS_LIVE=1):
//   $STDB_SERVER (default http://127.0.0.1:3000) hosts a running instance on
//   which $MR_OBS_DB (default monster-realm-obs-eval) is an ALREADY-PUBLISHED
//   copy of this module. The ORCHESTRATOR publishes before the run; this eval
//   NEVER publishes and never mutates the developer's default database.
//   Once MR_OBS_LIVE=1 there are NO silent skips: every subprocess or HTTP
//   failure is a loud `pass:false`.
//
// NO `new RegExp(...)` anywhere (Semgrep detect-non-literal-regexp). No regex at
// all, in fact — String methods and hand-rolled character walks only.
// `spawnSync` is called with ARRAY ARGS only, never a shell string.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CI_YML = path.resolve('.github/workflows/ci.yml');

/** OBS-9's named families. */
export const REQUIRED_FAMILIES = [
  'spacetime_num_txns_total',
  'spacetime_txn_elapsed_time_sec',
  'spacetime_num_table_rows',
  'spacetime_subscription_connections',
];

/** OBS-9's required label keys (G3). */
export const REQUIRED_LABEL_KEYS = ['reducer', 'committed', 'txn_type', 'table_name', 'le'];

/** OBS-9's floor. */
export const MIN_FAMILIES = 80;

/** The reducer whose rejected call must own the log line (OBS-10/G4). */
export const PROBE_REDUCER = 'set_profile_name';

/** Helpers that must NEVER appear as the attribution — the whole point of G4. */
export const FORBIDDEN_ATTRIBUTIONS = ['log_reject', 'guards', 'guards.rs'];

// ---------------------------------------------------------------------------
// Pure predicate 1: countMetricFamilies(promText) -> number
//
// A metric FAMILY is what `# TYPE` declares. Histogram/summary families expose
// three sample series each (`_bucket`, `_sum`, `_count`); counting raw sample
// names would let a bucket-heavy endpoint clear the >= 80 floor with a handful
// of real families — a vacuous green in the WRONG direction. So: every `# TYPE`
// name counts once, and a sample series is folded into its declared family when
// stripping a `_bucket`/`_sum`/`_count` suffix lands on a declared name.
// Samples with no `# TYPE` line still count (union, never a subtraction), so a
// fixture or endpoint that omits TYPE comments degrades to plain distinct-name
// counting rather than under-reporting.
// ---------------------------------------------------------------------------
const SERIES_SUFFIXES = ['_bucket', '_sum', '_count'];

function isSpaceChar(c) {
  return c === ' ' || c === '\t' || c === '\r';
}

/** The metric name at the start of a sample line: text before `{` or whitespace. */
function sampleName(line) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '{' || isSpaceChar(c)) break;
    i++;
  }
  return line.slice(0, i);
}

/** `{ typeNames: Set<string>, sampleNames: Set<string> }` for a prom text. */
export function collectMetricNames(promText) {
  const typeNames = new Set();
  const sampleNames = new Set();
  for (const raw of promText.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) {
      const marker = '# TYPE ';
      if (!line.startsWith(marker)) continue;
      const rest = line.slice(marker.length).trim();
      const name = sampleName(rest);
      if (name.length > 0) typeNames.add(name);
      continue;
    }
    const name = sampleName(line);
    if (name.length > 0) sampleNames.add(name);
  }
  return { typeNames, sampleNames };
}

/** The set of metric family names in a Prometheus text-exposition payload. */
export function metricFamilies(promText) {
  const { typeNames, sampleNames } = collectMetricNames(promText);
  const families = new Set(typeNames);
  for (const name of sampleNames) {
    if (typeNames.has(name)) continue;
    let folded = null;
    for (const suffix of SERIES_SUFFIXES) {
      if (!name.endsWith(suffix)) continue;
      const base = name.slice(0, name.length - suffix.length);
      if (typeNames.has(base)) folded = base;
    }
    families.add(folded === null ? name : folded);
  }
  return families;
}

export function countMetricFamilies(promText) {
  return metricFamilies(promText).size;
}

/** `{ ok, missing }` for the named families (OBS-9). */
export function familiesPresent(promText, names) {
  const families = metricFamilies(promText);
  const missing = names.filter((n) => !families.has(n));
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Pure predicate 2: label-key extraction.
//
// Walks each sample line's `{...}` block honoring quoted values (and `\"`
// escapes inside them), so a label VALUE containing `,` or `=` cannot forge a
// key. Kills a naive `promText.includes('le=')`, which a HELP string mentioning
// `le=` would satisfy.
// ---------------------------------------------------------------------------
export function labelKeysIn(promText) {
  const keys = new Set();
  for (const raw of promText.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const open = line.indexOf('{');
    if (open === -1) continue;
    let key = '';
    let inValue = false;
    let inQuote = false;
    let escaped = false;
    for (let i = open + 1; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inQuote = false;
        continue;
      }
      if (c === '}') break;
      if (inValue) {
        if (c === '"') inQuote = true;
        else if (c === ',') {
          inValue = false;
          key = '';
        }
        continue;
      }
      if (c === '=') {
        if (key.trim().length > 0) keys.add(key.trim());
        inValue = true;
        continue;
      }
      if (c === ',') {
        key = '';
        continue;
      }
      key += c;
    }
  }
  return keys;
}

/** `{ ok, missing }` for the required label keys (OBS-9). */
export function labelKeysPresent(promText, keys) {
  const found = labelKeysIn(promText);
  const missing = keys.filter((k) => !found.has(k));
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Pure predicate 3: functionAttribution(logLineJson) -> { ok, field, value }
//
// Takes ONE raw `spacetime logs --format json` line. The host populates a
// `function` field naming the invoking reducer (ADR-0180 verification ledger);
// tolerate the `target` spelling and one level of nesting, because the exact
// key is the CLI's contract, not ours — but FAIL LOUD when no attribution field
// exists at all, rather than returning a falsy value some caller compares
// loosely and calls green.
// ---------------------------------------------------------------------------
const ATTRIBUTION_KEYS = ['function', 'target'];
const NESTED_CONTAINERS = ['record', 'fields', 'data', 'log'];

export function functionAttribution(logLineJson) {
  let obj;
  try {
    obj = JSON.parse(logLineJson);
  } catch (e) {
    return { ok: false, reason: `line is not JSON: ${e?.message ?? String(e)}` };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'line is JSON but not an object' };
  }
  const scopes = [['', obj]];
  for (const container of NESTED_CONTAINERS) {
    const inner = obj[container];
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      scopes.push([`${container}.`, inner]);
    }
  }
  for (const [prefix, scope] of scopes) {
    for (const key of ATTRIBUTION_KEYS) {
      if (!Object.hasOwn(scope, key)) continue;
      const value = scope[key];
      if (typeof value !== 'string' || value.length === 0) {
        return {
          ok: false,
          reason: `attribution field '${prefix}${key}' is not a non-empty string`,
        };
      }
      return { ok: true, field: `${prefix}${key}`, value };
    }
  }
  return {
    ok: false,
    reason:
      'no function/target attribution field on this log line (keys: ' +
      `${Object.keys(obj).join(', ')}) — OBS-10 depends on the host populating it`,
  };
}

// ---------------------------------------------------------------------------
// Pure predicate 4: pinsAgree(ciYmlText) -> { ok, version, reason }  (AM9)
//
// A "pin" is a COMMAND that installs a LITERAL version. Three spoofs the first
// draft accepted, all found by red-team:
//   - COMMENT: a line whose trimmed form starts with `#` (commenting out one of
//     the two install steps left a single "agreeing" occurrence);
//   - DECORATIVE ECHO: `echo "spacetime version install 2.6.0"` counted as a
//     second pin, so deleting the real one still "agreed". Fixed by requiring
//     the marker to be the START of the command (optionally after a `- run: `
//     or `run: ` key), not merely present somewhere in the line;
//   - EXPRESSION COLLAPSE: `spacetime version install ${{ matrix.stdb }}` parsed
//     to the token `$` (the name walk stops at `{`), and two such lines
//     trivially "agreed" on `$`. Fixed by requiring the token to look like a
//     literal version — leading digit, at least one dot — and by FAILING LOUD
//     (not skipping) when a real pin line carries a non-literal.
// ---------------------------------------------------------------------------

/** A literal version token: starts with a digit, contains a dot. */
export function isVersionToken(token) {
  if (token.length === 0) return false;
  const first = token[0];
  if (first < '0' || first > '9') return false;
  return token.indexOf('.') !== -1;
}

/** Strip a leading YAML `- run: ` / `run: ` key so both step forms are pins. */
function commandTail(trimmed) {
  for (const prefix of ['- run: ', 'run: ']) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

export function pinsAgree(ciYmlText) {
  const marker = 'spacetime version install';
  const versions = [];
  for (const raw of ciYmlText.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const command = commandTail(line);
    // The marker must OPEN the command. A line that merely mentions it (an
    // echo, a comment inside a block scalar, a doc string) is not a pin.
    if (!command.startsWith(marker)) continue;
    const rest = command.slice(marker.length).trim();
    const token = sampleName(rest);
    if (!isVersionToken(token)) {
      return {
        ok: false,
        reason:
          `a \`${marker}\` command does not name a literal version (got '${token}') — a matrix ` +
          `expression or variable cannot anchor the recorded live evidence: ${line}`,
      };
    }
    versions.push(token);
  }
  if (versions.length < 2) {
    return {
      ok: false,
      reason:
        `expected >= 2 non-comment \`${marker}\` COMMANDS in ci.yml, found ${versions.length} — ` +
        'the CLI pin is the anchor the recorded live evidence is valid against (a line that ' +
        'only mentions the command, e.g. inside an echo, does not count)',
    };
  }
  for (const v of versions) {
    if (v !== versions[0]) {
      return { ok: false, reason: `ci.yml CLI pins disagree: ${versions.join(', ')}` };
    }
  }
  return {
    ok: true,
    version: versions[0],
    reason: `${versions.length} ci.yml CLI pins agree on ${versions[0]}`,
  };
}

// ===========================================================================
// PROOF-OF-TEETH — inline, hermetic fixtures. Always run, first.
// ===========================================================================

/**
 * Synthesize a Prometheus text-exposition payload with `familyCount` families:
 * the 4 OBS-9 families (carrying the 5 required label keys between them) plus
 * filler counters. `opts.stripLe` drops the `le` label; `opts.buckets` inflates
 * the histogram's bucket count (the vacuous-green probe).
 */
export function synthPromText(familyCount, opts) {
  const stripLe = opts?.stripLe === true;
  const buckets = opts?.buckets ?? 3;
  const lines = [
    '# HELP spacetime_num_txns_total Total transactions.',
    '# TYPE spacetime_num_txns_total counter',
    'spacetime_num_txns_total{reducer="set_profile_name",committed="true",txn_type="reducer"} 42',
    'spacetime_num_txns_total{reducer="movement_tick",committed="false",txn_type="reducer"} 7',
    '# HELP spacetime_txn_elapsed_time_sec Transaction latency.',
    '# TYPE spacetime_txn_elapsed_time_sec histogram',
  ];
  for (let b = 0; b < buckets; b++) {
    const bound = `0.${String(b + 1).padStart(3, '0')}`;
    const labels = stripLe ? 'reducer="movement_tick"' : `reducer="movement_tick",le="${bound}"`;
    lines.push(`spacetime_txn_elapsed_time_sec_bucket{${labels}} ${b}`);
  }
  lines.push('spacetime_txn_elapsed_time_sec_sum{reducer="movement_tick"} 0.021');
  lines.push('spacetime_txn_elapsed_time_sec_count{reducer="movement_tick"} 3');
  lines.push('# TYPE spacetime_num_table_rows gauge');
  lines.push('spacetime_num_table_rows{table_name="player"} 7');
  lines.push('# TYPE spacetime_subscription_connections gauge');
  lines.push('spacetime_subscription_connections{database_identity="c0ffee"} 1');
  for (let i = 0; i < familyCount - REQUIRED_FAMILIES.length; i++) {
    lines.push(`# TYPE mr_filler_${i} counter`);
    lines.push(`mr_filler_${i} ${i}`);
  }
  return `${lines.join('\n')}\n`;
}

const GOOD_LOG_LINE = JSON.stringify({
  ts: '2026-08-08T12:00:00.123456Z',
  level: 'warn',
  function: PROBE_REDUCER,
  filename: 'src/guards.rs',
  line_number: 55,
  message: '{"evt":"reject","reducer":"set_profile_name","sender":"c0ffee","reason":"not joined"}',
});

const HELPER_LOG_LINE = JSON.stringify({
  ts: '2026-08-08T12:00:00.123456Z',
  level: 'warn',
  function: 'log_reject',
  filename: 'src/guards.rs',
  line_number: 55,
  message: '{"evt":"reject","reducer":"set_profile_name","sender":"c0ffee","reason":"not joined"}',
});

const NO_ATTRIBUTION_LINE = JSON.stringify({
  ts: '2026-08-08T12:00:00.123456Z',
  level: 'warn',
  message: '{"evt":"reject"}',
});

const CI_PINS_GOOD =
  'jobs:\n  ci:\n    steps:\n      - run: |\n          spacetime version install 2.6.0\n' +
  '  e2e:\n    steps:\n      - run: |\n          spacetime version install 2.6.0\n';
const CI_PINS_MISMATCH = CI_PINS_GOOD.replace(
  '          spacetime version install 2.6.0\n  e2e:',
  '          spacetime version install 2.7.1\n  e2e:',
);
const CI_PINS_COMMENTED = CI_PINS_GOOD.replace(
  '      - run: |\n          spacetime version install 2.6.0\n  e2e:',
  '      - run: |\n          # spacetime version install 2.6.0\n  e2e:',
);
// MEDIUM-6 spoof (a): a decorative echo naming the same version. Only ONE real
// pin command remains, so this must fail rather than "agree" with itself.
const CI_PINS_ECHO_DECOY = CI_PINS_GOOD.replace(
  '      - run: |\n          spacetime version install 2.6.0\n  e2e:',
  '      - run: |\n          echo "spacetime version install 2.6.0 (pinned)"\n  e2e:',
);
// MEDIUM-6 spoof (b): both steps install a matrix expression. The old name walk
// stopped at `{` and both lines "agreed" on the token `$`.
const CI_PINS_MATRIX = CI_PINS_GOOD.split('2.6.0').join('${{ matrix.stdb }}');
// MEDIUM-6 spoof (c): a non-numeric token (a tag, a branch, `latest`).
const CI_PINS_NONLITERAL = CI_PINS_GOOD.split('2.6.0').join('latest');
// Inline `- run:` form must still count as a real pin (no false RED if ci.yml
// is ever reformatted away from block scalars).
const CI_PINS_INLINE =
  'jobs:\n  ci:\n    steps:\n      - run: spacetime version install 2.6.0\n' +
  '  e2e:\n    steps:\n      - run: spacetime version install 2.6.0\n';

const TEETH = [
  {
    id: 'B1-good',
    // Kills a counter that cannot reach the real figure at all.
    run() {
      const text = synthPromText(88, null);
      const n = countMetricFamilies(text);
      if (n !== 88) return `88-family fixture counted as ${n}`;
      if (n < MIN_FAMILIES) return `88-family fixture did not clear the >= ${MIN_FAMILIES} floor`;
      const named = familiesPresent(text, REQUIRED_FAMILIES);
      if (!named.ok)
        return `named families missing from the good fixture: ${named.missing.join(', ')}`;
      return null;
    },
  },
  {
    id: 'B1-thin',
    // The ADR's fresh-instance figure: 32 families (no module published) must
    // FAIL the OBS-9 floor. Kills a hardcoded `true`.
    run() {
      const n = countMetricFamilies(synthPromText(32, null));
      if (n !== 32) return `32-family fixture counted as ${n}`;
      if (n >= MIN_FAMILIES)
        return `32-family fixture wrongly cleared the >= ${MIN_FAMILIES} floor`;
      return null;
    },
  },
  {
    id: 'B1-bucket-inflation',
    // BITES: 32 real families whose histogram has 120 buckets. A counter that
    // tallies raw sample names sees 150+ and reports a vacuous green; the
    // family-correct counter still says 32 and stays red.
    run() {
      const text = synthPromText(32, { buckets: 120 });
      const n = countMetricFamilies(text);
      if (n !== 32) {
        return `bucket-heavy 32-family fixture counted as ${n} — histogram sub-series (_bucket/_sum/_count) are being counted as families, which lets a thin endpoint fake the >= 80 floor`;
      }
      return null;
    },
  },
  {
    id: 'B1-missing-named-family',
    // Kills a check that only counts and never looks for the 4 named families.
    run() {
      const text = synthPromText(88, null)
        .split('spacetime_num_table_rows')
        .join('mr_renamed_rows');
      const named = familiesPresent(text, REQUIRED_FAMILIES);
      if (named.ok) return 'a payload with spacetime_num_table_rows renamed away was accepted';
      if (named.missing.join(',') !== 'spacetime_num_table_rows') {
        return `wrong missing set reported: ${named.missing.join(',')}`;
      }
      return null;
    },
  },
  {
    id: 'B2-good',
    run() {
      const r = labelKeysPresent(synthPromText(88, null), REQUIRED_LABEL_KEYS);
      if (!r.ok) return `good fixture is missing label keys: ${r.missing.join(', ')}`;
      return null;
    },
  },
  {
    id: 'B2-le-stripped',
    // Kills a label check that passes on the histogram's bucket bound being gone
    // (no `le` => no latency quantiles => OBS-9's SLO panels are dead).
    run() {
      const r = labelKeysPresent(synthPromText(88, { stripLe: true }), REQUIRED_LABEL_KEYS);
      if (r.ok) return 'an `le`-stripped payload was accepted';
      if (r.missing.join(',') !== 'le') return `wrong missing set reported: ${r.missing.join(',')}`;
      return null;
    },
  },
  {
    id: 'B2-value-forgery',
    // Kills `promText.includes('committed=')`: a label VALUE that spells another
    // key must not register as that key.
    run() {
      const forged = '# TYPE mr_x counter\nmr_x{reducer="a,committed=true,txn_type=b"} 1\n';
      const found = labelKeysIn(forged);
      if (found.has('committed')) return 'a key spelled inside a quoted label VALUE was counted';
      if (!found.has('reducer')) return 'the real `reducer` key was not found';
      return null;
    },
  },
  {
    id: 'B3-good',
    // The G4 case: the host attributes guards.rs's helper emission to the
    // INVOKING reducer.
    run() {
      const r = functionAttribution(GOOD_LOG_LINE);
      if (!r.ok) return `good log line rejected: ${r.reason}`;
      if (r.value !== PROBE_REDUCER)
        return `attribution was '${r.value}', expected '${PROBE_REDUCER}'`;
      return null;
    },
  },
  {
    id: 'B3-helper',
    // BITES: this is the exact regression OBS-10 exists to detect — attribution
    // naming the helper instead of the reducer. The predicate must surface the
    // helper name so the comparison fails.
    run() {
      const r = functionAttribution(HELPER_LOG_LINE);
      if (!r.ok) return `helper-attributed line failed to parse: ${r.reason}`;
      if (r.value === PROBE_REDUCER) return 'a log_reject-attributed line was read as the reducer';
      if (!FORBIDDEN_ATTRIBUTIONS.includes(r.value)) {
        return `expected the helper name, got '${r.value}'`;
      }
      return null;
    },
  },
  {
    id: 'B3-missing',
    // Kills a predicate that returns undefined and lets `x !== reducer` be the
    // only guard — a missing field must be its own loud failure.
    run() {
      const r = functionAttribution(NO_ATTRIBUTION_LINE);
      if (r.ok) return 'a line with no attribution field was accepted';
      const notJson = functionAttribution('this is not json');
      if (notJson.ok) return 'a non-JSON line was accepted';
      return null;
    },
  },
  {
    id: 'B4-pins',
    run() {
      const good = pinsAgree(CI_PINS_GOOD);
      if (!good.ok) return `matching pins rejected: ${good.reason}`;
      if (good.version !== '2.6.0') return `parsed version '${good.version}', expected '2.6.0'`;
      if (pinsAgree(CI_PINS_MISMATCH).ok) return 'mismatched ci.yml pins were accepted';
      if (pinsAgree(CI_PINS_COMMENTED).ok) {
        return 'a ci.yml with only ONE live pin (the other commented out) was accepted';
      }
      if (pinsAgree('jobs:\n  ci:\n    steps: []\n').ok) {
        return 'a ci.yml with no `spacetime version install` line at all was accepted';
      }
      return null;
    },
  },
  {
    id: 'B4-pin-spoofs',
    // MEDIUM-6. Each of these made the tripwire green while the real pin was
    // absent, unpinned, or non-literal.
    run() {
      if (pinsAgree(CI_PINS_ECHO_DECOY).ok) {
        return 'a decorative `echo "spacetime version install 2.6.0"` counted as a second pin';
      }
      const matrix = pinsAgree(CI_PINS_MATRIX);
      if (matrix.ok) {
        return `a \`\${{ matrix.* }}\` version expression was accepted as a pin (${matrix.version})`;
      }
      if (pinsAgree(CI_PINS_NONLITERAL).ok) {
        return 'a non-literal version token (`latest`) was accepted as a pin';
      }
      const inline = pinsAgree(CI_PINS_INLINE);
      if (!inline.ok) return `the inline \`- run: ...\` step form was rejected: ${inline.reason}`;
      if (inline.version !== '2.6.0') return `inline form parsed '${inline.version}'`;
      if (isVersionToken('$') || isVersionToken('v2.6.0') || isVersionToken('260')) {
        return 'isVersionToken accepted a token that is not a literal dotted version';
      }
      if (!isVersionToken('2.6.0') || !isVersionToken('2.6.0-rc.1')) {
        return 'isVersionToken rejected a legitimate literal version';
      }
      return null;
    },
  },
];

function runTeeth() {
  for (const tooth of TEETH) {
    let miss;
    try {
      miss = tooth.run();
    } catch (e) {
      miss = `threw — ${e?.message ?? String(e)}`;
    }
    if (miss) return `TEETH: ${tooth.id} — ${miss}`;
  }
  return null;
}

// ===========================================================================
// Live-mode helpers (MR_OBS_LIVE=1 only)
// ===========================================================================

function runCli(args) {
  return spawnSync('spacetime', args, { encoding: 'utf8' });
}

function cliVersion() {
  const r = runCli(['--version']);
  if (r.error !== undefined || r.status !== 0) return null;
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

// ===========================================================================
// The eval
// ===========================================================================

const NAME = 'observability-metrics-contract (G3 OBS-9 + G4 OBS-10, ADR-0180)';

export async function observabilityMetricsContractEval() {
  const toothMiss = runTeeth();
  if (toothMiss) return { name: NAME, pass: false, detail: toothMiss };

  // --- B4: pin tripwire (always) -------------------------------------------
  if (!existsSync(CI_YML)) {
    return {
      name: NAME,
      pass: false,
      detail: 'B4: .github/workflows/ci.yml is missing — the CLI pin tripwire cannot run',
    };
  }
  const pins = pinsAgree(readFileSync(CI_YML, 'utf8'));
  if (!pins.ok) return { name: NAME, pass: false, detail: `B4: ${pins.reason}` };

  const version = cliVersion();
  if (version !== null && version.indexOf(pins.version) === -1) {
    return {
      name: NAME,
      pass: false,
      detail:
        `B4 PIN MOVED: ci.yml pins spacetime ${pins.version} but the CLI on PATH reports ` +
        `"${version.trim().split('\n')[0]}". The recorded OBS-9/OBS-10 live evidence was ` +
        'gathered against the pinned host and is no longer known-good. Re-run the live half ' +
        '(MR_OBS_LIVE=1) against the new host, refresh the handoff evidence, then update the pin.',
    };
  }

  const live = process.env.MR_OBS_LIVE === '1';
  if (!live) {
    return {
      name: NAME,
      pass: true,
      detail:
        'skipped: no live instance in this CI job by design — OBS-9/OBS-10 pure predicates + ' +
        'pin tripwire ran; live half last verified at slice DoD (see handoff); re-run with ' +
        'MR_OBS_LIVE=1 after any host-facing change',
    };
  }

  // =========================================================================
  // LIVE HALF — no silent skips past this point.
  // =========================================================================
  const server = process.env.STDB_SERVER ?? 'http://127.0.0.1:3000';
  const db = process.env.MR_OBS_DB ?? 'monster-realm-obs-eval';

  if (version === null) {
    return {
      name: NAME,
      pass: false,
      detail: 'LIVE B5: MR_OBS_LIVE=1 but the `spacetime` CLI is not on PATH',
    };
  }

  // --- B5: preflight on OUTPUT, never the exit code alone ------------------
  const ping = runCli(['server', 'ping', '-s', server]);
  const pingOut = `${ping.stdout ?? ''}${ping.stderr ?? ''}`;
  if (ping.error !== undefined) {
    return {
      name: NAME,
      pass: false,
      detail: `LIVE B5: \`spacetime server ping\` failed to spawn — ${ping.error.message}`,
    };
  }
  if (pingOut.indexOf('Server is online') === -1) {
    return {
      name: NAME,
      pass: false,
      detail:
        `LIVE B5: ${server} did not answer "Server is online" (exit ${ping.status}); output: ` +
        `${pingOut.trim().slice(0, 200)}. \`server ping\` exits 0 for a 404 and for an unrelated ` +
        'service on that port, so the OUTPUT is the liveness signal (justfile:229).',
    };
  }

  // --- B1/B2: scrape /v1/metrics -------------------------------------------
  let promText;
  try {
    const res = await fetch(`${server}/v1/metrics`);
    if (!res.ok) {
      return {
        name: NAME,
        pass: false,
        detail: `LIVE B1: GET ${server}/v1/metrics returned HTTP ${res.status}`,
      };
    }
    promText = await res.text();
  } catch (e) {
    return {
      name: NAME,
      pass: false,
      detail: `LIVE B1: GET ${server}/v1/metrics threw — ${e?.message ?? String(e)}`,
    };
  }
  const familyCount = countMetricFamilies(promText);
  if (familyCount < MIN_FAMILIES) {
    return {
      name: NAME,
      pass: false,
      detail:
        `LIVE B1: /v1/metrics exposes ${familyCount} metric families, OBS-9 requires >= ` +
        `${MIN_FAMILIES}. A count near 32 means no module is published to '${db}' on ${server}.`,
    };
  }
  const named = familiesPresent(promText, REQUIRED_FAMILIES);
  if (!named.ok) {
    return {
      name: NAME,
      pass: false,
      detail: `LIVE B1: /v1/metrics is missing named families: ${named.missing.join(', ')}`,
    };
  }
  const labels = labelKeysPresent(promText, REQUIRED_LABEL_KEYS);
  if (!labels.ok) {
    return {
      name: NAME,
      pass: false,
      detail: `LIVE B2: /v1/metrics is missing label keys: ${labels.missing.join(', ')}`,
    };
  }

  // --- B3: cross-file attribution on a REJECTED call (OBS-10/G4) -----------
  // Anonymous identity => `set_profile_name` rejects with "not joined" through
  // guards.rs's `log_reject` helper. The reject is EXPECTED; a success would
  // mean the probe identity is joined and the fixture is not reproducing G4.
  const call = runCli(['call', '-s', server, db, PROBE_REDUCER, '["obs_eval_probe"]']);
  if (call.error !== undefined) {
    return {
      name: NAME,
      pass: false,
      detail: `LIVE B3: \`spacetime call\` failed to spawn — ${call.error.message}`,
    };
  }
  const callOut = `${call.stdout ?? ''}${call.stderr ?? ''}`;
  if (call.status === 0 && callOut.indexOf('not joined') === -1) {
    return {
      name: NAME,
      pass: false,
      detail:
        `LIVE B3: ${PROBE_REDUCER} was NOT rejected on '${db}' (exit 0, no "not joined") — the ` +
        'probe identity appears to be joined, so no cross-file reject line was produced. Use a ' +
        'fresh anonymous identity against a scratch database.',
    };
  }

  const logs = runCli(['logs', '-s', server, db, '--format', 'json']);
  if (logs.error !== undefined || logs.status !== 0) {
    return {
      name: NAME,
      pass: false,
      detail:
        'LIVE B3: `spacetime logs --format json` failed — ' +
        `${logs.error?.message ?? `${logs.stderr ?? ''}`.trim().slice(0, 200)}`,
    };
  }
  const rejectMarker = '\\"evt\\":\\"reject\\"';
  let probeLine = null;
  for (const raw of (logs.stdout ?? '').split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.indexOf(rejectMarker) === -1 && line.indexOf('"evt":"reject"') === -1) continue;
    if (line.indexOf(PROBE_REDUCER) === -1) continue;
    probeLine = line;
  }
  if (probeLine === null) {
    return {
      name: NAME,
      pass: false,
      detail:
        `LIVE B3: no reject log line naming ${PROBE_REDUCER} in \`spacetime logs --format json\` ` +
        `for '${db}' — the module on that database may predate the reject envelope`,
    };
  }
  const attribution = functionAttribution(probeLine);
  if (!attribution.ok) return { name: NAME, pass: false, detail: `LIVE B3: ${attribution.reason}` };
  if (attribution.value !== PROBE_REDUCER) {
    return {
      name: NAME,
      pass: false,
      detail:
        `LIVE B3 (OBS-10/G4): the log line's '${attribution.field}' is ` +
        `'${attribution.value}', expected '${PROBE_REDUCER}'. The host must attribute a helper's ` +
        "emission (guards.rs's log_reject) to the INVOKING reducer — the whole cross-file " +
        'correlation story depends on it.',
    };
  }

  return {
    name: NAME,
    pass: true,
    detail:
      `LIVE: ${familyCount} metric families on ${server}/v1/metrics (>= ${MIN_FAMILIES}), all 4 ` +
      `named families + all 5 label keys present, and '${db}' attributes the rejected ` +
      `${PROBE_REDUCER} call's guards.rs log line to '${attribution.value}' via ` +
      `'${attribution.field}' (pinned CLI ${pins.version})`,
  };
}

export default observabilityMetricsContractEval;

// ---------------------------------------------------------------------------
// Main-guard: `node evals/observability-metrics-contract.eval.mjs` (optionally
// with MR_OBS_LIVE=1) runs it standalone — the shape the DoD live run uses.
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await observabilityMetricsContractEval();
    } catch (e) {
      return {
        name: 'observability-metrics-contract',
        pass: false,
        detail: `threw: ${e?.message ?? String(e)}`,
      };
    }
  })();
  console.log(
    `eval ${result.pass ? 'PASS' : 'FAIL'}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
  process.exit(result.pass ? 0 : 1);
}
