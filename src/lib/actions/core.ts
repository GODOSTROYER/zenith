/**
 * The typed action registry — Orrery's backbone.
 *
 * Every meaningful mutation in the product is an Action: the UI calls
 * actions, the REST API calls actions, and the Navigator agent calls the
 * SAME actions. Each action supports plan (readable preview + cost/risk),
 * execute (idempotent, audited), and optional undo.
 *
 * Agentic control is therefore architected from day one; the agent surface
 * ships last, but it will have nothing to learn that the UI doesn't already do.
 *
 * SPINE FILE — owned by the integrator. Concrete actions live in
 * src/lib/actions/defs/ (workstream ownership).
 */
import { z } from "zod";
import { appendAudit, db, save } from "@/lib/db/store";
import { id, type Actor, type AutonomyLevel } from "@/lib/domain/types";

export interface ActionContext {
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  actor: Actor;
  /** effective autonomy level when actor.type === "navigator" */
  autonomy?: AutonomyLevel;
}

export type Risk = "low" | "medium" | "high";
export type Role = "viewer" | "editor" | "admin";

export interface ActionPlan {
  /** one-sentence, human-readable statement of what will happen */
  summary: string;
  /** bullet-level detail lines */
  details: string[];
  costDeltaUsd: number;
  risk: Risk;
  warnings: string[];
  /** true when policy requires a human to approve before execute */
  requiresApproval: boolean;
}

export interface ActionResult {
  ok: boolean;
  summary: string;
  /** structured payload for the caller (ids, urls, …) */
  data?: unknown;
  error?: string;
  /** opaque token execute() can hand to undo() */
  undoToken?: unknown;
}

export interface ActionDef<I = unknown> {
  id: string;
  title: string;
  category:
    | "project"
    | "system" // manifest edits
    | "deploy"
    | "environment"
    | "connection"
    | "secrets"
    | "operations"
    | "navigator";
  risk: Risk;
  requiredRole: Role;
  /** true when the action mutates cloud/system state (vs. read-only helpers) */
  mutates: boolean;
  input: z.ZodType<I>;
  plan(ctx: ActionContext, input: I): Promise<ActionPlan> | ActionPlan;
  execute(ctx: ActionContext, input: I): Promise<ActionResult> | ActionResult;
  undo?(ctx: ActionContext, undoToken: unknown): Promise<ActionResult> | ActionResult;
}

/* -------------------------------- registry -------------------------------- */

type G = typeof globalThis & { __orreryActions?: Map<string, ActionDef<unknown>> };

export function actionRegistry(): Map<string, ActionDef<unknown>> {
  const g = globalThis as G;
  if (!g.__orreryActions) g.__orreryActions = new Map();
  return g.__orreryActions;
}

export function defineAction<I>(def: ActionDef<I>): ActionDef<I> {
  actionRegistry().set(def.id, def as unknown as ActionDef<unknown>);
  return def;
}

export function getAction(actionId: string): ActionDef<unknown> {
  const a = actionRegistry().get(actionId);
  if (!a) throw new Error(`Unknown action "${actionId}".`);
  return a;
}

/* ---------------------------------- roles --------------------------------- */

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/**
 * The acting user's role in this workspace. The member record is the authority;
 * the local demo actor (and any caller in a store with no members at all — the
 * seed script, the smoke run, tests) is admin because there is nobody else.
 * A user who is not a member gets the lowest role rather than the highest.
 */
export function roleOf(actor: Actor): Role {
  const members = db().members;
  const member = members.find((m) => m.id === actor.id);
  if (member) return member.role;
  if (actor.id === "local" || members.length === 0) return "admin";
  return "viewer";
}

/* ------------------------------- idempotency ------------------------------- */

/**
 * Bounded replay cache: a retried request inside the window gets the original
 * result, and the map can never grow without limit.
 */
const IDEM_MAX = 500;
const IDEM_TTL_MS = 10 * 60_000;

interface IdemEntry {
  at: number;
  result: ActionResult;
}

type GI = typeof globalThis & { __orreryIdem?: Map<string, IdemEntry> };

function idemCache(): Map<string, IdemEntry> {
  const g = globalThis as GI;
  if (!g.__orreryIdem) g.__orreryIdem = new Map();
  return g.__orreryIdem;
}

function idemGet(key: string): ActionResult | undefined {
  const cache = idemCache();
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > IDEM_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.result;
}

