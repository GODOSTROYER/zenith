/**
 * Can this provider be used right now?
 *
 * Onboarding lists providers before any connection exists, so it cannot ask
 * `connection.check` — it needs an answer with nothing set up. `probe()` is
 * that answer where an adapter offers one (LocalStack: is Docker actually
 * running?). Where it does not, this falls back to `preflight` against a
 * throwaway connection that is never persisted.
 *
 *   GET /api/providers/:id/health → { ok, checks, probe?, availability, displayName }
 *
 * Read-only and safe to call on render. It writes nothing, stores nothing, and
 * never reports a Planned provider as usable — `availability` still decides
 * selectability; this only says whether an available one is up.
 */
import { ProviderId, type CloudConnection } from "@/lib/domain/types";
import { getProvider, providerRegistry, type PreflightCheck } from "@/lib/providers/types";
import { ensureEngine } from "@/lib/engine/engine";
import { notFound, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  ensureEngine(); // adapters register on first touch
  const parsed = ProviderId.safeParse(id);
  if (!parsed.success || !providerRegistry().has(parsed.data))
    throw notFound(
      `Provider "${id}"`,
      `Use one of: ${[...providerRegistry().keys()].join(", ")}. Provider ids come from GET /api/bootstrap.`
    );

  const adapter = getProvider(parsed.data);

  if (adapter.probe) {
    const probe = await adapter.probe();
    const check: PreflightCheck = {
      id: `${adapter.id}.reachable`,
      label: probe.reachable ? `${adapter.displayName} is reachable` : `${adapter.displayName} is not reachable`,
      status: probe.reachable ? "pass" : "fail",
      detail: probe.detail,
      fix: probe.fix,
    };
    return {
      ok: probe.reachable,
      checks: [check],
      probe,
      availability: adapter.availability,
      displayName: adapter.displayName,
    };
  }

  // No probe: ask preflight with a connection shaped like the one this
  // provider would get. It is built here and thrown away — nothing is saved.
  const report = await adapter.preflight({
    id: "probe",
    workspaceId: "probe",
    provider: adapter.id,
    label: adapter.displayName,
    region: adapter.regions[0]?.id ?? "default",
    status: "connecting",
    grantedPermissions: [],
    createdAt: new Date().toISOString(),
  } satisfies CloudConnection);

  return {
    ok: report.ok,
    checks: report.checks,
    availability: adapter.availability,
    displayName: adapter.displayName,
  };
});
