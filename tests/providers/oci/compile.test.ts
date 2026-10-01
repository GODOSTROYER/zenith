/**
 * Compile: structure, determinism, tags, ownership, references and the
 * fail-closed refusals of the OCI drivers. Every test compiles the output of
 * the REAL `expandManifest()` for an OCI environment, so the specs the
 * drivers read are exactly what the platform produces.
 */
import { describe, expect, it } from "vitest";
import { NATIVE_TYPE_TABLE } from "@/lib/resources";
import type { Manifest } from "@/lib/domain/types";
import type { ResourceGraph, ResourceNode } from "@/lib/resources";
import { OciCompileError, OciUnsupportedError } from "@/lib/providers/oci/errors";
import { ociDrivers } from "@/lib/providers/oci/drivers";
import { ociPrimaryAddress, tfLabel } from "@/lib/providers/oci/naming";
import { allResources, compileContext, compileGraph, driverFor, expandOci, nodeOf, OCI_PROD, resourcesOf, webStack, COMPARTMENT, TENANCY, ENV_ID } from "./_support";

const staging = expandOci();
const compiled = compileGraph(staging);
const frag = (address: string) => compiled.fragments.get(address)!;
const onlyResource = (address: string, type: string): Record<string, unknown> => {
  const r = resourcesOf(frag(address)).filter((x) => x.type === type);
  expect(r, `${address} defines exactly one ${type}`).toHaveLength(1);
  return r[0].body;
};

describe("the driver set", () => {
  it("registers exactly the native types of the OCI row of the native-type table, once each", () => {
    const table = Object.values(NATIVE_TYPE_TABLE.oci).sort();
    expect([...new Set(ociDrivers.map((d) => d.nativeType))].sort()).toEqual([...new Set(table)].sort());
    expect(new Set(ociDrivers.map((d) => d.nativeType)).size).toBe(ociDrivers.length);
    expect(new Set(ociDrivers.map((d) => d.id)).size).toBe(ociDrivers.length);
  });

  it("every portable kind that has an OCI native type has a driver of that kind", () => {
    for (const [kind, nativeType] of Object.entries(NATIVE_TYPE_TABLE.oci)) {
      const d = ociDrivers.find((x) => x.nativeType === nativeType);
      expect(d, `${kind} → ${nativeType}`).toBeDefined();
      expect(d!.kind).toBe(kind);
      expect(d!.provider).toBe("oci");
      expect(d!.id).toBe(`oci.${nativeType.slice(4)}@1`);
    }
  });
});

describe("compiling the web stack", () => {
  it("compiles every node expansion produced for OCI, with nothing refused", () => {
    expect([...compiled.refused.entries()]).toEqual([]);
    expect(compiled.fragments.size).toBe(staging.nodes.length);
  });

  it("is deterministic: compiling twice gives byte-identical JSON", () => {
    const a = compileGraph(staging);
    const b = compileGraph(expandOci());
    for (const [address, f] of a.fragments) expect(JSON.stringify(b.fragments.get(address))).toBe(JSON.stringify(f));
  });

  it("does not depend on the order of ctx.tags", () => {
    const g = staging;
    const forward = compileGraph(g, { tags: { "zenith:workspace": "ws_1", "zenith:managed": "true", "zenith:team": "core" } });
    const reversed = compileGraph(g, { tags: { "zenith:team": "core", "zenith:managed": "true", "zenith:workspace": "ws_1" } });
    expect(JSON.stringify([...forward.fragments])).toBe(JSON.stringify([...reversed.fragments]));
  });

  it("every fragment's addresses are defined by it and addresses[0] is the node's primary resource", () => {
    const seen = new Map<string, string>();
    for (const [address, f] of compiled.fragments) {
      const node = nodeOf(staging, address);
      const defined = new Set([...resourcesOf(f).map((r) => `${r.type}.${r.name}`), ...Object.entries(f.data ?? {}).flatMap(([t, n]) => Object.keys(n).map((k) => `data.${t}.${k}`))]);
      for (const a of f.addresses) {
        expect(defined.has(a), `${address} claims ${a}`).toBe(true);
        expect(seen.has(a), `${a} claimed by ${seen.get(a)} and ${address}`).toBe(false);
        seen.set(a, address);
      }
      if (node.ownership === "managed") expect(f.addresses[0], address).toBe(ociPrimaryAddress(node));
      expect([...f.addresses.slice(1)]).toEqual([...f.addresses.slice(1)].sort());
    }
  });

  it("labels are [a-z0-9_] and derived from the node address", () => {
    expect(tfLabel("service/web")).toBe("service_web");
    expect(tfLabel("dns_record/app.example.com")).toBe("dns_record_app_example_com");
    expect(tfLabel("9bad/x")).toBe("_9bad_x");
    for (const f of compiled.fragments.values()) for (const r of resourcesOf(f)) expect(r.name).toMatch(/^[a-z0-9_]+$/);
  });

  it("every taggable resource carries the Zenith environment and its OWN node address, with at most 10 tags", () => {
    const untaggable = new Set([
      "oci_core_network_security_group_security_rule",
      "oci_load_balancer_backend_set",
      "oci_load_balancer_backend",
      "oci_load_balancer_listener",
      "oci_load_balancer_rule_set",
      "oci_load_balancer_load_balancer_routing_policy",
      "oci_dns_rrset",
    ]);
    for (const r of allResources(compiled)) {
      if (untaggable.has(r.type)) {
        expect(r.body.freeform_tags, `${r.type} has no tags`).toBeUndefined();
        continue;
      }
      const tags = r.body.freeform_tags as Record<string, string>;
      expect(tags, `${r.node} ${r.type}.${r.name}`).toBeDefined();
      expect(tags.zenith_environment).toBe(ENV_ID);
      expect(tags.zenith_resource).toBe(r.node);
      expect(tags.zenith_managed).toBe("true");
      expect(Object.keys(tags).length).toBeLessThanOrEqual(10);
      for (const [k, v] of Object.entries(tags)) {
        expect(k).toMatch(/^[A-Za-z0-9_-]+$/); // no ":" or "." in OCI free-form keys
        expect(v.length).toBeLessThanOrEqual(256);
      }
    }
  });

  it("refuses a workspace tag set that exceeds OCI's ten-tag limit", () => {
    const tags = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`zenith:k${i}`, "v"]));
    expect(() => driverFor(nodeOf(staging, "network/main")).compile!(nodeOf(staging, "network/main"), compileContext(staging, { tags }))).toThrow(OciCompileError);
  });

  it("referenced and external nodes never declare resources", () => {
    for (const node of staging.nodes.filter((n) => n.ownership !== "managed")) {
      expect(resourcesOf(frag(node.address)), node.address).toEqual([]);
    }
  });

  it("a plain CompileContext (no compartment/tenancy) is refused with the instruction to wrap it", () => {
    const plain = { ...compileContext(staging) } as Record<string, unknown>;
    delete plain.compartmentOcid;
    delete plain.tenancyOcid;
    expect(() => driverFor(nodeOf(staging, "network/main")).compile!(nodeOf(staging, "network/main"), plain as never)).toThrow(/ociCompileContext/);
  });

  it("the compartment and tenancy appear only where they belong", () => {
    const text = (a: string) => JSON.stringify(frag(a));
    expect(text("network/main")).toContain(COMPARTMENT);
    expect(text("network/main")).not.toContain(TENANCY);
    expect(text("identity/web")).toContain(TENANCY); // dynamic groups live in the tenancy
  });
});