function idemSet(key: string, result: ActionResult): void {
  const cache = idemCache();
  cache.delete(key); // re-insert so Map iteration order is oldest-first
  cache.set(key, { at: Date.now(), result });
  for (const [k, v] of cache) {
    if (cache.size <= IDEM_MAX && Date.now() - v.at <= IDEM_TTL_MS) break;
    cache.delete(k);
  }
}

/* -------------------------------- executor -------------------------------- */

export interface RunOptions {
  mode: "plan" | "execute";
  idempotencyKey?: string;
}

/**
 * The single entry point used by API routes, server components and the
 * Navigator. Validates input, enforces role/autonomy, audits every execute.
 */
export async function runAction(
  actionId: string,
  ctx: ActionContext,
  rawInput: unknown,
  opts: RunOptions
): Promise<{ plan?: ActionPlan; result?: ActionResult }> {
  const action = getAction(actionId);
  const parsed = action.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    if (opts.mode === "plan") {
      return {
        plan: {
          summary: "Invalid input.",
          details: [msg],
          costDeltaUsd: 0,
          risk: "low",
          warnings: [msg],
          requiresApproval: false,
        },
      };
    }
    return { result: { ok: false, summary: "Invalid input.", error: msg } };
  }
  const input = parsed.data;

  if (opts.mode === "plan") {
    return { plan: await action.plan(ctx, input) };
  }

  // Role enforcement: a human may only execute up to their workspace role.
  // (Planning is read-only and stays open — you can always see what an action
  // would do before asking someone who is allowed to run it.)
  if (ctx.actor.type === "user") {
    const role = roleOf(ctx.actor);
    if (RANK[role] < RANK[action.requiredRole]) {
      const denied: ActionResult = {
        ok: false,
        summary: `"${action.title}" needs the ${action.requiredRole} role and you are ${role} in this workspace.`,
        error: `role_denied: ask a workspace admin to give ${ctx.actor.name} the ${action.requiredRole} role in Settings → Members, or have them run this action.`,
      };
      audit(ctx, action, input, "denied", denied.summary, denied.error);
      return { result: denied };
    }
  }

  // Navigator autonomy enforcement: below "approve", the agent may never execute.
  if (ctx.actor.type === "navigator") {
    const level = ctx.autonomy ?? "observe";
    if (level === "observe" || level === "plan") {
      const denied: ActionResult = {
        ok: false,
        summary: `Navigator is in ${level} mode and may not execute actions.`,
        error: "autonomy_denied",
      };
      audit(ctx, action, input, "denied", denied.summary);
      return { result: denied };
    }
    if (level === "bounded" && action.risk !== "low") {
      const denied: ActionResult = {
        ok: false,
        summary: `Bounded autonomy only permits low-risk actions; "${action.title}" is ${action.risk} risk and needs approval.`,
        error: "autonomy_denied",
      };
      audit(ctx, action, input, "denied", denied.summary);
      return { result: denied };
    }
  }

  if (opts.idempotencyKey) {
    const cached = idemGet(`${actionId}:${opts.idempotencyKey}`);
    if (cached) return { result: cached };
  }

  try {
    const result = await action.execute(ctx, input);
    if (action.mutates) save();
    audit(ctx, action, input, result.ok ? "ok" : "error", result.summary, result.error);
    if (opts.idempotencyKey) idemSet(`${actionId}:${opts.idempotencyKey}`, result);
    return { result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ActionResult = {
      ok: false,
      summary: `${action.title} failed.`,
      error: message,
    };
    audit(ctx, action, input, "error", result.summary, message);
    return { result };
  }
}

function audit(
  ctx: ActionContext,
  action: ActionDef<unknown>,
  input: unknown,
  result: "ok" | "error" | "denied",
  summary: string,
  error?: string
) {
  if (!action.mutates && result === "ok") return; // don't audit reads
  appendAudit({
    ts: new Date().toISOString(),
    id: id(),
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    actor: ctx.actor,
    actionId: action.id,
    input: redact(input),
    result,
    summary,
    error,
  });
}

/** Strip anything that looks like a secret before it reaches the audit log. */
function redact(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const clone: Record<string, unknown> = Array.isArray(input)
    ? ({ ...input } as unknown as Record<string, unknown>)
    : { ...(input as Record<string, unknown>) };
  for (const k of Object.keys(clone)) {
    if (/secret|password|token|key/i.test(k) && typeof clone[k] === "string") {
      clone[k] = "•••";
    } else if (typeof clone[k] === "object") {
      clone[k] = redact(clone[k]);
    }
  }
  return Array.isArray(input) ? Object.values(clone) : clone;
}
