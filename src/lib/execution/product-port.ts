/**
 * The product-store port, implemented for real over `@/lib/db/store`.
 *
 * The product store (file JSON or Supabase Postgres, selected by
 * `ZENITH_STORE`) is what the UI reads. The execution worker reads the context
 * of an operation from it (workspace, project, environment, connection, revision
 * manifest) and writes the Deployment PROJECTION back: step statuses, status
 * events, outputs and the final outcome.
 *
 * Scope. On Postgres `db()` answers only from a snapshot someone primed. The
 * worker has no request and no session, so every call runs in `workerStoreScope`
 * — an UNFILTERED process snapshot (the same thing `inCronScope` does, without
 * importing the route layer) that is flushed before the call returns, and retried
 * a few times on an optimistic-concurrency conflict (HTTP 409). Because that
 * snapshot spans every workspace, every function below checks that the record it
 * touches belongs to the workspace and environment the caller named; a mismatch
 * is indistinguishable from "not found". On the file store the scope is a
 * pass-through. Tests inject their own `scope`.
 *
 * Projection rules, all idempotent:
 *   - a step write that changes nothing appends nothing;
 *   - a finished deployment ignores late writes (a superseded or stale runner
 *     cannot reopen it);
 *   - the terminal write (`commitOutcome`) releases the environment's
 *     `activeDeploymentId` if this deployment holds it, and only `succeeded`
 *     commits `deployedRevisionId` / `revision.deployedTo` — and only if this
 *     deployment is still the environment's writer (compare-and-swap, as the
 *     engine does); a deployment that was superseded becomes `cancelled`;
 *   - `uncertain` has no product status: it is shown as `failed` with an error
 *     that says the outcome is unknown, never as success and never as a clean
 *     failure.
 */
import type { Deployment, DeploymentEvent, DeploymentStatus, DeploymentStep, Output, StepStatus } from "@/lib/domain/types";
import { isPostgres, appendEvent, flushPendingAsync, q, readEvents, revisionManifestAsync, save, db } from "@/lib/db/store";
import type { StepName } from "@/lib/workflows/types";
import type { DeploymentOutcome, ProductContext, ProductPort, ProductRevision } from "./ports";
import { safeText } from "./text";

export class ProductNotFoundError extends Error {
  constructor(
    readonly code: "environment_not_found" | "connection_not_found" | "revision_not_found" | "deployment_not_found",
    message: string
  ) {
    super(message);
    this.name = "ProductNotFoundError";
  }
}

export type StoreScope = <T>(body: () => Promise<T>) => Promise<T>;

const MAX_CONFLICT_RETRIES = 3;

/** The default scope for the worker; see the module comment. */
export const workerStoreScope: StoreScope = async (body) => {
  for (let attempt = 1; ; attempt++) {
    try {
      if (!isPostgres()) {
        const out = await body();
        await flushPendingAsync();
        return out;
      }
      const { primeProcessSnapshot } = await import("@/lib/db/postgres-store");
      const { runWithSnapshot } = await import("@/lib/db/request-snapshot");
      const snapshot = await primeProcessSnapshot(null);
      return await runWithSnapshot(snapshot, async () => {
        const out = await body();
        await flushPendingAsync();
        return out;
      });
    } catch (err) {
      const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
      if (status === 409 && attempt < MAX_CONFLICT_RETRIES) continue;
      throw err;
    }
  }
};

/* ------------------------------ step metadata ----------------------------- */

const STEPS: Record<StepName, { phase: DeploymentStep["phase"]; title: string }> = {
  validate: { phase: "prepare", title: "Validate desired state" },
  lease: { phase: "prepare", title: "Take the environment lease" },
  credentials: { phase: "prepare", title: "Broker credentials" },
  plan: { phase: "prepare", title: "Plan infrastructure" },
  policy: { phase: "prepare", title: "Evaluate policy" },
  approval: { phase: "prepare", title: "Wait for approval" },
  final_plan: { phase: "prepare", title: "Confirm the plan is unchanged" },
  apply_network: { phase: "provision", title: "Apply network" },
  apply_data: { phase: "provision", title: "Apply data stores" },
  apply_infrastructure: { phase: "provision", title: "Apply infrastructure" },
  build: { phase: "release", title: "Build artifacts" },
  publish: { phase: "release", title: "Publish artifacts" },
  deploy: { phase: "release", title: "Deploy workloads" },
  secrets: { phase: "release", title: "Sync secrets" },
  ingress: { phase: "release", title: "Configure ingress" },
  dns_tls: { phase: "release", title: "Configure DNS and TLS" },
  migrate: { phase: "release", title: "Run migrations" },
  execute_capability: { phase: "release", title: "Run the operation" },
  verify_infrastructure: { phase: "verify", title: "Verify infrastructure" },
  verify_application: { phase: "verify", title: "Verify the application" },
  observe: { phase: "verify", title: "Observe the environment" },
  finalize: { phase: "verify", title: "Finalize" },
  release: { phase: "verify", title: "Release the lease" },
};
const ORDER = Object.keys(STEPS) as StepName[];

