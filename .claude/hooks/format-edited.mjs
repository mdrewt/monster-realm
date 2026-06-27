#!/usr/bin/env node
// PostToolUse hook: auto-format the file Claude just edited (best-effort, never blocks).
// JS/TS/CSS via Biome (only when a biome.json config is discoverable, so we never
// reformat with surprise defaults), Python via Ruff, Rust via rustfmt. Cross-platform.
// Reads the Claude Code hook payload JSON from stdin; always exits 0.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let file = '';
  try {
    file = JSON.parse(raw)?.tool_input?.file_path ?? '';
  } catch {
    /* no/invalid payload */
  }
  if (!file || !existsSync(file)) process.exit(0);

  const ext = path.extname(file).toLowerCase();
  const q = (s) => `"${s}"`;
  const run = (cmd, cwd) => {
    try {
      execSync(cmd, { stdio: 'ignore', cwd });
    } catch {
      /* best-effort: never block the agent */
    }
  };
  const has = (bin) => {
    try {
      execSync(`${process.platform === 'win32' ? 'where' : 'command -v'} ${bin}`, {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css'].includes(ext)) {
    let dir = path.dirname(file);
    let cfgDir = '';
    for (;;) {
      if (existsSync(path.join(dir, 'biome.json'))) {
        cfgDir = dir;
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (cfgDir) run(`npx --yes @biomejs/biome@2 check --write ${q(file)}`, cfgDir);
    // else: no biome config in this project yet -> skip rather than use surprise defaults
  } else if (ext === '.py') {
    if (has('ruff')) {
      run(`ruff check --fix ${q(file)}`, path.dirname(file));
      run(`ruff format ${q(file)}`, path.dirname(file));
    }
  } else if (ext === '.rs') {
    if (has('rustfmt')) run(`rustfmt ${q(file)}`, path.dirname(file));
  }

  // Keep the research library's generated index synced: when a research doc is written,
  // regenerate its sibling INDEX.md (best-effort; never blocks the agent).
  if (/[\\/]docs[\\/]research[\\/][^\\/]+\.md$/.test(file) && !/INDEX\.md$/.test(file)) {
    run(`node ${q(path.join(import.meta.dirname, 'research-index.mjs'))} ${q(path.dirname(file))}`);
  }
  process.exit(0);
});
