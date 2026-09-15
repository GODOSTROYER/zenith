/**
 * The typed action registry — Zenith's backbone.
 *
 * Every meaningful mutation in the product is an Action: the UI calls
 * actions, the REST API calls actions, and the Navigator agent calls the
 * SAME actions. Each action supports plan (readable preview + cost/risk),
 * execute (idempotent, audited), and optional undo.
 *
 * Agentic control is therefore architected from day one; the agent surface
 * ships last, but it will have nothing to learn that the UI doesn't already do.
 *
 * Concrete actions live in src/lib/actions/defs/.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { withMutationGate } from "./mutation-gate";
import { appendAuditAsync, db, save } from "@/lib/db/store";
import { id, type Actor, type AutonomyLevel } from "@/lib/domain/types";
import { membershipPolicy } from "@/lib/auth/policy";
import { WORKSPACE_ROLE_RANK, type WorkspaceRole } from "@/lib/domain/roles";

export interface ActionContext {
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  actor: Actor;
  /** Set by the authenticated integration coordinator, never read from action input. */
  integration?: { operationId: string; clientId: string; proposalDigest: string };
  /** effective autonomy level when actor.type === "navigator" */
  autonomy?: AutonomyLevel;
}

export type Risk = "low" | "medium" | "high";
/** Re-exported from the shared, browser-safe rank table. */
export type Role = WorkspaceRole;
export { WORKSPACE_ROLE_RANK, roleReaches, roleShortfall } from "@/lib/domain/roles";

