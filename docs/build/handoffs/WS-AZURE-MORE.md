# WS-AZURE-MORE — the Azure drivers that are still `unsupported`

Workstream: WS-AZURE-MORE (new; orchestrator brief) — Branch ws/azure-more — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-azure-more
Base: platform/integration

## Situation
NATIVE_TYPE_TABLE.azure (src/lib/resources/native-types.ts:146) maps kinds to Azure types, but these
have no working driver (WS-AZURE report): `azure:virtual_machine` (compute_instance),
`azure:function_app` (function), `azure:static_web_app` (static_site), `azure:mysql_flexible_server`
(mysql), `azure:aks_cluster` (kubernetes_cluster), `azure:managed_disk` (volume), and
`azure:application_gateway` declares nothing (the Container Apps ingress is the load balancer today).
Read src/lib/providers/azure/** first: `defineAzureDriver` kit (observe/runtime/verify/discover,
honesty rules), exports.ts locals convention, naming, landing-zone ownership (azure:virtual_network
owns the RG/VNet/Container Apps env), identity driver grants, deploy/azure bootstrap roles.

## Objective
Implement, with the same conventions and `contract` evidence, the drivers that make sense now:
1. `azure:mysql_flexible_server` — private, Entra-only where supported, HA/backup mapping, like the
   PostgreSQL driver.
2. `azure:virtual_machine` — Linux VM, no public IP, managed identity, SSH disabled (Run Command for
   access), encrypted disk, tags; plus `azure:managed_disk` for volume nodes.
3. `azure:static_web_app` — Static Web Apps (or storage static website + Front Door if SWA cannot be
   private/managed; justify), custom domain binding consistent with the DNS driver.
4. `azure:function_app` — Flex Consumption/Linux function app with the user-assigned identity,
   Key Vault references, VNet integration.
5. `azure:aks_cluster` — private API server or authorized IP ranges, workload identity + OIDC issuer
   enabled, Azure CNI, managed identity, no local accounts; node pool sizing from spec.
6. `azure:application_gateway` — only if a spec needs it beyond Container Apps ingress; otherwise keep
   the documented decision and make the driver's declaration honest.
Update deploy/azure bootstrap custom deployer role for the new resource types (least privilege).

## Owned paths
src/lib/providers/azure/** ; tests/providers/azure/** ; deploy/azure/** .

## Tests
Compile structure/determinism/tags/name limits; static checks (no public data services, no inline
secrets, no broad roles); observe/runtime/verify/discover against the fake ARM server
(200/404/403/429/500, ambiguity, partial); gated `tofu validate` against azurerm 5.7.0
(ZENITH_TEST_TOFU_NETWORK=1 — say if tofu cannot run in your sandbox).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/providers/azure tests/providers/azure
- npx vitest run --maxWorkers=2 tests/providers/azure
