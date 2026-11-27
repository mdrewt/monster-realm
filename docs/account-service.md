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

The service also holds the Steam checks the Steam sign-ins will call (section "Steam"): asking
Steam whose ticket a ticket is and what licence a player holds, the rule that turns that licence
into "owns the game", our own deny-list, and the settings that say which Steam app a profile
checks. No sign-in step calls them in this build, so a running service never reaches Steam.

The service also signs world attestations at `POST /attest`: a statement, good for five minutes
and addressed to one world, that an account owns the game. A `local` or `private` world's module
checks it with a key it holds as data and binds the account (`docs/DECISIONS.md`, "A private world
verifies an account by a per-world attestation our account service signs").

The service also answers a world that checks an account itself (`docs/refactors/account-checks.md`
§5): `POST /ticket` gives a signed-in player a one-use ticket for one world, and `POST
/world/check` lets that world's server redeem it, and later ask again, without a token of its
own. No module calls them in this build.

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
- **World tickets.** `POST /ticket` (`src/worldTicket.ts`) takes `Authorization: Bearer <ID
  token>` and the JSON body `{ "world": "…" }`, the name of the world the player is joining as
  the player's own software authenticated it (`docs/local-play.md` §3, "What the attestation
  names"), and answers `{ "ticket": "…" }`: 32 random bytes as 43 characters of base64url. The
  service keeps the account and that name for 60 seconds under the ticket's SHA-256, and nothing
  else of it. A ticket opens nothing by itself: it says who asked and for which world, and the
  check that redeems it answers for the account. So one is issued whether or not the account
  still owns the game or still exists.
  - *The checks, in order; the first failure answers.* The token, as `/attest` checks it but with
    no `mr_ent` needed (`401 invalid_token`). The body: `application/json`, at most 1024 bytes,
    exactly `world`, 1 to 512 characters of visible ASCII (`415`, `413` or `400
    invalid_request`). The account's limit (`429 rate_limited`, with `Retry-After`). A failure
    of the service is `500 server_error`. The token is checked before any of the body is read.
  - *Which requests.* Exactly the path `/ticket` under the issuer's `Host`, with `OPTIONS`, `405`
    and readable-from-any-origin answers as `/attest` has them: the game client's page calls it.
  - *One place makes a ticket:* `issue` of `createWorldTickets`. A sign-in built for a browser at
    a friend's server issues its ticket through it.
- **World checks.** `POST /world/check` is called by a world's server. It takes no token, and
  nothing identifies its caller. The body is JSON, at most 16 KiB, in exactly one of two forms.
  `world` in both is the calling world's database identity, 64 lower-case hex digits.
  - *A ticket:* `{ "ticket": "…", "names": [ … ], "world": "…" }`, where `names` is the 1 to 16
    names the world answers to. The ticket is spent. When it is unknown, already spent or
    expired, or was issued for a name that is not among `names`, the answer is one fixed `403
    ticket_refused`, and the ticket is gone whichever it was. Otherwise the answer is `{
    "handle", "entitled", "address", "name" }`: the account's handle in that world, whether the
    account owns the game now (read afresh), the request's source address, and the name the
    ticket was issued for. Of two presentations of one ticket at once, one is answered.
  - *A handle:* `{ "handle": "…", "world": "…" }`, a re-check of an account the world already
    knows. The answer is `{ "handle", "entitled", "address" }`, with the handle under the current
    key. A handle that does not open, or is another world's, answers `{ "entitled": false,
    "address" }` and no handle: the world can tell "this is no handle of yours" from "this
    account does not own the game".
  - An account that is gone answers exactly as one that does not own the game, in both forms, so
    the route tells nobody that an account was deleted. An account that cannot be read is `500
    server_error`, never "not entitled". A ticket presented in that request is spent all the same.
  - *The checks, in order; the first failure answers.* `POST` (`405`). The source address is
    known (`400`). The source address's limit, counted before any of the body is read (`429`,
    with `Retry-After`). The body (`415`, `413` or `400 invalid_request`): a malformed body
    spends no ticket. Then the form's own answer; a handle that opens for this world passes its
    own limit first (`429`).
  - *Which requests.* Exactly the path `/world/check`, under the issuer's `Host` or one of its
    two check names, `ipv4.` and `ipv6.` in front of that host (`worldCheckHosts`). A deployment
    gives the first an `A` record alone and the second an `AAAA` record alone, so a world can ask
    over the address family it wants `address` reported in. The check names answer nothing else
    (`421`). No answer carries a CORS header: a page has no business here.
  - *What a caller can learn.* Whoever redeems a ticket states the world's identity itself, so a
    host can state another world's and receive the player's handle there; it tells that host
    something only beside that world's own data (`docs/refactors/account-checks.md` §3.2).
    Whoever holds a handle can ask whether its account owns the game now, and sees `429` after
    12 answers in an hour, which an invented handle never gets. A handle's length is its
    subject's length plus a constant.
  - *What is logged, by both routes.* One line per ticket issued and one per ticket redeemed,
    with the account and the time, and one per failure of the service, with the account when it
    is known, the time, the step that failed and the error's class name. A refusal logs nothing,
    and neither does an answered handle check, whose caller is anonymous: no caller can write
    lines at will. No line holds a world, a name, a handle, a ticket, an address or an error's
    message.
- **Handles.** A handle (`src/worldHandle.ts`) is the account's subject and one world's database
  identity, encrypted so that only the service reads them; a world keeps it in place of the
  account. It is `<kid>.<base64url>`: the handle key's `kid`, then the tag and ciphertext of
  AES-SIV (RFC 5297, a 64-byte key, Node's own `aes-256-siv`) over the identity's 32 bytes
  followed by the subject. The encryption is deterministic, so one account in one world has one
  handle under one key, another world or account has another, and the service keeps no table of
  who joined which world. The first handle key seals; every key in the file opens, and what a
  retired key's handle holds is answered sealed under the first. Only the one spelling the
  service writes opens.
- **Source address.** `address` in an answer, and the address a limit counts, is the address at
  the other end of the request's socket. When that address is inside `MR_ACCOUNT_TRUSTED_PROXY`
  (the reverse proxy in front), it is instead the last address in the request's
  `X-Forwarded-For`, the one that proxy wrote; from anyone else the header is not read
  (`createSourceAddress` in `src/rateLimit.ts`). A trusted proxy that wrote no address leaves
  the source unknown, and the check answers `400`: the proxy's own address is never given as a
  caller's. An address is written in one spelling: dotted IPv4, IPv6 in lower case with its
  longest run of zeros compressed, and an IPv4-mapped IPv6 address as IPv4.
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
  in the process too, so each instance counts alone. An account gets at most 10 tickets in any
  minute, counted the same way. A source address gets at most 120 world checks in any minute,
  whatever their bodies and answers; and one account in one world is checked by handle from one
  source address at most 12 times in any hour, so a caller who harvested handles cannot use up
  what the player's own world may ask. A limit counts an IPv6 source under its /64. Each of the
  two world-check limits holds at most 100,000 keys at once and refuses a new one past that,
  since anyone can make keys there. These numbers are this build's own; a world that re-checks
  its players sizes its bursts against them (`docs/refactors/account-checks.md` §5.1).
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
- **Handle keys.** A handle key is 64 random bytes with a `kid`, held in a handle key file of the
  login key file's form: `{ "profile": "<profile>", "keys": [ { "kty": "oct", "kid": …, "k": … },
  … ] }`, marked with its profile, the first key sealing. A handle key is never replaced by a
  new one: under another key every account has another handle in every world, and a world takes
  an account it knows for one it has never seen, with the character it keeps out of reach. So
  only `local-dev` makes the file when it is absent; any other profile refuses to start without
  it, and a key that has sealed handles stays in the file for as long as a world may hold one.
- **Storage.** One SQLite file, opened with Node's built-in `node:sqlite`.
  `src/store/sqliteAdapter.ts` is the provider's storage adapter and the only module that touches
  the database. An expired record is not found. A consumed record is still found, carrying
  `consumed`: that mark is how the provider recognises a replayed code or refresh token and revokes
  its grant. Expired records are deleted once a minute. A code, an access token and a refresh
  token are each stored under the SHA-256 of their value, so a copy of the database holds none
  that can be presented; accounts, clients, grants and the sign-in step's records are stored under
  their own ids. A world ticket is stored under the SHA-256 of its text too, for its 60 seconds,
  and is taken out by one statement that deletes the record and returns it (`take`), so no two
  presentations are both given it.
- **No build step.** Node runs the TypeScript sources directly (`node src/server.ts`), so the
  sources use only syntax Node can strip (`erasableSyntaxOnly` in `tsconfig.json`) and relative
  imports name the `.ts` file.

## Profiles

`MR_ACCOUNT_PROFILE` selects one; there is no default.

| Profile | Issuer | Sign-in method | Steam app | Signing keys | Attestation key | Handle keys | Data directory |
|---|---|---|---|---|---|---|---|
| `local-dev` | `http://localhost:4455` | `dev-password` | none, or `480` | a key file, generated on the first start | one fixed key, the same on every machine | `handle-keys.json` beside the key file, generated on the first start | `account-service/.data` (ignored by git) unless set |
| `hosted-dev` | `https://auth.monster-realm.spookyowltech.com` | `dev-password` | none, or `480` | a key file the operator provides, with no access for group or others | `attestation-keys.json` beside the key file, provided by the operator under the same rules | `handle-keys.json` beside the key file, provided by the operator under the same rules | set by the operator |
| `production` | `MR_ACCOUNT_ISSUER` | `steam` | none, or the game's own (never `480`) | an external signer | an external signer | the file `MR_ACCOUNT_HANDLE_KEY_FILE` names | set by the operator |

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

