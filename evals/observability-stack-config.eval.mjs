// observability-stack-config.eval.mjs — m20e gates G6 (m20b carryover) + G9
// (relay/correlation/$trace_pair_set) + the m20e-2 park tripwires.
//
// WHAT THIS PROVES, AND WHERE
//   T-a..T-g (always, FIRST) — PROOF-OF-TEETH over inline fixtures. Every
//                    detector below is first shown to REJECT the shape it
//                    exists to catch. A gate that has never failed is a
//                    decoration.
//   C1-C18 (always) — the m20b stack-config predicates
//                    (ops/observability/checks/stack-config-checks.mjs) run
//                    against the REAL committed files. That module is the SSOT
//                    and is imported, never re-implemented; before this eval
//                    existed NOTHING in CI ran it (`just test` is cargo-only,
//                    justfile:24-26), so 1869 lines of predicates were dark.
//   G9a/G9b (always) — the D17 correlation pivot exists in BOTH directions,
//                    key-path scoped rather than file-wide substring.
//   G9c (always)   — `connection_id` is a log FIELD and a span ATTRIBUTE only,
//                    never a Loki or Prometheus LABEL (OBS-35/D12).
//   G9d (always)   — `$trace_pair_set` is read in 4 fail-loud stages. A missing
//                    file is NOT the empty set (anti-pattern 1).
//   G9e (always)   — membership excludes `movement_tick`, every PARSED $slo_set
//                    member, and every criterion bench id (OBS-50). The $slo_set
//                    is parsed from recording.rules.yml's own matchers, never
//                    re-spelled here; both matcher copies are parsed and must
//                    agree (AM11).
//   G9f (always)   — EXACT set equality between the committed membership and
//                    the reducers that actually carry a paired enter/exit
//                    breadcrumb, both directions reported separately (OBS-50's
//                    single-source-of-truth extension, spec:652-655).
//   G9g (always)   — PARK TRIPWIRE. The m20e-2 park is honest only while the
//                    parked things are absent; the moment one lands, this reds
//                    and names P1-P4.
//   G9h (always)   — SUPERSESSION TRIPWIRE. The day a paired call site appears,
//                    observability-log-wrapper.eval.mjs:1589 and
//                    observability_tests.rs:944 must be retired in the same
//                    change, and G11 must have run first (OBS-51).
//   G9i (always)   — the relay accepts no module-owner credential, NEVER writes
//                    (the batch CLI emits on stdout, so there is no `--out` flag
//                    and no blessed write call to hide behind), and its pure
//                    core touches no filesystem at all (OBS-45). "Always" is
//                    literal: when the files are absent it fails saying so,
//                    rather than falling silent.
//   G9j (always)   — relay hygiene over EVERY .mjs under relay/ (tests included,
//                    per AM12's scope) + the EXACT production file set: a
//                    missing file fails, and an unexpected extra non-test .mjs
//                    fails (anti-smuggling — the parked daemon cannot creep back
//                    in under a new filename).
//   G9k (always)   — runs `node --test` over the relay suites AND the m20b
//                    checks suites. This is the only door those suites have:
//                    nothing else in `just ci` executes them.
//
// PARKED — m20e-2 (verbatim; do NOT paraphrase into a TBD, anti-pattern 11):
//   P1  checkServiceSetExact(compose, [...SEVEN, 'mr-trace-relay']) (spec:650)
//   P2  checkModuleLogsMountReadOnly for the RELAY's own mount, ro not rw
//       (OBS-45; spec:650-651). AM18: checkModuleLogsMountReadOnly already
//       generalizes over every `replicas`-sourced mount, so C5 may satisfy P2
//       automatically once the relay service lands — verify, do not duplicate.
//   P3  prometheus.yml `job_name: mr-trace-relay` scraping the relay's /health
//       endpoint (OBS-46; spec:655-656)
//   P4  grafana alerting dead-man's-switch on that target's `up` metric,
//       DISTINCT from AlloyDown, and routed to a live contact point (OBS-46;
//       spec:656-657)
//   G9g reds the moment any of these becomes landable. Do NOT "helpfully" add a
//   scrape target or an alert rule for a service that does not exist
//   (anti-pattern 13): a permanently-zero dead-man's switch trains the operator
//   to ignore dead-man's switches.
//
// MEASURED COST (S3): the G9k subprocess is the only non-trivial cost in this
// eval; it is bounded by NODE_TEST_TIMEOUT_MS and its wall time is recorded in
// the slice handoff.
//
// NO `new RegExp(` anywhere. No regex at all, in fact — String methods and
// hand-rolled walkers only (the remote Semgrep detect-non-literal-regexp gate
// has red-ed this repo 3x). `spawnSync` is called with ARRAY ARGS only, never a
// shell string. No `Date.now` in any assertion. No fixture file is written to
// disk: every fixture below is an inline string.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkAlertRuleHasReceiver,
  checkCaddyDualPosture,
  checkDashboardPanelsReal,
  checkListenAddrsLoopback,
  checkModuleLogsMountReadOnly,
  checkNoAlertingBlock,
  checkNoExecLogSource,
  checkNoQuotedCredential,
  checkQueriedSeriesAreDefined,
  checkRemoteWriteBothEnds,
  checkRetentionConfigured,
  checkRulesAreRecordOnly,
  checkRunbookHasRunnableSteps,
  checkS4AttributeValuesBounded,
  checkS4MetricLabelsBounded,
  checkServiceImagesPinned,
  checkServiceSetExact,
  checkStageMetricsLabelsBounded,
} from '../ops/observability/checks/stack-config-checks.mjs';

// ===========================================================================
// Constants
// ===========================================================================

const NAME = 'observability-stack-config (G6 + G9 + m20e-2 park tripwires, ADR-0180)';

const OPS = 'ops/observability';
const RELAY_REL = `${OPS}/relay`;

/** D3/OBS-19: the stack is exactly these seven services, no more, no fewer. */
export const SEVEN_SERVICES = [
  'prometheus',
  'alloy',
  'loki',
  'tempo',
  'grafana',
  'node_exporter',
  'caddy',
];

/**
 * OBS-37's banned-tool half, pinned by REPOSITORY rather than by digest.
 * The digest is read from the compose file (a digest bump is a legitimate,
 * reviewed change and must not require editing three files); the repository
 * name is what a banned tool would have to change, and it is pinned here.
 */
export const ALLOWED_IMAGE_REPOS = {
  prometheus: 'prom/prometheus',
  alloy: 'grafana/alloy',
  loki: 'grafana/loki',
  tempo: 'grafana/tempo',
  grafana: 'grafana/grafana',
  node_exporter: 'prom/node-exporter',
};

/** D12/OBS-36: the S2 label enum. `caddy` builds from a Dockerfile, no image. */
const D12_ALLOWED_LABELS = ['reducer', 'evt'];
const HOST_NATIVE_ALLOWLIST = ['up', 'spacetime_', 'node_'];

/** OBS-50: never in `$trace_pair_set`, independent of any parsed set. */
const ALWAYS_BANNED_REDUCER = 'movement_tick';

const RELAY_PURE_FILES = ['parse.mjs', 'pair.mjs', 'otlp.mjs', 'reconstruct.mjs'];
const RELAY_SHELL_FILE = 'mr-trace-relay.mjs';
const RELAY_PRODUCTION_FILES = [...RELAY_PURE_FILES, RELAY_SHELL_FILE];
const RELAY_TEST_FILES = RELAY_PURE_FILES.map((f) => f.replace('.mjs', '.test.mjs'));

const TRACE_PAIR_SET_REL = `${RELAY_REL}/trace-pair-set.json`;

/**
 * G9k's spawned suites — an EXPLICIT list, never a glob: a glob silently runs
 * fewer files the day one is renamed, and "0 files, 0 failures" exits 0.
 *
 * FLOOR DERIVATION (re-run after adding or removing any test in these files):
 *   grep -c '^test(' ops/observability/relay/*.test.mjs ops/observability/checks/*.test.mjs
 * At authoring time: parse 21 + pair 18 + otlp 14 + reconstruct 12 = 65 relay,
 * plus checks 103 + redteam 13 = 116, total 181.
 */
const NODE_TEST_FILES = [
  ...RELAY_TEST_FILES.map((f) => `${RELAY_REL}/${f}`),
  `${OPS}/checks/stack-config-checks.test.mjs`,
  `${OPS}/checks/stack-config-checks.redteam.test.mjs`,
];
const NODE_TEST_PASS_FLOOR = 181;
const NODE_TEST_TIMEOUT_MS = 60_000;

/**
 * T-g's non-vacuity floor: the number of REAL committed files this eval reads
 * through `readReal`. Scanning nothing is never green.
 */
const FILE_FLOOR = 14;

// ===========================================================================
// Real-file reading (fail-loud, counted)
// ===========================================================================

const READ_FILES = new Set();

