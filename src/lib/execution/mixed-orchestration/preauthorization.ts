/**
 * Precise output preauthorizations (PROD-MIX-03: "newly materialized effects require review
 * unless precisely preauthorized").
 *
 * A preauthorization is a workspace admin's explicit, browser-session decision that ONE
 * dependency reference of ONE parent operation may be materialized and consumed without a
 * fresh review. It is deliberately narrower than a DUR-04 standing grant: it names the parent
 * operation, the reference and its contract digest, the consumer's immutable subplan digest,
 * the producer's subplan digest, the parent's desired-inputs digest and the value type. For a
 * secret it names the exact vault reference (a new version of that reference is the
 * materialization the grant exists for; a different reference is not covered). Optionally it
 * pins the value digest. It has 1 to 10 uses (reserved atomically), expires between five
 * minutes and seven days, and lapses when revoked or when its creator stops being an admin.
 * No field accepts a wildcard, a list of references or a secret value.
 *
 * It never covers a change of desired inputs, scope, a different consumer subplan or contract:
 * those change the parent's `desiredDigest` and always need a person's review.
 */
import { z } from "zod";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { memberAccess, newId, requireHumanSession } from "@/lib/capabilities/internal";
import { ROLE_RANK, type BrokerDeps } from "@/lib/capabilities/ports";
import { scrubSecrets } from "@/lib/capabilities/secret-guard";
import type { BrowserSessionProof } from "@/lib/capabilities/types";
import type { Principal } from "@/lib/controlplane/types";
import { ID, SHA, VAULT_REF } from "./errors";

export const PREAUTH_MIN_LIFETIME_MS = 5 * 60_000;
export const PREAUTH_MAX_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export const PREAUTH_MAX_USES = 10;

export interface OutputPreauthorization {
  id: string;
  workspaceId: string;
  environmentId: string;
  parentOperationId: string;
  createdBy: string;
  createdByName: string;
  desiredDigest: string;
  referenceId: string;
  contractDigest: string;
  consumerSubplanDigest: string;
  producerSubplanDigest: string;
  valueType: "string" | "number" | "boolean" | "resource_id" | "endpoint" | "secret_ref";
  /** Required for `secret_ref`, forbidden otherwise. A vault reference, never a value. */
  secretRef?: string;
  /** Optional pin of the exact value digest. */
  valueDigest?: string;
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  status: "active" | "revoked";
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
}
export type NewOutputPreauthorization = Omit<OutputPreauthorization, "uses" | "status" | "revokedAt" | "revokedBy" | "revokedReason">;

export interface PreauthorizationStore {
  create(input: NewOutputPreauthorization): Promise<OutputPreauthorization>;
  get(workspaceId: string, id: string): Promise<OutputPreauthorization | null>;
  list(workspaceId: string, filter?: { parentOperationId?: string; activeOnly?: boolean; now?: Date; limit?: number }): Promise<OutputPreauthorization[]>;
  revoke(input: { workspaceId: string; id: string; revokedBy: string; reason?: string; at: Date }): Promise<OutputPreauthorization | null>;
  /** One guarded step: active, unexpired, below `maxUses`. Returns null otherwise. */
  reserveUse(input: { workspaceId: string; id: string; now: Date }): Promise<OutputPreauthorization | null>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryPreauthorizationStore implements PreauthorizationStore {
  private readonly rows = new Map<string, OutputPreauthorization>();
  private key = (workspaceId: string, id: string): string => `${workspaceId}\u0000${id}`;

  async create(input: NewOutputPreauthorization): Promise<OutputPreauthorization> {
    if (this.rows.has(this.key(input.workspaceId, input.id))) throw new BrokerError("conflict", "That preauthorization id already exists.");
    const stored: OutputPreauthorization = { ...clone(input), uses: 0, status: "active" };
    this.rows.set(this.key(input.workspaceId, input.id), stored);
    return clone(stored);
  }

  async get(workspaceId: string, id: string): Promise<OutputPreauthorization | null> {
    const row = this.rows.get(this.key(workspaceId, id));
    return row ? clone(row) : null;
  }

  async list(workspaceId: string, filter: { parentOperationId?: string; activeOnly?: boolean; now?: Date; limit?: number } = {}): Promise<OutputPreauthorization[]> {
    const now = (filter.now ?? new Date()).getTime();
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && (!filter.parentOperationId || row.parentOperationId === filter.parentOperationId))
      .filter((row) => !filter.activeOnly || (row.status === "active" && Date.parse(row.expiresAt) > now && row.uses < row.maxUses))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .slice(0, Math.max(1, Math.min(200, filter.limit ?? 100))).map(clone);
  }

