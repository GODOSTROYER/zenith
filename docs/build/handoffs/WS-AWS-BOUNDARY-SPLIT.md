# WS-AWS-BOUNDARY-SPLIT - one permissions boundary per AWS role family, so every Zenith role can do its job

Workstream: WS-AWS-BOUNDARY-SPLIT (orchestrator brief, wave 8) - Branch ws/aws-boundary-split - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-aws-boundary-split
Base: ws/integrate-w6 (staging: WS-AWS-BUILD-BOUNDARY and WS-AWS-BOUNDARY-MORE merged - read both commits first)

## Situation
Every role Zenith creates carries the single managed policy `ZenithWorkloadBoundary` (deploy/aws/zenith-connection.cfn.yaml, mirrored in
deploy/aws/tofu-module). Build, scheduled-job and EC2-SSM grants were added as principal-conditioned statements and the policy was compacted;
the GovCloud rendering is now 5,983 of IAM's 6,144-character managed-policy limit. WS-AWS-BOUNDARY-MORE's coverage sweep found more role
families whose role policies the boundary still blocks (live AWS would return AccessDenied): identity roles (multipart upload, log reads,
database and cache grants) and parts of the EKS cluster/node role policies. One boundary cannot hold all families.

## Do
1. Replace the single boundary with one managed boundary per role family (e.g. app/identity workloads, build, machine (EC2), scheduler,
   EKS cluster, EKS node; merge families where they are genuinely the same). Each boundary allows only what that family's driver role
   policies need, scoped as narrowly as today, and keeps the principal conditions (a role of one family must not gain another's rights).
2. Drivers select their family's boundary ARN (one exported mapping in src/lib/credentials/aws/naming.ts or a sibling; no string literals
   scattered in drivers). The deploy role's IAM statements (iam:CreateRole / PutRolePermissionsBoundary / etc.) must still REQUIRE a Zenith
   boundary: condition `iam:PermissionsBoundary` in the exact set of family boundary ARNs; the deploy role still cannot create, edit, detach
   or delete any boundary policy. Keep "Do not edit; Zenith cannot" true for each.
3. Mirror CFN <-> tofu-module exactly; regenerate templates (`npx tsx deploy/aws/tools/generate-tofu-policies.ts --write`); a size guard
   that renders every boundary for aws / aws-cn / aws-us-gov and fails above 6,144 characters with a margin (say 5,800).
4. Coverage test with the existing local evaluator (tests/credentials/workload-boundary.ts): for EVERY AWS driver that creates a role, every
   action/resource in its role policy is allowed by its family boundary for its principal, and denied for every other family's principal.
   This must now pass for identity and EKS too. List anything you deliberately leave blocked, with the reason.
5. Migration note: existing connections have the single boundary; document the update path (stack update creates the family policies;
   roles move to their family boundary on next apply) in deploy/aws/README.md and docs/platform/operations/AWS-SETUP.md.

## Owned paths
deploy/aws/** , src/lib/credentials/aws/** , src/lib/providers/aws/drivers/** (boundary selection + role naming only) , tests/credentials/** ,
tests/providers/aws/** , docs/platform/operations/AWS-SETUP.md , docs/LIMITATIONS.md , docs/platform/DRIVER-CONVENTIONS.md (boundary section).
Anything outside: list it in your final report as an orchestrator follow-up instead of editing it.

## Rules that always apply
Deterministic code owns credentials, policy, approvals, state and execution; models only propose. No secret value anywhere. Nothing is
labelled live-verified. Never widen a grant to make a test pass without saying exactly what and why.

## Verification
- `npx tsc --noEmit` (at most twice) ; `npx eslint <touched paths>`
- `npx vitest run --maxWorkers=1 tests/credentials tests/providers/aws`
- `npx tsx deploy/aws/tools/generate-tofu-policies.ts --check`
- Real `tofu validate` of the module and the AWS e2e compile tests are network-gated; say if not run (the orchestrator runs them).
