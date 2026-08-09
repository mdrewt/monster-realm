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
