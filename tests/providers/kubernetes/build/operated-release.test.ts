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
    const approvals = await platform.query<{
      approver_id: string;
      approver: { kind: string; id: string; onBehalfOf?: string; integrationId?: string };
      proposal_digest: string;
      approval_round: number;
      consumed_at: string | null;
    }>("select approver_id, approver, proposal_digest, approval_round, consumed_at from platform.approvals where workspace_id=$1 and operation_id=$2 and decision='approve'", [workspaceId, operationId]);
    // OperationRecord omits round metadata; bind approvals to the persisted current operation round.
    const operationRounds = await platform.query<{ approval_round: number }>("select approval_round from platform.operations where workspace_id=$1 and id=$2 and environment_id=$3", [workspaceId, operationId, environmentId]);
    expect(operationRounds).toHaveLength(1);
    const currentApprovalRound = operationRounds[0].approval_round;
    const requesterId = operation!.principal.onBehalfOf ?? operation!.principal.id;
    const hasConsumedApprovalFromAnotherUser = approvals.some(a =>
      a.approver_id !== requesterId
      && a.approver.kind === "user"
      && a.approver.id === a.approver_id
      && a.approver.onBehalfOf === undefined
      && a.approver.integrationId === undefined
      && a.proposal_digest === operation!.proposalDigest
      && a.approval_round === currentApprovalRound
      && Boolean(a.consumed_at)
    );
    expect(hasConsumedApprovalFromAnotherUser).toBe(true);
    const releases = await createPlatformReleaseStore(platform).listRuns(workspaceId, { environmentId, operationId });
    expect(releases).toHaveLength(1);
    const release = releases[0];
    expect(release).toMatchObject({ workspaceId, environmentId, operationId, kind: "deploy", state: "readback_verified", provenance: { level: "attested" }, migration: { class: "expand", status: "ran", exitCode: 0 }, readback: { status: "verified", observedDigest: release.imageDigest } });
    const events = await createPlatformReleaseStore(platform).listEvents(workspaceId, release.id);
    const states = events.map(e => e.to);
    for (const state of ["verified", "deployed", "migrated", "ready", "cut_over", "readback_verified"] as const) expect(states).toContain(state);
    expect(states.indexOf("verified")).toBeLessThan(states.indexOf("deployed"));
    expect(states.indexOf("migrated")).toBeLessThan(states.indexOf("cut_over"));
    const rows = await platform.query<{ snapshot: unknown; snapshot_digest: string }>("select snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 and environment_id=$3 and service_address=$4", [workspaceId, operationId, environmentId, release.serviceAddress]);
    expect(rows).toHaveLength(1);
    const source = immutableSourceSnapshot(rows[0].snapshot);
    expect(source.workspaceId).toBe(workspaceId);
    expect(source.operationId).toBe(operationId);
    expect(source.environmentId).toBe(environmentId);
    expect(source.serviceAddress).toBe(release.serviceAddress);
    expect(["zenith", "kubernetes"]).toContain(source.provider);
    expect(sourceSnapshotDigest(source)).toBe(rows[0].snapshot_digest);
    expect(source.archiveDigest).toBe(release.sourceDigest);
    // Query every matching operation row directly; the repository list API is capped at 500.
    const provenance = await platform.query<{
      id: string;
      workspace_id: string;
      operation_id: string;
      simulated: boolean;
      service: string;
      pipeline: string;
      image_digest: string;
      source_digest: string;
      source_commit: string;
    }>("select id,workspace_id,operation_id,simulated,summary->>'service' as service,summary->>'pipeline' as pipeline,summary->>'imageDigest' as image_digest,summary->>'sourceDigest' as source_digest,summary->>'commit' as source_commit from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='build' and summary->>'kind'='build.provenance' order by id", [workspaceId, operationId]);
    // Keep the failure diff free of stored JWS segments.
    expect(provenance.map(e => ({ id: e.id, workspaceId: e.workspace_id, operationId: e.operation_id,
      simulated: e.simulated, service: e.service, pipeline: e.pipeline,
      imageDigest: e.image_digest, sourceDigest: e.source_digest, commit: e.source_commit }))).toHaveLength(1);
    expect(provenance[0].simulated).toBe(false);
    expect(provenance[0].workspace_id).toBe(workspaceId);
    expect(provenance[0].operation_id).toBe(operationId);
    expect(provenance[0].service).toBe(source.serviceAddress);
    expect(provenance[0].pipeline).toBe(source.pipelineAddress);
    expect(provenance[0].image_digest).toBe(release.imageDigest);
    expect(provenance[0].source_digest).toBe(source.archiveDigest);
    expect(provenance[0].source_commit).toBe(source.commitSha);
    const record = await repos.evidence.get(platform, workspaceId, provenance[0].id);
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