export interface ActionPlan {
  /** one-sentence, human-readable statement of what will happen */
  summary: string;
  /** bullet-level detail lines */
  details: string[];
  costDeltaUsd: number;
  risk: Risk;
  /** advisory only — things worth knowing that do NOT stop the action */
  warnings: string[];
  /** true when policy requires a human to approve before execute */
  requiresApproval: boolean;
  /**
   * Set when `execute` would refuse this exact input: the reason AND the fix,
   * in prose. A surface that renders a plan MUST disable its confirm control
   * when this is present and show this string — that is what stops a button
   * from being a dead control. Absent means execute is expected to run.
   */
  blocked?: string;
  /** the role execute demands, so a refusal can be explained before it happens */
  requiredRole?: Role;
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
    | "navigator"
    | "hosted";
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

type G = typeof globalThis & { __zenithActions?: Map<string, ActionDef<unknown>> };

export function actionRegistry(): Map<string, ActionDef<unknown>> {
  const g = globalThis as G;
  if (!g.__zenithActions) g.__zenithActions = new Map();
  return g.__zenithActions;
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


/**
 * The acting user's role in this workspace. The member record is the authority;
 * the local demo actor (and any caller in a store with no members at all — the
 * seed script, the smoke run, tests) is admin because there is nobody else.
 * A user who is not a member gets the lowest role rather than the highest.
 */
/**
 * The caller's role in ONE workspace. Membership is per workspace, so an
 * admin of A is whatever their row in B says — or a viewer if they have none.
 * The workspace is required: every enforcement path has one, and a lookup that
 * spanned all of them would answer with whichever workspace sorted first.
 */
export function roleOf(actor: Actor, workspaceId: string): Role {
  const members = db().members.filter((m) => m.workspaceId === workspaceId);
  const member = members.find((m) => m.id === actor.id);
  if (member) return member.role;
  // An empty member table means "nobody to defer to" only where the
  // membership policy says so; hosted workspaces always have the admin who
  // created them.
  if (actor.id === "local" || (members.length === 0 && membershipPolicy().emptyWorkspaceGrantsAdmin))
    return "admin";
  return "viewer";
}

/* ------------------------------- idempotency ------------------------------- */

/**
 * Bounded replay cache: a retried request inside the window gets the original
 * result, and the map can never grow without limit.
 *
 * One contract, the same one `agent-access/control/journal.ts:119` and
 * `hosted/authority/jobs.ts` implement durably: a key is scoped by **tenant +
 * principal + operation** — workspace, actor and action id — and bound to a
 * **canonical hash of the request**. Same key + same request returns the
 * retained outcome; same key + a *different* request is an `idempotency_conflict`,
 * never the first request's answer wearing the second one's name.
 *
 * TODO(ceiling): in-process only, and deliberately still so in this change.
 * A restart clears the window, so a retry that crosses a restart applies twice,
 * and two instances share no window at all. `IDEM_WINDOW_NOTE` and the
 * `idempotency` block on every execute response state that out loud; bounding
 * it durably is a storage decision, not a rename of this map.
 */
const IDEM_MAX = 500;
const IDEM_TTL_MS = 10 * 60_000;

/** The honest description of the replay guarantee, for API docs and plan copy. */
export const IDEM_WINDOW_NOTE =
  "Retries with the same idempotencyKey return the first result for 10 minutes, per workspace, actor and action, and only when the request body hashes the same; a different body under the same key is refused as idempotency_conflict. The window lives in this server process: if the server restarts, or the retry reaches another instance, a retry runs the action again.";

/**
 * What the response says about the replay guarantee that answered it.
 *
 * Returned on every execute so a caller can reason about its own retries
 * instead of reading the source: `scope: "process"` is the load-bearing word —
 * this window is not shared with any other instance and does not survive a
 * restart. The API route serialises the whole `runAction` return value, so this
 * reaches clients without the route knowing anything about it.
 */
export interface IdempotencyReport {
  /** Whether the caller supplied a key at all. */
  applied: boolean;
  /** Where the window lives. Only ever `"process"` today — say so, don't imply more. */
  scope: "process";
  /** True when it is best-effort: lost on restart, not shared across instances. */
  bestEffort: true;
  /** True when this response is a replay of an earlier identical request. */
  replayed: boolean;
  windowMs: number;
  note: string;
}

const idempotencyReport = (applied: boolean, replayed: boolean): IdempotencyReport => ({
  applied,
  scope: "process",
  bestEffort: true,
  replayed,
  windowMs: IDEM_TTL_MS,
  note: IDEM_WINDOW_NOTE,
});

interface IdemEntry {
  at: number;
  /** Canonical hash of the request this key was first used for. */
  requestHash: string;
  result: ActionResult;
}

type GI = typeof globalThis & { __zenithIdem?: Map<string, IdemEntry> };

function idemCache(): Map<string, IdemEntry> {
  const g = globalThis as GI;
  if (!g.__zenithIdem) g.__zenithIdem = new Map();
  return g.__zenithIdem;
}

function idemGet(key: string): IdemEntry | undefined {
  const cache = idemCache();
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > IDEM_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit;
}

function idemSet(key: string, requestHash: string, result: ActionResult): void {
  const cache = idemCache();
  cache.delete(key); // re-insert so Map iteration order is oldest-first
  cache.set(key, { at: Date.now(), requestHash, result });
  for (const [k, v] of cache) {
    if (cache.size <= IDEM_MAX && Date.now() - v.at <= IDEM_TTL_MS) break;
    cache.delete(k);
  }
}

/**
 * A stable JSON form for hashing. Mirrors `hashIntent` in
 * `hosted/authority/jobs.ts` — sorted keys, ISO dates, `undefined` dropped —
 * with one deliberate difference: it never throws. A value that has no natural
 * JSON form is hashed as a tagged string rather than turned into a 500, because
 * this runs *after* the action's own schema has accepted the input and a
 * refusal here would fail a request the action itself considers valid.
 */
function canonicalForHash(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalForHash);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner === undefined) continue;
      out[key] = canonicalForHash(inner);
    }
    return out;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : `number:${String(value)}`;
  if (typeof value === "string" || typeof value === "boolean") return value;
  return `${typeof value}:${String(value)}`;
}

/**
 * The request identity a key is bound to: the validated input plus the scope it
 * was aimed at. Two requests that differ only in their project or environment
 * are two different requests, even under one key.
 */
function requestHashOf(ctx: ActionContext, input: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalForHash({
          input,
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
        })
      )
    )
    .digest("hex");
}

