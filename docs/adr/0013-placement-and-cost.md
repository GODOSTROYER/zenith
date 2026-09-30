# ADR-0013 — Deterministic placement and costed estimates

Status: accepted (2026-09-30)

## Decision
A versioned price catalog with per-entry source and retrieval date; cost
estimates include NAT, public IPv4, load balancers, egress, requests, IOPS,
backups and cross-region/cross-cloud transfer, and list what is excluded.
Placement enumerates candidates, filters hard constraints (residency, budget,
capability, availability), and scores cost + latency + operational/identity
complexity deterministically. The model extracts constraints and explains;
it never optimizes. Estimates are never presented as invoices.
