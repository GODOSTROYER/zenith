# WS-DNS-GUARDS-CLOUDS - DNS deletion target-ownership guards for GCP, Azure and OCI

Workstream: WS-DNS-GUARDS-CLOUDS (orchestrator brief, wave 8) - Branch ws/dns-guards-clouds - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-dns-guards-clouds
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
inspectDeployDeletions (src/lib/execution/plan.ts) only supports AWS Route 53 ownership (assessRecordDeletion); every non-AWS DNS delete/replace is refused, and approval cannot override it.

## Do
1. Per provider, an ownership assessment equivalent to AWS: read the live record set through the broker session, confirm its target is a resource Zenith manages
   in this environment (tags/labels/ids), and return safe/unsafe with a secret-free reason. GCP Cloud DNS, Azure DNS, OCI DNS (OCI via runner oci.http read rules).
2. Dispatch in inspectDeployDeletions by node.provider/nativeType; keep refusal for anything unmapped.
3. Tests: owned target allowed (still needs human approval), foreign target refused without leaking it, unreadable fails closed.

## Owned paths
src/lib/execution/plan.ts (inspectDeployDeletions dispatch only) , src/lib/providers/{gcp,azure,oci}/** (dns ownership helpers) , src/lib/providers/oci/allowlist.ts + go testdata (read rules only) , tests/execution/deletion-guards*.test.ts , tests/providers/{gcp,azure,oci}/** , docs/platform/operations/TEARDOWN.md , docs/LIMITATIONS.md
Anything outside: list it in your final report as an orchestrator follow-up instead of editing it.

## Rules that always apply
Deterministic code owns credentials, policy, approvals, state and execution; models only propose. Approvals are human, browser-only,
bound to an immutable plan digest. No secret value in logs, state, evidence, errors, URLs or test output. Nothing is labelled live-verified.
Update docs/LIMITATIONS.md: remove or narrow the gap line you closed, and keep any remainder honest.

## Verification
- `npx tsc --noEmit` (at most twice) ; `npx eslint <touched paths>`
- `npx vitest run --maxWorkers=1 <the suites you touched or that cover the code you changed>`
- `npx vitest run --maxWorkers=1 tests/docs` if you changed any doc or a claim a docs guard checks
- Anything your sandbox cannot run (tofu, opa, go, temporal, Docker, live cloud): write the test anyway, gate it the way the repo
  already gates such tests, and SAY it was not run; the orchestrator runs it outside the sandbox.
