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
//   T-h..T-l (always, FIRST) — PROOF-OF-TEETH for the 13r-a boot tripwires
//                    below, over inline fixtures. Every one asserts the GOOD
//                    shape is ACCEPTED as well as the bad one rejected.
//   G12a (always)  — TEMPO PARK TRIPWIRE (ADR-0190 D1). The `command:` list is
//                    exactly, IN ORDER, the two committed flags — a SUBSET means
//                    the parked flag was removed (convert this gate per the
//                    PARKED — 13r-a block below), a SUPERSET means a new,
//                    possibly-undefined flag appeared. Plus the pinned image TAG
//                    (a version bump, not a CVE rebuild, must force
//                    re-verification), and the park's VISIBILITY: no `profiles:`,
//                    no `extends:`, `restart: unless-stopped`. A parked failure
//                    that vanishes from `docker compose ps` reads as closed.
//   G12b (always)  — every alert-rule group in EVERY document under
//                    grafana/provisioning/alerting/ (Grafana loads the whole
//                    provisioned directory; a sibling file with a bad interval
//                    crashes provisioning just as hard) declares exactly one
//                    `interval:`, which parses, is non-zero and is a multiple of
//                    Grafana's 10s scheduler tick. Every `for:` parses and is an
//                    exact multiple of its OWN group's interval — a repo
//                    convention, not a Grafana rule. Exact expected file set, and
//                    the grafana image TAG is pinned because the 10s tick is
//                    image-dependent.
//   G12c (always)  — the Dockerfile's FINAL stage removes the caddy binary's
//                    net-bind capability, as the LAST instruction that writes
//                    /usr/bin/caddy (buildkit preserves file capabilities across
//                    `COPY --from=`, so a later copy silently re-adds it), before
//                    exactly one `USER`. Stage-aware: a setcap in a discarded
//                    builder stage is not a fix.
//   G12d (always)  — the alloy service block is a KEY ALLOWLIST, not a
//                    four-property checklist: `privileged: true`, `group_add`,
//                    `pid: host` and friends each hand back everything the
//                    non-root + cap_drop posture just took away, while every
//                    property check stays green.
//   G12e (always)  — the S4 label-VALUE bounds are pinned character-for-character
//                    INSIDE otelcol.processor.transform "s4_keep"'s own
//                    `statements` list, not file-wide: the same two statements
//                    moved verbatim into an unwired component keep a file-wide
//                    check green while the live pipeline loses the bound.
//
// PARKED — 13r-a (verbatim; do NOT paraphrase into a TBD, anti-pattern 11):
//   D1  grafana/tempo:2.10.7 has NO listen-ADDRESS flag at all, so the committed
//       `-server.http-listen-address=127.0.0.1` is a flag tempo cannot parse and
//       C6's "all 7 services bind 127.0.0.1 only" is VACUOUS FOR TEMPO — tempo's
//       real binding lives in tempo/tempo-config.yml:9,11, which no gate reads.
//       G12a's job is to pin that known-false statement in place until the
//       follow-up lands; without it the next reader takes C6's green as proof.
//   The follow-up prescription, in order (ADR-0190 D1):
//     1. checks/stack-config-checks.mjs — checkListenAddrsLoopback stops being a
//        flat LISTEN_FLAGS scan and gains per-service binding sources: for tempo,
//        read http_listen_address / grpc_listen_address from
//        tempo/tempo-config.yml. Its signature gains the tempo config text, so
//        TWO call sites move: this eval's C6 and the checks suite's REAL-FILES
//        test.
//     2. checks/stack-config-checks.test.mjs — new teeth: tempo with no flag and
//        a config binding 0.0.0.0 FAILS; with a config binding 127.0.0.1 PASSES;
//        a missing or unreadable tempo config FAILS (absence is not loopback).
//        Re-derive NODE_TEST_PASS_FLOOR.
//     3. docker-compose.yml — delete the `-server.http-listen-address=127.0.0.1`
//        list item.
//     4. this eval — convert G12a to its post-fix form (expected list =
//        `-config.file=/etc/tempo/tempo-config.yml` only) and delete this block.
//     5. Proof: `docker compose up -d tempo` reaches a non-restarting state, and
//        `/tempo -help` is re-run if the image tag moved.
//   This block is SEPARATE from the m20e-2 block below ON PURPOSE: that park is
//   scoped to m20e-2 and G9g's failure message names P1-P4 by number. Adding a
//   P5 there would make the header lie and desynchronise G9g.
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
 *
 * FLOOR DERIVATION (re-derive, never guess, when a readReal call site is added):
 * the 14 distinct paths in the real-file try block, plus `ops/observability/
 * Dockerfile` (13r-a, G12c) = 15. The alerting-directory documents G12b
 * enumerates are `contact-points.yml`, `notification-policies.yml` and
 * `rules.yml`, all three ALREADY among those 14, and READ_FILES is a Set — so
 * they raise the count by 0. C2's rule documents resolve to
 * `rules/recording.rules.yml`, also already counted.
 */
const FILE_FLOOR = 15;

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
// 13r-a (ADR-0190) — G12a..G12e, the boot tripwires
//
// SCOPING DOCTRINE, stated once and obeyed by every detector below: a compose
// service block is resolved INSIDE the `services:` mapping, with an
// exactly-one-match requirement. The shipped `composeServiceBlock`
// (checks/stack-config-checks.mjs:98-111) does a whole-file `findIndex` for
// `  <name>:` while `parseComposeServices` scopes to `services:`, so a six-line
// top-level `x-decoy:` key holding a benign service shadows the real one and a
// compose with a public listener and a shell entrypoint passes five merged
// predicates today (live-proven; surfaced as R7, out of touches). The helpers
// below are written here rather than imported for exactly that reason — the
// bug is in the import, so importing it would inherit it.
// ===========================================================================

/** The `services:` mapping body, fail-loud. Never a whole-file search. */
function composeServicesBody(composeText) {
  const lines = stripHashComments(composeText).split('\n');
  const roots = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('services:')) roots.push(i);
  }
  if (roots.length !== 1) {
    return fail(`expected exactly one column-0 \`services:\` key, found ${roots.length}`);
  }
  if (lines[roots[0]].slice('services:'.length).trim().length > 0) {
    return fail('`services:` uses inline/flow style, which this scanner cannot read — fail loud');
  }
  return { ok: true, body: subBlock(lines, roots[0]) };
}

/** The lines of ONE compose service block, scoped inside `services:` (AM17). */
export function composeServiceBlockScoped(composeText, serviceName) {
  const services = composeServicesBody(composeText);
  if (!services.ok) return services;
  const idx = keyIndices(services.body, serviceName, 2);
  if (idx.length !== 1) {
    return fail(
      `found ${idx.length} \`${serviceName}:\` keys at two-space indent INSIDE \`services:\`; ` +
        'exactly 1 is required. A whole-file search would also match a top-level `x-decoy:` ' +
        "block's copy of this service name and validate the decoy instead of the real thing.",
    );
  }
  return {
    ok: true,
    detail: `${serviceName} block resolved`,
    lines: subBlock(services.body, idx[0]),
  };
}

/** The keys declared at EXACTLY `indent` in a block. Fail-loud on anything odd. */
function blockTopKeys(blockLines, indent) {
  const keys = [];
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (line.trim().length === 0) continue;
    if (indentOf(line) !== indent) continue;
    const t = line.trim();
    if (t.startsWith('- ')) {
      return fail(`a list item sits where a mapping key was expected: \`${t.slice(0, 48)}\``);
    }
    const colon = t.indexOf(':');
    if (colon <= 0) {
      return fail(`unparsable line where a mapping key was expected: \`${t.slice(0, 48)}\``);
    }
    keys.push({ name: t.slice(0, colon), index: i });
  }
  return { ok: true, keys };
}

/** The `- ` scalar items of the block under `blockLines[keyIndex]`, fail-loud. */
function scalarListUnder(blockLines, keyIndex) {
  const values = [];
  for (const line of subBlock(blockLines, keyIndex)) {
    if (line.trim().length === 0) continue;
    const t = line.trim();
    if (!t.startsWith('- ')) {
      return fail(`\`${t.slice(0, 48)}\` is not a \`- \` list item — fail loud, never skip`);
    }
    values.push(scalarOf(`x: ${t.slice(2).trim()}`, 'x'));
  }
  return { ok: true, values };
}

/** One scalar value from a scoped service block, fail-loud on 0 or >1 keys. */
function scopedServiceScalar(composeText, serviceName, key) {
  const block = composeServiceBlockScoped(composeText, serviceName);
  if (!block.ok) return block;
  const idx = keyIndices(block.lines, key, 4);
  if (idx.length !== 1) {
    return fail(`the \`${serviceName}\` service declares ${idx.length} \`${key}:\` keys, need 1`);
  }
  return { ok: true, value: scalarOf(block.lines[idx[0]], key) };
}

/** `image` starts with `tag`, and the tag is not a PREFIX of a longer one. */
function imageCarriesTag(image, tag) {
  if (!image.startsWith(tag)) return false;
  const next = image[tag.length];
  return next === undefined || next === '@';
}

// ---------------------------------------------------------------------------
// G12a — the tempo park tripwire
// ---------------------------------------------------------------------------

const TEMPO_FLAG_CONFIG = '-config.file=/etc/tempo/tempo-config.yml';
const TEMPO_FLAG_LISTEN = '-server.http-listen-address=127.0.0.1';

