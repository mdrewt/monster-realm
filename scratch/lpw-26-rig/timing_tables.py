#!/usr/bin/env python3
"""timing_tables.py — the record's step-timing tables.

Runs 1 to 4 pair today with D (tags t1..t4); runs 5 to 8 pair today with C (tags c1..c4). A and
D without the one-shot ran once, with run 1. Prints each table under a marker line."""
import json
import os
import statistics as st

SB = open('/tmp/lpw26-sandbox-path').read().strip()
STEP = 200.0
ZONE = {'none': 'without NPCs', 'npc': 'with NPCs'}
# label -> (variant directory name, tags)
SETS = [
    ('Today, runs 1 to 4', 'today', ['t1', 't2', 't3', 't4']),
    ('D, runs 1 to 4', 'd', ['t1', 't2', 't3', 't4']),
    ('Today, runs 5 to 8', 'today', ['c1', 'c2', 'c3', 'c4']),
    ('C, runs 5 to 8', 'c', ['c1', 'c2', 'c3', 'c4']),
]
RUN1 = [('Today', 'today'), ('D', 'd'), ('D without the one-shot', 'd-nokick'), ('A', 'a')]
RUNNO = {'t1': 1, 't2': 2, 't3': 3, 't4': 4, 'c1': 5, 'c2': 6, 'c3': 7, 'c4': 8}


def q(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def load(tag, v, zone):
    d = f'{SB}/run/timing-{tag}-{v}'
    w = [json.loads(l) for l in open(f'{d}/watch-{zone}.jsonl')]
    walk = [json.loads(l) for l in open(f'{d}/walk-{zone}.jsonl')]
    me = next(r['entity'] for r in walk if r['ev'] == 'ready')
    seen = [r for r in w if r['ev'] == 'row' and r['kind'] != 'initial' and r['id'] == me]
    first, later, stops, idle_between, walks = [], [], [], 0, 0
    idx, prev = 0, None
    for r in seen:
        if prev is not None:
            if r['moved'] and prev['moved']:
                gap = r['t'] - prev['t']
                if gap >= 3 * STEP:
                    idx = 0
                else:
                    (first if idx == 0 else later).append(gap)
                    idx += 1
            if not r['moved'] and r['action'] == 'Idle' and prev['moved']:
                stops.append(r['t'] - prev['t'])
                walks += 1
                idx = 0
        prev = r
    for a, b, c in zip(seen, seen[1:], seen[2:]):
        if a['moved'] and not b['moved'] and c['moved'] and c['t'] - a['t'] < 3 * STEP:
            idle_between += 1
    return first, later, stops, idle_between, walks


def press(tag, v):
    p = [json.loads(l) for l in open(f'{SB}/run/timing-{tag}-{v}/press.jsonl')]
    a = [r for r in p if r['ev'] == 'press']
    b = [r for r in p if r['ev'] == 'press-acked']
    return [y['t'] - x['t'] for x, y in zip(a, b)]


def pool(v, tags, zone):
    F, L, S, IB, W = [], [], [], 0, 0
    for tag in tags:
        f, l, s, ib, w = load(tag, v, zone)
        F += f
        L += l
        S += s
        IB += ib
        W += w
    return F, L, S, IB, W


HEAD = ('| Zone | Alternative | Walks | Intervals | Smallest | Median | p90 | p99 | Largest | Standard deviation | Late steps | `Idle` rows between two steps |\n'
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')


def step_row(zone, label, F, L, IB, W):
    allv = F + L
    late = sum(1 for x in allv if x >= 1.5 * STEP)
    return (f'| {ZONE[zone]} | {label} | {W} | {len(allv)} | {min(allv):.1f} | {q(allv,.5):.1f} | {q(allv,.9):.1f} | '
            f'{q(allv,.99):.1f} | {max(allv):.1f} | {st.pstdev(allv):.2f} | {late} | {IB} |')


print('@@POOLED')
print(HEAD)
for zone in ('none', 'npc'):
    for label, v, tags in SETS:
        F, L, S, IB, W = pool(v, tags, zone)
        print(step_row(zone, label, F, L, IB, W))
print('@@PERRUN')
print('| Run | Zone | Alternative | Intervals | Median | p90 | Largest | Late steps |')
print('| --- | --- | --- | --- | --- | --- | --- | --- |')
for tags, pair in ((['t1', 't2', 't3', 't4'], [('Today', 'today'), ('D', 'd')]), (['c1', 'c2', 'c3', 'c4'], [('Today', 'today'), ('C', 'c')])):
    for tag in tags:
        for zone in ('none', 'npc'):
            for label, v in pair:
                f, l, s, ib, w = load(tag, v, zone)
                allv = f + l
                print(f'| {RUNNO[tag]} | {ZONE[zone]} | {label} | {len(allv)} | {q(allv,.5):.1f} | {q(allv,.9):.1f} | {max(allv):.1f} | {sum(1 for x in allv if x >= 1.5*STEP)} |')
print('@@RUN1')
print(HEAD)
for zone in ('none', 'npc'):
    for label, v in RUN1:
        F, L, S, IB, W = pool(v, ['t1'], zone)
        print(step_row(zone, label, F, L, IB, W))
print('@@FIRST')
print('| Zone | Alternative | First interval of a walk: number, median, largest | Every later interval: number, median, largest, standard deviation |')
print('| --- | --- | --- | --- |')
for zone in ('none', 'npc'):
    for label, v, tags in SETS + [('D without the one-shot, run 1', 'd-nokick', ['t1']), ('A, run 1', 'a', ['t1'])]:
        F, L, S, IB, W = pool(v, tags, zone)
        print(f'| {ZONE[zone]} | {label} | {len(F)}, {q(F,.5):.1f}, {max(F):.1f} | {len(L)}, {q(L,.5):.1f}, {max(L):.1f}, {st.pstdev(L):.2f} |')
print('@@STOP')
print('| Zone | Alternative | Walks | Median | p90 | Largest |')
print('| --- | --- | --- | --- | --- | --- |')
for zone in ('none', 'npc'):
    for label, v, tags in SETS + [('D without the one-shot, run 1', 'd-nokick', ['t1']), ('A, run 1', 'a', ['t1'])]:
        S = pool(v, tags, zone)[2]
        print(f'| {ZONE[zone]} | {label} | {len(S)} | {q(S,.5):.1f} | {q(S,.9):.1f} | {max(S):.1f} |')
print('@@PRESS')
print('| Alternative | Presses | Smallest | p10 | Median | Mean | p90 | Largest | Presses by 25 ms of wait, 0 to 200 and over |')
print('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for label, v, tags in SETS + [('D without the one-shot, run 1', 'd-nokick', ['t1']), ('A, run 1', 'a', ['t1'])]:
    lat = []
    for tag in tags:
        lat += press(tag, v)
    bins = [0] * 9
    for x in lat:
        bins[min(int(x // 25), 8)] += 1
    print(f'| {label} | {len(lat)} | {min(lat):.1f} | {q(lat,.1):.1f} | {q(lat,.5):.1f} | {st.mean(lat):.1f} | {q(lat,.9):.1f} | {max(lat):.1f} | {", ".join(str(b) for b in bins)} |')
print('@@END')
for tag in RUNNO:
    for v in ('today',):
        p = f'{SB}/run/timing-{tag}-{v}/loadavg.txt'
        if os.path.exists(p):
            print('loadavg', tag, open(p).read().split()[:3])
