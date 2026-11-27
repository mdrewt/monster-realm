#!/usr/bin/env python3
"""spread.py <tag[,tag...]> <variant>... — spread of the watcher's step intervals, walks pooled
over the tags given, and the first interval of each walk apart from the rest."""
import json, sys, statistics as st
SB = open('/tmp/lpw26-sandbox-path').read().strip()
tags, variants = sys.argv[1].split(','), sys.argv[2:]
def q(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p; lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)
for zone in ('none', 'npc'):
    for v in variants:
        first, rest = [], []
        for tag in tags:
            d = f'{SB}/run/timing-{tag}-{v}'
            w = [json.loads(l) for l in open(f'{d}/watch-{zone}.jsonl')]
            walk = [json.loads(l) for l in open(f'{d}/walk-{zone}.jsonl')]
            me = next(r['entity'] for r in walk if r['ev'] == 'ready')
            seen = [r for r in w if r['ev'] == 'row' and r['kind'] != 'initial' and r['id'] == me and r['moved']]
            idx = 0
            for a, b in zip(seen, seen[1:]):
                gap = b['t'] - a['t']
                if gap >= 600:
                    idx = 0
                    continue
                (first if idx == 0 else rest).append(gap)
                idx += 1
        allv = first + rest
        def line(name, xs):
            return (f'{name}: n {len(xs)} mean {st.mean(xs):.2f} sd {st.pstdev(xs):.2f} min {min(xs):.1f} p1 {q(xs,.01):.1f} p10 {q(xs,.1):.1f} '
                    f'p50 {q(xs,.5):.1f} p90 {q(xs,.9):.1f} p99 {q(xs,.99):.1f} max {max(xs):.1f} '
                    f'outside 200+-2: {sum(1 for x in xs if abs(x-200)>2)} outside 200+-5: {sum(1 for x in xs if abs(x-200)>5)}')
        print(f'{zone:5s} {v:9s} {line("all", allv)}')
        print(f'{"":15s} {line("first of a walk", first)}')
        print(f'{"":15s} {line("later", rest)}')
