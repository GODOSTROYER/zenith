# Resume here: wave 8 integration (2026-10-02)

Production continuation now starts at [production/RESUME.md](production/RESUME.md)
from `37be734`, on `codex/production-2026-10-02`. The sections below preserve
historical wave-8 instructions and evidence; do not restart their completed work.

Source checkpoint: `platform/checkpoint-2026-10-01` at `6d1359a`.
Resumed staging: `ws/integrate-w8`, `/Users/saivedanthava/Desktop/zenith`,
on Saivedant Hava's Mac. Read this first, then `IMPLEMENTATION-LEDGER.md`
and `../LIMITATIONS.md`.

## 1. Where things are

| Thing | Where |
|---|---|
| Immutable source checkpoint | `platform/checkpoint-2026-10-01` at `6d1359a` |
| Resumed staging | `ws/integrate-w8` |
| Integration destination | `platform/integration` |
| New publication branch | `codex/wave8-integration-2026-10-02` |
| Previous fully gated integration | `6595294`, waves 1 through 7 |
| Durable program state | `ledger.json`; render with `node scripts/build/ledger.mjs` |
| Current limits | `../LIMITATIONS.md`, control-plane gaps |
| Job briefs | `handoffs/WS-*.md` |
| Historical paused diffs | `paused/ws-*.patch` and Azure resume prompt; all three jobs have now landed |
| Local tools and command logs | `/Users/saivedanthava/.codex/zenith-w8/{tools,logs}` |
| Worker worktrees | `/Users/saivedanthava/.codex/zenith-w8/worktrees/` |

Old `codex-lane` scripts describe another machine. Do not copy their paths or
commit identity. The checkpoint and saved patches remain for historical
comparison; do not apply those patches again to the integrated tree.

## 2. Status

All eight original wave 8 jobs and requested follow-ups are merged into staging.
The three resumed jobs cover teardown review and its approval race, trusted
Azure source storage, and six AWS role-family permissions boundaries. Additional
work integrates GitHub source migration 6, corrects machine transport docs, and
adds trusted OCI migration bindings with finished-instance cleanup.

Independent verification also repaired a dependency lockfile gap, quadratic
password redaction, GitHub callback route classification, long macOS OpenTofu
provider socket paths, a timestamp-order assumption in runner tests, and real
Kubernetes apply/release races and migration patch semantics. CI and package
metadata now require a compatible Node 22 patch; the worker build includes its
SSM JSON imports and has a successful local ARM64 image build with isolated CLI
probes. No Zenith worker or server was started.

Final full gate passed: 15,854 tests passed, 0 failed, 194 skipped across 788
files. Go passed 226 top-level tests plus 539 subtests with 3 Linux-only skips;
OPA passed 213/213. Both fresh local kind suites passed (provider 6/6, release
1/1) and the cluster/kubeconfig were deleted. Integration is
complete at `7bd6798`; all 22 wave 8 rows are integrated. Publication branch:
`codex/wave8-integration-2026-10-02`. Exact commands, prior failures and evidence
are recorded in
`verification/2026-10-02-wave8.md`, its compact JSON and `ledger.json`.

## 3. Remaining work and decisions

No requested implementation workstream remains paused. Remaining acceptance
needs real cloud accounts, Temporal Cloud or production self-hosted Temporal,
live private GitHub access, and a real Postgres server. Local kind evidence does
not establish live-cloud readiness, StatefulSet acceptance or enforced
NetworkPolicy behavior. The default managed Zenith session opener and hosted
substrate are still absent.

Ask the user before selecting audit retention or pruning, using live cloud
accounts, force-pushing or rewriting history. Events, evidence, approvals,
decisions, grants, operations and runner jobs currently have no pruning policy.
OCI migration receipt persistence also has no new retention policy.

AWS boundary migration is stack-first. Apply with default unsuffixed boundary
names; a nonempty bootstrap suffix is size-tested but not propagated through
connection/compiler role selection. The largest tested legacy boundary is
6,136 characters and deploy policy is 5,951, below IAM's 6,144 limit. Recheck
rendered sizes after changing names, partitions or hosted-zone inputs.

## 4. Rules of the program

- Deterministic code owns credentials, policy, approvals, state and execution.
  LLMs only propose. Approvals are human, browser-only, and bound to an immutable
  plan digest. Review refresh must never cancel an already-approved proposal.
- No secret values in code, logs, state, evidence, errors, URLs or tests. Build
  provider-format fake keys at runtime. A previous checkpoint push was refused
  for full fake-key literals; that historical repair required user approval.
  If a new push is refused for a secret, stop and show the user. Never bypass
  protection or rewrite history without the user's decision.
- New author and committer identity is **Saivedant Hava**
  `<saivedant169@gmail.com>`, on this Mac. Preserve historical authors.
  Use `git -c user.name="Saivedant Hava" -c user.email="saivedant169@gmail.com" commit ...`.
  Use clear, organized messages with no em dashes or Co-Authored-By trailer.
