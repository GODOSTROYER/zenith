# Zenith policy (OPA / Rego → WebAssembly)

Authorization policy for the capability broker (ADR-0007, ADR-0008). Rego is the
source of truth; it is tested with `opa test`, compiled by a pinned OPA into
`dist/policy.wasm`, committed with a manifest, and evaluated in-process by
`src/lib/policy` using `@open-policy-agent/opa-wasm`. No sidecar, no network, no
clock.

```
policy/
  rego/*.rego            rules (package zenith.*)
  rego/*_test.rego       Rego unit tests (excluded from the bundle)
  dist/policy.wasm       compiled bundle, committed
  dist/manifest.json     opaVersion, entrypoint, wasmSha256 (= policyVersion), regoSha256, sources
  build.mjs              test + compile + write (or --check)
src/lib/policy/          engine, plan-fact extraction, workspace parameter resolution
tests/policy/            vitest against the committed wasm, plan fixtures, wasm/interpreter parity
```

## Using it

```ts
import { extractPlanFacts, loadPolicyEngine, resolveWorkspacePolicy } from "@/lib/policy";

const engine = await loadPolicyEngine();          // rejects (PolicyLoadError) on a bad bundle: deny everything
const evaluated = await engine.evaluate({         // never throws for bad input: returns deny + policy_error
  version: 1,
  request, principal, environment, resource,
  plan: { ...extractPlanFacts(normalizedPlan), costDeltaUsdMonthly, projectedMonthlyUsd },
  workspacePolicy: resolveWorkspacePolicy(storedOverrides),
  context: { now, origin },
});
// evaluated.decision   { outcome, reasons[{code,message,rule}], approval?, constraints? }
// evaluated.policyVersion  sha256 of policy.wasm      -> PolicyDecisionRecord.policyVersion
// evaluated.inputDigest    digest(input)              -> PolicyDecisionRecord.inputDigest
```

`ZENITH_POLICY_WASM` overrides the bundle path (default `<cwd>/policy/dist/policy.wasm`).
For serverless deployments the Next build must trace `policy/dist/**` into the
server bundle (`outputFileTracingIncludes`).

## Decision semantics

Precedence is total: **any deny → `deny`; else any approval requirement →
`require_approval`; else `allow`.** Approval requirements merge: highest `count`,
highest `minRole`, `separationOfDuties` if any rule asks for it. `constraints`
accompany allow and require_approval, never deny. Reasons are sorted, so identical
input yields byte-identical output. A `default` deny (`policy_undefined`) backs the
aggregate; the input is also structurally checked in Rego (`malformed_input`).

Each rule is a separate, named complete rule in `zenith.rules.{deny,approval,constraints}`;
the aggregator iterates those packages, and the rule's name is reported as
`zenith.rules.<kind>.<name>` in every reason. Helpers live in `zenith.lib` and
must never be defined inside a rules package (they would be iterated as rules).

### Deny — `zenith.rules.deny.*`

| Code | Fires when |
|---|---|
| `workspace_denied_capability` | capability is in `workspacePolicy.deniedCapabilities` (exact names) |
| `no_workspace_role` | principal role is not viewer/editor/admin. `system` principals are exempt (not human members; governed by origin/autonomy/auto-remediation rules) |
| `viewer_cannot_mutate` | role `viewer` and the capability mutates |
| `integration_scope_missing` | `integration` principal's scopes lack the capability's `integrationScope` (literal: `write` does not imply `read`) |
| `integration_scope_unresolved` | `integration` principal and the request names no `integrationScope` (the engine fills it from the catalog, so this is a backstop) |
| `production_database_delete` | production + `database.delete` |
| `production_destroys_data` | production + `plan.destroysData` + capability is not `infrastructure.destroy` |
| `escape_hatch_denied_in_production` | production + escape-hatch capability + `allowEscapeHatchInProduction` is not true |
| `public_database` | `plan.publicDatabases` non-empty |
| `wildcard_iam` | `plan.wildcardIam` non-empty |
| `region_not_approved` | `approvedRegions` is set and a checked region is outside it. Checked: `plan.regions` (any capability) and `environment.region` (non-destructive mutations only, so a stale-region environment can still be torn down). An empty list approves nothing |
| `unowned_resource_mutation` | mutating capability on a `referenced`/`external` (or unknown-ownership) resource |
| `mutation_environment_unresolved` | mutating capability with no `environment` |
| `malformed_input` | the document is structurally invalid (backstop; the engine rejects earlier) |

### Require approval — `zenith.rules.approval.*`

