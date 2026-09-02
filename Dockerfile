# Orrery — production image, built on Next's `output: "standalone"` tracing.
#
# THE BUILD NEEDS NETWORK ACCESS. `src/app/layout.tsx` uses `next/font/google`
# (Space Grotesk, JetBrains Mono), and Next fetches those files from
# fonts.googleapis.com at build time. On an air-gapped or proxy-blocked builder
# `npm run build` fails with a font fetch error rather than a code error. The
# fonts are deliberately kept as-is; vendor them with `next/font/local` if you
# need an offline build. Same reason the CI `build` and `docker` jobs are
# `continue-on-error`.
#
# Layout follows the official Next standalone example:
# https://github.com/vercel/next.js/tree/canary/examples/with-docker

# ---------------------------------- deps ------------------------------------
FROM node:22-alpine AS deps
# Next's SWC binaries want glibc symbols that musl does not provide alone.
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------- builder ----------------------------------
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* are inlined into the client bundle at BUILD time, not read at
# run time — passing them only via env_file leaves the browser with an
# unconfigured Supabase client and the app silently in local demo mode. So they
# are build args. Empty is a valid choice: it builds demo mode on purpose.
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=""
ARG NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=""
ARG NEXT_PUBLIC_SITE_URL=""
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=$NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1

# The repo has no public/ directory today. The runner stage still copies one,
# per Next's standalone docs, so creating it here keeps that COPY valid whether
# or not the repo grows real static assets later.
RUN mkdir -p public && npm run build

# ---------------------------------- runner ----------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3400 \
    HOSTNAME=0.0.0.0 \
    ORRERY_DATA=/data

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs orrery

# standalone/ carries server.js and the traced node_modules; static/ and
# public/ are NOT traced into it and must be copied alongside by hand.
COPY --from=builder --chown=orrery:nodejs /app/public ./public

# .next is created and chowned before anything lands in it, per the official
# example: the standalone server writes .next/cache at run time, and a
# root-owned .next makes that fail under USER orrery.
RUN mkdir .next && chown orrery:nodejs .next

COPY --from=builder --chown=orrery:nodejs /app/.next/standalone ./
COPY --from=builder --chown=orrery:nodejs /app/.next/static ./.next/static

# Docker seeds a fresh named volume from the image directory at the mount
# point, ownership included. Creating /data as orrery here is what makes the
# volume writable by a non-root process; without it the first save fails EACCES.
RUN mkdir -p /data && chown orrery:nodejs /data
VOLUME /data

USER orrery
EXPOSE 3400

# node is guaranteed present; curl and wget are not worth an apk layer.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3400/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
