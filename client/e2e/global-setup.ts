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
  execSync(`spacetime publish -s ${server} --module-path ../server-module --delete-data -y ${db}`, {
    stdio: 'inherit',
  });
}
