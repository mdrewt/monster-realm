// daemon.mjs — the relay's imperative SHELL: a tail-follow poll loop over the
// read-only module-log mount, plus the /health scrape endpoint (13r-b;
// ADR-0191, OBS-45/OBS-46).
//
// Everything decidable is decided in the pure core. This file owns exactly four
// impure things — the filesystem, the cadence, the listening socket and the
// stdout/stderr sinks — and every one of them arrives through an INJECTED seam,
// so the whole poll loop is driven in tests with no real timer, no real socket
// and no file on disk.
//
// WHAT IT DOES NOT DO, and why (ADR-0191, the honesty clauses):
//   * it never writes. Not a log, not an offset checkpoint, not a temp file.
//     Offsets live in memory only, and the stated cost is that breadcrumbs
//     written while the relay was down are never exported (D2).
//   * it never reads a clock. The cadence comes from the injected timer, the
//     pairing order comes from the host-populated `ts` in the log lines
//     (OBS-43), the carry-over is aged against the largest host `ts` observed,
//     and the /health counter is a monotonic count. There is therefore no
//     `now` seam to inject and no wall-clock skew to reason about.
//   * it has ZERO egress. The reconstructed OTLP/HTTP JSON document is written
//     to STDOUT, exactly as the batch CLI writes it, and nothing ingests it
//     today: the OTLP POST client is parked to 13r-c. That costs no
//     observability while `$trace_pair_set` is empty, because the document is
//     `{"resourceSpans":[]}` regardless of sink.
//   * it accepts three flags and no credential. `ACCEPTED_FLAGS` is an
//     allowlist and every other flag exits 1, because a denylist of
//     credential-shaped names is unclosable (OBS-45).
//
// AM13: an empty or not-yet-created logs directory is NOT fatal here, though it
// is in the batch CLI. Under `restart: unless-stopped` an exit at boot is a
// crash loop, which pins `up=0` and leaves the dead-man's switch this service
// exists to arm permanently firing on a stack that is merely young. The daemon
// warns once and keeps polling; /health answers 200 throughout.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { collectLogFiles, DEFAULT_TRACE_PAIR_SET, loadTracePairSet } from './mr-trace-relay.mjs';
import { reconstruct } from './reconstruct.mjs';
import { carryAfter, decideRead, splitLines } from './tail.mjs';

const SERVICE_NAME = 'mr-trace-relay';

/** Bytes of each file's head that take part in its identity (AM9). */
const HEAD_SAMPLE_BYTES = 64;

/**
 * OBS-45, proven at RUNTIME rather than as a static blacklist: these three and
 * nothing else. A flag the parser never accepts cannot be renamed past a
 * substring check, so this is strictly stronger than enumerating `--token`,
 * `--api-key` and whatever the next credential-shaped spelling turns out to be.
 */
export const ACCEPTED_FLAGS = Object.freeze([
  '--logs-dir',
  '--trace-pair-set',
  '--web.listen-address',
]);

const FLAG_LOGS_DIR = ACCEPTED_FLAGS[0];
const FLAG_TRACE_PAIR_SET = ACCEPTED_FLAGS[1];
const FLAG_LISTEN_ADDRESS = ACCEPTED_FLAGS[2];

/** The poll cadence when the caller pins none. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * AM2/ADR-0191 — the carry-over bounds, exported rather than buried as magic
 * numbers because they are the two decisions that keep a cross-poll pairing
 * buffer from becoming an unbounded leak fed by module output.
 *
 * `maxAgeMicros` is measured against the largest HOST `ts` observed, never
 * against a clock: a relay whose input has gone quiet must not age its buffer
 * out on wall time alone, and this file reads no clock anyway.
 */
export const CARRY_OVER_LIMITS = Object.freeze({
  maxEntries: 1024,
  maxAgeMicros: 60_000_000,
});

const EXPOSITION_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * AM3 — /health serves a REAL Prometheus exposition document, not an empty
 * body. Verified against prom/prometheus:v3.13.2: `ok` yields `up=0`, and so
 * does `204 No Content` (the most idiomatic Node spelling of "empty body"),
 * which would INVERT the dead-man's switch this slice exists to arm. Serving
 * one label-free counter makes the body a valid document by construction, and
 * makes a silently stalled tail visible — which `up` alone cannot catch.
 */
