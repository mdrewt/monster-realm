# mr-trace-relay

Rebuilds reducer spans from the SpacetimeDB host's module log lines and encodes them
as an OTLP/HTTP JSON trace document. Module code writes structured breadcrumbs
(`evt:"span"` with `phase:"enter"` / `phase:"exit"`); the relay pairs them by
correlation identity and computes durations from the host's microsecond timestamps.

## Modules

Pure core (no filesystem, clock, sockets or regular expressions):

- `parse.mjs`: parses the host log envelope. It keeps `ts` as a digit string (it
  exceeds a double's exact range), extracts the module payload byte-exact, and rejects
  a duplicated top-level `evt`.
- `pair.mjs`: pairs enter and exit breadcrumbs, ordered by `BigInt(ts)` with a fixed
  tie-break, FIFO within one (reducer, correlation) pair. An unpaired breadcrumb is
  counted, never turned into a span.
- `otlp.mjs`: the OTLP/HTTP JSON encoder (sha256-derived hex ids, nanosecond digit
  strings for times).
- `reconstruct.mjs`: the composed pipeline. It throws if the reducer allowlist is
  missing (missing is not the same as empty) and carries unmatched enters between
  polls.
- `tail.mjs`: the tail state machine (previous offset plus one file observation gives
  a byte range). A changed file identity restarts at byte 0.

Shells:

- `mr-trace-relay.mjs`: the batch CLI. It reads every `*.log` under a directory and
  prints one trace document on stdout, with diagnostics on stderr:

  ```sh
  node ops/observability/relay/mr-trace-relay.mjs --logs-dir <dir> [--trace-pair-set <path>] > traces.json
  ```

  A missing or malformed allowlist, or an empty logs directory, is an exit-1 failure.
- `daemon.mjs`: the tail-follow service run by the `mr-trace-relay` compose service.
  It accepts exactly three flags (`--logs-dir`, `--web.listen-address`, and the
  optional `--trace-pair-set`, which defaults to the committed file) and exits 1 on
  any other. Each poll reads only newly appended bytes and prints one document per poll
  that produced spans. `GET /health` returns a Prometheus exposition with
  `mr_trace_relay_lines_read_total` and `mr_trace_relay_last_read_timestamp_seconds`;
  a flat counter on a live process means the tail is stalled (see the DR runbook's
  mount-permission section). An empty or missing logs directory is only a warning
  here, so the service does not crash-loop on a new stack.

`trace-pair-set.json` is the allowlist of reducers whose breadcrumbs become spans. It
is empty today, so every document is `{"resourceSpans":[]}`, and the stderr
diagnostics say so (`emptyTracePairSet: true`).

## Contract

- **Reads only.** Nothing in this directory writes files; output goes to stdout. The
  relay reads the same read-only mount as Alloy and needs no credential.
- **No egress yet.** There is no OTLP POST client, so the documents are not sent to
  Tempo. `docker compose logs mr-trace-relay` is where they go today.
- **Known gaps.** Offsets live only in memory, so files present at startup are read
  from the end (breadcrumbs written while the relay was down are lost). A rotation can
  lose the tail of the rotated file (`*.log.1` is not read). A truncation re-emits the
  surviving prefix. Unmatched enters are held for a bounded count and age
  (`CARRY_OVER_LIMITS`), and an evicted enter is reported on stderr, never guessed
  into a span.

## Manual end-to-end check

1. Run the batch CLI against a captured log tree and save stdout.
2. POST the file to Alloy's OTLP/HTTP traces path (`/v1/traces`, JSON content type).
3. Find the trace in Grafana Explore (Tempo), service `mr-trace-relay`.

## Tests

```sh
node --test ops/observability/relay/*.test.mjs
```

`just test` runs these with the stack-config suite. `fixtures/breadcrumb-golden.json`
is shared with the Rust side (`server-module/src/observability_tests.rs`): Rust owns
the module-payload format, and these tests own the host envelope.
