/**
 * Enhanced OKE cluster with a private API and OCI_VCN_IP_NATIVE pods. Enhanced
 * clusters support OCI workload identity; applications still need scoped IAM
 * policies and an OCI SDK. OIDC discovery is enabled, not external-user auth.
 * Node pool and pods share the node NSG; the endpoint has a separate NSG.
 * Only endpoint, public CA data and OIDC discovery are published for sessions;
 * never publish kubeconfig content or an authentication token. Contract only.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, interp, nodeCloudName, zenithTags } from "../../naming";
import { strictArrayOrItems, asArray, asNumber, asRecord, asString, attributesOf, discoverWith, locate, observationOf, runtimeOf, verifyWith, type LocateDef } from "../../observe-kit";
import { ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { addressList, assertCidr, isManaged, protectFromDestroy, readOnlyFragment, res, specOf } from "../shared";
import type { OkeClusterSpec } from "./specs";
import { boundedNumber, flexibleShape, imageId, privatePlacement } from "./support";

const NATIVE = "oci:oke_cluster";
const ID = ociDriverId(NATIVE);
export function compileOkeCluster(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<OkeClusterSpec>(node);
  if (typeof spec.version !== "string" || !/^v?1\.[0-9]{1,2}\.[0-9]{1,2}$/.test(spec.version)) throw new OciCompileError(`${node.address}: version must be an explicit Kubernetes version, such as v1.34.1.`);
  const version = spec.version.startsWith("v") ? spec.version : `v${spec.version}`;
  const image = imageId(node, spec.nodeImageOcid);
  const shape = flexibleShape(node, spec.nodeShape);
  const count = boundedNumber(node, "nodeCount", spec.nodeCount, 2, 1, 100);
  const ocpus = boundedNumber(node, "nodeOcpus", spec.nodeOcpus, 1, 1, 64);
  const memory = boundedNumber(node, "nodeMemoryGb", spec.nodeMemoryGb, ocpus * 16, ocpus, Math.min(1024, ocpus * 64));
  if (spec.apiAccessCidrs !== undefined && (!Array.isArray(spec.apiAccessCidrs) || spec.apiAccessCidrs.length > 16)) throw new OciCompileError(`${node.address}: apiAccessCidrs must contain at most 16 IPv4 CIDRs.`);
  const cidrs = [...new Set((spec.apiAccessCidrs ?? []).map((value) => assertCidr(node, value, "API client CIDR")))].sort();
  if (cidrs.some((cidr) => Number(cidr.split("/")[1]) < 8)) throw new OciCompileError(`${node.address}: API client CIDRs cannot admit the public internet.`);
  const placement = privatePlacement(ctx, node);
  const compartment = compartmentOf(ctx);
  const tags = zenithTags(ctx, node);
  const cluster = res("oci_containerengine_cluster", node);
  const pool = res("oci_containerengine_node_pool", node, "_nodes");
  const nsg = res("oci_core_network_security_group", node, "_nsg");
  const endpointNsg = res("oci_core_network_security_group", node, "_endpoint_nsg");
  const ad = res("oci_identity_availability_domain", node, "_ad");
  const kubeconfig = res("oci_containerengine_cluster_kube_config", node, "_session");
  const rules: Record<string, Record<string, unknown>> = {};
  const rule = (suffix: string, target: string, source: string, port?: number, sourceType = "NETWORK_SECURITY_GROUP") => {
    const r = res("oci_core_network_security_group_security_rule", node, suffix);
    rules[r.label] = { network_security_group_id: interp(`${target}.id`), direction: "INGRESS", protocol: port ? "6" : "all", source, source_type: sourceType, stateless: false, ...(port ? { tcp_options: { destination_port_range: { min: port, max: port } } } : {}) };
    return r.address;
  };
  const ruleAddresses = [
    rule("_nodes_internal", nsg.address, interp(`${nsg.address}.id`)),
    rule("_api_nodes", endpointNsg.address, interp(`${nsg.address}.id`), 6443),
    rule("_identity_nodes", endpointNsg.address, interp(`${nsg.address}.id`), 12250),
    rule("_kubelet", nsg.address, interp(`${endpointNsg.address}.id`), 10250),
    ...cidrs.map((cidr, i) => rule(`_api_client_${i}`, endpointNsg.address, cidr, 6443, "CIDR_BLOCK")),
  ];
  const subnetIds = placement.subnets.map((address) => ctx.ref(address, "id"));
  const session = `yamldecode(data.${kubeconfig.address}.content).clusters[0].cluster`;
  return {
    data: {
      oci_identity_availability_domain: { [ad.label]: { compartment_id: compartment, ad_number: 1 } },
      oci_containerengine_cluster_kube_config: { [kubeconfig.label]: { cluster_id: interp(`${cluster.address}.id`), endpoint: "PRIVATE_ENDPOINT", token_version: "2.0.0" } },
    },
    resource: {
      oci_core_network_security_group: {
        [nsg.label]: { compartment_id: compartment, vcn_id: ctx.ref(placement.network, "id"), display_name: `${nodeCloudName(ctx, node)}-nodes`, freeform_tags: tags },
        [endpointNsg.label]: { compartment_id: compartment, vcn_id: ctx.ref(placement.network, "id"), display_name: `${nodeCloudName(ctx, node)}-endpoint`, freeform_tags: { ...tags, zenith_resource: `${node.address}:endpoint` } },
      },
      oci_core_network_security_group_security_rule: rules,
      oci_containerengine_cluster: { [cluster.label]: {
        compartment_id: compartment, name: nodeCloudName(ctx, node), kubernetes_version: version, vcn_id: ctx.ref(placement.network, "id"), type: "ENHANCED_CLUSTER",
        cluster_pod_network_options: { cni_type: "OCI_VCN_IP_NATIVE" },
        endpoint_config: { is_public_ip_enabled: false, subnet_id: subnetIds[0], nsg_ids: [interp(`${endpointNsg.address}.id`)] },
        options: { open_id_connect_discovery: { is_open_id_connect_discovery_enabled: true }, add_ons: { is_kubernetes_dashboard_enabled: false, is_tiller_enabled: false } },
        depends_on: ruleAddresses,
        freeform_tags: tags, ...protectFromDestroy(spec),
      } },
      oci_containerengine_node_pool: { [pool.label]: {
        compartment_id: compartment, cluster_id: interp(`${cluster.address}.id`), name: `${nodeCloudName(ctx, node)}-nodes`, kubernetes_version: version,
        node_shape: shape, node_shape_config: { ocpus, memory_in_gbs: memory }, node_source_details: { source_type: "IMAGE", image_id: image },
        node_config_details: {
          size: count, placement_configs: { availability_domain: interp(`data.${ad.address}.name`), subnet_id: subnetIds[0] },
          nsg_ids: [interp(`${nsg.address}.id`)], is_pv_encryption_in_transit_enabled: true, freeform_tags: tags,
          node_pool_pod_network_option_details: { cni_type: "OCI_VCN_IP_NATIVE", pod_subnet_ids: subnetIds, pod_nsg_ids: [interp(`${nsg.address}.id`)] },
        },
        freeform_tags: tags, ...protectFromDestroy(spec),
      } },
    },
    locals: {
      [auxName(node.address, "nsg_id")]: interp(`${nsg.address}.id`),
      [auxName(node.address, "endpoint_nsg_id")]: interp(`${endpointNsg.address}.id`),
      [auxName(node.address, "endpoint")]: interp(`${session}.server`),
      [auxName(node.address, "ca_data")]: interp(`${session}["certificate-authority-data"]`),
      [auxName(node.address, "oidc_issuer_url")]: interp(`${cluster.address}.open_id_connect_discovery_endpoint`),
    },
    addresses: addressList(cluster.address, [pool.address, nsg.address, endpointNsg.address, `data.${ad.address}`, `data.${kubeconfig.address}`, ...ruleAddresses]),
  };
}

const def: LocateDef = {
  service: "containerengine", get: (id) => ({ path: ociPath("containerengine", "clusters", id) }),
  list: (compartmentId) => ({ path: ociPath("containerengine", "clusters"), query: { compartmentId } }),
  items: strictArrayOrItems, idOf: (i) => asString(asRecord(i)?.id),
};
const expected = (node: ResourceNode) => ({ version: typeof node.spec.version === "string" ? (node.spec.version.startsWith("v") ? node.spec.version : `v${node.spec.version}`) : undefined, type: "ENHANCED_CLUSTER", publicEndpoint: false, cni: "OCI_VCN_IP_NATIVE", oidcDiscovery: true });
export const okeClusterDriver: ResourceDriver<OciSession> = {
  id: ID, provider: "oci", kind: "kubernetes_cluster", nativeType: NATIVE,
  capabilities: ociCapabilities({ compile: true, observe: true, runtime: true, verify: true, discover: true }),
  compile: compileOkeCluster, expectedAttributes: expected,
  observe: async (ctx, node, externalId) => {
    const found = await locate(ctx, node, externalId, def);
    if (found.presence !== "present" || !found.externalId) return observationOf(ctx, node, ID, found);
    const r = await ociCall(ctx, { service: def.service, region: node.region || ctx.region, method: "GET", ...def.get!(found.externalId) });
    if (r.requestId) found.requestIds.push(r.requestId);
    const full = r.ok ? asRecord(r.body) : undefined;
    const endpoint = asRecord(full?.endpointConfig);
    const cnis = asArray(full?.clusterPodNetworkOptions).map((i) => asString(asRecord(i)?.cniType));
    const discovery = asRecord(asRecord(full?.options)?.openIdConnectDiscovery);
    return observationOf(ctx, node, ID, found, attributesOf(ctx.now().toISOString(), {
      version: asString(full?.kubernetesVersion), type: asString(full?.type),
      publicEndpoint: typeof endpoint?.isPublicIpEnabled === "boolean" ? endpoint.isPublicIpEnabled : undefined,
      cni: cnis.length === 1 ? cnis[0] : undefined,
      oidcDiscovery: typeof discovery?.isOpenIdConnectDiscoveryEnabled === "boolean" ? discovery.isOpenIdConnectDiscoveryEnabled : undefined,
    }), { lifecycleState: full?.lifecycleState, type: full?.type });
  },
  runtime: async (ctx, node, externalId) => {
    const found = await locate(ctx, node, externalId, def);
    if (found.presence !== "present" || !found.externalId) return runtimeOf(ctx, node, ID, "unknown", {}, [`presence:${found.presence}`]);
    const clusterState = asString(found.item?.lifecycleState);
    // The compilation owns one pool. List summaries cannot prove node health;
    // get the exact tagged pool and inspect the provider's node lifecycle states.
    const poolDef: LocateDef = {
      service: "containerengine", get: (id) => ({ path: ociPath("containerengine", "nodePools", id) }),
      list: (compartmentId) => ({ path: ociPath("containerengine", "nodePools"), query: { compartmentId, clusterId: found.externalId } }),
      items: strictArrayOrItems, idOf: def.idOf,
    };
    const pool = await locate(ctx, node, undefined, poolDef);
    if (pool.presence !== "present" || !pool.externalId) return runtimeOf(ctx, node, ID, "unknown", {}, [`state:${clusterState ?? "unknown"}`, `node_pool:${pool.presence}`]);
    const r = await ociCall(ctx, { service: "containerengine", region: node.region || ctx.region, method: "GET", ...poolDef.get!(pool.externalId) });
    const full = r.ok ? asRecord(r.body) : undefined;
    const desired = asNumber(asRecord(full?.nodeConfigDetails)?.size);
    if (full && full.clusterId !== found.externalId) return runtimeOf(ctx, node, ID, "unknown", {}, ["node_pool:cluster_binding_unconfirmed"]);
    const nodes = asArray(full?.nodes);
    const states = nodes.map((i) => asString(asRecord(i)?.lifecycleState));
    const active = states.filter((state) => state === "ACTIVE").length;
    const counts = { ...(desired === undefined ? {} : { desired }), ...(Array.isArray(full?.nodes) ? { active, total: nodes.length } : {}) };
    const healthy = clusterState === "ACTIVE" && full?.lifecycleState === "ACTIVE" && desired !== undefined && desired > 0 && desired === active && nodes.length === desired;
    const complete = desired !== undefined && Array.isArray(full?.nodes) && states.every((state) => state !== undefined);
    const health = clusterState === "FAILED" || full?.lifecycleState === "FAILED" ? "unhealthy" : !complete || !clusterState || !asString(full?.lifecycleState) ? "unknown" : healthy ? "healthy" : "degraded";
    return runtimeOf(ctx, node, ID, health, counts, [`state:${clusterState ?? "unknown"}`, `node_pool:${asString(full?.lifecycleState) ?? "unknown"}`]);
  },
  verify: async (ctx, node, observation, runtime) => verifyWith({ node, observation, expected: expected(node), runtime, now: ctx.now() }),
  discover: (ctx) => discoverWith(ctx, { ...def, kind: "kubernetes_cluster", nativeType: NATIVE, nameOf: (i) => asString(i.name) ?? "cluster", attributes: (i) => ({ state: asString(i.lifecycleState) ?? "", version: asString(i.kubernetesVersion) ?? "" }) }),
};
