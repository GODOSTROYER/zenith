/**
 * The one mutation endpoint. UI, source view and Navigator all come through
 * here, so no surface can hold private state about the system.
 */
import { z } from "zod";
import { actionRegistry, runAction } from "@/lib/actions/core";
import { ApiError, buildCtx, resolveActor, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const Body = z.object({
  input: z.unknown().optional(),
  mode: z.enum(["plan", "execute"]).default("plan"),
  scope: z
    .object({ projectId: z.string().optional(), environmentId: z.string().optional() })
    .default({}),
  idempotencyKey: z.string().optional(),
});

export const POST = route<{ actionId: string }>(async (req, { actionId }) => {
  if (!actionRegistry().has(actionId))
    throw new ApiError(`Unknown action "${actionId}".`, 404, {
      fix: "Use an action id from the catalog in docs/CONTRACTS.md; actions register when the server boots.",
    });

  const raw: unknown = await req.json().catch(() => null);
  const body = Body.safeParse(raw ?? {});
  if (!body.success)
    throw new ApiError(
      `Malformed request body: ${body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`,
      400,
      { fix: 'POST JSON shaped like { "input": {…}, "mode": "plan" | "execute", "scope": { "projectId": "…" } }.' }
    );

  const { input, mode, scope, idempotencyKey } = body.data;
  const ctx = buildCtx(scope, await resolveActor(req));
  return runAction(actionId, ctx, input, { mode, idempotencyKey });
});
