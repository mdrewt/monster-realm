// otlp.test.mjs — m20e T3 gate for the relay's OTLP/HTTP JSON encoder (TDD RED).
//
// Encodes OBS-44 (`trace_id`/`span_id` are LOWERCASE HEX strings of exactly
// 32/16 characters in the OTLP/HTTP JSON export, never base64) and the
// ADR-0180 D1/OBS-3 purity rule (ids are a deterministic function of the
// correlation key — no clock, no RNG) against the NOT-YET-WRITTEN './otlp.mjs'.
// RED today because that module does not exist.
//
// THE CHAR-CLASS CHECK IS OVER THE WHOLE ID, AND IT IS PROVEN TO BITE. The
// obvious wrong encoding is base64 (protobuf's JSON mapping for `bytes` fields
// is base64, so an OTLP library port lands there by default), and a base64 id
// contains hex characters — `id.includes` or a leading-prefix check passes it.
// `isLowercaseHex` below is asserted to REJECT a real 24-character base64
// digest before it is trusted to accept a real id.
//
// Discipline: no `new RegExp(`, no regex literals (the char class is a hand
// walk), no clock, no I/O, no committed digest literals (pinning a sha256
// output here would freeze the truncation choice and add a high-entropy blob
// gitleaks has to be argued with; the CONTRACT is shape + determinism +
// distinctness, which is what OBS-44 actually says).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeTraceDocument, microsToNanosString, spanIdFor, traceIdFor } from './otlp.mjs';

// ---------------------------------------------------------------------------
// Local predicates — deliberately NOT imported from the module under test.
// ---------------------------------------------------------------------------
function isLowercaseHex(value, length) {
  if (typeof value !== 'string') return false;
  if (value.length !== length) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const isDigit = c >= '0' && c <= '9';
    const isLowerHex = c >= 'a' && c <= 'f';
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

function isAllZero(value) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '0') return false;
  }
  return value.length > 0;
}

const SPAN_A = {
  key: 'cause:zone:a',
  reducer: 'zone_tick',
  startMicros: '1782197246181000',
  endMicros: '1782197246183000',
  durationMicros: '2000',
};
const SPAN_B = {
  key: 'cause:zone:b',
  reducer: 'zone_tick',
  startMicros: '1782197246182000',
  endMicros: '1782197246184000',
  durationMicros: '2000',
};
// Same correlation key as SPAN_A, a later call — same trace, different span.
const SPAN_A2 = {
  key: 'cause:zone:a',
  reducer: 'zone_tick',
  startMicros: '1782197246191000',
  endMicros: '1782197246193000',
  durationMicros: '2000',
};

// ---------------------------------------------------------------------------
// 0. The char-class predicate is proven to bite BEFORE anything relies on it
// ---------------------------------------------------------------------------

test('PROOF-OF-TEETH: isLowercaseHex rejects base64, uppercase, and off-by-one lengths', () => {
  // A 24-character base64 rendering of a 16-byte id — what protobuf-JSON emits
  // for a `bytes` field and the exact mistake OBS-44 names.
  assert.equal(isLowercaseHex('q83vEjRWeJCrze8SNFZ4kA==', 32), false, 'base64 must not pass');
  assert.equal(isLowercaseHex('q83vEjRWeJCrze8SNFZ4kA==', 24), false, 'not even at its own length');
  assert.equal(isLowercaseHex('ABCDEF0123456789ABCDEF0123456789', 32), false, 'uppercase hex');
  assert.equal(isLowercaseHex('abcdef012345678', 16), false, '15 characters is not 16');
  assert.equal(isLowercaseHex('abcdef01234567890', 16), false, '17 characters is not 16');
  assert.equal(isLowercaseHex('abcdef01-2345-6789', 16), false, 'a UUID rendering is not hex');
  assert.equal(isLowercaseHex('0123456789abcdef', 16), true, 'a real 16-hex id passes');
  assert.equal(isAllZero('00000000000000000000000000000000'), true);
  assert.equal(isAllZero('0000000000000001'), false);
});

