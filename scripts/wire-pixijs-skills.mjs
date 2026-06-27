#!/usr/bin/env node
// wire-pixijs-skills.mjs — make PixiJS's bundled Agent Skills discoverable.
//
// PixiJS v8 ships Agent Skills inside the npm package at
// node_modules/pixi.js/skills/*, but Claude Code only discovers skills under
// <repo>/.claude/skills, ~/.claude/skills, or plugins — never node_modules.
// This script symlinks each shipped skill into <repo>/.claude/skills so they
// become available, version-matched to the installed PixiJS.
//
// Idempotent · safe no-op if pixi.js isn't installed · never fails an install.
// Intended as an npm "postinstall" step; also runnable by hand:
//   node scripts/wire-pixijs-skills.mjs [--root <dir>] [--quiet]

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const getOpt = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
};
const QUIET = args.includes('--quiet');
const log = (...a) => {
  if (!QUIET) console.log('[wire-pixijs-skills]', ...a);
};

const isSymlink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const readlinkSafe = (p) => {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
};
const findUp = (startDir, test) => {
  let dir = resolve(startDir);
  for (;;) {
    if (test(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

try {
  const start = getOpt('--root') ? resolve(getOpt('--root')) : process.cwd();

  // 1. repo root = nearest ancestor (incl. start) holding .claude or .git
  const root =
    findUp(start, (d) => existsSync(join(d, '.claude')) || existsSync(join(d, '.git'))) || start;

  // 2. find node_modules/pixi.js/skills from start up to root (inclusive)
  let skillsDir = null;
  for (let d = resolve(start); ; d = dirname(d)) {
    const cand = join(d, 'node_modules', 'pixi.js', 'skills');
    if (existsSync(cand) && statSync(cand).isDirectory()) {
      skillsDir = cand;
      break;
    }
    if (d === root || dirname(d) === d) break;
  }
  if (!skillsDir) {
    log('pixi.js skills not found (not installed yet?) — nothing to do.');
    process.exit(0);
  }

  // 3. ensure <root>/.claude/skills exists
  const target = join(root, '.claude', 'skills');
  mkdirSync(target, { recursive: true });

  // 4. symlink each shipped skill (that has a SKILL.md) into it
  let linked = 0;
  let unchanged = 0;
  for (const name of readdirSync(skillsDir)) {
    const src = join(skillsDir, name);
    if (!existsSync(join(src, 'SKILL.md'))) continue;
    const dest = join(target, name);
    const rel = relative(target, src);
    if (existsSync(dest) || isSymlink(dest)) {
      if (isSymlink(dest)) {
        if (readlinkSafe(dest) === rel) {
          unchanged++;
          continue;
        }
        rmSync(dest, { force: true }); // replace stale/indirect symlink
      } else {
        log(`skip ${name}: a real file/dir already exists (left untouched)`);
        continue;
      }
    }
    symlinkSync(rel, dest);
    linked++;
  }
  log(`root         ${root}`);
  log(`source       ${relative(root, skillsDir)}`);
  log(`linked ${linked}, unchanged ${unchanged}  ->  ${relative(root, target)}/`);
} catch (e) {
  log('non-fatal error:', e?.message ? e.message : e);
}
process.exit(0);
