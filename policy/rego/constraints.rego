# METADATA
# title: Constraint ("restrict") rules
# description: |
#   Every rule in this package is a complete rule whose value is an object of
#   numeric ceilings the executor must enforce; it is defined only when the
#   request is subject to that restriction. The aggregator merges all defined
#   rules key by key, taking the minimum where two rules set the same key, and
#   attaches the result to allow / require_approval decisions (never to deny).
#
#   A requester's own narrower `request.constraints` values can lower a
#   ceiling, never raise it. Keep this package to constraint rules only.
package zenith.rules.constraints

import rego.v1

import data.zenith.lib

# Log reads are bounded in volume and in how far back they reach.
log_read_limits := lib.narrow({"maxLines": 1000, "maxWindowHours": 24}) if {
	input.request.capability in lib.log_capabilities
}

# Command execution is bounded in time and output size.
exec_limits := lib.narrow({"timeoutSec": 300, "maxOutputBytes": 1048576}) if {
	input.request.capability in lib.exec_capabilities
}

# A capability grant lives at most an hour (15 minutes for critical work); a
# request that asks for longer is shortened, not refused. Only present when the
# request named a duration.
grant_duration := {"grantDurationSec": lib.clamp_duration(input.request.requestedDurationSec)} if {
	input.request.requestedDurationSec
}
