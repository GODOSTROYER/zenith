# Test-only genuine OPA Wasm: undefined conversion would wrongly reach allow.
package vendor_precision
import rego.v1

allow := {"outcome": "allow", "reasons": [{"code": "fixture", "message": "Controlled test rule."}]}
deny := {"outcome": "deny", "reasons": [{"code": "fixture", "message": "Controlled test rule."}]}
default decision := {"outcome": "allow", "reasons": [{"code": "fixture", "message": "Controlled test rule."}]}

probe := sprintf(input.request.constraints.format, [input.request.constraints.value])

valid_precision if {
  sprintf(input.request.constraints.format, [input.request.constraints.value])
}

decision := deny if {
  input.request.constraints.variant == "default"
  valid_precision
}

decision := allow if {
  input.request.constraints.variant == "negation"
  not valid_precision
}

else_probe := deny if {
  sprintf(input.request.constraints.format, [input.request.constraints.value]) == "never"
} else := allow

decision := else_probe if {
  input.request.constraints.variant == "else"
}
