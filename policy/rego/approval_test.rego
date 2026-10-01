# METADATA
# title: Tests for zenith.rules.approval
package zenith.rules.approval_test

import rego.v1

import data.zenith.fixtures_test as fx
import data.zenith.rules.approval

editor := {"count": 1, "minRole": "editor", "separationOfDuties": false}

admin := {"count": 1, "minRole": "admin", "separationOfDuties": false}

# ---------------------------------------------------------------- baseline

test_base_input_needs_no_approval if {
	count(approval) == 0 with input as fx.base
}

# ------------------------------------------------ autonomy_below_capability

test_autonomy_below_capability_fires if {
	r := approval.autonomy_below_capability with input as fx.with_patch({"environment": {"autonomyLevel": 2}})
	r.code == "autonomy_below_capability"
	r.requirement == editor
}

test_autonomy_below_capability_message_names_the_levels if {
	approval.autonomy_below_capability.message == "Environment autonomy level 2 is below the level (3) at which this capability runs without approval." with input as fx.with_patch({"environment": {"autonomyLevel": 2}})
}

test_autonomy_equal_to_default_is_enough if {
	not approval.autonomy_below_capability with input as fx.with_patch({"environment": {"autonomyLevel": 3}})
}

test_autonomy_six_means_never_unattended if {
	approval.autonomy_below_capability.code == "autonomy_below_capability" with input as fx.with_patch({
		"environment": {"autonomyLevel": 5},
		"request": {"defaultAutonomy": 6},
	})
}

test_autonomy_rule_ignores_reads if {
	not approval.autonomy_below_capability with input as fx.with_patch({
		"environment": {"autonomyLevel": 0},
		"request": {"capability": "file.read", "mutates": false, "defaultAutonomy": 2},
	})
}

# --------------------------------------------- reconciler auto-remediation

test_auto_remediation_disabled_when_mode_is_none if {
	r := approval.auto_remediation_disabled with input as fx.with_patch({
		"context": {"origin": "reconciler"},
		"environment": {"class": "production"},
	})
	r.code == "auto_remediation_disabled"
	r.requirement == editor
}

test_auto_remediation_unknown_mode_behaves_as_none if {
	approval.auto_remediation_disabled.code == "auto_remediation_disabled" with input as fx.with_patch({
		"context": {"origin": "reconciler"},
		"workspacePolicy": {"autoRemediation": {"development": "yolo"}},
	})
}

test_auto_remediation_missing_class_behaves_as_none if {
	approval.auto_remediation_disabled.code == "auto_remediation_disabled" with input as json.remove(fx.with_patch({"context": {"origin": "reconciler"}}), ["workspacePolicy/autoRemediation/development"])
}

test_auto_remediation_any_and_safe_do_not_disable if {
	not approval.auto_remediation_disabled with input as fx.with_patch({"context": {"origin": "reconciler"}})
	not approval.auto_remediation_disabled with input as fx.with_patch({"context": {"origin": "reconciler"}, "environment": {"class": "staging"}})
}

test_auto_remediation_rules_only_apply_to_the_reconciler if {
	not approval.auto_remediation_disabled with input as fx.with_patch({"environment": {"class": "production"}})
	not approval.auto_remediation_not_safe with input as fx.with_patch({
		"environment": {"class": "staging"},
		"request": {"risk": "critical"},
	})
}

test_auto_remediation_safe_allows_medium_risk_non_destructive if {
	not approval.auto_remediation_not_safe with input as fx.with_patch({
		"context": {"origin": "reconciler"},
		"environment": {"class": "staging"},
	})
}

test_auto_remediation_safe_rejects_high_risk if {
	r := approval.auto_remediation_not_safe with input as fx.with_patch({
		"context": {"origin": "reconciler"},
		"environment": {"class": "staging"},
		"request": {"risk": "high"},
	})
	r.code == "auto_remediation_not_safe"
	r.requirement == editor
}

test_auto_remediation_safe_rejects_destructive if {
	approval.auto_remediation_not_safe.code == "auto_remediation_not_safe" with input as fx.with_patch({
		"context": {"origin": "reconciler"},
		"environment": {"class": "staging"},
		"request": {"destructive": true},
	})
}

