// reconstruct.test.mjs — m20e T3 gate for the relay's end-to-end pure pipeline
// (TDD RED).
//
// Encodes OBS-50 (`$trace_pair_set` is an ALLOWLIST — a reducer outside it is
// dropped, and an EMPTY set means zero spans, said out loud rather than
// implied) and the OBS-42/43/44 pipeline composition, against the
// NOT-YET-WRITTEN './reconstruct.mjs'. RED today because that module does not
// exist.
//
// ANTI-PATTERN 1 (green-by-absence) IS CLOSED HERE TOO. `reconstruct` THROWS
// when no `tracePairSet` is supplied: a missing allowlist is not the empty
// allowlist, and defaulting it to `[]` would turn "the config file could not be
// read" into "there was nothing to trace", which is the same failure wearing a
// green badge.
//
// Discipline: no `new RegExp(`, no regex literals, no clock, no I/O. Host lines
// are BUILT with JSON.stringify (a fixture builder, never an oracle for an
// expectation) so this file carries no hand-escaped envelope literals; every
// EXPECTED value below is a literal.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconstruct } from './reconstruct.mjs';

// ---------------------------------------------------------------------------
// Fixture builders + a local (not imported) hex predicate
// ---------------------------------------------------------------------------
function hostLine(fn, ts, message) {
  return JSON.stringify({
    level: 'Info',
    ts: Number(ts),
    target: '__spacetimedb__',
    filename: '__spacetimedb__',
    function: fn,
    message,
  });
}

function isLowercaseHex(value, length) {
  if (typeof value !== 'string' || value.length !== length) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

const LINES = [
  hostLine('zone_tick', '1782197246181000', '{"evt":"span","cause":"zone:a","phase":"enter"}'),
  hostLine('battle_tick', '1782197246181500', '{"evt":"span","cause":"battle:7","phase":"enter"}'),
  hostLine('zone_tick', '1782197246183000', '{"evt":"span","cause":"zone:a","phase":"exit"}'),
  hostLine('battle_tick', '1782197246183500', '{"evt":"span","cause":"battle:7","phase":"exit"}'),
  hostLine('mr_heartbeat', '1782197246184000', '{"evt":"heartbeat","content_version":7}'),
  '2026-08-09T00:00:00.123456Z  INFO spacetimedb: replica started',
  hostLine('zone_tick', '1782197246185000', '{"evt":"span","phase":"enter"}'),
  hostLine('zone_tick', '1782197246186000', '{"evt":"span","cause":"zone:zzz","phase":"exit"}'),
];

const SERVICE = { serviceName: 'mr-trace-relay' };

// ---------------------------------------------------------------------------
// 1. A missing allowlist is a loud failure, never an implied empty one
// ---------------------------------------------------------------------------

test('OBS-50: reconstruct THROWS when no tracePairSet is supplied — absence is not the empty set', () => {
  assert.throws(
    () => reconstruct(LINES, {}),
    (err) => {
      assert.ok(err instanceof Error, 'must throw an Error');
      assert.ok(
        err.message.includes('trace_pair_set'),
        `the message must name trace_pair_set, got: ${err.message}`,
      );
      return true;
    },
  );
  assert.throws(() => reconstruct(LINES, { tracePairSet: null, ...SERVICE }), Error);
});

// ---------------------------------------------------------------------------
// 2. The empty set: zero spans, and an EXPLICIT diagnostic saying so
// ---------------------------------------------------------------------------

test('OBS-50: an EMPTY trace_pair_set yields zero spans and says why', () => {
  const { document, diagnostics } = reconstruct(LINES, { tracePairSet: [], ...SERVICE });
  assert.deepEqual(document, { resourceSpans: [] }, 'zero spans is an empty OTLP document');
  assert.equal(diagnostics.emptyTracePairSet, true);
  assert.equal(diagnostics.paired, 0);
  assert.equal(diagnostics.unpaired, 0);
  assert.equal(diagnostics.skippedNoKey, 0);
  assert.equal(diagnostics.filteredOut, diagnostics.breadcrumbs, 'every crumb was filtered out');
  assert.ok(Array.isArray(diagnostics.notes));
  assert.ok(
    diagnostics.notes.some((n) => n.includes('trace_pair_set')),
    'zero spans with no note reads identically to a broken pipeline — say it out loud',
  );
});

test('OBS-50: a NON-empty set does not set the empty flag', () => {
  const { diagnostics } = reconstruct(LINES, { tracePairSet: ['zone_tick'], ...SERVICE });
  assert.equal(diagnostics.emptyTracePairSet, false);
});

// ---------------------------------------------------------------------------
// 3. Membership filtering
// ---------------------------------------------------------------------------

test('OBS-50: only reducers IN the set are reconstructed; the rest are dropped and counted', () => {
  const { document, diagnostics } = reconstruct(LINES, { tracePairSet: ['zone_tick'], ...SERVICE });
  const spans = document.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 1, 'battle_tick is outside the allowlist and contributes no span');
  assert.equal(spans[0].name, 'zone_tick');
  assert.equal(spans[0].startTimeUnixNano, '1782197246181000000');
  assert.equal(spans[0].endTimeUnixNano, '1782197246183000000');
  assert.equal(diagnostics.filteredOut, 2, "battle_tick's enter AND exit are both dropped");
});

test('OBS-50: a Set instance is accepted exactly like an array', () => {
  const viaArray = reconstruct(LINES, { tracePairSet: ['zone_tick'], ...SERVICE });
  const viaSet = reconstruct(LINES, { tracePairSet: new Set(['zone_tick']), ...SERVICE });
  assert.deepEqual(viaSet.document, viaArray.document);
  assert.deepEqual(viaSet.diagnostics, viaArray.diagnostics);
});

