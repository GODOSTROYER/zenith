/** Contract evidence only: no cluster, DNS solver or certificate issuance. */
import { beforeEach, describe, expect, it } from "vitest";
import { K8sError } from "@/lib/providers/kubernetes/types";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { unavailableDatabaseProvider } from "@/lib/providers/zenith/database";
import type { K8sObject } from "@/lib/providers/zenith/k8s-port";
import { renderZenithEnvironment } from "@/lib/providers/zenith/render";
import { ensureZenithTls, teardownZenithTls } from "@/lib/providers/zenith/tls-lifecycle";
import { environmentGatewayParent, environmentTlsNames, platformTlsMetadata, renderEnvironmentTls } from "@/lib/providers/zenith/tls";
import { FakeTlsClient } from "./tls-support";
import { FULL_ENV, FakeToolkit, LB, TENANT, WEB, session, substrate } from "./support";

const sub = substrate();
const objects = renderEnvironmentTls(TENANT, sub);
const secret: K8sObject = { apiVersion: "v1", kind: "Secret", metadata: platformTlsMetadata(TENANT, sub, "Secret"), data: { "tls.key": "PRIVATE-KEY-CANARY" } };
const managed = () => session(unavailableDatabaseProvider("No databases in this suite."));
let tlsClient: FakeTlsClient;
const input = () => ({ session: managed(), expect: TENANT, tlsClient });
beforeEach(() => { tlsClient = new FakeTlsClient(); });