/** PARK FORM (ADR-0190 D1). Post-fix form drops the second item — see AM2. */
export const TEMPO_COMMAND_PARKED = [TEMPO_FLAG_CONFIG, TEMPO_FLAG_LISTEN];

/**
 * The TAG, not the digest (reviewer m2): a same-version CVE rebuild moves the
 * digest without changing the flag set, so a digest pin would red for nothing,
 * while a VERSION bump still forces re-verification of the park's premise —
 * which is the actual intent.
 */
export const TEMPO_IMAGE_TAG = 'grafana/tempo:2.10.7';

/** Must name BOTH files a reader has to open. A prescription in a PR body rots. */
const TEMPO_PARK_PRESCRIPTION =
  'FOLLOW-UP PRESCRIPTION (ADR-0190 D1): `checks/stack-config-checks.mjs` — ' +
  'checkListenAddrsLoopback stops being a flat LISTEN_FLAGS scan and gains per-service binding ' +
  'sources, reading http_listen_address / grpc_listen_address from `tempo/tempo-config.yml`; its ' +
  "signature gains that text, so TWO call sites move (this eval's C6 and the checks suite's " +
  'REAL-FILES test); its suite gains three teeth and NODE_TEST_PASS_FLOOR is re-derived; only ' +
  'then does the compose flag go, and this gate converts to its post-fix form.';

const TEMPO_PARK_TRUTH =
  'The committed flag is one grafana/tempo:2.10.7 cannot parse (it has no listen-ADDRESS flag at ' +
  'all), so C6\'s "all 7 services bind 127.0.0.1 only" is VACUOUS FOR TEMPO — tempo\'s real ' +
  'binding lives in tempo/tempo-config.yml, which no gate reads. This tripwire pins a known-false ' +
  'statement in place until the follow-up lands.';

export function checkTempoCommandParked(composeText) {
  const block = composeServiceBlockScoped(composeText, 'tempo');
  if (!block.ok) return fail(`G12a: ${block.detail} — ${TEMPO_PARK_TRUTH}`);

  const cmdIdx = keyIndices(block.lines, 'command', 4);
  if (cmdIdx.length !== 1) {
    return fail(
      `G12a: the tempo service declares ${cmdIdx.length} \`command:\` keys; exactly 1 is ` +
        'required. A missing command is not a passing park — it silently hands tempo its image ' +
        `default. ${TEMPO_PARK_TRUTH}`,
    );
  }
  if (scalarOf(block.lines[cmdIdx[0]], 'command').length > 0) {
    return fail("G12a: tempo's `command:` is inline/flow style, which this scanner cannot read");
  }
  const items = scalarListUnder(block.lines, cmdIdx[0]);
  if (!items.ok) return fail(`G12a: tempo's \`command:\` — ${items.detail}`);
  if (items.values.length === 0) {
    return fail("G12a: tempo's `command:` declares ZERO items — nothing was compared");
  }

  const found = items.values;
  const missing = TEMPO_COMMAND_PARKED.filter((f) => !found.includes(f));
  const extra = found.filter((f) => !TEMPO_COMMAND_PARKED.includes(f));
  if (missing.length > 0) {
    return fail(
      `G12a: tempo's command list is a SUBSET of the parked set — [${missing.join(', ')}] was ` +
        `REMOVED. If that was deliberate, the park has ended and this gate must be converted, ` +
        `not deleted. ${TEMPO_PARK_PRESCRIPTION}`,
    );
  }
  if (extra.length > 0) {
    return fail(
      `G12a: tempo's command list is a SUPERSET of the parked set — [${extra.join(', ')}] is new ` +
        'and possibly a flag this tempo version does not define, which is exactly the defect ' +
        `class the park exists to record. ${TEMPO_PARK_TRUTH}`,
    );
  }
  for (let i = 0; i < TEMPO_COMMAND_PARKED.length; i++) {
    if (found[i] !== TEMPO_COMMAND_PARKED[i]) {
      return fail(
        `G12a: tempo's command items are the right SET in the wrong ORDER (position ${i} is ` +
          `\`${found[i]}\`, expected \`${TEMPO_COMMAND_PARKED[i]}\`) — argv order is not a ` +
          'cosmetic detail, and a set-only comparison would not see this',
      );
    }
  }

  const image = scopedServiceScalar(composeText, 'tempo', 'image');
  if (!image.ok) return fail(`G12a: ${image.detail}`);
  if (!imageCarriesTag(image.value, TEMPO_IMAGE_TAG)) {
    return fail(
      `G12a: tempo runs \`${image.value}\`, whose tag is not the pinned \`${TEMPO_IMAGE_TAG}\`. ` +
        "The park's premise is image-specific: re-run `/tempo -help` against the new version and " +
        `re-verify the flag set before moving this pin. ${TEMPO_PARK_TRUTH}`,
    );
  }

  for (const banned of ['profiles', 'extends']) {
    if (keyIndices(block.lines, banned, 4).length > 0) {
      return fail(
        `G12a: the tempo service declares \`${banned}:\`. \`profiles:\` removes tempo from ` +
          '`docker compose config --services` entirely, so the stack reads six-of-six healthy and ' +
          'the park reads as CLOSED; `extends:` smuggles arbitrary keys in from a file no ' +
          'single-file detector reads. The park is honest only while the failure stays visible ' +
          'in `docker compose ps`.',
      );
    }
  }
  const restart = scopedServiceScalar(composeText, 'tempo', 'restart');
  if (!restart.ok) return fail(`G12a: ${restart.detail}`);
  if (restart.value !== 'unless-stopped') {
    return fail(
      `G12a: tempo declares \`restart: ${restart.value}\`, expected \`unless-stopped\` — the ` +
        'softer version of hiding the park: a service that is not restarting does not look ' +
        'broken in `docker compose ps`',
    );
  }

  return pass(
    `G12a: tempo's park is pinned — command exactly [${found.join(', ')}] in order, image tag ` +
      `${TEMPO_IMAGE_TAG}, no profiles/extends, restart unless-stopped`,
  );
}

// ---------------------------------------------------------------------------
// G12b — alert group intervals, over the WHOLE provisioned alerting directory
// ---------------------------------------------------------------------------

/**
 * Grafana loads EVERY document under provisioning/alerting/, and compose mounts
 * the whole tree: a sibling file with a bad interval reproduces
 * `Failed to provision alerting ... divided exactly by scheduler interval: 10`
 * and exits the container, while a rules.yml-only detector stays green.
 * The expected file set is exact (the G9j anti-smuggling shape) so a new
 * document is a RED, not a silent widening of what this gate covers.
 */
export const ALERTING_DOC_SET = ['contact-points.yml', 'notification-policies.yml', 'rules.yml'];

/**
 * The 10s scheduler tick is a property of the IMAGE (three GF_UNIFIED_ALERTING_*
 * env overrides were tried against 13.1.3 and none moved it), so a version bump
 * must force re-verification of every number below.
 */
export const GRAFANA_IMAGE_TAG = 'grafana/grafana:13.1.3';
const GRAFANA_SCHEDULER_TICK_S = 10;

/** `20s`/`10m`/`1h30m` -> seconds. null for unit-less or unparseable input. */
function parseDurationSeconds(raw) {
  const text = String(raw).trim();
  if (text.length === 0) return null;
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  let total = 0;
  let digits = '';
  let sawUnit = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c >= '0' && c <= '9') {
      digits += c;
      continue;
    }
    if (!Object.hasOwn(units, c)) return null;
    if (digits.length === 0) return null;
    const n = toInt(digits);
    if (n === null) return null;
    total += n * units[c];
    digits = '';
    sawUnit = true;
  }
  if (digits.length > 0) return null;
  if (!sawUnit) return null;
  return total;
}

