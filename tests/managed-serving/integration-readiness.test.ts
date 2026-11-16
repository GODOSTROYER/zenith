/**
 * PROD-MAN-02: integration readiness (configured is not operating), the access guard, route classification, the durable job
 * registration and the operator add-on manifests.
 */
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { platformAccess } from "@/app/api/platform/v1/_lib/bearer-paths";
import { managedRefusals } from "@/app/api/platform/v1/_lib/managed";
import { BrokerError } from "@/lib/capabilities/errors";
import type { ResolvedAccess, ResolvedScope } from "@/lib/capabilities/ports";
import { assertManagedProvider, requireManagedEnvironment } from "@/lib/managed-serving/access";
import { ManagedDomainError } from "@/lib/managed-serving/domain-service";
import { environmentServingStatus, managedIntegrationReadiness, registryProbe, wildcardDnsProbe } from "@/lib/managed-serving/readiness";
import { CRITICAL_JOBS, CRITICAL_JOB_NAMES, MAINTENANCE_JOBS, classifyJob } from "@/lib/platform/critical-jobs";
import { customDomainTlsNames, environmentTlsNames, platformTlsMetadata, renderEnvironmentTls } from "@/lib/providers/zenith/tls";
import { FakeTlsClient } from "../providers/zenith/tls-support";
import { FULL_ENV, TENANT, substrate } from "../providers/zenith/support";

