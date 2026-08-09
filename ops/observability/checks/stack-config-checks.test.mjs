// stack-config-checks.test.mjs — m20b observability-stack-config gating suite (TDD RED).
//
// Encodes EARS criteria OBS-11..OBS-40 (M20-observability-performance.spec.md) plus the
// §5b addendum predicates from the m20b plan (LISTEN_ADDRS_LOOPBACK, S4_METRIC_LABELS_BOUNDED,
// LOKI_RETENTION_ENFORCED, QUERIED_SERIES_ARE_DEFINED). Every predicate is imported from the
// NOT-YET-WRITTEN './stack-config-checks.mjs' — this suite is intentionally RED today because
// that module does not exist. The tester (this file) does not implement the predicate library
// and does not write any ops/observability/** config file; the specialist does both.
//
// Structure, per predicate:
//   (a) GOOD fixture(s) it must accept (ok === true)
//   (b) BAD fixture(s) it must reject (ok === false) — including the red-team cheat shapes
//       named in the m20b tester brief
//   (c) non-vacuity — empty/whitespace/anchor-missing input must be ok === false, never a
//       default-true ("scanning nothing is never green")
// Then a final group runs every predicate against the REAL committed files under
// ops/observability/** (+ docs/observability-dr-runbook.md at the repo root), read via
// node:fs readFileSync relative to import.meta.dirname. Those assertions stay RED until the
// implementer lands the config.
//
// Hard rules honored in this file (CI-enforced, see the m20b plan §2/§4):
//   - NO `new RegExp(...)` anywhere — literal regex literals and String methods only.
//   - Biome (repo root config): single quotes, semicolons, 2-space indent, width 100,
//     `recommended` rules, no unused variables.
//   - No fixture files on disk (`.gitignore:79` = `*.log` would silently drop one) — every
//     fixture is an inline template-literal string constant.
//   - Real-file reads resolve relative to `import.meta.dirname`, never `process.cwd()`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

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
  checkS4MetricLabelsBounded,
  checkServiceImagesPinned,
  checkServiceSetExact,
  checkStageMetricsLabelsBounded,
} from './stack-config-checks.mjs';

// ---------------------------------------------------------------------------
// Shared constants (parameters the real predicates get called with)
// ---------------------------------------------------------------------------
const EXPECTED_SERVICE_NAMES = [
  'prometheus',
  'alloy',
  'loki',
  'tempo',
  'grafana',
  'node_exporter',
  'caddy',
];

const PINNED_IMAGES = {
  prometheus:
    'prom/prometheus:v3.13.2@sha256:1147c92841726a6fef55fe6124491d6f85480f8de204f7d420304ca5bbd0a8f7',
  alloy:
    'grafana/alloy:v1.18.1@sha256:754409730f1a4ed9781f8a2ea3b6a8c55750ee125a267ecf8fb449f9a25c109a',
  loki: 'grafana/loki:3.7.6@sha256:83c76da7858a8f4f88117ac521864ac33896fdae7a352a1df4068556e7513f64',
  tempo:
    'grafana/tempo:3.0.2@sha256:aa8df8d069f77b82e978464daf55169bb8d135852ad58700aa96880653c3d8f7',
  grafana:
    'grafana/grafana:13.1.3@sha256:e27e68cfd5795c1bea54950766078a02e84dfa3bafe0a4d0e5382f713dfd8e4e',
  node_exporter:
    'prom/node-exporter:v1.12.1@sha256:da83fae85603c4e47e6c68369a7d746e2dda683dc35ea2e234b4f171e0d92798',
};

const D12_ALLOWED_LABELS = ['reducer', 'table', 'zone_id', 'evt'];
const HOST_NATIVE_ALLOWLIST = ['up', 'spacetime_', 'node_'];

// ---------------------------------------------------------------------------
// Assertion helpers — also enforce the fixed API contract: every result is
// `{ ok: boolean, detail: string }` with a non-empty detail, on every call.
// ---------------------------------------------------------------------------
function assertOk(result, msg) {
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.detail, 'string', `${msg}: detail must be a string`);
  assert.ok(result.detail.length > 0, `${msg}: detail must be non-empty`);
  assert.equal(result.ok, true, `${msg}: expected ok=true, got detail=${result.detail}`);
}

function assertNotOk(result, msg) {
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.detail, 'string', `${msg}: detail must be a string`);
  assert.ok(result.detail.length > 0, `${msg}: detail must be non-empty`);
  assert.equal(result.ok, false, `${msg}: expected ok=false, got detail=${result.detail}`);
}

// ---------------------------------------------------------------------------
// Real-file readers
// ---------------------------------------------------------------------------
const OPS_DIR = path.join(import.meta.dirname, '..');
const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');

function readOps(relPath) {
  try {
    return readFileSync(path.join(OPS_DIR, relPath), 'utf8');
  } catch (err) {
    throw new Error(
      `RED (expected until m20b lands): cannot read ops/observability/${relPath} (${err.code})`,
    );
  }
}

function readRepoRoot(relPath) {
  try {
    return readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  } catch (err) {
    throw new Error(`RED (expected until m20b lands): cannot read ${relPath} (${err.code})`);
  }
}

// =============================================================================
// 1. checkNoAlertingBlock(prometheusYmlText) — OBS-18
// =============================================================================

test('checkNoAlertingBlock: GOOD — real config, no alerting block anywhere', () => {
  const text = [
    'global:',
    '  scrape_interval: 15s',
    'scrape_configs:',
    '  - job_name: spacetimedb',
    '    metrics_path: /v1/metrics',
    '    static_configs:',
    "      - targets: ['127.0.0.1:3000']",
    'rule_files:',
    '  - "rules/recording.rules.yml"',
  ].join('\n');
  assertOk(checkNoAlertingBlock(text), 'GOOD no-alerting config');
});

test('checkNoAlertingBlock: GOOD — false-positive guard: comment + rule_files substring must NOT trip it', () => {
  const text = [
    'global:',
    '  scrape_interval: 15s',
    '# alerting:',
    '#   alertmanagers: []',
    'scrape_configs:',
    '  - job_name: alloy',
    '    static_configs:',
    "      - targets: ['127.0.0.1:12345']",
    'rule_files:',
    '  - "rules/alerting-style-naming.rules.yml"',
  ].join('\n');
  assertOk(
    checkNoAlertingBlock(text),
    'a `# alerting:` comment and an "alerting" substring inside a rule_files path must not trip the check',
  );
});

test('checkNoAlertingBlock: BAD — a real column-0 alerting: block is rejected', () => {
  const text = [
    'global:',
    '  scrape_interval: 15s',
    'scrape_configs:',
    '  - job_name: spacetimedb',
    '    static_configs:',
    "      - targets: ['127.0.0.1:3000']",
    'alerting:',
    '  alertmanagers:',
    '    - static_configs:',
    '        - targets: []',
    'rule_files:',
    '  - "rules/recording.rules.yml"',
  ].join('\n');
  assertNotOk(checkNoAlertingBlock(text), 'a real column-0 alerting: block must be caught');
});

test('checkNoAlertingBlock: non-vacuity — empty/whitespace input is rejected, never default-true', () => {
  assertNotOk(checkNoAlertingBlock(''), 'empty string must not vacuously pass');
  assertNotOk(checkNoAlertingBlock('   \n  \n'), 'whitespace-only text must not vacuously pass');
});

// =============================================================================
// 2. checkRulesAreRecordOnly(ruleFiles) — OBS-18   ruleFiles: [{ name, text }]
// =============================================================================

test('checkRulesAreRecordOnly: GOOD — a file with >=1 real record: rule passes', () => {
  const ruleFiles = [
    {
      name: 'recording.rules.yml',
      text: [
        'groups:',
        '  - name: slo',
        '    rules:',
        '      - record: mr:reducer_success_ratio',
        '        expr: sum(rate(spacetime_num_txns_total{committed="true"}[5m])) / sum(rate(spacetime_num_txns_total[5m]))',
      ].join('\n'),
    },
  ];
  assertOk(checkRulesAreRecordOnly(ruleFiles), 'GOOD record-only rules file');
});

test('checkRulesAreRecordOnly: BAD — non-zero groups but zero rules is vacuous and must FAIL', () => {
  const ruleFiles = [
    { name: 'recording.rules.yml', text: ['groups:', '  - name: slo', '    rules: []'].join('\n') },
  ];
  assertNotOk(
    checkRulesAreRecordOnly(ruleFiles),
    'a group with rules: [] must not read as record-only by vacuous absence of an alert:',
  );
});

