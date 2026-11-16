# ADR-0015 — Kubernetes: server-side apply with explicit ownership

Status: accepted (2026-09-30)

## Decision
`@kubernetes/client-node`, server-side apply with field manager `zenith`,
`force: false`. Objects Zenith manages carry
`app.kubernetes.io/managed-by: zenith` and `zenith.dev/resource` annotations;
Zenith refuses to modify objects without them (conflicts are reported, never
forced) and never adopts discovered objects without an explicit import.
