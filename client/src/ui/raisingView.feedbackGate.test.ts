// @vitest-environment happy-dom
// qf-9 (QF9.2): the raising screen has NO feedback sink. This file used to pin that
// `RaisingView.showFeedback` was a no-op while the view was hidden (a care whose reducer promise
// settled after a force-hide must not write a message the player sees on the next open). Care now
// runs from the Monsters sheet and answers on the Monsters frame's own line (qf-2), so the raising
// view lost `#raising-feedback` and `showFeedback` altogether: the stale-message hazard cannot
// exist because there is nowhere to write one. The cases below pin that, keeping the file's intent
// (a late care answer never greets the raising screen).
import { describe, expect, it } from 'vitest';
import { RaisingView } from './raisingView';

function mount(): { view: RaisingView; parent: HTMLElement; root: HTMLElement } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new RaisingView(parent);
  return { view, parent, root: parent.firstElementChild as HTMLElement };
}

/** A caller written against the retired API: `showFeedback?.()` is a no-op when the method is gone. */
function lateCareAnswer(view: RaisingView, message: string): void {
  (view as unknown as { showFeedback?: (m: string) => void }).showFeedback?.(message);
}

describe('RaisingView qf-9: no feedback sink (QF9.2)', () => {
  it('QF9-2-GATE-NO-SINK: there is no #raising-feedback element and no showFeedback member in any state: constructed, shown, hidden, reopened', () => {
    // WRONG IMPL KILLED: the shipped view (its constructor appends #raising-feedback and defines
    // showFeedback); a view that drops the method but keeps the element (a dead line in the
    // frame); one that drops the element but keeps a no-op method (main.ts could still call it
    // and silently swallow a care answer).
    const { view } = mount();
    const states: ReadonlyArray<readonly [string, () => void]> = [
      ['constructed', () => {}],
      ['shown', () => view.show()],
      ['hidden', () => view.hide()],
      ['reopened', () => view.show()],
    ];
    for (const [name, step] of states) {
      step();
      expect(
        document.getElementById('raising-feedback'),
        `${name}: no #raising-feedback`,
      ).toBeNull();
      expect('showFeedback' in view, `${name}: no showFeedback member`).toBe(false);
    }
    view.hide();
  });

  it('QF9-2-GATE-LATE-ANSWER-NEVER-PAINTS: a care answer delivered to a raising view that is visible, hidden or reopened paints nothing anywhere in its root', () => {
    // WRONG IMPL KILLED: a view that still writes a message into its root while visible (the
    // shipped showFeedback does: "Cared!" would appear on the inventory screen, for a care sent
    // from the Monsters sheet); one whose reopened frame greets the player with the last message.
    const { view, root } = mount();
    view.show();
    lateCareAnswer(view, 'Cared!');
    expect(root.textContent ?? '', 'visible: nothing painted').not.toContain('Cared!');
    view.hide();
    lateCareAnswer(view, 'Cared!');
    view.show();
    expect(root.textContent ?? '', 'reopened: nothing painted').not.toContain('Cared!');
    view.hide();
  });
});
