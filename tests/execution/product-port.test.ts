/**
 * The product-store port, for real, over the file store: the Deployment
 * projection the UI follows and the context an operation reads.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Deployment, Manifest } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-act-product-", { fast: true });
const { db, q, readEvents, resetDb, save } = await import("@/lib/db/store");
const { createProductPort, ProductNotFoundError, workerStoreScope } = await import("@/lib/execution/product-port");

const WS = "ws-p";
const OTHER_WS = "ws-q";
const PROJECT = "proj-p";
const ENVIRONMENT = "env-p";
const OTHER_ENV = "env-other";
const REV1 = "rev-1";
const REV2 = "rev-2";
const DEP = "dep-p-1";
const at = "2026-09-30T12:00:00.000Z";

const manifest = (name: string): Manifest => ({
  version: 1,
  services: [{ id: "s1", name, kind: "web" as const, source: { type: "image" as const, image: "x:1" }, size: "small" as const, replicas: 1, env: [], ownership: "managed" as const }],
  resources: [],
  routes: [],
  bindings: [],
});
const author = { type: "user" as const, id: "u1", name: "You" };

const deployment = (over: Partial<Deployment> = {}): Deployment => ({
  id: DEP,
  projectId: PROJECT,
  environmentId: ENVIRONMENT,
  revisionId: REV2,
  status: "planning",
  steps: [],
  outputs: [],
  changeSummary: "deploy",
  estCostDeltaUsd: 0,
  actor: author,
  createdAt: at,
  ...over,
});

function seed(over: { deployments?: Deployment[]; deployedRevisionId?: string; activeDeploymentId?: string } = {}) {
  resetDb({
    workspaces: [
      { id: WS, name: "Atlas", slug: "atlas", createdAt: at },
      { id: OTHER_WS, name: "Other", slug: "other", createdAt: at },
    ],
    connections: [
      { id: "conn-p", workspaceId: WS, provider: "aws", label: "AWS", region: "us-east-1", status: "healthy", grantedPermissions: [], createdAt: at },
      { id: "conn-q", workspaceId: OTHER_WS, provider: "aws", label: "AWS", region: "us-east-1", status: "healthy", grantedPermissions: [], createdAt: at },
    ],
    projects: [
      { id: PROJECT, workspaceId: WS, name: "Atlas", slug: "atlas", workingManifest: manifest("web"), createdAt: at, origin: { type: "blank" } },
      { id: "proj-q", workspaceId: OTHER_WS, name: "Other", slug: "other", workingManifest: manifest("web"), createdAt: at, origin: { type: "blank" } },
    ],
    environments: [
      {
        id: ENVIRONMENT,
        projectId: PROJECT,
        name: "production",
        class: "production",
        connectionId: "conn-p",
        region: "us-east-1",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "atlas.zenith.test",
        createdAt: at,
        ...(over.deployedRevisionId ? { deployedRevisionId: over.deployedRevisionId } : {}),
        ...(over.activeDeploymentId ? { activeDeploymentId: over.activeDeploymentId } : {}),
      },
      {
        id: OTHER_ENV,
        projectId: "proj-q",
        name: "production",
        class: "production",
        connectionId: "conn-q",
        region: "us-east-1",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "other.zenith.test",
        createdAt: at,
      },
    ],
    revisions: [
      { id: REV1, projectId: PROJECT, number: 1, manifest: manifest("web"), message: "one", author, createdAt: at },
      { id: REV2, projectId: PROJECT, number: 2, manifest: manifest("api"), message: "two", author, createdAt: at },
      { id: "rev-q", projectId: "proj-q", number: 1, manifest: manifest("web"), message: "q", author, createdAt: at },
    ],
    deployments: over.deployments ?? [deployment()],
  });
  save();
}

const port = createProductPort(); // the default worker scope: a pass-through on the file store, flushed after each call
const base = { workspaceId: WS, environmentId: ENVIRONMENT, deploymentId: DEP, at };
const deploymentNow = (): Deployment => q.deployment(DEP)!;

beforeEach(() => seed());

describe("loadContext", () => {
  it("returns workspace, project, environment (provider from the connection), the requested revision's manifest and the deployment", async () => {
    const ctx = await port.loadContext({ workspaceId: WS, environmentId: ENVIRONMENT, revisionId: REV2, deploymentId: DEP });
    expect(ctx).toMatchObject({
      workspace: { id: WS, slug: "atlas" },
      project: { id: PROJECT },
      environment: { id: ENVIRONMENT, name: "production", class: "production", provider: "aws", region: "us-east-1", baseDomain: "atlas.zenith.test", connectionId: "conn-p", policies: { approvalRequired: false } },
      revision: { id: REV2, number: 2 },
      deploymentId: DEP,
    });
    expect((ctx.revision!.manifest as { services: { name: string }[] }).services[0].name).toBe("api");
  });

  it("falls back to the deployed revision when none is named, and has no revision when nothing is deployed", async () => {
    seed({ deployedRevisionId: REV1 });
    expect((await port.loadContext({ workspaceId: WS, environmentId: ENVIRONMENT })).revision?.id).toBe(REV1);
    seed();
    expect((await port.loadContext({ workspaceId: WS, environmentId: ENVIRONMENT })).revision).toBeUndefined();
  });

  it("reports the environment's writer slot", async () => {
    seed({ activeDeploymentId: "dep-someone" });
    expect((await port.loadContext({ workspaceId: WS, environmentId: ENVIRONMENT })).environment.activeDeploymentId).toBe("dep-someone");
  });

  it("is indistinguishable from 'not found' across tenants: another workspace's environment, revision or deployment", async () => {
    await expect(port.loadContext({ workspaceId: OTHER_WS, environmentId: ENVIRONMENT })).rejects.toMatchObject({ code: "environment_not_found" });
    await expect(port.loadContext({ workspaceId: WS, environmentId: OTHER_ENV })).rejects.toMatchObject({ code: "environment_not_found" });
    await expect(port.loadContext({ workspaceId: WS, environmentId: ENVIRONMENT, revisionId: "rev-q" })).rejects.toMatchObject({ code: "revision_not_found" });
    await expect(port.loadContext({ workspaceId: WS, environmentId: "nope" })).rejects.toBeInstanceOf(ProductNotFoundError);
    seed({ deployments: [deployment({ id: "dep-foreign", environmentId: OTHER_ENV, projectId: "proj-q" })] });
    await expect(port.loadContext({ workspaceId: WS, environmentId: ENVIRONMENT, deploymentId: "dep-foreign" })).rejects.toMatchObject({ code: "deployment_not_found" });
  });

  it("fails when the environment's connection is missing or belongs to another workspace", async () => {
    db().connections = db().connections.filter((c) => c.id !== "conn-p");
    await expect(port.loadContext({ workspaceId: WS, environmentId: ENVIRONMENT })).rejects.toMatchObject({ code: "connection_not_found" });
  });

  it("resolves an environment to its workspace and project, for passes that have no operation", async () => {
    expect(await port.resolveEnvironment(ENVIRONMENT)).toEqual({ workspaceId: WS, projectId: PROJECT });
    expect(await port.resolveEnvironment("nope")).toBeNull();
    expect((await port.loadRevision({ workspaceId: WS, environmentId: ENVIRONMENT, revisionId: REV1 }))?.number).toBe(1);
    expect(await port.loadRevision({ workspaceId: WS, environmentId: ENVIRONMENT, revisionId: "rev-q" })).toBeNull();
    expect(await port.loadRevision({ workspaceId: OTHER_WS, environmentId: ENVIRONMENT, revisionId: REV1 })).toBeNull();
  });
});

describe("recordStep", () => {
  it("creates the step, moves its status, appends step and log events, and sets the deployment status", async () => {
    await port.recordStep({ ...base, step: "plan", status: "running", deploymentStatus: "planning" });
    await port.recordStep({ ...base, step: "plan", status: "done", detail: "2 create · 0 update" });
    const d = deploymentNow();
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0]).toMatchObject({ id: "step-plan", phase: "prepare", title: "Plan infrastructure", status: "done", detail: "2 create · 0 update", startedAt: at, endedAt: at });
    expect(d.startedAt).toBe(at);
    expect(readEvents(DEP).map((e) => (e.type === "step" ? `step:${e.status}` : e.type === "log" ? "log" : e.type))).toEqual(["step:running", "step:done", "log"]);
  });

  it("is idempotent: replaying the same write changes nothing and appends nothing", async () => {
    await port.recordStep({ ...base, step: "plan", status: "running", detail: "planning" });
    const before = readEvents(DEP).length;
    const snapshot = JSON.stringify(deploymentNow());
    await port.recordStep({ ...base, step: "plan", status: "running", detail: "planning" });
    await port.recordStep({ ...base, step: "plan", status: "running" });
    expect(readEvents(DEP)).toHaveLength(before);
    expect(JSON.stringify(deploymentNow())).toBe(snapshot);
  });

  it("keeps steps in journey order and event sequence numbers dense and unique", async () => {
    await port.recordStep({ ...base, step: "apply_infrastructure", status: "running", deploymentStatus: "applying" });
    await port.recordStep({ ...base, step: "validate", status: "done" });
    await port.recordStep({ ...base, step: "verify_application", status: "running", deploymentStatus: "verifying" });
    expect(deploymentNow().steps.map((s) => s.id)).toEqual(["step-validate", "step-apply_infrastructure", "step-verify_application"]);
    expect(deploymentNow().status).toBe("verifying");
    const seqs = readEvents(DEP).map((e) => e.seq);
    expect(seqs).toEqual([...seqs.keys()]);
  });

  it("records a failed step's error and clears it when the step runs again", async () => {
    await port.recordStep({ ...base, step: "lease", status: "running" });
    await port.recordStep({ ...base, step: "lease", status: "failed", detail: "another operation holds the lease" });
    expect(deploymentNow().steps[0]).toMatchObject({ status: "failed", error: "another operation holds the lease" });
    await port.recordStep({ ...base, step: "lease", status: "running" });
    expect(deploymentNow().steps[0].error).toBeUndefined();
  });

  it("scrubs credential shapes out of what it stores", async () => {
    await port.recordStep({ ...base, step: "plan", status: "done", detail: "token=sk-live-ABCDEF1234567890 ok" });
    expect(JSON.stringify(deploymentNow())).not.toContain("ABCDEF1234567890");
  });

  it("ignores a late write to a finished deployment — except the two closing steps, which the workflow records after the terminal status", async () => {
    await port.recordStep({ ...base, step: "finalize", status: "running", deploymentStatus: "verifying" });
    await port.commitOutcome({ ...base, outcome: "succeeded" });
    expect(deploymentNow().status).toBe("succeeded");
    await port.recordStep({ ...base, step: "apply_infrastructure", status: "running", deploymentStatus: "applying" }); // a stale runner
    expect(deploymentNow().steps.map((s) => s.id)).toEqual(["step-finalize"]);
    expect(deploymentNow().status).toBe("succeeded");
    await port.recordStep({ ...base, step: "finalize", status: "done" });
    await port.recordStep({ ...base, step: "release", status: "done", deploymentStatus: "applying" });
    expect(deploymentNow().steps.map((s) => `${s.id}:${s.status}`)).toEqual(["step-finalize:done", "step-release:done"]);
    expect(deploymentNow().status).toBe("succeeded"); // never reopened
  });

  it("refuses a deployment of another workspace or environment and writes nothing", async () => {
    seed({ deployments: [deployment(), deployment({ id: "dep-foreign", environmentId: OTHER_ENV, projectId: "proj-q" })] });
    await expect(port.recordStep({ ...base, workspaceId: OTHER_WS, step: "plan", status: "running" })).rejects.toMatchObject({ code: "deployment_not_found" });
    await expect(port.recordStep({ ...base, deploymentId: "dep-foreign", step: "plan", status: "running" })).rejects.toMatchObject({ code: "deployment_not_found" });
    expect(q.deployment("dep-foreign")!.steps).toEqual([]);
    expect(deploymentNow().steps).toEqual([]);
  });
});

describe("setDeploymentStatus and the environment's writer slot", () => {
  it("moves a non-terminal status once, claims the free writer slot, and never overrides another writer", async () => {
    await port.setDeploymentStatus({ ...base, status: "awaiting_approval" });
    await port.setDeploymentStatus({ ...base, status: "awaiting_approval" });
    expect(readEvents(DEP).filter((e) => e.type === "status")).toHaveLength(1);
    expect(q.environment(ENVIRONMENT)!.activeDeploymentId).toBe(DEP);

    seed({ activeDeploymentId: "dep-someone" });
    await port.setDeploymentStatus({ ...base, status: "planning" });
    expect(q.environment(ENVIRONMENT)!.activeDeploymentId).toBe("dep-someone");
  });

  it("ignores status writes once terminal, and ignores an attempt to set a terminal status through it", async () => {
    await port.setDeploymentStatus({ ...base, status: "succeeded" }); // not a way to finish a deployment
    expect(deploymentNow().status).toBe("planning");
    await port.commitOutcome({ ...base, outcome: "failed", error: "boom" });
    await port.setDeploymentStatus({ ...base, status: "applying" });
    expect(deploymentNow().status).toBe("failed");
  });
});

describe("recordOutputs", () => {
  it("upserts outputs by key and announces only new or changed ones", async () => {
    const out = { key: "url:app", label: "app", value: "https://app.example.test/", kind: "url" as const, simulated: false };
    await port.recordOutputs({ ...base, outputs: [out] });
    await port.recordOutputs({ ...base, outputs: [out] });
    await port.recordOutputs({ ...base, outputs: [{ ...out, value: "https://app2.example.test/" }] });
    expect(deploymentNow().outputs).toEqual([{ ...out, value: "https://app2.example.test/" }]);
    expect(readEvents(DEP).filter((e) => e.type === "output")).toHaveLength(2);
  });
});

describe("commitOutcome", () => {
  it("on success commits the deployed revision, records where it ran, and releases the writer slot", async () => {
    await port.setDeploymentStatus({ ...base, status: "applying" });
    await port.recordStep({ ...base, step: "apply_infrastructure", status: "done" });
    await port.commitOutcome({ ...base, outcome: "succeeded" });
    expect(deploymentNow()).toMatchObject({ status: "succeeded", endedAt: at });
    expect(q.environment(ENVIRONMENT)).toMatchObject({ deployedRevisionId: REV2 });
    expect(q.environment(ENVIRONMENT)!.activeDeploymentId).toBeUndefined();
    expect(q.revision(REV2)!.deployedTo).toEqual([ENVIRONMENT]);
    await port.commitOutcome({ ...base, outcome: "succeeded" }); // idempotent
    expect(q.revision(REV2)!.deployedTo).toEqual([ENVIRONMENT]);
    expect(readEvents(DEP).filter((e) => e.type === "status" && e.status === "succeeded")).toHaveLength(1);
  });

  it("does NOT publish a revision when another deployment took over the environment meanwhile: it ends cancelled, superseded", async () => {
    seed({ activeDeploymentId: "dep-newer" });
    await port.commitOutcome({ ...base, outcome: "succeeded" });
    expect(deploymentNow().status).toBe("cancelled");
    expect(deploymentNow().error).toMatch(/Superseded/);
    expect(q.environment(ENVIRONMENT)!.deployedRevisionId).toBeUndefined();
    expect(q.environment(ENVIRONMENT)!.activeDeploymentId).toBe("dep-newer"); // not released: it is not ours
    expect(q.revision(REV2)!.deployedTo).toBeUndefined();
  });

  it("ends a failed deployment 'failed' with its error, skips what never ran, fails what was running, and publishes nothing", async () => {
    await port.recordStep({ ...base, step: "plan", status: "done" });
    await port.recordStep({ ...base, step: "apply_infrastructure", status: "running", deploymentStatus: "applying" });
    await port.commitOutcome({ ...base, outcome: "failed", error: "apply failed token=sk-live-ABCDEF1234567890" });
    const d = deploymentNow();
    expect(d.status).toBe("failed");
    expect(d.error).toMatch(/apply failed/);
    expect(d.error).not.toContain("ABCDEF1234567890");
    expect(d.steps.map((s) => `${s.id}:${s.status}`)).toEqual(["step-plan:done", "step-apply_infrastructure:failed"]);
    expect(q.environment(ENVIRONMENT)!.deployedRevisionId).toBeUndefined();
    expect(q.environment(ENVIRONMENT)!.activeDeploymentId).toBeUndefined();
  });

  it("preserves progress and the writer slot for an uncertain outcome without projecting a definitive failure", async () => {
    await port.recordStep({ ...base, step: "plan", status: "done" });
    await port.recordStep({ ...base, step: "apply_infrastructure", status: "running", deploymentStatus: "applying" });
    const steps = structuredClone(deploymentNow().steps);
    await port.commitOutcome({ ...base, outcome: "uncertain", error: "The environment lease was lost during apply_infrastructure." });
    const d = deploymentNow();
    expect(d.status).toBe("applying");
    expect(d.endedAt).toBeUndefined();
    expect(d.steps).toEqual(steps);
    expect(q.environment(ENVIRONMENT)!.activeDeploymentId).toBe(DEP);
    expect(q.environment(ENVIRONMENT)!.deployedRevisionId).toBeUndefined();
    expect(d.error).toMatch(/outcome of this deployment is uncertain/i);
    expect(d.error).toMatch(/Nothing was retried or rolled back/);
    expect(d.error).toMatch(/Inspect the platform operation/);
    expect(d.error).toMatch(/lease was lost/);
    expect(readEvents(DEP).filter((e) => e.type === "status" && e.status === "failed")).toEqual([]);
    const events = readEvents(DEP);
    await port.commitOutcome({ ...base, outcome: "uncertain", error: "The environment lease was lost during apply_infrastructure." });
    expect(readEvents(DEP)).toEqual(events);
  });

  it("uncertainty cannot clear or replace another deployment's writer slot", async () => {
    seed({ activeDeploymentId: "dep-newer" });
    await port.commitOutcome({ ...base, outcome: "uncertain" });
    expect(deploymentNow().status).toBe("planning");
    expect(deploymentNow().endedAt).toBeUndefined();
    expect(q.environment(ENVIRONMENT)!.activeDeploymentId).toBe("dep-newer");
  });

  it("a late uncertain receipt cannot overwrite confirmed terminal success", async () => {
    await port.commitOutcome({ ...base, outcome: "succeeded" });
    const confirmed = structuredClone(deploymentNow());
    const events = readEvents(DEP);
    await port.commitOutcome({ ...base, outcome: "uncertain", error: "lost response" });
    expect(deploymentNow()).toEqual(confirmed);
    expect(readEvents(DEP)).toEqual(events);
    expect(q.environment(ENVIRONMENT)!.deployedRevisionId).toBe(REV2);
  });

  it("confirmed success clears an earlier unconfirmed-start warning", async () => {
    seed({ deployments: [deployment({ error: "Workflow start could not be confirmed. Inspect the platform operation." })] });
    await port.commitOutcome({ ...base, outcome: "succeeded" });
    expect(deploymentNow().status).toBe("succeeded");
    expect(deploymentNow().error).toBeUndefined();
    expect(q.environment(ENVIRONMENT)!.deployedRevisionId).toBe(REV2);
  });

  it("maps cancelled and expired", async () => {
    await port.commitOutcome({ ...base, outcome: "cancelled", error: "Cancelled by request." });
    expect(deploymentNow()).toMatchObject({ status: "cancelled", error: "Cancelled by request." });
    seed();
    await port.commitOutcome({ ...base, outcome: "expired" });
    expect(deploymentNow()).toMatchObject({ status: "failed", error: expect.stringMatching(/No approval was recorded in time/) });
  });

  it("refuses a foreign deployment", async () => {
    await expect(port.commitOutcome({ ...base, workspaceId: OTHER_WS, outcome: "succeeded" })).rejects.toMatchObject({ code: "deployment_not_found" });
    expect(deploymentNow().status).toBe("planning");
  });
});

describe("workerStoreScope", () => {
  it("is a pass-through on the file store and returns the body's value", async () => {
    expect(await workerStoreScope(async () => 42)).toBe(42);
  });
});