  async revoke(input: { workspaceId: string; id: string; revokedBy: string; reason?: string; at: Date }): Promise<OutputPreauthorization | null> {
    const row = this.rows.get(this.key(input.workspaceId, input.id));
    if (!row) return null;
    if (row.status === "active") {
      row.status = "revoked"; row.revokedAt = input.at.toISOString(); row.revokedBy = input.revokedBy;
      if (input.reason) row.revokedReason = input.reason;
    }
    return clone(row);
  }

  async reserveUse(input: { workspaceId: string; id: string; now: Date }): Promise<OutputPreauthorization | null> {
    const row = this.rows.get(this.key(input.workspaceId, input.id));
    if (!row || row.status !== "active" || Date.parse(row.expiresAt) <= input.now.getTime() || row.uses >= row.maxUses) return null;
    row.uses += 1;
    return clone(row);
  }
}

const Input = z.object({
  parentOperationId: z.string().regex(ID),
  environmentId: z.string().regex(ID),
  desiredDigest: z.string().regex(SHA),
  referenceId: z.string().regex(ID),
  contractDigest: z.string().regex(SHA),
  consumerSubplanDigest: z.string().regex(SHA),
  producerSubplanDigest: z.string().regex(SHA),
  valueType: z.enum(["string", "number", "boolean", "resource_id", "endpoint", "secret_ref"]),
  secretRef: z.string().regex(VAULT_REF).optional(),
  valueDigest: z.string().regex(SHA).optional(),
  maxUses: z.number().int().min(1).max(PREAUTH_MAX_USES),
  lifetimeMs: z.number().int().min(PREAUTH_MIN_LIFETIME_MS).max(PREAUTH_MAX_LIFETIME_MS),
  reason: z.string().max(300).optional(),
}).strict();
export type CreatePreauthorizationInput = z.infer<typeof Input>;

function invalid(message: string): never {
  throw new BrokerError("invalid_request", message, "A preauthorization names one parent operation, one reference with its digests, a use count and an expiry.");
}

async function audit(deps: BrokerDeps, actor: Principal, scope: { workspaceId: string; environmentId: string }, data: Record<string, unknown>): Promise<void> {
  try {
    await deps.store.appendEvent({ type: "policy.evaluated", workspaceId: scope.workspaceId, environmentId: scope.environmentId, correlationId: newId(deps, "corr"), actor, data });
  } catch {
    /* the preauthorization row is authoritative; a missed audit append never turns a refusal into an allow */
  }
}

export async function createOutputPreauthorization(deps: BrokerDeps, store: PreauthorizationStore, input: { workspaceId: string; actor: Principal; session: BrowserSessionProof } & CreatePreauthorizationInput): Promise<OutputPreauthorization> {
  requireHumanSession(input.actor, input.session, "preauthorize a dependency output");
  const access = await memberAccess(deps, input.actor, input.workspaceId);
  if (ROLE_RANK[access.role] < ROLE_RANK.admin) throw new BrokerError("admin_required", `Preauthorizing an output needs the admin role and you are ${access.role} in this workspace.`, "Ask a workspace admin.");
  const { workspaceId, actor, session: _session, ...rest } = input;
  void _session;
  const parsed = Input.safeParse(rest);
  if (!parsed.success) return invalid("The preauthorization is malformed or exceeds a bound.");
  const body = parsed.data;
  if ((body.valueType === "secret_ref") !== (body.secretRef !== undefined)) invalid("A secret reference is required for secret_ref outputs and refused for every other type.");
  const resolved = await deps.scopes.resolve({ workspaceId, environmentId: body.environmentId });
  if (!resolved?.environment) throw notFound();
  if (access.allowedEnvironmentIds && !access.allowedEnvironmentIds.includes(body.environmentId)) throw notFound();
  const now = deps.clock.now();
  const reason = body.reason ? String(scrubSecrets(body.reason)).replace(/\s+/g, " ").slice(0, 300) : undefined;
  const row = await store.create({
    id: newId(deps, "mop"), workspaceId, environmentId: body.environmentId, parentOperationId: body.parentOperationId, createdBy: actor.id, createdByName: actor.name || actor.id,
    desiredDigest: body.desiredDigest, referenceId: body.referenceId, contractDigest: body.contractDigest, consumerSubplanDigest: body.consumerSubplanDigest,
    producerSubplanDigest: body.producerSubplanDigest, valueType: body.valueType, ...(body.secretRef ? { secretRef: body.secretRef } : {}), ...(body.valueDigest ? { valueDigest: body.valueDigest } : {}),
    maxUses: body.maxUses, expiresAt: new Date(now.getTime() + body.lifetimeMs).toISOString(), createdAt: now.toISOString(),
  });
  await audit(deps, actor, { workspaceId, environmentId: body.environmentId }, { kind: "mixed_output_preauthorization_created", preauthorizationId: row.id,
    parentOperationId: row.parentOperationId, referenceId: row.referenceId, maxUses: row.maxUses, expiresAt: row.expiresAt, ...(reason ? { reason } : {}) });
  return row;
}

