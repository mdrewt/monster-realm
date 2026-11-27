# Runbook: the account service

How to run, administer, back up and move the account service (`account-service/`, the OIDC
issuer game modules trust; design in [`../account-service.md`](../account-service.md)). The
recipe is `ops/auth/`: the image from `account-service/Dockerfile` behind Caddy, one compose
profile per service profile. Every command below runs from `ops/auth/`.

Losing the service's database or its keys is worse than losing a game database: a module
derives each account's `Identity` from the issuer and the token's subject, so a lost database
orphans every account, and a lost login key leaves no key that signs what modules expect. A lost
handle key leaves every friends and single-player world unable to tell which account a character
belongs to.

Commands marked **destructive** stop the service or replace data. Read the whole section first.

## 1. What runs

| Profile | Command | Serves | Volumes |
|---|---|---|---|
| `local-dev` | `docker compose --profile local-dev up -d` | `http://localhost:4455`, on `127.0.0.1` only | `local-dev-db`, `local-dev-keys` |
| `hosted-dev` | `docker compose --profile hosted-dev up -d` | `https://auth.monster-realm.spookyowltech.com`, ports 80 and 443 | `hosted-dev-db`, `hosted-dev-keys` |
| `production` | `docker compose --profile production up -d` | `MR_ACCOUNT_ISSUER` from `.env` | `production-db` |

- **The account container** (`account-<profile>`) runs as the image's `node` user (uid 1000) on
  a read-only root file system with every capability dropped. It can write only its two volumes
  (the database at `/var/lib/account-service/db/account.sqlite`, the keys in
  `/var/lib/account-service/keys/`) and a 64 MiB `/tmp`. No port of its own is published.
- **Caddy** (`caddy-<profile>`) is the only way in. It serves the profile's issuer origin: plain
  HTTP on port 4455 for `local-dev`, and for the other two an ACME certificate for the issuer's
  host name, kept in its `/data` volume. On the dev profiles it also serves the issuer's two
  check names, `ipv4.` and `ipv6.` in front of the issuer's host, each with its own certificate
  on `hosted-dev`; a world's server asks `POST /world/check` there. It serves no other host name,
  passes the client's `Host` on, and proxies to its own profile's account service; the service
  also answers only its issuer's host, and that one route under the check names (`421`
  otherwise).
- **The source address.** Caddy writes the address it takes a request to come from into
  `X-Forwarded-For`, replacing whatever the client sent there. The account container believes
  that header only from the private ranges a compose network is made from
  (`MR_ACCOUNT_TRUSTED_PROXY` in `docker-compose.yml`), which only its Caddy and this host are
  inside. The service reports that address to a world as the world's own, and counts its limits
  by it.
- **One public profile per host.** `hosted-dev` and `production` both take ports 80 and 443.
- **Refusals.** A container that lacks its profile's settings or keys exits 1 with one line,
  `account-service: refusing to start: <setting>: <problem>`, and `restart: unless-stopped`
  retries it. Read it with `docker compose --profile <profile> logs account-<profile>`. The
  `production` profile refuses in this build: it needs an external signer, which this build does
  not hold.
- The monitoring stack's Caddy (`ops/observability/`) also uses port 8443 and, when exposed,
  80/443; do not run it beside a public profile without moving one of them.

## 2. Start

**`local-dev`.** Nothing to prepare: the first start writes a login key file into
`local-dev-keys`, later starts reuse it. Check:

```sh
docker compose --profile local-dev up -d --build
curl -fsS http://localhost:4455/.well-known/openid-configuration
```

`MR_AUTH_LOCAL_PORT` (in `.env`, default 4455) moves only the host side of the published port.
The issuer stays `http://localhost:4455`, so a browser or a game client needs the default.

**`hosted-dev`.** Point three names at the host and open ports 80 and 443 first: Caddy asks for
their certificates at its first start.

