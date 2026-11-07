// ui/rowCard.ts — one visually separated row per entry (uif-3, UIF3.5): a consumer builds one card for
// each entry, normally inside `renderNav`'s `fill`, so the nav row stays the kit's and the card is its
// content. The kit writes only caller text.
export interface RowCardContent {
  readonly title: string;
  readonly lines?: readonly string[];
}

function part(doc: Document, className: string, text: string): HTMLElement {
  const el = doc.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

export function createRowCard(doc: Document, content: RowCardContent): HTMLElement {
  const card = doc.createElement('div');
  card.className = 'mr-card';
  card.append(
    part(doc, 'mr-card-title', content.title),
    ...(content.lines ?? []).map((text) => part(doc, 'mr-card-line', text)),
  );
  return card;
}
