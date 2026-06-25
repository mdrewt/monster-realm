import { execSync } from 'node:child_process';

// M5 e2e preconditions (ADR-0009): republish the module with --delete-data so each
// suite run starts from a KNOWN world (zero players). Server is `local` by default;
// CI points STDB_SERVER at the containerized spacetime (M5b). Runs from client/.
export default function globalSetup(): void {
  const server = process.env.STDB_SERVER ?? 'local';
  execSync(
    `spacetime publish -s ${server} --module-path ../server-module --delete-data -y monster-realm`,
    { stdio: 'inherit' },
  );
}
