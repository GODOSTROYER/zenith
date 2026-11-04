/**
 * The non-declarative helpers: Key Vault secret sync, ACR source builds and
 * managed-certificate binding, against a fake Key Vault / ARM / blob endpoint.
 */
import { afterEach, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { bindManagedCertificate } from "@/lib/providers/azure/certificates";
import { AcrBuildError, assertUploadUrl, runAcrBuild, validateBuildInput, type AcrBuildInput } from "@/lib/providers/azure/acr-build";
import { describeSecretSyncError, MAX_SECRET_BYTES, SecretSyncError, syncSecretValue } from "@/lib/providers/azure/secrets";
import { kvSecretName } from "@/lib/providers/azure/drivers/identity/key-vault-secret";
import { fakeArm, fakeEntra, sessionFor, SUB, type ArmRoute, type FakeArm, type FakeEntra } from "./_helpers";

const open: FakeArm[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function setup(routes: ArmRoute[]) {
  const entra: FakeEntra = fakeEntra();
  const arm = await fakeArm(routes, entra);
  open.push(arm);
  const session = await sessionFor(arm, entra, "deploy");
  return { arm, entra, session };
}

const VAULT = "https://zn-k3x9q2-session-9619d9.vault.azure.net/";
const REF = "vault:ws_1/env_azure_1/SESSION_KEY";
const VALUE = "CANARY-super-secret-value-0123456789";

describe("syncSecretValue", () => {
  const versionId = "0123456789abcdef0123456789abcdef";
  const put = (c: { stored?: string; puts: string[] }): ArmRoute => ({
    method: "PUT",
    match: "/secrets/SESSION-KEY",
    handler: ({ body }) => {
      c.puts.push(body);
      c.stored = JSON.parse(body).value;
      return { status: 200, body: { id: `${VAULT}secrets/SESSION-KEY/${versionId}`, value: c.stored, attributes: { enabled: true } } };
    },
  });

  it("creates the secret when it does not exist, with the Key Vault token and data-plane api-version", async () => {
    const c = { puts: [] as string[], stored: undefined as string | undefined };
    const { arm, entra, session } = await setup([{ method: "GET", match: "/secrets/SESSION-KEY", status: 404, body: { error: { code: "SecretNotFound", message: "not found" } } }, put(c)]);
    const r = await syncSecretValue(session, { vaultUri: VAULT, secretRef: REF, value: VALUE, clientRequestId: "zenith-op_1-f7" });
    expect(r).toEqual({ status: "created", secretName: "SESSION-KEY", version: versionId, requestId: "req-fake-1" });
    expect(c.stored).toBe(VALUE);
    const [get, putReq] = arm.requests;
    expect(get.query.get("api-version")).toBe("7.4");
    expect(putReq.query.get("api-version")).toBe("7.4");
    expect(JSON.parse(putReq.body)).toMatchObject({ value: VALUE, contentType: "text/plain", attributes: { enabled: true }, tags: { "zenith:managed": "true" } });
    expect(entra.requests.map((q) => q.body.get("scope"))).toEqual(["https://vault.azure.net/.default"]);
    expect(putReq.authorization).toBe(`Bearer ${entra.tokens[0]}`);
  });

  it("does not write when the value is already current (idempotent: no new version per retry)", async () => {
    const c = { puts: [] as string[], stored: VALUE };
    const { arm, session } = await setup([{ method: "GET", match: "/secrets/SESSION-KEY", body: { id: `${VAULT}secrets/SESSION-KEY/${versionId}`, value: VALUE } }, put(c)]);
    const r = await syncSecretValue(session, { vaultUri: VAULT, secretRef: REF, value: VALUE });
    expect(r).toMatchObject({ status: "unchanged", version: versionId });
    expect(arm.requests.filter((q) => q.method === "PUT")).toHaveLength(0);
  });

  it("writes a new version when the value changed", async () => {
    const c = { puts: [] as string[], stored: "old" };
    const { session } = await setup([{ method: "GET", match: "/secrets/SESSION-KEY", body: { id: `${VAULT}secrets/SESSION-KEY/ffffffffffffffffffffffffffffffff`, value: "old" } }, put(c)]);
    expect(await syncSecretValue(session, { vaultUri: VAULT, secretRef: REF, value: VALUE })).toMatchObject({ status: "updated", version: versionId });
  });

  it("never leaks the value: not in the result, in an error, in the URL, or in a dump of either", async () => {
    const c = { puts: [] as string[], stored: undefined as string | undefined };
    const ok = await setup([{ method: "GET", match: "/secrets/SESSION-KEY", status: 404, body: { error: { code: "SecretNotFound", message: "nope" } } }, put(c)]);
    const r = await syncSecretValue(ok.session, { vaultUri: VAULT, secretRef: REF, value: VALUE });
    expect(JSON.stringify(r)).not.toContain(VALUE);
    for (const req of ok.arm.requests) expect(req.pathname + req.query.toString()).not.toContain(VALUE);

    // an error body that (hypothetically) echoes the request must not surface it
    const bad = await setup([{ match: () => true, status: 400, body: { error: { code: "BadParameter", message: `Bad value ${VALUE}` } } }]);
    const err = await syncSecretValue(bad.session, { vaultUri: VAULT, secretRef: REF, value: VALUE }).catch((e) => e);
    expect(err).toBeInstanceOf(SecretSyncError);
    expect(err.message).not.toContain(VALUE);
    expect(inspect(err, { depth: 5 })).not.toContain(VALUE);
    expect(describeSecretSyncError(err)).not.toContain(VALUE);
  });

  it("tells a firewall refusal from a missing role, throttling and an unreachable vault", async () => {
    const cases: [number, unknown, Record<string, string>, string][] = [
      [403, { error: { code: "ForbiddenByFirewall", message: "Client address is not authorized and caller is not a trusted service. Client address: 1.2.3.4" } }, {}, "forbidden_by_firewall"],
      [403, { error: { code: "Forbidden", message: "Client address is not authorized and caller is not a trusted service." } }, {}, "forbidden_by_firewall"],
      [403, { error: { code: "ForbiddenByRbac", message: "Caller is not authorized to perform action on resource." } }, {}, "forbidden_by_rbac"],
      [403, { error: { code: "Forbidden", message: "The user, group or application does not have secrets set permission on key vault. Caller is not authorized to perform action" } }, {}, "forbidden_by_rbac"],
      [429, { error: { code: "Throttled", message: "slow" } }, { "retry-after": "5" }, "throttled"],
      [503, { error: { code: "ServiceUnavailable", message: "down" } }, {}, "unreachable"],
      [409, { error: { code: "ObjectIsDeletedButRecoverable", message: "soft deleted" } }, {}, "conflict"],
      [400, { error: { code: "BadParameter", message: "x" } }, {}, "rejected"],
    ];
    for (const [status, body, headers, reason] of cases) {
      const { session } = await setup([{ match: () => true, status, body, headers }]);
      const err = await syncSecretValue(session, { vaultUri: VAULT, secretRef: REF, value: VALUE }).catch((e) => e);
      expect(err, reason).toBeInstanceOf(SecretSyncError);
      expect(err.reason).toBe(reason);
      if (reason === "throttled") expect(err.retryAfterSec).toBe(5);
    }
  });

  it("validates the vault, the name and the value before any request", async () => {
    const { arm, session } = await setup([{ match: () => true, body: {} }]);
    const bad: [Partial<Parameters<typeof syncSecretValue>[1]>][] = [
      [{ vaultUri: "https://evil.example/" }],
      [{ vaultUri: "http://zn.vault.azure.net/" }],
      [{ vaultUri: "https://zn.vault.azure.net/secrets/x?" }],
      [{ vaultUri: "https://a.b.vault.azure.net/" }],
      [{ vaultUri: "https://user@zn-vault.vault.azure.net/" }],
      [{ value: "" }],
      [{ value: "x".repeat(MAX_SECRET_BYTES + 1) }],
    ];
    for (const [patch] of bad) {
      await expect(syncSecretValue(session, { vaultUri: VAULT, secretRef: REF, value: VALUE, ...patch })).rejects.toMatchObject({ reason: "invalid_input" });
    }
    expect(arm.requests).toHaveLength(0);
    expect(kvSecretName(REF)).toBe("SESSION-KEY");
  });
});

describe("runAcrBuild", () => {
  const REGISTRY = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/znk3x9q2webacr`;
  const base = (over: Partial<AcrBuildInput> = {}): AcrBuildInput => ({ registryId: REGISTRY, loginServer: "znk3x9q2webacr.azurecr.io", repository: "web", source: new Uint8Array([31, 139, 8, 0, 1, 2, 3]), pollIntervalMs: 1, ...over });
  const uploadUrl = "https://znbuildstore.blob.core.windows.net/source/abc.tar.gz?sv=2021&sig=SIGNATURE&se=2026";

  function acrRoutes(statuses: string[], over: { uploadUrl?: string; scheduleStatus?: number } = {}) {
    let n = 0;
    const routes: ArmRoute[] = [
      { method: "POST", match: `${REGISTRY}/listBuildSourceUploadUrl`, body: { uploadUrl: over.uploadUrl ?? uploadUrl, relativePath: "source/abc.tar.gz" } },
      { method: "POST", match: `${REGISTRY}/scheduleRun`, status: over.scheduleStatus ?? 200, body: over.scheduleStatus && over.scheduleStatus >= 400 ? { error: { code: "Bad", message: "no" } } : { properties: { runId: "cb1" } } },
      { method: "GET", match: `${REGISTRY}/runs/cb1`, handler: () => ({ status: 200, body: { properties: { status: statuses[Math.min(n++, statuses.length - 1)], outputImages: [{ registry: "znk3x9q2webacr.azurecr.io", repository: "web", tag: "latest", digest: "sha256:abc123" }] } } }) },
    ];
    return routes;
  }

  it("uploads the archive WITHOUT a bearer token, schedules a push build in ACR and returns the pushed digest", async () => {
    const { arm, session } = await setup(acrRoutes(["Queued", "Running", "Succeeded"]));
    const uploads: { url: string; headers: Headers; bytes: number }[] = [];
    const uploadFetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      uploads.push({ url: String(u), headers: new Headers(init?.headers), bytes: (init?.body as Uint8Array).byteLength });
      return new Response("", { status: 201 });
    }) as typeof fetch;
    const r = await runAcrBuild(session, base({ uploadFetch, tags: ["v1"], dockerfilePath: "docker/Dockerfile" }));
    expect(r).toMatchObject({ runId: "cb1", status: "Succeeded", images: [{ image: "znk3x9q2webacr.azurecr.io/web:latest", digest: "sha256:abc123" }] });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toBe(uploadUrl);
    expect(uploads[0].headers.get("authorization")).toBeNull();
    expect(uploads[0].headers.get("x-ms-blob-type")).toBe("BlockBlob");
    expect(uploads[0].bytes).toBe(7);

    const schedule = arm.requests.find((q) => q.pathname.endsWith("/scheduleRun"))!;
    expect(schedule.query.get("api-version")).toBe("2019-06-01-preview");
    expect(JSON.parse(schedule.body)).toEqual({
      type: "DockerBuildRequest", imageNames: ["web:latest", "web:v1"], isPushEnabled: true, noCache: false, dockerFilePath: "docker/Dockerfile", platform: { os: "Linux", architecture: "amd64" }, sourceLocation: "source/abc.tar.gz", isArchiveEnabled: false, timeout: 3600,
    });
    // ARM calls carry the ARM bearer; the upload did not go through the session at all
    expect(arm.requests.every((q) => !q.pathname.includes("blob"))).toBe(true);
  });

  it("refuses an upload URL that is not a signed Azure blob URL, without uploading or sending a token there", async () => {
    for (const url of ["https://evil.example/upload?sig=x", "http://znbuildstore.blob.core.windows.net/s?sig=x", "https://znbuildstore.blob.core.windows.net/s", "https://znbuildstore.blob.core.windows.net.evil.example/s?sig=x", "https://user:pw@znbuildstore.blob.core.windows.net/s?sig=x", "https://znbuildstore.blob.core.windows.net:8443/s?sig=x", "nonsense"]) {
      const { session } = await setup(acrRoutes(["Succeeded"], { uploadUrl: url }));
      let uploaded = false;
      await expect(runAcrBuild(session, base({ uploadFetch: (async () => ((uploaded = true), new Response("", { status: 201 }))) as typeof fetch }))).rejects.toMatchObject({ reason: "upload_url_rejected" });
      expect(uploaded, url).toBe(false);
    }
    expect(() => assertUploadUrl(uploadUrl)).not.toThrow();
  });

  it("reports upload, schedule and build failures precisely", async () => {
    const a = await setup(acrRoutes(["Succeeded"]));
    await expect(runAcrBuild(a.session, base({ uploadFetch: (async () => new Response("", { status: 403 })) as typeof fetch }))).rejects.toMatchObject({ reason: "upload_failed" });
    const b = await setup(acrRoutes(["Succeeded"], { scheduleStatus: 400 }));
    await expect(runAcrBuild(b.session, base({ uploadFetch: (async () => new Response("", { status: 201 })) as typeof fetch }))).rejects.toMatchObject({ reason: "schedule_failed" });
    const c = await setup(acrRoutes(["Running", "Failed"]));
    await expect(runAcrBuild(c.session, base({ uploadFetch: (async () => new Response("", { status: 201 })) as typeof fetch }))).rejects.toMatchObject({ reason: "build_failed" });
    const d = await setup(acrRoutes(["Running"]));
    await expect(runAcrBuild(d.session, base({ timeoutMs: 20, uploadFetch: (async () => new Response("", { status: 201 })) as typeof fetch }))).rejects.toMatchObject({ reason: "timeout" });
  });

  it("validates the registry id, names and archive before any request", async () => {
    const { arm, session } = await setup(acrRoutes(["Succeeded"]));
    const bad: Partial<AcrBuildInput>[] = [
      { registryId: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Cache/redis/x` },
      { registryId: "/subscriptions/99999999-9999-9999-9999-999999999999/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/x" },
      { loginServer: "evil.example.com" },
      { repository: "Web" },
      { repository: "../etc" },
      { repository: "a/../b" },
      { tags: ["bad tag"] },
      { tags: ["-x"] },
      { dockerfilePath: "../Dockerfile" },
      { dockerfilePath: "/abs/Dockerfile" },
      { source: new Uint8Array(0) },
    ];
    for (const patch of bad) await expect(runAcrBuild(session, base(patch))).rejects.toBeInstanceOf(AcrBuildError);
    expect(arm.requests).toHaveLength(0);
    expect(() => validateBuildInput(base(), SUB)).not.toThrow();
  });
});

