# METADATA
# title: Approval requirement rules
# description: |
#   Every rule in this package is a complete rule whose value is
#   `{code, message, requirement: {count, minRole, separationOfDuties}}`; it is
#   defined only when the request needs a human approval. The aggregator merges
#   every defined rule: the highest `count`, the highest `minRole`, and
#   `separationOfDuties` if any rule asks for it. Rule names are reported as
#   `zenith.rules.approval.<name>`.
#
#   Approvals never apply when any deny rule fires (deny wins). Keep this
#   package to requirement rules only: helpers belong in `zenith.lib`.
package zenith.rules.approval

import rego.v1

import data.zenith.lib

# Deleting or replacing stateful resources always needs a person, even at
# maximum autonomy or with unrestricted auto-remediation. Deny still wins.
stateful_deletes_require_approval := {
	"code": "stateful_deletes_require_approval",
	"message": "Deleting or replacing stateful resources requires human approval in every environment.",
	"requirement": {"count": 1, "minRole": "editor", "separationOfDuties": false},
} if {
	lib.mutating
	lib.plan_count("statefulDeletes") > 0
}

# DNS record deletion is distinct from an ordinary DNS create/update. Reads
# remain available so a person or agent can inspect a destructive plan.
dns_deletes_require_approval := {
	"code": "dns_deletes_require_approval",
	"message": "Deleting or replacing DNS records requires human approval in every environment.",
	"requirement": {"count": 1, "minRole": "editor", "separationOfDuties": false},
} if {
	lib.mutating
	lib.plan_count("dnsDeletes") > 0
}

# A mutation runs unattended only when the environment's autonomy level (0-5,
# ADR-0007) reaches the capability's catalog `defaultAutonomy` (6 = never).
autonomy_below_capability := {
	"code": "autonomy_below_capability",
	"message": sprintf("Environment autonomy level %d is below the level (%d) at which this capability runs without approval.", [input.environment.autonomyLevel, input.request.defaultAutonomy]),
	"requirement": {"count": 1, "minRole": "editor", "separationOfDuties": false},
} if {
	lib.mutating
	input.environment.autonomyLevel < input.request.defaultAutonomy
}

# Reconciler-initiated remediation follows the workspace's per-environment-class
# auto-remediation mode. Anything other than "safe" or "any" behaves as "none".
auto_remediation_disabled := {
	"code": "auto_remediation_disabled",
	"message": "Auto-remediation is disabled for this environment class; a person must approve.",
	"requirement": {"count": 1, "minRole": "editor", "separationOfDuties": false},
} if {
	input.context.origin == "reconciler"
	lib.mutating
	mode := object.get(object.get(input.workspacePolicy, "autoRemediation", {}), input.environment.class, "none")
	not mode in {"safe", "any"}
}

# "safe" auto-remediation covers low/medium-risk, non-destructive changes only.
auto_remediation_not_safe := {
	"code": "auto_remediation_not_safe",
	"message": "Only low- and medium-risk, non-destructive remediation runs automatically here; a person must approve this one.",
	"requirement": {"count": 1, "minRole": "editor", "separationOfDuties": false},
} if {
	input.context.origin == "reconciler"
	lib.mutating
	object.get(object.get(input.workspacePolicy, "autoRemediation", {}), input.environment.class, "none") == "safe"
	not lib.remediation_is_safe
}

# Firewall, identity and DNS changes in production need an administrator, whether
# the capability says so or only the plan facts reveal it.
production_network_identity_change := {
	"code": "production_network_identity_change",
	"message": "Firewall, identity and DNS changes in production need administrator approval.",
	"requirement": {"count": 1, "minRole": "admin", "separationOfDuties": false},
} if {
	lib.is_production
	lib.mutating
	lib.touches_network_identity
}

# A monthly cost increase at or above the workspace threshold. A zero or negative
# delta never triggers it, even with a zero threshold.
cost_threshold_exceeded := {
	"code": "cost_threshold_exceeded",
	"message": sprintf("The estimated monthly cost increase ($%v) reaches the approval threshold ($%v).", [delta, input.workspacePolicy.costApprovalThresholdUsd]),
	"requirement": {"count": 1, "minRole": "editor", "separationOfDuties": false},
} if {
	lib.mutating
	delta := input.plan.costDeltaUsdMonthly
	delta > 0
	delta >= input.workspacePolicy.costApprovalThresholdUsd
}

# The projected monthly total exceeds the workspace budget: a financial
# decision, so an administrator approves rather than an editor. It is an
# approval, not a denial — going over budget is sometimes intended.
budget_exceeded := {
	"code": "budget_exceeded",
	"message": sprintf("The projected monthly cost ($%v) exceeds the workspace budget ($%v).", [projected, budget]),
	"requirement": {"count": 1, "minRole": "admin", "separationOfDuties": false},
} if {
	lib.mutating
	budget := input.workspacePolicy.budgetUsdMonthly
	projected := input.plan.projectedMonthlyUsd
	projected > budget
}

# Ingress from anywhere on ports other than 80/443.
open_ingress := {
	"code": "open_ingress",
	"message": sprintf("The plan opens %d ingress rule(s) to the whole internet on ports other than 80/443.", [lib.plan_count("openIngress")]),
	"requirement": {"count": 1, "minRole": "admin", "separationOfDuties": false},
} if {
	lib.mutating
	lib.plan_count("openIngress") > 0
}

# The plan holds security-relevant values that are unknown until apply
# (or masked), so the exposure cannot be judged from the plan.
unresolved_security_attributes := {
	"code": "unresolved_security_attributes",
	"message": sprintf("The plan has %d security-relevant value(s) that cannot be evaluated before apply.", [lib.plan_count("unresolved")]),
	"requirement": {"count": 1, "minRole": "editor", "separationOfDuties": false},
} if {
	lib.mutating
	lib.plan_count("unresolved") > 0
}

# Escape hatches (machine.exec, container.exec, provider.native) always need an
# administrator, and a second person in production. They are never auto-approved.
escape_hatch_requires_approval := {
	"code": "escape_hatch_requires_approval",
	"message": "Unrestricted execution surfaces always need administrator approval.",
	"requirement": {"count": 1, "minRole": "admin", "separationOfDuties": lib.is_production},
} if lib.escape_hatch

# The workspace's two-person rule: production mutations need an approver other
# than the requester.
two_person_production := {
	"code": "two_person_production",
	"message": "Production changes need approval from a person other than the requester.",
	"requirement": {"count": 1, "minRole": "editor", "separationOfDuties": true},
} if {
	input.workspacePolicy.twoPersonProduction == true
	lib.is_production
	lib.mutating
}

# Agents and the Navigator never run high/critical-risk work on their own
# authority: a person with at least editor role approves it.
agent_high_risk_requires_approval := {
	"code": "agent_high_risk_requires_approval",
	"message": "High- and critical-risk work proposed by an agent needs a person's approval.",
	"requirement": {"count": 1, "minRole": "editor", "separationOfDuties": false},
} if {
	lib.agent_initiated
	lib.effective_risk_rank >= 2
}

# Destructive capabilities (infrastructure.destroy, database.restore) in
# production need an administrator other than the requester. This is the
# approval path that makes an explicit production `infrastructure.destroy`
# possible even though a production plan that destroys data is otherwise denied.
production_destructive_requires_admin := {
	"code": "production_destructive_requires_admin",
	"message": "Destructive changes in production need administrator approval from a different person.",
	"requirement": {"count": 1, "minRole": "admin", "separationOfDuties": true},
} if {
	lib.is_production
	lib.mutating
	lib.destructive
}