function renderExposition(metrics) {
  return [
    '# HELP mr_trace_relay_lines_read_total Complete log lines the relay has read since start.',
    '# TYPE mr_trace_relay_lines_read_total counter',
    `mr_trace_relay_lines_read_total ${metrics.linesRead}`,
    '# HELP mr_trace_relay_last_read_timestamp_seconds Modification time of the file whose bytes were read last.',
    '# TYPE mr_trace_relay_last_read_timestamp_seconds gauge',
    `mr_trace_relay_last_read_timestamp_seconds ${metrics.lastReadTimestampSeconds}`,
    '',
  ].join('\n');
}

/**
 * The dispatch surface, enumerated POSITIVELY and frozen (AM7).
 *
 * A "there is exactly one listener" compensator cannot see a second route
 * mounted on that same listener, so the route set is asserted as a KEY SET
 * instead: this object has one key, and anything else is a 404.
 */
export const ROUTES = Object.freeze({
  '/health': (daemon) => ({
    statusCode: 200,
    headers: { 'content-type': EXPOSITION_CONTENT_TYPE },
    body: renderExposition(daemon.metrics),
  }),
});

/**
 * AM9b — tail.mjs decides a HALF-OPEN range [readFrom, readTo); node's read
 * streams take an INCLUSIVE `end`. Left unconverted, every chunk boundary
 * re-reads one byte and corrupts the JSON line that straddles it.
 *
 * An empty range returns null: a stream is never opened for zero bytes.
 */
export function readRangeOptions(readFrom, readTo) {
  if (readTo <= readFrom) return null;
  return { start: readFrom, end: readTo - 1 };
}

const usage = [
  `usage: node daemon.mjs ${FLAG_LOGS_DIR} <dir> ${FLAG_LISTEN_ADDRESS} <host:port>`,
  `                       [${FLAG_TRACE_PAIR_SET} <path>]`,
  '  Follows every *.log file under <dir> read-only, reconstructs enter/exit',
  '  spans through the pure core, prints one OTLP/HTTP JSON trace document per',
  '  poll that produced spans on stdout, and serves the scrape endpoint on',
  '  <host:port>. Diagnostics print on stderr. There is no output-file flag and',
  '  no write call of any kind (OBS-45): redirect stdout instead.',
].join('\n');

/**
 * Parse the daemon's argv (D9).
 *
 * Both `--flag value` and `--flag=value` spell the same thing — the compose
 * `command:` list must use the joined form for `checkListenAddrsLoopback` to
 * associate a flag with its value, while a human types the spaced one.
 *
 * There is no default for the logs directory and none for the bind address:
 * absence is a loud exit 1, never a guess. `--trace-pair-set` is the one
 * optional flag and defaults to the committed file next to this module — that
 * is a default PATH, not a default MEMBERSHIP. The file's CONTENT is still read
 * through the 4 fail-loud stages, so a deleted config fails rather than reading
 * as "nothing is instrumented" (OBS-50).
 */
export function parseDaemonArgs(argv) {
  const values = new Map();
  const reject = (detail) => ({ ok: false, exitCode: 1, detail });

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    const joinedAt = item.indexOf('=');
    const name = joinedAt === -1 ? item : item.slice(0, joinedAt);
    if (!ACCEPTED_FLAGS.includes(name)) {
      return reject(
        `unknown argument: ${item} — this daemon accepts EXACTLY ` +
          `[${ACCEPTED_FLAGS.join(', ')}] and rejects every other flag, including every ` +
          'credential-shaped one (OBS-45)',
      );
    }
    let value;
    if (joinedAt === -1) {
      i++;
      if (i >= argv.length) return reject(`${name} requires a value`);
      value = argv[i];
    } else {
      value = item.slice(joinedAt + 1);
    }
    if (value.length === 0) {
      return reject(
        `${name} was given an empty value — that is absence wearing a value-shaped hat`,
      );
    }
    values.set(name, value);
  }

  if (!values.has(FLAG_LOGS_DIR)) {
    return reject(`${FLAG_LOGS_DIR} is required — there is no default logs directory`);
  }
  if (!values.has(FLAG_LISTEN_ADDRESS)) {
    return reject(
      `${FLAG_LISTEN_ADDRESS} is required — a daemon that guesses its bind address binds the ` +
        'wrong interface, and this stack has no boundary other than each process’s own bind',
    );
  }
  return {
    ok: true,
    args: {
      logsDir: values.get(FLAG_LOGS_DIR),
      listenAddress: values.get(FLAG_LISTEN_ADDRESS),
      tracePairSetPath: values.get(FLAG_TRACE_PAIR_SET) ?? DEFAULT_TRACE_PAIR_SET,
    },
  };
}