const TERMINAL: readonly DeploymentStatus[] = ["succeeded", "failed", "cancelled", "rolled_back"];
const isTerminal = (status: DeploymentStatus): boolean => TERMINAL.includes(status);

/* --------------------------------- helpers -------------------------------- */

function nextSeq(deploymentId: string): number | Promise<number> {
  if (isPostgres()) return import("@/lib/db/pg/history").then((m) => m.nextEventSeq(deploymentId));
  return readEvents(deploymentId).reduce((max, e) => Math.max(max, e.seq + 1), 0);
}

async function emit(deploymentId: string, at: string, body: Record<string, unknown> & { type: DeploymentEvent["type"] }): Promise<void> {
  appendEvent({ ts: at, deploymentId, seq: await nextSeq(deploymentId), ...body } as DeploymentEvent);
}

/** The deployment, only if it belongs to this workspace AND environment. */
function ownedDeployment(workspaceId: string, environmentId: string, deploymentId: string): Deployment {
  const d = q.deployment(deploymentId);
  const env = d ? q.environment(d.environmentId) : undefined;
  const project = env ? q.project(env.projectId) : undefined;
  if (!d || d.environmentId !== environmentId || !project || project.workspaceId !== workspaceId) {
    throw new ProductNotFoundError("deployment_not_found", "The deployment was not found in this environment.");
  }
  return d;
}

function setDeploymentStatus(d: Deployment, status: DeploymentStatus, at: string): Promise<void> {
  d.status = status;
  if (isTerminal(status)) d.endedAt = at;
  return emit(d.id, at, { type: "status", status });
}

/** An environment's writer slot: claim it if free. A non-terminal deployment that holds it is "the" deployment of the environment. */
function claimActive(envId: string, d: Deployment): void {
  const env = q.environment(envId);
  if (env && !env.activeDeploymentId) env.activeDeploymentId = d.id;
}

function releaseActive(d: Deployment): void {
  const env = q.environment(d.environmentId);
  if (env?.activeDeploymentId === d.id) delete env.activeDeploymentId;
}

/* ----------------------------------- port ---------------------------------- */

export interface ProductPortOptions {
  scope?: StoreScope;
}

