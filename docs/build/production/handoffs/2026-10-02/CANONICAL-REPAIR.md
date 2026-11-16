# Canonical repair integration completed locally

Source: `8657abdf6678a963869262ebd38375c16e895cc4`. Integration: `616a6f4e4024cbd3779b0498838222fe17100341`. Author and committer: Saivedant Hava `<saivedant169@gmail.com>` on this Mac.

The HTTP controller and patched Temporal reconcile path now reuse one controller under the same heartbeat/renewed fenced lease. Unknown and inaccessible observations retain provenance. Repairs remain scoped broker proposals; running/uncertain claims and environment-wide uncertain mutations block blind redispatch. The shared pure AWS ECS replica recipe is admission only. No credentials or mutation grant derive from that recipe.

Root verification: 692 passed, 0 failed, 0 skipped, including five real network OpenTofu checks and isolated Temporal history/reconcile tests. Full TypeScript, affected lint, gofmt, Go vet and Go tests passed. Go: 226 top-level passes, 539 subtest passes, 0 failures, 3 Linux-only macOS skips; 11 tested packages and 6 packages without tests. Fresh actual PostgreSQL 16.15: 1,331 passed, 0 failed/skipped, all 39 required groups and all 12 observed schema-2 receipt bindings matched; separate mandatory execution revalidation passed. Fresh local kind: provider 6/6 and release 1/1, no failures/skips. Database, cluster, owned containers and kubeconfig were removed.

Exact executable/test freeze checked was `d226284445698f3890fc44b9df939ed997420558b5da3e92a8cf011e1f06d531` on dirty base `e2a5c4f`. Final 30-path manifest `a94daffa326aac8a89310c97b244c5617dcf1dbb71101fb0c9ef89ecd695e5cc` differs only in the independently inspected documentation clarification. Artifacts retain their actual precommit provenance, not substituted hashes.

Evidence: `../../evidence/engine-acceptance/platform-postgres-canonical-repair.json` and `../../evidence/local-kind/canonical-repair.json`. Private logs remain under `/Users/saivedanthava/.codex/zenith-w8/logs/prod-canonical-repair-pure-root-*` and `/Users/saivedanthava/.codex/zenith-production/logs/prod-canonical-repair-pure-{postgres,kind}-root-*`.

PROD-OBS-01 remains paused, not verified complete. The ECS saved-plan execution adapter has not been verified or merged. Live remediation, fresh telemetry, diagnosis/escalation and durable fleet scheduling remain outstanding. Local kind proves neither managed CNI isolation nor live-cloud acceptance. Preserve `reconcile-canonical-proposals-v1` until history-retention and replay requirements permit patch retirement; no retention policy has been chosen.
