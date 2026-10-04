// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { HintBarView } from './hintBar';

describe('RT', () => {
  it('RT-M17: same buttons, a remapped keycap repaints', () => {
    document.body.innerHTML =
      '<div id="hint-bar"><button data-button="Start"></button><button data-button="Select"></button></div>';
    const v = new HintBarView(document.getElementById('hint-bar') as HTMLElement);
    const c = (k: string) => [
      { button: 'Start' as const, keycap: k, verb: 'Menu', badge: false },
      { button: 'Select' as const, keycap: 'H', verb: 'Help', badge: false },
    ];
    v.render(c('Esc'), null);
    v.render(c('P'), null);
    expect(document.querySelector('[data-button="Start"] .mr-chip-key')?.textContent).toBe('P');
  });
  it('RT-M39: an identical render touches no node', () => {
    document.body.innerHTML =
      '<div id="hint-bar"><button data-button="Start"></button><button data-button="Select"></button></div>';
    const root = document.getElementById('hint-bar') as HTMLElement;
    const v = new HintBarView(root);
    const chips = [{ button: 'Start' as const, keycap: 'Esc', verb: 'Menu', badge: false }];
    v.render(chips, 'x');
    let n = 0;
    new MutationObserver((r) => {
      n += r.length;
    }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    v.render(chips, 'x');
    return Promise.resolve().then(() => expect(n).toBe(0));
  });
});
