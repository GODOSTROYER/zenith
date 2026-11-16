# J8 COST-01: catalog refresh

Base: `3a9de905`. Status: `implementation_complete_verification_pending`; acceptance is not promoted. See `J8-COST-REPORT.md` for executed checks and exact counts.

Acceptance: "Refreshable official-source-backed catalogs replace weak values and distinguish estimates/forecasts/actual spend."

| Clause | Implementation and checks |
|---|---|
| Source-backed refresh | GCP E2 CPU/RAM and zonal Enterprise PostgreSQL CPU/RAM profiles; Azure exact Linux VM and Flexible Server shapes; OCI E4 OCPU/RAM and PostgreSQL OCPU profiles. `catalog-refresh/derived.ts`, provider normalizers and `tests/cost/compute-refresh.test.ts`. Missing components, units, currency, wrong region, reservations, HA variants and ambiguity are refused. |
| Dated provenance | Existing checked manifests and merge pipeline retained. `refresh.ts` assembles checked GCP/Azure pages before matching, keeps original file checksums and names every constituent checksum in observations. Split-page and tamper controls added. No synthetic price fixture is presented as a downloaded provider file. |
| Review before adoption | `src/lib/cost/catalog-dry-run{,-cli}.ts` never downloads or writes. Large changes stay flagged. The bundled catalog is unchanged. |
| Distinct money kinds | Existing `kinds.ts`, spend service and actual-spend store preserved; `tests/cost/kinds.test.ts`, `spend-service.test.ts`, `actual-spend-store.test.ts`. |

Public specifications consulted: [GCP Cloud SQL pricing](https://cloud.google.com/sql/pricing), [Azure Retail Prices contract](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices), [OCI price list](https://www.oracle.com/cloud/price-list/?product=service). These informed matching and units, not adopted current prices. API naming variants that fail the exact profile rules remain skipped. OCI PostgreSQL OCPU rules do not refresh additional user-selected memory or VPU fees. MySQL continues to be an explicitly disclosed PostgreSQL price approximation; this job does not claim engine-specific MySQL catalog coverage.

## Mac commands

Use installed Node 22; do not reinstall dependencies. From this worktree:

```sh
export PATH="$HOME/.local/sdk/node22:$PATH"
npx vitest run tests/cost/catalog-refresh.test.ts tests/cost/compute-refresh.test.ts tests/cost/kinds.test.ts tests/cost/spend-service.test.ts --no-file-parallelism --maxWorkers=2
npx tsx src/lib/cost/catalog-dry-run-cli.ts tests/cost/fixtures/price-snapshots 2026-10-08.1
```

Expected tests: zero failures. Dry run with the existing hand-built fixtures returns exit 2 because deliberately large price changes remain flagged; it writes no file. This is a contract dry run, not adoption or current pricing verification.

The existing real downloader and billing harness stay gated. **Do not run these until the owner authorizes live reads and supplies keys/account configuration**:

```sh
export ZENITH_LIVE_CATALOG_REFRESH=1
export ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE=/absolute/owner-provided/key-file
npx tsx scripts/cost/refresh-catalog.ts fetch --providers gcp,azure,oci --out /absolute/owned-j8-snapshots
npx tsx src/lib/cost/catalog-dry-run-cli.ts /absolute/owned-j8-snapshots 2026-10-09.1
```

Omit GCP from the provider list if no owner key is available and record that provider as unrefreshed. Review every skipped, flagged and weak entry before explicitly adopting a candidate using the existing `apply` command. Dates/versions must be newer than the bundled catalog and at least the retrieval date. AWS regional offer files can exceed 450 MiB: on the 8 GiB Mac use a saved official region/service subset plus its truthful manifest instead of loading the full EC2 offer. One provider/region job at a time, no Docker required for catalog normalization.

Actual provider billing remains **not run (needs authorized live provider accounts and credential files)**. The exact gated command is `npx vitest run tests/cost/live-billing.live.test.ts --no-file-parallelism --maxWorkers=2`; provider-specific `ZENITH_LIVE_<PROVIDER>=1` and `ZENITH_LIVE_<PROVIDER>_BILLING_CREDENTIALS_FILE` settings are documented in `PROD-COST-01-02.md`.

No migration or published aggregate changed. No dependency changes. No new table or sensitive-data inventory entry.
