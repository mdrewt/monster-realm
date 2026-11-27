#!/usr/bin/env python3
"""aggregate.py [--md] — one row per measured cell (run/cell-<variant>-<cond>-<zone>):

  window seconds; reducer calls per hour from /v1/metrics (movement_tick, npc_wander_tick,
  enqueue_move); committed transactions per hour from /v1/metrics (reducer and internal);
  commit-log records and bytes in the window (the log walked record by record), bytes per hour
  from the apparent size of replicas/1/clog (section 7's method) and from the records; bytes sent
  to clients per hour; host CPU as a share of one thread; resident memory at window end.
"""
import glob
import json
import os
import sys

SB = open('/tmp/lpw26-sandbox-path').read().strip()
MIB = 1024 * 1024
VAR = ['today', 'a', 'b', 'c', 'd']
ZONES = ['npc', 'none']
CONDS = ['idle', 'walk1', 'walk8']
rows = []
for v in VAR:
    for zone in ZONES:
        for cond in CONDS:
            d = f'{SB}/run/cell-{v}-{cond}-{zone}'
            if not os.path.exists(f'{d}/done'):
                continue
            s = [json.loads(l) for l in open(f'{d}/samples.jsonl')]
            a, b = s[0], s[-1]
            dt = b['mono'] - a['mono']
            per_h = 3600.0 / dt

            def delta(key, sub):
                return b[key].get(sub, 0) - a[key].get(sub, 0)

            calls = {k: delta('calls', k) for k in b['calls']}
            tx_reducer = sum(b['txns'][k] - a['txns'].get(k, 0) for k in b['txns'] if k.startswith('Reducer:'))
            tx_internal = sum(b['txns'][k] - a['txns'].get(k, 0) for k in b['txns'] if k.startswith('Internal:'))
            w = json.load(open(f'{d}/clog-window.json'))
            by = w['by_reducer']
            report = None
            if os.path.exists(f'{d}/report.json') and os.path.getsize(f'{d}/report.json') > 0:
                report = json.load(open(f'{d}/report.json'))
            lvl = report['levels'][0] if report else None
            rows.append({
                'variant': v, 'zone': zone, 'cond': cond, 'window_s': round(dt, 1), 'samples': len(s),
                'tick_calls_h': round((calls.get('movement_tick', 0) + calls.get('npc_wander_tick', 0)) * per_h),
                'movement_tick_h': round(calls.get('movement_tick', 0) * per_h),
                'npc_wander_tick_h': round(calls.get('npc_wander_tick', 0) * per_h),
                'enqueue_h': round(calls.get('enqueue_move', 0) * per_h),
                'tx_reducer_h': round(tx_reducer * per_h),
                'tx_internal_h': round(tx_internal * per_h),
                'tx_all_h': round((tx_reducer + tx_internal) * per_h),
                'clog_bytes': b['clog_log'] - a['clog_log'],
                'clog_dir_bytes': b['clog'] - a['clog'],
                'clog_mib_h': round((b['clog'] - a['clog']) * per_h / MIB, 3),
                'records': w['txs'], 'record_bytes': w['bytes'],
                'records_h': round(w['txs'] * per_h),
                'by_reducer': {k: [x['txs'], x['bytes']] for k, x in by.items()},
                'sent_mib_h': round((b['sent'] - a['sent']) * per_h / MIB, 3),
                'data_dir_mib_h': round((b['data_dir'] - a['data_dir']) * per_h / MIB, 3),
                'cpu_pct': round((b['cpu_usec'] - a['cpu_usec']) / (dt * 1e6) * 100, 3),
                'rss_end_mib': round(b['VmRSS'] / 1024, 1), 'hwm_mib': round(b['VmHWM'] / 1024, 1),
                'loadavg_median': sorted(x.get('loadavg1', 0) for x in s)[len(s) // 2],
                'loadavg_max': max(x.get('loadavg1', 0) for x in s),
                'driver_valid': lvl['valid'] if lvl else None,
                'driver_sends': lvl['attempted_sends'] if lvl else None,
                'driver_rejected': lvl['enqueue_move_rejected_delta'] if lvl else None,
                'tick_p95_s': lvl['movement_tick_p95_s'] if lvl else None,
            })
json.dump(rows, open(f'{SB}/run/matrix.json', 'w'), indent=1)
if '--md' in sys.argv:
    print('| Variant | Zone | Condition | Window, s | Tick calls/h | Transactions/h | Log records/h | Commit log, bytes | MiB/h | Sent, MiB/h | CPU, % |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
for r in rows:
    if '--md' in sys.argv:
        print(f"| {r['variant']} | {r['zone']} | {r['cond']} | {r['window_s']} | {r['tick_calls_h']} | {r['tx_all_h']} | {r['records_h']} | {r['clog_dir_bytes']} | {r['clog_mib_h']} | {r['sent_mib_h']} | {r['cpu_pct']} |")
    else:
        print(r['variant'], r['zone'], r['cond'], 'win', r['window_s'], 'ticks/h', r['tick_calls_h'], 'tx/h', r['tx_all_h'],
              f"(internal {r['tx_internal_h']})", 'rec/h', r['records_h'], 'clog', r['clog_dir_bytes'], 'MiB/h', r['clog_mib_h'],
              'sent MiB/h', r['sent_mib_h'], 'cpu%', r['cpu_pct'], 'valid', r['driver_valid'], 'rej', r['driver_rejected'])
