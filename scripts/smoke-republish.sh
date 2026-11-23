#!/usr/bin/env bash
# Smoke test: publish → edit content → republish WITHOUT --delete-data →
# assert existing monster data survives AND new content version is served. Then, with
# CONTENT_VERSION unchanged, overwrite the module_info row with other numbers, republish,
# and assert the owner's sync_content restores the module's protocol numbers.
#
# Runs in nightly.yml only (requires a live SpacetimeDB instance — not CI-fast).
# macOS: uses GNU sed (sed -i without suffix arg); requires GNU sed in PATH.
#   Install: brew install gnu-sed && add gnubin to PATH, or use a Linux runner.
#
# Usage: scripts/smoke-republish.sh [server_url] [db_name]
#   server_url  SpacetimeDB server URL  (default: http://127.0.0.1:3000)
#   db_name     Database name           (default: monster-realm-smoke)
#
# Failure policy: any failure exits non-zero, causing the nightly
# job to fail (see CONTRIBUTING.md, "When the nightly run is red").
set -euo pipefail

SERVER="${1:-http://127.0.0.1:3000}"
DB="${2:-monster-realm-smoke}"

log() { echo "[smoke-republish] $*"; }
fail() { echo "[smoke-republish] FAIL: $*" >&2; exit 1; }

# Restore lib.rs on exit so local runs are left clean (CI runner is ephemeral).
# Emit a warning rather than silently swallowing restore failure (|| true would
# leave lib.rs patched locally without any diagnostic).
trap 'git checkout -- server-module/src/lib.rs 2>/dev/null || echo "[smoke-republish] WARNING: could not restore server-module/src/lib.rs — restore manually" >&2' EXIT

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
# Each reducer arg is its own JSON value on the pinned spacetime 2.8.1 CLI (the
# CLI assembles the args array itself). Wrapping in a JSON array double-nests and
# the server rejects with "Invalid arguments provided for reducer" — this exact
# bug kept the smoke job red from its first nightly run. Re-verified
# live 2026-08-22 against 2.8.1: join_game '"Name"' succeeds, while the wrapped
# form '["Name"]' STILL fails.
spacetime call -s "$SERVER" "$DB" join_game '"SmokePlayer"'

# Poll until the starter monster row appears (SQL query may lag one step).
# Pre-initialize so the log line and [ check after the loop are safe under set -u.
FOUND=0
MONSTER_ROWS=""
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
# Promise: publish on a live DB must not wipe existing rows.
log "Phase 4: rebuild + republish WITHOUT --delete-data"
spacetime build --module-path server-module
spacetime publish -s "$SERVER" --module-path server-module -y "$DB"

# Phase 5: call sync_content as the module owner (owner-callable since 12.5b-1).
# sync_content_inner detects the version mismatch and re-seeds all registries.
# Use `if ! VAR=$(cmd)` form: VAR=$(cmd) alone suppresses set -e on non-zero exit.
log "Phase 5: calling sync_content (owner-callable since 12.5b-1)"
if ! SYNC_OUT=$(spacetime call -s "$SERVER" "$DB" sync_content 2>&1); then
  fail "sync_content call exited non-zero: $SYNC_OUT"
fi
log "sync_content result: $SYNC_OUT"
if echo "$SYNC_OUT" | grep -qi "err\|rejected\|unauthorized"; then
  fail "sync_content was rejected (check owner identity): $SYNC_OUT"
fi

# Phase 6: assert data survived + new content served.
log "Phase 6: asserting starter monster survived the republish"
FOUND=0
MONSTER_ROWS_AFTER=""
for i in $(seq 1 10); do
  MONSTER_ROWS_AFTER=$(spacetime sql -s "$SERVER" "$DB" "SELECT monster_id FROM monster")
  if echo "$MONSTER_ROWS_AFTER" | grep -qE '[0-9]+'; then FOUND=1; break; fi
  log "waiting for monster row post-republish (attempt $i/10)..."
  sleep 1
done
log "monster rows after republish: $MONSTER_ROWS_AFTER"
[ "$FOUND" -eq 1 ] || fail "starter monster LOST after republish WITHOUT --delete-data (live-data promise broken)"

log "Phase 6: asserting new content version served"
CFG_ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT content_version FROM config")
log "config rows after sync_content: $CFG_ROWS"
# This grep (like the two monster-row greps above) deliberately reads the CLI's
# text/display output: it is a presence check, not a value decode, and switching
# to --format json would need jq, which is not guaranteed on the nightly runner.
# Use word-boundary anchoring to prevent false-positive substring matches
# (e.g., version 3 matching "13" or "30" in formatted table output).
if ! echo "$CFG_ROWS" | grep -qE "(^|[^0-9])${BUMP_VERSION}([^0-9]|$)"; then
  fail "content not updated after sync_content (expected version $BUMP_VERSION in config; got: $CFG_ROWS)"
fi

