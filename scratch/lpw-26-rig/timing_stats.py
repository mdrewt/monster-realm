#!/usr/bin/env python3
"""timing_stats.py <tag> <variant>... — summarise the timing probes of timing.sh."""
import json
import sys

SB = open('/tmp/lpw26-sandbox-path').read().strip()
tag, variants = sys.argv[1], sys.argv[2:]
STEP = 200.0


def rows(path):
    return [json.loads(l) for l in open(path)]


def q(xs, p):
    xs = sorted(xs)
    if not xs:
        return float('nan')
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def walk_stats(d, zone_file, walker_name_rows):
    w = rows(f'{d}/watch-{zone_file}.jsonl')
    walk = rows(f'{d}/walk-{zone_file}.jsonl')
    me = next(r['entity'] for r in walk if r['ev'] == 'ready')
    seen = [r for r in w if r['ev'] == 'row' and r['kind'] != 'initial' and r['id'] == me]
    intervals, stops, idle_between = [], [], 0
    prev = None
    for r in seen:
        if prev is not None:
            if r['moved'] and prev['moved']:
                gap = r['t'] - prev['t']
                if gap < 3 * STEP:  # consecutive steps of one walk
                    intervals.append(gap)
            if not r['moved'] and r['action'] == 'Idle' and prev['moved']:
                stops.append(r['t'] - prev['t'])
        prev = r
    # an Idle row between two steps of one walk
    for a, b, c in zip(seen, seen[1:], seen[2:]):
        if a['moved'] and not b['moved'] and c['moved'] and c['t'] - a['t'] < 3 * STEP:
            idle_between += 1
    sends = {r['seq']: r for r in walk if r['ev'] == 'send'}
    return intervals, stops, idle_between, len(sends)


def fmt(xs):
    return (f'n {len(xs)} min {min(xs):.1f} p10 {q(xs, .1):.1f} median {q(xs, .5):.1f} '
            f'p90 {q(xs, .9):.1f} p99 {q(xs, .99):.1f} max {max(xs):.1f}')


out = {}
for v in variants:
    d = f'{SB}/run/timing-{tag}-{v}'
    res = {}
    for zone in ('none', 'npc'):
        iv, stops, idle_between, sends = walk_stats(d, zone, None)
        late = sum(1 for x in iv if x >= 1.5 * STEP)
        res[zone] = {
            'intervals': len(iv), 'min': round(min(iv), 1), 'p10': round(q(iv, .1), 1),
            'median': round(q(iv, .5), 1), 'p90': round(q(iv, .9), 1), 'p99': round(q(iv, .99), 1),
            'max': round(max(iv), 1), 'late': late, 'idle_between': idle_between,
            'stops': len(stops), 'stop_median': round(q(stops, .5), 1), 'stop_p90': round(q(stops, .9), 1),
            'stop_max': round(max(stops), 1), 'sends': sends,
        }
        print(f'{v:9s} walk-{zone}: step intervals {fmt(iv)}; 1.5 x STEP_MS or more: {late}; '
              f'Idle rows between steps: {idle_between}')
        print(f'{"":9s}          : last step to Idle row {fmt(stops)}')
    p = rows(f'{d}/press.jsonl')
    presses = [r for r in p if r['ev'] == 'press']
    acked = [r for r in p if r['ev'] == 'press-acked']
    lat = [b['t'] - a['t'] for a, b in zip(presses, acked)]
    bins = [0] * 9
    for x in lat:
        bins[min(int(x // 25), 8)] += 1
    res['press'] = {'n': len(lat), 'min': round(min(lat), 1), 'p10': round(q(lat, .1), 1),
                    'median': round(q(lat, .5), 1), 'p90': round(q(lat, .9), 1), 'max': round(max(lat), 1),
                    'mean': round(sum(lat) / len(lat), 1), 'bins25': bins}
    print(f'{v:9s} press    : send to acknowledging row {fmt(lat)} mean {sum(lat)/len(lat):.1f}; 25 ms bins {bins}')
    res['loadavg'] = open(f'{d}/loadavg.txt').read().split()[:3]
    out[v] = res
json.dump(out, open(f'{SB}/run/timing-{tag}.json', 'w'), indent=1)
