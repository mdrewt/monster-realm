# The account service's image (docs/account-service.md; deployed by ops/auth/docker-compose.yml).
#
# Node runs the TypeScript sources directly, so the image holds the sources, the runtime
# dependencies from the lock file and nothing else. It runs as the base image's unprivileged
# `node` user. The image takes no profile and no secret: a container started without
# MR_ACCOUNT_PROFILE, or without its profile's keys, refuses to start and exits 1. The compose
# recipe runs it with a read-only root file system; the database and the keys live on the two
# volumes mounted at the directories made below.

FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies only, exactly as locked, running no install script.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN find src -name '*.test.ts' -delete

FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
# Owned by `node` with no access for others, so a volume docker creates over either directory
# starts with that owner and mode.
RUN install -d -o node -g node -m 0700 /var/lib/account-service/db /var/lib/account-service/keys
# Inside the container the service listens on every interface: the published port and the proxy
# in front decide who reaches it.
ENV MR_ACCOUNT_HOST=0.0.0.0 \
    MR_ACCOUNT_DATA_DIR=/var/lib/account-service/db
USER node
EXPOSE 4455
ENTRYPOINT ["node", "src/server.ts"]
