/**
 * The end-to-end release acceptance scenarios (PROD-REL-01): every scenario the release needs independently
 * verified, each mapped to the test lanes and live harnesses that exist for it. This file is DATA: the orchestrator
 * (`acceptance-orchestrator.ts`) runs it and the dossier (`dossier.ts`) reports it, and
 * `tests/release/acceptance-scenarios.test.ts` fails when a mapped file disappears or a required scenario is missing.
 *
 * Lane kinds follow the ledger's evidence classes:
 *   contract          recorded or logical fixtures, no engine
 *   local_engine      the real local engine (PGlite or PostgreSQL, OpenTofu, kind, a real TCP/HTTP server)
 *   live_sandbox      a gated live harness against a disposable cloud sandbox: DEFERRED unless the operator runs it
 *
 * A scenario is `verified` only when every lane kind it needs has actually passed, live included. A scenario whose
 * live lane did not run is `local_passed_live_pending`, never verified.
 */
export type LaneKind = "contract" | "local_engine" | "live_sandbox";

export interface LocalLane {
  id: string;
  kind: "contract" | "local_engine";
  /** vitest files; every one must exist */
  files: readonly string[];
  /** env vars that make part of the lane real (documented; the lane runs without them and reports skips) */
  optionalGates?: readonly string[];
}

export interface LiveLane {
  id: string;
  kind: "live_sandbox";
  /** argv run from the repository root when the operator passes --include-live (the harness enforces its own gates and scope) */
  command: readonly string[];
  /** files the command runs; must exist */
  files: readonly string[];
  /** the scope manifest harness id that must be granted */
  scopeHarness: string;
  /** env gates the harness needs, so the orchestrator can say exactly what is missing */
  gates: readonly string[];
  /** exit codes meaning "the harness declined to run" (a skip, never a pass) */
  skipExitCodes: readonly number[];
  /** why this lane is deferred, in one sentence */
  deferredBecause: string;
}

export interface LocalCommandLane {
  id: string;
  kind: "local_engine";
  files: readonly string[];
  command: readonly string[];
  gates: readonly string[];
  evidenceLabel: "local_rehearsal" | "local_operated_rehearsal";
}
export type Lane = LocalLane | LiveLane | LocalCommandLane;

export interface Scenario {
  id: string;
  title: string;
  /** ledger requirement ids this scenario provides evidence for */
  requirements: readonly string[];
  lanes: readonly Lane[];
  /** an honest note on what the lanes do NOT establish */
  limits: string;
}

