/**
 * `GET /api/hosted/apps/:appId/usage` — what this app used, and which of its
 * limits are actually enforced.
 *
 * Owner only. Three things in one answer, because they are only meaningful
 * together: the quota counters Zenith itself keeps, the usage ledger priced
 * with the rate table (an estimate, labelled), and the limit table with the
 * honest enforcement column — `not_enforced` for the CPU and subrequest
 * ceilings that belong to Cloudflare and are not measured on this runtime.
 */
import { DEFAULT_LIMITS, HostedError, type HostedUsage } from "@/lib/hosted/contracts";
import { authority } from "@/lib/hosted/authority";
import { hostedConfig } from "@/lib/hosted/config";
import { ENFORCEMENT_LABELS, enforcementFor, quotaSummary } from "@/lib/hosted/quota";
import { RATE_TABLE, SPEND_DISCLOSURE, usageSummary } from "@/lib/hosted/usage";
import { intParam } from "@/lib/server/context";
import { hostedRoute } from "@/lib/server/hosted";

export const dynamic = "force-dynamic";

export const GET = hostedRoute<{ appId: string }>(
  { appRole: "owner", refusal: "not_found" },
  async (req, { appId }): Promise<HostedUsage> => {
    const app = await authority().repos.apps.get(appId);
    if (!app)
      throw new HostedError("not_found", `No hosted app has the id ${appId}.`, {
        fix: "Open the app from your apps list.",
      });

    const url = new URL(req.url);
    const days = intParam(url, "days", 30, { min: 1, max: 365 });
    const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();

    return {
      quota: await quotaSummary(appId, { days }),
      usage: await usageSummary(app.workspaceId, { since, appId }),
      limits: DEFAULT_LIMITS,
      enforcement: enforcementFor(hostedConfig().ZENITH_RUNTIME),
      enforcementLabels: ENFORCEMENT_LABELS,
      rateTable: RATE_TABLE,
      disclosure: SPEND_DISCLOSURE,
    };
  }
);
