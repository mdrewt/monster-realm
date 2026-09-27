/**
 * indexShell.smoke.test.ts: parses the REAL client/index.html and checks the shell contract
 * against the production overlay registry (OVERLAY_A11Y).
 *
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './ui/overlayRegistry';

const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
// A detached window with resource loading off: parsing must never fetch styles.css or main.ts.
const win = new Window({
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
    disableJavaScriptEvaluation: true,
  },
});
const doc = new win.DOMParser().parseFromString(
  readFileSync(INDEX_HTML, 'utf8'),
  'text/html',
) as unknown as Document;

/** Overlays whose shells main.ts constructs at runtime: no static anchor in index.html. */
const CONSTRUCTED: ReadonlySet<OverlayId> = new Set<OverlayId>([
  'battleView',
  'boxView',
  'raisingView',
  'evolutionView',
  'claimView',
  'privacyView',
]);

const NATIVE_FOCUSABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A']);

/** The anchor itself or its nearest ancestor that is a direct <body> child. */
function shellRoot(anchor: Element): Element | null {
  for (let el: Element | null = anchor; el !== null; el = el.parentElement) {
    if (el.parentElement?.tagName === 'BODY') return el;
  }
  return null;
}

describe('index.html shell contract', () => {
  it('mounts #app and loads exactly one module script by src, with no inline script', () => {
    expect(doc.getElementById('app')?.parentElement?.tagName).toBe('BODY');
    const scripts = Array.from(doc.querySelectorAll('script'));
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute('type')).toBe('module');
    expect(scripts[0].getAttribute('src')).toBeTruthy();
    expect((scripts[0].textContent ?? '').trim()).toBe('');
  });

  it('has exactly one live region: #a11y-live, polite + atomic, a direct empty <body> child outside #app', () => {
    const live = Array.from(doc.querySelectorAll('[aria-live]'));
    expect(live.map((el) => el.id)).toEqual(['a11y-live']);
    expect(doc.querySelectorAll('#a11y-live')).toHaveLength(1);
    const node = live[0];
    expect(node.getAttribute('aria-live')).toBe('polite');
    expect(node.getAttribute('aria-atomic')).toBe('true');
    expect(node.parentElement?.tagName).toBe('BODY');
    expect(doc.getElementById('app')?.contains(node)).toBe(false);
    expect(node.classList.contains('sr-only')).toBe(true);
    expect(node.hasAttribute('aria-hidden') || node.hasAttribute('hidden')).toBe(false);
    expect(node.getAttribute('style')).toBeNull();
    expect((node.textContent ?? '').trim()).toBe('');
  });

  it.each(
    OVERLAY_IDS.map((id) => [id]),
  )('%s: static shell ARIA and anchor focusability match OVERLAY_A11Y', (id) => {
    const meta = OVERLAY_A11Y[id];
    const anchor = doc.querySelector(meta.initialFocusSelector);
    if (CONSTRUCTED.has(id)) {
      expect(anchor, `${id} is constructed at runtime; its anchor must not be static`).toBeNull();
      return;
    }
    expect(anchor, `${id}: ${meta.initialFocusSelector} must resolve in index.html`).not.toBeNull();
    if (anchor === null) return;
    const root = shellRoot(anchor);
    expect(root, `${id}: anchor must sit inside a direct <body> child`).not.toBeNull();
    expect(root?.getAttribute('role')).toBe(meta.role);
    expect(root?.getAttribute('aria-modal')).toBe('true');
    for (const banned of ['aria-hidden', 'aria-label', 'aria-labelledby']) {
      expect(root?.hasAttribute(banned), `${id}: shell root must not carry ${banned}`).toBe(false);
    }
    const tabindex = anchor.getAttribute('tabindex');
    if (NATIVE_FOCUSABLE.has(anchor.tagName)) {
      expect(tabindex, `${id}: a native control must carry no tabindex`).toBeNull();
    } else {
      // menuView's listbox holds DOM focus (aria-activedescendant); passive anchors use -1.
      expect(tabindex).toBe(id === 'menuView' ? '0' : '-1');
    }
  });

  it('every role-bearing element is a registry shell, and no tabindex exceeds 0', () => {
    const roots = new Set(
      OVERLAY_IDS.map((id) => doc.querySelector(OVERLAY_A11Y[id].initialFocusSelector))
        .filter((a): a is Element => a !== null)
        .map(shellRoot),
    );
    const strays = Array.from(doc.querySelectorAll('body [role], body [id$="-overlay"]'))
      .filter((el) => !roots.has(el))
      .map((el) => el.id || el.tagName);
    expect(strays).toEqual([]);
    const bad = Array.from(doc.querySelectorAll('[tabindex]'))
      .map((el) => el.getAttribute('tabindex') ?? '')
      .filter((raw) => !/^-?\d+$/.test(raw) || Number.parseInt(raw, 10) > 0);
    expect(bad).toEqual([]);
  });
});
