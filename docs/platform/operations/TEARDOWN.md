# Tearing down an environment

Written against branch `ws/docs-sync-2`, based on `ws/integrate-w6` at `3c1fa66` (2026-10-01).

Teardown is an explicit, human-approved operation. It is never rollback or
automatic compensation after a failed deploy. The action and workflow are
implemented with contract evidence; no live cloud or cluster teardown was
verified in this sync.

## Review and request

1. Finish any active deployment and confirm the workspace and environment.
   The product action `env.teardown` requires an **admin**, a signed-in human
   browser session and a verified connection with a ready execution plane.
   Bearers, integrations, Navigator actors and supplied actor headers cannot
   authorize it (`src/lib/actions/defs/env-teardown.ts`,
   `src/lib/bridge/teardown-session.ts`).
2. Obtain a **current recorded destroy review** from the execution integration.
   `planDestroyInfrastructure` in `src/lib/execution/destroy.ts` can review an
   `infrastructure.plan` operation without deleting anything, under the
   environment lease. It records a `tofu_plan` evidence row with `destroy: true`,
   the digest, deletion facts and addresses; direct provider reviews also record
   retained references. The browser consumes that evidence rather than accepting
   caller-supplied plan facts (`src/lib/capabilities/destroy-plan.ts`).
3. On `/platform/environments/<id>`, use **Review teardown plan**, inspect the
   digest, counts, stateful deletions and retained resources, then type the exact
   environment name and choose **Request teardown for approval**. This records
   an `awaiting_approval` operation; it does not delete anything. Follow its link
   to `/platform/operations/<id>` (`src/app/(product)/platform/environments/[id]/environment-teardown.tsx`).
4. Approve through the browser operation review. The approval route claims the
   operation once and starts `infrastructureDestroyWorkflow` through `startDestroy`
   (`src/app/api/platform/v1/operations/[id]/approve/route.ts`,
   `src/lib/bridge/destroy.ts`). Follow the operation's status and events through
   plan, policy, human approval, final plan, apply and absence verification
   (`src/lib/workflows/definitions/destroy.ts`). A changed concrete plan needs a
   new review; the initial proposal approval cannot authorize a different plan.

**Current entry-point limits:** there is no public UI, REST or MCP trigger that
creates the first read-only destroy review. **Review teardown plan** consumes
an existing review; it does not run the worker planner. With no current review,
the action refuses and asks for one. REST destroy proposals are denied
`plan_required`, and MCP has no destroy execution tool. Plan-bound browser
approval also stays disabled without an authorized readable matching PlanView
artifact. Do not synthesize evidence, inject SQL rows or bypass that refusal.
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
  and applying. Other cloud DNS deletions are refused until an equivalent
  provider target ownership guard exists (`src/lib/execution/destroy.ts`,
  `src/lib/execution/plan.ts`). Approval never overrides ownership guards.
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
