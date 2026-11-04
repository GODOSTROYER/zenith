# WS-AWS-EKS-READS continuation — 2026-10-01

Branch `ws/aws-eks-reads`, starting/final HEAD
`ec3176f316de63a5e98656a57b43563e027cf9af`. All changes are in the working
tree for the orchestrator to review and commit. No Git metadata, dependencies,
fixed contracts or files outside the owned paths were edited.

## Current implementation

- `eks-cluster.ts`: broker-bound `DescribeCluster`, bounded/paginated
  `ListNodegroups`/`DescribeNodegroup`, and fallback `ListTagsForResource` reads.
  Exact names/ARNs and current tenant tags are checked before retaining data.
  Missing identifiers resolve through the existing tenant-scoped tagging index;
  an empty, ambiguous or incomplete index remains unknown because it is
  eventually consistent. Unrelated/mismatched nodegroups cannot produce a
  healthy result. SDK error bodies and health issue messages are not retained.
- Added desired/observed attributes for cluster version, endpoint access/CIDRs,
  logging, encryption/KMS key, access configuration, nodegroup count, scaling,
  version and instance types. Unread fields remain unknown. Secondary nodegroup
  read failures preserve successfully read cluster configuration.
- Verification compares the desired attributes and checks an active cluster,
  HTTPS endpoint, a regional EKS OIDC issuer, and supplied nodegroup runtime
  health. Missing, simulated or mismatched runtime/observation evidence cannot
  pass. The existing compilation decisions and emitted resources are preserved.
- Runtime reports EKS cluster/group status and issue presence plus configured
  min/desired/max totals. It does not report Kubernetes Ready/running nodes,
  private endpoint reachability, launch-template disk/IMDS compliance, or add-on
  health. Those require other read surfaces. Discovery remains unimplemented.
- Session and bootstrap observe policies now explicitly name the four EKS read
  actions in their existing account/name-scoped statement. Existing EKS read
  wildcards are retained for compatibility; this adds no broader ARN scopes or
  write permissions. Regeneration changes only `observe.json.tftpl`.
- `eks-cluster.test.ts` preserves the compiler coverage and updates the old
  compile-only capability assertion. `eks-reads.test.ts` adds 101 mocked SDK
  contracts; `eks-policy.test.ts` adds 4 static IAM contracts across partitions.
  All capability evidence remains `contract`, with no live AWS acceptance.

AWS references used to verify resource-level read authorization and supported
OIDC issuer hostnames:
- https://docs.aws.amazon.com/service-authorization/latest/reference/list_eks.html
- https://docs.aws.amazon.com/general/latest/gr/eks.html
- https://docs.amazonaws.cn/en_us/general/latest/gr/endpoints-Beijing.html

## Verification actually executed

`npx vitest run --maxWorkers=1 tests/providers/aws/drivers/eks tests/credentials`

Three runs, in order (passed / failed / skipped): `343 / 0 / 1`,
`354 / 0 / 1`, **`356 / 0 / 1`**. Final: 11 passing files; EKS compiler 37,
SDK reads 101, IAM scopes 4, credentials 214 passing plus 1 skipped.
The skip is the existing `ZENITH_TEST_TOFU`-gated bootstrap init/validate/test;
the gate was not enabled. No live AWS, network acceptance, WSL, Docker, OPA,
Go or Temporal checks were run. Existing OIDC failure-path log lines are
expected fixture output and are not test failures.

`npx eslint src/lib/providers/aws/drivers/eks tests/providers/aws/drivers/eks src/lib/credentials/aws/session-policy.ts deploy/aws/tools/generate-tofu-policies.ts`

Three runs: `1 error / 0 warnings` (unused test import, fixed), then
`0 errors / 0 warnings`, then **`0 errors / 0 warnings`**.
YAML and generated policy syntax/permissions are checked by the bootstrap and
EKS policy contract suites above, rather than by ESLint.

`npx tsc --noEmit`

Two whole-repo runs: first `3 errors` (two test typing errors fixed; one
pre-existing out-of-scope platform error), final **`1 error`**:

```text
src/lib/platform/credentials.ts(161,54): error TS2345:
Argument of type 'CredentialPurpose' is not assignable to parameter of type
'"observe" | "deploy"'. Type '"secret.write"' is not assignable to that type.
```

`npx tsx deploy/aws/tools/generate-tofu-policies.ts --write`

Executed twice; both exited 0 and generated 12 templates. Only the observe
template's content changed. The final focused suites verify all templates are
in sync with CloudFormation.

Intermediate session-policy size diagnostic (before listing all four actions):

```powershell
npx tsx -e 'import {sessionPolicyFor} from "./src/lib/credentials/aws/session-policy.ts"; for(const partition of ["aws","aws-us-gov"] as const) { console.log(partition,JSON.stringify(sessionPolicyFor("infrastructure.observe",{accountId:"123456789012",region:"us-gov-west-1",partition})).length); }'
```

Exited 0; compact sizes were 1620 and 1662. The final policy size is checked
against the 2048-character ceiling in the passing credential/EKS policy tests.

