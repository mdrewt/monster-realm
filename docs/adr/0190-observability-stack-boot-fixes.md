# 0190 — The observability stack could not boot: three committed config defects fixed, tempo parked, `build_sha` residual mechanized

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 13r-a (M-postgate thirteenth-review residuals §13r-a)
**Supersedes:** —
**Amends:** ADR-0180
**Subsystems:** ci-gates, tooling-docs
**Decision:** Alloy runs as the image own uid 473, the Caddy image strips the net-bind file capability that made its exec EPERM, and the alert group interval becomes a 10s-divisible 20s; tempo and Caddy port 80 stay parked out-of-touch-set.

## Context

ADR-0180 selected and m20b committed a seven-container self-hosted observability stack
(`ops/observability/`). m20e performed the **first real boot** of that committed configuration and
found four defects that made the stack unstartable; ADR-0180:1031 root-caused all four, but the
fixes were never committed — m20e's touch-set did not include `ops/observability/**` and its live
evidence ran under an uncommitted `/tmp` compose override. Every defect had been invisible to 1869
lines of static predicates and 18 CI-dark checks, which is the whole lesson of that finding: a
config gate that has never watched the thing boot proves nothing about booting.

This slice re-reproduced all four defects from scratch against the committed files before planning,
fixed the three that are fixable inside its declared touch-set, and pinned every fixed shape with a
static tripwire that was first proven to bite against a bad fixture (ADR-0010 proof-of-teeth).

## Decision

### D1 — tempo: the undefined flag stays, PARKED, and the park is mechanically un-rottable

`docker-compose.yml` passes `-server.http-listen-address=127.0.0.1` to tempo. Reproduced:

```
$ docker run --rm --entrypoint /tempo grafana/tempo:2.10.7 \
      -server.http-listen-address=127.0.0.1 -config.file=/dev/null
flag provided but not defined: -server.http-listen-address
```

`/tempo -help` confirms tempo 2.10.7 registers **no listen-address flag at all** — only
`-server.http-listen-port` and `-server.grpc-listen-port`. `grafana/tempo:3.0.2` rejects it too, so
an image bump is not an escape hatch. Loki's identical-looking flag *is* genuine
(`grafana/loki:3.7.6 -server.http-listen-address=127.0.0.1 -version` exits 0), which is how the
flag came to be copied onto tempo in the first place. Tempo's real binding is already declared in
`tempo/tempo-config.yml:9,11` (`http_listen_address` / `grpc_listen_address`, both `127.0.0.1`), so
deleting the flag is behaviourally correct and loses no control.

**Why it is not deleted here.** `checkListenAddrsLoopback`
(`ops/observability/checks/stack-config-checks.mjs:456-512`) requires *every* compose service block
to carry one of five allowlisted listen flags with a `127.0.0.1` value, and fails a service that
declares none ("silence is the trap" — every upstream default is `0.0.0.0`). It runs as **C6** in
`evals/observability-stack-config.eval.mjs` and again as that module's own REAL-FILES test. Both
files are outside this slice's declared touch-set. No tempo flag satisfies the allowlist, and
minting a `GF_SERVER_HTTP_ADDR=`- or `MR_CADDY_BIND_ADDR=`-shaped variable on the tempo service
purely to satisfy a scanner would be a lie about what binds the socket. This is therefore a
**hidden dependency**, surfaced for serialization rather than worked around.

**The uncomfortable truth, stated rather than left implied:** because the flag is unparseable,
C6's `"all 7 services … bind 127.0.0.1 only"` is **vacuous for tempo**. Tempo's actual binding
comes from a file no gate reads. Do not take C6's green as evidence about tempo until the
follow-up lands.

**Follow-up prescription** (also carried verbatim in the `G12a` failure message and the eval's
`PARKED — 13r-a` block, so it cannot survive only in a PR description):

