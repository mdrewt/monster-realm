import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Provider from 'oidc-provider';
import { type Adapter, errors } from 'oidc-provider';
import type { Config } from '../config.ts';
import { type SteamEntitlement, type SteamId, steamIdOfSubject } from '../steam/ownership.ts';
import { devPasswordStep } from './devPassword.ts';
import { endedPage, notOwnedPage, PAGE_HEADERS, signInPage, unavailablePage } from './pages.ts';
import { steamOpenIdStep } from './steamOpenId.ts';

export interface Account {
  readonly sub: string;
  readonly entitled: boolean;
  /** The epoch second the password was last reset. A code or refresh token issued, or signed in
   *  for, in an earlier second is refused. Absent: never reset, which is every Steam player's
   *  account, since a Steam player has no password here. What ends a Steam player's tokens is
   *  the entitlement read at each issuance. */
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

/** How a Steam sign-in ends once Steam has sent the browser back. */
export type SteamSignInOutcome =
  | { readonly kind: 'signed-in'; readonly sub: string }
  /** The reply is Steam's and this sign-in's; its player is not entitled. */
  | { readonly kind: 'not-owned' }
  /** The reply failed a check; it never says which. */
  | { readonly kind: 'refused' }
  /** Steam gave no answer. Nothing was learnt about the reply or its player. */
  | { readonly kind: 'unavailable' };

/** A sign-in step that sends the browser to Steam and decides the reply Steam sends it back with. */
export interface SteamStep {
  readonly kind: 'steam';
  /** Steam's login address for a sign-in that comes back to `returnTo`. */
  loginUrl(returnTo: string): string;
  /**
   * Decides Steam's reply: the query the browser came back with, against the address it was sent
   * out with and the sign-in's state.
   */
  complete(
    reply: URLSearchParams,
    expected: { readonly returnTo: string; readonly state: string },
  ): Promise<SteamSignInOutcome>;
  /** As `PasswordStep['account']`. Rejects when Steam gives no answer: never "not entitled". */
  account(sub: string): Promise<Account | undefined>;
}

/** A dev profile with Steam configured: the password form, and the Steam step beside it. */
export interface PasswordAndSteamStep {
  readonly kind: 'password-and-steam';
  readonly password: PasswordStep;
  readonly steam: SteamStep;
  /** A Steam player's subject is the Steam step's to answer; every other is the password step's. */
  account(sub: string): Promise<Account | undefined>;
}

/** How a profile signs a player in. The router shows each kind's step; the provider asks `account`. */
export type SignInStep = PasswordStep | SteamStep | PasswordAndSteamStep;

/**
 * The step of a profile's sign-in method. `steam` is given when Steam is configured for the
 * profile: `production` then signs in through Steam alone, and a dev profile offers Steam beside
 * its password form. `production` without it has no step, so nothing is issued.
 */
export function signInStepFor(
  config: Pick<Config, 'signIn' | 'issuer'>,
  adapter: (model: string) => Adapter,
  steam?: {
    /** The profile's entitlement source (`steamEntitlementSource`). */
    readonly entitlement: (steamId: SteamId) => Promise<SteamEntitlement>;
    readonly log: (line: string) => void;
    /** Replaces Steam's OpenID address, for a test's Steam fake. */
    readonly endpoint?: string;
  },
): SignInStep | undefined {
  const steamStep =
    steam === undefined
      ? undefined
      : steamOpenIdStep({ realm: new URL(config.issuer).origin, adapter, ...steam });
  switch (config.signIn) {
    case 'dev-password': {
      const password = devPasswordStep(adapter);
      if (steamStep === undefined) return password;
      return {
        kind: 'password-and-steam',
        password,
        steam: steamStep,
        account: (sub) =>
          steamIdOfSubject(sub) === undefined ? password.account(sub) : steamStep.account(sub),
      };
    }
    case 'steam':
      return steamStep;
  }
}

/** The path of the sign-in step of the authorization request `uid`. */
export function interactionPath(uid: string): string {
  return `/interaction/${uid}`;
}

/** The path Steam sends the browser back to for the sign-in `uid`. */
function steamReplyPath(uid: string): string {
  return `${interactionPath(uid)}/steam`;
}

const STEP_PATH = /^\/interaction\/([A-Za-z0-9_-]+)(\/steam)?$/;

/**
 * The `uid` a request path names as a sign-in step, or undefined for any other path. A step has
 * two paths: its page, and the one Steam sends the browser back to.
 */
export function interactionUid(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  return STEP_PATH.exec(path)?.[1];
}

const FORM_TYPE = 'application/x-www-form-urlencoded';
const MAX_BODY_BYTES = 8192;

/** What a request is answered with, decided apart from the request that asked. */
type Answer =
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'page'; readonly status: number; readonly html: string };