/** Read a repo-relative file. A file this eval cannot read is NEVER green. */
export function readReal(rel) {
  let text;
  try {
    text = readFileSync(path.resolve(rel), 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${rel} (${err.code}) — an unreadable input is never green`);
  }
  if (text.trim().length === 0) {
    throw new Error(`${rel} is empty — nothing was scanned, which is never green`);
  }
  READ_FILES.add(rel);
  return text;
}

// ===========================================================================
// Shared text walkers (no regex anywhere)
// ===========================================================================

const fail = (detail) => ({ ok: false, detail });
const pass = (detail) => ({ ok: true, detail });

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function isAsciiLetter(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/** Digits-only integer parse; null for anything else (no regex, no NaN leaks). */
function toInt(text) {
  if (text.length === 0) return null;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c < '0' || c > '9') return null;
    n = n * 10 + (c.charCodeAt(0) - 48);
  }
  return n;
}

/** Strip `#` comments outside quotes, line by line (YAML). */
export function stripHashComments(text) {
  const out = [];
  for (const line of text.split('\n')) {
    let quote = '';
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '#') {
        cut = i;
        break;
      }
    }
    out.push(cut === -1 ? line : line.slice(0, cut));
  }
  return out.join('\n');
}

/** Lines strictly deeper-indented than `lines[idx]`, contiguously. */
function subBlock(lines, idx) {
  const base = indentOf(lines[idx]);
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  return out;
}

/** Indices of `<key>:` lines at EXACTLY `indent` (null = any indent). */
function keyIndices(lines, key, indent) {
  const out = [];
  const needle = `${key}:`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (indent !== null && indentOf(line) !== indent) continue;
    if (line.trim().startsWith(needle)) out.push(i);
  }
  return out;
}

/** The scalar after `<key>:` on `line`, unquoted. */
function scalarOf(line, key) {
  const t = line.trim();
  let value = t.slice(`${key}:`.length).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, value.length - 1);
    }
  }
  return value;
}

/**
 * Split a block into its `- ` list items, normalising each item's first line so
 * every direct child of an item sits at one consistent indent.
 */
function listItems(lines) {
  let itemIndent = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (!line.trim().startsWith('- ')) continue;
    const ind = indentOf(line);
    if (itemIndent === null || ind < itemIndent) itemIndent = ind;
  }
  if (itemIndent === null) return [];
  const items = [];
  let current = null;
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current) current.push(line);
      continue;
    }
    if (indentOf(line) === itemIndent && line.trim().startsWith('- ')) {
      current = [`${' '.repeat(itemIndent + 2)}${line.trim().slice(2)}`];
      items.push(current);
      continue;
    }
    if (current !== null) current.push(line);
  }
  return items;
}

// ===========================================================================
// G9a/G9b — the D17 correlation pivot, key-path scoped
// ===========================================================================

/** `{ ok, items }` where each item is `{ uid, lines }`. Fails loud on ambiguity. */
export function datasourceItems(datasourcesYmlText) {
  const lines = stripHashComments(datasourcesYmlText).split('\n');
  const roots = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('datasources:')) roots.push(i);
  }
  if (roots.length !== 1) {
    return fail(`expected exactly one column-0 \`datasources:\` key, found ${roots.length}`);
  }
  const block = subBlock(lines, roots[0]);
  const rawItems = listItems(block);
  if (rawItems.length === 0) return fail('`datasources:` declares zero entries — nothing scanned');

  const items = [];
  for (const itemLines of rawItems) {
    const uidIdx = keyIndices(itemLines, 'uid', indentOf(itemLines[0]));
    if (uidIdx.length !== 1) {
      return fail(
        `a datasource entry declares ${uidIdx.length} \`uid:\` keys; exactly 1 is required so ` +
          'the entry this check reads is the entry Grafana provisions',
      );
    }
    items.push({ uid: scalarOf(itemLines[uidIdx[0]], 'uid'), lines: itemLines });
  }
  const uids = items.map((i) => i.uid);
  if (new Set(uids).size !== uids.length) {
    return fail(`duplicate datasource uids: ${uids.join(', ')}`);
  }
  return { ok: true, detail: `${items.length} datasource entries: ${uids.join(', ')}`, items };
}

function itemByUid(parsed, uid) {
  return parsed.items.find((i) => i.uid === uid);
}

/** G9a — D17(1): Tempo's tracesToLogsV2 targets Loki and pivots on connection_id. */
export function checkTracesToLogsPivot(datasourcesYmlText) {
  const parsed = datasourceItems(datasourcesYmlText);
  if (!parsed.ok) return fail(`G9a: ${parsed.detail}`);
  const tempo = itemByUid(parsed, 'mr-tempo');
  if (tempo === undefined) return fail('G9a: no datasource with uid `mr-tempo`');

  const childIndent = indentOf(tempo.lines[0]);
  const jsonDataIdx = keyIndices(tempo.lines, 'jsonData', childIndent);
  if (jsonDataIdx.length !== 1) {
    return fail(`G9a: the Tempo entry declares ${jsonDataIdx.length} \`jsonData:\` keys, need 1`);
  }
  const jsonData = subBlock(tempo.lines, jsonDataIdx[0]);
  const t2lIdx = keyIndices(jsonData, 'tracesToLogsV2', null);
  if (t2lIdx.length !== 1) {
    return fail(
      `G9a (D17(1)): the Tempo entry declares ${t2lIdx.length} \`tracesToLogsV2:\` blocks — ` +
        'exactly 1 is required; without it a span cannot pivot to its log lines',
    );
  }
  const t2l = subBlock(jsonData, t2lIdx[0]);
  const uidIdx = keyIndices(t2l, 'datasourceUid', null);
  if (uidIdx.length !== 1) {
    return fail(`G9a: tracesToLogsV2 declares ${uidIdx.length} \`datasourceUid:\` keys, need 1`);
  }
  const target = scalarOf(t2l[uidIdx[0]], 'datasourceUid');
  if (target !== 'mr-loki') {
    return fail(`G9a: tracesToLogsV2 targets \`${target}\`, expected \`mr-loki\``);
  }
  const queryIdx = keyIndices(t2l, 'query', null);
  if (queryIdx.length !== 1) {
    return fail(
      `G9a: tracesToLogsV2 declares ${queryIdx.length} \`query:\` keys — a trace-to-logs block ` +
        'with no query pivots to every log line in the window, which is not a pivot',
    );
  }
  const query = scalarOf(t2l[queryIdx[0]], 'query');
  if (!query.includes('connection_id')) {
    return fail(
      'G9a (D17(1)): tracesToLogsV2 has a query that does not filter on `connection_id` — the ' +
        'session pivot is the whole point; a job-scoped query is a time-window join, not a ' +
        'correlation',
    );
  }
  return pass(`G9a: Tempo tracesToLogsV2 -> mr-loki, filtered on connection_id`);
}

/** G9b — D17(2): BOTH correlation directions exist, each keyed on connection_id. */
export function checkCorrelationBothDirections(datasourcesYmlText) {
  const parsed = datasourceItems(datasourcesYmlText);
  if (!parsed.ok) return fail(`G9b: ${parsed.detail}`);

  const directions = [];
  let totalEntries = 0;
  for (const item of parsed.items) {
    const corrIdx = keyIndices(item.lines, 'correlations', indentOf(item.lines[0]));
    if (corrIdx.length === 0) continue;
    if (corrIdx.length > 1) {
      return fail(`G9b: datasource \`${item.uid}\` declares ${corrIdx.length} correlations blocks`);
    }
    for (const entry of listItems(subBlock(item.lines, corrIdx[0]))) {
      totalEntries++;
      const targetIdx = keyIndices(entry, 'targetUID', null);
      if (targetIdx.length !== 1) {
        return fail(`G9b: a correlation on \`${item.uid}\` declares no single \`targetUID:\``);
      }
      const hasField = entry.some((l) => l.trim() === 'field: connection_id');
      if (!hasField) {
        return fail(
          `G9b (OBS-35/D17): the correlation on \`${item.uid}\` does not key on ` +
            '`field: connection_id` — any other field is a different pivot',
        );
      }
      directions.push(`${item.uid}->${scalarOf(entry[targetIdx[0]], 'targetUID')}`);
    }
  }

  for (const required of ['mr-loki->mr-tempo', 'mr-tempo->mr-loki']) {
    if (!directions.includes(required)) {
      return fail(
        `G9b (D17(2)): the \`${required}\` correlation is missing (found: ` +
          `${directions.join(', ') || 'none'}). Correlations are one-way; neither direction can ` +
          'be replaced by the other, so >= 1 is not the bar — BOTH are.',
      );
    }
  }
  if (totalEntries !== 2) {
    return fail(
      `G9b: found ${totalEntries} correlation entries; exactly 2 are expected (one per ` +
        'direction) so a third, unreviewed pivot cannot ride along unnoticed',
    );
  }
  return pass(`G9b: both correlation directions present (${directions.join(', ')})`);
}

// ===========================================================================
// G9c — connection_id is never a label
// ===========================================================================

/** The label keys declared by Alloy's `stage.labels { values = { ... } }`. */
export function alloyStageLabelKeys(alloyText) {
  const at = alloyText.indexOf('stage.labels');
  if (at === -1) return null;
  const valuesAt = alloyText.indexOf('values', at);
  if (valuesAt === -1) return null;
  const open = alloyText.indexOf('{', valuesAt);
  const close = alloyText.indexOf('}', open);
  if (open === -1 || close === -1) return null;
  const keys = [];
  for (const raw of alloyText.slice(open + 1, close).split('\n')) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.length > 0) keys.push(key);
  }
  return keys;
}

/** Every `by (...)` grouping in a PromQL-bearing YAML text. */
export function promByClauses(text) {
  const groups = [];
  for (const opener of ['by (', 'by(']) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(opener, from);
      if (at === -1) break;
      const close = text.indexOf(')', at);
      if (close === -1) return null;
      groups.push(
        text
          .slice(at + opener.length, close)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      );
      from = close + 1;
    }
  }
  return groups;
}