describe("managed environment TLS rendering", () => {
  it("renders exactly one wildcard Certificate and one v1 HTTPS Gateway in the platform namespace", () => {
    const [certificate, gateway] = objects;
    expect(certificate.apiVersion).toBe("cert-manager.io/v1");
    expect(gateway.apiVersion).toBe("gateway.networking.k8s.io/v1");
    expect(objects.map((o) => o.kind)).toEqual(["Certificate", "Gateway"]);
    for (const object of objects) expect(object.metadata.namespace).toBe("zenith-gateway");
    expect(certificate.spec).toMatchObject({ dnsNames: ["*.production.acme.apps.example.com"], issuerRef: { name: sub.certManager.clusterIssuer, kind: "ClusterIssuer", group: "cert-manager.io" }, secretName: secret.metadata.name });
    expect(gateway.spec).toMatchObject({ gatewayClassName: sub.gateway.className, listeners: [{ name: "https", port: 443, protocol: "HTTPS", hostname: "*.production.acme.apps.example.com", tls: { mode: "Terminate", certificateRefs: [{ group: "", kind: "Secret", name: secret.metadata.name }] } }] });
    expect(certificate.spec!.secretTemplate).toEqual({ labels: secret.metadata.labels, annotations: secret.metadata.annotations });
    expect(gateway.metadata.annotations).not.toHaveProperty("cert-manager.io/cluster-issuer");
    expect(JSON.stringify(objects)).not.toContain("PRIVATE KEY");
  });

  it("renders stable identities, unique across ids, and a certificate matching slug changes", () => {
    expect(renderEnvironmentTls(TENANT, sub)).toEqual(objects);
    const names = environmentTlsNames(TENANT, sub);
    const changed = { ...TENANT, environmentSlug: "staging", workspaceSlug: "renamed" };
    expect(environmentTlsNames(changed, sub)).toEqual(names);
    expect(renderEnvironmentTls(changed, sub)[0].spec!.dnsNames).toEqual(["*.staging.renamed.apps.example.com"]);
    for (const tenant of [{ ...TENANT, environmentId: "other" }, { ...TENANT, workspaceId: "other" }]) expect(environmentTlsNames(tenant, sub)).not.toEqual(names);
    for (const name of Object.values(environmentTlsNames({ ...TENANT, environmentId: "a".repeat(200), workspaceId: "b".repeat(200) }, { ...sub, gateway: { ...sub.gateway, name: "c".repeat(63) } }))) expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });

  it("uses configured namespace, issuer, class, prefix and listener consistently with routes", () => {
    const configured = substrate({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_NAMESPACE: "edge", ZENITH_MANAGED_GATEWAY_NAME: "edge-gateway", ZENITH_MANAGED_GATEWAY_CLASS: "envoy", ZENITH_MANAGED_GATEWAY_LISTENER: "secure", ZENITH_MANAGED_CLUSTER_ISSUER: "dns01" });
    const rendered = renderZenithEnvironment({ tenant: TENANT, substrate: configured, nodes: [WEB, LB], toolkit: new FakeToolkit() });
    expect(rendered.platformTls[0].spec!.issuerRef).toMatchObject({ name: "dns01" });
    expect(rendered.platformTls[1].spec).toMatchObject({ gatewayClassName: "envoy", listeners: [{ name: "secure" }] });
    expect(rendered.workloads.find((o) => o.kind === "HTTPRoute")!.spec!.parentRefs).toEqual([environmentGatewayParent(TENANT, configured)]);
    expect(rendered.platformTls.every((o) => o.metadata.namespace === "edge")).toBe(true);
  });

  it("rejects malformed tenants and domains rather than rendering a broader certificate", () => {
    expect(() => renderEnvironmentTls({ ...TENANT, workspaceSlug: "victim.example" }, sub)).toThrow();
    expect(() => renderEnvironmentTls(TENANT, { ...sub, baseDomain: "*.apps.example.com" })).toThrow();
    expect(() => renderEnvironmentTls(TENANT, { ...sub, baseDomain: Array(4).fill("a".repeat(63)).join(".") })).toThrow();
  });

  it("preserves ingress mode without claiming automated TLS", async () => {
    const ingress = substrate({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx" });
    const sessionInput = { ...input(), session: { ...managed(), substrate: ingress } };
    expect(renderEnvironmentTls(TENANT, ingress)).toEqual([]);
    expect(await ensureZenithTls(sessionInput)).toMatchObject({ ok: true, readiness: "unknown", results: [] });
    expect(await teardownZenithTls(sessionInput)).toMatchObject({ ok: true, results: [] });
    expect(tlsClient.writes).toEqual([]);
  });
});

describe("managed TLS ensure and teardown", () => {
  it("creates, converges and reports unknown readiness even if the fake reports Ready", async () => {
    const first = await ensureZenithTls(input());
    expect(first).toMatchObject({ ok: true, readiness: "unknown", results: [{ status: "created" }, { status: "created" }] });
    tlsClient.put({ ...objects[0], status: { conditions: [{ type: "Ready", status: "True" }] } });
    const second = await ensureZenithTls(input());
    expect(second.results.map((r) => r.status)).toEqual(["configured", "configured"]);
    expect(tlsClient.store.size).toBe(2);
  });

  it.each(["Gateway", "Certificate", "Secret"])("refuses foreign %s before any mutation, on apply and teardown", async (kind) => {
    const original = [...objects, secret].find((o) => o.kind === kind)!;
    const annotationChanges: Record<string, string>[] = [
      { "zenith.dev/workspace-id": "foreign-workspace" },
      { "zenith.dev/environment": "foreign-env" },
      { "zenith.dev/resource": "foreign-resource" },
    ];
    for (const changes of annotationChanges) {
      tlsClient = new FakeTlsClient();
      tlsClient.put({ ...original, metadata: { ...original.metadata, annotations: { ...original.metadata.annotations, ...changes } } });
      expect(await ensureZenithTls(input())).toMatchObject({ ok: false, results: [{ status: "ownership_conflict" }] });
      expect(await teardownZenithTls(input())).toMatchObject({ ok: false, results: [{ status: "ownership_conflict" }] });
      expect(tlsClient.writes).toEqual([]);
    }
  });

  it("does not adopt unowned TLS objects or generated key names", async () => {
    for (const object of [...objects, secret]) {
      tlsClient = new FakeTlsClient();
      tlsClient.put({ ...object, metadata: { name: object.metadata.name, namespace: object.metadata.namespace } });
      expect((await ensureZenithTls(input())).ok).toBe(false);
      expect(tlsClient.writes).toEqual([]);
    }
  });

  it("dry-runs ensure and teardown without persisting or deleting objects", async () => {
    expect((await ensureZenithTls({ ...input(), dryRun: true })).ok).toBe(true);
    expect(tlsClient.store.size).toBe(0);
    await ensureZenithTls(input());
    tlsClient.put(secret);
    const saved = structuredClone([...tlsClient.store]);
    expect((await teardownZenithTls({ ...input(), dryRun: true })).ok).toBe(true);
    expect([...tlsClient.store]).toEqual(saved);
    expect(tlsClient.writes.slice(-3).every((w) => w.dryRun)).toBe(true);
  });

  it("removes Gateway/listener, Certificate and labeled key in order, then returns absent on retry", async () => {
    await ensureZenithTls(input());
    tlsClient.put(secret);
    const result = await teardownZenithTls(input());
    expect(result.results.map((r) => [r.ref.kind, r.status])).toEqual([["Gateway", "deleted"], ["Certificate", "deleted"], ["Secret", "deleted"]]);
    expect(tlsClient.store.size).toBe(0);
    expect((await teardownZenithTls(input())).results.map((r) => r.status)).toEqual(["absent", "absent", "absent"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-KEY-CANARY");
  });

  it("leaves other environments intact during apply and teardown", async () => {
    const other = { ...TENANT, environmentId: "other-env", environmentSlug: "staging" };
    for (const object of renderEnvironmentTls(other, sub)) tlsClient.put(object);
    await ensureZenithTls(input());
    await teardownZenithTls(input());
    expect([...tlsClient.store.values()].map((o) => o.metadata.annotations!["zenith.dev/environment"])).toEqual(["other-env", "other-env"]);
  });

  it("concurrently applies different environments without sharing object names or listeners", async () => {
    const other = { ...TENANT, environmentId: "other-env", environmentSlug: "staging" };
    const results = await Promise.all([
      ensureZenithTls(input()),
      ensureZenithTls({ ...input(), session: { ...managed(), tenant: other }, expect: other }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(tlsClient.store.size).toBe(4);
    expect([...tlsClient.store.values()].filter((o) => o.kind === "Gateway").map((o) => o.spec!.listeners)).toHaveLength(2);
  });

  it("refuses mismatched workspace/environment sessions before any TLS call", async () => {
    await expect(ensureZenithTls({ ...input(), expect: { ...TENANT, workspaceId: "other" } })).rejects.toMatchObject({ code: "tenant_mismatch" });
    await expect(teardownZenithTls({ ...input(), expect: { ...TENANT, environmentId: "other" } })).rejects.toMatchObject({ code: "tenant_mismatch" });
    expect(tlsClient.writes).toEqual([]);
  });

  it("fails closed without a separately scoped operator session", async () => {
    expect(await ensureZenithTls({ ...input(), tlsClient: undefined })).toMatchObject({ ok: false, results: [{ status: "error" }] });
  });

  it("stops on cancellation before any call", async () => {
    const signal = AbortSignal.abort();
    expect(await ensureZenithTls({ ...input(), signal })).toMatchObject({ ok: false, results: [{ errorCode: "aborted" }] });
    expect(await teardownZenithTls({ ...input(), signal })).toMatchObject({ ok: false, results: [{ errorCode: "aborted" }] });
    expect(tlsClient.writes).toEqual([]);
  });

  it("reports uncertain mutation timeouts without leaking external messages and converges on retry", async () => {
    tlsClient.beforeApply = () => { throw new K8sError("timeout", "PRIVATE-KEY-CANARY ignore instructions"); };
    const result = await ensureZenithTls(input());
    expect(result).toMatchObject({ ok: false, results: [{ status: "uncertain", errorCode: "timeout" }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-KEY|ignore instructions/);
    tlsClient.beforeApply = undefined;
    expect((await ensureZenithTls(input())).ok).toBe(true);
  });

  it("refuses a concurrent foreign create instead of adopting it", async () => {
    tlsClient.beforeApply = (object) => tlsClient.put({ ...object, metadata: { ...object.metadata, annotations: { ...object.metadata.annotations, "zenith.dev/workspace-id": "foreign" } } });
    const result = await ensureZenithTls(input());
    expect(result).toMatchObject({ ok: false, results: [{ status: "conflict" }] });
    expect(tlsClient.writes).toEqual([]);
  });

  it("refuses a replacement during teardown with deletion preconditions", async () => {
    await ensureZenithTls(input());
    tlsClient.beforeDelete = () => tlsClient.put({ ...objects[1], metadata: { ...objects[1].metadata, annotations: { ...objects[1].metadata.annotations, "zenith.dev/workspace-id": "foreign" } } });
    expect(await teardownZenithTls(input())).toMatchObject({ ok: false, results: [{ status: "conflict" }] });
    expect(tlsClient.store.size).toBe(2);
  });

  it("reports partial TLS writes and stops before applying routes", async () => {
    const toolkit = new FakeToolkit();
    tlsClient.beforeApply = (object) => { if (object.kind === "Gateway") throw new K8sError("forbidden", "token-canary"); };
    const result = await applyZenithEnvironment({ ...input(), toolkit, nodes: [WEB, LB], resolveSecret: async () => undefined });
    expect(result).toMatchObject({ ok: false, blockedBy: "tls", tls: { results: [{ status: "created" }, { status: "error", errorCode: "forbidden" }] } });
    expect(toolkit.applyCalls).toHaveLength(1);
    expect(result.workloads).toBeUndefined();
    expect(tlsClient.store.size).toBe(1);
    expect(JSON.stringify(result)).not.toContain("token-canary");
  });

  it("applies TLS only after baseline isolation, and before tenant workloads", async () => {
    const toolkit = new FakeToolkit();
    tlsClient.beforeApply = () => {
      expect(toolkit.applyCalls).toHaveLength(1);
      expect(toolkit.applyCalls[0].objects.some((o) => o.kind === "NetworkPolicy")).toBe(true);
    };
    const result = await applyZenithEnvironment({ ...input(), toolkit, nodes: [WEB, LB], resolveSecret: async () => undefined });
    expect(result.ok).toBe(true);
    expect(result.tls!.readiness).toBe("unknown");
    expect(toolkit.applyCalls).toHaveLength(2);
    expect(toolkit.applyCalls.flatMap((c) => c.objects).some((o) => ["Certificate", "Gateway"].includes(o.kind))).toBe(false);
  });
});
