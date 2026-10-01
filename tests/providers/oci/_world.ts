/**
 * A scripted "healthy OCI" for one expanded graph: a `FakeOci` that answers the
 * read calls the drivers make with objects consistent with the DESIRED graph
 * (right CIDRs, tags, rules, replica counts, health). It is hand-written from
 * the public API reference; it is NOT OCI and proves only that the drivers
 * read the fields they claim to read and that `expectedAttributes` and
 * `observe` speak the same units. Individual tests then break one thing at a
 * time (delete an object, open a bucket, throttle, deny).
 */
import type { ResourceGraph, ResourceNode } from "@/lib/resources";
import type {
  ContainerServiceSpec,
  DnsRecordSpec,
  DnsZoneSpec,
  FirewallSpec,
  LoadBalancerSpec,
  LogGroupSpec,
  NetworkSpec,
  ObjectStoreSpec,
  PostgresSpec,
  SubnetSpec,
  TlsCertificateSpec,
} from "@/lib/resources/specs";
import { capacity } from "@/lib/providers/oci/drivers/compute/container-instance";
import { retentionFor } from "@/lib/providers/oci/drivers/platform/log-group";
import { queueSettings } from "@/lib/providers/oci/drivers/data/queue";
import { FakeOci, NOW, json, ocid, zenithTagsFor } from "./_support";
import { compileGraph } from "./_support";

export interface World {
  oci: FakeOci;
  graph: ResourceGraph;
  /** id of the object a node's driver should find */
  ids: Map<string, string>;
  /** mutable object stores, so a test can break them */
  db: {
    nsgRules: Map<string, Record<string, unknown>[]>;
    buckets: Map<string, Record<string, unknown>>;
    instances: Map<string, Record<string, unknown>[]>;
    lbHealth: { status: string; critical: string[] };
  };
}

const spec = <T>(n: ResourceNode): T => n.spec as unknown as T;
const tagged = (address: string, extra: Record<string, unknown>) => ({ freeformTags: zenithTagsFor(address), ...extra });
const nodes = (g: ResourceGraph, nativeType: string) => g.nodes.filter((n) => n.nativeType === nativeType);