test('checkRulesAreRecordOnly: BAD — any alert: stanza must FAIL', () => {
  const ruleFiles = [
    {
      name: 'recording.rules.yml',
      text: [
        'groups:',
        '  - name: slo',
        '    rules:',
        '      - record: mr:reducer_success_ratio',
        '        expr: up',
        '      - alert: HighErrorRate',
        '        expr: up == 0',
      ].join('\n'),
    },
  ];
  assertNotOk(checkRulesAreRecordOnly(ruleFiles), 'an alert: stanza mixed with record: must FAIL');
});

test('checkRulesAreRecordOnly: non-vacuity — zero rule files is rejected, not a vacuous pass', () => {
  assertNotOk(checkRulesAreRecordOnly([]), 'an empty ruleFiles array must not vacuously pass');
});

test('checkRulesAreRecordOnly: non-vacuity — a rule file with blank text is rejected', () => {
  assertNotOk(
    checkRulesAreRecordOnly([{ name: 'recording.rules.yml', text: '   \n  ' }]),
    'a whitespace-only rule file must not vacuously pass',
  );
});

// =============================================================================
// 3. checkServiceSetExact(composeText, expectedServiceNames) — OBS-19/37/D3
// =============================================================================

const COMPOSE_SEVEN_SERVICES = [
  'services:',
  '  prometheus:',
  `    image: ${PINNED_IMAGES.prometheus}`,
  '  alloy:',
  `    image: ${PINNED_IMAGES.alloy}`,
  '  loki:',
  `    image: ${PINNED_IMAGES.loki}`,
  '  tempo:',
  `    image: ${PINNED_IMAGES.tempo}`,
  '  grafana:',
  `    image: ${PINNED_IMAGES.grafana}`,
  '  node_exporter:',
  `    image: ${PINNED_IMAGES.node_exporter}`,
  '  caddy:',
  '    build: .',
].join('\n');

test('checkServiceSetExact: GOOD — exact 7-service set matches', () => {
  assertOk(
    checkServiceSetExact(COMPOSE_SEVEN_SERVICES, EXPECTED_SERVICE_NAMES),
    'GOOD exact 7-service compose',
  );
});

test('checkServiceSetExact: BAD — same COUNT, substituted name (alertmanager for grafana) rejected', () => {
  const compose = [
    'services:',
    '  prometheus:',
    `    image: ${PINNED_IMAGES.prometheus}`,
    '  alloy:',
    `    image: ${PINNED_IMAGES.alloy}`,
    '  loki:',
    `    image: ${PINNED_IMAGES.loki}`,
    '  tempo:',
    `    image: ${PINNED_IMAGES.tempo}`,
    '  alertmanager:',
    '    image: prom/alertmanager:v0.27.0',
    '  node_exporter:',
    `    image: ${PINNED_IMAGES.node_exporter}`,
    '  caddy:',
    '    build: .',
  ].join('\n');
  assertNotOk(
    checkServiceSetExact(compose, EXPECTED_SERVICE_NAMES),
    'same count of 7 services but alertmanager substituted for grafana — a count check would miss this, a name-SET check must not',
  );
});

test('checkServiceSetExact: BAD — an 8th service (addition) is rejected', () => {
  const compose = `${COMPOSE_SEVEN_SERVICES}\n  mr-trace-relay:\n    build: ./relay\n`;
  assertNotOk(
    checkServiceSetExact(compose, EXPECTED_SERVICE_NAMES),
    'an added 8th service must be rejected',
  );
});

test('checkServiceSetExact: BAD — a missing service (omission) is rejected', () => {
  const compose = [
    'services:',
    '  prometheus:',
    `    image: ${PINNED_IMAGES.prometheus}`,
    '  alloy:',
    `    image: ${PINNED_IMAGES.alloy}`,
    '  loki:',
    `    image: ${PINNED_IMAGES.loki}`,
    '  tempo:',
    `    image: ${PINNED_IMAGES.tempo}`,
    '  grafana:',
    `    image: ${PINNED_IMAGES.grafana}`,
    '  node_exporter:',
    `    image: ${PINNED_IMAGES.node_exporter}`,
  ].join('\n');
  assertNotOk(
    checkServiceSetExact(compose, EXPECTED_SERVICE_NAMES),
    'a missing caddy service must be rejected',
  );
});

test('checkServiceSetExact: non-vacuity — empty compose text is rejected against the real expected set', () => {
  assertNotOk(
    checkServiceSetExact('', EXPECTED_SERVICE_NAMES),
    'empty compose text must not vacuously pass',
  );
  assertNotOk(
    checkServiceSetExact('services:\n', EXPECTED_SERVICE_NAMES),
    'a services: key with zero entries must not vacuously pass',
  );
});

test('checkServiceSetExact: parameterization — the expected set is a PARAMETER, not hardcoded to 7', () => {
  const twoServiceCompose = [
    'services:',
    '  prometheus:',
    '    image: x',
    '  alloy:',
    '    image: y',
  ].join('\n');
  assertOk(
    checkServiceSetExact(twoServiceCompose, ['prometheus', 'alloy']),
    'a smaller expected set must be honored, proving the check is parameterized (7 now, 8 in m20b-2)',
  );
  assertNotOk(
    checkServiceSetExact(COMPOSE_SEVEN_SERVICES, ['prometheus', 'alloy']),
    'the 7-service compose must fail against a 2-name expected set',
  );
});

// =============================================================================
// 4. checkServiceImagesPinned(composeText, expectedImageByService) — OBS-33/37
// =============================================================================

const IMAGES_EXPECTED_FIXTURE = {
  prometheus:
    'prom/prometheus:v3.13.2@sha256:1111111111111111111111111111111111111111111111111111111111111111',
  loki: 'grafana/loki:3.7.6@sha256:2222222222222222222222222222222222222222222222222222222222222222',
};

test('checkServiceImagesPinned: GOOD — every service image matches its pinned digest exactly', () => {
  const compose = [
    'services:',
    '  prometheus:',
    `    image: ${IMAGES_EXPECTED_FIXTURE.prometheus}`,
    '  loki:',
    `    image: ${IMAGES_EXPECTED_FIXTURE.loki}`,
  ].join('\n');
  assertOk(checkServiceImagesPinned(compose, IMAGES_EXPECTED_FIXTURE), 'GOOD exact-digest match');
});

test('checkServiceImagesPinned: BAD — a service NAMED prometheus running a banned tool image', () => {
  const compose = [
    'services:',
    '  prometheus:',
    '    image: otel/opentelemetry-collector:0.110.0',
    '  loki:',
    `    image: ${IMAGES_EXPECTED_FIXTURE.loki}`,
  ].join('\n');
  assertNotOk(
    checkServiceImagesPinned(compose, IMAGES_EXPECTED_FIXTURE),
    'a name-only check would miss a service literally called prometheus running otel/opentelemetry-collector — the image content itself must be checked',
  );
});

test('checkServiceImagesPinned: BAD — an unpinned :latest tag is rejected', () => {
  const compose = [
    'services:',
    '  prometheus:',
    `    image: ${IMAGES_EXPECTED_FIXTURE.prometheus}`,
    '  loki:',
    '    image: grafana/loki:latest',
  ].join('\n');
  assertNotOk(
    checkServiceImagesPinned(compose, IMAGES_EXPECTED_FIXTURE),
    'grafana/loki:latest must be rejected',
  );
});

test('checkServiceImagesPinned: BAD — a tag with no @sha256 digest is rejected', () => {
  const compose = [
    'services:',
    '  prometheus:',
    '    image: prom/prometheus:v3.13.2',
    '  loki:',
    `    image: ${IMAGES_EXPECTED_FIXTURE.loki}`,
  ].join('\n');
  assertNotOk(
    checkServiceImagesPinned(compose, IMAGES_EXPECTED_FIXTURE),
    'a tag-only image with no @sha256:... digest must be rejected',
  );
});

test('checkServiceImagesPinned: non-vacuity — an empty expectedImageByService map is rejected', () => {
  const compose = [
    'services:',
    '  prometheus:',
    `    image: ${IMAGES_EXPECTED_FIXTURE.prometheus}`,
  ].join('\n');
  assertNotOk(checkServiceImagesPinned(compose, {}), 'nothing to check must not read as green');
});

// =============================================================================
// 5. checkModuleLogsMountReadOnly(composeText) — OBS-11/45
// =============================================================================

test('checkModuleLogsMountReadOnly: GOOD — short-form :ro mount', () => {
  const compose = [
    'services:',
    '  alloy:',
    '    volumes:',
    '      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro',
    '      - ../../spacetime-data/replicas:/data/replicas:ro',
  ].join('\n');
  assertOk(checkModuleLogsMountReadOnly(compose), 'GOOD short-form :ro mount');
});

