import { beforeAll, describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-honesty-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db, q, resetDb } = await import("@/lib/db/store");
const { ensureEngine } = await import("@/lib/engine/engine");
await import("@/lib/actions/defs");

const WS = "ws-honesty";
const ctx: ActionContext = { workspaceId: WS, actor: { type: "user", id: "t", name: "Tester" } };

const exec = async (actionId: string, input: unknown, scope: Partial<ActionContext> = {}) =>
  (await runAction(actionId, { ...ctx, ...scope }, input, { mode: "execute" })).result!;

const plan = async (actionId: string, input: unknown, scope: Partial<ActionContext> = {}) =>
  (await runAction(actionId, { ...ctx, ...scope }, input, { mode: "plan" })).plan!;

let projectId = "";
const envs: Record<string, string> = {};

beforeAll(async () => {
  ensureEngine(); // registers the provider adapters
  resetDb({
    workspaces: [{ id: WS, name: "Honesty", slug: "honesty", createdAt: new Date().toISOString() }],
  });
  for (const provider of ["sandbox", "aws", "kubernetes"] as const) {
    db().connections.push({
      id: `conn-${provider}`,
      workspaceId: WS,
      provider,
      label: provider,
      region: "local-1",
      status: "healthy",
      grantedPermissions: [],
      createdAt: new Date().toISOString(),
    });
  }
  const created = await exec("project.applyBlueprint", { blueprint: "internal-tool", name: "Atlas" });
  projectId = (created.data as { projectId: string }).projectId;

  for (const provider of ["aws", "kubernetes"] as const) {
    const env = await exec(
      "env.create",
      { name: provider, class: "staging", connectionId: `conn-${provider}`, region: "local-1" },
      { projectId }
    );
    envs[provider] = (env.data as { environmentId: string }).environmentId;
  }
});

describe("providers refuse before anything is written", () => {
  it("AWS (Preview): apply is refused at plan time, naming what it can do instead", async () => {
    const environmentId = envs.aws;
    const revisionsBefore = db().revisions.length;

    // The refusal is a first-class field, not prose buried in `warnings`:
    // a surface disables its confirm control on `blocked` alone.
    const preview = await plan("deploy.apply", {}, { projectId, environmentId });
    expect(preview.blocked).toMatch(/Preview provider/);
    expect(preview.blocked).toMatch(/Terraform/);
    // and warnings stay advisory — nothing in there stops the deploy
    expect(preview.warnings.some((w) => /Blocks the deploy/.test(w))).toBe(false);

    const result = await exec("deploy.apply", {}, { projectId, environmentId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Preview provider/);
    expect(result.error).toMatch(/never applies/);
    expect(result.error).toMatch(/Terraform|Sandbox/);

    // The refusal happens before a revision is snapshotted or a deployment exists.
    expect(db().revisions).toHaveLength(revisionsBefore);
    expect(q.deploymentsOf(environmentId)).toHaveLength(0);
  });

  it("Kubernetes (Planned): apply is refused without an exception escaping the engine", async () => {
    const environmentId = envs.kubernetes;
    const result = await exec("deploy.apply", {}, { projectId, environmentId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Planned provider/);
    expect(result.error).toMatch(/Sandbox/);
    expect(q.deploymentsOf(environmentId)).toHaveLength(0);
  });

  it("says so in the plan summary rather than promising a deploy", async () => {
    const preview = await plan("deploy.plan", {}, { projectId, environmentId: envs.kubernetes });
    expect(preview.summary).toMatch(/cannot be deployed/);
    expect(preview.details[0]).toMatch(/Planned provider/);
  });

  it("refuses rollback on the same providers", async () => {
    const result = await exec("deploy.rollback", {}, { projectId, environmentId: envs.aws });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Preview provider/);
  });
});
