/** Read-only acceptance of an operation created/reviewed through the real product and Temporal worker. */
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { openPlatformDb, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import { createPlatformReleaseStore } from "@/lib/controlplane/db/repos/release-pipelines";
import { immutableSourceSnapshot, sourceSnapshotDigest } from "@/lib/execution/source-snapshot";
import { verifyBuildProvenance } from "@/lib/execution/build-provenance";
import { getControlVerificationKeys } from "@/lib/credentials/signing";

const enabled = process.env.ZENITH_TEST_J6_OPERATED_RELEASE === "1";
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name} for the operated release harness.`); return value; };
let platform: PlatformDbHandle | undefined, application: PlatformDbHandle | undefined;
afterAll(async () => { await application?.close(); await platform?.close(); });
describe.skipIf(!enabled)("J6 operated LIFE-10 source release", () => {
  it("observes real review/workflow, immutable source, signed provenance, migration and independent SQL/HTTP readbacks", async () => {
    const workspaceId = required("ZENITH_J6_WORKSPACE_ID"), environmentId = required("ZENITH_J6_ENVIRONMENT_ID"), operationId = required("ZENITH_J6_OPERATION_ID");
    const url = new URL(required("ZENITH_J6_HTTP_URL"));
    expect(["127.0.0.1", "localhost"]).toContain(url.hostname); // This lane never calls a live cloud.
    platform = await openPlatformDb({ kind: "postgres", url: required("ZENITH_TEST_PLATFORM_PG_URL"), migrate: false, max: 1 });
    application = await openPlatformDb({ kind: "postgres", url: required("ZENITH_J6_APPLICATION_PG_URL"), migrate: false, max: 1 });
    const deadline = Date.now() + 900_000;
    let operation = await repos.operations.get(platform, workspaceId, operationId);
    while (operation && !["succeeded", "failed", "uncertain", "cancelled", "denied", "rejected", "expired"].includes(operation.status) && Date.now() < deadline) {
      await delay(2000); operation = await repos.operations.get(platform, workspaceId, operationId);
    }
    expect(operation).toMatchObject({ workspaceId, environmentId, status: "succeeded", approvalRequired: true });
    expect(operation?.workflowId).toBeTruthy(); expect(operation?.planDigest).toMatch(/^[a-f0-9]{64}$/);
    const approvals = await platform.query<{ approver_id: string; consumed_at: string | null }>("select approver_id, consumed_at from platform.approvals where workspace_id=$1 and operation_id=$2 and decision='approve'", [workspaceId, operationId]);
    expect(approvals.some(a => Boolean(a.approver_id) && Boolean(a.consumed_at))).toBe(true);
    const releases = await createPlatformReleaseStore(platform).listRuns(workspaceId, { environmentId, operationId });
    expect(releases).toHaveLength(1);
    const release = releases[0];
    expect(release).toMatchObject({ state: "readback_verified", provenance: { level: "attested" }, migration: { class: "expand", status: "ran", exitCode: 0 }, readback: { status: "verified", observedDigest: release.imageDigest } });
    const events = await createPlatformReleaseStore(platform).listEvents(workspaceId, release.id);
    const states = events.map(e => e.to);
    for (const state of ["verified", "deployed", "migrated", "ready", "cut_over", "readback_verified"] as const) expect(states).toContain(state);
    expect(states.indexOf("verified")).toBeLessThan(states.indexOf("deployed"));
    expect(states.indexOf("migrated")).toBeLessThan(states.indexOf("cut_over"));
    const rows = await platform.query<{ snapshot: unknown; snapshot_digest: string }>("select snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 and service_address=$3", [workspaceId, operationId, release.serviceAddress]);
    expect(rows).toHaveLength(1);
    const source = immutableSourceSnapshot(rows[0].snapshot);
    expect(["zenith", "kubernetes"]).toContain(source.provider);
    expect(sourceSnapshotDigest(source)).toBe(rows[0].snapshot_digest);
    expect(source.archiveDigest).toBe(release.sourceDigest);
    const evidence = await repos.evidence.list(platform, workspaceId, { operationId, limit: 500 });
    const record = evidence.find(e => !e.simulated && e.summary.kind === "build.provenance" && e.summary.service === release.serviceAddress);
    expect(record).toBeDefined();
    const parts = record!.summary.jwsParts;
    expect(Array.isArray(parts) && parts.length === 3 && parts.every(p => typeof p === "string")).toBe(true);
    expect(process.env.ZENITH_CONTROL_KMS_KEY_ID).toBeFalsy();
    const verified = await verifyBuildProvenance((parts as string[]).join("."), { workspaceId, environmentId, operationId, provider: source.provider,
      serviceAddress: source.serviceAddress, pipelineAddress: source.pipelineAddress, contextDir: ".", imageDigest: release.imageDigest, source, policy: { allowOpenEgress: false } }, await getControlVerificationKeys());
    expect(verified.exceptions).toEqual([]);
    // These values come from the application's database and serving socket, independently of the release records.
    expect(await application.query("select marker from public.j6_release_probe where id=1")).toEqual([{ marker: "zenith-j6-source-release" }]);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200); expect(await response.text()).toBe("zenith-j6-source-release\n");
  }, 960_000);
});
