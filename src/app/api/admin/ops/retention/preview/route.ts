/**
 * `POST /api/admin/ops/retention/preview` - what a CANDIDATE policy would archive and prune (PROD-OPS-07).
 *
 * Body `{ policy }` in the retention policy schema (see src/lib/retention/policy.ts). The policy is validated (a
 * protected table or an unknown class is refused with the reason), then counted against live data. It is never stored
 * and nothing is changed: this is how an operator evaluates a policy before DEC-RETENTION approves it. POST only
 * because the body is large; same-origin and platform operators only.
 */
import type { NextRequest } from "next/server";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { readWaitlistJson } from "@/lib/waitlist/http";
import { opsStore, requireOpsOperator } from "@/lib/ops/operator";
import { parseRetentionPolicy, RetentionPolicyError } from "@/lib/retention/policy";
import { previewRetention } from "@/lib/retention/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    await requireOpsOperator(request, true);
    const body = await readWaitlistJson(request, 65_536);
    const candidate = body && typeof body === "object" ? (body as { policy?: unknown }).policy : undefined;
    if (candidate === undefined) throw new ApiError("Send { policy } in the retention policy schema.", 400);
    let policy;
    try { policy = parseRetentionPolicy(candidate); } catch (error) {
      if (error instanceof RetentionPolicyError) return json({ error: { message: "The policy is invalid.", problems: error.problems } }, 400);
      throw error;
    }
    return json({ preview: await previewRetention(await opsStore(), policy) });
  } catch (error) { return errorResponse(error); }
}
