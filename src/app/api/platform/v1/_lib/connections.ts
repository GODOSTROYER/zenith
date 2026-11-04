/**
 * Shared plumbing for /api/platform/v1/connections (PROD-LIFE-01).
 *
 * Every verb runs the SAME registered action the web app uses, so role
 * enforcement, input validation, the product audit row and idempotent replay are
 * identical across UI, REST and CLI. Two caller classes:
 *
 *  - browser-only routes (create, rotate, promote, abort): a person in the Zenith
 *    web app; any Authorization header is refused (`assertBrowserSession`).
 *  - bearer-capable routes (list, show, verify, revoke): a signed-in person OR a
 *    human-bound linked credential. The credential acts as its bound human, whose
 *    CURRENT workspace role is re-read on every call; it never gains more than
 *    that human has, and creation/rotation (which change trust) are not offered.
 */
import type { NextRequest } from "next/server";
import { runAction, type ActionContext, type ActionRun } from "@/lib/actions/core";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { currentProductRoleResolver } from "@/lib/capabilities/current-product-roles";
import { HUMAN_REQUIRED_MESSAGE, NOT_FOUND_MESSAGE } from "@/lib/connections/service";
import { buildCtx } from "@/lib/server/scope";
import { requireWorkspace } from "@/lib/server/workspace";
import { assertBrowserSession } from "./browser";
import { callerOf } from "./principal";
import type { Answer } from "./http";

export interface LifecycleCaller {
  ctx: ActionContext;
  via: "browser" | "credential";
}

const KEY = /^[A-Za-z0-9._:-]{8,100}$/;

async function requireMember(ctx: ActionContext): Promise<void> {
  try {
    const access = await currentProductRoleResolver().resolve({ kind: "user", id: ctx.actor.id, name: ctx.actor.name }, ctx.workspaceId);
    if (access.role === "none") throw notFound();
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError("policy_unavailable", "Workspace membership could not be confirmed, so this was refused.");
  }
}

/** A person in the browser, same-origin verified. Credentials are refused. */
export async function browserCaller(req: NextRequest): Promise<LifecycleCaller> {
  const caller = await assertBrowserSession(req, { mutation: req.method !== "GET" });
  if (requireWorkspace().id !== caller.workspaceId) throw notFound();
  const ctx = buildCtx({}, { type: "user", id: caller.principal.id, name: caller.principal.name });
  await requireMember(ctx);
  return { ctx, via: "browser" };
}

/** A person in the browser, or a human-bound linked credential. */
export async function personOrCredentialCaller(req: NextRequest): Promise<LifecycleCaller> {
  if (!req.headers.has("authorization")) return browserCaller(req);
  const caller = await callerOf(req);
  if (caller.via !== "bearer" || !caller.principal.onBehalfOf) throw new BrokerError("unauthenticated", "Present a valid integration credential.");
  const ctx: ActionContext = { workspaceId: caller.workspaceId, actor: { type: "user", id: caller.principal.onBehalfOf, name: `${caller.principal.name} (linked credential)` } };
  await requireMember(ctx);
  return { ctx, via: "credential" };
}

export function idempotencyKey(req: NextRequest): string | undefined {
  const key = req.headers.get("idempotency-key") ?? undefined;
  if (key !== undefined && !KEY.test(key)) throw new BrokerError("invalid_request", "Idempotency-Key must be 8-100 characters of letters, digits and . _ : -.");
  return key;
}

/** Run one registered action and translate refusals into the platform error body. */
export async function runLifecycle(caller: LifecycleCaller, actionId: string, input: unknown, key?: string): Promise<Answer> {
  await import("@/lib/actions/defs");
  if (actionId === "connection.createRunner") await import("@/lib/connections/runner-action");
  const run: ActionRun = await runAction(actionId, caller.ctx, input, { mode: "execute", idempotencyKey: key });
  const result = run.result;
  if (!result) throw new BrokerError("internal", "The action returned no result.");
  if (!result.ok) {
    const error = result.error ?? "";
    if (error.startsWith("role_denied") || error === HUMAN_REQUIRED_MESSAGE) throw new BrokerError("role_insufficient", "Your current workspace role cannot do this.", "Ask a workspace admin.");
    if (result.summary === "Invalid input.") throw new BrokerError("invalid_request", `The request is invalid (${error.slice(0, 300)}).`);
    if (error === NOT_FOUND_MESSAGE) throw notFound();
  }
  const status = result.ok && actionId.startsWith("connection.create") ? 201 : 200;
  return { status, body: { ok: result.ok, summary: result.summary, ...(result.error ? { error: result.error } : {}), data: result.data ?? null } };
}
