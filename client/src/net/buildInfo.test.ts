// net/buildInfo.test.ts — RED tests for pt-a1-2/-3: build info stamp.
//
// SOURCE OF TRUTH: pt-a1 EARS criteria pt-a1-2 and pt-a1-3
//
// EARS criterion pt-a1-2 (buildInfoFrom):
//   buildInfoFrom(sha, builtAt, isDev) maps isDev→mode (true→'dev',
//   false→'production') and passes sha/builtAt through unchanged.
//
// EARS criterion pt-a1-3 (formatBuildStamp):
//   formatBuildStamp(info) is a PURE TOTAL function producing a human string
//   that contains the sha AND the mode, so the F9 bug bundle / on-screen stamp
//   truthfully identify the build. Must be non-empty even for fallback
//   ('unknown') sha values.
//
// NOTE: `BUILD_INFO` (module-level const) is intentionally NOT tested here —
// it reads build-time injected globals (import.meta.env.*) which are unavailable
// in the vitest environment. Only buildInfoFrom + formatBuildStamp are tested.
//
// RED REASON: `buildInfo.ts` does not exist yet. Every import will fail with
// "does not provide an export named ..." until the implementer creates
// `client/src/net/buildInfo.ts` exporting `BuildInfo`, `buildInfoFrom`,
// `formatBuildStamp`, and `BUILD_INFO`.
//
// WRONG IMPL KILLED (each test states which wrong impl it kills):
//   [B1] A mode/sha swap or a hardcoded mode value.
//   [B2] A stamp that drops the sha or the mode string.
//   [B3] An impl that renders empty/blank when sha is 'unknown' (the git-absent fallback).
//   [B4] A non-total formatBuildStamp that throws on unusual input.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildInfoFrom, formatBuildStamp } from './buildInfo';

// ---------------------------------------------------------------------------
// B1: buildInfoFrom — mode mapping + field pass-through
// ---------------------------------------------------------------------------

