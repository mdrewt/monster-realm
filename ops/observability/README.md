# Observability stack

A self-hosted, open-source monitoring stack for the Monster Realm SpacetimeDB server.
Everything here is configuration: no game code, reducers or schema, and no
module-owner credential. Backup, retention and posture checks are in
[`../../docs/runbooks/observability-dr.md`](../../docs/runbooks/observability-dr.md).

## Rule: the module never times itself or calls out

Every server-side signal comes from the SpacetimeDB **host**. The host serves
`/v1/metrics` over HTTP and writes module logs to rotated files that agents tail
read-only. The module has no exporter reducer, polling loop or outbound call.
OpenTelemetry spans and metrics come only from the browser client.

## Topology

```text
  SpacetimeDB host (127.0.0.1:3000)
    ├── /v1/metrics ─────────── scrape ──> Prometheus :9090
    └── module logs (*.log) ─┬─ read-only ──> Alloy :12345 ──> Loki :3100
                             │                 └── log-derived counters (scraped)
                             └─ read-only ──> mr-trace-relay :9101 ──> stdout
                                                  └── /health (scraped)
  browser (OTel Web SDK)
    └── OTLP/HTTP ──> Caddy :8443 ──> Alloy ──┬──> Tempo :3200     (traces)
                                              └──> Prometheus remote-write (metrics)
  node_exporter :9100 ──── scrape ──> Prometheus
  Prometheus + Loki + Tempo ── query ──> Grafana :3001 ──> unified alerting ──> webhook
```

Eight services in `docker-compose.yml`: prometheus, alloy, loki, tempo, grafana,
node_exporter, caddy (the only built image) and mr-trace-relay (the stock `node` image
running `relay/`). Images are pinned by digest.

## Quick start

```sh
cd ops/observability
cp .env.example .env      # fill it in; several variables are required
docker compose up -d
```

Grafana is at <https://grafana.localhost:8443> behind Caddy's internal TLS certificate
(expect a trust prompt the first time), using the basic-auth credentials from `.env`.
`MR_ALERT_WEBHOOK_URL` is required, and compose refuses to start without it.

Validate the configuration without running it:

```sh
node --test ops/observability/checks/stack-config-checks.test.mjs   # pure config checks (run by just test)
just observability-validate                                         # upstream validators in the pinned images
```

## Network posture

Every service uses the host network and binds `127.0.0.1` only. `ports:` blocks
would do nothing under `network_mode: host`, so each service's own listen flag is the
boundary, and the config checks fail if one is missing. Upstream defaults are
`0.0.0.0`. A bridge network is not an option: Prometheus could not reach a
loopback-bound SpacetimeDB, and binding SpacetimeDB wider exposes `/v1/metrics`, which
answers without authentication.

`MR_CADDY_BIND_ADDR` (`Caddyfile`) is the one setting meant to change if the box is
ever exposed. Everything else stays on loopback.

Caddy applies two policies:

| Route | TLS | Auth | Other controls |
|---|---|---|---|
| `grafana.localhost:8443` | yes | basic auth | operator only |
| `otlp.localhost:8443` | yes | none (browsers post here) | CORS origin scoping, rate limit, body-size cap |

CORS stops other websites from using a visitor's browser to post telemetry; the rate
limit and body cap bound scripted clients. Neither bounds the label space. The
attribute allowlist in `alloy/config.alloy` does that, so a flood of distinct
attributes cannot grow Prometheus series without limit.

## Files

| File | Role |
|---|---|
| `docker-compose.yml` | The service set, digest-pinned images, listen flags, retention flags |
| `prometheus.yml` | Scrape jobs; recording rules only (no `alerting:` block) |
| `rules/recording.rules.yml` | The `mr:*` recording rules |
| `alloy/config.alloy` | Log tail to Loki plus log-derived counters; OTLP intake to Tempo and Prometheus |
| `loki/loki-config.yml`, `tempo/tempo-config.yml` | Log (30 days) and trace (7 days) storage |
| `grafana/provisioning/`, `grafana/dashboards/monster-realm.json` | Datasources, dashboards, alert rules and contact point |
| `Caddyfile`, `Dockerfile` | The two exposure policies; `xcaddy` build with `caddy-ratelimit` |
| `checks/` | Pure configuration predicates and their tests |
| `validate.mjs` | Runs each config through its upstream validator in the pinned image |
| `relay/` | `mr-trace-relay` (see `relay/README.md`) |

Tempo is pinned to the 2.x line; its 7-day retention is the top-level
`compactor.compaction.block_retention` block in `tempo/tempo-config.yml`.

## Alerting

Grafana unified alerting evaluates every alert rule and routes notifications;
Prometheus has recording rules only. The rules (`grafana/provisioning/alerting/rules.yml`)
are `AlloyDown`, `TraceRelayDown`, `AlloyIngestStalled` (liveness is not throughput:
Alloy can be up while its file tail reads nothing) and `ScheduledFunctionDelayed`.

## Licensing

Loki, Tempo and Grafana OSS are AGPLv3; Prometheus, Alloy, node_exporter and Caddy are
Apache-2.0; the relay runs the stock MIT `node` image with this repository's scripts
mounted read-only. AGPL's network clause applies to modified copies served to others.
This deployment runs unmodified images for a single operator, which is why they are
pinned by digest.

## Known limitations

- Resource limits are placeholders; no measured footprint exists yet.
- Nothing ingests the relay's output yet: it prints OTLP JSON on stdout, and its
  reducer allowlist (`relay/trace-pair-set.json`) is empty, so no server spans reach
  Tempo.
