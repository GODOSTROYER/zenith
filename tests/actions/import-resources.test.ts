/**
 * project.importResources — adopting what already exists.
 *
 * The guarantee this suite exists to hold is one line of the action: everything
 * it writes is `referenced`. A bug that let a discovered resource in as
 * `managed` would put a bucket nobody created into the next deploy plan, and
 * into the delete path of the one after that.
 *
 * The second guarantee is that the submitted list is a selection, not data: an
 * external reference the provider does not actually list must not reach the
 * manifest just because someone posted it.
 */
import { describe, expect, it, beforeAll } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import type { Manifest } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-import-res-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db, q, resetDb, save } = await import("@/lib/db/store");
const { sandboxProvider } = await import("@/lib/providers/sandbox");
await import("@/lib/actions/defs");

const ctx: ActionContext = {
  workspaceId: "ws-test",
  actor: { type: "user", id: "you", name: "you" },
};

let projectId = "";
let connectionId = "";
let refs: string[] = [];

const exec = async (actionId: string, input: unknown, scope: Partial<ActionContext> = {}) =>
  (await runAction(actionId, { ...ctx, ...scope }, input, { mode: "execute" })).result!;

const plan = async (actionId: string, input: unknown, scope: Partial<ActionContext> = {}) =>
  (await runAction(actionId, { ...ctx, ...scope }, input, { mode: "plan" })).plan!;

const working = (): Manifest => q.project(projectId)!.workingManifest;
const referenced = () => working().resources.filter((r) => r.ownership === "referenced");

beforeAll(async () => {
  resetDb({
    workspaces: [{ id: "ws-test", name: "Test", slug: "test", createdAt: new Date().toISOString() }],
  });
  const created = await exec("project.applyBlueprint", { blueprint: "internal-tool", name: "Atlas" });
  const data = created.data as { projectId: string; environmentId: string };
  projectId = data.projectId;
  connectionId = q.environment(data.environmentId)!.connectionId;

  // What the dialog would have been offered.
  const found = await sandboxProvider.discover!(q.connection(connectionId)!);
  refs = found.resources.map((r) => r.externalRef);
  expect(refs.length).toBeGreaterThan(1);
});

describe("project.importResources", () => {
  it("plans without touching the working copy", async () => {
    const before = JSON.stringify(working());
    const p = await plan(
      "project.importResources",
      { connectionId, resources: [{ externalRef: refs[0] }] },
      { projectId }
    );
    expect(p.blocked).toBeUndefined();
    expect(p.summary).toMatch(/Reference 1 existing resource/);
    expect(JSON.stringify(working())).toBe(before);
  });

  it("says out loud that a simulated list is simulated", async () => {
    const p = await plan(
      "project.importResources",
      { connectionId, resources: [{ externalRef: refs[0] }] },
      { projectId }
    );
    expect(p.warnings.join(" ")).toMatch(/invented this list/);
  });

  it("costs nothing — a referenced resource is not Zenith's bill", async () => {
    const p = await plan(
      "project.importResources",
      { connectionId, resources: refs.map((externalRef) => ({ externalRef })) },
      { projectId }
    );
    expect(p.costDeltaUsd).toBe(0);
  });

  it("adds them as referenced, never managed, and keeps the external reference", async () => {
    const managedBefore = working().resources.filter((r) => r.ownership === "managed").length;
    const result = await exec(
      "project.importResources",
      { connectionId, resources: [{ externalRef: refs[0] }, { externalRef: refs[1] }] },
      { projectId }
    );
    expect(result.ok).toBe(true);

    const added = referenced();
    expect(added).toHaveLength(2);
    expect(added.every((r) => r.ownership === "referenced")).toBe(true);
    expect(added.map((r) => r.externalRef).sort()).toEqual([refs[0], refs[1]].sort());
    // Nothing became managed, and nothing already there changed hands.
    expect(working().resources.filter((r) => r.ownership === "managed")).toHaveLength(
      managedBefore
    );
  });

  it("skips one it already references rather than adding it twice", async () => {
    const before = referenced().length;
    const result = await exec(
      "project.importResources",
      { connectionId, resources: [{ externalRef: refs[0] }, { externalRef: refs[2] }] },
      { projectId }
    );
    expect(result.ok).toBe(true);
    expect(referenced()).toHaveLength(before + 1);
    expect((result.data as { skipped: string[] }).skipped.join(" ")).toMatch(/already references/);
  });

  it("refuses a reference the provider does not actually list", async () => {
    const before = referenced().length;
    const p = await plan(
      "project.importResources",
      { connectionId, resources: [{ externalRef: "s3://not-from-this-provider" }] },
      { projectId }
    );
    expect(p.blocked).toBeTruthy();

    const result = await exec(
      "project.importResources",
      { connectionId, resources: [{ externalRef: "s3://not-from-this-provider" }] },
      { projectId }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not list it any more/);
    expect(referenced()).toHaveLength(before);
  });

  it("refuses a provider that reads no account, and names the alternative", async () => {
    db().connections.push({
      id: "conn-aws",
      workspaceId: "ws-test",
      provider: "aws",
      label: "Production AWS",
      region: "us-east-1",
      status: "healthy",
      grantedPermissions: [],
      createdAt: new Date().toISOString(),
    });
    save();

    const result = await exec(
      "project.importResources",
      { connectionId: "conn-aws", resources: [{ externalRef: "s3://anything" }] },
      { projectId }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not read your AWS account/);
    expect(result.error).toMatch(/terraform plan/);
  });

  it("refuses a connection from another workspace", async () => {
    db().connections.push({
      id: "conn-elsewhere",
      workspaceId: "ws-other",
      provider: "sandbox",
      label: "Someone else's",
      region: "sim-a",
      status: "healthy",
      grantedPermissions: [],
      createdAt: new Date().toISOString(),
    });
    save();

    const before = referenced().length;
    const result = await exec(
      "project.importResources",
      { connectionId: "conn-elsewhere", resources: [{ externalRef: "sim://x" }] },
      { projectId }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this workspace/);
    expect(referenced()).toHaveLength(before);
  });
});