// ---------------------------------------------------------------------------
// 1. OBS-44 — id shape
// ---------------------------------------------------------------------------

test('OBS-44: traceIdFor returns exactly 32 lowercase-hex characters, never all-zero', () => {
  for (const key of ['cause:zone:a', 'sched:sync_content@1782197250000', 'cause:battle:7']) {
    const id = traceIdFor(key);
    assert.equal(
      isLowercaseHex(id, 32),
      true,
      `traceIdFor('${key}') returned '${id}', which is not 32 lowercase-hex characters`,
    );
    assert.equal(isAllZero(id), false, 'an all-zero trace id is the OTLP "invalid id" sentinel');
  }
});

test('OBS-44: spanIdFor returns exactly 16 lowercase-hex characters, never all-zero', () => {
  const id = spanIdFor(SPAN_A.key, SPAN_A.reducer, SPAN_A.startMicros);
  assert.equal(isLowercaseHex(id, 16), true, `spanIdFor returned '${id}'`);
  assert.equal(isAllZero(id), false);
});

test('OBS-3/D1: ids are pure functions of their inputs — two calls are byte-identical', () => {
  assert.equal(traceIdFor('cause:zone:a'), traceIdFor('cause:zone:a'));
  assert.equal(
    spanIdFor(SPAN_A.key, SPAN_A.reducer, SPAN_A.startMicros),
    spanIdFor(SPAN_A.key, SPAN_A.reducer, SPAN_A.startMicros),
    'a clock or an RNG in the id derivation makes the export unreproducible',
  );
});

test('OBS-44: distinct keys get distinct trace ids; the same key shares one trace', () => {
  assert.notEqual(traceIdFor('cause:zone:a'), traceIdFor('cause:zone:b'));
  assert.notEqual(traceIdFor('cause:zone:a'), traceIdFor('sched:sync_content@1782197250000'));
  assert.equal(traceIdFor(SPAN_A.key), traceIdFor(SPAN_A2.key), 'one key is one trace');
});

test('OBS-44: two calls of the same reducer under one key get DISTINCT span ids', () => {
  const first = spanIdFor(SPAN_A.key, SPAN_A.reducer, SPAN_A.startMicros);
  const second = spanIdFor(SPAN_A2.key, SPAN_A2.reducer, SPAN_A2.startMicros);
  assert.notEqual(first, second, 'collapsing repeat calls into one span id loses every repeat');
});

// ---------------------------------------------------------------------------
// 2. Microseconds -> nanoseconds, exactly (anti-pattern 8)
// ---------------------------------------------------------------------------

test('microsToNanosString: the real host magnitude keeps every digit', () => {
  assert.equal(microsToNanosString('1782197246180474'), '1782197246180474000');
  assert.equal(typeof microsToNanosString('1782197246180474'), 'string');
});

test('microsToNanosString: BITES the Number path above 2^53', () => {
  // 9007199254740993 us is 9007199254740993000 ns. Number(x) * 1000 rounds the
  // input to ...992 first and then the product again, and prints
  // 9007199254740992000 — a whole microsecond of laundered precision.
  assert.equal(microsToNanosString('9007199254740993'), '9007199254740993000');
  assert.equal(
    String(Number('9007199254740993') * 1000),
    '9007199254740992000',
    'FIXTURE: this value must be one the double path corrupts, or the tooth is toothless',
  );
});

test('microsToNanosString: is arithmetic, not string append', () => {
  assert.equal(microsToNanosString('999'), '999000');
  // A `micros + "000"` implementation returns '0000' here; BigInt arithmetic
  // returns '0'. Leading-zero garbage is rejected by OTLP consumers.
  assert.equal(microsToNanosString('0'), '0');
});

// ---------------------------------------------------------------------------
// 3. encodeTraceDocument — the OTLP/HTTP JSON shape
// ---------------------------------------------------------------------------

