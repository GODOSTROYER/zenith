# Tearing down an environment

Written against branch `ws/docs-sync-2`, based on `ws/integrate-w6` at `3c1fa66` (2026-10-01).
Updated for WS-DESTROY-REVIEW on `ws/destroy-review`, based on `69d96fd` (2026-10-01).

Teardown is an explicit, human-approved operation. It is never rollback or
automatic compensation after a failed deploy. The action and workflow are
implemented with contract evidence; no live cloud or cluster teardown was
verified in this sync.

## Review and request

1. Finish any active deployment and confirm the workspace and environment.
   Any workspace member authorized for `infrastructure.plan` may request a
   **Review teardown** through the product action `env.reviewTeardown`,
   `POST /api/platform/v1/environments/<id>/teardown-review` or MCP
   `zenith_review_teardown`. Agents need the integration `plan` scope, not
   `write`; they cannot approve. REST takes `{ "idempotencyKey": "<random-key>" }`
   and optional `refresh: true`. MCP also takes the workspace/project/environment
   target. Retry an unconfirmed dispatch with the same key.
   The legacy product action `env.teardown` requires an **admin**, a signed-in human
   browser session and a verified connection with a ready execution plane.
   Bearers, integrations, Navigator actors and supplied actor headers cannot
   authorize it (`src/lib/actions/defs/env-teardown.ts`,
   `src/lib/bridge/teardown-session.ts`).
2. The execution worker creates the **current recorded destroy review**.
   The control plane dispatches the Temporal `teardownReviewWorkflow`, whose sole `reviewTeardown`
   activity runs once with workspace and operation ids only. It never opens cloud
   credentials or runs OpenTofu in the web process. The execution worker must be polling the queue.
   `planDestroyInfrastructure` in `src/lib/execution/destroy.ts` can review an
   `infrastructure.plan` operation without deleting anything, under the
   environment lease. It records a `tofu_plan` evidence row with `destroy: true`,
   the digest, deletion facts and addresses; direct provider reviews also record
   retained references. It also records the bounded, redacted matching PlanView
   on the pending teardown proposal so the existing browser approval can read it.
   The browser consumes that evidence rather than accepting
   caller-supplied plan facts (`src/lib/capabilities/destroy-plan.ts`).
3. On `/platform/environments/<id>`, the review state persists across reloads.
   `GET /api/platform/v1/environments/<id>/teardown-review` reads the latest
   request; optional `?reviewId=<id>` follows a specific request. A queued/running
   review is not a plan or a successful teardown. Once complete, inspect the
   pending proposal through **Review teardown operation for approval**.
   The legacy **Review teardown plan** path also consumes the recorded review; inspect the
   digest, counts, stateful deletions and retained resources, then type the exact
   environment name and choose **Request teardown for approval**. This records
   an `awaiting_approval` operation (or reuses the current review); it does not delete anything. Follow its link
   to `/platform/operations/<id>` (`src/app/(product)/platform/environments/[id]/environment-teardown.tsx`).
4. Approve through the browser operation review. The approval route claims the
   operation once and starts `infrastructureDestroyWorkflow` through `startDestroy`
   (`src/app/api/platform/v1/operations/[id]/approve/route.ts`,
   `src/lib/bridge/destroy.ts`). Follow the operation's status and events through
   plan, policy, human approval, final plan, apply and absence verification
   (`src/lib/workflows/definitions/destroy.ts`). A changed concrete plan needs a
   new review; the initial proposal approval cannot authorize a different plan.

One pending review is kept per environment under the environment lease. A
request reuses it while its stored environment/revision/resource inputs match
and its 15-minute validity window remains open. An expired review, changed
inputs or explicit refresh supersedes the pending review with a recorded
cancellation reason. An approved, running or uncertain teardown blocks a new
review. This freshness window does not attest to live drift: the final destroy
plan must still match before apply.

**Current entry-point limits:** ordinary REST destroy proposals still need
execution-supplied evidence and MCP still has no destroy execution tool.
The worker-created proposal records the real requester, checks their current
plan access at approval/execution, and evaluates destruction as a deterministic
service requiring at least one browser admin approval. It grants no mutation
authority to the requester. Plan-bound browser approval stays disabled without
an authorized readable matching PlanView artifact and exact plan digest.
The dedicated Temporal workflow has a disposable test-server check with fake
cloud ports; live cloud/cluster planning and deletion remain unverified.
Unavailable dispatch fails closed. Do not
synthesize evidence, inject SQL rows or bypass a refusal.
Managed Zenith teardown additionally requires an injected `withZenithSession`
opener; default execution composition does not supply it
(`src/lib/platform/execution.ts`, `src/lib/execution/destroy.ts`).