| Code | Requirement | Fires when |
|---|---|---|
| `autonomy_below_capability` | editor | mutating and `environment.autonomyLevel < request.defaultAutonomy` (6 = never unattended) |
| `auto_remediation_disabled` | editor | origin `reconciler`, mutating, and `autoRemediation[class]` is not `safe`/`any` |
| `auto_remediation_not_safe` | editor | origin `reconciler`, mode `safe`, and the change is not low/medium effective risk, non-destructive, non-escape-hatch, non-data-destroying |
| `production_network_identity_change` | admin | production + mutating + (`firewall.modify`/`identity.modify`/`dns.modify` or plan firewall/identity/dns changes) |
| `cost_threshold_exceeded` | editor | mutating and `0 < costDeltaUsdMonthly` and `≥ costApprovalThresholdUsd` |
| `budget_exceeded` | admin | mutating and `projectedMonthlyUsd > budgetUsdMonthly` (approval, not denial) |
| `open_ingress` | admin | mutating and `plan.openIngress` non-empty |
| `unresolved_security_attributes` | editor | mutating and `plan.unresolved` non-empty |
| `escape_hatch_requires_approval` | admin, separation of duties in production | escape-hatch capability (always) |
| `two_person_production` | editor, separation of duties | `twoPersonProduction` + production + mutating |
| `agent_high_risk_requires_approval` | editor | origin `agent`/`navigator` and effective risk high/critical |
| `production_destructive_requires_admin` | admin, separation of duties | production + mutating + destructive (the approval path for production `infrastructure.destroy`) |

*Effective risk* is the catalog risk, raised to at least `high` for a production
mutation of a stateful or publicly exposed resource or one whose plan destroys
data. Policy raises risk; it never lowers it.

### Allow reasons

`allowed_read_only` (non-mutating capability for a member) and
`allowed_within_policy` (mutation within autonomy and workspace policy).

### Constraints — `zenith.rules.constraints.*`

| Rule | Capabilities | Keys |
|---|---|---|
| `log_read_limits` | `logs.read`, `system.logs`, `container.logs` | `maxLines` 1000, `maxWindowHours` 24 |
| `exec_limits` | `machine.exec`, `container.exec` | `timeoutSec` 300, `maxOutputBytes` 1048576 |
| `grant_duration` | any, when `requestedDurationSec` is given | `grantDurationSec` = min(requested, 3600; 900 when effective risk is critical) |

A requester's `request.constraints` (positive numbers for those keys) can only lower
a ceiling. When no duration is requested no `grantDurationSec` is emitted; the
broker's own default grant lifetime applies and must respect the same caps.

### Engine-level reasons

`policy_error` (`rule`: `zenith.engine.input` | `catalog` | `evaluation` | `output`)
is returned — as a deny, never as an exception — when the input fails strict
validation, disagrees with the capability catalog (unknown capability, `mutates`/
`destructive`/`escapeHatch`/`defaultAutonomy` differing, risk below the catalog
floor, wrong `integrationScope`), the wasm traps, or its result is missing or
malformed. Reasons contain field paths and issue codes, never input values.

## Plan facts

`extractPlanFacts(NormalizedPlan)` (`src/lib/policy/plan-facts.ts`, rule table in
`plan-rules.ts`) turns the normalized OpenTofu plan into the `PlanFacts` the policy
reads. It is pure and deterministic (sorted, de-duplicated lists). AWS is
populated; another provider adds rows to the tables in `plan-rules.ts` and
nothing else. Honest limits:

- Only what the normalized plan reports is analyzed. An attribute absent from the
  diff is "not asserted", never "safe"; no-op/read changes are ignored.
- Masked or known-after-apply values that decide exposure (public-access flag,
  ingress CIDR/port, IAM policy document, unparseable JSON) are listed in
  `unresolved`, not guessed. Regions are read only from a resource's own
  `region` / `availability_zone(s)` / `arn`; nothing is inferred from provider
  configuration, and cross-region references are ignored.
- IAM: `Allow` with `*` or `service:*` (or `NotAction`) on Resource `*`, plus the
  managed `AdministratorAccess` policy. Partial wildcards are not flagged.
- Ingress: 0.0.0.0/0 and ::/0 except a single tcp/udp port 80 or 443 (ICMP is not a port).
- Not validated against a real `tofu show -json` from a live AWS plan: the
  attribute path format is handled in both `a[0].b` and `a.0.b` forms, from
  hand-written fixtures shaped like `NormalizedPlan`.

## Building

```
node policy/build.mjs            # opa version == 1.19.1, opa check --strict, opa test, opa build, write dist/
node policy/build.mjs --check    # same, then fail if committed dist/ differs from a fresh build (CI gate)
```

The wasm embeds the file names OPA is given, so the build compiles LF-normalised
copies of the sources under bare names in a temp directory; that is what makes the
output independent of the working directory, path separators and CRLF checkouts.
Verified: repeated builds here are byte-identical, including from other working
directories. **Not verified:** a build on a different OS/architecture (only Windows
was available). If `--check` fails in CI with an unchanged `regoSha256`, OPA's wasm
output is not host-independent and the committed bundle should be produced by CI.
`tests/policy/bundle.test.ts` independently checks (without opa) that the committed
wasm, manifest and sources agree; `tests/policy/parity.test.ts` checks the wasm
against the OPA interpreter when the pinned `opa` is on PATH (skipped otherwise).

## Changing a rule

1. Edit or add a named rule in `rego/deny.rego`, `approval.rego` or `constraints.rego`
   (helpers in `lib.rego`). One rule, one reason code, a doc comment.
2. Add positive and negative cases in the matching `*_test.rego` and a row in
   `tests/policy/scenarios.ts`.
3. `node policy/build.mjs`, commit `dist/`.

Rego pitfall worth knowing: in a *negated* call, an undefined argument makes the
whole expression undefined instead of true — `not input.x in {…}` does **not**
fire when `input.x` is missing. Bind a defaulted value first (see
`no_workspace_role`), or use `not input.x == …` / `not input.x`.
