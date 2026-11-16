/** Rotation store: tenancy, single open candidate, and the guarded atomic promotion (real PGlite). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { GcpConnectionConfig } from "@/lib/credentials/types";
import { applyRotationPatch, CreateGcpInput, CreateOciInput, LifecycleInputError } from "@/lib/connections/schemas";

const live: GcpConnectionConfig = {
  provider: "gcp", mode: "oidc_web_identity", region: "asia-south1", projectId: "acme-prod-123456",
  workloadIdentityProvider: "projects/123456789012/locations/global/workloadIdentityPools/zenith/providers/zenith-oidc",
  observeServiceAccount: "zenith-observe@acme-prod-123456.iam.gserviceaccount.com",
  deployServiceAccount: "zenith-deploy@acme-prod-123456.iam.gserviceaccount.com",
};
const next: GcpConnectionConfig = { ...live, observeServiceAccount: "zenith-observe-v2@acme-prod-123456.iam.gserviceaccount.com" };

let db: PlatformDbHandle;
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await db?.close(); });

async function connection(workspaceId: string) {
  const c = await repos.connections.create(db, { workspaceId, createdBy: "admin", config: live });
  await repos.connections.recordVerification(db, { workspaceId, id: c.id, ok: true, detail: "fixture" });
  return c;
}

describe("rotation store", () => {
  it("is tenant scoped: a foreign workspace sees and changes nothing", async () => {
    const c = await connection("ws-a");
    const rotation = (await repos.connectionRotations.stage(db, { workspaceId: "ws-a", connectionId: c.id, candidateConfig: next, createdBy: "admin" }))!;
    expect(await repos.connectionRotations.stage(db, { workspaceId: "ws-b", connectionId: c.id, candidateConfig: next, createdBy: "mallory" })).toBeNull();
    expect(await repos.connectionRotations.get(db, "ws-b", rotation.id)).toBeNull();
    expect(await repos.connectionRotations.getOpen(db, "ws-b", c.id)).toBeNull();
    expect(await repos.connectionRotations.abort(db, { workspaceId: "ws-b", id: rotation.id, actorId: "mallory" })).toBeNull();
    expect(await repos.connectionRotations.recordCandidateVerification(db, { workspaceId: "ws-b", id: rotation.id, ok: true })).toBeNull();
    expect(await repos.connectionRotations.promote(db, { workspaceId: "ws-b", id: rotation.id, actorId: "mallory" })).toEqual({ ok: false, reason: "not_found" });
    expect((await repos.connectionRotations.get(db, "ws-a", rotation.id))!.status).toBe("staged");
    expect(await repos.connections.revokeAudited(db, { workspaceId: "ws-b", id: c.id, actorId: "mallory" })).toBeNull();
    expect((await repos.connections.get(db, "ws-a", c.id))!.status).toBe("verified");
  });

  it("keeps one open candidate per connection and refuses no-op or cross-mode candidates", async () => {
    const c = await connection("ws-one");
    const a = (await repos.connectionRotations.stage(db, { workspaceId: "ws-one", connectionId: c.id, candidateConfig: next, createdBy: "admin" }))!;
    const b = (await repos.connectionRotations.stage(db, { workspaceId: "ws-one", connectionId: c.id, candidateConfig: { ...next, deployServiceAccount: "zenith-deploy-v2@acme-prod-123456.iam.gserviceaccount.com" }, createdBy: "admin" }))!;
    expect((await repos.connectionRotations.get(db, "ws-one", a.id))!.status).toBe("superseded");
    expect((await repos.connectionRotations.getOpen(db, "ws-one", c.id))!.id).toBe(b.id);
    await expect(repos.connectionRotations.stage(db, { workspaceId: "ws-one", connectionId: c.id, candidateConfig: live, createdBy: "admin" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repos.connectionRotations.stage(db, { workspaceId: "ws-one", connectionId: c.id, candidateConfig: { ...next, mode: "runner" } as never, createdBy: "admin" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repos.connectionRotations.stage(db, { workspaceId: "ws-one", connectionId: c.id, candidateConfig: { ...next, privateKey: "x" } as never, createdBy: "admin" })).rejects.toMatchObject({ code: "secret_material" });
  });

  it("promotes only a fresh, verified candidate over an unchanged, unrevoked connection", async () => {
    const c = await connection("ws-promote");
    const r = (await repos.connectionRotations.stage(db, { workspaceId: "ws-promote", connectionId: c.id, candidateConfig: next, createdBy: "admin" }))!;
    expect(await repos.connectionRotations.promote(db, { workspaceId: "ws-promote", id: r.id, actorId: "admin" })).toEqual({ ok: false, reason: "not_verified" });
    await repos.connectionRotations.recordCandidateVerification(db, { workspaceId: "ws-promote", id: r.id, ok: true, detail: "candidate ok" });
    const done = await repos.connectionRotations.promote(db, { workspaceId: "ws-promote", id: r.id, actorId: "admin" });
    expect(done).toMatchObject({ ok: true, previousConfig: live, connection: { status: "verified", config: next }, rotation: { status: "promoted", resolvedBy: "admin" } });
    expect(await repos.connectionRotations.promote(db, { workspaceId: "ws-promote", id: r.id, actorId: "admin" })).toEqual({ ok: false, reason: "not_verified" });
  });

  it("refuses promotion after revocation and discards the candidate", async () => {
    const c = await connection("ws-revoked");
    const r = (await repos.connectionRotations.stage(db, { workspaceId: "ws-revoked", connectionId: c.id, candidateConfig: next, createdBy: "admin" }))!;
    await repos.connectionRotations.recordCandidateVerification(db, { workspaceId: "ws-revoked", id: r.id, ok: true });
    const revoked = await repos.connections.revokeAudited(db, { workspaceId: "ws-revoked", id: c.id, actorId: "admin", reason: "leaked" });
    expect(revoked).toMatchObject({ alreadyRevoked: false, connection: { status: "revoked" } });
    expect((await repos.connectionRotations.get(db, "ws-revoked", r.id))!.status).toBe("aborted");
    expect(await repos.connectionRotations.promote(db, { workspaceId: "ws-revoked", id: r.id, actorId: "admin" })).toMatchObject({ ok: false });
    await expect(repos.connectionRotations.stage(db, { workspaceId: "ws-revoked", connectionId: c.id, candidateConfig: next, createdBy: "admin" })).rejects.toMatchObject({ code: "invalid_state" });
    expect((await repos.connections.get(db, "ws-revoked", c.id))!.config).toEqual(live);
  });

  it("revocation is terminal and verification can no longer record against it", async () => {
    const c = await connection("ws-terminal");
    await repos.connections.revokeAudited(db, { workspaceId: "ws-terminal", id: c.id, actorId: "admin" });
    expect(await repos.connections.recordVerification(db, { workspaceId: "ws-terminal", id: c.id, ok: true })).toBeNull();
    expect((await repos.connections.revokeAudited(db, { workspaceId: "ws-terminal", id: c.id, actorId: "admin" }))!.alreadyRevoked).toBe(true);
    const events = await repos.events.list(db, "ws-terminal", { type: "connection.revoked" });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("privateKey");
  });
});

describe("lifecycle schemas", () => {
  it("applies a patch without changing the pinned identity", () => {
    expect(applyRotationPatch(live, { observeServiceAccount: next.observeServiceAccount })).toEqual(next);
    for (const patch of [{ projectId: "x-project-1234" }, { region: "us-east1" }, {}, { workloadIdentityProvider: "nope" }]) expect(() => applyRotationPatch(live, patch)).toThrow(LifecycleInputError);
  });
  it("rotates only what each provider and mode allows", () => {
    const aws = { provider: "aws", mode: "oidc_web_identity", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/O", deployRoleArn: "arn:aws:iam::123456789012:role/D" } as const;
    expect(() => applyRotationPatch(aws, { rotateExternalId: true }, { newExternalId: () => "zenith-x" })).toThrow(/ExternalId/);
    expect(() => applyRotationPatch(aws, { deployRoleArn: "arn:aws:iam::999999999999:role/D" })).toThrow(/account 123456789012/);
    expect(applyRotationPatch({ ...aws, mode: "aws_assume_role", externalId: "zenith-old" }, { rotateExternalId: true }, { newExternalId: () => "zenith-new" })).toMatchObject({ externalId: "zenith-new" });
    expect(() => applyRotationPatch({ provider: "kubernetes", mode: "oidc_web_identity", server: "https://k.example", namespaces: ["a"] }, { credentialRef: "vault:x-secret" })).toThrow(/kubeconfig_ref/);
  });
  it("creation schemas are strict and identifier-only", () => {
    expect(CreateOciInput.safeParse({ region: "us-ashburn-1", tenancyOcid: "ocid1.tenancy.oc1..aaaaaaaa1", compartmentOcid: "ocid1.compartment.oc1..aaaaaaaa1", runnerId: "run_1" }).success).toBe(true);
    expect(CreateOciInput.safeParse({ region: "us-ashburn-1", tenancyOcid: "ocid1.tenancy.oc1..aaaaaaaa1", compartmentOcid: "ocid1.compartment.oc1..aaaaaaaa1", runnerId: "run_1", token: "x" }).success).toBe(false);
    expect(CreateGcpInput.safeParse({ region: live.region, projectId: live.projectId, workloadIdentityProvider: live.workloadIdentityProvider, observeServiceAccount: live.observeServiceAccount, deployServiceAccount: live.deployServiceAccount, privateKey: "x" }).success).toBe(false);
  });
});
