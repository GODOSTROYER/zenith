# PROD-MAN-01: Default managed substrate and sessions

Status: IN PROGRESS. This first commit publishes the substrate port so MAN-02..05
can build on it. The full document (acceptance mapping, verification commands,
limits) replaces this stub in the final commit of this branch.

## The substrate port (stable)

`src/lib/providers/zenith/managed-port.ts` (exported from `@/lib/providers/zenith`).

- `ManagedSubstratePort`: `status()`, `substrate()`, `toolkit`, `tenants`,
  `registry()`, `openSession(req)`, `withSession(req, fn)`, `databaseRuntime(input)`,
  `withBuildSession(req, fn)`.
- A request names ONLY `{ workspaceId, environmentId }`. Slugs and plan tier are
  resolved from the control plane by `TenantResolver`.
- `ZenithSession` (existing, `session.ts`) is what `openSession`/`withSession`
  yield: tenant-pinned Kubernetes session scoped to the tenant namespace, plus a
  gateway-namespace session in `gateway_api` mode, plus the managed-database port.
- Failure is `ManagedSubstrateError` with a stable `code`
  (`not_configured`, `tenant_unresolved`, `credential_unavailable`, ...).
- Implementation: `managed-substrate.ts` (provider layer, no env reads),
  default composition: `src/lib/platform/zenith-managed.ts` (reads `ZENITH_MANAGED_*`).
- Extend by adding methods to the port interface and the one implementation.
