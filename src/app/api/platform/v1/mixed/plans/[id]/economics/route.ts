/**
 * GET /api/platform/v1/mixed/plans/:id/economics?egressGb=&interComponentFraction=&residency=eu,us&latencyBudgetMs=
 *
 * PROD-MIX-07. The estimate-only economics of a stored mixed parent plan: the dated-catalog monthly total INCLUDING
 * each cross-cloud and cross-region transfer, approximate edge latency, and residency of every partition. Read-only,
 * no cloud call. It is an estimate and never a billing cap; a graph the catalog cannot price says so instead of
 * showing zero. The graph is the parent environment's current desired graph, re-checked against the plan's graph
 * digest so a report is never produced for a graph nobody planned.
 */
import { authorizeEnvironment, publicData } from "@/app/(product)/platform/_lib/read-models";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import { mixedEconomics } from "@/lib/execution/mixed/economics";
import { mixedDeps } from "@/lib/execution/mixed/runtime";
import { loadDefaultCatalog } from "@/lib/placement/pricebook";
import { platformRoute } from "../../../../_lib/http";
import { guarded } from "../../../../_lib/mixed";
import { callerOf } from "../../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOKEN = /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/;

function numberParam(params: URLSearchParams, name: string, max: number): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > max) throw new BrokerError("invalid_request", `${name} must be a number from 0 to ${max}.`);
  return value;
}

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  const deps = await mixedDeps();
  const stored = await guarded(() => plans.getPlan(deps.sql, caller.workspaceId, id));
  if (!stored) throw notFound();
  await authorizeEnvironment({ workspaceId: caller.workspaceId, principal: caller.principal, surface: "rest" }, stored.plan.parentEnvironmentId, "infrastructure.observe");
  const params = req.nextUrl.searchParams;
  const egressGb = numberParam(params, "egressGb", 1_000_000);
  const fraction = numberParam(params, "interComponentFraction", 1);
  const latencyBudgetMs = numberParam(params, "latencyBudgetMs", 5000);
  const residency = (params.get("residency") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (residency.length > 8 || residency.some((t) => !TOKEN.test(t))) throw new BrokerError("invalid_request", "residency must be up to 8 short comma-separated names such as eu,us.");
  const parent = await guarded(() => deps.world.parentGraph(caller.workspaceId, stored.plan.parentEnvironmentId));
  if (parent.graph.graphDigest !== stored.plan.graphDigest) {
    throw new BrokerError("invalid_state", "The parent graph changed after the plan was made, so the report would describe something nobody planned.", "Plan again, then read the report.", { reason: "plan_refused" });
  }
  const report = mixedEconomics({
    graph: parent.graph, catalog: loadDefaultCatalog(),
    usage: { ...(egressGb !== undefined ? { egressGb } : {}), ...(fraction !== undefined ? { interComponentFraction: fraction } : {}) },
    residency, ...(latencyBudgetMs !== undefined ? { latencyBudgetMs } : {}),
  });
  return { body: publicData({ parentPlanId: stored.plan.parentPlanId, report }) };
});