/** BigInt-safe max over host `ts` digit strings. */
function largerTs(a, b) {
  if (a === null) return b;
  return BigInt(b) > BigInt(a) ? b : a;
}

/**
 * Build the daemon.
 *
 * Seams, all required:
 *   fs      { listLogFiles(dir), statFile(path), readRange(path, from, to) }
 *           — the ONLY filesystem surface, and it is read-only by construction:
 *             there is no write method on it to call.
 *   timer   { schedule(fn, delayMs) } — the ONLY cadence surface.
 *   stdout  (text) => void — the OTLP document sink.
 *   stderr  (text) => void — diagnostics and the AM13 warning.
 *
 * Throws when `tracePairSet` is absent: absence is NOT the empty set, and
 * defaulting it would turn "the config could not be read" into "nothing is
 * instrumented" (OBS-50).
 */
export function createDaemon(options) {
  const {
    args,
    tracePairSet,
    fs,
    timer,
    stdout,
    stderr,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    carryOver = CARRY_OVER_LIMITS,
    serviceName = SERVICE_NAME,
  } = options;

  if (tracePairSet === undefined || tracePairSet === null) {
    throw new Error(
      'createDaemon: no trace_pair_set membership was supplied — absence is NOT the empty set; ' +
        'pass the positively-read allowlist (an empty array is a valid, explicit value)',
    );
  }

  const limits = {
    maxEntries: carryOver.maxEntries ?? CARRY_OVER_LIMITS.maxEntries,
    maxAgeMicros: carryOver.maxAgeMicros ?? CARRY_OVER_LIMITS.maxAgeMicros,
  };

  // path -> { offset, identity, carry }. Offsets and the held partial line live
  // HERE and nowhere else: D2 forbids an on-disk checkpoint.
  const files = new Map();
  // Open enter crumbs from earlier polls, oldest first (AM2).
  let openEnters = [];
  const metrics = { polls: 0, linesRead: 0, lastReadTimestampSeconds: 0 };
  let warnedEmptyDir = false;
  let started = false;

  const daemon = {
    metrics,

    pollOnce() {
      const bootPoll = metrics.polls === 0;
      metrics.polls++;
      const warnings = [];
      const decisions = [];
      const lines = [];
      let discovered = [];
      let listFailed = false;

      try {
        discovered = fs.listLogFiles(args.logsDir);
      } catch {
        listFailed = true;
        discovered = [];
      }

      if (discovered.length === 0 && !warnedEmptyDir) {
        warnedEmptyDir = true;
        const why = listFailed ? 'cannot be read yet' : 'holds no .log file yet';
        const warning =
          `${serviceName}: ${args.logsDir} ${why} — polling anyway. A young or ` +
          'not-yet-created replica tree is not a reason to exit: under `restart: ' +
          'unless-stopped` that is a crash loop, and a crash loop pins up=0 and leaves this ' +
          "service's own dead-man's switch permanently firing.";
        warnings.push(warning);
        stderr(`${warning}\n`);
      }

      let stamp = metrics.lastReadTimestampSeconds;
      for (const filePath of discovered) {
        const observed = fs.statFile(filePath);
        const previous = files.get(filePath);
        // With ZERO bytes read so far the head sample is empty and discriminates
        // nothing, so a growing file would read as a rotation. Both branches
        // decide the identical range ([0, size)) and the carry is provably '',
        // so adopt the fresh identity and report the honest reason.
        const prevState =
          previous === undefined
            ? null
            : {
                offset: previous.offset,
                identity: previous.offset === 0 ? observed.identity : previous.identity,
              };
        const decision = decideRead(prevState, {
          size: observed.size,
          identity: observed.identity,
          startAtEnd: bootPoll,
        });
        const chunk =
          decision.readTo > decision.readFrom
            ? fs.readRange(filePath, decision.readFrom, decision.readTo)
            : '';
        const held = carryAfter(decision, previous === undefined ? '' : previous.carry);
        const split = splitLines(chunk, held);
        for (const line of split.lines) lines.push(line);
        files.set(filePath, {
          offset: decision.readTo,
          identity: observed.identity,
          carry: split.carry,
        });
        if (chunk.length > 0) {
          stamp = Math.max(stamp, Math.floor(observed.mtimeMs / 1000));
        }
        decisions.push({
          path: filePath,
          reason: decision.reason,
          readFrom: decision.readFrom,
          readTo: decision.readTo,
          bytesRead: chunk.length,
        });
      }

      metrics.linesRead += lines.length;
      metrics.lastReadTimestampSeconds = stamp;

      const result = reconstruct(lines, {
        tracePairSet,
        serviceName,
        carryOverCrumbs: openEnters,
      });

      // AM14: a document only when there is something in it. Otherwise the
      // daemon prints an empty span list every poll forever into Docker's
      // json-file driver, which carries no `logging:` limits, for zero
      // information.
      const emitted = result.document.resourceSpans.length > 0;
      if (emitted) stdout(`${JSON.stringify(result.document)}\n`);

      let newest = null;
      for (const span of result.spans) {
        newest = largerTs(largerTs(newest, span.startMicros), span.endMicros);
      }
      for (const entry of result.unpaired) newest = largerTs(newest, entry.ts);

      // An unpaired EXIT can never pair with anything later, so it is dropped
      // here; an unpaired ENTER is carried, bounded twice over.
      const stillOpen = result.unpaired.filter((entry) => entry.phase === 'enter');
      const evicted = [];
      const kept = [];
      for (const entry of stillOpen) {
        const aged =
          newest !== null && BigInt(newest) - BigInt(entry.ts) > BigInt(limits.maxAgeMicros);
        if (aged) evicted.push({ entry, why: 'age' });
        else kept.push(entry);
      }
      while (kept.length > limits.maxEntries) {
        evicted.push({ entry: kept.shift(), why: 'entry count' });
      }
      for (const drop of evicted) {
        // OBS-42: the crumb is NAMED and then forgotten. It never becomes a
        // span — a duration derived from a missing enter would be invented.
        stderr(
          `${serviceName}: carry-over evicted ${drop.entry.key} (reducer ${drop.entry.reducer}, ` +
            `ts ${drop.entry.ts}) — the ${drop.why} bound was reached. No span will ever be ` +
            'emitted for it: an unpaired enter has no measured duration and OBS-42 forbids ' +
            'estimating one.\n',
        );
      }
      openEnters = kept;

      return {
        files: discovered,
        decisions,
        linesRead: lines.length,
        spans: result.spans.length,
        emitted,
        evicted: evicted.map((drop) => ({
          key: drop.entry.key,
          reducer: drop.entry.reducer,
          ts: drop.entry.ts,
          phase: drop.entry.phase,
        })),
        carryOverSize: openEnters.length,
        warnings,
      };
    },

    /**
     * Schedule the FIRST poll and return. This performs no poll itself, and
     * every poll schedules exactly one successor — never two loops racing.
     */
    start() {
      if (started) return;
      started = true;
      const tick = () => {
        try {
          daemon.pollOnce();
        } catch (err) {
          stderr(`${serviceName}: poll failed (${err.message}) — continuing\n`);
        }
        timer.schedule(tick, pollIntervalMs);
      };
      timer.schedule(tick, pollIntervalMs);
    },

    handleRequest(request) {
      const route = Object.hasOwn(ROUTES, request.url) ? ROUTES[request.url] : undefined;
      if (route === undefined) {
        return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: '' };
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return { statusCode: 405, headers: { allow: 'GET, HEAD' }, body: '' };
      }
      const answer = route(daemon);
      if (request.method === 'HEAD') return { ...answer, body: '' };
      return answer;
    },
  };

  return daemon;
}

