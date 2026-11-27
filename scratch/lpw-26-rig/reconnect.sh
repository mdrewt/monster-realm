#!/usr/bin/env bash
# reconnect.sh <variant> <port> — what a client is sent around a walk in the load zone:
#   a watcher subscribed throughout; a second watcher that subscribes about a second into the walk;
#   the walker's own socket dropped with its seventh input in flight, then the same identity
#   connecting again 300 ms later, joining and walking three more steps.
set -euo pipefail
SB=$(cat /tmp/lpw26-sandbox-path)
export PATH="$HOME/.asdf/installs/nodejs/24.22.3/bin:$PATH"
v=$1 port=$2
name=reconnect-$v
"$SB/scripts/host.sh" "$name" "$port" 30 "$SB/mods/$v.wasm" >/dev/null
cd "$SB/run/$name"
TOKEN=$(cat owner.token)
( for _ in $(seq 1 110); do
    printf '%s ' "$(date +%s%3N)"
    curl -s -X POST "http://127.0.0.1:$port/v1/database/lpw26/sql" -H "Authorization: Bearer $TOKEN" \
      --data 'SELECT * FROM movement_tick_schedule' | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[0]["rows"]))'
    sleep 0.1
  done >sched.log 2>&1 ) &
B="taskset -c 28-29 node $SB/scripts/bot.mjs --port $port"
$B --mode watch --watch-zone 10000 --seconds 12 --log watch-all.jsonl &
sleep 0.4
( sleep 2.75; $B --mode watch --watch-zone 10000 --seconds 3 --log watch-late.jsonl ) &
$B --mode walk --name Walker --zone 10000 --steps 12 --runs 1 --rest-ms 1200 --token-file walker.token \
  --drop-at-step 6 --log walk-1.jsonl
sleep 0.3
$B --mode walk --name Walker --zone 10000 --steps 3 --runs 1 --rest-ms 600 --dirs west --token-file walker.token \
  --log walk-2.jsonl
wait
kill "$(cat pid)" 2>/dev/null || true
python3 - <<'PY'
import json
def rows(f): return [json.loads(l) for l in open(f)]
def show(r): return {k: r[k] for k in ('kind','zone','x','y','action','q','ack','started') if k in r}
late = rows('watch-late.jsonl')
t0 = next(r['wall'] for r in late if r['ev'] == 'watching')
print('late watcher, initial rows:', [show(r) for r in late if r['ev'] == 'row' and r['kind'] == 'initial'])
print('late watcher, next rows:', [(r['wall'] - t0, r['x'], r['action']) for r in late if r['ev'] == 'row' and r['kind'] != 'initial'][:4])
w1 = rows('walk-1.jsonl'); drop = next(r for r in w1 if r['ev'] == 'drop')
print('walker dropped at wall', drop['wall'], 'own row then: x', drop['x'], 'ack', drop['ack'], '(7 inputs sent)')
allw = rows('watch-all.jsonl')
print('first watcher around the drop:', [(r['wall'] - drop['wall'], r['ev'], r.get('x'), r.get('action'), r.get('zone')) for r in allw if r['ev'] in ('row', 'del') and -450 < r['wall'] - drop['wall'] < 2500])
w2 = rows('walk-2.jsonl')
print('walker after reconnect, rows:', [(r['wall'] - drop['wall'], r['kind'], r.get('reducer'), r['zone'], r['x'], r['y'], r['action'], r['q'], r['ack']) for r in w2 if r['ev'] == 'row'][:9])
PY
echo "schedule table (changes only), ms after the drop:"
D=$(python3 -c "import json; print(next(json.loads(l)['wall'] for l in open('walk-1.jsonl') if '\"drop\"' in l))")
awk -v d="$D" '{t=$1; $1=""; if ($0 != last) {print t-d, $0; last=$0}}' sched.log | head -30