test_auto_remediation_safe_rejects_data_destroying_plans if {
	approval.auto_remediation_not_safe.code == "auto_remediation_not_safe" with input as fx.with_patch({
		"context": {"origin": "reconciler"},
		"environment": {"class": "staging"},
		"plan": fx.plan({"destroysData": true}),
	})
}

test_auto_remediation_safe_rejects_escape_hatches if {
	approval.auto_remediation_not_safe.code == "auto_remediation_not_safe" with input as fx.with_patch({
		"context": {"origin": "reconciler"},
		"environment": {"class": "staging"},
		"request": {"escapeHatch": true},
	})
}

test_auto_remediation_safe_uses_effective_risk_in_production if {
	# Production is "safe" here, and a stateful resource lifts medium to high.
	approval.auto_remediation_not_safe.code == "auto_remediation_not_safe" with input as fx.with_patch({
		"context": {"origin": "reconciler"},
		"environment": {"class": "production"},
		"workspacePolicy": {"autoRemediation": {"production": "safe"}},
		"resource": {"stateful": true},
	})
}

test_auto_remediation_any_permits_everything_without_extra_gate if {
	not approval.auto_remediation_not_safe with input as fx.with_patch({
		"context": {"origin": "reconciler"},
		"request": {"risk": "critical", "destructive": true},
	})
}

# -------------------------------------- production_network_identity_change

test_production_firewall_capability_needs_admin if {
	r := approval.production_network_identity_change with input as fx.with_patch(object.union(fx.production, {"request": {"capability": "firewall.modify", "risk": "high"}}))
	r.code == "production_network_identity_change"
	r.requirement == admin
}

test_production_identity_and_dns_capabilities_need_admin if {
	every capability in ["identity.modify", "dns.modify"] {
		approval.production_network_identity_change with input as fx.with_patch(object.union(fx.production, {"request": {"capability": capability}}))
	}
}

test_production_plan_facts_reveal_network_identity_changes if {
	every field in ["firewallChanges", "identityChanges", "dnsChanges"] {
		approval.production_network_identity_change with input as fx.with_patch(object.union(fx.production, {
			"request": {"capability": "infrastructure.apply"},
			"plan": fx.plan({field: ["something"]}),
		}))
	}
}

test_network_identity_change_outside_production_is_not_admin_gated if {
	not approval.production_network_identity_change with input as fx.with_patch({"request": {"capability": "firewall.modify"}})
	not approval.production_network_identity_change with input as fx.with_patch({
		"environment": {"class": "staging"},
		"plan": fx.plan({"firewallChanges": ["aws_security_group.web"]}),
	})
}

test_production_without_network_identity_change_is_not_gated if {
	not approval.production_network_identity_change with input as fx.with_patch(fx.production)
}

test_production_network_identity_plan_facts_do_not_gate_reads if {
	not approval.production_network_identity_change with input as fx.with_patch(object.union(fx.production, {
		"request": {"capability": "infrastructure.plan", "mutates": false},
		"plan": fx.plan({"firewallChanges": ["x"]}),
	}))
}

# ------------------------------------------------------- cost_threshold_exceeded

test_cost_threshold_fires_at_the_threshold if {
	r := approval.cost_threshold_exceeded with input as fx.with_patch({"plan": fx.plan({"costDeltaUsdMonthly": 50})})
	r.code == "cost_threshold_exceeded"
	r.requirement == editor
}

test_cost_threshold_fires_above_the_threshold if {
	approval.cost_threshold_exceeded.code == "cost_threshold_exceeded" with input as fx.with_patch({"plan": fx.plan({"costDeltaUsdMonthly": 51.5})})
}

test_cost_threshold_does_not_fire_below if {
	not approval.cost_threshold_exceeded with input as fx.with_patch({"plan": fx.plan({"costDeltaUsdMonthly": 49.99})})
}

test_cost_threshold_ignores_reductions_and_zero if {
	not approval.cost_threshold_exceeded with input as fx.with_patch({"plan": fx.plan({"costDeltaUsdMonthly": -500})})
	not approval.cost_threshold_exceeded with input as fx.with_patch({
		"workspacePolicy": {"costApprovalThresholdUsd": 0},
		"plan": fx.plan({"costDeltaUsdMonthly": 0}),
	})
}

