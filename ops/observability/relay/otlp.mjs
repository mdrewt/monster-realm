// otlp.mjs — OTLP/HTTP JSON trace encoder (pure core).
//
// Trace and span ids are LOWERCASE HEX strings of exactly 32/16 characters in
// the OTLP/HTTP JSON export — never base64, which is what protobuf's JSON
// mapping for bytes fields would produce (OBS-44). Ids are a deterministic
// sha256 derivation of the correlation identity: no clock, no RNG, so two
// runs over the same logs export byte-identical documents.
//
// 64-bit times are carried as STRINGS of exact digits: microseconds to
// nanoseconds is BigInt arithmetic, never Number math and never a string
// append (a bare append turns '0' into '0000', which OTLP consumers reject).
//
// Discipline: no regex, no clock, no I/O; node:crypto is the only import.

import { createHash } from 'node:crypto';

// A truncated lowercase-hex sha256 digest, never all-zero (the OTLP invalid-id
// sentinel). The all-zero fallback is deterministic and practically
// unreachable; it exists so the contract is total rather than probabilistic.
function derivedHexId(input, length) {
  const id = createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length);
  for (let i = 0; i < id.length; i++) {
    if (id[i] !== '0') return id;
  }
  return `${id.slice(0, length - 1)}1`;
}

/** The 32-hex trace id for one correlation key: one key is one trace. */
export function traceIdFor(key) {
  return derivedHexId(`mr-trace-relay:trace:${key}`, 32);
}

/**
 * The 16-hex span id for one reconstructed call: the start timestamp is part
 * of the identity, so repeat calls under one key stay distinct spans.
 */
export function spanIdFor(key, reducer, startMicros) {
  return derivedHexId(`mr-trace-relay:span:${key}\u0000${reducer}\u0000${startMicros}`, 16);
}

/** Exact microseconds -> nanoseconds over digit strings (BigInt arithmetic). */
export function microsToNanosString(microsDigitString) {
  return (BigInt(microsDigitString) * 1000n).toString();
}

/**
 * Encode paired spans as one OTLP/HTTP JSON trace document. Zero spans is the
 * EMPTY document { resourceSpans: [] } — a resource wrapping an empty span
 * list would post a payload that says nothing.
 */
export function encodeTraceDocument(spans, { serviceName = 'mr-trace-relay' } = {}) {
  if (spans.length === 0) {
    return { resourceSpans: [] };
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
        },
        scopeSpans: [
          {
            spans: spans.map((span) => ({
              traceId: traceIdFor(span.key),
              spanId: spanIdFor(span.key, span.reducer, span.startMicros),
              name: span.reducer,
              kind: 1,
              startTimeUnixNano: microsToNanosString(span.startMicros),
              endTimeUnixNano: microsToNanosString(span.endMicros),
              attributes: [
                { key: 'reducer', value: { stringValue: span.reducer } },
                { key: 'mr.correlation_key', value: { stringValue: span.key } },
              ],
            })),
          },
        ],
      },
    ],
  };
}
