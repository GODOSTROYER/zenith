import type { NextRequest } from "next/server";
import { ApiError, json } from "@/lib/server/errors";
import { readWaitlistJson, requireWaitlistOperator, sameOrigin } from "@/lib/waitlist/http";
import { waitlistRepository } from "@/lib/waitlist/repository";
import { waitlistAdmissionSchema } from "@/lib/waitlist/validation";
import { waitlistErrorResponse } from "@/lib/waitlist/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const user = await requireWaitlistOperator(request);
    sameOrigin(request);
    const parsed = waitlistAdmissionSchema.safeParse(await readWaitlistJson(request));
    if (!parsed.success) throw new ApiError("Choose a valid approval preview or a batch of 1 to 1000 people and a valid request ID.", 400);
    const repository = await waitlistRepository();
    if ("previewId" in parsed.data)
      return json(await repository.admitPreview(parsed.data.previewId, user.id, parsed.data.requestId));
    const admitted = await repository.admit(parsed.data.count, user.id, parsed.data.requestId);
    return json({ admitted, count: admitted.length });
  } catch (error) { return waitlistErrorResponse(error); }
}
