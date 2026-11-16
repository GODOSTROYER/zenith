# WS-BUILD-AZURE continuation

Branch `ws/build-azure`, base `ec3176f`. Working-tree changes only; no Git metadata,
dependencies, fixed contracts, or files outside ownership were changed.

Built Container Apps and jobs now bootstrap with a fixed linux/amd64 HTTP Echo
digest. OpenTofu ignores the container image and bootstrap argv; literal image
artifacts retain declarative ownership. The responder's literal argv matches the
app's port and responds to HTTP probes. Release clears that argv when replacing
bootstrap with the verified ACR digest. Bootstrap is never release evidence.

The release path uploads verified archive bytes using `listBuildSourceUploadUrl`
and the plain SAS transport, schedules only `repository:zn-<operation digest>`,
and persists an identifier-only run receipt before polling. Existing durable,
tenant-scoped permanent claims remain consumed on uncertain launches. A worker
replacement recovers the native ACR digest and returns `registry/repository@sha256`.
Documented UUID run IDs are accepted by handles and SQL receipts. Scheduled-job
replays confirm provisioning success even when the target image already matches.
The existing shared execution release code records the build digest/evidence.

## Files

Changed:
- `src/lib/platform/release-azure.ts`
- `src/lib/providers/azure/drivers/compute/{workload,container-app,container-app-job}.ts`
- `src/lib/providers/azure/release/{build,journal,workloads}.ts`
- `tests/providers/azure/{compile-drivers,release,release-journal,validate}.test.ts`

Added:
- `src/lib/providers/azure/release/{acr-task,source}.ts`
- `tests/providers/azure/build-digest.test.ts`
- This handoff.

## Required integration outside ownership

`src/lib/platform/source-bundle.ts` (C3) is absent at this base. No placeholder
implementation was added. `AzureSourceReader` has exactly C3's structural `read`
contract and accepts the actual `createSourceBundles(deps)` result once integrated.
The old `AzureBuildOptions.readSource` callback remains supported for existing
callers; `sourceBundles` takes precedence when supplied.

At `src/lib/platform/execution.ts:47`, the orchestrator must supply the actual C3
reader to `createReleasePorts({ db: opts.db, azure: { sourceBundles } })` and supply
a provider-dispatching `sourceBundle` port. For Azure, use
`createAzureSourceBundlePort(sourceBundles)`; for AWS/GCP, retain C3's `port`.
The Azure bridge returns content metadata in the historical `s3Key` field without
an S3/GCS upload, since ACR provides its own upload destination. Build rereads the
archive and refuses a changed digest, so moving refs fail closed instead of
deploying different bytes. Explicit `opts.ports` overrides can wire this without
editing the composition root. Until wired, default production builds still refuse
the missing source dependency. No other cross-workstream contract change is needed.

The legacy `src/lib/providers/azure/acr-build.ts` helper remains unchanged outside
ownership. Direct callers still push its historical latest tag; this release path
does not call it and never schedules/deploys latest.

## Verification

- `npx vitest run --maxWorkers=1 tests/providers/azure tests/platform`:
  32 files passed, 662 tests passed, 0 failed, 12 skipped. Vitest's prefix filter
  also selected existing `tests/platform-ui` suites. This preceded the extra SQL
  UUID case, gated built-job case, and final argv preservation cases; final
  affected-suite proof is below.
- `npx vitest run --maxWorkers=1 tests/providers/azure/compile-drivers.test.ts tests/providers/azure/build-digest.test.ts tests/providers/azure/release.test.ts tests/providers/azure/release-journal.test.ts tests/platform/release.test.ts tests/platform/release-multi.test.ts`:
  First: 6 files passed, 106 tests passed, 0 failed, 0 skipped. Final, after the
  two argv preservation cases: 6 files passed, 108 passed, 0 failed, 0 skipped.
- `npx eslint src/lib/providers/azure/drivers/compute src/lib/providers/azure/release src/lib/platform/release-azure.ts tests/providers/azure`:
  three executions, all exit 0, 0 errors, 0 warnings.
- Gated command:
  `$env:ZENITH_TEST_TOFU_NETWORK='1'; $env:ZENITH_TOFU_BIN='C:\Users\user\AppData\Local\Microsoft\WinGet\Packages\OpenTofu.Tofu_Microsoft.Winget.Source_8wekyb3d8bbwe\tofu.exe'; npx vitest run --maxWorkers=1 tests/providers/azure/validate.test.ts tests/providers/azure/deploy.test.ts`:
  2 files failed, 9 tests passed, 6 failed, 0 skipped. Five compiled-workspace
  checks fail at `spawn EPERM`; bootstrap init gets null spawn status. No tofu
  init/validate or provider download succeeded.
- `& 'C:\Users\user\AppData\Local\Microsoft\WinGet\Packages\OpenTofu.Tofu_Microsoft.Winget.Source_8wekyb3d8bbwe\tofu.exe' version -json`:
  exit 1, executable launch denied.

- `npx tsc --noEmit`: one execution, exit 1, one diagnostic in an unowned file:
  `src/lib/platform/credentials.ts(161,54): TS2345`, `CredentialPurpose` includes
  `secret.write`, while `withProviderSession` accepts only `observe | deploy`.
  No diagnostics name owned files. The orchestrator must add an explicit
  supported-purpose guard before the call (around line 150), e.g.
  `if (req.purpose !== "observe" && req.purpose !== "deploy") return deny("purpose_capability_mismatch", "Direct provider sessions do not support this credential purpose.");`
  to narrow the input consistently with the current native-session contract,
  or coordinate actual non-AWS secret-write support. Do not mask it with a cast.
- `git diff --check`: all executions exit 0, no whitespace errors.

## Limits and decisions

Cloud behavior is synthetic ARM/blob/C3 contract evidence. SQL receipt persistence
uses real in-memory PGlite. No live Azure, source-provider network, image pull,
OpenTofu schema proof, Docker, WSL, Go, OPA, or Temporal execution is claimed.
The broad suite skipped six Temporal cases because its CLI was unavailable; other
skips are existing network/provider identity gates. Network access also blocked
a public MCR manifest lookup; the chosen HTTP Echo digest comes from publisher
metadata, not a successful pull.

The handoff's bootstrap/image-ignore approach is retained with one necessary
extension: bootstrap argv is also ignored and removed at release, allowing the
HTTP responder to satisfy custom port/path probes without its arguments reaching
the customer's entrypoint. ACR scheduling moved into owned release code because
the existing helper always adds latest and waits before persisting its receipt.
No mock or unverified cloud behavior was upgraded to real evidence.

References: [HTTP Echo publisher metadata](https://hub.docker.com/layers/hashicorp/http-echo/1.0.0/images/sha256-2c213d6c05a0f68adfe9c7fe1a78a314e5c4fee783e2ee8592d49f10d0c4513f),
[ACR schedule contract](https://learn.microsoft.com/en-us/rest/api/container-registry-tasks/registries/schedule-run?view=rest-container-registry-tasks-2019-04-01),
[ACR source upload contract](https://learn.microsoft.com/en-us/rest/api/container-registry-tasks/registries/get-build-source-upload-url?view=rest-container-registry-tasks-2019-04-01).