# Phase 7: the protocol numbers come back after a republish with CONTENT_VERSION UNCHANGED.
# lib.rs is still patched to BUMP_VERSION, the live module was built from it and
# config.content_version equals it, so a republish now is a republish with CONTENT_VERSION
# unchanged and the owner's sync_content takes the skip path: only a protocol-number restore that
# sits outside sync_content_inner's version gate brings the numbers back.
# The module's numbers are what the live row holds after a publish and the owner's sync: they are
# recorded from the database, never read out of a source file.

# One read of module_info. On spacetime 2.16.1 `--format json` prints one JSON line carrying
# `"rows":[[P,M]]` for exactly one row (two rows read `"rows":[[..],[..]]`, none `"rows":[]`).
protocol_json() {
  spacetime sql -s "$SERVER" --format json "$DB" "SELECT protocol, min_client_protocol FROM module_info"
}

# Fail unless module_info is exactly the one row ($1, $2); $3 names the step.
expect_protocol_row() {
  local want="\"rows\":[[$1,$2]]"
  local got
  if ! got=$(protocol_json 2>&1); then
    fail "$3: the module_info read exited non-zero: $got"
  fi
  grep -qF -- "$want" <<<"$got" \
    || fail "$3: expected module_info to be exactly the one row ($1, $2); got: $got"
}

log "Phase 7: asserting the stored content version is still $BUMP_VERSION"
CFG_ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT content_version FROM config")
if ! grep -qE "(^|[^0-9])${BUMP_VERSION}([^0-9]|$)" <<<"$CFG_ROWS"; then
  fail "Phase 7 needs config.content_version == $BUMP_VERSION (the skip path); got: $CFG_ROWS"
fi

log "Phase 7: recording the module's protocol numbers from the live row"
if ! PROTO_OUT=$(protocol_json 2>&1); then
  fail "the module_info read exited non-zero: $PROTO_OUT"
fi
PROTO_ROW=$(grep -oE '"rows":\[\[[0-9]+,[0-9]+\]\]' <<<"$PROTO_OUT" || true)
[ -n "$PROTO_ROW" ] \
  || fail "expected module_info to hold exactly one row of two numbers; got: $PROTO_OUT"
PROTOCOL=$(sed -E 's/^"rows":\[\[([0-9]+),([0-9]+)\]\]$/\1/' <<<"$PROTO_ROW")
MIN_CLIENT=$(sed -E 's/^"rows":\[\[([0-9]+),([0-9]+)\]\]$/\2/' <<<"$PROTO_ROW")
log "module_info holds protocol $PROTOCOL, min_client_protocol $MIN_CLIENT"

# Two other numbers, offset differently so a swapped column shows.
OTHER_PROTOCOL=$((PROTOCOL + 4242))
OTHER_MIN_CLIENT=$((MIN_CLIENT + 4141))
log "Phase 7: overwriting module_info with ($OTHER_PROTOCOL, $OTHER_MIN_CLIENT)"
if ! UPDATE_OUT=$(spacetime sql -s "$SERVER" "$DB" \
  "UPDATE module_info SET protocol = $OTHER_PROTOCOL, min_client_protocol = $OTHER_MIN_CLIENT WHERE id = 0" 2>&1); then
  fail "the module_info overwrite exited non-zero: $UPDATE_OUT"
fi
expect_protocol_row "$OTHER_PROTOCOL" "$OTHER_MIN_CLIENT" "after the overwrite"

# The source is unchanged since Phase 4 (publish builds it again from that same source), over
# the same data.
log "Phase 7: republish WITHOUT --delete-data (CONTENT_VERSION unchanged)"
spacetime publish -s "$SERVER" --module-path server-module -y "$DB"
# The publish alone restores nothing, so the restore below is the owner's sync_content's.
expect_protocol_row "$OTHER_PROTOCOL" "$OTHER_MIN_CLIENT" "after the republish, before sync_content"

log "Phase 7: calling sync_content as the owner (the skip path)"
if ! SYNC_OUT=$(spacetime call -s "$SERVER" "$DB" sync_content 2>&1); then
  fail "the skip-path sync_content call exited non-zero: $SYNC_OUT"
fi
log "sync_content result: $SYNC_OUT"
expect_protocol_row "$PROTOCOL" "$MIN_CLIENT" "after the owner's skip-path sync_content"

CFG_ROWS=$(spacetime sql -s "$SERVER" "$DB" "SELECT content_version FROM config")
if ! grep -qE "(^|[^0-9])${BUMP_VERSION}([^0-9]|$)" <<<"$CFG_ROWS"; then
  fail "the stored content version moved off $BUMP_VERSION during Phase 7; got: $CFG_ROWS"
fi

log "PASS: starter monster survived republish AND new content served (version $BUMP_VERSION) AND protocol numbers restored ($PROTOCOL, $MIN_CLIENT) by the owner's sync_content"
