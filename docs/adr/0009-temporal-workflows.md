# ADR-0009 — Temporal for long-running orchestration

Status: accepted (2026-09-30)

## Context
Engine steps are single awaited promises inside a 20-second cron pass; an
RDS create or an OpenTofu apply takes 5–30 minutes. Durable leases, retries,
signals (approval), timers and cancellation are needed.

## Decision
Temporal (TypeScript SDK 1.24) in a separate long-running **execution
worker** (`npm run worker`, container image with pinned OpenTofu). The
control plane (including Vercel) only starts/signals/queries workflows.
Workflow id `op-<operationId>` makes starts idempotent. Activities are the
only code touching drivers, OpenTofu, credentials and stores. Payloads carry
ids and digests only. Local: `temporal server start-dev`; production:
Temporal Cloud or self-hosted. The existing engine remains for sandbox and
LocalStack.

## Alternatives
DBOS (Postgres-native) was the closest alternative: lighter operationally,
but a smaller ecosystem and weaker tooling for signals, time-skipping tests
and visibility. Revisit if running a Temporal cluster proves disproportionate.
