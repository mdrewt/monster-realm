// observability/telemetry.test.ts — m20c (ADR-0180 body amendment): the shell contract.
//
// SOURCE OF TRUTH: EARS OBS-16 ("client SHALL export via the OTel Web SDK over OTLP/HTTP to
// Alloy, with NO auth credential"), OBS-21 (target the m20b Caddy route), OBS-34/35 (no player
// text / no identity), plus AM3 (runtime header seam), AM7/R-1 (explicit resource), AM9 (exact
// export URL), AM10 (attribute reference identity), AM15 (no fan-out).
//
// THE SDK IS INJECTED — deliberately, and this is the load-bearing test-design decision:
//   `startClientTelemetry(config, deps)` receives `deps.loadSdk`, a function that takes a fully
//   resolved `TelemetryInit` and returns a meter. The real implementation's default loader is a
//   dynamic `import('@opentelemetry/…')` (which is also what keeps the SDK in a separate chunk
//   that is never fetched when telemetry is off). These tests NEVER import @opentelemetry: the
//   packages are not installed at authoring time, vitest runs in the NODE environment
//   (vite.config.ts:47-53) with no `window`/`fetch` ceremony, and a fake is the only way to
//   ASSERT ON the exporter configuration — the one thing OBS-16's "no auth credential" is about.
//
// THE INJECTED SEAM, SPELLED OUT (the implementer must match these names exactly):
//   type SdkLoader = (init: TelemetryInit) => Promise<TelemetryMeter>;
//   interface TelemetryInit {
//     exporterUrl: string;                       // <configured origin> + OTLP_METRICS_PATH
//     exporterHeaders?: Record<string, string>;  // absent, or {} — never anything else (OBS-16)
//     exportIntervalMillis: number;              // the resolved config value, verbatim
//     resourceAttributes: Record<string, string>;// EXACTLY { 'service.name': … } (AM7/R-1)
//     temporality: 'cumulative';                 // explicit, never the package default (R4)
//   }
//   interface TelemetryMeter {
//     createHistogram(spec: InstrumentSpec): Histogram;  // { record(value, attributes) }
//     createCounter(spec: InstrumentSpec): Counter;      // { add(value, attributes) }
//   }
//   interface TelemetryDeps { loadSdk: SdkLoader; hints?: DeviceHints; buildSha?: string }
//   startClientTelemetry(config, deps): Promise<ClientTelemetry>   // NEVER rejects
//
// RED REASON: `client/src/observability/telemetry.ts` does not exist yet.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAttributes } from './attributes';
import { OTLP_METRICS_PATH, type TelemetryConfig } from './config';
import type { DeviceHints } from './deviceClass';
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
import {
  type ClientTelemetry,
  type Counter,
  type Histogram,
  NOOP_TELEMETRY,
  type SdkLoader,
  startClientTelemetry,
  type TelemetryInit,
} from './telemetry';

const ENDPOINT = 'https://127.0.0.1:8443';
const SHA = 'a1b2c3d';
const IPHONE_HINTS: DeviceHints = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari/604.1',
  maxTouchPoints: 5,
};

const ENABLED: TelemetryConfig = {
  kind: 'enabled',
  endpoint: ENDPOINT,
  exportIntervalMs: 60_000,
};
const DISABLED: TelemetryConfig = { kind: 'disabled', reason: 'VITE_MR_OTLP_ENDPOINT unset' };

interface RecordedCall {
  readonly instrument: string;
  readonly method: 'record' | 'add';
  readonly value: number;
  readonly attributes: Readonly<Record<string, string>>;
}

interface Harness {
  readonly inits: TelemetryInit[];
  readonly created: Array<{ name: string; kind: string }>;
  readonly calls: RecordedCall[];
  readonly loadSdk: SdkLoader;
  loadCount: number;
}

/** A fake SDK loader that captures the whole init surface plus every instrument call.
 *  `throwOnCall` makes every instrument throw AFTER recording the attempt, so a test can prove
 *  both that the call was made and that the throw was swallowed. */
