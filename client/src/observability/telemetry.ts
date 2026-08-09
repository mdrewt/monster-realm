// observability/telemetry.ts — m20c (ADR-0180 body amendment): the imperative shell.
//
// Everything decision-shaped lives in the pure siblings (names/attributes/config/frameWindow/
// interpGap/instruments); this file only adapts them onto the OTel Web SDK and makes the whole
// path FAIL-SILENT. Telemetry is strictly non-essential: the local Caddy terminates TLS with an
// internal CA the browser may not trust yet, dev machines run without the stack entirely, and a
// broken exporter must never put an error in front of a playing player. So `startClientTelemetry`
// never rejects, the disabled path never loads the SDK, and every facade method swallows its own
// faults.
//
// THE SDK IS REACHED ONLY THROUGH THE INJECTED LOADER. The default loader below dynamic-imports
// the packages, which keeps them in a separate chunk that is never fetched when telemetry is off,
// and lets the sibling test drive the whole shell with a fake — the only way to assert on the
// exporter configuration (OBS-16: the export request carries NO extra request headers of any
// kind; the ingest is public by design and the CORS policy allows only content-type).
//
// The resource attribute set is EXACTLY { 'service.name' } (risk R-1): the remote-write side
// preserves the `instance` label, so a per-session resource value would mint one active series
// per page load — the cardinality failure the datapoint allowlist cannot see.

import { buildAttributes } from './attributes';
import { OTLP_METRICS_PATH, type TelemetryConfig } from './config';
import { classifyDeviceClass, type DeviceHints } from './deviceClass';
import type { FrameSample } from './frameWindow';
import { INSTRUMENTS, type InstrumentSpec } from './instruments';
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

export interface Histogram {
  record(value: number, attributes: Readonly<Record<string, string>>): void;
}

export interface Counter {
  add(value: number, attributes: Readonly<Record<string, string>>): void;
}

/** The fully resolved SDK bootstrap surface — everything the loader needs, nothing it decides. */
export interface TelemetryInit {
  /** `<configured origin>` + OTLP_METRICS_PATH, exactly. */
  readonly exporterUrl: string;
  /** Absent (or `{}`): the export request carries no extra request headers, ever (OBS-16). */
  readonly exporterHeaders?: Record<string, string>;
  /** The resolved config value, verbatim. */
  readonly exportIntervalMillis: number;
  /** EXACTLY { 'service.name': … } — see the R-1 header note. */
  readonly resourceAttributes: Record<string, string>;
  /** Explicit, never the package default (R4): the remote-write sink is a cumulative store. */
  readonly temporality: 'cumulative';
}

export interface TelemetryMeter {
  createHistogram(spec: InstrumentSpec): Histogram;
  createCounter(spec: InstrumentSpec): Counter;
}

export type SdkLoader = (init: TelemetryInit) => Promise<TelemetryMeter>;

export interface TelemetryDeps {
  readonly loadSdk: SdkLoader;
  readonly hints?: DeviceHints;
  readonly buildSha?: string;
}

export interface ClientTelemetry {
  recordFrameSample(sample: FrameSample): void;
  recordInterpGap(gapMs: number | undefined): void;
  recordReconcile(): void;
  recordCorrection(): void;
  recordIntentReject(): void;
  recordRtt(rttMs: number): void;
  recordWasmReady(readyMs: number): void;
  setZone(zoneId: number): void;
}

function noop(): void {
  // the shared do-nothing facade body
}

/** The shared inert facade: main.ts holds this from module evaluation until the async init
 *  resolves — and forever, when telemetry is off or the init failed. */
export const NOOP_TELEMETRY: ClientTelemetry = {
  recordFrameSample: noop,
  recordInterpGap: noop,
  recordReconcile: noop,
  recordCorrection: noop,
  recordIntentReject: noop,
  recordRtt: noop,
  recordWasmReady: noop,
  setZone: noop,
};

/** The default production loader: dynamic imports only (a static form would pull the SDK into
 *  the main bundle for every player, telemetry on or off). Adapts the real SDK onto the narrow
 *  TelemetryMeter seam the shell and the tests share. */
