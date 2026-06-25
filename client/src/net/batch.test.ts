// MicrotaskBatcher — coalesce a transaction's row burst into one flush (ADR-0013).
import { describe, expect, it, vi } from 'vitest';
import { MicrotaskBatcher } from './batch';

describe('MicrotaskBatcher: one flush per transaction burst', () => {
  it('BITES: N schedules in one sync burst flush exactly ONCE (never per-row)', async () => {
    const flush = vi.fn();
    const b = new MicrotaskBatcher(flush);
    b.schedule();
    b.schedule();
    b.schedule();
    expect(flush).toHaveBeenCalledTimes(0); // nothing fires synchronously — no mid-batch reconcile
    await Promise.resolve(); // drain the microtask queue
    expect(flush).toHaveBeenCalledTimes(1); // a per-row impl would have fired 3x
  });

  it('a later burst flushes again (one flush per transaction)', async () => {
    const flush = vi.fn();
    const b = new MicrotaskBatcher(flush);
    b.schedule();
    await Promise.resolve();
    b.schedule();
    b.schedule();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('no schedule => no flush', async () => {
    const flush = vi.fn();
    // eslint-disable-next-line no-new
    new MicrotaskBatcher(flush);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(0);
  });
});
