# Caddy + caddy-ratelimit, built with xcaddy.
#
# This is the one image in the stack that is BUILT rather than pulled, because stock Caddy has no
# rate limiting and OBS-21 needs it. ADR-0180 D3 flags this as Caddy's differentiated maintenance
# line: unlike the other six stock, `docker pull`-able images, this service carries its own
# build pipeline and upstream-CVE-tracking obligation. Both stages are digest-pinned, and the
# plugin is version-pinned — an unpinned `--with` reference would silently float.

FROM caddy:2.11.4-builder-alpine@sha256:a7963edd45496bb8962e91e75891937081113f08f34d148f04684c4e83243aca AS builder

RUN xcaddy build v2.11.4 \
    --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2.11.4-alpine@sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# ADR-0190 D3. The stock caddy binary carries the net-bind file capability, and buildkit
# preserves file capabilities across `COPY --from=`, so the line above inherits it. A binary
# whose EFFECTIVE capability set is not a subset of the process bounding set cannot be exec'd
# at all: with `USER 10001` below plus the compose service's `cap_drop: [ALL]` and
# `no-new-privileges:true`, `docker run … caddy version` died with
# `exec /usr/bin/caddy: operation not permitted` (exit 255) — it failed without
# `no-new-privileges` too, so that toggle was never the cause. Stripping it costs nothing here:
# every listener in this stack is a high port on loopback (see Caddyfile / MR_CADDY_BIND_ADDR).
# `setcap` already ships in caddy:2.11.4-alpine (/usr/sbin/setcap, libcap-setcap), so no
# package install is added.
#
# The `&& ! getcap …` half is not decoration. Static text cannot prove this: a `setcap` placed
# in an earlier build stage, or any `COPY --from=` that re-installs the binary AFTER this line,
# would leave the capability on the shipped image while a source scan still saw the word
# `setcap` before `USER`. Asserting the outcome inside the build makes that ordering mistake a
# build failure. Keep this instruction the LAST one that writes /usr/bin/caddy.
RUN setcap -r /usr/bin/caddy && ! getcap /usr/bin/caddy | grep -q cap_

# Run as a non-root, numeric UID. The data/config dirs are chowned in the image so the named
# volumes docker creates from them inherit that ownership on first use — otherwise a non-root
# Caddy cannot persist its internal TLS CA and would regenerate certs on every restart.
RUN mkdir -p /data /config && chown -R 10001:10001 /data /config

USER 10001:10001

# Caddy's admin API defaults to loopback-only, which is exactly what this stack wants under
# `network_mode: host`; it doubles as a dependency-free liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --spider -q http://127.0.0.1:2019/config/ || exit 1

ENTRYPOINT ["caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
