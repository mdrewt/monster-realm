// verify-build-hooks.mjs — check a production client build before it is served.
//
// Two things must hold of `client/dist` (or the directory given as the first argument):
//
//   1. No DEV debug hook survives in the bundle. It matches the BINDING form (`.__game=`/
//      `.__mrTrade=`/`.__mrPvp=`/`.__mrTactics=`, plus the `defineProperty(window,"__x"` escape),
//      NOT a bare substring (bar `__mrTactics`, whose name occurs nowhere else): an unminified
//      build legitimately retains dead object literals (`{challengePvp,proposeTrade}`) not
//      attached to `window`, and the ungated prod build stamp `window.__mrBuild=` must NOT be
//      flagged.
//   2. The connection target is run-time configuration. `shell-config.js` sets the shell
//      document, the document names the playtest database (`MR_PLAYTEST_DB`), `index.html` loads
//      that script, and no other file in the build contains the database name: a name found
//      anywhere else is an address baked back into the build, which a host could not change.
//
// It fails loud when the directory is absent or holds no bundle — scanning nothing must never
// read as green.
//
// `findDevHooks` is exported for its unit tests; everything that touches the file system runs
// from the main-guarded driver at the bottom.
//
// NO `new RegExp(...)` anywhere (Semgrep detect-non-literal-regexp): literal
// patterns + String methods only.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import vm from 'node:vm';

// The canonical DEV-hook fingerprint set. The window-
// binding assignment form (leading `.` also catches `w.`/`globalThis.`/`self.`
// receivers) plus the defineProperty escape. NO bracket `["__game"]` forms (vite
// emits no sourcemaps by default so they aren't reachable); NO bare `__game`
// substring; and NOT `.__mrBuild=` (the ungated prod stamp is not a dev hook).
// bt-12 (BT12.5): the tactical e2e hook `__mrTactics` joins in the same two shapes AND
// as the bare name — the one shape that catches `Object.assign(window, { __mrTactics })`
// or a bracket write; its name occurs nowhere else in the bundle (the hook object is
// `mrTacticsHook`, bound only inside the DEV-gated branch the minifier drops).
export const DEV_HOOK_FINGERPRINTS = [
  '.__game=',
  '.__game =',
  '.__mrTrade=',
  '.__mrTrade =',
  '.__mrPvp=',
  '.__mrPvp =',
  '.__mrTactics=',
  '.__mrTactics =',
  '__mrTactics',
  'defineProperty(window,"__game"',
  "defineProperty(window,'__game'",
  'defineProperty(window,"__mrTrade"',
  "defineProperty(window,'__mrTrade'",
  'defineProperty(window,"__mrPvp"',
  "defineProperty(window,'__mrPvp'",
  'defineProperty(window,"__mrTactics"',
  "defineProperty(window,'__mrTactics'",
];

// findDevHooks(bundleText, fingerprints) -> string[]
//
// Returns the fingerprints present in the bundle (exact substring match). The
// fingerprint set carries BOTH the no-space (`.__mrPvp=`) and single-space
// (`.__mrPvp =`) binding forms — the only shapes a real minified/pretty vite
// build emits — so no whitespace normalization is needed. (Normalizing would
// collapse a newline between `.__mrPvp` and `=` and risk matching a split that
// no bundler emits — a false-positive vector we deliberately avoid.)
export function findDevHooks(bundleText, fingerprints) {
  return fingerprints.filter((fp) => bundleText.includes(fp));
}

// The page global the shell document is assigned to, and the script that assigns it. Both names
// are repeated from client/src/net/shellDocument.ts: this script runs under plain Node and
// cannot import client TypeScript.
const SHELL_CONFIG_GLOBAL = '__MR_SHELL_CONFIG__';
const SHELL_CONFIG_SCRIPT = 'shell-config.js';
const DEV_DEFAULT_DB = 'monster-realm';
const SHELL_CONFIG_TIMEOUT_MS = 1000;

// readShellConfigDb(scriptText) -> { db: string } | { problem: string }
//
// Run the built `shell-config.js` and read the database its document names. The script is this
// repository's own build output; it runs in an empty `node:vm` context that is handed no object
// of this process. Both runs are time-bounded with microtasks drained inside the bound, and the
// document comes back as JSON text. Nothing here calls into a value the script made: a thrown
// value is described only when it is a native Error with an own string `message`.
function readShellConfigDb(scriptText) {
  let json;
  try {
    const context = vm.createContext(Object.create(null), { microtaskMode: 'afterEvaluate' });
    vm.runInContext(scriptText, context, { timeout: SHELL_CONFIG_TIMEOUT_MS });
    json = vm.runInContext(`JSON.stringify(globalThis.${SHELL_CONFIG_GLOBAL})`, context, {
      timeout: SHELL_CONFIG_TIMEOUT_MS,
    });
  } catch (err) {
    const message = types.isNativeError(err)
      ? Object.getOwnPropertyDescriptor(err, 'message')?.value
      : undefined;
    const why = typeof message === 'string' ? message.split('\n')[0] : 'it threw';
    return { problem: `running it failed (${why})` };
  }
  if (typeof json !== 'string') return { problem: 'it sets no document' };
  let doc;
  try {
    doc = JSON.parse(json);
  } catch {
    return { problem: 'its document does not read back as JSON' };
  }
  const db = doc?.connection?.db;
  if (typeof db !== 'string') return { problem: 'its document has no string connection.db' };
  return { db };
}

