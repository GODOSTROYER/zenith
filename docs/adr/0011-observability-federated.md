# ADR-0011 — Federated, normalized observability

Status: accepted (2026-09-30)

## Decision
Query providers' own backends at request time (CloudWatch Logs/Metrics,
Kubernetes, Prometheus, Loki, Cloud Logging, Azure Monitor, journald via
zenithd) through `ObservabilitySource`s; normalize to `NormalizedLog`,
`MetricSeries`, `NormalizedEvent` while preserving native fields; label
partial answers. No central ingestion in this phase. Log text is untrusted
data and is redacted defensively.