export async function revokeOutputPreauthorization(deps: BrokerDeps, store: PreauthorizationStore, input: { workspaceId: string; id: string; actor: Principal; session: BrowserSessionProof; reason?: string }): Promise<OutputPreauthorization> {
  requireHumanSession(input.actor, input.session, "revoke a dependency output preauthorization");
  const access = await memberAccess(deps, input.actor, input.workspaceId);
  const row = await store.get(input.workspaceId, input.id);
  if (!row) throw notFound();
  if (ROLE_RANK[access.role] < ROLE_RANK.admin && row.createdBy !== input.actor.id) throw new BrokerError("role_insufficient", "Only the administrator who created a preauthorization, or another admin, can revoke it.", "Ask a workspace admin.");
  const reason = input.reason ? String(scrubSecrets(input.reason)).replace(/\s+/g, " ").slice(0, 300) : undefined;
  const revoked = await store.revoke({ workspaceId: input.workspaceId, id: input.id, revokedBy: input.actor.id, reason, at: deps.clock.now() });
  if (!revoked) throw notFound();
  await audit(deps, input.actor, { workspaceId: input.workspaceId, environmentId: revoked.environmentId }, { kind: "mixed_output_preauthorization_revoked", preauthorizationId: revoked.id, ...(reason ? { reason } : {}) });
  return revoked;
}

export async function listOutputPreauthorizations(deps: BrokerDeps, store: PreauthorizationStore, input: { workspaceId: string; principal: Principal; parentOperationId?: string; activeOnly?: boolean }): Promise<OutputPreauthorization[]> {
  const access = await memberAccess(deps, input.principal, input.workspaceId);
  const all = await store.list(input.workspaceId, { parentOperationId: input.parentOperationId, activeOnly: input.activeOnly, now: deps.clock.now() });
  return all.filter((row) => !access.allowedEnvironmentIds || access.allowedEnvironmentIds.includes(row.environmentId));
}

/**
 * Resolve preauthorizations by id for a decision: tenant-filtered, and only those that still stand
 * (active, unexpired, with uses left, creator still an admin). Anything else is simply absent, so the
 * decision falls back to review.
 */
export async function resolveLivePreauthorizations(deps: Pick<BrokerDeps, "roles">, store: PreauthorizationStore, workspaceId: string, ids: readonly string[], now: Date): Promise<OutputPreauthorization[]> {
  const live: OutputPreauthorization[] = [];
  for (const id of [...new Set(ids)].slice(0, 64)) {
    if (!ID.test(id)) continue;
    const row = await store.get(workspaceId, id);
    if (!row || row.status !== "active" || Date.parse(row.expiresAt) <= now.getTime() || row.uses >= row.maxUses) continue;
    const access = await deps.roles.resolve({ kind: "user", id: row.createdBy, name: row.createdByName }, workspaceId);
    if (ROLE_RANK[access.role] < ROLE_RANK.admin) continue;
    live.push(row);
  }
  return live;
}
