# Minimal app (supported source contract v1)

The smallest source tree the Zenith hosted recipe accepts: a React + Vite
frontend with no build configuration of its own. The platform compiles it with
its own pinned toolchain (`RECIPE_V1`); nothing in this directory is executed at
build time.

Used by `tests/hosted/source` (validation, digest) and `tests/hosted/build`
(a real `recipe-local` build). Keep it valid — a change here changes the
recorded source digest.
