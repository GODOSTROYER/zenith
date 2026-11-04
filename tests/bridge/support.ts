/** Product fixtures only; cloud/workflow transports are supplied explicitly by each test. */
import { db, resetDb } from "@/lib/db/store";
import { emptyManifest, type Deployment, type Manifest } from "@/lib/domain/types";
import type { ActionContext } from "@/lib/actions/core";
import { plannedWorkflowSteps } from "@/lib/bridge/steps";
import type { ExecutionReadiness } from "@/lib/bridge/readiness";

export const ctx: ActionContext = { workspaceId: "bridge-ws", projectId: "bridge-project", environmentId: "bridge-env", actor: { type: "user", id: "admin-a", name: "Admin A" } };
export const ready: ExecutionReadiness = { provider: "aws", ready: true, checks: [], checkedAt: new Date().toISOString() };
export function manifest(): Manifest {
  return { ...emptyManifest(), services: [{ id: "web", name: "web", kind: "web", source: { type: "image", image: "example/web:1" }, size: "small", replicas: 1, port: 3000, ownership: "managed", env: [] }] };
}
export function seed(provider: "sandbox" | "aws" = "aws") {
  const createdAt = new Date().toISOString();
  resetDb({
    workspaces: [{ id: ctx.workspaceId, name: "Bridge", slug: "bridge", createdAt }],
    members: (["admin-a", "admin-b", "editor", "viewer"] as const).map((id) => ({ id, workspaceId: ctx.workspaceId, name: id, email: `${id}@example.com`, role: id.startsWith("admin") ? "admin" : id as "editor" | "viewer" })),
    connections: [{ id: "bridge-connection", workspaceId: ctx.workspaceId, provider, label: provider, region: "us-east-1", status: "healthy", grantedPermissions: [], platformConnectionId: provider === "aws" ? "bridge-connection" : undefined, createdAt }],
    projects: [{ id: ctx.projectId!, workspaceId: ctx.workspaceId, name: "Bridge", slug: "bridge", origin: { type: "blank" }, workingManifest: manifest(), createdAt }],
    environments: [{ id: ctx.environmentId!, projectId: ctx.projectId!, name: "staging", class: "staging", connectionId: "bridge-connection", region: "us-east-1", baseDomain: "bridge.example.com", policies: { approvalRequired: false, allowStatefulDeletion: false }, createdAt }],
    revisions: [{ id: "bridge-r1", projectId: ctx.projectId!, number: 1, message: "initial", author: ctx.actor, manifest: manifest(), createdAt }],
  });
}
export function workflowDeployment(status: Deployment["status"] = "applying"): Deployment {
  const d: Deployment = { id: "bridge-workflow", projectId: ctx.projectId!, environmentId: ctx.environmentId!, revisionId: "bridge-r1", executor: "workflow", operationId: "test-operation", status, steps: plannedWorkflowSteps(), outputs: [], actor: ctx.actor, changeSummary: "test workflow", estCostDeltaUsd: 0, createdAt: new Date().toISOString() };
  db().deployments.push(d);
  return d;
}
