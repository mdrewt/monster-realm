// observability/instruments.test.ts — m20c (ADR-0180 body amendment), OBS-25 + AM4/AM16/AM17.
//
// SOURCE OF TRUTH: EARS OBS-25 (fps SLO p50 ≥ 55, read from `mr_client_fps_bucket`) + AM16 (the
// adjudicated bucket sets) + AM17 (instrument names must REFERENCE names.ts, not re-spell it) +
// the plan's global metric rules:
//   (1) UNIT IS UNSET on every instrument — the unit lives in the NAME (`_ms`). Alloy's
//       otelcol.exporter.prometheus appends a unit suffix when a unit is present, which would
//       turn `mr_client_fps` into something else and permanently break recording.rules.yml:69.
//   (2) every dimension is a DATAPOINT attribute (config.alloy:141 context="datapoint"), never a
//       resource attribute — see T-R1 in telemetry.test.ts for the other half of that rule.
//
// WHY THE TABLE IS DATA: the spec table is imported by BOTH the shell (which creates the real
// instruments from it) and this contract test. A shell that hand-rolls `meter.createHistogram(…)`
// call by call cannot be checked for cardinality or naming at all.
//
// RED REASON: `client/src/observability/instruments.ts` does not exist yet.

import { describe, expect, it } from 'vitest';
import { INSTRUMENTS, type InstrumentSpec } from './instruments';
// A NAMESPACE import (not a named one) because AM17 needs to enumerate every export of names.ts,
// not just the ones this file happens to mention — that enumeration is what makes the
// name-set equality bidirectional.
import * as names from './names';

const {
  METRIC_FPS,
  METRIC_FRAME_TIME_MAX_MS,
  METRIC_INTENT_REJECT,
  METRIC_INTERP_GAP_MS,
  METRIC_RECONCILE,
  METRIC_RECONCILE_CORRECTION,
  METRIC_REDUCER_RTT_MS,
  METRIC_WASM_READY_MS,
} = names;

/** AM16 — the adjudicated bucket sets, per metric. Trimmed from the planner's first draft
 *  specifically to bound active-series cardinality: every extra boundary is one more series per
 *  (zone_id × build_sha × device_class) combination, and Prometheus has no per-remote-write cap
 *  (config.alloy:130-139). */
const EXPECTED_BOUNDARIES: ReadonlyMap<string, readonly number[]> = new Map([
  [METRIC_FPS, [15, 30, 45, 50, 55, 60, 90, 144]],
  [METRIC_FRAME_TIME_MAX_MS, [8, 16, 33, 50, 100, 250, 1000]],
  [METRIC_INTERP_GAP_MS, [16, 33, 66, 100, 200, 500]],
  [METRIC_REDUCER_RTT_MS, [10, 25, 50, 100, 250, 500, 1000]],
  [METRIC_WASM_READY_MS, [100, 250, 500, 1000, 2500, 5000, 10_000]],
]);

const EXPECTED_COUNTERS: readonly string[] = [
  METRIC_RECONCILE,
  METRIC_RECONCILE_CORRECTION,
  METRIC_INTENT_REJECT,
];

/** Every `mr_client_*` string constant names.ts exports. AM17's SSOT side.
 *  The length guard excludes a bare `'mr_client_'` PREFIX constant (a legitimate thing to export
 *  if the names are assembled from it) so it is not miscounted as a ninth metric. */
const METRIC_PREFIX = 'mr_client_';
const NAME_CONSTANTS: readonly string[] = Object.values(names).filter(
  (v): v is string =>
    typeof v === 'string' && v.startsWith(METRIC_PREFIX) && v.length > METRIC_PREFIX.length,
);

function specFor(name: string): InstrumentSpec {
  const spec = INSTRUMENTS.find((i) => i.name === name);
  if (spec === undefined) {
    throw new Error(
      `INSTRUMENTS has no entry named ${JSON.stringify(name)} — the spec table and names.ts have ` +
        'diverged (AM17)',
    );
  }
  return spec;
}

