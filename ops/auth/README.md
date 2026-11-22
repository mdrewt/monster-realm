# The account service's deployment recipe

The account service (`account-service/`, design in
[`../../docs/account-service.md`](../../docs/account-service.md)) is the OIDC issuer game
modules trust, and on the authentication path: losing its database or its keys orphans every
account. Run it with [`../../docs/runbooks/account-service.md`](../../docs/runbooks/account-service.md),
which covers starting each profile, admin accounts, key rotation, backup and restore, and moving
to another host.

| File | Purpose |
|---|---|
| `docker-compose.yml` | One compose profile per service profile (`local-dev`, `hosted-dev`, `production`): the account service built from `../../account-service/Dockerfile`, and Caddy in front |
| `Caddyfile` | Serves the profile's issuer origin and proxies it to the service |
| `.env.example` | The settings a profile may take: copy it to `.env` (git ignores it) |

```sh
docker compose --profile local-dev up -d --build
curl -fsS http://localhost:4455/.well-known/openid-configuration
```

- The account container runs as a non-root user on a read-only root file system; the database
  and the keys live on the profile's named volumes, so they survive `down` and a rebuild (`down
  -v` deletes them).
- Caddy is the only published port: `127.0.0.1:4455` for `local-dev`, 80 and 443 with an ACME
  certificate for the others. Nothing here holds a secret; `hosted-dev` keys are made in their
  volume (runbook section 2), and `production` refuses to start in this build.
- `account-service/src/deployment.test.ts` (in `just account-test`) builds the image and runs this
  recipe: the refusals, the restart and the backup drill.

## Point the game at it

- **The client** is built with `VITE_MR_OIDC_ISSUER` (the profile's issuer, `http://localhost:4455`
  for `local-dev`), `VITE_MR_OIDC_CLIENT_ID` (the client registered with `set-client`,
  `monster-realm`), `VITE_MR_OIDC_REDIRECT_URI` (that client's one redirect address,
  `http://localhost:5290/` for the dev client) and `VITE_MR_OIDC_PROVIDER_NAME` (the name on the
  Account screen's sign-in button). They take effect only toward an `official` or `test` server.
- **The module** creates an account only for a token whose issuer and audience match
  `ALLOWED_ISSUERS` and `ALLOWED_AUDIENCE` in `server-module/src/accounts.rs`.