export function checkAlertGroupIntervals(docs, grafanaImage) {
  if (!Array.isArray(docs) || docs.length === 0) {
    return fail(
      'G12b: ZERO alerting documents were scanned. Grafana provisions the whole directory; an ' +
        'empty read is not an empty directory, and a scan of nothing passes everything.',
    );
  }
  const names = docs.map((d) => d.name).sort();
  const expected = [...ALERTING_DOC_SET].sort();
  if (names.join(',') !== expected.join(',')) {
    return fail(
      `G12b: the provisioned alerting file set is [${names.join(', ')}], expected ` +
        `[${expected.join(', ')}]. Grafana loads every document in this directory, so a new one ` +
        'is a reviewed change (add it here in the same commit), never a silent widening.',
    );
  }
  if (typeof grafanaImage !== 'string' || grafanaImage.trim().length === 0) {
    return fail(
      'G12b: no grafana image string was resolved from docker-compose.yml — the 10s scheduler ' +
        'tick every number below is derived from is a property of that image',
    );
  }
  if (!imageCarriesTag(grafanaImage, GRAFANA_IMAGE_TAG)) {
    return fail(
      `G12b: grafana runs \`${grafanaImage}\`, whose tag is not the pinned ` +
        `\`${GRAFANA_IMAGE_TAG}\`. The ${GRAFANA_SCHEDULER_TICK_S}s scheduler tick is ` +
        'image-dependent and is not env-overridable: re-verify it against the new version and ' +
        'move this pin in the same change.',
    );
  }

  let totalGroups = 0;
  let totalRules = 0;
  for (const doc of docs) {
    const lines = stripHashComments(doc.text).split('\n');
    const roots = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('groups:')) roots.push(i);
    }
    if (roots.length > 1) {
      return fail(`G12b: ${doc.name} declares ${roots.length} column-0 \`groups:\` keys`);
    }
    if (roots.length === 0) continue;
    if (lines[roots[0]].slice('groups:'.length).trim().length > 0) {
      return fail(`G12b: ${doc.name}'s \`groups:\` uses inline/flow style — fail loud`);
    }
    const groups = listItems(subBlock(lines, roots[0]));
    if (groups.length === 0) {
      return fail(
        `G12b: ${doc.name} declares a \`groups:\` key with ZERO groups — an empty provisioning ` +
          'document is not a valid one, and it would make every clause below vacuous',
      );
    }

    for (const group of groups) {
      totalGroups++;
      const childIndent = indentOf(group[0]);
      const nameIdx = keyIndices(group, 'name', childIndent);
      const label = nameIdx.length === 1 ? scalarOf(group[nameIdx[0]], 'name') : '(unnamed group)';
      const where = `${doc.name} group \`${label}\``;

      const ivIdx = keyIndices(group, 'interval', childIndent);
      if (ivIdx.length !== 1) {
        return fail(
          `G12b: ${where} declares ${ivIdx.length} \`interval:\` keys; exactly 1 is required. ` +
            'Zero means Grafana silently applies its own default (which no reader of this file ' +
            'can see); two means YAML picks the last one and the first is a lie.',
        );
      }
      const rawInterval = scalarOf(group[ivIdx[0]], 'interval');
      const interval = parseDurationSeconds(rawInterval);
      if (interval === null) {
        return fail(
          `G12b: ${where} declares \`interval: ${rawInterval}\`, which does not parse as a ` +
            'duration (a unit-less number is NOT seconds here). Fail loud: coercing or skipping ' +
            'an unparseable value is how a config Grafana refuses reads as green.',
        );
      }
      if (interval === 0) {
        return fail(
          `G12b: ${where} declares \`interval: ${rawInterval}\` = 0s. Grafana requires a group ` +
            'interval to be NON-ZERO and divided exactly by its scheduler interval of ' +
            `${GRAFANA_SCHEDULER_TICK_S}s; 0 satisfies the divisibility test and fails the ` +
            'non-zero one, which is why both are checked. Provisioning refuses the file and the ' +
            'grafana container exits.',
        );
      }
      if (interval % GRAFANA_SCHEDULER_TICK_S !== 0) {
        return fail(
          `G12b: ${where} declares \`interval: ${rawInterval}\` = ${interval}s, which is not a ` +
            `multiple of Grafana's ${GRAFANA_SCHEDULER_TICK_S}s scheduler tick. This is ` +
            "GRAFANA's own rule, not a repo convention: provisioning fails with `interval " +
            `(${rawInterval}) should be non-zero and divided exactly by scheduler interval: ` +
            `${GRAFANA_SCHEDULER_TICK_S}` +
            '` and the container exits. The smallest legal value at or above the current one is ' +
            `${(Math.floor(interval / GRAFANA_SCHEDULER_TICK_S) + 1) * GRAFANA_SCHEDULER_TICK_S}s.`,
        );
      }

      const rulesIdx = keyIndices(group, 'rules', childIndent);
      if (rulesIdx.length !== 1) {
        return fail(`G12b: ${where} declares ${rulesIdx.length} \`rules:\` keys, need 1`);
      }
      const rules = listItems(subBlock(group, rulesIdx[0]));
      if (rules.length === 0) {
        return fail(
          `G12b: ${where} declares ZERO rules — a group with no rules means nothing was ` +
            'scanned, and a scan of nothing passes everything',
        );
      }
      for (const rule of rules) {
        totalRules++;
        const ruleIndent = indentOf(rule[0]);
        const titleIdx = keyIndices(rule, 'title', ruleIndent);
        const title = titleIdx.length === 1 ? scalarOf(rule[titleIdx[0]], 'title') : '(untitled)';
        const forIdx = keyIndices(rule, 'for', ruleIndent);
        if (forIdx.length > 1) {
          return fail(`G12b: ${where} rule \`${title}\` declares ${forIdx.length} \`for:\` keys`);
        }
        if (forIdx.length === 0) continue;
        const rawFor = scalarOf(rule[forIdx[0]], 'for');
        const pending = parseDurationSeconds(rawFor);
        if (pending === null) {
          return fail(
            `G12b: ${where} rule \`${title}\` declares \`for: ${rawFor}\`, which does not parse ` +
              'as a duration (a unit-less number is not seconds). Fail loud, never coerce.',
          );
        }
        if (pending % interval !== 0) {
          const effective = Math.ceil(pending / interval) * interval;
          return fail(
            `G12b: ${where} rule \`${title}\` declares \`for: ${rawFor}\` = ${pending}s, which ` +
              `is not an exact multiple of its own group interval (${interval}s). Grafana ` +
              'transitions state only on an evaluation boundary, so this rule actually fires ' +
              `after ceil(${pending}/${interval})*${interval} = ${effective}s and the YAML lies ` +
              'about its own behaviour. NOTE: this is a REPO CONVENTION introduced by ADR-0190, ' +
              'NOT a Grafana restriction — Grafana accepts a non-multiple `for` and rounds it up. ' +
              `Write ${effective}s, or change the interval, and update the annotation prose in ` +
              'the same edit.',
          );
        }
      }
    }
  }

  if (totalGroups === 0) {
    return fail(
      'G12b: ZERO alert-rule groups were found across the provisioned alerting documents — ' +
        'nothing was scanned, which is never green',
    );
  }
  if (totalRules === 0) {
    return fail('G12b: ZERO alert rules were scanned across every group found');
  }
  return pass(
    `G12b: ${docs.length} provisioned alerting document(s), ${totalGroups} group(s), ` +
      `${totalRules} rule(s); every interval non-zero and ${GRAFANA_SCHEDULER_TICK_S}s-divisible, ` +
      'every `for:` an exact multiple of its own group interval',
  );
}

// ---------------------------------------------------------------------------
// G12c — the caddy binary's net-bind capability, stage- and last-writer-aware
// ---------------------------------------------------------------------------

const CADDY_BIN = '/usr/bin/caddy';
const CADDY_WRITERS = ['RUN', 'COPY', 'ADD'];
/** Assembled, never spelled: this file must not trip its own substring ban. */
const NET_BIND_CAP = `cap_net_${'bind'}_service`;

/** Dockerfile logical instructions: comments dropped, continuations joined. */
function dockerInstructions(dockerfileText) {
  const out = [];
  const lines = dockerfileText.split('\n');
  let pending = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (pending === null) {
      if (t.length === 0 || t.startsWith('#')) continue;
      pending = { line: i + 1, text: t };
    } else {
      if (t.startsWith('#')) continue;
      pending = { line: pending.line, text: `${pending.text} ${t}` };
    }
    if (pending.text.endsWith('\\')) {
      pending = { line: pending.line, text: pending.text.slice(0, -1).trim() };
      continue;
    }
    out.push(pending);
    pending = null;
  }
  if (pending !== null) return null;
  return out;
}

function verbOf(instruction) {
  const at = instruction.text.indexOf(' ');
  return (at === -1 ? instruction.text : instruction.text.slice(0, at)).toUpperCase();
}

export function checkCaddySetcapBeforeUser(dockerfileText) {
  if (dockerfileText.includes(NET_BIND_CAP)) {
    return fail(
      `G12c: the substring \`${NET_BIND_CAP}\` appears in the Dockerfile. Re-adding the ` +
        'capability re-creates the exact boot failure this gate exists to end: under ' +
        '`--cap-drop ALL` a file capability the process cannot hold makes the kernel refuse the ' +
        'exec outright (`operation not permitted`, exit 255) — a crash-loop, not a degraded mode. ' +
        'The ban covers comments too; name it in prose as "the net-bind file capability".',
    );
  }
  const instructions = dockerInstructions(dockerfileText);
  if (instructions === null) {
    return fail('G12c: the last Dockerfile instruction ends in a line continuation — fail loud');
  }
  if (instructions.length === 0) {
    return fail('G12c: the Dockerfile declares zero instructions — nothing was scanned');
  }
  for (const ins of instructions) {
    if (verbOf(ins) === 'ONBUILD') {
      return fail(
        `G12c: an \`ONBUILD\` instruction at line ${ins.line} — it runs in a CHILD build this ` +
          'gate cannot see, so the final image it produces is not the image analysed here',
      );
    }
  }

  const fromAt = [];
  for (let i = 0; i < instructions.length; i++) {
    if (verbOf(instructions[i]) === 'FROM') fromAt.push(i);
  }
  if (fromAt.length === 0) {
    return fail('G12c: no `FROM` instruction — the stage structure cannot be read, fail loud');
  }
  for (let i = 0; i < fromAt[0]; i++) {
    if (verbOf(instructions[i]) !== 'ARG') {
      return fail(
        `G12c: instruction \`${instructions[i].text.slice(0, 40)}\` (line ${instructions[i].line}) ` +
          'sits before the first `FROM`, so the stage structure is ambiguous — fail loud rather ' +
          'than guess which stage ships',
      );
    }
  }
  const finalFrom = fromAt[fromAt.length - 1];
  const finalStage = instructions.slice(finalFrom + 1);
  if (finalStage.length === 0) {
    return fail('G12c: the final stage declares no instructions at all');
  }

  const isSetcap = (ins) =>
    verbOf(ins) === 'RUN' && ins.text.includes('setcap -r') && ins.text.includes(CADDY_BIN);
  const setcaps = finalStage.filter(isSetcap);
  if (setcaps.length === 0) {
    const earlier = instructions.slice(0, finalFrom).some(isSetcap);
    return fail(
      `G12c: no \`RUN\` instruction in the FINAL stage runs \`setcap -r ${CADDY_BIN}\`` +
        (earlier
          ? ' — one runs in an EARLIER stage, whose filesystem the final image discards. A ' +
            'capability stripped in a builder stage is not stripped in the image that ships ' +
            '(built and measured: the shipped binary still carries the capability and still ' +
            'refuses to exec under --cap-drop ALL).'
          : '. Stock caddy ships that capability on the binary, so a non-root, cap-dropped ' +
            'container cannot exec it at all (exit 255).') +
        ' A `setcap` inside a `#` comment is not an instruction.',
    );
  }
  const writers = finalStage.filter(
    (ins) => CADDY_WRITERS.includes(verbOf(ins)) && ins.text.includes(CADDY_BIN),
  );
  const lastWriter = writers[writers.length - 1];
  if (!isSetcap(lastWriter)) {
    return fail(
      `G12c: \`${verbOf(lastWriter)}\` at line ${lastWriter.line} writes ${CADDY_BIN} AFTER the ` +
        'setcap, so the stripped binary is overwritten by one that still carries the capability. ' +
        'buildkit PRESERVES file capabilities across `COPY --from=`, which is exactly how the ' +
        'capability arrives in this image in the first place — index order against `USER` is not ' +
        'enough; the setcap must be the LAST writer of that path in the final stage.',
    );
  }
  const users = finalStage.filter((ins) => verbOf(ins) === 'USER');
  if (users.length !== 1) {
    return fail(
      `G12c: the final stage declares ${users.length} \`USER\` instruction(s); exactly 1 is ` +
        'required. Zero means the container runs as root and the whole posture is theatre; two ' +
        'means a trailing `USER root` can undo everything the first one bought.',
    );
  }
  if (users[0].line < lastWriter.line) {
    return fail(
      `G12c: \`USER\` (line ${users[0].line}) comes BEFORE the setcap (line ${lastWriter.line}). ` +
        'A non-root user cannot setcap, so this Dockerfile does not build — and if it did, the ' +
        'capability would still be on the binary at runtime.',
    );
  }
  return pass(
    `G12c: the final stage strips the caddy net-bind capability at line ${lastWriter.line}, as ` +
      `the last writer of ${CADDY_BIN}, before its single \`USER\` at line ${users[0].line}`,
  );
}

