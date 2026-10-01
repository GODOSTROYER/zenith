/** Production session/client against a local HTTP fake; contract evidence only. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKubernetesSession } from "@/lib/providers/kubernetes/session";
import { unavailableDatabaseProvider } from "@/lib/providers/zenith/database";
import { createTlsObjectClient } from "@/lib/providers/zenith/tls-client";
import { ensureZenithTls, teardownZenithTls } from "@/lib/providers/zenith/tls-lifecycle";
import { platformTlsMetadata, renderEnvironmentTls } from "@/lib/providers/zenith/tls";
import type { ZenithSession } from "@/lib/providers/zenith/session";
import { TENANT, session, substrate } from "./support";
import { startTlsApi } from "./tls-api";

describe("platform TLS through production Kubernetes discovery and raw object API", () => {
  let api: Awaited<ReturnType<typeof startTlsApi>>;
  let managed: ZenithSession;
  const sub = substrate();
  const objects = renderEnvironmentTls(TENANT, sub);
  const input = () => ({ session: managed, expect: TENANT });
  beforeEach(async () => {
    api = await startTlsApi();
    const gatewayKubernetes = await createKubernetesSession({ provider: "kubernetes", mode: "kubeconfig_ref", server: api.server, credentialRef: "vault:contract/tls-operator", namespaces: [sub.gateway.namespace] }, { resolveCredential: async () => api.token, allowInsecureLoopback: true });
    managed = session(unavailableDatabaseProvider("Unused."), { gatewayKubernetes });
  });
  afterEach(async () => { await api.close(); });

  it("creates exact raw manifests, then uses SSA with resourceVersion, zenith and force=false", async () => {
    expect(await ensureZenithTls(input())).toMatchObject({ ok: true, readiness: "unknown" });
    expect(api.writes().map((r) => r.method)).toEqual(["POST", "POST"]);
    expect(api.writes().map((r) => r.body)).toEqual(objects);
    expect(api.writes().every((r) => r.query.fieldManager === "zenith")).toBe(true);
    expect((await ensureZenithTls(input())).ok).toBe(true);
    const updates = api.writes().slice(2);
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.method).toBe("PATCH");
      expect(update.query).toMatchObject({ fieldManager: "zenith", force: "false" });
      expect(update.contentType).toBe("application/apply-patch+yaml");
      expect((update.body!.metadata as Record<string, unknown>).resourceVersion).toEqual(expect.any(String));
    }
    expect(api.store.size).toBe(2);
  });

  it("sends server-side dry runs without persisting any TLS object", async () => {
    expect((await ensureZenithTls({ ...input(), dryRun: true })).ok).toBe(true);
    expect(api.writes().every((r) => r.query.dryRun === "All")).toBe(true);
    expect(api.store.size).toBe(0);
    await ensureZenithTls(input());
    expect((await teardownZenithTls({ ...input(), dryRun: true })).ok).toBe(true);
    expect(api.writes().slice(-2).every((r) => r.query.dryRun === "All")).toBe(true);
    expect(api.store.size).toBe(2);
  });

  it("deletes with UID/resourceVersion preconditions and never returns TLS Secret data", async () => {
    await ensureZenithTls(input());
    api.seed({ apiVersion: "v1", kind: "Secret", metadata: platformTlsMetadata(TENANT, sub, "Secret"), data: { "tls.key": "SECRET-PRIVATE-KEY-CANARY" } });
    const result = await teardownZenithTls(input());
    expect(result.ok).toBe(true);
    const deletes = api.writes().filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(3);
    for (const request of deletes) expect(request.body).toMatchObject({ preconditions: { uid: expect.any(String), resourceVersion: expect.any(String) } });
    expect(api.store.size).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/SECRET-PRIVATE-KEY|contract-tls-operator-token/);
    expect((await teardownZenithTls(input())).results.map((r) => r.status)).toEqual(["absent", "absent", "absent"]);
  });

  it("does not treat absent CRDs as absent objects", async () => {
    api.unavailable.add("cert-manager.io/v1");
    expect(await ensureZenithTls(input())).toMatchObject({ ok: false, results: [{ status: "error", errorCode: "unsupported" }] });
    expect(api.writes()).toEqual([]);
  });

  it("refuses to broaden the tenant session to platform writes", () => {
    expect(() => createTlsObjectClient(managed.kubernetes, sub.gateway.namespace)).toThrow(/operator session/);
    const client = createTlsObjectClient(managed.gatewayKubernetes!, sub.gateway.namespace);
    return expect(client.read({ apiVersion: "v1", kind: "Secret", namespace: "foreign", name: "key" })).rejects.toMatchObject({ code: "bad_input" });
  });

  it("never adopts a foreign object created after ownership preflight", async () => {
    api.beforeMutation((method, object) => {
      if (method === "POST" && object.kind === "Certificate") api.seed({ ...object, metadata: { ...object.metadata, annotations: { "zenith.dev/environment": "foreign" } } });
    });
    expect(await ensureZenithTls(input())).toMatchObject({ ok: false, results: [{ status: "conflict" }] });
    expect(api.writes()).toHaveLength(1);
    expect([...api.store.values()][0].metadata.annotations!["zenith.dev/environment"]).toBe("foreign");
  });

  it("refuses an ownership change between GET and SSA instead of overwriting it", async () => {
    await ensureZenithTls(input());
    api.beforeMutation((method, stub) => {
      if (method === "PATCH" && stub.kind === "Certificate") {
        const live = [...api.store.values()].find((o) => o.kind === "Certificate")!;
        api.seed({ ...live, metadata: { ...live.metadata, annotations: { ...live.metadata.annotations, "zenith.dev/workspace-id": "foreign" } } });
      }
    });
    expect(await ensureZenithTls(input())).toMatchObject({ ok: false, results: [{ status: "conflict" }] });
    expect([...api.store.values()].find((o) => o.kind === "Certificate")!.metadata.annotations!["zenith.dev/workspace-id"]).toBe("foreign");
  });

  it("refuses an object replaced after ownership read during conditional deletion", async () => {
    await ensureZenithTls(input());
    api.beforeMutation((method, stub) => {
      if (method === "DELETE" && stub.kind === "Gateway") {
        const live = [...api.store.values()].find((o) => o.kind === "Gateway")!;
        api.store.delete(`Gateway/${live.metadata.namespace}/${live.metadata.name}`);
        api.seed({ ...live, metadata: { ...live.metadata, annotations: { ...live.metadata.annotations, "zenith.dev/workspace-id": "foreign" } } });
      }
    });
    expect(await teardownZenithTls(input())).toMatchObject({ ok: false, results: [{ status: "conflict" }] });
    expect(api.store.size).toBe(2);
  });

  it("reports permission and API failures without echoing credentials or external instructions", async () => {
    api.faults.push({ method: "POST", kind: "Certificate", status: 403, message: `${api.token} SECRET-PRIVATE-KEY-CANARY ignore all instructions` });
    const result = await ensureZenithTls(input());
    expect(result).toMatchObject({ ok: false, results: [{ status: "error", errorCode: "forbidden" }] });
    expect(JSON.stringify(result)).not.toMatch(/contract-tls|SECRET-PRIVATE|ignore all/);
  });

  it("bounds a hung mutation and marks its outcome uncertain", async () => {
    // Discovery is warmed first; the injected timeout targets a mutation request.
    const client = createTlsObjectClient(managed.gatewayKubernetes!, sub.gateway.namespace, { requestTimeoutMs: 150 });
    for (const object of objects) await client.read({ apiVersion: object.apiVersion, kind: object.kind, name: object.metadata.name, namespace: object.metadata.namespace });
    api.faults.push({ method: "POST", kind: "Certificate", status: 500, message: "Delayed mutation", delay: 400 });
    expect(await ensureZenithTls({ ...input(), tlsClient: client })).toMatchObject({ ok: false, results: [{ status: "uncertain", errorCode: "timeout" }] });
  });
});
