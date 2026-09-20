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
      expect(t(key as never), `t(${key}) must equal CATALOG_EN[${key}]`).toBe(value);
      checked += 1;
    }
    expect(
      checked > 0,
      'ANTI-VACUITY: at least one plain (string-valued) key must have been checked',
    ).toBe(true);

    expect(t('chrome.helpHint' as never)).toBe('Press ? for help · click or M for menu');

    // FULL VALUE SNAPSHOT (mutation red-team): a punctuation-only change to any one plain
    // value — e.g. dropping the em dash in `contentStale` — passes every check above (it only
    // asserts t(key) === CATALOG_EN[key], never the LITERAL English text) but fails here. Kills
    // that survivor by pinning the exact 9-entry plain-value table from the plan.
    const plainKeys = Object.keys(CATALOG_EN as Record<string, unknown>).filter(
      (key) => typeof (CATALOG_EN as Record<string, unknown>)[key] === 'string',
    );
    const snapshot = Object.fromEntries(plainKeys.map((key) => [key, t(key as never)]));
    expect(snapshot).toEqual({
      'chrome.helpHint': 'Press ? for help · click or M for menu',
      'chrome.help.title': 'Controls & Goals',
      'chrome.rename.submit': 'Rename',
      'chrome.tradePropose.submit': 'Offer',
      'chrome.status.exportBlocked': 'data export: download blocked by the browser',
      'chrome.status.privacyOverlayBusy': 'privacy: close the other overlay first',
      'chrome.status.contentStale': 'content out of date — reload',
      'chrome.status.bugBundleBlocked': 'bug bundle: download blocked — copy from console',
      'chrome.status.healUnavailable': 'heal: no heal location available',
    });
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

  it('m24s1 RESOLVER-MISS: t/tf THROW (never return a string) for an absent key, an inherited Object.prototype key, or a key routed to the wrong resolver — and a prototype-chain hit takes the SAME miss path as an ordinary absent key', () => {
    function messageFor(key: string): string {
      let thrown: unknown;
      try {
        t(key as never);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `t(${key}) must throw an Error`).toBeInstanceOf(Error);
      return (thrown as Error).message;
    }

    const nopeMessage = messageFor('nope');
    expect(nopeMessage.includes('nope'), 'the thrown message must NAME the miss').toBe(true);

    // WRONG IMPL KILLED (red-team's `key in catalog` cheat): `key in CATALOGS[locale]` is TRUE
    // for 'constructor'/'toString'/'hasOwnProperty' even though none is a real catalog entry. A
    // `t = (key) => (key in catalog ? catalog[key] : throwMiss(key))` implementation would only
    // be caught by a bare `.toThrow()` if it happened to ALSO fail a downstream `typeof` guard —
    // but a cheat that special-cases "not a string" (the inherited Object.prototype member's
    // typeof) to produce its OWN distinct message would still pass a bare throw check while
    // never actually reaching the `Object.hasOwn` miss path. Asserting the prototype-key message
    // is IDENTICAL to the ordinary-miss message, modulo the substituted key, forces the SAME
    // Object.hasOwn-based miss path for both and closes that gap.
    for (const protoKey of ['constructor', 'toString', 'hasOwnProperty']) {
      const protoMessage = messageFor(protoKey);
      expect(
        protoMessage,
        `t(${protoKey}) must throw via the SAME miss path as t('nope') — got a different message shape`,
      ).toBe(nopeMessage.split('nope').join(protoKey));
      expect(protoMessage.includes(protoKey), 'the thrown message must NAME the key').toBe(true);
    }

    // A parameterized key routed through the PLAIN resolver.
    expect(() => t('chrome.status.disconnected' as never)).toThrow();

    // A plain key routed through the PARAMETERIZED resolver.
    expect(() => tf('chrome.helpHint' as never, {} as never)).toThrow();
  });

  it("m24s1 SHAPE-05: t has arity 1, tf has arity 2, and resolver.ts's source declares exactly one `export function t(` and one GENERIC `export function tf<` — no overload, no variadic, no monomorphic tf regression", () => {
    // NOTE (test-review round): the plan mandates the GENERIC signature
    // `export function tf<K extends ParamMessageId>(key: K, params: MessageParams[K]): string`,
    // so the literal substring `'export function tf('` can never appear — the `<` intervenes
    // between `tf` and `(`. The scan below counts `'export function tf<'` instead: this both
    // requires the generic form (a plain `tf(key, ...)` regression fails the count) and remains
    // exactly-one, no-overload.
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
        const at = stripped.indexOf('export function tf<', from);
        if (at === -1) break;
        tfDecls += 1;
        from = at + 'export function tf<'.length;
      }
    }
    expect(tDecls, "resolver.ts must declare exactly one 'export function t('").toBe(1);
    expect(
      tfDecls,
      "resolver.ts must declare exactly one GENERIC 'export function tf<' — a monomorphic 'export function tf(' regression fails this count too",
    ).toBe(1);

    // WRONG IMPL KILLED: `export function t(...key: PlainMessageId[])` — a rest/variadic
    // spelling immediately after the opening paren.
    expect(
      stripped.includes('t(...'),
      "resolver.ts must not declare t (or tf) with a rest/variadic parameter ('t(...')",
    ).toBe(false);
  });
});
