import type { NextRequest } from "next/server";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { readWaitlistJson, requireWaitlistOperator, sameOrigin } from "@/lib/waitlist/http";
import { waitlistRepository } from "@/lib/waitlist/repository";
import { waitlistPreviewSchema } from "@/lib/waitlist/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const user = await requireWaitlistOperator(request);
    sameOrigin(request);
    // Selected previews can contain 1000 UUIDs; public intake retains its 8 KiB cap.
    const parsed = waitlistPreviewSchema.safeParse(await readWaitlistJson(request, 65536));
    if (!parsed.success) throw new ApiError("Choose selected people, the next 1 to 1000 people, or everyone queued.", 400);
    return json(await (await waitlistRepository()).preview(parsed.data, user.id));
  } catch (error) { return errorResponse(error); }
}