/* -------------------------------- executor -------------------------------- */

export interface RunOptions {
  mode: "plan" | "execute";
  idempotencyKey?: string;
}

/** What one `runAction` call answers with. `plan` for plans, `result` for executes. */
export interface ActionRun {
  plan?: ActionPlan;
  result?: ActionResult;
  /**
   * Present on every execute: what the replay window did, and what it is worth.
   * Absent on plans, which change nothing and are never replayed.
   */
  idempotency?: IdempotencyReport;
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
): Promise<ActionRun> {
  const action = getAction(actionId);
  if (opts.mode === "execute" && action.mutates) return withMutationGate(() => runActionInsideGate(actionId, ctx, rawInput, opts));
  return runActionInsideGate(actionId, ctx, rawInput, opts);
}
async function runActionInsideGate(
  actionId: string, ctx: ActionContext, rawInput: unknown, opts: RunOptions
): Promise<ActionRun> {
  const action = getAction(actionId);
  const parsed = action.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    if (opts.mode === "plan") {
      // Not a plannable plan: execute would reject this input, so the preview
      // says so rather than rendering an enabled confirm button.
      return {
        plan: {
          // Summary text is load-bearing: components/inspector/logic.ts
          // reads `blocked` and shows the schema errors as the reason.
          summary: "Invalid input.",
          details: [msg],
          costDeltaUsd: 0,
          risk: "low",
          warnings: [],
          requiresApproval: false,
          requiredRole: action.requiredRole,
          blocked: `${msg}. Correct the highlighted field, then try again.`,
        },
      };
    }
    return { result: { ok: false, summary: "Invalid input.", error: msg } };
  }
  const input = parsed.data;

  if (opts.mode === "plan") {
    // A plan that cannot even be computed (a stale project id, an environment
    // that no longer exists) is a refusal, not a server error: the require*
    // helpers throw messages that already carry their fix, and the caller
    // needs that sentence on a disabled button, not a generic 500.
    let planned;
    try {
      planned = await action.plan(ctx, input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        plan: {
          summary: "This cannot be planned as things stand.",
          details: [message],
          costDeltaUsd: 0,
          risk: "low",
          warnings: [],
          requiresApproval: false,
          requiredRole: action.requiredRole,
          blocked: message,
        },
      };
    }
    return { plan: withRoleBlock(ctx, action, planned) };
  }

  // Role enforcement: a human may only execute up to their workspace role.
  // (Planning is read-only and stays open — you can always see what an action
  // would do before asking someone who is allowed to run it.)
  if (ctx.actor.type === "user") {
    const role = roleOf(ctx.actor, ctx.workspaceId);
    if (WORKSPACE_ROLE_RANK[role] < WORKSPACE_ROLE_RANK[action.requiredRole]) {
      const denied: ActionResult = {
        ok: false,
        summary: `"${action.title}" needs the ${action.requiredRole} role and you are ${role} in this workspace.`,
        error: `role_denied: ask a workspace admin to give ${ctx.actor.name} the ${action.requiredRole} role in Settings → Members, or have them run this action.`,
      };
      await audit(ctx, action, input, "denied", denied.summary, denied.error);
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
      await audit(ctx, action, input, "denied", denied.summary);
      return { result: denied };
    }
    if (level === "bounded" && action.risk !== "low") {
      const denied: ActionResult = {
        ok: false,
        summary: `Bounded autonomy only permits low-risk actions; "${action.title}" is ${action.risk} risk and needs approval.`,
        error: "autonomy_denied",
      };
      await audit(ctx, action, input, "denied", denied.summary);
      return { result: denied };
    }
  }

  // Tenant + principal + operation: the same key in another workspace, from
  // another actor, or against another action is another request entirely.
  const idemKey = opts.idempotencyKey
    ? `${ctx.workspaceId}:${ctx.actor.id}:${actionId}:${opts.idempotencyKey}`
    : undefined;
  const requestHash = idemKey ? requestHashOf(ctx, input) : "";
  if (idemKey) {
    const cached = idemGet(idemKey);
    if (cached && cached.requestHash !== requestHash)
      return {
        result: {
          ok: false,
          summary: `Idempotency key "${opts.idempotencyKey}" was already used for a different ${action.title} request.`,
          // Same contract as control/journal.ts:119 and hosted/authority/jobs.ts:
          // a reused key with different inputs is a conflict, never a silent
          // replay of somebody else's request.
          error:
            "idempotency_conflict: this key belongs to different inputs. Send a new idempotency key for a new request, or resend the original request unchanged to receive its retained outcome.",
        },
        idempotency: idempotencyReport(true, false),
      };
    if (cached) return { result: cached.result, idempotency: idempotencyReport(true, true) };
  }

  try {
    const result = await action.execute(ctx, input);
    // Business state BEFORE the audit await, and deliberately.
    //
    // `execute()` has already mutated the live in-memory `db()` object, so the
    // only two orderings available are "persist it" and "leave it dangling for
    // an unrelated later save() to flush". There is no transaction spanning the
    // product store and the audit log (ADR D-4), so this persists first and then
    // reports an audit failure honestly, rather than skipping the save and
    // leaving a half-applied mutation that the next action's save() commits
    // behind a request that was told it failed.
    if (action.mutates) save();
    try {
      await audit(ctx, action, input, result.ok ? "ok" : "error", result.summary, result.error);
    } catch (auditError) {
      // The effect happened and is persisted; its audit row is not. Neither
      // "success" nor "nothing happened" is true, so say exactly that — an
      // action never reports ok when a record it is required to write is
      // missing. Retained under the key so a retry does not apply it twice.
      const message = auditError instanceof Error ? auditError.message : String(auditError);
      console.error(`Zenith could not write the audit row for ${action.id}: ${message}`);
      const unaudited: ActionResult = {
        ok: false,
        summary: `${action.title} was applied, but its audit record could not be written.`,
        data: result.data,
        error: `audit_write_failed: ${message}. The change itself is saved; re-run nothing until the audit log is readable again, and reconcile from the object's own history.`,
      };
      if (idemKey) idemSet(idemKey, requestHash, unaudited);
      return { result: unaudited, idempotency: idempotencyReport(Boolean(idemKey), false) };
    }
    if (idemKey) idemSet(idemKey, requestHash, result);
    return { result, idempotency: idempotencyReport(Boolean(idemKey), false) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ActionResult = {
      ok: false,
      summary: `${action.title} failed.`,
      error: message,
    };
    try {
      await audit(ctx, action, input, "error", result.summary, message);
    } catch (auditError) {
      // A failed action must still be returned as an error when the secondary
      // failure audit cannot be persisted; never turn it into an unhandled
      // request exception or claim that the mutation succeeded.
      console.error(`Zenith could not write the failure audit row: ${(auditError as Error).message}`);
    }
    // Deliberately not cached under the idempotency key: a request that threw
    // may be retried, and retaining the throw would make a transient failure
    // permanent for that key.
    //
    // TODO(ceiling): an `execute()` that throws half-way may leave its partial
    // mutation in the in-memory `db()` object, which a later unrelated `save()`
    // would flush. The store has no rollback primitive to undo it with — the
    // fix is a real transaction boundary (ADR D-4), not a `save()` here, which
    // would persist exactly the half-applied state this comment warns about.
    return { result, idempotency: idempotencyReport(Boolean(idemKey), false) };
  }
}

