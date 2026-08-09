// stack-config-checks.mjs — pure, text-in predicates gating ops/observability/** (m20b).
//
// Every export is a PURE function over TEXT (never a path) returning
// `{ ok: boolean, detail: string }` with a non-empty detail. Fixtures and real files therefore
// share one code path, which is what makes the proof-of-teeth in the sibling test file real.
//
// This module is the SSOT m20e's `evals/observability-stack-config.eval.mjs` (G6/G9) imports
// rather than re-implements — the same relationship `evals/playtest-verify.eval.mjs` has to
// `scripts/verify-*.mjs`.
//
// Discipline (CI-enforced — see the m20b plan §2):
//   - NO `new RegExp(...)` anywhere. Literal regex literals and String methods only; the remote
//     Semgrep `detect-non-literal-regexp` gate has red-ed this repo 3x.
//   - Non-vacuity is a first-class requirement: scanning nothing is NEVER green. Every predicate
//     that could pass by absence instead fails, and says so in its detail.

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const fail = (detail) => ({ ok: false, detail });
const pass = (detail) => ({ ok: true, detail });

/**
 * Strip comments before any scan: `#` outside quotes (YAML, Caddyfile) and WHOLE-LINE `//`
 * (Alloy/River). Only leading `//` is treated as a comment, never mid-line — `http://host` must
 * survive. This matters structurally, not just cosmetically: an Alloy comment containing a brace
 * (e.g. a documented sample log line) would otherwise be parsed as a block header and corrupt
 * every subsequent brace-depth calculation.
 */
function stripComments(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('//')) {
      out.push('');
      continue;
    }
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

const isBlank = (text) => typeof text !== 'string' || text.trim().length === 0;

/**
 * Service names declared under a compose `services:` key: exactly two-space indent, a name, a
 * colon. Returns [] when there is no `services:` key or it has no entries.
 */
function composeServiceNames(composeText) {
  const lines = stripComments(composeText).split('\n');
  const start = lines.findIndex((l) => l.startsWith('services:'));
  if (start === -1) return [];
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    // A new column-0 key ends the services block.
    if (!line.startsWith(' ')) break;
    const m = line.match(/^ {2}([a-z0-9][a-z0-9_-]*):\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
}

/** The raw lines belonging to one compose service block (everything more-indented than its key). */
function composeServiceBlock(composeText, serviceName) {
  const lines = stripComments(composeText).split('\n');
  const header = `  ${serviceName}:`;
  const start = lines.findIndex((l) => l.trimEnd() === header);
  if (start === -1) return [];
  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (!line.startsWith('    ')) break;
    block.push(line);
  }
  return block;
}

/** Brace-delimited blocks whose header line sits at column 0 (Caddyfile sites, Alloy components). */
function topLevelBlocks(text) {
  const lines = stripComments(text).split('\n');
  const blocks = [];
  let current = null;
  let depth = 0;
  for (const line of lines) {
    if (current === null) {
      if (line.length > 0 && !line.startsWith(' ') && line.includes('{')) {
        current = { header: line.slice(0, line.indexOf('{')).trim(), body: [] };
        depth = 1;
      }
      continue;
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth <= 0) {
      blocks.push(current);
      current = null;
      depth = 0;
    } else {
      current.body.push(line);
    }
  }
  return blocks;
}

/** Fenced ``` blocks in a markdown document, as arrays of their inner lines. */
function fencedBlocks(markdown) {
  const blocks = [];
  let inside = false;
  let current = [];
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (inside) {
        blocks.push(current);
        current = [];
      }
      inside = !inside;
      continue;
    }
    if (inside) current.push(line);
  }
  return blocks;
}

const PROMQL_KEYWORDS = new Set([
  'sum',
  'rate',
  'irate',
  'increase',
  'avg',
  'min',
  'max',
  'count',
  'count_values',
  'stddev',
  'stdvar',
  'topk',
  'bottomk',
  'quantile',
  'histogram_quantile',
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'offset',
  'bool',
  'and',
  'or',
  'unless',
  'le',
  'delta',
  'deriv',
  'predict_linear',
  'abs',
  'ceil',
  'floor',
  'round',
  'scalar',
  'vector',
  'time',
  'changes',
  'resets',
  'absent',
  'absent_over_time',
  'clamp',
  'clamp_max',
  'clamp_min',
  'label_replace',
  'label_join',
  'sum_over_time',
  'avg_over_time',
  'max_over_time',
  'min_over_time',
  'count_over_time',
  'last_over_time',
  'present_over_time',
  'stddev_over_time',
  'sort',
  'sort_desc',
  'ln',
  'log2',
  'log10',
  'exp',
  'sqrt',
  'sgn',
  'timestamp',
  'group',
  'm',
  's',
  'h',
  'd',
  'w',
  'y',
]);

