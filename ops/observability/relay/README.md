# mr-trace-relay

Reconstructs reducer spans from the SpacetimeDB host's module log lines and
encodes them as one OTLP/HTTP JSON trace document (ADR-0180 D15, OBS-42..50).
The host writes structured breadcrumbs (`evt:"span"` with `phase:"enter"` /
`phase:"exit"`) into the module logs; this relay pairs them by correlation
identity and derives exact durations from the host's own microsecond
timestamps.

## What ships here

- **Pure core** — five side-effect-free modules; no filesystem, no clock, no
  sockets, no regex:
  - `parse.mjs` — host-envelope parser. Lifts `ts` from the raw text as a
    digit string (the value exceeds the double's exact range), lifts the
    module payload byte-exact, and rejects a forged duplicate top-level `evt`
    before the inner parse (last-value-wins forgery, AM8).
  - `pair.mjs` — enter/exit pairing. Ordered by `BigInt(ts)` with a pinned
    total tie-break (enter before exit, then correlation identity, then
    reducer); FIFO matching within one exact (reducer, correlation) tuple.
    Unpaired crumbs are diagnostic-only, never spans (AM9).
  - `otlp.mjs` — OTLP/HTTP JSON encoder. 32/16-char lowercase-hex ids derived
    deterministically via sha256; times as exact nanosecond digit strings.
  - `reconstruct.mjs` — the composed pipeline. Requires the membership
    explicitly and THROWS when it is absent: a missing allowlist is not the
    empty allowlist. It returns the leftover crumbs as well as counting them,
    and accepts a caller's still-open crumbs back in, which is what lets the
    daemon pair an enter with an exit that arrives a poll later.
  - `tail.mjs` — the tail state machine. Previous offset plus one fresh
    observation in, a half-open byte range and a reason out. Identity beats
    size: a reused inode or a copytruncate followed by a fast writer both
    present a size that reads as growth while the bytes belong to a different
    file, so a changed identity always restarts at byte 0 and always drops the
    held partial line.
- **`trace-pair-set.json`** — the committed membership (`$trace_pair_set`,
  OBS-50): the allowlist of reducers whose breadcrumbs become spans. It is
  currently EMPTY, deliberately: no reducer carries a paired enter/exit
  breadcrumb yet, and both the JS gate (G9f) and the Rust mirror (G9) assert
  exact set equality between this file and the scanned call sites. Absence of
  the file is a loud failure everywhere; emptiness is an explicit, valid
  state. Prose lives here rather than in the JSON because remote scanners
  treat certain credential-shaped words in config files as findings.
- **`mr-trace-relay.mjs`** — the batch CLI (the only file allowed to touch
  the filesystem, read-only):

  ```
  node ops/observability/relay/mr-trace-relay.mjs --logs-dir <dir> [--trace-pair-set <path>]
  ```

  Reads every `*.log` file under `<dir>` recursively (point it at a replica
  tree containing `module_logs/`, or at a directory holding `.log` files
  directly), reconstructs spans, and prints one OTLP/HTTP JSON trace document
  on **stdout**. Diagnostics (line/crumb accounting) print on stderr. A
  missing or malformed membership config and an empty logs directory are loud
  exit-1 failures, never silently-empty documents.

## The stdout-only contract

There is **no output-file flag and no write call anywhere in this
directory** (OBS-45). The relay reads the same read-only bind mount Alloy
reads, requires and accepts no module-owner credential, and emits on stdout
only — redirect to capture:

```
node ops/observability/relay/mr-trace-relay.mjs --logs-dir /path/to/replicas > /tmp/mr-traces.json
```

This is enforced mechanically: `evals/observability-stack-config.eval.mjs`
(G9i/G9j) scans every `.mjs` here for write APIs, credential surfaces,
sockets, timers, and clock reads in three ban tiers, and pins the production
file set to exactly the seven modules above.

## The daemon (`daemon.mjs`)

The tail-follow shell. It is what the `mr-trace-relay` compose service runs:

```
node /opt/relay/daemon.mjs \
  --logs-dir=/data/module-logs \
  --web.listen-address=127.0.0.1:9101 \
  --trace-pair-set=/opt/relay/trace-pair-set.json
```

Those three flags are the daemon's ENTIRE configuration surface. Any other
flag — credential-shaped or benign — exits 1, and both `--flag value` and
`--flag=value` parse identically. `--trace-pair-set` is the only optional one
and defaults to the committed file next to the module; that is a default
*path*, not a default membership, and the file's content is still read through
the same four fail-loud stages the batch CLI uses.

Each poll lists the `*.log` files under `--logs-dir`, reads only the bytes
that appeared since the last poll, and reconstructs spans. Two sinks, both
of them streams:

- **stdout** — one OTLP/HTTP JSON trace document per poll that produced at
  least one span. Nothing consumes it: **the OTLP POST client is deferred**
  (13r-c), so `docker compose logs mr-trace-relay` is the sink today. That
  costs no observability while `$trace_pair_set` is empty, because the
  document would be `{"resourceSpans":[]}` regardless of sink — but it does
  mean no trace reaches Tempo from this process yet. A poll with no spans
  prints nothing at all.
- **stderr** — the diagnostics: the one-shot warning for an empty or
  not-yet-created logs directory, and one line per carry-over eviction naming
  the dropped correlation key.

`GET /health` on the bind address answers `200` with a real Prometheus
exposition document — `mr_trace_relay_lines_read_total` and
`mr_trace_relay_last_read_timestamp_seconds`, both label-free. That is not
decoration: an empty body (or a `204`) is a scrape parse error, which reports
`up=0` and inverts the dead-man's switch. It is also the only way a *silently
stalled* tail is visible, since a stalled tail keeps `up=1` — the counter goes
flat instead. `/health` is the only route; everything else is 404, and a
non-GET/HEAD method is 405.

An empty or missing logs directory is deliberately **not** fatal here, unlike
in the batch CLI: under `restart: unless-stopped` exiting at boot is a crash
loop, which pins `up=0` and leaves this service's own dead-man's switch firing
on a stack that is merely young. The daemon warns once and keeps polling.

### Stated gaps (ADR-0191 — decisions, not oversights)

- **Files present at boot are seeked to EOF (D2).** Offsets live in memory
  only — there is no checkpoint file, because there is no write call anywhere
  in this directory — so breadcrumbs written while the relay was down are
  never exported. A file first seen on a *later* poll is read from byte 0.
- **Rotation loses the rotated file's tail.** Bytes appended to the old inode
  between two polls end up in `*.log.1`, which the `*.log` walk does not
  read, and a second rotation inside one poll interval loses the middle file
  whole: one identity comparison cannot count rotations.
- **A truncation re-emits the surviving prefix.** `truncated` restarts at
  offset 0 and there is no dedup, by decision.
- **The OTLP POST client is deferred to 13r-c** (see stdout, above). The ban
  on egress in `daemon.mjs` is asserted flatly by G9j, so the moment an
  outbound POST lands there without the park being graduated, the eval reds.
- **The cross-poll carry-over is bounded twice.** An enter waiting for an exit
  is held at most `CARRY_OVER_LIMITS.maxEntries` deep and at most
  `maxAgeMicros` old, aged against the largest host timestamp observed rather
  than against a clock. An evicted enter is named on stderr and never becomes
  a span: OBS-42 forbids inventing the duration.

## Batch smoke (manual)

1. Run the CLI against a captured replica log tree and redirect stdout to a
   file (as above).
2. POST that file with `curl` to the Alloy OTLP/HTTP traces path
   (`/v1/traces` on the Alloy listen address, JSON content type).
3. Confirm the trace in Tempo via the Grafana Explore view, querying the
   `mr-trace-relay` service name.

With the membership empty the document is `{"resourceSpans":[]}` and the
stderr diagnostics say so explicitly (`emptyTracePairSet: true` plus a note),
which distinguishes "configured to trace nothing" from "pipeline broke".

## Tests

```
node --test ops/observability/relay/*.test.mjs
```

The six suites are gating: `evals/observability-stack-config.eval.mjs`
G9k spawns them (plus the m20b checks suites) with a pass floor, and the
golden fixture `fixtures/breadcrumb-golden.json` is shared with the Rust
mirror in `server-module/src/observability_tests.rs` (two-layer contract,
AM4: Rust owns the module-payload layer, JS owns the host-envelope layer).
