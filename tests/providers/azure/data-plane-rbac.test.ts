/**
 * Data-plane RBAC (PROD-LIFE-04): the role catalog and its plane split, least-privilege grant shape, exact-scope
 * assignment reads, and role-propagation handling at the real call sites (Key Vault secret sync, source Blob
 * reads, the compiled role assignments). Contract-level: fake ARM, fake Key Vault, fake Blob; no Azure account.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArmError } from "@/lib/providers/azure/arm";
import {
  DataPlanePropagationTimeoutError, ROLE_CATALOG, RoleGrantRefusedError, assertRoleFitsTarget, awaitDataPlaneAccess, findRoleAssignment, isNeverGrantable, roleByGuid, roleByName,
  scopeFitsRole, splitByPlane,
} from "@/lib/providers/azure/data-plane-rbac";
import { BUILTIN_ROLE_IDS, rolesForGrants } from "@/lib/providers/azure/drivers/identity/identity";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { FORBIDDEN_ROLE_NAMES, ROLE } from "@/lib/providers/azure/platform";
import { syncSecretValue, SecretSyncError } from "@/lib/providers/azure/secrets";
import { kvSecretName } from "@/lib/providers/azure/drivers/identity/key-vault-secret";
import { createAzureSourceStorage } from "@/lib/providers/azure/release/source-storage";
import { SUB, compileAll, fakeArm, sampleGraph, sessionFor } from "./_helpers";
import { storageWorld } from "./source-storage-fixtures";

const main = readFileSync(path.resolve(__dirname, "../../../deploy/azure/main.tf"), "utf8");
const REGISTRY = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acmereg01`;
const VAULT = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/myvault`;
const CONTAINER = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct1/blobServices/default/containers/src`;

describe("role catalog", () => {
  it("has unique GUIDs and names, and covers exactly the roles the identity driver and bootstrap use", () => {
    expect(new Set(ROLE_CATALOG.map((r) => r.guid)).size).toBe(ROLE_CATALOG.length);
    expect(new Set(ROLE_CATALOG.map((r) => r.name.toLowerCase())).size).toBe(ROLE_CATALOG.length);
    for (const [guid, name] of Object.entries(BUILTIN_ROLE_IDS)) {
      expect(roleByGuid(guid)?.name, guid).toBe(name);
      expect(roleByGuid(guid)?.plane).toBe("data");
    }
    for (const name of Object.values(ROLE)) expect(roleByName(name), name).toBeDefined();
    // every GUID the bootstrap lets the deploy identity assign is a catalogued data role; the observe roles are control plane
    const listed = [...main.matchAll(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",?\s*#/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(5);
    for (const guid of listed) expect(roleByGuid(guid)?.plane, guid).toBe("data");
    for (const name of ["Reader", "Monitoring Reader", "Log Analytics Reader", "Key Vault Reader"]) expect(roleByName(name)?.plane, name).toBe("control");
  });

  it("data roles never accept a resource group or subscription scope and never list a forbidden role", () => {
    for (const r of ROLE_CATALOG) {
      expect(isNeverGrantable(r.name), r.name).toBe(false);
      if (r.plane === "data") {
        expect(r.dataActions.length, r.name).toBeGreaterThan(0);
        expect(r.scopeTypes.length, r.name).toBeGreaterThan(0);
        for (const t of r.scopeTypes) expect(t).toMatch(/^microsoft\.[a-z]+\/[a-z/]+$/);
      } else {
        expect(r.dataActions).toEqual([]);
        expect(r.targetKinds).toEqual([]);
      }
    }
    for (const name of FORBIDDEN_ROLE_NAMES) expect(isNeverGrantable(name.toUpperCase())).toBe(true);
  });

  it("splits any role list by plane and reports an uncatalogued role instead of guessing", () => {
    const split = splitByPlane([{ role: "AcrPull" }, { role: "Reader" }, { role: "Storage Blob Data Reader" }, { role: "Some Custom Role" }, { role: "acrpush" }]);
    expect(split.data.map((r) => r.role)).toEqual(["AcrPull", "Storage Blob Data Reader", "acrpush"]);
    expect(split.control.map((r) => r.role)).toEqual(["Reader"]);
    expect(split.unknown.map((r) => r.role)).toEqual(["Some Custom Role"]);
  });
});

describe("workload grants are data-plane, least-privilege and kind-correct", () => {
  it("accepts the catalogued data role for its target kind and refuses everything else", () => {
    expect(assertRoleFitsTarget(ROLE.acrPull, "container_registry").plane).toBe("data");
    expect(assertRoleFitsTarget(ROLE.blobContributor, "object_store").name).toBe("Storage Blob Data Contributor");
    expect(assertRoleFitsTarget(ROLE.keyVaultSecretsUser, "secret").risk).toBe("read");
    for (const name of FORBIDDEN_ROLE_NAMES) expect(() => assertRoleFitsTarget(name, "object_store"), name).toThrow(RoleGrantRefusedError);
    expect(() => assertRoleFitsTarget("Reader", "object_store")).toThrow(/control-plane/);
    expect(() => assertRoleFitsTarget("Made Up Role", "object_store")).toThrow(/catalog/);
    expect(() => assertRoleFitsTarget(ROLE.acrPull, "object_store")).toThrow(/cannot be granted/);
    expect(() => assertRoleFitsTarget(ROLE.keyVaultSecretsUser, "queue")).toThrow(RoleGrantRefusedError);
  });

  it("a push grant becomes the single AcrPush role on the registry (push implies pull); pull stays AcrPull", () => {
    const push = rolesForGrants([{ target: "container_registry/web", access: ["pull", "push"], via: ["build"] }]);
    expect(push).toEqual([{ target: "container_registry/web", role: "AcrPush", scopeKey: "id" }]);
    expect(rolesForGrants([{ target: "container_registry/web", access: ["pull"], via: ["image_pull"] }])).toEqual([{ target: "container_registry/web", role: "AcrPull", scopeKey: "id" }]);
    expect(() => rolesForGrants([{ target: "object_store/x", access: ["push"], via: [] }])).not.toThrow();
    expect(rolesForGrants([{ target: "object_store/x", access: ["push"], via: [] }])).toEqual([]);
  });

  it("scopes must be the exact resource type: not a resource group, subscription or another service", () => {
    const acrPull = roleByName("AcrPull")!, kv = roleByName("Key Vault Secrets User")!, blob = roleByName("Storage Blob Data Reader")!;
    expect(scopeFitsRole(acrPull, REGISTRY, SUB)).toBe(true);
    expect(scopeFitsRole(kv, VAULT, SUB)).toBe(true);
    expect(scopeFitsRole(blob, CONTAINER, SUB)).toBe(true);
    expect(scopeFitsRole(blob, CONTAINER.split("/blobServices")[0], SUB)).toBe(true);
    for (const bad of [`/subscriptions/${SUB}`, `/subscriptions/${SUB}/resourceGroups/rg`, VAULT, `${REGISTRY}/../x`, `${REGISTRY}/*`, "not-an-id", REGISTRY.replace(SUB, "99999999-2222-3333-4444-555555555555")]) {
      expect(scopeFitsRole(acrPull, bad, SUB), bad).toBe(false);
    }
    expect(scopeFitsRole(kv, REGISTRY, SUB)).toBe(false);
  });

  it("the compiled role assignments are data roles, one resource each, and skip the Entra pre-check for the fresh identity", () => {
    const nodes = sampleGraph();
    nodes.find((n) => n.address === "identity/web")!.spec.grants = [
      { target: "container_registry/web", access: ["pull", "push"], via: ["build"] },
      { target: "object_store/uploads", access: ["read"], via: ["binding:blob"] },
      { target: "secret/session-key-1a2b3c4d", access: ["read"], via: ["env:SESSION_KEY"] },
    ];
    const frags = compileAll(nodes, (n) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType));
    const roles = Object.values((frags.get("identity/web")!.resource!.azurerm_role_assignment ?? {}) as Record<string, Record<string, unknown>>);
    expect(roles.map((r) => r.role_definition_name).sort()).toEqual(["AcrPush", "Key Vault Secrets User", "Storage Blob Data Reader"]);
    const { control, unknown } = splitByPlane(roles.map((r) => ({ role: String(r.role_definition_name) })));
    expect(control).toEqual([]);
    expect(unknown).toEqual([]);
    for (const r of roles) {
      expect(r.skip_service_principal_aad_check).toBe(true);
      expect(r.principal_type).toBe("ServicePrincipal");
      expect(String(r.scope)).toMatch(/^\$\{local\.[a-z0-9_]+__(id|vault_id|resource_manager_id)\}$/);
    }
  });

  it("federated trust on the workload identity takes the cloud's audience from the compile context (public default unchanged)", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../src/lib/providers/azure/drivers/identity/identity.ts"), "utf8");
    expect(src).toContain("azureCloud(ctx.azureCloud).federationAudience");
    expect(src).not.toContain('audience: ["api://AzureADTokenExchange"]');
  });
});

describe("deploy/azure bootstrap federation audience", () => {
  it("trusts the audience of the configured cloud and defaults to the public exchange audience", () => {
    const vars = readFileSync(path.resolve(__dirname, "../../../deploy/azure/variables.tf"), "utf8");
    expect(vars).toContain('variable "cloud"');
    expect(vars).toContain('contains(["public", "usgov", "china"], var.cloud)');
    expect(main).toContain('usgov  = "api://AzureADTokenExchangeUSGov"');
    expect(main).toContain('china  = "api://AzureADTokenExchangeChina"');
    expect(main).toContain("federation_audience = local.federation_audiences[var.cloud]");
    expect(main.match(/audience\s+= \[local\.federation_audience\]/g)).toHaveLength(2);
  });
});

describe("awaitDataPlaneAccess", () => {
  const clock = () => {
    let t = 1_000_000;
    const sleeps: number[] = [];
    return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
  };
  const denied = () => new ArmError("forbidden", 403, "denied");
  const isDenied = (e: unknown) => e instanceof ArmError && e.kind === "forbidden";

  it("retries an RBAC denial with bounded exponential backoff until the permission appears", async () => {
    const c = clock();
    let n = 0;
    const out = await awaitDataPlaneAccess(async () => (++n < 5 ? Promise.reject(denied()) : "ok"), isDenied, { initialDelayMs: 1000, maxDelayMs: 4000, timeoutMs: 600_000, sleep: c.sleep, now: c.now });
    expect(out).toMatchObject({ result: "ok", attempts: 5, waitedMs: 1000 + 2000 + 4000 + 4000 });
    expect(c.sleeps).toEqual([1000, 2000, 4000, 4000]);
  });

  it("gives up at the deadline with an explicit propagation error, never longer than the deadline", async () => {
    const c = clock();
    const err = await awaitDataPlaneAccess(async () => Promise.reject(denied()), isDenied, { initialDelayMs: 1000, maxDelayMs: 8000, timeoutMs: 10_000, sleep: c.sleep, now: c.now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataPlanePropagationTimeoutError);
    expect((err as DataPlanePropagationTimeoutError).waitedMs).toBe(10_000);
    expect((err as Error).message).toMatch(/still denied after 10s/);
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it("does not retry anything that is not an RBAC denial, nor a zero deadline", async () => {
    const c = clock();
    let n = 0;
    await expect(awaitDataPlaneAccess(async () => { n++; throw new ArmError("not_found", 404, "nf"); }, isDenied, { sleep: c.sleep, now: c.now })).rejects.toMatchObject({ kind: "not_found" });
    expect(n).toBe(1);
    n = 0;
    await expect(awaitDataPlaneAccess(async () => { n++; throw denied(); }, isDenied, { timeoutMs: 0, sleep: c.sleep, now: c.now })).rejects.toBeInstanceOf(DataPlanePropagationTimeoutError);
    expect(n).toBe(1);
    expect(c.sleeps).toEqual([]);
  });

  it("an abort stops the wait and surfaces the denial", async () => {
    const abort = new AbortController();
    let n = 0;
    const err = await awaitDataPlaneAccess(async () => { n++; throw denied(); }, isDenied, { signal: abort.signal, timeoutMs: 600_000, sleep: async () => abort.abort(), now: () => 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArmError);
    expect(n).toBe(1);
  });

  it("clamps an oversized deadline to the maximum", async () => {
    const c = clock();
    const err = await awaitDataPlaneAccess(async () => Promise.reject(denied()), isDenied, { initialDelayMs: 60_000, maxDelayMs: 60_000, timeoutMs: 24 * 3600_000, sleep: c.sleep, now: c.now }).catch((e: unknown) => e);
    expect((err as DataPlanePropagationTimeoutError).waitedMs).toBe(15 * 60_000);
  });
});

describe("findRoleAssignment (exact scope)", () => {
  const principalId = "77777777-6666-5555-4444-333333333333";
  const guid = roleByName("AcrPull")!.guid;
  const assignment = (scope: string) => ({ id: `${scope}/providers/Microsoft.Authorization/roleAssignments/a1`, name: "a1", type: "Microsoft.Authorization/roleAssignments", properties: { principalId, scope, roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${guid}` } });
  const run = async (value: unknown[], status = 200) => {
    const arm = await fakeArm([{ method: "GET", match: (p) => p.toLowerCase().endsWith("/providers/microsoft.authorization/roleassignments"), status, body: status === 200 ? { value } : { error: { code: "AuthorizationFailed", message: "x" } } }]);
    try {
      return { result: await findRoleAssignment(await sessionFor(arm), undefined, { scopeId: REGISTRY, principalId, roleName: "AcrPull" }), arm };
    } finally {
      await arm.close();
    }
  };

  it("present only when the assignment is at exactly the resource scope", async () => {
    const { result, arm } = await run([assignment(REGISTRY)]);
    expect(result).toEqual({ state: "present", scopes: [REGISTRY] });
    expect(arm.requests[0].query.get("$filter")).toBe(`principalId eq '${principalId}'`);
  });

  it("an assignment only at a parent scope is reported as broader than required, not present", async () => {
    expect((await run([assignment(`/subscriptions/${SUB}/resourceGroups/rg`)])).result).toMatchObject({ state: "broader_than_required" });
    expect((await run([assignment(`/subscriptions/${SUB}`)])).result.state).toBe("broader_than_required");
  });

  it("missing for another role or principal; unreadable when ARM refuses", async () => {
    const other = { ...assignment(REGISTRY), properties: { ...assignment(REGISTRY).properties, roleDefinitionId: `/x/roleDefinitions/${roleByName("AcrPush")!.guid}` } };
    expect((await run([other])).result.state).toBe("missing");
    const foreign = { ...assignment(REGISTRY), properties: { ...assignment(REGISTRY).properties, principalId: "11111111-1111-1111-1111-111111111111" } };
    expect((await run([foreign])).result.state).toBe("missing");
    expect((await run([], 403)).result.state).toBe("unreadable");
  });

  it("refuses an unknown role, a bad principal or a scope the role cannot take before any call", async () => {
    const arm = await fakeArm();
    const session = await sessionFor(arm);
    await expect(findRoleAssignment(session, undefined, { scopeId: REGISTRY, principalId, roleName: "Nope" })).rejects.toBeInstanceOf(RoleGrantRefusedError);
    await expect(findRoleAssignment(session, undefined, { scopeId: VAULT, principalId, roleName: "AcrPull" })).rejects.toBeInstanceOf(RoleGrantRefusedError);
    await expect(findRoleAssignment(session, undefined, { scopeId: REGISTRY, principalId: "not-a-guid", roleName: "AcrPull" })).rejects.toBeInstanceOf(RoleGrantRefusedError);
    expect(arm.requests).toHaveLength(0);
    await arm.close();
  });
});

describe("Key Vault secret sync waits out role propagation", () => {
  const ref = "vault:ws_1/env_1/API_KEY";
  const input = { vaultUri: "https://myvault.vault.azure.net/", secretRef: ref, value: "a-secret-value" };
  const secretPath = (p: string) => p.toLowerCase().startsWith("/secrets/");
  const rbac = { status: 403, body: { error: { code: "ForbiddenByRbac", message: "caller lacks permission" } } };
  const fast = { initialDelayMs: 1, maxDelayMs: 2, sleep: async () => undefined };

  it("retries ForbiddenByRbac and then writes the secret", async () => {
    let gets = 0;
    const arm = await fakeArm([
      { method: "GET", match: secretPath, handler: () => (++gets <= 2 ? rbac : { status: 404, body: { error: { code: "SecretNotFound", message: "nf" } } }) },
      { method: "PUT", match: secretPath, handler: () => ({ status: 200, body: { id: `https://myvault.vault.azure.net/secrets/${kvSecretName(ref)}/0123456789abcdef0123456789abcdef` } }) },
    ]);
    const r = await syncSecretValue(await sessionFor(arm), { ...input, propagation: { ...fast, timeoutMs: 60_000 } });
    expect(r.status).toBe("created");
    expect(gets).toBe(3);
    await arm.close();
  });

  it("without a propagation window a denial fails at once (the verified contract)", async () => {
    const arm = await fakeArm([{ method: "GET", match: secretPath, ...rbac }]);
    await expect(syncSecretValue(await sessionFor(arm), input)).rejects.toMatchObject({ reason: "forbidden_by_rbac" });
    expect(arm.requests).toHaveLength(1);
    await arm.close();
  });

  it("a firewall denial is never treated as propagation", async () => {
    const arm = await fakeArm([{ method: "GET", match: secretPath, status: 403, body: { error: { code: "ForbiddenByFirewall", message: "Client address is not authorized" } } }]);
    await expect(syncSecretValue(await sessionFor(arm), { ...input, propagation: { ...fast, timeoutMs: 60_000 } })).rejects.toMatchObject({ reason: "forbidden_by_firewall" });
    expect(arm.requests).toHaveLength(1);
    await arm.close();
  });

  it("a denial that never clears ends as forbidden_by_rbac naming the missing role, with no secret value in the message", async () => {
    const arm = await fakeArm([{ method: "GET", match: secretPath, ...rbac }]);
    let t = 0;
    const err = await syncSecretValue(await sessionFor(arm), { ...input, propagation: { initialDelayMs: 1000, maxDelayMs: 1000, timeoutMs: 3000, sleep: async (ms) => void (t += ms), now: () => t } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretSyncError);
    expect(err).toMatchObject({ reason: "forbidden_by_rbac" });
    expect((err as Error).message).toMatch(/after waiting for role propagation/);
    expect((err as Error).message).toContain("Key Vault Secrets Officer");
    expect((err as Error).message).not.toContain(input.value);
    expect(arm.requests).toHaveLength(4);
    await arm.close();
  });
});

describe("source Blob reads wait out role propagation (and only for RBAC denials)", () => {
  it("retries 403 AuthorizationPermissionMismatch and then reads the exact bytes", async () => {
    const w = storageWorld();
    let blobCalls = 0;
    w.storage.before = (url) => {
      if (!url.hostname.includes("blob.core")) return undefined;
      return ++blobCalls <= 2 ? new Response("denied", { status: 403, headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" } }) : undefined;
    };
    const reader = createAzureSourceStorage({ resolveStorage: w.resolveStorage, propagationMs: 30_000, propagationDelayMs: 1 });
    expect(await reader.readSource(w.ctx, w.reference)).toEqual(w.archive);
    expect(blobCalls).toBe(3);
  });

  it("does not retry a firewall denial and refuses with the same generic reason as before", async () => {
    const w = storageWorld();
    let blobCalls = 0;
    w.storage.before = (url) => (url.hostname.includes("blob.core") ? (blobCalls++, new Response("denied", { status: 403, headers: { "x-ms-error-code": "AuthorizationFailure" } })) : undefined);
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage, propagationMs: 30_000, propagationDelayMs: 1 }).readSource(w.ctx, w.reference)).rejects.toThrow("bound container");
    expect(blobCalls).toBe(1);
  });

  it("a permission that never arrives ends with an actionable, secret-free refusal", async () => {
    const w = storageWorld();
    w.storage.before = (url) => (url.hostname.includes("blob.core") ? new Response("private-secret-sentinel", { status: 403, headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" } }) : undefined);
    const err = await createAzureSourceStorage({ resolveStorage: w.resolveStorage, propagationMs: 20, propagationDelayMs: 5 }).readSource(w.ctx, w.reference).catch((e: unknown) => e);
    expect((err as Error).message).toContain("Storage Blob Data Contributor");
    expect((err as Error).message).not.toContain("private-secret-sentinel");
  });

  it("is off unless a window is configured (verified default), and rejects an invalid window", async () => {
    const w = storageWorld();
    let blobCalls = 0;
    w.storage.before = (url) => (url.hostname.includes("blob.core") ? (blobCalls++, new Response("denied", { status: 403, headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" } })) : undefined);
    await expect(createAzureSourceStorage({ resolveStorage: w.resolveStorage }).readSource(w.ctx, w.reference)).rejects.toThrow("bound container");
    expect(blobCalls).toBe(1);
    expect(() => createAzureSourceStorage({ propagationMs: -1 })).toThrow();
    expect(() => createAzureSourceStorage({ propagationMs: 3_600_000 })).toThrow();
  });
});
