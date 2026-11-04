/**
 * GET  /api/platform/v1/audit/exports          admin: the ledger of this workspace's signed audit exports (chain facts only)
 * POST /api/platform/v1/audit/exports          admin, browser-only: body { from?, to? } (ISO timestamps)
 *
 * POST returns { exportId, record, document }: `document` is the signed, hash-chained export (`zenith.audit-export/v1`),
 * `record` the ledger row. The control plane keeps only the chain facts in the ledger;
 * the operator keeps the document and verifies it offline with `scripts/supply-chain/zenith-verify-audit-export.mjs`.
 * No control signing key means a 503-class refusal, never an unsigned export.
 */
import { z } from "zod";
import { BrokerError } from "@/lib/capabilities/errors";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { AuditExportError } from "@/lib/audit-export/service";
import { platformAuditExports } from "@/lib/platform/audit-export";
import { assertBrowserSession } from "../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";
import { requireRole } from "../../_lib/releases";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional() }).strict();

async function service() {
  const svc = await platformAuditExports();
  if (!svc) throw new BrokerError("platform_store_unavailable", "The platform store is not configured; audit exports are unavailable.");
  return svc;
}

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  await requireRole(caller.principal, caller.workspaceId, "admin", "read");
  const limit = Math.max(1, Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? "50") || 50));
  return { body: { exports: await (await service()).list(caller.workspaceId, limit) } };
});

export const POST = platformRoute(async (req) => {
  const caller = await assertBrowserSession(req);
  await requireRole(caller.principal, caller.workspaceId, "admin", "write");
  const body = parseWith(Body, await readJson(req));
  const svc = await service();
  try {
    const { document, record } = await svc.create({ workspaceId: caller.workspaceId, createdBy: caller.principal.id, from: body.from, to: body.to });
    return { body: { exportId: record.id, record, document } };
  } catch (e) {
    if (e instanceof AuditExportError) {
      if (e.code === "signer_unavailable") throw new BrokerError("policy_unavailable", e.message);
      throw new BrokerError("invalid_request", e.message);
    }
    if (e instanceof ControlStoreError && e.code === "conflict") throw new BrokerError("conflict", e.message);
    throw e;
  }
});
