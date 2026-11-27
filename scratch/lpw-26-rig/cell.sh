#!/usr/bin/env bash
# cell.sh <variant> <cond> <zone> <port> <cpu> [window-s]
#   variant: today | a | b | c | d      cond: idle | walk1 | walk8      zone: npc | none
# One measured cell by docs/local-play.md section 7's method: a host of its own (2 GiB scope, one
# core's two threads, fresh data directory), the module published, the load started, 60 seconds'
# wait, then a window sampled every 5 seconds. Load and sampler run on threads 20-31.
set -euo pipefail
SB=$(cat /tmp/lpw26-sandbox-path)
export PATH="$HOME/.asdf/installs/nodejs/24.22.3/bin:$PATH"
v=$1 cond=$2 zone=$3 port=$4 cpu=$5 window=${6:-1800}
name=cell-$v-$cond-$zone
LOADCPUS=20-31
"$SB/scripts/host.sh" "$name" "$port" "$cpu" "$SB/mods/$v.wasm"
cd "$SB/run/$name"
samples=$((window / 5 + 1))
loadsecs=$((window + 100))
case "$cond" in
  idle)
    zarg=()
    [ "$zone" = none ] && zarg=(--zone 10000)
    taskset -c $LOADCPUS node "$SB/scripts/bot.mjs" --port "$port" --mode idle --name Idle \
      "${zarg[@]}" --seconds "$loadsecs" --log bot.jsonl >bot.out 2>&1 &
    ;;
  walk1 | walk8)
    n=${cond#walk}
    zarg=()
    [ "$zone" = none ] && zarg=(--zones 1)
    scrapes=$(((loadsecs + 29) / 30))
    taskset -c $LOADCPUS "$SB/bin/mr_load_driver" --run-id "lpw26-$name" \
      --server "http://127.0.0.1:$port" --db lpw26 --clients-start "$n" --clients-step 1 \
      --clients-max "$n" --hold-scrapes "$scrapes" --scrape-interval-ms 30000 --move-rate 5 \
      "${zarg[@]}" >report.json 2>driver.err &
    ;;
esac
loadpid=$!
sleep 60
python3 "$SB/scripts/clogstat.py" "$name" >clog-start.json
taskset -c $LOADCPUS python3 "$SB/scripts/sample.py" "$name" 5 "$samples"
python3 "$SB/scripts/clogstat.py" "$name" >clog-end.json
t0=$(python3 -c 'import json; print(json.load(open("clog-start.json"))["next_tx"])')
t1=$(python3 -c 'import json; print(json.load(open("clog-end.json"))["next_tx"])')
python3 "$SB/scripts/clogstat.py" "$name" --from-tx "$t0" --to-tx "$t1" >clog-window.json
wait $loadpid || echo "load exited $?" >>cell.notes
kill "$(cat pid)" 2>/dev/null || true
echo done >done
