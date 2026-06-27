// Feature-isolation eval (ADR-0003): the client prediction crate must NEVER pull
// the server-only `spacetimedb` feature/dependency. game-core derives
// `SpacetimeType` only under its `spacetimedb` feature, enabled by `server-module`
// — never by `client-wasm`. A leak here is a silent client/server coupling that
// re-introduces the desync class. resolver="2" is the structural half; this eval
// is the proof.
import { execSync } from 'node:child_process';

// Pure predicate (separately teeth-tested below): does a resolved dependency/
// feature tree reference spacetimedb at all?
export function leaksSpacetimedb(treeText) {
  return /spacetimedb/i.test(treeText);
}

export default async function () {
  const name = 'feature-isolation (client-wasm pulls no spacetimedb)';

  // Proof-of-teeth: the predicate MUST reject a known-bad graph. If it doesn't,
  // the gate is meaningless — fail loudly.
  const knownBad = 'game-core v0.1.0\n└── spacetimedb feature "default"';
  if (!leaksSpacetimedb(knownBad)) {
    return {
      name,
      pass: false,
      detail: 'proof-of-teeth: predicate failed to reject a bad fixture',
    };
  }

  // Real check: resolve client-wasm's feature/dependency tree and assert clean.
  let tree;
  try {
    tree = execSync('cargo tree -p client-wasm -e features -f "{p} {f}"', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { name, pass: false, detail: `cargo tree failed: ${e.message}` };
  }

  if (!/game-core/.test(tree)) {
    return { name, pass: false, detail: 'sanity: client-wasm tree does not resolve game-core' };
  }
  const leaked = leaksSpacetimedb(tree);
  return {
    name,
    pass: !leaked,
    detail: leaked ? 'LEAK: client-wasm graph references spacetimedb' : 'clean (teeth verified)',
  };
}
