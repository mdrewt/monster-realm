# Better Auth issuer (Monster Realm accounts)

Self-hosted OIDC issuer for M21 accounts, per **ADR-0179** (accounts design) and
**ADR-0182** (M21b-2 client wiring + this deployment). SpacetimeDB derives every
player's `Identity` from a **verified JWT** minted here (`Identity = f(iss, sub)`),
so this service is on the auth critical path and its database loss permanently
orphans every account. Read the DR posture in
[`../../docs/observability-dr-runbook.md`](../../docs/observability-dr-runbook.md) §8
before deploying.

Better Auth is a TypeScript **library**, not a shipped server image. This directory
commits the *deployment recipe* — `docker-compose.yml`, this README, and
`.env.example` — never a running instance or a secret. The one deployment-time
artifact (`./app/`) is created from the fenced blocks below.

## What ships here vs. what is deployment-time

| File | Purpose |
|---|---|
| `docker-compose.yml` | One loopback-bound `node:24-alpine` service on `127.0.0.1:8443`; installs pinned Better Auth packages at start; runs `./app/auth.mjs`. |
| `.env.example` | Env template — copy to `.env` (gitignored), fill in real values. |
| `README.md` | This file: deploy sequence, the app entrypoint, the invariants. |
| `./app/` (deploy-time) | `auth.mjs` + `package.json`, from the fenced blocks below. |
| `./data/` (deploy-time) | The SQLite database — backed up by the runbook §8 restic sweep. |
| `./secrets/jwks.key` (deploy-time) | The JWKS signing key, held **outside** the DB and outside the routine backup (D20). |

## Deploy sequence (D18)

1. Create `.env` from `.env.example`; generate `BETTER_AUTH_SECRET` (32+ random
   bytes) and the JWKS key file.
2. Create `./app/` from the two fenced blocks below.
3. Stand the service up: `docker compose up -d`. Confirm it is loopback-bound AND
   actually reachable — `ss -tlnp | grep 8443` showing `127.0.0.1` only proves
   `docker-proxy`'s host socket exists, not that the container app accepts forwarded
   traffic, so also curl it: `curl -fsS http://127.0.0.1:8443/health` (or any live
   route) must succeed. The app binds `0.0.0.0` *inside* the container (`HOST` env);
   the loopback restriction is Docker's `-p 127.0.0.1:8443:8443` on the host side.
4. Register the game as an OAuth client, **server-side only** (never from browser
   code), as a **public client** with PKCE:
   ```sh
   # run against the standing instance, from a trusted admin shell
   node -e "import('./app/admin.mjs').then(m => m.createClient())"
   # → prints the client_id; it uses token_endpoint_auth_method: 'none'
   ```
   Put the printed `client_id` in `.env` as `OAUTH_CLIENT_ID`.
5. **Deployment-timed follow-up (SEQUENCING GATE — not part of the M21b-2 client
   slice).** Flipping the module's `ALLOWED_ISSUERS` (→ `BETTER_AUTH_URL`) and
   `ALLOWED_AUDIENCE` (→ `OAUTH_CLIENT_ID`) to these real values, and tightening
   `audience_allowed` to exact single-value equality, is a **separate commit that
   is HARD-GATED on slice `13r-c-2` landing first** (it migrates
   `evals/trade-escrow-guards.eval.mjs` off whole-crate comment stripping;
   ADR-0181 defers the `concat!()` removal there). Do **not** flip those constants
   before `13r-c-2` lands. The client code and this deployment recipe ship first;
   the value flip + the live restore drill come after.

## Permanent invariants

- **Single-client audience (CRITICAL-2 / D18).** `ALLOWED_AUDIENCE` holds exactly
  **one** entry — Monster Realm's own `client_id` — and is **never** widened to a
  list. A same-issuer token minted for a *different* client must not authenticate
  here. This is why the deployment-timed follow-up also tightens `audience_allowed`
  to exact equality rather than `.any()` membership.
- **`concat!()` stays** in `server-module/src/accounts.rs`'s issuer constant until
  `13r-c-2` lands (ADR-0181; the bare literal fails `trade-escrow-guards` TR-11).
- **Issuer URL is permanent** at first sign-up. Changing `BETTER_AUTH_URL` later
  re-mints every player's `Identity`. Pick the dedicated subdomain (OQ4) once.

## Native email + password is DEV/QA ONLY — not a public entry point (OQ5)

Native email+password sign-up is enabled **solely for internal development and QA**,
so engineers can hold multiple accounts while testing multiplayer features. It is
**not** a public-facing entry point for the player population: shipping players
authenticate via Steam (a future milestone, ADR-0182 OQ5). Do not surface native
sign-up in the game client's public UI. Two operational consequences:

- Keep native sign-up gated to the dev/QA deployment (e.g. an admin-only
  registration path or a separate dev instance), never exposed on the public
  issuer origin.
- **`sub` opacity.** Whatever population uses the native credential class, the DR
  backup exposes whatever the database contains (D20/L3) — so treat the subject
  identifiers as opaque secrets and keep them out of logs and support tooling.

## Signing-key custody (D20 — see runbook §8, the FIRST DR line item)

The JWKS **signing key** can forge a token for any player, forever, offline. Hold
it in `./secrets/jwks.key` — **outside** the SQLite database and **outside** the
routine `restic --tag better-auth` sweep. If Better Auth insists on keeping key
material in the database, the compensating control is a mandatory, documented key
**rotation** on any suspected backup exposure. OQ6's backup destination is a second
machine Drew owns — only as secure as that machine, which makes this exclusion
*more* important, not less.

## App entrypoint (create `./app/` from these)

`./app/package.json`:

```json
{
  "name": "mr-better-auth-app",
  "private": true,
  "type": "module"
}
```

`./app/auth.mjs` (skeleton — pin exact package versions in `docker-compose.yml`'s
install step; consult Better Auth's live docs for the current OAuth-provider API):

```js
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import Database from 'better-sqlite3';

// The signing key is loaded from a file OUTSIDE the DB (D20 custody).
export const auth = betterAuth({
  database: new Database(process.env.DATABASE_PATH),
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  // OAuth Provider mode uses its own token endpoint.
  disabledPaths: ['/token'],
  plugins: [
    jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } }),
    oauthProvider({ loginPage: '/sign-in', consentPage: '/consent', scopes: ['openid'] }),
  ],
});

// Serve on 0.0.0.0:8443 (HOST/PORT env) inside the container — the host-side
// `-p 127.0.0.1:8443` is what keeps it loopback-only. Expose Better Auth's
// routes plus the OIDC discovery metadata at
// <issuer>/.well-known/openid-configuration (SpacetimeDB reads it to verify JWTs).
```

The exact serving glue is intentionally left to deploy time (framework choice is
an ops decision, not a game-client one). The load-bearing requirements are: ES256
JWTs, a reachable `<issuer>/.well-known/openid-configuration` → `jwks_uri`, and a
single registered public PKCE client whose `client_id` is `ALLOWED_AUDIENCE`.