test('checkModuleLogsMountReadOnly: GOOD — long-form read_only: true mount', () => {
  const compose = [
    'services:',
    '  alloy:',
    '    volumes:',
    '      - type: bind',
    '        source: ../../spacetime-data/replicas',
    '        target: /data/replicas',
    '        read_only: true',
  ].join('\n');
  assertOk(checkModuleLogsMountReadOnly(compose), 'GOOD long-form read_only: true mount');
});

test('checkModuleLogsMountReadOnly: BAD — short-form :rw is rejected', () => {
  const compose = [
    'services:',
    '  alloy:',
    '    volumes:',
    '      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro',
    '      - ../../spacetime-data/replicas:/data/replicas:rw',
  ].join('\n');
  assertNotOk(
    checkModuleLogsMountReadOnly(compose),
    'the module_logs mount specifically must be :ro — an unrelated :ro mount on the same service must not launder a :rw module_logs mount',
  );
});

test('checkModuleLogsMountReadOnly: BAD — bare short-form mount (no :ro, no :rw) is rejected', () => {
  const compose = [
    'services:',
    '  alloy:',
    '    volumes:',
    '      - ../../spacetime-data/replicas:/data/replicas',
  ].join('\n');
  assertNotOk(
    checkModuleLogsMountReadOnly(compose),
    'a bare mount with no suffix defaults to read-write in Docker and must be rejected',
  );
});

test('checkModuleLogsMountReadOnly: BAD — long-form with NEITHER :ro NOR read_only: true is rejected', () => {
  const compose = [
    'services:',
    '  alloy:',
    '    volumes:',
    '      - type: bind',
    '        source: ../../spacetime-data/replicas',
    '        target: /data/replicas',
  ].join('\n');
  assertNotOk(
    checkModuleLogsMountReadOnly(compose),
    'long-form syntax with no read_only key contains neither :ro nor :rw — a reject-:rw-only check would pass this writable mount by omission; the predicate must POSITIVELY assert read-only',
  );
});

test('checkModuleLogsMountReadOnly: non-vacuity — no volumes at all is rejected', () => {
  const compose = ['services:', '  alloy:', '    image: grafana/alloy:v1.18.1'].join('\n');
  assertNotOk(
    checkModuleLogsMountReadOnly(compose),
    'a service with no volumes section cannot positively confirm a read-only mount and must not vacuously pass',
  );
  assertNotOk(checkModuleLogsMountReadOnly(''), 'empty compose text must not vacuously pass');
});

// =============================================================================
// 6. checkListenAddrsLoopback(composeText) — OQ1/OBS-17, plan §5b-A/B
// =============================================================================

const LISTEN_GOOD = [
  'services:',
  '  prometheus:',
  '    network_mode: host',
  '    command:',
  '      - --config.file=/etc/prometheus/prometheus.yml',
  '      - --web.listen-address=127.0.0.1:9090',
  '  grafana:',
  '    network_mode: host',
  '    environment:',
  '      - GF_SERVER_HTTP_ADDR=127.0.0.1',
  '  loki:',
  '    network_mode: host',
  '    command:',
  '      - -config.file=/etc/loki/loki-config.yml',
  '      - -server.http-listen-address=127.0.0.1',
  '  alloy:',
  '    network_mode: host',
  '    command:',
  '      - --server.http.listen-addr=127.0.0.1:12345',
  '  node_exporter:',
  '    network_mode: host',
  '    command:',
  '      - --web.listen-address=127.0.0.1:9100',
].join('\n');

test('checkListenAddrsLoopback: GOOD — every service explicitly binds 127.0.0.1, no ports: key', () => {
  assertOk(
    checkListenAddrsLoopback(LISTEN_GOOD),
    'GOOD all-loopback compose under network_mode: host',
  );
});

test('checkListenAddrsLoopback: BAD — 0.0.0.0 listen address is rejected', () => {
  const compose = LISTEN_GOOD.replace(
    '--web.listen-address=127.0.0.1:9090',
    '--web.listen-address=0.0.0.0:9090',
  );
  assertNotOk(checkListenAddrsLoopback(compose), '0.0.0.0:9090 must be rejected');
});

test('checkListenAddrsLoopback: BAD — a bare :PORT (implicit all-interfaces) is rejected', () => {
  const compose = LISTEN_GOOD.replace(
    '--web.listen-address=127.0.0.1:9090',
    '--web.listen-address=:9090',
  );
  assertNotOk(checkListenAddrsLoopback(compose), 'a bare :9090 with no host part must be rejected');
});

test('checkListenAddrsLoopback: BAD — an omitted listen flag is rejected (upstream default is 0.0.0.0)', () => {
  const compose = LISTEN_GOOD.replace(
    '    command:\n      - --web.listen-address=127.0.0.1:9100',
    '    command:\n      - --collector.systemd',
  );
  assertNotOk(
    checkListenAddrsLoopback(compose),
    'omitting the listen-address flag entirely must FAIL — node_exporter defaults to 0.0.0.0, so silence is the trap',
  );
});

test('checkListenAddrsLoopback: BAD — any ports: key is rejected (inert under network_mode: host, false comfort)', () => {
  const compose = `${LISTEN_GOOD}\n  caddy:\n    network_mode: host\n    ports:\n      - "127.0.0.1:8443:8443"\n`;
  assertNotOk(
    checkListenAddrsLoopback(compose),
    'a ports: key is silently inert under network_mode: host and must be rejected even when its own binding looks loopback-safe — it is false comfort, not a real control',
  );
});

test('checkListenAddrsLoopback: non-vacuity — no listen flags and no network_mode: host at all is rejected', () => {
  const compose = ['services:', '  prometheus:', '    image: prom/prometheus:v3.13.2'].join('\n');
  assertNotOk(
    checkListenAddrsLoopback(compose),
    'a compose file asserting nothing about binding must not vacuously pass',
  );
  assertNotOk(checkListenAddrsLoopback(''), 'empty compose text must not vacuously pass');
});

// =============================================================================
// 7. checkNoExecLogSource(alloyText, composeText) — OBS-11
// =============================================================================

const ALLOY_LOG_SOURCE_GOOD = [
  'loki.source.file "module_logs" {',
  '  targets    = local.file_match.module_logs.targets',
  '  forward_to = [loki.process.module_logs.receiver]',
  '}',
].join('\n');

const COMPOSE_ALLOY_NO_OVERRIDE = [
  'services:',
  '  alloy:',
  `    image: ${PINNED_IMAGES.alloy}`,
  '    volumes:',
  '      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro',
].join('\n');

test('checkNoExecLogSource: GOOD — loki.source.file with no exec source, no command/entrypoint override', () => {
  assertOk(
    checkNoExecLogSource(ALLOY_LOG_SOURCE_GOOD, COMPOSE_ALLOY_NO_OVERRIDE),
    'GOOD file-tail source, clean compose service',
  );
});

test('checkNoExecLogSource: BAD — a loki.source.exec component in the Alloy config is rejected', () => {
  const alloyText = [
    'loki.source.exec "tail_logs" {',
    '  command    = ["tail", "-F", "/data/replicas/module_logs.log"]',
    '  forward_to = [loki.process.module_logs.receiver]',
    '}',
  ].join('\n');
  assertNotOk(
    checkNoExecLogSource(alloyText, COMPOSE_ALLOY_NO_OVERRIDE),
    'a loki.source.exec-shaped component must be rejected',
  );
});

test('checkNoExecLogSource: BAD — a command:/entrypoint: shell-pipeline override on the Alloy service is rejected', () => {
  const composeText = [
    'services:',
    '  alloy:',
    `    image: ${PINNED_IMAGES.alloy}`,
    '    entrypoint: ["/bin/sh", "-c", "tail -F /data/replicas/*/module_logs/*.log | curl -X POST http://localhost:3100"]',
  ].join('\n');
  assertNotOk(
    checkNoExecLogSource(ALLOY_LOG_SOURCE_GOOD, composeText),
    'a shell-pipeline entrypoint/command override achieves the banned subprocess-log-tail outcome OUTSIDE config.alloy and must be caught too',
  );
});

test('checkNoExecLogSource: non-vacuity — empty alloyText/composeText is rejected', () => {
  assertNotOk(
    checkNoExecLogSource('', ''),
    'both empty must not vacuously pass — no loki.source.file confirmed either',
  );
  assertNotOk(
    checkNoExecLogSource('', COMPOSE_ALLOY_NO_OVERRIDE),
    'empty Alloy config text cannot positively confirm a file-tail source and must not vacuously pass',
  );
});