`git diff --check`: clean on all three runs (0 whitespace errors).

## Required orchestrator follow-ups outside ownership

1. **Whole-repo typecheck blocker:** `src/lib/platform/credentials.ts:150`.
   AWS requests already delegate to the AWS broker above this branch. Before
   the existing non-AWS purpose/capability check, explicitly refuse the
   unsupported secret writer purpose:

   ```ts
   if (req.purpose === "secret.write") return deny("purpose_capability_mismatch", "Secret writer sessions are supported only for AWS connections.");
   ```

   This narrows `req.purpose` to the session factories' existing
   `"observe" | "deploy"` contract at line 161 without casting or accidentally
   treating a non-AWS secret writer as an observe session. Both the offending
   call and the absence of this guard were confirmed in `git show HEAD`;
   `git diff -- src/lib/platform/credentials.ts` is empty. This job did not
   edit that file. Re-run typecheck and platform credential tests after fixing.
2. `src/lib/providers/aws/drivers/index.ts:23`: replace the EKS native-schema
   description `Private EKS cluster and managed node group (compile only)`
   with `Private EKS cluster and managed node group with EKS SDK reads`.
   Registration and runtime wiring already include this same driver object.
3. Regenerate `docs/platform/CAPABILITY-MATRIX.md` (current EKS row at line 61)
   with `npx tsx scripts/docs/capability-matrix.ts` during integration so it
   shows contract evidence for observe/runtime/verify. This generated document
   is outside this job's ownership and was not modified.

No changes to the handoff's compiler/security decisions or fixed contracts.
The supplied continuation mentioned existing `expectedAttributes`, but the
actual EKS driver at HEAD had none; this continuation adds that projection in
the existing driver interface. Compile-only EKS limits in the historical note
below are superseded by this continuation.

---

# Historical WS-AWS-MORE integration handoff

Branch `ws/aws-more`; starting HEAD `4c7a652`. All work is uncommitted, as requested.
The starting checkout had none of the three new drivers or their tests.

## Files

Modified:
- `src/lib/providers/aws/drivers/index.ts`: drivers/native schemas registered; three explicit lifecycle gaps removed.
- `src/lib/providers/aws/drivers/data/iam-grants.ts`: additive SNS publish and exact KMS-key grants, including native SNS target addresses.

Added:
- `src/lib/providers/aws/drivers/messaging/support.ts`: allowlisted, redacted spec validation and graph-neighbour checks.
- `src/lib/providers/aws/drivers/messaging/sns-topic.ts`: encrypted topics; SQS subscriptions/delivery policies; honest tag-index observation.
- `src/lib/providers/aws/drivers/storage/ebs-volume.ts`: encrypted gp3 volumes; explicit attachments/AZ preconditions/destruction guards; EC2 reads and verification.
- `src/lib/providers/aws/drivers/eks/eks-cluster.ts`: secure cluster/node-group/add-on compilation and Kubernetes session locals.
- `src/lib/providers/aws/drivers/eks/INTEGRATION.md`: this handoff.
- `tests/providers/aws/drivers/messaging/sns-topic.test.ts`
- `tests/providers/aws/drivers/messaging/assemble.test.ts`
- `tests/providers/aws/drivers/storage/ebs-volume.test.ts`
- `tests/providers/aws/drivers/eks/eks-cluster.test.ts`

## Verification executed

`npx vitest run --maxWorkers=2 tests/providers/aws/drivers/messaging tests/providers/aws/drivers/storage tests/providers/aws/drivers/eks tests/providers/aws/drivers/data/iam-role.test.ts`

Chronological runs (passed / failed / skipped): `180 / 5 / 1`, `186 / 0 / 1`, `189 / 0 / 1`, `191 / 0 / 1`.
The first assembly failures were fixed by completing the VPC fixture. The final
run passed all five files: SNS 43, EBS 42, EKS 37, assembly 8, existing IAM 61.

`npx vitest run --maxWorkers=2 tests/providers/aws/drivers/messaging/assemble.test.ts`

`5 / 1 / 1`. Its incorrect assertion about the assembler's sorted address map
was fixed to check the driver's primary fragment address and map membership.

PowerShell equivalent of the requested network gate:

```powershell
$env:ZENITH_TEST_TOFU_NETWORK = '1'; npx vitest run --maxWorkers=2 tests/providers/aws/drivers/messaging tests/providers/aws/drivers/storage tests/providers/aws/drivers/eks
```

`127 / 1 / 0`. The failure is the explicit binary-availability assertion:
OpenTofu cannot execute in this sandbox. `tofu init` / `tofu validate` never ran.
The earlier direct `tofu version` probe also could not launch the WinGet executable
("No application is associated with the specified file for this operation").
The gate is intentionally not converted to a success or silently skipped when
explicitly enabled. No live AWS, WSL or Docker checks were run.

`npx tsc --noEmit`: three whole-repo runs. First: 2 errors (mock call tuple
typing); second: 1 error (missing fixture baseDomain); final: **0 errors**.
All failures were corrected; no production contract or test expectation was weakened.

