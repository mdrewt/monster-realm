// net/connectionConfig.test.ts — RED tests for pt-a1-1: connection config resolver.
//
// SOURCE OF TRUTH: pt-a1 EARS criterion pt-a1-1
//
// EARS criterion:
//   WHILE isDev===true: resolveConnectionConfig returns
//     { uri: trimmedUri || 'ws://127.0.0.1:3000', db: trimmedDb || 'monster-realm' }
//     and NEVER throws.
//   WHEN isDev===false (production): IF trimmed db is empty/unset OR exactly equals
//     the dev-default 'monster-realm', THEN throws a descriptive Error (reject-not-clamp).
//     OTHERWISE returns { uri: trimmedUri || 'ws://127.0.0.1:3000', db: trimmedDb }.
//     The URI is NOT guarded — only the DB name is the corruption vector.
//
// RED REASON: `connectionConfig.ts` does not exist yet. Every import will fail with
// "does not provide an export named ..." until the implementer creates
// `client/src/net/connectionConfig.ts` exporting `resolveConnectionConfig`.
//
// WRONG IMPL KILLED (each test states which wrong impl it kills):
//   [T1] A naive `?? default` that silently connects prod to the dev DB (no throw at all).
//   [T2] An unset-only check that misses the equals-dev-default case.
//   [T3] A check that treats empty-string as "set"; empty must be treated like unset.
//   [T4] A no-trim impl — a whitespace-padded dev-default must still be rejected.
//   [T5] An impl that throws on ALL prod calls, breaking the real playtest publish.
//   [T6] A startsWith('monster-realm') / prefix impl — guard is exact equality only.
//   [T7] An impl that fail-louds in dev mode.
//   [T8] An impl that rejects the dev DB even in dev mode.
//   [T9/T10] An impl that guards URI instead of (or in addition to) DB name.
//   [T11] Property: encodes the exact fail-loud condition + trimming rule end-to-end.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveConnectionConfig } from './connectionConfig';

const DEV_URI = 'ws://127.0.0.1:3000';
const DEV_DB = 'monster-realm';

// ---------------------------------------------------------------------------
// Production (isDev === false) — guarded cases that MUST throw
// ---------------------------------------------------------------------------

