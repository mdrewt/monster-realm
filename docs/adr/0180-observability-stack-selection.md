# 0180 — Observability stack selection: self-hosted OSS replaces Datadog, and the WASM-sandbox-crossing data path

**Status:** Accepted
**Date:** 2026-08-08
**Slice:** heavy-ceremony M20 planning pass (pre-slice; implementation elaborates in m20a–m20e per
`specs/monster-realm-v2/M20-observability-performance.spec.md` §5)
**Supersedes:** —
**Amends:** ADR-0029 (harness spec corpus — elaborates the 2026-08-08 Datadog→self-hosted-OSS amendment
there into concrete tool selection + data-path architecture; corrects ADR-0029's own "M0 already wired the
substrate" consequence line)
**Amended-by:** ADR-0190, ADR-0191, ADR-0197, ADR-0202
**Subsystems:** ci-gates, tooling-docs, schema-persistence
**Decision:** An 8-container, all-open-source, self-hosted stack (Prometheus, Grafana Alloy, Loki, Tempo,
Grafana OSS, node_exporter, Caddy, and `mr-trace-relay`) replaces the harness-default Datadog sink; the
module never times or exports itself — every server signal is either host-computed (SpacetimeDB's own
`/v1/metrics`/logs/health, free, zero module code), reconstructed from paired log breadcrumbs by
`mr-trace-relay` (real per-call durations, no beta API), or client-side real OTel; a private domain-metric
table + polling exporter is cut for v1 and kept only as an explicit escape hatch — a `#[view]`-based
owner-scoped read, not RLS+SQL.

**Corrected 2026-08-08 (this line is the ADR's most-quoted summary, feeding `DIGEST.md`; it had gone
stale relative to the amendment below and is rewritten here, not left self-contradicting):** the count
was "7-container" before `mr-trace-relay` (D14-D18) added the 8th; the escape hatch was originally
described as "RLS-gated," which was itself wrong (D18a) — RLS is `unstable`-gated and documented
unenforced on the pinned toolchain, not merely superseded by a later change of mind.

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

The decisions below record the load-bearing rationale, with evidence cited inline.

**Attribution-record correction (added on review, 2026-08-08).** The line above originally pointed to
"the ceremony transcript" for the mandatory per-brainstormer attribution table
(`mr-feedback-doctrine.md` §6.3) — no such file was ever persisted anywhere in either repo; the raw
multi-agent workflow transcript is an ephemeral, session-scoped artifact, not a citable project record.
This is a real gap relative to doctrine, not a cosmetic one, and it is NOT the pattern this ADR's own
later, second amendment follows: see this document's "## Amendment — 2026-08-08 (server-side tracing
reconsidered...)" section below, whose "### Attribution" table is real and embedded directly in the
ADR — distinctly-sourced per-lens rows, not a pointer to an external artifact. That is what this
section should have done the first time, and what any future substantial re-amendment of the decisions
above should do if revisited. Reconstructing one retroactively here, without the original transcript,
would trade a known, disclosed gap for false precision, so none is fabricated in its place — the evidence
ledger (E1-E14 above) and each `D`-decision's own inline citations remain the auditable record for this
section.

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

**D3 — 7-container self-hosted OSS stack, one purpose each.** *(Forward-pointer added this review pass: a
same-day amendment (D14-D18, below) revisits this decision and adds an 8th, functionally-separate service —
`mr-trace-relay` — for server-side causal tracing; it does not change the 7 tools below. A reader stopping
at this ADR's "## Consequences" section, before the "## Amendment" heading, previously had no signal this
table was ever revisited; see D17 for the full re-litigation at 96GB RAM.)*

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
the payload (e.g. `zone_id`) instead.

