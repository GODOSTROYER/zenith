/**
 * PROD-MAN-01: the DEFAULT composition of the managed substrate.
 *
 * What is proven: the production composition root builds a working port from
 * `ZENITH_MANAGED_*` plus the control-plane tenant lookup plus the platform
 * credential vault scope, with no injected port, and that every caller the
 * requirement names (session opener, plan/apply, source build, release,
 * teardown) is wired to it in the real composition rather than in a test.
 *
 * CONTRACT-LEVEL: the product store and the vault reader are small doubles of
 * the SAME shape the composition uses in production; the Kubernetes session is
 * the real `createKubernetesSession` (it builds a session offline; no cluster
 * is contacted). Real-cluster proof is tests/providers/zenith/managed-kind.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProductNotFoundError } from "@/lib/execution/product-port";
import type { ProductContext, ProductPort } from "@/lib/execution/ports";
import {
  DEFAULT_PLATFORM_VAULT_SCOPE,
  createDefaultManagedSubstrate,
  createPlatformCredentialResolver,
  createProductTenantResolver,
  planTierOf,
  platformVaultScope,
} from "@/lib/platform/zenith-managed";
import { ManagedSubstrateError } from "@/lib/providers/zenith/managed-port";
import { FULL_ENV } from "../providers/zenith/support";

const root = path.resolve(__dirname, "../..");
const source = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

const WS = "ws-7f3a9c";
const ENVIRONMENT = "env-b12e04";

function product(over: { slug?: string; environmentId?: string; fail?: unknown } = {}): Pick<ProductPort, "loadContext"> {
  return {
    loadContext: async ({ workspaceId, environmentId }) => {
      if (over.fail) throw over.fail;
      return {
        workspace: { id: workspaceId, name: "Acme", slug: over.slug ?? "acme" },
        project: { id: "proj-1", name: "Shop", slug: "shop" },
        environment: { id: over.environmentId ?? environmentId, name: "production", class: "production", provider: "zenith", region: "zenith-managed", baseDomain: "x.test", connectionId: "c1", policies: {} },
      } as unknown as ProductContext;
    },
  };
}

/** The ManagedSubstrateError a promise rejects with; fails the test when it does not reject. */
async function refusalOf(promise: Promise<unknown>): Promise<ManagedSubstrateError> {
  try { await promise; } catch (e) { return e as ManagedSubstrateError; }
  throw new Error("expected a refusal");
}

/** A bearer-token-shaped value built at runtime (no credential-looking literal in the repository). */
const token = (): string => ["zt", "x".repeat(24)].join("-");

describe("platform credential scope", () => {
  it("defaults to the reserved platform scope and accepts an operator-chosen one", () => {
    expect(platformVaultScope({})).toBe(DEFAULT_PLATFORM_VAULT_SCOPE);
    expect(platformVaultScope({ ZENITH_MANAGED_VAULT_SCOPE: "zenith-prod-platform" })).toBe("zenith-prod-platform");
  });

  it("refuses a malformed scope by variable name", () => {
    expect(() => platformVaultScope({ ZENITH_MANAGED_VAULT_SCOPE: "has space" })).toThrowError(/ZENITH_MANAGED_VAULT_SCOPE/);
  });
});

describe("platform credential resolver", () => {
  it("reads only the platform scope", async () => {
    const calls: [string, string][] = [];
    const resolver = createPlatformCredentialResolver({ scope: "zenith-platform", read: async (scope, ref) => { calls.push([scope, ref]); return "value-1"; } });
    await expect(resolver.resolve("vault:zenith-managed/kubeconfig")).resolves.toBe("value-1");
    expect(calls).toEqual([["zenith-platform", "vault:zenith-managed/kubeconfig"]]);
  });

  it("refuses anything that is not a vault reference, without reading", async () => {
    let reads = 0;
    const resolver = createPlatformCredentialResolver({ scope: "s", read: async () => { reads++; return "v"; } });
    await expect(resolver.resolve("file:/etc/passwd")).rejects.toMatchObject({ code: "credential_unavailable" });
    await expect(resolver.resolve("plain-value")).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(reads).toBe(0);
  });

  it("answers a missing or unreadable credential with a fixed message that names no reference", async () => {
    const ref = "vault:zenith-managed/secret-name-xyz";
    const missing = createPlatformCredentialResolver({ scope: "s", read: async () => undefined });
    const broken = createPlatformCredentialResolver({ scope: "s", read: async () => { throw new Error(`disk failure while reading ${ref}`); } });
    for (const resolver of [missing, broken]) {
      const error = await refusalOf(resolver.resolve(ref));
      expect(error).toBeInstanceOf(ManagedSubstrateError);
      expect(error.code).toBe("credential_unavailable");
      expect(error.message).not.toContain("secret-name-xyz");
    }
  });
});