/** Metric identifiers referenced by a PromQL expression, with matchers/durations/strings removed. */
function promqlIdentifiers(expr) {
  const withoutStrings = expr.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  const withoutMatchers = withoutStrings.replace(/\{[^}]*\}/g, ' ');
  const withoutDurations = withoutMatchers.replace(/\[[^\]]*\]/g, ' ');
  const tokens = withoutDurations.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) || [];
  return tokens.filter((t) => !PROMQL_KEYWORDS.has(t));
}

/** Every non-empty `expr` string in a Grafana dashboard JSON's panel targets. */
function dashboardExprs(dashboard) {
  const exprs = [];
  for (const panel of dashboard.panels || []) {
    for (const target of panel.targets || []) {
      if (typeof target.expr === 'string' && target.expr.trim().length > 0) exprs.push(target.expr);
    }
  }
  return exprs;
}

/** `expr:` values from a Prometheus/Grafana rules YAML document. */
function yamlExprValues(text) {
  const exprs = [];
  for (const line of stripComments(text).split('\n')) {
    const m = line.match(/^\s*expr:\s*(.+)$/);
    if (m) exprs.push(m[1].trim());
  }
  return exprs;
}

/** Parse a byte size such as `2MB`, `512KB`, or a bare byte count. Returns NaN if unparseable. */
function parseByteSize(raw) {
  const m = raw.trim().match(/^([0-9]+)\s*([kKmMgG]?)[bB]?$/);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'k') return n * 1024;
  if (unit === 'm') return n * 1024 * 1024;
  if (unit === 'g') return n * 1024 * 1024 * 1024;
  return n;
}

// A rate limit looser than this is functionally unlimited for a single-operator game backend,
// and a body cap larger than this defeats the point of having one (D5 / red-team M4).
const MAX_SANE_RATE_EVENTS = 10_000;
const MAX_SANE_BODY_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 1. OBS-18 — prometheus.yml carries no `alerting:` block
// ---------------------------------------------------------------------------
export function checkNoAlertingBlock(prometheusYmlText) {
  if (isBlank(prometheusYmlText)) {
    return fail('prometheus.yml text is empty — nothing was scanned, which is never green');
  }
  const lines = stripComments(prometheusYmlText).split('\n');
  if (!lines.some((l) => l.startsWith('scrape_configs:'))) {
    return fail('no `scrape_configs:` key — this does not look like a Prometheus config');
  }
  const offender = lines.findIndex((l) => l.startsWith('alerting:'));
  if (offender !== -1) {
    return fail(`OBS-18: a column-0 \`alerting:\` block is present at line ${offender + 1}`);
  }
  return pass('OBS-18: no `alerting:` block (comments and rule_files paths correctly ignored)');
}

// ---------------------------------------------------------------------------
// 2. OBS-18 — every rule_files-loaded document is record-only
// ---------------------------------------------------------------------------
export function checkRulesAreRecordOnly(ruleFiles) {
  if (!Array.isArray(ruleFiles) || ruleFiles.length === 0) {
    return fail('zero rule files supplied — nothing was scanned, which is never green');
  }
  for (const { name, text } of ruleFiles) {
    if (isBlank(text)) return fail(`rule file ${name} is empty — cannot confirm it is record-only`);
    const lines = stripComments(text).split('\n');
    const alertLine = lines.findIndex((l) => {
      const t = l.trim();
      return t.startsWith('- alert:') || t.startsWith('alert:');
    });
    if (alertLine !== -1) {
      return fail(`OBS-18: ${name} line ${alertLine + 1} carries an \`alert:\` stanza`);
    }
    const records = lines.filter((l) => l.trim().startsWith('- record:')).length;
    if (records === 0) {
      return fail(
        `OBS-18: ${name} declares zero \`record:\` rules — an empty file satisfies ` +
          '"no alert: stanza" vacuously and must not read as green',
      );
    }
  }
  return pass(`OBS-18: ${ruleFiles.length} rule file(s), all record-only with >=1 real record:`);
}

