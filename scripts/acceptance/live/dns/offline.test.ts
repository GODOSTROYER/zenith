import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { Assertion, Packet, Permissions, planner } from "./contracts";
import { digest, Guard } from "./guard";
import { assertReadback, inventory, livePort, run, type Port } from "./runtime";
import { main } from "./cli";

function fixture() {
  const packet = Packet.parse({
    schema: "zenith.live-clouds.v1", provider: "azure", runId: "znlive-" + "a".repeat(16), commit: "b".repeat(40),
    account: "sandbox", region: "eastus", workspaceId: "ws", environmentIds: ["producer", "consumer"],
    apiOrigin: "https://control.example.test", estimatedUsd: 4, durationHours: 1, estimateBasis: "Provisional one-hour fixture plus teardown contingency",
    inventory: [{ url: "https://management.azure.com/subscriptions/sandbox/resources?api-version=2021-04-01", itemsPointer: "/value", idPointer: "/id", tagsPointer: "/tags", pagination: "azure" }],
    checks: [{ id: "azure-source-build", probes: [
      { kind: "control", path: "/api/platform/v1/operations/build", assertions: [{ pointer: "/operation/status", operator: "equals", expected: "succeeded" }] },
      { kind: "cloud", url: "https://management.azure.com/subscriptions/sandbox/build", assertions: [{ pointer: "/status", operator: "equals", expected: "Succeeded" }] },
    ] }],
  });
  const permissions = Permissions.parse({
    schema: "zenith.live-cloud-permissions.v1", approved: true, approvedBy: "arnav.bule05@gmail.com", expiresAt: "2099-01-01T00:00:00Z",
    packetSha256: digest(packet), maxUsd: 10, maxHours: 2, allowTeardownReview: true,
    cloudOrigins: ["https://management.azure.com"], cloudPathPrefixes: ["https://management.azure.com/subscriptions/sandbox"],
    trafficOrigins: ["https://app.example.test"], dnsSuffixes: ["example.test"], retainedResourceIds: [],
  });
  let resources = [{ id: "owned", tags: { zenith_live_run: packet.runId } }];
  const port: Port = {
    readCloud: vi.fn(async (url: string) => ({ body: url.includes("/resources") ? { value: resources } : { status: "Succeeded" } })),
    readControl: vi.fn(async () => ({ operation: { id: "build", environmentId: "producer", status: "succeeded" } })),
    teardown: vi.fn(async () => { resources = []; }),
    traffic: vi.fn(async (_url, nonce) => ({ nonce })),
    dns: vi.fn(async () => ["proof"]), tls: vi.fn(async () => undefined), sleep: vi.fn(async () => undefined),
  };
  return { packet, permissions, guard: new Guard(packet, permissions), port };
}

