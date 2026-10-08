import { describe, expect, it } from "vitest";
import { zenithSemanticsArgs } from "@/lib/execution/semantics/zenith";
import { createManagedSubstrate, readManagedConfigs } from "@/lib/providers/zenith/managed-substrate";
import type { ResourceGraph } from "@/lib/resources/types";
import type { ProviderConnection } from "@/lib/credentials/types";
import { createKubernetesToolkit } from "@/lib/platform/kubernetes-toolkit";
import { FULL_ENV, NET, TENANT } from "../providers/zenith/support";

function setup() {
  let tenant = { ...TENANT };
  let serving = { verifiedDomains: ["www.customer.example"], retiredDomains: [] as string[] };
  const graph = { graphDigest: "graph-pinned", nodes: [NET], edges: [] } as unknown as ResourceGraph;
  const config = readManagedConfigs(FULL_ENV);
  const managed = createManagedSubstrate({ ...config, toolkit: createKubernetesToolkit(), tenants: { resolve: async () => tenant },
    createKubernetesSession: async () => { throw new Error("Semantics must not open credentials"); },
    resolvePlatformCredential: async () => { throw new Error("Semantics must not resolve secrets"); }, fetch: globalThis.fetch,
    servingInputs: async () => serving,
  });
  const connection = { id: "managed", config: { provider: "kubernetes", mode: "kubeconfig_ref", server: FULL_ENV.ZENITH_MANAGED_CLUSTER_SERVER!, credentialRef: FULL_ENV.ZENITH_MANAGED_KUBECONFIG_REF!, namespaces: [] } } as Pick<ProviderConnection, "id" | "config">;
  return { args: () => zenithSemanticsArgs(managed, TENANT, graph, connection, "plan-pinned"),
    tier: () => { tenant = { ...tenant, planTier: "pro" }; },
    retire: () => { serving = { verifiedDomains: [], retiredDomains: ["www.customer.example"] }; },
    revoke: () => { serving = { ...serving, retiredDomains: ["old.customer.example"] }; },
    substrate: () => { if (config.config.configured) config.config.substrate.isolation = { fqdnEngine: "none", platformFqdns: [], runtimeClass: "sandbox" }; },
  };
}

describe("managed declarative semantics", () => {
  it("binds a stable rendered declaration and explicit engine without opening credentials", async () => {
    const run = setup();
    const args = await run.args();
    expect(args).toEqual(await run.args());
    expect(args.engineVersion).toBe("zenith-managed-apply/Z1");
    expect(args.ws.configDigest).not.toBe("graph-pinned");
    expect(args.planDigest).toBe("plan-pinned");
  });
  it.each(["tier", "retire", "revoke", "substrate"] as const)("changes the reviewed configuration digest when %s changes with the same resource graph", async (change) => {
    const run = setup();
    const before = await run.args();
    run[change]();
    expect((await run.args()).ws.configDigest).not.toBe(before.ws.configDigest);
  });
});
