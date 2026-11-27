import type { IncomingMessage, ServerResponse } from 'node:http';
import type Provider from 'oidc-provider';
import { type Adapter, errors } from 'oidc-provider';
import type { SignInMethod } from '../config.ts';
import { devPasswordStep } from './devPassword.ts';
import { endedPage, notOwnedPage, PAGE_HEADERS, signInPage } from './pages.ts';

export interface Account {
  readonly sub: string;
  readonly entitled: boolean;
  /** The epoch second the password was last reset. A code or refresh token issued, or signed in
   *  for, in an earlier second is refused. Absent: never reset. */
  readonly passwordChangedAt?: number;
}

export type SignInOutcome =
  | { readonly kind: 'signed-in'; readonly sub: string }
  /** The right password for an account that is not entitled. */
  | { readonly kind: 'not-owned' }
  /** Wrong email or password; it never says which. */
  | { readonly kind: 'refused' }
  /** This email has had too many failures. */
  | { readonly kind: 'locked' }
  /** Too many attempts are being checked at once; nothing was counted. */
  | { readonly kind: 'busy' };

/** A sign-in step that asks for an email and a password. */
export interface PasswordStep {
  readonly kind: 'password';
  attempt(email: string, password: string): Promise<SignInOutcome>;
  /** The account behind a subject, read afresh at every issuance; undefined when there is none. */
  account(sub: string): Promise<Account | undefined>;
}

/** How a profile signs a player in. The router shows each kind's step; the provider asks `account`. */
export type SignInStep = PasswordStep;

/** The step of a profile's sign-in method. This build has none for `steam`. */
export function signInStepFor(
  method: SignInMethod,
  adapter: (model: string) => Adapter,
): SignInStep | undefined {
  switch (method) {
    case 'dev-password':
      return devPasswordStep(adapter);
    case 'steam':
      return undefined;
  }
}

/** The path of the sign-in step of the authorization request `uid`. */
export function interactionPath(uid: string): string {
  return `/interaction/${uid}`;
}

/** The `uid` a request path names as a sign-in step, or undefined for any other path. */
export function interactionUid(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  return /^\/interaction\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
}

const FORM_TYPE = 'application/x-www-form-urlencoded';
const MAX_BODY_BYTES = 8192;

/**
 * Answers `/interaction/<uid>`, the sign-in step of one authorization request; the caller passes
 * the `uid` the path names. A request is tied to its sign-in by the signed cookie the provider set
 * when the request began, and a post is taken only from the issuer's own page.
 */
export function createInteractionRouter(options: {
  readonly provider: Provider;
  readonly issuer: string;
  readonly signIn: SignInStep;
}): (req: IncomingMessage, res: ServerResponse, uid: string) => Promise<void> {
  const { provider, signIn } = options;
  const origin = new URL(options.issuer).origin;

  const answer = async (req: IncomingMessage, res: ServerResponse, uid: string): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      text(res, 405, 'this address takes GET and POST', { allow: 'GET, POST' });
      return;
    }
    if (req.method === 'POST') {
      if (req.headers.origin !== origin) {
        text(res, 403, 'the sign-in form is posted only from its own page');
        return;
      }
      if (mediaType(req) !== FORM_TYPE) {
        text(res, 415, `the sign-in form is posted as ${FORM_TYPE}`);
        return;
      }
    }

    const interaction = await liveSignIn(provider, req, res, uid);
    if (interaction === undefined) {
      page(res, 400, endedPage());
      return;
    }
    const action = interactionPath(interaction.uid);
    if (req.method === 'GET') {
      page(res, 200, signInPage({ action }));
      return;
    }
    if (interaction.result?.login !== undefined) {
      // A second post of a sign-in that has succeeded (a double click): the same way on.
      redirect(res, interaction.returnTo);
      return;
    }

    const body = await readBody(req);
    if (body === undefined) {
      text(res, 413, `the sign-in form is at most ${MAX_BODY_BYTES} bytes`, {
        connection: 'close',
      });
      return;
    }
    const fields = new URLSearchParams(body);
    const [email, ...otherEmails] = fields.getAll('email');
    const [password, ...otherPasswords] = fields.getAll('password');
    if (
      email === undefined ||
      password === undefined ||
      otherEmails.length > 0 ||
      otherPasswords.length > 0
    ) {
      text(res, 400, 'the sign-in form has one email and one password');
      return;
    }

    // The second the password check starts becomes the session's login time, which every code and
    // refresh token of this sign-in carries as `authTime`: a reset in a later second ends them,
    // however late the resume that mints the code. Read before the check, so a reset that lands
    // while the hash is computed still ends them.
    const checkedAt = Math.floor(Date.now() / 1000);
    const outcome = await signIn.attempt(email, password);
    switch (outcome.kind) {
      case 'signed-in': {
        const grant = new provider.Grant({
          accountId: outcome.sub,
          clientId: String(interaction.params.client_id),
        });
        grant.addOIDCScope('openid');
        const grantId = await grant.save();
        redirect(
          res,
          await provider.interactionResult(
            req,
            res,
            {
              login: { accountId: outcome.sub, remember: false, ts: checkedAt },
              consent: { grantId },
            },
            { mergeWithLastSubmission: false },
          ),
        );
        return;
      }
      case 'not-owned':
        page(res, 403, notOwnedPage());
        return;
      case 'refused':
        page(res, 400, signInPage({ action, notice: 'refused' }));
        return;
      case 'locked':
        page(res, 429, signInPage({ action, notice: 'locked' }));
        return;
      case 'busy':
        page(res, 503, signInPage({ action, notice: 'busy' }));
        return;
    }
  };

  return async (req, res, uid) => {
    try {
      await answer(req, res, uid);
    } catch (error) {
      console.error('account-service: the sign-in step failed:', error);
      if (res.headersSent) res.destroy();
      else text(res, 500, 'the sign-in could not be completed');
    }
  };
}

/** The sign-in the request's cookies belong to, when it is the one the path names and still live. */
async function liveSignIn(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  uid: string,
): Promise<Awaited<ReturnType<Provider['interactionDetails']>> | undefined> {
  try {
    const interaction = await provider.interactionDetails(req, res);
    return interaction.uid === uid && interaction.prompt.name === 'login' ? interaction : undefined;
  } catch (error) {
    if (error instanceof errors.SessionNotFound) return undefined;
    throw error;
  }
}

function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * The request body as text, or undefined when it is over the limit or its sender went away. The
 * rest of an oversized body is discarded as it arrives, so the refusal still reaches the sender.
 */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off('data', onData);
        req.resume();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.once('error', () => {
      resolve(undefined);
    });
  });
}

function page(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, PAGE_HEADERS);
  res.end(html);
}

function text(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(`${message}\n`);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, {
    location,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': '0',
  });
  res.end();
}