function makeHarness(options: { throwOnCall?: boolean } = {}): Harness {
  const harness: Harness = {
    inits: [],
    created: [],
    calls: [],
    loadCount: 0,
    loadSdk: (init: TelemetryInit) => {
      harness.inits.push(init);
      harness.loadCount += 1;

      const sink = (spec: InstrumentSpec, method: 'record' | 'add') => {
        harness.created.push({ name: spec.name, kind: spec.kind });
        return (value: number, attributes: Readonly<Record<string, string>>): void => {
          harness.calls.push({ instrument: spec.name, method, value, attributes });
          if (options.throwOnCall === true) {
            throw new Error(`[fake sdk] ${spec.name}.${method} exploded`);
          }
        };
      };

      return Promise.resolve({
        createHistogram: (spec: InstrumentSpec): Histogram => ({ record: sink(spec, 'record') }),
        createCounter: (spec: InstrumentSpec): Counter => ({ add: sink(spec, 'add') }),
      });
    },
  };
  return harness;
}

/** Spy on every console sink; returns the total number of calls across all of them. */
function spyConsole(): () => number {
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'debug').mockImplementation(() => {}),
  ];
  return () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
}

interface StartOptions {
  readonly config?: TelemetryConfig;
  readonly hints?: DeviceHints;
  readonly buildSha?: string;
}

/**
 * Start telemetry against `harness` AND re-assert the whole-init invariants EVERY time.
 *
 * RED-TEAM X2, PROVEN: with the per-test assertions written only where each one was "about" the
 * subject, an implementation that called `deps.loadSdk` a SECOND time — a second MeterProvider
 * with an `Authorization` header and a `service.instance.id` resource attribute — passed all 97
 * unit tests. T-16a and T-R1 each read `harness.inits[0]`, the FIRST (clean) init, and nothing
 * anywhere asserted how many inits there were. Two exporters would then run side by side: one
 * conforming, one shipping a credential and minting a series per page load.
 *
 * So the invariants are hoisted here and re-checked, over EVERY captured init, on EVERY start in
 * this file: exactly one load, no headers, the exact resource set, cumulative temporality, and
 * the exact OTLP path. A smuggled second init now reds in every test at once.
 */
async function startWith(harness: Harness, options: StartOptions = {}): Promise<ClientTelemetry> {
  const config = options.config ?? ENABLED;
  const telemetry = await startClientTelemetry(config, {
    loadSdk: harness.loadSdk,
    buildSha: options.buildSha ?? SHA,
    hints: options.hints,
  });

  const expectedLoads = config.kind === 'enabled' ? 1 : 0;
  expect(
    harness.loadCount,
    `the SDK loader must be invoked exactly ${expectedLoads} time(s) for a ${config.kind} ` +
      'config. A SECOND load builds a second MeterProvider/exporter that no per-test assertion ' +
      'reading inits[0] can see (red-team X2).',
  ).toBe(expectedLoads);
  expect(harness.inits).toHaveLength(expectedLoads);

  for (const init of harness.inits) {
    if (init.exporterHeaders !== undefined) {
      expect(init.exporterHeaders, 'every exporter init must carry NO headers (OBS-16)').toEqual(
        {},
      );
    }
    expect(
      Object.keys(init.resourceAttributes).sort(),
      'every init resource must be exactly {service.name} (AM7/R-1)',
    ).toEqual(['service.name']);
    expect(init.resourceAttributes['service.name']).toBe('monster-realm-client');
    expect(init.temporality, 'every init must be CUMULATIVE (R4)').toBe('cumulative');
    const url = new URL(init.exporterUrl);
    expect(url.pathname, 'every init must POST to the OTLP metrics path').toBe(OTLP_METRICS_PATH);
    expect(url.search).toBe('');
    expect(url.username).toBe('');
    expect(url.password).toBe('');
  }

  return telemetry;
}