test('OBS-44: encodeTraceDocument emits the resourceSpans -> scopeSpans -> spans shape', () => {
  const doc = encodeTraceDocument([SPAN_A, SPAN_B], { serviceName: 'mr-trace-relay' });
  assert.ok(Array.isArray(doc.resourceSpans), 'resourceSpans must be an array');
  assert.equal(doc.resourceSpans.length, 1);

  const resource = doc.resourceSpans[0].resource;
  assert.ok(Array.isArray(resource.attributes), 'resource.attributes must be an array');
  assert.deepEqual(
    resource.attributes.find((a) => a.key === 'service.name'),
    { key: 'service.name', value: { stringValue: 'mr-trace-relay' } },
    'the service.name resource attribute is how Tempo names the service',
  );

  const scopeSpans = doc.resourceSpans[0].scopeSpans;
  assert.ok(Array.isArray(scopeSpans));
  assert.equal(scopeSpans.length, 1);
  assert.equal(scopeSpans[0].spans.length, 2);
});

test('OBS-44: every emitted span carries hex ids, string nanos, and the reducer attribute', () => {
  const doc = encodeTraceDocument([SPAN_A, SPAN_B], { serviceName: 'mr-trace-relay' });
  const spans = doc.resourceSpans[0].scopeSpans[0].spans;

  const a = spans[0];
  assert.equal(isLowercaseHex(a.traceId, 32), true, `traceId '${a.traceId}' is not 32-hex`);
  assert.equal(isLowercaseHex(a.spanId, 16), true, `spanId '${a.spanId}' is not 16-hex`);
  assert.equal(a.name, 'zone_tick', 'the span name is the reducer');
  assert.equal(a.kind, 1, 'SPAN_KIND_INTERNAL — a server-side reconstruction, not a client call');
  assert.equal(a.startTimeUnixNano, '1782197246181000000');
  assert.equal(a.endTimeUnixNano, '1782197246183000000');
  assert.equal(typeof a.startTimeUnixNano, 'string', 'OTLP JSON carries 64-bit times as strings');
  assert.equal(typeof a.endTimeUnixNano, 'string');
  assert.deepEqual(
    a.attributes.find((x) => x.key === 'reducer'),
    { key: 'reducer', value: { stringValue: 'zone_tick' } },
  );
  assert.deepEqual(
    a.attributes.find((x) => x.key === 'mr.correlation_key'),
    { key: 'mr.correlation_key', value: { stringValue: 'cause:zone:a' } },
  );

  const b = spans[1];
  assert.equal(b.startTimeUnixNano, '1782197246182000000');
  assert.equal(b.endTimeUnixNano, '1782197246184000000');
  assert.notEqual(a.traceId, b.traceId, 'two distinct chains are two distinct traces');
  assert.notEqual(a.spanId, b.spanId);
});

test('OBS-44: spans sharing a correlation key share a traceId and differ in spanId', () => {
  const doc = encodeTraceDocument([SPAN_A, SPAN_A2], { serviceName: 'mr-trace-relay' });
  const spans = doc.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  assert.equal(spans[0].traceId, spans[1].traceId, 'one correlation key is one trace');
  assert.notEqual(spans[0].spanId, spans[1].spanId);
  assert.equal(spans[0].traceId, traceIdFor('cause:zone:a'), 'and it is the key-derived id');
});

test('encodeTraceDocument: the whole document is byte-stable across two calls', () => {
  const first = JSON.stringify(encodeTraceDocument([SPAN_A, SPAN_B], { serviceName: 'mr-x' }));
  const second = JSON.stringify(encodeTraceDocument([SPAN_A, SPAN_B], { serviceName: 'mr-x' }));
  assert.equal(first, second);
});

test('encodeTraceDocument: zero spans is an EMPTY document, not an empty wrapper', () => {
  const doc = encodeTraceDocument([], { serviceName: 'mr-trace-relay' });
  assert.deepEqual(
    doc,
    { resourceSpans: [] },
    'exporting a resource with an empty span list posts a payload that says nothing',
  );
});
