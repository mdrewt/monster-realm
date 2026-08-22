#!/usr/bin/env node
// quiet-run.mjs — the wrapper the PreToolUse hook rewrites noisy commands into.
//
//   node quiet-run.mjs --profile=<name> --b64=<base64url of the original command>
//
// Runs the original command, streams the signal, withholds the noise, tees the
// COMPLETE raw output to a log file whose path it prints, and exits with the
// child's exit code.
//
// WHY A SINGLE ARGV-ONLY INVOCATION. The rewritten command is re-parsed by Claude
// Code's permission layer (measured: a rewrite containing `;` came back as "This
// Bash command contains multiple operations. The following part requires
// approval"). base64url carries no shell metacharacter, so the rewrite is one
// simple command and nothing can be smuggled through the rewrite itself.
//
// WHY IT RE-VALIDATES. Rewriting means a `cargo …` call reaches the permission
// layer as a `node …` call. Left unchecked that is a permission-laundering hole:
// anything hand-crafted into --b64 would inherit the wrapper's allow rule. Two
// controls close it, in this order:
//   1. the decoded command must itself select a profile — `rm -rf /` selects none
//      and is refused;
//   2. the sibling guard-bash.mjs is re-invoked on the decoded command, reusing
//      the real destructive-command guard verbatim rather than duplicating its
//      rule table (which has already rotted into three divergent copies once).

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFilter, selectProfile } from './quiet-lib.mjs';
import { PROFILES } from './quiet-profiles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so the test suite can point at a throwaway directory. Without it
// `just test` walks the REAL log root and prunes files older than three days across
// EVERY session — including other agents' logs, while lefthook runs it pre-commit.
const LOG_ROOT = process.env.CLAUDE_QUIET_LOG_ROOT || join(tmpdir(), 'claude-quiet-logs');
const LOG_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const LOG_MAX_BYTES = 512 * 1024 * 1024;

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

// Exits immediately and synchronously. It must: every caller sits in the top-level
// module body, where a non-halting die() would let a REFUSED command run anyway.
// (An earlier attempt to flush via the write callback did exactly that.) Truncation
// is not a concern at this size — the caller bounds the command it echoes, and the
// longest message is far inside the 64 KB pipe buffer.
function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Bound anything echoed back into an error message. */
const clip = (text, max = 400) =>
  text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;

// --- decode -----------------------------------------------------------------

const b64 = arg('b64');
const declaredProfile = arg('profile');
if (!b64) die(64, 'quiet-run: missing --b64=<base64url command>');

let command;
try {
  command = Buffer.from(b64, 'base64url').toString('utf8');
} catch {
  die(64, 'quiet-run: --b64 is not valid base64url');
}
if (!command.trim()) die(64, 'quiet-run: decoded command is empty');

// --- re-validate (anti-laundering) ------------------------------------------

const profile = selectProfile(PROFILES, command);
if (!profile) {
  die(
    78,
    `quiet-run: refusing to run a command that matches no filter profile.\n` +
      `  command: ${clip(command)}\n` +
      `  quiet-run only ever runs the noisy build/test commands its profiles recognise; it is not a\n` +
      `  general command runner and must not be used as one. Run the command directly instead.`,
  );
}
if (declaredProfile && declaredProfile !== profile.name) {
  die(
    78,
    `quiet-run: profile mismatch (rewritten as ${declaredProfile}, resolves to ${profile.name})`,
  );
}

const guard = join(HERE, '..', 'guard-bash.mjs');
try {
  statSync(guard);
  const res = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
  });
  if (res.status === 2) {
    die(78, `quiet-run: the destructive-command guard rejected this command.\n${res.stderr ?? ''}`);
  }
} catch (err) {
  // A missing guard is not fatal — the profile match above is the primary control,
  // and templates that ship quiet-run without guard-bash must still work. But say so.
  if (err && err.code !== 'ENOENT') {
    process.stderr.write(
      `quiet-run: guard re-check could not run (${err.message}); continuing on profile match alone\n`,
    );
  }
}

// --- raw log ----------------------------------------------------------------

const sessionId = (arg('sid') || process.env.CLAUDE_SESSION_ID || 'adhoc').replace(
  /[^A-Za-z0-9_-]/g,
  '',
);
const logDir = join(LOG_ROOT, sessionId);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const slug = createHash('sha256').update(command).digest('hex').slice(0, 8);
const logPath = join(logDir, `${stamp}-${profile.name}-${slug}.log`);

let logStream = null;
try {
  mkdirSync(logDir, { recursive: true });
  pruneLogs();
  logStream = createWriteStream(logPath);
  logStream.on('error', () => {
    logStream = null;
  });
  logStream.write(`# ${command}\n# cwd: ${process.cwd()}\n# profile: ${profile.name}\n\n`);
} catch {
  logStream = null;
}

