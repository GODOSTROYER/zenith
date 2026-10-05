# METADATA
# title: Shared helpers for the Zenith decision policy
# description: |
#   Pure helper rules and functions used by every rule package. Nothing in this
#   package yields a "reason", an "approval requirement" or a "constraint" —
#   those live in `zenith.rules.{deny,approval,constraints}`, and the decision
#   aggregator iterates exactly those three packages. Keeping helpers here (and
#   never in a rules package) is what makes that iteration safe.
#
#   Fail-closed defaults: a missing `request.mutates` is treated as a mutation,
#   a missing/unknown `request.risk` is treated as critical. The TypeScript
#   engine validates the input strictly before evaluation, so these defaults
#   are defense in depth, not the primary check.
package zenith.lib

import rego.v1

# Authenticated agent principals cannot opt out through an origin label.
# Retain the origin guard for callers that already mark work as agent-initiated.
agent_initiated if input.principal.kind in {"integration", "navigator"}

agent_initiated if input.context.origin in {"agent", "navigator"}

# Ordinal ranks. Unknown values are handled by the callers (fail closed).
risk_rank := {"low": 0, "medium": 1, "high": 2, "critical": 3}

# Approver roles by rank. "none" is rank 0 and is never a valid approver.
roles_by_rank := ["none", "viewer", "editor", "admin"]

role_rank := {"viewer": 1, "editor": 2, "admin": 3}

# Capabilities whose read volume is capped by policy.
log_capabilities := {"logs.read", "system.logs", "container.logs"}

# Escape-hatch executors with a hard timeout and output cap.
exec_capabilities := {"machine.exec", "container.exec"}

# Capabilities (and plan facts) that change firewall, identity or DNS state.
network_identity_capabilities := {"firewall.modify", "identity.modify", "dns.modify"}

# True when the environment is a production environment.
default is_production := false

is_production if input.environment.class == "production"

# True unless the request explicitly says it does not mutate. Fail closed.
default mutating := true

mutating := false if input.request.mutates == false

default destructive := false

destructive if input.request.destructive == true

default escape_hatch := false

escape_hatch if input.request.escapeHatch == true

# Adoption changes Zenith ownership metadata only. The broker and repository
# bind a referenced resource and exact human approval; no provider write occurs.
# Require the complete catalog annotation so altered autonomy cannot bypass denial.
metadata_adoption if {
	input.request.capability == "resource.adopt"
	input.request.mutates == true
	input.request.risk == "high"
	input.request.defaultAutonomy == 6
	input.request.destructive == false
	input.request.escapeHatch == false
	input.request.integrationScope == "write"
	input.resource.ownership == "referenced"
}

# The capability's risk from the catalog. Unknown or missing => critical.
base_risk_rank := object.get(risk_rank, object.get(input.request, "risk", "critical"), 3)

# Policy may raise the catalog risk, never lower it: a mutation in production of
# something stateful, publicly exposed, or that destroys data is at least high.
default raised_risk_rank := 0

raised_risk_rank := 2 if {
	is_production
	mutating
	production_sensitive
}

production_sensitive if input.resource.stateful == true

production_sensitive if input.resource.publiclyExposed == true

production_sensitive if input.plan.destroysData == true

effective_risk_rank := max({base_risk_rank, raised_risk_rank})

# List-valued plan fact (empty when there is no plan or the fact is absent).
plan_list(field) := object.get(object.get(input, "plan", {}), field, [])

plan_count(field) := count(plan_list(field))

# Regions the policy validates against the workspace's approved regions.
#   * every region a created/updated resource lands in (plan facts), for any
#     capability — an unacceptable plan is unacceptable however it is asked for;
#   * the environment's region, only for non-destructive mutations, so a
#     workspace can still tear down / repair an environment left in a region it
#     has since stopped approving.
checked_regions contains region if some region in plan_list("regions")

checked_regions contains region if {
	mutating
	not destructive
	region := input.environment.region
	region != ""
}

# Requested narrowing only ever tightens a policy ceiling.
narrow(ceilings) := {key: value |
	some key, ceiling in ceilings
	value := narrowed(key, ceiling)
}

narrowed(key, ceiling) := min([ceiling, requested]) if {
	requested := input.request.constraints[key]
	is_number(requested)
	requested > 0
}

narrowed(key, ceiling) := ceiling if not valid_requested(key)

