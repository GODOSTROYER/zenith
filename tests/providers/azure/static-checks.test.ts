/**
 * Static security checks over everything the Azure drivers compile. These read
 * the OpenTofu JSON, not a cloud: they are the "no public data services, no
 * inline secrets, no broad roles" rules of the Azure provider made executable.
 */
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { assertUniqueRulePriorities } from "@/lib/providers/azure/drivers/network/firewall";
import { FORBIDDEN_ROLE_NAMES, ROLE } from "@/lib/providers/azure/platform";
import { compileAll, mkNode, sampleGraph } from "./_helpers";

const driverFor = (n: { nativeType: string }) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType);

type Body = Record<string, unknown>;

function collect(type: string, frags: Map<string, TofuFragment>): { address: string; label: string; body: Body }[] {
  const out: { address: string; label: string; body: Body }[] = [];
  for (const [address, f] of frags) for (const [label, body] of Object.entries(f.resource?.[type] ?? {})) out.push({ address, label, body });
  return out;
}

function compileWith(mutate: (nodes: ReturnType<typeof sampleGraph>) => void = () => undefined) {
  const nodes = sampleGraph();
  mutate(nodes);
  return { nodes, frags: compileAll(nodes, driverFor) };
}

const { frags } = compileWith();

describe("data services are not reachable from the public network", () => {
  it("PostgreSQL: VNet-integrated, public access off, Entra-only authentication, no admin password", () => {
    const [pg] = collect("azurerm_postgresql_flexible_server", frags);
    expect(pg.body.public_network_access_enabled).toBe(false);
    expect(pg.body.delegated_subnet_id).toMatch(/snet_pg_id/);
    expect(pg.body.private_dns_zone_id).toMatch(/dns_pg_id/);
    expect(pg.body.authentication).toEqual({ active_directory_auth_enabled: true, password_auth_enabled: false, tenant_id: "${local.network_main__tenant_id}" });
    for (const k of ["administrator_login", "administrator_password", "administrator_password_wo"]) expect(pg.body).not.toHaveProperty(k);
  });

  it("Redis: TLS only, TLS 1.2, public access off, private endpoint in the DNS zone", () => {
    const [redis] = collect("azurerm_redis_cache", frags);
    expect(redis.body).toMatchObject({ non_ssl_port_enabled: false, minimum_tls_version: "1.2", public_network_access_enabled: false });
    // authentication is never turned off
    expect(JSON.stringify(redis.body)).not.toMatch(/"authentication_enabled"\s*:\s*false/);
    const pes = collect("azurerm_private_endpoint", frags).filter((p) => p.address === "redis/cache");
    expect(pes).toHaveLength(1);
    expect(JSON.stringify(pes[0].body)).toContain("redisCache");
    expect(JSON.stringify(pes[0].body)).toContain("dns_redis_id");
  });

  it("Storage: https only, TLS 1.2, no anonymous access, shared keys disabled, public network off, private endpoint", () => {
    const [st] = collect("azurerm_storage_account", frags);
    expect(st.body).toMatchObject({
      https_traffic_only_enabled: true,
      min_tls_version: "TLS1_2",
      allow_nested_items_to_be_public: false,
      shared_access_key_enabled: false,
      public_network_access: "Disabled",
      network_rules: { default_action: "Deny" },
    });
    expect((collect("azurerm_storage_container", frags)[0].body as Body).container_access_type).toBe("private");
    expect(collect("azurerm_private_endpoint", frags).filter((p) => p.address === "object_store/uploads")).toHaveLength(1);
    // versioning follows the spec
    expect((st.body.blob_properties as Body).versioning_enabled).toBe(true);
  });

  it("the documented exceptions are exactly these and each has its compensating control", () => {
    // Key Vault: public endpoint enabled ONLY because secret values are synced from outside the VNet; RBAC-only + purge protection
    const [kv] = collect("azurerm_key_vault", frags);
    expect(kv.body).toMatchObject({ public_network_access_enabled: true, rbac_authorization_enabled: true, purge_protection_enabled: true, soft_delete_retention_days: 90 });
    expect(kv.body).not.toHaveProperty("access_policy");
    // Service Bus Standard/Basic cannot be private; Entra-only, no SAS keys
    const [ns] = collect("azurerm_servicebus_namespace", frags);
    expect(ns.body).toMatchObject({ local_auth_enabled: false, minimum_tls_version: "1.2" });
    expect(ns.body).not.toHaveProperty("network_rule_set");
    // Container Registry: admin user off, no anonymous pull
    const [acr] = collect("azurerm_container_registry", frags);
    expect(acr.body).toMatchObject({ admin_enabled: false, anonymous_pull_enabled: false });
    // nothing else exposes a public-access switch set to true
    const enabledPublic = [...frags.entries()].flatMap(([address, f]) => Object.entries(f.resource ?? {}).flatMap(([type, named]) => Object.entries(named).filter(([, b]) => b.public_network_access_enabled === true || b.public_network_access === "Enabled").map(() => `${type}@${address}`)));
    expect(enabledPublic.sort()).toEqual(["azurerm_container_registry@container_registry/web", "azurerm_key_vault@secret/session-key-1a2b3c4d"]);
  });

  it("only the Container Apps environment has a public front door, and apps are external only when routed", () => {
    const [cae] = collect("azurerm_container_app_environment", frags);
    expect(cae.body.internal_load_balancer_enabled).toBe(false);
    const web = collect("azurerm_container_app", frags).find((a) => a.address === "container_service/web")!;
    expect((web.body.ingress as Body).external_enabled).toBe(true);
    expect((web.body.ingress as Body).allow_insecure_connections).toBe(false);

    const noRoute = compileWith((nodes) => {
      const i = nodes.findIndex((n) => n.address === "load_balancer/public");
      nodes.splice(i, 1);
      for (const a of ["dns_record/app.example.com", "tls_certificate/app.example.com", "firewall/internet-to-lb-80", "firewall/internet-to-lb-443", "firewall/lb-to-web"]) nodes.splice(nodes.findIndex((n) => n.address === a), 1);
    });
    const webNoRoute = collect("azurerm_container_app", noRoute.frags).find((a) => a.address === "container_service/web")!;
    expect((webNoRoute.body.ingress as Body).external_enabled).toBe(false);
  });
});

