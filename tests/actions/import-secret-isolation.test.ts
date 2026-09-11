import { beforeEach, describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import type { Project } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-import-secret-isolation-");
const { runAction } = await import("@/lib/actions/core");
const { q, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const ctx: ActionContext = {
  workspaceId: "ws-import",
  actor: { type: "user", id: "u1", name: "Importer" },
};
const compose = `services:\n  api:\n    image: node:22\n    environment:\n      API_KEY: plaintext-must-not-land`;

const execute = (input: unknown, scope: Partial<ActionContext> = {}) =>
  runAction("project.importCompose", { ...ctx, ...scope }, input, { mode: "execute" }).then((r) => r.result!);

beforeEach(() => {
  resetDb({ workspaces: [{ id: ctx.workspaceId, name: "Import", slug: "import", createdAt: "2026-01-01" }] });
});

describe("compose secret identity", () => {
  it("creates project- and service-scoped references", async () => {
    const a = await execute({ composeYaml: compose, name: "A" });
    const b = await execute({ composeYaml: compose, name: "B" });
    const pa = q.project((a.data as { projectId: string }).projectId)!;
    const pb = q.project((b.data as { projectId: string }).projectId)!;
    const ref = (p: Project) => p.workingManifest.services[0].env[0].secretRef;
    expect(ref(pa)).toBe(`vault:${pa.id}/${pa.workingManifest.services[0].id}/API_KEY`);
    expect(ref(pb)).toBe(`vault:${pb.id}/${pb.workingManifest.services[0].id}/API_KEY`);
    expect(ref(pa)).not.toBe(ref(pb));
  });

  it("keeps an existing legacy reference on re-import instead of stranding its value", async () => {
    const made = await execute({ composeYaml: compose, name: "Legacy" });
    const project = q.project((made.data as { projectId: string }).projectId)!;
    project.workingManifest.services[0].env[0].secretRef = "vault:API_KEY";

    await execute({ projectId: project.id, composeYaml: compose }, { projectId: project.id });
    expect(q.project(project.id)!.workingManifest.services[0].env[0].secretRef).toBe("vault:API_KEY");
  });
});
