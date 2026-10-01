# WS-INTEGRATE-W6 verification report

2026-10-01; branch `ws/integrate-w6`; starting HEAD `9b77406`.

Implementation is complete in the working tree. No commits or other Git mutations,
dependency changes, WSL/Docker use, or changes under `src/lib/providers/azure/**`.
The branch has not been committed or integrated by this worker.

## Result and remaining verification

- The affected workstream run passed **2,555 tests**, failed **0**, skipped **25**;
  **103 files passed**.
- The one authorized whole-suite run passed **13,693 tests**, failed **10**, skipped
  **382**; **695 files passed**, **5 failed**, **17 skipped**. Seven unexpected
  failures were corrected afterward. The final targeted rerun passed **419 tests**,
  failed **0**, skipped **15**; **15 files passed**, **1 skipped**. No second
  whole-suite run was made, so this report does not claim an observed whole-suite
  pass on the final tree.
- The remaining three observed full-run failures are the known sandbox process
  termination timeouts in `tests/tofu/process.test.ts`: timeout cancellation
  (line 98), killing grandchildren holding pipes (line 106), and AbortSignal
  cancellation (line 118). Tests and production process handling were not weakened.
- Whole-repo TypeScript passed with **0 errors** on invocations 2 and 3. The limit
  of three invocations was respected. The final documentation/assertion corrections
  and extraction of a constant SQL column list occurred after invocation 3; the
  orchestrator should run TypeScript once on the final tree before integration.
- ESLint passed on all changed TypeScript/TSX/MJS paths, including the two new
  source/test files: **0 errors, 0 warnings**. The last subsequently edited MJS
  file was separately linted clean.
- Strict capability matrix and the actual SQL `--check` invocation passed.
- `go vet ./...` and `go test ./...` could not start: Windows Go is absent from
  PATH and the standard Windows installation locations. The brief's installed
  Go is WSL-only, which this job forbids. **0 Go packages/tests ran**. The
  orchestrator must run both checks with Windows Go.
- Gated network/provider-schema, Temporal-download, real Postgres and kind checks
  were not enabled. No cloud acceptance evidence is claimed; EKS remains
  compile-only with contract evidence. Cloud bootstrap policies were validated
  through the local policy/size/security tests, not deployed to an AWS account.

## Changes and decisions

Manifest readers use `v1View` from `resources/upgrade`; MCP v3 pass-through paths
carry `AnyManifest`. Existing V2 writer preservation remains intact. Workflow
sandbox expectations include the destroy definition and export. OCI fixtures were
regenerated; the golden count is 7 capabilities, 16 services, 50 observation rules.
The regenerated matrix includes SNS, EBS and EKS with truthful capability evidence.

AWS generic contract fixtures include the three new drivers and only call observe
where advertised. EKS uses the shared security group implementation, with both
abstract and native EKS owners supported by firewall compilation. Existing self and
HTTPS standalone EKS rules remain. SNS/EBS/EKS bootstrap permissions use managed
and environment tags and account/name-scoped ARNs where supported; EBS creation
requires encryption, and EKS creation requires API authentication without creator
admin permissions. IAM attachment and service-principal lists stay explicit.