/**
 * Every plan carries the role its execute demands, and says so up front when
 * the caller does not have it. One place, so no action can forget — and so a
 * confirm button is never enabled for something that will be refused.
 */
function withRoleBlock(
  ctx: ActionContext,
  action: ActionDef<unknown>,
  plan: ActionPlan
): ActionPlan {
  // A plan may declare its own requiredRole when it previews a *different*
  // action's execution — deploy.plan is read-only but describes deploy.apply,
  // and the button the user will press is the one that must not be dead.
  const out: ActionPlan = { requiredRole: action.requiredRole, ...plan };
  const needed = out.requiredRole ?? action.requiredRole;
  if (out.blocked || ctx.actor.type !== "user") return out;
  const role = roleOf(ctx.actor, ctx.workspaceId);
  if (WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[needed]) return out;
  out.blocked =
    `"${action.title}" needs the ${needed} role and you are ${role} in this workspace. ` +
    `Ask a workspace admin to raise your role in Settings → Members, or have them run it.`;
  return out;
}

async function audit(
  ctx: ActionContext,
  action: ActionDef<unknown>,
  input: unknown,
  result: "ok" | "error" | "denied",
  summary: string,
  error?: string
) {
  if (!action.mutates && result === "ok") return; // don't audit reads
  await appendAuditAsync({
    ts: new Date().toISOString(),
    id: id(),
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    actor: ctx.actor,
    actionId: action.id,
    input: capSnapshot(redact(ctx.integration ? { integration: ctx.integration, inputStoredInReceipt: true } : input)),
    result,
    summary,
    error,
  });
}

