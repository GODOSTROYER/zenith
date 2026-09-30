# METADATA
# title: Shared test fixtures
# description: Base inputs for the rule and decision tests. Test-only; excluded from the wasm bundle.
package zenith.fixtures_test

import rego.v1

# An editor asking a human-approved-by-autonomy, ordinary change (restart a
# service, defaultAutonomy 3) in a development environment at autonomy 4. With
# no overrides this is allowed with no approval and no constraints.
base := {
	"version": 1,
	"request": {
		"capability": "service.restart",
		"risk": "medium",
		"mutates": true,
		"destructive": false,
		"escapeHatch": false,
		"defaultAutonomy": 3,
		"integrationScope": "write",
		"scope": {
			"workspaceId": "ws_1",
			"projectId": "prj_1",
			"environmentId": "env_1",
			"resourceId": "res_1",
		},
	},
	"principal": {"kind": "user", "id": "usr_1", "role": "editor"},
	"environment": {
		"id": "env_1",
		"class": "development",
		"autonomyLevel": 4,
		"provider": "aws",
		"region": "us-east-1",
	},
	"resource": {
		"address": "aws_ecs_service.web",
		"kind": "service",
		"stateful": false,
		"ownership": "managed",
		"publiclyExposed": false,
	},
	"workspacePolicy": {
		"costApprovalThresholdUsd": 50,
		"allowEscapeHatchInProduction": false,
		"twoPersonProduction": false,
		"autoRemediation": {
			"sandbox": "any",
			"development": "any",
			"staging": "safe",
			"production": "none",
		},
		"deniedCapabilities": [],
	},
	"context": {"now": "2026-09-30T00:00:00Z", "origin": "human"},
}

empty_plan := {
	"create": 0,
	"update": 0,
	"delete": 0,
	"replace": 0,
	"destroysData": false,
	"destroyedStatefulAddresses": [],
	"regions": [],
	"publicDatabases": [],
	"openIngress": [],
	"wildcardIam": [],
	"identityChanges": [],
	"firewallChanges": [],
	"dnsChanges": [],
}

# The base input with `patch` deep-merged over it (arrays are replaced).
with_patch(patch) := object.union(base, patch)

# The base input with the given JSON paths removed.
without(paths) := json.remove(base, paths)

# A plan-fact document: an empty plan with `patch` merged in.
plan(patch) := object.union(empty_plan, patch)

# The set of reason codes in a decision.
codes(decision) := {reason.code | some reason in decision.reasons}

# Production environment at maximum autonomy: only policy rules, not autonomy,
# gate the request.
production := {"environment": {"class": "production", "autonomyLevel": 5}}

# Request attributes for the capabilities the decision tests use, exactly as the
# catalog (src/lib/capabilities/catalog.ts) declares them.
catalog := {
	"service.restart": {"capability": "service.restart", "risk": "medium", "mutates": true, "destructive": false, "escapeHatch": false, "defaultAutonomy": 3, "integrationScope": "write"},
	"infrastructure.apply": {"capability": "infrastructure.apply", "risk": "high", "mutates": true, "destructive": false, "escapeHatch": false, "defaultAutonomy": 5, "integrationScope": "write"},
	"infrastructure.destroy": {"capability": "infrastructure.destroy", "risk": "critical", "mutates": true, "destructive": true, "escapeHatch": false, "defaultAutonomy": 6, "integrationScope": "write"},
	"deployment.deploy": {"capability": "deployment.deploy", "risk": "high", "mutates": true, "destructive": false, "escapeHatch": false, "defaultAutonomy": 4, "integrationScope": "write"},
	"drift.repair": {"capability": "drift.repair", "risk": "high", "mutates": true, "destructive": false, "escapeHatch": false, "defaultAutonomy": 4, "integrationScope": "write"},
	"firewall.modify": {"capability": "firewall.modify", "risk": "high", "mutates": true, "destructive": false, "escapeHatch": false, "defaultAutonomy": 5, "integrationScope": "write"},
	"database.delete": {"capability": "database.delete", "risk": "critical", "mutates": true, "destructive": true, "escapeHatch": false, "defaultAutonomy": 6, "integrationScope": "write"},
	"machine.exec": {"capability": "machine.exec", "risk": "critical", "mutates": true, "destructive": false, "escapeHatch": true, "defaultAutonomy": 6, "integrationScope": "write"},
	"logs.read": {"capability": "logs.read", "risk": "low", "mutates": false, "destructive": false, "escapeHatch": false, "defaultAutonomy": 0, "integrationScope": "logs"},
	"infrastructure.plan": {"capability": "infrastructure.plan", "risk": "low", "mutates": false, "destructive": false, "escapeHatch": false, "defaultAutonomy": 1, "integrationScope": "plan"},
}

# `patch` deep-merged over the base input, with the request replaced by the
# named catalog capability.
for_capability(name, patch) := object.union(object.union(base, {"request": catalog[name]}), patch)
