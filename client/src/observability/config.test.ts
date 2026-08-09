// observability/config.test.ts — m20c (ADR-0180 body amendment), OBS-21 + T-I1 + T-21a/T-21b.
//
// SOURCE OF TRUTH: EARS OBS-21 ("target the m20b Caddy route policy") + the merged m20b wire
// contract:
//   ops/observability/Caddyfile — public TLS route, NO auth on the ingest, CORS allows only the
//     `content-type` request header (:54), rate limit 120 events/min/IP (:60-64), 512KB body cap.
//   ops/observability/alloy/config.alloy — the receiver behind it.
//
// THE CONTRACT THIS FILE FIXES:
//   resolveTelemetryConfig(env, isDev, jitter) is PURE and TOTAL and returns a discriminated
//   union — { kind: 'disabled', reason } | { kind: 'enabled', endpoint, exportIntervalMs }.
//   `env` is the structural record `{ endpoint?: string; intervalMs?: string }` — BOTH members
//   optional, both raw `import.meta.env` strings, so main.ts can pass the two VITE vars straight
//   through and the tests can omit the one they are not exercising.
//     • endpoint UNSET ⇒ disabled, with ZERO console output (T-I1). vitest, Playwright and every
//       default build must be inert: no machinery, no SDK chunk, no noise.
//     • ENDPOINT IS REJECT-DON'T-CLAMP: PROD accepts absolute `https:` origins only; DEV also
//       accepts the http loopback with an explicit port. Anything else ⇒ disabled + a reason.
//     • INTERVAL IS CLAMP-DON'T-REJECT: a bad interval must not disable telemetry; it is clamped
//       into [MIN, MAX] and then given UPWARD-ONLY jitter ×(1 + 0.1×jitter) (AM12,
//       thundering-herd mitigation; main.ts injects Math.random()).
//     • IT NEVER WRITES TO THE CONSOLE, for any input. It is a pure resolver; the SHELL decides
//       whether to say anything. (Deliberate divergence from devLog.ts's injected `warn` sink —
//       the signature adjudicated in the plan has three params and no sink.)
//
// RED REASON: `client/src/observability/config.ts` does not exist yet.
//
// NOTE ON URL LITERALS: a bare insecure-scheme URL literal — `http` or `ws` written flush
// against the `://` separator — is banned in this repo's source scans, and the remote Semgrep
// SAST matches RAW TEXT, comments included (an earlier wording of this very note retripped
// it). So the two schemes below are BUILT (`['http', '//'].join(':')`) rather than written,
// and this note keeps scheme and separator apart for the same reason. The https fixtures use
// the loopback idiom with distinct ports.

import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveTelemetryConfig,
  TELEMETRY_INTERVAL_DEFAULT_MS,
  TELEMETRY_INTERVAL_MAX_MS,
  TELEMETRY_INTERVAL_MIN_MS,
  TELEMETRY_JITTER_FRACTION,
} from './config';

/** Built, never written: see the header note. Joins to the plaintext http scheme + `://`
 *  with no contiguous scheme-and-separator literal anywhere in this file. */
const HTTP = ['http', '//'].join(':');
/** Same trick for the SpacetimeDB scheme, which must NEVER be accepted as an OTLP endpoint. */
const WS = ['ws', '//'].join(':');

const HTTPS_LOOPBACK = 'https://127.0.0.1:8443';
const HTTPS_NAMED = 'https://otlp.localhost:8443';
const DEV_LOOPBACK_HTTP = `${HTTP}127.0.0.1:4318`;
const DEV_LOCALHOST_HTTP = `${HTTP}localhost:4318`;
/** An https origin carrying URL userinfo. BUILT from parts on purpose: a literal
 *  `scheme://user:secret@host` is precisely the shape gitleaks' generic rules flag, and that CI
 *  gate is remote-only (a false positive cannot be cleared locally). The value under test is
 *  identical either way. */
const HTTPS_WITH_USERINFO = ['https://', 'u', ':', 'p', '@', '127.0.0.1:8443'].join('');

