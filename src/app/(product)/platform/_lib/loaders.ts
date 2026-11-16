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
import type { OperationStatus, PlatformEvent, Principal } from "@/lib/controlplane/types";
import type { WorkspaceRoleOrNone } from "@/lib/capabilities/ports";
import { platformDb, repos } from "@/lib/controlplane/db";
import { approvalRoundOf, operationPlanReview, type ReviewedOperation } from "@/lib/controlplane/db/repos/operation-review";
import type { PlatformRunbooks } from "@/lib/platform/runbooks";
import { RunbookError, classifyRunbook } from "@/lib/machines/runbooks";
import { describeSchedule, diffRunbookSteps, type RunbookStepSpec } from "@/lib/platform/operator-journey";
import { executionPlaneReadiness, isRealProvider, REAL_PROVIDERS, type ExecutionReadiness } from "@/lib/bridge/readiness";
import { effectView, type EffectView } from "@/lib/effects/view";
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

/** External effects (provider calls whose outcome may be unknown) of one operation, newest first. Read-only. */
async function loadOperationEffects(workspaceId: string, operationId: string): Promise<EffectView[]> {
  const db = await platformDb();
  const rows = await repos.externalEffects.list(db, workspaceId, { operationId, includeContradicted: false, limit: 50 });
  return Promise.all(rows.map(async (e) => effectView(e, { fenceLive: await repos.externalEffects.isFenceLive(db, workspaceId, e.effectId) })));
}

export function loadOperation(id: string) {
  return loadPage(async (context, broker) => {
    if (!ENVIRONMENT_ID.test(id)) throw notFound();
    // This facade performs exactly the REST membership and visibility checks.
    await broker.getOperationDetail({ ...context, operationId: id });
    const record = await broker.deps.store.getOperation(context.workspaceId, id);
    if (!record) throw notFound();
    const [decision, approvals, timeline, estimates, effects] = await Promise.all([
      record.policyDecisionId ? broker.deps.store.getPolicyDecision(context.workspaceId, record.policyDecisionId) : undefined,
      broker.deps.store.listApprovals(context.workspaceId, id),
      broker.listOperationEvents({ ...context, operationId: id, limit: 500 }),
      repos.cost.list(await platformDb(), context.workspaceId, { operationId: id, limit: 1 }),
      loadOperationEffects(context.workspaceId, id),
    ]);
    // Preserve the native, validated review and current round alongside the
    // stored digests. A digest alone cannot supply a readable plan.
    const review = operationPlanReview(record);
    const operation: ReviewedOperation = publicData({
      id: record.id, workspaceId: record.workspaceId, projectId: record.projectId,
      environmentId: record.environmentId, resourceId: record.resourceId, capability: record.capability,
      principal: record.principal, status: record.status, proposal: { ...record.proposal, input: undefined },
      proposalDigest: record.proposalDigest, inputDigest: record.inputDigest, planDigest: record.planDigest,
      policyDecisionId: record.policyDecisionId, approvalRequired: record.approvalRequired,
      approvalRound: approvalRoundOf(record),
      correlationId: record.correlationId, error: record.error, createdAt: record.createdAt,
      updatedAt: record.updatedAt, startedAt: record.startedAt, finishedAt: record.finishedAt, expiresAt: record.expiresAt,
    });
    operation.proposal.input = publicData(record.proposal.input);
    // Bound the review separately so its size cannot truncate operation expiry
    // or round metadata. Revalidate the sanitized shape before exposing it.
    if (review) {
      operation.planReview = publicData(review);
      operation.planReview = operationPlanReview(operation);
    }
    const events: PlatformEvent[] = timeline.items.map((event) => ({
      ...event, workspaceId: context.workspaceId, type: event.type as PlatformEvent["type"],
      actor: event.actor ? { ...event.actor, kind: event.actor.kind as Principal["kind"] } : undefined,
    }));
    // A workflow-executed legacy deployment projects this operation; link it so both views are one journey.
    const projectIds = new Set(db().projects.filter((p) => p.workspaceId === context.workspaceId).map((p) => p.id));
    const linkedDeployment = db().deployments.find((d) => d.operationId === id && projectIds.has(d.projectId));
    return { operation, decision: decision ? publicData(decision) : undefined, approvals: approvals.map((a) => publicData(a)), events,
      linkedDeploymentId: linkedDeployment?.id, effects,
      timelineTruncated: timeline.items.length === 500, estimate: estimates[0] ? publicData(estimates[0].estimate) : undefined };
  });
}