| Name | Records |
|---|---|
| `auth.monster-realm.spookyowltech.com` | `A`, and `AAAA` when the host has an IPv6 address |
| `ipv4.auth.monster-realm.spookyowltech.com` | `A` only |
| `ipv6.auth.monster-realm.spookyowltech.com` | `AAAA` only |

A world asks the check name of the address family it listens on, so the service sees, and tells
it, the address of that family its requests leave from. A host with no IPv6 address leaves the
`ipv6.` name without a record; Caddy keeps retrying that one certificate and serves the rest.

The service never writes a `hosted-dev` key file, so make all three key files in the volume
once, before the first start:

```sh
docker compose --profile hosted-dev build
docker compose --profile hosted-dev run --rm -T --no-deps --entrypoint node account-hosted-dev -e '
  const fs = require("node:fs");
  const dir = "/var/lib/account-service/keys/";
  const write = (name, key) =>
    fs.writeFileSync(dir + name, JSON.stringify({ profile: "hosted-dev", keys: [key] }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  import("/app/src/keys.ts").then((k) => {
    write("keys.json", k.generateSigningKey());
    const attest = k.generateAttestationKey();
    write("attestation-keys.json", attest);
    write("handle-keys.json", k.generateHandleKey());
    console.log(JSON.stringify(k.publicAttestationKey(attest)));
  });'
docker compose --profile hosted-dev up -d
curl -fsS https://auth.monster-realm.spookyowltech.com/.well-known/openid-configuration
```

The command prints the attestation key's public half; a world accepts attestations from it only
once it is in `publishedAttestationKeys()` and a module built with it ships
(`docs/account-service.md`, "Attestation keys"). `flag: "wx"` refuses to overwrite a key file.
Back up the keys volume now (section 5): `handle-keys.json` can never be made again.

Then check, from another machine, that the service sees where a request comes from. The answer's
`address` must be that machine's own public address, of the family the name stands for:

```sh
curl -sS https://ipv4.auth.monster-realm.spookyowltech.com/world/check \
  -H 'Content-Type: application/json' \
  -d '{"handle":"none.none","world":"0000000000000000000000000000000000000000000000000000000000000000"}'
```

An `address` in a private range means the proxy or docker is hiding the caller: every world then
shares one limit, and no world can confirm its own address. Docker passes a caller's IPv4 address
through a published port, and passes an IPv6 address only on a network with IPv6 enabled; without
that, leave the `ipv6.` name without a record.

## 3. Admin accounts

The admin command runs inside the account container, against the database it serves, while it
runs:

```sh
docker compose --profile local-dev exec account-local-dev node src/admin/cli.ts set-client monster-realm http://localhost:5290/
docker compose --profile local-dev exec account-local-dev node src/admin/cli.ts create-account you@example.com
docker compose --profile local-dev exec account-local-dev node src/admin/cli.ts create-account other@example.com --not-entitled
```

Use `--profile hosted-dev exec account-hosted-dev` for the hosted instance; a hosted client
registers the game client's `https:` address. The commands, and what `reset-password` and
`set-entitlement` do, are in `docs/account-service.md` ("Admin accounts"). A password is printed
once: hand it over, or reset it. The command refuses the `production` profile.

## 4. Key rotation

The login key file is an ordered list read at start: the first key signs, every key is published
at `/jwks`. A module's host caches the key set (SpacetimeDB 2.11.0 refreshes it after 300 s and
drops it after 7,200 s), so a key is published before it signs and stays published until nothing
it signed is still in use. Each step edits the file in place and restarts the account container.
A restart ends the sign-ins in progress (the player starts again from the game) and clears the
in-process limits: password lockouts, the sign-in cap and attestation counts.

