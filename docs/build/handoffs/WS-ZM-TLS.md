# WS-ZM-TLS — managed hosting: TLS for managed hostnames, automated

Workstream: WS-ZM-TLS (new; orchestrator brief) — Branch ws/zm-tls — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-zm-tls
Base: platform/integration (Zenith-managed provider + K8s contract gaps merged)

## Situation (docs/platform/MANAGED-PLATFORM.md "TLS open question")
Managed hostnames are `<service>.<env>.<workspace-slug>.<domain>` — three labels below the base
domain, so one wildcard certificate does not cover them, and nothing automates per-environment
Gateway listeners or certificates. The deploy/zenith-managed Gateway manifest shows one example zone.

## Objective
Automate TLS for managed hostnames with cert-manager + Gateway API, per environment:
- On environment apply: a cert-manager `Certificate` for `*.<env>.<workspace-slug>.<domain>` (DNS-01
  via the configured ClusterIssuer) in the platform gateway namespace, and a Gateway listener (or a
  ListenerSet / per-env Gateway, choose and justify against Gateway API v1 support) bound to it; the
  tenant HTTPRoutes attach to that listener only.
- Isolation lint (src/lib/providers/zenith/isolation.ts) keeps refusing routes outside the tenant's
  suffix; certificates and listeners are platform-owned objects in the gateway namespace, created by
  the operator role (update deploy/zenith-managed RBAC narrowly).
- Teardown removes the env's listener and certificate.
- Honest docs update in docs/platform/MANAGED-PLATFORM.md (TLS section) — WS-DOCS-SYNC is editing
  other docs; touch only this file's TLS section.

## Owned paths
src/lib/providers/zenith/** ; deploy/zenith-managed/** ; tests/providers/zenith/** ;
docs/platform/MANAGED-PLATFORM.md (TLS section only).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/providers/zenith tests/providers/zenith
- npx vitest run --maxWorkers=2 tests/providers/zenith tests/providers/kubernetes
