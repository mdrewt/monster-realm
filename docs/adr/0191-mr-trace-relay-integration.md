# 0191 — `mr-trace-relay` integration: the 8th service, its scrape target and its dead-man's switch land as one change

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 13r-b (M-postgate thirteenth-review residuals §13r-b)
**Supersedes:** —
**Amends:** ADR-0180
**Subsystems:** ci-gates, tooling-docs
**Decision:** Ship the relay as an 8th compose service (node, uid 473, Alloy's read-only replicas mount) serving a one-counter exposition body on `/health`, plus its scrape job and a distinct dead-man's-switch rule. OTLP POST deferred.

## Context

OBS-45 and OBS-46 (`specs/monster-realm-v2/M20-observability-performance.spec.md:537-547`) were parked
by m20e as **"m20e-2" (formerly mislabelled "m20b-2")** — ADR-0180:1020 parks *all of OBS-46 as a
unit*: the compose service, the `:ro` module-logs mount, the `job="mr-trace-relay"` scrape target, the
Grafana alert rule, the `/health` endpoint and the tail-follow daemon. m20e shipped only the relay's
pure core and a batch stdout CLI. This slice delivers the parked half and discharges that named
forward obligation; the stale `m20b-2` labels ADR-0180:1020 assigns to the same follow-up are
rewritten in `docker-compose.yml:26-30`, `prometheus.yml:43-49` and
`grafana/provisioning/alerting/rules.yml:11-16`.

**The atomicity is mechanical, not rhetorical.** `checkListenAddrsLoopback`
(`ops/observability/checks/stack-config-checks.mjs:456-512`) **fails closed** at `:494-499` for any
service declaring none of the five allowlisted listen flags — "silence is the trap", because every
upstream default is `0.0.0.0`. It runs as C6 in `evals/observability-stack-config.eval.mjs` and again
as that module's own REAL-FILES test. So an 8th compose service **structurally cannot exist** without
a declared, loopback-bound listening process: "ship the mount, defer `/health`" was never an
available split. The other direction was already closed in writing — ADR-0180:1020 calls a `/health`
server nothing scrapes "the dead code the m20b park declined to ship", and a scrape target with no
process behind it pins `up=0` forever, which trains the operator to ignore the one switch this
service exists to arm. Both naive splits are illegal; the three files land together or not at all.

## Decision

### D1 — `/health` serves a real, LABEL-FREE exposition body, not an empty one

OBS-46 says "a bare 200 response is sufficient". That is wrong about Prometheus, which **parses the
scrape body**. Verified live against the pinned `prom/prometheus:v3.13.2`: a 200 carrying `ok` yields
`up=0`, and so does **`204 No Content`** — the most idiomatic Node spelling of "empty body", and the
landmine nobody had named. Either one **inverts the dead-man's switch**: the alert fires permanently
against a healthy relay, which is the exact failure the m20e-2 park warned about.

`/health` therefore returns 200 with `content-type: text/plain; version=0.0.4; charset=utf-8` and a
two-series document (`ops/observability/relay/daemon.mjs:93-103`):

```
mr_trace_relay_lines_read_total          counter   complete log lines read since start
mr_trace_relay_last_read_timestamp_seconds  gauge   mtime of the file whose bytes were read last
```

Both are label-free, so the cardinality cost is exactly two series. Rejected alternative: an empty
200 body. It parses to zero samples and *also* yields `up=1`, so it is not wrong — but it leaves the
whole "a 200 whose body Prometheus cannot parse" class one edit away, and it buys nothing. A real
body makes the document valid **by construction** at equal code size.

**This discharges ADR-0180's "Correction 3" residual for this service** rather than re-declaring it.
`up` proves only that the HTTP server answers; a stalled tail keeps `up=1`. The counter closes that:
a tail that stops advancing stops advancing `mr_trace_relay_lines_read_total` and the gauge stops
moving. That is directly why the counter was chosen — the residual's own failure mode (a wrong
host-side mount mode) is silent. The residual is therefore **discharged here, not re-parked**.

Consequence inside the eval: `HOST_NATIVE_ALLOWLIST`
(`evals/observability-stack-config.eval.mjs:301-310`) gains `'mr_trace_relay_'`, or C15
(`checkQueriedSeriesAreDefined`) reads the new series as dangling.

### D2 — the mount SOURCE is byte-identical to Alloy's; the container TARGET is `/data/module-logs`

OBS-45's "the same read-only bind mount as Alloy" is a claim about the **host source**, and that is
what ships: `${MR_SPACETIME_DATA_DIR:-/var/lib/spacetime}/replicas` string-equal to
`docker-compose.yml:92` (`docker-compose.yml:250`). A second host path holding a copy of the same
files is not the same mount and drifts the first time either side is re-pointed.

