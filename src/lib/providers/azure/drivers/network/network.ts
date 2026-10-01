/**
 * `azure:virtual_network` — the ENVIRONMENT LANDING ZONE (portable kind
 * `network`).
 *
 * One Azure network node per environment and place owns everything every
 * other Azure node of that environment lives in, because Azure has no
 * account-level container like an AWS VPC and several of these are singletons
 * that only one node can declare:
 *
 *   resource group        exactly one per environment ("the" environment RG);
 *                         every other Azure node compiles INTO it. A graph with
 *                         no Azure network node cannot host Azure nodes
 *                         (`AzureCompileError`), expansion derives a network
 *                         whenever a workload, postgres, redis or route exists.
 *   virtual network       address space = `spec.cidr`.
 *   platform subnets      carved from the TOP of the VNet (`landingZoneCidrs`):
 *                           snet-aca  /23  delegated to Microsoft.App/environments
 *                           snet-pg   /26  delegated to Microsoft.DBforPostgreSQL/flexibleServers
 *                           snet-pe   /26  private endpoints (Redis, Storage)
 *                         Azure requires dedicated delegated subnets, and the
 *                         portable `subnet/*` nodes (azure:subnet) carry no role,
 *                         so the delegations live here, not on them.
 *   NSGs                  one per platform subnet. The PostgreSQL subnet is
 *                         deny-by-default (intra-subnet + load-balancer probes
 *                         allowed; everything else needs a firewall node). The
 *                         ACA and PE subnets keep Azure's default rules.
 *   private DNS           PostgreSQL (delegated-subnet zone), Redis, Blob,
 *                         Queue and Linux Functions
 *                         `privatelink` zones, each linked to the VNet.
 *   log analytics         the environment's workspace (Container Apps allows one).
 *   container apps env    workload-profile environment, Consumption profile,
 *                         VNet-integrated, EXTERNAL load balancer. Whether an
 *                         individual app is reachable from the internet is the
 *                         app's `ingress.external_enabled` (only when a route
 *                         targets it). An environment cannot be flipped between
 *                         internal and external without replacement, so compile
 *                         never does. It costs nothing while no app runs.
 *
 * Everything other nodes need is published as tofu locals (`exports.ts`).
 * Stateful-resource rules do not apply (nothing here holds data).
 */
import type { CompileContext, TofuFragment, VerificationCheck } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { NetworkSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, fragment, mergeBlocks, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals } from "@/lib/providers/azure/exports";
import { defineAzureDriver, getById, pick, props } from "@/lib/providers/azure/kit";
import type { ArmResource, Json } from "@/lib/providers/azure/arm";
import { cloudName, azureTags, tfLabel } from "@/lib/providers/azure/naming";
import { API, DEFAULT_LOG_RETENTION_DAYS, landingZoneCidrs } from "@/lib/providers/azure/platform";
import { findLandingZoneTagged } from "@/lib/providers/azure/drivers/network/landing";

/** Fixed, prefix-free names inside the environment resource group / VNet (observers rely on them). */
export const PLATFORM = {
  subnets: { aca: "snet-aca", pg: "snet-pg", pe: "snet-pe" },
  nsgs: { aca: "nsg-aca", pg: "nsg-pg", pe: "nsg-pe" },
  delegations: {
    aca: "Microsoft.App/environments",
    pg: "Microsoft.DBforPostgreSQL/flexibleServers",
  },
} as const;

const JOIN_ACTION = "Microsoft.Network/virtualNetworks/subnets/join/action";

const PRIVATE_DNS = {
  redis: "privatelink.redis.cache.windows.net",
  blob: "privatelink.blob.core.windows.net",
  queue: "privatelink.queue.core.windows.net",
  web: "privatelink.azurewebsites.net",
} as const;

