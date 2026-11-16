/**
 * PROD-OPS-07 operational rehearsal (retention: preview, legal hold, dry-run) on an owned, already running lean J1 stack.
 *
 * An operator with step-up reads the current retention policy, previews what it would prune, places a legal hold on a
 * workspace, previews again, lists and releases the hold. Nothing is deleted: pruning needs ZENITH_RETENTION_APPLY=1 and the
 * DEC-RETENTION decision, neither of which this rehearsal sets. Archive, verify and restore need a tenant-owned S3 object
 * store, which a local stack does not have; the live OPS-07 run covers them. The API's original composition is restored.
 *
 * Gated: ZENITH_LOCAL_OPS_REHEARSAL=1 with ZENITH_DEFAULT_STACK_DIRECTORY and ZENITH_DEFAULT_MAILPIT_URL naming the stack.
 */
import { describe, expect, it } from "vitest";
import { browserRequest, ok } from "../e2e/default/support.mjs";
import { openRealSession, stepUpWithAuthenticator } from "../../scripts/acceptance/live/product/mix-03-driver";
import { withApiEnvironment } from "../../scripts/release/drivers/stack-env";

const gated = process.env.ZENITH_LOCAL_OPS_REHEARSAL === "1";
const diag = (label: string, value: unknown) => { if (process.env.ZENITH_OPERATED_DIAGNOSTICS === "1") process.stderr.write(`ops07-${label} ${JSON.stringify(value).slice(0, 900)}\n`); };

describe.skipIf(!gated)("PROD-OPS-07 operated rehearsal: retention preview, legal hold and release, no deletion", () => {
  it("previews the policy, holds a workspace, previews again, releases the hold and deletes nothing", async () => {
    const directory = process.env.ZENITH_DEFAULT_STACK_DIRECTORY!;
    const { tenant, close } = await openRealSession(process.env);
    const api = await withApiEnvironment(directory, { ZENITH_OPS_ADMIN_IDS: tenant.ownerId });
    try {
      const page = tenant.owner, ws = tenant.workspaceId;
      await stepUpWithAuthenticator(page, tenant.stack, tenant.ownerSecret);
      const overview = ok(await browserRequest(page, "/api/admin/ops/retention", undefined, "GET", ws)) as { policy?: { valid?: boolean; value?: unknown } };
      diag("overview", overview);
      expect(overview.policy?.valid).toBe(true);
      const preview = async () => (ok(await browserRequest(page, "/api/admin/ops/retention/preview", { policy: overview.policy!.value }, "POST", ws)) as { preview: unknown }).preview;
      const before = await preview();
      diag("preview-before", before);
      const created = ok(await browserRequest(page, "/api/admin/ops/retention/holds", { workspaceId: ws, reason: "PROD-OPS-07 operated rehearsal" }, "POST", ws)) as { hold: { id: string; workspaceId: string } };
      expect(created.hold.workspaceId).toBe(ws);
      const held = await preview();
      diag("preview-held", held);
      const active = ok(await browserRequest(page, `/api/admin/ops/retention/holds?workspaceId=${ws}`, undefined, "GET", ws)) as { holds: { id: string }[] };
      expect(active.holds.map(h => h.id)).toContain(created.hold.id);
      ok(await browserRequest(page, `/api/admin/ops/retention/holds?id=${created.hold.id}&workspaceId=${ws}`, undefined, "DELETE", ws));
      const after = ok(await browserRequest(page, `/api/admin/ops/retention/holds?workspaceId=${ws}`, undefined, "GET", ws)) as { holds: { id: string }[] };
      expect(after.holds.map(h => h.id)).not.toContain(created.hold.id);
      const all = ok(await browserRequest(page, `/api/admin/ops/retention/holds?workspaceId=${ws}&all=1`, undefined, "GET", ws)) as { holds: { id: string; releasedAt?: string | null }[] };
      expect(all.holds.find(h => h.id === created.hold.id)?.releasedAt).toBeTruthy();
      diag("preview-after", await preview());
    } finally {
      await api.restore();
      await close();
    }
  }, 1_800_000);
});
