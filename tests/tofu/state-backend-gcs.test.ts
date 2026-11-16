/**
 * PROD-DUR-06: GCS generation adapter against a scripted in-memory server, reached only through a (fake) brokered session's
 * `authorizedFetch`. The server is a fake, so this is contract evidence, not proof against a live Google project.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gcsStoreFromSession } from "@/lib/tofu/state-backend-gcs";
import type { BackendConfig } from "@/lib/tofu/backend-config";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const V1 = Buffer.from('{"serial":1}'), V2 = Buffer.from('{"serial":2}');
const KEY = "zenith/ws/env/default.tfstate";
interface Seen { method: string; url: string; headers: Record<string, string>; body?: Buffer }
const reply = (status: number, body?: Buffer | object, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body), { status, headers });

function gcs(opts: { versioning?: boolean; lock?: boolean; kms?: string } = {}) {
  const versions: { gen: string; bytes: Buffer }[] = [{ gen: "100", bytes: V1 }, { gen: "200", bytes: V2 }];
  let counter = 200;
  const seen: Seen[] = [];
  const session = {
    authorizedFetch: async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const req: Seen = { method: init?.method ?? "GET", url, headers, body: init?.body ? Buffer.from(init.body as Uint8Array) : undefined };
      seen.push(req);
      const u = new URL(url);
      expect(u.hostname).toBe("storage.googleapis.com");
      expect(init?.redirect).toBe("error");
      const latest = () => versions[versions.length - 1];
      if (u.pathname === "/storage/v1/b/state-bucket") return reply(200, { versioning: { enabled: opts.versioning ?? true } });
      if (u.pathname === "/storage/v1/b/state-bucket/o") return reply(200, { items: [
        ...[...versions].reverse().map((v, i) => ({ name: KEY, generation: v.gen, size: String(v.bytes.length), ...(i === 0 ? {} : { timeDeleted: "2025-01-01T00:00:00Z" }) })),
        { name: `${KEY}.bak`, generation: "9", size: "1" }] });
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
        counter += 100; versions.push({ gen: String(counter), bytes: req.body! });
        return reply(200, { generation: String(counter) });
      }
      return reply(500, {});
    },
  };
  const backend: BackendConfig = { kind: "gcs", bucket: "state-bucket", prefix: "zenith/ws/env" };
  return { session, seen, versions, backend };
}
const noDelete = (seen: Seen[]) => expect(seen.filter(r => r.method === "DELETE")).toEqual([]);

describe("GCS generations through a brokered session", () => {
  it("probes versioning, encryption, lock and the current generation", async () => {
    const g = gcs({ kms: "projects/p/locations/l/keyRings/r/cryptoKeys/k" });
    expect(await gcsStoreFromSession(g.session, g.backend, KEY).probe()).toMatchObject({ versioning: "enabled", encryption: "sse_kms", lockObject: "absent", currentVersionId: "200", restoreReady: true });
    const off = gcs({ versioning: false });
    expect(await gcsStoreFromSession(off.session, off.backend, KEY).probe()).toMatchObject({ versioning: "disabled", restoreReady: false });
    const locked = gcs({ lock: true });
    expect(await gcsStoreFromSession(locked.session, locked.backend, KEY).probe()).toMatchObject({ lockObject: "present", restoreReady: false });
  });
  it("adds no credential of its own: authorization is exactly what the session's fetch applies", async () => {
    const g = gcs();
    const store = gcsStoreFromSession(g.session, g.backend, KEY);
    await store.probe(); await store.readCurrent(); await store.writeRestored(V1, { currentEtag: "200" });
    expect(g.seen.length).toBeGreaterThan(4);
    expect(g.seen.every(r => r.headers.authorization === undefined)).toBe(true);
    expect(g.seen.every(r => new URL(r.url).hostname === "storage.googleapis.com")).toBe(true);
  });
  it("lists only the exact object and restores as a new generation with ifGenerationMatch and readback", async () => {
    const g = gcs();
    const store = gcsStoreFromSession(g.session, g.backend, KEY);
    expect((await store.listVersions(10)).map(v => [v.versionId, v.isLatest])).toEqual([["200", true], ["100", false]]);
    const earlier = await store.readVersion("100"), current = await store.readCurrent();
    expect(earlier.sha256).toBe(sha(V1));
    expect(current).toMatchObject({ versionId: "200", etag: "200" });
    const written = await store.writeRestored(earlier.bytes, { currentEtag: current.etag! });
    const readback = await store.readCurrent();
    expect(readback.versionId).toBe(written.versionId);
    expect(readback.sha256).toBe(sha(V1));
    expect(g.versions.map(v => v.gen)).toEqual(["100", "200", written.versionId]);
    expect(new URL(g.seen.find(r => r.url.includes("/upload/"))!.url).searchParams.get("ifGenerationMatch")).toBe("200");
    noDelete(g.seen);
  });
  it("refuses a stale or malformed generation, keeps CMEK on write and never reads a malformed version", async () => {
    const g = gcs({ kms: "projects/p/locations/l/keyRings/r/cryptoKeys/k" });
    const store = gcsStoreFromSession(g.session, g.backend, KEY);
    await expect(store.writeRestored(V1, { currentEtag: "100" })).rejects.toMatchObject({ code: "state_changed" });
    await expect(store.writeRestored(V1, { currentEtag: "1;drop" })).rejects.toMatchObject({ code: "state_changed" });
    expect(g.versions).toHaveLength(2);
    await store.writeRestored(V1, { currentEtag: "200" });
    expect(new URL(g.seen.find(r => r.url.includes("/upload/"))!.url).searchParams.get("kmsKeyName")).toContain("cryptoKeys/k");
    const before = g.seen.length;
    await expect(store.readVersion("../x")).rejects.toMatchObject({ code: "version_unavailable" });
    expect(g.seen.length).toBe(before);
  });
  it("refuses a non-GCS backend and an invalid bucket name", () => {
    const g = gcs();
    expect(() => gcsStoreFromSession(g.session, { kind: "s3", bucket: "b" }, KEY)).toThrow();
    expect(() => gcsStoreFromSession(g.session, { kind: "gcs", bucket: "Evil/../x" }, KEY)).toThrow();
  });
});