// ===========================================================================
// Production wiring. Everything below runs only under the main guard.
// ===========================================================================

/**
 * The real filesystem seam.
 *
 * The seam is SYNCHRONOUS by contract (the poll is), and node offers no
 * synchronous ranged read that is not built on `openSync` — a write-capable
 * handle this relay is forbidden to hold (OBS-45/D3). So the real reads happen
 * through `createReadStream`, ASYNCHRONOUSLY, in `refresh()`, which the
 * production timer awaits before it hands control to the poll; the seam methods
 * then answer from what that pass read. `refresh()` plans its reads with the
 * SAME pure `decideRead` the poll uses, over the same observations, so the
 * range the poll asks for is the range already in hand.
 */
function createFileSource(stderr) {
  const planned = new Map();
  let cache = new Map();
  let listing = [];
  let listError = null;
  let firstPass = true;

  async function readSlice(filePath, readFrom, readTo) {
    const range = readRangeOptions(readFrom, readTo);
    if (range === null) return '';
    const pieces = [];
    for await (const piece of createReadStream(filePath, range)) pieces.push(piece);
    return Buffer.concat(pieces).toString('utf8');
  }

  return {
    async refresh(dir) {
      listError = null;
      const fresh = new Map();
      try {
        listing = collectLogFiles(dir);
      } catch (err) {
        listError = err;
        listing = [];
        cache = fresh;
        return;
      }
      const startAtEnd = firstPass;
      firstPass = false;
      for (const filePath of listing) {
        let stat;
        try {
          stat = statSync(filePath);
        } catch {
          continue;
        }
        const head = await readSlice(filePath, 0, Math.min(HEAD_SAMPLE_BYTES, stat.size));
        const identity = {
          dev: String(stat.dev),
          ino: String(stat.ino),
          headSample: head,
          birthtimeMs: stat.birthtimeMs,
        };
        const previous = planned.get(filePath) ?? null;
        const decision = decideRead(previous, { size: stat.size, identity, startAtEnd });
        fresh.set(filePath, {
          stat: { size: stat.size, mtimeMs: stat.mtimeMs, identity },
          from: decision.readFrom,
          to: decision.readTo,
          chunk: await readSlice(filePath, decision.readFrom, decision.readTo),
        });
        planned.set(filePath, { offset: decision.readTo, identity });
      }
      for (const known of planned.keys()) {
        if (!fresh.has(known)) planned.delete(known);
      }
      cache = fresh;
    },

    listLogFiles() {
      if (listError !== null) throw listError;
      return listing.filter((filePath) => cache.has(filePath));
    },

    statFile(filePath) {
      return cache.get(filePath).stat;
    },

    readRange(filePath, from, to) {
      const entry = cache.get(filePath);
      if (entry === undefined || from < entry.from || to > entry.to) {
        stderr(
          `${SERVICE_NAME}: the poll asked for bytes the prefetch pass did not hold for ` +
            `${filePath} — reporting zero bytes rather than guessing at content\n`,
        );
        return '';
      }
      return entry.chunk.slice(from - entry.from, to - entry.from);
    },
  };
}

