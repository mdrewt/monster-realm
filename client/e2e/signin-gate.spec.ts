import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { renderShellConfigScript } from '../src/net/shellDocument';

// signin-gate.spec.ts: against a server that admits only players who own the game, the page asks
// for a sign-in before it plays.
//
//   official, owner      the first screen is the sign-in screen with one row naming the provider;
//                        no `join_game` reaches the server and the `player` table stays empty;
//                        Enter opens the issuer's form, the owning account signs in, and back in
//                        the game the screen is gone and the player has a row and a tile;
//   official, not owner  the issuer answers its not-owned page and redirects nowhere; back at the
//                        game the sign-in screen is up again and no player row exists;
//   test, anonymous      the page's one anonymous join is refused; the screen shows the not-owned
//                        title, the sign-in row and the store row, never the raw refusal; Down then
//                        Enter opens the store in a new page; Escape keeps the screen up.
//
// THE RIG lives in this file and starts everything in `beforeAll`:
//   1. a cargo build of the server module with the dev issuers, under `target/signin-gate`, so the
//      suite's own module artefact is untouched;
//   2. a publish of that artefact, with its data deleted, as `<VITE_STDB_DB>-signin-gate` on
//      `STDB_SERVER`;
//   3. the account service (`local-dev` profile, a fresh temporary data directory) on port 4455,
//      the issuer the module trusts; the rig refuses to start when anything answers on that port;
//   4. the client registration and two dev accounts (one owns the game, one does not), through the
//      service's admin command; each generated password is held in a variable and never printed;
//   5. a second vite dev server on `MR_E2E_PORT + 100`, naming the gate database and the issuer.
// `afterAll` stops both long-lived children by process group, and a process `exit` handler does the
// same for a run that ends without it. Nothing runs at import: a process that never runs this file
// never touches port 4455, the gate database or the gate port.
//
// Every failure names the command or the child, its exit status and the tail of its output, with
// any `password=` line and anything shaped like a token removed. Every wait has a bound.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
}

/** What the rig derives from the environment, each value validated. */
interface RigTarget {
  readonly server: string;
  readonly uri: string;
  readonly gateDb: string;
  readonly gatePort: number;
  readonly gateOrigin: string;
}

interface RigChild {
  readonly label: string;
  readonly proc: ChildProcess;
  output: string;
  ended: string | undefined;
}