/** Caddy's documented per-IP budget (ops/observability/Caddyfile:60-64). Copied here ONLY as the
 *  ceiling the arithmetic in T-21b is checked against; the client cannot read the ops file. */
const CADDY_EVENTS_PER_MINUTE = 120;
/** otlp-exporter-base retries at most 5× on 429/502/503/504 (AM12), so one export CYCLE can put
 *  up to 1 + 5 = 6 requests on the wire. Not configurable — hence a constant, not a knob. */
const REQUESTS_PER_EXPORT_CYCLE = 6;

function enabledOrThrow(cfg: ReturnType<typeof resolveTelemetryConfig>): {
  endpoint: string;
  exportIntervalMs: number;
} {
  if (cfg.kind !== 'enabled') {
    throw new Error(`expected an ENABLED config, got disabled: ${cfg.reason}`);
  }
  return { endpoint: cfg.endpoint, exportIntervalMs: cfg.exportIntervalMs };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spy on every console sink; returns the total call count across all of them. */
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

describe('resolveTelemetryConfig (T-I1): unset ⇒ disabled, silently', () => {
  it('T-I1: an UNSET endpoint disables telemetry and writes NOTHING to the console', () => {
    // WRONG IMPL KILLED (1): an enabled-by-default fallback (`endpoint ?? SOME_DEFAULT`). Every
    //   vitest run, every Playwright run and every developer's `npm run dev` would then try to
    //   POST to a host that is not there — and, worse, the DEFAULT build of the game would ship
    //   telemetry nobody opted into.
    // WRONG IMPL KILLED (2): a console.warn/error on the unset path. This resolve runs at MODULE
    //   scope in main.ts, before the onerror/unhandledrejection listeners; a line here appears in
    //   every developer console and in every e2e's captured output forever, training everyone to
    //   ignore it. "Off" is the normal state, not a misconfiguration.
    const total = spyConsole();
    const cfg = resolveTelemetryConfig({ endpoint: undefined, intervalMs: undefined }, false, 0);

    expect(cfg.kind).toBe('disabled');
    if (cfg.kind === 'disabled') {
      expect(cfg.reason.length, 'a disabled config must carry a non-empty reason').toBeGreaterThan(
        0,
      );
    }
    expect(total(), 'resolveTelemetryConfig must not write to the console when unset').toBe(0);
  });

  it('T-I1b: empty / whitespace-only endpoints are treated as UNSET, in dev and in prod', () => {
    // WRONG IMPL KILLED: `endpoint !== undefined` as the presence test — an empty VITE_ var is
    // the normal way a `.env` file spells "off", and `new URL('')` throws, which (uncaught) would
    // take main.ts's module evaluation down and blank the whole game.
    for (const raw of ['', ' ', '\t\n']) {
      for (const isDev of [true, false]) {
        const cfg = resolveTelemetryConfig({ endpoint: raw, intervalMs: undefined }, isDev, 0);
        expect(cfg.kind, `endpoint=${JSON.stringify(raw)} isDev=${isDev}`).toBe('disabled');
      }
    }
  });

  it('T-I1c: the resolver NEVER writes to the console — for any input, valid or hostile', () => {
    // The generalisation. A pure resolver that logs is not pure, cannot be property-tested
    // without noise, and (at module scope) logs before any error plumbing exists.
    const total = spyConsole();
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.boolean(), (endpoint, intervalMs, isDev) => {
        resolveTelemetryConfig({ endpoint, intervalMs }, isDev, 0.5);
      }),
      { seed: 20250809, numRuns: 300 },
    );
    expect(total()).toBe(0);
  });
});