The EKS node boundary permits CNI ENI actions on this account's ENI ARNs and
separately requires Zenith managed/environment tags on node instance ARNs. CNI
tagging is limited to its four native tag keys and cannot write Zenith ownership
tags. This follows the CNI's actual native tag behavior; Zenith tags are not
automatically applied to its ENIs. Account scope is used for these native ENIs,
not a claim of per-environment ENI isolation. References: [AWS CNI tag implementation](https://github.com/aws/amazon-vpc-cni-k8s/blob/master/pkg/awsutils/awsutils.go),
[AWS CNI IAM requirements](https://github.com/aws/amazon-vpc-cni-k8s/blob/master/docs/iam-policy.md),
[EKS IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelastickubernetesservice.html).

Legacy `deploy.approve` accepts and forwards the caller's reviewed plan digest.
The secret sync broker authorizes only deploy/apply/rollback secondary
`secret.write` grants, reevaluates both capabilities with reviewed plan facts,
checks current human approvals/roles/expiry and the live environment fence, and
signs exact target identities derived independently from the immutable revision,
original graph evidence, verified tenant connection and real observations. It
honors parent/secret policy target constraints and the shorter grant lifetime.
Foreign secret, environment, account, revision, stale graph and simulated/missing
observations are refused. Kubernetes generated DB Secrets use the same value-free
renderer as sync. Secret values never enter the grant derivation or observations.

Full-run drift fixes add messaging and destroy network suites to the mandatory CI
report requirements, document internal Azure guest parameters, assert current
approval-round/core-card safeguards, retain the reviewed plan digest in the UI
expectation, and extract a constant column expression before SQL interpolation.
The SQL scan itself is unchanged; tenant inputs remain bound parameters.

No handoff design decisions were reversed. Changes beyond the named initial seams
are the minimal full-suite integration drift fixes just described. The shared EKS
SG description now follows the shared implementation; an existing deployed SG
could require replacement if its provider treats description changes as immutable.
No live EKS deployment was available to verify that transition.

The handoff's deferred work remains deferred: product teardown/trusted destroy
proposal evidence, manifest-removal deletion guards, TLS teardown, GCP built-image
resolution, Azure `:latest`, SourceBundlePort, Neon sink composition, cloud-side
identity trust, non-AWS identity verification and OCI observability reads.

## Every verification command run

Counts below are per invocation, not summed across overlapping runs. `P/F/S`
means passed/failed/skipped tests. Logs are under `%TEMP%/zenith-w6-*.log`.

| Command | Result |
|---|---|
| `npx vitest run --maxWorkers=2 tests/providers/aws/drivers/contract.test.ts tests/providers/oci tests/docs/capability-matrix.test.ts tests/workflows/sandbox.test.ts` | Baseline **624/10/5**; files **11 passed, 3 failed**; exit 1. |
| `npx vitest run --maxWorkers=2 tests/credentials/session-policy.test.ts tests/credentials/bootstrap-templates.test.ts tests/providers/aws/drivers/contract.test.ts tests/providers/aws/drivers/eks/eks-cluster.test.ts tests/execution/secrets.test.ts tests/execution/secrets-azure.test.ts` | Initial focused run **173/6/1**; files **5 passed, 1 failed**; exit 1. |
| `npx vitest run --maxWorkers=2 tests/credentials/session-policy.test.ts tests/credentials/bootstrap-templates.test.ts` | **68/0/1**; files **2 passed**; exit 0. |
| `npx vitest run --maxWorkers=2 tests/platform/secret-grants.test.ts` | Initial fixture run **9/4/0**; files **1 failed**; exit 1. |
| `npx vitest run --maxWorkers=2 tests/platform/secret-grants.test.ts tests/bridge/deploy-bridge.test.ts tests/providers/aws/drivers/network/firewall.test.ts tests/credentials/session-policy.test.ts` | **109/0/0**; files **4 passed**; exit 0. |
| `npx vitest run --maxWorkers=2 tests/platform tests/credentials tests/secrets tests/providers/aws/drivers tests/providers/oci tests/workflows/sandbox.test.ts tests/execution/secrets.test.ts tests/execution/secrets-kubernetes.test.ts tests/execution/secrets-azure.test.ts tests/bridge tests/agent-v3 tests/actions/manifest-v2.test.ts tests/actions/manifest-v2-consumers.test.ts tests/actions/deploy.test.ts tests/actions/deploy-isolation.test.ts tests/actions/deploy-approve-separation.test.ts` | **2555/0/25**; files **103 passed**; exit 0. |
| `npx vitest run --maxWorkers=4` | The only whole-suite run: **13693/10/382**; files **695 passed, 5 failed, 17 skipped**; exit 1. |
| `npx vitest run --maxWorkers=2 tests/ci tests/docs tests/security/controlplane-sql-scoping.test.ts tests/screens/platform/approval-card.test.tsx tests/credentials/bootstrap-templates.test.ts tests/controlplane/operations.test.ts tests/platform/secret-grants.test.ts tests/platform/broker.test.ts` | **418/1/15**; files **14 passed, 1 failed, 1 skipped**; exit 1. Last failure exposed the missing destroy real-engine requirement. No `tests/platform/broker.test.ts` file exists; other selected paths ran. |
| `npx vitest run --maxWorkers=2 tests/ci tests/docs tests/security/controlplane-sql-scoping.test.ts tests/screens/platform/approval-card.test.tsx tests/credentials/bootstrap-templates.test.ts tests/controlplane/operations.test.ts tests/platform/secret-grants.test.ts` | Final seam rerun **419/0/15**; files **15 passed, 1 skipped**; exit 0. |
| `npx tsc --noEmit` (3 invocations) | #1: **21 errors**, exit 2; #2 and #3: **0 errors**, exit 0 each. No fourth invocation. |
| `npx eslint @lintPaths` (2 invocations; expansion A below) | **0 errors, 0 warnings**, exit 0 each. |
| `npx eslint @lintPaths` (1 invocation; expansion B below) | **0 errors, 0 warnings**, exit 0. |
| `npx eslint tests/ci/assert-lane-report.mjs` | **0 errors, 0 warnings**, exit 0. |
| `npx tsx scripts/generate-oci-allowlist.ts` | Exit 0; regenerated golden data. Allowlist JSON was already current; service fixture changed. |
| `npx tsx deploy/aws/tools/generate-tofu-policies.ts --write` (4 invocations) | Exit 0 each; **12 templates generated per invocation**, 7 changed from HEAD. |
| `npx tsx scripts/docs/capability-matrix.ts` | Exit 0; generated **282 lines, 104 driver rows**. |
| `npx tsx scripts/docs/capability-matrix.ts --strict` (3 invocations) | #1 exit 1: stale generated matrix; #2 and #3 exit 0, matrix current. No capability declaration inconsistency was introduced. |
| `npm run platform:emit-sql -- --check` | Exit 0, but `npm.ps1` consumed `--check` and warned; **not counted as a real check**. SQL output was already current. |
| `npm.cmd run platform:emit-sql -- --check` (2 invocations) | Exit 0 each; actual script `tsx scripts/platform/emit-sql.ts --check` reported migration current. |
| `git diff --check` (2 invocations); `git --no-optional-locks diff --check` (1 invocation) | **0 whitespace errors**, exit 0 each. |
| `go vet ./...` (from `go/`) | PowerShell exit 1: `go` not recognized. **Not run; 0 packages checked**. |
| `go test ./...` (from `go/`) | PowerShell exit 1: `go` not recognized. **Not run; 0 tests/packages run**. |

Exact PowerShell ESLint expansions, evaluated against changed paths at each run:

```powershell
# A
$lintPaths = @(git diff --name-only -- '*.ts' '*.tsx') + @('src/lib/platform/secret-grants.ts','tests/platform/secret-grants.test.ts')
npx eslint @lintPaths
# B (34 paths after full-suite drift fixes)
$lintPaths = @(git diff --name-only -- '*.ts' '*.tsx' '*.mjs') + @('src/lib/platform/secret-grants.ts','tests/platform/secret-grants.test.ts')
npx eslint @lintPaths
```

## Files changed or added

**48 files total**, including this report; 45 tracked changes and 3 additions.

Manifest readers and pass-through types:

- `src/app/api/environments/[id]/export/route.ts`
- `src/app/api/environments/[id]/plan-steps/route.ts`
- `src/components/deploy/changes-review.tsx`
- `src/components/deploy/success-panel.tsx`
- `src/components/inspector/add-resource-form.tsx`
- `src/components/inspector/add-service-form.tsx`
- `src/components/inspector/binding-list.tsx`
- `src/components/inspector/resource-editor.tsx`
- `src/components/shell/project-chrome.tsx`
- `src/lib/agent-access/v3/context.ts`
- `src/lib/agent-access/v3/ports.ts`
- `src/lib/agent-access/v3/tools/project.ts`
- `src/lib/agent-access/v3/tools/propose.ts`
- `tests/secrets/namespacing.test.ts`
- `tests/secrets/store.test.ts`

Approval and secret sync:

- `src/lib/actions/defs/deploy.ts`
- `src/lib/controlplane/db/repos/operations.ts`
- `src/lib/execution/secrets.ts`
- `src/lib/platform/broker.ts`
- **Added** `src/lib/platform/secret-grants.ts`
- **Added** `tests/platform/secret-grants.test.ts`
- `tests/bridge/deploy-bridge.test.ts`
- `tests/screens/platform/approval-card.test.tsx`
- `tests/workflows/sandbox.test.ts`

AWS drivers, credentials and generated bootstrap policies:

- `src/lib/credentials/aws/session-policy.ts`
- `src/lib/providers/aws/drivers/eks/eks-cluster.ts`
- `src/lib/providers/aws/drivers/network/firewall-compile.ts`
- `src/lib/providers/aws/drivers/shared/security-group.ts`
- `tests/credentials/bootstrap-templates.test.ts`
- `tests/credentials/session-policy.test.ts`
- `tests/providers/aws/drivers/contract.test.ts`
- `tests/providers/aws/drivers/network/firewall.test.ts`
- `deploy/aws/zenith-connection.cfn.yaml`
- `deploy/aws/tofu-module/policies/deploy-compute.json.tftpl`
- `deploy/aws/tofu-module/policies/deploy-data.json.tftpl`
- `deploy/aws/tofu-module/policies/deploy-edge.json.tftpl`
- `deploy/aws/tofu-module/policies/deploy-iam.json.tftpl`
- `deploy/aws/tofu-module/policies/deploy-network.json.tftpl`
- `deploy/aws/tofu-module/policies/observe.json.tftpl`
- `deploy/aws/tofu-module/policies/workload-boundary.json.tftpl`

OCI, matrix, CI and operator documentation:

- `go/internal/oci/oci_test.go`
- `go/internal/oci/testdata/services.json`
- `docs/platform/CAPABILITY-MATRIX.md`
- `docs/platform/operations/DEPLOYING.md`
- `docs/platform/operations/POLICY.md`
- `tests/ci/assert-lane-report.mjs`
- `tests/docs/operator-docs.test.ts`
- **Added** `WS-INTEGRATE-W6-REPORT.md`
