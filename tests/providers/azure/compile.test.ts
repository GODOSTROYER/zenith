import { describe, expect, it } from "vitest";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { cloudName, scopedName, tfLabel, azureTags, hash6 } from "@/lib/providers/azure/naming";
import { exportName, exportRef } from "@/lib/providers/azure/exports";
import { compileAll, compileContext, graphOf, mkNode, sampleGraph } from "./_helpers";

const driverFor = (n: { nativeType: string }) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType);

function allFragments() {
  const nodes = sampleGraph();
  return { nodes, frags: compileAll(nodes, driverFor) };
}

describe("compile: structure, determinism, tags", () => {
  it("compiles every node of a typical graph and every claimed address is defined exactly once", () => {
    const { nodes, frags } = allFragments();
    expect([...frags.keys()].sort()).toEqual(nodes.map((n) => n.address).sort());
    const claimed = new Set<string>();
    for (const [, f] of frags) {
      const defined = new Set<string>();
      for (const [t, named] of Object.entries(f.resource ?? {})) for (const n of Object.keys(named)) defined.add(`${t}.${n}`);
      for (const [t, named] of Object.entries(f.data ?? {})) for (const n of Object.keys(named)) defined.add(`data.${t}.${n}`);
      expect([...f.addresses].sort()).toEqual([...defined].sort());
      for (const a of f.addresses) {
        expect(claimed.has(a), `duplicate address ${a}`).toBe(false);
        claimed.add(a);
      }
    }
  });

  it("is deterministic: compiling twice gives byte-identical JSON", () => {
    const a = JSON.stringify([...allFragments().frags.entries()]);
    const b = JSON.stringify([...allFragments().frags.entries()]);
    expect(a).toBe(b);
  });

  it("assembles into a pinned azure workspace whose digest does not depend on fragment order", () => {
    const { nodes, frags } = allFragments();
    const input = {
      graph: graphOf(nodes),
      providerSet: "azure" as const,
      region: "westeurope",
      backend: { kind: "local" as const, path: "/tmp/state.tfstate" },
      tags: { "zenith:workspace": "ws_1" },
      providerConfig: { azurerm: { subscription_id: "11111111-2222-3333-4444-555555555555", storage_use_azuread: true, resource_provider_registrations: "none" } },
    };
    const ws1 = assembleWorkspace({ ...input, fragments: frags });
    const ws2 = assembleWorkspace({ ...input, fragments: new Map([...frags.entries()].reverse()) });
    expect(ws1.configDigest).toBe(ws2.configDigest);
    const versions = JSON.parse(ws1.files.find((f) => f.path === "versions.tf.json")!.content);
    expect(versions.terraform.required_providers.azurerm).toEqual({ source: "hashicorp/azurerm", version: "= 5.7.0" });
    // each node owns its tofu addresses in the workspace map
    expect(ws1.addressMap["container_service/web"]).toEqual(["azurerm_container_app.container_service_web_app"]);
    // referenced nodes contribute data sources only
    expect(Object.keys(frags.get("dns_zone/example.com")!.resource ?? {})).toEqual([]);
    expect(frags.get("dns_zone/example.com")!.addresses).toEqual(["data.azurerm_dns_zone.dns_zone_example__com_zone"]);
  });

  it("never uses ctx.ref (the context stub throws) and never writes a credential-shaped key or a provisioner", () => {
    const { frags } = allFragments();
    const json = JSON.stringify([...frags.values()]);
    expect(json).not.toMatch(/"(provisioner|connection)"/);
    expect(json).not.toMatch(/"(client_secret|client_certificate|access_key|administrator_password|password|connection_string|sas_token)"/i);
    expect(json).not.toMatch(/\$\{(file|templatefile|path\.)/);
  });

  it("tags every taggable resource with the node's Zenith identity", () => {
    const { frags } = allFragments();
    const taggable = new Set([
      "azurerm_resource_group", "azurerm_virtual_network", "azurerm_network_security_group", "azurerm_private_dns_zone", "azurerm_private_dns_zone_virtual_network_link",
      "azurerm_log_analytics_workspace", "azurerm_container_app_environment", "azurerm_container_app", "azurerm_container_app_job", "azurerm_postgresql_flexible_server",
      "azurerm_redis_cache", "azurerm_private_endpoint", "azurerm_storage_account", "azurerm_servicebus_namespace", "azurerm_key_vault", "azurerm_user_assigned_identity",
      "azurerm_container_registry", "azurerm_log_analytics_saved_search", "azurerm_container_app_environment_managed_certificate", "azurerm_dns_cname_record", "azurerm_dns_txt_record", "azurerm_dns_a_record",
    ]);
    let checked = 0;
    for (const [address, f] of frags) {
      for (const [type, named] of Object.entries(f.resource ?? {})) {
        if (!taggable.has(type)) continue;
        for (const [, body] of Object.entries(named)) {
          const tags = body.tags as Record<string, string> | undefined;
          expect(tags, `${type} in ${address} must carry tags`).toBeDefined();
          expect(tags!["zenith:resource"]).toBe(address);
          expect(tags!["zenith:environment"]).toBe("env_azure_1");
          expect(tags!["zenith:managed"]).toBe("true");
          expect(tags!["zenith:workspace"]).toBe("ws_1");
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("publishes exports as locals and references them without writing another node's label", () => {
    const { frags } = allFragments();
    const network = frags.get("network/main")!;
    expect(Object.keys(network.locals!)).toContain(exportName("network/main", "rg_name"));
    // a dependent references the export, not the network's tofu label
    const app = JSON.stringify(frags.get("container_service/web"));
    expect(app).toContain(exportRef("network/main", "cae_id"));
    expect(app).not.toContain("azurerm_container_app_environment.network_main");
    expect(app).not.toContain("azurerm_resource_group.network_main");
  });
});

describe("naming", () => {
  const ctx = { namePrefix: "zn-k3x9q2" };
  const addresses = ["container_service/web", "postgres/main-database-with-a-rather-long-name", "object_store/user-uploads-and-other-very-long-bucket-name", "secret/very-long-secret-name-for-the-session-signing-key-1a2b3c4d", "queue/jobs", "redis/cache", "dns_record/deep.sub.domain.example.co.uk"];

  it("keeps names inside each Azure service's length and character rules", () => {
    for (const a of addresses) {
      expect(cloudName(ctx, a, { max: 24, sep: "" })).toMatch(/^[a-z0-9]{3,24}$/); // storage account
      const kv = cloudName(ctx, a, { max: 24, suffix: "kv" });
      expect(kv).toMatch(/^[a-z][a-z0-9-]{1,22}[a-z0-9]$/);
      expect(kv).not.toContain("--");
      expect(cloudName(ctx, a, { max: 50, sep: "", suffix: "acr" })).toMatch(/^[a-z0-9]{1,50}$/);
      const pg = cloudName(ctx, a, { max: 63, suffix: "pg" });
      expect(pg).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
      const app = cloudName(ctx, a, { max: 32 });
      expect(app).toMatch(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/);
      expect(app).not.toContain("--");
      const bus = cloudName(ctx, a, { max: 50, suffix: "bus" });
      expect(bus).not.toMatch(/-(sb|mgmt)$/);
      expect(bus.length).toBeLessThanOrEqual(50);
    }
  });

  it("is deterministic and distinguishes long names that share a stem", () => {
    const a = cloudName(ctx, "object_store/user-uploads-and-other-very-long-bucket-name-one", { max: 24, sep: "" });
    const b = cloudName(ctx, "object_store/user-uploads-and-other-very-long-bucket-name-two", { max: 24, sep: "" });
    expect(a).not.toBe(b);
    expect(cloudName(ctx, "object_store/user-uploads-and-other-very-long-bucket-name-one", { max: 24, sep: "" })).toBe(a);
    expect(a.endsWith(hash6(`${ctx.namePrefix}|object_store/user-uploads-and-other-very-long-bucket-name-one|`))).toBe(true);
  });

  it("starts with a letter even when the prefix starts with a digit", () => {
    expect(cloudName({ namePrefix: "1abc" }, "queue/x", { max: 30 })).toMatch(/^z1abc/);
  });

  it("tfLabel is safe and injective for every address expansion can produce", () => {
    const seen = new Map<string, string>();
    for (const a of ["service/a-b", "service/a_b", "dns_record/a.b-c.com", "dns_record/a-b.c.com", "dns_record/a.b.c.com", "network/main", "subnet/azure-westeurope-private-a", "x/1abc"]) {
      const l = tfLabel(a, "part");
      expect(l).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(seen.has(l), `${a} collides with ${seen.get(l)}`).toBe(false);
      seen.set(l, a);
    }
    // characters outside the expansion's vocabulary get a hash so they cannot collide either
    expect(tfLabel("x/a b")).not.toBe(tfLabel("x/a_b"));
    expect(tfLabel("x/a b")).toMatch(/^[a-z0-9_]+$/);
  });

  it("scopedName is prefix-free and stable", () => {
    expect(scopedName("subnet/private-a", { max: 80 })).toBe("private-a");
    expect(scopedName("firewall/web-to-db", { max: 80 })).toBe("web-to-db");
    const long = scopedName(`firewall/${"x".repeat(200)}`, { max: 80 });
    expect(long.length).toBeLessThanOrEqual(80);
    expect(scopedName(`firewall/${"x".repeat(200)}`, { max: 80 })).toBe(long);
  });

  it("azureTags merges node labels and context tags and respects Azure tag rules", () => {
    const t = azureTags({ tags: { "zenith:workspace": "ws", "bad/name?": "v", "back\\slash<>%&": "v" } }, { labels: { "zenith:resource": "a/b", "zenith:environment": "e" } });
    expect(Object.keys(t)).toEqual(["back_slash____", "bad_name_", "zenith:environment", "zenith:resource", "zenith:workspace"]);
    expect(azureTags({ tags: {} }, { labels: { k: "v".repeat(400) } }).k).toHaveLength(256);
  });
});

describe("neighbours are required, not assumed", () => {
  it("a workload with no Azure network in the graph is a clear compile error", () => {
    const web = mkNode("container_service/web", "container_service", "azure:container_app", {
      size: "small", vcpu: 0.5, memoryMb: 512, artifact: { type: "image", ref: "nginx:1.27" }, env: [], zones: 1, subnetTier: "private", workload: "web", replicas: 1, port: 80,
    });
    const driver = driverFor(web)!;
    expect(() => driver.compile!(web, compileContext([web]))).toThrow(/network node.*resource group/i);
  });

  it("a firewall whose target is missing names it", () => {
    const fw = mkNode("firewall/x", "firewall", "azure:network_security_rule", { direction: "ingress", protocol: "tcp", port: 5432, source: { cidr: "10.0.0.0/8" }, target: "postgres/ghost", capability: "sql", description: "d" });
    expect(() => driverFor(fw)!.compile!(fw, compileContext([fw]))).toThrow(/postgres\/ghost/);
  });
});