```sh
P=hosted-dev   # or local-dev
rotate() {     # rotate <keys.json|attestation-keys.json|handle-keys.json> publish | promote <kid> | retire <kid>
  docker compose --profile "$P" exec -T "account-$P" node -e '
    const fs = require("node:fs");
    const [name, step, kid] = process.argv.slice(1);
    const make = { "keys.json": "generateSigningKey", "attestation-keys.json": "generateAttestationKey", "handle-keys.json": "generateHandleKey" }[name];
    if (make === undefined) throw new Error("which key file?");
    const file = "/var/lib/account-service/keys/" + name;
    import("/app/src/keys.ts").then((k) => {
      const set = JSON.parse(fs.readFileSync(file, "utf8"));
      const at = set.keys.findIndex((key) => key.kid === kid);
      if (step === "publish") {
        const key = k[make]();
        set.keys.push(key);
        if (name === "attestation-keys.json") console.log("public=" + JSON.stringify(k.publicAttestationKey(key)));
      } else if (step === "promote" && at > 0) set.keys.unshift(...set.keys.splice(at, 1));
      else if (step === "retire" && at > 0) set.keys.splice(at, 1);
      else throw new Error("publish, promote <kid> or retire <kid>, where the kid is listed and does not sign");
      fs.writeFileSync(file + ".next", JSON.stringify(set, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(file + ".next", file);
      console.log("signs=" + set.keys[0].kid + " published=" + set.keys.map((key) => key.kid).join(","));
    });' "$@" && docker compose --profile "$P" restart "account-$P"
}
```

1. **Publish the next key:** `rotate keys.json publish`. It prints the new `kid` last in
   `published=`: published, not signing. Wait at least two hours, so every host's cached key set
   holds it.
2. **Promote it:** `rotate keys.json promote <new kid>`. Check that `signs=` names it. The old key
   is still published, so tokens it signed keep verifying. Promoting a key that already signs is
   refused, so a repeated step changes nothing.
3. **Retire the old key:** after at least one hour more (the longest an ID token lives) plus the
   two hours of caching, `rotate keys.json retire <old kid>`. The signing key cannot be retired.

Back up the keys volume after each step (section 5). A step that fails leaves the file as it was.
A left-over `keys.json.next` (a step that stopped between its write and its rename) makes the next
step refuse; remove it with `docker compose --profile "$P" exec "account-$P" rm
/var/lib/account-service/keys/keys.json.next`.

On `hosted-dev`, `attestation-keys.json` rotates with the same three steps on that file, except
that a world accepts only the attestation keys its module was built with: `rotate
attestation-keys.json publish` prints the new key's public half, which goes into
`publishedAttestationKeys()` and ships in modules (`docs/account-service.md`, "Attestation keys")
before the key is promoted.

`handle-keys.json` rotates with the first two steps and no wait: `rotate handle-keys.json
publish`, then `rotate handle-keys.json promote <new kid>`. Only the service reads a handle, so
nothing has to learn the new key, and each world's stored handles are replaced as the world
re-checks them. **Do not retire a handle key.** A world that still holds a handle under it is
told the handle is not ours, and that account cannot reach its character there until the key is
back in the file. Back up the keys volume before and after.

## 5. Backup and restore

What to keep: the database (accounts, clients and refresh-token chains, the chains as digests) and
the key files, `handle-keys.json` among them. The database is the routine backup; the keys hold a
key that can sign for any player and the key that reads every handle, so they go to a narrowly
scoped secret store, not into the routine sweep, and are taken again after every key change.

**Back up, while the service runs.** SQLite's `VACUUM INTO` writes a consistent copy of a database
in use; a plain copy of the file can be torn. The copy is made in the database volume, streamed
out, checked, and only then put in place of the previous backup. `B` is a directory outside the
checkout, made private by `umask 077`; `set -e` stops at the first failure.

