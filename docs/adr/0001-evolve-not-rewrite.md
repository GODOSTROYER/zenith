# ADR-0001 — Evolve Zenith into a control plane; do not rewrite it

Status: accepted (2026-09-30)

## Context
Zenith already has a canonical manifest, a typed action registry that every
surface calls, a durable (single-step, tick-driven) deployment engine, honest
provider availability labels, a Postgres product store, a hosted-apps
subsystem with real transactions, and an agent-control journal with digest-
bound approvals and fenced claims. It lacks: real cloud execution, credential
brokering, resource-level drivers, persisted observed/runtime state, policy
as code, durable long-running workflows and a machine plane.

## Decision
Add the control plane beside the existing product, not instead of it:
- The manifest stays; V2 is a strict superset with an explicit, lossless
  migration (ADR-0003). V1 projects keep working untouched.
- The action registry stays the mutation path for product state. New
  infrastructure capabilities go through the capability broker (ADR-0007),
  which existing actions consult; there is one authorization path.
- The existing engine keeps running sandbox and LocalStack deployments. Real
  providers run through Temporal workflows (ADR-0009) that project progress
  onto the same `Deployment` records the UI already renders.
- The agent-control journal remains the v2 MCP path; v3 semantic tools use
  the capability broker and platform operations. Converging v2 onto platform
  operations is tracked debt, not a second design.

## Consequences
No existing API, manifest or stored project needs migration to keep working.
There are temporarily two execution paths (engine for simulated/emulated,
workflows for real clouds); each provider uses exactly one.
