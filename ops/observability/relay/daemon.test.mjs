// daemon.test.mjs — 13r-b U7..U19 gate for the relay's imperative SHELL
// (TDD RED).
//
// RED today because './daemon.mjs' does not exist. The tester does not
// implement it; the specialist does, to the API pinned in this header.
//
// ===========================================================================
// THE API THIS FILE PINS — daemon.mjs's exports
// ===========================================================================
//
//   ACCEPTED_FLAGS            a frozen array holding EXACTLY
//                             ['--logs-dir', '--trace-pair-set', '--web.listen-address']
//                             (AM16(d): OBS-45's "SHALL NOT ACCEPT a
//                             module-owner credential" is proven as an
//                             accepted-SET assertion at runtime, not as a
//                             blacklist of four credential-ish names).
//
//   ROUTES                    a frozen object whose KEY SET is exactly
//                             ['/health']. AM7: a `.count of listener calls`
//                             compensator cannot see a `/debug/eval` backdoor
//                             mounted on the same listener, so the surface is
//                             enumerated positively.
//
//   DEFAULT_POLL_INTERVAL_MS  number
//   CARRY_OVER_LIMITS         { maxEntries, maxAgeMicros } — AM2/ADR-0191 bounds
//
//   parseDaemonArgs(argv)
//     -> { ok: true,  args: { logsDir, listenAddress, tracePairSetPath } }
//     -> { ok: false, exitCode: 1, detail }
//     Both `--flag value` and `--flag=value` forms parse IDENTICALLY (D9).
//     There is NO default for --logs-dir and NO default for
//     --web.listen-address: absence is a loud exit 1, never a guess.
//     `--trace-pair-set` IS optional and defaults to the committed
//     trace-pair-set.json next to the module — the same default the batch CLI
//     already carries (AM15: import the SSOT, do not re-decide it). That is a
//     default PATH, not a default membership: the file's CONTENT is still read
//     through the 4 fail-loud stages, because absence is not the empty set.
//
//   readRangeOptions(readFrom, readTo) -> { start, end } | null
//     AM9b. tail.mjs returns the HALF-OPEN range [readFrom, readTo); node's
//     read-stream `end` is INCLUSIVE, so `end === readTo - 1`. An empty range
//     returns null — a stream must never be opened for zero bytes.
//
//   createDaemon({ args, tracePairSet, fs, timer, stdout, stderr,
//                  pollIntervalMs, carryOver, serviceName }) -> daemon
//
//     fs      { listLogFiles(dir) -> string[],
//               statFile(path)    -> { size, mtimeMs, identity },
//               readRange(path, from, to) -> string }   -- the ONLY fs seam
//     timer   { schedule(fn, delayMs) }                 -- the ONLY cadence seam
//     stdout  (text) => void        the OTLP document sink
//     stderr  (text) => void        diagnostics + the AM13 warning
//
//     daemon.metrics       { polls, linesRead, lastReadTimestampSeconds }
//     daemon.pollOnce()    -> {
//       files          string[]  the log paths discovered this round
//       decisions      [{ path, reason, readFrom, readTo, bytesRead }]
//                                one per discovered file; `reason` is
//                                tail.mjs's, verbatim
//       linesRead      number    COMPLETE lines produced this round
//       spans          number    spans in the document produced this round
//       emitted        boolean   AM14: true only when resourceSpans is non-empty
//       evicted        [{ key, reducer, ts, phase }]   the pair.mjs unpaired
//                                shape, for crumbs dropped by a carry-over bound
//       carryOverSize  number    open enters carried into the NEXT round
//       warnings       string[]  the AM13 warning, on the poll that raises it
//     }
//     daemon.start()       schedules the FIRST poll and returns; it performs
//                          no poll itself, and every poll reschedules the next
//     daemon.handleRequest({ method, url }) -> { statusCode, headers, body }
//
//     The AM13 warning text MUST contain the configured logs directory: an
//     operator reading it needs to see which path came up empty. Likewise an
//     eviction diagnostic MUST name the evicted correlation key, exactly once —
//     an unnamed "1 crumb evicted" line is not a diagnostic, it is a shrug.
//
// ===========================================================================
// AM16(b) — THERE IS NO CLOCK SEAM, AND THAT IS THE POINT
// ===========================================================================
// Nothing in the daemon reads wall-clock time. Cadence comes from the injected
// timer; pairing and carry-over ageing come from the HOST-populated `ts` in the
// log lines; `mr_trace_relay_lines_read_total` is a monotonic count; and
// `mr_trace_relay_last_read_timestamp_seconds` is derived from the mtime the fs
// seam reports for the file whose bytes were actually read. Consequently the
// `date.now(` ban is KEPT for this file rather than relaxed, and this suite
// contains no real timer and no real socket.
//
// AM8 — this file keeps ALL EIGHT hygiene bans. It drives injected transports
// and needs none of the daemon's relaxations; that is what mechanically forces
// the U13 seam to exist, and it keeps a real bound port out of `node --test`'s
// parallel execution (the recorded global-lock flake class).
//
// Discipline: no `new RegExp(`, no dynamic regex, no real timer, no bound port,
// no file written to disk. Every fixture is an inline string or a fake object;
// the only I/O is reading daemon.mjs's own source for the two structural tests.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  ACCEPTED_FLAGS,
  CARRY_OVER_LIMITS,
  createDaemon,
  DEFAULT_POLL_INTERVAL_MS,
  parseDaemonArgs,
  ROUTES,
  readRangeOptions,
} from './daemon.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOGS_DIR = '/data/module-logs';
const LOG_PATH = '/data/module-logs/replica-1/module_logs/2026-08-14.log';
const SECOND_LOG = '/data/module-logs/replica-2/module_logs/2026-08-14.log';
const PAIR_SET_PATH = '/opt/relay/trace-pair-set.json';
const LISTEN_ADDRESS = '127.0.0.1:9101';