/** Build the healthy world for `graph`. Identity policy statements come from the compiled fragments. */
export function healthyWorld(graph: ResourceGraph): World {
  const oci = new FakeOci();
  const ids = new Map<string, string>();
  const id = (node: ResourceNode, type: string, suffix = "") => {
    const key = `${node.address}${suffix}`;
    if (!ids.has(key)) ids.set(key, ocid(type, `${node.address.replace(/[^a-z0-9]/g, "")}${suffix.replace(/[^a-z0-9]/g, "")}`));
    return ids.get(key)!;
  };
  const db: World["db"] = { nsgRules: new Map(), buckets: new Map(), instances: new Map(), lbHealth: { status: "OK", critical: [] } };
  const compiled = compileGraph(graph);

  /* ------------------------------ networking ------------------------------ */
  const vcn = nodes(graph, "oci:vcn")[0];
  const vcnItems = vcn
    ? [{ id: id(vcn, "vcn"), lifecycleState: "AVAILABLE", displayName: "vcn", cidrBlock: spec<NetworkSpec>(vcn).cidr, cidrBlocks: [spec<NetworkSpec>(vcn).cidr], ...tagged(vcn.address, {}) }]
    : [];
  oci.route("GET", "/20160918/vcns", () => json(vcnItems));
  for (const v of vcnItems) oci.route("GET", `/20160918/vcns/${v.id}`, () => json(v));
  oci.route("GET", "/20160918/internetGateways", () => json([{ id: "ocid1.internetgateway.oc1..igw000000", lifecycleState: "AVAILABLE", isEnabled: true }]));
  oci.route("GET", "/20160918/natGateways", () => json(vcn && (spec<NetworkSpec>(vcn).egress?.natGateways ?? "single") !== "none" ? [{ id: "ocid1.natgateway.oc1..nat000000", lifecycleState: "AVAILABLE" }] : []));

  const subnets = nodes(graph, "oci:subnet").map((n) => ({ id: id(n, "subnet"), lifecycleState: "AVAILABLE", cidrBlock: spec<SubnetSpec>(n).cidr, prohibitPublicIpOnVnic: spec<SubnetSpec>(n).tier === "private", vcnId: vcnItems[0]?.id, ...tagged(n.address, {}) }));
  oci.route("GET", "/20160918/subnets", () => json(subnets));
  for (const s of subnets) oci.route("GET", `/20160918/subnets/${s.id}`, () => json(s));

  // NSGs: one per owner node, rules from the firewall nodes that target it
  const owners = graph.nodes.filter((n) => ["oci:load_balancer", "oci:container_instance", "oci:postgresql_db_system", "oci:redis_cluster"].includes(n.nativeType) && n.ownership === "managed");
  const nsgId = (address: string) => ocid("networksecuritygroup", `nsg${address.replace(/[^a-z0-9]/g, "")}`);
  const nsgs = owners.map((o) => ({ id: nsgId(o.address), lifecycleState: "AVAILABLE", displayName: `nsg-${o.address}`, ...tagged(o.address, {}) }));
  for (const o of owners) db.nsgRules.set(nsgId(o.address), []);
  for (const fw of nodes(graph, "oci:security_list_rule")) {
    const s = spec<FirewallSpec>(fw);
    const rule: Record<string, unknown> = {
      id: ocid("securityrule", fw.address.replace(/[^a-z0-9]/g, "")),
      direction: "INGRESS",
      protocol: "6",
      isValid: true,
      tcpOptions: { destinationPortRange: { min: s.port, max: s.port } },
      ...("cidr" in s.source ? { sourceType: "CIDR_BLOCK", source: s.source.cidr } : { sourceType: "NETWORK_SECURITY_GROUP", source: nsgId(s.source.address) }),
    };
    db.nsgRules.get(nsgId(s.target))!.push(rule);
  }
  oci.route("GET", "/20160918/networkSecurityGroups", () => json(nsgs));
  oci.route("GET", /^\/20160918\/networkSecurityGroups\/[^/]+\/securityRules$/, (req) => json(db.nsgRules.get(req.path.split("/")[3]) ?? []));

  /* ------------------------------ load balancer ---------------------------- */
  const lb = nodes(graph, "oci:load_balancer")[0];
  if (lb) {
    const s = spec<LoadBalancerSpec>(lb);
    const lbId = id(lb, "loadbalancer");
    const listeners = Object.fromEntries(s.listeners.map((l) => [`${l.protocol}_${l.port}`, { name: `${l.protocol}_${l.port}`, port: l.port, protocol: "HTTP" }]));
    const sets = Object.fromEntries([...new Set(s.routes.map((r) => r.target))].map((t) => [`bs_${t.split("/")[1]}`, { name: `bs_${t.split("/")[1]}` }]));
    const item = () => ({ id: lbId, lifecycleState: "ACTIVE", displayName: "lb", shapeName: "flexible", isPrivate: false, listeners, backendSets: sets, ipAddresses: [{ ipAddress: "203.0.113.10", isPublic: true }], ...tagged(lb.address, {}) });
    oci.route("GET", "/20170115/loadBalancers", () => json([item()]));
    oci.route("GET", `/20170115/loadBalancers/${lbId}`, () => json(item()));
    oci.route("GET", `/20170115/loadBalancers/${lbId}/health`, () =>
      json({ status: db.lbHealth.status, totalBackendSetCount: Object.keys(sets).length, criticalStateBackendSetNames: db.lbHealth.critical, warningStateBackendSetNames: [], unknownStateBackendSetNames: [] })
    );
    oci.route("GET", new RegExp(`^/20170115/loadBalancers/${lbId}/backendSets/[^/]+/health$`), () => json({ status: db.lbHealth.critical.length ? "CRITICAL" : "OK", totalBackendCount: 2, criticalStateBackendNames: db.lbHealth.critical.length ? ["10.0.1.4:3000"] : [], unknownStateBackendNames: [], warningStateBackendNames: [] }));
  }

  /* --------------------------- certificate and DNS ------------------------- */
  for (const c of nodes(graph, "oci:certificate")) {
    const domain = spec<TlsCertificateSpec>(c).domain;
    const cid = id(c, "certificate");
    const summary = { id: cid, name: domain, lifecycleState: "ACTIVE" };
    oci.route("GET", "/20210224/certificates", () => json({ items: [summary] }));
    oci.route("GET", `/20210224/certificates/${cid}`, () =>
      json({ ...summary, configType: "IMPORTED", subject: { commonName: domain }, currentVersion: { validity: { timeOfValidityNotAfter: new Date(NOW.getTime() + 90 * 86_400_000).toISOString() }, subjectAlternativeNames: [{ type: "DNS", value: domain }] } })
    );
  }
  oci.route("GET", "/20180115/zones", () => json(nodes(graph, "oci:dns_zone").map((z) => ({ id: id(z, "dns-zone"), name: spec<DnsZoneSpec>(z).name, zoneType: "PRIMARY", lifecycleState: "ACTIVE" }))));
  for (const z of nodes(graph, "oci:dns_zone")) {
    const name = spec<DnsZoneSpec>(z).name;
    oci.route("GET", `/20180115/zones/${name}`, () => json({ id: id(z, "dns-zone"), name, zoneType: "PRIMARY", lifecycleState: "ACTIVE" }));
  }
  for (const r of nodes(graph, "oci:dns_rrset")) {
    const s = spec<DnsRecordSpec>(r);
    const zone = s.zone.split("/")[1];
    oci.route("GET", `/20180115/zones/${zone}/records/${s.name}/A`, () => json({ items: [{ domain: s.name, rtype: "A", rdata: "203.0.113.10", ttl: 300 }] }));
  }

  /* ---------------------------- container instances ------------------------- */
  const containerImages = new Map<string, string>();
  const ciNodes = nodes(graph, "oci:container_instance").filter((n) => n.ownership === "managed");
  for (const n of ciNodes) {
    const s = spec<ContainerServiceSpec>(n);
    const cap = capacity(s);
    const insts = Array.from({ length: s.replicas }, (_, i) => {
      const iid = id(n, "computecontainerinstance", `r${i}`);
      containerImages.set(`c-${iid}`, s.artifact.type === "image" ? s.artifact.ref : "unknown");
      return { id: iid, lifecycleState: "ACTIVE", displayName: `${n.address}-${i + 1}`, shape: s.shape ?? "CI.Standard.E4.Flex", shapeConfig: { ocpus: cap.ocpus, memoryInGBs: cap.memoryGb }, faultDomain: `FAULT-DOMAIN-${(i % 3) + 1}`, availabilityDomain: "AD-1", containers: [{ containerId: `c-${iid}` }], ...tagged(n.address, {}) };
    });
    db.instances.set(n.address, insts);
  }
  oci.route("GET", "/20210415/containerInstances", () => json({ items: [...db.instances.values()].flat() }));
  oci.route("GET", /^\/20210415\/containerInstances\/[^/]+$/, (req) => {
    const found = [...db.instances.values()].flat().find((i) => i.id === req.path.split("/")[3]);
    return found ? json(found) : json({ code: "NotAuthorizedOrNotFound", message: "x" }, {}, 404);
  });
  oci.route("GET", /^\/20210415\/containers\/[^/]+$/, (req) => {
    const cid = req.path.split("/")[3];
    return containerImages.has(cid) ? json({ containerId: cid, imageUrl: containerImages.get(cid), lifecycleState: "ACTIVE" }) : json({ code: "NotAuthorizedOrNotFound", message: "x" }, {}, 404);
  });

  /* ------------------------------- registries etc. ------------------------- */
  const repos = nodes(graph, "oci:container_repository").map((n) => ({ id: id(n, "containerrepo"), displayName: n.address, isPublic: false, isImmutable: false, lifecycleState: "AVAILABLE", ...tagged(n.address, {}) }));
  oci.route("GET", "/20160918/container/repositories", () => json({ items: repos }));
  for (const r of repos) oci.route("GET", `/20160918/container/repositories/${r.id}`, () => json(r));

  for (const n of nodes(graph, "oci:postgresql_db_system")) {
    const s = spec<PostgresSpec>(n);
    const item = {
      id: id(n, "postgresqldbsystem"),
      displayName: "db",
      lifecycleState: "ACTIVE",
      dbVersion: String(s.version),
      instanceCount: s.highAvailability ? 2 : 1,
      shape: "VM.Standard.E4.Flex",
      instances: Array.from({ length: s.highAvailability ? 2 : 1 }, () => ({ lifecycleState: "ACTIVE" })),
      managementPolicy: { backupPolicy: { kind: s.backup === "none" ? "NONE" : "DAILY" } },
      storageDetails: { isRegionallyDurable: s.highAvailability },
      ...tagged(n.address, {}),
    };
    oci.route("GET", "/20220915/dbSystems", () => json({ items: [item] }));
    oci.route("GET", `/20220915/dbSystems/${item.id}`, () => json(item));
  }

  // object storage
  oci.route("GET", "/n", () => json("tenantns"));
  for (const b of nodes(graph, "oci:object_storage_bucket")) {
    const s = spec<ObjectStoreSpec>(b);
    const name = `bucket-${b.address.split("/")[1]}`;
    db.buckets.set(name, { name, publicAccessType: "NoPublicAccess", versioning: s.versioning ? "Enabled" : "Disabled", storageTier: "Standard", freeformTags: zenithTagsFor(b.address) });
  }
  oci.route("GET", "/n/tenantns/b", () => json([...db.buckets.values()].map((b) => ({ name: b.name, freeformTags: b.freeformTags }))));
  oci.route("GET", /^\/n\/tenantns\/b\/[^/]+$/, (req) => {
    const b = db.buckets.get(decodeURIComponent(req.path.split("/")[4]));
    return b ? json(b) : json({ code: "BucketNotFound", message: "x" }, {}, 404);
  });

  for (const q of nodes(graph, "oci:queue")) {
    const s = queueSettings(q);
    const qid = id(q, "queue");
    const item = { id: qid, displayName: "jobs", lifecycleState: "ACTIVE", retentionInSeconds: s.retentionSeconds, visibilityInSeconds: s.visibilitySeconds, messagesEndpoint: "https://cell-1.queue.messaging.us-ashburn-1.oci.oraclecloud.com", ...tagged(q.address, {}) };
    oci.route("GET", "/20210201/queues", () => json({ items: [item] }));
    oci.route("GET", `/20210201/queues/${qid}`, () => json(item));
    oci.route("GET", `/20210201/queues/${qid}/stats`, () => json({ queue: { visibleMessages: 4, inFlightMessages: 1, sizeInBytes: 10 }, dlq: { visibleMessages: 0, inFlightMessages: 0, sizeInBytes: 0 } }));
  }

  const secrets = nodes(graph, "oci:vault_secret").filter((n) => n.ownership === "managed").map((n) => ({ id: id(n, "vaultsecret"), secretName: n.address, lifecycleState: "ACTIVE", currentVersionNumber: 2, ...tagged(n.address, {}) }));
  oci.route("GET", "/20180608/secrets", () => json(secrets.map((s) => ({ ...s, currentVersionNumber: undefined }))));
  for (const s of secrets) oci.route("GET", `/20180608/secrets/${s.id}`, () => json(s));

  // identity: dynamic groups (+ the compiled policy statements)
  const statementsOf = (address: string): string[] => {
    const f = compiled.fragments.get(address);
    const pol = f?.resource?.oci_identity_policy ? Object.values(f.resource.oci_identity_policy)[0] : undefined;
    return (pol?.statements as string[] | undefined) ?? [];
  };
  const dgs = nodes(graph, "oci:dynamic_group").map((n) => ({ id: id(n, "dynamicgroup"), name: `dg-${n.address}`, lifecycleState: "ACTIVE", matchingRule: `ALL {resource.type='computecontainerinstance', resource.compartment.id='c', tag.zenith_environment.value='${graph.environmentId}', tag.zenith_resource.value='${spec<{ workload: string }>(n).workload}'}`, ...tagged(n.address, {}) }));
  oci.route("GET", "/20160918/dynamicGroups", () => json(dgs));
  for (const d of dgs) oci.route("GET", `/20160918/dynamicGroups/${d.id}`, () => json(d));
  oci.route("GET", "/20160918/policies", () => json(nodes(graph, "oci:dynamic_group").map((n) => ({ id: id(n, "policy"), name: `p-${n.address}`, lifecycleState: "ACTIVE", statements: statementsOf(n.address), ...tagged(n.address, {}) }))));

  // logging
  const logGroups = nodes(graph, "oci:log_group").map((n) => ({ id: id(n, "loggroup"), displayName: n.address, lifecycleState: "ACTIVE", ...tagged(n.address, {}) }));
  oci.route("GET", "/20200531/logGroups", () => json(logGroups));
  for (const g of logGroups) {
    oci.route("GET", `/20200531/logGroups/${g.id}`, () => json(g));
    const n = graph.nodes.find((x) => ids.get(x.address) === g.id)!;
    oci.route("GET", `/20200531/logGroups/${g.id}/logs`, () => json([{ id: "ocid1.log.oc1..l", lifecycleState: "ACTIVE", retentionDuration: retentionFor(n, spec<LogGroupSpec>(n).retentionDays), ...tagged(n.address, {}) }]));
  }

  // redis
  for (const n of nodes(graph, "oci:redis_cluster")) {
    const item = { id: id(n, "rediscluster"), displayName: "cache", lifecycleState: "ACTIVE", nodeCount: spec<{ highAvailability?: boolean }>(n).highAvailability ? 3 : 1, softwareVersion: "REDIS_7_0", ...tagged(n.address, {}) };
    oci.route("GET", "/20220315/redisClusters", () => json({ items: [item] }));
    oci.route("GET", `/20220315/redisClusters/${item.id}`, () => json(item));
  }

  // block volumes (not in the web stack; present when a test adds one)
  const volumes = nodes(graph, "oci:block_volume").map((n) => ({ id: id(n, "volume"), lifecycleState: "AVAILABLE", displayName: n.address, sizeInGBs: spec<{ sizeGb?: number }>(n).sizeGb ?? 50, availabilityDomain: "AD-1", ...tagged(n.address, {}) }));
  oci.route("GET", "/20160918/volumes", () => json(volumes));
  for (const v of volumes) oci.route("GET", `/20160918/volumes/${v.id}`, () => json(v));

  // the three mutating calls the operations make: accepted by default; tests override per case
  oci.route("PUT", /^\/20180608\/secrets\/[^/]+$/, json({}, {}, 200));
  oci.route("POST", /^\/20210415\/containerInstances\/[^/]+\/actions\/restart$/, json({}, { "opc-work-request-id": "wr" }, 202));
  oci.route("POST", "/20220915/backups", json({}, { "opc-work-request-id": "wr" }, 202));

  return { oci, graph, ids, db };
}