function serveHealth(daemon, listenAddress) {
  const at = listenAddress.lastIndexOf(':');
  const server = createServer((request, response) => {
    const target = request.url ?? '';
    const query = target.indexOf('?');
    const answer = daemon.handleRequest({
      method: request.method ?? 'GET',
      url: query === -1 ? target : target.slice(0, query),
    });
    response.writeHead(answer.statusCode, answer.headers);
    response.end(answer.body);
  });
  server.listen(Number(listenAddress.slice(at + 1)), listenAddress.slice(0, at));
  return server;
}

function main() {
  const stdout = (text) => process.stdout.write(text);
  const stderr = (text) => process.stderr.write(text);

  const cli = parseDaemonArgs(process.argv.slice(2));
  if (!cli.ok) {
    stderr(`${SERVICE_NAME}: ${cli.detail}\n${usage}\n`);
    process.exitCode = 1;
    return;
  }
  const membership = loadTracePairSet(cli.args.tracePairSetPath);
  if (!membership.ok) {
    stderr(`${SERVICE_NAME}: ${membership.detail}\n`);
    process.exitCode = 1;
    return;
  }

  const source = createFileSource(stderr);
  // The one timer call site in this file. It waits, makes the world readable,
  // and only then hands control to the poll — see createFileSource.
  const timer = {
    schedule(fn, delayMs) {
      setTimeout(() => {
        source.refresh(cli.args.logsDir).then(fn, (err) => {
          stderr(`${SERVICE_NAME}: prefetch failed (${err.message}) — polling anyway\n`);
          fn();
        });
      }, delayMs);
    },
  };

  const daemon = createDaemon({
    args: cli.args,
    tracePairSet: membership.names,
    fs: source,
    timer,
    stdout,
    stderr,
  });
  serveHealth(daemon, cli.args.listenAddress);
  daemon.start();
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
