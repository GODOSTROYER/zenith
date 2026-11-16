/**
 * `POST /api/admin/ops/retention/archives/:id/restore` - restore archived records (PROD-OPS-07).
 *
 * Body `{ mode: "staging" | "source", stagingSuffix?, rowIds? }`. The archive is verified first; a failed verification
 * restores nothing. `staging` writes a fresh schema `retention_stage_<suffix>` and leaves `platform` untouched. `source`
 * re-inserts into the source table without ever overwriting an existing (or newer) row, skips rows whose parent is gone,
 * and is idempotent. Every run is read back and written to the append-only restore audit; the answer carries the audit
 * id and counts, never row data. Platform operators only, same-origin.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { log } from "@/lib/log";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { readWaitlistJson } from "@/lib/waitlist/http";
import { opsStore, requireOpsOperator } from "@/lib/ops/operator";
import { restoreDepsFromEnv } from "@/lib/retention/runtime";
import { restoreArchive } from "@/lib/retention/restore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  mode: z.enum(["staging", "source"]),
  legacyKey: z.object({ originalPurpose: z.literal("enc:backup"), keyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), reason: z.string().regex(/^[A-Za-z0-9 ._:/()-]{1,200}$/) }).strict().optional(),
  stagingSuffix: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  rowIds: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)).min(1).max(500).optional(),
}).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const operator = await requireOpsOperator(request, true);
    const parsed = Body.safeParse(await readWaitlistJson(request, 65_536));
    if (!parsed.success) throw new ApiError("Send { mode: staging | source, stagingSuffix? (a-z, 0-9, _), rowIds? (up to 500 ids) }.", 400);
    const { id } = await context.params;
    const result = await restoreArchive(await opsStore(), { archiveId: id, ...parsed.data, actor: operator.id }, { deps: restoreDepsFromEnv(), privileged: true });
    log.info("retention restore", { scope: "ops", archiveId: id, mode: result.mode, verdict: result.verdict, actor: operator.id });
    return json(result, result.verdict === "refused" ? 409 : 200);
  } catch (error) { return errorResponse(error); }
}
