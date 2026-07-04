#!/usr/bin/env bash
# Smoke test: publish → edit content → republish WITHOUT --delete-data →
# assert existing monster data survives AND new content version is served.
#
# Implements spec §12.5b-6 / ADR-0079.
# Runs in nightly.yml only (requires a live SpacetimeDB instance — not CI-fast).
#
# Usage: scripts/smoke-republish.sh [server_url] [db_name]
#   server_url  SpacetimeDB server URL  (default: http://127.0.0.1:3000)
#   db_name     Database name           (default: monster-realm-smoke)
#
# Failure policy (ADR-0079): any failure exits non-zero, causing the nightly
# job to fail. The supervisor inserts the failure as the NEXT slice in the
# milestone queue (same priority as fix-red-master, below it in ordering).
set -euo pipefail

SERVER="${1:-http://127.0.0.1:3000}"
DB="${2:-monster-realm-smoke}"

log() { echo "[smoke-republish] $*"; }
fail() { echo "[smoke-republish] FAIL: $*" >&2; exit 1; }

# Restore lib.rs on exit so local runs are left clean (CI runner is ephemeral).
trap 'git checkout -- server-module/src/lib.rs 2>/dev/null || true' EXIT

# Phase 1: initial publish (creates fresh DB, runs init → seeds content V_orig)
log "Phase 1: build + initial publish (--delete-data, fresh state)"
spacetime build --module-path server-module
spacetime publish -s "$SERVER" --module-path server-module --delete-data -y "$DB"

# Phase 2: create test data via reducer call.
# join_game creates a starter monster (session-independent table) in addition to
# player+character rows. We assert on the monster table — NOT the player table.
# RT-SR-01: on_disconnect deletes the player row the moment the CLI disconnects,
# so player-table assertions after a one-shot `spacetime call` are vacuous.
log "Phase 2: calling join_game to create starter monster"
# Reducer args are a JSON array per SpacetimeDB 2.x CLI convention.
spacetime call -s "$SERVER" "$DB" join_game '["SmokePlayer"]'

# Poll until the starter monster row appears (SQL query may lag one step).
FOUND=0
for i in $(seq 1 10); do
  MONSTER_ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT monster_id FROM monster")
  if echo "$MONSTER_ROWS" | grep -qE '[0-9]+'; then FOUND=1; break; fi
  log "waiting for starter monster row (attempt $i/10)..."
  sleep 1
done
log "monster rows after join_game: $MONSTER_ROWS"
[ "$FOUND" -eq 1 ] || fail "no starter monster found after join_game (data creation failed)"

# Phase 3: bump CONTENT_VERSION to simulate a live content update.
# sync_content_inner skips re-seeding when cfg.content_version == CONTENT_VERSION;
# bumping by 1 forces it to re-run the full seed. The trap restores lib.rs on EXIT.
ORIG_VERSION=$(sed -n 's/^pub(crate) const CONTENT_VERSION: u32 = \([0-9]*\);.*/\1/p' server-module/src/lib.rs)
[ -n "$ORIG_VERSION" ] || fail "could not extract CONTENT_VERSION from server-module/src/lib.rs"
BUMP_VERSION=$((ORIG_VERSION + 1))
# Anchored to the declaration line start so comments/strings elsewhere are not matched.
sed -i "s/^pub(crate) const CONTENT_VERSION: u32 = ${ORIG_VERSION};/pub(crate) const CONTENT_VERSION: u32 = ${BUMP_VERSION};/" \
  server-module/src/lib.rs
grep -q "CONTENT_VERSION: u32 = ${BUMP_VERSION}" server-module/src/lib.rs \
  || fail "CONTENT_VERSION patch failed — expected ${BUMP_VERSION} in lib.rs after sed"
log "Phase 3: CONTENT_VERSION patched: $ORIG_VERSION → $BUMP_VERSION"

# Phase 4: rebuild + republish WITHOUT --delete-data (live-content-update path).
# ADR-0006 / ADR-0037 promise: publish on a live DB must not wipe existing rows.
log "Phase 4: rebuild + republish WITHOUT --delete-data"
spacetime build --module-path server-module
spacetime publish -s "$SERVER" --module-path server-module -y "$DB"

# Phase 5: call sync_content as the module owner (owner-callable since 12.5b-1).
# sync_content_inner detects the version mismatch and re-seeds all registries.
log "Phase 5: calling sync_content (owner-callable since 12.5b-1)"
SYNC_OUT=$(spacetime call -s "$SERVER" "$DB" sync_content 2>&1)
log "sync_content result: $SYNC_OUT"
if echo "$SYNC_OUT" | grep -qi "err\|rejected\|unauthorized"; then
  fail "sync_content was rejected (check owner identity): $SYNC_OUT"
fi

# Phase 6: assert data survived + new content served.
log "Phase 6: asserting starter monster survived the republish"
FOUND=0
for i in $(seq 1 10); do
  MONSTER_ROWS_AFTER=$(spacetime sql -s "$SERVER" "$DB" "SELECT monster_id FROM monster")
  if echo "$MONSTER_ROWS_AFTER" | grep -qE '[0-9]+'; then FOUND=1; break; fi
  log "waiting for monster row post-republish (attempt $i/10)..."
  sleep 1
done
log "monster rows after republish: $MONSTER_ROWS_AFTER"
[ "$FOUND" -eq 1 ] || fail "starter monster LOST after republish WITHOUT --delete-data (ADR-0006/ADR-0037 promise broken)"

log "Phase 6: asserting new content version served"
CFG_ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT content_version FROM config")
log "config rows after sync_content: $CFG_ROWS"
if ! echo "$CFG_ROWS" | grep -q "$BUMP_VERSION"; then
  fail "content not updated after sync_content (expected version $BUMP_VERSION in config; got: $CFG_ROWS)"
fi

log "PASS: starter monster survived republish AND new content served (version $BUMP_VERSION)"
