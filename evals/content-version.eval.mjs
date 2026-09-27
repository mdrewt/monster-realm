// content-version eval: any change under game-core/content/** must come with a
// CONTENT_VERSION bump in server-module/src/lib.rs. sync_content skips
// re-seeding when the stored version equals CONTENT_VERSION, so unbumped content
// never reaches a live DB. The pair (version, sha256 of every content file's
// path + raw bytes — comment-only edits count) is pinned in
// evals/baselines/content-hash.json.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINE = 'evals/baselines/content-hash.json';
const REGEN =
  'bump CONTENT_VERSION in server-module/src/lib.rs FIRST, then regenerate the baseline: ' +
  `node -e "import('./evals/content-version.eval.mjs').then((m) => require('node:fs').writeFileSync('${BASELINE}', ` +
  `JSON.stringify({ version: m.readContentVersion('server-module/src/lib.rs'), hash: m.hashContentDir('game-core/content') }) + '\\n'))"`;

export function hashContentDir(dir, base = dir, h = createHash('sha256'), top = true) {
  for (const e of readdirSync(dir).sort()) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) hashContentDir(full, base, h, false);
    else
      h.update(`${path.relative(base, full).replace(/\\/g, '/')}\n`)
        .update(readFileSync(full))
        .update('\n');
  }
  return top ? h.digest('hex') : undefined;
}

// The single `pub(crate) const CONTENT_VERSION: u32 = N;` declaration, or null
// (absent or ambiguous).
export function readContentVersion(libRsPath) {
  const src = readFileSync(libRsPath, 'utf8');
  const m = [...src.matchAll(/^pub\(crate\) const CONTENT_VERSION: u32 = (\d+);/gm)];
  return m.length === 1 ? Number(m[0][1]) : null;
}

export default async function contentVersionEval() {
  const name = 'content-version (content/** hash is pinned to CONTENT_VERSION)';
  const version = readContentVersion('server-module/src/lib.rs');
  if (version === null) {
    return {
      name,
      pass: false,
      detail: 'expected exactly one CONTENT_VERSION declaration in server-module/src/lib.rs',
    };
  }
  const hash = hashContentDir('game-core/content');
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (base.version === version && base.hash === hash) {
    return {
      name,
      pass: true,
      detail: `CONTENT_VERSION=${version} hash=${hash.slice(0, 16)}… matches ${BASELINE}`,
    };
  }
  const why =
    base.version === version
      ? 'game-core/content changed without a CONTENT_VERSION bump'
      : `CONTENT_VERSION=${version} but ${BASELINE} pins version ${base.version}`;
  return { name, pass: false, detail: `${why} — ${REGEN}` };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const r = await contentVersionEval().catch((e) => ({
    name: 'content-version',
    pass: false,
    detail: `threw: ${e.message}`,
  }));
  console.log(`eval ${r.pass ? 'PASS' : 'FAIL'}: ${r.name} — ${r.detail}`);
  process.exit(r.pass ? 0 : 1);
}