const ARGS = Object.freeze({
  logsDir: LOGS_DIR,
  listenAddress: LISTEN_ADDRESS,
  tracePairSetPath: PAIR_SET_PATH,
});

/** A real host envelope line — a fixture builder, never an oracle. */
function hostLine(fn, ts, message) {
  return JSON.stringify({
    level: 'Info',
    ts: Number(ts),
    target: '__spacetimedb__',
    filename: '__spacetimedb__',
    function: fn,
    message,
  });
}

const ENTER_A = hostLine(
  'zone_tick',
  '1782197246181000',
  '{"evt":"span","cause":"zone:a","phase":"enter"}',
);
const EXIT_A = hostLine(
  'zone_tick',
  '1782197246183000',
  '{"evt":"span","cause":"zone:a","phase":"exit"}',
);
const ENTER_B = hostLine(
  'zone_tick',
  '1782197246186000',
  '{"evt":"span","cause":"zone:b","phase":"enter"}',
);
const EXIT_B = hostLine(
  'zone_tick',
  '1782197246187000',
  '{"evt":"span","cause":"zone:b","phase":"exit"}',
);
const HEARTBEAT = hostLine('mr_heartbeat', '1782197246184000', '{"evt":"heartbeat"}');

// ---------------------------------------------------------------------------
// Fakes — an fs seam, a timer seam, and two capture sinks
// ---------------------------------------------------------------------------

// AM7 widened WRITE_APIS after a cheat daemon wrote via `open(p,'a')` and
// `cpSync(...)` and passed every proposed static gate. Every one of these
// THROWS on the fake, so a daemon that reaches for one reddens loudly.
const WRITE_METHODS = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'open',
  'openSync',
  'createWriteStream',
  'copyFile',
  'copyFileSync',
  'cpSync',
  'mkdirSync',
  'mkdtempSync',
  'rmSync',
  'unlinkSync',
  'renameSync',
  'truncateSync',
  'chmodSync',
  'symlinkSync',
  'linkSync',
  'writeSync',
  'utimesSync',
];

const READ_OPS = ['listLogFiles', 'statFile', 'readRange'];

/**
 * A fake fs over in-memory files. Every fixture below is pure ASCII, so a
 * string's length IS its byte length — stated so the size arithmetic in these
 * tests is a fact rather than a coincidence.
 */
function fakeFs(spec) {
  const files = new Map();
  const calls = [];
  let listError = null;
  for (const [p, f] of Object.entries(spec)) files.set(p, { ...f });

  const api = {
    calls,
    put(p, f) {
      files.set(p, { ...f });
    },
    append(p, text) {
      const f = files.get(p);
      f.content += text;
    },
    truncate(p, text) {
      const f = files.get(p);
      f.content = text;
    },
    rotate(p, content, ino) {
      files.set(p, { content, ino, birthtimeMs: 5000 + ino, mtimeMs: 5000 + ino });
    },
    failListWith(err) {
      listError = err;
    },
    ops() {
      return calls.map((c) => c.op);
    },
    listLogFiles(dir) {
      calls.push({ op: 'listLogFiles', dir });
      if (listError !== null) throw listError;
      return [...files.keys()].sort();
    },
    statFile(p) {
      calls.push({ op: 'statFile', path: p });
      const f = files.get(p);
      return {
        size: f.content.length,
        mtimeMs: f.mtimeMs,
        identity: {
          dev: 2049,
          ino: f.ino,
          headSample: f.content.slice(0, 64),
          birthtimeMs: f.birthtimeMs,
        },
      };
    },
    readRange(p, from, to) {
      calls.push({ op: 'readRange', path: p, from, to });
      return files.get(p).content.slice(from, to);
    },
  };
  for (const name of WRITE_METHODS) {
    api[name] = () => {
      throw new Error(`OBS-45 VIOLATION: the daemon called fs.${name} — the relay NEVER writes`);
    };
  }
  return api;
}

/** The cadence seam: records every scheduling call, sleeps for exactly 0ms. */
function fakeTimer() {
  const calls = [];
  const queue = [];
  return {
    calls,
    schedule(fn, delayMs) {
      calls.push({ delayMs });
      queue.push(fn);
      return { handle: calls.length };
    },
    pending() {
      return queue.length;
    },
    runNext() {
      const fn = queue.shift();
      assert.notEqual(
        fn,
        undefined,
        'the daemon scheduled no further work — the poll loop stopped',
      );
      fn();
    },
  };
}

function capture() {
  const written = [];
  const sink = (text) => {
    written.push(text);
  };
  sink.written = written;
  return sink;
}

function makeDaemon(overrides = {}) {
  const stdout = overrides.stdout ?? capture();
  const stderr = overrides.stderr ?? capture();
  const timer = overrides.timer ?? fakeTimer();
  const fs = overrides.fs ?? fakeFs({});
  const daemon = createDaemon({
    args: overrides.args ?? ARGS,
    tracePairSet: overrides.tracePairSet ?? ['zone_tick'],
    fs,
    timer,
    stdout,
    stderr,
    pollIntervalMs: overrides.pollIntervalMs,
    carryOver: overrides.carryOver,
  });
  return { daemon, fs, timer, stdout, stderr };
}

// ---------------------------------------------------------------------------
// A Prometheus exposition reader — the platform-independent oracle for U7.
// Character classes are walked by hand: no regex of any kind in this repo's
// relay suites.
// ---------------------------------------------------------------------------

function isMetricNameChar(c, first) {
  if (c >= 'a' && c <= 'z') return true;
  if (c >= 'A' && c <= 'Z') return true;
  if (c === '_' || c === ':') return true;
  if (!first && c >= '0' && c <= '9') return true;
  return false;
}

function isBareMetricName(name) {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i++) {
    if (!isMetricNameChar(name[i], i === 0)) return false;
  }
  return true;
}

/**
 * Parse an exposition document the way a scraper does, and FAIL if any line is
 * unparseable. This is what makes "the body is a valid exposition document" an
 * assertion rather than a hope: `ok`, `OK\n` and a JSON blob all red here, and
 * each of those is a scrape parse error, i.e. `up=0`.
 */
