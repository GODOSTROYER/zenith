/** Disk-backed product manifests: cold reads preserve versions and snapshots. */
import { beforeEach, describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-manifest-v2-store-");
const { db, resetDb, flush, q, revisionManifestAsync } = await import("@/lib/db/store");
const { ctx, AT, productSeed, v1, v2 } = await import("../actions/manifest-v2-fixture");
const { diffManifests } = await import("@/lib/domain/graph");

function coldBoot() {
  const g = globalThis as Record<string, unknown>;
  delete g.__zenithDb;
  delete g.__zenithManifests;
}
beforeEach(() => resetDb());

describe("product store manifest versions", () => {
  it.each([v1, v2])("round-trips working copy and revision exactly on cold reads (%#)", async (make) => {
    const manifest = make();
    const before = JSON.stringify(manifest);
    resetDb(productSeed(manifest));
    db().revisions.push({ id: "rev", projectId: "proj", number: 1, manifest: structuredClone(manifest), message: "Snapshot", author: ctx.actor, createdAt: AT });
    flush(); coldBoot();
    expect(JSON.stringify(q.project("proj")!.workingManifest)).toBe(before);
    expect(JSON.stringify(q.revisionManifest("rev"))).toBe(before);
    expect(JSON.stringify(await revisionManifestAsync("rev"))).toBe(before);
    expect(JSON.stringify(q.revision("rev")!.manifest)).toBe(before);
    q.project("proj")!.workingManifest.services[0].replicas = 5;
    flush(); coldBoot();
    expect(q.project("proj")!.workingManifest.services[0].replicas).toBe(5);
    expect(JSON.stringify(q.revision("rev")!.manifest)).toBe(before);
  });

  it("diffs a cold V1 revision against a cold V2 revision without losing settings", () => {
    resetDb(productSeed(v2()));
    for (const [i, manifest] of [v1(), v2()].entries())
      db().revisions.push({ id: `rev-${i}`, projectId: "proj", number: i + 1, manifest, message: "Snapshot", author: ctx.actor, createdAt: AT });
    flush(); coldBoot();
    const cs = diffManifests(q.revisionManifest("rev-0")!, q.revisionManifest("rev-1")!);
    expect(cs.items).toHaveLength(1);
    expect(cs.items[0].nodeType).toBe("manifest");
    expect(cs.items[0].fields?.map((field) => field.field)).toContain("release");
    expect(cs.totalCostDeltaUsd).toBe(0);
    expect(cs.warnings.join(" ")).toMatch(/cost estimate covers V1/);
  });
});
