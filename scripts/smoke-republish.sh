#!/usr/bin/env bash
# Smoke test: publish → edit content → republish WITHOUT --delete-data →
# assert existing player data survives AND new content version is served.
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

# ---------------------------------------------------------------------------
# Phase 1: initial publish (creates fresh DB, runs init → seeds content V_orig)
# ---------------------------------------------------------------------------
log "Phase 1: build + initial publish (--delete-data, fresh state)"
spacetime build --module-path server-module
spacetime publish -s "$SERVER" --module-path server-module --delete-data -y "$DB"

# ---------------------------------------------------------------------------
# Phase 2: create test data via reducer call
# ---------------------------------------------------------------------------
log "Phase 2: calling join_game to create a player row"
spacetime call -s "$SERVER" "$DB" join_game "SmokePlayer"

# Give the server a moment to commit the reducer result before querying.
sleep 1

# Verify player exists in the public `player` table.
PLAYER_ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT name FROM player" 2>&1)
log "player rows after join_game: $PLAYER_ROWS"
if ! echo "$PLAYER_ROWS" | grep -q "SmokePlayer"; then
  fail "no player 'SmokePlayer' found after join_game (data creation failed)"
fi

# ---------------------------------------------------------------------------
# Phase 3: bump CONTENT_VERSION to simulate a live content update.
# sync_content_inner skips re-seeding when cfg.content_version == CONTENT_VERSION
# (early-return at content.rs:35); bumping forces it to re-run the full seed.
# The trap above restores lib.rs on EXIT (keeps local runs clean).
# ---------------------------------------------------------------------------
ORIG_VERSION=$(grep -oP '(?<=CONTENT_VERSION: u32 = )\d+' server-module/src/lib.rs)
BUMP_VERSION=$((ORIG_VERSION + 100))
sed -i "s/CONTENT_VERSION: u32 = ${ORIG_VERSION}/CONTENT_VERSION: u32 = ${BUMP_VERSION}/" \
  server-module/src/lib.rs
log "Phase 3: CONTENT_VERSION patched: $ORIG_VERSION → $BUMP_VERSION"

# ---------------------------------------------------------------------------
# Phase 4: rebuild + republish WITHOUT --delete-data (live-content-update path)
# This is the ADR-0006 / ADR-0037 promise: `just publish` on a live DB must
# not wipe player data. The module binary now embeds CONTENT_VERSION=$BUMP_VERSION.
# ---------------------------------------------------------------------------
log "Phase 4: rebuild + republish WITHOUT --delete-data"
spacetime build --module-path server-module
spacetime publish -s "$SERVER" --module-path server-module -y "$DB"

# ---------------------------------------------------------------------------
# Phase 5: call sync_content as the module owner (12.5b-1: owner-callable guard).
# sync_content_inner detects the version mismatch and re-seeds all registries.
# ---------------------------------------------------------------------------
log "Phase 5: calling sync_content (owner-callable since 12.5b-1)"
spacetime call -s "$SERVER" "$DB" sync_content

sleep 1

# ---------------------------------------------------------------------------
# Phase 6: assert data survived + new content served
# ---------------------------------------------------------------------------
log "Phase 6: asserting player data survived the republish"
PLAYER_ROWS_AFTER=$(spacetime sql -s "$SERVER" "$DB" "SELECT name FROM player" 2>&1)
log "player rows after republish: $PLAYER_ROWS_AFTER"
if ! echo "$PLAYER_ROWS_AFTER" | grep -q "SmokePlayer"; then
  fail "player data LOST after republish WITHOUT --delete-data (ADR-0006/ADR-0037 promise broken)"
fi

log "Phase 6: asserting new content version served"
CFG_ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT content_version FROM config" 2>&1)
log "config rows after sync_content: $CFG_ROWS"
if ! echo "$CFG_ROWS" | grep -q "$BUMP_VERSION"; then
  fail "content not updated after sync_content (expected version $BUMP_VERSION in config; got: $CFG_ROWS)"
fi

log "PASS: data survived republish AND new content served (version $BUMP_VERSION)"
