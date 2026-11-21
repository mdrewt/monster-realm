# Runbook: the account service

How to run, administer, back up and move the account service (`account-service/`, the OIDC
issuer game modules trust; design in [`../account-service.md`](../account-service.md)). The
recipe is `ops/auth/`: the image from `account-service/Dockerfile` behind Caddy, one compose
profile per service profile. Every command below runs from `ops/auth/`.

Losing the service's database or its keys is worse than losing a game database: a module
derives each account's `Identity` from the issuer and the token's subject, so a lost database
orphans every account, and a lost login key leaves no key that signs what modules expect.

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
  host name, kept in its `/data` volume. It passes the client's `Host` on, and the service answers
  only its issuer's host (`421` otherwise).
- **One profile per host.** The account services share the network name Caddy proxies to, and the
  two public profiles both take ports 80 and 443.
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

**`hosted-dev`.** Point `auth.monster-realm.spookyowltech.com` at the host and open ports 80 and
443 first: Caddy asks for the certificate at its first start. The service never writes a
`hosted-dev` key file, so make both key files in the volume once, before the first start:

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
    console.log(JSON.stringify(k.publicAttestationKey(attest)));
  });'
docker compose --profile hosted-dev up -d
curl -fsS https://auth.monster-realm.spookyowltech.com/.well-known/openid-configuration
```

The command prints the attestation key's public half; a world accepts attestations from it only
once it is in `publishedAttestationKeys()` and a module built with it ships
(`docs/account-service.md`, "Attestation keys"). `flag: "wx"` refuses to overwrite a key file.

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
it signed is still in use. Each step edits the file in place and restarts the account container;
a restart ends the sign-ins in progress (the player starts again from the game) and nothing else.

```sh
P=hosted-dev   # or local-dev
rotate() {
  docker compose --profile "$P" exec -T "account-$P" node -e '
    const fs = require("node:fs");
    const file = "/var/lib/account-service/keys/keys.json";
    import("/app/src/keys.ts").then((k) => {
      const keys = JSON.parse(fs.readFileSync(file, "utf8"));
      const step = process.argv[1];
      if (step === "publish") keys.keys.push(k.generateSigningKey());
      else if (step === "promote") keys.keys.unshift(keys.keys.pop());
      else if (step === "retire") keys.keys.splice(1);
      else throw new Error("publish, promote or retire");
      fs.writeFileSync(file + ".next", JSON.stringify(keys, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(file + ".next", file);
      console.log("kids=" + keys.keys.map((key) => key.kid).join(","));
    });' "$1" && docker compose --profile "$P" restart "account-$P"
}
```

1. **Publish the next key:** `rotate publish`. The new key is last: published, not signing.
   Wait at least two hours, so every host's cached key set holds it.
2. **Promote it:** `rotate promote`. The new key signs; the old one is still published, so tokens
   it signed keep verifying.
3. **Retire the old key:** after at least one hour (the longest an ID token lives), plus the two
   hours of caching, `rotate retire` keeps only the first key.

Back up the keys volume after each step (section 5). A left-over `keys.json.next` (a step that
failed half-way) makes the next step refuse; remove it with `docker compose --profile "$P" exec
"account-$P" rm /var/lib/account-service/keys/keys.json.next`.

The `hosted-dev` attestation key file (`attestation-keys.json`) rotates the same way, with
`generateAttestationKey()`, except that the publish step is a build: the new key's public half goes
into `publishedAttestationKeys()` and ships in modules before it moves to the front.

## 5. Backup and restore

What to keep: the database (accounts, clients and refresh-token chains, the chains as digests) and
the key files. The database is the routine backup; the keys hold a key that can sign for any
player, so they go to a narrowly scoped secret store, not into the routine sweep, and are taken
again after every key change.

**Back up, while the service runs.** SQLite's `VACUUM INTO` writes a consistent copy of a database
in use; a plain copy of the file can be torn. `umask 077` keeps the copies private on the host.

```sh
P=local-dev   # or hosted-dev
umask 077
docker compose --profile "$P" exec -T "account-$P" node -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1]).prepare("VACUUM INTO ?").run(process.argv[2])' /var/lib/account-service/db/account.sqlite /tmp/account.sqlite
docker compose --profile "$P" exec -T "account-$P" cat /tmp/account.sqlite > account.sqlite
docker compose --profile "$P" exec -T "account-$P" rm /tmp/account.sqlite
docker compose --profile "$P" exec -T "account-$P" tar -C /var/lib/account-service/keys -cf - . > keys.tar
```

Then, for example, `restic backup --tag account-service account.sqlite` hourly, and `keys.tar`
into the secret store. A restored database keeps every player signed in: a refresh token issued
after the backup was taken is lost with it, and its player signs in again.

**Restore into fresh volumes (destructive).** On a new host, or after `docker compose --profile
"$P" down -v` (which deletes the volumes):

```sh
docker compose --profile "$P" build
docker compose --profile "$P" run --rm -T --no-deps --entrypoint tar "account-$P" -C /var/lib/account-service/keys -xpf - < keys.tar
docker compose --profile "$P" run --rm -T --no-deps --entrypoint sh "account-$P" -c 'umask 077 && cat > /var/lib/account-service/db/account.sqlite' < account.sqlite
docker compose --profile "$P" up -d
```

Then check: `/jwks` lists the same `kid`s as before, an account signs in, and a module still
derives the same `Identity` for it (the issuer URL is unchanged).

### Drill record

`account-service/src/deployment.test.ts` ("a backup restored into fresh volumes") runs this drill
on `local-dev` in `just account-test`, on a source stack and a second stack with fresh volumes:

| Date | Run | Result |
|---|---|---|
| 2026-11-21 | `npm --prefix account-service test -- src/deployment.test.ts` (Docker 29.2.1, Compose 5.0.2) | Pass. The restored `/jwks` equals the source's and verifies the source's ID token; an entitled account signs in and a not-entitled one gets the not-owned page; the refresh token newest at the backup refreshes, the spent one is refused and revokes its chain. |

## 6. Moving to another host

The issuer's name moves with the service: a module derives identities from the issuer URL, so
changing it orphans every account.

1. On the old host, stop traffic and take the backup: `docker compose --profile "$P" stop
   "caddy-$P"`, then section 5's backup.
2. **Destructive:** `docker compose --profile "$P" down` on the old host.
3. On the new host, check out the same commit, restore (section 5), and start.
4. Point the issuer's DNS name at the new host. Caddy obtains a new certificate there.
5. Check discovery and `/jwks` at the issuer URL and sign in with a test account.

Keep the old host's volumes until the new host has served sign-ins; then delete them with
`down -v`.
