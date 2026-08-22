#!/usr/bin/env node
// quiet-bash.mjs — PreToolUse(Bash) hook: route noisy build/test commands through
// quiet-run.mjs so their output reaches the model as signal instead of a wall.
//
// WHY A PreToolUse REWRITE AND NOT A PostToolUse FILTER. Measured against the
// installed Claude Code (2.1.240): a PostToolUse hook CANNOT alter tool output —
// its schema offers only `additionalContext` (which ADDS tokens), `decision:block`
// and `suppressOutput` (the hook's own stdout). The one lever that shrinks what
// reaches the model is PreToolUse `hookSpecificOutput.updatedInput`, which
// rewrites the command before it runs. Verified end to end with a probe session.
//
// SAFETY POSTURE: fail open, always. Any command this cannot confidently classify
// runs completely untouched. The hook never blocks, never edits semantics beyond
// wrapping, and exits 0 on every error path — a filter that eats output is worse
// than no filter at all.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allEnvNames, isRewritableShape, selectProfile } from './quiet-lib.mjs';
import { PROFILES } from './quiet-profiles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let out = null;
  try {
    out = main(JSON.parse(raw));
  } catch {
    /* not a Bash call, malformed payload, or a bug in here — stay out of the way */
  }
  if (!out) {
    process.exit(0);
    return;
  }
  // process.exit() discards whatever is still queued on stdout. A rewrite of a very
  // long command exceeds the pipe buffer, and exiting immediately after write() cut
  // the JSON in half — which Claude Code then could not parse. Exit from the write
  // callback so the payload is flushed first.
  process.stdout.write(out, () => process.exit(0));
});

function main(payload) {
  if (payload?.tool_name !== 'Bash') return;

  // Windows has no guaranteed `bash`, and quiet-run shells out to one. Rewriting
  // there would trade token savings for broken commands, so it simply does not.
  if (process.platform === 'win32') return;

  // A global off switch, for bisecting a suspected filter bug without editing settings.
  if (process.env.CLAUDE_QUIET_BASH === '0') return;

  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return;

  // Per-command escape hatch. `NOFILTER=1 cargo test` is a valid shell command
  // either way, so declining to rewrite is all that is needed — the command still
  // runs, just unfiltered.
  if (allEnvNames(command).some((n) => n === 'NOFILTER' || n === 'CLAUDE_QUIET_BASH')) return;

  // Idempotence. This hook is deliberately wired at BOTH the user level
  // (~/.claude/settings.json, so the supervisor loop's project-rooted runs are
  // covered) and the project level (so a project cloned standalone keeps the
  // behaviour). Both instances see the same original input and would emit the
  // same rewrite, but a command that is already wrapped must never be wrapped twice.
  if (command.includes('quiet-run.mjs')) return;

  // Anything with a shell operator the hook cannot account for is left alone —
  // including any command the agent has ALREADY piped or redirected, which is a
  // deliberate act of filtering that this hook has no business second-guessing.
  if (!isRewritableShape(command)) return;

  const profile = selectProfile(PROFILES, command);
  if (!profile) return;

  const runner = join(HERE, 'quiet-run.mjs');
  if (!existsSync(runner)) return;

  const b64 = Buffer.from(command, 'utf8').toString('base64url');
  const sid = String(payload.session_id ?? 'adhoc').replace(/[^A-Za-z0-9_-]/g, '');

  // ONE simple command, no shell operators: the rewritten command is re-parsed by
  // the permission layer, and anything it reads as "multiple operations" gets
  // rejected outright (measured). base64url contains no shell metacharacter.
  const rewritten = `node ${JSON.stringify(runner)} --profile=${profile.name} --sid=${sid} --b64=${b64}`;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: {
        ...payload.tool_input,
        command: rewritten,
        // Keep the transcript legible: `command` is now an opaque wrapper call,
        // so the human-readable original lives here.
        description: `${payload.tool_input.description ?? command} [noise-filtered: ${profile.name}]`,
      },
    },
  });
}
