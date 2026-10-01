/** Real encrypted file vault and Kubernetes renderer; Neon and apply are contract doubles. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { databaseSpecFromNode, managedDatabaseConnectionRef } from "@/lib/providers/zenith/database";
import { createVaultDatabaseRuntime } from "@/lib/providers/zenith/database-factory";
import { openZenithSession } from "@/lib/providers/zenith/session";
import { FileSecretsAsync } from "@/lib/secrets/file-backend";
import { putSecretAsync } from "@/lib/secrets";
import { FakeTlsClient } from "./tls-support";
import { DB, DB_PASSWORD, FakeNeon, FakeToolkit, K8S_SESSION, NEON_KEY, TENANT, TYPICAL_GRAPH, resolver, substrate } from "./support";

const KEY_REF = "vault:zenith-managed/neon-api-key";
const REF = managedDatabaseConnectionRef(TENANT.environmentId, DB.address);
const CONNECTION_URI = `postgresql://app_owner:${DB_PASSWORD}@ep-quiet-glade-123456.us-east-2.aws.neon.tech/app?sslmode=require`;
let dir: string;
let neon: FakeNeon;
let toolkit: FakeToolkit;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "zenith-vault-runtime-"));
  vi.stubEnv("ZENITH_DATA", dir);
  vi.stubEnv("ZENITH_SECRET_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("ZENITH_STORE", "file");
  neon = new FakeNeon();
  await neon.start();
  toolkit = new FakeToolkit();
  toolkit.renderGraph = renderGraph;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await neon.stop();
  rmSync(dir, { recursive: true, force: true });
});

const runtime = (over: Partial<Parameters<typeof createVaultDatabaseRuntime>[0]> = {}) => {
  const config = substrate();
  return createVaultDatabaseRuntime({
    workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId, projectId: "project1",
    nodes: TYPICAL_GRAPH, substrate: { ...config, database: { ...config.database!, apiBase: neon.url } }, ...over,
  }, { fetch, resolveSecret: resolver(KEY_REF, NEON_KEY), timeoutMs: 3000 });
};
const deploy = async (ports = runtime(), dryRun = false) => {
  const session = await openZenithSession(TENANT, {
    substrate: substrate(), databases: ports.databases, createKubernetesSession: async () => K8S_SESSION,
  });
  return applyZenithEnvironment({
    session, expect: TENANT, toolkit, tlsClient: new FakeTlsClient(), nodes: TYPICAL_GRAPH,
    resolveSecret: ports.resolveSecret, dryRun,
  });
};
const spec = () => {
  const result = databaseSpecFromNode(TENANT, DB);
  if ("error" in result) throw new Error(result.error);
  return result.spec;
};

describe("managed database vault composition", () => {
  it.each([false, true])("persists the provider URI encrypted before rollout (URI fetched separately: %s), and retries converge", async (missing) => {
    neon.uriCanBeMissingFromCreate = missing;
    const ports = runtime();
    expect(await ports.resolveSecret(REF)).toBeUndefined();
    const first = await deploy(ports);
    expect(first.ok).toBe(true);
    expect(first.databases[0]).toMatchObject({ status: "created", connectionSecretRef: REF });
    expect(await ports.resolveSecret(REF)).toBe(CONNECTION_URI);
    expect(await FileSecretsAsync.get(TENANT.workspaceId, REF)).toMatchObject({ version: 1 });
    const second = await deploy(runtime());
    expect(second.ok).toBe(true);
    expect(second.databases[0].status).toBe("exists");
    expect(neon.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    const publicOutput = JSON.stringify({ first, second, objects: toolkit.applyCalls });
    const stored = readFileSync(path.join(dir, "secrets.json"), "utf8");
    for (const text of [publicOutput, stored]) {
      for (const canary of [DB_PASSWORD, NEON_KEY, CONNECTION_URI]) expect(text).not.toContain(canary);
    }
  });

  it("awaits vault persistence before applying any baseline or workload", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const put = FileSecretsAsync.putIfAbsent.bind(FileSecretsAsync);
    vi.spyOn(FileSecretsAsync, "putIfAbsent").mockImplementation(async (workspaceId, record) => {
      entered.resolve();
      await release.promise;
      return put(workspaceId, record);
    });
    const ports = runtime();
    const deploying = deploy(ports);
    await entered.promise;
    try {
      expect(toolkit.applyCalls).toEqual([]);
      expect(await ports.resolveSecret(REF)).toBeUndefined();
    } finally { release.resolve(); }
    expect((await deploying).ok).toBe(true);
    expect(toolkit.applyCalls).toHaveLength(2);
    expect(await ports.resolveSecret(REF)).toBe(CONNECTION_URI);
  });

  it("blocks rollout on vault failure without exposing provider credentials or store errors", async () => {
    vi.spyOn(FileSecretsAsync, "putIfAbsent").mockRejectedValue(new Error(`${DB_PASSWORD} ${NEON_KEY}`));
    const report = await deploy();
    expect(report).toMatchObject({ ok: false, blockedBy: "database", databases: [{ status: "failed", error: { code: "secret_store_failed" } }] });
    expect(toolkit.applyCalls).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(report)).not.toContain(NEON_KEY);
  });

  it("refuses a replacement URI after recreating a database and leaves the existing vault value intact", async () => {
    const previous = "postgresql://contract-user:prior-canary@previous.example/app";
    await putSecretAsync(TENANT.workspaceId, REF, previous, "contract-test");
    const ports = runtime();
    const report = await deploy(ports);
    expect(report).toMatchObject({ ok: false, blockedBy: "database", databases: [{ error: { code: "secret_store_failed" } }] });
    expect(await ports.resolveSecret(REF)).toBe(previous);
    expect(toolkit.applyCalls).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(previous);
    expect(JSON.stringify(report)).not.toContain(DB_PASSWORD);
  });

  it.each([
    { workspaceId: "other-workspace" }, { environmentId: "other-environment" }, { address: "postgres/other" },
  ])("refuses foreign targets before provider or vault I/O: %j", async (over) => {
    const ports = runtime();
    const target = { ...spec(), ...over };
    const read = vi.spyOn(FileSecretsAsync, "get");
    for (const result of [await ports.databases.create(target), await ports.databases.get(target), await ports.databases.delete(target)]) {
      expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(neon.requests).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not authorize referenced, foreign-provider or removed databases", async () => {
    for (const nodes of [[], [{ ...DB, ownership: "referenced" as const }], [{ ...DB, provider: "aws" as const }]]) {
      const ports = runtime({ nodes });
      expect(await ports.databases.create(spec())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      await expect(ports.resolveSecret(REF)).rejects.toMatchObject({ reason: "denied" });
      expect(() => ports.databases.connectionSecretRef(spec())).toThrow();
    }
    expect(neon.requests).toEqual([]);
  });

  it("scopes URI reads by workspace, environment and address and never exposes the operator resolver", async () => {
    await deploy();
    expect(await runtime({ workspaceId: "other-workspace" }).resolveSecret(REF)).toBeUndefined();
    await expect(runtime({ environmentId: "other-environment" }).resolveSecret(REF)).rejects.toMatchObject({ reason: "denied" });
    await expect(runtime().resolveSecret(REF.replace("postgres/db", "postgres/other"))).rejects.toMatchObject({ reason: "denied" });
    await expect(runtime().resolveSecret(KEY_REF)).rejects.toMatchObject({ reason: "denied" });
    await expect(runtime().resolveSecret("vault:other-project/service/KEY")).rejects.toMatchObject({ reason: "denied" });
  });

  it("keeps dry run free of provider calls and vault writes", async () => {
    const write = vi.spyOn(FileSecretsAsync, "putIfAbsent");
    const ports = runtime();
    const report = await deploy(ports, true);
    expect(report.ok).toBe(true);
    expect(report.databases[0].status).toBe("planned");
    expect(neon.requests).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(await ports.resolveSecret(REF)).toBeUndefined();
  });

  it("preserves unconfigured-provider refusal without requiring a vault write", async () => {
    const ports = runtime({ substrate: { ...substrate(), database: undefined } });
    expect(ports.databases.availability()).toMatchObject({ available: false });
    expect(await ports.databases.create(spec())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(neon.requests).toEqual([]);
    expect(await ports.resolveSecret(REF)).toBeUndefined();
  });
});