// =============================================================================
// 8. checkStageMetricsLabelsBounded(alloyText, allowedLabels) — OBS-12/36, D12
// =============================================================================

const ALLOY_STAGE_METRICS_GOOD = [
  'loki.process "module_logs" {',
  '  forward_to = [loki.write.default.receiver]',
  '',
  '  stage.json {',
  '    expressions = {',
  '      reducer = "reducer",',
  '      evt     = "evt",',
  '    }',
  '  }',
  '',
  '  stage.labels {',
  '    values = {',
  '      reducer = "",',
  '      evt     = "",',
  '    }',
  '  }',
  '',
  '  stage.metrics {',
  '    metric.counter {',
  '      name      = "mr_log_events_total"',
  '      match_all = true',
  '      action    = "inc"',
  '    }',
  '  }',
  '}',
].join('\n');

test('checkStageMetricsLabelsBounded: GOOD — labels drawn from the bounded D12 enum', () => {
  assertOk(
    checkStageMetricsLabelsBounded(ALLOY_STAGE_METRICS_GOOD, D12_ALLOWED_LABELS),
    'GOOD bounded reducer/evt labels via stage.json literal field mapping',
  );
});

test('checkStageMetricsLabelsBounded: BAD — a "sender" label is rejected', () => {
  const alloyText = [
    'loki.process "module_logs" {',
    '  forward_to = [loki.write.default.receiver]',
    '  stage.labels {',
    '    values = {',
    '      reducer = "",',
    '      sender  = "",',
    '    }',
    '  }',
    '  stage.metrics {',
    '    metric.counter { name = "mr_log_events_total" match_all = true action = "inc" }',
    '  }',
    '}',
  ].join('\n');
  assertNotOk(
    checkStageMetricsLabelsBounded(alloyText, D12_ALLOWED_LABELS),
    'a sender label must be rejected — D12/D35',
  );
});

test('checkStageMetricsLabelsBounded: BAD — a "connection_id" label is rejected (the D12 inversion)', () => {
  const alloyText = [
    'loki.process "module_logs" {',
    '  forward_to = [loki.write.default.receiver]',
    '  stage.labels {',
    '    values = {',
    '      connection_id = "",',
    '    }',
    '  }',
    '  stage.metrics {',
    '    metric.counter { name = "mr_log_events_total" match_all = true action = "inc" }',
    '  }',
    '}',
  ].join('\n');
  assertNotOk(
    checkStageMetricsLabelsBounded(alloyText, D12_ALLOWED_LABELS),
    'connection_id is required as a log FIELD but forbidden as a LABEL — promoting it is the exact one-series-per-session breach D12 warns about',
  );
});

test('checkStageMetricsLabelsBounded: BAD — a zero-label stage.labels block is vacuous and must FAIL', () => {
  const alloyText = [
    'loki.process "module_logs" {',
    '  forward_to = [loki.write.default.receiver]',
    '  stage.labels {',
    '    values = {}',
    '  }',
    '  stage.metrics {',
    '    metric.counter { name = "mr_log_events_total" match_all = true action = "inc" }',
    '  }',
    '}',
  ].join('\n');
  assertNotOk(
    checkStageMetricsLabelsBounded(alloyText, D12_ALLOWED_LABELS),
    'a zero-label block vacuously satisfies "no unbounded label" — the predicate must positively find a bounded label present, not pass on absence',
  );
});

test('checkStageMetricsLabelsBounded: BAD — a correctly-named evt label sourced from a free-form regex capture is rejected', () => {
  const alloyText = [
    'loki.process "module_logs" {',
    '  forward_to = [loki.write.default.receiver]',
    '',
    '  stage.regex {',
    '    expression = "evt=(?P<evt>[^\\\\s]+)"',
    '  }',
    '',
    '  stage.labels {',
    '    values = {',
    '      reducer = "",',
    '      evt     = "",',
    '    }',
    '  }',
    '',
    '  stage.metrics {',
    '    metric.counter { name = "mr_log_events_total" match_all = true action = "inc" }',
    '  }',
    '}',
  ].join('\n');
  assertNotOk(
    checkStageMetricsLabelsBounded(alloyText, D12_ALLOWED_LABELS),
    'evt is a correctly-NAMED allowed label, but its only source here is a free-form regex capture group — right name, unbounded values — must be rejected, not just name-checked',
  );
});

test('checkStageMetricsLabelsBounded: non-vacuity — empty alloyText is rejected', () => {
  assertNotOk(
    checkStageMetricsLabelsBounded('', D12_ALLOWED_LABELS),
    'empty text must not vacuously pass',
  );
});

test('checkStageMetricsLabelsBounded: parameterization — allowedLabels is a real parameter, not hardcoded', () => {
  assertNotOk(
    checkStageMetricsLabelsBounded(ALLOY_STAGE_METRICS_GOOD, ['reducer']),
    'when evt is excluded from the allowlist parameter, a config that labels by evt must now fail — proves the allowlist is honored, not hardcoded',
  );
});

// =============================================================================
// 9. checkS4MetricLabelsBounded(alloyText) — OBS-34, plan §5b-B
// =============================================================================

const S4_CHAIN_GOOD = [
  'otelcol.receiver.otlp "s4" {',
  '  http { endpoint = "127.0.0.1:4318" }',
  '  output {',
  '    metrics = [otelcol.processor.attributes.s4_keep.input]',
  '  }',
  '}',
  '',
  'otelcol.processor.attributes "s4_keep" {',
  '  action {',
  '    key    = "*"',
  '    action = "delete"',
  '  }',
  '  action {',
  '    key    = "fps"',
  '    action = "upsert"',
  '  }',
  '  output {',
  '    metrics = [otelcol.exporter.prometheus.s4.input]',
  '  }',
  '}',
  '',
  'otelcol.exporter.prometheus "s4" {',
  '  forward_to = [prometheus.remote_write.default.receiver]',
  '}',
  '',
  'prometheus.remote_write "default" {',
  '  endpoint { url = "http://127.0.0.1:9090/api/v1/write" }',
  '}',
].join('\n');

test('checkS4MetricLabelsBounded: GOOD — an explicit keep-list attribute filter is wired into the S4 chain', () => {
  assertOk(
    checkS4MetricLabelsBounded(S4_CHAIN_GOOD),
    'GOOD S4 chain with an attribute allowlist filter',
  );
});

test('checkS4MetricLabelsBounded: BAD — S4 chain with NO attribute-allowlist filter between receipt and storage', () => {
  const alloyText = [
    'otelcol.receiver.otlp "s4" {',
    '  http { endpoint = "127.0.0.1:4318" }',
    '  output {',
    '    metrics = [otelcol.exporter.prometheus.s4.input]',
    '  }',
    '}',
    '',
    'otelcol.exporter.prometheus "s4" {',
    '  forward_to = [prometheus.remote_write.default.receiver]',
    '}',
    '',
    'prometheus.remote_write "default" {',
    '  endpoint { url = "http://127.0.0.1:9090/api/v1/write" }',
    '}',
  ].join('\n');
  assertNotOk(
    checkS4MetricLabelsBounded(alloyText),
    'the public unauthenticated OTLP ingest converts attacker-chosen attributes 1:1 into Prometheus labels with no filter — a curl loop with a random attribute per request OOMs Prometheus; this is red-team C3, the highest-severity finding',
  );
});

test('checkS4MetricLabelsBounded: non-vacuity — empty text, and an S4 chain with no exporter/remote_write anchor, both rejected', () => {
  assertNotOk(checkS4MetricLabelsBounded(''), 'empty text must not vacuously pass');
  assertNotOk(
    checkS4MetricLabelsBounded(
      'otelcol.receiver.otlp "s4" {\n  http { endpoint = "127.0.0.1:4318" }\n}',
    ),
    'a receiver with no downstream exporter/remote_write chain at all cannot positively confirm the S4 path is filtered and must not vacuously pass',
  );
});

// =============================================================================
// 10. checkRemoteWriteBothEnds(alloyText, composeText) — OBS-38
// =============================================================================

const COMPOSE_RW_FLAG = [
  'services:',
  '  prometheus:',
  '    command:',
  '      - --config.file=/etc/prometheus/prometheus.yml',
  '      - --web.enable-remote-write-receiver',
].join('\n');

const ALLOY_RW_WIRED_GOOD = [
  'otelcol.exporter.prometheus "s4" {',
  '  forward_to = [prometheus.remote_write.default.receiver]',
  '}',
  '',
  'prometheus.remote_write "default" {',
  '  endpoint { url = "http://127.0.0.1:9090/api/v1/write" }',
  '}',
].join('\n');

