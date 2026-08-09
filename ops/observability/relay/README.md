# mr-trace-relay

Reconstructs reducer spans from the SpacetimeDB host's module log lines and
encodes them as one OTLP/HTTP JSON trace document (ADR-0180 D15, OBS-42..50).
The host writes structured breadcrumbs (`evt:"span"` with `phase:"enter"` /
`phase:"exit"`) into the module logs; this relay pairs them by correlation
identity and derives exact durations from the host's own microsecond
timestamps.

## What ships in m20e (this directory)

- **Pure core** — four side-effect-free modules; no filesystem, no clock, no
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
    empty allowlist.
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
sockets, timers, and clock reads, and pins the production file set to exactly
the five modules above.

## Parked to m20e-2 (do not add here)

Per the ADR-0180 m20e amendment, the integration shell is a separate slice:

- the `mr-trace-relay` compose service (eighth service in
  `docker-compose.yml`, with its own read-only mount),
- the `prometheus.yml` scrape job for the relay,
- the Grafana dead-man's-switch alert rule on the relay's `up` metric,
- the `/health` endpoint,
- the tail-follow daemon and the OTLP POST client (batch output is POSTed by
  hand until then — see the batch smoke below).

G9g in the stack-config eval is the park tripwire: it reds the moment any of
these lands, so they cannot creep in silently.

## Batch smoke (manual, until m20e-2)

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

The four suites (65 tests) are gating: `evals/observability-stack-config.eval.mjs`
G9k spawns them (plus the m20b checks suites) with a pass floor, and the
golden fixture `fixtures/breadcrumb-golden.json` is shared with the Rust
mirror in `server-module/src/observability_tests.rs` (two-layer contract,
AM4: Rust owns the module-payload layer, JS owns the host-envelope layer).