export function checkConnectionIdNotALabel(alloyText, recordingRulesText) {
  const labels = alloyStageLabelKeys(alloyText);
  if (labels === null || labels.length === 0) {
    return fail(
      'G9c: could not read a non-empty `stage.labels` block — a zero-label read vacuously ' +
        'satisfies "connection_id is not a label"',
    );
  }
  if (labels.includes('connection_id')) {
    return fail(
      'G9c (OBS-35/D12): `connection_id` is promoted to a Loki stream LABEL — that is one ' +
        'active series per session, which is the cardinality bomb D12 exists to stop. It is a ' +
        'log FIELD, filtered at query time.',
    );
  }
  const groups = promByClauses(stripHashComments(recordingRulesText));
  if (groups === null) return fail('G9c: an unterminated `by (` grouping — fail loud, not silent');
  if (groups.length === 0) {
    return fail(
      'G9c: zero `by (...)` groupings found in the recording rules — nothing was scanned',
    );
  }
  for (const group of groups) {
    if (group.includes('connection_id')) {
      return fail(
        'G9c (OBS-35/D12): a recording rule groups `by (connection_id)`, minting one recorded ' +
          'series per session',
      );
    }
  }
  return pass(
    `G9c: labels [${labels.join(', ')}] and ${groups.length} \`by (...)\` groupings, none ` +
      'carrying connection_id',
  );
}

// ===========================================================================
// G9d — the 4-stage fail-loud $trace_pair_set read
// ===========================================================================

/**
 * Stage 1 absent (null text) · 2 unparseable · 3 wrong schema or missing key ·
 * 4 a positively-read array. ABSENCE IS NOT THE EMPTY SET: a deleted or
 * unreadable config must fail, never read as "no reducers are instrumented"
 * (anti-pattern 1).
 */
export function readTracePairSet(textOrNull) {
  if (textOrNull === null || textOrNull === undefined) {
    return {
      ok: false,
      stage: 1,
      detail:
        `G9d stage 1: ${TRACE_PAIR_SET_REL} is absent. Absence is NOT the empty set — a deleted ` +
        'config would otherwise read as "nothing is instrumented" and every membership gate ' +
        'below would pass vacuously.',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(textOrNull);
  } catch (err) {
    return {
      ok: false,
      stage: 2,
      detail: `G9d stage 2: ${TRACE_PAIR_SET_REL} does not parse as JSON: ${err.message}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, stage: 3, detail: 'G9d stage 3: the config is not a JSON object' };
  }
  if (parsed.schema !== 1) {
    return {
      ok: false,
      stage: 3,
      detail: `G9d stage 3: schema is ${JSON.stringify(parsed.schema)}, expected 1`,
    };
  }
  if (!Object.hasOwn(parsed, 'trace_pair_set')) {
    return {
      ok: false,
      stage: 3,
      detail:
        'G9d stage 3: the `trace_pair_set` key is ABSENT. An absent key and an empty array are ' +
        'different facts and must not collapse into one.',
    };
  }
  if (!Array.isArray(parsed.trace_pair_set)) {
    return {
      ok: false,
      stage: 3,
      detail: 'G9d stage 3: `trace_pair_set` is present but is not an array',
    };
  }
  for (const entry of parsed.trace_pair_set) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return {
        ok: false,
        stage: 3,
        detail: `G9d stage 3: membership entry ${JSON.stringify(entry)} is not a reducer name`,
      };
    }
  }
  const names = [...parsed.trace_pair_set];
  return {
    ok: true,
    stage: 4,
    names,
    set: new Set(names),
    detail: `G9d stage 4: positively read ${names.length} member(s): [${names.join(', ')}]`,
  };
}

// ===========================================================================
// G9e — banned membership ($slo_set PARSED, bench ids READ, movement_tick)
// ===========================================================================

/** Parse EVERY `reducer=~"a|b|c"` matcher; AM11 requires them to agree. */
export function parseSloSet(recordingRulesText) {
  const needle = 'reducer=~"';
  const occurrences = [];
  let from = 0;
  for (;;) {
    const at = recordingRulesText.indexOf(needle, from);
    if (at === -1) break;
    const start = at + needle.length;
    const end = recordingRulesText.indexOf('"', start);
    if (end === -1) {
      return fail(
        'G9e: a `reducer=~"` matcher is never closed — the $slo_set cannot be parsed, and a ' +
          'silently-empty parse would make the banned-membership check vacuous',
      );
    }
    const names = recordingRulesText
      .slice(start, end)
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (names.length === 0) {
      return fail('G9e: a `reducer=~"..."` matcher parsed to ZERO names — fail loud, never empty');
    }
    occurrences.push(names);
    from = end + 1;
  }
  if (occurrences.length < 2) {
    return fail(
      `G9e (AM11): found ${occurrences.length} \`reducer=~\` matcher(s); recording.rules.yml ` +
        'carries the $slo_set twice (committed + total) and BOTH must be parsed — reading one ' +
        'copy cannot detect the two drifting apart',
    );
  }
  const canonical = [...occurrences[0]].sort().join('|');
  for (const names of occurrences) {
    if ([...names].sort().join('|') !== canonical) {
      return fail(
        `G9e (AM11): the $slo_set matcher copies DISAGREE: [${canonical}] vs ` +
          `[${[...names].sort().join('|')}] — the SSOT has already drifted`,
      );
    }
  }
  return {
    ok: true,
    names: [...occurrences[0]],
    occurrences: occurrences.length,
    detail: `G9e: ${occurrences.length} agreeing $slo_set matchers, ${occurrences[0].length} names`,
  };
}

/** The criterion bench ids, READ from game-core/benches/budgets.rs. */
export function benchIds(budgetsRsText) {
  const needle = 'id: "';
  const ids = [];
  let from = 0;
  for (;;) {
    const at = budgetsRsText.indexOf(needle, from);
    if (at === -1) break;
    const start = at + needle.length;
    const end = budgetsRsText.indexOf('"', start);
    if (end === -1) return fail('G9e: an unterminated bench id literal in budgets.rs');
    const id = budgetsRsText.slice(start, end).trim();
    if (id.length === 0) return fail('G9e: an empty bench id literal in budgets.rs');
    ids.push(id);
    from = end + 1;
  }
  if (ids.length !== 7) {
    return fail(
      `G9e (OBS-5/D7): read ${ids.length} criterion bench ids from budgets.rs, expected 7 — a ` +
        'short read would let a benched reducer slip into $trace_pair_set',
    );
  }
  return { ok: true, ids, detail: `G9e: 7 bench ids read: ${ids.join(', ')}` };
}

export function checkBannedMembership(configNames, bannedNames) {
  if (bannedNames.length === 0) {
    return fail('G9e: the banned set is empty — nothing could be excluded, which is never green');
  }
  const banned = new Set(bannedNames);
  const offenders = configNames.filter((n) => banned.has(n));
  if (offenders.length > 0) {
    return fail(
      `G9e (OBS-50): \`${offenders.join(', ')}\` is in $trace_pair_set but is banned — ` +
        '$trace_pair_set may never contain movement_tick, a $slo_set member, or a ' +
        'criterion-benched hot path (breadcrumb overhead would be measured as an SLO regression)',
    );
  }
  return pass(
    `G9e: ${configNames.length} member(s) intersect the ${banned.size}-name banned set in 0 places`,
  );
}

// ===========================================================================
// G9f — reducers that actually carry a paired enter/exit breadcrumb
// ===========================================================================

// The needles are ASSEMBLED, never spelled contiguously, so this file cannot
// satisfy any crate-wide or repo-wide scan with its own text (the
// observability_tests.rs `concat!` idiom, :945-946).
const DQ = String.fromCharCode(34);
const ENTER_NEEDLE = `Some(${DQ}enter${DQ})`;
const EXIT_NEEDLE = `Some(${DQ}exit${DQ})`;
const REDUCER_ATTR = '#[spacetimedb::reducer';

/** Blank out whole-line `//` comments so a doc MENTION is never a call site. */
function scrubCommentLines(src) {
  return src
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

/**
 * AM5 — "paired reducer" means BOTH literals inside ONE reducer function's
 * body, found by brace-tracking (the observability_tests.rs `fn_body` idiom).
 * A file-wide `contains(enter) && contains(exit)` would call two unrelated
 * reducers a pair; the T-c negative control proves this one does not.
 *
 * `orphans` closes the granularity blind spot: a phase literal OUTSIDE any
 * reducer body cannot be attributed to a reducer name, so it is reported rather
 * than silently dropped.
 */
export function pairedReducers(srcMap) {
  const paired = new Set();
  const orphans = [];
  let reducersScanned = 0;
  let attrsSeen = 0;

  for (const file of Object.keys(srcMap).sort()) {
    const src = scrubCommentLines(srcMap[file]);
    const bodies = [];

    // Counted from the SAME scrubbed text the walk reads, so `attrsSeen !==
    // reducersScanned` means the brace tracking derailed (an unbalanced brace
    // inside a string literal is the realistic cause) rather than that the tree
    // changed. A derailed walk silently stops finding call sites, which is
    // exactly the vacuous-green G9f must not have.
    let attrFrom = 0;
    for (;;) {
      const at = src.indexOf(REDUCER_ATTR, attrFrom);
      if (at === -1) break;
      attrsSeen++;
      attrFrom = at + REDUCER_ATTR.length;
    }

    let from = 0;
    for (;;) {
      const attr = src.indexOf(REDUCER_ATTR, from);
      if (attr === -1) break;
      const fnAt = src.indexOf('fn ', attr);
      if (fnAt === -1) break;
      let nameEnd = fnAt + 3;
      while (nameEnd < src.length) {
        const c = src[nameEnd];
        const wordish = isAsciiLetter(c) || (c >= '0' && c <= '9') || c === '_';
        if (!wordish) break;
        nameEnd++;
      }
      const name = src.slice(fnAt + 3, nameEnd).trim();
      const open = src.indexOf('{', nameEnd);
      if (open === -1) break;
      let depth = 0;
      let close = -1;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close === -1) break;
      reducersScanned++;
      const body = src.slice(open + 1, close);
      bodies.push([open, close]);
      if (body.includes(ENTER_NEEDLE) && body.includes(EXIT_NEEDLE)) paired.add(name);
      from = close;
    }

    for (const needle of [ENTER_NEEDLE, EXIT_NEEDLE]) {
      let at = src.indexOf(needle);
      while (at !== -1) {
        const inside = bodies.some(([open, close]) => at > open && at < close);
        if (!inside) orphans.push({ file, literal: needle === ENTER_NEEDLE ? 'enter' : 'exit' });
        at = src.indexOf(needle, at + needle.length);
      }
    }
  }

  return { paired: [...paired].sort(), reducersScanned, attrsSeen, orphans };
}

