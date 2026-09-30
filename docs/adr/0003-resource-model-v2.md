# ADR-0003 — Manifest V2 and the portable resource graph

Status: accepted (2026-09-30)

## Decision
- `ManifestV2` = V1's services/resources/routes/bindings with the same
  meaning, plus: `placement` (provider incl. `auto`, regions, zones),
  `constraints` (budget, availability target, latency, residency),
  `policies` (deletion, backup, availability, approval), per-node placement
  overrides for multi-cloud, `providerConfig` (typed per provider) and
  `native` (Level-3 provider-native escape hatch, schema-validated per
  provider type). `version: 2`.
- `upgradeManifest(v1, env) → v2` is pure, deterministic and lossless;
  `parseManifest` accepts both. V1 is never rewritten implicitly.
- `expandManifest(manifest, env) → ResourceGraph` compiles the app into
  portable primitives (network, subnets, firewall rules, load balancer, DNS,
  certificates, container services, databases…), deriving infrastructure
  from routes and bindings, with `origin` provenance on every node.
- Desired, observed and runtime state are separate types
  (`src/lib/resources/types.ts`); unknown is a value.

## Consequences
Users describe applications, not VPCs; advanced users can still pin
provider-native resources without corrupting the portable model.
