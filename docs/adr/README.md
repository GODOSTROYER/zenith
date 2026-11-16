# Architecture decision records

- [ADR-0001](0001-evolve-not-rewrite.md) — Evolve Zenith into a control plane; do not rewrite it
- [ADR-0002](0002-platform-control-store.md) — Platform control store: Postgres schema `platform`, PGlite locally
- [ADR-0003](0003-resource-model-v2.md) — Manifest V2 and the portable resource graph
- [ADR-0004](0004-resource-drivers.md) — Resource-oriented drivers
- [ADR-0005](0005-opentofu-hybrid.md) — OpenTofu for declarative lifecycle, native APIs for day two
- [ADR-0006](0006-credential-broker.md) — Keyless credential brokering
- [ADR-0007](0007-capability-broker-and-autonomy.md) — Capability broker, approvals and autonomy levels
- [ADR-0008](0008-policy-opa-wasm.md) — Policy as code: OPA/Rego compiled to WebAssembly
- [ADR-0009](0009-temporal-workflows.md) — Temporal for long-running orchestration
- [ADR-0010](0010-go-runner-and-zenithd.md) — Go for zenith-runner and zenithd; signed outbound protocol
- [ADR-0011](0011-observability-federated.md) — Federated, normalized observability
- [ADR-0012](0012-machine-plane.md) — One semantic machine plane
- [ADR-0013](0013-placement-and-cost.md) — Deterministic placement and costed estimates
- [ADR-0014](0014-incident-engine.md) — Evidence-first incident investigation
- [ADR-0015](0015-kubernetes-ownership.md) — Kubernetes: server-side apply with explicit ownership
- [ADR-0016](0016-builds-in-customer-account.md) — Source builds run in the customer's account

Earlier decisions: `docs/ARCHITECTURE.md` (ADRs 1–7), `docs/production-hardening/ADR.md` (D-1…D-15), `docs/hosted/DECISIONS.md` (R3-*).
