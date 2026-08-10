# Observability & disaster-recovery runbook

Backup, restore, and measured-RTO procedure for the Monster Realm SpacetimeDB instance and the
self-hosted observability stack (M20, ADR-0180 D11 / OBS-30–32, OBS-40).

Scope note: this deployment is **local-only, single operator** — `M-playtest-a-deployment.spec.md`
fixes that (rescoped 2026-07-17), and it is what answers M20's OQ1. There is no HA requirement
and no hosted target, so the procedures below take the simplest correct option at every fork
rather than the most available one.

> **RTO status: NOT YET MEASURED.** The restore drill in §4 has not been run. The slot in §5 is
> deliberately empty rather than filled with an estimate — ADR-0180 D11 requires RTO to be
> *derived from the host's own replay metrics*, not guessed. It is filled in at M20's
> post-integration verification, once m20a–m20e have merged and the stack runs against a real
> published module.

---

## 1. What is backed up

| Surface | Path | Why |
|---|---|---|
| Commitlog | `<data-dir>/replicas/<id>/clog` | The authoritative write-ahead log. Append-only, never compacted — it only grows. |
| Snapshots | `<data-dir>/replicas/<id>/snapshots` | Replay start points. Without them, restore replays the whole commitlog. |
| Control DB | `<data-dir>/control-db/` | Database identities, ownership, routing. A restore without this has data but no addressable database. |
| Module bytes | `<data-dir>/program-bytes/` | The published wasm. Restoring data against a different module version is not a restore. |
| Observability data | Prometheus / Loki / Tempo volumes | Lower stakes — these are derived signals, not game state. Losing them loses history, not correctness. |

`<data-dir>` is SpacetimeDB's data directory, typically `~/.local/share/spacetime/data`; it is the
same directory `MR_SPACETIME_DATA_DIR` points at in `ops/observability/.env`.

## 2. Crash consistency — the part that is easy to get wrong

**A live copy of an in-use commitlog file is NOT crash-consistent** and must never be treated as a
valid backup. The commitlog is being appended to while you copy it, so a naive `cp`/`restic` run
over a running instance can capture a torn final record.

For a solo operator with no HA requirement, v1 takes the backup one of two ways, never a third:

1. **stop-the-world** — stop the instance, back up, restart. Simplest, and a few seconds of
   downtime is free for a single-tester deployment. This is the default.
2. **atomic filesystem snapshot** — LVM/ZFS/btrfs snapshot, then back up *from the snapshot*.
   Use when even brief downtime is unwanted.

### 2.1 Stop-the-world backup (default)

```sh
export RESTIC_REPOSITORY=<RESTIC_REPOSITORY>
export RESTIC_PASSWORD=<RESTIC_PASSWORD>
export MR_DATA_DIR="$HOME/.local/share/spacetime/data"

systemctl --user stop spacetimedb
restic backup --tag monster-realm --tag stop-the-world "$MR_DATA_DIR/replicas" "$MR_DATA_DIR/control-db" "$MR_DATA_DIR/program-bytes"
systemctl --user start spacetimedb
restic snapshots --tag monster-realm --latest 1
```

### 2.2 Atomic-snapshot backup (no downtime)

```sh
sudo lvcreate --size 4G --snapshot --name stdb-snap /dev/vg0/home
sudo mount -o ro /dev/vg0/stdb-snap /mnt/stdb-snap
restic backup --tag monster-realm --tag fs-snapshot /mnt/stdb-snap/.local/share/spacetime/data
sudo umount /mnt/stdb-snap
sudo lvremove -f /dev/vg0/stdb-snap
```

`borgbackup` is an equally acceptable engine; the crash-consistency rule above is what matters,
not the tool.

## 3. Retention (D11)

| Store | Retention | Knob | File |
|---|---|---|---|
| Prometheus | 30d | `--storage.tsdb.retention.time=30d` | `ops/observability/docker-compose.yml` |
| Loki | 30d | `limits_config.retention_period` **plus** `compactor.retention_enabled: true` | `ops/observability/loki/loki-config.yml` |
| Tempo | 7d | `compactor.compaction.block_retention: 168h` | `ops/observability/tempo/tempo-config.yml` |

Loki needs **both** keys. `retention_period` alone is a documented no-op — `retention_enabled`
defaults to `false`, so deletion simply never runs and logs accumulate until the disk fills, with
no error and no alert. `checkRetentionConfigured` fails the build if the two ever separate.

## 4. Restore drill — and how RTO is derived, not estimated

SpacetimeDB emits its replay cost on every restart. That makes RTO a **measured** number: run the
drill, then read it straight off `/v1/metrics`.

```sh
systemctl --user stop spacetimedb
mv "$MR_DATA_DIR" "$MR_DATA_DIR.pre-drill"
restic restore latest --target /
systemctl --user start spacetimedb
```

Once it is back up, read the three replay metrics — these are the RTO, no estimation involved:

```text
spacetime_replay_total_time_seconds
spacetime_replay_commitlog_time_seconds
spacetime_replay_commitlog_num_commits
```

```sh
curl -s http://127.0.0.1:3000/v1/metrics | grep -E '^spacetime_replay_'
```

Then verify the restore is real, not merely running: the database answers, content is seeded, and
the module version matches what was backed up.

**Repeat the drill as the commitlog grows.** It is append-only and never compacted, so replay time
increases monotonically over the life of the deployment — a drill result from six months ago is
not a current RTO.

## 5. Measured results