// ---------------------------------------------------------------------------
// G12d — the alloy service block, as a KEY ALLOWLIST
// ---------------------------------------------------------------------------

/**
 * EXACT SET EQUALITY, BOTH DIRECTIONS — the G12a doctrine applied to keys. A
 * four-property checklist ("user, cap_drop, security_opt, no cap_add") is not a
 * control: `privileged: true` alone passes all four and hands the container the
 * full bounding set (measured: CapBnd 000001ffffffffff vs 0000000000000000) plus
 * 185 host /dev entries (vs 15). `group_add`, `pid`, `ipc`, a `/:/host` volume
 * and an extra security_opt item are each equally uncovered by a checklist.
 * Derived from the committed block plus the `user:` this slice adds.
 */
export const ALLOY_ALLOWED_KEYS = [
  'cap_drop',
  'command',
  'cpus',
  'image',
  'mem_limit',
  'network_mode',
  'restart',
  'security_opt',
  'user',
  'volumes',
];

const ALLOY_SECURITY_OPT = 'no-new-privileges:true';

export function checkAlloyRunsUnprivileged(composeText) {
  const block = composeServiceBlockScoped(composeText, 'alloy');
  if (!block.ok) return fail(`G12d: ${block.detail}`);
  const keys = blockTopKeys(block.lines, 4);
  if (!keys.ok) return fail(`G12d: the alloy block — ${keys.detail}`);
  if (keys.keys.length === 0) {
    return fail('G12d: the alloy service block declares zero keys — nothing was scanned');
  }

  const declared = keys.keys.map((k) => k.name);
  const unexpected = declared.filter((n) => !ALLOY_ALLOWED_KEYS.includes(n));
  if (unexpected.length > 0) {
    return fail(
      `G12d: the alloy service declares [${unexpected.join(', ')}], which is outside the ` +
        `allowlist [${ALLOY_ALLOWED_KEYS.join(', ')}]. This is an allowlist and not a checklist ` +
        'because every one of `privileged`, `group_add`, `pid`, `ipc`, `userns_mode`, `devices`, ' +
        '`extends`, `entrypoint` and a host-root `volumes` entry hands back what the non-root + ' +
        'cap_drop posture just took away while every property check stays green (measured). If ' +
        'a new key is genuinely needed, add it here in the same reviewed change.',
    );
  }
  const dupes = declared.filter((n, i) => declared.indexOf(n) !== i);
  if (dupes.length > 0) {
    return fail(`G12d: the alloy service declares duplicate key(s) [${dupes.join(', ')}]`);
  }

  const userIdx = keyIndices(block.lines, 'user', 4);
  if (userIdx.length !== 1) {
    return fail(
      `G12d: the alloy service declares ${userIdx.length} \`user:\` keys; exactly 1 is required. ` +
        'The image runs uid 0 by default and its own state dirs are mode 0770 owned by 473:473, ' +
        'so root WITHOUT CAP_DAC_OVERRIDE (which `cap_drop: ALL` removes) cannot create them: ' +
        '`mkdir: cannot create directory: Permission denied`, then a crash-loop. A `user:` on ' +
        'any OTHER service does not satisfy this — the check is block-scoped for that reason.',
    );
  }
  const user = scalarOf(block.lines[userIdx[0]], 'user');
  const parts = user.split(':');
  if (parts.length !== 2) {
    return fail(
      `G12d: alloy's \`user: ${user}\` is not <uid>:<gid>. Numeric on purpose: compose passes a ` +
        'NAME through to be resolved in-container against /etc/passwd, which an image rebuild can ' +
        'renumber silently.',
    );
  }
  const uid = toInt(parts[0]);
  const gid = toInt(parts[1]);
  if (uid === null || gid === null) {
    return fail(`G12d: alloy's \`user: ${user}\` is not numeric on both sides`);
  }
  if (uid === 0) {
    return fail(
      `G12d: alloy declares \`user: ${user}\` — uid 0 IS root, which is the state this gate ` +
        'exists to prevent; the quoted form only makes it look deliberate',
    );
  }

  if (keyIndices(block.lines, 'cap_add', 4).length > 0) {
    return fail(
      'G12d: the alloy service declares `cap_add:`. Granting a capability back (DAC_OVERRIDE was ' +
        'the tempting one here) is the rejected alternative to running as the uid that already ' +
        'owns the directories.',
    );
  }
  const dropIdx = keyIndices(block.lines, 'cap_drop', 4);
  if (dropIdx.length !== 1) {
    return fail(`G12d: the alloy service declares ${dropIdx.length} \`cap_drop:\` keys, need 1`);
  }
  const drops = scalarListUnder(block.lines, dropIdx[0]);
  if (!drops.ok) return fail(`G12d: alloy's \`cap_drop:\` — ${drops.detail}`);
  if (!drops.values.includes('ALL')) {
    return fail(
      `G12d: alloy's \`cap_drop:\` is [${drops.values.join(', ') || 'empty'}] and does not ` +
        'contain `ALL` — a partial drop leaves the default bounding set almost intact',
    );
  }

  const optIdx = keyIndices(block.lines, 'security_opt', 4);
  if (optIdx.length !== 1) {
    return fail(`G12d: the alloy service declares ${optIdx.length} \`security_opt:\` keys, need 1`);
  }
  const opts = scalarListUnder(block.lines, optIdx[0]);
  if (!opts.ok) return fail(`G12d: alloy's \`security_opt:\` — ${opts.detail}`);
  if (opts.values.length !== 1 || opts.values[0] !== ALLOY_SECURITY_OPT) {
    return fail(
      `G12d: alloy's \`security_opt:\` is [${opts.values.join(', ') || 'empty'}], expected ` +
        `exactly [${ALLOY_SECURITY_OPT}]. An EXTRA item is the hole: a seccomp or apparmor ` +
        '`unconfined` entry rides along beside the correct one and every "contains" check stays ' +
        'green.',
    );
  }

  return pass(
    `G12d: alloy runs as ${user} with cap_drop [${drops.values.join(', ')}], security_opt ` +
      `[${opts.values.join(', ')}], no cap_add, and only allowlisted keys ` +
      `[${declared.sort().join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// G12e — the S4 label-value bounds, PATH-SCOPED into s4_keep
// ---------------------------------------------------------------------------

const S4_KEEP_HEADER = 'otelcol.processor.transform "s4_keep"';

/** Pinned character-for-character. These are DATA, not compiled patterns. */
export const S4_STATEMENT_KEEP_KEYS =
  'keep_matching_keys(attributes, "^(zone_id|build_sha|device_class)$")';
export const S4_STATEMENT_ZONE_ID =
  'delete_key(attributes, "zone_id") where not IsMatch(attributes["zone_id"], "^[0-9]{1,4}$")';
export const S4_STATEMENT_BUILD_SHA =
  'delete_key(attributes, "build_sha") where not IsMatch(attributes["build_sha"], ' +
  '"^[0-9a-f]{7,40}$")';
export const S4_STATEMENT_DEVICE_CLASS =
  'delete_key(attributes, "device_class") where not IsMatch(attributes["device_class"], ' +
  '"^(desktop|mobile|tablet)$")';

const BUILD_SHA_GRAMMAR_NOTE =
  'The `{7,40}` bound is pinned character-for-character: a WIDENING re-opens the label-value ' +
  'space, and a NARROWING to 40 hex would silently drop build_sha from 100% of production ' +
  'datapoints, because the client emits a 7-character short SHA (`git rev-parse --short HEAD`, ' +
  'client/src/observability/attributes.ts, mirrored in client/src/observability/names.ts). Do ' +
  "NOT apply the original slice brief's fixed-40-hex instruction — ADR-0190 D5 rejects it on " +
  'that evidence.';

/** Balanced `open`/`close` block starting at the first `open` at/after `from`. */
function delimitedBlock(text, from, open, close) {
  const start = text.indexOf(open, from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { start, end: i, body: text.slice(start + 1, i) };
    }
  }
  return null;
}

/** Backtick-quoted list elements. null when ANY other token appears. */
function backtickListItems(body) {
  const items = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch !== '`') return null;
    const end = body.indexOf('`', i + 1);
    if (end === -1) return null;
    items.push(body.slice(i + 1, end));
    i = end + 1;
  }
  return items;
}