describe("network", () => {
  it("VCN: cidr, gateways, route tables and a LOCKED default security list", () => {
    const f = frag("network/main");
    expect(onlyResource("network/main", "oci_core_vcn").cidr_blocks).toEqual(["10.0.0.0/16"]);
    const types = resourcesOf(f).map((r) => r.type).sort();
    expect(types).toEqual(["oci_core_default_security_list", "oci_core_internet_gateway", "oci_core_nat_gateway", "oci_core_route_table", "oci_core_route_table", "oci_core_service_gateway", "oci_core_vcn"]);
    const sl = onlyResource("network/main", "oci_core_default_security_list");
    expect(sl.ingress_security_rules).toBeUndefined();
    expect(sl.egress_security_rules).toHaveLength(1);
    expect(Object.keys(f.locals!).sort()).toEqual(["network_main_locked_security_list_id", "network_main_private_route_table_id", "network_main_public_route_table_id"]);
  });

  it("natGateways 'none' omits the NAT gateway and its route; per_az collapses to one regional NAT", () => {
    const base = webStack();
    const none = expandOci({ ...base, version: 2, providerConfig: undefined } as unknown as Manifest);
    const node = nodeOf(none, "network/main");
    const noNat = { ...node, spec: { ...node.spec, egress: { natGateways: "none" } } } as ResourceNode;
    const f = driverFor(noNat).compile!(noNat, compileContext(none));
    expect(resourcesOf(f).some((r) => r.type === "oci_core_nat_gateway")).toBe(false);
    const rt = resourcesOf(f).find((r) => r.name.endsWith("rt_private"))!.body.route_rules as { destination_type: string }[];
    expect(rt.map((r) => r.destination_type)).toEqual(["SERVICE_CIDR_BLOCK"]);
    const perAz = { ...node, spec: { ...node.spec, egress: { natGateways: "per_az" } } } as ResourceNode;
    expect(resourcesOf(driverFor(perAz).compile!(perAz, compileContext(none))).filter((r) => r.type === "oci_core_nat_gateway")).toHaveLength(1);
  });

  it("a namespace-only (Kubernetes) network spec is refused", () => {
    const node = { ...nodeOf(staging, "network/main"), spec: { namespace: "x", zones: 1 } } as ResourceNode;
    expect(() => driverFor(node).compile!(node, compileContext(staging))).toThrow(/spec\.cidr/);
  });

  it("subnets are regional (no availability domain), private ones forbid public IPs and internet ingress", () => {
    for (const [address, isPrivate] of [["subnet/private-a", true], ["subnet/public-a", false]] as const) {
      const s = onlyResource(address, "oci_core_subnet");
      expect(s.availability_domain).toBeUndefined();
      expect(s.prohibit_public_ip_on_vnic).toBe(isPrivate);
      expect(s.prohibit_internet_ingress).toBe(isPrivate);
      expect(s.security_list_ids).toEqual(["${local.network_main_locked_security_list_id}"]);
      expect(s.route_table_id).toBe(`\${local.network_main_${isPrivate ? "private" : "public"}_route_table_id}`);
      expect(s.vcn_id).toBe("${oci_core_vcn.network_main.id}");
    }
  });

  it("production gets one subnet per zone and still compiles", () => {
    const prod = compileGraph(expandOci(webStack(), OCI_PROD));
    expect([...prod.refused]).toEqual([]);
    expect([...prod.fragments.keys()].filter((a) => a.startsWith("subnet/")).sort()).toEqual(["subnet/private-a", "subnet/private-b", "subnet/public-a", "subnet/public-b"]);
  });

  it("bad subnet specs are refused", () => {
    const node = nodeOf(staging, "subnet/public-a");
    for (const spec of [{ ...node.spec, tier: "dmz" }, { ...node.spec, cidr: "10.0.0.0/33" }, { ...node.spec, network: undefined }]) {
      const n = { ...node, spec } as ResourceNode;
      expect(() => driverFor(n).compile!(n, compileContext(staging))).toThrow(OciCompileError);
    }
  });
});

