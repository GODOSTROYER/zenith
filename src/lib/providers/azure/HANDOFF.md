# WS-AZURE-MORE implementation handoff

Worktree: `Z:/Projects/Spawned.ai/zenith-wt/ws-azure-more`, branch
`ws/azure-more`, starting commit `4c7a652`. All changes remain in the working
tree. No Git metadata writes, dependency installs, package edits, or changes
outside the three owned path trees were made.

## Result and evidence

Six previously absent native types are registered with **contract** evidence:
MySQL Flexible Server, Linux VM, managed disk, Static Web Apps, Linux Functions,
and private AKS. Container Apps ingress remains the load-balancer implementation;
the application-gateway declaration now rejects unsupported requirements.
Bootstrap permissions, private subnet/DNS wiring, identity roles, SWA custom
domains, and observation ambiguity/partial-read handling accompany these drivers.

The final ordinary Azure run passed **361 tests**, with **5 gated schema tests
skipped**, across 14 passing files. Whole-repo TypeScript and owned-path ESLint
passed. No real Azure subscription was used. No OpenTofu schema validation
success is claimed: the installed executable cannot launch in this sandbox.
Fake ARM tests cover 200/404/403/429/500, ambiguous matches, malformed/partial
configuration, credential redaction, and truncated discovery.

See [README.md](./README.md) for graph inputs, declaration limits, and operator
prerequisites. This work is ready for orchestrator review, **not live-verified**.

## Added files

- `src/lib/providers/azure/README.md`
- `src/lib/providers/azure/HANDOFF.md`
- `src/lib/providers/azure/drivers/arm-template.ts`
- `src/lib/providers/azure/drivers/more-util.ts`
- `src/lib/providers/azure/drivers/compute/virtual-machine.ts`
- `src/lib/providers/azure/drivers/compute/function-app.ts`
- `src/lib/providers/azure/drivers/compute/static-web-app.ts`
- `src/lib/providers/azure/drivers/compute/aks-cluster.ts`
- `src/lib/providers/azure/drivers/data/mysql.ts`
- `src/lib/providers/azure/drivers/data/managed-disk.ts`
- `tests/providers/azure/_more-fixtures.ts`
- `tests/providers/azure/more-compile.test.ts`
- `tests/providers/azure/more-observe.test.ts`

## Changed files

- `src/lib/providers/azure/drivers/index.ts`
- `src/lib/providers/azure/drivers/compute/index.ts`
- `src/lib/providers/azure/drivers/compute/load-balancer.ts`
- `src/lib/providers/azure/drivers/data/index.ts`
- `src/lib/providers/azure/drivers/data/postgres.ts` (comment pointing to MySQL)
- `src/lib/providers/azure/drivers/data/private-endpoint.ts`
- `src/lib/providers/azure/drivers/dns/dns-record.ts`
- `src/lib/providers/azure/drivers/identity/identity.ts`
- `src/lib/providers/azure/drivers/network/firewall.ts`
- `src/lib/providers/azure/drivers/network/network.ts`
- `src/lib/providers/azure/drivers/network/subnet.ts`
- `src/lib/providers/azure/exports.ts`
- `src/lib/providers/azure/kit.ts`
- `src/lib/providers/azure/platform.ts`
- `deploy/azure/main.tf`
- `deploy/azure/README.md`
- `tests/providers/azure/compile-drivers.test.ts`
- `tests/providers/azure/deploy.test.ts`
- `tests/providers/azure/observe.test.ts`
- `tests/providers/azure/registry.test.ts`
- `tests/providers/azure/validate.test.ts`

## Exact verification history

Commands ran from this worktree. Counts below are reported results, not inferred
success. Earlier failures were corrected without reducing test coverage.

| Command | Executions and results |
| --- | --- |
| `npx eslint src/lib/providers/azure tests/providers/azure` | First: 1 error, 0 warnings (unused MySQL import, fixed). Second, third and fourth: 0 errors, 0 warnings, exit 0. |
| `npx tsc --noEmit` | Two executions: both exit 0, 0 diagnostics. No third execution. |
| `npx vitest run --maxWorkers=2 tests/providers/azure` | First: 220 passed, 2 failed, 4 skipped (226); 10 files passed, 2 failed. Second: 353 passed, 1 failed, 5 skipped (359); 13 files passed, 1 failed. Final: 361 passed, 0 failed, 5 skipped (366); 14 files passed. |
| `npx vitest run --maxWorkers=2 tests/providers/azure/more-compile.test.ts tests/providers/azure/more-observe.test.ts` | 131 passed, 0 failed, 0 skipped; 2 files passed. Later seven cases are included in the final full Azure run. |
| Gated command below | First: 8 passed, 6 failed, 0 skipped (14); 2 files failed. Final: 9 passed, 5 failed, 0 skipped (14); 2 files failed. |
| `git diff --check` | Three executions: all exit 0, 0 whitespace errors. |
| `tofu version -json` | Failed to launch the WinGet shim: no associated application. |
| `& 'C:\Users\user\AppData\Local\Microsoft\WinGet\Packages\OpenTofu.Tofu_Microsoft.Winget.Source_8wekyb3d8bbwe\tofu.exe' version -json` | Failed to launch: access denied, exit 1. No version result was obtained. |

