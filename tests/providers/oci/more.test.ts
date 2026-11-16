/** New OCI driver contracts: pure compile, private defaults and honest HTTP reads. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ResourceNode } from "@/lib/resources/types";
import { ociPrimaryAddress, auxName } from "@/lib/providers/oci/naming";
import { OciCompileError } from "@/lib/providers/oci/errors";
import { isAllowed } from "@/lib/providers/oci/allowlist";
import { createRunnerOciTransport } from "@/lib/providers/oci/runner-transport";
import { compileContext, driverContext, driverFor, err, FakeOci, json, nodeOf, ocid, resourcesOf, zenithTagsFor } from "./_support";
import { IMAGE, moreGraph } from "./_more";
import { healthyWorld } from "./_world";

const graph = moreGraph();
const ctx = compileContext(graph);
const vm = nodeOf(graph, "compute_instance/machine");
const oke = nodeOf(graph, "kubernetes_cluster/cluster");
const mysql = nodeOf(graph, "mysql/db");
const nodes = [vm, oke, mysql];
const compile = (node: ResourceNode) => driverFor(node).compile!(node, ctx);
const body = (node: ResourceNode, type: string) => resourcesOf(compile(node)).find((r) => r.type === type)!.body;

describe("private compilation", () => {
  it.each([vm, oke])("$nativeType compiles deterministically with complete address ownership", (node) => {
    const f = compile(node);
    expect(compile(node)).toEqual(f);
    const addresses = [...resourcesOf(f).map((r) => `${r.type}.${r.name}`), ...Object.entries(f.data ?? {}).flatMap(([t, names]) => Object.keys(names).map((name) => `data.${t}.${name}`))];
    expect(f.addresses[0]).toBe(ociPrimaryAddress(node));
    expect(new Set(f.addresses).size).toBe(f.addresses.length);
    expect([...f.addresses].sort()).toEqual(addresses.sort());
    expect(f.locals![auxName(node.address, "nsg_id")]).toContain("_nsg.id");
    expect(JSON.stringify(f)).not.toMatch(/"provisioner"|"connection"|file\(|templatefile\(|"password"|"secret_content"/);
  });

  it("VM has private VNIC, encrypted boot disk, IMDSv2 and enabled OS Management Hub", () => {
    expect(body(vm, "oci_core_instance")).toMatchObject({
      source_details: { source_type: "image", source_id: IMAGE, boot_volume_size_in_gbs: 50 },
      create_vnic_details: { assign_public_ip: false, subnet_id: "${oci_core_subnet.subnet_private_a.id}", nsg_ids: ["${oci_core_network_security_group.compute_instance_machine_nsg.id}"] },
      is_pv_encryption_in_transit_enabled: true, lifecycle: { prevent_destroy: true },
      instance_options: { are_legacy_imds_endpoints_disabled: true },
      agent_config: { is_management_disabled: false, plugins_config: [{ name: "OS Management Hub Agent", desired_state: "ENABLED" }] },
    });
  });

  it("cloud-init stays literal metadata, including Terraform-shaped strings", () => {
    const cloudInit = '#cloud-config\nwrite_files:\n  - path: /etc/example\n    content: ${file("/forbidden")}\n';
    const node = { ...vm, spec: { ...vm.spec, cloudInit } };
    const metadata = body(node, "oci_core_instance").metadata as Record<string, string>;
    expect(Object.keys(metadata)).toEqual(["user_data"]);
    expect(Buffer.from(metadata.user_data, "base64").toString("utf8")).toBe(cloudInit);
    expect(JSON.stringify(compile(node))).not.toContain("/forbidden");
  });

  it.each([
    "#cloud-config\npassword: CANARY_CREDENTIAL\n", "#cloud-config\nsecretRef: vault:password\n",
    "#cloud-config\nruncmd:\n  - [echo, 'TOKEN=CANARY_CREDENTIAL']\n",
    "#cloud-config\nwrite_files:\n - path: /tmp/key\n   content: '-----BEGIN RSA PRIVATE KEY-----'\n",
    "#cloud-config\npackages: [\n", "#!/bin/sh\necho hi", "#cloud-config\n" + "x".repeat(24000),
  ])("refuses unsafe or malformed cloud-init without echoing it %#", (cloudInit) => {
    try { compile({ ...vm, spec: { ...vm.spec, cloudInit } }); throw new Error("accepted unsafe cloud-init"); }
    catch (error) { expect(error).toBeInstanceOf(OciCompileError); expect(String(error)).not.toContain("CANARY_CREDENTIAL"); }
  });

  it("OKE uses enhanced cluster, private endpoint and VCN-native pods/nodes", () => {
    expect(body(oke, "oci_containerengine_cluster")).toMatchObject({ type: "ENHANCED_CLUSTER", cluster_pod_network_options: { cni_type: "OCI_VCN_IP_NATIVE" }, endpoint_config: { is_public_ip_enabled: false, subnet_id: "${oci_core_subnet.subnet_private_a.id}" }, options: { open_id_connect_discovery: { is_open_id_connect_discovery_enabled: true } }, lifecycle: { prevent_destroy: true } });
    expect(body(oke, "oci_containerengine_node_pool")).toMatchObject({ node_source_details: { source_type: "IMAGE", image_id: IMAGE }, node_config_details: { size: 2, nsg_ids: ["${oci_core_network_security_group.kubernetes_cluster_cluster_nsg.id}"], placement_configs: { subnet_id: "${oci_core_subnet.subnet_private_a.id}" }, node_pool_pod_network_option_details: { cni_type: "OCI_VCN_IP_NATIVE", pod_nsg_ids: ["${oci_core_network_security_group.kubernetes_cluster_cluster_nsg.id}"] } }, lifecycle: { prevent_destroy: true } });
    const f = compile(oke);
    expect(f.locals!.kubernetes_cluster_cluster_endpoint).toContain(".server");
    expect(f.locals!.kubernetes_cluster_cluster_ca_data).toContain('certificate-authority-data');
    expect(f.locals!.kubernetes_cluster_cluster_oidc_issuer_url).toContain("open_id_connect_discovery_endpoint");
    expect(f.data!.oci_containerengine_cluster_kube_config.kubernetes_cluster_cluster_session).toMatchObject({ endpoint: "PRIVATE_ENDPOINT", token_version: "2.0.0" });
    expect(Object.keys(f.output ?? {})).toEqual([]);
  });

  it("OKE internal rules are NSG scoped; explicit API clients are restricted and deterministic", () => {
    const spec = { ...oke.spec, apiAccessCidrs: ["10.4.0.0/16", "10.2.0.0/16", "10.4.0.0/16"] };
    const f = compile({ ...oke, spec });
    const rules = resourcesOf(f).filter((r) => r.type === "oci_core_network_security_group_security_rule");
    expect(rules.filter((r) => r.body.source_type === "CIDR_BLOCK").map((r) => r.body.source)).toEqual(["10.2.0.0/16", "10.4.0.0/16"]);
    expect(rules.filter((r) => r.body.source_type === "NETWORK_SECURITY_GROUP")).toHaveLength(4);
    expect(resourcesOf(f).filter((r) => r.type === "oci_core_network_security_group").map((r) => (r.body.freeform_tags as Record<string, string>).zenith_resource).sort()).toEqual([oke.address, `${oke.address}:endpoint`].sort());
  });

  it.each([vm, oke])("$nativeType protects deletion unless explicitly allowed and respects foreign ownership", (node) => {
    for (const ownership of ["referenced", "external"] as const) expect(compile({ ...node, ownership, spec: {} })).toEqual({ addresses: [] });
    const allowed = compile({ ...node, spec: { ...node.spec, deletionPolicy: "allow" } });
    expect(resourcesOf(allowed).filter((r) => ["oci_core_instance", "oci_containerengine_cluster", "oci_containerengine_node_pool"].includes(r.type)).every((r) => !r.body.lifecycle)).toBe(true);
    expect(() => compile({ ...node, dependsOn: [] })).toThrow(/private subnet/);
  });

  it.each([
    [vm, { imageOcid: "not-an-ocid" }], [vm, { imageOcid: ocid("volume", "other") }], [vm, { shape: "BM.Standard" }],
    [vm, { ocpus: 0 }], [vm, { ocpus: 1.5 }], [vm, { memoryGb: 0 }], [vm, { memoryGb: 65 }], [vm, { bootVolumeGb: 49 }],
    [oke, { version: "latest" }], [oke, { nodeImageOcid: "" }], [oke, { nodeCount: 0 }], [oke, { nodeCount: 101 }], [oke, { nodeOcpus: Number.NaN }],
    [oke, { apiAccessCidrs: ["0.0.0.0/0"] }], [oke, { apiAccessCidrs: "10.0.0.0/8" }],
  ])("refuses invalid spec %#", (node, over) => expect(() => compile({ ...node, spec: { ...node.spec, ...over } })).toThrow(OciCompileError));

  it("rejects foreign region and mixed VCN subnet placement", () => {
    const base = ctx.node;
    for (const over of [{ region: "us-phoenix-1" }, { provider: "aws" }, { spec: { network: "network/other", tier: "private" } }]) {
      const scoped = { ...ctx, node: (address: string) => address === "subnet/private-a" ? { ...base(address)!, ...over } as ResourceNode : base(address) };
      expect(() => driverFor(vm).compile!(vm, scoped)).toThrow(OciCompileError);
    }
  });

  it("VM identity grants an instance principal and keeps exact target policy conditions", () => {
    const original = nodeOf(graph, "identity/web");
    const identity = { ...original, spec: { ...original.spec, workload: vm.address, grants: [{ target: "object_store/assets", access: ["read"], via: [] }] } };
    const f = compile(identity);
    expect(resourcesOf(f).find((r) => r.type === "oci_identity_dynamic_group")!.body.matching_rule).toContain("instance.compartment.id=");
    expect(resourcesOf(f).find((r) => r.type === "oci_identity_dynamic_group")!.body.matching_rule).toContain("instance.id='${oci_core_instance.compute_instance_machine.id}'");
    expect(JSON.stringify(f)).not.toContain("resource.type='computecontainerinstance'");
    expect(JSON.stringify(f)).toContain("target.bucket.name");
    expect(() => compile({ ...identity, spec: { ...identity.spec, grants: [{ target: mysql.address, access: ["read_credentials"], via: [] }] } })).toThrow(/no managed Vault password/);
  });

  it("MySQL never claims safe compilation or installs a throwing stub", () => {
    expect(driverFor(mysql).compile).toBeUndefined();
    expect(driverFor(mysql).capabilities.compile).toBe(false);
  });

  it("firewall rules target the VM/OKE node NSG without admitting world ingress", () => {
    const template = nodeOf(graph, "firewall/web-to-db");
    const source = { address: "container_service/web" };
    for (const target of [vm.address, oke.address]) {
      const rule = { ...template, spec: { ...template.spec, target, source } };
      const f = compile(rule);
      expect(resourcesOf(f)[0].body.network_security_group_id).toBe("${local." + auxName(target, "nsg_id") + "}");
      expect(() => compile({ ...rule, spec: { ...rule.spec, source: { cidr: "0.0.0.0/0" } } })).toThrow(/open to the internet/);
    }
  });
});

describe("honest reads", () => {
  it("VM identity observes the workload from its exact instance ID and leaves failed reads unknown", async () => {
    const world = healthyWorld(graph);
    const identity = nodeOf(graph, "identity/web");
    const groupId = world.ids.get(identity.address)!;
    const instanceId = world.ids.get(vm.address)!;
    const item = { id: groupId, matchingRule: `ALL {instance.id='${instanceId}'}`, freeformTags: zenithTagsFor(identity.address) };
    world.oci.route("GET", `/20160918/dynamicGroups/${groupId}`, json(item));
    const d = driverFor(identity);
    const context = driverContext(world.oci);
    expect((await d.observe!(context, identity, groupId)).attributes.workload).toMatchObject({ state: "known", value: vm.address });
    world.oci.route("GET", `/20160918/instances/${instanceId}`, err(403, "Denied"));
    expect((await d.observe!(context, identity, groupId)).attributes.workload.state).toBe("unknown");
  });
  it.each(nodes)("$nativeType observes, verifies and discovers using only allowed reads", async (node) => {
    const world = healthyWorld(graph);
    const context = driverContext(world.oci);
    const d = driverFor(node);
    const observation = await d.observe!(context, node);
    const runtime = await d.runtime!(context, node);
    expect(observation.presence).toBe("present");
    expect(runtime.health).toBe("healthy");
    expect((await d.verify!(context, node, observation, runtime)).status).toBe("passed");
    expect((await d.discover!(context)).map((i) => i.externalId)).toContain(observation.externalId);
    expect(world.oci.calls.every((req) => req.method === "GET" && ["infrastructure.observe", "topology.read", "incident.investigate"].every((cap) => isAllowed(cap, req)))).toBe(true);
    expect(world.oci.calls.some((req) => req.method !== "GET")).toBe(false);
  });

  it.each(nodes)("$nativeType accepts unsigned runner serialization without credentials", async (node) => {
    const world = healthyWorld(graph);
    const transport = createRunnerOciTransport(async (p) => {
      expect(p).not.toHaveProperty("bodyB64");
      const r = await world.oci.request({ service: p.service, region: p.region, method: p.method, path: p.path, query: Object.fromEntries(p.query) });
      return { status: r.status, headers: r.headers, bodyB64: Buffer.from(JSON.stringify(r.body)).toString("base64") };
    }, { capability: "infrastructure.observe" });
    expect((await driverFor(node).observe!(driverContext(transport), node)).presence).toBe("present");
  });

  it.each(nodes)("$nativeType refuses to infer absence from 404 alone", async (node) => {
    const oci = new FakeOci().on(() => err(404, "NotAuthorizedOrNotFound"));
    const d = driverFor(node);
    expect((await d.observe!(driverContext(oci), node, ocid("example", "resource"))).presence).toBe("inaccessible");
    expect((await d.runtime!(driverContext(oci), node)).health).toBe("unknown");
    const listing = node === vm ? "/20160918/instances" : node === oke ? "/20180222/clusters" : "/20190415/dbSystems";
    oci.route("GET", listing, json({ items: [] }));
    expect((await d.observe!(driverContext(oci), node, ocid("example", "resource"))).presence).toBe("missing");
  });

  it.each(nodes.flatMap((node) => [403, 429, 503].map((status) => [node, status] as const)))("denied/throttled/unavailable reads remain honest %#", async (node, status) => {
    const oci = new FakeOci().on(() => err(status, "ReadFailure"));
    expect((await driverFor(node).observe!(driverContext(oci), node)).presence).toBe(status === 403 ? "inaccessible" : "unknown");
    expect(await driverFor(node).discover!(driverContext(oci))).toEqual([]);
  });

  it.each(nodes)("$nativeType leaves unavailable full configuration unknown", async (node) => {
    const world = healthyWorld(graph);
    const id = world.ids.get(node.address)!;
    world.oci.route("GET", new RegExp(`/${id}$`), err(503, "Unavailable"));
    const obs = await driverFor(node).observe!(driverContext(world.oci), node);
    expect(obs.presence).toBe("present");
    expect(Object.values(obs.attributes).every((value) => value.state === "unknown")).toBe(true);
    expect((await driverFor(node).verify!(driverContext(world.oci), node, obs)).status).toBe("unknown");
  });

  it.each(nodes)("$nativeType drops secret/metadata fields from native responses", async (node) => {
    const world = healthyWorld(graph);
    const id = world.ids.get(node.address)!;
    const listing = node === vm ? "/20160918/instances" : node === oke ? "/20180222/clusters" : "/20190415/dbSystems";
    const item = { id, lifecycleState: "ACTIVE", freeformTags: zenithTagsFor(node.address), adminPassword: "CANARY_CREDENTIAL", metadata: { user_data: "CANARY_CREDENTIAL" }, secretContent: "CANARY_CREDENTIAL" };
    world.oci.route("GET", `${listing}/${id}`, json(item));
    world.oci.route("GET", listing, json({ items: [item] }));
    const d = driverFor(node);
    const context = driverContext(world.oci);
    expect(JSON.stringify([await d.observe!(context, node), await d.runtime!(context, node), await d.discover!(context)])).not.toContain("CANARY_CREDENTIAL");
  });

  it("OKE control-plane ACTIVE never implies healthy worker nodes", async () => {
    const world = healthyWorld(graph);
    const poolPath = `/20180222/nodePools/${ocid("nodepool", "pool")}`;
    const context = driverContext(world.oci);
    world.oci.route("GET", poolPath, json({ clusterId: world.ids.get(oke.address), lifecycleState: "ACTIVE", nodeConfigDetails: { size: 2 }, nodes: [{ lifecycleState: "ACTIVE" }, { lifecycleState: "FAILED" }] }));
    expect((await driverFor(oke).runtime!(context, oke)).health).toBe("degraded");
    world.oci.route("GET", poolPath, err(403, "Denied"));
    expect((await driverFor(oke).runtime!(context, oke)).health).toBe("unknown");
    world.oci.route("GET", poolPath, json({ clusterId: world.ids.get(oke.address), lifecycleState: "ACTIVE", nodeConfigDetails: { size: 2 } }));
    expect((await driverFor(oke).runtime!(context, oke)).health).toBe("unknown");
  });

  it("MySQL daily backups do not satisfy hourly desired backup", async () => {
    const world = healthyWorld(graph);
    const node = { ...mysql, spec: { ...mysql.spec, backup: "hourly" } };
    const context = driverContext(world.oci);
    const d = driverFor(node);
    const result = await d.verify!(context, node, await d.observe!(context, node));
    expect(result.checks.find((c) => c.id === "config:backup")?.passed).toBe(false);
  });

  it.each(nodes)("$nativeType invalid collection responses are unknown and aborts send no requests", async (node) => {
    const oci = new FakeOci().on(() => json({ message: "not a collection" }));
    const d = driverFor(node);
    expect((await d.observe!(driverContext(oci), node)).presence).toBe("unknown");
    oci.on(() => json({ items: [null, "not-a-resource"] }));
    expect((await d.observe!(driverContext(oci), node)).presence).toBe("unknown");
    const controller = new AbortController();
    controller.abort();
    oci.calls.length = 0;
    expect((await d.observe!(driverContext(oci, { signal: controller.signal }), node)).presence).toBe("unknown");
    expect(oci.calls).toEqual([]);
  });

  it("OKE refuses a node pool from a different cluster", async () => {
    const world = healthyWorld(graph);
    world.oci.route("GET", `/20180222/nodePools/${ocid("nodepool", "pool")}`, json({ clusterId: ocid("cluster", "foreign"), lifecycleState: "ACTIVE", nodeConfigDetails: { size: 2 }, nodes: [{ lifecycleState: "ACTIVE" }, { lifecycleState: "ACTIVE" }] }));
    expect((await driverFor(oke).runtime!(driverContext(world.oci), oke)).health).toBe("unknown");
  });

  it.each(nodes)("$nativeType ambiguous or truncated tag listings never choose or claim missing", async (node) => {
    const listing = node === vm ? "/20160918/instances" : node === oke ? "/20180222/clusters" : "/20190415/dbSystems";
    const oci = new FakeOci().route("GET", listing, json({ items: [1, 2].map((n) => ({ id: ocid("example", `item${n}`), freeformTags: zenithTagsFor(node.address) })) }));
    const d = driverFor(node);
    expect((await d.observe!(driverContext(oci), node)).presence).toBe("unknown");
    oci.route("GET", listing, json({ items: [] }, { "opc-next-page": "page" }));
    expect((await d.observe!(driverContext(oci), node)).presence).toBe("unknown");
  });
});

interface SchemaBlock {
  attributes: Record<string, { required: boolean; optional: boolean; computed: boolean }>;
  block_types: Record<string, { block: SchemaBlock; min_items?: number }>;
}
const schema = JSON.parse(readFileSync("tests/providers/oci/fixtures/schema-9.7.1.json", "utf8")) as { version: string; resource: Record<string, SchemaBlock>; data: Record<string, SchemaBlock> };
function validateBlock(value: Record<string, unknown>, block: SchemaBlock): void {
  for (const [key, attribute] of Object.entries(block.attributes)) if (attribute.required) expect(value, `required ${key}`).toHaveProperty(key);
  for (const [key, nested] of Object.entries(block.block_types)) if ((nested.min_items ?? 0) > 0) expect(value, `required block ${key}`).toHaveProperty(key);
  for (const [key, field] of Object.entries(value)) {
    if (["lifecycle", "depends_on", "count"].includes(key)) continue;
    const nested = block.block_types[key];
    if (nested) for (const entry of Array.isArray(field) ? field : [field]) validateBlock(entry as Record<string, unknown>, nested.block);
    else { expect(block.attributes, `unknown argument ${key}`).toHaveProperty(key); expect(block.attributes[key].optional || block.attributes[key].required, `computed-only ${key}`).toBe(true); }
  }
}
describe("cached oracle/oci 9.7.1 argument structure (not tofu validate)", () => {
  it.each([vm, oke])("$nativeType emits only writable schema arguments and all required fields", (node) => {
    expect(schema.version).toBe("9.7.1");
    const f = compile(node);
    for (const [type, named] of Object.entries(f.resource ?? {})) for (const resource of Object.values(named)) validateBlock(resource, schema.resource[type]);
    for (const [type, named] of Object.entries(f.data ?? {})) for (const data of Object.values(named)) validateBlock(data, schema.data[type]);
  });
  it("the schema detector rejects invented arguments and missing required fields", () => {
    const instance = body(vm, "oci_core_instance");
    expect(() => validateBlock({ ...instance, unknown_argument: true }, schema.resource.oci_core_instance)).toThrow();
    const missing = { ...instance };
    delete missing.compartment_id;
    expect(() => validateBlock(missing, schema.resource.oci_core_instance)).toThrow();
  });
  it("MySQL's schema has no VAULT_SECRET password details", () => {
    const block = schema.resource.oci_mysql_mysql_db_system;
    expect(block.attributes).toHaveProperty("admin_password");
    expect(block.attributes).not.toHaveProperty("admin_password_secret_id");
    expect(block.block_types).not.toHaveProperty("password_details");
    expect(block.block_types).not.toHaveProperty("credentials");
  });
});
