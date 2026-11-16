# ECS replica repair

Written against branch `ws/prod-ecs-replica-repair`, based on `codex/production-2026-10-02` at `b46fb8a` (2026-10-03).

This adapter restores one existing managed AWS Fargate ECS service's desired
replica count from its deployed revision. It supports only canonical
`reapply_desired_state` proposals for a changed `replicas` field, with a desired
count of 1 through 20 and a digest-pinned image artifact. It refuses missing
services, autoscaled services, unknown observations, other fields, legacy incident
recipes, external ownership and other resource types or providers.
Execution supports commercial AWS accounts and regions only. AWS GovCloud and
China partitions are outside this recipe.

The initial execution claim is authorized separately for read-only planning and
returns an `infrastructure.plan` bearer. It retains `drift.repair` as the operation
capability. Planning uses the existing full environment and state backend; it
does not prune the graph or run a targeted reapply.

Before planning, a real SDK read must prove the exact service ARN, account,
region, ownership tags, creation time, task definition and desired count.
A normal managed row need not contain an ARN. In that case, a successful complete
Resource Groups Tagging API lookup must return exactly one service carrying
all five managed/workspace/environment/project/resource tags. Missing results,
pagination, ambiguity, denied access or a foreign account/region refuse the
repair. The subsequent service read repeats ownership checks. Stored IDs are
only hints, and later lookups must match the original immutable binding.
A successful complete Application Auto Scaling response must prove that no
scalable target controls that service's desired count. Permission denial,
missing results and pagination remain unconfirmed and refuse the repair.

The resulting versioned binding is stored once under a deterministic evidence
ID. Repeated activity attempts receive and compare the original row. Its digest
is part of the workspace configuration and therefore the reviewed OpenTofu plan
digest. A revision, graph, spec, connection, backend or service identity change
requires a new proposal; it cannot silently rematerialize an approved operation.

Initial planning, final planning and exact saved-plan application inspect the
raw plan. They permit exactly one owned ECS service update changing only
`desired_count`. Other resource writes, replacements, task/image changes,
unknown or sensitive update values and output changes are refused. Raw plans
and credentials remain inside the worker. Evidence retains only the bounded
binding, digests and existing safe plan projection.

Current broker policy must require human review of this concrete plan even when
workspace policy otherwise allows automation. Existing browser-session proof,
exact digest, current approval round, role/count/separation rules and environment
fences remain mandatory. Mutation grants include the plan and binding digests;
unknown policy restrictions are refused rather than ignored.

The deploy session uses the existing broad environment deploy IAM role. Its
permissions are not limited to the `desired_count` property. The one-field
limit depends on the adapter's software guards, immutable target binding and
exact saved-plan checks. Independent live IAM permission validation has not
been established by the local checks below.

Apply uses the existing single-attempt OpenTofu activity. Execution regenerates
a digest-matching full-environment plan, validates its raw replica-only guard,
then applies that exact newly generated saved file. It does not import a
retained approval-time binary. Original-byte cross-worker plan handoff remains
incomplete (PROD-DUR-05). Success requires a subsequent real read of the same
owned service and one explicit replica check.
There is no zero-probe success path, native UpdateService fallback, rebuild,
retry or compensation. Lost responses, lost fences, unavailable read authority
and unconfirmed readback preserve an uncertain outcome requiring inspection.
Matching readback must also produce the exact durable, non-simulated verification
receipt. Exhausted evidence appends or mismatched receipts keep the outcome
uncertain. Cancellation after an apply attempt is uncertain for this versioned
recipe; cancellation before mutation and legacy workflow histories retain their
existing classification.

The pure `supportsDeclarativeRepair(node, finding)` admission contract advertises
this recipe without inventing a native driver operation. It grants no authority;
the worker repeats the same admission and all live ownership and plan checks.

The read contract follows AWS's [DescribeScalableTargets API](https://docs.aws.amazon.com/autoscaling/application/APIReference/API_DescribeScalableTargets.html)
and [JavaScript v3 command](https://docs.aws.amazon.com/goto/SdkForJavaScriptV3/application-autoscaling-2016-02-06/DescribeScalableTargets).
The Application Auto Scaling SDK pin is `3.1121.0`, matching the ECS
sibling's exact version and dependency ranges in the npm registry metadata
inspected on 2026-10-02. The lock update added only this package and its root
declaration, with no existing version or transitive dependency changes. A fresh
private installation on macOS ARM64 using Node `22.23.3` and npm `10.9.9` passed
with 783 installed package nodes from 927 locked nodes. The mandatory complete
locked security audit passed with zero known findings and no exceptions.
These results do not establish Linux installation or runtime compatibility.

Root independently verified the frozen 26-file candidate based on `fbfa456`
before its fast-forward to `b46fb8a`. All 26 candidate files retained identical
bytes across that integration. Those checks recorded:

- 595 tests passed, with zero failures and zero skips. This included scripted
  AWS SDK and OpenTofu adapter contracts, actual isolated local Temporal
  orchestration/replay with scripted activities, and five tests using real
  OpenTofu. Scripted cloud activities do not prove provider mutations.
- Fresh PostgreSQL verification recorded 1344 passed, zero failed and zero
  skipped, satisfying all 45 mandatory groups. Each of the six PostgreSQL
  grant behaviors passed independently under its exact backend ancestry.
  The grant file ran 13 cases: six on PostgreSQL, six on PGlite and one on
  memory. These exercise genuine SQL ledger, signer, browser approval and
  broker authority with synthetic plans and policy facts. All 12 schema-2
  evidence bindings passed separate required-execution validation; the owned
  test database was deleted and its absence verified.
- Full TypeScript and lint checks passed. Go reported 226 top-level tests and
  539 subtests, zero failures and three Linux-only tests skipped on macOS.
- A fresh disposable local kind cluster passed six provider checks and one
  release check. The owned cluster, containers and kubeconfig were removed,
  with cleanup verified. This does not establish live AWS repair acceptance.
- The complete locked security audit reported zero known findings and zero
  exceptions.

Root subsequently verified the combined 28-file candidate at `b46fb8a`, before
this final guide clarification. The combined run recorded 1232 passed, zero
failed and zero skipped; full TypeScript and affected lint checks passed,
including five actual network OpenTofu checks. Go reported 226 top-level tests
and 539 subtests, zero failures and three Linux-only skips on macOS. A fresh
PostgreSQL 16.15 run recorded 1422 passed, zero failed and zero skipped, all 45
required groups and all 12 schema-2 evidence bindings with observed exit zero
and separate `--require-execution` validation. Each of the six genuine
PostgreSQL grant behaviors passed independently, and the grant file ran all 13
SQL and memory cases. The owned database was deleted and its absence verified.
A fresh local kind run passed six provider checks and one release check with
zero failures and zero skips; cluster, containers and kubeconfig removal were
verified. This final clarification changes only the guide; the other 27
candidate files remain byte-identical.

Earlier failed compiler or assertion attempts established no passing gate
evidence. Their corrections preceded the successful runs recorded above; the
595-test and 1344-test PostgreSQL results remain historical frozen-26 evidence,
separate from the combined 1232-test and 1422-test PostgreSQL results. These
local results do not establish updated Linux image compatibility, independent
live IAM permission validation or a live AWS write.

No live AWS repair is authorized or proven. This is a bounded recipe, not a
durable outbox, a recovery epoch or operator continuation. Uncertain outcomes
remain blocked pending inspection and new authorization; a receipt or approval
cannot authorize a blind retry. A cloud operator outside Zenith can still race
the final ownership read; the environment fence coordinates Zenith writers,
while provider state locking and exact saved-plan checks constrain the apply.
