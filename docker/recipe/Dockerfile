# The build image for the `docker` runner: the platform recipe, and nothing else.
#
#   docker build -t zenith-recipe:v1 -f docker/recipe/Dockerfile .
#
# The pinned toolchain is installed once, here, at image build time. A container
# started from this image never installs anything, never reads a submitted
# `vite.config.*` or `package.json` script, and never has a network: the runner
# starts it with `--network none`, `--read-only`, `/src` mounted read-only and
# `/out` as the only writable mount.
#
# Rebuild this image whenever `RECIPE_V1` in `src/lib/hosted/contracts/source-v1.ts`
# changes; the versions below and that constant must agree, because the recipe
# version lands in every artifact's provenance.
#
# Workstream W2 (hosted R3).

FROM node:22-alpine

# `RECIPE_V1`, duplicated here because an image cannot import TypeScript.
ARG VITE_VERSION=7.3.6
ARG PLUGIN_REACT_VERSION=5.1.4
ARG REACT_VERSION=19.1.0

WORKDIR /opt/zenith

# One layer, one install, no lockfile from anyone outside this repository.
RUN npm install --no-audit --no-fund --omit=dev \
      "vite@${VITE_VERSION}" \
      "@vitejs/plugin-react@${PLUGIN_REACT_VERSION}" \
      "react@${REACT_VERSION}" \
      "react-dom@${REACT_VERSION}" \
 && npm cache clean --force

# The recipe itself. `recipe-worker.mjs` imports `recipe-config.mjs` from beside
# it, so both files must land in the same directory.
COPY src/lib/hosted/build/recipe-worker.mjs /opt/zenith/recipe-worker.mjs
COPY src/lib/hosted/build/recipe-config.mjs /opt/zenith/recipe-config.mjs

# The mounts the runner supplies. `/src` is read-only at run time.
RUN mkdir -p /src /out && chown -R node:node /out /opt/zenith

# Unprivileged by default. NOTE for whoever first runs this for real: a bind
# mount keeps the host directory's ownership, so on a Linux host whose user is
# not uid 1000 the container cannot write /out and the build fails with EACCES
# rather than silently. Add `--user "$(id -u):$(id -g)"` to the run arguments in
# `dockerRunArgs` (and to its test) when that host exists; it has not been run
# from this repository, so the flag is not guessed at here.
USER node
ENV NODE_ENV=production
ENV NODE_OPTIONS=""

# Fixed paths: the runner writes the job onto the writable mount, because /src
# is read-only and the container has nowhere else to be handed instructions.
ENTRYPOINT ["node", "/opt/zenith/recipe-worker.mjs", "/out/job.json", "/out/result.json"]