test('checkRemoteWriteBothEnds: GOOD — flag present AND forward_to name-resolves to the remote_write component', () => {
  assertOk(
    checkRemoteWriteBothEnds(ALLOY_RW_WIRED_GOOD, COMPOSE_RW_FLAG),
    'GOOD wired remote-write path',
  );
});

test('checkRemoteWriteBothEnds: BAD — co-occurrence without wiring: forward_to label does not resolve', () => {
  const alloyText = [
    'otelcol.exporter.prometheus "s4" {',
    '  forward_to = [prometheus.remote_write.other.receiver]',
    '}',
    '',
    'prometheus.remote_write "default" {',
    '  endpoint { url = "http://127.0.0.1:9090/api/v1/write" }',
    '}',
  ].join('\n');
  assertNotOk(
    checkRemoteWriteBothEnds(alloyText, COMPOSE_RW_FLAG),
    'the flag and a prometheus.remote_write component both exist (co-occurrence), but forward_to references label "other" while the actual component is named "default" — wiring, not adjacency, must be checked',
  );
});

test('checkRemoteWriteBothEnds: BAD — the remote-write-receiver flag is missing from compose entirely', () => {
  const composeText = [
    'services:',
    '  prometheus:',
    '    command:',
    '      - --config.file=/etc/prometheus/prometheus.yml',
  ].join('\n');
  assertNotOk(
    checkRemoteWriteBothEnds(ALLOY_RW_WIRED_GOOD, composeText),
    'a correctly-wired Alloy chain still fails if Prometheus never enables --web.enable-remote-write-receiver',
  );
});

test('checkRemoteWriteBothEnds: non-vacuity — empty inputs are rejected', () => {
  assertNotOk(checkRemoteWriteBothEnds('', ''), 'both empty must not vacuously pass');
});

// =============================================================================
// 11. checkCaddyDualPosture(caddyfileText) — OBS-20/21, D5
// =============================================================================

const CADDY_GOOD = [
  'grafana.example.com {',
  '  tls internal',
  '  basicauth {',
  '    admin {env.MR_GRAFANA_BASIC_AUTH_HASH}',
  '  }',
  '  reverse_proxy 127.0.0.1:3000',
  '}',
  '',
  'otlp.example.com {',
  '  tls internal',
  '  handle {',
  '    header Access-Control-Allow-Origin "https://example.com"',
  '    rate_limit {',
  '      zone otlp_ingest {',
  '        key    {remote_host}',
  '        events 100',
  '        window 1s',
  '      }',
  '    }',
  '    request_body {',
  '      max_size 2MB',
  '    }',
  '    reverse_proxy 127.0.0.1:12345',
  '  }',
  '}',
].join('\n');

test('checkCaddyDualPosture: GOOD — Grafana route auth+TLS, OTLP route TLS+CORS+sane rate-limit+body-cap, no auth', () => {
  assertOk(checkCaddyDualPosture(CADDY_GOOD), 'GOOD dual-posture Caddyfile');
});

test('checkCaddyDualPosture: BAD — auth on the OTLP route is rejected', () => {
  const caddyfileText = CADDY_GOOD.replace(
    '  handle {\n    header Access-Control-Allow-Origin "https://example.com"',
    '  handle {\n    basicauth {\n      admin {env.MR_GRAFANA_BASIC_AUTH_HASH}\n    }\n    header Access-Control-Allow-Origin "https://example.com"',
  );
  assertNotOk(
    checkCaddyDualPosture(caddyfileText),
    'a public game client cannot present a login — auth on the OTLP ingest route must be rejected',
  );
});

test('checkCaddyDualPosture: BAD — no auth on the Grafana route is rejected', () => {
  const caddyfileText = [
    'grafana.example.com {',
    '  tls internal',
    '  reverse_proxy 127.0.0.1:3000',
    '}',
    '',
    'otlp.example.com {',
    '  tls internal',
    '  handle {',
    '    header Access-Control-Allow-Origin "https://example.com"',
    '    rate_limit {',
    '      zone otlp_ingest { key {remote_host} events 100 window 1s }',
    '    }',
    '    request_body { max_size 2MB }',
    '    reverse_proxy 127.0.0.1:12345',
    '  }',
    '}',
  ].join('\n');
  assertNotOk(
    checkCaddyDualPosture(caddyfileText),
    'no auth directive on the operator-only Grafana route must be rejected',
  );
});

test('checkCaddyDualPosture: BAD — OTLP route with CORS but no rate_limit or no body-size cap is rejected', () => {
  const caddyfileText = [
    'grafana.example.com {',
    '  tls internal',
    '  basicauth { admin {env.MR_GRAFANA_BASIC_AUTH_HASH} }',
    '  reverse_proxy 127.0.0.1:3000',
    '}',
    '',
    'otlp.example.com {',
    '  tls internal',
    '  handle {',
    '    header Access-Control-Allow-Origin "https://example.com"',
    '    request_body { max_size 2MB }',
    '    reverse_proxy 127.0.0.1:12345',
    '  }',
    '}',
  ].join('\n');
  assertNotOk(
    checkCaddyDualPosture(caddyfileText),
    'CORS alone is browser-enforced only — a direct scripted client ignores it; missing rate_limit against a scripted flood must be rejected',
  );
});

test('checkCaddyDualPosture: BAD — functionally-unlimited numeric ceilings are rejected, not just directive presence', () => {
  const caddyfileText = [
    'grafana.example.com {',
    '  tls internal',
    '  basicauth { admin {env.MR_GRAFANA_BASIC_AUTH_HASH} }',
    '  reverse_proxy 127.0.0.1:3000',
    '}',
    '',
    'otlp.example.com {',
    '  tls internal',
    '  handle {',
    '    header Access-Control-Allow-Origin "https://example.com"',
    '    rate_limit {',
    '      zone otlp_ingest {',
    '        key    {remote_host}',
    '        events 999999999',
    '        window 1s',
    '      }',
    '    }',
    '    request_body {',
    '      max_size 999999999999',
    '    }',
    '    reverse_proxy 127.0.0.1:12345',
    '  }',
    '}',
  ].join('\n');
  assertNotOk(
    checkCaddyDualPosture(caddyfileText),
    'rate_limit { events 999999999 window 1s } and max_size 999999999999 are structurally present but functionally unlimited — the check must assert sane numeric ceilings, not mere directive presence',
  );
});

test('checkCaddyDualPosture: non-vacuity — empty Caddyfile text is rejected', () => {
  assertNotOk(checkCaddyDualPosture(''), 'empty Caddyfile text must not vacuously pass');
  assertNotOk(
    checkCaddyDualPosture('{\n  order rate_limit before basicauth\n}'),
    'a global-options-only file with no site blocks must not vacuously pass',
  );
});

// =============================================================================
// 12. checkAlertRuleHasReceiver(alertRulesText, contactPointsText, notificationPoliciesText) — OBS-39, D4
// =============================================================================

const ALERT_RULES_GOOD = [
  'apiVersion: 1',
  'groups:',
  '  - orgId: 1',
  '    name: meta-monitoring',
  '    folder: Observability',
  '    interval: 15s',
  '    rules:',
  '      - uid: alloy-down',
  '        title: AlloyDown',
  '        for: 45s',
].join('\n');

const CONTACT_POINTS_GOOD = [
  'apiVersion: 1',
  'contactPoints:',
  '  - orgId: 1',
  '    name: on-call-ntfy',
  '    receivers:',
  '      - uid: cp-1',
  '        type: webhook',
  '        settings:',
  '          url: https://ntfy.sh/mr-observability-alerts',
].join('\n');

const NOTIFICATION_POLICIES_GOOD = [
  'apiVersion: 1',
  'policies:',
  '  - orgId: 1',
  '    receiver: on-call-ntfy',
  '    routes:',
  '      - receiver: on-call-ntfy',
  '        object_matchers:',
  '          - ["alertname", "=", "AlloyDown"]',
].join('\n');

test('checkAlertRuleHasReceiver: GOOD — rule routes to a real, defined, non-empty contact point', () => {
  assertOk(
    checkAlertRuleHasReceiver(ALERT_RULES_GOOD, CONTACT_POINTS_GOOD, NOTIFICATION_POLICIES_GOOD),
    'GOOD alert routed to a real receiver',
  );
});

test('checkAlertRuleHasReceiver: BAD — routed to a contact point that is never defined', () => {
  const notificationPoliciesText = [
    'apiVersion: 1',
    'policies:',
    '  - orgId: 1',
    '    receiver: nobody-home',
    '    routes:',
    '      - receiver: nobody-home',
    '        object_matchers:',
    '          - ["alertname", "=", "AlloyDown"]',
  ].join('\n');
  assertNotOk(
    checkAlertRuleHasReceiver(ALERT_RULES_GOOD, CONTACT_POINTS_GOOD, notificationPoliciesText),
    'routing to "nobody-home", a name absent from contactPoints, evaluates into nothing — the exact D4 failure',
  );
});

