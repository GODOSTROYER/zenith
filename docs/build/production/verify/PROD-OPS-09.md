# PROD-OPS-09 Verified release supply chain: verify handoff

Branch `prod/ops-09-w5`, base c02c097e. BUILD ONLY: nothing below was executed except typecheck (`tsc --noEmit`, clean), eslint
on the changed files (clean) and `node --check` on the new `.mjs` files. No vitest, go, docker or workflow run was performed.
Operator guide: `docs/platform/operations/SUPPLY-CHAIN.md`.

## 1. What was built

| Area | Files |
| --- | --- |
| SBOM (CycloneDX 1.5) | `scripts/supply-chain/sbom.mjs` (+ `sbom.d.mts`) |
| Provenance, verification manifest, signing, OCI archive digests, offline release verification | `scripts/supply-chain/release.mjs` (+ `.d.mts`), `scripts/supply-chain/zenith-verify-release.mjs` (+ `.d.mts`) |
| Release workflow (tags only) | `.github/workflows/release.yml` (new file; no existing workflow edited) |
| Vulnerability triage | `scripts/ci/vulnerability-triage.mjs` (+ `.d.mts`), `scripts/ci/vulnerability-triage.json` (empty registry) |
| Audit export (chain, signing, ledger, offline verifier) | `src/lib/audit-export/{chain,service,store}.ts`, `src/lib/platform/audit-export.ts`, `src/app/api/platform/v1/audit/exports/route.ts`, `src/lib/controlplane/db/migrations/0047_audit_exports.ts` (registered in `index.ts`), `scripts/supply-chain/zenith-verify-audit-export.mjs` (+ `.d.mts`) |
| npm scripts | `package.json`: `sbom`, `verify:release`, `verify:audit-export`, `triage:check` |
| Docs | `docs/platform/operations/SUPPLY-CHAIN.md`, this file |
| Tests | `tests/supply-chain/sbom.test.ts`, `tests/supply-chain/release.test.ts`, `tests/ci/vulnerability-triage.test.ts`, `tests/ci/release-workflow.test.ts`, `tests/audit-export/audit-export.test.ts` |

Reused unchanged: `lockfile-integrity.mjs`, `security-audit.mjs`, `security-exceptions.mjs` and its gate rules (the triage module reads the
exception registry and never imports or alters the exception evaluation), MACH-04 `go/cmd/zenith-release` and `go/internal/release`
(signing key format and scheme; the workflow calls `zenith-release sign` for the updater manifests), OPS-05 purposes (`signing:release` stays
verify-only on the control plane; audit exports sign with `signing:jobs` through `getControlSigner`), LIFE-09 constants (in-toto Statement v1 and
`https://slsa.dev/provenance/v1`, same predicate family; the release provenance has its own `buildType`).

