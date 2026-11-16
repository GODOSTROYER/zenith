# ADR-0012 — One semantic machine plane

Status: accepted (2026-09-30)

## Decision
`src/lib/machines` exposes semantic operations; transports are AWS SSM
(fixed documents with validated parameters), Kubernetes API/exec, Azure Run
Command, GCP OS management and zenithd. `machine.exec`/`container.exec` are
separate, critical, escape-hatch capabilities denied in production unless a
workspace policy enables them. No public SSH anywhere.
