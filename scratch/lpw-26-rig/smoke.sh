#!/usr/bin/env bash
# smoke.sh <variant> <port> <cpu> — a short functional pass over one module variant on its own host:
# idle in the load zone, idle in zone 0, a 20-step bot walk with a watcher, then prints the tick
# count and the commit log by reducer for each phase.
set -euo pipefail
SB=$(cat /tmp/lpw26-sandbox-path)
export PATH="$HOME/.asdf/installs/nodejs/24.22.3/bin:$PATH"
v=$1 port=$2 cpu=$3
name=smoke-$v
"$SB/scripts/host.sh" "$name" "$port" "$cpu" "$SB/mods/$v.wasm" >/dev/null
cd "$SB/run/$name"
nexttx() { python3 "$SB/scripts/clogstat.py" "$name" | python3 -c 'import json,sys; print(json.load(sys.stdin)["next_tx"])'; }
ticks() { curl -s "http://127.0.0.1:$port/v1/metrics" | grep -E '^spacetime_reducer_plus_query_duration_sec_count.*reducer="(movement_tick|npc_wander_tick)"' | awk '{s+=$2} END {print s+0}'; }
phase() { # label, command...
  local label=$1; shift
  local t0 k0 t1 k1
  "$@" &
  local pid=$!
  sleep 4
  t0=$(nexttx); k0=$(ticks)
  sleep 10
  t1=$(nexttx); k1=$(ticks)
  wait $pid || true
  echo "== $v $label: ticks in 10 s = $((k1 - k0))"
  python3 "$SB/scripts/clogstat.py" "$name" --from-tx "$t0" --to-tx "$t1" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("   txs",d["txs"],"bytes",d["bytes"], {k:(v["txs"],v["bytes"],v["top_sizes"][:3]) for k,v in d["by_reducer"].items()})'
}
phase idle-load node "$SB/scripts/bot.mjs" --port "$port" --mode idle --name IdleL --zone 10000 --seconds 16 --log idle-load.jsonl
sleep 2
phase idle-zero node "$SB/scripts/bot.mjs" --port "$port" --mode idle --name IdleZ --seconds 16 --log idle-zero.jsonl
sleep 2
node "$SB/scripts/bot.mjs" --port "$port" --mode watch --watch-zone 10000 --seconds 22 --log watch.jsonl &
phase walk-load node "$SB/scripts/bot.mjs" --port "$port" --mode walk --name Walk --zone 10000 --steps 12 --runs 4 --log walk.jsonl
wait || true
sleep 2
echo "== $v after everyone left: schedule rows"
curl -s -X POST "http://127.0.0.1:$port/v1/database/lpw26/sql" -H "Authorization: Bearer $(cat owner.token)" \
  --data 'SELECT * FROM movement_tick_schedule' | head -c 600
echo
