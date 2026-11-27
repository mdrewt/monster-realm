#!/usr/bin/env bash
# batch.sh <batch-name> <window-s> <cell>...   where <cell> is variant:cond:zone
# Runs up to ten cells at once, each host on its own core (threads 0-19), ports from 3920.
set -uo pipefail
SB=$(cat /tmp/lpw26-sandbox-path)
batch=$1 window=$2
shift 2
i=0
for cell in "$@"; do
  IFS=: read -r v cond zone <<<"$cell"
  setsid nohup "$SB/scripts/cell.sh" "$v" "$cond" "$zone" $((3920 + i)) $((2 * i)) "$window" \
    >"$SB/run/$batch-$v-$cond-$zone.out" 2>&1 &
  i=$((i + 1))
done
wait
date -u +%FT%TZ >"$SB/run/$batch.done"
