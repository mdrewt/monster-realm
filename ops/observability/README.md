# Observability stack (M20 / ADR-0180)

Self-hosted, all-open-source monitoring for the Monster Realm SpacetimeDB server. Replaces the
harness-default Datadog sink. Everything here is **configuration**; no game code, no reducers, no
schema, and no new module-owner credential.

## Governing invariant

**The server module never times itself and never initiates an outbound call** (ADR-0180 D1).
Every server-side signal is either computed by the SpacetimeDB *host* outside the wasm sandbox and
exposed on an HTTP endpoint, or written by the host to a rotated NDJSON file that an external
agent tails read-only. Real OTel spans exist **client-side only**. That is why there is no
exporter reducer, no polling loop, and no instrumentation seam inside the module.

## Topology

```text
  SpacetimeDB (host process, 127.0.0.1:3000)
    ├── /v1/metrics ─────────── scrape ──> Prometheus :9090
    └── module_logs/*.log ─┬─ read-only ──> Alloy :12345 ──> Loki :3100
                           │                   │  └── log-derived counters, scraped as S1b
                           └─ read-only ──> mr-trace-relay :9101 ──> stdout (no ingest yet)
                                                 └── /health ── scrape ──> Prometheus
  browser (OTel Web SDK, m20c)                 │
    └── OTLP/HTTP ──> Caddy :8443 ──────> Alloy ──┬──> Tempo :3200        (traces)
                                                  └──> Prometheus remote-write (metrics)
  node_exporter :9100 ──────── scrape ──> Prometheus
  Prometheus + Loki + Tempo ── query ───> Grafana :3001 ──> unified alerting ──> webhook
```

Eight containers. The 8th, `mr-trace-relay` (ADR-0180 D15/D17 — server-side causal spans
reconstructed from paired log breadcrumbs), landed in slice **13r-b** with its scrape job and its
dead-man's-switch alert rule. It reads the SAME read-only bind mount Alloy does and prints its
trace document on stdout; nothing ingests that document yet (ADR-0191) — see *Known limitations*
below.

## Quick start

```sh
cd ops/observability
cp .env.example .env      # then fill it in — several variables are REQUIRED
docker compose up -d
```

Then open <https://grafana.localhost:8443> (Caddy issues an internal TLS cert; expect a
first-visit trust prompt) and authenticate with the basic-auth credentials from `.env`.

Validate the configuration without running anything:

```sh
node ops/observability/checks/stack-config-checks.test.mjs   # Tier 1 — pure predicates + teeth
node ops/observability/validate.mjs                          # Tier 2 — upstream validators
```

## Network posture — read this before changing anything

Every service runs on the **host network** and binds **127.0.0.1 only**. There is no `ports:`
block anywhere, deliberately: under `network_mode: host` it is silently inert, so it would be
false comfort rather than a control.

A bridge network is not an option here. A container's `127.0.0.1` is the container itself, and a
socket bound to the host's `127.0.0.1` refuses a connection destined for the bridge gateway — so
Prometheus could not scrape SpacetimeDB at all. Both bridge-preserving repairs require
SpacetimeDB to bind a non-loopback address, which reopens a real hole: `/v1/metrics` is
unauthenticated by a **confirmed, permanent** gap in the shipped 2.6.0 binary, and it discloses
table names, row counts, per-reducer call volumes and connected-player counts.

The trade-off is that each service's **own listen flag** becomes the security boundary. That is
why every one of them is explicit in `docker-compose.yml` and mechanically gated: omission
**fails** the check, because every upstream default is `0.0.0.0` and silence is the trap.

> **`MR_CADDY_BIND_ADDR` is the single variable that changes if this box is ever exposed.**
> Every other service stays loopback-bound permanently. That is the whole change
> `M-playtest-a2` would need to make.

This posture rests on M20's OQ1, which is **answered, not guessed**:
`M-playtest-a-deployment.spec.md` fixes deployment as local-only, no hosted deployment (rescoped
2026-07-17), same box. It is a build-time *snapshot*, not an enforced invariant — see §7 of the
[DR runbook](../../docs/observability-dr-runbook.md) for the drift check.

## Two exposure policies, not one

Caddy is the only process with an externally-facing policy, and it applies **two different
rules** — an anonymous game client structurally cannot present Grafana's login:

| Route | TLS | Auth | Other controls |
|---|---|---|---|
| `grafana.localhost:8443` | yes | **required** (basic auth) | operator-only |
| `otlp.localhost:8443` | yes | **none, by design** | CORS origin scoping, rate limit, body-size cap |

**CORS and the rate limit defend different threats.** CORS is browser-enforced: it stops another
website using a victim's browser to cross-origin-post telemetry here. A direct scripted client
(curl, a bot, a load tool) simply omits or forges the `Origin` header and is unaffected. Against
*that* threat the rate limit and body cap are the actual control — CORS is not a redundant third
leg.

Neither of those bounds the **label space** one well-formed request can introduce. That is a
separate control: the S4 attribute allowlist in `alloy/config.alloy`, without which a `curl` loop
sending one distinct attribute per request grows Prometheus active series without bound until it
OOMs — taking down the store that every dashboard *and the dead-man's-switch alert itself* depend
on to evaluate.