/** OBS-50's SSOT extension: neither a superset nor a subset, reported apart. */
export function checkExactSetEquality(configNames, scannedNames) {
  const configSet = new Set(configNames);
  const scannedSet = new Set(scannedNames);
  const configOnly = configNames.filter((n) => !scannedSet.has(n)).sort();
  const sourceOnly = scannedNames.filter((n) => !configSet.has(n)).sort();
  if (configOnly.length === 0 && sourceOnly.length === 0) {
    return pass(
      `G9f (OBS-50): $trace_pair_set and the scanned call sites are the SAME set of ` +
        `${configSet.size} reducer(s)`,
    );
  }
  const clauses = [];
  if (configOnly.length > 0) {
    clauses.push(
      `SUPERSET: [${configOnly.join(', ')}] are in $trace_pair_set but NO reducer body carries ` +
        'a paired enter/exit breadcrumb for them (the config promises spans that will never exist)',
    );
  }
  if (sourceOnly.length > 0) {
    clauses.push(
      `SUBSET: [${sourceOnly.join(', ')}] carry a paired enter/exit breadcrumb but are NOT in ` +
        '$trace_pair_set (the relay will drop their crumbs; the instrumentation is dead weight)',
    );
  }
  return fail(`G9f (OBS-50 SSOT extension, spec:652-655): ${clauses.join(' | ')}`);
}

// ===========================================================================
// G9g — park tripwire helpers
// ===========================================================================

const RELAY_SERVICE_NAME = 'mr-trace-relay';

export function checkNoRelayScrapeJob(prometheusYmlText) {
  const lines = stripHashComments(prometheusYmlText).split('\n');
  const jobs = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('- job_name:')) jobs.push(scalarOf(t.slice(2), 'job_name'));
    else if (t.startsWith('job_name:')) jobs.push(scalarOf(t, 'job_name'));
  }
  if (jobs.length === 0) {
    return fail('G9g: prometheus.yml declares zero scrape jobs — nothing was scanned');
  }
  if (jobs.includes(RELAY_SERVICE_NAME)) {
    return fail(`G9g: a \`job_name: ${RELAY_SERVICE_NAME}\` scrape target is present`);
  }
  return pass(`G9g: ${jobs.length} scrape jobs (${jobs.join(', ')}), none for the parked relay`);
}

export function checkNoRelayAlertRule(alertRulesText) {
  const lines = stripHashComments(alertRulesText).split('\n');
  const offender = lines.find((l) => l.includes(RELAY_SERVICE_NAME));
  if (offender !== undefined) {
    return fail(`G9g: an alerting rule references ${RELAY_SERVICE_NAME}: ${offender.trim()}`);
  }
  const titles = lines.filter((l) => l.trim().startsWith('- uid:')).length;
  if (titles === 0) {
    return fail('G9g: the alerting provisioning declares zero rules — nothing was scanned');
  }
  return pass(`G9g: ${titles} alert rule(s), none for the parked relay`);
}

// ===========================================================================
// G9i/G9j — relay source hygiene
// ===========================================================================

/**
 * The CODE of a source file: whole-line comments dropped, and trailing `//`
 * comments cut QUOTE-AWARELY (the checks module's `stripComments` idiom, ported
 * from `#` to `//`). Without the quote tracking a legitimate comment naming a
 * banned token would false-positive; without cutting trailing comments at all,
 * a banned token could hide behind `const x = 1; // setTimeout(` and read as
 * code. Lowercased so every needle below can be written in lower case.
 */
function codeLines(source) {
  const out = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }
    let quote = '';
    let escaped = false;
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') {
        cut = i;
        break;
      }
    }
    out.push((cut === -1 ? line : line.slice(0, cut)).toLowerCase());
  }
  return out;
}

/**
 * OBS-45 static half, SUBSTRING needles. Prose ABOUT credentials belongs in
 * comments (which `codeLines` strips); a credential surface in CODE is banned.
 */
const CREDENTIAL_SURFACE = [
  '--token',
  '--auth',
  '--password',
  '--api-key',
  '--credential',
  'authorization',
  'bearer ',
  'password',
  'secret',
  'apikey',
  'api_key',
  'x-api-key',
  'x-auth',
];

/**
 * OBS-45, WORD-SEGMENT needles. A bare substring `token` would fire on
 * `tokenize` and `nextToken(` — both of which a hand-rolled parser (which is
 * exactly what the relay is) may legitimately want. So the needle must be its
 * own identifier SEGMENT: no ASCII letter on either side. Underscores, dots,
 * dashes and quotes are all boundaries, which is what matters —
 * `process.env.SESSION_TOKEN`, `.token`, `token:` and `'token'` all fire, while
 * `tokenize`/`tokenizer`/`nextToken` stay clean. Accepted residual, stated
 * rather than hidden: a run-together `authtoken` is missed; the `--token`,
 * `authorization`, `bearer ` and `x-api-key` substrings above cover the shapes
 * a real credential read actually takes.
 */
const CREDENTIAL_WORDS = ['token'];

function containsCredentialWord(line, word) {
  const isLetter = (c) => c !== undefined && c >= 'a' && c <= 'z';
  let at = line.indexOf(word);
  while (at !== -1) {
    if (!isLetter(line[at - 1]) && !isLetter(line[at + word.length])) return true;
    at = line.indexOf(word, at + word.length);
  }
  return false;
}

/**
 * Write-shaped fs APIs NO relay file may reach for (OBS-45).
 *
 * CONTRACT CONSEQUENCE, stated so it is a decision and not an accident: the
 * batch CLI writes its OTLP document to STDOUT ONLY — there is no `--out` flag.
 * Allowing one blessed `writeFileSync` for `--out` is what let a red-team probe
 * plant `writeFileSync('/tmp/x', 'x')` in the shell and stay silent. A relay
 * that never writes at all is the only version of OBS-45 a static scan can
 * actually prove, and `> file` covers every use `--out` would have had.
 */
const WRITE_APIS = [
  'writefilesync',
  'writefile',
  'appendfilesync',
  'appendfile',
  'copyfilesync',
  'copyfile',
  'createwritestream',
  'opensync',
  'unlinksync',
  'rmsync',
  'renamesync',
  'mkdirsync',
  'chmodsync',
  'truncatesync',
];

// AM12's mechanical ban list — this is what keeps the parked /health server and
// tail-follow daemon out of the slice rather than a promise that they stay out.
// AM12 scopes it to `relay/**`, so it is applied to EVERY .mjs in that directory
// including the four test files, not just the five production ones.
// The first needle is assembled from fragments so that no CODE line of this file
// spells the dynamic-regexp constructor contiguously; the remote Semgrep gate
// matches raw text as well as AST, and this repo has been red-ed by it 3x.
const HYGIENE_BANS = [
  `new reg${'exp('}`,
  'node:child_process',
  'node:http',
  'node:net',
  '.listen(',
  'setinterval(',
  'settimeout(',
  'date.now(',
];

// ===========================================================================
// PROOF-OF-TEETH — inline fixtures, always run, FIRST
// ===========================================================================

function composeWith(names) {
  const out = ['services:'];
  for (const n of names) {
    out.push(`  ${n}:`);
    out.push(`    image: example/${n}:v1@sha256:00ff00ff`);
  }
  return out.join('\n');
}

// Assembled INDEPENDENTLY of the scanner's own needles: if a needle above is
// mutated, T-c still spells the real literal and the tooth reddens.
const FIXTURE_ENTER = `Some(${String.fromCharCode(34)}enter${String.fromCharCode(34)})`;
const FIXTURE_EXIT = `Some(${String.fromCharCode(34)}exit${String.fromCharCode(34)})`;

const SRC_PAIRED = [
  '#[spacetimedb::reducer]',
  'pub fn synthetic_paired(ctx: &ReducerContext) -> Result<(), String> {',
  `    mr_log_breadcrumb("span", "", Breadcrumb { cause: Some("z"), phase: ${FIXTURE_ENTER}, ..Default::default() });`,
  '    if ctx.sender != ctx.identity() { return Err("no".to_string()); }',
  `    mr_log_breadcrumb("span", "", Breadcrumb { cause: Some("z"), phase: ${FIXTURE_EXIT}, ..Default::default() });`,
  '    Ok(())',
  '}',
].join('\n');

