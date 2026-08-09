// reconstruct.mjs — the relay's end-to-end pure pipeline (m20e T3; OBS-50 +
// the OBS-42/43/44 composition).
//
// `tracePairSet` is an ALLOWLIST and it is REQUIRED: a missing allowlist is
// not the empty allowlist. Defaulting it would turn "the config could not be
// read" into "there was nothing to trace" — green by absence, the exact shape
// anti-pattern 1 names. An EMPTY set is a valid, explicit value: zero spans,
// flagged in the diagnostics and said out loud in a note.
//
// Discipline: no regex, no clock, no I/O. Lines in, document + diagnostics out.

import { encodeTraceDocument } from './otlp.mjs';
import { pairBreadcrumbs } from './pair.mjs';
import { parseBreadcrumb, parseHostLine } from './parse.mjs';

/**
 * Reconstruct an OTLP trace document from raw host log lines.
 *
 * Returns { document, diagnostics } where diagnostics is a closed book:
 *   linesRead === parsed + parseFailures            (blank lines are ignored)
 *   breadcrumbs === filteredOut + paired*2 + unpaired + skippedNoKey
 *
 * Throws when `tracePairSet` is absent or null — absence is not the empty set.
 * Accepts the membership as an Array or a Set of reducer names.
 */
export function reconstruct(lines, options = {}) {
  const { tracePairSet, serviceName = 'mr-trace-relay' } = options;
  if (tracePairSet === undefined || tracePairSet === null) {
    throw new Error(
      'reconstruct: no trace_pair_set membership was supplied — absence is NOT the empty set; ' +
        'pass the positively-read allowlist (an empty array is a valid, explicit value)',
    );
  }
  let allowed;
  if (tracePairSet instanceof Set) {
    allowed = tracePairSet;
  } else if (Array.isArray(tracePairSet)) {
    allowed = new Set(tracePairSet);
  } else {
    throw new Error('reconstruct: trace_pair_set must be an Array or a Set of reducer names');
  }

  let linesRead = 0;
  let parsed = 0;
  let parseFailures = 0;
  let breadcrumbs = 0;
  let filteredOut = 0;
  const crumbs = [];

  for (const line of lines) {
    if (typeof line === 'string' && line.trim().length === 0) {
      continue;
    }
    linesRead++;
    const record =
      typeof line === 'string' ? parseHostLine(line) : { ok: false, reason: 'not-json' };
    if (!record.ok) {
      parseFailures++;
      continue;
    }
    parsed++;
    const candidate = parseBreadcrumb(record);
    if (!candidate.ok) continue;
    breadcrumbs++;
    if (!allowed.has(candidate.crumb.reducer)) {
      filteredOut++;
      continue;
    }
    crumbs.push(candidate.crumb);
  }

  const { spans, counts } = pairBreadcrumbs(crumbs);
  const document = encodeTraceDocument(spans, { serviceName });

  const emptyTracePairSet = allowed.size === 0;
  const notes = [];
  if (emptyTracePairSet) {
    notes.push(
      'trace_pair_set is empty: every breadcrumb was filtered out by configuration, so zero ' +
        'spans is the configured result, not a broken pipeline',
    );
  }

  return {
    document,
    diagnostics: {
      linesRead,
      parsed,
      parseFailures,
      breadcrumbs,
      filteredOut,
      paired: counts.paired,
      unpaired: counts.unpaired,
      skippedNoKey: counts.skippedNoKey,
      emptyTracePairSet,
      notes,
    },
  };
}
