// observability/config.ts — m20c (ADR-0180 body amendment), OBS-21.
//
// Pure, total resolver for the two VITE telemetry vars. Discriminated union out — an illegal
// combination is unrepresentable, and the shell branches on `kind` alone.
//
//   endpoint  — REJECT-don't-clamp. PROD accepts absolute `https:` origins only (no path, no
//               query, no fragment, no URL userinfo — the m20b ingest takes no secret of any
//               kind, and a rejected shape must never be "helpfully" repaired). DEV additionally
//               accepts the plaintext loopback with an explicit port (`127.0.0.1`/`localhost`
//               host equality, never a substring test), because the local Caddy terminates TLS
//               with an internal CA the browser has not trusted yet.
//   interval  — CLAMP-don't-reject. A typo'd interval must not silently switch telemetry off;
//               it clamps into [MIN, MAX] and then takes UPWARD-ONLY jitter ×(1 + 0.1×j)
//               (AM12 thundering-herd de-sync; the caller injects the randomness — this module
//               never samples it, which is what keeps the formula property-testable).
//
// NEVER writes to the console, for any input: it runs at module scope in main.ts, before the
// error plumbing exists, and "off" is the normal state of every dev/test build, not an error.

export const OTLP_METRICS_PATH = '/v1/metrics';
export const TELEMETRY_INTERVAL_MIN_MS = 15_000;
export const TELEMETRY_INTERVAL_MAX_MS = 300_000;
export const TELEMETRY_INTERVAL_DEFAULT_MS = 60_000;
export const TELEMETRY_JITTER_FRACTION = 0.1;

export type TelemetryConfig =
  | { readonly kind: 'disabled'; readonly reason: string }
  | { readonly kind: 'enabled'; readonly endpoint: string; readonly exportIntervalMs: number };

/** The raw `import.meta.env` strings, passed straight through by main.ts. */
export interface TelemetryEnv {
  readonly endpoint?: string;
  readonly intervalMs?: string;
}

function disabled(reason: string): TelemetryConfig {
  return { kind: 'disabled', reason };
}

/** The DEV-only plaintext allowance: loopback host EQUALITY plus an explicit port. */
function isDevLoopback(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return false;
  return url.port !== '';
}

function resolveEndpoint(raw: string | undefined, isDev: boolean): TelemetryConfig {
  if (raw === undefined) return disabled('VITE_MR_OTLP_ENDPOINT unset — telemetry off');
  const trimmed = raw.trim();
  if (trimmed === '') return disabled('VITE_MR_OTLP_ENDPOINT empty — telemetry off');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return disabled('VITE_MR_OTLP_ENDPOINT is not an absolute URL');
  }

  if (url.username !== '' || url.password !== '') {
    // OBS-16: the ingest takes no secret; reject outright rather than silently stripping.
    return disabled('VITE_MR_OTLP_ENDPOINT carries URL userinfo');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    // The shell appends the OTLP path itself; a path here would smuggle extra segments.
    return disabled('VITE_MR_OTLP_ENDPOINT must be a bare origin (no path/query/fragment)');
  }
  const httpsOk = url.protocol === 'https:';
  const devHttpOk = isDev && isDevLoopback(url);
  if (!httpsOk && !devHttpOk) {
    return disabled('VITE_MR_OTLP_ENDPOINT must be an https origin (or a DEV loopback with port)');
  }
  return { kind: 'enabled', endpoint: url.origin, exportIntervalMs: TELEMETRY_INTERVAL_DEFAULT_MS };
}

function resolveIntervalMs(raw: string | undefined, jitter: number): number {
  let base = TELEMETRY_INTERVAL_DEFAULT_MS;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed !== '') {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) base = parsed;
    }
  }
  const clamped = Math.min(TELEMETRY_INTERVAL_MAX_MS, Math.max(TELEMETRY_INTERVAL_MIN_MS, base));
  // Upward-only, applied AFTER the clamp (a symmetric or pre-clamp jitter re-synchronises the
  // herd or dips below the floor the whole rate budget is derived from).
  const j = Number.isFinite(jitter) && jitter > 0 ? Math.min(jitter, 1) : 0;
  return Math.round(clamped * (1 + TELEMETRY_JITTER_FRACTION * j));
}

export function resolveTelemetryConfig(
  env: TelemetryEnv,
  isDev: boolean,
  jitter: number,
): TelemetryConfig {
  const endpoint = resolveEndpoint(env.endpoint, isDev);
  if (endpoint.kind === 'disabled') return endpoint;
  return {
    kind: 'enabled',
    endpoint: endpoint.endpoint,
    exportIntervalMs: resolveIntervalMs(env.intervalMs, jitter),
  };
}
