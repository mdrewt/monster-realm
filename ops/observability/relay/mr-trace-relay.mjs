// mr-trace-relay.mjs — batch shell around the pure relay core (m20e T4;
// ADR-0180, OBS-44/45/50).
//
// Contract: read the module log files under --logs-dir READ-ONLY, reconstruct
// spans through the pure core, and print ONE OTLP/HTTP JSON trace document on
// STDOUT. Diagnostics go to STDERR. There is deliberately no output-file
// flag and no write call of any kind: redirect stdout instead (OBS-45 — the
// relay never writes, and it neither requires nor accepts any module-owner
// credential). The tail-follow daemon and the /health endpoint live in
// daemon.mjs (13r-b) and must not creep in here — this file stays a one-shot
// batch pass over whole files. The OTLP POST client is parked to 13r-c and
// exists in neither shell. daemon.mjs IMPORTS `collectLogFiles` and
// `loadTracePairSet` from here (AM15); both are exported for that reason and
// the module is main-guarded at the bottom, so importing it runs nothing.
//
// The only filesystem calls in this file are readFileSync and readdirSync.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { reconstruct } from './reconstruct.mjs';

const SERVICE_NAME = 'mr-trace-relay';

/**
 * The committed membership file next to this module. Exported so the daemon
 * shell defaults to the SAME path rather than re-deciding it (AM15): a second
 * spelling of this default is a second thing to drift.
 */
export const DEFAULT_TRACE_PAIR_SET = path.join(import.meta.dirname, 'trace-pair-set.json');

const USAGE = [
  'usage: node mr-trace-relay.mjs --logs-dir <dir> [--trace-pair-set <path>]',
  '  Reads every *.log file under <dir> (recursively, e.g. a replica tree',
  '  containing module_logs/, or a directory holding .log files directly),',
  '  reconstructs enter/exit spans through the pure core, and prints one',
  '  OTLP/HTTP JSON trace document on stdout. Diagnostics print on stderr.',
  '  The membership defaults to the committed trace-pair-set.json next to',
  '  this file.',
].join('\n');

function parseCliArgs(argv) {
  const args = { logsDir: null, tracePairSetPath: DEFAULT_TRACE_PAIR_SET };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--logs-dir') {
      i++;
      if (i >= argv.length) return { ok: false, detail: '--logs-dir requires a value' };
      args.logsDir = argv[i];
    } else if (flag === '--trace-pair-set') {
      i++;
      if (i >= argv.length) return { ok: false, detail: '--trace-pair-set requires a value' };
      args.tracePairSetPath = argv[i];
    } else {
      return { ok: false, detail: `unknown argument: ${flag}` };
    }
  }
  if (args.logsDir === null) {
    return { ok: false, detail: '--logs-dir is required' };
  }
  return { ok: true, args };
}

// The committed membership, read in the same 4 fail-loud stages the G9d gate
// uses: absent file, unparseable JSON, wrong shape, positively-read array.
// ABSENCE IS NOT THE EMPTY SET.
//
// Exported (AM15) so the daemon shell IMPORTS this contract instead of carrying
// a second copy of it. A duplicated 4-stage reader is a duplicated chance for
// one copy to start treating a missing file as "nothing is instrumented".
export function loadTracePairSet(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      detail:
        `stage 1: cannot read the trace_pair_set config at ${filePath} (${err.code}) — ` +
        'absence is NOT the empty set; a deleted config must fail, never read as ' +
        '"nothing is instrumented"',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, detail: `stage 2: ${filePath} does not parse as JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, detail: `stage 3: ${filePath} is not a JSON object` };
  }
  if (parsed.schema !== 1) {
    return {
      ok: false,
      detail: `stage 3: ${filePath} schema is ${JSON.stringify(parsed.schema)}, expected 1`,
    };
  }
  if (!Object.hasOwn(parsed, 'trace_pair_set') || !Array.isArray(parsed.trace_pair_set)) {
    return {
      ok: false,
      detail:
        `stage 3: ${filePath} carries no trace_pair_set array — an absent field and an ` +
        'empty array are different facts and must not collapse into one',
    };
  }
  for (const entry of parsed.trace_pair_set) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return {
        ok: false,
        detail: `stage 3: membership entry ${JSON.stringify(entry)} is not a reducer name`,
      };
    }
  }
  return { ok: true, names: parsed.trace_pair_set };
}

// Every *.log file under dir, walked recursively, sorted for determinism.
// Exported (AM15) for the same reason as loadTracePairSet above: the daemon
// discovers its files through this walker, not through a second one.
export function collectLogFiles(dir) {
  const files = [];
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.log')) files.push(full);
    }
  };
  walk(dir);
  return files;
}

function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli.ok) {
    process.stderr.write(`mr-trace-relay: ${cli.detail}\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const membership = loadTracePairSet(cli.args.tracePairSetPath);
  if (!membership.ok) {
    process.stderr.write(`mr-trace-relay: ${membership.detail}\n`);
    process.exitCode = 1;
    return;
  }
  let files;
  try {
    files = collectLogFiles(cli.args.logsDir);
  } catch (err) {
    process.stderr.write(
      `mr-trace-relay: cannot read the logs directory ${cli.args.logsDir} (${err.code})\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (files.length === 0) {
    process.stderr.write(
      `mr-trace-relay: no .log files found under ${cli.args.logsDir} — refusing to emit a ` +
        'silently-empty document for what is probably a wrong path\n',
    );
    process.exitCode = 1;
    return;
  }
  const lines = [];
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      lines.push(line);
    }
  }
  const { document, diagnostics } = reconstruct(lines, {
    tracePairSet: membership.names,
    serviceName: SERVICE_NAME,
  });
  process.stdout.write(`${JSON.stringify(document)}\n`);
  process.stderr.write(
    `mr-trace-relay diagnostics: ${JSON.stringify({ logFiles: files.length, ...diagnostics })}\n`,
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