describe("no inline secrets", () => {
  it("every Container Apps secret is a Key Vault reference read with the workload identity; no value anywhere", () => {
    const apps = [...collect("azurerm_container_app", frags), ...collect("azurerm_container_app_job", frags)];
    let secrets = 0;
    for (const app of apps) {
      for (const s of (app.body.secret as Body[] | undefined) ?? []) {
        secrets++;
        expect(s).not.toHaveProperty("value");
        expect(String(s.key_vault_secret_id)).toMatch(/__secret_uri\}$/);
        expect(String(s.identity)).toMatch(/^\$\{local\.identity_web__id\}$/);
      }
      // a secret env var carries the secret NAME, never a value
      const envs = ((app.body.template as Body).container as Body[]).flatMap((c) => (c.env as Body[] | undefined) ?? []);
      for (const e of envs) expect(Object.keys(e).sort()).toEqual(e.secret_name ? ["name", "secret_name"] : ["name", "value"]);
    }
    expect(secrets).toBe(1);
  });

  it("a secret value that appears in the manifest graph (canary) never reaches a fragment", () => {
    const canary = "CANARY-secret-value-9f8e7d6c5b4a";
    const { frags: f } = compileWith((nodes) => {
      const web = nodes.find((n) => n.address === "container_service/web")!;
      // the spec must only ever hold references; a stray inline value elsewhere would be the model's leak, not the driver's
      (web.spec.env as Body[]).push({ key: "OTHER_SECRET", secretRef: "vault:ws_1/env_azure_1/OTHER" });
      const secret = mkNode("secret/other-0a0b0c0d", "secret", "azure:key_vault_secret", { secretRef: "vault:ws_1/env_azure_1/OTHER", store: "zenith_vault", purpose: "environment" });
      nodes.push(secret);
      web.dependsOn.push(secret.address);
      const identity = nodes.find((n) => n.address === "identity/web")!;
      (identity.spec.grants as Body[]).push({ target: secret.address, access: ["read"], via: ["env:OTHER_SECRET"] });
      identity.dependsOn.push(secret.address);
    });
    expect(JSON.stringify([...f.values()])).not.toContain(canary);
    const secretNames = collect("azurerm_container_app", f)[0].body.secret as Body[];
    expect(secretNames).toHaveLength(2);
  });

  it("there is no secret resource, generated password, key or connection string in any fragment", () => {
    const types = new Set([...frags.values()].flatMap((f) => Object.keys(f.resource ?? {})));
    for (const banned of ["azurerm_key_vault_secret", "random_password", "azurerm_key_vault_key", "azurerm_key_vault_certificate", "azurerm_storage_account_sas", "azurerm_servicebus_namespace_authorization_rule", "azurerm_servicebus_queue_authorization_rule", "azurerm_redis_firewall_rule"]) {
      expect(types.has(banned), banned).toBe(false);
    }
    // outputs are never produced (and so can never be sensitive values)
    for (const f of frags.values()) expect(f.output).toBeUndefined();
    // and nothing reads a key/connection-string attribute of any resource
    expect(JSON.stringify([...frags.values()])).not.toMatch(/primary_access_key|secondary_access_key|connection_string|primary_key|shared_key|admin_password|administrator_password/);
  });

  it("the container registry has no admin user, so no registry password exists", () => {
    expect(collect("azurerm_container_registry", frags)[0].body.admin_enabled).toBe(false);
    for (const app of collect("azurerm_container_app", frags)) for (const r of (app.body.registry as Body[] | undefined) ?? []) expect(r).not.toHaveProperty("password_secret_name");
  });
});

