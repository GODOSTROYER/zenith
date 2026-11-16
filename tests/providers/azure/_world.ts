/**
 * A fake Azure subscription for contract tests: an in-memory ARM resource
 * store, served by the fake ARM HTTP server, consistent with the sample graph
 * (every resource matches its node's desired spec, so observation, drift and
 * verify come out clean until a test perturbs it).
 *
 * This is a model of the REST shapes the drivers read (paths, api-versions,
 * property names from Microsoft's references) — not a recording of Azure.
 */
import type { ResourceNode } from "@/lib/resources/types";
import { ruleName } from "@/lib/providers/azure/drivers/network/firewall";
import { containerName } from "@/lib/providers/azure/drivers/data/storage";
import { scopedName } from "@/lib/providers/azure/naming";
import type { ArmRoute } from "./_helpers";
import { ENV_ID, REGION, SUB } from "./_helpers";

/** A loosely typed ARM document for tests that reach into nested properties. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

export const RG = "zn-k3x9q2-main-rg";
export const WORKSPACE_GUID = "abcdef01-2345-6789-abcd-ef0123456789";
export const PRINCIPAL_GUID = "0f0f0f0f-1111-2222-3333-444444444444";

export interface Failure {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface TaggedResource {
  id: string;
  name: string;
  type: string;
  location: string;
  tags: Record<string, string>;
}

export class World {
  /** exact lowercased path → response body */
  readonly docs = new Map<string, unknown>();
  /** exact lowercased path → collection items (answered as `{ value }`) */
  readonly lists = new Map<string, unknown[]>();
  readonly tagged: TaggedResource[] = [];
  /** exact lowercased path → forced failure */
  readonly failures = new Map<string, Failure>();
  /** failure for the subscription-wide resource search */
  searchFailure?: Failure;
  /** extra handlers, tried first */
  readonly extra: ArmRoute[] = [];

  private key = (p: string) => p.toLowerCase();

  id(type: string, ...names: string[]): string {
    const [provider, ...types] = type.split("/");
    return `/subscriptions/${SUB}/resourceGroups/${RG}/providers/${provider}/${types.map((t, i) => `${t}/${names[i]}`).join("/")}`;
  }

  /** add a GET-able resource; with `node` it is also findable by that node's Zenith tags */
  add(type: string, names: string[], body: Record<string, unknown>, node?: Pick<ResourceNode, "address" | "labels">, taggable = true): string {
    const id = this.id(type, ...names);
    const full = { id, name: names[names.length - 1], type, location: REGION, ...(node && taggable ? { tags: this.tagsOf(node) } : {}), ...body };
    this.docs.set(this.key(id), full);
    if (node && taggable) this.tagged.push({ id, name: names[names.length - 1], type, location: REGION, tags: this.tagsOf(node) });
    return id;
  }

  tagsOf(node: Pick<ResourceNode, "address" | "labels">): Record<string, string> {
    return { ...node.labels, "zenith:workspace": "ws_1", "zenith:environment": ENV_ID, "zenith:resource": node.address, "zenith:managed": "true" };
  }

  set(path: string, body: unknown) {
    // ARM resource documents always carry their id
    this.docs.set(this.key(path), body && typeof body === "object" && !("id" in (body as object)) ? { id: path, ...(body as object) } : body);
  }
  setList(path: string, items: unknown[]) {
    this.lists.set(this.key(path), items);
  }
  fail(path: string, f: Failure) {
    this.failures.set(this.key(path), f);
  }

  /** mutate a stored document (for perturbing a fixture) */
  patch(id: string, fn: (doc: Record<string, unknown>) => void) {
    const doc = this.docs.get(this.key(id)) as Record<string, unknown>;
    fn(doc);
  }

  route(): ArmRoute {
    return {
      match: () => true,
      handler: ({ method, pathname, query }) => {
        for (const r of this.extra) {
          if ((!r.method || r.method === method) && (typeof r.match === "string" ? r.match.toLowerCase() === pathname.toLowerCase() : r.match(pathname, query))) {
            return r.handler ? r.handler({ method, pathname, query, body: "", headers: {} }) : { status: r.status ?? 200, body: r.body, headers: r.headers };
          }
        }
        const p = pathname.toLowerCase();
        if (!query.get("api-version")) return { status: 400, body: { error: { code: "MissingApiVersionParameter", message: "api-version is required" } } };
        const forced = this.failures.get(p);
        if (forced) return { status: forced.status, headers: forced.headers, body: forced.body ?? { error: { code: "Forced", message: "forced failure" } } };
        if (method !== "GET") return { status: 405, body: { error: { code: "MethodNotAllowed", message: `${method} ${pathname}` } } };
        if (p === `/subscriptions/${SUB}/resources`) {
          if (this.searchFailure) return { status: this.searchFailure.status, headers: this.searchFailure.headers, body: this.searchFailure.body ?? { error: { code: "Forced", message: "search failed" } } };
          const filter = query.get("$filter") ?? "";
          const tag = /tagName eq '([^']+)' and tagValue eq '((?:[^']|'')*)'/.exec(filter);
          const rt = /resourceType eq '([^']+)'/.exec(filter);
          const hits = this.tagged.filter((r) => (tag ? r.tags[tag[1]] === tag[2].replace(/''/g, "'") : true) && (rt ? r.type.toLowerCase() === rt[1].toLowerCase() : true));
          return { status: 200, body: { value: hits } };
        }
        if (this.docs.has(p)) return { status: 200, body: this.docs.get(p) };
        if (this.lists.has(p)) {
          const items = this.lists.get(p)!;
          const filter = query.get("$filter");
          const filtered = filter && p.endsWith("/roleassignments") ? items.filter((i) => JSON.stringify(i).includes(String(/principalId eq '([^']+)'/.exec(filter)?.[1]))) : items;
          return { status: 200, body: { value: filtered } };
        }
        return { status: 404, body: { error: { code: "ResourceNotFound", message: `The resource ${pathname} was not found.` } } };
      },
    };
  }
}

