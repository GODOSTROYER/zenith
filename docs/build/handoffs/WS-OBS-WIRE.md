# WS-OBS-WIRE — cloud reads and incident diagnosis actually available in the app

Workstream: WS-OBS-WIRE (new; orchestrator brief) — Branch ws/obs-wire — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-obs-wire
Base: platform/integration (platform composed end to end; tsc clean)

## Situation (verified by the orchestrator)
- Nothing in the application calls `registerCredentialBroker()` or `registerInvestigator()`
  (grep: no callers outside src/lib/incidents and src/lib/agent-access/v3/adapters.ts). So MCP v3
  cloud reads (logs/metrics/resource state) and incident investigation answer `unavailable`.
- Observability sources exist for AWS (CloudWatch logs/metrics/events/health), Kubernetes, Loki,
  Prometheus and sandbox (src/lib/observability/sources/**); GCP and Azure sources live inside their
  providers (src/lib/providers/gcp/observability.ts, src/lib/providers/azure/observability.ts
  createAzureLogsSource/createAzureMetricsSource). OCI has none. Check whether
  `sourcesForEnvironment` (src/lib/observability) includes GCP/Azure/Kubernetes/zenith-managed.
- The incident engine (src/lib/incidents/**) is evidence-first and takes injected ports.

## Objective
In the running app, an authorised agent or user can read logs/metrics/resource state and run an
incident investigation for any environment whose provider has sources — through the credential
broker (observe purpose), tenant-scoped, read-only, with honest `unavailable` where a provider has none.

## Owned paths
src/lib/platform/app.ts (call the registrations from the app composition, guarded like the rest) and
NEW src/lib/platform/agent-ports.ts ; src/lib/agent-access/v3/adapters.ts (registration seam only) ;
src/lib/observability/** (factory: include gcp/azure/kubernetes/zenith; NEW sources/oci-logging.ts and
oci-monitoring.ts over the OCI runner transport port, honest when no runner) ; src/lib/incidents/**
(only to accept the wired ports) ; tests/observability/**, tests/incidents/**, tests/platform/agent-ports*.test.ts,
tests/agent-v3/*-wired.test.ts (new).
Do NOT edit src/lib/platform/broker.ts (WS-APPROVAL-FLOW) or src/lib/server/cron.ts (WS-OPS).

## Tests
- app composition registers both; MCP read tools return data from mocked AWS/K8s sources through the
  real route; investigation produces findings from mocked evidence; foreign workspace refused uniformly;
  OCI sources honest `unavailable` without a runner; no credential ever in a result.

## Verification
- npx tsc --noEmit ; npx eslint src/lib/platform src/lib/observability src/lib/incidents src/lib/agent-access/v3/adapters.ts tests/observability tests/incidents tests/platform tests/agent-v3
- npx vitest run --maxWorkers=2 tests/observability tests/incidents tests/platform tests/agent-v3