// ---------------------------------------------------------------------------
// 3. OBS-19/37, D3 — the compose service set is EXACTLY the declared set
// ---------------------------------------------------------------------------
export function checkServiceSetExact(composeText, expectedServiceNames) {
  if (!Array.isArray(expectedServiceNames) || expectedServiceNames.length === 0) {
    return fail('the expected service-name set is empty — nothing to compare against');
  }
  const actual = composeServiceNames(composeText);
  if (actual.length === 0) {
    return fail('docker-compose.yml declares zero services — nothing was scanned');
  }
  const expected = new Set(expectedServiceNames);
  const found = new Set(actual);
  const extra = actual.filter((n) => !expected.has(n));
  const missing = expectedServiceNames.filter((n) => !found.has(n));
  if (extra.length > 0 || missing.length > 0) {
    return fail(
      `OBS-19/OBS-37: service set mismatch — unexpected [${extra.join(', ')}], ` +
        `missing [${missing.join(', ')}] (set equality, not a count: a substitution keeps the ` +
        'count identical)',
    );
  }
  return pass(`OBS-19/OBS-37: exact service set of ${actual.length}: ${actual.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 4. OBS-33/37 — images are the pinned, digest-anchored, stock vendor images
// ---------------------------------------------------------------------------
export function checkServiceImagesPinned(composeText, expectedImageByService) {
  const expectedEntries = Object.entries(expectedImageByService || {});
  if (expectedEntries.length === 0) {
    return fail('the expected image map is empty — nothing to check, which is never green');
  }
  for (const [service, expectedImage] of expectedEntries) {
    const block = composeServiceBlock(composeText, service);
    const imageLine = block.find((l) => l.trim().startsWith('image:'));
    if (!imageLine) return fail(`service \`${service}\` declares no image:`);
    const actual = imageLine.slice(imageLine.indexOf('image:') + 6).trim();
    if (actual !== expectedImage) {
      return fail(
        `OBS-33/OBS-37: service \`${service}\` runs \`${actual}\`, expected \`${expectedImage}\` ` +
          '— a name-only check would miss a banned tool running under an expected service name',
      );
    }
  }
  // Any image anywhere must be digest-pinned; `latest` is never acceptable.
  for (const line of stripComments(composeText).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('image:')) continue;
    const value = t.slice(6).trim();
    if (value.endsWith(':latest')) return fail(`OBS-33: unpinned \`:latest\` image \`${value}\``);
    if (!value.includes('@sha256:')) {
      return fail(`OBS-33: image \`${value}\` is not digest-pinned (no @sha256:)`);
    }
  }
  return pass(`OBS-33/OBS-37: ${expectedEntries.length} image(s) match their pinned digests`);
}

// ---------------------------------------------------------------------------
// 5. OBS-11/45 — the module_logs bind mount is POSITIVELY read-only
// ---------------------------------------------------------------------------
export function checkModuleLogsMountReadOnly(composeText) {
  if (isBlank(composeText)) return fail('compose text is empty — nothing was scanned');
  const lines = stripComments(composeText).split('\n');
  let found = 0;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    // Long form: `- type: bind` followed by source/target/read_only keys.
    if (t === '- type: bind') {
      const group = [];
      for (let j = i + 1; j < lines.length; j++) {
        const inner = lines[j].trim();
        if (inner.length === 0) continue;
        if (inner.startsWith('- ') || !lines[j].startsWith(' ')) break;
        group.push(inner);
      }
      const source = group.find((g) => g.startsWith('source:')) || '';
      if (!source.includes('replicas')) continue;
      found++;
      if (!group.some((g) => g === 'read_only: true')) {
        return fail(
          'OBS-11/OBS-45: the long-form module_logs bind mount has no `read_only: true` — ' +
            'long-form syntax contains neither `:ro` nor `:rw`, so a reject-`:rw` check would ' +
            'pass this writable mount by omission',
        );
      }
      continue;
    }

    // Short form: `- <host>:<container>[:mode]`
    if (!t.startsWith('- ') || !t.includes('replicas') || t.includes('type:')) continue;
    found++;
    if (!t.endsWith(':ro')) {
      return fail(
        `OBS-11/OBS-45: module_logs mount \`${t}\` is not \`:ro\` (a bare mount defaults to ` +
          'read-write in Docker)',
      );
    }
  }

  if (found === 0) {
    return fail(
      'OBS-11/OBS-45: no module_logs/replicas bind mount found at all — the read-only property ' +
        'cannot be positively confirmed, so this must not pass',
    );
  }
  return pass(`OBS-11/OBS-45: ${found} module_logs bind mount(s), all positively read-only`);
}

// ---------------------------------------------------------------------------
// 6. OQ1/OBS-17 — every listener binds loopback (plan §5b-A: network_mode host)
// ---------------------------------------------------------------------------
const LISTEN_FLAGS = [
  '--web.listen-address=',
  '--server.http.listen-addr=',
  '-server.http-listen-address=',
  'GF_SERVER_HTTP_ADDR=',
  'MR_CADDY_BIND_ADDR=',
];

