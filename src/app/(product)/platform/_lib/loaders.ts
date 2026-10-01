/**
 * Server page loaders use the same broker facade as REST, inside the product
 * store scope. No host-header HTTP fetch, bearer credential or demo fallback
 * with configured authentication. Only public read models reach the browser.
 */
import { db, runInStoreScope } from "@/lib/db/store";
import { currentWorkspace } from "@/lib/server/workspace";
import { getSessionUser } from "@/lib/auth/session";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { platformBroker, type Broker } from "@/lib/capabilities/platform";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import type { OperationRecord, OperationStatus, PlatformEvent, Principal } from "@/lib/controlplane/types";
import type { WorkspaceRoleOrNone } from "@/lib/capabilities/ports";
import { platformDb, repos } from "@/lib/controlplane/db";
import { publicData, readResources, readDrift, readIncidents, ENVIRONMENT_ID, type ReadCaller } from "./read-models";

export interface PageContext extends ReadCaller {
  role: WorkspaceRoleOrNone;
  environments: { id: string; name: string; class: string }[];
}
export type PageResult<T> = { data: T; context: PageContext } | { error: string; missing?: boolean };

export async function loadPage<T>(read: (context: PageContext, broker: Broker) => Promise<T>): Promise<PageResult<T>> {
  try {
    return await runInStoreScope(async () => {
      const user = await getSessionUser();
      if (!user && isSupabaseConfigured()) throw new BrokerError("unauthenticated", "Sign in to view the platform.");
      const workspace = await currentWorkspace();
      if (!workspace) return { error: "No workspace yet. Complete onboarding to use the platform.", missing: true };
      const principal = { kind: "user" as const, id: user?.id ?? "local", name: user?.name ?? "You" };
      const broker = await platformBroker();
      const access = await broker.deps.roles.resolve(principal, workspace.id);
      if (access.role === "none") throw notFound();
      const projectIds = new Set(db().projects.filter((p) => p.workspaceId === workspace.id).map((p) => p.id));
      const context: PageContext = {
        principal, workspaceId: workspace.id, role: access.role, surface: "ui",
        environments: db().environments.filter((e) => projectIds.has(e.projectId)).map((e) => ({ id: e.id, name: publicData(e.name), class: e.class })),
      };
      return { context, data: await read(context, broker) };
    });
  } catch (error) {
    if (error instanceof BrokerError) return { error: publicData(error.message), missing: error.status === 404 };
    return { error: "The platform could not be read. Restore the platform store and services, then reload." };
  }
}

export const OPERATION_STATUSES: readonly OperationStatus[] = ["proposed", "awaiting_approval", "approved", "rejected", "denied", "queued", "running", "succeeded", "failed", "uncertain", "cancelled", "expired"];
export type Search = Record<string, string | string[] | undefined>;
export function one(params: Search, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function loadOperations(params: Search) {
  return loadPage(async (context, broker) => {
    const status = one(params, "status");
    const environmentId = one(params, "environmentId");
    const cursor = one(params, "cursor");
    if (status && !OPERATION_STATUSES.includes(status as OperationStatus)) throw new BrokerError("invalid_request", "Choose a known operation status.");
    if (environmentId && !ENVIRONMENT_ID.test(environmentId)) throw new BrokerError("invalid_request", "Choose a valid environment.");
    if (cursor && !/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw new BrokerError("invalid_request", "The page cursor is not valid.");
    return broker.listOperations({ ...context, filters: { status: status ? [status as OperationStatus] : undefined, environmentId }, limit: 50, cursor });
  });
}

export function loadOperation(id: string) {
  return loadPage(async (context, broker) => {
    if (!ENVIRONMENT_ID.test(id)) throw notFound();
    // This facade performs exactly the REST membership and visibility checks.
    await broker.getOperationDetail({ ...context, operationId: id });
    const record = await broker.deps.store.getOperation(context.workspaceId, id);
    if (!record) throw notFound();
    const [decision, approvals, timeline, estimates] = await Promise.all([
      record.policyDecisionId ? broker.deps.store.getPolicyDecision(context.workspaceId, record.policyDecisionId) : undefined,
      broker.deps.store.listApprovals(context.workspaceId, id),
      broker.listOperationEvents({ ...context, operationId: id, limit: 500 }),
      repos.cost.list(await platformDb(), context.workspaceId, { operationId: id, limit: 1 }),
    ]);
    // The components need digest-bound records; REST's flattened approval DTO
    // omits those facts. Preserve actual stored digests, never reconstruct them.
    const operation: OperationRecord = publicData({
      id: record.id, workspaceId: record.workspaceId, projectId: record.projectId,
      environmentId: record.environmentId, resourceId: record.resourceId, capability: record.capability,
      principal: record.principal, status: record.status, proposal: { ...record.proposal, input: undefined },
      proposalDigest: record.proposalDigest, inputDigest: record.inputDigest, planDigest: record.planDigest,
      policyDecisionId: record.policyDecisionId, approvalRequired: record.approvalRequired,
      correlationId: record.correlationId, error: record.error, createdAt: record.createdAt,
      updatedAt: record.updatedAt, startedAt: record.startedAt, finishedAt: record.finishedAt, expiresAt: record.expiresAt,
    });
    operation.proposal.input = publicData(record.proposal.input);
    const events: PlatformEvent[] = timeline.items.map((event) => ({
      ...event, workspaceId: context.workspaceId, type: event.type as PlatformEvent["type"],
      actor: event.actor ? { ...event.actor, kind: event.actor.kind as Principal["kind"] } : undefined,
    }));
    return { operation, decision: decision ? publicData(decision) : undefined, approvals: approvals.map((a) => publicData(a)), events,
      timelineTruncated: timeline.items.length === 500, estimate: estimates[0] ? publicData(estimates[0].estimate) : undefined };
    // No readable PlanView is persisted by the current execution ports. A
    // digest alone cannot produce a changes table; the page states this limit.
  });
}

export function loadEnvironment(id: string, cursor?: string) {
  return loadPage(async (context, broker) => {
    const [resources, drift, autonomy] = await Promise.all([
      readResources(context, id, 100, cursor), readDrift(context, id),
      broker.getAutonomy({ ...context, environmentId: id }),
    ]);
    return { resources, drift, autonomy };
  });
}

export function loadInvestigations(id: string) { return loadPage((context) => readIncidents(context, id)); }
export function loadPolicy() { return loadPage((context, broker) => broker.getWorkspacePolicy(context)); }
