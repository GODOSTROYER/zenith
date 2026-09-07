/**
 * Job admission: the idempotency rule every hosted mutation goes through.
 *
 * A client sends a UUID with its request. Sending the same UUID again is a
 * retry, and a retry must produce the same job, not a second publish. Sending
 * the same UUID with *different* content is not a retry at all — it is two
 * different operations wearing one name — so it is refused with
 * `idempotency_conflict` (409) rather than silently resolved to either one.
 *
 * The comparison is a SHA-256 over a canonical rendering of the intent: keys
 * sorted at every depth and `undefined` dropped, so `{ a, b }` and `{ b, a }`
 * are one intent and a reordered request body does not read as a conflict.
 *
 * Actor, kind, app and workspace are compared as fields rather than folded
 * into the hash. The guarantee is the same either way; the difference is that
 * the refusal can say *which* thing changed, which is what makes a 409
 * actionable instead of mysterious.
 *
 * Workstream W1 (hosted R3).
 */
import { createHash } from "node:crypto";
import { HostedError, type HostedJob, type JobKind, type Subject } from "@/lib/hosted/contracts";
import { authority } from "./lifecycle";

/** What admission needs to decide whether this is a new operation or a retry. */
export interface AdmitJobInput {
  /** The client's UUID. The idempotency key of the whole operation. */
  id: string;
  kind: JobKind;
  workspaceId: string;
  appId: string;
  actor: Subject;
  /** Everything that makes this operation what it is: source refs, target release, options. */
  intent: unknown;
  /** Starting phase. Defaults to `"queued"`. */
  phase?: string;
}

/** The admitted job, and whether this call is what created it. */
export interface AdmittedJob {
  job: HostedJob;
  /** False when an identical request had already been admitted — the retry case. */
  created: boolean;
}

/**
 * Canonical SHA-256 of any JSON-shaped value: object keys sorted at every
 * depth, `undefined` properties dropped, array order preserved.
 *
 * Rejects what JSON cannot carry losslessly — `NaN`, `Infinity`, `BigInt`,
 * functions, symbols and class instances other than `Date` — because
 * `JSON.stringify` turns most of those into `null` or `{}`, and an
 * idempotency key that quietly collapses two different intents into one hash
 * is worse than no key at all.
 */
export function hashIntent(intent: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(intent) ?? null)).digest("hex");
}

const unsupported = (what: string): HostedError =>
  new HostedError("invalid_input", `A job intent cannot contain ${what}: it has no stable JSON form to hash.`, {
    fix: "Send the intent as plain JSON — objects, arrays, strings, finite numbers, booleans and null. Render dates as ISO strings.",
  });

function canonical(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) throw unsupported(`a ${value.constructor?.name ?? "class"} instance`);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner === undefined) continue;
      out[key] = canonical(inner);
    }
    return out;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw unsupported(`the number ${String(value)}`);
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  throw unsupported(`a ${typeof value}`);
}

const conflict = (id: string, field: string, admitted: string, now: string): HostedError =>
  new HostedError(
    "idempotency_conflict",
    `Job ${id} was already admitted with a different ${field}, so this request was refused rather than joined to it.`,
    {
      fix: "Send a new job id (a fresh UUID) for a new operation, or resend the original request unchanged to follow the job that is already running.",
      details: { jobId: id, field, admitted, received: now },
    }
  );

/**
 * Admit a job, or return the one this id already names.
 *
 * Runs in one transaction, so the "does it exist / insert it" pair cannot
 * interleave with a concurrent request carrying the same id. Nests safely
 * inside a caller's own `tx()`.
 */
export function admitJob(input: AdmitJobInput): AdmittedJob {
  const intentHash = hashIntent(input.intent);
  const a = authority();
  return a.tx(() => {
    const existing = a.repos.jobs.get(input.id);
    if (existing) {
      if (existing.actor !== input.actor)
        throw conflict(input.id, "actor", existing.actor, input.actor);
      if (existing.kind !== input.kind) throw conflict(input.id, "kind", existing.kind, input.kind);
      if (existing.appId !== input.appId) throw conflict(input.id, "app", existing.appId, input.appId);
      if (existing.workspaceId !== input.workspaceId)
        throw conflict(input.id, "workspace", existing.workspaceId, input.workspaceId);
      if (existing.intentHash !== intentHash)
        throw conflict(input.id, "intent", existing.intentHash, intentHash);
      return { job: existing, created: false };
    }
    const job = a.repos.jobs.insert({
      id: input.id,
      kind: input.kind,
      workspaceId: input.workspaceId,
      appId: input.appId,
      actor: input.actor,
      intentHash,
      phase: input.phase,
    });
    return { job, created: true };
  });
}