test('checkAlertRuleHasReceiver: BAD — a contact point that structurally exists but has zero real recipients (empty receivers)', () => {
  const contactPointsText = [
    'apiVersion: 1',
    'contactPoints:',
    '  - orgId: 1',
    '    name: on-call-ntfy',
    '    receivers: []',
  ].join('\n');
  assertNotOk(
    checkAlertRuleHasReceiver(ALERT_RULES_GOOD, contactPointsText, NOTIFICATION_POLICIES_GOOD),
    'a contact point with receivers: [] "exists" but notifies nobody — the same D4 failure in disguise',
  );
});

test('checkAlertRuleHasReceiver: BAD — a contact point with a placeholder/empty URL notifies nobody', () => {
  const contactPointsText = [
    'apiVersion: 1',
    'contactPoints:',
    '  - orgId: 1',
    '    name: on-call-ntfy',
    '    receivers:',
    '      - uid: cp-1',
    '        type: webhook',
    '        settings:',
    '          url: "<CHANGE_ME>"',
  ].join('\n');
  assertNotOk(
    checkAlertRuleHasReceiver(ALERT_RULES_GOOD, contactPointsText, NOTIFICATION_POLICIES_GOOD),
    'a placeholder token in the recipient URL is not a real recipient',
  );
});

test('checkAlertRuleHasReceiver: non-vacuity — zero alert rules cannot verify "routed to a receiver" and must FAIL', () => {
  assertNotOk(
    checkAlertRuleHasReceiver(
      'apiVersion: 1\ngroups: []',
      CONTACT_POINTS_GOOD,
      NOTIFICATION_POLICIES_GOOD,
    ),
    'with no alert rules at all, the claim is unverifiable and must not vacuously pass',
  );
  assertNotOk(checkAlertRuleHasReceiver('', '', ''), 'all-empty input must not vacuously pass');
});

// =============================================================================
// 13. checkDashboardPanelsReal(dashboardJsonText) — OBS-22..26/28
// =============================================================================

const DASHBOARD_GOOD = JSON.stringify({
  title: 'Monster Realm — RED & SLOs',
  templating: { list: [{ name: 'slo_set', type: 'query' }] },
  panels: [
    {
      title: 'Movement tick p95',
      targets: [
        {
          expr: 'histogram_quantile(0.95, sum(rate(spacetime_txn_elapsed_time_sec_bucket{reducer="movement_tick"}[5m])) by (le))',
        },
      ],
    },
    {
      title: 'Reducer success SLO',
      targets: [
        {
          expr: 'sum(rate(spacetime_num_txns_total{committed="true",reducer=~"$slo_set"}[5m])) / sum(rate(spacetime_num_txns_total{reducer=~"$slo_set"}[5m]))',
        },
      ],
    },
  ],
});

test('checkDashboardPanelsReal: GOOD — valid JSON, panels carry real metric-name-bearing expressions', () => {
  assertOk(checkDashboardPanelsReal(DASHBOARD_GOOD), 'GOOD dashboard JSON');
});

test('checkDashboardPanelsReal: BAD — invalid JSON is rejected', () => {
  assertNotOk(
    checkDashboardPanelsReal('{ this is not valid json'),
    'invalid JSON must be rejected, not silently swallowed',
  );
});

test('checkDashboardPanelsReal: BAD — title decoy: correctly-titled panel with an empty/missing expr', () => {
  const dashboardJsonText = JSON.stringify({
    title: 'Monster Realm — RED & SLOs',
    panels: [{ title: 'Movement tick p95', targets: [{ expr: '' }] }],
  });
  assertNotOk(
    checkDashboardPanelsReal(dashboardJsonText),
    'a panel titled "Movement tick p95" with an empty query is a decoy — the title alone must not satisfy the check',
  );
});

test('checkDashboardPanelsReal: BAD — a non-empty expr that does not contain the required metric-name literal', () => {
  const dashboardJsonText = JSON.stringify({
    title: 'Monster Realm — RED & SLOs',
    panels: [{ title: 'Movement tick p95', targets: [{ expr: '1 + 1' }] }],
  });
  assertNotOk(
    checkDashboardPanelsReal(dashboardJsonText),
    'a non-empty but content-free expression must be rejected — the exact metric-name literal must appear',
  );
});

// NOTE (documented Tier-1 limitation, per the m20b tester brief): a NEUTERED-but-present
// expression such as `spacetime_txn_elapsed_time_sec_bucket * 0` or an always-false filter
// contains the required metric-name literal and would read GREEN under a purely static,
// text-based check. This is a KNOWN gap of the Tier-1 predicate, closable only by a live
// Tier-3 query against a running Grafana instance — it is deliberately NOT asserted against
// here, because no static-text predicate can distinguish "queries the real series" from
// "queries the real series and then multiplies it by zero." Do not add a fixture demanding
// this predicate reject `* 0` — it cannot, honestly, without becoming a live check.

test('checkDashboardPanelsReal: non-vacuity — valid JSON with zero panels is rejected', () => {
  assertNotOk(
    checkDashboardPanelsReal('{}'),
    'a dashboard with no panels key must not vacuously pass',
  );
  assertNotOk(
    checkDashboardPanelsReal(JSON.stringify({ panels: [] })),
    'a dashboard with zero panels must not vacuously pass',
  );
});

// =============================================================================
// 14. checkQueriedSeriesAreDefined(recordingRulesText, dashboardJsonText, alertRulesText,
//     hostNativeAllowlist) — plan §5b-B
// =============================================================================

const QSD_RECORDING_RULES_GOOD = [
  'groups:',
  '  - name: slo',
  '    rules:',
  '      - record: mr:reducer_success_ratio',
  '        expr: sum(rate(spacetime_num_txns_total{committed="true"}[5m])) / sum(rate(spacetime_num_txns_total[5m]))',
].join('\n');

const QSD_DASHBOARD_GOOD = JSON.stringify({
  panels: [
    { title: 'Reducer success SLO', targets: [{ expr: 'mr:reducer_success_ratio' }] },
    { title: 'Alloy up', targets: [{ expr: 'up{job="alloy"}' }] },
  ],
});

const QSD_ALERT_RULES_GOOD = [
  'groups:',
  '  - name: meta',
  '    rules:',
  '      - alert: AlloyDown',
  '        expr: up{job="alloy"} == 0',
].join('\n');

test('checkQueriedSeriesAreDefined: GOOD — every queried series is a defined record: or an allowlisted host-native name', () => {
  assertOk(
    checkQueriedSeriesAreDefined(
      QSD_RECORDING_RULES_GOOD,
      QSD_DASHBOARD_GOOD,
      QSD_ALERT_RULES_GOOD,
      HOST_NATIVE_ALLOWLIST,
    ),
    'GOOD — mr:reducer_success_ratio is recorded, up{...} is host-native-allowlisted',
  );
});

test('checkQueriedSeriesAreDefined: BAD — a dashboard panel queries a recorded-style name nothing records', () => {
  const dashboardJsonText = JSON.stringify({
    panels: [{ title: 'Ghost panel', targets: [{ expr: 'mr:ghost_metric_nobody_records' }] }],
  });
  assertNotOk(
    checkQueriedSeriesAreDefined(
      QSD_RECORDING_RULES_GOOD,
      dashboardJsonText,
      QSD_ALERT_RULES_GOOD,
      HOST_NATIVE_ALLOWLIST,
    ),
    'a panel querying mr:ghost_metric_nobody_records, which no record: defines and which is not host-native, must be rejected — two independently-green files otherwise ship a panel querying a series nothing emits',
  );
});

test('checkQueriedSeriesAreDefined: BAD — an alert rule queries an undefined recorded-style series', () => {
  const alertRulesText = [
    'groups:',
    '  - name: meta',
    '    rules:',
    '      - alert: GhostAlert',
    '        expr: mr:ghost_metric_nobody_records > 0',
  ].join('\n');
  assertNotOk(
    checkQueriedSeriesAreDefined(
      QSD_RECORDING_RULES_GOOD,
      QSD_DASHBOARD_GOOD,
      alertRulesText,
      HOST_NATIVE_ALLOWLIST,
    ),
    'an alert querying an undefined recorded series must be rejected',
  );
});