describe("firewall → network security group rules", () => {
  const rule = (address: string) => onlyResource(address, "oci_core_network_security_group_security_rule");

  it("each protected node owns an NSG and publishes its id", () => {
    for (const [address, nsg] of [
      ["load_balancer/public", "load_balancer_public_nsg"],
      ["container_service/web", "container_service_web_nsg"],
      ["postgres/db", "postgres_db_nsg"],
      ["redis/cache", "redis_cache_nsg"],
    ] as const) {
      expect(resourcesOf(frag(address)).some((r) => r.type === "oci_core_network_security_group" && r.name === nsg), address).toBe(true);
      expect(frag(address).locals![`${nsg}_id`]).toBe(`\${oci_core_network_security_group.${nsg}.id}`);
    }
  });

  it("internet → LB is a CIDR rule on the LB's NSG, tcp, stateful, on exactly that port", () => {
    for (const port of [80, 443]) {
      const r = rule(`firewall/internet-to-lb-${port}`);
      expect(r).toMatchObject({ network_security_group_id: "${local.load_balancer_public_nsg_id}", direction: "INGRESS", protocol: "6", stateless: false, source: "0.0.0.0/0", source_type: "CIDR_BLOCK" });
      expect(r.tcp_options).toEqual({ destination_port_range: { min: port, max: port } });
    }
  });

  it("node-to-node rules use the source node's NSG, not a CIDR", () => {
    expect(rule("firewall/lb-to-web")).toMatchObject({ network_security_group_id: "${local.container_service_web_nsg_id}", source: "${local.load_balancer_public_nsg_id}", source_type: "NETWORK_SECURITY_GROUP" });
    expect(rule("firewall/web-to-db")).toMatchObject({ network_security_group_id: "${local.postgres_db_nsg_id}", source: "${local.container_service_web_nsg_id}" });
    expect(rule("firewall/web-to-cache").tcp_options).toEqual({ destination_port_range: { min: 6379, max: 6379 } });
  });

  it("refuses an open CIDR for anything but public_http into a load balancer", () => {
    const base = nodeOf(staging, "firewall/web-to-db");
    const open = (over: Record<string, unknown>) => ({ ...base, spec: { ...base.spec, ...over } }) as ResourceNode;
    for (const cidr of ["0.0.0.0/0", "10.0.0.0/4", "128.0.0.0/1"]) {
      const n = open({ source: { cidr } });
      expect(() => driverFor(n).compile!(n, compileContext(staging)), cidr).toThrow(/open to the internet/);
    }
    const ok = open({ source: { cidr: "10.1.0.0/16" } });
    expect(() => driverFor(ok).compile!(ok, compileContext(staging))).not.toThrow();
    // capability public_http but the target is a database
    const sneaky = open({ source: { cidr: "0.0.0.0/0" }, capability: "public_http" });
    expect(() => driverFor(sneaky).compile!(sneaky, compileContext(staging))).toThrow(/open to the internet/);
  });

  it("refuses cross-boundary rules, unmanaged or unknown targets, non-tcp/ingress and bad ports", () => {
    const base = nodeOf(staging, "firewall/web-to-db");
    const make = (over: Record<string, unknown>) => ({ ...base, spec: { ...base.spec, ...over } }) as ResourceNode;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ crossBoundary: "cross_cloud" }, /cross_cloud/],
      [{ target: "postgres/nope" }, /not in the graph/],
      [{ target: "network/main" }, /no network security group/],
      [{ source: { address: "secret/x" } }, /not in the graph/],
      [{ protocol: "udp" }, /only ingress tcp/],
      [{ direction: "egress" }, /only ingress tcp/],
      [{ port: 0 }, /1\.\.65535/],
      [{ port: 70000 }, /1\.\.65535/],
      [{ source: { cidr: "10.0.0.0/99" } }, /IPv4 CIDR/],
    ];
    for (const [over, message] of cases) {
      const n = make(over);
      expect(() => driverFor(n).compile!(n, compileContext(staging)), JSON.stringify(over)).toThrow(message);
    }
  });

  it("refuses a rule into a referenced (unmanaged) target", () => {
    const g: ResourceGraph = { ...staging, nodes: staging.nodes.map((n) => (n.address === "postgres/db" ? { ...n, ownership: "referenced" as const } : n)) };
    const n = nodeOf(g, "firewall/web-to-db");
    expect(() => driverFor(n).compile!(n, compileContext(g))).toThrow(/never edits a node it does not manage|referenced/);
  });
});