export function compileNetwork(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<NetworkSpec>(node);
  const a = node.address;
  if (!spec.cidr) throw new AzureCompileError("an Azure network needs spec.cidr.", a);
  const cidrs = landingZoneCidrs(spec.cidr, a);
  const L = (part: string) => tfLabel(a, part);
  const tags = azureTags(ctx, node);
  const rg = `\${azurerm_resource_group.${L("rg")}.name}`;
  const location = node.region;
  const vnetName = cloudName(ctx, a, { max: 64, suffix: "vnet" });

  const subnet = (key: "aca" | "pg" | "pe", extra: Record<string, unknown>) =>
    block("azurerm_subnet", L(`snet_${key}`), {
      name: PLATFORM.subnets[key],
      resource_group_name: rg,
      virtual_network_name: `\${azurerm_virtual_network.${L("vnet")}.name}`,
      address_prefixes: [cidrs[key]],
      ...extra,
    });
  const nsg = (key: "aca" | "pg" | "pe") =>
    mergeBlocks(
      block("azurerm_network_security_group", L(`nsg_${key}`), { name: PLATFORM.nsgs[key], location, resource_group_name: rg, tags }),
      block("azurerm_subnet_network_security_group_association", L(`assoc_${key}`), {
        subnet_id: `\${azurerm_subnet.${L(`snet_${key}`)}.id}`,
        network_security_group_id: `\${azurerm_network_security_group.${L(`nsg_${key}`)}.id}`,
      })
    );
  const pgRule = (name: string, priority: number, access: "Allow" | "Deny", src: string, dst: string, description: string) =>
    block("azurerm_network_security_rule", L(`rule_pg_${name.replace(/-/g, "_")}`), {
      name,
      resource_group_name: rg,
      network_security_group_name: `\${azurerm_network_security_group.${L("nsg_pg")}.name}`,
      priority,
      direction: "Inbound",
      access,
      protocol: "*",
      source_port_range: "*",
      destination_port_range: "*",
      source_address_prefix: src,
      destination_address_prefix: dst,
      description,
    });
  const zone = (key: "pg" | "redis" | "blob" | "queue" | "web", name: string) =>
    mergeBlocks(
      block("azurerm_private_dns_zone", L(`dns_${key}`), { name, resource_group_name: rg, tags }),
      block("azurerm_private_dns_zone_virtual_network_link", L(`dns_${key}_link`), {
        name: `link-${key}`,
        private_dns_zone_id: `\${azurerm_private_dns_zone.${L(`dns_${key}`)}.id}`,
        virtual_network_id: `\${azurerm_virtual_network.${L("vnet")}.id}`,
        registration_enabled: false,
        tags,
      })
    );

  const pgZoneName = `${cloudName(ctx, a, { max: 50, suffix: "pg" })}.private.postgres.database.azure.com`;

  const resource = mergeBlocks(
    block("azurerm_resource_group", L("rg"), { name: cloudName(ctx, a, { max: 90, suffix: "rg" }), location, tags }),
    block("azurerm_virtual_network", L("vnet"), { name: vnetName, location, resource_group_name: rg, address_space: [spec.cidr], tags }),
    subnet("aca", {
      delegation: [{ name: "aca", service_delegation: { name: PLATFORM.delegations.aca, actions: [JOIN_ACTION] } }],
    }),
    subnet("pg", {
      delegation: [{ name: "pg", service_delegation: { name: PLATFORM.delegations.pg, actions: [JOIN_ACTION] } }],
    }),
    subnet("pe", { private_endpoint_network_policies: "Enabled" }),
    nsg("aca"),
    nsg("pg"),
    nsg("pe"),
    pgRule("allow-intra-subnet", 100, "Allow", cidrs.pg, cidrs.pg, "primary and standby replicate inside the delegated subnet"),
    pgRule("allow-azure-lb", 110, "Allow", "AzureLoadBalancer", "*", "platform health probes"),
    pgRule("deny-all-inbound", 4096, "Deny", "*", "*", "everything else needs a Zenith firewall rule"),
    zone("pg", pgZoneName),
    zone("redis", PRIVATE_DNS.redis),
    zone("blob", PRIVATE_DNS.blob),
    zone("queue", PRIVATE_DNS.queue),
    zone("web", PRIVATE_DNS.web),
    block("azurerm_log_analytics_workspace", L("logs"), {
      name: cloudName(ctx, a, { max: 63, suffix: "logs" }),
      location,
      resource_group_name: rg,
      sku: "PerGB2018",
      retention_in_days: DEFAULT_LOG_RETENTION_DAYS,
      tags,
    }),
    block("azurerm_container_app_environment", L("cae"), {
      name: cloudName(ctx, a, { max: 60, suffix: "cae" }),
      location,
      resource_group_name: rg,
      log_analytics_workspace_id: `\${azurerm_log_analytics_workspace.${L("logs")}.id}`,
      logs_destination: "log-analytics",
      infrastructure_subnet_id: `\${azurerm_subnet.${L("snet_aca")}.id}`,
      internal_load_balancer_enabled: false,
      zone_redundancy_enabled: spec.zones >= 2,
      workload_profile: [{ name: "Consumption", workload_profile_type: "Consumption" }],
      tags,
    })
  );

  const ref = (type: string, part: string, attr: string) => `\${${type}.${L(part)}.${attr}}`;
  return fragment({
    data: { azurerm_client_config: { [L("client")]: {} } },
    resource,
    locals: exportLocals(a, {
      rg_name: rg,
      location: ref("azurerm_resource_group", "rg", "location"),
      tenant_id: ref("data.azurerm_client_config", "client", "tenant_id"),
      object_id: ref("data.azurerm_client_config", "client", "object_id"),
      subscription_id: ref("data.azurerm_client_config", "client", "subscription_id"),
      vnet_id: ref("azurerm_virtual_network", "vnet", "id"),
      vnet_name: ref("azurerm_virtual_network", "vnet", "name"),
      snet_aca_id: ref("azurerm_subnet", "snet_aca", "id"),
      snet_pg_id: ref("azurerm_subnet", "snet_pg", "id"),
      snet_pe_id: ref("azurerm_subnet", "snet_pe", "id"),
      cidr_aca: cidrs.aca,
      cidr_pg: cidrs.pg,
      cidr_pe: cidrs.pe,
      nsg_aca_name: ref("azurerm_network_security_group", "nsg_aca", "name"),
      nsg_pg_name: ref("azurerm_network_security_group", "nsg_pg", "name"),
      nsg_pe_name: ref("azurerm_network_security_group", "nsg_pe", "name"),
      dns_pg_id: ref("azurerm_private_dns_zone", "dns_pg", "id"),
      dns_redis_id: ref("azurerm_private_dns_zone", "dns_redis", "id"),
      dns_blob_id: ref("azurerm_private_dns_zone", "dns_blob", "id"),
      dns_queue_id: ref("azurerm_private_dns_zone", "dns_queue", "id"),
      dns_web_id: ref("azurerm_private_dns_zone", "dns_web", "id"),
      cae_id: ref("azurerm_container_app_environment", "cae", "id"),
      cae_name: ref("azurerm_container_app_environment", "cae", "name"),
      cae_default_domain: ref("azurerm_container_app_environment", "cae", "default_domain"),
      cae_static_ip: ref("azurerm_container_app_environment", "cae", "static_ip_address"),
      cae_verification_id: ref("azurerm_container_app_environment", "cae", "custom_domain_verification_id"),
      law_id: ref("azurerm_log_analytics_workspace", "logs", "id"),
      law_workspace_id: ref("azurerm_log_analytics_workspace", "logs", "workspace_id"),
      law_name: ref("azurerm_log_analytics_workspace", "logs", "name"),
    }),
  });
}

