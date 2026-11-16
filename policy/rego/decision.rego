# METADATA
# title: Zenith decision
# description: |
#   Entrypoint `zenith/decision/result` (ADR-0008). Aggregates the three rule
#   packages into one decision:
#
#     {outcome, reasons: [{code, message, rule}], approval?, constraints?}
#
#   Precedence is total and deterministic:
#     1. any `zenith.rules.deny.*` rule defined      -> deny
#     2. else any `zenith.rules.approval.*` defined  -> require_approval, with the
#        requirements merged (highest count, highest minRole, separation of
#        duties if any rule asks for it)
#     3. else                                        -> allow
#
#   `constraints` (merged `zenith.rules.constraints.*`) accompany allow and
#   require_approval, never deny. Reasons are sorted, so identical input always
#   yields byte-identical output. The policy reads no clock: `context.now` is
#   carried for the audit record only.
#
#   `default result` is a deny with `policy_undefined`: if evaluation of the
#   aggregate itself were ever undefined, the answer is still "no".
package zenith.decision

import rego.v1

import data.zenith.lib

default result := {
	"outcome": "deny",
	"reasons": [{
		"code": "policy_undefined",
		"message": "The policy produced no decision; the request is denied.",
		"rule": "zenith.decision.result",
	}],
}

result := deny_result if count(deny_reasons) > 0

else := approval_result if count(approval_entries) > 0

else := allow_result

deny_reasons := sort([reason |
	some name, found in data.zenith.rules.deny
	reason := object.union(found, {"rule": sprintf("zenith.rules.deny.%s", [name])})
])

approval_entries := [entry |
	some name, found in data.zenith.rules.approval
	entry := object.union(found, {"rule": sprintf("zenith.rules.approval.%s", [name])})
]

approval_reasons := sort([{"code": entry.code, "message": entry.message, "rule": entry.rule} | some entry in approval_entries])

required_count := max([entry.requirement.count | some entry in approval_entries])

required_role_rank := max([lib.role_rank[entry.requirement.minRole] | some entry in approval_entries])

requires_separation if {
	some entry in approval_entries
	entry.requirement.separationOfDuties == true
}

default separation_of_duties := false

separation_of_duties if requires_separation

approval_requirement := {
	"count": required_count,
	"minRole": lib.roles_by_rank[required_role_rank],
	"separationOfDuties": separation_of_duties,
}

constraint_docs := [doc | some doc in data.zenith.rules.constraints]

merged_constraints := {key: value |
	some doc in constraint_docs
	some key, _ in doc
	value := min([candidate | some other in constraint_docs; candidate := other[key]])
}

default constraints_part := {}

constraints_part := {"constraints": merged_constraints} if count(merged_constraints) > 0

deny_result := {
	"outcome": "deny",
	"reasons": deny_reasons,
}

approval_result := object.union(
	{
		"outcome": "require_approval",
		"reasons": approval_reasons,
		"approval": approval_requirement,
	},
	constraints_part,
)

allow_result := object.union(
	{
		"outcome": "allow",
		"reasons": [allow_reason],
	},
	constraints_part,
)

allow_reason := {
	"code": "allowed_read_only",
	"message": "A read-only capability is allowed for a workspace member.",
	"rule": "zenith.decision.allow",
} if not lib.mutating

allow_reason := {
	"code": "allowed_within_policy",
	"message": "The change is within the environment's autonomy level and the workspace policy.",
	"rule": "zenith.decision.allow",
} if lib.mutating