describe("load balancer", () => {
  const lb = () => onlyResource("load_balancer/public", "oci_load_balancer_load_balancer");

  it("is a public flexible LB in a regional public subnet with an NSG and a reserved IP", () => {
    expect(lb()).toMatchObject({
      shape: "flexible",
      is_private: false,
      shape_details: { minimum_bandwidth_in_mbps: 10, maximum_bandwidth_in_mbps: 100 },
      subnet_ids: ["${oci_core_subnet.subnet_public_a.id}"],
      network_security_group_ids: ["${oci_core_network_security_group.load_balancer_public_nsg.id}"],
      reserved_ips: [{ id: "${oci_core_public_ip.load_balancer_public_ip.id}" }],
    });
    expect(onlyResource("load_balancer/public", "oci_core_public_ip").lifetime).toBe("RESERVED");
    expect(frag("load_balancer/public").locals!.load_balancer_public_public_ip).toBe("${oci_core_public_ip.load_balancer_public_ip.ip_address}");
  });

  it("backends are the target's private IPs, one per replica, with an HTTP health check on healthPath", () => {
    const set = onlyResource("load_balancer/public", "oci_load_balancer_backend_set");
    expect(set.health_checker).toMatchObject({ protocol: "HTTP", port: 3000, url_path: "/healthz", return_code: 200 });
    const be = onlyResource("load_balancer/public", "oci_load_balancer_backend");
    expect(be).toMatchObject({ count: 2, port: 3000, ip_address: "${local.container_service_web_private_ips[count.index]}" });
  });

  it("HTTPS terminates TLS 1.2/1.3 with the certificate's id; HTTP redirects to HTTPS", () => {
    const listeners = Object.fromEntries(resourcesOf(frag("load_balancer/public")).filter((r) => r.type === "oci_load_balancer_listener").map((r) => [r.body.name as string, r.body]));
    expect(listeners.https_443.ssl_configuration).toMatchObject({ certificate_ids: ["${local.tls_certificate_app_acme_io_id}"], protocols: ["TLSv1.2", "TLSv1.3"] });
    expect(listeners.http_80.rule_set_names).toEqual(["${oci_load_balancer_rule_set.load_balancer_public_redirect.name}"]);
    const rs = onlyResource("load_balancer/public", "oci_load_balancer_rule_set");
    expect(rs.items).toMatchObject([{ action: "REDIRECT", response_code: 301, redirect_uri: { protocol: "https", port: 443 } }]);
  });

  it("with several targets it adds a routing policy: host + path, longest prefix first", () => {
    const m = webStack();
    m.services.push({ ...m.services[0], id: "svc-api", name: "api", env: [], port: 8080, healthPath: "/health" });
    m.routes.push({ id: "rt-api", host: "app.acme.io", pathPrefix: "/api", tls: true, managedDns: true });
    m.bindings.push({ id: "b-api", from: "rt-api", to: "svc-api", capability: "http" });
    const g = expandOci(m);
    const c = compileGraph(g);
    expect([...c.refused]).toEqual([]);
    const policy = resourcesOf(c.fragments.get("load_balancer/public")!).find((r) => r.type === "oci_load_balancer_load_balancer_routing_policy")!.body as { rules: { condition: string }[]; condition_language_version: string };
    expect(policy.condition_language_version).toBe("V1");
    expect(policy.rules.map((r) => r.condition)).toEqual([
      "all(http.request.headers[(i 'host')] eq (i 'app.acme.io'), http.request.url.path sw '/api')",
      "http.request.headers[(i 'host')] eq (i 'app.acme.io')",
    ]);
    const https = resourcesOf(c.fragments.get("load_balancer/public")!).find((r) => r.body.name === "https_443")!.body;
    expect(https.routing_policy_name).toBeDefined();
  });

  it("refuses unsafe hosts and paths, route ports that disagree, and more than one certificate", () => {
    const node = nodeOf(staging, "load_balancer/public");
    const spec = node.spec as { routes: Record<string, unknown>[]; listeners: unknown[] };
    const withRoute = (over: Record<string, unknown>) => ({ ...node, spec: { ...spec, routes: [{ ...spec.routes[0], ...over }] } }) as ResourceNode;
    for (const [over, message] of [
      [{ host: "a'b.example.com" }, /plain hostname/],
      [{ pathPrefix: "/x' ) any(1" }, /not allowed in a routing condition/],
      [{ pathPrefix: "/a\nb" }, /not allowed in a routing condition/],
      [{ port: undefined }, /no port/],
      [{ target: "container_service/nope" }, /not a Zenith-managed container instance/],
    ] as [Record<string, unknown>, RegExp][]) {
      const n = withRoute(over);
      expect(() => driverFor(n).compile!(n, compileContext(staging)), JSON.stringify(over)).toThrow(message);
    }
    const twoCerts = { ...node, dependsOn: [...node.dependsOn, "tls_certificate/other.acme.io"] } as ResourceNode;
    const g: ResourceGraph = { ...staging, nodes: [...staging.nodes, { ...nodeOf(staging, "tls_certificate/app.acme.io"), address: "tls_certificate/other.acme.io", spec: { domain: "other.acme.io", validation: "dns_automatic" } }] };
    expect(() => driverFor(twoCerts).compile!(twoCerts, compileContext(g))).toThrow(OciUnsupportedError);
    expect(() => driverFor(twoCerts).compile!(twoCerts, compileContext(g))).toThrow(/single Certificates-service certificate/);
  });

  it("an HTTPS listener without a certificate is refused", () => {
    const node = nodeOf(staging, "load_balancer/public");
    const bare = { ...node, dependsOn: node.dependsOn.filter((d) => !d.startsWith("tls_certificate/")) } as ResourceNode;
    expect(() => driverFor(bare).compile!(bare, compileContext(staging))).toThrow(OciCompileError);
  });

  it("an http-only environment compiles without certificates or redirects", () => {
    const m = webStack();
    m.routes = [{ id: "rt-app", host: "plain.acme.io", pathPrefix: "/", tls: false, managedDns: true }];
    const c = compileGraph(expandOci(m));
    expect([...c.refused]).toEqual([]);
    const types = resourcesOf(c.fragments.get("load_balancer/public")!).map((r) => r.type);
    expect(types).not.toContain("oci_load_balancer_rule_set");
    expect(c.fragments.has("tls_certificate/plain.acme.io")).toBe(false);
  });
});

describe("certificate, DNS", () => {
  it("the certificate is a LOOKUP of an imported certificate, never a resource", () => {
    const f = frag("tls_certificate/app.acme.io");
    expect(resourcesOf(f)).toEqual([]);
    const body = f.data!.oci_certificates_management_certificates.tls_certificate_app_acme_io as Record<string, unknown>;
    expect(body).toMatchObject({ name: "app.acme.io", state: "ACTIVE", compartment_id: COMPARTMENT });
    expect(JSON.stringify(body.lifecycle)).toMatch(/postcondition/);
    expect(f.addresses).toEqual(["data.oci_certificates_management_certificates.tls_certificate_app_acme_io"]);
  });

  it("the zone is a data lookup (GLOBAL, PRIMARY, exact name) and the record an A record to the LB's reserved IP", () => {
    const z = frag("dns_zone/acme.io").data!.oci_dns_zones.dns_zone_acme_io as Record<string, unknown>;
    expect(z).toMatchObject({ name: "acme.io", scope: "GLOBAL", zone_type: "PRIMARY", state: "ACTIVE" });
    expect(resourcesOf(frag("dns_zone/acme.io"))).toEqual([]);
    const r = onlyResource("dns_record/app.acme.io", "oci_dns_rrset");
    expect(r).toMatchObject({ domain: "app.acme.io", rtype: "A", zone_name_or_id: "${local.dns_zone_acme_io_id}" });
    expect(r.items).toEqual([{ domain: "app.acme.io", rtype: "A", rdata: "${local.load_balancer_public_public_ip}", ttl: 300 }]);
  });

  it("an alias to anything but a managed load balancer is refused", () => {
    const node = nodeOf(staging, "dns_record/app.acme.io");
    const n = { ...node, spec: { ...node.spec, target: "container_service/web" } } as ResourceNode;
    expect(() => driverFor(n).compile!(n, compileContext(staging))).toThrow(OciUnsupportedError);
  });

  it("hostile names are refused", () => {
    const rec = nodeOf(staging, "dns_record/app.acme.io");
    const zone = nodeOf(staging, "dns_zone/acme.io");
    const cert = nodeOf(staging, "tls_certificate/app.acme.io");
    for (const n of [
      { ...rec, spec: { ...rec.spec, name: "a b.example.com" } },
      { ...zone, spec: { ...zone.spec, name: "x'; drop" } },
      { ...cert, spec: { ...cert.spec, domain: "${file(\"/etc/passwd\")}" } },
    ] as ResourceNode[]) expect(() => driverFor(n).compile!(n, compileContext(staging))).toThrow(OciCompileError);
  });
});