The third ESLint invocation and first whitespace check shared one shell command:
`npx eslint src/lib/providers/azure tests/providers/azure; git diff --check`.
The exact gated command, run twice, was:

```powershell
$env:ZENITH_TEST_TOFU_NETWORK='1'; $env:ZENITH_TOFU_BIN='C:\Users\user\AppData\Local\Microsoft\WinGet\Packages\OpenTofu.Tofu_Microsoft.Winget.Source_8wekyb3d8bbwe\tofu.exe'; npx vitest run --maxWorkers=2 tests/providers/azure/validate.test.ts tests/providers/azure/deploy.test.ts
```

The first ordinary failures were stale native-type and partial-read expectations.
The second ordinary failure and one first gated failure were a new static regex
that mistook the basic-publishing-auth policy name for credential listing; the
regex was narrowed to actual credential-read actions. Final gated failures:
four compiled-workspace cases raise `spawn EPERM`; the bootstrap case receives
null `spawnSync` status because the process cannot start. OpenTofu init/validate
did **not** successfully execute, and provider download/network behavior was not
tested. The env-var gates remain intact.

## Remaining work and deliberate deviations

- **Fresh MySQL is refused.** This driver supports PITR and Replica without a
  bootstrap password. AzureRM 5.7.0 Default creation requires one, while the
  fixed fragment contract cannot express ephemeral resources. The orchestrator
  would need an additive `ephemeral` field at
  `src/lib/drivers/types.ts:87`, expression/block validation at
  `src/lib/tofu/workspace.ts:168`, address handling at `:216`, merging at `:225`,
  and assembly/resource-type collection at `:321`, plus shared integration
  tests. Then ephemeral `random_password` can feed
  `administrator_password_wo` with a nonsecret rotation version. Those paths
  were not edited. [Pinned provider contract](https://raw.githubusercontent.com/hashicorp/terraform-provider-azurerm/v5.7.0/website/docs/r/mysql_flexible_server.html.markdown).
- **Functions use Dedicated Linux, not Flex.** Existing portable artifacts are
  containers. The driver implements private identity-based host storage and
  container hosting; Flex lacks custom-container support. Durable/Table and
  workload binding grants require separate explicit work.
  [Azure hosting comparison](https://learn.microsoft.com/en-us/azure/azure-functions/functions-scale).
- **SWA is infrastructure only.** Asset upload is absent; runtime stays unknown.
  An external partition-specific VNet-linked private DNS zone is required for
  private hosting. Its partition must match the assigned hostname, potentially
  requiring customer preparation after site assignment. Subdomain CNAME/custom
  domain binding is implemented; apex domains are refused. No deployment token
  is read. [Azure private endpoint requirements](https://learn.microsoft.com/en-us/azure/static-web-apps/private-endpoint).
- **AKS and MySQL identities need preparation.** Customer-scoped AKS subnet/DNS
  permissions and MySQL Graph directory permissions are prerequisites, not
  broad roles silently added to the deployer. Database workload SQL roles are
  also an operator step.
- **VM access is operator Run Command.** Zenith declares no guest command
  operation, and bootstrap does not grant arbitrary guest execution. A public
  RSA key is required by the VM resource, while NSG/cloud-init disable SSH.
  Guest SSH shutdown cannot be attested through ARM; verification stays unknown.
- **Function/SWA/AKS use ARM template deployments.** This avoids dedicated
  AzureRM refresh calls that retrieve credentials. See the pinned
  [Function refresh](https://raw.githubusercontent.com/hashicorp/terraform-provider-azurerm/v5.7.0/internal/services/appservice/linux_function_app_resource.go)
  and [AKS refresh](https://raw.githubusercontent.com/hashicorp/terraform-provider-azurerm/v5.7.0/internal/services/containers/kubernetes_cluster_resource.go).
  Templates output ID/hostname only and retain OpenTofu lifecycle ownership.
  Plans are at deployment granularity; ARM contents require real Azure
  validation/apply beyond provider-schema validation. Keep AzureRM's default
  nested-resource deletion behavior.
- **Manifest integration is outside ownership.** Current shared expansion does
  not emit most of these kinds, and static-only expansion lacks network/UAI
  dependencies (`src/lib/resources/expand.ts:248`). These drivers accept explicit
  resource graphs; the orchestrator must coordinate shared manifest changes if
  end-to-end manifest authoring is required.
- **No separate Application Gateway was added.** Existing Container Apps
  ingress is retained as directed; unsupported gateway behavior now fails
  compilation honestly.
- **No live deployment or schema proof.** Re-run gated azurerm 5.7.0 checks
  outside this sandbox, then Azure validation/apply and service-specific health
  checks before upgrading evidence beyond contract.