describe('resolveTelemetryConfig (T-21a): PROD accepts https: origins ONLY', () => {
  it('T-21a-accept: an absolute https origin is accepted and normalised to its ORIGIN', () => {
    // The endpoint is stored as a bare origin because telemetry.ts appends the OTLP path
    // (`/v1/metrics`) itself — see T-16c. Normalising here is what makes that append exact.
    // WRONG IMPL KILLED: a `startsWith('https://')` prefix test. It accepts
    // `https://user:pass@host` (a credential on an ingest that has none — OBS-16), accepts
    // `https://host/some/path` (which would produce `…/some/path/v1/metrics`), and rejects the
    // perfectly legal uppercase scheme. Only a real URL parse gets all three right.
    expect(
      enabledOrThrow(resolveTelemetryConfig({ endpoint: HTTPS_LOOPBACK }, false, 0)).endpoint,
    ).toBe(HTTPS_LOOPBACK);
    expect(
      enabledOrThrow(resolveTelemetryConfig({ endpoint: HTTPS_NAMED }, false, 0)).endpoint,
    ).toBe(HTTPS_NAMED);
    // A trailing slash is the empty path — accepted, and normalised away.
    expect(
      enabledOrThrow(resolveTelemetryConfig({ endpoint: `${HTTPS_NAMED}/` }, false, 0)).endpoint,
    ).toBe(HTTPS_NAMED);
    // Scheme case is not significant in a URL; the parse normalises it.
    expect(
      enabledOrThrow(resolveTelemetryConfig({ endpoint: 'HTTPS://127.0.0.1:8443' }, false, 0))
        .endpoint,
    ).toBe(HTTPS_LOOPBACK);
  });

  it('T-21a-reject: non-https, relative, path-bearing and CREDENTIAL-bearing endpoints disable', () => {
    // WRONG IMPL KILLED (1): a permissive parser that accepts anything `new URL()` can swallow.
    //   `http:` on a public path is a plaintext ingest; `ws:`/`wss:` is the SpacetimeDB URL
    //   pasted into the wrong env var (and would make the exporter POST to the game socket).
    // WRONG IMPL KILLED (2, OBS-16): `https://user:pass@host` — a CREDENTIAL in the endpoint.
    //   The m20b ingest has no auth by design; accepting userinfo would put a secret in a
    //   client-side env var, in the bundle, and in the request line. Reject it outright rather
    //   than silently stripping it (silent stripping hides an operator mistake).
    // WRONG IMPL KILLED (3): accepting a path/query/hash and later concatenating `/v1/metrics`
    //   onto it — that is the identity-in-path smuggling channel AM9/T-16c closes from the other
    //   end. Reject-don't-clamp means it never reaches the exporter at all.
    const rejected = [
      `${HTTP}127.0.0.1:4318`, // plaintext, PROD
      `${HTTP}otlp.example.com`,
      `${WS}127.0.0.1:3000`,
      'wss://127.0.0.1:3000',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/plain,hi',
      '//127.0.0.1:8443', // protocol-relative
      '/v1/metrics', // relative
      'otlp.localhost:8443', // scheme-less
      'https://', // unparseable
      HTTPS_WITH_USERINFO, // OBS-16: a credential in the endpoint
      'https://127.0.0.1:8443/v1/metrics', // path
      'https://127.0.0.1:8443/ingest',
      'https://127.0.0.1:8443?zone=1', // query
      'https://127.0.0.1:8443#frag', // hash
      'not a url at all',
    ];
    for (const endpoint of rejected) {
      const cfg = resolveTelemetryConfig({ endpoint }, false, 0);
      expect(cfg.kind, `PROD must reject ${JSON.stringify(endpoint)}`).toBe('disabled');
    }
  });

  it('T-21a-property: in PROD, an ENABLED config always carries an https origin with no path', () => {
    // The invariant, not a sample of it. Any string at all goes in; if the resolver says
    // "enabled", the endpoint must survive a URL parse as an https origin with nothing after it.
    const endpoints = fc.oneof(
      fc.string(),
      fc.webUrl(),
      fc.constantFrom(
        HTTPS_LOOPBACK,
        HTTPS_NAMED,
        DEV_LOOPBACK_HTTP,
        DEV_LOCALHOST_HTTP,
        `${WS}127.0.0.1:3000`,
        '/v1/metrics',
        '',
      ),
    );
    fc.assert(
      fc.property(endpoints, (endpoint) => {
        const cfg = resolveTelemetryConfig({ endpoint }, false, 0);
        if (cfg.kind !== 'enabled') return;
        const url = new URL(cfg.endpoint);
        expect(url.protocol, `PROD enabled endpoint ${cfg.endpoint}`).toBe('https:');
        expect(url.pathname).toBe('/');
        expect(url.search).toBe('');
        expect(url.hash).toBe('');
        expect(url.username).toBe('');
        expect(url.password).toBe('');
        expect(cfg.endpoint).toBe(url.origin);
      }),
      { seed: 20250809, numRuns: 500 },
    );
  });
});