const SRC_SPLIT_ACROSS_REDUCERS = [
  '#[spacetimedb::reducer]',
  'pub fn only_enter(ctx: &ReducerContext) -> Result<(), String> {',
  '    let _ = ctx;',
  `    mr_log_breadcrumb("span", "", Breadcrumb { phase: ${FIXTURE_ENTER}, ..Default::default() });`,
  '    Ok(())',
  '}',
  '',
  '#[spacetimedb::reducer]',
  'pub fn only_exit(ctx: &ReducerContext) -> Result<(), String> {',
  '    let _ = ctx;',
  `    mr_log_breadcrumb("span", "", Breadcrumb { phase: ${FIXTURE_EXIT}, ..Default::default() });`,
  '    Ok(())',
  '}',
].join('\n');

const SRC_ORPHAN_HELPER = [
  'fn helper_not_a_reducer() {',
  `    mr_log_breadcrumb("span", "", Breadcrumb { phase: ${FIXTURE_ENTER}, ..Default::default() });`,
  `    mr_log_breadcrumb("span", "", Breadcrumb { phase: ${FIXTURE_EXIT}, ..Default::default() });`,
  '}',
].join('\n');

const SRC_DOC_MENTION_ONLY = [
  '#[spacetimedb::reducer]',
  'pub fn documented(ctx: &ReducerContext) -> Result<(), String> {',
  `    // a doc mention of ${FIXTURE_ENTER} / ${FIXTURE_EXIT} is not a call site`,
  '    let _ = ctx;',
  '    Ok(())',
  '}',
].join('\n');

const DS_GOOD = [
  'apiVersion: 1',
  '',
  'datasources:',
  '  - name: Loki',
  '    type: loki',
  '    uid: mr-loki',
  '    correlations:',
  '      - targetUID: mr-tempo',
  '        label: Logs to trace',
  '        type: query',
  '        config:',
  '          field: connection_id',
  '          target:',
  '            queryType: traceql',
  '            query: \'{ span.connection_id = "$${__value.raw}" }\'',
  '  - name: Tempo',
  '    type: tempo',
  '    uid: mr-tempo',
  '    jsonData:',
  '      tracesToLogsV2:',
  '        datasourceUid: mr-loki',
  '        customQuery: true',
  '        query: \'{job="spacetimedb-module"} | json | connection_id = "$${__span.tags.connection_id}"\'',
  '    correlations:',
  '      - targetUID: mr-loki',
  '        label: Trace to logs',
  '        type: query',
  '        config:',
  '          field: connection_id',
  '          target:',
  '            expr: \'{job="spacetimedb-module"} | json | connection_id = "$${__value.raw}"\'',
].join('\n');

// tracesToLogsV2 present and correctly targeted, but the query is a bare job
// selector: a time-window join that LOOKS like a pivot.
const DS_NO_PIVOT_KEY = DS_GOOD.replace(
  '| json | connection_id = "$${__span.tags.connection_id}"',
  '',
);

// Only the Loki -> Tempo leg. Derived-field-style thinking: "one direction is
// enough". It is not — correlations are one-way.
const DS_ONE_DIRECTION = DS_GOOD.split('\n')
  .slice(0, DS_GOOD.split('\n').indexOf('    correlations:', 20))
  .join('\n');

const RULES_UNPARSEABLE_MATCHER = [
  'groups:',
  '  - name: mr-slo',
  '    rules:',
  '      - record: mr:slo_set_txns_total:rate5m',
  '        expr: |',
  '          sum by (reducer) (rate(spacetime_num_txns_total{reducer=~"move_player|create_player',
].join('\n');

const RULES_TWO_AGREEING = [
  'groups:',
  '  - name: mr-slo',
  '    rules:',
  '      - record: a',
  '        expr: |',
  '          sum by (reducer) (rate(x{committed="true",reducer=~"move_player|evolve_monster"}[5m]))',
  '      - record: b',
  '        expr: |',
  '          sum by (reducer) (rate(x{reducer=~"move_player|evolve_monster"}[5m]))',
].join('\n');

const RULES_TWO_DISAGREEING = RULES_TWO_AGREEING.replace(
  'rate(x{reducer=~"move_player|evolve_monster"}',
  'rate(x{reducer=~"move_player"}',
);

const ALLOY_LABELS_WITH_CONNECTION_ID = [
  'loki.process "module_logs" {',
  '  stage.labels {',
  '    values = {',
  '      reducer       = "",',
  '      evt           = "",',
  '      connection_id = "",',
  '    }',
  '  }',
  '}',
].join('\n');

const ALLOY_LABELS_BOUNDED = ALLOY_LABELS_WITH_CONNECTION_ID.split('\n')
  .filter((l) => !l.includes('connection_id'))
  .join('\n');

const RULES_BY_CONNECTION_ID = [
  'groups:',
  '  - name: mr-slo',
  '    rules:',
  '      - record: mr:x',
  '        expr: |',
  '          sum by (connection_id) (rate(mr_log_events_total[5m]))',
].join('\n');