describe('instruments.ts (AM17): the table IS names.ts — no second list of string literals', () => {
  it('AM17: the instrument-name set is set-EQUAL to the names.ts mr_client_* constant set', () => {
    // WRONG IMPL KILLED (1): instrument entries written as their own string literals. Two
    //   independent spellings of `mr_client_reducer_rtt_ms` drift on the first rename, and the
    //   symptom is a metric that simply stops existing — no error, no red test, an empty panel.
    // WRONG IMPL KILLED (2): a name defined in names.ts but never instrumented (a signal the ADR
    //   claims to ship and does not), or an instrument with no constant behind it. The equality
    //   is bidirectional, so both directions red.
    // NOT KILLED HERE, AND DELIBERATELY SO (red-team X5): a table that re-spells all eight names
    //   as string LITERALS produces an identical set and passes this test. Value equality is
    //   structurally blind to it. The companion TEXT check — instruments.ts must import
    //   `from './names'` and contain no `name: '…'` literal — lives in sourceScan.test.ts
    //   ("AM17 / X5"), where the comment-stripping scanner already exists. Both halves are
    //   required; neither is sufficient.
    // ANTI-VACUITY: the constant set itself must be the expected size, or an empty-vs-empty
    // comparison would pass while nothing is instrumented at all.
    expect(NAME_CONSTANTS.length, 'names.ts must export 8 mr_client_* metric names').toBe(8);
    expect(INSTRUMENTS.length, 'the table must carry exactly those 8 instruments').toBe(8);
    expect([...INSTRUMENTS.map((i) => i.name)].sort()).toEqual([...NAME_CONSTANTS].sort());
  });

  it('AM17-unique: no duplicate instrument names', () => {
    // WRONG IMPL KILLED: a copy-pasted row (e.g. two `mr_client_reconcile` entries, one counter
    // and one histogram). The OTel SDK would create both and the second silently shadows the
    // first for the rest of the session.
    expect(new Set(INSTRUMENTS.map((i) => i.name)).size).toBe(INSTRUMENTS.length);
  });

  it('AM17-shape: every name is lowercase snake_case ASCII under the mr_client_ prefix', () => {
    // WRONG IMPL KILLED: a dotted OTel-style name (`mr.client.fps`). Alloy's prometheus exporter
    // rewrites dots to underscores, so the stored series would not be the one the client (or any
    // dashboard written from this source) believes it emits.
    const ALLOWED = 'abcdefghijklmnopqrstuvwxyz0123456789_';
    for (const spec of INSTRUMENTS) {
      expect(
        spec.name.startsWith(METRIC_PREFIX),
        `${spec.name} must carry the mr_client_ prefix`,
      ).toBe(true);
      for (const ch of spec.name) {
        expect(ALLOWED.includes(ch), `${spec.name} contains the illegal character ${ch}`).toBe(
          true,
        );
      }
    }
  });
});

describe('instruments.ts (T-25a): the fps histogram is the OBS-25 SLO source', () => {
  it('T-25a: the fps instrument is a histogram named mr_client_fps with NO unit', () => {
    // WRONG IMPL KILLED (1): a rename — recording.rules.yml:69 reads `mr_client_fps_bucket` and
    //   is out of this slice's touch-set.
    // WRONG IMPL KILLED (2, the subtle one): setting `unit: 'fps'` / `unit: '1'`. Alloy's
    //   prometheus exporter appends the unit as a NAME SUFFIX, so the stored series becomes
    //   `mr_client_fps_fps_bucket` and the SLO records `vector(0)` forever while the client is
    //   demonstrably sending data. This is risk R-2 in the plan; unit-free naming is the fix.
    // WRONG IMPL KILLED (3): fps modelled as a GAUGE. A gauge has no `_bucket` series at all, so
    //   `histogram_quantile` cannot be computed and the p50 SLO is unimplementable.
    const fps = specFor('mr_client_fps');
    expect(fps.name).toBe(METRIC_FPS);
    expect(fps.kind).toBe('histogram');
    expect(fps.unit === undefined || fps.unit === '').toBe(true);
  });

  it('T-25b: the fps boundaries contain 50 AND 55 AND 60, strictly increasing (AM4)', () => {
    // AM4. 55 is the OBS-25 threshold itself: `histogram_quantile` INTERPOLATES inside a bucket,
    // so without a boundary AT 55 the p50 near the SLO line is a linear guess between 45 and 60 —
    // the panel would report a number that is not measured. 50 and 60 bracket it.
    // WRONG IMPL KILLED: a "simplified" bucket list ([30, 60, 120]) that un-measures the SLO
    // while every other assertion in this file still passes.
    const boundaries = specFor(METRIC_FPS).boundaries ?? [];
    for (const b of [50, 55, 60]) {
      expect(boundaries.includes(b), `the fps histogram must have a boundary at ${b}`).toBe(true);
    }
  });
});

