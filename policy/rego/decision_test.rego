# METADATA
# title: Tests for zenith.decision (precedence, merging, scenarios)
package zenith.decision_test

import rego.v1

import data.zenith.decision
import data.zenith.fixtures_test as fx

prod := fx.production

# ------------------------------------------------------------------ allow

test_ordinary_change_is_allowed_without_approval_or_constraints if {
	r := decision.result with input as fx.base
	r.outcome == "allow"
	fx.codes(r) == {"allowed_within_policy"}
	not r.approval
	not r.constraints
}

test_read_only_capability_is_allowed_for_a_viewer if {
	r := decision.result with input as fx.for_capability("infrastructure.plan", {"principal": {"role": "viewer"}, "environment": {"autonomyLevel": 0}})
	r.outcome == "allow"
	fx.codes(r) == {"allowed_read_only"}
}

test_read_only_capability_never_needs_approval_at_any_autonomy if {
	every level in [0, 1, 2, 3, 4, 5] {
		r := decision.result with input as fx.for_capability("infrastructure.plan", {"environment": {"autonomyLevel": level}})
		r.outcome == "allow"
	}
}

test_allow_reasons_name_their_rule if {
	r := decision.result with input as fx.base
	r.reasons == [{
		"code": "allowed_within_policy",
		"message": "The change is within the environment's autonomy level and the workspace policy.",
		"rule": "zenith.decision.allow",
	}]
}

# ------------------------------------------------------------------- deny

test_production_database_delete_is_denied if {
	r := decision.result with input as fx.for_capability("database.delete", {"environment": {"class": "production", "autonomyLevel": 5}, "principal": {"role": "admin"}})
	r.outcome == "deny"
	fx.codes(r) == {"production_database_delete"}
}

test_production_database_delete_is_denied_even_for_admins_with_full_autonomy if {
	r := decision.result with input as fx.for_capability("database.delete", {"environment": {"class": "production", "autonomyLevel": 5}, "principal": {"role": "admin"}, "workspacePolicy": {"twoPersonProduction": true}})
	r.outcome == "deny"
	not r.approval
}

test_database_delete_outside_production_needs_approval_not_denial if {
	r := decision.result with input as fx.for_capability("database.delete", {"environment": {"class": "staging", "autonomyLevel": 5}})
	r.outcome == "require_approval"
	fx.codes(r) == {"autonomy_below_capability"}
}

test_public_database_is_denied if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {"environment": {"autonomyLevel": 5}, "plan": fx.plan({"publicDatabases": ["aws_db_instance.main"]})})
	r.outcome == "deny"
	fx.codes(r) == {"public_database"}
}

test_wildcard_iam_is_denied if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {"environment": {"autonomyLevel": 5}, "plan": fx.plan({"wildcardIam": ["aws_iam_policy.admin#statement[0]"]})})
	r.outcome == "deny"
	fx.codes(r) == {"wildcard_iam"}
}

test_region_outside_approved_regions_is_denied if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {
		"environment": {"autonomyLevel": 5},
		"workspacePolicy": {"approvedRegions": ["us-east-1"]},
		"plan": fx.plan({"regions": ["ap-southeast-2"]}),
	})
	r.outcome == "deny"
	fx.codes(r) == {"region_not_approved"}
}

test_viewer_mutation_is_denied if {
	r := decision.result with input as fx.with_patch({"principal": {"role": "viewer"}})
	r.outcome == "deny"
	fx.codes(r) == {"viewer_cannot_mutate"}
}

test_non_member_is_denied_even_for_reads if {
	r := decision.result with input as fx.for_capability("logs.read", {"principal": {"role": "none"}})
	r.outcome == "deny"
	fx.codes(r) == {"no_workspace_role"}
}

test_integration_missing_scope_is_denied if {
	r := decision.result with input as fx.with_patch({"principal": {"kind": "integration", "integrationScopes": ["read", "plan"]}})
	r.outcome == "deny"
	fx.codes(r) == {"integration_scope_missing"}
}

