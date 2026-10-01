# WS-DOCS-SYNC-2 — operator docs tell the truth about wave 7

Workstream: WS-DOCS-SYNC-2 (orchestrator brief) — Branch ws/docs-sync-2 — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-docs-sync-2
Base: ws/integrate-w6 (staging: all wave-7 jobs merged except WS-AWS-BUILD-BOUNDARY, which is still running)

## Situation
Wave 7 landed a lot of behaviour that the operator guides describe only partly or not at all. `npx vitest run tests/docs`
passes today (the orchestrator just fixed the guards that failed), but passing guards do not prove the guides are complete.
What changed (read the code; cite the file that proves each claim):
- **Teardown:** `env.teardown` action, trusted evidence-backed destroy proposals, destroy workflow start, deletion guards
  (src/lib/actions/**, src/lib/execution/destroy.ts, src/lib/execution/plan.ts deletion guards, src/lib/providers/{kubernetes,zenith}/teardown.ts,
  destroy UI under src/app/(product)/platform/**).
- **Deletion approvals:** stateful and DNS deletions always require a human, every environment, any autonomy
  (policy/rego/approval.rego `stateful_deletes_require_approval`, `dns_deletes_require_approval`); a moved final plan is refused as
  plan_changed before deletion guards run (src/lib/tofu/engine.ts expectedDigest).
- **Ephemeral secrets (C5):** TofuFragment `ephemeral` blocks and write-only `*_wo` attributes; passwords never in state
  (src/lib/tofu/workspace.ts, Azure/GCP/AWS DB drivers); OCI MySQL creation still disabled (src/lib/providers/oci/drivers/data/mysql.ts — say why).
- **Builds from source (C3):** deterministic git source bundles uploaded to the customer bucket (src/lib/platform/source-bundle.ts);
  AWS CodeBuild takes ZIP, GCP Cloud Build and Azure ACR take tar.gz; pinned bootstrap images (no :latest).
- **OCI:** platform sessions through a registered runner only; Logging Search + Monitoring reads with the logs.read / metrics.read /
  incident.investigate split; runner read jobs without an operation (migration 5, src/lib/runners/read-jobs.ts).
- **AWS reads:** EKS and SNS SDK reads (observe/verify/refresh at contract evidence), EventBridge/CloudFront reads.
- **Temporal payload encryption:** AES-256-GCM codec, key rotation via ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS (src/lib/workflows/codec.ts).
- **MCP OAuth discovery:** protected-resource metadata at /.well-known/oauth-protected-resource/api/agent/v3/mcp and the
  WWW-Authenticate challenge (src/lib/agent-access/v3/auth.ts, server.ts).
- **Zenith-managed:** teardown (C1), Neon credential sink, full-graph identity trust, TLS for managed hostnames.
- **Worker:** identity rules, health/readiness endpoints, plan janitor; housekeeping prunes with skip-locked.

## Objective
Every operator-facing statement is TRUE for the current code, complete enough to operate the new features, and guarded:
when you add a claim that would silently rot, add a drift assertion in tests/docs/operator-docs.test.ts that fails if the
wiring is removed. Honesty rules: nothing is `real`/live-verified (no cloud accounts were used); unknown stays unknown.

## Owned paths
docs/** EXCEPT docs/build/** (orchestrator ledger), docs/platform/CAPABILITY-MATRIX.md (generated — never hand-edit),
docs/platform/RUNNER-PROTOCOL-OCI.md (just updated by WS-OCI-SIGNALS-WIRE; edit only if wrong) ; README.md (platform section) ;
tests/docs/** EXCEPT tests/docs/capability-matrix.test.ts.
NOT deploy/aws/** and NOT the IAM boundary text anywhere (WS-AWS-BUILD-BOUNDARY owns it right now). No source changes.

## Do
1. Sweep docs/platform/**, docs/LIMITATIONS.md, README.md for stale statements about the items above ("not wired", "refused",
   "gap", "pending", "not yet", "stub", "TODO") and correct them against the code.
2. Add or extend operator sections: tearing down an environment (who can, what is guarded, what needs approval, what evidence
   is kept); deletion approvals; builds from source per provider; OCI signal reads through the runner (operator view, link to
   RUNNER-PROTOCOL-OCI.md); Temporal payload encryption and key rotation; MCP OAuth discovery for agent clients.
3. docs/LIMITATIONS.md: one honest line per still-open gap (live clouds unverified, real Postgres lane not run, kind/real
   Kubernetes not run, Temporal Cloud not run, OCI MySQL create disabled, anything else you find).
4. Drift assertions for the new claims.

## Verification
- `npx vitest run --maxWorkers=1 tests/docs` (0 failures) ; `npx eslint tests/docs` ; at most one `npx tsc --noEmit`
- `npx tsx scripts/docs/capability-matrix.ts --check`
