/** Hand-built OCI graph nodes and synthetic HTTP responses; no cloud acceptance. */
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { expandOci, FakeOci, json, ocid, zenithTagsFor } from "./_support";

export const IMAGE = ocid("image", "oraclelinux");
export function moreGraph(base = expandOci()): ResourceGraph {
  const template = base.nodes.find((n) => n.kind === "network")!;
  const make = (address: string, kind: ResourceNode["kind"], nativeType: string, spec: ResourceNode["spec"]): ResourceNode => ({ ...template, address, kind, nativeType, spec, dependsOn: base.nodes.filter((n) => n.kind === "subnet" && n.spec.tier === "private").map((n) => n.address), origin: [] });
  return { ...base, nodes: [...base.nodes,
    make("compute_instance/machine", "compute_instance", "oci:compute_instance", { imageOcid: IMAGE, cloudInit: "#cloud-config\npackages:\n  - jq\n" }),
    make("kubernetes_cluster/cluster", "kubernetes_cluster", "oci:oke_cluster", { version: "v1.34.1", nodeImageOcid: IMAGE, nodeCount: 2 }),
    make("mysql/db", "mysql", "oci:mysql_db_system", { engine: "mysql", version: "8.4.6", highAvailability: true, backup: "daily", credentials: "generated" }),
  ] };
}

export function populateMoreWorld(oci: FakeOci, graph: ResourceGraph, ids: Map<string, string>): void {
  const collections = [
    ["oci:compute_instance", "core", "/20160918/instances", "instance"],
    ["oci:oke_cluster", "containerengine", "/20180222/clusters", "cluster"],
    ["oci:mysql_db_system", "mysql", "/20190415/dbSystems", "mysqldbsystem"],
  ];
  const pools: Record<string, unknown>[] = [];
  for (const [native, service, path, type] of collections) {
    const items = graph.nodes.filter((n) => n.nativeType === native).map((node) => {
      const id = ocid(type, node.address.replace(/[^a-z]/g, ""));
      ids.set(node.address, id);
      const common = { id, lifecycleState: native === "oci:compute_instance" ? "RUNNING" : "ACTIVE", displayName: node.address, name: node.address, freeformTags: zenithTagsFor(node.address, graph.environmentId) };
      if (native === "oci:compute_instance") return { ...common, shape: "VM.Standard.E4.Flex", sourceDetails: { imageId: IMAGE }, isPvEncryptionInTransitEnabled: true };
      if (native === "oci:mysql_db_system") return { ...common, mysqlVersion: "8.4.6", isHighlyAvailable: true, backupPolicy: { isEnabled: true } };
      const pool = { ...common, id: ocid("nodepool", "pool"), clusterId: id, nodeConfigDetails: { size: 2 }, nodes: [{ lifecycleState: "ACTIVE" }, { lifecycleState: "ACTIVE" }] };
      pools.push(pool);
      return { ...common, kubernetesVersion: "v1.34.1", type: "ENHANCED_CLUSTER", endpointConfig: { isPublicIpEnabled: false }, clusterPodNetworkOptions: [{ cniType: "OCI_VCN_IP_NATIVE" }], options: { openIdConnectDiscovery: { isOpenIdConnectDiscoveryEnabled: true } } };
    });
    oci.on((req) => req.service === service && req.method === "GET" && req.path === path ? json(service === "core" ? items : { items }) : undefined);
    for (const item of items) oci.on((req) => req.service === service && req.method === "GET" && req.path === `${path}/${item.id}` ? json(item) : undefined);
  }
  oci.route("GET", "/20180222/nodePools", (req) => json({ items: pools.filter((p) => p.clusterId === req.query?.clusterId) }));
  for (const pool of pools) oci.route("GET", `/20180222/nodePools/${pool.id}`, json(pool));
}
