/** Read-only worker review. No approval fields, commands, cloud values or apply path. */
import { z } from "zod/v4";
import { requestDestroyReview } from "@/lib/capabilities/destroy-review";
import { ReviewTeardownInput } from "../teardown-review-schema";
import type { ToolContext } from "../context";
import type { ToolOutput } from "../envelope";

export async function reviewTeardown(args: z.infer<typeof ReviewTeardownInput>, ctx: ToolContext): Promise<ToolOutput> {
  const review = await requestDestroyReview(ctx.broker, args.target, ctx.principal.principal,
    { idempotencyKey: args.idempotencyKey, refresh: args.refresh }, "mcp");
  return { data: { ...review, poll: { tool: "zenith_get_operation", workspaceId: args.target.workspaceId, operationId: review.reviewOperationId } },
    notes: ["This requests read-only planning. The worker records a destroy PlanView and a pending teardown proposal. Only a person in the browser can approve it. Nothing is applied by this tool."] };
}