describe("container instances", () => {
  it("web: private, no public IP, resource principal on, replicas as count, spread over ADs and fault domains", () => {
    const ci = onlyResource("container_service/web", "oci_container_instances_container_instance");
    expect(ci).toMatchObject({ count: 2, shape: "CI.Standard.E4.Flex", shape_config: { ocpus: 1, memory_in_gbs: 1 }, container_restart_policy: "ALWAYS" });
    expect((ci.vnics as Record<string, unknown>[])[0]).toMatchObject({ is_public_ip_assigned: false, subnet_id: "${oci_core_subnet.subnet_private_a.id}", nsg_ids: ["${oci_core_network_security_group.container_service_web_nsg.id}"] });
    expect(ci.availability_domain).toMatch(/^\$\{element\(data\.oci_identity_availability_domains\./);
    expect(String(ci.fault_domain)).toContain("count.index % 3");
    const c = (ci.containers as Record<string, unknown>[])[0];
    expect(c).toMatchObject({ image_url: "iad.ocir.io/acme/app:1", is_resource_principal_disabled: false });
    expect(c.health_checks).toMatchObject([{ health_check_type: "HTTP", port: 3000, path: "/healthz", failure_action: "KILL" }]);
    expect(frag("container_service/web").locals!.container_service_web_private_ips).toBe("${[for v in data.oci_core_vnic.container_service_web_vnic : v.private_ip_address]}");
  });

  it("a worker has no health check; sizes round UP to OCI's 1 OCPU / 1 GB minimum", () => {
    const ci = onlyResource("container_service/worker", "oci_container_instances_container_instance");
    expect((ci.containers as Record<string, unknown>[])[0].health_checks).toBeUndefined();
    for (const [vcpu, memoryMb, ocpus, gb] of [[0.25, 256, 1, 1], [1, 1024, 1, 1], [2, 4096, 1, 4], [3, 1024, 2, 2], [4, 16384, 2, 16]] as const) {
      const n = { ...nodeOf(staging, "container_service/web"), spec: { ...nodeOf(staging, "container_service/web").spec, vcpu, memoryMb } } as ResourceNode;
      const f = driverFor(n).compile!(n, compileContext(staging));
      expect(resourcesOf(f).find((r) => r.type === "oci_container_instances_container_instance")!.body.shape_config, `${vcpu}/${memoryMb}`).toEqual({ ocpus, memory_in_gbs: gb });
    }
  });

  it("secret env entries get NO value, only the OCID pointer; unresolvable ones are reported by name", () => {
    const f = frag("container_service/web");
    const env = ((onlyResource("container_service/web", "oci_container_instances_container_instance").containers as Record<string, unknown>[])[0].environment_variables ?? {}) as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(["LOG_LEVEL", "ZENITH_SECRET_OCID_SESSION_SECRET"]);
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.STRIPE_KEY).toBeUndefined();
    expect(env.ZENITH_SECRET_OCID_SESSION_SECRET).toMatch(/^\$\{local\.secret_session_secret_[0-9a-f]{8}_id\}$/);
    expect(f.output!.container_service_web_unresolved_secret_keys.value).toEqual(["STRIPE_KEY"]);
    expect(f.output!.container_service_web_secret_delivery.value).toEqual({ mode: "runtime_fetch", keys: ["SESSION_SECRET"] });
  });

  it("built and blueprint artifacts are refused (OCI has no build pipeline driver)", () => {
    for (const artifact of [{ type: "built", pipeline: "build_pipeline/web" }, { type: "blueprint", blueprint: "web" }]) {
      const n = { ...nodeOf(staging, "container_service/web"), spec: { ...nodeOf(staging, "container_service/web").spec, artifact } } as ResourceNode;
      expect(() => driverFor(n).compile!(n, compileContext(staging))).toThrow(OciUnsupportedError);
    }
  });

  it("refuses bad images, env keys, replica counts, shapes and ports", () => {
    const base = nodeOf(staging, "container_service/web");
    const make = (over: Record<string, unknown>) => ({ ...base, spec: { ...base.spec, ...over } }) as ResourceNode;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ artifact: { type: "image", ref: "nginx; rm -rf /" } }, /valid container image/],
      [{ artifact: { type: "image", ref: "a\"b" } }, /valid container image/],
      [{ env: [{ key: "BAD-KEY", value: "x" }] }, /not a valid variable name/],
      [{ env: [{ key: "A B", value: "x" }] }, /not a valid variable name/],
      [{ replicas: -1 }, /replicas/],
      [{ replicas: 51 }, /replicas/],
      [{ replicas: 1.5 }, /replicas/],
      [{ shape: "VM.Standard.E4.Flex" }, /Container Instances flexible shape/],
      [{ shape: "CI.Fixed" }, /Container Instances flexible shape/],
      [{ port: 99999 }, /1\.\.65535/],
    ];
    for (const [over, message] of cases) {
      const n = make(over);
      expect(() => driverFor(n).compile!(n, compileContext(staging)), JSON.stringify(over)).toThrow(message);
    }
  });

  it("accepts the OCI tuning shape from providerConfig", () => {
    const n = { ...nodeOf(staging, "container_service/web"), spec: { ...nodeOf(staging, "container_service/web").spec, shape: "CI.Standard.A1.Flex" } } as ResourceNode;
    const ci = resourcesOf(driverFor(n).compile!(n, compileContext(staging))).find((r) => r.type === "oci_container_instances_container_instance")!;
    expect(ci.body.shape).toBe("CI.Standard.A1.Flex");
  });
});

