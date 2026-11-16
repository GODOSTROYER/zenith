/**
 * `POST /api/admin/ops/retention/archives/:id/verify` - prove an archive is intact (PROD-OPS-07).
 *
 * Reads the object from the destination it was written to, unseals it (authentication fails on any change), and compares
 * its rows digest, count, id range and workspace with the verified record. Read-only. Answers `{ ok, problems, rows }`
 * (no row data). Platform operators only, same-origin.
 */
import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/lib/server/errors";
import { opsStore, requireOpsOperator } from "@/lib/ops/operator";
import { restoreDepsFromEnv } from "@/lib/retention/runtime";
import { verifyArchive } from "@/lib/retention/restore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireOpsOperator(request, true);
    const { id } = await context.params;
    const result = await verifyArchive(await opsStore(), id, { deps: restoreDepsFromEnv() });
    if (!result.archive) return json({ error: { message: "No such archive." } }, 404);
    return json({ ok: result.ok, problems: result.problems, rows: result.rows, archiveId: id });
  } catch (error) { return errorResponse(error); }
}