test_integration_with_scope_is_allowed if {
	r := decision.result with input as fx.with_patch({"principal": {"kind": "integration", "integrationScopes": ["read", "write"]}})
	r.outcome == "allow"
}

test_referenced_resource_mutation_is_denied if {
	r := decision.result with input as fx.with_patch({"resource": {"ownership": "referenced"}})
	r.outcome == "deny"
	fx.codes(r) == {"unowned_resource_mutation"}
}

test_external_resource_may_still_be_read if {
	r := decision.result with input as fx.for_capability("logs.read", {"resource": {"ownership": "external"}})
	r.outcome == "allow"
}

test_workspace_denied_capability_wins_over_everything if {
	r := decision.result with input as fx.with_patch({"workspacePolicy": {"deniedCapabilities": ["service.restart"]}, "principal": {"role": "admin"}})
	r.outcome == "deny"
	fx.codes(r) == {"workspace_denied_capability"}
}

test_production_apply_that_destroys_data_is_denied if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {
		"environment": {"class": "production", "autonomyLevel": 5},
		"plan": fx.plan({"destroysData": true, "destroyedStatefulAddresses": ["aws_db_instance.main"]}),
	})
	r.outcome == "deny"
	fx.codes(r) == {"production_destroys_data"}
}

test_mutation_without_environment_is_denied if {
	r := decision.result with input as json.remove(fx.base, ["environment"])
	r.outcome == "deny"
	fx.codes(r) == {"mutation_environment_unresolved"}
}

test_production_exec_is_denied_by_default if {
	r := decision.result with input as fx.for_capability("machine.exec", {"environment": {"class": "production", "autonomyLevel": 5}, "principal": {"role": "admin"}})
	r.outcome == "deny"
	fx.codes(r) == {"escape_hatch_denied_in_production"}
}

test_multiple_denials_are_all_reported_sorted_by_code if {
	r := decision.result with input as fx.with_patch({
		"principal": {"role": "viewer", "kind": "integration", "integrationScopes": ["read"]},
		"resource": {"ownership": "external"},
		"workspacePolicy": {"deniedCapabilities": ["service.restart"]},
	})
	r.outcome == "deny"
	[reason.code | some reason in r.reasons] == [
		"integration_scope_missing",
		"unowned_resource_mutation",
		"viewer_cannot_mutate",
		"workspace_denied_capability",
	]
}

test_deny_reasons_carry_their_rule_path if {
	r := decision.result with input as fx.with_patch({"principal": {"role": "viewer"}})
	r.reasons == [{
		"code": "viewer_cannot_mutate",
		"message": "Viewers cannot run capabilities that change anything.",
		"rule": "zenith.rules.deny.viewer_cannot_mutate",
	}]
}

# ------------------------------------------------------------ require_approval

test_production_firewall_change_needs_admin_approval if {
	r := decision.result with input as fx.for_capability("firewall.modify", {"environment": {"class": "production", "autonomyLevel": 5}})
	r.outcome == "require_approval"
	r.approval == {"count": 1, "minRole": "admin", "separationOfDuties": false}
	fx.codes(r) == {"production_network_identity_change"}
}

test_production_plan_that_changes_a_firewall_needs_admin_approval if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {
		"environment": {"class": "production", "autonomyLevel": 5},
		"plan": fx.plan({"firewallChanges": ["aws_security_group.web"]}),
	})
	r.outcome == "require_approval"
	r.approval.minRole == "admin"
}

test_cost_threshold_needs_editor_approval if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {"environment": {"autonomyLevel": 5}, "plan": fx.plan({"costDeltaUsdMonthly": 75})})
	r.outcome == "require_approval"
	r.approval == {"count": 1, "minRole": "editor", "separationOfDuties": false}
	fx.codes(r) == {"cost_threshold_exceeded"}
}

test_cost_below_threshold_is_allowed if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {"environment": {"autonomyLevel": 5}, "plan": fx.plan({"costDeltaUsdMonthly": 49})})
	r.outcome == "allow"
}

