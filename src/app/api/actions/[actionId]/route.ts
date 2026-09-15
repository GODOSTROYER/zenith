/**
 * The one mutation endpoint. UI, source view and Navigator all come through
 * here, so no surface can hold private state about the system.
 *
 * `idempotencyKey` is honest about its limits: retries are deduplicated per
 * workspace, actor and action for ten minutes, and only for an identical
 * request body — a different body under the same key is `idempotency_conflict`.
 * An outcome becomes replayable only once `route()`'s durable flush for its
 * request has succeeded, so `idempotency.replayed: true` in the response means
 * the change was committed; a retry that arrives before that is
 * `idempotency_in_flight`. The window is this server process only: a retry that
 * crosses a restart, or reaches another instance, runs the action a second
 * time — see `IDEM_WINDOW_NOTE`, which is what the response and the
 * malformed-body fix both quote.
 */
import { z } from "zod";
import { actionRegistry, runAction, IDEM_WINDOW_NOTE } from "@/lib/actions/core";
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
      { fix: `POST JSON shaped like { "input": {…}, "mode": "plan" | "execute", "scope": { "projectId": "…" } }. ${IDEM_WINDOW_NOTE}` }
    );

  const { input, mode, scope, idempotencyKey } = body.data;
  const ctx = buildCtx(scope, await resolveActor(req));
  return runAction(actionId, ctx, input, { mode, idempotencyKey });
});