describe("data stores", () => {
  it("PostgreSQL: private, vault-generated password by reference, regional storage only when HA, deletion-protected", () => {
    const db = onlyResource("postgres/db", "oci_psql_db_system");
    expect(db).toMatchObject({ db_version: "16", shape: "VM.Standard.E4.Flex", instance_count: 1, instance_ocpu_count: 4, instance_memory_size_in_gbs: 64 });
    expect(db.credentials).toEqual({ username: "zenith_admin", password_details: { password_type: "VAULT_SECRET", secret_id: "${oci_vault_secret.postgres_db_admin.id}", secret_version: "${oci_vault_secret.postgres_db_admin.current_version_number}" } });
    expect(db.lifecycle).toEqual({ prevent_destroy: true });
    expect(JSON.stringify(db)).not.toMatch(/"password"/);
    const secret = onlyResource("postgres/db", "oci_vault_secret");
    expect(secret).toMatchObject({ enable_auto_generation: true, secret_generation_context: { generation_type: "PASSPHRASE", generation_template: "DBAAS_DEFAULT_PASSWORD" } });
    expect(secret.secret_content).toBeUndefined();
    expect(frag("postgres/db").locals!.postgres_db_admin_secret_id).toBe("${oci_vault_secret.postgres_db_admin.id}");
    expect((db.storage_details as Record<string, unknown>).is_regionally_durable).toBe(false);
    expect(frag("postgres/db").data!.oci_identity_availability_domain).toBeDefined();
  });

  it("PostgreSQL HA: two nodes, regionally durable storage, no AD lookup; hourly backups are DAILY", () => {
    const base = nodeOf(staging, "postgres/db");
    const ha = { ...base, spec: { ...base.spec, highAvailability: true, backup: "hourly" } } as ResourceNode;
    const f = driverFor(ha).compile!(ha, compileContext(staging));
    const db = resourcesOf(f).find((r) => r.type === "oci_psql_db_system")!.body;
    expect(db).toMatchObject({ instance_count: 2, storage_details: { is_regionally_durable: true }, management_policy: { backup_policy: { kind: "DAILY" } } });
    expect(f.data!.oci_identity_availability_domain).toBeUndefined();
    const none = { ...base, spec: { ...base.spec, backup: "none" } } as ResourceNode;
    expect((resourcesOf(driverFor(none).compile!(none, compileContext(staging))).find((r) => r.type === "oci_psql_db_system")!.body.management_policy as Record<string, unknown>).backup_policy).toEqual({ kind: "NONE" });
  });

  it("deletionPolicy 'allow' (and only 'allow') drops prevent_destroy", () => {
    for (const address of ["postgres/db", "object_store/assets", "queue/jobs", "redis/cache"]) {
      const base = nodeOf(staging, address);
      for (const [policy, protectedFromDestroy] of [["deny", true], ["approval", true], ["allow", false]] as const) {
        const n = { ...base, spec: { ...base.spec, deletionPolicy: policy } } as ResourceNode;
        const main = resourcesOf(driverFor(n).compile!(n, compileContext(staging))).find((r) => r.type === ociPrimaryAddress(n)!.split(".")[0])!.body;
        expect(main.lifecycle !== undefined, `${address} ${policy}`).toBe(protectedFromDestroy);
      }
    }
  });

  it("PostgreSQL refuses other engines, a non-generated credential mode, odd versions and sizes", () => {
    const base = nodeOf(staging, "postgres/db");
    for (const [over, message] of [
      [{ engine: "mysql" }, /engine "postgres" only/],
      [{ credentials: "inline" }, /generated/],
      [{ version: "16; drop" }, /major version/],
      [{ size: "huge" }, /unknown size/],
    ] as [Record<string, unknown>, RegExp][]) {
      const n = { ...base, spec: { ...base.spec, ...over } } as ResourceNode;
      expect(() => driverFor(n).compile!(n, compileContext(staging)), JSON.stringify(over)).toThrow(message);
    }
  });

  it("bucket: NoPublicAccess, versioning follows the spec (on by default because backups are), namespace from a data source", () => {
    const b = onlyResource("object_store/assets", "oci_objectstorage_bucket");
    expect(b).toMatchObject({ access_type: "NoPublicAccess", versioning: "Enabled", storage_tier: "Standard", namespace: "${data.oci_objectstorage_namespace.object_store_assets_ns.namespace}" });
    const base = nodeOf(staging, "object_store/assets");
    const unversioned = { ...base, spec: { ...base.spec, versioning: false } } as ResourceNode;
    expect(resourcesOf(driverFor(unversioned).compile!(unversioned, compileContext(staging)))[0].body.versioning).toBe("Disabled");
    const open = { ...base, spec: { ...base.spec, publicAccess: true } } as ResourceNode;
    expect(() => driverFor(open).compile!(open, compileContext(staging))).toThrow(/never public/);
  });

  it("queue: pinned retention/visibility; config overrides are validated", () => {
    expect(onlyResource("queue/jobs", "oci_queue_queue")).toMatchObject({ retention_in_seconds: 345600, visibility_in_seconds: 30 });
    const base = nodeOf(staging, "queue/jobs");
    const tuned = { ...base, spec: { ...base.spec, config: { retentionSeconds: 600, visibilitySeconds: 5 } } } as ResourceNode;
    expect(resourcesOf(driverFor(tuned).compile!(tuned, compileContext(staging)))[0].body).toMatchObject({ retention_in_seconds: 600, visibility_in_seconds: 5 });
    for (const config of [{ retentionSeconds: 5 }, { retentionSeconds: "9" }, { visibilitySeconds: -1 }, { retentionSeconds: 1e9 }]) {
      const bad = { ...base, spec: { ...base.spec, config } } as ResourceNode;
      expect(() => driverFor(bad).compile!(bad, compileContext(staging)), JSON.stringify(config)).toThrow(OciCompileError);
    }
  });

  it("redis (minimal): private, own NSG, nodes follow HA; block volume (minimal): bounded size, AD 1", () => {
    expect(onlyResource("redis/cache", "oci_redis_redis_cluster")).toMatchObject({ node_count: 1, software_version: "REDIS_7_0", cluster_mode: "NONSHARDED", nsg_ids: ["${oci_core_network_security_group.redis_cache_nsg.id}"] });
    const vol = { ...nodeOf(staging, "object_store/assets"), address: "volume/data", kind: "volume", nativeType: "oci:block_volume", spec: { sizeGb: 100, deletionPolicy: "deny" } } as ResourceNode;
    const f = driverFor(vol).compile!(vol, compileContext(staging));
    expect(resourcesOf(f)[0].body).toMatchObject({ size_in_gbs: "100", lifecycle: { prevent_destroy: true } });
    for (const sizeGb of [10, 1.5, 99999]) {
      const bad = { ...vol, spec: { sizeGb } } as ResourceNode;
      expect(() => driverFor(bad).compile!(bad, compileContext(staging))).toThrow(/sizeGb/);
    }
  });

  it("repository: private, immutability follows the spec, no scan-on-push claim", () => {
    const g = expandOci({ ...webStack(), services: [{ ...webStack().services[0], source: { type: "git", repo: "github.com/acme/web", ref: "main" } }] });
    const repo = compileGraph(g).fragments.get("container_registry/web");
    expect(repo).toBeDefined();
    const body = resourcesOf(repo!)[0].body;
    expect(body).toMatchObject({ is_public: false, is_immutable: false });
    expect(JSON.stringify(body)).not.toMatch(/scan/i);
    expect(repo!.output!.container_registry_web_image_path.value).toContain("ocir.io");
  });
});

