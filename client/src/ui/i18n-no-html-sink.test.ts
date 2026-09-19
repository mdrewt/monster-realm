// ui/i18n-no-html-sink.test.ts — m24-s0 RHS-independent HTML-parsing-sink census.
//
// SOURCE OF TRUTH: M24-internationalization.spec.md §6 S0 (I18N-1..5), ADR-0255 D1-D6,
// memory/projects/gates/m24-s0.gates.md X1-X5.
//
// WHY THIS IS A CO-LOCATED TEST, NOT AN EVAL (ADR-0224/ADR-0255): the spec's own S0
// `touches:` names a NEW `evals/i18n-no-html-sink.eval.mjs`. ADR-0224 (2026-09-01, after
// the spec's ceremony) retires new `evals/*.eval.mjs` files; the equivalent invariant
// ships as this ordinary vitest suite, discovered by vitest's `src/**/*.test.ts` include
// and run by `just ci`'s client stage.
//
// SCOPE (ADR-0255 D2): every `client/src/**/*.ts` file whose name does NOT end in
// `.test.ts` (`endsWith`, never substring `.includes`) — including `module_bindings/`.
// The whole non-test client tree, not just the five S0 view files: the site population
// is zero after S0, so the stronger invariant costs nothing and a sixth file cannot
// silently reintroduce a sink.
//
// MATCHER VOCABULARY (ADR-0255 D3) — `String.indexOf` loops ONLY, no `RegExp` (ReDoS ban;
// a regex literal also blinds the single-owner `stripComments` this file imports).
//   Assignment family: `.innerHTML` / `.outerHTML`, optional whitespace (incl. newlines),
//     then `=` NOT followed by `=` (a plain assignment), or `+=`. `==`/`===` are getter
//     reads and never count.
//   Call family: the literal tokens `insertAdjacentHTML(`, `document.write(`, `.setHTML(`.
//     `document.writeln(` is deliberately NOT matched (spec vocabulary is exactly these
//     five tokens; `document.writeln(` is a declared review-lens item, not a gate).
//
// ANTI-VACUITY (ADR-0255 D4) is on files READ, never on sites matched: the site count
// legitimately reaches zero, so I18N-4 pins a NAMED roster of files that must each be
// present and non-empty after comment-stripping, and fails loudly naming any absent one.
// There is no numeric file-count floor (ADR-0224 amendment: no ratchets).
//
// RED REASON AT HEAD: I18N-1 finds the 13 live `.innerHTML =` sites (ADR-0255 measured
// population: shopView.ts x6, tradeView.ts x5, questLogView.ts x1, healView.ts x1) — see
// the assertion message for the exact file:line list. I18N-2/I18N-3/I18N-4 are already
// green at HEAD (the matcher and the roster are new but the population/files they assert
// on already satisfy them); they exist as proof-of-teeth for the SAME matcher I18N-1 uses.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The single-owner comment stripper (ADR-0215: no third stripper). Precedent for a `.ts`
// test importing a `.mjs` eval: render/motionPreference.test.ts:48.
import { stripComments } from '../../../evals/dom-shell-coverage-exclusion.eval.mjs';

const CLIENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ASSIGN_TOKENS = ['.innerHTML', '.outerHTML'];
const CALL_TOKENS = ['insertAdjacentHTML(', 'document.write(', '.setHTML('];
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

interface Hit {
  readonly sink: string;
  readonly index: number;
}

/** ADR-0255 D3. `indexOf` loops only — no regex literal, no `new RegExp`. */
function findHtmlSinks(code: string): Hit[] {
  const hits: Hit[] = [];
  for (const token of ASSIGN_TOKENS) {
    let from = 0;
    for (;;) {
      const at = code.indexOf(token, from);
      if (at === -1) break;
      from = at + token.length;
      let j = at + token.length;
      while (j < code.length && WHITESPACE.has(code[j])) j++;
      if (code[j] === '=' && code[j + 1] !== '=') {
        hits.push({ sink: `${token} =`, index: at });
      } else if (code[j] === '+' && code[j + 1] === '=') {
        hits.push({ sink: `${token} +=`, index: at });
      }
    }
  }
  for (const token of CALL_TOKENS) {
    let from = 0;
    for (;;) {
      const at = code.indexOf(token, from);
      if (at === -1) break;
      from = at + token.length;
      hits.push({ sink: token, index: at });
    }
  }
  return hits;
}

interface ScanResult {
  readonly files: readonly string[];
  readonly sinks: ReadonlyArray<{
    readonly file: string;
    readonly sink: string;
    readonly line: number;
  }>;
  readonly stripped: ReadonlyMap<string, string>;
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(rel);
    }
  }
}

let cached: ScanResult | undefined;