`npx eslint src/lib/providers/aws tests/providers/aws`: three runs, each
**0 errors / 0 warnings**.

`git diff --check`: clean on each run.

The full AWS vitest directory was not run, following the shared-machine override
to run only owned/touched suites with two workers.

## Integration changes outside this job's ownership

1. `tests/providers/aws/drivers/contract.test.ts:12-13`: extend the combined
   fixture with a pubsub/SNS node, an EBS node (`sizeGb` plus AZ), and an EKS node
   (`version` plus two private subnet dependencies). Its lookups at lines 47
   and 63 currently find none of these. At line 62, run the SDK observation
   cases only for drivers that declare `capabilities.observe`; EKS explicitly
   has no observer, so the unconditional `driver.observe!` call is invalid.
   Preserve the existing capability/function/evidence assertions.

2. `src/lib/providers/aws/drivers/shared/security-group.ts:52,80`: accept
   `kubernetes_cluster`, and native nodes whose `nativeType` is exactly
   `aws:eks_cluster`, as security-group owners. Use the same node-aware predicate
   in `network/firewall-compile.ts:52`. Then replace the resource/expose pair in
   `eks/eks-cluster.ts`'s `addClusterSecurityGroup` adapter with the shared
   `addSecurityGroup` helper (`egress: "none"`); preserve its separate self/HTTPS
   rules. The current adapter already uses shared names/labels/refs/tags and
   creates exactly one declared SG without falsifying the node kind.

3. `deploy/aws/zenith-connection.cfn.yaml` and its generated tofu policies need
   a separate bootstrap workstream before real apply. Specific wiring points:
   - `WorkloadBoundary` at line 225: SNS publish, SNS KMS ViaService, and the
     cluster/node service permissions. Its current ECR scope only permits
     Zenith repositories, while EKS nodes/add-ons pull AWS ECR images.
   - EC2 creation/tag-on-create/modify statements at lines 425/443/463: scoped
     EBS CreateVolume, ModifyVolume, DeleteVolume, AttachVolume and DetachVolume.
   - Add scoped SNS and EKS lifecycle/add-on/node-group actions and the KMS
     creation/rotation/grant/key-read actions needed by the emitted resources;
     current policies do not contain SNS/EKS lifecycle permissions or general
     KMS lifecycle permissions.
   - `IamAttachOnlyKnownPolicies` at line 999: AmazonEKSClusterPolicy,
     AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy and
     AmazonEC2ContainerRegistryReadOnly.
   - `IamPassRoleToWorkloadServices` at line 1034 and service-linked roles at
     line 1041: EKS/node-group service principals.
   Keep request/resource tags, account/environment scoping and explicit
   action lists; this note is not authorization to introduce broad policies.

4. The fixed `expectedGrantActions` contract in `data/iam-grants.ts:292` lacks
   graph metadata. It can summarize portable `pubsub/...` grants, but cannot
   identify the service of an arbitrary `provider_native/...` address.
   Compilation of native SNS grants now works; IAM's existing observer leaves
   the desired action summary unset for these targets rather than guessing.
   Resolving this needs a graph-aware desired-action projection in the IAM
   workstream, not a blanket grant for all native resources.

## Honest limits / decisions

- No installed SNS or EKS SDK clients, and dependency changes were forbidden.
  SNS uses only the eventually-consistent tagging index; unread topic encryption
  and subscriptions are unknown, and verification cannot claim they passed.
  EKS declares compile-only capability/evidence. All evidence remains contract.
- SQS subscriptions name graph queue addresses in `subscriptions`, or queue
  dependencies on the topic node. Queue policies require managed queues; two
  topics claiming the same queue policy fail closed in workspace assembly.
  Aggregating multiple topics/existing policy statements needs a queue-owned
  policy compiler with graph enumeration, outside the fixed CompileContext.
- EBS attachments require a managed graph-named EC2 instance. The existing EC2
  driver selects its first sorted private subnet, which the EBS driver reuses.
  Literal/subnet AZ disagreement fails a tofu lifecycle precondition. Both
  volume deletion and detachment are protected for deny/approval.
- EBS verifies attachment count/device, but its target check remains unknown:
  DriverContext has no graph-address-to-instance-ID resolver. It never labels
  an attachment to an unverified instance as matching.
- EKS uses Pod Identity (per the handoff's IRSA/Pod Identity choice). No blanket
  pod role or cluster-creator administrator is created. Explicit access entries
  and pod associations are required for their respective users/workloads.
  Private nodes require NAT or suitable AWS endpoints. Public API access is
  optional and requires canonical IPv4 CIDRs of /8 or narrower; IPv6 public
  endpoint configuration and ARM node shapes are refused.
- Kubernetes name/endpoint/server/CA/OIDC locals are published without tokens.
  Constructing/storing a Kubernetes provider connection remains its owner's job.
- The shared SG adapter and reduced read capabilities are the material
  deviations imposed by owned-path/dependency constraints. No previous driver
  decisions were undone, and no files owned by WS-DRIVER-FIX were edited.
