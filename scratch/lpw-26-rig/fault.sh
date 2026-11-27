#!/usr/bin/env bash
# fault.sh <variant> <port> — the failed-tick scenario on <variant>-fault.wasm: a walker in the
# load zone makes two 12-step walks from rest; every tick of the 500 ms after the first input of
# walk 0, and of the 500 ms after the sixth input of walk 1, fails. A watcher stamps what arrives
# and a poller reads the schedule table every 100 ms.
set -euo pipefail
SB=$(cat /tmp/lpw26-sandbox-path)
export PATH="$HOME/.asdf/installs/nodejs/24.22.3/bin:$PATH"
v=$1 port=$2
name=fault-$v
"$SB/scripts/host.sh" "$name" "$port" 30 "$SB/mods/$v-fault.wasm" >/dev/null
cd "$SB/run/$name"
TOKEN=$(cat owner.token)
( for _ in $(seq 1 220); do
    printf '%s ' "$(date +%s%3N)"
    curl -s -X POST "http://127.0.0.1:$port/v1/database/lpw26/sql" -H "Authorization: Bearer $TOKEN" \
      --data 'SELECT * FROM movement_tick_schedule' | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[0]["rows"]))'
    sleep 0.1
  done >sched.log 2>&1 ) &
taskset -c 28-29 node "$SB/scripts/bot.mjs" --port "$port" --mode watch --watch-zone 10000 --seconds 24 --log watch.jsonl &
sleep 0.5
taskset -c 28-29 node "$SB/scripts/bot.mjs" --port "$port" --mode walk --name Faulty --zone 10000 --steps 12 --runs 2 \
  --rest-ms 2500 --stall-ms 1500 --fault-ms 500 --fault-at 0:0,1:5 --log walk.jsonl || echo "walker exit $?"
wait
kill "$(cat pid)" 2>/dev/null || true
python3 - <<'PY'
import json
rows = [json.loads(l) for l in open('walk.jsonl')]
sends = {r['seq']: r for r in rows if r.get('ev') == 'send'}
acks = {}
for r in rows:
    if r.get('ev') == 'row' and r.get('own') and r.get('kind') != 'initial':
        for seq, s in sends.items():
            if seq not in acks and r['ack'] >= seq and r['t'] >= s['t']:
                acks[seq] = r['t']
print('events:', [(r['ev'], r.get('run'), r.get('step'), r.get('unacked')) for r in rows if r.get('ev') in ('fault-set', 'stall', 'run-start', 'run-end')])
print('send -> ack ms by seq:', {seq: round(acks[seq] - s['t']) if seq in acks else None for seq, s in sorted(sends.items())})
w = [json.loads(l) for l in open('watch.jsonl')]
pos = [r for r in w if r.get('ev') == 'row' and r.get('kind') != 'initial']
gaps = [(round(b['t'] - a['t']), a['x'], b['x'], b['action']) for a, b in zip(pos, pos[1:])]
print('watcher: rows', len(pos), 'gaps over 250 ms:', [g for g in gaps if g[0] > 250])
PY
echo "schedule table around the faults (changes only):"
awk '{t=$1; $1=""; if ($0 != last) {print t, $0; last=$0}}' sched.log | head -40
