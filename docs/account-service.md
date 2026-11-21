# The account service

`account-service/` is the OpenID Connect issuer that game modules trust for player accounts. A
module fetches `<issuer>/.well-known/openid-configuration`, then the key set that document names,
and accepts a token only when one of those keys signed it. Why the issuer is ours, and what it will
check before it signs: `docs/DECISIONS.md`, "The account service is our own small OIDC issuer; Steam
is the only player sign-in" and "Every player must own the game on Steam, for now".

The service serves discovery and its key set. It has no client and no sign-in step, so it issues no
token.

## Design

- **Provider.** [`oidc-provider`](https://github.com/panva/node-oidc-provider) 9.x carries the
  protocol. `src/provider.ts` configures it: the `code` response type only, ES256 ID tokens only,
  and the library's built-in sign-in form and logout page switched off (the form accepts any name;
  the logout page stores a session for a caller who never signed in).
- **Requests.** One handler stands in front of the provider. It answers a request only when its
  `Host` header is the issuer's host, and gives every other request `421`; a request target that is
  not a path gets `400`. It removes `Forwarded` and every `X-Forwarded-*` header and takes the
  scheme from the issuer, since TLS ends at a reverse proxy. The provider builds each URL it
  publishes from the request it is answering, so without this a forged `Host` would put another
  origin's `jwks_uri` in the discovery document. The same handler means the provider sees the
  socket's address as the client's, never one a request names.
- **Keys.** ES256 (P-256) signing keys, each with a `kid`. The first key in the file signs; the
  public half of every key is published at `/jwks`. `src/keys.ts` loads them from a JSON key file,
  `{ "profile": "<profile>", "keys": [ <private JWK>, … ] }`, marked with the profile it was made
  for and refused by any other profile. A generated `kid` is the key's RFC 7638 thumbprint.
- **Storage.** One SQLite file, opened with Node's built-in `node:sqlite`.
  `src/store/sqliteAdapter.ts` is the provider's storage adapter and the only module that touches
  the database. An expired record is not found. A consumed record is still found, carrying
  `consumed`: that mark is how the provider recognises a replayed code or refresh token and revokes
  its grant. Expired records are deleted once a minute. Record ids are stored as the provider hands
  them over.
- **No build step.** Node runs the TypeScript sources directly (`node src/server.ts`), so the
  sources use only syntax Node can strip (`erasableSyntaxOnly` in `tsconfig.json`) and relative
  imports name the `.ts` file.

## Profiles

`MR_ACCOUNT_PROFILE` selects one; there is no default.

| Profile | Issuer | Sign-in method | Signing keys | Data directory |
|---|---|---|---|---|
| `local-dev` | `http://localhost:4455` | `dev-password` | a key file, generated on the first start | `account-service/.data` (ignored by git) unless set |
| `hosted-dev` | `https://auth.monster-realm.spookyowltech.com` | `dev-password` | a key file the operator provides, readable by its owner only | set by the operator |
| `production` | `MR_ACCOUNT_ISSUER` | `steam` | an external signer | set by the operator |

The `production` profile loads and checks its settings and then refuses to start: this build holds
no external signer. Each dev issuer has its own keys.

## Settings

A setting that is unset or empty takes its default. A set value is taken exactly as written.

| Setting | Meaning |
|---|---|
| `MR_ACCOUNT_PROFILE` | `local-dev`, `hosted-dev` or `production`. Required. |
| `MR_ACCOUNT_ISSUER` | The production issuer: a bare `https:` origin in the exact form a token carries it (lower case; no user, path, query, fragment, default port or trailing slash), on a DNS name that is neither local nor a dev issuer's host or under it. Required by `production`; refused by the dev profiles, whose issuers are fixed. |
| `MR_ACCOUNT_SIGN_IN` | The sign-in method. Each profile accepts only its own (table above). |
| `MR_ACCOUNT_DATA_DIR` | The directory that holds `account.sqlite`. An absolute, normalised path. Required by `hosted-dev` and `production`. |
| `MR_ACCOUNT_KEY_FILE` | The key file; by default `keys.json` in the data directory. An absolute, normalised path. Refused by `production`. |
| `MR_ACCOUNT_HOST` | The address to listen on: an IP address or `localhost`. Default `127.0.0.1`. |
| `MR_ACCOUNT_PORT` | The port to listen on, 0 to 65535 (0 lets the system choose). Default 4455. |

The service refuses to start, naming the setting on stderr and exiting 1, when:

- `production` is given the dev sign-in method, a key file, an `http:` issuer, or an issuer on a dev
  issuer's host;
- a dev profile is given `MR_ACCOUNT_ISSUER`, or any setting whose name matches `MR_STEAM_*KEY*`
  (the Steam publisher key is `MR_STEAM_PUBLISHER_KEY`);
- a key file is missing (except on `local-dev`), malformed, marked for another profile, holds
  anything but P-256 private keys with distinct `kid`s, or, on `hosted-dev`, is readable by group or
  others;
- any other name beginning `MR_ACCOUNT_`, in any letter case, is set: a misspelt setting never
  falls back to a default.

A refusal never repeats a setting's value. A refused configuration or key file leaves nothing
written.

## Running it

- `just account-dev` runs the `local-dev` profile: it serves
  `http://localhost:4455/.well-known/openid-configuration` and `http://localhost:4455/jwks`, and
  prints one line naming the profile, the issuer, the address bound and the `kid`s. The first start
  writes `account-service/.data/keys.json` (mode 0600) and `account.sqlite` (0600) in a 0700
  directory; later starts reuse them. A request must name the issuer's host, so
  `http://127.0.0.1:4455` answers `421`.
- `just account-test` runs the package's tests and `just account-typecheck` its typecheck. Both are
  part of `just ci` and of the `account-service` job in `.github/workflows/ci.yml`. `just lint`
  lints the package with the rest of the tree.
- Each recipe installs the package's dependencies from `account-service/package-lock.json` when they
  are absent or older than the lock file.
- A test that needs a module to fetch discovery must run the service on its real port, one instance
  on a machine. Every other test drives the handler in process on a port the system chooses and
  sends the issuer's `Host`.

## Operator inputs

None is recorded.

| Input | Who supplies it | Recorded here as |
|---|---|---|
| The host behind `auth.monster-realm.spookyowltech.com` | the operator points the name at a host that runs the service | the host and the date |
| The Steam app id and a publisher Web API key | the operator; the key goes only into the production deployment's secret store | the app id (never the key) |
| The production host and issuer domain | the operator | the issuer URL every release module trusts |

## Runbook

No deployment recipe exists; these are the procedures a deployed instance needs.

### Start

`just account-dev` for `local-dev`. A `hosted-dev` instance needs `MR_ACCOUNT_DATA_DIR` and a key
file marked `hosted-dev`; no command writes one.

### Admin accounts

The service holds no accounts.

### Key rotation

The key file is an ordered list: a key added after the first is published and does not sign; moved
to the front it signs; taken out of the file it is published by nobody. No command edits the file.

### Backup and restore

Everything to keep is the key file and `account.sqlite`.

### Moving to another host

A host's issuer URL is part of every account's identity, so the name moves with the service; the
key file and the database move with it.
