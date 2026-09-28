# Runbook: backups, restore, and the monitoring stack

Backup, restore and operational checks for the SpacetimeDB instance, the identity
provider (`ops/auth/`) and the monitoring stack (`ops/observability/`). The deployment
is local, with a single operator and no high-availability requirement, so each
procedure takes the simplest correct option.

Commands marked **destructive** stop services or replace data. Read the whole section
before running them.

## 1. What to back up

| Surface | Path (under SpacetimeDB's data directory) | Why |
|---|---|---|
| Commitlog | `replicas/<id>/clog` | The write-ahead log; append-only and never compacted |
| Snapshots | `replicas/<id>/snapshots` | Replay start points; without them a restore replays the whole commitlog |
| Control database | `control-db/` | Database identities, ownership, routing |
| Module bytes | `program-bytes/` | The published wasm; data restored against a different module is not a restore |
| Monitoring volumes | Prometheus, Loki, Tempo | Derived signals only; losing them loses history, not game state |

The data directory is usually `~/.local/share/spacetime/data`; the monitoring stack
reads it through `MR_SPACETIME_DATA_DIR` (`ops/observability/docker-compose.yml`).

## 2. Take a crash-consistent backup

A copy of a commitlog that is being appended to can capture a torn final record. Never
back up a running instance with a plain `cp` or `restic`. Use one of these two methods.

**Stop the world (default, destructive: brief downtime).** Replace the `systemctl`
lines with however you run the server:

```sh
export RESTIC_REPOSITORY=<repository> RESTIC_PASSWORD=<password>
export MR_DATA_DIR="$HOME/.local/share/spacetime/data"
systemctl --user stop spacetimedb
restic backup --tag monster-realm "$MR_DATA_DIR/replicas" "$MR_DATA_DIR/control-db" "$MR_DATA_DIR/program-bytes"
systemctl --user start spacetimedb
restic snapshots --tag monster-realm --latest 1
```

**Filesystem snapshot (no downtime).** Take an LVM, ZFS or btrfs snapshot, back up
from the read-only snapshot mount, then remove the snapshot. For example, with LVM:

```sh
sudo lvcreate --size 4G --snapshot --name stdb-snap /dev/vg0/home
sudo mount -o ro /dev/vg0/stdb-snap /mnt/stdb-snap
restic backup --tag monster-realm /mnt/stdb-snap/.local/share/spacetime/data
sudo umount /mnt/stdb-snap && sudo lvremove -f /dev/vg0/stdb-snap
```

**Freshness check.** Nothing in the monitoring stack watches the backup repository, so
check by hand after each backup:

```sh
restic snapshots --tag monster-realm --latest 1 --json | head -c 400
```

If the newest snapshot is older than twice your backup interval, the backup pipeline
is broken.

## 3. Restore drill and measured recovery time (destructive)

```sh
systemctl --user stop spacetimedb
mv "$MR_DATA_DIR" "$MR_DATA_DIR.pre-drill"
restic restore latest --target /
systemctl --user start spacetimedb
curl -s http://127.0.0.1:3000/v1/metrics | grep -E '^spacetime_replay_'
```

The host reports its replay cost on every start (`spacetime_replay_total_time_seconds`,
`spacetime_replay_commitlog_time_seconds`, `spacetime_replay_commitlog_num_commits`,
one series per database). That number is the recovery time; do not estimate it. Then
confirm the database answers and the content version is right:

```sh
spacetime sql -s http://127.0.0.1:3000 <db> "SELECT content_version FROM config"
```

The commitlog only grows, so replay time grows with it. Repeat the drill periodically.
No drill has been recorded yet.

## 4. Monitoring stack retention

| Store | Retention | Setting |
|---|---|---|
| Prometheus | 30 days | `--storage.tsdb.retention.time=30d` in `ops/observability/docker-compose.yml` |
| Loki | 30 days | `retention_period: 30d` **and** `retention_enabled: true` in `ops/observability/loki/loki-config.yml` |
| Tempo | 7 days | `block_retention: 168h` in `ops/observability/tempo/tempo-config.yml` |

Loki needs both settings. `retention_period` alone deletes nothing, and logs grow until
the disk fills.

## 5. Keep everything on loopback

`/v1/metrics` answers without authentication (a plain `curl` returns every series,
labelled by database). The monitoring stack runs on the host network with every
service bound to `127.0.0.1`. Start SpacetimeDB with
`--listen-addr 127.0.0.1:3000`; its default is all interfaces. Check:

```sh
ss -tlnp | grep -E ':(3000|3001|3100|3200|8443|9090|9100|9101|12345) '
```

Every line must show `127.0.0.1`. Anything else means SpacetimeDB or a service is
reachable from the network and needs a reverse proxy in front of it before that is
acceptable. `MR_CADDY_BIND_ADDR` is the only setting meant to change if the stack is
ever exposed (`ops/observability/README.md`).

## 6. Log tailers read nothing: mount permissions

`alloy` and `mr-trace-relay` both run as uid 473 and read
`${MR_SPACETIME_DATA_DIR}/replicas` read-only. If uid 473 cannot read that path, both
containers stay up and answer their scrapes, so liveness alerts stay quiet, but no log
line is ever read.

```sh
sudo -u '#473' test -r "$MR_SPACETIME_DATA_DIR/replicas" && echo readable || echo BLOCKED
namei -l "$MR_SPACETIME_DATA_DIR/replicas"
```

Symptoms: the `AlloyIngestStalled` alert fires (throughput, not liveness), and
`curl -s 127.0.0.1:9101/health` shows `mr_trace_relay_lines_read_total` flat. Fix the
host-side permissions. Do not grant the containers extra capabilities; they run with
`cap_drop: [ALL]` and read-only mounts on purpose.

## 7. Identity provider (Better Auth)

The issuer in `ops/auth/` (loopback port 8443, SQLite) is backed up separately from the
game (`restic` tag `better-auth`). Losing it is worse than losing the game database:
SpacetimeDB derives each account's `Identity` from the token's issuer and subject, so
a lost issuer database orphans every account.

- **Signing key first.** The JWKS signing key can forge a token for any player. Keep
  it out of the routine backup and in a narrowly scoped secret store
  (`ops/auth/README.md` keeps it at `./secrets/jwks.key`, outside the database). If a
  backup set ever contains it, rotate the key.
- **Online backup** (SQLite `VACUUM INTO` is consistent while the service runs):

  ```sh
  sqlite3 /var/lib/better-auth/auth.sqlite "VACUUM INTO '/var/backups/auth.sqlite'"
  restic backup --tag better-auth /var/backups/auth.sqlite
  ```

- **Restore drill.** Restore, bring the issuer back on `127.0.0.1:8443`, sign in as a
  known test user, and confirm SpacetimeDB derives the same `Identity` as before. A
  changed issuer URL changes every identity, and this check is what catches it.

## 8. Deletion and backups

- An account deletion (`delete_account`, 7-day grace from
  `DELETION_GRACE_MS_DEFAULT` in `game-core/src/accounts/deletion.rs`) erases or
  anonymises the module's live state. It cannot reach host backups, snapshots or the
  commitlog: a deleted account can be restored from any backup older than the
  deletion. The `Identity` key and timestamps remain in shared historical rows
  (pseudonymisation, not erasure).
- Retuning the grace period is a code change to that constant.
- **A deletion looks stuck:** check the account's `status`, `deletion_requested_at_ms`
  and `terminal_at_ms`, and whether it has an `account_deletion_reaper_schedule` row.
  A `PendingDeletion` account with no schedule row is re-armed by
  `ensure_deletion_reapers_armed`, which runs on `init` and `sync_content` (re-run
  `sync_content` as the owner). The cascade runs as one transaction and stamps
  `terminal_at_ms` last, so a half-erased account cannot persist.
- **Export bundles** are a second copy of one player's data. They are purged when the
  owner requests a new export, by the deletion cascade, and by the hourly
  `export_bundle_reaper` after 7 days (`EXPORT_BUNDLE_TTL_MS`,
  `server-module/src/privacy.rs`). A missing reaper schedule is re-armed by the next
  export request or by `init`/`sync_content`. Bundles in a backup live as long as the
  backup does.
- Nothing prunes backups when an account is deleted. Once a retention window is chosen,
  prune with a dry run first:

  ```sh
  restic snapshots --tag monster-realm --json | jq -r '.[] | "\(.time)  \(.short_id)"'
  restic forget --tag monster-realm --keep-daily 7 --keep-weekly 4 --dry-run
  ```

## 9. Validate the stack configuration

```sh
node --test ops/observability/checks/stack-config-checks.test.mjs   # pure config checks (also in just test)
just observability-validate                                         # upstream validators in the pinned images (needs Docker)
```
