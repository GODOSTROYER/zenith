import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { openPlatformDb } from "@/lib/controlplane/db";
import { getUpdateControl, putUpdateControl } from "@/lib/controlplane/db/repos/agent-updates";

const url = process.env.ZENITH_TEST_PLATFORM_PG_URL;
it.skipIf(!url)("real PostgreSQL serializes conflicting update/hold intents after the integrator migration", async () => {
  const db = await openPlatformDb({ kind: "postgres", url, max: 2 });
  const id = `run_update_${randomBytes(8).toString("hex")}`, workspaceId = `ws_update_${randomBytes(8).toString("hex")}`;
  try {
    // An absent migration is a failure in this enabled lane, never a fixture DDL fallback.
    await db.query("select revision from platform.agent_update_controls where workspace_id = $1", [workspaceId]);
    await db.query("insert into platform.runners (id, workspace_id, name, protocol, public_key) values ($1,$2,$3,$4,$5)", [id, workspaceId, id, "zenith.runner/v1", randomBytes(32).toString("base64url")]);
    const input = { expectedRevision: 0, hold: true, manifestSha256: null };
    const results = await Promise.allSettled([putUpdateControl(db, workspaceId, "runner", id, "operator", input), putUpdateControl(db, workspaceId, "runner", id, "operator", input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("conflict");
    expect(await getUpdateControl(db, workspaceId, "runner", id)).toMatchObject({ revision: 1, hold: true });
    await expect(putUpdateControl(db, `${workspaceId}_foreign`, "runner", id, "operator", input)).rejects.toMatchObject({ code: "not_found" });
    await db.query("update platform.runners set status = 'revoked' where workspace_id = $1 and id = $2", [workspaceId, id]);
    await expect(putUpdateControl(db, workspaceId, "runner", id, "operator", { ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "invalid_state" });
  } finally {
    try {
      await db.query("delete from platform.agent_update_controls where workspace_id = $1 and kind = 'runner' and agent_id = $2", [workspaceId, id]);
      await db.query("delete from platform.runners where workspace_id = $1 and id = $2", [workspaceId, id]);
    } finally { await db.close(); }
  }
});