export function createProductPort(options: ProductPortOptions = {}): ProductPort {
  const scope = options.scope ?? workerStoreScope;

  return {
    loadContext: ({ workspaceId, environmentId, revisionId, deploymentId }) =>
      scope(async (): Promise<ProductContext> => {
        const env = q.environment(environmentId);
        const project = env ? q.project(env.projectId) : undefined;
        const workspace = project ? db().workspaces.find((w) => w.id === workspaceId) : undefined;
        if (!env || !project || project.workspaceId !== workspaceId || !workspace) throw new ProductNotFoundError("environment_not_found", "The environment was not found in this workspace.");
        const connection = q.connection(env.connectionId);
        if (!connection || connection.workspaceId !== workspaceId) throw new ProductNotFoundError("connection_not_found", "The environment's connection was not found in this workspace.");

        let revision: ProductRevision | undefined;
        const wanted = revisionId ?? env.deployedRevisionId;
        if (wanted) {
          const row = q.revision(wanted);
          if (!row || row.projectId !== project.id) throw new ProductNotFoundError("revision_not_found", "The revision was not found in this project.");
          const manifest = (await revisionManifestAsync(wanted)) ?? row.manifest;
          revision = { id: row.id, number: row.number, manifest };
        }
        if (deploymentId) ownedDeployment(workspaceId, environmentId, deploymentId);
        return {
          workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
          project: { id: project.id, name: project.name, slug: project.slug },
          environment: {
            id: env.id,
            name: env.name,
            class: env.class,
            provider: connection.provider,
            region: env.region,
            baseDomain: env.baseDomain,
            connectionId: env.connectionId,
            policies: env.policies,
            ...(env.deployedRevisionId ? { deployedRevisionId: env.deployedRevisionId } : {}),
            ...(env.activeDeploymentId ? { activeDeploymentId: env.activeDeploymentId } : {}),
          },
          ...(revision ? { revision } : {}),
          ...(deploymentId ? { deploymentId } : {}),
        };
      }),

    loadRevision: ({ workspaceId, environmentId, revisionId }) =>
      scope(async () => {
        const env = q.environment(environmentId);
        const project = env ? q.project(env.projectId) : undefined;
        if (!env || !project || project.workspaceId !== workspaceId) return null;
        const row = q.revision(revisionId);
        if (!row || row.projectId !== project.id) return null;
        return { id: row.id, number: row.number, manifest: (await revisionManifestAsync(revisionId)) ?? row.manifest };
      }),

    resolveEnvironment: (environmentId) =>
      scope(async () => {
        const env = q.environment(environmentId);
        const project = env ? q.project(env.projectId) : undefined;
        return env && project ? { workspaceId: project.workspaceId, projectId: project.id } : null;
      }),

    recordStep: ({ workspaceId, environmentId, deploymentId, step, status, detail, at, deploymentStatus }) =>
      scope(async () => {
        const d = ownedDeployment(workspaceId, environmentId, deploymentId);
        // A finished deployment is not reopened by a late write. The two closing steps are the exception: the
        // workflow records `finalize` and `release` AFTER the terminal status, and they never touch the status.
        const closing = step === "finalize" || step === "release";
        if (isTerminal(d.status) && !closing) return;
        const meta = STEPS[step];
        const id = `step-${step}`;
        let row = d.steps.find((s) => s.id === id);
        const text = detail === undefined ? undefined : safeText(detail, 500);
        const changed = !row || row.status !== status || (text !== undefined && row.detail !== text);
        if (!row) {
          row = { id, seq: ORDER.indexOf(step), phase: meta.phase, title: meta.title, targetId: "", status: "pending" } satisfies DeploymentStep;
          d.steps.push(row);
          d.steps.sort((a, b) => a.seq - b.seq);
        }
        if (changed) {
          const previous: StepStatus = row.status;
          row.status = status;
          if (status === "running" && previous !== "running") {
            row.startedAt = at;
            delete row.endedAt;
            delete row.error;
          }
          if (status === "done" || status === "failed" || status === "skipped") row.endedAt = at;
          if (text !== undefined) row.detail = text;
          if (status === "failed" && text !== undefined) row.error = text;
          if (!d.startedAt && status === "running") d.startedAt = at;
          await emit(d.id, at, { type: "step", stepId: id, status, ...(status === "failed" && text ? { error: text } : {}) });
          if (text) await emit(d.id, at, { type: "log", stepId: id, line: text, stream: "info" });
        }
        if (deploymentStatus && d.status !== deploymentStatus && !isTerminal(d.status)) {
          await setDeploymentStatus(d, deploymentStatus, at);
          claimActive(d.environmentId, d);
        }
        if (changed || deploymentStatus) save(d.projectId);
      }),

    setDeploymentStatus: ({ workspaceId, environmentId, deploymentId, status, at }) =>
      scope(async () => {
        const d = ownedDeployment(workspaceId, environmentId, deploymentId);
        if (isTerminal(d.status) || isTerminal(status) || d.status === status) return;
        await setDeploymentStatus(d, status, at);
        claimActive(d.environmentId, d);
        save(d.projectId);
      }),

    recordOutputs: ({ workspaceId, environmentId, deploymentId, outputs }) =>
      scope(async () => {
        const d = ownedDeployment(workspaceId, environmentId, deploymentId);
        for (const output of outputs as Output[]) {
          const existing = d.outputs.find((o) => o.key === output.key);
          if (existing && existing.value === output.value) continue;
          if (existing) Object.assign(existing, output);
          else d.outputs.push({ ...output });
          await emit(d.id, new Date().toISOString(), { type: "output", output });
        }
        save(d.projectId);
      }),

    commitOutcome: ({ workspaceId, environmentId, deploymentId, outcome, error, at }) =>
      scope(async () => {
        const d = ownedDeployment(workspaceId, environmentId, deploymentId);
        if (isTerminal(d.status)) return;
        const env = q.environment(d.environmentId);
        const message = error ? safeText(error, 1000) : undefined;

        let status: DeploymentStatus;
        let finalError = message;
        if (outcome === "succeeded") {
          if (env?.activeDeploymentId && env.activeDeploymentId !== d.id) {
            // Superseded while finishing: the environment belongs to another deployment now. Do not publish this revision.
            status = "cancelled";
            finalError = `Superseded: environment writer ${env.activeDeploymentId} took over before this deployment could commit, so its revision was not published.`;
          } else {
            status = "succeeded";
            if (env) {
              env.deployedRevisionId = d.revisionId;
              const revision = q.revision(d.revisionId);
              if (revision && !revision.deployedTo?.includes(env.id)) revision.deployedTo = [...(revision.deployedTo ?? []), env.id];
            }
          }
        } else if (outcome === "cancelled") status = "cancelled";
        else {
          status = "failed";
          if (outcome === "uncertain") finalError = `The outcome of this deployment is uncertain: Zenith cannot prove whether every change was applied, so the environment may be partly changed. It will be observed and reconciled; nothing was retried or rolled back.${message ? ` (${message})` : ""}`;
          else if (outcome === "expired") finalError = message ?? "No approval was recorded in time; nothing was changed.";
        }
        // Whatever never ran is skipped, as the engine does on a failed step.
        if (status !== "succeeded") {
          for (const s of d.steps) {
            if (s.status === "pending" || s.status === "running") {
              s.status = s.status === "running" ? "failed" : "skipped";
              s.endedAt = at;
              await emit(d.id, at, { type: "step", stepId: s.id, status: s.status });
            }
          }
        }
        if (finalError) d.error = finalError;
        await setDeploymentStatus(d, status, at);
        releaseActive(d);
        save(d.projectId);
      }),
  };
}

export type { DeploymentOutcome };
