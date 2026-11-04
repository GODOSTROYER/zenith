/** A real product save/revision/engine path with simulated sandbox execution. */
import { expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-engine-manifest-v2-", { fast: true });
const { db, q, resetDb, flush, readEvents } = await import("@/lib/db/store");
const { runAction } = await import("@/lib/actions/core");
const { engineTickAsync } = await import("@/lib/engine/engine");
const { ctx, productSeed, v1, v2 } = await import("../actions/manifest-v2-fixture");
await import("@/lib/actions/defs");

it("deploys the V1 view in sandbox while revisioning the exact V2 document", async () => {
  resetDb(productSeed(v1()));
  const manifest = v2();
  const before = JSON.stringify(manifest);
  expect((await runAction("project.updateManifest", ctx, { manifest }, { mode: "execute" })).result?.ok).toBe(true);
  const result = await runAction("deploy.apply", ctx, {}, { mode: "execute" });
  expect(result.result?.ok).toBe(true);
  const dep = db().deployments[0];
  expect(dep).toBeDefined();
  await expect.poll(async () => {
    await engineTickAsync();
    return q.deployment(dep.id)?.status;
  }, { timeout: 10000, interval: 30 }).toBe("succeeded");
  expect(q.environment("env")?.deployedRevisionId).toBe(dep.revisionId);
  flush();
  expect(JSON.stringify(q.revisionManifest(dep.revisionId))).toBe(before);
  expect(JSON.stringify(q.project("proj")!.workingManifest)).toBe(before);
  expect(q.deployment(dep.id)?.outputs).not.toHaveLength(0);
  expect(readEvents(dep.id).some((event) => event.type === "log" && /V1 view only.*release/.test(event.line))).toBe(true);
});
