import type { NextRequest } from "next/server";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { requireWaitlistOperator } from "@/lib/waitlist/http";
import { waitlistRepository } from "@/lib/waitlist/repository";
import { waitlistListSchema } from "@/lib/waitlist/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireWaitlistOperator(request);
    const params = request.nextUrl.searchParams;
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1)
      || ["after", "limit"].some((key) => params.has(key) && !/^[0-9]+$/.test(params.get(key)!)))
      throw new ApiError("Invalid waitlist query.", 400);
    const parsed = waitlistListSchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) throw new ApiError("Invalid waitlist query.", 400);
    return json(await (await waitlistRepository()).list(parsed.data));
  } catch (error) { return errorResponse(error); }
}