function countOccurrences(text, needle) {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return n;
    n++;
    from = at + needle.length;
  }
}

export function checkBuildShaBounded(alloyText) {
  // Whole-line `//` comments are blanked FIRST: a statement demoted to a
  // comment is not a statement, and a file-wide substring check cannot tell the
  // difference.
  const text = scrubCommentLines(alloyText);
  const headers = countOccurrences(text, S4_KEEP_HEADER);
  if (headers !== 1) {
    return fail(
      `G12e: found ${headers} \`${S4_KEEP_HEADER}\` component declarations; exactly 1 is ` +
        'required. This gate is PATH-SCOPED on purpose: the same statements moved verbatim into ' +
        'a second, unwired transform component keep every file-wide check green while the live ' +
        'pipeline loses the bound entirely.',
    );
  }
  const comp = delimitedBlock(text, text.indexOf(S4_KEEP_HEADER), '{', '}');
  if (comp === null) return fail(`G12e: \`${S4_KEEP_HEADER}\`'s block is unbalanced or absent`);
  const msAt = comp.body.indexOf('metric_statements');
  if (msAt === -1) {
    return fail(`G12e: \`${S4_KEEP_HEADER}\` declares no \`metric_statements\` block`);
  }
  if (countOccurrences(comp.body, 'metric_statements') !== 1) {
    return fail(`G12e: \`${S4_KEEP_HEADER}\` declares more than one \`metric_statements\` block`);
  }
  const ms = delimitedBlock(comp.body, msAt, '{', '}');
  if (ms === null) return fail("G12e: s4_keep's `metric_statements` block is unbalanced");
  const stAt = ms.body.indexOf('statements');
  if (stAt === -1) {
    return fail("G12e: s4_keep's `metric_statements` declares no `statements` list");
  }
  const eq = ms.body.indexOf('=', stAt);
  if (eq === -1) return fail("G12e: s4_keep's `statements` is not an assignment");
  const list = delimitedBlock(ms.body, eq, '[', ']');
  if (list === null) return fail("G12e: s4_keep's `statements = [` list is unbalanced or absent");
  if (ms.body.slice(eq + 1, list.start).trim().length > 0) {
    return fail('G12e: unreadable text between `statements =` and its `[` — fail loud');
  }
  const items = backtickListItems(list.body);
  if (items === null) {
    return fail(
      "G12e: s4_keep's `statements` list contains a token this scanner cannot read — fail loud " +
        'rather than compare against a partial parse',
    );
  }
  if (items.length === 0) {
    return fail("G12e: s4_keep's `statements` list is EMPTY — the S4 label bounds are gone");
  }

  if (items[0] !== S4_STATEMENT_KEEP_KEYS) {
    return fail(
      `G12e: the FIRST element of s4_keep's statements list is \`${items[0]}\`, expected ` +
        `\`${S4_STATEMENT_KEEP_KEYS}\`. The key allowlist must run FIRST: OTTL statements ` +
        'execute in order, so an attacker-chosen attribute name that is dropped later has ' +
        'already been read by every statement before it, and a key allowlist that never runs at ' +
        'all bounds nothing.',
    );
  }
  const required = [
    { name: 'zone_id', text: S4_STATEMENT_ZONE_ID },
    { name: 'build_sha', text: S4_STATEMENT_BUILD_SHA },
    { name: 'device_class', text: S4_STATEMENT_DEVICE_CLASS },
  ];
  for (const req of required) {
    if (items.includes(req.text)) continue;
    const prefix = `delete_key(attributes, "${req.name}")`;
    const drifted = items.find((s) => s.startsWith(prefix));
    const note = req.name === 'build_sha' ? ` ${BUILD_SHA_GRAMMAR_NOTE}` : '';
    return fail(
      `G12e: s4_keep's statements list does not carry the pinned \`${req.name}\` value bound ` +
        `character-for-character.${drifted === undefined ? ' It is ABSENT from THIS list (a copy in another component does not bound this pipeline).' : ` Found: \`${drifted}\`.`}` +
        ` Expected: \`${req.text}\`.${note}`,
    );
  }

  return pass(
    `G12e: s4_keep's own statements list carries the key allowlist as element [0] plus all ` +
      `${required.length} pinned value bounds, character-for-character (${items.length} ` +
      'statements total)',
  );
}

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

// ---------------------------------------------------------------------------
// 13r-a fixtures (T-h..T-l). Inline strings only — no fixture file is written.
// Every builder produces a COMPLIANT shape by default so each tooth can prove
// its detector ACCEPTS the good shape before proving it rejects the bad one.
// ---------------------------------------------------------------------------

function tempoServiceLines(o = {}) {
  const lines = ['  tempo:'];
  lines.push(`    image: ${o.image ?? 'grafana/tempo:2.10.7'}`);
  lines.push('    network_mode: host');
  lines.push(`    restart: ${o.restart ?? 'unless-stopped'}`);
  for (const extra of o.extraLines ?? []) lines.push(extra);
  if (o.omitCommand !== true) {
    lines.push('    command:');
    for (const item of o.command ?? [TEMPO_FLAG_CONFIG, TEMPO_FLAG_LISTEN]) {
      lines.push(`      - ${item}`);
    }
  }
  return lines;
}

function tempoCompose(o = {}) {
  const out = [];
  // The AM17 decoy: a top-level `x-decoy:` key holding a fully compliant
  // `tempo:` at the same two-space indent a whole-file search looks for. It sits
  // BEFORE `services:` so a `findIndex` would return it first.
  if (o.decoy === true) {
    out.push('x-decoy:');
    out.push(...tempoServiceLines());
  }
  out.push('services:');
  out.push('  prometheus:');
  out.push('    image: prom/prometheus:v3.13.2');
  out.push('    restart: unless-stopped');
  if (o.omitService !== true) out.push(...tempoServiceLines(o));
  return out.join('\n');
}

function alertRulesDoc(o = {}) {
  const lines = ['apiVersion: 1', '', 'groups:'];
  if (o.emptyGroups === true) return lines.join('\n');
  lines.push('  - orgId: 1');
  lines.push(`    name: ${o.groupName ?? 'meta-monitoring'}`);
  lines.push('    folder: Monster Realm');
  if (o.omitInterval !== true) lines.push(`    interval: ${o.interval ?? '20s'}`);
  if (o.secondInterval !== undefined) lines.push(`    interval: ${o.secondInterval}`);
  if (o.emptyRules === true) {
    lines.push('    rules: []');
    return lines.join('\n');
  }
  lines.push('    rules:');
  lines.push('      - uid: mr-alloy-down');
  lines.push('        title: AlloyDown');
  lines.push('        condition: C');
  if (o.omitFor !== true) lines.push(`        for: ${o.forValue ?? '60s'}`);
  lines.push('        labels:');
  lines.push('          severity: critical');
  return lines.join('\n');
}

const CONTACT_POINTS_DOC = ['apiVersion: 1', '', 'contactPoints:', '  - orgId: 1'].join('\n');
const NOTIFICATION_POLICIES_DOC = ['apiVersion: 1', '', 'policies:', '  - orgId: 1'].join('\n');

/** The three-document set Grafana actually provisions, rules.yml configurable. */
function alertingDocsFixture(o = {}) {
  return [
    { name: 'contact-points.yml', text: o.contactPoints ?? CONTACT_POINTS_DOC },
    {
      name: 'notification-policies.yml',
      text: o.notificationPolicies ?? NOTIFICATION_POLICIES_DOC,
    },
    { name: 'rules.yml', text: o.rules ?? alertRulesDoc() },
  ];
}

function dockerfileFixture(o = {}) {
  const out = ['FROM caddy:2.11.4-builder-alpine AS builder', 'RUN xcaddy build v2.11.4'];
  if (o.builderSetcap === true) out.push('RUN setcap -r /usr/bin/caddy');
  out.push('');
  out.push('FROM caddy:2.11.4-alpine');
  out.push('COPY --from=builder /usr/bin/caddy /usr/bin/caddy');
  out.push('RUN mkdir -p /data /config && chown -R 10001:10001 /data /config');
  out.push(...(o.tail ?? ['RUN setcap -r /usr/bin/caddy', 'USER 10001:10001']));
  out.push('ENTRYPOINT ["caddy"]');
  return out.join('\n');
}

