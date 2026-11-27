#!/usr/bin/env python3
"""sample.py <run-name> <interval-s> <count> [out-name]

Every <interval-s> seconds, <count> times, append one JSON line to run/<run-name>/<out-name>
(default samples.jsonl): the apparent size of every part of the data directory
(docs/local-play.md section 7: replicas/1/clog is the commit log), the host's resident memory and
high-water mark from /proc/<pid>/status, processor time from the scope's cpu.stat, and the host's
/v1/metrics counters: committed transactions per reducer, reducer calls, bytes written and bytes
sent to clients.
"""
import json
import os
import re
import sys
import time
import urllib.request

SB = open('/tmp/lpw26-sandbox-path').read().strip()
name, interval, count = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
out_name = sys.argv[4] if len(sys.argv) > 4 else 'samples.jsonl'
run = f'{SB}/run/{name}'
port = open(f'{run}/port').read().strip()
pid = open(f'{run}/pid').read().strip()
unit = open(f'{run}/unit').read().strip()
uid = os.getuid()
cpu_stat = f'/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/app.slice/{unit}.scope/cpu.stat'


def tree_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def proc_status():
    out = {}
    with open(f'/proc/{pid}/status') as fh:
        for line in fh:
            if line.startswith(('VmRSS:', 'VmHWM:')):
                k, v = line.split(':')
                out[k] = int(v.split()[0])  # kB
    return out


def cpu_usec():
    try:
        with open(cpu_stat) as fh:
            for line in fh:
                if line.startswith('usage_usec'):
                    return int(line.split()[1])
    except OSError:
        return None
    return None


LINE = re.compile(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9eE+.\-]+|NaN)$')
LABEL = re.compile(r'([a-zA-Z_]+)="([^"]*)"')


def metrics():
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/v1/metrics', timeout=10) as r:
        text = r.read().decode()
    txns, calls, written, sent, wasm_usec, fuel = {}, {}, 0, 0, {}, {}
    sched_delay = {}
    for line in text.splitlines():
        if not line or line[0] == '#':
            continue
        m = LINE.match(line)
        if not m:
            continue
        fam, labels, val = m.group(1), dict(LABEL.findall(m.group(2) or '')), float(m.group(3))
        if fam == 'spacetime_num_txns_total' and labels.get('committed') == 'true':
            key = f"{labels.get('txn_type')}:{labels.get('reducer')}"
            txns[key] = txns.get(key, 0) + val
        elif fam == 'spacetime_reducer_plus_query_duration_sec_count':
            if val:
                calls[labels.get('reducer')] = val
        elif fam == 'spacetime_num_bytes_written_total':
            written += val
        elif fam == 'spacetime_num_bytes_sent_to_clients_total':
            sent += val
        elif fam == 'reducer_wasm_time_usec' and val:
            wasm_usec[labels.get('reducer')] = val
        elif fam == 'spacetime_scheduled_function_delay_seconds_bucket' and labels.get('function') == 'movement_tick':
            sched_delay[labels.get('le')] = val
    return {'txns': txns, 'calls': calls, 'written': written, 'sent': sent, 'wasm_usec': wasm_usec,
            'sched_delay': sched_delay, 'metrics_bytes': len(text)}


data = f'{run}/data'
with open(f'{run}/{out_name}', 'a') as fh:
    start = time.monotonic()
    for i in range(count):
        target = start + i * interval
        delay = target - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        row = {
            'i': i,
            'wall': time.time(),
            'mono': time.monotonic(),
            'clog': tree_size(f'{data}/replicas/1/clog'),
            'clog_log': sum(os.lstat(os.path.join(f'{data}/replicas/1/clog', f)).st_size
                            for f in os.listdir(f'{data}/replicas/1/clog') if f.endswith('.stdb.log')),
            'snapshots': tree_size(f'{data}/replicas/1/snapshots'),
            'module_logs': tree_size(f'{data}/replicas/1/module_logs'),
            'logs': tree_size(f'{data}/logs'),
            'data_dir': tree_size(data),
            'cpu_usec': cpu_usec(),
            'loadavg1': float(open('/proc/loadavg').read().split()[0]),
            **proc_status(),
            **metrics(),
        }
        fh.write(json.dumps(row) + '\n')
        fh.flush()