**The bare-`log::` ban is a ratchet against the current tree, not a blanket ban that fails on landing —
corrected in this finalization pass.** A grep against the actual repo at ADR-amendment time found **56**
raw substring matches for `log::info!/warn!/error!` across **10** domain files outside `guards.rs`/
`observability.rs` (`movement.rs`, `content.rs`, `lib.rs`, `trading.rs`, `pvp.rs`, `evolution.rs`, `taming.rs`,
`raising.rs`, `battle.rs`, `npc.rs`) — hand-rolled JSON, non-reject structured events, functionally the same
thing `mr_log` exists to formalize, already shipped and passing. **Corrected again, this review pass: the
real invocation count is 53, not 56** — 3 of the 56 (`movement.rs:274`, `battle.rs:280`, `npc.rs:21`) are
`///` doc-comment lines that merely *mention* the macro in prose, not real call sites; an invocation-anchored
scan (`log::(info|warn|error)!\(`, requiring the opening paren) finds 53. This is the identical failure
class ADR-0179's `REKEY_COMPLETENESS` gate already hit once on this same codebase — a naive whole-file scan
false-positiving on non-matching sites, requiring a syntax-aware fix — and the same fix applies here: the
`.log-baseline` generator AND G1's own CI check must both anchor on the invocation pattern, never a bare
substring, or a doc-comment mention could pollute the baseline or false-flag a new comment as a violation.
As literally worded, a same-day blanket ban would fail CI against already-merged code the moment it lands,
with no task anywhere in this milestone budgeted to migrate ten files' worth of call sites. The gate is
corrected to be a **ratchet**: a committed baseline file (`server-module/src/.log-baseline` or equivalent —
exact name/format decided at build time), enumerated once at build time by scanning the pre-existing tree
with the invocation-anchored pattern above, lists every pre-existing bare-`log::` call site; the CI lint/eval
fails on any bare `log::info!/warn!/error!` call **not** in that baseline (i.e. any new one, in a new or
existing file) and passes on baseline entries unchanged. Migrating the baseline's existing 53 call sites to
`mr_log` is explicitly **out of this milestone's scope** — a named follow-up (a future tech-debt slice), not
a silently absorbed gap and not something this retrofit quietly declines to mention.

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
| G1 | `evals/observability-log-wrapper.eval.mjs` | No bare `log::info!/warn!/error!` call, matched by an invocation-anchored pattern (`log::(info\|warn\|error)!\(` — never a bare substring match, which would count doc-comment mentions as violations) anywhere in `server-module/src/*.rs` except inside `guards.rs` (owns `log_reject`), `observability.rs` (owns `mr_log`), or an entry in the committed pre-existing-call-site baseline (see D6's corrected ratchet framing — 53 sites across 10 files, grandfathered, not exempted forever; corrected from an earlier miscount of 56 that included 3 doc-comment mentions); excludes `_tests.rs` files |
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

  > **Correction, 2026-08-08 (see the dated amendment below, D18a):** the "S3 escape hatch's RLS requirement"
  > line immediately above is now known to be wrong on the pinned toolchain and is superseded — **not just
  > the RLS half.** RLS is gated behind the `unstable` Cargo feature and documented by the crate itself as
  > unimplemented/unenforced; upstream recommends Views instead. D18a's corrected default also replaces the
  > *transport* this Follow-up implicitly assumed (`POST /v1/database/<id>/sql`) with a subscribed
  > `#[view]`-based read (the `my_wallet`/`my_conversation` pattern) — D18a's own wording is "not RLS+SQL,"
  > rejecting both together, not narrowing to RLS alone. This paragraph is left unedited above, per this
  > amendment's append-only write scope; the amendment section below is the authoritative correction.

## Amendment — 2026-08-08 (server-side tracing reconsidered via scheduled Procedures; stack choice re-litigated at 96GB RAM)

**Status of this amendment:** Accepted, same day as the ADR above. Appended, not merged into the sections
above — D1–D12 above stand except where a decision below (D14–D18) explicitly amends one.

### Trigger

Per Drew's direct instruction, this ADR's tool-stack and server-tracing calls were re-litigated with two
facts that did not exist at the original heavy-ceremony pass:

- **(A) 96GB RAM.** Drew's desktop has 96GB RAM, so the ClickHouse-backed-footprint objection that would
  have ruled out an OTel-native all-in-one (SigNoz / Uptrace / HyperDX-ClickStack / OpenObserve) no longer
  applies. Resource cost is not the deciding factor for this reconsideration — single-developer
  debugging/workflow ergonomics is. **(Framing note, added this finalization pass: V10 below finds this
  objection was never actually evaluated or written down anywhere in this project's prior record — read this
  trigger as removing a hypothetical/assumed blocker to reconsidering, not a previously-recorded one; see
  D17/D18c for the honest accounting once that's established.)**
- **(B) Beta-API pre-clearance, conditional.** Drew is explicitly willing to adopt a BETA SpacetimeDB API —
  scheduled Procedures with outbound HTTP, gated behind the `unstable` Cargo feature — now, and to accept the
  risk of fixing it later if the API shifts, **conditional on it producing a meaningfully better design**,
  not merely because it is technically possible.

Several subagents brainstormed, debated, and adversarially reviewed competing designs against this widened
decision space, explicitly instructed to: steelman positions they disagreed with; disclose the real
downsides of their own proposals; decide on verified evidence rather than rhetorical confidence; guard
against both status-quo bias (keep D1–D12 unchanged just because they already shipped) and novelty bias
(adopt the beta API just because it is now pre-cleared and more sophisticated); and flag any sign that a
prior pipeline stage's output was gaming an evaluation criterion rather than genuinely satisfying it.

### Verdict

**Keep the 7-container Grafana/Prometheus/Loki/Tempo backend (D3, unchanged) as the tool selection. Do not
enable `features = ["unstable"]`. Do not build a scheduled Procedure, a private span table, or an RLS-gated
SQL puller.** Build server-side causal traceability out of the log path this ADR already designed (D2/D6) —
`mr_log` breadcrumbs carrying host-supplied timestamps and natural keys, reassembled into real OTLP spans
**with real, not synthetic, per-call durations** — by a small stateless relay (`mr-trace-relay`) that tails
the same read-only log mount Alloy already tails, plus the cross-signal correlation layer (trace-to-logs, a
`connection_id` pivot) the stack was missing. This adds one small, functionally-separate 8th service
alongside the unchanged 7-container backend — "STAY" is a statement about backend *tool selection*, not a
claim that total footprint stays at 7. D1 survives fully intact, no new credential is introduced, no schema
changes, no bindings drift, and the beta API is not touched for M20 v1.

This is **not** the status-quo answer: it rejects both the original ADR's "server traces are out of scope"
position and every proposed export mechanism that required the beta API or an RLS-gated pull path — the
latter is not currently buildable on the pinned toolchain at all (V3/V8 below), a fact this ADR's own D2
escape hatch got wrong.

### Evidence verified this pass

All findings below were checked directly against primary sources (crate source, live upstream repositories,
upstream docs, or real on-disk data from this project) during this reconsideration pass, independent of any
upstream synthesis draft.

| # | Finding | Source |
|---|---|---|
| V1 | `spacetimedb = "1.12"` resolves to crate **1.12.0**, against host/CLI **2.6.0** — crate version and product version are intentionally decoupled. | `Cargo.toml`, `Cargo.lock`, `spacetime --version` |
| V2 | Crate 1.12.0 already contains `procedure`, `ProcedureContext`, `ctx.http`, `HttpClient`, `Timeout` — all behind one Cargo feature, `unstable`. **Adopting Procedures is a one-line feature flag, not a major-version migration** — a cost objection some upstream input reportedly relied on is false for this repo. | `spacetimedb-1.12.0` crate source (`Cargo.toml`, `lib.rs`, `http.rs`) |
| V3 | **Decisive.** `client_visibility_filter` (RLS) is gated behind that same `unstable` flag **and** carries the crate's own doc comment: RLS filters are "currently unimplemented, and are not enforced." | `spacetimedb-1.12.0/src/lib.rs` |
| V4 | `#[spacetimedb::view]` is stable, un-gated, and already shipped twice in this repo (`my_wallet`, `my_conversation` — ADR-0087/0154), `ctx.sender`-scoped, subscribable. | `spacetimedb-1.12.0/src/lib.rs`; `server-module/src/schema.rs` |
| V5 | **Decisive.** `Instant`/`SystemTime::now/elapsed` are clippy-banned workspace-wide, `-D warnings`, with a proof-of-teeth fixture. **The module structurally cannot time itself**, regardless of what timing APIs a future crate version exposes. | `clippy.toml`; `evals/determinism-fail-loud.eval.mjs` |
| V6 | **Corrected post-review — an unresolved upstream contradiction, not a settled figure.** `spacetimedb-1.12.0/src/http.rs`'s own doc comment states a 500ms maximum timeout on all outbound HTTP. But upstream's mdbook reference docs (version 1.12.0, the same pin) say the opposite: a request with no explicit `Timeout` defaults to 30 seconds, and a user-specified timeout is clamped to a host maximum of 180 seconds — the docs' own worked "Calling an External AI API" example sets an explicit `timeout: TimeDuration.fromMillis(3000)` (3s, six times the rustdoc's claimed ceiling) with no caveat and no mention of a 500ms clamp. This is a genuine, current, internal contradiction in SpacetimeDB's own documentation about a load-bearing operational parameter — not a resolved fact this ADR can build a numeric gate threshold on. G10 below is revised to measure both regimes on the pinned host rather than assume either figure. | `spacetimedb-1.12.0/src/http.rs`; upstream `docs/docs/00200-core-concepts/00200-functions/00400-procedures.md` (mdbook, version 1.12.0) |
| V7 | Real on-disk `module_logs` NDJSON lines carry a **host-populated, per-call, microsecond-precision `ts`** — the pinned crate's `Logger::log` passes no timestamp parameter to the host call at all, so the host, not the module, stamps it. Cross-checked against the log file's own date-named filename. | `~/.local/share/spacetime/data/replicas/*/module_logs/*.log` (real project data); `spacetimedb-1.12.0/src/logger.rs` |
| V8 | Official upstream docs (version 1.12.0, matching the pin) call RLS "an experimental, unstable feature. The API may change or be removed in future releases" and instruct: "For access control, use Views instead." | `clockworklabs/SpacetimeDB` docs, version-1.12.0, row-level-security page |
| V9 | Official upstream docs (version 1.12.0) state Procedures "are currently in beta, and their API may change in upcoming SpacetimeDB releases," and advise "prefer defining reducers rather than procedures unless you need" one. | `clockworklabs/SpacetimeDB` docs, version-1.12.0, procedures page |
| V10 | ADR-0180 and the M20 spec contain **zero mentions** of SigNoz, ClickHouse, Uptrace, HyperDX, or OpenObserve anywhere. **The ClickHouse-family tools were never evaluated, let alone rejected on RAM/footprint** — 96GB removes an objection that was never actually written down. | Full-text search, both documents |
| V11 | **Correction to an upstream synthesis draft's claim, not to this ADR.** A pipeline stage asserted Uptrace's license is BSL, "not AGPLv3." Checked directly against the live `uptrace/uptrace` repository: it is **AGPL-3.0** — confirmed by both GitHub's own SPDX license detector and the raw `LICENSE` file's literal text. The draft's "correction" was itself wrong; this does not change any decision here (the SigNoz/Uptrace/HyperDX/OpenObserve deferral below never rested on licensing), but the record should not carry a wrong "correction" uncorrected. | `uptrace/uptrace` GitHub repository (license API + raw `LICENSE` file) |
| V12 | The pinned playtest-report script (`scripts/playtest-report.mjs`, ADR-0131) reads its private table via the developer's own logged-in CLI identity, invoked outside `just ci` — precedent for `mr-trace-relay` mirroring the same toolchain and non-CI posture, not a new pattern. | `scripts/playtest-report.mjs`; `justfile` |

### Decision

**D14 — D1 stands, unamended; Procedures and `features = ["unstable"]` are explicitly considered and
rejected for M20 v1.** The module still never times itself and never initiates an outbound call. This is
forced, not a preference: V5 makes it a hard CI failure regardless of what APIs exist, so no dependency-shape
change could make the module time itself even if it wanted to. V2 shows adopting Procedures is a one-Cargo-
line change, not a migration — the cost objection several upstream inputs reportedly leaned on is retracted
as false for this repo. Procedures are rejected anyway, but on a **necessity** argument, not a **fear**
argument: D15 below delivers real causal server-side tracing, including real per-call durations, with no new
outbound-HTTP surface and no new in-module timing mechanism at all — so there is nothing left for the beta
API to buy that D15 doesn't already supply. V9's upstream guidance ("prefer reducers... unless you need" a
procedure) reinforces this from the vendor's own side, independent of this project's reasoning. The
falsifier that would overturn this is recorded below, not asserted away.

**D15 — Server-side causal spans, with real durations, are reconstructed from the log stream — no procedure,
no new table, no new credential.** `observability.rs`'s `mr_log` envelope (D6) gains three optional, bounded
fields: `cause` (the call's natural key — `zone_id`/`battle_id`/`trade_id`, already present in the payload),
`sched` (`{target_reducer, scheduled_at}`, logged when a reducer enqueues scheduled work), and `phase`
(`enter` | `exit` | `event`). No synthesized ids, no counter table, no reducer-signature changes, no
`schema.rs` change.

For **causally-interesting calls only** — reducers that enqueue or are triggered by scheduled work, and
cross-reducer chains (the motivating case: a scheduled reducer triggering another reducer, multiple players'
actions interleaving in one zone tick) — `mr_log` is called twice: once at entry (`phase:"enter"`), once at
exit (`phase:"exit"`, on every return path including error paths), sharing the same `cause`/`sched` key. This
is deliberately **not** blanket instrumentation of every reducer, which would double S2 log volume
project-wide for marginal benefit and work against D12's log-hygiene discipline.

**Scoping is a named, enumerated allowlist, not a qualitative rule left to build-time judgment — corrected in
this finalization pass.** `$trace_pair_set` (mirroring D8/OBS-22's `$slo_set` pattern) is the concrete list of
reducers instrumented with enter/exit pairing; membership is decided and committed at build time, not inferred
from this prose. **`$trace_pair_set` explicitly EXCLUDES `movement_tick` and any other reducer already gated
by a per-call SLO (OBS-24's `STEP_MS` budget) or a `criterion` benchmark (D7)** — those reducers' durations are
already measured, for free, host-side, by S1's per-reducer RED histogram with zero module-side cost; doubling
their `mr_log` emission would risk adding exactly the kind of reducer-side latency this whole redesign exists
to avoid, on exactly the hot path least able to absorb it. Breadcrumb pairing targets the reducers *around*
those hot ticks — the ones a hot tick enqueues or is triggered by, and cross-reducer chains generally — not
the tick itself. If a future need genuinely requires pairing a `$slo_set`/criterion-gated reducer, that
addition is a deliberate, reviewed exception, not a default, and is gated by the pre-merge check below, not
silently allowed in. This closes two gaps a later review found: (1) without a named list, it was unverifiable
whether `movement_tick` — named as this feature's own motivating case — was actually in scope; (2) the
project's only pre-merge performance gate (`criterion`, D7) is permanently walled off from `server-module` by
design (never becomes a dependency), so nothing previously caught a `$trace_pair_set` addition eating into a
`STEP_MS`-adjacent budget before merge. **Mitigation:** any reducer added to `$trace_pair_set` MUST be
exercised by `mr-load-driver` (D9) with breadcrumbs active as part of m20e's post-integration verification,
comparing its own relevant SLO/budget (if any) with and without pairing enabled, before that addition merges —
see the new G11 gate below. This is disclosed as a real, previously-unmeasured cost, not assumed safe: two
heap-allocating hand-rolled JSON string builds (`format!`/`json_escape`) per paired invocation, inline in the
reducer's own transaction, is real reducer-side CPU/allocation cost that the "Log volume" cost item below
previously named only in terms of S2 log-line volume, not reducer-side compute.

**Single source of truth for `$trace_pair_set`, and a drift check between it and the code — added this
review pass, closing a gap the earlier drafts left open.** `$trace_pair_set` genuinely has two independent
representations that must agree: (a) which reducers' *source code* in `server-module/src/*.rs` actually
contains the paired `mr_log("...", phase:"enter")`/`phase:"exit"` calls (a compile-time fact — a reducer
either has the breadcrumb calls or it doesn't), and (b) the relay's own committed config file (D15,
`ops/observability/relay/trace-pair-set.json` or equivalent — the exact filename is a build-time detail)
that tells `mr-trace-relay` which reducer names to actually build trace trees for. Nothing previously
verified these two lists agree — a reducer could gain breadcrumb code without ever being added to the
relay's config (its breadcrumbs would be logged and then silently ignored by the relay), or vice versa (the
relay would wait forever for breadcrumbs that never arrive). **The relay's committed config is the
authoritative `$trace_pair_set`** — it is what OBS-50/G9's static exclusion check (movement_tick, etc.)
already scans. G9 is extended to also statically scan `server-module/src/*.rs` for reducers containing a
paired `mr_log(...)` `enter`/`exit` call and assert that set is *exactly* equal (not a subset either
direction) to the relay's committed `$trace_pair_set` — failing CI on either a reducer with breadcrumbs but
no config entry, or a config entry with no matching breadcrumb code.

A new stateless service, **`mr-trace-relay`** (`ops/observability/relay/`, Node, mirroring
`scripts/playtest-report.mjs`'s toolchain — V12), tails the same read-only `module_logs/*.log` bind mount
Alloy already tails, pairs and orders enter/exit breadcrumbs **by the host-populated `ts` field** (V7 — never
by file-tail arrival order, since a rotation boundary or relay restart could in principle deliver `exit`
before its matching `enter`), and computes `duration = exit.ts − enter.ts` — a real, host-attributed
wall-clock duration, D1-compliant because the module never reads a clock to produce it; the subtraction
happens entirely in the relay, outside the wasm sandbox. It then reconstructs trace trees (client-originated
root keyed on `(connection_id, entry ctx.timestamp)`; scheduled root keyed on `(function, ts)` per the
spec's existing OBS-4; cross-reducer edges via joining a child's `scheduled_at` to its parent's `sched`
breadcrumb) and POSTs OTLP/HTTP JSON to Alloy's existing OTLP receiver → Tempo, encoding `trace_id`/`span_id`
as **lowercase hex** (32/16 characters) — not base64, to match the W3C trace-context conventions
Tempo/Grafana correlate against.

**Integrity rule:** a paired enter/exit breadcrumb gets a real, non-negotiable, host-timestamped duration. An
unpaired breadcrumb (only one phase seen — the process crashed mid-call, or the call wasn't scoped for
pairing) stays `start == end`, honestly representing "we know this happened, not how long it took." **Never
synthesize a duration for an unpaired span from an aggregate histogram** — that fabricates precision the
data doesn't support.

**D16 — Client and server traces are pivoted, not merged, in v1.** Unchanged rationale from the original
ceremony: no `trace_id` reducer argument; the join is a Grafana trace-to-logs (span-time-window) pivot plus a
`connection_id` correlation pivot (D17). A merged trace id would cost reducer signature changes across the
hot API surface, a bindings regen, and an amendment to the spec's OBS-3 correlation rule, to buy what one
dashboard click already provides. Distributed context propagation is deferred behind the falsifier below.

**D17 — Backend tool selection: STAY on the Grafana-family stack (D3, 7 containers, unchanged); add one
functionally-separate 8th service to close the correlation gap that motivated this reconsideration.**

"STAY" is a decision about *which observability tools* are selected (Prometheus/Alloy/Loki/Tempo/Grafana
OSS/node_exporter/Caddy), not a claim that nothing new is deployed. `mr-trace-relay` (D15) is genuine new ops
infrastructure — an 8th `docker-compose.yml` service — disclosed as a real cost (Costs, below), not hidden
inside a "no new mechanism" claim.

Added to m20b (`ops/observability/**`, all additive):
1. Tempo→Loki trace-to-logs with span-time-window shift (a standard Grafana Tempo datasource feature).
2. A `connection_id` correlation pivot — **which first-party Grafana mechanism (Correlations vs. Loki derived
   fields) is the right fit for this specific join is UNVERIFIED by this pass; both features exist in the
   Grafana OSS ecosystem in general, but which correctly targets a `connection_id`-shaped join was not
   independently confirmed. Treat this as a build-time spike, not a settled fact.**
3. Shared time-range linkage across Prometheus/Loki/Tempo surfaces (standard dashboard-variable wiring).
4. `mr-trace-relay` itself: stateless, restart-safe. **Corrected this review pass — "folded into OBS-39" was
   asserted, not designed: OBS-39 watches Prometheus's scrape of Alloy's self-metrics endpoint (S1b); it says
   nothing about whether the separate `mr-trace-relay` process is alive, since Alloy keeps running fine if the
   relay dies.** The real mechanism: `mr-trace-relay` exposes a minimal `/health` HTTP endpoint (a bare 200
   response is sufficient — it does not need to implement the Prometheus text-exposition format itself) as a
   new Prometheus scrape target (`job="mr-trace-relay"`, alongside S1/S1b in `prometheus.yml`); Prometheus's
   own auto-generated `up{job="mr-trace-relay"}` gauge (present for every scrape target regardless of what it
   exposes — the identical mechanism S1b's `up{job="alloy"}` already relies on for OBS-39) is what a NEW,
   separate Grafana OSS alert rule watches, mirroring OBS-39's shape but on a distinct scrape target — not the
   same rule extended to cover two unrelated processes' liveness under one condition.

Its failure degrades trace *assembly* only — logs still reach Loki on the independent Alloy path (S2), since
D15 reads the same file alongside Alloy, not in front of it.

**D18 — Two corrections to already-Accepted content, found and fixed by this pass, plus the deferral entry
the original ceremony left implicit.**

**(a) This ADR's own D2 escape hatch is wrong on the current toolchain, and is hereby amended.** D2 above
names `POST /v1/database/<id>/sql`, "governed by RLS," as the sanctioned path if S3 is ever un-cut. V3 and V8
show this is not currently exercisable: RLS is gated behind the same `unstable` flag as Procedures,
documented by the crate itself as unenforced, and upstream now actively steers developers to Views instead
of RLS for access control generally. **Corrected default, if S3 is ever un-cut:** a Views-based per-owner
read path (the `my_wallet`/`my_conversation` pattern — V4), not RLS+SQL, unless a future SpacetimeDB release
documents RLS as stable. This corrects the "Follow-ups" line in this ADR's own Consequences section above
(not edited directly, per this amendment's append-only convention — this paragraph is the authoritative
correction) and the M20 spec's OBS-15, which is amended directly in that document.

**(b) A factual correction to an upstream pipeline claim, not to this ADR.** V11: a prior synthesis pass
asserted Uptrace's license is BSL, "not AGPLv3." It is AGPL-3.0. This does not change (c) below — the
deferral never rested on licensing — but a wrong "correction" should not stand uncorrected in the record.

**(c) Deferral, recorded explicitly rather than left implicit.** SigNoz, Uptrace, HyperDX-ClickStack, and
OpenObserve remain deferred, now for a stated reason rather than by silence: RAM was never the operative
reason (V10 — these tools were never evaluated in the first place). The deferral rests on (i) correlated-fate
risk across a single ClickHouse instance backing everything, (ii) non-transfer of this ADR's own
D4/OBS-18/OBS-19 alerting-correctness work to a different backend, and (iii) the fact that the headline
benefit of an all-in-one — native cross-signal correlation — is unreachable in *either* backend without
server-side trace context, which D15 now supplies regardless of backend choice. The falsifier below names
the re-open trigger.

### Costs of this decision, disclosed

This design's own downsides, stated plainly rather than omitted to make it look better:

1. **Residual fidelity loss.** Only paired enter/exit calls get real durations; unpaired single-phase
   breadcrumbs stay zero-duration by design. A real tracing SDK would still capture sub-call timing (time
   spent inside a nested function call within one reducer) that this cannot — mitigated by S1 histograms +
   `--enable-tracy` shown alongside, not inside, the waterfall.
2. **A new artifact.** `mr-trace-relay` is real code — an NDJSON→OTLP parser, a pairing/ordering algorithm,
   an 8th container on a stack already carrying a real ops-burden accepted risk (this ADR's own Consequences
   section, above).
3. **Reconstruction is weaker than propagation.** Ambiguous interleavings can still mis-parent a span even
   with real durations — pairing is heuristic, not a propagated context.
4. **Out-of-order log delivery is a real edge case with a stated mitigation, not a solved problem.** The
   relay sorts/pairs by host-stamped `ts` (never arrival order), but this still assumes `ts` values are
   monotonic per source — true in every sample checked (V7), not adversarially stress-tested under
   concurrent high-throughput logging in this pass.
5. **Seconds-scale latency** (file-tail + batch) versus a push — worse for live debugging than an in-module
   push would have been, if Procedures were viable (they are not, D14).
6. **Log volume, and reducer-side CPU/allocation cost — corrected in this finalization pass to name both.**
   Paired breadcrumbs double S2 log-line volume for whichever calls are scoped for pairing — bounded by D15's
   `$trace_pair_set` allowlist, D12's PII/cardinality rules unchanged. Previously undisclosed: each paired
   `mr_log` call does a heap-allocating hand-rolled JSON string build (`format!`/`json_escape`), so a paired
   invocation does **two** such allocations inline in the reducer's own transaction, not one — real reducer-
   side compute, not just downstream log volume. `$trace_pair_set`'s exclusion of `movement_tick` and other
   `STEP_MS`/criterion-gated reducers (above) is the primary mitigation; G11 (below) is the mechanical check
   for any future addition.
7. **STAY forgoes** the single-pane ergonomics a ClickHouse-backed all-in-one genuinely offers — a real loss,
   now that 96GB makes it affordable, and one D15's causal-tracing win does not fully offset: native
   cross-signal correlation in a true all-in-one is still smoother than Grafana's trace-to-logs pivot, even
   after D17's additions.

### Attribution

This amendment's pipeline received brainstormed proposals and debate verdicts as synthesized text, not as
independently re-fetchable raw transcripts — the specific claim-by-claim provenance below is carried forward
from that synthesis, not independently re-confirmed input-by-input, except where a row states otherwise.
Where a claim's *substance* was checkable against a primary source (crate code, live repositories, upstream
docs), it was verified directly regardless of attribution (Evidence, above).

| Design input | Adopted → where | Rejected → why |
|---|---|---|
| Incremental (log-relay-first) proposal | OTLP/HTTP-JSON-with-hex-ids wire format → D15 (independently re-verified against current OTLP JSON conventions); the sub-ms private-address rejection measurement; the refusal to commit gate numbers on unresolved evidence | Scheduled-Procedure exporter — moot once D15 needs no procedure; its crate-pin cost premise is false for this repo (V1/V2) |
| All-in-one (SigNoz-style) proposal | The out-of-process exporter shape → D15; the `#[view]`/ADR-0154 precedent (V4) → load-bearing in D18a's escape-hatch fix | SigNoz backend (D17/D18c); its module-computed `duration_micros` field cannot be built (V5) — though D15's relay-computed duration achieves a version of the same goal at zero module-side risk; its view-scoped sidecar table is strictly dominated by D15 (a table costs commitlog/RTO growth, an observer identity, and bindings churn D15 avoids) |
| Skeptic (reject-everything) proposal | The reject-the-Procedure verdict → D14; the fault-isolation argument; the SSRF-forecloses-the-fast-local-collector point | Its "defer everything, change nothing" posture — status-quo by default. D15/D17 close the causal-tracing gap now. Its Uptrace license claim is corrected (V11) |
| Clean-slate proposal | The `trace_id`-in-`mr_log`-not-a-label discipline → D15/D12; the "Procedures can't hold a tx open while sending" constraint (independently confirmed, V9); the reducer-signature/bindings-regen cost → why D16 refuses a merged trace id | Its 30s/180s timeout figures — checked at the time against the crate's rustdoc (V6, then read as 500ms) and marked contradicted; **corrected post-review:** upstream's own mdbook docs state the same 30s/180s figures this proposal used, so the two upstream sources conflict rather than one being simply wrong — downgraded from "contradicted" to "unresolved pending upstream clarification," see V6's correction |
| Research-alternatives proposal | The external-drain insight (outbox safety requires an external consumer) → the core of D15; the self-flagged requirement that a beta API must be necessary, not merely permitted | Its recommended mechanism (RLS-gated SQL) is not buildable on the pinned toolchain (V3) and upstream discourages RLS generally (V8) |
| Debate 1 (server spans, for/against Procedures) | The crate-pin correction — inverts the beta-cost argument several inputs reportedly leaned on; the commitlog/RTO cost of a span table → why D15 uses no table; the "synthesized ids forbidden" constraint (the spec's own OBS-3/OBS-4) → D15's derivation rules | Any pull path depending on RLS (V3/V8 — not enforced, not recommended) |
| Debate 2 (backend stack, STAY vs. swap) | STAY and its rubric → D17/D18c; the finding that this ADR never evaluated the ClickHouse-family tools (V10); the flag that log→log derived-field targeting is unverified → carried into D17(2) as an explicit build-time spike | Any retrofit rationale asserting unstated reasoning was "already doing this work" without evidence |

### Bias guards applied

**Against status-quo bias.** The strongest reason to break the original design was V2: the beta API is one
Cargo line away, not a migration — a cost objection this pass explicitly retracts rather than banks
silently. This reconsideration also overturned the original spec's "server traces are out of scope" position
(D15), "no correlation layer needed" (D17), this ADR's own silence on the ClickHouse family (D18c), and —
the one piece of already-Accepted content this pass found and fixed that the original ceremony did not catch
— **this ADR's own D2 RLS-based escape hatch** (D18a). D1 survives only because V5 makes it structurally
forced, not because it was already written and convenient to leave alone.

**Against novelty bias.** Drew pre-authorized the beta API, conditional on it producing a *meaningfully*
better design. It is declined here because D15's log-relay path turned out *more* capable than a naive
version of it would have been — real per-call durations, not just causal ordering (V7) — which raises the
necessity bar for the beta API rather than lowering it. This pass explicitly resisted treating "the beta API
turned out cheaper than believed" (V2) as license to adopt it anyway; V5's structural clippy ban is untouched
by that finding.

**Goal check** (debugging / latency / errors / load, per the operator's stated goals for this project): (1)
debugging — server causal chains with real inter-call latency where scoped, a genuine capability upgrade over
"always zero-duration"; (2) latency — S1 histograms + `--enable-tracy` + criterion (D7/D10) unchanged, D15
adds inter-transaction chain latency for scoped calls but is not the main lever; (3) errors — `evt:"reject"`
lines become trace-correlated; (4) load — `mr-load-driver` (D9) unchanged, untouched by anything in this
amendment.

### Reward-hacking / evaluation-gaming flags

1. A pipeline stage's Uptrace "BSL, not AGPLv3" correction (V11) is itself a case of the failure mode it
   claimed to be fixing: it read as rigorous specifically because it was phrased as correcting someone else's
   error, confident and symmetrical-sounding — and it was wrong. Flagged explicitly per the operator's rigor
   rule naming prior pipeline stages as fair game: a correction dressed in the language of rigor is not
   evidence of rigor until checked against a primary source.
2. **This flag itself needed correcting.** This amendment originally reported the 30s/180s outbound-HTTP
   timeout figures circulating in the upstream pipeline as unreproducible "false precision" against the
   crate's rustdoc (V6, then read as 500ms), and asserted "no gate threshold in this amendment is built on an
   unverified number." A later adversarial pass found this backwards: upstream's own mdbook reference docs
   (same version-1.12.0 pin) *do* state a 30s default / 180s clamp, with a worked example setting an explicit
   3s timeout and no mention of 500ms — the 30s/180s figures were reproducible after all, from a different
   primary source than the one originally checked. The real finding is that SpacetimeDB's own documentation
   contradicts itself on this parameter, not that one side fabricated it — and G10's original 500ms-based
   condition *was* built on an unverified number, the opposite of what this flag claimed. V6 is corrected
   above; G10 is revised below to measure both regimes rather than assume either.
3. No deliberate criterion-gaming was found in what could be checked this pass. The failures above are
   unverified-confidence failures, not manipulation — but are named as failures, not rounded up to "minor."

### Falsifiers — what overturns this amendment

- **→ Adopt Procedures:** a documented, non-CI `procedure-http-clamp` harness (Gate G10, below) first
  measures which of V6's two contradictory upstream timeout regimes the pinned host build actually enforces —
  for both (i) a call with an explicit aggressive `Timeout` set and (ii) a call with no `Timeout` set at all —
  then shows (a) a procedure call against a hung endpoint, on whichever regime a future adoption would
  actually ship with, returns within the *measured* bound (not an assumed 500ms), **and** (b) a 200ms-interval
  scheduled reducer loses no more ticks than that measured bound predicts during it, **and** (c) any adoption
  mandates an explicit, aggressive `Timeout` on every outbound call as a hard, gate-enforced rule — not a
  convention — since the no-`Timeout` code path is the one upstream's own worked example leaves unbounded at
  30s/180s, **and** (d) D15's reconstruction still proves insufficient in practice despite its real-duration
  improvement. All four conditions, not any one.
- **→ Hard-reject in-module HTTP permanently:** a multi-second stall reproduces with an explicit 100ms
  `Timeout` set (a real API surface per V6/V9). That would be a host defect worth reporting upstream,
  independent of this decision.
- **→ Upgrade D16 to real context propagation:** reconstruction mis-parents spans in ≥2 real debugging
  sessions, even with D15's duration improvement.
- **→ Re-open the backend swap:** D17(2)'s `connection_id` pivot has no first-party Grafana mechanism at all
  (the "bounded config addition" premise is then false and the cost comparison inverts), or a one-day
  pre-registered bake-off shows materially better symptom-to-root-cause time on a ClickHouse-backed
  all-in-one.
- **→ Revisit the relay's shape:** if a first-party Alloy/OTel log→trace converter is found to exist (none
  was found in this pass either — treat the custom relay as committed until proven otherwise).
- **→ Un-cut S3 via RLS after all:** if a future SpacetimeDB release documents RLS as stable (superseding
  V3/V8's current "unimplemented, not enforced, use Views instead" status) *and* a genuine domain-metric need
  arises that a `#[view]` cannot express (views are read-only projections; RLS could in principle restrict
  row-level access to writes too) — until then, D18a's Views-based amendment stands.

### Rollback plan for a future beta-API adoption

Required explicitly by the operator's task framing, not left implicit:

1. **Procedures are never adopted (the current decision, D14).** No rollback is needed — nothing beta is in
   the dependency graph. D15 is the permanent baseline, not a placeholder.
2. **Procedures are adopted later, because the falsifier above triggers all four conditions.** At that point
   **D15 is not deleted** — the falsifier condition explicitly requires D15 to have already proven
   *insufficient*, not broken, so both mechanisms coexist by design. If a *subsequent* SpacetimeDB release
   then breaks the (still-beta, per V9) Procedure/`ctx.http` API surface, the rollback is to **pin the
   crate/CLI version pair that still supports the working procedure API and defer the bump** — this project
   already treats crate-vs-CLI versioning as an explicit, documented decision (V1), so this is an application
   of an existing discipline, not a new one — **not** a data-path redesign. Tracing coverage does not go dark
   during the pin, since D15's relay keeps running throughout.
   **Blast radius, disclosed rather than implied "contained":** the pin is not scoped to the tracing feature —
   it freezes the **whole SpacetimeDB host/toolchain version pair for the entire game server**, not just the
   Procedure/export data path. If an unrelated upstream release two versions later ships a security-relevant
   host patch, staying on the pin to preserve span export means the whole game server also misses that patch;
   upgrading past the pin to take the patch means span export breaks (the accepted, "contained" loss this plan
   already names). That tradeoff — security-patch cadence versus tracing continuity — is not disclosed
   elsewhere in this document and is a real, standing cost of ever exercising this rollback, not a
   hypothetical one; whoever exercises it must weigh it explicitly at the time, not assume the pin is free.

### New gates

| ID | Gate | Enforces |
|---|---|---|
| G8 | `mr-trace-relay` pure-function unit tests + a seeded-ambiguity proof-of-teeth fixture (two interleaved zone-tick chains that must not cross-pollinate) | D15's reconstruction/pairing rules |
| G9 | `evals/observability-stack-config.eval.mjs` extension | Confirms the relay service is present in `docker-compose.yml`, reads `module_logs` read-only, and the trace-to-logs + correlation-pivot config exists in Grafana provisioning (mirrors G6's pattern); **this finalization pass adds:** the committed `$trace_pair_set` config does NOT list `movement_tick` or any other `$slo_set`/criterion-benched reducer, a static check independent of G11's runtime measurement; **this review pass further adds:** `prometheus.yml` has a `job="mr-trace-relay"` scrape target pointed at the relay's `/health` endpoint (D17(4)), AND a Grafana OSS alert rule exists on that target's `up` metric distinct from OBS-39's own rule (not the same rule reused for two processes); AND the set of `server-module/src/*.rs` reducers containing a paired `mr_log(...)` enter/exit breadcrumb call exactly equals the relay's committed `$trace_pair_set` config (D15's single-source-of-truth fix — neither a superset nor a subset) |
| G10 | `procedure-http-clamp` harness (documented, manually-triggered or separately network-gated — **explicitly NOT a `just ci` gate**, since it requires live network egress and toggling `features=["unstable"]` in a disposable scratch module, neither of which belongs in the always-on CI path); measures the hung-endpoint timeout **with and without** an explicit `Timeout` set, per V6's corrected upstream-doc-contradiction finding, rather than assuming either the 500ms or the 30s/180s figure holds | The Falsifiers section's Procedures-adoption trigger condition |
| G11 *(new, this finalization pass)* | m20e post-integration verification step: `mr-load-driver` (D9) run **with** `$trace_pair_set`'s breadcrumbs active, comparing each paired reducer's own relevant SLO/budget (if any) with pairing on vs. off | D15's `$trace_pair_set` scoping rule — the pre-merge check HIGH-1 found missing; not a `just ci` gate itself (it needs the live `docker-compose.yml` stack + a published module, same precondition as G3–G6), but is required before any `$trace_pair_set` addition merges |

### Open question carried forward

**OQ1 (network topology)** — unchanged, still open, still blocks m20b independent of everything decided in
this amendment: whether the SpacetimeDB host port is publicly reachable or private-network-only is a
deployment decision only Drew can make. Nothing in this amendment creates new exposure — `mr-trace-relay`
reads a read-only file mount, adds no port, and adds no credential — but m20b's Caddy/topology config, and
now the relay's own placement (same box as the data dir it tails, or not), cannot be finalized until OQ1 is
answered.

### Amendments (to this ADR's own content, above)

- **D2 (escape hatch):** amended by D18a — **both** the RLS clause **and** the `POST /v1/database/<id>/sql`
  transport requirement are superseded by a Views-based default (subscribed via the SDK, the
  `my_wallet`/`my_conversation` pattern), not merely the RLS half — D18a's own text says "not RLS+SQL"; the
  "Follow-ups" line in Consequences (above, not edited directly per this section's append-only scope) is
  corrected by the callout immediately preceding this amendment's heading, which is broadened to match. The
  M20 spec's OBS-15 is corrected to the same full scope, not just its RLS clause (a coherence gap a later
  review pass found and this finalization fixes).
- **To `M20-observability-performance.spec.md`:** D3/D2 gain cross-reference notes to D17/D18a; OBS-15 is
  amended directly; new EARS criteria OBS-41–OBS-49 implement D14–D18 mechanically, and OBS-50/OBS-51 (added
  this finalization pass) name `$trace_pair_set` and its pre-merge check; §5 slice-decomposition notes for
  m20a/m20b/m20e are updated to reflect the new files (no new slice row — the new work fits inside each
  slice's already-declared `touches:` scope, per the Slice placement note below).
- **Slice placement (verified against the spec's actual §5 table, not asserted):** `observability.rs`'s new
  `cause`/`sched`/`phase` fields are additive within the file m20a is already scoped to create — no new
  touches. `ops/observability/relay/**` and the correlation-config additions fall inside m20b's already-
  declared `ops/observability/**` scope — touches-disjoint from m20a as already designed. Reconstruction unit
  tests + the config-presence gate extension belong in m20e (SERIAL, already gated on both m20a and m20b
  merging). **This finalization pass:** the `server-module/src/.log-baseline` file (OBS-2's ratchet) belongs
  in m20a alongside `observability.rs` — same directory, same slice, added to that row's `touches:` list; the
  `$trace_pair_set` config belongs in m20b's `ops/observability/**` scope alongside `mr-trace-relay`. **No
  slice-serialization changes to the existing table.**
- **To `observability-performance-plan.md`:** **not touched by this amendment** — the backend tool selection
  (§4 "Tooling") does not change; D17 explicitly stays on the same 7-container Grafana/Prometheus/Loki/Tempo
  stack that document already names. Only a project-specific spec/ADR amendment was warranted, not a
  cross-cutting plan-document rewrite.

## Amendment — 2026-08-08 (m20b build pass: build-time spikes resolved, networking model corrected, S4 cardinality closed)

Recorded by the `m20b` build slice, which stands up `ops/observability/**`. This is an **append-only** amendment: it
resolves decisions this ADR itself deferred to build time, and records two design corrections found by the slice's own
plan-review and red-team passes. It does not restate or reverse D1–D18.

### Build-time spikes this ADR left open — now resolved

- **OQ1 (network topology) — ANSWERED from existing spec text, not guessed.** `M-playtest-a-deployment.spec.md`
  fixes deployment as **local-only, no hosted deployment** (rescoped 2026-07-17; Drew is the sole tester), and states
  same-box explicitly ("Local-only means the playtest DB shares the machine with dev churn"). The M20 spec's own
  instruction is to treat OQ1 as answered if that file fixes the topology. Consequence: SpacetimeDB stays
  loopback-bound and **OBS-17's "reverse proxy in front of SpacetimeDB itself" scope addition is NOT triggered**; the
  D3/D5 posture as written is sufficient. This is a build-time *snapshot*, not an enforced invariant — see the
  disclosed risk below.
- **D17(2) — Grafana Correlations vs. Loki derived fields: CORRELATIONS.** This ADR flagged the mechanism UNVERIFIED
  and demanded a build-time spike. Verdict: **derived fields cannot do this join** — they are one-way and Loki-source
  only, so they structurally cannot express the Tempo→Loki leg the `connection_id` pivot requires. Correlations are
  any-source→any-target and — the previously unverified half — **are file-provisionable in Grafana OSS**, as a nested
  `correlations:` list under the *source* datasource in `datasources.yaml`; no UI or API step is needed. Two entries
  are required, one per direction. **No falsifier tripped** (this ADR named "neither mechanism is a first-party fit"
  as a re-open trigger for the backend swap; a first-party fit exists).
- **Version pins (this ADR's standing "confirm versions against the pinned environment at build time").**
  All images verified live via `docker manifest inspect` and pinned **by `tag@sha256:` digest**, which also
  makes OBS-33's "stock, unmodified vendor images" claim mechanically checkable rather than asserted.
  Licensing re-confirmed: Loki/Tempo/Grafana OSS AGPLv3; Prometheus/Alloy/node_exporter/Caddy Apache-2.0 —
  unchanged, so the AGPL network-copyleft analysis stands. **Corrected during implementation (this is why
  the standing instruction exists):** the digest-verification pass confirms only that a tag EXISTS, not that
  its config schema is compatible. Running each config through its own upstream validator caught that
  **Tempo 3.0.2 rejects this stack's config outright** — 3.0.x restructured `app.Config` and no longer
  accepts the top-level `compactor`/`ingester` keys, so D11's named knob
  (`compactor.compaction.block_retention`) has no home there. Tempo alone is therefore pinned to the **2.x
  LTS track (2.10.7)**, which validates cleanly; every other image stays on current stable.

### Correction 1 — the networking model: host networking with loopback-bound listeners

A bridge-networked Prometheus **cannot** scrape a loopback-bound SpacetimeDB. A container's `127.0.0.1` is the
container itself, and a socket bound to `127.0.0.1` refuses a connection whose destination is the bridge gateway, so
the `host-gateway`/`extra_hosts` workaround does not rescue it. The two bridge-preserving repairs both require
SpacetimeDB to bind a non-loopback address, which reopens `/v1/metrics`'s confirmed-permanent unauthenticated gap —
to the LAN in one case, to every container on the box in the other. Both are rejected.

**Adopted: `network_mode: host`, with every service's own listen-address flag bound to `127.0.0.1`.** SpacetimeDB
stays strictly loopback and remains scrapable. The tradeoff is disclosed, not hidden: under host networking compose's
`ports:` block is inert, so **each service's own listen flag becomes the security boundary** — a larger and
easier-to-miss surface than a `ports:` prefix. It is therefore mechanically gated (`LISTEN_ADDRS_LOOPBACK`), and
omission of a listen flag **fails** rather than passes, because the upstream defaults are all `0.0.0.0`.

The payoff is that OQ1 containment becomes exact: **the single variable that changes if M-playtest-a2 later exposes
this box is Caddy's bind address.** Every other service stays loopback permanently.

### Correction 2 — S4's metric-label cardinality is now bounded (a real gap in this ADR's own controls)

D12/OBS-36 bound the label sets of Alloy's `stage.metrics` — the **S2 log-derived** path only. The **S4** path
(browser OTLP → `otelcol.exporter.prometheus` → `prometheus.remote_write`) is public and unauthenticated **by design**
(D5/OBS-21: an anonymous game client structurally cannot authenticate), and converts caller-chosen OTLP attributes
1:1 into Prometheus labels. Nothing in D12, OBS-36, or the original control set bounded that path.

Concretely: a scripted client posting one distinct attribute value per request creates one new active series per
request. Prometheus applies no default per-remote-write cardinality cap, so this grows unbounded until the container
OOMs — destroying the metrics store that every SLO panel, every dashboard, **and OBS-39's own dead-man's switch**
depend on to evaluate. The rate-limit and payload-size caps D5 correctly identifies as the control against a scripted
client bound request *volume*, not the *label space* a single well-formed request can introduce.

**Added: an explicit label allowlist on the S4 path before anything reaches storage**, gated by its own predicate
distinct from S2's. **Extended after an adversarial pass on the implementation:** a key-only allowlist is only
half the control, and calling it "closed" would have been wrong. `zone_id` is a legitimate,
caller-supplied dimension, so a scripted client could still send a fresh value per request and mint one new
series each time — the same bomb, moved from an arbitrary key to an allowed one. The shipped filter therefore
bounds the label VALUE space too (OTTL `delete_key ... where not IsMatch(...)` per allowed attribute), and a
second predicate asserts it. This discharges **OBS-34**, which already reads on its face as covering this path ("SHALL NOT
include player-authored text in any log line, **metric label**, or trace attribute") even though OBS-36 names only
`stage.metrics`. Follow-up flagged: the M20 spec has no S4-specific cardinality criterion; OBS-36 deserves an
explicit S4 counterpart.

### Correction 3 — liveness `up` is not pipeline health

OBS-39 and OBS-46 both alert on `up{job=…} == 0`. Alloy is a single process hosting independent internal components:
if the file-tail stalls (bind-mount permission drift, a log-rotation edge case) or the OTLP receiver rejects every
request, Alloy's HTTP server — the thing S1b actually scrapes — stays healthy and `up` stays `1`, while S2 and S4
ingestion are entirely dark. The meta-monitoring rationale that justified making S1b double as a liveness probe fails
in exactly the scenario it exists for. OBS-39's rule ships as specified **plus** a companion rule on a sustained-zero
Alloy-internal pipeline metric.

### Slice-scope deviation, declared

This ADR and the M20 spec both place `mr-trace-relay` inside m20b's `ops/observability/**` wildcard with "no new slice
row needed", mitigated by m20e's post-merge eval. The build pass **split m20b**, shipping the backend stack config
here and parking the relay as `m20b-2`, under the run's standing right-sizing instruction. The originally-drafted
justification — that OBS-50's G9 and OBS-51's G11 force the split — was **wrong and is retracted**: both gates run at
m20e regardless of the slicing, so they do not discriminate. The corrected reason is that the relay's only input does
not exist and is assigned to no one:

**Spec defect surfaced, requiring an owner: OBS-41 has no implementing slice.** The relay consumes `mr_log`
breadcrumbs carrying `phase:"enter"`/`phase:"exit"`, which OBS-41 requires *inside domain reducers*. m20a's `touches:`
covers `observability.rs` gaining the `cause`/`sched`/`phase` **fields** (the envelope) but includes **no**
domain-reducer file, and **no §4 task checkbox anywhere assigns the paired call sites**. So no merged, in-flight, or
planned slice emits a single `phase` breadcrumb. Shipping the relay now would ship a service with
`$trace_pair_set = ∅` (G9-consistent, since ∅ == ∅ — the gate would not even flag it), zero input, and no possible
integration coverage. That is dead code by the YAGNI standard. The gap is independent of how m20b is sliced and needs
an owner before M20 can claim OBS-41 is covered.

## Amendment — 2026-08-08 (m20a build notes: Layer-1 retrofit as shipped)

**Status of this amendment:** Accepted in m20a build. Appended, not merged into the sections above — D1–D18 above stand unchanged.

### Build-time decisions recorded

**D6 delegation:** the `.log-baseline` format is per-file per-level TSV (`<file>\t<info>\t<warn>\t<error>\t<logbang>`) with a `# total 53` self-checked grandfathered sum. `guards.rs` and `observability.rs` are IN the baseline with pinned rows (0/1/0/0 and 1/0/0/0 respectively) rather than excluded — "blessed" means "these exact counts", not "unmonitored" (closes an exemption-abuse hole a red-team pass found). Counting rule: recursive scan, trimmed-`//`-line skip only, needles `log::info!/warn!/error!/log!` + optional whitespace/block-comment + any of `({[` delimiter; flat bans (zero tolerance): `use log`, `use ::log`, `extern crate log`, `rustfmt::skip` (the last keeps `cargo fmt --check` valid as the spacing normalizer — a spaced macro path under a skip attribute was a compiled, fmt-silent, clippy-silent bypass). Both G1 (JS) and G7 (Rust) implement the identical rule independently.

**The heartbeat as shipped:** 60s interval (four Prometheus scrapes per beat at the 15s D2 scrape interval); `content_version` read from the Config ROW, not the compile-time const (the line answers "is the deployed data at the expected version"; missing row → 0, the existing unseeded sentinel); scheduler-only guard pinned by a dedicated source-scan gate with seven teeth (every other scheduled reducer already had one — a security-audit finding, closed in-slice).

**Perf gate mechanics:** criterion pinned `=0.5.1` (`default-features = false, features = ["cargo_bench_support"]` — no plotters/rayon), `serde_json = "1"` dev-dep added for parsing criterion's `estimates.json` `mean.point_estimate` (a documented-private layout — hence the exact pin; the sanctioned fallback if the layout moves on a deliberate bump is `cargo-criterion --message-format=json`, which needs a CI tool install and is a follow-up slice); budgets are a compiled Rust table (`game-core/benches/budgets.rs`) shared verbatim by the bench harness and its nextest teeth; ceilings ~20x the recorded measured means (order-of-magnitude gate, not drift detection); the harness deletes each budgeted id's criterion dir before benching AND the `perf-budget:` recipe rm -rf's `$CRITERION_HOME` first (a Swatinem/rust-cache-restored `target/` otherwise lets a stale prior run's estimates.json silently satisfy the read-back — a red-team CRITICAL); the gate is wired inside the `eval:` recipe body because `ci-gate-wiring` pins the `ci:` dep list against ci.yml, which is outside m20a's touches.

**Two disclosed, accepted risks (dated, named):** (a) **Host-generated ERROR log lines are an unauthenticated flood surface** — reproduced live this slice: every rejected/`Err` reducer call makes the HOST append an ERROR-severity line to `module_logs` (`target:"__spacetimedb__"`), platform-wide for every public-by-construction reducer, unthrottled (200-call anonymous burst verified); D8's split covers only the app's own `evt:"reject"` lines. **Standing rule for m20b:** never alert on raw ERROR-severity module_logs volume — key alerts on the app's structured `evt` taxonomy (and any heartbeat-liveness alert keys on the S2 `evt:"heartbeat"` log-derived counter, NEVER on `mr_heartbeat`'s `committed="false"` call rate, which any client can inflate; the log line itself is guard-gated and unforgeable). Consider extending the D5 rate-limit posture to `/v1/database/*/call/*`. (b) **AM6's reserved-key `debug_assert` in `mr_log_breadcrumb` compiles out of the release wasm** (verified: `overflow-checks = true` does not imply `debug-assertions`); safe today because the only production caller is `heartbeat_fields(u32)` (digits-only, structurally injection-free) — the check must be promoted to a runtime guard or a static CI scan before any second call site passes a string-derived fragment (forward obligation on m20b/m20e, the slices that add call sites).

**Trace-pair set:** `$trace_pair_set` is EMPTY as of m20a (capability shipped, zero reducers instrumented; a standing eval assertion bans `Some("enter")`/`Some("exit")` literals until m20e's G9 supersedes it).

## Amendment — 2026-08-09 (m20c build notes: client OTel Web SDK wiring as shipped)

**Status of this amendment:** Accepted in m20c build. Appended, not merged into the sections above — D1–D18 and the two prior build amendments stand unchanged.

### What shipped

`client/src/observability/` (8 modules, functional-core/imperative-shell): `names.ts` (the ONE client mirror of the S4 ingest policy — metric-name constants, the 3-key attribute allowlist, hand-rolled value predicates; no regex engine, so there is exactly one policy grammar next to Alloy's RE2), `deviceClass.ts` (total UA→{desktop|mobile|tablet} collapse), `attributes.ts` (per-key omit-don't-coerce, frozen output), `config.ts` (pure resolver: endpoint reject-don't-clamp, interval clamp-don't-reject), `frameWindow.ts` (injected-clock 1s accumulator), `interpGap.ts` (max over remotes of the renderer's own imported `adaptiveInterpDelayMs` — never a copied formula), `instruments.ts` (the catalogue as data), `telemetry.ts` (the only impure file: injected-loader shell + the dynamic-import production loader). Eight additive main.ts hooks (marker-comment-bounded), each pinned by a source-scan tooth in `main.wiring.test.ts`'s append-only m20c block.

### Dependencies (new — the ADR record for them)

Direct, exact-pinned: `@opentelemetry/api@1.9.1`, `@opentelemetry/sdk-metrics@2.10.0`, `@opentelemetry/resources@2.10.0`, `@opentelemetry/exporter-metrics-otlp-http@0.221.0`. Full resolved set adds 7 transitives (`api-logs`, `core`, `otlp-exporter-base`, `otlp-transformer`, `sdk-logs`, `sdk-trace`, `semantic-conventions` — the last three are type-only reach, never imported at runtime by the metrics path). All 11 Apache-2.0, zero install scripts (verified from the lockfile resolve). The SDK is reachable ONLY via dynamic `import()` inside the default loader — a separate chunk, never fetched when telemetry is off (`VITE_MR_OTLP_ENDPOINT` unset = the default state of every dev/test/prod build until an operator opts in).

### The wire contract, as implemented

- **Metric names are unit-free; the unit lives in the name (`_ms`).** Risk R-2 discharge: Alloy's `otelcol.exporter.prometheus` appends a declared OTLP `unit` as a name suffix (version-dependent via `add_metric_suffixes`/`translation_strategy`), which would break the verbatim `mr_client_fps_bucket` that `recording.rules.yml:69` reads. Unit-free naming makes every suffix strategy converge. A gating test pins `unit` unset on all 8 instruments.
- **Instruments:** histograms `mr_client_fps` [15,30,45,50,55,60,90,144] (50/55/60 bracket the OBS-25 p50≥55 SLO), `mr_client_frame_time_max_ms` [8,16,33,50,100,250,1000], `mr_client_interp_gap_ms` [16,33,66,100,200,500], `mr_client_reducer_rtt_ms` [10,25,50,100,250,500,1000], `mr_client_wasm_ready_ms` [100,250,500,1000,2500,5000,10000]; counters `mr_client_reconcile`, `mr_client_reconcile_correction`, `mr_client_intent_reject`. Bucket lists deliberately trimmed (≤9 boundaries, gated) — every boundary is one active series per zone×build×device combination on a public ingest with no per-write cap.
- **The spec's two named rates map onto counters** (the predictor exposes ONE divergence boolean): prediction-divergence rate := `rate(mr_client_reconcile_correction[5m]) / rate(mr_client_reconcile[5m])`; reconcile-correction rate := `rate(mr_client_reconcile_correction[5m])`. `mr_client_intent_reject` is a DELIBERATE third counter beyond the six spec-named signals (server-rejected intents = the player-visible rubber-band class; rate := `rate(mr_client_intent_reject[5m])`). m20e's dashboards/rules should use these formulas.
- **Datapoint attributes only, exactly `{zone_id, build_sha, device_class}`**, validated client-side with the same value grammars as `config.alloy:156-158` and OMITTED (never coerced) when invalid — what leaves the browser is the OBS-34/35 criterion, not what Prometheus stores. `build_sha` rides `BUILD_INFO.sha`; the `'unknown'` dev fallback fails the grammar and drops the key by design. `zone_id` tracks warps (re-stamped on the switchZone success path, after the rawMap commit).
- **Resource attributes are exactly `{'service.name': 'monster-realm-client'}`** — this EXTENDS Correction 2: the S4 datapoint allowlist runs at `context="datapoint"` and never sees resource attributes, while remote-write `labelkeep` PRESERVES `instance`; a per-session resource value (e.g. an instance id) would mint one active series per page load through that door. Verified on sdk-metrics 2.10.0: `MeterProvider` nullish-coalesces `options.resource` (no default-resource merge), and no instance id is auto-injected. A gating test pins the resource set by exact equality.
- **Export path:** `<origin>/v1/metrics` exact (origin equality + pathname equality gated — no extra path segments or query can ever ride the URL), no extra request headers of any kind (the ingest is public BY DESIGN, D5; Caddy's CORS allows only content-type, so any added header would fail preflight anyway), temporality pinned CUMULATIVE explicitly (Prometheus `rate()` semantics; the exporter package default has drifted across 0.x releases).
- **RTT definition (`mr_client_reducer_rtt_ms`):** the enqueueMove promise-settle delta — a genuine round trip (the SDK resolves on the server's Ok/OkEmpty transaction response, sdk `index.mjs:6313-6338`), plus up to one JS task tick of client-side outbound batching under the v3 ws protocol (`index.mjs:5948-5969`). enqueueMove-only, deliberately: one high-frequency movement-path seam; mixing heavier reducers would silently redefine the histogram.
- **wasm-ready definition:** ms from `performance.timeOrigin` to the prediction-wasm exports being callable (module-scope mark right below the wasm-derived consts — the import is top-level-awaited). Includes document load + module-graph eval; NOT a pure instantiate cost. Once per session.

### Rate budget vs the Caddy limiter (AM12)

`otlp-exporter-base@0.221.0` retries ≤5× on 429/502/503/504 (backoff 1s→5s cap, ±20% jitter, NOT configurable via the exporter's public options), so one export cycle can put up to 6 requests on the wire. At the clamp floor (15s) that is 24 req/min from one tab — 5× headroom under Caddy's 120/min/IP, asserted as arithmetic in a gating test. The default is 60s (≤6 req/min). The export interval takes UPWARD-ONLY jitter ×(1+0.1×`Math.random()`), applied after the clamp, injected at the main.ts call site — `PeriodicExportingMetricReader` has no start-offset knob, so interval jitter is the available de-synchronizer against a mass-reconnect export herd.

### Accepted losses and behaviors (documented, not bugs)

- **Backgrounded tabs:** a frame window whose elapsed exceeds 2× nominal is DISCARDED (reset, no sample) — rAF suspension would otherwise turn the fps SLO into an alt-tab detector. There is no honest fps for a window in which the browser scheduled no frames.
- **No page-hide flush:** the final partial window (and, for sessions shorter than one export interval — up to 5.5 min at the clamp max — ALL telemetry) is lost on tab close. v1 accepts this; `sendBeacon` is explicitly banned (its text/plain body fails the content-type-only CORS) and a `pagehide` fetch-keepalive flush is a future, separate decision.
- **Fail-silent everywhere:** init never rejects, façade methods swallow instrument faults, the resolver never writes to the console. The local Caddy uses `tls internal` — until the operator trusts the local CA, browser exports fail and the game must not care. Deliberate divergence from devLog's dev-rethrow asymmetry: telemetry is non-essential; a wrong endpoint must not blank a session.
- **The sendIntent `.then` is self-guarded (call-site try/catch) IN ADDITION to the shell's internal guards:** a telemetry throw falling into the rejection `.catch` would run `predictor.dropRejected` on a move the server ACCEPTED — a desync manufactured by observability. Defense-in-depth here is gated, not stylistic.

### Operator note (R-3 — CORS origin)

The committed `.env.example` default `MR_OTLP_ALLOWED_ORIGIN=https://localhost:5173` matches neither the vite dev server (`5290`, http) nor `vite preview` (`4173`). Browser exports are CORS-blocked (silently, by design) until the operator sets `MR_OTLP_ALLOWED_ORIGIN` to the real client origin AND serves the client from it. Ops-side (out of m20c's touches); recorded here so post-integration does not chase a "client sends nothing" ghost.

### Residuals / flags carried forward

1. **Alloy's `build_sha` value grammar is a weak cardinality bound on a public path** (any 7-40 lowercase-hex string; a scripted client can mint ~120 series/min/IP within the rate limit). Client-side validation does not help against a non-browser attacker. m20b/ops follow-up: pin to fixed length or a deployed-SHA allowlist (out of m20c's touches).
2. **`main.wiring.test.ts`'s PRE-EXISTING comment strippers are not string-literal-aware** (an unclosed `/*` inside any main.ts string literal blinds every older tooth after it). The m20c block ships its own string-aware scanner + a self-test, and a tooth bans the hazard shape in the m20c hunks — but the older helpers are unfixed (out of the append-only block's reach). Follow-up slice: port the string-aware scanner file-wide.
3. **Live end-to-end against `docker compose up -d` NOT run this slice** (per the slice brief: unit-level wiring must not require a live stack). Post-integration/m20e owns: the R-2 suffix confirmation against live Alloy (`curl the Prometheus name index for mr_client_*`), the R-7 transport check, and the first real browser export through Caddy.
4. **No m20e recording rules exist yet for the non-fps metrics** — the PromQL mappings above are the contract m20e should encode.

## Amendment — 2026-08-09 (m20d build notes: `mr-load-driver` as shipped)

**Status of this amendment:** Accepted in m20d build. Appended, not merged into the sections above — D1–D18 (incl. D9) stand unchanged; this records how D9's load driver was actually built and one deliberate deviation from D9's literal wording.

**The D9 deviation, stated plainly — protocol-real, not SDK-real.** D9 (and the §4 checkbox) say `mr-load-driver` "scales real SpacetimeDB SDK clients." That is **not implementable inside the m20d touch-set** (`sim-harness/src/bin/mr_load_driver.rs` + optional `lib.rs`/`world.rs` — zero new deps): `spacetimedb-sdk` @2.6 hard-requires `tokio` + `tokio-tungstenite` + `native-tls` + a `spacetime generate --lang rust` bindings tree (~50–70 files) + `Cargo.toml`/`Cargo.lock` edits, all outside the touch-set, and `sim-harness`'s std-only zero-dep posture is itself load-bearing for the workspace determinism gate (`clippy.toml`). The driver is therefore a **std-only client that speaks the same `v1.json.spacetimedb` wire protocol the SDK speaks**, hand-rolling the RFC 6455 framing and the SATS-JSON envelopes. Live-verified this slice against a real 2.6.0 host: the JSON subprotocol is **never server-compressed** (compression exists only on the v2/v3 bsatn paths), so there is no decompression path to get wrong; the client messages are externally-tagged serde — `{"Subscribe":{"query_strings":[…],"request_id":N}}` and `{"CallReducer":{"reducer":…,"args":"<json-string of the args array>","request_id":N,"flags":0}}` with `MoveInput` as `{"Step":{"East":[]}}`/`{"Jump":[]}`. **D9's core intent is preserved unchanged:** every latency/queue number is read off S1 `/v1/metrics` (the same instrument the dashboards read); the driver has no stopwatch and structurally cannot have one (the determinism gate bans clock reads), so the breaking-point measurement path is not a second instrument to keep in sync. What is NOT claimed: the driver does not exercise the SDK's own client-side code paths (bsatn decode, client cache) — the measured number is a **server** breaking point.

**Why WebSocket-only (no HTTP transport, no `--transport` flag).** The plan explored an HTTP-reducer-call transport; a live probe killed it: each `POST /v1/database/<db>/call/<reducer>` is an ephemeral connection, and `on_disconnect` (`server-module/src/lib.rs`) deletes the caller's player+character **by identity** when it closes, so HTTP cannot sustain join state (verified: `join_game` 200, then `enqueue_move` 530 "not joined" 5 ms later) and would also destroy a concurrent WS session's join state for the same identity. Separately, the dominant server cost at concurrency N is subscription fan-out (every accepted move updates a `character` row broadcast to all N subscribers ⇒ O(N²)); with zero subscriptions, `spacetime_subscription_send_queue_length` — one of OBS-27's two named breach signals — is blind. WS is the only honest transport; the report carries a fixed `"transport":"ws"` literal.

**One character per identity — the load model needs N identities.** A live finding worth recording because it is exactly the kind of assumption a reader would otherwise doubt: **there is no occupancy/collision rule anywhere in the movement pipeline** (`apply_move`/`is_walkable`/`movement_tick` verified line-by-line), so N bots stack freely on zone-0 row 1. But `join_game` creates a player+character only for the FIRST join of a given identity, so the driver mints a **fresh identity per simulated client** (`POST /v1/identity` per client per level) — otherwise every connection re-uses one identity, one character exists, and the O(N²) fan-out collapses to O(N) and the breaking point reads far too high. Confirmed live: accepted-move deltas scale exactly linearly with concurrency (a shared identity would flat-line them).

**OBS-27 measurement semantics as shipped.** Budget = `game_core::STEP_MS` imported (SSOT, never a literal). p95 per level = one windowed cumulative-histogram delta (last usable scrape − first usable scrape) over `spacetime_txn_elapsed_time_sec_bucket{reducer="movement_tick"}`, linear-interpolated inside the containing bucket — the same computation Prometheus `histogram_quantile` performs, with bucket bounds READ from the exposition (the live `le` set is **not** the prometheus-crate `DEFAULT_BUCKETS`; STEP_MS=0.2 s sits in a 400 ms-wide `(0.1, 0.5]` bucket, so every level reports `p95_bucket_width_s` as the resolution indicator). The breach comparator is INCLUSIVE (`p95 >= STEP_MS`, since OBS-24 is satisfied only strictly under budget). Queue-growth = strict within-level monotonic growth over the warm-up-discarded window (a queue that spikes then drains is the server keeping up, not divergence — confirmed live: at 400 concurrent the send queue hit 101 then fell, correctly NOT flagged); cross-level plateau growth is a reported diagnostic, never a breach reason. Guard rejections are never a breach reason and never blended into an error rate (D8): a saturated `accepted=0/rejected>0` level stays VALID with a `rejection_storm` note. Label matching pins the resolved `database_identity` (name→identity resolved at startup via `GET /v1/database/<name>`) and `txn_type="Reducer"` (an `txn_type="Update"` row exists per reducer and would double-count). A missing queue-gauge family fails loud (never a silent 0 → false "no growth"); a non-monotonic cumulative-delta (corrupted scrape) is treated as `Reset` rather than silently mis-ranked.

**OBS-27 evidence of record (dev box, this slice).** Canonical `5→50` ramp: **breaking_point = null / not_reached = true** — a legitimate recording (movement_tick p95 ≈ 0.46 ms ≪ 200 ms; queues flat; all levels valid). Aggressive `100→400` ramp: still `not_reached`, but the O(N²) fan-out is visibly real (subscription queue → 101, operation queue → 481; p95 rose 0.46 ms→4.5 ms) — the server does not sustain a breaking point at ≤400 on this hardware. **G11/OBS-51 readiness:** the CLI (`--clients-start N --clients-max N` + `--run-id "…-pairing-on/off"`) and the `schema:1` machine-readable report support m20e's fixed-concurrency pairing-on/off A/B directly; to produce a real breaking point for that A/B, a weaker/remote target or a higher `--move-rate` is needed — documented, not massaged.

**Determinism posture.** No clock read anywhere (pacing is open-loop `thread::sleep` of a constant derived from `--move-rate`; the only wall-clock label is the injected `--run-id`); all randomness (WS masks, `Sec-WebSocket-Key`, per-client walk phase) is seeded via `game_core::tick_seed`; `#![forbid(unsafe_code)]`. The bin never runs in CI — it needs a live host, the same skip-by-design posture as the metrics-contract eval's live half — but its whole pure core (CLI parse, Prometheus parser, p95 estimator, verdict machine, renderer, bot model, WS codec, envelope builders) is covered by 187 in-file unit/property tests that DO run in `just ci`.

**Named duplicated-rule risk (mitigated).** Bot names are conservative ASCII (`"LoadBot <i>"`) that sit far inside `server-module/src/guards.rs::validate_name`'s NFC/allowlist/length rules; the rule is NOT re-implemented in the driver (a game-core export was rejected as a touch-set violation), and any future drift is converted into a loud tool error at run time by the S1 `join_game{committed="true"}`-counter guard (a short join wave invalidates the level as `join_failed`), never a silent desync.

## Amendment — 2026-08-09 (m20e build notes: evals tail as shipped)

**Status of this amendment:** Accepted in m20e build. Appended; D1–D18 stand unchanged except where explicitly superseded below.

**Slice-placement supersession (this amendment SUPERSEDES the "Slice placement" sentence in the 2026-08-08 amendment assigning `ops/observability/relay/**` implementation to m20b).** m20b shipped only the stack config and parked the relay as "m20b-2" (see "Slice-scope deviation, declared" above); that parked work was never launched, so m20e arrived with the relay absent and its G8/G9 gates unbuildable as specified. Resolution, taken under the build-loop's autonomy mandate and flagged in the m20e PR for supervisor sign-off: **the relay's pure functional core (parse → pair → OTLP encode → reconstruct), the committed `$trace_pair_set` config (membership ∅), and a batch stdout-only CLI shipped in m20e** — all inside m20e's declared `ops/observability/relay/**` touches; **the integration half is re-parked as "m20e-2" (formerly "m20b-2")**: the `docker-compose.yml` relay service (+`:ro` `module_logs` mount), the `prometheus.yml` `job="mr-trace-relay"` scrape target, the Grafana dead-man's-switch alert rule, the `/health` endpoint, and the tail-follow daemon + OTLP POST client — i.e. **all of OBS-46 parked as a unit** (a `/health` server nothing scrapes is the dead code the m20b park declined to ship, on unchanged facts). The stale `m20b-2` labels in `docker-compose.yml`/`prometheus.yml` comments are a forward obligation on m20e-2 (both files outside m20e touches). The park cannot rot silently: the stack-config eval's **G9g park tripwire** fails the moment any of the three integration files gains its relay half, naming the four parked assertions (P1–P4 in the eval header) that must be enabled in the same PR. **[PARTLY CLOSED by 13r-b, `7bba44e`, ADR-0191 — P1–P4 graduated and G9g DELETED (not inverted); the OTLP POST client alone is re-parked as P5; the stale-label obligation is discharged for the two files named here but survives in two others. Three corrections to this paragraph, per item, in the lp-doc-a amendment at the end of this file; recorded by ADR-0202]**

**OBS-41 disposition.** Still unowned — the m20b finding stands. `$trace_pair_set` membership is ∅; OBS-41's WHEN-clause is vacuously satisfied. G9's exact set-equality (eval `pairedReducers` scan + the independent Rust mirror in `observability_tests.rs`) is now the standing SSOT gate; the older flat bans (eval A10, Rust `g7_trace_pair_set_stays_empty`) deliberately remain until first membership, when the **G9h supersession tripwire** fires and names both. Before any first membership merges: G11 must re-run with a real pairing toggle (below), the A10/G7 bans must be superseded, and AM6's reserved-key `debug_assert` must be promoted to a runtime guard or static scan (forward obligations, unchanged).

**Relay wire contract as built (executable spec = `ops/observability/relay/*.test.mjs` + the two-layer golden fixture).** Host envelope live-confirmed against a running 2.6.0 host (module-emitted lines carry `target:"monster_realm_module::<mod>"`, real `filename`, `line_number`; `ts` is a JSON **number** of µs — the parser lifts its digits from raw text, never through `JSON.parse`'s Number, so 16-digit precision survives). Pairing: BigInt ts order; ties break enter-before-exit, then key, then reducer (arrival-independent — pinned by dedicated identical-ts teeth); FIFO within an exact `(reducer, correlation key)` tuple; correlation key = `cause`, else `sched.target_reducer@scheduled_at`, never synthesized. **Unpaired breadcrumbs produce diagnostics, never spans** — a deliberate, stronger reading of D15's "we know this happened" wording (OBS-42's never-estimate rule admits no honest span without both ends). Trace/span ids: sha256-truncated lowercase hex (32/16), deterministic, no clock/RNG, never all-zero (OBS-44); µs→ns exact via BigInt. **Declared deviation: flat spans, no D16 parent/child nesting** — OBS-42/43/44 + G8 are all satisfied by flat spans grouped per correlation key; nesting re-opens when mis-parenting costs a real debugging session (D16's own falsifier). **The batch CLI is stdout-only (no `--out`)**: the G9i gate statically bans every write API in all five relay files, which is the only version of OBS-45 a static scan can actually prove.

**Live evidence of record (2026-08-09, spacetime 2.6.0 host + the m20b compose stack, this dev box).**
- **OBS-44 end-to-end:** a synthetic paired-breadcrumb log run through the batch CLI produced trace `c3c3c61c68f2c1a20e4071f24dd19a5b`; Alloy's OTLP receiver accepted the JSON POST (200, full success), and Tempo returned the span **queried by that lowercase-hex id** with nanos byte-exact.
- **G5/OBS-12/OBS-13:** live eval PASS — `mr_log_events_total{reducer="mr_m20e_g5_<runid>",evt="heartbeat"}` rose **0 → 5 within 8 s** of appending 5 synthetic envelope lines (delta protocol, run-unique synthetic reducer label, collision with ambient heartbeat traffic impossible). B1–B5 re-confirmed: 110 metric families, all named families/label keys, OBS-10 cross-file attribution reproduced.
- **G11/OBS-51 (null A/B, said out loud):** with membership ∅ there is no pairing toggle, so the fixed-concurrency A/B (`--clients-start 50 --clients-max 50 --move-rate 100 --hold-scrapes 8 --seed 20260809`, run-ids `…-pairing-off-a/-b` — deliberately NOT labeled pairing-on) measures the harness's own run-to-run variance: **|Δp95| = 0.028 ms noise floor** (A: 0.459 ms, B: 0.487 ms; both `not_reached`, breaking_point null; identical accepted-move deltas of 1800; zero send errors). This floor is the standing benchmark the FIRST membership addition's real pairing-on/off A/B must be judged against; `not_reached` at ≤400 concurrent remains this hardware's documented floor (m20d amendment above).
- **Alloy's exposed counter name confirmed:** exactly `mr_log_events_total` (the config's `prefix`+`name` verbatim; no component prefixing), with an additional per-file `filename` label from the tail source. The eval's B6 static tripwire pins the config side.

**First real boot of the m20b stack — four committed-config defects found (fixes belong to m20e-2/supervisor; none fixable inside m20e's touches).** m20b shipped the stack statically validated but never booted; `docker compose up -d` on this box surfaced: (1) **tempo**: compose passes `-server.http-listen-address=127.0.0.1`, a flag Tempo 2.10.7 does not define (start-loop crash); `tempo-config.yml` already sets the loopback bind, so the fix is deleting the flag. (2) **alloy**: the image's `/var/lib/alloy` is `770 alloy:alloy` while the service runs as root with `cap_drop: ALL` (no `CAP_DAC_OVERRIDE`) — `mkdir /var/lib/alloy/data` EACCES crash-loop; fix: run as the alloy user, or mount the volume at a root-writable path, or add `DAC_OVERRIDE`. (3) **caddy**: the built image's `/usr/bin/caddy` carries the file capability `cap_net_bind_service=ep`; `USER 10001` + `cap_drop: ALL` + `no-new-privileges:true` makes exec fail EPERM (reproduced minimally); fix: `setcap -r` in the Dockerfile (only high loopback ports are bound). (4) **grafana**: the provisioned alert-rule group interval 15 s is rejected by Grafana 13's fixed 10 s scheduler tick (crash-loop, "should be … divided exactly"); fix: a divisible interval (20 s/30 s) or the `configurableSchedulerTick` feature toggle + 5 s tick. m20e's live evidence was captured with an **uncommitted runtime override** (`/tmp` compose override: tempo command minus the bad flag; alloy `+DAC_OVERRIDE`; grafana toggle+5 s tick) — the committed files were not touched. Environment caveats, documented not massaged: **node_exporter** cannot bind-mount `/` on WSL2/Docker Desktop ("not a shared mount") and was left down; **Docker Desktop scopes `network_mode: host` to its own VM**, so the stack's loopback endpoints are invisible to WSL-native processes (and Prometheus cannot scrape the WSL-native SpacetimeDB host's `/v1/metrics` from inside the VM) — the metrics-contract eval gained an injectable `MR_OBS_ALLOY_FETCH` argv seam (production default: plain in-process HTTP) and the G5 poll ran through a host-network curl container. On the real single-box Linux deployment none of these environment caveats apply. **[PARTLY CLOSED by 13r-a, ADR-0190 — NOT m20e-2: alloy (D2), caddy setcap (D3) and the grafana interval (D4) are fixed; the tempo undefined-flag defect (D1) and a FIFTH defect discovered by D3, caddy’s port-80 redirect bind (D3b), are STILL OPEN with no owner slice; recorded by ADR-0202]**

**The checks-suite activation decision.** m20b's 1,869 lines of stack-config predicate tests were CI-dark (nothing ran them — `just test` is cargo-only and `justfile` is outside m20e's touches). The new stack-config eval is the door: its G9k stage spawns `node --test` over the six suites (4 relay + 2 checks) with the exit code authoritative, a mechanically-derived pass floor (181), and TAP-summary corroboration tolerant of format drift.

## Amendment — 2026-08-21 (lp-doc-a: the m20b-2 / m20e-2 park, closed per item)

**Status of this amendment:** Accepted in slice `lp-doc-a` (ADR-0202). Appended, not merged into the
sections above — D1–D18 and every prior amendment stand unchanged. This section is the SSOT for the
disposition of the park; ADR-0202 points here rather than restating it.

**Why it exists.** The park paragraph above (the 2026-08-09 m20e amendment) described work that had
already shipped six days later, and it is the only place in the corpus that enumerates the park. A
reader arriving via `grep m20e-2` therefore read closed work as outstanding. The numbering below is
the eval's own **P1–P5**, taken verbatim from `evals/observability-stack-config.eval.mjs` — the
mechanized SSOT — rather than a third scheme invented here.

### Residuals — closure status

| id | parked item | state | closed by | gate |
|---|---|---|---|---|
| P1 | the relay as an 8th compose service | **CLOSED** | 13r-b, `7bba44e`, ADR-0191 D1–D4 | C3 `checkServiceSetExact` |
| P2 | the `:ro` module-logs replicas mount | **CLOSED** | 13r-b, `7bba44e`, ADR-0191 D2 | C5 + G9n |
| P3 | the `job="mr-trace-relay"` scrape target | **CLOSED** | 13r-b, `7bba44e`, ADR-0191 | G9o |
| P4 | the Grafana dead-man's-switch alert rule | **CLOSED** | 13r-b, `7bba44e`, ADR-0191 | G9p |
| — | the `/health` endpoint | **CLOSED** | 13r-b, `7bba44e`, ADR-0191 D1 | folded into P1/P3 |
| — | the tail-follow daemon | **CLOSED** | 13r-b, `7bba44e`, ADR-0191 D5–D6 | G9j egress bans |
| **P5** | **the OTLP POST client** | **STILL OPEN** | — | re-parked verbatim in the eval; un-defer trigger G9h |

**Three corrections to the park paragraph itself**, each now false as written:

1. *"the integration half is re-parked as m20e-2 … i.e. all of OBS-46 parked as a unit"* — the unit
   was split on delivery. Five of the six artifacts shipped; only the OTLP POST client remains, and
   it is re-parked under a **new** id (`P5`), not under `m20e-2`. The id `m20e-2` is **retired**: no
   work is tracked under it any more.
2. *"The stale `m20b-2` labels in `docker-compose.yml`/`prometheus.yml` comments are a forward
   obligation on m20e-2"* — **discharged as written** by 13r-b for those two files plus
   `grafana/provisioning/alerting/rules.yml`. Two label sites the obligation never named survive:
   `ops/observability/tempo/tempo-config.yml` and
   `ops/observability/grafana/provisioning/datasources/datasources.yml`. Both are outside
   `lp-doc-a`'s declared `touches:` and are escalated, not fixed here.
3. *"the stack-config eval's **G9g park tripwire** fails the moment any of the three integration
   files gains its relay half"* — all three gained it, and **G9g was deleted rather than inverted**
   (ADR-0191). No tripwire named G9g exists. The live un-defer tripwire is **G9h**, and it guards
   P5, not P1–P4.

### The four boot defects (the paragraph above this section) belong to 13r-a, not m20e-2

That paragraph assigns its four committed-config defects to *"m20e-2/supervisor"*. The owner is
slice **13r-a**, ADR-0190:

| defect | state | where |
|---|---|---|
| alloy `/var/lib/alloy` EACCES | **CLOSED** | 13r-a, ADR-0190 D2 (uid 473) |
| caddy `cap_net_bind_service` EPERM | **CLOSED** | 13r-a, ADR-0190 D3 |
| grafana 15 s alert-group interval | **CLOSED** | 13r-a, ADR-0190 D4 (20 s) |
| tempo `-server.http-listen-address` undefined flag | **STILL OPEN** | 13r-a, ADR-0190 D1 — parked out of touch-set |
| *(fifth, discovered by D3)* caddy port-80 redirect bind | **STILL OPEN** | 13r-a, ADR-0190 D3b — parked out of touch-set |

Neither open defect has an owner slice. Escalated by ADR-0202.
