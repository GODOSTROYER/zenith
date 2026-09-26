import type { NextRequest } from "next/server";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { waitlistEnabled } from "@/lib/waitlist/config";
import { readWaitlistJson, sameOrigin, throttleWaitlist } from "@/lib/waitlist/http";
import { waitlistRepository } from "@/lib/waitlist/repository";
import { waitlistSubmissionSchema } from "@/lib/waitlist/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public intake only; never reveals membership, answers, position or admission. */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    if (!waitlistEnabled()) throw new ApiError("Waitlist intake is not available.", 404);
    sameOrigin(request);
    const repository = await waitlistRepository();
    const refusal = await throttleWaitlist(request, repository);
    if (refusal) return refusal;
    const parsed = waitlistSubmissionSchema.safeParse(await readWaitlistJson(request));
    if (!parsed.success) throw new ApiError("Enter a valid email, your occupation (up to 120 characters), and your primary use case (up to 2000 characters).", 400);
    await repository.join(parsed.data);
    return json({ accepted: true }, 202);
  } catch (error) { return errorResponse(error); }
}