```sh
P=local-dev                # or hosted-dev
B="$HOME/mr-auth-backup"   # outside the repository
(
  set -eu
  umask 077
  mkdir -p "$B"
  x() { docker compose --profile "$P" exec -T "account-$P" "$@"; }
  x rm -f /var/lib/account-service/db/backup.sqlite
  x node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); db.exec("PRAGMA busy_timeout = 5000"); db.prepare("VACUUM INTO ?").run(process.argv[2]);' /var/lib/account-service/db/account.sqlite /var/lib/account-service/db/backup.sqlite
  x cat /var/lib/account-service/db/backup.sqlite > "$B/account.sqlite.new"
  x rm /var/lib/account-service/db/backup.sqlite
  x tar -C /var/lib/account-service/keys -cf - . > "$B/keys.tar.new"
  [ "$(head -c 15 "$B/account.sqlite.new")" = "SQLite format 3" ]
  tar -tf "$B/keys.tar.new" | grep -q keys.json
  mv "$B/account.sqlite.new" "$B/account.sqlite"
  mv "$B/keys.tar.new" "$B/keys.tar"
)
```

Then, for example, `restic backup --tag account-service "$B/account.sqlite"` hourly, and
`keys.tar` into the secret store.

**What a restore brings back.** The database as it was at the backup: a refresh token issued
after it is lost and its player signs in again, and a refresh token spent after it works once
more. Admin changes made after it (a cleared entitlement, a password reset, a new account) are
undone: make them again after the restore.

**Restore into fresh volumes (destructive).** On a new host, or after `docker compose --profile
"$P" down -v` (which deletes the volumes). Each step refuses to write into a volume that already
holds keys or a database.

```sh
docker compose --profile "$P" build
docker compose --profile "$P" run --rm -T --no-deps --entrypoint sh "account-$P" -c 'test -z "$(ls -A /var/lib/account-service/keys)" && tar -C /var/lib/account-service/keys -xpf -' < "$B/keys.tar"
docker compose --profile "$P" run --rm -T --no-deps --entrypoint sh "account-$P" -c 'umask 077 && set -C && cat > /var/lib/account-service/db/account.sqlite' < "$B/account.sqlite"
docker compose --profile "$P" up -d
```

Then check: `/jwks` lists the same `kid`s as before, an account signs in, a module still
derives the same `Identity` for it (the issuer URL is unchanged), and a handle a world already
holds is answered back unchanged by `POST /world/check`.

### Drill record

`account-service/src/deployment.test.ts` ("a backup restored into fresh volumes") runs this
drill's container commands on `local-dev` in `just account-test`, on a source stack and a second
stack with fresh volumes; the host-side steps (`umask`, the checks, the `mv`) are the runbook's
alone:

| Date | Run | Result |
|---|---|---|
| 2026-11-21 | `npm --prefix account-service test -- src/deployment.test.ts` (Docker 29.2.1, Compose 5.0.2) | Pass. The restored `/jwks` equals the source's and verifies the source's ID token; an entitled account signs in and a not-entitled one gets the not-owned page; the refresh token newest at the backup refreshes, the spent one is refused and revokes its chain. |

## 6. Moving to another host

The issuer's name moves with the service: a module derives identities from the issuer URL, so
changing it orphans every account. Caddy can get the new host's certificate only once the name
points there.

1. Lower the DNS record's TTL a day ahead.
2. On the old host (`P` and `B` as in section 5), stop traffic and take the backup:
   `docker compose --profile "$P" stop "caddy-$P"`, then section 5's backup.
3. **Destructive:** `docker compose --profile "$P" down` on the old host.
4. On the new host, check out the same commit and copy `B` there. Run section 5's restore, but in
   place of its last line start only the service: `docker compose --profile "$P" up -d
   "account-$P"`.
5. Point the issuer's DNS name and its two check names at the new host, open ports 80 and 443,
   and wait for the records to resolve to it. Then `docker compose --profile "$P" up -d`: Caddy
   obtains the certificates.
6. Check discovery and `/jwks` at the issuer URL, sign in with a test account, and run section 2's
   source-address check: every world's stored address is the old host's view of it until its next
   check.

Keep the old host's volumes until the new host has served sign-ins; then delete them with
`down -v`.