describe('instruments.ts (AM16): the bucket sets are exact and the cardinality budget holds', () => {
  it('AM16: each histogram carries EXACTLY its adjudicated boundary list', () => {
    // Exact equality, not containment: an added boundary is an added series per attribute
    // combination, and a removed one silently coarsens a panel. Both must be a deliberate edit
    // here and in the ADR, never a drive-by.
    for (const [name, expected] of EXPECTED_BOUNDARIES) {
      const spec = specFor(name);
      expect(spec.kind, `${name} must be a histogram`).toBe('histogram');
      expect(spec.boundaries, `${name} boundaries`).toEqual(expected);
    }
    expect(EXPECTED_BOUNDARIES.size, 'five histograms are specified').toBe(5);
  });

  it('AM16-budget: EVERY histogram is strictly increasing, ≤ 9 boundaries, finite and positive', () => {
    // The ceiling that survives future edits: a new histogram added later is bound by the same
    // rule without anyone remembering to extend the table above.
    // WRONG IMPL KILLED (1): an unsorted or duplicated boundary list. The OTel SDK does not
    //   validate it; Prometheus ends up with non-monotonic `le` buckets and `histogram_quantile`
    //   returns nonsense (or NaN) rather than failing.
    // WRONG IMPL KILLED (2): a 20-boundary "high resolution" list. Series count is
    //   (boundaries + 1) × zone × build × device, on a PUBLIC ingest with no per-write cap
    //   (config.alloy:130-139) — the OOM this whole filter chain exists to prevent.
    const histograms = INSTRUMENTS.filter((i) => i.kind === 'histogram');
    expect(histograms.length, 'anti-vacuity: there must be histograms to judge').toBe(5);

    for (const spec of histograms) {
      const boundaries = spec.boundaries;
      expect(boundaries, `${spec.name} must declare boundaries`).toBeDefined();
      if (boundaries === undefined) continue;
      expect(
        boundaries.length,
        `${spec.name} has ${boundaries.length} boundaries (max 9)`,
      ).toBeLessThanOrEqual(9);
      expect(boundaries.length, `${spec.name} must have at least one boundary`).toBeGreaterThan(0);
      for (let i = 0; i < boundaries.length; i += 1) {
        const value = boundaries[i] as number;
        expect(Number.isFinite(value), `${spec.name}[${i}] must be finite`).toBe(true);
        expect(value, `${spec.name}[${i}] must be positive`).toBeGreaterThan(0);
        if (i > 0) {
          expect(value, `${spec.name} boundaries must be STRICTLY increasing`).toBeGreaterThan(
            boundaries[i - 1] as number,
          );
        }
      }
    }
  });

  it('AM16-counters: the three counters exist, are counters, and declare no boundaries', () => {
    // AM5 keeps `mr_client_intent_reject` as a deliberate third counter beyond the six
    // spec-named signals (netcode health: server-rejected intents ⇒ visible rubber-banding).
    // WRONG IMPL KILLED: modelling a counter as a histogram "for consistency", which multiplies
    // its series count by the bucket count for no information gain.
    expect([...INSTRUMENTS.filter((i) => i.kind === 'counter').map((i) => i.name)].sort()).toEqual(
      [...EXPECTED_COUNTERS].sort(),
    );
    for (const name of EXPECTED_COUNTERS) {
      expect(specFor(name).boundaries, `${name} must not declare buckets`).toBeUndefined();
    }
  });
});

describe('instruments.ts: the global rules that apply to every row', () => {
  it('T-25a-global: NO instrument declares a unit (the unit lives in the name)', () => {
    // Risk R-2, generalised. Alloy 1.18.1's `add_metric_suffixes`/`translation_strategy`
    // behaviour differs across versions, and unit-free naming is what makes both converge on the
    // names recording.rules.yml already references.
    for (const spec of INSTRUMENTS) {
      expect(
        spec.unit === undefined || spec.unit === '',
        `${spec.name} must NOT declare a unit (got ${JSON.stringify(spec.unit)}) — Alloy would ` +
          'append it as a name suffix and the recording rule would stop matching',
      ).toBe(true);
    }
  });

  it('every instrument carries a non-empty description (it reaches Prometheus as HELP text)', () => {
    for (const spec of INSTRUMENTS) {
      expect(spec.description.trim().length, `${spec.name} needs a description`).toBeGreaterThan(0);
    }
  });

  it('every instrument is a counter or a histogram — no gauges, no observable callbacks', () => {
    // Plan anti-pattern 5: an ObservableGauge runs a CALLBACK on the export thread, on a
    // schedule this module does not control, reading state the frame loop owns. Both supported
    // kinds are push-only and synchronous with the game loop.
    for (const spec of INSTRUMENTS) {
      expect(['counter', 'histogram'].includes(spec.kind), `${spec.name} kind=${spec.kind}`).toBe(
        true,
      );
    }
  });
});