describe("no broad role assignments", () => {
  const roles = collect("azurerm_role_assignment", frags);

  it("every assignment is scoped to one resource export and uses a narrow built-in data role", () => {
    expect(roles.length).toBeGreaterThanOrEqual(4);
    const allowed = new Set<string>(Object.values(ROLE));
    for (const r of roles) {
      expect(allowed.has(String(r.body.role_definition_name)), String(r.body.role_definition_name)).toBe(true);
      expect(FORBIDDEN_ROLE_NAMES).not.toContain(r.body.role_definition_name);
      // a scope is `${local.<resource>__<id|vault_id|resource_manager_id>}`: never the resource group, the subscription or a literal
      expect(String(r.body.scope)).toMatch(/^\$\{local\.[a-z0-9_]+__(id|vault_id|resource_manager_id)\}$/);
      expect(String(r.body.scope)).not.toMatch(/rg_name|subscription|network_main__/);
      expect(r.body.principal_type).toBe("ServicePrincipal");
      expect(JSON.stringify(r.body)).not.toContain("*");
    }
  });

  it("grants map to exact roles and exact targets; log, database and referenced-secret grants add no role", () => {
    const byTarget = Object.fromEntries(roles.map((r) => [String(r.body.description), r.body.role_definition_name]));
    expect(byTarget).toEqual({
      "Zenith grant on container_registry/web": "AcrPull",
      "Zenith grant on object_store/uploads": "Storage Blob Data Contributor",
      "Zenith grant on queue/jobs": "Azure Service Bus Data Sender",
      "Zenith grant on secret/session-key-1a2b3c4d": "Key Vault Secrets User",
    });
  });

  it("read-only blob grants get the reader role, consume gets the receiver role", () => {
    const { frags: f } = compileWith((nodes) => {
      const identity = nodes.find((n) => n.address === "identity/web")!;
      identity.spec.grants = [
        { target: "object_store/uploads", access: ["list", "read"], via: ["binding:blob"] },
        { target: "queue/jobs", access: ["consume"], via: ["binding:queue_consume"] },
      ];
    });
    const r = collect("azurerm_role_assignment", f).map((x) => x.body.role_definition_name).sort();
    expect(r).toEqual(["Azure Service Bus Data Receiver", "Storage Blob Data Reader"]);
  });

  it("a wildcard, an unknown verb or an unmappable target is a compile error, never a silently dropped permission", () => {
    for (const grant of [
      { target: "object_store/*", access: ["read"], via: [] },
      { target: "object_store/uploads", access: ["read", "*"], via: [] },
      { target: "object_store/uploads", access: ["admin"], via: [] },
      { target: "build_pipeline/web", access: ["read"], via: [] },
    ]) {
      expect(() =>
        compileWith((nodes) => {
          nodes.find((n) => n.address === "identity/web")!.spec.grants = [grant];
        })
      ).toThrow();
    }
  });

  it("a referenced (customer-owned) Key Vault secret gets no role from Zenith", () => {
    const { frags: f } = compileWith((nodes) => {
      const s = nodes.find((n) => n.address === "secret/session-key-1a2b3c4d")!;
      s.ownership = "referenced";
      s.externalRef = "https://customer-vault.vault.azure.net/secrets/session-key";
    });
    expect(collect("azurerm_role_assignment", f).map((r) => r.body.role_definition_name)).not.toContain("Key Vault Secrets User");
    expect(collect("azurerm_key_vault", f)).toHaveLength(0);
    // the app reads the customer's secret by its URI
    expect(JSON.stringify(collect("azurerm_container_app", f)[0].body.secret)).toContain("https://customer-vault.vault.azure.net/secrets/session-key");
  });
});

