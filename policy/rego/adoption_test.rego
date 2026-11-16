# METADATA
# title: Metadata adoption remains human-approved and cannot authorize provider writes
package zenith.adoption_test

import rego.v1
import data.zenith.decision
import data.zenith.fixtures_test as fx

adoption := fx.with_patch({
	"request": {"capability": "resource.adopt", "mutates": true, "risk": "high", "defaultAutonomy": 6, "destructive": false, "escapeHatch": false, "integrationScope": "write"},
	"resource": {"ownership": "referenced"},
})

test_adoption_requires_human_at_every_autonomy if {
	every level in [0, 1, 2, 3, 4, 5] {
		r := decision.result with input as object.union(adoption, {"environment": {"autonomyLevel": level}})
		r.outcome == "require_approval"
		r.approval.count >= 1
		"autonomy_below_capability" in fx.codes(r)
	}
}

test_adoption_never_exempts_external_or_unknown_ownership if {
	every ownership in ["external", "unknown", "adopted"] {
		r := decision.result with input as object.union(adoption, {"resource": {"ownership": ownership}})
		r.outcome == "deny"
		"unowned_resource_mutation" in fx.codes(r)
	}
}

test_other_capabilities_cannot_use_adoption_exception if {
	every capability in ["infrastructure.apply", "resource.release", "service.restart", "data.import"] {
		r := decision.result with input as object.union(adoption, {"request": {"capability": capability}})
		r.outcome == "deny"
		"unowned_resource_mutation" in fx.codes(r)
	}
}

test_changed_adoption_catalog_annotations_fail_closed if {
	every patch in [{"defaultAutonomy": 0}, {"risk": "low"}, {"destructive": true}, {"escapeHatch": true}, {"integrationScope": "read"}] {
		r := decision.result with input as object.union(adoption, {"request": patch})
		r.outcome == "deny"
		"unowned_resource_mutation" in fx.codes(r)
	}
}

test_viewer_cannot_adopt if {
	r := decision.result with input as object.union(adoption, {"principal": {"role": "viewer"}})
	r.outcome == "deny"
	"viewer_cannot_mutate" in fx.codes(r)
}

test_integration_without_write_scope_cannot_adopt if {
	r := decision.result with input as object.union(adoption, {"principal": {"kind": "integration", "integrationScopes": ["read", "plan"]}})
	r.outcome == "deny"
	"integration_scope_missing" in fx.codes(r)
}