| Date | Commitlog size | `spacetime_replay_total_time_seconds` | Measured RTO | Notes |
|---|---|---|---|---|
| _(not yet run)_ | — | — | — | Filled in at M20 post-integration verification, per ADR-0180 D11. |

## 6. Backup freshness check (OBS-40)

**Most recent successful backup:** _(none recorded — no backup has been taken yet)_

OBS-40 requires an alert **or** a documented manual check that fires when the newest backup's age
exceeds **2x** the operator-configured backup interval. This deployment uses the documented manual
check rather than an alert, deliberately: nothing in the 7-container stack observes the backup
repository, so an alert rule would have no series to evaluate and would be a dead rule — the exact
D4 failure the alerting design exists to prevent. When a backup exporter exists, promote this to a
real Grafana rule.

Run this after every backup, and record the date above:

```sh
restic snapshots --tag monster-realm --latest 1 --json | head -c 400
```

If the newest snapshot is older than 2x your backup interval (e.g. older than 48h for a daily
schedule), the backup pipeline is broken — investigate before doing anything else.

## 7. Known drift risk: OQ1 is a snapshot, not an invariant

The whole network posture of this stack rests on **SpacetimeDB staying loopback-bound**, decided
once at build time from `M-playtest-a-deployment.spec.md`'s local-only scope. Nothing in this
stack re-verifies it at runtime.

`/v1/metrics` is unauthenticated by a **confirmed, permanent** gap in the shipped 2.6.0 binary
(`MetricsAuthMiddleware` is written but commented out upstream — it is not a config toggle), and it
discloses table names, row counts, per-reducer call volumes and connected-player counts. If the
instance is ever started with a wider listen address — for LAN playtesting, phone testing, or a
port-forward — that endpoint becomes reachable from that network with **no warning from anywhere
in this stack**.

```sh
ss -tlnp | grep -E '3000|3001|3100|3200|8443|9090|9100|12345'
```

Every line should show `127.0.0.1`. Anything else means the posture has drifted and
`M-playtest-a2` owes this deployment a reverse proxy in front of SpacetimeDB itself (OBS-17).

The Better Auth identity provider (M21b-2, ADR-0182 D18/D20) adds one more loopback service on
port `8443` — already in the `ss -tlnp` grep above. Its own backup/DR posture is §8 below, because
its database is a *different* kind of loss than the game's: the game DB is regenerable content, but
the issuer DB derives every player's permanent `Identity` and its loss orphans them all.

## 8. Better Auth (accounts)

Scope: the self-hosted Better Auth issuer that backs M21's OIDC accounts (ADR-0179/0182). Deployed
per `ops/auth/` — a single loopback-bound service on port `8443` with a SQLite database. This section
extends §1–§7's local-only, single-operator posture to that service; it does **not** replace it. The
game database and the issuer database are backed up independently (`restic` tags `monster-realm`
vs. `better-auth`) because they fail differently: a lost game DB is regenerable, a lost issuer DB
permanently orphans every account (`Identity = f(iss, sub)`).

- **Signing-key custody (FIRST line item, D20).** The `jwt` plugin's JWKS **signing key** is the
  crown jewel: anyone holding it can forge a token for any player, forever, offline. Confirm where
  Better Auth stores it (its own config/secret file vs. inside the shared SQLite database — check
  Better Auth's docs at deploy time, assume neither). If it lives in the database, **exclude** that
  table/file from the nightly `restic` sweep and hold the key in a separate, narrowly-scoped secret
  store; a backup set that also contains the signing key is a second copy of the credential, not a
  backup. If exclusion is infeasible, the compensating control is a documented, mandatory **key
  rotation** on any suspected backup exposure. OQ6's backup destination is a second machine Drew
  already owns — only as secure as that machine, which makes the exclusion/rotation rule *more*
  load-bearing, not less.
- The service is loopback-bound on port `8443` (audited by §7's `ss -tlnp` line).
- Retention mirrors §3: nightly, `14d` / `8w` / `6m`.

Nightly backup — an online snapshot (no stop-the-world; SQLite `VACUUM INTO` produces a consistent
copy while the service runs):

```sh
sqlite3 /var/lib/better-auth/auth.sqlite "VACUUM INTO '/var/backups/auth.sqlite'"
restic backup --tag better-auth /var/backups/auth.sqlite
restic snapshots --tag better-auth --latest 1
```

Restore drill — the drill proves **identity equality**, not merely that the file mounts. Restore the
snapshot, stand the issuer back up, mint a token for a **known** `sub`, and confirm SpacetimeDB
still derives the *same* `Identity` from it. That derivation is `BLAKE3` over the issuer and subject,
applied by `Identity::from_claims`, so an unchanged issuer URL yields an unchanged `Identity` and a
changed one re-keys every player — which is exactly what the drill must catch:

```sh
restic restore latest --target /var/restore --tag better-auth
# stand the restored issuer up on 127.0.0.1:8443, then mint for a known subject:
curl -s -X POST "$AUTH_BASE/api/auth/token" -d '{"sub":"dr-drill-user"}' | jq -r .token
# feed that token to a throwaway client and confirm the derived Identity is unchanged:
spacetime logs monster-realm | tail -n 20
```

Caveat carried from ADR-0182 D20: the `BLAKE3(iss|sub)` construction is cited against the vendored
`spacetimedb-lib-1.12.0` source at high confidence and was **not** byte-verified by any review pass —
treat the drill's identity-equality check as the authority, not this prose.
