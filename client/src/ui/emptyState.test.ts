// @vitest-environment happy-dom
/**
 * emptyState.test.ts: the EmptyState kit primitive (uif-3, UIF3.5, research section 8).
 *
 * `createEmptyState(doc, { reason, cue?, nextStep? })` returns a `.mr-empty` block holding the reason
 * (always), then the cue and the next step when given and non-empty, in that order. It writes only
 * caller text, and it is inert: no role, no live region, nothing focusable (the frame's nav
 * container stays the only tab stop).
 */
import { describe, expect, it } from 'vitest';
import { createEmptyState } from './emptyState';

const classes = (el: Element): string[] => Array.from(el.children).map((c) => c.className);

describe('createEmptyState', () => {
  it('UIF3.5 always renders the reason, in a .mr-empty block with exactly one child when no cue or next step is given', () => {
    // WRONG IMPLS KILLED: a reason written straight onto the root (no .mr-empty-reason element for
    // the CSS to style); a reason element created only when a cue exists; empty placeholder
    // elements for the absent cue and next step.
    const el = createEmptyState(document, { reason: 'No monsters yet' });
    expect(el.classList.contains('mr-empty')).toBe(true);
    expect(el.children.length).toBe(1);
    const reason = el.querySelector('.mr-empty-reason');
    expect(reason?.textContent).toBe('No monsters yet');
    expect(el.querySelector('.mr-empty-cue')).toBeNull();
    expect(el.querySelector('.mr-empty-next')).toBeNull();
    expect(el.textContent).toBe('No monsters yet');
    // an empty reason is still the required part: its element exists
    const blank = createEmptyState(document, { reason: '' });
    expect(blank.querySelector('.mr-empty-reason')).not.toBeNull();
  });

  it('UIF3.5 renders reason, cue, next step in that order, and each optional part only when present and non-empty', () => {
    // WRONG IMPLS KILLED: next before cue; a cue that replaces the reason; an empty-string cue or
    // next step rendered as an empty element (a stray gap); undefined rendered as the text
    // "undefined"; the cue dropped when only the next step is missing.
    const full = createEmptyState(document, { reason: 'R', cue: 'C', nextStep: 'N' });
    expect(classes(full)).toEqual(['mr-empty-reason', 'mr-empty-cue', 'mr-empty-next']);
    expect(Array.from(full.children).map((c) => c.textContent)).toEqual(['R', 'C', 'N']);

    const noNext = createEmptyState(document, { reason: 'R', cue: 'C' });
    expect(classes(noNext)).toEqual(['mr-empty-reason', 'mr-empty-cue']);
    const noCue = createEmptyState(document, { reason: 'R', nextStep: 'N' });
    expect(classes(noCue)).toEqual(['mr-empty-reason', 'mr-empty-next']);

    const blanks = [
      { reason: 'R', cue: '' },
      { reason: 'R', nextStep: '' },
      { reason: 'R', cue: '', nextStep: '' },
    ] as const;
    for (const input of blanks) {
      const el = createEmptyState(document, input);
      expect(classes(el), JSON.stringify(input)).toEqual(['mr-empty-reason']);
      expect(el.textContent).toBe('R');
    }
    const blankCue = createEmptyState(document, { reason: 'R', cue: '', nextStep: 'N' });
    expect(classes(blankCue)).toEqual(['mr-empty-reason', 'mr-empty-next']);
  });

  it('UIF3.5 is inert: no role, no aria-live, no tabindex, no focusable element, on the root or any part', () => {
    // WRONG IMPLS KILLED: role="status" or aria-live on the block (a second live region beside
    // #a11y-live); tabindex on the root (a second tab stop); a link or button for the next step.
    const el = createEmptyState(document, { reason: 'R', cue: 'C', nextStep: 'N' });
    for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
      for (const attr of ['role', 'aria-live', 'tabindex', 'aria-atomic', 'contenteditable']) {
        expect(node.hasAttribute(attr), `${node.className} ${attr}`).toBe(false);
      }
      expect(['A', 'BUTTON', 'INPUT']).not.toContain(node.tagName);
    }
  });

  it('UIF3.5 writes caller text as text, never markup, for the reason, the cue and the next step', () => {
    // WRONG IMPLS KILLED: innerHTML for any of the three parts.
    const bad = '<img src=x onerror=alert(1)><b>b</b>';
    const el = createEmptyState(document, { reason: bad, cue: bad, nextStep: bad });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    for (const part of Array.from(el.children)) {
      expect(part.childElementCount).toBe(0);
      expect(part.textContent).toBe(bad);
    }
    expect(el.children.length).toBe(3);
  });

  it('UIF3.5 builds a fresh detached element per call', () => {
    // WRONG IMPLS KILLED: a module-level singleton re-filled on every call (two empty lists on one
    // screen would share and steal one node).
    const a = createEmptyState(document, { reason: 'A' });
    const b = createEmptyState(document, { reason: 'B' });
    expect(a).not.toBe(b);
    expect(a.textContent).toBe('A');
    expect(b.textContent).toBe('B');
    expect(a.parentElement).toBeNull();
  });
});