function alloyCompose(o = {}) {
  const out = ['services:'];
  out.push('  prometheus:');
  out.push('    image: prom/prometheus:v3.13.2');
  out.push('    restart: unless-stopped');
  if (o.prometheusUser !== undefined) out.push(`    user: "${o.prometheusUser}"`);
  out.push('  alloy:');
  out.push('    image: grafana/alloy:v1.18.1');
  out.push('    network_mode: host');
  out.push('    restart: unless-stopped');
  if (o.omitUser !== true) out.push(`    user: "${o.user ?? '473:473'}"`);
  if (o.omitSecurityOpt !== true) {
    out.push('    security_opt:');
    for (const item of o.securityOpt ?? ['no-new-privileges:true']) out.push(`      - ${item}`);
  }
  if (o.omitCapDrop !== true) {
    out.push('    cap_drop:');
    out.push('      - ALL');
  }
  for (const extra of o.extraLines ?? []) out.push(extra);
  out.push('    volumes:');
  out.push('      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro');
  out.push('    command:');
  out.push('      - run');
  out.push('    mem_limit: 1g');
  out.push('    cpus: 1.0');
  return out.join('\n');
}

// The two grammar mutations T-l exists to kill, spelled out rather than derived
// from the pinned constant: a mutation of that constant must not silently
// mutate the fixture that is supposed to catch it.
const BUILD_SHA_WIDENED =
  'delete_key(attributes, "build_sha") where not IsMatch(attributes["build_sha"], ' +
  '"^[0-9a-f]{1,40}$")';
const BUILD_SHA_NARROWED =
  'delete_key(attributes, "build_sha") where not IsMatch(attributes["build_sha"], ' +
  '"^[0-9a-f]{40}$")';

