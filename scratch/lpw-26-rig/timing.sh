#!/usr/bin/env bash
# timing.sh <tag> <variant>... — the step-timing probes, every variant at once, each on its own
# pinned host (docs/local-play.md section 7's confinement), bots on threads 20-31:
#   walk-none : 40 walks of 12 steps in the load zone, from rest (1.2 to 1.4 s between walks), a
#               watcher stamping every row it is sent;
#   walk-npc  : 30 walks of 7 steps along row 1 of zone 0 (the zone with the NPC that wanders);
#   press     : 150 presses from rest (1.3 to 1.7 s apart), send to acknowledging row.
set -uo pipefail
SB=$(cat /tmp/lpw26-sandbox-path)
export PATH="$HOME/.asdf/installs/nodejs/24.22.3/bin:$PATH"
tag=$1
shift
i=${BASE:-0}
for v in "$@"; do
  (
    name=timing-$tag-$v
    port=$((3950 + i))
    "$SB/scripts/host.sh" "$name" "$port" $((2 * i)) "$SB/mods/$v.wasm" >/dev/null
    cd "$SB/run/$name"
    B="taskset -c 20-31 node $SB/scripts/bot.mjs --port $port"
    $B --mode watch --watch-zone 10000 --seconds 200 --log watch-none.jsonl &
    sleep 0.5
    $B --mode walk --name WalkerN --zone 10000 --steps 12 --runs 40 --rest-ms 1200 --seed 11 --log walk-none.jsonl
    wait
    $B --mode watch --watch-zone 0 --seconds 110 --log watch-npc.jsonl &
    sleep 0.5
    $B --mode walk --name WalkerZ --steps 7 --runs 30 --rest-ms 1200 --seed 12 --log walk-npc.jsonl
    wait
    $B --mode press --name Presser --zone 10000 --presses 150 --press-rest-ms 1300 --seed 13 --log press.jsonl
    cat /proc/loadavg >loadavg.txt
    kill "$(cat pid)" 2>/dev/null
    echo done >done
  ) >"$SB/run/timing-$tag-$v.out" 2>&1 &
  i=$((i + 1))
done
wait
