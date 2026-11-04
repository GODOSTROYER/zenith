# ADR-0008 — Policy as code: OPA/Rego compiled to WebAssembly

Status: accepted (2026-09-30)

## Decision
Rego policies in `policy/rego`, tested with `opa test`, compiled with a
pinned OPA (`opa build -t wasm`) into `policy/dist/policy.wasm`, committed with
a manifest (sha256, OPA version). Evaluated in-process with
`@open-policy-agent/opa-wasm` — deterministic, no sidecar, works serverless.
Workspace-tunable parameters (approved regions, cost threshold, two-person
rule, auto-remediation classes) are data, not code. Every decision stores
policy version (bundle sha256), input digest, outcome, reasons, approval
requirement and constraints. CI rebuilds the bundle and fails if the
committed wasm differs.