const full = substrate({ ...FULL_ENV, ZENITH_MANAGED_HTTP_CLUSTER_ISSUER: "zenith-letsencrypt-http01", ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:zenith-managed/object-store-admin" });
const state = (list: Awaited<ReturnType<typeof managedIntegrationReadiness>>, id: string) => list.find((s) => s.id === id)!.state;

describe("integration readiness never reports operation without a probe that saw it", () => {
  it("is not_configured for everything when the platform is not configured", async () => {
    const list = await managedIntegrationReadiness(undefined);
    expect(list.map((s) => s.state)).toEqual(Array(list.length).fill("not_configured"));
    expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
  });

  it("is configured_unverified, not verified, when nothing probed it", async () => {
    const list = await managedIntegrationReadiness(full);
    expect(list.filter((s) => s.state === "verified")).toEqual([]);
    for (const id of ["cluster", "registry", "gateway", "dns", "tls", "secret_delivery", "object_storage", "managed_database", "custom_domains", "autoscaling"]) expect(state(list, id), id).toBe("configured_unverified");
  });

  it("names what is missing", async () => {
    const plain = await managedIntegrationReadiness(substrate({ ...FULL_ENV }));
    expect(state(plain, "custom_domains")).toBe("not_configured");
    expect(state(plain, "object_storage")).toBe("not_configured");
    expect(plain.find((s) => s.id === "object_storage")!.detail).toMatch(/IAM-admin credential/);
    const ingress = await managedIntegrationReadiness(substrate({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx" }));
    expect(state(ingress, "tls")).toBe("not_configured");
    const noRegistry = await managedIntegrationReadiness(substrate({ ...FULL_ENV, ZENITH_MANAGED_REGISTRY: "" }));
    expect(state(noRegistry, "registry")).toBe("not_configured");
  });

  it("marks an integration verified only from a passing probe, and failing from a failing one", async () => {
    const ok = await managedIntegrationReadiness(full, { registry: async () => ({ ok: true, detail: "x" }), wildcardDns: async () => ({ ok: true, detail: "y" }) });
    expect(state(ok, "registry")).toBe("verified");
    expect(state(ok, "dns")).toBe("verified");
    expect(state(ok, "cluster")).toBe("configured_unverified");
    const bad = await managedIntegrationReadiness(full, { registry: async () => ({ ok: false, detail: "no" }), wildcardDns: async () => ({ ok: false, detail: "no" }) });
    expect(state(bad, "registry")).toBe("failing");
    expect(state(bad, "dns")).toBe("failing");
  });

  describe("the probes", () => {
    const res = (status: number, headers: Record<string, string> = {}) => (async () => new Response(null, { status, headers })) as unknown as typeof fetch;

    it("recognizes a registry v2 API and nothing else", async () => {
      expect((await registryProbe(res(200, { "docker-distribution-api-version": "registry/2.0" }))!("registry.example.com")).ok).toBe(true);
      expect((await registryProbe(res(401, { "www-authenticate": "Bearer realm=x" }))!("registry.example.com")).ok).toBe(true);
      expect((await registryProbe(res(200))!("registry.example.com")).ok).toBe(false);
      expect((await registryProbe(res(404))!("registry.example.com")).ok).toBe(false);
      expect((await registryProbe(res(301, { location: "https://elsewhere" }))!("registry.example.com")).ok).toBe(false);
      expect((await registryProbe((async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:443"); }) as unknown as typeof fetch)!("registry.example.com"))).toEqual({ ok: false, detail: "the registry did not answer" });
    });

    it("probes only the operator's host over https", async () => {
      const seen: string[] = [];
      await registryProbe((async (url: string) => { seen.push(url); return new Response(null, { status: 401 }); }) as unknown as typeof fetch)!("registry.example.com:5000");
      expect(seen).toEqual(["https://registry.example.com:5000/v2/"]);
    });

    it("resolves the wildcard through the injected resolver", async () => {
      const names: string[] = [];
      const probe = wildcardDnsProbe(async (n) => { names.push(n); return ["203.0.113.5"]; })!;
      expect((await probe("apps.example.com")).ok).toBe(true);
      expect(names).toEqual(["zenith-probe.apps.example.com"]);
      expect((await wildcardDnsProbe(async () => [])!("apps.example.com")).ok).toBe(false);
      expect((await wildcardDnsProbe(async () => { throw new Error("ENOTFOUND"); })!("apps.example.com")).ok).toBe(false);
    });
  });

  describe("per-environment TLS and gateway status from the objects' own conditions", () => {
    const HOST = "shop.customer.com";
    const objects = renderEnvironmentTls(TENANT, full, { customDomains: [HOST] });
    const seed = (client: FakeTlsClient, status: Record<string, unknown>) => {
      for (const o of objects) client.put({ ...o, status: status[o.kind + (o.metadata.name === custom().certificate ? ":custom" : "")] ?? status[o.kind] } as never);
    };
    const custom = () => customDomainTlsNames(TENANT, HOST);
    const cond = (type: string, value: string) => ({ conditions: [{ type, status: value, reason: "Because" }] });

    it("reports ready only on Ready=True and Programmed=True", async () => {
      const client = new FakeTlsClient();
      seed(client, { Certificate: cond("Ready", "True"), Gateway: cond("Programmed", "True") });
      const status = await environmentServingStatus(client, TENANT, full, [HOST]);
      expect(status.map((s) => [s.object, s.state])).toEqual([["wildcard_certificate", "ready"], ["gateway", "ready"], ["custom_certificate", "ready"]]);
      expect(status[2].host).toBe(HOST);
    });

    it("separates not ready, missing and not yet reported", async () => {
      const client = new FakeTlsClient();
      seed(client, { Certificate: cond("Ready", "False"), Gateway: {} });
      const status = await environmentServingStatus(client, TENANT, full, [HOST, "gone.customer.com"]);
      expect(status.find((s) => s.object === "wildcard_certificate")).toMatchObject({ state: "not_ready", detail: expect.stringContaining("Ready=False") });
      expect(status.find((s) => s.object === "gateway")).toMatchObject({ state: "unknown" });
      expect(status.find((s) => s.host === "gone.customer.com")).toMatchObject({ state: "missing" });
    });

    it("never reads or returns a Secret, and is empty in ingress mode", async () => {
      const client = new FakeTlsClient();
      client.put({ apiVersion: "v1", kind: "Secret", metadata: platformTlsMetadata(TENANT, full, "Secret"), data: { "tls.key": "PRIVATE-KEY-CANARY" } });
      const status = await environmentServingStatus(client, TENANT, full);
      expect(JSON.stringify(status)).not.toContain("PRIVATE-KEY-CANARY");
      expect(status.every((s) => s.state === "missing")).toBe(true);
      expect(environmentTlsNames(TENANT, full).gateway).toBeTruthy();
      expect(await environmentServingStatus(client, TENANT, substrate({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx" }))).toEqual([]);
    });

    it("reports unknown, not a failure, when the objects cannot be read", async () => {
      const client = new FakeTlsClient();
      client.error = new Error("api down");
      const status = await environmentServingStatus(client, TENANT, full);
      expect(status.every((s) => s.state === "unknown")).toBe(true);
    });
  });
});

describe("who may change an environment's custom domains", () => {
  const principal = { kind: "user" as const, id: "u1", name: "U" };
  const deps = (access: ResolvedAccess, scope: ResolvedScope | null = { scope: { workspaceId: "ws_1", environmentId: "env_1" }, environment: { id: "env_1", class: "production", provider: "zenith", region: "r" } }) => ({
    roles: { resolve: async () => access },
    scopes: { resolve: async () => scope },
  });
  const ask = (access: ResolvedAccess, need: "member" | "admin", scope?: ResolvedScope | null, ids = { workspaceId: "ws_1", environmentId: "env_1" }) =>
    requireManagedEnvironment(deps(access, scope), principal, ids, need);

  it("lets any member read and only an admin change", async () => {
    await expect(ask({ role: "viewer" }, "member")).resolves.toMatchObject({ environmentId: "env_1", provider: "zenith", role: "viewer" });
    await expect(ask({ role: "editor" }, "admin")).rejects.toMatchObject({ code: "role_insufficient" });
    await expect(ask({ role: "viewer" }, "admin")).rejects.toMatchObject({ code: "role_insufficient" });
    await expect(ask({ role: "admin" }, "admin")).resolves.toMatchObject({ role: "admin" });
  });

  it("answers a non-member, a foreign environment, an unresolved environment and a bad id with the same not-found", async () => {
    const answers = await Promise.all([
      ask({ role: "none" }, "member").catch((e: BrokerError) => e),
      ask({ role: "admin" }, "member", null).catch((e: BrokerError) => e),
      ask({ role: "admin" }, "member", { scope: { workspaceId: "ws_1" } }).catch((e: BrokerError) => e),
      ask({ role: "admin" }, "member", undefined, { workspaceId: "ws_1", environmentId: "../x" }).catch((e: BrokerError) => e),
      ask({ role: "admin", allowedEnvironmentIds: ["env_2"] }, "member").catch((e: BrokerError) => e),
    ]);
    for (const a of answers) expect(a).toMatchObject({ code: "not_found" });
    expect(new Set(answers.map((a) => (a as BrokerError).message)).size).toBe(1);
  });

  it("honours an integration credential's environment restriction", async () => {
    await expect(ask({ role: "admin", allowedEnvironmentIds: ["env_1"] }, "member")).resolves.toBeDefined();
  });

  it("refuses an environment that is not on the managed platform, naming its provider", async () => {
    const aws = await ask({ role: "admin" }, "admin", { scope: { workspaceId: "ws_1", environmentId: "env_1" }, environment: { id: "env_1", class: "production", provider: "aws", region: "r" } });
    expect(() => assertManagedProvider(aws)).toThrow(/provider "aws"/);
    expect(() => assertManagedProvider({ ...aws, provider: "zenith" })).not.toThrow();
  });

  it("translates domain refusals into the platform's error shape and hides which claims exist", async () => {
    await expect(managedRefusals(async () => { throw new ManagedDomainError("not_found", "No such domain claim."); })).rejects.toMatchObject({ code: "not_found" });
    await expect(managedRefusals(async () => { throw new ManagedDomainError("unavailable", "That hostname is not available to claim."); })).rejects.toMatchObject({ code: "conflict" });
    await expect(managedRefusals(async () => { throw new ManagedDomainError("managed_suffix", "x"); })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(managedRefusals(async () => { throw new ManagedDomainError("challenge_expired", "x"); })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(managedRefusals(async () => { throw new Error("db password leaked here"); })).rejects.toThrow("db password leaked here");
  });
});

describe("route classification", () => {
  const A = "/api/platform/v1";
  it("reads accept a person or a human-bound credential; claiming, proving and revoking need the browser", () => {
    expect(platformAccess(`${A}/managed-services`, "GET")).toBe("bearer-capable");
    expect(platformAccess(`${A}/environments/env_1/domains`, "GET")).toBe("bearer-capable");
    expect(platformAccess(`${A}/environments/env_1/domains`, "POST")).toBe("browser-only");
    expect(platformAccess(`${A}/environments/env_1/domains/verify`, "POST")).toBe("browser-only");
    expect(platformAccess(`${A}/environments/env_1/domains/revoke`, "POST")).toBe("browser-only");
  });
  it("offers nothing else", () => {
    expect(platformAccess(`${A}/managed-services`, "POST")).toBeUndefined();
    expect(platformAccess(`${A}/environments/env_1/domains`, "DELETE")).toBeUndefined();
    expect(platformAccess(`${A}/environments/env_1/domains/verify`, "GET")).toBeUndefined();
    expect(platformAccess(`${A}/environments/env_1/domains/other`, "POST")).toBeUndefined();
    expect(platformAccess(`${A}/environments/../domains`, "GET")).toBeUndefined();
  });
});

describe("the durable job", () => {
  it("is a registered critical job, run by the maintenance schedule, durable-only like the custody jobs", () => {
    expect(CRITICAL_JOB_NAMES).toContain("managed-serving");
    expect(CRITICAL_JOBS["managed-serving"]).toMatchObject({ cadenceMs: 60_000, durableOnly: true });
    expect(Object.keys(MAINTENANCE_JOBS)).toContain("managed-serving");
    expect(classifyJob("managed-serving", null).state).toBe("never_run");
  });
});

describe("the custom-domains operator add-on", () => {
  const DIR = path.resolve(__dirname, "../../deploy/zenith-managed/custom-domains");
  const read = (f: string) => load(fs.readFileSync(path.join(DIR, f), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const gateway = read("10-gateway-acme-http01.yaml");
  const issuer = read("20-clusterissuer-http01.yaml");

  it("is a separate optional kustomization that does not change the base", () => {
    const k = read("kustomization.yaml");
    expect(k.resources).toEqual(["10-gateway-acme-http01.yaml", "20-clusterissuer-http01.yaml"]);
    const base = load(fs.readFileSync(path.join(DIR, "../kustomization.yaml"), "utf8")) as { resources: string[] };
    expect(base.resources).not.toContain("custom-domains");
  });

  it("carries the issuer name the substrate documents, uses ACME staging and is flagged as a placeholder", () => {
    expect(issuer.kind).toBe("ClusterIssuer");
    expect(issuer.metadata.name).toBe("zenith-letsencrypt-http01");
    expect(issuer.spec.acme.server).toMatch(/staging/);
    expect(issuer.metadata.annotations["zenith.dev/placeholder"]).toBe("true");
    expect(gateway.metadata.annotations["zenith.dev/placeholder"]).toBe("true");
    expect(fs.readFileSync(path.join(DIR, "20-clusterissuer-http01.yaml"), "utf8")).toMatch(/REPLACE/);
  });

  it("solves HTTP-01 through the ACME gateway's port-80 listener, which admits only same-namespace routes", () => {
    const parent = issuer.spec.acme.solvers[0].http01.gatewayHTTPRoute.parentRefs[0];
    expect(parent).toMatchObject({ kind: "Gateway", name: gateway.metadata.name, namespace: gateway.metadata.namespace, sectionName: "http" });
    const listener = gateway.spec.listeners.find((l: { name: string }) => l.name === parent.sectionName);
    expect(listener).toMatchObject({ protocol: "HTTP", port: 80, allowedRoutes: { namespaces: { from: "Same" }, kinds: [{ kind: "HTTPRoute" }] } });
    expect(gateway.spec.listeners).toHaveLength(1);
    expect(gateway.metadata.namespace).toBe(full.gateway.namespace);
    expect(gateway.spec.gatewayClassName).toBe(full.gateway.className);
  });

  it("holds no credential", () => {
    for (const f of fs.readdirSync(DIR)) {
      const text = fs.readFileSync(path.join(DIR, f), "utf8");
      expect(text, f).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
      expect(text, f).not.toMatch(/\b(eyJ[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{20,})\b/);
    }
  });
});