/** A world in which every node of the sample graph exists and matches its desired spec. */
export function buildWorld(nodes: ResourceNode[]): World {
  const w = new World();
  const by = (a: string) => nodes.find((n) => n.address === a)!;
  const network = by("network/main");

  // ---- network landing zone
  const nsgIds: Record<string, string> = {};
  const rulesByNsg: Record<"aca" | "pg" | "pe", unknown[]> = { aca: [], pg: [], pe: [] };
  const fw: [string, "aca" | "pg" | "pe", Record<string, unknown>][] = [
    ["firewall/internet-to-lb-80", "aca", { sourceAddressPrefix: "Internet", destinationPortRange: "80" }],
    ["firewall/internet-to-lb-443", "aca", { sourceAddressPrefix: "Internet", destinationPortRange: "443" }],
    ["firewall/lb-to-web", "aca", { sourceAddressPrefix: "10.0.254.0/23", destinationPortRange: "8080" }],
    ["firewall/web-to-db", "pg", { sourceAddressPrefix: "10.0.254.0/23", destinationPortRange: "5432" }],
    ["firewall/web-to-cache", "pe", { sourceAddressPrefix: "10.0.254.0/23", destinationPortRange: "6380" }],
  ];
  for (const [address, key, props] of fw) {
    rulesByNsg[key].push({ id: `rule-${address}`, name: ruleName(address), properties: { direction: "Inbound", access: "Allow", protocol: "Tcp", priority: 300, provisioningState: "Succeeded", ...props } });
  }
  for (const key of ["aca", "pg", "pe"] as const) {
    nsgIds[key] = w.add("Microsoft.Network/networkSecurityGroups", [`nsg-${key}`], { properties: { provisioningState: "Succeeded", securityRules: rulesByNsg[key] } }, network);
  }
  const subnet = (name: string, prefix: string, delegation?: string, nsg?: string) => ({
    name,
    properties: { addressPrefix: prefix, ...(delegation ? { delegations: [{ properties: { serviceName: delegation } }] } : {}), ...(nsg ? { networkSecurityGroup: { id: nsg } } : {}) },
  });
  const vnetId = w.add(
    "Microsoft.Network/virtualNetworks",
    ["zn-k3x9q2-main-vnet"],
    {
      properties: {
        provisioningState: "Succeeded",
        addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
        subnets: [
          subnet("snet-aca", "10.0.254.0/23", "Microsoft.App/environments", nsgIds.aca),
          subnet("snet-pg", "10.0.253.192/26", "Microsoft.DBforPostgreSQL/flexibleServers", nsgIds.pg),
          subnet("snet-pe", "10.0.253.128/26", undefined, nsgIds.pe),
        ],
      },
    },
    network
  );
  for (const n of nodes.filter((x) => x.kind === "subnet")) {
    w.add("Microsoft.Network/virtualNetworks/subnets", ["zn-k3x9q2-main-vnet", scopedName(n.address, { max: 80 })], { properties: { provisioningState: "Succeeded", addressPrefix: n.spec.cidr as string } }, undefined, false);
  }
  void vnetId;
  const lawId = w.add("Microsoft.OperationalInsights/workspaces", ["zn-k3x9q2-main-logs"], { properties: { provisioningState: "Succeeded", sku: { name: "PerGB2018" }, retentionInDays: 30, customerId: WORKSPACE_GUID } }, network);
  w.add("Microsoft.OperationalInsights/workspaces/savedSearches", ["zn-k3x9q2-main-logs", scopedName("log_group/web", { max: 80, suffix: "logs" })], { properties: { query: "x" } }, undefined, false);
  const caeId = w.add("Microsoft.App/managedEnvironments", ["zn-k3x9q2-main-cae"], { properties: { provisioningState: "Succeeded", staticIp: "20.1.2.3" } }, network);
  const cert = { id: `${caeId}/managedCertificates/app-example-com-cert`, name: "app-example-com-cert", properties: { subjectName: "app.example.com", provisioningState: "Succeeded", domainControlValidation: "CNAME" } };
  w.setList(`${caeId}/managedCertificates`, [cert]);
  w.set(cert.id, cert);
  void lawId;

  // ---- identity, registry, secret
  const identity = by("identity/web");
  const uai = w.add("Microsoft.ManagedIdentity/userAssignedIdentities", ["zn-k3x9q2-web-id"], { properties: { principalId: PRINCIPAL_GUID, clientId: "c1c1c1c1-0000-0000-0000-000000000000", tenantId: "t" } }, identity);
  const role = (guid: string) => ({ properties: { principalId: PRINCIPAL_GUID, roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${guid}` } });
  w.setList(`/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments`, [
    role("7f951dda-4ed3-4680-a7ca-43fe172d538d"),
    role("ba92f5b4-2d11-453d-a403-e96b0029c9fe"),
    role("69a216fc-b8fb-44d8-bc22-1f3c2cd27a39"),
    role("4633458b-17de-408a-b874-0445c86b69e6"),
  ]);
  void uai;
  w.add("Microsoft.ContainerRegistry/registries", ["znk3x9q2webacr"], { sku: { name: "Standard" }, properties: { provisioningState: "Succeeded", adminUserEnabled: false, anonymousPullEnabled: false, loginServer: "znk3x9q2webacr.azurecr.io", publicNetworkAccess: "Enabled" } }, by("container_registry/web"));
  w.add(
    "Microsoft.KeyVault/vaults",
    ["zn-k3x9q2-session-9619d9"],
    { properties: { provisioningState: "Succeeded", enableRbacAuthorization: true, enablePurgeProtection: true, softDeleteRetentionInDays: 90, sku: { family: "A", name: "standard" }, vaultUri: "https://zn-k3x9q2-session-9619d9.vault.azure.net/" } },
    by("secret/session-key-1a2b3c4d")
  );
  w.extra.push({ match: "/secrets/SESSION-KEY/versions", body: { value: [{ id: "https://zn-k3x9q2-session-9619d9.vault.azure.net/secrets/SESSION-KEY/0123456789abcdef0123456789abcdef", attributes: { enabled: true } }] } });

  // ---- workloads
  const app = by("container_service/web");
  const appId = w.add(
    "Microsoft.App/containerApps",
    ["zn-k3x9q2-web"],
    {
      properties: {
        provisioningState: "Succeeded",
        latestReadyRevisionName: "zn-k3x9q2-web--r1",
        template: { containers: [{ name: "web", image: "znk3x9q2webacr.azurecr.io/web:latest", resources: { cpu: 0.5, memory: "1Gi" } }], scale: { minReplicas: 2, maxReplicas: 2 } },
        configuration: { ingress: { external: true, targetPort: 8080, fqdn: "zn-k3x9q2-web.happy-sea-123.westeurope.azurecontainerapps.io", customDomains: [{ name: "app.example.com", bindingType: "SniEnabled", certificateId: `${caeId}/managedCertificates/app-example-com-cert` }] } },
        workloadProfileName: "Consumption",
      },
    },
    app
  );
  w.setList(`${appId}/revisions`, [
    { id: `${appId}/revisions/zn-k3x9q2-web--r1`, name: "zn-k3x9q2-web--r1", properties: { active: true, healthState: "Healthy", runningState: "Running", replicas: 2, provisioningState: "Provisioned" } },
    { id: `${appId}/revisions/zn-k3x9q2-web--r0`, name: "zn-k3x9q2-web--r0", properties: { active: false, healthState: "None", runningState: "Stopped", replicas: 0 } },
  ]);
  w.setList(`${appId}/revisions/zn-k3x9q2-web--r1/replicas`, [
    { name: "zn-k3x9q2-web--r1-aaa", properties: { runningState: "Running" } },
    { name: "zn-k3x9q2-web--r1-bbb", properties: { runningState: "Running" } },
  ]);
  const job = by("scheduled_job/report");
  const jobId = w.add(
    "Microsoft.App/jobs",
    ["zn-k3x9q2-report"],
    { properties: { provisioningState: "Succeeded", configuration: { triggerType: "Schedule", scheduleTriggerConfig: { cronExpression: "0 2 * * *" } }, template: { containers: [{ name: "report", image: "ghcr.io/acme/report:1.4.2", resources: { cpu: 0.25, memory: "0.5Gi" } }] } } },
    job
  );
  w.setList(`${jobId}/executions`, [{ name: "e2", properties: { status: "Succeeded" } }, { name: "e1", properties: { status: "Succeeded" } }]);

  // ---- data
  w.add(
    "Microsoft.DBforPostgreSQL/flexibleServers",
    ["zn-k3x9q2-db-pg"],
    {
      sku: { name: "GP_Standard_D2ds_v5", tier: "GeneralPurpose" },
      properties: {
        state: "Ready",
        version: "16",
        storage: { storageSizeGB: 64 },
        highAvailability: { mode: "ZoneRedundant", state: "Healthy" },
        backup: { backupRetentionDays: 14, geoRedundantBackup: "Disabled" },
        network: { publicNetworkAccess: "Disabled" },
        authConfig: { passwordAuth: "Disabled", activeDirectoryAuth: "Enabled" },
        fullyQualifiedDomainName: "zn-k3x9q2-db-pg.private.postgres.database.azure.com",
      },
    },
    by("postgres/db")
  );
  w.add(
    "Microsoft.Cache/redis",
    ["zn-k3x9q2-cache-redis"],
    { properties: { provisioningState: "Succeeded", sku: { name: "Basic", family: "C", capacity: 1 }, enableNonSslPort: false, minimumTlsVersion: "1.2", publicNetworkAccess: "Disabled", hostName: "zn-k3x9q2-cache-redis.redis.cache.windows.net", sslPort: 6380 } },
    by("redis/cache")
  );
  const acct = w.add(
    "Microsoft.Storage/storageAccounts",
    ["znk3x9q2uploads"],
    { properties: { provisioningState: "Succeeded", supportsHttpsTrafficOnly: true, minimumTlsVersion: "TLS1_2", allowBlobPublicAccess: false, allowSharedKeyAccess: false, publicNetworkAccess: "Disabled", primaryEndpoints: { blob: "https://znk3x9q2uploads.blob.core.windows.net/" }, encryption: { services: { blob: { enabled: true } } } } },
    by("object_store/uploads")
  );
  w.set(`${acct}/blobServices/default`, { id: `${acct}/blobServices/default`, name: "default", properties: { isVersioningEnabled: true } });
  w.set(`${acct}/blobServices/default/containers/${containerName("object_store/uploads")}`, { name: containerName("object_store/uploads"), properties: { publicAccess: "None" } });
  const ns = w.add("Microsoft.ServiceBus/namespaces", ["zn-k3x9q2-jobs-bus"], { sku: { name: "Basic", tier: "Basic" }, properties: { provisioningState: "Succeeded", disableLocalAuth: true, minimumTlsVersion: "1.2", serviceBusEndpoint: "https://zn-k3x9q2-jobs-bus.servicebus.windows.net:443/" } }, by("queue/jobs"));
  w.set(`${ns}/queues/${scopedName("queue/jobs", { max: 260 })}`, { name: "jobs", properties: { status: "Active", maxDeliveryCount: 10, countDetails: { activeMessageCount: 4, deadLetterMessageCount: 0, scheduledMessageCount: 0 } } });

  // ---- DNS (customer zone, not tagged)
  const zoneId = `/subscriptions/${SUB}/resourceGroups/dns-rg/providers/Microsoft.Network/dnszones/example.com`;
  w.set(zoneId, { id: zoneId, name: "example.com", type: "Microsoft.Network/dnszones", location: "global", properties: { zoneType: "Public", nameServers: ["ns1-01.azure-dns.com."], numberOfRecordSets: 7 } });
  w.setList(`/subscriptions/${SUB}/providers/Microsoft.Network/dnszones`, [{ id: zoneId, name: "example.com", type: "Microsoft.Network/dnszones", location: "global" }]);
  w.set(`${zoneId}/CNAME/app`, { id: `${zoneId}/CNAME/app`, name: "app", type: "Microsoft.Network/dnszones/CNAME", properties: { TTL: 300, fqdn: "app.example.com.", CNAMERecord: { cname: "zn-k3x9q2-web.happy-sea-123.westeurope.azurecontainerapps.io" } } });
  w.set(`${zoneId}/TXT/asuid.app`, { id: `${zoneId}/TXT/asuid.app`, name: "asuid.app", type: "Microsoft.Network/dnszones/TXT", properties: { TTL: 300 } });
  return w;
}

export const pathOf = (...parts: string[]) => parts.join("");