test_cost_threshold_of_zero_flags_any_increase if {
	approval.cost_threshold_exceeded.code == "cost_threshold_exceeded" with input as fx.with_patch({
		"workspacePolicy": {"costApprovalThresholdUsd": 0},
		"plan": fx.plan({"costDeltaUsdMonthly": 0.01}),
	})
}

test_cost_threshold_needs_a_known_delta if {
	not approval.cost_threshold_exceeded with input as fx.with_patch({"plan": fx.empty_plan})
	not approval.cost_threshold_exceeded with input as fx.base
}

test_cost_threshold_does_not_gate_planning if {
	not approval.cost_threshold_exceeded with input as fx.with_patch({
		"request": {"capability": "infrastructure.plan", "mutates": false},
		"plan": fx.plan({"costDeltaUsdMonthly": 900}),
	})
}

# ------------------------------------------------------------ budget_exceeded

test_budget_exceeded_fires_above_budget_and_needs_admin if {
	r := approval.budget_exceeded with input as fx.with_patch({
		"workspacePolicy": {"budgetUsdMonthly": 1000},
		"plan": fx.plan({"projectedMonthlyUsd": 1000.01}),
	})
	r.code == "budget_exceeded"
	r.requirement == admin
}

test_budget_exactly_met_is_not_exceeded if {
	not approval.budget_exceeded with input as fx.with_patch({
		"workspacePolicy": {"budgetUsdMonthly": 1000},
		"plan": fx.plan({"projectedMonthlyUsd": 1000}),
	})
}

test_budget_needs_both_a_budget_and_a_projection if {
	not approval.budget_exceeded with input as fx.with_patch({"plan": fx.plan({"projectedMonthlyUsd": 99999})})
	not approval.budget_exceeded with input as fx.with_patch({"workspacePolicy": {"budgetUsdMonthly": 10}})
}

# ---------------------------------------------------------------- open_ingress

test_open_ingress_needs_admin if {
	r := approval.open_ingress with input as fx.with_patch({"plan": fx.plan({"openIngress": [{"address": "aws_security_group.web", "port": "22", "cidr": "0.0.0.0/0"}]})})
	r.code == "open_ingress"
	r.requirement == admin
}

test_no_open_ingress_no_requirement if {
	not approval.open_ingress with input as fx.with_patch({"plan": fx.empty_plan})
}

test_open_ingress_does_not_gate_planning if {
	not approval.open_ingress with input as fx.with_patch({
		"request": {"capability": "infrastructure.plan", "mutates": false},
		"plan": fx.plan({"openIngress": [{"address": "a", "port": "22", "cidr": "0.0.0.0/0"}]}),
	})
}

# ------------------------------------------ unresolved_security_attributes

test_unresolved_security_attributes_need_editor if {
	r := approval.unresolved_security_attributes with input as fx.with_patch({"plan": fx.plan({"unresolved": ["aws_iam_policy.x:policy"]})})
	r.code == "unresolved_security_attributes"
	r.requirement == editor
}

test_no_unresolved_attributes_no_requirement if {
	not approval.unresolved_security_attributes with input as fx.with_patch({"plan": fx.plan({"unresolved": []})})
	not approval.unresolved_security_attributes with input as fx.with_patch({"plan": fx.empty_plan})
}

# ------------------------------------------- escape_hatch_requires_approval

test_escape_hatch_always_needs_admin if {
	r := approval.escape_hatch_requires_approval with input as fx.with_patch({
		"request": {"capability": "machine.exec", "escapeHatch": true},
		"environment": {"autonomyLevel": 5},
	})
	r.code == "escape_hatch_requires_approval"
	r.requirement == admin
}

test_escape_hatch_in_production_adds_separation_of_duties if {
	r := approval.escape_hatch_requires_approval with input as fx.with_patch(object.union(fx.production, {"request": {"capability": "provider.native", "escapeHatch": true}}))
	r.requirement == {"count": 1, "minRole": "admin", "separationOfDuties": true}
}

test_non_escape_hatch_is_not_an_escape_hatch_requirement if {
	not approval.escape_hatch_requires_approval with input as fx.base
}

# ------------------------------------------------------ two_person_production

