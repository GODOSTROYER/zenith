# Operating the policy engine

How authorization policy is decided, tuned and changed. The rules themselves, with
the exact condition of each, are in [`policy/README.md`](../../../policy/README.md);
this page is about operating it: what the parameters are, what the autonomy levels
mean, how to change a rule and rebuild the bundle, and what a decision record is.
Design: [ADR-0007](../../adr/0007-capability-broker-and-autonomy.md) and
[ADR-0008](../../adr/0008-policy-opa-wasm.md).

Written against branch `ws/docs-sync`, based on `platform/integration` at `e3ea61a` (2026-10-01).

**Status.** The engine, the Rego rules, the plan-fact extraction, the workspace
parameter resolver, the decision-record store and the capability broker that calls
the engine are built and tested. The broker (`src/lib/capabilities`, behind
`/api/platform/v1`) builds the policy input from authoritative state (the catalog,
the caller's role, the environment's autonomy, the stored workspace policy) and
evaluates on every proposal, check, approval and execution. The worker's
`evaluatePolicy` delegates through `src/lib/platform/broker.ts`, using facts and
cost from authoritative plan evidence (`src/lib/execution/plan-evidence.ts`).
Product deploys and MCP v3 start workflows. Plan facts never come from a REST
request body: a REST apply/destroy proposal without an execution-supplied plan
is still denied `plan_required`. A revision approval cannot approve a new
concrete plan that changes its authority; the execution broker requires human
approval of the exact proposal and plan in the current approval round. Proposal
round zero cannot authorize a subsequently gated plan. Every statement here is about the
contract verified by tests, not about a decision made on a production request, and
nothing has been evaluated against a plan from a real AWS account (see
[Plan facts](#plan-facts-and-what-they-cannot-see)).

## How a decision is made

Policy is Rego (Open Policy Agent), compiled to WebAssembly and evaluated in-process
with `@open-policy-agent/opa-wasm`: no sidecar, no network, no clock. The same input
and the same bundle give byte-identical output.

```
PolicyInput ─ strict validation ─ consistency with the capability catalog ─ wasm ─ strict validation ─ decision
```

**Precedence is total.** Any deny gives `deny`. Otherwise any approval requirement
gives `require_approval`. Otherwise `allow`. When several approval rules fire their
requirements merge: the highest approver count, the highest minimum role, and
separation of duties if any rule asks for it. `constraints` (for example a log
window or a grant duration) accompany `allow` and `require_approval`, never `deny`.
Reasons are sorted, so output does not depend on evaluation order.

**It fails closed.** A malformed input, an input that disagrees with the capability
catalog (a capability understating its risk or `mutates`, an unknown name, a wrong
integration scope), a wasm trap, or a missing or malformed result all produce a
**deny** with the reason code `policy_error` and the failing stage in `rule`
(`zenith.engine.input`, `catalog`, `evaluation`, `output`). `evaluate` does not
throw for these. The reason carries field paths and issue codes, never input
values, because inputs can contain externally derived text. A bundle that is
missing, empty or does not match its manifest makes `loadPolicyEngine()` reject
with `PolicyLoadError`; callers must treat that as "deny everything".

**An `allow` means no rule fired.** It is not a statement that the change is safe.
Policy raises risk and never lowers it: the catalog's `risk` is a floor, and policy
raises the *effective* risk to at least `high` for a production mutation of a
stateful or publicly exposed resource, or one whose plan destroys data.

## The rules, in summary

Each rule is one named complete rule in a Rego package and is reported as
`zenith.rules.<kind>.<name>` in every reason. There are **14 deny rules, 12
approval rules and 3 constraint rules**. For the exact condition of each, read
[policy/README.md](../../../policy/README.md#decision-semantics).

**Deny** (14): `workspace_denied_capability`, `no_workspace_role`,
`viewer_cannot_mutate`, `integration_scope_missing`, `integration_scope_unresolved`,
`production_database_delete`, `production_destroys_data`,
`escape_hatch_denied_in_production`, `public_database`, `wildcard_iam`,
`region_not_approved`, `unowned_resource_mutation`,
`mutation_environment_unresolved`, `malformed_input`.

**Require approval** (12), with who may approve:

| Rule | Approver at least | In one line |
|---|---|---|
| `autonomy_below_capability` | editor | A mutation whose capability needs more autonomy than the environment has |
| `auto_remediation_disabled` | editor | The reconciler wants to fix something and the class is not allowed to auto-remediate |
| `auto_remediation_not_safe` | editor | In `safe` mode, the change is not low or medium effective risk, or is destructive, an escape hatch or destroys data |
| `production_network_identity_change` | admin | Production firewall, identity or DNS change |
| `cost_threshold_exceeded` | editor | Monthly cost rises by at least the workspace threshold |
| `budget_exceeded` | admin | Projected monthly cost is above the workspace budget (an approval, not a denial) |
| `open_ingress` | admin | The plan opens ingress to `0.0.0.0/0` or `::/0` on something other than a single tcp or udp port 80 or 443 |
| `unresolved_security_attributes` | editor | The plan has a security-relevant value it cannot settle before apply |
| `escape_hatch_requires_approval` | admin, separation of duties in production | Always, for `machine.exec`, `container.exec` and `provider.native` |
| `two_person_production` | editor, separation of duties | The workspace asked for it, production, mutating |
| `agent_high_risk_requires_approval` | editor | An agent or the Navigator wants a high or critical effective-risk change |
| `production_destructive_requires_admin` | admin, separation of duties | Production destructive change (the path for production `infrastructure.destroy`) |

**Constraints** (3): `log_read_limits` (at most 1000 lines and a 24 hour window),
`exec_limits` (300 seconds and 1 MiB of output), `grant_duration` (at most one hour;
15 minutes when the effective risk is critical). A requester's own constraints can
only lower a ceiling.

Approvals are **human-only**: a browser session, never a bearer token. A model's
"yes" is never an approval. An approval is bound to exactly one proposal digest, is
single-use, expires, and is re-checked against the current policy version when the
operation is claimed ([RECOVERY.md](RECOVERY.md#4-what-happens-to-an-operation-when-something-crashes)).

## Workspace parameters

The tunable knobs are **data, not code**: changing them never needs a rebuild.
Defaults are `DEFAULT_WORKSPACE_POLICY` in `src/lib/policy/types.ts`; a workspace
stores only what it changed.

| Parameter | Default | Effect |
|---|---|---|
| `approvedRegions` | unset (no restriction) | When set, any checked region outside the list is **denied** (`region_not_approved`). An empty list is refused, not interpreted as "deny all"; to restrict, list regions, to lift the restriction, unset it (`null`). |
| `costApprovalThresholdUsd` | `50` | A mutation that raises monthly cost by at least this needs an editor's approval. |
| `budgetUsdMonthly` | unset | When set, a mutation whose projected monthly total exceeds it needs an admin's approval. |
| `allowEscapeHatchInProduction` | `false` | `machine.exec`, `container.exec` and `provider.native` are denied in production unless `true`. Even then they always need an admin's approval. |
| `twoPersonProduction` | `false` | Production mutations need an approver other than the requester. |
| `autoRemediation` | sandbox `any`, development `any`, staging `safe`, production `none` | Per environment class, what the reconciler may fix without a human: `none`, `safe` (low or medium effective risk, non-destructive) or `any`. |
| `deniedCapabilities` | `[]` | Capabilities denied outright in the workspace, by exact name. |

Validation is strict and loud (`resolveWorkspacePolicy`, `src/lib/policy/defaults.ts`):
an unknown key, an unknown capability name (a typo that would otherwise deny
nothing), or an empty region list throws `PolicyConfigError` instead of being
corrected. Region and capability lists are de-duplicated and sorted so equal
policies produce equal inputs and equal input digests.

**Where they are stored and how to change them.** `platform.workspace_policy`
(`params`, `version`, `updated_by`), through `GET` and `PUT /api/platform/v1/workspace/policy`
(the broker's `getWorkspacePolicy` / `setWorkspacePolicy`). Members may read it, with the
overrides and the complete effective parameters. **Writing is for a human admin in a
browser session**: the route refuses any `Authorization` header, verifies the identity
live and requires an exact `Origin` ([DEPLOYING.md](DEPLOYING.md#28-capability-broker-approvals-and-the-agent-routes)).
Writes use optimistic concurrency: pass the `expectedVersion` you read, and a stale
writer gets `conflict` instead of overwriting. Only the **overrides** are stored.
(`platform.environment_settings.policy_params` also exists; see below.)

**Two things to know before you write one.**

1. **The write path validates; the store does not.** `setWorkspacePolicy` validates
   with `resolveWorkspacePolicy` before saving, so an unknown key or capability name is
   refused. The repository function underneath (`putWorkspacePolicy`) refuses only
   secret-shaped values, so anything that writes there directly can store an invalid
   policy. An invalid stored policy is `policy_unavailable`: **every request in that
   workspace is refused** until an admin saves a valid one.
2. **Use `/platform/settings` for browser editing.** Its editor in
   `src/app/(product)/platform/settings/policy-editor.tsx` sends versioned
   replacements through the same browser-only REST route. A stale version is a
   conflict, not an overwrite. UI wiring is source-verified; no live browser
   session was exercised in this sync.

**Per-environment `policy_params` are not read.** The column exists and the autonomy
setting preserves it, but the broker builds its policy input from the workspace policy
and the environment's autonomy level only. Do not rely on environment-level overrides.

## Autonomy levels

Autonomy is **per environment**, 0 to 5 ([ADR-0007](../../adr/0007-capability-broker-and-autonomy.md)),
stored in `platform.environment_settings.autonomy_level` (a check constraint keeps it
between 0 and 5) and read and written through `GET` and `PUT
/api/platform/v1/environments/<id>/autonomy`. Any member may read it; **only a human admin
in a browser session may change it**, so an agent cannot raise its own autonomy.

**When never configured** the broker applies a default by environment class
(`DEFAULT_AUTONOMY_BY_CLASS`, `src/lib/capabilities/autonomy.ts`): **production 2, staging
3, development 3, sandbox 4**; the view says `defaulted: true` so "never configured" is
distinguishable from "configured to that level". (The store alone, with no broker above
it, reads an unconfigured environment as 1, `DEFAULT_AUTONOMY_LEVEL`; the broker's
class default is what a request sees.)

| Level | Meaning (ADR-0007) | What happens |
|---|---|---|
| 0 | observe | Every mutating capability needs an approval, and an agent cannot create a mutating proposal at all (`agent_autonomy_too_low`). |
| 1 | recommend | Same as 0: agents recommend in prose but cannot create executable proposals. |
| 2 | plan: exact proposals that need approval | Agents may propose; every mutation waits for a human approval. |
| 3 | safe execution: low-risk changes run automatically | `service.restart`, `service.scale` and `database.snapshot` need no approval for autonomy reasons. |
| 4 | bounded SRE operations automatic under policy | Adds `deployment.deploy`, `deployment.rollback`, `drift.repair`, `database.migrate`, `function.invoke` and `machine.service.restart`. |
| 5 | broad autonomy within configured limits | Adds `infrastructure.apply`, `firewall.modify`, `dns.modify`, `secret.write`, `file.write`, `file.upload` and `package.install`. |

The mechanism is one rule: `autonomy_below_capability` requires an editor's approval
when the capability is mutating and the environment's level is below the
capability's `defaultAutonomy`. Capabilities with `defaultAutonomy` 6
(`infrastructure.destroy`, `database.delete`, `database.restore`, `identity.modify`,
`machine.exec`, `container.exec`, `provider.native`) are **never unattended**, at any
level. The full list by level is generated from the catalog in the
[capability matrix](../CAPABILITY-MATRIX.md#mutating-capabilities-by-default-autonomy),
so it cannot drift from the code.

"Automatic" is only ever "no approval *for autonomy reasons*". Every other rule still
applies at level 5: a cost increase over the threshold, a budget overrun, a region
outside the approved list, open ingress, a production two-person rule, a destructive
production change. Levels 3 to 5 are not levels at which policy stops looking.

Two layers decide this. The Rego rule is mutation-only and applies to every principal.
The **broker adds one guard** the Rego cannot see (`applyGuards`, which only tightens):
an `integration` or `navigator` principal proposing a mutating capability in an
environment below level 2 is denied with `agent_autonomy_too_low`. That is what makes
levels 1 and 2 differ: at 1 agents recommend, at 2 they may propose. The broker does not
gate non-mutating capabilities by autonomy (`infrastructure.plan` has default autonomy 1
and `file.read` 2, but reads are decided by role and integration scope, not by level).

The Navigator's install-wide setting maps onto these levels as observe to 0, plan to 1,
approve to 2, bounded to 3, autonomous to 5 (`levelFromNavigator`); the inverse reads 3
and 4 as "bounded". The broker implements the mapping; **nothing calls the broker from
`runAction` yet** (`checkActionThroughBroker` is "not wired into runAction" in its own
header), so the product's existing Navigator dial and the platform's per-environment
level are two settings that are not yet connected.

## Decision records

Every evaluation is stored, so "why was this allowed or sent for approval?" has an
answer after the fact. A row in `platform.policy_decisions` holds:

| Column | Meaning |
|---|---|
| `policy_version` | SHA-256 of the compiled bundle (`policy/dist/manifest.json`, `wasmSha256`), cross-checked against the bytes actually loaded |
| `input_digest` | `digest(input)`, the same canonical-JSON rule as every other digest in the control plane |
| `outcome` | `allow`, `deny` or `require_approval` |
| `reasons` | Sorted `{code, message, rule}` entries |
| `approval` | For `require_approval`: the merged requirement (count, minimum role, separation of duties) |
| `constraints` | Restrictions the executor must enforce |
| `evaluated_at` | Database time |

The broker's `propose` writes the decision and the operation together
(`recordPolicyOutcome`, `src/lib/controlplane/operations/index.ts`, through the platform
store adapter): `allow` to `approved`, `require_approval` to `awaiting_approval`, `deny`
to `denied`, with a `policy.evaluated` event. `check` makes the same decision as a dry
run and persists nothing. `authorizeRead` decides read-only capabilities without creating
an operation and logs at most one decision a minute per principal, capability, scope and
outcome. Approving and executing **re-evaluate** against current policy, roles and
autonomy and record a fresh decision.

What a record does **not** hold: the input itself, only its digest. To replay a
decision you rebuild the input from the operation's proposal, the requester's role,
the environment settings and the plan, run it through the bundle whose hash is in
`policy_version` (the committed `policy/dist/policy.wasm` of that era, from git
history), and compare the digest. Reasons never contain input values.

## Changing a rule

1. Edit or add a named rule in `policy/rego/deny.rego`, `approval.rego` or
   `constraints.rego` (shared helpers in `lib.rego`, never inside a rules package,
   where they would be iterated as rules). One rule, one reason code, a doc comment.
2. Add positive and negative cases in the matching `*_test.rego` and a row in
   `tests/policy/scenarios.ts`.
3. Rebuild:

   ```bash
   npm run policy:build     # opa version must be exactly 1.19.1; opa check --strict, opa test, opa build, writes policy/dist/
   npm run policy:check     # the same, then fails if the committed policy/dist differs from a fresh build (the CI gate)
   ```

   Install the pinned OPA (`opa` on `PATH`, or `ZENITH_OPA_BIN`). The build refuses
   any other version because the compiled wasm depends on it.
4. Run the TypeScript side: `npx vitest run tests/policy`. `bundle.test.ts` checks
   without `opa` that the committed wasm, manifest and sources agree;
   `parity.test.ts` compares the wasm with the OPA interpreter when `opa` is on
   `PATH`.
5. Commit the rules **and** `policy/dist/` (`policy.wasm` and `manifest.json`).
6. Update [policy/README.md](../../../policy/README.md) if a rule's condition or code
   changed, and the counts on this page.

Rego pitfall worth knowing: in a *negated* call an undefined argument makes the whole
expression undefined instead of true, so `not input.x in {...}` does **not** fire when
`input.x` is missing. Bind a defaulted value first, or use `not input.x == ...`.

**What a new bundle does to work in flight.** `policyVersion` is the wasm's hash, so
any rebuild changes it, and an approval records the version it was granted under. The
broker does **not** invalidate approvals on a version change by itself: it omits
`expectedPolicyVersion` and instead re-evaluates under the **current** bundle and checks
that the unconsumed, unexpired approvals satisfy the **current** requirement (count of
distinct approvers, each still holding the minimum role, separation of duties). If the
requirement is unchanged or looser the approval stands; if it is stricter the operation
needs `reapproval_required`; if the new bundle denies it, approving is refused
(`policy_denied`) and execution ends the operation (`cancelled`, `operation.denied`).
Decision records already written keep the version that made them. (The store's own
`claimForExecution` can still be given an `expectedPolicyVersion` and then refuses with
`policy_changed`; the broker does not use that mode.)

**Build reproducibility.** The build compiles LF-normalised copies of the sources under
bare names in a temp directory so the wasm does not depend on the working directory
or path separators; repeated builds here are byte-identical. The bundle was built on
Windows; a Linux (WSL2) build with a checksum-verified static OPA 1.19.1 matched it,
per the comment on the `policy` lane in `.github/workflows/ci.yml`, and that lane
re-checks it on every pull request (I did not run the lane). Only linux/amd64 and
Windows have been seen. If `policy:check` fails in CI with an unchanged `regoSha256`,
OPA's wasm output is not host-independent for that platform and the committed bundle
should be produced by CI.

Verified while writing this page (2026-09-30): `npm run policy:check` passes 205 of 205
Rego tests under OPA 1.19.1 and reports that `policy/dist` matches a fresh build.

## Plan facts, and what they cannot see

`extractPlanFacts` turns a normalized OpenTofu plan into the facts the rules read:
public databases, open ingress, wildcard IAM, regions, identity, firewall and DNS
changes, data-destroying changes and `unresolved` attributes. It is pure and
deterministic. The honest limits (from the code's own comments):

- Only what the normalized plan reports is analysed. An attribute absent from the
  diff is "not asserted", never "safe".
- A masked or known-after-apply value that decides exposure (a public-access flag,
  an ingress CIDR or port, an IAM policy document) is listed as **unresolved**,
  which asks a person to review; it is not guessed.
- Regions are read only from a resource's own `region`, availability zone or `arn`;
  nothing is inferred from provider configuration.
- IAM: `Allow` with `*` or `service:*` (or `NotAction`) on resource `*`, plus the
  managed `AdministratorAccess` policy. Partial wildcards are not flagged.
- AWS is populated; another provider adds rows to the tables in `plan-rules.ts`.
- **It has not been validated against a real `tofu show -json` from a live AWS
  plan.** The attribute path is handled in both `a[0].b` and `a.0.b` forms, from
  hand-written fixtures shaped like the normalized plan.

## What to check when something is denied or held

1. Read the decision's `reasons`: the `code` names the rule and the `message` says
   what it saw (field paths, never values). Besides the Rego rules, the **broker** can
   add `plan_required` (an `infrastructure.apply` or `destroy` without the reviewed
   OpenTofu plan; over REST this is always the case today), `agent_autonomy_too_low`
   (see above) and `policy_unavailable` (the bundle cannot load, or the stored
   workspace policy is invalid: refuse everything, never allow).
2. `policy_error` is the engine refusing, not a rule: look at the `rule` field for
   the stage. `zenith.engine.catalog` means the broker's input disagrees with the
   capability catalog, which is a bug in the broker, not a policy choice.
   `policy_unavailable` on a serverless host usually means the bundle was not shipped
   with the build ([DEPLOYING.md](DEPLOYING.md#27-policy-engine)).
3. `workspace_denied_capability`, `region_not_approved`: a workspace parameter, in
   `platform.workspace_policy`.
4. `autonomy_below_capability`: the environment's autonomy level, in
   `platform.environment_settings`, or the class default if never configured.
5. Anything else: the rule table above and [policy/README.md](../../../policy/README.md).