interface DevAccount {
  readonly email: string;
  readonly password: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_DIR = join(REPO_ROOT, 'client');
const ACCOUNT_DIR = join(REPO_ROOT, 'account-service');
const GATE_TARGET_DIR = join(REPO_ROOT, 'target', 'signin-gate');
const GATE_WASM = join(
  GATE_TARGET_DIR,
  'wasm32-unknown-unknown',
  'release',
  'monster_realm_module.wasm',
);

const ISSUER_PORT = 4455;
const ISSUER_ORIGIN = 'http://localhost:4455';
const DISCOVERY_URL = `${ISSUER_ORIGIN}/.well-known/openid-configuration`;
const CLIENT_ID = 'monster-realm';
const PROVIDER_NAME = 'Dev Account';
const STORE_URL = 'https://store.steampowered.com/';
const OWNER_EMAIL = 'owner@signin-gate.test';
const STRANGER_EMAIL = 'stranger@signin-gate.test';

const GATE_TITLE = 'Sign in to play';
const GATE_BODY = 'This server needs an account. Sign in to start playing.';
const SIGN_IN_LABEL = `Sign in / create account with ${PROVIDER_NAME}`;
const NOT_OWNED_TITLE = 'You need to own Monster Realm on Steam';
const NOT_OWNED_BODY = 'Get the game on Steam, then sign in with the account that owns it.';
const STORE_LABEL = 'Open the Steam store';
const STAYS_LINE = 'You need to sign in before you can play.';
const ISSUER_NOT_OWNED = 'This account does not own Monster Realm';
const RAW_REFUSAL = 'ownership required';

const REFUSAL_EVT = '"evt":"reject"';
const REFUSAL_REDUCER = '"reducer":"join_game"';
const REFUSAL_REASON = '"reason":"ownership required"';

/** How much of a child's output is kept for an error message. */
const OUTPUT_KEPT = 6_000;
/** How long a closed context's connection may take to end on the server. */
const SESSION_END_MS = 15_000;
/** How long the server truth must hold when the claim is that nothing happens. */
const HOLD_MS = 4_000;

const children = new Set<RigChild>();
let exitHandlerInstalled = false;

/** Read and validate the environment the suite runs with. Called from `beforeAll` only. */
function rigTarget(): RigTarget {
  const server = process.env.STDB_SERVER?.trim() || 'local';
  const uri = process.env.VITE_STDB_URI?.trim() || 'ws://127.0.0.1:3000';
  const db = process.env.VITE_STDB_DB?.trim() || 'monster-realm';
  const port = process.env.MR_E2E_PORT?.trim() || '5290';
  if (!/^[A-Za-z0-9][A-Za-z0-9:/._-]*$/.test(server)) {
    throw new Error('STDB_SERVER contains characters outside [A-Za-z0-9:/._-]');
  }
  if (!/^wss?:\/\/[A-Za-z0-9._:[\]-]+\/?$/.test(uri)) {
    throw new Error('VITE_STDB_URI is not a ws:// or wss:// address of a host and port');
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(db)) {
    throw new Error('VITE_STDB_DB contains characters outside [A-Za-z0-9_-]');
  }
  if (!/^[1-9][0-9]{0,4}$/.test(port)) {
    throw new Error('MR_E2E_PORT is not a decimal port number');
  }
  const gatePort = Number(port) + 100;
  if (gatePort > 65_535) throw new Error('MR_E2E_PORT + 100 is not a port number');
  return {
    server,
    uri,
    gateDb: `${db}-signin-gate`,
    gatePort,
    gateOrigin: `http://localhost:${gatePort}`,
  };
}

/** `text` with every `password=` line and anything shaped like a JWT replaced. */
function redact(text: string): string {
  return text
    .replace(/^password=.*$/gm, 'password=(hidden)')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '(token hidden)');
}

/** The last part of `text`, redacted. */
function tail(text: string): string {
  return redact(text).slice(-OUTPUT_KEPT);
}

/** Run a command to its end without a shell; throw naming it, its status and its output tail. */
function run(
  label: string,
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs: number },
): string {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const shown = `\`${command} ${args.join(' ')}\` (in ${options.cwd})`;
  if (result.error !== undefined) {
    throw new Error(
      `${label}: ${shown} did not run to its end: ${result.error.message}\n${tail(`${stdout}\n${stderr}`)}`,
    );
  }
  if (result.status !== 0) {
    const how = result.status === null ? `signal ${result.signal}` : `status ${result.status}`;
    throw new Error(`${label}: ${shown} ended with ${how}\n${tail(`${stdout}\n${stderr}`)}`);
  }
  return stdout;
}