function alloyS4Fixture(o = {}) {
  const statements = o.statements ?? [
    S4_STATEMENT_KEEP_KEYS,
    S4_STATEMENT_ZONE_ID,
    S4_STATEMENT_BUILD_SHA,
    S4_STATEMENT_DEVICE_CLASS,
  ];
  const out = [];
  out.push('otelcol.receiver.otlp "s4" {');
  out.push('\toutput {');
  out.push('\t\tmetrics = [otelcol.processor.transform.s4_keep.input]');
  out.push('\t}');
  out.push('}');
  out.push('');
  out.push('otelcol.processor.transform "s4_keep" {');
  out.push('\tmetric_statements {');
  out.push('\t\tcontext = "datapoint"');
  out.push('\t\t// the allowlist bounds the label KEY space; the delete_key set bounds VALUES');
  out.push('\t\tstatements = [');
  for (const s of statements) out.push(`\t\t\t\`${s}\`,`);
  for (const s of o.commentedStatements ?? []) out.push(`\t\t\t// \`${s}\`,`);
  out.push('\t\t]');
  out.push('\t}');
  out.push('');
  out.push('\toutput {');
  out.push('\t\tmetrics = [otelcol.exporter.prometheus.s4.input]');
  out.push('\t}');
  out.push('}');
  // AM20: a second transform component holding the SAME statements verbatim,
  // whose output forwards nowhere. Every file-wide substring check stays green.
  if (o.parkedComponent === true) {
    out.push('');
    out.push('otelcol.processor.transform "parked_bounds" {');
    out.push('\tmetric_statements {');
    out.push('\t\tcontext = "datapoint"');
    out.push('\t\tstatements = [');
    out.push(`\t\t\t\`${S4_STATEMENT_KEEP_KEYS}\`,`);
    out.push(`\t\t\t\`${S4_STATEMENT_BUILD_SHA}\`,`);
    out.push('\t\t]');
    out.push('\t}');
    out.push('');
    out.push('\toutput {');
    out.push('\t\tmetrics = []');
    out.push('\t}');
    out.push('}');
  }
  return out.join('\n');
}

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
  {
    id: 'T-h',
    // Kills: a denylist of known-bad tempo flags (cannot catch flag #3); a
    // one-directional subset check; an order-blind set comparison; a detector
    // that passes when the service or its command is absent; a digest/tag-blind
    // park; a park that hides itself with `profiles:`/`restart: "no"`; and — the
    // AM17 tooth — a whole-file service lookup that validates an `x-decoy:`
    // block instead of the real service.
    run() {
      const good = checkTempoCommandParked(tempoCompose());
      if (!good.ok) return `the committed park shape was rejected: ${good.detail}`;

      const removed = checkTempoCommandParked(tempoCompose({ command: [TEMPO_FLAG_CONFIG] }));
      if (removed.ok) return 'the parked flag being REMOVED was accepted';
      if (!removed.detail.includes('SUBSET')) {
        return `the removal was not reported as a SUBSET: ${removed.detail}`;
      }
      for (const needle of ['stack-config-checks.mjs', 'tempo-config.yml']) {
        if (!removed.detail.includes(needle)) {
          return `the SUBSET failure does not name \`${needle}\` in its follow-up prescription: ${removed.detail}`;
        }
      }

      const extra = checkTempoCommandParked(
        tempoCompose({ command: [TEMPO_FLAG_CONFIG, TEMPO_FLAG_LISTEN, '-target=all'] }),
      );
      if (extra.ok) return 'a THIRD, unreviewed tempo flag was accepted';
      if (!extra.detail.includes('SUPERSET')) {
        return `the extra flag was not reported as a SUPERSET: ${extra.detail}`;
      }

      const reordered = checkTempoCommandParked(
        tempoCompose({ command: [TEMPO_FLAG_LISTEN, TEMPO_FLAG_CONFIG] }),
      );
      if (reordered.ok) return 'the right SET of flags in the wrong ORDER was accepted';

      if (checkTempoCommandParked(tempoCompose({ omitCommand: true })).ok) {
        return 'a tempo service with NO `command:` key was accepted';
      }
      if (checkTempoCommandParked(tempoCompose({ omitService: true })).ok) {
        return 'a compose with no `tempo:` service at all was accepted';
      }
      if (checkTempoCommandParked(tempoCompose({ image: 'grafana/tempo:2.11.0' })).ok) {
        return 'a tempo VERSION bump was accepted without re-verifying the flag set';
      }
      if (
        checkTempoCommandParked(tempoCompose({ extraLines: ['    profiles:', '      - parked'] }))
          .ok
      ) {
        return '`profiles:` on tempo was accepted — it removes the service from `docker compose config --services` and the park reads as closed';
      }
      if (
        checkTempoCommandParked(
          tempoCompose({ extraLines: ['    extends:', '      file: base.yml'] }),
        ).ok
      ) {
        return '`extends:` on tempo was accepted — it smuggles arbitrary keys in from an unscanned file';
      }
      if (checkTempoCommandParked(tempoCompose({ restart: '"no"' })).ok) {
        return '`restart: "no"` was accepted — a parked failure that does not restart does not look broken';
      }

      // AM17: the decoy is COMPLIANT and sits where a whole-file `findIndex`
      // would find it first; the real `services:` tempo has lost the parked
      // flag. A detector that is not scoped to `services:` reports green here.
      const decoyText = tempoCompose({ decoy: true, command: [TEMPO_FLAG_CONFIG] });
      if (decoyText.indexOf('x-decoy:') > decoyText.indexOf('services:')) {
        return 'FIXTURE: the decoy must sit BEFORE `services:` to shadow a whole-file search';
      }
      const decoy = checkTempoCommandParked(decoyText);
      if (decoy.ok) {
        return 'a top-level `x-decoy:` block holding a compliant `tempo:` shadowed the real, non-compliant service';
      }
      if (!decoy.detail.includes('SUBSET')) {
        return `the decoy fixture failed for the wrong reason: ${decoy.detail}`;
      }
      return null;
    },
  },
  {
    id: 'T-i',
    // Kills: a rules.yml-only scan (Grafana provisions the whole directory); a
    // `% 10 === 0` divisibility check with no non-zero clause; a `for:` clause
    // that coerces or skips an unparseable value; a group-count-blind scan; and
    // a file set that silently widens.
    run() {
      const tag = GRAFANA_IMAGE_TAG;
      const good = checkAlertGroupIntervals(alertingDocsFixture(), tag);
      if (!good.ok) return `the compliant 20s/60s fixture was rejected: ${good.detail}`;

      // `for: 0s` is LEGAL and meaningful — Grafana fires on the first
      // evaluation. A "for must be non-zero" clause would be wrong.
      const zeroFor = checkAlertGroupIntervals(
        alertingDocsFixture({ rules: alertRulesDoc({ forValue: '0s' }) }),
        tag,
      );
      if (!zeroFor.ok) return `\`for: 0s\` was rejected, but it is legal: ${zeroFor.detail}`;
      const noFor = checkAlertGroupIntervals(
        alertingDocsFixture({ rules: alertRulesDoc({ omitFor: true }) }),
        tag,
      );
      if (!noFor.ok) return `a rule with no \`for:\` at all was rejected: ${noFor.detail}`;

      const bad15 = checkAlertGroupIntervals(
        alertingDocsFixture({ rules: alertRulesDoc({ interval: '15s' }) }),
        tag,
      );
      if (bad15.ok)
        return 'the committed `interval: 15s` (which crashes grafana at boot) was accepted';
      if (!bad15.detail.includes('scheduler')) {
        return `the 15s failure does not name the scheduler tick: ${bad15.detail}`;
      }

      const zero = checkAlertGroupIntervals(
        alertingDocsFixture({ rules: alertRulesDoc({ interval: '0s' }) }),
        tag,
      );
      if (zero.ok) return '`interval: 0s` was accepted — 0 passes a bare `% 10 === 0` test';

      const drift = checkAlertGroupIntervals(
        alertingDocsFixture({ rules: alertRulesDoc({ interval: '20s', forValue: '45s' }) }),
        tag,
      );
      if (drift.ok)
        return '`for: 45s` under a 20s interval was accepted — the YAML lies about its own behaviour';
      for (const needle of ['REPO CONVENTION', 'ADR-0190', '60s']) {
        if (!drift.detail.includes(needle)) {
          return `the \`for\`-drift failure is missing \`${needle}\` (it must not read as a Grafana rule, and must print the effective value): ${drift.detail}`;
        }
      }

      if (
        checkAlertGroupIntervals(
          alertingDocsFixture({ rules: alertRulesDoc({ interval: 'twenty' }) }),
          tag,
        ).ok
      ) {
        return 'an unparseable `interval: twenty` was accepted — it must fail LOUD, never be skipped';
      }
      if (
        checkAlertGroupIntervals(
          alertingDocsFixture({ rules: alertRulesDoc({ forValue: '45' }) }),
          tag,
        ).ok
      ) {
        return 'a unit-less `for: 45` was accepted — it must fail loud, never be coerced to seconds';
      }
      if (
        checkAlertGroupIntervals(
          alertingDocsFixture({ rules: alertRulesDoc({ secondInterval: '15s' }) }),
          tag,
        ).ok
      ) {
        return 'a group with TWO `interval:` keys was accepted — YAML takes the last, so the first is a lie';
      }
      if (
        checkAlertGroupIntervals(
          alertingDocsFixture({ rules: alertRulesDoc({ omitInterval: true }) }),
          tag,
        ).ok
      ) {
        return 'a group with NO `interval:` was accepted — grafana would silently apply its own default';
      }
      if (
        checkAlertGroupIntervals(
          alertingDocsFixture({ rules: alertRulesDoc({ emptyGroups: true }) }),
          tag,
        ).ok
      ) {
        return 'a `groups:` key with zero groups was accepted — nothing was scanned';
      }
      if (
        checkAlertGroupIntervals(
          alertingDocsFixture({ rules: alertRulesDoc({ emptyRules: true }) }),
          tag,
        ).ok
      ) {
        return 'a group with `rules: []` was accepted — nothing was scanned';
      }

      // AM19: the SIBLING document. rules.yml itself is compliant, so a
      // rules.yml-only detector reports green while grafana refuses to boot.
      const siblingDocs = alertingDocsFixture({
        notificationPolicies: alertRulesDoc({ groupName: 'smuggled', interval: '15s' }),
      });
      const primary = siblingDocs.find((d) => d.name === 'rules.yml');
      if (!checkAlertGroupIntervals(alertingDocsFixture({ rules: primary.text }), tag).ok) {
        return 'FIXTURE: the sibling case requires rules.yml itself to be compliant';
      }
      const sibling = checkAlertGroupIntervals(siblingDocs, tag);
      if (sibling.ok) return 'a BAD group in a sibling provisioned document was not scanned at all';
      if (!sibling.detail.includes('notification-policies.yml')) {
        return `the sibling failure does not name the offending document: ${sibling.detail}`;
      }

      const extraFile = checkAlertGroupIntervals(
        [...alertingDocsFixture(), { name: 'rules-extra.yml', text: alertRulesDoc() }],
        tag,
      );
      if (extraFile.ok)
        return 'an unexpected extra document in the alerting directory was accepted';
      if (!extraFile.detail.includes('rules-extra.yml')) {
        return `the file-set failure does not name the new file: ${extraFile.detail}`;
      }

      if (checkAlertGroupIntervals([], tag).ok) return 'ZERO alerting documents was accepted';
      if (checkAlertGroupIntervals(alertingDocsFixture(), null).ok) {
        return 'a missing grafana image string was accepted — the 10s tick is image-dependent';
      }
      if (checkAlertGroupIntervals(alertingDocsFixture(), 'grafana/grafana:14.0.0').ok) {
        return 'a grafana MAJOR version bump was accepted without re-verifying the scheduler tick';
      }
      return null;
    },
  },
  {
    id: 'T-j',
    // Kills an index-aware `.includes('setcap -r')` check: BOTH bypasses below
    // keep the setcap textually before `USER` and still ship a binary that
    // cannot exec under `--cap-drop ALL` (measured: exit 255).
    run() {
      const good = checkCaddySetcapBeforeUser(dockerfileFixture());
      if (!good.ok) return `the fixed Dockerfile shape was rejected: ${good.detail}`;

      if (checkCaddySetcapBeforeUser(dockerfileFixture({ tail: ['USER 10001:10001'] })).ok) {
        return 'a Dockerfile with NO setcap was accepted (this is the committed state)';
      }
      if (
        checkCaddySetcapBeforeUser(
          dockerfileFixture({ tail: ['USER 10001:10001', 'RUN setcap -r /usr/bin/caddy'] }),
        ).ok
      ) {
        return 'a setcap placed AFTER `USER` was accepted — that Dockerfile does not even build';
      }
      if (
        checkCaddySetcapBeforeUser(
          dockerfileFixture({ tail: ['# RUN setcap -r /usr/bin/caddy', 'USER 10001:10001'] }),
        ).ok
      ) {
        return 'a setcap that exists only inside a `#` comment was accepted';
      }
      if (
        checkCaddySetcapBeforeUser(
          dockerfileFixture({
            tail: [
              'RUN setcap -r /usr/bin/caddy',
              `RUN setcap cap_net_${'bind'}_service=+ep /usr/bin/caddy`,
              'USER 10001:10001',
            ],
          }),
        ).ok
      ) {
        return 'the capability being RE-ADDED after the strip was accepted';
      }
      if (
        checkCaddySetcapBeforeUser(dockerfileFixture({ tail: ['RUN setcap -r /usr/bin/caddy'] })).ok
      ) {
        return 'a final stage with NO `USER` was accepted — the container runs as root';
      }
      if (
        checkCaddySetcapBeforeUser(
          dockerfileFixture({
            tail: ['RUN setcap -r /usr/bin/caddy', 'USER 10001:10001', 'USER root'],
          }),
        ).ok
      ) {
        return 'a trailing `USER root` was accepted — it undoes everything the first USER bought';
      }

      // AM18a: the setcap runs in a stage the final image DISCARDS.
      const builderOnly = dockerfileFixture({ builderSetcap: true, tail: ['USER 10001:10001'] });
      if (!builderOnly.includes('setcap -r /usr/bin/caddy')) {
        return 'FIXTURE: the builder-stage bypass must still spell the setcap verbatim';
      }
      const staged = checkCaddySetcapBeforeUser(builderOnly);
      if (staged.ok)
        return 'a setcap in an earlier `AS builder` stage was accepted — the final image discards that filesystem';
      if (!staged.detail.includes('EARLIER stage')) {
        return `the discarded-stage failure does not say which stage ran it: ${staged.detail}`;
      }

      // AM18b: buildkit PRESERVES file capabilities across `COPY --from=`, so a
      // later copy re-adds what the setcap removed — textual order is not enough.
      const lateCopy = checkCaddySetcapBeforeUser(
        dockerfileFixture({
          tail: [
            'RUN setcap -r /usr/bin/caddy',
            'COPY --from=builder /usr/bin/caddy /usr/bin/caddy',
            'USER 10001:10001',
          ],
        }),
      );
      if (lateCopy.ok) {
        return 'a `COPY --from=` of /usr/bin/caddy AFTER the setcap was accepted — the capability rides back in with the file';
      }
      if (!lateCopy.detail.includes('COPY --from=')) {
        return `the late-copy failure does not name the mechanism: ${lateCopy.detail}`;
      }

      if (
        checkCaddySetcapBeforeUser(
          dockerfileFixture({
            tail: ['RUN setcap -r /usr/bin/caddy', 'USER 10001:10001', 'ONBUILD RUN echo hi'],
          }),
        ).ok
      ) {
        return 'an `ONBUILD` instruction was accepted — its child build is invisible to this scan';
      }
      if (checkCaddySetcapBeforeUser('RUN setcap -r /usr/bin/caddy\nUSER 10001:10001\n').ok) {
        return 'a Dockerfile with no `FROM` at all was accepted — the stage structure is unreadable';
      }
      return null;
    },
  },
  {
    id: 'T-k',
    // Kills a four-property checklist. `privileged: true` alone passes "user +
    // cap_drop + security_opt + no cap_add" and restores the full bounding set
    // (measured: CapBnd 000001ffffffffff vs 0000000000000000, 185 host /dev
    // entries vs 15). Also kills a file-wide `includes('user:')`.
    run() {
      const good = checkAlloyRunsUnprivileged(alloyCompose());
      if (!good.ok) return `the fixed alloy block was rejected: ${good.detail}`;

      if (checkAlloyRunsUnprivileged(alloyCompose({ omitUser: true })).ok) {
        return 'an alloy block with no `user:` was accepted (this is the committed state)';
      }
      if (checkAlloyRunsUnprivileged(alloyCompose({ user: '0:0' })).ok) {
        return '`user: "0:0"` was accepted — uid 0 is root however it is spelled';
      }
      if (checkAlloyRunsUnprivileged(alloyCompose({ user: 'alloy' })).ok) {
        return 'a NAME-shaped `user:` was accepted — an image rebuild can renumber it silently';
      }
      if (
        checkAlloyRunsUnprivileged(
          alloyCompose({ extraLines: ['    cap_add:', '      - DAC_OVERRIDE'] }),
        ).ok
      ) {
        return '`cap_add: DAC_OVERRIDE` alongside a correct `user:` was accepted';
      }
      if (checkAlloyRunsUnprivileged(alloyCompose({ omitCapDrop: true })).ok) {
        return 'an alloy block with `cap_drop: - ALL` REMOVED was accepted';
      }
      if (checkAlloyRunsUnprivileged(alloyCompose({ omitSecurityOpt: true })).ok) {
        return 'an alloy block with `no-new-privileges:true` removed was accepted';
      }
      if (
        checkAlloyRunsUnprivileged(
          alloyCompose({ securityOpt: ['no-new-privileges:true', 'seccomp=unconfined'] }),
        ).ok
      ) {
        return 'an EXTRA security_opt item riding beside the correct one was accepted';
      }

      // Block scoping: the string `user:` is present in the file, on the WRONG
      // service. A file-wide substring check reports green (the T-e blind spot).
      const wrongBlock = alloyCompose({ omitUser: true, prometheusUser: '65534:65534' });
      if (!wrongBlock.includes('user: "65534:65534"')) {
        return 'FIXTURE: the scoping case must still spell a `user:` key somewhere in the file';
      }
      if (checkAlloyRunsUnprivileged(wrongBlock).ok) {
        return 'a `user:` on the PROMETHEUS block satisfied the alloy check';
      }

      // The key allowlist. Each of these passes a four-property checklist.
      const smuggled = [
        ['    privileged: true'],
        ['    group_add: ["0"]'],
        ['    pid: host'],
        ['    ipc: host'],
        ['    userns_mode: host'],
        ['    extends:', '      file: base.yml'],
        ['    entrypoint: /bin/sh'],
        ['    devices:', '      - /dev/mem:/dev/mem'],
      ];
      for (const extraLines of smuggled) {
        const key = extraLines[0].trim().split(':')[0];
        if (checkAlloyRunsUnprivileged(alloyCompose({ extraLines })).ok) {
          return `\`${key}\` was accepted on an otherwise-compliant alloy block — it hands back what cap_drop just took away`;
        }
      }
      return null;
    },
  },
  {
    id: 'T-l',
    // Kills a file-wide substring check for the pinned statements (AM20: the
    // same text in an unwired component bounds nothing), a grammar widening,
    // AND a 40-hex narrowing — the tooth that stops a future author applying the
    // original slice brief's instruction, which would drop build_sha from 100%
    // of production datapoints.
    run() {
      const good = checkBuildShaBounded(alloyS4Fixture());
      if (!good.ok) return `the committed s4_keep shape was rejected: ${good.detail}`;

      const widened = checkBuildShaBounded(
        alloyS4Fixture({
          statements: [
            S4_STATEMENT_KEEP_KEYS,
            S4_STATEMENT_ZONE_ID,
            BUILD_SHA_WIDENED,
            S4_STATEMENT_DEVICE_CLASS,
          ],
        }),
      );
      if (widened.ok) return 'the build_sha grammar WIDENED to {1,40} was accepted';

      const narrowed = checkBuildShaBounded(
        alloyS4Fixture({
          statements: [
            S4_STATEMENT_KEEP_KEYS,
            S4_STATEMENT_ZONE_ID,
            BUILD_SHA_NARROWED,
            S4_STATEMENT_DEVICE_CLASS,
          ],
        }),
      );
      if (narrowed.ok) {
        return 'the build_sha grammar NARROWED to {40} was accepted — the client emits 7 hex chars, so that drops the attribute from every datapoint';
      }
      for (const needle of ['7-character', 'attributes.ts', 'names.ts']) {
        if (!narrowed.detail.includes(needle)) {
          return `the {40} failure does not tell the next reader why 40 is wrong (missing \`${needle}\`): ${narrowed.detail}`;
        }
      }

      const reordered = checkBuildShaBounded(
        alloyS4Fixture({
          statements: [
            S4_STATEMENT_ZONE_ID,
            S4_STATEMENT_KEEP_KEYS,
            S4_STATEMENT_BUILD_SHA,
            S4_STATEMENT_DEVICE_CLASS,
          ],
        }),
      );
      if (reordered.ok) return '`keep_matching_keys` demoted out of element [0] was accepted';

      const commented = alloyS4Fixture({
        statements: [S4_STATEMENT_KEEP_KEYS, S4_STATEMENT_ZONE_ID, S4_STATEMENT_DEVICE_CLASS],
        commentedStatements: [S4_STATEMENT_BUILD_SHA],
      });
      if (!commented.includes(S4_STATEMENT_BUILD_SHA)) {
        return 'FIXTURE: the commented-out case must still spell the statement verbatim';
      }
      if (checkBuildShaBounded(commented).ok) {
        return 'a build_sha bound demoted to a `//` comment was accepted';
      }

      // AM20: both statements moved VERBATIM into a second, unwired component.
      // A file-wide check is green; s4_keep's effective list has lost the bound.
      const parked = alloyS4Fixture({
        statements: [S4_STATEMENT_KEEP_KEYS, S4_STATEMENT_ZONE_ID, S4_STATEMENT_DEVICE_CLASS],
        parkedComponent: true,
      });
      if (!parked.includes(S4_STATEMENT_BUILD_SHA) || !parked.includes(S4_STATEMENT_KEEP_KEYS)) {
        return 'FIXTURE: the parked-component case must still spell both statements verbatim';
      }
      const moved = checkBuildShaBounded(parked);
      if (moved.ok) {
        return 'the pinned statements moved into an unwired `parked_bounds` component were accepted — the live pipeline has lost the bound';
      }
      if (!moved.detail.includes('ABSENT from THIS list')) {
        return `the moved-statement failure does not say the bound left s4_keep's own list: ${moved.detail}`;
      }

      if (checkBuildShaBounded('otelcol.exporter.prometheus "s4" {\n}\n').ok) {
        return 'an alloy config with NO s4_keep component was accepted';
      }
      if (
        checkBuildShaBounded('otelcol.processor.transform "s4_keep" {\n\toutput {\n\t}\n}\n').ok
      ) {
        return 'an s4_keep with no `metric_statements` block was accepted';
      }
      if (checkBuildShaBounded(alloyS4Fixture({ statements: [] })).ok) {
        return 'an EMPTY statements list was accepted — the S4 label bounds would be gone';
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
  let dockerfile;
  let alertingDocs;
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
    // 13r-a: the Dockerfile is a config file like any other here (G12c), and
    // the alerting directory is ENUMERATED rather than named file-by-file —
    // Grafana provisions every document in it, so a file this eval did not
    // guess would otherwise crash the container with every gate green. The
    // three documents it finds today are already counted above; READ_FILES is a
    // Set, so FILE_FLOOR moves by exactly +1 (the Dockerfile).
    dockerfile = readReal(`${OPS}/Dockerfile`);
    const alertingDir = `${OPS}/grafana/provisioning/alerting`;
    alertingDocs = readdirSync(path.resolve(alertingDir))
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .sort()
      .map((f) => ({ name: f, text: readReal(`${alertingDir}/${f}`) }));
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

  // --- G12a-G12e: the 13r-a boot tripwires (ADR-0190) -----------------------
  record('G12a', checkTempoCommandParked(compose));

  const grafanaImage = scopedServiceScalar(compose, 'grafana', 'image');
  record(
    'G12b',
    checkAlertGroupIntervals(alertingDocs, grafanaImage.ok ? grafanaImage.value : null),
  );

  record('G12c', checkCaddySetcapBeforeUser(dockerfile));
  record('G12d', checkAlloyRunsUnprivileged(compose));
  record('G12e', checkBuildShaBounded(alloy));

  // An override file is auto-loaded by `docker compose` and merges arbitrary
  // keys into any service, so it defeats EVERY single-file detector above at
  // once (proven: `cap_add: [DAC_OVERRIDE, SYS_ADMIN]` with G12d green). The
  // durable fix is gating `docker compose config` output, which is out of
  // touches for this slice (R9) — until then, the file must simply not exist.
  for (const override of [
    'docker-compose.override.yml',
    'docker-compose.override.yaml',
    'compose.override.yml',
    'compose.override.yaml',
  ]) {
    if (existsSync(path.resolve(`${OPS}/${override}`))) {
      failures.push(
        `G12 (AM22): ${OPS}/${override} exists. \`docker compose\` merges it automatically, so ` +
          'every posture G12a/G12d prove about the committed file can be undone by a file none ' +
          'of them reads. If an override is genuinely needed, gate `docker compose config` ' +
          'output instead and record the decision in an ADR.',
      );
    }
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
      `${NODE_TEST_FILES.length} suites green (floor ${NODE_TEST_PASS_FLOOR}); G12a the tempo ` +
      `park is pinned and VISIBLE (command list exact and in order, image tag ` +
      `${TEMPO_IMAGE_TAG}, no profiles/extends, restart unless-stopped); G12b ` +
      `${alertingDocs.length} provisioned alerting document(s), every group interval non-zero ` +
      `and 10s-divisible under ${GRAFANA_IMAGE_TAG} with every \`for:\` an exact multiple of its ` +
      'own group interval; G12c the Dockerfile final stage strips the caddy net-bind capability ' +
      'as the last writer of that path, before its single USER; G12d the alloy block declares ' +
      `only the ${ALLOY_ALLOWED_KEYS.length} allowlisted keys and runs non-root, cap-dropped; ` +
      "G12e s4_keep's OWN statements list carries the key allowlist at [0] plus all three pinned " +
      'value bounds, and no compose override file exists',
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