1. `checks/stack-config-checks.mjs` — `checkListenAddrsLoopback` stops being a flat `LISTEN_FLAGS`
   scan and gains per-service binding sources: for `tempo`, read `http_listen_address` /
   `grpc_listen_address` from `ops/observability/tempo/tempo-config.yml:9,11`. Its signature gains
   the tempo config text, which moves **two call sites** — the eval's C6 and the checks suite's
   REAL-FILES test.
2. `checks/stack-config-checks.test.mjs` — new teeth: tempo with no flag and a config binding
   `0.0.0.0` must FAIL; with `127.0.0.1` must PASS; a **missing or unreadable tempo config must
   FAIL** (absence is not loopback). Re-derive `NODE_TEST_PASS_FLOOR` and the arithmetic comment
   that justifies it.
3. `docker-compose.yml` — delete the `-server.http-listen-address=127.0.0.1` item.
4. the eval — convert `G12a` from park form to post-fix form (expected command list becomes
   `-config.file=…` alone) and delete the `PARKED — 13r-a` block.
5. Proof: `docker compose up -d tempo` reaches a non-restarting state; re-run `/tempo -help` if the
   image version moved.

`G12a` pins tempo's `command:` list by **exact two-directional set equality** — removing the parked
flag reds it (forcing the follow-up author through step 4 rather than letting the park silently
close), and adding any further flag reds it too. It additionally pins the image **tag** (not the
digest — a same-version CVE rebuild does not change the flag set, but a version bump must force
re-verification), and asserts tempo declares no `profiles:` and no `extends:` and keeps
`restart: unless-stopped`: a `profiles: [parked]` key would remove tempo from
`docker compose config --services` entirely, making six-of-six look healthy while the park quietly
disappeared from view.

### D2 — alloy runs as `user: "473:473"`