describe("tenants come from the control plane", () => {
  it("maps workspace slug, environment id and the default tier", async () => {
    const tenants = createProductTenantResolver(product());
    await expect(tenants.resolve({ workspaceId: WS, environmentId: ENVIRONMENT })).resolves.toEqual({
      workspaceId: WS, environmentId: ENVIRONMENT, workspaceSlug: "acme", environmentSlug: ENVIRONMENT, planTier: "free",
    });
    const pro = createProductTenantResolver(product(), { defaultPlanTier: "pro" });
    await expect(pro.resolve({ workspaceId: WS, environmentId: ENVIRONMENT })).resolves.toMatchObject({ planTier: "pro" });
  });

  it("an unknown workspace or environment is tenant_unresolved", async () => {
    const tenants = createProductTenantResolver(product({ fail: new ProductNotFoundError("environment_not_found", "no") }));
    await expect(tenants.resolve({ workspaceId: WS, environmentId: ENVIRONMENT })).rejects.toMatchObject({ code: "tenant_unresolved" });
    const other = createProductTenantResolver(product({ fail: new Error("db down") }));
    await expect(other.resolve({ workspaceId: WS, environmentId: ENVIRONMENT })).rejects.toMatchObject({ code: "tenant_unresolved" });
  });

  it("refuses a slug or environment id that cannot be a DNS label, rather than altering it", async () => {
    await expect(createProductTenantResolver(product({ slug: "Not A Slug" })).resolve({ workspaceId: WS, environmentId: ENVIRONMENT })).rejects.toMatchObject({ code: "tenant_invalid" });
    await expect(createProductTenantResolver(product()).resolve({ workspaceId: WS, environmentId: "Env_Upper" })).rejects.toMatchObject({ code: "tenant_invalid" });
  });

  it("refuses when the control plane returns another tenant", async () => {
    const tenants = createProductTenantResolver(product({ environmentId: "env-someone-else" }));
    await expect(tenants.resolve({ workspaceId: WS, environmentId: ENVIRONMENT })).rejects.toMatchObject({ code: "tenant_invalid" });
  });

  it("reads the default plan tier from the environment and refuses an unknown one", () => {
    expect(planTierOf({})).toBe("free");
    expect(planTierOf({ ZENITH_MANAGED_DEFAULT_PLAN: "starter" })).toBe("starter");
    expect(() => planTierOf({ ZENITH_MANAGED_DEFAULT_PLAN: "enterprise" })).toThrowError(/ZENITH_MANAGED_DEFAULT_PLAN/);
  });
});