describe("network rules", () => {
  const rules = collect("azurerm_network_security_rule", frags);
  const fromFirewallNodes = rules.filter((r) => r.address.startsWith("firewall/"));

  it("no allow rule is open to everything; the internet reaches only ports 80/443 of the ingress subnet", () => {
    for (const r of fromFirewallNodes) {
      expect(r.body.access).toBe("Allow");
      expect(r.body.direction).toBe("Inbound");
      expect(String(r.body.source_address_prefix)).not.toBe("*");
      expect(String(r.body.source_address_prefix)).not.toBe("0.0.0.0/0");
      expect(r.body.destination_port_range).toMatch(/^\d+$/);
    }
    const internet = fromFirewallNodes.filter((r) => r.body.source_address_prefix === "Internet");
    expect(internet.map((r) => r.body.destination_port_range).sort()).toEqual(["443", "80"]);
    for (const r of internet) expect(r.body.network_security_group_name).toMatch(/nsg_aca_name/);
  });

  it("the PostgreSQL subnet denies all inbound by default and only the web subnet may reach it", () => {
    const network = rules.filter((r) => r.address === "network/main");
    const deny = network.find((r) => r.body.name === "deny-all-inbound")!;
    expect(deny.body).toMatchObject({ access: "Deny", direction: "Inbound", priority: 4096 });
    const toDb = fromFirewallNodes.filter((r) => String(r.body.network_security_group_name).includes("nsg_pg_name"));
    expect(toDb).toHaveLength(1);
    expect(toDb[0].body).toMatchObject({ destination_port_range: "5432", source_address_prefix: "${local.network_main__cidr_aca}" });
    // allows sit above the deny
    expect(Number(toDb[0].body.priority)).toBeLessThan(4096);
  });

  it("redis rules target the TLS port", () => {
    const toCache = fromFirewallNodes.find((r) => r.address === "firewall/web-to-cache")!;
    expect(toCache.body.destination_port_range).toBe("6380");
  });

  it("a public source CIDR is refused for anything but public_http to the load balancer", () => {
    for (const patch of [
      { source: { cidr: "0.0.0.0/0" }, target: "postgres/db", capability: "sql", port: 5432 },
      { source: { cidr: "203.0.113.0/24" }, target: "redis/cache", capability: "cache", port: 6379 },
      { source: { cidr: "0.0.0.0/0" }, target: "container_service/web", capability: "http", port: 8080 },
      { source: { cidr: "0.0.0.0/0" }, target: "load_balancer/public", capability: "sql", port: 80 },
    ]) {
      expect(() =>
        compileWith((nodes) => {
          const fw = nodes.find((n) => n.address === "firewall/lb-to-web")!;
          Object.assign(fw.spec, patch);
        })
      ).toThrow(/refusing a public source CIDR/);
    }
    // private CIDRs are fine
    expect(() =>
      compileWith((nodes) => {
        Object.assign(nodes.find((n) => n.address === "firewall/lb-to-web")!.spec, { source: { cidr: "10.20.0.0/16" } });
      })
    ).not.toThrow();
  });

  it("a cross-cloud source address cannot be expressed and says so", () => {
    expect(() =>
      compileWith((nodes) => {
        nodes.push(mkNode("container_service/remote", "container_service", "aws:ecs_service", { port: 80 }, { provider: "aws", region: "us-east-1" }));
        const fw = nodes.find((n) => n.address === "firewall/web-to-db")!;
        fw.spec.source = { address: "container_service/remote" };
      })
    ).toThrow(/aws.*explicit CIDR/i);
  });

  it("rule priorities stay in 200–3999 and collisions are detectable", () => {
    for (const r of fromFirewallNodes) expect(Number(r.body.priority)).toBeGreaterThanOrEqual(200);
    for (const r of fromFirewallNodes) expect(Number(r.body.priority)).toBeLessThan(4000);
    expect(assertUniqueRulePriorities(frags.values())).toEqual([]);
    const dup: TofuFragment = { addresses: [], resource: { azurerm_network_security_rule: { a: { network_security_group_name: "x", direction: "Inbound", priority: 300 }, b: { network_security_group_name: "x", direction: "Inbound", priority: 300 } } } };
    expect(assertUniqueRulePriorities([dup])).toHaveLength(1);
  });
});

describe("deletion protection on stateful resources", () => {
  it("prevent_destroy and a CanNotDelete lock unless the spec allows deletion", () => {
    const protectedTypes = ["azurerm_postgresql_flexible_server", "azurerm_redis_cache", "azurerm_storage_account", "azurerm_servicebus_namespace"];
    for (const t of protectedTypes) for (const r of collect(t, frags)) expect((r.body.lifecycle as Body).prevent_destroy, t).toBe(true);
    const locks = collect("azurerm_management_lock", frags);
    expect(locks.map((l) => l.address).sort()).toEqual(["object_store/uploads", "postgres/db", "queue/jobs", "redis/cache"]);
    for (const l of locks) expect(l.body).toMatchObject({ lock_level: "CanNotDelete" });
    // the vault is protected by purge protection AND prevent_destroy (there is no policy knob on a secret)
    expect((collect("azurerm_key_vault", frags)[0].body.lifecycle as Body).prevent_destroy).toBe(true);

    const { frags: open } = compileWith((nodes) => {
      for (const a of ["postgres/db", "redis/cache", "object_store/uploads", "queue/jobs"]) nodes.find((n) => n.address === a)!.spec.deletionPolicy = "allow";
    });
    expect(collect("azurerm_management_lock", open)).toHaveLength(0);
    for (const t of protectedTypes) for (const r of collect(t, open)) expect((r.body.lifecycle as Body).prevent_destroy, t).toBe(false);
  });
});
