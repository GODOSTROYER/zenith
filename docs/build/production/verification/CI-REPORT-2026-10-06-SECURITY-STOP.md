# CI snapshot at security stop, 6 October 2026

Group1–2 publication source: `adb6fb422b337bb6b981e99039ad5ce0a6aa45ed`. Snapshot only; pending/running is not passed. Final security-report publication introduces a new SHA whose CI must be inspected separately. No complete final gate/CI verdict is issued.

| Workflow | Run | Job | Status | Conclusion |
|---|---|---|---|---|
| CI | 37505657907 | agent | completed | success |
| CI | 37505657907 | hosted | completed | success |
| CI | 37505657907 | postgres | completed | success |
| CI | 37505657907 | workflows | in_progress | pending |
| CI | 37505657907 | docker | completed | success |
| CI | 37505657907 | supply-chain | completed | failure |
| CI | 37505657907 | verify | in_progress | pending |
| CI | 37505657907 | operation-gates (reconciliation) | completed | success |
| CI | 37505657907 | tofu | completed | success |
| CI | 37505657907 | build | completed | success |
| CI | 37505657907 | ledger | completed | success |
| CI | 37505657907 | platform-postgres | in_progress | pending |
| CI | 37505657907 | policy | completed | success |
| CI | 37505657907 | go | completed | success |
| CI | 37505657907 | generated | completed | success |
| CI | 37505657907 | operation-gates (workflow-intents) | completed | success |
| Native packaged workers | 37505657899 | packaged-worker (amd64, ubuntu-24.04) | completed | success |
| Native packaged workers | 37505657899 | packaged-worker (arm64, ubuntu-24.04-arm) | completed | success |
| Native skipped platforms | 37505657829 | linux-systemd | completed | success |
| Native skipped platforms | 37505657829 | windows-acl | completed | success |

Historical runtimeec18 had20 terminal successes, with native AMD64 and ARM64 each22checks separately. This does not establish repaired LIFE11 transport or paused product/default journeys.

Resume final report CI with `gh run list --branch codex/production-2026-10-02 --commit "$(git rev-parse HEAD)"`, then inspect every returned job/run on that exact SHA. Retain failed/cancelled/skipped states; do not claim CI green until every required run is terminal success.

Failure inspected: supply-chain job112413547642 / run37505657907, Known dependency findings block release;1 unresolved sharp0.35.4 finding GHSA-wq5f-xc86-pv6w. [Disposition](RESULTS-2026-10.md#dependency-stop-sharp-2026-10-06). No final green verdict.