- Orchestrator plans, reviews, verifies, merges and keeps the ledger. Delegate
  implementation to `gpt-6.1-sol`, **high** reasoning, one worktree and `ws/<name>`
  branch per workstream. Reuse briefs; workers stay within owned paths and list
  other changes as follow-ups. Resume interrupted workers in the same thread.
- Keep compiler checks serialized on this 8 GB Mac. Workers use touched Vitest
  suites with `--maxWorkers=1`. Before merging, orchestrator independently runs
  typecheck, lint, affected suites, real OpenTofu and Go checks; policy changes
  also require OPA build/check. Kubernetes and managed Zenith changes require
  real local kind checks. Never merge on worker reports alone.
- Merge workers into `ws/integrate-w8`, pass the full gate and fresh kind suites,
  then merge into `platform/integration` and publish a new GitHub branch. Keep
  still-open limitations and remove only verified closed gaps. Edit `ledger.json`
  and render its Markdown.
- Do not start or restart a Zenith server unless the user explicitly requests
  it. Disposable test services and kind clusters are authorized for these gates.
  Delete every cluster created. Use its dedicated kubeconfig only.
- LocalStack remains on hold. Do not touch unrelated containers or services.
  Nothing is labelled live-verified without live cloud acceptance.

## 5. Verification commands: full gate

Verified local tools: Node **22.23.3**, OpenTofu **1.12.5**, OPA **1.19.1**, Go
**1.27.1** with `GOTOOLCHAIN=local`, Docker **29.1.3**, kind **0.33.0**, kubectl
**1.34.1**. Node 22.23.3 satisfies the requested 22.x range and locked jsdom's
newer patch requirement. Set a 4 GB Node heap for the whole-tree typecheck. The full suite uses one
worker on this 8 GB Mac; three workers caused heavy swap and setup timeouts.
Test coverage and functional/security deadlines are unchanged.

```bash
export PATH="/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:/Users/saivedanthava/.codex/zenith-w8/tools/go/bin:/Users/saivedanthava/.codex/zenith-w8/tools:$PATH"
export GOTOOLCHAIN=local
export NODE_OPTIONS=--max-old-space-size=4096
export ZENITH_TOFU_BIN=/Users/saivedanthava/.codex/zenith-w8/tools/tofu
export ZENITH_OPA_BIN=/Users/saivedanthava/.codex/zenith-w8/tools/opa
export ZENITH_TEST_TOFU="$ZENITH_TOFU_BIN"
export ZENITH_TEST_TOFU_NETWORK=1
export TF_REGISTRY_CLIENT_TIMEOUT=60
export ZENITH_TOFU_PLUGIN_CACHE=/Users/saivedanthava/.codex/zenith-w8/tofu-plugin-cache
export TF_PLUGIN_CACHE_DIR="$ZENITH_TOFU_PLUGIN_CACHE"
export ZENITH_COMPOSE_TEMPORAL_MODE=time-skipping
export ZENITH_TEST_TEMPORAL_DOWNLOAD=1
export ZENITH_SEC_TEMPORAL=1

npm ci
npx tsc --noEmit
npx eslint .
(cd go && test -z "$(gofmt -l .)" && go vet ./... && go test ./...)
npm run policy:check
npm run platform:emit-sql -- --check
npx tsx scripts/docs/capability-matrix.ts --strict
npx tsx deploy/aws/tools/generate-tofu-policies.ts --check
npx vitest run --maxWorkers=1
node scripts/build/ledger.mjs --check
```

Prefetch the official SDK Temporal test server before the full suite if its
first download is cold. Local logs identify the binary used. Policy check
builds the bundle, runs Rego tests and verifies generated bytes.

## 6. Fresh disposable kind gate

Both suites are required after the full gate. Docker must be running. This
verified BusyBox 1.37 ARM64 manifest contains `/bin/sh`; the test configures a
non-root workload.

```bash
export KUBECONFIG="$PWD/.kind-kubeconfig"
kind create cluster --name zenith-w8-final --wait 120s --kubeconfig "$KUBECONFIG"
test "$(kubectl config current-context)" = kind-zenith-w8-final
export ZENITH_TEST_KIND_RELEASE_IMAGE=busybox@sha256:d82c2ab94640ded77cf76514ce6a84870761105058a4a9e51b05a8a79be97a6c
docker pull "$ZENITH_TEST_KIND_RELEASE_IMAGE"
kind load docker-image "$ZENITH_TEST_KIND_RELEASE_IMAGE" --name zenith-w8-final
ZENITH_TEST_KIND=1 npx vitest run --maxWorkers=1 tests/providers/kubernetes/kind.test.ts
ZENITH_TEST_KIND=1 npx vitest run --maxWorkers=1 tests/providers/kubernetes/release-kind.test.ts
kind delete cluster --name zenith-w8-final
rm .kind-kubeconfig
```

Keep the kubeconfig out of Git. Cleanup is required on success and failure.
Record these results as **local kind cluster** evidence, never live-cloud evidence.
