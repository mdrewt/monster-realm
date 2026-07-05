import { execSync } from 'node:child_process';

// M5 e2e preconditions (ADR-0009): republish the module with --delete-data so each
// suite run starts from a KNOWN world (zero players). Server is `local` by default;
// CI points STDB_SERVER at the containerized spacetime (M5b). Runs from client/.
export default function globalSetup(): void {
  const server = process.env.STDB_SERVER ?? 'local';
  // Integration-runtime isolation: db name env-driven (default unchanged),
  // aligned with the client's VITE_STDB_DB, so a concurrent suite targets a
  // distinct db — its --delete-data then resets only that db, not a sibling run's.
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  // Both values are interpolated into a shell string below — reject anything
  // outside their legitimate shapes (red-team F5; literal regexes only).
  if (!/^[A-Za-z0-9:/._-]+$/.test(server)) {
    throw new Error(`STDB_SERVER contains characters outside [A-Za-z0-9:/._-]: ${server}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`VITE_STDB_DB contains characters outside [A-Za-z0-9_-]: ${db}`);
  }
  // 13.5h dev_reducers publish point (ADR-0086): CI pre-builds the module wasm
  // with `--features dev_reducers` and points MR_DEV_MODULE_WASM at the artifact;
  // when set, publish that binary via --bin-path (double-quoted — path-with-spaces
  // hygiene). Local runs without the var keep the plain --module-path publish.
  const devWasm = process.env.MR_DEV_MODULE_WASM;
  // Parse-don't-validate at the boundary: the value is interpolated into a shell
  // string, so reject anything outside a conservative path charset (spaces OK —
  // the interpolation double-quotes; quotes/backticks/$ etc. are NOT). Literal
  // regex, never new RegExp(dynamic) — Semgrep detect-non-literal-regexp.
  // Set-but-empty is a misconfiguration: silently falling back to the non-dev
  // publish would defeat the CI wiring this var exists for — fail loud instead.
  if (devWasm !== undefined && devWasm === '') {
    throw new Error('MR_DEV_MODULE_WASM is set but empty — unset it or point it at the dev wasm');
  }
  if (devWasm !== undefined && !/^[A-Za-z0-9/._ -]+$/.test(devWasm)) {
    throw new Error(
      `MR_DEV_MODULE_WASM contains characters outside [A-Za-z0-9/._ -]: ${JSON.stringify(devWasm)}`,
    );
  }
  const moduleArg = devWasm ? `--bin-path "${devWasm}"` : '--module-path ../server-module';
  execSync(`spacetime publish -s ${server} ${moduleArg} --delete-data -y ${db}`, {
    stdio: 'inherit',
  });
}
