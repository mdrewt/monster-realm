// observability/instruments.ts — m20c (ADR-0180 body amendment), OBS-25 + AM16/AM17.
//
// The instrument catalogue AS DATA, consumed by BOTH the shell (which creates the real
// instruments from it) and the contract test (which pins names, kinds and the cardinality
// budget). Every `name:` field references names.ts — the single mirror of the wire contract —
// never a re-spelled literal (AM17).
//
// NO `unit` on any row, deliberately (risk R-2): the merged Alloy exporter appends a declared
// unit as a NAME suffix, which would break the verbatim `mr_client_fps_bucket` the recording
// rule reads. The unit lives in the name (`_ms`).
//
// Bucket lists are the AM16 adjudicated sets — trimmed for active-series cardinality (every
// boundary is one more series per zone × build × device combination, on a public ingest with no
// per-write cap). The fps list carries 50/55/60 because 55 IS the OBS-25 SLO threshold and
// histogram quantiles interpolate inside a bucket.

import {
  METRIC_FPS,
  METRIC_FRAME_TIME_MAX_MS,
  METRIC_INTENT_REJECT,
  METRIC_INTERP_GAP_MS,
  METRIC_RECONCILE,
  METRIC_RECONCILE_CORRECTION,
  METRIC_REDUCER_RTT_MS,
  METRIC_WASM_READY_MS,
} from './names';

export interface InstrumentSpec {
  readonly name: string;
  readonly kind: 'counter' | 'histogram';
  readonly boundaries?: readonly number[];
  readonly unit?: string;
  readonly description: string;
}

export const INSTRUMENTS: readonly InstrumentSpec[] = [
  {
    name: METRIC_FPS,
    kind: 'histogram',
    boundaries: [15, 30, 45, 50, 55, 60, 90, 144],
    description: 'Frames per second over each 1s window (OBS-25 SLO source, p50 >= 55)',
  },
  {
    name: METRIC_FRAME_TIME_MAX_MS,
    kind: 'histogram',
    boundaries: [8, 16, 33, 50, 100, 250, 1000],
    description: 'Worst single frame delta (ms) within each 1s window',
  },
  {
    name: METRIC_RECONCILE,
    kind: 'counter',
    description: 'Reconcile attempts against a coherent authoritative snapshot',
  },
  {
    name: METRIC_RECONCILE_CORRECTION,
    kind: 'counter',
    description: 'Reconciles whose corrected tile differed from the prediction',
  },
  {
    name: METRIC_INTENT_REJECT,
    kind: 'counter',
    description: 'Server-rejected movement intents that dropped a predicted op',
  },
  {
    name: METRIC_INTERP_GAP_MS,
    kind: 'histogram',
    boundaries: [16, 33, 66, 100, 200, 500],
    description: 'Adaptive interpolation delay (ms) of the worst remote character',
  },
  {
    name: METRIC_REDUCER_RTT_MS,
    kind: 'histogram',
    boundaries: [10, 25, 50, 100, 250, 500, 1000],
    description: 'enqueueMove round trip (ms): send to server-acknowledged settle',
  },
  {
    name: METRIC_WASM_READY_MS,
    kind: 'histogram',
    boundaries: [100, 250, 500, 1000, 2500, 5000, 10_000],
    description: 'ms from timeOrigin to the prediction-wasm exports being callable',
  },
];