describe("bindManagedCertificate", () => {
  const ENV = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/cae`;
  const APP = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/web`;
  const tags = { "zenith:managed": "true", "zenith:environment": "env_azure_1", "zenith:resource": "container_service/web" };
  const expectTags = { environment: "env_azure_1", resource: "container_service/web" };
  const certId = `${ENV}/managedCertificates/c1`;

  function routes(over: { certState?: string; binding?: string; bound?: boolean; appTags?: Record<string, string>; domains?: unknown[] } = {}) {
    const patches: string[] = [];
    const list: ArmRoute[] = [
      { method: "GET", match: `${ENV}/managedCertificates`, body: { value: [{ id: certId, name: "c1", properties: { subjectName: "app.example.com", provisioningState: over.certState ?? "Succeeded" } }] } },
      {
        method: "GET",
        match: APP,
        body: {
          id: APP,
          location: "westeurope",
          tags: over.appTags ?? tags,
          properties: { configuration: { ingress: { customDomains: over.domains ?? [{ name: "app.example.com", bindingType: over.bound ? "SniEnabled" : "Disabled", ...(over.bound ? { certificateId: certId } : {}) }, { name: "other.example.com", bindingType: "SniEnabled", certificateId: `${ENV}/certificates/x` }] } } },
        },
      },
      { method: "PATCH", match: APP, handler: ({ body }) => (patches.push(body), { status: 200, body: {} }) },
    ];
    return { list, patches };
  }
  const input = { appId: APP, environmentId: ENV, domain: "app.example.com", expectTags };

  it("binds the issued certificate by sending the FULL domain list with only this entry changed", async () => {
    const { list, patches } = routes();
    const { session } = await setup(list);
    const r = await bindManagedCertificate(session, input);
    expect(r).toMatchObject({ status: "bound", certificateId: certId });
    expect(JSON.parse(patches[0])).toEqual({
      location: "westeurope",
      properties: { configuration: { ingress: { customDomains: [{ name: "app.example.com", bindingType: "SniEnabled", certificateId: certId }, { name: "other.example.com", bindingType: "SniEnabled", certificateId: `${ENV}/certificates/x` }] } } },
    });
  });

  it("is idempotent, and does nothing until the certificate is issued", async () => {
    const a = routes({ bound: true });
    expect(await bindManagedCertificate((await setup(a.list)).session, input)).toMatchObject({ status: "already_bound" });
    expect(a.patches).toHaveLength(0);
    const b = routes({ certState: "Pending" });
    expect(await bindManagedCertificate((await setup(b.list)).session, input)).toMatchObject({ status: "pending" });
    expect(b.patches).toHaveLength(0);
  });

  it("refuses an app that is not this environment's, a hostname not registered on the app, and bad ids", async () => {
    const a = routes({ appTags: { ...tags, "zenith:environment": "env_other" } });
    expect(await bindManagedCertificate((await setup(a.list)).session, input)).toMatchObject({ status: "refused", detail: expect.stringMatching(/Zenith tags/) });
    expect(a.patches).toHaveLength(0);
    const b = routes({ domains: [] });
    expect(await bindManagedCertificate((await setup(b.list)).session, input)).toMatchObject({ status: "refused", detail: expect.stringMatching(/not registered/) });
    const c = routes();
    const { session } = await setup(c.list);
    for (const patch of [{ domain: "not a domain" }, { domain: "x/../y" }, { appId: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Cache/redis/x` }, { environmentId: "/subscriptions/99999999-9999-9999-9999-999999999999/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/cae" }]) {
      expect(await bindManagedCertificate(session, { ...input, ...patch })).toMatchObject({ status: "refused" });
    }
    expect(c.patches).toHaveLength(0);
  });

  it("reports a missing certificate", async () => {
    const { session } = await setup([{ method: "GET", match: `${ENV}/managedCertificates`, body: { value: [] } }]);
    expect(await bindManagedCertificate(session, input)).toMatchObject({ status: "missing_certificate" });
  });
});
