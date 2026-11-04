# Zenith live-acceptance sample app. Build context: this directory.
#
# Base image pinned by digest (the multi-arch index of node:22-alpine, node
# v22.23.3 when this digest was read on 2026-09-30). A tag can move; a digest
# cannot. Refresh deliberately: `docker pull node:22-alpine` and copy the new
# "Digest:" line, then rebuild and re-run tests/acceptance.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# No dependencies to install: the app uses only the Node standard library.
COPY --chown=node:node package.json server.mjs ./

# The node image ships an unprivileged `node` user (uid 1000); never run as root.
USER node

EXPOSE 8080

# /health never looks at the database (see server.mjs), so a broken dependency
# does not get the task killed; it has to be diagnosed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

CMD ["node", "server.mjs"]