function pruneLogs() {
  try {
    const now = Date.now();
    let total = 0;
    const files = [];
    for (const session of readdirSync(LOG_ROOT)) {
      const dir = join(LOG_ROOT, session);
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const p = join(dir, name);
        try {
          const st = statSync(p);
          total += st.size;
          files.push({ p, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* raced with another run */
        }
      }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    for (const f of files) {
      const tooOld = now - f.mtime > LOG_MAX_AGE_MS;
      const overBudget = total > LOG_MAX_BYTES;
      if (!tooOld && !overBudget) break;
      try {
        unlinkSync(f.p);
        total -= f.size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* pruning is best-effort and must never fail a run */
  }
}

// --- run --------------------------------------------------------------------

const targeted = Boolean(profile.targeted?.(command));
const filter = createFilter(profile, { targeted, capKeptAt: profile.capKeptAt ?? null });

const scope = targeted ? 'targeted' : 'sweep';
const flags = scope;

// NO HEADER LINE — deliberately. Measured: a green `vitest run` of 2,461 tests is
// 9 lines / 271 bytes, and a green `tsc --noEmit` is zero. Two banner lines ahead
// of those is a 20%+ REGRESSION on exactly the commands that were already terse.
// The banner is emitted at the end instead, where the exit code and the withheld
// count are actually known, and collapses to a single line when nothing was
// withheld — so a run this filter did not help costs ~10 tokens, not ~40.

// `exec 2>&1` on its own line, ahead of the command, gives ONE ordered stream
// instead of two pipes whose interleaving is at the mercy of buffering. A newline
// rather than `;` so a command that opens with a comment or its own newline is
// still well-formed.
const child = spawn('bash', ['-c', `exec 2>&1\n${command}`], {
  stdio: ['ignore', 'pipe', 'inherit'],
  // Deliberately NOT detached: staying in Claude Code's process group means a
  // tool timeout or an interrupt kills the whole tree. A detached child would
  // survive as an orphaned cargo/vitest run.
});

let pending = '';
function consume(chunk) {
  pending += chunk;
  for (;;) {
    const nl = pending.indexOf('\n');
    if (nl === -1) break;
    emit(pending.slice(0, nl));
    pending = pending.slice(nl + 1);
  }
}
// Content lines only. Synthesised banner/summary lines are counted separately so
// the banner can never claim it showed more lines than the command produced.
let emittedCount = 0;
function write(line) {
  emittedCount += 1;
  process.stdout.write(`${line}\n`);
}
function writeSynthetic(line) {
  process.stdout.write(`${line}\n`);
}
function emit(rawLine) {
  if (logStream) logStream.write(`${rawLine}\n`);
  const out = filter.push(rawLine);
  if (out !== null) write(out);
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', consume);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  });
}

child.on('error', (err) => {
  die(127, `quiet-run: could not start bash: ${err.message}`);
});

child.on('close', (code, signal) => {
  if (pending.length) emit(pending);
  const exitCode = signal ? 128 + (osSignalNumber(signal) ?? 15) : (code ?? 0);

  // finish() returns a mix: replayed content lines (which count) and synthesised
  // notices (which do not). Replayed content is exactly the first `replayed` entries.
  const trailing = filter.finish(exitCode);
  for (const [i, line] of trailing.entries()) {
    if (i < filter.state.replayed) write(line);
    else writeSynthetic(line);
  }

  const s = filter.state;
  // `withheld` comes from the rule counters, NOT from `total - emitted`. Synthesised
  // summary lines are counted in `emittedCount` but never in `total`, so the
  // subtraction can come out zero — or negative — on a run that genuinely dropped
  // lines, and then clamp to a banner claiming "nothing withheld". That would be a
  // lie in exactly the direction that matters.
  const withheld = s.dropped + (s.deferred - s.replayed);
  const pct = s.total > 0 ? Math.round((withheld / s.total) * 100) : 0;

  if (s.total === 0) {
    // The command printed nothing at all, so there is nothing to report and nothing
    // to recover. Staying silent keeps the result byte-identical to an unfiltered
    // run — `cargo fmt --all --check` and `tsc --noEmit` are silent when clean and
    // are run constantly, and a banner there is pure cost with no signal behind it.
    // (A run that DID produce output and had all of it withheld still gets the full
    // banner below — that case genuinely needs saying.)
  } else if (withheld === 0) {
    // Nothing was filtered, so there is nothing to audit — say so in one short line
    // rather than paying for a log path and a recovery hint that recover nothing.
    process.stdout.write(`[quiet-run:${profile.name}] exit ${exitCode} · nothing withheld\n`);
  } else {
    process.stdout.write(
      `[quiet-run:${profile.name}] exit ${exitCode} · ${flags} · showed ${emittedCount} of ${s.total} lines ` +
        `(${pct}% withheld)\n`,
    );
    process.stdout.write(
      `[quiet-run] full output: ${logStream ? logPath : '(log unavailable)'}` +
        ` · re-run unfiltered with: NOFILTER=1 ${clip(command, 300)}\n`,
    );
  }

  if (logStream) logStream.end();
  process.exitCode = exitCode;
});

function osSignalNumber(name) {
  return { SIGINT: 2, SIGKILL: 9, SIGTERM: 15, SIGHUP: 1 }[name];
}
