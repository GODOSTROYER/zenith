# AWS readiness invocation source handoff, 2026-10-04

This source packet connects the reviewed AWS bootstrap inspector to the default
execution observation composition. It advances PROD-LIFE-03 without closing
live IAM authorization, the complete environment inventory, or the production
acceptance program. The author ran no imports, tests, compiler, lint, dependency
installation, services, database, Docker, cloud calls or commits. Root owns
independent integration and runtime decisions; C owns independent source review.

The worktree is
`/Users/saivedanthava/.codex/zenith-production/worktrees/aws-preflight-session-20261004`,
branch `ws/prod-aws-preflight-session-20261004`, based on
`b38ef37c1c319beb730ed7ca41c28ace2682c489`. The immutable baseline receipt and
separate authorized caller preimage are under
`/Users/saivedanthava/.codex/zenith-production/logs/aws-preflight-session-20261004/revision1`.
The final freeze there binds the exact changed paths, before and after copies,
incremental patch, unchanged outside paths and native case contract.

The dependency inspector is the accepted R2 implementation in
`src/lib/credentials/aws/bootstrap-preflight.ts`, SHA256
`02d0e43f78857d8d5d5c63c4d40de56bf858ab8c5c1d819ef0d2c1c4764430a7`.
Its SDK literal is `PermissionsBoundaryPolicy`. This packet changes neither the
inspector, its tests, the CloudFormation template nor the generated policies.

## Default caller and authority

The existing `composeExecutionActivities` observation wrapper runs the original
`observeEnvironment` activity first. A separate supplemental read then reloads
the operation and selected connection, obtains its recorded native environment
fence, and requests a fresh 60-second `infrastructure.observe` worker grant
through the existing capability broker. The original drift and unknown counts
are returned unchanged. Existing Temporal commands, activity input and result
types, generic `withProviderSession`, planning, deploy, secret and reconcile
sessions remain unchanged. No migration exception or write admission is added.

The inspector service accepts only the registered credential owner, connection
id and grant claims. It takes no caller client, credentials, configuration,
inventory, SQL handle, registration callback or authorization proof. Registration
is internal to the existing platform credential composition and requires a
genuine, still-open PostgreSQL handle from the existing opener. A fabricated
driver or kind label cannot register. The owner is bound to original methods
and identity, and the credential callback must remain the exact registered
method across awaits. The captured original callback is invoked directly.

The native checks require schema13, exact workspace/project/environment and
proposal digest, a live running canonical workflow claim, the recorded pair of
environment scope and fence, a live native worker lease naming the same
operation, and the exact live, unconsumed, unrevoked worker observe grant row.
The current verified AWS connection must be the exact connection in the owning
native `reconcile_state` workspace/project/environment/provider/region mapping.
Unknown owners, PGlite, closed or replaced methods, missing mappings, unrelated
same-workspace connections, terminal or uncertain operations, stale claims,
foreign grants and lost fences refuse inspector IO.

The opener records membership only after successful driver creation and
migration, invalidates it when close starts, and retains the private method
registry across module reload alongside the existing process-wide pool.
Its only new export is a membership predicate. This is a trusted process
composition check, not isolation against arbitrary hostile code executing in
the same Node process and inspecting global symbols or monkey-patching modules.
Existing session and connection verification contracts keep their prior behavior.

## Inventory and honest outcomes

Every retained native environment row, including deleted, external, referenced,
unknown and compiler parent rows, and every latest overall observation are
captured. Known explicit IAM roles require exact tenant/project/environment,
managed ownership, AWS provider, region, supported status, matching address,
fresh actual IAM provenance and a noncontradictory observed ARN. Unknown,
simulated, errored, stale, deleted or contradictory role rows remain counted
as unresolved. No older success is substituted, missing ARN guessed, or absent
role inferred. The accepted inspector independently checks current cloud role
identity, tags, account, family and attached boundary.

All captured operation source, connection mapping, full desired rows and latest
observations are compared again inside the session callback and after readback.
Removal, addition, replacement, revocation and source changes refuse a positive
readiness result. No raw source, proposal, observation, policy document, ARN,
credential or SDK exception text leaves the helper or enters its evidence.
The fixed summary carries only codes, family statuses, counts, legacy-policy
status, `roleCoverage: incomplete`, `authorization: unverified` and
`migration: not_performed`. A compatible bounded read becomes `incomplete`;
conflict, unavailable, missing-stack and migration-required statuses remain
explicit. No result permits or clears a mutation.

The native capture is bounded to 1,000 retained rows and 32 explicit role rows.
The existing inspector bounds documents, reads at most 51 SDK commands and
uses its shared 30-second abort signal. The new service also refuses admission
or result persistence after its 30-second native window. The supplemental
caller stops waiting after 35 seconds. Existing federation and SQL transports
retain their current cancellation behavior; an outstanding transport may settle
later, but a late callback cannot begin inspector IO or persist a positive
readiness result. Unavailable evidence uses a fresh native owning AWS scope;
failure to record that diagnostic is logged with fixed text and preserves the
original observation result.

Explicit IAM rows cannot establish coverage of compiler-created app ECS/Lambda/
VPC-flow roles, CodeBuild roles, EC2 roles, scheduler roles or EKS cluster/node
roles. Coverage therefore remains incomplete even with an empty explicit-role
inventory or successful reads of every listed role. The existing IAM driver
also uses Resource Groups Tagging `GetResources` for missing role discovery;
the [AWS API reference](https://docs.aws.amazon.com/resourcegroupstagging/latest/APIReference/)
states that IAM users and roles are unsupported. This packet does not call
that discovery path or treat an empty tagging response as true absence.

## Required independent execution and outside ownership

The native case contract supplies exact names for the suites
`opened platform handle ownership [postgres]` and
`native AWS bootstrap readiness admission [postgres]`. Required flags are
`ZENITH_TEST_OPENED_HANDLE_REQUIRED=1` and
`ZENITH_TEST_AWS_PREFLIGHT_REQUIRED=1`. Both guards fail before pool creation
when the owned PostgreSQL URL is missing or canonical schema13 is absent.
Mandatory canonical gate registration is outside this packet and remains a
root-owned prerequisite, including strict failed/skipped/missing/duplicate and
malformed report detection. No source count or digest proves execution.

Root supplies pinned Node22 and runs the compiler, affected-path lint, and:

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=1 tests/execution/session.test.ts tests/execution/aws-bootstrap-preflight.test.ts
ZENITH_TEST_OPENED_HANDLE_REQUIRED=1 ZENITH_TEST_AWS_PREFLIGHT_REQUIRED=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 tests/controlplane/opened-handle-ownership.test.ts tests/platform/aws-bootstrap-preflight-admission.test.ts
```

The native fixtures use real human approval rows, running claims, acquired and
bound leases, independent PostgreSQL pools, native connections/mappings and
evidence. IAM/STS responses, human role/signing policy and product lookup are
explicit models. The default caller controls use the original observer and
default native credential owner, with modeled product and grant ports; they
do not prove the default product database, signer/role resolver, browser,
Temporal service, provider permissions or live IAM. The existing composition,
credential, OpenTofu and canonical native acceptance suites remain required.

Outside-owned follow-ups are complete native compiler-child role inventory and
supported IAM role discovery, canonical gate registration, genuine default
product/broker/browser execution and independent live IAM authorization.
Customer stack-first migration and legacy boundary retirement stay with the
existing reviewed plan/custody path and customer administrator. No IAM write,
schema migration, automatic retirement or new API/startup bypass is included.
