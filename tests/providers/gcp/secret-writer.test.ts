/** Fake authorized HTTP transport; no live Google call. */
import { describe, expect, it, vi } from "vitest";
import { writeGcpSecret } from "@/lib/providers/gcp/secret-writer";
import { gcpLabels } from "@/lib/providers/gcp/naming";
import type { GcpSession } from "@/lib/credentials/types";
const CANARY = "GCP-SECRET-canary-do-not-persist-42";
const id = "projects/project1/secrets/zenith-env1-key";
const node = { address: "secret/key", kind: "secret" as const, provider: "gcp" as const, region: "us-central1", nativeType: "gcp:secret_manager_secret", ownership: "managed" as const, spec: {}, dependsOn: [], origin: [], labels: {}, specDigest: "d" };
const tenant = { workspaceId: "ws1", projectId: "proj1", environmentId: "env1" };
const labels = gcpLabels({ "zenith:managed": "true", "zenith:workspace": "ws1", "zenith:environment": "env1", "zenith:resource": node.address });
function setup() {
  const fetch = vi.fn<GcpSession["authorizedFetch"]>();
  const session: GcpSession = { provider: "gcp", projectId: "project1", region: "us-central1", expiresAt: "2099-01-01", authorizedFetch: fetch, childProcessEnv: () => ({}) };
  fetch.mockResolvedValueOnce(Response.json({ name: id, labels }));
  return { fetch, session, input: { ...tenant, node, secretId: id, resolve: async () => CANARY } };
}
describe("GCP secret writer", () => {
  it("compares current content hashes and skips unchanged writes", async () => {
    const { fetch, session, input } = setup();
    fetch.mockResolvedValueOnce(Response.json({ name: `${id}/versions/12`, payload: { data: Buffer.from(CANARY).toString("base64") } }));
    expect(await writeGcpSecret(session, input)).toEqual({ changed: false, versionId: "12" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("writes a missing/rotated value with CRC32C and returns only validated metadata", async () => {
    for (const exists of [false, true]) {
      const { fetch, session, input } = setup();
      fetch.mockResolvedValueOnce(exists ? Response.json({ payload: { data: Buffer.from("old").toString("base64") } }) : new Response("", { status: 404 }));
      fetch.mockResolvedValueOnce(Response.json({ name: `${id}/versions/13` }));
      const result = await writeGcpSecret(session, input);
      expect(result).toEqual({ changed: true, versionId: "13" });
      const request = JSON.parse(fetch.mock.calls[2][1]!.body as string);
      expect(Buffer.from(request.payload.data, "base64").toString()).toBe(CANARY);
      expect(request.payload.dataCrc32c).toMatch(/^\d+$/);
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  });
  it.each([[403, "denied"], [429, "throttled"], [503, "unreachable"]])("classifies HTTP %s without reading/logging the error body", async (status, reason) => {
    const { fetch, session, input } = setup();
    fetch.mockResolvedValueOnce(new Response(CANARY, { status: status as number }));
    const error = await writeGcpSecret(session, input).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason }); expect(String(error)).not.toContain(CANARY);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("refuses foreign projects and workspace labels before resolving", async () => {
    const { fetch, session, input } = setup();
    await expect(writeGcpSecret(session, { ...input, secretId: id.replace("project1", "other") })).rejects.toMatchObject({ reason: "denied" });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockReset().mockResolvedValueOnce(Response.json({ name: id, labels: { ...labels, zenith_workspace: "foreign" } }));
    const resolve = vi.fn(input.resolve);
    await expect(writeGcpSecret(session, { ...input, resolve })).rejects.toMatchObject({ reason: "denied" });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("rejects corrupt responses and opaque version names without leaking them", async () => {
    const { fetch, session, input } = setup();
    fetch.mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(Response.json({ name: CANARY }));
    const error = await writeGcpSecret(session, input).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "unreachable" }); expect(String(error)).not.toContain(CANARY);
  });
});