function parseExposition(body) {
  const samples = new Map();
  const types = new Map();
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) {
      const parts = line.split(' ').filter((p) => p.length > 0);
      if (parts[1] === 'TYPE') types.set(parts[2], parts[3]);
      continue;
    }
    const at = line.indexOf(' ');
    assert.notEqual(at, -1, `exposition line carries no value: '${line}'`);
    const name = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    assert.equal(
      isBareMetricName(name),
      true,
      `'${name}' is not a bare, LABEL-FREE metric name — AM3 serves one label-free counter`,
    );
    const parsed = Number(value);
    assert.equal(Number.isFinite(parsed), true, `'${line}' carries a non-numeric sample value`);
    samples.set(name, parsed);
  }
  return { samples, types };
}

/** Comment-stripped, lowercased source text — used by the structural tests. */
function codeText(source) {
  const kept = [];
  for (const raw of source.split('\n')) {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    const cut = raw.indexOf('//');
    kept.push(cut === -1 ? raw : raw.slice(0, cut));
  }
  return kept.join('\n').toLowerCase();
}

const DAEMON_SOURCE = readFileSync(path.join(import.meta.dirname, 'daemon.mjs'), 'utf8');

function spansOf(stdoutSink) {
  const out = [];
  for (const text of stdoutSink.written) {
    const doc = JSON.parse(text.trim());
    for (const rs of doc.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) out.push(span);
      }
    }
  }
  return out;
}

function correlationKeyOf(span) {
  const attr = span.attributes.find((a) => a.key === 'mr.correlation_key');
  return attr === undefined ? null : attr.value.stringValue;
}

// ===========================================================================
// U9/U10/U11 — the argument parser (OBS-45's runtime half, AM16(d))
// ===========================================================================

test('U9: --web.listen-address absent is a LOUD exit 1 — never a default (D9/OBS-46)', () => {
  const r = parseDaemonArgs(['--logs-dir', LOGS_DIR, '--trace-pair-set', PAIR_SET_PATH]);
  assert.equal(r.ok, false, 'a daemon that guesses its bind address binds the wrong interface');
  assert.equal(r.exitCode, 1);
  assert.equal(
    r.detail.indexOf('--web.listen-address') !== -1,
    true,
    `the failure must NAME the missing flag, got: ${r.detail}`,
  );
  assert.equal(r.args, undefined, 'a rejection must not hand back a half-built argument set');
});

test('U9: the `=`-joined and space-separated forms parse IDENTICALLY', () => {
  // D9's consequence: the shipped batch parser (mr-trace-relay.mjs:34-54)
  // handles ONLY space-separated pairs, while the compose `command:` list must
  // spell `--web.listen-address=127.0.0.1:9101` for checkListenAddrsLoopback.
  const joined = parseDaemonArgs([
    `--logs-dir=${LOGS_DIR}`,
    `--web.listen-address=${LISTEN_ADDRESS}`,
    `--trace-pair-set=${PAIR_SET_PATH}`,
  ]);
  const spaced = parseDaemonArgs([
    '--logs-dir',
    LOGS_DIR,
    '--web.listen-address',
    LISTEN_ADDRESS,
    '--trace-pair-set',
    PAIR_SET_PATH,
  ]);
  assert.equal(joined.ok, true, joined.detail);
  assert.deepEqual(joined, spaced, 'the two spellings must not differ by one byte');
  assert.deepEqual(joined.args, {
    logsDir: LOGS_DIR,
    listenAddress: LISTEN_ADDRESS,
    tracePairSetPath: PAIR_SET_PATH,
  });
});

test('U9: a flag given with no value is a loud exit 1, not an empty-string bind address', () => {
  const missingValue = parseDaemonArgs(['--logs-dir', LOGS_DIR, '--web.listen-address']);
  assert.equal(missingValue.ok, false);
  assert.equal(missingValue.exitCode, 1);

  const emptyJoined = parseDaemonArgs([`--logs-dir=${LOGS_DIR}`, '--web.listen-address=']);
  assert.equal(emptyJoined.ok, false, 'an empty value is absence wearing a value-shaped hat');
  assert.equal(emptyJoined.exitCode, 1);
});

test('U10 (AM16(d)): the ACCEPTED flag set is EXACTLY three flags — asserted as a SET', () => {
  // Strictly stronger than enumerating four credential-ish names: a flag the
  // parser never accepts cannot be renamed past a substring blacklist.
  assert.deepEqual(
    [...ACCEPTED_FLAGS].sort(),
    ['--logs-dir', '--trace-pair-set', '--web.listen-address'],
    'OBS-45: the relay SHALL NOT ACCEPT a module-owner credential — proven at runtime',
  );
  assert.equal(ACCEPTED_FLAGS.length, 3, 'three, and no fourth');
});

test('U10 (OBS-45): every flag outside that set exits 1 — credential-shaped and benign alike', () => {
  const rejected = [
    '--token',
    '--auth',
    '--password',
    '--api-key',
    '--credential',
    '--authorization',
    '--bearer',
    '--out',
    '--output',
    '--offset-file',
    '--checkpoint',
    '--otlp-endpoint',
    '--debug',
    '--verbose',
    '-v',
    '--help',
  ];
  for (const flag of rejected) {
    const spaced = parseDaemonArgs([
      '--logs-dir',
      LOGS_DIR,
      '--web.listen-address',
      LISTEN_ADDRESS,
      flag,
      'value',
    ]);
    assert.equal(spaced.ok, false, `${flag} must be REJECTED, not silently ignored`);
    assert.equal(spaced.exitCode, 1, `${flag}: exit code`);
    assert.equal(
      spaced.detail.indexOf(flag) !== -1,
      true,
      `${flag}: the failure must name the offending flag, got: ${spaced.detail}`,
    );

    const joined = parseDaemonArgs([
      `--logs-dir=${LOGS_DIR}`,
      `--web.listen-address=${LISTEN_ADDRESS}`,
      `${flag}=value`,
    ]);
    assert.equal(joined.ok, false, `${flag}=value must be rejected in the joined form too`);
    assert.equal(joined.exitCode, 1);
  }
});