test_budget_overrun_needs_admin_approval_not_denial if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {
		"environment": {"autonomyLevel": 5},
		"workspacePolicy": {"budgetUsdMonthly": 500},
		"plan": fx.plan({"projectedMonthlyUsd": 800, "costDeltaUsdMonthly": 10}),
	})
	r.outcome == "require_approval"
	r.approval.minRole == "admin"
	fx.codes(r) == {"budget_exceeded"}
}

test_open_ingress_needs_admin_approval if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {
		"environment": {"autonomyLevel": 5},
		"plan": fx.plan({"openIngress": [{"address": "aws_security_group.web", "port": "22", "cidr": "0.0.0.0/0"}]}),
	})
	r.outcome == "require_approval"
	r.approval.minRole == "admin"
	fx.codes(r) == {"open_ingress"}
}

test_autonomy_below_capability_needs_editor_approval if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {"environment": {"autonomyLevel": 3}})
	r.outcome == "require_approval"
	r.approval == {"count": 1, "minRole": "editor", "separationOfDuties": false}
	fx.codes(r) == {"autonomy_below_capability"}
}

test_production_exec_is_allowed_with_admin_approval_when_the_workspace_enables_it if {
	r := decision.result with input as fx.for_capability("machine.exec", {
		"environment": {"class": "production", "autonomyLevel": 5},
		"principal": {"role": "admin"},
		"workspacePolicy": {"allowEscapeHatchInProduction": true},
	})
	r.outcome == "require_approval"
	r.approval == {"count": 1, "minRole": "admin", "separationOfDuties": true}
	fx.codes(r) == {"autonomy_below_capability", "escape_hatch_requires_approval"}
	r.constraints == {"timeoutSec": 300, "maxOutputBytes": 1048576}
}

test_exec_outside_production_still_needs_admin_approval if {
	r := decision.result with input as fx.for_capability("machine.exec", {"environment": {"class": "development", "autonomyLevel": 5}})
	r.outcome == "require_approval"
	r.approval == {"count": 1, "minRole": "admin", "separationOfDuties": false}
}

test_two_person_rule_adds_separation_of_duties_to_production_changes if {
	r := decision.result with input as fx.for_capability("deployment.deploy", {
		"environment": {"class": "production", "autonomyLevel": 5},
		"workspacePolicy": {"twoPersonProduction": true},
	})
	r.outcome == "require_approval"
	r.approval == {"count": 1, "minRole": "editor", "separationOfDuties": true}
	fx.codes(r) == {"two_person_production"}
}

test_production_change_without_two_person_rule_at_full_autonomy_is_allowed if {
	r := decision.result with input as fx.for_capability("deployment.deploy", {"environment": {"class": "production", "autonomyLevel": 5}})
	r.outcome == "allow"
}

test_agent_high_risk_needs_editor_approval_even_at_full_autonomy if {
	r := decision.result with input as fx.for_capability("deployment.deploy", {"environment": {"autonomyLevel": 5}, "context": {"origin": "agent"}})
	r.outcome == "require_approval"
	r.approval == {"count": 1, "minRole": "editor", "separationOfDuties": false}
	fx.codes(r) == {"agent_high_risk_requires_approval"}
}

test_agent_low_risk_change_runs_within_autonomy if {
	r := decision.result with input as fx.with_patch({"context": {"origin": "agent"}, "request": {"risk": "low"}})
	r.outcome == "allow"
}

test_production_destroy_needs_admin_and_a_second_person_and_is_not_denied if {
	r := decision.result with input as fx.for_capability("infrastructure.destroy", {
		"environment": {"class": "production", "autonomyLevel": 5},
		"principal": {"role": "admin"},
		"plan": fx.plan({"delete": 4, "destroysData": true, "destroyedStatefulAddresses": ["aws_s3_bucket.assets"]}),
	})
	r.outcome == "require_approval"
	r.approval == {"count": 1, "minRole": "admin", "separationOfDuties": true}
}

test_unresolved_security_values_need_editor_approval_at_full_autonomy if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {"environment": {"autonomyLevel": 5}, "plan": fx.plan({"unresolved": ["aws_iam_role_policy.app:policy"]})})
	r.outcome == "require_approval"
	fx.codes(r) == {"unresolved_security_attributes"}
}

