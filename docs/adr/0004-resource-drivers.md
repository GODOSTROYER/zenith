# ADR-0004 — Resource-oriented drivers

Status: accepted (2026-09-30)

## Decision
A provider is a registry of `ResourceDriver`s keyed by (provider, native
type) (`src/lib/drivers/types.ts`): `compile` (OpenTofu JSON), `observe`,
`runtime`, `verify`, `discover`, `expectedAttributes`, and `operations` for
day-two capabilities. Each driver declares per-operation evidence
(`real | emulated | contract | simulated`); the capability matrix in the docs
is generated from those declarations, not hand-written.
The existing `ProviderAdapter` interface remains for the engine path.

## Consequences
AWS cannot become one giant switch; GCP/Azure/OCI/Kubernetes implement the
same interface and reuse all agent, policy, workflow and incident logic.
