import { createHash } from 'node:crypto';
import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH } from './devPassword.ts';

const STYLE =
  'body{font-family:system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}' +
  'label,input,button{display:block;width:100%;box-sizing:border-box}' +
  'input,button{margin:.25rem 0 1rem;padding:.5rem;font:inherit}' +
  '[role=alert]{font-weight:600}';

/**
 * Sent with every page. The policy loads nothing: the one style sheet is inline and admitted by
 * its hash. There is no `form-action`: Chrome applies it to the redirect that follows the post,
 * and that redirect ends at the game's origin.
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // `same-origin`, not `no-referrer`: under `no-referrer` a browser posts the form with
  // `Origin: null`, and the router admits a post only from the issuer's own origin.
  'referrer-policy': 'same-origin',
  'content-security-policy': [
    "default-src 'none'",
    `style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; '),
};

const NOTICES = {
  refused: 'Wrong email or password.',
  locked: 'Too many attempts. Try again in a few minutes.',
  busy: 'The service is busy. Try again in a moment.',
} as const;

/**
 * The email and password form of the dev sign-in. `action` is the path the form posts to. With
 * `steam`, Steam's login address for this sign-in, the page also offers the Steam sign-in as one
 * link to it. Those two are all a caller supplies, so the page never carries an email or a
 * password back.
 */
export function signInPage(options: {
  readonly action: string;
  readonly notice?: keyof typeof NOTICES;
  readonly steam?: string;
}): string {
  const notice =
    options.notice === undefined ? '' : `<p role="alert">${NOTICES[options.notice]}</p>`;
  const steam =
    options.steam === undefined
      ? ''
      : `<p><a href="${escapeHtml(options.steam)}">Sign in through Steam</a></p>`;
  return page(
    'Sign in to Monster Realm',
    `<h1>Sign in</h1><p>Development and test accounts only.</p>${notice}` +
      `<form method="post" action="${escapeHtml(options.action)}">` +
      '<label for="email">Email</label>' +
      `<input id="email" name="email" type="email" autocomplete="username" required maxlength="${MAX_EMAIL_LENGTH}">` +
      '<label for="password">Password</label>' +
      `<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="${MAX_PASSWORD_LENGTH}">` +
      `<button type="submit">Sign in</button></form>${steam}`,
  );
}

/** Shown to an account that signed in and does not own the game. It names nothing about the account. */
export function notOwnedPage(): string {
  return page(
    'Monster Realm is not owned',
    '<h1>This account does not own Monster Realm</h1><p>Playing needs a copy of the game.</p>',
  );
}

/** Shown when a sign-in cannot be continued: it expired, or its cookies are not this browser's. */
export function endedPage(): string {
  return page(
    'Sign-in ended',
    '<h1>This sign-in has ended</h1><p>Go back to the game and start signing in again.</p>',
  );
}

/** Shown when Steam gave no answer about a sign-in. It names nothing about the account. */
export function unavailablePage(): string {
  return page(
    'Steam could not be reached',
    '<h1>Steam could not be reached</h1><p>Go back to the game and sign in again in a few minutes.</p>',
  );
}

function page(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${STYLE}</style></head><body>${body}</body></html>`
  );
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ENTITIES[character]);
}
