# WS-MACH-CLOUDS — Azure Run Command and GCP OS management machine transports

Workstream: WS-MACH-CLOUDS (new; orchestrator brief) — Branch ws/mach-clouds — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-mach-clouds
Base: platform/integration (machine plane aligned end to end: SSM, Kubernetes, zenithd)

## Situation
`MachineTransport` includes `azure_run_command` and `gcp_os_management`, but both are refused as
`unsupported_transport` (src/lib/machines/**). The SSM transport (transports/aws-ssm.ts + the
environment-specialised SSM documents) is the reference: fixed, parameter-validated implementations
per semantic operation, argv never concatenated into a shell string, output bounded and redacted,
uncertain on mutating timeouts, evidence per request.

## Objective
1. `azure_run_command` over the Azure session's ARM client (Run Command v2 / managed run commands on
   a VM): one fixed script per supported operation with parameters passed as named parameters (never
   interpolated), polling with backoff, output bounds, uncertain semantics like SSM.
2. `gcp_os_management`: choose the safest available mechanism (e.g. OS Config guest policies are not
   on-demand; prefer the documented approach — if no safe on-demand exec API exists, implement only the
   read operations via the Compute/OS Inventory APIs and refuse mutating ones with a clear reason).
   Document the choice.
3. Session provider (src/lib/machines/sessions.ts) builds the Azure/GCP sessions through the broker;
   execution target resolution (src/lib/execution/capability.ts `machineTarget`) maps
   `azure:virtual_machine` / `gcp:compute_instance` observations to the new transports.

## Owned paths
src/lib/machines/** ; src/lib/execution/capability.ts (target resolution only) ; tests/machines/** ;
tests/execution/capability*.test.ts .

## Verification
- npx tsc --noEmit ; npx eslint src/lib/machines src/lib/execution/capability.ts tests/machines tests/execution
- npx vitest run --maxWorkers=2 tests/machines tests/execution/capability.test.ts