/* -------------------------------- redaction ------------------------------- */

const MASK = "•••";
/** Field names that hold a credential. `key` is NOT one — it names a variable. */
const SECRET_FIELD = /secret|password|passwd|token|credential|apikey|api_key|accesskey/i;
/** Variable NAMES whose value is probably a credential (the { key, value } shape). */
const SECRET_VAR_NAME = /key|secret|token|password|passwd|credential/i;

/**
 * Strip anything that looks like a secret before it reaches the audit log.
 *
 * Direction matters: a field literally called `key` holds the NAME of a
 * variable, which is never sensitive and is the only thing that makes the row
 * readable. The `value` beside it is what can be a credential — so for the
 * `{ key, value }` shape the value is masked when the name looks secret-ish.
 */
function redact(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const clone: Record<string, unknown> = Array.isArray(input)
    ? ({ ...input } as unknown as Record<string, unknown>)
    : { ...(input as Record<string, unknown>) };
  for (const k of Object.keys(clone)) {
    if (SECRET_FIELD.test(k) && typeof clone[k] === "string") clone[k] = MASK;
    else if (typeof clone[k] === "object") clone[k] = redact(clone[k]);
  }
  if (
    typeof clone.key === "string" &&
    typeof clone.value === "string" &&
    SECRET_VAR_NAME.test(clone.key)
  )
    clone.value = MASK;
  return Array.isArray(input) ? Object.values(clone) : clone;
}

/* ---------------------------- audit input budget --------------------------- */

/**
 * The audit log is scanned backwards under a byte budget, so one whole-manifest
 * snapshot per Source save is enough to swallow a page of history. Keep the
 * shape (which keys were sent) and lose the bulk, saying so where it was cut.
 */
const AUDIT_INPUT_MAX = 4096;
const AUDIT_STRING_MAX = 200;
const AUDIT_ARRAY_MAX = 20;

const bytes = (v: unknown) => JSON.stringify(v)?.length ?? 0;

function shrink(v: unknown): unknown {
  if (typeof v === "string")
    return v.length <= AUDIT_STRING_MAX
      ? v
      : `${v.slice(0, AUDIT_STRING_MAX)}… (truncated, ${v.length} chars)`;
  if (Array.isArray(v))
    return v.length <= AUDIT_ARRAY_MAX
      ? v.map(shrink)
      : [...v.slice(0, AUDIT_ARRAY_MAX).map(shrink), `… (truncated, ${v.length} items)`];
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shrink(x)])
    );
  return v;
}

function capSnapshot(input: unknown): unknown {
  if (bytes(input) <= AUDIT_INPUT_MAX) return input;
  const small = shrink(input);
  if (bytes(small) <= AUDIT_INPUT_MAX) return small;
  return {
    truncated: `Input was ${bytes(input)} bytes; only its shape is recorded. The full value is in the revision or the working copy it produced.`,
    keys: input && typeof input === "object" ? Object.keys(input) : undefined,
  };
}