/** A legacy product deployment, read inside the active workspace only; a foreign id is the same 404 as a missing one. */
export function loadDeployment(id: string) {
  return loadPage(async (context, broker) => {
    if (!ENVIRONMENT_ID.test(id)) throw notFound();
    const projectIds = new Set(db().projects.filter((p) => p.workspaceId === context.workspaceId).map((p) => p.id));
    const dep = db().deployments.find((d) => d.id === id && projectIds.has(d.projectId));
    if (!dep) throw notFound();
    let linked: { id: string; status: OperationStatus; planDigest?: string; proposalDigest?: string } | undefined;
    if (dep.executor === "workflow" && dep.operationId) {
      const op = await broker.deps.store.getOperation(context.workspaceId, dep.operationId);
      if (op) linked = { id: op.id, status: op.status, planDigest: op.planDigest, proposalDigest: op.proposalDigest };
    }
    return {
      deployment: publicData({ id: dep.id, status: dep.status, executor: dep.executor, operationId: dep.operationId, createdAt: dep.createdAt, changeSummary: dep.changeSummary, steps: dep.steps.map((s) => ({ id: s.id, seq: s.seq, title: s.title, status: s.status })) }),
      linked,
    };
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
/** Standing grants with their usage history, newest use first. Public fields only. */
export function loadStandingGrants() {
  return loadPage(async (context, broker) => {
    const grants = await broker.listStandingGrants({ workspaceId: context.workspaceId, principal: context.principal });
    const rows = await Promise.all(grants.map(async (g) => ({ grant: g, uses: await broker.listStandingGrantUsage({ workspaceId: context.workspaceId, principal: context.principal, grantId: g.id }) })));
    return publicData(rows);
  });
}

export function loadPolicy() { return loadPage((context, broker) => broker.getWorkspacePolicy(context)); }

/** Runbook composition with its errors mapped onto the broker's, so pages show the same words as the API. */
async function runbooksFor(): Promise<PlatformRunbooks> {
  try { return await (await import("@/lib/platform/runbooks")).platformRunbooks(); }
  catch (e) {
    if (e instanceof RunbookError) throw new BrokerError("platform_store_unavailable", e.message);
    throw e;
  }
}
async function runbookRead<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof RunbookError) {
      if (e.code === "not_found") throw notFound();
      throw new BrokerError(e.code === "forbidden" ? "role_insufficient" : "invalid_state", e.message);
    }
    throw e;
  }
}

export function loadRunbooks() {
  return loadPage(async (context) => {
    const rb = await runbooksFor();
    const input = { workspaceId: context.workspaceId, principal: context.principal, limit: 50 };
    const [runbooks, runs, schedules] = await runbookRead(() => Promise.all([rb.service.listRunbooks(input), rb.service.listRuns(input), rb.service.listSchedules(input)]));
    return publicData({
      runbooks: runbooks.map((r) => ({ runbookId: r.runbookId, version: r.version, name: r.name, definitionDigest: r.definitionDigest, createdAt: r.createdAt, stepCount: r.definition.steps.length })),
      runs: runs.map((r) => ({ id: r.id, runbookId: r.runbookId, version: r.version, status: r.status, bindingDigest: r.bindingDigest, createdAt: r.createdAt, deadlineAt: r.deadlineAt, targetCount: r.targets.length, requestedBy: r.requester.name || r.requestedBy })),
      schedules: schedules.map((s) => ({ id: s.id, runbookId: s.runbookId, version: s.version, status: s.status, nextDueAt: s.nextDueAt, bindingDigest: s.bindingDigest, targetCount: s.targets.length, createdBy: s.creator.name || s.createdBy, creatorId: s.creator.onBehalfOf ?? s.creator.id, lines: describeSchedule(s.spec) })),
    });
  });
}

export function loadRunbookRun(id: string) {
  return loadPage(async (context) => {
    if (!ENVIRONMENT_ID.test(id)) throw notFound();
    const rb = await runbooksFor();
    return runbookRead(async () => {
      const read = await rb.service.readRun({ workspaceId: context.workspaceId, runId: id, principal: context.principal });
      if (!read) throw notFound();
      const { run, steps, audit } = read;
      const version = await rb.store.getVersion(context.workspaceId, run.runbookId, run.version);
      const previous = run.version > 1 ? await rb.store.getVersion(context.workspaceId, run.runbookId, run.version - 1) : null;
      const specs = (version?.definition.steps ?? []) as RunbookStepSpec[];
      return publicData({
        run: { id: run.id, runbookId: run.runbookId, version: run.version, status: run.status, definitionDigest: run.definitionDigest, bindingDigest: run.bindingDigest, scheduleId: run.scheduleId, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, deadlineAt: run.deadlineAt, cancelRequestedAt: run.cancelRequestedAt, failureCode: run.failureCode, maxParallelTargets: run.maxParallelTargets, requester: { id: run.requester.id, name: run.requester.name, kind: run.requester.kind, onBehalfOf: run.requester.onBehalfOf } },
        name: version?.name ?? run.runbookId,
        targets: run.targets.map((t) => ({ ...t })),
        steps: steps.map((s) => ({ targetIndex: s.targetIndex, stepId: s.stepId, status: s.status, errorCode: s.errorCode, startedAt: s.startedAt, finishedAt: s.finishedAt })),
        diff: version ? diffRunbookSteps(previous ? (previous.definition.steps as RunbookStepSpec[]) : undefined, specs) : [],
        hasPrevious: Boolean(previous),
        classification: version ? classifyRunbook(version.definition) : undefined,
        audit: audit.map((a) => ({ seq: a.seq, event: a.event, actor: a.actor, createdAt: a.createdAt })),
      });
    });
  });
}

export interface ReadinessData { providers: readonly string[]; selected: string; readiness?: ExecutionReadiness; visible: boolean }

/** Readiness names environment variables of the install, so it is shown to editors and admins only. */
export function loadReadiness(params: Search) {
  return loadPage(async (context): Promise<ReadinessData> => {
    const requested = one(params, "provider");
    const selected = requested && isRealProvider(requested) ? requested : "aws";
    if (context.role !== "admin" && context.role !== "editor") return { providers: REAL_PROVIDERS, selected, visible: false };
    return { providers: REAL_PROVIDERS, selected, visible: true, readiness: publicData(await executionPlaneReadiness(selected)) };
  });
}