test('U10: a bare positional argument is rejected too — there is no implicit logs-dir', () => {
  const r = parseDaemonArgs([LOGS_DIR, '--web.listen-address', LISTEN_ADDRESS]);
  assert.equal(r.ok, false, 'a positional path is how an --out sink sneaks in');
  assert.equal(r.exitCode, 1);
});

test('U9/AM15: --trace-pair-set is the ONE optional flag, defaulting to the committed file path', () => {
  const r = parseDaemonArgs(['--logs-dir', LOGS_DIR, '--web.listen-address', LISTEN_ADDRESS]);
  assert.equal(r.ok, true, r.detail);
  assert.equal(typeof r.args.tracePairSetPath, 'string');
  assert.equal(
    r.args.tracePairSetPath.endsWith('trace-pair-set.json'),
    true,
    `the default membership PATH is the committed file, got: ${r.args.tracePairSetPath}`,
  );
  // A default PATH is not a default MEMBERSHIP: the file's content is still
  // read through the batch CLI's 4 fail-loud stages, so a deleted config fails
  // loudly rather than reading as "nothing is instrumented" (OBS-50).
});

test('U11: --logs-dir absent is exit 1', () => {
  const r = parseDaemonArgs([
    '--web.listen-address',
    LISTEN_ADDRESS,
    '--trace-pair-set',
    PAIR_SET_PATH,
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.equal(
    r.detail.indexOf('--logs-dir') !== -1,
    true,
    `the failure must name --logs-dir, got: ${r.detail}`,
  );

  // And an EMPTY argv is a rejection, not a daemon booting on defaults.
  const empty = parseDaemonArgs([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.exitCode, 1);
});

test('U11: no default logs directory is spelled ANYWHERE in daemon.mjs', () => {
  // Behavioural absence above; textual absence here. A hardcoded fallback path
  // would satisfy every parser test and still make a wrong --logs-dir silently
  // read the wrong tree.
  const code = codeText(DAEMON_SOURCE);
  for (const literal of ['/var/log', '/data/', 'module_logs', 'module-logs', 'replicas']) {
    assert.equal(
      code.indexOf(literal),
      -1,
      `daemon.mjs spells '${literal}' in code — the logs path comes from --logs-dir, only`,
    );
  }
});

// ===========================================================================
// U7 — /health (AM3: the highest-severity assertion in the slice)
// ===========================================================================

function bootedDaemon() {
  const rig = makeDaemon({
    fs: fakeFs({
      [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 },
    }),
  });
  rig.daemon.pollOnce(); // boot poll: startAtEnd, reads nothing
  rig.fs.put(LOG_PATH, {
    content: `${ENTER_A}\n${HEARTBEAT}\n${EXIT_A}\n`,
    ino: 10,
    birthtimeMs: 1000,
    mtimeMs: 1782197246000,
  });
  rig.daemon.pollOnce();
  return rig;
}

test('U7 (AM3): GET /health returns statusCode 200 — asserted on its own', () => {
  const { daemon } = bootedDaemon();
  const res = daemon.handleRequest({ method: 'GET', url: '/health' });
  assert.equal(
    res.statusCode,
    200,
    'anything else pins up=0 and the dead-man switch fires forever',
  );
});

test('U7 (AM3): /health must NOT answer 204 — verified live, a 204 makes Prometheus report up=0', () => {
  // THE LANDMINE THIS KILLS, named. `res.writeHead(204).end()` is the most
  // idiomatic Node spelling of "empty body", it looks correct in review, and it
  // was verified against real prom/prometheus:v3.13.2 to yield up=0 — INVERTING
  // the dead-man's switch this slice exists to arm. AM3 removes the whole class
  // by serving a real exposition document instead of an empty one.
  const { daemon } = bootedDaemon();
  const res = daemon.handleRequest({ method: 'GET', url: '/health' });
  assert.notEqual(res.statusCode, 204, 'a 204 is a scrape failure, not an empty success');
  assert.equal(res.statusCode >= 200 && res.statusCode < 300, true);
  assert.equal(typeof res.body, 'string');
  assert.notEqual(res.body.length, 0, 'a zero-length body is the 204 landmine in a 200 costume');
  assert.equal(res.body.endsWith('\n'), true, 'an exposition document ends on a newline');
});

test('U7 (AM3): the /health body is a VALID exposition document with a label-free counter', () => {
  const { daemon } = bootedDaemon();
  const res = daemon.handleRequest({ method: 'GET', url: '/health' });
  const contentType = res.headers['content-type'];
  assert.equal(typeof contentType, 'string', 'a scrape target must declare its content type');
  assert.equal(contentType.startsWith('text/plain'), true, contentType);
  assert.equal(contentType.indexOf('version=0.0.4') !== -1, true, contentType);

  // parseExposition itself asserts every line is parseable: `ok`, `OK\n` and a
  // JSON blob all red here, and each of those is a scrape parse error.
  const { samples, types } = parseExposition(res.body);
  assert.equal(
    samples.has('mr_trace_relay_lines_read_total'),
    true,
    'AM3: the counter is what makes the body a valid document BY CONSTRUCTION',
  );
  assert.equal(samples.has('mr_trace_relay_last_read_timestamp_seconds'), true);
  assert.equal(types.get('mr_trace_relay_lines_read_total'), 'counter');
  assert.equal(
    res.body.indexOf('{'),
    -1,
    'AM3 serves ONE LABEL-FREE counter — a label set here is unreviewed cardinality',
  );
});

test('U7 (AM3/D8): the counter tracks the lines ACTUALLY read, and a held partial does not count', () => {
  const { daemon, fs } = makeDaemon({
    fs: fakeFs({ [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 } }),
  });
  const read = () =>
    parseExposition(daemon.handleRequest({ method: 'GET', url: '/health' }).body).samples.get(
      'mr_trace_relay_lines_read_total',
    );

  daemon.pollOnce();
  assert.equal(read(), 0, 'a boot poll over an untouched file reads zero lines');

  // Three complete lines plus a fourth that is still being written.
  const partial = ENTER_B.slice(0, 40);
  fs.append(LOG_PATH, `${ENTER_A}\n${HEARTBEAT}\n${EXIT_A}\n${partial}`);
  const round = daemon.pollOnce();
  assert.equal(round.linesRead, 3, 'the half-written fourth line is HELD, not counted');
  assert.equal(read(), 3);
  assert.equal(daemon.metrics.linesRead, 3);

  fs.append(LOG_PATH, `${ENTER_B.slice(40)}\n`);
  daemon.pollOnce();
  assert.equal(read(), 4, 'the counter is monotonic and the completed line lands exactly once');

  daemon.pollOnce();
  assert.equal(
    read(),
    4,
    'an idle poll adds nothing — a stalled tail is visible as a flat counter',
  );
});

test('U7 (AM16(b)): the last-read timestamp is DATA-derived (file mtime), never a clock read', () => {
  const { daemon, fs } = makeDaemon({
    fs: fakeFs({
      [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1_000_000_000_000 },
    }),
  });
  const stamp = () =>
    parseExposition(daemon.handleRequest({ method: 'GET', url: '/health' }).body).samples.get(
      'mr_trace_relay_last_read_timestamp_seconds',
    );

  daemon.pollOnce();
  assert.equal(stamp(), 0, 'nothing has been read yet, so the stamp is an honest zero');

  fs.put(LOG_PATH, {
    content: `${ENTER_A}\n`,
    ino: 10,
    birthtimeMs: 1000,
    mtimeMs: 1782197246000,
  });
  daemon.pollOnce();
  assert.equal(stamp(), 1782197246, 'milliseconds to seconds, exactly, from the fs seam');

  // A poll that reads NO bytes must not advance the stamp, even though the
  // file's mtime moved: the metric answers "when did the relay last read", and
  // a stamp that advances on an idle poll is the stalled-tail blind spot D8
  // named and AM3 closes.
  fs.put(LOG_PATH, {
    content: `${ENTER_A}\n`,
    ino: 10,
    birthtimeMs: 1000,
    mtimeMs: 1900000000000,
  });
  daemon.pollOnce();
  assert.equal(stamp(), 1782197246);
});

// ===========================================================================
// U8 — the route surface (AM7)
// ===========================================================================

test('U8 (AM7): the dispatch KEY SET is exactly one route, /health — a positive enumeration', () => {
  // A `.count of listener call sites` compensator cannot see a /debug/eval
  // backdoor mounted on the SAME listener. Enumerating the routes can.
  assert.deepEqual(Object.keys(ROUTES).sort(), ['/health']);
  assert.equal(typeof ROUTES['/health'], 'function');
  assert.equal(Object.isFrozen(ROUTES), true, 'a mutable route table is a runtime backdoor');
});

test('U8: every other path is 404 — including the shapes a backdoor would take', () => {
  const { daemon } = bootedDaemon();
  for (const url of [
    '/',
    '/metrics',
    '/health/',
    '/healthz',
    '/debug/eval',
    '/debug/pprof',
    '/logs',
    '/../health',
    '/HEALTH',
  ]) {
    const res = daemon.handleRequest({ method: 'GET', url });
    assert.equal(res.statusCode, 404, `${url} must not be served`);
  }
});

test('U8: HEAD is served, and every other method on /health is 405', () => {
  const { daemon } = bootedDaemon();
  const head = daemon.handleRequest({ method: 'HEAD', url: '/health' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '', 'a HEAD response carries headers and no body');

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    const res = daemon.handleRequest({ method, url: '/health' });
    assert.equal(res.statusCode, 405, `${method} /health must be 405, not 200 and not 404`);
  }
});

// ===========================================================================
// U13 — the poll loop over an injected fs + injected timer
// ===========================================================================

test('U13: N scheduled polls produce N decision rounds with ZERO real sleeping', () => {
  const { daemon, fs, timer } = makeDaemon({
    fs: fakeFs({ [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 } }),
    pollIntervalMs: 5000,
  });

  daemon.start();
  assert.equal(
    daemon.metrics.polls,
    0,
    'start() schedules the first poll; it does not perform one',
  );
  assert.equal(timer.calls.length, 1);
  assert.deepEqual(timer.calls[0], { delayMs: 5000 });

  for (let i = 0; i < 3; i++) timer.runNext();

  assert.equal(daemon.metrics.polls, 3, 'three fired timers, three rounds');
  assert.equal(timer.calls.length, 4, 'and every poll rescheduled exactly one successor');
  for (const call of timer.calls) {
    assert.equal(
      call.delayMs,
      5000,
      'every wait goes through the injected timer at the pinned cadence',
    );
  }
  assert.equal(timer.pending(), 1, 'exactly one poll is outstanding — never two loops racing');

  const listCalls = fs.ops().filter((op) => op === 'listLogFiles');
  assert.equal(listCalls.length, 3, 'each round rediscovers the log set once');
});

test('U13: the cadence defaults to the exported DEFAULT_POLL_INTERVAL_MS, and it is a real interval', () => {
  assert.equal(Number.isFinite(DEFAULT_POLL_INTERVAL_MS), true);
  assert.equal(DEFAULT_POLL_INTERVAL_MS > 0, true, 'a zero interval is a busy loop, not a poll');
  const { daemon, timer } = makeDaemon();
  daemon.start();
  assert.deepEqual(timer.calls[0], { delayMs: DEFAULT_POLL_INTERVAL_MS });
});

test('D2: a file present at BOOT seeks to EOF; a file first seen LATER is read from 0', () => {
  const { daemon, fs, stdout } = makeDaemon({
    fs: fakeFs({
      [LOG_PATH]: { content: `${ENTER_A}\n${EXIT_A}\n`, ino: 10, birthtimeMs: 1000, mtimeMs: 1000 },
    }),
    tracePairSet: ['zone_tick'],
  });

  const boot = daemon.pollOnce();
  assert.equal(
    boot.linesRead,
    0,
    'D2: breadcrumbs written while the relay was down are NOT exported',
  );
  assert.equal(boot.decisions.length, 1);
  assert.equal(boot.decisions[0].reason, 'firstSight');
  assert.equal(boot.decisions[0].readFrom, boot.decisions[0].readTo, 'a boot seek reads nothing');
  assert.equal(stdout.written.length, 0);

  // A second replica's log appears on a LATER poll: it has no history to skip.
  fs.put(SECOND_LOG, {
    content: `${ENTER_B}\n${EXIT_B}\n`,
    ino: 20,
    birthtimeMs: 2000,
    mtimeMs: 2000,
  });
  const later = daemon.pollOnce();
  const fresh = later.decisions.find((d) => d.path === SECOND_LOG);
  assert.notEqual(fresh, undefined, 'the new file must be discovered');
  assert.equal(fresh.reason, 'firstSight');
  assert.equal(fresh.readFrom, 0, 'a file first seen after boot is read from byte 0');
  assert.equal(later.linesRead, 2);
  assert.equal(later.spans, 1);
});

// ===========================================================================
// AM9b — the half-open decision vs the INCLUSIVE stream end
// ===========================================================================

test('AM9b: readRangeOptions converts [readFrom, readTo) to an INCLUSIVE end, losing no byte', () => {
  const opts = readRangeOptions(0, 4096);
  assert.deepEqual(opts, { start: 0, end: 4095 });
  assert.equal(opts.end - opts.start + 1, 4096, 'the inclusive span must equal readTo - readFrom');

  // PROOF OF TEETH — the wrong implementation this kills. `end: readTo` reads
  // 4097 bytes, so every chunk boundary duplicates one byte and the JSON line
  // that straddles it is corrupted.
  assert.notEqual(opts.end, 4096, 'a naive `end: readTo` re-reads one byte at every boundary');
  assert.equal(4096 - 0 + 1, 4097, 'FIXTURE: the naive form really is one byte long, spelled out');

  const mid = readRangeOptions(4096, 9000);
  assert.deepEqual(mid, { start: 4096, end: 8999 });
  assert.equal(mid.end - mid.start + 1, 9000 - 4096);
});

test('AM9b: an EMPTY range yields null — a stream is never opened for zero bytes', () => {
  assert.equal(readRangeOptions(0, 0), null, '{start:0,end:-1} would read the whole file');
  assert.equal(readRangeOptions(4096, 4096), null, 'the noChange branch must open nothing');
});

test('AM9b: the adapter reads EXACTLY readTo - readFrom bytes over a real poll cycle', () => {
  // U3 in tail.test.mjs asserts the DECISION; this asserts the ADAPTER. The
  // off-by-one lives between them, which is why it needs both.
  const { daemon, fs } = makeDaemon({
    fs: fakeFs({ [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 } }),
  });
  daemon.pollOnce();

  const chunk = `${ENTER_A}\n${EXIT_A}\n`;
  fs.append(LOG_PATH, chunk);
  const round = daemon.pollOnce();

  const decision = round.decisions.find((d) => d.path === LOG_PATH);
  assert.equal(decision.reason, 'growth');
  assert.equal(decision.readTo - decision.readFrom, chunk.length);
  assert.equal(
    decision.bytesRead,
    decision.readTo - decision.readFrom,
    'bytesRead must equal the half-open width — one byte over is a duplicated byte',
  );

  const readCalls = fs.calls.filter((c) => c.op === 'readRange');
  assert.equal(readCalls.length, 1, 'exactly one read for one growth decision');
  assert.equal(readCalls[0].to - readCalls[0].from, chunk.length);
  assert.equal(round.linesRead, 2, 'and both lines survived the boundary intact');
});

// ===========================================================================
// U15 — the relay never writes
// ===========================================================================

test('U15 (OBS-45): no write API is called on ANY path — driven through truncation and rotation', () => {
  // The fake's 21 write methods all throw (AM7's widened list, including the
  // `open(` and `cpSync(` shapes a cheat daemon used to pass every proposed
  // static gate). A daemon that reaches for one reddens here, loudly.
  const { daemon, fs, stdout } = makeDaemon({
    fs: fakeFs({ [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 } }),
  });

  daemon.pollOnce(); // boot
  fs.append(LOG_PATH, `${ENTER_A}\n${EXIT_A}\n`);
  daemon.pollOnce(); // growth
  fs.truncate(LOG_PATH, '');
  daemon.pollOnce(); // truncation
  fs.append(LOG_PATH, `${ENTER_B}\n`);
  daemon.pollOnce(); // growth after truncation
  fs.rotate(LOG_PATH, `${EXIT_B}\n`, 99);
  daemon.pollOnce(); // rotation
  daemon.pollOnce(); // idle

  for (const call of fs.calls) {
    assert.equal(
      READ_OPS.includes(call.op),
      true,
      `the daemon reached outside the read-only fs seam: ${call.op}`,
    );
  }
  assert.equal(daemon.metrics.polls, 6);
  assert.notEqual(stdout.written.length, 0, 'and the cycle actually did work — not a vacuous pass');
  assert.equal(
    fs.calls.filter((c) => c.op === 'readRange').length > 0,
    true,
    'the hostile-fs drive must actually have read bytes, or the write ban is vacuous here',
  );
});

test('U15: daemon.mjs calls NO write API in its source, and reads via createReadStream (AM15)', () => {
  // The injected-fs test above proves the daemon does not write THROUGH THE
  // SEAM; this proves it does not import a write API around it. D3: openSync is
  // itself banned, so createReadStream is the daemon's only read API.
  const code = codeText(DAEMON_SOURCE);
  const writeApis = [
    'writefilesync',
    'writefile',
    'appendfilesync',
    'appendfile',
    'copyfilesync',
    'copyfile',
    'cpsync',
    'createwritestream',
    'opensync',
    'promises.open',
    'unlinksync',
    'rmsync',
    'renamesync',
    'mkdirsync',
    'mkdtempsync',
    'chmodsync',
    'truncatesync',
    'writesync',
    'symlinksync',
    'linksync',
    'utimessync',
  ];
  for (const api of writeApis) {
    assert.equal(
      code.indexOf(api),
      -1,
      `daemon.mjs calls a write API (${api}) — OBS-45 forbids it`,
    );
  }
  assert.notEqual(
    code.indexOf('createreadstream'),
    -1,
    'a shell that reads nothing cannot be confirmed to read READ-ONLY',
  );
  assert.notEqual(
    code.indexOf('readrangeoptions'),
    -1,
    'AM9b: the inclusive-end conversion must actually be WIRED, not merely exported',
  );
});

// ===========================================================================
// U16/U17 — AM2's cross-poll carry-over (the span-loss blocker)
// ===========================================================================

test('U16 (AM2): an enter in poll N and its exit in poll N+1 produce EXACTLY ONE span', () => {
  // THE BLOCKER THIS CLOSES: reconstruct() pairs FIFO within ONE invocation
  // (pair.mjs:58), so a daemon calling reconstruct(linesSinceLastPoll) drops
  // BOTH crumbs into `unpaired` and no span is EVER emitted for a reducer whose
  // enter and exit straddle a poll boundary — which is most of them.
  const { daemon, fs, stdout } = makeDaemon({
    fs: fakeFs({ [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 } }),
    tracePairSet: ['zone_tick'],
  });

  daemon.pollOnce();

  fs.append(LOG_PATH, `${ENTER_A}\n`);
  const withEnter = daemon.pollOnce();
  assert.equal(withEnter.linesRead, 1);
  assert.equal(withEnter.spans, 0, 'an open enter is not yet a span');
  assert.equal(withEnter.emitted, false, 'AM14: nothing to say, so say nothing');
  assert.equal(withEnter.carryOverSize, 1, 'the unpaired enter is CARRIED, not discarded');
  assert.equal(stdout.written.length, 0);

  fs.append(LOG_PATH, `${EXIT_A}\n`);
  const withExit = daemon.pollOnce();
  assert.equal(withExit.linesRead, 1);
  assert.equal(withExit.spans, 1, 'exactly one span, not zero and not two');
  assert.equal(withExit.emitted, true);
  assert.equal(withExit.carryOverSize, 0, 'the carry-over is drained once it pairs');

  const spans = spansOf(stdout);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'zone_tick');
  assert.equal(correlationKeyOf(spans[0]), 'cause:zone:a');
  assert.equal(spans[0].startTimeUnixNano, '1782197246181000000');
  assert.equal(spans[0].endTimeUnixNano, '1782197246183000000');
  assert.equal(
    BigInt(spans[0].endTimeUnixNano) - BigInt(spans[0].startTimeUnixNano),
    2000000n,
    'the duration is the real 2000us, measured across the poll boundary',
  );

  // A third poll must not re-emit the same span: the carry-over is consumed.
  daemon.pollOnce();
  assert.equal(spansOf(stdout).length, 1, 'a carried enter must pair exactly once');
});

test('U17 (AM2/OBS-42): a carry-over evicted by MAX ENTRIES emits a diagnostic and NEVER a span', () => {
  const { daemon, fs, stdout, stderr } = makeDaemon({
    fs: fakeFs({ [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 } }),
    tracePairSet: ['zone_tick'],
    carryOver: { maxEntries: 1, maxAgeMicros: 999999999 },
  });

  daemon.pollOnce();
  fs.append(LOG_PATH, `${ENTER_A}\n`);
  assert.equal(daemon.pollOnce().carryOverSize, 1);

  fs.append(LOG_PATH, `${ENTER_B}\n`);
  const evicting = daemon.pollOnce();
  assert.equal(evicting.carryOverSize, 1, 'the bound is enforced, not merely declared');
  assert.equal(evicting.evicted.length, 1);
  assert.equal(evicting.evicted[0].key, 'cause:zone:a', 'the OLDEST open enter is the one dropped');
  assert.equal(evicting.evicted[0].phase, 'enter');
  assert.equal(evicting.emitted, false);

  const notices = stderr.written.filter((t) => t.indexOf('cause:zone:a') !== -1);
  assert.equal(notices.length, 1, 'an eviction is DIAGNOSTIC — it must be said, exactly once');

  // Its exit finally arrives: OBS-42 forbids estimating or backfilling, so it
  // must produce nothing at all rather than a span with a guessed start.
  fs.append(LOG_PATH, `${EXIT_A}\n`);
  daemon.pollOnce();
  for (const span of spansOf(stdout)) {
    assert.notEqual(
      correlationKeyOf(span),
      'cause:zone:a',
      'an evicted enter must NEVER become a span — that duration would be invented',
    );
  }
});

test('U17 (AM2/OBS-42): a carry-over evicted by MAX AGE emits a diagnostic and NEVER a span', () => {
  // Age is measured against the largest HOST ts observed so far, not against a
  // clock (AM16(b)): the daemon reads no wall-clock time anywhere.
  const { daemon, fs, stdout, stderr } = makeDaemon({
    fs: fakeFs({ [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 } }),
    tracePairSet: ['zone_tick'],
    carryOver: { maxEntries: 100, maxAgeMicros: 1000 },
  });

  daemon.pollOnce();
  fs.append(LOG_PATH, `${ENTER_A}\n`);
  assert.equal(daemon.pollOnce().carryOverSize, 1);

  // A complete, unrelated chain 6000us later advances the observed ts.
  fs.append(LOG_PATH, `${ENTER_B}\n${EXIT_B}\n`);
  const aging = daemon.pollOnce();
  assert.equal(aging.spans, 1, 'the fresh chain still pairs normally');
  assert.equal(aging.evicted.length, 1, 'the 6000us-old enter is past the 1000us bound');
  assert.equal(aging.evicted[0].key, 'cause:zone:a');
  assert.equal(aging.carryOverSize, 0);

  const notices = stderr.written.filter((t) => t.indexOf('cause:zone:a') !== -1);
  assert.equal(notices.length, 1);

  fs.append(LOG_PATH, `${EXIT_A}\n`);
  daemon.pollOnce();
  const keys = spansOf(stdout).map(correlationKeyOf);
  assert.deepEqual(keys, ['cause:zone:b'], 'only the chain that genuinely paired is exported');
});

test('AM2: both carry-over bounds are EXPORTED constants, not magic numbers (ADR-0191)', () => {
  assert.equal(typeof CARRY_OVER_LIMITS.maxEntries, 'number');
  assert.equal(typeof CARRY_OVER_LIMITS.maxAgeMicros, 'number');
  assert.equal(CARRY_OVER_LIMITS.maxEntries > 0, true, 'an unbounded carry-over is a memory leak');
  assert.equal(CARRY_OVER_LIMITS.maxAgeMicros > 0, true);
});

// ===========================================================================
// U18 (AM13) / U19 (AM14) — boot resilience and output discipline
// ===========================================================================

test('U18 (AM13): an EMPTY logs-dir does NOT exit — warn once, keep polling, /health still 200', () => {
  // The batch CLI exits 1 here (mr-trace-relay.mjs:146-153). Under
  // `restart: unless-stopped` that is a crash loop pinning up=0 — the
  // dead-man's switch permanently firing on a stack that is merely young.
  const { daemon, timer, stderr } = makeDaemon({ fs: fakeFs({}) });

  const first = daemon.pollOnce();
  assert.equal(first.files.length, 0);
  assert.equal(first.warnings.length, 1, 'say it ONCE');
  const second = daemon.pollOnce();
  const third = daemon.pollOnce();
  assert.equal(second.warnings.length, 0, 'and not again on every poll, forever');
  assert.equal(third.warnings.length, 0);

  const mentions = stderr.written.filter((t) => t.indexOf(LOGS_DIR) !== -1);
  assert.equal(mentions.length, 1, 'exactly one stderr warning names the empty directory');

  assert.equal(daemon.metrics.polls, 3, 'the daemon kept polling');
  daemon.start();
  timer.runNext();
  assert.equal(timer.calls.length, 2, 'and it keeps rescheduling — no crash loop, no exit');

  const res = daemon.handleRequest({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200, 'a young stack must not read as a dead relay');
  parseExposition(res.body);
});

test('U18 (AM13): a MISSING logs-dir is the same — a thrown ENOENT is warned about, not fatal', () => {
  const fs = fakeFs({});
  const enoent = new Error('ENOENT: no such file or directory');
  enoent.code = 'ENOENT';
  fs.failListWith(enoent);
  const { daemon, stderr } = makeDaemon({ fs });

  assert.doesNotThrow(() => daemon.pollOnce(), 'the replicas tree may not exist yet');
  assert.doesNotThrow(() => daemon.pollOnce());
  assert.equal(daemon.metrics.polls, 2);
  const mentions = stderr.written.filter((t) => t.indexOf(LOGS_DIR) !== -1);
  assert.equal(mentions.length, 1, 'warn once, then stay quiet');
  assert.equal(daemon.handleRequest({ method: 'GET', url: '/health' }).statusCode, 200);
});

test('U19 (AM14): a document is emitted ONLY when resourceSpans is non-empty', () => {
  // Otherwise the daemon prints {"resourceSpans":[]} every poll forever into
  // Docker's json-file driver (no `logging:` limits anywhere in the compose)
  // for exactly zero information.
  const empty = makeDaemon({
    fs: fakeFs({ [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 } }),
    tracePairSet: [],
  });
  empty.daemon.pollOnce();
  empty.fs.append(LOG_PATH, `${ENTER_A}\n${EXIT_A}\n${HEARTBEAT}\n`);
  const filtered = empty.daemon.pollOnce();
  assert.equal(filtered.linesRead, 3, 'the lines WERE read');
  assert.equal(filtered.spans, 0, 'and the empty allowlist filtered every crumb out (OBS-50)');
  assert.equal(filtered.emitted, false);
  assert.equal(empty.stdout.written.length, 0, 'an empty reconstruction emits NO document');

  empty.daemon.pollOnce();
  empty.daemon.pollOnce();
  assert.equal(empty.stdout.written.length, 0, 'and idle polls stay silent too');

  const live = makeDaemon({
    fs: fakeFs({ [LOG_PATH]: { content: '', ino: 10, birthtimeMs: 1000, mtimeMs: 1000 } }),
    tracePairSet: ['zone_tick'],
  });
  live.daemon.pollOnce();
  live.fs.append(LOG_PATH, `${ENTER_A}\n${EXIT_A}\n`);
  live.daemon.pollOnce();
  assert.equal(live.stdout.written.length, 1, 'one non-empty reconstruction, one document');
  assert.equal(live.stdout.written[0].endsWith('\n'), true, 'one document per line on stdout');
  assert.equal(spansOf(live.stdout).length, 1);
});

test('OBS-50: createDaemon THROWS without a tracePairSet — absence is NOT the empty set', () => {
  assert.throws(
    () =>
      createDaemon({
        args: ARGS,
        fs: fakeFs({}),
        timer: fakeTimer(),
        stdout: capture(),
        stderr: capture(),
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(
        err.message.indexOf('trace_pair_set') !== -1 || err.message.indexOf('tracePairSet') !== -1,
        true,
        `the message must name the missing allowlist, got: ${err.message}`,
      );
      return true;
    },
    'defaulting the allowlist turns "the config could not be read" into "nothing is instrumented"',
  );
});
