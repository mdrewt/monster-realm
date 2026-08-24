// render/world.test.ts — m23-s4 pure SOURCE SCAN for the canvas region ARIA attributes
// (M23-accessibility.spec.md §9.3, §2.3 D8; ADR-0205 A2/A9).
//
// world.ts is coverage-excluded (client/vite.config.ts) and drags PixiJS into vitest if
// imported, so this file NEVER imports it — it is a pure text scan, modelled on
// client/src/render/motionPreference.test.ts's `stripComments` + inline CONTROL
// (plan §8 A9). Comment-stripping ONLY: the three writes ARE string literals
// (`'application'`, `'0'`, `t('a11y.world.region')`), so a string-aware stripper would
// eat the very thing being checked.
//
// RED REASON: world.ts does not yet call setAttribute('role', ...) / ('tabindex', ...) /
// ('aria-label', ...) on app.canvas anywhere, and a11yCopy.ts does not yet carry the
// 'a11y.world.region' key — every clause below fails today.
//
// CONDITIONAL CONTROL (plan §8 A9 CONDITIONAL): this stripper is a COPY of
// motionPreference.test.ts's (not an import — that function is not exported), so its two
// CONTROL fixtures ride along here too: a comment-only decoy must FAIL detection, a real
// call must PASS.
//
// BRACE-SCOPED, red-team CRITICAL (plan §8 A2): "the three writes appear somewhere after
// the anchor" passes a wrong implementation that leaves init() untouched and parks the
// three setAttribute calls in a PRIVATE METHOD nothing calls (PoC'd green while the real
// canvas gets zero ARIA). This scan locates `async init(` and its brace-matched closing
// `}` by depth counting, and requires the anchor AND all three writes to fall INSIDE that
// span, on the `app.canvas` receiver, after the anchor index.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { a11yCopy, t } from '../ui/a11yCopy';

// Comment delimiters, COMPOSED rather than written out (motionPreference.test.ts
// precedent), so this file itself contains no raw block-comment opener outside a real
// comment — a measured false-RED class in naive comment-stripping scanners elsewhere.
const SLASH = '/';
const STAR = '*';
const LINE_OPEN = SLASH + SLASH;
const BLOCK_OPEN = SLASH + STAR;
const BLOCK_CLOSE = STAR + SLASH;

/** Strip `//` line comments and block comments. String-literal-BLIND on purpose: the
 *  three writes under test ARE string literals, so a string-aware pass would eat them. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === LINE_OPEN) {
      while (i < src.length && src.charAt(i) !== '\n') i++;
    } else if (two === BLOCK_OPEN) {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== BLOCK_CLOSE) i++;
      i += 2;
    } else {
      out += src.charAt(i);
      i++;
    }
  }
  return out;
}

/** Fail-loud read off import.meta.url — a silently-empty read passes every "must
 *  contain"/"must not contain" clause vacuously. */
function readWorldSource(): string {
  const abs = fileURLToPath(new URL('./world.ts', import.meta.url));
  try {
    return readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(
      'client/src/render/world.ts unreadable at expected path: ' + abs + ' — ' + String(err),
    );
  }
}

function readIndexHtml(): string {
  const abs = fileURLToPath(new URL('../../index.html', import.meta.url));
  try {
    return readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error('client/index.html unreadable at expected path: ' + abs + ' — ' + String(err));
  }
}

/** Brace-match the body of `async init(`, starting at its opening `{`. Returns the
 *  [start,end) character span of the body (exclusive of both braces) or null if the
 *  anchor cannot be found / the braces never balance. Depth counting, not regex — this
 *  is the ONLY robust way to find "this method's own closing brace" in a file whose body
 *  legitimately contains nested braces (if/for/loops). */
function initMethodBody(stripped: string): { start: number; end: number } | null {
  const anchor = stripped.indexOf('async init(');
  if (anchor < 0) return null;
  const openBrace = stripped.indexOf('{', anchor);
  if (openBrace < 0) return null;
  let depth = 0;
  for (let i = openBrace; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth === 0) return { start: openBrace + 1, end: i };
    }
  }
  return null;
}

