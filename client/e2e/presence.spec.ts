import { test, expect, chromium } from '@playwright/test';

// The M0b walking-skeleton proof: two independent clients (separate browser
// contexts => separate identities => separate presence rows) each converge, via
// their subscription, to seeing BOTH presence dots — the end-to-end pipe
// (connect -> reducer -> table -> subscription -> render) works. Asserted via the
// DEV introspection hook, never pixels.
test('two clients each see both presence dots', async () => {
  const browser = await chromium.launch();
  try {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await a.goto('/');
    await b.goto('/');

    // Both connect, subscribe, and join (the hook resolves `ready` on subscribe).
    await a.waitForFunction(() => Boolean((window as any).__mr), null, { timeout: 20_000 });
    await b.waitForFunction(() => Boolean((window as any).__mr), null, { timeout: 20_000 });

    // Each client should see exactly 2 presence rows + 2 rendered dots.
    await a.waitForFunction(() => (window as any).__mr.presenceCount() === 2, null, { timeout: 20_000 });
    await b.waitForFunction(() => (window as any).__mr.presenceCount() === 2, null, { timeout: 20_000 });

    expect(await a.evaluate(() => (window as any).__mr.dotCount())).toBe(2);
    expect(await b.evaluate(() => (window as any).__mr.dotCount())).toBe(2);

    // Identities differ (two distinct players).
    const idA = await a.evaluate(() => (window as any).__mr.identity);
    const idB = await b.evaluate(() => (window as any).__mr.identity);
    expect(idA).not.toEqual(idB);
    expect(idA).toBeTruthy();
  } finally {
    await browser.close();
  }
});
