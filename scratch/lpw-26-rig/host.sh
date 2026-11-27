#!/usr/bin/env bash
# host.sh <run-name> <port> <cpu-a> <wasm> [db]
# Start one spacetimedb-standalone 2.16.1 in its own systemd scope (2 GiB, no swap), pinned to
# hardware threads <cpu-a>,<cpu-a+1>, on a fresh data directory; create the owner's token; publish
# <wasm> as database <db> (default lpw26). docs/local-play.md section 7's method.
set -euo pipefail
SB=$(cat /tmp/lpw26-sandbox-path)
name=$1 port=$2 cpu=$3 wasm=$4 db=${5:-lpw26}
run=$SB/run/$name
if [ -e "$run" ]; then
  echo "host.sh: $run exists; a run never reuses a data directory" >&2
  exit 1
fi
mkdir -p "$run"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
STANDALONE=$HOME/.local/share/spacetime/bin/2.16.1/spacetimedb-standalone
nohup systemd-run --user --scope --unit="lpw26-$name-$$" -p MemoryMax=2G -p MemorySwapMax=0 \
  taskset -c "$cpu,$((cpu + 1))" "$STANDALONE" start --data-dir "$run/data" \
  --jwt-key-dir "$run/keys" --listen-addr "127.0.0.1:$port" --non-interactive \
  >"$run/host.log" 2>&1 &
echo "lpw26-$name-$$" >"$run/unit"
for _ in $(seq 1 400); do
  if curl -fsS "http://127.0.0.1:$port/v1/ping" >/dev/null 2>&1; then break; fi
  sleep 0.05
done
curl -fsS "http://127.0.0.1:$port/v1/ping" >/dev/null
curl -fsS -X POST "http://127.0.0.1:$port/v1/identity" >"$run/owner.json"
token=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$run/owner.json")
echo "$token" >"$run/owner.token"
curl -fsS -X PUT "http://127.0.0.1:$port/v1/database/$db" -H "Authorization: Bearer $token" \
  -H "Content-Type: application/wasm" --data-binary @"$wasm" >"$run/publish.json"
ss -ltnp 2>/dev/null | grep "127.0.0.1:$port " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 >"$run/pid"
echo "$port" >"$run/port"
echo "host $name up on $port pid $(cat "$run/pid") cpus $cpu,$((cpu + 1))"