test_two_person_production_requires_separation_of_duties if {
	r := approval.two_person_production with input as fx.with_patch(object.union(fx.production, {"workspacePolicy": {"twoPersonProduction": true}}))
	r.code == "two_person_production"
	r.requirement == {"count": 1, "minRole": "editor", "separationOfDuties": true}
}

test_two_person_production_is_opt_in if {
	not approval.two_person_production with input as fx.with_patch(fx.production)
}

test_two_person_production_is_production_only if {
	not approval.two_person_production with input as fx.with_patch({"workspacePolicy": {"twoPersonProduction": true}})
}

test_two_person_production_does_not_gate_reads if {
	not approval.two_person_production with input as fx.with_patch(object.union(fx.production, {
		"workspacePolicy": {"twoPersonProduction": true},
		"request": {"capability": "logs.read", "mutates": false},
	}))
}

# ------------------------------------------ agent_high_risk_requires_approval

test_agent_principal_cannot_claim_non_agent_origin if {
	every kind in ["integration", "navigator"] {
		every origin in ["human", "system", "reconciler"] {
			every risk in ["high", "critical"] {
				r := approval.agent_high_risk_requires_approval with input as fx.with_patch({
					"principal": {"kind": kind},
					"context": {"origin": origin},
					"request": {"risk": risk},
				})
				r.code == "agent_high_risk_requires_approval"
				r.requirement == editor
			}
		}
	}
}

test_agent_principal_low_and_medium_risk_are_not_gated if {
	every kind in ["integration", "navigator"] {
		every risk in ["low", "medium"] {
			not approval.agent_high_risk_requires_approval with input as fx.with_patch({
				"principal": {"kind": kind},
				"context": {"origin": "human"},
				"request": {"risk": risk},
			})
		}
	}
}

test_agent_high_risk_needs_an_editor if {
	r := approval.agent_high_risk_requires_approval with input as fx.with_patch({
		"context": {"origin": "agent"},
		"request": {"risk": "high"},
	})
	r.code == "agent_high_risk_requires_approval"
	r.requirement == editor
}

test_navigator_critical_risk_needs_approval if {
	approval.agent_high_risk_requires_approval.code == "agent_high_risk_requires_approval" with input as fx.with_patch({
		"context": {"origin": "navigator"},
		"request": {"risk": "critical"},
	})
}

test_agent_low_and_medium_risk_are_not_gated_by_this_rule if {
	every risk in ["low", "medium"] {
		not approval.agent_high_risk_requires_approval with input as fx.with_patch({
			"context": {"origin": "agent"},
			"request": {"risk": risk},
		})
	}
}

test_humans_and_system_are_not_gated_by_agent_rule if {
	every origin in ["human", "system", "reconciler"] {
		not approval.agent_high_risk_requires_approval with input as fx.with_patch({
			"context": {"origin": origin},
			"request": {"risk": "critical"},
		})
	}
}

test_agent_effective_risk_is_raised_by_production_stateful_targets if {
	approval.agent_high_risk_requires_approval.code == "agent_high_risk_requires_approval" with input as fx.with_patch(object.union(fx.production, {
		"context": {"origin": "agent"},
		"resource": {"stateful": true},
	}))
}

test_agent_effective_risk_is_not_raised_outside_production if {
	not approval.agent_high_risk_requires_approval with input as fx.with_patch({
		"context": {"origin": "agent"},
		"resource": {"stateful": true},
	})
}

# --------------------------------------- production_destructive_requires_admin

test_production_destructive_needs_admin_and_a_second_person if {
	r := approval.production_destructive_requires_admin with input as fx.with_patch(object.union(fx.production, {"request": {"capability": "infrastructure.destroy", "destructive": true, "risk": "critical"}}))
	r.code == "production_destructive_requires_admin"
	r.requirement == {"count": 1, "minRole": "admin", "separationOfDuties": true}
}

test_destructive_outside_production_is_not_admin_gated if {
	not approval.production_destructive_requires_admin with input as fx.with_patch({"request": {"destructive": true}})
}

test_production_non_destructive_is_not_gated_by_destructive_rule if {
	not approval.production_destructive_requires_admin with input as fx.with_patch(fx.production)
}