/** Drive every façade method once. Used by the robustness teeth. */
function exerciseAll(t: ClientTelemetry): void {
  t.recordFrameSample({ fps: 59.5, maxFrameMs: 21 });
  t.recordInterpGap(240);
  t.recordReconcile();
  t.recordCorrection();
  t.recordIntentReject();
  t.recordRtt(42);
  t.recordWasmReady(1234);
  t.setZone(1);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startClientTelemetry (OBS-16): the exporter carries NO credential and one exact URL', () => {
  it('T-16a: the exporter headers are EXACTLY {} or absent — deep equality, not a substring scan', async () => {
    // AM3: this is the RUNTIME half of the OBS-16 "no auth credential" criterion, and it is the
    // primary one — the source scan in sourceScan.test.ts can only see the words in the file.
    // WRONG IMPL KILLED (1): `headers: { Authorization: … }` built from the SpacetimeDB token.
    //   The ingest is deliberately unauthenticated (ops/observability/Caddyfile), so ANY header
    //   here is a secret shipped to a public endpoint for no benefit — and a session token in a
    //   telemetry request is a session-hijack primitive.
    // WRONG IMPL KILLED (2): a custom header of any kind (`X-Player-Id`, `X-Build`). Caddy's
    //   CORS preflight allows ONLY `content-type` (Caddyfile:54), so a custom header makes every
    //   export fail the preflight — telemetry that silently never arrives.
    // Deep equality is the point: `expect(JSON.stringify(headers)).not.toContain('Authorization')`
    // passes for `{ 'x-mr-token': … }`.
    // X2: `startWith` additionally proves there is exactly ONE init and re-checks the headers of
    // EVERY captured init — a second, header-bearing exporter smuggled in beside the clean one is
    // invisible to an `inits[0]` read.
    const harness = makeHarness();
    await startWith(harness);

    expect(harness.inits, 'the loader must be called exactly once').toHaveLength(1);
    const headers = (harness.inits[0] as TelemetryInit).exporterHeaders;
    if (headers !== undefined) {
      expect(
        headers,
        'the OTLP exporter must be configured with NO headers at all (OBS-16). Got: ' +
          JSON.stringify(headers),
      ).toEqual({});
    }
  });

  it('T-16c/AM9: the export URL is EXACTLY <configured origin>/v1/metrics', async () => {
    // AM9. WRONG IMPL KILLED (1): a hard-coded fallback host — the endpoint the operator
    //   configured would be ignored and every export would go somewhere else (or nowhere).
    // WRONG IMPL KILLED (2, the reason this is an exact parse rather than an `endsWith`):
    //   identity smuggling in the PATH — `${endpoint}/v1/metrics?u=${identity}` or
    //   `${endpoint}/${sessionId}/v1/metrics`. Both satisfy "ends with /v1/metrics"; neither
    //   survives `origin === endpoint && pathname === '/v1/metrics' && search === ''`.
    const harness = makeHarness();
    await startWith(harness);

    const init = harness.inits[0] as TelemetryInit;
    const url = new URL(init.exporterUrl);
    expect(url.origin).toBe(ENDPOINT);
    expect(url.pathname).toBe('/v1/metrics');
    expect(url.pathname).toBe(OTLP_METRICS_PATH);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(url.username).toBe('');
    expect(url.password).toBe('');
  });

  it('T-R1/AM7: the resource attribute set is EXACTLY {service.name} (the cardinality back door)', async () => {
    // RISK R-1, the one that can OOM Prometheus through a door the datapoint allowlist cannot
    // see. `prometheus.remote_write`'s labelkeep (config.alloy:174+) PRESERVES `instance`, and a
    // browser resource that carries `service.instance.id` (a fresh UUID per page load) becomes a
    // new `instance` label — one new active series per RELOAD. The S4 datapoint filter never
    // sees resource attributes at all (config.alloy:141 is context="datapoint").
    // WRONG IMPL KILLED (1): `defaultResource().merge(…)` or `detectResources()`, which is what
    //   every OTel getting-started snippet does.
    // WRONG IMPL KILLED (2): adding `service.version: BUILD_INFO.sha` "for convenience" — the
    //   build sha belongs on the DATAPOINT (where the allowlist bounds it), not on the resource
    //   (where it mints a target_info series per build and is stripped anyway).
    const harness = makeHarness();
    await startWith(harness);

    const init = harness.inits[0] as TelemetryInit;
    expect(Object.keys(init.resourceAttributes).sort()).toEqual(['service.name']);
    expect(init.resourceAttributes['service.name']).toBe('monster-realm-client');
  });

  it('R4: the reader temporality is CUMULATIVE, explicitly', async () => {
    // Pinned rather than left to the SDK default. Alloy's prometheus exporter converts OTLP sums
    // to Prometheus counters, and Prometheus's `rate()` model assumes a monotonically increasing
    // series. DELTA temporality resets the value to the per-interval increment on every export,
    // so `rate(mr_client_reconcile[5m])` would read a sawtooth as a stream of counter RESETS —
    // producing plausible-looking but meaningless divergence and reject rates (§4's whole point).
    // WRONG IMPL KILLED: leaving `temporality` unset and inheriting whatever the exporter
    // package defaults to in the version the lockfile happens to resolve (AM6 pins 0.221.0 today;
    // the default has changed across 0.x releases).
    const harness = makeHarness();
    await startWith(harness);
    expect((harness.inits[0] as TelemetryInit).temporality).toBe('cumulative');
  });

  it('the resolved export interval is passed through to the reader unchanged', async () => {
    // WRONG IMPL KILLED: the SDK default (60s) used while the resolved config says something
    // else — the clamp+jitter work in config.ts would be dead code and the herd would stay
    // synchronised (AM12).
    const harness = makeHarness();
    await startWith(harness, {
      config: { kind: 'enabled', endpoint: ENDPOINT, exportIntervalMs: 63_000 },
    });
    expect((harness.inits[0] as TelemetryInit).exportIntervalMillis).toBe(63_000);
  });

  it('every instrument in the spec table is created, with the right KIND', async () => {
    // Binds the shell to instruments.ts. WRONG IMPL KILLED: a shell that hand-writes
    // `meter.createHistogram('mr_client_fps', …)` call by call — then the AM16 cardinality
    // ceiling and the AM17 name-set identity proven in instruments.test.ts govern a table
    // nothing reads, and the real instrument set is unchecked.
    const harness = makeHarness();
    await startWith(harness);

    expect([...harness.created].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [...INSTRUMENTS]
        .map((i) => ({ name: i.name, kind: i.kind }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    // Kind-correctness is what routes counters to add() and histograms to record().
    for (const entry of harness.created) {
      const spec = INSTRUMENTS.find((i) => i.name === entry.name);
      expect(spec?.kind).toBe(entry.kind);
    }
  });
});

describe('startClientTelemetry (T-I1): disabled means INERT — no loader, no console, the shared no-op', () => {
  it('T-I1: a disabled config returns NOOP_TELEMETRY, never calls the loader, and is silent', async () => {
    // The default state of every build, every vitest run and every Playwright run.
    // WRONG IMPL KILLED (1): loading the SDK anyway and only skipping the exporter — that pulls
    //   the (~30-40KB gz) OTel chunk into every page load for nothing, which is the exact cost
    //   the dynamic-import design exists to avoid.
    // WRONG IMPL KILLED (2): returning a FRESH no-op object. Identity with the exported constant
    //   is what lets main.ts's `let telemetry = NOOP_TELEMETRY` be compared and reasoned about,
    //   and it guarantees the disabled path allocates nothing at all.
    const total = spyConsole();
    const harness = makeHarness();
    // startWith asserts ZERO loads for a disabled config — including a second, "just to warm the
    // chunk" load that a `loadCount === 0` check written only here would still have to make.
    const telemetry = await startWith(harness, { config: DISABLED });

    expect(telemetry).toBe(NOOP_TELEMETRY);
    expect(harness.loadCount, 'the SDK must NOT be loaded when telemetry is off').toBe(0);
    expect(harness.calls).toHaveLength(0);
    expect(total(), 'the disabled path must write nothing to the console').toBe(0);
  });

  it('NOOP_TELEMETRY implements the whole façade and every method is a silent no-op', () => {
    // main.ts holds this object from module evaluation until the async init resolves — and
    // FOREVER if telemetry is off or init fails. A missing method there is a TypeError inside
    // the frame loop / the reducer promise chain.
    const total = spyConsole();
    expect(() => exerciseAll(NOOP_TELEMETRY)).not.toThrow();
    expect(total()).toBe(0);
  });
});

describe('startClientTelemetry (T-P1): initialisation NEVER escapes as a rejection or a throw', () => {
  it('T-P1-throw: a loader that throws SYNCHRONOUSLY still yields a usable façade', async () => {
    // WRONG IMPL KILLED: `const meter = await deps.loadSdk(init)` with no try/catch. A synchronous
    // throw inside the loader (a bad dynamic import specifier, a CSP block, a missing chunk after
    // a redeploy) rejects the promise; main.ts's call site is fire-and-forget, so the rejection
    // reaches window.onunhandledrejection → pushError → the ERROR OVERLAY. Telemetry would then
    // put a modal error in front of a playing player. It must fail silent, always.
    const total = spyConsole();
    const telemetry = await startClientTelemetry(ENABLED, {
      loadSdk: () => {
        throw new Error('chunk load failed');
      },
      buildSha: SHA,
    });

    expect(telemetry).toBeDefined();
    expect(() => exerciseAll(telemetry)).not.toThrow();
    expect(total(), 'a failed init must not write to the console either').toBe(0);
  });

  it('T-P1-reject: a loader that REJECTS resolves to a usable façade, with no unhandled rejection', async () => {
    const telemetry = await startClientTelemetry(ENABLED, {
      loadSdk: () => Promise.reject(new Error('network down')),
      buildSha: SHA,
    });
    expect(telemetry).toBeDefined();
    expect(() => exerciseAll(telemetry)).not.toThrow();
  });

  it('T-P1-resolves: the returned promise NEVER rejects, whatever the loader does', async () => {
    // Stated as its own assertion because `await` in the two tests above would also pass if the
    // implementation rejected and some outer catch swallowed it — `.resolves` pins the shape.
    await expect(
      startClientTelemetry(ENABLED, {
        loadSdk: () => Promise.reject(new Error('boom')),
        buildSha: SHA,
      }),
    ).resolves.toBeDefined();
  });
});

describe('startClientTelemetry (T-P2): a throwing instrument is swallowed, per method', () => {
  it('T-P2: every façade method survives an instrument that throws, and the next one still runs', async () => {
    // The exporter/instrument surface is third-party code running inside the frame loop and
    // inside the enqueueMove promise chain. WRONG IMPL KILLED: removing the per-method try/catch
    // "because the SDK does not throw". A throw from `record()` inside the rAF body reaches the
    // frame handler's catch, which logs — 60 times a second; a throw inside the sendIntent
    // `.then` lands in the rejection `.catch`, which calls `predictor.dropRejected` on a
    // SUCCESSFUL move: a manufactured desync (plan anti-pattern 8).
    const total = spyConsole();
    const harness = makeHarness({ throwOnCall: true });
    const telemetry = await startWith(harness);

    expect(() => exerciseAll(telemetry)).not.toThrow();
    // Anti-vacuity: the calls really were attempted (a façade that silently stopped calling
    // instruments after the first throw would also "not throw").
    expect(harness.calls.length, 'each method must still attempt its record/add').toBeGreaterThan(
      5,
    );
    expect(total(), 'a throwing instrument must not turn into console noise').toBe(0);
  });
});

describe('startClientTelemetry (AM10/AM15): one frozen attribute object, no fan-out', () => {
  it('AM10: the attrs passed to record()/add() are the SAME frozen object buildAttributes returned', async () => {
    // AM10. WRONG IMPL KILLED: a spread-and-append call site —
    //   `h.record(v, { ...attrs, reason: 'divergence' })` / `{ ...attrs, seq }`.
    //   Each spread creates a NEW object, so reference identity across calls is the mechanical
    //   detector; and each appended key is a new label that Alloy deletes (silently) or, worse,
    //   a per-datapoint value that would mint a series if the allowlist ever widened. Reference
    //   identity makes the "one attribute object per zone" claim structural.
    const harness = makeHarness();
    const telemetry = await startWith(harness, { hints: IPHONE_HINTS });
    telemetry.setZone(3);
    exerciseAll(telemetry);

    expect(harness.calls.length).toBeGreaterThan(0);
    const first = harness.calls[0]?.attributes as Readonly<Record<string, string>>;
    for (const call of harness.calls) {
      // NOTE: exerciseAll ends with setZone(1), which legitimately rebuilds the object — but it
      // records nothing itself, so every call captured here predates the rebuild.
      expect(
        call.attributes,
        `${call.instrument}.${call.method} must pass the SHARED attribute object, not a copy`,
      ).toBe(first);
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual(buildAttributes({ zoneId: 3, buildSha: SHA, deviceClass: 'mobile' }));
  });

  it('AM10-device: the device class is DERIVED from the injected hints (never a raw UA)', async () => {
    // Binds the shell to deviceClass.ts. WRONG IMPL KILLED: passing `navigator.userAgent`
    // straight into the attribute (OBS-35), or hard-coding 'desktop' so the dimension is
    // constant and useless.
    const harness = makeHarness();
    const telemetry = await startWith(harness, { hints: IPHONE_HINTS });
    telemetry.recordReconcile();
    expect(harness.calls[0]?.attributes.device_class).toBe('mobile');
  });

  it('AM1: setZone REBUILDS the attribute object — later datapoints carry the new zone_id', async () => {
    // AM1 (reviewer H1). WRONG IMPL KILLED (1): attributes computed once at init, so every
    //   datapoint after a zone warp is attributed to the STARTING zone — silently wrong per-zone
    //   panels, which is worse than no zone dimension at all.
    // WRONG IMPL KILLED (2): mutating the existing object (it is frozen, so the write no-ops or
    //   throws inside the guard, and every already-captured reference would change retroactively
    //   if it did not).
    const harness = makeHarness();
    const telemetry = await startWith(harness, { hints: IPHONE_HINTS });

    telemetry.setZone(0);
    telemetry.recordReconcile();
    const before = harness.calls[0]?.attributes as Readonly<Record<string, string>>;

    telemetry.setZone(1);
    telemetry.recordReconcile();
    const after = harness.calls[1]?.attributes as Readonly<Record<string, string>>;

    expect(before.zone_id).toBe('0');
    expect(after.zone_id).toBe('1');
    expect(after).not.toBe(before);
    expect(before.zone_id, 'the earlier object must not have been mutated').toBe('0');
    expect(Object.isFrozen(after)).toBe(true);
  });

  it('AM15: recordFrameSample performs EXACTLY two instrument calls — fps and frame-time-max', async () => {
    // AM15. WRONG IMPL KILLED (1): fan-out — a third "frames counted" counter, or an
    //   avg/min/max trio. This runs once a second for every player; each extra instrument is
    //   another series per attribute combination on a public ingest.
    // WRONG IMPL KILLED (2): recording the fps value into BOTH histograms (a copy-paste slip).
    //   The values are pinned, not just the count.
    const harness = makeHarness();
    const telemetry = await startWith(harness);

    telemetry.recordFrameSample({ fps: 58.25, maxFrameMs: 34 });

    expect(harness.calls).toHaveLength(2);
    expect(harness.calls.map((c) => `${c.instrument}:${c.method}:${c.value}`).sort()).toEqual(
      [`${METRIC_FPS}:record:58.25`, `${METRIC_FRAME_TIME_MAX_MS}:record:34`].sort(),
    );
  });

  it('each façade method drives exactly its own instrument, with the right value and method', async () => {
    // The routing table, stated once. WRONG IMPL KILLED: recordCorrection incrementing
    // `mr_client_reconcile` (or vice versa) — the prediction-divergence rate
    // `rate(correction)/rate(reconcile)` would then read 1.0 or 0.0 forever, and the number is
    // plausible enough that nobody would question it.
    const harness = makeHarness();
    const telemetry = await startWith(harness);

    telemetry.recordReconcile();
    telemetry.recordCorrection();
    telemetry.recordIntentReject();
    telemetry.recordRtt(37);
    telemetry.recordWasmReady(1500);
    telemetry.recordInterpGap(240);

    expect(harness.calls.map((c) => [c.instrument, c.method, c.value])).toEqual([
      [METRIC_RECONCILE, 'add', 1],
      [METRIC_RECONCILE_CORRECTION, 'add', 1],
      [METRIC_INTENT_REJECT, 'add', 1],
      [METRIC_REDUCER_RTT_MS, 'record', 37],
      [METRIC_WASM_READY_MS, 'record', 1500],
      [METRIC_INTERP_GAP_MS, 'record', 240],
    ]);
  });

  it('recordInterpGap(undefined) records NOTHING — a solo player is not a 0ms gap', async () => {
    // The other half of AM2's "zero remotes ⇒ no sample". WRONG IMPL KILLED: `record(gap ?? 0)`,
    // which floods `mr_client_interp_gap_ms` with zeros from every solo session and drags the
    // whole distribution down — the histogram would say remote interpolation is perfect exactly
    // when there are no remotes to interpolate.
    const harness = makeHarness();
    const telemetry = await startWith(harness);

    telemetry.recordInterpGap(undefined);
    expect(harness.calls).toHaveLength(0);
  });
});