The **container target is `/data/module-logs`, not `/data/replicas`**, and that is forced.
`checkModuleLogsMountReadOnly` (`ops/observability/checks/stack-config-checks.mjs:426-433`) counts
**any** whole-file line trimming to `- …replicas…` (without `type:`) as a mount and requires it to end
`:ro`. A compose `command:` list item `- --logs-dir=/data/replicas` is such a line, so it would be
read as a writable mount and red that check — proven by executing it, not inferred. Dropping the
substring from the target and from `--logs-dir` costs nothing and keeps the predicate honest.

Alternative rejected: teaching `checkModuleLogsMountReadOnly` to distinguish a `volumes:` item from a
`command:` item. That is the right fix and it is a checks-module edit outside this slice's
touch-set — the same hidden-dependency class ADR-0190 D1 parked.

### D3 — `user: "473:473"`, the uid Alloy already uses

Both services read the same host directory. A second uid (`65534:65534`, the stack's other
unprivileged identity and this slice's first choice) would force the
operator to widen host-side `r-x` on `${MR_SPACETIME_DATA_DIR}/replicas` to a second identity for
zero benefit, adding an avoidable precondition whose failure mode is silent (see Residuals). The uid
is numeric for the reason ADR-0190 D2 gives: a name is resolved in-container against `/etc/passwd`,
so an image rebuild could renumber it while the compose file still read correctly.

### D4 — `command:` must BEGIN with `node /opt/relay/daemon.mjs`

The `node:*-alpine` entrypoint does `set -- node "$@"` only when `$1` does **not** start with `-`. A
list whose first item is `--logs-dir=…` is therefore handed to **node itself** as a CLI option and the
container dies on start. The full list form (`node`, the script path, then the flags) fixes it and
still declares **no `entrypoint:`** — a replaced entrypoint is unbounded by any marker list, which is
the reason `checkNoExecLogSource` bans one for alloy (`stack-config-checks.mjs:539-570`) and the
reason G9n bans one here. The service also declares no `environment:` key and no `env_file:`: the
node runtime reads `NODE_OPTIONS`, `HTTPS_PROXY` and friends from the environment, so a denylist of
variable names is unclosable. The relay's entire configuration surface is its three flags.

### D5 — no offset checkpoint file, ever

OBS-45 admits no write, and the G9i `WRITE_APIS` ban is the only version of "never writes" a static
scan can actually prove. Persisting a tail offset is a write, so offsets, the held partial line and
the pairing carry-over all live **in memory only** (`daemon.mjs:252-259`). Files present at boot seek
to EOF; a file first seen on a later poll is read from byte 0. The cost is stated in D8 below rather
than discovered later.

### D6 — cross-poll carry-over of unpaired `enter` breadcrumbs, bounded by entries AND age

`reconstruct()` pairs FIFO **within one invocation**, so a daemon calling it once per poll would drop
every span whose `enter` arrived in poll N and whose `exit` arrived in poll N+1 — silently, because
`unpaired` was count-only. `reconstruct` now also returns the unpaired **array** (additive; the batch
CLI and the four pure suites are unaffected), and the daemon keeps the open `enter` crumbs.

Two bounds, both decisions of this ADR (`daemon.mjs:78-81`): `maxEntries: 1024` and
`maxAgeMicros: 60_000_000`. Age is measured against the **largest host `ts` observed**, never against
a clock — the daemon reads no clock at all, so there is no `now` seam and no wall-clock skew to
reason about, and a relay whose input has gone quiet does not age its buffer out on wall time. An
unpaired `exit` can pair with nothing later and is dropped immediately. **Eviction emits a
diagnostic on stderr naming the crumb and never emits a span** (`daemon.mjs:372-381`): OBS-42 forbids
estimating a duration, and an `enter` without its `exit` has none.

### D7 — the flag is `--web.listen-address`, and the relay is the SECOND service bent to a hardcoded list

The name is chosen on **Prometheus-ecosystem convention** grounds: the relay *is* a scrape target, and
that is the spelling the ecosystem uses for one. Checker compatibility is a **consequence**, not the
reason — but it would have forced the same answer anyway, and that is worth saying plainly rather
than leaving a future reader to discover it. `LISTEN_FLAGS`
(`ops/observability/checks/stack-config-checks.mjs:448-454`) is a hardcoded five-entry literal list
and `checkListenAddrsLoopback` fails closed for a service matching none of them, so a natural
`--health-listen-addr=` would red C6 and force an out-of-scope checks-module edit.

**The relay is the second service bent to that list.** The first is tempo, whose compose block keeps
`-server.http-listen-address=127.0.0.1` — a flag `grafana/tempo:2.10.7` **cannot parse**, so the
container dies on start — retained at `docker-compose.yml:130-140` **solely to keep the predicate
green** (ADR-0190 D1). Two services now shaped by a five-element literal is the point at which the
literal is the defect. The right follow-up is not a sixth entry: it is the per-service binding
sources already prescribed verbatim at `evals/observability-stack-config.eval.mjs:142-158` and in
`TEMPO_PARK_PRESCRIPTION` (`:2435-2441`) — `checkListenAddrsLoopback` stops being a flat
`LISTEN_FLAGS` scan and reads each service's real binding from where that service actually declares
it.

### D8 — what this does NOT do (stated, not implied)

1. **Nothing ingests the relay's output.** As shipped, the daemon answers `/health` and prints its
   OTLP/HTTP JSON trace document to **stdout** — the identical contract the batch CLI already carries
   (`relay/mr-trace-relay.mjs:4-12`) — and `docker compose logs mr-trace-relay` is the sink. The OTLP
   POST client is **deferred and parked as P5**, verbatim, at
   `evals/observability-stack-config.eval.mjs:179-199`. Building it now would add an HTTP egress
   surface, a retry/backoff state machine and a header-allowlist obligation in order to POST an empty
   array on a loop. The park is mechanized, not remembered: the daemon has **zero egress** and G9j's
   DAEMON tier bans `fetch(`, `.request(`, `.connect(`, `node:https`, `node:net` and `undici` flatly,
   so the first outbound POST reds the gate and names P5. The deferral also made the gate *stronger*
   — a flat ban replaced a conditional-egress gate.
2. **`$trace_pair_set` is ∅**, so the emitted document is `{"resourceSpans":[]}` **regardless of
   sink**. This is the original m20b objection (ADR-0180:928-935): the relay's only input is
   `phase:"enter"`/`phase:"exit"` breadcrumbs from domain reducers, OBS-41 still has no implementing
   slice, and no merged or planned slice emits one. It does **not** block OBS-45/OBS-46 — both are
   criteria about the read path, the scrape target and the alert — but nothing end-to-end can prove a
   span reaches Tempo, and no reader should infer otherwise from a green stack. The un-defer trigger
   is already mechanized as G9h, which reds at first membership.
3. **Two stated gaps in the tail** (`relay/README.md:120-131`), decisions rather than oversights:
   files present at boot seek to EOF, so breadcrumbs written while the relay was down are never
   exported (D5); and bytes appended to a rotated file **between two polls** end up in `*.log.1`,
   which the `*.log` walk does not read, so they are lost on every rotation. A second rotation inside
   one poll interval loses the middle file whole — one identity comparison cannot count rotations.
   A `truncated` restart re-emits the surviving prefix; there is no dedup, by decision.

Identity is `{dev, ino, headSample(64 bytes), birthtimeMs}` and **identity beats size** in the
precedence order (`relay/tail.mjs:15-24`): copytruncate followed by a fast writer, and an inode reused
by the rotator, both present as `growth` to a size comparison alone and deliver a corrupt first line.
The held partial line is dropped on every restart (`carryAfter`, `tail.mjs:124-127`) because log
content is module output — attacker-influenced — so a naive splice of an old tail onto a new head can
be crafted into a valid-looking breadcrumb naming a correlation key that existed in no file.

## Consequences

**Gates.** Three new always-on gates in `evals/observability-stack-config.eval.mjs`, each scoped
rather than file-wide because the file-wide version of each is provably false-green:

- **G9n** — the relay's own `volumes:` sub-block: a mount whose **source half is string-equal to
  Alloy's**, ending `:ro`, with `--logs-dir` pointing inside that mount's container target; plus no
  `entrypoint:`, no shell marker, no `env_file:`, no `environment:` key at all, and a `command:`
  flag-name allowlist. This closes a real vacuity floor: C5's only non-vacuity check is `found === 0`
  (`stack-config-checks.mjs:436`), so a relay with **no mount at all** leaves alloy's `found === 1`
  and C5 still passes. C5 can reject a `:rw` relay mount; it cannot prove the relay has one.
- **G9o** — `job_name: mr-trace-relay` resolved **inside `scrape_configs:`** (a top-level `x-parked:`
  decoy otherwise satisfies a flat line scan while Prometheus scrapes nothing), `metrics_path:
  /health`, loopback host, and a port **cross-resolved from the relay's own scoped compose block** —
  a file-wide search for `--web.listen-address=` returns **prometheus's 9090**
  (`docker-compose.yml:52`, the first occurrence) and would compare the wrong two numbers.
- **G9p** — the switch asserted as something that can actually FIRE. Beyond "an expr mentioning the
  relay job": the `condition:` refId must resolve to a threshold node over the refId carrying the
  relay expr, and its node type, evaluator type, params, `datasourceUid`, `severity` label and `for:`
  are all **derived from AlloyDown in the same document** rather than re-spelled. Not paused, uid
  distinct, group interval no coarser than AlloyDown's, and the relay expr must not also match
  `job="alloy"` (spec:542-547 calls one rule watching two processes unbuildable). `for:` is an
  **equality** check, not a lower bound — a `for: 24h` dead-man's switch passes a `>=`. `severity:
  critical` is mirrored because `notification-policies.yml:8-9` routes on it: without it the relay
  rule silently takes the catch-all 4h repeat interval instead of its sibling's 1h.

**Teeth.** T-a is **inverted** (the 8-service compose is now the shape that must be ACCEPTED, the
7-service one the shape that must not); T-m/T-n/T-o/T-p are new, and per this repo's recorded
red-team lesson they were written as **executed cheats** rather than as reviews of the detectors.
G9g — the m20e-2 park tripwire, with its `checkNoRelayScrapeJob`/`checkNoRelayAlertRule` negatives —
is **deleted rather than inverted in place**: a same-named predicate whose polarity flipped is a trap
for the next reader.

**Three mutation bite-proofs against the REAL committed config**, not fixtures. Each reds with a
precise message naming the failure:

| mutation | gate | what it says |
|---|---|---|
| relay mount `:ro` → `:rw` | G9n | the mount "is not `:ro`. A bare short-form mount defaults to READ-WRITE in Docker, so omission is the trap" |
| scrape target port ≠ the relay's `--web.listen-address` port | G9o | "Co-occurrence is not wiring: a job and a service that merely exist in the same repo produce `up=0` forever" |
| alert evaluator `lt` → `gt` | G9p | "Direction is the whole switch: `up` is 1 when the target is healthy, so a `gt 1` evaluator NEVER fires and a `gt 0` evaluator fires while the relay is FINE. The expr, the uid, the for: and the datasource all stay correct through that mutation." |

**Bookkeeping.** `NODE_TEST_PASS_FLOOR` moves **181 → 243** (re-derived with the documented command,
never guessed) as `tail.test.mjs` and `daemon.test.mjs` join G9k's spawn. `EXPECTED_SERVICE_NAMES` and
the `(exact 7)` → `(exact 8)` title in `checks/stack-config-checks.test.mjs` are the mechanical
consequence of the 8th service and were the hidden dependency that parked the slice's first attempt.
`ALLOWED_IMAGE_REPOS` gains `mr-trace-relay: 'node'` (C4 requires the image-bearing service set to
equal that map's key set exactly). The daemon's hygiene bans were **retiered, not relaxed**: the pure
tier keeps all eight, the DAEMON tier relaxes `node:http`, `.listen(` and exactly one of
`setinterval(`/`settimeout(` — `date.now(` **stays banned**, since nothing in the daemon reads
wall-clock time — and `daemon.test.mjs` keeps all eight unrelaxed, which is what mechanically forces
the injected seams instead of trusting the author to build them.

**Live proof.** L2 (`MR_OBS_STACK=1`) reads Prometheus's own targets API and requires the
`mr-trace-relay` target at `health: "up"`. It is the criterion-level proof of OBS-46 and the only
thing that catches a `/health` body Prometheus cannot parse; the skip is **stated** when the flag is
absent, never silent. The seam is mandatory rather than stylistic — Docker Desktop scopes
`network_mode: host` to its own VM, so WSL-native node cannot reach the stack's loopback
(ADR-0180:1032).

**Residual / operator risk (high, inherited from ADR-0190 D2, now shared).** As uid 473 the relay
needs host-side **`r-x` on `${MR_SPACETIME_DATA_DIR}/replicas`** and on every component of that path.
A wrong mode is a **silent tail stall**, not a crash — the process stays up, `/health` answers 200
and `up` stays 1. That is precisely why D1 chose a throughput counter over an empty body: the stall
is now visible as a flat `mr_trace_relay_lines_read_total`. The precondition and its check are in
`docs/observability-dr-runbook.md` §7.1 (`:165-181`).

**Runtime evidence recorded elsewhere.** The hardened-runtime risk was retired by an executed probe:
`node:24-alpine` under `--read-only --cap-drop ALL --security-opt no-new-privileges:true` served HTTP
with `exit=0`, `restarts=0`, no tmpfs and no writable `/tmp`. That probe ran as uid 65534, before D3
moved the shipped uid to 473; it holds only while the daemon stays dependency-free and never touches
`os.tmpdir()`. This ADR records **no eight-service `docker compose up -d` boot** of its own — ADR-0190
D6 carries the stack's boot evidence of record, and tempo (D1 there) and caddy (D3b there) remain
parked on hidden dependencies that this slice does not touch.

**Out-of-touch-set doc drift, flagged not edited:** `ops/observability/tempo/tempo-config.yml:5` and
`grafana/provisioning/datasources/datasources.yml:16` still carry stale slice labels.
