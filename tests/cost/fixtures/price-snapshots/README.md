# Price snapshot fixtures

Contract-level fixtures: hand-built to match the documented shape of each provider's official price file, saved with SHA-256 checksums in `manifest.json`. They are NOT downloads from the providers and their values are illustrative. They exercise the offline refresh pipeline (`tests/cost/catalog-refresh.test.ts`). Do not regenerate them to change a test; the tests pin their checksums.
