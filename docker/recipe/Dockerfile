# The build image for the `docker` runner: the platform recipe, and nothing else.
#
#   docker build -t zenith-recipe:build -f docker/recipe/Dockerfile .
#   docker image inspect --format '{{.Id}}' zenith-recipe:build
#
# The second command prints the `sha256:<64 hex>` image ID the runner must be
# pointed at: `ZENITH_RECIPE_IMAGE` takes a digest or an image ID, never a tag,
# so a rebuilt `:v1` cannot silently become the build boundary (see
# `src/lib/hosted/build/runner-docker.ts`). The tag above is a scratch label for
# the one `docker image inspect` that follows it.
#
# The pinned toolchain is installed once, here, at image build time, from the
# lockfile committed beside this file — `npm ci` (frozen: the resolved tree is
# exactly what `docker/recipe/package-lock.json` records, transitive packages
# included) with `--ignore-scripts` (no dependency's `preinstall`/`install`/
# `postinstall` runs, so a compromised transitive package cannot execute code
# while the image is being built). A container started from this image never
# installs anything, never reads a submitted `vite.config.*` or `package.json`
# script, and never has a network: the runner starts it with `--network none`,
# `--read-only`, `/src` mounted read-only and `/out` as the only writable mount.
#
# `docker/recipe/package.json` and `RECIPE_V1` in
# `src/lib/hosted/contracts/source-v1.ts` must agree, because the recipe version
# lands in every artifact's provenance. `tests/hosted/build/recipe-image.test.ts`
# fails if they drift, and fails if this file stops installing from the lockfile.
# To change the toolchain: edit `docker/recipe/package.json` and `RECIPE_V1`,
# regenerate the lockfile with `npm install --package-lock-only --ignore-scripts`
# in a scratch copy of `docker/recipe/`, and rebuild the image.
#
# Workstream W2 (hosted R3); frozen and script-free in track D.

FROM node:22-alpine

WORKDIR /opt/zenith

# Frozen (`ci` from the committed lockfile, not `install`) and script-free.
# `--omit=dev` is belt and braces: the toolchain package.json has no
# devDependencies, and this keeps it that way if one is ever added by mistake.
COPY docker/recipe/package.json docker/recipe/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
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
