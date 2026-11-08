// @vitest-environment happy-dom
/**
 * toast.test.ts: the toast kit module (uif-4: UIF4.2).
 *
 * `toastStep` is a pure step over injected numbers (no clock, no timer); `createToast` builds the
 * one `#toast.mr-toast` element and `renderToast` paints a state onto it. The toast is NOT a live
 * region: `#a11y-live` is the only announcer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createToast, NO_TOAST, renderToast, TOAST_MS, type ToastState, toastStep } from './toast';

const show = (text: string, nowMs: number) => ({ kind: 'show' as const, text, nowMs });
const tick = (nowMs: number) => ({ kind: 'tick' as const, nowMs });
const CLEAR = { kind: 'clear' as const };

describe('toast (uif-4)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('UIF4.2 TOAST_MS is 4000 and NO_TOAST is the none state', () => {
    // WRONG IMPL KILLED: a different dwell time, a NO_TOAST that carries text.
    expect(TOAST_MS).toBe(4000);
    expect(NO_TOAST).toEqual({ kind: 'none' });
  });

  it('UIF4.2 show sets the text and expires TOAST_MS after the injected now', () => {
    // WRONG IMPL KILLED: untilMs computed from a wall clock, from 0, or without the dwell time.
    expect(toastStep(NO_TOAST, show('Entering Cobalt Reach', 1000))).toEqual({
      kind: 'shown',
      text: 'Entering Cobalt Reach',
      untilMs: 1000 + TOAST_MS,
    });
  });

  it('UIF4.2 a tick one millisecond before the expiry keeps the toast, and returns the same reference', () => {
    // WRONG IMPL KILLED: an early expiry (`>` off by one the other way) and a tick that rebuilds
    // an equal object (a render per frame).
    const s = toastStep(NO_TOAST, show('a', 1000));
    expect(toastStep(s, tick(1000 + TOAST_MS - 1))).toBe(s);
  });

  it('UIF4.2 a tick exactly at the expiry clears the toast', () => {
    // WRONG IMPL KILLED: `nowMs > untilMs` (a toast that lingers one frame past its time).
    const s = toastStep(NO_TOAST, show('a', 1000));
    expect(toastStep(s, tick(1000 + TOAST_MS))).toEqual({ kind: 'none' });
  });

  it('UIF4.2 a tick after the expiry clears the toast', () => {
    // WRONG IMPL KILLED: an expiry test that only fires on equality.
    const s = toastStep(NO_TOAST, show('a', 1000));
    expect(toastStep(s, tick(1000 + TOAST_MS + 5000))).toEqual({ kind: 'none' });
  });

  it('UIF4.2 a tick with no toast returns the same state object', () => {
    // WRONG IMPL KILLED: a no-op tick that allocates a fresh none state.
    expect(toastStep(NO_TOAST, tick(5000))).toBe(NO_TOAST);
  });

  it('UIF4.2 a newer show replaces the text and restarts the dwell time', () => {
    // WRONG IMPL KILLED: a queue (the old text stays), a show that keeps the old untilMs (the new
    // toast dies early), a show ignored while one is up.
    const first = toastStep(NO_TOAST, show('first', 1000));
    const second = toastStep(first, show('second', 3000));
    expect(second).toEqual({ kind: 'shown', text: 'second', untilMs: 3000 + TOAST_MS });
    expect(toastStep(second, tick(1000 + TOAST_MS))).toBe(second);
  });

  it('UIF4.2 clear removes a shown toast at once', () => {
    // WRONG IMPL KILLED: a clear that waits for the expiry.
    const s = toastStep(NO_TOAST, show('a', 1000));
    expect(toastStep(s, CLEAR)).toEqual({ kind: 'none' });
  });

  it('UIF4.2 clear with no toast returns the same state object', () => {
    // WRONG IMPL KILLED: a clear that allocates a new none state.
    expect(toastStep(NO_TOAST, CLEAR)).toBe(NO_TOAST);
  });

  it('UIF4.2 toastStep does not mutate the state it was given', () => {
    // WRONG IMPL KILLED: an in-place update of the shown state.
    const s = toastStep(NO_TOAST, show('a', 1000)) as Extract<ToastState, { kind: 'shown' }>;
    toastStep(s, show('b', 2000));
    expect(s).toEqual({ kind: 'shown', text: 'a', untilMs: 1000 + TOAST_MS });
  });

  it('UIF4.2 createToast builds exactly one #toast.mr-toast under the parent, hidden', () => {
    // WRONG IMPL KILLED: an element built but not attached, attached to body instead of the
    // parent, shown at creation, missing its id or class, or built twice.
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const t = createToast(document, parent);
    expect(t.root.id).toBe('toast');
    expect(t.root.classList.contains('mr-toast')).toBe(true);
    expect(t.root.parentElement).toBe(parent);
    expect(t.root.hidden).toBe(true);
    expect(parent.querySelectorAll('#toast')).toHaveLength(1);
    expect(parent.children).toHaveLength(1);
  });

  it('UIF4.2 the toast is not a live region (no role, aria-live or aria-atomic)', () => {
    // WRONG IMPL KILLED: a second announcer (role=status / aria-live) that would double-speak
    // beside #a11y-live.
    const t = createToast(document, document.body);
    expect(t.root.hasAttribute('role')).toBe(false);
    expect(t.root.hasAttribute('aria-live')).toBe(false);
    expect(t.root.hasAttribute('aria-atomic')).toBe(false);
  });

  it('UIF4.2 renderToast shows a shown state: not hidden, its text', () => {
    // WRONG IMPL KILLED: text painted but hidden left on, or hidden cleared without the text.
    const t = createToast(document, document.body);
    renderToast(t, toastStep(NO_TOAST, show('Entering Umber Fen', 10)));
    expect(t.root.hidden).toBe(false);
    expect(t.root.textContent).toBe('Entering Umber Fen');
  });

  it('UIF4.2 renderToast on the none state hides the toast and empties its text', () => {
    // WRONG IMPL KILLED: a hide that leaves the stale text for a screen-reader walk.
    const t = createToast(document, document.body);
    renderToast(t, toastStep(NO_TOAST, show('x', 10)));
    renderToast(t, NO_TOAST);
    expect(t.root.hidden).toBe(true);
    expect(t.root.textContent).toBe('');
  });

  it('UIF4.2 renderToast writes text, never markup', () => {
    // WRONG IMPL KILLED: an innerHTML write (a server-supplied name becomes live markup).
    const t = createToast(document, document.body);
    const html = '<img src=x onerror=alert(1)><b>bold</b>';
    renderToast(t, toastStep(NO_TOAST, show(html, 10)));
    expect(t.root.textContent).toBe(html);
    expect(t.root.children).toHaveLength(0);
  });
});