describe('resolveConnectionConfig: production — throws when db is absent or dev-default', () => {
  it('T1: {} + isDev=false MUST throw — kills naive ?? default that silently uses dev DB', () => {
    // WRONG IMPL KILLED: any impl that returns a config instead of throwing
    // when no env vars are provided in production.
    expect(() => resolveConnectionConfig({}, false)).toThrow();
  });

  it('T2: { db: "monster-realm" } + isDev=false MUST throw — kills unset-only check', () => {
    // WRONG IMPL KILLED: an impl that only throws when db is unset, but allows
    // the literal dev-default string 'monster-realm' through.
    expect(() => resolveConnectionConfig({ db: DEV_DB }, false)).toThrow();
  });

  it('T3: { db: "" } + isDev=false MUST throw — kills impl that treats empty-string as set', () => {
    // WRONG IMPL KILLED: an impl that only checks `db === undefined` or
    // `db == null`; empty string must be treated as unset.
    expect(() => resolveConnectionConfig({ db: '' }, false)).toThrow();
  });

  it('T4: { db: "  monster-realm  " } + isDev=false MUST throw — kills no-trim impl', () => {
    // WRONG IMPL KILLED: an impl that compares before trimming, so a
    // whitespace-padded dev-default sneaks through to production.
    expect(() => resolveConnectionConfig({ db: '  monster-realm  ' }, false)).toThrow();
  });

  it('T3b: { db: "   " } (whitespace-only) + isDev=false MUST throw — trims to empty', () => {
    // WRONG IMPL KILLED: an impl that only checks `db === ''` without trimming;
    // a whitespace-only string trims to empty and must be rejected.
    expect(() => resolveConnectionConfig({ db: '   ' }, false)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Production (isDev === false) — valid cases that MUST return a config
// ---------------------------------------------------------------------------

describe('resolveConnectionConfig: production — returns config for valid db names', () => {
  it('T5: { db: "monster-realm-playtest" } + isDev=false MUST return, NOT throw', () => {
    // WRONG IMPL KILLED: an impl that throws on ALL prod calls regardless of db name,
    // which would break the real playtest publish target.
    const result = resolveConnectionConfig({ db: 'monster-realm-playtest' }, false);
    expect(result).toEqual({ uri: DEV_URI, db: 'monster-realm-playtest' });
  });

  it('T6: { db: "monster-realm-old" } + isDev=false MUST return — kills prefix/startsWith guard', () => {
    // WRONG IMPL KILLED: an impl using startsWith('monster-realm') or
    // includes('monster-realm') — the guard must be exact equality, not a prefix match.
    const result = resolveConnectionConfig({ db: 'monster-realm-old' }, false);
    expect(result).toEqual({ uri: DEV_URI, db: 'monster-realm-old' });
  });

  it('T9: { uri: undefined, db: "monster-realm-playtest" } — uri falls back, db is used', () => {
    // WRONG IMPL KILLED: an impl that guards URI in production (URI must fall back
    // to dev default; only DB name is the corruption vector).
    const result = resolveConnectionConfig({ uri: undefined, db: 'monster-realm-playtest' }, false);
    expect(result).toEqual({ uri: DEV_URI, db: 'monster-realm-playtest' });
  });

  it('T10: { uri: "wss://play.example:3000", db: "monster-realm-playtest" } — custom uri passes through', () => {
    // WRONG IMPL KILLED: an impl that throws because the URI is localhost,
    // or that clamps the URI to the dev default despite an explicit value.
    const result = resolveConnectionConfig(
      { uri: 'wss://play.example:3000', db: 'monster-realm-playtest' },
      false,
    );
    expect(result).toEqual({ uri: 'wss://play.example:3000', db: 'monster-realm-playtest' });
  });

  it('trimmed db is returned (not the raw padded value)', () => {
    // WRONG IMPL KILLED: an impl that returns the raw (untrimmed) db value.
    const result = resolveConnectionConfig({ db: '  prod-realm  ' }, false);
    expect(result.db).toBe('prod-realm');
  });

  it('trimmed uri is returned (not the raw padded value)', () => {
    // WRONG IMPL KILLED: an impl that returns the raw (untrimmed) uri value.
    const result = resolveConnectionConfig(
      { uri: '  wss://prod.example:3000  ', db: 'prod-realm' },
      false,
    );
    expect(result.uri).toBe('wss://prod.example:3000');
  });
});

// ---------------------------------------------------------------------------
// Dev mode (isDev === true) — MUST NEVER throw
// ---------------------------------------------------------------------------

describe('resolveConnectionConfig: dev mode — never throws, applies dev defaults', () => {
  it('T7: {} + isDev=true returns exactly the dev defaults', () => {
    // WRONG IMPL KILLED: an impl that fail-louds even in dev when no env vars are set.
    expect(resolveConnectionConfig({}, true)).toEqual({ uri: DEV_URI, db: DEV_DB });
  });

  it('T8: { db: "monster-realm" } + isDev=true returns that db — dev legitimately uses dev DB', () => {
    // WRONG IMPL KILLED: an impl that throws on the dev-default DB name regardless
    // of isDev, which would break local development.
    expect(resolveConnectionConfig({ db: DEV_DB }, true)).toEqual({ uri: DEV_URI, db: DEV_DB });
  });

  it('dev with explicit uri uses that uri, falls back db to default', () => {
    // WRONG IMPL KILLED: an impl that ignores explicit uri in dev mode.
    // Intentional insecure localhost WebSocket dev/playtest fixture, not a production endpoint (ADR-0128).
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    expect(resolveConnectionConfig({ uri: 'ws://0.0.0.0:3000' }, true)).toEqual({
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
      uri: 'ws://0.0.0.0:3000',
      db: DEV_DB,
    });
  });

  it('dev with explicit db uses that db, falls back uri to default', () => {
    // WRONG IMPL KILLED: an impl that ignores explicit db in dev mode.
    expect(resolveConnectionConfig({ db: 'my-test-realm' }, true)).toEqual({
      uri: DEV_URI,
      db: 'my-test-realm',
    });
  });

  it('dev trims whitespace-padded uri and db', () => {
    // WRONG IMPL KILLED: a no-trim impl that returns raw strings in dev mode.
    // Intentional insecure localhost WebSocket dev/playtest fixture, not a production endpoint (ADR-0128).
    expect(
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
      resolveConnectionConfig({ uri: '  ws://local:3000  ', db: '  dev-realm  ' }, true),
    ).toEqual({
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
      uri: 'ws://local:3000',
      db: 'dev-realm',
    });
  });

  it('dev with whitespace-only uri falls back to default', () => {
    // WRONG IMPL KILLED: an impl that uses the whitespace-only string as a uri.
    expect(resolveConnectionConfig({ uri: '   ' }, true)).toEqual({ uri: DEV_URI, db: DEV_DB });
  });
});

// ---------------------------------------------------------------------------
// F-2: Case-insensitive dev-default guard
// The guard comparison is case-insensitive: db.trim().toLowerCase() === 'monster-realm'
// so a case-variant of the dev DB name cannot slip past in production.
// The RETURNED db value is still case-preserving — only the comparison is case-folded.
// ---------------------------------------------------------------------------

describe('resolveConnectionConfig: production — case-insensitive dev-default guard (F-2)', () => {
  it('F-2a: { db: "Monster-Realm" } + isDev=false MUST throw — kills case-sensitive === check', () => {
    // WRONG IMPL KILLED: a case-sensitive `=== 'monster-realm'` check that lets a
    // case-variant of the dev DB through to production.
    expect(() => resolveConnectionConfig({ db: 'Monster-Realm' }, false)).toThrow();
  });

  it('F-2b: { db: "MONSTER-REALM" } + isDev=false MUST throw — kills case-sensitive check', () => {
    // WRONG IMPL KILLED: same — all-caps variant of the dev DB must also be rejected.
    expect(() => resolveConnectionConfig({ db: 'MONSTER-REALM' }, false)).toThrow();
  });

  it('F-2c: { db: "Monster-Realm-Playtest" } + isDev=false MUST return (positive control — no over-folding)', () => {
    // WRONG IMPL KILLED: an impl that does a case-insensitive PREFIX check rather than
    // exact equality, or an impl that lower-cases the returned value.
    // 'monster-realm-playtest' !== 'monster-realm' under case-insensitive exact equality,
    // so this MUST pass through. The returned db must be the trimmed raw value, NOT lowercased.
    const result = resolveConnectionConfig({ db: 'Monster-Realm-Playtest' }, false);
    expect(result.db).toBe('Monster-Realm-Playtest');
  });

  it('F-2d: { db: "  Monster-Realm  " } + isDev=false MUST throw — case-insensitive + trim combined', () => {
    // WRONG IMPL KILLED: an impl that only case-folds without trimming, or only trims
    // without case-folding — both must apply together.
    expect(() => resolveConnectionConfig({ db: '  Monster-Realm  ' }, false)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// T11: Property test — encodes the exact fail-loud condition + trimming rule
// ---------------------------------------------------------------------------

describe('resolveConnectionConfig property (T11): exact fail-loud condition + trim semantics', () => {
  it(
    'for any db string d: throws IFF d.trim()==="" or d.trim().toLowerCase()==="monster-realm"; ' +
      'when it does NOT throw, returned db === d.trim() (case-preserving)',
    () => {
      // WRONG IMPL KILLED: any impl that diverges from the two-clause condition —
      // a prefix check, a case-sensitive-only check, a missing-trim, or an inverted
      // condition all fail here. The case-insensitive guard (F-2) means
      // 'Monster-Realm' must throw; the case-preserving return means 'Monster-Realm-Playtest'
      // must come back exactly as 'Monster-Realm-Playtest'.
      fc.assert(
        fc.property(
          // Generate a range of db strings including the critical boundary values
          fc.oneof(
            fc.constant(''),
            fc.constant('monster-realm'),
            fc.constant('Monster-Realm'),
            fc.constant('MONSTER-REALM'),
            fc.constant('  monster-realm  '),
            fc.constant('  Monster-Realm  '),
            fc.constant('monster-realm-playtest'),
            fc.constant('Monster-Realm-Playtest'),
            fc.constant('monster-realm-old'),
            fc.string({ minLength: 0, maxLength: 30 }),
          ),
          (d) => {
            const shouldThrow = d.trim() === '' || d.trim().toLowerCase() === 'monster-realm';
            if (shouldThrow) {
              expect(() => resolveConnectionConfig({ db: d }, false)).toThrow();
            } else {
              const result = resolveConnectionConfig({ db: d }, false);
              // Case-preserving: returned db is the trimmed raw value, NOT lowercased.
              expect(result.db).toBe(d.trim());
            }
          },
        ),
      );
    },
  );

  it('in dev mode: never throws for any db string', () => {
    // WRONG IMPL KILLED: any impl that throws in dev regardless of the db value.
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 30 }), (d) => {
        expect(() => resolveConnectionConfig({ db: d }, true)).not.toThrow();
      }),
    );
  });
});
