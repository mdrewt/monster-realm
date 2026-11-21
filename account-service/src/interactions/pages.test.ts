import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { endedPage, notOwnedPage, PAGE_HEADERS, signInPage } from './pages.ts';

const ACTION = '/interaction/AbCdEfGh0123456789_-';
const NOTICES = ['refused', 'locked', 'busy'] as const;

interface Element {
  readonly name: string;
  readonly attrs: Map<string, string>;
  readonly raw: string;
}

// An opening tag: quoted attribute values may hold `>`.
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributes(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (!map.has(name)) map.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return map;
}

function elements(html: string, name?: string): Element[] {
  const found: Element[] = [];
  for (const match of html.matchAll(OPEN_TAG)) {
    const tag = match[1]!.toLowerCase();
    if (name !== undefined && tag !== name) continue;
    found.push({ name: tag, attrs: attributes(match[2]!), raw: match[2]! });
  }
  return found;
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_all, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return named[entity]!;
  });
}

/** The text inside every element whose opening tag carries role="alert". */
function alerts(html: string): string[] {
  const texts: string[] = [];
  // Every opening tag is examined, nested ones included; an alert's text runs to its own
  // closing tag, counting nested elements of the same name.
  for (const match of html.matchAll(OPEN_TAG)) {
    if (attributes(match[2]!).get('role') !== 'alert') continue;
    const name = match[1]!.toLowerCase();
    const start = (match.index ?? 0) + match[0].length;
    const tags = new RegExp(`<(/?)${name}\\b(?:"[^"]*"|'[^']*'|[^'">])*>`, 'gi');
    tags.lastIndex = start;
    let depth = 1;
    let end = html.length;
    for (let tag = tags.exec(html); tag !== null; tag = tags.exec(html)) {
      depth += tag[1] === '/' ? -1 : 1;
      if (depth === 0) {
        end = tag.index;
        break;
      }
    }
    texts.push(
      decode(html.slice(start, end).replace(/<[^>]*>/g, ''))
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return texts;
}

function header(name: string): string | undefined {
  const entry = Object.entries(PAGE_HEADERS).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

function cspDirectives(): Map<string, string[]> {
  const csp = header('content-security-policy') ?? '';
  const map = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    map.set(tokens[0]!.toLowerCase(), tokens.slice(1));
  }
  return map;
}

function formOf(html: string): { attrs: Map<string, string>; body: string } {
  const match = /<form\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/form\s*>/i.exec(html);
  expect(match, 'a form element').not.toBeNull();
  return { attrs: attributes(match![1]!), body: match![2]! };
}

function allPages(): Array<[string, string]> {
  return [
    ['the sign-in form', signInPage({ action: ACTION })],
    ...NOTICES.map((notice): [string, string] => [
      `the form with the ${notice} notice`,
      signInPage({ action: ACTION, notice }),
    ]),
    ['the not-owned page', notOwnedPage()],
    ['the ended page', endedPage()],
  ];
}

describe('PAGE_HEADERS', () => {
  test('are exactly the six page headers with their fixed values acs-2.2', () => {
    const names = Object.keys(PAGE_HEADERS).map((name) => name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(
      [
        'cache-control',
        'content-security-policy',
        'content-type',
        'referrer-policy',
        'x-content-type-options',
        'x-frame-options',
      ].sort(),
    );
    expect(header('content-type')).toBe('text/html; charset=utf-8');
    expect(header('cache-control')).toBe('no-store');
    expect(header('x-content-type-options')).toBe('nosniff');
    expect(header('x-frame-options')).toBe('DENY');
    expect(header('referrer-policy')).toBe('same-origin');
  });

  test('the content security policy loads nothing, frames nowhere and styles only by hash acs-2.2', () => {
    const csp = cspDirectives();
    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    const style = csp.get('style-src');
    expect(style, 'a style-src directive').toBeDefined();
    expect(style!.length).toBeGreaterThan(0);
    for (const source of style!) {
      expect(source).toMatch(/^'sha(256|384|512)-[A-Za-z0-9+/]+={0,2}'$/);
    }
    expect(header('content-security-policy')).not.toMatch(/unsafe-inline/i);
    expect(csp.has('form-action')).toBe(false);
  });

  test('every inline style of every page is one the policy lets through by its hash', () => {
    const allowed = new Set(cspDirectives().get('style-src') ?? []);
    for (const [name, html] of allPages()) {
      for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
        const body = match[1]!;
        const hashes = ['sha256', 'sha384', 'sha512'].map(
          (alg) => `'${alg}-${createHash(alg).update(body, 'utf8').digest('base64')}'`,
        );
        expect(
          hashes.some((hash) => allowed.has(hash)),
          `${name}: a <style> the policy blocks`,
        ).toBe(true);
      }
      // A hash-only style-src blocks style attributes.
      for (const element of elements(html)) {
        expect(element.attrs.has('style'), `${name}: a style attribute on <${element.name}>`).toBe(
          false,
        );
      }
    }
  });
});

describe('every page', () => {
  test.each(
    allPages(),
  )('%s is a complete HTML document with no script, handler or external URL acs-2.2', (_name, html) => {
    expect(html).toMatch(/^\s*<!doctype html>/i);
    const htmlTags = elements(html, 'html');
    expect(htmlTags).toHaveLength(1);
    expect(htmlTags[0]!.attrs.get('lang')).toBe('en');
    expect(html).toMatch(/<title>[^<]*\S[^<]*<\/title>/i);
    expect(html).toMatch(/<\/html>\s*$/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/https?:/i);
    for (const element of elements(html)) {
      for (const [attr, value] of element.attrs) {
        expect(attr.startsWith('on'), `<${element.name} ${attr}>`).toBe(false);
        if (attr === 'src' || attr === 'href' || attr === 'srcset' || attr === 'action') {
          expect(value.startsWith('//'), `<${element.name} ${attr}=${value}>`).toBe(false);
        }
      }
      expect(element.name).not.toBe('iframe');
      expect(element.name).not.toBe('img');
      expect(element.name).not.toBe('link');
    }
  });

  test('the same call renders the same bytes every time', () => {
    const first = allPages().map(([, html]) => html);
    const second = allPages().map(([, html]) => html);
    expect(second).toEqual(first);
  });

  test('the form, the not-owned page and the ended page are three different pages acs-2.2', () => {
    const pages = new Set([signInPage({ action: ACTION }), notOwnedPage(), endedPage()]);
    expect(pages.size).toBe(3);
  });
});

describe('signInPage', () => {
  test.each([
    undefined,
    ...NOTICES,
  ])('with notice %s it posts one email and one password field to its action', (notice) => {
    const html = signInPage(notice === undefined ? { action: ACTION } : { action: ACTION, notice });
    expect(elements(html, 'form')).toHaveLength(1);
    const form = formOf(html);
    expect(form.attrs.get('method')?.toLowerCase()).toBe('post');
    expect(decode(form.attrs.get('action') ?? '')).toBe(ACTION);

    const inputs = elements(html, 'input').filter((input) => input.attrs.get('type') !== 'hidden');
    const email = inputs.filter((input) => input.attrs.get('name') === 'email');
    const password = inputs.filter((input) => input.attrs.get('name') === 'password');
    expect(email).toHaveLength(1);
    expect(password).toHaveLength(1);
    expect(email[0]!.attrs.get('type')).toBe('email');
    expect(email[0]!.attrs.get('autocomplete')).toBe('username');
    expect(email[0]!.attrs.has('required')).toBe(true);
    expect(email[0]!.attrs.get('maxlength')).toBe('254');
    expect(password[0]!.attrs.get('type')).toBe('password');
    expect(password[0]!.attrs.get('autocomplete')).toBe('current-password');
    expect(password[0]!.attrs.has('required')).toBe(true);
    expect(password[0]!.attrs.get('maxlength')).toBe('128');
    // The page never carries an email or a password back.
    expect(email[0]!.attrs.has('value')).toBe(false);
    expect(password[0]!.attrs.has('value')).toBe(false);

    // Both fields and a submit control sit inside the form.
    expect(
      elements(form.body, 'input').filter((i) => i.attrs.get('name') === 'email'),
    ).toHaveLength(1);
    expect(
      elements(form.body, 'input').filter((i) => i.attrs.get('name') === 'password'),
    ).toHaveLength(1);
    const submits = [
      ...elements(form.body, 'button').filter(
        (b) => (b.attrs.get('type') ?? 'submit') === 'submit',
      ),
      ...elements(form.body, 'input').filter((i) => i.attrs.get('type') === 'submit'),
    ];
    expect(submits.length).toBeGreaterThanOrEqual(1);

    // Each field has a label: one naming its id, or one wrapping it.
    const labels = [
      ...html.matchAll(/<label\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/label\s*>/gi),
    ];
    for (const field of [email[0]!, password[0]!]) {
      const id = field.attrs.get('id');
      const labelled = labels.some((label) => {
        const forId = attributes(label[1]!).get('for');
        if (id !== undefined && forId === id) return true;
        return elements(label[2]!, 'input').some((i) => i.raw === field.raw);
      });
      expect(labelled, `a label for ${field.attrs.get('name')}`).toBe(true);
    }
  });

  test('without a notice the form has no alert, and each notice adds exactly one alert with text acs-2.2', () => {
    expect(alerts(signInPage({ action: ACTION }))).toEqual([]);
    expect(
      elements(signInPage({ action: ACTION })).some((e) => e.attrs.get('role') === 'alert'),
    ).toBe(false);
    for (const notice of NOTICES) {
      const html = signInPage({ action: ACTION, notice });
      expect(
        elements(html).filter((e) => e.attrs.get('role') === 'alert'),
        notice,
      ).toHaveLength(1);
      const texts = alerts(html);
      expect(texts, notice).toHaveLength(1);
      expect(texts[0]!.length, notice).toBeGreaterThan(0);
    }
  });

  test('the three notices give three different pages, each different from the page without one acs-2.2', () => {
    const plain = signInPage({ action: ACTION });
    const noticed = NOTICES.map((notice) => signInPage({ action: ACTION, notice }));
    expect(new Set([plain, ...noticed]).size).toBe(4);
    const texts = NOTICES.map((notice) => alerts(signInPage({ action: ACTION, notice }))[0]);
    expect(new Set(texts).size).toBe(3);
  });

  test('the action is the only thing a caller changes: it appears once and nothing else moves', () => {
    const a = '/interaction/AAAAAAAAAAAAAAAA';
    const b = '/interaction/BBBBBBBBBBBBBBBB';
    for (const notice of [undefined, ...NOTICES]) {
      const pageA = signInPage(notice === undefined ? { action: a } : { action: a, notice });
      const pageB = signInPage(notice === undefined ? { action: b } : { action: b, notice });
      expect(pageA.split(a)).toHaveLength(2);
      expect(pageA.split(a).join(b)).toBe(pageB);
    }
  });

  test.each([
    ['a double quote and a tag', '/interaction/x"><script>alert(1)</script><a href="'],
    ['an ampersand', '/interaction/a&b&amp;c'],
    ['a single quote and a less-than', "/interaction/x' onfocus='alert(1)'<"],
    ['a greater-than and an entity', '/interaction/&quot;>&#34;'],
  ])('an action with %s stays inside the attribute, escaped', (_name, action) => {
    const plain = '/interaction/PLAINPLAINPLAIN';
    const html = signInPage({ action });
    expect(html).not.toMatch(/<script/i);
    expect(elements(html, 'form')).toHaveLength(1);
    const form = formOf(html);
    const raw = form.attrs.get('action') ?? '';
    expect(decode(raw)).toBe(action);
    expect(raw).not.toMatch(/[<"]/);
    expect(raw).not.toMatch(/&(?!(?:#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);)/);
    for (const [attr] of form.attrs) expect(attr.startsWith('on'), attr).toBe(false);
    // Apart from the escaped action, the page is the page for a plain action.
    const plainHtml = signInPage({ action: plain });
    expect(plainHtml.split(plain)).toHaveLength(2);
    expect(plainHtml.split(plain).join(raw)).toBe(html);
  });
});

describe('notOwnedPage and endedPage', () => {
  test('the not-owned page takes nothing: any argument leaves it byte-identical and unnamed acs-2.2', () => {
    const page = notOwnedPage();
    const withJunk = (notOwnedPage as (...args: unknown[]) => string)('player@example.com', {
      sub: 'dev:11111111-1111-4111-8111-111111111111',
      email: 'player@example.com',
    });
    expect(withJunk).toBe(page);
    const withAccount = (notOwnedPage as (...args: unknown[]) => string)({
      sub: 'dev:22222222-2222-4222-8222-222222222222',
      email: 'other@example.com',
      entitled: false,
    });
    expect(withAccount).toBe(page);
    expect(page).not.toContain('player@example.com');
    expect(page).not.toContain('dev:');
  });

  test('the ended page takes nothing: any argument leaves it byte-identical', () => {
    const page = endedPage();
    const withJunk = (endedPage as (...args: unknown[]) => string)('/interaction/abc', {
      action: '/interaction/abc',
    });
    expect(withJunk).toBe(page);
    expect(page).not.toContain('/interaction/abc');
  });
});