test('checkQueriedSeriesAreDefined: non-vacuity — nothing queried at all is rejected, not a vacuous pass', () => {
  assertNotOk(
    checkQueriedSeriesAreDefined(
      '',
      JSON.stringify({ panels: [] }),
      'groups: []',
      HOST_NATIVE_ALLOWLIST,
    ),
    'with zero panels and zero alert rules there is nothing to violate the invariant, but that must not read as green — nothing was actually checked',
  );
});

test('checkQueriedSeriesAreDefined: parameterization — hostNativeAllowlist is a real parameter, not hardcoded', () => {
  assertNotOk(
    checkQueriedSeriesAreDefined(
      QSD_RECORDING_RULES_GOOD,
      QSD_DASHBOARD_GOOD,
      QSD_ALERT_RULES_GOOD,
      [],
    ),
    'with an EMPTY allowlist, the previously-allowed up{...} reference must now be rejected — proves the allowlist argument is honored, not a hardcoded internal list',
  );
});

// =============================================================================
// 15. checkRetentionConfigured({ composeText, lokiText, tempoText }) — D11
// =============================================================================

const RETENTION_COMPOSE_GOOD = [
  'services:',
  '  prometheus:',
  '    command:',
  '      - --config.file=/etc/prometheus/prometheus.yml',
  '      - --storage.tsdb.retention.time=30d',
].join('\n');

const RETENTION_LOKI_GOOD = [
  'compactor:',
  '  retention_enabled: true',
  'limits_config:',
  '  retention_period: 30d',
].join('\n');

const RETENTION_TEMPO_GOOD = ['compactor:', '  compaction:', '    block_retention: 168h'].join(
  '\n',
);

test('checkRetentionConfigured: GOOD — Prometheus 30d flag, Loki retention_period + retention_enabled: true, Tempo block_retention', () => {
  assertOk(
    checkRetentionConfigured({
      composeText: RETENTION_COMPOSE_GOOD,
      lokiText: RETENTION_LOKI_GOOD,
      tempoText: RETENTION_TEMPO_GOOD,
    }),
    'GOOD full retention config across all three stores',
  );
});

test('checkRetentionConfigured: BAD — Loki retention_period WITHOUT compactor.retention_enabled: true is the documented no-op', () => {
  const lokiText = ['limits_config:', '  retention_period: 30d'].join('\n');
  assertNotOk(
    checkRetentionConfigured({
      composeText: RETENTION_COMPOSE_GOOD,
      lokiText,
      tempoText: RETENTION_TEMPO_GOOD,
    }),
    "retention_period without compactor.retention_enabled: true silently does nothing (default false) — D11's whole 30-day promise is a no-op here",
  );
});

test('checkRetentionConfigured: BAD — missing Prometheus --storage.tsdb.retention.time flag', () => {
  const composeText = [
    'services:',
    '  prometheus:',
    '    command:',
    '      - --config.file=/etc/prometheus/prometheus.yml',
  ].join('\n');
  assertNotOk(
    checkRetentionConfigured({
      composeText,
      lokiText: RETENTION_LOKI_GOOD,
      tempoText: RETENTION_TEMPO_GOOD,
    }),
    'Prometheus with no retention flag at all must be rejected',
  );
});

test('checkRetentionConfigured: BAD — missing Tempo block_retention', () => {
  const tempoText = ['compactor:', '  compaction:'].join('\n');
  assertNotOk(
    checkRetentionConfigured({
      composeText: RETENTION_COMPOSE_GOOD,
      lokiText: RETENTION_LOKI_GOOD,
      tempoText,
    }),
    'Tempo with no block_retention key must be rejected',
  );
});

test('checkRetentionConfigured: non-vacuity — all three inputs empty is rejected', () => {
  assertNotOk(
    checkRetentionConfigured({ composeText: '', lokiText: '', tempoText: '' }),
    'all-empty input must not vacuously pass',
  );
});

// =============================================================================
// 16. checkNoQuotedCredential(namedTexts) — [{ name, text }]
// =============================================================================

test('checkNoQuotedCredential: GOOD — env indirection and placeholder tokens only', () => {
  const namedTexts = [
    {
      name: 'docker-compose.yml',
      text: 'environment:\n  - GF_SECURITY_ADMIN_PASSWORD=${GF_SECURITY_ADMIN_PASSWORD}\n',
    },
    { name: 'Caddyfile', text: 'basicauth {\n  admin {env.MR_GRAFANA_BASIC_AUTH_HASH}\n}\n' },
    { name: 'observability-dr-runbook.md', text: 'export RESTIC_PASSWORD=<RESTIC_PASSWORD>\n' },
  ];
  assertOk(checkNoQuotedCredential(namedTexts), 'GOOD env-indirection-only credential usage');
});

test('checkNoQuotedCredential: BAD — a quoted credential-shaped literal is rejected', () => {
  const namedTexts = [
    { name: 'docker-compose.yml', text: 'environment:\n  - password: "somelongvalue12345"\n' },
  ];
  assertNotOk(checkNoQuotedCredential(namedTexts), 'a quoted password literal must be rejected');
});

test('checkNoQuotedCredential: BAD — the unquoted bash export form, which check-secrets.mjs misses, is rejected', () => {
  const namedTexts = [
    { name: 'observability-dr-runbook.md', text: 'export RESTIC_PASSWORD=hunter2value\n' },
  ];
  assertNotOk(
    checkNoQuotedCredential(namedTexts),
    "check-secrets.mjs's own pattern requires quotes, so export RESTIC_PASSWORD=hunter2value evades it entirely; this local check must not have the same gap",
  );
});

test('checkNoQuotedCredential: non-vacuity — an empty namedTexts array is rejected, not a vacuous "clean" pass', () => {
  assertNotOk(checkNoQuotedCredential([]), 'zero files scanned must not read as "clean"');
});

// =============================================================================
// 17. checkRunbookHasRunnableSteps(runbookText) — OBS-30/31/32/40
// =============================================================================

const RUNBOOK_GOOD = [
  '# Observability DR Runbook',
  '',
  '## Backup',
  '',
  '```sh',
  'restic backup --repo "$RESTIC_REPOSITORY" <data-dir>/replicas/*/{clog,snapshots} control-db/ program-bytes/',
  '```',
  '',
  'Backups are taken inside a brief stop-the-world window or an atomic filesystem snapshot; a live',
  'copy of an in-use commitlog file without one of these is NOT crash-consistent.',
  '',
  '## Restore drill / RTO',
  '',
  "RTO is derived from the host's own replay metrics, not estimated:",
  '',
  '```text',
  'spacetime_replay_total_time_seconds',
  'spacetime_replay_commitlog_time_seconds',
  'spacetime_replay_commitlog_num_commits',
  '```',
  '',
  '## Freshness check',
  '',
  'Most recent successful backup: 2026-08-08T03:00:00Z',
  '',
  "An alert or documented manual check fires when the most recent backup's age exceeds 2x the",
  'operator-configured backup interval.',
].join('\n');

test('checkRunbookHasRunnableSteps: GOOD — fenced restic step, fenced replay-metric literal, 2x rule, crash-consistency statement', () => {
  assertOk(
    checkRunbookHasRunnableSteps(RUNBOOK_GOOD),
    'GOOD runbook with all four runnable requirements',
  );
});

test('checkRunbookHasRunnableSteps: BAD — a commented-out restic step must FAIL after comment-stripping', () => {
  const runbookText = [
    '## Backup',
    '',
    '```sh',
    '# restic backup --repo "$RESTIC_REPOSITORY" <data-dir>/replicas/*/{clog,snapshots}',
    '```',
    '',
    'Backups are taken inside a brief stop-the-world window or an atomic filesystem snapshot; a live',
    'copy of an in-use commitlog file without one of these is NOT crash-consistent.',
    '',
    '```text',
    'spacetime_replay_total_time_seconds',
    '```',
    '',
    'Age exceeds 2x the operator-configured backup interval triggers an alert.',
  ].join('\n');
  assertNotOk(
    checkRunbookHasRunnableSteps(runbookText),
    'a `# restic backup ...` line still contains the substring but is commented out — comments must be stripped FIRST so a disabled step does not read as runnable',
  );
});

test('checkRunbookHasRunnableSteps: BAD — spacetime_replay_total_time_seconds only in prose, not a fenced block', () => {
  const runbookText = [
    '## Backup',
    '',
    '```sh',
    'restic backup --repo "$RESTIC_REPOSITORY" <data-dir>/replicas/*/{clog,snapshots}',
    '```',
    '',
    'Backups are taken inside a brief stop-the-world window or an atomic filesystem snapshot; a live',
    'copy of an in-use commitlog file without one of these is NOT crash-consistent.',
    '',
    'RTO is derived from spacetime_replay_total_time_seconds, measured directly by a restore drill.',
    '',
    'Age exceeds 2x the operator-configured backup interval triggers an alert.',
  ].join('\n');
  assertNotOk(
    checkRunbookHasRunnableSteps(runbookText),
    'the replay-metric literal must appear inside a FENCED code block, not merely in prose',
  );
});

