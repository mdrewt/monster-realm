// ui/emptyState.ts — the empty state (uif-3, UIF3.5; research §8): why this area is empty, where its
// content comes from, and what to do next. The kit writes only caller text. It is not a live region and
// holds nothing focusable: the frame's nav container stays the one tab stop.
export interface EmptyStateContent {
  readonly reason: string;
  readonly cue?: string;
  readonly nextStep?: string;
}

function line(doc: Document, className: string, text: string): HTMLElement {
  const el = doc.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

export function createEmptyState(doc: Document, content: EmptyStateContent): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'mr-empty';
  root.append(line(doc, 'mr-empty-reason', content.reason));
  if (content.cue) root.append(line(doc, 'mr-empty-cue', content.cue));
  if (content.nextStep) root.append(line(doc, 'mr-empty-next', content.nextStep));
  return root;
}