valid_requested(key) if {
	requested := input.request.constraints[key]
	is_number(requested)
	requested > 0
}

# Longest capability grant the policy will allow for this request.
grant_duration_cap := 900 if effective_risk_rank >= 3

grant_duration_cap := 3600 if effective_risk_rank < 3

clamp_duration(requested) := min([requested, grant_duration_cap]) if {
	is_number(requested)
	requested > 0
}

clamp_duration(requested) := grant_duration_cap if not is_valid_duration(requested)

is_valid_duration(requested) if {
	is_number(requested)
	requested > 0
}

# A remediation the reconciler may run unattended when the workspace allows
# "safe" auto-remediation: low/medium effective risk, nothing destructive, no
# data destroyed, no escape hatch.
remediation_is_safe if {
	effective_risk_rank <= 1
	not destructive
	not escape_hatch
	not input.plan.destroysData == true
}

# The request changes (or the plan changes) firewall, identity or DNS state.
touches_network_identity if input.request.capability in network_identity_capabilities

touches_network_identity if plan_count("firewallChanges") > 0

touches_network_identity if plan_count("identityChanges") > 0

touches_network_identity if plan_count("dnsChanges") > 0

# Structural check of the input. The TypeScript engine validates the input
# strictly before evaluation; this is the backstop so that a malformed document
# handed straight to the wasm is denied instead of falling through rules that
# silently do not match. Optional sections may be absent but must be well formed
# when present.
default well_formed := false

well_formed if {
	input.version == 1
	request_well_formed
	principal_well_formed
	workspace_policy_well_formed
	environment_well_formed
	resource_well_formed
	plan_well_formed
	is_object(input.context)
	is_string(input.context.origin)
}

default request_well_formed := false

request_well_formed if {
	is_object(input.request)
	is_string(input.request.capability)
	is_string(input.request.risk)
	is_boolean(input.request.mutates)
	is_boolean(input.request.destructive)
	is_boolean(input.request.escapeHatch)
	is_number(input.request.defaultAutonomy)
}

default principal_well_formed := false

principal_well_formed if {
	is_object(input.principal)
	is_string(input.principal.kind)
	is_string(input.principal.role)
}

default workspace_policy_well_formed := false

workspace_policy_well_formed if {
	is_object(input.workspacePolicy)
	is_number(input.workspacePolicy.costApprovalThresholdUsd)
	is_boolean(input.workspacePolicy.allowEscapeHatchInProduction)
	is_boolean(input.workspacePolicy.twoPersonProduction)
	is_object(input.workspacePolicy.autoRemediation)
	is_array(input.workspacePolicy.deniedCapabilities)
	optional_array(input.workspacePolicy, "approvedRegions")
	optional_number(input.workspacePolicy, "budgetUsdMonthly")
}

default environment_well_formed := false

environment_well_formed if not input.environment

environment_well_formed if {
	is_object(input.environment)
	is_string(input.environment.class)
	is_number(input.environment.autonomyLevel)
	is_string(input.environment.region)
}

default resource_well_formed := false

resource_well_formed if not input.resource

resource_well_formed if {
	is_object(input.resource)
	is_string(input.resource.ownership)
	is_boolean(input.resource.stateful)
}

default plan_well_formed := false

plan_well_formed if not input.plan

plan_well_formed if {
	is_object(input.plan)
	optional_bool(input.plan, "destroysData")
	optional_number(input.plan, "costDeltaUsdMonthly")
	optional_number(input.plan, "projectedMonthlyUsd")
	every field in plan_list_fields {
		optional_array(input.plan, field)
	}
}

plan_list_fields := [
	"destroyedStatefulAddresses", "regions", "publicDatabases", "openIngress", "wildcardIam",
	"identityChanges", "firewallChanges", "dnsChanges", "unresolved",
]

# `optional_*(obj, key)`: the key is absent, or present with the right type.
optional_array(obj, key) if not has_key(obj, key)

optional_array(obj, key) if is_array(obj[key])

optional_number(obj, key) if not has_key(obj, key)

optional_number(obj, key) if is_number(obj[key])

optional_bool(obj, key) if not has_key(obj, key)

optional_bool(obj, key) if is_boolean(obj[key])

# Presence check that treats an explicit `false` or `null` as present.
has_key(obj, key) if key in object.keys(obj)