describe("the default substrate", () => {
  it("is a port that refuses by variable name when nothing is configured (no throw at composition)", async () => {
    const managed = createDefaultManagedSubstrate({ env: {}, product: product() });
    expect(managed.id).toBe("zenith-managed");
    expect(managed.status().configured).toBe(false);
    await expect(managed.withSession({ workspaceId: WS, environmentId: ENVIRONMENT }, async () => 1)).rejects.toMatchObject({ code: "not_configured" });
    expect(managed.status().build.available).toBe(false);
  });

  it("an invalid plan tier degrades to unconfigured and names the variable", async () => {
    const managed = createDefaultManagedSubstrate({ env: { ...FULL_ENV, ZENITH_MANAGED_DEFAULT_PLAN: "enterprise" }, product: product() });
    expect(managed.status().configured).toBe(false);
    await expect(managed.openSession({ workspaceId: WS, environmentId: ENVIRONMENT })).rejects.toThrowError(/ZENITH_MANAGED_DEFAULT_PLAN|not configured/);
  });

  it("refuses shared operator credentials before reading secrets or opening a session", async () => {
    const reads: [string, string][] = [];
    const managed = createDefaultManagedSubstrate({
      env: { ...FULL_ENV, ZENITH_MANAGED_VAULT_SCOPE: "zenith-platform-test" }, product: product(),
      readPlatformSecret: async (scope, ref) => { reads.push([scope, ref]); return token(); },
    });
    await expect(managed.openSession({ workspaceId: WS, environmentId: ENVIRONMENT })).rejects.toThrow(/ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX/);
    expect(reads).toEqual([]);
  });

  it("refuses shared build execution even when a digest-pinned builder is configured", async () => {
    const managed = createDefaultManagedSubstrate({ env: { ...FULL_ENV, ZENITH_MANAGED_BUILDER_IMAGE: `registry.example.com/builder@sha256:${"a".repeat(64)}` }, product: product() });
    expect(managed.status().build).toMatchObject({ available: false, reason: expect.stringContaining("per-tenant build namespaces") });
    await expect(managed.withBuildSession({ workspaceId: WS, environmentId: ENVIRONMENT }, async () => "unsafe")).rejects.toMatchObject({ code: "build_unavailable" });
  });

  it("an incomplete per-tenant operator setup refuses without exposing its vault reference", async () => {
    const managed = createDefaultManagedSubstrate({ env: { ...FULL_ENV, ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:operators" }, product: product(),
      db: { query: async () => [] } as unknown as import("@/lib/controlplane/types").Sql, readPlatformSecret: async () => undefined });
    const error = await refusalOf(managed.openSession({ workspaceId: WS, environmentId: ENVIRONMENT }));
    expect(error).toBeInstanceOf(ManagedSubstrateError);
    expect(error.code).toBe("session_refused");
    expect(error.message).not.toContain("vault:");
  });
});

describe("the real composition wires every managed caller (no test-only port)", () => {
  const execution = source("src/lib/platform/execution.ts");

  it("composeExecutionActivities builds the default substrate and hands it to execution, release and source", () => {
    expect(execution).toContain("createDefaultManagedSubstrate({ product, db: opts.db })");
    expect(execution).toContain("product, managed, broker:");
    expect(execution).toContain("createReleasePorts({ db: opts.db, azure, managed })");
    expect(execution).toContain("zenithSources: createIsolatedSourceStore()");
  });

  it("plan, final plan, apply and teardown are routed to the managed paths by provider", () => {
    expect(source("src/lib/execution/plan.ts")).toContain("if (isDirectZenith(ec)) return planDirectZenith(rt, ec, lease);");
    expect(source("src/lib/execution/plan.ts")).toContain("if (isDirectZenith(ec)) return finalDirectZenith(rt, ec, lease, approvedPlanDigest);");
    expect(source("src/lib/execution/apply.ts")).toContain("if (isDirectZenith(ec)) return applyDirectZenith(rt, ec, lease, planDigest);");
    expect(source("src/lib/execution/destroy.ts")).toContain("ports.withZenithSession ??");
  });

  it("every step that asks for the environment's connection or session gets the managed one", () => {
    expect(source("src/lib/execution/context.ts")).toContain("if (isManagedEnvironment(ec)) return managedConnection(rt, ec);");
    expect(source("src/lib/execution/session.ts")).toContain("if (isManagedConnection(opts.connection))");
  });

  it("the release ports carry managed build, rollout and migration adapters only when a substrate is composed", () => {
    const release = source("src/lib/platform/release.ts");
    expect(release).toContain("createZenithBuildPort({ managed: options.managed })");
    expect(release).toContain("createZenithWorkloadsPort(options.managed)");
    expect(release).toContain("createZenithMigrationsPort()");
  });

  it("source preparation has a managed branch that needs the managed source hand-off", () => {
    const bundle = source("src/lib/platform/source-bundle.ts");
    expect(bundle).toContain('(ctx.provider === "zenith" ? deps.zenithSources! : deps.kubernetesSources!).upload(ctx, bundle)');
    expect(bundle).toContain("Zenith-managed builds are refused");
  });
});