## Steam

Every player must own the game on Steam (`docs/DECISIONS.md`, "Every player must own the game on
Steam, for now"). This section is what the service can ask Steam and how it decides; the sign-in
steps that use it are not in this build.

- **Which app.** `MR_STEAM_APP_ID` configures Steam for a profile: the loaded configuration then
  carries `steam: { appId }`, and a dev profile keeps its password sign-in beside it. A dev
  profile takes only `480`, Valve's development app (Spacewar), which every Steam account can
  run: it proves a Steam sign-in and never ownership of the game, and a dev deployment can never
  act for the game's own app. `production` takes the game's own app id and never `480`.
- **Keys.** `src/steam/webApi.ts` is the only reader of a Steam key, and reads it from the
  environment as an own entry: the publisher key (`MR_STEAM_PUBLISHER_KEY`) on `production`, the
  optional ordinary Web API key (`MR_STEAM_WEB_API_KEY`) on a dev profile. The loaded
  configuration holds no key. A key is 1 to 256 characters of visible ASCII. The client refuses to
  be built without `MR_STEAM_APP_ID`, on `production` without the publisher key, and for an app
  that is not the profile's (anything but `480` on a dev profile, `480` on `production`); loading
  the configuration alone requires no Steam setting.
- **The client.** `createSteamWebApi` makes one client for the profile: the partner host
  `https://partner.steam-api.com` with the publisher key on `production`, the public host
  `https://api.steampowered.com` with the ordinary key on a dev profile. The key travels in the
  `x-webapi-key` request header and in no request target. Each call is one `GET` with a
  five-second limit on the whole exchange and is never retried. A refusal would not change, and
  the partner host rate-limits an address that keeps sending refused requests; a failure of
  Steam's is the player's to retry by signing in again, so an outage costs this address one
  request per attempt. A redirect is not followed, because the followed request would carry the
  key to another host. At most 64 KiB of an answer
  is read. Anything that subscribes to Node's `undici` diagnostics channel sees request headers,
  the key among them.
- **`authenticateTicket(ticket, identity)`** asks
  `ISteamUserAuth/AuthenticateUserTicket/v1/?appid=…&ticket=…&identity=…`. The ticket is the hex
  of what `GetAuthTicketForWebApi(identity)` returned, at most 2560 bytes; anything else is
  rejected without a request. The identity is 1 to 128 letters, digits, dots, underscores, colons
  and hyphens, and is always sent: Steam authenticates a ticket made for any identity when the
  parameter is absent, and App ID 480 is shared by every developer. A call with any other
  identity is a fault of the caller's and rejects with a `TypeError`, sending nothing. The answer is one of:
  `authenticated` with the SteamID; `rejected` (Steam answered with an `error` member: not a
  valid ticket, made for another identity or for another app); `failed`. A ticket authenticates
  again for as long as it lives, so whoever captures one can present it.
- **`checkAppOwnership(steamId)`** asks `ISteamUser/CheckAppOwnership/v4/?appid=…&steamid=…`. Only
  `production` can: on a dev profile it sends nothing and answers `failed`, because only the
  publisher key of the app itself may ask. The answer is `answered` with the four members the
  rule reads, or `failed`. An answer whose `result` is anything but `OK` says nothing and is
  `failed`. Otherwise an answer whose `ownsapp` is `false` is reported as one fixed "does not own
  it" value whatever else it holds, and an answer whose `ownsapp` is `true` needs boolean
  `permanent` and `sitelicense` and a digit-string `ownersteamid`.
- **Failures.** `failed` carries a `SteamApiError` with a reason: `timeout`, `unreachable`,
  `status` (with the status number), `malformed` (a `200` whose body is not the expected JSON) or
  `unconfigured` (this profile has no key for the call; nothing was sent). The error holds
  nothing Steam sent but the status number: its message is fixed by the reason and it has no
  cause. One line is logged per failed exchange, naming the call, the reason and the status
  number; a success, a rejected ticket and `unconfigured` log nothing, so a caller cannot write
  lines at will. No line holds a key, a ticket, a request target or anything of Steam's answer
  but the status number.
- **The rule.** `entitled(ownership, steamId)` in `src/steam/ownership.ts`: a player owns the game
  only with `ownsapp` true, `permanent` true, `sitelicense` false and `ownersteamid` equal to
  their own SteamID. A Family Sharing borrower, a free weekend and a PC café do not count.
- **The decision.** `steamEntitlementSource` decides one player for one profile. Our own
  deny-list is read first on every profile: a denied SteamID is not entitled whatever Steam or a
  flag says, and is asked about nowhere else. After it, a dev profile reads only the admin flag
  on `steam:<steamid64>` (an account with no flag is not entitled) and never asks Steam;
  `production` asks Steam, applies the rule, and never reads a flag. The answer is entitled, or
  not entitled with a reason: `denied`, `not-owned`, or `unavailable` when Steam failed to
  answer, which carries the client's error. All three mean no token; `unavailable` says nothing
  was learnt about what the player owns. A ban reaches a player at their next issuance: one that
  lands while a decision is waiting on Steam does not change that decision.
- **Records.** `src/denyList.ts` keeps both things the store holds about a SteamID, each a record
  under the SteamID with no expiry: the deny-list (`denyList`) and the dev flag
  (`steamAccounts`). Only the admin command writes them.
- **SteamIDs.** A SteamID is the 17 digits of a SteamID64, and a Steam player's subject is
  `steam:<steamid64>`; `parseSteamId`, `steamSubject` and `steamIdOfSubject` are the one place
  that form is written and read.

### What Steam answers

Valve documents both calls on the partner site (`partner.steamgames.com/doc/webapi/ISteamUserAuth`
and `/ISteamUser`, `/doc/webapi_overview/auth` for keys, `/doc/webapi_overview/responses` for
status codes), read on 2026-11-26:

- `AuthenticateUserTicket` v1 takes `key`, `appid`, `ticket` and `identity` ("only tickets created
  with that parameter will successfully authenticate"), needs a publisher key on the partner
  host, and is "also available for games servers via the `https://api.steampowered.com/` domain
  using a Web API user authentication key", rate limited. It returns "the user's 64-bit SteamID
  if the user's ticket is valid". No response or error body is documented.
- `CheckAppOwnership` v4 takes `key`, `steamid` and `appid`, and needs the publisher key that owns
  the app. Its documented response fields are `ownsapp`, `permanent` ("not true for ownership via
  Family Sharing, free weekends or PC Café program"), `timestamp`, `timeexpires`, `ownersteamid`
  ("the true owner if user is accessing this app via Family Sharing; otherwise … the same steamID
  passed in"), `sitelicense` and `usercanceled`. The service reads `ownsapp`, `permanent`,
  `sitelicense` and `ownersteamid`. The object that wraps them (`appownership`) and its `result`
  member are not in the documentation: the service expects them as the API is known to answer,
  and fails closed (nobody entitled) if production's first live answer differs.
- The key "can be provided either as a standard parameter or by setting the 'x-webapi-key'
  request header value". A `401` or `403` means "access is denied, retrying will not help", and
  on the partner host a `403` brings "strict rate limits for the connecting IP".

A live `AuthenticateUserTicket` run on 2026-11-26, as App ID 480 on the public host with the
operator's ordinary Web API key and a ticket of 234 bytes from
`GetAuthTicketForWebApi("monster-realm-account")` (steamworks.js 0.4.0 beside the Steam client on
the operator's Windows host):

| Request | Steam answers |
|---|---|
| key in `x-webapi-key`, the ticket's identity | `200`, `{"response":{"params":{"result":"OK","steamid":"<17 digits>","ownersteamid":"<17 digits>","vacbanned":false,"publisherbanned":false}}}` |
| key as the `key` parameter | the same |
| the same ticket a second time | the same |
| another `identity` | `200`, `{"response":{"error":{"errorcode":105,"errordesc":"Identity parameter did not match"}}}` |
| no `identity` parameter | `200`, authenticated |
| a hex ticket Steam never issued, or one that is not hex | `200`, `{"response":{"error":{"errorcode":3,"errordesc":"Invalid parameter"}}}` |
| another `appid` | `200`, `{"response":{"error":{"errorcode":102,"errordesc":"Ticket for other app"}}}` |
| no key | `400`, an HTML page |

Through the service's own client on `local-dev` (`createSteamWebApi`, default origin) such a
ticket is `authenticated`, written in lower or upper case; another identity and an unknown ticket
are `rejected`,
`checkAppOwnership` is `unconfigured` with nothing sent, and nothing is logged. `vacbanned` and
`publisherbanned` are not read. `CheckAppOwnership` has no live answer yet: only the publisher key
of the game's own app may call it.

### The Steam fake

`account-service/test-util/steamStub.ts` is a local fake of the two calls, answering with the
shapes above; every test that needs Steam uses it, and no test reaches Steam. It serves only the
two exact paths, takes one key, issues tickets bound to a SteamID and an identity, answers
ownership per SteamID, records every request, and can be told to answer the next request with any
status, any body, a redirect, nothing at all, a body that never ends or a closed connection. It
does not fake Steam's OpenID sign-in.

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
| `MR_ACCOUNT_HANDLE_KEY_FILE` | The handle key file; on a dev profile, by default `handle-keys.json` in the key file's directory. An absolute, normalised path. Required by `production`. |
| `MR_ACCOUNT_TRUSTED_PROXY` | The reverse proxy in front: a comma-separated list, with no space, of 1 to 16 IP addresses and CIDR blocks. A request from inside one has the source address the proxy wrote (see Source address). Unset: no proxy is trusted. |
| `MR_ACCOUNT_HOST` | The address to listen on: an IP address or `localhost`. Default `127.0.0.1`. |
| `MR_ACCOUNT_PORT` | The port to listen on, 0 to 65535 (0 lets the system choose). Default 4455. |
| `MR_STEAM_APP_ID` | The Steam app the profile checks players against. A dev profile takes exactly `480`; `production` takes the game's app id, a decimal number from 1 to 4294967295 that is not `480`. Unset: Steam is not configured. |
| `MR_STEAM_WEB_API_KEY` | A dev profile's ordinary Steam Web API key, for checking a real ticket under App ID 480. Optional, and taken only with `MR_STEAM_APP_ID`. Refused by `production`. |
| `MR_STEAM_PUBLISHER_KEY` | The publisher Web API key of the game's app. `production` only; refused by the dev profiles. |

The service refuses to start, naming the setting on stderr and exiting 1, when:

- `production` is given the dev sign-in method, a key file, an `http:` issuer, or an issuer on a dev
  issuer's host;
- a dev profile is given `MR_ACCOUNT_ISSUER`, `MR_STEAM_PUBLISHER_KEY`, an `MR_STEAM_APP_ID` that
  is not exactly `480`, or `MR_STEAM_WEB_API_KEY` without `MR_STEAM_APP_ID`;
- `production` is given `MR_STEAM_WEB_API_KEY`, or an `MR_STEAM_APP_ID` that is `480` or not an
  app id;
- a key file is missing (except on `local-dev`), not a regular file, larger than 64 KiB,
  malformed, marked for another profile, holds anything but P-256 private keys with distinct
  `kid`s, or, on `hosted-dev`, grants group or others any access;
- on `hosted-dev`, `attestation-keys.json` is missing from the key file's directory, breaks any
  of those rules of form, holds anything but Ed25519 private keys with distinct `kid`s whose `x`
  is the public half of their `d`, repeats a login key's `kid`, or holds the `local-dev`
  attestation key (the refusal names the file);
- `production` has no `MR_ACCOUNT_HANDLE_KEY_FILE`, or names a path with no file; `hosted-dev`
  has no handle key file; or a handle key file breaks any of the key file's rules of form or
  holds anything but 64-byte `oct` keys with distinct `kid`s and distinct bytes (the refusal
  names `MR_ACCOUNT_HANDLE_KEY_FILE`);
- `MR_ACCOUNT_TRUSTED_PROXY` holds a space, an empty entry, a name, an address with a zone, a
  prefix length out of range or more than 16 entries;
- any other name beginning `MR_ACCOUNT_` or `MR_STEAM_`, in any letter case and with or without a
  space around it, is set: a misspelt setting never falls back to a default, and a Steam key
  under another spelling is never taken for no key.

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
- A Steam account's entitlement on a dev profile, and a ban:

  ```sh
  MR_ACCOUNT_PROFILE=local-dev node src/admin/cli.ts set-entitlement steam:<steamid64> entitled
  MR_ACCOUNT_PROFILE=local-dev node src/admin/cli.ts deny steam:<steamid64>
  ```
- An attestation, given an ID token from a sign-in:

  ```sh
  curl -sS http://localhost:4455/attest \
    -H "Authorization: Bearer $ID_TOKEN" -H 'Content-Type: application/json' \
    -d '{"world":"spki:<fingerprint>/<database>","nonce":"<the nonce that world issued>"}'
  ```
- A ticket for a world, given an ID token, then that world's check and its later re-check:

  ```sh
  curl -sS http://localhost:4455/ticket \
    -H "Authorization: Bearer $ID_TOKEN" -H 'Content-Type: application/json' \
    -d '{"world":"spki:<fingerprint>/<database>"}'
  curl -sS http://localhost:4455/world/check -H 'Content-Type: application/json' \
    -d '{"ticket":"<the ticket>","names":["spki:<fingerprint>/<database>"],"world":"<64 hex digits>"}'
  curl -sS http://localhost:4455/world/check -H 'Content-Type: application/json' \
    -d '{"handle":"<the handle answered>","world":"<the same 64 hex digits>"}'
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

Recorded: the dev profiles' ordinary Steam Web API key exists, registered for `localhost`. It is
kept with `MR_STEAM_APP_ID=480` in `~/.config/monster-realm/steam-dev.env` on the operator's
machine (mode 600, outside every repository); a run sources that file and never prints, copies or
commits it. No other input is recorded.

| Input | Who supplies it | Recorded here as |
|---|---|---|
| The host behind `auth.monster-realm.spookyowltech.com` | the operator points the name at a host that runs the service | the host and the date |
| An ordinary Steam Web API key for the dev profiles | the operator; it stays in a file outside every repository | that it exists (never the key) |
| The Steam app id and a publisher Web API key | the operator; the key goes only into the production deployment's secret store, which hands it to the service as `MR_STEAM_PUBLISHER_KEY` | the app id (never the key) |
| The production host and issuer domain | the operator | the issuer URL every release module trusts |
| The `hosted-dev` attestation key | the operator makes it and keeps the private half on the host | its public half, in `publishedAttestationKeys()` and the generated list |
| The `hosted-dev` handle key | the operator makes it on the host and backs it up with the login key | that it exists (never the key) |
| The two check names of each hosted issuer | the operator gives `ipv4.<issuer host>` an `A` record alone and `ipv6.<issuer host>` an `AAAA` record alone, both to the host that runs the service | the names and the date |
| The production key service | the operator, with the production host | that it signs with Ed25519, or that it cannot |

## Runbook

The deployment recipe is `ops/auth/` (the image from `account-service/Dockerfile` behind Caddy),
and its commands are in [`runbooks/account-service.md`](runbooks/account-service.md). This
section holds the rules those procedures follow.

### Start

`just account-dev` runs `local-dev` from the checkout; `docker compose --profile <profile> up -d`
in `ops/auth/` runs the image. A `hosted-dev` instance needs `MR_ACCOUNT_DATA_DIR`, a key file
marked `hosted-dev`, and `attestation-keys.json` and `handle-keys.json` beside it, marked the
same; the service never writes any of them (the runbook makes all three in the keys volume). The
recipe sets `MR_ACCOUNT_TRUSTED_PROXY` to the ranges its Caddy connects from.

### Admin accounts

`node src/admin/cli.ts <command>` from `account-service/`, with the instance's `MR_ACCOUNT_*`
settings. It refuses the `production` profile, exits 1 with one line on stderr when it refuses a
request, and exits 2 with its usage for anything that is not a command.

| Command | Does |
|---|---|
| `create-account <email> [--not-entitled]` | Makes an account, entitled unless the flag is given, and prints its generated password. Refuses an email that has an account. |
| `reset-password <email>` | Replaces the password with a new generated one and prints it. The account's subject and flag stay. |
| `set-entitlement <email> entitled\|not-entitled` | Sets whether the account owns the game. Clearing it takes effect at the account's next sign-in, code exchange or refresh, which is refused and revokes that chain; an ID token already issued lasts until its `exp`, an hour at most. |
| `set-entitlement steam:<steamid64> entitled\|not-entitled` | Sets a Steam account's dev flag, the only thing that entitles a Steam player on a dev profile. The account needs no sign-in first, and one with no flag is not entitled. Prints `sub=` and `entitled=`. |
| `deny steam:<steamid64>` | Puts the SteamID on the deny-list: not entitled, whatever its flag or Steam says. Prints `sub=` and `denied=true`. |
| `allow steam:<steamid64>` | Takes it off the deny-list; its flag is as it stood. Prints `sub=` and `denied=false`. |
| `set-client <client-id> <redirect-uri>` | Registers a client, or replaces its redirect address. The address is `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`, written in its canonical form (`http://localhost:5290/`, with the slash), with no user, password or fragment. |

A Steam account is written `steam:` and the 17 digits of its SteamID. Anything else that begins
`steam:`, and for `deny` and `allow` any other target at all, is refused after the `production`
check and before the command loads its configuration or touches the disk. The deny-list has no
other writer, and the command refuses `production`, so no SteamID can be denied there.

A password is printed once and stored nowhere: hand it over, or reset it. A reset does not end the
account's existing sign-ins; their refresh tokens work until the chain ends. A locked email gets
one attempt back as each of its failures turns ten minutes old, and all of them at a restart. Run one command at a time against an
account: two writing the same account at the same instant can overwrite each other.

### Key rotation

The key file is an ordered list, read at start: a key added after the first is published and does
not sign; moved to the front it signs; taken out of the file it is published by nobody. Each change
takes effect at the next start. The service and the admin command never edit the file; the
runbook's rotation steps do.

`attestation-keys.json` is an ordered list too, and its first key signs. A world accepts only
the keys its module was built with, so a new attestation key is published before it signs: add
its public half to `publishedAttestationKeys()` and regenerate the list, ship modules built with
it, then move the key to the front of the file and restart. A key leaves the published list once
no world should accept what it signed.

The handle key file is an ordered list too: its first key seals and every key opens. A new first
key changes no account's standing, because a world that presents a handle under an older key is
answered with the new one and stores it. A key taken out of the file strands every handle still
under it: a world that presents one is told it is no handle of ours, and the account behind it
reaches that world's character again only if the key is put back. Keep every key that has ever
sealed.

### Backup and restore

Everything to keep is the key file, the handle key file, `attestation-keys.json` on
`hosted-dev`, and `account.sqlite`. Losing the handle key file loses every world's link between
an account and its character, as losing the database loses the accounts. Copy the database with the service stopped, or through SQLite's own backup
(the runbook uses `VACUUM INTO` on the running service): a plain copy of a file being written
can be torn. The
database holds the accounts (emails and password hashes), the clients and the refresh-token chains
(as digests): a restored copy keeps every player who signed in before the backup signed in, and
undoes what changed after it (the runbook's "What a restore brings back").

### Moving to another host

A module derives an account's identity from the issuer URL and the subject of its token
(`docs/DECISIONS.md`, "Accounts, guest identity and the claim flow"), so the issuer's name moves
with the service; the key file, the attestation key file, the handle key file and the database
move with it, and the two check names move to the new host with the issuer's.
