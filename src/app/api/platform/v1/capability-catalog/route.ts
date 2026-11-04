/**
 * GET /api/platform/v1/capability-catalog   any authenticated caller
 *
 * The versioned offered capability catalog (PROD-LIFE-02): per provider x
 * portable kind x lifecycle operation, whether Zenith offers it (supported,
 * preview or unsupported with a reason). Static product data derived from the
 * resource drivers; nothing here is workspace-specific or secret.
 *
 *   ?view=summary                      rollups and counts only (default: full)
 *   ?provider=&domain=&kind=&level=    narrow the entries (full view)
 *
 * Unknown query values are a 400 naming the field, never echoing the value.
 */
import { BrokerError } from "@/lib/capabilities/errors";
import { getOfferedCatalog, offeredCatalogSummary, parseCatalogFilter, queryOfferedCatalog } from "@/lib/offered-catalog";
import { platformRoute } from "../_lib/http";
import { callerOf } from "../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = platformRoute(async (req) => {
  await callerOf(req);
  const params = req.nextUrl.searchParams;
  const view = params.get("view") ?? "full";
  if (view !== "full" && view !== "summary") throw new BrokerError("invalid_request", "view must be full or summary.");
  if (view === "summary") return { body: offeredCatalogSummary() };
  const parsed = parseCatalogFilter(params);
  if (!parsed.ok) throw new BrokerError("invalid_request", parsed.error);
  const catalog = getOfferedCatalog();
  return {
    body: {
      schemaVersion: catalog.schemaVersion,
      catalogVersion: catalog.catalogVersion,
      contentDigest: catalog.contentDigest,
      levelPolicy: catalog.levelPolicy,
      domains: catalog.domains,
      dayTwoOperations: catalog.dayTwoOperations,
      filter: parsed.filter,
      entries: queryOfferedCatalog(parsed.filter),
      rollup: catalog.rollup.filter((r) => (!parsed.filter.provider || r.provider === parsed.filter.provider) && (!parsed.filter.domain || r.domain === parsed.filter.domain)),
      unmappedDrivers: catalog.unmappedDrivers,
    },
  };
});
