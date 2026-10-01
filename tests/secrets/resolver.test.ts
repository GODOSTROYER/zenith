/** File store is real; PostgREST transport is mocked (no live database claim). */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSecretResolver, createConnectionSecretSink } from "@/lib/secrets/resolver";
import { putSecretAsync, readSecretValueAsync } from "@/lib/secrets";
import { FileSecretsAsync } from "@/lib/secrets/file-backend";
import { PostgresSecretsAsync } from "@/lib/secrets/pg-backend";
import { restAsync } from "@/lib/db/pg/sync-rest";

vi.mock("@/lib/db/pg/sync-rest", () => ({ restAsync: vi.fn(), restSync: vi.fn(), eq: (k: string, v: string) => `${k}=eq.${encodeURIComponent(v)}` }));
const CANARY = "SECRET-VALUE-canary-for-resolver-90210";
const scope = { workspaceId: "ws1", projectId: "proj1", environmentId: "env1", resourceAddresses: ["postgres/db", "redis/cache"] };
const password = "vault:generated/env1/postgres/db/password";
const uri = "vault:generated/env1/postgres/db/connection-uri";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "zenith-secret-resolver-"));
  vi.stubEnv("ZENITH_DATA", dir);
  vi.stubEnv("ZENITH_SECRET_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("ZENITH_STORE", "file");
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("activity vault resolver", () => {
  it("creates generated passwords once across concurrent resolver instances and keeps only sealed bytes", async () => {
    const values = await Promise.all(Array.from({ length: 30 }, () => createSecretResolver(scope)(password)));
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(await FileSecretsAsync.get("ws1", password)).toMatchObject({ version: 1 });
    expect(await createSecretResolver(scope)(password)).toBe(values[0]);
    expect(readFileSync(path.join(dir, "secrets.json"), "utf8")).not.toContain(values[0]);
  });
  it("resolves the current rotated value and refuses foreign workspaces by store scoping", async () => {
    await putSecretAsync("ws1", "vault:proj1/svc1/API_KEY", CANARY, "actor");
    expect(await createSecretResolver(scope)("vault:proj1/svc1/API_KEY")).toBe(CANARY);
    expect(await createSecretResolver({ ...scope, workspaceId: "foreign" })("vault:proj1/svc1/API_KEY")).toBeUndefined();
    await putSecretAsync("ws1", "vault:proj1/svc1/API_KEY", "rotated-value", "actor");
    expect(await createSecretResolver(scope)("vault:proj1/svc1/API_KEY")).toBe("rotated-value");
    expect(readFileSync(path.join(dir, "secrets.json"), "utf8")).not.toContain(CANARY);
  });
  it.each(["vault:generated/env2/postgres/db/password", "vault:generated/env1/postgres/foreign/password", "vault:proj2/svc1/API_KEY", "vault:generated/env1/../password", "vault:generated/env1/postgres/db/unknown", "vault:proj1/svc1/API_KEY/extra", "vault:../svc1/key", "vault:proj1%2Fsvc1/key/key"])("rejects an out-of-scope or malformed ref %s before reading", async (ref) => {
    const read = vi.spyOn(FileSecretsAsync, "get");
    await expect(createSecretResolver(scope)(ref)).rejects.toMatchObject({ reason: ref.includes("%") ? "invalid" : "denied" });
    expect(read).not.toHaveBeenCalled(); read.mockRestore();
  });
  it("narrows to the batch's exact references and keeps legacy references workspace-shared", async () => {
    await putSecretAsync("ws1", "vault:KEY", CANARY, "actor");
    expect(await createSecretResolver(scope)("vault:KEY")).toBe(CANARY);
    await expect(createSecretResolver({ ...scope, allowedRefs: [password] })("vault:KEY")).rejects.toMatchObject({ reason: "denied" });
  });
  it("does not invent a connection URI; sink stores it once and refuses replacement", async () => {
    const sink = createConnectionSecretSink(scope);
    expect(await createSecretResolver(scope)(uri)).toBeUndefined();
    expect(await sink.exists(uri)).toBe(false);
    await Promise.all(Array.from({ length: 10 }, () => sink.put(uri, CANARY)));
    expect(await sink.exists(uri)).toBe(true);
    expect(await createSecretResolver(scope)(uri)).toBe(CANARY);
    expect(await FileSecretsAsync.get("ws1", uri)).toMatchObject({ version: 1 });
    await expect(sink.put(uri, "different-uri")).rejects.toMatchObject({ reason: "conflict" });
    expect(await readSecretValueAsync("ws1", uri)).toBe(CANARY);
    await expect(sink.put(password, CANARY)).rejects.toMatchObject({ reason: "denied" });
  });
  it("sanitizes storage/key failures without causes or secret values", async () => {
    const read = vi.spyOn(FileSecretsAsync, "get").mockRejectedValue(new Error(CANARY));
    const error = await createSecretResolver(scope)(password).catch((e: unknown) => e as Error);
    expect(String(error)).not.toContain(CANARY);
    expect(error).not.toHaveProperty("cause"); read.mockRestore();
    vi.stubEnv("ZENITH_SECRET_KEY", "");
    await expect(createSecretResolver(scope)(password)).rejects.toMatchObject({ reason: "unreachable" });
  });
  it("Postgres insert-or-return ignores duplicates, scopes the follow-up and never sends plaintext", async () => {
    await putSecretAsync("ws1", password, CANARY, "actor");
    const record = (await FileSecretsAsync.get("ws1", password))!;
    const row = { workspace_id: "ws1", ref: password, version: 1, iv: record.iv, auth_tag: record.authTag, ciphertext: record.ciphertext, key_version: 1 };
    vi.mocked(restAsync).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] });
    const result = await PostgresSecretsAsync.putIfAbsent("ws1", record);
    expect(result.ciphertext).toBe(record.ciphertext);
    expect(vi.mocked(restAsync).mock.calls[0][0].prefer).toBe("resolution=ignore-duplicates,return=representation");
    expect(vi.mocked(restAsync).mock.calls[1][0].path).toContain("workspace_id=eq.ws1");
    expect(JSON.stringify(vi.mocked(restAsync).mock.calls)).not.toContain(CANARY);
  });
  it("creates the same password across independent Node processes sharing the file backend", async () => {
    const moduleUrl = pathToFileURL(path.resolve("src/lib/secrets/resolver.ts")).href;
    const script = `import { createSecretResolver } from ${JSON.stringify(moduleUrl)};
      import { createHmac } from 'node:crypto';
      const value = await createSecretResolver(${JSON.stringify(scope)})(${JSON.stringify(password)});
      process.stdout.write(createHmac('sha256', process.env.ZENITH_SECRET_KEY).update(value).digest('hex'));`;
    const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "ZENITH_STORE", "ZENITH_DATA", "ZENITH_SECRET_KEY"]) {
      if (process.env[key] !== undefined) childEnv[key] = process.env[key]!;
    }
    const run = promisify(execFile);
    const results = await Promise.all([1, 2].map(() => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: childEnv, encoding: "utf8", timeout: 10000, windowsHide: true })));
    expect(results[0].stdout).toMatch(/^[a-f0-9]{64}$/);
    expect(results[1].stdout).toBe(results[0].stdout);
    expect(await FileSecretsAsync.get("ws1", password)).toMatchObject({ version: 1 });
  });
});