const AWS_LIVE = (scenario: string, because: string): LiveLane => ({
  id: `aws-live-${scenario.toLowerCase()}`, kind: "live_sandbox", command: ["npx", "tsx", "scripts/acceptance/aws-live.ts", "--scenario", scenario, "--confirm-billable"], files: ["scripts/acceptance/aws-live.ts"],
  scopeHarness: "aws-live", gates: ["ZENITH_LIVE_AWS_ACCOUNT_ID", "ZENITH_LIVE_REGION", "ZENITH_LIVE_API_URL", "ZENITH_LIVE_API_TOKEN", "ZENITH_LIVE_SCOPE_FILE (approved)"], skipExitCodes: [2], deferredBecause: because,
});

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "install", title: "Clean install of the self-hosted stack", requirements: ["PROD-PKG-04", "PROD-PKG-05", "PROD-REL-01"],
    lanes: [{ id: "installer-contract", kind: "contract", files: ["tests/deploy/installation.test.ts"] }],
    limits: "The installer is exercised by its own verifier on a clean host; this lane proves the installer's contract, not a clean machine.",
  },
  {
    id: "private-source", title: "Private source admitted by approved snapshot", requirements: ["PROD-REL-01"],
    lanes: [{ id: "source-authority", kind: "local_engine", files: ["tests/execution/approved-source.test.ts", "tests/controlplane/approved-source-snapshots.test.ts", "tests/sources/github-app.test.ts", "tests/sources/github-lifecycle.test.ts", "tests/release/drivers/drv1.test.ts"], optionalGates: ["ZENITH_TEST_PLATFORM_PG_URL", "ZENITH_TEST_SOURCE_GITHUB_APP"] }],
    limits: "The dedicated local target operates source admission, browser review and revocation on J1/J2 with an authenticated GitHub emulator. It intentionally refuses execution after revocation; private builds and live GitHub acceptance remain separate.",
  },
  {
    id: "plan-approval", title: "Plan, human approval bound to exact effects", requirements: ["PROD-REL-01"],
    lanes: [{ id: "approval-binding", kind: "local_engine", files: ["tests/execution/ledger-approval.test.ts", "tests/controlplane/approvals.test.ts", "tests/platform/plan-approval.test.ts", "tests/workflows/approval-time.test.ts"] }],
    limits: "Browser approval by a person is exercised through the route contracts, not a live browser session.",
  },
  {
    id: "dns-tls", title: "DNS and TLS ownership, issuance and teardown review", requirements: ["PROD-REL-01", "PROD-MIX-05"],
    lanes: [
      { id: "dns-contract", kind: "contract", files: ["tests/execution/destroy-dns-ownership.test.ts", "tests/portability/dns-transport.test.ts", "tests/acceptance/non-aws-dns-live.test.ts"] },
      { id: "protected-connectivity-contract", kind: "contract", files: ["tests/execution/mixed/connectivity.test.ts", "tests/acceptance/mixed-connectivity-probe.test.ts"] },
      {
        id: "mixed-connectivity-live", kind: "live_sandbox", command: ["npx", "vitest", "run", "tests/live/mixed-connectivity.live.test.ts"], files: ["tests/live/mixed-connectivity.live.test.ts"], scopeHarness: "mixed-connectivity-live",
        gates: ["ZENITH_LIVE_MIXED=1", "ZENITH_LIVE_MIXED_API_URL", "ZENITH_LIVE_MIXED_PLAN_ID", "ZENITH_LIVE_MIXED_TOKEN_FILE", "ZENITH_LIVE_MIXED_CLIENT_CERT_FILE", "ZENITH_LIVE_MIXED_CLIENT_KEY_FILE"], skipExitCodes: [], deferredBecause: "needs a deployed mixed run and a person's approved scope",
      },
    ],
    limits: "No real certificate issuance or DNS write is performed by the contract lanes.",
  },
  {
    id: "stateful-traffic", title: "Stateful application serving real traffic with independent readback", requirements: ["PROD-MIX-06", "PROD-REL-01"],
    lanes: [
      { id: "reference-app-local", kind: "local_engine", files: ["tests/acceptance/mixed-traffic.test.ts", "tests/acceptance/mixed-live-run.test.ts", "tests/execution/journey.test.ts", "tests/acceptance/sample-app.test.ts"] },
      {
        id: "mixed-traffic-live", kind: "live_sandbox", command: ["npx", "tsx", "scripts/acceptance/mixed/live-run.ts"], files: ["scripts/acceptance/mixed/live-run.ts"], scopeHarness: "mixed-traffic-live",
        gates: ["ZENITH_LIVE_MIXED=1", "ZENITH_LIVE_MIXED_API_URL", "ZENITH_LIVE_MIXED_WORKSPACE_ID", "ZENITH_LIVE_MIXED_PLAN_ID", "ZENITH_LIVE_MIXED_TOKEN_FILE", "ZENITH_LIVE_MIXED_ENTRY_URL", "ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE", "ZENITH_LIVE_MIXED_BUDGET_USD", "ZENITH_LIVE_MIXED_TTL_MINUTES"],
        skipExitCodes: [2], deferredBecause: "live cloud acceptance and its budget are not approved",
      },
    ],
    limits: "The local lane serves the real fixture servers on loopback with an in-memory store; it proves the checker, not a cloud deployment.",
  },
  {
    id: "update-rollback", title: "Compatible update and rollback", requirements: ["PROD-REL-01"],
    lanes: [{ id: "release-safety", kind: "local_engine", files: ["tests/execution/release.test.ts", "tests/execution/release-safety.test.ts", "tests/release-safety/pipeline.test.ts", "tests/execution/manifest-release.test.ts", "tests/hosted/acceptance/gate-08-compatible-update.test.ts", "tests/release/drivers/drv1.test.ts"] }],
    limits: "The dedicated local target operates compatible revisions, failed rollout and browser-approved rollback on J1/J2/kind. Live provider rollback and data-migration compatibility remain separately gated.",
  },
  {
    id: "machine-schedules", title: "Machine runbooks and scheduled jobs", requirements: ["PROD-REL-01"],
    lanes: [{ id: "machine-schedules", kind: "local_engine", files: ["tests/machines/runbooks.test.ts", "tests/machines/dispatcher.test.ts", "tests/workflows/critical-schedule.test.ts", "tests/workflows/reconcile-schedule.test.ts"], optionalGates: ["ZENITH_TEST_PLATFORM_PG_URL"] }],
    limits: "Cloud machine agents (SSM, run-command, OS config) are provider contract tests, not live runs.",
  },
  {
    id: "drift-repair", title: "Drift detection and approved repair", requirements: ["PROD-REL-01"],
    lanes: [
      { id: "drift-repair", kind: "local_engine", files: ["tests/drift/compute.test.ts", "tests/repair/lifecycle.test.ts", "tests/reconcile/repair.test.ts", "tests/reconcile/pass.test.ts"] },
      AWS_LIVE("D", "live cloud acceptance is not approved"),
    ],
    limits: "Repair is judged against fakes and the local engine unless the live demo ran.",
  },
  {
    id: "revocation", title: "Credential and connection revocation", requirements: ["PROD-REL-01", "PROD-MIX-07"],
    lanes: [
      { id: "revocation", kind: "local_engine", files: ["tests/connections/lifecycle.test.ts", "tests/credentials/grants.test.ts", "tests/controlplane/grants.test.ts"] },
      AWS_LIVE("F", "live cloud acceptance is not approved"),
    ],
    limits: "A revoked connection is shown to refuse new actions; the effect on a live cloud's running resources is the live lane's.",
  },
  {
    id: "crash-partition", title: "Crash, restart and partitioned writers", requirements: ["PROD-REL-01", "PROD-MIX-07"],
    lanes: [
      { id: "crash-partition", kind: "local_engine", files: ["tests/workflows/destroy-replay.test.ts", "tests/workflows/history-replay.test.ts", "tests/ops/data-plane-independence.test.ts", "tests/runners/late-effect-receipts.test.ts", "tests/controlplane/leases.test.ts", "tests/controlplane/lease-hang.test.ts"], optionalGates: ["ZENITH_TEST_PLATFORM_PG_URL"] },
      { id: "mixed-failure-simulation", kind: "contract", files: ["tests/acceptance/mixed-failure-scenarios.test.ts", "tests/execution/mixed-orchestration.test.ts", "tests/workflows/mixed-parent.test.ts"] },
      AWS_LIVE("E", "live cloud acceptance is not approved"),
    ],
    limits: "Simulated failure over the real state machine is not a provider outage.",
  },
  {
    id: "mixed-recovery", title: "One-provider failure recovery on the mixed app", requirements: ["PROD-MIX-07"],
    lanes: [
      { id: "fault-proxy-local", kind: "local_engine", files: ["tests/acceptance/mixed-live-recovery.test.ts"] },
      {
        id: "mixed-recovery-live", kind: "live_sandbox", command: ["npx", "tsx", "scripts/acceptance/mixed/live-recovery.ts"], files: ["scripts/acceptance/mixed/live-recovery.ts"], scopeHarness: "mixed-recovery-live",
        gates: ["ZENITH_LIVE_MIXED=1", "ZENITH_LIVE_MIXED_RECOVERY=1", "ZENITH_LIVE_MIXED_FAULT", "ZENITH_LIVE_MIXED_RUN_ID", "ZENITH_LIVE_MIXED_ENTRY_URL", "ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE"],
        skipExitCodes: [2], deferredBecause: "live cloud acceptance and fault injection are not approved",
      },
    ],
    limits: "The local lane blackholes a loopback server through a real TCP proxy; the live lane revokes or blackholes against a deployed run.",
  },
  {
    id: "rotation", title: "Key and credential rotation", requirements: ["PROD-REL-01"],
    lanes: [{ id: "rotation", kind: "local_engine", files: ["tests/keycustody/rewrap-job.test.ts", "tests/keycustody/registry.test.ts", "tests/connections/rotations-repo.test.ts", "tests/controlplane/plan-custody.test.ts"], optionalGates: ["ZENITH_TEST_PLATFORM_PG_URL"] }],
    limits: "Provider-side credential rotation is covered by connection lifecycle contracts, not a live cloud.",
  },
  {
    id: "upgrade", title: "Rolling upgrade and rollback", requirements: ["PROD-REL-01"],
    lanes: [{ id: "rolling-upgrade", kind: "local_engine", files: ["tests/ops/rolling-upgrade.test.ts", "tests/controlplane/migration-compat.test.ts", "tests/workflows/codec-replay.test.ts"] }],
    limits: "A real rolling upgrade of a deployed topology is the operations rehearsal, not a unit lane.",
  },
  {
    id: "restore", title: "Backup and restore", requirements: ["PROD-REL-01"],
    lanes: [{ id: "backup-restore", kind: "local_engine", files: ["tests/hosted/backup/create-restore.test.ts", "tests/hosted/backup/reopen.test.ts", "tests/controlplane/state-backend-recovery.test.ts"] }],
    limits: "Restore into a fresh environment from off-site storage is the operations rehearsal.",
  },
  {
    id: "two-tenants", title: "Two tenants cannot see or affect each other", requirements: ["PROD-REL-01"],
    lanes: [{ id: "tenant-isolation", kind: "local_engine", files: ["tests/controlplane/tenancy.test.ts", "tests/security/controlplane-sql-scoping.test.ts", "tests/security/mcp-v2-tenant-isolation.test.ts", "tests/hosted/acceptance/gate-02-second-identity.test.ts"], optionalGates: ["ZENITH_TEST_PLATFORM_PG_URL"] }],
    limits: "Isolation is proven by SQL scoping, RLS and identity tests; a live two-customer run is not claimed.",
  },
  {
    id: "export", title: "Export and portability", requirements: ["PROD-REL-01"],
    lanes: [{ id: "export", kind: "local_engine", files: ["tests/hosted/export/roundtrip.test.ts", "tests/portability/store.test.ts", "tests/portability/postgres-engine.test.ts"] }],
    limits: "Importing the export into a different provider is not exercised.",
  },
  {
    id: "teardown", title: "Approved teardown in reverse dependency order", requirements: ["PROD-REL-01", "PROD-MIX-07"],
    lanes: [
      { id: "teardown", kind: "local_engine", files: ["tests/execution/destroy.test.ts", "tests/execution/destroy-review.test.ts", "tests/workflows/destroy.test.ts", "tests/execution/mixed-orchestration-service.test.ts"] },
      AWS_LIVE("A", "live cloud acceptance is not approved"),
    ],
    limits: "Provider-side deletion is judged live only; teardown of a mixed run stays a person-approved proposal.",
  },
  {
    id: "mixed-economics", title: "Mixed-cloud economics, latency and residency report", requirements: ["PROD-MIX-07", "PROD-COST-01", "PROD-COST-02"],
    lanes: [{ id: "economics", kind: "contract", files: ["tests/execution/mixed/economics.test.ts", "tests/placement/cost.test.ts", "tests/cost/kinds.test.ts"] }],
    limits: "Figures are list-price estimates from a dated catalog and approximate latency tables; actual spend is a separate, gated read.",
  },
  {
    id: "release-governance", title: "Scope manifest, checkpoints, release status and the evidence dossier", requirements: ["PROD-REL-02", "PROD-REL-03", "PROD-REL-04"],
    lanes: [{ id: "release-tooling", kind: "contract", files: ["tests/release/scope.test.ts", "tests/release/checkpoint.test.ts", "tests/release/acceptance-scenarios.test.ts", "tests/release/orchestrator.test.ts", "tests/release/dossier.test.ts", "tests/release/status.test.ts", "tests/release/live-scope-coverage.test.ts"] }],
    limits: "These lanes prove the tooling's rules, not that any live run happened.",
  },
];

export const REQUIRED_SCENARIO_IDS: readonly string[] = [
  "install", "private-source", "plan-approval", "dns-tls", "stateful-traffic", "update-rollback", "machine-schedules", "drift-repair", "revocation", "crash-partition",
  "rotation", "upgrade", "restore", "two-tenants", "export", "teardown",
];

export function allLaneFiles(scenarios: readonly Scenario[] = SCENARIOS): string[] {
  return [...new Set(scenarios.flatMap((s) => s.lanes.flatMap((l) => [...l.files])))].sort();
}