/** Memoised: the tree is walked and every file read/stripped exactly once. */
function scan(): ScanResult {
  if (cached) return cached;
  const files: string[] = [];
  walk(CLIENT_SRC, '', files);
  files.sort();
  const sinks: Array<{ file: string; sink: string; line: number }> = [];
  const stripped = new Map<string, string>();
  for (const rel of files) {
    const raw = readFileSync(path.join(CLIENT_SRC, ...rel.split('/')), 'utf8');
    const clean = stripComments(raw);
    stripped.set(rel, clean);
    for (const hit of findHtmlSinks(clean)) {
      const line = clean.slice(0, hit.index).split('\n').length;
      sinks.push({ file: rel, sink: hit.sink, line });
    }
  }
  cached = { files, sinks, stripped };
  return cached;
}

describe('i18n-no-html-sink (M24 S0, ADR-0255)', () => {
  it('m24s0 I18N-1: zero .innerHTML = / .outerHTML = assignment sites in non-test client/src/**/*.ts (RHS-independent)', () => {
    const assignmentHits = scan().sinks.filter((h) => h.sink.endsWith('='));
    const message =
      assignmentHits.length === 0
        ? undefined
        : `HTML-parsing assignment sink(s):\n${assignmentHits
            .map((h) => `${h.file}:${h.line} ${h.sink}`)
            .join('\n')}`;
    expect(assignmentHits, message).toEqual([]);
  });

  it('m24s0 I18N-2: zero insertAdjacentHTML( / document.write( / .setHTML( call sites in non-test client/src/**/*.ts', () => {
    const callHits = scan().sinks.filter((h) => h.sink.endsWith('('));
    const message =
      callHits.length === 0
        ? undefined
        : `HTML-parsing call sink(s):\n${callHits.map((h) => `${h.file}:${h.line} ${h.sink}`).join('\n')}`;
    expect(callHits, message).toEqual([]);
  });

  it("m24s0 I18N-3: the spec fixture list.innerHTML = t('shop.empty') is flagged by findHtmlSinks itself, RHS-independently", () => {
    // THE fixture: the catalog value is the RHS, and the sink is flagged anyway.
    expect(findHtmlSinks("list.innerHTML = t('shop.empty')")).toEqual([
      { sink: '.innerHTML =', index: 4 },
    ]);
    // Newline-split token/operator — the whitespace-skip includes '\n'.
    expect(findHtmlSinks('el.innerHTML\n  = markup;')).toEqual([
      { sink: '.innerHTML =', index: 2 },
    ]);
    // `+=` is an assignment too.
    expect(findHtmlSinks('el.innerHTML += x;')).toEqual([{ sink: '.innerHTML +=', index: 2 }]);
    // `===` / `==` are getter READS, never flagged.
    expect(findHtmlSinks("if (el.innerHTML === '') {}")).toEqual([]);
    expect(findHtmlSinks("el.innerHTML == ''")).toEqual([]);
    // A sink mentioned only inside a comment, after stripping, is invisible to the matcher.
    expect(findHtmlSinks(stripComments("// el.innerHTML = 'x'\nconst a = 1;\n"))).toEqual([]);
    expect(
      findHtmlSinks(stripComments("/* list.innerHTML = t('shop.empty') */\nconst a = 1;\n")),
    ).toEqual([]);
    // The call family, through the SAME function.
    expect(findHtmlSinks('x.insertAdjacentHTML("beforeend", s)')).toEqual([
      { sink: 'insertAdjacentHTML(', index: 2 },
    ]);
    expect(findHtmlSinks('document.write(s)')).toEqual([{ sink: 'document.write(', index: 0 }]);
    expect(findHtmlSinks('el.setHTML(s)')).toEqual([{ sink: '.setHTML(', index: 2 }]);
    // A same-prefixed but different call is NOT a hit.
    expect(findHtmlSinks('el.insertAdjacentElement("afterend", n)')).toEqual([]);
  });

  it('m24s0 I18N-4: the walk read every named roster file and each is non-empty after stripping', () => {
    // ADR-0255 D4: the five S0 view files, main.ts, and one canary file per other
    // top-level client/src subdirectory. No numeric file-count floor.
    const roster = [
      'main.ts',
      'ui/shopView.ts',
      'ui/tradeView.ts',
      'ui/questLogView.ts',
      'ui/healView.ts',
      'ui/dialogueView.ts',
      'convert/convert.ts',
      'module_bindings/accept_challenge_reducer.ts',
      'net/authToken.ts',
      'observability/attributes.ts',
      'prediction/heldKeys.ts',
      'render/camera.ts',
      'shared/interpConfig.ts',
    ];
    const { files, stripped } = scan();
    for (const f of roster) {
      expect(files, `roster file missing from walk: ${f}`).toContain(f);
      expect(stripped.get(f)!.trim().length, `${f} is empty after stripping`).toBeGreaterThan(0);
    }
  });
});
