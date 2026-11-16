# METADATA
# title: Tests for zenith.lib helpers and fail-closed behaviour
package zenith.lib_test

import rego.v1

import data.zenith.decision
import data.zenith.fixtures_test as fx
import data.zenith.lib

# ------------------------------------------------------------- fail closed

test_empty_input_is_denied if {
	r := decision.result with input as {}
	r.outcome == "deny"
	fx.codes(r) == {"malformed_input", "no_workspace_role", "mutation_environment_unresolved"}
}

test_garbage_input_is_denied if {
	r := decision.result with input as {"request": "nope", "principal": 7, "environment": [], "workspacePolicy": null}
	r.outcome == "deny"
	"malformed_input" in fx.codes(r)
}

test_missing_mutates_is_treated_as_a_mutation if {
	lib.mutating with input as json.remove(fx.base, ["request/mutates"])
	not lib.mutating with input as fx.with_patch({"request": {"mutates": false}})
}

test_unknown_risk_is_treated_as_critical if {
	lib.base_risk_rank == 3 with input as fx.with_patch({"request": {"risk": "apocalyptic"}})
	lib.base_risk_rank == 3 with input as json.remove(fx.base, ["request/risk"])
}

# ------------------------------------------------------------- effective risk

test_effective_risk_is_the_catalog_risk_by_default if {
	lib.effective_risk_rank == 1 with input as fx.base
}

test_effective_risk_is_raised_to_high_in_production_for_sensitive_targets if {
	lib.effective_risk_rank == 2 with input as fx.with_patch(object.union(fx.production, {"resource": {"stateful": true}}))
	lib.effective_risk_rank == 2 with input as fx.with_patch(object.union(fx.production, {"resource": {"publiclyExposed": true}}))
	lib.effective_risk_rank == 2 with input as fx.with_patch(object.union(fx.production, {"plan": fx.plan({"destroysData": true})}))
}

test_effective_risk_is_never_lowered if {
	lib.effective_risk_rank == 3 with input as fx.with_patch(object.union(fx.production, {"request": {"risk": "critical"}, "resource": {"stateful": true}}))
}

test_effective_risk_is_not_raised_outside_production_or_for_reads if {
	lib.effective_risk_rank == 1 with input as fx.with_patch({"environment": {"class": "staging"}, "resource": {"stateful": true}})
	lib.effective_risk_rank == 0 with input as fx.with_patch(object.union(fx.production, {"request": {"risk": "low", "mutates": false}, "resource": {"stateful": true}}))
}

# --------------------------------------------------------------- narrowing

test_narrow_only_lowers_ceilings if {
	lib.narrow({"a": 10, "b": 5}) == {"a": 3, "b": 5} with input as fx.with_patch({"request": {"constraints": {"a": 3, "b": 50}}})
}

test_narrow_ignores_non_numbers_and_non_positive_values if {
	lib.narrow({"a": 10}) == {"a": 10} with input as fx.with_patch({"request": {"constraints": {"a": "3"}}})
	lib.narrow({"a": 10}) == {"a": 10} with input as fx.with_patch({"request": {"constraints": {"a": 0}}})
	lib.narrow({"a": 10}) == {"a": 10} with input as fx.with_patch({"request": {"constraints": {"a": -1}}})
	lib.narrow({"a": 10}) == {"a": 10} with input as fx.base
}

# ---------------------------------------------------------------- durations

test_clamp_duration if {
	lib.clamp_duration(60) == 60 with input as fx.base
	lib.clamp_duration(7200) == 3600 with input as fx.base
	lib.clamp_duration(7200) == 900 with input as fx.with_patch({"request": {"risk": "critical"}})
	lib.clamp_duration(0) == 3600 with input as fx.base
	lib.clamp_duration("x") == 3600 with input as fx.base
}

# ------------------------------------------------------------ plan accessors

test_plan_accessors_are_empty_without_a_plan if {
	lib.plan_list("regions") == [] with input as fx.base
	lib.plan_count("openIngress") == 0 with input as fx.base
	lib.plan_count("openIngress") == 1 with input as fx.with_patch({"plan": fx.plan({"openIngress": [{}]})})
}

test_checked_regions_combine_plan_and_environment_for_non_destructive_mutations if {
	lib.checked_regions == {"eu-west-1", "us-east-1"} with input as fx.with_patch({"plan": fx.plan({"regions": ["eu-west-1"]})})
	lib.checked_regions == {"eu-west-1"} with input as fx.with_patch({"plan": fx.plan({"regions": ["eu-west-1"]}), "request": {"destructive": true}})
	lib.checked_regions == set() with input as fx.with_patch({"request": {"mutates": false}})
}

# ---------------------------------------------------------- well-formedness

test_the_base_input_is_well_formed if {
	lib.well_formed with input as fx.base
	lib.well_formed with input as fx.with_patch({"plan": fx.plan({"costDeltaUsdMonthly": 1, "projectedMonthlyUsd": 2, "unresolved": ["x"]})})
	lib.well_formed with input as fx.with_patch({"workspacePolicy": {"approvedRegions": ["us-east-1"], "budgetUsdMonthly": 100}})
}

test_optional_sections_may_be_absent if {
	lib.well_formed with input as json.remove(fx.base, ["environment", "resource", "plan"])
}

test_malformed_documents_are_not_well_formed if {
	not lib.well_formed with input as fx.with_patch({"version": 2})
	not lib.well_formed with input as json.remove(fx.base, ["request/mutates"])
	not lib.well_formed with input as fx.with_patch({"request": {"defaultAutonomy": "3"}})
	not lib.well_formed with input as fx.with_patch({"principal": {"role": 3}})
	not lib.well_formed with input as json.remove(fx.base, ["workspacePolicy/deniedCapabilities"])
	not lib.well_formed with input as fx.with_patch({"workspacePolicy": {"approvedRegions": "us-east-1"}})
	not lib.well_formed with input as fx.with_patch({"environment": {"autonomyLevel": "high"}})
	not lib.well_formed with input as fx.with_patch({"resource": {"ownership": 1}})
	not lib.well_formed with input as fx.with_patch({"plan": fx.plan({"openIngress": "0.0.0.0/0"})})
	not lib.well_formed with input as fx.with_patch({"plan": fx.plan({"costDeltaUsdMonthly": "50"})})
	not lib.well_formed with input as json.remove(fx.base, ["context/origin"])
}

test_a_malformed_document_is_denied_with_malformed_input if {
	r := decision.result with input as fx.with_patch({"plan": fx.plan({"publicDatabases": "yes"})})
	r.outcome == "deny"
	"malformed_input" in fx.codes(r)
}