describe("identity, secrets, logs", () => {
  const dg = (a: string) => onlyResource(a, "oci_identity_dynamic_group");
  const policy = (a: string) => onlyResource(a, "oci_identity_policy");

  it("the dynamic group matches THIS environment's instances of THIS workload in the compartment, and lives in the tenancy", () => {
    const d = dg("identity/web");
    expect(d.compartment_id).toBe(TENANCY);
    expect(d.matching_rule).toBe(`ALL {resource.type='computecontainerinstance', resource.compartment.id='${COMPARTMENT}', tag.zenith_environment.value='${ENV_ID}', tag.zenith_resource.value='container_service/web'}`);
    expect(policy("identity/web").compartment_id).toBe(COMPARTMENT);
  });

  it("one scoped statement per grant: exact verbs, resource types and targets, no wildcards", () => {
    const statements = policy("identity/web").statements as string[];
    const dgName = "${oci_identity_dynamic_group.identity_web.name}";
    const inC = `in compartment id ${COMPARTMENT}`;
    expect(statements).toEqual([
      `Allow dynamic-group ${dgName} to use log-content ${inC} where target.loggroup.id = '\${oci_logging_log_group.log_group_web.id}'`,
      `Allow dynamic-group ${dgName} to manage objects ${inC} where target.bucket.name = '\${oci_objectstorage_bucket.object_store_assets.name}'`,
      `Allow dynamic-group ${dgName} to read secret-bundles ${inC} where target.secret.id = '\${local.postgres_db_admin_secret_id}'`,
      `Allow dynamic-group ${dgName} to use queue-push ${inC} where target.queue.id = '\${oci_queue_queue.queue_jobs.id}'`,
      expect.stringMatching(/to read secret-bundles .* where target\.secret\.id = '\$\{local\.secret_session_secret_[0-9a-f]{8}_id\}'$/),
    ]);
    expect((policy("identity/worker").statements as string[]).some((s) => s.includes("use queue-pull"))).toBe(true);
    expect((policy("identity/worker").statements as string[]).some((s) => s.includes("queue-push"))).toBe(false);
  });

  it("a grant to a secret outside OCI Vault grants nothing and is listed", () => {
    expect((policy("identity/web").statements as string[]).join("\n")).not.toContain("stripe");
    expect(frag("identity/web").output!.identity_web_ungranted_targets.value).toEqual([expect.stringMatching(/^secret\/stripe-/)]);
  });

  it("refuses wildcards, unknown targets, unknown verbs and unsafe rule inputs", () => {
    const base = nodeOf(staging, "identity/web");
    const spec = base.spec as { grants: unknown[] };
    const make = (grants: unknown[], over: Record<string, unknown> = {}) => ({ ...base, spec: { ...base.spec, grants, ...over } }) as ResourceNode;
    const cases: [ResourceNode, RegExp][] = [
      [make([{ target: "object_store/*", access: ["read"], via: [] }]), /wildcard/],
      [make([{ target: "network/main", access: ["read"], via: [] }]), /no OCI policy mapping/],
      [make([{ target: "object_store/assets", access: ["destroy"], via: [] }]), /not valid for object_store/],
      [make([{ target: "object_store/assets", access: [], via: [] }]), /no access verbs/],
      [make(spec.grants, { principal: "user" }), /only workload principals/],
      [make(spec.grants, { workload: "container_service/web'} ANY {1=1" }), /not allowed in a dynamic group rule/],
    ];
    for (const [n, message] of cases) expect(() => driverFor(n).compile!(n, compileContext(staging))).toThrow(message);
    expect(() => driverFor(base).compile!(base, compileContext(staging, { environmentId: "e'; ALL {" }))).toThrow(/not allowed in a dynamic group rule/);
  });

  it("verbs map to the lowest OCI verb that works: read-only blob access is `read`, list-only is `inspect`", () => {
    const base = nodeOf(staging, "identity/web");
    const grant = (access: string[]) => ({ ...base, spec: { ...base.spec, grants: [{ target: "object_store/assets", access, via: [] }] } }) as ResourceNode;
    const verbOf = (access: string[]) => ((resourcesOf(driverFor(grant(access)).compile!(grant(access), compileContext(staging))).find((r) => r.type === "oci_identity_policy")!.body.statements as string[])[0].match(/ to (\w+) objects/) ?? [])[1];
    expect(verbOf(["list"])).toBe("inspect");
    expect(verbOf(["read", "list"])).toBe("read");
    expect(verbOf(["write"])).toBe("manage");
    expect(verbOf(["delete", "list", "read", "write"])).toBe("manage");
  });

  it("an identity with no grants still declares its dynamic group but no policy", () => {
    const base = nodeOf(staging, "identity/worker");
    const n = { ...base, spec: { ...base.spec, grants: [] } } as ResourceNode;
    const f = driverFor(n).compile!(n, compileContext(staging));
    expect(resourcesOf(f).map((r) => r.type)).toEqual(["oci_identity_dynamic_group"]);
  });

  it("vault secret: an auto-generated placeholder container; content is never reconciled", () => {
    const address = [...compiled.fragments.keys()].find((a) => a.startsWith("secret/session-secret"))!;
    const s = onlyResource(address, "oci_vault_secret");
    expect(s).toMatchObject({ enable_auto_generation: true, vault_id: expect.stringContaining("data.oci_kms_vaults"), key_id: expect.stringContaining("data.oci_kms_keys") });
    expect(s.secret_content).toBeUndefined();
    expect((s.lifecycle as { ignore_changes: string[] }).ignore_changes).toEqual(expect.arrayContaining(["secret_content", "enable_auto_generation", "secret_generation_context"]));
    expect(Object.keys(frag(address).data!).sort()).toEqual(["oci_kms_keys", "oci_kms_vaults"]);
  });

  it("log group: a group plus a CUSTOM log whose retention rounds up to a multiple of 30 days", () => {
    const f = frag("log_group/web");
    expect(resourcesOf(f).map((r) => r.type)).toEqual(["oci_logging_log_group", "oci_logging_log"]);
    expect(onlyResource("log_group/web", "oci_logging_log")).toMatchObject({ log_type: "CUSTOM", is_enabled: true, retention_duration: 30 });
    const base = nodeOf(staging, "log_group/web");
    for (const [days, want] of [[1, 30], [30, 30], [31, 60], [90, 90], [180, 180]] as const) {
      const n = { ...base, spec: { ...base.spec, retentionDays: days } } as ResourceNode;
      expect(resourcesOf(driverFor(n).compile!(n, compileContext(staging))).find((r) => r.type === "oci_logging_log")!.body.retention_duration).toBe(want);
    }
    for (const days of [181, 0, -1, Number.NaN]) {
      const n = { ...base, spec: { ...base.spec, retentionDays: days } } as ResourceNode;
      expect(() => driverFor(n).compile!(n, compileContext(staging))).toThrow();
    }
  });
});

