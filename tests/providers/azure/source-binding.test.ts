/** PGlite tenant/configuration contracts; no Azure account is contacted. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textArray } from "@/lib/controlplane/db/sql";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { registerEnvironment } from "@/lib/reconcile/platform";
import { createAzureSourceStorageResolver } from "@/lib/providers/azure/release/source-binding";
import { binding, accountId } from "./source-storage-fixtures";
import { connection } from "./_helpers";
import { SUB, REGION } from "./release-fixtures";
import type { ResourceNode } from "@/lib/resources/types";
import type { AzureConnectionConfig } from "@/lib/credentials/types";
let db: Awaited<ReturnType<typeof openPlatformDb>>;
let sequence = 0;
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); });
afterAll(async () => { await db.close(); });
async function setup(change: Partial<AzureConnectionConfig> = {}) {
  const workspaceId = `ws-source-${++sequence}`, environmentId = `env-source-${sequence}`;
  const config = { ...connection, subscriptionId: SUB, region: REGION, sourceStorage: { [environmentId]: binding }, ...change };
  const c = await repos.connections.create(db, { workspaceId, config, createdBy: "operator" });
  await repos.connections.recordVerification(db, { workspaceId, id: c.id, ok: true });
  await registerEnvironment(db, { environment: { workspaceId, environmentId, class: "production", provider: "azure", region: REGION, connection: { id: c.id, status: "verified" } } });
  const node: ResourceNode = { address: binding.resourceAddress, kind: "object_store", nativeType: "azure:storage_container", provider: "azure", region: REGION, ownership: "managed", externalRef: accountId, spec: {}, specDigest: "a".repeat(64), dependsOn: [], origin: [], labels: {} };
  const resource = await repos.resources.upsertDesired(db, { workspaceId, environmentId, node, status: "active" });
  return { c, node, resource, scope: { workspaceId, environmentId, subscriptionId: SUB, region: REGION } };
}
describe("trusted Azure source storage resolver", () => {
  it("derives the binding from the verified environment connection and owned resource", async () => {
    const { scope, c, resource } = await setup(); const resolve = createAzureSourceStorageResolver(db);
    expect(await resolve(scope)).toEqual(binding);
    expect(await resolve({ ...scope, connectionId: c.id, resourceId: resource.id })).toEqual(binding);
  });
  it("refuses foreign workspace/environment/subscription/region/connection and resource grants", async () => {
    const { scope } = await setup(); const resolve = createAzureSourceStorageResolver(db);
    for (const change of [{ workspaceId: "foreign" }, { environmentId: "foreign" }, { subscriptionId: "99999999-2222-3333-4444-555555555555" }, { region: "foreign" }, { connectionId: "foreign" }]) expect(await resolve({ ...scope, ...change })).toBeNull();
    await expect(resolve({ ...scope, resourceId: "foreign" })).rejects.toThrow("granted environment");
  });
  it("never borrows state storage or bindings of another environment", async () => {
    const { scope } = await setup({ sourceStorage: { another: binding }, stateStorageAccount: "stateaccount", stateContainer: "state" });
    expect(await createAzureSourceStorageResolver(db)(scope)).toBeNull();
  });
  it("refuses pending, revoked and missing registrations", async () => {
    const { scope, c } = await setup(); const resolve = createAzureSourceStorageResolver(db);
    await repos.connections.recordVerification(db, { workspaceId: scope.workspaceId, id: c.id, ok: false });
    expect(await resolve(scope)).toBeNull();
    await repos.connections.revoke(db, scope.workspaceId, c.id); expect(await resolve(scope)).toBeNull();
    expect(await resolve({ ...scope, environmentId: "never-registered" })).toBeNull();
  });
  it("refuses a configured cross-subscription source account", async () => {
    const { scope } = await setup();
    await db.query("update platform.provider_connections set config = jsonb_set(config, $1::text[], $2::text::jsonb) where workspace_id = $3", [textArray(["sourceStorage", scope.environmentId, "accountResourceId"]), JSON.stringify(accountId.replace(SUB, "99999999-2222-3333-4444-555555555555")), scope.workspaceId]);
    await expect(createAzureSourceStorageResolver(db)(scope)).rejects.toThrow("outside this subscription");
  });
  it("does not treat a desired resource address or stale identity as sufficient authority", async () => {
    const { scope, node } = await setup();
    await repos.resources.upsertDesired(db, { workspaceId: scope.workspaceId, environmentId: scope.environmentId, node: { ...node, externalRef: undefined } });
    await expect(createAzureSourceStorageResolver(db)(scope)).rejects.toThrow("owned resource");
  });
  it("uses the current non-simulated observation and refuses a disappeared account", async () => {
    const { scope, resource } = await setup();
    await repos.observations.appendObservation(db, { workspaceId: scope.workspaceId, resourceId: resource.id, observation: { observedAt: new Date().toISOString(), address: binding.resourceAddress, externalId: accountId, presence: "missing", attributes: {}, source: "azure.storage_container@1", simulated: false } });
    await expect(createAzureSourceStorageResolver(db)(scope)).rejects.toThrow("owned resource");
  });
});
