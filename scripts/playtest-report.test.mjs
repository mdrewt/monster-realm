// Unit tests for scripts/playtest-report.mjs (just playtest-report): the pure aggregation, the
// `spacetime sql --format json` decoder, the fail-loud row coercion, and the real driver run as a
// subprocess against a fake `spacetime`. Wrong output misleads playtest tuning; a leaked identity
// breaks the aggregate-only privacy posture (ADR-0131).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateReport, coerceRow, decodeSqlJson, sortByEventId } from './playtest-report.mjs';

const row = (o) => ({ kind: 1, bait_item_id: 0, success: true, ...o });
const close = (actual, expected) => {
  for (const [k, v] of Object.entries(expected))
    assert.ok(Math.abs(actual[k] - v) < 1e-9, `${k}: ${actual[k]} != ${v}`);
};

// Captured verbatim from the pinned 2.8.1 CLI against a live playtest_event table. Rows arrive
// out of event_id order (10, 30, 20, 40); event 40 is kind 2; identity is a one-element array.
const CAPTURE =
  '[{"schema":{"elements":[{"name":{"some":"event_id"},"algebraic_type":{"U64":[]}},{"name":{"some":"kind"},"algebraic_type":{"U16":[]}},{"name":{"some":"identity"},"algebraic_type":{"Product":{"elements":[{"name":{"some":"__identity__"},"algebraic_type":{"U256":[]}}]}}},{"name":{"some":"species_id"},"algebraic_type":{"U32":[]}},{"name":{"some":"hp_permille"},"algebraic_type":{"U16":[]}},{"name":{"some":"bait_item_id"},"algebraic_type":{"U32":[]}},{"name":{"some":"success"},"algebraic_type":{"Bool":[]}}]},"rows":[[10,1,["0xc20081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed767da6"],7,300,0,true],[30,1,["0xc20081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed767da6"],7,900,42,false],[20,1,["0xb10081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed76700f"],9,200,0,true],[40,2,["0xb10081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed76700f"],9,500,0,false]],"total_duration_micros":316,"stats":{"rows_inserted":0,"rows_deleted":0,"rows_updated":0}}]';
const capture = () => JSON.parse(CAPTURE);
const HEX_A = '0xc20081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed767da6';

test('aggregateReport: empty input gives zeroed, finite rates', () => {
  assert.deepEqual(aggregateReport([]), {
    weakenFirstRate: 0,
    successRate: 0,
    baitRate: 0,
    recatchRate: 0,
  });
});

test('aggregateReport: hand-computed rates; kind 2 filtered; no identity in the result', () => {
  const fixture = [
    row({ identity: 'aaa', species_id: 1, hp_permille: 400, success: false }),
    row({ identity: 'aaa', species_id: 1, hp_permille: 600, bait_item_id: 7 }),
    row({ identity: 'bbb', species_id: 2, hp_permille: 800 }),
    row({ identity: 'aaa', species_id: 2, hp_permille: 200, bait_item_id: 3, success: false }),
  ];
  close(aggregateReport(fixture), {
    weakenFirstRate: 2 / 3,
    successRate: 0.5,
    baitRate: 0.5,
    recatchRate: 1 / 3,
  });
  const filtered = aggregateReport([
    row({ identity: 'ccc', species_id: 5, hp_permille: 800 }),
    row({ kind: 2, identity: 'ccc', species_id: 5, hp_permille: 0, success: false }),
  ]);
  assert.equal(filtered.successRate, 1);
  const hex = 'b'.repeat(64);
  const out = JSON.stringify(
    aggregateReport([row({ identity: hex, species_id: 1, hp_permille: 300 })]),
  );
  assert.ok(!out.includes(hex), out);
});

test('sortByEventId returns a new ascending array, so the first encounter is the oldest row', () => {
  const input = [
    row({ event_id: 2, identity: 'p', species_id: 1, hp_permille: 999 }),
    row({ event_id: 1, identity: 'p', species_id: 1, hp_permille: 250, success: false }),
    row({ event_id: 3, identity: 'q', species_id: 2, hp_permille: 700 }),
  ];
  const sorted = sortByEventId(input);
  assert.deepEqual(
    sorted.map((r) => r.event_id),
    [1, 2, 3],
  );
  assert.equal(input[0].event_id, 2, 'input must not be mutated');
  assert.equal(aggregateReport(sorted).weakenFirstRate, 0.5);
});

test('decodeSqlJson zips positional rows against the schema, in arrival order', () => {
  const decoded = decodeSqlJson(CAPTURE);
  assert.deepEqual(
    decoded.map((r) => r.event_id),
    [10, 30, 20, 40],
  );
  assert.equal(decoded[0].success, true);
  assert.deepEqual(decoded[0].identity, [HEX_A]);
  assert.equal(decoded[1].bait_item_id, 42);
  const empty = capture();
  empty[0].rows = [];
  assert.deepEqual(decodeSqlJson(JSON.stringify(empty)), []);
});

test('decodeSqlJson keeps a "__proto__" column as an own property', () => {
  const env = capture();
  env[0].schema.elements[0].name = { some: '__proto__' };
  env[0].rows = [[999, 1, ['0xabc'], 7, 300, 0, true]];
  const r = decodeSqlJson(JSON.stringify(env))[0];
  assert.equal(Object.getOwnPropertyDescriptor(r, '__proto__')?.value, 999);
});

