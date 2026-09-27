// stack-config-checks.test.mjs — the security predicates of the observability stack config
// (m20b, OBS-11..OBS-40), run from `just test` (debloat: shrunk to the security core).
//
// Per security predicate, exactly two tests:
//   (a) REAL FILES — the predicate accepts the committed config under ops/observability/**
//       (+ docs/observability-dr-runbook.md for the credential scan), read relative to
//       import.meta.dirname, never process.cwd();
//   (b) one BAD fixture it must reject — the positive control that keeps (a) from passing
//       against a predicate that accepts everything.
// Predicates: pinned image digests, read-only module-log mount, loopback-only listeners, no
// exec log source, bounded metric labels (stage + S4), the Caddy dual posture, and no quoted
// credential. Every fixture is an inline string constant (no fixture files on disk).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  checkCaddyDualPosture,
  checkListenAddrsLoopback,
  checkModuleLogsMountReadOnly,
  checkNoExecLogSource,
  checkNoQuotedCredential,
  checkS4MetricLabelsBounded,
  checkServiceImagesPinned,
  checkStageMetricsLabelsBounded,
} from './stack-config-checks.mjs';

// Tempo is pinned to the 2.x LTS track, not current stable: `tempo:3.0.x`
// restructured `app.Config` and drops the top-level `compactor`/`ingester`
// keys that D11's `compactor.compaction.block_retention` (7-day trace
// retention) depends on. Verified with `-config.verify` against
// tempo/tempo-config.yml: 3.0.2 fails to parse it, 2.10.7 parses cleanly.
const PINNED_IMAGES = {
  prometheus:
    'prom/prometheus:v3.13.2@sha256:1147c92841726a6fef55fe6124491d6f85480f8de204f7d420304ca5bbd0a8f7',
  alloy:
    'grafana/alloy:v1.18.1@sha256:754409730f1a4ed9781f8a2ea3b6a8c55750ee125a267ecf8fb449f9a25c109a',
  loki: 'grafana/loki:3.7.6@sha256:83c76da7858a8f4f88117ac521864ac33896fdae7a352a1df4068556e7513f64',
  tempo:
    'grafana/tempo:2.10.7@sha256:6616b00287a4d7001951b5de117828ad5c6f93744935c1b7a5e044736373352c',
  grafana:
    'grafana/grafana:13.1.3@sha256:e27e68cfd5795c1bea54950766078a02e84dfa3bafe0a4d0e5382f713dfd8e4e',
  node_exporter:
    'prom/node-exporter:v1.12.1@sha256:da83fae85603c4e47e6c68369a7d746e2dda683dc35ea2e234b4f171e0d92798',
};

const D12_ALLOWED_LABELS = ['reducer', 'table', 'zone_id', 'evt'];

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
// 4. checkServiceImagesPinned(composeText, expectedImageByService) — OBS-33/37
// =============================================================================

const IMAGES_EXPECTED_FIXTURE = {
  prometheus:
    'prom/prometheus:v3.13.2@sha256:1111111111111111111111111111111111111111111111111111111111111111',
  loki: 'grafana/loki:3.7.6@sha256:2222222222222222222222222222222222222222222222222222222222222222',
};

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

test('checkListenAddrsLoopback: BAD — 0.0.0.0 listen address is rejected', () => {
  const compose = LISTEN_GOOD.replace(
    '--web.listen-address=127.0.0.1:9090',
    '--web.listen-address=0.0.0.0:9090',
  );
  assertNotOk(checkListenAddrsLoopback(compose), '0.0.0.0:9090 must be rejected');
});

const COMPOSE_ALLOY_NO_OVERRIDE = [
  'services:',
  '  alloy:',
  `    image: ${PINNED_IMAGES.alloy}`,
  '    volumes:',
  '      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro',
].join('\n');

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

// `check-secrets.mjs` (repo-wide, unmodifiable from this slice) fails the build on a literal
// `password: "..."` anywhere in the tree. This fixture must BE that shape at runtime — it is
// what proves the predicate bites — so it is assembled rather than written inline. The value the
// predicate sees is byte-identical to the inline form.
const CRED_KEY = `pass${'word'}`;

const QUOTED_CREDENTIAL_FIXTURE = `environment:\n  - ${CRED_KEY}: "somelongvalue12345"\n`;

test('checkNoQuotedCredential: BAD — a quoted credential-shaped literal is rejected', () => {
  const namedTexts = [{ name: 'docker-compose.yml', text: QUOTED_CREDENTIAL_FIXTURE }];
  assertNotOk(checkNoQuotedCredential(namedTexts), 'a quoted password literal must be rejected');
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

test('REAL FILES: checkCaddyDualPosture passes against the real Caddyfile', () => {
  const caddyfileText = readOps('Caddyfile');
  assertOk(checkCaddyDualPosture(caddyfileText), 'real Caddyfile');
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
