# METADATA
# title: Tests for zenith.rules.constraints
package zenith.rules.constraints_test

import rego.v1

import data.zenith.fixtures_test as fx
import data.zenith.rules.constraints

read_logs := {"request": {"capability": "logs.read", "mutates": false, "risk": "low", "defaultAutonomy": 0}}

test_base_input_has_no_constraints if {
	count(constraints) == 0 with input as fx.base
}

# ---------------------------------------------------------- log_read_limits

test_log_read_limits_apply_to_every_log_capability if {
	every capability in ["logs.read", "system.logs", "container.logs"] {
		constraints.log_read_limits == {"maxLines": 1000, "maxWindowHours": 24} with input as fx.with_patch({"request": {"capability": capability, "mutates": false, "risk": "low"}})
	}
}

test_log_read_limits_can_be_narrowed_by_the_requester if {
	constraints.log_read_limits == {"maxLines": 200, "maxWindowHours": 6} with input as fx.with_patch(object.union(read_logs, {"request": {"constraints": {"maxLines": 200, "maxWindowHours": 6}}}))
}

test_log_read_limits_cannot_be_widened_by_the_requester if {
	constraints.log_read_limits == {"maxLines": 1000, "maxWindowHours": 24} with input as fx.with_patch(object.union(read_logs, {"request": {"constraints": {"maxLines": 5000000, "maxWindowHours": 9999}}}))
}

test_log_read_limits_ignore_nonsense_requests if {
	constraints.log_read_limits == {"maxLines": 1000, "maxWindowHours": 24} with input as fx.with_patch(object.union(read_logs, {"request": {"constraints": {"maxLines": "all", "maxWindowHours": -3}}}))
	constraints.log_read_limits == {"maxLines": 1000, "maxWindowHours": 24} with input as fx.with_patch(object.union(read_logs, {"request": {"constraints": {"maxLines": 0}}}))
}

test_log_read_limits_keep_unrelated_request_keys_out if {
	constraints.log_read_limits == {"maxLines": 1000, "maxWindowHours": 24} with input as fx.with_patch(object.union(read_logs, {"request": {"constraints": {"window": "1h", "level": "error"}}}))
}

test_other_capabilities_have_no_log_limits if {
	not constraints.log_read_limits with input as fx.with_patch({"request": {"capability": "metrics.read", "mutates": false}})
}

# ---------------------------------------------------------------- exec_limits

test_exec_limits_apply_to_exec_capabilities if {
	every capability in ["machine.exec", "container.exec"] {
		constraints.exec_limits == {"timeoutSec": 300, "maxOutputBytes": 1048576} with input as fx.with_patch({"request": {"capability": capability, "escapeHatch": true}})
	}
}

test_exec_limits_can_be_narrowed_not_widened if {
	constraints.exec_limits == {"timeoutSec": 30, "maxOutputBytes": 1048576} with input as fx.with_patch({"request": {"capability": "machine.exec", "constraints": {"timeoutSec": 30, "maxOutputBytes": 99999999}}})
}

test_provider_native_is_not_an_exec_capability_for_limits if {
	not constraints.exec_limits with input as fx.with_patch({"request": {"capability": "provider.native", "escapeHatch": true}})
}

# ------------------------------------------------------------- grant_duration

test_no_requested_duration_no_duration_constraint if {
	not constraints.grant_duration with input as fx.base
}

test_short_requested_duration_is_kept if {
	constraints.grant_duration == {"grantDurationSec": 300} with input as fx.with_patch({"request": {"requestedDurationSec": 300}})
}

test_long_requested_duration_is_capped_at_one_hour if {
	constraints.grant_duration == {"grantDurationSec": 3600} with input as fx.with_patch({"request": {"requestedDurationSec": 86400}})
}

test_critical_risk_grants_are_capped_at_fifteen_minutes if {
	constraints.grant_duration == {"grantDurationSec": 900} with input as fx.with_patch({"request": {"risk": "critical", "requestedDurationSec": 3600}})
	constraints.grant_duration == {"grantDurationSec": 600} with input as fx.with_patch({"request": {"risk": "critical", "requestedDurationSec": 600}})
}

test_policy_raised_risk_reaches_high_never_critical_so_the_cap_stays_one_hour if {
	constraints.grant_duration == {"grantDurationSec": 3600} with input as fx.with_patch(object.union(fx.production, {
		"request": {"requestedDurationSec": 3600},
		"resource": {"stateful": true, "ownership": "managed"},
		"plan": fx.plan({"destroysData": true}),
	}))
}

test_invalid_requested_duration_falls_back_to_the_cap if {
	constraints.grant_duration == {"grantDurationSec": 3600} with input as fx.with_patch({"request": {"requestedDurationSec": -5}})
	constraints.grant_duration == {"grantDurationSec": 3600} with input as fx.with_patch({"request": {"requestedDurationSec": "forever"}})
}
