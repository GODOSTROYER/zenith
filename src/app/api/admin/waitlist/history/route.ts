import type { NextRequest } from "next/server";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { requireWaitlistOperator } from "@/lib/waitlist/http";
import { waitlistRepository } from "@/lib/waitlist/repository";
import { waitlistHistorySchema } from "@/lib/waitlist/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireWaitlistOperator(request);
    const params = request.nextUrl.searchParams;
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1)
      || (params.has("limit") && !/^[0-9]+$/.test(params.get("limit")!)))
      throw new ApiError("Invalid approval history query.", 400);
    const parsed = waitlistHistorySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) throw new ApiError("Invalid approval history query.", 400);
    return json(await (await waitlistRepository()).history(parsed.data));
  } catch (error) { return errorResponse(error); }
}
