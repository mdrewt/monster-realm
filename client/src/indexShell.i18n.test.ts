// @vitest-environment happy-dom
// indexShell.i18n.test.ts — m24-s5 (ADR-0261) RED gating tests: IX-01/02 (I18N-23, D7).
//
// SOURCE OF TRUTH: memory/projects/monster-realm-m24-s5-plan.md (Tests — IX-01/IX-02, Files —
// client/index.html :2 gains dir="ltr"; :60/:79-81/:94 the three view-owned literals are
// REMOVED), plan-revisions.md, docs/adr/0261-i18n-migration-batch-c.md.
//
// WHY THIS READS THE REAL FILE: the artifact under test IS the shipped markup (indexShell.test.ts
// precedent) — a hand-mirrored fixture would stay green after a regression to the real file.
//
// RED REASON AT HEAD: client/index.html:2 ships only `<html lang="en">` (no `dir` attribute), and
// :60/:79-81/:94 still carry the literal 'Rename'/'Offer'/'Controls &amp; Goals' text inside
// #rename-submit/#tradepropose-submit/#help-title. IX-01 fails because
// `documentElement.getAttribute('dir')` reads `null`, not `'ltr'`. IX-02 fails because FOUR
// non-whitespace text nodes exist under <body> today (the #help-hint text plus the three
// view-owned literals above), not the required ONE.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the
// plan/plan-revisions/ADR-0261 only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOG_EN } from './ui/i18n/catalog.en';

const INDEX_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

function readIndexHtml(): string {
  try {
    return readFileSync(INDEX_HTML_PATH, 'utf8');
  } catch (err) {
    // Fail loud — every assertion below is vacuous if the file cannot be read.
    throw new Error(`index.html could not be read at expected path: ${INDEX_HTML_PATH} — ${err}`);
  }
}

// Hermeticity (indexShell.test.ts precedent, m23-s2): happy-dom resolves index.html's
// `<link rel="stylesheet" href="/src/styles.css">` against the document URL and issues a REAL
// `fetch()` to http://localhost:3000/src/styles.css on every parse. Nothing here reads a computed
// style, so the load is disabled and treated as a success — the same optional, non-asserted
// happy-dom-internals switch the sibling flips (an upgrade that moves it only brings the stderr
// noise back).
const happyDomSettings = (
  window as unknown as {
    happyDOM?: {
      settings?: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean };
    };
  }
).happyDOM?.settings;
if (happyDomSettings !== undefined) {
  happyDomSettings.disableCSSFileLoading = true;
  happyDomSettings.handleDisabledFileLoadingAsSuccess = true;
}

function parseIndexHtml(): Document {
  return new DOMParser().parseFromString(readIndexHtml(), 'text/html');
}

/** Every non-whitespace TEXT_NODE under `root`, <script>/<style> content excluded. */
function collectNonWhitespaceTextNodes(root: Element): ChildNode[] {
  const out: ChildNode[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.nodeType === 1) {
      const tag = (node as Element).tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      const children = (node as Element).childNodes;
      for (let i = 0; i < children.length; i++) stack.push(children[i] as Node);
    } else if (node.nodeType === 3) {
      const text = node as ChildNode;
      if ((text.textContent ?? '').trim() !== '') out.push(text);
    }
  }
  return out;
}

describe('m24s5 (ADR-0261, I18N-23): index.html static-shell i18n invariants', () => {
  it('m24s5 IX-01: <html> carries dir="ltr" and lang="en"', () => {
    const doc = parseIndexHtml();
    expect(doc.documentElement.getAttribute('dir')).toBe('ltr');
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
  });

  it('m24s5 IX-02: exactly ONE non-whitespace text node exists under <body> (script/style excluded), parented by #help-hint and byte-identical to CATALOG_EN[chrome.helpHint]; #help-title/#rename-submit/#tradepropose-submit each ship EMPTY', () => {
    const doc = parseIndexHtml();
    const body = doc.body;
    expect(body, 'precondition: index.html must parse a <body>').not.toBeNull();

    const nodes = collectNonWhitespaceTextNodes(body as Element);
    expect(
      nodes.length,
      `expected exactly ONE non-whitespace text node directly under <body> (script/style ` +
        `excluded); found ${nodes.length}: ${JSON.stringify(nodes.map((n) => n.textContent))}`,
    ).toBe(1);
    const onlyNode = nodes[0] as ChildNode;
    expect(onlyNode.parentElement?.id).toBe('help-hint');
    expect(onlyNode.textContent?.trim()).toBe(
      (CATALOG_EN as Record<string, unknown>)['chrome.helpHint'],
    );

    for (const id of ['help-title', 'rename-submit', 'tradepropose-submit']) {
      const el = doc.getElementById(id);
      expect(el, `#${id} must exist in the shell`).not.toBeNull();
      expect(
        (el?.textContent ?? '').trim(),
        `#${id} must ship EMPTY — the owning view writes its text at open time (D3/D7)`,
      ).toBe('');
    }
  });
});