test('decodeSqlJson fails loud on every malformed envelope', () => {
  const mutate = (fn) => {
    const env = capture();
    fn(env);
    return JSON.stringify(env);
  };
  const cases = {
    'non-JSON': 'not json at all',
    empty: '',
    'object top level': '{}',
    'zero statements': '[]',
    'two statements': JSON.stringify([capture()[0], capture()[0]]),
    'elements missing': mutate((e) => delete e[0].schema.elements),
    'elements empty': mutate((e) => {
      e[0].schema.elements = [];
    }),
    'unnamed column': mutate((e) => {
      e[0].schema.elements[0].name = { none: {} };
    }),
    'duplicate column': mutate((e) => {
      e[0].schema.elements[1].name = { some: 'event_id' };
    }),
    'rows missing': mutate((e) => delete e[0].rows),
    'rows not array': mutate((e) => {
      e[0].rows = 'nope';
    }),
    'row not array': mutate((e) => {
      e[0].rows[0] = { event_id: 10 };
    }),
    // A short row would zip bait_item_id to undefined -> NaN !== 0 -> silently inflated baitRate.
    'arity mismatch': mutate((e) => {
      e[0].rows[0] = e[0].rows[0].slice(0, 5);
    }),
  };
  for (const [label, stdout] of Object.entries(cases))
    assert.throws(() => decodeSqlJson(stdout), label);
});

test('coerceRow unwraps the one-element identity and rejects malformed rows', () => {
  const good = {
    event_id: 10,
    kind: 1,
    identity: [HEX_A],
    species_id: 7,
    hp_permille: 300,
    bait_item_id: 0,
    success: true,
  };
  assert.equal(coerceRow(good).identity, HEX_A);
  const bad = {
    'two-element identity': { identity: ['a', 'b'] },
    'bare string identity': { identity: HEX_A },
    'empty identity': { identity: [''] },
    'missing bait_item_id': { bait_item_id: undefined },
    'non-numeric hp': { hp_permille: 'abc' },
    'string success': { success: 'true' },
  };
  for (const [label, patch] of Object.entries(bad)) {
    const r = { ...good, ...patch };
    if ('bait_item_id' in patch && patch.bait_item_id === undefined) delete r.bait_item_id;
    assert.throws(() => coerceRow(r), label);
  }
});

test('full pipeline over the capture reproduces hand-computed rates in either arrival order', () => {
  const run = (json) => aggregateReport(sortByEventId(decodeSqlJson(json).map(coerceRow)));
  close(run(CAPTURE), {
    successRate: 2 / 3,
    baitRate: 1 / 3,
    weakenFirstRate: 1,
    recatchRate: 0.5,
  });
  const reversed = capture();
  reversed[0].rows.reverse();
  assert.equal(run(JSON.stringify(reversed)).weakenFirstRate, 1);
});

test('driver: real subprocess against a fake spacetime — argv, printed rates, fail-loud, no PII', (t) => {
  const script = fileURLToPath(new URL('./playtest-report.mjs', import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'mr-report-driver-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, 'spacetime');
  writeFileSync(
    stub,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$MR_FAKE_ARGV_FILE"\ncat "$MR_FAKE_ENVELOPE_FILE"\n',
  );
  chmodSync(stub, 0o755);
  const ids = ['a1', 'b2', 'c3', 'd4'].map((h) => `0x${h.repeat(32)}`);
  const cols = [
    'event_id',
    'kind',
    'identity',
    'species_id',
    'hp_permille',
    'bait_item_id',
    'success',
  ];
  const envelope = (rows) =>
    JSON.stringify([{ schema: { elements: cols.map((c) => ({ name: { some: c } })) }, rows }]);
  const drive = (rows, tag) => {
    const env = path.join(dir, `${tag}.json`);
    const argv = path.join(dir, `${tag}.argv`);
    writeFileSync(env, envelope(rows));
    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        STDB_SERVER: 'http://127.0.0.1:1',
        MR_PLAYTEST_DB: 'mr-driver-test',
        MR_FAKE_ARGV_FILE: argv,
        MR_FAKE_ENVELOPE_FILE: env,
      },
    });
    const out = `${r.stdout}${r.stderr}`;
    for (const id of ids) assert.ok(!out.includes(id), `identity leaked in ${tag} run`);
    return { r, argv };
  };

  // Group (A, species 1) arrives out of order: sorted, its first encounter is event 10 (hp 100,
  // weakened) -> weakenFirstRate 0.5; unsorted it would be event 20 -> 0.25.
  const good = drive(
    [
      [20, 1, [ids[0]], 1, 900, 7, true],
      [10, 1, [ids[0]], 1, 100, 0, false],
      [30, 1, [ids[1]], 2, 800, 0, true],
      [40, 1, [ids[2]], 3, 300, 13, false],
      [50, 1, [ids[3]], 4, 600, 0, true],
    ],
    'good',
  );
  assert.equal(good.r.status, 0, good.r.stderr);
  const argv = readFileSync(good.argv, 'utf8').split('\n');
  for (const a of ['sql', '--format', 'json'])
    assert.ok(argv.includes(a), `argv ${JSON.stringify(argv)} lacks ${a}`);
  const rate = (label) => good.r.stdout.split(label)[1]?.split('\n')[0].trim();
  assert.equal(rate('H1 weaken-first rate:'), '0.5000');
  assert.equal(rate('H1 recatch rate:'), '0.2500');
  assert.equal(rate('H2 success rate:'), '0.6000');
  assert.equal(rate('H2 bait rate:'), '0.4000');

  // One malformed row (success as the string "true") must abort the whole run, printing no rates.
  const bad = drive(
    [
      [100, 1, [ids[0]], 1, 700, 0, true],
      [200, 1, [ids[1]], 2, 300, 0, 'true'],
      [300, 1, [ids[2]], 3, 600, 5, false],
    ],
    'bad',
  );
  assert.notEqual(bad.r.status, 0);
  assert.ok(!bad.r.stdout.includes('weaken-first rate:'), bad.r.stdout);
});
