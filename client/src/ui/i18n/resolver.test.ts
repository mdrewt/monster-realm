// ui/i18n/resolver.test.ts — m24-s1 RED gating tests for the module-level locale cell and the
// t()/tf() resolvers.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M24-internationalization.spec.md §2.3, §2.8.
//   docs/adr/0256-i18n-module-total-catalog-resolver-cell-negative-compile.md D1, D3.
//   memory/projects/monster-realm-m24-s1-plan.md §2 resolver.ts.
//
// RED REASON: `client/src/ui/i18n/{resolver,catalog.en}.ts` DO NOT EXIST YET. The static imports
// below fail to resolve at collection, redding every test in this file until the specialist
// ships them.
//
// NOT CONCURRENT (load-bearing): `resolver.ts` holds ONE module-level locale cell shared by
// every test in this process — running this file's tests concurrently (`describe.concurrent` /
// `it.concurrent`) would let one test's `setLocale` call race another's `currentLocale()` read.
// This file relies on vitest's DEFAULT per-file (not per-test) isolation and an `afterEach` that
// resets the cell back to 'en' after every test.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/ADR/plan
// only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// The comment stripper is IMPORTED, never copied (ADR-0215 single-owner rule). Precedent for a
// `.ts` test importing a `.mjs` eval: client/src/ui/i18n-no-html-sink.test.ts:45 (one `..`
// shallower — this file sits one directory deeper, under `ui/i18n/`).
import { stripComments } from '../../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { CATALOG_EN } from './catalog.en';
import { CATALOGS, currentLocale, DEFAULT_LOCALE, setLocale, t, tf } from './resolver';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  setLocale('en');
});

describe('resolver — the module-level locale cell and the t()/tf() resolvers (m24-s1, ADR-0256)', () => {
  it('m24s1 RESOLVER-T: t(key) returns the exact CATALOG_EN value for every plain (string-valued) key, and the literal English helpHint value is pinned', () => {
    const entries = Object.entries(CATALOG_EN as Record<string, unknown>);
    expect(entries.length > 0, 'ANTI-VACUITY: CATALOG_EN must not be empty').toBe(true);

    let checked = 0;
    for (const [key, value] of entries) {
      if (typeof value !== 'string') continue;
      expect(t(key as never), 't(' + key + ') must equal CATALOG_EN[' + key + ']').toBe(value);
      checked += 1;
    }
    expect(
      checked > 0,
      'ANTI-VACUITY: at least one plain (string-valued) key must have been checked',
    ).toBe(true);

    expect(t('chrome.helpHint' as never)).toBe('Press ? for help · click or M for menu');
  });

  it('m24s1 RESOLVER-TF: tf(key, params) interpolates the params into the catalog closure — the em-dash literal is exact', () => {
    expect(tf('chrome.status.disconnected' as never, { where: 'shop' } as never)).toBe(
      'shop: disconnected — try again',
    );
  });

  it('m24s1 RESOLVER-LOCALE: currentLocale()/DEFAULT_LOCALE start at en; setLocale THROWS on an unregistered locale and leaves the cell UNCHANGED; CATALOGS is the frozen single-entry registry', () => {
    expect(currentLocale()).toBe('en');
    expect(DEFAULT_LOCALE).toBe('en');

    // WRONG IMPL KILLED: `setLocale` clamping an unknown locale to 'en' instead of throwing —
    // that makes an unwired locale look wired (ADR-0256 D1's rejected alternative (c)).
    expect(() => setLocale('xx')).toThrow();
    let thrown: unknown;
    try {
      setLocale('xx');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(
      (thrown as Error).message.includes('xx'),
      "setLocale('xx')'s thrown message must NAME the unregistered locale 'xx'",
    ).toBe(true);
    // State must be UNCHANGED after the throw.
    expect(currentLocale(), 'currentLocale() must still be en after a rejected setLocale').toBe(
      'en',
    );

    expect(() => setLocale('en')).not.toThrow();

    expect(Object.keys(CATALOGS as Record<string, unknown>)).toEqual(['en']);
    expect(Object.isFrozen(CATALOGS), 'CATALOGS must be Object.freeze()d').toBe(true);
  });

  it('m24s1 RESOLVER-MISS: t/tf THROW (never return a string) for an absent key, an inherited Object.prototype key, or a key routed to the wrong resolver', () => {
    // Absent key.
    expect(() => t('nope' as never)).toThrow();
    let thrown: unknown;
    try {
      t('nope' as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(
      (thrown as Error).message.includes('nope'),
      'the thrown message must NAME the miss',
    ).toBe(true);

    // Inherited Object.prototype members — `key in CATALOGS[locale]` is true for these even
    // though neither is a real catalog entry; only `Object.hasOwn` resolution is safe.
    expect(() => t('constructor' as never)).toThrow();
    expect(() => t('toString' as never)).toThrow();

    // A parameterized key routed through the PLAIN resolver.
    expect(() => t('chrome.status.disconnected' as never)).toThrow();

    // A plain key routed through the PARAMETERIZED resolver.
    expect(() => tf('chrome.helpHint' as never, {} as never)).toThrow();
  });

  it("m24s1 SHAPE-05: t has arity 1, tf has arity 2, and resolver.ts's source declares exactly one `export function t(` and one `export function tf(` — no overload, no variadic", () => {
    expect(t.length, 't.length must be 1').toBe(1);
    expect(tf.length, 'tf.length must be 2').toBe(2);

    const resolverSource = readFileSync(path.join(I18N_DIR, 'resolver.ts'), 'utf8');
    const stripped = stripComments(resolverSource);

    let tDecls = 0;
    {
      let from = 0;
      for (;;) {
        const at = stripped.indexOf('export function t(', from);
        if (at === -1) break;
        tDecls += 1;
        from = at + 'export function t('.length;
      }
    }
    let tfDecls = 0;
    {
      let from = 0;
      for (;;) {
        const at = stripped.indexOf('export function tf(', from);
        if (at === -1) break;
        tfDecls += 1;
        from = at + 'export function tf('.length;
      }
    }
    expect(tDecls, "resolver.ts must declare exactly one 'export function t('").toBe(1);
    expect(tfDecls, "resolver.ts must declare exactly one 'export function tf('").toBe(1);

    // WRONG IMPL KILLED: `export function t(...key: PlainMessageId[])` — a rest/variadic
    // spelling immediately after the opening paren.
    expect(
      stripped.includes('t(...'),
      "resolver.ts must not declare t (or tf) with a rest/variadic parameter ('t(...')",
    ).toBe(false);
  });
});