describe('render/world.ts — canvas region ARIA scan (S4-WORLD-CANVAS-REGION, A11Y-08/A11Y-17, spec §9.3)', () => {
  it('S4-WORLD-CANVAS-REGION BITES: role="application" + tabindex="0" + aria-label=t(...) land on app.canvas INSIDE init(), after the mount.appendChild anchor, and #app carries no role', () => {
    // ---- CONTROL (plan A9 CONDITIONAL — this stripper is a COPY, not an import) --------
    const lineFixture =
      'const a = 1; ' +
      LINE_OPEN +
      " app.canvas.setAttribute('role','application')\nconst b = 2;\n";
    const blockFixture =
      'const a = 1; ' +
      BLOCK_OPEN +
      " app.canvas.setAttribute('role','application') " +
      BLOCK_CLOSE +
      ' const b = 2;\n';
    expect(
      stripComments(lineFixture).includes('setAttribute'),
      'CONTROL: a decoy call hidden in a // comment must be STRIPPED (a comment-only decoy ' +
        'must FAIL detection)',
    ).toBe(false);
    expect(
      stripComments(blockFixture).includes('setAttribute'),
      'CONTROL: a decoy call hidden in a /* */ comment must be STRIPPED',
    ).toBe(false);
    const realCallFixture =
      "mount.appendChild(app.canvas);\napp.canvas.setAttribute('role', 'application');\n";
    expect(
      stripComments(realCallFixture).includes('setAttribute'),
      'CONTROL: a REAL call outside any comment must SURVIVE stripping (the positive control)',
    ).toBe(true);
    expect(stripComments(realCallFixture).includes('mount.appendChild(app.canvas)')).toBe(true);

    // ---- clause 1: fail-loud read + clause 2: anti-vacuity ----------------------------
    const raw = readWorldSource();
    expect(raw.length, 'ANTI-VACUITY: world.ts must not read as an empty string').toBeGreaterThan(
      0,
    );
    const stripped = stripComments(raw);
    expect(
      stripped.includes('export class WorldRenderer'),
      'ANTI-VACUITY: the class declaration must survive stripping',
    ).toBe(true);

    // ---- clause 3: fail-loud anchor, BRACE-SCOPED to init() (red-team CRITICAL) -------
    const anchorNeedle = 'mount.appendChild(app.canvas)';
    const anchorIndex = stripped.indexOf(anchorNeedle);
    expect(
      anchorIndex,
      'FAIL-LOUD ANCHOR (spec §9.3 verbatim): "mount.appendChild(app.canvas)" must appear in ' +
        'the stripped source — if this is -1 the refactor moved/renamed the mount call and the ' +
        'scan below cannot locate the canvas at all',
    ).toBeGreaterThanOrEqual(0);

    const body = initMethodBody(stripped);
    expect(
      body,
      'FAIL-LOUD ANCHOR: "async init(" must brace-match to a closing "}" — if this is null the ' +
        'method signature moved or changed shape',
    ).not.toBeNull();
    expect(
      anchorIndex,
      "the mount.appendChild anchor must fall INSIDE init()'s own matched body",
    ).toBeGreaterThanOrEqual(body!.start);
    expect(
      anchorIndex,
      "the mount.appendChild anchor must fall INSIDE init()'s own matched body",
    ).toBeLessThan(body!.end);

    const initBody = stripped.slice(body!.start, body!.end);
    const anchorIndexInBody = anchorIndex - body!.start;
    const afterAnchor = initBody.slice(anchorIndexInBody + anchorNeedle.length);

    // BRACE-SCOPED, red-team CRITICAL (plan A2): "somewhere later in the file" passes a
    // wrong impl that parks the three calls in a PRIVATE METHOD nothing calls (anchor
    // found, all three writes present, on app.canvas, in t(...) form — PASS, while the
    // real canvas gets zero ARIA). Requiring the writes AFTER the anchor WITHIN init()'s
    // own matched body (never "later in the file") closes that hole. Whitespace-tolerant
    // (multi-line calls are legal), but the argument order/quoting is pinned exactly.
    const roleRe = /app\.canvas\.setAttribute\(\s*'role'\s*,\s*'application'\s*\)/;
    const tabindexRe = /app\.canvas\.setAttribute\(\s*'tabindex'\s*,\s*'0'\s*\)/;
    const ariaLabelRe =
      /app\.canvas\.setAttribute\(\s*'aria-label'\s*,\s*t\(\s*'a11y\.world\.region'\s*\)\s*\)/;

    expect(
      roleRe.test(afterAnchor),
      "MISSING/MISPLACED: expected app.canvas.setAttribute('role', 'application') inside " +
        'init(), after the mount.appendChild anchor. A private-method placement (the ' +
        'red-team PoC) must NOT satisfy this scan',
    ).toBe(true);
    expect(
      tabindexRe.test(afterAnchor),
      "MISSING/MISPLACED: expected app.canvas.setAttribute('tabindex', '0') inside init(), " +
        'after the anchor',
    ).toBe(true);
    expect(
      ariaLabelRe.test(afterAnchor),
      "MISSING/MISPLACED: expected app.canvas.setAttribute('aria-label', t('a11y.world.region')) " +
        "inside init(), after the anchor — a raw literal instead of t('a11y.world.region') fails " +
        'this exact-form check (§2.8 no-raw-literal)',
    ).toBe(true);

    // ---- clause 4: every t('...') key extracted from the STRIPPED source resolves in the
    // REAL a11yCopy, count >= 1. One assertion, four jobs (R5 boot-crash guard, D5 orphan
    // obligation, §2.8 no-raw-literal, key validity).
    const tCalls = [...stripped.matchAll(/t\('([^']+)'\)/g)].map((m) => m[1] as string);
    expect(
      tCalls.length,
      'a raw literal (no t(...) call) yields ZERO matches here — the count floor is what ' +
        'makes that shape red',
    ).toBeGreaterThanOrEqual(1);
    for (const key of tCalls) {
      expect(
        () => t(key),
        `world.ts calls t('${key}') — that key must resolve in the REAL a11yCopy catalog, or ` +
          'WorldRenderer.init() throws at runtime and the client never boots',
      ).not.toThrow();
    }
    expect(tCalls, "world.ts must call t('a11y.world.region') specifically").toContain(
      'a11y.world.region',
    );

    // D5 ORPHAN OBLIGATION: every a11y.world.* key in the catalog must be referenced by
    // world.ts's own t(...) calls (the slice that owns the consumer owns the orphan check).
    const worldKeys = Object.keys(a11yCopy).filter((k) => k.startsWith('a11y.world.'));
    for (const key of worldKeys) {
      expect(
        tCalls,
        `a11y.world.* key "${key}" exists in the catalog but is never referenced by world.ts's ` +
          'own t(...) calls (D5 orphan obligation)',
      ).toContain(key);
    }

    // ---- clause 5: no mount.setAttribute('role' anywhere; #app carries no role --------
    expect(
      stripped.includes("mount.setAttribute('role'"),
      "world.ts must never call mount.setAttribute('role', ...) — role belongs on app.canvas, " +
        'never on the shared #app mount that four other overlays also append into',
    ).toBe(false);

    const html = readIndexHtml();
    const appTagMatch = html.match(/<div id="app"[^>]*>/);
    expect(
      appTagMatch,
      'FAIL-LOUD: client/index.html must contain an id="app" tag — if this is null the shell ' +
        'moved/renamed the mount element',
    ).not.toBeNull();
    expect(
      appTagMatch![0].includes('role='),
      'A11Y-17: #app itself must carry no role= attribute — role="application" belongs on ' +
        'app.canvas only (four other overlays also mount into #app; giving #app itself a role ' +
        'would swallow their dialog semantics)',
    ).toBe(false);
  });
});
