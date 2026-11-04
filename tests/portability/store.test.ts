/**
 * PROD-LIFE-11 platform store: verified exports, restores with their readback
 * verdicts, and ownership claims, against the real platform schema (PGlite lane
 * here; set ZENITH_TEST_PLATFORM_PG_URL for real PostgreSQL as well).
 *
 * Operations and approvals are created by the real broker with a real policy
 * bundle, so the "human approved this exact proposal" check is the production one.
 */
import { describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { STORE_KINDS, approveAs, closeSharedPgliteAfterAll, makeHarness, proposeOk, user, type Harness } from "../capabilities/support";

closeSharedPgliteAfterAll();

const hex = (c: string): string => c.repeat(64);

function scopeFor(h: Harness, resourceId: string): Record<string, string> {
  return { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, resourceId };
}

async function seedReferencedDb(h: Harness, id = `${h.ids.resADbProd}_ref`): Promise<string> {
  h.world.resources.set(id, { environmentId: h.ids.envAProd, facts: { address: `postgres/legacy_${id.slice(-6)}`, kind: "postgres", stateful: true, ownership: "referenced", publiclyExposed: false } });
  await h.db!.query(
    `insert into platform.resources (id, workspace_id, environment_id, address, kind, provider, native_type, ownership, external_id, spec_digest, spec)
     values ($1,$2,$3,$4,'postgres','aws','aws:rds_instance','referenced','legacy-db-1',$5,'{}'::jsonb)`,
    [id, h.ids.wsA, h.ids.envAProd, `postgres/legacy_${id.slice(-6)}`, hex("a")]
  );
  return id;
}

const adoptInput = { claim: { externalId: "legacy-db-1", acknowledge: true, lifecycle: "manage" } };
const destination = { resourceAddress: "object_store/backups", credentialsRef: "vault:proj/backups/creds" };

async function approvedOperation(h: Harness, capability: "resource.adopt" | "resource.release" | "data.export" | "data.import", resourceId: string, input: Record<string, unknown>) {
  const op = await proposeOk(h, { capability, scope: scopeFor(h, resourceId), input }, user("bob"));
  expect(op.operation.status).toBe("awaiting_approval");
  const approved = await approveAs(h, op.operation, "alice");
  return { operation: op.operation, approvalId: approved.approval.id };
}

describe.each(STORE_KINDS.filter((k) => k !== "memory"))("portability store [%s]", (kind) => {
  it("records a verified export once per operation, and refuses a different digest for the same operation", async () => {
    const h = await makeHarness({ kind });
    const { operation } = await approvedOperation(h, "data.export", h.ids.resADbProd, { destination });
    const input = { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, operationId: operation.id, resourceId: h.ids.resADbProd, address: "resource/db", kind: "postgres", provider: "aws", engine: "postgres-logical-v1", engineVersion: "16.4", destinationLabel: "s3://tenant/zenith-portability/x/", artifactPrefix: "zenith-portability/x/", manifestDigest: hex("1"), contentDigest: hex("2"), fileCount: 6, byteSize: 1234, coverage: { tables: 2, rows: 6 }, verifiedAt: new Date().toISOString() };
    const first = await repos.portability.recordExport(h.db!, input);
    expect(first).toMatchObject({ kind: "postgres", fileCount: 6, byteSize: 1234, manifestDigest: hex("1"), coverage: { tables: 2, rows: 6 } });
    const again = await repos.portability.recordExport(h.db!, input);
    expect(again.id).toBe(first.id);
    await expect(repos.portability.recordExport(h.db!, { ...input, manifestDigest: hex("9") })).rejects.toMatchObject({ code: "conflict" });
    await expect(repos.portability.recordExport(h.db!, { ...input, kind: "redis" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repos.portability.recordExport(h.db!, { ...input, contentDigest: "nothex" })).rejects.toMatchObject({ code: "invalid_input" });

    // tenant scoping: another workspace sees nothing, and cannot read by id
    expect(await repos.portability.getExport(h.db!, h.ids.wsA, first.id)).toMatchObject({ id: first.id });
    expect(await repos.portability.getExport(h.db!, h.ids.wsB, first.id)).toBeNull();
    expect(await repos.portability.listExports(h.db!, h.ids.wsB, h.ids.envAProd)).toEqual([]);
    expect((await repos.portability.listExports(h.db!, h.ids.wsA, h.ids.envAProd)).map((e) => e.id)).toContain(first.id);

    // append-only
    await expect(h.db!.query("update platform.portability_exports set byte_size = 1 where id = $1", [first.id])).rejects.toThrow();
    await expect(h.db!.query("delete from platform.portability_exports where id = $1", [first.id])).rejects.toThrow();
  });

  it("derives a restore's verdict from the two digests and only accepts an export of this workspace", async () => {
    const h = await makeHarness({ kind });
    const exp = await approvedOperation(h, "data.export", h.ids.resADbProd, { destination });
    const record = await repos.portability.recordExport(h.db!, { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, operationId: exp.operation.id, resourceId: h.ids.resADbProd, address: "resource/db", kind: "postgres", provider: "aws", engine: "postgres-logical-v1", destinationLabel: "s3://t/p/", artifactPrefix: "p/", manifestDigest: hex("1"), contentDigest: hex("2"), fileCount: 1, byteSize: 1, coverage: {}, verifiedAt: new Date().toISOString() });

    const imp = await approvedOperation(h, "data.import", h.ids.resADbProd, { exportId: record.id, destination });
    const base = { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, operationId: imp.operation.id, exportId: record.id, targetResourceId: h.ids.resADbProd, targetAddress: "resource/db", kind: "postgres", provider: "aws", expectedContentDigest: hex("2"), readback: { tables: 2 }, restored: { rows: 6 }, verifiedAt: new Date().toISOString() };
    const verified = await repos.portability.recordRestore(h.db!, { ...base, observedContentDigest: hex("2") });
    expect(verified.status).toBe("verified");
    expect((await repos.portability.recordRestore(h.db!, { ...base, observedContentDigest: hex("2") })).id).toBe(verified.id);

    const imp2 = await approvedOperation(h, "data.import", h.ids.resADbProd, { exportId: record.id, destination, again: undefined });
    const mismatch = await repos.portability.recordRestore(h.db!, { ...base, operationId: imp2.operation.id, observedContentDigest: hex("3") });
    expect(mismatch.status).toBe("mismatch");
    // a restore naming an export with another content digest, or in another workspace, is refused
    const imp3 = await approvedOperation(h, "data.import", h.ids.resADbProd, { exportId: record.id, destination, third: undefined });
    await expect(repos.portability.recordRestore(h.db!, { ...base, operationId: imp3.operation.id, expectedContentDigest: hex("7"), observedContentDigest: hex("7") })).rejects.toMatchObject({ code: "not_found" });
    await expect(repos.portability.recordRestore(h.db!, { ...base, workspaceId: h.ids.wsB, operationId: imp3.operation.id, observedContentDigest: hex("2") })).rejects.toBeTruthy();
    expect((await repos.portability.listRestores(h.db!, h.ids.wsA, h.ids.envAProd)).map((r) => r.status).sort()).toEqual(["mismatch", "verified"]);
    expect(await repos.portability.listRestores(h.db!, h.ids.wsB, h.ids.envAProd)).toEqual([]);
    await expect(h.db!.query("update platform.portability_restores set status = 'verified' where id = $1", [mismatch.id])).rejects.toThrow();
    // the database itself refuses a status that disagrees with the digests
    await expect(h.db!.query("update platform.portability_restores set observed_content_digest = expected_content_digest where id = $1", [mismatch.id])).rejects.toThrow();
  });

  it("adopts a referenced resource only under a human approval of the exact operation, atomically with the ownership change", async () => {
    const h = await makeHarness({ kind });
    const resourceId = await seedReferencedDb(h);
    const { operation, approvalId } = await approvedOperation(h, "resource.adopt", resourceId, adoptInput);
    const adoption = await repos.portability.adopt(h.db!, { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, resourceId, operationId: operation.id, approvalId, externalId: "legacy-db-1", lifecycle: "manage", claim: adoptInput.claim, claimDigest: hex("4"), fieldOwners: [{ path: "zone", owner: "provider-managed" }], baseline: { v: 1, attributes: { engineVersion: "16" }, excluded: [] }, baselineDigest: hex("5") });
    expect(adoption).toMatchObject({ status: "active", lifecycle: "manage", externalId: "legacy-db-1", approvalId, proposalDigest: operation.proposalDigest, baselineDigest: hex("5") });
    expect((await repos.resources.get(h.db!, h.ids.wsA, resourceId))?.ownership).toBe("managed");

    // idempotent per operation
    expect((await repos.portability.adopt(h.db!, { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, resourceId, operationId: operation.id, approvalId, externalId: "legacy-db-1", lifecycle: "manage", claim: adoptInput.claim, claimDigest: hex("4"), fieldOwners: [], baseline: {}, baselineDigest: hex("5") })).id).toBe(adoption.id);

    // facts for the decommission gate, tenant scoped
    expect(await repos.portability.adoptionFacts(h.db!, h.ids.wsA, h.ids.envAProd)).toEqual([expect.objectContaining({ externalId: "legacy-db-1", status: "active", lifecycle: "manage", approvalId })]);
    expect(await repos.portability.adoptionFacts(h.db!, h.ids.wsB, h.ids.envAProd)).toEqual([]);
    expect(await repos.portability.getAdoption(h.db!, h.ids.wsB, adoption.id)).toBeNull();
    expect(await repos.portability.listAdoptions(h.db!, h.ids.wsB, h.ids.envAProd)).toEqual([]);

    // the claim cannot be edited or deleted
    await expect(h.db!.query("update platform.resource_adoptions set lifecycle = 'manage_and_destroy' where id = $1", [adoption.id])).rejects.toThrow();
    await expect(h.db!.query("delete from platform.resource_adoptions where id = $1", [adoption.id])).rejects.toThrow();
  });

  it("refuses to adopt without a human approval, with a stale or foreign approval, for a managed resource, or a second claim on the same object", async () => {
    const h = await makeHarness({ kind });
    const resourceId = await seedReferencedDb(h);
    const proposed = await proposeOk(h, { capability: "resource.adopt", scope: scopeFor(h, resourceId), input: adoptInput }, user("bob"));
    const args = (operationId: string, approvalId: string, rid = resourceId) => ({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, resourceId: rid, operationId, approvalId, externalId: "legacy-db-1", lifecycle: "manage", claim: adoptInput.claim, claimDigest: hex("4"), fieldOwners: [], baseline: {}, baselineDigest: hex("5") });
    // proposed but not approved: no approval row exists
    await expect(repos.portability.adopt(h.db!, args(proposed.id, "apr_nonexistent"))).rejects.toMatchObject({ code: "approval_required" });
    expect((await repos.resources.get(h.db!, h.ids.wsA, resourceId))?.ownership).toBe("referenced");

    const approved = await approveAs(h, proposed.operation, "alice");
    // wrong environment/resource for the operation
    const otherId = await seedReferencedDb(h, `${h.ids.resADbProd}_other`);
    await expect(repos.portability.adopt(h.db!, args(proposed.id, approved.approval.id, otherId))).rejects.toMatchObject({ code: "invalid_state" });
    // another workspace cannot use this operation
    await expect(repos.portability.adopt(h.db!, { ...args(proposed.id, approved.approval.id), workspaceId: h.ids.wsB })).rejects.toBeTruthy();
    expect((await repos.resources.get(h.db!, h.ids.wsA, otherId))?.ownership).toBe("referenced");

    await repos.portability.adopt(h.db!, args(proposed.id, approved.approval.id));
    // a managed resource cannot be adopted again; a second operation over the same external object is refused too
    const second = await approvedOperation(h, "resource.adopt", resourceId, { claim: { ...adoptInput.claim, note: "again" } });
    await expect(repos.portability.adopt(h.db!, args(second.operation.id, second.approvalId))).rejects.toMatchObject({ code: "conflict" });
    const third = await approvedOperation(h, "resource.adopt", otherId, adoptInput);
    await expect(repos.portability.adopt(h.db!, args(third.operation.id, third.approvalId, otherId))).rejects.toMatchObject({ code: "conflict" });
    expect((await repos.resources.get(h.db!, h.ids.wsA, otherId))?.ownership).toBe("referenced");
  });

  it("releases an adopted resource back under approval, once, without ever touching the object", async () => {
    const h = await makeHarness({ kind });
    const resourceId = await seedReferencedDb(h);
    const adopted = await approvedOperation(h, "resource.adopt", resourceId, adoptInput);
    const adoption = await repos.portability.adopt(h.db!, { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, resourceId, operationId: adopted.operation.id, approvalId: adopted.approvalId, externalId: "legacy-db-1", lifecycle: "manage_and_destroy", claim: adoptInput.claim, claimDigest: hex("4"), fieldOwners: [], baseline: {}, baselineDigest: hex("5") });
    // the world must now describe it as managed for the release proposal
    h.world.resources.set(resourceId, { environmentId: h.ids.envAProd, facts: { address: adoption.address, kind: "postgres", stateful: true, ownership: "managed", publiclyExposed: false } });
    const rel = await approvedOperation(h, "resource.release", resourceId, { adoptionId: adoption.id });
    const args = { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, resourceId, adoptionId: adoption.id, operationId: rel.operation.id, approvalId: rel.approvalId, releasedBy: "alice" };
    await expect(repos.portability.release(h.db!, { ...args, workspaceId: h.ids.wsB })).rejects.toBeTruthy();
    const released = await repos.portability.release(h.db!, args);
    expect(released).toMatchObject({ status: "released", releasedBy: "alice", releaseOperationId: rel.operation.id });
    expect((await repos.resources.get(h.db!, h.ids.wsA, resourceId))?.ownership).toBe("referenced");
    // idempotent for the same operation, refused for another
    expect((await repos.portability.release(h.db!, args)).id).toBe(adoption.id);
    const again = await approvedOperation(h, "resource.release", resourceId, { adoptionId: adoption.id, reason: "second" });
    await expect(repos.portability.release(h.db!, { ...args, operationId: again.operation.id, approvalId: again.approvalId })).rejects.toMatchObject({ code: "conflict" });
    expect(await repos.portability.adoptionFacts(h.db!, h.ids.wsA, h.ids.envAProd)).toEqual([expect.objectContaining({ status: "released" })]);
    // a released claim frees the object for a new claim
    h.world.resources.set(resourceId, { environmentId: h.ids.envAProd, facts: { address: adoption.address, kind: "postgres", stateful: true, ownership: "referenced", publiclyExposed: false } });
    const reAdopt = await approvedOperation(h, "resource.adopt", resourceId, { claim: { ...adoptInput.claim, note: "again" } });
    const next = await repos.portability.adopt(h.db!, { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, resourceId, operationId: reAdopt.operation.id, approvalId: reAdopt.approvalId, externalId: "legacy-db-1", lifecycle: "manage", claim: adoptInput.claim, claimDigest: hex("6"), fieldOwners: [], baseline: {}, baselineDigest: hex("7") });
    expect(next.status).toBe("active");
    expect(next.id).not.toBe(adoption.id);
  });
});