# ----------------------------------------------------- reconciler / remediation

test_development_auto_remediation_is_allowed_at_autonomy_four if {
	r := decision.result with input as fx.for_capability("drift.repair", {
		"principal": {"kind": "system", "role": "none"},
		"context": {"origin": "reconciler"},
		"environment": {"class": "development", "autonomyLevel": 4},
	})
	r.outcome == "allow"
}

test_development_auto_remediation_needs_approval_below_autonomy_four if {
	r := decision.result with input as fx.for_capability("drift.repair", {
		"principal": {"kind": "system", "role": "none"},
		"context": {"origin": "reconciler"},
		"environment": {"class": "development", "autonomyLevel": 3},
	})
	r.outcome == "require_approval"
	fx.codes(r) == {"autonomy_below_capability"}
}

test_production_auto_remediation_defaults_to_approval if {
	r := decision.result with input as fx.for_capability("drift.repair", {
		"principal": {"kind": "system", "role": "none"},
		"context": {"origin": "reconciler"},
		"environment": {"class": "production", "autonomyLevel": 5},
	})
	r.outcome == "require_approval"
	fx.codes(r) == {"auto_remediation_disabled"}
}

test_production_safe_auto_remediation_allows_a_plain_medium_risk_restart if {
	r := decision.result with input as fx.for_capability("service.restart", {
		"principal": {"kind": "system", "role": "none"},
		"context": {"origin": "reconciler"},
		"environment": {"class": "production", "autonomyLevel": 5},
		"workspacePolicy": {"autoRemediation": {"production": "safe"}},
	})
	r.outcome == "allow"
}

test_production_safe_auto_remediation_asks_when_the_target_is_stateful if {
	# Policy lifts a production mutation of a stateful resource to high risk, so
	# "safe" auto-remediation no longer covers it.
	r := decision.result with input as fx.for_capability("service.restart", {
		"principal": {"kind": "system", "role": "none"},
		"context": {"origin": "reconciler"},
		"environment": {"class": "production", "autonomyLevel": 5},
		"resource": {"stateful": true},
		"workspacePolicy": {"autoRemediation": {"production": "safe"}},
	})
	r.outcome == "require_approval"
	fx.codes(r) == {"auto_remediation_not_safe"}
}

test_production_safe_auto_remediation_allows_a_plain_low_risk_change if {
	r := decision.result with input as fx.with_patch({
		"principal": {"kind": "system", "role": "none"},
		"context": {"origin": "reconciler"},
		"environment": {"class": "production", "autonomyLevel": 5},
		"request": {"risk": "low", "capability": "service.restart"},
		"workspacePolicy": {"autoRemediation": {"production": "safe"}},
	})
	r.outcome == "allow"
}

test_staging_safe_auto_remediation_refuses_high_risk_repairs if {
	r := decision.result with input as fx.for_capability("drift.repair", {
		"principal": {"kind": "system", "role": "none"},
		"context": {"origin": "reconciler"},
		"environment": {"class": "staging", "autonomyLevel": 5},
	})
	r.outcome == "require_approval"
	fx.codes(r) == {"auto_remediation_not_safe"}
}

test_system_principal_is_not_denied_for_lacking_a_workspace_role if {
	r := decision.result with input as fx.with_patch({"principal": {"kind": "system", "role": "none"}, "context": {"origin": "system"}})
	r.outcome == "allow"
}

# ------------------------------------------------------------ precedence

test_deny_wins_over_every_approval_requirement if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {
		"environment": {"autonomyLevel": 0},
		"context": {"origin": "agent"},
		"plan": fx.plan({
			"publicDatabases": ["aws_db_instance.main"],
			"costDeltaUsdMonthly": 900,
			"openIngress": [{"address": "aws_security_group.web", "port": "22", "cidr": "0.0.0.0/0"}],
		}),
	})
	r.outcome == "deny"
	fx.codes(r) == {"public_database"}
	not r.approval
}

