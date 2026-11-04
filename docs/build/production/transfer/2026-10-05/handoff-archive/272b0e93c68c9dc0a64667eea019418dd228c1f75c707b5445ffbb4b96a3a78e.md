# WS-TOFU-2 — remaining OpenTofu-side security findings + state backends for GCP, Azure and OCI

Workstream: WS-TOFU-2 (new; orchestrator brief) — Branch ws/tofu-2 — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-tofu-2
Base: platform/integration @ c915fe4 (tsc clean; SEC-F5/F4 fixed: src/lib/tofu/hcl-template.ts +
expression-policy.ts scanner/allowlist, re-run in assertWorkspaceIntact; native .tf refused)

Read docs/platform/THREAT-MODEL.md (findings) and each pinned test first.

## Part A — security findings (each pinned as `it.fails`; flip ONLY these pins to `it` once fixed)
- SEC-F2 (LOW): a resource/output/local named `__proto__` is accepted by the label rule and then
  silently dropped from main.tf.json while `addressMap` still claims it. Fix: refuse (or build with
  null-prototype objects AND keep it) — never silently drop. Pin: tests/security/tofu-workspace-injection.test.ts.
- SEC-F3 (MEDIUM, latent): `providerConfig` accepts `endpoints`, `http_proxy`, `custom_ca_bundle`,
  `insecure`, `assume_role`, … — provider settings that can redirect, proxy, weaken or re-identify
  the API traffic carrying brokered credentials. Fix: an explicit per-provider ALLOWLIST of
  non-secret, non-routing keys (e.g. google `project`, azurerm `subscription_id`/`features`/
  `storage_use_azuread`/`resource_provider_registrations`, oci `auth`/`region` — derive the list
  from what drivers/providers actually pass today; grep for providerConfig), refuse everything
  else. Pin: same file.
- SEC-F6 (LOW): the child-process environment validator is a denylist; a session may carry
  `LD_PRELOAD`, `NODE_OPTIONS`, `AWS_ENDPOINT_URL*` … Fix: allowlist per session contract (the
  variables each provider session legitimately sets). Pin: tests/security/tofu-runner-env.test.ts.
- SEC-F7 (LOW-MEDIUM): `planView` (model-facing projection, src/lib/tofu/plan.ts ~566) strips C0
  controls only; bidi overrides, zero-width and Unicode TAG characters pass. Fix: neutralize them
  (escape visibly, do not silently delete meaning). Pin: tests/security/tofu-secrets.test.ts.

## Part B — state backends (today `BackendConfig` in src/lib/tofu/workspace.ts has local | s3 | http)
- `gcs`: bucket, prefix (state key), optional KMS (`kms_encryption_key` or OpenTofu client-side
  encryption with gcp_kms), auth from the session env only (no credentials in files).
- `azurerm`: storage_account_name, container_name, key, `use_azuread_auth = true`, `use_oidc` per
  the Azure session env (ARM_* vars), no access keys / SAS ever.
- OCI: S3-compatible backend options on the s3 kind (custom endpoint
  `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`, `use_path_style`,
  `skip_region_validation`, `skip_credentials_validation`, `skip_requesting_account_id`,
  `skip_s3_checksum`, as needed by OpenTofu 1.12's s3 backend) — note deploy/oci/README.md says a
  static customer secret key is needed; keep credentials OUT of files (env only) and document the
  limitation honestly. These endpoint options are BACKEND config, distinct from the F3 provider
  allowlist above.
- Validate every new field strictly (same style as BUCKET/STATE_KEY/REGION regexes); never allow
  credential-shaped keys.
- Add the additive connection fields the providers need in src/lib/credentials/types.ts:
  `GcpConnectionConfig.stateBucket?` (+ optional `stateKmsKey?`), `AzureConnectionConfig`
  `stateStorageAccount?`, `stateContainer?` (and optional `deployClientId?` if you can keep it
  additive), `OciConnectionConfig` `stateBucket?`, `stateNamespace?`. ADDITIVE ONLY — another job
  (WS-SEC-POLICY) edits other files under src/lib/credentials.
- NEW `src/lib/tofu/backends.ts`: `backendForConnection(connection, { workspaceId, environmentId })`
  → `{ backend, stateKey }` for aws/gcp/azure/oci, refusing clearly when a connection lacks its
  state settings. Do NOT edit src/lib/execution/compile.ts (WS-REF owns it): its `backendFor`
  (line ~135) is AWS-only; the orchestrator will make it delegate to your function — write the
  exact replacement in your report.
- Tests: assembled backend blocks for each kind (and refusals), and gated real `tofu init
  -backend=false` / `tofu validate` of a workspace with each backend block where possible
  (ZENITH_TEST_TOFU_NETWORK=1; say clearly if tofu cannot run in your sandbox).

## Owned paths
src/lib/tofu/** ; tests/tofu/** ; src/lib/credentials/types.ts (additive fields only) ;
tests/security/{tofu-workspace-injection,tofu-runner-env,tofu-secrets}.test.ts (flip F2/F3/F6/F7 pins only) ;
deploy/{gcp,azure,oci}/README.md (state-backend sections only, if they describe the gap).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/tofu tests/tofu src/lib/credentials/types.ts tests/security
- npx vitest run --maxWorkers=2 tests/tofu tests/security tests/providers/gcp tests/providers/azure tests/providers/oci tests/execution
- ZENITH_TEST_TOFU_NETWORK=1 npx vitest run --maxWorkers=2 tests/tofu