// loadsShellConfig(html) -> boolean
//
// True when `html` holds, outside comments, a <script> start tag that loads the shell document
// as a classic script, which the browser runs before any module script: it carries the
// attribute `src="/shell-config.js"` and none of `async`, `defer`, `nomodule` or `type` (any
// `type` is refused: Vite writes none on a classic script).
function loadsShellConfig(html) {
  const tags = html.replace(/<!--[\s\S]*?-->/g, '').match(/<script\b[^>]*>/gi) ?? [];
  return tags.some(
    (tag) =>
      /\ssrc="\/shell-config\.js"/.test(tag) && !/\s(?:async|defer|nomodule|type)\b/i.test(tag),
  );
}

// Every regular file under `dir`, at any depth. Symbolic links are skipped: Vite writes none.
function collectFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

// verifyBuild(distDir, playtestDb) -> string[]
//
// Every reason the build under `distDir` must not be served; empty when it may.
function verifyBuild(distDir, playtestDb) {
  if (!existsSync(distDir)) {
    return [`"${distDir}" does not exist — run \`just playtest-up\` / vite build first`];
  }
  const shellConfigPath = path.join(distDir, SHELL_CONFIG_SCRIPT);
  const texts = new Map(collectFiles(distDir).map((file) => [file, readFileSync(file, 'utf8')]));
  const scripts = [...texts.keys()].filter((file) => file.endsWith('.js'));
  if (scripts.every((file) => file === shellConfigPath)) {
    return [`no .js bundle found under "${distDir}" — run \`just playtest-up\` / vite build first`];
  }

  const failures = [];
  for (const file of scripts) {
    for (const hook of findDevHooks(texts.get(file), DEV_HOOK_FINGERPRINTS)) {
      failures.push(
        `DEV hook "${hook}" present in ${file} — the production build must strip ` +
          '__game/__mrTrade/__mrPvp/__mrTactics',
      );
    }
  }

  // The checks below compare against the playtest database, so they need a usable name.
  if (playtestDb === '' || playtestDb.toLowerCase() === DEV_DEFAULT_DB) {
    failures.push(
      `MR_PLAYTEST_DB is empty or the dev-default ("${playtestDb}") — set an isolated playtest ` +
        'DB before building',
    );
    return failures;
  }

  const shellConfig = texts.get(shellConfigPath);
  if (shellConfig === undefined) {
    failures.push(
      `${shellConfigPath} is missing — the build wrote no shell document. Build with ` +
        '`VITE_STDB_DB="$MR_PLAYTEST_DB" npm run build` (as `just playtest-up` does), else the ' +
        'served client has no server to join and throws at start-up',
    );
  } else {
    const read = readShellConfigDb(shellConfig);
    if (read.problem !== undefined) {
      failures.push(`${shellConfigPath} sets no readable ${SHELL_CONFIG_GLOBAL}: ${read.problem}`);
    } else if (read.db !== playtestDb) {
      failures.push(
        `${shellConfigPath} names the database "${read.db}", not the playtest database ` +
          `"${playtestDb}" — the build and MR_PLAYTEST_DB disagree`,
      );
    }
  }

  for (const [file, text] of texts) {
    if (file !== shellConfigPath && text.includes(playtestDb)) {
      failures.push(
        `${file} contains the playtest database name "${playtestDb}" — only ` +
          `${SHELL_CONFIG_SCRIPT} may name the server, or a host cannot change it`,
      );
    }
  }

  const indexHtmlPath = path.join(distDir, 'index.html');
  const indexHtml = texts.get(indexHtmlPath);
  if (indexHtml === undefined) {
    failures.push(`${indexHtmlPath} is missing — nothing loads /${SHELL_CONFIG_SCRIPT}`);
  } else if (!loadsShellConfig(indexHtml)) {
    failures.push(
      `${indexHtmlPath} does not load /${SHELL_CONFIG_SCRIPT} from a classic <script> — the ` +
        'client would start with no shell document',
    );
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Main-guarded driver (live FS I/O). Not run on import.
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Optional explicit dir override (argv[2]) for local checks; default dist.
  const distDir = process.argv[2] || path.join('client', 'dist');
  // The database `playtest-up` published to; the default matches that recipe's.
  const playtestDb = (process.env.MR_PLAYTEST_DB || 'monster-realm-playtest').trim();

  const failures = verifyBuild(distDir, playtestDb);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`verify-build-hooks: FAIL — ${failure}`);
    process.exit(1);
  }
  console.log(
    `verify-build-hooks: OK — "${distDir}" carries no DEV hooks ` +
      `(__game/__mrTrade/__mrPvp/__mrTactics); ${SHELL_CONFIG_SCRIPT} names the playtest DB ` +
      `"${playtestDb}" and no other file does.`,
  );
  process.exit(0);
}