## What can be deleted

The worker starts with the **deployed** revision and workspace-scoped stored
resources, including resources removed from later revisions. It refuses
unmapped OpenTofu deletions, foreign providers and non-deletion mutations.
Referenced/external resources do not become managed during teardown.

- Stateful deletion requires an explicit deletion policy and human approval;
  `allow` does not waive approval. Direct provider teardown retains stateful
  objects when `allowStatefulDeletion` is false or any managed stateful node
  lacks an `allow`/`approval` deletion policy. Retention can leave infrastructure
  and ongoing charges. See [POLICY.md](POLICY.md#deletion-approvals).
- AWS Route53 deletions require a live target ownership check before planning
  and applying. Normal deploy delete/replace also checks GCP Cloud DNS A records
  against the scoped managed forwarding rule, Azure DNS A/CNAME and companion
  asuid TXT against scoped managed endpoints, and OCI DNS A rrsets against the
  scoped managed load balancer through read-only `oci.http` runner requests
  (`src/lib/execution/plan.ts`, `src/lib/providers/{gcp,azure,oci}/dns-ownership.ts`).
  Every record value must be owned. Unmapped types, foreign targets, malformed
  responses, ambiguous or truncated searches and unreadable ownership refuse.
  OCI requires a readable compartment zone and treats any rrset 404 as unknown;
  a complete empty rrset proves absence. These guards have contract evidence,
  with no live cloud verification. Explicit non-AWS DNS **teardown still refuses**
  in `src/lib/execution/destroy.ts`; its separate dispatch is not integrated.
  Human digest-bound approval remains required and never overrides ownership guards.
- Kubernetes deletes only environment-owned objects, rechecking ownership with
  UID/resourceVersion preconditions. Namespaces are **always retained** to avoid
  cascading into foreign or uninventoried objects. Finalizers are not removed;
  one bounded follow-up read must confirm absence or the outcome is uncertain
  (`src/lib/providers/kubernetes/teardown.ts`).
- Zenith-managed teardown keeps isolation until the final namespace deletion,
  removes owned TLS objects through its separate operator session, and uses the
  database lifecycle's policy/ownership gate. It needs a trusted complete
  `session.teardown.databases` inventory, including removed resources, with
  approval flags from this operation. Missing inventory is unknown. Retention,
  incomplete discovery, foreign supported objects or uncertainty prevent namespace
  deletion (`src/lib/providers/zenith/teardown.ts`). Unknown custom kinds are not
  inventoried; the managed namespace must belong exclusively to that tenant.

### OCI normal-deploy DNS read rules

This additive operator contract supplements the capability table in
[RUNNER-PROTOCOL-OCI.md](../RUNNER-PROTOCOL-OCI.md). For `infrastructure.plan`,
`infrastructure.apply`, `deployment.deploy` and `deployment.rollback`, the
DNS ownership guard permits exactly these read-only requests:

```text
dns GET /20180115/zones/{}
dns GET /20180115/zones/{}/records/{}/{}
loadbalancer GET /20170115/loadBalancers
loadbalancer GET /20170115/loadBalancers/{}
```

No OCI HTTP mutation is authorized by these additions. The runner still checks
the signed grant, region and owner-maintained compartment bindings, including
the DNS zone name and load-balancer OCID. Missing local bindings fail closed.
The TS allowlist and embedded Go testdata carry the same rules; a rebuilt runner
is required to consume the updated embedded contract. The protocol table itself
and explicit teardown dispatch require orchestrator follow-up.

## Evidence and unsuccessful outcomes

Approval binds the exact proposal and plan in the current approval round. Every
stage runs under an environment lease and fence. A fresh final plan must match
the reviewed digest before apply. Plan evidence, approval history, events,
apply summaries and verification evidence remain in the platform store;
teardown does not delete the product environment or its audit trail.

`tofu_apply` means an apply ran, not that all resources are absent. OpenTofu
resources become `deleted` only after a non-simulated observation reports
`missing`; inaccessible, unknown or simulated observations cannot prove absence.
For Kubernetes the adapter confirms absence; the managed adapter's `deleted`
means deletion was accepted (or would occur in a dry run), so the worker performs
another review. Skipped/uncertain references or mismatched evidence prevent a
passed verification (`src/lib/execution/destroy.ts`).

If workflow start cannot be confirmed after claiming, or deletion may have
partially occurred, inspect the existing operation and live state before a new
proposal. Mutations are not retried automatically. `unknown`, `failed` and
`uncertain` are outcomes to investigate, never successful cleanup. See
[RECOVERY.md](RECOVERY.md#45-what-to-do-with-an-uncertain-operation).
