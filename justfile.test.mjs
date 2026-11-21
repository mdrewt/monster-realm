// `just publish` over a database that holds data must re-seed it as the owner: after the publish
// the recipe calls `sync_content` on the same database with the CLI's own identity, and a refused
// call fails the recipe. These tests RUN the real recipe with a recording stand-in for the
// `spacetime` CLI first on PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const JUSTFILE = join(ROOT, 'justfile');
const DB = 'lpw3-sentinel-db-7f3a';
const REFUSAL = 'Error: Response text: sync_content: caller is not the module owner';

// The stand-in: one invocation per line, arguments tab-separated, then the exit code the test
// chose for that subcommand. A refused `call` prints the real CLI's refusal on stderr.
const STAND_IN = `#!/bin/sh
for a in "$@"; do printf '%s\\t' "$a" >> "$MR_FAKE_SPACETIME_LOG"; done
printf '\\n' >> "$MR_FAKE_SPACETIME_LOG"
case "$1" in
  publish) exit "$MR_FAKE_PUBLISH_EXIT" ;;
  call)
    if [ "$MR_FAKE_CALL_EXIT" -ne 0 ]; then
      echo '${REFUSAL}' >&2
    fi
    exit "$MR_FAKE_CALL_EXIT"
    ;;
esac
exit 97
`;

// Run `just publish` with the stand-in answering `publish` and `call` with the given codes.
// Returns the recipe's exit status, its stderr and the recorded invocations (argument arrays).
function runPublish({ publishExit = 0, callExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lpw3-just-publish-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fake = join(bin, 'spacetime');
    writeFileSync(fake, STAND_IN);
    chmodSync(fake, 0o755);
    const log = join(dir, 'spacetime.log');
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('JUST_') && k !== 'VITE_STDB_DB') env[k] = v;
    }
    Object.assign(env, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      VITE_STDB_DB: DB,
      // Fail closed: a real spacetime CLI reached instead of the stand-in holds no identity.
      XDG_CONFIG_HOME: join(dir, 'xdg-config'),
      XDG_DATA_HOME: join(dir, 'xdg-data'),
      MR_FAKE_SPACETIME_LOG: log,
      MR_FAKE_PUBLISH_EXIT: String(publishExit),
      MR_FAKE_CALL_EXIT: String(callExit),
    });
    const result = spawnSync(
      'just',
      ['--justfile', JUSTFILE, '--working-directory', ROOT, 'publish'],
      {
        env,
        encoding: 'utf8',
      },
    );
    if (result.error) {
      throw new Error(`could not run \`just\`: ${result.error.message}`);
    }
    assert.notEqual(result.status, null, `just was killed by ${result.signal}`);
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.split('\t').slice(0, -1))
      : [];
    return { status: result.status, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The whole argument list, exactly: the database named, the data kept (no `-c` /
// `--delete-data` in any spelling), the CLI's default server and identity.
function assertPublishOf(args) {
  assert.deepEqual(args, ['publish', '--module-path', 'server-module', DB]);
}

test('after a publish that succeeds, just publish calls sync_content on the same database as the publishing identity', () => {
  const { status, stderr, calls } = runPublish();
  assert.equal(status, 0, `just publish failed: ${stderr}`);
  assert.equal(calls.length, 2, `two invocations, got ${JSON.stringify(calls)}`);
  assertPublishOf(calls[0]);
  assert.deepEqual(calls[1], ['call', DB, 'sync_content']);
});

test('a refused sync_content makes just publish exit non-zero and shows the refusal', () => {
  for (const code of [1, 3]) {
    const { status, stderr, calls } = runPublish({ callExit: code });
    assert.notEqual(status, 0, `a refusal exiting ${code} must fail the recipe`);
    assert.ok(
      stderr.includes(REFUSAL),
      `the refusal reaches the operator (exit ${code}): ${stderr}`,
    );
    assert.equal(calls.length, 2, `two invocations (exit ${code}), got ${JSON.stringify(calls)}`);
    assertPublishOf(calls[0]);
    assert.deepEqual(calls[1], ['call', DB, 'sync_content']);
  }
});

test('a failed publish is not followed by a sync_content call', () => {
  const { status, calls } = runPublish({ publishExit: 1 });
  assert.notEqual(status, 0, 'a failed publish fails the recipe');
  assert.equal(calls.length, 1, `only the publish ran, got ${JSON.stringify(calls)}`);
  assertPublishOf(calls[0]);
});
