import { describe, expect, it } from "vitest";
import { getBlueprint } from "@/lib/blueprints";
import { Manifest } from "@/lib/domain/types";

describe("LocalStack starter", () => {
  it("only includes the default managed resources the adapter can actually apply", () => {
    const blueprint = getBlueprint("local-resources")!;
    const manifest = blueprint.manifestFactory("new-team");
    expect(Manifest.safeParse(manifest).success).toBe(true);
    expect(manifest.services).toEqual([]);
    expect(manifest.routes).toEqual([]);
    expect(manifest.bindings).toEqual([]);
    expect(manifest.resources.map(r => r.kind)).toEqual(["object_store", "queue"]);
    expect(manifest.resources.every(r => r.ownership === "managed" && Object.keys(r.config).length === 0)).toBe(true);
  });
  it("creates distinct node identities for separate projects", () => {
    const blueprint = getBlueprint("local-resources")!;
    const first = blueprint.manifestFactory("first");
    const second = blueprint.manifestFactory("second");
    expect(first.resources.some(a => second.resources.some(b => a.id === b.id))).toBe(false);
  });
});
