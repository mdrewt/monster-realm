# 0180 — Observability stack selection: self-hosted OSS replaces Datadog, and the WASM-sandbox-crossing data path

**Status:** Accepted
**Date:** 2026-08-08
**Slice:** heavy-ceremony M20 planning pass (pre-slice; implementation elaborates in m20a–m20e per
`specs/monster-realm-v2/M20-observability-performance.spec.md` §5)
**Supersedes:** —
**Amends:** ADR-0029 (harness spec corpus — elaborates the 2026-08-08 Datadog→self-hosted-OSS amendment
there into concrete tool selection + data-path architecture; corrects ADR-0029's own "M0 already wired the
substrate" consequence line)
**Subsystems:** ci-gates, tooling-docs, schema-persistence
**Decision:** A 7-container, all-open-source, self-hosted stack (Prometheus, Grafana Alloy, Loki, Tempo,
Grafana OSS, node_exporter, Caddy) replaces the harness-default Datadog sink; the module never times or
exports itself — every server signal is either host-computed (SpacetimeDB's own `/v1/metrics`/logs/health,
free, zero module code) or client-side real OTel; a private domain-metric table + polling exporter (the
naive way to get custom metrics) is cut for v1 as unnecessary once the host's free signals are used, and
kept only as an explicit, RLS-gated escape hatch.

## Context

ADR-0029 (accepted, harness spec corpus) made the top-level call for M20's original scope: a three-layer
observability strategy (always-on M0 substrate, a per-milestone invariant, an M20 capstone) with OTel
instrumentation exporting to Datadog dashboards/alerts. Drew explicitly overrode the Datadog half of that
decision (2026-08-08, interactive) in favor of a self-hosted, free, OSS stack — recorded as an amendment on
ADR-0029 itself. **This ADR does not re-litigate that override** — it is the concrete tool-selection and
data-path design the ADR-0029 amendment named as a follow-up, the same relationship ADR-0179 has to
ADR-0030.

That design was produced by the harness's heavy-ceremony planning pipeline
(`memory/projects/mr-feedback-doctrine.md` §6): an investigation pass, six independent brainstormers each
refined by their own adversarial reviewer, a judge synthesis, and a second adversarial-refinement pass. The
second pass did not just re-argue the judge's evidence from its chair — it independently reproduced it: it
installed the pinned `spacetime` 2.6.0 CLI, started two fresh standalone instances from empty data
directories (one `--in-memory`, one persistent), published the repo's actual
`target/wasm32-unknown-unknown/release/monster_realm_module.wasm` to both, and drove the same probes the
judge's synthesis described — `/v1/metrics` before/after publish, `/v1/health`, `spacetime logs` in text and
JSON, the on-disk `module_logs/*.log`, commitlog file sizes, `spacetime sql` (including a deliberate
`ORDER BY` to reproduce a documented limitation), and a raw `POST /v1/database/<id>/sql` call. It also
pulled the actual `MetricsAuthMiddleware` source from `clockworklabs/SpacetimeDB` and the real timestamps on
GitHub issue #846 and PR #1013, rather than trusting a prior summary. Instances were torn down after;
nothing in the repository was touched by the verification itself.

**The overwhelming majority of the evidence ledger reproduced exactly**, not approximately: 32 metric
families on a fresh instance with no database, exactly 88 after publish; RED-per-reducer metrics
pre-registered at zero for every reducer including the scheduled `movement_tick`, before any of them had
ever run; a cross-file structured-log attribution (`guards.rs:55`'s `log_reject` helper produces a line
whose host-populated `function` field names the *calling reducer*, `set_profile_name`, not the helper) byte-
for-byte reproduced; the commitlog `.stdb.ofs` file exactly 4,194,304 bytes; `just ci`'s recipe exactly
`lint typecheck test eval security wasm client-typecheck client-test`. This gave four genuine defects to fix,
not a wholesale re-design:

1. **A factual error.** The synthesis claimed both `/v1/metrics` *and* `/v1/database/<id>/logs` are
   unauthenticated. Only the first is true. `/v1/metrics` is confirmed open — and confirmed *why*: the
   upstream `crates/client-api/src/routes/metrics.rs` has `MetricsAuthMiddleware` written but commented out
   behind a literal `// TODO: .layer(MetricsAuthMiddleware)`, a permanent gap in the shipped binary, not a
   config toggle. `/v1/database/<id>/logs` (the HTTP endpoint — **not** the on-disk file S2 actually tails)
   returned `403 Forbidden` to an anonymous request on two independent fresh instances, reproduced
   identically both times: `"<identity> is not authorized to perform action on database <id>: view module
   logs"`. This is corrected throughout (§Network posture below); it retroactively strengthens the case for
   tailing the file rather than calling the HTTP endpoint, since the file needs only OS bind-mount
   permissions, whereas the endpoint would need a credential this design specifically avoids issuing.
2. **A mis-cited date.** GitHub issue #846 (debug-symbol stripping in wasm-opt) closed 2024-11-04, not
   "2024-10-01"; its actual fix, PR #1013 ("Preserve debuginfo (e.g. symbols) in wasm-opt"), merged
   2024-04-05 — seven months *before* the issue's eventual close, which was for a separate, broader ask. The
   substantive conclusion (v2.6.0 doesn't strip debug symbols by default, so a jitdump profiling spike stays
   a live fallback option) is unaffected and, if anything, stronger — the fix is older and better-soaked
   than claimed.
3. **An alerting-role incoherence.** The draft gave Prometheus "alert rule evaluation" while separately
   excluding Alertmanager on the grounds that "Grafana OSS alerting covers notification routing." Those two
   claims conflict: Prometheus's native `alerting:` block has no sink except Alertmanager. Fixed in D4 below.
4. **A missing metrics-ingestion hop.** The design routes S2's log-derived counters and S4's browser-OTLP
   metrics through Grafana Alloy, but never specified how either reaches Prometheus for querying/alerting.
   Fixed in D2/D3 below via a second scrape target (S1b, for S2) — **and, found only in a subsequent
   adversarial pass on this ADR itself, S1b does not also cover S4**: `otelcol.exporter.prometheus`'s only
   sink is a push (`prometheus.remote_write`), not something Prometheus scrapes, so S4 needed its own,
   separately-wired fix (also in D2/D3 below). This project's own gate discipline caught the fix as
   half-complete before it shipped, not after.

The complete evidence ledger (E1–E14), the pre-committed scoring rubric, and the mandatory per-brainstormer
attribution table (what each contributed, where it landed, why the rest was rejected) live in the ceremony
transcript; this ADR records only the decisions and their load-bearing rationale, per this project's own
established convention for ceremony-sourced ADRs (ADR-0179's own framing).

## Decision

**D1 — Governing invariant: the server module never times itself and never initiates an outbound call.**
Every server-side signal is either (a) computed by the SpacetimeDB *host*, outside the wasm sandbox, and
exposed on an HTTP endpoint, or (b) written by the *host* to a rotated NDJSON file an external agent tails.
Real OTel spans/metrics exist client-side only. This is the reason ADR-0029's original model — module code
emitting OTel spans/metrics from inside a reducer — was never buildable as specified and is now abandoned
rather than merely deferred: the host already does that job, for free, with none of the wasm-sandbox
crossing risk an in-module OTel SDK would carry (no confirmed `protoc`/`prost` availability for a wasm32
target; `Procedure`/outbound-call APIs are gated behind `#[cfg(feature="unstable")]` in the pinned crate —
the worst dependency shape for an unattended build tick).

**D2 — Three-surface data path; the private-table surface is cut, not built.**

| Surface | Mechanism | New module code | New credential |
|---|---|---|---|
| S1 (pull, host metrics) | Prometheus scrapes `http://<stdb-host>:3000/v1/metrics` every 15s | none | none |
| S1b (pull, agent self-metrics) | Prometheus **also** scrapes Alloy's own self-instrumentation endpoint — where S2's `stage.metrics`-derived counters surface | none | none |
| S2 (tail) | Alloy `loki.source.file` tails `<data-dir>/replicas/*/module_logs/*.log` (read-only bind mount) → `loki.process` (`stage.metrics` derives bounded-label counters, exposed on Alloy's self-metrics endpoint, i.e. what S1b scrapes) → `loki.write` (Loki) | none at transport; a log-envelope convention (see the M20 spec D6) | none |
| S4 (push, traces) | Browser OTel Web SDK → OTLP/HTTP → Alloy `otelcol.receiver.otlp` (CORS-scoped, public) → `otelcol.exporter.otlp` → Tempo | client-only | none (public, rate-limited instead — D5) |
| S4 (push, metrics) | Same ingress → `otelcol.exporter.prometheus` (OTLP→Prometheus format) → a `prometheus.remote_write` component → **pushed** to Prometheus's remote-write receiver (`--web.enable-remote-write-receiver`) — a separate wiring from S1b, since `otelcol.exporter.prometheus`'s only sink is a push, not something Prometheus scrapes | client-only | none (public, rate-limited instead — D5) |

S1 alone already answers the bulk of what a naive design reaches for a custom metrics table to get:
RED-per-reducer (rate/error/duration, including scheduled reducers), table row counts, subscription/queue
depths, and wasm memory — all pre-registered by the host at publish time, before any reducer has ever run.
S1b closes half of the gap the refinement pass found: without a second scrape target, S2's log-derived
counters (which live inside Alloy's self-metrics endpoint, not SpacetimeDB) would have nowhere to land in
Prometheus. **S4's browser-OTLP metrics need a different fix, not S1b:** `otelcol.exporter.prometheus`'s
only documented sink is `forward_to` a `prometheus.remote_write` component — a push, not a target Prometheus
polls — so Alloy forwards S4's converted metrics to that component, which pushes to Prometheus's remote-write
receiver (`--web.enable-remote-write-receiver`, set at Prometheus startup). Both mechanisms are wired in
`ops/observability/**`: the scrape (S1b) for S2, the independent remote-write push for S4 — together closing
the missing-ingestion-hop defect completely, not just its log-metrics half.

**S3** (a private `perf_event`-style table + a scheduled polling-exporter reducer — the design a naive
first pass reaches for) **is cut from v1.** It would cost a module-owner-identity credential with
unrestricted table access — the single most expensive credential this design could introduce — for metrics
S1/S1b/S2 already supply free. It is recorded as a **pre-approved escape hatch**, not foreclosed: if a
future milestone needs a genuine domain-specific metric neither the host's native signals nor Alloy's log
derivation can produce, build it via `POST /v1/database/<id>/sql` (confirmed reachable **anonymously**,
governed only by whatever row-level-security policy the target table declares — this is a materially
different, weaker default posture than `/v1/database/<id>/logs`'s ownership gate, so the new table's RLS
policy is a mandatory design requirement then, not an afterthought), never a `spacetime sql` CLI subprocess
wrapped in ops code (the CLI's own `--help` banner flags the command `UNSTABLE`, and it renders enums/
Option as brittle tagged JSON objects — `{"some": "id"}`, `{"U32": []}` — at the wire level, confirmed by
reading a raw response).

**D3 — 7-container self-hosted OSS stack, one purpose each.**

| # | Tool | Sole purpose | License |
|---|---|---|---|
| 1 | Prometheus | Metric storage, scraping (S1 + S1b), **and** a remote-write receiver for S4's pushed metrics (`--web.enable-remote-write-receiver`); **recording rules only** for its own rule evaluation | Apache-2.0 |
| 2 | Grafana Alloy | The *only* telemetry agent: file-tail→Loki (+ log→metric derivation), browser-OTLP→Tempo/Prometheus-exporter→remote-write | Apache-2.0 |
| 3 | Loki | Log storage + LogQL | AGPLv3 |
| 4 | Tempo | Trace storage (client traces only) | AGPLv3 |
| 5 | Grafana OSS | Dashboards **+ 100% of alert-rule evaluation and notification routing** | AGPLv3 |
| 6 | node_exporter | Host CPU/RAM/disk/network | Apache-2.0 |
| 7 | Caddy | The only externally reachable process — **two distinct exposure policies**, see D5. Unlike the other six stock, `docker pull`-able images, this one is a custom `xcaddy` build (`caddy-ratelimit` compiled in), so it carries its own build-pipeline and upstream-Caddy-CVE-tracking maintenance line — see Consequences. | Apache-2.0 |

Licensing, independently re-verified this pass (not merely cited): Loki/Tempo/Grafana OSS are AGPLv3,
confirmed via Grafana Labs' own 2021-04-20 relicensing announcement (moved from Apache-2.0 to AGPLv3 for
exactly these three; agents/plugins/libraries — what became Alloy — stayed Apache). Alloy is genuinely
Apache-2.0 and a real distribution built on the CNCF-hosted OpenTelemetry Collector project (confirmed via
its `LICENSE` file and Grafana's own "OpenTelemetry Collector distribution" description) — not itself a
separately CNCF-governed project, and not a marketing relabel either; the substance (Apache-2.0, standards-
compliant OTLP, no vendor lock-in) holds regardless of that distinction. Grafana OSS
unified alerting is confirmed **not** Enterprise-gated — available in OSS since Grafana 8; Enterprise gates
SSO/SAML/LDAP sync, fine-grained RBAC, audit log, and reporting/PDF export, none of which this design uses.
AGPL's network-copyleft clause engages on distributing a **modified** copy to other users over a network —
this design runs **stock, unmodified** vendor images, configuration only, to a single solo operator with no
other users, so the clause has nothing to trigger on either count. This conclusion is contingent on staying
stock-image-only forever, not a one-time check — see Consequences.

Explicitly excluded, with the reason: **Vector** (its usual justification — a stock `exec` log source — is
moot; nothing in this design execs a subprocess for logs, S2 tails a file directly); **a standalone OTel
Collector** (Alloy genuinely is a distribution built on it); **a bespoke metrics exporter + its owner-identity
credential** (S3 cut); **a separate log-shipper process** (file-tail replaces it); **Alertmanager** (D4 makes
it genuinely redundant, not just nominally excluded); **blackbox_exporter** (deferred — `up{job=…}` covers
reachability until a deployment milestone gives the client a static host URL); **Pyroscope/Parca/cAdvisor**
(superseded by `--enable-tracy`, D10, tried first); **k6** (needs bespoke SpacetimeDB protocol support for no
gain over the project's own SDK-bound `sim-harness`); **Datadog** (this ADR's whole reason for existing);
**Tailscale** (proprietary control plane; Headscale is the OSS equivalent if ever wanted, not adopted now).
**Prometheus over VictoriaMetrics** (a real footprint edge, deliberately not taken): irrelevant at pre-launch
scale, and Prometheus is the ecosystem default every dashboard/alert/doc example assumes — that matters for
an unattended build tick that must not guess at API differences.

**Meta-monitoring — who watches Alloy:** because Alloy is the *sole* telemetry agent, its own failure would
silently black out both S2 (logs) and S4 (client metrics/traces) ingestion at once, with nothing else in the
7-container stack noticing on its own. No new signal or container is needed to close this: the S1b scrape
target Prometheus already polls doubles as a liveness probe, and a Grafana OSS alert rule firing when that
target's `up` metric is `0` for more than 3 consecutive scrape intervals catches the failure (OBS-39).

**D4 — Alerting is owned entirely by Grafana OSS, not split with Alertmanager.** Prometheus's native
`alerting:` block has no sink except Alertmanager; giving Prometheus "alert rule evaluation" while
separately excluding Alertmanager (this design's own earlier draft) means an evaluated alert fires into
nothing — internally incoherent, not just imprecise. The corrected, coherent split: **Prometheus computes
and stores recording rules only** (e.g. pre-aggregated burn-rate ratios); **Grafana OSS unified alerting
evaluates alert conditions against those recorded series (and against Loki) and owns 100% of notification
routing**, querying Prometheus/Loki as datasources. No Alertmanager container anywhere in the stack — and
now that exclusion is actually true end-to-end, not merely stated.

**D5 — Caddy has two different exposure policies on two different routes, not one blanket rule.** An
earlier draft gave Caddy one "TLS + auth in front of Grafana and the browser-OTLP ingress" policy — internally
incoherent, since the OTLP ingress (feeding S4) exists specifically so **anonymous players' browsers** can
send telemetry; it structurally cannot require a login. Corrected: the **Grafana route** gets TLS +
authentication (basic auth or an OAuth proxy — operator-only). The **browser-OTLP ingest route** gets TLS +
**public** reachability, CORS `allowed_origins` scoping (a genuine feature of Alloy's `otelcol.receiver.otlp`
`http` block, inherited from upstream OTel Collector), and request-rate + payload-size limits. Stock Caddy
has no rate limiting — this requires `caddy-ratelimit` compiled in via `xcaddy`, confirmed not a stock
feature. **CORS and the rate/payload limits defend different threats, not one layered stack:** CORS is
browser-enforced, so it stops another website from using a victim's browser to cross-origin-post telemetry
here, but does nothing against a direct scripted client (curl, a bot, a load tool) that omits or forges the
`Origin` header, since no browser is present to honor the restriction. Against that scripted-flood threat —
the one an unauthenticated public endpoint actually invites — the rate-limit and payload-size caps are the
real control; CORS should not be credited as a third redundant layer against it.

**D6 — Layer-1 retrofit is real, and deliberately narrow.** ADR-0029's substrate claim ("M0 gains the
always-on benchmark/perf-budget gate") was accepted as done; it wasn't. Confirmed against the actual repo:
`Cargo.toml` names `criterion`/`opentelemetry` only in comments (lines 16, 39); no `benches/` directory
exists anywhere in the workspace; `M0-foundation.spec.md`'s line `:142` (module-emitted OTel spans/metrics)
was never implemented, and per D1 that model is now known to be the wrong one regardless. The retrofit this
ADR actually commissions, in `server-module/src/observability.rs` (one new domain module, ADR-0056/M8.9
convention):

```rust
// Illustrative sketch only — refined at build time, not shipped verbatim from this ADR.
//
// General-purpose structured-event helper (complements, does not replace, guards::log_reject,
// which stays the unchanged SSOT for the reject path). Deliberately NOT a macro_rules! — zero
// declarative-macro precedent exists anywhere in server-module/src or game-core/src (ADR-0179 D6
// already considered and rejected introducing one; no reason to be the first here).
pub(crate) fn mr_log(evt: &str, extra_fields_json: &str) {
    log::info!("{{\"evt\":\"{}\",{}}}", json_escape(evt), extra_fields_json);
}

// Scheduled table colocated with its reducer (ADR-0056 exception, mirrors
// movement_tick_schedule / battle_challenge_reaper_schedule).
#[spacetimedb::table(name = mr_heartbeat_schedule, scheduled(mr_heartbeat))]
pub struct MrHeartbeatSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[spacetimedb::reducer]
pub fn mr_heartbeat(ctx: &ReducerContext) -> Result<(), String> {
    mr_log("heartbeat", &format!("\"content_version\":{}", CONTENT_VERSION));
    Ok(()) // never mutates a table
}
```

Correlation is `ctx.connection_id` — session-scoped, already present on `ReducerContext`, no shared mutable
counter table (which would itself be a write-contention hazard on a hot path). A scheduled reducer's
`connection_id` is always `None`; those lines correlate by `(function, ts)` plus a natural key already in
the payload (e.g. `zone_id`) instead. A CI lint/eval bans bare `log::info!/warn!/error!` calls anywhere in
`server-module/src` outside `guards.rs` (which owns `log_reject`) and `observability.rs` (which owns
`mr_log`) — two blessed low-level emission points, not a blanket rewrite of already-tested, working reject-
path code.

**D7 — Perf-budget gate is a `criterion` dev-dependency scoped to `game-core` only.** Zero coupling to
`spacetimedb`/wasm crates — the existing feature-isolation invariant (M0) stays intact with no exemption
carved out for benches. Benchmarks cover the named hot paths `observability-performance-plan.md` §2 already
enumerates (`apply_move`, `derive_stats`, `resolve_turn`, recruit/encounter, evolution, and the marshaling
boundary); a regression beyond a committed budget fails `just ci`, proven by a seeded-regression
proof-of-teeth fixture — the same discipline as every other mechanical gate in this project (ADR-0010).

**D8 — SLOs split "bug" from "correctly rejected."** `committed="false"` on `spacetime_num_txns_total`
conflates a genuine reducer failure with a guard correctly rejecting a bad request — reproduced live: an
unauthenticated `talk`/`set_profile_name` call (guard-rejected on purpose, by never calling `join` first)
both surface as `committed="false"`, identical to a real bug's signature. The reducer-success SLO is
computed only over a **named allowlist** (`$slo_set`), `committed="true"` vs total; guard-rejection rate is
tracked as a **separate** panel, sourced from S2's `evt:"reject"` lines, never blended into the success
ratio — otherwise the SLO measures player behavior (how often clients hit a guard), not server reliability.

**D9 — Load testing reuses the dashboards' own instrument, not a second one.** `mr-load-driver`
(`sim-harness/src/bin/mr_load_driver.rs`) scales real SpacetimeDB SDK clients against a target concurrency;
the breaking point is read directly off S1 (movement-tick p95 crossing `STEP_MS`, or any queue-depth metric
growing monotonically) — no separate measurement path that could silently drift from what the dashboards
show in production. Chat-flood load scenarios stay a reserved, stubbed dashboard panel until M19 (chat)
exists; this milestone does not block on it.

**D10 — Profiling is cost-ordered, cheapest first.** T1 `criterion` (=D7, CI-gated) → T2 `cargo flamegraph`
on `game-core` (on-demand SVG artifact, no service) → T3 `spacetime start --enable-tracy` (confirmed present
on the actually-installed pinned binary via its own `--help` output — **try this first, under load**; if it
works, Pyroscope/Parca/eBPF privilege grants and the T4 spike below are all moot) → T4 wasmtime
`--profile=jitdump` + `perf` (**deferred spike, only if T3 fails**). T4's citation is corrected from an
earlier draft: the debuginfo-preserving fix, `clockworklabs/SpacetimeDB` PR #1013 ("Preserve debuginfo (e.g.
symbols) in wasm-opt"), merged 2024-04-05 — sixteen months before this ADR, comfortably inside the 2.6.0 pin
— not the miscited "2024-10-01," and GitHub issue #846 (which cross-references it) actually closed
2024-11-04 for a separate, broader ask. wasm-opt stripping debug symbols is not a live blocker for the
pinned toolchain either way; the corrected dates make the conclusion stronger, not weaker.

**D11 — Backup/DR is decided now, not deferred to launch.** Backup surface:
`<data-dir>/replicas/<id>/{clog,snapshots}`, `control-db/`, `program-bytes/` (via `restic` or
`borgbackup`, both OSS), plus the Prometheus/Loki/Tempo data directories if kept on local filesystem.
Retention, configured before first deploy: Prometheus `--storage.tsdb.retention.time=30d`; Loki compactor
`retention_period=30d`; Tempo block retention 7d. Crash-consistency, decided rather than left implicit: for
a solo operator with no HA requirement, v1 takes the backup inside a brief stop-the-world window or an
atomic filesystem snapshot — never a live copy of an in-use commitlog file, which is not safe to assume
crash-consistent. **RTO is measured, not estimated**: `spacetime_replay_total_time_seconds`,
`spacetime_replay_commitlog_time_seconds`, and `spacetime_replay_commitlog_num_commits` are emitted by the
host on every restart, so a real restore drill produces the actual number directly rather than a guess. The
commitlog is append-only and never compacted, so replay time grows monotonically — repeat the drill as it
grows, and alert on the growth trend via `spacetime_message_log_size_bytes`. **Backup freshness is a
separate, previously-unstated requirement:** an operator-configured schedule (OBS-30) is not itself a
guarantee the schedule is running — the runbook records each backup's timestamp, and an alert or documented
manual check fires when that age exceeds twice the configured interval (OBS-40), so a silently-stalled backup
job doesn't go unnoticed for weeks.

**D12 — PII and cardinality rules, enforced mechanically, not just documented.** No player-authored text
(names, chat) in any log line, metric label, or trace attribute, ever. `sender` (identity hex) is confirmed
already logged today, unescaped, via `guards::log_reject`'s `Identity` `Display` — permitted in WARN/ERROR
log lines only, and explicitly never promoted to a Prometheus or Loki **label** (labels create a new time
series per distinct value; an identity-keyed label is an unbounded-cardinality bomb). Every Alloy
`stage.metrics` label set is restricted to a bounded enum (`reducer`, `table`, `zone_id`, `evt`); an eval
rejects a configuration that proposes an unbounded label. The client's F9 bug-report bundle (ADR-0130)
already carries no identity fields beyond what pt-b1 shipped — unchanged by this design.

## Relationship to pt-b1/pt-b2 (M-playtest-b)

`M-playtest-b-observability-feedback.spec.md`'s own scope note already drew this boundary before this ADR
existed: "Out of scope: Datadog/OTel export, dashboards, load testing, SLOs, alerting (all M20)." That
boundary holds **unchanged** — this ADR just fills in what "M20" concretely means now. `pt-b1`'s client
error overlay + event ring + F9 bug bundle (ADR-0130) and `pt-b2`'s additive `playtest_event` table + its
reaper + `just playtest-report` (ADR-0131) answer **product** questions (did the player weaken-before-
recruit, re-catch, come back next session — the H1/H2/H3 proxies) and are **untouched** by this design.
S3 being cut removes the only structural reason M20 might have needed a private table of its own — there is
no `mr_metric_event`-shaped table anywhere in this design, so there is no overlap, no shared reaper, and no
migration to reconcile between the two. `playtest_event` stays pt-b2's, permanently, unless a future ADR
says otherwise.

## Gates

Every checker below needs a BAD fixture it must flag and a GOOD fixture it must pass (ADR-0010
proof-of-teeth discipline):

| ID | Gate | Enforces |
|---|---|---|
| G1 | `evals/observability-log-wrapper.eval.mjs` | No bare `log::info!/warn!/error!` call anywhere in `server-module/src/*.rs` except inside `guards.rs` (owns `log_reject`) and `observability.rs` (owns `mr_log`); excludes `_tests.rs` files |
| G2 | perf-budget CI step (`just ci`) + committed budget file(s) | A `game-core` `criterion` benchmark regressing beyond its committed budget fails CI; seeded-regression fixture proves it bites |
| G3 | `evals/observability-metrics-contract.eval.mjs` — family/label assertion | Publishes a scratch module, scrapes `/v1/metrics`, asserts ≥80 families and the required label keys (`reducer`, `committed`, `txn_type`, `table_name`, `le`) are present |
| G4 | same file — cross-file attribution assertion | `spacetime logs --format json` emits a line whose `function` equals the invoking reducer's name even when the log call originates in a different file's helper (reproduces the `guards.rs:55` case) |
| G5 | same file — Alloy self-metrics assertion | Standing up Alloy against a synthetic `module_logs` fixture with a known `evt` line produces a non-zero counter on Alloy's own self-metrics endpoint (validates S1b's log-derived half — S2 — end-to-end; S4's separate remote-write path is a static config check, not a live-metrics assertion, and is covered by G6 instead) |
| G6 | `evals/observability-stack-config.eval.mjs` | Static scan of `ops/observability/**`: no `alerting:` block in `prometheus.yml` **and** no `alert:` stanza in any `rule_files:`-loaded YAML (OBS-18); no `alertmanager` service in `docker-compose.yml` **and** none of the OBS-37 banned tool names appear as a service name there either; a `cors` sub-block present on Alloy's `otelcol.receiver.otlp`; a `prometheus.remote_write` component present in `config.alloy` forwarding `otelcol.exporter.prometheus`'s output, and `--web.enable-remote-write-receiver` present in Prometheus's `docker-compose.yml` command args (OBS-38); no subprocess/`exec`-based log source configured for Alloy's log tail (OBS-11); Caddy's OTLP route carries no auth directive while its Grafana route does; every `stage.metrics` label set matches the D12 bounded enum; the Grafana provisioning JSON names the `$slo_set` allowlist variable, includes the movement-tick/client-fps/connect-success/saturation panels (OBS-22–26), and includes the S1b dead-man's-switch alert rule (OBS-39) |
| G7 | `observability_tests.rs` | Rust-side mirror of G1's bare-`log::` ban (toolchain-boundary defense in depth, the `accounts_tests.rs`/`ranking-security.eval.mjs` precedent) |

## Amendments

- **To ADR-0029:** this ADR is the concrete elaboration of the 2026-08-08 amendment recorded there — the
  top-level Datadog→self-hosted-OSS override and the "M0 already wired the substrate" correction are stated
  in that amendment; this ADR supplies the tool selection, licensing audit, and data-path architecture.
- **To `observability-performance-plan.md`:** §4 ("Tooling") is rewritten in the same ceremony to name this
  stack instead of Datadog; §1/§5 receive small inline corrections pointing here rather than a full rewrite,
  since their remaining content (the three-layer strategy shape, the named hot-path table, the metrics
  taxonomy) is unaffected.
- **Subsystem-tag note:** this project's `scripts/adr-digest.mjs` `SUBSYSTEM_VOCAB` is a closed,
  zero-tolerance set (`battle`, `evolution-fusion`, `movement-netcode`, `content`, `schema-persistence`,
  `client-ui`, `ci-gates`, `tooling-docs`, `security-authz`, `economy-quests`) with no observability/
  performance/infra entry. The three tags above (`ci-gates`, `tooling-docs`, `schema-persistence`) are the
  closest available fit, chosen deliberately, and recorded here rather than silently mistagged. Adding a
  proper tag requires editing `scripts/adr-digest.mjs`, which is out of this ceremony's write scope — a
  named follow-up, not an oversight.

## Consequences

- **Positive:** zero new credentials for S1/S1b/S2 (host-native, free); $0 recurring third-party cost; no
  vendor lock-in (Alloy is a standards-compliant OTel Collector distribution, so the ingestion side is
  portable if the dashboard/alert side ever changes); the Layer-1 gap is closed with a small, narrowly
  scoped retrofit rather than a full in-module OTel SDK integration that D1 shows isn't buildable inside the
  wasm sandbox at all; the perf-budget gate finally exists as a real, working CI check instead of a
  specified-but-unbuilt one.
- **Negative / accepted risk:** the solo operator now owns 7 containers and their independent upgrade
  cadences, versus one managed Datadog agent — a real, accepted ops-burden tradeoff for the cost/control
  win. That burden is not evenly distributed: six of the seven are stock, unmodified, `docker pull`-able
  images; Caddy is a custom `xcaddy` build (`caddy-ratelimit` compiled in), which means the operator also
  owns a build pipeline and manual upstream-Caddy-CVE tracking rather than a version bump — a materially
  heavier line than the other six. The full stack is also being committed before
  `M-playtest-a-deployment.spec.md`'s hosting topology is decided (that spec rescopes deployment to
  local-only, deferring hosted deployment to `M-playtest-a2`) — a real sequencing cost: the operator pays the
  7-container + custom-build maintenance tax now for a stack whose network posture may need rework once a
  host is actually chosen. `/v1/metrics`'s unauthenticated-by-design gap is a real, standing network-topology
  risk until the M20 spec's OQ1 is answered and the corresponding proxy/network posture is deployed — this
  ADR does not resolve OQ1, it names the exact risk OQ1 must close. The AGPL non-trigger conclusion (D3) is
  contingent on staying stock-image-only forever, not a one-time check at build time — revisit if this stack
  is ever forked, patched, or exposed to other viewers (a multi-operator team dashboard rather than solo).
- **Follow-ups:** OQ1 (deployment topology / port exposure) must be answered before the Caddy/network-
  posture tasks in the M20 spec are finalized. The S3 escape hatch's RLS requirement (D2) is a standing note
  for whichever future milestone first needs a genuine domain-specific metric. `just adr-digest`
  regeneration is required after this ADR lands (mirrors ADR-0179's own equivalent task). The subsystem-tag
  gap (Amendments, above) should be resolved the next time `scripts/adr-digest.mjs`'s vocabulary is touched
  for any other reason, rather than as a dedicated slice on its own.