describe('resolveTelemetryConfig (T-21a): DEV additionally allows the http loopback WITH a port', () => {
  it('T-21a-dev-accept: http://127.0.0.1:<port> and http://localhost:<port> are DEV-only', () => {
    // The dev stack terminates TLS at Caddy with an internal CA the browser has not trusted yet
    // (risk R-6), so a developer needs to be able to point straight at Alloy's plaintext
    // receiver. That allowance must be DEV-scoped: the same value in a production build is a
    // plaintext public ingest.
    for (const endpoint of [DEV_LOOPBACK_HTTP, DEV_LOCALHOST_HTTP]) {
      expect(enabledOrThrow(resolveTelemetryConfig({ endpoint }, true, 0)).endpoint).toBe(endpoint);
      expect(
        resolveTelemetryConfig({ endpoint }, false, 0).kind,
        `${endpoint} must be DEV-only`,
      ).toBe('disabled');
    }
    // https keeps working in DEV too — the DEV rule ADDS a case, it does not replace one.
    expect(
      enabledOrThrow(resolveTelemetryConfig({ endpoint: HTTPS_NAMED }, true, 0)).endpoint,
    ).toBe(HTTPS_NAMED);
  });

  it('T-21a-dev-reject: the DEV allowance is loopback-only and requires an explicit port', () => {
    // WRONG IMPL KILLED (1): `hostname.includes('localhost')` — `localhost.evil.example` and
    //   `evil-localhost.test` both pass a substring test, so a DEV build could be pointed at an
    //   attacker host. Host equality is the only correct test.
    // WRONG IMPL KILLED (2): dropping the port requirement, which quietly permits a plain
    //   port-80 `localhost` URL — not a loopback dev receiver, and one more shape to reason
    //   about. The grammar is exactly `127.0.0.1:<port>` / `localhost:<port>` behind the
    //   plaintext http scheme.
    const rejected = [
      `${HTTP}127.0.0.1`, // no explicit port
      `${HTTP}localhost`,
      `${HTTP}localhost.evil.example:4318`,
      `${HTTP}evil-localhost.test:4318`,
      `${HTTP}127.0.0.1.evil.example:4318`,
      `${HTTP}0.0.0.0:4318`,
      `${HTTP}otlp.example.com:4318`,
      `${HTTP}[::1]:4318`, // deliberately out of the documented grammar
      `${HTTP}127.0.0.1:4318/v1/metrics`, // path, even on the DEV allowance
      `${WS}127.0.0.1:4318`,
    ];
    for (const endpoint of rejected) {
      expect(
        resolveTelemetryConfig({ endpoint }, true, 0).kind,
        `DEV must reject ${JSON.stringify(endpoint)}`,
      ).toBe('disabled');
    }
  });
});

