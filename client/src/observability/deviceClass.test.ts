// observability/deviceClass.test.ts — m20c (ADR-0180 body amendment), OBS-34/35 + T-35b.
//
// SOURCE OF TRUTH: EARS OBS-34/35 ("no player text / no identity in telemetry") plus the Alloy
// datapoint allowlist `device_class ^(desktop|mobile|tablet)$` (config.alloy:158).
//
// WHAT THIS MODULE IS FOR: the raw User-Agent string is a high-cardinality, fingerprint-grade
// value. It must be COLLAPSED to one of three literals INSIDE the browser, before anything is
// serialised — not filtered later by Alloy (which only sees what we already sent) and not
// "sanitised" by lowercasing. `classifyDeviceClass` is the collapse, and it must be TOTAL: any
// hints object at all, including one assembled from a hostile/spoofed UA, yields one of exactly
// three strings.
//
// HOST ACCESS IS INJECTED (AM21): vitest runs in the NODE environment (vite.config.ts:47-53), so
// this module must not read `navigator` / `window` at module scope or anywhere else. The caller
// (main.ts) reads the host and passes a plain `DeviceHints` record. sourceScan.test.ts enforces
// the absence of those globals; this file pins the pure behaviour.
//
// RED REASON: `client/src/observability/deviceClass.ts` does not exist yet.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyDeviceClass, type DeviceClass, type DeviceHints } from './deviceClass';

const CLASSES: readonly DeviceClass[] = ['desktop', 'mobile', 'tablet'];

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Mobile Safari/537.36';
const UA_ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';
const UA_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

describe('classifyDeviceClass (T-35b): a TOTAL collapse to exactly three literals', () => {
  it('T-35b-total: ANY hints object yields one of desktop|mobile|tablet — never a raw string', () => {
    // WRONG IMPL KILLED (the headline, named in the plan): `return ua.toLowerCase()` — or any
    // shape that returns a *derived* piece of the UA (`ua.split(' ')[0]`, a vendor token, a
    // version number). Each is a per-browser-build cardinality bomb AND a fingerprint field, and
    // Alloy would delete the key so nothing would look broken. The membership assertion is what
    // makes that impossible.
    // WRONG IMPL KILLED (2): a partial function — `undefined` (or a throw) for an unrecognised
    // UA. `undefined` would be stringified as "undefined" by a naive attribute builder, minting
    // a fourth class; a throw inside the telemetry init would be swallowed and silently disable
    // the whole feature.
    const hints = fc.record(
      {
        userAgent: fc.oneof(
          fc.string(),
          fc.constant(undefined),
          fc.constantFrom(UA_IPHONE, UA_IPAD, UA_ANDROID_PHONE, UA_ANDROID_TABLET, UA_WINDOWS),
        ),
        maxTouchPoints: fc.oneof(
          fc.integer({ min: -5, max: 20 }),
          fc.constant(Number.NaN),
          fc.constant(undefined),
        ),
        screenWidthPx: fc.oneof(
          fc.integer({ min: -1, max: 8000 }),
          fc.constant(Number.NaN),
          fc.constant(undefined),
        ),
        isMobileHint: fc.oneof(fc.boolean(), fc.constant(undefined)),
      },
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(hints, (h: DeviceHints) => {
        const out = classifyDeviceClass(h);
        expect(CLASSES.includes(out), `classifyDeviceClass returned ${JSON.stringify(out)}`).toBe(
          true,
        );
      }),
      { seed: 20250809, numRuns: 1000 },
    );
  });

  it('T-35b-deterministic: the same hints classify the same way twice (no clock, no RNG, no state)', () => {
    // WRONG IMPL KILLED: a classifier that consults a module-scope cache/latch seeded on first
    // call, or that samples `Math.random()`/`Date.now()` for a "sticky" bucket. Either makes the
    // attribute set differ between the first and later exports of one session, which silently
    // doubles the series count per user.
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 10 }), (ua, touch) => {
        const h: DeviceHints = { userAgent: ua, maxTouchPoints: touch };
        expect(classifyDeviceClass(h)).toBe(classifyDeviceClass(h));
      }),
      { seed: 20250809, numRuns: 300 },
    );
  });

  it('T-35b-noleak: no output ever contains text taken from the UA (a player name cannot survive)', () => {
    // OBS-35 in its most direct form. The UA is attacker-controlled and, on some platforms,
    // carries a device NAME the player chose. A classifier that ever returns UA-derived text
    // ships that name to a public ingest.
    const marker = 'Drews-Phone';
    const out = classifyDeviceClass({
      userAgent: `Mozilla/5.0 (${marker}; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari`,
      maxTouchPoints: 5,
    });
    expect(out.includes(marker)).toBe(false);
    expect(CLASSES.includes(out)).toBe(true);
  });
});

describe('classifyDeviceClass: the heuristic itself (a constant function is NOT a classifier)', () => {
  // ANTI-VACUITY for the property above: `() => "desktop"` satisfies totality, determinism and
  // no-leak perfectly. These five fixtures are the minimum that force a real decision — they are
  // the platform conventions, not invented rules: iPhone/Android-with-"Mobile" ⇒ phone,
  // iPad/Android-without-"Mobile" ⇒ tablet, plain desktop UA ⇒ desktop.
  it('T-35b-iphone: an iPhone UA classifies as mobile', () => {
    expect(classifyDeviceClass({ userAgent: UA_IPHONE, maxTouchPoints: 5 })).toBe('mobile');
  });

  it('T-35b-ipad: an iPad UA classifies as tablet (NOT mobile — the tablet arm must exist)', () => {
    // WRONG IMPL KILLED: a two-way classifier (`touch ? 'mobile' : 'desktop'`) that never emits
    // 'tablet'. The three-way split is what makes the fps SLO readable — tablet frame budgets sit
    // between phone and desktop, and folding them into 'mobile' hides a whole population.
    expect(classifyDeviceClass({ userAgent: UA_IPAD, maxTouchPoints: 5 })).toBe('tablet');
  });

  it('T-35b-android: Android WITH the `Mobile` token is a phone, WITHOUT it is a tablet', () => {
    expect(classifyDeviceClass({ userAgent: UA_ANDROID_PHONE, maxTouchPoints: 5 })).toBe('mobile');
    expect(classifyDeviceClass({ userAgent: UA_ANDROID_TABLET, maxTouchPoints: 5 })).toBe('tablet');
  });

  it('T-35b-desktop: a Windows desktop UA with no touch classifies as desktop', () => {
    expect(classifyDeviceClass({ userAgent: UA_WINDOWS, maxTouchPoints: 0 })).toBe('desktop');
  });

  it('T-35b-empty: EMPTY hints classify as desktop (the documented default, never a 4th value)', () => {
    // The pre-join / headless / UA-Client-Hints-restricted case. It must resolve to a real class
    // so the attribute is present and stable, rather than being omitted for a slice of sessions
    // (which would split every series in two).
    expect(classifyDeviceClass({})).toBe('desktop');
  });
});