## 2. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Pinned verified dependencies | existing lockfile and audit gates, run by `release.yml` before any build; SBOM records each npm sha512; `verifyRelease --lock` requires the SBOM's npm set to equal the lockfile | `release.test.ts` ("not exactly those of the supplied package-lock.json"), `sbom.test.ts` (real `package-lock.json` inventory, link refusal), `release-workflow.test.ts` (gate steps and order) |
| SBOM for npm app, Go binaries, container images | `sbom.mjs`: lockfile parse, `go version -m` parse (binary or captured text), Dockerfile FROM/ARG parse, named built images | `sbom.test.ts` (synthetic and real lock, real Dockerfiles, go text; real binary test gated by `ZENITH_TEST_GO`) |
| Provenance | `release.mjs provenance` (SLSA v1 in-toto) bound by the signed manifest; verifier checks subjects, commit, repository | `release.test.ts` (commit mismatch, subject digest mismatch) |
| Signed releases | `release.mjs manifest`/`sign`; workflow signs only when `ZENITH_RELEASE_SIGNING_SEED` exists, in the protected `release` environment | `release.test.ts` (wrong key, unpinned kid, forged manifest, expiry), `release-workflow.test.ts` (secret only in the 3 signing steps, removed after) |
| Updater verification | updater manifests signed by the existing MACH-04 signer with the same key; agents verify as before; release bundle verifier verifies the bundle | covered by existing `go/internal/release` tests (not rerun); bundle verification in `release.test.ts` |
| Vulnerability triage with expiry linked to SBOM | `vulnerability-triage.mjs` | `vulnerability-triage.test.ts` (purl link, expiry, 14/90 day caps, exception mirror both directions, VEX, untriaged findings, `gateEffect: "none"`, committed registry empty) |
| Tamper-evident audit export | `audit-export/*`, route, migration 47, offline verifier | `audit-export.test.ts` (edit/remove/insert/reorder/truncate/forge, foreign key, previous-head and ledger linkage, no signer refusal, range and size, tenant leakage, ledger append-only and fork refusal) |
| Tags-only workflow | `on.push.tags` only | `release-workflow.test.ts` |
| No unperformed claims | docs state: provenance workflow-asserted, no SLSA level, images not pushed, tag-only bases flagged, OS packages not inventoried, no key and no run yet | `sbom.test.ts` (tag-only flagged), `vulnerability-triage.test.ts` (empty registry) |

## 3. Verification commands (other machine)

```
npx vitest run tests/supply-chain tests/ci/vulnerability-triage.test.ts tests/ci/release-workflow.test.ts tests/audit-export
```
Expected: all pass, 0 skipped except `sbom.test.ts` "reads the build info of a real binary" (skipped unless `ZENITH_TEST_GO` is a go
executable path; with `ZENITH_TEST_GO=C:/Users/user/.local/sdk/go/bin/go.exe` it builds `go/cmd/zenith-release` with `GOTOOLCHAIN=local` and parses real build info).
`audit-export.test.ts` uses PGlite (needs migration 47 registered, done in `index.ts`); no env needed.

Also rerun after the shared-file edits below: `npx vitest run tests/ci tests/controlplane/migrations.test.ts tests/controlplane tests/security/sensitive-inventory.test.ts`.

Manual checks worth doing once on a machine with docker and go (not performed here):
1. `cd go && ./build.sh 0.0.0-dev` then `node scripts/supply-chain/sbom.mjs --lock package-lock.json --package package.json --go-binary go/dist/linux-amd64/zenithd --dockerfile Dockerfile --dockerfile docker/runner.Dockerfile --version 0.0.0-dev --commit $(git rev-parse HEAD) --out /tmp/sbom.json`
   and `node scripts/ci/vulnerability-triage.mjs --sbom /tmp/sbom.json` (expects `ok`, registry empty).
2. A throwaway tag run of `release.yml` on a fork with a freshly generated key: confirm buildx OCI export works with the docker-container driver and that the self-verify step passes.

## 4. Known gaps and risks, and shared-file updates for the assembler

Workflow never executed: `release.yml` is unrun. Likely first failures: buildx `docker-container` driver availability, build args of the root `Dockerfile`
(it declares `NEXT_PUBLIC_*` defaults), the `zenith-worker` `production` target, and the 45 minute timeout for four image builds.

Honest limits (all also in the operator doc): provenance is workflow-asserted (no Sigstore/GitHub attestation, no SLSA level); images ship as OCI
archives and are not pushed; `docker/runner.Dockerfile` and `docker/zenithd.Dockerfile` base images are tag-only (flagged, not fixed: digests cannot be
resolved offline); OS packages in base images not inventoried; no release key exists and no signed release has been produced; the audit chain
starts at export time and does not prove the live log was complete; the export reads through the product audit store reader (`readAuditPageAsync`),
which is scoped by the request snapshot, so a workspace outside the caller's snapshot yields an empty export rather than leaking.

Required shared-file edits (I did not make them):