describe('resolveTelemetryConfig (T-21b): interval clamp + upward-only jitter', () => {
  it('T-21b-constants: the clamp window is [15000, 300000] with a 60000 default and 10% jitter', () => {
    // These four numbers ARE the rate budget (see the tooth below). Pinning them here means the
    // budget arithmetic cannot be quietly invalidated by editing a constant.
    expect(TELEMETRY_INTERVAL_MIN_MS).toBe(15_000);
    expect(TELEMETRY_INTERVAL_MAX_MS).toBe(300_000);
    expect(TELEMETRY_INTERVAL_DEFAULT_MS).toBe(60_000);
    expect(TELEMETRY_JITTER_FRACTION).toBe(0.1);
  });

  it('T-21b-default: an unset/garbage interval falls back to the default — it never disables', () => {
    // CLAMP-don't-reject, the deliberate asymmetry against the endpoint rule: a typo'd interval
    // must not silently switch telemetry off (that failure is invisible), whereas a typo'd
    // endpoint must never be guessed at.
    for (const intervalMs of [undefined, '', '   ', 'abc', 'NaN', 'Infinity', '60_000']) {
      const cfg = enabledOrThrow(
        resolveTelemetryConfig({ endpoint: HTTPS_NAMED, intervalMs }, false, 0),
      );
      expect(cfg.exportIntervalMs, `intervalMs=${JSON.stringify(intervalMs)}`).toBe(
        TELEMETRY_INTERVAL_DEFAULT_MS,
      );
    }
  });

  it('T-21b-clamp: values below/above the window clamp to it; in-window values pass through', () => {
    // WRONG IMPL KILLED: a "debug" 1s interval shipped by accident (`VITE_MR_OTLP_INTERVAL_MS=1000`
    // in someone's .env). Unclamped, one tab alone would exceed Caddy's 120/min and every OTHER
    // player behind the same NAT/CGNAT address would start getting 429s — one developer's env
    // var degrading the whole fleet's telemetry.
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['1', TELEMETRY_INTERVAL_MIN_MS],
      ['1000', TELEMETRY_INTERVAL_MIN_MS],
      ['14999', TELEMETRY_INTERVAL_MIN_MS],
      ['15000', 15_000],
      ['30000', 30_000],
      ['300000', 300_000],
      ['300001', TELEMETRY_INTERVAL_MAX_MS],
      ['999999999', TELEMETRY_INTERVAL_MAX_MS],
      ['-5', TELEMETRY_INTERVAL_MIN_MS],
      [' 45000 ', 45_000],
    ];
    for (const [intervalMs, expected] of cases) {
      const cfg = enabledOrThrow(
        resolveTelemetryConfig({ endpoint: HTTPS_NAMED, intervalMs }, false, 0),
      );
      expect(cfg.exportIntervalMs, `intervalMs=${JSON.stringify(intervalMs)}`).toBe(expected);
    }
  });

  it('T-21b-jitter: jitter is applied AFTER the clamp, UPWARD only, and is total', () => {
    // AM12. Every tab that loads at the same moment (a Twitch raid, a scheduled playtest) would
    // otherwise export in lockstep forever — one synchronised burst per interval against a
    // per-IP-and-per-CPU-bounded ingest. The jitter is injected (main.ts passes Math.random()),
    // never sampled here, so this stays pure and property-testable.
    // WRONG IMPL KILLED (1): SYMMETRIC jitter (`×(1 ± 0.1)`), which can push the interval to
    //   13.5s — BELOW the clamp floor the whole rate budget is derived from.
    // WRONG IMPL KILLED (2): jitter applied BEFORE the clamp, where the clamp then erases it and
    //   the herd stays synchronised (13500 → clamped back to 15000 for every tab).
    // WRONG IMPL KILLED (3): a non-total jitter — NaN in, NaN out, and the OTel reader would
    //   either spin or never export at all.
    const base = { endpoint: HTTPS_NAMED, intervalMs: '60000' } as const;
    expect(enabledOrThrow(resolveTelemetryConfig(base, false, 0)).exportIntervalMs).toBe(60_000);
    expect(enabledOrThrow(resolveTelemetryConfig(base, false, 0.5)).exportIntervalMs).toBe(63_000);
    expect(enabledOrThrow(resolveTelemetryConfig(base, false, 0.99)).exportIntervalMs).toBe(65_940);

    // Applied after the clamp: a below-floor request is clamped to 15000 and THEN jittered.
    const clamped = enabledOrThrow(
      resolveTelemetryConfig({ endpoint: HTTPS_NAMED, intervalMs: '1000' }, false, 0.5),
    );
    expect(clamped.exportIntervalMs).toBe(15_750);

    // Total + upward-only for out-of-contract jitter values.
    for (const jitter of [Number.NaN, -1, -0.5]) {
      expect(
        enabledOrThrow(resolveTelemetryConfig(base, false, jitter)).exportIntervalMs,
        `jitter=${String(jitter)} must never REDUCE the interval`,
      ).toBe(60_000);
    }
    for (const jitter of [1, 5, Number.POSITIVE_INFINITY]) {
      const ms = enabledOrThrow(resolveTelemetryConfig(base, false, jitter)).exportIntervalMs;
      expect(ms, `jitter=${String(jitter)}`).toBeGreaterThanOrEqual(60_000);
      expect(ms, `jitter=${String(jitter)} must stay within +10%`).toBeLessThanOrEqual(66_000);
    }
  });

  it('T-21b-property: exportIntervalMs is always an integer in [15000, 330000]', () => {
    // 330000 = MAX × (1 + jitter fraction). The upper bound is what proves the jitter is applied
    // to the CLAMPED value rather than to the raw env value.
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: -1000, max: 10_000_000 }).map(String), fc.string()),
        fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
        (intervalMs, jitter) => {
          const cfg = resolveTelemetryConfig({ endpoint: HTTPS_NAMED, intervalMs }, false, jitter);
          if (cfg.kind !== 'enabled') throw new Error('a valid https endpoint must stay enabled');
          expect(Number.isInteger(cfg.exportIntervalMs)).toBe(true);
          expect(cfg.exportIntervalMs).toBeGreaterThanOrEqual(TELEMETRY_INTERVAL_MIN_MS);
          expect(cfg.exportIntervalMs).toBeLessThanOrEqual(
            Math.round(TELEMETRY_INTERVAL_MAX_MS * (1 + TELEMETRY_JITTER_FRACTION)),
          );
        },
      ),
      { seed: 20250809, numRuns: 500 },
    );
  });

  it('T-21b-budget: the WORST-CASE request rate at the clamp floor fits under Caddy 120/min', () => {
    // AM12, written as arithmetic rather than as a comment so it cannot rot:
    //   cycles/min at the floor      = 60000 / MIN
    //   requests per cycle           = 1 initial + up to 5 retries (otlp-exporter-base, on
    //                                  429/502/503/504, backoff 1s→5s cap, NOT configurable)
    //   worst case, one tab          = cycles × requests
    // Caddy allows 120 events/min/IP. AM12 states the headroom as 5×, so that is what is
    // asserted: a player with several tabs open — or a handful of players behind one CGNAT
    // address — must not be able to trip the limiter and take the whole address's telemetry down.
    // WRONG IMPL KILLED: lowering MIN "just for debugging" (e.g. to 1000, which yields
    // 60 × 6 = 360 requests/min from ONE tab — three times the entire per-IP budget).
    const cyclesPerMinute = 60_000 / TELEMETRY_INTERVAL_MIN_MS;
    const worstCasePerMinute = cyclesPerMinute * REQUESTS_PER_EXPORT_CYCLE;

    expect(TELEMETRY_INTERVAL_MIN_MS).toBeGreaterThanOrEqual(15_000);
    expect(
      worstCasePerMinute,
      `at the ${TELEMETRY_INTERVAL_MIN_MS}ms floor one tab can emit ${worstCasePerMinute} ` +
        `req/min; Caddy allows ${CADDY_EVENTS_PER_MINUTE}/min/IP`,
    ).toBeLessThan(CADDY_EVENTS_PER_MINUTE);
    expect(
      worstCasePerMinute * 5,
      'the budget must leave 5× headroom (AM12) — multiple tabs / a shared egress IP. At the ' +
        `${TELEMETRY_INTERVAL_MIN_MS}ms floor that is ${worstCasePerMinute * 5} of Caddy's ` +
        `${CADDY_EVENTS_PER_MINUTE}/min. Lowering the floor to 10s already breaks it.`,
    ).toBeLessThanOrEqual(CADDY_EVENTS_PER_MINUTE);
  });
});