export function checkListenAddrsLoopback(composeText) {
  const services = composeServiceNames(composeText);
  if (services.length === 0) {
    return fail('docker-compose.yml declares zero services — binding cannot be confirmed');
  }
  const portsLine = stripComments(composeText)
    .split('\n')
    .findIndex((l) => l.trim().startsWith('ports:'));
  if (portsLine !== -1) {
    return fail(
      `a \`ports:\` key is present at line ${portsLine + 1} — under \`network_mode: host\` it is ` +
        'silently inert, so it is false comfort rather than a real control (plan §5b-A/B)',
    );
  }

  for (const service of services) {
    const block = composeServiceBlock(composeText, service);
    const blockText = block.join('\n');
    if (!blockText.includes('network_mode: host')) {
      return fail(`service \`${service}\` does not declare \`network_mode: host\``);
    }
    const bindings = [];
    for (const flag of LISTEN_FLAGS) {
      let idx = blockText.indexOf(flag);
      while (idx !== -1) {
        const rest = blockText.slice(idx + flag.length);
        bindings.push(
          rest
            .split('\n')[0]
            .trim()
            .replace(/^["']|["']$/g, ''),
        );
        idx = blockText.indexOf(flag, idx + flag.length);
      }
    }
    if (bindings.length === 0) {
      return fail(
        `OBS-17: service \`${service}\` declares no listen-address flag at all — every upstream ` +
          'default here is 0.0.0.0, so silence is the trap and must FAIL, not pass',
      );
    }
    for (const bind of bindings) {
      if (!bind.startsWith('127.0.0.1')) {
        return fail(
          `OBS-17: service \`${service}\` binds \`${bind}\`, which is not loopback — OQ1 fixes ` +
            'this deployment as local-only',
        );
      }
    }
  }
  return pass(
    `OBS-17: all ${services.length} services declare network_mode: host and bind 127.0.0.1 only`,
  );
}

// ---------------------------------------------------------------------------
// 7. OBS-11 — logs are file-tailed, never sourced from a subprocess
// ---------------------------------------------------------------------------
const SHELL_MARKERS = ['/bin/sh', '/bin/bash', 'sh -c', 'bash -c', 'tail -F', 'tail -f', ' | '];

export function checkNoExecLogSource(rawAlloyText, composeText) {
  const alloyText = stripComments(rawAlloyText || '');
  if (isBlank(alloyText) || !alloyText.includes('loki.source.file')) {
    return fail(
      'OBS-11: no `loki.source.file` component found — the file-tail source cannot be positively ' +
        'confirmed, so this must not pass',
    );
  }
  if (alloyText.includes('loki.source.exec')) {
    return fail('OBS-11: a `loki.source.exec` subprocess log source is configured');
  }
  const alloyBlock = composeServiceBlock(composeText, 'alloy').join('\n');
  const hasOverride = alloyBlock.includes('entrypoint:') || alloyBlock.includes('command:');
  if (hasOverride) {
    const marker = SHELL_MARKERS.find((m) => alloyBlock.includes(m));
    if (marker) {
      return fail(
        `OBS-11: the alloy service's command/entrypoint override contains \`${marker}\` — a ` +
          'shell pipeline there achieves the banned subprocess log tail OUTSIDE config.alloy',
      );
    }
  }
  return pass('OBS-11: loki.source.file tail only; no exec source and no shell-pipeline override');
}

// ---------------------------------------------------------------------------
// 8. OBS-12/36, D12 — S2 stage.metrics labels are a bounded enum with literal sources
// ---------------------------------------------------------------------------
function alloyValuesBlockKeys(text, blockName, mapKeyword) {
  // Collects across EVERY occurrence of the block: a correct pipeline routinely parses a nested
  // envelope with more than one `stage.json` (outer host envelope, then the module payload
  // inside `message`), so reading only the first block would reject a correct two-stage parse.
  const keys = [];
  let found = false;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(blockName, from);
    if (idx === -1) break;
    from = idx + blockName.length;
    const valuesIdx = text.indexOf(mapKeyword, idx);
    if (valuesIdx === -1) continue;
    const open = text.indexOf('{', valuesIdx);
    const close = text.indexOf('}', open);
    if (open === -1 || close === -1) continue;
    found = true;
    const body = text.slice(open + 1, close);
    for (const k of body.match(/[a-zA-Z_][a-zA-Z0-9_]*(?=\s*=)/g) || []) {
      if (k !== 'values' && k !== 'expressions') keys.push(k);
    }
  }
  return found ? keys : null;
}

export function checkStageMetricsLabelsBounded(rawAlloyText, allowedLabels) {
  if (isBlank(rawAlloyText)) return fail('Alloy config text is empty — nothing was scanned');
  const alloyText = stripComments(rawAlloyText);
  if (!alloyText.includes('stage.metrics')) {
    return fail('OBS-12: no `stage.metrics` block found — the derivation cannot be confirmed');
  }
  const labels = alloyValuesBlockKeys(alloyText, 'stage.labels', 'values');
  if (labels === null || labels.length === 0) {
    return fail(
      'OBS-36: `stage.labels` declares zero labels — a zero-label block vacuously satisfies ' +
        '"no unbounded label"; a bounded label must be positively present',
    );
  }
  const allowed = new Set(allowedLabels || []);
  const offender = labels.find((l) => !allowed.has(l));
  if (offender) {
    return fail(
      `OBS-36/D12: label \`${offender}\` is outside the bounded enum ` +
        `[${[...allowed].join(', ')}] — an unbounded label is one series per distinct value`,
    );
  }
  if (alloyText.includes('stage.regex')) {
    return fail(
      'OBS-36/D12: a `stage.regex` block is present — a correctly-NAMED label sourced from a ' +
        'free-form capture group still has unbounded VALUES; labels must come from a literal ' +
        'stage.json field mapping',
    );
  }
  const jsonKeys = alloyValuesBlockKeys(alloyText, 'stage.json', 'expressions') || [];
  const jsonSet = new Set(jsonKeys);
  const unsourced = labels.find((l) => !jsonSet.has(l));
  if (unsourced) {
    return fail(
      `OBS-36/D12: label \`${unsourced}\` is not extracted by a literal \`stage.json\` field ` +
        'mapping — its value source is unbounded',
    );
  }
  return pass(
    `OBS-12/OBS-36: bounded labels [${labels.join(', ')}], all literal stage.json fields`,
  );
}

// ---------------------------------------------------------------------------
// 9. OBS-34 (plan §5b-B) — the PUBLIC S4 OTLP path has a metric-label allowlist
// ---------------------------------------------------------------------------
// Both are genuine allowlist mechanisms: `attributes` filters keys by action, `transform` does
// it via OTTL `keep_matching_keys`. Accepting either recognizes a second correct implementation
// — it does NOT weaken the check, because a chain with no filter component at all still fails.

// ---------------------------------------------------------------------------
const S4_FILTER_COMPONENTS = ['otelcol.processor.attributes', 'otelcol.processor.transform'];

export function checkS4MetricLabelsBounded(rawAlloyText) {
  if (isBlank(rawAlloyText)) return fail('Alloy config text is empty — nothing was scanned');
  const alloyText = stripComments(rawAlloyText);
  const hasReceiver = alloyText.includes('otelcol.receiver.otlp');
  const hasExporter = alloyText.includes('otelcol.exporter.prometheus');
  const hasRemoteWrite = alloyText.includes('prometheus.remote_write');
  if (!hasReceiver || !hasExporter || !hasRemoteWrite) {
    return fail(
      'OBS-34: the S4 chain (otlp receiver -> prometheus exporter -> remote_write) is not fully ' +
        'present, so the filtered property cannot be positively confirmed',
    );
  }
  const filterComponent = S4_FILTER_COMPONENTS.find((c) => alloyText.includes(c));
  if (!filterComponent) {
    return fail(
      'OBS-34: no attribute-allowlist processor on the S4 path — the public, ' +
        'unauthenticated OTLP ingest converts caller-chosen attributes 1:1 into Prometheus ' +
        'labels, so one curl loop with a distinct attribute per request grows active series ' +
        'without bound until Prometheus OOMs (red-team C3)',
    );
  }
  const receiverBlock = topLevelBlocks(alloyText).find((b) =>
    b.header.startsWith('otelcol.receiver.otlp'),
  );
  const receiverBody = receiverBlock ? receiverBlock.body.join('\n') : '';
  if (!receiverBody.includes(filterComponent)) {
    return fail(
      'OBS-34: the attributes filter exists but the OTLP receiver does not forward metrics into ' +
        'it — an unwired filter is not a control (co-occurrence is not wiring)',
    );
  }
  return pass('OBS-34: S4 metrics pass through a wired attribute allowlist before storage');
}

// ---------------------------------------------------------------------------
// 10. OBS-38 — remote-write is wired at BOTH ends, by name resolution
// ---------------------------------------------------------------------------
export function checkRemoteWriteBothEnds(rawAlloyText, composeText) {
  const alloyText = stripComments(rawAlloyText || '');
  if (isBlank(alloyText) || isBlank(composeText)) {
    return fail('OBS-38: Alloy and/or compose text is empty — nothing was scanned');
  }
  if (!composeText.includes('--web.enable-remote-write-receiver')) {
    return fail(
      'OBS-38: Prometheus does not enable `--web.enable-remote-write-receiver`, so S4 metrics ' +
        'have nowhere to land',
    );
  }
  const needle = 'forward_to = [prometheus.remote_write.';
  const idx = alloyText.indexOf(needle);
  if (idx === -1) {
    return fail(
      'OBS-38: no `forward_to = [prometheus.remote_write...]` wiring in the Alloy config',
    );
  }
  const rest = alloyText.slice(idx + needle.length);
  const label = rest.slice(0, rest.indexOf('.receiver'));
  if (!alloyText.includes(`prometheus.remote_write "${label}"`)) {
    return fail(
      `OBS-38: forward_to targets \`prometheus.remote_write.${label}\` but no component named ` +
        `\`${label}\` is declared — the flag and the component merely CO-OCCUR; wiring must ` +
        'name-resolve',
    );
  }
  return pass(`OBS-38: receiver flag set and forward_to name-resolves to remote_write "${label}"`);
}

// ---------------------------------------------------------------------------
// 11. OBS-20/21, D5 — Caddy's two routes carry two DIFFERENT policies
// ---------------------------------------------------------------------------
const AUTH_MARKERS = ['basic_auth', 'basicauth', 'forward_auth', 'jwt'];

export function checkCaddyDualPosture(caddyfileText) {
  if (isBlank(caddyfileText)) return fail('Caddyfile text is empty — nothing was scanned');
  const sites = topLevelBlocks(caddyfileText).filter((b) => b.header.length > 0);
  const grafana = sites.find((b) => b.header.includes('grafana'));
  const otlp = sites.find((b) => b.header.includes('otlp'));
  if (!grafana || !otlp) {
    return fail(
      'D5: could not find both a `grafana` site block and an `otlp` site block — the dual ' +
        'posture cannot be confirmed (a global-options-only file asserts nothing)',
    );
  }
  const grafanaBody = grafana.body.join('\n');
  const otlpBody = otlp.body.join('\n');

  if (!AUTH_MARKERS.some((m) => grafanaBody.includes(m))) {
    return fail('OBS-20: the Grafana route has no authentication directive (operator-only route)');
  }
  const otlpAuth = AUTH_MARKERS.find((m) => otlpBody.includes(m));
  if (otlpAuth) {
    return fail(
      `OBS-21: the OTLP ingest route carries \`${otlpAuth}\` — an anonymous game client ` +
        'structurally cannot present a login, so this route must NOT require authentication',
    );
  }
  if (!grafanaBody.includes('tls') || !otlpBody.includes('tls')) {
    return fail('OBS-20/OBS-21: both routes must require TLS');
  }
  if (!otlpBody.includes('Access-Control-Allow-Origin')) {
    return fail('OBS-21: the OTLP route declares no CORS origin scoping');
  }
  if (!otlpBody.includes('rate_limit')) {
    return fail(
      'OBS-21: the OTLP route has no `rate_limit` — CORS is browser-enforced only, so a direct ' +
        'scripted client simply omits the Origin header; the rate limit is the actual control',
    );
  }
  if (!otlpBody.includes('max_size')) {
    return fail('OBS-21: the OTLP route declares no `request_body { max_size ... }` cap');
  }

  const events = otlpBody.match(/events\s+([0-9]+)/);
  const maxSize = otlpBody.match(/max_size\s+([0-9]+\s*[kKmMgG]?[bB]?)/);
  if (!events || !maxSize) {
    return fail('OBS-21: could not read the rate-limit `events` and/or `max_size` values');
  }
  if (Number(events[1]) > MAX_SANE_RATE_EVENTS) {
    return fail(
      `OBS-21: rate limit of ${events[1]} events is structurally present but functionally ` +
        `unlimited (ceiling ${MAX_SANE_RATE_EVENTS}) — presence is not a control`,
    );
  }
  const bytes = parseByteSize(maxSize[1]);
  if (!Number.isFinite(bytes) || bytes > MAX_SANE_BODY_BYTES) {
    return fail(
      `OBS-21: body cap \`${maxSize[1]}\` is functionally unlimited (ceiling ` +
        `${MAX_SANE_BODY_BYTES} bytes)`,
    );
  }
  return pass(
    `OBS-20/OBS-21: Grafana route authed; OTLP route anonymous with CORS, ${events[1]} ` +
      `events/window and a ${maxSize[1]} body cap`,
  );
}

// ---------------------------------------------------------------------------
// 12. OBS-39, D4 — every alert routes to a receiver that actually notifies someone
// ---------------------------------------------------------------------------
export function checkAlertRuleHasReceiver(alertRulesText, contactPointsText, policiesText) {
  if (isBlank(alertRulesText) || isBlank(contactPointsText) || isBlank(policiesText)) {
    return fail('D4: alerting provisioning text is empty — nothing was scanned');
  }
  const ruleLines = stripComments(alertRulesText).split('\n');
  const ruleCount = ruleLines.filter((l) => {
    const t = l.trim();
    return t.startsWith('- uid:') || t.startsWith('- title:');
  }).length;
  if (ruleCount === 0) {
    return fail(
      'D4: zero alert rules declared — "every rule routes to a live receiver" is unverifiable ' +
        'and must not read as green',
    );
  }

  const contactNames = new Set();
  for (const line of stripComments(contactPointsText).split('\n')) {
    const m = line.match(/^\s*-?\s*name:\s*(\S+)\s*$/);
    if (m) contactNames.add(m[1]);
  }
  if (contactNames.size === 0) return fail('D4: no contact points are defined');

  if (stripComments(contactPointsText).includes('receivers: []')) {
    return fail(
      'D4: a contact point declares `receivers: []` — it structurally exists but notifies ' +
        'nobody, which is the same failure in disguise',
    );
  }
  const recipients = [];
  for (const line of stripComments(contactPointsText).split('\n')) {
    const m = line.match(/^\s*(url|addresses):\s*(.+)$/);
    if (m) recipients.push(m[2].trim().replace(/^["']|["']$/g, ''));
  }
  if (recipients.length === 0) {
    return fail('D4: no contact point declares a `url:` or `addresses:` recipient');
  }
  const placeholder = recipients.find(
    (r) => r.length === 0 || r.includes('<') || r.includes('CHANGE') || r === '[]',
  );
  if (placeholder !== undefined) {
    return fail(`D4: contact-point recipient \`${placeholder}\` is a placeholder, not a recipient`);
  }

  const routed = [];
  for (const line of stripComments(policiesText).split('\n')) {
    const m = line.match(/^\s*-?\s*receiver:\s*(\S+)\s*$/);
    if (m) routed.push(m[1]);
  }
  if (routed.length === 0) return fail('D4: notification policies route to no receiver at all');
  const dangling = routed.find((r) => !contactNames.has(r));
  if (dangling) {
    return fail(
      `D4: notification policy routes to \`${dangling}\`, which is not a defined contact point ` +
        '— the alert evaluates into nothing',
    );
  }
  return pass(`D4: ${ruleCount} alert rule(s) route to defined, non-placeholder contact points`);
}

// ---------------------------------------------------------------------------
// 13. OBS-22..26/28 — dashboard panels carry real queries, not title decoys
// ---------------------------------------------------------------------------
const METRIC_MARKERS = ['spacetime_', 'node_', 'mr:', 'up{', 'up ', 'alloy_', 'loki_', 'promhttp_'];

export function checkDashboardPanelsReal(dashboardJsonText) {
  if (isBlank(dashboardJsonText)) return fail('dashboard JSON text is empty — nothing was scanned');
  let dashboard;
  try {
    dashboard = JSON.parse(dashboardJsonText);
  } catch (err) {
    return fail(`dashboard JSON does not parse: ${err.message}`);
  }
  const panels = dashboard.panels || [];
  if (panels.length === 0) {
    return fail('OBS-22..26: the dashboard declares zero panels — nothing was scanned');
  }
  for (const panel of panels) {
    const title = panel.title || '(untitled)';
    const exprs = (panel.targets || [])
      .map((t) => (typeof t.expr === 'string' ? t.expr.trim() : ''))
      .filter((e) => e.length > 0);
    if (exprs.length === 0) {
      return fail(
        `OBS-22..26: panel "${title}" has no non-empty query — a correctly-titled panel with an ` +
          'empty expr is a decoy; the title alone must not satisfy the check',
      );
    }
    const hasMetric = exprs.some((e) => METRIC_MARKERS.some((m) => e.includes(m)));
    if (!hasMetric) {
      return fail(
        `OBS-22..26: panel "${title}" queries no recognizable metric name — a non-empty but ` +
          'content-free expression is not a real panel',
      );
    }
  }
  return pass(`OBS-22..26: ${panels.length} panel(s), each with a real metric-bearing query`);
}

// ---------------------------------------------------------------------------
// 14. Cross-file (plan §5b-B) — nothing queries a series no rule defines
// ---------------------------------------------------------------------------
export function checkQueriedSeriesAreDefined(
  recordingRulesText,
  dashboardJsonText,
  alertRulesText,
  hostNativeAllowlist,
) {
  const recorded = new Set();
  for (const line of stripComments(recordingRulesText || '').split('\n')) {
    const m = line.match(/^\s*-\s*record:\s*(\S+)\s*$/);
    if (m) recorded.add(m[1]);
  }

  const exprs = [];
  try {
    exprs.push(...dashboardExprs(JSON.parse(dashboardJsonText || '{}')));
  } catch (err) {
    return fail(`dashboard JSON does not parse: ${err.message}`);
  }
  exprs.push(...yamlExprValues(alertRulesText || ''));

  const queried = new Set();
  for (const expr of exprs) for (const id of promqlIdentifiers(expr)) queried.add(id);
  if (queried.size === 0) {
    return fail(
      'zero series are queried by any panel or alert rule — the invariant is trivially ' +
        'unviolated, but nothing was actually checked, so this must not read as green',
    );
  }

  const prefixes = hostNativeAllowlist || [];
  const dangling = [...queried].find(
    (id) => !recorded.has(id) && !prefixes.some((p) => id.startsWith(p)),
  );
  if (dangling !== undefined) {
    return fail(
      `\`${dangling}\` is queried but is neither defined by a \`record:\` rule nor host-native ` +
        `(allowlist: [${prefixes.join(', ')}]) — the panel/alert would query a series nothing emits`,
    );
  }
  return pass(
    `${queried.size} queried series all resolve (${recorded.size} recorded + host-native prefixes)`,
  );
}

// ---------------------------------------------------------------------------
// 15. D11 — retention is configured AND actually enforced
// ---------------------------------------------------------------------------
export function checkRetentionConfigured({ composeText, lokiText, tempoText }) {
  if (isBlank(composeText) && isBlank(lokiText) && isBlank(tempoText)) {
    return fail('D11: all retention inputs are empty — nothing was scanned');
  }
  if (!(composeText || '').includes('--storage.tsdb.retention.time=')) {
    return fail('D11: Prometheus declares no `--storage.tsdb.retention.time` flag (default 15d)');
  }
  const loki = stripComments(lokiText || '');
  if (!loki.includes('retention_period:')) {
    return fail('D11: Loki declares no `retention_period:`');
  }
  if (!loki.includes('retention_enabled: true')) {
    return fail(
      'D11: Loki sets `retention_period:` without `compactor.retention_enabled: true` — that ' +
        'defaults to false, so deletion silently never runs and the 30-day promise is a no-op',
    );
  }
  const tempo = stripComments(tempoText || '');
  const blockRetention = tempo.match(/block_retention:\s*(\S+)/);
  if (!blockRetention) return fail('D11: Tempo declares no `block_retention:`');
  return pass(
    `D11: Prometheus retention flag set, Loki retention enabled, Tempo block_retention ` +
      `${blockRetention[1]}`,
  );
}

// ---------------------------------------------------------------------------
// 16. Secrets — no committed credential, quoted OR unquoted
// ---------------------------------------------------------------------------
const QUOTED_CREDENTIAL = /(password|secret|api_?key|token)\s*[:=]\s*["'][^"']{8,}["']/i;
const UNQUOTED_CREDENTIAL = /\b[A-Za-z_]*(PASSWORD|SECRET|API_?KEY|TOKEN)\s*=\s*([^\s"'#]{8,})/;

export function checkNoQuotedCredential(namedTexts) {
  if (!Array.isArray(namedTexts) || namedTexts.length === 0) {
    return fail('zero files scanned — that is not the same as "clean" and must not read as green');
  }
  for (const { name, text } of namedTexts) {
    const body = text || '';
    if (QUOTED_CREDENTIAL.test(body)) {
      return fail(`${name}: a quoted credential-shaped literal is committed`);
    }
    const unquoted = body.match(UNQUOTED_CREDENTIAL);
    if (unquoted) {
      const value = unquoted[2];
      // Env indirection (`${VAR}`, `$VAR`) and placeholders (`<VAR>`, `{env.VAR}`) are fine.
      const indirect =
        value.startsWith('$') || value.startsWith('<') || value.startsWith('{') || value === '';
      if (!indirect) {
        return fail(
          `${name}: an UNQUOTED credential assignment (\`${unquoted[1]}=${value}\`) is ` +
            "committed — the repo's own check-secrets.mjs pattern requires quotes and would " +
            'miss this entirely',
        );
      }
    }
  }
  return pass(`${namedTexts.length} file(s) scanned: env indirection/placeholders only`);
}

// ---------------------------------------------------------------------------
// 17. OBS-30/31/32/40 — the DR runbook is runnable, not aspirational
// ---------------------------------------------------------------------------
export function checkRunbookHasRunnableSteps(runbookText) {
  if (isBlank(runbookText)) return fail('runbook text is empty — nothing was scanned');
  const blocks = fencedBlocks(runbookText);
  if (blocks.length === 0) return fail('OBS-30: the runbook contains no fenced code block');

  const liveLines = blocks.flat().filter((l) => !l.trimStart().startsWith('#'));
  const hasBackupCmd = liveLines.some((l) => {
    const t = l.trimStart();
    return t.startsWith('restic ') || t.startsWith('borg ') || t.startsWith('borgbackup ');
  });
  if (!hasBackupCmd) {
    return fail(
      'OBS-30: no runnable `restic`/`borg` backup command — a commented-out step still contains ' +
        'the substring, so comments are stripped first and a disabled step does not count',
    );
  }
  if (!liveLines.some((l) => l.includes('spacetime_replay_total_time_seconds'))) {
    return fail(
      'OBS-31: `spacetime_replay_total_time_seconds` does not appear inside a fenced block — RTO ' +
        'must be derived from the host replay metrics, and a prose mention is not a procedure',
    );
  }
  if (!runbookText.includes('crash-consistent') || !runbookText.includes('stop-the-world')) {
    return fail(
      'OBS-32: the runbook does not state the stop-the-world / atomic-snapshot requirement and ' +
        'that a live commitlog copy is not crash-consistent',
    );
  }
  if (!runbookText.includes('2x') && !runbookText.includes('2×')) {
    return fail('OBS-40: the backup-freshness rule (age > 2x the backup interval) is missing');
  }
  return pass(
    `OBS-30/31/32/40: ${blocks.length} fenced block(s) with a runnable backup command, the ` +
      'replay-metric RTO derivation, crash-consistency, and the 2x freshness rule',
  );
}