## Files

| File | Role |
|---|---|
| `docker-compose.yml` | The 7-service SSOT. Digest-pinned stock images; Caddy alone is built. |
| `prometheus.yml` | S1/S1b/node_exporter scrape jobs. **Recording rules only** — no `alerting:` block. |
| `rules/recording.rules.yml` | The `mr:*` vocabulary, and the SSOT for the `$slo_set` allowlist. |
| `alloy/config.alloy` | S2 file tail → Loki (+ log-derived counters); S4 OTLP → Tempo / remote-write. |
| `loki/loki-config.yml` | Log storage, 30d retention. |
| `tempo/tempo-config.yml` | Trace storage, 7d block retention. |
| `grafana/provisioning/` | Datasources (+ the `connection_id` correlation pivot), dashboards, alerting. |
| `grafana/dashboards/monster-realm.json` | RED / SLO / saturation panels. |
| `Caddyfile`, `Dockerfile` | Dual exposure policy; `xcaddy` build with `caddy-ratelimit`. |
| `checks/` | The Tier-1 predicate library + its proof-of-teeth suite. |
| `validate.mjs` | Tier-2: each config through its own upstream validator, via the pinned image. |

**Image pins.** All images are digest-pinned, which is what makes the "stock, unmodified" claim above
checkable. Tempo is the one exception to "current stable": it is pinned to the **2.x LTS track**, because
Tempo 3.0.x restructured `app.Config` and dropped the top-level `compactor` key that D11's `block_retention`
retention setting requires. `validate.mjs` is what caught it.

## Alerting

Grafana OSS unified alerting owns **100%** of rule evaluation and notification routing (D4).
Prometheus computes recording rules only and has no `alerting:` block, because its only sink
would be an Alertmanager — and there is none by design (OBS-19). An `alert:` rule there would
evaluate into nothing.

Two rules ship:

- **`AlloyDown`** — the sole telemetry agent's dead-man's switch (OBS-39).
- **`AlloyIngestStalled`** — because `up` is *not* pipeline health. Alloy hosts independent
  internal components; if the file tail stalls, `up` stays `1` while ingestion is entirely dark.

`MR_ALERT_WEBHOOK_URL` is **required**. An alerting stack whose contact point notifies nobody is
the same failure as having no alerting at all.

## Retention

Prometheus 30d · Loki 30d · Tempo 7d. See [the runbook](../../docs/observability-dr-runbook.md)
§3 for the exact knob and file for each. Note Loki needs **both** `retention_period` *and*
`compactor.retention_enabled: true` — the first alone is a documented no-op.

## Licensing (OBS-33)

Loki, Tempo and Grafana OSS are **AGPLv3**; Prometheus, Alloy, node_exporter and Caddy are
Apache-2.0, and `mr-trace-relay` runs the stock MIT-licensed `node` image with this repo's own
scripts bind-mounted read-only (no image is built for it). AGPL's network-copyleft clause triggers
on distributing a *modified* copy to other users over a network. This deployment runs **stock, unmodified** vendor images — configured only,
for a single operator — so nothing triggers it. **That conclusion is contingent on staying
stock**, which is why the images are digest-pinned and the pins are asserted by a test. Caddy is
the sole built image, and Caddy is Apache-2.0.

## Deliberately absent

- **Alertmanager, Datadog, Vector, a standalone OTel Collector, Pushgateway, any bespoke exporter**
  (OBS-37). Asserted by exact service-set equality, not by absence checks.
- **A reverse proxy in front of SpacetimeDB itself** (OBS-17) — not triggered, because OQ1
  resolves the port as loopback-bound.

## Known limitations, stated rather than papered over

- **Resource caps are placeholders.** M20 §5 sequences this slice in *parallel* with m20d
  (`mr-load-driver`), so no measured footprint exists yet. Re-size at post-integration
  verification.
- **Nothing ingests the relay's trace document yet.** `mr-trace-relay` runs, is scraped and is
  dead-man's-switched, but its OTLP/HTTP JSON document goes to stdout: the OTLP POST client is
  deferred to a follow-up slice (ADR-0191). It costs no signal today because `$trace_pair_set` is
  empty, so the document is `{"resourceSpans":[]}` whatever the sink.
- **The `connection_id` correlation pivot is not verifiable end-to-end yet.** Tempo holds no
  server spans until the relay POSTs them and no client spans until m20c. The config is correct
  and inert.
- **The `heartbeat` half of the `evt` vocabulary is written against an unmerged contract.**
  `mr_log`/`mr_heartbeat` are m20a's, and m20a may still adjust the envelope. Per M20 §5's own
  stated mitigation, drift is caught by m20e's post-merge integration eval, not by a pre-merge
  check. The `reject` half has no such dependency — `guards::log_reject` ships today.
- **Nothing here is wired into `just ci`.** The justfile belongs to m20a's `touches:` set, and the
  CI-wired eval (`evals/observability-stack-config.eval.mjs`) is m20e's. `checks/` is written as
  an importable predicate library precisely so m20e wires it rather than re-implements it.
