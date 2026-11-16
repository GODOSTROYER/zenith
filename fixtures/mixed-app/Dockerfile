# Staged context reuses the installed postgres module. No package installation.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY --chown=node:node fixture/ ./
COPY --chown=node:node postgres/ ./node_modules/postgres/
USER node
CMD ["node", "web/server.mjs"]