const TEETH = [
  {
    id: 'T-a',
    // Kills a service-set check that counts instead of comparing, and proves
    // G9g's detector actually sees an 8th service arriving.
    run() {
      const seven = checkServiceSetExact(composeWith(SEVEN_SERVICES), SEVEN_SERVICES);
      if (!seven.ok) return `the real 7-service shape was rejected: ${seven.detail}`;
      const eight = checkServiceSetExact(
        composeWith([...SEVEN_SERVICES, RELAY_SERVICE_NAME]),
        SEVEN_SERVICES,
      );
      if (eight.ok) return 'an 8-service compose (the parked relay landing) was accepted';
      const substituted = checkServiceSetExact(
        composeWith([
          'prometheus',
          'alloy',
          'loki',
          'tempo',
          'grafana',
          'node_exporter',
          'datadog',
        ]),
        SEVEN_SERVICES,
      );
      if (substituted.ok) return 'a 7-service compose with `datadog` substituted in was accepted';
      return null;
    },
  },
  {
    id: 'T-b',
    // Kills a banned-membership check that only looks for movement_tick, or
    // only for the parsed $slo_set, or only for bench ids.
    run() {
      const banned = [ALWAYS_BANNED_REDUCER, 'move_player', 'apply_move'];
      if (checkBannedMembership([], banned).ok !== true) return 'the empty membership was rejected';
      for (const name of banned) {
        if (checkBannedMembership([name], banned).ok) return `\`${name}\` was accepted as a member`;
      }
      if (checkBannedMembership(['talk', 'apply_move'], banned).ok) {
        return 'a membership containing one legal and one banned name was accepted';
      }
      if (!checkBannedMembership(['talk'], banned).ok) {
        return 'a legal membership was rejected';
      }
      if (checkBannedMembership(['talk'], []).ok) {
        return 'an EMPTY banned set was treated as a pass — nothing could have been excluded';
      }
      return null;
    },
  },
  {
    id: 'T-c',
    // THE tooth that makes the empty-vs-empty equality honest. If the scanner
    // is broken, 0 === 0 is green forever and OBS-50 is unowned.
    run() {
      const detected = pairedReducers({ 'synthetic.rs': SRC_PAIRED });
      if (!detected.paired.includes('synthetic_paired')) {
        return `a reducer body carrying BOTH phase literals was not detected (paired=[${detected.paired.join(', ')}]) — an empty scan result would make G9f vacuously green`;
      }
      const equality = checkExactSetEquality([], detected.paired);
      if (equality.ok) return 'set-equality accepted a detected reducer against an EMPTY config';
      if (!equality.detail.includes('SUBSET')) {
        return `the failure did not report the SUBSET direction: ${equality.detail}`;
      }

      // NEGATIVE CONTROL (AM5): enter in one reducer, exit in another, same
      // file. A file-wide `contains && contains` calls this a pair.
      const split = pairedReducers({ 'split.rs': SRC_SPLIT_ACROSS_REDUCERS });
      if (split.paired.length !== 0) {
        return `enter in one reducer and exit in another registered as paired: [${split.paired.join(', ')}]`;
      }
      if (split.reducersScanned !== 2) {
        return `expected 2 scanned reducer bodies in the split fixture, got ${split.reducersScanned}`;
      }

      // A doc MENTION is not a call site (the 56-vs-53 miscount class).
      const documented = pairedReducers({ 'doc.rs': SRC_DOC_MENTION_ONLY });
      if (documented.paired.length !== 0) {
        return 'a commented-out mention of both literals registered as a paired reducer';
      }

      // The granularity blind spot is REPORTED, never silently dropped.
      const orphan = pairedReducers({ 'helper.rs': SRC_ORPHAN_HELPER });
      if (orphan.paired.length !== 0) return 'a non-reducer helper registered as a paired reducer';
      if (orphan.orphans.length !== 2) {
        return `a phase literal outside every reducer body must be reported as an orphan; got ${orphan.orphans.length}`;
      }

      // And both directions of inequality are distinguishable.
      const superset = checkExactSetEquality(['ghost_reducer'], []);
      if (superset.ok || !superset.detail.includes('SUPERSET')) {
        return `a config naming a reducer with no call site was not reported as a SUPERSET: ${superset.detail}`;
      }
      if (!checkExactSetEquality([], []).ok)
        return 'two genuinely empty sets were reported unequal';
      return null;
    },
  },
  {
    id: 'T-d',
    // Four DISTINCT failures. A loader that returns `[]` for any of them turns
    // "the config is gone" into "no reducers are instrumented".
    run() {
      const absent = readTracePairSet(null);
      const unparseable = readTracePairSet('   ');
      const noSchema = readTracePairSet('{}');
      const noKey = readTracePairSet('{"schema":1}');
      const cases = [absent, unparseable, noSchema, noKey];
      const labels = ['absent', 'blank', '{}', '{"schema":1}'];
      for (let i = 0; i < cases.length; i++) {
        if (cases[i].ok) return `the ${labels[i]} config was accepted`;
        if (typeof cases[i].detail !== 'string' || cases[i].detail.length === 0) {
          return `the ${labels[i]} failure carries no detail`;
        }
      }
      if (new Set(cases.map((c) => c.detail)).size !== 4) {
        return 'the four failure modes are not distinguishable from their details';
      }
      if (absent.stage !== 1 || unparseable.stage !== 2) return 'stages 1 and 2 are mislabelled';
      if (noSchema.stage !== 3 || noKey.stage !== 3) return 'stage 3 is mislabelled';

      const wrongType = readTracePairSet('{"schema":1,"trace_pair_set":"move_player"}');
      if (wrongType.ok) return 'a STRING membership was accepted as an array';
      const wrongSchema = readTracePairSet('{"schema":2,"trace_pair_set":[]}');
      if (wrongSchema.ok) return 'schema 2 was accepted';
      const good = readTracePairSet('{"schema":1,"trace_pair_set":[]}');
      if (!good.ok) return `the committed empty shape was rejected: ${good.detail}`;
      if (good.stage !== 4 || good.names.length !== 0) return 'the good read is mis-shaped';
      const populated = readTracePairSet('{"schema":1,"trace_pair_set":["talk"]}');
      if (!populated.ok || populated.names[0] !== 'talk') return 'a populated read is mis-shaped';
      return null;
    },
  },
  {
    id: 'T-e',
    // Kills file-wide `text.includes('connection_id')`: the string is present
    // in both broken fixtures, in a DIFFERENT key path.
    run() {
      const good = checkTracesToLogsPivot(DS_GOOD);
      if (!good.ok) return `the well-formed pivot fixture was rejected: ${good.detail}`;
      const goodBoth = checkCorrelationBothDirections(DS_GOOD);
      if (!goodBoth.ok) return `the two-direction fixture was rejected: ${goodBoth.detail}`;

      if (!DS_NO_PIVOT_KEY.includes('connection_id')) {
        return 'FIXTURE: the no-pivot fixture must still MENTION connection_id elsewhere';
      }
      if (checkTracesToLogsPivot(DS_NO_PIVOT_KEY).ok) {
        return 'a tracesToLogsV2 whose query does not filter on connection_id was accepted';
      }

      if (!DS_ONE_DIRECTION.includes('connection_id')) {
        return 'FIXTURE: the one-direction fixture must still mention connection_id';
      }
      const oneWay = checkCorrelationBothDirections(DS_ONE_DIRECTION);
      if (oneWay.ok) return 'a single correlation direction was accepted as the pivot';
      if (!oneWay.detail.includes('mr-tempo->mr-loki')) {
        return `the failure did not name the MISSING direction: ${oneWay.detail}`;
      }

      const noDatasources = checkTracesToLogsPivot('apiVersion: 1\n');
      if (noDatasources.ok) return 'a file with no datasources: key was accepted';
      return null;
    },
  },
  {
    id: 'T-f',
    // Kills a matcher parser that returns an empty set on malformed input —
    // which would make G9e's intersection vacuously empty.
    run() {
      const unparseable = parseSloSet(RULES_UNPARSEABLE_MATCHER);
      if (unparseable.ok) return 'an unterminated `reducer=~"` matcher parsed "successfully"';
      const single = parseSloSet('expr: rate(x{reducer=~"move_player"}[5m])');
      if (single.ok) return 'a SINGLE matcher copy was accepted; AM11 requires both to be parsed';
      const agreeing = parseSloSet(RULES_TWO_AGREEING);
      if (!agreeing.ok) return `two agreeing matcher copies were rejected: ${agreeing.detail}`;
      if (agreeing.names.length !== 2) return `parsed ${agreeing.names.length} names, expected 2`;
      const disagreeing = parseSloSet(RULES_TWO_DISAGREEING);
      if (disagreeing.ok) return 'two DISAGREEING matcher copies were accepted (AM11)';
      const none = parseSloSet('groups: []');
      if (none.ok) return 'a rules file with no matcher at all was accepted';

      const ids = benchIds('pub const BUDGETS: &[Budget] = &[];');
      if (ids.ok) return 'a budgets.rs with zero bench ids was accepted';

      // G9c's own teeth, alongside the parse ones.
      const labelled = checkConnectionIdNotALabel(
        ALLOY_LABELS_WITH_CONNECTION_ID,
        RULES_TWO_AGREEING,
      );
      if (labelled.ok) return 'connection_id promoted to a Loki LABEL was accepted';
      const grouped = checkConnectionIdNotALabel(ALLOY_LABELS_BOUNDED, RULES_BY_CONNECTION_ID);
      if (grouped.ok) return 'a recording rule grouping `by (connection_id)` was accepted';
      const clean = checkConnectionIdNotALabel(ALLOY_LABELS_BOUNDED, RULES_TWO_AGREEING);
      if (!clean.ok) return `the clean label/grouping fixture was rejected: ${clean.detail}`;
      const noLabels = checkConnectionIdNotALabel('loki.process "x" { }', RULES_TWO_AGREEING);
      if (noLabels.ok) return 'a config with NO stage.labels block vacuously passed';
      return null;
    },
  },
  {
    id: 'T-g',
    // Non-vacuity of the reader itself: a missing input must throw, not return
    // '' and let every `includes` below report a clean absence.
    run() {
      let threw = false;
      try {
        readReal(`${OPS}/this-file-does-not-exist.yml`);
      } catch (err) {
        threw = true;
        if (!err.message.includes('never green')) {
          return `the reader threw without saying why: ${err.message}`;
        }
      }
      if (!threw) return 'readReal returned normally for a missing file';
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
// C4 helper — image repositories pinned, digests read
// ===========================================================================

/** `{ service: image }` for every `image:` under a compose service key. */
export function composeImages(composeText) {
  const lines = stripHashComments(composeText).split('\n');
  const start = lines.findIndex((l) => l.startsWith('services:'));
  if (start === -1) return null;
  const images = {};
  let service = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (indentOf(line) === 0) break;
    if (indentOf(line) === 2 && line.trim().endsWith(':')) {
      service = line.trim().slice(0, -1);
      continue;
    }
    if (service !== null && line.trim().startsWith('image:')) {
      images[service] = scalarOf(line, 'image');
    }
  }
  return images;
}

// ===========================================================================
// The eval
// ===========================================================================

export async function observabilityStackConfigEval() {
  const toothMiss = runTeeth();
  if (toothMiss) return { name: NAME, pass: false, detail: toothMiss };

  const failures = [];
  const record = (id, result) => {
    if (!result || result.ok !== true) {
      failures.push(`${id}: ${result?.detail ?? 'no result'}`);
    }
    return result;
  };

  // --- real files -----------------------------------------------------------
  let prometheusYml;
  let recordingRules;
  let compose;
  let alloy;
  let caddyfile;
  let alertRules;
  let contactPoints;
  let notificationPolicies;
  let dashboardJson;
  let datasourcesYml;
  let lokiConfig;
  let tempoConfig;
  let runbook;
  let budgetsRs;
  try {
    prometheusYml = readReal(`${OPS}/prometheus.yml`);
    recordingRules = readReal(`${OPS}/rules/recording.rules.yml`);
    compose = readReal(`${OPS}/docker-compose.yml`);
    alloy = readReal(`${OPS}/alloy/config.alloy`);
    caddyfile = readReal(`${OPS}/Caddyfile`);
    alertRules = readReal(`${OPS}/grafana/provisioning/alerting/rules.yml`);
    contactPoints = readReal(`${OPS}/grafana/provisioning/alerting/contact-points.yml`);
    notificationPolicies = readReal(
      `${OPS}/grafana/provisioning/alerting/notification-policies.yml`,
    );
    dashboardJson = readReal(`${OPS}/grafana/dashboards/monster-realm.json`);
    datasourcesYml = readReal(`${OPS}/grafana/provisioning/datasources/datasources.yml`);
    lokiConfig = readReal(`${OPS}/loki/loki-config.yml`);
    tempoConfig = readReal(`${OPS}/tempo/tempo-config.yml`);
    runbook = readReal('docs/observability-dr-runbook.md');
    budgetsRs = readReal('game-core/benches/budgets.rs');
  } catch (err) {
    return { name: NAME, pass: false, detail: `INPUTS: ${err.message}` };
  }

  // --- C1/C2: OBS-18 -------------------------------------------------------
  record('C1', checkNoAlertingBlock(prometheusYml));

  // C2 resolves the rule documents from `rule_files:` THROUGH the compose
  // mount, never from a filename convention: a rule file the operator loads
  // under a name this eval did not guess would otherwise go unscanned.
  const ruleFiles = [];
  {
    const lines = stripHashComments(prometheusYml).split('\n');
    const at = lines.findIndex((l) => l.startsWith('rule_files:'));
    const mounts = [];
    for (const line of stripHashComments(compose).split('\n')) {
      const t = line.trim();
      if (!t.startsWith('- ./')) continue;
      const parts = t.slice(2).split(':');
      if (parts.length < 2) continue;
      mounts.push({ host: parts[0], container: parts[1] });
    }
    if (at === -1) {
      failures.push('C2: prometheus.yml declares no `rule_files:` key — nothing to resolve');
    } else {
      for (const line of subBlock(lines, at)) {
        const t = line.trim();
        if (!t.startsWith('- ')) continue;
        const containerPath = scalarOf(`x: ${t.slice(2)}`, 'x');
        const mount = mounts.find((m) => containerPath.startsWith(`${m.container}/`));
        if (mount === undefined) {
          failures.push(
            `C2: rule file \`${containerPath}\` resolves through no compose mount — the loaded ` +
              'document cannot be located, so "record-only" cannot be confirmed',
          );
          continue;
        }
        const rel = `${OPS}/${mount.host.slice(2)}${containerPath.slice(mount.container.length)}`;
        try {
          ruleFiles.push({ name: rel, text: readReal(rel) });
        } catch (err) {
          failures.push(`C2: ${err.message}`);
        }
      }
    }
  }
  record('C2', checkRulesAreRecordOnly(ruleFiles));

  // --- C3/C4/C5/C6: compose ------------------------------------------------
  const serviceSet = record('C3', checkServiceSetExact(compose, SEVEN_SERVICES));

  const images = composeImages(compose);
  if (images === null) {
    failures.push('C4: docker-compose.yml has no readable `services:` block');
  } else {
    const named = Object.keys(images).sort();
    const expected = Object.keys(ALLOWED_IMAGE_REPOS).sort();
    if (named.join(',') !== expected.join(',')) {
      failures.push(
        `C4 (OBS-33/37): the image-bearing service set is [${named.join(', ')}], expected ` +
          `[${expected.join(', ')}] (caddy builds from a Dockerfile and has no image:)`,
      );
    }
    for (const [service, image] of Object.entries(images)) {
      const repo = ALLOWED_IMAGE_REPOS[service];
      if (repo === undefined) continue;
      if (!image.startsWith(`${repo}:`)) {
        failures.push(
          `C4 (OBS-37): service \`${service}\` runs \`${image}\`, whose repository is not ` +
            `\`${repo}\` — a banned tool under an expected service name is the shape this catches`,
        );
      }
    }
    // The digest half is delegated to the SSOT predicate, fed the digests the
    // compose actually declares: a reviewed digest bump edits ONE file, while
    // an unpinned or `:latest` image still fails inside the predicate.
    record('C4', checkServiceImagesPinned(compose, images));
  }
  record('C5', checkModuleLogsMountReadOnly(compose));
  record('C6', checkListenAddrsLoopback(compose));

  // --- C7-C11: Alloy -------------------------------------------------------
  record('C7', checkNoExecLogSource(alloy, compose));
  record('C8', checkStageMetricsLabelsBounded(alloy, D12_ALLOWED_LABELS));
  record('C9', checkS4MetricLabelsBounded(alloy));
  record('C10', checkS4AttributeValuesBounded(alloy));
  record('C11', checkRemoteWriteBothEnds(alloy, compose));

  // --- C12-C18 -------------------------------------------------------------
  record('C12', checkCaddyDualPosture(caddyfile));
  record('C13', checkAlertRuleHasReceiver(alertRules, contactPoints, notificationPolicies));
  record('C14', checkDashboardPanelsReal(dashboardJson));
  record(
    'C15',
    checkQueriedSeriesAreDefined(recordingRules, dashboardJson, alertRules, HOST_NATIVE_ALLOWLIST),
  );
  record(
    'C16',
    checkRetentionConfigured({
      composeText: compose,
      lokiText: lokiConfig,
      tempoText: tempoConfig,
    }),
  );
  record(
    'C17',
    checkNoQuotedCredential([
      { name: 'docker-compose.yml', text: compose },
      { name: 'prometheus.yml', text: prometheusYml },
      { name: 'alloy/config.alloy', text: alloy },
      { name: 'Caddyfile', text: caddyfile },
      { name: 'loki/loki-config.yml', text: lokiConfig },
      { name: 'tempo/tempo-config.yml', text: tempoConfig },
      { name: 'rules/recording.rules.yml', text: recordingRules },
      { name: 'grafana/provisioning/datasources/datasources.yml', text: datasourcesYml },
      { name: 'grafana/provisioning/alerting/rules.yml', text: alertRules },
      { name: 'grafana/provisioning/alerting/contact-points.yml', text: contactPoints },
      {
        name: 'grafana/provisioning/alerting/notification-policies.yml',
        text: notificationPolicies,
      },
      { name: 'grafana/dashboards/monster-realm.json', text: dashboardJson },
      { name: 'docs/observability-dr-runbook.md', text: runbook },
    ]),
  );
  record('C18', checkRunbookHasRunnableSteps(runbook));

  // --- G9a/G9b/G9c ---------------------------------------------------------
  record('G9a', checkTracesToLogsPivot(datasourcesYml));
  record('G9b', checkCorrelationBothDirections(datasourcesYml));
  record('G9c', checkConnectionIdNotALabel(alloy, recordingRules));

  // --- G9d: $trace_pair_set ------------------------------------------------
  let membership = null;
  {
    const text = existsSync(path.resolve(TRACE_PAIR_SET_REL))
      ? readFileSync(path.resolve(TRACE_PAIR_SET_REL), 'utf8')
      : null;
    const read = readTracePairSet(text);
    record('G9d', read);
    if (read.ok) {
      membership = read.names;
      // AM19, mechanized rather than remembered: gitleaks runs remote-only and
      // its entropy/keyword rules fire on a credential-shaped WORD near a
      // quoted literal, so a helpful `note` in this config would red CI after
      // the push, where the fix costs a squash onto a fresh branch (force-push
      // is hook-blocked). Caught here instead, before the commit.
      const lowered = text.toLowerCase();
      for (const word of ['key', 'token', 'secret', 'password']) {
        if (lowered.includes(word)) {
          failures.push(
            `G9d (AM19): ${TRACE_PAIR_SET_REL} contains the word \`${word}\`. Keep this file's ` +
              'prose free of credential-shaped words — the remote secret scanners read it as a ' +
              'committed credential. If a REDUCER NAME legitimately contains it, that is a ' +
              'reviewed exception: record it in the PR and narrow this check in the same change.',
          );
        }
      }
    }
  }

  // --- G9e: banned membership ----------------------------------------------
  const sloSet = parseSloSet(recordingRules);
  record('G9e/$slo_set', sloSet);
  const benches = benchIds(budgetsRs);
  record('G9e/bench-ids', benches);
  if (membership !== null && sloSet.ok && benches.ok) {
    record(
      'G9e',
      checkBannedMembership(membership, [ALWAYS_BANNED_REDUCER, ...sloSet.names, ...benches.ids]),
    );
  } else {
    failures.push('G9e: skipped because an input above failed — a skipped gate is not a pass');
  }

  // --- G9f/G9h: the call-site scan -----------------------------------------
  const srcMap = {};
  {
    const srcRoot = path.resolve('server-module/src');
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      )) {
        const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
          continue;
        }
        if (!entry.name.endsWith('.rs') || entry.name.endsWith('_tests.rs')) continue;
        srcMap[rel] = readFileSync(path.join(dir, entry.name), 'utf8');
      }
    };
    walk(srcRoot, '');
  }
  if (Object.keys(srcMap).length < 10) {
    failures.push(
      `G9f: only ${Object.keys(srcMap).length} non-test .rs files found under server-module/src ` +
        '— the walk is broken, and a scanner that sees nothing passes everything',
    );
  }
  const scan = pairedReducers(srcMap);
  if (scan.attrsSeen < 10) {
    failures.push(
      `G9f: only ${scan.attrsSeen} \`#[spacetimedb::reducer\` attributes found across ` +
        `${Object.keys(srcMap).length} files — the scan sees almost nothing, and a scanner that ` +
        'sees nothing passes everything',
    );
  }
  if (scan.reducersScanned !== scan.attrsSeen) {
    failures.push(
      `G9f: ${scan.attrsSeen} reducer attributes but only ${scan.reducersScanned} bodies were ` +
        'extracted — the brace-tracking walk derailed part-way, so every call site after the ' +
        'derailment is invisible and the set equality below would be vacuous',
    );
  }
  if (scan.orphans.length > 0) {
    const where = scan.orphans.map((o) => `${o.file}(${o.literal})`).join(', ');
    failures.push(
      `G9f: a phase literal sits OUTSIDE every reducer body (${where}) — it cannot be attributed ` +
        'to a reducer name, so neither this scanner nor the Rust mirror can decide membership',
    );
  }
  if (membership !== null) {
    record('G9f', checkExactSetEquality(membership, scan.paired));
  } else {
    failures.push(
      'G9f: cannot run — G9d could not positively read a membership. A set equality against an ' +
        'ASSUMED empty config is exactly the vacuous green OBS-50 exists to prevent.',
    );
  }

  // --- G9g: PARK TRIPWIRE --------------------------------------------------
  {
    const noJob = checkNoRelayScrapeJob(prometheusYml);
    const noRule = checkNoRelayAlertRule(alertRules);
    const parkIntact = serviceSet.ok && noJob.ok && noRule.ok;
    if (!parkIntact) {
      failures.push(
        'G9g: THE m20e-2 PARK HAS ENDED — enable the parked assertions P1-P4 named in this ' +
          `file's header before merging. (services: ${serviceSet.detail} | scrape: ` +
          `${noJob.detail} | alerting: ${noRule.detail})`,
      );
    }
  }

  // --- G9h: SUPERSESSION TRIPWIRE ------------------------------------------
  if (scan.paired.length > 0) {
    failures.push(
      `G9h (OBS-51): [${scan.paired.join(', ')}] now carry a paired enter/exit breadcrumb. G9's ` +
        'set equality SUPERSEDES the two placeholder assertions that keep $trace_pair_set empty ' +
        '— retire evals/observability-log-wrapper.eval.mjs:1589 (A10) and ' +
        'server-module/src/observability_tests.rs:944 (g7_trace_pair_set_stays_empty) in the ' +
        'SAME change. G11 must run before membership merges: mr-load-driver with those ' +
        "reducers' breadcrumbs active, compared against the recorded noise floor.",
    );
  }

  // --- G9i/G9j: relay source ------------------------------------------------
  let relayFilesScanned = 0;
  {
    const relayDir = path.resolve(RELAY_REL);
    if (!existsSync(relayDir)) {
      failures.push(`G9j: ${RELAY_REL}/ does not exist — the relay core is unbuilt`);
    } else {
      const present = readdirSync(relayDir)
        .filter((f) => f.endsWith('.mjs'))
        .sort();
      const allowed = new Set([...RELAY_PRODUCTION_FILES, ...RELAY_TEST_FILES]);
      for (const required of RELAY_PRODUCTION_FILES) {
        if (!present.includes(required)) {
          failures.push(`G9j: ${RELAY_REL}/${required} is MISSING — an absent file is not a pass`);
        }
      }
      for (const found of present) {
        if (!allowed.has(found)) {
          failures.push(
            `G9j: unexpected ${RELAY_REL}/${found}. The production file set is fixed; a new ` +
              'non-test module is how the parked /health server and tail-follow daemon would ' +
              'creep back in-slice (AM12)',
          );
        }
      }

      // AM12's ban list is scoped to `relay/**`, so it runs over EVERY .mjs in
      // the directory, tests included: a `setTimeout` poll or a `node:http`
      // import smuggled into a test file is still relay code that ships.
      for (const file of present) {
        const lines = codeLines(readFileSync(path.join(relayDir, file), 'utf8'));
        for (const ban of HYGIENE_BANS) {
          if (lines.some((l) => l.includes(ban))) {
            failures.push(`G9j (AM12): ${RELAY_REL}/${file} contains a banned construct (${ban})`);
          }
        }
      }

      // OBS-45 is about the PRODUCTION surface only: a test may legitimately
      // build a fixture string naming a credential shape.
      for (const file of RELAY_PRODUCTION_FILES) {
        const full = path.join(relayDir, file);
        if (!existsSync(full)) continue;
        relayFilesScanned++;
        const lines = codeLines(readFileSync(full, 'utf8'));
        for (const surface of CREDENTIAL_SURFACE) {
          if (lines.some((l) => l.includes(surface))) {
            failures.push(
              `G9i (OBS-45): ${RELAY_REL}/${file} exposes a credential surface (${surface}) — ` +
                'the relay reads the same read-only bind mount Alloy does and must neither ' +
                'require nor accept a module-owner credential',
            );
          }
        }
        for (const word of CREDENTIAL_WORDS) {
          if (lines.some((l) => containsCredentialWord(l, word))) {
            failures.push(
              `G9i (OBS-45): ${RELAY_REL}/${file} reads a \`${word}\`-shaped value — OBS-45 ` +
                'forbids the relay REQUIRING or ACCEPTING a module-owner credential, and an env ' +
                'read is acceptance',
            );
          }
        }
        for (const api of WRITE_APIS) {
          if (lines.some((l) => l.includes(api))) {
            failures.push(
              `G9i (OBS-45): ${RELAY_REL}/${file} calls a write API (${api}). Every relay file ` +
                'is read-only: the batch CLI emits its document on STDOUT, so a write call has ' +
                'no legitimate caller here',
            );
          }
        }
        if (RELAY_PURE_FILES.includes(file) && lines.some((l) => l.includes('node:fs'))) {
          failures.push(
            `G9i: ${RELAY_REL}/${file} imports node:fs — the pure core takes text in and returns ` +
              'data out; all I/O belongs to the batch shell',
          );
        }
        if (
          file === RELAY_SHELL_FILE &&
          !lines.some((l) => l.includes('readfilesync') || l.includes('readdirsync'))
        ) {
          failures.push(
            `G9i: ${RELAY_REL}/${file} never reads the logs directory — a shell that reads ` +
              'nothing cannot be confirmed to read it READ-ONLY',
          );
        }
      }
    }
  }
  // G9i is documented as an ALWAYS assertion, so it must SAY something when the
  // files are absent. Without this, a tree with no relay at all produced zero
  // G9i output and the gate read as "nothing wrong here" — green by absence,
  // the exact shape G9d exists to reject one directory over.
  if (relayFilesScanned < RELAY_PRODUCTION_FILES.length) {
    failures.push(
      `G9i (OBS-45): only ${relayFilesScanned} of ${RELAY_PRODUCTION_FILES.length} production ` +
        'relay files could be scanned — a file that does not exist cannot be confirmed ' +
        'credential-free or write-free, and an unscanned file is not a clean one',
    );
  }

  // --- G9k: run the suites nothing else runs -------------------------------
  {
    for (const file of NODE_TEST_FILES) {
      if (!existsSync(path.resolve(file))) {
        failures.push(`G9k: ${file} does not exist — the suite list is explicit for this reason`);
      }
    }
    const run = spawnSync('node', ['--test', ...NODE_TEST_FILES], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: NODE_TEST_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (run.error !== undefined && run.error !== null) {
      failures.push(`G9k: \`node --test\` failed to run — ${run.error.message}`);
    } else if (run.signal !== null && run.signal !== undefined) {
      failures.push(
        `G9k: \`node --test\` was killed by ${run.signal} after ${NODE_TEST_TIMEOUT_MS}ms`,
      );
    } else if (run.status !== 0) {
      const tail = output.split('\n').slice(-40).join('\n');
      failures.push(`G9k: \`node --test\` exited ${run.status}. Tail:\n${tail}`);
    } else {
      // Exit code is authoritative (AM14); the summary is corroboration, parsed
      // tolerantly so a reporter-format change cannot red the gate on its own.
      const summary = {};
      for (const raw of output.split('\n')) {
        const t = raw.trim();
        let i = 0;
        while (i < t.length && !isAsciiLetter(t[i])) i++;
        const body = t.slice(i);
        for (const key of ['tests', 'pass', 'fail']) {
          if (summary[key] !== undefined) continue;
          if (!body.startsWith(`${key} `)) continue;
          const n = toInt(body.slice(key.length + 1).trim());
          if (n !== null) summary[key] = n;
        }
      }
      if (summary.fail !== undefined && summary.fail !== 0) {
        failures.push(`G9k: the runner reports ${summary.fail} failing test(s) despite exit 0`);
      }
      if (summary.pass !== undefined && summary.pass < NODE_TEST_PASS_FLOOR) {
        failures.push(
          `G9k: ${summary.pass} passing tests, floor ${NODE_TEST_PASS_FLOOR} — a suite that ` +
            'stopped running is indistinguishable from a suite that passed unless the count is ' +
            'checked (re-derive the floor with the grep in this file if tests were removed on ' +
            'purpose)',
        );
      }
    }
  }

  // --- T-g: non-vacuity floor ----------------------------------------------
  if (READ_FILES.size < FILE_FLOOR) {
    failures.push(
      `T-g: only ${READ_FILES.size} real files were read, floor ${FILE_FLOOR} — a scan that ` +
        'reads less than it claims is a scan that proves less than it claims',
    );
  }

  if (failures.length > 0) {
    return { name: NAME, pass: false, detail: failures.join(' || ') };
  }
  return {
    name: NAME,
    pass: true,
    detail:
      `C1-C18 pass against ${READ_FILES.size} real files; G9a/G9b both correlation directions; ` +
      `G9c connection_id is no label; G9d read ${membership?.length ?? 0} member(s) positively; ` +
      `G9e clear of movement_tick + ${sloSet.names?.length ?? 0} $slo_set names + ` +
      `${benches.ids?.length ?? 0} bench ids; G9f exact set equality over ${scan.reducersScanned} ` +
      `reducer bodies in ${Object.keys(srcMap).length} files; G9g the m20e-2 park is intact ` +
      '(7 services, no relay scrape job, no relay alert rule); G9h no supersession due; ' +
      `G9i/G9j ${RELAY_PRODUCTION_FILES.length} relay files clean; G9k ` +
      `${NODE_TEST_FILES.length} suites green (floor ${NODE_TEST_PASS_FLOOR})`,
  };
}

export default observabilityStackConfigEval;

// ---------------------------------------------------------------------------
// Main-guard: `node evals/observability-stack-config.eval.mjs` runs it alone.
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await observabilityStackConfigEval();
    } catch (e) {
      return {
        name: 'observability-stack-config',
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