/* --------------------------------- observe ---------------------------------- */

const VNET = { type: "Microsoft.Network/virtualNetworks", apiVersion: API.network } as const;

function subnetsOf(res: ArmResource): Json[] {
  const s = pick<Json[]>(props(res), "subnets");
  return Array.isArray(s) ? s : [];
}

function platformSubnet(res: ArmResource, name: string): Json | undefined {
  return subnetsOf(res).find((s) => String(s.name ?? "").toLowerCase() === name);
}

export const networkDriver = defineAzureDriver({
  id: "azure.virtual_network@1",
  kind: "network",
  nativeType: "azure:virtual_network",
  arm: VNET,
  compile: compileNetwork,
  expected: (node) => {
    const spec = specOf<NetworkSpec>(node);
    return { cidr: spec.cidr };
  },
  read: (res) => {
    const prefixes = pick<string[]>(props(res), "addressSpace", "addressPrefixes");
    return { cidr: Array.isArray(prefixes) && prefixes.length === 1 ? prefixes[0] : undefined };
  },
  native: (res) => ({
    addressPrefixes: pick(props(res), "addressSpace", "addressPrefixes"),
    subnets: subnetsOf(res).map((s) => ({ name: s.name, prefix: pick(s, "properties", "addressPrefix") })),
    provisioningState: props(res).provisioningState,
  }),
  checks: async (ctx, node, res, arm) => {
    const checks: VerificationCheck[] = [];
    const want: [string, string, string][] = [
      ["aca", PLATFORM.subnets.aca, PLATFORM.delegations.aca],
      ["pg", PLATFORM.subnets.pg, PLATFORM.delegations.pg],
    ];
    for (const [key, name, service] of want) {
      const sn = platformSubnet(res, name);
      const delegations = pick<Json[]>(sn, "properties", "delegations") ?? [];
      const ok = delegations.some((d) => String(pick(d, "properties", "serviceName") ?? "").toLowerCase() === service.toLowerCase());
      checks.push({
        id: `delegation_${key}`,
        description: `subnet ${name} is delegated to ${service}`,
        passed: sn ? ok : false,
        ...(sn ? {} : { detail: "subnet not found" }),
      });
    }
    const pgNsg = pick<string>(platformSubnet(res, PLATFORM.subnets.pg), "properties", "networkSecurityGroup", "id");
    checks.push({ id: "pg_nsg", description: "the PostgreSQL subnet has its network security group attached", passed: Boolean(pgNsg) });

    const env = await findLandingZoneTagged(ctx, node, arm, "Microsoft.App/managedEnvironments");
    if ("matches" in env && env.matches.length === 1) {
      const got = await getById(arm, env.matches[0].id, API.containerApps);
      if (got.state === "found") {
        const state = pick<string>(props(got.resource), "provisioningState");
        checks.push({ id: "container_apps_environment", description: "the Container Apps environment is provisioned", passed: state === "Succeeded", detail: `provisioningState=${state ?? "unknown"}` });
      } else checks.push({ id: "container_apps_environment", description: "the Container Apps environment is provisioned", passed: "unknown", detail: got.state });
    } else {
      checks.push({
        id: "container_apps_environment",
        description: "the Container Apps environment is provisioned",
        passed: "matches" in env ? false : "unknown",
        detail: "matches" in env ? `${env.matches.length} environments tagged for this node` : env.state,
      });
    }
    return checks;
  },
});