/** Start a long-lived child in its own process group, keeping the tail of its output. */
function startChild(
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): RigChild {
  const proc = spawn(command, [...args], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child: RigChild = { label, proc, output: '', ended: undefined };
  const keep = (chunk: Buffer): void => {
    child.output = (child.output + chunk.toString('utf8')).slice(-OUTPUT_KEPT);
  };
  proc.stdout?.on('data', keep);
  proc.stderr?.on('data', keep);
  proc.on('error', (err) => {
    child.ended ??= `failed to start: ${err.message}`;
  });
  proc.on('exit', (code, signal) => {
    child.ended ??= code === null ? `ended by signal ${signal}` : `exited with status ${code}`;
  });
  children.add(child);
  return child;
}

/** Send `signal` to the process group led by `pid`; a group that has ended is left alone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has ended.
  }
}

/** Stop a child's whole process group: SIGTERM, up to five seconds, then SIGKILL. */
async function stopChild(child: RigChild): Promise<void> {
  const pid = child.proc.pid;
  children.delete(child);
  if (pid === undefined) return;
  signalGroup(pid, 'SIGTERM');
  const until = Date.now() + 5_000;
  while (child.ended === undefined && Date.now() < until) await sleep(100);
  signalGroup(pid, 'SIGKILL');
}

/** At process exit, kill every child group still running. */
function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => {
    for (const child of children) {
      if (child.proc.pid !== undefined) signalGroup(child.proc.pid, 'SIGKILL');
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/** The loopback address on which something accepts a TCP connection to `port`, if any. */
async function portAnswers(port: number): Promise<string | undefined> {
  for (const host of ['127.0.0.1', '::1']) {
    const open = await new Promise<boolean>((done) => {
      const socket = connect({ host, port });
      socket.setTimeout(1_000);
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', () => {
        done(false);
      });
      socket.once('timeout', () => {
        socket.destroy();
        done(false);
      });
    });
    if (open) return host;
  }
  return undefined;
}

/** Throw, naming the port, when something already answers on it. */
async function refuseTakenPort(port: number, what: string): Promise<void> {
  const host = await portAnswers(port);
  if (host !== undefined) {
    throw new Error(
      `port ${port} already answers on ${host}: the rig starts ${what} there and takes no running one; stop whatever listens on ${port}`,
    );
  }
}

/** Wait until `url` answers 200 and `accept` takes the answer, while `child` is alive. */
async function waitReady(
  child: RigChild,
  url: string,
  timeoutMs: number,
  accept: (res: Response) => Promise<void>,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = 'no answer yet';
  while (Date.now() < until) {
    if (child.ended !== undefined) {
      throw new Error(
        `${child.label} ${child.ended} before ${url} answered\n${tail(child.output)}`,
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) {
        await accept(res);
        return;
      }
      last = `status ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(250);
  }
  throw new Error(
    `${child.label}: ${url} did not answer 200 within ${timeoutMs} ms (last: ${last})\n${tail(child.output)}`,
  );
}

/** The account service's environment: the inherited one without any account-service setting,
 *  then the profile and the data directory. */
function serviceEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.trim().toUpperCase();
    if (upper.startsWith('MR_ACCOUNT_') || upper.startsWith('MR_STEAM_')) continue;
    env[name] = value;
  }
  env.MR_ACCOUNT_PROFILE = 'local-dev';
  env.MR_ACCOUNT_DATA_DIR = dataDir;
  return env;
}

/** Run one admin command of the account service and return its stdout. */
function admin(label: string, args: readonly string[], dataDir: string): string {
  return run(label, process.execPath, ['src/admin/cli.ts', ...args], {
    cwd: ACCOUNT_DIR,
    env: serviceEnv(dataDir),
    timeoutMs: 60_000,
  });
}

/** Make a dev account and read its generated password from the `password=` line. */
function createAccount(email: string, entitled: boolean, dataDir: string): DevAccount {
  const label = `create-account ${email}`;
  const out = admin(
    label,
    ['create-account', email, ...(entitled ? [] : ['--not-entitled'])],
    dataDir,
  );
  const lines = out.split('\n').map((line) => line.trim());
  const prefix = ['pass', 'word='].join('');
  const secretLine = lines.find((line) => line.startsWith(prefix));
  if (secretLine === undefined || secretLine.length === prefix.length) {
    throw new Error(`${label}: no password line in its output\n${tail(out)}`);
  }
  if (!lines.includes(`entitled=${entitled}`)) {
    throw new Error(`${label}: the account is not entitled=${entitled}\n${tail(out)}`);
  }
  return { email, password: secretLine.slice(prefix.length) };
}

/** A `spacetime sql` table as column to cell records. */
function tableRows(stdout: string, label: string): Record<string, string>[] {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const header = lines.shift();
  const separator = lines.shift();
  if (header === undefined || separator === undefined || !/^[-+]+$/.test(separator.trim())) {
    throw new Error(`${label}: unrecognised spacetime sql table: ${stdout.slice(0, 300)}`);
  }
  const cols = header.split('|').map((c) => c.trim());
  return lines.map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

/** An identity as lowercase hex without a `0x`. */
function bareHex(identity: string): string {
  const lower = identity.trim().toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

/** The gate database's `player` identities, lowercase hex without a `0x`. */
function gatePlayers(target: RigTarget, label: string): string[] {
  const out = run(
    label,
    'spacetime',
    ['sql', '-s', target.server, target.gateDb, 'SELECT * FROM player'],
    { cwd: CLIENT_DIR, timeoutMs: 30_000 },
  );
  return tableRows(out, label).map((row) => bareHex(row.identity ?? ''));
}

/** How many module log lines record a `join_game` refused for ownership to `hex`. */
function refusalsFor(target: RigTarget, hex: string, label: string): number {
  const out = run(label, 'spacetime', ['logs', '-s', target.server, target.gateDb], {
    cwd: CLIENT_DIR,
    timeoutMs: 30_000,
  });
  const sender = `"sender":"${hex}"`;
  return out
    .split('\n')
    .filter(
      (line) =>
        line.includes(REFUSAL_EVT) &&
        line.includes(REFUSAL_REDUCER) &&
        line.includes(sender) &&
        line.includes(REFUSAL_REASON),
    ).length;
}

/** Run `check` repeatedly over HOLD_MS (at least twice). */
async function holdFor(check: () => void): Promise<void> {
  const until = Date.now() + HOLD_MS;
  let reads = 0;
  while (reads < 2 || Date.now() < until) {
    check();
    reads += 1;
    await sleep(500);
  }
}

/** Serve the gate database as an `official` shell document to every page of `ctx`. */
async function serveOfficial(ctx: BrowserContext, target: RigTarget): Promise<void> {
  await ctx.route('**/shell-config.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: renderShellConfigScript({
        connection: { uri: target.uri, db: target.gateDb, kind: 'official' },
      }),
    }),
  );
}

/** Wait until the page holds an identity; return it as bare lowercase hex. */
async function waitIdentity(page: Page, label: string): Promise<string> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      return w.__game !== undefined && w.__game().identity !== '';
    },
    null,
    { timeout: 30_000 },
  );
  const hex = bareHex(
    await page.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game().identity),
  );
  expect(hex, `${label}: the identity is 64 hex digits`).toMatch(/^[0-9a-f]{64}$/);
  return hex;
}

/** The own authoritative tile, or null. */
function ownTile(page: Page): Promise<GameSnap['ownAuthTile']> {
  return page.evaluate(
    () => (window as unknown as { __game: () => GameSnap }).__game().ownAuthTile,
  );
}

/** The keys of the rows the menu frame shows, in order. */
function rowKeys(page: Page): Promise<string[]> {
  return page
    .locator('#menu-overlay #menu-rows [data-nav-key]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-nav-key') ?? ''));
}

/** The menu frame is up as the sign-in screen with `title`, `line` and exactly `keys` as rows. */
async function expectGate(
  page: Page,
  title: string,
  line: string,
  keys: readonly string[],
  label: string,
): Promise<void> {
  await expect(
    page.locator('#menu-overlay'),
    `${label}: the menu frame holds the screen`,
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#menu-overlay .mr-frame-title'), `${label}: the title`).toHaveText(
    title,
    { timeout: 15_000 },
  );
  await expect
    .poll(() => rowKeys(page), { message: `${label}: the rows, in order`, timeout: 10_000 })
    .toEqual([...keys]);
  await expect(
    page.locator('#menu-overlay #menu-rows [data-nav-key="signIn"]'),
    `${label}: the sign-in row names the provider`,
  ).toContainText(SIGN_IN_LABEL);
  await expect(page.locator('#menu-overlay .mr-frame-feedback'), `${label}: the line`).toHaveText(
    line,
  );
}

/** The page's text holds no raw refusal string. */
async function expectNoRawRefusal(page: Page, label: string): Promise<void> {
  const text = await page.evaluate(() => document.body.textContent ?? '');
  expect(text.toLowerCase(), `${label}: the page never shows the raw refusal`).not.toContain(
    RAW_REFUSAL,
  );
}

/** Wait for the issuer's form and fill it with `account`. */
async function fillIssuerForm(page: Page, account: DevAccount, label: string): Promise<void> {
  await page.waitForURL((url) => url.origin === ISSUER_ORIGIN, { timeout: 30_000 });
  await expect(page.locator('#email'), `${label}: the issuer shows its form`).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('#email').fill(account.email);
  await page.locator('#password').fill(account.password);
}

/** Close `ctx`, then wait until the gate database holds no player row. */
async function closeAndDrain(ctx: BrowserContext, target: RigTarget, label: string): Promise<void> {
  await ctx.close();
  await expect
    .poll(() => gatePlayers(target, `${label}: players after close`), {
      message: `${label}: the closed context leaves no player behind`,
      timeout: SESSION_END_MS,
    })
    .toEqual([]);
}

test.describe
  .serial('the sign-in screen against a server that admits only players who own the game', () => {
    let target: RigTarget | undefined;
    let browser: Browser | undefined;
    let issuer: RigChild | undefined;
    let vite: RigChild | undefined;
    let dataDir: string | undefined;
    let owner: DevAccount | undefined;
    let stranger: DevAccount | undefined;

    /** The rig's parts, or a throw naming the one `beforeAll` did not make. */
    function rig(): {
      target: RigTarget;
      browser: Browser;
      owner: DevAccount;
      stranger: DevAccount;
    } {
      if (target === undefined || browser === undefined) {
        throw new Error('the rig did not start (see beforeAll)');
      }
      if (owner === undefined || stranger === undefined) {
        throw new Error('the rig made no dev accounts (see beforeAll)');
      }
      return { target, browser, owner, stranger };
    }

    test.beforeAll(async () => {
      test.setTimeout(900_000);
      installExitHandler();
      const t = rigTarget();
      target = t;
      await refuseTakenPort(ISSUER_PORT, 'its own issuer');
      await refuseTakenPort(t.gatePort, 'its own vite dev server');

      run(
        'module build',
        'cargo',
        [
          'build',
          '-p',
          'monster-realm-module',
          '--release',
          '--target',
          'wasm32-unknown-unknown',
          '--no-default-features',
          '--features',
          'dev_issuers',
          '--target-dir',
          GATE_TARGET_DIR,
        ],
        { cwd: REPO_ROOT, timeoutMs: 840_000 },
      );
      if (!existsSync(GATE_WASM)) {
        throw new Error(`module build: the artefact ${GATE_WASM} is missing after the build`);
      }
      run(
        'module publish',
        'spacetime',
        ['publish', '-s', t.server, '--bin-path', GATE_WASM, '--delete-data', '-y', t.gateDb],
        { cwd: CLIENT_DIR, timeoutMs: 180_000 },
      );

      run('account install', 'just', ['account-install'], { cwd: REPO_ROOT, timeoutMs: 300_000 });
      dataDir = mkdtempSync(join(tmpdir(), 'mr-signin-gate-'));
      issuer = startChild(
        'the account service',
        process.execPath,
        ['src/server.ts'],
        ACCOUNT_DIR,
        serviceEnv(dataDir),
      );
      await waitReady(issuer, DISCOVERY_URL, 60_000, async (res) => {
        const doc = (await res.json()) as { issuer?: unknown };
        if (doc.issuer !== ISSUER_ORIGIN) {
          throw new Error(`the issuer on port ${ISSUER_PORT} is not the rig's own`);
        }
      });

      const registered = admin(
        'set-client',
        ['set-client', CLIENT_ID, `${t.gateOrigin}/`],
        dataDir,
      );
      if (!registered.includes(`client=${CLIENT_ID}`)) {
        throw new Error(`set-client: the client is not registered\n${tail(registered)}`);
      }
      owner = createAccount(OWNER_EMAIL, true, dataDir);
      stranger = createAccount(STRANGER_EMAIL, false, dataDir);

      vite = startChild('the gate vite dev server', 'npm', ['run', 'dev'], CLIENT_DIR, {
        ...process.env,
        MR_E2E_PORT: String(t.gatePort),
        VITE_STDB_URI: t.uri,
        VITE_STDB_DB: t.gateDb,
        VITE_MR_OIDC_ISSUER: ISSUER_ORIGIN,
        VITE_MR_OIDC_CLIENT_ID: CLIENT_ID,
        VITE_MR_OIDC_REDIRECT_URI: `${t.gateOrigin}/`,
        VITE_MR_OIDC_PROVIDER_NAME: PROVIDER_NAME,
      });
      await waitReady(vite, `${t.gateOrigin}/shell-config.js`, 90_000, async (res) => {
        if (!(await res.text()).includes(`"db":${JSON.stringify(t.gateDb)}`)) {
          throw new Error(`the server on port ${t.gatePort} does not name the gate database`);
        }
      });

      browser = await chromium.launch();
    });

    test.afterAll(async () => {
      test.setTimeout(60_000);
      await browser?.close();
      if (vite !== undefined) await stopChild(vite);
      if (issuer !== undefined) await stopChild(issuer);
      if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
    });

    test('an official server shows the sign-in screen first, calls no join before sign-in, and an owning account then plays [acs-7.1]', async () => {
      test.setTimeout(180_000);
      const r = rig();
      expect(gatePlayers(r.target, 'owner: players before'), 'owner: no player yet').toEqual([]);
      const ctx = await r.browser.newContext();
      try {
        await serveOfficial(ctx, r.target);
        const page = await ctx.newPage();
        await page.goto(`${r.target.gateOrigin}/`);
        const anon = await waitIdentity(page, 'owner: anonymous page');

        await expectGate(page, GATE_TITLE, GATE_BODY, ['signIn'], 'owner: first screen');
        expect(await ownTile(page), 'owner: no character before sign-in').toBeNull();
        await holdFor(() => {
          expect(
            refusalsFor(r.target, anon, 'owner: refusals before sign-in'),
            'owner: no join_game reached the server for the anonymous identity',
          ).toBe(0);
          expect(
            gatePlayers(r.target, 'owner: players before sign-in'),
            'owner: the player table stays empty',
          ).toEqual([]);
        });

        await page.keyboard.press('Enter');
        await fillIssuerForm(page, r.owner, 'owner');
        await page.locator('button[type=submit]').click();

        await page.waitForURL((url) => url.origin === r.target.gateOrigin, { timeout: 30_000 });
        await page.waitForFunction(
          () => {
            const w = window as unknown as { __game?: () => GameSnap };
            return w.__game !== undefined && w.__game().ownAuthTile !== null;
          },
          null,
          { timeout: 60_000 },
        );
        const account = await waitIdentity(page, 'owner: signed-in page');
        expect(account, 'owner: the signed-in page is another identity').not.toBe(anon);
        await expect(page.locator('#menu-overlay'), 'owner: the sign-in screen is gone').toBeHidden(
          { timeout: 15_000 },
        );
        await expect
          .poll(() => gatePlayers(r.target, 'owner: players after sign-in'), {
            message: 'owner: the signed-in identity has the one player row',
            timeout: 15_000,
          })
          .toEqual([account]);
        expect(
          refusalsFor(r.target, account, 'owner: refusals after sign-in'),
          'owner: the signed-in join is not refused',
        ).toBe(0);
        expect(
          refusalsFor(r.target, anon, 'owner: anonymous refusals after sign-in'),
          'owner: the anonymous identity never called join_game',
        ).toBe(0);
        await expectNoRawRefusal(page, 'owner');
      } finally {
        await closeAndDrain(ctx, r.target, 'owner');
      }
    });

    test('an account that does not own the game gets the issuer not-owned page and returns to the sign-in screen with no player row [acs-7.1]', async () => {
      test.setTimeout(180_000);
      const r = rig();
      const ctx = await r.browser.newContext();
      try {
        await serveOfficial(ctx, r.target);
        const page = await ctx.newPage();
        await page.goto(`${r.target.gateOrigin}/`);
        const first = await waitIdentity(page, 'stranger: anonymous page');
        await expectGate(page, GATE_TITLE, GATE_BODY, ['signIn'], 'stranger: first screen');

        await page.keyboard.press('Enter');
        await fillIssuerForm(page, r.stranger, 'stranger');
        const posted = page.waitForResponse(
          (res) => res.request().method() === 'POST' && new URL(res.url()).origin === ISSUER_ORIGIN,
          { timeout: 30_000 },
        );
        await page.locator('button[type=submit]').click();
        expect((await posted).status(), 'stranger: the issuer refuses with 403').toBe(403);
        await expect(page.locator('h1'), 'stranger: the issuer not-owned page').toHaveText(
          ISSUER_NOT_OWNED,
        );
        expect(new URL(page.url()).origin, 'stranger: the issuer redirects nowhere').toBe(
          ISSUER_ORIGIN,
        );

        await page.goto(`${r.target.gateOrigin}/`);
        const back = await waitIdentity(page, 'stranger: page after the issuer');
        await expectGate(page, GATE_TITLE, GATE_BODY, ['signIn'], 'stranger: back at the game');
        expect(await ownTile(page), 'stranger: no character').toBeNull();
        await holdFor(() => {
          expect(
            gatePlayers(r.target, 'stranger: players after return'),
            'stranger: the player table gained no row',
          ).toEqual([]);
          expect(
            refusalsFor(r.target, first, 'stranger: refusals, first page') +
              refusalsFor(r.target, back, 'stranger: refusals, page after return'),
            'stranger: no join_game reached the server',
          ).toBe(0);
        });
        await expectNoRawRefusal(page, 'stranger');
      } finally {
        await closeAndDrain(ctx, r.target, 'stranger');
      }
    });

    test('a test server that refuses the anonymous join shows the not-owned screen with the store link and sign-in, and Escape keeps it up [acs-7.2]', async () => {
      test.setTimeout(180_000);
      const r = rig();
      const ctx = await r.browser.newContext();
      try {
        await ctx.route(
          (url) => url.hostname === 'store.steampowered.com',
          (route) =>
            route.fulfill({
              status: 200,
              contentType: 'text/html',
              body: '<!doctype html><title>store stand-in</title><p>store stand-in</p>',
            }),
        );
        const page = await ctx.newPage();
        await page.goto(`${r.target.gateOrigin}/`);
        const anon = await waitIdentity(page, 'probe: anonymous page');

        await expectGate(
          page,
          NOT_OWNED_TITLE,
          NOT_OWNED_BODY,
          ['signIn', 'store'],
          'probe: after the refusal',
        );
        await expect(
          page.locator('#menu-overlay #menu-rows [data-nav-key="store"]'),
          'probe: the store row',
        ).toContainText(STORE_LABEL);
        await expectNoRawRefusal(page, 'probe: after the refusal');
        await expect
          .poll(() => refusalsFor(r.target, anon, 'probe: refusals'), {
            message: 'probe: the module logged the refused join for this identity',
            timeout: 15_000,
          })
          .toBe(1);
        expect(
          gatePlayers(r.target, 'probe: players').includes(anon),
          'probe: the refused identity has no player row',
        ).toBe(false);

        const opened = ctx.waitForEvent('page', { timeout: 15_000 });
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        const store = await opened;
        await store.waitForURL(STORE_URL, { timeout: 15_000 });
        expect(store.url(), 'probe: the new page is the store').toBe(STORE_URL);
        expect(
          await store.evaluate(() => window.opener === null),
          'probe: the store page has no opener',
        ).toBe(true);
        expect(new URL(page.url()).origin, 'probe: the game page stays on the game').toBe(
          r.target.gateOrigin,
        );
        await store.close();

        await page.bringToFront();
        await page.keyboard.press('Escape');
        await expect(
          page.locator('#menu-overlay .mr-frame-feedback'),
          'probe: Escape answers with the stays line',
        ).toHaveText(STAYS_LINE, { timeout: 10_000 });
        await sleep(1_000);
        await expect(
          page.locator('#menu-overlay'),
          'probe: Escape leaves the screen up',
        ).toBeVisible();
        await expect(
          page.locator('#menu-overlay .mr-frame-title'),
          'probe: the not-owned title stays',
        ).toHaveText(NOT_OWNED_TITLE);
        expect(await rowKeys(page), 'probe: both rows stay').toEqual(['signIn', 'store']);
        await expectNoRawRefusal(page, 'probe: after Escape');
        expect(
          refusalsFor(r.target, anon, 'probe: refusals at the end'),
          'probe: one page load sends one refused join',
        ).toBe(1);
      } finally {
        await closeAndDrain(ctx, r.target, 'probe');
      }
    });
  });
