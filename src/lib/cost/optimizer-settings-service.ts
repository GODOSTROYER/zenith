import { z } from "zod";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { requireHumanSession } from "@/lib/capabilities/internal";
import type { BrowserSessionProof } from "@/lib/capabilities/types";
import type { Broker } from "@/lib/capabilities/platform";
import type { Principal, Sql } from "@/lib/controlplane/types";
import { getOptimizerSettings, putOptimizerSettings } from "@/lib/controlplane/db/repos/optimizer-settings";
import { append } from "@/lib/controlplane/db/repos/events";

export const OptimizerOptIn = z.object({ enabled: z.boolean(), expectedVersion: z.number().int().nonnegative() }).strict();
export interface OptimizerSettingsCaller { workspaceId: string; environmentId: string; actor: Principal; session: BrowserSessionProof }

async function authorize(broker: Broker, input: OptimizerSettingsCaller) {
  requireHumanSession(input.actor, input.session, "configure economic optimization");
  const access = await broker.deps.roles.resolve(input.actor, input.workspaceId);
  if (access.role === "none") throw notFound();
  if (access.role !== "admin") throw new BrokerError("role_insufficient", "Only a workspace admin can configure economic optimization.");
  const scope = await broker.deps.scopes.resolve({ workspaceId: input.workspaceId, environmentId: input.environmentId });
  if (!scope?.environment || scope.environment.id !== input.environmentId) throw notFound();
  const read = await broker.authorizeRead({ capability: "cost.estimate", scope: scope.scope }, input.actor);
  if (read.decision.outcome !== "allow" || !read.claims) throw new BrokerError("policy_denied", "Current policy refuses optimizer configuration.");
  return scope.scope;
}

export async function readOptimizerSettings(db: Sql, broker: Broker, input: OptimizerSettingsCaller) {
  await authorize(broker, input);
  return getOptimizerSettings(db, input.workspaceId, input.environmentId);
}

/** Versioned human consent plus audit in one transaction. Consent never approves an operation. */
export async function setOptimizerSettings(db: Sql, broker: Broker, input: OptimizerSettingsCaller, body: unknown) {
  const parsed = OptimizerOptIn.safeParse(body);
  if (!parsed.success) throw new BrokerError("invalid_request", "Supply enabled and the version returned by GET; no other fields are accepted.");
  const scope = await authorize(broker, input);
  return db.tx(async tx => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1), hashtext($2))", [input.workspaceId, `optimizer-settings:${input.environmentId}`]);
    const current = await getOptimizerSettings(tx, input.workspaceId, input.environmentId);
    if (current.version !== parsed.data.expectedVersion) throw new BrokerError("conflict", "Optimizer settings changed; reload before changing consent.");
    const settings = await putOptimizerSettings(tx, { workspaceId: input.workspaceId, environmentId: input.environmentId, updatedBy: input.actor.id, ...parsed.data });
    await append(tx, { type: "policy.evaluated", workspaceId: input.workspaceId, projectId: scope.projectId, environmentId: input.environmentId,
      correlationId: `optimizer-settings:${input.environmentId}:${settings.version}`, actor: input.actor,
      data: { kind: "optimizer_settings_changed", enabled: settings.enabled, version: settings.version, proposalOnly: true } });
    return { settings, proposalOnly: true as const, notice: "Opt-in permits measured optimization proposals. Each change still requires policy and operation approval; this consent never executes a change." };
  });
}