test('checkRunbookHasRunnableSteps: BAD — missing the OBS-40 2x freshness rule', () => {
  const runbookText = [
    '## Backup',
    '',
    '```sh',
    'restic backup --repo "$RESTIC_REPOSITORY" <data-dir>/replicas/*/{clog,snapshots}',
    '```',
    '',
    'Backups are taken inside a brief stop-the-world window or an atomic filesystem snapshot; a live',
    'copy of an in-use commitlog file without one of these is NOT crash-consistent.',
    '',
    '```text',
    'spacetime_replay_total_time_seconds',
    '```',
    '',
    'Most recent successful backup: 2026-08-08T03:00:00Z',
  ].join('\n');
  assertNotOk(
    checkRunbookHasRunnableSteps(runbookText),
    "OBS-40's 2x-interval freshness rule must be present",
  );
});

test('checkRunbookHasRunnableSteps: BAD — missing the OBS-32 crash-consistency statement', () => {
  const runbookText = [
    '## Backup',
    '',
    '```sh',
    'restic backup --repo "$RESTIC_REPOSITORY" <data-dir>/replicas/*/{clog,snapshots}',
    '```',
    '',
    '```text',
    'spacetime_replay_total_time_seconds',
    '```',
    '',
    'Age exceeds 2x the operator-configured backup interval triggers an alert.',
  ].join('\n');
  assertNotOk(
    checkRunbookHasRunnableSteps(runbookText),
    'the OBS-32 statement that a live commitlog copy without a stop-the-world/snapshot is NOT crash-consistent must be present',
  );
});

test('checkRunbookHasRunnableSteps: non-vacuity — empty runbook text is rejected', () => {
  assertNotOk(checkRunbookHasRunnableSteps(''), 'empty runbook text must not vacuously pass');
});

// =============================================================================
// FINAL GROUP — every predicate against the REAL committed files.
// These stay RED until the implementer lands ops/observability/** and
// docs/observability-dr-runbook.md. This is the intended, honest RED state.
// =============================================================================

test('REAL FILES: checkNoAlertingBlock passes against ops/observability/prometheus.yml', () => {
  assertOk(checkNoAlertingBlock(readOps('prometheus.yml')), 'real prometheus.yml');
});

test('REAL FILES: checkRulesAreRecordOnly passes against ops/observability/rules/recording.rules.yml', () => {
  const text = readOps('rules/recording.rules.yml');
  assertOk(
    checkRulesAreRecordOnly([{ name: 'recording.rules.yml', text }]),
    'real recording.rules.yml',
  );
});

test('REAL FILES: checkServiceSetExact passes against ops/observability/docker-compose.yml (exact 7)', () => {
  const text = readOps('docker-compose.yml');
  assertOk(
    checkServiceSetExact(text, EXPECTED_SERVICE_NAMES),
    'real docker-compose.yml service set',
  );
});

test('REAL FILES: checkServiceImagesPinned passes against ops/observability/docker-compose.yml', () => {
  const text = readOps('docker-compose.yml');
  assertOk(checkServiceImagesPinned(text, PINNED_IMAGES), 'real docker-compose.yml pinned images');
});

test('REAL FILES: checkModuleLogsMountReadOnly passes against ops/observability/docker-compose.yml', () => {
  const text = readOps('docker-compose.yml');
  assertOk(checkModuleLogsMountReadOnly(text), 'real docker-compose.yml module_logs mount');
});

test('REAL FILES: checkListenAddrsLoopback passes against ops/observability/docker-compose.yml', () => {
  const text = readOps('docker-compose.yml');
  assertOk(checkListenAddrsLoopback(text), 'real docker-compose.yml listen addresses');
});

test('REAL FILES: checkNoExecLogSource passes against the real Alloy config + compose', () => {
  const alloyText = readOps('alloy/config.alloy');
  const composeText = readOps('docker-compose.yml');
  assertOk(checkNoExecLogSource(alloyText, composeText), 'real config.alloy + docker-compose.yml');
});

test('REAL FILES: checkStageMetricsLabelsBounded passes against the real Alloy config', () => {
  const alloyText = readOps('alloy/config.alloy');
  assertOk(
    checkStageMetricsLabelsBounded(alloyText, D12_ALLOWED_LABELS),
    'real config.alloy stage.metrics labels',
  );
});

test('REAL FILES: checkS4MetricLabelsBounded passes against the real Alloy config', () => {
  const alloyText = readOps('alloy/config.alloy');
  assertOk(checkS4MetricLabelsBounded(alloyText), 'real config.alloy S4 chain');
});

test('REAL FILES: checkRemoteWriteBothEnds passes against the real Alloy config + compose', () => {
  const alloyText = readOps('alloy/config.alloy');
  const composeText = readOps('docker-compose.yml');
  assertOk(
    checkRemoteWriteBothEnds(alloyText, composeText),
    'real config.alloy + docker-compose.yml remote-write wiring',
  );
});

test('REAL FILES: checkCaddyDualPosture passes against the real Caddyfile', () => {
  const caddyfileText = readOps('Caddyfile');
  assertOk(checkCaddyDualPosture(caddyfileText), 'real Caddyfile');
});

test('REAL FILES: checkAlertRuleHasReceiver passes against the real Grafana alerting provisioning', () => {
  const alertRulesText = readOps('grafana/provisioning/alerting/rules.yml');
  const contactPointsText = readOps('grafana/provisioning/alerting/contact-points.yml');
  const notificationPoliciesText = readOps(
    'grafana/provisioning/alerting/notification-policies.yml',
  );
  assertOk(
    checkAlertRuleHasReceiver(alertRulesText, contactPointsText, notificationPoliciesText),
    'real Grafana alerting provisioning',
  );
});

test('REAL FILES: checkDashboardPanelsReal passes against the real dashboard JSON', () => {
  const dashboardJsonText = readOps('grafana/dashboards/monster-realm.json');
  assertOk(checkDashboardPanelsReal(dashboardJsonText), 'real monster-realm.json dashboard');
});

test('REAL FILES: checkQueriedSeriesAreDefined passes across the real recording rules, dashboard, and alert rules', () => {
  const recordingRulesText = readOps('rules/recording.rules.yml');
  const dashboardJsonText = readOps('grafana/dashboards/monster-realm.json');
  const alertRulesText = readOps('grafana/provisioning/alerting/rules.yml');
  assertOk(
    checkQueriedSeriesAreDefined(
      recordingRulesText,
      dashboardJsonText,
      alertRulesText,
      HOST_NATIVE_ALLOWLIST,
    ),
    'real cross-file series-definition closure',
  );
});

test('REAL FILES: checkRetentionConfigured passes against the real compose, Loki, and Tempo config', () => {
  const composeText = readOps('docker-compose.yml');
  const lokiText = readOps('loki/loki-config.yml');
  const tempoText = readOps('tempo/tempo-config.yml');
  assertOk(checkRetentionConfigured({ composeText, lokiText, tempoText }), 'real retention config');
});

test('REAL FILES: checkNoQuotedCredential passes across every real ops/observability config file', () => {
  const namedTexts = [
    { name: 'docker-compose.yml', text: readOps('docker-compose.yml') },
    { name: 'prometheus.yml', text: readOps('prometheus.yml') },
    { name: 'alloy/config.alloy', text: readOps('alloy/config.alloy') },
    { name: 'Caddyfile', text: readOps('Caddyfile') },
    { name: 'loki/loki-config.yml', text: readOps('loki/loki-config.yml') },
    { name: 'tempo/tempo-config.yml', text: readOps('tempo/tempo-config.yml') },
    {
      name: 'grafana/provisioning/datasources/datasources.yml',
      text: readOps('grafana/provisioning/datasources/datasources.yml'),
    },
    {
      name: 'grafana/provisioning/alerting/contact-points.yml',
      text: readOps('grafana/provisioning/alerting/contact-points.yml'),
    },
    { name: 'observability-dr-runbook.md', text: readRepoRoot('docs/observability-dr-runbook.md') },
  ];
  assertOk(
    checkNoQuotedCredential(namedTexts),
    'zero quoted credentials across the real committed config',
  );
});

test('REAL FILES: checkRunbookHasRunnableSteps passes against the real docs/observability-dr-runbook.md', () => {
  const runbookText = readRepoRoot('docs/observability-dr-runbook.md');
  assertOk(checkRunbookHasRunnableSteps(runbookText), 'real observability-dr-runbook.md');
});
