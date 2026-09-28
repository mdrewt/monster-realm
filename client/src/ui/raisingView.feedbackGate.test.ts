// @vitest-environment happy-dom
// RaisingView.showFeedback is a no-op while the view is hidden. KeyB/KeyE force-hide the
// raising overlay (hide() clears the feedback line); a care whose reducer promise settles
// AFTER that must not write a message the player then sees on the next open.
import { describe, expect, it, vi } from 'vitest';
import { RaisingView } from './raisingView';

function mount(): { view: RaisingView; feedback: () => string } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new RaisingView(parent, { onTrain: vi.fn(), onCare: vi.fn() });
  const el = parent.querySelector('#raising-feedback');
  if (!el) throw new Error('raising-feedback element missing');
  return { view, feedback: () => el.textContent ?? '' };
}

describe('RaisingView.showFeedback visibility gate', () => {
  it('writes the message while the view is visible', () => {
    const { view, feedback } = mount();
    view.show();
    view.showFeedback('Cared!');
    expect(feedback()).toBe('Cared!');
    view.hide();
  });

  it('a feedback that settles after a force-hide does not greet the next open', () => {
    const { view, feedback } = mount();
    view.show();
    view.hide();
    view.showFeedback('Cared!');
    view.show();
    expect(feedback()).toBe('');
    view.hide();
  });
});