describe("explicitly unsupported", () => {
  it.each(["oci:oke_cluster", "oci:mysql_db_system", "oci:compute_instance"])("%s is registered, declares nothing, and compile throws OciUnsupportedError with a reason", (nativeType) => {
    const d = ociDrivers.find((x) => x.nativeType === nativeType)!;
    expect(d.capabilities).toMatchObject({ compile: false, observe: false, runtime: false, verify: false, discover: false, operations: [], evidence: {} });
    expect(d.observe).toBeUndefined();
    const node = { ...nodeOf(staging, "postgres/db"), nativeType } as ResourceNode;
    expect(() => d.compile!(node, compileContext(staging))).toThrow(OciUnsupportedError);
    expect(() => d.compile!(node, compileContext(staging))).toThrow(new RegExp(nativeType));
  });

  it("expansion keeps unsupported kinds visible instead of dropping them", () => {
    const m = webStack();
    m.services.push({ ...m.services[0], id: "svc-site", name: "site", kind: "static", port: undefined, env: [], source: { type: "image", image: "x:1" } });
    const g = expandOci(m);
    const site = g.nodes.find((n) => n.address === "static_site/site")!;
    expect(site.nativeType).toBe("unsupported:oci:static_site");
    expect(compileGraph(g).refused.get("static_site/site")).toMatch(/no OCI driver/);
  });
});

describe("references", () => {
  it("cross-node references go through ctx.ref or locals, never a hard-coded foreign label", () => {
    const refs = new Set<string>();
    const ctx = compileContext(staging, {
      ref: (a, attr) => {
        refs.add(`${a}:${attr}`);
        return "${" + `${ociPrimaryAddress(nodeOf(staging, a))}.${attr}` + "}";
      },
    });
    for (const node of staging.nodes) driverFor(node).compile!(node, ctx);
    expect([...refs]).toEqual(expect.arrayContaining(["network/main:id", "subnet/private-a:id", "subnet/public-a:id", "object_store/assets:name", "queue/jobs:id", "log_group/web:id"]));
    // every `${local.X}` a fragment reads is published by some fragment
    const published = new Set(compiled.fragments.size ? [...compiled.fragments.values()].flatMap((f) => Object.keys(f.locals ?? {})) : []);
    for (const r of allResources(compiled)) for (const m of JSON.stringify(r.body).matchAll(/\$\{local\.([a-z0-9_]+)/g)) expect(published.has(m[1]), `${r.node} reads local.${m[1]}`).toBe(true);
    for (const f of compiled.fragments.values()) for (const m of JSON.stringify(f.output ?? {}).matchAll(/\$\{local\.([a-z0-9_]+)/g)) expect(published.has(m[1])).toBe(true);
  });
});