`grafana/alloy:v1.18.1` runs as uid 0, but ships `/var/lib/alloy` and `/var/lib/alloy/data` as
`drwxrwx---` owned `473:473` (`alloy:x:473:473` in the image's `/etc/passwd`). Under
`cap_drop: [ALL]` even uid 0 has no `CAP_DAC_OVERRIDE`, so it cannot traverse or write them:

```
$ docker run --rm --entrypoint /bin/sh --cap-drop ALL --security-opt no-new-privileges:true \
      grafana/alloy:v1.18.1 -c 'mkdir -p /var/lib/alloy/data'
mkdir: cannot create directory '/var/lib/alloy': Permission denied
```

Running as the image's own `alloy` user fixes it and keeps `cap_drop: ALL` intact — verified: the
same flags plus `--user 473:473` boot to a complete graph evaluation with the HTTP server up.
`cap_add: [DAC_OVERRIDE]` was rejected: it would hand a capability back to a root process to work
around a directory the image already owns correctly, and it breaks the stack's uniform posture
(prometheus and node_exporter run `65534:65534`, caddy runs `USER 10001`).

The uid is **numeric on purpose**. Compose passes the `user:` string through to Docker and a *name*
is resolved in-container against `/etc/passwd`, so a future image rebuild could silently renumber
`alloy` while the compose file still reads correctly; the numeric form fails loudly instead. This
matches the existing `65534:65534` precedent in the same file.

Two operator preconditions, neither previously documented:

- As uid 473, Alloy needs host-side read+traverse (`r-x`) on `${MR_SPACETIME_DATA_DIR}/replicas`,
  the read-only mount it tails. **This is not a regression** — under `cap_drop: ALL` root had no
  `DAC_OVERRIDE` either, so the previous configuration would have had the same requirement had it
  ever started. If it is wrong the failure is a **silent tail stall**, not a crash, which is
  exactly what the `AlloyIngestStalled` rule in `grafana/provisioning/alerting/rules.yml` exists to
  catch — the loop closes.
- A **populated** root-owned `alloy-data` volume left over from an earlier root-running boot
  (m20e's `/tmp` override ran Alloy as root with `+DAC_OVERRIDE`) is not self-healing: uid 473 gets
  `failed to create the remotecfg service: mkdir /var/lib/alloy/data/remotecfg: permission denied`,
  exit 1. An *empty* named volume is auto-chowned by Docker from the image path and boots fine. The
  remediation is `docker compose down -v` before the first boot on this fix — note that this
  destroys **all seven** named volumes, not just alloy's.

`read_only: true` on alloy was **not attempted** and is out of scope for this slice; it is recorded
here only so a future reader does not assume it was evaluated. (It is not, as an earlier draft of
this ADR claimed, known to crash-loop with the committed volume present.)

### D3 — the Caddy image strips `cap_net_bind_service`

The xcaddy-built binary carries a file capability inherited from the stock image
(`getcap /usr/bin/caddy` → `cap_net_bind_service=ep`, on both `caddy:2.11.4-alpine` and the built
`observability-caddy:latest`; buildkit preserves file capabilities across `COPY --from=`, which is
exactly how it arrives). A binary whose *effective* capability set is not a subset of the process
bounding set cannot be exec'd at all:

```
$ docker run --rm --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true \
      observability-caddy:latest version
exec /usr/bin/caddy: operation not permitted            # exit 255
```

It fails without `no-new-privileges:true` as well, so the toggle is not the cause. `setcap -r`
in the final stage removes it; verified afterwards the same hardened invocation prints
`v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=`. `setcap` already ships in
`caddy:2.11.4-alpine` (`/usr/sbin/setcap`, `libcap-setcap-2.78-r0`), so no package install is
added. The capability bought nothing here in the first place: every listener in the stack is a
high port on loopback.

**The `RUN` also asserts its own outcome** — `setcap -r … && ! getcap … | grep -q cap_` — because
static text cannot close this hole. Two Dockerfiles were built that keep `RUN setcap -r` textually
before `USER` and still ship the capability: one with the `setcap` in an earlier `AS builder` stage
that the final image discards, one with a `COPY --from=` *after* the setcap in the final stage.
`G12c` is correspondingly stage-aware and last-writer-aware rather than index-aware, and the
in-image assertion means a wrong-order Dockerfile fails `docker build` itself.

### D3b — a FIFTH defect, reachable only once D3 was fixed: Caddy cannot bind its automatic HTTP redirect port. PARKED

The premise this slice inherited — "the stack only binds high ports on loopback, so the capability
buys nothing" — is **incomplete**, and the first boot after the D3 fix proved it. With the
capability stripped, Caddy now gets all the way through config load and then dies on:

```
Error: loading initial config: … http app module: start:
  listening on 127.0.0.1:80: listen tcp 127.0.0.1:80: bind: permission denied
```

Caddy's automatic HTTPS adds an implicit HTTP→HTTPS **redirect listener on port 80** for every
`https://…` site, and the Caddyfile's global options block declares neither
`auto_https disable_redirects` nor an `http_port`. Port 80 is privileged, `USER 10001` is not root,
and the capability that made that bind possible is exactly what D3 removes. **This is not a
regression introduced by D3** — before D3 the binary could not be exec'd at all, so no boot ever
reached the bind. It is the next error in line, uncovered by fixing the one in front of it.

**`cap_add: [NET_BIND_SERVICE]` does not fix it; that was tested, not assumed.** Docker does not
place an added capability in the *ambient* set for a non-root user, so the process's effective set
stays empty: the identical `permission denied` reproduces with `cap_add` present, and again with
`no-new-privileges:true` additionally removed. There is no compose-side or Dockerfile-side remedy —
`caddy run` exposes no flag for this, and the setting exists only as a Caddyfile global option.

**The fix is one line in `ops/observability/Caddyfile`**, which is outside this slice's declared
file set — the same hidden-dependency class as D1. It is **verified, not proposed**: adding

```
	auto_https disable_redirects
```

to that file's global options block and running the setcap'd image under the full hardened flags
(`--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true`) yields
`msg="serving initial configuration"` with **zero** errors, running until killed. Disabling the
redirects is the design-correct answer independently of the capability: an HTTP listener on port 80
is unrequested surface in a stack whose whole posture is "loopback, high ports only", and no
documented client of this stack speaks plain HTTP to it.

Consequence: the D3 fix still ships — it is a strict prerequisite, moving Caddy from "cannot exec
at all" to "loads its entire configuration" — and Caddy **still crash-loops** until the Caddyfile
line lands. D6's table states that rather than smoothing it over.

### D4 — the alert group interval moves 15s → 20s, and `for:` 45s → 60s

Grafana 13's alert scheduler runs on a fixed 10s base tick and refuses a group interval that is not
an exact multiple of it. Reproduced against the real provisioning tree:

```
level=error msg="Failed to provision alerting" \
  error="alert rules: invalid alert rule: interval (15s) should be non-zero and divided exactly by scheduler interval: 10"
```

…and the container exits, which under `restart: unless-stopped` is a crash-loop **of the
dead-man's-switch host itself** — the one component whose whole job is to notice that something
else went dark.

20s is the smallest 10s-divisible value at or above the original 15s, so the change is
mechanically derived rather than picked. `for: 45s` moves to `60s` in the same edit: Grafana can
only transition alert state on an evaluation boundary, so under a 20s interval a `for: 45s` fires
at 60s regardless — leaving 45 in the file would make the YAML state a number the scheduler will
never use. Three distinct numbers now live in that neighbourhood and the comment names all three
with their owners, because two of them are *not* this file's:

| number | owner | meaning |
|---|---|---|
| 15s | `prometheus.yml:14` `scrape_interval` (+ `:15` `evaluation_interval`) | how often Prometheus scrapes Alloy — **unchanged** |
| 20s | `rules.yml` group `interval:` | how often Grafana evaluates the group — forced to a 10s multiple |
| 60s | `rules.yml` rule `for:` | pending period before the alert fires |

The second rule in the file (`AlloyIngestStalled`) keeps `for: 10m`: 600s is already an exact
multiple of 20s and its prose carries no interval numbers.

**Correction to ADR-0180:196**, which this ADR cannot edit in place: that line says the AlloyDown
rule catches the failure when `up` is 0 "for more than **3 consecutive scrape intervals**". The
scrape interval is unchanged at 15s, but the pending period is now 60s — **four** scrape intervals
(equivalently, three *evaluation* intervals). Read ADR-0180:196 with that substitution.

`G12b` enumerates **every** `*.yml` under `grafana/provisioning/alerting/` rather than `rules.yml`
alone, because Grafana loads the whole provisioned directory: a sibling `rules-extra.yml`
containing `interval: 15s` reproduces the exact provisioning abort above while a `rules.yml`-only
gate stays green. It also holds an exact expected file set, so a new file in that directory is a
red rather than a silent widening. Its group-interval clauses (non-zero, divisible by 10s) are
Grafana's own rules and fail loud. Its `for:`-is-a-multiple-of-`interval` clause is a **repo
convention introduced by this ADR, not a Grafana restriction** — Grafana accepts a non-multiple
`for` and rounds it up — so that failure message says so and prints the effective value, to stop a
future author burning an hour believing the platform rejected their rule.

### D5 — the `build_sha` cardinality residual: both proposed remedies are rejected on evidence; the residual is mechanized instead

ADR-0180:992 recorded that Alloy's S4 attribute filter bounds `build_sha` only to
`^[0-9a-f]{7,40}$`, leaving a scriptable cardinality vector on the public OTLP path
(~120 series/min/IP, within Caddy's rate limit). The slice brief proposed closing it by pinning to
a fixed 40-hex length **or** a deployed-SHA allowlist. Both were investigated and both are wrong
here:

- **Fixed 40-hex is disqualified by what the client actually sends.** The browser stamps
  `git rev-parse --short HEAD` — **7 characters** (`client/vite.config.ts` `resolveBuildSha`
  → `net/buildInfo.ts` → `client/src/observability/attributes.ts`). A `^[0-9a-f]{40}$` pin would
  `delete_key` `build_sha` from **100%** of production datapoints, silently collapsing every point
  into the unlabelled series while the client believes it is reporting. It would also drift
  `client/src/observability/names.ts`, which mirrors this grammar character-for-character and is
  quoted as SSOT by its own test — a file outside this slice's touch-set.
- **A narrower *length* pin (e.g. `^[0-9a-f]{7}$`) is theatre.** 16⁷ ≈ 268M values remain legal;
  the real bound on the attack is Caddy's request rate limit, not the grammar. A control that
  cannot fail is worse than a declared residual, because it reads as closed.
- **The deployed-SHA allowlist is right in principle and wrong in this slice.** The natural River
  form string-concatenates an operator-supplied `sys.env("MR_BUILD_SHA")` into an OTTL program.
  Live: `MR_BUILD_SHA='a"b'` → `statement has invalid syntax: 1:46: unexpected token "b"`, **exit 1**;
  `MR_BUILD_SHA='abc1234\'` → `lexer: invalid input text`, **exit 1**. Under
  `restart: unless-stopped` a `.env` typo becomes an infinite crash-loop — precisely the defect
  class this slice exists to end. Worse, the name is already taken: `client/vite.config.ts` reads
  `MR_BUILD_SHA` as the *client build-time* SHA override (ADR-0128). Two `.env` files, two
  read-times, one name; an operator pasting a full 40-char SHA stack-side against a 7-char client
  build reproduces the silent 100%-loss failure this decision just rejected 40-hex for. And the
  variable would belong in `ops/observability/.env.example` — outside the touch-set.

**Decision: `ops/observability/alloy/config.alloy` is functionally unchanged**, and the residual is
converted from prose into a mechanism. `G12e` pins the three `delete_key` value-grammar statements
character-for-character **as elements of `otelcol.processor.transform "s4_keep"`'s own
`statements` list**, and requires `keep_matching_keys(...)` to be element `[0]` of that same list.
Path-scoping is load-bearing, not pedantry: moving both `build_sha` statements verbatim into a new
`otelcol.processor.transform` whose `output {}` forwards nowhere keeps a file-wide substring check
green — and the shipped `checkS4AttributeValuesBounded` green too — while the live pipeline loses
the bound entirely. So `G12e` reds on a widened grammar, reds on the 40-hex narrowing (which is the
tooth that stops a future reader applying this slice's own brief), reds on a statement demoted to a
comment, and reds on the unwired-component move.

**Prescription for the follow-up** that does close it: pick a name that does not collide with the
client's `MR_BUILD_SHA`; escape the value with `string.format("%q", …)`, which was verified to
produce a correctly quoted OTTL literal for `a"b` and `a"b\c` (`encoding.to_json(...)` was also
tried and **fails config decode** — do not use it); and prove the drop semantics against a reachable
OTLP client, which this dev box does not have (Docker Desktop scopes `network_mode: host` to its
own VM).

### D6 — EARS, re-scoped honestly, and the boot evidence of record

The slice's original EARS — *all seven services reach a non-restarting running state* — is not
satisfiable while D1 is parked. It is re-scoped to: **WHEN `docker compose up -d --build` is run
with a populated `.env`, THE SYSTEM SHALL reach a non-restarting running state for six of the seven
services; tempo remains parked on D1 and caddy on D3b, and tempo's boot is demonstrated
separately under an uncommitted flag-drop override.** No other service is pre-excused: an earlier draft carried a
node_exporter caveat inherited from ADR-0180:1031, which was withdrawn after node_exporter booted
cleanly on this box under the exact committed configuration
(`msg="Listening on" address=127.0.0.1:9100`).

Runtime facts are not statically checkable, so the boot evidence is recorded manually here, per the
G11 precedent. The tripwires pin the known-bad *shapes*; only a boot proves the *outcome*.

**Procedure of record.** `docker compose down -v --remove-orphans` first (D2's populated-volume
trap), a hand-written `.env` (from the committed `.env.example`; never committed), then
`docker compose up -d --build`. Box: WSL2 + Docker Desktop, 2026-08-14.

**Result — `docker compose ps -a`, six minutes after start:**

| service | state | `RestartCount` | reading |
|---|---|---|---|
| alloy | **running** | 0 | **D2 confirmed.** Zero `permission denied` in its log; `msg="Alloy is starting"` then `msg="now listening for http traffic" addr=127.0.0.1:12345`. This is the container that crash-looped before the fix. |
| grafana | **running** | 0 | **D4 confirmed.** Zero occurrences of `Failed to provision alerting`; `logger=provisioning.alerting … msg="finished to provision alerting"`. |
| loki | **running** | 0 | unchanged by this slice; recorded as a control. |
| prometheus | **running** | 0 | unchanged by this slice; recorded as a control. |
| tempo | restarting | 11 | **D1, as parked.** `flag provided but not defined: -server.http-listen-address`. Re-run with a `/tmp` compose override whose only difference is the deleted flag: **`running`**, and it stays up. That is the proof the sole remaining blocker is the out-of-touches checker, not tempo's own configuration. |
| caddy | restarting | 11 | **D3 confirmed, D3b exposed.** It now *execs* and loads its whole Caddyfile — the pre-fix failure was `exec /usr/bin/caddy: operation not permitted` before any log line at all. It dies later, on D3b's port-80 redirect bind. With the verified one-line Caddyfile fix applied out-of-tree it reaches `msg="serving initial configuration"`, zero errors. |
| node_exporter | **could not be created** | — | `Error response from daemon: path / is mounted on / but it is not a shared mount`. A **host** property of this WSL2/Docker Desktop box (`/` is not a shared mount, so `rslave` propagation on the rootfs bind is refused), not a defect in the committed configuration; a single-box Linux deploy has a shared `/`. Recorded as observed — an earlier draft of this ADR carried this as a *pre-written* caveat and that was withdrawn, because a standalone `docker run` of the identical arguments had succeeded; only the real `compose up` reproduced it. |

**Two operator notes the run surfaced, neither a code change here:**

- A bcrypt hash pasted into `.env` unescaped is silently mangled — Compose interpolates `$` in an
  env file, so `MR_GRAFANA_BASIC_AUTH_HASH` arrives truncated and Caddy fails with
  `base64-decoding password: illegal base64 data`. `.env.example`'s comment tells the operator to
  generate the hash but not to escape it.
- `docker compose up -d` **aborts the whole start** when one service fails to *create*
  (node_exporter here), leaving the other six `Created` but never `Started`. That is a
  create-time failure, not a run-time one; `docker compose start <the rest>` recovers.

<!-- /BOOT-EVIDENCE -->

## Consequences

- Four of the seven services boot clean where two of them previously crash-looped; tempo (D1) and caddy (D3b) remain parked on hidden dependencies, node_exporter on a host property of this box.
- Five new always-on gates (`G12a`–`G12e`) and five new proof-of-teeth fixture groups
  (`T-h`–`T-l`) in `evals/observability-stack-config.eval.mjs`. Each was proven to bite against a
  bad fixture before the corresponding fix landed.
- Alloy's storage and the SpacetimeDB replica mount now carry a **uid** contract with the host
  (473). An operator moving `MR_SPACETIME_DATA_DIR` must check traverse permissions for that uid.
- The Caddy image gains one `RUN` layer that also self-asserts; a Dockerfile reordering that
  reintroduces the capability now fails the build rather than the container start.
- One tempo defect and several gate-coverage gaps remain open and are named in the PR body as
  supervisor items: the unscoped `composeServiceBlock` in the shipped checks module (a decoy
  top-level key currently shadows a real service block for five merged predicates), the absence of
  any gate over the Caddyfile's `bind` directives, and the blindness of every single-file compose
  detector to `extends:` and to an auto-loaded `docker-compose.override.yml`.
- `ADR-0180:196`'s "3 consecutive scrape intervals" is superseded by D4's table.
