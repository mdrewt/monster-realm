#!/usr/bin/env python3
"""clogstat.py <run-name> [--from-tx N] [--to-tx M] [--dump K]

Walk the commit log of run/<run-name> (replicas/1/clog/*.stdb.log, format version 1: a 10-byte
segment header, then commits of a 22-byte header {min_tx_offset u64, epoch u64, n u16, len u32},
`len` bytes of records and a 4-byte checksum) and print, per reducer named in a transaction's
inputs record, how many transactions the log holds and their bytes on disk (header and checksum
included). --dump K prints the last K records in hex.
"""
import glob
import json
import struct
import sys

SB = open('/tmp/lpw26-sandbox-path').read().strip()
argv = sys.argv[1:]
name = argv[0]
opt = {argv[i][2:]: argv[i + 1] for i in range(1, len(argv) - 1, 2) if argv[i].startswith('--')}
lo = int(opt.get('from-tx', 0))
hi = int(opt.get('to-tx', 1 << 62))
dump = int(opt.get('dump', 0))

commits = []
for path in sorted(glob.glob(f'{SB}/run/{name}/data/replicas/1/clog/*.stdb.log')):
    f = open(path, 'rb').read()
    assert f[:6] == b'(ds)^2', path
    off = 10
    while off + 22 <= len(f):
        mto, epoch, n, ln = struct.unpack_from('<QQHI', f, off)
        if n == 0 and ln == 0:
            break
        payload = f[off + 22:off + 22 + ln]
        commits.append((mto, n, ln + 26, payload))
        off += 22 + ln + 4


def reducer_of(payload):
    # A record: flags u8; when the inputs bit is set, u32 length then u8 name length and the name.
    if len(payload) < 6:
        return '<none>'
    ilen = struct.unpack_from('<I', payload, 1)[0]
    if ilen == 0 or 5 + ilen > len(payload):
        return '<no-inputs>'
    nlen = payload[5]
    name = payload[6:6 + nlen]
    try:
        s = name.decode('ascii')
    except UnicodeDecodeError:
        return '<no-inputs>'
    return s if s.replace('_', '').isalnum() else '<no-inputs>'


stats = {}
for mto, n, size, payload in commits:
    if not (lo <= mto < hi):
        continue
    r = reducer_of(payload)
    s = stats.setdefault(r, {'txs': 0, 'bytes': 0, 'sizes': {}})
    s['txs'] += 1
    s['bytes'] += size
    s['sizes'][size] = s['sizes'].get(size, 0) + 1

total_tx = sum(s['txs'] for s in stats.values())
total_b = sum(s['bytes'] for s in stats.values())
out = {'first_tx': commits[0][0] if commits else None, 'next_tx': commits[-1][0] + 1 if commits else None,
       'txs': total_tx, 'bytes': total_b, 'by_reducer': {}}
for r, s in sorted(stats.items(), key=lambda kv: -kv[1]['bytes']):
    sizes = sorted(s['sizes'].items(), key=lambda kv: -kv[1])[:6]
    out['by_reducer'][r] = {'txs': s['txs'], 'bytes': s['bytes'], 'mean': round(s['bytes'] / s['txs'], 1),
                            'top_sizes': [f'{b}Bx{c}' for b, c in sizes]}
print(json.dumps(out, indent=1))
for mto, n, size, payload in commits[-dump:] if dump else []:
    print(mto, size, reducer_of(payload), payload.hex())
