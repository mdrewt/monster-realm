# Better Auth issuer (Monster Realm accounts)

The deployment recipe for the self-hosted OIDC issuer behind player accounts.
SpacetimeDB derives an account's `Identity` from a verified JWT's issuer and subject,
so this service is on the authentication path, and losing its database orphans every
account. Backup and key custody are in
[`../../docs/runbooks/observability-dr.md`](../../docs/runbooks/observability-dr.md)
§7. Read it before deploying.

Better Auth is a TypeScript library, not a server image. This directory commits the
recipe only: `docker-compose.yml`, this README, and `.env.example`. Nothing here is a
running instance or a secret.

| File | Purpose |
|---|---|
| `docker-compose.yml` | One `node:24-alpine` service published on `127.0.0.1:8443`; installs the pinned Better Auth packages at start and runs `./app/auth.mjs` |
| `.env.example` | Environment template: copy it to `.env` (gitignored) and fill it in |
| `./app/` (created at deploy time) | `auth.mjs` and `package.json`, from the blocks below |
| `./data/` (deploy time) | The SQLite database |
| `./secrets/jwks.key` (deploy time) | The JWKS signing key, kept outside the database and outside the routine backup |

## Deploy

1. Create `.env` from `.env.example`. Generate `BETTER_AUTH_SECRET` (32+ random bytes)
   and the JWKS key file.
2. Create `./app/` from the two blocks below.
3. `docker compose up -d`. Check the port is loopback-only **and** reachable:
   `ss -tlnp | grep 8443` should show `127.0.0.1`, and
   `curl -fsS http://127.0.0.1:8443/health` (or any live route) must succeed. Inside
   the container the app binds `0.0.0.0` (`HOST`); Docker's `127.0.0.1:8443:8443`
   mapping is what restricts it to loopback.
4. Register the game as a single **public** OAuth client with PKCE
   (`token_endpoint_auth_method: 'none'`), from a trusted admin shell and never from
   browser code, using Better Auth's OAuth-provider API. Put the resulting
   `client_id` in `.env` as `OAUTH_CLIENT_ID`.
5. Point the game at it:
   - server: set `ALLOWED_ISSUERS` to `BETTER_AUTH_URL` and `ALLOWED_AUDIENCE` to the
     `client_id` in `server-module/src/accounts.rs`, then republish. Until then both
     hold a fail-closed `.invalid` placeholder, and no account can be created. When
     you do this, tighten `audience_allowed` to exact equality.
   - client: build with `VITE_MR_OIDC_ISSUER`, `VITE_MR_OIDC_CLIENT_ID` and
     `VITE_MR_OIDC_REDIRECT_URI`.

The monitoring stack's Caddy (`ops/observability/`) also listens on port 8443. Do not
run both on one host without moving one of them.

## Invariants

- **One audience.** `ALLOWED_AUDIENCE` holds exactly this game's `client_id`. A token
  from the same issuer minted for another client must not authenticate here.
- **The issuer URL is permanent.** Changing `BETTER_AUTH_URL` after players sign up
  changes every account's `Identity`. Choose the final hostname once.
- **Email and password sign-up is for development and QA only.** It lets engineers
  hold several accounts for multiplayer testing. Keep it off the public issuer, and
  treat subject identifiers as opaque secrets (out of logs and support tooling).
- **Signing-key custody.** The JWKS key can forge a token for any player. Keep it in
  `./secrets/jwks.key`, outside the database and outside the `restic --tag better-auth`
  backup. If key material ever ends up in a backup, rotate it.

## App entrypoint (create `./app/` from these)

`./app/package.json`:

```json
{
  "name": "mr-better-auth-app",
  "private": true,
  "type": "module"
}
```

`./app/auth.mjs` (a skeleton; pin exact package versions in `docker-compose.yml`'s
install step, and check Better Auth's current docs for the OAuth-provider API):

```js
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import Database from 'better-sqlite3';

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

// Serve on 0.0.0.0:8443 (HOST/PORT env) inside the container. Expose Better Auth's
// routes plus the OIDC discovery document at <issuer>/.well-known/openid-configuration,
// which SpacetimeDB reads to verify JWTs.
```

The HTTP serving glue is left to deploy time. What matters: ES256 JWTs, a reachable
`<issuer>/.well-known/openid-configuration` with a `jwks_uri`, and one registered
public PKCE client whose `client_id` is `ALLOWED_AUDIENCE`.
