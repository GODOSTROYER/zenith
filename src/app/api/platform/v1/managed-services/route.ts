/**
 * GET /api/platform/v1/managed-services   any authenticated caller
 *
 * What the Zenith-managed tier promises (PROD-MAN-03), joined to the versioned offered capability catalog so the two cannot
 * drift: each service with its portable kinds, the offered-catalog level of each, per-plan limits (provisional), what it needs
 * from the platform's substrate and whether this platform has it, the kinds the tier refuses with the catalog's reasons, and
 * the drift verdict. Static product data plus the non-secret shape of this deployment's configuration.
 *
 *   ?probe=true   also run the bounded network probes (registry v2 API, app-domain wildcard DNS) and report each integration's
 *                 state: not_configured, configured_unverified, verified or failing. Probes only ever target operator
 *                 configuration, never a caller-supplied address.
 */
import { resolve4 } from "node:dns/promises";
import { BrokerError } from "@/lib/capabilities/errors";
import { buildManagedServiceCatalog } from "@/lib/managed-serving/catalog";
import { managedIntegrationReadiness, registryProbe, wildcardDnsProbe } from "@/lib/managed-serving/readiness";
import { readSubstrateConfig } from "@/lib/providers/zenith/substrate";
import { platformRoute } from "../_lib/http";
import { callerOf } from "../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = platformRoute(async (req) => {
  await callerOf(req);
  const probe = req.nextUrl.searchParams.get("probe");
  if (probe !== null && probe !== "true" && probe !== "false") throw new BrokerError("invalid_request", "probe must be true or false.");
  const cfg = readSubstrateConfig(process.env);
  const substrate = cfg.configured ? cfg.substrate : undefined;
  const catalog = buildManagedServiceCatalog({ substrate });
  const integrations = await managedIntegrationReadiness(substrate, probe === "true" ? { registry: registryProbe(), wildcardDns: wildcardDnsProbe((name) => resolve4(name)) } : {});
  return {
    body: {
      ...catalog,
      configured: cfg.configured,
      ...(cfg.configured ? { warnings: cfg.warnings } : { missing: cfg.missing, invalid: cfg.invalid.map((i) => ({ variable: i.variable, problem: i.problem })) }),
      integrations,
      evidence: "contract",
    },
  };
});