1. `tests/ci/release-gates.test.ts` "validates every workflow file in the repository" requires the `verify` job's actionlint step to name every file in
   `.github/workflows/`. Add ` .github/workflows/release.yml` to the actionlint command in `ci.yml` (line ~76) and the same string in
   `tests/ci/release-gates.test.ts` (line ~114) and `scripts/ci/gate-manifest.mjs`, otherwise that test fails on the new file.
2. Optional new CI job (separate, existing lanes untouched), to run the new checks on every push:
   ```yaml
     release-supply-chain:
       runs-on: ubuntu-latest
       timeout-minutes: 15
       steps:
         - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
           with:
             persist-credentials: false
         - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
           with:
             node-version: '22.23.3'
         - name: SBOM from the lockfile and Dockerfiles
           run: node scripts/supply-chain/sbom.mjs --lock package-lock.json --package package.json --dockerfile Dockerfile --dockerfile docker/worker.Dockerfile --dockerfile docker/runner.Dockerfile --dockerfile docker/zenithd.Dockerfile --version 0.0.0-ci --commit "$GITHUB_SHA" --out "$RUNNER_TEMP/sbom.cdx.json"
         - name: Triage records match the SBOM and none has expired
           run: node scripts/ci/vulnerability-triage.mjs --sbom "$RUNNER_TEMP/sbom.cdx.json"
   ```
   It passes the existing pin tests (node pinned before first use, checkout without credentials, timeout under 45). If it is added to the gate manifest,
   register its two commands there.
3. `scripts/ci/security-exceptions.mjs` binds each exception to a digest of `scripts/` and `.github/`; the new files change that digest. The registry is empty, so
   nothing is affected today; any exception approved later must be signed against the final tree.
4. Migration inventory: version 47 `audit_exports` (versions 42-46 are other waves; the migrator does not need contiguity, `tests/controlplane/migrations.test.ts` does:
   the assembler fills the gap and adds `audit_exports` to its table list). `emit.ts`: add `audit_exports` to the service_role grant block (select, insert only) mirroring the
   SQL in the migration; `supabase/migrations` regeneration and `apply-supabase-migrations.sh` are the assembler's.
5. `src/lib/sensitivedata/inventory.ts`: add `platform.audit_exports`: owner `audit-export (OPS-09)`, classification `operational`, retention `immutable("append-only by trigger; " + OPS07)`,
   purpose "ledger of signed audit exports: chain facts only", columns `{}` (no event content, no secret; `created_by` is a principal id).
6. Store functions and tenancy classification (`tenancy.test.ts` / controlplane SQL scoping), all in `src/lib/audit-export/store.ts`:
   `latestExport(db, workspaceId)`, `listExports(db, workspaceId, limit)`, `recordExport(db, input)`: all workspace-owned, every statement filters or inserts on `workspace_id`;
   `recordExport` also takes a per-workspace advisory lock. No system-level or cross-workspace function.
7. Route inventory/count: new route `GET`/`POST /api/platform/v1/audit/exports` (admin; POST browser-only via `assertBrowserSession`; no bearer path added to
   `_lib/bearer-paths.ts`, so agent credentials cannot call it).
8. LIMITATIONS.md: add the honest limits above. `docs/platform/operations/README.md` index: link `SUPPLY-CHAIN.md`.
9. Operator action: create the `release` environment, key and variables (section "Releasing" of the operator doc). Nothing in the repo can do this.

## 5. Suggested ledger implementationStatus

`implementation_complete_verification_pending`: SBOM generator, signed release manifest, SLSA-format provenance, offline release verifier, tag-only release workflow, triage records
and signed hash-chained audit export are built with contract tests; the release workflow is unrun, no release key exists, no signed release has been produced, provenance is
workflow-asserted (no SLSA level), images are not registry-pushed, two Dockerfiles use tag-only bases, and the audit chain proves post-export integrity only.