export const loadOtelSdk: SdkLoader = async (init) => {
  const [sdkMetrics, resources, exporterHttp] = await Promise.all([
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
  ]);

  const exporter = new exporterHttp.OTLPMetricExporter({
    url: init.exporterUrl,
    temporalityPreference: sdkMetrics.AggregationTemporality.CUMULATIVE,
  });
  const reader = new sdkMetrics.PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: init.exportIntervalMillis,
  });
  const provider = new sdkMetrics.MeterProvider({
    resource: resources.resourceFromAttributes(init.resourceAttributes),
    readers: [reader],
  });
  const meter = provider.getMeter('monster-realm-client');

  return {
    createHistogram: (spec) =>
      meter.createHistogram(spec.name, {
        description: spec.description,
        advice:
          spec.boundaries === undefined
            ? undefined
            : { explicitBucketBoundaries: [...spec.boundaries] },
      }),
    createCounter: (spec) => meter.createCounter(spec.name, { description: spec.description }),
  };
};

/** Guard for every instrument call: third-party record faults must never reach the frame loop,
 *  the reconcile path, or the send-path promise chain. */
function safely(run: () => void): void {
  try {
    run();
  } catch {
    // swallowed by contract — telemetry degrades, the game does not
  }
}

/**
 * Start the telemetry shell. NEVER rejects; resolves to NOOP_TELEMETRY when the config is
 * disabled (without touching the loader) or when any part of the bootstrap fails.
 */
export async function startClientTelemetry(
  config: TelemetryConfig,
  deps: TelemetryDeps,
): Promise<ClientTelemetry> {
  try {
    if (config.kind !== 'enabled') return NOOP_TELEMETRY;

    const init: TelemetryInit = {
      exporterUrl: `${config.endpoint}${OTLP_METRICS_PATH}`,
      exportIntervalMillis: config.exportIntervalMs,
      resourceAttributes: { 'service.name': 'monster-realm-client' },
      temporality: 'cumulative',
    };
    const meter = await deps.loadSdk(init);

    const histograms = new Map<string, Histogram>();
    const counters = new Map<string, Counter>();
    for (const spec of INSTRUMENTS) {
      if (spec.kind === 'histogram') {
        histograms.set(spec.name, meter.createHistogram(spec));
      } else {
        counters.set(spec.name, meter.createCounter(spec));
      }
    }

    const deviceClass = classifyDeviceClass(deps.hints ?? {});
    // ONE frozen attribute object, shared by every instrument call verbatim (AM10) and rebuilt
    // only by setZone (AM1). No call site can append a per-call dimension.
    let attrs = buildAttributes({ buildSha: deps.buildSha, deviceClass });

    const record = (name: string, value: number): void => {
      safely(() => histograms.get(name)?.record(value, attrs));
    };
    const count = (name: string): void => {
      safely(() => counters.get(name)?.add(1, attrs));
    };

    return {
      recordFrameSample: (sample) => {
        record(METRIC_FPS, sample.fps);
        record(METRIC_FRAME_TIME_MAX_MS, sample.maxFrameMs);
      },
      recordInterpGap: (gapMs) => {
        if (gapMs === undefined) return; // a solo session is not a 0ms gap
        record(METRIC_INTERP_GAP_MS, gapMs);
      },
      recordReconcile: () => count(METRIC_RECONCILE),
      recordCorrection: () => count(METRIC_RECONCILE_CORRECTION),
      recordIntentReject: () => count(METRIC_INTENT_REJECT),
      recordRtt: (rttMs) => record(METRIC_REDUCER_RTT_MS, rttMs),
      recordWasmReady: (readyMs) => record(METRIC_WASM_READY_MS, readyMs),
      setZone: (zoneId) => {
        attrs = buildAttributes({ zoneId, buildSha: deps.buildSha, deviceClass });
      },
    };
  } catch {
    return NOOP_TELEMETRY;
  }
}