describe('buildInfoFrom: maps isDev to mode, passes sha/builtAt through', () => {
  it('B1a: isDev=false → mode "production"', () => {
    // WRONG IMPL KILLED: an impl that always returns mode='dev' or swaps the flag.
    const info = buildInfoFrom('abc1234', '2026-07-19T00:00:00Z', false);
    expect(info.mode).toBe('production');
  });

  it('B1b: isDev=true → mode "dev"', () => {
    // WRONG IMPL KILLED: an impl that always returns mode='production' or swaps the flag.
    const info = buildInfoFrom('abc1234', '2026-07-19T00:00:00Z', true);
    expect(info.mode).toBe('dev');
  });

  it('B1c: sha is passed through unchanged', () => {
    // WRONG IMPL KILLED: an impl that truncates, hashes, or transforms the sha.
    const info = buildInfoFrom('deadbeef01234567', '2026-07-19T00:00:00Z', false);
    expect(info.sha).toBe('deadbeef01234567');
  });

  it('B1d: builtAt is passed through unchanged', () => {
    // WRONG IMPL KILLED: an impl that reformats or re-parses the timestamp.
    const info = buildInfoFrom('abc1234', '2026-07-19T12:34:56Z', true);
    expect(info.builtAt).toBe('2026-07-19T12:34:56Z');
  });

  it('B1e: full object shape matches BuildInfo for isDev=false', () => {
    // WRONG IMPL KILLED: an impl that omits any field or adds extra ones that
    // break the BuildInfo interface shape expected by formatBuildStamp.
    const info = buildInfoFrom('abc1234', '2026-07-19T00:00:00Z', false);
    expect(info).toEqual({
      sha: 'abc1234',
      builtAt: '2026-07-19T00:00:00Z',
      mode: 'production',
    });
  });

  it('B1f: full object shape matches BuildInfo for isDev=true', () => {
    // WRONG IMPL KILLED: same as B1e but for dev mode.
    const info = buildInfoFrom('abc1234', '2026-07-19T00:00:00Z', true);
    expect(info).toEqual({
      sha: 'abc1234',
      builtAt: '2026-07-19T00:00:00Z',
      mode: 'dev',
    });
  });

  it('B1g: "unknown" sha passes through — git-absent fallback is preserved', () => {
    // WRONG IMPL KILLED: an impl that replaces 'unknown' with a default or empty string.
    const info = buildInfoFrom('unknown', 'unknown', true);
    expect(info.sha).toBe('unknown');
    expect(info.builtAt).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// B2: formatBuildStamp — stamp contains sha AND mode
// ---------------------------------------------------------------------------

describe('formatBuildStamp: stamp contains sha and mode', () => {
  it('B2a: production stamp includes sha "abc1234" and "production"', () => {
    // WRONG IMPL KILLED: a stamp that drops the sha, or one that always says 'dev'.
    const stamp = formatBuildStamp({
      sha: 'abc1234',
      builtAt: '2026-07-19T00:00:00Z',
      mode: 'production',
    });
    expect(stamp).toContain('abc1234');
    expect(stamp).toContain('production');
  });

  it('B2b: dev stamp includes sha "deadbeef" and "dev"', () => {
    // WRONG IMPL KILLED: a stamp that drops the sha, or one that always says 'production'.
    const stamp = formatBuildStamp({
      sha: 'deadbeef',
      builtAt: '2026-07-19T00:00:00Z',
      mode: 'dev',
    });
    expect(stamp).toContain('deadbeef');
    expect(stamp).toContain('dev');
  });

  it('B2c: stamp is a non-empty string', () => {
    // WRONG IMPL KILLED: an impl returning '' or undefined.
    const stamp = formatBuildStamp({
      sha: 'abc1234',
      builtAt: '2026-07-19T00:00:00Z',
      mode: 'production',
    });
    expect(typeof stamp).toBe('string');
    expect(stamp.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// B3: formatBuildStamp — fallback 'unknown' values must not produce blank stamp
// ---------------------------------------------------------------------------

describe('formatBuildStamp: fallback unknown sha/builtAt renders non-empty', () => {
  it('B3: { sha: "unknown", builtAt: "unknown", mode: "dev" } → non-empty string containing "unknown"', () => {
    // WRONG IMPL KILLED: an impl that short-circuits on 'unknown' and returns ''
    // or omits the sha — the F9 bug bundle must never embed a blank build id.
    const stamp = formatBuildStamp({ sha: 'unknown', builtAt: 'unknown', mode: 'dev' });
    expect(stamp.length).toBeGreaterThan(0);
    expect(stamp).toContain('unknown');
  });

  it('B3b: { sha: "unknown", builtAt: "unknown", mode: "production" } → non-empty, contains "unknown"', () => {
    // WRONG IMPL KILLED: same but in production mode — fallback must still render.
    const stamp = formatBuildStamp({ sha: 'unknown', builtAt: 'unknown', mode: 'production' });
    expect(stamp.length).toBeGreaterThan(0);
    expect(stamp).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// B4: formatBuildStamp is total — never throws, always non-empty, always has sha
// ---------------------------------------------------------------------------

describe('formatBuildStamp property (B4): total function for arbitrary inputs', () => {
  it('B4: never throws, always non-empty string, always contains the sha', () => {
    // WRONG IMPL KILLED: any impl that throws on unusual sha/builtAt strings, or
    // returns empty string, or omits the sha from the formatted output.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 0, maxLength: 40 }),
        fc.constantFrom('dev' as const, 'production' as const),
        (sha, builtAt, mode) => {
          let stamp: string;
          expect(() => {
            stamp = formatBuildStamp({ sha, builtAt, mode });
          }).not.toThrow();
          // Use the captured value — it is always assigned after the above
          expect(stamp!.length).toBeGreaterThan(0);
          expect(stamp!).toContain(sha);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Round-trip: buildInfoFrom → formatBuildStamp
// ---------------------------------------------------------------------------

describe('buildInfoFrom → formatBuildStamp round-trip', () => {
  it('stamp from buildInfoFrom(sha, builtAt, false) contains sha and "production"', () => {
    // WRONG IMPL KILLED: a mismatch between buildInfoFrom output shape and
    // formatBuildStamp expected input that causes the pipeline to produce wrong output.
    const info = buildInfoFrom('f00dcafe', '2026-07-19T00:00:00Z', false);
    const stamp = formatBuildStamp(info);
    expect(stamp).toContain('f00dcafe');
    expect(stamp).toContain('production');
  });

  it('stamp from buildInfoFrom(sha, builtAt, true) contains sha and "dev"', () => {
    // WRONG IMPL KILLED: same but for dev mode.
    const info = buildInfoFrom('f00dcafe', '2026-07-19T00:00:00Z', true);
    const stamp = formatBuildStamp(info);
    expect(stamp).toContain('f00dcafe');
    expect(stamp).toContain('dev');
  });
});