/**
 * Answers the sign-in step of one authorization request; the caller passes the `uid` the path
 * names. A request is tied to its sign-in by the signed cookie the provider set when the request
 * began, and a post is taken only from the issuer's own page.
 *
 * `/interaction/<uid>` is the step's page: the password form, with a link to Steam when the step
 * has both, or a redirect to Steam when Steam is the only step. `/interaction/<uid>/steam` is
 * where Steam sends the browser back.
 *
 * Steam is told to come back to exactly `<origin>/interaction/<uid>/steam?state=<state>`. The
 * state is an HMAC of the uid under a key made here, so it cannot be worked out from the uid, is
 * the same for every look at one sign-in, and dies with the process as the cookies do. A reply is
 * for this sign-in only when Steam signed that address and the browser came back with that state.
 *
 * One reply is decided per sign-in at a time: a reply that arrives while another is being decided
 * asks nothing and gets that decision's answer. A reply that is refused, or that Steam gives no
 * answer about, ends the sign-in. Together they bound what a caller can make this service ask
 * Steam, at one question that does not end in a valid reply per sign-in started; and a second
 * load of a reply, which Steam vouches for once, cannot end the sign-in the first load completed.
 */
export function createInteractionRouter(options: {
  readonly provider: Provider;
  readonly issuer: string;
  readonly signIn: SignInStep;
}): (req: IncomingMessage, res: ServerResponse, uid: string) => Promise<void> {
  const { provider, signIn } = options;
  const origin = new URL(options.issuer).origin;
  const steam =
    signIn.kind === 'steam' ? signIn : signIn.kind === 'password' ? undefined : signIn.steam;
  const stateKey = randomBytes(32);
  const deciding = new Map<string, Promise<Answer>>();

  /** What Steam's reply for the sign-in `uid` must match: where it comes back to, and its state. */
  const expectedOf = (uid: string): { readonly returnTo: string; readonly state: string } => {
    const state = createHmac('sha256', stateKey).update(uid).digest('base64url');
    return { returnTo: `${origin}${steamReplyPath(uid)}?state=${state}`, state };
  };

  /** Stores the sign-in's result for `sub` and returns where the browser goes on to. */
  const signedIn = async (
    req: IncomingMessage,
    res: ServerResponse,
    clientId: string,
    sub: string,
    checkedAt: number,
  ): Promise<string> => {
    const grant = new provider.Grant({ accountId: sub, clientId });
    grant.addOIDCScope('openid');
    const grantId = await grant.save();
    return provider.interactionResult(
      req,
      res,
      { login: { accountId: sub, remember: false, ts: checkedAt }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
  };

  /**
   * Decides one reply for the sign-in `uid`. The sign-in's record is read here, inside the one
   * decision in flight for it: the request that starts a decision read its own copy before it had
   * the decision to itself, and a reply decided in between may have signed in or ended the
   * sign-in.
   */
  const decideSteamReply = async (
    step: SteamStep,
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
    reply: URLSearchParams,
  ): Promise<Answer> => {
    const interaction = await provider.Interaction.find(uid);
    if (interaction === undefined) return { kind: 'page', status: 400, html: endedPage() };
    if (interaction.result?.login !== undefined) {
      // A second load of a reply that has signed in: the same way on.
      return { kind: 'redirect', location: interaction.returnTo };
    }
    // The second the reply's check starts is the session's login time, as for a password.
    const checkedAt = Math.floor(Date.now() / 1000);
    const outcome = await step.complete(reply, expectedOf(uid));
    switch (outcome.kind) {
      case 'signed-in':
        return {
          kind: 'redirect',
          location: await signedIn(
            req,
            res,
            String(interaction.params.client_id),
            outcome.sub,
            checkedAt,
          ),
        };
      case 'not-owned':
        return { kind: 'page', status: 403, html: notOwnedPage() };
      case 'refused':
        await interaction.destroy();
        return { kind: 'page', status: 400, html: endedPage() };
      case 'unavailable':
        await interaction.destroy();
        return { kind: 'page', status: 503, html: unavailablePage() };
    }
  };

  const answerSteamReply = async (
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
    query: string,
  ): Promise<void> => {
    if (steam === undefined) {
      text(res, 404, 'this sign-in has no Steam step');
      return;
    }
    if (req.method !== 'GET') {
      text(res, 405, 'this address takes GET', { allow: 'GET' });
      return;
    }
    // Only the browser that holds the sign-in's cookies is given a decision, its own or one in flight.
    if ((await liveSignIn(provider, req, res, uid)) === undefined) {
      page(res, 400, endedPage());
      return;
    }
    let decision = deciding.get(uid);
    if (decision === undefined) {
      decision = decideSteamReply(steam, req, res, uid, new URLSearchParams(query)).finally(() => {
        deciding.delete(uid);
      });
      deciding.set(uid, decision);
    }
    const decided = await decision;
    if (decided.kind === 'redirect') redirect(res, decided.location);
    else page(res, decided.status, decided.html);
  };

  /** The step's page when Steam is the only step: the way to Steam. */
  const answerSteamOnly = async (
    step: SteamStep,
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
  ): Promise<void> => {
    if (req.method !== 'GET') {
      text(res, 405, 'this address takes GET', { allow: 'GET' });
      return;
    }
    if ((await liveSignIn(provider, req, res, uid)) === undefined) {
      page(res, 400, endedPage());
      return;
    }
    redirect(res, step.loginUrl(expectedOf(uid).returnTo));
  };

  /** The step's page with a password step: the form, and what a post of it gets. */
  const answerForm = async (
    password: PasswordStep,
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
  ): Promise<void> => {
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
    const form = (notice?: 'refused' | 'locked' | 'busy'): string =>
      signInPage({
        action: interactionPath(interaction.uid),
        steam: steam?.loginUrl(expectedOf(interaction.uid).returnTo),
        notice,
      });
    if (req.method === 'GET') {
      page(res, 200, form());
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
    const [given, ...otherPasswords] = fields.getAll('password');
    if (
      email === undefined ||
      given === undefined ||
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
    const outcome = await password.attempt(email, given);
    switch (outcome.kind) {
      case 'signed-in':
        redirect(
          res,
          await signedIn(req, res, String(interaction.params.client_id), outcome.sub, checkedAt),
        );
        return;
      case 'not-owned':
        page(res, 403, notOwnedPage());
        return;
      case 'refused':
        page(res, 400, form('refused'));
        return;
      case 'locked':
        page(res, 429, form('locked'));
        return;
      case 'busy':
        page(res, 503, form('busy'));
        return;
    }
  };

  const answer = async (req: IncomingMessage, res: ServerResponse, uid: string): Promise<void> => {
    const target = req.url ?? '';
    const mark = target.indexOf('?');
    if ((mark === -1 ? target : target.slice(0, mark)) === steamReplyPath(uid)) {
      await answerSteamReply(req, res, uid, mark === -1 ? '' : target.slice(mark + 1));
    } else if (signIn.kind === 'steam') {
      await answerSteamOnly(signIn, req, res, uid);
    } else {
      await answerForm(signIn.kind === 'password' ? signIn : signIn.password, req, res, uid);
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