test_a_denial_carries_no_constraints if {
	r := decision.result with input as fx.for_capability("logs.read", {"workspacePolicy": {"deniedCapabilities": ["logs.read"]}})
	r.outcome == "deny"
	not r.constraints
}

test_approval_beats_allow_and_reports_only_approval_reasons if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {"environment": {"autonomyLevel": 4}})
	r.outcome == "require_approval"
	not fx.codes(r).allowed_within_policy
}

# --------------------------------------------------------- approval merging

test_approval_merge_takes_max_role_and_or_of_separation if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {
		"environment": {"class": "production", "autonomyLevel": 3},
		"workspacePolicy": {"twoPersonProduction": true},
		"plan": fx.plan({"costDeltaUsdMonthly": 60, "openIngress": [{"address": "a", "port": "22", "cidr": "0.0.0.0/0"}]}),
	})
	r.outcome == "require_approval"

	# editor (autonomy, cost), admin (open ingress), separation of duties (two-person)
	r.approval == {"count": 1, "minRole": "admin", "separationOfDuties": true}
	fx.codes(r) == {"autonomy_below_capability", "cost_threshold_exceeded", "open_ingress", "two_person_production"}
}

test_approval_merge_with_only_editor_requirements_stays_editor if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {
		"environment": {"autonomyLevel": 3},
		"plan": fx.plan({"costDeltaUsdMonthly": 60}),
	})
	r.approval == {"count": 1, "minRole": "editor", "separationOfDuties": false}
}

test_approval_reasons_are_sorted_and_name_their_rules if {
	r := decision.result with input as fx.for_capability("infrastructure.apply", {
		"environment": {"autonomyLevel": 3},
		"plan": fx.plan({"costDeltaUsdMonthly": 60}),
	})
	[reason.rule | some reason in r.reasons] == [
		"zenith.rules.approval.autonomy_below_capability",
		"zenith.rules.approval.cost_threshold_exceeded",
	]
}

# ------------------------------------------------------------- constraints

test_log_reads_are_restricted if {
	r := decision.result with input as fx.for_capability("logs.read", {"principal": {"role": "viewer"}})
	r.outcome == "allow"
	r.constraints == {"maxLines": 1000, "maxWindowHours": 24}
}

test_requested_narrowing_is_respected if {
	r := decision.result with input as fx.for_capability("logs.read", {"request": {"constraints": {"maxLines": 100}}})
	r.constraints == {"maxLines": 100, "maxWindowHours": 24}
}

test_constraints_accompany_require_approval if {
	r := decision.result with input as fx.for_capability("machine.exec", {"environment": {"class": "development", "autonomyLevel": 5}})
	r.outcome == "require_approval"
	r.constraints == {"timeoutSec": 300, "maxOutputBytes": 1048576}
}

test_grant_duration_is_capped_for_critical_work if {
	r := decision.result with input as fx.for_capability("infrastructure.destroy", {
		"environment": {"class": "development", "autonomyLevel": 5},
		"request": {"requestedDurationSec": 3600},
	})
	r.constraints == {"grantDurationSec": 900}
}

test_constraints_from_several_rules_are_merged if {
	r := decision.result with input as fx.for_capability("logs.read", {"request": {"requestedDurationSec": 7200}})
	r.constraints == {"maxLines": 1000, "maxWindowHours": 24, "grantDurationSec": 3600}
}

# ------------------------------------------------------------ determinism

test_evaluation_is_deterministic if {
	input_doc := fx.for_capability("infrastructure.apply", {
		"environment": {"class": "production", "autonomyLevel": 3},
		"plan": fx.plan({"costDeltaUsdMonthly": 60, "openIngress": [{"address": "a", "port": "22", "cidr": "0.0.0.0/0"}]}),
	})
	first := decision.result with input as input_doc
	second := decision.result with input as input_doc
	first == second
	json.marshal(first) == json.marshal(second)
}

test_result_ignores_the_clock if {
	earlier := decision.result with input as fx.with_patch({"context": {"now": "2020-01-01T00:00:00Z"}})
	later := decision.result with input as fx.with_patch({"context": {"now": "2099-12-31T23:59:59Z"}})
	earlier == later
}
