/**
 * PROD-DUR-06: GCS, Azure Blob and OCI Object Storage restore adapters against scripted in-memory servers. Keys and tokens are
 * generated at run time. Request signatures are verified with the matching public key, so signing is exercised for real; the
 * servers themselves are fakes, so this is contract evidence, not proof against a live cloud account.
 */
import { createHash, createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BackendConfig } from "@/lib/tofu/backend-config";
import { AzureBlobStateStore, GcsStateStore, OciStateStore, gcsAssertion, ociSignedHeaders, openAzureStateStore, openGcsStateStore, openOciStateStore,
  parseAzureCredentials, parseGcsCredentials, parseOciCredentials, type Fetch } from "@/lib/tofu/state-backend-http";
import { openStateStore } from "@/lib/tofu/state-backend-open";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const V1 = Buffer.from('{"serial":1}'), V2 = Buffer.from('{"serial":2}');
interface Seen { method: string; url: string; headers: Record<string, string>; body?: Buffer }
const lowered = (h: HeadersInit | undefined): Record<string, string> => Object.fromEntries(Object.entries((h ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
const reply = (status: number, body?: Buffer | string | object, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : Buffer.isBuffer(body) ? new Uint8Array(body) : typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const bodyOf = (init?: RequestInit): Buffer | undefined => (init?.body ? Buffer.from(init.body as Uint8Array) : undefined);
function recorder(handler: (r: Seen) => Response) {
  const seen: Seen[] = [];
  const f: Fetch = async (url, init) => { const r: Seen = { method: init?.method ?? "GET", url, headers: lowered(init?.headers), body: bodyOf(init) }; seen.push(r); return handler(r); };
  return { f, seen };
}
const noDelete = (seen: Seen[]) => expect(seen.filter(r => r.method === "DELETE")).toEqual([]);

/* --------------------------------- GCS ------------------------------------ */
describe("GCS generations", () => {
  function gcs(opts: { versioning?: boolean; lock?: boolean; kms?: string } = {}) {
    const versions: { gen: string; bytes: Buffer }[] = [{ gen: "100", bytes: V1 }, { gen: "200", bytes: V2 }];
    const state = { versions, counter: 200 };
    const r = recorder(req => {
      const u = new URL(req.url);
      if (u.hostname === "oauth2.googleapis.com") return reply(200, { access_token: "token-value", expires_in: 3600 });
      expect(req.headers.authorization).toBe("Bearer token-value");
      expect(u.hostname).toBe("storage.googleapis.com");
      const latest = () => versions[versions.length - 1];
      if (u.pathname === "/storage/v1/b/state-bucket") return reply(200, { versioning: { enabled: opts.versioning ?? true } });
      if (u.pathname === "/storage/v1/b/state-bucket/o") return reply(200, { items: [
        ...[...versions].reverse().map((v, i) => ({ name: "zenith/ws/env/default.tfstate", generation: v.gen, size: String(v.bytes.length), ...(i === 0 ? {} : { timeDeleted: "2025-01-01T00:00:00Z" }) })),
        { name: "zenith/ws/env/default.tfstate.bak", generation: "9", size: "1" }] });
      if (u.pathname === "/storage/v1/b/state-bucket/o/zenith%2Fws%2Fenv%2Fdefault.tflock") return opts.lock ? reply(200, { generation: "5" }) : reply(404, { error: {} });
      if (u.pathname === "/storage/v1/b/state-bucket/o/zenith%2Fws%2Fenv%2Fdefault.tfstate") {
        if (u.searchParams.get("alt") === "media") {
          const gen = u.searchParams.get("generation") ?? latest().gen, v = versions.find(x => x.gen === gen);
          return v ? reply(200, v.bytes, { "x-goog-generation": v.gen }) : reply(404, {});
        }
        return reply(200, { generation: latest().gen, ...(opts.kms ? { kmsKeyName: opts.kms } : {}) });
      }
      if (u.pathname === "/upload/storage/v1/b/state-bucket/o") {
        if (u.searchParams.get("ifGenerationMatch") !== latest().gen) return reply(412, {});
        state.counter += 100; versions.push({ gen: String(state.counter), bytes: req.body! });
        return reply(200, { generation: String(state.counter) });
      }
      return reply(500, {});
    });
    const backend: BackendConfig = { kind: "gcs", bucket: "state-bucket", prefix: "zenith/ws/env" };
    const secret = JSON.stringify({ client_email: "restore@proj.iam.gserviceaccount.com", private_key: pem, token_uri: "https://evil.test/token", project_id: "p" });
    return { ...r, versions, backend, secret };
  }
  it("probes versioning, encryption, lock and the current generation", async () => {
    const g = gcs({ kms: "projects/p/locations/l/keyRings/r/cryptoKeys/k" });
    const store = await openGcsStateStore(g.backend, "zenith/ws/env/default.tfstate", g.secret, g.f);
    expect(await store.probe()).toMatchObject({ versioning: "enabled", encryption: "sse_kms", lockObject: "absent", currentVersionId: "200", restoreReady: true });
    expect(await (await openGcsStateStore(g.backend, "zenith/ws/env/default.tfstate", gcs({ versioning: false }).secret, gcs({ versioning: false }).f)).probe()).toMatchObject({ versioning: "disabled", restoreReady: false });
    const locked = gcs({ lock: true });
    expect(await (await openGcsStateStore(locked.backend, "zenith/ws/env/default.tfstate", locked.secret, locked.f)).probe()).toMatchObject({ lockObject: "present", restoreReady: false });
  });
  it("lists only the exact object and restores as a new generation with ifGenerationMatch and readback", async () => {
    const g = gcs();
    const store = await openGcsStateStore(g.backend, "zenith/ws/env/default.tfstate", g.secret, g.f);
    expect((await store.listVersions(10)).map(v => [v.versionId, v.isLatest])).toEqual([["200", true], ["100", false]]);
    const earlier = await store.readVersion("100"), current = await store.readCurrent();
    expect(earlier.sha256).toBe(sha(V1));
    expect(current).toMatchObject({ versionId: "200", etag: "200" });
    const written = await store.writeRestored(earlier.bytes, { currentEtag: current.etag! });
    const readback = await store.readCurrent();
    expect(readback.versionId).toBe(written.versionId);
    expect(readback.sha256).toBe(sha(V1));
    expect(g.versions.map(v => v.gen)).toEqual(["100", "200", written.versionId]);
    const upload = g.seen.find(r => r.url.includes("/upload/"))!;
    expect(new URL(upload.url).searchParams.get("ifGenerationMatch")).toBe("200");
    noDelete(g.seen);
  });
  it("refuses a stale generation, keeps CMEK on write, and never touches the network for a malformed one", async () => {
    const g = gcs({ kms: "projects/p/locations/l/keyRings/r/cryptoKeys/k" });
    const store = await openGcsStateStore(g.backend, "zenith/ws/env/default.tfstate", g.secret, g.f);
    await expect(store.writeRestored(V1, { currentEtag: "100" })).rejects.toMatchObject({ code: "state_changed" });
    await expect(store.writeRestored(V1, { currentEtag: "1;drop" })).rejects.toMatchObject({ code: "state_changed" });
    await store.writeRestored(V1, { currentEtag: "200" });
    expect(new URL(g.seen.find(r => r.url.includes("/upload/"))!.url).searchParams.get("kmsKeyName")).toContain("cryptoKeys/k");
    await expect(store.readVersion("../x")).rejects.toMatchObject({ code: "version_unavailable" });
  });
  it("exchanges an RS256 JWT at the fixed Google token endpoint, ignoring any token_uri in the key", async () => {
    const g = gcs();
    const store = await openGcsStateStore(g.backend, "zenith/ws/env/default.tfstate", g.secret, g.f);
    await store.probe();
    const token = g.seen.find(r => r.url.startsWith("https://oauth2.googleapis.com/token"))!;
    expect(g.seen.some(r => r.url.includes("evil.test"))).toBe(false);
    const assertion = decodeURIComponent(String(token.body ? Buffer.from(token.body).toString() : token.url).split("assertion=")[1]);
    const [head, claims, sig] = assertion.split(".");
    expect(createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(createPublicKey(pem), Buffer.from(sig, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({ iss: "restore@proj.iam.gserviceaccount.com", aud: "https://oauth2.googleapis.com/token" });
    expect(gcsAssertion(parseGcsCredentials(g.secret), 1000).split(".")).toHaveLength(3);
  });
  it("refuses unusable credentials", () => {
    for (const bad of ["x", "{}", JSON.stringify({ client_email: "a@evil.test", private_key: pem }), JSON.stringify({ client_email: "a@p.iam.gserviceaccount.com", private_key: "nope" })])
      expect(() => parseGcsCredentials(bad)).toThrow();
  });
});

/* -------------------------------- Azure Blob --------------------------------- */
describe("Azure blob versions", () => {
  function azure(opts: { versioned?: boolean; lease?: string } = {}) {
    const versions: { id: string; bytes: Buffer; etag: string }[] = [{ id: "2025-01-01T00:00:00.0000000Z", bytes: V1, etag: '"0x1"' }, { id: "2025-01-02T00:00:00.0000000Z", bytes: V2, etag: '"0x2"' }];
    let n = 2;
    const r = recorder(req => {
      const u = new URL(req.url);
      expect(u.hostname).toBe("acct.blob.core.windows.net");
      expect(u.searchParams.get("sig")).toBe("signature-value");
      expect(req.headers["x-ms-version"]).toBeTruthy();
      const latest = () => versions[versions.length - 1];
      if (u.pathname === "/state") {
        const items = [...versions].reverse().map((v, i) => `<Blob><Name>zenith/ws/env/terraform.tfstate</Name><VersionId>${v.id}</VersionId>${i === 0 ? "<IsCurrentVersion>true</IsCurrentVersion>" : ""}<Properties><Content-Length>${v.bytes.length}</Content-Length></Properties></Blob>`);
        return reply(200, `<EnumerationResults><Blobs>${items.join("")}<Blob><Name>zenith/ws/env/terraform.tfstate.old</Name><VersionId>zz</VersionId></Blob></Blobs><NextMarker /></EnumerationResults>`);
      }
      expect(u.pathname).toBe("/state/zenith/ws/env/terraform.tfstate");
      if (req.method === "HEAD") return reply(200, undefined, { etag: latest().etag, "x-ms-server-encrypted": "true", "x-ms-lease-state": opts.lease ?? "available", ...(opts.versioned === false ? {} : { "x-ms-version-id": latest().id }) });
      if (req.method === "PUT") {
        if (req.headers["if-match"] !== latest().etag || opts.lease === "leased") return reply(412, "precondition");
        n += 1; versions.push({ id: `2025-02-0${n}T00:00:00.0000000Z`, bytes: req.body!, etag: `"0x${n}"` });
        return reply(201, undefined, { "x-ms-version-id": versions[versions.length - 1].id, etag: versions[versions.length - 1].etag });
      }
      const v = u.searchParams.get("versionid") ? versions.find(x => x.id === u.searchParams.get("versionid")) : latest();
      return v ? reply(200, v.bytes, { etag: v.etag, "x-ms-version-id": v.id }) : reply(404, "missing");
    });
    const backend: BackendConfig = { kind: "azurerm", storageAccountName: "acct", containerName: "state" };
    return { ...r, versions, backend, secret: JSON.stringify({ sasToken: "?sv=2023-11-03&sp=rwl&sig=signature-value" }) };
  }
  it("probes versioning from the version id, encryption and the blob lease", async () => {
    const a = azure();
    expect(await (await openAzureStateStore(a.backend, "zenith/ws/env/terraform.tfstate", a.secret, a.f)).probe()).toMatchObject({ versioning: "enabled", encryption: "sse_s3", lockObject: "absent", restoreReady: true });
    const off = azure({ versioned: false });
    expect(await (await openAzureStateStore(off.backend, "zenith/ws/env/terraform.tfstate", off.secret, off.f)).probe()).toMatchObject({ versioning: "disabled", restoreReady: false });
    const leased = azure({ lease: "leased" });
    expect(await (await openAzureStateStore(leased.backend, "zenith/ws/env/terraform.tfstate", leased.secret, leased.f)).probe()).toMatchObject({ lockObject: "present", restoreReady: false });
  });
  it("lists the exact blob, restores a version with If-Match and reads it back", async () => {
    const a = azure();
    const store = await openAzureStateStore(a.backend, "zenith/ws/env/terraform.tfstate", a.secret, a.f);
    expect((await store.listVersions(10)).map(v => [v.versionId, v.isLatest])).toEqual([["2025-01-02T00:00:00.0000000Z", true], ["2025-01-01T00:00:00.0000000Z", false]]);
    const earlier = await store.readVersion("2025-01-01T00:00:00.0000000Z"), current = await store.readCurrent();
    const written = await store.writeRestored(earlier.bytes, { currentEtag: current.etag! });
    const readback = await store.readCurrent();
    expect(readback.versionId).toBe(written.versionId);
    expect(readback.sha256).toBe(sha(V1));
    expect(a.seen.find(r => r.method === "PUT")!.headers["if-match"]).toBe('"0x2"');
    noDelete(a.seen);
  });
  it("never bypasses a held lease and refuses a changed blob", async () => {
    const a = azure({ lease: "leased" });
    const store = await openAzureStateStore(a.backend, "zenith/ws/env/terraform.tfstate", a.secret, a.f);
    await expect(store.writeRestored(V1, { currentEtag: '"0x2"' })).rejects.toMatchObject({ code: "state_changed" });
    await expect(store.writeRestored(V1, { currentEtag: '"0x1"' })).rejects.toMatchObject({ code: "state_changed" });
    expect(a.versions).toHaveLength(2);
  });
  it("builds the host only from a validated account name and accepts only a SAS secret", async () => {
    const a = azure();
    await expect(openAzureStateStore({ kind: "azurerm", storageAccountName: "Evil.example.com/", containerName: "state" }, "k", a.secret, a.f)).rejects.toMatchObject({ code: "unsupported_backend" });
    for (const bad of ["x", "{}", JSON.stringify({ sasToken: "no-signature" }), JSON.stringify({ sasToken: "sig=a", accountKey: "k" }), JSON.stringify({ sasToken: "sig=a b" })])
      expect(() => parseAzureCredentials(bad)).toThrow();
    expect(parseAzureCredentials(a.secret).sas).toBe("sv=2023-11-03&sp=rwl&sig=signature-value");
  });
});

/* ----------------------------------- OCI ------------------------------------ */
describe("OCI object versions", () => {
  const tenancy = "ocid1.tenancy.oc1..aaaaaaaaexample1", user = "ocid1.user.oc1..aaaaaaaaexample2", fingerprint = "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99";
  const secret = JSON.stringify({ tenancyOcid: tenancy, userOcid: user, fingerprint, privateKeyPem: pem });
  const backend: BackendConfig = { kind: "s3", bucket: "state-bucket", region: "us-ashburn-1", endpoint: "https://myns.compat.objectstorage.us-ashburn-1.oraclecloud.com" };
  const KEY = "zenith/ws/env/terraform.tfstate";
  function verifySignature(req: Seen): void {
    const auth = req.headers.authorization, u = new URL(req.url);
    const m = /^Signature version="1",keyId="([^"]+)",algorithm="rsa-sha256",headers="([^"]+)",signature="([^"]+)"$/.exec(auth)!;
    expect(m[1]).toBe(`${tenancy}/${user}/${fingerprint}`);
    const lines = m[2].split(" ").map(name => name === "(request-target)" ? `(request-target): ${req.method.toLowerCase()} ${u.pathname}${u.search}`
      : name === "host" ? `host: ${u.host}` : name === "content-length" ? `content-length: ${req.body!.length}` : `${name}: ${req.headers[name]}`);
    expect(createVerify("RSA-SHA256").update(lines.join("\n")).verify(createPublicKey(pem), Buffer.from(m[3], "base64"))).toBe(true);
    if (req.method === "PUT") expect(req.headers["x-content-sha256"]).toBe(createHash("sha256").update(req.body!).digest("base64"));
  }
  function oci(opts: { versioning?: string; lock?: boolean } = {}) {
    const versions: { id: string; bytes: Buffer; etag: string; at: string }[] = [{ id: "ver1", bytes: V1, etag: "e1", at: "2025-01-01T00:00:00Z" }, { id: "ver2", bytes: V2, etag: "e2", at: "2025-01-02T00:00:00Z" }];
    let n = 2;
    const r = recorder(req => {
      verifySignature(req);
      const u = new URL(req.url);
      expect(u.host).toBe("objectstorage.us-ashburn-1.oraclecloud.com");
      const latest = () => versions[versions.length - 1];
      const base = "/n/myns/b/state-bucket";
      if (u.pathname === base) return reply(200, { versioning: opts.versioning ?? "Enabled" });
      if (u.pathname === `${base}/objectversions`) return reply(200, { items: [...versions].map(v => ({ name: KEY, versionId: v.id, timeCreated: v.at, size: v.bytes.length })).concat([{ name: `${KEY}.tflock`, versionId: "l", timeCreated: "2025-01-03T00:00:00Z", size: 1 }]) });
      if (u.pathname === `${base}/o/${encodeURIComponent(`${KEY}.tflock`)}`) return opts.lock ? reply(200, undefined, { etag: "l" }) : reply(404, {});
      expect(u.pathname).toBe(`${base}/o/${encodeURIComponent(KEY)}`);
      if (req.method === "HEAD") return reply(200, undefined, { etag: latest().etag, "version-id": latest().id });
      if (req.method === "PUT") {
        if (req.headers["if-match"] !== latest().etag) return reply(412, {});
        n += 1; versions.push({ id: `ver${n}`, bytes: req.body!, etag: `e${n}`, at: `2025-01-0${n}T00:00:00Z` });
        return reply(200, undefined, { etag: `e${n}`, "version-id": `ver${n}` });
      }
      const v = u.searchParams.get("versionId") ? versions.find(x => x.id === u.searchParams.get("versionId")) : latest();
      return v ? reply(200, v.bytes, { etag: v.etag, "version-id": v.id }) : reply(404, {});
    });
    return { ...r, versions };
  }
  it("signs every request with a verifiable rsa-sha256 HTTP signature", async () => {
    const o = oci();
    const store = await openOciStateStore(backend, KEY, secret, o.f);
    await store.probe(); await store.readCurrent(); await store.writeRestored(V1, { currentEtag: "e2" });
    expect(o.seen.length).toBeGreaterThan(4);
    expect(ociSignedHeaders(parseOciCredentials(secret), "GET", new URL("https://objectstorage.us-ashburn-1.oraclecloud.com/n/myns/b/x")).authorization).toContain("keyId=");
  });
  it("probes bucket versioning, the current version and the lock object", async () => {
    const o = oci();
    expect(await (await openOciStateStore(backend, KEY, secret, o.f)).probe()).toMatchObject({ versioning: "enabled", lockObject: "absent", currentVersionId: "ver2", restoreReady: true });
    const off = oci({ versioning: "Disabled" });
    expect(await (await openOciStateStore(backend, KEY, secret, off.f)).probe()).toMatchObject({ versioning: "disabled", restoreReady: false });
    const locked = oci({ lock: true });
    expect(await (await openOciStateStore(backend, KEY, secret, locked.f)).probe()).toMatchObject({ lockObject: "present", restoreReady: false });
  });
  it("restores an earlier version with If-Match, reads it back and never deletes", async () => {
    const o = oci();
    const store = await openOciStateStore(backend, KEY, secret, o.f);
    expect((await store.listVersions(10)).map(v => [v.versionId, v.isLatest])).toEqual([["ver2", true], ["ver1", false]]);
    const earlier = await store.readVersion("ver1"), current = await store.readCurrent();
    const written = await store.writeRestored(earlier.bytes, { currentEtag: current.etag! });
    expect((await store.readCurrent()).sha256).toBe(sha(V1));
    expect(written.versionId).toBe("ver3");
    await expect(store.writeRestored(V1, { currentEtag: "e1" })).rejects.toMatchObject({ code: "state_changed" });
    noDelete(o.seen);
  });
  it("derives the host from the validated OCI endpoint only and accepts only signing-key fields", async () => {
    await expect(openOciStateStore({ ...backend, endpoint: "https://evil.example.com" } as BackendConfig, KEY, secret)).rejects.toMatchObject({ code: "unsupported_backend" });
    for (const bad of ["x", "{}", JSON.stringify({ tenancyOcid: tenancy, userOcid: user, fingerprint: "nope", privateKeyPem: pem }), JSON.stringify({ tenancyOcid: tenancy, userOcid: user, fingerprint, privateKeyPem: pem, endpoint: "https://evil.test" })])
      expect(() => parseOciCredentials(bad)).toThrow();
  });
});

describe("dispatch", () => {
  it("selects an adapter per backend kind and refuses kinds without one", async () => {
    const gcsStore = await openStateStore({ kind: "gcs", bucket: "state-bucket", prefix: "p" }, "us-central1", "p/default.tfstate", JSON.stringify({ client_email: "a@p.iam.gserviceaccount.com", private_key: pem }));
    expect(gcsStore).toBeInstanceOf(GcsStateStore);
    expect(await openStateStore({ kind: "azurerm", storageAccountName: "acct", containerName: "state" }, "eastus", "k", JSON.stringify({ sasToken: "sig=a" }))).toBeInstanceOf(AzureBlobStateStore);
    expect(await openStateStore({ kind: "s3", bucket: "state-bucket", endpoint: "https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com" }, "us-ashburn-1", "k",
      JSON.stringify({ tenancyOcid: "ocid1.tenancy.oc1..aaaaaaaaexample1", userOcid: "ocid1.user.oc1..aaaaaaaaexample2", fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99", privateKeyPem: pem }))).toBeInstanceOf(OciStateStore);
    for (const kind of ["http", "local"] as const)
      await expect(openStateStore({ kind } as unknown as BackendConfig, "r", "k", "{}")).rejects.toMatchObject({ code: "unsupported_backend" });
  });
});
