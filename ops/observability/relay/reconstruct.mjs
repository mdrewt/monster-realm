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
import { correlationKey, parseBreadcrumb, parseHostLine } from './parse.mjs';

/**
 * Re-attach each leftover from `pairBreadcrumbs` to the crumb it came from.
 *
 * `pairBreadcrumbs` reports its leftovers in the KEYED shape { key, reducer,
 * ts, phase }, which is enough to diagnose but NOT enough to pair again: the
 * `cause`/`sched` fields the correlation key is derived from are gone, so a
 * leftover fed straight back in would key as null and be counted skippedNoKey.
 * A tail-follow caller (AM2) has to carry its open enters into the NEXT batch,
 * so this returns each leftover in the FULL crumb shape with its `key`
 * alongside — the exact value `carryOverCrumbs` accepts.
 */
function rejoinLeftovers(leftovers, pool) {
  const bySignature = new Map();
  for (const crumb of pool) {
    const key = correlationKey(crumb);
    if (key === null) continue;
    const signature = JSON.stringify([crumb.reducer, key, crumb.ts, crumb.phase]);
    const queue = bySignature.get(signature);
    if (queue === undefined) bySignature.set(signature, [crumb]);
    else queue.push(crumb);
  }
  return leftovers.map((entry) => {
    const signature = JSON.stringify([entry.reducer, entry.key, entry.ts, entry.phase]);
    const queue = bySignature.get(signature);
    if (queue === undefined || queue.length === 0) return { ...entry };
    return { ...queue.shift(), key: entry.key };
  });
}

/**
 * Reconstruct an OTLP trace document from raw host log lines.
 *
 * Returns { document, spans, unpaired, diagnostics }:
 *   document   the OTLP/HTTP JSON trace document for `spans`
 *   spans      the paired spans in domain form (see pair.mjs)
 *   unpaired   the leftover crumbs in FULL form, each carrying its correlation
 *              `key` — diagnostic-only here, and the value a tail-follow caller
 *              carries into the next batch through `carryOverCrumbs` (AM2)
 *   diagnostics a closed book:
 *     linesRead === parsed + parseFailures            (blank lines are ignored)
 *     breadcrumbs === filteredOut + paired*2 + unpaired + skippedNoKey
 *
 * `carryOverCrumbs` (default []) are crumbs read in an EARLIER batch that are
 * still open. They join the pairing pool without being re-parsed, which is what
 * lets an enter in poll N pair with its exit in poll N+1 — `pairBreadcrumbs`
 * matches FIFO within ONE invocation, so without this every reducer whose
 * enter and exit straddle a poll boundary would lose its span silently. They
 * ARE counted in `breadcrumbs` (which therefore means "crumbs entering the
 * pairing pool", not "crumbs parsed from `lines`") so the closed book above
 * stays closed; `linesRead`/`parsed` are untouched by them.
 *
 * Throws when `tracePairSet` is absent or null — absence is not the empty set.
 * Accepts the membership as an Array or a Set of reducer names.
 */
export function reconstruct(lines, options = {}) {
  const { tracePairSet, serviceName = 'mr-trace-relay', carryOverCrumbs = [] } = options;
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

  const pool = carryOverCrumbs.length === 0 ? crumbs : [...carryOverCrumbs, ...crumbs];
  const { spans, unpaired: leftovers, counts } = pairBreadcrumbs(pool);
  const document = encodeTraceDocument(spans, { serviceName });
  const unpaired = rejoinLeftovers(leftovers, pool);

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
    spans,
    unpaired,
    diagnostics: {
      linesRead,
      parsed,
      parseFailures,
      breadcrumbs: breadcrumbs + carryOverCrumbs.length,
      filteredOut,
      paired: counts.paired,
      unpaired: counts.unpaired,
      skippedNoKey: counts.skippedNoKey,
      emptyTracePairSet,
      notes,
    },
  };
}
