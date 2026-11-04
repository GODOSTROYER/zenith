# WS-INTEGRATE-W6 — make the wave-6 staging branch green and close its small seams

Workstream: WS-INTEGRATE-W6 (orchestrator brief) — Branch ws/integrate-w6 — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-integrate-w6
Base: platform/integration @ 579b2d6 + merges of ws/mach-clouds, ws/aws-more, ws/oci-more,
ws/manifest-v2, ws/approval-flow, ws/secret-sync, ws/destroy, ws/build-multi (already merged here by
the orchestrator; read `git log --oneline -20`). Each of those branches passed its own suites; this
branch has never been verified as a whole.

## Goal
This branch passes: `npx tsc --noEmit` (0 errors), eslint on touched paths, the whole vitest suite
(except the 3 known Windows process-termination tests in tests/tofu/process.test.ts, which only fail
because taskkill is denied in the sandbox), `npx tsx scripts/docs/capability-matrix.ts --strict`,
`npm run platform:emit-sql -- --check`, and (in go/) `go vet ./... && go test ./...` with Windows Go.

## Known work (verify each, fix minimally, keep every safety property)
1. Type errors from Manifest V2 widening (14 today):
   src/app/api/environments/[id]/export/route.ts:43, src/app/api/environments/[id]/plan-steps/route.ts:64,
   src/components/deploy/changes-review.tsx:237, src/components/deploy/success-panel.tsx:144,
   src/components/inspector/{add-resource-form.tsx:36,add-service-form.tsx:39,binding-list.tsx:23,resource-editor.tsx:28},
   src/components/shell/project-chrome.tsx:80, src/lib/agent-access/v3/adapters.ts:105,124,
   tests/secrets/namespacing.test.ts:344,416, tests/secrets/store.test.ts:152.
   Readers use `v1View(manifest)`; writers preserve V2 sections via src/lib/actions/defs/_manifest.ts;
   MCP v3 contracts carry `AnyManifest` where they pass manifests through.
2. tests/workflows/sandbox.test.ts (~47): its exact workflow file/export lists must include
   definitions/destroy.ts and `infrastructureDestroyWorkflow`.
3. OCI (WS-OCI-MORE): the Go allowlist golden count assertion fails (go/internal/oci tests) after the
   allowlist grew — regenerate via scripts/generate-oci-allowlist.ts and fix the count; one vitest
   failure in tests/providers/oci|runners/oci|docs/capability-matrix — find and fix.
4. AWS (WS-AWS-MORE, see src/lib/providers/aws/drivers/eks/INTEGRATION.md): update the generic contract
   fixture and observation capability filter in tests/providers/aws/drivers/contract.test.ts for the new
   drivers; add EKS support to shared/security-group.ts (replace the documented adapter if cleaner);
   add read/deploy permissions for SNS, EBS and EKS to src/lib/credentials/aws/session-policy.ts and
   deploy/aws/zenith-connection.cfn.yaml (least privilege, tag/ARN-scoped where AWS allows), then
   `npx tsx deploy/aws/tools/generate-tofu-policies.ts --write`.
5. APPROVAL-FLOW: the legacy product action src/lib/actions/defs/deploy.ts (~354) must forward the
   reviewed plan digest to the approve path, like the platform approve route does.
6. SECRET-SYNC (see src/lib/secrets/DELIVERY.md): the platform broker adapter (src/lib/platform/broker.ts
   `issueGrant`) must authorise `secret.write` grants for the deploy operation, constrained to the exact
   secret resources of that environment (constraints signed into the grant), so the sync step can run;
   tests for allowed / foreign-secret refused / other-environment refused.
7. Run the whole suite once at the end and report exact counts; fix anything the combination broke.

## Out of scope (separate jobs later — list anything you find for them in your report)
Product teardown action + trusted destroy proposal evidence; manifest-removal deletion guards;
teardownZenithTls in destroy; GCP built-image resolution before compile; Azure `:latest` in
providers/azure/drivers/compute/workload.ts (WS-AZURE-MORE is editing src/lib/providers/azure/** now —
do NOT edit it); SourceBundlePort; Neon secret-sink composition; cloud-side workload-identity trust;
non-AWS identity verification; OCI observability reads.

## Owned paths
Anything needed for items 1–7 EXCEPT src/lib/providers/azure/**. Keep changes minimal and local.