test('OBS-50: widening the set adds the previously-dropped chain, and nothing else changes', () => {
  const wide = reconstruct(LINES, { tracePairSet: ['zone_tick', 'battle_tick'], ...SERVICE });
  const spans = wide.document.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  assert.equal(wide.diagnostics.filteredOut, 0);
  assert.equal(wide.diagnostics.paired, 2);
  const names = spans.map((s) => s.name).sort();
  assert.deepEqual(names, ['battle_tick', 'zone_tick']);
});

// ---------------------------------------------------------------------------
// 4. Diagnostics are a closed book
// ---------------------------------------------------------------------------

test('diagnostics: every line and every crumb is accounted for exactly once', () => {
  const { diagnostics } = reconstruct(LINES, { tracePairSet: ['zone_tick'], ...SERVICE });
  assert.equal(diagnostics.linesRead, 8);
  assert.equal(diagnostics.parsed, 7);
  assert.equal(diagnostics.parseFailures, 1, 'the prose line is a failure, not a crash');
  assert.equal(
    diagnostics.linesRead,
    diagnostics.parsed + diagnostics.parseFailures,
    'linesRead === parsed + parseFailures',
  );

  assert.equal(diagnostics.breadcrumbs, 6, 'the heartbeat line has no phase and is not a crumb');
  assert.equal(diagnostics.filteredOut, 2);
  assert.equal(diagnostics.paired, 1);
  assert.equal(diagnostics.skippedNoKey, 1, 'the keyless enter is counted, never guessed at');
  assert.equal(diagnostics.unpaired, 1, 'the zone:zzz exit has no enter');
  assert.equal(
    diagnostics.breadcrumbs,
    diagnostics.filteredOut +
      diagnostics.paired * 2 +
      diagnostics.unpaired +
      diagnostics.skippedNoKey,
    'breadcrumbs === filteredOut + paired*2 + unpaired + skippedNoKey',
  );
});

test('diagnostics: blank lines are ignored outright, not miscounted as parse failures', () => {
  const withBlanks = [LINES[0], '', '   ', LINES[2]];
  const { diagnostics } = reconstruct(withBlanks, { tracePairSet: ['zone_tick'], ...SERVICE });
  assert.equal(diagnostics.linesRead, 2, 'a trailing newline is not a corrupt log line');
  assert.equal(diagnostics.parseFailures, 0);
  assert.equal(diagnostics.paired, 1);
});

test('reconstruct: an empty input is an empty document with zeroed diagnostics, not a throw', () => {
  const { document, diagnostics } = reconstruct([], { tracePairSet: ['zone_tick'], ...SERVICE });
  assert.deepEqual(document, { resourceSpans: [] });
  assert.equal(diagnostics.linesRead, 0);
  assert.equal(diagnostics.parsed, 0);
  assert.equal(diagnostics.breadcrumbs, 0);
  assert.equal(diagnostics.paired, 0);
});

// ---------------------------------------------------------------------------
// 5. The document the CLI posts
// ---------------------------------------------------------------------------

test('OBS-44: the reconstructed document carries the full OTLP shape end to end', () => {
  const { document } = reconstruct(LINES, {
    tracePairSet: ['zone_tick', 'battle_tick'],
    serviceName: 'mr-trace-relay',
  });
  assert.equal(document.resourceSpans.length, 1);
  assert.deepEqual(
    document.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name'),
    { key: 'service.name', value: { stringValue: 'mr-trace-relay' } },
  );
  const spans = document.resourceSpans[0].scopeSpans[0].spans;
  for (const span of spans) {
    assert.equal(isLowercaseHex(span.traceId, 32), true, `traceId '${span.traceId}'`);
    assert.equal(isLowercaseHex(span.spanId, 16), true, `spanId '${span.spanId}'`);
    assert.equal(typeof span.startTimeUnixNano, 'string');
    assert.equal(typeof span.endTimeUnixNano, 'string');
    assert.equal(span.kind, 1);
    assert.deepEqual(
      span.attributes.find((a) => a.key === 'reducer'),
      { key: 'reducer', value: { stringValue: span.name } },
      'the reducer attribute is what the Grafana trace-to-logs tag joins on',
    );
  }
  assert.deepEqual(
    spans
      .find((s) => s.name === 'battle_tick')
      .attributes.find((a) => a.key === 'mr.correlation_key'),
    { key: 'mr.correlation_key', value: { stringValue: 'cause:battle:7' } },
  );
});

test('reconstruct: serviceName defaults to mr-trace-relay when the caller omits it', () => {
  const { document } = reconstruct(LINES, { tracePairSet: ['zone_tick'] });
  assert.deepEqual(
    document.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name'),
    { key: 'service.name', value: { stringValue: 'mr-trace-relay' } },
  );
});

test('reconstruct: the whole pipeline is order-independent — shuffled lines, identical output', () => {
  const shuffled = [LINES[7], LINES[3], LINES[0], LINES[5], LINES[2], LINES[6], LINES[4], LINES[1]];
  const canonical = reconstruct(LINES, { tracePairSet: ['zone_tick', 'battle_tick'], ...SERVICE });
  const permuted = reconstruct(shuffled, {
    tracePairSet: ['zone_tick', 'battle_tick'],
    ...SERVICE,
  });
  assert.equal(
    JSON.stringify(permuted.document),
    JSON.stringify(canonical.document),
    'file-tail arrival order must not reach the exported document (OBS-43)',
  );
  assert.deepEqual(permuted.diagnostics, canonical.diagnostics);
});
