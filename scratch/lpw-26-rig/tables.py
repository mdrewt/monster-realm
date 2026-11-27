#!/usr/bin/env python3
"""tables.py — the record's tables from run/matrix.json (aggregate.py) and the timing probes."""
import json, sys, statistics as st
SB = open('/tmp/lpw26-sandbox-path').read().strip()
m = json.load(open(f'{SB}/run/matrix.json'))
NAME = {'today': 'Today', 'a': 'A', 'b': 'B', 'c': 'C', 'd': 'D'}
ZONE = {'npc': 'with NPCs', 'none': 'without'}
COND = {'idle': 'standing', 'walk1': 'one walking', 'walk8': 'eight walking'}
cell = {(r['variant'], r['zone'], r['cond']): r for r in m}
print('| Alternative | Zone | Condition | Window, s | Tick calls an hour | Transactions an hour | Log records an hour | Commit log, bytes | MiB an hour | Sent to clients, MiB an hour | Host CPU, % of one thread |')
print('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for zone in ('npc', 'none'):
    for cond in ('idle', 'walk1', 'walk8'):
        for v in ('today', 'a', 'b', 'c', 'd'):
            r = cell.get((v, zone, cond))
            if not r:
                print(f'| {NAME[v]} | {ZONE[zone]} | {COND[cond]} | MISSING |')
                continue
            print(f"| {NAME[v]} | {ZONE[zone]} | {COND[cond]} | {r['window_s']:.0f} | {r['tick_calls_h']:,} | {r['tx_all_h']:,} | {r['records_h']:,} | {r['clog_dir_bytes']:,} | {r['clog_mib_h']:.3f} | {r['sent_mib_h']:.2f} | {r['cpu_pct']:.2f} |")
print()
bad = [(r['variant'], r['zone'], r['cond']) for r in m if r['driver_valid'] is False or (r['driver_rejected'] or 0) > 0 or abs(r['window_s'] - 1800) > 1]
print('invalid or rejected or odd window:', bad)
print('load average over the windows: median', st.median(r['loadavg_median'] for r in m), 'highest', max(r['loadavg_max'] for r in m))
print('rss end MiB range', min(r['rss_end_mib'] for r in m), max(r['rss_end_mib'] for r in m), 'hwm max', max(r['hwm_mib'] for r in m))
for r in m:
    if r['clog_bytes'] != r['clog_dir_bytes'] or r['record_bytes'] != r['clog_bytes']:
        print('note: sizes differ', r['variant'], r['zone'], r['cond'], r['clog_bytes'], r['clog_dir_bytes'], r['record_bytes'])