describe("offline planner and permissions, no live calls", () => {
  it("plans without any credentials and lists absent clauses", () => {
    const { packet } = fixture();
    const plan = planner(packet);
    expect(plan).toMatchObject({ mode: "plan", credentialReads: 0, networkCalls: 0, estimatedUsd: 4, teardown: ["consumer", "producer"] });
    expect(plan.missing).toContain("azure-sovereign");
  });
  it.each(["unknown", "oci-deletion"])("refuses unknown or wrong-provider check %s", (id) => {
    const { packet } = fixture(); packet.checks[0].id = id;
    expect(() => planner(packet)).toThrow();
  });
  it("rejects non-finite plan estimates before JSON can turn them into null", () => {
    const { packet } = fixture();
    expect(Packet.safeParse({ ...packet, estimatedUsd: Infinity }).success).toBe(false);
    expect(Packet.safeParse({ ...packet, estimatedUsd: NaN }).success).toBe(false);
  });
  it("requires accountable permission instead of an opt-in alone", () => {
    const { permissions } = fixture();
    expect(Permissions.safeParse({ ...permissions, approved: false }).success).toBe(false);
    expect(Permissions.safeParse({ ...permissions, approvedBy: "agent" }).success).toBe(false);
  });
  it.each(["expired", "budget", "hours", "binding", "nan", "unbounded-budget", "unbounded-duration"])("refuses %s before any call", (reason) => {
    const f = fixture();
    if (reason === "expired") f.permissions.expiresAt = "2000-01-01T00:00:00Z";
    if (reason === "budget") f.permissions.maxUsd = 3;
    if (reason === "hours") f.permissions.maxHours = 0.5;
    if (reason === "binding") f.packet.environmentIds.push("foreign");
    if (reason === "nan") f.packet.estimatedUsd = NaN;
    if (reason === "unbounded-budget") f.permissions.maxUsd = Infinity;
    if (reason === "unbounded-duration") f.permissions.maxHours = Infinity;
    expect(() => new Guard(f.packet, f.permissions)).toThrow();
    expect(f.port.readCloud).not.toHaveBeenCalled();
  });
  it.each([
    "http://management.azure.com/subscriptions/sandbox/resources",
    "https://management.azure.com.evil.test/subscriptions/sandbox/resources",
    "https://user:password@management.azure.com/subscriptions/sandbox/resources",
    "https://management.azure.com/subscriptions/sandbox-foreign/resources",
    "https://management.azure.com/subscriptions/other/resources",
    "https://management.azure.com:8443/subscriptions/sandbox/resources",
  ])("refuses URL %s", (url) => expect(() => fixture().guard.url(url, "cloud")).toThrow());
  it("refuses approval endpoints and foreign DNS/control-plane scopes", () => {
    const { guard } = fixture();
    expect(() => guard.url("https://control.example.test/api/platform/v1/operations/x/approve", "control")).toThrow();
    expect(() => guard.url("https://control.example.test/api/platform/v1/environments/foreign/teardown-review", "control")).toThrow();
    expect(() => guard.dns("example.test.evil.test")).toThrow();
  });
  it("rechecks expiration for later calls", () => {
    const f = fixture(); let now = 0;
    const guard = new Guard(f.packet, f.permissions, () => now);
    now = Date.parse(f.permissions.expiresAt);
    expect(() => guard.url(f.packet.inventory[0].url, "cloud")).toThrow();
  });
  it("CLI --plan reads no credential files even when their paths do not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-clouds-"));
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      writeFileSync(join(dir, "packet.json"), JSON.stringify(fixture().packet));
      const result = await main("azure", ["--plan", "--packet", join(dir, "packet.json")], { ZENITH_LIVE_AZURE: "1", ZENITH_LIVE_AZURE_CREDENTIAL_FILE: join(dir, "missing") });
      expect(result).toBe(0);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"credentialReads": 0'));
    } finally { output.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("missing opt-in reports NOT RUN instead of a pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-clouds-"));
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      writeFileSync(join(dir, "packet.json"), JSON.stringify(fixture().packet));
      expect(await main("azure", ["--packet", join(dir, "packet.json")], {})).toBe(3);
      expect(output).toHaveBeenCalledWith(expect.stringContaining("NOT RUN"));
    } finally { output.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("offline readback, teardown and evidence contracts", () => {
  it("does not confuse missing/null/false or prototype properties", () => {
    expect(() => assertReadback({}, [{ pointer: "/missing", operator: "equals", expected: false }])).toThrow();
    expect(() => assertReadback({ missing: null }, [{ pointer: "/missing", operator: "absent" }])).toThrow();
    expect(() => assertReadback({}, [{ pointer: "/toString", operator: "nonempty" }])).toThrow();
    expect(() => assertReadback({ "a/b": false }, [{ pointer: "/a~1b", operator: "equals", expected: false }])).not.toThrow();
  });
  it("accepts explicit null receipt IDs, refuses absence and numeric overflow", () => {
    const assertion = Assertion.parse({ pointer: "/resourceId", operator: "equals", expected: null });
    expect(() => assertReadback({ resourceId: null }, [assertion])).not.toThrow();
    expect(() => assertReadback({}, [assertion])).toThrow();
    expect(() => assertReadback({ resourceId: Infinity }, [assertion])).toThrow();
    expect(Assertion.safeParse({ pointer: "/cost", operator: "equals", expected: Infinity }).success).toBe(false);
  });
  it("attempts reverse dependency cleanup and an independent scan after success", async () => {
    const f = fixture(); const result = await run(f.packet, f.guard, f.port);
    expect(result.result).toBe("passed_checks");
    expect(result.cleanup).toEqual({ attempted: 2, succeeded: 2, leakScan: "empty" });
    expect(vi.mocked(f.port.teardown).mock.calls.map(([id]) => id)).toEqual(["consumer", "producer"]);
  });
  it("still tears down and scans after a failed scenario; arbitrary errors cannot leak", async () => {
    const f = fixture(), secret = randomBytes(32).toString("hex");
    f.port.readControl = vi.fn(async () => { throw new Error(secret); });
    const result = await run(f.packet, f.guard, f.port);
    expect(result.result).toBe("failed");
    expect(result.cleanup.leakScan).toBe("empty");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("accessTokenFile");
  });
  it("failed consumer cleanup blocks destructive producer cleanup and still scans", async () => {
    const f = fixture(); f.port.teardown = vi.fn(async () => { throw new Error("unavailable"); });
    const result = await run(f.packet, f.guard, f.port);
    expect(result.result).toBe("incomplete");
    expect(result.cleanup).toEqual({ attempted: 1, succeeded: 0, leakScan: "leaks" });
    expect(f.port.teardown).toHaveBeenCalledTimes(1);
  });
  it("foreign resources are retained and refuse teardown", async () => {
    const f = fixture(); f.port.readCloud = vi.fn(async () => ({ body: { value: [{ id: "foreign", tags: { zenith_live_run: "different" } }] } }));
    const result = await run(f.packet, f.guard, f.port);
    expect(result.result).toBe("failed");
    expect(result.cleanup.leakScan).toBe("leaks");
    expect(f.port.teardown).not.toHaveBeenCalled();
  });
  it("unreadable inventory stays unknown and never permits destructive cleanup", async () => {
    const f = fixture(); f.port.readCloud = vi.fn(async () => { throw new Error("denied"); });
    expect((await run(f.packet, f.guard, f.port)).cleanup.leakScan).toBe("unknown");
    expect(f.port.teardown).not.toHaveBeenCalled();
  });
  it("an operation status alone cannot count as positive live acceptance", async () => {
    const f = fixture(); f.packet.checks[0].probes = f.packet.checks[0].probes.filter((p) => p.kind === "control");
    f.permissions.packetSha256 = digest(f.packet);
    const result = await run(f.packet, f.guard, f.port);
    expect(result.checks[0].status).toBe("incomplete");
    expect(result.result).toBe("incomplete");
  });
  it("a mismatched operation ID is rejected despite a successful status", async () => {
    const f = fixture(); f.port.readControl = vi.fn(async () => ({ operation: { id: "other", environmentId: "producer", status: "succeeded" } }));
    expect((await run(f.packet, f.guard, f.port)).checks[0].status).toBe("failed");
  });
  it("an unused sovereign permission origin cannot turn public reads into sovereign proof", async () => {
    const f = fixture(); f.packet.checks[0].id = "azure-sovereign";
    f.permissions.cloudOrigins.push("https://management.usgovcloudapi.net"); f.permissions.packetSha256 = digest(f.packet);
    const result = await run(f.packet, f.guard, f.port);
    expect(result.checks[0].status).toBe("incomplete");
    expect(f.port.readControl).not.toHaveBeenCalled();
  });
  it("sovereign data-plane reads alone do not establish the required ARM endpoint", async () => {
    const f = fixture(); f.packet.checks[0].id = "azure-sovereign";
    const cloud = f.packet.checks[0].probes.find((p) => p.kind === "cloud")!;
    if (cloud.kind !== "cloud") throw new Error("fixture needs a cloud probe");
    cloud.url = "https://sandbox.vault.usgovcloudapi.net/secrets";
    f.permissions.cloudOrigins.push("https://sandbox.vault.usgovcloudapi.net");
    f.permissions.cloudPathPrefixes.push(cloud.url); f.permissions.packetSha256 = digest(f.packet);
    expect((await run(f.packet, f.guard, f.port)).checks[0].status).toBe("incomplete");
    expect(f.port.readControl).not.toHaveBeenCalled();
  });
  it("cancellation still enters teardown and scans", async () => {
    const f = fixture(); const result = await run(f.packet, f.guard, f.port, false, () => true);
    expect(result.result).toBe("failed");
    expect(result.cleanup).toEqual({ attempted: 2, succeeded: 2, leakScan: "empty" });
  });
  it("cleanup-only reuses the same identity and never repeats scenarios", async () => {
    const f = fixture(); const result = await run(f.packet, f.guard, f.port, true);
    expect(result.checks).toEqual([]);
    expect(f.port.readControl).not.toHaveBeenCalled();
    expect(result.cleanup.succeeded).toBe(2);
  });
  it("drains inventory pages, including untagged foreign resources", async () => {
    const f = fixture();
    const url = f.packet.inventory[0].url + "&page=2";
    f.port.readCloud = vi.fn().mockResolvedValueOnce({ body: { value: [{ id: "owned", tags: { zenith_live_run: f.packet.runId } }], nextLink: url } })
      .mockResolvedValueOnce({ body: { value: [{ id: "foreign", tags: {} }] } });
    expect(await inventory(f.port, f.packet.inventory[0], f.guard)).toEqual([{ id: "owned", owned: true }, { id: "foreign", owned: false }]);
    expect(f.port.readCloud).toHaveBeenCalledTimes(2);
  });
  it("redirected inventory cursors are rejected before the next call", async () => {
    const f = fixture(); f.port.readCloud = vi.fn(async () => ({ body: { value: [], nextLink: "https://evil.test/resources" } }));
    await expect(inventory(f.port, f.packet.inventory[0], f.guard)).rejects.toThrow();
    expect(f.port.readCloud).toHaveBeenCalledTimes(1);
  });
  it("repeating cursors, duplicate resources and absent lists are not empty inventories", async () => {
    const f = fixture();
    f.port.readCloud = vi.fn(async () => ({ body: { value: [], nextLink: f.packet.inventory[0].url } }));
    await expect(inventory(f.port, f.packet.inventory[0], f.guard)).rejects.toThrow();
    f.port.readCloud = vi.fn(async () => ({ body: { value: [{ id: "x", tags: {} }, { id: "x", tags: {} }] } }));
    await expect(inventory(f.port, f.packet.inventory[0], f.guard)).rejects.toThrow();
    f.port.readCloud = vi.fn(async () => ({ body: {} }));
    await expect(inventory(f.port, f.packet.inventory[0], f.guard)).rejects.toThrow();
  });
  it.each(["gcp", "oci"] as const)("drains %s service tokens without treating first-page emptiness as proof", async (provider) => {
    const f = fixture();
    f.packet.provider = provider; f.packet.region = "region-1";
    const origin = provider === "gcp" ? "https://compute.googleapis.com" : "https://iaas.region-1.oraclecloud.com";
    f.permissions.cloudOrigins = [origin]; f.permissions.cloudPathPrefixes = [origin + "/resources"];
    const descriptor = { ...f.packet.inventory[0], url: origin + "/resources", pagination: provider };
    f.permissions.packetSha256 = digest(f.packet);
    f.port.readCloud = vi.fn().mockResolvedValueOnce({ body: { value: [], ...(provider === "gcp" ? { nextPageToken: "second" } : {}) }, ...(provider === "oci" ? { nextPage: "second" } : {}) })
      .mockResolvedValueOnce({ body: { value: [{ id: "leak", tags: {} }] } });
    const found = await inventory(f.port, descriptor, f.guard);
    expect(found).toEqual([{ id: "leak", owned: false }]);
    expect(f.port.readCloud).toHaveBeenLastCalledWith(origin + `/resources?${provider === "gcp" ? "pageToken" : "page"}=second`);
  });
  it("signs OCI read-only requests with an ephemeral proof-of-possession key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-clouds-"));
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const secret = randomBytes(32).toString("base64url");
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } }));
    try {
      const f = fixture(); f.packet.provider = "oci"; f.packet.region = "region-1";
      const url = "https://iaas.region-1.oraclecloud.com/resources?compartmentId=sandbox";
      f.permissions.cloudOrigins = [new URL(url).origin]; f.permissions.cloudPathPrefixes = [new URL(url).origin + "/resources"];
      f.permissions.packetSha256 = digest(f.packet);
      writeFileSync(join(dir, "rpst"), secret); writeFileSync(join(dir, "api"), randomBytes(32).toString("hex"));
      writeFileSync(join(dir, "key"), privateKey.export({ format: "pem", type: "pkcs8" }));
      writeFileSync(join(dir, "credentials"), JSON.stringify({ provider: "oci", account: "sandbox", region: "region-1", securityTokenFile: join(dir, "rpst"), privateKeyFile: join(dir, "key") }));
      await livePort(f.guard, join(dir, "credentials"), join(dir, "api"), () => undefined).readCloud(url);
      const init = network.mock.calls[0][1]!;
      const headers = init.headers as Record<string, string>;
      expect(init.redirect).toBe("error");
      const signature = /signature="([^"]+)"/.exec(headers.authorization)![1];
      expect(verify("RSA-SHA256", Buffer.from(`date: ${headers.date}\n(request-target): get /resources?compartmentId=sandbox\nhost: iaas.region-1.oraclecloud.com`), publicKey, Buffer.from(signature, "base64"))).toBe(true);
    } finally { network.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("Azure uses origin-specific tokens and reads real Blob XML without persisting raw content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-clouds-")), secret = randomBytes(32).toString("hex");
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`<EnumerationResults>${secret}</EnumerationResults>`, { headers: { "content-type": "application/xml" } }));
    try {
      const f = fixture(), origin = "https://sandbox.blob.core.windows.net";
      f.permissions.cloudOrigins.push(origin); f.permissions.cloudPathPrefixes.push(origin + "/owned"); f.permissions.packetSha256 = digest(f.packet);
      writeFileSync(join(dir, "token"), randomBytes(32).toString("hex")); writeFileSync(join(dir, "api"), randomBytes(32).toString("hex"));
      writeFileSync(join(dir, "credentials"), JSON.stringify({ provider: "azure", account: "sandbox", region: "eastus", tokenFiles: { [origin]: join(dir, "token") } }));
      const port = livePort(f.guard, join(dir, "credentials"), join(dir, "api"), () => undefined);
      const result = await port.readCloud(origin + "/owned?restype=container&comp=list");
      expect(result.body).toMatchObject({ httpStatus: 200 });
      expect(JSON.stringify(result)).not.toContain(secret);
      await expect(port.readCloud(f.packet.inventory[0].url)).rejects.toThrow("No audience-specific");
      expect(network).toHaveBeenCalledTimes(1);
    } finally { network.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("DNS child inventory requires a tagged parent and the same live endpoint values", async () => {
    const f = fixture();
    const descriptor = { ...f.packet.inventory[0], parentOwnership: {
      url: "https://management.azure.com/subscriptions/sandbox/endpoint", tagsPointer: "/tags", targetValuesPointer: "/addresses", itemValuesPointer: "/values",
    } };
    let address = "192.0.2.10";
    f.port.readCloud = vi.fn(async (url) => ({ body: url.includes("/endpoint")
      ? { tags: { zenith_live_run: f.packet.runId }, addresses: ["192.0.2.10"] }
      : { value: [{ id: "record", values: [address] }] } }));
    expect(await inventory(f.port, descriptor, f.guard)).toEqual([{ id: "record", owned: true }]);
    address = "192.0.2.11";
    expect(await inventory(f.port, descriptor, f.guard)).toEqual([{ id: "record", owned: false }]);
  });
  it.each([
    ["compute#instanceList", "/items"], ["storage#objects", "/items"], ["storage#buckets", "/items"],
    ["dns#resourceRecordSetsListResponse", "/rrsets"], ["dns#managedZonesListResponse", "/managedZones"],
  ])("GCP only accepts missing items for the explicitly documented %s list", async (kind, itemsPointer) => {
    const f = fixture(); f.packet.provider = "gcp";
    const descriptor = { ...f.packet.inventory[0], url: "https://compute.googleapis.com/resources", pagination: "gcp" as const, itemsPointer, emptyListKind: kind };
    expect(Packet.safeParse({ ...f.packet, inventory: [descriptor] }).success).toBe(true);
    f.permissions.cloudOrigins = ["https://compute.googleapis.com"]; f.permissions.cloudPathPrefixes = ["https://compute.googleapis.com/resources"]; f.permissions.packetSha256 = digest(f.packet);
    f.port.readCloud = vi.fn(async () => ({ body: { kind } }));
    expect(await inventory(f.port, descriptor, f.guard)).toEqual([]);
    f.port.readCloud = vi.fn(async () => ({ body: { kind, [itemsPointer.slice(1)]: [{ id: "leak", tags: { zenith_live_run: f.packet.runId } }] } }));
    expect(await inventory(f.port, descriptor, f.guard)).toEqual([{ id: "leak", owned: true }]);
    const badDescriptor = { ...descriptor, itemsPointer: "/typo" };
    expect(Packet.safeParse({ ...f.packet, inventory: [badDescriptor] }).success).toBe(false);
    await expect(inventory(f.port, badDescriptor, f.guard)).rejects.toThrow();
    f.port.readCloud = vi.fn(async () => ({ body: { kind: "wrong" } }));
    await expect(inventory(f.port, descriptor, f.guard)).rejects.toThrow();
  });
  it.each([["fields", "kind"], ["delimiter", "/"], ["returnPartialSuccess", "true"]])("refuses inventory %s parameters before any request", async (parameter, value) => {
    const f = fixture(); f.packet.provider = "gcp";
    const descriptor = { ...f.packet.inventory[0], url: `https://compute.googleapis.com/resources?${parameter}=${encodeURIComponent(value)}`, pagination: "gcp" as const, itemsPointer: "/items", emptyListKind: "compute#instanceList" };
    f.permissions.cloudOrigins = ["https://compute.googleapis.com"]; f.permissions.cloudPathPrefixes = ["https://compute.googleapis.com/resources"]; f.permissions.packetSha256 = digest(f.packet);
    f.port.readCloud = vi.fn(async () => ({ body: { kind: "compute#instanceList" } }));
    expect(Packet.safeParse({ ...f.packet, inventory: [descriptor] }).success).toBe(false);
    await expect(inventory(f.port, descriptor, f.guard)).rejects.toThrow();
    expect(f.port.readCloud).not.toHaveBeenCalled();
  });
  it("refuses a partial bucket listing with unreachable resources", async () => {
    const f = fixture(); f.packet.provider = "gcp";
    const descriptor = { ...f.packet.inventory[0], url: "https://compute.googleapis.com/resources", pagination: "gcp" as const, itemsPointer: "/items", emptyListKind: "storage#buckets" };
    f.permissions.cloudOrigins = ["https://compute.googleapis.com"]; f.permissions.cloudPathPrefixes = ["https://compute.googleapis.com/resources"]; f.permissions.packetSha256 = digest(f.packet);
    f.port.readCloud = vi.fn(async () => ({ body: { kind: "storage#buckets", unreachable: ["owned-bucket"] } }));
    await expect(inventory(f.port, descriptor, f.guard)).rejects.toThrow();
  });
  it("refuses Storage prefixes that conceal objects from a leak scan", async () => {
    const f = fixture(); f.packet.provider = "gcp";
    const descriptor = { ...f.packet.inventory[0], url: "https://storage.googleapis.com/resources", pagination: "gcp" as const, itemsPointer: "/items", emptyListKind: "storage#objects" };
    expect(Packet.safeParse({ ...f.packet, inventory: [descriptor] }).success).toBe(true);
    f.permissions.cloudOrigins = ["https://storage.googleapis.com"]; f.permissions.cloudPathPrefixes = ["https://storage.googleapis.com/resources"]; f.permissions.packetSha256 = digest(f.packet);
    f.port.readCloud = vi.fn(async () => ({ body: { kind: "storage#objects", prefixes: ["owned/"] } }));
    await expect(inventory(f.port, descriptor, f.guard)).rejects.toThrow();
  });
});
