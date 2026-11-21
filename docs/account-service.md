# The account service

`account-service/` is the OpenID Connect issuer that game modules trust for player accounts. A
module fetches `<issuer>/.well-known/openid-configuration`, then the key set that document names,
and accepts a token only when one of those keys signed it. Why the issuer is ours, and what it will
check before it signs: `docs/DECISIONS.md`, "The account service is our own small OIDC issuer; Steam
is the only player sign-in" and "Every player must own the game on Steam, for now".

The service serves discovery and its key set. On the two dev profiles a player signs in with an
email and a password, through authorization code with PKCE, and the game client gets an ID token and
a refresh token. Accounts and clients are made by an admin command; there is no sign-up and no reset
mail. The `production` profile has no sign-in step in this build.

The service also signs world attestations at `POST /attest`: a statement, good for five minutes
and addressed to one world, that an account owns the game. A `local` or `private` world's module
checks it with a key it holds as data and binds the account (`docs/DECISIONS.md`, "A private world
verifies an account by a per-world attestation our account service signs").

## Design

- **Provider.** [`oidc-provider`](https://github.com/panva/node-oidc-provider) 9.x carries the
  protocol. `src/provider.ts` configures it: the `code` response type only, PKCE with `S256` for
  every client, ES256 ID tokens only, and `openid` as the only scope. Four library features are
  switched off: the built-in sign-in form (it accepts any name), the logout page (it stores a
  session for a caller who never signed in), pushed authorization requests (a record any caller
  can make the store write) and `userinfo` (the ID token is all a client reads).
- **Requests.** One handler stands in front of the provider. A request target that is not a path
  gets `400`. Any other request is answered only when its `Host` header is the issuer's host,
  written as the issuer writes it (no default port), and otherwise gets `421`; a reverse proxy in
  front must pass on the `Host` the client sent. The handler removes `Forwarded` and every
  `X-Forwarded-*` header, and takes the scheme from the issuer, since TLS ends at a reverse proxy.
  The provider builds each URL it publishes from the request it is answering, so without this a
  forged `Host` would put another origin's `jwks_uri` in the discovery document. The provider sees
  the socket's address as the client's, never one a request names. Of a request's cookies it is
  given only the sign-in step's own four (`_interaction`, `_interaction_resume` and their
  signatures); without a sign-in step it is given none.
- **Sign-in.** An authorization request (`/auth`) for a registered client redirects the browser to
  `/interaction/<uid>`, the sign-in step, answered by `src/interactions/router.ts`. The profile's
  sign-in method decides the step: `dev-password` shows the email and password form
  (`src/interactions/devPassword.ts`, pages in `src/interactions/pages.ts`); `steam` has no step in
  this build. A right password for an entitled account sends the browser on to the client's
  redirect address with a code. A right password for an account that is not entitled gets the
  not-owned page and no code; the page says nothing about the account. A wrong email and a wrong
  password get the same answer, after the same hashing work. The form is tied to its authorization
  request by a signed cookie, and a post is taken only with the issuer's own `Origin`, as
  `application/x-www-form-urlencoded`, of at most 8192 bytes. The pages load nothing from anywhere
  and cannot be framed.
- **No session.** The service keeps no sign-in session: every authorization request runs the
  sign-in step, whatever cookie the browser holds. The provider sets a `_session` cookie when a
  sign-in completes; the service never reads it, and its record expires after a minute. Cookies
  are signed with a key made at each start, so a restart ends the sign-ins in progress (the player
  starts again from the game) and nothing else.
- **Tokens.** The claims are named in `src/claims.ts`. An ID token carries `iss`, `sub`
  (`dev:<uuid>` for a dev account), `aud` (the client id), `mr_ent: ["base-game"]`, `iat` and
  `exp`, one hour later; a request that sends `nonce`, or `max_age` or `prompt=login`, also gets
  `nonce` or `auth_time` back, as OpenID Connect requires. A code is exchanged once, within 60
  seconds, with its PKCE verifier; a second exchange revokes everything that sign-in issued. Every
  refresh spends the refresh token and issues a new one; presenting a spent one revokes the chain.
  A chain ends 30 days after its sign-in: a new refresh token inherits what its predecessor had
  left. The account is read again at every exchange and refresh: when it is gone or not
  entitled the request is refused and the chain revoked, so only an entitled account is ever
  issued a token. An ID token already issued stays valid until its `exp`.
- **Attestations.** `POST /attest` (`src/attest.ts`) takes `Authorization: Bearer <ID token>` and
  the JSON body `{ "world": "…", "nonce": "…" }`, and answers `{ "attestation": "<JWT>" }`. The
  attestation is a compact JWT with the header `{ "alg": "Ed25519", "kid": … }` and exactly eight
  claims: `iss` (the issuer followed by `/attest`, a name no login token carries), `sub` (the
  account), `aud` (the world, as it was given), `nonce` (as it was given), `mr_ent:
  ["base-game"]`, `iat`, `exp` five minutes later, and a random `jti`. `world` and `nonce` are
  opaque to the service: 1 to 512 and 1 to 128 characters of visible ASCII (`0x21` to `0x7E`), in
  a body of at most 1024 bytes that holds nothing else, so an attestation stays under 2 KiB. What
  a world's name is: `docs/local-play.md` §3, "What the attestation names".
  - *The checks, in order; the first failure answers.* The token: signed by a login key with
    ES256, `iss` this issuer, `exp` in the future, a `sub` of 1 to 255 characters of visible
    ASCII and an `aud` (`401 invalid_token`).
    Its `mr_ent` names `base-game` (`403 not_entitled`). The body (`415`, `413` or `400
    invalid_request`). The account's limit (`429 rate_limited`, with `Retry-After`). The account
    itself, read again: an ID token outlives a cleared entitlement by up to an hour, and a binding
    outlives both (`403 not_entitled`). An error is `{ "error": "<code>" }`; a failure of the
    service is `500 server_error`. The token is checked before any of the body is read.
  - *Which requests.* Exactly the path `/attest` under the issuer's `Host`; `OPTIONS` answers a
    browser's preflight and any method but `POST` and `OPTIONS` gets `405`. Any other spelling of
    the path, and any other `Host`, is answered as every other request is (see Requests).
  - *Who may call.* An ID token of this issuer, whichever registered client it was issued to. The
    route reads no cookie, and every answer can be read from any origin
    (`Access-Control-Allow-Origin: *`), so the game client's page can call it: the token is the
    only way in, and a page that holds one could send it from anywhere. Whoever holds an account's
    ID token can therefore have worlds bound to that account while the token lasts, 20 an hour,
    and a binding outlasts the token.
  - *What is logged.* One line per attestation issued, with the account and the time, and one per
    failure of the service, with the account, the time, the step that failed and the error's
    class name. The account is the token's `sub`, which only this issuer writes and which holds
    no space or line break. A refusal logs nothing, so a caller cannot write lines at will. No line holds a
    world, a nonce, a token or an error's message, and the service keeps no record of the world
    an attestation was for.
- **Clients.** A client is a stored record: a client id and one redirect address, written by the
  admin command. Whatever else a record holds, the provider treats the client as public (no
  secret), with exactly that redirect address, the code and refresh grants and ES256 ID tokens. The
  token endpoint answers cross-origin requests from the redirect address's origin only. A game
  module accepts a token by its `aud`, so the game client's id is the audience the module allows
  (`monster-realm`).
- **Accounts.** A dev account is an email, an argon2id password hash (19 MiB, two passes; Node's
  built-in `crypto.argon2`) and an entitlement flag, stored under the email in lower case after
  Unicode NFKC normalisation. Passwords are generated by the admin command, 24 characters, printed
  once; the service never stores or takes one.
- **Limits.** Five wrong passwords for one email within ten minutes lock that email, the right
  password included; one attempt comes back as each failure turns ten minutes old. An email with
  no account locks the same way, and an attempt that ends in an internal error counts as a
  failure. At most four password hashes run at once (more attempts are told the service is busy),
  because hashing shares its threads with token signing. At most 20,000 sign-ins can be started
  per ten minutes, and a request target is at most 2048 characters (`414` past it); together they
  bound the sign-in records anonymous callers can leave in the store at about 100 MB. Past the cap
  an authorization request is answered `503`, and everything else keeps answering. The lock, the
  hash ceiling and the cap live in the process, so a restart clears them. There is no limit per
  network address: a flood can hold the busy answer or the 503 for as long as it lasts, and anyone
  who knows an account's email can keep it locked. An account gets at most 20 attestations in any
  hour. The count is of requests that reached it with a valid token and body: one refused because
  the account is gone or not entitled still counts, and one the service failed does not. It lives
  in the process too, so each instance counts alone.
- **Keys.** ES256 (P-256) signing keys, each with a `kid`. The first key in the file signs; the
  public half of every key is published at `/jwks`. `src/keys.ts` loads them from a JSON key file,
  `{ "profile": "<profile>", "keys": [ <private JWK>, … ] }`, marked with the profile it was made
  for and refused by any other profile. A generated `kid` is the key's RFC 7638 thumbprint.
- **Attestation keys.** An attestation is signed with an Ed25519 key of its own, never a login
  key (`docs/DECISIONS.md`, "The attestation is signed with Ed25519 and checked by
  `ed25519-dalek` compiled into the module"). The two key sets cannot stand in for each other: a
  P-256 key is refused as an attestation key and an Ed25519 key as a login key, an attestation
  key file that repeats a login key's `kid` is refused at start, and neither set verifies the
  other's tokens. The first attestation key signs. Where each profile's key lives is under "Attestation keys" below.
- **Storage.** One SQLite file, opened with Node's built-in `node:sqlite`.
  `src/store/sqliteAdapter.ts` is the provider's storage adapter and the only module that touches
  the database. An expired record is not found. A consumed record is still found, carrying
  `consumed`: that mark is how the provider recognises a replayed code or refresh token and revokes
  its grant. Expired records are deleted once a minute. A code, an access token and a refresh
  token are each stored under the SHA-256 of their value, so a copy of the database holds none
  that can be presented; accounts, clients, grants and the sign-in step's records are stored under
  their own ids.
- **No build step.** Node runs the TypeScript sources directly (`node src/server.ts`), so the
  sources use only syntax Node can strip (`erasableSyntaxOnly` in `tsconfig.json`) and relative
  imports name the `.ts` file.

## Profiles

`MR_ACCOUNT_PROFILE` selects one; there is no default.

| Profile | Issuer | Sign-in method | Signing keys | Attestation key | Data directory |
|---|---|---|---|---|---|
| `local-dev` | `http://localhost:4455` | `dev-password` | a key file, generated on the first start | one fixed key, the same on every machine | `account-service/.data` (ignored by git) unless set |
| `hosted-dev` | `https://auth.monster-realm.spookyowltech.com` | `dev-password` | a key file the operator provides, with no access for group or others | `attestation-keys.json` beside the key file, provided by the operator under the same rules | set by the operator |
| `production` | `MR_ACCOUNT_ISSUER` | `steam` | an external signer | an external signer | set by the operator |

The `production` profile loads and checks its settings and then refuses to start: this build holds
no external signer, and no `steam` sign-in step. Each dev issuer has its own keys.

## Attestation keys

A build of the game module holds the attestation keys it accepts as data and cannot fetch them
(`docs/local-play.md` §3, "How a world server verifies an attestation"), so a key signs nothing a
world accepts until its public half is in a build.

- **The published list.** `account-service/attestation-public-keys.json` holds, per profile, the
  public attestation keys a build may accept, each a JWK with its `kid` and `alg`. It is generated
  from `publishedAttestationKeys()` in `src/keys.ts`, and a test compares the two. From
  `account-service/`:

  ```sh
  node -e "import('./src/keys.ts').then((m) => process.stdout.write(JSON.stringify(m.publishedAttestationKeys(), null, 2) + '\n'))" > attestation-public-keys.json
  ```

  `hosted-dev` and `production` list no key. The service does not check that the key it signs
  with is listed: an unlisted key signs attestations no build accepts.
- **`local-dev`.** One fixed key, in `src/keys.ts`: its private bytes are the SHA-256 of a label
  in this repository, so every machine signs with the same key and every dev build can hold its
  public half. The repository is public, so anyone can sign with this key. A build that accepts
  it accepts a binding anyone can forge: its ownership check in a `local` or `private` world
  rehearses the flow and stops nobody. Every dev build accepts both dev lists
  (`docs/local-play.md` §3, "The build input, and the order of calls"); a dev build that has to
  hold against strangers needs a feature set that accepts the `hosted-dev` list alone, and there
  is none. No other profile signs with this key: a key file that holds it is refused.
- **`hosted-dev`.** The operator makes an Ed25519 key and keeps it in `attestation-keys.json` in
  the directory of the key file: `{ "profile": "hosted-dev", "keys": [ <private JWK>, … ] }`,
  each key `{ "kty": "OKP", "crv": "Ed25519", "kid": …, "x": …, "d": … }`. The first key signs.
  The instance refuses to start without the file, and the service never writes it. From
  `account-service/`, this makes one with a new key:

  ```sh
  (umask 077 && node -e "import('./src/keys.ts').then((m) => console.log(JSON.stringify({ profile: 'hosted-dev', keys: [m.generateAttestationKey()] }, null, 2)))" > /path/to/attestation-keys.json)
  ```
- **`production`.** An external signer holds the key, as it holds the login key; this build has
  none. It has to be a key service that signs with Ed25519. If the production host's key service
  cannot, the attestation moves to ES256 and the module's verifier with it (`docs/DECISIONS.md`,
  "The attestation is signed with Ed25519 and checked by `ed25519-dalek` compiled into the
  module").

## Settings

A setting that is unset or empty takes its default, if it has one. A set value is taken exactly
as written.

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
- a key file is missing (except on `local-dev`), not a regular file, larger than 64 KiB,
  malformed, marked for another profile, holds anything but P-256 private keys with distinct
  `kid`s, or, on `hosted-dev`, grants group or others any access;
- on `hosted-dev`, `attestation-keys.json` is missing from the key file's directory, breaks any
  of those rules of form, holds anything but Ed25519 private keys with distinct `kid`s whose `x`
  is the public half of their `d`, repeats a login key's `kid`, or holds the `local-dev`
  attestation key (the refusal names the file);
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
- The admin command runs from `account-service/` with the service's own settings, against the same
  database, while the service runs or not:

  ```sh
  cd account-service
  MR_ACCOUNT_PROFILE=local-dev node src/admin/cli.ts set-client monster-realm http://localhost:5290/
  MR_ACCOUNT_PROFILE=local-dev node src/admin/cli.ts create-account you@example.com
  ```

  A sign-in needs both: the game client's id with the exact address it returns to (the dev client
  is served at `http://localhost:5290/`), and an account. Each command prints `name=value` lines;
  `create-account` prints the account's generated `password=` once.
- An attestation, given an ID token from a sign-in:

  ```sh
  curl -sS http://localhost:4455/attest \
    -H "Authorization: Bearer $ID_TOKEN" -H 'Content-Type: application/json' \
    -d '{"world":"spki:<fingerprint>/<database>","nonce":"<the nonce that world issued>"}'
  ```
- `just account-test` runs the package's tests and `just account-typecheck` its typecheck. Both are
  part of `just ci` and of the `account-service` job in `.github/workflows/ci.yml`. `just lint`
  lints the package with the rest of the tree.
- Each recipe first installs the package's dependencies from `account-service/package-lock.json`
  when they are absent or older than the lock file, running no dependency's install script. It
  leaves a `node_modules` that is a symlink alone.
- The tests listen on a port the system chooses and send the issuer's `Host`, so they never need
  port 4455.

## Operator inputs

None is recorded.

| Input | Who supplies it | Recorded here as |
|---|---|---|
| The host behind `auth.monster-realm.spookyowltech.com` | the operator points the name at a host that runs the service | the host and the date |
| The Steam app id and a publisher Web API key | the operator; the key goes only into the production deployment's secret store | the app id (never the key) |
| The production host and issuer domain | the operator | the issuer URL every release module trusts |
| The `hosted-dev` attestation key | the operator makes it and keeps the private half on the host | its public half, in `publishedAttestationKeys()` and the generated list |
| The production key service | the operator, with the production host | that it signs with Ed25519, or that it cannot |

## Runbook

No deployment recipe exists; these are the procedures a deployed instance needs.

### Start

`just account-dev` for `local-dev`. A `hosted-dev` instance needs `MR_ACCOUNT_DATA_DIR`, a key
file marked `hosted-dev` and `attestation-keys.json` beside it, marked the same; no command
writes either.

### Admin accounts

`node src/admin/cli.ts <command>` from `account-service/`, with the instance's `MR_ACCOUNT_*`
settings. It refuses the `production` profile, exits 1 with one line on stderr when it refuses a
request, and exits 2 with its usage for anything that is not a command.

| Command | Does |
|---|---|
| `create-account <email> [--not-entitled]` | Makes an account, entitled unless the flag is given, and prints its generated password. Refuses an email that has an account. |
| `reset-password <email>` | Replaces the password with a new generated one and prints it. The account's subject and flag stay. |
| `set-entitlement <email> entitled\|not-entitled` | Sets whether the account owns the game. Clearing it takes effect at the account's next sign-in, code exchange or refresh, which is refused and revokes that chain; an ID token already issued lasts until its `exp`, an hour at most. |
| `set-client <client-id> <redirect-uri>` | Registers a client, or replaces its redirect address. The address is `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`, written in its canonical form (`http://localhost:5290/`, with the slash), with no user, password or fragment. |

A password is printed once and stored nowhere: hand it over, or reset it. A reset does not end the
account's existing sign-ins; their refresh tokens work until the chain ends. A locked email gets
one attempt back as each of its failures turns ten minutes old, and all of them at a restart. Run one command at a time against an
account: two writing the same account at the same instant can overwrite each other.

### Key rotation

The key file is an ordered list, read at start: a key added after the first is published and does
not sign; moved to the front it signs; taken out of the file it is published by nobody. Each change
takes effect at the next start. No command edits the file.

`attestation-keys.json` is an ordered list too, and its first key signs. A world accepts only
the keys its module was built with, so a new attestation key is published before it signs: add
its public half to `publishedAttestationKeys()` and regenerate the list, ship modules built with
it, then move the key to the front of the file and restart. A key leaves the published list once
no world should accept what it signed.

### Backup and restore

Everything to keep is the key file, `attestation-keys.json` on `hosted-dev`, and
`account.sqlite`. Copy the database with the service
stopped, or through SQLite's own backup: a plain copy of a file being written can be torn. The
database holds the accounts (emails and password hashes), the clients and the refresh-token chains
(as digests): a restored copy keeps every player signed in.

### Moving to another host

A module derives an account's identity from the issuer URL and the subject of its token
(`docs/DECISIONS.md`, "Accounts, guest identity and the claim flow"), so the issuer's name moves
with the service; the key file, the attestation key file and the database move with it.
